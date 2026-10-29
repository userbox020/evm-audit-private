#!/usr/bin/env node
"use strict";

// fluid-t2t4-flash-rehearsal.js
// Keyless, local-only FORK REHEARSAL driver for the built Fluid T2/T4 flash liquidator
// `FltLiquidateT2T4` (contracts/flash-liquidate-fluid-t2t4/).
//
// Design shape (mirrors tools/euler-evk-flash-liquidator-rehearsal.js):
//   * the executor has no mainnet deployment, so this harness forks chain state at the row's
//     Stage-6 pin (through an in-process loopback relay that owns the upstream; anvil only ever
//     talks to 127.0.0.1), asserts the REAL vault / debt token / Balancer / oracle / DEX-pool code
//     is present at the pin, reads the REAL oracle `getExchangeRateLiquidate()`, and probes the REAL
//     vault's `simulateLiquidate(...)` liquidatability at the pin (canonical in-tree max-liquidatable
//     probe: reverts with `FluidLiquidateResult(col,debt)`),
//   * it then deploys the LOCAL `FltLiquidateT2T4` build artifact on the fork and DRIVES `execute()`
//     to completion. Because the REAL vault has no liquidatable position at the pin (recorded), the
//     measured liquidation route is driven against the module's OWN source-verified mock vault
//     (`MockVaultT2`/`MockVaultT4`, the same effect-ordering mocks as `test/FltLiquidateT2T4.t.sol`:
//     pulls the debt at Liquidity, enforces the `colPerUnitDebt_` slippage guard, exits via the
//     one-token DEX path to `to_`), and the result is HONESTLY labelled `MOCK_DRIVEN` (realLegs vs
//     mockLegs recorded) rather than claiming a fork-real liquidation,
//   * it also drives the executor's REAL vault flow once (REAL Balancer flash -> REAL vault
//     `liquidate` -> fail-closed) to record the real-path outcome at the pin,
//   * fail-closed negatives (3/3): minOut=0 -> MIN_OUT_REQUIRED, colPerUnitDebt above the achievable
//     ratio -> ExcessSlippageLiquidation (the vault guard), minProfitWei above achievable ->
//     MIN_PROFIT_NOT_MET.
//
// No real-network write, no key access, no signing (fork txs are sent from an impersonated,
// fork-funded ephemeral EOA only). Endpoint material (URL/host/path) is NEVER printed, persisted, or
// forwarded to children. Artifact-only output: reports/raw/fast/fluid-t2t4-fork-rehearsal/result.json.

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");
const { spawn, spawnSync } = require("node:child_process");
const { Interface, AbiCoder, keccak256 } = require(path.join(__dirname, "node_modules", "ethers"));

const ROOT = path.resolve(__dirname, "..");
const OUTDIR = path.join(ROOT, "reports", "raw", "fast", "fluid-t2t4-fork-rehearsal");
const OUTPUT = path.join(OUTDIR, "result.json");
const INVENTORY = path.join(ROOT, "rpc_endpoints.txt");
const SOURCE_JSON = path.join(ROOT, "reports", "raw", "fast", "fluid-l-economics-stage6.json");
const EXEC_ARTIFACT = path.join(
  ROOT, "contracts", "flash-liquidate-fluid-t2t4", "out", "FltLiquidateT2T4.sol", "FltLiquidateT2T4.json",
);
const MOCK_DIR = path.join(ROOT, "contracts", "flash-liquidate-fluid-t2t4", "out", "FltLiquidateT2T4.t.sol");
const ANVIL = "C:\\Users\\MiPC\\.foundry\\bin\\anvil.exe";

const BALANCER_VAULT = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";
const DEAD_ADDRESS = "0x000000000000000000000000000000000000dEaD";
const LIMIT_MS = 450000; // whole rehearsal under 8 minutes wall (7.5 min guard)
const OWNER = "0x00000000000000000000000000000000DeaDBeef";
const OWNER_FUND_WEI = 10n * 10n ** 18n;
const EXEC_GAS = 12_000_000;
const DEPLOY_GAS = 4_000_000;
const MOCK_DEPLOY_GAS = 3_000_000;
const GAS_PRICE_WEI = 2_000_000_000n;
const MAX_PIN_BACKOFF = 1;

// Measured mock-driven case sizing (mock token units; the mock reproduces the vault's ordering).
const DEBT_AMT = 100n * 10n ** 18n;
const MOCK_COL_PER_DEBT_X18 = 1_050_000_000_000_000_000n; // 1.05 (5% liquidation bonus)
const COL_PER_UNIT_DEBT = 1_000_000_000_000_000_000n; // 1.00 floor
const COL_PER_UNIT_SHARES = 1_000_000_000_000_000_000n;
const MIN_OUT = 100n * 10n ** 18n;
const MIN_PROFIT = 1n * 10n ** 18n;

const fail = (code) => { throw new Error(code); };
const lc = (s) => String(s || "").toLowerCase();
const quantity = (value) => "0x" + BigInt(value).toString(16);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deadline = Date.now() + LIMIT_MS;
let anvil = null;
let relay = null;
let requestId = 0;
let aborted = false;
let stage = "SETUP";
let live = null;

const EXEC_PARAMS_TUPLE =
  "(address,uint8,address,uint256,uint256,uint256,uint256,uint256,bool,address,uint256,bool,uint256,uint256,address,bytes)";

