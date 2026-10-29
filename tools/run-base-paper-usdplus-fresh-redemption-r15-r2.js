"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { requestJSON, header: parseHeader } = require("./run-base-redemption-paper-state-r1");
const { readCandidates } = require("./run-base-paper-usdplus-exit-r13");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT_FILE = path.join(ROOT, "reports/raw/fast/base-paper-usdplus-r15/fresh-redemption-r2.json");
const SCHEMA = "base-paper-usdplus-fresh-redemption-qualification/v15-r2";
const EXCHANGE = "0x7cb1b38591021309c64f451859d79312d8ca2789";
const USD_PLUS = "0xb79dd08ea68a908a97220c76d19a6aa9cbde4376";
const CAPS = Object.freeze({ candidates: 8, responseBytes: 1024 * 1024, phaseARequests: 16, phaseABytes: 8 * 1024 * 1024,
  phaseBRequests: 26, phaseBBytes: 16 * 1024 * 1024, totalRequests: 42, totalBytes: 24 * 1024 * 1024, requestMs: 8000, wallMs: 180000, freshnessSeconds: 3600 });
const BASELINES = Object.freeze({
  "tools/run-base-paper-usdplus-fresh-redemption-r15.js": "40fa016c07f286386e376e7341e9c43298d9a4cd315080237f67446d5ac03041",
  "reports/raw/fast/base-paper-usdplus-r15/fresh-redemption.json": "ea3c4da5f8cf24da50f78c551e1e9655f13e8bd3ffb491988b35a8bddba3d259",
  "reports/raw/fast/base-paper-usdplus-r14/redemption-fork-correction-v2.json": "b27bd176f4d7b595d6039d54cd4f5b74e4708b19de8a5ce9af4dafa0791964c4",
  "reports/raw/fast/base-paper-usdplus-r11/build-manifest.json": "84bc2eb07fb48bb703c9316a27a71c4b5bb4cd52e2db3fd67cd6300b0e75a4e5",
  "reports/raw/fast/base-paper-usdplus-r12/source-build.json": "4205b78a2e67d462e32564f426ff9a57c7e7427b8b44f546b4f32f03b316fb1a",
  "reports/raw/fast/base-paper-usdplus-r13/active-token-exact-build.json": "7b782f931221f1ac4441cbb95c4727ef05abb7e77b475bd33e595407419f9a6a",
  "reports/raw/fast/base-paper-usdplus-r13/aave/active/linked-build.json": "8a540bf5f8bca304cd0d5065fa80b081c067b2e71d1d2d852c1ee21a7e92c7fa",
});

class R2Error extends Error {
  constructor(stage, code, context = null) { super(code); this.stage = stage; this.code = code; this.context = context; }
}
const fail = (stage, code, context) => { throw new R2Error(stage, code, context); };
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const pinKey = pin => [pin.number, pin.hash, pin.parentHash, pin.stateRoot, pin.timestamp].join("|");
const blockRef = pin => ({ blockHash: pin.hash, requireCanonical: true });

