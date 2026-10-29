#!/usr/bin/env node
"use strict";

// Observation only. Never use fetchPrice (state-changing), sign, or broadcast.
const fs = require("node:fs");
const path = require("node:path");
const { Interface, id } = require(path.join(__dirname, "node_modules", "ethers"));

const ROOT = path.resolve(__dirname, "..");
const INVENTORY = path.join(ROOT, "rpc_endpoints.txt");
const OUT = path.join(ROOT, "reports", "raw", "fast", "liquity-liquidation-watch");
const V1 = Object.freeze({ priceFeed: "0x4c517D4e2C851CA76d7eC94B805269Df0f2201De", manager: "0xA39739EF8b0231DbFA0DcdA07d7e29faAbCf4bb2", pool: "0x66017D22b0f8556afDd19FC67041899Eb65a21bb", getter: "0xFc92d0E9Fa35df17E3A6d9F40716ca2cE749922B" });
// Public addresses from contracts/addresses/1.json; deployment order is the collateral index.
const DEPLOYMENT = require(path.join(ROOT, "targets", "liquity-v2-bold-deployment", "contracts", "addresses", "1.json"));
const MAX_REQUESTS = 120;
const PAGE = 40;
const WAD = 10n ** 18n;
const ABI = new Interface([
  "function lastGoodPrice() view returns (uint256)",
  "function checkRecoveryMode(uint256) view returns (bool)",
  "function getCurrentICR(address,uint256) view returns (uint256)",
  "function getCurrentICR(uint256,uint256) view returns (uint256)",
  "function getTotalLUSDDeposits() view returns (uint256)",
  "function getMaxAmountToOffset() view returns (uint256)",
  "function getTotalBoldDeposits() view returns (uint256)",
  "function priceSource() view returns (uint8)",
  // V1 MultiTroveGetter.sol: negative start index -1 means tail (lowest nominal CR).
  "function getMultipleSortedTroves(int256,uint256) view returns ((address owner,uint256 debt,uint256 coll,uint256 stake,uint256 snapshotETH,uint256 snapshotLUSDDebt)[])",
  // V2 MultiTroveGetter.sol / IMultiTroveGetter.sol: sorted by interest rate, NOT ICR.
  "function getMultipleSortedTroves(uint256,int256,uint256) view returns ((uint256 id,uint256 entireDebt,uint256 entireColl,uint256 redistBoldDebtGain,uint256 redistCollGain,uint256 accruedInterest,uint256 recordedDebt,uint256 annualInterestRate,uint256 accruedBatchManagementFee,uint256 lastInterestRateAdjTime,uint256 stake,uint256 lastDebtUpdateTime,address interestBatchManager,uint256 batchDebtShares,uint256 snapshotETH,uint256 snapshotBoldDebt)[])",
]);
const V1_TROVE_TOPIC = "0xea67486ed7ebe3eea8ab3390efd4a3c8aae48be5bea27df104a8af786c408434";
const V1_AGG_TOPIC = "0x4152c73dd2614c4f9fc35e8c9cf16013cd588c75b49a4c1673ecffdcbcda9403";
const SHUTDOWN_TOPIC = id("ShutDownFromOracleFailure(address)");
const CODES = new Set(["authorized-inventory-unavailable", "no-eligible-candidates", "request-budget-exhausted", "transport-failure", "response-bound-exceeded", "rpc-error", "rpc-shape-failure", "no-qualified-provider", "chain-not-mainnet", "finalized-header-invalid", "finalized-recheck-mismatch", "runtime-code-empty", "latest-block-invalid", "call-invalid", "logs-invalid", "artifact-write-failure", "invalid-arguments"]);
const safeCode = (error) => CODES.has(error && error.message) ? error.message : "transport-failure";
const hex = (number) => `0x${number.toString(16)}`;
const quantity = (value) => typeof value === "string" && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value);
const hash = (value) => typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value);

