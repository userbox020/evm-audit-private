#!/usr/bin/env node
// scan-cross-chain-chainlink-staleness.js - fixed-head, read-only Chainlink feed comparison.
// Feed age gaps are research signals, not executable routes. Never emits provider values.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpcPool, rpcCall } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "cross-chain-chainlink-staleness.json");
const REPORT = path.join(WORKSPACE, "reports", "cross-chain-chainlink-staleness-triage.md");
const MANIFEST = path.join(WORKSPACE, "reports", "raw", "fast", "cross-chain-chainlink-staleness.manifest.json");
const SHARED_RPC = path.join(__dirname, "shared-rpc.js");
const ETHERS_ENTRY = require.resolve("ethers");
const ETHERS_PACKAGE = path.resolve(path.dirname(ETHERS_ENTRY), "..", "package.json");
const NODE_MODULES_ROOT = path.dirname(path.dirname(ETHERS_PACKAGE));
const MATERIAL_PACKAGE_ROOTS = ["ethers", "@adraffy/ens-normalize", "@noble/curves", "@noble/hashes", "aes-js", "tslib", "ws"]
  .map((name) => path.join(NODE_MODULES_ROOT, ...name.split("/")));
const ROOT_PACKAGE = path.join(WORKSPACE, "package.json");
const ROOT_LOCK = path.join(WORKSPACE, "package-lock.json");
const QUIET = process.argv.includes("--quiet");
const OFFLINE = process.argv.includes("--offline");
const MATERIAL_PRICE_GAP_BPS = 50;
const LEGACY_AGE_GAP_SECONDS = 300;
const CLASSIFICATION = "WATCH_ONLY/COVERAGE_GAPPED/NO_ROUTE_PROOF";

// Major Chainlink feeds that exist on multiple chains. Addresses are public feed identifiers.
const FEEDS = {
  "ETH/USD": [
    { chainId: 1, feed: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419" },
    { chainId: 42161, feed: "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612" },
    { chainId: 10, feed: "0x13e3Ee699D1909E989722E753853AE30b17e08c5" },
    { chainId: 8453, feed: "0x71041dddad3595F9CEd3DcCFbe3D1F4b0a16Bb70" },
    { chainId: 137, feed: "0xF9680D99D6C9589e2a93a78A04A279e509205945" },
    { chainId: 56, feed: "0x9ef1B8c0E4F7dc8bF5719Ea496883DC6401d5b2e" },
    { chainId: 43114, feed: "0x976B3D034E162d8bD72D6b9C989d545b839003b0" },
  ],
  "BTC/USD": [
    { chainId: 1, feed: "0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c" },
    { chainId: 42161, feed: "0x6ce185860a4963106506C203335A2910413708e9" },
    { chainId: 10, feed: "0xD702DD976Fb76Fffc2D3963D037dfDae5b04E593" },
    { chainId: 8453, feed: "0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F" },
    { chainId: 137, feed: "0xc907E116054Ad103354f2D350FD2514433D57F6f" },
    { chainId: 56, feed: "0x264990fbd0A4796A3E3d8E37C4D5F87a3aCa5Ebf" },
  ],
  "USDC/USD": [
    { chainId: 1, feed: "0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6" },
    { chainId: 42161, feed: "0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3" },
    { chainId: 10, feed: "0x16a9FA2FDa030272Ce99B29CF780dFA30361E0f3" },
    { chainId: 8453, feed: "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B" },
    { chainId: 137, feed: "0xfE4A8cc5b5B2366C1B58Bea3858e81843581b2F7" },
  ],
  "USDT/USD": [
    { chainId: 1, feed: "0x3E7d1eAB13ad0104d2750B8863b489D65364e32D" },
    { chainId: 42161, feed: "0x3f3f5dF88dC9F13eac63DF89EC16ef6e7E633D60" },
    { chainId: 10, feed: "0xECef79E109e997bCA29c1c0897ec9d7E03618FAB" },
    { chainId: 137, feed: "0x0A6513e40db6EB1b165753AD52E80663aeA50545" },
  ],
  "DAI/USD": [
    { chainId: 1, feed: "0xAed0c38402a5d19df6E4c03F4E2DceD6e29c1ee9" },
    { chainId: 42161, feed: "0xc5C8E77B397E531B8EC06BFb0048328B30E9eE2c" },
    { chainId: 10, feed: "0x8dBa75e83DA73cc766A7a5ECcf71e3262b099c95" },
  ],
};

const AGGREGATOR_IFACE = new ethers.Interface([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
]);

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function rel(file) { return path.relative(WORKSPACE, file).replace(/\\/g, "/"); }
function round(value, digits = 2) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * (10 ** digits)) / (10 ** digits) : null;
}
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function fileMeta(file) {
  const bytes = fs.readFileSync(file);
  return { file: rel(file), bytes: bytes.length, sha256: sha256(bytes) };
}
function treeMeta(directory) {
  const files = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  };
  visit(directory);
  const rows = files.map((file) => {
    const bytes = fs.readFileSync(file);
    return `${path.relative(directory, file).replace(/\\/g, "/")}\0${bytes.length}\0${sha256(bytes)}`;
  });
  return {
    directory: rel(directory),
    files: files.length,
    bytes: files.reduce((sum, file) => sum + fs.statSync(file).size, 0),
    sha256: sha256(rows.join("\n")),
  };
}
function asHexBlock(value) { return `0x${BigInt(value).toString(16)}`; }
function maxOrNull(values) {
  const valid = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  return valid.length ? Math.max(...valid) : null;
}
function assertNoProviderLeak(text, label) {
  const checks = [
    /https?:\/\//i,
    /(?:authorization|x-api-key|api[_-]?key)\s*[:=]/i,
    /[?&](?:key|token|secret|apikey)=/i,
  ];
  if (checks.some((check) => check.test(text))) throw new Error(`${label} failed endpoint/secret leak guard`);
}

