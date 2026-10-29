#!/usr/bin/env node
"use strict";

// fluid-t2t4-fork-rehearsal-real.js
// Keyless, local-only REAL fork rehearsal for the Fluid T2/T4 flash liquidator
// `FltLiquidateT2T4` (contracts/flash-liquidate-fluid-t2t4/) against the single
// currently-eligible Ethereum route-positive Stage-6 row
// (default candidate vault 0x989a44cb4dbb7ebe20e0abf3c1e1d727bf90f881).
//
// THIS IS DIAGNOSTIC REHEARSAL EVIDENCE, NOT AUTHORIZATION. Every artifact carries
// label = "REHEARSAL_EVIDENCE_NOT_AUTHORIZATION"; signedActionJustified is false and
// no key is read, no transaction is broadcast upstream, no endpoint URL is printed or
// persisted.
//
// Runtime shape (reuses the patterns of tools/fluid-t2t4-flash-rehearsal.js and
// tools/execute-fluid-t2t4-trigger.js LIQ_SIM_IFACE):
//   1. spawn anvil forked at a pinned recent finalized mainnet block (pin recorded);
//      anvil only ever talks to a 127.0.0.1 loopback relay that owns the upstream;
//      confirm chainId 1 locally.
//   2. deploy the local `FltLiquidateT2T4` build artifact on the fork from the main
//      wallet (impersonated, fork-local only) and record the deployed codehash.
//   3. impersonate the main wallet ONLY for fork-local gas/funding; the wallet address
//      stays constant 0x24e46e91dfaad1fa3d49c48aa85ca9306885ce0a.
//   4. read LIVE vault state at the pin: vault TYPE/VAULT_ID/LIQUIDITY, the VaultResolver
//      vault state (totalBorrow / liquidityUserBorrowData.borrow), the oracle
//      getExchangeRateLiquidate, the vault's own DEX-pool depth (live ERC20 balances),
//      and the candidate's `simulateLiquidate` revert decode (FluidLiquidateResult(col,debt)
//      / FluidVaultError(id)) with the SAME decoder as execute-fluid-t2t4-trigger.js.
//   5. execute the FULL liquidation path locally against the real executor bytecode:
//      flash fund the real Balancer V2 vault (locally seeded, labelled) -> vault.liquidate
//      -> DEX one-token exit -> Balancer repay -> owner sweep; measure REAL deltas
//      (executor debt-token balance change, owner repayment/profit) and gas at fork basefee.
//   6. write reports/raw/fast/fluid-t2t4-fork-rehearsal-real/result.json schema
//      "rehearsal-evidence/v1" with provenance markers and a fail-closed verdict:
//      PASS ONLY if realizedNet > 0 on the real executor bytecode at real pin state;
//      otherwise FAIL with a bounded reason. Negative / insufficient-liquidity outcomes
//      are valid FAIL evidence. Missing/unreadable live reads never fabricate values.
//
// No signing keys, no broadcast, no contract changes; fork / spawned process local only.

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { Interface, AbiCoder, keccak256 } = require(path.join(__dirname, "node_modules", "ethers"));
const shared = require("./shared-rpc");

const ROOT = path.resolve(__dirname, "..");
const OUTDIR = path.join(ROOT, "reports", "raw", "fast", "fluid-t2t4-fork-rehearsal-real");
const OUTPUT = path.join(OUTDIR, "result.json");
const SOURCE_JSON = path.join(ROOT, "reports", "raw", "fast", "fluid-l-economics-stage6.json");
const EXEC_ARTIFACT = path.join(
  ROOT, "contracts", "flash-liquidate-fluid-t2t4", "out", "FltLiquidateT2T4.sol", "FltLiquidateT2T4.json",
);
const RESOLVER_JSON = path.join(ROOT, "targets", "fluid-contracts-public", "deployments", "mainnet", "VaultResolver.json");
const ANVIL = "C:\\Users\\MiPC\\.foundry\\bin\\anvil.exe";
const FORGE = "C:\\Users\\MiPC\\.foundry\\bin\\forge.exe";

const CANDIDATE_VAULT = "0x989a44cb4dbb7ebe20e0abf3c1e1d727bf90f881";
const MAIN = "0x24e46e91dfaad1fa3d49c48aa85ca9306885ce0a"; // main wallet: owner + fork-local caller
const BALANCER_VAULT = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";
const LABEL = "REHEARSAL_EVIDENCE_NOT_AUTHORIZATION";

const LIMIT_MS = 480000; // whole rehearsal under 8 minutes wall
const MAIN_FUND_WEI = 100n * 10n ** 18n;
const DEPLOY_GAS = 4_000_000;
const EXEC_GAS = 14_000_000;
const SEED_GAS = 200_000;
const MAX_PIN_BACKOFF = 3;

const fail = (code) => { throw new Error(code); };
const lc = (s) => String(s || "").toLowerCase();
const quantity = (value) => "0x" + BigInt(value).toString(16);
const word = (value) => "0x" + BigInt(value).toString(16).padStart(64, "0");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let anvil = null;
let relay = null;
let requestId = 0;
let aborted = false;
let stage = "SETUP";
let deadline = Date.now() + LIMIT_MS;

const EXEC_PARAMS_TUPLE =
  "(address,uint8,address,uint256,uint256,uint256,uint256,uint256,bool,address,uint256,bool,uint256,uint256,address,bytes)";

const EXEC_IFACE = new Interface([
  "function owner() view returns (address)",
  "function BALANCER_VAULT() view returns (address)",
  `function execute(${EXEC_PARAMS_TUPLE})`,
  "event LiquidationExecuted(address vault,uint8 vaultType,address debtToken,uint256 debtLiquidated,uint256 colSharesLiquidated,uint256 exitOut,uint256 swapOut,uint256 netProfitWei)",
]);

const VAULT_IFACE = new Interface([
  "function simulateLiquidate(uint256 maxAmount_, bool absorb_)",
  "function TYPE() view returns (uint256)",
  "function VAULT_ID() view returns (uint256)",
  "function LIQUIDITY() view returns (address)",
]);

