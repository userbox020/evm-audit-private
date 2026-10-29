"use strict";

// Injected-only contract. Nothing here opens providers, inventories, stores or files.
// Native input is a fresh unsanitized topology with its OWN count-matched terminal
// pin, plus the original same-pin context and opaque deployed role bindings from
// aave-v4-base-role-evidence. A historical admission receipt is not this contract.
// Optional oracle semantic descriptors additionally require public source-artifact
// bytes, an exact observed-runtime match, and a code/source-bound parent semantic
// review statement. This validates that supplied evidence, not its review process.
const crypto = require("node:crypto");
const { Interface, AbiCoder, id, keccak256 } = require("ethers");
const HUB = "0xa4d5947eb727a052bae69c593ffc84247ec9864e";
const SPOKE = "0x17905db0e4a3514467539956c084180616ae7b8d";
const IMPLEMENTATION = "0x81a73c282faa932de3b2541cee19549f4bf13b19";
const IMPL_HASH = "0x919242697bc12c3081610e470b50011f50312fedd852ea04282a1ee5294c3881";
const ORACLE = "0xabaf048fd7675ea34a84332371ffd5d55e322a47";
const NON_LENDING = ["0x5f8d0102f5b51fae6de9d2f2561bda63fb5db674", "0x7081ce7eb1282c53cf38ea9b622f6269cb8fefdc"];
const ASSETS = Object.freeze([
  "0xb200000000000000000000c2e324d24d7eecd1fb", "0xb200000000000000000000d9192b6b456483c2e8",
  "0xb2000000000000000000002d0ba3164cc74f58b7", "0xb2000000000000000000008bc8786b856e61707c",
  "0xb200000000000000000000ab99cfa739e253872b", "0xb20000000000000000000078ee7ce2fe4908108c",
  "0xb2000000000000000000001e800a7f5189430cd0", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
]);
const FEEDS = Object.freeze([
  "0x787f13dea48db0897cbcdd985de77809d837f988", "0x06a8e4b3abb3b7543d8396fb2b763d22820cb295",
  "0x5bf49e0ffa937ce2fff033c739ad7c634c4d34f2", "0x6526ae6797a76123638b863aee4dd27ba4e4b27d",
  "0xeb10a6c9aa7e537aed766c08c35dae35b321b18c", "0x04689a41629776563e6822f76f2e57d148d28513",
  "0xfaf869185383a24f8cb00e27bda6b63b9905dcb4", "0xc7d0f8dcc1f860ca752054c59ea82ba2a5aab50c",
]);
const ADDRESS = /^0x[0-9a-f]{40}$/i, HASH = /^0x[0-9a-f]{64}$/i, DIGEST = /^[0-9a-f]{64}$/;
const SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const COMMIT = "3cd68031dad4e2fe0c8e8610e747b6083c2fc561";
const CODES = new Set(["INPUT_INVALID", "TOPOLOGY_METADATA_INVALID", "TOPOLOGY_STALE", "TOPOLOGY_PIN_INVALID", "TOPOLOGY_SCOPE_INVALID",
  "TOPOLOGY_READ_GAPS", "CONTEXT_REQUIRED", "CONTEXT_PIN_MISMATCH", "ROLE_BINDING_INVALID", "SCOPE_INVALID", "SOURCE_BINDING_INVALID",
  "RUNTIME_BINDING_INVALID", "OBSERVATION_READ_FAILED", "OBSERVATION_BUDGET_EXHAUSTED", "TERMINAL_CONFIRMATION_FAILED",
  "FINAL_ATTESTATION_UNAVAILABLE", "HISTORY_INVALID", "HISTORY_INCOMPLETE", "HISTORY_STORE_FAILED", "USER_CAP_REACHED",
  "BORROWER_DEBT_UNACCOUNTED", "START_PROOF_INVALID", "CREATION_PROOF_UNQUALIFIED", "ORACLE_WIRING_MISMATCH", "ORACLE_PRICE_INVALID"]);
