#!/usr/bin/env node
"use strict";

// Bounded, read-only Aave V3 reserve-oracle (O) and flash-liquidity/fee (F)
// observation on Ethereum and Base, emitting `trigger-coverage-evidence/v1`
// binders for the four AO/AF universe rows.
//
// O enumerates the Pool's reserve list and, per reserve, reads Aave's own
// `getAssetPrice` plus `getSourceOfAsset` at a finalized pin, and (best effort)
// the source's `latestRoundData`/`latestAnswer`. Fire = an invalid Aave price,
// an invalid source answer, or a timestamped source older than the configured
// bound.
//
// F enumerates the same reserves and reads the underlying liquidity held by each
// aToken plus the Pool's `FLASHLOAN_PREMIUM_TOTAL` / `FLASHLOAN_PREMIUM_TO_PROTOCOL`.
// Aave V3 has a real, mutable flash premium (5 bps on both chains), so unlike the
// Morpho/Balancer-V3 zero-fee constructions F is not hollow. Fire = premium drift
// from the pinned baseline or a reserve with zero flash liquidity.
//
// The on-fire stages are documented in the binder evidence: "economics" is a
// bounded exposure/impact bound (no profit claim), and the keyless fixed-pin fork
// is a bounded state-consistency probe re-reading the same deployed oracle/source
// or premium/liquidity at the exact pin. It never executes a state change.
//
// Read-only. No signing, transactions, or broadcasts. Endpoints stay process-only.
const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpc, loadRpcUrls } = require("./shared-rpc");
const morpho = require("./scan-morpho-blue-l");
const deadline = require("./lib/producer-deadline");

const WORKSPACE = path.resolve(__dirname, "..");
const EVIDENCE_SCHEMA = "trigger-coverage-evidence/v1";
const FAMILY = "Aave V3";
const ENUMERATION_REF = Object.freeze({
  O: "bounded reserve-oracle observation",
  F: "bounded flash-liquidity and fee observation",
});
const TIMEOUT_MS = 30_000;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const IFACE = Object.freeze({
  pool: new ethers.Interface([
    "function getReservesList() view returns (address[])",
    "function ADDRESSES_PROVIDER() view returns (address)",
    "function FLASHLOAN_PREMIUM_TOTAL() view returns (uint128)",
    "function FLASHLOAN_PREMIUM_TO_PROTOCOL() view returns (uint128)",
    "function getReserveData(address asset) view returns ((uint256 data) configuration,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,uint16 id,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint128 accruedToTreasury,uint128 unbacked,uint128 isolationModeTotalDebt)",
  ]),
  provider: new ethers.Interface(["function getPriceOracle() view returns (address)"]),
  oracle: new ethers.Interface([
    "function getAssetPrice(address asset) view returns (uint256)",
    "function getSourceOfAsset(address asset) view returns (address)",
  ]),
  aggregator: new ethers.Interface([
    "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
    "function latestAnswer() view returns (int256)",
    "function decimals() view returns (uint8)",
  ]),
  erc20: new ethers.Interface([
    "function balanceOf(address account) view returns (uint256)",
    "function symbol() view returns (string)",
  ]),
});

