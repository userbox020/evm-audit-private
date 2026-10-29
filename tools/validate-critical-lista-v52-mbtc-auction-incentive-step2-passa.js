#!/usr/bin/env node
"use strict";

// Offline validator. Trust boundary: this validator's reviewed policy constants
// and its externally reported SHA-256. It does not embed the manifest hash.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const runner = require("./run-critical-lista-v52-mbtc-auction-incentive-step2-passa");

const POLICY_VERSION = "lista-v52-mbtc-step2-passa-validator/v1";
const MANIFEST_REL = "tools/critical-lista-v52-mbtc-auction-incentive-step2-passa.manifest.json";
const EXPECTED_SPEC_SHA256 = "dbde31eb8ed822c09a97baf38369fe48c6166166873dc7a03e578e88f2f26afc";
const EXPECTED_DESIGN_SHA256 = "8d3ca12dc9f56d94f01f05d2c03fda379c4fdb7ba88395cc04aa1c22011488e3";
const sha256 = (x) => crypto.createHash("sha256").update(x).digest("hex");
const exact = (x, keys) => x && typeof x === "object" && !Array.isArray(x) && Object.keys(x).sort().join("|") === [...keys].sort().join("|");
const address = (x) => /^0x[0-9a-f]{40}$/.test(x || ""), hash = (x) => /^0x[0-9a-f]{64}$/.test(x || "");
const decimal = (x) => typeof x === "string" && /^(?:0|[1-9][0-9]*)$/.test(x), signed = (x) => typeof x === "string" && /^(?:0|-?[1-9][0-9]*)$/.test(x);
const state = () => ({ checks: 0 });
function check(v, code, s) { if (!v) throw new Error(`VALIDATION_FAILED:${code}`); s.checks++; }
const read = (rel) => fs.readFileSync(path.join(runner.ROOT, rel));

