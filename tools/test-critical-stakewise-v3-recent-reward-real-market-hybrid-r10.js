"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Interface, id } = require("./node_modules/ethers");
const runner = require("./critical-stakewise-v3-recent-reward-real-market-hybrid-r10-runner");

const ROOT = path.resolve(__dirname, "..");
const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, ...runner.FIXTURE_REL.split("/")), "utf8"));
let checks = 0;
function equal(actual, expected, message) { assert.deepStrictEqual(actual, expected, message); checks += 1; }
function check(value, message) { assert.ok(value, message); checks += 1; }
function independentPackageAggregate(value) {
  const records = [...(value.artifacts || []).map((row) => `artifacts:${row.path}:${row.sha256}`),
    ...(value.runtimeDependencyGraph || []).map((row) => `runtime:${row.path}:${row.sha256}`),
    ...(value.localInputs || []).map((row) => `localInputs:${row.path}:${row.sha256}`)];
  return crypto.createHash("sha256").update(records.sort().join("\n")).digest("hex");
}
function context() { return { caps: runner.CAPS, budget: new runner.Budget(runner.CAPS, () => 0),
  accounting: new runner.Accounting(), nextId: 0, missingRequiredFields: [], missingReadReasons: {}, reasonCode: null }; }
function stream(text) { const bytes = Buffer.from(text); let sent = false; return { getReader() { return {
  async read() { if (sent) return { done: true }; sent = true; return { done: false, value: bytes }; }, async cancel() {} }; } }; }