function parseCli(argv) {
  if (!Array.isArray(argv) || argv.length !== 1 || argv[0] !== "--run-once") fail("CLI", "EXPLICIT_RUN_ONCE_REQUIRED");
  return true;
}
function runnerProvenance(readFile = fs.readFileSync) {
  return { runner: "tools/run-base-paper-usdplus-fresh-redemption-r15-r2.js", runnerSha256: sha(readFile(__filename)), schema: SCHEMA, version: "15-r2" };
}
function sanitized(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return !/(?:https?|wss?):\/\/|authorization|bearer\s|api[-_]?key|token=|rpc_endpoints\.txt|\.invalid(?:[/:"']|$)/i.test(text);
}

function preflight(options = {}) {
  const root = options.root || ROOT, specs = options.specs || BASELINES, readFile = options.readFile || fs.readFileSync, lstat = options.lstat || fs.lstatSync, immutable = {};
  for (const [relative, expected] of Object.entries(specs)) {
    let bytes, stat;
    try { bytes = readFile(path.join(root, relative)); stat = lstat(path.join(root, relative)); } catch (_) { fail("PREFLIGHT", "BASELINE_MISSING"); }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== bytes.length || stat.size > 64 * 1024 * 1024 || sha(bytes) !== expected) fail("PREFLIGHT", "BASELINE_HASH_MISMATCH");
    immutable[relative] = { sha256: expected, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
  }
  const readJson = relative => JSON.parse(readFile(path.join(root, relative), "utf8"));
  const r1 = readJson("reports/raw/fast/base-paper-usdplus-r15/fresh-redemption.json"), r14 = readJson("reports/raw/fast/base-paper-usdplus-r14/redemption-fork-correction-v2.json");
  if (r1.safety?.inventoryReads !== 1 || r1.safety?.retries !== 0 || r1.progress?.relayReached !== false || r1.progress?.anvilReached !== false || r1.progress?.mintReached !== false || r1.progress?.redemptionReached !== false
    || r14.schema !== "base-paper-usdplus-redemption-fork-correction-v2/v14" || r14.canonicalEvidence !== true) fail("PREFLIGHT", "PREDECESSOR_BINDING_INVALID");
  return { root, specs, immutable };
}
function assertPreflightUnchanged(authority, options = {}) {
  const readFile = options.readFile || fs.readFileSync, lstat = options.lstat || fs.lstatSync;
  for (const [relative, before] of Object.entries(authority.immutable)) {
    const file = path.join(authority.root, relative), stat = lstat(file), bytes = readFile(file);
    if (sha(bytes) !== before.sha256 || stat.size !== before.size || stat.mtimeMs !== before.mtimeMs || stat.ctimeMs !== before.ctimeMs) fail("PREFLIGHT", "BASELINE_CHANGED_DURING_RUN");
  }
}

function validateCandidates(candidates) {
  if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > CAPS.candidates) fail("CANDIDATES", "CANDIDATE_POOL_INVALID");
  const endpoints = new Set(), origins = new Set();
  for (const candidate of candidates) {
    let url;
    try { url = candidate.url instanceof URL ? candidate.url : new URL(candidate.url); } catch (_) { fail("CANDIDATES", "CANDIDATE_URL_INVALID"); }
    if (!candidate.family || typeof candidate.family !== "string" || endpoints.has(url.href) || origins.has(url.origin)) fail("CANDIDATES", "DUPLICATE_ENDPOINT_OR_ORIGIN");
    endpoints.add(url.href); origins.add(url.origin);
  }
  return candidates;
}

function validateProof(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || String(value.address || "").toLowerCase() !== USD_PLUS
    || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value.nonce || "") || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value.balance || "")
    || !/^0x[0-9a-f]{64}$/i.test(value.codeHash || "") || !/^0x[0-9a-f]{64}$/i.test(value.storageHash || "")
    || !Array.isArray(value.accountProof) || value.accountProof.length < 1 || value.accountProof.some(row => !/^0x(?:[0-9a-f]{2})+$/i.test(row || ""))
    || !Array.isArray(value.storageProof)) fail("PHASE_B", "PROOF_SHAPE_INVALID");
  return true;
}

function newPhase(attempted = 0) { return { attempted, calls: 0, bytes: 0, failures: {}, admitted: 0, codeValidated: 0, proofValidated: 0 }; }
function publicStats(state) {
  const phase = row => ({ attempted: row.attempted, calls: row.calls, bytes: row.bytes, failures: { ...row.failures }, admitted: row.admitted, codeValidated: row.codeValidated, proofValidated: row.proofValidated });
  return { phaseA: phase(state.phaseA), phaseB: phase(state.phaseB), aggregate: { calls: state.phaseA.calls + state.phaseB.calls, bytes: state.phaseA.bytes + state.phaseB.bytes,
    attempted: state.phaseA.attempted + state.phaseB.attempted, failures: Object.fromEntries([...new Set([...Object.keys(state.phaseA.failures), ...Object.keys(state.phaseB.failures)])].map(code => [code, (state.phaseA.failures[code] || 0) + (state.phaseB.failures[code] || 0)])) }, caps: CAPS };
}
function recordFailure(phase, code) { phase.failures[code] = (phase.failures[code] || 0) + 1; }