async function fixedHead(rpc, chainId) {
  if (!rpc) return { chainId, status: "coverage-gap-no-rpc", blockNumber: null, blockHash: null, blockTimestamp: null };
  const observedChainId = await rpcCall(rpc, "eth_chainId", [], 8000);
  if (!observedChainId || Number.parseInt(observedChainId, 16) !== chainId) {
    return { chainId, status: "coverage-gap-chain-id-validation", blockNumber: null, blockHash: null, blockTimestamp: null };
  }
  const head = await rpcCall(rpc, "eth_getBlockByNumber", ["latest", false], 12000);
  if (!head?.number || !head?.hash || !head?.timestamp) {
    return { chainId, status: "coverage-gap-fixed-head-read", blockNumber: null, blockHash: null, blockTimestamp: null };
  }
  return {
    chainId,
    status: "fixed-head-bound",
    blockNumber: Number(BigInt(head.number)),
    blockHash: String(head.hash).toLowerCase(),
    blockTimestamp: Number(BigInt(head.timestamp)),
  };
}

async function readFeed(rpc, feedAddr, snapshot) {
  if (!rpc || snapshot.status !== "fixed-head-bound") return null;
  const blockTag = asHexBlock(snapshot.blockNumber);
  const [raw, decRaw, descRaw] = await Promise.all([
    rpcCall(rpc, "eth_call", [{ to: feedAddr, data: AGGREGATOR_IFACE.encodeFunctionData("latestRoundData", []) }, blockTag], 12000),
    rpcCall(rpc, "eth_call", [{ to: feedAddr, data: AGGREGATOR_IFACE.encodeFunctionData("decimals", []) }, blockTag], 8000),
    rpcCall(rpc, "eth_call", [{ to: feedAddr, data: AGGREGATOR_IFACE.encodeFunctionData("description", []) }, blockTag], 8000),
  ]);
  if (!raw || raw === "0x" || !decRaw || decRaw === "0x") return null;
  try {
    const decoded = AGGREGATOR_IFACE.decodeFunctionResult("latestRoundData", raw);
    const decimals = Number(AGGREGATOR_IFACE.decodeFunctionResult("decimals", decRaw)[0]);
    const updatedAt = Number(decoded[3]);
    const answer = decoded[1];
    const price = Number(ethers.formatUnits(answer, decimals));
    if (!Number.isFinite(price) || price <= 0 || !Number.isSafeInteger(updatedAt) || updatedAt <= 0) return null;
    let description = "?";
    try { description = AGGREGATOR_IFACE.decodeFunctionResult("description", descRaw)[0]; } catch (_) {}
    return {
      price: round(price, 8),
      updatedAt,
      age: snapshot.blockTimestamp - updatedAt,
      decimals,
      description,
      blockNumber: snapshot.blockNumber,
      blockHash: snapshot.blockHash,
    };
  } catch (_) {
    return null;
  }
}