// Same error surface + decoder as tools/execute-fluid-t2t4-trigger.js LIQ_SIM_IFACE.
const LIQ_SIM_IFACE = new Interface([
  "function simulateLiquidate(uint256 maxAmount_, bool absorb_)",
  "error FluidLiquidateResult(uint256 colLiquidated, uint256 debtLiquidated)",
  "error FluidVaultError(uint256 id)",
]);

const ORACLE_IFACE = new Interface(["function getExchangeRateLiquidate() view returns (uint256)"]);

const ERC20_IFACE = new Interface([
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
]);

const VAULT_ERROR_NAMES = {
  31001: "Vault__AlreadyEntered", 31007: "Vault__TopTickDoesNotExist", 31009: "Vault__ExcessSlippageLiquidation",
  31022: "Vault__InvalidLiquidationAmt", 31024: "Vault__BranchDebtTooLow", 31025: "Vault__TickDebtTooLow",
  31027: "Vault__UserDebtTooLow", 31029: "Vault__InvalidLiquidation", 31032: "Vault__LiquidationReverts",
  31033: "Vault__InvalidOraclePrice",
};

const CODES = new Set([
  "ANVIL_MISSING", "ANVIL_CLEANUP_FAILED", "ANVIL_START_FAILED", "ANVIL_ARGUMENTS_INVALID",
  "FORK_BLOCK_MISMATCH", "FORK_BACKING_UNSUPPORTED", "FORK_BACKING_STATE_MISSING", "FORK_BACKING_BLOCK_FAILURE",
  "FORK_BACKING_CHAIN_ID_FAILURE", "FORK_BACKING_CODE_FAILURE", "FORK_BACKING_RATE_LIMITED",
  "INVENTORY_MISSING", "NO_ARCHIVE_BACKING", "NO_UPSTREAM",
  "SOURCE_MISSING", "SOURCE_INVALID", "NO_CANDIDATE_ROW",
  "EXEC_ARTIFACT_MISSING", "EXEC_ARTIFACT_INVALID",
  "VAULT_CODE_MISSING", "DEBT_CODE_MISSING", "BALANCER_CODE_MISSING", "ORACLE_CODE_MISSING", "POOL_CODE_MISSING",
  "DEPLOY_FAILED", "EXEC_IMMUTABLE_MISMATCH", "CODEHASH_UNREADABLE",
  "FUNDING_FAILED", "SEED_FAILED",
  "EXECUTE_STATIC_REVERTED", "EXECUTE_TX_REVERTED", "REALIZED_NET_NONPOSITIVE", "NO_LIQUIDATABLE_DEBT_AT_PIN",
  "RPC_RESPONSE_TOO_LARGE", "UPSTREAM_UNAVAILABLE", "UPSTREAM_RPC_ERROR", "LOCAL_RPC_UNAVAILABLE",
  "LOCAL_RPC_ERROR", "RELAY_INVALID_REQUEST", "RELAY_REQUEST_TOO_LARGE", "RELAY_INVALID_METHOD", "RELAY_UPSTREAM_FAILURE",
  "DEADLINE_EXCEEDED", "INTERNAL_FAILURE",
]);

function budget(maxMs = 8500) {
  if (aborted || Date.now() >= deadline) fail("DEADLINE_EXCEEDED");
  return Math.max(1, Math.min(maxMs, deadline - Date.now()));
}

// --- RPC ---------------------------------------------------------------------------------
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

// --- decoder (mirrors execute-fluid-t2t4-trigger.js) -------------------------------------
function decodeLiqSimRevert(data) {
  const out = { name: null, text: null, colLiquidated: null, debtLiquidated: null, errorId: null, errorName: null };
  if (typeof data !== "string" || !/^0x/i.test(data)) return out;
  try {
    if (data.startsWith("0x08c379a0")) {
      const [msg] = AbiCoder.defaultAbiCoder().decode(["string"], "0x" + data.slice(10));
      return { ...out, name: "Error", text: String(msg) };
    }
    if (data.startsWith("0x4e487b71")) {
      const [code] = AbiCoder.defaultAbiCoder().decode(["uint256"], "0x" + data.slice(10));
      return { ...out, name: "Panic", text: "Panic(0x" + code.toString(16) + ")" };
    }
    const parsed = LIQ_SIM_IFACE.parseError(data);
    if (parsed && parsed.name === "FluidLiquidateResult") {
      return {
        ...out, name: parsed.name,
        text: `FluidLiquidateResult(col=${parsed.args[0].toString()},debt=${parsed.args[1].toString()})`,
        colLiquidated: parsed.args[0].toString(), debtLiquidated: parsed.args[1].toString(),
      };
    }
    if (parsed && parsed.name === "FluidVaultError") {
      const id = Number(parsed.args[0]);
      return {
        ...out, name: parsed.name, errorId: parsed.args[0].toString(),
        errorName: VAULT_ERROR_NAMES[id] || `FluidVaultError(${id})`,
        text: VAULT_ERROR_NAMES[id] ? `${VAULT_ERROR_NAMES[id]}(${id})` : `FluidVaultError(${id})`,
      };
    }
    if (parsed) return { ...out, name: parsed.name, text: parsed.name };
  } catch (_) { /* fall through to selector */ }
  return { ...out, text: data.slice(0, 10).toLowerCase() };
}

// --- source / artifact loaders ------------------------------------------------------------
function loadSource() {
  if (!fs.existsSync(SOURCE_JSON)) fail("SOURCE_MISSING");
  let doc;
  try { doc = JSON.parse(fs.readFileSync(SOURCE_JSON, "utf8")); } catch (_) { fail("SOURCE_INVALID"); }
  const rows = Array.isArray(doc?.rows) ? doc.rows : [];
  const pin = (doc?.chains || []).find((c) => Number(c?.chainId) === 1)?.pin || null;
  const target = lc(process.env.REHEARSAL_VAULT || CANDIDATE_VAULT);
  const row = rows.find((r) => lc(r?.vault) === target);
  if (!row) fail("NO_CANDIDATE_ROW");
  return { doc, row, pin };
}

