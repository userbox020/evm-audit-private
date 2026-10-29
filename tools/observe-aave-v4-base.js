#!/usr/bin/env node
"use strict";

// Parent-bootstrap adapter, NOT an approval issuer or a replacement C.capture.
// The parent burns one fresh approval atomically before calling, and marks it
// CONSUMED in finally. No approval files, inventories, output files or providers
// are discovered here. Inject raw transport and candidates explicitly.
const crypto = require("node:crypto");
const SCOPE_SHA256 = "a15d870270f0f92a1c7f90f1e6d89d469f3510bc6e6d8f690861617efad7cf0c";
const ADDRESS_SET_SHA256 = "2ce170d71b311294e676e6aa6925f7d027d85e512fe0ea143339c90c7b47d184";
const HUB = "0xa4d5947eb727a052bae69c593ffc84247ec9864e";
const SPOKE = "0x17905db0e4a3514467539956c084180616ae7b8d";
const ORACLE = "0xabaf048fd7675ea34a84332371ffd5d55e322a47";
const FEEDS = Object.freeze([
  "0x787f13dea48db0897cbcdd985de77809d837f988", "0x06a8e4b3abb3b7543d8396fb2b763d22820cb295",
  "0x5bf49e0ffa937ce2fff033c739ad7c634c4d34f2", "0x6526ae6797a76123638b863aee4dd27ba4e4b27d",
  "0xeb10a6c9aa7e537aed766c08c35dae35b321b18c", "0x04689a41629776563e6822f76f2e57d148d28513",
  "0xfaf869185383a24f8cb00e27bda6b63b9905dcb4", "0xc7d0f8dcc1f860ca752054c59ea82ba2a5aab50c",
]);
const LIMITS = Object.freeze({ maxCandidates: 16, maxRequests: 12000, maxMs: 240000, timeoutMs: 10000,
  maxBytes: 4194304, concurrency: 4, maxPinAgeMs: 1800000, reserveRequests: 8, terminalReserveMs: 30000, paceMs: 250 });
const CODE_FILES = Object.freeze([
  "tools/observe-aave-v4-base.js", "tools/admit-aave-v4-base.js", "tools/scan-aave-v4-hubs.js",
  "tools/scan-aave-v4-base-borrowers.js", "tools/scan-aave-v4-base-oracles.js", "tools/lib/aave-v4-base-observation-contract.js",
  "tools/lib/aave-v4-borrower-history.js", "tools/lib/aave-v4-base-role-evidence.js", "tools/aave-v4-base-role-evidence.json",
  "tools/lib/aave-v4-pinned-collection.js", "tools/lib/common-finalized-rpc-preflight.js", "tools/shared-rpc.js",
  "tools/lib/rpc-provider-reliability.js", "tools/lib/producer-deadline.js", "tools/aave-source-coverage.js",
  "tools/lib/aave-v4-family-candidates.js",
]);
const SAFE_CODES = new Set(["APPROVAL_REQUIRED", "APPROVAL_INVALID", "APPROVAL_EXPIRED", "PROFILE_INVALID", "SOURCES_INVALID",
  "SCOPE_INVALID", "TRANSPORT_REQUIRED", "NATIVE_ROOT_ZERO_LOG_UNSUPPORTED", "RUN_FAILED", "RUN_CLOSED", "READ_POLICY_REFUSED",
  "HISTORY_POLICY_REFUSED", "HISTORY_RESULT_REFUSED", "BUDGET_EXHAUSTED", "PIN_INVALID", "CURRENT_BINDING_FAILED",
  "COMPONENT_FAILED", "FINAL_CONFIRMATION_FAILED", "COUNTERS_INVALID", "HISTORY_COMMIT_FAILED", "QUALIFICATION_CANARY_REFUSED", "QUALIFICATION_HEADER_INVALID"]);