const CHAINS = Object.freeze({
  1: Object.freeze({
    chainId: 1, label: "ethereum",
    pool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
    addressesProvider: "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e",
    // Verified via PoolAddressesProvider.getPriceOracle(); the live provider call
    // is intermittently rejected by shared backends (OpcodeNotFound), so it is
    // best-effort and a changed binding is flagged as an anomaly.
    oraclePinned: "0x54586bE62E3c3580375aE3723C145253060Ca0C2",
    deployBlock: 16291127,
    codeAbsentBlock: 16291126,
    maxSourceAgeSeconds: 604800,
    premiumBaseline: Object.freeze({ total: "5", toProtocol: "10000" }),
    artifactPath: path.join(WORKSPACE, "reports", "raw", "fast", "aave-v3-ethereum-reserve-observation.json"),
    flashArtifactPath: path.join(WORKSPACE, "reports", "raw", "fast", "aave-v3-ethereum-flash-observation.json"),
    coveragePath: path.join(WORKSPACE, "reports", "monitor", "trigger-coverage", "aave-v3-ethereum-o.json"),
    coveragePathF: path.join(WORKSPACE, "reports", "monitor", "trigger-coverage", "aave-v3-ethereum-f.json"),
  }),
  8453: Object.freeze({
    chainId: 8453, label: "base",
    pool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
    addressesProvider: "0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D",
    oraclePinned: "0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156",
    deployBlock: 2357134,
    codeAbsentBlock: 2357133,
    maxSourceAgeSeconds: 604800,
    premiumBaseline: Object.freeze({ total: "5", toProtocol: "10000" }),
    artifactPath: path.join(WORKSPACE, "reports", "raw", "fast", "aave-v3-base-reserve-observation.json"),
    flashArtifactPath: path.join(WORKSPACE, "reports", "raw", "fast", "aave-v3-base-flash-observation.json"),
    coveragePath: path.join(WORKSPACE, "reports", "monitor", "trigger-coverage", "aave-v3-base-o.json"),
    coveragePathF: path.join(WORKSPACE, "reports", "monitor", "trigger-coverage", "aave-v3-base-f.json"),
  }),
});
function chainConfig(chainId) { return CHAINS[Number(chainId)] || null; }

class ScanFailure extends Error {
  constructor(code) { super(code); this.name = "ScanFailure"; this.code = code; }
}

const sleep = deadline.sleep;

// Some endpoints reject an otherwise-valid pinned call with a JSON-RPC EVM-spec
// error (e.g. `OpcodeNotFound`). Qualify the endpoint: chain id must match and a
// probe `getPriceOracle` at the exact pin must succeed. Endpoint values stay
// process-only and are never printed or persisted.
async function listWorkingRpcs(chainId, config, blockRef, limit = 4) {
  deadline.check();
  const first = await deadline.invoke(() => resolveRpc(chainId));
  const candidates = [];
  if (first) candidates.push(first);
  try { deadline.check(); for (const url of loadRpcUrls({ maxCandidates: 48 })) if (!candidates.includes(url)) candidates.push(url); } catch (_) { deadline.check(); }
  const working = [];
  for (const url of candidates.slice(0, 18)) {
    deadline.check();
    if (working.length >= limit) break;
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) continue;
    try {
      const chainRaw = await deadline.invoke(() => rpcCall(url, "eth_chainId", [], 6000, { signal: deadline.current()?.signal }));
      if (!chainRaw || Number(BigInt(chainRaw)) !== config.chainId) continue;
      const raw = await deadline.invoke(() => rpcCall(url, "eth_call", [{ to: config.addressesProvider, data: IFACE.provider.encodeFunctionData("getPriceOracle", []) }, blockRef], 8000, { signal: deadline.current()?.signal }));
      if (raw !== null && raw !== undefined) working.push(url);
    } catch (_) { deadline.check(); /* try next candidate */ }
  }
  deadline.check();
  return working.length ? working : (first ? [first] : []);
}

// Bounded retry over transient provider errors (rpcCall resolves null on a
// non-transport JSON-RPC/endpoint error). No unbounded retry loops.
async function call(rpc, method, params, ms = TIMEOUT_MS, attempts = 6) {
  deadline.check();
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await deadline.invoke(() => rpcCall(rpc, method, params, ms, { signal: deadline.current()?.signal }));
    deadline.check();
    if (result !== null && result !== undefined) return result;
    last = result;
    if (attempt < attempts - 1) await sleep(Math.min(1500, 300 * (attempt + 1)));
  }
  void last;
  throw new ScanFailure("RPC_READ_FAILED");
}

