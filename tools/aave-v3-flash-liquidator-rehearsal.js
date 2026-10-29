#!/usr/bin/env node
"use strict";

// aave-v3-flash-liquidator-rehearsal.js
// Keyless, local-only fork rehearsal for the deployed Aave V3 flash liquidator
// 0x1C4Bc8d8b5806C1D73b47bC7ae4c2b6552c858A1 (owner 0x24e4...ce0a).
//
// Proves the deployed executor's liquidation route on a fork-local copy of current
// mainnet state with a RECORDED fork-local oracle price intervention that reproduces
// the trigger condition, then measures real route economics. No real-network write,
// no key access, no signing (fork txs are sent from an impersonated/funded EOA).
//
// Endpoint material (URL/host/path) is NEVER printed, persisted, or forwarded to
// children; anvil forks through an in-process loopback relay that owns the upstream,
// mirroring tools/liquity-fork-rehearsal.js.

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");
const { spawn, spawnSync } = require("node:child_process");
const { Interface, keccak256, AbiCoder } = require(path.join(__dirname, "node_modules", "ethers"));

const ROOT = path.resolve(__dirname, "..");
const OUTDIR = path.join(ROOT, "reports", "raw", "fast", "aave-v3-flash-liquidator-fork-rehearsal");
const OUTPUT = path.join(OUTDIR, "result.json");
const INVENTORY = path.join(ROOT, "rpc_endpoints.txt");
const ANVIL = "C:\\Users\\MiPC\\.foundry\\bin\\anvil.exe";

const CHAIN_ID = 1;
const POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const ORACLE = "0x54586bE62E3c3580375aE3723C145253060Ca0C2";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const WEETH = "0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee";
const BORROWER = "0x1A557354C5b8d7Df38ea914209e416Dc7065b158";
const EXEC = "0x1C4Bc8d8b5806C1D73b47bC7ae4c2b6552c858A1";
const OWNER = "0x24e46e91dFAAD1FA3d49C48Aa85ca9306885ce0a";
const VAULT = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";
const ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
const DPROV = "0x41393e5e337606dc3821075Af65AeE84D7688CBD";
const QUOTER = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const WEETH_SOURCE = "0x87625393534d5C102cADB66D37201dF24cc26d4C";

const LIMIT_MS = 240000;
const INTERVENTION_FACTOR_BPS = 9900n; // weETH oracle to 99% of live -> HF just below 1
const SWAP_FEE = 500;
const MAX_ORACLE_SLOT_SCAN = 20;
const OWNER_FUND_WEI = 10n * 10n ** 18n;
const EXEC_GAS = 3_000_000;
const DEPLOY_GAS = 1_000_000;
const GAS_PRICE_WEI = 2_000_000_000n;

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
let live = null;

const IFACE = {
  pool: new Interface([
    "function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)",
    "function FLASHLOAN_PREMIUM_TOTAL() view returns (uint128)",
  ]),
  oracle: new Interface([
    "function getAssetPrice(address) view returns (uint256)",
    "function getSourceOfAsset(address) view returns (address)",
  ]),
  exec: new Interface([
    "function owner() view returns (address)",
    "function execute(uint256,uint256,uint256,bytes)",
    "function isLiquidatable() view returns (bool,uint256)",
    "function AAVE_V3_POOL() view returns (address)",
    "function WETH() view returns (address)",
    "function COLLATERAL_TOKEN() view returns (address)",
    "function UNISWAP_ROUTER() view returns (address)",
    "function BORROWER() view returns (address)",
  ]),
  erc20: new Interface([
    "function balanceOf(address) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
  ]),
  quoter: new Interface(["function quoteExactInput(bytes,uint256) returns (uint256,uint160[],uint32[],uint256)"]),
  dp: new Interface([
    "function getUserReserveData(address,address) view returns (uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint40,bool)",
    "function getReserveConfigurationData(address) view returns (uint256,uint256,uint256,uint256,uint256,bool,bool,bool,bool,bool)",
  ]),
  aaveEvents: new Interface([
    "event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)",
  ]),
  balancerEvents: new Interface([
    "event FlashLoan(address indexed recipient, address indexed token, uint256 amount, uint256 feeAmount)",
  ]),
};

