#!/usr/bin/env node
"use strict";

// Offline triage, not execution readiness or a profitability estimate.
const fs = require("node:fs");
const path = require("node:path");

const OUTPUT_DIR = path.resolve(__dirname, "..", "reports", "raw", "fast", "divergence-readiness-step1");
const MAX_INPUT = 4 * 1024 * 1024;
const CHAINS = new Set([1, 8453, 42161, 999, 4663]);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MARKET = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const PAIR = /^[A-Za-z0-9._+?-]{1,32}\/[A-Za-z0-9._+?-]{1,32}$/;
const UNVERIFIED = ["publicFunding", "borrowExecutable", "exitExecutable", "gasSlippageBound", "conservativeNetPositive", "signedBatchValid"];

function requireSafe(condition, message) {
  if (!condition) throw new Error(message);
}

function checkRaw(value, name) {
  requireSafe(value === null || (typeof value === "string" && DECIMAL.test(value) && value.length <= 78), `invalid ${name}`);
}

function positive(value) { return value !== null && BigInt(value) > 0n; }

function validateSource(state) {
  requireSafe(state && typeof state === "object" && !Array.isArray(state) && state.schema === "oracle-divergence-monitor/v1", "invalid schema");
  requireSafe(typeof state.runId === "string" && /^[A-Za-z0-9._:-]{1,64}$/.test(state.runId), "invalid runId");
  requireSafe(typeof state.generatedAt === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(state.generatedAt) && Number.isFinite(Date.parse(state.generatedAt)), "invalid source timestamp");
  requireSafe(Array.isArray(state.sentinels) && state.sentinels.length > 0 && state.sentinels.length <= 512, "invalid sentinel universe");
  const identities = new Set(), ids = new Set();
  for (const row of state.sentinels) {
    requireSafe(row && typeof row === "object" && !Array.isArray(row), "invalid row");
    requireSafe(Number.isInteger(row.chainId) && CHAINS.has(row.chainId) && ADDRESS.test(row.oracle), "invalid identity");
    requireSafe(typeof row.sentinel === "string" && row.sentinel === `div:${row.chainId}:${row.oracle.slice(2, 10)}`, "invalid sentinel id");
    const identity = `${row.chainId}:${row.oracle.toLowerCase()}`;
    requireSafe(!identities.has(identity) && !ids.has(row.sentinel), "duplicate sentinel identity");
    identities.add(identity); ids.add(row.sentinel);
    requireSafe(row.marketId === null || (typeof row.marketId === "string" && MARKET.test(row.marketId)), "invalid marketId");
    requireSafe(row.pair === null || (typeof row.pair === "string" && PAIR.test(row.pair)), "invalid pair");
    for (const field of ["ok", "referenceOk", "fired", "actionable"]) requireSafe(typeof row[field] === "boolean", `invalid ${field}`);
    requireSafe(row.measurements === undefined || (row.measurements && typeof row.measurements === "object" && !Array.isArray(row.measurements)), "invalid measurements");
    checkRaw(row.borrowRaw, "borrowRaw");
    checkRaw(row.availableRaw, "availableRaw");
    if (row.measurements && row.measurements.oraclePrice !== undefined) {
      checkRaw(row.measurements.oraclePrice, "oraclePrice");
      requireSafe(row.measurements.oraclePrice !== null && positive(row.measurements.oraclePrice), "invalid oraclePrice");
    }
  }
  return state;
}

