"use strict";

// Production startup intentionally imports built-ins only.  The reviewed P0
// anchor is pathname/hash-pinned and loaded later by secureStartup().
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const INVENTORY_FILE = path.join(ROOT, "rpc_endpoints.txt");
const OUTPUT_DIR = path.join(ROOT, "reports/raw/fast/base-paper-usdplus-r16");
const ATTEMPT_FILE = path.join(OUTPUT_DIR, "redemption-p1-attempt.json");
const OUTPUT_FILE = path.join(OUTPUT_DIR, "redemption-p1.json");
const ANCHOR_FILE = path.join(ROOT, "tools/lib/base-paper-usdplus-r16-proof-anchor.js");
const SCHEMA = "base-paper-usdplus-redemption/v16-p1";
const ANCHOR = Object.freeze({
  bytes: 14_481,
  sha256: "59dea96628ff46542b92ab6793244904740881489943321911345db1551ef221",
  manifestSha256: "8ec40e65a917b7c45eb65026732a9cecad80d6b77a343de6b41c2d5101d38cba",
});
const ANVIL = Object.freeze({
  file: "C:/Users/MiPC/.foundry/bin/anvil.exe",
  version: "1.5.1-stable",
  commit: "b0a9dd9ceda36f63e2326ce530c10e6916f4b8a2",
  bytes: 27_333_120,
  sha256: "d909a15a16d56ef2c00093c70cb567845b16400398158e5957b7a9a6818a1b9b",
});
const EIP1967 = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const MANAGER_ASSET_SLOT = `0x${"0".repeat(62)}fc`;
const ZERO = `0x${"0".repeat(40)}`;
const RAY = 10n ** 27n;
const SIZES = Object.freeze([1n, 1_000_000n, 100_000_000n]);
const A = Object.freeze({
  actor: "0x000000000000000000000000000000000000b0b0",
  venue: "0x0c1a09d5d0445047da3ab4994262b22404288a3b",
  exchange: "0x7cb1b38591021309c64f451859d79312d8ca2789",
  exchangeImpl: "0x10a013eb5d9f23dcd4b8f51321d6ea7d462927d4",
  manager: "0x27b12f3282f1d02682d7d1ad30e45e818b78f7b8",
  managerImpl: "0xb008d09d25f06799e4081877a6bb185d89d893d3",
  cash: "0x687ac878bc93610366b705c385cd0a0038493dbb",
  cashImpl: "0xebeac3cd336e592defd6b53548fadde22900d3df",
  usdPlus: "0xb79dd08ea68a908a97220c76d19a6aa9cbde4376",
  usdPlusImpl: "0xe1201f02c02e468c7ff6f61afff505a859673cfd",
  role: "0xa5096260710d135f9c3762fcd07b6b2e2fd127d1",
  roleImpl: "0x3e1f4163a61113e8a11b72d4cb388f7cb609d3a2",
  usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  aaveProvider: "0xe20fcbdbffc4dd138ce8b2e6fbb6cb49777ad64d",
  pool: "0xa238dd80c259a72e81d7e4664a9801593f98d1c5",
  poolImpl: "0xa4abc5fcba6d0d7e3d144d6dbf6cb6128599dfdb",
  aToken: "0x4e65fe4dba92790696d040ac24aa414708f5c0ab",
  supplyLogic: "0x584c7d8c4cb05304fe5ac7fbc97f20a10fb07564",
  poolLogic: "0xd70593841c57cbaa04957cc3eace95708e48853b",
  m2m: "0x1f4947cd5a5c058dd5ea6fd1ccd5c311ada9e6fb",
});
const LIMITS = Object.freeze({
  inventoryBytes: 1024 * 1024,
  parsedCandidates: 128,
  selectedCandidates: 8,
  perFamily: 2,
  rpcRequests: 320,
  rpcBytes: 256 * 1024 * 1024,
  relayRequests: 2400,
  relayBytes: 384 * 1024 * 1024,
  localRequests: 360,
  localBytes: 64 * 1024 * 1024,
  responseBytes: 8 * 1024 * 1024,
  requestMs: 10_000,
  startupMs: 45_000,
  wallMs: 360_000,
  freshnessSeconds: 3600,
  dynamicTargets: 20,
  proxyDepth: 2,
});
const STATIC_FILES = Object.freeze({
  "reports/raw/fast/base-paper-usdplus-r11/build-manifest.json": "84bc2eb07fb48bb703c9316a27a71c4b5bb4cd52e2db3fd67cd6300b0e75a4e5",
  "reports/raw/fast/base-paper-usdplus-r11/exchange-proxy.compiled.json": "984b9e89e4300255fe64d8bfed84f90baba24265c7a2ada3e7ac0f9508fdfa00",
  "reports/raw/fast/base-paper-usdplus-r11/exchange-implementation.compiled.json": "360989e356dd09b1aa43bf6091ab84743fb50f05de33917bb3d9759a2c43aa01",
  "reports/raw/fast/base-paper-usdplus-r11/manager-proxy.compiled.json": "511c86232ccf15fc4d6c3a919b5e2538ab19d7c133334a08bc9effce3d2a9f0d",
  "reports/raw/fast/base-paper-usdplus-r11/manager-implementation.compiled.json": "668e55e486eac52cb49dc72b1c1110ff69a7d69bae3ea1389f4ed59bd74099a2",
  "reports/raw/fast/base-paper-usdplus-r11/manager-implementation.input.json": "6bed366ac6dc5259db11de56990b54ef17a3e6473a1be55e11aa3ce47a9c6b72",
  "reports/raw/fast/base-paper-usdplus-r11/cash-proxy.compiled.json": "6113171151c66fb7314b68d2062935cd53cf09ba023e3001ae1562856483bcc3",
  "reports/raw/fast/base-paper-usdplus-r12/source-build.json": "4205b78a2e67d462e32564f426ff9a57c7e7427b8b44f546b4f32f03b316fb1a",
  "reports/raw/fast/base-paper-usdplus-r12/cash.compiled.json": "d978644070d862779b7e2beae22a9b7baa30c6af37622564569c42713c50b7c8",
  "reports/raw/fast/base-paper-usdplus-r13/active-token-exact-build.json": "7b782f931221f1ac4441cbb95c4727ef05abb7e77b475bd33e595407419f9a6a",
  "reports/raw/fast/base-paper-usdplus-r13/active-token.compiled.json": "6e4b94fafb553cd9095d7c31979628270896688a13902f65e86867e32b67165d",
  "reports/raw/fast/base-paper-usdplus-r13/role.compiled.json": "3b6e0b5fe94882b1e3bcf59d9423cb389ec0180e8be4f155cc4ffe6a96b9b4dc",
  "reports/raw/fast/base-paper-usdplus-r13/aave/active/linked-build.json": "8a540bf5f8bca304cd0d5065fa80b081c067b2e71d1d2d852c1ee21a7e92c7fa",
  "reports/raw/fast/base-paper-usdplus-r13/aave/active/withdrawal-compiled.json": "fe573d41693023d75ca86b408f037caabb6ce2e77e0be230d3e7759af6012d4a",
  "reports/raw/fast/base-paper-usdplus-r16/pool-proxy-authority-r3/authority.json": "ed22eb1bd582b2a81afc7cb3d60d32c542ff32ddc871899af658a37bd607a545",
  "reports/raw/fast/base-paper-usdplus-r16/pool-proxy-authority-r3/reconstructed-runtime.hex": "a2f2fc5a0ed86cbba37492fc7d70120c30ff31d86389e4f21e4403e62bc0c6f8",
});
const UPSTREAM = new Set(["eth_chainId", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getBalance", "eth_getCode", "eth_getStorageAt", "eth_getProof", "eth_call", "eth_getTransactionCount", "eth_gasPrice", "eth_getBlockReceipts", "eth_getTransactionByHash", "eth_getTransactionReceipt"]);
const MATERIAL = new Set(["eth_getBalance", "eth_getCode", "eth_getStorageAt", "eth_getProof", "eth_call", "eth_getTransactionCount"]);
const FAMILY_SUFFIXES = Object.freeze([
  ["alchemy.com", "alchemy", 0], ["infura.io", "infura", 0], ["quicknode.com", "quicknode", 0], ["quiknode.pro", "quicknode", 0],
  ["ankr.com", "ankr", 0], ["publicnode.com", "publicnode", 2], ["1rpc.io", "1rpc", 2], ["0xrpc.io", "0xrpc", 2], ["drpc.org", "drpc", 2],
]);
// Never exported.  Production truth and default-path publication require both
// this capability and an invocation object created only after the immutable
// attempt marker has been written and rebound.
const PRODUCTION_CAPABILITY = Object.freeze({});
const AUTHORIZED_INVOCATIONS = new WeakSet();
const CONSUMED_INVOCATIONS = new WeakSet();

class R16Error extends Error {
  constructor(stage, code, context = null) { super(code); this.name = "R16Error"; this.stage = stage; this.code = code; this.context = context; }
}
const fail = (stage, code, context) => { throw new R16Error(stage, code, context); };
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const lower = value => String(value || "").toLowerCase();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const quantity = value => `0x${BigInt(value).toString(16)}`;
const blockRef = pin => Object.freeze({ blockHash: pin.hash, requireCanonical: true });

// Small, dependency-free Keccak-256 implementation used only for exact ABI
// selectors, event topics, role IDs, and runtime identity checks.
const MASK64 = (1n << 64n) - 1n;
const KECCAK_RHO = Object.freeze([0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14]);
const KECCAK_RC = Object.freeze([0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an, 0x0000000000000088n,
  0x0000000080008009n, 0x000000008000000an, 0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n,
  0x0000000080000001n, 0x8000000080008008n]);
function rotl64(value, shift) { const n = BigInt(shift); return n === 0n ? value & MASK64 : ((value << n) | (value >> (64n - n))) & MASK64; }
function keccakPermutation(state) {
  for (const rc of KECCAK_RC) {
    const c = Array(5), d = Array(5), b = Array(25);
    for (let x = 0; x < 5; x++) c[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
    for (let x = 0; x < 5; x++) d[x] = c[(x + 4) % 5] ^ rotl64(c[(x + 1) % 5], 1);
    for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) state[x + 5 * y] = (state[x + 5 * y] ^ d[x]) & MASK64;
    for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl64(state[x + 5 * y], KECCAK_RHO[x + 5 * y]);
    for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) state[x + 5 * y] = (b[x + 5 * y] ^ ((~b[(x + 1) % 5 + 5 * y]) & b[(x + 2) % 5 + 5 * y])) & MASK64;
    state[0] ^= rc;
  }
}
function keccak256Bytes(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input), rate = 136, padded = Buffer.alloc(Math.ceil((bytes.length + 1) / rate) * rate || rate);
  bytes.copy(padded); padded[bytes.length] ^= 0x01; padded[padded.length - 1] ^= 0x80;
  const state = Array(25).fill(0n);
  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let i = 0; i < rate; i++) state[Math.floor(i / 8)] ^= BigInt(padded[offset + i]) << BigInt(8 * (i % 8));
    keccakPermutation(state);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < out.length; i++) out[i] = Number((state[Math.floor(i / 8)] >> BigInt(8 * (i % 8))) & 0xffn);
  return out;
}
const keccakHex = value => `0x${keccak256Bytes(typeof value === "string" ? Buffer.from(value, "utf8") : value).toString("hex")}`;
const selector = signature => keccakHex(signature).slice(0, 10);

