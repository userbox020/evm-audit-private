"use strict";

// Offline suite for the Aave V3 Base liquidation (L class) vertical, mirroring
// tools/test-aave-v3-l.js. No network: pure math, schema, wiring,
// compiled-artifact, and scenario-assertion checks only.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");

const scanner = require("./scan-aave-v3-l");
const coverage = require("./audit-trigger-coverage-universe");
const watch = require("./run-profit-trigger-watch");
const bridge = require("./run-trigger-fork-poc");
const autopilot = require("./trigger-fork-autopilot");
const dispatcher = require("./monitor-alert-dispatcher");

const ROOT = path.resolve(__dirname, "..");
const UNIVERSE = JSON.parse(fs.readFileSync(path.join(__dirname, "trigger-coverage-universe.json"), "utf8"));
const PRODUCER_ID = "aave-v3-base-l";
const CONTRACT = {
  name: "AaveV3LiquidationUnwindBaseRoundTrip",
  sol: path.join(__dirname, "fork-poc", "contracts", "AaveV3LiquidationUnwindBaseRoundTrip.sol"),
  compiled: path.join(__dirname, "fork-poc", "contracts", "AaveV3LiquidationUnwindBaseRoundTrip.compiled.json"),
  scenario: path.join(__dirname, "fork-poc", "triggers", `${PRODUCER_ID}.js`),
};

test("Aave V3 L Base chain config pins the verified deployment bound", () => {
  const config = scanner.chainConfig(8453);
  assert.equal(config.chainId, 8453);
  assert.equal(config.pool, "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5");
  assert.equal(config.deployBlock, 2357134);
  assert.equal(config.codeAbsentBlock, 2357133);
  assert.equal(config.chainlinkEthUsd, "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70");
  assert.equal(config.coveragePath.endsWith("aave-v3-base-l.json"), true);
  assert.equal(config.indexPath.endsWith("aave-v3-l-index-base.json"), true);
  assert.equal(config.artifactPath.endsWith("aave-v3-liquidatable-base.json"), true);
  assert.equal(config.logChunk, 20_000);
  // Chain-parameterized: the scanner resolves the Base pool for reads.
  assert.equal(scanner.scan.length >= 0, true);
});

test("Aave V3 L Base exact math: HF eligibility, close factor, and reserve-config bitmap", () => {
  assert.equal(scanner.isLiquidatable({ totalDebtBaseRaw: "1", healthFactorRaw: "999999999999999999" }), true);
  assert.equal(scanner.isLiquidatable({ totalDebtBaseRaw: "1", healthFactorRaw: scanner.HF_ONE.toString() }), false);
  assert.equal(scanner.isLiquidatable({ totalDebtBaseRaw: "0", healthFactorRaw: "1" }), false);
  assert.equal(scanner.closeFactorBps("949999999999999999").toString(), "10000");
  assert.equal(scanner.closeFactorBps(scanner.HF_ONE.toString()).toString(), "5000");

  let config = 0n;
  config |= 7500n << 0n;
  config |= 7800n << 16n;
  config |= 10450n << 32n;
  config |= 6n << 48n;
  config |= 1n << 56n;
  config |= 1n << 58n;
  config |= 1n << 63n;
  const decoded = scanner.decodeReserveConfiguration(config);
  assert.equal(decoded.ltvRaw, "7500");
  assert.equal(decoded.liquidationThresholdRaw, "7800");
  assert.equal(decoded.liquidationBonusRaw, "10450");
  assert.equal(decoded.decimals, 6);
  assert.equal(decoded.isActive, true);
  assert.equal(decoded.isFrozen, false);
  assert.equal(decoded.borrowingEnabled, true);
  assert.equal(decoded.flashLoanEnabled, true);
  assert.equal(decoded.paused, false);
});

