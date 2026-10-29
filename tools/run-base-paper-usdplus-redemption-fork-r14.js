"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { Interface, ZeroAddress } = require("ethers");
const { requestJSON } = require("./run-base-redemption-paper-state-r1");
const { readCandidates } = require("./run-base-paper-usdplus-exit-r13");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.join(ROOT, "reports/raw/fast/base-paper-usdplus-r14");
const OUTPUT_FILE = path.join(OUTPUT_DIR, "redemption-fork.json");
const PIN = Object.freeze({
  number: "50931239",
  hash: "0xf1893e48b4751c9fdd5c40f2eb7425ac8d6d4a489e56c421edb2c7144bfb4511",
  parentHash: "0xfe809fc6d11ca5b66f4e3f0e6c1cea64fc4f570d36751f37071d0a446811fa79",
  stateRoot: "0x59a3079ab1c1f1ee381bb73d2a924a5504818bc4393b34ca170befa8b947edf3",
  timestamp: "1788651825",
});
const ADDRESS = Object.freeze({
  actor: "0x000000000000000000000000000000000000b0b0",
  exchange: "0x7cb1b38591021309c64f451859d79312d8ca2789",
  manager: "0x27b12f3282f1d02682d7d1ad30e45e818b78f7b8",
  cash: "0x687ac878bc93610366b705c385cd0a0038493dbb",
  usdPlus: "0xb79dd08ea68a908a97220c76d19a6aa9cbde4376",
  usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  aToken: "0x4e65fe4dba92790696d040ac24aa414708f5c0ab",
  aaveProvider: "0xe20fcbdbffc4dd138ce8b2e6fbb6cb49777ad64d",
  aavePool: "0xa238dd80c259a72e81d7e4664a9801593f98d1c5",
  aaveImplementation: "0xa4abc5fcba6d0d7e3d144d6dbf6cb6128599dfdb",
});
const SIZES = Object.freeze([1_000_000n, 100_000_000n]);
const LIMITS = Object.freeze({ candidates: 8, qualificationRequests: 40, localRequests: 220, relayRequests: 2400,
  requestBytes: 8 * 1024 * 1024, qualificationBytes: 16 * 1024 * 1024, localBytes: 48 * 1024 * 1024,
  relayBytes: 384 * 1024 * 1024, requestMs: 10000, startupMs: 45000, totalMs: 360000 });
const UPSTREAM_METHODS = new Set(["eth_chainId", "eth_gasPrice", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getBlockReceipts",
  "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getBalance", "eth_getTransactionCount", "eth_getCode", "eth_getStorageAt", "eth_getProof"]);
const ARTIFACTS = Object.freeze({
  "reports/raw/fast/base-paper-usdplus-r11/build-manifest.json": "84bc2eb07fb48bb703c9316a27a71c4b5bb4cd52e2db3fd67cd6300b0e75a4e5",
  "reports/raw/fast/base-paper-usdplus-r11/exchange-proxy.compiled.json": "984b9e89e4300255fe64d8bfed84f90baba24265c7a2ada3e7ac0f9508fdfa00",
  "reports/raw/fast/base-paper-usdplus-r11/exchange-implementation.compiled.json": "360989e356dd09b1aa43bf6091ab84743fb50f05de33917bb3d9759a2c43aa01",
  "reports/raw/fast/base-paper-usdplus-r11/manager-proxy.compiled.json": "511c86232ccf15fc4d6c3a919b5e2538ab19d7c133334a08bc9effce3d2a9f0d",
  "reports/raw/fast/base-paper-usdplus-r11/manager-implementation.compiled.json": "668e55e486eac52cb49dc72b1c1110ff69a7d69bae3ea1389f4ed59bd74099a2",
  "reports/raw/fast/base-paper-usdplus-r11/cash-proxy.compiled.json": "6113171151c66fb7314b68d2062935cd53cf09ba023e3001ae1562856483bcc3",
  "reports/raw/fast/base-paper-usdplus-r12/source-build.json": "4205b78a2e67d462e32564f426ff9a57c7e7427b8b44f546b4f32f03b316fb1a",
  "reports/raw/fast/base-paper-usdplus-r12/cash.compiled.json": "d978644070d862779b7e2beae22a9b7baa30c6af37622564569c42713c50b7c8",
  "reports/raw/fast/base-paper-usdplus-r13/active-token-exact-build.json": "7b782f931221f1ac4441cbb95c4727ef05abb7e77b475bd33e595407419f9a6a",
  "reports/raw/fast/base-paper-usdplus-r13/active-token.compiled.json": "6e4b94fafb553cd9095d7c31979628270896688a13902f65e86867e32b67165d",
  "reports/raw/fast/base-paper-usdplus-r13/role.compiled.json": "3b6e0b5fe94882b1e3bcf59d9423cb389ec0180e8be4f155cc4ffe6a96b9b4dc",
  "reports/raw/fast/base-paper-usdplus-r13/aave/core-refresh.json": "6ef24802be5570a6f3e21b2e4a54a36c5dfb21c3e541f8760b1858ee55a9552d",
  "reports/raw/fast/base-paper-usdplus-r13/aave/active/linked-build.json": "8a540bf5f8bca304cd0d5065fa80b081c067b2e71d1d2d852c1ee21a7e92c7fa",
  "reports/raw/fast/base-paper-usdplus-r13/aave/active/withdrawal-compiled.json": "fe573d41693023d75ca86b408f037caabb6ce2e77e0be230d3e7759af6012d4a",
  "reports/raw/fast/base-paper-usdplus-r13/aave/active/withdrawal-state.json": "b7029265b9ed6a44aedcb26b4f0ea3b3b10e1416211ad4e2c85575fa259c7be7",
});

class R14Error extends Error {
  constructor(code, stage, access = false) { super(code); this.code = code; this.stage = stage; this.access = access; }
}
const fail = (code, stage, access = false) => { throw new R14Error(code, stage, access); };
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hexQuantity = value => `0x${BigInt(value).toString(16)}`;
const normalizeAddress = value => String(value || "").toLowerCase();
const SCHEMA = "base-paper-usdplus-redemption-fork/v14";
function runnerProvenance(readFile = fs.readFileSync) {
  return { runner: "tools/run-base-paper-usdplus-redemption-fork-r14.js", runnerSha256: sha(readFile(__filename)), schema: SCHEMA, version: 14 };
}