const IFACE = {
  exec: new Interface([
    "function owner() view returns (address)",
    "function BALANCER_VAULT() view returns (address)",
    `function execute(${EXEC_PARAMS_TUPLE})`,
    "event LiquidationExecuted(address vault,uint8 vaultType,address debtToken,uint256 debtLiquidated,uint256 colSharesLiquidated,uint256 exitOut,uint256 swapOut,uint256 netProfitWei)",
  ]),
  vault: new Interface([
    "function simulateLiquidate(uint256,bool)",
    "function TYPE() view returns (uint256)",
    "function VAULT_ID() view returns (uint256)",
    "function LIQUIDITY() view returns (address)",
  ]),
  oracle: new Interface(["function getExchangeRateLiquidate() view returns (uint256)"]),
  erc20: new Interface([
    "function balanceOf(address) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
    "function transfer(address,uint256) returns (bool)",
  ]),
  mockErc20: new Interface([
    "function balanceOf(address) view returns (uint256)",
    "function mint(address,uint256)",
  ]),
  mockVault: new Interface([
    "function liquidate(uint256,uint256,uint256,uint256,address,bool) returns (uint256,uint256,uint256,uint256)",
    "function liquidate(uint256,uint256,uint256,uint256,uint256,uint256,address,bool) returns (uint256,uint256,uint256,uint256)",
    "function setColPerDebtX18(uint256)",
    "function colPerDebtX18() view returns (uint256)",
    "function liquidateInvoked() view returns (bool)",
    "error ExcessSlippageLiquidation()",
  ]),
  vaultErrors: new Interface([
    "error FluidVaultError(uint256)",
    "error FluidLiquidateResult(uint256 colLiquidated,uint256 debtLiquidated)",
  ]),
};

const VAULT_ERROR_NAMES = {
  31001: "Vault__AlreadyEntered", 31007: "Vault__TopTickDoesNotExist", 31009: "Vault__ExcessSlippageLiquidation",
  31022: "Vault__InvalidLiquidationAmt", 31024: "Vault__BranchDebtTooLow", 31025: "Vault__TickDebtTooLow",
  31027: "Vault__UserDebtTooLow", 31029: "Vault__InvalidLiquidation", 31032: "Vault__LiquidationReverts",
  31033: "Vault__InvalidOraclePrice",
};

const CODES = new Set([
  "ANVIL_MISSING", "ANVIL_CLEANUP_FAILED", "ANVIL_ARGUMENTS_INVALID", "ANVIL_START_FAILED",
  "FORK_BLOCK_MISMATCH", "FORK_BACKING_UNSUPPORTED", "FORK_BACKING_METHOD_MISSING", "FORK_BACKING_STATE_MISSING",
  "FORK_BACKING_BLOCK_FAILURE", "FORK_BACKING_CHAIN_ID_FAILURE", "FORK_BACKING_GAS_PRICE_FAILURE",
  "FORK_BACKING_TRANSACTION_FAILURE", "FORK_BACKING_PROOF_FAILURE", "FORK_BACKING_CODE_FAILURE",
  "FORK_BACKING_BALANCE_FAILURE", "FORK_BACKING_RATE_LIMITED",
  "INVENTORY_MISSING", "NO_ARCHIVE_BACKING", "DEADLINE_EXCEEDED",
  "SOURCE_MISSING", "SOURCE_INVALID", "NO_EXECUTABLE_ROW",
  "EXEC_ARTIFACT_MISSING", "EXEC_ARTIFACT_INVALID", "MOCK_ARTIFACT_MISSING", "MOCK_ARTIFACT_INVALID",
  "VAULT_CODE_MISSING", "DEBT_CODE_MISSING", "BALANCER_CODE_MISSING", "ORACLE_CODE_MISSING", "POOL_CODE_MISSING",
  "DEPLOY_FAILED", "EXEC_IMMUTABLE_MISMATCH", "MOCK_DEPLOY_FAILED", "MOCK_ETCH_FAILED", "SEED_FAILED",
  "MEASURED_STATIC_REVERTED", "MEASURED_TX_REVERTED", "NEGATIVE_CONTROL_FAILED", "NO_MEASURED_CASE",
  "RPC_RESPONSE_TOO_LARGE", "UPSTREAM_UNAVAILABLE", "UPSTREAM_RPC_ERROR", "LOCAL_RPC_UNAVAILABLE",
  "LOCAL_RPC_ERROR", "RELAY_INVALID_REQUEST", "RELAY_REQUEST_TOO_LARGE", "RELAY_INVALID_METHOD", "RELAY_UPSTREAM_FAILURE",
]);

function budget(maxMs = 8500) {
  if (aborted || Date.now() >= deadline) fail("DEADLINE_EXCEEDED");
  return Math.max(1, Math.min(maxMs, deadline - Date.now()));
}

// --- inventory (chain-hint aware) --------------------------------------------------------
function parseInventory() {
  if (!fs.existsSync(INVENTORY)) fail("INVENTORY_MISSING");
  const out = [];
  for (const line of fs.readFileSync(INVENTORY, "utf8").split(/\r?\n/)) {
    const match = line.match(/https?:\/\/[^\s'"<>\[\]]+/i);
    if (!match) continue;
    let parsed;
    try { parsed = new URL(match[0].replace(/[)\],;]+$/, "")); } catch (_) { continue; }
    if (parsed.protocol !== "https:") continue;
    let chainId = null;
    if (/^\s*arbitrum\b/i.test(line)) chainId = 42161;
    else if (/^\s*(ethereum|mainnet)\b/i.test(line)) chainId = 1;
    else if (/^\s*base\b/i.test(line)) chainId = 8453;
    if (chainId === null) continue;
    const metadata = line.replace(match[0], " ");
    if (/\b(?:origin|header|auth|bearer|x-api-key)\s*[:=]/i.test(metadata)) continue;
    out.push({ url: parsed.href, chainId });
  }
  return out;
}