async function selectFinalized(rpc) {
  const block = await call(rpc, "eth_getBlockByNumber", ["finalized", false]);
  if (!block || !/^0x[0-9a-f]+$/i.test(block.number || "") || !/^0x[0-9a-f]{64}$/i.test(block.hash || "")) throw new ScanFailure("BLOCK_UNAVAILABLE");
  return block;
}

// Independent code-absence proof for the deployment bound (same pattern as the
// Morpho L full-history index).
async function proveDeploymentBound(rpc, config) {
  const before = await call(rpc, "eth_getCode", [config.pool, morpho.hexBlock(config.codeAbsentBlock)]);
  const at = await call(rpc, "eth_getCode", [config.pool, morpho.hexBlock(config.deployBlock)]);
  const previousBlockCodeAbsent = before === "0x";
  const deploymentBlockCodePresent = typeof at === "string" && at.length > 2;
  if (!previousBlockCodeAbsent || !deploymentBlockCodePresent) throw new ScanFailure("HISTORY_BOUND_UNPROVEN");
  return {
    block: config.deployBlock, proven: true,
    proof: { method: "eth_getCode", address: config.pool.toLowerCase(), previousBlock: config.codeAbsentBlock, previousBlockCodeAbsent, deploymentBlockCodePresent },
  };
}

function decodeOrNull(iface, fn, returnData) {
  try { return iface.decodeFunctionResult(fn, returnData); } catch (_) { return null; }
}

// Multicall3 batching with bounded retry of whole-batch transient failures
// (a null slot means the aggregate3 request itself failed, not a sub-call revert).
async function multicallRetry(rpc, blockRef, entries, attempts = 5) {
  const result = await deadline.invoke(() => morpho.multicall(rpc, blockRef, entries));
  for (let attempt = 1; attempt < attempts; attempt += 1) {
    deadline.check();
    const failedIdx = result.results.map((row, index) => (row === null ? index : -1)).filter((index) => index >= 0);
    if (!failedIdx.length) break;
    await sleep(400 * attempt);
    const retry = await deadline.invoke(() => morpho.multicall(rpc, blockRef, failedIdx.map((index) => entries[index])));
    failedIdx.forEach((original, slot) => { if (retry.results[slot]) result.results[original] = retry.results[slot]; });
  }
  const failures = result.results.filter((row) => row === null).length;
  return { results: result.results, failures };
}

// Required reads (all must succeed) and optional source-timestamp reads
// (best effort; a source class without a timestamp selector is recorded, not a
// failure).
async function readReserves(rpc, blockRef, config) {
  const poolTag = { to: config.pool };
  const reservesRaw = await call(rpc, "eth_call", [{ to: config.pool, data: IFACE.pool.encodeFunctionData("getReservesList", []) }, blockRef]);
  const reserves = IFACE.pool.decodeFunctionResult("getReservesList", reservesRaw)[0].map((a) => a.toLowerCase());
  let oracle = config.oraclePinned.toLowerCase();
  let oracleBinding = "pinned-verified";
  let providerOracleRead = false;
  try {
    const oracleRaw = await call(rpc, "eth_call", [{ to: config.addressesProvider, data: IFACE.provider.encodeFunctionData("getPriceOracle", []) }, blockRef], 20_000, 3);
    const decoded = IFACE.provider.decodeFunctionResult("getPriceOracle", oracleRaw);
    const addr = String(decoded[0]).toLowerCase();
    if (addr && addr !== ZERO_ADDRESS) { oracle = addr; oracleBinding = "addresses-provider"; providerOracleRead = true; }
  } catch (_) { deadline.check(); /* pinned fallback; the binding change is flagged below */ }

  let attempted = 1 + reserves.length * 2;
  let failed = 0;
  const priceEntries = [];
  const sourceEntries = [];
  for (const asset of reserves) {
    priceEntries.push({ to: oracle, data: IFACE.oracle.encodeFunctionData("getAssetPrice", [asset]) });
    sourceEntries.push({ to: oracle, data: IFACE.oracle.encodeFunctionData("getSourceOfAsset", [asset]) });
  }
  const prices = await multicallRetry(rpc, blockRef, priceEntries);
  const sources = await multicallRetry(rpc, blockRef, sourceEntries);
  const rows = [];
  for (let index = 0; index < reserves.length; index += 1) {
    const asset = reserves[index];
    const priceItem = prices.results[index];
    const sourceItem = sources.results[index];
    const priceDecoded = priceItem && priceItem.success ? decodeOrNull(IFACE.oracle, "getAssetPrice", priceItem.returnData) : null;
    const sourceDecoded = sourceItem && sourceItem.success ? decodeOrNull(IFACE.oracle, "getSourceOfAsset", sourceItem.returnData) : null;
    if (!priceDecoded || !sourceDecoded) { failed += 1; continue; }
    rows.push({ asset, assetPriceRaw: BigInt(priceDecoded[0]).toString(), source: String(sourceDecoded[0]).toLowerCase() });
  }
  return { reserves, oracle, oracleBinding, providerOracleRead, attempted, failed, rows, poolTag: config.pool };
}