function validateStaticBindings() {
  const s = state();
  check(runner.SCHEMA_VERSION === "lista-v52-mbtc-auction-incentive-step2-passa/v1", "SCHEMA", s);
  check(runner.LOGIC_COMMIT === "fe0fe823a245db35452a17c203801653cabb0148", "LOGIC_COMMIT", s);
  check(runner.REGISTRY_COMMIT === "2b7dee0bf8c98208f1761758641fce3e4ae6aa67", "REGISTRY_COMMIT", s);
  check(runner.SOURCE_LABEL === "Lista DAO v5.2 source logic with official post-tag mBTC deployment registry", "SOURCE_LABEL", s);
  check(runner.DESIGN_SHA256 === EXPECTED_DESIGN_SHA256 && sha256(read(runner.DESIGN_REL)) === EXPECTED_DESIGN_SHA256, "DESIGN_HASH", s);
  check(runner.SPEC_SHA256 === EXPECTED_SPEC_SHA256, "SPEC_HASH", s);
  check(runner.ROOTS.token === "0x7c1cca5b25fa0bc9af9275fb53cba89dc172b878" && runner.ILK === "0x6d42544300000000000000000000000000000000000000000000000000000000", "MBTC", s);
  check(runner.ROOTS.joinProxy === "0xe95eaf5b61558bf73195550149759ce53a82a0c6" && runner.ROOTS.joinImplementation === "0x3e75d7edacc97645033ef8073d025069b0a0976d", "JOIN", s);
  check(runner.ROOTS.clipProxy === "0x117b4a02d1bb3a32f4bf5cd6103e633b2b651063" && runner.ROOTS.clipImplementation === "0x9b878823cf06fac1edb02b44eada8bb4274ab7ea", "CLIP", s);
  check(runner.ROOTS.oracleProxy === "0xd5e1b35d7dfb1b20546d3bb63aee3d8b7cc66870" && runner.ROOTS.oracleImplementation === "0x8be9583e729ca39d3d50458fb59e4fe5ba222345", "ORACLE", s);
  check(runner.ROOTS.calc === "0xc1359ed77e6b0cbf9a8130a4c28fbbb87b9501b7", "CALC", s);
  check(runner.FIXED_ROOTS.length === 14 && runner.CAPS.candidates === 1 && runner.CAPS.fixedRoots === 14, "SCOPE", s);
  check(runner.CAPS.endpointQualification === 5 && runner.CAPS.maxTransportRetriesTotal === 1 && runner.CAPS.callsPerBatch === 12 && runner.CAPS.concurrency === 2, "TRANSPORT_CAPS", s);
  check(runner.PLAN.stateCalls === 52 && runner.PLAN.captureLogicalRequests === runner.PLAN.codeAndSlotCalls + runner.PLAN.stateCalls + 3 && runner.PLAN.trueWorstCaseRequests === 128 && runner.PLAN.trueWorstCaseRequests === runner.PLAN.captureLogicalRequests + runner.PLAN.maximumQualificationRequests + runner.PLAN.reservedRetryElements && runner.PLAN.trueWorstCaseRequests <= runner.CAPS.rpcRequests, "TRUE_WORST_CASE", s);
  check(runner.RETRY_SCOPE.includes("pre-pin") && runner.RETRY_SCOPE.includes("no block assertion"), "RETRY_SCOPE", s);
  check(runner.canonicalJson(runner.INVENTORY_SELECTION_POLICY) === runner.canonicalJson({ version: "bsc-direct-https-line-label/v2", lineScoped: true, standaloneLabel: "BSC", protocol: "https:", preserveOrder: true, exactUrlDedupe: true, maximumRows: 5, rejectOtherChainLabels: true, rejectBscAdjacentAndNonMainnetLabels: true, percentDecodeBeforeTemplateCheck: true, decodeErrorsFailClosed: true, rejectTemplatesPlaceholdersAndCustomEnvelopes: true, memoryOnlySecrets: true }), "INVENTORY_SELECTION", s);
  check(JSON.stringify(runner.ALLOWED_METHODS) === JSON.stringify(["eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getCode", "eth_getStorageAt", "eth_call"]), "METHODS", s);
  check(runner.SELECTORS.vat.live === "957aa58c" && runner.SELECTORS.dog.Hole === "af7cfeb1" && runner.SELECTORS.interaction.dutyCalculator === "ebb95c5d" && runner.SELECTORS.interaction.borrowLisUSDListaDistributor === "e68d57cf" && runner.SELECTORS.spotter.par === "495d32cb" && runner.SELECTORS.auth.wards === "bf353dbb" && runner.SELECTORS.clip.calc === "96f1b6be", "SELECTORS", s);
  return s;
}

function validateProxy(x, s) { check(exact(x, ["kind", "implementation", "beacon", "admin"]), "PROXY_SCHEMA", s); check(["DIRECT", "IMPLEMENTATION", "BEACON"].includes(x.kind) && [x.implementation, x.beacon, x.admin].every((v) => v === null || address(v)) && !(x.implementation && x.beacon), "PROXY_VALUE", s); }
function validateEconomics(x, s) {
  check(exact(x, ["dustRad", "rateRay", "requiredArtWad", "requiredDebtRad", "chopWad", "requiredTabRad", "chostExpectedRad", "tipRad", "chipWad", "penaltyCapacityRad", "kickRewardRad", "signedResidualRad", "resetRewardRad", "ratePositive", "dustPositive", "chopAtLeastWad", "tabPositive", "rewardExceedsPenaltyCapacity"]), "ECON_SCHEMA", s);
  check([x.dustRad, x.rateRay, x.chopWad, x.chostExpectedRad, x.tipRad, x.chipWad].every(decimal), "ECON_INPUT_DECIMAL", s);
  if (x.ratePositive) check([x.requiredArtWad, x.requiredDebtRad, x.requiredTabRad, x.kickRewardRad, x.resetRewardRad].every(decimal) && signed(x.penaltyCapacityRad) && signed(x.signedResidualRad), "ECON_DERIVED_DECIMAL", s);
  else check([x.requiredArtWad, x.requiredDebtRad, x.requiredTabRad, x.penaltyCapacityRad, x.kickRewardRad, x.signedResidualRad, x.resetRewardRad].every((v) => v === null), "ECON_ZERO_RATE_NULLS", s);
  check(runner.canonicalJson(runner.arithmetic(BigInt(x.dustRad), BigInt(x.rateRay), BigInt(x.chopWad), BigInt(x.tipRad), BigInt(x.chipWad))) === runner.canonicalJson(x), "ECON_BINDING", s);
}

