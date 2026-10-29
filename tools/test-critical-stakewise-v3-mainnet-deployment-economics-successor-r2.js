#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Interface, id } = require("ethers");
const runner = require("./critical-stakewise-v3-mainnet-deployment-economics-successor-r2-runner.js");

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures",
  "critical-stakewise-v3-mainnet-deployment-economics-successor-r2-fixtures.json"), "utf8"));
let checks = 0;
function equal(actual, expected, message) { checks += 1; assert.deepStrictEqual(actual, expected, `check ${checks}: ${message}`); }
function check(value, message) { checks += 1; assert.ok(value, `check ${checks}: ${message}`); }
function throws(fn, code, message) { checks += 1; assert.throws(fn, new RegExp(code, "u"), `check ${checks}: ${message}`); }
async function rejects(fn, code, message) { checks += 1; await assert.rejects(fn, new RegExp(code, "u"), `check ${checks}: ${message}`); }

function response(body, status = 200) {
  let done = false;
  return { status, redirected: false, body: { getReader: () => ({
    read: async () => done ? { done: true } : (done = true, { done: false, value: Buffer.from(body) }),
    cancel: async () => {}
  }) } };
}
function context(caps = runner.CAPS) {
  return { caps, budget: new runner.Budget(caps), accounting: new runner.Accounting(), nextId: 0, missingRequiredFields: [] };
}
function treeDataset(rows) {
  const leaves = rows.map((row) => runner.standardLeaf(row[0], row[1], row[2]));
  if (leaves.length !== 2) throw new Error("fixture requires two leaves");
  const root = runner.hashPair(leaves[0], leaves[1]);
  return { root, value: { format: "standard-v1", leafEncoding: ["address", "int160", "uint160"],
    tree: [root, leaves[0], leaves[1]], values: [
      { value: rows[0].map(String), treeIndex: 1 }, { value: rows[1].map(String), treeIndex: 2 }
    ] } };
}