function address(value, stage = "DECODE") {
  const out = lower(value); if (!/^0x[0-9a-f]{40}$/.test(out)) fail(stage, "ADDRESS_INVALID"); return out;
}
function hash32(value, stage = "DECODE") { const out = lower(value); if (!/^0x[0-9a-f]{64}$/.test(out)) fail(stage, "HASH32_INVALID"); return out; }
function encodeWord(type, value) {
  if (type === "address") return address(value).slice(2).padStart(64, "0");
  if (type === "bytes32") return hash32(value).slice(2);
  if (type === "bool") return (value ? "1" : "0").padStart(64, "0");
  if (/^uint(?:\d+)?$/.test(type)) { const n = BigInt(value); if (n < 0n || n >= 1n << 256n) fail("ENCODE", "UINT_INVALID"); return n.toString(16).padStart(64, "0"); }
  fail("ENCODE", "ABI_TYPE_UNSUPPORTED");
}
function calldata(signature, args = []) {
  const inside = signature.slice(signature.indexOf("(") + 1, -1), types = inside ? inside.split(",") : [];
  if (types.length !== args.length) fail("ENCODE", "ABI_ARGUMENT_COUNT");
  return selector(signature) + types.map((type, index) => encodeWord(type, args[index])).join("");
}
function decodeWords(raw, count, stage = "ABI") {
  const value = lower(raw); if (!new RegExp(`^0x[0-9a-f]{${count * 64}}$`).test(value)) fail(stage, "ABI_RESULT_LENGTH_INVALID");
  return Array.from({ length: count }, (_, index) => value.slice(2 + index * 64, 2 + (index + 1) * 64));
}
const uintWord = word => BigInt(`0x${word}`);
function addressWord(word, stage = "ABI") { if (!/^0{24}[0-9a-f]{40}$/.test(word)) fail(stage, "ABI_ADDRESS_NONCANONICAL"); return `0x${word.slice(24)}`; }
function boolWord(word, stage = "ABI") { const n = uintWord(word); if (n !== 0n && n !== 1n) fail(stage, "ABI_BOOL_NONCANONICAL"); return n === 1n; }
const decodeUint = raw => uintWord(decodeWords(raw, 1)[0]);
const decodeAddress = raw => addressWord(decodeWords(raw, 1)[0]);
const decodeBool = raw => boolWord(decodeWords(raw, 1)[0]);

function parseCli(argv) { if (!Array.isArray(argv) || argv.length !== 1 || argv[0] !== "--run-once") fail("CLI", "EXPLICIT_RUN_ONCE_REQUIRED"); return true; }
function provenance(readFile = fs.readFileSync) { return Object.freeze({ runner: "tools/run-base-paper-usdplus-redemption-r16.js", runnerSha256: sha(readFile(__filename)), schema: SCHEMA, version: "16-p1" }); }
function sanitized(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return !/(?:https?|wss?):\/\/|authorization|bearer\s|api[-_]?key|private[-_]?key|client[-_]?secret|access[-_]?key|[?&](?:key|token|secret)=|rpc_endpoints\.txt|\b(?:alchemy|infura|quicknode|quiknode|ankr|publicnode|1rpc|0xrpc|drpc)\b/i.test(text);
}
function statIdentity(stat) { return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, nlink: stat.nlink }; }
function sameStat(a, b) { return ["dev", "ino", "size", "mtimeMs", "ctimeMs", "nlink"].every(key => a[key] === b[key]); }
function inside(file, parent) { const rel = path.relative(path.resolve(parent), path.resolve(file)); return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)); }
function secureIdentity(file, expected, options = {}) {
  const lstat = options.lstat || fs.lstatSync, realpath = options.realpath || fs.realpathSync, readFile = options.readFile || fs.readFileSync;
  let before, after, realBefore, realAfter, bytes;
  try { before = lstat(file); realBefore = realpath(file); } catch (_) { fail(options.stage || "IDENTITY", "PINNED_FILE_MISSING"); }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || path.resolve(realBefore) !== path.resolve(file)) fail(options.stage || "IDENTITY", "PINNED_FILE_TYPE_INVALID");
  if (expected.bytes !== undefined && before.size !== expected.bytes) fail(options.stage || "IDENTITY", "PINNED_FILE_SIZE_MISMATCH");
  if (before.size > (expected.cap || 64 * 1024 * 1024)) fail(options.stage || "IDENTITY", "PINNED_FILE_SIZE_CAP");
  try { bytes = readFile(file); after = lstat(file); realAfter = realpath(file); } catch (_) { fail(options.stage || "IDENTITY", "PINNED_FILE_READ_FAILED"); }
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (!sameStat(before, after) || realBefore !== realAfter || bytes.length !== before.size) fail(options.stage || "IDENTITY", "PINNED_FILE_CHANGED_DURING_READ");
  if (sha(bytes) !== expected.sha256) fail(options.stage || "IDENTITY", "PINNED_FILE_HASH_MISMATCH");
  return { bytes, stat: statIdentity(after), realpath: realAfter };
}
function validateStartupEnvironment(options = {}) {
  const environment = options.environment || process.env, execArgv = options.execArgv || process.execArgv, cache = options.cache || require.cache;
  const keys = Object.keys(environment).map(key => key.toUpperCase());
  if (keys.includes("NODE_OPTIONS")) fail("STARTUP", "NODE_OPTIONS_REJECTED");
  if (keys.includes("NODE_PATH")) fail("STARTUP", "NODE_PATH_REJECTED");
  if (!Array.isArray(execArgv) || execArgv.length !== 0) fail("STARTUP", "EXEC_ARGV_REJECTED");
  const toolRoot = path.join(ROOT, "tools");
  for (const key of Object.keys(cache)) if (inside(key, toolRoot) && path.resolve(key) !== path.resolve(__filename)) fail("STARTUP", "PRELOADED_TOOL_MODULE_REJECTED");
  return true;
}
function anchorIdentity(options = {}) {
  const result = secureIdentity(options.anchorFile || ANCHOR_FILE, { bytes: options.anchorBytes === undefined ? ANCHOR.bytes : options.anchorBytes, sha256: ANCHOR.sha256, cap: 64 * 1024 }, { ...options, stage: "P0_ANCHOR" });
  if (!result.bytes.toString("utf8").includes(ANCHOR.manifestSha256)) fail("P0_ANCHOR", "FULL_MANIFEST_PIN_NOT_OWNED_BY_ANCHOR");
  return result;
}
function secureStartup(options = {}) {
  validateStartupEnvironment(options); anchorIdentity(options);
  const load = options.load || (file => require(file)), anchor = load(options.anchorFile || ANCHOR_FILE);
  if (!Object.isFrozen(anchor) || typeof anchor.verifyAccountProof !== "function" || typeof anchor.attestation !== "function") fail("P0_ANCHOR", "ANCHOR_PUBLIC_SURFACE_INVALID");
  const attestation = anchor.attestation();
  if (attestation.reviewedIdentity !== true || attestation.externalAnchorRequired !== true || attestation.anchorHashMustBePinnedBeforeRequire !== true || attestation.selfVerificationClaimed !== false) fail("P0_ANCHOR", "ANCHOR_ATTESTATION_INVALID");
  anchorIdentity(options); return anchor;
}

