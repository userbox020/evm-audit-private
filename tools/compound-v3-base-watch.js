#!/usr/bin/env node
"use strict";

// Observation only: the sole network transport permits bounded read RPCs only.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const { Interface } = require("./node_modules/ethers");
const borrowerIndex = require("./lib/compound-borrower-index");
const ROOT = path.resolve(__dirname, ".."), SCHEMA = "compound-v3-base-watch/v1";
const OUT = path.join(ROOT, "reports/raw/fast/compound-v3-base-watch");
const OUTPUT = path.join(ROOT, "reports/monitor/compound-v3-base-watch.json");
const FIXTURES = path.join(__dirname, "compound-v3-base-watch.fixtures.json");
const MARKET = "0xb125e6687d4313864e53df431d5425969c15eb2f", CHAIN_ID = 8453;
const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
const MAX_REQUESTS = 30, MAX_MS = 120000, RESPONSE_BOUND = 2 * 1024 * 1024;
const WINDOW = 2000, CHUNK = 2000, CANDIDATE_CAP = 1000, BATCH = 100, WAD = 10n ** 18n;
const ENFORCEMENT = "Observation-only Compound V3 Base watch. No signing, deployment, transactions, simulation, liquidation execution or alert dispatch. Evidence only; non-zero observations surface for review, not action. No executable liquidation or fork proof is established.";
const COMET = new Interface([
  "function numAssets() view returns(uint8)",
  "function baseScale() view returns(uint64)",
  "function baseToken() view returns(address)",
  "function baseTokenPriceFeed() view returns(address)",
  "function totalBorrow() view returns(uint256)",
  "function getAssetInfo(uint8) view returns(tuple(uint8 offset,address asset,address priceFeed,uint64 scale,uint64 borrowCollateralFactor,uint64 liquidateCollateralFactor,uint64 liquidationFactor,uint128 supplyCap))",
  "function getPrice(address) view returns(uint256)",
  "function borrowBalanceOf(address) view returns(uint256)",
  "function userBasic(address) view returns(int104 principal,uint64 baseTrackingIndex,uint64 baseTrackingAccrued,uint16 assetsIn,uint8 reserved)",
  "function collateralBalanceOf(address,address) view returns(uint128)",
  "function isLiquidatable(address) view returns(bool)",
  "function getAccountLiquidity(address) view returns(int256)",
  "event Withdraw(address indexed src,address indexed to,uint256 amount)",
  "event Transfer(address indexed from,address indexed to,uint256 amount)",
]);
const MULTI = new Interface(["function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns((bool success,bytes returnData)[] returnData)"]);
const TOPICS = ["Withdraw", "Transfer"].map((name) => COMET.getEvent(name).topicHash);
const CODES = new Set(["INVALID_ARGUMENTS", "CHAIN_MISMATCH", "PIN_INVALID", "PIN_DRIFT", "NO_RUNTIME_CODE", "READ_INVALID", "READ_FAILED", "PARTIAL_READ", "RPC_FAILURE", "RPC_SHAPE_INVALID", "RESPONSE_BOUND_EXCEEDED", "METHOD_REJECTED", "RPC_BUDGET_EXCEEDED", "TIME_BUDGET_EXCEEDED", "SANITIZATION_FAILED", "ARTIFACT_EXISTS", "OFFLINE_TEST_FAILED", "DISCOVERY_BOUND_EXCEEDED", "RANKING_INCOMPLETE", "NO_ACTIVE_BORROWERS_IN_DISCOVERY_WINDOW"]);
borrowerIndex.ERROR_CODES.forEach((code) => CODES.add(code));
const fail = (code) => { throw new Error(code); };
const safeCode = (error) => CODES.has(error?.message) ? error.message : "RPC_FAILURE";
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const rel = (file) => path.relative(ROOT, file).replace(/\\/g, "/");
const hex = (value) => `0x${BigInt(value).toString(16)}`;
const isHash = (value) => typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value);
const isQuantity = (value) => typeof value === "string" && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value);
const isAddress = (value) => typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value);
const safety = () => ({ readOnly: true, signing: false, deployment: false, transactions: false, stateMutation: false, simulation: false, forkExecution: false, alertDispatch: false, executableNow: false, signedActionJustified: false, rpcUrlsStored: false, keysRead: false, authMaterialStored: false });
function jsonBytes(value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (/(?:https?|wss?):\/\/|authorization\s*:|bearer\s|[?&](?:key|token)=/i.test(text)) fail("SANITIZATION_FAILED");
  return Buffer.from(text);
}
function decimal(value, decimals = 18) {
  value = BigInt(value); const scale = 10n ** BigInt(decimals);
  return `${value / scale}.${(value % scale).toString().padStart(decimals, "0")}`;
}
function classify(hf) {
  hf = BigInt(hf);
  return hf < WAD ? "LIQUIDATABLE" : hf < 110n * WAD / 100n ? "NEAR_LIQUIDATION" : "HEALTHY";
}
function validHeader(h) {
  return h && isQuantity(h.number) && isHash(h.hash) && isQuantity(h.timestamp)
    && Number.isSafeInteger(Number(BigInt(h.number))) && Number.isSafeInteger(Number(BigInt(h.timestamp)));
}
function liveSend(rpcUrl) {
  let url; try { url = new URL(rpcUrl); } catch (_) { fail("INVALID_ARGUMENTS"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) fail("INVALID_ARGUMENTS");
  return async (method, params, id, timeoutMs) => {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: controller.signal, redirect: "error" });
      if (!response.ok || !response.body) fail("RPC_FAILURE");
      const reader = response.body.getReader(), chunks = []; let length = 0;
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        length += value.byteLength;
        if (length > RESPONSE_BOUND) { controller.abort(); fail("RESPONSE_BOUND_EXCEEDED"); }
        chunks.push(Buffer.from(value));
      }
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (_) { fail("RPC_SHAPE_INVALID"); }
      if (!body || body.jsonrpc !== "2.0" || body.id !== id || body.error || !Object.hasOwn(body, "result")) fail("RPC_SHAPE_INVALID");
      return body.result;
    } catch (error) { throw new Error(controller.signal.aborted && safeCode(error) !== "RESPONSE_BOUND_EXCEEDED" ? "TIME_BUDGET_EXCEEDED" : safeCode(error)); }
    finally { clearTimeout(timer); }
  };
}
function decode(fn, result) {
  if (!result?.success) fail("READ_FAILED");
  try {
    const value = COMET.decodeFunctionResult(fn, result.returnData);
    if (COMET.encodeFunctionResult(fn, value).toLowerCase() !== result.returnData.toLowerCase()) fail("READ_INVALID");
    return value;
  } catch (_) { fail("READ_INVALID"); }
}
function account(row, results, assets, baseScale, basePrice) {
  try {
    const debt = decode("borrowBalanceOf", results[0])[0], basic = decode("userBasic", results[1]);
    const protocolLiquidatable = decode("isLiquidatable", results[2])[0];
    if ((basic[0] >= 0n) !== (debt === 0n)) fail("READ_INVALID");
    let collateral = 0n, weighted = 0n;
    const collaterals = assets.map((asset, i) => {
      const balance = decode("collateralBalanceOf", results[3 + i])[0];
      const entered = (basic[3] & (1n << BigInt(asset.offset))) !== 0n;
      if ((balance > 0n) !== entered) fail("READ_INVALID");
      const usd = balance * BigInt(asset.priceRaw) / BigInt(asset.scaleRaw);
      const adjusted = usd * BigInt(asset.liquidateCollateralFactorRaw) / WAD;
      collateral += usd; weighted += adjusted;
      return { asset: asset.asset, balanceRaw: balance.toString(), entered, collateralUsdRaw: usd.toString(), liquidationAdjustedUsdRaw: adjusted.toString() };
    });
    const debtUsd = debt * basePrice / baseScale;
    if (debt > 0n && debtUsd === 0n) fail("READ_INVALID");
    const hf = debtUsd > 0n ? weighted * WAD / debtUsd : null;
    return { ...row, status: "COMPLETE", reason: null, debtRaw: debt.toString(), debtUsdRaw: debtUsd.toString(), debtUsd: decimal(debtUsd, 8), principalRaw: basic[0].toString(), assetsIn: basic[3].toString(), collateralUsdRaw: collateral.toString(), collateralUsd: decimal(collateral, 8), liquidationAdjustedUsdRaw: weighted.toString(), liquidationAdjustedUsd: decimal(weighted, 8), collaterals, hfWad: hf?.toString() ?? null, hf: hf === null ? null : decimal(hf), noDebt: debt === 0n, verdict: hf === null ? "HEALTHY" : classify(hf), protocolLiquidatableAtPin: protocolLiquidatable, protocolFlagMatchesHf: hf === null ? !protocolLiquidatable : protocolLiquidatable === (hf < WAD) };
  } catch (error) { return { ...row, status: "INCOMPLETE", verdict: "INCOMPLETE", reason: safeCode(error), hf: null, hfWad: null }; }
}
async function capture({ topN = 20, mode = "dry-run", send = null, transports = null, pin = null, seedBytes = null, seedFile,
  windowBlocks = WINDOW, chunkBlocks = CHUNK, maxChunks = 10, fromBlock = null, backfill = false,
  candidateCap = CANDIDATE_CAP, screenCap = CANDIDATE_CAP, maxRequests = MAX_REQUESTS,
  fixtureId = null, now = () => performance.now() } = {}) {
  if (!Number.isInteger(topN) || topN < 0 || topN > 100 || !["live", "dry-run"].includes(mode)
      || !Number.isInteger(candidateCap) || candidateCap < 1 || candidateCap > CANDIDATE_CAP || !Number.isInteger(screenCap) || screenCap < 0 || screenCap > CANDIDATE_CAP
      || !Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 1024
      || !Number.isInteger(windowBlocks) || windowBlocks < 1 || windowBlocks > borrowerIndex.MAX_WINDOW
      || !Number.isInteger(chunkBlocks) || chunkBlocks < 1 || chunkBlocks > borrowerIndex.MAX_CHUNK
      || !Number.isInteger(maxChunks) || maxChunks < 1 || maxChunks > borrowerIndex.MAX_CHUNKS
      || typeof backfill !== "boolean" || (fromBlock !== null && (!Number.isSafeInteger(fromBlock) || fromBlock < 0))) fail("INVALID_ARGUMENTS");
  const started = now(), ledger = [];
  const value = { schema: SCHEMA, kind: "LiveWatch", generatedAt: new Date().toISOString(), runId: crypto.randomBytes(8).toString("hex"), mode, fixtureId,
    identity: { producer: "tools/compound-v3-base-watch.js", protocol: "Compound V3", chain: "Base", chainId: CHAIN_ID, market: MARKET, multicall3: MULTICALL3, topN },
    status: "INCOMPLETE", statusScope: "BOUNDED_DISCOVERY_AND_DISCOVERED_SET_SCREEN", reason: null, pin: { requested: "finalized", valid: false, rechecked: false, chainIdVerified: false },
    provenance: { provider: mode === "live" ? "two-caller-qualified-independent-transports-redacted" : "synthetic-Comet-ABI-mock", providerCount: transports?.length ?? (send ? 1 : 0), fixturePath: fixtureId ? rel(FIXTURES) : null, fixtureSha256: fixtureId ? sha(fs.readFileSync(FIXTURES)) : null,
      method: "borrowBalanceOf + userBasic + collateralBalanceOf + getAssetInfo + getPrice via Multicall3 aggregate3 eth_call; isLiquidatable cross-check",
      liquidityFallback: "Standard Comet has userBasic, not getUserBasic or getAccountLiquidity. Probe getAccountLiquidity for the first selected borrower; canonical HF always reconstructed from per-asset balances and Comet oracle prices.",
      hfFormula: "sum(floor(floor(collateralBalance * oraclePrice / assetScale) * liquidateCollateralFactor / 1e18)) / floor(borrowBalanceOf * basePrice / baseScale)",
      factorNote: "Comet liquidateCollateralFactor is the liquidation eligibility threshold. The distinct liquidationFactor is an absorption valuation/penalty factor, NOT the HF threshold.",
      priceDecimals: 8, hfDecimals: 18, thresholdPolicy: "HF < 1: LIQUIDATABLE; 1 <= HF < 1.10: NEAR_LIQUIDATION; HF >= 1.10: HEALTHY; failed reads: INCOMPLETE",
      callBinding: "EIP-1898 blockHash + requireCanonical for all state reads; numbered header recheck; live state and logs compared across two caller-qualified independent transports, no retries or single-provider fallback",
      limitations: "Top-N is a display selection within discovered candidates (seed hints plus bounded Withdraw.src / Transfer.from logs), NOT protocol-wide top-N. All active discovered candidates are position-screened up to an explicit cap independently of topN. Seed/index history is partial, including when current debt coverage is 100%; undiscovered borrowers and unscreened positions can remain. Legacy blocksScanned is not coverage proof. Two-service agreement is not cryptographic log completeness or backend-independence proof. borrowBalanceOf includes accrued interest at pin; isLiquidatable can use stored indices, so protocol flag may differ slightly. No execution, profitability or fork proof." },
    discovery: { windowBlocks, chunkBlocks, candidateCap, protocolWideRankingEstablished: false, rankingEstablishedWithinWindow: false, rankingEstablishedWithinDiscoveredSet: false,
      coverage: "PARTIAL", seed: null, candidates: [], logs: [] },
    marketState: null, borrowers: [], screenedBorrowers: [], rankedBorrowerSummary: [], closestToLiquidation: null, crossSectionSummary: null,
    coverage: { scope: "DISCOVERED_SET_ONLY", fullMarketCoverageEstablished: false, candidateDebtReadStatus: "NOT_READ", marketDebtReadStatus: "NOT_READ", positionReadStatus: "NOT_READ",
      candidateDebtRaw: null, knownCandidateDebtRaw: null, screenedDebtRaw: null, marketTotalDebtRaw: null, candidateDebtCoverageFraction: null, screenedDebtCoverageFraction: null, debtResidualRaw: null },
    evidence: [], enforcement: ENFORCEMENT, safety: safety(), diagnostics: { rpcCount: 0, networkRequestCount: 0, maxRequests, retries: 0, ledger }, timing: { maxMs: MAX_MS, durationMs: 0 } };
  const check = () => { if (now() - started >= MAX_MS) fail("TIME_BUDGET_EXCEEDED"); };
  async function rpcTo(provider, method, params) {
    check();
    if (!["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_getLogs", "eth_call"].includes(method)) fail("METHOD_REJECTED");
    const transport = transports ? transports[provider] : send;
    if (!transport) fail("READ_FAILED");
    if (ledger.length >= maxRequests) fail("RPC_BUDGET_EXCEEDED");
    const entry = { ordinal: ledger.length + 1, providerSlot: provider, method, status: "PENDING", durationMs: 0 }; ledger.push(entry); const start = now();
    try { const result = await transport(method, params, entry.ordinal, Math.max(1, Math.min(15000, MAX_MS - (now() - started)))); check(); entry.status = "OK"; return result; }
    catch (error) { entry.status = safeCode(error); throw new Error(entry.status); }
    finally { entry.durationMs = Math.max(0, Math.round(now() - start)); }
  }
  async function rpc(method, params) {
    if (!transports) return rpcTo(0, method, params);
    const settled = await Promise.allSettled([rpcTo(0, method, params), rpcTo(1, method, params)]);
    const failed = settled.find((r) => r.status === "rejected"); if (failed) throw failed.reason;
    const results = settled.map((r) => r.value);
    const normalized = results.map((r) => method === "eth_getBlockByNumber" ? (validHeader(r) ? JSON.stringify([hex(BigInt(r.number)), r.hash.toLowerCase(), hex(BigInt(r.timestamp))]) : null) : typeof r === "string" ? r.toLowerCase() : null);
    if (normalized.includes(null)) fail("READ_INVALID");
    if (normalized[0] !== normalized[1]) fail("PROVIDER_DISAGREEMENT");
    return results[0];
  }
  const binding = () => { if (!value.pin.valid) fail("PIN_INVALID"); return { blockHash: value.pin.hash, requireCanonical: true }; };
  async function batch(calls, label) {
    // Only this closed Comet getter interface can be encoded. No arbitrary targets/calldata.
    if (!calls.length || calls.some((c) => !COMET.getFunction(c.fn)?.constant)) fail("METHOD_REJECTED");
    const data = MULTI.encodeFunctionData("aggregate3", [calls.map((c) => [MARKET, true, COMET.encodeFunctionData(c.fn, c.args ?? [])])]);
    const raw = await rpc("eth_call", [{ to: MULTICALL3, data }, binding()]);
    let results;
    try {
      if (typeof raw !== "string" || raw.length > RESPONSE_BOUND || !/^0x[0-9a-f]+$/i.test(raw)) fail("READ_INVALID");
      [results] = MULTI.decodeFunctionResult("aggregate3", raw);
      if (results.length !== calls.length || MULTI.encodeFunctionResult("aggregate3", [results]).toLowerCase() !== raw.toLowerCase()) fail("READ_INVALID");
    } catch (_) { fail("READ_INVALID"); }
    value.evidence.push({ label, calls, calldataSha256: sha(Buffer.from(data.slice(2), "hex")), returnData: raw, returnDataSha256: sha(Buffer.from(raw.slice(2), "hex")) });
    return results;
  }
  try {
    if (mode === "live" || transports) borrowerIndex.validateTransports(transports);
    const seed = seedBytes !== null ? borrowerIndex.parseSeed(seedBytes, { candidateCap })
      : seedFile !== undefined ? borrowerIndex.loadSeed(seedFile, { candidateCap })
      : mode === "live" ? borrowerIndex.loadSeed(path.join(OUT, "borrower-seed.json"), { optional: true, candidateCap }) : null;
    value.discovery.seed = seed?.provenance ?? null;
    const id = await rpc("eth_chainId", []);
    if (!isQuantity(id) || BigInt(id) !== BigInt(CHAIN_ID)) fail("CHAIN_MISMATCH");
    value.pin.chainIdVerified = true;
    const requestedPin = pin === null ? null : borrowerIndex.normalizedPin(pin);
    const header = await rpc("eth_getBlockByNumber", [requestedPin ? hex(requestedPin.number) : "finalized", false]);
    if (!validHeader(header)) fail("PIN_INVALID");
    Object.assign(value.pin, { requested: requestedPin ? "caller-canonical-pin" : "finalized", number: Number(BigInt(header.number)), numberHex: hex(BigInt(header.number)), hash: header.hash.toLowerCase(), timestamp: Number(BigInt(header.timestamp)), valid: true });
    if (requestedPin && (value.pin.number !== requestedPin.number || value.pin.hash !== requestedPin.hash || value.pin.timestamp !== requestedPin.timestamp)) fail("PIN_DRIFT");
    if (seed) {
      if (seed.provenance.pin.number > value.pin.number) fail("SEED_PIN_AHEAD");
      value.discovery.seed = { ...seed.provenance, staleAtPin: seed.provenance.pin.hash !== value.pin.hash, ageBlocksAtPin: value.pin.number - seed.provenance.pin.number };
    }
    const code = await rpc("eth_getCode", [MARKET, binding()]);
    if (typeof code !== "string" || !/^0x(?:[0-9a-f]{2})*$/i.test(code)) fail("READ_INVALID");
    value.runtimeCode = { bytes: (code.length - 2) / 2, sha256: sha(Buffer.from(code.slice(2), "hex")) };
    if (code === "0x") fail("NO_RUNTIME_CODE");
    const startBlock = fromBlock ?? Math.max(0, value.pin.number - windowBlocks + 1), users = new Set(seed?.users ?? []);
    const endBlock = Math.min(value.pin.number, startBlock + windowBlocks - 1);
    if (startBlock > value.pin.number || (!backfill && endBlock !== value.pin.number)) fail("INVALID_ARGUMENTS");
    Object.assign(value.discovery, { fromBlock: startBlock, toBlock: endBlock, status: "INCOMPLETE", reason: null, rankingScope: seed ? "DISCOVERED_SET" : "RECENT_WINDOW" });
    if (transports) {
      const index = await borrowerIndex.scanBorrowerIndex({ transports: [0, 1].map((slot) => (method, params) => rpcTo(slot, method, params)),
        pin: { number: value.pin.number, hash: value.pin.hash, timestamp: value.pin.timestamp }, seedBytes: seed?.bytes ?? null,
        windowBlocks, chunkBlocks, maxChunks, fromBlock, backfill, candidateCap });
      value.borrowerIndex = index;
      index.users.forEach((user) => users.add(user));
      Object.assign(value.discovery, { fromBlock: index.window.fromBlock, toBlock: index.window.toBlock, status: index.status, reason: index.reason,
        logs: index.logs, successfulChunks: index.successfulChunks, coveredBlocks: index.coveredBlocks, coveredRanges: index.coveredRanges, gaps: index.gaps,
        nextCursor: index.nextCursor, dualProviderLogsVerified: index.pinVerified && index.status === "COMPLETE" });
      if (!index.pinVerified) fail(index.reason ?? "PIN_INVALID");
    } else {
      // Single in-process synthetic fixtures only; never a production fallback.
      let chunks = 0, cursor = startBlock;
      for (; cursor <= endBlock && chunks < maxChunks; chunks++) {
        const to = Math.min(endBlock, cursor + chunkBlocks - 1);
        const logs = borrowerIndex.normalizeLogs(await rpc("eth_getLogs", [{ address: MARKET, fromBlock: hex(cursor), toBlock: hex(to), topics: [TOPICS] }]),
          { fromBlock: cursor, toBlock: to, pin: value.pin });
        for (const log of logs) { const user = `0x${log.topics[1].slice(-40)}`; if (!/^0x0{40}$/.test(user)) users.add(user); }
        if (users.size > candidateCap || value.discovery.logs.length + logs.length > 5000) fail("DISCOVERY_BOUND_EXCEEDED");
        value.discovery.logs.push(...logs); cursor = to + 1;
      }
      Object.assign(value.discovery, { status: cursor > endBlock ? "COMPLETE" : "INCOMPLETE", reason: cursor > endBlock ? null : "DISCOVERY_INCOMPLETE", nextCursor: cursor,
        successfulChunks: chunks, coveredBlocks: cursor - startBlock, dualProviderLogsVerified: false });
    }
    const candidates = [...users].sort().map((user) => ({ user, status: "INCOMPLETE", debtRaw: null }));
    value.discovery.candidates = candidates;
    // Read all discovered candidates before sorting, never silently truncate a ranking.
    for (let i = 0; i < candidates.length; i += BATCH) {
      const rows = candidates.slice(i, i + BATCH);
      try {
        const results = await batch(rows.map((r) => ({ fn: "borrowBalanceOf", args: [r.user] })), "candidate-debts");
        rows.forEach((r, j) => { try { r.debtRaw = decode("borrowBalanceOf", results[j])[0].toString(); r.status = "COMPLETE"; } catch (error) { r.reason = safeCode(error); } });
      } catch (error) { rows.forEach((r) => { r.reason = safeCode(error); }); }
    }
    const ranked = candidates.filter((r) => r.status === "COMPLETE" && BigInt(r.debtRaw) > 0n).sort((a, b) => BigInt(a.debtRaw) > BigInt(b.debtRaw) ? -1 : BigInt(a.debtRaw) < BigInt(b.debtRaw) ? 1 : a.user.localeCompare(b.user));
    value.discovery.rankingEstablishedWithinDiscoveredSet = candidates.every((r) => r.status === "COMPLETE");
    value.discovery.rankingEstablishedWithinWindow = !seed && value.discovery.status === "COMPLETE" && value.discovery.rankingEstablishedWithinDiscoveredSet;
    value.discovery.nonZeroDebtCandidateCount = ranked.length;
    value.discovery.candidateCount = candidates.length;
    value.coverage.candidateDebtReadStatus = value.discovery.rankingEstablishedWithinDiscoveredSet ? "COMPLETE" : "INCOMPLETE";
    value.coverage.knownCandidateDebtRaw = candidates.reduce((sum, r) => sum + (r.status === "COMPLETE" ? BigInt(r.debtRaw) : 0n), 0n).toString();
    value.coverage.candidateDebtRaw = value.discovery.rankingEstablishedWithinDiscoveredSet ? value.coverage.knownCandidateDebtRaw : null;
    value.coverage.debtReadFailedCount = candidates.filter((r) => r.status !== "COMPLETE").length;
    const positions = ranked.map((r, i) => ({ user: r.user, debtRaw: r.debtRaw,
      debtRankWithinDiscoveredSet: value.discovery.rankingEstablishedWithinDiscoveredSet ? i + 1 : null,
      debtRankWithinWindow: value.discovery.rankingEstablishedWithinWindow ? i + 1 : null,
      chain: "Base", chainId: CHAIN_ID, market: MARKET, status: "INCOMPLETE", verdict: "INCOMPLETE", reason: "READ_FAILED", hf: null }));
    value.screenedBorrowers = positions.slice(0, screenCap);
    value.borrowers = positions.slice(0, topN);
    value.coverage.screenCap = screenCap;
    value.coverage.activeDiscoveredCount = ranked.length;
    value.coverage.positionReadStatus = "INCOMPLETE";
    value.coverage.unscreenedActiveCount = ranked.length;
    value.coverage.marketDebtReadStatus = "INCOMPLETE";
    const metaFns = ["numAssets", "baseScale", "baseToken", "baseTokenPriceFeed", "totalBorrow"];
    const meta = await batch(metaFns.map((fn) => ({ fn })), "market-metadata");
    // Decode market total separately: missing totals must not become a zero or suppress position screening.
    let totalBorrow = null;
    try { totalBorrow = decode("totalBorrow", meta[4])[0]; value.coverage.marketTotalDebtRaw = totalBorrow.toString(); value.coverage.marketDebtReadStatus = "COMPLETE"; } catch (_) {}
    const [count, baseScale, baseToken, baseFeed] = metaFns.slice(0, 4).map((fn, i) => decode(fn, meta[i])[0]);
    if (count > 16n || baseScale <= 0n || !isAddress(baseToken) || !isAddress(baseFeed)) fail("READ_INVALID");
    let assets = [];
    if (count > 0n) {
      const infos = await batch(Array.from({ length: Number(count) }, (_, i) => ({ fn: "getAssetInfo", args: [i] })), "asset-metadata");
      assets = infos.map((r) => {
        const a = decode("getAssetInfo", r)[0];
        if (a.scale <= 0n || a.offset >= count || a.liquidateCollateralFactor > WAD || a.liquidationFactor > WAD) fail("READ_INVALID");
        return { offset: Number(a.offset), asset: a.asset.toLowerCase(), priceFeed: a.priceFeed.toLowerCase(), scaleRaw: a.scale.toString(), borrowCollateralFactorRaw: a.borrowCollateralFactor.toString(), liquidateCollateralFactorRaw: a.liquidateCollateralFactor.toString(), liquidationFactorRaw: a.liquidationFactor.toString() };
      });
      if (new Set(assets.map((a) => a.asset)).size !== assets.length || new Set(assets.map((a) => a.offset)).size !== assets.length) fail("READ_INVALID");
    }
    const prices = await batch([baseFeed, ...assets.map((a) => a.priceFeed)].map((feed) => ({ fn: "getPrice", args: [feed] })), "oracle-prices");
    const decodedPrices = prices.map((r) => decode("getPrice", r)[0]);
    if (decodedPrices.some((p) => p <= 0n)) fail("READ_INVALID");
    assets.forEach((a, i) => { a.priceRaw = decodedPrices[i + 1].toString(); });
    value.marketState = { baseToken: baseToken.toLowerCase(), baseScaleRaw: baseScale.toString(), baseTokenPriceFeed: baseFeed.toLowerCase(), basePriceRaw: decodedPrices[0].toString(), totalBorrowRaw: totalBorrow?.toString() ?? null, assets };
    const size = 3 + assets.length, rowsPerBatch = Math.max(1, Math.floor((BATCH - 1) / size));
    for (let i = 0; i < value.screenedBorrowers.length; i += rowsPerBatch) {
      const rows = value.screenedBorrowers.slice(i, i + rowsPerBatch);
      const calls = rows.flatMap((r) => [{ fn: "borrowBalanceOf", args: [r.user] }, { fn: "userBasic", args: [r.user] }, { fn: "isLiquidatable", args: [r.user] }, ...assets.map((a) => ({ fn: "collateralBalanceOf", args: [r.user, a.asset] }))]);
      if (i === 0) calls.push({ fn: "getAccountLiquidity", args: [rows[0].user] });
      try {
        const results = await batch(calls, "discovered-borrower-positions");
        if (i === 0) value.provenance.getAccountLiquidityProbeSucceeded = results[results.length - 1].success;
        rows.forEach((r, j) => {
          let screened = account(r, results.slice(j * size, (j + 1) * size), assets, baseScale, decodedPrices[0]);
          if (screened.status === "COMPLETE" && screened.debtRaw !== r.debtRaw) screened = { ...r, reason: "READ_INVALID" };
          value.screenedBorrowers[i + j] = screened;
        });
      } catch (error) { rows.forEach((r, j) => { value.screenedBorrowers[i + j] = { ...r, reason: safeCode(error) }; }); }
    }
    const screenedByUser = new Map(value.screenedBorrowers.map((r) => [r.user, r]));
    value.borrowers = positions.slice(0, topN).map((r) => screenedByUser.get(r.user) ?? { ...r, reason: "SCREEN_CAP_REACHED" });
    const recheck = await rpc("eth_getBlockByNumber", [value.pin.numberHex, false]);
    if (!validHeader(recheck) || recheck.hash.toLowerCase() !== value.pin.hash || recheck.number !== value.pin.numberHex || Number(BigInt(recheck.timestamp)) !== value.pin.timestamp) fail("PIN_DRIFT");
    value.pin.rechecked = true;
    value.coverage.positionReadStatus = value.screenedBorrowers.length === ranked.length && value.screenedBorrowers.every((r) => r.status === "COMPLETE") && value.coverage.debtReadFailedCount === 0 ? "COMPLETE" : "INCOMPLETE";
    value.reason = !value.discovery.rankingEstablishedWithinDiscoveredSet ? "RANKING_INCOMPLETE"
      : value.discovery.status !== "COMPLETE" ? value.discovery.reason
      : value.coverage.positionReadStatus !== "COMPLETE" || totalBorrow === null ? "PARTIAL_READ" : null;
    value.status = value.reason === null ? "COMPLETE" : "INCOMPLETE";
    if (ranked.length === 0 && totalBorrow > 0n) {
      value.status = "INCOMPLETE";
      if (value.reason === null) value.reason = seed ? "NO_ACTIVE_BORROWERS_IN_DISCOVERED_SET" : "NO_ACTIVE_BORROWERS_IN_DISCOVERY_WINDOW";
    }
  } catch (error) {
    value.reason = safeCode(error);
    if (!value.pin.rechecked) {
      value.pin.valid = false;
      value.borrowers = value.borrowers.map((r) => ({ ...r, status: "INCOMPLETE", verdict: "INCOMPLETE", reason: value.reason, hf: null, hfWad: null }));
      value.screenedBorrowers = value.screenedBorrowers.map((r) => ({ ...r, status: "INCOMPLETE", verdict: "INCOMPLETE", reason: value.reason, hf: null, hfWad: null }));
    }
  }
  const completePositions = value.screenedBorrowers.filter((r) => r.status === "COMPLETE");
  value.coverage.pin = value.pin.rechecked ? { number: value.pin.number, hash: value.pin.hash, timestamp: value.pin.timestamp } : null;
  value.coverage.screenedCount = completePositions.length;
  value.coverage.unscreenedActiveCount = value.coverage.activeDiscoveredCount === undefined ? null : value.coverage.activeDiscoveredCount - completePositions.length;
  if (value.pin.rechecked) {
    value.coverage.knownScreenedDebtRaw = completePositions.reduce((sum, r) => sum + BigInt(r.debtRaw), 0n).toString();
    value.coverage.screenedDebtRaw = value.coverage.positionReadStatus === "COMPLETE" ? value.coverage.knownScreenedDebtRaw : null;
    const marketDebt = value.coverage.marketTotalDebtRaw === null ? null : BigInt(value.coverage.marketTotalDebtRaw);
    if (marketDebt !== null && value.coverage.candidateDebtRaw !== null) {
      const debt = BigInt(value.coverage.candidateDebtRaw);
      value.coverage.debtResidualRaw = (marketDebt - debt).toString();
      value.coverage.debtExceedsMarketTotal = debt > marketDebt;
      value.coverage.candidateDebtCoverageFraction = marketDebt > 0n ? decimal(debt * WAD / marketDebt) : null;
    }
    if (marketDebt > 0n && value.coverage.screenedDebtRaw !== null) value.coverage.screenedDebtCoverageFraction = decimal(BigInt(value.coverage.screenedDebtRaw) * WAD / marketDebt);
  } else {
    for (const field of ["candidateDebtReadStatus", "marketDebtReadStatus", "positionReadStatus"]) if (value.coverage[field] !== "NOT_READ") value.coverage[field] = "INCOMPLETE";
    value.coverage.candidateDebtRaw = null; value.coverage.marketTotalDebtRaw = null;
    value.discovery.rankingEstablishedWithinDiscoveredSet = false; value.discovery.rankingEstablishedWithinWindow = false;
  }
  value.rankedBorrowerSummary = value.borrowers.map((r) => ({ user: r.user, debtRankWithinDiscoveredSet: r.debtRankWithinDiscoveredSet, debtRankWithinWindow: r.debtRankWithinWindow, debtRaw: r.debtRaw ?? null, hf: r.hf, verdict: r.verdict, status: r.status }));
  value.closestToLiquidation = completePositions.filter((r) => !r.noDebt).sort((a, b) => BigInt(a.hfWad) < BigInt(b.hfWad) ? -1 : BigInt(a.hfWad) > BigInt(b.hfWad) ? 1 : a.user.localeCompare(b.user))[0] ?? null;
  value.crossSectionSummary = { requestedTopN: topN, count: value.borrowers.length, completeCount: value.borrowers.filter((r) => r.status === "COMPLETE").length, partial: value.status !== "COMPLETE", emptySelection: value.borrowers.length === 0,
    verdictCounts: Object.fromEntries(["LIQUIDATABLE", "NEAR_LIQUIDATION", "HEALTHY", "INCOMPLETE"].map((v) => [v, value.borrowers.filter((r) => r.verdict === v).length])),
    screenedCount: completePositions.length, unscreenedActiveCount: value.coverage.unscreenedActiveCount, debtReadFailedCount: value.coverage.debtReadFailedCount ?? null,
    nonZeroObservationsForReview: completePositions.filter((r) => !r.noDebt && ["LIQUIDATABLE", "NEAR_LIQUIDATION"].includes(r.verdict)).map((r) => ({ user: r.user, hf: r.hf, verdict: r.verdict })) };
  value.diagnostics.rpcCount = ledger.length; value.diagnostics.networkRequestCount = mode === "live" ? ledger.length : 0;
  value.timing.durationMs = Math.max(0, Math.round(now() - started)); value.timing.completedAt = new Date().toISOString();
  jsonBytes(value); return value;
}
function atomicJson(file, value, replace = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomBytes(8).toString("hex")}.tmp`, bytes = jsonBytes(value); let fd;
  try {
    fd = fs.openSync(temp, "wx", 0o600); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    if (replace) fs.renameSync(temp, file);
    else { try { fs.linkSync(temp, file); } catch (error) { if (error.code === "EEXIST") fail("ARTIFACT_EXISTS"); throw error; } }
    return { sha256: sha(bytes), bytes: bytes.length };
  } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch (_) { /* renamed or removed */ } }
}
function persist(value, latest = false) {
  const file = path.join(OUT, `${value.generatedAt.replace(/[-:.]/g, "")}-${value.mode ?? "offline-test"}-${value.runId}.json`);
  const digest = atomicJson(file, value), artifactPath = rel(file), manifestPath = rel(file.replace(/\.json$/, ".manifest.json"));
  const manifest = atomicJson(path.join(ROOT, manifestPath), { schema: "compound-v3-base-watch-manifest/v1", artifact: artifactPath, ...digest, enforcement: ENFORCEMENT, safety: safety() });
  if (latest) {
    const date = new Date(value.generatedAt), nextDueAt = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)).toISOString();
    atomicJson(OUTPUT, { ...value, artifactPath, artifactSha256: digest.sha256, manifestPath, manifestSha256: manifest.sha256,
      cadence: { utc: "00:00", nextDueAt, registration: "separate durable external daily due gate required; producer registers no scheduler" }, freshness: { validUntil: nextDueAt, liveObservation: value.mode === "live" } }, true);
  }
  return { artifactPath, artifactSha256: digest.sha256, manifestPath, manifestSha256: manifest.sha256 };
}
function readPrevious() {
  try {
    const v = JSON.parse(fs.readFileSync(OUTPUT)); jsonBytes(v);
    if (v.schema !== SCHEMA || v.mode !== "live" || v.enforcement !== ENFORCEMENT || !/^reports\/raw\/fast\/compound-v3-base-watch\/[^/]+\.json$/.test(v.artifactPath)) return null;
    const bytes = fs.readFileSync(path.join(ROOT, v.artifactPath)), manifestBytes = fs.readFileSync(path.join(ROOT, v.artifactPath.replace(/\.json$/, ".manifest.json"))), manifest = JSON.parse(manifestBytes);
    jsonBytes(manifest);
    if (sha(bytes) !== v.artifactSha256 || manifest.sha256 !== v.artifactSha256 || manifest.artifact !== v.artifactPath || manifest.bytes !== bytes.length || sha(manifestBytes) !== v.manifestSha256) return null;
    const artifact = JSON.parse(bytes); jsonBytes(artifact);
    if (artifact.schema !== SCHEMA || artifact.mode !== "live" || artifact.enforcement !== ENFORCEMENT) return null;
    return { ...artifact, artifactPath: v.artifactPath, artifactSha256: v.artifactSha256, manifestPath: v.manifestPath, manifestSha256: v.manifestSha256, freshness: v.freshness };
  } catch (_) { return null; }
}
function parseArgs(argv) {
  const options = { once: false, live: false, refresh: false, offlineTest: false, rpcUrl: null, topN: 20,
    windowBlocks: WINDOW, chunkBlocks: CHUNK, maxChunks: 10, fromBlock: null, backfill: false, screenCap: CANDIDATE_CAP, maxRequests: MAX_REQUESTS };
  const flags = { "--once": "once", "--live": "live", "--refresh": "refresh", "--offline-test": "offlineTest", "--backfill": "backfill" };
  const numeric = { "--top-n": ["topN", 0, 100], "--window-blocks": ["windowBlocks", 1, borrowerIndex.MAX_WINDOW], "--chunk-blocks": ["chunkBlocks", 1, borrowerIndex.MAX_CHUNK],
    "--max-chunks": ["maxChunks", 1, borrowerIndex.MAX_CHUNKS], "--from-block": ["fromBlock", 0, Number.MAX_SAFE_INTEGER - 1],
    "--screen-cap": ["screenCap", 0, CANDIDATE_CAP], "--max-requests": ["maxRequests", 1, 1024] };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]; if (seen.has(arg)) fail("INVALID_ARGUMENTS"); seen.add(arg);
    if (arg === "--rpc-url") { options.rpcUrl = argv[++i]; liveSend(options.rpcUrl); }
    else if (numeric[arg]) {
      const [key, min, max] = numeric[arg], raw = argv[++i]; if (!/^(?:0|[1-9][0-9]*)$/.test(raw ?? "")) fail("INVALID_ARGUMENTS"); options[key] = Number(raw);
      if (!Number.isSafeInteger(options[key]) || options[key] < min || options[key] > max) fail("INVALID_ARGUMENTS");
    } else { if (!flags[arg]) fail("INVALID_ARGUMENTS"); options[flags[arg]] = true; }
  }
  if ((options.live && !options.once) || (options.offlineTest && (options.live || options.rpcUrl)) || (options.rpcUrl && !options.live)) fail("INVALID_ARGUMENTS");
  return options;
}
function fixtureSetup(fixture) {
  const addr = (n) => `0x${n.toString(16).padStart(40, "0")}`;
  const users = fixture.rows.map((r, i) => ({ ...r, user: addr(i + 1) }));
  const header = { number: "0x100000", hash: `0x${"a".repeat(64)}`, timestamp: "0x6ad00000" }, requests = [];
  const send = async (method, params) => {
    requests.push({ method, params });
    if (fixture.failure === "rpc") throw new Error("https://redacted.invalid?key=synthetic-secret");
    if (method === "eth_chainId") return fixture.failure === "chain" ? "0x1" : "0x2105";
    if (method === "eth_getBlockByNumber") return fixture.failure === "drift" && params[0] !== "finalized" ? { ...header, hash: `0x${"b".repeat(64)}` } : header;
    if (method === "eth_getCode") { assert.deepEqual(params, [MARKET, { blockHash: header.hash, requireCanonical: true }]); return "0x60006000"; }
    if (method === "eth_getLogs") {
      assert.equal(params[0].address, MARKET); assert.deepEqual(params[0].topics, [TOPICS]);
      if (BigInt(params[0].toBlock) !== BigInt(header.number)) return [];
      return users.map((r, i) => { const event = COMET.encodeEventLog(COMET.getEvent("Withdraw"), [r.user, addr(90), 1]); return { address: MARKET, removed: false, blockNumber: header.number, blockHash: header.hash, transactionHash: `0x${(i + 1).toString(16).padStart(64, "0")}`, logIndex: hex(i), ...event }; });
    }
    assert.equal(method, "eth_call"); assert.equal(params[0].to, MULTICALL3); assert.deepEqual(params[1], { blockHash: header.hash, requireCanonical: true });
    const [calls] = MULTI.decodeFunctionData("aggregate3", params[0].data);
    const results = calls.map((call) => {
      assert.equal(call.target.toLowerCase(), MARKET); assert.equal(call.allowFailure, true);
      const parsed = COMET.parseTransaction({ data: call.callData }), fn = parsed.name, args = parsed.args;
      const row = args.length ? users.find((r) => r.user === args[0].toString().toLowerCase()) : null;
      if (fn === "getAccountLiquidity" || (row?.failure === fn)) return [false, "0x"];
      let values;
      if (fn === "numAssets") values = [1];
      else if (fn === "baseScale") values = [1000000];
      else if (fn === "baseToken") values = [addr(100)];
      else if (fn === "baseTokenPriceFeed") values = [addr(101)];
      else if (fn === "totalBorrow") values = [fixture.marketDebt ?? users.reduce((sum, r) => sum + BigInt(r.debt ?? "1000000"), 0n)];
      else if (fn === "getAssetInfo") values = [[0, addr(102), addr(103), 1000000, 700000000000000000n, 800000000000000000n, 950000000000000000n, 1000000000000n]];
      else if (fn === "getPrice") values = [100000000];
      else if (fn === "borrowBalanceOf") values = [BigInt(row.debt ?? "1000000")];
      else if (fn === "userBasic") values = [-BigInt(row.debt ?? "1000000"), 0, 0, BigInt(row.collateral ?? "2500000") > 0n ? 1 : 0, 0];
      else if (fn === "isLiquidatable") values = [BigInt(row.collateral ?? "2500000") * 8n < BigInt(row.debt ?? "1000000") * 10n];
      else if (fn === "collateralBalanceOf") values = [BigInt(row.collateral ?? "2500000")];
      else fail("METHOD_REJECTED");
      return [true, COMET.encodeFunctionResult(fn, values)];
    });
    return MULTI.encodeFunctionResult("aggregate3", [results]);
  };
  return { send, requests };
}
async function offlineTest({ persistReport = true, quiet = false } = {}) {
  const fixtures = JSON.parse(fs.readFileSync(FIXTURES)), cases = [], captures = [], networkFetch = globalThis.fetch; let networkAttempts = 0;
  globalThis.fetch = () => { networkAttempts++; fail("METHOD_REJECTED"); };
  try {
    for (const fixture of fixtures.cases) {
      try {
        const setup = fixtureSetup(fixture), value = await capture({ send: setup.send, topN: fixture.topN ?? 20, fixtureId: fixture.id }); captures.push(value);
        assert.equal(value.status, fixture.expectedStatus); assert.deepEqual(value.borrowers.map((r) => r.verdict), fixture.expectedVerdicts);
        assert.ok(value.diagnostics.rpcCount <= MAX_REQUESTS); assert.equal(value.diagnostics.networkRequestCount, 0); assert.deepEqual(value.safety, safety());
        if (fixture.expectedHfs) assert.deepEqual(value.borrowers.map((r) => r.hf), fixture.expectedHfs);
        if (value.status === "COMPLETE") { assert.equal(value.pin.valid, true); assert.equal(value.pin.rechecked, true); assert.equal(value.discovery.rankingEstablishedWithinWindow, true); }
        if (fixture.id === "full-pipeline") { assert.equal(value.borrowers[0].user, `0x${"2".padStart(40, "0")}`); assert.equal(value.closestToLiquidation.user, value.borrowers[1].user); assert.equal(value.provenance.getAccountLiquidityProbeSucceeded, false); }
        assert.ok(!JSON.stringify(value).includes("redacted.invalid"));
        cases.push({ id: fixture.id, passed: true });
      } catch (_) { cases.push({ id: fixture.id, passed: false }); }
    }
    const test = (id, fn) => { try { fn(); cases.push({ id, passed: true }); } catch (_) { cases.push({ id, passed: false }); } };
    test("exact-thresholds", () => { assert.equal(classify(WAD - 1n), "LIQUIDATABLE"); assert.equal(classify(WAD), "NEAR_LIQUIDATION"); assert.equal(classify(11n * WAD / 10n - 1n), "NEAR_LIQUIDATION"); assert.equal(classify(11n * WAD / 10n), "HEALTHY"); });
    test("cli-safety", () => { assert.throws(() => parseArgs(["--live"])); assert.throws(() => parseArgs(["--once", "--live", "--offline-test"])); assert.throws(() => parseArgs(["--sign"])); assert.throws(() => parseArgs(["--top-n", "101"])); assert.throws(() => parseArgs(["--rpc-url", "invalid"])); assert.equal(parseArgs(["--top-n", "0"]).topN, 0); });
    test("sanitization", () => { assert.throws(() => jsonBytes({ endpoint: "https://synthetic.invalid" }), /SANITIZATION_FAILED/); });
    test("no-network", () => assert.equal(networkAttempts, 0));
    const report = { schema: "compound-v3-base-watch-offline-test/v1", generatedAt: new Date().toISOString(), runId: crypto.randomBytes(8).toString("hex"), passed: cases.every((c) => c.passed), passCount: cases.filter((c) => c.passed).length, total: cases.length, cases, captures, enforcement: ENFORCEMENT, safety: safety() };
    const artifacts = persistReport ? persist(report) : {};
    if (!quiet) process.stdout.write(JSON.stringify({ passed: report.passed, passCount: report.passCount, total: report.total, ...artifacts, networkAttempts, cases }) + "\n");
    if (!report.passed) fail("OFFLINE_TEST_FAILED");
    return report;
  } finally { globalThis.fetch = networkFetch; }
}
async function main(argv = process.argv.slice(2), runtime = {}) {
  const options = parseArgs(argv); if (options.offlineTest) return offlineTest();
  // CLI syntax is retained, but a lone URL (or an implicit public endpoint) is no
  // longer sufficient for live evidence. The parent runner injects the two transports.
  if (options.live) borrowerIndex.validateTransports(runtime.transports);
  const previous = readPrevious();
  if (options.live && !options.refresh && !runtime.pin && options.fromBlock === null && !options.backfill
      && previous?.status === "COMPLETE" && previous.discovery?.dualProviderLogsVerified && previous.discovery.windowBlocks === options.windowBlocks
      && previous.discovery.chunkBlocks === options.chunkBlocks && previous.coverage?.screenCap === options.screenCap
      && previous.identity.topN === options.topN && previous.pin.valid && previous.pin.rechecked
      && previous.pin.chainIdVerified && previous.identity.market === MARKET && previous.identity.chainId === CHAIN_ID
      && previous.generatedAt.slice(0, 10) === new Date().toISOString().slice(0, 10) && Date.parse(previous.generatedAt) <= Date.now()
      && Date.parse(previous.freshness?.validUntil) > Date.now() && previous.diagnostics.rpcCount <= MAX_REQUESTS && JSON.stringify(previous.safety) === JSON.stringify(safety())) {
    process.stdout.write(JSON.stringify({ status: previous.status, reused: true, artifactPath: previous.artifactPath, rpcCount: 0, closestToLiquidation: previous.closestToLiquidation }) + "\n"); return;
  }
  const fixture = options.live ? null : JSON.parse(fs.readFileSync(FIXTURES)).cases.find((f) => f.id === "full-pipeline");
  const send = options.live ? null : fixtureSetup(fixture).send;
  const value = await capture({ ...options, ...runtime, mode: options.live ? "live" : "dry-run", send, fixtureId: fixture?.id ?? null });
  const priorObservations = new Set((previous?.crossSectionSummary?.nonZeroObservationsForReview ?? []).map((r) => `${r.user}:${r.verdict}`));
  value.newObservationsForReview = value.crossSectionSummary.nonZeroObservationsForReview.filter((r) => !priorObservations.has(`${r.user}:${r.verdict}`));
  const artifacts = persist(value, options.live || !previous);
  process.stdout.write(JSON.stringify({ status: value.status, reason: value.reason, mode: value.mode, ...artifacts, rpcCount: value.diagnostics.rpcCount, durationMs: value.timing.durationMs, pin: value.pin, crossSectionSummary: value.crossSectionSummary, rankedBorrowerSummary: value.rankedBorrowerSummary, closestToLiquidation: value.closestToLiquidation, newObservationsForReview: value.newObservationsForReview, enforcement: ENFORCEMENT }) + "\n");
  if (value.status !== "COMPLETE") process.exitCode = 1;
}
module.exports = { main, capture, classify, parseArgs, fixtureSetup, offlineTest, persist, readPrevious, account, OUT, OUTPUT, FIXTURES, MARKET, MAX_REQUESTS, MAX_MS,
  scanBorrowerIndex: borrowerIndex.scanBorrowerIndex, persistBorrowerIndex: borrowerIndex.persistBorrowerIndex };
if (require.main === module) main().catch((error) => { process.stdout.write(JSON.stringify({ status: "INCOMPLETE", reason: safeCode(error), enforcement: ENFORCEMENT, safety: safety() }) + "\n"); process.exitCode = 1; });
