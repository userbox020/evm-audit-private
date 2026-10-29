#!/usr/bin/env node
"use strict";

// Pure offline validator. The trusted manifest hashes runner/test but excludes
// this validator, avoiding self-hash recursion.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const runner = require("./run-critical-rocketpool-v14-final-withdrawal-step2");

const POLICY_VERSION = "rocketpool-step2-validator-policy/v1";
const MANIFEST_REL = "tools/critical-rocketpool-v14-final-withdrawal-step2.manifest.json";
const EXPECTED_SPEC_SHA256 = "2ac397088c50714fad48ebf908dd84cf5a1e6c787def19b77afcd95aa7070186";
const EXPECTED_MANIFEST_SHA256 = "083e54cc9f5fb3703e6ed0a9d7faee3cdcd5622bfa8cc1b4058b9f76b8cd3f68";
const EXPECTED_RUNNER_SHA256 = "79de80e192adf9a8505953890a495622068f6fcdaa11b4b15f78721b7a8c6a70";
const EXPECTED_TEST_SHA256 = "85cf1834b8615375b44cf420d9537854fcb81c3a7804f659ee28a030ea790c79";
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const read = (relative) => fs.readFileSync(path.join(runner.ROOT, relative));
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join("|") === [...keys].sort().join("|");
const address = (value) => /^0x[0-9a-f]{40}$/.test(value || "");
const hash = (value) => /^0x[0-9a-f]{64}$/.test(value || "");
const decimal = (value) => typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value);
const signed = (value) => typeof value === "string" && /^(?:0|-?[1-9][0-9]*)$/.test(value);
const runtime = (value) => exactKeys(value, ["bytes", "keccak256"]) && Number.isSafeInteger(value.bytes) && value.bytes > 0 && value.bytes <= runner.CAPS.codeBytes && hash(value.keccak256);
const state = () => ({ checks: 0 });
function check(condition, code, result) { if (!condition) throw new Error(`VALIDATION_FAILED:${code}`); result.checks++; }

function validateStaticBindings() {
  const r = state();
  check(runner.SCHEMA_VERSION === "rocketpool-v14-final-withdrawal-step2/v1", "SCHEMA", r);
  check(runner.SOURCE_ROOT === "targets/rocketpool-v1.4-fb7d9c4" && runner.SOURCE_COMMIT === "fb7d9c428dc3dddc3fbd3e634e3cb365655df89e", "SOURCE", r);
  check(runner.ROCKET_STORAGE === "0x1d8f8f00cfa6758d7be78336684788fb0ee0fa46", "ROCKET_STORAGE", r);
  check(runner.TRANSPORT_PROTOCOL === "https:", "TRANSPORT_PROTOCOL", r);
  check(runner.SOURCE_RUNTIME_ATTESTED === false && runner.SPEC_SHA256 === EXPECTED_SPEC_SHA256, "SPEC_ATTESTATION", r);
  check(runner.CONTRACT_NAMES.length === 16 && new Set(runner.CONTRACT_NAMES).size === 16, "CONTRACT_NAMES", r);
  check(Object.keys(runner.CONTRACTS).join("|") === runner.CONTRACT_NAMES.join("|"), "VERSIONS", r);
  check(Object.entries(runner.SIGNATURES).every(([name, signature]) => runner.SELECTORS[name] === runner.selector(signature)), "SELECTORS_RECOMPUTED", r);
  check(runner.canonicalJson(runner.CAPS) === runner.canonicalJson({ ethCall:68,getCode:17,chainAndHeader:3,totalLogicalCalls:88,transportBatches:6,elementsPerBatch:16,retries:0,ethCallGas:1000000,resultBytes:65536,aggregateBytes:1048576,stringBytes:128,arrayBytes:512,codeBytes:65536,inventoryCandidates:1,timeoutMs:10000 }), "CAPS", r);
  check(runner.canonicalJson(runner.PLAN) === runner.canonicalJson({ ethCall:62,getCode:17,chainAndHeader:3,totalLogicalCalls:82,transportBatches:6 }), "PLAN", r);
  check(JSON.stringify(runner.ALLOWED_METHODS) === JSON.stringify(["eth_chainId","eth_getBlockByNumber","eth_call","eth_getCode"]), "METHODS", r);
  check(runner.registryKey("rocketMegapoolDelegate") === "0x" + require("ethers").solidityPackedKeccak256(["string","string"],["contract.address","rocketMegapoolDelegate"]).slice(2), "KEY_DERIVATION", r);
  return r;
}