function json(bytes, stage = "STATIC_AUTHORITY") { try { return JSON.parse(bytes.toString("utf8")); } catch (_) { fail(stage, "AUTHORITY_JSON_INVALID"); } }
function canonicalAbiType(input) { return input.type.startsWith("tuple") ? `(${(input.components || []).map(canonicalAbiType).join(",")})${input.type.slice(5)}` : input.type; }
function eventTopic(abi, name) {
  const rows = (abi || []).filter(row => row.type === "event" && row.name === name); if (rows.length !== 1) fail("STATIC_AUTHORITY", "EVENT_ABI_AMBIGUOUS");
  return keccakHex(`${name}(${(rows[0].inputs || []).map(canonicalAbiType).join(",")})`);
}
function runtimeRecord(row, expectedAddress, expectedHash) {
  if (!row || address(row.address) !== expectedAddress || !/^0x(?:[0-9a-f]{2})+$/i.test(row.runtime || "") || lower(row.runtimeKeccak256) !== expectedHash || keccakHex(Buffer.from(row.runtime.slice(2), "hex")) !== expectedHash) fail("STATIC_AUTHORITY", "STATIC_RUNTIME_AUTHORITY_INVALID");
  return lower(row.runtime);
}
function staticAuthority(options = {}) {
  const root = options.root || ROOT, specs = options.specs || STATIC_FILES, readFile = options.readFile || fs.readFileSync, lstat = options.lstat || fs.lstatSync, realpath = options.realpath || fs.realpathSync;
  const snapshot = {}, bytesByPath = {};
  for (const [relative, expected] of Object.entries(specs)) {
    const file = path.join(root, relative), identity = secureIdentity(file, { sha256: expected, cap: 64 * 1024 * 1024 }, { readFile, lstat, realpath, stage: "STATIC_AUTHORITY" });
    snapshot[relative] = { ...identity.stat, sha256: expected }; bytesByPath[relative] = identity.bytes;
  }
  const get = relative => json(bytesByPath[relative]);
  const exchangeProxy = get("reports/raw/fast/base-paper-usdplus-r11/exchange-proxy.compiled.json");
  const exchange = get("reports/raw/fast/base-paper-usdplus-r11/exchange-implementation.compiled.json");
  const managerProxy = get("reports/raw/fast/base-paper-usdplus-r11/manager-proxy.compiled.json");
  const manager = get("reports/raw/fast/base-paper-usdplus-r11/manager-implementation.compiled.json");
  const cashProxy = get("reports/raw/fast/base-paper-usdplus-r11/cash-proxy.compiled.json");
  const cash = get("reports/raw/fast/base-paper-usdplus-r12/cash.compiled.json");
  const token = get("reports/raw/fast/base-paper-usdplus-r13/active-token.compiled.json");
  const role = get("reports/raw/fast/base-paper-usdplus-r13/role.compiled.json");
  const linked = get("reports/raw/fast/base-paper-usdplus-r13/aave/active/linked-build.json");
  const aave = get("reports/raw/fast/base-paper-usdplus-r13/aave/active/withdrawal-compiled.json");
  const poolAuthority = get("reports/raw/fast/base-paper-usdplus-r16/pool-proxy-authority-r3/authority.json");
  const poolText = bytesByPath["reports/raw/fast/base-paper-usdplus-r16/pool-proxy-authority-r3/reconstructed-runtime.hex"].toString("ascii").trim();
  if (!/^0x(?:[0-9a-f]{2})+$/i.test(poolText)) fail("STATIC_AUTHORITY", "POOL_PROXY_RUNTIME_INVALID");
  const poolRuntime = lower(poolText), poolRaw = Buffer.from(poolRuntime.slice(2), "hex");
  if (poolAuthority.classification !== "EXACT_AAVE_POOL_PROXY_SOURCE_BUILD_RUNTIME_BOUND_CANDIDATE" || lower(poolAuthority.address) !== A.pool || lower(poolAuthority.admin) !== A.aaveProvider
    || poolAuthority.runtime?.bytes !== 1933 || lower(poolAuthority.runtime?.keccak256) !== "0xffcb26fbebbe09d9b0d8baef76a1fa218989be6c279b7acf9865d8fb6e0718ce"
    || sha(poolRaw) !== "0ce3fd0250aff7584b77df0ac1f3de5a7a732e842d0dd8d67e73836d2c07b685" || keccakHex(poolRaw) !== lower(poolAuthority.runtime.keccak256)
    || poolAuthority.lineage?.p0AnchorSha256 !== ANCHOR.sha256 || poolAuthority.limitations?.historicalPublicSourceBuildOnly !== true) fail("STATIC_AUTHORITY", "POOL_PROXY_AUTHORITY_INVALID");
  if (linked.status !== "ACTIVE_AAVE_LINKED_EXACT_POOL_MATCH" || lower(linked.implementation) !== A.poolImpl) fail("STATIC_AUTHORITY", "AAVE_LINKED_AUTHORITY_INVALID");
  const sharedProxy = runtimeRecord(exchangeProxy, A.exchange, "0x932cddc50793da935ccf915651ad67f6b746e9936fcc5614f0ff492563782c75");
  const runtimes = Object.freeze({
    [A.exchange]: sharedProxy,
    [A.exchangeImpl]: runtimeRecord(exchange, A.exchangeImpl, "0xa456737736f5153205d4ee0c4e3c81a8f660735ce53aa406c84cd26f932924c6"),
    [A.manager]: runtimeRecord(managerProxy, A.manager, "0x932cddc50793da935ccf915651ad67f6b746e9936fcc5614f0ff492563782c75"),
    [A.managerImpl]: runtimeRecord(manager, A.managerImpl, "0xad2d36729d1aec2db8dcb188cc42acf243abacf2082ccf0604778dff98a5a2b0"),
    [A.cash]: runtimeRecord(cashProxy, A.cash, "0x5e4dcb0bb1910f6429e5fe91678990088a51c6d1cfe1b31d05fb9d948cc7867c"),
    [A.cashImpl]: runtimeRecord(cash, A.cashImpl, "0x25b068f238f59964c724d0e0a4b063f4f8703c8ca06e7acf2238f5aaa91c0f29"),
    [A.usdPlus]: sharedProxy,
    [A.usdPlusImpl]: runtimeRecord(token, A.usdPlusImpl, "0x620d69f8ada943306a9ff09bbc5b02c594a622a4cb5a837d88f05f3984bf398c"),
    [A.role]: sharedProxy,
    [A.roleImpl]: runtimeRecord(role, A.roleImpl, "0x25cc0589797963189c81b697f9a2b31badc08f6c2642ea09dca831c07ccc5236"),
    [A.pool]: poolRuntime,
    [A.poolImpl]: runtimeRecord(aave.pool, A.poolImpl, "0x46a99baf41f90e39818ded14f4d45885fe6293496e72c1cea2014e814701a994"),
    [A.supplyLogic]: runtimeRecord(aave.SupplyLogic, A.supplyLogic, "0xd7a886e7fff585881ef03af514c58a96b9c188f9502bc0d0a49fb472cd2eee6e"),
    [A.poolLogic]: runtimeRecord(aave.PoolLogic, A.poolLogic, "0x0fe8b38a44e9cb253e9e8c1abb79beb4ac2aae00dedaf4207a3215eeab678cee"),
  });
  const slots = Object.freeze({ [A.exchange]: [EIP1967], [A.manager]: [EIP1967, MANAGER_ASSET_SLOT], [A.cash]: [EIP1967], [A.usdPlus]: [EIP1967], [A.role]: [EIP1967], [A.pool]: [EIP1967] });
  const events = Object.freeze({ transfer: keccakHex("Transfer(address,address,uint256)"), unstake: eventTopic(cash.abi, "Unstake"), reserveUpdated: eventTopic(aave.pool.abi, "ReserveDataUpdated"), withdraw: eventTopic(aave.pool.abi, "Withdraw"), balance: eventTopic(manager.abi, "Balance") });
  return { root, specs, snapshot, runtimes, slots, events };
}
function assertAuthorityUnchanged(authority, options = {}) {
  const readFile = options.readFile || fs.readFileSync, lstat = options.lstat || fs.lstatSync, realpath = options.realpath || fs.realpathSync;
  for (const [relative, before] of Object.entries(authority.snapshot)) {
    const file = path.join(authority.root, relative), current = secureIdentity(file, { bytes: before.size, sha256: before.sha256, cap: 64 * 1024 * 1024 }, { readFile, lstat, realpath, stage: "STATIC_AUTHORITY_TERMINAL" });
    if (!sameStat(before, current.stat)) fail("STATIC_AUTHORITY_TERMINAL", "STATIC_AUTHORITY_CHANGED");
  }
  return true;
}
function verifyAnvilIdentity(options = {}) {
  const expected = options.expected || ANVIL, file = path.resolve(options.file || expected.file);
  const identity = secureIdentity(file, { bytes: expected.bytes, sha256: expected.sha256, cap: 64 * 1024 * 1024 }, { ...options, stage: "ANVIL_IDENTITY" });
  return Object.freeze({ file, version: expected.version, commit: expected.commit, bytes: expected.bytes, sha256: expected.sha256, stat: identity.stat });
}

function classifyFamily(url) {
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  for (const [suffix, family, rank] of FAMILY_SUFFIXES) if (host === suffix || host.endsWith(`.${suffix}`)) return { family, rank };
  return null;
}
function parseInventory(text) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > LIMITS.inventoryBytes) fail("INVENTORY", "INVENTORY_INVALID");
  const raw = [];
  for (const line of text.split(/\r?\n/)) {
    if (/\[origin:/i.test(line)) continue;
    const match = line.match(/(https:\/\/[^\s'"<>\[\]]+)/i); if (!match) continue;
    const token = match[1].replace(/[)\]]+$/, ""); let url;
    try { url = new URL(token); } catch (_) { continue; }
    if (url.protocol !== "https:" || url.username || url.password || url.hash || /solana|sui|aptos|stellar|tron|testnet|hoodi|sepolia/i.test(url.href)) continue;
    const classified = classifyFamily(url); if (!classified) continue;
    raw.push({ url, family: classified.family, rank: classified.rank, ordinal: raw.length }); if (raw.length >= LIMITS.parsedCandidates) break;
  }
  const hrefs = new Set(), origins = new Set(), familyCount = new Map(), selected = [];
  raw.sort((a, b) => a.rank - b.rank || a.ordinal - b.ordinal);
  for (const row of raw) {
    if (hrefs.has(row.url.href) || origins.has(row.url.origin)) continue;
    hrefs.add(row.url.href); origins.add(row.url.origin);
    const used = familyCount.get(row.family) || 0; if (used >= LIMITS.perFamily) continue;
    familyCount.set(row.family, used + 1); selected.push(row); if (selected.length === LIMITS.selectedCandidates) break;
  }
  if (new Set(selected.map(row => row.family)).size < 2) fail("INVENTORY", "TWO_REVIEWED_FAMILIES_UNAVAILABLE");
  return selected;
}
function readInventoryOnce(options = {}) {
  const file = options.file || INVENTORY_FILE, lstat = options.lstat || fs.lstatSync, readFile = options.readFile || fs.readFileSync;
  let before, after, bytes;
  try { before = lstat(file); } catch (_) { fail("INVENTORY", "INVENTORY_MISSING"); }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > LIMITS.inventoryBytes) fail("INVENTORY", "INVENTORY_INVALID");
  try { bytes = readFile(file); after = lstat(file); if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes); if (!sameStat(before, after) || bytes.length !== before.size) fail("INVENTORY", "INVENTORY_CHANGED_DURING_READ"); return parseInventory(bytes.toString("utf8")); }
  finally { if (Buffer.isBuffer(bytes)) bytes.fill(0); }
}
function originFor(url) {
  const href = url.href;
  if (href.includes("nodereal.io")) return "https://pancakeswap.finance";
  if (href.includes("app.aave.com/api/rpc-proxy")) return "https://app.aave.com";
  if (href.includes("app.morpho.org/api/rpc")) return "https://app.morpho.org";
  if (href.includes("proxy.sky.money") || href.includes("gateway.tenderly.co")) return "https://app.sky.money";
  return null;
}
async function requestJSON(url, body, timeoutMs = LIMITS.requestMs) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(timeoutMs, LIMITS.requestMs))), headers = { "content-type": "application/json" };
  const origin = originFor(url); if (origin) headers.origin = origin;
  try {
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal, redirect: "error" });
    if (!response.ok || response.redirected || !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") || "")) throw new Error("transport");
    const chunks = []; let total = 0;
    for await (const chunk of response.body) { total += chunk.length; if (total > LIMITS.responseBytes) throw new Error("cap"); chunks.push(chunk); }
    return { value: JSON.parse(Buffer.concat(chunks).toString("utf8")), bytes: total };
  } finally { clearTimeout(timer); }
}
function createRpcLedger(transport = requestJSON, now = Date.now) {
  const state = { requests: 0, bytes: 0, started: now(), eip1898: 0 };
  const call = async (candidate, method, params, stage) => {
    if (!UPSTREAM.has(method) || state.requests >= LIMITS.rpcRequests || now() - state.started > LIMITS.wallMs) fail(stage, "RPC_BUDGET_EXHAUSTED");
    if (MATERIAL.has(method)) { const ref = params.at(-1); if (!ref || typeof ref !== "object" || ref.requireCanonical !== true || !/^0x[0-9a-f]{64}$/.test(ref.blockHash || "")) fail(stage, "EIP1898_REQUIRED"); state.eip1898++; }
    const id = ++state.requests; let response;
    try { response = await transport(candidate.url, { jsonrpc: "2.0", id, method, params }, LIMITS.requestMs); } catch (_) { fail(stage, "TRANSPORT_UNAVAILABLE"); }
    if (!response || !Number.isSafeInteger(response.bytes) || response.bytes < 0 || response.bytes > LIMITS.responseBytes || (state.bytes += response.bytes) > LIMITS.rpcBytes) fail(stage, "RPC_BYTE_BUDGET_EXHAUSTED");
    if (response.value?.jsonrpc !== "2.0" || response.value.id !== id || response.value.error || !Object.hasOwn(response.value, "result")) fail(stage, "RPC_ENVELOPE_INVALID");
    return response.value.result;
  };
  return { state, call };
}
function parseHeader(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(raw.number || "") || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(raw.timestamp || "")) fail("QUALIFICATION", "HEADER_INVALID");
  const number = BigInt(raw.number), timestamp = BigInt(raw.timestamp); if (number > BigInt(Number.MAX_SAFE_INTEGER)) fail("QUALIFICATION", "HEADER_INVALID");
  return Object.freeze({ number: number.toString(), hash: hash32(raw.hash, "QUALIFICATION"), parentHash: hash32(raw.parentHash, "QUALIFICATION"), stateRoot: hash32(raw.stateRoot, "QUALIFICATION"), timestamp: timestamp.toString() });
}
function freshHeader(pin, now) { const age = BigInt(Math.floor(now() / 1000)) - BigInt(pin.timestamp); if (age < -60n || age > BigInt(LIMITS.freshnessSeconds)) fail("QUALIFICATION", "FINALIZED_HEADER_STALE"); return pin; }
async function qualify(candidates, ledger, now = Date.now) {
  if (!Array.isArray(candidates) || candidates.length < 2 || candidates.length > LIMITS.selectedCandidates || new Set(candidates.map(row => row.url.origin)).size !== candidates.length) fail("QUALIFICATION", "CANDIDATE_SET_INVALID");
  const admitted = [], failures = {};
  for (const candidate of candidates) {
    try {
      if (await ledger.call(candidate, "eth_chainId", [], "QUALIFICATION") !== "0x2105") fail("QUALIFICATION", "CHAIN_MISMATCH");
      admitted.push({ candidate, finalized: freshHeader(parseHeader(await ledger.call(candidate, "eth_getBlockByNumber", ["finalized", false], "QUALIFICATION")), now) });
    } catch (error) { const code = error instanceof R16Error ? error.code : "QUALIFICATION_FAILED"; failures[code] = (failures[code] || 0) + 1; if (/BUDGET/.test(code)) throw error; }
  }
  if (new Set(admitted.map(row => row.candidate.family)).size < 2) fail("QUALIFICATION", "TWO_FINALIZED_FAMILIES_UNAVAILABLE", { attempted: candidates.length, admitted: admitted.length, failures });
  const common = admitted.reduce((n, row) => BigInt(row.finalized.number) < n ? BigInt(row.finalized.number) : n, BigInt(admitted[0].finalized.number));
  const groups = new Map();
  for (const row of admitted) {
    try {
      const pin = freshHeader(parseHeader(await ledger.call(row.candidate, "eth_getBlockByNumber", [quantity(common), false], "QUALIFICATION")), now);
      if (BigInt(pin.number) !== common) fail("QUALIFICATION", "COMMON_HEIGHT_MISMATCH");
      const key = JSON.stringify(pin); if (!groups.has(key)) groups.set(key, []); groups.get(key).push({ candidate: row.candidate, pin });
    } catch (error) { const code = error instanceof R16Error ? error.code : "EXACT_HEADER_FAILED"; failures[code] = (failures[code] || 0) + 1; if (/BUDGET/.test(code)) throw error; }
  }
  const coherent = [...groups.values()].filter(rows => new Set(rows.map(row => row.candidate.family)).size >= 2).sort((x, y) => new Set(y.map(row => row.candidate.family)).size - new Set(x.map(row => row.candidate.family)).size)[0];
  if (!coherent) fail("QUALIFICATION", "EXACT_TWO_FAMILY_PIN_UNAVAILABLE", { attempted: candidates.length, admitted: admitted.length, failures });
  const pair = [], used = new Set(); for (const row of coherent) if (!used.has(row.candidate.family)) { pair.push(row); used.add(row.candidate.family); if (pair.length === 2) break; }
  return { pair, pin: pair[0].pin, stats: { attempted: candidates.length, finalizedAdmitted: admitted.length, selectedFamilyCount: 2, failures } };
}