function createBudget(transport, now = Date.now) {
  const state = { started: now(), phaseA: newPhase(), phaseB: newPhase() };
  const call = async (phaseName, candidate, method, params) => {
    const phase = phaseName === "A" ? state.phaseA : state.phaseB, requestCap = phaseName === "A" ? CAPS.phaseARequests : CAPS.phaseBRequests, byteCap = phaseName === "A" ? CAPS.phaseABytes : CAPS.phaseBBytes;
    if (now() - state.started > CAPS.wallMs) fail(`PHASE_${phaseName}`, "TOTAL_WALL_CAP", publicStats(state));
    if (phase.calls >= requestCap || state.phaseA.calls + state.phaseB.calls >= CAPS.totalRequests) fail(`PHASE_${phaseName}`, "REQUEST_CAP", publicStats(state));
    phase.calls++;
    let response;
    try { response = await transport(candidate.url, { jsonrpc: "2.0", id: state.phaseA.calls + state.phaseB.calls, method, params }, CAPS.requestMs); }
    catch (_) { fail(`PHASE_${phaseName}`, "TRANSPORT_FAILURE"); }
    if (!response || !Number.isSafeInteger(response.bytes) || response.bytes < 0) fail(`PHASE_${phaseName}`, "RESPONSE_BYTE_ACCOUNTING_INVALID");
    phase.bytes += response.bytes;
    if (response.bytes > CAPS.responseBytes) fail(`PHASE_${phaseName}`, "RESPONSE_BYTE_CAP", publicStats(state));
    if (phase.bytes > byteCap) fail(`PHASE_${phaseName}`, "PHASE_BYTE_CAP", publicStats(state));
    if (state.phaseA.bytes + state.phaseB.bytes > CAPS.totalBytes) fail(`PHASE_${phaseName}`, "TOTAL_BYTE_CAP", publicStats(state));
    const id = state.phaseA.calls + state.phaseB.calls;
    if (response.value?.jsonrpc !== "2.0" || response.value.id !== id || response.value.error || !Object.hasOwn(response.value, "result")) fail(`PHASE_${phaseName}`, "RPC_ENVELOPE_INVALID");
    return response.value.result;
  };
  return { state, call };
}

function fresh(pin, now) {
  const age = BigInt(Math.floor(now() / 1000)) - BigInt(pin.timestamp);
  if (age < -60n || age > BigInt(CAPS.freshnessSeconds)) fail("HEADER", "FINALIZED_HEADER_STALE");
  return true;
}
function safeHeader(raw, now) {
  let pin;
  try { pin = parseHeader(raw); } catch (_) { fail("HEADER", "HEADER_SHAPE_INVALID"); }
  fresh(pin, now); return pin;
}

function aliasesFor(rows) {
  const aliases = new Map(); let next = 1;
  return rows.map(row => { if (!aliases.has(row.family)) aliases.set(row.family, `F${next++}`); return { ...row, alias: aliases.get(row.family) }; });
}
function groupRows(rows) {
  const groups = new Map();
  for (const row of rows) { const key = pinKey(row.pin); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row); }
  return [...groups.entries()].map(([key, members]) => ({ key, members, distinctLabels: new Set(members.map(row => row.family)).size })).sort((a, b) => b.distinctLabels - a.distinctLabels || a.key.localeCompare(b.key));
}
function outputRows(rows) { return rows.map(row => ({ alias: row.alias, pin: row.pin, proofValidated: true, codeValidated: true })); }
function pairability(rows) {
  const matrix = [];
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) matrix.push({ aliasA: rows[i].alias, aliasB: rows[j].alias, samePin: pinKey(rows[i].pin) === pinKey(rows[j].pin), distinctLabel: rows[i].family !== rows[j].family });
  return matrix;
}