function loadArtifact(file, missing, invalid) {
  if (!fs.existsSync(file)) fail(missing);
  let artifact;
  try { artifact = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { fail(invalid); }
  const creation = artifact?.bytecode?.object;
  const runtime = artifact?.deployedBytecode?.object;
  if (typeof creation !== "string" || !/^0x[0-9a-f]+$/i.test(creation) || creation.length <= 2) fail(invalid);
  if (typeof runtime !== "string" || !/^0x[0-9a-f]+$/i.test(runtime) || runtime.length <= 2) fail(invalid);
  return { creation, runtime, abi: artifact.abi || [] };
}

function loadResolver() {
  if (!fs.existsSync(RESOLVER_JSON)) return null;
  try {
    const doc = JSON.parse(fs.readFileSync(RESOLVER_JSON, "utf8"));
    if (!doc?.address || !Array.isArray(doc?.abi)) return null;
    return { address: doc.address, iface: new Interface(doc.abi) };
  } catch (_) { return null; }
}

// --- upstream qualification (endpoints process-only via shared-rpc) -----------------------
function upstreamPool() {
  const seen = new Set();
  const pool = [];
  let urls = [];
  try { urls = shared.loadRpcUrls({ maxCandidates: 40 }); } catch (_) { urls = []; }
  for (const url of urls) {
    if (typeof url !== "string" || seen.has(url)) continue;
    seen.add(url);
    pool.push({ url, backingClass: "SHARED_RPC_INVENTORY" });
  }
  const fallback = shared.PUBLIC_FALLBACKS && shared.PUBLIC_FALLBACKS[1];
  if (typeof fallback === "string" && !seen.has(fallback)) pool.push({ url: fallback, backingClass: "PUBLIC_KEYLESS_FALLBACK" });
  return pool;
}

function pinCandidates(sourcePin) {
  const list = [];
  if (sourcePin && Number.isFinite(Number(sourcePin.number))) {
    const n = Number(sourcePin.number);
    for (let b = 0; b <= MAX_PIN_BACKOFF; b += 1) list.push({ block: n - b, source: b === 0 ? "stage6-chain1-pin" : "stage6-chain1-pin-backoff" });
  }
  return list;
}

async function qualifyUpstream(vault, sourcePin) {
  const chainIdHex = "0x1";
  const candidates = pinCandidates(sourcePin);
  for (const entry of upstreamPool()) {
    let chainId;
    try { chainId = await request(entry.url, "eth_chainId", [], true); } catch (_) { continue; }
    if (chainId !== chainIdHex) continue;
    let finalized = null;
    try { finalized = await request(entry.url, "eth_getBlockByNumber", ["finalized", false], true); } catch (_) { finalized = null; }
    const finalizedNum = finalized && finalized.number ? Number(BigInt(finalized.number)) : null;
    const probe = [...candidates];
    if (finalizedNum !== null) probe.push({ block: finalizedNum, source: "latest-finalized-fallback" });
    for (const cand of probe) {
      if (!Number.isFinite(cand.block) || cand.block <= 0) continue;
      if (finalizedNum !== null && cand.block > finalizedNum) continue;
      try {
        const block = await request(entry.url, "eth_getBlockByNumber", [quantity(cand.block), false], true);
        if (!block || !block.hash || Number(BigInt(block.number)) !== cand.block) continue;
        const code = await request(entry.url, "eth_getCode", [vault, quantity(cand.block)], true);
        if (typeof code !== "string" || code.length <= 2) continue;
        return { url: entry.url, backingClass: entry.backingClass, pin: cand.block, pinHash: block.hash, pinTimestamp: block.timestamp ? Number(BigInt(block.timestamp)) : null, pinSource: cand.source };
      } catch (_) { /* candidate failed qualification */ }
    }
  }
  fail("NO_ARCHIVE_BACKING");
}

// --- anvil lifecycle ----------------------------------------------------------------------
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

async function startAnvil(relayUrl, pin) {
  if (!stopAnvil()) fail("ANVIL_CLEANUP_FAILED");
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  anvil = spawn(ANVIL, ["--host", "127.0.0.1", "--port", String(port), "--fork-url", relayUrl,
    "--fork-block-number", String(pin), "--no-rate-limit", "--silent"],
  { stdio: ["ignore", "ignore", "pipe"], windowsHide: true, shell: false });
  let bootDiagnostic = "";
  anvil.stderr.on("data", (chunk) => { bootDiagnostic = (bootDiagnostic + chunk.toString("utf8")).slice(-16384); });
  const bootError = () => {
    if (/429|too many requests|rate.limit/i.test(bootDiagnostic)) return "FORK_BACKING_RATE_LIMITED";
    if (/missing trie node|historical state/i.test(bootDiagnostic)) return "FORK_BACKING_STATE_MISSING";
    if (/failed to get.*(?:chain.?id|chain id)/i.test(bootDiagnostic)) return "FORK_BACKING_CHAIN_ID_FAILURE";
    if (/failed to get.*code/i.test(bootDiagnostic)) return "FORK_BACKING_CODE_FAILURE";
    if (/failed to get block/i.test(bootDiagnostic)) return "FORK_BACKING_BLOCK_FAILURE";
    if (/unexpected argument|unrecognized option|invalid value/i.test(bootDiagnostic)) return "ANVIL_ARGUMENTS_INVALID";
    if (/failed to get|failed to fetch|cannot fork|unsupported/i.test(bootDiagnostic)) return "FORK_BACKING_UNSUPPORTED";
    return "ANVIL_START_FAILED";
  };
  anvil.on("error", () => { /* observed by readiness loop */ });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    budget();
    if (anvil.exitCode !== null) fail(bootError());
    const local = `http://127.0.0.1:${port}`;
    try {
      if (await request(local, "eth_chainId", []) === "0x1" && Number(BigInt(await request(local, "eth_blockNumber", []))) === pin) return local;
    } catch (_) { /* boot in progress */ }
    await delay(150);
  }
  fail(bootError());
}