const PUBLIC_FALLBACKS = {
  1: ["https://ethereum.publicnode.com", "https://eth.drpc.org", "https://rpc.ankr.com/eth"],
  42161: ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one.publicnode.com", "https://arbitrum.drpc.org"],
  8453: ["https://base.publicnode.com", "https://base.drpc.org"],
};

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

// --- row selection (Stage-6 executable rows) ---------------------------------------------
function loadSource() {
  if (!fs.existsSync(SOURCE_JSON)) fail("SOURCE_MISSING");
  let doc;
  try { doc = JSON.parse(fs.readFileSync(SOURCE_JSON, "utf8")); } catch (_) { fail("SOURCE_INVALID"); }
  const rows = Array.isArray(doc?.rows) ? doc.rows : [];
  const pins = {};
  for (const c of doc?.chains || []) if (c?.pin?.number) pins[c.chainId] = Number(c.pin.number);
  const exec = rows.filter((r) =>
    r?.executable === true && r?.verdict === "REALIZED_NET_POSITIVE_EXECUTABLE" &&
    /^0x[0-9a-fA-F]{40}$/.test(r?.vault || "") && /^0x[0-9a-fA-F]{40}$/.test(r?.debtToken || "") &&
    r?.exitMarket?.dexPool && pins[r.chainId]);
  if (!exec.length) fail("NO_EXECUTABLE_ROW");
  exec.sort((a, b) => (BigInt(b.realizedNetUsdc || "0") > BigInt(a.realizedNetUsdc || "0") ? 1 : -1));
  return { pins, rows: exec };
}

