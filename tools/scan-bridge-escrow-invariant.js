#!/usr/bin/env node
// scan-bridge-escrow-invariant.js — Read-only OP Stack bridge escrow vs L2
// wrapped-supply reconciliation scanner.
// For Base and Optimism OP Stack bridges, reads L1 escrow token balances and
// compares against L2 wrapped token total supplies. Flags escrow shortfalls
// (>0.5% delta).
// No ethers dependency — manual ABI encoding via eth_call.
// RPC URLs are resolved in memory only and never printed or stored.

const fs = require("fs");
const path = require("path");
const { resolveRpc, rpcCall } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "bridge-escrow-invariant.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "bridge-escrow-invariant.md");
const QUIET = process.argv.includes("--quiet");

const SHORTFALL_THRESHOLD_PCT = 0.5;

// ---------------------------------------------------------------------------
// Bridge definitions
// ---------------------------------------------------------------------------
const BRIDGES = [
  {
    name: "Base",
    l1Bridge: "0x3154Cf16ccdb4C6d922629664174b904d80F2C35",
    l2Predeploy: "0x4200000000000000000000000000000000000010",
    l1ChainId: 1,
    l2ChainId: 8453,
  },
  {
    name: "Optimism",
    l1Bridge: "0x99C9fc46f92E8a1c0deC1b1747d010903E884bE1",
    l2Predeploy: "0x4200000000000000000000000000000000000010",
    l1ChainId: 1,
    l2ChainId: 10,
  },
];