function parseCli(argv) {
  if (!Array.isArray(argv) || argv.length !== 1 || argv[0] !== "--run-once") fail("EXPLICIT_RUN_ONCE_REQUIRED", "CLI");
  return { runOnce: true };
}

function assertLocalhostUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch (_) { fail("LOCALHOST_ENDPOINT_REQUIRED", "LOCAL_ENDPOINT"); }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(host) || parsed.username || parsed.password || parsed.hash || (parsed.pathname !== "/" && parsed.pathname !== "")) fail("LOCALHOST_ENDPOINT_REQUIRED", "LOCAL_ENDPOINT");
  return parsed;
}

function statIdentity(stat) { return { size: stat.size, dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs }; }
function artifactPreflight(options = {}) {
  const root = options.root || ROOT, specs = options.specs || ARTIFACTS, readFile = options.readFile || fs.readFileSync, lstat = options.lstat || fs.lstatSync;
  const snapshot = {};
  for (const [relative, expected] of Object.entries(specs)) {
    let stat, bytes;
    try { stat = lstat(path.join(root, relative)); bytes = readFile(path.join(root, relative)); } catch (_) { fail("REQUIRED_ARTIFACT_MISSING", "ARTIFACT_PREFLIGHT"); }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== bytes.length || stat.size > 64 * 1024 * 1024 || sha(bytes) !== expected) fail("REQUIRED_ARTIFACT_MISMATCH", "ARTIFACT_PREFLIGHT");
    snapshot[relative] = { ...statIdentity(stat), sha256: expected };
  }
  const json = relative => JSON.parse(readFile(path.join(root, relative), "utf8"));
  let core, aave, linked, tokenBuild, cashBuild, build11;
  try {
    core = json("reports/raw/fast/base-paper-usdplus-r13/aave/core-refresh.json");
    aave = json("reports/raw/fast/base-paper-usdplus-r13/aave/active/withdrawal-state.json");
    linked = json("reports/raw/fast/base-paper-usdplus-r13/aave/active/linked-build.json");
    tokenBuild = json("reports/raw/fast/base-paper-usdplus-r13/active-token-exact-build.json");
    cashBuild = json("reports/raw/fast/base-paper-usdplus-r12/source-build.json");
    build11 = json("reports/raw/fast/base-paper-usdplus-r11/build-manifest.json");
  } catch (_) { fail("REQUIRED_ARTIFACT_JSON_INVALID", "ARTIFACT_PREFLIGHT"); }
  if (core.status !== "TOKEN_CORE_GUARDS_CLEAR_AAVE_BINDING_REQUIRED" || !same(core.observation?.pin, PIN)
    || aave.status !== "AAVE_WITHDRAWAL_LIBRARIES_BOUND_EXTERNAL_CALLS_UNPROVEN" || !same(aave.observation?.pin, PIN)
    || linked.status !== "ACTIVE_AAVE_LINKED_EXACT_POOL_MATCH" || linked.implementation !== ADDRESS.aaveImplementation
    || tokenBuild.status !== "OFFICIAL_ACTIVE_TOKEN_REBUILT" || cashBuild.status !== "OFFICIAL_CASH_SOURCE_REBUILT_CHAIN_BINDING_REQUIRED"
    || build11.status !== "RECOVERED_CONTRACTS_REBUILT_EXACT_EXPLORER_MATCH") fail("R11_R13_DEPENDENCY_OR_PIN_MISMATCH", "ARTIFACT_PREFLIGHT");
  const load = relative => json(relative);
  return { root, specs, snapshot, bindings: {
    exchange: load("reports/raw/fast/base-paper-usdplus-r11/exchange-implementation.compiled.json"),
    manager: load("reports/raw/fast/base-paper-usdplus-r11/manager-implementation.compiled.json"),
    cash: load("reports/raw/fast/base-paper-usdplus-r12/cash.compiled.json"),
    token: load("reports/raw/fast/base-paper-usdplus-r13/active-token.compiled.json"),
    aave: load("reports/raw/fast/base-paper-usdplus-r13/aave/active/withdrawal-compiled.json"),
  } };
}

function assertArtifactsUnchanged(preflight, options = {}) {
  const readFile = options.readFile || fs.readFileSync, lstat = options.lstat || fs.lstatSync;
  for (const [relative, before] of Object.entries(preflight.snapshot)) {
    let stat, bytes;
    try { stat = lstat(path.join(preflight.root, relative)); bytes = readFile(path.join(preflight.root, relative)); } catch (_) { fail("ARTIFACT_CHANGED_DURING_RUN", "ARTIFACT_IMMUTABILITY"); }
    if (!same(statIdentity(stat), { size: before.size, dev: before.dev, ino: before.ino, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs }) || sha(bytes) !== before.sha256) fail("ARTIFACT_CHANGED_DURING_RUN", "ARTIFACT_IMMUTABILITY");
  }
}

function outputIsSanitized(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return !/(?:https?|wss?):\/\/|authorization|api[-_]?key|bearer\s|token=|rpc_endpoints\.txt/i.test(text);
}

