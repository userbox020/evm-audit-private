#!/usr/bin/env node
"use strict";

// Builtins are the only modules loaded before local-file authority is established.
const crypto = require("node:crypto");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");

const FLAG = "--one-shot-r2-full-pool-preflight";
const ROOT = "/home/mruserbox/.local/share/evm-audit/morpho-pt-post-expiry-r2";
const SELF = `${ROOT}/tools/preflight-morpho-pt-27aug2026-post-expiry-r2-full-pool.js`;
const NODE = `${ROOT}/runtime/bin/node`;
const INVENTORY = "/mnt/c/_Work/__EVM_AUDIT/rpc_endpoints.txt";
const RUNNER = "C:\\_Work\\__EVM_AUDIT\\.runtime\\morpho-pt-post-expiry-r2\\morpho-pt-post-expiry-r2-full-pool-preflight-runner-win32.exe";
const RUNNER_SHA256 = "33db31277c403c18837f254a350996120c2cbaa97d9c944b312fbc3cfc1e2761";
const LAUNCHER = `${ROOT}/morpho-pt-post-expiry-r2-full-pool-preflight-launcher-linux`;
const LAUNCHER_SHA256 = "1c517e2f6b42dacd5e73c7ba171fde746a2615144003b5397d99b2a8395f3080";
const MAX_INVENTORY = 2 * 1024 * 1024;
const EXT4_MAGIC = 0xef53;
const MODULES = Object.freeze([
  ["tools/morpho-pt-27aug2026-post-expiry-r2-production-policy.js", "94b7f65cefa537639d4e172ada67365d290a54f8853254e4317e1718bad5c53f"],
  ["tools/morpho-pt-27aug2026-post-expiry-r1-profile.js", "7cd70f0888bc6c93b08a83b749904cf1f79e6f46abdc0d9455ddc8d400aa5db8"],
  ["tools/lib/r1-evm-read-gate.js", "c20d290fa053e23e561c5fee54c6e47709f3f812d83d60d7c879932e438bc5fe"],
  ["tools/lib/morpho-pt-27aug2026-post-expiry-r2-gate.js", "f54da668074b742f7838f75a6270d7eae7ad2c9b3f5a1ffc81d95150220e3b08"],
  ["tools/validate-morpho-pt-27aug2026-post-expiry-r2.js", "f43e69bc447e107f81b8a738dfebde808ef2e2e3927c3dd684fbdcadf11f4b69"],
  ["tools/preflight-all-chain-endpoints-v4.js", "171590a0ab5bc204a9a0fa8a750ba8adbe74684bd68e756e99a7e29b29067558"],
  ["tools/lib/morpho-pt-27aug2026-post-expiry-r2-production-adapter.js", "86c81e2c812a382785e935ab82d878f3cd707896131c037b22fa8dd83c4a1610"],
  ["tools/capture-morpho-pt-27aug2026-post-expiry-r2-production.js", "da578cceb8484597f173bb6e7a6bb36a56df1c865b17567ee00ada138b9ce56a"],
]);
const LOAD_ORDER = Object.freeze([0, 1, 2, 3, 4, 5, 6, 7]);
const LOCAL = Object.freeze(["HTTP_STATUS", "HTTP_BODY_LIMIT", "RPC_JSON", "RPC_ENVELOPE", "RESULT_SCHEMA", "CHAIN_ID_MISMATCH", "BLOCK_NUMBER_MISMATCH", "BLOCK_HASH_MISMATCH"]);
const GLOBAL = Object.freeze(["AUTHORITY", "ACCOUNTING", "DEADLINE", "REQUEST_CONTRACT", "SOCKET", "INTERNAL"]);
const RUNNER_SCHEMA = "morpho-pt-post-expiry-r2-full-pool-runner-authority/v2";

