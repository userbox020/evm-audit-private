#!/usr/bin/env node
// monitor-hyperliquid-funding.js — Hyperliquid Perp Funding Rate Arbitrage Scanner
// Polls predicted funding rates. Alerts when >200% APR with active spot pairs.
// Profit model: open spot+perp delta-neutral, collect funding every 8h.
const fs = require("fs"); const path = require("path");
const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "hyperliquid-funding-arb.json");

const HL_INFO = "https://api.hyperliquid.xyz/info";

async function hlPost(type, user = null) {
  try {
    const body = { type };
    if (user) body.user = user;
    const r = await fetch(HL_INFO, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    return await r.json();
  } catch (e) { return null; }
}

async function main() {
  console.log("=== Hyperliquid Funding Arbitrage Scanner ===\n");

  // 1. Get all perp metadata + funding
  console.log("Fetching perp meta + funding...");
  const metaAndCtxs = await hlPost("metaAndAssetCtxs");
  if (!metaAndCtxs || !Array.isArray(metaAndCtxs) || metaAndCtxs.length < 2) {
    console.log("API error"); return;
  }

  const [meta, ctxs] = metaAndCtxs;
  const perps = meta?.universe || [];
  console.log("Perps: " + perps.length);

  // 2. Get spot metadata for matching pairs
  console.log("Fetching spot meta...");
  const spotMeta = await hlPost("spotMeta");
  const spots = spotMeta?.tokens || [];
  console.log("Spot tokens: " + spots.length);

  // 3. Compute funding rates and match with spot pairs
  const results = [];
  const spotNames = new Set(spots.map(s => s.name?.toLowerCase()).filter(Boolean));

  for (let i = 0; i < perps.length; i++) {
    const p = perps[i];
    const ctx = ctxs?.[i];
    if (!ctx || !p.name) continue;

    // funding = (premium * fundingPeriod) / oraclePrice (8h rate)
    // Convert to APR: fundingRate * 3 * 365 (3 funding periods per day, 365 days)
    const funding = ctx.funding || ctx.premium || "0";
    const fundingNum = Number(funding);
    const price = Number(ctx.oraclePx || ctx.markPx || "0");
    const openInterest = Number(ctx.openInterest || "0");
    const dailyVolume = Number(ctx.dayNtlVlm || "0");

    if (price <= 0) continue;

    // 8h funding rate as decimal
    const fundingRate8h = Math.abs(fundingNum) / price;
    // Annualize: 8h rate * 3 periods/day * 365 days
    const aprPct = fundingRate8h * 3 * 365 * 100;

    // Check if there's a matching spot pair
    const nameLower = p.name?.toLowerCase();
    const hasSpot = nameLower ? spotNames.has(nameLower) : false;

    if (aprPct > 50) { // Only report significant rates
      results.push({
        name: p.name,
        index: p.index,
        oraclePrice: price,
        fundingRate8h: fundingRate8h,
        aprPct: aprPct.toFixed(1),
        openInterest: Math.round(openInterest),
        dailyVolume: Math.round(dailyVolume),
        hasSpotPair: hasSpot,
        direction: fundingNum > 0 ? "LONG_PAYS_SHORT" : "SHORT_PAYS_LONG",
      });
    }
  }

  // 4. Sort by APR descending
  results.sort((a, b) => Number(b.aprPct) - Number(a.aprPct));

  // 5. Report top opportunities
  console.log("\nTop Funding Carry Opportunities:");
  console.log("(APR > 100%, spot pair, and $1M daily volume = capital/manual candidate, not low-fund executable)");
  console.log("");

  const capitalPositionCandidates = results.filter(r => Number(r.aprPct) > 100 && r.hasSpotPair && r.dailyVolume > 1000000);
  const watch = results.filter(r => Number(r.aprPct) > 50);

  console.log("Capital/manual candidates (>100% APR + spot + $1M daily vol):");
  if (capitalPositionCandidates.length === 0) {
    console.log("  None currently");
  } else {
    for (const r of capitalPositionCandidates.slice(0, 5)) {
      console.log(`  ${r.name.padEnd(12)}: ${r.aprPct}% APR OI=$${(r.openInterest/1e6).toFixed(1)}M vol=$${(r.dailyVolume/1e6).toFixed(1)}M ${r.direction} ${r.hasSpotPair?"spot":"no-spot"}`);
      // Profit model
      const dailyReturn = Number(r.aprPct) / 365;
      console.log(`    Daily return: ${dailyReturn.toFixed(2)}% on deployed capital. $10K → $${Math.round(10000*dailyReturn/100)}/day`);
      console.log("    Blocked for low-fund route: requires spot+perp capital, time-based funding accrual, and active rebalancing.");
    }
  }

  console.log("\nWatch (>50% APR): " + watch.length + " candidates");

  const capitalNames = new Set(capitalPositionCandidates.map(r => r.name));
  const annotatedTop10 = results.slice(0, 10).map(r => ({
    ...r,
    capitalPositionCandidate: capitalNames.has(r.name),
    routePositive: false,
    executableNow: false,
    lowFundExecutable: false,
    blockers: capitalNames.has(r.name)
      ? [
          "Requires own capital in spot and perp positions",
          "Funding is time-based and not atomic",
          "Requires ongoing rebalancing and liquidation-risk management",
        ]
      : ["Missing spot pair, volume gate, or APR gate for a capital/manual carry candidate"],
  }));

  fs.writeFileSync(OUT, JSON.stringify({
    scannedAt: new Date().toISOString(),
    scanner: "tools/monitor-hyperliquid-funding.js",
    scope: "Read-only funding carry monitor; not a low-fund executable route source",
    safety: {
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
      lowFundExecutable: false,
    },
    methodology: "Funding carry requires deployed spot+perp capital and time-based accrual; route-positive remains false unless a same-transaction, no-capital-lock extraction path appears.",
    perpsTotal: perps.length,
    spotsTotal: spots.length,
    executable: 0,
    executableMeaning: "low-fund executable routes; capital-position funding carry is excluded",
    capitalPositionCandidates: capitalPositionCandidates.length,
    lowFundExecutable: 0,
    routePositive: 0,
    watch: watch.length,
    topCapitalPositionCandidates: capitalPositionCandidates.slice(0, 5),
    top10: annotatedTop10,
  }, null, 2));
  console.log("\nArtifact: " + OUT);
}
main().catch(e => { console.error(e.message); process.exit(1); });