async function qualifyArchive(options = {}) {
  const candidates = options.candidates || readCandidates(), transport = options.transport || requestJSON, now = options.now || Date.now;
  if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > LIMITS.candidates) fail("ARCHIVE_CANDIDATE_POOL_UNAVAILABLE", "ARCHIVE_QUALIFICATION", true);
  const started = now(), stats = { attempted: 0, qualified: 0, requests: 0, bytes: 0, failures: {} }, qualified = [];
  const rpc = async (candidate, method, params) => {
    if (!UPSTREAM_METHODS.has(method) || ++stats.requests > LIMITS.qualificationRequests || now() - started > 90000) fail("QUALIFICATION_BUDGET_EXHAUSTED", "ARCHIVE_QUALIFICATION", true);
    let response;
    try { response = await transport(candidate.url, { jsonrpc: "2.0", id: stats.requests, method, params }, LIMITS.requestMs); } catch (_) { fail("QUALIFICATION_TRANSPORT_UNAVAILABLE", "ARCHIVE_QUALIFICATION", true); }
    if (!response || !Number.isSafeInteger(response.bytes) || response.bytes < 0 || response.bytes > LIMITS.requestBytes) fail("QUALIFICATION_RESPONSE_CAP", "ARCHIVE_QUALIFICATION", true);
    stats.bytes += response.bytes; if (stats.bytes > LIMITS.qualificationBytes) fail("QUALIFICATION_BYTE_BUDGET_EXHAUSTED", "ARCHIVE_QUALIFICATION", true);
    if (response.value?.jsonrpc !== "2.0" || response.value.id !== stats.requests || response.value.error || !Object.hasOwn(response.value, "result")) fail("QUALIFICATION_RPC_UNAVAILABLE", "ARCHIVE_QUALIFICATION", true);
    return response.value.result;
  };
  for (const candidate of candidates) {
    stats.attempted++;
    try {
      if (await rpc(candidate, "eth_chainId", []) !== "0x2105") fail("CHAIN_MISMATCH", "ARCHIVE_QUALIFICATION", true);
      const header = await rpc(candidate, "eth_getBlockByNumber", [hexQuantity(PIN.number), false]);
      if (BigInt(header?.number || -1) !== BigInt(PIN.number) || normalizeAddress(header?.hash) !== PIN.hash || normalizeAddress(header?.stateRoot) !== PIN.stateRoot) fail("R13_PIN_UNAVAILABLE", "ARCHIVE_QUALIFICATION", true);
      const code = await rpc(candidate, "eth_getCode", [ADDRESS.exchange, hexQuantity(PIN.number)]);
      if (!/^0x[0-9a-f]+$/i.test(code || "") || code === "0x") fail("ARCHIVE_CODE_UNAVAILABLE", "ARCHIVE_QUALIFICATION", true);
      const proof = await rpc(candidate, "eth_getProof", [ADDRESS.usdPlus, [], hexQuantity(PIN.number)]);
      if (normalizeAddress(proof?.address) !== ADDRESS.usdPlus || !/^0x[0-9a-f]{64}$/i.test(proof?.storageHash || "")) fail("ARCHIVE_PROOF_UNAVAILABLE", "ARCHIVE_QUALIFICATION", true);
      qualified.push(candidate); stats.qualified++;
    } catch (error) {
      const code = error instanceof R14Error ? error.code : "QUALIFICATION_FAILURE";
      stats.failures[code] = (stats.failures[code] || 0) + 1;
      if (/BUDGET/.test(code)) throw error;
    }
  }
  if (!qualified.length) {
    const error = new R14Error("ARCHIVE_FORK_CAPABILITY_UNAVAILABLE", "ARCHIVE_QUALIFICATION", true);
    error.qualificationStats = structuredClone(stats); throw error;
  }
  return { selected: qualified[0], stats };
}

function forbiddenRelayMethod(method) {
  return /^(?:eth_send|eth_sign|eth_accounts|eth_coinbase|personal_|wallet_|account|admin_|anvil_|evm_|debug_|trace_|engine_|miner_|txpool_)/i.test(method);
}

async function createReadOnlyRelay(options) {
  const started = Date.now(); let requests = 0, bytes = 0, denied = 0, active = 0; const methods = {};
  const forwardOne = async row => {
    const id = Object.hasOwn(row || {}, "id") ? row.id : null, method = typeof row?.method === "string" ? row.method : "";
    if (forbiddenRelayMethod(method) || !UPSTREAM_METHODS.has(method)) { denied++; methods.DENIED = (methods.DENIED || 0) + 1; return { jsonrpc: "2.0", id, error: { code: -32601, message: "method-not-allowed" } }; }
    if (++requests > LIMITS.relayRequests || Date.now() - started > LIMITS.totalMs || active >= 8) { methods.BUDGET = (methods.BUDGET || 0) + 1; return { jsonrpc: "2.0", id, error: { code: -32000, message: "relay-budget-exhausted" } }; }
    active++;
    try {
      const response = await options.transport(options.candidate.url, { jsonrpc: "2.0", id, method, params: Array.isArray(row.params) ? row.params : [] }, LIMITS.requestMs);
      if (!response || !Number.isSafeInteger(response.bytes) || response.bytes < 0 || response.bytes > LIMITS.requestBytes || (bytes += response.bytes) > LIMITS.relayBytes
        || response.value?.jsonrpc !== "2.0" || response.value.id !== id) throw new Error("upstream-read-failure");
      methods[method] = (methods[method] || 0) + 1; return response.value;
    } catch (_) { return { jsonrpc: "2.0", id, error: { code: -32000, message: "upstream-read-failure" } }; }
    finally { active--; }
  };
  const server = http.createServer((request, response) => {
    if (request.method !== "POST" || request.socket.remoteAddress && !request.socket.remoteAddress.includes("127.0.0.1") && request.socket.remoteAddress !== "::1") { response.writeHead(403).end(); return; }
    let size = 0; const chunks = []; request.setTimeout(LIMITS.requestMs, () => request.destroy());
    request.on("data", chunk => { size += chunk.length; if (size <= 1024 * 1024) chunks.push(chunk); else request.destroy(); });
    request.on("end", async () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")), rows = Array.isArray(parsed) ? parsed : [parsed];
        if (!rows.length || rows.length > 64) throw new Error("invalid");
        const results = await Promise.all(rows.map(forwardOne)), payload = Buffer.from(JSON.stringify(Array.isArray(parsed) ? results : results[0]));
        if (payload.length > LIMITS.requestBytes) throw new Error("large");
        response.writeHead(200, { "content-type": "application/json" }); response.end(payload);
      } catch (_) { response.writeHead(400, { "content-type": "application/json" }); response.end('{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"invalid-request"}}'); }
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const close = () => new Promise((resolve, reject) => {
    let settled = false;
    const finish = error => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(); };
    const timer = setTimeout(() => { server.closeAllConnections?.(); finish(new R14Error("RELAY_CLOSE_UNCONFIRMED", "RELAY_CLEANUP")); }, 1500);
    server.close(error => finish(error ? new R14Error("RELAY_CLOSE_FAILED", "RELAY_CLEANUP") : null));
  });
  return { port: server.address().port, stats: () => ({ forwarded: requests, bytes, denied, methods: { ...methods } }), close };
}

function sanitizedChildEnvironment(environment = process.env) {
  const result = {};
  for (const key of ["Path", "PATH", "SystemRoot", "WINDIR"]) if (typeof environment[key] === "string" && environment[key] && !/:\/\//.test(environment[key])) result[key] = environment[key];
  result.TEMP = path.join(os.tmpdir(), "opencode"); result.TMP = result.TEMP; return result;
}
function buildAnvilArgs(relayPort, localPort) {
  const relay = `http://127.0.0.1:${relayPort}`; assertLocalhostUrl(relay);
  return ["--host", "127.0.0.1", "--port", String(localPort), "--chain-id", "8453", "--accounts", "0", "--auto-impersonate",
    "--fork-url", relay, "--fork-block-number", PIN.number, "--no-storage-caching", "--quiet", "--color", "never"];
}
function freePort() { return new Promise((resolve, reject) => { const server = net.createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolve(port)); }); }); }