class PreflightError extends Error {
  constructor(code) { super(code); this.name = "PreflightError"; this.code = code; }
}
function fail(code) { throw new PreflightError(code); }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function canonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!object(value)) fail("AUTHORITY");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
function exact(value, keys, code = "AUTHORITY") {
  if (!object(value) || Object.keys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) fail(code);
}
function safeCode(error, adapter = null) {
  const raw = error && typeof error.code === "string" ? error.code : "INTERNAL";
  const code = raw === "POOL_QUORUM" ? raw : adapter ? adapter.normalizeFailure(error) : raw;
  return [...LOCAL, ...GLOBAL, "POOL_QUORUM"].includes(code) ? code : "INTERNAL";
}
function validateInvocation({ argv = process.argv, execArgv = process.execArgv, env = process.env, execPath = process.execPath } = {}) {
  if (execPath !== NODE || argv.length !== 3 || argv[0] !== NODE || argv[1] !== SELF || argv[2] !== FLAG || !Array.isArray(execArgv) || execArgv.length !== 0) fail("AUTHORITY");
  exact(env, ["LANG", "LC_ALL", "TZ"]);
  if (env.LANG !== "C.UTF-8" || env.LC_ALL !== "C.UTF-8" || env.TZ !== "UTC") fail("AUTHORITY");
  return true;
}
function readExactFd(fd, maximum) {
  const chunks = [];
  let size = 0;
  for (;;) {
    const chunk = Buffer.alloc(Math.min(4096, maximum + 1 - size));
    const count = fs.readSync(fd, chunk, 0, chunk.length, null);
    if (count === 0) break;
    size += count;
    if (size > maximum) fail("AUTHORITY");
    chunks.push(chunk.subarray(0, count));
  }
  return Buffer.concat(chunks);
}
function validateRunnerAttestation(value, sourceSha256) {
  exact(value, ["schema", "runnerPath", "runnerSelfSha256", "runnerSelfHashVerified", "launcherPath", "launcherSha256", "launcherHashVerified", "targetPath", "targetSha256", "targetAclQualified", "inventoryPath", "inventoryAclQualified"]);
  if (value.schema !== RUNNER_SCHEMA || value.runnerPath !== RUNNER || value.runnerSelfSha256 !== RUNNER_SHA256 || value.runnerSelfHashVerified !== true || value.launcherPath !== LAUNCHER || value.launcherSha256 !== LAUNCHER_SHA256 || value.launcherHashVerified !== true || value.targetPath !== SELF || value.targetSha256 !== sourceSha256 || value.targetAclQualified !== true || value.inventoryPath !== INVENTORY || value.inventoryAclQualified !== true) fail("AUTHORITY");
  return true;
}
function statTuple(stat) { return [String(stat.dev), String(stat.ino), String(stat.size), String(stat.mtimeNs ?? BigInt(Math.floor(stat.mtimeMs * 1e6)))]; }
function sameTuple(a, b) { return canonical(statTuple(a)) === canonical(statTuple(b)); }
function qualifyHeldFile(file, expectedHash, { requireExt4 = true, expectedDevice = null } = {}) {
  if (path.resolve(file) !== file || fs.realpathSync(file) !== file) fail("AUTHORITY");
  const before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== 1000n || before.nlink !== 1n || (before.mode & 0o22n) !== 0n || expectedDevice !== null && before.dev !== expectedDevice) fail("AUTHORITY");
  if (requireExt4 && Number(fs.statfsSync(file).type) !== EXT4_MAGIC) fail("AUTHORITY");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!sameTuple(before, opened)) fail("AUTHORITY");
    const bytes = readExactFd(fd, Math.max(Number(opened.size), 1));
    if (bytes.length !== Number(opened.size) || sha256(bytes) !== expectedHash) fail("AUTHORITY");
    const after = fs.lstatSync(file, { bigint: true });
    if (!sameTuple(opened, after)) fail("AUTHORITY");
    return { file, fd, bytes, dev: opened.dev };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}