async function finalRecheck(rpc, snapshot) {
  if (snapshot.status !== "fixed-head-bound") return { ...snapshot, finalRecheck: null };
  const block = await rpcCall(rpc, "eth_getBlockByNumber", [asHexBlock(snapshot.blockNumber), false], 12000);
  const observed = block?.number && block?.hash && block?.timestamp ? {
    blockNumber: Number(BigInt(block.number)),
    blockHash: String(block.hash).toLowerCase(),
    blockTimestamp: Number(BigInt(block.timestamp)),
  } : null;
  const matches = observed !== null
    && observed.blockNumber === snapshot.blockNumber
    && observed.blockHash === snapshot.blockHash
    && observed.blockTimestamp === snapshot.blockTimestamp;
  if (!matches) throw new Error(`fixed-head final recheck mismatch for chain ${snapshot.chainId}`);
  return { ...snapshot, finalRecheck: true };
}

function rowStatus({ validCount, configuredCount, legacyAgeGapSignal, materialDivergence }) {
  if (validCount < 2) return "coverage-gap-insufficient-fixed-head-feeds";
  if (materialDivergence) return "watch-only-material-price-divergence-no-consumer-economics-fork-proof";
  if (legacyAgeGapSignal) return "watch-only-age-gap-no-consumer-economics-proof";
  if (validCount < configuredCount) return "observed-no-material-divergence-with-feed-coverage-gaps";
  return "observed-no-material-price-divergence-no-route-proof";
}

function buildReport(output, rawHash, scannerHash) {
  const s = output.summary;
  const rows = output.results.map((row) => `| ${row.pair} | ${row.feedsRead}/${row.feedsConfigured} | ${row.priceGapBps ?? "n/a"} | ${row.ageGap ?? "n/a"} | ${String(row.legacyAgeGapSignal)} | ${String(row.materialDivergence)} | ${row.status} |`).join("\n");
  return `# Cross-Chain Chainlink Staleness Triage

**Run:** \`${output.runId}\`  
**Status:** \`${s.status}\`
**Classification:** \`${s.classification}\`

## Legacy correction

The former artifact treated \`ageGap > ${LEGACY_AGE_GAP_SECONDS}\` as \`routePositive\`. That was an age-only research signal, not a bound route. This corrected artifact preserves it as \`legacyAgeGapSignal\`/\`watchSignal\`; every row and the summary now have \`routePositive=0\`.

## Current fixed-head observations

| Pair | Feed coverage | Price gap bps | Age gap sec | Legacy age watch | Material divergence | Status |
|---|---:|---:|---:|---|---|---|
${rows}

- Fixed chain heads bound: ${s.fixedHeadsBound}/${s.chainsConfigured}; final rechecks: ${s.finalRecheckChains}/${s.fixedHeadsBound} (aggregate=${s.finalRecheck}); feed coverage: ${s.feedsRead}/${s.feedsConfigured}.
- Maximum price gap: ${s.maxPriceGapBps ?? "n/a"} bps; maximum age gap: ${s.maxAgeGap ?? "n/a"} seconds.
- Watch/material rows: ${s.watchRows}/${s.materialDivergenceRows}; coverage-gap pairs: ${s.coverageGapRows}.
- Consumer-bound/exact-economics/fork-proof rows: ${s.consumerBoundRows}/${s.exactEconomicsRows}/${s.forkProofRows}.

## Route gate

Promotion requires all four gates on the exact deployed path: material price divergence; deployed consumer/feed binding with material liquidity; positive economics after gas, fees, and slippage; and positive local-fork value delta. No route is established because the consumer, economics, and fork gates are absent, so unknown evidence is \`null\`, \`routePositive=0\`, \`executableNow=false\`, and \`signedActionJustified=false\`.

This is durably classified as \`${CLASSIFICATION}\`, not route-negative. Missing feeds prevent a complete no-divergence claim. Unavailable RPCs or feeds are explicit coverage gaps and are not route-negative proof. No fork, signing, transaction, wallet, endpoint-value emission, inventory persistence, or state mutation occurred.

## Integrity

- Raw SHA-256: \`${rawHash}\`
- Scanner SHA-256: \`${scannerHash}\`
- Detached manifest: \`${rel(MANIFEST)}\`
- Offline verification: \`node tools/scan-cross-chain-chainlink-staleness.js --offline\`
`;
}

