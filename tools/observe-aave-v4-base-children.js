#!/usr/bin/env node
"use strict";
// Parent-injected, read-only child observation. No provider/inventory/approval
// discovery. Public source is data, never executable. Parent owns approval burn.
const crypto = require("node:crypto");
const BASE = "reports/coverage-unblock-20261018/continuation/";
const ARCHIVE = BASE + "public-child-sources/";
const HUB = "0xa4d5947eb727a052bae69c593ffc84247ec9864e", SPOKE = "0x17905db0e4a3514467539956c084180616ae7b8d";
const ORACLE = "0xabaf048fd7675ea34a84332371ffd5d55e322a47", IMPL = "0x81a73c282faa932de3b2541cee19549f4bf13b19";
const SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc", ZERO = "0x" + "0".repeat(64);
const OCR = "0x16f41184f797cb8f8918680df0ebf2a97cc3192aa6b104615f61096fc674f2aa";
const EAC = "0xbd6f524cdc4268b6bd1bb6f77a8821faeea9c52ee9e0afa0b6d948ce82c966c2";
const PROXY = "0x57db7d2196b3603cef54f6fdeae8332584be1e54b2bd9c2a7c827a89f5482e61";
const IMPL_HASH = "0x919242697bc12c3081610e470b50011f50312fedd852ea04282a1ee5294c3881";
const HUB_HASH = "0xf3e0ac43f298f860c8e49e8a580d542c083f30d5b40f68750d0b3d45037a4fdc";
const SCOPE_SHA256 = "a15d870270f0f92a1c7f90f1e6d89d469f3510bc6e6d8f690861617efad7cf0c";
const ANCHORS = Object.freeze({
  ["tools/aave-v4-base-admission-scope.json"]: SCOPE_SHA256,
  [BASE + "observed-price-child-bindings.json"]: "fc85c2dc30f570d171a966f74fc20f226c2c273734b56a1c67b84fb26ad0b9e1",
  [ARCHIVE + "receipt.json"]: "6973dadc09cbc9fdff92796c3a51251dea1d00b72a057261a8d1bd4f9d4100ce",
  [ARCHIVE + "not-approved-child-readset.json"]: "2fe929f89908f4a569ceaf4e0f80c7565f14abc1cabefb3064a2926f535e404a",
  [ARCHIVE + "semantics.md"]: "e782b3e3f27160b5b51e53f40e6f6a3268ed34f96c4b605fd84ec055c3942207",
  [BASE + "public-base-sources/receipt.json"]: "76c5e06bc3bc424f9a7a7a10fd44145c668bdd247054d436d98abd28e252b9dd",
});
const CODE_FILES = Object.freeze(["tools/observe-aave-v4-base-children.js", "tools/test/aave-v4-base-children.test.js",
  "tools/admit-aave-v4-base.js", "tools/lib/aave-v4-pinned-collection.js", "tools/lib/common-finalized-rpc-preflight.js",
  "tools/shared-rpc.js", "tools/lib/rpc-provider-reliability.js", "tools/lib/producer-deadline.js", "tools/aave-v4-base-role-evidence.json"]);
const LIMITS = Object.freeze({ maxCandidates: 2, maxRequests: 12000, maxMs: 240000, timeoutMs: 10000, maxBytes: 4194304,
  concurrency: 4, maxPinAgeMs: 1800000, reserveRequests: 8, terminalReserveMs: 30000, paceMs: 1000 });
const CODES = new Set(["INPUT_INVALID", "EVIDENCE_INVALID", "SCOPE_INVALID", "PLAN_INVALID", "APPROVAL_REQUIRED", "APPROVAL_INVALID",
  "APPROVAL_EXPIRED", "TRANSPORT_REQUIRED", "READ_REFUSED", "CANARY_REFUSED", "HEADER_INVALID", "BUDGET_EXHAUSTED", "RUN_CLOSED",
  "READ_FAILED", "FINAL_CONFIRMATION_FAILED", "COUNTERS_INVALID", "RUN_FAILED"]);
class ChildObservationError extends Error { constructor(code) { super(CODES.has(code) ? code : "RUN_FAILED"); this.code = this.message; } }
function fail(code) { throw new ChildObservationError(code); }
function sha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function canonical(v) { return Array.isArray(v) ? "[" + v.map(canonical).join(",") + "]" : v && typeof v === "object"
  ? "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}" : JSON.stringify(v); }
