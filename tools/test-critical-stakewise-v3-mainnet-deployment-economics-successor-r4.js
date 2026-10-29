"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { id } = require("./node_modules/ethers");
const runner = require("./critical-stakewise-v3-mainnet-deployment-economics-successor-r4-runner");

const ROOT = path.resolve(__dirname, "..");
const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, ...runner.FIXTURE_REL.split("/")), "utf8"));
let checks = 0;
function check(value, message) { assert.ok(value, message); checks += 1; }
function equal(actual, expected, message) { assert.deepStrictEqual(actual, expected, message); checks += 1; }

async function main() {
  equal(fixture.schemaVersion, 4, "fixture schema");
  check(fixture.fixtureClasses.includes("transitive-loaded-file-tamper-rejected"), "tamper fixture class");
  equal(runner.FINDING_ID, "stakewise-v3-current-deployment-state-diagnostic-r4", "finding id");
  equal(runner.CAPTURE_FLAG, "--capture-stakewise-mainnet-r4-once", "capture flag");
  check(runner.ROLE_KEYS.includes("LegacyPoolEscrow"), "legacy pool role");

  const stamp = new Date().toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
  const runId = `swv3diag4-${stamp}-${"a".repeat(32)}`;
  equal(runner.parseArgs(["node", "runner", "--check-only"]).checkOnly, true, "check-only args");
  equal(runner.parseArgs(["node", "runner", runner.CAPTURE_FLAG, "--run-id", runId]).runId, runId, "capture args");
  assert.throws(() => runner.parseArgs(["node", "runner", "--capture-stakewise-mainnet-r3-once", "--run-id", runId])); checks += 1;

  const meta = runner.trustedClassification(id("EthMetaVault"), 5n,
    { factoryKey: "MetaVaultFactory", directKey: null }, true, true);
  equal(meta.meta, true, "meta classification");
  equal(runner.stagedReadPlan(meta), { stage: "META_SUBVAULTS", keeper: false, vaultMev: false, subVaults: true }, "meta plan");
  const nonMeta = runner.trustedClassification(id("EthVault"), 5n,
    { factoryKey: "VaultFactory", directKey: null }, true, true);
  equal(runner.stagedReadPlan(nonMeta), { stage: "NON_META_KEEPER_MEV", keeper: true, vaultMev: true, subVaults: false }, "non-meta plan");
  equal(runner.stagedReadPlan({ trusted: false }), { stage: "IDENTITY_ONLY", keeper: false, vaultMev: false, subVaults: false }, "identity-only plan");

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
  equal(preflight.schemaVersion, 4, "preflight schema");
  equal(preflight.correctness.economics, null, "economics null");
  equal(preflight.correctness.applicability, null, "applicability null");
  equal(preflight.correctness.exactAffectedSemantics, null, "semantics null");
  equal(preflight.gates.deploymentApplicabilityCandidate, null, "candidate null");
  equal(preflight.gates.routePositive, null, "route null");

  const source = fs.readFileSync(path.join(__dirname, "critical-stakewise-v3-mainnet-deployment-economics-successor-r4-runner.js"), "utf8");
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

  const ordering = [];
  const failure = await runner.runCapture({ runId }, {
    verifyRuntimeBeforeInventory() { ordering.push("runtime"); },
    loadManifest() { ordering.push("manifest"); return {}; },
    loadInventory() { ordering.push("inventory"); return []; },
    async qualify() { ordering.push("qualify"); return { selected: null, attemptedFamilyCount: 0, qualifyingFamilyCount: 0 }; },
    writeOutput(_path, value) { ordering.push("write"); return value; }, outputPath: "unused"
  });
  equal(ordering, ["runtime", "manifest", "inventory", "qualify", "write"], "runtime verification precedes inventory");
  equal(failure.reasonCode, "NO_CHAIN1_FINALIZED_FAMILY", "offline capture failure reason");
  equal(failure.gates.deploymentApplicabilityCandidate, null, "failure candidate null");
  let inventoryRead = false;
  const runtimeFailure = await runner.runCapture({ runId }, {
    verifyRuntimeBeforeInventory() { throw new Error("DEPENDENCY_FILE_MISMATCH"); },
    loadInventory() { inventoryRead = true; return []; }, writeOutput() {}, outputPath: "unused"
  });
  equal(inventoryRead, false, "tamper stops before inventory");
  equal(runtimeFailure.reasonCode, "DEPENDENCY_FILE_MISMATCH", "tamper reason preserved");

  equal(preflight.networkReads, 0, "test preflight network reads");
  equal(preflight.inventoryReads, 0, "test preflight inventory reads");
  process.stdout.write(`stakewise successor r4 tests passed: ${checks} checks, ${fixture.fixtureClasses.length} fixture classes, zero network/inventory reads\n`);
}

main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