function parseInventory(text) {
  const rows = [];
  let family = null;
  for (const [lineIndex, line] of String(text).split(/\r?\n/).entries()) {
    const heading = line.match(/^\s*(?:#{1,6}\s+)?(?:-{3}\s+)?(?:provider|family|service)\s*[:=\-]\s*(.+?)\s*(?:-{3})?\s*$/i);
    if (heading) family = heading[1];
    const match = line.match(/https?:\/\/[^\s'"<>\[\]]+/i);
    if (!match) continue;
    const url = match[0].replace(/[)\],;]+$/, "");
    let parsed;
    try { parsed = new URL(url); } catch (_) { continue; }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) continue;
    if (parsed.pathname !== "/" && !/^\/(v3|api)?\/?$/.test(parsed.pathname)) continue;
    if (parsed.search || parsed.hash) continue;
    if (/\b(?:origin|header|auth|bearer|x-api-key|key|token)\s*[:=]/i.test(line.replace(match[0], " "))) continue;
    const hint = /\bmainnet\b|\bethereum\b|\beth\b/i.test(`${heading ? heading[1] : ""} ${line}`);
    rows.push({ url, lineIndex, familyHint: family, ethereumHint: hint ? true : family ? family : null });
  }
  const seen = new Set();
  return rows.filter((row) => !seen.has(row.url) && Boolean(seen.add(row.url)));
}

function selectFamilies(qualified) {
  const seen = new Set();
  return qualified.filter((entry) => {
    // Without a declared family we cannot assert independence from another provider.
    const family = entry.provider.familyHint;
    if (!family) {
      if (seen.size) return false;
      seen.add("unknown");
      return true;
    }
    if (seen.has("unknown") || seen.has(family)) return false;
    seen.add(family);
    return true;
  }).slice(0, 2);
}

function transport(fetchFn = globalThis.fetch) {
  let count = 0;
  return {
    get count() { return count; },
    async rpc(provider, method, params) {
      if (++count > MAX_REQUESTS) throw new Error("request-budget-exhausted");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetchFn(provider.url, { method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal, body: JSON.stringify({ jsonrpc: "2.0", id: count, method, params }) });
        const raw = await response.arrayBuffer();
        if (raw.byteLength > 2 * 1024 * 1024) throw new Error("response-bound-exceeded");
        const body = JSON.parse(Buffer.from(raw).toString("utf8"));
        if (body.error) throw new Error("rpc-error");
        if (Array.isArray(body) || body.result === undefined) throw new Error("rpc-shape-failure");
        return body.result;
      } catch (error) { throw new Error(safeCode(error)); }
      finally { clearTimeout(timer); }
    },
  };
}

async function qualify(provider, rpc) {
  try {
    if (await rpc(provider, "eth_chainId", []) !== "0x1") return false;
    const finalized = await rpc(provider, "eth_getBlockByNumber", ["finalized", false]);
    if (!finalized || !hash(finalized.hash) || !quantity(finalized.number)) return false;
    const recheck = await rpc(provider, "eth_getBlockByNumber", [finalized.number, false]);
    if (!recheck || recheck.hash !== finalized.hash) return false;
    for (const address of [V1.manager, V1.getter, ...DEPLOYMENT.branches.map((branch) => branch.troveManager)]) {
      const code = await rpc(provider, "eth_getCode", [address, "latest"]);
      if (typeof code !== "string" || !/^0x[0-9a-f]+$/i.test(code) || code.length < 4) return false;
    }
    return true;
  } catch (_) { return false; }
}

async function call(rpc, provider, address, fragment, args, block) {
  const data = ABI.encodeFunctionData(fragment, args);
  const result = await rpc(provider, "eth_call", [{ to: address, data }, block]);
  try { return ABI.decodeFunctionResult(fragment, result)[0]; }
  catch (_) { throw new Error("call-invalid"); }
}

async function logs(rpc, provider, address, topic, from, to) {
  const result = await rpc(provider, "eth_getLogs", [{ address, fromBlock: hex(from), toBlock: hex(to), topics: [topic] }]);
  if (!Array.isArray(result)) throw new Error("logs-invalid");
  return result.length;
}

const min = (a, b) => a < b ? a : b;
const boundedV1Offset = (deposits, maxOffset, debt) => min(min(BigInt(deposits), BigInt(maxOffset)), BigInt(debt));
function classify(trove, { branch, mcrBps, blockNumber, recoveryMode = false, spAvailable = 0n, offsettableDebt = 0n }) {
  const debt = BigInt(trove.debt);
  const coll = BigInt(trove.coll);
  const icr = BigInt(trove.icr);
  if (debt <= 0n || icr >= BigInt(mcrBps) * WAD / 10_000n) return null;
  const toOffset = min(spAvailable, offsettableDebt || debt);
  const offsetColl = debt > 0n ? coll * min(toOffset, debt) / debt : 0n;
  const comp = branch === "v1" ? 200n * WAD + coll / 200n : 37500000000000000n + min(offsetColl / 200n, 2n * WAD);
  return {
    ...(branch === "v1" ? { borrower: trove.id } : { id: String(trove.id) }), branch,
    debt: debt.toString(), coll: coll.toString(), icrBps: (icr * 10_000n / WAD).toString(), blockNumber,
    compBasis: branch === "v1" ? (recoveryMode ? "v1-recovery-gross" : "v1-normal-gross") : "v2-bounded-sp-offset-gross",
    compGrossWei: comp.toString(), allGrossPositive: false, routePositive: "unknown", autoExecutable: false, signedActionJustified: false,
  };
}

