#!/usr/bin/env node
// scan-pendle-pt-mispricing.js — Pattern #8: PT/YT Maturity Mispricing
// Scans Pendle markets for PT tokens listed as collateral in lending protocols
// Attack: buy discounted PT → deposit as collateral at inflated price → borrow more
//
// REGISTRY FRESHNESS FIX (2026-09-17)
// ----------------------------------
// The previous registry held nine hardcoded 2024/2025 maturities. Every row resolved
// to MATURED (latest 2025-12-25), so the tool could only ever emit zero signal, and
// that zero was indistinguishable from "no finding". The registry below holds ten
// CURRENTLY-LIVE Pendle PTs. Each was discovered from the public Pendle markets API
// (the same source tools/scan-pendle-pt-multichain-consumer-graph.js uses) and then
// re-verified with read-only eth_call on 2026-09-17:
//     * eth_getCode non-empty
//     * symbol() starts with "PT-"
//     * expiry() is in the future and equals the registry maturity
//     * isExpired() == false
// Registry entries carry their own provenance fields. The scanner additionally re-reads
// expiry() on chain every run, so a rotted registry is detected rather than trusted.
//
// SEVERITY HONESTY FIX (2026-09-17)
// ---------------------------------
// A PT being close to maturity is a calendar fact, not a mispricing finding. The old
// code emitted "CRITICAL — <7 days to maturity" / "HIGH — <30 days to maturity" from
// days-to-maturity alone. With a live registry that would have promoted a standing
// false CRITICAL/HIGH alert into the novelty-patterns condition. Maturity is now
// reported descriptively as `maturityWindow`; `critical`/`high` stay empty because this
// scanner performs no accepted-collateral-value vs PT-price comparison.
//
// If every verified target has matured, the artifact self-reports
// registryStatus="STALE_EXPIRED" instead of emitting rows as if they were fresh signal.
const { rpcCall, resolveRpc } = require("./shared-rpc");
const ethers = require("ethers");
const fs = require("fs"); const path = require("path");

const OUT = path.join(__dirname, "..", "reports", "raw", "fast", "pendle-pt-mispricing.json");

const PENDLE_MARKETS_API = "https://api-v2.pendle.finance/core/v1/{chainId}/markets/active";
const REGISTRY_SOURCE = "pendle-markets-api + onchain-verification";
const REGISTRY_DISCOVERED_AT = "2026-09-17";
const REGISTRY_REVERIFY_AFTER_DAYS = 90;

