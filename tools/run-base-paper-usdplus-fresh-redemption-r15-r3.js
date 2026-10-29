"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const r2 = require("./run-base-paper-usdplus-fresh-redemption-r15-r2");
const { requestJSON } = require("./run-base-redemption-paper-state-r1");
const { getOrigin, parseRpcInventory, MAX_INVENTORY_BYTES } = require("./shared-rpc");
const { classifyOperatorFamily } = require("./lib/common-finalized-rpc-preflight");

const ROOT = path.resolve(__dirname, "..");
const INVENTORY_FILE = path.join(ROOT, "rpc_endpoints.txt");
const OUTPUT_FILE = path.join(ROOT, "reports/raw/fast/base-paper-usdplus-r15/fresh-redemption-r3.json");
const SCHEMA = "base-paper-usdplus-fresh-redemption-qualification/v15-r3";
const PREDECESSORS = Object.freeze({
  "tools/run-base-paper-usdplus-fresh-redemption-r15.js": "40fa016c07f286386e376e7341e9c43298d9a4cd315080237f67446d5ac03041",
  "reports/raw/fast/base-paper-usdplus-r15/fresh-redemption.json": "ea3c4da5f8cf24da50f78c551e1e9655f13e8bd3ffb491988b35a8bddba3d259",
  "tools/run-base-paper-usdplus-fresh-redemption-r15-r2.js": "8e38c03ab9f8553d68a5f4548c3e2b84e931cd977747ab32309365992c9c366b",
  "reports/raw/fast/base-paper-usdplus-r15/fresh-redemption-r2.json": "d352ed3c506a2e048fc5b917837c8eb387970668418af9b5695fbeda4ffd97b7",
});
const MAX_PARSED = 128, PER_FAMILY = 2, FINAL_CAP = 8;

class R3Error extends Error {
  constructor(stage, code, context = null) { super(code); this.stage = stage; this.code = code; this.context = context; }
}
const fail = (stage, code, context) => { throw new R3Error(stage, code, context); };
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const emptyPhase = () => ({ attempted: 0, calls: 0, bytes: 0, failures: {}, admitted: 0, codeValidated: 0, proofValidated: 0 });
const emptyQualification = () => ({ phaseA: emptyPhase(), phaseB: emptyPhase(), aggregate: { calls: 0, bytes: 0, attempted: 0, failures: {} }, caps: r2.CAPS });
const emptySelection = () => ({ parsedCount: 0, eligibleCount: 0, securityFilteredCount: 0, duplicateHrefCount: 0, duplicateOriginCount: 0, deduplicatedCount: 0,
  familyQuotaDiscardedCount: 0, postQuotaCount: 0, finalCapDiscardedCount: 0, retainedCount: 0, distinctRetainedFamilyCount: 0 });

function parseCli(argv) {
  if (!Array.isArray(argv) || argv.length !== 1 || argv[0] !== "--once") fail("CLI", "EXPLICIT_ONCE_REQUIRED");
  return true;
}
function provenance(readFile = fs.readFileSync) {
  return { runner: "tools/run-base-paper-usdplus-fresh-redemption-r15-r3.js", runnerSha256: sha(readFile(__filename)), schema: SCHEMA, version: "15-r3" };
}
function sanitized(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return r2.sanitized(text) && !/(?:private[-_]?key|client[-_]?secret|access[-_]?key|x-api-key|[?&](?:key|token|secret)=)/i.test(text);
}

