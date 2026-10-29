#!/usr/bin/env node
"use strict";

// Check-only validator. It never writes files, reads endpoint inventories, or
// performs network activity. Its trusted manifest does not hash this validator,
// avoiding self-hash recursion; it binds a fixed validator policy version.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const runner = require("./run-critical-kelp-rseth-stale-rate-deployment-step2");

const POLICY_VERSION = "kelp-step2-validator-policy/v2";
const MANIFEST_REL = "tools/critical-kelp-rseth-stale-rate-deployment-step2.manifest.json";
const EXPECTED_SPEC_SHA256 = "3083d9561d102dfae6e957229572d7a8c6323594a162c23b624de96db84d57c9";
const EXPECTED_MANIFEST_SHA256 = "bc27970025db94ec492dc6f74645a037a23aaa226a571b6dc32e73e5679ba9d5";
const EXPECTED = Object.freeze({
  schemaVersion: "kelp-rseth-stale-rate-deployment-step2/v2",
  sourceCommit: "3dded885f6f797f5959aff449c3a30c5cbb6ce23",
  addresses: Object.freeze({
    pool: "0x291088312150482826b3a37d5a69a4c54daa9118",
    wrapper: "0xedfa23602d0ec14714057867a78d01e94176bea0",
    receiver: "0x7781ae9b47fecaceaecc4fca8d0b6187e3ef9ba7",
    canonical: "0x1bc71130a0e39942a7658878169764bbd8a45993",
    proxyAdmin: "0xdf3f5926fd14ed048b04941189da54bdedd478d0",
    provider: "0x0788906b19ba8f8d0e8a7015f0714df3179d9ab6",
    lrtOracle: "0x349a73444b1a310bae67ef67973022020d70020d",
  }),
  route: Object.freeze({ receiverExpectedSourceChainId: 101, providerExpectedDestinationChainId: 184 }),
  caps: Object.freeze({ aggregateTransientBytes: 786432, baseCalls: 48, callsPerBatch: 12, codeBytes: 65536, ethereumCalls: 24, getterBytes: 128, maxCandidateInputWei: "10000000000000000000", minimumValueDeltaWei: "1000000000000000", minimumValueMarginBps: 10, qualificationCalls: 12, requestBytes: 32768, responseBytesPerBatch: 131072, routeGetterBytes: 2112, routeReceiverEntries: 32, snapshotSkewSeconds: 1800, staleThresholdSeconds: 86400, timeoutMs: 10000, totalCalls: 72 }),
  plan: Object.freeze({ baseCallsIncludingQualificationAndTerminal: 44, ethereumCallsIncludingQualificationAndTerminal: 14, totalCallsWithMaximumQualification: 68 }),
  methods: Object.freeze(["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_getStorageAt", "eth_call"]),
});

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const state = () => ({ checks: 0 });
function check(condition, code, result) { if (!condition) throw new Error(`VALIDATION_FAILED:${code}`); result.checks++; }
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join("|") === [...keys].sort().join("|");
const address = (value) => /^0x[0-9a-f]{40}$/.test(value || "");
const hash = (value) => /^0x[0-9a-f]{64}$/.test(value || "");
const decimal = (value) => typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value);
const runtime = (value) => exactKeys(value, ["bytes", "keccak256"]) && Number.isSafeInteger(value.bytes) && value.bytes > 0 && value.bytes <= EXPECTED.caps.codeBytes && hash(value.keccak256);
const read = (relative) => fs.readFileSync(path.join(runner.ROOT, relative));