function createLocalRpc(port, options = {}) {
  const endpoint = `http://127.0.0.1:${port}`; assertLocalhostUrl(endpoint); let requests = 0, bytes = 0; const started = Date.now();
  const call = async (method, params, timeoutMs = LIMITS.requestMs) => {
    if (++requests > LIMITS.localRequests || Date.now() - started > LIMITS.totalMs) fail("LOCAL_RPC_BUDGET_EXHAUSTED", "LOCAL_RPC");
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(timeoutMs, LIMITS.requestMs)));
    try {
      const response = await (options.fetch || fetch)(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: requests, method, params }), signal: controller.signal, redirect: "error" });
      const buffer = Buffer.from(await response.arrayBuffer()); bytes += buffer.length;
      if (!response.ok || buffer.length > LIMITS.requestBytes || bytes > LIMITS.localBytes) fail("LOCAL_RPC_RESPONSE_BUDGET", "LOCAL_RPC");
      const parsed = JSON.parse(buffer.toString("utf8")); if (parsed.error || parsed.id !== requests || !Object.hasOwn(parsed, "result")) fail("LOCAL_RPC_METHOD_FAILED", "LOCAL_RPC");
      return parsed.result;
    } catch (error) { if (error instanceof R14Error) throw error; fail("LOCAL_RPC_UNAVAILABLE", "LOCAL_RPC"); }
    finally { clearTimeout(timer); }
  };
  return { call, stats: () => ({ requests, bytes }) };
}

async function stopAnvil(child, options = {}) {
  if (!child || child.exitCode != null || child.signalCode != null) return true;
  const waitMs = options.waitMs == null ? 1500 : options.waitMs;
  const waitExit = () => new Promise(resolve => {
    if (child.exitCode != null || child.signalCode != null) { resolve(true); return; }
    let settled = false; const done = () => { if (settled) return; settled = true; clearTimeout(timer); child.removeListener?.("exit", onExit); resolve(true); };
    const onExit = () => done(), timer = setTimeout(() => { if (settled) return; settled = true; child.removeListener?.("exit", onExit); resolve(false); }, waitMs);
    child.once?.("exit", onExit);
  });
  try { child.kill(); } catch (_) { fail("ANVIL_NORMAL_KILL_FAILED", "CHILD_CLEANUP"); }
  if (await waitExit()) return true;
  try { child.kill("SIGKILL"); } catch (_) { fail("ANVIL_FORCED_KILL_FAILED", "CHILD_CLEANUP"); }
  if (await waitExit()) return true;
  fail("ANVIL_EXIT_UNCONFIRMED", "CHILD_CLEANUP");
}

const defaultAnvilAdapter = {
  freePort,
  start: args => new Promise((resolve, reject) => {
    const child = childProcess.spawn("anvil", args, { stdio: "ignore", windowsHide: true, shell: false, env: sanitizedChildEnvironment() });
    child.once("spawn", () => resolve(child)); child.once("error", () => reject(new R14Error("ANVIL_START_FAILED", "ANVIL_START", true)));
  }),
  stop: stopAnvil,
};

async function waitReady(child, rpc, timeoutMs = LIMITS.startupMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child?.exitCode != null || child?.signalCode != null) fail("ANVIL_EXITED_DURING_STARTUP", "ANVIL_START", true);
    try {
      const chain = await rpc.call("eth_chainId", []), block = await rpc.call("eth_getBlockByNumber", [hexQuantity(PIN.number), false]);
      if (chain === "0x2105" && BigInt(block?.number || -1) === BigInt(PIN.number) && normalizeAddress(block.hash) === PIN.hash && normalizeAddress(block.stateRoot) === PIN.stateRoot) return;
      fail("LOCAL_FORK_PIN_MISMATCH", "FORK_PIN", true);
    } catch (error) { if (error instanceof R14Error && error.code === "LOCAL_FORK_PIN_MISMATCH") throw error; }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  fail("ANVIL_STARTUP_TIMEOUT", "ANVIL_START", true);
}

