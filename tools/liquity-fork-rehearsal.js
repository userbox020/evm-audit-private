#!/usr/bin/env node
"use strict";

// Keyless, local-only Liquity V1 rehearsal. Never forward endpoint strings to
// children, artifacts, diagnostics, or exceptions. The relay owns the upstream.
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");
const { spawn, spawnSync } = require("node:child_process");
const { Interface, id } = require(path.join(__dirname, "node_modules", "ethers"));

const ROOT = path.resolve(__dirname, "..");
const OUTPUT = path.join(ROOT, "reports", "raw", "fast", "liquity-fork-rehearsal", "result.json");
const INVENTORY = path.join(ROOT, "rpc_endpoints.txt");
const ANVIL = "C:\\Users\\MiPC\\.foundry\\bin\\anvil.exe";
const TM = "0xA39739EF8b0231DbFA0DcdA07d7e29faAbCf4bb2";
const BO = "0x24179CD81c9e782A4096035f7eC97fB8B783e007";
const LUSD = "0x5f98805A4E8be255a32880FDeC7F6728C6568bA0";
const PRICE_FEED = "0x4c517D4e2C851CA76d7eC94B805269Df0f2201De";
const PRICE_TOPIC = id("LastGoodPriceUpdated(uint256)");
const CALLER = "0x000000000000000000000000000000000000bEEF";
const HISTORICAL = Object.freeze([
  { borrower: "0x5bfc0c6bcbe913d0b13ef862e1cb5ab32c532007", liquidationBlock: 12449701, transactionHash: "0x2a129ee83760a87b0f62b3b371c74b10cc636aa4659757331c57e625e6b3b781" },
  { borrower: "0xc9086b7f93e19ad9d73e9ff4e7c038b3cc1ed288", liquidationBlock: 12454623, transactionHash: "0x6bffdbb1c3f33dda4acbf88f976d73da70d1d2fed773a5c117655b8b513536e6" },
  { borrower: "0x8bace3a49a375027868cdd34e84521eed1f1b01d", liquidationBlock: 12464922, transactionHash: "0xa5f2390ba727884b16314e1d0edb41b7daf4a87bb3847fcfc868703b5ce9d765" },
]);
const ARCHIVE_PIN = HISTORICAL[0].liquidationBlock - 1;
const LIMIT_MS = 180000;
const IFACE = new Interface([
  "function liquidate(address)",
  "function batchLiquidateTroves(address[])",
  "function lusdToken() view returns (address)",
  "function priceFeed() view returns (address)",
  "function MCR() view returns (uint256)",
  "function getCurrentICR(address,uint256) view returns (uint256)",
  "function getTroveOwnersCount() view returns (uint256)",
  "function getTroveFromTroveOwnersArray(uint256) view returns (address)",
  "function getTroveStatus(address) view returns (uint256)",
  "function getEntireDebtAndColl(address) view returns (uint256 debt,uint256 coll,uint256 pendingDebt,uint256 pendingColl)",
  "function balanceOf(address) view returns (uint256)",
  "function fetchPrice() returns (uint256)",
]);
const mintedGasWei = 10n ** 20n;
const fail = (code) => { throw new Error(code); };
const quantity = (value) => "0x" + BigInt(value).toString(16);
const word = (value) => `0x${BigInt(value).toString(16).padStart(64, "0")}`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deadline = Date.now() + LIMIT_MS;
let anvil = null;
let relay = null;
let requestId = 0;
let aborted = false;
let stage = "SETUP";
const evidence = { cases: [], negatives: [], attempts: [], receiptChecks: [], backingClass: null, sourceEndpointClass: null };
const spawnedAt = new Date().toISOString();

function budget(maxMs = 8500) {
  if (aborted || Date.now() >= deadline) fail("DEADLINE_EXCEEDED");
  return Math.max(1, Math.min(maxMs, deadline - Date.now()));
}

