#!/usr/bin/env node
// Bridge escrow vs circulating supply reconciliation scanner.
// Compares proof-of-reserves (custodian backing) against circulating supply
// for xStocks tokens and Hyperlane warp routes.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "bridge-escrow-reconciliation.json");
const QUIET = process.argv.includes("--quiet");
const SHORTFALL_THRESHOLD_PCT = 0.5; // flag >0.5% shortfall

const XSTOCKS_LIVE = path.join(WORKSPACE, "reports", "raw", "fast", "xstocks-live.json");
const HYPERLANE_WARP = path.join(WORKSPACE, "reports", "raw", "fast", "hyperlane-warp-routes.json");

function readJson(f, fb = null) { try { if (!fs.existsSync(f)) return fb; return JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { return fb; } }
function asNumber(v) { if (v === null || v === undefined) return null; if (typeof v === "number") return Number.isFinite(v) ? v : null; const n = Number(String(v).replace(/[$,%\s,]/g, "")); return Number.isFinite(n) ? n : null; }
function round(v, d = 4) { const n = asNumber(v); if (n === null) return null; return Math.round(n * 10 ** d) / 10 ** d; }

function main() {
  const xstocks = readJson(XSTOCKS_LIVE, {});
  const hyperlane = readJson(HYPERLANE_WARP, {});

  // === xStocks proof-of-reserves ===
  const proofRows = Array.isArray(xstocks?.proofReserves) ? xstocks.proofReserves : [];
  const xstocksResults = [];
  for (const row of proofRows) {
    const sharesHeld = asNumber(row?.sharesHeld);
    const circulating = asNumber(row?.circulatingSupply);
    if (sharesHeld === null && circulating === null) {
      xstocksResults.push({ symbol: row.symbol, status: "data_gap", sharesHeld: null, circulating: null, shortfall: null, pct: null });
      continue;
    }
    if (sharesHeld === null || circulating === null) {
      xstocksResults.push({ symbol: row.symbol, status: "partial_data", sharesHeld, circulating, shortfall: null, pct: null });
      continue;
    }
    const shortfall = circulating - sharesHeld; // positive = under-collateralized
    const pct = sharesHeld > 0 ? (shortfall / sharesHeld) * 100 : null;
    const status = shortfall > sharesHeld * SHORTFALL_THRESHOLD_PCT / 100 ? "shortfall" : "backed";
    xstocksResults.push({
      symbol: row.symbol,
      status,
      sharesHeld: round(sharesHeld, 2),
      circulating: round(circulating, 2),
      shortfall: round(shortfall, 2),
      shortfallPct: round(pct, 4),
      holdings: row?.holdings || [],
      timestamp: row?.timestamp || null,
    });
  }

  // === Hyperlane warp route escrows ===
  const warpProducers = Array.isArray(hyperlane?.producers) ? hyperlane.producers : [];
  const escrowResults = [];
  // Collect pairs: same symbol across chains
  const bySymbol = {};
  for (const p of warpProducers) {
    const sym = String(p?.symbol || p?.name || "").toLowerCase();
    if (!sym) continue;
    if (!bySymbol[sym]) bySymbol[sym] = [];
    bySymbol[sym].push({ chainId: p?.chainId, chain: p?.chain, address: p?.address, category: p?.category, totalSupply: p?.totalSupply, isEscrow: p?.category?.includes("escrow") || false, isCollateral: p?.category?.includes("collateral") || false });
  }

  // Find escrow+collateral pairs for same symbol
  for (const [sym, entries] of Object.entries(bySymbol)) {
    const escrows = entries.filter(e => e.isEscrow);
    const collaterals = entries.filter(e => e.isCollateral);
    if (!escrows.length || !collaterals.length) continue;
    for (const escrow of escrows) {
      for (const col of collaterals) {
        if (escrow.chainId === col.chainId) continue; // different chain
        escrowResults.push({
          symbol: sym,
          escrowChain: escrow.chain, escrowAddress: escrow.address, escrowChainId: escrow.chainId,
          bridgedChain: col.chain, bridgedAddress: col.address, bridgedChainId: col.chainId,
          status: "mapped_no_balance_check",
        });
      }
    }
  }

  // === Summary ===
  const shortfalls = xstocksResults.filter(r => r.status === "shortfall");
  const dataGaps = xstocksResults.filter(r => r.status === "data_gap" || r.status === "partial_data");
  const backedCount = xstocksResults.filter(r => r.status === "backed").length;

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-bridge-escrow-reconciliation.js",
    scope: "Read-only bridge escrow vs circulating supply reconciliation for multi-chain tokens",
    safety: { rpcInventoryRead: false, rpcUrlsStored: false, signedActions: false, routePositive: false, signedActionJustified: false },
    thresholdPct: SHORTFALL_THRESHOLD_PCT,
    xstocks: {
      proofRowsScanned: proofRows.length,
      backed: backedCount,
      shortfalls: shortfalls.length,
      dataGaps: dataGaps.length,
      results: xstocksResults,
    },
    hyperlane: {
      warpRoutesScanned: warpProducers.length,
      escrowPairsFound: escrowResults.length,
      results: escrowResults.slice(0, 50),
    },
    summary: {
      totalChecks: xstocksResults.length + escrowResults.length,
      shortfallsFound: shortfalls.length + escrowResults.length,
      watchCandidates: shortfalls.length,
      routePositive: 0,
      signedActionJustified: false,
      closedReason: shortfalls.length ? "Shortfall(s) found; needs bridge-call mechanics analysis" : dataGaps.length ? "Data gaps persist on some tokens; recheck" : "All proof rows backed; bridging resolved",
    },
    shortfalls: shortfalls.slice(0, 30),
    requiredForRoutePositive: ["proof-of-reserves shortfall or escrow mismatch detected", "public mint/burn bridge call exploitable", "exact extractive economics positive", "fork extraction proof"],
    nextReadOnlyStep: shortfalls.length ? "Analyze bridge mechanics for shortfall tokens; fork-proof only if mint/burn call is permissionless with positive extractive economics." : "Re-scan when new proof-of-reserves data is published.",
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");
  if (!QUIET) {
    console.log(`Bridge escrow: xStocks=${xstocksResults.length} backed=${backedCount} shortfall=${shortfalls.length} gap=${dataGaps.length} hyperlane=${escrowResults.length}`);
    for (const s of shortfalls.slice(0, 5)) console.log(`  SHORTFALL ${s.symbol}: shares=${s.sharesHeld} circ=${s.circulating} gap=${s.shortfall} (${s.shortfallPct}%)`);
  }
}

main();
