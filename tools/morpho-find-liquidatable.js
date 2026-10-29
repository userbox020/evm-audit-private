#!/usr/bin/env node
// morpho-find-liquidatable.js — bounded, truthfully classified Morpho liquidation telemetry
"use strict";

const { rpcCall, resolveRpc } = require("./shared-rpc");
const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "monitor", "morpho-liquidatable-startup.json");

const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const BORROW_TOPIC = "0x570954540bed6b1304a87dfe815a5eda4a648f7097a16240dcd85c9b5fd42a43";
const LOG_LOOKBACK_BLOCKS = 5000;
const MAX_BORROW_LOGS = 500;
const MAX_BORROWERS_PER_MARKET = 30;
const ORACLE_PRICE_SCALE = 10n ** 36n;
const LIQUIDATION_CURSOR = 0.3;
const MAX_LIQUIDATION_INCENTIVE = 1.15;
const WAD = 10n ** 18n;
const READ_KINDS = ["blockNumber", "borrowLogs", "marketParams", "marketState", "oraclePrice", "position"];

function enc(address) { return "0".repeat(24) + address.slice(2).toLowerCase(); }

async function getMarketParams(rpc, marketId) {
  const raw = await rpcCall(rpc, "eth_call", [{ to: MORPHO, data: "0x2c3c9157" + marketId.slice(2) }, "latest"], 8000);
  if (!raw || raw.length < 322) return null;
  const lltvRaw = BigInt("0x" + raw.slice(258, 322));
  return {
    loanToken: "0x" + raw.slice(26, 66),
    collateralToken: "0x" + raw.slice(90, 130),
    oracle: "0x" + raw.slice(154, 194),
    lltvRaw: lltvRaw.toString(),
    lltv: Number(lltvRaw) / Number(WAD),
  };
}

async function getMarketState(rpc, marketId) {
  const raw = await rpcCall(rpc, "eth_call", [{ to: MORPHO, data: "0x5c60e39a" + marketId.slice(2) }, "latest"], 8000);
  if (!raw || raw.length < 386) return null;
  return {
    totalBorrowAssets: BigInt("0x" + raw.slice(130, 194)),
    totalBorrowShares: BigInt("0x" + raw.slice(194, 258)),
  };
}

function getLiquidationIncentive(lltv) {
  const denominator = 1 - LIQUIDATION_CURSOR * (1 - lltv);
  return Math.min(MAX_LIQUIDATION_INCENTIVE, 1 / denominator);
}

async function scanBorrower(rpc, marketId, borrower, params, state, oraclePriceBig) {
  const raw = await rpcCall(rpc, "eth_call", [{ to: MORPHO, data: "0x93c52062" + marketId.slice(2) + enc(borrower) }, "latest"], 8000);
  if (!raw || raw.length < 194) return { readSucceeded: false, position: null };

  const borrowShares = BigInt("0x" + raw.slice(66, 130));
  const collateral = BigInt("0x" + raw.slice(130, 194));
  if (borrowShares === 0n) return { readSucceeded: true, position: null };

  const tba = state.totalBorrowAssets;
  const tbs = state.totalBorrowShares;
  if (tbs === 0n) return { readSucceeded: true, position: null };

  const product = borrowShares * tba;
  const borrowed = product / tbs + (product % tbs !== 0n ? 1n : 0n);
  const lltvRaw = params.lltvRaw === undefined
    ? BigInt(Math.floor(params.lltv * Number(WAD)))
    : BigInt(params.lltvRaw);
  const maxBorrow = (collateral * oraclePriceBig / ORACLE_PRICE_SCALE) * lltvRaw / WAD;
  const healthFactor = borrowed === 0n
    ? null
    : Number(maxBorrow * 1_000_000n / borrowed) / 1_000_000;
  const isLiquidatable = maxBorrow < borrowed && borrowed > 0n;

  return {
    readSucceeded: true,
    position: {
      borrower,
      loanToken: params.loanToken,
      collateralToken: params.collateralToken,
      borrowSharesRaw: borrowShares.toString(),
      collateralRaw: collateral.toString(),
      borrowAssetsRaw: borrowed.toString(),
      maxBorrowAssetsRaw: maxBorrow.toString(),
      oraclePriceRaw: oraclePriceBig.toString(),
      lltvRaw: lltvRaw.toString(),
      healthFactor,
      isLiquidatable,
      liquidationIncentiveFactor: getLiquidationIncentive(params.lltv),
      valuationStatus: "unavailable",
    },
  };
}

function emptyReadCounts() {
  return Object.fromEntries(READ_KINDS.map((kind) => [kind, { attempts: 0, successes: 0, failures: 0 }]));
}