function loadArtifact(file, missing, invalid) {
  if (!fs.existsSync(file)) fail(missing);
  let artifact;
  try { artifact = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { fail(invalid); }
  const creation = artifact?.bytecode?.object;
  if (typeof creation !== "string" || !/^0x[0-9a-f]+$/i.test(creation) || creation.length <= 2) fail(invalid);
  const runtime = artifact?.deployedBytecode?.object;
  if (typeof runtime !== "string" || !/^0x[0-9a-f]+$/i.test(runtime) || runtime.length <= 2) fail(invalid);
  return { creation, runtime, abi: artifact.abi || [] };
}

// --- upstream qualification --------------------------------------------------------------
async function* qualifiedUpstreams(chainId, pin, requiredCode) {
  const chainIdHex = "0x" + BigInt(chainId).toString(16);
  const seen = new Set();
  const pool = [
    ...parseInventory().filter((e) => e.chainId === chainId).map((e) => ({ url: e.url, backingClass: "PUBLIC_KEYLESS_INVENTORY" })),
    ...(PUBLIC_FALLBACKS[chainId] || []).map((url) => ({ url, backingClass: "PUBLIC_KEYLESS_FALLBACK" })),
  ];
  for (const candidate of pool) {
    const { url } = candidate;
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      if (await request(url, "eth_chainId", [], true) !== chainIdHex) continue;
      const block = await request(url, "eth_getBlockByNumber", [quantity(pin), false], true);
      if (!block || Number(BigInt(block.number)) !== pin) continue;
      const code = await request(url, "eth_getCode", [requiredCode, quantity(pin)], true);
      if (typeof code !== "string" || code.length <= 2) continue;
      yield { ...candidate, pin };
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

function stopRelay() {
  if (!relay) return;
  try { relay.closeAllConnections(); relay.close(); } catch (_) {}
  relay = null;
}

async function startRelay(upstream) {
  stopRelay();
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

async function startAnvil(relayUrl, pin, chainIdHex) {
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
  for (let attempt = 0; attempt < 80; attempt += 1) {
    budget();
    if (anvil.exitCode !== null) fail(bootError());
    const local = `http://127.0.0.1:${port}`;
    try {
      if (await request(local, "eth_chainId", []) === chainIdHex && Number(BigInt(await request(local, "eth_blockNumber", []))) === pin) return local;
    } catch (_) { /* boot in progress */ }
    await delay(150);
  }
  fail(bootError());
}

// --- fork-local helpers ------------------------------------------------------------------
async function readCall(local, to, iface, fn, args, from) {
  const data = iface.encodeFunctionData(fn, args);
  const req = { to, data };
  if (from) req.from = from;
  return iface.decodeFunctionResult(fn, await request(local, "eth_call", [req, "latest"]));
}

async function sendTx(local, tx) {
  const hash = await request(local, "eth_sendTransaction", [tx]);
  let receipt = null;
  for (let n = 0; n < 60 && !receipt; n += 1) { receipt = await request(local, "eth_getTransactionReceipt", [hash]); if (!receipt) await delay(120); }
  return { hash, receipt };
}

const ERROR_NAME = (() => {
  const map = {};
  for (const e of [...IFACE.mockVault.fragments, ...IFACE.vaultErrors.fragments]) if (e.type === "error") map[e.selector.toLowerCase()] = e.name;
  return map;
})();

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
    if (data.startsWith("0x60121cca")) {
      const [id] = AbiCoder.defaultAbiCoder().decode(["uint256"], "0x" + data.slice(10));
      const n = Number(id);
      return VAULT_ERROR_NAMES[n] ? `${VAULT_ERROR_NAMES[n]}(${n})` : `FluidVaultError(${n})`;
    }
    if (data.startsWith("0x")) {
      try { const p = IFACE.vaultErrors.parseError(data); if (p && p.name === "FluidLiquidateResult") return `FluidLiquidateResult(col=${p.args[0].toString()},debt=${p.args[1].toString()})`; } catch (_) {}
    }
  } catch (_) { /* fall through to selector */ }
  const sel = data.slice(0, 10).toLowerCase();
  return ERROR_NAME[sel] ? `${ERROR_NAME[sel]}(${sel})` : sel;
}

function balanceSlot(holder, slot) {
  return keccak256(AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [holder, slot]));
}

function encodeExecute(p) {
  return IFACE.exec.encodeFunctionData("execute", [p]);
}

// --- per-row rehearsal -------------------------------------------------------------------
async function runRow(row, pin) {
  const chainId = row.chainId;
  const chainIdHex = "0x" + BigInt(chainId).toString(16);
  const execArtifact = loadArtifact(EXEC_ARTIFACT, "EXEC_ARTIFACT_MISSING", "EXEC_ARTIFACT_INVALID");
  const mockErc20Art = loadArtifact(path.join(MOCK_DIR, "MockERC20.json"), "MOCK_ARTIFACT_MISSING", "MOCK_ARTIFACT_INVALID");
  const mockT2Art = loadArtifact(path.join(MOCK_DIR, "MockVaultT2.json"), "MOCK_ARTIFACT_MISSING", "MOCK_ARTIFACT_INVALID");
  const mockT4Art = loadArtifact(path.join(MOCK_DIR, "MockVaultT4.json"), "MOCK_ARTIFACT_MISSING", "MOCK_ARTIFACT_INVALID");
  const mockBalArt = loadArtifact(path.join(MOCK_DIR, "MockBalancerVault.json"), "MOCK_ARTIFACT_MISSING", "MOCK_ARTIFACT_INVALID");

  const result = {
    rowIndex: null, chainId, vault: row.vault, vaultId: row.vaultId,
    debtToken: row.debtToken, debtTokenSymbol: row.debtTokenSymbol, debtTokenDecimals: row.debtTokenDecimals,
    oracle: row.oracle, dexPool: row.exitMarket.dexPool,
    exitToken0: row.exitMarket.token0, exitToken1: row.exitMarket.token1, quoteInToken0: row.exitMarket.quoteInToken0,
    realizedSize: row.exitDepth ? row.exitDepth.realizedSize : null,
    realizedNetUsdc: row.realizedNetUsdc,
    routeSource: row.routeSource,
    state: "FAIL_CLOSED", reason: null, stage: null,
    pinBlock: pin, mode: null,
    realLegs: [], mockLegs: [],
    realContext: null, realVaultAttempt: null,
    interventions: [], measuredCases: [], failNegatives: [],
    cleanup: "residual", spawnedAt: new Date().toISOString(), completedAt: null,
  };
  live = result;

  // ---- fork-revival runtime ----
  stage = "QUALIFY";
  let local = null, qualified = null;
  for (let backoff = 0; backoff <= MAX_PIN_BACKOFF && !local; backoff += 1) {
    const tryPin = pin - backoff;
    for await (const backing of qualifiedUpstreams(chainId, tryPin, row.vault)) {
      try {
        const relayUrl = await startRelay(backing.url);
        stage = "QUALIFY_FORK";
        local = await startAnvil(relayUrl, tryPin, chainIdHex);
        qualified = backing;
        result.pinBlock = tryPin;
        break;
      } catch (error) {
        if (!stopAnvil()) fail("ANVIL_CLEANUP_FAILED");
        stopRelay();
        if (error?.message === "DEADLINE_EXCEEDED" || error?.message === "ANVIL_CLEANUP_FAILED") throw error;
      }
    }
  }
  if (!local || !qualified) fail("NO_ARCHIVE_BACKING");
  result.backingClass = qualified.backingClass;
  result.sourceEndpointClass = "PUBLIC_KEYLESS";
  if (Number(BigInt(await request(local, "eth_blockNumber", []))) !== result.pinBlock) fail("FORK_BLOCK_MISMATCH");

  // ---- CONTEXT: real code + real oracle ----
  stage = "CONTEXT";
  const code = async (a) => await request(local, "eth_getCode", [a, "latest"]);
  if ((await code(row.vault)) === "0x") fail("VAULT_CODE_MISSING");
  if ((await code(row.debtToken)) === "0x") fail("DEBT_CODE_MISSING");
  if ((await code(BALANCER_VAULT)) === "0x") fail("BALANCER_CODE_MISSING");
  if ((await code(row.oracle)) === "0x") fail("ORACLE_CODE_MISSING");
  if ((await code(row.exitMarket.dexPool)) === "0x") fail("POOL_CODE_MISSING");

  const realRate = BigInt((await readCall(local, row.oracle, IFACE.oracle, "getExchangeRateLiquidate", []))[0]);
  const vaultType = BigInt((await readCall(local, row.vault, IFACE.vault, "TYPE", []))[0]);
  const vaultId = BigInt((await readCall(local, row.vault, IFACE.vault, "VAULT_ID", []))[0]);
  const debtSymbol = await readCall(local, row.debtToken, IFACE.erc20, "symbol", []).then((r) => r[0]).catch(() => row.debtTokenSymbol);
  const poolDebtBal = BigInt((await readCall(local, row.debtToken, IFACE.erc20, "balanceOf", [row.exitMarket.dexPool]))[0]);
  result.realContext = {
    vaultCode: true, debtTokenCode: true, balancerCode: true, oracleCode: true, poolCode: true,
    vaultTypeOnChain: vaultType.toString(), vaultIdOnChain: vaultId.toString(),
    realOracleRateLiquidateRaw: realRate.toString(), debtTokenSymbol: debtSymbol,
    poolDebtTokenBalanceRaw: poolDebtBal.toString(),
  };

  // ---- REAL vault liquidatability probe (canonical in-tree max-liquidatable) ----
  stage = "REAL_PROBE";
  let simOutcome;
  try {
    await request(local, "eth_call", [{ to: row.vault, data: IFACE.vault.encodeFunctionData("simulateLiquidate", [0, false]) }, "latest"]);
    simOutcome = { reverted: false, reason: "simulateLiquidate returned without revert", colLiquidated: null, debtLiquidated: null };
  } catch (error) {
    if (error.reverted !== true) throw error;
    const reason = decodeRevert(error);
    const data = error.revertData || "";
    let col = null, debt = null;
    if (data.startsWith("0x") ) {
      try { const p = IFACE.vaultErrors.parseError(data); if (p && p.name === "FluidLiquidateResult") { col = p.args[0].toString(); debt = p.args[1].toString(); } } catch (_) {}
    }
    simOutcome = { reverted: true, reason, colLiquidated: col, debtLiquidated: debt };
  }
  const realLiquidatable = simOutcome.reverted && simOutcome.debtLiquidated !== null && BigInt(simOutcome.debtLiquidated) > 0n;
  result.realVaultAttempt = { probe: "simulateLiquidate(uint256,bool)", ...simOutcome, liquidatableAtPin: realLiquidatable };

  // ---- fund owner + deploy executor ----
  stage = "FUND_OWNER";
  await request(local, "anvil_setBalance", [OWNER, quantity(OWNER_FUND_WEI)]);
  await request(local, "anvil_impersonateAccount", [OWNER]);
  result.interventions.push({ kind: "anvil_setBalance+anvil_impersonateAccount", target: "ephemeral owner EOA", purpose: "fork-local tx sender", signed: false });

  stage = "DEPLOY_EXECUTOR";
  const { receipt: deployReceipt } = await sendTx(local, { from: OWNER, data: execArtifact.creation, gas: quantity(DEPLOY_GAS), gasPrice: quantity(GAS_PRICE_WEI) });
  if (!deployReceipt || deployReceipt.status !== "0x1" || !deployReceipt.contractAddress) fail("DEPLOY_FAILED");
  const EXEC = deployReceipt.contractAddress;
  result.executor = EXEC;
  result.executorDeployment = { method: "fork-local deploy from local build artifact", contractAddress: EXEC, signed: false };
  const execOwner = (await readCall(local, EXEC, IFACE.exec, "owner", []))[0];
  const execBalancer = (await readCall(local, EXEC, IFACE.exec, "BALANCER_VAULT", []))[0];
  if (lc(execOwner) !== lc(OWNER) || lc(execBalancer) !== lc(BALANCER_VAULT)) fail("EXEC_IMMUTABLE_MISMATCH");

  // ---- REAL executor flow attempt (real Balancer flash -> real vault liquidate -> fail-closed) ----
  stage = "REAL_EXECUTOR_ATTEMPT";
  // size in the REAL debt token's own decimals (e.g. 1000 USDC = 1e9 raw), not the mock 18-dec units
  const realDebtAmt = 1000n * 10n ** BigInt(row.debtTokenDecimals);
  const realParams = [
    row.vault, 0, row.debtToken, realDebtAmt, 0n, 0n, 0n,
    COL_PER_UNIT_DEBT, lc(row.exitMarket.token0) === lc(row.debtToken), row.debtToken,
    COL_PER_UNIT_SHARES, false, realDebtAmt, 0n, DEAD_ADDRESS, "0x",
  ];
  const liquidity = await readCall(local, row.vault, IFACE.vault, "LIQUIDITY", []).then((r) => r[0]).catch(() => null);
  const holderCandidates = [...new Set([BALANCER_VAULT, row.exitMarket.dexPool, liquidity, row.vault].filter(Boolean).map(lc))];
  let holder = null, holderBal = 0n;
  for (const c of holderCandidates) {
    const bal = BigInt((await readCall(local, row.debtToken, IFACE.erc20, "balanceOf", [c]))[0]);
    if (bal > holderBal) { holderBal = bal; holder = c; }
  }
  const needSeed = realDebtAmt + 10n ** BigInt(row.debtTokenDecimals);
  let realExecAttempt;
  let seeded = false;
  if (holder && lc(holder) === lc(BALANCER_VAULT) && holderBal >= needSeed) {
    seeded = true;
  } else if (holder && holderBal >= needSeed) {
    await request(local, "anvil_impersonateAccount", [holder]);
    await request(local, "anvil_setBalance", [holder, quantity(OWNER_FUND_WEI)]);
    const fund = await sendTx(local, {
      from: holder, to: row.debtToken,
      data: IFACE.erc20.encodeFunctionData("transfer", [BALANCER_VAULT, needSeed]),
      gas: quantity(200000), gasPrice: quantity(GAS_PRICE_WEI),
    });
    seeded = fund.receipt?.status === "0x1";
    result.interventions.push({
      kind: "anvil_impersonateAccount(real debt-token holder)+real ERC20 transfer", target: "real Balancer V2 vault",
      purpose: "seed the real Balancer with the real debt token for the real executor flash leg (holds ~0 at the pin)", signed: false,
    });
  }
  if (seeded) {
    try {
      await request(local, "eth_call", [{ from: OWNER, to: EXEC, data: encodeExecute(realParams) }, "latest"]);
      realExecAttempt = { reverted: false, reason: "execute returned without revert" };
    } catch (error) {
      if (error.reverted !== true) throw error;
      realExecAttempt = { reverted: true, reason: decodeRevert(error) };
    }
  } else {
    realExecAttempt = { reverted: null, reason: "no real debt-token holder at the pin to seed the real Balancer flash leg", holderScanned: holderCandidates, maxHolderBalanceRaw: holderBal.toString() };
  }
  result.realExecutorAttempt = realExecAttempt;

  // ---- MOCK-DRIVEN measured route (module's own source-verified mocks) ----
  stage = "MOCK_SETUP";
  const mockErc20Data = mockErc20Art.creation + AbiCoder.defaultAbiCoder().encode(["string"], ["MOCK"]).slice(2);
  const { receipt: loanReceipt } = await sendTx(local, { from: OWNER, data: mockErc20Data, gas: quantity(MOCK_DEPLOY_GAS), gasPrice: quantity(GAS_PRICE_WEI) });
  if (!loanReceipt || loanReceipt.status !== "0x1") fail("MOCK_DEPLOY_FAILED");
  const LOAN = loanReceipt.contractAddress;

  const mkMockVault = async (art) => {
    const data = art.creation + AbiCoder.defaultAbiCoder().encode(["address", "address"], [LOAN, LOAN]).slice(2);
    const { receipt } = await sendTx(local, { from: OWNER, data, gas: quantity(MOCK_DEPLOY_GAS), gasPrice: quantity(GAS_PRICE_WEI) });
    if (!receipt || receipt.status !== "0x1" || !receipt.contractAddress) fail("MOCK_DEPLOY_FAILED");
    return receipt.contractAddress;
  };
  const MOCK_T2 = await mkMockVault(mockT2Art);
  const MOCK_T4 = await mkMockVault(mockT4Art);
  // calibrate the mock to the module's source-verified 5% bonus (the mock's colPerDebtX18 default).
  await sendTx(local, { from: OWNER, to: MOCK_T2, data: IFACE.mockVault.encodeFunctionData("setColPerDebtX18", [MOCK_COL_PER_DEBT_X18]), gas: quantity(200000), gasPrice: quantity(GAS_PRICE_WEI) });
  await sendTx(local, { from: OWNER, to: MOCK_T4, data: IFACE.mockVault.encodeFunctionData("setColPerDebtX18", [MOCK_COL_PER_DEBT_X18]), gas: quantity(200000), gasPrice: quantity(GAS_PRICE_WEI) });

  // etch the mock Balancer at the executor's hardcoded BALANCER_VAULT address (RUNTIME bytecode)
  await request(local, "anvil_setCode", [BALANCER_VAULT, mockBalArt.runtime]);
  if ((await code(BALANCER_VAULT)).length !== mockBalArt.runtime.length) fail("MOCK_ETCH_FAILED");

  result.mockLegs = ["mock-debt-token(MockERC20)", "mock-vault-liquidate(MockVaultT2/T4)", "mock-balancer-etch@0xBA12", "mock-dex-exit(mint)"];
  result.realLegs = ["fork@real-pin", "real-vault-code+TYPE+oracle-rate", "real-vault-simulateLiquidate-probe", "executor-real-bytecode", "real-Balancer-flash(real-executor-attempt)"];
  result.interventions.push({ kind: "fork-local MockERC20+MockVaultT2/T4 deploy", target: "measured liquidation route", purpose: "the REAL vault has no liquidatable position at the pin; the module's own source-verified mock vault reproduces the T2/T4 effect ordering", signed: false });
  result.interventions.push({ kind: "anvil_setCode", target: `BALANCER_VAULT ${BALANCER_VAULT}`, purpose: "etch the module's MockBalancerVault at the executor's hardcoded flash vault address", signed: false });

  // ---- measured T2 case ----
  stage = "MEASURED_T2";
  const t2Params = [MOCK_T2, 0, LOAN, DEBT_AMT, 0n, 0n, 0n, COL_PER_UNIT_DEBT, true, LOAN, COL_PER_UNIT_SHARES, false, MIN_OUT, MIN_PROFIT, DEAD_ADDRESS, "0x"];
  const measured = await driveMeasured(local, EXEC, LOAN, t2Params, "MEASURED_T2");
  result.measuredCases.push(measured);
  result.measuredCases[result.measuredCases.length - 1].netPerUnitDebtWei = ((BigInt(measured.netWei) * 10n ** 18n) / DEBT_AMT).toString();

  // ---- measured T4 case (the T4 lens: exercises the 8-arg overload) ----
  stage = "MEASURED_T4";
  const t4Params = [MOCK_T4, 1, LOAN, DEBT_AMT, DEBT_AMT, 0n, 10n ** 18n, COL_PER_UNIT_DEBT, true, LOAN, COL_PER_UNIT_SHARES, false, MIN_OUT, MIN_PROFIT, DEAD_ADDRESS, "0x"];
  const measuredT4 = await driveMeasured(local, EXEC, LOAN, t4Params, "MEASURED_T4");
  result.measuredCases.push(measuredT4);
  result.measuredCases[result.measuredCases.length - 1].netPerUnitDebtWei = ((BigInt(measuredT4.netWei) * 10n ** 18n) / DEBT_AMT).toString();

  // ---- fail-closed negatives (3/3) ----
  stage = "NEGATIVES";
  const staticCall = async (params) => {
    try {
      await request(local, "eth_call", [{ from: OWNER, to: EXEC, data: encodeExecute(params) }, "latest"]);
      return { reverted: false, reason: null };
    } catch (error) {
      if (error.reverted !== true) throw error;
      return { reverted: true, reason: decodeRevert(error) };
    }
  };
  const negMinOut = await staticCall([MOCK_T2, 0, LOAN, DEBT_AMT, 0n, 0n, 0n, COL_PER_UNIT_DEBT, true, LOAN, COL_PER_UNIT_SHARES, false, 0n, MIN_PROFIT, DEAD_ADDRESS, "0x"]);
  result.failNegatives.push({ kind: "minOut-zero-undercut", expected: "MIN_OUT_REQUIRED", status: negMinOut.reverted && /MIN_OUT_REQUIRED/.test(negMinOut.reason || "") ? "PASS" : "FAIL", reverted: negMinOut.reverted, reason: negMinOut.reason, controlledIntervention: "NONE" });
  const negSlip = await staticCall([MOCK_T2, 0, LOAN, DEBT_AMT, 0n, 0n, 0n, 1_100_000_000_000_000_000n, true, LOAN, COL_PER_UNIT_SHARES, false, MIN_OUT, MIN_PROFIT, DEAD_ADDRESS, "0x"]);
  result.failNegatives.push({ kind: "colPerUnitDebt-above-achievable", expected: "ExcessSlippageLiquidation", status: negSlip.reverted && /ExcessSlippageLiquidation/.test(negSlip.reason || "") ? "PASS" : "FAIL", reverted: negSlip.reverted, reason: negSlip.reason, controlledIntervention: "NONE" });
  const negProfit = await staticCall([MOCK_T2, 0, LOAN, DEBT_AMT, 0n, 0n, 0n, COL_PER_UNIT_DEBT, true, LOAN, COL_PER_UNIT_SHARES, false, MIN_OUT, 10n * 10n ** 18n, DEAD_ADDRESS, "0x"]);
  result.failNegatives.push({ kind: "minProfit-above-achievable", expected: "MIN_PROFIT_NOT_MET", status: negProfit.reverted && /MIN_PROFIT_NOT_MET/.test(negProfit.reason || "") ? "PASS" : "FAIL", reverted: negProfit.reverted, reason: negProfit.reason, controlledIntervention: "NONE" });

  // ---- teardown + verdict ----
  stage = "TEARDOWN";
  const stopped = stopAnvil();
  stopRelay();
  result.cleanup = stopped ? "clean" : "residual";

  const negativesOk = result.failNegatives.length === 3 && result.failNegatives.every((n) => n.status === "PASS");
  if (!negativesOk) fail("NEGATIVE_CONTROL_FAILED");
  if (result.measuredCases.length < 1) fail("NO_MEASURED_CASE");
  if (result.measuredCases.some((c) => BigInt(c.netWei) <= 0n)) fail("MEASURED_TX_REVERTED");

  result.mode = "MOCK_DRIVEN";
  result.modeNote = "The measured liquidation route is driven against the module's OWN source-verified mock vault (real debt/exit token semantics are mocked) because the REAL vault has no liquidatable position at the Stage-6 pin (recorded in realVaultAttempt/realExecutorAttempt). The fork, the REAL vault/pool/oracle/Balancer code presence, the REAL oracle rate, and the executor's REAL bytecode are all real.";
  result.state = "PASS";
  result.reason = "MEASURED_ROUTE_DRIVEN_MOCK";
  result.completedAt = new Date().toISOString();
  return result;
}

async function driveMeasured(local, EXEC, LOAN, params, label) {
  const ownerBefore = BigInt((await readCall(local, LOAN, IFACE.mockErc20, "balanceOf", [OWNER]))[0]);
  const { receipt } = await sendTx(local, { from: OWNER, to: EXEC, data: encodeExecute(params), gas: quantity(EXEC_GAS), gasPrice: quantity(GAS_PRICE_WEI) });
  if (!receipt || receipt.status !== "0x1") {
    fail("MEASURED_TX_REVERTED");
  }
  const ownerAfter = BigInt((await readCall(local, LOAN, IFACE.mockErc20, "balanceOf", [OWNER]))[0]);
  const gasUsed = BigInt(receipt.gasUsed);
  if (process.env.REHEARSAL_DEBUG === "1") {
    const invoked = await readCall(local, params[0], IFACE.mockVault, "liquidateInvoked", []).then((r) => r[0]).catch(() => "?");
    const logs = (receipt.logs || []).map((l) => `${l.address}:${(l.topics || [])[0] || ""}`).join(",");
    process.stderr.write(`[debug] ${label} status=${receipt.status} gas=${receipt.gasUsed} nlogs=${(receipt.logs || []).length} invoked=${invoked} net=${ownerAfter - ownerBefore} balancerCodeLen=${(await request(local, "eth_getCode", [BALANCER_VAULT, "latest"])).length} logs=[${logs}]\n`);
  }
  let event = null;
  for (const log of receipt.logs || []) {
    try {
      if (lc(log.address) === lc(EXEC)) {
        const parsed = IFACE.exec.parseLog(log);
        if (parsed && parsed.name === "LiquidationExecuted") {
          event = {
            debtLiquidated: parsed.args.debtLiquidated.toString(),
            colSharesLiquidated: parsed.args.colSharesLiquidated.toString(),
            exitOut: parsed.args.exitOut.toString(),
            swapOut: parsed.args.swapOut.toString(),
            netProfitWei: parsed.args.netProfitWei.toString(),
          };
        }
      }
    } catch (_) { /* unrelated log */ }
  }
  return {
    case: label,
    route: "balancer-flash(mock)->vault.liquidate(mock T2/T4)->native-debt-exit(mock)->balancer-repay->owner-sweep",
    vaultType: label === "MEASURED_T4" ? 1 : 0,
    debtAmt: DEBT_AMT.toString(),
    colPerUnitDebt: COL_PER_UNIT_DEBT.toString(),
    minOut: MIN_OUT.toString(),
    minProfitWei: MIN_PROFIT.toString(),
    ownerBeforeWei: ownerBefore.toString(),
    ownerAfterWei: ownerAfter.toString(),
    netWei: (ownerAfter - ownerBefore).toString(),
    gasUsed: gasUsed.toString(),
    receiptStatus: receipt.status,
    event,
    controlledIntervention: "MOCK_DRIVEN(vault+token+balancer)",
  };
}

// ---------------------------------------------------------------------------
// main run
// ---------------------------------------------------------------------------
async function run() {
  if (!fs.existsSync(ANVIL)) fail("ANVIL_MISSING");
  loadArtifact(EXEC_ARTIFACT, "EXEC_ARTIFACT_MISSING", "EXEC_ARTIFACT_INVALID");
  const source = loadSource();
  const rows = source.rows;
  // highest-net first, then the boundary (smallest-net) row; remaining rows fill the budget.
  const ordered = [rows[0], rows[rows.length - 1], ...rows.slice(1, rows.length - 1)].filter((r, i, a) => r && a.indexOf(r) === i);
  const maxRows = Number(process.env.REHEARSAL_MAX_ROWS || 0);
  const selected = maxRows > 0 ? ordered.slice(0, maxRows) : ordered;

  const out = {
    schema: "fluid-t2t4-fork-rehearsal/v1",
    generatedAt: new Date().toISOString(),
    scanner: "tools/fluid-t2t4-flash-rehearsal.js",
    sourceArtifact: "reports/raw/fast/fluid-l-economics-stage6.json",
    executorArtifact: "contracts/flash-liquidate-fluid-t2t4/out/FltLiquidateT2T4.sol/FltLiquidateT2T4.json",
    balancerVault: BALANCER_VAULT,
    relayOnly: true,
    endpointProcessOnly: true,
    readonly: false,
    signedActionJustified: false,
    forkLocalOnly: true,
    upstreamBroadcast: false,
    keysRead: false,
    methodNote:
      "Per-row: fork chain state at the Stage-6 pin through a loopback relay (anvil only talks to 127.0.0.1); assert REAL vault/debt/Balancer/oracle/DEX-pool code; read the REAL oracle rate; probe the REAL vault simulateLiquidate; deploy the local executor build; attempt the REAL executor flow (REAL Balancer flash -> REAL vault liquidate) and DRIVE the measured route against the module's OWN source-verified mock vault. `mode` is MOCK_DRIVEN when the measured liquidation route is mock-driven (realLegs/mockLegs/realVaultAttempt/realExecutorAttempt record exactly what is real).",
    rows: [],
    spawnedAt: new Date().toISOString(),
  };
  live = out;

  for (const row of selected) {
    budget();
    const pin = source.pins[row.chainId];
    let rowResult;
    try {
      rowResult = await runRow(row, pin);
    } catch (error) {
      const reason = CODES.has(error?.message) ? error.message : `${stage}_INTERNAL_OR_RELAY_FAILURE`;
      const stopped = stopAnvil();
      stopRelay();
      if (process.env.REHEARSAL_DEBUG === "1") process.stderr.write(`[debug] row=${row.vault} stage=${stage} reason=${reason} ${error && error.stack ? error.stack.split("\n").slice(0, 3).join(" | ") : String(error)}\n`);
      rowResult = live && live.chainId === row.chainId
        ? { ...live, state: "FAIL_CLOSED", reason, stage, cleanup: stopped ? "clean" : "residual", completedAt: new Date().toISOString() }
        : {
            chainId: row.chainId, vault: row.vault, vaultId: row.vaultId,
            debtToken: row.debtToken, debtTokenSymbol: row.debtTokenSymbol, oracle: row.oracle,
            dexPool: row.exitMarket ? row.exitMarket.dexPool : null,
            realizedNetUsdc: row.realizedNetUsdc,
            state: "FAIL_CLOSED", reason, stage, pinBlock: pin, mode: null,
            realLegs: [], mockLegs: [], realContext: null, realVaultAttempt: null, realExecutorAttempt: null,
            interventions: [], measuredCases: [], failNegatives: [],
            cleanup: stopped ? "clean" : "residual", spawnedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
          };
    }
    out.rows.push(rowResult);
  }

  out.summary = {
    rows: out.rows.length,
    pass: out.rows.filter((r) => r.state === "PASS").length,
    failClosed: out.rows.filter((r) => r.state !== "PASS").length,
    modes: [...new Set(out.rows.map((r) => r.mode).filter(Boolean))],
    cleanup: out.rows.every((r) => r.cleanup === "clean") ? "clean" : "residual",
    wallMs: Date.now() - Date.parse(out.spawnedAt),
  };
  out.completedAt = new Date().toISOString();
  return out;
}

function writeResult(result) {
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(result, null, 2) + "\n", "utf8");
}