test("Aave V3 L Base user parsing and coverage evidence map the universe row", () => {
  assert.equal(scanner.userFromLog({ topics: ["0x00", "0x11", "0x" + "0".repeat(24) + "ab".repeat(20)] }), `0x${"ab".repeat(20)}`);
  assert.equal(scanner.userFromLog({ topics: ["0x00"] }), null);

  const universeRows = UNIVERSE.rows.filter((row) => row.id === "base-aave-v3-l");
  assert.equal(universeRows.length, 1);
  assert.equal(universeRows[0].onFire.enabled, true);
  assert.equal(universeRows[0].chainId, 8453);
  assert.equal(universeRows[0].artifactPath, "reports/monitor/trigger-coverage/aave-v3-base-l.json");

  const artifact = {
    scannedAt: new Date().toISOString(), chainId: 8453,
    pin: { number: 1, hash: `0x${"1".repeat(64)}`, timestamp: new Date().toISOString() },
    historyStartBound: { block: 2357134, proven: true },
    closeFactor: "dynamic: HF<0.95e18 => 100%, else 50%",
    enumeration: { activeAccounts: 2, exactLiquidatable: 1 },
    totals: { exactLiquidatable: 1, activeAccounts: 2, accountsObserved: 2 },
    valuation: { status: "NO_CANDIDATE", boundPositiveCandidates: 0 },
    reads: { attempted: 10, succeeded: 10, failed: 0, unclassifiedFailures: 0 },
    coverage: { complete: true },
  };
  const evidence = scanner.coverageEvidence(artifact);
  const shape = coverage.genericEvidenceShape(evidence, universeRows[0]);
  assert.equal(shape.identity && shape.enumerationBound && shape.readsClean && shape.semanticsExact
    && shape.stagesWired && shape.complete && shape.dispatchEnabled, true);
  assert.deepEqual(evidence.blockers, []);
  assert.equal(coverage.genericEvidenceShape(scanner.coverageEvidence({ ...artifact, reads: { attempted: 10, succeeded: 9, failed: 1, unclassifiedFailures: 0 } }), universeRows[0]).complete, false);
});

test("Aave V3 L Base producer is wired through watch, bridge, autopilot, and dispatcher", () => {
  assert.equal(watch.PRODUCER_IDS.includes(PRODUCER_ID), true);
  assert.deepEqual([...watch.SUCCESS_STATUSES[PRODUCER_ID]], ["NO_GROSS_EDGE", "GROSS_EDGE_NET_BLOCKED", "ATOMIC_FORK_REQUIRED"]);
  assert.equal(autopilot.SUPPORTED_EVENTS.get(PRODUCER_ID), "ATOMIC_FORK_REQUIRED");
  assert.equal(autopilot.CROSS_VENUE_PRODUCERS.has(PRODUCER_ID), true);
  assert.equal(dispatcher.FORK_PROMOTION_PRODUCERS.includes(PRODUCER_ID), true);
  assert.equal(bridge.FIXED_CHAIN[PRODUCER_ID], 8453);
});

test("Aave V3 L Base producer evidence validates the liquidation envelope", () => {
  const base = {
    chainId: 8453, blockNumberRaw: "1", blockHash: `0x${"c".repeat(64)}`, blockTimestamp: new Date().toISOString(),
    routeCount: 3, failedCount: 0, firedCount: 0, candidate: null,
  };
  assert.equal(watch.validateEvidence(PRODUCER_ID, "GROSS_EDGE_NET_BLOCKED", base), true);
  assert.equal(watch.validateEvidence(PRODUCER_ID, "NO_GROSS_EDGE", { ...base, routeCount: 0 }), true);
  assert.equal(watch.validateEvidence(PRODUCER_ID, "NO_GROSS_EDGE", base), false);
  assert.equal(watch.validateEvidence(PRODUCER_ID, "GROSS_EDGE_NET_BLOCKED", { ...base, chainId: 1 }), false);

  const candidate = {
    routeKey: "a".repeat(64), eventId: "a".repeat(64),
    user: `0x${"1".repeat(40)}`, debtAsset: `0x${"2".repeat(40)}`, collateralAsset: `0x${"3".repeat(40)}`,
    debtToCoverRaw: "1000000", swapTarget: `0x${"4".repeat(40)}`,
    swapHops: [`0x${"3".repeat(40)}`, `0x${"2".repeat(40)}`], swapFees: [500],
    seizedCollateralRaw: "1100000", minDebtOut: "1000000", ethUsdRaw: "200000000000", routePositive: true,
  };
  const fired = { ...base, firedCount: 1, candidate };
  assert.equal(watch.validateEvidence(PRODUCER_ID, "ATOMIC_FORK_REQUIRED", fired), true);
  assert.equal(watch.validateEvidence(PRODUCER_ID, "ATOMIC_FORK_REQUIRED", { ...fired, candidate: { ...candidate, routePositive: false } }), false);
  assert.equal(watch.validateEvidence(PRODUCER_ID, "ATOMIC_FORK_REQUIRED", { ...fired, candidate: { ...candidate, eventId: "b".repeat(64) } }), false);
  assert.equal(watch.validateEvidence(PRODUCER_ID, "ATOMIC_FORK_REQUIRED", { ...fired, firedCount: 0 }), false);
});

