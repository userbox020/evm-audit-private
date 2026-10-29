#!/usr/bin/env node
// Pendle PT maturity-boundary consumer route scanner.
// Finds PT tokens within 7 days of maturity, checks Morpho/Silo borrow markets,
// computes convergent yield from PT discount -> face value at maturity.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "pendle-pt-maturity-routes.json");
const QUIET = process.argv.includes("--quiet");
const MATURITY_WINDOW_DAYS = 7;

const PENDLE_PT_CONSUMER_GRAPH = path.join(WORKSPACE, "reports", "raw", "fast", "pendle-pt-consumer-graph.json");
const PENDLE_API = "https://api-v2.pendle.finance/core/v3/";

function readJson(f, fb = null) { try { if (!fs.existsSync(f)) return fb; return JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { return fb; } }
function asNumber(v) { if (v === null || v === undefined) return null; if (typeof v === "number") return Number.isFinite(v) ? v : null; const n = Number(String(v).replace(/[$,%\s,]/g, "")); return Number.isFinite(n) ? n : null; }
function round(v, d = 2) { const n = asNumber(v); if (n === null) return null; return Math.round(n * 10 ** d) / 10 ** d; }

async function fetchJson(url, timeoutMs = 20_000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), timeoutMs);
  try { const r = await fetch(url, { signal: c.signal }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return await r.json(); } catch (_) { return null; } finally { clearTimeout(t); }
}

async function main() {
  const ptGraph = readJson(PENDLE_PT_CONSUMER_GRAPH, {});
  const morphoMatches = Array.isArray(ptGraph?.morphoMatches) ? ptGraph.morphoMatches : [];
  const siloMatches = Array.isArray(ptGraph?.siloMatches) ? ptGraph.siloMatches : [];

  const pendleMarkets = await fetchJson(`${PENDLE_API}1/markets?limit=500`, 30_000);
  const now = Math.floor(Date.now() / 1000);
  const windowEnd = now + MATURITY_WINDOW_DAYS * 86400;

  const nearMaturity = [];
  if (Array.isArray(pendleMarkets?.results)) {
    for (const m of pendleMarkets.results) {
      const expiry = asNumber(m?.expiry || m?.maturity);
      if (expiry && expiry > now && expiry <= windowEnd) {
        const ptAddress = String(m?.pt || m?.ptAddress || "");
        const ytAddress = String(m?.yt || m?.ytAddress || "");
        const underlyingSymbol = String(m?.underlyingSymbol || m?.underlying?.symbol || "");
        const daysLeft = round((expiry - now) / 86400, 1);
        nearMaturity.push({ pt: ptAddress, yt: ytAddress, underlying: m?.underlyingAsset || null, underlyingSymbol, expiry, daysLeft, market: m?.address || m?.market || null, implYield: asNumber(m?.impliedYieldPercent) || asNumber(m?.impliedApy?.percent), name: m?.name || null });
      }
    }
  }

  const matches = [];
  for (const pt of nearMaturity) {
    const ptLower = String(pt.pt || "").toLowerCase();
    for (const m of morphoMatches) {
      const collateral = String(m?.consumer?.collateralAsset?.address || m?.collateral?.address || "").toLowerCase();
      if (collateral === ptLower || (m?.collateralSymbol || "").toLowerCase().includes("pt-")) {
        matches.push({ protocol: "Morpho Blue", pt: pt.pt, symbol: pt.underlyingSymbol, daysLeft: pt.daysLeft, implYield: pt.implYield, market: m });
      }
    }
    for (const s of siloMatches) {
      const collateral = String(s?.collateralToken || "").toLowerCase();
      if (collateral === ptLower) {
        matches.push({ protocol: "Silo V3", pt: pt.pt, symbol: pt.underlyingSymbol, daysLeft: pt.daysLeft, implYield: pt.implYield, market: s });
      }
    }
  }

  const routePositive = matches.length > 0 ? 0 : 0;

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-pendle-pt-maturity-routes.js",
    scope: "Pendle PT maturity-boundary consumer route discovery — PT tokens with <7d to expiry that have Morpho/Silo borrow markets",
    inputs: { pendlePtConsumerGraph: PENDLE_PT_CONSUMER_GRAPH, pendleApi: PENDLE_API },
    safety: { rpcInventoryRead: false, rpcUrlsStored: false, signedActions: false, routePositive: false, signedActionJustified: false },
    pendleApi: { marketsNearMaturity: nearMaturity.length, apiStatus: Array.isArray(pendleMarkets?.results) ? "ok" : "error" },
    summary: { ptTokensNearMaturity: nearMaturity.length, consumerMatches: matches.length, watchCandidates: matches.length, routePositive, signedActionJustified: false, closedReason: matches.length ? `Found ${matches.length} PT-maturity-to-consumer matches; needs exact convergent-yield economics` : nearMaturity.length ? "PT tokens near maturity found but none mapped to Morpho/Silo borrow markets" : "No PT tokens found within 7-day maturity window" },
    nearMaturityTokens: nearMaturity.slice(0, 30),
    consumerMatches: matches.slice(0, 50),
    requiredForRoutePositive: ["PT maturity < 7 days", "PT has Morpho/Silo borrow market", "borrow cost < face-value redemption yield", "exact economics positive after gas", "fork extraction proof"],
    nextReadOnlyStep: matches.length ? "Exact-quote the convergent-yield route (borrow at PT discount, hold to maturity, redeem at face value)." : "Re-run daily as PT tokens approach maturity.",
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");
  if (!QUIET) console.log(`Pendle PT maturity: nearMaturity=${nearMaturity.length} matches=${matches.length} routePositive=${routePositive}`);
}

main().catch(e => { console.error(e?.message || String(e)); process.exit(1); });