const CODES = new Set([
  "ANVIL_MISSING", "ANVIL_CLEANUP_FAILED", "ANVIL_ARGUMENTS_INVALID", "ANVIL_START_FAILED",
  "FORK_BLOCK_MISMATCH", "FORK_BACKING_UNSUPPORTED", "FORK_BACKING_METHOD_MISSING", "FORK_BACKING_STATE_MISSING",
  "FORK_BACKING_BLOCK_FAILURE", "FORK_BACKING_CHAIN_ID_FAILURE", "FORK_BACKING_GAS_PRICE_FAILURE",
  "FORK_BACKING_TRANSACTION_FAILURE", "FORK_BACKING_PROOF_FAILURE", "FORK_BACKING_CODE_FAILURE",
  "FORK_BACKING_BALANCE_FAILURE", "FORK_BACKING_RATE_LIMITED",
  "INVENTORY_MISSING", "NO_ARCHIVE_BACKING", "DEADLINE_EXCEEDED",
  "POOL_CODE_MISSING", "EXEC_CODE_MISSING", "ORACLE_CODE_MISSING", "ORACLE_SLOT_UNPROVEN",
  "INTERVENTION_NOT_APPLIED", "MOCK_DEPLOY_FAILED", "HF_READ_INVALID", "EXEC_IMMUTABLE_MISMATCH",
  "MEASURED_STATIC_REVERTED", "MEASURED_TX_REVERTED", "NEGATIVE_CONTROL_FAILED", "NO_MEASURED_CASE",
  "SNAPSHOT_REVERT_FAILED",
  "RPC_RESPONSE_TOO_LARGE", "UPSTREAM_UNAVAILABLE", "UPSTREAM_RPC_ERROR", "LOCAL_RPC_UNAVAILABLE", "LOCAL_RPC_ERROR",
]);

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
    if (typeof data === "string" && /^0x[0-9a-f]+$/i.test(data)) error.revertData = data.toLowerCase();
    throw error;
  }
  if (!body || Array.isArray(body) || body.result === undefined) fail(upstream ? "UPSTREAM_RPC_ERROR" : "LOCAL_RPC_ERROR");
  return body.result;
}

async function* qualifiedUpstreams() {
  const archive = ["https://eth.blockscout.com/api/eth-rpc", "https://eth.drpc.org"];
  const fallback = ["https://gateway.tenderly.co/public/mainnet", "https://rpc.mevblocker.io"];
  const pool = [
    ...archive.map((url) => ({ url, backingClass: "PUBLIC_KEYLESS_ARCHIVE" })),
    ...fallback.map((url) => ({ url, backingClass: "PUBLIC_KEYLESS_ARCHIVE" })),
    ...parseInventory().map((url) => ({ url, backingClass: "PUBLIC_KEYLESS_INVENTORY" })),
  ];
  const seen = new Set();
  for (const candidate of pool) {
    const { url } = candidate;
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      if (await request(url, "eth_chainId", [], true) !== "0x1") continue;
      const head = (await request(url, "eth_getBlockByNumber", ["finalized", false], true).catch(() => null))
        || (await request(url, "eth_getBlockByNumber", ["latest", false], true));
      if (!head || !/^0x[0-9a-f]{64}$/i.test(head.hash || "") || !/^0x[0-9a-f]+$/i.test(head.number || "")) continue;
      const pin = Number(BigInt(head.number)) - 1;
      const pinBlock = await request(url, "eth_getBlockByNumber", [quantity(pin), false], true);
      if (!pinBlock || Number(BigInt(pinBlock.number)) !== pin || !/^0x[0-9a-f]{64}$/i.test(pinBlock.hash || "")) continue;
      const code = await request(url, "eth_getCode", [POOL, quantity(pin)], true);
      const ecode = await request(url, "eth_getCode", [EXEC, quantity(pin)], true);
      const ocode = await request(url, "eth_getCode", [ORACLE, quantity(pin)], true);
      if (typeof code !== "string" || code.length <= 2) continue;
      if (typeof ecode !== "string" || ecode.length <= 2) continue;
      if (typeof ocode !== "string" || ocode.length <= 2) continue;
      const probe = await request(url, "eth_call", [{ to: POOL, data: IFACE.pool.encodeFunctionData("getUserAccountData", [BORROWER]) }, quantity(pin)], true);
      if (IFACE.pool.decodeFunctionResult("getUserAccountData", probe).length !== 6) continue;
      yield { ...candidate, pin, headNumber: Number(BigInt(head.number)) };
    } catch (_) { /* candidate failed qualification; never expose its error */ }
  }
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
  anvil = spawn(ANVIL, ["--host", "127.0.0.1", "--port", String(port), "--fork-url", relayUrl,
    "--fork-block-number", String(pin), "--no-rate-limit", "--block-base-fee-per-gas", "1000000000"],
  { stdio: ["ignore", "ignore", "pipe"], windowsHide: true, shell: false });
  let bootDiagnostic = "";
  anvil.stderr.on("data", (chunk) => { bootDiagnostic = (bootDiagnostic + chunk.toString("utf8")).slice(-16384); });
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
  for (let attempt = 0; attempt < 60; attempt += 1) {
    budget();
    if (anvil.exitCode !== null) fail(bootError());
    const local = `http://127.0.0.1:${port}`;
    try { if (await request(local, "eth_chainId", []) === "0x1" && Number(BigInt(await request(local, "eth_blockNumber", []))) === pin) return local; } catch (_) { /* boot in progress */ }
    await delay(120);
  }
  fail(bootError());
}