function validatePin(pin, r) { check(exactKeys(pin, ["number","hash","stateRoot","timestamp","terminalHeaderConsistent"]), "PIN_SCHEMA", r); check(decimal(pin.number) && hash(pin.hash) && hash(pin.stateRoot) && decimal(pin.timestamp) && pin.terminalHeaderConsistent === true, "PIN_VALUES", r); }
function validateData(raw) {
  const r = state();
  check(exactKeys(raw, ["schemaVersion","findingId","source","rocketStorage","sourceRuntimeAttested","directRuntimeMatching","effectiveMegapoolDelegateIdentityEstablished","attestationReason","captureMode","promotion","classification","killReasons","pin","registry","state","analysis","policy","rpc","safety"]), "TOP_SCHEMA", r);
  check(raw.schemaVersion === runner.SCHEMA_VERSION && raw.findingId === runner.FINDING_ID, "ID", r);
  check(exactKeys(raw.source, ["root","commit"]) && raw.source.root === runner.SOURCE_ROOT && raw.source.commit === runner.SOURCE_COMMIT, "SOURCE", r);
  check(exactKeys(raw.rocketStorage, ["address","runtime"]) && raw.rocketStorage.address === runner.ROCKET_STORAGE && runtime(raw.rocketStorage.runtime), "STORAGE", r);
  check(raw.sourceRuntimeAttested === false && raw.directRuntimeMatching === false && raw.effectiveMegapoolDelegateIdentityEstablished === false && raw.promotion === false, "FORCED_NONPROMOTION", r);
  check(raw.attestationReason === "No permitted aggregate getter establishes effective delegate identity across deployed EIP-1167 megapool proxies.", "ATTESTATION_REASON", r);
  check(raw.captureMode === "ETHEREUM_FINALIZED_NUMERIC_PIN_WITH_TERMINAL_HEADER_HASH_STATE_ROOT_TIMESTAMP_RECHECK", "CAPTURE_MODE", r); validatePin(raw.pin, r);
  check(exactKeys(raw.registry, runner.CONTRACT_NAMES), "REGISTRY_NAMES", r);
  for (const name of runner.CONTRACT_NAMES) { const x = raw.registry[name]; check(exactKeys(x, ["address","expectedVersion","observedVersion","runtime"]) && address(x.address) && x.address !== runner.ZERO && x.expectedVersion === runner.CONTRACTS[name] && x.observedVersion === runner.CONTRACTS[name] && runtime(x.runtime), `REGISTRY_${name}`, r); }
  const s = raw.state; check(exactKeys(s, ["protocolVersion","economics","exitSettings","aggregates"]), "STATE_SCHEMA", r);
  check(s.protocolVersion === "1.4", "PROTOCOL_VERSION", r);
  check(exactKeys(s.economics, ["nodeShare","voterShare","protocolDAOShare","calculateSplit","firstValidatorBond","reducedBond","baseBondArray"]), "ECONOMICS_SCHEMA", r);
  check([s.economics.nodeShare,s.economics.voterShare,s.economics.protocolDAOShare,s.economics.firstValidatorBond,s.economics.reducedBond].every(decimal) && Array.isArray(s.economics.calculateSplit) && s.economics.calculateSplit.length === 4 && s.economics.calculateSplit.every(decimal) && Array.isArray(s.economics.baseBondArray) && s.economics.baseBondArray.length <= 14 && s.economics.baseBondArray.every(decimal), "ECONOMICS_VALUES", r);
  check(exactKeys(s.exitSettings, ["notifyThresholdEpochs","lateNotifyFineWei","userDistributeDelayEpochs","userDistributeDelayWithShortfallEpochs","penaltyThreshold"]) && Object.values(s.exitSettings).every(decimal), "EXIT_SETTINGS", r);
  const a = s.aggregates; check(exactKeys(a, ["megapoolValidatorRecords","nodeCount","trustedNodeCount","depositPool","reth","network"]), "AGGREGATE_SCHEMA", r);
  check(exactKeys(a.megapoolValidatorRecords, ["value","label"]) && decimal(a.megapoolValidatorRecords.value) && a.megapoolValidatorRecords.label === "cumulative validator records; not active validator count or TVL", "VALIDATOR_COUNT_LABEL", r);
  check(decimal(a.nodeCount) && decimal(a.trustedNodeCount), "COUNTS", r);
  check(exactKeys(a.depositPool, ["balance","nodeBalance","userBalanceSigned","excessBalance","queueIndex","minipoolQueueLength","expressQueueLength","standardQueueLength"]) && Object.entries(a.depositPool).every(([key,value]) => key === "userBalanceSigned" ? signed(value) : decimal(value)), "DEPOSIT_AGGREGATES", r);
  check(exactKeys(a.reth, ["totalSupply","exchangeRate","totalCollateral","collateralRate"]) && Object.values(a.reth).every(decimal), "RETH_AGGREGATES", r);
  check(exactKeys(a.network, ["totalEthBalance","totalRethSupply"]) && Object.values(a.network).every(decimal), "NETWORK_AGGREGATES", r);
  check(exactKeys(raw.policy, ["allowedMethods","caps","plan","retries","ethCallGas","signing","transactions","logs","storageReads","traces","accounts","arbitraryBalances","multicall"]), "POLICY_SCHEMA", r);
  check(JSON.stringify(raw.policy.allowedMethods) === JSON.stringify(runner.ALLOWED_METHODS) && runner.canonicalJson(raw.policy.caps) === runner.canonicalJson(runner.CAPS) && runner.canonicalJson(raw.policy.plan) === runner.canonicalJson(runner.PLAN), "POLICY_BINDINGS", r);
  check(raw.policy.retries === 0 && raw.policy.ethCallGas === 1000000 && [raw.policy.signing,raw.policy.transactions,raw.policy.logs,raw.policy.storageReads,raw.policy.traces,raw.policy.accounts,raw.policy.arbitraryBalances,raw.policy.multicall].every((x) => x === false), "POLICY_FORBIDDEN", r);
  check(exactKeys(raw.rpc, ["totalLogicalCalls","transportBatches","aggregateResultBytes","byMethod"]), "RPC_SCHEMA", r);
  check(Number.isSafeInteger(raw.rpc.totalLogicalCalls) && raw.rpc.totalLogicalCalls <= runner.CAPS.totalLogicalCalls && raw.rpc.transportBatches <= runner.CAPS.transportBatches && raw.rpc.aggregateResultBytes <= runner.CAPS.aggregateBytes, "RPC_CAPS", r);
  check(Object.keys(raw.rpc.byMethod).every((x) => runner.ALLOWED_METHODS.includes(x)) && Object.values(raw.rpc.byMethod).reduce((x,y) => x+y, 0) === raw.rpc.totalLogicalCalls && (raw.rpc.byMethod.eth_call || 0) <= runner.CAPS.ethCall && (raw.rpc.byMethod.eth_getCode || 0) <= runner.CAPS.getCode && (raw.rpc.byMethod.eth_chainId || 0) + (raw.rpc.byMethod.eth_getBlockByNumber || 0) <= runner.CAPS.chainAndHeader, "RPC_COUNTS", r);
  check(exactKeys(raw.safety, ["inventoryMemoryOnly","endpointMaterialPersisted","rawResponsesPersisted","rawBytecodePersisted","identifiersPersisted","networkOnlyInExplicitCaptureMode"]) && raw.safety.inventoryMemoryOnly === true && raw.safety.networkOnlyInExplicitCaptureMode === true && [raw.safety.endpointMaterialPersisted,raw.safety.rawResponsesPersisted,raw.safety.rawBytecodePersisted,raw.safety.identifiersPersisted].every((x) => x === false), "SAFETY", r);
  const observed = { chainId: 1, pin: raw.pin, state: { protocolVersion:s.protocolVersion,nodeShare:BigInt(s.economics.nodeShare),voterShare:BigInt(s.economics.voterShare),pdaoShare:BigInt(s.economics.protocolDAOShare),split:s.economics.calculateSplit.map(BigInt),bondRequirement:BigInt(s.economics.firstValidatorBond),reducedBond:BigInt(s.economics.reducedBond),baseBondArray:s.economics.baseBondArray.map(BigInt),notifyThreshold:BigInt(s.exitSettings.notifyThresholdEpochs),lateNotifyFine:BigInt(s.exitSettings.lateNotifyFineWei),userDistributeDelay:BigInt(s.exitSettings.userDistributeDelayEpochs),userDistributeDelayShortfall:BigInt(s.exitSettings.userDistributeDelayWithShortfallEpochs),penaltyThreshold:BigInt(s.exitSettings.penaltyThreshold),validatorCount:BigInt(a.megapoolValidatorRecords.value),nodeCount:BigInt(a.nodeCount),memberCount:BigInt(a.trustedNodeCount) } };
  const outcome = runner.evaluateCapture(observed); check(raw.promotion === false && raw.classification === outcome.classification && JSON.stringify(raw.killReasons) === JSON.stringify(outcome.killReasons) && JSON.stringify(raw.analysis) === JSON.stringify(outcome.analysis), "OUTCOME", r);
  check(raw.killReasons.includes("EFFECTIVE_MEGAPOOL_DELEGATE_IDENTITY_UNAVAILABLE") && raw.killReasons.includes("SOURCE_RUNTIME_UNATTESTED"), "NONPROMOTION_REASONS", r);
  const leak = runner.leakScan(raw); check(leak.passed, `LEAK_${leak.findings.join("_")}`, r); return r;
}

