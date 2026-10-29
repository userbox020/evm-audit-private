#!/usr/bin/env node
"use strict";

// twyne-wrapper-accounting-step2.js
// T-1 step 2: Twyne wrapper accounting decomposition on a keyless, local-only fork.
//
// Scope (read-only + fork-local impersonated txs only):
//   a-1a  asset() chain shape of wrapper -> intermediate -> eWETH on a fresh finalized-pin fork
//   a-1b  archive-derivative (NO fork): per-block totalAssets/totalSupply premium over ~7 days,
//         plus an archive re-read of the step-1 REVERT rows at their exact pin
//   a-1c  decode convertToAssets(1e18) REVERT + ERC-4626 round-trip conservation rows
//   a-1d  forked harness: impersonated fresh EOA, 10 wstETH deposit -> shares -> withdraw roundtrip,
//         with a deterministic same-block control that isolates natural Aave interest accrual
//
// Discipline (reports/profitable-exploit-analysis-framework-20261012.md):
//   * every numeric row carries its pin block + hash
//   * unit-scale guard fires INCONCLUSIVE_UNIT_SCALE_MISMATCH instead of a raw number
//   * no signing, no real-key reads; anvil txs only from impersonated/funded EOAs on the fork
//   * nothing is ever forwarded upstream
//
// Endpoint material (URL / host / path) is NEVER printed, persisted, or logged.
// Anvil forks through an in-process loopback relay that owns the upstream, mirroring
// tools/aave-v3-flash-liquidator-rehearsal.js and tools/liquity-fork-rehearsal.js.
// The only endpoint watermark emitted anywhere is the path-only inventory name.

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");
const { spawn, spawnSync } = require("node:child_process");
const { Interface, AbiCoder, keccak256 } = require(path.join(__dirname, "node_modules", "ethers"));

const ROOT = path.resolve(__dirname, "..");
const OUTDIR = path.join(ROOT, "reports", "raw", "fast");
const OUTPUT = path.join(OUTDIR, "twyne-wrapper-accounting-step2.json");
const INVENTORY = path.join(ROOT, "rpc_endpoints.txt");
const ANVIL = "C:\\Users\\MiPC\\.foundry\\bin\\anvil.exe";

const CHAIN_ID = 1;
const WSTETH = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0";
const WRAPPER = "0xFaBA8f777996C0C28fe9e6554D84cB30ca3e1881";
const WRAPPER_IMPL = "0x41695d3304e38bc806f077a3541c5cd34f8f034b";
const INTERMEDIATE = "0x75029a47f28550C93Ad5A3BbD2d9b5315204B561";
const EWETH = "0x87b8081A3ace680f35125F469526Ac10f5418Ca7";
const EWETH_ASSET = "0xd8b27cf359b7d15710a5be299af6e7bf904984c2";
const PIN_HINT = 26173469;

const EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ONE = 10n ** 18n;
const FUND_WSTETH = 10n * ONE;
const ARCHIVE_SPAN = 50400; // ~7 days at 12s blocks
const HEIGHT_OFFSETS = [0, 12600, 25200, 37800, 50400];
const UNIT_SCALE_TARGET = 10n ** 14n; // 1e14 precision floor for fee/premium measurement

const LIMIT_MS = 480000;
const MAX_INVENTORY = 24;

const fail = (code) => { const e = new Error(code); e.code = code; throw e; };
const quantity = (value) => "0x" + BigInt(value).toString(16);
const word = (value) => `0x${BigInt(value).toString(16).padStart(64, "0")}`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const num = (v) => Number(BigInt(v));
const deadline = Date.now() + LIMIT_MS;

const EOA = "0x" + keccak256(Buffer.from("twyne-wrapper-accounting-step2-eoa", "utf8")).slice(26);

let anvil = null;
let requestId = 0;
let aborted = false;
let stage = "SETUP";
let preferred = null;
const failedBackings = new Set();
const live = [];

const IFACE = {
  v4626: new Interface([
    "function asset() view returns (address)",
    "function totalAssets() view returns (uint256)",
    "function totalSupply() view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function convertToAssets(uint256 shares) view returns (uint256)",
    "function convertToShares(uint256 assets) view returns (uint256)",
    "function previewDeposit(uint256 assets) view returns (uint256)",
    "function previewRedeem(uint256 shares) view returns (uint256)",
    "function previewWithdraw(uint256 assets) view returns (uint256)",
    "function previewMint(uint256 shares) view returns (uint256)",
    "function maxDeposit(address) view returns (uint256)",
    "function maxWithdraw(address) view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
    "function name() view returns (string)",
    "function symbol() view returns (string)",
    "function paused() view returns (bool)",
    "function aToken() view returns (address)",
    "function POOL() view returns (address)",
    "function owner() view returns (address)",
    "function admin() view returns (address)",
    "function version() view returns (uint256)",
    "function collateralVaultFactory() view returns (address)",
    "function deposit(uint256 assets, address receiver) returns (uint256)",
    "function withdraw(uint256 assets, address receiver, address owner) returns (uint256)",
    "function redeem(uint256 shares, address receiver, address owner) returns (uint256)",
  ]),
  erc20: new Interface([
    "function balanceOf(address) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function approve(address spender, uint256 value) returns (bool)",
    "function transfer(address to, uint256 value) returns (bool)",
  ]),
  events: new Interface([
    "event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)",
    "event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)",
    "event Transfer(address indexed from, address indexed to, uint256 value)",
  ]),
  errors: new Interface([
    "error ERC4626ExceededMaxDeposit(address receiver, uint256 assets, uint256 max)",
    "error ERC4626ExceededMaxMint(address receiver, uint256 shares, uint256 max)",
    "error ERC4626ExceededMaxRedeem(address owner, uint256 shares, uint256 max)",
    "error ERC4626ExceededMaxWithdraw(address owner, uint256 assets, uint256 max)",
    "error StaticATokenInvalidZeroShares()",
    "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
    "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
    "error ERC20InvalidReceiver(address receiver)",
    "error ERC20InvalidSender(address sender)",
    "error EnforcedPause()",
    "error ExpectedPause()",
    "error SafeERC20FailedOperation(address token)",
    "error ZeroAddress()",
    "error NotCollateralVault()",
    "error ControllerDisabled()",
    "error CallerNotAdmin()",
    "error OnlyPauseGuardian(address caller)",
    "error PoolAddressMismatch(address pool)",
    "error AddressEmptyCode(address target)",
    "error FailedCall()",
    "error ERC1967InvalidImplementation(address implementation)",
    "error ERC1967NonPayable()",
  ]),
};