function canonicalStorageKey(value) {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value) || value.length > 66) fail("PROOF_BINDING", "STORAGE_KEY_INVALID");
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}
function storageWord(value) {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value) || value.length > 66) fail("PROOF_BINDING", "STORAGE_VALUE_INVALID");
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}
function storageAddress(value) { const n = BigInt(value); if (n === 0n) return ZERO; return `0x${n.toString(16).padStart(64, "0").slice(-40)}`; }
async function bindAccount(candidate, pin, ledger, anchor, target, slots = [], expectedRuntime = null) {
  const ref = blockRef(pin), requested = slots.map(canonicalStorageKey);
  const proof = await ledger.call(candidate, "eth_getProof", [target, requested, ref], "PROOF_BINDING");
  const code = lower(await ledger.call(candidate, "eth_getCode", [target, ref], "PROOF_BINDING"));
  if (!proof || typeof proof !== "object" || lower(proof.address) !== target || !Array.isArray(proof.storageProof) || proof.storageProof.length !== requested.length || !/^0x(?:[0-9a-f]{2})+$/i.test(code) || code === "0x") fail("PROOF_BINDING", "ACCOUNT_PROOF_RESPONSE_INVALID");
  const normalizedStorage = proof.storageProof.map((row, index) => {
    if (!row || canonicalStorageKey(row.key) !== requested[index]) fail("PROOF_BINDING", "STORAGE_PROOF_KEY_SET_MISMATCH");
    return { ...row, key: requested[index] };
  });
  const result = await anchor.verifyAccountProof({ stateRoot: pin.stateRoot, address: target, nonce: proof.nonce, balance: proof.balance, storageHash: proof.storageHash, codeHash: proof.codeHash, accountProof: proof.accountProof, storageProof: normalizedStorage, code }, "REQUIRED_EXISTING");
  if (result.accountIncluded !== true || result.codeHashMatched !== true || result.storageProofCount !== requested.length || expectedRuntime !== null && code !== expectedRuntime) fail("PROOF_BINDING", expectedRuntime === null ? "ACCOUNT_PROOF_NOT_BOUND" : "STATIC_RUNTIME_MISMATCH");
  return { address: target, slots: Object.fromEntries(normalizedStorage.map(row => [row.key, storageWord(row.value)])), code };
}
async function exactCall(candidate, pin, ledger, rawCalls, label, to, signature, args, decoder) {
  const data = calldata(signature, args), raw = lower(await ledger.call(candidate, "eth_call", [{ to, data, gas: "0x4c4b40" }, blockRef(pin)], "ABI_OBSERVATION"));
  if (!/^0x(?:[0-9a-f]{2})+$/.test(raw)) fail("ABI_OBSERVATION", "ABI_RESULT_INVALID"); rawCalls[label] = { to, data, raw }; return decoder(raw);
}
function decodeReserve(raw) {
  const w = decodeWords(raw, 15); return { configuration: uintWord(w[0]).toString(), liquidityIndex: uintWord(w[1]).toString(), currentLiquidityRate: uintWord(w[2]).toString(),
    variableBorrowIndex: uintWord(w[3]).toString(), currentVariableBorrowRate: uintWord(w[4]).toString(), currentStableBorrowRate: uintWord(w[5]).toString(), lastUpdateTimestamp: uintWord(w[6]).toString(),
    id: uintWord(w[7]).toString(), aToken: addressWord(w[8]), stableDebt: addressWord(w[9]), variableDebt: addressWord(w[10]), rateStrategy: addressWord(w[11]),
    accruedToTreasury: uintWord(w[12]).toString(), unbacked: uintWord(w[13]).toString(), isolationModeTotalDebt: uintWord(w[14]).toString() };
}
function payoutFor(x, inputs) {
  const amount = BigInt(x), assetDecimals = BigInt(inputs.assetDecimals), usdPlusDecimals = BigInt(inputs.usdPlusDecimals);
  let assetAmount = assetDecimals > usdPlusDecimals ? amount * 10n ** (assetDecimals - usdPlusDecimals) : amount / 10n ** (usdPlusDecimals - assetDecimals);
  const rate = BigInt(inputs.feeRate), denominator = BigInt(inputs.feeDenominator); if (assetAmount <= 0n || denominator <= 0n || rate > denominator) fail("PAYOUT", "PAYOUT_INPUT_INVALID");
  const fee = inputs.freeRider ? 0n : assetAmount * rate / denominator; return { x: amount.toString(), assetAmount: assetAmount.toString(), fee: fee.toString(), payout: (assetAmount - fee).toString() };
}
function capacityRows(view) {
  return SIZES.map(size => { const amounts = payoutFor(size, view.payoutInputs), payout = BigInt(amounts.payout), index = BigInt(view.aave.nextLiquidityIndex), scaled = (payout * RAY + index - 1n) / index;
    return { ...amounts, scaledP: scaled.toString(), liquidationStrict: BigInt(view.cash.liquidationValue) > payout, scaledSufficient: BigInt(view.aave.scaledBalance) >= scaled,
      virtualSufficient: BigInt(view.aave.virtualUnderlying) >= payout, actualSufficient: BigInt(view.aave.actualUnderlying) >= payout }; });
}
async function captureFamily(row, pin, ledger, authority, anchor) {
  const candidate = row.candidate, rawCalls = {}, staticBindings = {}, commitments = [];
  for (const target of Object.keys(authority.runtimes)) staticBindings[target] = await bindAccount(candidate, pin, ledger, anchor, target, authority.slots[target] || [], authority.runtimes[target]);
  for (const bound of Object.values(staticBindings)) commitments.push({ address: bound.address, code: bound.code, slots: bound.slots });
  const impl = proxy => storageAddress(staticBindings[proxy].slots[EIP1967]);
  const pointers = { exchange: impl(A.exchange), manager: impl(A.manager), cash: impl(A.cash), token: impl(A.usdPlus), role: impl(A.role), pool: impl(A.pool) };
  const call = (label, to, signature, args, decoder) => exactCall(candidate, pin, ledger, rawCalls, label, to, signature, args, decoder);
  const scalarUint = (label, to, signature, args = []) => call(label, to, signature, args, raw => decodeUint(raw).toString());
  const scalarAddress = (label, to, signature, args = []) => call(label, to, signature, args, decodeAddress);
  const scalarBool = (label, to, signature, args = []) => call(label, to, signature, args, decodeBool);
  const reserve = await call("pool.reserve", A.pool, "getReserveData(address)", [A.usdc], decodeReserve);
  if (reserve.aToken !== A.aToken || reserve.stableDebt !== ZERO || reserve.variableDebt === ZERO || reserve.rateStrategy === ZERO) fail("ABI_OBSERVATION", "RESERVE_DEPENDENCY_SET_INVALID");
  const blockGetter = await scalarAddress("exchange.blockGetter", A.exchange, "blockGetter()");
  const incentives = await scalarAddress("aToken.incentives", reserve.aToken, "getIncentivesController()"); if (incentives === ZERO) fail("ABI_OBSERVATION", "INCENTIVES_CONTROLLER_ZERO");
  const dynamicInitial = [["usdc", A.usdc], ["aToken", reserve.aToken], ["addressesProvider", A.aaveProvider], ["variableDebt", reserve.variableDebt], ["rateStrategy", reserve.rateStrategy], ["incentives", incentives]];
  if (blockGetter !== ZERO) dynamicInitial.push(["blockGetter", blockGetter]);
  const queue = dynamicInitial.map(([label, target]) => ({ label, target, depth: 0 })), dynamic = [], seen = new Set(Object.keys(authority.runtimes));
  while (queue.length) {
    const next = queue.shift(); if (seen.has(next.target)) continue; seen.add(next.target);
    if (dynamic.length >= LIMITS.dynamicTargets) fail("PROOF_BINDING", "DYNAMIC_TARGET_CAP");
    const bound = await bindAccount(candidate, pin, ledger, anchor, next.target, [EIP1967]); const implementation = storageAddress(bound.slots[EIP1967]);
    dynamic.push({ address: next.target, implementation }); commitments.push({ address: bound.address, code: bound.code, slots: bound.slots });
    if (implementation !== ZERO && !seen.has(implementation)) { if (next.depth >= LIMITS.proxyDepth) fail("PROOF_BINDING", "DYNAMIC_PROXY_DEPTH_EXCEEDED"); queue.push({ label: `${next.label}Implementation`, target: implementation, depth: next.depth + 1 }); }
  }
  dynamic.sort((x, y) => x.address.localeCompare(y.address));
  commitments.sort((x, y) => x.address.localeCompare(y.address));
  const dynamicMap = new Map(dynamic.map(item => [item.address, item.implementation]));
  if (dynamicMap.get(A.usdc) === ZERO || dynamicMap.get(A.aToken) === ZERO) fail("PROOF_BINDING", "TOKEN_IMPLEMENTATION_UNBOUND");
  const locks = {};
  for (const [label, target] of [["actor", A.actor], ["venue", A.venue], ["burn", ZERO]]) locks[label] = await call(`token.lock.${label}`, A.usdPlus, "lockOptionsPerAddress(address)", [target], raw => { const w = decodeWords(raw, 2); return { lockSend: boolWord(w[0]), lockReceive: boolWord(w[1]) }; });
  const freeRiderRole = keccakHex("FREE_RIDER_ROLE"), exchangerRole = keccakHex("EXCHANGER");
  const view = {
    staticProofCount: Object.keys(staticBindings).length, pointers, privateAsset: storageAddress(staticBindings[A.manager].slots[MANAGER_ASSET_SLOT]), dynamic, commitments,
    payoutInputs: { assetDecimals: await scalarUint("usdc.decimals", A.usdc, "decimals()"), usdPlusDecimals: await scalarUint("token.decimals", A.usdPlus, "decimals()"),
      feeRate: await scalarUint("exchange.redeemFee", A.exchange, "redeemFee()"), feeDenominator: await scalarUint("exchange.redeemFeeDenominator", A.exchange, "redeemFeeDenominator()"),
      freeRider: await scalarBool("role.freeRider", A.role, "hasRole(bytes32,address)", [freeRiderRole, A.actor]) },
    core: {
      usdPlus: await scalarAddress("exchange.usdPlus", A.exchange, "usdPlus()"), usdc: await scalarAddress("exchange.usdc", A.exchange, "usdc()"),
      manager: await scalarAddress("exchange.manager", A.exchange, "portfolioManager()"), role: await scalarAddress("exchange.role", A.exchange, "roleManager()"), blockGetter,
      exchangePaused: await scalarBool("exchange.paused", A.exchange, "paused()"), tokenPaused: await scalarBool("token.paused", A.usdPlus, "isPaused()"),
      tokenExchange: await scalarAddress("token.exchange", A.usdPlus, "exchange()"), tokenRole: await scalarAddress("token.role", A.usdPlus, "roleManager()"), locks,
    },
    manager: { exchanger: await scalarAddress("manager.exchanger", A.manager, "exchanger()"), cash: await scalarAddress("manager.cash", A.manager, "cashStrategy()"),
      exchangeHasRole: await scalarBool("manager.exchangeRole", A.manager, "hasRole(bytes32,address)", [exchangerRole, A.exchange]) },
    cash: { manager: await scalarAddress("cash.manager", A.cash, "portfolioManager()"), usdc: await scalarAddress("cash.usdc", A.cash, "usdcToken()"),
      aToken: await scalarAddress("cash.aToken", A.cash, "aUsdcToken()"), provider: await scalarAddress("cash.provider", A.cash, "aaveProvider()"),
      inLending: await scalarBool("cash.inLending", A.cash, "inLending()"), liquidationValue: await scalarUint("cash.liquidation", A.cash, "liquidationValue()"), navSlippageBP: await scalarUint("cash.slippage", A.cash, "navSlippageBP()") },
    aave: { reserve, configuration: await scalarUint("pool.configuration", A.pool, "getConfiguration(address)", [A.usdc]), userConfiguration: await scalarUint("pool.userConfiguration", A.pool, "getUserConfiguration(address)", [A.cash]),
      providerAtPool: await scalarAddress("pool.provider", A.pool, "ADDRESSES_PROVIDER()"), providerPool: await scalarAddress("provider.pool", A.aaveProvider, "getPool()"),
      tokenPool: await scalarAddress("aToken.pool", reserve.aToken, "POOL()"), tokenUnderlying: await scalarAddress("aToken.underlying", reserve.aToken, "UNDERLYING_ASSET_ADDRESS()"), incentives,
      nextLiquidityIndex: await scalarUint("pool.normalizedIncome", A.pool, "getReserveNormalizedIncome(address)", [A.usdc]), scaledBalance: await scalarUint("aToken.scaledCash", reserve.aToken, "scaledBalanceOf(address)", [A.cash]),
      virtualUnderlying: await scalarUint("pool.virtual", A.pool, "getVirtualUnderlyingBalance(address)", [A.usdc]), actualUnderlying: await scalarUint("usdc.aTokenBalance", A.usdc, "balanceOf(address)", [reserve.aToken]) },
  };
  if (blockGetter !== ZERO) view.blockGetterNumber = await scalarUint("blockGetter.number", blockGetter, "getNumber()");
  view.capacity = capacityRows(view); return { view, rawCalls };
}
function evaluateGates(view, authority) {
  const expectedPointers = { exchange: A.exchangeImpl, manager: A.managerImpl, cash: A.cashImpl, token: A.usdPlusImpl, role: A.roleImpl, pool: A.poolImpl };
  const config = BigInt(view.aave.configuration), user = BigInt(view.aave.userConfiguration), noBorrowing = (user & BigInt(`0x${"55".repeat(32)}`)) === 0n;
  const gates = {
    G1: { pass: view.staticProofCount === Object.keys(authority.runtimes).length && same(view.pointers, expectedPointers), code: "STATIC_RUNTIME_OR_TOPOLOGY_UNBOUND" },
    G2: { pass: view.core.usdPlus === A.usdPlus && view.core.usdc === A.usdc && view.core.manager === A.manager && view.core.role === A.role && view.core.tokenExchange === A.exchange && view.core.tokenRole === A.role
      && !view.core.exchangePaused && !view.core.tokenPaused && Object.values(view.core.locks).every(row => !row.lockSend && !row.lockReceive), code: "CORE_CONFIG_OR_GUARD_BLOCKED" },
    G3: { pass: view.privateAsset === A.usdc && view.manager.exchanger === A.exchange && view.manager.cash === A.cash && view.manager.exchangeHasRole && view.cash.manager === A.manager && view.cash.usdc === A.usdc
      && view.cash.aToken === A.aToken && view.cash.provider === A.aaveProvider && view.cash.inLending, code: "MANAGER_STRATEGY_BINDING_BLOCKED" },
    G4: { pass: view.capacity.length === SIZES.length && view.capacity.every(row => row.liquidationStrict && row.scaledSufficient && row.virtualSufficient && row.actualSufficient), code: "CASH_ONLY_CAPACITY_BLOCKED" },
    G5: { pass: view.dynamic.length >= 8 && view.aave.reserve.aToken === A.aToken && view.aave.reserve.variableDebt !== ZERO && view.aave.reserve.rateStrategy !== ZERO && view.aave.providerAtPool === A.aaveProvider
      && view.aave.providerPool === A.pool && view.aave.tokenPool === A.pool && view.aave.tokenUnderlying === A.usdc && view.aave.incentives !== ZERO && Boolean(config & (1n << 56n)) && !Boolean(config & (1n << 60n))
      && noBorrowing && (view.core.blockGetter === ZERO || view.blockGetterNumber === undefined || view.blockGetterNumber === null || BigInt(view.blockGetterNumber) === BigInt(view.pinNumber || 0)), code: "AAVE_DYNAMIC_DEPENDENCY_BLOCKED" },
  };
  // The block getter equality is checked with the selected pin by establish().
  if (view.core.blockGetter !== ZERO && BigInt(view.blockGetterNumber) !== BigInt(view.pinNumber)) gates.G5.pass = false;
  const first = Object.entries(gates).find(([, gate]) => !gate.pass); return { gates, allPass: !first, firstFailure: first ? { stage: `PREFORK_${first[0]}`, code: first[1].code } : null };
}
async function terminalPinRechecks(pair, pin, ledger, now = Date.now) {
  for (const row of pair) {
    const exact = freshHeader(parseHeader(await ledger.call(row.candidate, "eth_getBlockByNumber", [quantity(pin.number), false], "TERMINAL_PIN_RECHECK")), now);
    if (!same(exact, pin)) fail("TERMINAL_PIN_RECHECK", "EXACT_HEADER_CHANGED");
    const finalized = freshHeader(parseHeader(await ledger.call(row.candidate, "eth_getBlockByNumber", ["finalized", false], "TERMINAL_PIN_RECHECK")), now);
    if (BigInt(finalized.number) < BigInt(pin.number)) fail("TERMINAL_PIN_RECHECK", "FINALITY_REGRESSED");
  }
  return true;
}
async function establish(options) {
  const qualified = await qualify(options.candidates, options.ledger, options.now || Date.now), captures = [];
  for (const row of qualified.pair) captures.push(await captureFamily(row, qualified.pin, options.ledger, options.authority, options.anchor));
  captures[0].view.pinNumber = qualified.pin.number; captures[1].view.pinNumber = qualified.pin.number;
  if (!same(captures[0].rawCalls, captures[1].rawCalls) || !same(captures[0].view, captures[1].view)) fail("TWO_FAMILY_AGREEMENT", "EXACT_ABI_OR_BOUND_STATE_DISAGREEMENT");
  const evaluation = evaluateGates(captures[0].view, options.authority); if (!evaluation.allPass) throw new R16Error(evaluation.firstFailure.stage, evaluation.firstFailure.code, { evaluation });
  await terminalPinRechecks(qualified.pair, qualified.pin, options.ledger, options.now || Date.now);
  options.anchor.attestation(); anchorIdentity(options.anchorOptions || {});
  return { ...qualified, view: captures[0].view, commitments: captures[0].view.commitments, abiCommitments: captures[0].rawCalls, evaluation, selected: qualified.pair[0].candidate };
}