async function main() {
  equal(fixture.schemaVersion, 10, "fixture schema");
  equal(runner.FINDING_ID, "stakewise-v3-genesis-recent-reward-real-market-hybrid-r10", "finding id");
  equal(runner.CAPTURE_FLAG, "--capture-stakewise-genesis-hybrid-r10-once", "capture flag");
  const stamp = new Date().toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
  const runId = `swv3hybrid10-${stamp}-${"a".repeat(32)}`;
  equal(runner.parseArgs(["node", "runner", runner.CAPTURE_FLAG, "--run-id", runId]).runId, runId, "fresh command");

  const descriptors = runner.parseInventoryText("[Ethereum]\nrpc=https:\\/\\/a.example\\/rpc [header: X-Key=v]\nrpc=https://a.example/rpc [header: X-Key=v]");
  equal(descriptors.length, 1, "R7 descriptor normalization and exact dedupe");
  equal(Object.keys(descriptors[0]), ["url", "headers", "family"], "process-only descriptor shape");
  assert.throws(() => runner.sanitizeOutput({ endpoint: descriptors[0] }), /PROVIDER_MATERIAL_IN_OUTPUT/u); checks += 1;

  equal(runner.OSETH_WETH_POOL_ID, "0xdacf5fa19b1f720111609043ac67a9818262850c000000000000000000000635", "official pool id");
  equal(runner.BALANCER_VAULT, "0xba12222222228d8ba445958a75a0704d566bf2c8", "Balancer vault");
  equal(runner.D_GRID, [1n, 10n, 100n, 1000n, 10000n].map((x) => x * runner.WAD), "deposit grid");

  const rewardAbi = new Interface(["event RewardsUpdated(address indexed caller,bytes32 indexed rewardsRoot,uint256 avgRewardPerSecond,uint64 updateTimestamp,uint64 nonce,string rewardsIpfsHash)"]);
  const keeper = "0x2222222222222222222222222222222222222222";
  const currentRoot = `0x${"3".repeat(64)}`; const previousRoot = `0x${"4".repeat(64)}`;
  function eventLog(root, nonce, block, index, cid) { const event = rewardAbi.encodeEventLog(rewardAbi.getEvent("RewardsUpdated"),
    [fixture.genesis, root, 1n, 2n, nonce, cid]); return { address: keeper, topics: event.topics, data: event.data,
    blockNumber: `0x${block.toString(16)}`, transactionIndex: "0x0", logIndex: `0x${index.toString(16)}`,
    blockHash: `0x${"5".repeat(64)}`, transactionHash: `0x${"6".repeat(64)}`, removed: false }; }
  const currentLog = eventLog(currentRoot, 9n, 100000, 1, "c".repeat(32));
  const previousLog = eventLog(previousRoot, 8n, 99999, 0, "p".repeat(32));
  const logContext = context(); let chunks = 0;
  logContext.rpcRequest = async (_target, method, params) => { equal(method, "eth_getLogs", "logs method only"); chunks += 1;
    const from = BigInt(params[0].fromBlock); const to = BigInt(params[0].toBlock); const rows = [];
    if (99999n >= from && 99999n <= to) rows.push(previousLog);
    if (100000n >= from && 100000n <= to) rows.push(currentLog);
    return { ok: true, result: rows }; };
  const events = await runner.recentRewardEvents({}, keeper, 100000n, logContext, "families.0.rewardLogs");
  equal(chunks, 20, "100k lookback uses 20 five-thousand-block chunks");
  equal(events.length, 2, "strict reward events decoded");
  const aligned = runner.alignedRewardEvents(events, { rewardsRoot: currentRoot, prevRewardsRoot: previousRoot,
    rewardsNonce: 10n }, logContext, "families.0.rewardEvents");
  equal(aligned.current.cid, "c".repeat(32), "current CID aligned");
  equal(aligned.previous.cid, "p".repeat(32), "previous CID aligned");
  const failedLogsContext = context(); failedLogsContext.rpcRequest = async () => ({ ok: false, reason: "HTTP_5XX", result: null });
  equal(await runner.recentRewardEvents({}, keeper, 100000n, failedLogsContext, "families.1.rewardLogs"), null,
    "provider log error is incomplete");
  check(failedLogsContext.missingRequiredFields.includes("families.1.rewardLogs"), "log failure path recorded");

  const fetchContext = context(); let fetchedUrl = null;
  const fetched = await runner.fetchDataset("z".repeat(32), fetchContext, async (url, options) => {
    fetchedUrl = url; equal(options.redirect, "error", "dataset redirect rejected");
    return { status: 200, redirected: false, body: stream('{"ok":true}') };
  });
  equal(fetchedUrl, `https://ipfs.stakewise.io/ipfs/${"z".repeat(32)}`, "official gateway exact");
  equal(fetched.available, true, "bounded dataset fetched");

  const leaf = runner.standardLeaf(fixture.genesis, 120n, 12n);
  const dataset = { format: "standard-v1", leafEncoding: ["address", "int160", "uint160"], tree: [leaf],
    values: [{ value: [fixture.genesis, "120", "12"], treeIndex: 0 }] };
  const parsed = runner.parseRewardsDataset(dataset, [leaf, previousRoot], [fixture.genesis],
    new Map([[fixture.genesis, { rewardAssets: 100n, unlockedMevAssets: 10n }]]));
  equal(parsed.verified, true, "R3 complete StandardMerkleTree validation reused");
  equal(parsed.rows.get(fixture.genesis).reward, 120n, "Genesis proof row");

  const capture = { state: { totalAssets: 1000n, totalShares: 1000n, capacity: 5000n, feePercent: 1000n },
    keeper: { rewards: { assets: 100n, nonce: 4n }, unlocked: { assets: 10n, nonce: 4n } },
    controller: { totalAssets: 1000n, totalShares: 1000n },
    ltvConfig: { ltvPercent: 500000000000000000n } };
  const proof = { reward: 120n, unlockedMevReward: 12n };
  const cell = runner.modelDepositCell(capture, proof, 100n);
  equal(cell.depositShares, 100n, "exact vault share mint");
  equal(cell.feeAssets, 2n, "fee asset floor");
  equal(cell.feeShares, 1n, "fee share floor");
  equal(cell.maxOsTokenAssets, 50n, "LTV asset math");
  equal(cell.modelExact, false, "post-harvest model explicitly non-exact");
  equal(cell.blockers, runner.MODEL_BLOCKERS, "private donation and exit-transition blockers exposed");
  equal(runner.modelDepositCell(capture, proof, 5000n), null, "capacity gate");
  const sensitivityCell = runner.gatedModelDepositCell(capture, proof, 100n);
  equal(runner.controllerRawReadsComplete({ capacity: 5000n, totalAssets: 1000n, totalShares: 1000n,
    headroomExact: null, executionEligibility: null }), true,
  "complete raw controller reads tolerate intentional policy nulls");
  equal(runner.controllerRawReadsComplete({ capacity: null, totalAssets: 1000n, totalShares: 1000n,
    headroomExact: null, executionEligibility: null }), false, "missing raw controller capacity is incomplete");
  equal(sensitivityCell.controllerEligibility, null, "controller execution eligibility unknown");
  equal(sensitivityCell.headroomExact, null, "controller exact headroom unknown");
  equal(sensitivityCell.routeEligibility, null, "route eligibility unknown");
  check(runner.MODEL_BLOCKERS.includes("CONTROLLER_EXECUTION_HEADROOM_UNKNOWN"),
    "accrued-treasury controller blocker explicit");
  const settled = runner.settleModelCell(100n, cell, { osTokenShares: 50n, osTokenDebtAssets: 51n, proceeds: 200n }, { flashloanPremiumTotal: 100n },
    capture.controller, false);
  equal(settled.marketSensitivity.quoteWethProceeds, 200n, "DEX quote retained as sensitivity only");
  equal(settled.eligible, null, "route eligibility is not asserted");
  equal(settled.economics, null, "per-cell economics null");
  equal(settled.currentExecutable, false, "already-harvested state is not executable");
  equal(settled.gasCost, null, "gas remains null");
  equal(settled.conservativeNet, null, "conservative net remains null");
  equal(settled.routePositive, null, "route positive never true without exact gas");

  const quoteContext = context(); quoteContext.decodedCall = async ({ fragment, args }) => {
    if (fragment === "convertToShares") return [50n];
    if (fragment === "convertToAssets") return [51n];
    equal(fragment, "queryBatchSwap", "Balancer query function");
    equal(args[0], 0, "GIVEN_IN quote");
    return [[BigInt(args[1][0].amount), -95n]];
  };
  const quote = await runner.quoteHybridFamily({}, { roles: { OsToken: fixture.genesis } }, 1n, quoteContext,
    "families.0", [cell], { tokens: [fixture.genesis, runner.WETH], osIndex: 0, wethIndex: 1 });
  equal(quote, [{ osTokenShares: 50n, osTokenDebtAssets: 51n, proceeds: 95n }],
    "exact controller conversions and osETH sale proceeds decoded");
  equal(quoteContext.missingRequiredFields, [], "quote complete");
  equal(runner.requiredQuoteCellsComplete([cell], [[null], [null]]), false,
    "matching null quote cells cannot satisfy completeness");
  equal(runner.requiredQuoteCellsComplete([cell], [quote, quote]), true, "dual non-null quote cells complete");

  for (const [name, deltas, pool] of [
    ["input mismatch", [49n, -95n], { tokens: [fixture.genesis, runner.WETH], osIndex: 0, wethIndex: 1 }],
    ["nonnegative output", [50n, 0n], { tokens: [fixture.genesis, runner.WETH], osIndex: 0, wethIndex: 1 }],
    ["unrelated nonzero", [50n, -95n, 1n], { tokens: [fixture.genesis, runner.WETH,
      "0x3333333333333333333333333333333333333333"], osIndex: 0, wethIndex: 1 }]
  ]) {
    const badContext = context(); badContext.decodedCall = async ({ fragment }) => fragment === "convertToShares" ? [50n] :
      fragment === "convertToAssets" ? [51n] : [deltas];
    equal(await runner.quoteHybridFamily({}, { roles: { OsToken: fixture.genesis,
      OsTokenVaultController: "0x4444444444444444444444444444444444444444" } }, 1n, badContext,
    "families.0", [cell], pool), [null], `Balancer rejects ${name}`);
    check(badContext.missingRequiredFields.includes("families.0.quotes.0"), `${name} missing path`);
  }

  const activeConfig = (1n << 56n) | (1n << 63n);
  equal(runner.deriveAaveReserveState(activeConfig, 1000n, 9n).flashEligibility, null,
    "Aave eligibility unknown without implementation binding");
  equal(runner.deriveAaveReserveState(activeConfig, 1000n, 9n).diagnosticConfigurationConditionsMet, true,
    "Aave configuration conditions are diagnostic only");
  equal(runner.deriveAaveReserveState(activeConfig | (1n << 60n), 1000n, 9n).diagnosticConfigurationConditionsMet, false,
    "Aave paused diagnostic condition observed");
  equal(runner.deriveAaveReserveState(activeConfig & ~(1n << 63n), 1000n, 9n).flashEligibility, null,
    "Aave flash-disabled observation still makes no eligibility claim");
  equal(runner.deriveAaveReserveState(null, null, 9n).flashEligible, null,
    "Aave unavailable reserve eligibility null");
  const reserveTuple = [activeConfig, 1n, 2n, 3n, 4n, 5n, 6n, 7n,
    "0x5555555555555555555555555555555555555555", "0x6666666666666666666666666666666666666666",
    "0x7777777777777777777777777777777777777777", "0x8888888888888888888888888888888888888888",
    9n, 10n, 11n];
  equal(runner.decodeAaveReserveData([reserveTuple]), { configuration: activeConfig,
    aTokenAddress: "0x5555555555555555555555555555555555555555", lastUpdateTimestamp: 6n,
    reserveId: 7n, accruedToTreasury: 9n, unbacked: 10n, isolationModeTotalDebt: 11n },
  "Aave 15-field ReserveDataLegacy exact tuple decode");
  equal(runner.decodeAaveReserveData([[...reserveTuple, 12n]]), null, "non-legacy reserve tuple rejected");
  const unavailableAave = runner.settleModelCell(100n, cell,
    { osTokenShares: 50n, osTokenDebtAssets: 51n, proceeds: 200n }, null, capture.controller, true);
  equal(unavailableAave.eligible, null, "Aave unavailable makes no route eligibility claim");
  equal(unavailableAave.routePositive, null, "Aave unavailable leaves route output null");
  equal(unavailableAave.currentExecutable, null, "current executable is not false unless one-behind is false");

  const non2xxContext = context(); let publicCanceled = 0; let publicRead = 0;
  const non2xx = await runner.fetchDataset("q".repeat(32), non2xxContext, async () => ({ status: 503,
    redirected: false, body: { async cancel() { publicCanceled += 1; }, getReader() { publicRead += 1; } } }));
  equal(non2xx.reason, "PUBLIC_GET_HTTP_FAILURE", "public non2xx sanitized");
  equal(publicCanceled, 1, "public non2xx body canceled");
  equal(publicRead, 0, "public non2xx body not read");

  const preflight = runner.dryPreflight();
  equal(preflight.schemaVersion, 10, "preflight schema");
  equal(preflight.correctness.gasCost, null, "gas placeholder null");
  equal(preflight.correctness.conservativeNet, null, "conservative net null");
  equal(preflight.correctness.genesisVersionRequired, 5, "Genesis version 5 required");
  equal(preflight.correctness.aaveImplementationBinding, "UNKNOWN", "Aave implementation binding downgraded");
  equal(preflight.correctness.controllerHeadroomExact, null, "controller headroom exactness null");
  equal(preflight.gates.routePositive, null, "route positive null");
  equal(preflight.gates.promotable, false, "nonpromotable");

  const graph = runner.loadedDependencyGraph(); const local = runner.fileRecords(runner.LOCAL_INPUT_RELS);
  check(graph.length > 20, "runtime graph populated");
  equal(runner.verifyDependencyGraph(graph), true, "runtime graph verifies");
  equal(runner.verifyFileRecords(local, runner.LOCAL_INPUT_RELS), true, "local inputs verify");
  for (const requiredSource of ["VaultState.sol", "VaultEnterExit.sol", "VaultOsToken.sol", "VaultMev.sol",
    "OsTokenVaultController.sol", "ReserveConfiguration.sol", "FlashLoanLogic.sol", "IBalancerVault.sol"]) {
    check(runner.LOCAL_INPUT_RELS.some((item) => item.endsWith(requiredSource)), `${requiredSource} bound`);
  }
  const artifacts = runner.fileRecords(runner.REQUIRED_ARTIFACT_PATHS);
  equal(runner.assertArtifactPathSet(artifacts), true, "artifact paths exact");
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, ...runner.MANIFEST_REL.split("/")), "utf8"));
  equal(independentPackageAggregate(manifest), manifest.aggregateSha256, "aggregate independently recomputed");
  const tampered = JSON.parse(JSON.stringify(manifest)); tampered.artifacts[0].sha256 = "0".repeat(64);
  check(independentPackageAggregate(tampered) !== tampered.aggregateSha256, "independent aggregate catches mismatch");
  equal(preflight.networkReads, 0, "no implementation network reads");
  equal(preflight.inventoryReads, 0, "no implementation inventory reads");
  process.stdout.write(`stakewise hybrid r10 tests passed: ${checks} checks, ${fixture.fixtureClasses.length} fixture classes, zero network/inventory reads\n`);
}

main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