function makeInterfaces(bindings) {
  return {
    exchange: new Interface(bindings.exchange.abi), manager: new Interface(bindings.manager.abi), cash: new Interface(bindings.cash.abi),
    token: new Interface(bindings.token.abi), pool: new Interface(bindings.aave.pool.abi),
    erc20: new Interface(["function balanceOf(address) view returns(uint256)", "function totalSupply() view returns(uint256)", "event Transfer(address indexed from,address indexed to,uint256 value)"]),
    aToken: new Interface(["function balanceOf(address) view returns(uint256)", "function scaledBalanceOf(address) view returns(uint256)", "function totalSupply() view returns(uint256)", "function getIncentivesController() view returns(address)", "event Transfer(address indexed from,address indexed to,uint256 value)"]),
  };
}
async function decodedCall(rpc, to, iface, name, args = []) {
  const raw = await rpc.call("eth_call", [{ to, data: iface.encodeFunctionData(name, args), gas: "0x989680" }, "latest"]);
  try { return iface.decodeFunctionResult(name, raw); } catch (_) { fail("LOCAL_ABI_DECODE_FAILED", "STATE_CAPTURE"); }
}
const scalar = async (...args) => (await decodedCall(...args))[0];

async function captureState(rpc, i) {
  const usdc = {}, holders = [ADDRESS.actor, ADDRESS.cash, ADDRESS.manager, ADDRESS.exchange, ADDRESS.aToken];
  for (const holder of holders) usdc[holder] = (await scalar(rpc, ADDRESS.usdc, i.erc20, "balanceOf", [holder])).toString();
  const reserve = (await decodedCall(rpc, ADDRESS.aavePool, i.pool, "getReserveData", [ADDRESS.usdc]))[0];
  return {
    usdPlus: { actor: (await scalar(rpc, ADDRESS.usdPlus, i.token, "balanceOf", [ADDRESS.actor])).toString(), totalSupply: (await scalar(rpc, ADDRESS.usdPlus, i.token, "totalSupply")).toString() },
    usdc,
    aToken: { cashBalance: (await scalar(rpc, ADDRESS.aToken, i.aToken, "balanceOf", [ADDRESS.cash])).toString(), scaledCashBalance: (await scalar(rpc, ADDRESS.aToken, i.aToken, "scaledBalanceOf", [ADDRESS.cash])).toString(),
      totalSupply: (await scalar(rpc, ADDRESS.aToken, i.aToken, "totalSupply")).toString(), incentivesController: normalizeAddress(await scalar(rpc, ADDRESS.aToken, i.aToken, "getIncentivesController")) },
    reserve: { normalizedIncome: (await scalar(rpc, ADDRESS.aavePool, i.pool, "getReserveNormalizedIncome", [ADDRESS.usdc])).toString(), virtualUnderlying: (await scalar(rpc, ADDRESS.aavePool, i.pool, "getVirtualUnderlyingBalance", [ADDRESS.usdc])).toString(),
      liquidityIndex: reserve.liquidityIndex.toString(), liquidityRate: reserve.currentLiquidityRate.toString(), lastUpdateTimestamp: reserve.lastUpdateTimestamp.toString() },
  };
}

function parseReceiptEvidence(receipt, i) {
  const transfers = [], events = [];
  for (const log of receipt.logs || []) {
    const address = normalizeAddress(log.address); let parsed = null;
    try {
      const iface = address === ADDRESS.exchange ? i.exchange : address === ADDRESS.cash ? i.cash : address === ADDRESS.aavePool ? i.pool : [ADDRESS.usdc, ADDRESS.usdPlus, ADDRESS.aToken].includes(address) ? i.erc20 : null;
      if (iface) parsed = iface.parseLog(log);
    } catch (_) { /* unrelated event */ }
    if (!parsed) continue;
    if (parsed.name === "Transfer") transfers.push({ token: address, from: normalizeAddress(parsed.args[0]), to: normalizeAddress(parsed.args[1]), value: parsed.args[2].toString() });
    else events.push({ address, name: parsed.name });
  }
  return { transfers, events };
}
function traceTargets(trace) {
  const targets = [];
  const visit = node => { if (!node || typeof node !== "object") return; if (typeof node.to === "string") targets.push(normalizeAddress(node.to)); for (const child of node.calls || []) visit(child); };
  visit(trace); return [...new Set(targets)];
}
function hasTransfer(evidence, token, from, to, amount = null) {
  return evidence.transfers.some(row => row.token === token && row.from === from && row.to === to && (amount == null || BigInt(row.value) === BigInt(amount)));
}

function validateRedemptionEvidence(row) {
  const amount = BigInt(row.amountRaw), payout = BigInt(row.expectedPayoutRaw), before = row.before, after = row.after, evidence = row.evidence;
  const check = (condition, stage, code) => { if (!condition) return { ok: false, firstFailure: { stage, code } }; return null; };
  let failure;
  failure = check(hasTransfer(evidence, ADDRESS.usdc, ADDRESS.manager, ADDRESS.exchange, payout), "PORTFOLIO_MANAGER_WITHDRAWAL", "MANAGER_TO_EXCHANGE_TRANSFER_MISSING"); if (failure) return failure;
  failure = check(hasTransfer(evidence, ADDRESS.usdc, ADDRESS.cash, ADDRESS.manager, payout) && evidence.events.some(event => event.address === ADDRESS.cash && event.name === "Unstake"), "STRATEGY_AAVE_WITHDRAWAL", "STRATEGY_UNSTAKE_EVIDENCE_MISSING"); if (failure) return failure;
  failure = check(hasTransfer(evidence, ADDRESS.usdc, ADDRESS.aToken, ADDRESS.cash, payout) && BigInt(before.usdc[ADDRESS.aToken]) - BigInt(after.usdc[ADDRESS.aToken]) === payout
    && BigInt(before.aToken.cashBalance) > BigInt(after.aToken.cashBalance) && BigInt(before.aToken.scaledCashBalance) > BigInt(after.aToken.scaledCashBalance), "AAVE_POOL_WITHDRAWAL", "AAVE_UNDERLYING_MOVEMENT_MISMATCH"); if (failure) return failure;
  const controller = before.aToken.incentivesController, rewardOkay = controller === ZeroAddress ? row.rewardHook.legitimateZero === true : row.rewardHook.targets.includes(controller);
  failure = check(hasTransfer(evidence, ADDRESS.aToken, ADDRESS.cash, ZeroAddress) && rewardOkay, "ATOKEN_BURN_REWARD_HOOK", controller === ZeroAddress ? "ATOKEN_BURN_OR_ZERO_REWARD_EVIDENCE_MISSING" : "ATOKEN_BURN_OR_REWARD_HOOK_CALL_MISSING"); if (failure) return failure;
  failure = check(evidence.events.some(event => event.address === ADDRESS.aavePool && event.name === "ReserveDataUpdated") && BigInt(before.reserve.virtualUnderlying) - BigInt(after.reserve.virtualUnderlying) === payout, "AAVE_RESERVE_RATE_UPDATE", "RESERVE_UPDATE_EVIDENCE_MISSING"); if (failure) return failure;
  failure = check(BigInt(before.usdPlus.actor) - BigInt(after.usdPlus.actor) === amount && BigInt(before.usdPlus.totalSupply) - BigInt(after.usdPlus.totalSupply) === amount
    && hasTransfer(evidence, ADDRESS.usdPlus, ADDRESS.actor, ZeroAddress, amount), "EXCHANGE_BURN", "USDPLUS_BURN_MISMATCH"); if (failure) return failure;
  failure = check(BigInt(after.usdc[ADDRESS.actor]) - BigInt(before.usdc[ADDRESS.actor]) === payout && hasTransfer(evidence, ADDRESS.usdc, ADDRESS.exchange, ADDRESS.actor, payout)
    && BigInt(after.usdc[ADDRESS.cash]) === BigInt(before.usdc[ADDRESS.cash]) && BigInt(after.usdc[ADDRESS.manager]) === BigInt(before.usdc[ADDRESS.manager]) && BigInt(after.usdc[ADDRESS.exchange]) === BigInt(before.usdc[ADDRESS.exchange]), "USDC_PAYOUT", "FEE_ADJUSTED_PAYOUT_OR_TEMP_BALANCE_MISMATCH"); if (failure) return failure;
  failure = check(row.rollbackVerified === true, "SNAPSHOT_ROLLBACK", "SNAPSHOT_ROLLBACK_MISMATCH"); if (failure) return failure;
  return { ok: true, firstFailure: null };
}