function localhost(value) {
  let url; try { url = new URL(value); } catch (_) { fail("LOCALHOST", "LOCALHOST_REQUIRED"); }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(host) || url.username || url.password || url.hash || !["", "/"].includes(url.pathname)) fail("LOCALHOST", "LOCALHOST_REQUIRED"); return url;
}
function forbiddenRelayMethod(method) { return /^(?:eth_send|eth_sign|eth_accounts|eth_coinbase|personal_|wallet_|account|admin_|anvil_|evm_|debug_|trace_|engine_|miner_|txpool_)/i.test(method); }
function relayParams(method, params, pin) {
  const out = structuredClone(Array.isArray(params) ? params : []), tag = quantity(pin.number), ref = blockRef(pin);
  if (method === "eth_getBlockByNumber") { if (!["latest", tag].includes(lower(out[0]))) fail("RELAY", "UNPINNED_BLOCK_REQUEST"); out[0] = tag; }
  else if (method === "eth_getBlockByHash") { if (lower(out[0]) !== pin.hash) fail("RELAY", "UNPINNED_BLOCK_REQUEST"); }
  else if (MATERIAL.has(method)) {
    const current = out.at(-1); if (!(current === "latest" || lower(current) === tag || current && typeof current === "object" && lower(current.blockHash) === pin.hash && current.requireCanonical === true)) fail("RELAY", "UNPINNED_STATE_REQUEST"); out[out.length - 1] = ref;
  } else if (method === "eth_getBlockReceipts") {
    if (!["latest", tag, pin.hash].includes(lower(out[0]))) fail("RELAY", "UNPINNED_BLOCK_REQUEST");
    out[0] = pin.hash;
  }
  return out;
}
async function createRelay(options) {
  let forwarded = 0, denied = 0, bytes = 0, active = 0; const started = Date.now(), methods = {};
  const forward = async row => {
    const id = Object.hasOwn(row || {}, "id") ? row.id : null, method = typeof row?.method === "string" ? row.method : "";
    if (forbiddenRelayMethod(method) || !UPSTREAM.has(method)) { denied++; return { jsonrpc: "2.0", id, error: { code: -32601, message: "method-not-allowed" } }; }
    if (forwarded >= LIMITS.relayRequests || active >= 8 || Date.now() - started > LIMITS.wallMs) return { jsonrpc: "2.0", id, error: { code: -32000, message: "relay-budget-exhausted" } };
    active++; forwarded++; methods[method] = (methods[method] || 0) + 1;
    try {
      const response = await options.transport(options.candidate.url, { jsonrpc: "2.0", id, method, params: relayParams(method, row.params, options.pin) }, LIMITS.requestMs);
      if (!response || !Number.isSafeInteger(response.bytes) || response.bytes < 0 || response.bytes > LIMITS.responseBytes || (bytes += response.bytes) > LIMITS.relayBytes || response.value?.jsonrpc !== "2.0" || response.value.id !== id) throw new Error("upstream");
      return response.value;
    } catch (_) { return { jsonrpc: "2.0", id, error: { code: -32000, message: "upstream-read-failure" } }; } finally { active--; }
  };
  const server = http.createServer((request, response) => {
    const remote = request.socket.remoteAddress || "";
    if (request.method !== "POST" || !(remote.includes("127.0.0.1") || remote === "::1" || remote === "::ffff:127.0.0.1")) { response.writeHead(403).end(); return; }
    let size = 0; const chunks = []; request.setTimeout(LIMITS.requestMs, () => request.destroy());
    request.on("data", chunk => { size += chunk.length; if (size <= 1024 * 1024) chunks.push(chunk); else request.destroy(); });
    request.on("end", async () => { try { const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")), rows = Array.isArray(parsed) ? parsed : [parsed]; if (!rows.length || rows.length > 64) throw new Error("invalid");
      const results = await Promise.all(rows.map(forward)), payload = Buffer.from(JSON.stringify(Array.isArray(parsed) ? results : results[0])); if (payload.length > LIMITS.responseBytes) throw new Error("large");
      response.writeHead(200, { "content-type": "application/json" }); response.end(payload); } catch (_) { response.writeHead(400, { "content-type": "application/json" }); response.end('{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"invalid-request"}}'); } });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const close = () => new Promise((resolve, reject) => { let done = false; const finish = error => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(); };
    const timer = setTimeout(() => { server.closeAllConnections?.(); finish(new R16Error("RELAY_CLEANUP", "RELAY_CLOSE_UNCONFIRMED")); }, 1500); server.close(error => finish(error ? new R16Error("RELAY_CLEANUP", "RELAY_CLOSE_FAILED") : null)); });
  return { port: server.address().port, stats: () => ({ forwarded, denied, bytes, methods }), close };
}
function childEnvironment(environment = process.env) {
  const result = {}; for (const key of ["SystemRoot", "WINDIR"]) if (typeof environment[key] === "string" && environment[key] && !/:\/\//.test(environment[key])) result[key] = environment[key];
  result.TEMP = path.join(os.tmpdir(), "opencode"); result.TMP = result.TEMP; return result;
}
function buildAnvilArgs(relayPort, localPort, pin) {
  const relay = `http://127.0.0.1:${relayPort}`; localhost(relay);
  const args = ["--host", "127.0.0.1", "--port", String(localPort), "--chain-id", "8453", "--accounts", "0", "--auto-impersonate", "--fork-url", relay, "--fork-block-number", String(pin.number), "--no-storage-caching", "--quiet", "--color", "never"];
  if (args.some(value => /https|wss|authorization|bearer|token=/i.test(value))) fail("ANVIL_START", "CHILD_ARGV_SECRET_EXPOSURE"); return args;
}
function freePort() { return new Promise((resolve, reject) => { const server = net.createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolve(port)); }); }); }
function startAnvil(identity, args) { return new Promise((resolve, reject) => { const child = childProcess.spawn(identity.file, args, { stdio: "ignore", shell: false, windowsHide: true, env: childEnvironment() }); child.once("spawn", () => resolve(child)); child.once("error", () => reject(new R16Error("ANVIL_START", "ANVIL_START_FAILED"))); }); }
async function stopAnvil(child, waitMs = 1500) {
  if (!child || child.exitCode != null || child.signalCode != null) return true;
  const wait = () => new Promise(resolve => { if (child.exitCode != null || child.signalCode != null) return resolve(true); let done = false; const finish = value => { if (done) return; done = true; clearTimeout(timer); child.removeListener?.("exit", onExit); resolve(value); }; const onExit = () => finish(true), timer = setTimeout(() => finish(false), waitMs); child.once?.("exit", onExit); });
  try { child.kill(); } catch (_) { fail("CHILD_CLEANUP", "ANVIL_NORMAL_KILL_FAILED"); } if (await wait()) return true;
  try { child.kill("SIGKILL"); } catch (_) { fail("CHILD_CLEANUP", "ANVIL_FORCED_KILL_FAILED"); } if (await wait()) return true; fail("CHILD_CLEANUP", "ANVIL_EXIT_UNCONFIRMED");
}
function createLocalRpc(port, options = {}) {
  const endpoint = `http://127.0.0.1:${port}`; localhost(endpoint); let requests = 0, bytes = 0; const started = Date.now();
  const call = async (method, params, timeoutMs = LIMITS.requestMs) => {
    if (++requests > LIMITS.localRequests || Date.now() - started > LIMITS.wallMs) fail("LOCAL_RPC", "LOCAL_RPC_BUDGET_EXHAUSTED");
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(timeoutMs, LIMITS.requestMs)));
    try { const response = await (options.fetch || fetch)(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: requests, method, params }), signal: controller.signal, redirect: "error" });
      const buffer = Buffer.from(await response.arrayBuffer()); bytes += buffer.length; if (!response.ok || buffer.length > LIMITS.responseBytes || bytes > LIMITS.localBytes) fail("LOCAL_RPC", "LOCAL_RPC_RESPONSE_CAP");
      const parsed = JSON.parse(buffer.toString("utf8")); if (parsed.error || parsed.id !== requests || !Object.hasOwn(parsed, "result")) fail("LOCAL_RPC", "LOCAL_RPC_METHOD_FAILED"); return parsed.result;
    } catch (error) { if (error instanceof R16Error) throw error; fail("LOCAL_RPC", "LOCAL_RPC_UNAVAILABLE"); } finally { clearTimeout(timer); }
  };
  return { call, stats: () => ({ requests, bytes }) };
}
async function waitReady(child, rpc, pin, timeoutMs = LIMITS.startupMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child?.exitCode != null || child?.signalCode != null) fail("ANVIL_START", "ANVIL_EXITED_DURING_STARTUP");
    try { const chain = await rpc.call("eth_chainId", []), block = parseHeader(await rpc.call("eth_getBlockByNumber", [quantity(pin.number), false])); if (chain === "0x2105" && same(block, pin)) return true; fail("FORK_PIN", "LOCAL_FORK_PIN_MISMATCH"); }
    catch (error) { if (error instanceof R16Error && error.stage === "FORK_PIN") throw error; }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  fail("ANVIL_START", "ANVIL_STARTUP_TIMEOUT");
}
async function verifyLocalBinding(rpc, pre) {
  if (!Array.isArray(pre?.commitments) || !pre.commitments.length || !pre.abiCommitments || typeof pre.abiCommitments !== "object") fail("LOCAL_BINDING", "LOCAL_COMMITMENTS_MISSING");
  let accounts = 0, slots = 0, abi = 0;
  for (const commitment of pre.commitments) {
    const code = lower(await rpc.call("eth_getCode", [commitment.address, "latest"]));
    if (code !== commitment.code) fail("LOCAL_BINDING", "LOCAL_CODE_COMMITMENT_MISMATCH"); accounts++;
    for (const [slot, expected] of Object.entries(commitment.slots)) {
      const observed = lower(await rpc.call("eth_getStorageAt", [commitment.address, slot, "latest"]));
      if (!/^0x[0-9a-f]{64}$/.test(observed) || observed !== expected) fail("LOCAL_BINDING", "LOCAL_STORAGE_COMMITMENT_MISMATCH"); slots++;
    }
  }
  for (const label of Object.keys(pre.abiCommitments).sort()) {
    const commitment = pre.abiCommitments[label];
    if (!commitment || address(commitment.to, "LOCAL_BINDING") !== commitment.to || !/^0x(?:[0-9a-f]{2})+$/.test(commitment.data || "") || !/^0x(?:[0-9a-f]{2})+$/.test(commitment.raw || "")) fail("LOCAL_BINDING", "LOCAL_ABI_COMMITMENT_INVALID");
    const observed = lower(await rpc.call("eth_call", [{ to: commitment.to, data: commitment.data, gas: "0x4c4b40" }, "latest"]));
    if (observed !== commitment.raw) fail("LOCAL_BINDING", "LOCAL_ABI_COMMITMENT_MISMATCH"); abi++;
  }
  return Object.freeze({ accounts, slots, abi });
}
async function localCall(rpc, to, signature, args, decoder) { return decoder(await rpc.call("eth_call", [{ to, data: calldata(signature, args), gas: "0x4c4b40" }, "latest"])); }
async function captureLocalState(rpc, view) {
  const header = parseHeader(await rpc.call("eth_getBlockByNumber", ["latest", false])), balance = (token, holder) => localCall(rpc, token, "balanceOf(address)", [holder], raw => decodeUint(raw).toString());
  return {
    blockNumber: header.number, blockTimestamp: header.timestamp,
    usdPlusActor: await balance(A.usdPlus, A.actor), usdPlusSupply: await localCall(rpc, A.usdPlus, "totalSupply()", [], raw => decodeUint(raw).toString()),
    usdcActor: await balance(A.usdc, A.actor), usdcAToken: await balance(A.usdc, A.aToken), usdcCash: await balance(A.usdc, A.cash), usdcManager: await balance(A.usdc, A.manager), usdcExchange: await balance(A.usdc, A.exchange),
    usdcSupply: await localCall(rpc, A.usdc, "totalSupply()", [], raw => decodeUint(raw).toString()), scaledCash: await localCall(rpc, A.aToken, "scaledBalanceOf(address)", [A.cash], raw => decodeUint(raw).toString()),
    virtualUnderlying: await localCall(rpc, A.pool, "getVirtualUnderlyingBalance(address)", [A.usdc], raw => decodeUint(raw).toString()), actualUnderlying: await balance(A.usdc, A.aToken),
    nextLiquidityIndex: await localCall(rpc, A.pool, "getReserveNormalizedIncome(address)", [A.usdc], raw => decodeUint(raw).toString()), expectedViewIndex: view.aave.nextLiquidityIndex,
  };
}
async function sendLocal(rpc, from, to, data, stage) {
  let hash; try { hash = await rpc.call("eth_sendTransaction", [{ from, to, data, gas: "0xe4e1c0" }]); } catch (_) { fail(stage, `${stage}_REVERTED`); }
  for (let count = 0; count < 20; count++) { const receipt = await rpc.call("eth_getTransactionReceipt", [hash]); if (receipt) { if (receipt.status !== "0x1") fail(stage, `${stage}_REVERTED`); return { hash, receipt }; } await new Promise(resolve => setTimeout(resolve, 25)); }
  fail(stage, `${stage}_RECEIPT_UNAVAILABLE`);
}
function parseTransfers(receipt, topic) {
  const rows = [];
  for (const log of receipt.logs || []) if (lower(log.topics?.[0]) === topic && log.topics.length === 3) {
    const from = addressWord(lower(log.topics[1]).slice(2)), to = addressWord(lower(log.topics[2]).slice(2)), value = decodeUint(log.data).toString(); rows.push({ token: address(log.address), from, to, value });
  }
  return rows;
}
function reserveUpdateEvidence(receipt, topic) {
  const matches = [];
  for (const log of receipt.logs || []) {
    if (lower(log.address) !== A.pool || lower(log.topics?.[0]) !== topic || log.topics.length !== 2) continue;
    const reserve = addressWord(lower(log.topics[1]).slice(2)); if (reserve !== A.usdc) continue;
    const words = decodeWords(log.data, 5, "RESERVE_UPDATE_EVENT");
    matches.push({ liquidityRate: uintWord(words[0]).toString(), stableBorrowRate: uintWord(words[1]).toString(), variableBorrowRate: uintWord(words[2]).toString(),
      liquidityIndex: uintWord(words[3]).toString(), variableBorrowIndex: uintWord(words[4]).toString() });
  }
  if (matches.length !== 1 || BigInt(matches[0].liquidityIndex) <= 0n) fail("RESERVE_UPDATE_EVENT", "POST_UPDATE_LIQUIDITY_INDEX_UNAVAILABLE");
  return matches[0];
}
function orderedCalls(trace) {
  const rows = [];
  const visit = (node, parent = null) => { if (!node || typeof node !== "object") return; const index = rows.length; rows.push({ order: index, parent, caller: lower(node.from), callee: lower(node.to), type: String(node.type || "CALL").toUpperCase(), selector: lower(node.input).slice(0, 10), success: !node.error }); for (const child of node.calls || []) visit(child, index); };
  visit(trace); return rows;
}
function validateOrderedCashPath(calls) {
  const pathPairs = [[A.actor, A.exchange], [A.exchange, A.manager], [A.manager, A.cash], [A.cash, A.pool], [A.pool, A.aToken], [A.aToken, A.usdc]];
  // Proxy and linked-library DELEGATECALL frames legitimately occur between
  // these external legs, so preserve global depth-first order rather than
  // requiring the six calls to be direct parent/child frames.
  let cursor = -1;
  for (const [from, to] of pathPairs) { const index = calls.findIndex(row => row.order > cursor && row.caller === from && row.callee === to && row.success); if (index < 0) return { pass: false, code: "ORDERED_CASH_PATH_MISSING" }; cursor = calls[index].order; }
  if (calls.some(row => row.callee === A.m2m)) return { pass: false, code: "PATH_EXPANDED_TO_PORTFOLIO_BALANCING" }; return { pass: true, code: null };
}
function validateTraceClosure(calls, expectedTargets) {
  for (const row of calls) {
    if (["CREATE", "CREATE2", "SELFDESTRUCT"].includes(row.type) || !row.success) return { pass: false, code: "TRACE_CREATE_OR_FAILURE" };
    if (!/^0x[0-9a-f]{40}$/.test(row.callee)) return { pass: false, code: "TRACE_TARGET_INVALID" };
    const numeric = BigInt(row.callee); if (!expectedTargets.has(row.callee) && !(numeric > 0n && numeric <= 0xffn)) return { pass: false, code: "UNEXPECTED_CODE_TARGET" };
  }
  return { pass: true, code: null };
}
function hasTransfer(row, token, from, to, amount = null) { return row.transfers.some(item => item.token === token && item.from === from && item.to === to && (amount === null || BigInt(item.value) === BigInt(amount))); }
function validateConservation(row) {
  const x = BigInt(row.x), payout = BigInt(row.payout), index = BigInt(row.postLiquidityIndex), scaled = (payout * RAY + index - 1n) / index, before = row.before, after = row.after;
  const pass = BigInt(before.usdPlusActor) - BigInt(after.usdPlusActor) === x && BigInt(before.usdPlusSupply) - BigInt(after.usdPlusSupply) === x && hasTransfer(row, A.usdPlus, A.actor, ZERO, x)
    && hasTransfer(row, A.usdc, A.aToken, A.cash, payout) && hasTransfer(row, A.usdc, A.cash, A.manager, payout) && hasTransfer(row, A.usdc, A.manager, A.exchange, payout) && hasTransfer(row, A.usdc, A.exchange, A.actor, payout)
    && BigInt(after.usdcActor) - BigInt(before.usdcActor) === payout && BigInt(before.usdcAToken) - BigInt(after.usdcAToken) === payout
    && ["usdcCash", "usdcManager", "usdcExchange"].every(key => BigInt(after[key]) === BigInt(before[key])) && BigInt(before.usdcSupply) === BigInt(after.usdcSupply)
    && BigInt(after.blockNumber) === BigInt(row.eventBlockNumber) && BigInt(after.nextLiquidityIndex) === index && BigInt(before.scaledCash) - BigInt(after.scaledCash) === scaled && BigInt(before.virtualUnderlying) - BigInt(after.virtualUnderlying) === payout && BigInt(before.actualUnderlying) - BigInt(after.actualUnderlying) === payout
    && row.poolWithdraw && row.strategyUnstake && row.reserveUpdated && !row.balanceEvent && row.rollbackComplete && row.path.pass && row.closure.pass;
  return { pass, scaledP: scaled.toString(), code: pass ? null : "CONSERVATION_TRACE_OR_ROLLBACK_MISMATCH" };
}
async function executeG6(options) {
  const { rpc, pre, authority, progress } = options, rows = [], expectedTargets = new Set([...Object.keys(authority.runtimes), ...pre.view.dynamic.map(row => row.address), A.actor]);
  for (const amounts of pre.view.capacity) {
    const snapshot = await rpc.call("evm_snapshot", []), pristine = await captureLocalState(rpc, pre.view); let reverted = false;
    try {
      await rpc.call("anvil_setBalance", [A.actor, "0x56bc75e2d63100000"]); await rpc.call("anvil_setBalance", [A.exchange, "0x56bc75e2d63100000"]);
      await rpc.call("anvil_impersonateAccount", [A.actor]); await rpc.call("anvil_impersonateAccount", [A.exchange]);
      await sendLocal(rpc, A.exchange, A.usdPlus, calldata("mint(address,uint256)", [A.actor, amounts.x]), "SYNTHETIC_USDPLUS_MINT"); progress.mintReached = true;
      const before = await captureLocalState(rpc, pre.view); if (BigInt(before.usdPlusActor) - BigInt(pristine.usdPlusActor) !== BigInt(amounts.x) || BigInt(before.usdPlusSupply) - BigInt(pristine.usdPlusSupply) !== BigInt(amounts.x)) fail("SYNTHETIC_USDPLUS_MINT", "SYNTHETIC_MINT_RECONCILIATION_FAILED");
      const sent = await sendLocal(rpc, A.actor, A.exchange, calldata("redeem(address,uint256)", [A.usdc, amounts.x]), "EXCHANGE_REDEEM"); progress.redemptionReached = true;
      const after = await captureLocalState(rpc, pre.view), transfers = parseTransfers(sent.receipt, authority.events.transfer), reserveUpdate = reserveUpdateEvidence(sent.receipt, authority.events.reserveUpdated);
      if (BigInt(reserveUpdate.liquidityIndex) !== BigInt(after.nextLiquidityIndex)) fail("RESERVE_UPDATE_EVENT", "POST_UPDATE_LIQUIDITY_INDEX_MISMATCH");
      let trace; try { trace = await rpc.call("debug_traceTransaction", [sent.hash, { tracer: "callTracer" }]); } catch (_) { fail("G6_TRACE", "CALL_TRACE_UNAVAILABLE"); }
      const calls = orderedCalls(trace), pathResult = validateOrderedCashPath(calls), closure = validateTraceClosure(calls, expectedTargets);
      const topics = (sent.receipt.logs || []).map(log => ({ address: lower(log.address), topic: lower(log.topics?.[0]) }));
      const result = await rpc.call("evm_revert", [snapshot]); reverted = result === true; const rolledBack = await captureLocalState(rpc, pre.view), rollbackComplete = reverted && same(pristine, rolledBack);
      if (!/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(sent.receipt.blockNumber || "")) fail("RESERVE_UPDATE_EVENT", "RECEIPT_BLOCK_NUMBER_INVALID");
      const row = { x: amounts.x, payout: amounts.payout, postLiquidityIndex: reserveUpdate.liquidityIndex, eventBlockNumber: BigInt(sent.receipt.blockNumber).toString(), before, after, transfers,
        poolWithdraw: topics.some(item => item.address === A.pool && item.topic === authority.events.withdraw), strategyUnstake: topics.some(item => item.address === A.cash && item.topic === authority.events.unstake),
        reserveUpdated: topics.some(item => item.address === A.pool && item.topic === authority.events.reserveUpdated), balanceEvent: topics.some(item => item.address === A.manager && item.topic === authority.events.balance),
        rollbackComplete, path: pathResult, closure };
      const validation = validateConservation(row); if (!validation.pass) fail("G6_CONSERVATION", validation.code); rows.push({ amountRaw: row.x, payoutRaw: row.payout, postLiquidityIndex: row.postLiquidityIndex, scaledBurnRaw: validation.scaledP, orderedCashPath: true, targetClosure: true, conservation: true, rollback: true });
    } catch (error) { if (!reverted) try { await rpc.call("evm_revert", [snapshot]); } catch (_) { /* primary failure retained */ } throw error; }
    finally { for (const account of [A.actor, A.exchange]) try { await rpc.call("anvil_stopImpersonatingAccount", [account]); } catch (_) { /* local cleanup */ } }
  }
  return rows;
}

