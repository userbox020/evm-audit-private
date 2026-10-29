#!/usr/bin/env node
// Read-only preflight for Morpho Pyth watch rows produced by scan-morpho-pyth-unsafe-consumers.js.
// RPC URLs are resolved in memory only and never printed or stored.

const fs = require("fs");
const path = require("path");
let ethers;
try { ({ ethers } = require("ethers")); } catch (_) { ({ ethers } = require("./node_modules/ethers")); }
const { resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const IN = path.join(WORKSPACE, "reports", "raw", "fast", "morpho-pyth-unsafe-consumers.json");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "morpho-pyth-watch-row-preflight.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "morpho-pyth-watch-row-preflight.md");
const QUIET = process.argv.includes("--quiet");
const MIN_PROFIT_USD = Number(process.env.MORPHO_PYTH_PREFLIGHT_MIN_PROFIT_USD || "25");
const GAS_USD = Number(process.env.MORPHO_PYTH_PREFLIGHT_GAS_USD || "25");
const SLIPPAGE_BPS = Number(process.env.MORPHO_PYTH_PREFLIGHT_SLIPPAGE_BPS || "100");

const CHAIN_SLUG = { 1: "ethereum", 8453: "base", 42161: "arbitrum" };

const ORACLE = new ethers.Interface([
  "function pyth() view returns (address)",
  "function BASE_VAULT() view returns (address)",
  "function BASE_VAULT_CONVERSION_SAMPLE() view returns (uint256)",
  "function QUOTE_VAULT() view returns (address)",
  "function QUOTE_VAULT_CONVERSION_SAMPLE() view returns (uint256)",
  "function BASE_FEED_1() view returns (bytes32)",
  "function BASE_FEED_2() view returns (bytes32)",
  "function QUOTE_FEED_1() view returns (bytes32)",
  "function QUOTE_FEED_2() view returns (bytes32)",
  "function SCALE_FACTOR() view returns (uint256)",
  "function PRICE_FEED_MAX_AGE() view returns (uint256)",
  "function price() view returns (uint256)",
]);
const PYTH = new ethers.Interface([
  "function getPriceNoOlderThan(bytes32 id,uint256 age) view returns (tuple(int64 price,uint64 conf,int32 expo,uint256 publishTime))",
  "function getPriceUnsafe(bytes32 id) view returns (tuple(int64 price,uint64 conf,int32 expo,uint256 publishTime))",
]);
const VAULT = new ethers.Interface([
  "function asset() view returns (address)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
]);

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return fallback; }
}

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function round(value, decimals = 6) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function normalizeAddress(value) {
  try { return ethers.getAddress(value); } catch (_) { return null; }
}

function isZeroBytes32(value) {
  return !value || /^0x0{64}$/i.test(String(value));
}

function isZeroAddress(value) {
  return !value || /^0x0{40}$/i.test(String(value));
}

function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value.toString());
  const n = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

async function safeCall(provider, to, iface, fn, args = []) {
  try {
    const target = normalizeAddress(to);
    if (!target) return { ok: false, value: null, error: "invalid-target" };
    const raw = await provider.call({ to: target, data: iface.encodeFunctionData(fn, args) });
    return { ok: true, value: iface.decodeFunctionResult(fn, raw)[0], error: null };
  } catch (err) {
    return { ok: false, value: null, error: err.shortMessage || err.reason || err.message || "call-failed" };
  }
}

function pythTupleToRow(tuple, latestTimestamp, maxAge) {
  if (!tuple) return null;
  const price = Number(tuple.price?.toString?.() || tuple.price);
  const conf = Number(tuple.conf?.toString?.() || tuple.conf);
  const expo = Number(tuple.expo?.toString?.() || tuple.expo);
  const publishTime = Number(tuple.publishTime?.toString?.() || tuple.publishTime);
  const normalizedPrice = Number.isFinite(price) && Number.isFinite(expo) ? price * (10 ** expo) : null;
  const confBps = Number.isFinite(price) && price !== 0 && Number.isFinite(conf) ? Math.abs(conf / price) * 10_000 : null;
  const ageSeconds = Number.isFinite(publishTime) ? latestTimestamp - publishTime : null;
  return {
    rawPrice: Number.isFinite(price) ? price : null,
    conf: Number.isFinite(conf) ? conf : null,
    expo: Number.isFinite(expo) ? expo : null,
    publishTime: Number.isFinite(publishTime) ? publishTime : null,
    normalizedPrice: round(normalizedPrice, 12),
    confBps: round(confBps, 6),
    ageSeconds: round(ageSeconds, 0),
    withinMaxAge: ageSeconds !== null && ageSeconds <= maxAge,
  };
}