function parseInventory() {
  if (!fs.existsSync(INVENTORY)) fail("INVENTORY_MISSING");
  const rows = [];
  let family = null;
  for (const line of fs.readFileSync(INVENTORY, "utf8").split(/\r?\n/)) {
    const heading = line.match(/^\s*(?:#{1,6}\s+)?(?:-{3}\s+)?(?:provider|family|service)\s*[:=\-]\s*(.+?)\s*(?:-{3})?\s*$/i);
    if (heading) family = heading[1];
    const match = line.match(/https?:\/\/[^\s'"<>\[\]]+/i);
    if (!match) continue;
    let parsed;
    try { parsed = new URL(match[0].replace(/[)\],;]+$/, "")); } catch (_) { continue; }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) continue;
    if (parsed.pathname !== "/" && !/^\/(v3|api)?\/?$/.test(parsed.pathname)) continue;
    const metadata = line.replace(match[0], " ");
    if (/\b(?:origin|header|auth|bearer|x-api-key|key|token)\s*[:=]/i.test(metadata)) continue;
    if (!/\bmainnet\b|\bethereum\b|\beth\b/i.test(`${family || ""} ${line}`) && family == null) continue;
    rows.push(parsed.href);
  }
  return [...new Set(rows)].slice(0, 24);
}

async function request(url, method, params, upstream = false) {
  let response;
  const bodyJson = JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    response = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" }, body: bodyJson,
      signal: AbortSignal.timeout(budget(upstream ? 8500 : 30000)),
    });
    if (response.status !== 429 || attempt === 2) break;
    await response.arrayBuffer();
    await delay(400 * (attempt + 1));
  }
  if (!response.ok || Number(response.headers.get("content-length") || 0) > 8 * 1024 * 1024) fail(upstream ? "UPSTREAM_UNAVAILABLE" : "LOCAL_RPC_UNAVAILABLE");
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > 8 * 1024 * 1024) fail("RPC_RESPONSE_TOO_LARGE");
  const body = JSON.parse(Buffer.from(bytes).toString("utf8"));
  if (body?.error) {
    const error = new Error(upstream ? "UPSTREAM_RPC_ERROR" : "LOCAL_RPC_ERROR");
    error.reverted = /execution reverted|\brevert\b|VM Exception/i.test(String(body.error.message || ""));
    const data = typeof body.error.data === "string" ? body.error.data : body.error.data?.data;
    if (typeof data === "string" && /^0x[0-9a-f]+$/i.test(data)) error.revertData = `0x${data.slice(2, 66).toLowerCase()}`;
    throw error;
  }
  if (!body || Array.isArray(body) || body.result === undefined) fail(upstream ? "UPSTREAM_RPC_ERROR" : "LOCAL_RPC_ERROR");
  return body.result;
}

async function* qualifiedUpstreams() {
  const archive = ["https://eth.blockscout.com/api/eth-rpc", "https://eth.drpc.org"];
  const pool = [...archive.map((url) => ({ url, backingClass: "PUBLIC_KEYLESS_ARCHIVE" })),
    ...parseInventory().map((url) => ({ url, backingClass: "PUBLIC_KEYLESS_INVENTORY" }))];
  const seen = new Set();
  for (const candidate of pool) {
    const { url } = candidate;
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      if (await request(url, "eth_chainId", [], true) !== "0x1") continue;
      const finalized = await request(url, "eth_getBlockByNumber", ["finalized", false], true);
      if (!finalized || !/^0x[0-9a-f]{64}$/i.test(finalized.hash || "") || !/^0x[0-9a-f]+$/i.test(finalized.number || "")) continue;
      const recheck = await request(url, "eth_getBlockByNumber", [finalized.number, false], true);
      if (!recheck || recheck.hash !== finalized.hash) continue;
      const historicBlock = await request(url, "eth_getBlockByNumber", [quantity(ARCHIVE_PIN), false], true);
      if (!historicBlock || Number(BigInt(historicBlock.number)) !== ARCHIVE_PIN || !/^0x[0-9a-f]{64}$/i.test(historicBlock.hash || "")) continue;
      const tm = await request(url, "eth_getCode", [TM, quantity(ARCHIVE_PIN)], true);
      const bo = await request(url, "eth_getCode", [BO, quantity(ARCHIVE_PIN)], true);
      if (typeof tm !== "string" || tm.length <= 2 || typeof bo !== "string" || bo.length <= 2) continue;
      const balance = await request(url, "eth_call", [{ to: LUSD, data: IFACE.encodeFunctionData("balanceOf", [CALLER]) }, quantity(ARCHIVE_PIN)], true);
      if (IFACE.decodeFunctionResult("balanceOf", balance).length !== 1) continue;
      const storage = await request(url, "eth_getStorageAt", [TM, quantity(0), quantity(ARCHIVE_PIN)], true);
      if (!/^0x[0-9a-f]{64}$/i.test(storage)) continue;
      yield candidate;
    } catch (_) { /* candidate failed qualification; never expose its error */ }
  }
}

