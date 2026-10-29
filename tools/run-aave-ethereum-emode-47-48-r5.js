#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const ROOT = path.resolve(__dirname, "..");
const SCHEMA = "aave-ethereum-emode-47-48-r5/v1";
const OUTPUT = "reports/raw/fast/aave-ethereum-emode-47-48-r5.json";
const ATTEMPT = "reports/raw/fast/aave-ethereum-emode-47-48-r5-attempt.json";
const RUNNER = "tools/run-aave-ethereum-emode-47-48-r5.js";
const TEST = "tools/test-run-aave-ethereum-emode-47-48-r5.js";
const R4_REPORT = "reports/raw/fast/aave-ethereum-emode-47-48-r4.json";
const PINS = Object.freeze({
  "tools/run-aave-ethereum-emode-47-48-r4.js": "d779025828cfeaf914bc3b08a2b44c7ce865317d42b172decd506e2387d7444a",
  "tools/test-run-aave-ethereum-emode-47-48-r4.js": "7c6fe7109f5577f43d2950b5a2f52cfb9d9a4574513d485ddb7ae8cf7f8cfa5f",
  [R4_REPORT]: "ea079f29b145b872b01eba8c0772b79c48d6beb6967468f1ccb78a769f9a2eae",
  "reports/raw/fast/aave-ethereum-emode-47-48-r4-attempt.json": "121b51edc3cf30e1d49c3acf80bef82e5f82fc7d3fef1c246bad900c70f8bbb4",
  "reports/raw/fast/aave-ethereum-emode-47-48-r3-attempt.json": "e6c0abc363e8fc131007721a9077e5a44854bab5d8c9e4ced553bc51df0855a8",
  "tools/test-run-aave-ethereum-emode-47-48-r3.js": "e1b4920830daaad3f0cebd34fae135afe5aee8fbd1b5c3c824a8c7ba2fd5d4e6"
});
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
function pinnedRead(relative, hash) {
  const file = path.join(ROOT, relative), before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > 8 * 1024 * 1024 || path.resolve(fs.realpathSync(file)) !== path.resolve(file)) throw new Error("SOURCE_PIN_MISMATCH");
  const bytes = fs.readFileSync(file), after = fs.lstatSync(file);
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || sha256(bytes) !== hash) throw new Error("SOURCE_PIN_MISMATCH");
  return bytes;
}
// Verify before loading the shared code; never call either previous runOnce().
pinnedRead("tools/run-aave-ethereum-emode-47-48-r4.js", PINS["tools/run-aave-ethereum-emode-47-48-r4.js"]);
const r4 = require("./run-aave-ethereum-emode-47-48-r4.js");
const { A, PIN, BLOCK, IMPLEMENTATION_SLOT, stable } = r4;
const fail = (code) => { throw new r4.R4Error(code); };
const LIMITS = Object.freeze({ candidates: 8, calls: 112 }); // 8 * 13 qualification reads + 2 * 4 terminal reads.
const GATES = Object.freeze({ implementationSlotCorroborated: false, completeRuntimeBinding: false, completeAuthorityVerification: false,
  effectiveRangeSemanticsBound: false, routePositive: "unknown", executableNow: "unknown", signedActionJustified: false, fork: false });
const CODE_STAGES = Object.freeze({ [A.hub]: "HUB_CODE", [A.hubImplementation]: "IMPLEMENTATION_CODE", [A.agent]: "AGENT_CODE", [A.range]: "RANGE_CODE" });
const VIEW_STAGES = Object.freeze(Object.fromEntries(r4.AGENT_VIEWS.map((view) => [view.data,
  ({ agentHub: "AGENT_HUB_GETTER", range: "RANGE_GETTER", pool: "POOL_GETTER", updateType: "UPDATE_TYPE_GETTER" })[view.key]])));