function tokenPriceKey(chainId, address) {
  const slug = CHAIN_SLUG[Number(chainId)];
  const addr = normalizeAddress(address);
  return slug && addr ? `${slug}:${addr}` : null;
}

async function fetchReferencePrices(rows) {
  const keys = [...new Set(rows.flatMap((row) => [
    tokenPriceKey(row.chainId, row.collateral?.address),
    tokenPriceKey(row.chainId, row.loanAsset?.address),
  ]).filter(Boolean))];
  if (!keys.length) return new Map();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`https://coins.llama.fi/prices/current/${keys.join(",")}?searchWidth=6h`, { signal: controller.signal });
    const json = await res.json();
    const out = new Map();
    for (const [key, value] of Object.entries(json.coins || {})) {
      const price = asNumber(value?.price);
      if (price && price > 0) out.set(key.toLowerCase(), price);
    }
    return out;
  } catch (_) {
    return new Map();
  } finally {
    clearTimeout(timer);
  }
}

async function inspectVault(provider, address, sample) {
  if (isZeroAddress(address)) return { address: ethers.ZeroAddress, sample: sample?.toString?.() || String(sample || 1), skipped: true, assetsRaw: "1", asset: ethers.ZeroAddress };
  const asset = await safeCall(provider, address, VAULT, "asset");
  const assets = await safeCall(provider, address, VAULT, "convertToAssets", [sample]);
  return {
    address: normalizeAddress(address),
    sample: sample?.toString?.() || String(sample),
    asset: asset.ok ? normalizeAddress(asset.value) : null,
    assetsRaw: assets.ok && assets.value !== null ? assets.value.toString() : null,
    ok: Boolean(asset.ok && assets.ok),
    error: asset.error || assets.error || null,
  };
}

async function inspectFeed(provider, pyth, id, label, maxAge, latestTimestamp) {
  if (isZeroBytes32(id)) return { label, id, omitted: true, normalizedPrice: 1, confBps: 0, ageSeconds: 0, withinMaxAge: true, noOlderOk: true, unsafeOk: true };
  const noOlder = await safeCall(provider, pyth, PYTH, "getPriceNoOlderThan", [id, maxAge]);
  const unsafe = await safeCall(provider, pyth, PYTH, "getPriceUnsafe", [id]);
  const safeRow = pythTupleToRow(noOlder.value, latestTimestamp, maxAge);
  const unsafeRow = pythTupleToRow(unsafe.value, latestTimestamp, maxAge);
  return {
    label,
    id,
    omitted: false,
    noOlderOk: noOlder.ok,
    noOlderError: noOlder.error,
    unsafeOk: unsafe.ok,
    unsafeError: unsafe.error,
    ...(safeRow || unsafeRow || {}),
    diagnosticUnsafe: unsafeRow,
  };
}

function acceptedLoanPerCollateral(priceRaw, collateralDecimals, loanDecimals) {
  if (priceRaw === null || priceRaw === undefined) return null;
  const scaleDecimals = 36 + Number(loanDecimals || 0) - Number(collateralDecimals || 0);
  if (scaleDecimals < 0) return null;
  try { return Number(ethers.formatUnits(priceRaw, scaleDecimals)); } catch (_) { return null; }
}

function premiumBps(observed, reference) {
  const obs = Number(observed || 0);
  const ref = Number(reference || 0);
  if (!Number.isFinite(obs) || !Number.isFinite(ref) || obs <= 0 || ref <= 0) return null;
  return ((obs / ref) - 1) * 10_000;
}