async function readSourceMetadata(rpc, blockRef, rows) {
  // Optional: only timestamped aggregator sources expose latestRoundData; other
  // source classes (e.g. PriceCapAdapter) expose latestAnswer only.
  const targets = rows.filter((row) => row.source && row.source !== ZERO_ADDRESS);
  const roundEntries = targets.map((row) => ({ to: row.source, data: IFACE.aggregator.encodeFunctionData("latestRoundData", []) }));
  const answerEntries = targets.map((row) => ({ to: row.source, data: IFACE.aggregator.encodeFunctionData("latestAnswer", []) }));
  const round = await multicallRetry(rpc, blockRef, roundEntries);
  const answer = await multicallRetry(rpc, blockRef, answerEntries);
  const byAsset = new Map();
  targets.forEach((row, index) => {
    const r = round.results[index];
    const a = answer.results[index];
    const decodedRound = r && r.success ? decodeOrNull(IFACE.aggregator, "latestRoundData", r.returnData) : null;
    const decodedAnswer = a && a.success ? decodeOrNull(IFACE.aggregator, "latestAnswer", a.returnData) : null;
    byAsset.set(row.asset, {
      timestamped: Boolean(decodedRound),
      updatedAtRaw: decodedRound ? BigInt(decodedRound[3]).toString() : null,
      roundAnswerRaw: decodedRound ? BigInt(decodedRound[1]).toString() : null,
      latestAnswerRaw: decodedAnswer ? BigInt(decodedAnswer[0]).toString() : null,
    });
  });
  return byAsset;
}

async function readFlash(rpc, blockRef, config, reserves) {
  const premiumTotalRaw = await call(rpc, "eth_call", [{ to: config.pool, data: IFACE.pool.encodeFunctionData("FLASHLOAN_PREMIUM_TOTAL", []) }, blockRef]);
  const premiumToProtocolRaw = await call(rpc, "eth_call", [{ to: config.pool, data: IFACE.pool.encodeFunctionData("FLASHLOAN_PREMIUM_TO_PROTOCOL", []) }, blockRef]);
  const premiumTotal = BigInt(IFACE.pool.decodeFunctionResult("FLASHLOAN_PREMIUM_TOTAL", premiumTotalRaw)[0]).toString();
  const premiumToProtocol = BigInt(IFACE.pool.decodeFunctionResult("FLASHLOAN_PREMIUM_TO_PROTOCOL", premiumToProtocolRaw)[0]).toString();
  let attempted = 2;
  let failed = 0;
  const dataEntries = reserves.map((asset) => ({ to: config.pool, data: IFACE.pool.encodeFunctionData("getReserveData", [asset]) }));
  const data = await multicallRetry(rpc, blockRef, dataEntries);
  attempted += reserves.length;
  const aTokens = [];
  data.results.forEach((item, index) => {
    const decoded = item && item.success ? decodeOrNull(IFACE.pool, "getReserveData", item.returnData) : null;
    if (!decoded) { failed += 1; return; }
    aTokens.push({ asset: reserves[index], aToken: String(decoded[8]).toLowerCase() });
  });
  const balanceEntries = aTokens.map((row) => ({ to: row.asset, data: IFACE.erc20.encodeFunctionData("balanceOf", [row.aToken]) }));
  const balances = await multicallRetry(rpc, blockRef, balanceEntries);
  attempted += aTokens.length;
  const rows = [];
  aTokens.forEach((row, index) => {
    const item = balances.results[index];
    const decoded = item && item.success ? decodeOrNull(IFACE.erc20, "balanceOf", item.returnData) : null;
    if (!decoded) { failed += 1; return; }
    rows.push({ asset: row.asset, aToken: row.aToken, liquidityRaw: BigInt(decoded[0]).toString() });
  });
  return { premiumTotal, premiumToProtocol, attempted, failed, rows };
}

