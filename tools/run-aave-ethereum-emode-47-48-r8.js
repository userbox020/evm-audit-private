#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { keccak256 } = require("ethers");

const ROOT = path.resolve(__dirname, "..");
const SCHEMA = "aave-ethereum-emode-47-48-r8/v1";
const OUTPUT = "reports/raw/fast/aave-ethereum-emode-47-48-r8.json";
const ATTEMPT = "reports/raw/fast/aave-ethereum-emode-47-48-r8-attempt.json";
const RUNNER = "tools/run-aave-ethereum-emode-47-48-r8.js";
const TEST = "tools/test-run-aave-ethereum-emode-47-48-r8.js";
const R5_REPORT = "reports/raw/fast/aave-ethereum-emode-47-48-r5.json";
const R6_REPORT = "reports/raw/fast/aave-ethereum-emode-47-48-r6-offline/report.json";
const R6_RUNTIMES = "reports/raw/fast/aave-ethereum-emode-47-48-r6-offline/observed-runtimes.json";
const R7_REPORT = "reports/raw/fast/aave-ethereum-emode-47-48-r7-source/report.json";
const PINS = Object.freeze({
  "tools/run-aave-ethereum-emode-47-48-r4.js": "d779025828cfeaf914bc3b08a2b44c7ce865317d42b172decd506e2387d7444a",
  "tools/run-aave-ethereum-emode-47-48-r5.js": "2b0678fea95aca0203a52ff502603eddcc8ea1c7f64b25ba81ed723d9ac39ed5",
  [R5_REPORT]: "75d205ff5178a733482fc55bb04313425573c256e8cc0aef4873d47fce809c45",
  [R6_REPORT]: "5a89a7e4adc064538f102198c904d978f6000ed590c633f0950cabb11e74927f",
  [R6_RUNTIMES]: "660fea40a848bce909e461954d966288658c76c5c5be652f98d523adc9f376fe",
  "reports/raw/fast/aave-ethereum-emode-47-48-r6-offline/core.output.json": "3a2fe9001b16f071adc7097a858415858195930768f9d7aaa330449c5d63ba29",
  [R7_REPORT]: "1e369169994062fdb70a0f191bd93de7f71cfe1a741d55795ff72eea13bcdd61",
  "tools/lib/common-finalized-rpc-preflight.js": "febeb98a013e652afda6196f9173823b02c2e5c88ebb7a1ac6bb6bd6e5b86673",
  "tools/preflight-all-chain-endpoints-v4.js": "171590a0ab5bc204a9a0fa8a750ba8adbe74684bd68e756e99a7e29b29067558",
  "tools/run-aave-ethereum-emode-47-48-r3.js": "4a1eee450e7e2f41c873d7d36d4aef8d118f817ba459c1bf88049b80da483d29"
});
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const stable = (value) => Array.isArray(value) ? `[${value.map(stable).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`
    : JSON.stringify(value);

function pinnedRead(relative, expected, root = ROOT) {
  const file = path.join(root, relative), before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > 8 * 1024 * 1024
    || path.resolve(fs.realpathSync(file)) !== path.resolve(file)) throw new Error("SOURCE_PIN_MISMATCH");
  const bytes = fs.readFileSync(file), after = fs.lstatSync(file);
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || sha256(bytes) !== expected) throw new Error("SOURCE_PIN_MISMATCH");
  return bytes;
}

pinnedRead("tools/run-aave-ethereum-emode-47-48-r4.js", PINS["tools/run-aave-ethereum-emode-47-48-r4.js"]);
const r4 = require("./run-aave-ethereum-emode-47-48-r4.js");
const { A, PIN, BLOCK } = r4;
const CODES = new Set(["NONE", "SOURCE_PIN_MISMATCH", "INPUT_INVALID", "CHAIN_MISMATCH", "FINALITY_UNAVAILABLE",
  "HISTORICAL_HEADER_MISMATCH", "RPC_UNAVAILABLE", "CODE_INVALID", "BYTECODE_INVALID", "HISTORICAL_CODE_CONSENSUS_UNAVAILABLE",
  "TERMINAL_RECHECK_FAILED", "NETWORK_CALL_CAP", "REQUEST_FORBIDDEN", "BYTE_CAP", "WALL_CAP", "OUTPUT_INVALID", "ATTEMPT_CONSUMED",
  "INVOCATION_INVALID", "UNEXPECTED"]);