// --- fork-local helpers -------------------------------------------------------------------
async function readCall(local, to, iface, fn, args = [], from) {
  const req = { to, data: iface.encodeFunctionData(fn, args) };
  if (from) req.from = from;
  return iface.decodeFunctionResult(fn, await request(local, "eth_call", [req, "latest"]));
}

async function sendTx(local, tx) {
  const hash = await request(local, "eth_sendTransaction", [tx]);
  let receipt = null;
  for (let n = 0; n < 80 && !receipt; n += 1) { receipt = await request(local, "eth_getTransactionReceipt", [hash]); if (!receipt) await delay(120); }
  return { hash, receipt };
}

async function readUint(local, token, fn, args = []) {
  const r = await readCall(local, token, ERC20_IFACE, fn, args).catch(() => null);
  return r ? BigInt(r[0]) : null;
}

// Seed an arbitrary ERC20 balance for `holder` via anvil_setStorageAt, scanning the
// balance-mapping slot 0..59 (same technique as tools/fluid-t2negmax-differential-r1.js).
async function fundToken(local, token, holder, amount) {
  for (let slot = 0; slot < 60; slot += 1) {
    const key = keccak256(AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [holder, slot]));
    await request(local, "anvil_setStorageAt", [token, key, word(amount)]);
    const bal = await readUint(local, token, "balanceOf", [holder]);
    if (bal !== null && bal >= amount) return { ok: true, slot };
  }
  return { ok: false, slot: null };
}

function encodeExecute(p) { return EXEC_IFACE.encodeFunctionData("execute", [p]); }

// --- evidence helpers (exported for the offline suite) ------------------------------------
function newAttemptId(now) {
  const stamp = (now ? now() : new Date()).toISOString().replace(/[:.]/g, "").replace("Z", "Z");
  return `fluid-t2t4-real-${stamp}-${crypto.randomBytes(4).toString("hex")}`;
}

function defaultCandidate(row) {
  const r = row || {};
  const exit = r.exitMarket || {};
  return {
    vault: r.vault || CANDIDATE_VAULT,
    chainId: Number(r.chainId) || 1,
    vaultId: r.vaultId != null ? String(r.vaultId) : null,
    debtToken: r.debtToken || null,
    debtTokenSymbol: r.debtTokenSymbol || null,
    debtTokenDecimals: r.debtTokenDecimals != null ? Number(r.debtTokenDecimals) : null,
    oracle: r.oracle || null,
    dexPool: exit.dexPool || null,
    exitToken0: exit.token0 || null,
    exitToken1: exit.token1 || null,
    stage6TypeField: r.type != null ? String(r.type) : null,
    stage6Verdict: r.verdict || null,
  };
}

function baseProvenance(extra) {
  return {
    REALFORK: true,
    forkLocalOnly: true,
    upstreamBroadcast: false,
    keysRead: false,
    signedActionJustified: false,
    endpointProcessOnly: true,
    relayOnly: true,
    ...(extra || {}),
  };
}

function buildFailEvidence(opts) {
  const o = opts || {};
  const generatedAt = o.generatedAt || new Date().toISOString();
  return {
    schema: "rehearsal-evidence/v1",
    generatedAt,
    attemptId: o.attemptId || newAttemptId(),
    scanner: "tools/fluid-t2t4-fork-rehearsal-real.js",
    label: LABEL,
    candidate: o.candidate || defaultCandidate(null),
    pin: o.pin || null,
    executor: o.executor || null,
    liveState: o.liveState || null,
    funding: o.funding || null,
    execution: o.execution || null,
    realizedNet: o.realizedNet || null,
    provenance: baseProvenance(o.provenance),
    verdict: { state: "FAIL", reason: o.reason || "INTERNAL_FAILURE", stage: o.stage || null, passBasis: null },
    cleanup: o.cleanup || "clean",
    interventions: o.interventions || [],
    spawnedAt: o.spawnedAt || generatedAt,
    completedAt: generatedAt,
  };
}

// Guard against accidental secrets/endpoint material in the artifact. 32-byte hashes
// (pin hash, codehash, artifact runtime hash, tx hash) are the only allowed 64-hex values.
const ALLOWED_HASH_PATHS = new Set([
  "pin.hash", "executor.codehash", "executor.artifactRuntimeKeccak", "execution.txHash",
]);