function validateStaticBindings() {
  const result = state();
  check(runner.SCHEMA_VERSION === EXPECTED.schemaVersion, "SCHEMA_BINDING", result);
  check(runner.SOURCE_COMMIT === EXPECTED.sourceCommit && runner.SOURCE_RUNTIME_ATTESTED === false, "SOURCE_BINDING", result);
  check(runner.SPEC_SHA256 === EXPECTED_SPEC_SHA256, "SPEC_HASH_BINDING", result);
  check(runner.canonicalJson(runner.CAPS) === runner.canonicalJson(EXPECTED.caps), "CAP_BINDING", result);
  check(runner.canonicalJson(runner.PLAN) === runner.canonicalJson(EXPECTED.plan), "PLAN_BINDING", result);
  check(runner.canonicalJson(runner.ROUTE) === runner.canonicalJson(EXPECTED.route), "ROUTE_BINDING", result);
  check(JSON.stringify(runner.ALLOWED_METHODS) === JSON.stringify(EXPECTED.methods), "METHOD_BINDING", result);
  check(runner.ADDRESSES.base.pool === EXPECTED.addresses.pool && runner.ADDRESSES.base.wrapper === EXPECTED.addresses.wrapper && runner.ADDRESSES.base.receiver === EXPECTED.addresses.receiver && runner.ADDRESSES.base.canonical === EXPECTED.addresses.canonical && runner.ADDRESSES.base.proxyAdmin === EXPECTED.addresses.proxyAdmin, "BASE_ADDRESS_BINDING", result);
  check(runner.ADDRESSES.ethereum.provider === EXPECTED.addresses.provider && runner.ADDRESSES.ethereum.lrtOracle === EXPECTED.addresses.lrtOracle, "ETHEREUM_ADDRESS_BINDING", result);
  check(runner.SLOTS.implementation === "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" && runner.SLOTS.admin === "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103" && runner.SLOTS.beacon === "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50", "EIP1967_SLOT_BINDING", result);
  check(runner.SELECTORS.pool.wrsETH === "e129200f" && runner.SELECTORS.pool.getRate === "679aefce" && runner.SELECTORS.wrapper.hasRole === "91d14854" && runner.SELECTORS.receiver.layerZeroEndpoint === "07968db1" && runner.SELECTORS.provider.getLatestRate === "e1e7ff77" && runner.SELECTORS.provider.getRateReceivers === "b02d0322" && runner.SELECTORS.provider.layerZeroEndpoint === "07968db1" && runner.SELECTORS.lrtOracle.rsETHPrice === "b4b46434", "SELECTOR_BINDING", result);
  return result;
}

function validateProxy(value, result, label) {
  check(exactKeys(value, ["kind", "implementation", "beacon", "admin", "implementationRuntime", "beaconRuntime"]), `${label}_PROXY_SCHEMA`, result);
  check(["EIP1967_IMPLEMENTATION", "EIP1967_BEACON"].includes(value.kind) && address(value.admin) && address(value.implementation) && runtime(value.implementationRuntime), `${label}_PROXY_VALUES`, result);
  if (value.kind === "EIP1967_IMPLEMENTATION") check(value.beacon === null && value.beaconRuntime === null, `${label}_IMPLEMENTATION_SHAPE`, result);
  else check(address(value.beacon) && runtime(value.beaconRuntime), `${label}_BEACON_SHAPE`, result);
}

function validatePin(pin, result, label) {
  check(exactKeys(pin, ["number", "hash", "timestamp", "terminalHeaderConsistent"]), `${label}_PIN_SCHEMA`, result);
  check(decimal(pin.number) && hash(pin.hash) && decimal(pin.timestamp) && typeof pin.terminalHeaderConsistent === "boolean", `${label}_PIN_VALUES`, result);
}