class ObservationRunError extends Error {
  constructor(code) { super(SAFE_CODES.has(code) ? code : "RUN_FAILED"); this.name = "ObservationRunError"; this.code = this.message; }
}
function fail(code) { throw new ObservationRunError(code); }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  return JSON.stringify(value);
}
function digest(value) { return sha256(canonical(value)); }
function clone(value) { try { return JSON.parse(JSON.stringify(value)); } catch (_) { fail("PROFILE_INVALID"); } }
function freeze(value) { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function count(value) { return Number.isSafeInteger(value) && value >= 0; }
function address(value) { return typeof value === "string" && /^0x[0-9a-f]{40}$/.test(value); }
function hash(value) { return typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value); }
function rootDiscoveryProfile() {
  // A proposed read profile only. This does not confer authorization.
  return { schema: "aave-v4-base-observation-profile/v1", mode: "ROOT_DISCOVERY", roots: true,
    topology: false, borrowers: false, oracles: false, qualificationCanaries: false, history: { enabled: false } };
}
function publicProjection(value) {
  // A positive key list, in addition to C's value/metadata sanitizer. Arbitrary
  // keys, source bytes, errors, handles and caller metadata never leave this lane.
  const keys = new Set(("chainId chain generatedAt id blockNumber blockHash stateRoot timestamp finality declaredTopology bound hubsDeclared pinBlock registry version commit inventoryDigest " +
    "hubs address assetCountReadOk assetCount assets assetId underlying decimals spokeDirectory count rows listed reserve reserveBearing reserveId hub dynamicConfigKey totalDebtRaw oracleData source " +
    "sourceCoverage schemaVersion protocolVersion coverageKind sampleComplete complete stateReadsAttempted stateReadsSucceeded stateReadsFailed topologyUniverse consumedReserveLinks hubAddress spoke " +
    "hubsExpected hubsObserved spokesExpected spokesObserved assetsExpected assetsObserved spokeReserveLinks expected observed consumed links reserveLinksExpected reserveLinksDeclared reserveLinksObserved reserveLinksConsumed " +
    "componentObservationComplete coverage classification classSemantics exact coveragePromotion dispatchEnabled liveAdmission baseGuardQualified terminalPinConfirmed stateReads attempted succeeded failed usdQualification " +
    "users accountRaw reserves usdValue collateral borrowing suppliedAssetsRaw position drawnShares premiumShares premiumOffsetRay suppliedShares dynamicConfig key collateralFactor maxLiquidationBonus liquidationFee " +
    "linksConsumed fullHistoryProven debtAccounting debtReconciliation reconciliationUnit underlyingDebtAdditive aggregateDebtRaw indexedUserDebtRaw roundingOverhangRaw drawnIndexRay aggregateComponents indexedUserComponents " +
    "componentsEqual aggregateDebtConsistent userDebtReadsConsistent equal history namespace identityDigest fromBlock throughBlock throughBlockHash logs committedChunks rangeComplete startKind " +
    "oracle wiringObserved sourceSemanticsQualified freshness priceRaw oracleDecimals runtimeAddress runtimeCodeKeccak256 reason updatedAt timestampEvidence maxAgeSeconds childFreshness semanticsChainQualified " +
    "readings target signature args values priceChildCandidates controlAddresses errors error evidence evidenceKind publicationAddress perAddressPublication currentStorage currentConfig currentChild currentAdmin").split(/\s+/));
  function project(v) {
    if (Array.isArray(v)) return v.map(project);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([key]) => keys.has(key)).map(([key, child]) => [key,
      ["complete", "exact", "coveragePromotion", "dispatchEnabled", "liveAdmission", "baseGuardQualified"].includes(key) ? false : project(child)]));
    if (typeof v === "number") return Number.isSafeInteger(v) ? v : null;
    return v;
  }
  return project(value);
}
function validateRequest(options, started) {
  const approval = clone(options.approval || null);
  if (!approval) fail("APPROVAL_REQUIRED");
  if (approval.schema !== "aave-v4-base-observation-approval/v1" || approval.status !== "CURRENT_IN_PROGRESS"
    || approval.attemptStarted !== true || approval.chainId !== 8453 || approval.scopeSha256 !== SCOPE_SHA256
    || approval.targetCount !== 38 || approval.addressSetSha256 !== ADDRESS_SET_SHA256
    || !["NATIVE", "OFFLINE_FIXTURE"].includes(approval.execution) || !count(approval.issuedAtMs)
    || approval.issuedAtMs > started || !count(approval.expiresAtMs)) fail("APPROVAL_INVALID");
  if (approval.expiresAtMs <= started) fail("APPROVAL_EXPIRED");
  const profile = clone(options.profile || rootDiscoveryProfile()), sources = clone(options.sourceProfile);
  if (profile.schema !== "aave-v4-base-observation-profile/v1" || !["ROOT_DISCOVERY", "FULL_L_O"].includes(profile.mode)
    || approval.mode !== profile.mode || approval.profileDigest !== digest(profile) || approval.sourceProfileDigest !== digest(sources)) fail("PROFILE_INVALID");
  const budget = approval.budget;
  if (!budget || Object.keys(budget).sort().join() !== Object.keys(LIMITS).sort().join()
    || Object.entries(LIMITS).some(([key, cap]) => !Number.isSafeInteger(budget[key]) || budget[key] <= 0
      || (key === "paceMs" ? budget[key] < 250 || budget[key] > 10000 : budget[key] > cap))
    || budget.reserveRequests !== 8 || budget.terminalReserveMs !== 30000 || budget.maxRequests < 160) fail("APPROVAL_INVALID");
  if (typeof options.transport !== "function" || !Array.isArray(options.candidates) || options.candidates.length < 2
    || options.candidates.length > budget.maxCandidates || options.candidates.some(row => !row || !Object.hasOwn(row, "handle"))) fail("TRANSPORT_REQUIRED");
  if (approval.candidatesDigest !== digest(options.candidates)) fail("APPROVAL_INVALID");
  if (approval.execution === "NATIVE" && ["openCollection", "collectTopology", "collectBorrowers", "collectOracles"].some(key => options[key] !== undefined)) fail("APPROVAL_INVALID");
  if (profile.qualificationCanaries === true) {
    const q = profile.qualificationCanaryPolicy;
    if (!q || Object.keys(q).sort().join() !== "address,maxBlock,maxPerCandidate,maxTotal,minBlock,schema,stages,topic"
      || q.schema !== "aave-v4-base-qualification-canaries/v1" || q.address !== HUB || q.topic !== "0x" + "0".repeat(64)
      || !count(q.minBlock) || !count(q.maxBlock) || q.minBlock > q.maxBlock || q.maxPerCandidate !== 2
      || q.maxTotal !== 2 * options.candidates.length || q.maxTotal > 32
      || JSON.stringify(q.stages) !== JSON.stringify(["PINNED_CANDIDATE", "COMMON_PIN"])
      || approval.qualificationCanaryDigest !== digest(q) || sources?.qualificationCanaryDigest !== digest(q)) fail("PROFILE_INVALID");
  } else if (profile.qualificationCanaries !== false || profile.qualificationCanaryPolicy !== undefined
    || approval.qualificationCanaryDigest !== undefined || sources?.qualificationCanaryDigest !== undefined) fail("PROFILE_INVALID");
  if (profile.mode === "ROOT_DISCOVERY") {
    if (profile.roots !== true || profile.topology !== false || profile.borrowers !== false || profile.oracles !== false
      || profile.history?.enabled !== false) fail("PROFILE_INVALID");
    // Frozen native constructors require log canaries. Do not fake empty results,
    // weaken that constructor or silently reinterpret "zero logs" as zero scans.
    if (approval.execution === "NATIVE" && !profile.qualificationCanaries) fail("NATIVE_ROOT_ZERO_LOG_UNSUPPORTED");
  } else {
    const h = profile.history;
    if (profile.topology !== true || profile.borrowers !== true || profile.oracles !== true || typeof profile.roots !== "boolean"
      || profile.qualificationCanaries !== true || h?.enabled !== true || !count(h.fromBlock)
      || !count(h.chunkSize) || h.chunkSize < 1 || h.chunkSize > 10000 || !count(h.maxChunks) || h.maxChunks < 1 || h.maxChunks > 512
      || !count(h.maxLogs) || h.maxLogs < 1 || h.maxLogs > 10000 || !count(h.maxUsers) || h.maxUsers < 1 || h.maxUsers > 10000) fail("PROFILE_INVALID");
    if (h.fromBlock !== (h.startProof?.fromBlock ?? 0) || (h.startProof && !["GENESIS", "SNAPSHOT"].includes(h.startProof.kind))) fail("PROFILE_INVALID");
  }
  if (sources?.schema !== "aave-v4-base-observation-sources/v1" || !sources.codeHashes
    || CODE_FILES.some(file => !/^[0-9a-f]{64}$/.test(sources.codeHashes[file] || ""))
    || Object.keys(sources.codeHashes).sort().join() !== [...CODE_FILES].sort().join()
    || !Array.isArray(sources.roots) || sources.roots.length !== 9
    || new Set(sources.roots.map(row => row.address)).size !== 9
    || [ORACLE, ...FEEDS].some(at => !sources.roots.some(row => row.address === at && hash(row.codeKeccak256) && /^[0-9a-f]{64}$/.test(row.sourceEvidenceSha256 || "")))) fail("SOURCES_INVALID");
  for (const row of sources.roots) if (!["DIRECT_PUBLICATION", "SHARED_RUNTIME_CLASS"].includes(row.evidenceKind)
    || typeof row.artifactJson !== "string" || Buffer.byteLength(row.artifactJson) > 2097152
    || sha256(row.artifactJson) !== row.sourceEvidenceSha256) fail("SOURCES_INVALID");
  if ((profile.qualificationCanaries || sources.roots.some(row => row.evidenceKind === "SHARED_RUNTIME_CLASS") || profile.rootEvidenceDigest !== undefined)
    && profile.rootEvidenceDigest !== digest(sources.roots)) fail("SOURCES_INVALID");
  if (profile.mode === "FULL_L_O" && (!sources.callSelectors || Object.entries(sources.callSelectors).some(([at, selectors]) => !address(at)
    || !Array.isArray(selectors) || selectors.length > 80 || selectors.some(selector => !/^0x[0-9a-f]{8}$/.test(selector))))) fail("SOURCES_INVALID");
  return freeze({ approval, profile, sources, candidates: clone(options.candidates), budget: { ...budget } });
}
function rootReads() {
  const reads = [{ target: SPOKE, signature: "ORACLE()", outputs: ["address"], args: [] },
    { target: ORACLE, signature: "spoke()", outputs: ["address"], args: [] },
    { target: ORACLE, signature: "decimals()", outputs: ["uint8"], args: [] }];
  for (let i = 0; i < 8; i++) for (const signature of ["getReserveSource(uint256)", "getReservePrice(uint256)"]) reads.push({
    target: ORACLE, signature, outputs: [signature.startsWith("getReserveSource") ? "address" : "uint256"], args: [i] });
  for (const target of FEEDS.slice(0, 7)) for (const [signature, outputs] of [
    ["aggregator()", ["address"]], ["phaseId()", ["uint16"]], ["accessController()", ["address"]], ["decimals()", ["uint8"]],
    ["latestAnswer()", ["int256"]], ["latestRoundData()", ["uint80", "int256", "uint256", "uint256", "uint80"]],
  ]) reads.push({ target, signature, outputs, args: [] });
  for (const [signature, outputs] of [["ASSET_TO_USD_AGGREGATOR()", ["address"]], ["ACL_MANAGER()", ["address"]],
    ["decimals()", ["uint8"]], ["getPriceCap()", ["int256"]], ["latestAnswer()", ["int256"]]]) reads.push({ target: FEEDS[7], signature, outputs, args: [] });
  return reads;
}
function numberHex(value) { return typeof value === "string" && /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value) && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(BigInt(value)) : null; }
function publicCounters(context) {
  const raw = context.statistics(), out = {};
  for (const key of ["dispatchedRequests", "stateRequests", "stateReadOperations", "stateCacheHits", "stateTransportFailures",
    "revertedStateReads", "rejectedRequests", "networkCalls", "headerFamilies", "stateFamilies", "automaticRetries"]) {
    if (!count(raw[key])) fail("COUNTERS_INVALID"); out[key] = raw[key];
  }
  return out;
}
/**
 * Parent-only entry point; returns a sanitized artifact, never native topology.
 * Required: approval, candidates (JSON descriptors), transport, sourceProfile.
 * Optional: profile (defaults to rootDiscoveryProfile), now, historyStore.
 * sourceProfile contains CODE_FILES SHA-256 pins, nine root artifactJson bytes
 * and their SHA-256/runtime-keccak bindings, approved per-target callSelectors,
 * and optional inline semanticEvidence for the existing oracle observer.
 * digest() is canonical sorted-key JSON SHA-256 (not the scope's byte hash).
 * OFFLINE_FIXTURE additionally permits openCollection/collector injections;
 * NATIVE forbids them. All injected transports must honor the passed finite
 * timeout and maxBytes. The guard retains slots until transports really settle.
 */
