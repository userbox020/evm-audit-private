#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { id } = require("ethers");
const runner = require("./critical-stakewise-v3-mainnet-deployment-economics-successor-r3-runner.js");

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures",
  "critical-stakewise-v3-mainnet-deployment-economics-successor-r3-fixtures.json"), "utf8"));
let checks = 0;
function equal(actual, expected, message) { checks += 1; assert.deepStrictEqual(actual, expected, `check ${checks}: ${message}`); }
function check(value, message) { checks += 1; assert.ok(value, `check ${checks}: ${message}`); }
function throws(fn, code, message) { checks += 1; assert.throws(fn, new RegExp(code, "u"), `check ${checks}: ${message}`); }

function standardTree(rows) {
  const count = rows.length; const tree = new Array(2 * count - 1);
  const values = [];
  for (let index = 0; index < count; index++) {
    const treeIndex = count - 1 + index;
    tree[treeIndex] = runner.standardLeaf(rows[index][0], rows[index][1], rows[index][2]);
    values.push({ value: rows[index].map(String), treeIndex });
  }
  for (let index = count - 2; index >= 0; index--) tree[index] = runner.hashPair(tree[2 * index + 1], tree[2 * index + 2]);
  return { root: tree[0], value: { format: "standard-v1", leafEncoding: ["address", "int160", "uint160"], tree, values } };
}

function baseVault() {
  return { requiredReadsComplete: true, classification: { trusted: true, ownMevUnsupported: false }, access: "PUBLIC",
    meta: false, registryMember: true, implementationRegistryMember: true, totalAssets: 3n, totalShares: 2n,
    currentSupply: 2n, securityShares: 1n, capacity: 103n, feePercent: 5000n, rewardAssets: 0n,
    unlockedMevAssets: 0n, mevEscrowBalance: 100n, nativeBalance: 100n,
    queue: { queuedShares: 0n, unclaimedAssets: 0n, totalExitingAssets: 0n }, withdrawableAssets: 100n,
    canHarvest: true, isHarvestRequired: false, stateUpdateRequired: false, keeperRewardsNonce: 9n,
    mevEscrow: fixture.vaultB, sharedMevEscrow: fixture.vaultB };
}

const completeGates = { allComplete: true, familyAgreement: true, terminalPin: true, datasetComplete: true };