async function main() {
  equal(fixture.fixtureClasses.length, 47, "all R2 blocker fixtures listed");
  check(runner.PREFIX.endsWith("-r2") && runner.reused.r1.PREFIX !== runner.PREFIX, "R1 preserved and R2 distinct");
  const now = Date.parse("2026-08-15T12:00:00Z");
  const runId = "swv3econr2-20260815T115900Z-0123456789abcdef0123456789abcdef";
  equal(runner.parseArgs(["node", "r2", runner.CAPTURE_FLAG, "--run-id", runId], now).runId, runId, "exact R2 command");
  throws(() => runner.parseArgs(["node", "r2", "--capture-stakewise-mainnet-once", "--run-id", runId], now),
    "EXACT_R2_FLAG", "R1 flag rejected");
  equal(runner.CAPS.retriesPerRequest, 0, "no retry");

  const accounting = new runner.Accounting();
  accounting.start("eth_call"); accounting.finish("eth_call", "failed", "SYNTHETIC_FAILURE");
  equal(accounting.snapshot().methods.eth_call, { attempted: 1, succeeded: 0, failed: 1, canceled: 0 }, "per-method counters");
  equal(accounting.snapshot().reasons.SYNTHETIC_FAILURE, 1, "reason counter");
  equal(accounting.snapshot().counterEquationValid, true, "counter equation");

  const rpcContext = context();
  const group = new runner.RequestGroup(rpcContext.accounting);
  const rpc = await runner.rpcRequest({ url: "mock://r2" }, "eth_chainId", [], rpcContext, group,
    async () => response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" })));
  await group.settle();
  equal([rpc.ok, rpcContext.accounting.snapshot().methods.eth_chainId.succeeded,
    rpcContext.accounting.snapshot().allStartedSettled], [true, 1, true], "RPC settles and counts");

  const cancelContext = context();
  await rejects(() => runner.requiredBatch({
    membership: async () => null,
    slow: async (requestGroup) => {
      const controller = new AbortController();
      const promise = new Promise((resolve) => controller.signal.addEventListener("abort", () => resolve(null), { once: true }));
      requestGroup.track(controller, promise); return promise;
    }
  }, cancelContext), "REQUIRED_membership_MISSING", "required membership null fatal");
  const canceled = cancelContext.accounting.snapshot();
  equal([canceled.allStartedSettled, canceled.concurrentStarted, canceled.concurrentSettled], [true, 1, 1], "concurrent work canceled and settled");
  check(canceled.cancelSignals >= 1, "cancellation accounted");
  equal(cancelContext.missingRequiredFields.sort(), ["membership", "slow"], "required-field completeness names all missing fields");

  const header = { number: 25000000n, hash: `0x${"aa".repeat(32)}`, timestamp: 123n };
  const selected = runner.choosePin([{ family: "F1", chainId: 1, header }, { family: "F2", chainId: 1, header }]);
  equal([selected.mode, selected.hostnameConsensus, selected.backendIndependenceProven, selected.promotable],
    ["HOSTNAME_CONSENSUS_DIAGNOSTIC", true, false, false], "hostname consensus nonpromotable");
  equal(runner.choosePin([{ family: "F1", chainId: 1, header }]).mode, "SINGLE_FAMILY_DIAGNOSTIC", "single-family diagnostic");

  const rows = [[fixture.vaultA, 120n, 10n], [fixture.vaultB, -5n, 0n]];
  const built = treeDataset(rows);
  const stored = new Map([[fixture.vaultA, { rewardAssets: 20n, unlockedMevAssets: 5n }],
    [fixture.vaultB, { rewardAssets: 0n, unlockedMevAssets: 0n }]]);
  const parsed = runner.parseRewardsDataset(built.value, [built.root, `0x${"bb".repeat(32)}`],
    [fixture.vaultA, fixture.vaultB], stored);
  equal([parsed.verified, parsed.rows.size, parsed.rows.get(fixture.vaultA).proof.length], [true, 2, 1], "standard tree proofs verified");
  equal(parsed.rows.get(fixture.vaultA).rootKind, "CURRENT", "current root marked");
  const previous = runner.parseRewardsDataset(built.value, [`0x${"bb".repeat(32)}`, built.root], [fixture.vaultA], stored);
  equal(previous.rows.get(fixture.vaultA).rootKind, "PREVIOUS", "previous root marked diagnostic");
  equal(runner.parseRewardsDataset({ ...built.value, format: "other" }, [built.root], [], new Map()).reason,
    "STANDARD_TREE_SCHEMA_INVALID", "exact schema");
  const duplicate = JSON.parse(JSON.stringify(built.value)); duplicate.values[1].value[0] = duplicate.values[0].value[0];
  equal(runner.parseRewardsDataset(duplicate, [built.root], [], new Map()).reason, "TREE_DUPLICATE_REJECTED", "duplicate address rejected");
  const duplicateIndex = JSON.parse(JSON.stringify(built.value)); duplicateIndex.values[1].treeIndex = 1;
  equal(runner.parseRewardsDataset(duplicateIndex, [built.root], [], new Map()).reason, "TREE_DUPLICATE_REJECTED", "duplicate index rejected");
  const leafMismatch = JSON.parse(JSON.stringify(built.value)); leafMismatch.values[0].value[1] = "121";
  equal(runner.parseRewardsDataset(leafMismatch, [built.root], [], new Map()).reason, "TREE_LEAF_MISMATCH", "leaf mismatch rejected");
  const outOfInt = JSON.parse(JSON.stringify(built.value)); outOfInt.values[0].value[1] = String(runner.INT160_MAX + 1n);
  equal(runner.parseRewardsDataset(outOfInt, [built.root], [], new Map()).reason, "TREE_VALUE_BOUNDS_INVALID", "int160 upper bound");
  const underInt = JSON.parse(JSON.stringify(built.value)); underInt.values[0].value[1] = String(runner.INT160_MIN - 1n);
  equal(runner.parseRewardsDataset(underInt, [built.root], [], new Map()).reason, "TREE_VALUE_BOUNDS_INVALID", "int160 lower bound");
  const overUint = JSON.parse(JSON.stringify(built.value)); overUint.values[0].value[2] = String(runner.UINT160_MAX + 1n);
  equal(runner.parseRewardsDataset(overUint, [built.root], [], new Map()).reason, "TREE_VALUE_BOUNDS_INVALID", "uint160 bound");
  const nonmonotonicStored = new Map(stored); nonmonotonicStored.set(fixture.vaultA, { rewardAssets: 0n, unlockedMevAssets: 11n });
  equal(runner.parseRewardsDataset(built.value, [built.root], [fixture.vaultA], nonmonotonicStored).reason,
    "UNLOCKED_MEV_NONMONOTONIC", "unlocked MEV monotonicity");

  const vaultBase = { classification: { trusted: true, ownMevUnsupported: false }, access: "PUBLIC", registryMember: true,
    implementationRegistryMember: true, capacity: 200n, totalAssets: 100n, feePercent: 1000n, rewardAssets: 20n,
    unlockedMevAssets: 5n, mevEscrowBalance: 10n, queue: { queuedShares: 0n }, withdrawableAssets: 50n,
    canHarvest: true, isHarvestRequired: false, stateUpdateRequired: false, keeperRewardsNonce: 9n,
    mevEscrow: fixture.vaultB, sharedMevEscrow: fixture.vaultB };
  const proof = parsed.rows.get(fixture.vaultA);
  const economics = runner.computeEconomics(vaultBase, proof, 10n);
  equal([economics.rewardDelta, economics.unlockedMevDelta, economics.netRewardDelta], [100n, 5n, 90n],
    "reward delta excludes unlocked MEV");
  equal(economics.unlockedMevCountedAsReward, false, "unlocked MEV gate only");
  equal([economics.oneBehindExposure, economics.deploymentApplicabilityCandidate, economics.routePositive, economics.executableNow],
    [true, true, null, null], "candidate only and route unknown");
  equal(runner.computeEconomics({ ...vaultBase, stateUpdateRequired: true }, proof, 10n),
    null, "state update required blocks economics");
  equal(runner.evaluateApplicability({ ...vaultBase, keeperRewardsNonce: 8n }, proof, 10n).oneBehindExposure, false,
    "nonce exactly one behind");
  equal(runner.computeEconomics({ ...vaultBase, mevEscrowBalance: 4n }, proof, 10n), null, "unlocked MEV liquidity gate");
  equal(runner.evaluateApplicability({ ...vaultBase, mevEscrow: fixture.vaultA }, proof, 10n).ownMevUnsupported,
    true, "own MEV unsupported");
  equal(runner.computeEconomics({ ...vaultBase, mevEscrow: fixture.vaultA }, proof, 10n), null, "own MEV has no economics");
  equal(runner.computeEconomics(vaultBase, null, 10n), null, "dataset row required and economics null");
  equal(runner.computeEconomics(vaultBase, { ...proof, rootKind: "PREVIOUS" }, 10n),
    null, "previous-root row diagnostic only");

  const fox = runner.trustedClassification(id("EthFoxVault"), 2,
    { directKey: "FoxVault", factoryKey: null }, true, true);
  equal([fox.trusted, fox.access, fox.assetMode, fox.ownMevUnsupported, fox.numericVersion],
    [true, "BLOCKLIST", "NATIVE_ETH", true, 2], "Fox corrected");
  const community = runner.trustedClassification(id("EthCommunityVault"), 6,
    { directKey: "CommunityVault", factoryKey: null }, true, true);
  equal([community.trusted, community.access, community.assetMode, community.numericVersion],
    [true, "PUBLIC", "ERC20", 6], "Community corrected and version preserved");
  equal(runner.trustedClassification(id("EthCommunityVault"), 6,
    { directKey: "FoxVault", factoryKey: null }, true, true).trusted, false, "lineage mismatch untrusted");

  check(runner.ROLE_KEYS.includes("OsTokenRedeemer") && runner.ROLE_KEYS.includes("CommunityVault") &&
    runner.ROLE_KEYS.includes("FoxVault") && runner.ROLE_KEYS.includes("GenesisVault"), "all relied roles required");
  const roles = Object.fromEntries(runner.ROLE_KEYS.map((key, index) => [key, `0x${String(index + 1).padStart(40, "0")}`]));
  const integrityValues = Object.fromEntries(runner.ROLE_KEYS.map((key) => [`code_${key}`, true]));
  integrityValues.controllerKeeper = roles.Keeper; integrityValues.configRedeemer = roles.OsTokenRedeemer;
  equal(runner.globalIntegrity(integrityValues, roles), { allRoleCodePresent: true, controllerKeeperMatches: true,
    configRedeemerMatches: true }, "global role/controller/keeper/config/redeemer integrity");
  equal(runner.globalIntegrity({ ...integrityValues, code_Keeper: null }, roles).allRoleCodePresent, false,
    "missing role code breaks integrity");

  const rewardsAbi = new Interface([
    "event RewardsUpdated(address indexed caller,bytes32 indexed rewardsRoot,uint256 avgRewardPerSecond,uint64 updateTimestamp,uint64 nonce,string rewardsIpfsHash)"
  ]);
  const eventLog = (blockNumber, transactionIndex, logIndex, root, nonce, cid) => {
    const encoded = rewardsAbi.encodeEventLog(rewardsAbi.getEvent("RewardsUpdated"),
      [fixture.vaultA, root, 1n, 2n, nonce, cid]);
    return { blockNumber, transactionIndex, logIndex, topics: encoded.topics, data: encoded.data };
  };
  const root1 = `0x${"aa".repeat(32)}`; const root2 = `0x${"bb".repeat(32)}`;
  const latest = runner.orderedRewardsEvent([
    eventLog(11n, 0n, 0n, root2, 9n, "bafybeigdyrzt11111111111111111111"),
    eventLog(10n, 1n, 1n, root1, 8n, "bafybeigdyrzt22222222222222222222")
  ]);
  equal([latest.blockNumber, latest.root, latest.nonce], [11n, root2, 9n], "latest event ordered by block transaction log");
  equal(runner.rewardsEventAligns(latest, { rewardsRoot: root2, rewardsNonce: 10n }), true,
    "latest event aligns current Keeper root and nonce");
  equal(runner.rewardsEventAligns(latest, { rewardsRoot: root1, rewardsNonce: 10n }), false,
    "misaligned Keeper root rejected");

  const runtime = runner.runtimeBinding();
  check(/^v\d+\./u.test(runtime.nodeVersion), "Node version bound");
  equal(runtime.ethersVersion, "6.16.0", "ethers version bound");
  check(runtime.dependencyClosure.length === 9 && runtime.dependencyClosure.every((row) => row.version), "ethers closure bound");

  throws(() => runner.sanitizeOutput({ providerHash: built.root }), "PROVIDER_MATERIAL", "provider hash rejected");
  equal(runner.sanitizeOutput({ publicVaultAddress: fixture.vaultA }).publicVaultAddress, fixture.vaultA, "public address allowed");
  const preflight = runner.dryPreflight();
  equal([preflight.networkReads, preflight.inventoryReads, preflight.writes, preflight.gates.promotable], [0, 0, 0, false],
    "preflight offline and nonpromotable");
  equal(preflight.correctness.routePositiveCanBeTrue, false, "capture cannot assert routePositive");

  const tempParent = path.join(os.tmpdir(), "opencode"); check(fs.existsSync(tempParent), "approved temp parent");
  const temp = fs.mkdtempSync(path.join(tempParent, "swv3-r2-test-"));
  try {
    const output = path.join(temp, "terminal.json"); runner.atomicWrite(output, { terminal: true });
    equal(JSON.parse(fs.readFileSync(output, "utf8")).terminal, true, "atomic output");
    throws(() => runner.atomicWrite(output, { terminal: true }), "EEXIST|EPERM", "one-shot output");
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }

  process.stdout.write(`${JSON.stringify({ status: "PASS", checks, fixtureClasses: fixture.fixtureClasses.length,
    networkReads: 0, inventoryReads: 0, captureExecuted: false })}\n`);
}
main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