async function qualify(options) {
  const now = options.now || Date.now, candidates = validateCandidates(options.candidates), budget = options.budget || createBudget(options.transport, now), state = budget.state;
  state.phaseA.attempted = candidates.length; const admitted = [];
  for (const candidate of candidates) {
    try {
      if (await budget.call("A", candidate, "eth_chainId", []) !== "0x2105") fail("PHASE_A", "CHAIN_MISMATCH");
      const pin = safeHeader(await budget.call("A", candidate, "eth_getBlockByNumber", ["finalized", false]), now); admitted.push({ candidate, pin }); state.phaseA.admitted++;
    } catch (error) {
      const known = error instanceof R2Error ? error : new R2Error("PHASE_A", "UNEXPECTED_FAILURE"); recordFailure(state.phaseA, known.code);
      if (["REQUEST_CAP", "RESPONSE_BYTE_CAP", "PHASE_BYTE_CAP", "TOTAL_BYTE_CAP", "TOTAL_WALL_CAP"].includes(known.code)) { known.context = { stats: publicStats(state) }; throw known; }
    }
  }
  if (!admitted.length) { const error = new R2Error("QUALIFICATION", "COHERENT_PIN_NOT_OBSERVED_IN_BOUNDED_SAMPLE", { stats: publicStats(state), rows: [], matrix: [], maxDistinctLabels: 0 }); throw error; }
  const commonHeight = admitted.reduce((minimum, row) => BigInt(row.pin.number) < minimum ? BigInt(row.pin.number) : minimum, BigInt(admitted[0].pin.number));
  state.phaseB.attempted = admitted.length; const qualified = [];
  for (const row of admitted) {
    try {
      const exact = safeHeader(await budget.call("B", row.candidate, "eth_getBlockByNumber", [`0x${commonHeight.toString(16)}`, false]), now);
      if (BigInt(exact.number) !== commonHeight) fail("PHASE_B", "COMMON_HEIGHT_MISMATCH");
      const ref = blockRef(exact), code = await budget.call("B", row.candidate, "eth_getCode", [EXCHANGE, ref]);
      if (!/^0x(?:[0-9a-f]{2})+$/i.test(code || "") || code === "0x") fail("PHASE_B", "EXCHANGE_CODE_INVALID"); state.phaseB.codeValidated++;
      validateProof(await budget.call("B", row.candidate, "eth_getProof", [USD_PLUS, [], ref])); state.phaseB.proofValidated++;
      qualified.push({ candidate: row.candidate, family: row.candidate.family, pin: exact }); state.phaseB.admitted++;
    } catch (error) {
      const known = error instanceof R2Error ? error : new R2Error("PHASE_B", "UNEXPECTED_FAILURE"); recordFailure(state.phaseB, known.code);
      if (["REQUEST_CAP", "RESPONSE_BYTE_CAP", "PHASE_BYTE_CAP", "TOTAL_BYTE_CAP", "TOTAL_WALL_CAP"].includes(known.code)) { known.context = { stats: publicStats(state) }; throw known; }
    }
  }
  const aliased = aliasesFor(qualified), groups = groupRows(aliased), best = groups[0] || null, maxDistinctLabels = best?.distinctLabels || 0, matrix = pairability(aliased), selectedGroup = groups.find(group => group.distinctLabels >= 2);
  const context = { stats: publicStats(state), rows: outputRows(aliased), matrix, maxDistinctLabels, commonHeight: commonHeight.toString() };
  if (!selectedGroup) throw new R2Error("QUALIFICATION", "COHERENT_PIN_NOT_OBSERVED_IN_BOUNDED_SAMPLE", context);
  const selected = []; for (const row of selectedGroup.members) if (!selected.some(other => other.family === row.family)) selected.push(row); selected.length = 2;
  for (const row of selected) {
    let terminal;
    try { terminal = safeHeader(await budget.call("B", row.candidate, "eth_getBlockByNumber", [`0x${BigInt(selectedGroup.members[0].pin.number).toString(16)}`, false]), now); }
    catch (error) { const known = error instanceof R2Error ? error : new R2Error("TERMINAL_RECHECK", "TERMINAL_RECHECK_FAILED"); recordFailure(state.phaseB, known.code); known.stage = "TERMINAL_RECHECK"; known.context = { ...context, stats: publicStats(state) }; throw known; }
    if (!same(terminal, selectedGroup.members[0].pin)) { recordFailure(state.phaseB, "TERMINAL_HEADER_CHANGED"); throw new R2Error("TERMINAL_RECHECK", "TERMINAL_HEADER_CHANGED", { ...context, stats: publicStats(state) }); }
  }
  context.stats = publicStats(state);
  return { ...context, coherent: true, pin: selectedGroup.members[0].pin, selectedAliases: selected.map(row => row.alias), selectedFamilyCount: 2 };
}