function newCoverage() {
  return {
    currentBlock: null,
    logQuerySuccessful: false,
    observedRange: { fromBlock: null, toBlock: null },
    historyScope: "RECENT_BLOCK_SUFFIX",
    historyStartBound: null,
    fullHistoryProven: false,
    caps: { borrowLogs: MAX_BORROW_LOGS, borrowersPerMarket: MAX_BORROWERS_PER_MARKET },
    borrowLogs: { discovered: 0, processed: 0, omittedByCap: 0, malformed: 0, wasTruncated: false },
    markets: {
      discoveryScope: "processedBorrowLogs",
      discovered: 0,
      attempted: 0,
      resolved: 0,
      unresolved: 0,
    },
    borrowers: {
      discoveryScope: "processedBorrowLogs",
      discoveredUnique: 0,
      discoveredMarketBorrowerPairs: 0,
      selectedForCheck: 0,
      omittedByCap: 0,
      wasTruncated: false,
    },
    positions: {
      discovered: 0,
      selectedForCheck: 0,
      readAttempts: 0,
      successfullyChecked: 0,
      readFailures: 0,
      unchecked: 0,
      uncheckedDueToBorrowerCap: 0,
      uncheckedDueToUnresolvedMarket: 0,
    },
    reads: { attempts: 0, successes: 0, failures: 0, byKind: emptyReadCounts() },
    operationalFailures: 0,
    errors: 0,
  };
}

async function readWithCoverage(coverage, kind, reader, isValid = () => true) {
  const counts = coverage.reads.byKind[kind];
  counts.attempts += 1;
  coverage.reads.attempts += 1;
  try {
    const value = await reader();
    if (!isValid(value)) throw new Error(`${kind} returned invalid data`);
    counts.successes += 1;
    coverage.reads.successes += 1;
    return value;
  } catch (error) {
    counts.failures += 1;
    coverage.reads.failures += 1;
    throw error;
  }
}

function finalizeCoverage(coverage) {
  coverage.positions.readAttempts = coverage.reads.byKind.position.attempts;
  coverage.positions.readFailures = coverage.reads.byKind.position.failures;
  coverage.positions.unchecked = coverage.positions.discovered - coverage.positions.successfullyChecked;
  coverage.errors = coverage.reads.failures + coverage.borrowLogs.malformed + coverage.operationalFailures;
  coverage.fullHistoryProven = hasFullHistoryProof(coverage);
  return coverage;
}

function hasFullHistoryProof(coverage) {
  const fromBlock = coverage.observedRange?.fromBlock;
  const toBlock = coverage.observedRange?.toBlock;
  const validRange = Number.isSafeInteger(fromBlock) && Number.isSafeInteger(toBlock) && fromBlock >= 0 && toBlock >= fromBlock;
  const bound = coverage.historyStartBound;
  const explicitBoundProven = validRange
    && fromBlock > 0
    && bound?.proven === true
    && bound.block === fromBlock
    && typeof bound.proof === "string"
    && bound.proof.trim().length > 0;
  return validRange && (fromBlock === 0 || explicitBoundProven);
}

function isCoverageComplete(coverage) {
  return hasFullHistoryProof(coverage)
    && coverage.logQuerySuccessful === true
    && Number.isSafeInteger(coverage.currentBlock) && coverage.currentBlock > 0
    && coverage.borrowLogs.processed === coverage.borrowLogs.discovered
    && coverage.borrowLogs.malformed === 0
    && coverage.borrowLogs.wasTruncated === false
    && coverage.markets.attempted === coverage.markets.discovered
    && coverage.markets.unresolved === 0
    && coverage.borrowers.wasTruncated === false
    && coverage.positions.successfullyChecked === coverage.positions.discovered
    && coverage.positions.unchecked === 0
    && coverage.reads.failures === 0
    && coverage.operationalFailures === 0;
}

function buildCompletionArtifact(coverage, liquidatablePositions = [], now = new Date()) {
  finalizeCoverage(coverage);
  const complete = isCoverageComplete(coverage);
  const blocker = complete ? null : coverage.fullHistoryProven !== true
    ? "Active-position discovery covers only a recent block suffix; full history is not proven."
    : "One or more discovery or state-read sources are incomplete.";
  return {
    schemaVersion: 2,
    generatedAt: now.toISOString(),
    scanner: "tools/morpho-find-liquidatable.js",
    classification: complete ? "EXHAUSTIVE_COMPLETE" : "BOUNDED_WINDOW_INCOMPLETE",
    complete,
    blocker,
    // Compatibility fields consumed by the existing startup supervisor.
    currentBlock: coverage.currentBlock,
    logQuerySuccessful: coverage.logQuerySuccessful,
    marketsAttempted: coverage.markets.attempted,
    marketsSuccessfullyChecked: coverage.markets.resolved,
    positionsAttempted: coverage.positions.readAttempts,
    positionsSuccessfullyChecked: coverage.positions.successfullyChecked,
    errors: coverage.errors,
    coverage,
    results: {
      liquidatablePositionsFound: liquidatablePositions.length,
      valuationStatus: "unavailable",
      valuationEvidence: null,
      promotionEligible: false,
      liquidatablePositions,
    },
  };
}