async function sendLocalTransaction(rpc, from, to, data, stage) {
  try {
    const hash = await rpc.call("eth_sendTransaction", [{ from, to, data, gas: "0xe4e1c0", gasPrice: "0x3b9aca00" }]);
    const receipt = await rpc.call("eth_getTransactionReceipt", [hash]);
    if (!receipt || receipt.status !== "0x1") fail(`${stage}_REVERTED`, stage);
    return receipt;
  } catch (error) { if (error instanceof R14Error && error.stage === stage) throw error; fail(`${stage}_REVERTED`, stage); }
}

async function executeRedemptions(rpc, bindings, hooks = {}) {
  const i = makeInterfaces(bindings), rows = [];
  for (const amount of SIZES) {
    const snapshot = await rpc.call("evm_snapshot", []), pristine = await captureState(rpc, i);
    try {
      await rpc.call("anvil_setBalance", [ADDRESS.actor, "0x56bc75e2d63100000"]);
      await rpc.call("anvil_setBalance", [ADDRESS.exchange, "0x56bc75e2d63100000"]);
      await rpc.call("anvil_impersonateAccount", [ADDRESS.actor]); await rpc.call("anvil_impersonateAccount", [ADDRESS.exchange]);
      const mintData = i.token.encodeFunctionData("mint", [ADDRESS.actor, amount]);
      await sendLocalTransaction(rpc, ADDRESS.exchange, ADDRESS.usdPlus, mintData, "SYNTHETIC_USDPLUS_MINT");
      const before = await captureState(rpc, i);
      if (BigInt(before.usdPlus.actor) - BigInt(pristine.usdPlus.actor) !== amount || BigInt(before.usdPlus.totalSupply) - BigInt(pristine.usdPlus.totalSupply) !== amount) fail("SYNTHETIC_MINT_SUPPLY_RECONCILIATION_FAILED", "SYNTHETIC_USDPLUS_MINT");
      hooks.onSyntheticMinted?.({ amountRaw: amount.toString() });
      const fee = BigInt((await scalar(rpc, ADDRESS.exchange, i.exchange, "redeemFee")).toString()), denominator = BigInt((await scalar(rpc, ADDRESS.exchange, i.exchange, "redeemFeeDenominator")).toString());
      const payout = amount - amount * fee / denominator;
      const receipt = await sendLocalTransaction(rpc, ADDRESS.actor, ADDRESS.exchange, i.exchange.encodeFunctionData("redeem", [ADDRESS.usdc, amount]), "EXCHANGE_REDEEM");
      const after = await captureState(rpc, i), evidence = parseReceiptEvidence(receipt, i);
      let trace; try { trace = await rpc.call("debug_traceTransaction", [receipt.transactionHash, { tracer: "callTracer" }]); } catch (_) { fail("CALL_TRACE_UNAVAILABLE", "ATOKEN_BURN_REWARD_HOOK"); }
      const targets = traceTargets(trace), rewardHook = { controller: before.aToken.incentivesController, targets,
        legitimateZero: before.aToken.incentivesController === ZeroAddress };
      await rpc.call("evm_revert", [snapshot]); const rolledBack = await captureState(rpc, i), rollbackVerified = same(pristine, rolledBack);
      const row = { amountRaw: amount.toString(), expectedPayoutRaw: payout.toString(), before, after, evidence, rewardHook, rollbackVerified };
      const validation = validateRedemptionEvidence(row); row.stageValidation = validation;
      if (!validation.ok) fail(validation.firstFailure.code, validation.firstFailure.stage);
      rows.push(row);
    } catch (error) {
      try { await rpc.call("evm_revert", [snapshot]); } catch (_) { /* cleanup cannot mask first failure */ }
      throw error;
    } finally {
      for (const account of [ADDRESS.actor, ADDRESS.exchange]) try { await rpc.call("anvil_stopImpersonatingAccount", [account]); } catch (_) { /* local cleanup */ }
    }
  }
  return rows;
}