function validateData(raw) {
  const s = state();
  check(exact(raw, ["schemaVersion", "findingId", "provenance", "specSha256", "sourceRuntimeAttested", "promotion", "executable", "captureMode", "classification", "passBWarranted", "killReasons", "inconclusiveReasons", "chain", "analysis", "policy", "rpc", "safety"]), "TOP_SCHEMA", s);
  check(raw.schemaVersion === runner.SCHEMA_VERSION && raw.findingId === runner.FINDING_ID && raw.specSha256 === EXPECTED_SPEC_SHA256, "IDENTITY", s);
  check(exact(raw.provenance, ["sourceLabel", "logicCommit", "registryCommit", "designSha256"]) && raw.provenance.sourceLabel === runner.SOURCE_LABEL && raw.provenance.logicCommit === runner.LOGIC_COMMIT && raw.provenance.registryCommit === runner.REGISTRY_COMMIT && raw.provenance.designSha256 === EXPECTED_DESIGN_SHA256, "PROVENANCE", s);
  check(raw.sourceRuntimeAttested === false && raw.promotion === false && raw.executable === false, "FORCED_FALSE", s);
  check(raw.captureMode === "BSC_NUMERIC_PIN_TERMINAL_HASH_STATE_ROOT_RECHECK" && typeof raw.passBWarranted === "boolean" && ["PASS_B_WARRANTED/MBTC_DEPLOYMENT_EVIDENCE_ONLY", "KILLED/PASS_B_NOT_WARRANTED"].includes(raw.classification), "CLASSIFICATION", s);
  check(Array.isArray(raw.killReasons) && Array.isArray(raw.inconclusiveReasons) && raw.inconclusiveReasons.includes("SOURCE_RUNTIME_UNATTESTED") && raw.inconclusiveReasons.includes("POST_TAG_REGISTRY_IS_PROVENANCE_NOT_RUNTIME_ATTESTATION") && raw.inconclusiveReasons.includes("INTERACTION_HAY_HAYJOIN_DUTY_DISTRIBUTOR_RUNTIME_RECORD_ONLY"), "GATES", s);
  const c = raw.chain;
  check(exact(c, ["chainId", "pin", "contracts", "values"]) && c.chainId === 56, "CHAIN", s);
  check(exact(c.pin, ["number", "timestamp", "hash", "stateRoot", "terminalHeaderConsistent"]) && decimal(c.pin.number) && decimal(c.pin.timestamp) && hash(c.pin.hash) && hash(c.pin.stateRoot) && c.pin.terminalHeaderConsistent === true, "PIN", s);
  check(Array.isArray(c.contracts) && c.contracts.length === 14, "CONTRACT_COUNT", s);
  c.contracts.forEach((row, i) => { check(exact(row, ["address", "runtime", "proxy"]) && row.address === runner.FIXED_ROOTS[i], "CONTRACT_ROOT", s); check(exact(row.runtime, ["bytes", "keccak256"]) && Number.isSafeInteger(row.runtime.bytes) && row.runtime.bytes > 0 && row.runtime.bytes <= runner.CAPS.codeBytes && hash(row.runtime.keccak256), "RUNTIME", s); validateProxy(row.proxy, s); });
  const v = c.values;
  check(exact(v, ["interaction", "vat", "dog", "spotter", "join", "clip", "oracle", "calc", "token", "auth"]), "VALUES_SCHEMA", s);
  check(exact(v.interaction, Object.keys(runner.SELECTORS.interaction)), "INTERACTION_SCHEMA", s);
  check([v.interaction.vat, v.interaction.spotter, v.interaction.dog, v.interaction.hay, v.interaction.hayJoin, v.interaction.jug, v.interaction.dutyCalculator, v.interaction.borrowLisUSDListaDistributor, v.interaction.helioProviders].every(address), "INTERACTION_ADDRESSES", s);
  check([v.interaction.whitelistMode, v.interaction.auctionWhitelistMode, v.interaction.tokensBlacklist, v.interaction.providerCompatibilityMode].every(decimal), "INTERACTION_CONTROLS", s);
  check(exact(v.interaction.collaterals, ["join", "ilk", "live", "clip"]) && address(v.interaction.collaterals.join) && hash(v.interaction.collaterals.ilk) && decimal(v.interaction.collaterals.live) && address(v.interaction.collaterals.clip), "COLLATERAL", s);
  check(exact(v.vat, Object.keys(runner.SELECTORS.vat)) && exact(v.vat.ilks, ["art", "rate", "spot", "line", "dust"]) && Object.values(v.vat.ilks).every(decimal) && [v.vat.live, v.vat.debt, v.vat.Line].every(decimal), "VAT", s);
  check(exact(v.dog, Object.keys(runner.SELECTORS.dog)) && exact(v.dog.ilks, ["clip", "chop", "hole", "dirt"]) && address(v.dog.ilks.clip) && [v.dog.ilks.chop, v.dog.ilks.hole, v.dog.ilks.dirt, v.dog.live, v.dog.Dirt, v.dog.Hole].every(decimal) && address(v.dog.vow), "DOG", s);
  check(exact(v.spotter, ["ilks", "par"]) && exact(v.spotter.ilks, ["oracle", "mat"]) && address(v.spotter.ilks.oracle) && decimal(v.spotter.ilks.mat) && decimal(v.spotter.par), "SPOTTER", s);
  check(exact(v.join, Object.keys(runner.SELECTORS.join)) && address(v.join.vat) && hash(v.join.ilk) && address(v.join.gem) && decimal(v.join.live), "JOIN", s);
  check(exact(v.clip, Object.keys(runner.SELECTORS.clip)) && [v.clip.vow, v.clip.dog, v.clip.vat, v.clip.spotter, v.clip.calc].every(address) && hash(v.clip.ilk) && [v.clip.tip, v.clip.chip, v.clip.tail, v.clip.cusp, v.clip.stopped, v.clip.chost, v.clip.buf].every(decimal), "CLIP", s);
  check(exact(v.oracle, ["value", "valid"]) && hash(v.oracle.value) && typeof v.oracle.valid === "boolean" && exact(v.calc, ["tau"]) && decimal(v.calc.tau) && exact(v.token, ["decimals"]) && decimal(v.token.decimals), "DEPENDENCIES", s);
  check(exact(v.auth, ["dogInteraction", "clipDog", "clipInteraction", "vatDog", "vatClip", "vatSpotter", "vatJug"]) && Object.values(v.auth).every(decimal), "AUTH_EDGES", s);
  const a = raw.analysis;
  check(exact(a, ["economics", "capacity", "routes", "controls", "sourceRuntimeAttested", "promotion", "executable"]), "ANALYSIS_SCHEMA", s); validateEconomics(a.economics, s);
  check(exact(a.capacity, ["requiredDebtRad", "ilkDebtRad", "globalVatAvailableRad", "ilkVatAvailableRad", "dogHeadroomRad", "ilkHeadroomRad", "vatDebtWithinLine", "ilkDebtWithinLine", "dogDirtWithinHole", "ilkDirtWithinHole", "globalVatMinimumDebtAvailable", "ilkVatMinimumDebtAvailable"]) && [a.capacity.requiredDebtRad, a.capacity.ilkDebtRad, a.capacity.globalVatAvailableRad, a.capacity.ilkVatAvailableRad, a.capacity.dogHeadroomRad, a.capacity.ilkHeadroomRad].every(decimal) && [a.capacity.vatDebtWithinLine, a.capacity.ilkDebtWithinLine, a.capacity.dogDirtWithinHole, a.capacity.ilkDirtWithinHole, a.capacity.globalVatMinimumDebtAvailable, a.capacity.ilkVatMinimumDebtAvailable].every((x) => typeof x === "boolean"), "CAPACITY", s);
  check(exact(a.routes, ["simpleAttackerNewVaultPermissionless", "existingUnsafeVaultPublicKickConfigEligible", "existingUnsafeVaultPublicRedoConfigEligible", "providerConfigured", "providerCallRequiredForKick", "borrowerWhitelistAffectsNewVaultOnly", "blacklistAffectsDepositBorrowNotStartAuction"]) && Object.values(a.routes).every((x) => typeof x === "boolean"), "ROUTES", s);
  check(exact(a.controls, ["whitelistMode", "auctionWhitelistMode", "blacklist", "provider", "providerCompatibilityMode", "stopped"]) && [a.controls.whitelistMode, a.controls.auctionWhitelistMode, a.controls.blacklist, a.controls.providerCompatibilityMode, a.controls.stopped].every(decimal) && address(a.controls.provider), "CONTROLS", s);
  check(a.sourceRuntimeAttested === false && a.promotion === false && a.executable === false, "ANALYSIS_FORCED_FALSE", s);
  check(exact(raw.policy, ["allowedMethods", "caps", "plan", "equations", "inventorySelection", "fixedTargetsOnly", "dynamicTraversal", "retry", "logs", "traces", "transactions", "signing", "arbitraryAccounts", "storageScans"]), "POLICY_SCHEMA", s);
  check(JSON.stringify(raw.policy.allowedMethods) === JSON.stringify(runner.ALLOWED_METHODS) && runner.canonicalJson(raw.policy.caps) === runner.canonicalJson(runner.CAPS) && runner.canonicalJson(raw.policy.plan) === runner.canonicalJson(runner.PLAN) && runner.canonicalJson(raw.policy.equations) === runner.canonicalJson(runner.EQUATIONS) && runner.canonicalJson(raw.policy.inventorySelection) === runner.canonicalJson(runner.INVENTORY_SELECTION_POLICY), "POLICY_BINDING", s);
  check(raw.policy.fixedTargetsOnly === true && raw.policy.dynamicTraversal === false && [raw.policy.logs, raw.policy.traces, raw.policy.transactions, raw.policy.signing, raw.policy.arbitraryAccounts, raw.policy.storageScans].every((x) => x === false), "FORBIDDEN_OPS", s);
  check(exact(raw.policy.retry, ["maximumTotal", "transportOnly", "delayMs", "scope"]) && raw.policy.retry.maximumTotal === 1 && raw.policy.retry.transportOnly === true && raw.policy.retry.delayMs === 750 && raw.policy.retry.scope === runner.RETRY_SCOPE, "RETRY", s);
  check(exact(raw.rpc, ["requests", "batches", "retryElements", "retries", "byMethod"]) && Number.isSafeInteger(raw.rpc.requests) && raw.rpc.requests <= 128 && Number.isSafeInteger(raw.rpc.batches) && Number.isSafeInteger(raw.rpc.retryElements) && raw.rpc.retryElements <= 12 && [0, 1].includes(raw.rpc.retries), "RPC", s);
  check(Object.keys(raw.rpc.byMethod).every((x) => runner.ALLOWED_METHODS.includes(x)) && Object.values(raw.rpc.byMethod).every(Number.isSafeInteger) && Object.values(raw.rpc.byMethod).reduce((x, y) => x + y, 0) === raw.rpc.requests, "RPC_COUNTS", s);
  check(exact(raw.safety, ["inventoryMemoryOnly", "endpointMaterialPersisted", "rawRpcPersisted", "rawBytecodePersisted", "networkOnlyWithExplicitCapture"]) && raw.safety.inventoryMemoryOnly && raw.safety.networkOnlyWithExplicitCapture && !raw.safety.endpointMaterialPersisted && !raw.safety.rawRpcPersisted && !raw.safety.rawBytecodePersisted, "SAFETY", s);
  check(runner.leakScan(raw).passed, "LEAK", s);
  const expected = runner.evaluate(c);
  check(raw.classification === expected.classification && raw.passBWarranted === expected.passBWarranted && JSON.stringify(raw.killReasons) === JSON.stringify(expected.killReasons) && JSON.stringify(raw.inconclusiveReasons) === JSON.stringify(expected.inconclusiveReasons) && JSON.stringify(raw.analysis) === JSON.stringify(expected.analysis), "OUTCOME", s);
  return s;
}