// ---------------------------------------------------------------------------
// fork-local reads + intervention
// ---------------------------------------------------------------------------
async function readCall(local, to, iface, fn, args, from) {
  const data = iface.encodeFunctionData(fn, args);
  const req = { to, data };
  if (from) req.from = from;
  return iface.decodeFunctionResult(fn, await request(local, "eth_call", [req, "latest"]));
}

async function scanOracleSlot(local, source) {
  for (let base = 0; base <= MAX_ORACLE_SLOT_SCAN; base += 1) {
    const slot = keccak256(AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [WEETH, base]));
    const val = await request(local, "eth_getStorageAt", [ORACLE, slot, "latest"]);
    if (typeof val !== "string" || !/^0x[0-9a-f]{64}$/i.test(val)) continue;
    const addr = "0x" + val.slice(-40);
    if (addr.toLowerCase() === source.toLowerCase()) return { baseSlot: base, slot };
  }
  fail("ORACLE_SLOT_UNPROVEN");
}

function mockAggregatorDeployData(price) {
  // runtime: PUSH32 price; PUSH1 0; MSTORE; PUSH1 32; PUSH1 0; RETURN
  const runtime = "7f" + BigInt(price).toString(16).padStart(64, "0") + "600052" + "6020" + "6000" + "f3";
  const runtimeLen = runtime.length / 2;
  const offset = 12;
  const push = (n) => (n <= 0xff ? "60" + n.toString(16).padStart(2, "0") : "61" + n.toString(16).padStart(4, "0"));
  const init = push(runtimeLen) + push(offset) + "6000" + "39" + push(runtimeLen) + "6000" + "f3";
  return "0x" + init + runtime;
}

async function sendTx(local, tx) {
  const hash = await request(local, "eth_sendTransaction", [tx]);
  let receipt = null;
  for (let n = 0; n < 40 && !receipt; n += 1) { receipt = await request(local, "eth_getTransactionReceipt", [hash]); if (!receipt) await delay(120); }
  return { hash, receipt };
}