function emptyArtifact() {
  return { schema: "liquity-liquidation-watch/v1", generatedAt: new Date().toISOString(), blockNumber: null, rpcStrength: "none", families: [],
    v1: { lastGoodPrice: null, freshnessSeconds: null, recoveryMode: null, spTotalLUSD: null, spMaxOffset: null, trackedEligible: [], recentLiquidationEvents: { troveLiquidated: null, liquidation: null } },
    v2: { branches: DEPLOYMENT.branches.map((b) => ({ branch: b.collSymbol, lastGoodPrice: null, freshnessSeconds: null, priceSource: null, spTotalBold: null, troveSweep: "PENDING", trackedEligible: [], recentOracleShutdownEvents: null })) },
    records: "autoGenerated", readonly: true, allGrossPositive: false, routePositive: "unknown", autoExecutable: false, signedActionJustified: false, failClosed: true };
}

async function poll({ inventoryText, fetchFn } = {}) {
  const artifact = emptyArtifact();
  const net = transport(fetchFn);
  try {
    if (inventoryText === undefined && !fs.existsSync(INVENTORY)) throw new Error("authorized-inventory-unavailable");
    const pool = parseInventory(inventoryText === undefined ? fs.readFileSync(INVENTORY, "utf8") : inventoryText)
      .filter((row) => row.ethereumHint !== false).slice(0, 24);
    if (!pool.length) throw new Error("no-eligible-candidates");
    const qualified = [];
    for (const provider of pool) {
      if (net.count >= 18 || selectFamilies(qualified).length >= 2) break;
      if (await qualify(provider, net.rpc)) qualified.push({ provider });
    }
    const selected = selectFamilies(qualified);
    if (!selected.length) throw new Error("no-qualified-provider");
    artifact.families = selected.map((_, i) => `f${String.fromCharCode(65 + i)}`);
    artifact.rpcStrength = selected.length === 2 ? "two-independent-declared-families" : "single-declared-family";
    const provider = selected[0].provider;
    const block = await net.rpc(provider, "eth_getBlockByNumber", ["latest", false]);
    if (!block || !quantity(block.number)) throw new Error("latest-block-invalid");
    artifact.blockNumber = Number(BigInt(block.number));
    const tag = block.number;
    const from = Math.max(0, artifact.blockNumber - 999);
    const v1 = artifact.v1;
    const v1Price = await call(net.rpc, provider, V1.priceFeed, "lastGoodPrice()", [], tag);
    v1.lastGoodPrice = v1Price.toString();
    // lastGoodPrice has no update timestamp; freshness is unknown, not fabricated.
    v1.recoveryMode = await call(net.rpc, provider, V1.manager, "checkRecoveryMode(uint256)", [v1Price], tag);
    const deposits = await call(net.rpc, provider, V1.pool, "getTotalLUSDDeposits()", [], tag);
    let maxOffset = 0n;
    try { maxOffset = await call(net.rpc, provider, V1.pool, "getMaxAmountToOffset()", [], tag); }
    catch (_) { v1.spMaxOffsetStatus = "UNAVAILABLE_FAIL_CLOSED"; }
    v1.spTotalLUSD = deposits.toString();
    v1.spMaxOffset = v1.spMaxOffsetStatus ? null : maxOffset.toString();
    // Descending nominal CR from tail; only compute exact ICR for flagged candidates.
    let above = 0;
    for (let start = 0; start < PAGE && above < 3; start += 10) {
      const page = await call(net.rpc, provider, V1.getter, "getMultipleSortedTroves(int256,uint256)", [-BigInt(start + 1), 10], tag);
      if (!page.length) break;
      for (const trove of page) {
        if (!trove.debt) continue;
        const nominal = trove.coll * v1Price / trove.debt;
        if (nominal >= 12n * WAD / 10n) { above++; continue; }
        above = 0;
        const icr = await call(net.rpc, provider, V1.manager, "getCurrentICR(address,uint256)", [trove.owner, v1Price], tag);
        const row = classify({ id: trove.owner, debt: trove.debt, coll: trove.coll, icr }, { branch: "v1", mcrBps: 11000, blockNumber: artifact.blockNumber, recoveryMode: v1.recoveryMode, spAvailable: boundedV1Offset(deposits, maxOffset, trove.debt) });
        if (row) v1.trackedEligible.push(row);
      }
      if (page.length < 10) break;
    }
    v1.recentLiquidationEvents.troveLiquidated = await logs(net.rpc, provider, V1.manager, V1_TROVE_TOPIC, from, artifact.blockNumber);
    v1.recentLiquidationEvents.liquidation = await logs(net.rpc, provider, V1.manager, V1_AGG_TOPIC, from, artifact.blockNumber);

    for (const [index, b] of DEPLOYMENT.branches.entries()) {
      const result = artifact.v2.branches[index];
      const price = await call(net.rpc, provider, b.priceFeed, "lastGoodPrice()", [], tag);
      result.lastGoodPrice = price.toString();
      result.priceSource = Number(await call(net.rpc, provider, b.priceFeed, "priceSource()", [], tag));
      const sp = await call(net.rpc, provider, b.stabilityPool, "getTotalBoldDeposits()", [], tag);
      result.spTotalBold = sp.toString();
      result.recentOracleShutdownEvents = await logs(net.rpc, provider, b.priceFeed, SHUTDOWN_TOPIC, from, artifact.blockNumber);
      // Interest-rate ordering gives no ICR cutoff; never claim a full branch scan.
      const page = await call(net.rpc, provider, DEPLOYMENT.multiTroveGetter, "getMultipleSortedTroves(uint256,int256,uint256)", [index, -1, 12], tag);
      result.troveSweep = page.length === 12 ? "BOUNDED_12_NOT_EXHAUSTIVE" : "COMPLETE_FROM_TAIL";
      const mcrBps = index === 0 ? 11000 : 12000;
      const candidates = [];
      for (const trove of page) {
        const icr = await call(net.rpc, provider, b.troveManager, "getCurrentICR(uint256,uint256)", [trove.id, price], tag);
        if (icr < BigInt(mcrBps) * WAD / 10000n) candidates.push({ id: trove.id, debt: trove.entireDebt, coll: trove.entireColl, icr });
      }
      const offsettableDebt = candidates.reduce((sum, trove) => sum + trove.debt, 0n);
      // Conservative bounded share across observed eligible troves only.
      for (const trove of candidates) {
        const share = offsettableDebt ? min(sp, offsettableDebt) * trove.debt / offsettableDebt : 0n;
        result.trackedEligible.push(classify(trove, { branch: b.collSymbol, mcrBps, blockNumber: artifact.blockNumber, spAvailable: share, offsettableDebt: trove.debt }));
      }
    }
    // Without gas data and a complete cross-provider trove sweep, never assert execution readiness.
    artifact.failClosed = true;
  } catch (error) { artifact.error = safeCode(error); artifact.failClosed = true; }
  return artifact;
}