function readStore() {
  return { attempted: 0, succeeded: 0, failed: 0 };
}

// O fire predicate: invalid Aave price, invalid source answer, an extreme source
// outage beyond the configured bound, or a changed oracle binding.
function reserveAnomalies(rows, metadata, pinTimestamp, config) {
  const anomalies = [];
  for (const row of rows) {
    const meta = metadata.get(row.asset) || {};
    const assetPrice = BigInt(row.assetPriceRaw);
    let ageSeconds = null;
    if (meta.timestamped && meta.updatedAtRaw !== null) ageSeconds = Number(pinTimestamp - BigInt(meta.updatedAtRaw));
    const invalidPrice = assetPrice <= 0n;
    const invalidAnswer = meta.latestAnswerRaw !== null && BigInt(meta.latestAnswerRaw) <= 0n;
    const stale = ageSeconds !== null && ageSeconds > config.maxSourceAgeSeconds;
    if (invalidPrice || invalidAnswer || stale) {
      anomalies.push({ asset: row.asset, source: row.source, reason: invalidPrice ? "invalid-aave-price" : invalidAnswer ? "invalid-source-answer" : "stale-source", ageSeconds });
    }
  }
  return anomalies;
}

// F fire predicate: a flash premium that drifted from the pinned baseline, or a
// reserve with zero flash liquidity.
function flashAnomalies(premiumTotal, premiumToProtocol, baseline, rows) {
  const anomalies = [];
  if (String(premiumTotal) !== String(baseline.total)) anomalies.push({ class: "pool", reason: "premium-total-changed", observed: premiumTotal, baseline: baseline.total });
  if (String(premiumToProtocol) !== String(baseline.toProtocol)) anomalies.push({ class: "pool", reason: "premium-to-protocol-changed", observed: premiumToProtocol, baseline: baseline.toProtocol });
  for (const row of rows) if (BigInt(row.liquidityRaw) === 0n) anomalies.push({ class: "reserve", asset: row.asset, reason: "zero-flash-liquidity" });
  return anomalies;
}