function decodeRevert(error) {
  if (!error || error.reverted !== true) return null;
  const data = error.revertData;
  if (!data) return "reverted";
  try {
    if (data.startsWith("0x08c379a0")) {
      const [msg] = AbiCoder.defaultAbiCoder().decode(["string"], "0x" + data.slice(10));
      return String(msg);
    }
    if (data.startsWith("0x4e487b71")) {
      const [code] = AbiCoder.defaultAbiCoder().decode(["uint256"], "0x" + data.slice(10));
      return "Panic(0x" + code.toString(16) + ")";
    }
    // Aave V3 custom errors (selector map)
    const CUSTOM = { "0x930bb771": "HealthFactorNotBelowThreshold()", "0xc8bb2d2e": "HealthFactorHigherThanLiquidationThreshold()", "0x979b5ce8": "CollateralCannotBeLiquidated()" };
    const sel = data.slice(0, 10);
    if (CUSTOM[sel]) return CUSTOM[sel];
  } catch (_) { /* fall through to selector */ }
  return data.slice(0, 10);
}

function decodeExecutionLogs(receipt) {
  let collAtaWei = null;
  let debtCoveredWei = null;
  let balancerFeeWei = null;
  for (const log of receipt.logs || []) {
    try {
      if (log.address.toLowerCase() === POOL.toLowerCase() && log.topics[0].toLowerCase() === IFACE.aaveEvents.getEvent("LiquidationCall").topicHash.toLowerCase()) {
        const parsed = IFACE.aaveEvents.parseLog(log);
        collAtaWei = parsed.args.liquidatedCollateralAmount.toString();
        debtCoveredWei = parsed.args.debtToCover.toString();
      }
      if (log.address.toLowerCase() === VAULT.toLowerCase() && log.topics[0].toLowerCase() === IFACE.balancerEvents.getEvent("FlashLoan").topicHash.toLowerCase()) {
        const parsed = IFACE.balancerEvents.parseLog(log);
        balancerFeeWei = parsed.args.feeAmount.toString();
      }
    } catch (_) { /* unrelated log */ }
  }
  return { collAtaWei, debtCoveredWei, balancerFeeWei };
}