function validateManifest(bytes = read(MANIFEST_REL)) {
  const r = state(), m = JSON.parse(bytes.toString("utf8")); check(sha256(bytes) === EXPECTED_MANIFEST_SHA256, "MANIFEST_HASH", r);
  check(exactKeys(m, ["schemaVersion","packageId","sourceRoot","sourceCommit","rocketStorage","transportProtocol","sourceRuntimeAttested","validatorPolicyVersion","specSha256","contractNames","expectedVersions","selectors","caps","plan","allowedMethods","files"]), "MANIFEST_SCHEMA", r);
  check(m.schemaVersion === "rocketpool-v14-final-withdrawal-step2-manifest/v1" && m.packageId === runner.FINDING_ID && m.validatorPolicyVersion === POLICY_VERSION, "MANIFEST_ID", r);
  check(m.sourceRoot === runner.SOURCE_ROOT && m.sourceCommit === runner.SOURCE_COMMIT && m.rocketStorage === runner.ROCKET_STORAGE && m.transportProtocol === "https:" && m.sourceRuntimeAttested === false && m.specSha256 === EXPECTED_SPEC_SHA256, "MANIFEST_SOURCE", r);
  check(JSON.stringify(m.contractNames) === JSON.stringify(runner.CONTRACT_NAMES) && runner.canonicalJson(m.expectedVersions) === runner.canonicalJson(runner.CONTRACTS) && runner.canonicalJson(m.selectors) === runner.canonicalJson(runner.SELECTORS), "MANIFEST_CONTRACTS", r);
  check(runner.canonicalJson(m.caps) === runner.canonicalJson(runner.CAPS) && runner.canonicalJson(m.plan) === runner.canonicalJson(runner.PLAN) && JSON.stringify(m.allowedMethods) === JSON.stringify(runner.ALLOWED_METHODS), "MANIFEST_POLICY", r);
  const expected = [["tools/run-critical-rocketpool-v14-final-withdrawal-step2.js",EXPECTED_RUNNER_SHA256],["tools/test-critical-rocketpool-v14-final-withdrawal-step2.js",EXPECTED_TEST_SHA256]]; check(JSON.stringify(m.files.map((x) => [x.path,x.sha256])) === JSON.stringify(expected), "MANIFEST_FILES", r); for (const [file, expectedHash] of expected) check(sha256(read(file)) === expectedHash, `FILE_HASH_${file}`, r); return r;
}
function checkOnly() { const a = validateStaticBindings(), b = validateManifest(); return { status:"PASS",mode:"offline-check-only",checks:a.checks+b.checks,specSha256:EXPECTED_SPEC_SHA256,manifestSha256:EXPECTED_MANIFEST_SHA256,sourceRoot:runner.SOURCE_ROOT,sourceCommit:runner.SOURCE_COMMIT,sourceRuntimeAttested:false,promotionPossible:false,validatorPolicyVersion:POLICY_VERSION }; }
function main(argv = process.argv.slice(2)) { if (!argv.length || (argv.length === 1 && argv[0] === "--check-only")) { process.stdout.write(`${JSON.stringify(checkOnly())}\n`); return; } if (argv.length !== 2 || argv[0] !== "--input") throw new Error("VALIDATION_FAILED:CLI_ARGUMENTS"); const input = path.resolve(argv[1]); if (input !== runner.OUTPUT) throw new Error("VALIDATION_FAILED:INPUT_PATH"); const bytes = fs.readFileSync(input), raw = JSON.parse(bytes), data = validateData(raw), a = validateStaticBindings(), b = validateManifest(); process.stdout.write(`${JSON.stringify({status:"PASS",mode:"capture-validation",checks:data.checks+a.checks+b.checks,promotion:false,captureSha256:sha256(bytes)})}\n`); }
if (require.main === module) { try { main(); } catch (error) { process.stderr.write(`${JSON.stringify({status:"FAIL",reason:String(error.message || error).replace(/[^A-Z0-9_:.-]/gi,"_").slice(0,160)})}\n`); process.exitCode = 1; } }
module.exports = { POLICY_VERSION, MANIFEST_REL, EXPECTED_SPEC_SHA256, EXPECTED_MANIFEST_SHA256, EXPECTED_RUNNER_SHA256, EXPECTED_TEST_SHA256, validateStaticBindings, validateData, validateManifest, checkOnly };