function renderReport(artifact) {
  const rows = artifact.rows.map((row) => `| ${row.chain} | ${row.pair} | ${row.lltvPct} | ${row.liquidityUsd} | ${row.maxAgeSeconds} | ${row.maxFeedAgeSeconds ?? "n/a"} | ${row.maxConfBps ?? "n/a"} | ${row.acceptedVsReferenceBps ?? "n/a"} | ${row.requiredPremiumBps} | ${row.routePositive ? "yes" : "no"} |`).join("\n");
  return [
    "# 🟢 DORMANT — Morpho Pyth Watch Row Preflight",
    "",
    `Date: ${artifact.generatedAt.slice(0, 10)}`,
    "",
    "## Result",
    "",
    "**Dormant / route-negative.** The watch row uses bounded Pyth reads and does not clear LLTV break-even economics under the available reference data. No fork or signed action is justified.",
    "",
    "## Rows",
    "",
    "| Chain | Pair | LLTV % | Liquidity USD | Max age s | Feed age s | Max conf bps | Accepted vs reference bps | Required premium bps | RoutePositive |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    rows || "| n/a | n/a | n/a | 0 | n/a | n/a | n/a | n/a | n/a | no |",
    "",
    "## Gate",
    "",
    "Fork gate stays closed until a Pyth feed is stale or materially divergent, accepted collateral value exceeds exact acquisition cost by more than LLTV break-even plus gas/slippage, and local fork extraction proves net profit.",
    "",
    "## Artifacts",
    "",
    "- JSON: `reports/raw/fast/morpho-pyth-watch-row-preflight.json`",
    "- Scanner: `tools/probe-morpho-pyth-watch-row.js`",
    "",
  ].join("\n");
}

async function inspectRow(row, prices) {
  const rpc = await resolveRpc(Number(row.chainId));
  if (!rpc) throw new Error(`No RPC resolved for chain ${row.chainId}`);
  const provider = new ethers.JsonRpcProvider(rpc, Number(row.chainId), { staticNetwork: true });
  const latest = await provider.getBlock("latest");
  const latestTimestamp = Number(latest?.timestamp || 0);
  const oracle = normalizeAddress(row.oracle);
  const getters = {};
  for (const fn of ["pyth", "BASE_VAULT", "BASE_VAULT_CONVERSION_SAMPLE", "QUOTE_VAULT", "QUOTE_VAULT_CONVERSION_SAMPLE", "BASE_FEED_1", "BASE_FEED_2", "QUOTE_FEED_1", "QUOTE_FEED_2", "SCALE_FACTOR", "PRICE_FEED_MAX_AGE", "price"]) {
    getters[fn] = await safeCall(provider, oracle, ORACLE, fn);
  }
  const pyth = normalizeAddress(getters.pyth.value);
  const maxAge = asNumber(getters.PRICE_FEED_MAX_AGE.value) || 0;
  const feeds = [];
  for (const [fn, label] of [["BASE_FEED_1", "base1"], ["BASE_FEED_2", "base2"], ["QUOTE_FEED_1", "quote1"], ["QUOTE_FEED_2", "quote2"]]) {
    feeds.push(await inspectFeed(provider, pyth, getters[fn].value, label, maxAge, latestTimestamp));
  }
  const baseVault = await inspectVault(provider, getters.BASE_VAULT.value, getters.BASE_VAULT_CONVERSION_SAMPLE.value);
  const quoteVault = await inspectVault(provider, getters.QUOTE_VAULT.value, getters.QUOTE_VAULT_CONVERSION_SAMPLE.value);
  const oraclePriceRaw = getters.price.ok ? getters.price.value : null;
  const accepted = acceptedLoanPerCollateral(oraclePriceRaw, row.collateral?.decimals, row.loanAsset?.decimals);
  const collateralKey = tokenPriceKey(row.chainId, row.collateral?.address);
  const loanKey = tokenPriceKey(row.chainId, row.loanAsset?.address);
  const collateralUsd = collateralKey ? prices.get(collateralKey.toLowerCase()) || null : null;
  const loanUsd = loanKey ? prices.get(loanKey.toLowerCase()) || null : null;
  const referenceLoanPerCollateral = collateralUsd && loanUsd ? collateralUsd / loanUsd : null;
  const lltv = Number(row.lltvPct || 0) / 100;
  const requiredPremiumBps = lltv > 0 ? ((1 / lltv) - 1) * 10_000 + SLIPPAGE_BPS : null;
  const acceptedVsReferenceBps = premiumBps(accepted, referenceLoanPerCollateral);
  const routePositive = Boolean(
    acceptedVsReferenceBps !== null
      && requiredPremiumBps !== null
      && acceptedVsReferenceBps > requiredPremiumBps
      && (Number(row.liquidityUsd || 0) * lltv * (acceptedVsReferenceBps - requiredPremiumBps) / 10_000) > (GAS_USD + MIN_PROFIT_USD)
      && feeds.every((feed) => feed.omitted || feed.noOlderOk)
  );
  return {
    chainId: row.chainId,
    chain: row.chain,
    marketId: row.marketId,
    pair: row.pair,
    collateral: row.collateral,
    loanAsset: row.loanAsset,
    lltvPct: row.lltvPct,
    liquidityUsd: row.liquidityUsd,
    oracle,
    pyth,
    latestBlock: latest?.number || null,
    latestTimestamp,
    maxAgeSeconds: maxAge,
    oraclePriceRaw: oraclePriceRaw !== null && oraclePriceRaw !== undefined ? oraclePriceRaw.toString() : null,
    acceptedLoanPerCollateral: round(accepted, 12),
    reference: {
      collateralUsd,
      loanUsd,
      referenceLoanPerCollateral: round(referenceLoanPerCollateral, 12),
      source: "coins.llama.fi current prices searchWidth=6h",
    },
    acceptedVsReferenceBps: round(acceptedVsReferenceBps, 6),
    requiredPremiumBps: round(requiredPremiumBps, 6),
    estimatedEdgeUsdAtLiquidity: acceptedVsReferenceBps !== null && requiredPremiumBps !== null ? round(Number(row.liquidityUsd || 0) * lltv * (acceptedVsReferenceBps - requiredPremiumBps) / 10_000 - GAS_USD, 6) : null,
    maxFeedAgeSeconds: round(Math.max(0, ...feeds.filter((feed) => !feed.omitted).map((feed) => asNumber(feed.ageSeconds) || 0)), 0),
    maxConfBps: round(Math.max(0, ...feeds.filter((feed) => !feed.omitted).map((feed) => asNumber(feed.confBps) || 0)), 6),
    staleFeedCount: feeds.filter((feed) => !feed.omitted && !feed.noOlderOk).length,
    feeds,
    vaults: { baseVault, quoteVault },
    routePositive,
    executableNow: false,
    signedActionJustified: false,
    blocker: routePositive
      ? "Route-positive preflight requires fork extraction before any signed action."
      : "Bounded Pyth reads and/or accepted-vs-reference economics do not clear LLTV break-even plus gas/slippage.",
  };
}