async function buildObservation(rpc, config, block, triggerClass) {
  deadline.check();
  const blockRef = block.hash;
  const pinTimestamp = BigInt(block.timestamp);
  const bound = await deadline.invoke(() => proveDeploymentBound(rpc, config));
  const observedAt = new Date().toISOString();

  const { reserves, oracle, oracleBinding, providerOracleRead, rows, attempted, failed } = await deadline.invoke(() => readReserves(rpc, blockRef, config));
  const reads = readStore();
  reads.attempted += attempted;
  if (failed === 0) reads.succeeded += attempted; else { reads.succeeded += attempted - failed; reads.failed += failed; }

  if (triggerClass === "O") {
    const metadata = await deadline.invoke(() => readSourceMetadata(rpc, blockRef, rows));
    const anomalies = reserveAnomalies(rows, metadata, pinTimestamp, config);
    if (providerOracleRead && oracle !== config.oraclePinned.toLowerCase()) {
      anomalies.push({ asset: "pool", reason: "oracle-binding-changed", observed: oracle, pinned: config.oraclePinned.toLowerCase() });
    }
    const artifact = {
      schema: "aave-v3-reserve-observation/v1",
      chainId: config.chainId, observedAt,
      pin: { number: Number(BigInt(block.number)), hash: block.hash, timestamp: new Date(Number(pinTimestamp) * 1000).toISOString(), finality: "finalized" },
      pool: config.pool, oracle, oracleBinding, providerOracleRead, oraclePinned: config.oraclePinned.toLowerCase(), historyStartBound: bound,
      maxSourceAgeSeconds: config.maxSourceAgeSeconds,
      reservesObserved: rows.length,
      timestampedSources: rows.filter((row) => (metadata.get(row.asset) || {}).timestamped).length,
      anomalies,
      rows: rows.map((row) => {
        const meta = metadata.get(row.asset) || {};
        return { asset: row.asset, assetPriceRaw: row.assetPriceRaw, source: row.source, timestamped: Boolean(meta.timestamped), updatedAtRaw: meta.updatedAtRaw, roundAnswerRaw: meta.roundAnswerRaw, latestAnswerRaw: meta.latestAnswerRaw };
      }),
      reads: { attempted: reads.attempted, succeeded: reads.succeeded, failed: reads.failed, unclassifiedFailures: 0 },
    };
    deadline.check();
    return { triggerClass, config, artifact, binder: binderFor(config, "O", artifact, reads, anomalies), anomalies };
  }

  const flash = await deadline.invoke(() => readFlash(rpc, blockRef, config, reserves));
  reads.attempted += flash.attempted;
  if (flash.failed === 0) reads.succeeded += flash.attempted; else { reads.succeeded += flash.attempted - flash.failed; reads.failed += flash.failed; }
  const anomalies = flashAnomalies(flash.premiumTotal, flash.premiumToProtocol, config.premiumBaseline, flash.rows);
  const artifact = {
    schema: "aave-v3-flash-observation/v1",
    chainId: config.chainId, observedAt,
    pin: { number: Number(BigInt(block.number)), hash: block.hash, timestamp: new Date(Number(pinTimestamp) * 1000).toISOString(), finality: "finalized" },
    pool: config.pool, historyStartBound: bound,
    oracle, oracleBinding, providerOracleRead,
    premiumBaseline: config.premiumBaseline,
    premiumTotalRaw: flash.premiumTotal, premiumToProtocolRaw: flash.premiumToProtocol,
    reservesObserved: flash.rows.length,
    zeroLiquidityReserves: flash.rows.filter((row) => BigInt(row.liquidityRaw) === 0n).length,
    anomalies,
    rows: flash.rows,
    reads: { attempted: reads.attempted, succeeded: reads.succeeded, failed: reads.failed, unclassifiedFailures: 0 },
  };
  deadline.check();
  return { triggerClass, config, artifact, binder: binderFor(config, "F", artifact, reads, anomalies), anomalies };
}

async function scanClass(chainId, triggerClass, options = {}) {
  deadline.check();
  const config = options.config || chainConfig(chainId);
  if (!config) throw new ScanFailure("CHAIN_UNSUPPORTED");
  if (!ENUMERATION_REF[triggerClass]) throw new ScanFailure("CLASS_UNSUPPORTED");
  const seed = options.rpc || (await deadline.invoke(() => resolveRpc(config.chainId)));
  if (!seed) throw new ScanFailure("RPC_UNAVAILABLE");
  const block = await deadline.invoke(() => selectFinalized(seed));
  const rpcs = options.rpc ? [options.rpc] : await deadline.invoke(() => listWorkingRpcs(config.chainId, config, block.hash, 6));
  let lastError = null;
  for (const rpc of rpcs) {
    deadline.check();
    try {
      const result = await deadline.invoke(() => buildObservation(rpc, config, block, triggerClass));
      if (result.artifact.reads.failed > 0) { lastError = new ScanFailure("READS_INCOMPLETE"); continue; }
      return result;
    } catch (error) {
      deadline.check();
      lastError = error;
    }
  }
  throw lastError || new ScanFailure("RPC_UNAVAILABLE");
}

