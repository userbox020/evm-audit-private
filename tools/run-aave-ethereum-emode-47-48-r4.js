#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { Interface, keccak256 } = require("ethers");

const ROOT = path.resolve(__dirname, "..");
const SCHEMA = "aave-ethereum-emode-47-48-r4/v1";
const OUTPUT = "reports/raw/fast/aave-ethereum-emode-47-48-r4.json";
const ATTEMPT = "reports/raw/fast/aave-ethereum-emode-47-48-r4-attempt.json";
const R3 = "reports/raw/fast/aave-ethereum-emode-47-48-r3.json";
const R3_RUNNER = "tools/run-aave-ethereum-emode-47-48-r3.js";
const PREFLIGHT = "tools/lib/common-finalized-rpc-preflight.js";
const INVENTORY = "tools/preflight-all-chain-endpoints-v4.js";
const CHAOS = "targets/chaos-agents-b365c58b/";
const AAVE_AGENT = "targets/aave-risk-agents-c09d73bc/";
const HUB_ARTIFACT = `${CHAOS}out-shanghai/AgentHub.sol/AgentHub.json`;
const RANGE_ARTIFACT = `${CHAOS}out-shanghai/RangeValidationModule.sol/RangeValidationModule.json`;
const PINS = Object.freeze({
  [R3]: "8d92d8ae869e98cd3d4708826cee763dcd34760f627843209e04f4d426e9ae72",
  [R3_RUNNER]: "4a1eee450e7e2f41c873d7d36d4aef8d118f817ba459c1bf88049b80da483d29",
  [PREFLIGHT]: "febeb98a013e652afda6196f9173823b02c2e5c88ebb7a1ac6bb6bd6e5b86673",
  [INVENTORY]: "171590a0ab5bc204a9a0fa8a750ba8adbe74684bd68e756e99a7e29b29067558",
  [`${AAVE_AGENT}src/contracts/agent/AaveEModeAgent.sol`]: "b1d8dbb61bbfdc7df974fb1249a8406f30456a507afa8a9fd56359235f7c2662",
  [`${AAVE_AGENT}src/contracts/agent/BaseAaveAgent.sol`]: "6306afcd685322f5d8e640584a3a39ab278bf664e1dddc6e9e944a335527eb16",
  [`${CHAOS}src/contracts/AgentHub.sol`]: "6133046eeb0517256a1c715d0f7da87096ec00655f5bccb0d74a9d9f252675fb",
  [`${CHAOS}src/contracts/AgentConfigurator.sol`]: "a44bbcfd630aecfa81ed2dd4ee6391754f2056dc9892f674e43dbd284dc0c416",
  [`${CHAOS}src/contracts/modules/RangeValidationModule.sol`]: "0d1e547d0c77be9408be44e7fd65d0d06606004dde270545f834a33566f82314",
  [HUB_ARTIFACT]: "2404e9f79f8bdf7e16b68e584bc9be663224a5c90a36a207a31c04e2dbeaecfd",
  [RANGE_ARTIFACT]: "2746eeb9111087356ddc59d42e8a0f174cd15bc5e25aca7fde3ae601a7ed456e"
});
const A = Object.freeze({
  hub: "0x95e3015c67ef62b866cc28ca5a9ab5017a55e336",
  hubImplementation: "0x73d1bdcdb39ef06aea0371288a3ca5f1559ffcba",
  agent: "0xbe2840440d4f77cd98cec2de09913e6851907744",
  range: "0x9240a6669cc4782fc98620212862df5cb2e0df10",
  pool: "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2"
});
const PIN = Object.freeze({
  number: 25930340,
  hash: "0xc9162f3e952303571d2a55923824521f550784400c129c8d0eb1d84081f5582d",
  parentHash: "0xe7e3e316391440c48718ce473c1c2579f44280dc3a96baf80a435f65acfae799",
  stateRoot: "0xd169ca779924259cee83340062a7c01817946187f74f8152da57c11be8c7df1f",
  timestamp: "1788842699"
});
const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const BLOCK = Object.freeze({ blockHash: PIN.hash, requireCanonical: true });
// Eight qualification observations plus three terminal observations, 13 reads each.
const LIMITS = Object.freeze({ candidates: 8, calls: 144, requestMs: 10000, responseBytes: 262144, totalBytes: 4194304, wallMs: 120000, outputBytes: 131072 });
const AGENT_VIEWS = Object.freeze([
  ["agentHub", "AGENT_HUB() view returns (address)", A.hub],
  ["range", "RANGE_VALIDATION_MODULE() view returns (address)", A.range],
  ["pool", "POOL() view returns (address)", A.pool],
  ["updateType", "getUpdateType() view returns (string)", "EModeCategoryUpdate"]
].map(([key, signature, expected]) => {
  const iface = new Interface([`function ${signature}`]);
  const fn = iface.fragments[0];
  return Object.freeze({ key, iface, fn, data: iface.encodeFunctionData(fn), expected });
}));
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const stable = (value) => Array.isArray(value) ? `[${value.map(stable).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`
    : JSON.stringify(value);