function baseOutput(source = "real-local-fork", provenance = runnerProvenance()) {
  return { schema: SCHEMA, generatedAt: new Date().toISOString(), provenance, classification: "INCOMPLETE / DEPENDENCY_UNCLASSIFIED", firstFailure: null, cleanupFailures: [],
    chainId: 8453, pin: PIN, evidenceSource: source, fullExitVerified: false, routePositive: "unknown", quoteEligible: false, executableNow: "unknown", signedActionJustified: false,
    profitabilityClaim: false, currentQuoteClaim: false, rows: [], qualification: null, relay: null, localRpc: null,
    cleanup: { child: "NOT_STARTED", relay: "NOT_STARTED" },
    safety: { keyless: true, localForkOnly: true, localhostRelay: true, upstreamReadOnly: true, upstreamTransactions: 0, walletFilesRead: false, envFilesRead: false, signing: false, broadcasts: false, retries: 0, syntheticUsdPlusProvisioningConfigured: true, syntheticUsdPlusMintedLocally: false, syntheticUsdcInjected: false } };
}

function exactClassification(error) {
  if (error?.stage === "ARCHIVE_QUALIFICATION" && error?.code === "ARCHIVE_FORK_CAPABILITY_UNAVAILABLE") return "INCOMPLETE / ARCHIVE_FORK_CAPABILITY_UNAVAILABLE";
  return `INCOMPLETE / ${error?.stage || "UNCLASSIFIED"} / ${error?.code || "UNEXPECTED_FAILURE"}`;
}

function cleanupError(error, fallbackStage, fallbackCode) {
  return error instanceof R14Error ? { stage: error.stage, code: error.code } : { stage: fallbackStage, code: fallbackCode };
}

async function runFork(options = {}) {
  const provenance = options.provenance || runnerProvenance(options.runnerReadFile), output = baseOutput(options.mock === true ? "mock" : "real-local-fork", provenance), adapter = options.anvilAdapter || defaultAnvilAdapter;
  let preflight, relay, child, rpc;
  if ((options.outputExists || fs.existsSync)(options.outputFile || OUTPUT_FILE)) fail("OUTPUT_EXISTS_NO_OVERWRITE", "OUTPUT_PREFLIGHT");
  try {
    preflight = options.preflight || artifactPreflight(options.preflightOptions);
    const qualified = options.qualify ? await options.qualify() : await qualifyArchive(options.qualificationOptions); output.qualification = qualified.stats;
    relay = options.relayFactory ? await options.relayFactory(qualified.selected) : await createReadOnlyRelay({ candidate: qualified.selected, transport: options.transport || requestJSON });
    const port = await adapter.freePort(), args = buildAnvilArgs(relay.port, port);
    if (args.some(value => /https|wss|authorization|bearer/i.test(value))) fail("ANVIL_ARG_SECRET_EXPOSURE", "ANVIL_START");
    child = await adapter.start(args); rpc = options.rpcFactory ? options.rpcFactory(port) : createLocalRpc(port);
    await (options.waitReady || waitReady)(child, rpc, options.startupMs);
    const hooks = { onSyntheticMinted: () => { output.safety.syntheticUsdPlusMintedLocally = true; } };
    const work = options.execute ? options.execute(rpc, preflight.bindings, hooks) : executeRedemptions(rpc, preflight.bindings, hooks);
    let timeout;
    try { output.rows = await Promise.race([work, new Promise((_, reject) => { timeout = setTimeout(() => reject(new R14Error("TOTAL_TIMEOUT", "TIME_BUDGET", true)), options.totalMs || LIMITS.totalMs); })]); }
    finally { clearTimeout(timeout); }
    output.classification = options.mock === true ? "MOCK_STAGE_PATH_COMPLETE" : "LOCAL_FORK_FULL_REDEMPTION_VERIFIED_AT_R13_PIN";
    output.fullExitVerified = options.mock === true ? false : true;
  } catch (error) {
    const known = error instanceof R14Error ? error : new R14Error("UNEXPECTED_FAILURE", "UNCLASSIFIED");
    output.firstFailure = { stage: known.stage, code: known.code };
    if (known.qualificationStats) output.qualification = known.qualificationStats;
    output.classification = exactClassification(known);
  } finally {
    if (child) {
      try { await adapter.stop(child); output.cleanup.child = "CONFIRMED"; }
      catch (error) { const failure = cleanupError(error, "CHILD_CLEANUP", "ANVIL_CLEANUP_FAILED"); output.cleanup.child = "FAILED"; output.cleanupFailures.push(failure); }
    }
    if (relay) {
      try { output.relay = relay.stats(); await relay.close(); output.cleanup.relay = "CONFIRMED"; }
      catch (error) { const failure = cleanupError(error, "RELAY_CLEANUP", "RELAY_CLEANUP_FAILED"); output.cleanup.relay = "FAILED"; output.cleanupFailures.push(failure); }
    }
    if (rpc?.stats) output.localRpc = rpc.stats();
    if (output.cleanupFailures.length) {
      output.fullExitVerified = false;
      if (!output.firstFailure) { output.firstFailure = output.cleanupFailures[0]; output.classification = exactClassification(output.firstFailure); }
    }
  }
  if (preflight) assertArtifactsUnchanged(preflight, options.preflightOptions);
  output.completedAt = new Date().toISOString();
  if (!outputIsSanitized(output)) fail("OUTPUT_NOT_SANITIZED", "OUTPUT");
  return output;
}

function writeOnce(output, options = {}) {
  const directory = options.outputDir || OUTPUT_DIR, filename = options.outputFile || OUTPUT_FILE;
  if (fs.existsSync(filename)) fail("OUTPUT_EXISTS_NO_OVERWRITE", "OUTPUT");
  fs.mkdirSync(directory, { recursive: true });
  const encoded = JSON.stringify(output, null, 2) + "\n"; if (!outputIsSanitized(encoded)) fail("OUTPUT_NOT_SANITIZED", "OUTPUT");
  fs.writeFileSync(filename, encoded, { flag: "wx" }); return filename;
}