async function historicalPriceControl(local, row) {
  const receipt = await request(local, "eth_getTransactionReceipt", [row.transactionHash]);
  if (!receipt) fail("HISTORICAL_RECEIPT_MISSING");
  if (!receipt.blockNumber) fail("HISTORICAL_RECEIPT_INVALID");
  const observedBlock = Number(BigInt(receipt.blockNumber));
  if (evidence.receiptChecks.length < 8 && !evidence.receiptChecks.some((item) => item.borrower === row.borrower && item.observedBlock === observedBlock))
    evidence.receiptChecks.push({ borrower: row.borrower, claimedBlock: row.liquidationBlock, observedBlock, match: observedBlock === row.liquidationBlock });
  if (observedBlock !== row.liquidationBlock) fail("HISTORICAL_RECEIPT_BLOCK_MISMATCH");
  if (BigInt(receipt.status ?? "0x0") !== 1n || !Array.isArray(receipt.logs)) fail("HISTORICAL_RECEIPT_INVALID");
  const prices = receipt.logs.filter((log) => log.address?.toLowerCase() === PRICE_FEED.toLowerCase() && log.topics?.[0]?.toLowerCase() === PRICE_TOPIC.toLowerCase()).map((log) => {
    if (!/^0x[0-9a-f]{64}$/i.test(log.data || "")) fail("HISTORICAL_PRICE_LOG_INVALID");
    return BigInt(log.data);
  });
  if (!prices.length) return { priceUsed: null, controlledIntervention: "NONE" };
  for (const price of prices.reverse()) {
    for (let slot = 0; slot <= 20; slot += 1) {
      const atBlock = await request(local, "eth_getStorageAt", [PRICE_FEED, word(slot), quantity(row.liquidationBlock)]);
      if (!/^0x[0-9a-f]{64}$/i.test(atBlock) || BigInt(atBlock) !== price) continue;
      const atPin = await request(local, "eth_getStorageAt", [PRICE_FEED, word(slot), quantity(row.liquidationBlock - 1)]);
      if (!/^0x[0-9a-f]{64}$/i.test(atPin)) fail("PRICE_SLOT_INVALID");
      if (BigInt(atPin) === price) continue;
      return { priceUsed: price.toString(), slot, slotAtPin: atPin, slotAtBlock: atBlock,
        controlledIntervention: { kind: "LAST_GOOD_PRICE_SET", from: atPin, to: price.toString() } };
    }
  }
  fail("PRICE_SLOT_UNPROVEN");
}

function stopAnvil() {
  if (!anvil) return true;
  const child = anvil;
  anvil = null;
  if (child.exitCode !== null || !child.pid) return true;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 4000 });
  else { try { child.kill("SIGKILL"); } catch (_) {} }
  try { process.kill(child.pid, 0); return false; } catch (_) { return true; }
}

async function startRelay(upstream) {
  // Never log upstream responses/errors; never allow arbitrary LAN callers.
  relay = http.createServer(async (req, res) => {
    try {
      if (req.method !== "POST" || req.socket.remoteAddress !== "127.0.0.1") fail("RELAY_INVALID_REQUEST");
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) fail("RELAY_REQUEST_TOO_LARGE"); chunks.push(chunk); }
      const query = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!query || typeof query.method !== "string" || !/^eth_|^net_|^web3_/.test(query.method)) fail("RELAY_INVALID_METHOD");
      let remote;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        remote = await fetch(upstream, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(query), signal: AbortSignal.timeout(budget(25000)) });
        if (remote.status !== 429 || attempt === 2) break;
        await remote.arrayBuffer();
        await delay(400 * (attempt + 1));
      }
      const bytes = await remote.arrayBuffer();
      if (!remote.ok || bytes.byteLength > 16 * 1024 * 1024) fail("RELAY_UPSTREAM_FAILURE");
      res.writeHead(200, { "content-type": "application/json" }); res.end(Buffer.from(bytes));
    } catch (_) {
      // Downstream receives reason code only, never an upstream RPC message.
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "RELAY_UPSTREAM_FAILURE" } }));
    }
  });
  await new Promise((resolve, reject) => { relay.once("error", reject); relay.listen(0, "127.0.0.1", resolve); });
  return `http://127.0.0.1:${relay.address().port}`;
}