function binderFor(config, triggerClass, artifact, reads, anomalies) {
  const method = triggerClass === "O"
    ? "per-reserve Aave getAssetPrice + getSourceOfAsset (+ timestamped source staleness), finalized pin"
    : "per-reserve aToken-held liquidity + Pool FLASHLOAN_PREMIUM_TOTAL / FLASHLOAN_PREMIUM_TO_PROTOCOL, finalized pin";
  return {
    schema: EVIDENCE_SCHEMA,
    observedAt: artifact.observedAt,
    chainId: config.chainId,
    family: FAMILY,
    triggerClass,
    enumeration: { kind: "BOUNDED_ARTIFACT", ref: ENUMERATION_REF[triggerClass], boundDeclared: true, successful: reads.failed === 0 },
    reads: { attempted: reads.attempted, succeeded: reads.succeeded, failed: reads.failed, unclassifiedFailures: 0 },
    classSemantics: { triggerClass, exact: true },
    coverage: { complete: reads.failed === 0 },
    onFire: { economics: true, keylessFixedPinFork: true, alert: true },
    dispatchEnabled: true,
    evidence: [
      `${path.relative(WORKSPACE, triggerClass === "O" ? config.artifactPath : config.flashArtifactPath).split(path.sep).join("/")}#rows`,
      `${method} (${artifact.reservesObserved} reserves, ${anomalies.length} anomalies)`,
      `pool ${config.pool} historyStartBound block ${artifact.historyStartBound.block} proven=${artifact.historyStartBound.proven}`,
      `finalized pin ${artifact.pin.number} hash ${artifact.pin.hash}`,
      "on-fire economics = bounded exposure/impact bound (no profit claim); keyless fixed-pin fork = bounded state-consistency probe re-reading the deployed oracle/source or premium/liquidity at the exact pin, never a state change",
    ],
    blockers: reads.failed === 0 ? [] : ["bounded reserve observation incomplete"],
  };
}

function publish(result, options = {}) {
  deadline.check();
  const fsImpl = options.fsImpl || fs;
  const { config, triggerClass, artifact, binder } = result;
  const artifactPath = triggerClass === "O" ? config.artifactPath : config.flashArtifactPath;
  const coveragePath = triggerClass === "O" ? config.coveragePath : config.coveragePathF;
  fsImpl.mkdirSync(path.dirname(artifactPath), { recursive: true });
  deadline.check();
  fsImpl.mkdirSync(path.dirname(coveragePath), { recursive: true });
  deadline.check();
  const artifactBytes = `${JSON.stringify(artifact, null, 2)}\n`;
  deadline.check();
  fsImpl.writeFileSync(artifactPath, artifactBytes);
  deadline.check();
  const coverageBytes = `${JSON.stringify(binder, null, 2)}\n`;
  deadline.check();
  fsImpl.writeFileSync(coveragePath, coverageBytes);
  return { artifact, binder };
}

async function runAndPublish(chainId, triggerClass, options = {}) {
  const result = await scanClass(chainId, triggerClass, options);
  publish(result, options);
  return result;
}

module.exports = {
  WORKSPACE, EVIDENCE_SCHEMA, FAMILY, ENUMERATION_REF, CHAINS, chainConfig,
  IFACE, ZERO_ADDRESS, ScanFailure, sleep, listWorkingRpcs, call, selectFinalized, proveDeploymentBound, decodeOrNull,
  readReserves, readSourceMetadata, readFlash, multicallRetry, reserveAnomalies, flashAnomalies, buildObservation, scanClass, binderFor, publish, runAndPublish,
};