const STAGES = new Set(["INVENTORY", "COLLECT", "CHAIN_ID", "FINALITY", "HISTORICAL_HEADER", "IMPLEMENTATION_SLOT", "POST_HEADER",
  ...Object.values(CODE_STAGES), ...Object.values(CODE_STAGES).map((stage) => stage.replace("_CODE", "_METADATA")),
  ...Object.values(VIEW_STAGES), "R3_CODE_COMPARE", "COMPLETE", "TERMINAL_FINALITY", "TERMINAL_HEADER", "TERMINAL_SLOT", "TERMINAL_POST_HEADER"]);
const STAGE_READS = Object.freeze({ CHAIN_ID: 1, FINALITY: 2, HISTORICAL_HEADER: 3, IMPLEMENTATION_SLOT: 4,
  HUB_CODE: 5, HUB_METADATA: 5, IMPLEMENTATION_CODE: 6, IMPLEMENTATION_METADATA: 6, AGENT_CODE: 7, AGENT_METADATA: 7,
  RANGE_CODE: 8, RANGE_METADATA: 8, AGENT_HUB_GETTER: 9, RANGE_GETTER: 10, POOL_GETTER: 11, UPDATE_TYPE_GETTER: 12,
  POST_HEADER: 13, R3_CODE_COMPARE: 13, COMPLETE: 13 });