function writeArtifact(artifact, outputPath = OUT) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.tmp-${process.hrtime.bigint().toString(16)}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(artifact, null, 2)}\n`, { flag: "wx" });
    fs.renameSync(temporary, outputPath);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch (_) {}
  }
  return artifact;
}

function writeCompletionArtifact(coverage, liquidatablePositions = [], outputPath = OUT) {
  return writeArtifact(buildCompletionArtifact(coverage, liquidatablePositions), outputPath);
}

async function main(dependencies = {}) {
  const resolve = dependencies.resolveRpc || resolveRpc;
  const call = dependencies.rpcCall || rpcCall;
  const logger = dependencies.console || console;
  const coverage = newCoverage();
  const liquidatable = [];
  let positionsWithDebt = 0;

  logger.log("=== Morpho Liquidation Telemetry Scanner ===\n");
  try {
    const rpc = await resolve(1);
    if (!rpc) {
      coverage.operationalFailures += 1;
      throw new Error("No ETH RPC");
    }

    const block = await readWithCoverage(
      coverage,
      "blockNumber",
      () => call(rpc, "eth_blockNumber", [], 5000),
      (value) => typeof value === "string" && Number.isSafeInteger(parseInt(value, 16)) && parseInt(value, 16) > 0,
    );
    const currentBlock = parseInt(block, 16);
    coverage.currentBlock = currentBlock;
    const configuredBound = dependencies.historyStartBound;
    const explicitBoundProven = configuredBound
      && Number.isSafeInteger(configuredBound.block)
      && configuredBound.block >= 0
      && configuredBound.block <= currentBlock
      && configuredBound.proven === true
      && typeof configuredBound.proof === "string"
      && configuredBound.proof.trim().length > 0;
    const fromBlock = explicitBoundProven
      ? configuredBound.block
      : Math.max(0, currentBlock - LOG_LOOKBACK_BLOCKS);
    coverage.observedRange = {
      fromBlock,
      toBlock: currentBlock,
    };
    coverage.historyStartBound = fromBlock === 0
      ? { block: 0, kind: "genesis", proven: true, proof: "genesis" }
      : explicitBoundProven
        ? { ...configuredBound }
        : null;
    coverage.fullHistoryProven = fromBlock === 0 || Boolean(explicitBoundProven);
    coverage.historyScope = fromBlock === 0
      ? "GENESIS_TO_TIP"
      : explicitBoundProven
        ? "PROVEN_START_TO_TIP"
        : "RECENT_BLOCK_SUFFIX";

    const borrowLogs = await readWithCoverage(
      coverage,
      "borrowLogs",
      () => call(rpc, "eth_getLogs", [{
        address: MORPHO,
        fromBlock: "0x" + fromBlock.toString(16),
        toBlock: block,
        topics: [BORROW_TOPIC],
      }], 15000),
      Array.isArray,
    );
    coverage.logQuerySuccessful = true;
    coverage.borrowLogs.discovered = borrowLogs.length;
    coverage.borrowLogs.wasTruncated = borrowLogs.length > MAX_BORROW_LOGS;

    const logsToProcess = borrowLogs.slice(-MAX_BORROW_LOGS);
    coverage.borrowLogs.processed = logsToProcess.length;
    coverage.borrowLogs.omittedByCap = coverage.borrowLogs.discovered - coverage.borrowLogs.processed;
    const pairs = new Map();
    const uniqueBorrowers = new Set();
    for (const log of logsToProcess) {
      const marketId = log?.topics?.[1];
      const encodedBorrower = log?.topics?.[2];
      if (!/^0x[0-9a-fA-F]{64}$/.test(marketId || "") || !/^0x[0-9a-fA-F]{64}$/.test(encodedBorrower || "")) {
        coverage.borrowLogs.malformed += 1;
        continue;
      }
      const borrower = "0x" + encodedBorrower.slice(26).toLowerCase();
      if (!pairs.has(marketId)) pairs.set(marketId, new Set());
      pairs.get(marketId).add(borrower);
      uniqueBorrowers.add(borrower);
    }

    coverage.markets.discovered = pairs.size;
    coverage.borrowers.discoveredUnique = uniqueBorrowers.size;
    coverage.borrowers.discoveredMarketBorrowerPairs = [...pairs.values()].reduce((sum, set) => sum + set.size, 0);
    coverage.borrowers.selectedForCheck = [...pairs.values()].reduce(
      (sum, set) => sum + Math.min(set.size, MAX_BORROWERS_PER_MARKET),
      0,
    );
    coverage.borrowers.omittedByCap = coverage.borrowers.discoveredMarketBorrowerPairs - coverage.borrowers.selectedForCheck;
    coverage.borrowers.wasTruncated = coverage.borrowers.omittedByCap > 0;
    coverage.positions.discovered = coverage.borrowers.discoveredMarketBorrowerPairs;
    coverage.positions.selectedForCheck = coverage.borrowers.selectedForCheck;
    coverage.positions.uncheckedDueToBorrowerCap = coverage.borrowers.omittedByCap;

    logger.log(`Discovered ${coverage.borrowLogs.discovered} Borrow logs; processing ${coverage.borrowLogs.processed}.`);
    logger.log(`Discovered ${coverage.markets.discovered} markets and ${coverage.positions.discovered} market/borrower positions.\n`);

    for (const [marketId, borrowers] of pairs) {
      coverage.markets.attempted += 1;
      const selectedBorrowers = [...borrowers].slice(0, MAX_BORROWERS_PER_MARKET);
      let params;
      let state;
      let oraclePriceBig;
      try {
        params = await readWithCoverage(
          coverage,
          "marketParams",
          () => dependencies.getMarketParams
            ? dependencies.getMarketParams(rpc, marketId)
            : getMarketParams(rpc, marketId),
          (value) => Boolean(value),
        );
        state = await readWithCoverage(
          coverage,
          "marketState",
          () => dependencies.getMarketState
            ? dependencies.getMarketState(rpc, marketId)
            : getMarketState(rpc, marketId),
          (value) => Boolean(value),
        );
        const priceRaw = await readWithCoverage(
          coverage,
          "oraclePrice",
          () => call(rpc, "eth_call", [{ to: params.oracle, data: "0xa035b1fe" }, "latest"], 8000),
          (value) => typeof value === "string" && value.length >= 66 && BigInt("0x" + value.slice(2, 66)) > 0n,
        );
        oraclePriceBig = BigInt("0x" + priceRaw.slice(2, 66));
        coverage.markets.resolved += 1;
      } catch (_) {
        coverage.markets.unresolved += 1;
        coverage.positions.uncheckedDueToUnresolvedMarket += selectedBorrowers.length;
        continue;
      }

      for (const borrower of selectedBorrowers) {
        let result;
        try {
          result = await readWithCoverage(
            coverage,
            "position",
            () => dependencies.scanBorrower
              ? dependencies.scanBorrower(rpc, marketId, borrower, params, state, oraclePriceBig)
              : scanBorrower(rpc, marketId, borrower, params, state, oraclePriceBig),
            (value) => value?.readSucceeded === true,
          );
        } catch (_) {
          continue;
        }
        coverage.positions.successfullyChecked += 1;
        if (!result.position) continue;
        positionsWithDebt += 1;
        if (result.position.isLiquidatable) {
          liquidatable.push({ marketId, ...result.position, valuationStatus: "unavailable" });
          logger.log(`LIQUIDATABLE ${result.position.borrower} rawBorrowAssets=${result.position.borrowAssetsRaw || result.position.borrowed || "unavailable"}`);
        }
      }
    }
  } catch (error) {
    if (coverage.reads.failures === 0 && coverage.operationalFailures === 0) coverage.operationalFailures += 1;
    logger.error(error?.message || String(error));
  }

  liquidatable.sort((a, b) => (a.healthFactor ?? Infinity) - (b.healthFactor ?? Infinity));
  const artifact = buildCompletionArtifact(coverage, liquidatable, dependencies.now ? new Date(dependencies.now) : new Date());
  logger.log(`\nChecked: ${coverage.positions.successfullyChecked}/${coverage.positions.discovered} | With debt: ${positionsWithDebt} | Liquidatable: ${liquidatable.length}`);
  logger.log(`Classification: ${artifact.classification}; valuationStatus=unavailable`);
  if (dependencies.writeArtifact !== false) writeArtifact(artifact, dependencies.outputPath || OUT);
  if (!artifact.complete && dependencies.setExitCode !== false) process.exitCode = 1;
  return artifact;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  MAX_BORROW_LOGS,
  MAX_BORROWERS_PER_MARKET,
  OUT,
  buildCompletionArtifact,
  main,
  scanBorrower,
  writeCompletionArtifact,
};