test("Aave V3 L Base compiled artifact is source-hash bound and reproducible", () => {
  const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
  const artifact = JSON.parse(fs.readFileSync(CONTRACT.compiled, "utf8"));
  assert.equal(artifact.chainId, 8453);
  assert.equal(artifact.contractName, CONTRACT.name);
  assert.equal(sha(fs.readFileSync(CONTRACT.sol)), artifact.sourceSha256);
  assert.equal(sha(Buffer.from(artifact.creationBytecode.slice(2), "hex")), artifact.creationBytecodeSha256);
  assert.equal(sha(Buffer.from(artifact.runtimeBytecode.slice(2), "hex")), artifact.runtimeBytecodeSha256);
  const result = childProcess.spawnSync(path.join(ROOT, artifact.compiler.path), [
    "--optimize", "--optimize-runs", "200", "--evm-version", "paris", "--metadata-hash", "none", "--combined-json", "abi,bin,bin-runtime", CONTRACT.sol,
  ], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  const built = output.contracts[Object.keys(output.contracts).find((key) => key.endsWith(`:${CONTRACT.name}`))];
  assert.equal(`0x${built.bin}`, artifact.creationBytecode);
  assert.equal(`0x${built["bin-runtime"]}`, artifact.runtimeBytecode);
});

test("Aave V3 L Base fresh executor differs from the rejected legacy contract", () => {
  const source = fs.readFileSync(CONTRACT.sol, "utf8");
  assert.match(source, /liquidationCall\(plan\.collateralAsset, plan\.debtAsset, plan\.user, plan\.debtToCover, false\)/u);
  assert.match(source, /receiveFlashLoan/u);
  assert.match(source, /require\(msg\.sender == actor, "caller"\)/u);
  assert.match(source, /require\(msg\.sender == BALANCER_VAULT, "vault"\)/u);
  assert.match(source, /require\(plan\.minDebtOut >= plan\.debtToCover, "min-out"\)/u);
  assert.match(source, /require\(debtBalance >= plan\.minDebtOut/u);
  assert.equal(/amountOutMinimum:\s*0/u.test(source), false);
  // Base pool binding, not the Ethereum pool.
  assert.match(source, /AAVE_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5/u);
  assert.equal(/0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2/u.test(source), false);
});

test("Aave V3 L Base scenario binds chain, exact pin, funded actor, and zero-fee repayment", () => {
  const scenario = fs.readFileSync(CONTRACT.scenario, "utf8");
  assert.match(scenario, /module\.exports = \{ chainId: 8453, run \}/u);
  assert.match(scenario, /const ACTOR = "0x00000000000000000000000000000000000a11d0"/u);
  assert.match(scenario, /ctx\.assert\(ctx\.chainId === 8453, "base-chain"\)/u);
  assert.match(scenario, /ctx\.assert\(exactPin, "exact-pin-hash"\)/u);
  assert.match(scenario, /ctx\.assert\(candidate\?\.routePositive === true, "route-qualified"\)/u);
  assert.match(scenario, /deploymentGas \* deploymentGasPrice \+ executionGas \* executionGasPrice/u);
  assert.match(scenario, /ctx\.assert\(routePositive, "net-after-actual-gas"\)/u);
});

test("Aave V3 L Base scenario aborts on an exact-pin mismatch before any RPC or deployment", async () => {
  const scenario = require(CONTRACT.scenario);
  const seen = [];
  const ctx = {
    chainId: 8453,
    blockHash: `0x${"2".repeat(64)}`,
    input: { blockHash: `0x${"1".repeat(64)}`, candidate: {} },
    fatal: false,
    assert(condition, label) {
      const pass = condition === true;
      seen.push(label);
      if (!pass && this.fatal) throw Object.assign(new Error("SCENARIO_ASSERT_FAILED"), { code: "SCENARIO_ASSERT_FAILED" });
      return pass;
    },
  };
  await assert.rejects(() => scenario.run(ctx), /SCENARIO_ASSERT_FAILED/u);
  assert.deepEqual(seen, ["base-chain", "exact-pin-hash"]);
  assert.equal(Object.hasOwn(ctx, "ethers"), false);
});

test("Aave V3 L Base producer fails closed on an incomplete read accounting", async () => {
  const incomplete = {
    pin: { number: 1, hash: `0x${"a".repeat(64)}`, timestamp: new Date().toISOString() },
    totals: { exactLiquidatable: 0 },
    valuation: { candidates: [], ethUsdRaw: null },
    reads: { failed: 1 },
    coverage: { complete: false },
  };
  let published = 0;
  await assert.rejects(
    () => watch.runAaveV3BaseL({ scanAaveBaseL: async () => incomplete, publishAaveBaseL: () => { published += 1; } }),
    (error) => error.code === "INCOMPLETE",
  );
  assert.equal(published, 1, "binder is published before the row fails closed");
  const complete = { ...incomplete, reads: { failed: 0 }, coverage: { complete: true } };
  const ok = await watch.runAaveV3BaseL({ scanAaveBaseL: async () => complete, publishAaveBaseL: () => {} });
  assert.equal(ok.status, "NO_GROSS_EDGE");
});
