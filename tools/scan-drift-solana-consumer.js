#!/usr/bin/env node
// Read-only Drift Protocol Solana perps consumer scanner.
// Fetches Drift public API market data and cross-references xStocks Token-2022 mints.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "drift-solana-consumer-routes.json");
const QUIET = process.argv.includes("--quiet");

const DRIFT_API = "https://drift-public.s3.eu-west-1.amazonaws.com";
const DRIFT_GRAPHQL = "https://api.drift.trade/graphql";
const XSTOCKS_LIVE = path.join(WORKSPACE, "reports", "raw", "fast", "xstocks-live.json");
const TIMEOUT_MS = 30_000;

function readJson(file, f = null) { try { if (!fs.existsSync(file)) return f; return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return f; } }
function asNumber(v) { if (v === null || v === undefined) return null; if (typeof v === "number") return Number.isFinite(v) ? v : null; const n = Number(String(v).replace(/[$,%\s,]/g, "")); return Number.isFinite(n) ? n : null; }
function round(v, d = 2) { const n = asNumber(v); if (n === null) return null; return Math.round(n * 10 ** d) / 10 ** d; }

async function fetchJson(url, timeoutMs = TIMEOUT_MS) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try { const r = await fetch(url, { headers: { "Accept": "application/json", "User-Agent": "evm-audit-drift/1.0" }, signal: ctrl.signal }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return await r.json(); } catch (_) { return null; } finally { clearTimeout(t); }
}

async function main() {
  const xstocks = readJson(XSTOCKS_LIVE, {});
  const solMints = new Map();
  for (const t of xstocks?.solana?.tokens || []) {
    const mint = t?.mint;
    if (!mint) continue;
    solMints.set(mint, {
      name: t?.name || null,
      symbol: t?.mintInfo?.token2022TokenMetadata?.parsed?.symbol || null,
      supply: asNumber(t?.mintInfo?.supply),
      circulating: asNumber(t?.circulating),
      mintAuthority: t?.mintInfo?.mintAuthority || null,
      frozen: t?.mintInfo?.freezeAuthority ? true : false,
      scaledUiMultiplier: asNumber(t?.mintInfo?.token2022ExtensionDetails?.ScaledUiAmountConfig?.multiplier),
    });
  }

  const endpoints = [
    { url: `https://drift-public.s3.eu-west-1.amazonaws.com/spotMarketAccounts.json`, name: "spotMarkets" },
    { url: `https://drift-public.s3.eu-west-1.amazonaws.com/perpMarketAccounts.json`, name: "perpMarkets" },
    { url: `https://api.drift.trade/stats?marketsOnly`, name: "stats" },
  ];

  const results = {};
  for (const ep of endpoints) {
    const data = await fetchJson(ep.url);
    results[ep.name] = data ? (Array.isArray(data) ? data : data?.markets || data?.data || []) : null;
  }

  const matches = [];
  const allMints = new Set();

  for (const [kind, data] of Object.entries(results)) {
    if (!Array.isArray(data)) continue;
    for (const market of data) {
      const mint = market?.oracle || market?.marketIndex ? (market?.baseAssetSymbol || market?.symbol) : null;
      const oracleAddr = String(market?.oracle || market?.oracleAddress || "");
      if (oracleAddr) allMints.add(oracleAddr);
      if (mint) allMints.add(String(mint));
      for (const key of ["marketIndex", "baseAssetSymbol", "symbol", "name", "oracle", "oracleAddress"]) {
        const val = String(market?.[key] || "");
        if (val && solMints.has(val)) {
          matches.push({ kind, market, xstocksMint: val, info: solMints.get(val) });
        }
      }
    }
  }

  const matchedMints = [...new Set(matches.map(m => m.xstocksMint))];

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-drift-solana-consumer.js",
    scope: "Read-only Drift Protocol Solana spot/perps consumer cross-reference for xStocks Token-2022 mints",
    safety: { rpcInventoryRead: false, rpcUrlsStored: false, signedActions: false, exploitExecuteCalls: false, routePositive: matchedMints.length > 0, signedActionJustified: false },
    driftApiStatus: { spotMarkets: Array.isArray(results.spotMarkets) ? results.spotMarkets.length : "error", perpMarkets: Array.isArray(results.perpMarkets) ? results.perpMarkets.length : "error" },
    xstocksMints: solMints.size,
    summary: { spotMarkets: Array.isArray(results.spotMarkets) ? results.spotMarkets.length : 0, perpMarkets: Array.isArray(results.perpMarkets) ? results.perpMarkets.length : 0, matches: matches.length, matchedMints: matchedMints.length, watchCandidates: matchedMints.length, routePositive: 0, signedActionJustified: false, closedReason: matches.length ? "xStocks mint(s) found in Drift markets; needs per-market leverage/economics analysis" : "No xStocks mint matched any Drift spot or perps market by oracle, symbol, or name" },
    matches: matches.slice(0, 50),
    topSpotMarkets: Array.isArray(results.spotMarkets) ? results.spotMarkets.slice(0, 10) : [],
    topPerpMarkets: Array.isArray(results.perpMarkets) ? results.perpMarkets.slice(0, 10) : [],
    requiredForRoutePositive: ["xStocks mint is listed as Drift spot/perps market", "Drift allows leveraged positions on the market", "xStocks-side signal is exploitable", "exact Drift liquidation/swap economics positive", "fork extraction proof"],
    nextReadOnlyStep: matches.length ? "Evaluate Drift market leverage/economics for matched mints; fork-proof only if positive." : "Reopen if new xStocks mints appear as Drift markets.",
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");
  if (!QUIET) {
    console.log(`Drift Solana: spot=${results.spotMarkets?.length || "err"} perp=${results.perpMarkets?.length || "err"} matches=${matches.length} mintsFound=${matchedMints.length}`);
  }
}

main().catch(e => { console.error(e?.message || String(e)); process.exit(1); });