async function observeBase(options = {}) {
  const now = options.now || Date.now;
  let started;
  const out = { schema: "aave-v4-base-combined-observation/v1", chainId: 8453, status: "INCOMPLETE", errors: [],
    complete: false, coverage: { complete: false, classification: "SOURCE_INCOMPLETE" }, classSemantics: { exact: false }, coveragePromotion: false, dispatchEnabled: false, liveAdmission: false,
    baseGuardQualified: false, freshness: "UNKNOWN", creationHistory: "UNKNOWN", historyPublished: false,
    components: { topology: null, borrowers: null, oracles: null, roots: null },
    attestations: { topology: null, borrowers: null, oracles: null, wholeContext: null }, closed: false };
  let request, guard, context, original, pin, closed = false, phase = "QUALIFICATION", stage = "QUALIFICATION", finalizing = false;
  let fault = null, rawTopology, l, o, roots, stagedHistory = null, historyNext, historyChunks = 0, totalLogs = 0;
  const work = new Set(), rpcWork = new Set(), qualification = new Map(), historyUsers = new Set();
  let canaryDispatches = 0;
  const stop = code => { if (!fault) fault = code; fail(code); };
  function track(promise, set) {
    const p = Promise.resolve(promise); set.add(p);
    p.then(() => set.delete(p), () => { set.delete(p); if (phase !== "QUALIFICATION" && !fault) fault = "RUN_FAILED"; });
    return p;
  }
  async function drain() { while (work.size || rpcWork.size) await Promise.allSettled([...work, ...rpcWork]); }
  function check(ordinary = false) {
    if (closed) fail("RUN_CLOSED");
    if (fault) fail(fault);
    if (now() < started || now() >= request.approval.expiresAtMs) stop("APPROVAL_EXPIRED");
    guard.check();
    const remaining = request.budget.maxMs - (now() - started);
    if (ordinary && (remaining <= request.budget.terminalReserveMs || guard.statistics().requests >= request.budget.maxRequests - 8)) stop("BUDGET_EXHAUSTED");
    if (pin && (now() - Number(pin.timestamp) * 1000 > request.budget.maxPinAgeMs || Number(pin.timestamp) * 1000 - now() > 60000)) stop("PIN_INVALID");
  }
  try {
    started = now();
    if (!count(started)) fail("APPROVAL_INVALID");
    request = validateRequest(options, started); out.mode = request.profile.mode; out.execution = request.approval.execution;
    const transport = options.transport;
    const C = require("./admit-aave-v4-base"), fs = options.fs || require("node:fs"), path = require("node:path");
    const root = path.resolve(options.workspace || path.join(__dirname, ".."));
    for (const file of CODE_FILES) {
      const local = C.containedPath(root, file, fs);
      if (sha256(fs.readFileSync(local)) !== request.sources.codeHashes[file]) fail("SOURCES_INVALID");
    }
    const validated = C.loadScope(options.scopePath || "tools/aave-v4-base-admission-scope.json", { fs, workspace: root });
    if (validated.scopeSha256 !== SCOPE_SHA256 || validated.allowedAddresses.length !== 38
      || sha256([...validated.allowedAddresses].sort().join("\n")) !== ADDRESS_SET_SHA256) fail("SCOPE_INVALID");
    const allowed = new Set(validated.allowedAddresses), { Interface, id, keccak256 } = require("ethers");
    const borrowTopic = id("Borrow(uint256,address,address,uint256,uint256)");
    const zeroTopic = "0x" + "0".repeat(64), probeData = id("getAssetCount()").slice(0, 10);
    const reads = rootReads().map(row => ({ ...row, iface: new Interface([`function ${row.signature} view returns (${row.outputs.join(",")})`]) }));
    for (const row of request.sources.roots) {
      const artifact = JSON.parse(row.artifactJson);
      const shared = row.evidenceKind === "SHARED_RUNTIME_CLASS", publicationAddress = shared ? row.peerAddress : row.address;
      if (shared) {
        const peer = request.sources.roots.find(item => item.address === FEEDS[0]);
        const witness = { schema: "aave-v4-base-shared-runtime-class/v1", chainId: 8453, target: FEEDS[6], peer: FEEDS[0],
          codeKeccak256: row.codeKeccak256, peerArtifactSha256: row.sourceEvidenceSha256, classId: "EACAggregatorProxy",
          claim: "INTERFACE_ONLY_NO_PER_ADDRESS_PUBLICATION" };
        const review = { schema: "aave-v4-base-shared-runtime-review/v1", classWitnessSha256: digest(witness), conclusion: "ABI_ONLY_CURRENT_STATE_UNKNOWN" };
        if (row.address !== FEEDS[6] || row.peerAddress !== FEEDS[0] || peer?.evidenceKind !== "DIRECT_PUBLICATION"
          || peer.artifactJson !== row.artifactJson || peer.sourceEvidenceSha256 !== row.sourceEvidenceSha256 || peer.codeKeccak256 !== row.codeKeccak256
          || canonical(row.classWitness) !== canonical(witness) || row.classWitnessSha256 !== digest(witness)
          || canonical(row.reviewStatement) !== canonical(review) || row.reviewStatementSha256 !== digest(review)) fail("SOURCES_INVALID");
      } else if (row.peerAddress !== undefined || row.classWitness !== undefined || row.reviewStatement !== undefined) fail("SOURCES_INVALID");
      if (Number(artifact.chainId) !== 8453 || artifact.address?.toLowerCase() !== publicationAddress || !["match", "exact_match"].includes(artifact.runtimeMatch)
        || !/^0x(?:[0-9a-f]{2})+$/.test(artifact.runtimeBytecode?.onchainBytecode || "")
        || keccak256(artifact.runtimeBytecode.onchainBytecode) !== row.codeKeccak256 || !Array.isArray(artifact.abi)) fail("SOURCES_INVALID");
      const abi = new Interface(artifact.abi);
      for (const read of reads.filter(read => read.target === row.address)) {
        if (abi.getFunction(read.signature)?.outputs.map(x => x.type).join() !== read.outputs.join()) fail("SOURCES_INVALID");
      }
    }
    for (const at of Object.keys(request.sources.callSelectors || {})) if (!allowed.has(at)) fail("SOURCES_INVALID");
    // No child following in this adapter, even when a child happens to be in 38.
    for (const descriptor of request.sources.semanticEvidence?.semanticDescriptors || []) if (![ORACLE, ...FEEDS].includes(descriptor.address)
      || descriptor.sourceEvidence?.review?.statement?.child !== undefined
      || request.sources.roots.find(row => row.address === descriptor.address)?.evidenceKind === "SHARED_RUNTIME_CLASS") fail("SOURCES_INVALID");
    const rootData = new Set(reads.map(row => row.target + ":" + row.iface.encodeFunctionData(row.signature, row.args)));
    const borrowEvent = new Interface(["event Borrow(uint256 indexed reserveId,address indexed caller,address indexed user,uint256 drawnShares,uint256 drawnAmount)"]);
    historyNext = request.profile.history.fromBlock;
    const candidateState = handle => {
      if (!qualification.has(handle)) qualification.set(handle, { step: "INITIAL", chain: false, header: null, commonFinalized: null, commonHeader: null,
        probes: new Set(), dispatched: 0 });
      return qualification.get(handle);
    };
    function canaryStage(handle, filter) {
      const q = request.profile.qualificationCanaryPolicy, c = candidateState(handle);
      if (phase !== "QUALIFICATION" || !request.profile.qualificationCanaries || !q
        || !filter || Object.keys(filter).sort().join() !== "address,blockHash,topics" || filter.address !== HUB
        || JSON.stringify(filter.topics) !== JSON.stringify([zeroTopic]) || !hash(filter.blockHash)
        || c.dispatched >= q.maxPerCandidate || canaryDispatches >= q.maxTotal || !c.chain
        || !["code", "storage", "call"].every(name => c.probes.has(name))) stop("QUALIFICATION_CANARY_REFUSED");
      const header = c.step === "INITIAL" ? c.header : c.step === "COMMON" ? c.commonHeader : null;
      if (!header || header.hash !== filter.blockHash || header.number < q.minBlock || header.number > q.maxBlock) stop("QUALIFICATION_CANARY_REFUSED");
      if (c.step === "COMMON") {
        const families = new Set(request.candidates.filter(row => canonical(candidateState(row.handle).commonHeader) === canonical(header)).map(row => row.operatorFamily));
        if (!c.commonFinalized || header.number > c.commonFinalized.number || families.size < 2 || families.has(undefined)) stop("QUALIFICATION_CANARY_REFUSED");
      }
      return c.step === "INITIAL" ? "PINNED_CANDIDATE" : "COMMON_PIN";
    }
    function policy(method, params, handle) {
      check(!finalizing && method !== "eth_getBlockByNumber");
      if (finalizing && (method !== "eth_getBlockByNumber" || params[0] !== "0x" + pin.number.toString(16))) stop("READ_POLICY_REFUSED");
      if (phase === "QUALIFICATION" && request.profile.qualificationCanaries) {
        const c = candidateState(handle), q = request.profile.qualificationCanaryPolicy;
        if (method === "eth_chainId" && !((c.step === "INITIAL" && !c.chain && !c.header) || c.step === "INITIAL_DONE")) stop("QUALIFICATION_CANARY_REFUSED");
        if (method === "eth_getBlockByNumber" && (!c.chain || !["INITIAL", "COMMON"].includes(c.step)
          || (params[0] !== "finalized" && (c.step !== "COMMON" || !c.commonFinalized || numberHex(params[0]) === null
            || numberHex(params[0]) < q.minBlock || numberHex(params[0]) > q.maxBlock || numberHex(params[0]) > c.commonFinalized.number)))) stop("QUALIFICATION_HEADER_INVALID");
        if (["eth_getCode", "eth_getStorageAt", "eth_call"].includes(method)) {
          const header = c.step === "INITIAL" ? c.header : c.step === "COMMON" ? c.commonHeader : null;
          const at = method === "eth_call" ? params[0]?.to : params[0];
          if (!header || at !== HUB || params.at(-1)?.blockHash !== header.hash
            || (method === "eth_getStorageAt" && params[1] !== zeroTopic)) stop("QUALIFICATION_CANARY_REFUSED");
        }
      }
      if (method === "eth_getLogs") {
        const f = params[0], at = Array.isArray(f?.address) ? f.address.length === 1 ? f.address[0] : null : f?.address;
        if (phase === "QUALIFICATION" && request.profile.qualificationCanaries) { canaryStage(handle, f); return; }
        if (!request.profile.history.enabled) stop("HISTORY_POLICY_REFUSED");
        const from = numberHex(f?.fromBlock), to = numberHex(f?.toBlock), h = request.profile.history;
        if (phase === "QUALIFICATION" || stage !== "BORROWERS" || at?.toLowerCase() !== SPOKE
          || JSON.stringify(f.topics) !== JSON.stringify([borrowTopic]) || from === null || to === null || !pin
          || from !== historyNext || from < h.fromBlock || to < from || to > pin.number || to - from + 1 > h.chunkSize
          || historyChunks >= h.maxChunks || Object.keys(f).sort().join() !== "address,fromBlock,toBlock,topics") stop("HISTORY_POLICY_REFUSED");
      }
      if (method === "eth_call") {
        const at = params[0]?.to?.toLowerCase(), data = params[0]?.data;
        if (phase === "QUALIFICATION") { if (at !== HUB || data !== probeData) stop("READ_POLICY_REFUSED"); }
        else if (stage === "ROOTS") { if (!rootData.has(at + ":" + data)) stop("READ_POLICY_REFUSED"); }
        else if (!request.sources.callSelectors?.[at]?.includes(data?.slice(0, 10))
          || (stage === "BORROWERS" && ![HUB, SPOKE].includes(at))
          || (stage === "ORACLES" && ![SPOKE, ORACLE, ...FEEDS].includes(at))
          || (at === FEEDS[7] && data.slice(0, 10) === id("latestRoundData()").slice(0, 10))) stop("READ_POLICY_REFUSED");
      }
      if (phase !== "QUALIFICATION" && ["eth_getCode", "eth_getStorageAt", "eth_call"].includes(method)
        && (params.at(-1)?.blockHash !== pin.hash || params.at(-1)?.requireCanonical !== true)) stop("PIN_INVALID");
      if (method === "eth_getBlockByNumber" && pin && (numberHex(params[0]) === null || numberHex(params[0]) > pin.number)) stop("READ_POLICY_REFUSED");
    }
    async function raw(handle, method, params, timeout, transportOptions) {
      policy(method, params, handle);
      const c = candidateState(handle), qualificationCall = phase === "QUALIFICATION";
      if (qualificationCall && method === "eth_getLogs") {
        const which = canaryStage(handle, params[0]);
        c.dispatched++; canaryDispatches++; c.step = which === "PINNED_CANDIDATE" ? "INITIAL_DONE" : "COMMON_DONE";
      }
      const value = await transport(handle, method, params, timeout, transportOptions);
      if (Buffer.byteLength(JSON.stringify(value) ?? "") > request.budget.maxBytes) stop("READ_POLICY_REFUSED");
      if (qualificationCall && request.profile.qualificationCanaries && method === "eth_chainId") {
        c.chain = value === "0x2105";
        if (c.step === "INITIAL_DONE") { c.step = "COMMON"; c.probes.clear(); }
        else if (c.step !== "INITIAL") stop("QUALIFICATION_CANARY_REFUSED");
      }
      if (qualificationCall && request.profile.qualificationCanaries && method === "eth_getBlockByNumber") {
        const header = require("./lib/common-finalized-rpc-preflight").normalizeHeader(value), q = request.profile.qualificationCanaryPolicy;
        if (!header || !c.chain || !q || header.number < q.minBlock || header.number > q.maxBlock
          || /^0x0{64}$/.test(header.hash) || /^0x0{64}$/.test(header.stateRoot)
          || (params[0] !== "finalized" && numberHex(params[0]) !== header.number)
          || now() - Number(header.timestamp) * 1000 > request.budget.maxPinAgeMs || Number(header.timestamp) * 1000 - now() > 60000) stop("QUALIFICATION_HEADER_INVALID");
        if (c.step === "INITIAL" && params[0] === "finalized") { c.header = header; c.probes.clear(); }
        else if (c.step === "COMMON" && params[0] === "finalized") { c.commonFinalized = header; c.commonHeader = null; c.probes.clear(); }
        else if (c.step === "COMMON" && c.commonFinalized && numberHex(params[0]) !== null && header.number <= c.commonFinalized.number) { c.commonHeader = header; c.probes.clear(); }
        else stop("QUALIFICATION_HEADER_INVALID");
      }
      if (qualificationCall && request.profile.qualificationCanaries && ["eth_getCode", "eth_getStorageAt", "eth_call"].includes(method)) {
        const expected = c.step === "INITIAL" ? c.header : c.step === "COMMON" ? c.commonHeader : null;
        if (!expected || params.at(-1)?.blockHash !== expected.hash) stop("QUALIFICATION_CANARY_REFUSED");
        if (method === "eth_getCode" ? !/^0x(?:[0-9a-f]{2})+$/.test(value || "") : !hash(value)) stop("QUALIFICATION_CANARY_REFUSED");
        c.probes.add(method === "eth_getCode" ? "code" : method === "eth_getStorageAt" ? "storage" : "call");
      }
      if (method === "eth_getLogs" && phase !== "QUALIFICATION") {
        if (!Array.isArray(value) || value.length >= request.profile.history.maxLogs
          || totalLogs + value.length > request.profile.history.maxLogs) stop("HISTORY_RESULT_REFUSED");
        const f = params[0], seen = new Set(), additions = new Set();
        for (const log of value) {
          const n = numberHex(log?.blockNumber), logIndex = numberHex(log?.logIndex);
          if (log?.removed !== false || log.address?.toLowerCase() !== SPOKE || n === null || n < numberHex(f.fromBlock) || n > numberHex(f.toBlock)
            || logIndex === null || !hash(log.blockHash) || !hash(log.transactionHash) || log.topics?.length !== 4
            || log.topics[0] !== borrowTopic || log.topics.some(topic => !hash(topic)) || !/^0x[0-9a-f]{128}$/i.test(log.data || "")) stop("HISTORY_RESULT_REFUSED");
          const key = `${log.blockHash}:${log.transactionHash}:${logIndex}`;
          if (seen.has(key)) stop("HISTORY_RESULT_REFUSED"); seen.add(key);
          let decoded;
          try { decoded = borrowEvent.decodeEventLog("Borrow", log.data, log.topics); } catch (_) { stop("HISTORY_RESULT_REFUSED"); }
          if (decoded.reserveId > 7n || /^0x0{40}$/.test(decoded.user)) stop("HISTORY_RESULT_REFUSED");
          additions.add(decoded.user.toLowerCase());
        }
        if (new Set([...historyUsers, ...additions]).size > request.profile.history.maxUsers) stop("HISTORY_RESULT_REFUSED");
        additions.forEach(user => historyUsers.add(user)); totalLogs += value.length; historyNext = numberHex(f.toBlock) + 1; historyChunks++;
      }
      return value;
    }
    guard = C.createRpcGuard({ allowedAddresses: validated.allowedAddresses, rpcRead: raw, now, started, budget: request.budget,
      phase: "QUALIFICATION", paceMs: request.budget.paceMs, sleep: options.sleep });
    const rpc = (handle, method, params, timeout) => {
      if (closed) return Promise.reject(new ObservationRunError("RUN_CLOSED"));
      let snapshot;
      try {
        if (!request.candidates.some(candidate => candidate.handle === handle)) stop("READ_POLICY_REFUSED");
        snapshot = freeze(clone(params)); policy(method, snapshot, handle);
      }
      catch (error) { if (!fault) fault = "READ_POLICY_REFUSED"; return Promise.reject(error); }
      return track(guard.rpc(handle, method, snapshot, timeout), rpcWork);
    };
    check();
    const pinned = options.openCollection ? null : require("./lib/aave-v4-pinned-collection");
    const limits = Object.fromEntries(Object.keys(LIMITS).filter(key => !["paceMs", "terminalReserveMs"].includes(key)).map(key => [key, request.budget[key]]));
    original = await (options.openCollection || pinned.openPinnedCollection)({ chainId: 8453, candidates: request.candidates,
      probeAddress: HUB, rpc, now, limits });
    await drain(); check();
    if (original?.chainId !== 8453 || !count(original.pin?.number) || !hash(original.pin.hash) || !hash(original.pin.stateRoot)
      || !count(Number(original.pin.timestamp))) fail("PIN_INVALID");
    pin = original.pin; guard.beginStateCollection(); phase = "STATE";
    const provider = {};
    for (const name of ["getCode", "getStorage", "call", "getLogs", "getBlock", "callMany"]) if (typeof original.provider?.[name] === "function") {
      provider[name] = (...args) => {
        try {
          check(true);
          if (["getCode", "getStorage"].includes(name)) guard.target(args[0], name === "getCode" ? "eth_getCode" : "eth_getStorageAt");
          if (name === "call") guard.target(args[0]?.to, "eth_call");
          if (name === "call") policy("eth_call", [args[0], { blockHash: pin.hash, requireCanonical: true }]);
          return track(original.provider[name](...args), work);
        } catch (error) { return Promise.reject(error); }
      };
    }
    context = Object.freeze({ ...original, provider: Object.freeze(provider), canCollect: () => {
      try { check(true); return original.canCollect(); } catch (_) { return false; }
    }, checkpointBlock: n => { check(); return track(original.checkpointBlock(n), work); },
    confirmPin: () => { check(); return track(original.confirmPin(), work); } });
    const inventory = [];
    for (const at of validated.allowedAddresses) {
      const code = await context.provider.getCode(at);
      if (typeof code !== "string" || !/^0x(?:[0-9a-f]{2})+$/.test(code)) fail("CURRENT_BINDING_FAILED");
      inventory.push({ address: at, roles: validated.moduleAddressRoles[at] || [], codePresent: true,
        codeBytes: (code.length - 2) / 2, codeKeccak256: keccak256(code) });
    }
    for (const proxy of validated.proxies) {
      const slot = await context.provider.getStorage(proxy.address, "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc");
      if (!/^0x0{24}[0-9a-f]{40}$/.test(slot || "")) fail("CURRENT_BINDING_FAILED");
      const row = inventory.find(item => item.address === proxy.address), implementation = "0x" + slot.slice(-40);
      if (!allowed.has(implementation) || !validated.dependencies.some(item => item.parent === proxy.address && item.address === implementation)) fail("CURRENT_BINDING_FAILED");
      row.implementation = implementation; row.implementationInFrozenScope = true;
    }
    const roles = require("./lib/aave-v4-base-role-evidence");
    const published = roles.loadPublishedEvidence({ readFile: file => fs.readFileSync(C.containedPath(root, file, fs)) });
    const roleBindings = roles.bindRoleEvidence({ chainId: 8453, registry: validated.scope.registry, scopeSha256: validated.scopeSha256,
      pin, published, inventory: { chainId: 8453, pin, complete: inventory.length === 38, rows: inventory } });
    const extract = C.registryExtract(validated, pin);
    roles.assertBindings(roleBindings, { chainId: 8453, pin, registry: extract });
    for (const rootSource of request.sources.roots) if (inventory.find(row => row.address === rootSource.address)?.codeKeccak256 !== rootSource.codeKeccak256) fail("CURRENT_BINDING_FAILED");
    out.inventory = { complete: true, addressesObserved: inventory.length, proxyPointersObserved: validated.proxies.length };
    if (request.profile.roots) {
      stage = "ROOTS"; roots = { readings: [], priceChildCandidates: [], controlAddresses: [], freshness: "UNKNOWN", sourceSemanticsQualified: false,
        evidence: request.sources.roots.map(row => ({ target: row.address, evidenceKind: row.evidenceKind,
          publicationAddress: row.peerAddress || row.address, perAddressPublication: row.evidenceKind === "DIRECT_PUBLICATION",
          currentStorage: "UNKNOWN", currentConfig: "UNKNOWN", currentChild: "UNKNOWN", currentAdmin: "UNKNOWN", freshness: "UNKNOWN" })) };
      for (const read of reads) {
        const rawValue = await context.provider.call({ to: read.target, data: read.iface.encodeFunctionData(read.signature, read.args) });
        let values; try { values = read.iface.decodeFunctionResult(read.signature, rawValue); } catch (_) { fail("COMPONENT_FAILED"); }
        const valuesRaw = Array.from(values, value => typeof value === "bigint" ? value.toString() : value.toLowerCase());
        roots.readings.push({ target: read.target, signature: read.signature, args: read.args, values: valuesRaw });
        if (["aggregator()", "ASSET_TO_USD_AGGREGATOR()"].includes(read.signature) && address(valuesRaw[0]) && !/^0x0{40}$/.test(valuesRaw[0])) roots.priceChildCandidates.push(valuesRaw[0]);
        if (["accessController()", "ACL_MANAGER()"].includes(read.signature) && address(valuesRaw[0])) roots.controlAddresses.push(valuesRaw[0]);
      }
      roots.priceChildCandidates = [...new Set(roots.priceChildCandidates)]; roots.controlAddresses = [...new Set(roots.controlAddresses)];
      if (roots.priceChildCandidates.length > 8) fail("COMPONENT_FAILED");
      out.counts = { rootReadOperations: reads.length };
    }
    if (request.profile.topology) {
      stage = "TOPOLOGY";
      rawTopology = await (options.collectTopology || require("./scan-aave-v4-hubs").collectTopology)({ chainId: 8453, registryExtract: extract,
        roleBindings, openCollection: async () => context, fetchPrices: async () => ({}), now });
      // Native scanner amounts are BigInt until its CLI's JSON boundary. Apply
      // that lossless amount encoding to this NEW result only; do not repair
      // metadata, replace its 34-read pin, or serialize the opaque deps bindings.
      if (!options.collectTopology) rawTopology = JSON.parse(JSON.stringify(rawTopology, (_key, value) => typeof value === "bigint" ? value.toString() : value));
      const contract = require("./lib/aave-v4-base-observation-contract");
      const prepared = contract.prepareTopology(rawTopology, now());
      out.counts = { ...(out.counts || {}), topologyLogicalReads: prepared.coverage.stateReadsAttempted };
      const stagedStore = { load: async identity => {
        const history = require("./lib/aave-v4-borrower-history");
        const index = options.historyStore ? clone(await options.historyStore.load(identity)) : history.emptyHistory(identity);
        history.validateHistory(index, identity);
        if (index.identity.fromBlock !== request.profile.history.fromBlock || index.logs > request.profile.history.maxLogs
          || index.users[SPOKE].length > request.profile.history.maxUsers) stop("HISTORY_POLICY_REFUSED");
        totalLogs = index.logs;
        index.users[SPOKE].forEach(row => historyUsers.add(row.user));
        historyNext = index.throughBlock + 1;
        return clone(index);
      }, save: async index => { stagedHistory = clone(index); } };
      const source = request.sources.semanticEvidence || {};
      const common = { context, roleBindings, now, frozenScope: freeze({ chainId: 8453, addresses: [...validated.allowedAddresses],
        digest: contract.digest([...validated.allowedAddresses].sort()) }), runtimeExpectations: source.runtimeExpectations
          || request.sources.roots.map(row => ({ address: row.address, codeKeccak256: row.codeKeccak256 })),
        semanticDescriptors: source.semanticDescriptors };
      stage = "BORROWERS";
      l = await (options.collectBorrowers || require("./scan-aave-v4-base-borrowers").collectBaseBorrowers)(rawTopology, { ...common,
        historyStore: stagedStore, startProof: request.profile.history.startProof, maxUsers: request.profile.history.maxUsers,
        historyOptions: { chunkSize: request.profile.history.chunkSize, maxChunks: request.profile.history.maxChunks, maxLogs: request.profile.history.maxLogs } });
      if (l?.terminalPinConfirmed !== true || !l.observationPin) fail("COMPONENT_FAILED");
      stage = "ORACLES";
      o = await (options.collectOracles || require("./scan-aave-v4-base-oracles").collectBaseOracles)(rawTopology, common);
      if (o?.terminalPinConfirmed !== true || !o.observationPin) fail("COMPONENT_FAILED");
    }
    await drain(); check();
    finalizing = true;
    let terminal;
    try { terminal = await context.confirmPin(); await drain(); } catch (_) { fail("FINAL_CONFIRMATION_FAILED"); }
    if (JSON.stringify(terminal) !== JSON.stringify(pin)) fail("FINAL_CONFIRMATION_FAILED");
    check();
    const statistics = publicCounters(original), g = guard.statistics();
    if (g.activeRequests || g.stateFailures || g.stateReverts || g.fatalCode || statistics.stateTransportFailures || statistics.revertedStateReads
      || statistics.rejectedRequests || statistics.automaticRetries || statistics.headerFamilies < 2
      || statistics.networkCalls !== g.actualDispatches || statistics.dispatchedRequests !== g.actualDispatches
      || statistics.networkCalls > request.budget.maxRequests || work.size || rpcWork.size) fail("COUNTERS_INVALID");
    const contract = require("./lib/aave-v4-base-observation-contract");
    out.attestations.wholeContext = contract.publicPin(original.observationPin({ stateReadsAttempted: statistics.stateReadOperations,
      stateReadsSucceeded: statistics.stateReadOperations, stateReadsFailed: 0 }), pin, statistics.stateReadOperations);
    if (rawTopology) out.attestations.topology = contract.publicPin(rawTopology.sourceCoverage.observationPin, pin, rawTopology.sourceCoverage.stateReadsAttempted);
    for (const [name, component] of [["borrowers", l], ["oracles", o]]) if (component?.observationPin) {
      out.attestations[name] = contract.publicPin(component.observationPin, pin, component.stateReads.attempted);
    }
    out.counts = { ...(out.counts || {}), borrowerStateReads: l?.stateReads?.attempted ?? null, oracleStateReads: o?.stateReads?.attempted ?? null,
      qualificationCanaryDispatches: canaryDispatches,
      wholeContext: statistics, physical: { requests: g.requests, actualDispatches: g.actualDispatches,
        qualificationFailures: g.qualificationFailures, stateFailures: g.stateFailures, stateReverts: g.stateReverts, activeRequests: 0 } };
    closed = true; out.closed = true;
    const partial = [l, o].some(component => component && (component.errors?.length || component.componentObservationComplete !== true));
    const labels = new Set(["ROOT_DISCOVERY", "FULL_L_O", "DIRECT_PUBLICATION", "SHARED_RUNTIME_CLASS", "UNKNOWN", "PASS", "FAIL", "NOT_COLLECTED", ...reads.map(read => read.signature)]);
    for (const label of ["GENESIS", "SNAPSHOT", "RAW_POSITION_COMPONENTS", "aave-v4-base-borrower-history/v1", "SOURCE_SEMANTICS_UNQUALIFIED",
      "SOURCE_EXPOSES_NO_TIMESTAMP", "CURRENT_CHILD_BINDING_UNQUALIFIED", "CHILD_SCOPE_OR_SOURCE_UNQUALIFIED", "PARENT_TIMESTAMP_NOT_INDEPENDENTLY_OBSERVED",
      "ADAPTER_PROPAGATED", "ADAPTER_REPORTED", "CHILD_ONLY_PARENT_UNKNOWN"]) labels.add(label);
    const sanitized = value => publicProjection(C.sanitizeTopology(value, labels));
    out.components = { topology: rawTopology ? sanitized(rawTopology) : null,
      borrowers: l ? sanitized(l) : { status: "NOT_COLLECTED", fullHistoryProven: false, creationHistory: "UNKNOWN" },
      oracles: o ? sanitized(o) : { status: "NOT_COLLECTED", freshness: "UNKNOWN" }, roots: roots ? sanitized(roots) : null };
    // Build every public artifact before the last side effect. The parent's
    // injected store.save must itself provide atomic local persistence; there
    // is no automatic/default store and a partial component is never committed.
    if (stagedHistory && !partial && options.historyStore?.save) {
      try { await options.historyStore.save(clone(stagedHistory)); out.historyPublished = true; }
      catch (_) { fail("HISTORY_COMMIT_FAILED"); }
    }
    out.status = partial ? "OBSERVED_PARTIAL" : "OBSERVED";
  } catch (error) {
    out.errors.push(error instanceof ObservationRunError && SAFE_CODES.has(error.code) ? error.code : "RUN_FAILED");
    stagedHistory = null;
    // Stop queued/new transports immediately, but retain every active physical
    // slot until the reviewed finite-time transport actually settles.
    closed = true;
    await drain();
    out.closed = true; out.status = "INCOMPLETE"; out.historyPublished = false;
    out.components = { topology: null, borrowers: null, oracles: null, roots: null };
    out.attestations = { topology: null, borrowers: null, oracles: null, wholeContext: null };
    if (guard) { const g = guard.statistics(); out.partialPhysicalCounts = { requests: g.requests, actualDispatches: g.actualDispatches,
      qualificationCanaryDispatches: canaryDispatches, qualificationFailures: g.qualificationFailures, stateFailures: g.stateFailures, stateReverts: g.stateReverts, activeRequests: g.activeRequests }; }
  }
  return out;
}
async function runCli(argv = [], options = {}) {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === "--check")) return { status: "OFFLINE_CHECK_ONLY", chainId: 8453,
    requiresNewParentApproval: true, nativeRootZeroLogSupported: false, nativeRootApprovedQualificationCanariesSupported: true,
    blocker: "NATIVE_ROOT_ZERO_LOG_UNSUPPORTED", networkCalls: 0, writes: 0 };
  if (argv.length === 1 && argv[0] === "--capture") return observeBase(options);
  return { status: "REFUSED", code: "PROFILE_INVALID", networkCalls: 0, writes: 0 };
}
if (require.main === module) runCli(process.argv.slice(2)).then(result => { console.log(JSON.stringify(result)); if (["INCOMPLETE", "REFUSED"].includes(result.status)) process.exitCode = 1; });
module.exports = { observeBase, runCli, rootDiscoveryProfile, rootReads, digest, SCOPE_SHA256, ADDRESS_SET_SHA256, LIMITS, CODE_FILES, ObservationRunError };