// Currently-live Pendle PTs, verified on-chain 2026-09-17 (see header).
// `verifiedSymbol` / `verifiedExpiry` are the values the read-only eth_call returned.
const PT_TOKENS = [
  // Ethereum mainnet
  { chain:1, pt:"0xb253Eff1104802b97aC7E3aC9FdD73AecE295a2c", label:"PT-stETH-30DEC2027",  maturity:1830124800, verifiedSymbol:"PT-stETH-30DEC2027",  verifiedExpiry:"2027-12-30T00:00:00.000Z" },
  { chain:1, pt:"0x77dB49aC43107f0cef6F65837aA55ee8Ae4cD9fa", label:"PT-ynRWAx-15OCT2026", maturity:1792022400, verifiedSymbol:"PT-ynRWAx-15OCT2026", verifiedExpiry:"2026-10-15T00:00:00.000Z" },
  { chain:1, pt:"0x42959E174FE28029de5Ce250B58699229a3362B0", label:"PT-sYUSD-24SEP2026",  maturity:1790208000, verifiedSymbol:"PT-sYUSD-24SEP2026",  verifiedExpiry:"2026-09-24T00:00:00.000Z" },
  { chain:1, pt:"0xb9b3A5823dfDB39389F50742eE7Bb81cF0BE56cb", label:"PT-sENA-24SEP2026",   maturity:1790208000, verifiedSymbol:"PT-sENA-24SEP2026",   verifiedExpiry:"2026-09-24T00:00:00.000Z" },
  { chain:1, pt:"0xFaE86383D512722a50192d9E6B414Dc3F067519c", label:"PT-mHYPER-24SEP2026", maturity:1790208000, verifiedSymbol:"PT-mHYPER-24SEP2026", verifiedExpiry:"2026-09-24T00:00:00.000Z" },
  { chain:1, pt:"0xc8fF5A1d899C2a453c6f10F4eA87978726cf9f63", label:"PT-mHyperBTC-24SEP2026", maturity:1790208000, verifiedSymbol:"PT-mHyperBTC-24SEP2026", verifiedExpiry:"2026-09-24T00:00:00.000Z" },
  // Base
  { chain:8453, pt:"0x1fEc97CA2817Da87f266fD1741bBA61cAf7CDe29", label:"PT-yoUSD-24SEP2026", maturity:1790208000, verifiedSymbol:"PT-yoUSD-24SEP2026", verifiedExpiry:"2026-09-24T00:00:00.000Z" },
  { chain:8453, pt:"0x45099d137C7A1f5b28BdC4443fDfECD842e1dDEE", label:"PT-apxUSD-5NOV2026", maturity:1793836800, verifiedSymbol:"PT-apxUSD-5NOV2026", verifiedExpiry:"2026-11-05T00:00:00.000Z" },
  // Arbitrum
  { chain:42161, pt:"0xc9D24Ad0bb25f34098e226A8c5192dea7BacCcAE", label:"PT-USDai-15OCT2026", maturity:1792022400, verifiedSymbol:"PT-USDai-15OCT2026", verifiedExpiry:"2026-10-15T00:00:00.000Z" },
  { chain:42161, pt:"0xe9D07C2a3588b9A25EDd55664bE44ecFE5F92FcE", label:"PT-sUSDai-25FEB2027", maturity:1803513600, verifiedSymbol:"PT-sUSDai-25FEB2027", verifiedExpiry:"2027-02-25T00:00:00.000Z" },
].map((t) => ({ ...t, registrySource: REGISTRY_SOURCE, registryDiscoveredAt: REGISTRY_DISCOVERED_AT }));

// Lending protocols that are known to consider PT collateral. Recorded in the artifact
// as context only: this scanner does not read their oracles or LTVs.
const LENDING_MARKETS = [
  { chain:1, label:"Morpho Blue", addr:"0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb" },
  { chain:1, label:"Silo Finance", addr:"0x6f80310CA7F2C654691D1383149Fa1A57d8AB1f8" },
  { chain:1, label:"Euler", addr:"0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" },
];

const PT_IFACE = new ethers.Interface([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function expiry() view returns (uint256)",
  "function isExpired() view returns (bool)",
]);

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

async function read(rpc, to, frag) {
  const raw = await rpcCall(rpc, "eth_call", [{ to, data: PT_IFACE.encodeFunctionData(frag) }, "latest"], 5000);
  if (!raw || raw.length < 3) return null;
  try { return PT_IFACE.decodeFunctionResult(frag, raw)[0]; } catch (_) { return null; }
}

function maturityWindow(days) {
  if (days === null || days === undefined) return "UNKNOWN";
  if (days < 0) return "MATURED";
  if (days < 7) return "LT_7D";
  if (days < 30) return "LT_30D";
  if (days < 90) return "LT_90D";
  return "GT_90D";
}

function describeRisk(r) {
  if (!r.ptVerified) return "UNVERIFIED — target did not verify as a Pendle PT (symbol/expiry read failed)";
  if (r.maturityWindow === "MATURED") return "INFO — matured (historical registry row; not a live mispricing finding)";
  return "INFO — " + r.maturityWindow + " to maturity; maturity proximity alone is not a mispricing finding "
    + "(no accepted-collateral-value vs PT-price comparison is performed by this scanner)";
}