function preflight(options = {}) {
  const root = options.root || ROOT, specs = options.specs || PREDECESSORS, readFile = options.readFile || fs.readFileSync, lstat = options.lstat || fs.lstatSync, immutable = {};
  for (const [relative, expected] of Object.entries(specs)) {
    let bytes, stat;
    try { bytes = readFile(path.join(root, relative)); stat = lstat(path.join(root, relative)); } catch (_) { fail("PREFLIGHT", "PREDECESSOR_MISSING"); }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== bytes.length || stat.size > 64 * 1024 * 1024 || sha(bytes) !== expected) fail("PREFLIGHT", "PREDECESSOR_HASH_MISMATCH");
    immutable[relative] = { sha256: expected, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
  }
  const readJson = relative => JSON.parse(readFile(path.join(root, relative), "utf8"));
  const r1Artifact = readJson("reports/raw/fast/base-paper-usdplus-r15/fresh-redemption.json"), r2Artifact = readJson("reports/raw/fast/base-paper-usdplus-r15/fresh-redemption-r2.json");
  if (r1Artifact.safety?.inventoryReads !== 1 || r1Artifact.safety?.retries !== 0 || r1Artifact.progress?.relayReached !== false || r1Artifact.progress?.anvilReached !== false
    || r1Artifact.progress?.mintReached !== false || r1Artifact.progress?.redemptionReached !== false || r2Artifact.inventoryReads !== 1 || r2Artifact.retries !== 0
    || r2Artifact.qualification?.aggregate?.calls !== 0 || r2Artifact.qualification?.aggregate?.bytes !== 0 || r2Artifact.firstFailure?.code !== "DUPLICATE_ENDPOINT_OR_ORIGIN") fail("PREFLIGHT", "PREDECESSOR_DISPOSITION_MISMATCH");
  return { root, immutable };
}
function assertPreflightUnchanged(authority, options = {}) {
  const readFile = options.readFile || fs.readFileSync, lstat = options.lstat || fs.lstatSync;
  for (const [relative, before] of Object.entries(authority.immutable)) {
    const file = path.join(authority.root, relative), stat = lstat(file), bytes = readFile(file);
    if (sha(bytes) !== before.sha256 || stat.size !== before.size || stat.mtimeMs !== before.mtimeMs || stat.ctimeMs !== before.ctimeMs) fail("PREFLIGHT", "PREDECESSOR_CHANGED_DURING_RUN");
  }
}

function readInventoryOnce(options = {}) {
  const file = options.file || INVENTORY_FILE, lstat = options.lstat || fs.lstatSync, readFile = options.readFile || fs.readFileSync;
  const before = lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_INVENTORY_BYTES) fail("CANDIDATES", "CANDIDATE_POOL_INVALID");
  const bytes = readFile(file);
  try {
    const after = lstat(file);
    if (before.size !== bytes.length || ["dev", "ino", "size", "mtimeMs", "ctimeMs"].some(key => before[key] !== after[key])) fail("CANDIDATES", "CANDIDATE_POOL_INVALID");
    return parseRpcInventory(bytes.toString("utf8"), { maxBytes: MAX_INVENTORY_BYTES, maxCandidates: MAX_PARSED });
  } finally { if (Buffer.isBuffer(bytes)) bytes.fill(0); }
}

function canonicalFamily(value) { return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value) ? value : null; }
function normalizeEntry(source, index, strictMetadata) {
  if ((typeof source !== "string" && (!source || typeof source !== "object")) || index >= MAX_PARSED) fail("CANDIDATES", "CANDIDATE_POOL_INVALID");
  const raw = typeof source === "string" ? source : source.raw ?? source.url;
  let url;
  try { url = raw instanceof URL ? new URL(raw.href) : new URL(raw); } catch (_) { fail("CANDIDATES", "CANDIDATE_URL_INVALID"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) fail("CANDIDATES", "CANDIDATE_URL_INVALID");
  if (getOrigin(url.href)) return null;
  const classified = classifyOperatorFamily(url.href), explicit = typeof source === "object" ? source.family : undefined;
  if (strictMetadata && explicit !== undefined && !canonicalFamily(explicit)) fail("CANDIDATES", "CANDIDATE_FAMILY_INVALID");
  const family = explicit === undefined ? classified?.operatorFamily : explicit;
  if (!canonicalFamily(family)) {
    if (strictMetadata) fail("CANDIDATES", "CANDIDATE_FAMILY_INVALID");
    return null;
  }
  const rank = typeof source === "object" && source.capabilityRank !== undefined ? source.capabilityRank : classified?.capabilityRank;
  if (!Number.isSafeInteger(rank) || rank < 0) fail("CANDIDATES", "CANDIDATE_POOL_INVALID");
  const ordinal = typeof source === "object" && source.ordinal !== undefined ? source.ordinal : index;
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) fail("CANDIDATES", "CANDIDATE_POOL_INVALID");
  const baseSuitability = typeof source === "object" && source.baseSuitability !== undefined ? source.baseSuitability : (/base|8453/i.test(url.hostname + url.pathname + url.search) ? 0 : 1);
  if (baseSuitability !== 0 && baseSuitability !== 1) fail("CANDIDATES", "CANDIDATE_POOL_INVALID");
  return { url, family, capabilityRank: rank, ordinal, baseSuitability };
}