function scanEvidenceForSecrets(root) {
  const findings = [];
  const walk = (node, pathStr) => {
    if (node === null || node === undefined) return;
    if (typeof node === "string") {
      if (/https?:\/\//i.test(node)) findings.push({ path: pathStr, kind: "url" });
      if (/(?:private[_-]?key|secret|mnemonic|seed[_-]?phrase)/i.test(pathStr) && node.length > 0) findings.push({ path: pathStr, kind: "secret-field" });
      if (/^0x[0-9a-f]{64}$/i.test(node) && !ALLOWED_HASH_PATHS.has(pathStr)) findings.push({ path: pathStr, kind: "64hex" });
      return;
    }
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${pathStr}[${i}]`)); return; }
    if (typeof node === "object") { for (const k of Object.keys(node)) walk(node[k], pathStr ? `${pathStr}.${k}` : k); }
  };
  walk(root, "");
  return findings;
}

function validateEvidenceShape(obj) {
  const errors = [];
  if (!obj || typeof obj !== "object") return { ok: false, errors: ["not-an-object"] };
  if (obj.schema !== "rehearsal-evidence/v1") errors.push("schema");
  if (typeof obj.generatedAt !== "string" || !Number.isFinite(Date.parse(obj.generatedAt))) errors.push("generatedAt");
  if (typeof obj.attemptId !== "string" || obj.attemptId.length === 0) errors.push("attemptId");
  if (obj.label !== LABEL) errors.push("label");
  const p = obj.provenance || {};
  if (p.REALFORK !== true) errors.push("provenance.REALFORK");
  if (p.forkLocalOnly !== true) errors.push("provenance.forkLocalOnly");
  if (p.upstreamBroadcast !== false) errors.push("provenance.upstreamBroadcast");
  if (p.keysRead !== false) errors.push("provenance.keysRead");
  if (p.signedActionJustified !== false) errors.push("provenance.signedActionJustified");
  const v = obj.verdict || {};
  if (v.state !== "PASS" && v.state !== "FAIL") errors.push("verdict.state");
  if (typeof v.reason !== "string" || v.reason.length === 0) errors.push("verdict.reason");
  if (v.state === "PASS") {
    if (!obj.pin || !Number.isFinite(Number(obj.pin.block))) errors.push("pin.block");
    if (!obj.executor || !/^0x[0-9a-f]{64}$/i.test(String(obj.executor.codehash || ""))) errors.push("executor.codehash");
    if (!obj.realizedNet || obj.realizedNet.rawDebtToken === undefined) errors.push("realizedNet.rawDebtToken");
    if (!obj.execution || obj.execution.receiptStatus !== "0x1") errors.push("execution.receiptStatus");
  }
  return { ok: errors.length === 0, errors };
}

function writeEvidence(output, evidence) {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n", "utf8");
}

// --- main rehearsal -----------------------------------------------------------------------
async function runRehearsal(opts = {}) {
  const anvilPath = opts.anvilPath || ANVIL;
  const output = opts.output || OUTPUT;
  const now = opts.now || (() => new Date());
  const generatedAt = now().toISOString();
  const attemptId = opts.attemptId || newAttemptId(now);

  if (!fs.existsSync(anvilPath)) {
    const evidence = buildFailEvidence({ reason: "ANVIL_MISSING", stage: "SETUP", attemptId, generatedAt, candidate: opts.candidate });
    writeEvidence(output, evidence);
    return evidence;
  }
  if (opts.requireForge && !fs.existsSync(opts.forgePath || FORGE)) {
    const evidence = buildFailEvidence({ reason: "ANVIL_MISSING", stage: "SETUP", attemptId, generatedAt, candidate: opts.candidate });
    writeEvidence(output, evidence);
    return evidence;
  }

  deadline = Date.now() + LIMIT_MS;
  aborted = false;

  let evidence = buildFailEvidence({ attemptId, generatedAt, candidate: opts.candidate });
  const record = (patch) => { evidence = { ...evidence, ...patch }; };
  let clean = true;

  try {
    loadArtifact(EXEC_ARTIFACT, "EXEC_ARTIFACT_MISSING", "EXEC_ARTIFACT_INVALID");
    const source = loadSource();
    const row = source.row;
    const candidate = defaultCandidate(row);
    record({ candidate, spawnedAt: generatedAt });

    // ---- QUALIFY + FORK ----
    stage = "QUALIFY";
    const backing = await qualifyUpstream(row.vault, source.pin);
    record({ pin: { block: backing.pin, hash: backing.pinHash, timestamp: backing.pinTimestamp, source: backing.pinSource, chainIdLocal: 1 } });

    stage = "FORK";
    const relayUrl = await startRelay(backing.url);
    const local = await startAnvil(relayUrl, backing.pin);
    if (await request(local, "eth_chainId", []) !== "0x1") fail("FORK_BACKING_CHAIN_ID_FAILURE");
    if (Number(BigInt(await request(local, "eth_blockNumber", []))) !== backing.pin) fail("FORK_BLOCK_MISMATCH");
    const forkHead = await request(local, "eth_getBlockByNumber", ["latest", false]);
    const baseFeeWei = forkHead && forkHead.baseFeePerGas ? BigInt(forkHead.baseFeePerGas) : 0n;
    record({ pin: { ...evidence.pin, baseFeePerGasRaw: baseFeeWei.toString() } });

    // ---- CONTEXT: real code + live reads ----
    stage = "CONTEXT";
    const code = async (a) => await request(local, "eth_getCode", [a, "latest"]);
    const codePresent = {
      vault: (await code(row.vault)) !== "0x",
      debtToken: (await code(row.debtToken)) !== "0x",
      oracle: (await code(row.oracle)) !== "0x",
      pool: (await code(row.exitMarket.dexPool)) !== "0x",
      balancer: (await code(BALANCER_VAULT)) !== "0x",
    };
    if (!codePresent.vault) fail("VAULT_CODE_MISSING");
    if (!codePresent.debtToken) fail("DEBT_CODE_MISSING");
    if (!codePresent.oracle) fail("ORACLE_CODE_MISSING");
    if (!codePresent.pool) fail("POOL_CODE_MISSING");
    if (!codePresent.balancer) fail("BALANCER_CODE_MISSING");

    const decimals = row.debtTokenDecimals != null ? Number(row.debtTokenDecimals) : Number(await readUint(local, row.debtToken, "decimals")) || 6;
    const oracleRateRaw = BigInt((await readCall(local, row.oracle, ORACLE_IFACE, "getExchangeRateLiquidate", []))[0]);
    const vaultTypeOnChain = BigInt((await readCall(local, row.vault, VAULT_IFACE, "TYPE", []))[0]).toString();
    const vaultIdOnChain = BigInt((await readCall(local, row.vault, VAULT_IFACE, "VAULT_ID", []))[0]).toString();
    const liquidity = (await readCall(local, row.vault, VAULT_IFACE, "LIQUIDITY", []))[0];

    // vault's own DEX-pool depth (live ERC20 balances)
    const poolDebtBal = await readUint(local, row.debtToken, "balanceOf", [row.exitMarket.dexPool]);
    const poolCollBal = await readUint(local, row.exitMarket.token0, "balanceOf", [row.exitMarket.dexPool]);
    const poolSupply = await readUint(local, row.exitMarket.dexPool, "totalSupply").catch(() => null);

    // VaultResolver live vault state (totalBorrow / liquidityUserBorrowData.borrow)
    let resolverState = null;
    const resolver = loadResolver();
    if (resolver && (await code(resolver.address)) !== "0x") {
      try {
        const d = (await readCall(local, resolver.address, resolver.iface, "getVaultEntireData", [row.vault]))[0];
        const cs = d.constantVariables || {};
        const cfg = d.configs || {};
        const vs = d.vaultState || {};
        const tsb = d.totalSupplyAndBorrow || {};
        const lub = d.liquidityUserBorrowData || {};
        resolverState = {
          vaultType: cs.vaultType != null ? String(cs.vaultType) : null,
          vaultId: cs.vaultId != null ? String(cs.vaultId) : null,
          isSmartCol: d.isSmartCol === true, isSmartDebt: d.isSmartDebt === true,
          oracle: cfg.oracle || null,
          oraclePriceLiquidateRaw: cfg.oraclePriceLiquidate != null ? String(cfg.oraclePriceLiquidate) : null,
          totalBorrowVaultRaw: tsb.totalBorrowVault != null ? String(tsb.totalBorrowVault) : null,
          totalBorrowRaw: vs.totalBorrow != null ? String(vs.totalBorrow) : null,
          totalPositions: vs.totalPositions != null ? String(vs.totalPositions) : null,
          userBorrowBalanceRaw: lub.borrow != null ? String(lub.borrow) : null,
        };
      } catch (_) { resolverState = null; }
    }

    // candidate's simulateLiquidate revert decode (same decoder as the trigger runner)
    let simOutcome;
    try {
      await request(local, "eth_call", [{ to: row.vault, data: LIQ_SIM_IFACE.encodeFunctionData("simulateLiquidate", [0, false]) }, "latest"]);
      simOutcome = { reverted: false, decoded: null, text: "simulateLiquidate-returned", colLiquidated: null, debtLiquidated: null, liquidatable: false };
    } catch (error) {
      if (error.reverted !== true) throw error;
      const decoded = decodeLiqSimRevert(error.revertData || "0x");
      const liquidatable = decoded.name === "FluidLiquidateResult" && decoded.debtLiquidated !== null && BigInt(decoded.debtLiquidated) > 0n;
      simOutcome = { reverted: true, decoded, text: decoded.text, colLiquidated: decoded.colLiquidated, debtLiquidated: decoded.debtLiquidated, liquidatable };
    }

    const vaultType = resolverState && resolverState.vaultType != null ? Number(resolverState.vaultType)
      : (vaultTypeOnChain !== null ? Number(vaultTypeOnChain) : 0);

    record({
      liveState: {
        codePresent,
        decimals,
        vaultTypeOnChain, vaultIdOnChain, liquidity,
        resolverAvailable: Boolean(resolverState),
        resolverVault: resolverState,
        oracleRateLiquidateRaw: oracleRateRaw.toString(),
        simulateLiquidate: { reverted: simOutcome.reverted, text: simOutcome.text, colLiquidated: simOutcome.colLiquidated, debtLiquidated: simOutcome.debtLiquidated, liquidatable: simOutcome.liquidatable },
        poolDepth: {
          debtToken: row.debtToken, collateralToken: row.exitMarket.token0,
          debtTokenBalanceRaw: poolDebtBal !== null ? poolDebtBal.toString() : null,
          collateralTokenBalanceRaw: poolCollBal !== null ? poolCollBal.toString() : null,
          totalSupplyRaw: poolSupply !== null ? poolSupply.toString() : null,
        },
        quoteUnitLabels: {
          debtTokenRaw: "debt-token raw units (USDT 6dp; realizedNet.rawDebtToken)",
          convertedUsdc: "USDC 6dp at 1:1 face (realizedNet.convertedUsdc)",
          colPerUnitDebt: "1e18 fixed-point (vault slippage guard unit)",
          colAmtPerUnitShares: "1e18 fixed-point (DEX pool minOut per share unit)",
        },
      },
    });

    // ---- FUND owner (fork-local only) ----
    stage = "FUND_OWNER";
    await request(local, "anvil_setBalance", [MAIN, quantity(MAIN_FUND_WEI)]);
    await request(local, "anvil_impersonateAccount", [MAIN]);
    const interventions = [{
      kind: "anvil_setBalance+anvil_impersonateAccount", target: "main wallet (constant)", purpose: "fork-local gas + caller only; wallet address unchanged; signed=false",
      signed: false,
    }];

    // ---- DEPLOY executor from the local build artifact ----
    stage = "DEPLOY_EXECUTOR";
    const execArtifact = loadArtifact(EXEC_ARTIFACT, "EXEC_ARTIFACT_MISSING", "EXEC_ARTIFACT_INVALID");
    const gasPriceWei = baseFeeWei > 0n ? baseFeeWei * 2n : 2_000_000_000n;
    const { receipt: deployReceipt } = await sendTx(local, { from: MAIN, data: execArtifact.creation, gas: quantity(DEPLOY_GAS), gasPrice: quantity(gasPriceWei) });
    if (!deployReceipt || deployReceipt.status !== "0x1" || !deployReceipt.contractAddress) fail("DEPLOY_FAILED");
    const EXEC = deployReceipt.contractAddress;
    const execCode = await code(EXEC);
    if (typeof execCode !== "string" || execCode.length <= 2) fail("CODEHASH_UNREADABLE");
    const execOwner = (await readCall(local, EXEC, EXEC_IFACE, "owner", []))[0];
    const execBalancer = (await readCall(local, EXEC, EXEC_IFACE, "BALANCER_VAULT", []))[0];
    if (lc(execOwner) !== lc(MAIN) || lc(execBalancer) !== lc(BALANCER_VAULT)) fail("EXEC_IMMUTABLE_MISMATCH");
    const artifactRuntimeKeccak = keccak256(execArtifact.runtime);
    record({
      executor: {
        address: EXEC,
        codehash: keccak256(execCode),
        artifactRuntimeKeccak,
        runtimeKeccakMatchesArtifact: lc(keccak256(execCode)) === lc(artifactRuntimeKeccak),
        owner: execOwner,
        balancerVault: execBalancer,
        deployMethod: "fork-local deploy of local build artifact creation bytecode (signed=false)",
        artifactPath: "contracts/flash-liquidate-fluid-t2t4/out/FltLiquidateT2T4.sol/FltLiquidateT2T4.json",
      },
    });

    // ---- choose live-derived size + params ----
    const liquidatable = simOutcome.liquidatable;
    let debtAmt, debtAmtSource;
    if (liquidatable) { debtAmt = BigInt(simOutcome.debtLiquidated); debtAmtSource = "simulateLiquidate.debtLiquidated"; }
    else { debtAmt = 1n * 10n ** BigInt(decimals); debtAmtSource = "bounded-default-nonliquidatable"; }
    if (debtAmt <= 0n) fail("FUNDING_FAILED");

    let colPerUnitDebt, colPerUnitDebtSource;
    if (liquidatable && simOutcome.colLiquidated !== null && BigInt(simOutcome.colLiquidated) > 0n) {
      const ratio = (BigInt(simOutcome.colLiquidated) * 10n ** 18n) / BigInt(simOutcome.debtLiquidated);
      colPerUnitDebt = ratio * 99n / 100n; if (colPerUnitDebt <= 0n) colPerUnitDebt = 1n;
      colPerUnitDebtSource = "simulateLiquidate-ratio-1%floor";
    } else { colPerUnitDebt = 1n; colPerUnitDebtSource = "minimal-nonliquidatable"; }
    const colAmtPerUnitShares = 1n;
    const minOut = 1n;
    const minProfitWei = 1n;
    record({
      liveState: {
        ...evidence.liveState,
        debtAmtUsed: { value: debtAmt.toString(), source: debtAmtSource },
        colPerUnitDebtUsed: { value: colPerUnitDebt.toString(), source: colPerUnitDebtSource },
        minOutUsed: minOut.toString(),
        minProfitWeiUsed: minProfitWei.toString(),
        colAmtPerUnitSharesUsed: colAmtPerUnitShares.toString(),
      },
    });

    // ---- FUND flash source (real Balancer locally seeded; labelled) ----
    stage = "FUND_FLASH";
    const seedAmount = debtAmt + 10n ** BigInt(decimals);
    const realBalBefore = await readUint(local, row.debtToken, "balanceOf", [BALANCER_VAULT]);
    let funding;
    if (realBalBefore !== null && realBalBefore >= seedAmount) {
      funding = { method: "real-balancer-existing-balance", realBalancer: true, realDebtToken: true, mockFunding: false, localStorageSeed: false, seededBalanceRaw: realBalBefore.toString(), balanceBeforeRaw: realBalBefore.toString(), note: "real Balancer V2 vault code present at the pin and already holds >= flash amount; REAL flashLoan used, no local funding intervention" };
    } else {
      const seeded = await fundToken(local, row.debtToken, BALANCER_VAULT, seedAmount);
      if (!seeded.ok) fail("FUNDING_FAILED");
      interventions.push({
        kind: "anvil_setStorageAt", target: `real debt token ${row.debtToken} balanceOf[${BALANCER_VAULT}] slot ${seeded.slot}`,
        purpose: "fork-local seed of the real Balancer V2 vault so its REAL flashLoan logic can fund the REAL executor; local-only, signed=false", signed: false,
      });
      funding = { method: `anvil_setStorageAt:keccak(balancer,${seeded.slot})`, realBalancer: true, realDebtToken: true, mockFunding: false, localStorageSeed: true, seededBalanceRaw: seedAmount.toString(), balanceBeforeRaw: realBalBefore !== null ? realBalBefore.toString() : null, note: "real Balancer V2 vault code present at the pin; its REAL flashLoan executes against a fork-local storage seed (mock funding not required, debt token is the real token)" };
    }
    record({ funding });

    // ---- execute the FULL path against the real executor bytecode ----
    stage = "EXECUTE";
    const exitIsToken0 = lc(row.exitMarket.token0) === lc(row.debtToken);
    const isT4 = vaultType === 1;
    const token0DebtAmt = isT4 && lc(row.debtToken) === lc(row.exitMarket.token0) ? debtAmt : 0n;
    const token1DebtAmt = isT4 && lc(row.debtToken) === lc(row.exitMarket.token1) ? debtAmt : 0n;
    const params = [
      row.vault, isT4 ? 1 : 0, row.debtToken, debtAmt,
      token0DebtAmt, token1DebtAmt, isT4 ? 1n : 0n, colPerUnitDebt,
      exitIsToken0, row.debtToken, colAmtPerUnitShares, false,
      minOut, minProfitWei, "0x0000000000000000000000000000000000000000", "0x",
    ];

    const executorDebtBefore = await readUint(local, row.debtToken, "balanceOf", [EXEC]);
    const ownerDebtBefore = await readUint(local, row.debtToken, "balanceOf", [MAIN]);

    let staticRevert = null;
    try {
      await request(local, "eth_call", [{ from: MAIN, to: EXEC, data: encodeExecute(params) }, "latest"]);
    } catch (error) {
      if (error.reverted !== true) throw error;
      staticRevert = decodeLiqSimRevert(error.revertData || "0x");
    }

    const execution = {
      attempted: true,
      params: {
        vault: row.vault, vaultType: isT4 ? 1 : 0, debtToken: row.debtToken, debtAmt: debtAmt.toString(),
        token0DebtAmt: token0DebtAmt.toString(), token1DebtAmt: token1DebtAmt.toString(), debtSharesMin: isT4 ? "1" : "0",
        colPerUnitDebt: colPerUnitDebt.toString(), colPerUnitDebtSource, exitIsToken0, exitToken: row.debtToken,
        colAmtPerUnitShares: colAmtPerUnitShares.toString(), minOut: minOut.toString(), minProfitWei: minProfitWei.toString(),
        debtAmtSource,
      },
      staticCallReverted: staticRevert !== null,
      staticCallReason: staticRevert ? staticRevert.text : null,
      txSent: false, txHash: null, receiptStatus: null,
      gasUsed: null, effectiveGasPriceWei: null, baseFeeWei: baseFeeWei.toString(),
      executorDebtBeforeRaw: executorDebtBefore !== null ? executorDebtBefore.toString() : null,
      executorDebtAfterRaw: null, ownerDebtBeforeRaw: ownerDebtBefore !== null ? ownerDebtBefore.toString() : null, ownerDebtAfterRaw: null,
      event: null,
      perLeg: { flash: null, liquidate: null, exit: null, repay: null },
    };

    let realized = null;
    if (staticRevert) {
      execution.perLeg = {
        flash: { ok: null, reason: "static-call-reverted-before-execution" },
        liquidate: { ok: false, reason: staticRevert.text },
        exit: null, repay: null,
      };
      record({ execution });
      throw new Error("EXECUTE_STATIC_REVERTED");
    }

    const { hash, receipt } = await sendTx(local, { from: MAIN, to: EXEC, data: encodeExecute(params), gas: quantity(EXEC_GAS), gasPrice: quantity(gasPriceWei) });
    execution.txSent = true;
    execution.txHash = hash;
    execution.receiptStatus = receipt ? receipt.status : null;
    execution.gasUsed = receipt && receipt.gasUsed ? BigInt(receipt.gasUsed).toString() : null;
    execution.effectiveGasPriceWei = receipt && receipt.effectiveGasPrice ? BigInt(receipt.effectiveGasPrice).toString() : null;

    const executorDebtAfter = await readUint(local, row.debtToken, "balanceOf", [EXEC]);
    const ownerDebtAfter = await readUint(local, row.debtToken, "balanceOf", [MAIN]);
    execution.executorDebtAfterRaw = executorDebtAfter !== null ? executorDebtAfter.toString() : null;
    execution.ownerDebtAfterRaw = ownerDebtAfter !== null ? ownerDebtAfter.toString() : null;

    for (const log of (receipt && receipt.logs) || []) {
      try {
        if (lc(log.address) === lc(EXEC)) {
          const parsed = EXEC_IFACE.parseLog(log);
          if (parsed && parsed.name === "LiquidationExecuted") {
            execution.event = {
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
    if (execution.event) {
      execution.perLeg = {
        flash: { ok: true, amount: debtAmt.toString(), source: funding.method },
        liquidate: { ok: true, debtLiquidated: execution.event.debtLiquidated, colSharesLiquidated: execution.event.colSharesLiquidated },
        exit: { ok: true, exitOut: execution.event.exitOut, swapOut: execution.event.swapOut },
        repay: { ok: true, repayAmount: debtAmt.toString(), netProfitWei: execution.event.netProfitWei },
      };
    }
    record({ execution });

    if (!receipt || receipt.status !== "0x1") throw new Error("EXECUTE_TX_REVERTED");

    const gross = (ownerDebtBefore !== null && ownerDebtAfter !== null) ? ownerDebtAfter - ownerDebtBefore : null;
    const converted = gross === null ? null : (decimals === 6 ? gross : (gross * 10n ** 6n) / 10n ** BigInt(decimals));
    realized = {
      rawDebtToken: gross === null ? null : gross.toString(),
      grossRawDebtToken: gross === null ? null : gross.toString(),
      convertedUsdc: converted === null ? null : converted.toString(),
      conversionProvenance: `debtToken=${row.debtTokenSymbol || "debtToken"} decimals=${decimals}; converted to USDC at 1:1 face for 6-dp USD stablecoins (no external price API); stage6 oracleRateLiquidateRaw=${oracleRateRaw} recorded for reference (vault col-share liquidation price, not a debt/USD rate)`,
      gasUsed: execution.gasUsed,
      gasCostWei: execution.gasUsed !== null && execution.effectiveGasPriceWei !== null ? (BigInt(execution.gasUsed) * BigInt(execution.effectiveGasPriceWei)).toString() : null,
      gasCostConvertedUsdc: null,
      gasCostProvenance: "gas is paid in ETH; no ETH/USD price is read at the pin (no external price API), so gas is reported in wei only and not converted",
    };
    record({ realizedNet: realized });

    if (gross === null) fail("REALIZED_NET_NONPOSITIVE");
    if (gross <= 0n) throw new Error("REALIZED_NET_NONPOSITIVE");

    record({
      verdict: { state: "PASS", reason: "REALIZED_NET_POSITIVE_ON_REAL_EXECUTOR_BYTECODE", stage: "EXECUTE", passBasis: "realizedNet.rawDebtToken > 0 on the real executor bytecode at real pin state; gas reported in wei, not converted" },
    });
  } catch (error) {
    const reason = CODES.has(error?.message) ? error.message : "INTERNAL_FAILURE";
    record({
      verdict: { state: "FAIL", reason, stage, passBasis: null },
      realizedNet: evidence.realizedNet,
    });
    if (process.env.REHEARSAL_DEBUG === "1") {
      process.stderr.write(`[debug] stage=${stage} reason=${reason} ${error && error.stack ? error.stack.split("\n").slice(0, 3).join(" | ") : String(error)}\n`);
    }
  } finally {
    clean = stopAnvil();
    stopRelay();
  }

  evidence = { ...evidence, cleanup: clean ? "clean" : "residual", completedAt: now().toISOString() };
  writeEvidence(output, evidence);
  return evidence;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
async function main() {
  const result = await runRehearsal({});
  const summary = {
    state: result.verdict.state, reason: result.verdict.reason, stage: result.verdict.stage,
    attemptId: result.attemptId, pin: result.pin ? result.pin.block : null,
    candidate: result.candidate ? result.candidate.vault : null,
    executor: result.executor ? result.executor.address : null,
    realizedNetRaw: result.realizedNet ? result.realizedNet.rawDebtToken : null,
    cleanup: result.cleanup, label: result.label,
  };
  process.stdout.write(JSON.stringify(summary) + "\n");
  if (result.verdict.state !== "PASS") process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(String((error && error.message) || error).replace(/https?:\/\/\S+/g, "[redacted]") + "\n");
    process.exitCode = 1;
  });
}

process.once("exit", () => { stopAnvil(); });
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { aborted = true; stopAnvil(); process.exit(1); });

module.exports = {
  runRehearsal,
  buildFailEvidence,
  decodeLiqSimRevert,
  validateEvidenceShape,
  scanEvidenceForSecrets,
  defaultCandidate,
  newAttemptId,
  CODES,
  PATHS: { OUTPUT, OUTDIR, SOURCE_JSON, EXEC_ARTIFACT, RESOLVER_JSON },
  MAIN,
  CANDIDATE_VAULT,
  BALANCER_VAULT,
  LABEL,
};