async function scanPT(rpc, ptCfg) {
  const r = {
    ...ptCfg,
    supply:"N/A", rateToUnderlying:null, daysToMaturity:null, maturityWindow:"UNKNOWN",
    maturitySource:"registry", onchainSymbol:null, isExpired:null, ptVerified:false,
    deployed:null, codeBytes:null, risk:"UNKNOWN",
  };

  const code = await rpcCall(rpc, "eth_getCode", [ptCfg.pt, "latest"], 3000);
  r.codeBytes = code ? (code.length - 2) / 2 : 0;

  const symbol = await read(rpc, ptCfg.pt, "function symbol() view returns (string)");
  r.onchainSymbol = typeof symbol === "string" ? symbol : null;
  const decimals = await read(rpc, ptCfg.pt, "function decimals() view returns (uint8)");
  const supply = await read(rpc, ptCfg.pt, "function totalSupply() view returns (uint256)");
  const expiry = await read(rpc, ptCfg.pt, "function expiry() view returns (uint256)");
  const isExpired = await read(rpc, ptCfg.pt, "function isExpired() view returns (bool)");

  // A contract that answers ABI calls is deployed even when a flaky endpoint returns an
  // empty eth_getCode (observed on Base during 2026-09-17 verification).
  r.deployed = r.codeBytes > 0 || r.onchainSymbol !== null;

  if (decimals !== null && supply !== null) {
    r.supply = Number(supply) / 10 ** Number(decimals);
  }

  if (expiry !== null) {
    r.maturity = Number(expiry);
    r.maturitySource = "onchain-expiry()";
    if (r.maturity !== ptCfg.maturity) r.registryMaturityMismatch = true;
  }
  r.isExpired = typeof isExpired === "boolean" ? isExpired : null;

  r.ptVerified = typeof r.onchainSymbol === "string"
    && r.onchainSymbol.startsWith("PT-")
    && r.maturitySource === "onchain-expiry()";

  const daysLeft = (r.maturity - NOW) / DAY;
  r.daysToMaturity = Math.round(daysLeft);
  r.maturityWindow = maturityWindow(daysLeft);
  r.risk = describeRisk(r);
  return r;
}