function pinAuthority() {
  let attestation;
  try {
    const raw = readExactFd(3, 4096), text = raw.toString("utf8");
    attestation = JSON.parse(text);
    if (`${JSON.stringify(attestation)}\n` !== text) fail("AUTHORITY");
  } catch (_) { fail("AUTHORITY"); }
  if (!object(attestation) || !/^[0-9a-f]{64}$/u.test(attestation.targetSha256)) fail("AUTHORITY");
  let source, node;
  const held = [];
  try {
    source = qualifyHeldFile(SELF, attestation.targetSha256);
    const sourceSha256 = sha256(source.bytes);
    validateRunnerAttestation(attestation, sourceSha256);
    node = qualifyHeldFile(NODE, "53fb205ae78805130177e24bcb459a69a1518c8d98f8965f31d85aae7ea840fc", { expectedDevice: source.dev });
    for (const [relative, hash] of MODULES) held.push(qualifyHeldFile(`${ROOT}/${relative}`, hash, { expectedDevice: node.dev }));
    return { sourceSha256, source, node, held };
  } catch (error) {
    for (const item of held) try { fs.closeSync(item.fd); } catch (_) {}
    if (node) try { fs.closeSync(node.fd); } catch (_) {}
    if (source) try { fs.closeSync(source.fd); } catch (_) {}
    throw error;
  }
}
function loadPinned(authority) {
  const byPath = new Map(authority.held.map((item) => [item.file, item]));
  for (const index of LOAD_ORDER) {
    const filename = `${ROOT}/${MODULES[index][0]}`, item = byPath.get(filename);
    const loaded = new Module(filename, module);
    loaded.filename = filename;
    loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    require.cache[filename] = loaded;
    loaded._compile(item.bytes.toString("utf8"), filename);
  }
  const adapterPath = `${ROOT}/tools/lib/morpho-pt-27aug2026-post-expiry-r2-production-adapter.js`;
  const capturePath = `${ROOT}/tools/capture-morpho-pt-27aug2026-post-expiry-r2-production.js`;
  return { adapter: require.cache[adapterPath].exports, capture: require.cache[capturePath].exports, base: require.cache[`${ROOT}/tools/lib/r1-evm-read-gate.js`].exports };
}
function closeAuthority(authority) {
  for (const item of [...authority.held, authority.node, authority.source]) try { fs.closeSync(item.fd); } catch (_) {}
}
function readHeldInventory(file = INVENTORY) {
  if (file !== INVENTORY || fs.realpathSync(file) !== file) fail("AUTHORITY");
  const before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 2n || before.size > BigInt(MAX_INVENTORY)) fail("AUTHORITY");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!sameTuple(before, opened)) fail("AUTHORITY");
    const bytes = readExactFd(fd, MAX_INVENTORY);
    if (bytes.length !== Number(opened.size)) fail("AUTHORITY");
    const eof = Buffer.alloc(1);
    if (fs.readSync(fd, eof, 0, 1, null) !== 0) fail("AUTHORITY");
    const after = fs.lstatSync(file, { bigint: true });
    if (!sameTuple(opened, after)) fail("AUTHORITY");
    return bytes;
  } finally { fs.closeSync(fd); }
}
function zeroCounters() { return { dns: 0, socket: 0, connect: 0, tls: 0, data: 0, requestDestroyed: 0, socketDestroyed: 0, agentDestroyed: 0 }; }
function reconstructFailedPool(trace, handles, base, nowMs) {
  const methods = ["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_call"], stages = ["POOL_CHAIN_ID", "POOL_FINALIZED", "POOL_CODE", "POOL_EXPIRY"], ledger = [], outcomes = [];
  let cursor = 0;
  for (let poolIndex = 0; poolIndex < 8; poolIndex++) {
    const rows = [], handle = handles[poolIndex]; let failed = null, finalized = null;
    for (let attemptIndex = 0; attemptIndex < 4; attemptIndex++) {
      if (failed) { rows.push({ poolIndex, attemptIndex, stage: stages[attemptIndex], method: methods[attemptIndex], blockTag: attemptIndex === 1 ? "finalized" : null, blockHash: null, outcome: "SKIP", reason: "CANDIDATE_FAILED" }); continue; }
      const row = trace[cursor];
      if (!row || row.handle !== handle || row.method !== methods[attemptIndex]) { failed = "NOT_ATTEMPTED"; rows.push({ poolIndex, attemptIndex, stage: stages[attemptIndex], method: methods[attemptIndex], blockTag: attemptIndex === 1 ? "finalized" : null, blockHash: null, outcome: "SKIP", reason: "CANDIDATE_FAILED" }); continue; }
      cursor++;
      const item = { poolIndex, attemptIndex, stage: stages[attemptIndex], method: row.method, blockTag: attemptIndex === 1 ? "finalized" : null, blockHash: attemptIndex >= 2 && finalized ? finalized.hash : null, outcome: row.outcome, bytes: row.bytes, elapsedMs: row.elapsedMs, counters: row.counters, transportClass: row.transportClass };
      if (row.outcome === "FAIL") { item.reason = row.reason; failed = row.reason; }
      else {
        try {
          if (attemptIndex === 0 && row.result !== "0x1") failed = typeof row.result === "string" && /^(?:0x0|0x[1-9a-f][0-9a-f]*)$/iu.test(row.result) ? "CHAIN_ID_MISMATCH" : "RESULT_SCHEMA";
          if (attemptIndex === 1) {
            finalized = base.parseHeader(row.result);
            const now = Math.floor(nowMs / 1000);
            if (finalized.timestamp < 1787788800 || finalized.timestamp < now - 3600 || finalized.timestamp > now + 60) failed = "RESULT_SCHEMA";
          }
          if (attemptIndex === 2 && (typeof row.result !== "string" || !/^0x(?:[0-9a-f]{2})+$/u.test(row.result))) failed = "RESULT_SCHEMA";
          if (attemptIndex === 3 && (typeof row.result !== "string" || !/^0x[0-9a-f]{64}$/u.test(row.result) || BigInt(row.result) !== 1787788800n)) failed = "RESULT_SCHEMA";
        } catch (_) { failed = "RESULT_SCHEMA"; }
        if (failed) { item.outcome = "FAIL"; item.reason = failed; }
      }
      rows.push(item);
    }
    ledger.push(...rows);
    outcomes.push({ poolIndex, passed: failed === null, reason: failed, attempts: 4 });
  }
  return { ledger, outcomes };
}
function buildOutput(status, outcomes, selectedPoolIndices, accounting, ledger, adapter, secrets) {
  const nonSkip = ledger.filter((row) => row.outcome !== "SKIP");
  const bytes = nonSkip.reduce((sum, row) => sum + row.bytes, 0), requests = nonSkip.length;
  if (requests !== accounting.requests || bytes !== accounting.responseBytes || requests > 32 || accounting.maxConcurrency > 1) fail("ACCOUNTING");
  const slots = Array.from({ length: 8 }, (_, poolIndex) => {
    const outcome = outcomes.find((row) => row.poolIndex === poolIndex), attempted = ledger.filter((row) => row.poolIndex === poolIndex && row.outcome !== "SKIP").length;
    const passed = outcome && outcome.passed === true;
    const reason = passed ? null : GLOBAL.includes(status) ? status : outcome?.reason || "INTERNAL";
    return { poolIndex, outcome: passed ? "PASS" : "FAIL", failureClass: passed ? null : LOCAL.includes(reason) ? "LOCAL" : "GLOBAL", reason, attempted };
  });
  const output = { status, slots, selectedPoolIndices: [...selectedPoolIndices], aggregate: { requests, responseBytes: bytes, maxConcurrency: accounting.maxConcurrency, retries: 0 } };
  const serialized = `${JSON.stringify(output)}\n`;
  adapter.assertSanitized(serialized, secrets);
  if (/(?:https?|wss):\/\/|"(?:operatorFamily|family|endpoint|headers?|stack|rawError|sha256)"\s*:/iu.test(serialized)) fail("INTERNAL");
  return { output, serialized };
}
async function runPool({ inventoryBytes, adapter, base, resolveDns, httpPost, clock = Date.now }) {
  const rows = adapter.parseInventory(inventoryBytes), secrets = adapter.collectSensitiveStrings(rows), handles = adapter.selectCandidates(rows);
  const deadline = adapter.createDeadline(clock, 120000), pins = await adapter.resolvePins(handles, { resolve: resolveDns, deadline }), trace = [], productionAccounting = adapter.account(), usage = { direct: 0, relay: 0, dnsQualifications: pins.size, counters: zeroCounters() };
  const transport = adapter.createTransport(httpPost, { pins, deadline, accounting: productionAccounting, trace, usage });
  let attempts = 0;
  const bounded = async (...args) => { if (++attempts > 32) fail("ACCOUNTING"); return transport(...args); };
  try {
    const pool = await adapter.qualifyPool(handles, bounded, clock), accounting = productionAccounting.summary(handles);
    if (attempts !== accounting.requests || attempts > 32) fail("ACCOUNTING");
    return buildOutput("POOL_READY", pool.outcomes.map(({ poolIndex, passed, reason, attempts: count }) => ({ poolIndex, passed, reason, attempts: count })), pool.selectedPoolIndices, accounting, pool.ledger, adapter, secrets);
  } catch (error) {
    const code = safeCode(error, adapter), accounting = productionAccounting.summary(handles);
    if (attempts !== accounting.requests || attempts > 32) fail("ACCOUNTING");
    if (GLOBAL.includes(code)) {
      const reconstructed = reconstructFailedPool(trace, handles, base, clock());
      return buildOutput(code, reconstructed.outcomes, [], accounting, reconstructed.ledger.filter((row) => row.outcome !== "SKIP" || row.poolIndex < Math.ceil(attempts / 4)), adapter, secrets);
    }
    if (code !== "POOL_QUORUM") throw error;
    const reconstructed = reconstructFailedPool(trace, handles, base, clock());
    return buildOutput("POOL_NO_QUORUM", reconstructed.outcomes, [], accounting, reconstructed.ledger, adapter, secrets);
  }
}
async function main() {
  let authority, loaded;
  try {
    validateInvocation();
    authority = pinAuthority();
    loaded = loadPinned(authority);
    const inventoryBytes = readHeldInventory();
    const result = await runPool({ inventoryBytes, adapter: loaded.adapter, base: loaded.base, resolveDns: loaded.capture.resolveDns, httpPost: loaded.capture.strictRequest, clock: Date.now });
    process.stdout.write(result.serialized);
  } catch (error) {
    const code = safeCode(error, loaded?.adapter);
    const fallback = { status: code, slots: Array.from({ length: 8 }, (_, poolIndex) => ({ poolIndex, outcome: "FAIL", failureClass: "GLOBAL", reason: code, attempted: 0 })), selectedPoolIndices: [], aggregate: { requests: 0, responseBytes: 0, maxConcurrency: 0, retries: 0 } };
    process.stdout.write(`${JSON.stringify(fallback)}\n`);
    process.exitCode = 2;
  } finally { if (authority) closeAuthority(authority); }
}

if (require.main === module) main();
module.exports = { FLAG, ROOT, SELF, NODE, INVENTORY, RUNNER, RUNNER_SHA256, LAUNCHER, LAUNCHER_SHA256, MODULES, LOCAL, GLOBAL, RUNNER_SCHEMA, PreflightError, canonical, validateInvocation, validateRunnerAttestation, reconstructFailedPool, buildOutput, runPool };