function baseOutput(capability = null) { const source = capability === PRODUCTION_CAPABILITY ? "production" : "offline-test"; return { schema: SCHEMA, generatedAt: new Date().toISOString(), completedAt: null, provenance: provenance(), evidenceSource: source,
  classification: "INCOMPLETE", firstFailure: null, stageProgression: [], pin: null, qualification: null, budgets: LIMITS, preForkGates: null, rows: [],
  productionInvocationBound: false, attemptId: null, progress: { relayReached: false, anvilReached: false, localBindingVerified: false, mintReached: false, redemptionReached: false }, cleanup: { child: "NOT_STARTED", relay: "NOT_STARTED" }, cleanupFailures: [],
  fullExitVerified: false, measuredFreshRedemptionBehavior: false, localSemantic: { status: "UNKNOWN", result: "inconclusive" }, reproducibility: "UNKNOWN", quoteEligible: false,
  routePositive: "unknown", executableNow: "unknown", profitabilityClaim: false, signedActionJustified: false, signing: false, broadcast: false,
  safety: { indivisibleStateMachine: true, partialProductionModes: false, inventoryReads: 0, retries: 0, endpointMaterialPersisted: false, endpointIdentityPersisted: false,
    endpointMaterialHashed: false, endpointMaterialInChildArgv: false, walletKeyFilesRead: false, envFilesRead: false, upstreamTransactions: 0, localKeyless: true,
    nativeUsdcInjected: false, storageEdited: false, victimImpersonated: false, rawSizes: SIZES.map(String) } }; }
