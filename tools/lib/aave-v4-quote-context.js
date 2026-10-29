"use strict";

// Quote-local capture reuse and lifetime. Not a discovery collector or executor.
const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { ethers } = require("ethers");
const coverage = require("../aave-source-coverage");
const { openPinnedCollection, CollectionError, LIMITS: COLLECTION_LIMITS } = require("./aave-v4-pinned-collection");
const { TOPOLOGY_MAX_AGE_MS } = require("../scan-aave-v4-spoke-borrowers");
const { buildTopologySourceCoverage, loadAaveV4EthereumRegistry } = require("../scan-aave-v4-hubs");

const LIMITS = Object.freeze({ candidates: 2, reserves: 24, pairs: 2, sizes: 4,
  paths: 16, mids: 2, pools: 1, discoveries: 12, discoveryMs: 2000,
  maxMs: 90000, maxRequests: 800, maxContracts: 96 });
const ETH_FEED = "0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419";
// Existing Ethereum Chainlink policy: scan-cross-dex-arbitrage.js CHAINLINK.
const ETH_MAX_AGE_SECONDS = 3600;
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const sessions = new WeakMap();
const prepared = new WeakMap();
const I = Object.freeze({
  spoke: new ethers.Interface([
    "function getReserve(uint256) view returns (address,address,uint16,uint8,uint24,uint8,uint32)",
    "function getUserPosition(uint256,address) view returns ((uint120 drawnShares,uint120 premiumShares,int200 premiumOffsetRay,uint120 suppliedShares,uint32 dynamicConfigKey))",
    "function getDynamicReserveConfig(uint256,uint32) view returns (uint16,uint32,uint16)",
    "function getReserveConfig(uint256) view returns (uint24,bool,bool,bool,bool)",
    "function getLiquidationConfig() view returns (uint128,uint64,uint16)",
    "function getLiquidationBonus(uint256,address,uint256) view returns (uint256)",
    "function ORACLE() view returns (address)",
  ]),
  oracle: new ethers.Interface([
    "function spoke() view returns (address)", "function decimals() view returns (uint8)",
    "function getReserveSource(uint256) view returns (address)",
    "function getReservePrice(uint256) view returns (uint256)",
  ]),
  feed: new ethers.Interface([
    "function decimals() view returns (uint8)",
    "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  ]),
  token: new ethers.Interface(["function balanceOf(address) view returns (uint256)"]),
});
class QuoteError extends Error {
  constructor(code) {
    const safe = typeof code === "string" && /^[A-Z][A-Z0-9_]{0,70}$/.test(code) ? code : "QUOTE_CONTEXT_UNAVAILABLE";
    super(safe); this.code = safe;
  }
}
function fail(code) { throw new QuoteError(code); }
function address(value) { try { return ethers.getAddress(value).toLowerCase(); } catch (_) { fail("IDENTITY_INVALID"); } }
function uint(value) { if (typeof value !== "string" || !/^\d+$/.test(value)) fail("RAW_AMOUNT_INVALID"); return BigInt(value); }
function digest(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function pinEqual(a, b) { return a?.chainId === 1 && b?.chainId === 1 && /^0x[0-9a-f]{64}$/i.test(a.stateRoot || "") && a.blockNumber === b.blockNumber
  && a.blockHash?.toLowerCase() === b.blockHash?.toLowerCase() && a.stateRoot === b.stateRoot && a.finality === b.finality; }
function sourceAge(timestamp, now, maximum) { const age = now - Date.parse(timestamp); return Number.isFinite(age) && age >= 0 && age <= maximum; }

function validateSources(sources, nowMs, consumerMaxAgeMs = TOPOLOGY_MAX_AGE_MS) {
  const failures = [];
  const { borrowers: b, hubs: h, watch: w } = sources || {};
  const ttl = Math.min(TOPOLOGY_MAX_AGE_MS, consumerMaxAgeMs);
  if (!Number.isSafeInteger(ttl) || ttl <= 0) failures.push("SOURCE_TTL_INVALID");
  for (const [label, artifact, kind] of [["BORROWER", b, "borrower-scan"], ["TOPOLOGY", h, "topology"], ["WATCH", w?.latest, "monitor"]]) {
    const c = artifact?.sourceCoverage;
    const envelope = coverage.validateAaveSourceCoverageEnvelope(c, { protocolVersion: "V4", coverageKind: kind, requireSampleComplete: true });
    if (!envelope.valid || !coverage.validV4ObservationPin(c)) failures.push(`${label}_COVERAGE_INVALID`);
    // Topology is a bounded authoritative sample, not a full-history proof.
    if (kind !== "topology" && (c?.complete !== true || c?.sampleComplete !== true
      || !coverage.validateV4ExhaustiveEvidence(c).valid)) failures.push(`${label}_NOT_COMPLETE`);
  }
  if (!coverage.validateV4TopologyAuthority(h?.sourceCoverage).valid) failures.push("TOPOLOGY_AUTHORITY_INVALID");
  const bp = b?.sourceCoverage?.observationPin;
  if (!pinEqual(bp, h?.sourceCoverage?.observationPin) || !pinEqual(bp, w?.latest?.sourceCoverage?.observationPin)) failures.push("SOURCE_PIN_MISMATCH");
  for (const [label, artifact] of [["BORROWER", b], ["TOPOLOGY", h], ["WATCH", w?.latest]]) {
    const chain = artifact?.chain;
    if (chain?.id !== 1 || !pinEqual(bp, { ...chain, chainId: chain.id })
      || !Number.isSafeInteger(chain.timestamp) || chain.timestamp <= 0
      || chain.timestamp !== b?.chain?.timestamp) failures.push(`${label}_HEADER_BINDING_INVALID`);
    const pinAge = nowMs - Number(chain?.timestamp) * 1000;
    if (!Number.isFinite(pinAge) || pinAge < 0 || pinAge > COLLECTION_LIMITS.maxPinAgeMs) failures.push(`${label}_FINALIZED_PIN_STALE`);
  }
  if (!isDeepStrictEqual(b?.sourceCoverage?.topologySourceCoverage, h?.sourceCoverage)
    || b?.sourceCoverage?.topologyGeneratedAt !== h?.generatedAt
    || b?.sourceCoverage?.topologyUniverse?.inventoryDigest !== h?.sourceCoverage?.topologyUniverse?.inventoryDigest
    || !isDeepStrictEqual(b?.sourceCoverage?.consumedReserveLinks, h?.sourceCoverage?.consumedReserveLinks)) failures.push("TOPOLOGY_CAPTURE_MISMATCH");
  if (w?.latest?.sourceGeneratedAt !== b?.generatedAt
    || !isDeepStrictEqual(w?.latest?.sourceCoverage?.topologySourceCoverage, h?.sourceCoverage)
    || !isDeepStrictEqual(w?.latest?.sourceCoverage?.consumedReserveLinks, b?.sourceCoverage?.consumedReserveLinks)
    || (w?.sourceCoverage && !isDeepStrictEqual(w.sourceCoverage, w.latest?.sourceCoverage))) failures.push("WATCH_CAPTURE_MISMATCH");
  for (const [label, timestamp] of [["BORROWER", b?.generatedAt], ["TOPOLOGY", h?.generatedAt], ["WATCH", w?.generatedAt], ["WATCH_LATEST", w?.latest?.generatedAt]]) {
    if (!sourceAge(timestamp, nowMs, ttl)) failures.push(`${label}_STALE_OR_UNDATED`);
  }
  if (!Array.isArray(w?.latest?.quoteRequiredRows)) failures.push("TRIGGER_LIST_INVALID");
  const bindings = new Map();
  try {
    // Re-evaluate the actual serialized directory, not just its copied envelope.
    const registry = loadAaveV4EthereumRegistry();
    if (!Array.isArray(h?.hubs) || h.hubs.length !== registry.hubs.length
      || new Set(h.hubs.map(row => address(row.address))).size !== registry.hubs.length
      || !registry.hubs.every(row => h.hubs.some(hub => address(hub.address) === address(row.address)))) fail("TOPOLOGY_HUB_SET_INVALID");
    const rebuilt = buildTopologySourceCoverage(h.hubs, registry);
    for (const field of ["topologyUniverse", "consumedReserveLinks", "spokeReserveLinks", "hubsObserved", "assetsObserved", "stateReadsAttempted", "stateReadsSucceeded", "stateReadsFailed", "sampleComplete"])
      if (!isDeepStrictEqual(rebuilt[field], h.sourceCoverage[field])) fail("TOPOLOGY_DIRECTORY_MISMATCH");
    for (const link of h?.sourceCoverage?.consumedReserveLinks || []) {
      const hub = h.hubs.find(row => address(row.address) === address(link.hubAddress));
      const asset = hub?.assets?.find(row => Number(row.assetId) === link.assetId);
      const directory = asset?.spokeDirectory?.rows?.find(row => address(row.address) === address(link.spoke) && row.reserve?.reserveId === link.reserveId);
      const reserve = directory?.reserve?.reserve;
      if (!asset || !reserve || address(reserve.hub) !== address(hub.address)
        || Number(reserve.assetId) !== Number(asset.assetId) || address(reserve.underlying) !== address(asset.underlying)
        || !Number.isInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 36
        || !Number.isInteger(reserve.decimals) || reserve.decimals !== asset.decimals) fail("TOPOLOGY_IDENTITY_INVALID");
      const key = `${address(link.spoke)}:${link.reserveId}`;
      if (bindings.has(key)) fail("TOPOLOGY_IDENTITY_DUPLICATE");
      const oracle = directory.reserve.oracleData;
      if (address(oracle?.spoke) !== address(link.spoke) || !Number.isInteger(oracle.decimals)
        || oracle.decimals < 0 || oracle.decimals > 36 || uint(oracle.priceRaw) <= 0n) fail("CAPTURED_ORACLE_INVALID");
      bindings.set(key, { hubAddress: address(hub.address), underlying: address(asset.underlying), assetId: Number(asset.assetId), decimals: Number(asset.decimals), reserveId: link.reserveId,
        capturedOracle: { address: address(oracle.address), source: address(oracle.source), decimals: oracle.decimals, priceRaw: oracle.priceRaw } });
    }
  } catch (_) { failures.push("TOPOLOGY_IDENTITY_INVALID"); }
  return { valid: failures.length === 0, failures: [...new Set(failures)], pin: bp || null, bindings,
    provenance: { sourceTtlMs: ttl, inventoryDigest: h?.sourceCoverage?.topologyUniverse?.inventoryDigest || null,
      borrowers: { generatedAt: b?.generatedAt || null, ageMs: nowMs - Date.parse(b?.generatedAt), sha256: digest(b || null), pin: bp || null, chain: b?.chain || null },
      topology: { generatedAt: h?.generatedAt || null, ageMs: nowMs - Date.parse(h?.generatedAt), sha256: digest(h || null), pin: h?.sourceCoverage?.observationPin || null, chain: h?.chain || null },
      watch: { generatedAt: w?.generatedAt || null, ageMs: nowMs - Date.parse(w?.generatedAt), sha256: digest(w || null), sourceGeneratedAt: w?.latest?.sourceGeneratedAt || null,
        pin: w?.latest?.sourceCoverage?.observationPin || null, chain: w?.latest?.chain || null } } };
}

async function begin(sources, options = {}) {
  const now = options.now || Date.now;
  const validated = validateSources(sources, now(), options.consumerMaxAgeMs);
  if (!validated.valid) fail(validated.failures[0]);
  const started = now();
  const raw = await (options.openCollection || openPinnedCollection)({ chainId: 1,
    requestedPin: validated.pin, probeAddress: sources.hubs.hubs[0].address, now,
    limits: { maxMs: LIMITS.maxMs, maxRequests: LIMITS.maxRequests, timeoutMs: 5000, concurrency: 2, reserveRequests: 8 } });
  if (raw.chainId !== 1 || raw.pin.number !== validated.pin.blockNumber || raw.pin.hash.toLowerCase() !== validated.pin.blockHash.toLowerCase()
    || raw.pin.stateRoot !== validated.pin.stateRoot || !Number.isSafeInteger(Number(raw.pin.timestamp))
    || [sources.hubs.chain, sources.borrowers.chain, sources.watch.latest.chain].some(chain => chain.timestamp !== Number(raw.pin.timestamp))) {
    await raw.confirmPin().catch(() => {}); fail("COLLECTOR_PIN_MISMATCH");
  }
  const session = { sources, now, started, validated, raw, limits: LIMITS, closed: false, fatal: new Set(), runtimes: new Map(),
    counters: { attempted: 0, resolved: 0, expectedReverts: 0, failed: 0, discoveries: 0 },
    oracleQualification: { denomination: "UNKNOWN", heartbeat: "UNKNOWN", reviewedRuntime: "UNKNOWN" },
    fundingEvidence: options.fundingEvidence || null, fundingBalances: new Map(), truncation: new Set() };
  session.assertOpen = () => {
    if (session.closed) fail("QUOTE_CONTEXT_CLOSED");
    if (session.fatal.size) fail("QUOTE_CONTEXT_INVALID");
    if (now() - started >= LIMITS.maxMs || !raw.canCollect()) { session.fatal.add("QUOTE_BUDGET_EXHAUSTED"); fail("QUOTE_BUDGET_EXHAUSTED"); }
  };
  session.read = async (method, ...args) => {
    session.assertOpen(); session.counters.attempted += 1;
    try { const value = await raw.provider[method](...args); session.counters.resolved += 1; return value; }
    catch (error) {
      if (error?.code === "CALL_EXCEPTION") { session.counters.expectedReverts += 1; session.counters.resolved += 1; }
      else { session.counters.failed += 1; session.fatal.add("PINNED_TRANSPORT_OR_BUDGET_FAILURE"); }
      throw new QuoteError(error?.code === "CALL_EXCEPTION" ? "CALL_EXCEPTION" : "PINNED_TRANSPORT_OR_BUDGET_FAILURE");
    }
  };
  session.captureRuntime = async target => {
    session.assertOpen(); const to = address(target);
    if (session.runtimes.has(to)) return session.runtimes.get(to);
    if (session.runtimes.size >= LIMITS.maxContracts) { session.fatal.add("RUNTIME_CAP"); fail("RUNTIME_CAP"); }
    const code = await session.read("getCode", to);
    if (!/^0x(?:[0-9a-f]{2})+$/i.test(code || "")) { session.fatal.add("EMPTY_RUNTIME"); fail("EMPTY_RUNTIME"); }
    const record = { address: to, codeHash: ethers.keccak256(code), implementation: null, implementationCodeHash: null, reviewedSourceEquivalence: "UNKNOWN" };
    session.runtimes.set(to, record);
    const slot = await session.read("getStorage", to, IMPL_SLOT);
    if (!/^0x[0-9a-f]{64}$/i.test(slot || "")) { session.fatal.add("IMPLEMENTATION_SLOT_INVALID"); fail("IMPLEMENTATION_SLOT_INVALID"); }
    if (!/^0x0{64}$/i.test(slot)) {
      record.implementation = address(`0x${slot.slice(-40)}`);
      const implementationCode = await session.read("getCode", record.implementation);
      if (!/^0x(?:[0-9a-f]{2})+$/i.test(implementationCode || "")) { session.fatal.add("EMPTY_IMPLEMENTATION_RUNTIME"); fail("EMPTY_IMPLEMENTATION_RUNTIME"); }
      record.implementationCodeHash = ethers.keccak256(implementationCode);
    }
    return record;
  };
  session.provider = Object.freeze({ call: async transaction => {
    await session.captureRuntime(transaction.to);
    return session.read("call", transaction);
  } });
  sessions.set(session.provider, session);
  session.required = async (target, iface, fn, args = []) => {
    try {
      const value = await session.provider.call({ to: address(target), data: iface.encodeFunctionData(fn, args) });
      return iface.decodeFunctionResult(fn, value);
    } catch (_) { session.fatal.add("REQUIRED_PINNED_READ_FAILED"); fail("REQUIRED_PINNED_READ_FAILED"); }
  };
  session.discover = async operation => {
    session.assertOpen();
    if (++session.counters.discoveries > LIMITS.discoveries) { session.fatal.add("DISCOVERY_CAP"); fail("DISCOVERY_CAP"); }
    const controller = new AbortController();
    const timeout = Math.min(LIMITS.discoveryMs, LIMITS.maxMs - (now() - started));
    const timer = setTimeout(() => controller.abort(), timeout);
    try { const result = await operation(controller.signal); session.assertOpen(); return result; }
    catch (_) { if (controller.signal.aborted) session.fatal.add("DISCOVERY_TIMEOUT"); throw new QuoteError("DISCOVERY_UNAVAILABLE"); }
    finally { clearTimeout(timer); controller.abort(); }
  };
  session.prepareUser = async (detail, quoteRow) => {
    session.assertOpen();
    const user = address(quoteRow.user), spoke = address(quoteRow.spoke);
    if (address(detail.user.user) !== user || (detail.user.spoke && address(detail.user.spoke) !== spoke)
      || address(detail.spoke.spoke) !== spoke || detail.user.account?.error) fail("CAPTURED_USER_BINDING_INVALID");
    const hf = uint(detail.user.account?.healthFactorRaw);
    const reserves = detail.user.reserves;
    if (!Array.isArray(reserves) || reserves.length > LIMITS.reserves) fail("RESERVE_CAP_OR_SHAPE");
    const [oracle] = await session.required(spoke, I.spoke, "ORACLE");
    const [oracleSpoke] = await session.required(oracle, I.oracle, "spoke");
    if (address(oracleSpoke) !== spoke) fail("ORACLE_SPOKE_MISMATCH");
    const [oracleDecimalsRaw] = await session.required(oracle, I.oracle, "decimals");
    const oracleDecimals = Number(oracleDecimalsRaw);
    if (!Number.isInteger(oracleDecimals) || oracleDecimals < 0 || oracleDecimals > 36) fail("ORACLE_DECIMALS_INVALID");
    const config = await session.required(spoke, I.spoke, "getLiquidationConfig");
    const target = Number(ethers.formatUnits(config[0], 18));
    if (!(target >= 1)) fail("LIQUIDATION_CONFIG_INVALID");
    const index = { bySpokeReserve: new Map(), byHubAsset: new Map(), bySymbol: new Map() };
    const hydrated = [];
    const seen = new Set();
    for (const reserve of reserves) {
      if (!Number.isSafeInteger(reserve.reserveId) || seen.has(reserve.reserveId)) fail("RESERVE_ID_INVALID");
      seen.add(reserve.reserveId);
      const binding = validated.bindings.get(`${spoke}:${reserve.reserveId}`);
      if (!binding) fail("IDENTITY_NOT_IN_CAPTURE");
      if (binding.capturedOracle.address !== address(oracle) || binding.capturedOracle.decimals !== oracleDecimals) fail("ORACLE_CAPTURE_BINDING_MISMATCH");
      const decoded = await session.required(spoke, I.spoke, "getReserve", [reserve.reserveId]);
      if (address(decoded[0]) !== binding.underlying || address(decoded[1]) !== binding.hubAddress
        || Number(decoded[2]) !== binding.assetId || Number(decoded[3]) !== binding.decimals) fail("PINNED_IDENTITY_MISMATCH");
      const [position] = await session.required(spoke, I.spoke, "getUserPosition", [reserve.reserveId, user]);
      const positionKey = Number(position[4]);
      const dynamic = await session.required(spoke, I.spoke, "getDynamicReserveConfig", [reserve.reserveId, positionKey]);
      const reserveConfig = await session.required(spoke, I.spoke, "getReserveConfig", [reserve.reserveId]);
      if (reserveConfig[1] === true) fail("RESERVE_PAUSED");
      const [source] = await session.required(oracle, I.oracle, "getReserveSource", [reserve.reserveId]);
      if (address(source) === ethers.ZeroAddress) fail("ORACLE_SOURCE_INVALID");
      if (binding.capturedOracle.source !== address(source)) fail("ORACLE_CAPTURE_BINDING_MISMATCH");
      await session.captureRuntime(source);
      await session.captureRuntime(binding.underlying);
      const [priceRaw] = await session.required(oracle, I.oracle, "getReservePrice", [reserve.reserveId]);
      if (priceRaw <= 0n) fail("ORACLE_PRICE_INVALID");
      if (BigInt(binding.capturedOracle.priceRaw) !== priceRaw) fail("ORACLE_CAPTURE_BINDING_MISMATCH");
      const debtRaw = uint(reserve.debtRaw), suppliedRaw = uint(reserve.suppliedRaw);
      if (reserve.errors?.status || reserve.errors?.supplied || reserve.errors?.debt || typeof reserve.usingAsCollateral !== "boolean") fail("CAPTURED_RESERVE_INVALID");
      const price = Number(ethers.formatUnits(priceRaw, oracleDecimals));
      const quantity = rawAmount => Number(ethers.formatUnits(rawAmount, binding.decimals)) * price;
      if (!Number.isFinite(quantity(debtRaw)) || !Number.isFinite(quantity(suppliedRaw)) || !(price > 0)) fail("VALUATION_INVALID");
      const collateral = suppliedRaw > 0n && reserve.usingAsCollateral;
      const [bonus] = collateral ? await session.required(spoke, I.spoke, "getLiquidationBonus", [reserve.reserveId, user,
        quoteRow.nearLiquidationPreQuote ? 999900000000000000n : hf]) : [10000n];
      const cf = Number(dynamic[0]), fee = Number(dynamic[2]);
      if (!Number.isInteger(cf) || cf < 0 || cf > 10000 || !Number.isInteger(fee) || fee < 0 || fee > 10000 || bonus < 10000n) fail("USER_CONFIG_INVALID");
      const meta = { ...binding, address: binding.underlying, symbol: reserve.symbol || null, identityBound: true,
        priceOracleUnit: price, oraclePriceRaw: priceRaw.toString(), oracleDecimals, oracle: address(oracle), oracleSource: address(source),
        positionDynamicConfigKey: positionKey, currentDynamicConfigKey: Number(decoded[6]),
        collateralFactorBps: cf, liquidationFeeBps: fee, liquidationBonusBps: Number(bonus),
        liquidationConfig: { targetHealthFactor: target }, oracleQualification: session.oracleQualification };
      index.bySpokeReserve.set(`${spoke}:${reserve.reserveId}`, meta);
      hydrated.push({ ...reserve, debtRaw: debtRaw.toString(), suppliedRaw: suppliedRaw.toString(), debtUsd: quantity(debtRaw), suppliedUsd: quantity(suppliedRaw) });
    }
    const result = { assetIndex: index, detail: { spoke: { ...detail.spoke, liquidationConfig: { targetHealthFactor: target } },
      user: { ...detail.user, account: { ...detail.user.account, healthFactor: Number(ethers.formatUnits(hf, 18)) }, reserves: hydrated } } };
    prepared.set(index, { session, user, spoke, detail: result.detail });
    return result;
  };
  session.funding = async (tokenAddress, requestedRaw) => {
    session.assertOpen(); const evidence = session.fundingEvidence;
    // Only the already declared prestage venue is allowed in this bounded lane.
    if (evidence?.address?.toLowerCase() !== "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb"
      || !/^0x[0-9a-f]{64}$/i.test(evidence.runtimeKeccak256 || "")) return { status: "UNKNOWN", reason: "DECLARED_FUNDING_EVIDENCE_UNAVAILABLE", executionProof: false };
    const venue = address(evidence.address), token = address(tokenAddress);
    const runtime = await session.captureRuntime(venue);
    if (runtime.codeHash !== evidence.runtimeKeccak256.toLowerCase()) return { status: "UNKNOWN", reason: "FUNDING_RUNTIME_CHANGED", executionProof: false };
    if (!session.fundingBalances.has(token)) {
      const [balance] = await session.required(token, I.token, "balanceOf", [venue]);
      session.fundingBalances.set(token, balance);
    }
    const balance = session.fundingBalances.get(token);
    return { status: balance >= requestedRaw ? "PASS" : "FAIL", venue, token,
      balanceRaw: balance.toString(), requestedRaw: requestedRaw.toString(),
      semantics: "PINNED_BALANCE_COVERAGE_ONLY", executionProof: false, flashCapacityAndFeeProof: "UNKNOWN" };
  };
  session.readGas = async projection => {
    const [decimals] = await session.required(ETH_FEED, I.feed, "decimals");
    const round = await session.required(ETH_FEED, I.feed, "latestRoundData");
    validateEthRound(round, Number(decimals), Number(raw.pin.timestamp), now());
    session.ethRound = { roundId: round[0].toString(), answerRaw: round[1].toString(), updatedAt: Number(round[3]), decimals: Number(decimals), policyMaxAgeSeconds: ETH_MAX_AGE_SECONDS };
    session.gasProjection = projection || null;
    if (!validGasProjection(projection, now())) return { valid: false, gasUsd: null, reason: "GAS_PROJECTION_UNAVAILABLE", ethUsdRaw: round[1].toString(), projection: projection || null };
    // A declared projection, not pinned eth_gasPrice or measured full-path gas.
    const gasUsd = Number(projection.priceWei) * 2000000 / 1e18 * Number(round[1]) / 10 ** Number(decimals);
    if (!Number.isFinite(gasUsd) || gasUsd <= 0) return { valid: false, gasUsd: null, reason: "GAS_PROJECTION_INVALID", ethUsd: session.ethRound, projection };
    return { valid: true, gasUsd, gasUnitsAssumption: 2000000, projection, fullPathCostProof: "UNKNOWN", measuredGas: false, ethUsd: session.ethRound };
  };
  session.finalize = async () => {
    session.closed = true; // No subsequent state read, including cache hits.
    let terminal = false, attestation = null;
    try {
      const confirmed = await raw.confirmPin();
      if (confirmed.number !== raw.pin.number || confirmed.hash !== raw.pin.hash || confirmed.stateRoot !== raw.pin.stateRoot) fail("TERMINAL_PIN_MISMATCH");
      terminal = true;
      attestation = raw.observationPin({ stateReadsAttempted: session.counters.attempted,
        stateReadsSucceeded: session.counters.resolved, stateReadsFailed: session.counters.failed });
      if (!attestation || !pinEqual(attestation, validated.pin)) session.fatal.add("QUOTE_ATTESTATION_UNAVAILABLE");
    } catch (_) { session.fatal.add("TERMINAL_PIN_CONFIRMATION_FAILED"); }
    const stats = raw.statistics();
    if (stats.stateTransportFailures || stats.rejectedRequests || stats.budget?.outstandingRequests) session.fatal.add("COLLECTOR_FAILURE_OR_UNDRAINED_WORK");
    const freshness = validateSources(sources, now(), options.consumerMaxAgeMs);
    for (const error of freshness.failures) session.fatal.add(error);
    const pinAgeMs = now() - Number(raw.pin.timestamp) * 1000;
    if (now() - started >= LIMITS.maxMs) session.fatal.add("QUOTE_RUN_DEADLINE");
    if (pinAgeMs < 0 || pinAgeMs > COLLECTION_LIMITS.maxPinAgeMs) session.fatal.add("QUOTE_PIN_STALE");
    if (session.ethRound && now() / 1000 - session.ethRound.updatedAt > ETH_MAX_AGE_SECONDS) session.fatal.add("ETH_USD_STALE_AT_PUBLICATION");
    return { terminal, attestation, statistics: stats, quoteReads: { ...session.counters },
      pin: { chainId: 1, number: raw.pin.number, hash: raw.pin.hash, stateRoot: raw.pin.stateRoot,
        timestamp: Number(raw.pin.timestamp), finality: "finalized", ageMs: pinAgeMs },
      sources: freshness.provenance, failures: [...session.fatal], runtimes: [...session.runtimes.values()],
      runtimeDependencyCoverage: "DIRECT_TARGETS_AND_EIP1967_ONLY_NOT_REVIEWED_SOURCE_EQUIVALENCE",
      truncatedSearch: [...session.truncation] };
  };
  return session;
}

function validateEthRound(round, decimals, pinSeconds, nowMs) {
  if (decimals !== 8 || round[0] <= 0n || round[1] <= 0n || round[2] <= 0n || round[3] <= 0n
    || round[2] > round[3] || round[4] < round[0] || Number(round[3]) > pinSeconds
    || pinSeconds - Number(round[3]) > ETH_MAX_AGE_SECONDS || nowMs / 1000 - Number(round[3]) > ETH_MAX_AGE_SECONDS) fail("ETH_USD_ROUND_INVALID_OR_STALE");
}
function validGasProjection(projection, nowMs) {
  return projection?.chainId === 1 && projection.method === "eth_gasPrice"
    && typeof projection.priceWei === "string" && /^\d+$/.test(projection.priceWei) && BigInt(projection.priceWei) > 0n
    && sourceAge(projection.observedAt, nowMs, 60000);
}
function sessionFor(provider) { const session = sessions.get(provider); if (!session) fail("PINNED_QUOTE_CONTEXT_REQUIRED"); session.assertOpen(); return session; }
function assertPrepared(provider, index, row, detail) {
  const session = sessionFor(provider), binding = prepared.get(index);
  if (!binding || binding.session !== session || binding.detail !== detail || binding.user !== address(row.user) || binding.spoke !== address(row.spoke)) fail("PREPARED_CAPTURE_REQUIRED");
  return session;
}
function historical(previous) {
  const snapshot = previous?.nearLiquidationPreQuotes ? { generatedAt: previous.generatedAt, pin: previous.pin || null, rows: previous.rows || [] } : previous?.preQuotes;
  if (!snapshot) return null;
  return { ...snapshot, status: "HISTORICAL_UNVERIFIED", current: false, fresh: false,
    originalGeneratedAt: snapshot.originalGeneratedAt || snapshot.generatedAt || null,
    pin: snapshot.pin || null, currentQualified: false, routePositive: false, executableNow: false, signedActionJustified: false };
}
function failureCode(error) { return error instanceof QuoteError || error instanceof CollectionError ? error.code : "PINNED_COLLECTION_UNAVAILABLE"; }
function safeArtifact(value) {
  if (Array.isArray(value)) return value.map(safeArtifact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
    ["routePositive", "executableNow", "signedActionJustified", "researchPositive", "hypotheticalResearchPositive", "currentQualified", "freshnessQualified"].includes(key)
      ? (key === "routePositive" && typeof child === "number" ? 0 : false) : safeArtifact(child)]));
  if (typeof value === "string" && /(?:https?|wss?):\/\/|rpc_endpoints|\b[a-z0-9-]+\.(?:com|io|org|net|xyz|fi|app)\b|bearer\s|authorization\s*:/i.test(value)) return "REDACTED";
  return value;
}
module.exports = { LIMITS, I, ETH_FEED, QuoteError, validateSources, begin, sessionFor, assertPrepared, validateEthRound, validGasProjection, historical, safeArtifact, failureCode };