const CODES = new Set([
  "ANVIL_MISSING", "ANVIL_CLEANUP_FAILED", "ANVIL_ARGUMENTS_INVALID", "ANVIL_START_FAILED",
  "FORK_BLOCK_MISMATCH", "FORK_BACKING_UNSUPPORTED", "FORK_BACKING_METHOD_MISSING", "FORK_BACKING_STATE_MISSING",
  "FORK_BACKING_BLOCK_FAILURE", "FORK_BACKING_CHAIN_ID_FAILURE", "FORK_BACKING_GAS_PRICE_FAILURE",
  "FORK_BACKING_TRANSACTION_FAILURE", "FORK_BACKING_PROOF_FAILURE", "FORK_BACKING_CODE_FAILURE",
  "FORK_BACKING_BALANCE_FAILURE", "FORK_BACKING_RATE_LIMITED",
  "INVENTORY_MISSING", "NO_ARCHIVE_BACKING", "DEADLINE_EXCEEDED",
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

async function qualify(url, { needArchive }) {
  if (await rpc(url, "eth_chainId", [], true) !== "0x1") return null;
  const head = (await rpc(url, "eth_getBlockByNumber", ["finalized", false], true).catch(() => null))
    || (await rpc(url, "eth_getBlockByNumber", ["latest", false], true));
  if (!head || !/^0x[0-9a-f]{64}$/i.test(head.hash || "") || !/^0x[0-9a-f]+$/i.test(head.number || "")) return null;
  const headNumber = num(head.number);
  const pin = headNumber - 1;
  const pinBlock = await rpc(url, "eth_getBlockByNumber", [quantity(pin), false], true);
  if (!pinBlock || num(pinBlock.number) !== pin || !/^0x[0-9a-f]{64}$/i.test(pinBlock.hash || "")) return null;
  for (const addr of [WRAPPER, INTERMEDIATE, EWETH]) {
    const code = await rpc(url, "eth_getCode", [addr, quantity(pin)], true);
    if (typeof code !== "string" || code.length <= 2) return null;
  }
  const assetProbe = await rpc(url, "eth_call", [{ to: WRAPPER, data: IFACE.v4626.encodeFunctionData("asset", []) }, quantity(pin)], true);
  const [asset] = IFACE.v4626.decodeFunctionResult("asset", assetProbe);
  if (String(asset).toLowerCase() !== WSTETH.toLowerCase()) return null;
  let archiveHeight = null;
  if (needArchive) {
    archiveHeight = pin - ARCHIVE_SPAN;
    const hb = await rpc(url, "eth_getBlockByNumber", [quantity(archiveHeight), false], true);
    if (!hb || !/^0x[0-9a-f]{64}$/i.test(hb.hash || "")) return null;
    const probe = await rpc(url, "eth_call", [{ to: WRAPPER, data: IFACE.v4626.encodeFunctionData("totalAssets", []) }, quantity(archiveHeight)], true);
    const [ta] = IFACE.v4626.decodeFunctionResult("totalAssets", probe);
    if (BigInt(ta) <= 0n) return null;
  }
  return { pin, pinHash: pinBlock.hash, pinTimestamp: num(pinBlock.timestamp), headNumber, archiveHeight };
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
    try { backing = await qualify(cand.url, { needArchive: false }); } catch (_) { failedBackings.add(cand.url); continue; }
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
      if (process.env.TWYNE_STEP2_DEBUG === "1") process.stderr.write(`[debug] fork ${name} backing failed: ${lastErr}\n`);
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

async function view(url, to, fn, args, block = "latest", iface = IFACE.v4626) {
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

async function setNextTs(local, ts) {
  try { await rpc(local, "evm_setNextBlockTimestamp", [quantity(ts)]); }
  catch (_) { await rpc(local, "anvil_setNextBlockTimestamp", [quantity(ts)]); }
}

function decodeReceiptEvents(receipt, addresses) {
  const out = [];
  const allow = new Set((addresses || []).map((a) => a.toLowerCase()));
  for (const log of receipt.logs || []) {
    if (allow.size && !allow.has(String(log.address).toLowerCase())) continue;
    let parsed = null;
    try { parsed = IFACE.events.parseLog(log); } catch (_) { /* unknown */ }
    if (!parsed) continue;
    const args = {};
    for (const [k, v] of Object.entries(parsed.args)) {
      if (/^\d+$/.test(k)) continue;
      args[k] = typeof v === "bigint" ? v.toString() : String(v);
    }
    out.push({ address: log.address, name: parsed.name, args });
  }
  return out;
}

const bps = (ta, ts) => (ts === 0n ? null : ((ta - ts) * 10000n) / ts);

// ---------------------------------------------------------------------------
// a-1a  asset() chain shape
// ---------------------------------------------------------------------------
async function stage1a(local, backing) {
  const layers = [
    { key: "wrapper", addr: WRAPPER, expect: WSTETH, label: "wstETH" },
    { key: "intermediate", addr: INTERMEDIATE, expect: WRAPPER, label: "wrapper(awstETH)" },
    { key: "eweth", addr: EWETH, expect: EWETH_ASSET, label: "staticAToken(0xd8b27cf3)" },
  ];
  const rows = [];
  for (const L of layers) {
    const asset = await view(local, L.addr, "asset", []);
    const row = {
      layer: L.key, address: L.addr,
      asset: asset.ok ? String(asset.value) : null,
      assetReadReverted: asset.ok ? false : true,
      expectedAsset: L.expect, expectedLabel: L.label,
      match: asset.ok && String(asset.value).toLowerCase() === L.expect.toLowerCase(),
    };
    const dec = await view(local, L.addr, "decimals", []);
    row.decimals = dec.ok ? String(dec.value) : null;
    const ts = await view(local, L.addr, "totalSupply", []);
    const ta = await view(local, L.addr, "totalAssets", []);
    row.totalSupply = ts.ok ? String(ts.value) : null;
    row.totalAssets = ta.ok ? String(ta.value) : null;
    row.premiumBps = (ta.ok && ts.ok && BigInt(ts.value) > 0n) ? bps(BigInt(ta.value), BigInt(ts.value)).toString() : null;
    const nm = await view(local, L.addr, "name", []);
    row.name = nm.ok ? String(nm.value) : null;
    const slot = await rpc(local, "eth_getStorageAt", [L.addr, EIP1967_IMPL_SLOT, "latest"]);
    row.eip1967Impl = (typeof slot === "string" && /^0x[0-9a-f]{64}$/i.test(slot)) ? ("0x" + slot.slice(-40)) : null;
    if (L.key === "wrapper") {
      const at = await view(local, L.addr, "aToken", []);
      row.aToken = at.ok ? String(at.value) : null;
      const pool = await view(local, L.addr, "POOL", []);
      row.pool = pool.ok ? String(pool.value) : null;
      const pause = await view(local, L.addr, "paused", []);
      row.paused = pause.ok ? Boolean(pause.value) : null;
      const ver = await view(local, L.addr, "version", []);
      row.version = ver.ok ? String(ver.value) : null;
      row.implMatchesPinHint = row.eip1967Impl ? row.eip1967Impl.toLowerCase() === WRAPPER_IMPL.toLowerCase() : false;
    }
    rows.push(row);
  }
  const divergent = rows.filter((r) => !r.match);
  const verdict = divergent.length === 0 ? "PASS" : "FAIL_ASSET_CHAIN_DIVERGENT";
  return {
    verdict, pin: backing.pin, pinHash: backing.pinHash,
    rows,
    divergence: divergent.map((r) => ({ layer: r.layer, got: r.asset, expected: r.expectedAsset })),
    note: "wrapper.asset==wstETH && intermediate.asset==wrapper && eWETH.asset==0xd8b27cf3",
  };
}

// ---------------------------------------------------------------------------
// a-1b  archive-derivative, no fork
// ---------------------------------------------------------------------------
async function historicalRevertProbe(url, block) {
  const targets = [
    { key: "wrapper", addr: WRAPPER },
    { key: "intermediate", addr: INTERMEDIATE },
    { key: "eweth", addr: EWETH },
  ];
  const out = {
    block,
    note: "re-read of the step-1 snapshot rows (tools/batch16-ladder-spoke.live.json) at their exact pin via archive eth_call",
    calls: [],
  };
  for (const t of targets) {
    for (const spec of [["convertToAssets", [ONE], "convertToAssets(1e18)"], ["balanceOf", [WRAPPER], "balanceOf(wrapper)"]]) {
      const [fn, args, label] = spec;
      const r = await tryCall(url, t.addr, IFACE.v4626.encodeFunctionData(fn, args), quantity(block));
      let decoded = null;
      if (r.ok) { try { decoded = String(IFACE.v4626.decodeFunctionResult(fn, r.result)[0]); } catch (_) { decoded = r.result; } }
      out.calls.push({ layer: t.key, address: t.addr, call: label, reverted: !r.ok, revertData: r.revertData || null, decoded: r.ok ? null : decodeRevert(r.revertData), returns: decoded });
    }
  }
  const nm = await tryCall(url, WRAPPER, IFACE.v4626.encodeFunctionData("name", []), quantity(block));
  if (nm.ok) { try { out.wrapperName = String(IFACE.v4626.decodeFunctionResult("name", nm.result)[0]); } catch (_) { out.wrapperName = nm.result; } }
  out.wrapperNameReverted = !nm.ok;
  try {
    const snapPath = path.join(ROOT, "tools", "batch16-ladder-spoke.live.json");
    if (fs.existsSync(snapPath)) out.step1Snapshot = JSON.parse(fs.readFileSync(snapPath, "utf8"));
  } catch (_) { /* snapshot optional */ }
  return out;
}

function classifyShape(premiums) {
  // premiums: array of {block, bps} ascending in the derived metric (ppb here)
  if (premiums.length < 3) return { shape: "INSUFFICIENT_POINTS", confidence: "low" };
  const abs = [];
  const rel = [];
  for (let i = 1; i < premiums.length; i += 1) {
    const d = premiums[i].bps - premiums[i - 1].bps;
    abs.push(d);
    rel.push(premiums[i - 1].bps === 0 ? 0 : (d * 1e6) / premiums[i - 1].bps);
  }
  if (abs.some((d) => d < 0)) return { shape: "non_monotonic", confidence: "low", absPpb: abs, relPpm: rel };
  const mean = abs.reduce((a, b) => a + b, 0) / abs.length;
  if (mean <= 0) return { shape: "flat_or_zero", confidence: "low", absPpb: abs, relPpm: rel };
  const spread = (arr) => (Math.max(...arr) - Math.min(...arr)) / (Math.abs(arr.reduce((a, b) => a + b, 0) / arr.length) || 1);
  const absVar = spread(abs);
  const relVar = spread(rel);
  const total = abs.reduce((a, b) => a + b, 0);
  const maxAbs = Math.max(...abs);
  if (abs.length >= 3 && total > 0 && maxAbs / total >= 0.6 && (total - maxAbs) / total <= 0.4 && absVar > 0.25) {
    return { shape: "step", confidence: "low", absPpb: abs, relPpm: rel };
  }
  if (absVar <= 0.25) return { shape: "linear", confidence: "low", absPpb: abs, relPpm: rel };
  if (relVar <= 0.25) return { shape: "compound", confidence: "low", absPpb: abs, relPpm: rel };
  return { shape: "mixed", confidence: "low", absPpb: abs, relPpm: rel };
}

async function archiveStage1b() {
  const pool = candidatePool();
  let chosen = null;
  for (const cand of pool) {
    if (failedBackings.has(cand.url)) continue;
    budget(20000);
    try {
      const b = await qualify(cand.url, { needArchive: true });
      if (b) { chosen = { ...cand, ...b }; break; }
    } catch (_) { /* next */ }
  }
  if (!chosen) {
    return { verdict: "INSUFFICIENT_EVIDENCE", reason: "NO_ARCHIVE_BACKING_WITH_7D_HISTORY", rows: [], derivatives: [], shape: {} };
  }
  const layers = [
    { key: "wrapper", addr: WRAPPER },
    { key: "intermediate", addr: INTERMEDIATE },
    { key: "eweth", addr: EWETH },
  ];
  const decimals = {};
  for (const L of layers) {
    const d = await view(chosen.url, L.addr, "decimals", [], quantity(chosen.pin));
    decimals[L.key] = d.ok ? num(d.value) : null;
  }
  const unitMismatch = layers.some((L) => decimals[L.key] !== null && decimals[L.key] !== 18);
  const rows = [];
  const heights = HEIGHT_OFFSETS.map((o) => chosen.pin - o).filter((h) => h > 0);
  for (const L of layers) {
    for (const h of heights) {
      const blk = await rpc(chosen.url, "eth_getBlockByNumber", [quantity(h), false]);
      const ta = await view(chosen.url, L.addr, "totalAssets", [], quantity(h));
      const ts = await view(chosen.url, L.addr, "totalSupply", [], quantity(h));
      const row = {
        layer: L.key, address: L.addr, block: h,
        blockHash: blk && /^0x[0-9a-f]{64}$/i.test(blk.hash || "") ? blk.hash : null,
        timestamp: blk && blk.timestamp ? num(blk.timestamp) : null,
        totalAssets: ta.ok ? String(ta.value) : null,
        totalSupply: ts.ok ? String(ts.value) : null,
        readOk: ta.ok && ts.ok,
        surplusWei: null, premiumPpb: null, premiumPpt: null, premiumBps: null,
      };
      if (row.readOk) {
        const taV = BigInt(row.totalAssets), tsV = BigInt(row.totalSupply);
        row.surplusWei = (taV - tsV).toString();
        if (tsV > 0n) {
          row.premiumPpb = ((taV * 10n ** 9n) / tsV).toString();
          row.premiumPpt = ((taV * 10n ** 12n) / tsV).toString();
          row.premiumBps = bps(taV, tsV).toString();
        }
      }
      rows.push(row);
    }
  }
  const historicalProbe = await historicalRevertProbe(chosen.url, PIN_HINT);
  const derivatives = [];
  const shape = {};
  for (const L of layers) {
    const lr = rows.filter((r) => r.layer === L.key && r.readOk && r.premiumPpt !== null)
      .sort((a, b) => a.block - b.block);
    if (lr.length < 4) { shape[L.key] = { shape: "INSUFFICIENT_POINTS", points: lr.length }; continue; }
    for (let i = 1; i < lr.length; i += 1) {
      const seconds = lr[i].timestamp - lr[i - 1].timestamp;
      const p0 = BigInt(lr[i - 1].premiumPpt), p1 = BigInt(lr[i].premiumPpt);
      const s0 = BigInt(lr[i - 1].surplusWei), s1 = BigInt(lr[i].surplusWei);
      const deltaPpt = Number(p1 - p0);
      const deltaSurplusWei = s1 - s0;
      derivatives.push({
        layer: L.key, fromBlock: lr[i - 1].block, toBlock: lr[i].block, seconds,
        totalSupplyChanged: lr[i].totalSupply !== lr[i - 1].totalSupply,
        premiumPptFrom: p0.toString(), premiumPptTo: p1.toString(),
        deltaPpt, pptPerDay: seconds > 0 ? Number(((BigInt(deltaPpt) * 86400n) / BigInt(seconds)).toString()) : null,
        surplusWeiFrom: s0.toString(), surplusWeiTo: s1.toString(),
        deltaSurplusWei: deltaSurplusWei.toString(),
        surplusWeiPerDay: seconds > 0 ? (deltaSurplusWei * 86400n / BigInt(seconds)).toString() : null,
      });
    }
    // shape only from intervals without a totalSupply change (flow-contaminated intervals excluded)
    const clean = [lr[0]];
    for (let i = 1; i < lr.length; i += 1) if (lr[i].totalSupply === lr[i - 1].totalSupply) clean.push(lr[i]);
    const premiums = clean.map((r) => ({ block: r.block, bps: Number(BigInt(r.premiumPpt)) }));
    shape[L.key] = { ...classifyShape(premiums), metric: "premiumPpt", points: clean.length, flowIntervals: lr.length - clean.length, firstPpt: premiums[0].bps, lastPpt: premiums[premiums.length - 1].bps };
  }
  const verdict = unitMismatch ? "INCONCLUSIVE_UNIT_SCALE_MISMATCH"
    : (layers.every((L) => (shape[L.key]?.points || 0) >= 4) ? "PASS" : "INSUFFICIENT_EVIDENCE");
  return {
    verdict, pin: chosen.pin, pinHash: chosen.pinHash, archiveBackingClass: chosen.backingClass,
    spanBlocks: ARCHIVE_SPAN, offsets: HEIGHT_OFFSETS, decimals, unitMismatch,
    rows, derivatives, shape, historicalProbe,
    note: "read-only eth_call at archived heights; premiumPpb = floor(totalAssets*1e9/totalSupply); per-day rate from exact header timestamps; intervals with a totalSupply change are flow-contaminated",
  };
}

// ---------------------------------------------------------------------------
// a-1c  convertToAssets revert decode + round-trip conservation
// ---------------------------------------------------------------------------
async function stage1c(local, backing) {
  const layers = [
    { key: "wrapper", addr: WRAPPER },
    { key: "intermediate", addr: INTERMEDIATE },
    { key: "eweth", addr: EWETH },
  ];
  const reverts = [];
  for (const L of layers) {
    const r = await tryCall(local, L.addr, IFACE.v4626.encodeFunctionData("convertToAssets", [ONE]), "latest");
    reverts.push({
      layer: L.key, address: L.addr, call: "convertToAssets(1e18)",
      reverted: !r.ok, revertData: r.revertData || null,
      decoded: r.ok ? null : decodeRevert(r.revertData),
      returns: r.ok ? r.result : null,
    });
  }
  const roundTrips = [];
  for (const L of layers) {
    const row = { layer: L.key, address: L.addr, legs: {}, conservation: null, verdict: "PASS" };
    const ts = await view(local, L.addr, "totalSupply", []);
    const ta = await view(local, L.addr, "totalAssets", []);
    row.totalSupply = ts.ok ? String(ts.value) : null;
    row.totalAssets = ta.ok ? String(ta.value) : null;
    const dec = await view(local, L.addr, "decimals", []);
    row.decimals = dec.ok ? String(dec.value) : null;
    if (ta.ok && ts.ok && BigInt(ts.value) > 0n) {
      row.impliedConvertToAssets1e18 = ((BigInt(ta.value) * ONE) / BigInt(ts.value)).toString();
    }
    const a1 = await tryCall(local, L.addr, IFACE.v4626.encodeFunctionData("convertToAssets", [ONE]), "latest");
    row.legs.convertToAssets_1e18 = a1.ok ? a1.result : null;
    if (!a1.ok) { row.legs.convertToAssets_1e18_revert = decodeRevert(a1.revertData); row.verdict = "INCONCLUSIVE_CONVERT_REVERT"; }
    if (a1.ok) {
      const assets = BigInt(a1.result);
      row.legs.assets1 = assets.toString();
      if (row.impliedConvertToAssets1e18) row.impliedVsActualDiffWei = (assets - BigInt(row.impliedConvertToAssets1e18)).toString();
      const s1 = await tryCall(local, L.addr, IFACE.v4626.encodeFunctionData("convertToShares", [assets]), "latest");
      row.legs.convertToShares_assets1 = s1.ok ? s1.result : null;
      if (!s1.ok) { row.legs.convertToShares_revert = decodeRevert(s1.revertData); row.verdict = "INCONCLUSIVE_CONVERT_REVERT"; }
      if (s1.ok) {
        const sharesBack = BigInt(s1.result);
        const a2 = await tryCall(local, L.addr, IFACE.v4626.encodeFunctionData("convertToAssets", [sharesBack]), "latest");
        row.legs.convertToAssets_sharesBack = a2.ok ? a2.result : null;
        if (!a2.ok) { row.legs.convertToAssets_revert2 = decodeRevert(a2.revertData); row.verdict = "INCONCLUSIVE_CONVERT_REVERT"; }
        if (a2.ok) {
          const assets2 = BigInt(a2.result);
          const cons = assets > assets2 ? assets - assets2 : assets2 - assets;
          row.conservation = { assets1: assets.toString(), sharesBack: sharesBack.toString(), assets2: assets2.toString(), absDiffWei: cons.toString(), withinUnitScale: cons < UNIT_SCALE_TARGET };
          if (cons === 0n) row.verdict = "PASS_EXACT";
          else if (cons < UNIT_SCALE_TARGET) row.verdict = "PASS_ROUNDING_WITHIN_FLOOR";
          else row.verdict = "FAIL_CONSERVATION_NONZERO";
        }
      }
    }
    const sB = await tryCall(local, L.addr, IFACE.v4626.encodeFunctionData("convertToShares", [ONE]), "latest");
    row.legs.convertToShares_1e18 = sB.ok ? sB.result : null;
    if (!sB.ok) row.legs.convertToShares_1e18_revert = decodeRevert(sB.revertData);
    if (sB.ok) {
      const shares = BigInt(sB.result);
      const aB = await tryCall(local, L.addr, IFACE.v4626.encodeFunctionData("convertToAssets", [shares]), "latest");
      row.legs.convertToAssets_shares = aB.ok ? aB.result : null;
      if (!aB.ok) row.legs.convertToAssets_shares_revert = decodeRevert(aB.revertData);
      if (aB.ok) row.reverse = { shares: shares.toString(), assets: BigInt(aB.result).toString() };
    }
    const pd = await tryCall(local, L.addr, IFACE.v4626.encodeFunctionData("previewDeposit", [ONE]), "latest");
    if (pd.ok) { try { row.previewDeposit1e18 = IFACE.v4626.decodeFunctionResult("previewDeposit", pd.result)[0].toString(); } catch (_) { row.previewDeposit1e18 = pd.result; } }
    else row.previewDeposit1e18_revert = decodeRevert(pd.revertData);
    roundTrips.push(row);
  }
  const reproduced = reverts.some((r) => r.reverted);
  const anyFail = roundTrips.some((r) => r.verdict === "FAIL_CONSERVATION_NONZERO");
  const verdict = anyFail ? "FAIL_CONSERVATION_NONZERO"
    : (reproduced || roundTrips.some((r) => String(r.verdict).startsWith("INCONCLUSIVE"))) ? "INCONCLUSIVE_CONVERT_REVERT"
    : "PASS";
  return {
    verdict, pin: backing.pin, pinHash: backing.pinHash, reverts, roundTrips,
    revertReproduction: reproduced ? "REPRODUCED_ON_FORK" : "NOT_REPRODUCED_ON_FORK",
    note: "conservation is |convertToAssets(1e18) - convertToAssets(convertToShares(convertToAssets(1e18)))|; a 1-wei floor-truncation is standard ERC-4626 rounding, not a leak",
  };
}

// ---------------------------------------------------------------------------
// a-1d  forked deposit -> shares -> withdraw harness
// ---------------------------------------------------------------------------
async function readUint(local, addr, fn, args = []) {
  const r = await view(local, addr, fn, args);
  return r.ok ? BigInt(r.value) : null;
}

async function fundWsteth(local, amount) {
  // Primary: locate the ERC20 balance mapping slot by writing keccak(EOA, slot) — only
  // mapping-derived keys are written, never a plain storage slot, so unrelated state
  // is not corrupted. Fallback: impersonate the wrapper (a known wstETH holder) and transfer.
  for (let slot = 0; slot < 40; slot += 1) {
    const key = keccak256(AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [EOA, slot]));
    await rpc(local, "anvil_setStorageAt", [WSTETH, key, word(amount)]);
    const bal = await readUint(local, WSTETH, "balanceOf", [EOA]);
    if (bal !== null && bal >= amount) return { method: `anvil_setStorageAt:keccak(EOA,${slot})`, slot, ok: true };
  }
  const wrapperBal = await readUint(local, WSTETH, "balanceOf", [WRAPPER]);
  if (wrapperBal !== null && wrapperBal >= amount) {
    await rpc(local, "anvil_impersonateAccount", [WRAPPER]);
    await rpc(local, "anvil_setBalance", [WRAPPER, quantity(10n ** 19n)]);
    const data = IFACE.erc20.encodeFunctionData("transfer", [EOA, amount]);
    const { receipt } = await sendTx(local, { from: WRAPPER, to: WSTETH, data, gas: quantity(200000), gasPrice: quantity(2n * 10n ** 9n) });
    if (receipt && receipt.status === "0x1") {
      const bal = await readUint(local, WSTETH, "balanceOf", [EOA]);
      if (bal !== null && bal >= amount) return { method: "impersonate-wrapper-transfer", ok: true };
    }
  }
  return { method: null, ok: false };
}

async function stage1d(local, backing) {
  const out = {
    verdict: "INSUFFICIENT_EVIDENCE", pin: backing.pin, pinHash: backing.pinHash,
    eoa: EOA, funding: null, paused: null, ledger: null, rows: [], attempts: [], failures: [],
  };
  const paused = await readUint(local, WRAPPER, "paused");
  out.paused = paused === null ? null : Boolean(paused);
  if (out.paused === true) { out.verdict = "INCONCLUSIVE_WRAPPER_PAUSED"; return out; }

  if ((await rpc(local, "eth_getCode", [EOA, "latest"])) !== "0x") { out.verdict = "FAIL_EOA_HAS_CODE"; return out; }
  await rpc(local, "anvil_setBalance", [EOA, quantity(10n ** 20n)]);
  await rpc(local, "anvil_impersonateAccount", [EOA]);

  stage = "1D_FUND";
  const fund = await fundWsteth(local, FUND_WSTETH);
  out.funding = { method: fund.method, ok: fund.ok, amountWei: FUND_WSTETH.toString(), wroteStorageOnlyMappingKeys: true };
  if (!fund.ok) { out.verdict = "INSUFFICIENT_EVIDENCE_FUNDING_FAILED"; return out; }

  const wrapBal = async () => (await readUint(local, WRAPPER, "balanceOf", [EOA])) ?? 0n;
  const wstBal = async () => (await readUint(local, WSTETH, "balanceOf", [EOA])) ?? 0n;
  const taOf = async (a) => readUint(local, a, "totalAssets");
  const tsOf = async (a) => readUint(local, a, "totalSupply");

  stage = "1D_APPROVE";
  const appr = await sendTx(local, { from: EOA, to: WSTETH, data: IFACE.erc20.encodeFunctionData("approve", [WRAPPER, FUND_WSTETH]), gas: quantity(120000), gasPrice: quantity(2n * 10n ** 9n) });
  if (!appr.receipt || appr.receipt.status !== "0x1") { out.verdict = "FAIL_APPROVE_REVERTED"; out.attempts.push({ step: "approve", status: appr.receipt ? appr.receipt.status : null }); return out; }

  // Deterministic control: measure the natural per-block Aave interest accrual at the
  // identical block number and timestamp the action will use, then revert so the action
  // itself runs from the same state. This isolates interest from any accounting residual.
  const controlInterest = async (label, taNow, nextTs) => {
    const snap = await rpc(local, "evm_snapshot", []);
    await setNextTs(local, nextTs);
    await rpc(local, "anvil_mine", ["0x1"]);
    const taNext = await readUint(local, WRAPPER, "totalAssets");
    const reverted = await rpc(local, "evm_revert", [snap]);
    return {
      label,
      taNextWei: taNext === null ? null : taNext.toString(),
      controlInterestWei: (taNext === null || taNow === null) ? null : (taNext - taNow).toString(),
      revertOk: Boolean(reverted),
    };
  };

  const blockQ = num(await rpc(local, "eth_blockNumber", []));
  const tsQ = num((await rpc(local, "eth_getBlockByNumber", [quantity(blockQ), false])).timestamp);
  const pre = {
    block: blockQ, timestamp: tsQ,
    eoaWsteth: await wstBal(), eoaShares: await wrapBal(),
    wrapperTa: await taOf(WRAPPER), wrapperTs: await tsOf(WRAPPER),
    interTa: await taOf(INTERMEDIATE), interTs: await tsOf(INTERMEDIATE),
    ewethTa: await taOf(EWETH), ewethTs: await tsOf(EWETH),
    wrapperConvert: await readUint(local, WRAPPER, "convertToAssets", [ONE]),
    maxDeposit: await readUint(local, WRAPPER, "maxDeposit", [EOA]),
  };

  const ctrlDep = await controlInterest("deposit", pre.wrapperTa, tsQ + 12);
  if (num(await rpc(local, "eth_blockNumber", [])) !== blockQ) { out.verdict = "INCONCLUSIVE_SNAPSHOT_REVERT_FAILED"; return out; }

  stage = "1D_DEPOSIT";
  await setNextTs(local, tsQ + 12);
  const dep = await sendTx(local, { from: EOA, to: WRAPPER, data: IFACE.v4626.encodeFunctionData("deposit", [FUND_WSTETH, EOA]), gas: quantity(2000000), gasPrice: quantity(2n * 10n ** 9n) });
  const depEvents = dep.receipt ? decodeReceiptEvents(dep.receipt, [WRAPPER, WSTETH]) : [];
  out.attempts.push({ step: "deposit", status: dep.receipt ? dep.receipt.status : null, gasUsed: dep.receipt ? String(num(dep.receipt.gasUsed)) : null, events: depEvents });
  if (!dep.receipt || dep.receipt.status !== "0x1") { out.verdict = "INCONCLUSIVE_WRAPPER_DEPOSIT_BLOCKED"; return out; }
  const afterDep = {
    block: num(await rpc(local, "eth_blockNumber", [])),
    eoaWsteth: await wstBal(), eoaShares: await wrapBal(),
    wrapperTa: await taOf(WRAPPER), wrapperTs: await tsOf(WRAPPER),
    interTa: await taOf(INTERMEDIATE), interTs: await tsOf(INTERMEDIATE),
    ewethTa: await taOf(EWETH), ewethTs: await tsOf(EWETH),
    wrapperConvert: await readUint(local, WRAPPER, "convertToAssets", [ONE]),
  };
  const sharesMinted = afterDep.eoaShares - pre.eoaShares;
  const assetsIn = pre.eoaWsteth - afterDep.eoaWsteth;
  const ctrlDepWei = BigInt(ctrlDep.controlInterestWei || "0");
  const expectedDep = pre.wrapperTa + assetsIn + ctrlDepWei;
  const residualDep = afterDep.wrapperTa - expectedDep;

  stage = "1D_WITHDRAW";
  const blockQ1 = afterDep.block;
  const tsQ1 = num((await rpc(local, "eth_getBlockByNumber", [quantity(blockQ1), false])).timestamp);
  const ctrlWd = await controlInterest("withdraw", afterDep.wrapperTa, tsQ1 + 12);
  if (num(await rpc(local, "eth_blockNumber", [])) !== blockQ1) { out.verdict = "INCONCLUSIVE_SNAPSHOT_REVERT_FAILED"; return out; }
  await setNextTs(local, tsQ1 + 12);
  const wd = await sendTx(local, { from: EOA, to: WRAPPER, data: IFACE.v4626.encodeFunctionData("withdraw", [FUND_WSTETH, EOA, EOA]), gas: quantity(2000000), gasPrice: quantity(2n * 10n ** 9n) });
  const wdEvents = wd.receipt ? decodeReceiptEvents(wd.receipt, [WRAPPER, WSTETH]) : [];
  out.attempts.push({ step: "withdraw", status: wd.receipt ? wd.receipt.status : null, gasUsed: wd.receipt ? String(num(wd.receipt.gasUsed)) : null, events: wdEvents });
  if (!wd.receipt || wd.receipt.status !== "0x1") { out.verdict = "INCONCLUSIVE_WRAPPER_WITHDRAW_BLOCKED"; return out; }
  const afterWd = {
    block: num(await rpc(local, "eth_blockNumber", [])),
    eoaWsteth: await wstBal(), eoaShares: await wrapBal(),
    wrapperTa: await taOf(WRAPPER), wrapperTs: await tsOf(WRAPPER),
    interTa: await taOf(INTERMEDIATE), interTs: await tsOf(INTERMEDIATE),
    ewethTa: await taOf(EWETH), ewethTs: await tsOf(EWETH),
    wrapperConvert: await readUint(local, WRAPPER, "convertToAssets", [ONE]),
  };
  const assetsOut = afterWd.eoaWsteth - afterDep.eoaWsteth;
  const sharesBurned = afterDep.eoaShares - afterWd.eoaShares;
  const ctrlWdWei = BigInt(ctrlWd.controlInterestWei || "0");
  const expectedWd = afterDep.wrapperTa + ctrlWdWei - assetsOut;
  const residualWd = afterWd.wrapperTa - expectedWd;

  let redeemed = null;
  if (afterWd.eoaShares > 0n) {
    stage = "1D_REDEEM";
    const rd = await sendTx(local, { from: EOA, to: WRAPPER, data: IFACE.v4626.encodeFunctionData("redeem", [afterWd.eoaShares, EOA, EOA]), gas: quantity(2000000), gasPrice: quantity(2n * 10n ** 9n) });
    if (rd.receipt && rd.receipt.status === "0x1") {
      const finalWsteth = await wstBal();
      redeemed = {
        shares: afterWd.eoaShares.toString(),
        assetsWei: (finalWsteth - afterWd.eoaWsteth).toString(),
        finalShares: ((await wrapBal()) ?? 0n).toString(),
        finalWrapperTa: ((await taOf(WRAPPER)) ?? 0n).toString(),
        finalWrapperTs: ((await tsOf(WRAPPER)) ?? 0n).toString(),
        finalEoaWsteth: finalWsteth.toString(),
      };
    } else {
      redeemed = { reverted: true };
    }
  }

  const dWrapperTaDep = afterDep.wrapperTa - pre.wrapperTa;
  const dWrapperTaWd = afterWd.wrapperTa - afterDep.wrapperTa;
  const dWrapperTsDep = afterDep.wrapperTs - pre.wrapperTs;
  const dWrapperTsWd = afterWd.wrapperTs - afterDep.wrapperTs;
  const interPlDep = afterDep.interTa - pre.interTa;
  const ewethPlDep = afterDep.ewethTa - pre.ewethTa;
  const interPlWd = afterWd.interTa - afterDep.interTa;
  const finalNet = redeemed && !redeemed.reverted ? (BigInt(redeemed.finalEoaWsteth) - pre.eoaWsteth) : (afterWd.eoaWsteth - pre.eoaWsteth);

  const sOf = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === null ? null : v.toString()]));
  out.ledger = {
    pre: sOf(pre), afterDeposit: sOf(afterDep), afterWithdraw: sOf(afterWd),
    assetsInWei: assetsIn.toString(),
    assetsOutWei: assetsOut.toString(),
    sharesMinted: sharesMinted.toString(),
    sharesBurned: sharesBurned.toString(),
    deltaWrapperTotalAssets_deposit: dWrapperTaDep.toString(),
    deltaWrapperTotalAssets_withdraw: dWrapperTaWd.toString(),
    deltaWrapperTotalSupply_deposit: dWrapperTsDep.toString(),
    deltaWrapperTotalSupply_withdraw: dWrapperTsWd.toString(),
    controlInterest_depositWei: ctrlDep.controlInterestWei,
    controlInterest_withdrawWei: ctrlWd.controlInterestWei,
    expectedWrapperTotalAssetsAfterDepositWei: expectedDep.toString(),
    residual_depositWei: residualDep.toString(),
    expectedWrapperTotalAssetsAfterWithdrawWei: expectedWd.toString(),
    residual_withdrawWei: residualWd.toString(),
    intermediatePl_depositWei: interPlDep.toString(),
    ewethPl_depositWei: ewethPlDep.toString(),
    intermediatePl_withdrawWei: interPlWd.toString(),
    wrapperSharePricePrePer1e18: pre.wrapperConvert === null ? null : pre.wrapperConvert.toString(),
    wrapperSharePricePostDepPer1e18: afterDep.wrapperConvert === null ? null : afterDep.wrapperConvert.toString(),
    wrapperSharePricePostWdPer1e18: afterWd.wrapperConvert === null ? null : afterWd.wrapperConvert.toString(),
    roundtripNetAfterRedeemWei: finalNet.toString(),
    redeemed,
    precisionFloorWei: UNIT_SCALE_TARGET.toString(),
    attribution: "residual = wrapper totalAssets change minus (supplied/returned assets + a control-measured natural per-block Aave interest accrual at the identical block number and timestamp)",
  };

  const row = (measure, valueWei, attributedWei, residualWei) => out.rows.push({
    pin: backing.pin, pinHash: backing.pinHash, measure,
    valueWei: valueWei === null ? null : valueWei.toString(),
    attributedWei: attributedWei === null ? null : attributedWei.toString(),
    residualWei: residualWei === null ? null : residualWei.toString(),
    residualAbovePrecisionFloor: residualWei !== null && (residualWei < 0n ? -residualWei : residualWei) >= UNIT_SCALE_TARGET,
  });
  row("deposit.assetsIn", assetsIn, FUND_WSTETH, assetsIn - FUND_WSTETH);
  row("deposit.wrapperTotalAssetsDelta", dWrapperTaDep, assetsIn + ctrlDepWei, residualDep);
  row("withdraw.assetsOut", assetsOut, FUND_WSTETH, assetsOut - FUND_WSTETH);
  row("withdraw.wrapperTotalAssetsDelta", dWrapperTaWd, -assetsOut + ctrlWdWei, residualWd);
  row("shares.minted", sharesMinted, dWrapperTsDep, sharesMinted - dWrapperTsDep);
  row("shares.burned", sharesBurned, -dWrapperTsWd, sharesBurned + dWrapperTsWd);
  row("shares.mintedMinusBurned", sharesMinted - sharesBurned, 0n, sharesMinted - sharesBurned);
  row("roundtrip.wstethNetAfterRedeem", finalNet, 0n, finalNet);
  row("intermediate.PL_deposit", interPlDep, 0n, interPlDep);
  row("eweth.PL_deposit", ewethPlDep, 0n, ewethPlDep);

  const redeemShares = redeemed && !redeemed.reverted ? BigInt(redeemed.shares) : 0n;
  const exceedsFloor = (r) => (r < 0n ? -r : r) >= UNIT_SCALE_TARGET;
  const residualMaterialDep = exceedsFloor(residualDep);
  const residualMaterialWd = exceedsFloor(residualWd);
  const failures = [];
  if (assetsIn !== FUND_WSTETH) failures.push("assetsIn != 10 wstETH");
  if (sharesMinted === 0n) failures.push("zero shares minted");
  if (residualMaterialDep) failures.push("unattributed wrapper totalAssets delta on deposit exceeds precision floor");
  if (residualMaterialWd) failures.push("unattributed wrapper totalAssets delta on withdraw exceeds precision floor");
  if (sharesBurned + redeemShares !== sharesMinted) failures.push("shares not fully accounted");

  out.failures = failures;
  out.residualNotes = {
    deposit: residualDep === 0n ? "exactly attributed (0 wei)" : residualDep + " wei (below 1e14 floor: ERC-4626/index rounding)",
    withdraw: residualWd === 0n ? "exactly attributed (0 wei)" : residualWd + " wei (below 1e14 floor: ERC-4626/index rounding)",
  };
  if (failures.length > 0) out.verdict = "FAIL_UNATTRIBUTED_DELTA";
  else if (residualDep !== 0n || residualWd !== 0n) out.verdict = "PASS_WITHIN_PRECISION_FLOOR";
  else out.verdict = "PASS_INTEREST_ATTRIBUTED";
  return out;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function run() {
  if (!fs.existsSync(ANVIL)) fail("ANVIL_MISSING");
  const artifacts = {
    schema: "twyne-wrapper-accounting-step2/v1",
    generatedAt: new Date().toISOString(),
    chainId: CHAIN_ID,
    addresses: {
      wstETH: WSTETH, wrapper: WRAPPER, wrapperImpl: WRAPPER_IMPL,
      intermediate: INTERMEDIATE, eweth: EWETH, ewethAsset: EWETH_ASSET,
    },
    pinHint: PIN_HINT,
    relayOnly: true,
    endpointProcessOnly: true,
    endpointSource: "rpc_endpoints.txt",
    endpointMaterialLogged: false,
    readonly: true,
    signedActionJustified: false,
    build: {
      attempted: false,
      reason: "no local contract deployment required: every probe targets live bytecode via fork/archive reads; targets/twyne-contracts-v1 was not built (would write out/ into the checkout)",
      policy: "report INCONCLUSIVE_BUILD_BLOCKED only if a build is actually required and fails",
    },
    stages: {},
  };
  live.push(artifacts);
  process.stdout.write("endpoint: rpc_endpoints.txt, path-only\n");

  const runStage = async (name, fn) => {
    try { artifacts.stages[name] = { stage: name, ...(await fn()) }; }
    catch (e) {
      const reason = e?.code && CODES.has(e.code) ? e.code : `${stage}_INTERNAL_OR_RELAY_FAILURE`;
      if (reason === "DEADLINE_EXCEEDED") throw e;
      artifacts.stages[name] = { stage: name, verdict: "FAIL_CLOSED", reason };
    }
  };

  stage = "1A";
  await runStage("a-1a", () => forkSession("1a", stage1a));
  stage = "1B";
  await runStage("a-1b", archiveStage1b);
  stage = "1C";
  await runStage("a-1c", () => forkSession("1c", stage1c));
  stage = "1D";
  await runStage("a-1d", () => forkSession("1d", stage1d));

  const s = artifacts.stages;
  const hardFail = [s["a-1c"], s["a-1d"]].some((x) => x && String(x.verdict || "").startsWith("FAIL"));
  const closed = Object.values(s).some((x) => x && x.verdict === "FAIL_CLOSED");
  artifacts.overallVerdict = hardFail ? "FAIL_ACCOUNTING_INVARIANT" : closed ? "FAIL_CLOSED" : "PASS_OR_INCONCLUSIVE";
  artifacts.completedAt = new Date().toISOString();
  return artifacts;
}

function writeResult(result) {
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(result, null, 2) + "\n", "utf8");
}

function summary(result) {
  const s = result.stages || {};
  return {
    overallVerdict: result.overallVerdict,
    stages: Object.fromEntries(Object.entries(s).map(([k, v]) => [k, (v && v.verdict) || null])),
    pins: Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v && v.pin ? { pin: v.pin, hash: v.pinHash } : null])),
    oneD: s["a-1d"] ? { residuals: { deposit: s["a-1d"].ledger?.residual_depositWei, withdraw: s["a-1d"].ledger?.residual_withdrawWei }, netAfterRedeemWei: s["a-1d"].ledger?.roundtripNetAfterRedeemWei } : null,
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
    if (process.env.TWYNE_STEP2_DEBUG === "1" && !CODES.has(error?.message)) process.stderr.write(`[debug] ${error && error.stack ? error.stack : String(error)}\n`);
    const closed = {
      schema: "twyne-wrapper-accounting-step2/v1", state: "FAIL_CLOSED", reason,
      generatedAt: new Date().toISOString(), chainId: CHAIN_ID,
      relayOnly: true, endpointProcessOnly: true, endpointSource: "rpc_endpoints.txt", endpointMaterialLogged: false,
      readonly: true, signedActionJustified: false,
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