async function main() {
  const source = readJson(IN, {});
  const watchRows = (source.rows || []).filter((row) => row.watchCandidate && row.pythLinked);
  const prices = await fetchReferencePrices(watchRows);
  const rows = [];
  for (const row of watchRows) rows.push(await inspectRow(row, prices));
  const summary = {
    rows: rows.length,
    staleFeedRows: rows.filter((row) => row.staleFeedCount > 0).length,
    referencePricedRows: rows.filter((row) => row.acceptedVsReferenceBps !== null).length,
    maxAcceptedVsReferenceBps: round(Math.max(...rows.map((row) => asNumber(row.acceptedVsReferenceBps)).filter((n) => n !== null)), 6),
    minRequiredPremiumBps: round(Math.min(...rows.map((row) => asNumber(row.requiredPremiumBps)).filter((n) => n !== null)), 6),
    routePositive: rows.filter((row) => row.routePositive).length,
    executableNow: 0,
    signedActionJustified: false,
    status: rows.some((row) => row.routePositive) ? "route-positive-needs-fork-proof" : "bounded-pyth-route-negative",
  };
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/probe-morpho-pyth-watch-row.js",
    sourceArtifact: "reports/raw/fast/morpho-pyth-unsafe-consumers.json",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: summary.routePositive,
      executableNow: false,
      signedActionJustified: false,
    },
    thresholds: { slippageBps: SLIPPAGE_BPS, gasUsd: GAS_USD, minProfitUsd: MIN_PROFIT_USD },
    summary,
    rows,
  };
  fs.writeFileSync(OUT, JSON.stringify(artifact, jsonReplacer, 2) + "\n");
  fs.writeFileSync(REPORT_OUT, renderReport(artifact));
  if (!QUIET) console.log(`Morpho Pyth watch preflight: rows=${summary.rows} stale=${summary.staleFeedRows} routePositive=${summary.routePositive} status=${summary.status}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