function validateDesign(design, s) {
  check(exact(design, ["schemaVersion", "packageId", "network", "logicProvenance", "deploymentRegistryProvenance", "fixedRoots", "mbtc", "passARequirements", "attestationPolicy"]), "DESIGN_SCHEMA", s);
  check(design.schemaVersion === "lista-v52-mbtc-step2-passa-target-design/v1" && design.packageId === runner.FINDING_ID && design.network.chainId === 56, "DESIGN_ID", s);
  check(design.logicProvenance.commit === runner.LOGIC_COMMIT && design.logicProvenance.tag === "v5.2" && design.deploymentRegistryProvenance.commit === runner.REGISTRY_COMMIT && design.deploymentRegistryProvenance.relationship.includes("not v5.2 runtime-bytecode attestation"), "DESIGN_PROVENANCE", s);
  check(runner.canonicalJson(design.fixedRoots) === runner.canonicalJson(runner.ROOTS) && design.mbtc.ilk === runner.ILK && design.mbtc.candidateCount === 1, "DESIGN_TARGETS", s);
  check(typeof design.passARequirements.requiredArtWad === "string" && design.passARequirements.requiredArtWad.includes("exact bigint ceil division") && design.passARequirements.requiredDebtRad.includes("RAD units (10^45)") && design.passARequirements.requiredTabRad.includes("Dog headroom") && design.passARequirements.chostExpectedRad.includes("unrounded dust") && design.passARequirements.newVaultCeilings.length === 4 && design.passARequirements.pricePrerequisites.length === 4 && design.passARequirements.authorizationEdges.length === 7 && design.passARequirements.recordOnlyDependencies.includes("Interaction.borrowLisUSDListaDistributor") && design.passARequirements.inventorySelection.length === 6, "DESIGN_REQUIREMENTS", s);
  check(design.attestationPolicy.sourceRuntimeAttested === false && design.attestationPolicy.promotion === false && design.attestationPolicy.executable === false, "DESIGN_ATTESTATION", s);
}
function validateManifest(bytes = read(MANIFEST_REL)) {
  const s = state(), m = JSON.parse(bytes.toString("utf8")), designBytes = read(runner.DESIGN_REL), design = JSON.parse(designBytes);
  validateDesign(design, s); check(sha256(designBytes) === EXPECTED_DESIGN_SHA256, "DESIGN_TRUSTED_HASH", s);
  check(exact(m, ["schemaVersion", "packageId", "validatorPolicyVersion", "trustBoundary", "provenance", "specSha256", "sourceRuntimeAttested", "promotion", "executable", "roots", "ilk", "slots", "selectors", "caps", "plan", "equations", "retryScope", "inventorySelectionPolicy", "allowedMethods", "files"]), "MANIFEST_SCHEMA", s);
  check(m.schemaVersion === "lista-v52-mbtc-step2-passa-manifest/v1" && m.packageId === runner.FINDING_ID && m.validatorPolicyVersion === POLICY_VERSION && m.specSha256 === EXPECTED_SPEC_SHA256, "MANIFEST_ID", s);
  check(m.trustBoundary === "reviewed validator policy plus externally reported validator SHA-256; manifest hash is not embedded in validator" && m.sourceRuntimeAttested === false && m.promotion === false && m.executable === false, "MANIFEST_TRUST", s);
  check(m.provenance.logicCommit === runner.LOGIC_COMMIT && m.provenance.registryCommit === runner.REGISTRY_COMMIT && m.provenance.designSha256 === EXPECTED_DESIGN_SHA256 && m.provenance.sourceLabel === runner.SOURCE_LABEL, "MANIFEST_PROVENANCE", s);
  check(runner.canonicalJson(m.roots) === runner.canonicalJson(runner.ROOTS) && m.ilk === runner.ILK && runner.canonicalJson(m.slots) === runner.canonicalJson(runner.SLOTS) && runner.canonicalJson(m.selectors) === runner.canonicalJson(runner.SELECTORS), "MANIFEST_TARGETS", s);
  check(runner.canonicalJson(m.caps) === runner.canonicalJson(runner.CAPS) && runner.canonicalJson(m.plan) === runner.canonicalJson(runner.PLAN) && runner.canonicalJson(m.equations) === runner.canonicalJson(runner.EQUATIONS) && m.retryScope === runner.RETRY_SCOPE && runner.canonicalJson(m.inventorySelectionPolicy) === runner.canonicalJson(runner.INVENTORY_SELECTION_POLICY) && JSON.stringify(m.allowedMethods) === JSON.stringify(runner.ALLOWED_METHODS), "MANIFEST_POLICY", s);
  const expectedFiles = ["tools/run-critical-lista-v52-mbtc-auction-incentive-step2-passa.js", "tools/test-critical-lista-v52-mbtc-auction-incentive-step2-passa.js", "tools/validate-critical-lista-v52-mbtc-auction-incentive-step2-passa.js", runner.DESIGN_REL];
  check(Array.isArray(m.files) && JSON.stringify(m.files.map((x) => x.path)) === JSON.stringify(expectedFiles), "MANIFEST_FILES", s);
  m.files.forEach((x) => check(exact(x, ["path", "sha256"]) && /^[0-9a-f]{64}$/.test(x.sha256) && sha256(read(x.path)) === x.sha256, `FILE_HASH_${x.path}`, s));
  return s;
}