async function startAnvil(relayUrl, pin) {
  if (!stopAnvil()) fail("ANVIL_CLEANUP_FAILED");
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  // Only a loopback relay URL appears in the child command line.
  anvil = spawn(ANVIL, ["--host", "127.0.0.1", "--port", String(port), "--fork-url", relayUrl,
    "--fork-block-number", String(pin), "--no-rate-limit", "--block-base-fee-per-gas", "1000000000"],
  { stdio: ["ignore", "ignore", "pipe"], windowsHide: true, shell: false });
  let bootDiagnostic = "";
  anvil.stderr.on("data", (chunk) => {
    bootDiagnostic = (bootDiagnostic + chunk.toString("utf8")).slice(-16384);
  });
  const bootError = () => {
    if (/429|too many requests|rate.limit/i.test(bootDiagnostic)) return "FORK_BACKING_RATE_LIMITED";
    if (/method not found/i.test(bootDiagnostic)) return "FORK_BACKING_METHOD_MISSING";
    if (/missing trie node|historical state/i.test(bootDiagnostic)) return "FORK_BACKING_STATE_MISSING";
    if (/failed to get.*(?:chain.?id|chain id)/i.test(bootDiagnostic)) return "FORK_BACKING_CHAIN_ID_FAILURE";
    if (/failed to get.*(?:gas price|gasprice)/i.test(bootDiagnostic)) return "FORK_BACKING_GAS_PRICE_FAILURE";
    if (/failed to get.*(?:transaction|receipt)/i.test(bootDiagnostic)) return "FORK_BACKING_TRANSACTION_FAILURE";
    if (/failed to get.*proof/i.test(bootDiagnostic)) return "FORK_BACKING_PROOF_FAILURE";
    if (/failed to get.*code/i.test(bootDiagnostic)) return "FORK_BACKING_CODE_FAILURE";
    if (/failed to get.*balance/i.test(bootDiagnostic)) return "FORK_BACKING_BALANCE_FAILURE";
    if (/failed to get block/i.test(bootDiagnostic)) return "FORK_BACKING_BLOCK_FAILURE";
    if (/failed to get|failed to fetch|cannot fork|unsupported/i.test(bootDiagnostic)) return "FORK_BACKING_UNSUPPORTED";
    if (/unexpected argument|unrecognized option|invalid value/i.test(bootDiagnostic)) return "ANVIL_ARGUMENTS_INVALID";
    return "ANVIL_START_FAILED";
  };
  anvil.on("error", () => { /* observed by readiness loop */ });
  for (let attempt = 0; attempt < 55; attempt += 1) {
    budget();
    if (anvil.exitCode !== null) fail(bootError());
    const local = `http://127.0.0.1:${port}`;
    try { if (await request(local, "eth_chainId", []) === "0x1" && Number(BigInt(await request(local, "eth_blockNumber", []))) === pin) return local; } catch (_) { /* boot in progress */ }
    await delay(120);
  }
  fail(bootError());
}

async function call(local, to, signature, args, from = CALLER) {
  const data = IFACE.encodeFunctionData(signature, args);
  const result = await request(local, "eth_call", [{ from, to, data }, "latest"]);
  return IFACE.decodeFunctionResult(signature, result)[0];
}

async function guardedStatic(local, data) {
  const code = await request(local, "eth_getCode", [TM, "latest"]);
  if (typeof code !== "string" || code.length <= 2) fail("TARGET_CODE_MISSING");
  await request(local, "eth_call", [{ from: CALLER, to: TM, data, gas: quantity(6500000) }, "latest"]);
}

async function balances(local, lusd) {
  return { eth: BigInt(await request(local, "eth_getBalance", [CALLER, "latest"])), lusd: BigInt(await call(local, lusd, "balanceOf", [CALLER])) };
}