// ---------------------------------------------------------------------------
// Token pairs (same underlying asset on both L1 and L2)
// ---------------------------------------------------------------------------
const TOKEN_PAIRS = {
  WETH:   { l1: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", symbol: "WETH", decimals: 18 },
  USDC:   { l1: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", decimals: 6,
            l2Base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", l2Optimism: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" },
  USDT:   { l1: "0xdAC17F958D2ee523a2206206994597C13D831ec7", symbol: "USDT", decimals: 6,
            l2Base: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", l2Optimism: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58" },
  DAI:    { l1: "0x6B175474E89094C44Da98b954EedeAC495271d0F", symbol: "DAI",  decimals: 18,
            l2Base: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", l2Optimism: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1" },
  WBTC:   { l1: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", symbol: "WBTC", decimals: 8,
            l2Optimism: "0x68f180fcCe6836688e9084f035309E29Bf0A2095" },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function log(...args) {
  if (!QUIET) console.log(...args);
}

function toLower(addr) {
  return String(addr).toLowerCase();
}

// ---------------------------------------------------------------------------
// RPC helpers — manual ABI encoding
// ---------------------------------------------------------------------------

async function readBalance(rpc, tokenAddr, ownerAddr) {
  const paddedOwner = toLower(ownerAddr).slice(2).padStart(64, "0");
  const data = "0x70a08231" + paddedOwner;
  const raw = await rpcCall(rpc, "eth_call", [{ to: toLower(tokenAddr), data }, "latest"], 8000);
  if (!raw || raw === "0x") return null;
  return BigInt(raw);
}

async function readTotalSupply(rpc, tokenAddr) {
  const data = "0x18160ddd";
  const raw = await rpcCall(rpc, "eth_call", [{ to: toLower(tokenAddr), data }, "latest"], 8000);
  if (!raw || raw === "0x") return null;
  return BigInt(raw);
}

// ---------------------------------------------------------------------------
// Get the L2 token address for a given token pair and bridge name
// ---------------------------------------------------------------------------
function getL2Token(token, bridgeName) {
  if (bridgeName === "Base") return token.l2Base || null;
  if (bridgeName === "Optimism") return token.l2Optimism || null;
  return null;
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

function generateMarkdown(artifact) {
  const { generatedAt, summary, rows } = artifact;
  const date = generatedAt ? generatedAt.slice(0, 10) : new Date().toISOString().slice(0, 10);

  const violationCount = summary.escrowShortfalls || 0;
  const statusEmoji = violationCount > 0 ? "🟡" : "🟢";
  const statusLabel = violationCount > 0 ? "VIOLATIONS DETECTED" : "DORMANT";

  let md = `# ${statusEmoji} ${statusLabel} — OP Stack Bridge Escrow Invariant\n\n`;
  md += `Date: ${date}\n\n`;

  md += `## Result\n\n`;
  if (violationCount > 0) {
    md += `**⚠️ Escrow shortfalls detected.** ${violationCount} token pair(s) exceed the ${SHORTFALL_THRESHOLD_PCT}% delta threshold. See table below.\n\n`;
  } else {
    md += `No escrow shortfalls detected. All ${rows.length} token pair(s) within ${SHORTFALL_THRESHOLD_PCT}% delta threshold.\n\n`;
  }

  md += `## Summary\n\n`;
  md += `| Metric | Value |\n`;
  md += `| --- | ---: |\n`;
  md += `| Bridges checked | ${summary.bridgesChecked} |\n`;
  md += `| Token pairs checked | ${summary.tokenPairsChecked} |\n`;
  md += `| Escrow shortfalls | ${summary.escrowShortfalls} |\n`;
  md += `| Route positive | ${summary.routePositive} |\n\n`;

  if (rows.length > 0) {
    md += `## Details\n\n`;
    md += `| Bridge | Symbol | L1 Escrow | L2 Supply | Delta | Delta % | Violation |\n`;
    md += `| --- | --- | --- | --- | --- | --- | --- |\n`;
    for (const row of rows) {
      const vMark = row.violation ? "⚠ YES" : "No";
      md += `| ${row.bridge} | ${row.symbol} | ${row.l1Escrow} | ${row.l2Supply} | ${row.delta} | ${row.deltaPct.toFixed(4)}% | ${vMark} |\n`;
    }
    md += "\n";
  }

  md += `## Gate\n\n`;
  md += `Escrow shortfalls are flagged for human review. Many shortfalls are explained by time-locked deposits, cross-chain withdrawals in flight, or token rebasing. A violation alone does **NOT** constitute an executable exploit route without proof that the shortfall is permissionlessly extractable.\n\n`;

  md += `## Artifacts\n\n`;
  md += `- JSON: \`reports/raw/fast/bridge-escrow-invariant.json\`\n`;
  md += `- Scanner: \`tools/scan-bridge-escrow-invariant.js\`\n`;

  return md;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log("=== OP Stack Bridge Escrow Invariant Scanner ===");

  // Resolve L1 RPC once (shared across all bridges)
  log("Resolving L1 RPC (chainId 1)...");
  const l1Rpc = await resolveRpc(1);
  if (!l1Rpc) {
    throw new Error("Failed to resolve L1 RPC (chainId 1)");
  }

  // Resolve L2 RPCs per bridge
  const l2Rpcs = {};
  for (const bridge of BRIDGES) {
    log(`Resolving ${bridge.name} L2 RPC (chainId ${bridge.l2ChainId})...`);
    const rpc = await resolveRpc(bridge.l2ChainId);
    if (rpc) {
      l2Rpcs[bridge.l2ChainId] = rpc;
    } else {
      log(`  WARN: No RPC available for ${bridge.name} (chainId ${bridge.l2ChainId})`);
    }
  }

  const rows = [];

  for (const bridge of BRIDGES) {
    const { name, l1Bridge, l2ChainId, l1ChainId } = bridge;
    log(`\n--- ${name} Bridge ---`);

    const l2Rpc = l2Rpcs[l2ChainId];
    if (!l2Rpc) {
      log(`  SKIP ${name}: No L2 RPC resolved`);
      continue;
    }

    for (const [, token] of Object.entries(TOKEN_PAIRS)) {
      const l2TokenAddr = getL2Token(token, name);
      if (!l2TokenAddr) {
        log(`  SKIP ${token.symbol}: No L2 token address for ${name}`);
        continue;
      }

      log(`  Checking ${token.symbol}...`);

      const l1Escrow = await readBalance(l1Rpc, token.l1, l1Bridge);
      if (l1Escrow === null) {
        log(`    WARN: Failed to read L1 escrow balance for ${token.symbol}`);
        continue;
      }

      const l2Supply = await readTotalSupply(l2Rpc, l2TokenAddr);
      if (l2Supply === null) {
        log(`    WARN: Failed to read L2 totalSupply for ${token.symbol}`);
        continue;
      }

      const delta = l1Escrow >= l2Supply ? l1Escrow - l2Supply : l2Supply - l1Escrow;
      const maxVal = l1Escrow >= l2Supply ? l1Escrow : l2Supply;
      const deltaPct = maxVal > 0n ? Number(delta) / Number(maxVal) * 100 : 0;
      const violation = deltaPct > SHORTFALL_THRESHOLD_PCT;

      log(`    L1 Escrow:  ${l1Escrow.toString()}`);
      log(`    L2 Supply:  ${l2Supply.toString()}`);
      log(`    Delta:      ${delta.toString()} (${deltaPct.toFixed(4)}%)`);
      log(`    Violation:  ${violation ? "⚠ FLAGGED" : "OK"}`);

      rows.push({
        bridge: name,
        chainIds: { l1: l1ChainId, l2: l2ChainId },
        symbol: token.symbol,
        l1Escrow: l1Escrow.toString(),
        l2Supply: l2Supply.toString(),
        delta: delta.toString(),
        deltaPct: Math.round(deltaPct * 10000) / 10000,
        violation,
      });
    }
  }

  const violations = rows.filter(r => r.violation);

  const summary = {
    bridgesChecked: BRIDGES.length,
    tokenPairsChecked: rows.length,
    escrowShortfalls: violations.length,
    routePositive: 0,
  };

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-bridge-escrow-invariant.js",
    scope: "Read-only OP Stack bridge escrow vs L2 wrapped-supply invariant check",
    safety: {
      rpcInventoryRead: false,
      rpcUrlsStored: false,
      signedActions: false,
      routePositive: false,
      signedActionJustified: false,
    },
    thresholdPct: SHORTFALL_THRESHOLD_PCT,
    summary,
    rows,
  };

  // Write JSON
  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, JSON.stringify(artifact, null, 2));
  log(`\nWrote ${RAW_OUT}`);

  // Write Markdown report
  const md = generateMarkdown(artifact);
  ensureDir(REPORT_OUT);
  fs.writeFileSync(REPORT_OUT, md);
  log(`Wrote ${REPORT_OUT}`);

  // Final summary
  log(`\n=== Summary ===`);
  log(`Bridges checked:      ${summary.bridgesChecked}`);
  log(`Token pairs checked:  ${summary.tokenPairsChecked}`);
  log(`Escrow shortfalls:    ${summary.escrowShortfalls}`);
  log(`Route positive:       ${summary.routePositive}`);

  return artifact;
}

main().catch(err => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