function validateData(raw) {
  const result = state();
  check(exactKeys(raw, ["schemaVersion", "findingId", "sourceCommit", "sourceRuntimeAttested", "specSha256", "captureMode", "classification", "promotion", "killReasons", "chains", "analysis", "policy", "rpc", "safety"]), "TOP_LEVEL_SCHEMA", result);
  check(raw.schemaVersion === EXPECTED.schemaVersion && raw.findingId === runner.FINDING_ID, "SCHEMA_AND_ID", result);
  check(raw.sourceCommit === EXPECTED.sourceCommit && raw.sourceRuntimeAttested === false && raw.specSha256 === EXPECTED_SPEC_SHA256, "SOURCE_AND_SPEC_HASH", result);
  check(raw.captureMode === "READ_ONLY_LATEST_THEN_NUMBER_PINNED_WITH_TERMINAL_HEADER_CONSISTENCY" && raw.promotion === false && raw.killReasons.includes("SOURCE_RUNTIME_UNATTESTED"), "FORCED_NONPROMOTION", result);
  check(exactKeys(raw.chains, ["base", "ethereum"]), "CHAIN_SCHEMA", result);
  const b = raw.chains.base, e = raw.chains.ethereum;
  check(exactKeys(b, ["chainId", "pin", "contracts", "state"]) && b.chainId === 8453, "BASE_SCHEMA_CHAIN", result);
  check(exactKeys(e, ["chainId", "pin", "contracts", "state"]) && e.chainId === 1, "ETHEREUM_SCHEMA_CHAIN", result);
  validatePin(b.pin, result, "BASE"); validatePin(e.pin, result, "ETHEREUM");
  check(exactKeys(b.contracts, ["pool", "wrapper", "receiver", "canonical", "documentedProxyAdmin", "configuredLayerZeroEndpoint"]), "BASE_CONTRACT_SCHEMA", result);
  for (const [label, expectedAddress] of [["pool", EXPECTED.addresses.pool], ["wrapper", EXPECTED.addresses.wrapper], ["receiver", EXPECTED.addresses.receiver], ["canonical", EXPECTED.addresses.canonical]]) {
    const row = b.contracts[label], keys = ["pool", "wrapper"].includes(label) ? ["address", "runtime", "proxy"] : ["address", "runtime"];
    check(exactKeys(row, keys) && row.address === expectedAddress && runtime(row.runtime), `BASE_${label.toUpperCase()}_CONTRACT`, result);
  }
  check(exactKeys(b.contracts.documentedProxyAdmin, ["address", "runtime"]) && b.contracts.documentedProxyAdmin.address === EXPECTED.addresses.proxyAdmin && runtime(b.contracts.documentedProxyAdmin.runtime), "PROXY_ADMIN_CONTRACT", result);
  check(exactKeys(b.contracts.configuredLayerZeroEndpoint, ["address", "runtime"]) && address(b.contracts.configuredLayerZeroEndpoint.address) && runtime(b.contracts.configuredLayerZeroEndpoint.runtime), "BASE_ENDPOINT_CONTRACT", result);
  validateProxy(b.contracts.pool.proxy, result, "POOL"); validateProxy(b.contracts.wrapper.proxy, result, "WRAPPER");
  check(exactKeys(e.contracts, ["provider", "lrtOracle", "configuredEndpoint"]), "ETHEREUM_CONTRACT_SCHEMA", result);
  check(exactKeys(e.contracts.provider, ["address", "runtime"]) && e.contracts.provider.address === EXPECTED.addresses.provider && runtime(e.contracts.provider.runtime), "PROVIDER_CONTRACT", result);
  check(exactKeys(e.contracts.lrtOracle, ["address", "runtime"]) && e.contracts.lrtOracle.address === EXPECTED.addresses.lrtOracle && runtime(e.contracts.lrtOracle.runtime), "LRT_ORACLE_CONTRACT", result);
  check(exactKeys(e.contracts.configuredEndpoint, ["address", "runtime"]) && address(e.contracts.configuredEndpoint.address) && runtime(e.contracts.configuredEndpoint.runtime), "ETHEREUM_ENDPOINT_CONTRACT", result);

  check(exactKeys(b.state, ["pool", "wrapper", "canonical", "receiver"]), "BASE_STATE_SCHEMA", result);
  check(exactKeys(b.state.pool, ["wrsETH", "rsETHOracle", "paused", "feeBps", "dailyMintLimit", "dailyMintAmount", "lastMintDay", "startTimestamp", "currentDay", "remainingDailyMintLimit", "rate"]), "POOL_STATE_SCHEMA", result);
  check(exactKeys(b.state.wrapper, ["minterRole", "poolHasMinterRole", "canonicalAllowed", "maxCanonicalDeposit", "totalSupply"]), "WRAPPER_STATE_SCHEMA", result);
  check(exactKeys(b.state.canonical, ["decimals", "wrapperReserve"]), "CANONICAL_STATE_SCHEMA", result);
  check(exactKeys(b.state.receiver, ["rate", "lastUpdated", "srcChainId", "rateProvider", "layerZeroEndpoint"]), "RECEIVER_STATE_SCHEMA", result);
  check(exactKeys(e.state, ["provider", "lrtOracle"]), "ETHEREUM_STATE_SCHEMA", result);
  check(exactKeys(e.state.provider, ["getLatestRate", "getRate", "rate", "lastUpdated", "rsETHPriceOracle", "routeSummary", "layerZeroEndpoint"]), "PROVIDER_STATE_SCHEMA", result);
  check(exactKeys(e.state.lrtOracle, ["rsETHPrice"]), "ORACLE_STATE_SCHEMA", result);
  const decimalValues = [b.state.pool.feeBps, b.state.pool.dailyMintLimit, b.state.pool.dailyMintAmount, b.state.pool.lastMintDay, b.state.pool.startTimestamp, b.state.pool.currentDay, b.state.pool.remainingDailyMintLimit, b.state.pool.rate, b.state.wrapper.maxCanonicalDeposit, b.state.wrapper.totalSupply, b.state.canonical.decimals, b.state.canonical.wrapperReserve, b.state.receiver.rate, b.state.receiver.lastUpdated, b.state.receiver.srcChainId, e.state.provider.getLatestRate, e.state.provider.getRate, e.state.provider.rate, e.state.provider.lastUpdated, e.state.lrtOracle.rsETHPrice];
  check(decimalValues.every(decimal), "DECIMAL_SCALARS", result);
  check([b.state.pool.wrsETH, b.state.pool.rsETHOracle, b.state.receiver.rateProvider, b.state.receiver.layerZeroEndpoint, e.state.provider.rsETHPriceOracle, e.state.provider.layerZeroEndpoint].every(address) && /^0x[0-9a-f]{64}$/.test(b.state.wrapper.minterRole), "ADDRESS_AND_ROLE_SCALARS", result);
  const route = e.state.provider.routeSummary;
  check(exactKeys(route, ["getterStatus", "totalEntries", "baseDestinationEntries", "matchingBaseEntries", "conflictingBaseEntries"]) && route.getterStatus === "OBSERVED" && [route.totalEntries, route.baseDestinationEntries, route.matchingBaseEntries, route.conflictingBaseEntries].every(Number.isSafeInteger) && route.totalEntries <= EXPECTED.caps.routeReceiverEntries, "PROVIDER_ROUTE_SUMMARY", result);
  check(typeof b.state.pool.paused === "boolean" && typeof b.state.wrapper.poolHasMinterRole === "boolean" && typeof b.state.wrapper.canonicalAllowed === "boolean", "BOOLEAN_SCALARS", result);

  check(exactKeys(raw.policy, ["allowedMethods", "caps", "plan", "retries", "stateOverrides", "logs", "traces", "accounts", "pinnedReadSemantics"]), "POLICY_SCHEMA", result);
  check(JSON.stringify(raw.policy.allowedMethods) === JSON.stringify(EXPECTED.methods) && runner.canonicalJson(raw.policy.caps) === runner.canonicalJson(EXPECTED.caps) && runner.canonicalJson(raw.policy.plan) === runner.canonicalJson(EXPECTED.plan), "POLICY_BINDING", result);
  check(raw.policy.retries === 0 && raw.policy.stateOverrides === false && raw.policy.logs === false && raw.policy.traces === false && raw.policy.accounts === false && raw.policy.pinnedReadSemantics === "numeric block tags plus terminal same-number/hash/timestamp header consistency", "POLICY_FORBIDDEN_OPERATIONS", result);
  check(exactKeys(raw.rpc, ["totalCalls", "callsByChain", "qualificationCalls", "batches", "transientBytes", "byMethod"]), "RPC_SCHEMA", result);
  check(Number.isSafeInteger(raw.rpc.totalCalls) && raw.rpc.totalCalls <= EXPECTED.caps.totalCalls && raw.rpc.callsByChain.base <= EXPECTED.caps.baseCalls && raw.rpc.callsByChain.ethereum <= EXPECTED.caps.ethereumCalls && raw.rpc.qualificationCalls <= EXPECTED.caps.qualificationCalls && raw.rpc.transientBytes <= EXPECTED.caps.aggregateTransientBytes, "RPC_CAPS", result);
  check(Object.keys(raw.rpc.byMethod).every((method) => EXPECTED.methods.includes(method)) && Object.values(raw.rpc.byMethod).every(Number.isSafeInteger) && Object.values(raw.rpc.byMethod).reduce((sum, count) => sum + count, 0) === raw.rpc.totalCalls && (raw.rpc.byMethod.eth_getBlockByNumber || 0) >= 4, "RPC_METHOD_COUNTS_AND_TERMINAL_READS", result);
  check(exactKeys(raw.safety, ["inventoryReadInMemoryOnly", "endpointMaterialPersisted", "providerIdentityPersisted", "rawRpcPersisted", "rawBytecodePersisted", "signing", "transactions", "broadcasts", "stateMutation", "networkOnlyInExplicitCaptureMode"]), "SAFETY_SCHEMA", result);
  check(raw.safety.inventoryReadInMemoryOnly === true && raw.safety.networkOnlyInExplicitCaptureMode === true && [raw.safety.endpointMaterialPersisted, raw.safety.providerIdentityPersisted, raw.safety.rawRpcPersisted, raw.safety.rawBytecodePersisted, raw.safety.signing, raw.safety.transactions, raw.safety.broadcasts, raw.safety.stateMutation].every((value) => value === false), "SAFETY_VALUES", result);
  const leak = runner.leakScan(raw); check(leak.passed, `LEAK_${leak.findings.join("_")}`, result);

  const outcome = runner.evaluateCapture(raw.chains);
  check(raw.promotion === outcome.promotion && raw.classification === outcome.classification, "OUTCOME_CLASSIFICATION", result);
  check(JSON.stringify(raw.killReasons) === JSON.stringify(outcome.killReasons), "KILL_REASON_BINDING", result);
  check(JSON.stringify(raw.analysis) === JSON.stringify(outcome.analysis), "ANALYSIS_BINDING", result);
  return result;
}