function strictAssertions(output) {
  if (output.summary.routePositive !== 0 || output.summary.executableNow !== false || output.summary.signedActionJustified !== false) {
    throw new Error("strict summary route gate failed");
  }
  if (output.summary.finalRecheck !== true) throw new Error("aggregate fixed-head final recheck failed");
  if (output.chainSnapshots.some((snapshot) => snapshot.status === "fixed-head-bound" && snapshot.finalRecheck !== true)) {
    throw new Error("per-chain fixed-head final recheck failed");
  }
  for (const row of output.results) {
    if (row.routePositive !== false) throw new Error(`routePositive must be false for ${row.pair}`);
    if (row.legacyAgeGapSignal === true && row.materialDivergence !== true && row.routePositive) {
      throw new Error(`age-only row promoted for ${row.pair}`);
    }
    for (const field of ["legacyAgeGapSignal", "watchSignal", "materialDivergence", "consumerBinding", "exactEconomics", "forkProof", "blockers", "status"]) {
      if (!(field in row)) throw new Error(`missing ${field} for ${row.pair}`);
    }
  }
}

function offlineVerify() {
  const artifact = JSON.parse(fs.readFileSync(OUT, "utf8"));
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  strictAssertions(artifact);
  const checked = [manifest.files.raw, manifest.files.report, manifest.files.scanner, ...manifest.files.dependencies].map((entry) => {
    const file = path.join(WORKSPACE, ...entry.file.split("/"));
    const actual = fileMeta(file);
    if (actual.sha256 !== entry.sha256 || actual.bytes !== entry.bytes) throw new Error(`integrity mismatch: ${entry.file}`);
    return actual;
  });
  const checkedBundles = manifest.files.dependencyBundles.map((entry) => {
    const directory = path.join(WORKSPACE, ...entry.directory.split("/"));
    const actual = treeMeta(directory);
    if (actual.sha256 !== entry.sha256 || actual.files !== entry.files || actual.bytes !== entry.bytes) throw new Error(`integrity mismatch: ${entry.directory}`);
    return actual;
  });
  for (const entry of [manifest.files.raw, manifest.files.report]) {
    assertNoProviderLeak(fs.readFileSync(path.join(WORKSPACE, ...entry.file.split("/")), "utf8"), entry.file);
  }
  assertNoProviderLeak(JSON.stringify(manifest), "manifest");
  if (!QUIET) console.log(JSON.stringify({ mode: "offline", verified: true, runId: artifact.runId, summary: artifact.summary, hashes: checked, dependencyBundles: checkedBundles }, null, 2));
}