const TERMINAL_READS = Object.freeze({ TERMINAL_FINALITY: 1, TERMINAL_HEADER: 2, TERMINAL_SLOT: 3, TERMINAL_POST_HEADER: 4, COMPLETE: 4 });
const address = (value) => typeof value === "string" && /^0x[0-9a-f]{40}$/.test(value);
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join() === [...keys].sort().join();
const validCode = (code) => code === "NONE" || typeof code === "string" && r4.safeCode(new r4.R4Error(code)) === code;
const fatalCode = (code) => ["BYTE_CAP", "WALL_CAP", "NETWORK_CALL_CAP", "REQUEST_FORBIDDEN"].includes(code);
function readInputs() {
  for (const [file, hash] of Object.entries(PINS)) pinnedRead(file, hash);
  const previous = JSON.parse(pinnedRead(R4_REPORT, PINS[R4_REPORT]));
  if (previous.sha256 !== sha256(stable(previous.report)) || previous.report.status !== "INCOMPLETE" || previous.report.executionMode !== "production") fail("INPUT_INVALID");
  const sourceHashes = { ...previous.report.sourceHashes, ...PINS };
  for (const [file, hash] of Object.entries(sourceHashes)) pinnedRead(file, hash);
  const authority = r4.readAuthority();
  r4.validateReport(previous.report, authority);
  return { authority, sourceHashes };
}
function reportTemplate(now) {
  return { schema: SCHEMA, status: "DIAGNOSTIC_ONLY", code: "HISTORICAL_CONSENSUS_UNAVAILABLE", generatedAt: new Date(now()).toISOString(),
    targetPin: PIN, hub: A.hub, implementationSlot: IMPLEMENTATION_SLOT, candidateImplementation: A.hubImplementation,
    callsUsed: 0, diagnostics: [], terminal: [], abort: null, implementation: null, failureCounts: {}, gates: { ...GATES } };
}
function failureCounts(report) {
  const counts = {};
  for (const row of [...report.diagnostics, ...report.terminal]) if (row.code !== "NONE") {
    const key = `${row.stage}:${row.code}`; counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}
function checkHeader(raw, pf) {
  if (stable(pf.normalizeHeader(raw)) !== stable(PIN)) fail("HISTORICAL_HEADER_MISMATCH");
}
function checkFinality(raw, pf) {
  const header = pf.normalizeHeader(raw);
  if (!header || header.number < PIN.number || header.number === PIN.number && stable(header) !== stable(PIN)) fail("FINALITY_UNAVAILABLE");
}
async function collect({ candidates, rawCall, authority, pf, now = Date.now }) {
  if (!Array.isArray(candidates) || !candidates.length || candidates.length > LIMITS.candidates || typeof rawCall !== "function"
    || candidates.some((candidate) => !candidate || typeof candidate.operatorFamily !== "string" || pf.reviewedOperatorFamily(candidate.operatorFamily) !== candidate.operatorFamily)
    || new Set(candidates.map((candidate) => candidate.handle)).size !== candidates.length) fail("INPUT_INVALID");
  const report = reportTemplate(now), groups = new Map();
  let selected = null;
  const call = async (row, handle, method, params, timeout) => {
    r4.allowRequest(method, params);
    if (report.callsUsed >= LIMITS.calls) fail("NETWORK_CALL_CAP");
    report.callsUsed += 1; row.calls += 1;
    return rawCall(handle, method, params, timeout);
  };
  for (let ordinal = 0; ordinal < candidates.length; ordinal += 1) {
    const candidate = candidates[ordinal], row = { ordinal, stage: "CHAIN_ID", code: "NONE", implementation: null, calls: 0 };
    report.diagnostics.push(row);
    let headers = 0;
    try {
      const observation = await r4.observe(candidate.handle, async (handle, method, params, timeout) => {
        if (method === "eth_chainId") row.stage = "CHAIN_ID";
        else if (method === "eth_getBlockByNumber") row.stage = params[0] === "finalized" ? "FINALITY" : ++headers === 1 ? "HISTORICAL_HEADER" : "POST_HEADER";
        else if (method === "eth_getStorageAt") row.stage = "IMPLEMENTATION_SLOT";
        else if (method === "eth_getCode") row.stage = CODE_STAGES[params[0]];
        else if (method === "eth_call") row.stage = VIEW_STAGES[params[0].data];
        if (!STAGES.has(row.stage)) fail("REQUEST_FORBIDDEN");
        const result = await call(row, handle, method, params, timeout);
        // Retain the validated public slot value before R4 checks its candidate assumption.
        if (method === "eth_getStorageAt") row.implementation = r4.decodeSlot(result);
        return result;
      }, pf);
      row.stage = "R3_CODE_COMPARE";
      for (const key of ["hub", "agent", "range"]) {
        const prior = authority.r3.report.observations.current.code[key];
        if (observation.code[key].keccak256 !== prior.keccak256 || observation.code[key].bytes !== prior.bytes) fail("R3_RUNTIME_MISMATCH");
      }
      row.stage = "COMPLETE";
    } catch (error) {
      row.code = r4.safeCode(error);
      if (row.code === "BYTECODE_INVALID" && row.stage.endsWith("_CODE")) row.stage = row.stage.replace("_CODE", "_METADATA");
      if (fatalCode(row.code)) { report.abort = { stage: row.stage, code: row.code }; break; }
    }
    if (row.implementation !== null) {
      const group = groups.get(row.implementation) || [];
      if (!group.some((entry) => entry.candidate.operatorFamily === candidate.operatorFamily)) group.push({ candidate, row });
      groups.set(row.implementation, group);
      if (group.length === 2) { selected = group; break; }
    }
  }
  if (selected && !report.abort) {
    const expected = selected[0].row.implementation;
    for (const entry of selected) {
      const row = { ordinal: entry.row.ordinal, stage: "TERMINAL_FINALITY", code: "NONE", implementation: null, calls: 0 };
      report.terminal.push(row);
      const request = (method, params) => call(row, entry.candidate.handle, method, params, 8000);
      try {
        checkFinality(await request("eth_getBlockByNumber", ["finalized", false]), pf);
        row.stage = "TERMINAL_HEADER";
        checkHeader(await request("eth_getBlockByNumber", [`0x${PIN.number.toString(16)}`, false]), pf);
        row.stage = "TERMINAL_SLOT";
        row.implementation = r4.decodeSlot(await request("eth_getStorageAt", [A.hub, IMPLEMENTATION_SLOT, BLOCK]));
        if (row.implementation !== expected) fail("TERMINAL_RECHECK_FAILED");
        row.stage = "TERMINAL_POST_HEADER";
        checkHeader(await request("eth_getBlockByNumber", [`0x${PIN.number.toString(16)}`, false]), pf);
        row.stage = "COMPLETE";
      } catch (error) {
        row.code = r4.safeCode(error); report.abort = { stage: row.stage, code: row.code }; break;
      }
    }
    if (!report.abort) {
      report.status = "CORROBORATED_IMPLEMENTATION_SLOT";
      report.code = "NONE";
      report.implementation = { address: expected, matchesCandidate: expected === A.hubImplementation,
        familyCount: 2, ordinals: selected.map((entry) => entry.row.ordinal) };
      report.gates.implementationSlotCorroborated = true;
    }
  }
  if (report.abort) { report.status = "INCOMPLETE"; report.code = report.abort.code; }
  report.failureCounts = failureCounts(report);
  return report;
}
function validateReport(report) {
  const baseKeys = ["schema", "status", "code", "generatedAt", "targetPin", "hub", "implementationSlot", "candidateImplementation", "callsUsed",
    "diagnostics", "terminal", "abort", "implementation", "failureCounts", "gates"];
  const published = Object.hasOwn(report || {}, "executionMode");
  if (!exactKeys(report, published ? [...baseKeys, "executionMode", "inventoryReads", "inventoryReadAttempts", "transportRequestAttempts", "responseBytes", "sourceHashes"] : baseKeys)
    || report.schema !== SCHEMA || !["DIAGNOSTIC_ONLY", "INCOMPLETE", "CORROBORATED_IMPLEMENTATION_SLOT"].includes(report.status)
    || !Number.isFinite(Date.parse(report.generatedAt)) || stable(report.targetPin) !== stable(PIN) || report.hub !== A.hub
    || report.implementationSlot !== IMPLEMENTATION_SLOT || report.candidateImplementation !== A.hubImplementation
    || !validCode(report.code) || !Number.isInteger(report.callsUsed) || report.callsUsed < 0 || report.callsUsed > LIMITS.calls
    || !Array.isArray(report.diagnostics) || report.diagnostics.length > LIMITS.candidates || !Array.isArray(report.terminal) || report.terminal.length > 2) fail("OUTPUT_INVALID");
  for (const [index, row] of [...report.diagnostics, ...report.terminal].entries()) {
    const terminal = index >= report.diagnostics.length;
    if (!exactKeys(row, ["ordinal", "stage", "code", "implementation", "calls"]) || !Number.isInteger(row.ordinal) || row.ordinal < 0
      || row.ordinal >= report.diagnostics.length || !STAGES.has(row.stage) || !validCode(row.code)
      || (row.code === "NONE") !== (row.stage === "COMPLETE") || !Number.isInteger(row.calls) || row.calls < 0 || row.calls > (terminal ? 4 : 13)
      || row.implementation !== null && !address(row.implementation) || !terminal && row.ordinal !== index
      || row.code === "NONE" && (row.implementation === null || row.calls !== (terminal ? 4 : 13))) fail("OUTPUT_INVALID");
    if (row.calls !== (terminal ? TERMINAL_READS : STAGE_READS)[row.stage]) fail("OUTPUT_INVALID");
    if (row.code === "HUB_IMPLEMENTATION_MISMATCH" && (terminal || row.stage !== "IMPLEMENTATION_SLOT"
      || row.implementation === null || row.implementation === A.hubImplementation)) fail("OUTPUT_INVALID");
    if (row.stage.endsWith("_METADATA") && row.code !== "BYTECODE_INVALID") fail("OUTPUT_INVALID");
    if (!terminal && row.implementation !== null && row.calls < 4) fail("OUTPUT_INVALID");
    if (!terminal && row.implementation !== null && row.implementation !== A.hubImplementation
      && (row.code !== "HUB_IMPLEMENTATION_MISMATCH" || row.stage !== "IMPLEMENTATION_SLOT" || row.calls !== 4)) fail("OUTPUT_INVALID");
  }
  if (report.callsUsed !== [...report.diagnostics, ...report.terminal].reduce((sum, row) => sum + row.calls, 0)
    || stable(report.failureCounts) !== stable(failureCounts(report))) fail("OUTPUT_INVALID");
  const corroborated = report.status === "CORROBORATED_IMPLEMENTATION_SLOT";
  if (stable(report.gates) !== stable({ ...GATES, implementationSlotCorroborated: corroborated })) fail("OUTPUT_INVALID");
  if (corroborated) {
    const value = report.implementation;
    if (report.abort !== null || report.code !== "NONE" || !exactKeys(value, ["address", "matchesCandidate", "familyCount", "ordinals"])
      || !address(value.address) || value.matchesCandidate !== (value.address === A.hubImplementation) || value.familyCount !== 2
      || !Array.isArray(value.ordinals) || value.ordinals.length !== 2 || new Set(value.ordinals).size !== 2 || report.terminal.length !== 2) fail("OUTPUT_INVALID");
    for (let i = 0; i < 2; i += 1) {
      const ordinal = value.ordinals[i];
      if (!Number.isInteger(ordinal) || report.diagnostics[ordinal]?.implementation !== value.address || report.terminal[i].ordinal !== ordinal
        || report.terminal[i].code !== "NONE" || report.terminal[i].implementation !== value.address) fail("OUTPUT_INVALID");
    }
  } else {
    if (report.implementation !== null) fail("OUTPUT_INVALID");
    if (report.status === "DIAGNOSTIC_ONLY" && (report.abort !== null || report.code !== "HISTORICAL_CONSENSUS_UNAVAILABLE" || report.terminal.length)) fail("OUTPUT_INVALID");
    if (report.status === "INCOMPLETE" && (!exactKeys(report.abort, ["stage", "code"]) || !STAGES.has(report.abort.stage)
      || report.abort.code !== report.code || report.code === "NONE")) fail("OUTPUT_INVALID");
  }
  if (report.abort !== null) {
    const rows = [...report.diagnostics, ...report.terminal], last = rows[rows.length - 1];
    if (last ? last.stage !== report.abort.stage || last.code !== report.abort.code
      : !["INVENTORY", "COLLECT"].includes(report.abort.stage)) fail("OUTPUT_INVALID");
  }
  if (published) {
    if (!["production", "injected"].includes(report.executionMode) || !Number.isInteger(report.inventoryReadAttempts) || report.inventoryReadAttempts < 0 || report.inventoryReadAttempts > 1
      || !Number.isInteger(report.inventoryReads) || report.inventoryReads < 0 || report.inventoryReads > report.inventoryReadAttempts
      || !Number.isInteger(report.transportRequestAttempts) || report.transportRequestAttempts < 0 || report.transportRequestAttempts > report.callsUsed
      || report.executionMode === "injected" && (report.inventoryReadAttempts !== 0 || report.responseBytes !== null)
      || report.executionMode === "production" && (!Number.isSafeInteger(report.responseBytes) || report.responseBytes < 0)) fail("OUTPUT_INVALID");
    if (report.status !== "INCOMPLETE" && report.executionMode === "production" && (report.inventoryReads !== 1 || report.transportRequestAttempts !== report.callsUsed)) fail("OUTPUT_INVALID");
    if (!report.sourceHashes || Object.entries(report.sourceHashes).some(([file, hash]) => file.split(/[\\/]/).includes("..")
      || !/^[a-zA-Z0-9_./-]+$/.test(file) || !/^[0-9a-f]{64}$/.test(hash))) fail("OUTPUT_INVALID");
  }
  const text = stable(report);
  if (Buffer.byteLength(text) > r4.LIMITS.outputBytes || /https?:\/\/|authorization|bearer\s|api[_-]?key/i.test(text)) fail("OUTPUT_INVALID");
  return true;
}
async function runOnce(options = {}) {
  const injected = Object.keys(options).length !== 0;
  if (injected && (typeof options.rawCall !== "function" || !Array.isArray(options.candidates) || typeof options.root !== "string"
    || path.resolve(options.root) === ROOT || path.resolve(fs.realpathSync(options.root)) === ROOT)) fail("INPUT_INVALID");
  if (!injected && require.main !== module) fail("INVOCATION_INVALID");
  const { authority: actualAuthority, sourceHashes: inputHashes } = readInputs();
  const root = injected ? path.resolve(options.root) : ROOT, authority = injected && options.authority || actualAuthority, now = options.now || Date.now;
  const hashes = { ...inputHashes, [RUNNER]: sha256(fs.readFileSync(__filename)), [TEST]: sha256(fs.readFileSync(path.join(ROOT, TEST))) };
  const inventory = require("./preflight-all-chain-endpoints-v4.js");
  try { inventory.safeParent(root, OUTPUT, { create: false }); } catch (_) { fail("OUTPUT_INVALID"); }
  const output = path.join(root, OUTPUT), attempt = path.join(root, ATTEMPT), executionMode = injected ? "injected" : "production";
  if (fs.existsSync(output) || fs.existsSync(attempt)) fail("ATTEMPT_CONSUMED");
  r4.writeExclusive(attempt, { schema: `${SCHEMA}/attempt`, executionMode, startedAt: new Date(now()).toISOString(), allowedRuns: 1, retries: 0, sourceHashes: hashes });
  let report, transport, inventoryReads = 0, inventoryReadAttempts = 0, stage = "COLLECT", calls = 0;
  try {
    let candidates;
    if (injected) candidates = options.candidates;
    else {
      stage = "INVENTORY"; inventoryReadAttempts += 1;
      const source = inventory.readSource("rpc_endpoints.txt", { root }); inventoryReads += 1;
      candidates = require("./run-aave-ethereum-emode-47-48-r3.js").selectCandidates(inventory.parsePrimaryRpcGrammar(source.text).records);
      transport = r4.createTransport(candidates);
    }
    stage = "COLLECT";
    const rawCall = options.rawCall || transport.call.bind(transport), pf = require("./lib/common-finalized-rpc-preflight.js");
    report = await collect({ candidates, rawCall: (...args) => { calls += 1; return rawCall(...args); }, authority, pf, now });
  } catch (error) {
    // Setup failures are also durable, but an unexpected loss of an active transcript is not publishable.
    if (calls !== 0) fail("OUTPUT_INVALID");
    report = reportTemplate(now); report.status = "INCOMPLETE"; report.code = r4.safeCode(error); report.abort = { stage, code: report.code };
  }
  report = { ...report, executionMode, inventoryReadAttempts, inventoryReads, transportRequestAttempts: injected ? calls : transport?.stats.calls || 0,
    responseBytes: injected ? null : transport?.stats.responseBytes || 0, sourceHashes: hashes };
  for (const [file, hash] of Object.entries(hashes)) pinnedRead(file, hash);
  validateReport(report);
  const envelope = { sha256: sha256(stable(report)), report };
  r4.writeExclusive(output, envelope);
  return envelope;
}
async function main(argv = process.argv.slice(2)) {
  try {
    if (argv.length !== 1 || !["--check", "--run-once"].includes(argv[0]) || process.execArgv.length
      || ["NODE_OPTIONS", "NODE_DEBUG", "NODE_DEBUG_NATIVE", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_USE_ENV_PROXY", "SSLKEYLOGFILE"].some((name) => process.env[name])) fail("INVOCATION_INVALID");
    if (argv[0] === "--check") { const inputs = readInputs(); console.log(JSON.stringify({ status: "OFFLINE_INPUT_CHECK_PASS", sourcePins: Object.keys(inputs.sourceHashes).length, network: false })); return; }
    const result = await runOnce();
    console.log(JSON.stringify({ status: result.report.status, code: result.report.code, callsUsed: result.report.callsUsed,
      implementation: result.report.implementation, failureCounts: result.report.failureCounts, output: OUTPUT, sha256: result.sha256 }));
    if (result.report.status === "INCOMPLETE") process.exitCode = 2;
  } catch (error) { console.log(JSON.stringify({ status: "REFUSED_OR_FAILED", code: r4.safeCode(error) })); process.exitCode = 2; }
}
if (require.main === module) main();
module.exports = { ROOT, SCHEMA, OUTPUT, ATTEMPT, PINS, LIMITS, GATES, STAGES, r4, readInputs, collect, validateReport, runOnce, failureCounts };