function selectCandidates(values, options = {}) {
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_PARSED) fail("CANDIDATES", "CANDIDATE_POOL_INVALID");
  const counts = emptySelection(); counts.parsedCount = values.length; const eligible = [];
  for (let index = 0; index < values.length; index++) {
    const row = normalizeEntry(values[index], index, options.strictMetadata === true);
    if (row) eligible.push(row); else counts.securityFilteredCount++;
  }
  counts.eligibleCount = eligible.length;
  eligible.sort((a, b) => a.baseSuitability - b.baseSuitability || a.capabilityRank - b.capabilityRank || a.ordinal - b.ordinal);
  const hrefs = new Set(), origins = new Set(), deduplicated = [];
  for (const row of eligible) {
    if (hrefs.has(row.url.href)) { counts.duplicateHrefCount++; continue; }
    if (origins.has(row.url.origin)) { counts.duplicateOriginCount++; continue; }
    hrefs.add(row.url.href); origins.add(row.url.origin); deduplicated.push(row);
  }
  counts.deduplicatedCount = deduplicated.length;
  const familyCounts = new Map(), postQuota = [];
  for (const row of deduplicated) {
    const used = familyCounts.get(row.family) || 0;
    if (used >= PER_FAMILY) { counts.familyQuotaDiscardedCount++; continue; }
    familyCounts.set(row.family, used + 1); postQuota.push(row);
  }
  counts.postQuotaCount = postQuota.length; counts.finalCapDiscardedCount = Math.max(0, postQuota.length - FINAL_CAP);
  const candidates = postQuota.slice(0, FINAL_CAP); counts.retainedCount = candidates.length; counts.distinctRetainedFamilyCount = new Set(candidates.map(row => row.family)).size;
  const reconciles = counts.parsedCount === counts.eligibleCount + counts.securityFilteredCount
    && counts.eligibleCount === counts.deduplicatedCount + counts.duplicateHrefCount + counts.duplicateOriginCount
    && counts.deduplicatedCount === counts.postQuotaCount + counts.familyQuotaDiscardedCount
    && counts.postQuotaCount === counts.retainedCount + counts.finalCapDiscardedCount;
  if (!reconciles || candidates.length > FINAL_CAP || new Set(candidates.map(row => row.url.href)).size !== candidates.length || new Set(candidates.map(row => row.url.origin)).size !== candidates.length
    || [...new Set(candidates.map(row => row.family))].some(family => candidates.filter(row => row.family === family).length > PER_FAMILY)) fail("CANDIDATES", "CANDIDATE_POOL_INVALID", { selection: counts });
  if (candidates.length < 2) fail("CANDIDATES", "INSUFFICIENT_UNIQUE_ENDPOINTS_AFTER_DEDUPLICATION", { selection: counts });
  if (counts.distinctRetainedFamilyCount < 2) fail("CANDIDATES", "INSUFFICIENT_DISTINCT_OPAQUE_FAMILY_LABELS_AFTER_DEDUPLICATION", { selection: counts });
  return { candidates, counts };
}