async function transaction(local, data, lusd, row, pinGasPriceWei, control) {
  const step = `CASE_${HISTORICAL.indexOf(row) + 1}`;
  stage = `${step}_BALANCE_PRE`;
  const before = await balances(local, lusd);
  stage = `${step}_STATIC_CALL`;
  await guardedStatic(local, data);
  stage = `${step}_SEND_LOCAL`;
  const hash = await request(local, "eth_sendTransaction", [{ from: CALLER, to: TM, data, gas: quantity(6500000), gasPrice: quantity(2_000_000_000) }]);
  stage = `${step}_RECEIPT`;
  let receipt = null;
  for (let n = 0; n < 30 && !receipt; n += 1) { receipt = await request(local, "eth_getTransactionReceipt", [hash]); if (!receipt) await delay(120); }
  if (!receipt || receipt.status !== "0x1") fail("LOCAL_TRANSACTION_REVERTED");
  stage = `${step}_BALANCE_POST`;
  const after = await balances(local, lusd);
  const gasUsed = BigInt(receipt.gasUsed), effectiveGasPrice = BigInt(receipt.effectiveGasPrice);
  const gasCost = gasUsed * effectiveGasPrice;
  const collateralComp = after.eth - before.eth + gasCost;
  const lusdComp = after.lusd - before.lusd;
  if (collateralComp <= 0n || lusdComp !== 200n * 10n ** 18n) fail("COMPENSATION_MISMATCH");
  return {
    kind: "single", borrower: row.borrower, liquidationBlock: row.liquidationBlock, forkBlock: row.liquidationBlock - 1,
    historicalTransactionHash: row.transactionHash, calldataShape: "liquidate(address)",
    priceUsed: control.priceUsed, controlledIntervention: control.controlledIntervention,
    slot: control.slot, slotAtPin: control.slotAtPin, slotAtBlock: control.slotAtBlock,
    staticCallReverted: false, gasUsed: gasUsed.toString(), gasUsedPerLiquidation: Number(gasUsed),
    pinGasPriceWei: pinGasPriceWei.toString(), pricing: "PINNED_GAS_PRICE_NOT_TODAY",
    measuredGasWeiPerLiquidation: (gasUsed * pinGasPriceWei).toString(), effectiveGasPriceWei: effectiveGasPrice.toString(),
    gasCostWei: gasCost.toString(), collateralCompWei: collateralComp.toString(), lusdCompWei: lusdComp.toString(),
    measuredNetBeforeBundleWei: (after.eth - before.eth).toString(),
  };
}