function digest(v) { return sha256(canonical(v)); }
function clone(v) { try { return JSON.parse(JSON.stringify(v)); } catch (_) { fail("INPUT_INVALID"); } }
function freeze(v) { if (v && typeof v === "object") { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }
const count = v => Number.isSafeInteger(v) && v >= 0;
const address = v => typeof v === "string" && /^0x[0-9a-f]{40}$/.test(v);
const hash = v => typeof v === "string" && /^0x[0-9a-f]{64}$/.test(v);
const quantity = v => typeof v === "string" && /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(v) && BigInt(v) <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(BigInt(v)) : null;
function evidenceModel(evidence) {
  const { Interface, keccak256 } = require("ethers"), files = evidence?.files;
  if (!files || Object.keys(files).length > 64) fail("EVIDENCE_INVALID");
  let bytes = 0;
  const get = (file, expected) => {
    const text = files[file];
    if (typeof text !== "string" || Buffer.byteLength(text) > 4194304 || (expected && sha256(text) !== expected)) fail("EVIDENCE_INVALID");
    return text;
  };
  for (const text of Object.values(files)) { if (typeof text !== "string") fail("EVIDENCE_INVALID"); bytes += Buffer.byteLength(text); }
  if (bytes > 25165824) fail("EVIDENCE_INVALID");
  for (const [file, expected] of Object.entries(ANCHORS)) get(file, expected);
  const original = JSON.parse(get("tools/aave-v4-base-admission-scope.json")), bindings = JSON.parse(get(BASE + "observed-price-child-bindings.json"));
  const receipt = JSON.parse(get(ARCHIVE + "receipt.json")), archived = JSON.parse(get(ARCHIVE + "not-approved-child-readset.json"));
  const parentReceipt = JSON.parse(get(BASE + "public-base-sources/receipt.json"));
  for (const row of parentReceipt.rows.filter(row => row.status === "ARCHIVED" && /^(?:oracle|feed-[0-57])\.json$/.test(row.file))) {
    const artifact = JSON.parse(get(BASE + "public-base-sources/" + row.file, row.sha256));
    if (Number(artifact.chainId) !== 8453 || artifact.address.toLowerCase() !== row.address
      || keccak256(artifact.runtimeBytecode.onchainBytecode) !== row.publishedRuntimeKeccak256) fail("EVIDENCE_INVALID");
  }
  const originalAddresses = [...new Set([...original.components, ...original.dependencies].map(row => row.address))].sort();
  if (originalAddresses.length !== 38 || bindings.bindings.length !== 8 || archived.targets.length !== 8 || receipt.rows.length !== 8) fail("EVIDENCE_INVALID");
  const roleFile = "tools/aave-v4-base-role-evidence.json", roles = JSON.parse(get(roleFile));
  const lending = roles.roles.find(row => row.role === "lending"), hub = roles.roles.find(row => row.role === "hub");
  if (lending.address !== SPOKE || lending.implementation !== IMPL || lending.proxyCodeKeccak256 !== PROXY
    || lending.implementationCodeKeccak256 !== IMPL_HASH || hub.address !== HUB || hub.proxyCodeKeccak256 !== HUB_HASH) fail("EVIDENCE_INVALID");
  const implArtifact = JSON.parse(get(lending.runtime.filePath, lending.runtime.sha256));
  if (implArtifact.address.toLowerCase() !== IMPL || keccak256(implArtifact.runtimeBytecode.onchainBytecode) !== IMPL_HASH) fail("EVIDENCE_INVALID");
  const child0 = JSON.parse(get(ARCHIVE + receipt.rows[0].file, receipt.rows[0].sha256));
  const sourceCommitments = {};
  for (const name of ["src/OCR2Aggregator.sol", "src/AccessControlledOCR2Aggregator.sol", "src/SimpleReadAccessController.sol", "src/SimpleWriteAccessController.sol"]) {
    const expected = child0.metadata.sources[name].keccak256;
    if (keccak256(Buffer.from(child0.sources[name].content)) !== expected) fail("EVIDENCE_INVALID"); sourceCommitments[name] = expected;
  }
  const classProof = { schema: "base-child-published-class/v1", classId: "AccessControlledOCR2Aggregator", runtimeKeccak256: OCR,
    sourceArtifactSha256: receipt.rows[0].sha256, sourceCommitments,
    interpretation: "OBSERVATION_AND_TRANSMISSION_TIMESTAMPS_ACCESS_CONTEXT_NOT_FRESHNESS" };
  if (digest(evidence.classProof) !== digest(classProof)) fail("EVIDENCE_INVALID");
  const operations = [], call = (target, signature, outputs, args, key, reserveId = null) => {
    const iface = new Interface([`function ${signature} view returns (${outputs.join(",")})`]);
    operations.push({ kind: "call", target, signature, outputs, args, data: iface.encodeFunctionData(signature, args), key, reserveId });
  };
  const code = (target, expected, key, reserveId = null) => operations.push({ kind: "code", target, expected, key, reserveId });
  code(SPOKE, PROXY, "spokeCode"); code(ORACLE, parentReceipt.rows.find(r => r.address === ORACLE).publishedRuntimeKeccak256, "oracleCode");
  operations.push({ kind: "storage", target: SPOKE, slot: SLOT, expected: "0x" + "0".repeat(24) + IMPL.slice(2), key: "implementationPointer", reserveId: null });
  code(IMPL, IMPL_HASH, "implementationCode");
  call(SPOKE, "ORACLE()", ["address"], [], "spokeOracle"); call(ORACLE, "spoke()", ["address"], [], "oracleSpoke");
  call(ORACLE, "decimals()", ["uint8"], [], "oracleDecimals");
  const rows = bindings.bindings.map((binding, i) => {
    const published = receipt.rows[i], target = archived.targets[i];
    if (binding.reserveId !== i || published.index !== i || published.address !== binding.directPriceChild || target.address !== binding.directPriceChild
      || target.consumerParent !== binding.feed || !address(binding.feed) || !address(binding.directPriceChild)) fail("EVIDENCE_INVALID");
    const parent = parentReceipt.rows.find(r => r.address === binding.feed) || parentReceipt.rows.find(r => r.address === bindings.bindings[0].feed);
    const parentPublication = parent.status === "ARCHIVED" ? parent : parentReceipt.rows.find(r => r.address === bindings.bindings[0].feed);
    const parentArtifact = JSON.parse(get(BASE + "public-base-sources/" + parentPublication.file, parentPublication.sha256));
    if (parentArtifact.address.toLowerCase() !== parentPublication.address || keccak256(parentArtifact.runtimeBytecode.onchainBytecode) !== parentPublication.publishedRuntimeKeccak256) fail("EVIDENCE_INVALID");
    const childRaw = get(ARCHIVE + published.file, published.sha256), abiText = get(ARCHIVE + target.sourceAbiFile, target.sourceAbiSha256), abi = JSON.parse(abiText);
    const iface = new Interface(abi), expectedRuntime = i === 7 ? EAC : OCR;
    if (published.published.runtimeKeccak256 !== expectedRuntime || published.published.runtimeBytes !== (i === 7 ? 9571 : 22337)) fail("EVIDENCE_INVALID");
    if (![3, 5].includes(i)) {
      const a = JSON.parse(childRaw);
      if (a.address.toLowerCase() !== binding.directPriceChild || Number(a.chainId) !== 8453 || digest(a.abi) !== digest(abi)
        || keccak256(a.runtimeBytecode.onchainBytecode) !== expectedRuntime) fail("EVIDENCE_INVALID");
    }
    const names = ["decimals", "description", "latestRoundData", ...(i < 7 ? ["typeAndVersion", "latestConfigDetails", "latestConfigDigestAndEpoch", "checkEnabled", "hasAccess"] : ["aggregator", "phaseId", "accessController"])];
    const expectedTypes = { decimals: ["uint8"], description: ["string"], latestRoundData: ["uint80", "int256", "uint256", "uint256", "uint80"],
      typeAndVersion: ["string"], latestConfigDetails: ["uint32", "uint32", "bytes32"], latestConfigDigestAndEpoch: ["bool", "bytes32", "uint32"],
      checkEnabled: ["bool"], hasAccess: ["bool"], aggregator: ["address"], phaseId: ["uint16"], accessController: ["address"] };
    if (target.calls.length !== names.length) fail("EVIDENCE_INVALID");
    for (let n = 0; n < names.length; n++) {
      const name = names[n], fn = iface.getFunction(name), frozen = target.calls[n];
      if (!fn || digest(fn.outputs.map(p => p.type)) !== digest(expectedTypes[name])
        || digest(fn.inputs.map(p => p.type)) !== digest(name === "hasAccess" ? ["address", "bytes"] : [])
        || fn.format("sighash") !== frozen.signature || digest(fn.outputs.map(p => ({ name: p.name, type: p.type }))) !== digest(frozen.outputs)) fail("EVIDENCE_INVALID");
    }
    call(ORACLE, "getReserveSource(uint256)", ["address"], [i], "oracleSource", i);
    return { reserveId: i, parent: binding.feed, child: binding.directPriceChild, parentHash: parentPublication.publishedRuntimeKeccak256,
      childHash: expectedRuntime, parentSignature: i < 7 ? "aggregator()" : "ASSET_TO_USD_AGGREGATOR()", abi, calls: target.calls,
      perAddressSourcePublication: ![3, 5].includes(i), sourceGap: [3, 5].includes(i) ? "HTML_SOURCE_UNPARSED" : "NONE", parentPerAddressPublication: i !== 6 };
  });
  for (const row of rows) code(row.parent, row.parentHash, "parentCode", row.reserveId);
  for (const row of rows) call(row.parent, row.parentSignature, ["address"], [], "parentLink", row.reserveId);
  for (const row of rows) code(row.child, row.childHash, "childCode", row.reserveId);
  for (const row of rows) for (const method of row.calls) call(row.child, method.signature, method.outputs.map(p => p.type), method.args, method.signature.split("(")[0], row.reserveId);
  if (operations.length !== 101) fail("PLAN_INVALID");
  const addresses = [...new Set([...originalAddresses, ...rows.map(row => row.child)])].sort();
  if (addresses.length !== 46 || operations.some(op => !addresses.includes(op.target))) fail("SCOPE_INVALID");
  const scope = { schema: "base-child-observation-scope/v1", chainId: 8453, originalScopeSha256: SCOPE_SHA256,
    bindingsSha256: ANCHORS[BASE + "observed-price-child-bindings.json"], originalAddresses, childAddresses: rows.map(row => row.child), addresses,
    addressSetSha256: sha256(addresses.join("\n")) };
  const canary = { schema: "base-child-qualification-canaries/v1", address: HUB, topic: ZERO, minBlock: 52754104, maxBlock: 52774104,
    maxPerCandidate: 2, maxTotal: 4, stages: ["PINNED_CANDIDATE", "COMMON_PIN"] };
  const fileHashes = Object.fromEntries(Object.entries(files).map(([file, value]) => [file, sha256(value)]));
  const codeHashes = Object.fromEntries(CODE_FILES.map(file => [file, sha256(get(file))]));
  if (digest(evidence.codeHashes) !== digest(codeHashes)) fail("EVIDENCE_INVALID");
  return { scope, rows, operations, canary, fileHashes, codeHashes, evidenceDigest: digest({ fileHashes, classProof }), codeDigest: digest(codeHashes) };
}
/** Pure: byte/shape/digest validation only; no filesystem, provider or transport. */
function validateChildPlan(inputs) {
  try {
    const model = evidenceModel(inputs.evidence), readset = inputs.readset;
    if (digest(inputs.scope) !== digest(model.scope)) fail("SCOPE_INVALID");
    if (readset?.schema !== "base-child-observation-plan/v1" || readset.mode !== "CHILDREN_101" || readset.history !== false
      || digest(readset.operations) !== digest(model.operations) || digest(readset.qualificationCanaryPolicy) !== digest(model.canary)) fail("PLAN_INVALID");
    const limits = readset.limits;
    if (!limits || Object.keys(limits).sort().join() !== Object.keys(LIMITS).sort().join()
      || Object.entries(LIMITS).some(([key, cap]) => !Number.isSafeInteger(limits[key]) || limits[key] <= 0
        || (key === "paceMs" ? limits[key] < 1000 || limits[key] > 10000 : limits[key] > cap))
      || limits.maxCandidates !== 2 || limits.reserveRequests !== 8 || limits.terminalReserveMs !== 30000 || limits.maxRequests < 160) fail("PLAN_INVALID");
    return freeze({ ...model, readset: clone(readset), planDigest: digest(readset), scopeDigest: digest(model.scope) });
  } catch (error) { if (error instanceof ChildObservationError) throw error; fail("EVIDENCE_INVALID"); }
}
/** Explicit local-public-file builder. Does not approve, choose candidates, or write. */
function buildPublicChildInputs({ workspace, originalScopeFile, bindingsFile, childArchiveDirectory, parentArchiveDirectory } = {}) {
  if (![workspace, originalScopeFile, bindingsFile, childArchiveDirectory, parentArchiveDirectory].every(v => typeof v === "string" && v.length)) fail("INPUT_INVALID");
  const fs = require("node:fs"), path = require("node:path"), root = path.resolve(workspace), C = require("./admit-aave-v4-base");
  const files = {}, read = file => { if (!Object.hasOwn(files, file)) files[file] = fs.readFileSync(C.containedPath(root, file, fs), "utf8"); return files[file]; };
  if (originalScopeFile !== "tools/aave-v4-base-admission-scope.json" || bindingsFile !== BASE + "observed-price-child-bindings.json"
    || childArchiveDirectory !== ARCHIVE.slice(0, -1) || parentArchiveDirectory !== (BASE + "public-base-sources")) fail("INPUT_INVALID");
  C.loadScope(originalScopeFile, { workspace: root });
  for (const file of [...Object.keys(ANCHORS), ...CODE_FILES]) read(file);
  const roles = JSON.parse(read("tools/aave-v4-base-role-evidence.json")); read(roles.roles.find(r => r.role === "lending").runtime.filePath);
  const childReceipt = JSON.parse(read(ARCHIVE + "receipt.json")), archived = JSON.parse(read(ARCHIVE + "not-approved-child-readset.json"));
  for (const row of childReceipt.rows) read(ARCHIVE + row.file);
  for (const row of archived.targets) read(ARCHIVE + row.sourceAbiFile);
  for (const row of JSON.parse(read(BASE + "public-base-sources/receipt.json")).rows.filter(row => row.status === "ARCHIVED" && /^feed-[0-57]\.json$|^oracle\.json$/.test(row.file))) read(BASE + "public-base-sources/" + row.file);
  const child0 = JSON.parse(read(ARCHIVE + "child-0.json")), sourceCommitments = {};
  for (const name of ["src/OCR2Aggregator.sol", "src/AccessControlledOCR2Aggregator.sol", "src/SimpleReadAccessController.sol", "src/SimpleWriteAccessController.sol"]) sourceCommitments[name] = child0.metadata.sources[name].keccak256;
  const evidence = { files, codeHashes: Object.fromEntries(CODE_FILES.map(file => [file, sha256(files[file])])), classProof: {
    schema: "base-child-published-class/v1", classId: "AccessControlledOCR2Aggregator", runtimeKeccak256: OCR,
    sourceArtifactSha256: childReceipt.rows[0].sha256, sourceCommitments, interpretation: "OBSERVATION_AND_TRANSMISSION_TIMESTAMPS_ACCESS_CONTEXT_NOT_FRESHNESS" } };
  const model = evidenceModel(evidence);
  const readset = { schema: "base-child-observation-plan/v1", mode: "CHILDREN_101", history: false, operations: model.operations,
    qualificationCanaryPolicy: model.canary, limits: { ...LIMITS } };
  const inputs = { scope: model.scope, readset, evidence }; validateChildPlan(inputs); return inputs;
}

function validateApproval(approval, candidates, transport, model, now) {
  if (!approval) fail("APPROVAL_REQUIRED");
  if (approval.schema !== "base-child-observation-approval/v1" || approval.status !== "CURRENT_IN_PROGRESS" || approval.attemptStarted !== true
    || approval.chainId !== 8453 || approval.mode !== "CHILDREN_101" || approval.originalScopeSha256 !== SCOPE_SHA256
    || approval.scopeDigest !== model.scopeDigest || approval.addressSetSha256 !== model.scope.addressSetSha256 || approval.targetCount !== 46
    || approval.planDigest !== model.planDigest || approval.evidenceDigest !== model.evidenceDigest || approval.codeDigest !== model.codeDigest
    || approval.qualificationCanaryDigest !== digest(model.canary) || digest(approval.budget) !== digest(model.readset.limits)
    || !count(approval.issuedAtMs) || approval.issuedAtMs > now || !count(approval.expiresAtMs)) fail("APPROVAL_INVALID");
  if (approval.expiresAtMs <= now) fail("APPROVAL_EXPIRED");
  const P = require("./lib/common-finalized-rpc-preflight");
  if (typeof transport !== "function" || !Array.isArray(candidates) || candidates.length !== 2 || new Set(candidates.map(r => r.handle)).size !== 2
    || candidates.some(r => typeof r.handle !== "string" || !r.handle || !P.reviewedOperatorFamily(r.operatorFamily))
    || new Set(candidates.map(r => P.reviewedOperatorFamily(r.operatorFamily))).size !== 2 || approval.candidatesDigest !== digest(candidates)) fail("TRANSPORT_REQUIRED");
}

/**
 * Parent-only injected transport; it MUST honor timeout/maxBytes and settle on
 * abort. Physical slots are retained until settlement, never released by races.
 * No approval mutation/burn, output I/O, history, provider or context injection.
 * evidence.codeHashes bind supplied code bytes; the trusted parent independently
 * checks actual installed file hashes when freezing/burning its one-use approval.
 */
async function observeBaseChildren(options = {}) {
  const out = { schema: "base-child-observation/v1", chainId: 8453, status: "INCOMPLETE", errors: [], rows: [], blockers: [],
    coverage: { complete: false }, classSemantics: { exact: false }, promotion: false, coveragePromotion: false, dispatchEnabled: false,
    liveAdmission: false, baseGuardQualified: false, freshness: "UNKNOWN", observationPin: null, closed: false,
    stateReads: { planned: 101, attempted: 0, succeeded: 0, failed: 0, skipped: 101 }, qualificationCanaryDispatches: 0 };
  const now = options.now || Date.now;
  let model, guard, context, pin, started, closed = false, finalizing = false, phase = "QUALIFICATION", current = null, fault = null;
  let actualTransportStarts = 0, activeTransports = 0;
  const pending = new Set(), states = new Map();
  const stop = code => { if (!fault) fault = code; fail(code); };
  const drain = async () => { while (pending.size) await Promise.allSettled([...pending]); };
  const tracked = p => { pending.add(p); p.then(() => pending.delete(p), () => pending.delete(p)); return p; };
  try {
    started = now(); if (!count(started)) fail("INPUT_INVALID");
    model = validateChildPlan(options);
    out.inputCommitments = { scopeDigest: model.scopeDigest, planDigest: model.planDigest, evidenceDigest: model.evidenceDigest,
      codeDigest: model.codeDigest, originalScopeSha256: SCOPE_SHA256, bindingsSha256: model.scope.bindingsSha256 };
    const approval = freeze(clone(options.approval || null)), candidates = freeze(clone(options.candidates || null));
    validateApproval(approval, candidates, options.transport, model, started);
    for (const key of ["openCollection", "context", "provider", "historyStore", "policy"]) if (options[key] !== undefined) fail("INPUT_INVALID");
    const limits = model.readset.limits, transport = options.transport, C = require("./admit-aave-v4-base"), P = require("./lib/common-finalized-rpc-preflight");
    out.operatorFamilies = candidates.map(row => P.reviewedOperatorFamily(row.operatorFamily)).sort();
    const { Interface, keccak256, id } = require("ethers"), probe = id("getAssetCount()").slice(0, 10);
    function check(ordinary = false) {
      if (closed) fail("RUN_CLOSED"); if (fault) fail(fault);
      const time = now(); if (time < started || time >= approval.expiresAtMs) stop("APPROVAL_EXPIRED");
      guard.check();
      if (ordinary && (time - started >= limits.maxMs - 30000 || guard.statistics().requests >= limits.maxRequests - 8)) stop("BUDGET_EXHAUSTED");
      if (pin && (time - Number(pin.timestamp) * 1000 > limits.maxPinAgeMs || Number(pin.timestamp) * 1000 - time > 60000)) stop("HEADER_INVALID");
    }
    const state = handle => { if (!states.has(handle)) states.set(handle, { stage: "INITIAL", chain: false, header: null, finalized: null, common: null, probes: new Set(), canaries: 0 }); return states.get(handle); };
    function policy(handle, method, params) {
      check(!finalizing && method !== "eth_getBlockByNumber");
      if (!candidates.some(row => row.handle === handle)) stop("READ_REFUSED");
      const c = state(handle);
      if (phase === "STATE") {
        if (finalizing) { if (method !== "eth_getBlockByNumber" || params[0] !== "0x" + pin.number.toString(16)) stop("READ_REFUSED"); return; }
        if (!current || current.used) stop("READ_REFUSED");
        const expectedMethod = current.kind === "code" ? "eth_getCode" : current.kind === "storage" ? "eth_getStorageAt" : "eth_call";
        const expected = current.kind === "call" ? [{ to: current.target, data: current.data }, { blockHash: pin.hash, requireCanonical: true }]
          : current.kind === "code" ? [current.target, { blockHash: pin.hash, requireCanonical: true }]
            : [current.target, current.slot, { blockHash: pin.hash, requireCanonical: true }];
        if (method !== expectedMethod || canonical(params) !== canonical(expected)) stop("READ_REFUSED"); return;
      }
      if (method === "eth_chainId") { if (!((c.stage === "INITIAL" && !c.chain) || c.stage === "INITIAL_DONE")) stop("CANARY_REFUSED"); return; }
      if (method === "eth_getBlockByNumber") {
        const n = quantity(params[0]);
        if (!c.chain || !["INITIAL", "COMMON"].includes(c.stage) || (params[0] !== "finalized"
          && (c.stage !== "COMMON" || !c.finalized || n === null || n < model.canary.minBlock || n > model.canary.maxBlock || n > c.finalized.number))) stop("HEADER_INVALID"); return;
      }
      const header = c.stage === "INITIAL" ? c.header : c.stage === "COMMON" ? c.common : null;
      if (method === "eth_getLogs") {
        const filter = params[0];
        if (!header || Object.keys(filter || {}).sort().join() !== "address,blockHash,topics" || filter.address !== HUB || filter.blockHash !== header.hash
          || canonical(filter.topics) !== canonical([ZERO]) || c.canaries >= 2 || out.qualificationCanaryDispatches >= 4
          || !["eth_getCode", "eth_getStorageAt", "eth_call"].every(name => c.probes.has(name))) stop("CANARY_REFUSED");
        if (c.stage === "COMMON" && new Set(candidates.filter(row => canonical(state(row.handle).common) === canonical(header)).map(row => row.operatorFamily)).size !== 2) stop("CANARY_REFUSED");
        return;
      }
      if (!["eth_getCode", "eth_getStorageAt", "eth_call"].includes(method) || !header || params.at(-1)?.blockHash !== header.hash) stop("READ_REFUSED");
      if (method === "eth_call" ? params[0]?.to !== HUB || params[0]?.data !== probe : params[0] !== HUB || (method === "eth_getStorageAt" && params[1] !== ZERO)) stop("READ_REFUSED");
    }
    async function raw(handle, method, params, timeout, transportOptions) {
      policy(handle, method, params);
      const c = state(handle), qualification = phase === "QUALIFICATION";
      if (qualification && method === "eth_getLogs") { c.canaries++; out.qualificationCanaryDispatches++; c.stage = c.stage === "INITIAL" ? "INITIAL_DONE" : "COMMON_DONE"; }
      if (!qualification && !finalizing) current.used = true;
      let result;
      actualTransportStarts++; activeTransports++;
      try { result = await transport(handle, method, params, timeout, transportOptions); }
      finally { activeTransports--; }
      if (Buffer.byteLength(JSON.stringify(result) ?? "") > limits.maxBytes) stop("READ_REFUSED");
      if (qualification && method === "eth_chainId") { c.chain = quantity(result) === 8453; if (c.stage === "INITIAL_DONE") { c.stage = "COMMON"; c.probes.clear(); } }
      if (qualification && method === "eth_getBlockByNumber") {
        const h = P.normalizeHeader(result);
        if (!h || h.number < model.canary.minBlock || h.number > model.canary.maxBlock || h.hash === ZERO || h.stateRoot === ZERO
          || (params[0] !== "finalized" && quantity(params[0]) !== h.number) || now() - Number(h.timestamp) * 1000 > limits.maxPinAgeMs
          || Number(h.timestamp) * 1000 - now() > 60000) stop("HEADER_INVALID");
        c.probes.clear();
        if (c.stage === "INITIAL" && params[0] === "finalized") c.header = h;
        else if (c.stage === "COMMON" && params[0] === "finalized") { c.finalized = h; c.common = null; }
        else if (c.stage === "COMMON" && c.finalized && h.number <= c.finalized.number) c.common = h;
        else stop("HEADER_INVALID");
      }
      if (qualification && ["eth_getCode", "eth_getStorageAt", "eth_call"].includes(method)) {
        if (method === "eth_getCode" ? !/^0x(?:[0-9a-f]{2})+$/.test(result || "") || keccak256(result) !== HUB_HASH : !hash(result)) stop("READ_REFUSED");
        c.probes.add(method);
      }
      return result;
    }
    guard = C.createRpcGuard({ allowedAddresses: model.scope.addresses, rpcRead: raw, now, started, budget: limits, phase: "QUALIFICATION", paceMs: limits.paceMs, sleep: options.sleep });
    const rpc = (handle, method, params, timeout) => {
      try { const snapshot = freeze(clone(params)); policy(handle, method, snapshot); return tracked(guard.rpc(handle, method, snapshot, timeout)); }
      catch (error) { if (!fault) fault = error instanceof ChildObservationError ? error.code : "READ_REFUSED"; return Promise.reject(error); }
    };
    context = await require("./lib/aave-v4-pinned-collection").openPinnedCollection({ chainId: 8453, probeAddress: HUB, candidates,
      rpc, now, limits: Object.fromEntries(Object.entries(limits).filter(([key]) => !["paceMs", "terminalReserveMs"].includes(key))) });
    await drain(); check(); pin = context.pin;
    if (context.chainId !== 8453 || !count(pin.number) || !hash(pin.hash) || !hash(pin.stateRoot) || !count(Number(pin.timestamp))) fail("HEADER_INVALID");
    guard.beginStateCollection(); phase = "STATE";
    out.rows = model.rows.map(row => ({ reserveId: row.reserveId, parent: row.parent, child: row.child, perAddressSourcePublication: row.perAddressSourcePublication,
      sourceGap: row.sourceGap, parentPerAddressPublication: row.parentPerAddressPublication, runtimeClassMatched: false, parentLinkMatched: false,
      blockers: [], views: {}, round: null, freshness: "UNKNOWN", heartbeat: "UNKNOWN", marketHours: "UNKNOWN", consumerMaxAge: "UNKNOWN", consumerPricePathQualification: "UNKNOWN" }));
    let globalInvalid = false;
    function block(op, code) { const list = op.reserveId === null ? out.blockers : out.rows[op.reserveId].blockers; if (!list.includes(code)) list.push(code); if (op.reserveId === null) globalInvalid = true; }
    for (const operation of model.operations) {
      const row = operation.reserveId === null ? null : out.rows[operation.reserveId];
      if (globalInvalid || (row?.blockers.length && operation.key !== "parentCode")) continue;
      check(true); current = { ...operation, used: false }; out.stateReads.attempted++; out.stateReads.skipped--;
      let decoded;
      try {
        if (operation.kind === "code") {
          const code = await context.provider.getCode(operation.target); out.stateReads.succeeded++;
          if (!/^0x(?:[0-9a-f]{2})+$/.test(code || "") || keccak256(code) !== operation.expected) block(operation, "RUNTIME_MISMATCH");
          else if (operation.key === "childCode") row.runtimeClassMatched = true;
        } else if (operation.kind === "storage") {
          const value = await context.provider.getStorage(operation.target, operation.slot); out.stateReads.succeeded++;
          if (value !== operation.expected) block(operation, "IMPLEMENTATION_POINTER_MISMATCH");
        } else {
          const iface = new Interface([`function ${operation.signature} view returns (${operation.outputs.join(",")})`]);
          const data = await context.provider.call({ to: operation.target, data: operation.data });
          if (data.length > 32770) throw new Error(); decoded = iface.decodeFunctionResult(operation.signature, data);
          if (iface.encodeFunctionResult(operation.signature, decoded).toLowerCase() !== data.toLowerCase()) throw new Error(); out.stateReads.succeeded++;
          if (operation.key === "spokeOracle" && decoded[0].toLowerCase() !== ORACLE || operation.key === "oracleSpoke" && decoded[0].toLowerCase() !== SPOKE
            || operation.key === "oracleDecimals" && decoded[0] !== 8n) block(operation, "RECIPROCAL_IDENTITY_MISMATCH");
          else if (operation.key === "oracleSource" && decoded[0].toLowerCase() !== row.parent) block(operation, "ORACLE_SOURCE_MISMATCH");
          else if (operation.key === "parentLink") { if (decoded[0].toLowerCase() !== row.child) block(operation, "PARENT_LINK_MISMATCH"); else row.parentLinkMatched = true; }
          else if (row && operation.target === row.child) {
            row.views[operation.key] = Array.from(decoded, (value, i) => operation.outputs[i] === "string"
              ? { omitted: true, bytes: Buffer.byteLength(value), sha256: sha256(value) } : typeof value === "bigint" ? value.toString() : typeof value === "string" ? value.toLowerCase() : value);
            if (row.reserveId === 7 && operation.key === "aggregator") row.nextLayer = {
              aggregator: decoded[0].toLowerCase(), scope: "UNSCOPED_RECORD_ONLY", runtime: "UNKNOWN", followUpCalls: 0 };
            if (operation.key === "decimals" && decoded[0] !== 8n) block(operation, "DECIMALS_MISMATCH");
            if (operation.key === "hasAccess" && decoded[0] === false) block(operation, "ACCESS_OBSERVED_FALSE");
            if (operation.key === "latestRoundData") {
              const [roundId, answer, observation, transmission, answeredInRound] = decoded, time = BigInt(pin.timestamp), flags = [];
              if (!roundId || !observation || !transmission || answeredInRound < roundId || transmission < observation) flags.push("INVALID_ROUND_STRUCTURE");
              if (observation > time || transmission > time) flags.push("FUTURE_TIMESTAMP");
              if (answer <= 0n) flags.push("NON_POSITIVE_ANSWER");
              row.round = { roundId: String(roundId), answerRaw: String(answer), startedAt: String(observation), updatedAt: String(transmission), answeredInRound: String(answeredInRound),
                timestampUnit: "SECONDS", oracleDecimals: 8, startedAtMeaning: row.reserveId < 7 ? "OBSERVATION_TIMESTAMP" : "FORWARDED_NEXT_LAYER_UNQUALIFIED",
                updatedAtMeaning: row.reserveId < 7 ? "TRANSMISSION_TIMESTAMP" : "FORWARDED_NEXT_LAYER_UNQUALIFIED", observationAgeSecondsRaw: String(time - observation),
                transmissionAgeSecondsRaw: String(time - transmission), ageClassification: "OBSERVED_METRIC_NOT_FRESHNESS", flags };
              for (const flag of flags) block(operation, flag);
            }
          }
        }
      } catch (_) { out.stateReads.failed++; block(operation, "READ_FAILED"); if (guard.statistics().fatalCode) stop("READ_FAILED"); }
      finally { current = null; }
    }
    await drain(); check(); finalizing = true;
    try { const terminal = await context.confirmPin(); await drain(); if (canonical(terminal) !== canonical(pin)) fail("FINAL_CONFIRMATION_FAILED"); }
    catch (_) { fail("FINAL_CONFIRMATION_FAILED"); }
    check(); const g = guard.statistics(), s = context.statistics();
    const counters = ["networkCalls", "dispatchedRequests", "stateReadOperations", "stateCacheHits", "stateRequests", "stateTransportFailures", "revertedStateReads", "rejectedRequests", "headerFamilies", "stateFamilies", "automaticRetries"];
    if (counters.some(key => !count(s[key])) || g.activeRequests || activeTransports || pending.size || g.fatalCode || g.stateFailures || s.stateTransportFailures
      || s.rejectedRequests || s.automaticRetries || s.networkCalls !== g.actualDispatches || s.dispatchedRequests !== g.actualDispatches || actualTransportStarts !== g.actualDispatches
      || s.stateReadOperations !== out.stateReads.attempted || s.headerFamilies !== 2 || s.stateFamilies !== 1) fail("COUNTERS_INVALID");
    out.contextCounters = Object.fromEntries(counters.map(key => [key, s[key]]));
    if (!out.stateReads.failed && !g.stateReverts && !s.revertedStateReads) {
      const attestation = context.observationPin({ stateReadsAttempted: out.stateReads.attempted, stateReadsSucceeded: out.stateReads.succeeded, stateReadsFailed: 0 });
      if (!attestation || attestation.schema !== "aave-v4-state-pin/v1" || attestation.finality !== "finalized" || attestation.rpcStrength !== "single-provider"
        || attestation.stateReadsPinned !== out.stateReads.attempted || attestation.blockHash !== pin.hash
        || attestation.terminalBlockHash !== pin.hash || attestation.blockNumber !== pin.number || attestation.terminalBlockNumber !== pin.number
        || attestation.stateRoot !== pin.stateRoot || attestation.chainId !== 8453 || attestation.headerFamilies !== 2 || attestation.stateFamilies !== 1) fail("COUNTERS_INVALID");
      out.observationPin = { schema: "aave-v4-state-pin/v1", chainId: 8453, blockNumber: pin.number, blockHash: pin.hash, stateRoot: pin.stateRoot,
        terminalBlockNumber: pin.number, terminalBlockHash: pin.hash, stateReadsPinned: out.stateReads.attempted, headerFamilies: 2, stateFamilies: 1,
        finality: "finalized", rpcStrength: "single-provider" };
    }
    out.status = out.stateReads.succeeded === 101 && !out.rows.some(row => row.blockers.length) && !out.blockers.length ? "OBSERVED" : "OBSERVED_PARTIAL";
  } catch (error) { out.errors.push(error instanceof ChildObservationError && CODES.has(error.code) ? error.code : "RUN_FAILED"); out.observationPin = null; }
  finally {
    closed = true; await drain(); out.closed = true;
    if (guard) { const g = guard.statistics(); out.physicalCounters = { reservations: g.requests, guardDispatches: g.actualDispatches, actualStarts: actualTransportStarts,
      activeRequests: g.activeRequests, activeTransports, qualificationFailures: g.qualificationFailures, stateFailures: g.stateFailures, stateReverts: g.stateReverts }; }
  }
  return out;
}
async function runCli(argv = []) {
  return !argv.length || argv.length === 1 && argv[0] === "--check"
    ? { status: "OFFLINE_CHECK_ONLY", planLogicalReads: 101, newChildScopeApprovalRequired: true, networkCalls: 0, writes: 0 }
    : { status: "REFUSED", code: "APPROVAL_REQUIRED", networkCalls: 0, writes: 0 };
}
if (require.main === module) runCli(process.argv.slice(2)).then(out => { console.log(JSON.stringify(out)); if (out.status === "REFUSED") process.exitCode = 1; });
module.exports = { validateChildPlan, observeBaseChildren, buildPublicChildInputs, runCli, digest, sha256, LIMITS, CODE_FILES, ANCHORS, ChildObservationError };