async function main() {
  console.log("=== Pendle PT Maturity Mispricing Scanner (Pattern #8) ===\n");
  console.log("Attack: PT approaches maturity → price converges to underlying");
  console.log("Lending protocols that don't mark PT to market → overcollateralized borrow\n");
  console.log("Registry: " + PT_TOKENS.length + " targets from " + REGISTRY_SOURCE
    + " (discovered " + REGISTRY_DISCOVERED_AT + ")\n");

  const results = [];
  const rpcs = {};

  for (const pt of PT_TOKENS) {
    if (!rpcs[pt.chain]) rpcs[pt.chain] = await resolveRpc(pt.chain);
    if (!rpcs[pt.chain]) { results.push({...pt, error:"no-rpc", ptVerified:false, risk:"UNVERIFIED — no RPC available"}); continue; }

    let r = await scanPT(rpcs[pt.chain], pt);
    // One retry on a fresh endpoint: Base endpoints returned inconsistent code/call
    // results during 2026-09-17 verification.
    if (!r.ptVerified) {
      const rpc2 = await resolveRpc(pt.chain);
      if (rpc2 && rpc2 !== rpcs[pt.chain]) {
        rpcs[pt.chain] = rpc2;
        const retry = await scanPT(rpc2, pt);
        if (retry.ptVerified) r = retry;
      }
    }
    results.push(r);

    const days = r.daysToMaturity !== null ? r.daysToMaturity + "d" : "N/A";
    const deployed = r.deployed ? "" : " NOT FOUND";
    const sym = r.onchainSymbol || "no symbol";
    console.log(r.label.padEnd(24) + days.padEnd(8) + r.maturityWindow.padEnd(11) + (r.ptVerified ? "verified " : "UNVERIFIED ") + sym + deployed);
  }

  // Registry freshness self-report
  const verifiedRows = results.filter(r => r.ptVerified);
  const liveRows = verifiedRows.filter(r => r.daysToMaturity !== null && r.daysToMaturity >= 0);
  const registryAgeDays = Math.floor((NOW - Math.floor(Date.parse(REGISTRY_DISCOVERED_AT) / 1000)) / DAY);
  let registryStatus, registryNote;
  if (verifiedRows.length === 0) {
    registryStatus = "UNVERIFIED";
    registryNote = "No registry target verified as a Pendle PT on this run; the artifact is intentionally signal-free. Re-check RPC availability and the registry addresses.";
  } else if (liveRows.length === 0) {
    registryStatus = "STALE_EXPIRED";
    registryNote = "Every verified registry target has matured. The artifact is intentionally signal-free (no MATURED row is a finding). Refresh targets from " + PENDLE_MARKETS_API + " and re-verify on-chain before the next promotion attempt.";
  } else if (liveRows.length < verifiedRows.length) {
    registryStatus = "PARTIAL_EXPIRED";
    registryNote = (verifiedRows.length - liveRows.length) + " of " + verifiedRows.length + " verified targets have matured; refresh them from " + PENDLE_MARKETS_API + ".";
  } else {
    registryStatus = "LIVE";
    registryNote = "All " + liveRows.length + " verified targets are unexpired. Re-verify against " + PENDLE_MARKETS_API + " once older than " + REGISTRY_REVERIFY_AFTER_DAYS + " days.";
  }
  if (registryAgeDays > REGISTRY_REVERIFY_AFTER_DAYS && registryStatus === "LIVE") {
    registryStatus = "LIVE_STALE_REGISTRY";
    registryNote = "Targets are live but the registry was discovered " + registryAgeDays + " days ago; re-verify addresses/expiries.";
  }

  // Lending-protocol exposure context (no oracle/LTV read is performed here)
  const exposureWatch = results
    .filter(r => r.ptVerified && r.daysToMaturity !== null && r.daysToMaturity >= 0 && r.daysToMaturity < 90)
    .map(r => ({
      chain: r.chain, label: r.label, pt: r.pt, daysToMaturity: r.daysToMaturity,
      maturityWindow: r.maturityWindow,
      note: "check PT accepted-collateral value vs PT market/redemption price in Morpho/Silo/Euler",
    }));

  console.log("\n=== Lending Protocol Exposure (context only) ===");
  if (exposureWatch.length === 0) console.log("  no verified live target inside 90 days");
  for (const e of exposureWatch) {
    console.log("  WATCH: " + e.label + " — " + e.daysToMaturity + "d to maturity (" + e.maturityWindow + ")");
  }

  const critical = []; // no verified mispricing check exists, so nothing promotes
  const high = [];
  const promotionBlocker = "requires an accepted-collateral-value vs PT market/redemption-price comparison plus a consumer join (not performed by this scanner)";

  console.log("\n=== Summary ===");
  console.log("CRITICAL: " + critical.length + " | HIGH: " + high.length);
  console.log("PT tokens scanned: " + results.length + " | verified: " + verifiedRows.length + " | live: " + liveRows.length);
  console.log("Registry status: " + registryStatus);
  console.log("Next: verify which lending protocols list these PTs as collateral and at what accepted value");

  fs.writeFileSync(OUT, JSON.stringify({
    scannedAt: new Date().toISOString(),
    registryStatus,
    registryNote,
    registrySource: REGISTRY_SOURCE,
    registryDiscoveredAt: REGISTRY_DISCOVERED_AT,
    registryAgeDays,
    results,
    exposureWatch,
    lendingProtocolsConsidered: LENDING_MARKETS,
    critical,
    high,
    promotionBlocker,
  }, null, 2));
  console.log("Artifact: " + OUT);
}
main().catch(e => { console.error(e.message); process.exit(1); });