class R8Error extends Error { constructor(code) { super(CODES.has(code) ? code : "UNEXPECTED"); this.code = this.message; } }
const fail = (code) => { throw new R8Error(code); };
const safeCode = (error) => error instanceof R8Error ? error.code : error instanceof r4.R4Error && CODES.has(error.code) ? error.code : "UNEXPECTED";
const LIMITS = Object.freeze({ candidates: 8, calls: 48, outputBytes: 131072 });
const GATES = Object.freeze({ hubHistoricalCodeCorroborated: false, hubHistoricalFullExplorerMatch: false,
  hubHistoricalExecutableSourceBound: false, agentExactRuntimeMatch: true, rangeHistoricalExecutableSourceBound: true,
  completeRuntimeBinding: false, completeAuthorityVerification: false, effectiveRangeSemanticsBound: false,
  routePositive: "unknown", executableNow: "unknown", signedActionJustified: false, fork: false });
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join() === [...keys].sort().join();
const quantity = (value) => `0x${value.toString(16)}`;
const fatalCode = (code) => ["BYTE_CAP", "WALL_CAP", "NETWORK_CALL_CAP", "REQUEST_FORBIDDEN"].includes(code);

function fullIdentity(code) {
  if (typeof code !== "string" || !/^0x(?:[0-9a-f]{2})+$/i.test(code) || code.length > 131074) fail("CODE_INVALID");
  return Object.freeze({ bytes: (code.length - 2) / 2, keccak256: keccak256(code.toLowerCase()) });
}
function readAuthority() {
  const bytes = Object.fromEntries(Object.entries(PINS).map(([file, hash]) => [file, pinnedRead(file, hash)]));
  const r5 = JSON.parse(bytes[R5_REPORT]), r6 = JSON.parse(bytes[R6_REPORT]), runtimes = JSON.parse(bytes[R6_RUNTIMES]), r7 = JSON.parse(bytes[R7_REPORT]);
  if (r5.report?.status !== "CORROBORATED_IMPLEMENTATION_SLOT" || r5.report?.implementation?.address !== A.hubImplementation
    || stable(r5.report.targetPin) !== stable(PIN) || r6.status !== "OFFLINE_BUILD_COMPLETE" || stable(r6.historicalPin) !== stable(PIN)
    || r6.files?.["observed-runtimes.json"] !== PINS[R6_RUNTIMES] || r6.files?.["core.output.json"] !== PINS["reports/raw/fast/aave-ethereum-emode-47-48-r6-offline/core.output.json"]
    || r6.core?.AgentHub?.explorerComparison?.normalizedRuntimeMatch !== true || r7.gates?.agentExactRuntimeMatch !== true) fail("INPUT_INVALID");
  const retainedCode = runtimes.AgentHub?.runtime;
  const retained = fullIdentity(retainedCode), parsed = r4.codeIdentity(retainedCode);
  const compiledParsed = r4.codeIdentity(`0x${JSON.parse(bytes["reports/raw/fast/aave-ethereum-emode-47-48-r6-offline/core.output.json"])
    .contracts["src/contracts/AgentHub.sol"].AgentHub.evm.deployedBytecode.object}`);
  const expected = r6.core.AgentHub.explorerComparison.observedFullRuntime;
  if (retained.keccak256 !== runtimes.AgentHub.runtimeKeccak256 || stable(retained) !== stable(expected)
    || parsed.executableBytes !== r6.core.AgentHub.bytes - 53
    || parsed.executableKeccak256 !== compiledParsed.executableKeccak256) fail("INPUT_INVALID");
  return Object.freeze({ retainedCode: retainedCode.toLowerCase(), retained, retainedParsed: parsed,
    compiled: Object.freeze({ bytes: r6.core.AgentHub.bytes, keccak256: r6.core.AgentHub.keccak256,
      executableBytes: compiledParsed.executableBytes, executableKeccak256: compiledParsed.executableKeccak256 }), sourceHashes: { ...PINS } });
}
function allowRequest(method, params) {
  let ok = Array.isArray(params);
  if (method === "eth_chainId") ok = ok && params.length === 0;
  else if (method === "eth_getBlockByNumber") ok = ok && params.length === 2 && params[1] === false && ["finalized", quantity(PIN.number)].includes(params[0]);
  else if (method === "eth_getCode") ok = ok && stable(params) === stable([A.hubImplementation, BLOCK]);
  else ok = false;
  if (!ok) fail("REQUEST_FORBIDDEN");
}
function checkHeader(raw, pf) {
  if (stable(pf.normalizeHeader(raw)) !== stable(PIN)) fail("HISTORICAL_HEADER_MISMATCH");
}
function checkFinality(raw, pf) {
  const header = pf.normalizeHeader(raw);
  if (!header || header.number < PIN.number || header.number === PIN.number && stable(header) !== stable(PIN)) fail("FINALITY_UNAVAILABLE");
}
async function observe(handle, call, pf) {
  if (await call(handle, "eth_chainId", [], 3500) !== "0x1") fail("CHAIN_MISMATCH");
  checkFinality(await call(handle, "eth_getBlockByNumber", ["finalized", false], 6000), pf);
  checkHeader(await call(handle, "eth_getBlockByNumber", [quantity(PIN.number), false], 6000), pf);
  const code = await call(handle, "eth_getCode", [A.hubImplementation, BLOCK], 8000);
  fullIdentity(code);
  const identity = r4.codeIdentity(code.toLowerCase());
  checkHeader(await call(handle, "eth_getBlockByNumber", [quantity(PIN.number), false], 6000), pf);
  return Object.freeze({ identity, code: code.toLowerCase() });
}
function template(now) {
  return { schema: SCHEMA, status: "INCOMPLETE", code: "HISTORICAL_CODE_CONSENSUS_UNAVAILABLE", generatedAt: new Date(now()).toISOString(),
    pin: PIN, implementation: A.hubImplementation, selectedFamilyCount: 0, callsUsed: 0, diagnostics: [], terminal: [], observation: null,
    comparisons: null, failureCounts: {}, gates: { ...GATES }, limitations: ["Historical fixed-pin provider-attested code only; not a state-root proof.",
      "Provider-family classification does not establish backend independence.", "Full Hub governance, ConfigEngine and oracle authority remain unverified.",
      "No current executability, position, stress, transaction, signing, broadcast or state-mutation claim."] };
}
function failureCounts(report) {
  const out = {};
  for (const row of [...report.diagnostics, ...report.terminal]) if (row.code !== "NONE") out[`${row.stage}:${row.code}`] = (out[`${row.stage}:${row.code}`] || 0) + 1;
  return out;
}
async function collect({ candidates, rawCall, authority, pf, now = Date.now }) {
  if (!Array.isArray(candidates) || candidates.length < 2 || candidates.length > LIMITS.candidates || typeof rawCall !== "function"
    || candidates.some((candidate) => !candidate || pf.reviewedOperatorFamily(candidate.operatorFamily) !== candidate.operatorFamily)
    || new Set(candidates.map((candidate) => candidate.handle)).size !== candidates.length) fail("INPUT_INVALID");
  const report = template(now), groups = new Map(); let selected = null;
  const call = async (row, handle, method, params, timeout) => {
    allowRequest(method, params); if (report.callsUsed >= LIMITS.calls) fail("NETWORK_CALL_CAP");
    report.callsUsed += 1; row.calls += 1; return rawCall(handle, method, params, timeout);
  };
  for (let ordinal = 0; ordinal < candidates.length; ordinal += 1) {
    const candidate = candidates[ordinal], row = { ordinal, stage: "CHAIN_ID", code: "NONE", calls: 0, identity: null };
    report.diagnostics.push(row); let headerReads = 0;
    try {
      const observation = await observe(candidate.handle, async (handle, method, params, timeout) => {
        row.stage = method === "eth_chainId" ? "CHAIN_ID" : method === "eth_getCode" ? "IMPLEMENTATION_CODE"
          : params[0] === "finalized" ? "FINALITY" : ++headerReads === 1 ? "HISTORICAL_HEADER" : "POST_HEADER";
        return call(row, handle, method, params, timeout);
      }, pf);
      row.identity = observation.identity; row.stage = "COMPLETE";
      const key = stable(observation.identity), group = groups.get(key) || [];
      if (!group.some((entry) => entry.candidate.operatorFamily === candidate.operatorFamily)) group.push({ candidate, row, observation });
      groups.set(key, group); if (group.length === 2) { selected = group; break; }
    } catch (error) {
      row.code = safeCode(error); if (fatalCode(row.code)) { report.status = "INCOMPLETE"; report.code = row.code; break; }
    }
  }
  if (selected && !fatalCode(report.code)) {
    for (const entry of selected) {
      const row = { ordinal: entry.row.ordinal, stage: "TERMINAL_FINALITY", code: "NONE", calls: 0, identity: null }; report.terminal.push(row);
      const request = async (method, params, timeout) => { allowRequest(method, params); if (report.callsUsed >= LIMITS.calls) fail("NETWORK_CALL_CAP"); report.callsUsed += 1; row.calls += 1; return rawCall(entry.candidate.handle, method, params, timeout); };
      try {
        checkFinality(await request("eth_getBlockByNumber", ["finalized", false], 6000), pf);
        row.stage = "TERMINAL_HEADER"; checkHeader(await request("eth_getBlockByNumber", [quantity(PIN.number), false], 6000), pf);
        row.stage = "TERMINAL_CODE";
        const code = await request("eth_getCode", [A.hubImplementation, BLOCK], 8000);
        fullIdentity(code); row.identity = r4.codeIdentity(code.toLowerCase());
        if (stable(row.identity) !== stable(entry.observation.identity)) fail("TERMINAL_RECHECK_FAILED");
        row.stage = "TERMINAL_POST_HEADER"; checkHeader(await request("eth_getBlockByNumber", [quantity(PIN.number), false], 6000), pf);
        row.stage = "COMPLETE";
      } catch (error) { row.code = safeCode(error); report.status = "INCOMPLETE"; report.code = row.code; selected = null; break; }
    }
  }
  if (selected) {
    const identity = selected[0].observation.identity;
    const exact = identity.bytes === authority.retained.bytes && identity.keccak256 === authority.retained.keccak256;
    const executable = identity.executableBytes === authority.compiled.executableBytes && identity.executableKeccak256 === authority.compiled.executableKeccak256;
    report.status = "CORROBORATED_HISTORICAL_HUB_CODE"; report.code = "NONE"; report.selectedFamilyCount = 2; report.observation = identity;
    report.comparisons = { exactRetainedExplorerRuntime: exact, normalizedExecutableSourceMatch: executable,
      retainedExplorer: authority.retainedParsed, compiledSource: authority.compiled };
    report.gates = { ...GATES, hubHistoricalCodeCorroborated: true, hubHistoricalFullExplorerMatch: exact,
      hubHistoricalExecutableSourceBound: executable };
  }
  report.failureCounts = failureCounts(report); return report;
}
function validateReport(report, authority = readAuthority()) {
  const success = report?.status === "CORROBORATED_HISTORICAL_HUB_CODE";
  const baseKeys = ["schema", "status", "code", "generatedAt", "pin", "implementation", "selectedFamilyCount", "callsUsed", "diagnostics",
    "terminal", "observation", "comparisons", "failureCounts", "gates", "limitations"];
  const published = Object.hasOwn(report || {}, "executionMode");
  if (!exactKeys(report, published ? [...baseKeys, "executionMode", "inventoryReadAttempts", "inventoryReads", "transportRequestAttempts", "responseBytes", "sourceHashes"] : baseKeys)
    || report.schema !== SCHEMA || !["INCOMPLETE", "CORROBORATED_HISTORICAL_HUB_CODE"].includes(report.status)
    || !Number.isFinite(Date.parse(report.generatedAt)) || stable(report.pin) !== stable(PIN) || report.implementation !== A.hubImplementation
    || !Number.isInteger(report.callsUsed) || report.callsUsed < 0 || report.callsUsed > LIMITS.calls || !Array.isArray(report.diagnostics)
    || report.diagnostics.length > LIMITS.candidates || !Array.isArray(report.terminal) || report.terminal.length > 2) fail("OUTPUT_INVALID");
  for (const [index, row] of [...report.diagnostics, ...report.terminal].entries()) {
    const terminal = index >= report.diagnostics.length, stages = terminal
      ? ["TERMINAL_FINALITY", "TERMINAL_HEADER", "TERMINAL_CODE", "TERMINAL_POST_HEADER", "COMPLETE"]
      : ["CHAIN_ID", "FINALITY", "HISTORICAL_HEADER", "IMPLEMENTATION_CODE", "POST_HEADER", "COMPLETE"];
    const stageCalls = terminal ? { TERMINAL_FINALITY: 1, TERMINAL_HEADER: 2, TERMINAL_CODE: 3, TERMINAL_POST_HEADER: 4, COMPLETE: 4 }
      : { CHAIN_ID: 1, FINALITY: 2, HISTORICAL_HEADER: 3, IMPLEMENTATION_CODE: 4, POST_HEADER: 5, COMPLETE: 5 };
    if (!exactKeys(row, ["ordinal", "stage", "code", "calls", "identity"]) || !stages.includes(row.stage) || !CODES.has(row.code)
      || !Number.isInteger(row.calls) || row.calls < 0 || row.calls > (terminal ? 4 : 5) || (row.code === "NONE") !== (row.stage === "COMPLETE")
      || row.calls !== stageCalls[row.stage] || !Number.isInteger(row.ordinal) || row.ordinal < 0 || row.ordinal >= report.diagnostics.length
      || !terminal && (row.ordinal !== index || (row.stage === "COMPLETE") !== (row.identity !== null))
      || terminal && (row.stage === "COMPLETE" && row.identity === null
        || ["TERMINAL_FINALITY", "TERMINAL_HEADER"].includes(row.stage) && row.identity !== null
        || row.stage === "TERMINAL_POST_HEADER" && row.identity === null)
      || row.identity !== null && (!exactKeys(row.identity, ["bytes", "keccak256", "executableBytes", "executableKeccak256", "metadataHex"])
        || !Number.isInteger(row.identity.bytes) || row.identity.bytes < 54 || row.identity.bytes > 65536
        || row.identity.executableBytes !== row.identity.bytes - 53 || !/^0x[0-9a-f]{64}$/.test(row.identity.keccak256)
        || !/^0x[0-9a-f]{64}$/.test(row.identity.executableKeccak256)
        || !/^0xa2646970667358221220[0-9a-f]{64}64736f6c634300081b0033$/.test(row.identity.metadataHex))) fail("OUTPUT_INVALID");
  }
  if (report.callsUsed !== [...report.diagnostics, ...report.terminal].reduce((sum, row) => sum + row.calls, 0)
    || stable(report.failureCounts) !== stable(failureCounts(report)) || !Array.isArray(report.limitations) || report.limitations.length !== 4) fail("OUTPUT_INVALID");
  if (success) {
    const exact = report.observation.bytes === authority.retained.bytes && report.observation.keccak256 === authority.retained.keccak256;
    const executable = report.observation.executableBytes === authority.compiled.executableBytes
      && report.observation.executableKeccak256 === authority.compiled.executableKeccak256;
    const ordinals = report.terminal.map((row) => row.ordinal);
    if (report.code !== "NONE" || report.selectedFamilyCount !== 2 || report.terminal.length !== 2 || new Set(ordinals).size !== 2
      || report.terminal.some((row) => row.stage !== "COMPLETE" || stable(row.identity) !== stable(report.observation)
        || report.diagnostics[row.ordinal]?.stage !== "COMPLETE" || stable(report.diagnostics[row.ordinal].identity) !== stable(report.observation))
      || !exactKeys(report.comparisons,
      ["exactRetainedExplorerRuntime", "normalizedExecutableSourceMatch", "retainedExplorer", "compiledSource"])
      || stable(report.comparisons) !== stable({ exactRetainedExplorerRuntime: exact, normalizedExecutableSourceMatch: executable,
        retainedExplorer: authority.retainedParsed, compiledSource: authority.compiled })
      || stable(report.gates) !== stable({ ...GATES, hubHistoricalCodeCorroborated: true, hubHistoricalFullExplorerMatch: exact,
        hubHistoricalExecutableSourceBound: executable })) fail("OUTPUT_INVALID");
  } else if (report.code === "NONE" || report.selectedFamilyCount !== 0 || report.observation !== null || report.comparisons !== null
    || stable(report.gates) !== stable(GATES)) fail("OUTPUT_INVALID");
  if (published) {
    if (!["production", "injected"].includes(report.executionMode) || !Number.isInteger(report.inventoryReadAttempts)
      || report.inventoryReadAttempts < 0 || report.inventoryReadAttempts > 1 || !Number.isInteger(report.inventoryReads)
      || report.inventoryReads < 0 || report.inventoryReads > report.inventoryReadAttempts || report.transportRequestAttempts !== report.callsUsed
      || report.executionMode === "injected" && (report.inventoryReadAttempts !== 0 || report.responseBytes !== null)
      || report.executionMode === "production" && (!Number.isInteger(report.responseBytes) || report.responseBytes < 0 || report.inventoryReadAttempts !== 1 || report.inventoryReads !== 1)
      || !report.sourceHashes || Object.entries(report.sourceHashes).some(([file, hash]) => file.split(/[\\/]/).includes("..") || !/^[a-zA-Z0-9_./-]+$/.test(file) || !/^[0-9a-f]{64}$/.test(hash))) fail("OUTPUT_INVALID");
  }
  if (Buffer.byteLength(stable(report)) > LIMITS.outputBytes || /https?:\/\/|authorization|bearer\s|api[_-]?key/i.test(stable(report))) fail("OUTPUT_INVALID");
  return true;
}
async function runOnce(options = {}) {
  const injected = Object.keys(options).length !== 0;
  if (injected && (typeof options.rawCall !== "function" || !Array.isArray(options.candidates) || typeof options.root !== "string"
    || path.resolve(options.root) === ROOT || path.resolve(fs.realpathSync(options.root)) === ROOT)) fail("INPUT_INVALID");
  if (!injected && require.main !== module) fail("INVOCATION_INVALID");
  const authority = readAuthority(), root = injected ? path.resolve(options.root) : ROOT, now = options.now || Date.now;
  const sourceHashes = { ...authority.sourceHashes, [RUNNER]: sha256(fs.readFileSync(__filename)), [TEST]: sha256(fs.readFileSync(path.join(ROOT, TEST))) };
  const inventory = require("./preflight-all-chain-endpoints-v4.js");
  try { inventory.safeParent(root, OUTPUT, { create: false }); } catch (_) { fail("OUTPUT_INVALID"); }
  const output = path.join(root, OUTPUT), attempt = path.join(root, ATTEMPT), executionMode = injected ? "injected" : "production";
  if (fs.existsSync(output) || fs.existsSync(attempt)) fail("ATTEMPT_CONSUMED");
  r4.writeExclusive(attempt, { schema: `${SCHEMA}/attempt`, executionMode, startedAt: new Date(now()).toISOString(), allowedRuns: 1, retries: 0, sourceHashes });
  let report, transport, inventoryReadAttempts = 0, inventoryReads = 0, calls = 0;
  try {
    let candidates;
    if (injected) candidates = options.candidates;
    else {
      inventoryReadAttempts += 1; const source = inventory.readSource("rpc_endpoints.txt", { root }); inventoryReads += 1;
      candidates = require("./run-aave-ethereum-emode-47-48-r3.js").selectCandidates(inventory.parsePrimaryRpcGrammar(source.text).records);
      transport = r4.createTransport(candidates);
    }
    const pf = require("./lib/common-finalized-rpc-preflight.js"), rawCall = options.rawCall || transport.call.bind(transport);
    report = await collect({ candidates, rawCall: (...args) => { calls += 1; return rawCall(...args); }, authority, pf, now });
  } catch (error) {
    report = template(now); report.code = safeCode(error);
  }
  report = { ...report, executionMode, inventoryReadAttempts, inventoryReads, transportRequestAttempts: injected ? calls : transport?.stats.calls || 0,
    responseBytes: injected ? null : transport?.stats.responseBytes || 0, sourceHashes };
  for (const [file, hash] of Object.entries(sourceHashes)) pinnedRead(file, hash);
  validateReport(report, authority); const envelope = { sha256: sha256(stable(report)), report }; r4.writeExclusive(output, envelope); return envelope;
}
async function main(argv = process.argv.slice(2)) {
  try {
    if (argv.length !== 1 || !["--check", "--run-once"].includes(argv[0]) || process.execArgv.length
      || ["NODE_OPTIONS", "NODE_DEBUG", "NODE_DEBUG_NATIVE", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_USE_ENV_PROXY", "SSLKEYLOGFILE"].some((name) => process.env[name])) fail("INVOCATION_INVALID");
    if (argv[0] === "--check") { const authority = readAuthority(); console.log(JSON.stringify({ status: "OFFLINE_INPUT_CHECK_PASS", sourcePins: Object.keys(authority.sourceHashes).length, network: false })); return; }
    const result = await runOnce(); console.log(JSON.stringify({ status: result.report.status, code: result.report.code, callsUsed: result.report.callsUsed,
      comparisons: result.report.comparisons, output: OUTPUT, sha256: result.sha256 })); if (result.report.status === "INCOMPLETE") process.exitCode = 2;
  } catch (error) { console.log(JSON.stringify({ status: "REFUSED_OR_FAILED", code: safeCode(error) })); process.exitCode = 2; }
}
if (require.main === module) main();
module.exports = { ROOT, SCHEMA, OUTPUT, ATTEMPT, PINS, LIMITS, GATES, r4, R8Error, safeCode, fullIdentity, readAuthority,
  allowRequest, observe, collect, validateReport, failureCounts, runOnce };