function persist(artifact, directory = OUT) {
  fs.mkdirSync(directory, { recursive: true });
  const historyFile = path.join(directory, "history.json");
  let history = [];
  try { const existing = JSON.parse(fs.readFileSync(historyFile, "utf8")); if (Array.isArray(existing)) history = existing; } catch (_) { /* new or invalid history */ }
  function atomic(file, value) {
    const temp = path.join(directory, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
    try { fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); fs.renameSync(temp, file); }
    finally { try { fs.unlinkSync(temp); } catch (_) { /* already renamed */ } }
  }
  atomic(path.join(directory, "status.json"), artifact);
  atomic(historyFile, [...history.slice(-39), artifact]);
}

async function main(argv = process.argv.slice(2)) {
  const once = argv.length === 1 && argv[0] === "--once";
  const loop = (argv.length === 1 && argv[0] === "--loop") || (argv.length === 2 && argv[0] === "--loop" && /^\d+$/.test(argv[1]) && Number(argv[1]) >= 4);
  if (!once && !loop && argv.length) throw new Error("invalid-arguments");
  const interval = argv.length === 2 ? Number(argv[1]) : 300;
  let failures = 0;
  do {
    const artifact = await poll();
    persist(artifact);
    const rows = artifact.v1.trackedEligible.length + artifact.v2.branches.reduce((sum, b) => sum + b.trackedEligible.length, 0);
    process.stdout.write(JSON.stringify({ ok: !artifact.error, blockNumber: artifact.blockNumber, families: artifact.families, eligibleCount: rows, failClosed: artifact.failClosed, reason: artifact.error || null }) + "\n");
    failures = artifact.error ? failures + 1 : 0;
    if (once || failures >= 2 || rows > 0) { if (artifact.error) process.exitCode = 1; break; }
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));
  } while (true);
}

module.exports = { parseInventory, selectFamilies, transport, qualify, boundedV1Offset, classify, emptyArtifact, poll, persist, main };
if (require.main === module) main().catch(() => { process.stdout.write(JSON.stringify({ ok: false, reason: "artifact-write-failure" }) + "\n"); process.exitCode = 1; });