function checkOnly() { const a = validateStaticBindings(), m = validateManifest(), manifestSha256 = sha256(read(MANIFEST_REL)); return { status: "PASS", mode: "offline-check-only", checks: a.checks + m.checks, packageId: runner.FINDING_ID, candidate: "mBTC", specSha256: EXPECTED_SPEC_SHA256, designSha256: EXPECTED_DESIGN_SHA256, manifestSha256, sourceRuntimeAttested: false, promotion: false, executable: false, trustBoundary: "validator-policy-and-external-validator-hash" }; }
function main(argv = process.argv.slice(2)) { if (argv.length === 0 || (argv.length === 1 && argv[0] === "--check-only")) { process.stdout.write(`${JSON.stringify(checkOnly())}\n`); return; } if (argv.length !== 2 || argv[0] !== "--input" || path.resolve(argv[1]) !== runner.OUTPUT) throw new Error("VALIDATION_FAILED:CLI"); const body = fs.readFileSync(runner.OUTPUT); if (body.length > runner.CAPS.sanitizedOutputBytes) throw new Error("VALIDATION_FAILED:OUTPUT_CAP"); const d = validateData(JSON.parse(body)), a = validateStaticBindings(), m = validateManifest(); process.stdout.write(`${JSON.stringify({ status: "PASS", mode: "capture-validation", checks: d.checks + a.checks + m.checks, captureSha256: sha256(body), sourceRuntimeAttested: false, promotion: false, executable: false })}\n`); }
if (require.main === module) { try { main(); } catch (e) { process.stderr.write(`${JSON.stringify({ status: "FAIL", reason: String(e.message || e).replace(/[^A-Z0-9_:.-]/gi, "_").slice(0, 200) })}\n`); process.exitCode = 1; } }
module.exports = { POLICY_VERSION, MANIFEST_REL, EXPECTED_SPEC_SHA256, EXPECTED_DESIGN_SHA256, validateStaticBindings, validateData, validateDesign, validateManifest, checkOnly };