function validateCorrectionArtifacts(originalBytes, firstCorrectionBytes, correctionV2Bytes, options = {}) {
  let original, firstCorrection, correction;
  try { original = JSON.parse(Buffer.from(originalBytes).toString("utf8")); firstCorrection = JSON.parse(Buffer.from(firstCorrectionBytes).toString("utf8")); correction = JSON.parse(Buffer.from(correctionV2Bytes).toString("utf8")); }
  catch (_) { fail("CORRECTION_JSON_INVALID", "CORRECTION_VALIDATION"); }
  const provenance = runnerProvenance(options.readFile || fs.readFileSync), expectedFailure = { stage: "ARCHIVE_QUALIFICATION", code: "ARCHIVE_FORK_CAPABILITY_UNAVAILABLE" };
  const generatedAt = Date.parse(correction.generatedAt), validationTime = options.now == null ? Date.now() : options.now;
  const canonicalGeneratedAt = Number.isFinite(generatedAt) ? new Date(generatedAt).toISOString() : null;
  const predecessors = Array.isArray(correction.supersedes) ? Object.fromEntries(correction.supersedes.map(row => [row.artifact, row])) : {};
  if (sha(originalBytes) !== "e6beb48c6634d57f5a166cb5c9950b3ae151d1e82f10e9027820daaf30c1b962" || sha(firstCorrectionBytes) !== "144321dc1812c9ac7b552e754c79ffe0c7331eabe1f8b5f182150d48470c069e"
    || correction.schema !== "base-paper-usdplus-redemption-fork-correction-v2/v14" || correction.version !== 14 || correction.canonicalEvidence !== true
    || correction.generatedAt !== canonicalGeneratedAt || !Number.isFinite(validationTime) || generatedAt > validationTime
    || predecessors["redemption-fork.json"]?.sha256 !== sha(originalBytes) || predecessors["redemption-fork.json"]?.canonicalEvidence !== false
    || predecessors["redemption-fork.json"]?.rejectedReason !== "IMPOSSIBLE_SYNTHETIC_MINT_CLAIM_WITH_EXECUTION_NOT_REACHED"
    || predecessors["redemption-fork-correction.json"]?.sha256 !== sha(firstCorrectionBytes) || predecessors["redemption-fork-correction.json"]?.canonicalEvidence !== false
    || predecessors["redemption-fork-correction.json"]?.rejectedReason !== "GENERATED_AT_POSTDATES_ACTUAL_CREATION_AND_IS_NOT_TRUTHFUL_PROVENANCE"
    || correction.firstCorrectionTiming?.claimedGeneratedAt !== firstCorrection.generatedAt || correction.firstCorrectionTiming?.actualCreationTime !== "2026-09-06T20:42:23.287Z"
    || correction.firstCorrectionTiming?.evidenceCheckedAt !== "2026-09-06T20:46:46.000Z" || Date.parse(firstCorrection.generatedAt) <= Date.parse(correction.firstCorrectionTiming.actualCreationTime)
    || correction.producer?.runner !== provenance.runner || correction.producer?.runnerSha256 !== provenance.runnerSha256 || correction.producer?.schema !== SCHEMA || correction.producer?.version !== 14
    || !same(original.firstFailure, expectedFailure) || !same(correction.actualFirstFailure, expectedFailure) || correction.classification !== "INCOMPLETE / ARCHIVE_FORK_CAPABILITY_UNAVAILABLE"
    || original.safety?.syntheticUsdPlusMintedLocally !== true || correction.execution?.syntheticUsdPlusMintedLocally !== false
    || correction.execution?.reached !== false || correction.execution?.relayReached !== false || correction.execution?.anvilReached !== false || correction.execution?.mintReached !== false || correction.execution?.redemptionReached !== false
    || correction.fullExitVerified !== false || correction.routePositive !== "unknown" || correction.executableNow !== "unknown" || correction.quoteEligible !== false
    || correction.signedActionJustified !== false || correction.profitabilityClaim !== false || correction.broadcastClaim !== false
    || correction.qualification?.attempted !== null || correction.qualification?.qualified !== null || correction.qualification?.requests !== null || correction.qualification?.bytes !== null
    || correction.qualification?.failureCodeCounts !== null || correction.qualification?.reason !== "COUNTERS_UNAVAILABLE_FROM_IMMUTABLE_ORIGINAL_ARTIFACT"
    || !outputIsSanitized(correction)) fail("CORRECTION_NOT_ADMISSIBLE", "CORRECTION_VALIDATION");
  return { canonicalArtifact: "redemption-fork-correction-v2.json", rejectedArtifacts: ["redemption-fork.json", "redemption-fork-correction.json"], contradictionProven: true,
    originalSha256: sha(originalBytes), firstCorrectionSha256: sha(firstCorrectionBytes), runnerSha256: provenance.runnerSha256 };
}

async function runCli(argv, io = {}) {
  parseCli(argv); const stdout = io.stdout || (value => process.stdout.write(value)), stderr = io.stderr || (value => process.stderr.write(value));
  try {
    const output = await runFork(io.options || {}); writeOnce(output, io.options || {});
    stdout(JSON.stringify({ classification: output.classification, firstFailure: output.firstFailure, fullExitVerified: output.fullExitVerified }) + "\n");
    if (output.classification !== "LOCAL_FORK_FULL_REDEMPTION_VERIFIED_AT_R13_PIN") process.exitCode = 2;
    return output;
  } catch (_) { stderr("R14_FAILED_CLOSED\n"); process.exitCode = 1; return null; }
}

module.exports = { ADDRESS, ARTIFACTS, LIMITS, OUTPUT_FILE, PIN, SIZES, UPSTREAM_METHODS, R14Error, artifactPreflight, assertArtifactsUnchanged,
  assertLocalhostUrl, baseOutput, buildAnvilArgs, createLocalRpc, createReadOnlyRelay, executeRedemptions, forbiddenRelayMethod, outputIsSanitized,
  parseCli, qualifyArchive, runCli, runFork, runnerProvenance, sanitizedChildEnvironment, stopAnvil, traceTargets, validateCorrectionArtifacts, validateRedemptionEvidence, writeOnce };
if (require.main === module) runCli(process.argv.slice(2));