function validateManifest(manifestBytes = read(MANIFEST_REL)) {
  const result = state(), manifest = JSON.parse(manifestBytes.toString("utf8"));
  check(sha256(manifestBytes) === EXPECTED_MANIFEST_SHA256, "MANIFEST_TRUSTED_HASH", result);
  check(exactKeys(manifest, ["schemaVersion", "packageId", "sourceCommit", "sourceRuntimeAttested", "validatorPolicyVersion", "specSha256", "constants", "files"]), "MANIFEST_SCHEMA", result);
  check(manifest.schemaVersion === "kelp-rseth-stale-rate-deployment-step2-manifest/v1" && manifest.packageId === runner.FINDING_ID, "MANIFEST_ID", result);
  check(manifest.sourceCommit === EXPECTED.sourceCommit && manifest.sourceRuntimeAttested === false && manifest.validatorPolicyVersion === POLICY_VERSION && manifest.specSha256 === EXPECTED_SPEC_SHA256, "MANIFEST_POLICY_SOURCE_SPEC", result);
  check(runner.canonicalJson(manifest.constants) === runner.canonicalJson({ addresses: runner.ADDRESSES, route: runner.ROUTE, slots: runner.SLOTS, selectors: runner.SELECTORS, caps: runner.CAPS, plan: runner.PLAN, allowedMethods: runner.ALLOWED_METHODS }), "MANIFEST_CONSTANTS", result);
  const expectedFiles = ["tools/run-critical-kelp-rseth-stale-rate-deployment-step2.js", "tools/test-critical-kelp-rseth-stale-rate-deployment-step2.js"];
  check(Array.isArray(manifest.files) && JSON.stringify(manifest.files.map((row) => row.path)) === JSON.stringify(expectedFiles), "MANIFEST_FILE_SET", result);
  for (const row of manifest.files) check(exactKeys(row, ["path", "sha256"]) && /^[0-9a-f]{64}$/.test(row.sha256) && sha256(read(row.path)) === row.sha256, `MANIFEST_FILE_HASH:${row.path}`, result);
  return result;
}