function supersession() {
  return {
    r1: { runnerSha256: PREDECESSORS["tools/run-base-paper-usdplus-fresh-redemption-r15.js"], artifactSha256: PREDECESSORS["reports/raw/fast/base-paper-usdplus-r15/fresh-redemption.json"],
      canonicalOnlyFor: ["PROCESS_STOPPED_BEFORE_RELAY_ANVIL_MINT_REDEMPTION", "ONE_INVENTORY_READ", "ZERO_RETRIES"], coherentPinAvailabilitySupported: false },
    r2: { runnerSha256: PREDECESSORS["tools/run-base-paper-usdplus-fresh-redemption-r15-r2.js"], artifactSha256: PREDECESSORS["reports/raw/fast/base-paper-usdplus-r15/fresh-redemption-r2.json"],
      canonicalOnlyFor: ["ONE_INVENTORY_READ", "ZERO_RETRIES", "ZERO_RPC_CALLS_AND_BYTES", "DUPLICATE_CANDIDATE_PREFLIGHT_STOP"], coherentPinAvailabilitySupported: false },
  };
}
function baseOutput() {
  return { schema: SCHEMA, generatedAt: new Date().toISOString(), completedAt: null, provenance: provenance(), correctionType: "CHANGED_SELECTION_RULE_EFFECTIVE_INPUT_CORRECTION",
    finalOneShotUnderThisRule: true, unchangedLaterRetryJustified: false, conclusionScope: "BOUNDED_SELECTED_SAMPLE_ONLY", classification: "INCOMPLETE", firstFailure: null, stageProgression: [],
    predecessorHashes: { ...PREDECESSORS }, supersession: supersession(), selection: emptySelection(), familyBasis: "opaque-inventory-label-only", backendIndependenceProven: false,
    inventoryReads: 0, retries: 0, commonHeight: null, coherentPinCandidateObserved: false, selectedPin: null, selectedAliases: [], selectedFamilyCount: 0,
    maxDistinctLabelsInBestExactPinGroup: 0, qualifiedRows: [], pairabilityMatrix: [], qualification: emptyQualification(), preForkGates: null, notRunReason: "R3_QUALIFICATION_ONLY",
    fullExitVerified: false, localSemantic: { status: "UNKNOWN", result: "inconclusive" }, reproducibility: "UNKNOWN", quoteEligible: false, routePositive: "unknown", executableNow: "unknown",
    profitabilityClaim: false, signedActionJustified: false, signing: false, broadcast: false, safety: { qualificationOnly: true, endpointMaterialPersisted: false, endpointIdentityPersisted: false,
      endpointMaterialHashed: false, familyLabelsPersisted: false, walletKeyEnvRead: false, transactions: 0, productionMutations: 0, relayCreated: false, anvilSpawned: false,
      localRpcMutation: false, autoImpersonation: false, syntheticMint: false, redemption: false } };
}
function assertClosed(output) {
  if (output.fullExitVerified !== false || output.localSemantic?.status !== "UNKNOWN" || output.localSemantic?.result !== "inconclusive" || output.reproducibility !== "UNKNOWN"
    || output.quoteEligible !== false || output.routePositive !== "unknown" || output.executableNow !== "unknown" || output.backendIndependenceProven !== false
    || [output.profitabilityClaim, output.signedActionJustified, output.signing, output.broadcast].some(Boolean) || output.preForkGates !== null || output.safety?.qualificationOnly !== true
    || Object.entries(output.safety || {}).some(([key, value]) => key !== "qualificationOnly" && value !== false && value !== 0)) fail("OUTPUT", "CLOSED_SEMANTICS_VIOLATION");
  return true;
}
function decorateMatrix(matrix) { return matrix.map(row => ({ ...row, distinctEndpoint: true, distinctOrigin: true })); }