function main() {
  equal(fixture.fixtureClasses.length, 47, "every R3 blocker fixture listed");
  check(runner.PREFIX.endsWith("-r3") && runner.reused.r2.PREFIX.endsWith("-r2"), "R3 distinct and R2 reused unchanged");
  const now = Date.parse("2026-08-15T12:00:00Z");
  const runId = "swv3econr3-20260815T115900Z-0123456789abcdef0123456789abcdef";
  equal(runner.parseArgs(["node", "r3", runner.CAPTURE_FLAG, "--run-id", runId], now).runId, runId, "fresh exact R3 command");
  throws(() => runner.parseArgs(["node", "r3", "--capture-stakewise-mainnet-r2-once", "--run-id", runId], now),
    "EXACT_R3_FLAG", "R2 flag rejected");

  const metaClass = runner.trustedClassification(id("EthMetaVault"), 7,
    { factoryKey: "MetaVaultFactory", directKey: null }, true, true);
  const nonMetaClass = runner.trustedClassification(id("EthVault"), 5,
    { factoryKey: "VaultFactory", directKey: null }, true, true);
  equal(runner.stagedReadPlan(metaClass), { stage: "META_SUBVAULTS", keeper: false, vaultMev: false, subVaults: true },
    "meta skips VaultMev and Keeper and reads sub-vaults");
  equal(runner.stagedReadPlan(nonMetaClass), { stage: "NON_META_KEEPER_MEV", keeper: true, vaultMev: true, subVaults: false },
    "non-meta reads Keeper and VaultMev");
  equal(runner.stagedReadPlan(null).stage, "IDENTITY_ONLY", "untrusted identity does not run wrong ABI stage");

  const rows = [[fixture.vaultA, 2n, 0n], [fixture.vaultB, 3n, 0n], [fixture.vaultC, -1n, 1n]];
  const built = standardTree(rows);
  const stored = new Map(rows.map((row) => [row[0], { rewardAssets: 0n, unlockedMevAssets: 0n }]));
  const parsed = runner.parseRewardsDataset(built.value, [built.root], rows.map((row) => row[0]), stored);
  equal([parsed.verified, parsed.completeForDiscovered, parsed.rows.size], [true, true, 3], "complete tree fully verified");
  equal(parsed.rowCount, 3, "nonempty values count");
  const empty = { format: "standard-v1", leafEncoding: ["address", "int160", "uint160"], tree: [], values: [] };
  equal(runner.parseRewardsDataset(empty, [built.root], [], new Map()).reason, "STANDARD_TREE_SCHEMA_INVALID", "empty values rejected");
  const badLength = JSON.parse(JSON.stringify(built.value)); badLength.tree.pop();
  equal(runner.parseRewardsDataset(badLength, [built.root], [], new Map()).reason, "STANDARD_TREE_SCHEMA_INVALID", "2n-1 required");
  const badIndex = JSON.parse(JSON.stringify(built.value)); badIndex.values[0].treeIndex = 1;
  equal(runner.parseRewardsDataset(badIndex, [built.root], [], new Map()).reason, "TREE_VALUE_SCHEMA_INVALID", "leaf range required");
  const duplicateIndex = JSON.parse(JSON.stringify(built.value)); duplicateIndex.values[1].treeIndex = duplicateIndex.values[0].treeIndex;
  equal(runner.parseRewardsDataset(duplicateIndex, [built.root], [], new Map()).reason, "TREE_DUPLICATE_REJECTED", "unique coverage");
  const badLeaf = JSON.parse(JSON.stringify(built.value)); badLeaf.values[0].value[1] = "99";
  equal(runner.parseRewardsDataset(badLeaf, [built.root], [], new Map()).reason, "TREE_LEAF_MISMATCH", "every leaf recomputed");
  const badParent = JSON.parse(JSON.stringify(built.value)); badParent.tree[1] = `0x${"dd".repeat(32)}`;
  equal(runner.parseRewardsDataset(badParent, [badParent.tree[0]], [], new Map()).reason, "TREE_PARENT_RECOMPUTE_MISMATCH",
    "every internal parent and root recomputed");
  const extraKey = JSON.parse(JSON.stringify(built.value)); extraKey.other = true;
  equal(runner.parseRewardsDataset(extraKey, [built.root], [], new Map()).reason, "STANDARD_TREE_SCHEMA_INVALID", "schema exact");
  const missing = runner.parseRewardsDataset(built.value, [built.root], [...rows.map((row) => row[0]),
    "0x4444444444444444444444444444444444444444"], stored);
  equal([missing.verified, missing.completeForDiscovered, missing.reason, missing.missingDiscoveredVaults.length],
    [true, false, "DISCOVERED_VAULT_ROWS_MISSING", 1], "missing discovered row is incomplete/unknown, not false");

  equal(runner.ceilDiv(2n, 3n), 1n, "one-wei ceil edge");
  const proof = parsed.rows.get(fixture.vaultA);
  const vault = baseVault();
  const cell = runner.exactContractCell(vault, proof, 1n);
  equal([cell.depositSharesCeil, cell.feeAssetsFloor, cell.feeSharesFloor], [1n, 1n, 0n],
    "ceil deposit and fee floors exact");
  equal([cell.assetsAfterReward, cell.sharesAfterReward, cell.queueConversionAssetsFloor], [6n, 3n, 2n],
    "post-reward conversion floor exact");
  equal([cell.checkpointBurnedSharesFloor, cell.attackerBurnedShares, cell.attackerCheckpointAssetsFloor,
    cell.exactAssetDelta], [1n, 1n, 2n, 1n], "queue and attacker checkpoint floors exact");
  equal([cell.currentSupply, cell.securityShares], [2n, 1n], "current supply and security shares retained");
  const feeEdge = runner.exactContractCell({ ...vault, feePercent: 9999n }, { ...proof, reward: 1n }, 1n);
  equal([feeEdge.feeAssetsFloor, feeEdge.feeSharesFloor], [0n, 0n], "one-wei fee edge floors zero");
  const queueEdge = runner.exactContractCell({ ...vault, nativeBalance: 0n,
    queue: { ...vault.queue, totalExitingAssets: 2n } }, proof, 1n);
  equal([queueEdge.checkpointAssetsFloor, queueEdge.checkpointBurnedSharesFloor], [0n, 0n], "one-wei queue liquidity edge");

  const economics = runner.computeEconomics(vault, proof, 10n, completeGates, [100, 10000]);
  check(economics && economics.model === "EXACT_INTEGER_MODEL_WHEN_ALL_INPUTS_EXACT", "exact model labelled only when exact");
  equal(economics.sweep.length, 2, "bounded D sweep");
  equal([economics.currentSupply, economics.securityShares, economics.routePositive, economics.executableNow],
    [2n, 1n, null, null], "exact economics retains supply and operational gates unknown");
  equal(runner.computeEconomics({ ...vault, securityShares: null }, proof, 10n, completeGates), null, "missing model input nulls economics");
  equal(runner.computeEconomics({ ...vault, meta: true }, proof, 10n, completeGates), null, "meta economics null");

  equal(runner.evaluateApplicability(vault, proof, 10n, { ...completeGates, allComplete: false }), null,
    "allComplete missing makes applicability null");
  equal(runner.evaluateApplicability(vault, proof, 10n, { ...completeGates, familyAgreement: false }), null,
    "family mismatch makes applicability null");
  equal(runner.evaluateApplicability(vault, proof, 10n, { ...completeGates, terminalPin: false }), null,
    "terminal mismatch makes applicability null");
  equal(runner.evaluateApplicability(vault, proof, 10n, { ...completeGates, datasetComplete: false }), null,
    "dataset incomplete makes applicability null");
  equal(runner.evaluateApplicability({ ...vault, requiredReadsComplete: false }, proof, 10n, completeGates), null,
    "required read incomplete makes applicability null");
  equal(runner.computeEconomics(vault, null, 10n, { ...completeGates, datasetComplete: false }), null,
    "missing row cannot become false economics");

  const runtime = runner.runtimeBinding();
  equal(runtime.loadedEntry.path, "node_modules/ethers/lib.commonjs/index.js", "actual loaded ethers entry bound");
  check(runtime.loadedEntry.bytes > 0 && /^[0-9a-f]{64}$/u.test(runtime.loadedEntry.sha256), "loaded entry file record exact");
  check(runtime.dependencyClosure.every((row) => row.integrity && row.packageJsonPath), "lock integrity closure bound");
  for (const productionFile of ["VaultImmutables.sol", "VaultEnterExit.sol", "VaultFee.sol", "SubVaultsRegistry.sol",
    "VaultMev.sol", "SharedMevEscrow.sol"]) {
    const matches = productionFile === "SharedMevEscrow.sol"
      ? path.join(__dirname, "..", "targets", "stakewise-v3-core-v5.0.1", "contracts", "vaults", "ethereum", "mev", productionFile)
      : productionFile === "SubVaultsRegistry.sol"
        ? path.join(__dirname, "..", "targets", "stakewise-v3-core-v5.0.1", "contracts", "vaults", productionFile)
        : path.join(__dirname, "..", "targets", "stakewise-v3-core-v5.0.1", "contracts", "vaults", "modules", productionFile);
    check(fs.existsSync(matches), `${productionFile} relied production source exists`);
  }
  const preflight = runner.dryPreflight();
  equal([preflight.networkReads, preflight.inventoryReads, preflight.writes], [0, 0, 0], "no implementation capture");
  equal([preflight.correctness.stagedTypeAwareReads, preflight.correctness.datasetCompleteCoverageRequired,
    preflight.correctness.exactIntegerEconomicsOrNull], [true, true, true], "R3 blocker declarations");

  const tempParent = path.join(os.tmpdir(), "opencode"); check(fs.existsSync(tempParent), "approved temp parent");
  const temp = fs.mkdtempSync(path.join(tempParent, "swv3-r3-test-"));
  try {
    const output = path.join(temp, "terminal.json"); runner.atomicWrite(output, { terminal: true });
    equal(JSON.parse(fs.readFileSync(output, "utf8")).terminal, true, "atomic terminal output");
    throws(() => runner.atomicWrite(output, { terminal: true }), "EEXIST|EPERM", "one-shot output cannot overwrite");
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }

  process.stdout.write(`${JSON.stringify({ status: "PASS", checks, fixtureClasses: fixture.fixtureClasses.length,
    networkReads: 0, inventoryReads: 0, captureExecuted: false })}\n`);
}

try { main(); } catch (error) { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; }
