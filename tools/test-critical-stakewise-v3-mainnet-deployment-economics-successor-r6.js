"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { id } = require("./node_modules/ethers");
const runner = require("./critical-stakewise-v3-mainnet-deployment-economics-successor-r6-runner");

const ROOT = path.resolve(__dirname, "..");
const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, ...runner.FIXTURE_REL.split("/")), "utf8"));
let checks = 0;
function check(value, message) { assert.ok(value, message); checks += 1; }
function equal(actual, expected, message) { assert.deepStrictEqual(actual, expected, message); checks += 1; }

async function main() {
  equal(fixture.schemaVersion, 6, "fixture schema");
  check(fixture.fixtureClasses.includes("transitive-loaded-file-tamper-rejected"), "tamper fixture class");
  equal(runner.FINDING_ID, "stakewise-v3-current-deployment-state-diagnostic-r6", "finding id");
  equal(runner.CAPTURE_FLAG, "--capture-stakewise-mainnet-r6-once", "capture flag");
  check(runner.ROLE_KEYS.includes("LegacyPoolEscrow"), "legacy pool role");

  const stamp = new Date().toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
  const runId = `swv3diag6-${stamp}-${"a".repeat(32)}`;
  equal(runner.parseArgs(["node", "runner", "--check-only"]).checkOnly, true, "check-only args");
  equal(runner.parseArgs(["node", "runner", runner.CAPTURE_FLAG, "--run-id", runId]).runId, runId, "capture args");
  assert.throws(() => runner.parseArgs(["node", "runner", "--capture-stakewise-mainnet-r5-once", "--run-id", runId])); checks += 1;

  const requestCode = (result) => async () => result === null ? { ok: false, result: null } : { ok: true, result };
  equal(await runner.requiredCode({}, fixture.vaultA, 1n, {}, null, requestCode("0x")), false,
    "empty runtime code propagates present false");
  equal(await runner.requiredCode({}, fixture.vaultA, 1n, {}, null, requestCode("0x6000")), true,
    "nonempty runtime code propagates present true");
  equal(await runner.requiredCode({}, fixture.vaultA, 1n, {}, null, requestCode(null)), null,
    "failed runtime code read remains missing");
  const roles = Object.fromEntries(runner.ROLE_KEYS.map((key) => [key, fixture.vaultA]));
  const roleCode = Object.fromEntries(runner.ROLE_KEYS.map((key) => [`code_${key}`, true]));
  roleCode.code_VaultFactory = false; roleCode.controllerKeeper = roles.Keeper;
  roleCode.configRedeemer = roles.OsTokenRedeemer;
  equal(runner.globalIntegrity(roleCode, roles).allRoleCodePresent, false,
    "empty factory code fails all-role completeness");

  const meta = runner.trustedClassification(id("EthMetaVault"), 5n,
    { factoryKey: "MetaVaultFactory", directKey: null }, true, true);
  equal(meta.meta, true, "meta classification");
  equal(runner.stagedReadPlan(meta), { stage: "META_SUBVAULTS", keeper: false, vaultMev: false, subVaults: true }, "meta plan");
  const nonMeta = runner.trustedClassification(id("EthVault"), 5n,
    { factoryKey: "VaultFactory", directKey: null }, true, true);
  equal(runner.stagedReadPlan(nonMeta), { stage: "NON_META_KEEPER_MEV", keeper: true, vaultMev: true, subVaults: false }, "non-meta plan");
  equal(runner.stagedReadPlan({ trusted: false }), { stage: "IDENTITY_ONLY", keeper: false, vaultMev: false, subVaults: false }, "identity-only plan");
  const identity = { registryMember: true, codeRecord: { present: true, runtimeCodeHash: `0x${"1".repeat(64)}` },
    implementation: fixture.vaultB, version: 9, vaultId: `0x${"f".repeat(64)}` };
  const implementation = { implementationCodeRecord: { present: true, runtimeCodeHash: `0x${"2".repeat(64)}` },
    implementationRegistryMember: true };
  const unknownClassification = runner.trustedClassification(identity.vaultId, identity.version,
    { factoryKey: null, directKey: null }, true, true);
  const unknownRow = runner.identityDiagnosticRow({ address: fixture.vaultA, runtimeBuildBinding: false,
    exactAffectedSemantics: null, genesisState: null }, identity, implementation, unknownClassification);
  equal(unknownRow.readPath, "IDENTITY_ONLY", "unknown type uses identity path");
  equal(unknownRow.classification.reason, "VAULT_ID_UNKNOWN", "unknown classification preserved");
  equal(unknownRow.proxyRuntimeCodeHash, identity.codeRecord.runtimeCodeHash, "unknown proxy hash preserved");
  equal(unknownRow.implementationRuntimeCodeHash, implementation.implementationCodeRecord.runtimeCodeHash,
    "unknown implementation hash preserved");
  equal(unknownRow.capacity, null, "unsupported state skipped");
  equal(unknownRow.stageError, null, "identity-only is not a stage error");
  const actualUnknown = await runner.readVault(null, {}, fixture.vaultA,
    { factoryAddress: fixture.vaultB, factoryKey: "UnknownFactory", directKey: null }, 1n, {},
    { identity, implementationState: implementation });
  equal(actualUnknown.readPath, "IDENTITY_ONLY", "readVault executes unknown identity-only stage");
  equal(actualUnknown.vaultId, identity.vaultId, "readVault retains unknown vault id");
  equal(actualUnknown.unsupportedStateReadsSkipped, true, "readVault skips unknown state ABIs");
  const lineageMismatch = runner.trustedClassification(id("EthVault"), 5,
    { factoryKey: "MetaVaultFactory", directKey: null }, true, true);
  const lineageRow = runner.identityDiagnosticRow({ address: fixture.vaultA, runtimeBuildBinding: false,
    exactAffectedSemantics: null, genesisState: null }, { ...identity, vaultId: id("EthVault"), version: 5 },
  implementation, lineageMismatch);
  equal(lineageRow.classification.reason, "IMPL_OR_LINEAGE_MISMATCH", "lineage mismatch preserved");
  equal(lineageRow.identityReadsComplete, true, "lineage identity reads complete");
  equal(lineageRow.requiredReadsComplete, false, "unsupported state does not claim full completeness");
  const actualLineage = await runner.readVault(null, {}, fixture.vaultA,
    { factoryAddress: fixture.vaultB, factoryKey: "MetaVaultFactory", directKey: null }, 1n, {},
    { identity: { ...identity, vaultId: id("EthVault"), version: 5 }, implementationState: implementation });
  equal(actualLineage.readPath, "IDENTITY_ONLY", "readVault executes lineage-mismatch identity stage");
  equal(actualLineage.classification.reason, "IMPL_OR_LINEAGE_MISMATCH", "readVault retains lineage mismatch");

  const vault = fixture.vaultA; const reward = 17n; const unlocked = 3n;
  const root = runner.standardLeaf(vault, reward, unlocked);
  const dataset = { format: "standard-v1", leafEncoding: ["address", "int160", "uint160"], tree: [root],
    values: [{ value: [vault, reward.toString(), unlocked.toString()], treeIndex: 0 }] };
  const parsed = runner.parseRewardsDataset(dataset, [root, `0x${"0".repeat(64)}`], [vault],
    new Map([[vault, { rewardAssets: 1n, unlockedMevAssets: 2n }]]));
  equal(parsed.verified, true, "dataset verified");
  equal(parsed.completeForDiscovered, true, "dataset complete");
  equal(parsed.rows.get(vault).rootKind, "CURRENT", "current root kind");
  const missing = runner.parseRewardsDataset(dataset, [root, `0x${"0".repeat(64)}`], [vault, fixture.vaultB],
    new Map([[vault, { rewardAssets: 1n, unlockedMevAssets: 2n }], [fixture.vaultB, { rewardAssets: 0n, unlockedMevAssets: 0n }]]));
  equal(missing.verified, true, "partial dataset remains proof-valid");
  equal(missing.completeForDiscovered, false, "missing row is incomplete");
  equal(missing.reason, "DISCOVERED_VAULT_ROWS_MISSING", "missing row is unknown");

  const preflight = runner.dryPreflight();
  equal(preflight.schemaVersion, 6, "preflight schema");
  equal(Object.isFrozen(runner.NULL_CONCLUSIONS), true, "shared null conclusions frozen");
  equal(runner.NULL_CONCLUSIONS, { economics: null, applicability: null, capacitySweeps: null,
    exactAffectedSemantics: null }, "shared null conclusions exact");
  equal(preflight.nullConclusions, runner.NULL_CONCLUSIONS, "preflight uses shared null conclusions");
  equal(preflight.correctness.economics, null, "economics null");
  equal(preflight.correctness.applicability, null, "applicability null");
  equal(preflight.correctness.exactAffectedSemantics, null, "semantics null");
  equal(preflight.gates.deploymentApplicabilityCandidate, null, "candidate null");
  equal(preflight.gates.routePositive, null, "route null");

  const source = fs.readFileSync(path.join(__dirname, "critical-stakewise-v3-mainnet-deployment-economics-successor-r6-runner.js"), "utf8");
  for (const forbidden of ["function computeEconomics", "function exactContractCell", "function evaluateApplicability",
    "depositSweepBps", "EXACT_INTEGER_MODEL", "capacityResidual * BigInt"]) {
    check(!source.includes(forbidden), `forbidden model source absent: ${forbidden}`);
  }

  const graph = runner.loadedDependencyGraph();
  check(graph.length > 20, "transitive graph is populated");
  check(graph.every((row) => /^tools\/node_modules\/(?:ethers\/|@noble\/|@adraffy\/|ws\/)/u.test(row.path)), "graph scope");
  equal(new Set(graph.map((row) => row.path)).size, graph.length, "graph paths unique");
  equal(runner.verifyDependencyGraph(graph), true, "graph verifies");
  const victim = graph.find((row) => row.path.endsWith(".js"));
  assert.throws(() => runner.verifyDependencyGraph(graph, { readFile(file) {
    const bytes = fs.readFileSync(file); return file.endsWith(victim.path.replace(/\//gu, path.sep)) ? Buffer.concat([bytes, Buffer.from("tamper")]) : bytes;
  } }), /DEPENDENCY_FILE_MISMATCH/u); checks += 1;
  const omitted = graph.slice(1);
  assert.throws(() => runner.verifyDependencyGraph(omitted), /DEPENDENCY_GRAPH_PATH_SET_MISMATCH/u); checks += 1;

  const localInputs = runner.fileRecords(runner.LOCAL_INPUT_RELS);
  equal(localInputs.length, runner.LOCAL_INPUT_RELS.length, "all declared local inputs recorded");
  equal(runner.verifyFileRecords(localInputs, runner.LOCAL_INPUT_RELS), true, "local inputs verify");
  const localVictim = localInputs.find((row) => row.path.endsWith("mainnet.json"));
  assert.throws(() => runner.verifyFileRecords(localInputs, runner.LOCAL_INPUT_RELS, { readFile(file) {
    const bytes = fs.readFileSync(file); return file.endsWith(localVictim.path.replace(/\//gu, path.sep)) ?
      Buffer.concat([bytes, Buffer.from("tamper")]) : bytes;
  } }), /LOCAL_INPUT_FILE_MISMATCH/u); checks += 1;
  assert.throws(() => runner.verifyFileRecords(localInputs.slice(1), runner.LOCAL_INPUT_RELS),
    /LOCAL_INPUT_PATH_SET_MISMATCH/u); checks += 1;
  const artifacts = runner.fileRecords(runner.REQUIRED_ARTIFACT_PATHS);
  equal(runner.assertArtifactPathSet(artifacts), true, "required artifact set exact");
  assert.throws(() => runner.assertArtifactPathSet(artifacts.slice(1)), /ARTIFACT_PATH_SET_MISMATCH/u); checks += 1;
  const substituted = artifacts.map((row, index) => index === 0 ? { ...row, path: "reports/substituted-r6.txt" } : row);
  assert.throws(() => runner.assertArtifactPathSet(substituted), /ARTIFACT_PATH_SET_MISMATCH/u); checks += 1;
  const bound = { artifacts, runtimeDependencyGraph: graph, localInputs };
  bound.aggregateSha256 = runner.packageAggregate(bound);
  const omittedBound = { ...bound, artifacts: artifacts.slice(1) };
  omittedBound.aggregateSha256 = runner.packageAggregate(omittedBound);
  assert.throws(() => runner.verifyRuntimeBeforeInventory({ manifest: omittedBound }),
    /ARTIFACT_PATH_SET_MISMATCH/u); checks += 1;
  const substitutedBound = { ...bound, artifacts: substituted };
  substitutedBound.aggregateSha256 = runner.packageAggregate(substitutedBound);
  assert.throws(() => runner.verifyRuntimeBeforeInventory({ manifest: substitutedBound }),
    /ARTIFACT_PATH_SET_MISMATCH/u); checks += 1;
  let deploymentReads = 0;
  const verifiedBundle = runner.verifyRuntimeBeforeInventory({ manifest: bound, readFile(file) {
    if (file.endsWith(path.join("deployments", "mainnet.json"))) deploymentReads += 1;
    return fs.readFileSync(file);
  } });
  equal(deploymentReads, 1, "verified deployment buffer read exactly once");
  equal(Object.isFrozen(verifiedBundle), true, "verified bundle frozen");
  equal(Object.isFrozen(verifiedBundle.deployment), true, "parsed deployment frozen");
  equal(Object.isFrozen(verifiedBundle.roles), true, "parsed roles frozen");
  equal(Object.isFrozen(verifiedBundle.localConfig.packageLock), true, "verified package lock frozen");
  equal(runner.runtimeBinding(verifiedBundle.localConfig).loadedDependencyGraphCount, graph.length,
    "later runtime config consumes verified parsed package lock");
  assert.throws(() => runner.verifyRuntimeBeforeInventory({ manifest: bound, readFile(file) {
    const bytes = fs.readFileSync(file); return file.endsWith(localVictim.path.replace(/\//gu, path.sep)) ?
      Buffer.concat([bytes, Buffer.from("tamper")]) : bytes;
  } }), /LOCAL_INPUT_FILE_MISMATCH/u); checks += 1;

  const stateRoot = `0x${"3".repeat(64)}`; const previousRoot = `0x${"4".repeat(64)}`;
  const syntheticCapture = { discovery: {}, vaults: [], latestRewardsUpdated: { cid: "a".repeat(32) },
    global: { keeper: { rewardsRoot: stateRoot, prevRewardsRoot: previousRoot, rewardsNonce: 1n } } };
  const syntheticSuccess = await runner.runCapture({ runId }, {
    verifyRuntimeBeforeInventory() { return verifiedBundle; }, loadInventory() { return []; },
    async qualify() { return { attemptedFamilyCount: 2, qualifyingFamilyCount: 1, selected: {
      rows: [{}, {}], header: { number: 1n, hash: stateRoot, timestamp: 1n }, mode: "TWO_HOST_DIAGNOSTIC",
      hostnameConsensus: true } }; },
    async captureFamily() { return syntheticCapture; }, async terminalCheck() { return true; },
    async fetchDataset() { return { available: false, reason: "OFFLINE_TEST", value: null }; },
    writeOutput() {}, outputPath: "unused"
  });
  equal(syntheticSuccess.nullConclusions, runner.NULL_CONCLUSIONS, "success uses shared null conclusions");
  equal(syntheticSuccess.schemaVersion, 6, "synthetic success schema");

  const ordering = [];
  const failure = await runner.runCapture({ runId }, {
    verifyRuntimeBeforeInventory() { ordering.push("runtime"); return { deployment: {}, roles: {},
      localConfig: { packageLock: {}, packageJson: {} } }; },
    loadManifest() { throw new Error("DEPLOYMENT_REREAD_FORBIDDEN"); },
    loadInventory() { ordering.push("inventory"); return []; },
    async qualify() { ordering.push("qualify"); return { selected: null, attemptedFamilyCount: 0, qualifyingFamilyCount: 0 }; },
    writeOutput(_path, value) { ordering.push("write"); return value; }, outputPath: "unused"
  });
  equal(ordering, ["runtime", "inventory", "qualify", "write"], "verified bundle precedes inventory without reread");
  equal(failure.reasonCode, "NO_CHAIN1_FINALIZED_FAMILY", "offline capture failure reason");
  equal(failure.gates.deploymentApplicabilityCandidate, null, "failure candidate null");
  equal(failure.nullConclusions, runner.NULL_CONCLUSIONS, "failure uses shared null conclusions");
  let inventoryRead = false;
  const runtimeFailure = await runner.runCapture({ runId }, {
    verifyRuntimeBeforeInventory() { throw new Error("DEPENDENCY_FILE_MISMATCH"); },
    loadInventory() { inventoryRead = true; return []; }, writeOutput() {}, outputPath: "unused"
  });
  equal(inventoryRead, false, "tamper stops before inventory");
  equal(runtimeFailure.reasonCode, "DEPENDENCY_FILE_MISMATCH", "tamper reason preserved");
  equal(runtimeFailure.nullConclusions, runner.NULL_CONCLUSIONS, "pre-inventory failure uses shared null conclusions");

  equal(preflight.networkReads, 0, "test preflight network reads");
  equal(preflight.inventoryReads, 0, "test preflight inventory reads");
  equal((source.match(/nullConclusions: NULL_CONCLUSIONS/gu) || []).length >= 3, true,
    "success preflight and failure include shared null conclusions");
  process.stdout.write(`stakewise successor r6 tests passed: ${checks} checks, ${fixture.fixtureClasses.length} fixture classes, zero network/inventory reads\n`);
}

main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