// ---------------------------------------------------------------------------
// main run
// ---------------------------------------------------------------------------
async function run() {
  if (!fs.existsSync(ANVIL)) fail("ANVIL_MISSING");
  stage = "QUALIFY";
  let relayUrl = null;
  let local = null;
  let qualified = null;
  for await (const backing of qualifiedUpstreams()) {
    try {
      relayUrl = await startRelay(backing.url);
      stage = "QUALIFY_FORK";
      local = await startAnvil(relayUrl, backing.pin);
      qualified = backing;
      break;
    } catch (error) {
      if (!stopAnvil()) fail("ANVIL_CLEANUP_FAILED");
      if (relay) { relay.closeAllConnections(); relay.close(); relay = null; }
      relayUrl = null;
      if (error?.message === "DEADLINE_EXCEEDED" || error?.message === "ANVIL_CLEANUP_FAILED") throw error;
    }
  }
  if (!relayUrl || !qualified) fail("NO_ARCHIVE_BACKING");

  const pin = qualified.pin;
  if (Number(BigInt(await request(local, "eth_blockNumber", []))) !== pin) fail("FORK_BLOCK_MISMATCH");

  // ---- context / code presence ----
  stage = "CONTEXT";
  if ((await request(local, "eth_getCode", [POOL, "latest"])) === "0x") fail("POOL_CODE_MISSING");
  if ((await request(local, "eth_getCode", [EXEC, "latest"])) === "0x") fail("EXEC_CODE_MISSING");
  if ((await request(local, "eth_getCode", [ORACLE, "latest"])) === "0x") fail("ORACLE_CODE_MISSING");

  // executor immutables must match the deployed deployment batch
  const immutables = {};
  for (const fn of ["owner", "AAVE_V3_POOL", "WETH", "COLLATERAL_TOKEN", "UNISWAP_ROUTER", "BORROWER"]) {
    immutables[fn] = (await readCall(local, EXEC, IFACE.exec, fn, []))[0];
  }
  if (immutables.AAVE_V3_POOL.toLowerCase() !== POOL.toLowerCase()) fail("EXEC_IMMUTABLE_MISMATCH");
  if (immutables.WETH.toLowerCase() !== WETH.toLowerCase()) fail("EXEC_IMMUTABLE_MISMATCH");
  if (immutables.COLLATERAL_TOKEN.toLowerCase() !== WEETH.toLowerCase()) fail("EXEC_IMMUTABLE_MISMATCH");
  if (immutables.UNISWAP_ROUTER.toLowerCase() !== ROUTER.toLowerCase()) fail("EXEC_IMMUTABLE_MISMATCH");
  if (immutables.BORROWER.toLowerCase() !== BORROWER.toLowerCase()) fail("EXEC_IMMUTABLE_MISMATCH");

  // ---- live reads at pin ----
  stage = "LIVE_READS";
  const account = await readCall(local, POOL, IFACE.pool, "getUserAccountData", [BORROWER]);
  const healthFactor = account[5];
  if (healthFactor === undefined) fail("HF_READ_INVALID");
  const oracleWeethPrice = (await readCall(local, ORACLE, IFACE.oracle, "getAssetPrice", [WEETH]))[0];
  const oracleWethPrice = (await readCall(local, ORACLE, IFACE.oracle, "getAssetPrice", [WETH]))[0];
  const weethSource = (await readCall(local, ORACLE, IFACE.oracle, "getSourceOfAsset", [WEETH]))[0];
  const reserveCfg = await readCall(local, DPROV, IFACE.dp, "getReserveConfigurationData", [WEETH]);
  const liquidationBonusBps = reserveCfg[3];
  const wethUser = await readCall(local, DPROV, IFACE.dp, "getUserReserveData", [WETH, BORROWER]);
  const weethUser = await readCall(local, DPROV, IFACE.dp, "getUserReserveData", [WEETH, BORROWER]);
  const debtWeth = wethUser[1] + wethUser[2];
  const collWeethAToken = weethUser[0];

  const caseBlockers = [];
  if (healthFactor < 10n ** 18n) caseBlockers.push("already-liquidatable-at-pin");

  const artifacts = {
    schema: "aave-v3-flash-liquidator-fork-rehearsal/v1",
    generatedAt: new Date().toISOString(),
    scanner: "tools/aave-v3-flash-liquidator-rehearsal.js",
    chainId: CHAIN_ID,
    pinBlock: pin,
    headBlock: qualified.headNumber,
    executor: EXEC,
    owner: immutables.owner,
    borrower: BORROWER,
    pool: POOL,
    oracle: ORACLE,
    collateralToken: WEETH,
    debtToken: WETH,
    router: ROUTER,
    relayOnly: true,
    endpointProcessOnly: true,
    sourceEndpointClass: qualified.backingClass.startsWith("PUBLIC_KEYLESS") ? qualified.backingClass : "PUBLIC_KEYLESS",
    backingClass: qualified.backingClass,
    liveReads: {
      healthFactorWei: healthFactor.toString(),
      healthFactor: Number(healthFactor) / 1e18,
      oracleWeethPriceRaw: oracleWeethPrice.toString(),
      oracleWethPriceRaw: oracleWethPrice.toString(),
      weethSource,
      liquidationBonusBps: liquidationBonusBps.toString(),
      debtWethRaw: debtWeth.toString(),
      collateralWeethATokenRaw: collWeethAToken.toString(),
      currentLiquidatable: healthFactor < 10n ** 18n,
    },
    callerFunding: { method: "anvil_setBalance+anvil_impersonateAccount", amountWei: OWNER_FUND_WEI.toString(), impersonated: true, signed: false },
    interventions: [],
    cases: [],
    negatives: [],
    attempts: [],
    caseBlockers,
    gateNote: "liveExecutorReady stays false until real-state fork proof at trigger time",
    readonly: true,
    signedActionJustified: false,
    spawnedAt: new Date().toISOString(),
  };
  live = artifacts;

  // ---- prepare owner (impersonated/funded) ----
  stage = "FUND_OWNER";
  await request(local, "anvil_setBalance", [OWNER, quantity(OWNER_FUND_WEI)]);
  await request(local, "anvil_impersonateAccount", [OWNER]);
  if ((await request(local, "eth_getCode", [OWNER, "latest"])) !== "0x") fail("EXEC_IMMUTABLE_MISMATCH");

  // swap path weETH -> WETH at SWAP_FEE (20-byte token + 3-byte fee + 20-byte token)
  const swapPath = WEETH.toLowerCase().replace(/^0x/, "") + SWAP_FEE.toString(16).padStart(6, "0") + WETH.toLowerCase().replace(/^0x/, "");
  const repay = debtWeth / 2n;
  const quotePath = "0x" + swapPath;

  const quoteFor = async (amountIn) => {
    if (amountIn <= 0n) return 0n;
    const out = await readCall(local, QUOTER, IFACE.quoter, "quoteExactInput", [quotePath, amountIn]);
    return out[0];
  };

  const execData = (debtToCover, minProfitWei, minOut) =>
    IFACE.exec.encodeFunctionData("execute", [debtToCover, minProfitWei, minOut, quotePath]);

  const staticCall = async (data) => {
    try {
      await request(local, "eth_call", [{ from: OWNER, to: EXEC, data }, "latest"]);
      return { reverted: false };
    } catch (error) {
      if (error.reverted !== true) throw error;
      return { reverted: true, reason: decodeRevert(error), revertData: error.revertData || null };
    }
  };

  // ---- negative (b): minOut = 0 -> MIN_OUT_REQUIRED (no intervention needed) ----
  stage = "NEGATIVE_MINOUT_ZERO";
  const negMinOut = await staticCall(execData(repay, 0n, 0n));
  artifacts.negatives.push({
    kind: "minOut-zero-undercut", expected: "MIN_OUT_REQUIRED", staticCallReverted: negMinOut.reverted,
    revertReason: negMinOut.reason, controlledIntervention: "NONE",
    status: negMinOut.reverted ? "PASS" : "FAIL",
  });

  // ---- negative (c): HF >= 1 un-intervened control -> liquidation must revert ----
  // (minOut value is irrelevant here: the revert happens inside liquidationCall)
  stage = "NEGATIVE_HF_CONTROL";
  const negHf = await staticCall(execData(repay, 0n, 1n));
  artifacts.negatives.push({
    kind: "hf-above-one-control", expected: "HEALTH_FACTOR_NOT_BELOW_THRESHOLD", staticCallReverted: negHf.reverted,
    revertReason: negHf.reason, revertSelector: negHf.revertData ? negHf.revertData.slice(0, 10) : null, controlledIntervention: "NONE",
    status: negHf.reverted ? "PASS" : "FAIL",
  });

  // ---- apply recorded fork-local oracle intervention ----
  stage = "INTERVENTION";
  const oracleSlotInfo = await scanOracleSlot(local, weethSource);
  const mockPrice = oracleWeethPrice * INTERVENTION_FACTOR_BPS / 10000n;
  const { receipt: deployReceipt } = await sendTx(local, {
    from: OWNER, data: mockAggregatorDeployData(mockPrice), gas: quantity(DEPLOY_GAS), gasPrice: quantity(GAS_PRICE_WEI),
  });
  if (!deployReceipt || deployReceipt.status !== "0x1" || !deployReceipt.contractAddress) fail("MOCK_DEPLOY_FAILED");
  const mock = deployReceipt.contractAddress;
  await request(local, "anvil_setStorageAt", [ORACLE, oracleSlotInfo.slot, word(mock)]);
  const applied = (await readCall(local, ORACLE, IFACE.oracle, "getAssetPrice", [WEETH]))[0];
  if (applied !== mockPrice) fail("INTERVENTION_NOT_APPLIED");
  const hfAfter = (await readCall(local, POOL, IFACE.pool, "getUserAccountData", [BORROWER]))[5];
  artifacts.interventions.push({
    case: "MEASURED_INTERVENTION",
    kind: "AAVE_ORACLE_PRICE_SOURCE_SET",
    baseSlot: oracleSlotInfo.baseSlot,
    slot: oracleSlotInfo.slot,
    from: weethSource,
    to: mock,
    livePriceRaw: oracleWeethPrice.toString(),
    mockPriceRaw: mockPrice.toString(),
    factorBps: Number(INTERVENTION_FACTOR_BPS),
    healthFactorAfterWei: hfAfter.toString(),
    healthFactorAfter: Number(hfAfter) / 1e18,
  });
  if (hfAfter >= 10n ** 18n) fail("INTERVENTION_NOT_APPLIED");

  // ---- probe: measure the actual seized collateral + swap output on the fork ----
  // The borrower is in E-Mode (effective liquidation bonus ~1.01, not the reserve's
  // 1.07) plus a protocol fee, so the seized amount is measured, not assumed. A
  // snapshot/probe/revert keeps the fork deterministic for the recorded case.
  stage = "PROBE";
  const snapshot = await request(local, "evm_snapshot", []);
  const probeOwnerBefore = BigInt((await readCall(local, WETH, IFACE.erc20, "balanceOf", [OWNER]))[0]);
  const probe = await sendTx(local, { from: OWNER, to: EXEC, data: execData(repay, 0n, 1n), gas: quantity(EXEC_GAS), gasPrice: quantity(GAS_PRICE_WEI) });
  if (!probe.receipt || probe.receipt.status !== "0x1") {
    artifacts.attempts.push({ case: "PROBE", reverted: true, reason: "probe-receipt-nonzero" });
    fail("MEASURED_TX_REVERTED");
  }
  const probeOwnerAfter = BigInt((await readCall(local, WETH, IFACE.erc20, "balanceOf", [OWNER]))[0]);
  const probeLogs = decodeExecutionLogs(probe.receipt);
  const probeFee = probeLogs.balancerFeeWei === null ? 0n : BigInt(probeLogs.balancerFeeWei);
  const probeRepay = repay + probeFee;
  const probeNet = probeOwnerAfter - probeOwnerBefore;
  const probeSwapOut = probeNet + probeRepay;
  const probeSeized = probeLogs.collAtaWei === null ? 0n : BigInt(probeLogs.collAtaWei);
  if (!await request(local, "evm_revert", [snapshot])) fail("SNAPSHOT_REVERT_FAILED");
  const quotedSwapOut = await quoteFor(probeSeized);
  const minOut = probeSwapOut * 98n / 100n;
  if (process.env.REHEARSAL_DEBUG === "1") process.stderr.write(`[debug] probe seized=${probeSeized} swapOut=${probeSwapOut} net=${probeNet} quoted=${quotedSwapOut} minOut=${minOut}\n`);

  // ---- negative (a): minProfit above achievable -> must revert ----
  stage = "NEGATIVE_MINPROFIT";
  const negProfit = await staticCall(execData(repay, 10n ** 30n, minOut));
  artifacts.negatives.push({
    kind: "minProfit-above-achievable", expected: "profit below minimum", staticCallReverted: negProfit.reverted,
    revertReason: negProfit.reason, revertSelector: negProfit.revertData ? negProfit.revertData.slice(0, 10) : null,
    controlledIntervention: "MEASURED_INTERVENTION", status: negProfit.reverted ? "PASS" : "FAIL",
  });

  // ---- measured executor execution ----
  stage = "MEASURED_STATIC";
  const measuredData = execData(repay, 0n, minOut);
  const staticResult = await staticCall(measuredData);
  if (staticResult.reverted) {
    artifacts.attempts.push({ case: "MEASURED_EXECUTION", reverted: true, reason: staticResult.reason, revertSelector: staticResult.revertData ? staticResult.revertData.slice(0, 10) : null });
    fail("MEASURED_STATIC_REVERTED");
  }

  stage = "MEASURED_TX";
  const ownerWethBefore = BigInt((await readCall(local, WETH, IFACE.erc20, "balanceOf", [OWNER]))[0]);
  const { receipt } = await sendTx(local, {
    from: OWNER, to: EXEC, data: measuredData, gas: quantity(EXEC_GAS), gasPrice: quantity(GAS_PRICE_WEI),
  });
  if (!receipt || receipt.status !== "0x1") {
    artifacts.attempts.push({ case: "MEASURED_EXECUTION", reverted: true, reason: "receipt-status-nonzero" });
    fail("MEASURED_TX_REVERTED");
  }
  const ownerWethAfter = BigInt((await readCall(local, WETH, IFACE.erc20, "balanceOf", [OWNER]))[0]);
  const gasUsed = BigInt(receipt.gasUsed);
  const decoded = decodeExecutionLogs(receipt);
  const collAtaWei = decoded.collAtaWei;
  const balancerFeeWei = decoded.balancerFeeWei;

  const feeWei = balancerFeeWei === null ? 0n : BigInt(balancerFeeWei);
  const repayAmountWei = repay + feeWei;
  const netWei = ownerWethAfter - ownerWethBefore; // profit to owner
  const swapOutWei = netWei + repayAmountWei; // WETH in from swap = repay + profit
  if (process.env.REHEARSAL_DEBUG === "1") process.stderr.write(`[debug] actual collAta=${collAtaWei} fee=${feeWei} net=${netWei} swapOut=${swapOutWei} gas=${gasUsed}\n`);

  artifacts.cases.push({
    case: "MEASURED_EXECUTION",
    debtToCoverWei: repay.toString(),
    debtCoveredWei: decoded.debtCoveredWei,
    minProfitWei: "0",
    minOutWei: minOut.toString(),
    swapPathFee: SWAP_FEE,
    quotedSwapOutWei: quotedSwapOut.toString(),
    gasUsed: gasUsed.toString(),
    collAtaWei: collAtaWei === null ? null : collAtaWei,
    swapOutWei: swapOutWei.toString(),
    repayAmountWei: repayAmountWei.toString(),
    balancerFlashFeeWei: feeWei.toString(),
    netWei: netWei.toString(),
    ownerWethBeforeWei: ownerWethBefore.toString(),
    ownerWethAfterWei: ownerWethAfter.toString(),
    executed: true,
    receiptStatus: receipt.status,
    controlledIntervention: "MEASURED_INTERVENTION",
  });

  if (artifacts.negatives.some((n) => n.status !== "PASS")) fail("NEGATIVE_CONTROL_FAILED");
  if (artifacts.cases.length < 1) fail("NO_MEASURED_CASE");

  artifacts.completedAt = new Date().toISOString();
  artifacts.state = "PASS";
  return artifacts;
}