const CODES = new Set(["SOURCE_PIN_MISMATCH", "BYTECODE_INVALID", "ARTIFACT_INVALID", "R3_INVALID", "R3_RANGE_CHANGED",
  "SOURCE_SEMANTICS_MISSING", "HISTORICAL_HEADER_MISMATCH", "SLOT_INVALID", "AGENT_WIRING_MISMATCH", "AGENT_WIRING_INVALID",
  "CHAIN_MISMATCH", "FINALITY_UNAVAILABLE", "HUB_IMPLEMENTATION_MISMATCH", "CODE_INVALID", "INPUT_INVALID", "NETWORK_CALL_CAP",
  "RPC_UNAVAILABLE", "HISTORICAL_CONSENSUS_UNAVAILABLE", "TERMINAL_RECHECK_FAILED", "R3_RUNTIME_MISMATCH", "OUTPUT_INVALID",
  "ATTEMPT_CONSUMED", "REQUEST_FORBIDDEN", "BYTE_CAP", "WALL_CAP", "INVOCATION_INVALID", "UNEXPECTED"]);
class R4Error extends Error { constructor(code) { super(CODES.has(code) ? code : "UNEXPECTED"); this.code = this.message; } }
const safeCode = (error) => error instanceof R4Error && CODES.has(error.code) ? error.code : "UNEXPECTED";
const fail = (code) => { throw new R4Error(code); };
const address = (value) => typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value);
const hex32 = (value) => typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value);
const quantity = (value) => `0x${value.toString(16)}`;
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join() === [...keys].sort().join();
function pinnedRead(relative, expected, root = ROOT) {
  try {
    const file = path.join(root, relative), before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > 8 * 1024 * 1024 || path.resolve(fs.realpathSync(file)) !== path.resolve(file)) fail("SOURCE_PIN_MISMATCH");
    const bytes = fs.readFileSync(file), after = fs.lstatSync(file);
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || sha256(bytes) !== expected) fail("SOURCE_PIN_MISMATCH");
    return bytes;
  } catch (error) { if (error instanceof R4Error) throw error; fail("SOURCE_PIN_MISMATCH"); }
}
function stripMetadata(bytecode) {
  if (typeof bytecode !== "string" || !/^0x(?:[0-9a-f]{2})+$/i.test(bytecode)) fail("BYTECODE_INVALID");
  const bytes = Buffer.from(bytecode.slice(2), "hex");
  if (bytes.length < 3) fail("BYTECODE_INVALID");
  const metadataLength = bytes.readUInt16BE(bytes.length - 2);
  const bodyLength = bytes.length - metadataLength - 2;
  // Only the observed Solidity 0.8.27 IPFS/solc CBOR trailer is normalized.
  const metadata = bytes.subarray(bodyLength, bytes.length - 2).toString("hex");
  if (metadataLength !== 51 || bodyLength < 1 || bytes[bodyLength - 1] !== 0xfe
    || !/^a2646970667358221220[0-9a-f]{64}64736f6c634300081b$/.test(metadata)) fail("BYTECODE_INVALID");
  return `0x${bytes.subarray(0, bodyLength).toString("hex")}`;
}
function codeIdentity(bytecode) {
  const body = stripMetadata(bytecode);
  return Object.freeze({ bytes: (bytecode.length - 2) / 2, keccak256: keccak256(bytecode), executableBytes: (body.length - 2) / 2,
    executableKeccak256: keccak256(body), metadataHex: `0x${bytecode.slice(body.length).toLowerCase()}` });
}
function loadArtifact(bytes) {
  let artifact;
  try { artifact = JSON.parse(bytes.toString("utf8")); } catch (_) { fail("ARTIFACT_INVALID"); }
  const settings = artifact?.metadata?.settings, compiler = artifact?.metadata?.compiler?.version;
  if (compiler !== "0.8.27+commit.40a35a09" || settings?.evmVersion !== "shanghai"
    || settings?.optimizer?.enabled !== true || settings?.optimizer?.runs !== 200
    || typeof artifact?.deployedBytecode?.object !== "string" || Object.keys(settings.libraries || {}).length
    || Object.keys(artifact.deployedBytecode.immutableReferences || {}).length) fail("ARTIFACT_INVALID");
  const sourceHashes = {};
  for (const [file, source] of Object.entries(artifact.metadata.sources || {})) {
    if (!/^(src|lib)\/[A-Za-z0-9_./-]+\.sol$/.test(file) || file.split("/").includes("..") || !hex32(source.keccak256)) fail("ARTIFACT_INVALID");
    const relative = `${CHAOS}${file}`, sourceBytes = fs.readFileSync(path.join(ROOT, relative));
    // Forge's retained compiler inputs use LF; preserve raw worktree hashes separately.
    if (keccak256(Buffer.from(sourceBytes.toString("utf8").replace(/\r\n/g, "\n"))) !== source.keccak256) fail("SOURCE_PIN_MISMATCH");
    sourceHashes[relative] = sha256(sourceBytes);
  }
  if (!Object.keys(sourceHashes).length) fail("ARTIFACT_INVALID");
  return Object.freeze({ compiler, evmVersion: settings.evmVersion, optimizerRuns: 200, sourceHashes,
    runtime: artifact.deployedBytecode.object, identity: codeIdentity(artifact.deployedBytecode.object) });
}
function deriveEffectiveRange(r3) {
  const views = r3?.report?.observations?.current?.views;
  if (!views) fail("R3_INVALID");
  const fields = ["EModeLTV", "EModeLiquidationThreshold", "EModeLiquidationBonus"], categories = [47, 48];
  const output = {};
  for (const field of fields) {
    const fallback = views[`range.${field}.default`];
    if (stable(fallback) !== stable(["50", "50", false, false])) fail("R3_RANGE_CHANGED");
    output[field] = {};
    for (const category of categories) {
      const market = views[`range.${field}.${category}`];
      if (stable(market) !== stable(["0", "0", false, false])) fail("R3_RANGE_CHANGED");
      output[field][category] = Object.freeze({ marketConfig: market, defaultFallback: true, effectiveConfig: fallback,
        interpretation: "inclusive absolute delta of 50 encoded parameter units; not a relative 50-bp change" });
    }
  }
  return Object.freeze(output);
}
function readAuthority(root = ROOT) {
  const contents = Object.fromEntries(Object.entries(PINS).map(([file, hash]) => [file, pinnedRead(file, hash, root)]));
  const r3 = JSON.parse(contents[R3].toString("utf8"));
  if (stable(r3.report?.pin) !== stable(PIN) || r3.report?.status !== "CORROBORATED_OBSERVATIONS"
    || r3.report.executionMode !== "production" || r3.sha256 !== sha256(stable(r3.report))) fail("R3_INVALID");
  const sources = Object.fromEntries(Object.entries(contents).filter(([file]) => file.endsWith(".sol")).map(([file, bytes]) => [file, bytes.toString("utf8")]));
  if (!sources[`${CHAOS}src/contracts/modules/RangeValidationModule.sol`].includes("if (config.maxIncrease == 0 && config.maxDecrease == 0)")
    || !sources[`${CHAOS}src/contracts/modules/RangeValidationModule.sol`].includes("uint256 maxDiff = isRelativeChange ? (maxChange * from) / BPS_MAX : maxChange;")
    || !sources[`${CHAOS}src/contracts/AgentHub.sol`].includes("block.timestamp - lastInjectedUpdate.timestamp < basicConfig.minimumDelay")
    || !sources[`${AAVE_AGENT}src/contracts/agent/AaveEModeAgent.sol`].includes("RANGE_VALIDATION_MODULE.validate(AGENT_HUB, agentId, update.market, input)")) fail("SOURCE_SEMANTICS_MISSING");
  return Object.freeze({ r3, effectiveRange: deriveEffectiveRange(r3), hubBuild: loadArtifact(contents[HUB_ARTIFACT]), rangeBuild: loadArtifact(contents[RANGE_ARTIFACT]) });
}
function exactHeader(raw, pf) {
  const header = pf.normalizeHeader(raw);
  if (!header || stable(header) !== stable(PIN)) fail("HISTORICAL_HEADER_MISMATCH");
  return header;
}
function decodeSlot(raw) {
  if (typeof raw !== "string" || !/^0x0{24}[0-9a-f]{40}$/i.test(raw)) fail("SLOT_INVALID");
  const value = `0x${raw.slice(-40).toLowerCase()}`;
  if (!address(value)) fail("SLOT_INVALID");
  return value;
}
function decodeAgentView(view, raw) {
  try {
    const result = view.iface.decodeFunctionResult(view.fn, raw);
    if (view.iface.encodeFunctionResult(view.fn, result).toLowerCase() !== raw.toLowerCase()) fail("AGENT_WIRING_INVALID");
    const decoded = result[0];
    const value = typeof decoded === "string" && address(decoded) ? decoded.toLowerCase() : decoded;
    if (value !== view.expected) fail("AGENT_WIRING_MISMATCH");
    return value;
  } catch (error) { if (error instanceof R4Error) throw error; fail("AGENT_WIRING_INVALID"); }
}
async function observe(handle, call, pf) {
  if (await call(handle, "eth_chainId", [], 3500) !== "0x1") fail("CHAIN_MISMATCH");
  const finalized = pf.normalizeHeader(await call(handle, "eth_getBlockByNumber", ["finalized", false], 6000));
  if (!finalized || finalized.number < PIN.number || (finalized.number === PIN.number && stable(finalized) !== stable(PIN))) fail("FINALITY_UNAVAILABLE");
  exactHeader(await call(handle, "eth_getBlockByNumber", [quantity(PIN.number), false], 6000), pf);
  const implementation = decodeSlot(await call(handle, "eth_getStorageAt", [A.hub, IMPLEMENTATION_SLOT, BLOCK], 8000));
  if (implementation !== A.hubImplementation) fail("HUB_IMPLEMENTATION_MISMATCH");
  const code = {};
  for (const [key, target] of Object.entries({ hub: A.hub, hubImplementation: implementation, agent: A.agent, range: A.range })) {
    const raw = await call(handle, "eth_getCode", [target, BLOCK], 8000);
    if (raw === "0x" || typeof raw !== "string" || raw.length > 131074) fail("CODE_INVALID");
    code[key] = codeIdentity(raw.toLowerCase());
  }
  const agentWiring = {};
  for (const view of AGENT_VIEWS) agentWiring[view.key] = decodeAgentView(view, await call(handle, "eth_call", [{ to: A.agent, data: view.data }, BLOCK], 8000));
  exactHeader(await call(handle, "eth_getBlockByNumber", [quantity(PIN.number), false], 6000), pf);
  return Object.freeze({ implementation, code, agentWiring });
}
async function collect({ candidates, rawCall, authority, pf, now = Date.now }) {
  if (!Array.isArray(candidates) || candidates.length < 2 || candidates.length > LIMITS.candidates || typeof rawCall !== "function"
    || candidates.some((candidate) => !candidate || !pf.reviewedOperatorFamily(candidate.operatorFamily))
    || new Set(candidates.map((candidate) => candidate.handle)).size !== candidates.length) fail("INPUT_INVALID");
  let calls = 0;
  const call = async (handle, method, params, timeout) => {
    allowRequest(method, params);
    if (calls >= LIMITS.calls) fail("NETWORK_CALL_CAP");
    calls += 1;
    return rawCall(handle, method, params, timeout);
  };
  const groups = new Map(), failures = {};
  for (const candidate of candidates.slice(0, LIMITS.candidates)) {
    try {
      const observation = await observe(candidate.handle, call, pf), key = stable(observation);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ candidate, observation });
      if (new Set(groups.get(key).map((row) => row.candidate.operatorFamily)).size === 3) break;
    } catch (error) {
      const code = safeCode(error);
      if (["BYTE_CAP", "WALL_CAP", "NETWORK_CALL_CAP", "REQUEST_FORBIDDEN"].includes(code)) throw error;
      failures[code] = (failures[code] || 0) + 1;
    }
  }
  const winning = [...groups.values()].filter((group) => new Set(group.map((row) => row.candidate.operatorFamily)).size >= 2)
    .sort((a, b) => b.length - a.length)[0];
  if (!winning) fail("HISTORICAL_CONSENSUS_UNAVAILABLE");
  const selected = [], families = new Set();
  for (const row of winning) {
    if (families.has(row.candidate.operatorFamily)) continue;
    families.add(row.candidate.operatorFamily); selected.push(row);
    if (selected.length === 3) break;
  }
  for (const row of selected) if (stable(await observe(row.candidate.handle, call, pf)) !== stable(row.observation)) fail("TERMINAL_RECHECK_FAILED");
  const observation = selected[0].observation, hubBuild = authority.hubBuild.identity, rangeBuild = authority.rangeBuild.identity;
  const sourceBindings = Object.freeze({
    hubExecutableMatch: observation.code.hubImplementation.executableKeccak256 === hubBuild.executableKeccak256
      && observation.code.hubImplementation.executableBytes === hubBuild.executableBytes,
    rangeExecutableMatch: observation.code.range.executableKeccak256 === rangeBuild.executableKeccak256
      && observation.code.range.executableBytes === rangeBuild.executableBytes,
    hubExactMetadataMatch: observation.code.hubImplementation.keccak256 === hubBuild.keccak256,
    rangeExactMetadataMatch: observation.code.range.keccak256 === rangeBuild.keccak256,
    agentExecutableMatch: false
  });
  const r3Code = authority.r3.report.observations.current.code;
  if (observation.code.hub.keccak256 !== r3Code.hub.keccak256 || observation.code.agent.keccak256 !== r3Code.agent.keccak256
    || observation.code.range.keccak256 !== r3Code.range.keccak256) fail("R3_RUNTIME_MISMATCH");
  return Object.freeze({ schema: SCHEMA, status: "CORROBORATED_HISTORICAL_OBSERVATIONS", code: "NONE", generatedAt: new Date(now()).toISOString(), pin: PIN,
    selectedFamilyCount: selected.length, callsUsed: calls, failures, addresses: A, implementationSlot: IMPLEMENTATION_SLOT,
    observation, builds: { hub: hubBuild, range: rangeBuild },
    buildSettings: { compiler: "0.8.27+commit.40a35a09", evmVersion: "shanghai", optimizerRuns: 200, sourceNormalization: "CRLF_TO_LF" },
    sourceBindings, effectiveRange: authority.effectiveRange,
    gates: { hubRuntimeBound: sourceBindings.hubExecutableMatch, rangeRuntimeBound: sourceBindings.rangeExecutableMatch,
      agentRuntimeBound: false, rangeModuleSemanticsSupported: sourceBindings.rangeExecutableMatch, effectiveRangeSemanticsBound: false,
      completeAuthorityVerification: false, completeRuntimeBinding: false,
      routePositive: "unknown", executableNow: "unknown", signedActionJustified: false, fork: false },
    limitations: ["Historical evidence only; no present-state freshness claim.", "AaveEModeAgent source revision is pinned and wiring is runtime-checked, but its executable build is not yet bound.",
      "Runtime-bound flags cover normalized implementation code only, not full proxy or dependency authority.",
      "Exact metadata-byte equality is reported separately from executable-byte equality.",
      "Classified provider families corroborate observations; backend independence and state-root proofs are not established.",
      "No oracle semantics, positions, stress model, transaction, signing, broadcast or state mutation."] });
}
function validateReport(report, authority = readAuthority()) {
  if (!report || report.schema !== SCHEMA || !["INCOMPLETE", "CORROBORATED_HISTORICAL_OBSERVATIONS"].includes(report.status)
    || !Number.isFinite(Date.parse(report.generatedAt)) || stable(report.pin) !== stable(PIN)
    || !Number.isSafeInteger(report.callsUsed) || report.callsUsed < 0 || report.callsUsed > LIMITS.calls) fail("OUTPUT_INVALID");
  if (report.status === "CORROBORATED_HISTORICAL_OBSERVATIONS") {
    try {
      if (report.code !== "NONE" || !Number.isInteger(report.selectedFamilyCount) || report.selectedFamilyCount < 2 || report.selectedFamilyCount > 3
        || report.callsUsed < report.selectedFamilyCount * 26 || stable(report.addresses) !== stable(A) || report.implementationSlot !== IMPLEMENTATION_SLOT
        || !exactKeys(report.observation, ["implementation", "code", "agentWiring"]) || report.observation.implementation !== A.hubImplementation
        || !exactKeys(report.observation.code, ["hub", "hubImplementation", "agent", "range"])
        || stable(report.observation.agentWiring) !== stable(Object.fromEntries(AGENT_VIEWS.map((view) => [view.key, view.expected])))
        || stable(report.builds) !== stable({ hub: authority.hubBuild.identity, range: authority.rangeBuild.identity })
        || stable(report.effectiveRange) !== stable(authority.effectiveRange)
        || stable(report.buildSettings) !== stable({ compiler: "0.8.27+commit.40a35a09", evmVersion: "shanghai", optimizerRuns: 200, sourceNormalization: "CRLF_TO_LF" })) fail("OUTPUT_INVALID");
      for (const [key, identity] of Object.entries(report.observation.code)) {
        if (!exactKeys(identity, ["bytes", "keccak256", "executableBytes", "executableKeccak256", "metadataHex"])
          || !Number.isSafeInteger(identity.bytes) || identity.bytes > 65536 || identity.bytes < 54
          || identity.executableBytes !== identity.bytes - 53 || !hex32(identity.keccak256) || !hex32(identity.executableKeccak256)
          || !/^0xa2646970667358221220[0-9a-f]{64}64736f6c634300081b0033$/.test(identity.metadataHex)) fail("OUTPUT_INVALID");
        if (key !== "hubImplementation") {
          const prior = authority.r3.report.observations.current.code[key];
          if (identity.bytes !== prior.bytes || identity.keccak256 !== prior.keccak256) fail("OUTPUT_INVALID");
        }
      }
      const bindings = { agentExecutableMatch: false };
      for (const [key, observedKey] of [["hub", "hubImplementation"], ["range", "range"]]) {
        const observed = report.observation.code[observedKey], build = authority[`${key}Build`];
        bindings[`${key}ExecutableMatch`] = observed.executableBytes === build.identity.executableBytes && observed.executableKeccak256 === build.identity.executableKeccak256;
        bindings[`${key}ExactMetadataMatch`] = observed.keccak256 === build.identity.keccak256;
        if (bindings[`${key}ExecutableMatch`] && stable(observed) !== stable(codeIdentity(`${stripMetadata(build.runtime)}${observed.metadataHex.slice(2)}`))) fail("OUTPUT_INVALID");
      }
      if (stable(report.sourceBindings) !== stable(bindings) || stable(report.gates) !== stable({ hubRuntimeBound: bindings.hubExecutableMatch,
        rangeRuntimeBound: bindings.rangeExecutableMatch, agentRuntimeBound: false, rangeModuleSemanticsSupported: bindings.rangeExecutableMatch,
        effectiveRangeSemanticsBound: false, completeAuthorityVerification: false, completeRuntimeBinding: false,
        routePositive: "unknown", executableNow: "unknown", signedActionJustified: false, fork: false })) fail("OUTPUT_INVALID");
      if (Object.entries(report.failures).some(([code, count]) => !CODES.has(code) || !Number.isSafeInteger(count) || count < 1 || count > LIMITS.candidates)) fail("OUTPUT_INVALID");
    } catch (_) { fail("OUTPUT_INVALID"); }
  } else if (!CODES.has(report.code) || report.observation !== null || report.selectedFamilyCount !== 0
    || stable(report.gates) !== stable({ completeRuntimeBinding: false, completeAuthorityVerification: false, effectiveRangeSemanticsBound: false,
      routePositive: "unknown", executableNow: "unknown", signedActionJustified: false, fork: false })) fail("OUTPUT_INVALID");
  if (Object.hasOwn(report, "executionMode")) {
    if (!["production", "injected"].includes(report.executionMode) || report.transportRequestAttempts !== report.callsUsed
      || !Number.isInteger(report.inventoryReadAttempts) || report.inventoryReadAttempts < 0 || report.inventoryReadAttempts > 1
      || !Number.isInteger(report.inventoryReads) || report.inventoryReads < 0 || report.inventoryReads > report.inventoryReadAttempts
      || (report.executionMode === "injected" && (report.inventoryReadAttempts !== 0 || report.responseBytes !== null))
      || (report.executionMode === "production" && (!Number.isSafeInteger(report.responseBytes) || report.responseBytes < 0
        || (report.status !== "INCOMPLETE" && (report.inventoryReads !== 1 || report.inventoryReadAttempts !== 1))))) fail("OUTPUT_INVALID");
  }
  const serialized = stable(report);
  if (Buffer.byteLength(serialized) > LIMITS.outputBytes || /https?:\/\/|authorization|bearer\s|api[_-]?key/i.test(serialized)) fail("OUTPUT_INVALID");
  return true;
}
function writeExclusive(file, value) {
  let fd;
  try {
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    if (bytes.length > LIMITS.outputBytes) fail("OUTPUT_INVALID");
    fd = fs.openSync(file, "wx", 0o600); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    if (!fs.readFileSync(file).equals(bytes)) fail("OUTPUT_INVALID");
  } catch (error) { if (error instanceof R4Error) throw error; if (error?.code === "EEXIST") fail("ATTEMPT_CONSUMED"); fail("OUTPUT_INVALID"); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function allowRequest(method, params) {
  const codeTargets = new Set([A.hub, A.hubImplementation, A.agent, A.range]);
  let ok = Array.isArray(params);
  if (method === "eth_chainId") ok = ok && params.length === 0;
  else if (method === "eth_getBlockByNumber") ok = ok && params.length === 2 && params[1] === false && ["finalized", quantity(PIN.number)].includes(params[0]);
  else if (method === "eth_getStorageAt") ok = ok && stable(params) === stable([A.hub, IMPLEMENTATION_SLOT, BLOCK]);
  else if (method === "eth_getCode") ok = ok && params.length === 2 && codeTargets.has(params[0]) && stable(params[1]) === stable(BLOCK);
  else if (method === "eth_call") ok = ok && params.length === 2 && exactKeys(params[0], ["to", "data"]) && params[0].to === A.agent
    && AGENT_VIEWS.some((view) => view.data === params[0].data) && stable(params[1]) === stable(BLOCK);
  else ok = false;
  if (!ok) fail("REQUEST_FORBIDDEN");
}
function createTransport(candidates, options = {}) {
  const request = options.request || https.request, monotonic = options.monotonic || (() => performance.now());
  const deadline = monotonic() + LIMITS.wallMs, handles = new Set(candidates.map((candidate) => candidate.handle));
  let calls = 0, totalBytes = 0, fatal = null;
  return Object.freeze({
    get stats() { return { calls, responseBytes: totalBytes }; },
    async call(handle, method, params, timeout = LIMITS.requestMs) {
      allowRequest(method, params);
      if (fatal) fail(fatal);
      if (!handles.has(handle)) fail("REQUEST_FORBIDDEN");
      if (calls >= LIMITS.calls) fail("NETWORK_CALL_CAP");
      if (monotonic() >= deadline) fail("WALL_CAP");
      const url = handle.url;
      if (!(url instanceof URL) || url.protocol !== "https:" || url.username || url.password || url.hash) fail("REQUEST_FORBIDDEN");
      const id = ++calls, body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      return new Promise((resolve, reject) => {
        let req, done = false, size = 0; const chunks = [];
        const finish = (error, value) => {
          if (done) return;
          done = true; clearTimeout(timer);
          if (error && ["BYTE_CAP", "WALL_CAP"].includes(safeCode(error))) fatal = safeCode(error);
          try { req?.destroy(); } catch (_) {}
          chunks.length = 0;
          error ? reject(error) : resolve(value);
        };
        const timer = setTimeout(() => finish(new R4Error(monotonic() >= deadline ? "WALL_CAP" : "RPC_UNAVAILABLE")), Math.max(1, Math.min(timeout, LIMITS.requestMs, deadline - monotonic())));
        try {
          req = request({ protocol: "https:", hostname: url.hostname, port: url.port || 443, path: `${url.pathname}${url.search}`, method: "POST", agent: false,
            rejectUnauthorized: true, headers: { ...(handle.headers || {}), ...(handle.origin ? { origin: handle.origin } : {}), "content-type": "application/json",
              accept: "application/json", "accept-encoding": "identity", "content-length": body.length } }, (res) => {
            res.on("data", (chunk) => {
              if (done) return;
              size += chunk.length; totalBytes += chunk.length;
              if (monotonic() >= deadline) finish(new R4Error("WALL_CAP"));
              else if (size > LIMITS.responseBytes || totalBytes > LIMITS.totalBytes) finish(new R4Error("BYTE_CAP"));
              else chunks.push(Buffer.from(chunk));
            });
            res.on("end", () => { if (done) return; try {
              if (monotonic() >= deadline) fail("WALL_CAP");
              const raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              if (res.statusCode !== 200 || !exactKeys(raw, ["jsonrpc", "id", "result"]) || raw.jsonrpc !== "2.0" || raw.id !== id) fail("RPC_UNAVAILABLE");
              finish(null, raw.result);
            } catch (error) { finish(error instanceof R4Error ? error : new R4Error("RPC_UNAVAILABLE")); } });
            res.on("error", () => finish(new R4Error("RPC_UNAVAILABLE")));
            res.on("aborted", () => finish(new R4Error("RPC_UNAVAILABLE")));
          });
          req.on("error", () => finish(new R4Error("RPC_UNAVAILABLE"))); req.end(body);
        } catch (_) { finish(new R4Error("RPC_UNAVAILABLE")); }
      });
    }
  });
}
async function runOnce(options = {}) {
  const injected = Object.keys(options).length > 0;
  if (injected && (typeof options.rawCall !== "function" || !Array.isArray(options.candidates) || typeof options.root !== "string"
    || path.resolve(options.root) === ROOT || path.resolve(fs.realpathSync(options.root)) === ROOT)) fail("INPUT_INVALID");
  if (!injected && require.main !== module) fail("INVOCATION_INVALID");
  const root = injected ? path.resolve(options.root) : ROOT, actualAuthority = readAuthority(), authority = injected && options.authority || actualAuthority;
  const runner = "tools/run-aave-ethereum-emode-47-48-r4.js", test = "tools/test-run-aave-ethereum-emode-47-48-r4.js";
  const sourceHashes = { ...PINS, ...actualAuthority.hubBuild.sourceHashes, ...actualAuthority.rangeBuild.sourceHashes,
    [runner]: sha256(fs.readFileSync(__filename)), [test]: sha256(fs.readFileSync(path.join(ROOT, test))) };
  const inventory = require("./preflight-all-chain-endpoints-v4.js");
  try { inventory.safeParent(root, OUTPUT, { create: false }); } catch (_) { fail("OUTPUT_INVALID"); }
  const output = path.join(root, OUTPUT), attempt = path.join(root, ATTEMPT);
  if (fs.existsSync(output) || fs.existsSync(attempt)) fail("ATTEMPT_CONSUMED");
  const now = options.now || Date.now, executionMode = injected ? "injected" : "production";
  writeExclusive(attempt, { schema: `${SCHEMA}/attempt`, executionMode, startedAt: new Date(now()).toISOString(), allowedRuns: 1, retries: 0, sourceHashes });
  let report, transport, inventoryReads = 0, inventoryReadAttempts = 0, calls = 0;
  try {
    let candidates;
    if (injected) candidates = options.candidates;
    else {
      const r3Runner = require("./run-aave-ethereum-emode-47-48-r3.js");
      inventoryReadAttempts += 1;
      const source = inventory.readSource("rpc_endpoints.txt", { root });
      inventoryReads += 1;
      candidates = r3Runner.selectCandidates(inventory.parsePrimaryRpcGrammar(source.text).records);
      transport = createTransport(candidates);
    }
    const pf = require("./lib/common-finalized-rpc-preflight.js");
    const rawCall = options.rawCall || transport.call.bind(transport);
    report = await collect({ candidates, rawCall: (...args) => { calls += 1; return rawCall(...args); }, authority, pf, now });
  } catch (error) {
    report = { schema: SCHEMA, status: "INCOMPLETE", code: safeCode(error), generatedAt: new Date(now()).toISOString(), pin: PIN,
      selectedFamilyCount: 0, callsUsed: injected ? calls : transport?.stats.calls || 0, observation: null,
      gates: { completeRuntimeBinding: false, completeAuthorityVerification: false, effectiveRangeSemanticsBound: false,
        routePositive: "unknown", executableNow: "unknown", signedActionJustified: false, fork: false } };
  }
  report = { ...report, executionMode, inventoryReadAttempts, inventoryReads, transportRequestAttempts: injected ? calls : transport?.stats.calls || 0,
    responseBytes: injected ? null : transport?.stats.responseBytes || 0, sourceHashes };
  for (const [file, hash] of Object.entries(sourceHashes)) pinnedRead(file, hash);
  validateReport(report, authority);
  const envelope = { sha256: sha256(stable(report)), report };
  writeExclusive(output, envelope);
  return envelope;
}
async function main(argv = process.argv.slice(2)) {
  try {
    if (argv.length !== 1 || !["--check", "--run-once"].includes(argv[0]) || process.execArgv.length
      || ["NODE_OPTIONS", "NODE_DEBUG", "NODE_DEBUG_NATIVE", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_USE_ENV_PROXY", "SSLKEYLOGFILE"].some((name) => process.env[name])) fail("INVOCATION_INVALID");
    if (argv[0] === "--check") { const authority = readAuthority(); process.stdout.write(`${JSON.stringify({ status: "OFFLINE_INPUT_CHECK_PASS", sourcePins: Object.keys(PINS).length, effectiveFields: Object.keys(authority.effectiveRange).length, network: false })}\n`); return; }
    const envelope = await runOnce(); process.stdout.write(`${JSON.stringify({ status: envelope.report.status, code: envelope.report.code, callsUsed: envelope.report.callsUsed, output: OUTPUT, sha256: envelope.sha256 })}\n`);
    if (envelope.report.status === "INCOMPLETE") process.exitCode = 2;
  } catch (error) { process.stdout.write(`${JSON.stringify({ status: "REFUSED_OR_FAILED", code: safeCode(error) })}\n`); process.exitCode = 2; }
}
if (require.main === module) main();
module.exports = { ROOT, SCHEMA, OUTPUT, ATTEMPT, PINS, A, PIN, BLOCK, IMPLEMENTATION_SLOT, LIMITS, AGENT_VIEWS, R4Error,
  sha256, stable, safeCode, stripMetadata, codeIdentity, loadArtifact, deriveEffectiveRange, readAuthority, decodeSlot, decodeAgentView,
  observe, collect, validateReport, allowRequest, createTransport, writeExclusive, runOnce };