async function healthyBorrower(local, price, mcr, excluded) {
  const count = Number(await call(local, TM, "getTroveOwnersCount", []));
  if (!Number.isSafeInteger(count) || count < 1) fail("TROVE_OWNER_COUNT_INVALID");
  const indices = [0, Math.floor(count / 2), count - 1, Math.floor(count / 4), ...Array.from({ length: 24 }, (_, i) => Math.floor(count * i / 24))];
  for (const index of [...new Set(indices)]) {
    const borrower = await call(local, TM, "getTroveFromTroveOwnersArray", [index]);
    if (excluded.has(borrower.toLowerCase())) continue;
    if (BigInt(await call(local, TM, "getTroveStatus", [borrower])) !== 1n) continue;
    const result = await request(local, "eth_call", [{ from: CALLER, to: TM, data: IFACE.encodeFunctionData("getEntireDebtAndColl", [borrower]) }, "latest"]);
    const [debt, coll] = IFACE.decodeFunctionResult("getEntireDebtAndColl", result);
    if (debt === 0n) continue;
    const icr = coll * price / debt;
    if (icr < 2n * 10n ** 18n || icr <= mcr) continue;
    const fraction = (icr % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
    return { borrower, nominalCR: `${icr / 10n ** 18n}.${fraction || "0"}`, nominalCRWei: icr.toString(),
      nominalCRDefinition: "pin-price-adjusted-collateral-value/debt", collateralWei: coll.toString(), debtWei: debt.toString() };
  }
  fail("HEALTHY_TROVE_UNAVAILABLE");
}

async function expectRevert(local, kind, data, borrower, extra = {}) {
  let reverted = false;
  try { await guardedStatic(local, data); } catch (error) {
    if (error.reverted !== true) throw error;
    reverted = true;
  }
  return { kind, borrower, calldataShape: "liquidate(address)", staticCallReverted: reverted, status: reverted ? "PASS" : "FAIL", ...extra };
}

async function run() {
  if (!fs.existsSync(ANVIL)) fail("ANVIL_MISSING");
  stage = "QUALIFY";
  let relayUrl = null;
  let firstLocal = null;
  let firstControl = null;
  let backingFailure = "NO_ARCHIVE_BACKING";
  for await (const backing of qualifiedUpstreams()) {
    try {
      relayUrl = await startRelay(backing.url);
      stage = "CASE_1_HISTORICAL_PRICE";
      const control = await historicalPriceControl(relayUrl, HISTORICAL[0]);
      stage = "QUALIFY_FORK";
      const local = await startAnvil(relayUrl, ARCHIVE_PIN);
      if (Number(BigInt(await request(local, "eth_blockNumber", []))) !== ARCHIVE_PIN) fail("FORK_BLOCK_MISMATCH");
      firstLocal = local;
      firstControl = control;
      evidence.backingClass = backing.backingClass;
      evidence.sourceEndpointClass = backing.backingClass.startsWith("PUBLIC_KEYLESS") ? backing.backingClass : "PUBLIC_KEYLESS";
      break;
    } catch (error) {
      if (["HISTORICAL_RECEIPT_MISSING", "HISTORICAL_RECEIPT_BLOCK_MISMATCH", "HISTORICAL_RECEIPT_INVALID", "HISTORICAL_PRICE_LOG_INVALID", "PRICE_SLOT_INVALID", "PRICE_SLOT_UNPROVEN", "FORK_BACKING_CODE_FAILURE"].includes(error?.message)) backingFailure = error.message;
      if (!stopAnvil()) fail("ANVIL_CLEANUP_FAILED");
      if (relay) { relay.closeAllConnections(); relay.close(); relay = null; }
      relayUrl = null;
      if (error?.message === "DEADLINE_EXCEEDED" || error?.message === "ANVIL_CLEANUP_FAILED") throw error;
    }
  }
  if (!relayUrl) fail(backingFailure);
  stage = "FORK";
  const { cases, negatives, attempts } = evidence;
  for (const [index, row] of HISTORICAL.entries()) {
    const pin = row.liquidationBlock - 1;
    let control = null;
    try {
      stage = `CASE_${index + 1}_HISTORICAL_PRICE`;
      control = index === 0 ? firstControl : await historicalPriceControl(relayUrl, row);
      stage = `CASE_${index + 1}_START`;
      const local = index === 0 ? firstLocal : await startAnvil(relayUrl, pin);
      stage = `CASE_${index + 1}_CONTEXT`;
      if (await request(local, "eth_getCode", [CALLER, "latest"]) !== "0x") fail("CALLER_NOT_EOA");
      if (await request(local, "eth_getCode", [TM, "latest"]) === "0x") fail("FORK_TARGET_CODE_MISSING");
      if (await request(local, "eth_getCode", [LUSD, "latest"]) === "0x") fail("LUSD_CODE_MISSING");
      const pinGasPriceWei = BigInt(await request(local, "eth_gasPrice", []));
      if (pinGasPriceWei <= 0n) fail("PIN_GAS_PRICE_INVALID");
      // Only the impersonated EOA is funded; no trove/token/protocol balances are altered.
      stage = `CASE_${index + 1}_FUND`;
      await request(local, "anvil_setBalance", [CALLER, quantity(mintedGasWei)]);
      await request(local, "anvil_impersonateAccount", [CALLER]);
      const data = IFACE.encodeFunctionData("liquidate", [row.borrower]);
      const snapshot = index === 0 ? await request(local, "evm_snapshot", []) : null;
      if (control.slot != null) {
        stage = `CASE_${index + 1}_ORACLE_INTERVENTION`;
        await request(local, "anvil_setStorageAt", [PRICE_FEED, word(control.slot), word(control.priceUsed)]);
        const observed = await request(local, "eth_getStorageAt", [PRICE_FEED, word(control.slot), "latest"]);
        if (BigInt(observed) !== BigInt(control.priceUsed)) fail("INTERVENTION_NOT_APPLIED");
      }
      stage = `CASE_${index + 1}_LIQUIDATE`;
      cases.push(await transaction(local, data, LUSD, row, pinGasPriceWei, control));
      if (index === 0) {
        stage = "ALREADY_LIQUIDATED_NEGATIVE";
        if (control.slot != null) await request(local, "anvil_setStorageAt", [PRICE_FEED, word(control.slot), control.slotAtPin]);
        negatives.push(await expectRevert(local, "already-liquidated", data, row.borrower, { controlledIntervention: "NONE" }));
        if (!await request(local, "evm_revert", [snapshot])) fail("SNAPSHOT_REVERT_FAILED");
        stage = "HEALTHY_NEGATIVE";
        const priceFeed = await call(local, TM, "priceFeed", []);
        const price = BigInt(await call(local, priceFeed, "fetchPrice", []));
        const mcr = BigInt(await call(local, TM, "MCR", []));
        const healthy = await healthyBorrower(local, price, mcr, new Set(HISTORICAL.map((item) => item.borrower)));
        negatives.push(await expectRevert(local, "healthy-at-pin", IFACE.encodeFunctionData("liquidate", [healthy.borrower]), healthy.borrower, { ...healthy, mcrWei: mcr.toString(), controlledIntervention: "NONE" }));
        stage = "STUB_NEGATIVE";
        await request(local, "anvil_setCode", [TM, "0x60006000fd"]);
        negatives.push(await expectRevert(local, "reverting-code-stub", data, row.borrower, { guardRejected: false, evmCallReverted: true, reason: "STUB_REVERTED", controlledIntervention: "NONE" }));
        if (negatives.some((negative) => negative.status !== "PASS")) fail("NEGATIVE_CONTROL_FAILED");
      }
    } catch (error) {
      if (error?.message === "HISTORICAL_RECEIPT_BLOCK_MISMATCH" && cases.filter((item) => item.kind === "single").length >= 2 && negatives.length === 3 && negatives.every((item) => item.status === "PASS")) {
        const observedBlock = evidence.receiptChecks.find((item) => item.borrower === row.borrower)?.observedBlock;
        attempts.push({ borrower: row.borrower, pin, reverted: false, reason: "HISTORICAL_RECEIPT_BLOCK_MISMATCH", observedBlock });
        continue; // Do not fork, intervene, or claim a third liquidation on inconsistent inputs.
      }
      if (stage === `CASE_${index + 1}_STATIC_CALL` && error?.message === "LOCAL_RPC_ERROR" && error.reverted === true) {
        attempts.push({ borrower: row.borrower, pin, reverted: true, priceUsed: control?.priceUsed || null,
          controlledIntervention: control?.controlledIntervention || "NONE", slot: control?.slot,
          ...(error.revertData ? { revertData: error.revertData } : {}) });
        fail("PIN_STATIC_CALL_REVERTED");
      }
      if (stage === `CASE_${index + 1}_STATIC_CALL` && error?.message !== "PIN_STATIC_CALL_REVERTED")
        attempts.push({ borrower: row.borrower, pin, reverted: false, priceUsed: control?.priceUsed || null,
          controlledIntervention: control?.controlledIntervention || "NONE", slot: control?.slot,
          errorClass: ["Error", "TypeError", "AbortError", "TimeoutError", "SyntaxError"].includes(error?.name) ? error.name : "OTHER" });
      throw error;
    } finally {
      if (!stopAnvil()) fail("ANVIL_CLEANUP_FAILED");
      // On Windows taskkill is synchronous; a survivor is a failed cleanup, not a successful case.
    }
  }
  const measuredCount = cases.filter((item) => item.kind === "single").length;
  if (measuredCount === 0) fail("ALL_PINS_STATIC_REVERT");
  if (measuredCount < 2) fail("ONLY_ONE_PIN_EXECUTABLE");
  if (negatives.length !== 3 || negatives.some((item) => item.status !== "PASS")) fail("NEGATIVE_CONTROL_FAILED");
  return {
    schema: "liquity-fork-rehearsal/v1", state: "PASS", forkBlock: ARCHIVE_PIN,
    inputCompleteness: attempts.some((item) => item.reason === "HISTORICAL_RECEIPT_BLOCK_MISMATCH") ? "TWO_OF_THREE_VERIFIED_THIRD_RECEIPT_MISMATCH" : "ALL_RECEIPTS_MATCHED",
    relayOnly: true, endpointProcessOnly: true, sourceEndpointClass: evidence.sourceEndpointClass, backingClass: evidence.backingClass,
    caller: CALLER, callerFunding: { method: "anvil_setBalance", amountWei: mintedGasWei.toString(), impersonated: true, signed: false },
    cases, negatives, attempts, receiptChecks: evidence.receiptChecks, batchCase: "SKIPPED_NO_SHARED_PIN",
    measuredGasWeiPerLiquidation: cases.filter((item) => item.kind === "single").map((item) => item.measuredGasWeiPerLiquidation),
    spawnedAt, completedAt: new Date().toISOString(), readonly: true, signedActionJustified: false,
  };
}

function writeResult(result) {
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(result, null, 2) + "\n", "utf8");
}