function writeResult(result) {
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(result, null, 2) + "\n", "utf8");
}

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
    process.stdout.write(JSON.stringify({
      state: "PASS", pinBlock: result.pinBlock, interventions: result.interventions.length,
      measuredCases: result.cases.length, negatives: result.negatives.map((n) => n.status),
      gasUsed: result.cases[0] ? result.cases[0].gasUsed : null, netWei: result.cases[0] ? result.cases[0].netWei : null,
      cleanup: stopAnvil() ? "clean" : "residual",
    }) + "\n");
  } catch (error) {
    const codes = CODES;
    const reason = codes.has(error?.message) ? error.message : `${stage}_INTERNAL_OR_RELAY_FAILURE`;
    if (process.env.REHEARSAL_DEBUG === "1" && !codes.has(error?.message)) process.stderr.write(`[debug] ${error && error.stack ? error.stack : String(error)}\n`);
    writeResult({
      schema: "aave-v3-flash-liquidator-fork-rehearsal/v1", state: "FAIL_CLOSED", reason, pinBlock: live ? live.pinBlock : null,
      relayOnly: true, endpointProcessOnly: true,
      sourceEndpointClass: live ? live.sourceEndpointClass : null, backingClass: live ? live.backingClass : null,
      liveReads: live ? live.liveReads : null, interventions: live ? live.interventions : [],
      cases: live ? live.cases : [], negatives: live ? live.negatives : [], attempts: live ? live.attempts : [],
      spawnedAt: live ? live.spawnedAt : new Date().toISOString(), completedAt: new Date().toISOString(),
      readonly: true, signedActionJustified: false,
      gateNote: "liveExecutorReady stays false until real-state fork proof at trigger time",
    });
    process.stdout.write(JSON.stringify({ state: "FAIL_CLOSED", reason }) + "\n");
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    stopAnvil();
    if (relay) { relay.closeAllConnections(); relay.close(); }
  }
})();