function buildReadiness(input) {
  const state = validateSource(input);
  const records = state.sentinels.map(row => {
    const measurements = row.measurements || {};
    const sourceReportedMarketBinding = row.ok && MARKET.test(row.marketId || "") &&
      ADDRESS.test(measurements.collateralToken || "") && ADDRESS.test(measurements.loanToken || "") &&
      typeof measurements.oraclePrice === "string" && positive(measurements.oraclePrice);
    const liquidityObserved = positive(row.borrowRaw) && positive(row.availableRaw);
    const hasSignalEvidence = row.ok && sourceReportedMarketBinding && liquidityObserved &&
      (row.referenceOk || (row.feedless === true && row.actionable === true));
    const triageTier = (row.fired || row.actionable) && hasSignalEvidence ? 1
      : row.ok && row.referenceOk && sourceReportedMarketBinding && liquidityObserved ? 2
        : !row.ok ? 3 : 4;
    return {
      chainId: row.chainId, sentinel: row.sentinel, oracle: row.oracle,
      marketId: row.marketId, pair: row.pair, sourceRunId: state.runId, sourceAt: state.generatedAt,
      monitorOk: row.ok, referenceOk: row.referenceOk, signalFired: row.fired,
      monitorActionableAsObserved: row.actionable, sourceReportedMarketBinding: Boolean(sourceReportedMarketBinding),
      liquidityObserved, gates: Object.fromEntries(UNVERIFIED.map(g => [g, "unknown"])),
      unverified: [...UNVERIFIED], routeReady: false, liveReady: false, profitRank: null,
      triageTier,
    };
  });
  records.sort((a, b) => a.triageTier - b.triageTier || a.chainId - b.chainId || a.sentinel.localeCompare(b.sentinel, "en"));
  const byChain = {};
  for (const chainId of [...CHAINS].sort((a, b) => a - b)) {
    const matches = records.filter(r => r.chainId === chainId);
    byChain[String(chainId)] = matches.length;
  }
  return {
    schema: "oracle-divergence-readiness-step1/v1", sourceRunId: state.runId,
    sourceAt: state.generatedAt,
    summary: {
      universe: records.length, byChain, monitorFailures: records.filter(r => !r.monitorOk).length,
      readableReferenceAndLiquidity: records.filter(r => r.monitorOk && r.referenceOk && r.liquidityObserved).length,
      tiers: Object.fromEntries([1, 2, 3, 4].map(n => [String(n), records.filter(r => r.triageTier === n).length])),
      routeReady: 0, liveReady: 0, profitRanked: 0,
      noProfitOrderReason: "No same-market verified public funding, executable borrow/exit, bounded gas/slippage, conservative positive net, or signed batch proof is accepted at this step; raw liquidity and monitor signals are not profit.",
      triageIsNotProfitOrder: true,
    },
    records,
  };
}

function checkNoSymlink(file, io = fs) {
  let current = path.parse(path.resolve(file)).root;
  for (const part of path.resolve(file).slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (io.existsSync(current)) requireSafe(!io.lstatSync(current).isSymbolicLink(), "symlink path refused");
  }
}

function readSource(file, io = fs) {
  checkNoSymlink(file, io);
  const stat = io.lstatSync(file);
  requireSafe(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= MAX_INPUT, "input must be bounded regular file");
  return validateSource(JSON.parse(io.readFileSync(file, "utf8")));
}

function outputPath(file) {
  const resolved = path.resolve(file);
  requireSafe(path.dirname(resolved) === OUTPUT_DIR && /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(path.basename(resolved)), "output outside allowlist");
  return resolved;
}

function writeNew(file, data) {
  const target = outputPath(file);
  checkNoSymlink(target);
  requireSafe(!fs.existsSync(target), "output already exists");
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  checkNoSymlink(target);
  const temporary = `${target}.${process.pid}.tmp`;
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, JSON.stringify(data, null, 2) + "\n");
    fs.fsyncSync(descriptor);
  } catch (error) {
    fs.closeSync(descriptor);
    fs.unlinkSync(temporary);
    throw error;
  }
  fs.closeSync(descriptor);
  try { fs.renameSync(temporary, target); }
  catch (error) { fs.unlinkSync(temporary); throw error; }
}

function argumentsOf(args) {
  requireSafe(args.length === 4 && args[0] === "--status" && args[2] === "--out" && Boolean(args[1]) && Boolean(args[3]), "required: --status <file> --out <allowlisted-new-file>");
  return { status: args[1], out: args[3] };
}

if (require.main === module) {
  try {
    const args = argumentsOf(process.argv.slice(2));
    const target = outputPath(args.out);
    const readiness = buildReadiness(readSource(args.status));
    writeNew(target, readiness);
    process.stdout.write(JSON.stringify({ universe: readiness.summary.universe, routeReady: 0, liveReady: 0 }) + "\n");
  } catch (_) {
    process.stderr.write("readiness input/output rejected; no profitability inferred\n");
    process.exitCode = 1;
  }
}

module.exports = { validateSource, buildReadiness, readSource, outputPath, argumentsOf };
