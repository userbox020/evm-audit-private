#!/usr/bin/env node
"use strict";

// Read-only Phase 1 economics. Nothing in this artifact authorizes a transaction.
const fs = require("node:fs");
const path = require("node:path");
const { Interface } = require(path.join(__dirname, "node_modules", "ethers"));
const watcher = require("./watch-liquity-liquidation-triggers.js");

const ROOT = path.resolve(__dirname, "..");
const STATUS = path.join(ROOT, "reports", "raw", "fast", "liquity-liquidation-watch", "status.json");
const REHEARSAL = path.join(ROOT, "reports", "raw", "fast", "liquity-v2-rehearsal-20261013", "gate-view.result.json");
const OUT = path.join(ROOT, "reports", "raw", "fast", "liquity-route-economics");
const INVENTORY = path.join(ROOT, "rpc_endpoints.txt");
const WAD = 10n ** 18n;
const V2_BASE = 37500000000000000n;
const PRICE = new Interface(["function lastGoodPrice() view returns (uint256)"]);
const integer = (value) => (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) ? BigInt(value) : null;
const hexInteger = (value) => (typeof value === "string" && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) ? BigInt(value) : null;
const minimum = (a, b) => a < b ? a : b;

function boundedJson(file) {
  if (fs.statSync(file).size > 2 * 1024 * 1024) throw new Error("input-too-large");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Reuse the watcher's inventory parsing, transport safeguards and exact mainnet
// finalized-block/runtime-code qualification. The wrapper lowers its request cap.
async function liveSnapshot() {
  const result = { chainId: null, blockNumber: null, gasPriceWei: null, baseFeeWei: null, priorityFeeWei: null, prices: null, error: null };
  try {
    if (!fs.existsSync(INVENTORY)) throw new Error("inventory-unavailable");
    const providers = watcher.parseInventory(fs.readFileSync(INVENTORY, "utf8"))
      .filter((row) => row.ethereumHint !== false).slice(0, 24);
    const transport = watcher.transport();
    const rpc = async (provider, method, params) => {
      if (transport.count >= 24) throw new Error("request-budget-exhausted");
      return transport.rpc(provider, method, params);
    };
    let provider = null;
    // Reserve seven calls for the latest block, two gas queries and four feeds.
    for (const candidate of providers) {
      if (transport.count > 9) break;
      if (await watcher.qualify(candidate, rpc)) { provider = candidate; break; }
    }
    if (!provider) throw new Error("no-qualified-provider");
    result.chainId = 1;
    const block = await rpc(provider, "eth_getBlockByNumber", ["latest", false]);
    const number = block && hexInteger(block.number);
    if (number === null || number > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("invalid-block");
    result.blockNumber = Number(number);
    result.baseFeeWei = block.baseFeePerGas && hexInteger(block.baseFeePerGas)?.toString() || null;
    const gasPrice = hexInteger(await rpc(provider, "eth_gasPrice", []));
    const priority = hexInteger(await rpc(provider, "eth_maxPriorityFeePerGas", []));
    if (gasPrice === null || priority === null) throw new Error("invalid-gas-price");
    result.gasPriceWei = gasPrice.toString();
    result.priorityFeeWei = priority.toString();
    const deployment = require(path.join(ROOT, "targets", "liquity-v2-bold-deployment", "contracts", "addresses", "1.json"));
    const feeds = ["0x4c517D4e2C851CA76d7eC94B805269Df0f2201De", ...deployment.branches.map((branch) => branch.priceFeed)];
    const prices = [];
    for (const feed of feeds) {
      const raw = await rpc(provider, "eth_call", [{ to: feed, data: PRICE.encodeFunctionData("lastGoodPrice()") }, block.number]);
      prices.push(PRICE.decodeFunctionResult("lastGoodPrice()", raw)[0].toString());
    }
    result.prices = prices;
  } catch (_) { result.error = "live-read-unavailable"; }
  return result;
}

function economics(status, live, rehearsal) {
  const blockers = ["FORK_PROOF_PENDING", "NO_EXECUTOR_OR_SIGNED_AUTHORIZATION"];
  if (status.error) blockers.push("WATCH_STATUS_ERROR");
  if (!Number.isSafeInteger(status.blockNumber)) blockers.push("WATCH_BLOCK_UNAVAILABLE");
  if (live.error) blockers.push("LIVE_RPC_UNAVAILABLE");
  if (live.blockNumber !== null && status.blockNumber !== live.blockNumber) blockers.push("WATCH_BLOCK_NOT_LIVE");
  if (!status.contractAddresses) blockers.push("CONTRACT_ADDRESSES_NOT_IN_WATCH_STATUS");
  const branches = Array.isArray(status.v2?.branches) ? status.v2.branches : [];
  if (status.v1?.freshnessSeconds == null || branches.some((b) => b.freshnessSeconds == null)) blockers.push("ORACLE_AGE_UNKNOWN");
  if (branches.some((b) => b.troveSweep !== "COMPLETE_FROM_TAIL")) blockers.push("TROVE_SWEEP_INCOMPLETE");
  const v1Price = integer(status.v1?.lastGoodPrice);
  const livePrices = [status.v1?.lastGoodPrice, ...branches.map((b) => b.lastGoodPrice)];
  if (live.prices && live.prices.some((price, i) => price !== livePrices[i])) blockers.push("WATCH_PRICE_NOT_LIVE");
  if (!v1Price || !branches.every((b) => integer(b.lastGoodPrice))) blockers.push("WATCH_PRICE_UNAVAILABLE");
  const rehearsalPassed = rehearsal?.state === "PASS";
  const rehearsalIdx = blockers.indexOf("FORK_PROOF_PENDING");
  if (rehearsalPassed && rehearsalIdx >= 0) blockers.splice(rehearsalIdx, 1);
  const rehearsalCases = Array.isArray(rehearsal?.cases) ? rehearsal.cases : [];
  const caseGas = rehearsalCases.map((c) => Number(c?.gasUsedPerLiquidation)).filter((v) => Number.isFinite(v) && v > 0);
  const liveGasPrice = integer(live.gasPriceWei);
  const scalarMeasured = integer(rehearsal?.measuredGasWeiPerLiquidation);
  const arrayMeasured = Array.isArray(rehearsal?.measuredGasWeiPerLiquidation)
    ? rehearsal.measuredGasWeiPerLiquidation.map((v) => integer(v)).filter((v) => v !== null)
    : [];
  const measuredCandidates = [scalarMeasured, ...arrayMeasured].filter((v) => v !== null);
  const pinnedMax = measuredCandidates.length ? Math.max(...measuredCandidates.map((v) => typeof v === "bigint" ? Number(v) : v)) : null;
  let measured = null;
  let measuredPricing = null;
  if (caseGas.length && liveGasPrice !== null && liveGasPrice > 0) {
    measured = BigInt(Math.max(...caseGas)) * liveGasPrice; // strictest: today's gas price, not the pinned historical one
    measuredPricing = "LIVE_GAS_PRICE_APPLIED";
  } else if (pinnedMax !== null && pinnedMax > 0) {
    measured = pinnedMax;
    measuredPricing = "PINNED_GAS_PRICE_NOT_TODAY";
  }
  if (rehearsal && measured === null) blockers.push("FORK_GAS_RESULT_INVALID");
  if (measured === null) blockers.push("FORK_GAS_UNMEASURED");
  const gasModel = { baseFeeWei: live.baseFeeWei, priorityFeeWei: live.priorityFeeWei, gasPriceWei: live.gasPriceWei,
    assumedGasLimit: null, measured: measured === null ? "PENDING_FORK_REHEARSAL" : "FORK_REHEARSAL_REPORTED",
    measuredGasWeiPerLiquidation: measured === null ? null : measured.toString(), measuredPricing, netFloorWei: null };

  const rows = [];
  function add(row, branch, collPrice) {
    const debt = integer(row.debt);
    const coll = integer(row.coll);
    const price = integer(collPrice);
    const rowBlockers = [];
    if (!debt || coll === null || !price || !v1Price) rowBlockers.push("ROW_INPUT_UNAVAILABLE");
    let offsetShare = null;
    let offsetCollateral = 0n;
    if (branch !== "v1") {
      offsetShare = integer(row.offsetShare);
      if (offsetShare === null) rowBlockers.push("OFFSET_CAPACITY_UNAVAILABLE");
      else if (debt && coll !== null) offsetCollateral = coll * minimum(offsetShare, debt) / debt;
    }
    const collComp = coll === null ? 0n : branch === "v1" ? coll / 200n : minimum(offsetCollateral / 200n, 2n * WAD);
    const stableComp = branch === "v1" ? 200n * WAD : 0n;
    const wethComp = branch === "v1" ? 0n : V2_BASE;
    const grossUsdWad = price && v1Price ? stableComp + (collComp * price / WAD) + (wethComp * v1Price / WAD) : null;
    const grossWei = grossUsdWad !== null && v1Price ? grossUsdWad * WAD / v1Price : null;
    const indicativeNetWei = grossWei !== null && measured !== null ? grossWei - measured : null;
    rows.push({ branch, ...(branch === "v1" ? { borrower: row.borrower || null } : { id: row.id || null }),
      blockNumber: row.blockNumber ?? status.blockNumber ?? null, collateralWei: coll?.toString() ?? null,
      lastGoodPrice: collPrice ?? null, pegAssumption: true, stablePegUsd: "1",
      offsetShare: branch === "v1" ? null : offsetShare === null ? ["UNKNOWN", "offset capacity unavailable", "fail-closed"] : offsetShare.toString(),
      grossCompensation: { stableToken: branch === "v1" ? "LUSD" : "BOLD", stableWei: stableComp.toString(), wethWei: wethComp.toString(), collateralTokenWei: collComp.toString() },
      expectedGrossUsdWad: grossUsdWad?.toString() ?? null, expectedGrossWei: grossWei?.toString() ?? null,
      gasModel: { ...gasModel },
      indicativeNetWei: indicativeNetWei?.toString() ?? null, routePositive: measured === null ? "unknown" : false,
      executableNow: false, autoExecutable: false, signedActionJustified: false, forkJustified: false,
      blockers: [...blockers, ...rowBlockers] });
  }
  for (const row of status.v1?.trackedEligible || []) add(row, "v1", status.v1.lastGoodPrice);
  for (const branch of branches) for (const row of branch.trackedEligible || []) add(row, branch.branch, branch.lastGoodPrice);
  return { schema: "liquity-route-economics/v1", condition: "liquity-liquidation-route", state: rows.length ? "READ_ONLY" : "EMPTY_TRIGGER_SET",
    generatedAt: new Date().toISOString(), sourceGeneratedAt: status.generatedAt || null,
    chainId: live.chainId, blockNumber: status.blockNumber ?? null, observedBlockNumber: live.blockNumber,
    contractAddresses: status.contractAddresses || null, executorFamily: null,
    livePrice: { v1LastGoodPrice: status.v1?.lastGoodPrice ?? null,
      v2Branches: branches.map((b) => ({ branch: b.branch, lastGoodPrice: b.lastGoodPrice ?? null, freshnessSeconds: b.freshnessSeconds ?? null })) },
    gasPriceWei: live.gasPriceWei, gasModel, pegAssumption: true, stablePegUsd: "1", rows,
    routePositive: rows.length && measured !== null ? false : "unknown", forkJustified: false,
    executableNow: false, autoExecutable: false, signedActionJustified: false,
    readonly: true, failClosed: true, blockers };
}

function persist(artifact) {
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, "route-artifact.json");
  const temp = path.join(OUT, `.route-artifact.${process.pid}.${Date.now()}.tmp`);
  try { fs.writeFileSync(temp, JSON.stringify(artifact, null, 2) + "\n", { mode: 0o600 }); fs.renameSync(temp, file); }
  finally { try { fs.unlinkSync(temp); } catch (_) { /* renamed */ } }
}

function args(argv) {
  const once = argv[0] === "--once";
  const watch = argv[0] === "--watch";
  if (!once && !watch && argv.length) throw new Error("invalid-arguments");
  if (once && argv.length !== 1) throw new Error("invalid-arguments");
  if (watch && argv.length !== 1 && !(argv.length === 3 && argv[1] === "--max-runs" && /^[1-9][0-9]*$/.test(argv[2]) && Number.isSafeInteger(Number(argv[2])))) throw new Error("invalid-arguments");
  return { watch, maxRuns: watch && argv.length === 3 ? Number(argv[2]) : 1440 };
}

async function main(argv = process.argv.slice(2)) {
  const { watch, maxRuns } = args(argv);
  let prior = null;
  for (let run = 0; run < maxRuns; run++) {
    try {
      const raw = fs.readFileSync(STATUS, "utf8");
      const rehearsal = fs.existsSync(REHEARSAL) ? boundedJson(REHEARSAL) : null;
      const signature = raw + JSON.stringify(rehearsal);
      if (signature !== prior) {
        const status = JSON.parse(raw);
        const artifact = economics(status, await liveSnapshot(), rehearsal);
        persist(artifact);
        process.stdout.write(JSON.stringify({ ok: true, state: artifact.state, blockNumber: artifact.blockNumber,
          observedBlockNumber: artifact.observedBlockNumber, eligibleCount: artifact.rows.length, failClosed: true,
          blockers: artifact.blockers }) + "\n");
        prior = signature;
      }
    } catch (_) { process.stdout.write(JSON.stringify({ ok: false, reason: "artifact-input-or-write-failure" }) + "\n"); process.exitCode = 1; if (!watch) break; }
    if (!watch) break;
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  }
}

module.exports = { economics, liveSnapshot, main };
if (require.main === module) main().catch(() => { process.stdout.write('{"ok":false,"reason":"artifact-input-or-write-failure"}\n'); process.exitCode = 1; });
