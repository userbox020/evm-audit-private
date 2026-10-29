#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const runner = require("./critical-stakewise-v3-mainnet-deployment-economics-successor-runner.js");

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures",
  "critical-stakewise-v3-mainnet-deployment-economics-successor-fixtures.json"), "utf8"));
let checks = 0;
function equal(actual, expected, message) { checks += 1; assert.deepStrictEqual(actual, expected, `check ${checks}: ${message}`); }
function check(value, message) { checks += 1; assert.ok(value, `check ${checks}: ${message}`); }
function throws(fn, code, message) { checks += 1; assert.throws(fn, new RegExp(code, "u"), `check ${checks}: ${message}`); }

async function main() {
  equal(fixture.fixtureClasses.length, 22, "bounded fixture inventory");
  const now = Date.parse("2026-08-15T12:00:00Z");
  const runId = "swv3econ-20260815T115900Z-0123456789abcdef0123456789abcdef";
  equal(runner.parseArgs(["node", "runner", "--check-only"], now), { checkOnly: true, capture: false, runId: null }, "check-only");
  equal(runner.parseArgs(["node", "runner", runner.CAPTURE_FLAG, "--run-id", runId], now).runId, runId, "exact capture invocation");
  throws(() => runner.parseArgs(["node", "runner", "--capture-once", "--run-id", runId], now),
    "EXACT_CAPTURE_FLAG", "legacy capture flag rejected");
  throws(() => runner.parseArgs(["node", "runner", runner.CAPTURE_FLAG, "--run-id",
    "swv3econ-20260815T110000Z-0123456789abcdef0123456789abcdef"], now), "RUN_ID_NOT_FRESH", "expired ID rejected");

  const preflight = runner.dryPreflight();
  equal([preflight.networkReads, preflight.inventoryReads, preflight.writes], [0, 0, 0], "offline preflight");
  equal(preflight.methods.allowed, ["eth_call", "eth_chainId", "eth_getBalance", "eth_getBlockByNumber", "eth_getCode", "eth_getLogs"],
    "exact method allowlist");
  equal(preflight.caps.retriesPerRequest, 0, "no retry");
  for (const method of ["eth_getStorageAt", "eth_sendRawTransaction", "debug_traceCall", "eth_estimateGas"]) {
    throws(() => new runner.Budget().consume(method), "METHOD_FORBIDDEN", `${method} forbidden`);
  }

  const header = { number: 25000000n, hash: fixture.syntheticRoot, timestamp: 1n };
  const consensus = runner.choosePin([{ family: "F1", chainId: 1, header }, { family: "F2", chainId: 1, header }]);
  equal([consensus.mode, consensus.promotable, consensus.rows.length], ["TWO_FAMILY_CONSENSUS", true, 2], "two-family pin");
  const diagnostic = runner.choosePin([{ family: "F1", chainId: 1, header }]);
  equal([diagnostic.mode, diagnostic.promotable, diagnostic.rows.length], ["SINGLE_FAMILY_DIAGNOSTIC", false, 1], "single-family diagnostic");
  equal(runner.choosePin([{ family: "F1", chainId: 1, header },
    { family: "F2", chainId: 1, header: { ...header, hash: `0x${"bb".repeat(32)}` } }]).promotable, false, "pin mismatch");

  equal([runner.factoryClassification("VaultFactory").access, runner.factoryClassification("PrivVaultFactory").access,
    runner.factoryClassification("BlocklistVaultFactory").access, runner.factoryClassification("MetaVaultFactory").meta],
  ["PUBLIC", "PRIVATE", "BLOCKLIST", true], "factory classes");
  equal([runner.versionClass(5), runner.versionClass(6), runner.versionClass(7), runner.versionClass(8)],
    ["V5", "V6", "V7", "UNKNOWN"], "version classes");

  const dataset = runner.parseRewardsDataset({ rewardsRoot: fixture.syntheticRoot, rewards: [{ vault: fixture.syntheticVault,
    reward: "120", unlockedMevReward: "10", proof: [fixture.syntheticRoot] }] }, fixture.syntheticRoot, [fixture.syntheticVault]);
  equal([dataset.available, dataset.rows.size], [true, 1], "strict dataset accepted");
  equal(runner.parseRewardsDataset({ rewardsRoot: `0x${"bb".repeat(32)}`, rewards: [] }, fixture.syntheticRoot, []).available,
    false, "dataset root mismatch rejected");

  const baseVault = { access: "PUBLIC", versionClass: "V5", registryMember: true, implementationRegistryMember: true,
    canHarvest: true, isHarvestRequired: false, stateUpdateRequired: true, mevEscrowBalance: 1000n,
    capacity: 200n, totalAssets: 100n, feePercent: 1000n, rewardAssets: 20n, unlockedMevAssets: 0n,
    queue: { queuedShares: 0n }, withdrawableAssets: 50n };
  equal(runner.computeEconomics(baseVault, null).routePositive, null, "proof residual required");
  const economics = runner.computeEconomics(baseVault, dataset.rows.get(fixture.syntheticVault));
  equal([economics.positiveRewardResidual, economics.netRewardResidual, economics.capacityResidual], [110n, 99n, 100n],
    "residual and fee");
  equal(economics.sweep[economics.sweep.length - 1].gainUpperBound, 49n, "D*Rnet/(A+D) floors exactly");
  equal([economics.routePositive, economics.executableNow], [true, true], "all exact gates permit booleans");
  equal(runner.computeEconomics({ ...baseVault, access: "PRIVATE" }, dataset.rows.get(fixture.syntheticVault)).routePositive,
    null, "inexact public gate remains unknown");

  throws(() => runner.sanitizeOutput({ endpointHash: fixture.syntheticRoot }), "ENDPOINT_MATERIAL", "endpoint hash guard");
  equal(runner.sanitizeOutput({ vaultAddressPublic: fixture.syntheticVault }).vaultAddressPublic, fixture.syntheticVault,
    "public contract address allowed");

  const tempParent = path.join(os.tmpdir(), "opencode");
  check(fs.existsSync(tempParent), "approved temp parent");
  const tempDir = fs.mkdtempSync(path.join(tempParent, "swv3-econ-test-"));
  try {
    const output = path.join(tempDir, "terminal.json");
    runner.atomicWrite(output, { terminal: true, address: fixture.syntheticVault });
    equal(JSON.parse(fs.readFileSync(output, "utf8")).terminal, true, "atomic terminal write");
    throws(() => runner.atomicWrite(output, { terminal: true }), "EEXIST|EPERM", "one-shot output cannot overwrite");
  } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }

  check(runner.reused.step2.parseRegistryDiscovery === require("./critical-stakewise-v3-eth-exitqueue-step2-runner.js").parseRegistryDiscovery,
    "step2 discovery parser reused");
  check(runner.reused.osToken.canonicalJson === require("./critical-stakewise-v3-ostoken-mainnet-runner.js").canonicalJson,
    "osToken canonical comparator reused");

  process.stdout.write(`${JSON.stringify({ status: "PASS", checks, fixtureClasses: fixture.fixtureClasses.length,
    networkReads: 0, inventoryReads: 0, captureExecuted: false })}\n`);
}

main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