// Synchronous exit cleanup also covers early signals and unexpected throws.
process.once("exit", stopAnvil);
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { aborted = true; stopAnvil(); process.exit(1); });

(async () => {
  let timer;
  try {
    const result = await Promise.race([
      run(),
      new Promise((_, reject) => { timer = setTimeout(() => { aborted = true; stopAnvil(); reject(new Error("DEADLINE_EXCEEDED")); }, LIMIT_MS); }),
    ]);
    writeResult(result);
    process.stdout.write(JSON.stringify({ state: "PASS", forkBlock: result.forkBlock, measuredCases: result.cases.filter((item) => item.gasUsed != null).length, negatives: result.negatives.length }) + "\n");
  } catch (error) {
    // No arbitrary exception text is ever printed or persisted.
    const codes = new Set(["ANVIL_MISSING", "ANVIL_CLEANUP_FAILED", "ANVIL_ARGUMENTS_INVALID", "ANVIL_START_FAILED", "FORK_BLOCK_MISMATCH", "FORK_BACKING_UNSUPPORTED", "FORK_BACKING_METHOD_MISSING", "FORK_BACKING_STATE_MISSING", "FORK_BACKING_BLOCK_FAILURE", "FORK_BACKING_CHAIN_ID_FAILURE", "FORK_BACKING_GAS_PRICE_FAILURE", "FORK_BACKING_TRANSACTION_FAILURE", "FORK_BACKING_PROOF_FAILURE", "FORK_BACKING_CODE_FAILURE", "FORK_BACKING_BALANCE_FAILURE", "FORK_BACKING_RATE_LIMITED", "INVENTORY_MISSING", "NO_ARCHIVE_BACKING", "HISTORICAL_RECEIPT_MISSING", "HISTORICAL_RECEIPT_BLOCK_MISMATCH", "HISTORICAL_RECEIPT_INVALID", "HISTORICAL_PRICE_LOG_INVALID", "PRICE_SLOT_INVALID", "PRICE_SLOT_UNPROVEN", "INTERVENTION_NOT_APPLIED", "DEADLINE_EXCEEDED", "FORK_TARGET_CODE_MISSING", "CALLER_NOT_EOA", "LUSD_CODE_MISSING", "PIN_GAS_PRICE_INVALID", "TROVE_OWNER_COUNT_INVALID", "HEALTHY_TROVE_UNAVAILABLE", "SNAPSHOT_REVERT_FAILED", "PIN_STATIC_CALL_REVERTED", "COMPENSATION_MISMATCH", "LOCAL_TRANSACTION_REVERTED", "NEGATIVE_CONTROL_FAILED", "ALL_PINS_STATIC_REVERT", "ONLY_ONE_PIN_EXECUTABLE", "RPC_RESPONSE_TOO_LARGE", "UPSTREAM_UNAVAILABLE", "UPSTREAM_RPC_ERROR", "LOCAL_RPC_UNAVAILABLE", "LOCAL_RPC_ERROR"]);
    const reason = codes.has(error?.message) ? (/^(?:LOCAL_RPC_|FORK_BACKING_)/.test(error.message) && stage.startsWith("CASE_") ? `${stage}_${error.message}` : error.message) : `${stage}_INTERNAL_OR_RELAY_FAILURE`;
    writeResult({ schema: "liquity-fork-rehearsal/v1", state: "FAIL_CLOSED", reason, forkBlock: null,
      relayOnly: true, endpointProcessOnly: true, sourceEndpointClass: evidence.sourceEndpointClass,
      backingClass: evidence.backingClass, cases: evidence.cases, negatives: evidence.negatives, attempts: evidence.attempts,
      receiptChecks: evidence.receiptChecks,
      batchCase: "SKIPPED_NO_SHARED_PIN",
      spawnedAt, completedAt: new Date().toISOString(), readonly: true, signedActionJustified: false });
    process.stdout.write(JSON.stringify({ state: "FAIL_CLOSED", reason }) + "\n");
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    stopAnvil();
    if (relay) { relay.closeAllConnections(); relay.close(); }
  }
})();