process.once("exit", () => { stopAnvil(); });
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
      state: result.summary.failClosed === 0 ? "PASS" : "PARTIAL",
      rows: result.rows.map((r) => ({ vault: r.vault, chainId: r.chainId, state: r.state, mode: r.mode, reason: r.reason,
        pinBlock: r.pinBlock, netWei: r.measuredCases[0] ? r.measuredCases[0].netWei : null,
        negatives: r.failNegatives.map((n) => n.status), cleanup: r.cleanup })),
      summary: result.summary,
    }) + "\n");
  } catch (error) {
    const reason = CODES.has(error?.message) ? error.message : `${stage}_INTERNAL_OR_RELAY_FAILURE`;
    stopAnvil();
    stopRelay();
    writeResult({
      schema: "fluid-t2t4-fork-rehearsal/v1", state: "FAIL_CLOSED", reason, stage,
      relayOnly: true, endpointProcessOnly: true, rows: live ? live.rows : [],
      readonly: false, signedActionJustified: false, forkLocalOnly: true,
      spawnedAt: live ? live.spawnedAt : new Date().toISOString(), completedAt: new Date().toISOString(),
    });
    process.stdout.write(JSON.stringify({ state: "FAIL_CLOSED", reason, stage }) + "\n");
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    stopAnvil();
    stopRelay();
  }
})();