function checkOnly() {
  const bindings = validateStaticBindings(), manifest = validateManifest();
  return { status: "PASS", mode: "offline-check-only", checks: bindings.checks + manifest.checks, specSha256: EXPECTED_SPEC_SHA256, manifestSha256: EXPECTED_MANIFEST_SHA256, sourceCommit: EXPECTED.sourceCommit, sourceRuntimeAttested: false, promotionPossible: false, validatorPolicyVersion: POLICY_VERSION };
}

function main(argv = process.argv.slice(2)) {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === "--check-only")) { process.stdout.write(`${JSON.stringify(checkOnly())}\n`); return; }
  if (argv.length !== 2 || argv[0] !== "--input") throw new Error("VALIDATION_FAILED:CLI_ARGUMENTS");
  const supplied = path.resolve(argv[1]); if (supplied !== runner.OUTPUT) throw new Error("VALIDATION_FAILED:INPUT_PATH_NOT_FIXED_OUTPUT");
  const body = fs.readFileSync(supplied), raw = JSON.parse(body), data = validateData(raw), bindings = validateStaticBindings(), manifest = validateManifest();
  process.stdout.write(`${JSON.stringify({ status: "PASS", mode: "capture-validation", checks: data.checks + bindings.checks + manifest.checks, promotion: false, classification: raw.classification, captureSha256: sha256(body) })}\n`);
}

if (require.main === module) {
  try { main(); }
  catch (error) { process.stderr.write(`${JSON.stringify({ status: "FAIL", reason: String(error.message || error).replace(/[^A-Z0-9_:.-]/gi, "_").slice(0, 160) })}\n`); process.exitCode = 1; }
}

module.exports = { POLICY_VERSION, MANIFEST_REL, EXPECTED_SPEC_SHA256, EXPECTED_MANIFEST_SHA256, EXPECTED, validateStaticBindings, validateData, validateManifest, checkOnly };