async function runOnce(options = {}) {
  const output = baseOutput(), exists = options.exists || fs.existsSync, outputFile = options.outputFile || OUTPUT_FILE; let authority;
  if (exists(outputFile)) fail("OUTPUT", "OUTPUT_EXISTS_NO_OVERWRITE");
  try {
    authority = options.preflight || preflight(options.preflightOptions); output.stageProgression.push("EXACT_R1_R2_PREDECESSORS_BOUND");
    let raw;
    if (options.entries) raw = options.entries;
    else { output.inventoryReads++; raw = (options.readInventory || readInventoryOnce)(); }
    const selected = selectCandidates(raw, { strictMetadata: options.entries !== undefined }); output.selection = selected.counts; output.stageProgression.push("DEDUPLICATED_SELECTION_BOUND");
    try {
      const result = await r2.qualify({ candidates: selected.candidates, transport: options.transport || requestJSON, now: options.now || Date.now });
      output.stageProgression.push("PHASE_A_FINALIZED_HEADS_CAPTURED", "COMMON_HEIGHT_DERIVED", "PHASE_B_EXACT_HEIGHT_AND_PROOF_VALIDATED", "TERMINAL_SELECTED_PAIR_RECHECKED");
      output.classification = "FRESH_COHERENT_PIN_CANDIDATE_OBSERVED / PREFORK_BINDING_NOT_RUN"; output.firstFailure = { stage: "PREFORK_BINDING", code: "R3_QUALIFICATION_ONLY" };
      output.coherentPinCandidateObserved = true; output.selectedPin = { ...result.pin, observedAt: new Date((options.now || Date.now)()).toISOString(), freshnessExpiresAt: new Date((Number(result.pin.timestamp) + r2.CAPS.freshnessSeconds) * 1000).toISOString() };
      output.selectedAliases = result.selectedAliases; output.selectedFamilyCount = result.selectedFamilyCount; output.maxDistinctLabelsInBestExactPinGroup = result.maxDistinctLabels;
      output.commonHeight = result.commonHeight; output.qualifiedRows = result.rows; output.pairabilityMatrix = decorateMatrix(result.matrix); output.qualification = result.stats;
    } catch (error) {
      if (!(error instanceof r2.R2Error)) throw error;
      output.firstFailure = { stage: error.stage, code: error.code }; output.classification = error.stage === "QUALIFICATION" && error.code === "COHERENT_PIN_NOT_OBSERVED_IN_BOUNDED_SAMPLE"
        ? "INCOMPLETE / QUALIFICATION / COHERENT_PIN_NOT_OBSERVED_IN_BOUNDED_SAMPLE" : `INCOMPLETE / ${error.stage} / ${error.code}`;
      const context = error.context || {}; if (context.stats) output.qualification = context.stats; if (context.rows) output.qualifiedRows = context.rows;
      if (context.matrix) output.pairabilityMatrix = decorateMatrix(context.matrix); if (context.commonHeight) output.commonHeight = context.commonHeight;
      if (Number.isSafeInteger(context.maxDistinctLabels)) output.maxDistinctLabelsInBestExactPinGroup = context.maxDistinctLabels;
      if (context.stats?.phaseA) output.stageProgression.push("PHASE_A_BOUNDED_SAMPLE_COMPLETED"); if (context.commonHeight) output.stageProgression.push("COMMON_HEIGHT_DERIVED", "PHASE_B_BOUNDED_SAMPLE_COMPLETED");
    }
  } catch (error) {
    const known = error instanceof R3Error ? error : new R3Error("UNCLASSIFIED", "UNEXPECTED_FAILURE"); output.firstFailure = { stage: known.stage, code: known.code };
    output.classification = `INCOMPLETE / ${known.stage} / ${known.code}`; if (known.context?.selection) output.selection = known.context.selection;
  }
  if (authority) assertPreflightUnchanged(authority, options.preflightOptions); output.completedAt = new Date().toISOString(); assertClosed(output);
  if (!sanitized(output)) fail("OUTPUT", "OUTPUT_NOT_SANITIZED"); return output;
}
function writeOnce(output, options = {}) {
  const file = options.outputFile || OUTPUT_FILE; if (fs.existsSync(file)) fail("OUTPUT", "OUTPUT_EXISTS_NO_OVERWRITE"); fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify(output, null, 2) + "\n"; if (!sanitized(text)) fail("OUTPUT", "OUTPUT_NOT_SANITIZED"); fs.writeFileSync(file, text, { flag: "wx" }); return file;
}
async function runCli(argv, io = {}) {
  const stdout = io.stdout || (text => process.stdout.write(text)), stderr = io.stderr || (text => process.stderr.write(text));
  try {
    parseCli(argv); const output = await runOnce(io.options || {}); (io.writeOutput || writeOnce)(output, io.options || {});
    stdout(JSON.stringify({ classification: output.classification, firstFailure: output.firstFailure, stages: output.stageProgression, selection: output.selection,
      qualification: output.qualification, coherentPinCandidateObserved: output.coherentPinCandidateObserved, selectedFamilyCount: output.selectedFamilyCount, inventoryReads: output.inventoryReads, retries: output.retries }) + "\n");
    (io.setExitCode || (code => { process.exitCode = code; }))(output.coherentPinCandidateObserved ? 3 : 2); return output;
  } catch (_) { stderr("R15_R3_FAILED_CLOSED\n"); (io.setExitCode || (code => { process.exitCode = code; }))(1); return null; }
}

module.exports = { FINAL_CAP, INVENTORY_FILE, MAX_PARSED, OUTPUT_FILE, PER_FAMILY, PREDECESSORS, R3Error, SCHEMA, assertClosed, assertPreflightUnchanged, baseOutput,
  canonicalFamily, decorateMatrix, emptyQualification, emptySelection, normalizeEntry, parseCli, preflight, provenance, readInventoryOnce, runCli, runOnce, sanitized,
  selectCandidates, supersession, writeOnce };
if (require.main === module) runCli(process.argv.slice(2));