function r1Disposition() {
  return {
    artifact: "reports/raw/fast/base-paper-usdplus-r15/fresh-redemption.json", artifactSha256: BASELINES["reports/raw/fast/base-paper-usdplus-r15/fresh-redemption.json"],
    runner: "tools/run-base-paper-usdplus-fresh-redemption-r15.js", runnerSha256: BASELINES["tools/run-base-paper-usdplus-fresh-redemption-r15.js"], runnerDisposition: "DO_NOT_USE_FOR_FORK_OR_FULL_EXIT_EVIDENCE",
    canonicalOnlyFor: ["PROCESS_STOPPED_BEFORE_RELAY_ANVIL_MINT_REDEMPTION", "ONE_INVENTORY_READ", "ZERO_RETRIES"],
    rejectedClaims: ["R1_CLASSIFICATION", "R1_EXACT_QUALIFIED_COUNT", "R1_PAIR_CONCLUSION", "R1_FULL_HARNESS_SUITABILITY"],
    rejectionReasons: ["PAIRING_WAS_ORDER_DEPENDENT", "PROOF_SHAPE_WAS_UNVALIDATED", "REQUEST_BYTE_TOTALS_WERE_ABSENT", "G6_WAS_ABSENT", "ARBITRARY_INJECTED_EXECUTOR_COULD_ASSERT_PASS"],
  };
}
function baseOutput() {
  return { schema: SCHEMA, generatedAt: new Date().toISOString(), completedAt: null, provenance: runnerProvenance(), classification: "INCOMPLETE", firstFailure: null, stageProgression: [],
    supersedesR1: r1Disposition(), baselineHashes: { ...BASELINES }, familyBasis: "opaque-inventory-label-only", backendIndependenceProven: false, inventoryReads: 0, retries: 0,
    commonHeight: null, coherentPinCandidateObserved: false, selectedPin: null, selectedAliases: [], selectedFamilyCount: 0, maxDistinctLabelsInBestExactPinGroup: 0,
    qualifiedRows: [], pairabilityMatrix: [], qualification: { phaseA: newPhase(), phaseB: newPhase(), aggregate: { calls: 0, bytes: 0, attempted: 0, failures: {} }, caps: CAPS },
    preForkGates: null, notRunReason: "R2_QUALIFICATION_ONLY", fullExitVerified: false, localSemantic: { status: "UNKNOWN", result: "inconclusive" }, reproducibility: "UNKNOWN", quoteEligible: false,
    routePositive: "unknown", executableNow: "unknown", profitabilityClaim: false, signedActionJustified: false, signing: false, broadcast: false,
    safety: { qualificationOnly: true, endpointMaterialPersisted: false, endpointIdentityPersisted: false, endpointMaterialHashed: false, walletKeyEnvRead: false, transactions: 0, productionMutations: 0,
      relayCreated: false, anvilSpawned: false, localRpcMutation: false, autoImpersonation: false, syntheticMint: false, redemption: false } };
}
function assertClosed(output) {
  if (output.fullExitVerified !== false || output.localSemantic.status !== "UNKNOWN" || output.localSemantic.result !== "inconclusive" || output.reproducibility !== "UNKNOWN" || output.quoteEligible !== false
    || output.routePositive !== "unknown" || output.executableNow !== "unknown" || [output.profitabilityClaim, output.signedActionJustified, output.signing, output.broadcast].some(Boolean)
    || output.safety.qualificationOnly !== true || Object.entries(output.safety).some(([key, value]) => key !== "qualificationOnly" && value !== false && value !== 0)) fail("OUTPUT", "CLOSED_SEMANTICS_VIOLATION");
  return true;
}