class ObservationError extends Error {
  constructor(code) { const safe = CODES.has(code) ? code : "INPUT_INVALID"; super(safe); this.name = "ObservationError"; this.code = safe; }
}
function fail(code) { throw new ObservationError(code); }
function safeFailure(error, fallback = "OBSERVATION_READ_FAILED") { return error instanceof ObservationError && CODES.has(error.code) ? error.code : fallback; }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function digest(value) { return sha256(JSON.stringify(value)); }
function count(value) { return Number.isSafeInteger(value) && value >= 0; }
function at(value) { return typeof value === "string" && ADDRESS.test(value) ? value.toLowerCase() : null; }
function hasGaps(value) {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => {
    if (/^(?:error|errors|failureReason)$/.test(key)) {
      const bad = v => v && typeof v === "object" ? Object.values(v).some(bad) : typeof v === "number" ? v > 0 : Boolean(v);
      if (bad(child)) return true;
    }
    return (/truncated|incomplete/i.test(key) && child === true) || hasGaps(child);
  });
}
function samePin(a, b) {
  return a && b && a.number === b.number && a.hash === b.hash && a.stateRoot === b.stateRoot && Number(a.timestamp) === Number(b.timestamp);
}
function pinOf(chain) {
  if (chain?.id !== 8453 || !count(chain.blockNumber) || !HASH.test(chain.blockHash || "") || !HASH.test(chain.stateRoot || "")
    || /^0x0{64}$/i.test(chain.blockHash) || /^0x0{64}$/i.test(chain.stateRoot)
    || !count(chain.timestamp) || chain.finality !== "finalized") fail("TOPOLOGY_PIN_INVALID");
  return { number: chain.blockNumber, hash: chain.blockHash.toLowerCase(), stateRoot: chain.stateRoot.toLowerCase(), timestamp: chain.timestamp };
}
function publicPin(value, pin, reads) {
  if (!value || value.schema !== "aave-v4-state-pin/v1" || value.chainId !== 8453 || value.finality !== "finalized"
    || value.blockNumber !== pin.number || value.blockHash !== pin.hash || value.stateRoot !== pin.stateRoot
    || value.terminalBlockNumber !== pin.number || value.terminalBlockHash !== pin.hash || value.stateReadsPinned !== reads
    || !count(reads) || !count(value.headerFamilies) || value.headerFamilies < 2 || value.headerFamilies > 16
    || value.stateFamilies !== 1 || value.rpcStrength !== "single-provider") fail("TOPOLOGY_PIN_INVALID");
  return { schema: "aave-v4-state-pin/v1", chainId: 8453, blockNumber: pin.number, blockHash: pin.hash, stateRoot: pin.stateRoot,
    finality: "finalized", stateReadsPinned: reads, terminalBlockNumber: pin.number, terminalBlockHash: pin.hash,
    headerFamilies: value.headerFamilies, stateFamilies: 1, rpcStrength: "single-provider" };
}
function prepareTopology(topology, nowMs = Date.now()) {
  const coverage = topology?.sourceCoverage, declared = topology?.declaredTopology;
  if (!Number.isSafeInteger(nowMs) || !topology || coverage?.schema !== "aave-source-coverage/v1" || coverage.schemaVersion !== 1
    || coverage.protocolVersion !== "V4" || coverage.coverageKind !== "topology" || typeof topology.generatedAt !== "string"
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(topology.generatedAt)
    || !Number.isFinite(Date.parse(topology.generatedAt)) || !DIGEST.test(declared?.inventoryDigest || "")
    || new Date(Date.parse(topology.generatedAt)).toISOString() !== topology.generatedAt
    || declared.inventoryDigest !== coverage.topologyUniverse?.inventoryDigest || declared.commit !== COMMIT
    || declared.version !== "v4.74.1" || declared.registry !== "aave-dao/aave-address-book" || declared.bound !== true
    || coverage.topologyUniverse.bound !== true || coverage.topologyUniverse.registry !== declared.registry
    || coverage.topologyUniverse.version !== declared.version || coverage.topologyUniverse.commit !== declared.commit) fail("TOPOLOGY_METADATA_INVALID");
  if (nowMs - Date.parse(topology.generatedAt) > 600000 || nowMs < Date.parse(topology.generatedAt)) fail("TOPOLOGY_STALE");
  const pin = pinOf(topology.chain);
  if (declared.hubsDeclared !== 1 || Number(declared.pinBlock) !== pin.number || coverage.topologyUniverse.pinBlock !== declared.pinBlock) fail("TOPOLOGY_PIN_INVALID");
  if (nowMs - pin.timestamp * 1000 > 1800000 || pin.timestamp * 1000 - nowMs > 60000) fail("TOPOLOGY_STALE");
  if (hasGaps(topology) || topology.provisional === true || coverage.sampleComplete !== true || coverage.stateReadsFailed !== 0
    || !count(coverage.stateReadsAttempted) || coverage.stateReadsAttempted < 1 || coverage.stateReadsSucceeded !== coverage.stateReadsAttempted) fail("TOPOLOGY_READ_GAPS");
  const observationPin = publicPin(coverage.observationPin, pin, coverage.stateReadsAttempted);
  if (topology.hubs?.length !== 1 || at(topology.hubs[0].address) !== HUB || topology.hubs[0].assets?.length !== 8
    || topology.hubs[0].assetCount !== 8 || topology.hubs[0].assetCountReadOk !== true) fail("TOPOLOGY_SCOPE_INVALID");
  const rows = [];
  for (const asset of topology.hubs[0].assets) {
    const i = asset.assetId;
    if (!Number.isInteger(i) || i < 0 || i > 7 || rows.some(row => row.reserveId === i) || at(asset.underlying) !== ASSETS[i]
      || asset.decimals !== (i === 7 ? 6 : 8)) fail("TOPOLOGY_SCOPE_INVALID");
    const lending = (asset.spokeDirectory?.rows || []).filter(row => at(row.address) === SPOKE);
    if (lending.length !== 1 || !count(asset.spokeDirectory.count) || asset.spokeDirectory.count !== asset.spokeDirectory.rows.length
      || asset.spokeDirectory.count > 12 || new Set(asset.spokeDirectory.rows.map(row => at(row.address))).size !== asset.spokeDirectory.count
      || asset.spokeDirectory.rows.some(row => at(row.address) !== SPOKE && (!NON_LENDING.includes(at(row.address))
        || row.reserve?.reserveBearing !== false || row.reserve?.reason !== "NON_LENDING_INTERFACE"))) fail("TOPOLOGY_SCOPE_INVALID");
    const row = lending[0], reserve = row.reserve;
    if (row.listed !== true || reserve?.reserveBearing !== true || reserve.reserveId !== i || at(reserve.reserve?.hub) !== HUB
      || Number(reserve.reserve.assetId) !== i || at(reserve.reserve.underlying) !== ASSETS[i]
      || reserve.reserve.decimals !== asset.decimals || at(reserve.oracleData?.address) !== ORACLE
      || at(reserve.oracleData?.spoke) !== SPOKE || at(reserve.oracleData?.source) !== FEEDS[i]
      || typeof reserve.totalDebtRaw !== "string" || !/^\d+$/.test(reserve.totalDebtRaw) || reserve.totalDebtRaw.length > 78
      || BigInt(reserve.totalDebtRaw) >= 2n ** 256n) fail("TOPOLOGY_SCOPE_INVALID");
    rows.push({ reserveId: i, assetId: i, hubAddress: HUB, spoke: SPOKE, underlying: ASSETS[i], decimals: asset.decimals,
      source: FEEDS[i], aggregateDebtRaw: reserve.totalDebtRaw });
  }
  const links = coverage.consumedReserveLinks;
  if (!Array.isArray(links) || links.length !== 8 || new Set(links.map(row => row.reserveId)).size !== 8
    || links.some(row => !rows.some(r => r.reserveId === row.reserveId && r.assetId === row.assetId && at(row.hubAddress) === HUB && at(row.spoke) === SPOKE))
    || ["reserveLinksExpected", "reserveLinksDeclared", "reserveLinksObserved", "reserveLinksConsumed", "assetsExpected", "assetsObserved"].some(key => coverage[key] !== 8)
    || ["hubsExpected", "hubsObserved", "spokesExpected", "spokesObserved"].some(key => coverage[key] !== 1)
    || coverage.spokeReserveLinks?.length !== 1 || at(coverage.spokeReserveLinks[0].spoke) !== SPOKE
    || ["expected", "observed", "consumed"].some(key => coverage.spokeReserveLinks[0][key] !== 8)
    || coverage.spokeReserveLinks[0].links?.length !== 8
    || digest(coverage.spokeReserveLinks[0].links) !== digest(links)) fail("TOPOLOGY_SCOPE_INVALID");
  return { pin, observationPin, coverage: { stateReadsAttempted: coverage.stateReadsAttempted, stateReadsSucceeded: coverage.stateReadsSucceeded, stateReadsFailed: 0 },
    registryDigest: declared.inventoryDigest, registry: { version: declared.version, commit: declared.commit }, links: rows.sort((a, b) => a.reserveId - b.reserveId) };
}
async function openObservation(topology, deps = {}, options = {}) {
  const now = deps.now || Date.now, prepared = prepareTopology(topology, now());
  let context;
  if (deps.context) context = deps.context;
  else if (typeof deps.openCollection === "function") {
    try { context = await deps.openCollection({ chainId: 8453, probeAddress: HUB,
      requestedPin: { chainId: 8453, finality: "finalized", blockNumber: prepared.pin.number, blockHash: prepared.pin.hash }, now,
      ...(options.historyProbe ? { historyProbe: options.historyProbe } : {}) }); }
    catch (_) { fail("CONTEXT_REQUIRED"); }
  } else fail("CONTEXT_REQUIRED");
  if (context?.chainId !== 8453 || !samePin(context.pin, prepared.pin) || typeof context.confirmPin !== "function"
    || typeof context.observationPin !== "function" || typeof context.canCollect !== "function" || typeof context.provider?.call !== "function") fail("CONTEXT_PIN_MISMATCH");
  try {
    const roles = require("./aave-v4-base-role-evidence");
    roles.assertBindings(deps.roleBindings, { chainId: 8453, pin: context.pin, registry: {
      commit: COMMIT, moduleSha256: "4f8dac4012e70c59e351167e4933af10630cd3ca70f569cbb15b088ba52fa059", version: "v4.74.1", hubs: [{ address: HUB }],
    } });
    const role = roles.bindingFor(deps.roleBindings, SPOKE);
    if (role?.role !== "lending" || role.implementation !== IMPLEMENTATION || role.implementationCodeKeccak256 !== IMPL_HASH) fail("ROLE_BINDING_INVALID");
  } catch (_) { fail("ROLE_BINDING_INVALID"); }
  // Do not mint a new topology attestation from a whole-capture read count.
  let attestation;
  try { attestation = context.observationPin(prepared.coverage); } catch (_) { fail("TOPOLOGY_PIN_INVALID"); }
  publicPin(attestation, prepared.pin, prepared.coverage.stateReadsAttempted);
  return { ...prepared, context, now };
}
function result(component, now = Date.now) {
  let time;
  try { time = now(); } catch (_) { time = NaN; }
  return { schema: `aave-v4-base-${component}-observation/v1`, chainId: 8453,
    generatedAt: Number.isSafeInteger(time) && Math.abs(time) <= 8640000000000000 ? new Date(time).toISOString() : null, evidenceOrigin: "INJECTED_PARENT_CONTEXT",
    componentObservationComplete: false, coverage: { complete: false, classification: "SOURCE_INCOMPLETE" },
    classSemantics: { exact: false }, coveragePromotion: false, dispatchEnabled: false, liveAdmission: false, baseGuardQualified: false,
    observationPin: null, terminalPinConfirmed: false, stateReads: { attempted: 0, succeeded: 0, failed: 0 }, errors: [], usdQualification: "UNKNOWN" };
}
async function read(state, target, iface, name, args = []) {
  if (!state.context.canCollect()) fail("OBSERVATION_BUDGET_EXHAUSTED");
  state.counts.attempted += 1;
  try {
    const raw = await state.context.provider.call({ to: target, data: iface.encodeFunctionData(name, args) });
    if (typeof raw !== "string" || raw.length > 131074 || !/^0x(?:[0-9a-f]{2})*$/i.test(raw)) throw new Error();
    const values = iface.decodeFunctionResult(name, raw);
    state.counts.succeeded += 1;
    return values;
  } catch (_) { state.counts.failed += 1; fail("OBSERVATION_READ_FAILED"); }
}
async function finish(out, state) {
  out.stateReads = { ...state.counts };
  try {
    const terminal = await state.context.confirmPin();
    const nowMs = state.now();
    if (!samePin(terminal, state.pin) || !count(nowMs) || nowMs - state.pin.timestamp * 1000 > 1800000
      || state.pin.timestamp * 1000 - nowMs > 60000) fail("TERMINAL_CONFIRMATION_FAILED");
    if (!out.stateReads.failed) {
      out.observationPin = publicPin(state.context.observationPin({ stateReadsAttempted: out.stateReads.attempted,
        stateReadsSucceeded: out.stateReads.succeeded, stateReadsFailed: 0 }), state.pin, out.stateReads.attempted);
    }
    out.terminalPinConfirmed = true;
    return true;
  } catch (_) { out.errors.push("TERMINAL_CONFIRMATION_FAILED"); out.terminalPinConfirmed = false; out.observationPin = null; out.componentObservationComplete = false; return false; }
}
function startProof(proof, prepared) {
  if (proof === undefined || proof?.kind === "GENESIS") {
    if (proof !== undefined && proof.fromBlock !== 0) fail("START_PROOF_INVALID");
    const data = { kind: "GENESIS", fromBlock: 0 };
    return { ...data, evidenceDigest: digest(data), fullHistoryEligible: true };
  }
  if (proof?.kind === "SNAPSHOT" && count(proof.fromBlock) && proof.fromBlock <= prepared.pin.number && HASH.test(proof.blockHash || "")) {
    const data = { kind: "SNAPSHOT", fromBlock: proof.fromBlock, blockHash: proof.blockHash.toLowerCase() };
    return { kind: data.kind, fromBlock: data.fromBlock, evidenceDigest: digest(data), fullHistoryEligible: false };
  }
  if (proof?.kind === "CREATION") {
    // Caller-supplied tx/receipt/header/code consistency is not canonical creation
    // provenance. No independently qualified creation binding exists here.
    fail("CREATION_PROOF_UNQUALIFIED");
  }
  fail("START_PROOF_INVALID");
}
function frozenScope(scope) {
  if (!scope || scope.chainId !== 8453 || !Object.isFrozen(scope.addresses) || !Array.isArray(scope.addresses)
    || scope.addresses.length > 128 || scope.addresses.some(value => !at(value)) || new Set(scope.addresses.map(at)).size !== scope.addresses.length
    || scope.digest !== digest([...scope.addresses].map(at).sort())) fail("SCOPE_INVALID");
  return new Set(scope.addresses.map(at));
}
async function runtimeBinding(state, address, expectations, scope) {
  const matches = Array.isArray(expectations) ? expectations.filter(row => at(row?.address) === address) : [];
  if (!scope.has(address) || matches.length !== 1 || !HASH.test(matches[0].codeKeccak256 || "")) fail("RUNTIME_BINDING_INVALID");
  const expected = matches[0];
  async function code(atAddress, expectedHash) {
    if (!scope.has(atAddress) || !HASH.test(expectedHash || "") || !state.context.canCollect()) fail("RUNTIME_BINDING_INVALID");
    state.counts.attempted += 1;
    try {
      const raw = await state.context.provider.getCode(atAddress);
      if (!/^0x(?:[0-9a-f]{2})+$/i.test(raw) || raw.length > 262146 || keccak256(raw) !== expectedHash.toLowerCase()) throw new Error();
      state.counts.succeeded += 1; return raw;
    } catch (_) { state.counts.failed += 1; fail("RUNTIME_BINDING_INVALID"); }
  }
  let runtimeCode = await code(address, expected.codeKeccak256), runtimeAddress = address;
  if (expected.implementation !== undefined) {
    const implementation = at(expected.implementation);
    if (!implementation || !scope.has(implementation)) fail("RUNTIME_BINDING_INVALID");
    state.counts.attempted += 1;
    try {
      const slot = await state.context.provider.getStorage(address, SLOT);
      if (!/^0x0{24}[0-9a-f]{40}$/i.test(slot || "") || "0x" + slot.slice(-40).toLowerCase() !== implementation) throw new Error();
      state.counts.succeeded += 1;
    } catch (_) { state.counts.failed += 1; fail("RUNTIME_BINDING_INVALID"); }
    runtimeCode = await code(implementation, expected.implementationCodeKeccak256); runtimeAddress = implementation;
  }
  return { address, runtimeAddress, runtimeCode, codeKeccak256: keccak256(runtimeCode) };
}
function sourcePolicy(descriptor, binding) {
  if (!descriptor) return null;
  try {
    if (at(descriptor.address) !== binding.address || descriptor.codeKeccak256 !== binding.codeKeccak256) fail("SOURCE_BINDING_INVALID");
    const evidence = descriptor.sourceEvidence;
    if (!evidence || evidence.schema !== "aave-v4-base-source-evidence/v1" || typeof evidence.artifactJson !== "string"
      || Buffer.byteLength(evidence.artifactJson) > 2 * 1024 * 1024 || sha256(evidence.artifactJson) !== evidence.artifactSha256) fail("SOURCE_BINDING_INVALID");
    const artifact = JSON.parse(evidence.artifactJson), source = artifact.sources?.[evidence.sourcePath]?.content;
    // Archived EACAggregatorProxy feed-0 uses this exact 0.6.6 representation.
    // Compiler acceptance does not qualify a propagated child or its freshness.
    if (Number(artifact.chainId) !== 8453 || at(artifact.address) !== binding.runtimeAddress || !["match", "exact_match"].includes(artifact.runtimeMatch)
      || artifact.runtimeBytecode?.onchainBytecode !== binding.runtimeCode || typeof source !== "string" || sha256(source) !== evidence.sourceSha256
      || (!/^0\.8\.\d+\+commit\.[0-9a-f]{8}/.test(artifact.compilation?.compilerVersion || "")
        && artifact.compilation?.compilerVersion !== "0.6.6+commit.6c089d02")
      || !Array.isArray(artifact.abi) || evidence.review?.schema !== "aave-v4-code-bound-semantic-review/v1"
      || evidence.review.sourceSha256 !== evidence.sourceSha256 || evidence.review.codeKeccak256 !== binding.codeKeccak256
      || digest(evidence.review.statement) !== descriptor.statementDigest) fail("SOURCE_BINDING_INVALID");
    const statement = evidence.review.statement;
    if (!["answer-only", "round-data", "capped-child", "reserve-price-positive-only"].includes(statement.kind)
      || (statement.kind === "reserve-price-positive-only" && binding.address !== ORACLE)) fail("SOURCE_BINDING_INVALID");
    const iface = new Interface(artifact.abi);
    const method = statement.kind === "round-data" ? "latestRoundData()"
      : statement.kind === "reserve-price-positive-only" ? "getReservePrice(uint256)" : "latestAnswer()";
    if (!iface.getFunction(method) || !source.includes(method.split("(")[0])) fail("SOURCE_BINDING_INVALID");
    if (statement.kind === "round-data" && iface.getFunction(method).outputs.map(x => x.type).join() !== "uint80,int256,uint256,uint256,uint80") fail("SOURCE_BINDING_INVALID");
    let childBindingQualified = false;
    const child = at(statement.child), pc = statement.childProof?.opcodePc;
    if (statement.kind === "capped-child" && child && count(pc)) {
      const code = Buffer.from(binding.runtimeCode.slice(2), "hex"), width = code[pc] === 0x73 ? 20 : code[pc] === 0x7f ? 32 : 0;
      let boundary = 0;
      while (boundary < pc && boundary < code.length) {
        const op = code[boundary]; boundary += op >= 0x60 && op <= 0x7f ? op - 0x5f + 1 : 1;
      }
      childBindingQualified = boundary === pc && Boolean(width)
        && code.subarray(pc + 1, pc + 1 + width).toString("hex") === "0".repeat((width - 20) * 2) + child.slice(2);
    }
    return { kind: statement.kind, child, childBindingQualified, timestampPropagation: statement.timestampPropagation,
      maxAgeSeconds: statement.maxAgeSeconds, sourceSha256: evidence.sourceSha256, codeKeccak256: binding.codeKeccak256 };
  } catch (_) { fail("SOURCE_BINDING_INVALID"); }
}
function timestampFreshness(updatedAt, pinTimestamp, maxAgeSeconds) {
  if (updatedAt <= 0n || updatedAt > BigInt(pinTimestamp)) return "FAIL";
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds <= 0) return "UNKNOWN";
  return BigInt(pinTimestamp) - updatedAt > BigInt(maxAgeSeconds) ? "FAIL" : "PASS";
}
module.exports = { HUB, SPOKE, IMPLEMENTATION, IMPL_HASH, ORACLE, ASSETS, FEEDS, ObservationError, fail, safeFailure, sha256, digest,
  count, at, samePin, publicPin, prepareTopology, openObservation, result, read, finish, startProof, frozenScope, runtimeBinding, sourcePolicy, timestampFreshness };