function classification(error) { return `INCOMPLETE / ${error.stage || "UNCLASSIFIED"} / ${error.code || "UNEXPECTED_FAILURE"}`; }
function cleanupFailure(error, stage, code) { return { stage: error instanceof R16Error ? error.stage : stage, code: error instanceof R16Error ? error.code : code }; }
function productionEligible(options) {
  return options.capability === PRODUCTION_CAPABILITY && !!options.invocation && AUTHORIZED_INVOCATIONS.has(options.invocation) && !CONSUMED_INVOCATIONS.has(options.invocation);
}
async function runAttempt(options = {}) {
  const eligible = productionEligible(options), output = baseOutput(eligible ? PRODUCTION_CAPABILITY : null), now = options.now || Date.now, transport = options.transport || requestJSON, authority = options.authority, anchor = options.anchor, anvilIdentity = options.anvilIdentity;
  if (eligible) { output.productionInvocationBound = true; output.attemptId = options.invocation.attemptId; }
  let relay, child, rpc, primary = null;
  try {
    output.stageProgression.push(...(eligible ? ["BUILTINS_ONLY_STARTUP_AND_P0_ANCHOR_PINNED", "STATIC_AUTHORITY_AND_ANVIL_IDENTITY_PINNED", "NO_OVERWRITE_ATTEMPT_MARKER_CREATED"] : ["OFFLINE_TEST_SEAMS_ACTIVE"]));
    output.safety.inventoryReads++; const candidates = options.candidates || (options.readInventory || readInventoryOnce)();
    const ledger = options.ledger || createRpcLedger(transport, now), pre = options.establish ? await options.establish({ candidates, ledger, authority, anchor, now }) : await establish({ candidates, ledger, authority, anchor, now, anchorOptions: options.anchorOptions });
    output.qualification = pre.stats; output.pin = { ...pre.pin, observedAt: new Date(now()).toISOString(), freshnessExpiresAt: new Date((Number(pre.pin.timestamp) + LIMITS.freshnessSeconds) * 1000).toISOString(), stateRootProofBound: true, exactTwoFamilyAgreement: true };
    output.preForkGates = pre.evaluation; output.stageProgression.push("FRESH_TWO_FAMILY_STATE_ROOT_BOUND", "G1_G5_PASS", "TERMINAL_PIN_RECHECKS_PASS");
    if (now() >= (Number(pre.pin.timestamp) + LIMITS.freshnessSeconds) * 1000) fail("FORK_START", "PIN_FRESHNESS_EXPIRED");
    relay = options.relayFactory ? await options.relayFactory(pre.selected, pre.pin) : await createRelay({ candidate: pre.selected, pin: pre.pin, transport }); output.progress.relayReached = true; output.stageProgression.push("LOCALHOST_READ_ONLY_RELAY_STARTED");
    const port = await (options.freePort || freePort)(), args = buildAnvilArgs(relay.port, port, pre.pin);
    child = options.startChild ? await options.startChild(anvilIdentity, args) : await startAnvil(anvilIdentity, args); output.progress.anvilReached = true; output.stageProgression.push("PINNED_KEYLESS_ANVIL_STARTED");
    rpc = options.rpcFactory ? options.rpcFactory(port) : createLocalRpc(port); await (options.waitReady || waitReady)(child, rpc, pre.pin);
    output.localBinding = await (options.verifyLocalBinding || verifyLocalBinding)(rpc, pre); output.progress.localBindingVerified = true; output.stageProgression.push("ANVIL_LOCAL_COMMITMENTS_REBOUND_BEFORE_MUTATION");
    output.rows = await (options.executeG6 || executeG6)({ rpc, child, pre, authority, progress: output.progress });
    if (!Array.isArray(output.rows) || output.rows.length !== SIZES.length || output.rows.some((row, index) => row.amountRaw !== SIZES[index].toString() || !row.conservation || !row.rollback || !row.orderedCashPath || !row.targetClosure)) fail("G6", "G6_RESULT_SET_INVALID");
    output.stageProgression.push("G6_THREE_SIZE_REDEMPTION_PASS"); output.classification = eligible ? "MEASURED_FRESH_REDEMPTION_BEHAVIOR_VERIFIED" : "OFFLINE_TEST_STATE_MACHINE_COMPLETE";
    if (eligible) { output.fullExitVerified = true; output.measuredFreshRedemptionBehavior = true; output.localSemantic = { status: "PASS", result: "supports" }; output.reproducibility = "PASS"; }
  } catch (error) {
    primary = error instanceof R16Error ? error : new R16Error("UNCLASSIFIED", "UNEXPECTED_FAILURE"); output.firstFailure = { stage: primary.stage, code: primary.code }; output.classification = classification(primary);
    if (primary.context?.evaluation) output.preForkGates = primary.context.evaluation; if (primary.context?.attempted !== undefined) output.qualification = primary.context;
  } finally {
    if (child) try { await (options.stopChild || stopAnvil)(child); output.cleanup.child = "CONFIRMED"; } catch (error) { output.cleanup.child = "FAILED"; output.cleanupFailures.push(cleanupFailure(error, "CHILD_CLEANUP", "ANVIL_CLEANUP_FAILED")); }
    if (relay) try { output.relay = relay.stats(); await relay.close(); output.cleanup.relay = "CONFIRMED"; } catch (error) { output.cleanup.relay = "FAILED"; output.cleanupFailures.push(cleanupFailure(error, "RELAY_CLEANUP", "RELAY_CLEANUP_FAILED")); }
    if (rpc?.stats) output.localRpc = rpc.stats();
    if (output.cleanupFailures.length) { output.fullExitVerified = false; output.measuredFreshRedemptionBehavior = false; output.localSemantic = { status: "UNKNOWN", result: "inconclusive" }; output.reproducibility = "UNKNOWN"; if (!primary) { output.firstFailure = output.cleanupFailures[0]; output.classification = classification(output.firstFailure); } }
  }
  output.completedAt = new Date(now()).toISOString(); if (!sanitized(output)) fail("OUTPUT", "OUTPUT_NOT_SANITIZED"); return output;
}
function ensureNoOverwrite(options = {}) { const exists = options.exists || fs.existsSync; if (exists(options.attemptFile || ATTEMPT_FILE) || exists(options.outputFile || OUTPUT_FILE)) fail("PUBLICATION", "ATTEMPT_ALREADY_CONSUMED_NO_RETRY"); return true; }
function writeJsonOnce(file, value, options = {}) {
  const resolved = path.resolve(file), isAttempt = resolved === path.resolve(ATTEMPT_FILE), isOutput = resolved === path.resolve(OUTPUT_FILE);
  if (isAttempt && options.capability !== PRODUCTION_CAPABILITY) fail("PUBLICATION", "PRODUCTION_CAPABILITY_REQUIRED");
  if (isOutput && (options.capability !== PRODUCTION_CAPABILITY || !options.invocation || !AUTHORIZED_INVOCATIONS.has(options.invocation) || CONSUMED_INVOCATIONS.has(options.invocation))) fail("PUBLICATION", "PRODUCTION_INVOCATION_BINDING_INVALID");
  const mkdir = options.mkdir || fs.mkdirSync, writeFile = options.writeFile || fs.writeFileSync, text = JSON.stringify(value, null, 2) + "\n"; if (!sanitized(text)) fail("PUBLICATION", "OUTPUT_NOT_SANITIZED"); mkdir(path.dirname(file), { recursive: true }); writeFile(file, text, { flag: "wx" }); return file;
}
function beginProductionInvocation(capability) {
  if (capability !== PRODUCTION_CAPABILITY) fail("PUBLICATION", "PRODUCTION_CAPABILITY_REQUIRED");
  const attemptId = crypto.randomBytes(16).toString("hex"), marker = { schema: "base-paper-usdplus-redemption-attempt/v16-p1", generatedAt: new Date().toISOString(), provenance: provenance(), attemptId, oneShotConsumed: true, retries: 0, partialProductionModes: false };
  const text = JSON.stringify(marker, null, 2) + "\n"; writeJsonOnce(ATTEMPT_FILE, marker, { capability });
  const identity = secureIdentity(ATTEMPT_FILE, { bytes: Buffer.byteLength(text), sha256: sha(text), cap: 64 * 1024 }, { stage: "PUBLICATION" });
  const invocation = Object.freeze({ attemptId, markerSha256: sha(text), markerBytes: Buffer.byteLength(text), markerStat: identity.stat }); AUTHORIZED_INVOCATIONS.add(invocation); return invocation;
}
function publishProduction(capability, invocation, output) {
  if (capability !== PRODUCTION_CAPABILITY || !AUTHORIZED_INVOCATIONS.has(invocation) || CONSUMED_INVOCATIONS.has(invocation) || output?.productionInvocationBound !== true || output.attemptId !== invocation.attemptId || output.evidenceSource !== "production") fail("PUBLICATION", "PRODUCTION_INVOCATION_BINDING_INVALID");
  const identity = secureIdentity(ATTEMPT_FILE, { bytes: invocation.markerBytes, sha256: invocation.markerSha256, cap: 64 * 1024 }, { stage: "PUBLICATION" });
  if (!sameStat(identity.stat, invocation.markerStat)) fail("PUBLICATION", "ATTEMPT_MARKER_CHANGED");
  writeJsonOnce(OUTPUT_FILE, output, { capability, invocation }); CONSUMED_INVOCATIONS.add(invocation); return OUTPUT_FILE;
}
async function productionOnce() {
  ensureNoOverwrite(); const anchor = secureStartup(), authority = staticAuthority(), anvilIdentity = verifyAnvilIdentity();
  const invocation = beginProductionInvocation(PRODUCTION_CAPABILITY), output = await runAttempt({ capability: PRODUCTION_CAPABILITY, invocation, authority, anchor, anvilIdentity });
  try { assertAuthorityUnchanged(authority); anchor.attestation(); anchorIdentity(); }
  catch (error) { const known = error instanceof R16Error ? error : new R16Error("TERMINAL_IDENTITY", "TERMINAL_IDENTITY_RECHECK_FAILED"); output.fullExitVerified = false; output.measuredFreshRedemptionBehavior = false; output.localSemantic = { status: "UNKNOWN", result: "inconclusive" }; output.reproducibility = "UNKNOWN"; if (!output.firstFailure) { output.firstFailure = { stage: known.stage, code: known.code }; output.classification = classification(known); } else output.cleanupFailures.push({ stage: known.stage, code: known.code }); }
  output.completedAt = new Date().toISOString(); publishProduction(PRODUCTION_CAPABILITY, invocation, output); return output;
}
async function runCli(argv, io = {}) {
  const stdout = io.stdout || (text => process.stdout.write(text)), stderr = io.stderr || (text => process.stderr.write(text)), setExitCode = io.setExitCode || (code => { process.exitCode = code; });
  try { parseCli(argv); const output = await productionOnce(); stdout(JSON.stringify({ classification: output.classification, firstFailure: output.firstFailure, stages: output.stageProgression, progress: output.progress, cleanup: output.cleanup }) + "\n"); setExitCode(output.fullExitVerified ? 0 : 2); return output; }
  catch (_) { stderr("R16_P1_FAILED_CLOSED\n"); setExitCode(1); return null; }
}

module.exports = Object.freeze({ A, ANCHOR, ANVIL, ATTEMPT_FILE, EIP1967, LIMITS, MANAGER_ASSET_SLOT, OUTPUT_FILE, R16Error, SCHEMA, SIZES, STATIC_FILES,
  _test: Object.freeze({ anchorIdentity, assertAuthorityUnchanged, baseOutput, bindAccount, blockRef, buildAnvilArgs, calldata, canonicalStorageKey, capacityRows, childEnvironment,
    classifyFamily, createLocalRpc, createRpcLedger, decodeAddress, decodeBool, decodeReserve, decodeUint, decodeWords, ensureNoOverwrite, establish, evaluateGates, eventTopic,
    executeG6, hash32, keccakHex, localhost, orderedCalls, parseCli, parseHeader, parseInventory, payoutFor, provenance, qualify, relayParams, reserveUpdateEvidence, runAttempt, sanitized, secureIdentity,
    secureStartup, selector, staticAuthority, stopAnvil, terminalPinRechecks, validateConservation, validateOrderedCashPath, validateStartupEnvironment, validateTraceClosure,
    verifyAnvilIdentity, verifyLocalBinding }) });
if (require.main === module) runCli(process.argv.slice(2));
