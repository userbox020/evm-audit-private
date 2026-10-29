#!/usr/bin/env node
"use strict";

// Indexed observation only: no chain RPC, signer, transaction or simulation API.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const ROOT = path.resolve(__dirname, ".."), SCHEMA = "gmx-position-watch/v1";
const OUT = path.join(ROOT, "reports/raw/fast/gmx-position-watch");
const OUTPUT = path.join(ROOT, "reports/monitor/gmx-position-watch.json");
const FIXTURES = path.join(__dirname, "gmx-position-watch.fixtures.json");
const MAX_MS = 24000, MAX_REQUESTS = 1, RESPONSE_BOUND = 2 * 1024 * 1024;
const USD = 10n ** 30n, WAD = 10n ** 18n, MIN_SIZE = 50000n * USD;
const ENFORCEMENT = "Observation-only standing watch on GMX v2 positions. It does NOT sign, deploy, simulate, or execute trades. Outputs are evidence for review; any execution requires separate explicit authorization. **The watch is not fork proof and does not establish an executable trade.**";
// Static token metadata only; unknown collateral is INCOMPLETE, never guessed.
const TOKENS = {
  "0xaf88d065e77c8cc2239327c5edb3a432268e5831": { symbol: "USDC", decimals: 6 },
  "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8": { symbol: "USDC.e", decimals: 6 },
  "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f": { symbol: "WBTC", decimals: 8 },
  "0x82af49447d8a07e3bd95bd0d56f35241523fbab1": { symbol: "WETH", decimals: 18 },
  "0x912ce59144191c1204e64559fe8253a0e49e6548": { symbol: "ARB", decimals: 18 },
};
const QUERY = `query GmxPositionWatch {
  positions(limit:10, orderBy:[leverage_DESC,id_ASC], where:{isSnapshot_eq:false,sizeInUsd_gt:"${MIN_SIZE}"}) {
    id positionKey account market collateralToken isLong collateralAmount sizeInUsd unrealizedPnl leverage isSnapshot
  }
  marketInfos(limit:1000) { marketTokenAddress minCollateralFactorForLiquidation }
  squidStatus { height finalizedHeight }
}`;
const CODES = new Set(["INVALID_ARGUMENTS", "INDEX_READ_FAILED", "INDEX_SHAPE_INVALID", "PARTIAL_READ", "RESPONSE_BOUND_EXCEEDED", "TIME_BUDGET_EXCEEDED", "SANITIZATION_FAILED", "ARTIFACT_EXISTS", "OFFLINE_TEST_FAILED"]);
const fail = (code) => { throw new Error(code); };
const safeCode = (error) => CODES.has(error?.message) ? error.message : "INDEX_READ_FAILED";
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const rel = (file) => path.relative(ROOT, file).replace(/\\/g, "/");
const safety = () => ({ readOnly: true, signing: false, submission: false, deployment: false, stateMutation: false, simulation: false, forkExecution: false, routePositive: false, executableNow: false, signedActionJustified: false, alertDispatch: false, rpcUrlsStored: false, endpointUrlsStored: false, keysRead: false, authMaterialStored: false });
function jsonBytes(value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (/(?:https?|wss?):\/\/|authorization\s*:|bearer\s|[?&](?:key|token)=/i.test(text)) fail("SANITIZATION_FAILED");
  return Buffer.from(text);
}
function decimal(value, decimals = 18) {
  value = BigInt(value); const sign = value < 0n ? "-" : "", n = value < 0n ? -value : value, scale = 10n ** BigInt(decimals);
  return `${sign}${n / scale}.${(n % scale).toString().padStart(decimals, "0")}`;
}
function integer(value, signed = false) {
  if (typeof value !== "string" || !(signed ? /^-?\d+$/ : /^\d+$/).test(value)) fail("INDEX_SHAPE_INVALID");
  return BigInt(value);
}
function address(value) {
  if (typeof value !== "string" || !/^0x[0-9a-f]{40}$/i.test(value)) fail("INDEX_SHAPE_INVALID");
  return value.toLowerCase();
}
function classify(leverage) {
  return leverage > 250000n ? "OBSERVED_HIGH_LEVERAGE" : leverage > 100000n ? "OBSERVED_MEDIUM_LEVERAGE" : "OBSERVED_LOW_LEVERAGE";
}
function compute(row, market) {
  const user = address(row.account), marketAddress = address(row.market), collateralToken = address(row.collateralToken);
  const token = TOKENS[collateralToken], size = integer(row.sizeInUsd), pnl = integer(row.unrealizedPnl, true);
  const leverage = integer(row.leverage), collateral = integer(row.collateralAmount);
  if (!token || !market || address(market.marketTokenAddress) !== marketAddress) fail("PARTIAL_READ");
  const factor = integer(market.minCollateralFactorForLiquidation);
  if (factor <= 0n || factor >= USD || size <= MIN_SIZE || leverage <= 0n || row.isSnapshot !== false || typeof row.isLong !== "boolean") fail("INDEX_SHAPE_INVALID");
  // Indexed leverage is 1e4-scaled. Its inverse is an indicative effective-equity
  // fraction, not an independently read collateral valuation. Do NOT add PnL again.
  const buffer = (10000n * USD / leverage - factor) * 100n * WAD / USD;
  const hf = 10000n * USD * WAD / (leverage * factor);
  return { status: "COMPLETE", reason: null, user, market: marketAddress, side: row.isLong ? "long" : "short",
    sizeRawUsd: size.toString(), sizeUsd: decimal(size, 30), collateralToken,
    collateralSymbol: token.symbol, collateralRaw: collateral.toString(), collateralDecimals: token.decimals, collateralAmount: decimal(collateral, token.decimals),
    unrealizedPnlRawUsd: pnl.toString(), unrealizedPnlUsd: decimal(pnl, 30), indexedLeverageRaw: leverage.toString(), indexedLeverage: decimal(leverage, 4),
    minCollateralFactorForLiquidationRaw: factor.toString(), minCollateralFactorForLiquidation: decimal(factor, 30),
    indicativeBufferPct: decimal(buffer), indicativeBufferPctWad: buffer.toString(), indicativeHf: decimal(hf), indicativeHfWad: hf.toString(), verdict: classify(leverage) };
}
function summarize(positions) {
  const complete = positions.filter((p) => p.status === "COMPLETE"), sum = complete.reduce((n, p) => n + BigInt(p.sizeRawUsd), 0n);
  return { scope: "captured top-10 only; not all GMX positions", count: positions.length, completeCount: complete.length, incompleteCount: positions.length - complete.length,
    above25x: complete.filter((p) => BigInt(p.indexedLeverageRaw) > 250000n).length,
    between10xAnd25x: complete.filter((p) => BigInt(p.indexedLeverageRaw) >= 100000n && BigInt(p.indexedLeverageRaw) <= 250000n).length,
    below10x: complete.filter((p) => BigInt(p.indexedLeverageRaw) < 100000n).length,
    bucketPolicy: "summary: 10 <= leverage <= 25; verdict MEDIUM: 10 < leverage <= 25; exactly 10 is LOW",
    totalSizeRawUsd: sum.toString(), totalSizeUsd: decimal(sum, 30), partial: complete.length !== positions.length };
}
function compare(position, previous, generatedAt) {
  const before = previous?.positions?.find((p) => p.positionKey === position.positionKey && p.status === "COMPLETE");
  if (position.status !== "COMPLETE" || !before) return { status: "NO_COMPARABLE_PREVIOUS", previousGeneratedAt: previous?.generatedAt ?? null, deltas: null };
  return { status: "COMPARED", previousGeneratedAt: previous.generatedAt, elapsedSeconds: (Date.parse(generatedAt) - Date.parse(previous.generatedAt)) / 1000,
    deltas: { sizeRawUsd: (BigInt(position.sizeRawUsd) - BigInt(before.sizeRawUsd)).toString(), sizeUsd: decimal(BigInt(position.sizeRawUsd) - BigInt(before.sizeRawUsd), 30),
      indexedLeverage: decimal(BigInt(position.indexedLeverageRaw) - BigInt(before.indexedLeverageRaw), 4),
      unrealizedPnlUsd: decimal(BigInt(position.unrealizedPnlRawUsd) - BigInt(before.unrealizedPnlRawUsd), 30),
      indicativeBufferPctPoints: decimal(BigInt(position.indicativeBufferPctWad) - BigInt(before.indicativeBufferPctWad)),
      indicativeHf: decimal(BigInt(position.indicativeHfWad) - BigInt(before.indicativeHfWad)) } };
}
async function liveSend() {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), MAX_MS);
  try {
    const endpoint = new URL(["", "gmx-synthetics-arbitrum:prod", "api", "graphql"].join("/"), "https:" + "//gmx.squids.live");
    const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: QUERY }), signal: controller.signal, redirect: "error" });
    if (!response.ok || !response.body) fail("INDEX_READ_FAILED");
    const chunks = [], reader = response.body.getReader(); let length = 0;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength; if (length > RESPONSE_BOUND) { controller.abort(); fail("RESPONSE_BOUND_EXCEEDED"); }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) { throw new Error(controller.signal.aborted ? "TIME_BUDGET_EXCEEDED" : safeCode(error)); }
  finally { clearTimeout(timer); }
}
function fixtureSend(fixtures = JSON.parse(fs.readFileSync(FIXTURES))) {
  const positions = fixtures.positions.map((p) => ({ id: `0x${p.number.toString(16).padStart(64, "0")}`, positionKey: `0x${p.number.toString(16).padStart(64, "0")}`,
    account: `0x${p.number.toString(16).padStart(40, "0")}`, market: fixtures.market, collateralToken: fixtures.collateralToken,
    isLong: p.number % 2 === 1, isSnapshot: p.isSnapshot ?? false, collateralAmount: "3500000000", sizeInUsd: (BigInt(p.sizeUsd) * USD).toString(),
    unrealizedPnl: (BigInt(p.pnlUsd) * USD).toString(), leverage: p.leverage }))
    .filter((p) => !p.isSnapshot && BigInt(p.sizeInUsd) > MIN_SIZE).sort((a, b) => BigInt(a.leverage) > BigInt(b.leverage) ? -1 : 1).slice(0, 10);
  return async () => ({ data: { positions, marketInfos: [{ marketTokenAddress: fixtures.market, minCollateralFactorForLiquidation: fixtures.minCollateralFactorForLiquidation }], squidStatus: { height: fixtures.height, finalizedHeight: fixtures.height - 10 } } });
}
async function capture({ send = liveSend, mode = "live", previous = null, fixtureId = null } = {}) {
  const start = performance.now(), generatedAt = new Date().toISOString();
  const value = { schema: SCHEMA, kind: "LiveWatch", generatedAt, runId: crypto.randomBytes(8).toString("hex"),
    identity: { producer: "tools/gmx-position-watch.js", chainId: 42161, protocol: "GMX v2", selection: "default-top-10" }, mode, fixtureId,
    status: "INCOMPLETE", reason: null, selection: { limit: 10, sizeUsdStrictlyGreaterThan: "50000", isSnapshot: false, orderBy: ["leverage_DESC", "id_ASC"] },
    pin: { requested: "indexed", number: null, finalizedHeight: null, valid: false, chainBlockHashVerified: false },
    provenance: { provider: mode === "live" ? "gmx-arbitrum-subsquid-redacted" : "synthetic-fixture", querySha256: sha(QUERY),
      fixturePath: fixtureId ? rel(FIXTURES) : null, fixtureSha256: fixtureId ? sha(fs.readFileSync(FIXTURES)) : null,
      usdDecimals: 30, leverageScale: 10000, factorDecimals: 30, collateralMetadata: "local static token decimals; unknown token is INCOMPLETE",
      bufferFormula: "100 * (1 / (indexed leverage / 10000) - minCollateralFactorForLiquidation / 1e30)",
      hfFormula: "1 / ((indexed leverage / 10000) * (minCollateralFactorForLiquidation / 1e30))",
      limitations: "Indicative inverse-indexed-leverage equity proxy; no independent collateral USD valuation. PnL is recorded, not added twice. Not a protocol liquidation check: fees, impact, minimum collateral USD, oracle changes and index lag may differ. Index height is not a pinned or verified canonical block; GraphQL fields may update during the read. Closest is within this captured top-10, not protocol-wide.",
      comparisonPolicy: "same positionKey against prior same-mode capture; elapsed time recorded, not assumed exactly one day" },
    positions: [], crossSectionSummary: null, closestToLiquidation: null, comparedWithPrevious: null,
    enforcement: ENFORCEMENT, safety: safety(), timing: { maxMs: MAX_MS, durationMs: 0, completedAt: null },
    diagnostics: { rpcCount: 0, requestCount: 0, networkRequestCount: 0, maxRequests: MAX_REQUESTS, retries: 0 } };
  try {
    value.diagnostics.requestCount = 1; value.diagnostics.networkRequestCount = mode === "live" ? 1 : 0;
    const body = await send(), data = body?.data;
    if (!data || !Array.isArray(data.positions) || data.positions.length > 10) fail("INDEX_SHAPE_INVALID");
    const markets = new Map();
    for (const market of data.marketInfos ?? []) { try { markets.set(address(market.marketTokenAddress), market); } catch (_) { /* missing matching metadata makes that row incomplete */ } }
    const keys = new Set(); let priorLeverage = null;
    for (const row of data.positions) {
      const position = { positionKey: null, status: "INCOMPLETE", verdict: "INCOMPLETE", reason: null };
      try {
        if (!/^0x[0-9a-f]{64}$/i.test(row?.positionKey ?? "") || row.id?.toLowerCase() !== row.positionKey.toLowerCase() || keys.has(row.positionKey.toLowerCase())) fail("INDEX_SHAPE_INVALID");
        position.positionKey = row.positionKey.toLowerCase(); keys.add(position.positionKey);
        Object.assign(position, compute(row, markets.get(address(row.market))));
        const leverage = BigInt(position.indexedLeverageRaw);
        if (priorLeverage !== null && leverage > priorLeverage) fail("INDEX_SHAPE_INVALID");
        priorLeverage = leverage;
      } catch (error) { position.status = "INCOMPLETE"; position.verdict = "INCOMPLETE"; position.reason = safeCode(error); }
      position.comparedWithPrevious = compare(position, previous, generatedAt); value.positions.push(position);
    }
    const status = data.squidStatus;
    if (!Number.isSafeInteger(status?.height) || !Number.isSafeInteger(status?.finalizedHeight) || status.finalizedHeight < 0 || status.height < status.finalizedHeight) fail("INDEX_SHAPE_INVALID");
    Object.assign(value.pin, { number: status.height, finalizedHeight: status.finalizedHeight, valid: true });
    if (body.errors?.length || !Array.isArray(data.marketInfos) || value.positions.some((p) => p.status !== "COMPLETE")) fail("PARTIAL_READ");
    value.status = "COMPLETE";
  } catch (error) { value.reason = safeCode(error); }
  value.crossSectionSummary = summarize(value.positions);
  value.crossSectionSummary.partial = value.status !== "COMPLETE";
  const ranked = value.positions.filter((p) => p.status === "COMPLETE").sort((a, b) => BigInt(a.indicativeBufferPctWad) < BigInt(b.indicativeBufferPctWad) ? -1 : 1);
  const closest = ranked[0];
  value.closestToLiquidation = closest ? { positionKey: closest.positionKey, user: closest.user, market: closest.market, side: closest.side, indexedLeverage: closest.indexedLeverage, indicativeBufferPct: closest.indicativeBufferPct, partialCrossSection: value.status !== "COMPLETE" } : null;
  value.comparedWithPrevious = { previousGeneratedAt: previous?.generatedAt ?? null, matched: value.positions.filter((p) => p.comparedWithPrevious.status === "COMPARED").length,
    notInCurrentTop10: (previous?.positions ?? []).filter((p) => !value.positions.some((now) => now.positionKey === p.positionKey)).map((p) => p.positionKey), absenceMeaning: "left selected top-10; not evidence of closure or liquidation" };
  value.timing.durationMs = Math.round(performance.now() - start); value.timing.completedAt = new Date().toISOString();
  if (value.timing.durationMs >= MAX_MS) { value.status = "INCOMPLETE"; value.reason = "TIME_BUDGET_EXCEEDED"; value.crossSectionSummary.partial = true; }
  jsonBytes(value); return value;
}
function atomicJson(file, value, replace = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomBytes(8).toString("hex")}.tmp`, bytes = jsonBytes(value); let fd;
  try {
    fd = fs.openSync(temporary, "wx", 0o600); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    if (replace) fs.renameSync(temporary, file);
    else { try { fs.linkSync(temporary, file); } catch (error) { if (error.code === "EEXIST") fail("ARTIFACT_EXISTS"); throw error; } }
    return { sha256: sha(bytes), bytes: bytes.length };
  } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temporary); } catch (_) { /* renamed/removed */ } }
}
function persist(value, latest = false) {
  const file = path.join(OUT, `${value.generatedAt.replace(/[-:.]/g, "")}-b${value.pin?.number ?? "test"}-${value.runId}.json`);
  const digest = atomicJson(file, value), artifactPath = rel(file);
  atomicJson(file.replace(/\.json$/, ".manifest.json"), { schema: "gmx-position-watch-manifest/v1", artifact: artifactPath, ...digest, enforcement: ENFORCEMENT, safety: safety() });
  if (latest) {
    const date = new Date(value.generatedAt), nextDueAt = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)).toISOString();
    atomicJson(OUTPUT, { ...value, artifactPath, artifactSha256: digest.sha256,
      cadence: { utc: "00:00", nextDueAt, registration: "external daily gate required; no scheduler registered by producer" },
      freshness: { validUntil: nextDueAt, liveObservation: value.mode === "live" } }, true);
  }
  return artifactPath;
}
function readPrevious(mode) {
  try {
    const value = JSON.parse(fs.readFileSync(OUTPUT)); jsonBytes(value);
    if (value.schema !== SCHEMA || value.mode !== mode || value.enforcement !== ENFORCEMENT || !/^reports\/raw\/fast\/gmx-position-watch\/[^/]+\.json$/.test(value.artifactPath)) return null;
    const file = path.join(ROOT, value.artifactPath), bytes = fs.readFileSync(file), manifest = JSON.parse(fs.readFileSync(file.replace(/\.json$/, ".manifest.json")));
    if (sha(bytes) !== value.artifactSha256 || manifest.sha256 !== value.artifactSha256 || manifest.artifact !== value.artifactPath) return null;
    const artifact = JSON.parse(bytes); jsonBytes(artifact);
    if (artifact.schema !== SCHEMA || artifact.mode !== mode || artifact.enforcement !== ENFORCEMENT || Date.parse(artifact.generatedAt) > Date.now()) return null;
    return { ...artifact, artifactPath: value.artifactPath, artifactSha256: value.artifactSha256, freshness: value.freshness };
  } catch (_) { return null; }
}
function freshStatus() {
  const value = readPrevious("live");
  return value?.status === "COMPLETE" && value.pin.valid && value.generatedAt.slice(0, 10) === new Date().toISOString().slice(0, 10)
    && Date.parse(value.freshness?.validUntil) > Date.now() && value.diagnostics.requestCount <= MAX_REQUESTS && JSON.stringify(value.safety) === JSON.stringify(safety()) ? value : null;
}
function parseArgs(argv) {
  const options = { once: false, live: false, refresh: false, offlineTest: false, defaultTop10: true };
  const flags = { "--once": "once", "--live": "live", "--refresh": "refresh", "--offline-test": "offlineTest", "--default-top-10": "defaultTop10" };
  for (const flag of argv) { if (!flags[flag]) fail("INVALID_ARGUMENTS"); options[flags[flag]] = true; }
  if ((options.live && !options.once) || (options.offlineTest && options.live)) fail("INVALID_ARGUMENTS");
  return options;
}
async function offlineTest() {
  const fixtures = JSON.parse(fs.readFileSync(FIXTURES)), cases = [], networkFetch = globalThis.fetch;
  globalThis.fetch = () => fail("INDEX_READ_FAILED");
  const test = async (id, fn) => { try { await fn(); cases.push({ id, passed: true }); } catch (_) { cases.push({ id, passed: false }); } };
  try {
    const value = await capture({ send: fixtureSend(fixtures), mode: "dry-run", fixtureId: fixtures.id });
    await test("all-top-10-present-filtered-ordered", () => { assert.equal(value.status, "COMPLETE"); assert.equal(value.positions.length, 10); assert.deepEqual(value.positions.map((p) => Number(BigInt(p.positionKey))), [1,2,3,4,5,6,7,8,9,10]); });
    await test("cross-section-counts-and-total", () => { for (const key of ["count", "above25x", "between10xAnd25x", "below10x", "totalSizeUsd"]) assert.equal(value.crossSectionSummary[key], fixtures.expected[key]); });
    await test("verdict-classes-including-10-and-25-boundaries", () => { assert.deepEqual(value.positions.map((p) => p.verdict), ["OBSERVED_HIGH_LEVERAGE", "OBSERVED_HIGH_LEVERAGE", ...Array(3).fill("OBSERVED_MEDIUM_LEVERAGE"), ...Array(5).fill("OBSERVED_LOW_LEVERAGE")]); });
    await test("fixture-buffer-and-indicative-hf", () => { assert.equal(value.positions[0].indicativeBufferPct, fixtures.expected.firstBufferPct); assert.equal(value.positions[0].indicativeHf, fixtures.expected.firstHf); assert.equal(value.positions[0].unrealizedPnlUsd, "-1000.000000000000000000000000000000"); });
    await test("per-position-previous-deltas", async () => {
      const send = fixtureSend(fixtures), body = await send(); body.data.positions[0].sizeInUsd = (110000n * USD).toString(); body.data.positions[0].leverage = "500000"; body.data.positions[0].unrealizedPnl = (-2000n * USD).toString();
      const next = await capture({ send: async () => body, mode: "dry-run", previous: value });
      assert.equal(next.comparedWithPrevious.matched, 10); const delta = next.positions[0].comparedWithPrevious.deltas;
      assert.equal(delta.sizeUsd, "10000.000000000000000000000000000000"); assert.equal(delta.indexedLeverage, "10.0000"); assert.equal(delta.unrealizedPnlUsd, "-1000.000000000000000000000000000000"); assert.equal(delta.indicativeBufferPctPoints, "-0.500000000000000000"); assert.ok(BigInt(next.positions[0].indicativeHfWad) < BigInt(value.positions[0].indicativeHfWad));
    });
    await test("partial-market-read-incomplete", async () => { const body = await fixtureSend(fixtures)(); body.data.marketInfos = []; const partial = await capture({ send: async () => body, mode: "dry-run" }); assert.equal(partial.status, "INCOMPLETE"); assert.ok(partial.positions.every((p) => p.verdict === "INCOMPLETE")); assert.equal(partial.closestToLiquidation, null); });
    await test("partial-graphql-error-preserves-evidence", async () => { const body = await fixtureSend(fixtures)(); body.errors = [{ message: "redacted upstream failure" }]; const partial = await capture({ send: async () => body, mode: "dry-run" }); assert.equal(partial.status, "INCOMPLETE"); assert.equal(partial.positions.length, 10); assert.equal(partial.crossSectionSummary.partial, true); });
    await test("failure-sanitization-and-no-rpc", async () => { const partial = await capture({ mode: "dry-run", send: async () => { throw new Error("https://private.invalid?key=redacted"); } }); assert.equal(partial.reason, "INDEX_READ_FAILED"); assert.ok(!JSON.stringify(partial).includes("private.invalid")); assert.equal(partial.diagnostics.rpcCount, 0); assert.throws(() => jsonBytes({ url: "https://private.invalid" }), /SANITIZATION_FAILED/); });
    await test("live-flags-and-enforcement", () => { assert.throws(() => parseArgs(["--live"])); assert.throws(() => parseArgs(["--once", "--live", "--offline-test"])); assert.equal(value.enforcement, ENFORCEMENT); assert.equal(value.diagnostics.networkRequestCount, 0); assert.deepEqual(value.safety, safety()); });
    const report = { schema: "gmx-position-watch-offline-test/v1", generatedAt: new Date().toISOString(), runId: crypto.randomBytes(8).toString("hex"), passed: cases.every((c) => c.passed), cases, capture: value, enforcement: ENFORCEMENT, safety: safety() };
    const artifactPath = persist(report);
    process.stdout.write(JSON.stringify({ passed: report.passed, artifactPath, rpcCount: 0, cases, enforcement: ENFORCEMENT }) + "\n");
    if (!report.passed) fail("OFFLINE_TEST_FAILED");
  } finally { globalThis.fetch = networkFetch; }
}
async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv); if (options.offlineTest) return offlineTest();
  if (options.live && !options.refresh) {
    const cached = freshStatus();
    if (cached) { process.stdout.write(JSON.stringify({ status: cached.status, mode: "live", reused: true, artifactPath: cached.artifactPath, rpcCount: 0, requestCount: 0, crossSectionSummary: cached.crossSectionSummary, closestToLiquidation: cached.closestToLiquidation, enforcement: ENFORCEMENT }) + "\n"); return; }
  }
  const mode = options.live ? "live" : "dry-run", previous = readPrevious(mode);
  const value = await capture({ mode, previous, send: options.live ? liveSend : fixtureSend(), fixtureId: options.live ? null : "gmx-top-10-synthetic-v1" });
  let prior = null; try { prior = JSON.parse(fs.readFileSync(OUTPUT)); } catch (_) { /* first capture */ }
  const artifactPath = persist(value, options.live || prior?.mode !== "live");
  process.stdout.write(JSON.stringify({ status: value.status, reason: value.reason, mode, artifactPath, rpcCount: 0, requestCount: value.diagnostics.requestCount, durationMs: value.timing.durationMs, pin: value.pin, crossSectionSummary: value.crossSectionSummary, closestToLiquidation: value.closestToLiquidation, enforcement: ENFORCEMENT }) + "\n");
  if (value.status !== "COMPLETE") process.exitCode = 1;
}
module.exports = { main, capture, compute, classify, summarize, parseArgs, persist, freshStatus, readPrevious, fixtureSend, OUTPUT, OUT, SCHEMA, ENFORCEMENT, MAX_MS, MAX_REQUESTS };
if (require.main === module) main().catch((error) => { process.stdout.write(JSON.stringify({ status: "INCOMPLETE", reason: safeCode(error), enforcement: ENFORCEMENT, safety: safety() }) + "\n"); process.exitCode = 1; });