async function main() {
  if (OFFLINE) return offlineVerify();

  const allChainIds = [...new Set(Object.values(FEEDS).flatMap((entries) => entries.map((entry) => entry.chainId)))].sort((a, b) => a - b);
  const rpcPool = await resolveRpcPool(allChainIds);
  const initialSnapshots = await Promise.all(allChainIds.map((chainId) => fixedHead(rpcPool[chainId], chainId)));
  const snapshotByChain = Object.fromEntries(initialSnapshots.map((snapshot) => [snapshot.chainId, snapshot]));

  const results = [];
  for (const [pair, entries] of Object.entries(FEEDS)) {
    const feeds = await Promise.all(entries.map(async (entry) => {
      const snapshot = snapshotByChain[entry.chainId];
      if (!snapshot || snapshot.status !== "fixed-head-bound") {
        return { chainId: entry.chainId, feed: entry.feed, error: snapshot?.status || "coverage-gap-no-fixed-head" };
      }
      const data = await readFeed(rpcPool[entry.chainId], entry.feed, snapshot);
      if (!data) return { chainId: entry.chainId, feed: entry.feed, blockNumber: snapshot.blockNumber, blockHash: snapshot.blockHash, error: "coverage-gap-feed-read-at-fixed-head" };
      return { chainId: entry.chainId, feed: entry.feed, ...data };
    }));

    const valid = feeds.filter((feed) => typeof feed.price === "number" && Number.isFinite(feed.price) && feed.price > 0);
    const ages = valid.map((feed) => feed.age);
    const prices = valid.map((feed) => feed.price);
    const minAge = valid.length >= 2 ? Math.min(...ages) : null;
    const maxAge = valid.length >= 2 ? Math.max(...ages) : null;
    const ageGap = minAge === null ? null : maxAge - minAge;
    const minPrice = valid.length >= 2 ? Math.min(...prices) : null;
    const maxPrice = valid.length >= 2 ? Math.max(...prices) : null;
    const priceGapBps = minPrice && maxPrice ? round((maxPrice / minPrice - 1) * 10000, 2) : null;
    const legacyAgeGapSignal = ageGap === null ? null : ageGap > LEGACY_AGE_GAP_SECONDS;
    const materialDivergence = priceGapBps === null ? null : priceGapBps >= MATERIAL_PRICE_GAP_BPS;
    const watchSignal = legacyAgeGapSignal === true || materialDivergence === true
      ? true
      : legacyAgeGapSignal === false && materialDivergence === false
        ? false
        : null;
    const coverageGapCount = feeds.filter((feed) => Boolean(feed.error)).length;
    const blockers = [
      materialDivergence === true ? null : "Material price divergence threshold is not established",
      "Exact deployed consumer/feed path and material liquidity are not evaluated by this scanner",
      "Exact economics after gas, fees, and slippage are not evaluated by this scanner",
      "Positive local-fork value delta is not evaluated by this scanner",
      coverageGapCount ? `${coverageGapCount} configured feed read(s) are coverage gaps, not route-negative proof` : null,
    ].filter(Boolean);

    results.push({
      pair,
      feeds,
      feedsConfigured: entries.length,
      feedsRead: valid.length,
      coverageGapCount,
      minAge,
      maxAge,
      ageGap,
      maxPrice,
      minPrice,
      priceGapBps,
      stalestChain: maxAge === null ? null : valid.find((feed) => feed.age === maxAge)?.chainId ?? null,
      stalestAge: maxAge,
      freshestChain: minAge === null ? null : valid.find((feed) => feed.age === minAge)?.chainId ?? null,
      freshestAge: minAge,
      legacyAgeGapSignal,
      watchSignal,
      materialDivergence,
      consumerBinding: null,
      exactEconomics: null,
      forkProof: null,
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
      blockers,
      status: rowStatus({ validCount: valid.length, configuredCount: entries.length, legacyAgeGapSignal, materialDivergence }),
    });
  }

  // Re-read every exact pinned block only after all feed calls complete. Publication fails on any mismatch.
  const snapshots = await Promise.all(initialSnapshots.map((snapshot) => finalRecheck(rpcPool[snapshot.chainId], snapshot)));

  const feedsConfigured = Object.values(FEEDS).reduce((sum, entries) => sum + entries.length, 0);
  const feedsRead = results.reduce((sum, row) => sum + row.feedsRead, 0);
  const materialDivergenceRows = results.filter((row) => row.materialDivergence === true).length;
  const legacyAgeGapSignalRows = results.filter((row) => row.legacyAgeGapSignal === true).length;
  const watchRows = results.filter((row) => row.watchSignal === true).length;
  const coverageGapRows = results.filter((row) => row.coverageGapCount > 0 || row.feedsRead < 2).length;
  const fixedHeadsBound = snapshots.filter((snapshot) => snapshot.status === "fixed-head-bound").length;
  const finalRecheckChains = snapshots.filter((snapshot) => snapshot.finalRecheck === true).length;
  const aggregateFinalRecheck = finalRecheckChains === fixedHeadsBound;
  const status = materialDivergenceRows > 0
    ? "watch-only-material-divergence-no-consumer-economics-fork-proof"
    : legacyAgeGapSignalRows > 0
      ? "watch-only-age-gaps-no-consumer-economics-proof"
      : coverageGapRows > 0
        ? "coverage-gaps-no-route-proof"
        : "no-material-divergence-no-route-proof";
  const summary = {
    pairsChecked: results.length,
    pairsWithGap: results.filter((row) => typeof row.ageGap === "number" && row.ageGap > 60).length,
    pairsWithLargeGap: legacyAgeGapSignalRows,
    classification: CLASSIFICATION,
    chainsConfigured: allChainIds.length,
    fixedHeadsBound,
    finalRecheckChains,
    finalRecheck: aggregateFinalRecheck,
    feedsConfigured,
    feedsRead,
    feedCoveragePct: round((feedsRead / feedsConfigured) * 100, 2),
    coverageGapRows,
    materialDivergenceRows,
    legacyAgeGapSignalRows,
    watchRows,
    consumerBoundRows: results.filter((row) => row.consumerBinding === true).length,
    exactEconomicsRows: results.filter((row) => row.exactEconomics === true).length,
    forkProofRows: results.filter((row) => row.forkProof === true).length,
    maxAgeGap: maxOrNull(results.map((row) => row.ageGap)),
    maxPriceGapBps: maxOrNull(results.map((row) => row.priceGapBps)),
    routePositive: 0,
    executableNow: false,
    signedActionJustified: false,
    status,
  };

  const evidenceCore = { schemaVersion: 2, config: { materialPriceGapBps: MATERIAL_PRICE_GAP_BPS, legacyAgeGapSeconds: LEGACY_AGE_GAP_SECONDS }, chainSnapshots: snapshots, results };
  const runId = `cross-chain-chainlink-staleness-${sha256(JSON.stringify(evidenceCore)).slice(0, 20)}`;
  const fixedTimestamp = maxOrNull(snapshots.map((snapshot) => snapshot.blockTimestamp));
  const scannerHash = fileMeta(__filename).sha256;
  const output = {
    schemaVersion: 2,
    runId,
    generatedAt: fixedTimestamp === null ? new Date().toISOString() : new Date(fixedTimestamp * 1000).toISOString(),
    scanner: "tools/scan-cross-chain-chainlink-staleness.js",
    scope: "Fixed-head cross-chain Chainlink feed price/freshness research; no consumer/economics/fork route proof",
    safety: {
      readOnlyRpc: true,
      rpcInventoryRead: true,
      inventoryMayContainSecretValues: true,
      secretValuesPersisted: false,
      endpointValuesEmitted: false,
      inventoryContentsPersisted: false,
      signing: false,
      transactions: false,
      forks: false,
      stateMutation: false,
      endpointSecretLeakScanPassed: true,
      routePositive: false,
    },
    config: evidenceCore.config,
    integrity: { scannerSha256: scannerHash, detachedManifest: rel(MANIFEST), offlineRerunSupported: true },
    chainSnapshots: snapshots,
    summary,
    results,
  };
  strictAssertions(output);

  const rawText = `${JSON.stringify(output, null, 2)}\n`;
  assertNoProviderLeak(rawText, "raw artifact");
  ensureDir(OUT);
  ensureDir(REPORT);
  fs.writeFileSync(OUT, rawText);
  const rawHash = fileMeta(OUT).sha256;
  const reportText = buildReport(output, rawHash, scannerHash);
  assertNoProviderLeak(reportText, "report");
  fs.writeFileSync(REPORT, reportText);
  const manifest = {
    schemaVersion: 1,
    detached: true,
    selfExcluded: true,
    runId,
    fixedGenerationDateMarker: output.generatedAt,
    files: {
      raw: fileMeta(OUT),
      report: fileMeta(REPORT),
      scanner: fileMeta(__filename),
      dependencies: [SHARED_RPC, ETHERS_ENTRY, ETHERS_PACKAGE, ROOT_PACKAGE, ROOT_LOCK].map(fileMeta),
      dependencyBundles: MATERIAL_PACKAGE_ROOTS.map(treeMeta),
    },
    runtime: { node: process.version, builtins: ["crypto", "fs", "path", "fetch", "AbortController"] },
    verification: { hashAlgorithm: "sha256", allFilesExist: true, sizesBound: true, endpointSecretLeakScanPassed: true },
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  assertNoProviderLeak(manifestText, "manifest");
  ensureDir(MANIFEST);
  fs.writeFileSync(MANIFEST, manifestText);

  if (!QUIET) {
    console.log(JSON.stringify({
      runId,
      generatedAt: output.generatedAt,
      status,
      heads: { configured: summary.chainsConfigured, fixed: summary.fixedHeadsBound, finalRecheckChains, finalRecheck: aggregateFinalRecheck },
      feedCoverage: { configured: feedsConfigured, read: feedsRead, percent: summary.feedCoveragePct, gapRows: coverageGapRows },
      maxGaps: { priceGapBps: summary.maxPriceGapBps, ageGapSeconds: summary.maxAgeGap },
      counts: { watchRows, materialDivergenceRows, legacyAgeGapSignalRows },
      gates: { consumerBoundRows: 0, exactEconomicsRows: 0, forkProofRows: 0, routePositive: 0, executableNow: false, signedActionJustified: false },
      hashes: { raw: manifest.files.raw.sha256, report: manifest.files.report.sha256, scanner: manifest.files.scanner.sha256, dependencies: manifest.files.dependencies },
      files: [rel(OUT), rel(REPORT), rel(MANIFEST)],
    }, null, 2));
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error?.message || error) }));
  process.exit(1);
});