async function runOnce(options = {}) {
  const output = baseOutput(), exists = options.exists || fs.existsSync, outputFile = options.outputFile || OUTPUT_FILE;
  if (exists(outputFile)) fail("OUTPUT", "OUTPUT_EXISTS_NO_OVERWRITE"); let authority;
  try {
    authority = options.preflight || preflight(options.preflightOptions); output.stageProgression.push("IMMUTABLE_BASELINE_AND_R1_REJECTION_BOUND");
    let candidates;
    if (options.candidates) candidates = options.candidates; else { output.inventoryReads++; candidates = (options.readCandidates || readCandidates)(); }
    const result = await qualify({ candidates, transport: options.transport || requestJSON, now: options.now || Date.now, budget: options.budget });
    output.stageProgression.push("PHASE_A_FINALIZED_HEADS_CAPTURED", "COMMON_HEIGHT_DERIVED", "PHASE_B_EXACT_HEIGHT_AND_PROOF_VALIDATED", "TERMINAL_SELECTED_PAIR_RECHECKED");
    output.classification = "FRESH_COHERENT_PIN_CANDIDATE_OBSERVED / PREFORK_BINDING_NOT_RUN"; output.firstFailure = { stage: "PREFORK_BINDING", code: "R2_QUALIFICATION_ONLY" };
    output.coherentPinCandidateObserved = true; output.selectedPin = { ...result.pin, observedAt: new Date((options.now || Date.now)()).toISOString(), freshnessExpiresAt: new Date((Number(result.pin.timestamp) + CAPS.freshnessSeconds) * 1000).toISOString() };
    output.selectedAliases = result.selectedAliases; output.selectedFamilyCount = result.selectedFamilyCount; output.maxDistinctLabelsInBestExactPinGroup = result.maxDistinctLabels;
    output.commonHeight = result.commonHeight; output.qualifiedRows = result.rows; output.pairabilityMatrix = result.matrix; output.qualification = result.stats;
  } catch (error) {
    const known = error instanceof R2Error ? error : new R2Error("UNCLASSIFIED", "UNEXPECTED_FAILURE"); output.firstFailure = { stage: known.stage, code: known.code };
    output.classification = known.stage === "QUALIFICATION" && known.code === "COHERENT_PIN_NOT_OBSERVED_IN_BOUNDED_SAMPLE" ? "INCOMPLETE / QUALIFICATION / COHERENT_PIN_NOT_OBSERVED_IN_BOUNDED_SAMPLE" : `INCOMPLETE / ${known.stage} / ${known.code}`;
    const context = known.context || {}; if (context.stats) output.qualification = context.stats; if (context.rows) output.qualifiedRows = context.rows; if (context.matrix) output.pairabilityMatrix = context.matrix;
    if (context.commonHeight) output.commonHeight = context.commonHeight; if (Number.isSafeInteger(context.maxDistinctLabels)) output.maxDistinctLabelsInBestExactPinGroup = context.maxDistinctLabels;
    if (context.stats?.phaseA) output.stageProgression.push("PHASE_A_BOUNDED_SAMPLE_COMPLETED");
    if (context.commonHeight) output.stageProgression.push("COMMON_HEIGHT_DERIVED", "PHASE_B_BOUNDED_SAMPLE_COMPLETED");
  }
  if (authority) assertPreflightUnchanged(authority, options.preflightOptions); output.completedAt = new Date().toISOString(); assertClosed(output); if (!sanitized(output)) fail("OUTPUT", "OUTPUT_NOT_SANITIZED"); return output;
}
function writeOnce(output, options = {}) {
  const file = options.outputFile || OUTPUT_FILE; if (fs.existsSync(file)) fail("OUTPUT", "OUTPUT_EXISTS_NO_OVERWRITE"); fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify(output, null, 2) + "\n"; if (!sanitized(text)) fail("OUTPUT", "OUTPUT_NOT_SANITIZED"); fs.writeFileSync(file, text, { flag: "wx" }); return file;
}
async function runCli(argv, io = {}) {
  const stdout = io.stdout || (text => process.stdout.write(text)), stderr = io.stderr || (text => process.stderr.write(text));
  try { parseCli(argv); const output = await runOnce(io.options || {}); (io.writeOutput || writeOnce)(output, io.options || {}); stdout(JSON.stringify({ classification: output.classification, firstFailure: output.firstFailure,
    stages: output.stageProgression, qualification: output.qualification, coherentPinCandidateObserved: output.coherentPinCandidateObserved, selectedFamilyCount: output.selectedFamilyCount, inventoryReads: output.inventoryReads, retries: output.retries }) + "\n");
    (io.setExitCode || (code => { process.exitCode = code; }))(output.coherentPinCandidateObserved ? 3 : 2); return output;
  } catch (_) { stderr("R15_R2_FAILED_CLOSED\n"); (io.setExitCode || (code => { process.exitCode = code; }))(1); return null; }
}

module.exports = { BASELINES, CAPS, EXCHANGE, OUTPUT_FILE, R2Error, SCHEMA, USD_PLUS, aliasesFor, assertClosed, assertPreflightUnchanged, baseOutput, blockRef, createBudget, fresh, groupRows,
  outputRows, pairability, parseCli, preflight, qualify, r1Disposition, runnerProvenance, runCli, runOnce, safeHeader, sanitized, validateCandidates, validateProof, writeOnce };
if (require.main === module) runCli(process.argv.slice(2));
