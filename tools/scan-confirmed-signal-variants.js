#!/usr/bin/env node
// scan-confirmed-signal-variants.js - classify confirmed reports into reusable exploit-pattern seeds.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT_JSON = path.join(WORKSPACE, "reports", "raw", "fast", "confirmed-signal-variants.json");
const OUT_MD = path.join(WORKSPACE, "reports", "confirmed-signal-variant-plan.md");
const STEAMM_MARKETABILITY = path.join(WORKSPACE, "reports", "raw", "steamm-candidate-marketability.json");

const CONFIRMED_REPORTS = [
  {
    file: "reports/EXAMPLE-CONFIRMED-EXPLOIT.md",
    title: "Example Exploit Report",
    category: "noise-template",
    patternIds: [],
    currentActionability: "ignore",
    blocker: "Template/example report, not a real target artifact.",
    priority: 0,
  },
  {
    file: "reports/hop-triage.md",
    title: "Hop Protocol v1 root-domain separation",
    category: "privileged-liveness",
    patternIds: ["bridge-domain-separation"],
    currentActionability: "variant-seed-only",
    blocker: "Registered-bonder prerequisite and liveness/freeze impact rather than direct permissionless TVL extraction.",
    priority: 42,
  },
  {
    file: "reports/kamino-klend-liquidation-disclosure.md",
    title: "Kamino Klend liquidation price-status bypass disclosure",
    category: "event-driven-live-window",
    patternIds: ["validation-differential-liquidation"],
    currentActionability: "monitor-and-variant-scan",
    blocker: "Requires a fresh oracle status that fails omitted full checks while still satisfying liquidation checks.",
    priority: 74,
  },
  {
    file: "reports/kamino-triage.md",
    title: "Kamino Klend / Kvault triage",
    category: "event-driven-live-window",
    patternIds: ["validation-differential-liquidation"],
    currentActionability: "monitor-and-variant-scan",
    blocker: "No currently proven same-slot executable liquidation window from cached live state.",
    priority: 72,
  },
  {
    file: "reports/loopscale-exploit-plan.md",
    title: "LoopScale historical liquidation replay",
    category: "historical-disabled",
    patternIds: ["pt-oracle-unit-mismatch"],
    currentActionability: "variant-seed-only",
    blocker: "Historical path appears removed/disabled and current flow requires a protocol-admin co-signer.",
    priority: 58,
  },
  {
    file: "reports/loopscale-triage.md",
    title: "LoopScale cross-protocol PT collateral triage",
    category: "historical-disabled",
    patternIds: ["pt-oracle-unit-mismatch"],
    currentActionability: "variant-seed-only",
    blocker: "Historical RateX PT collateral mints are not present in the current loaded market state.",
    priority: 58,
  },
  {
    file: "reports/suilend-suite-triage.md",
    title: "Suilend / STEAMM zero-offset CPMM",
    category: "live-style-variant",
    patternIds: ["invariant-zero-amm"],
    currentActionability: "highest-priority-variant-scan",
    blocker: "Existing report includes a live executed drain; follow-up must be variant/redeemability research only, not live execution.",
    priority: 82,
  },
  {
    file: "reports/synapse-hypercall-triage.md",
    title: "Synapse / Hypercall gas and replay findings",
    category: "dormant-prelaunch-testnet",
    patternIds: ["signed-payload-replay", "gas-accounting-tip-race"],
    currentActionability: "variant-seed-only",
    blocker: "Hypercall is testnet/prelaunch; Synapse core mainnet path is dormant and tip/liveness impact is not principal drain.",
    priority: 46,
  },
];

const PATTERN_DEFS = {
  "invariant-zero-amm": {
    rank: 1,
    bugClass: "Zero-reserve / zero-offset AMM invariant collapse",
    directImpactShape: "Single swap can quote nearly all non-empty reserve when invariant baseline is zero.",
    whyReusable: "Any AMM formula with virtual reserve/offset disabled and a zero input-side reserve can collapse to full-reserve output while k0 remains zero.",
    firstReadOnlyStep: "Rank known one-sided zero-offset pools by output token marketability, redeemability, and consumer links; reopen only if exact unwind economics are positive.",
    requiredForRoutePositive: [
      "output token is redeemable or has exact DEX exit liquidity",
      "pool remains one-sided with zero virtual offset",
      "net output value exceeds input/gas/fees",
      "local/fork extraction proof",
    ],
    staticSearchTerms: ["offset", "reserve_in", "reserve_out", "k0", "k1", "safe_mul_div", "one-sided"],
    targetHints: ["targets/steamm-public", "targets/suilend", "targets/scallop-sui-lending-protocol"],
  },
  "validation-differential-liquidation": {
    rank: 2,
    bugClass: "Liquidation path accepts weaker oracle/status validation than borrow/withdraw paths",
    directImpactShape: "Unfair or profitable liquidation when a price is fresh enough for liquidation but rejected by full safety checks.",
    whyReusable: "Many protocols intentionally relax liquidation checks for liveness; the gap becomes extractive if the reduced set omits TWAP, heuristic, bound, or stale checks.",
    firstReadOnlyStep: "Scan lending/perps code for liquidation-specific freshness/status constants and compare them to borrow/withdraw/full-check gates.",
    requiredForRoutePositive: [
      "reduced liquidation gate excludes a configured price safety check",
      "live market has material at-risk obligations",
      "oracle anomaly can be observed or triggered in the same transaction/slot",
      "exact liquidation route is profitable after exit costs",
    ],
    staticSearchTerms: ["LIQUIDATION_CHECKS", "ALL_CHECKS", "PriceStatusFlags", "is_stale", "liquidatable", "TWAP", "heuristic"],
    targetHints: ["targets/kamino-klend", "targets/kamino-kvault", "targets/drift-protocol-v2", "targets/jupiter-lend"],
  },
  "pt-oracle-unit-mismatch": {
    rank: 3,
    bugClass: "Principal-token / oracle unit mismatch in lending collateral valuation",
    directImpactShape: "Tiny PT amount is valued as full-notional collateral, enabling overborrow or unfair liquidation.",
    whyReusable: "PT/YT and RWA receipts are easy to misprice when metadata decimals, maturity discount, exchange rate, or oracle units diverge.",
    firstReadOnlyStep: "Join PT/RWA/receipt tokens to lending collateral consumers, then compare oracle unit value against conservative redemption/market value.",
    requiredForRoutePositive: [
      "PT/RWA receipt is accepted as collateral",
      "oracle valuation exceeds market/redemption value after collateral haircut",
      "borrow cash and DEX/hold-to-maturity exit are available",
      "fork/local extraction proof",
    ],
    staticSearchTerms: ["principal", "PT", "maturity", "RateX", "oracle", "assetIdentifier", "ltv"],
    targetHints: ["targets/loopscale", "targets/pendle-core-v2-public", "targets/silo-contracts-v2", "targets/morpho-blue"],
  },
  "bridge-domain-separation": {
    rank: 4,
    bugClass: "Bridge root/message identifier omits chain/domain fields",
    directImpactShape: "Valid message/root for one domain can be bonded, replayed, or settled under another domain.",
    whyReusable: "Bridges often hash only payload/root/amount while treating origin/destination as parameters in later calls.",
    firstReadOnlyStep: "Scan bridge roots, message IDs, and nonce IDs for missing origin/destination/message-type fields in the signed or stored identifier.",
    requiredForRoutePositive: [
      "domain-colliding identifier found in deployed bridge path",
      "attacker can submit/call the colliding action permissionlessly or with accessible role",
      "impact maps to extractable funds or material settlement capture",
      "fork/local proof",
    ],
    staticSearchTerms: ["transferRootId", "rootHash", "destinationChainId", "originChainId", "nonce", "messageType", "domain"],
    targetHints: ["targets/hop-contracts", "targets/debridge-contracts", "targets/stargate-v2", "targets/layerzero-v2", "targets/hyperlane-monorepo"],
  },
  "signed-payload-replay": {
    rank: 5,
    bugClass: "Signed payload replay or nonce scope failure",
    directImpactShape: "Captured signatures can be replayed across order, agent, config, or chain/message scopes.",
    whyReusable: "EIP-712 and API-signed protocols frequently validate signatures but under-scope nonces, domains, or revoked agent state.",
    firstReadOnlyStep: "Scan signed-write APIs/contracts for nonce storage keyed only by wallet or missing message-type/chain/action scope.",
    requiredForRoutePositive: [
      "write endpoint or contract is live/mainnet",
      "valid signature can be replayed after intended one-time use or revocation",
      "replay causes asset movement or position-control impact",
      "controlled-account or fork proof",
    ],
    staticSearchTerms: ["EIP712", "nonce", "replay", "authorized", "agent", "signature", "permit"],
    targetHints: ["targets/synapse-sanguine", "targets/near-intents", "targets/dln-contracts", "targets/polymarket-ctf-exchange-v2"],
  },
  "gas-accounting-tip-race": {
    rank: 6,
    bugClass: "Executor gas-accounting race / false failed execution",
    directImpactShape: "Under-supplied EIP-150 call records failure and awards fees/tips to the wrong executor.",
    whyReusable: "Cross-chain executors often check gas before CALL but forget EIP-150 headroom and post-call accounting.",
    firstReadOnlyStep: "Scan executor hubs for `gasleft() > gasLimit` followed by bounded `call` and first-failure fee attribution.",
    requiredForRoutePositive: [
      "permissionless execute path is live",
      "fee/tip value is material and repeatedly claimable",
      "gas calibration produces false failure without principal risk",
      "fork/local proof",
    ],
    staticSearchTerms: ["gasleft", "gasLimit", "safeCall", "firstExecutor", "Failed", "tip"],
    targetHints: ["targets/synapse-sanguine", "targets/hyperlane-monorepo", "targets/across-contracts", "targets/layerzero-v2"],
  },
};

const EXCLUDED_DIRS = new Set([".git", "node_modules", "target", "build", "dist", "cache", "out", "artifacts", "coverage", ".next"]);
const TEXT_EXTS = new Set([".sol", ".rs", ".move", ".ts", ".tsx", ".js", ".jsx", ".go", ".md", ".json", ".toml", ".yaml", ".yml"]);

function rel(filePath) {
  return path.relative(WORKSPACE, filePath).replace(/\\/g, "/");
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (_) {
    return "";
  }
}

function readJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function existsRel(relPath) {
  return fs.existsSync(path.join(WORKSPACE, relPath));
}

function reportTitle(text) {
  const first = text.split(/\r?\n/).find((line) => line.startsWith("# ")) || "";
  return first.replace(/^#\s+/, "").trim();
}

function walkFiles(root, out = []) {
  if (!fs.existsSync(root)) return out;
  const stat = fs.statSync(root);
  if (stat.isFile()) {
    if (stat.size <= 2_000_000 && TEXT_EXTS.has(path.extname(root).toLowerCase())) out.push(root);
    return out;
  }
  if (!stat.isDirectory()) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;
    walkFiles(path.join(root, entry.name), out);
  }
  return out;
}

function staticHits(pattern, limit = 60) {
  const terms = pattern.staticSearchTerms || [];
  const files = [];
  for (const hint of pattern.targetHints || []) walkFiles(path.join(WORKSPACE, hint), files);
  const hits = [];
  for (const filePath of files) {
    const text = readText(filePath);
    if (!text) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const matchedTerms = terms.filter((term) => line.toLowerCase().includes(term.toLowerCase()));
      if (!matchedTerms.length) continue;
      hits.push({ file: rel(filePath), line: i + 1, matchedTerms, snippet: line.trim().slice(0, 220) });
      if (hits.length >= limit) return { filesScanned: files.length, hits };
    }
  }
  return { filesScanned: files.length, hits };
}

function uniq(items) {
  return [...new Set(items.filter(Boolean))];
}

function markdownTable(rows, headers) {
  const lines = [];
  lines.push(`| ${headers.join(" | ")} |`);
  lines.push(`| ${headers.map(() => "---").join(" | ")} |`);
  for (const row of rows) lines.push(`| ${headers.map((h) => row[h] ?? "").join(" | ")} |`);
  return lines.join("\n");
}

function main() {
  const reportRows = CONFIRMED_REPORTS.map((row) => {
    const abs = path.join(WORKSPACE, row.file);
    const text = readText(abs);
    return {
      ...row,
      exists: fs.existsSync(abs),
      detectedTitle: reportTitle(text),
      bytes: text.length,
      routePositive: 0,
      signedActionJustified: false,
    };
  });

  const patternRows = Object.entries(PATTERN_DEFS).map(([id, def]) => {
    const sources = reportRows.filter((row) => row.patternIds.includes(id));
    const scan = staticHits(def);
    return {
      id,
      ...def,
      sourceReports: sources.map((row) => row.file),
      sourceCategories: uniq(sources.map((row) => row.category)),
      priorityScore: Math.max(0, 90 - def.rank * 7 + Math.min(8, sources.length * 2)),
      routePositive: 0,
      signedActionJustified: false,
      staticEvidence: {
        targetHints: def.targetHints,
        filesScanned: scan.filesScanned,
        hitsFound: scan.hits.length,
        topHits: scan.hits.slice(0, 20),
      },
    };
  }).sort((a, b) => a.rank - b.rank);

  const actionablePatterns = patternRows.filter((row) => row.sourceReports.length > 0);
  const steammMarketability = readJson(STEAMM_MARKETABILITY, null);
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-confirmed-signal-variants.js",
    scope: "Confirmed report actionability matrix and variant-seed plan",
    safety: {
      rpcInventoryRead: false,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: false,
      signedActionJustified: false,
    },
    summary: {
      confirmedReportsInput: CONFIRMED_REPORTS.length,
      confirmedReportsFound: reportRows.filter((row) => row.exists).length,
      ignoredAsTemplate: reportRows.filter((row) => row.category === "noise-template").length,
      actionablePatternSeeds: actionablePatterns.length,
      highestPriorityPattern: actionablePatterns[0]?.id || null,
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      nextBranch: actionablePatterns[0]?.firstReadOnlyStep || null,
    },
    actionabilityRows: reportRows,
    patternSeeds: actionablePatterns,
    followUpChecks: {
      steammMarketability: steammMarketability?.generatedAt ? {
        artifact: rel(STEAMM_MARKETABILITY),
        generatedAt: steammMarketability.generatedAt,
        candidateCount: steammMarketability.summary?.candidateCount ?? steammMarketability.candidateCount,
        dexPricedCount: steammMarketability.summary?.dexPricedCount ?? steammMarketability.dexPricedCount,
        steammRouteOnlyCount: steammMarketability.summary?.steammRouteOnlyCount ?? steammMarketability.steammRouteOnlyCount,
        unpricedCount: steammMarketability.summary?.unpricedCount ?? steammMarketability.unpricedCount,
        bestLiquidityUsd: steammMarketability.summary?.bestLiquidityUsd ?? 0,
        routePositive: 0,
        blocker: steammMarketability.summary?.blocker || "STEAMM marketability artifact has no route-positive row.",
      } : null,
    },
    closedGateReason: "Confirmed historical/testnet/event-driven signals are useful variant seeds, but none currently emit exact positive economics or fork-ready routePositive state.",
  };

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, `${JSON.stringify(artifact, null, 2)}\n`);

  const actionRows = reportRows.map((row) => ({
    Report: row.file.replace(/^reports\//, ""),
    Category: row.category,
    Pattern: row.patternIds.length ? row.patternIds.join(", ") : "ignore",
    Actionability: row.currentActionability,
    Blocker: row.blocker,
  }));
  const patternMdRows = actionablePatterns.map((row) => ({
    Rank: String(row.rank),
    Pattern: row.id,
    "Why It Matters": row.directImpactShape,
    "Next Read-Only Step": row.firstReadOnlyStep,
    Gate: "routePositive=0",
  }));
  const md = [
    "# 🟢 DORMANT — Confirmed Signal Variant Plan",
    "",
    `Date: ${new Date().toISOString().slice(0, 10)}`,
    "",
    "## Result",
    "",
    "Confirmed reports are now classified as variant seeds, not immediate execution targets. No current row has exact positive economics, fork proof, or signed-action justification.",
    "",
    "## Actionability Matrix",
    "",
    markdownTable(actionRows, ["Report", "Category", "Pattern", "Actionability", "Blocker"]),
    "",
    "## Prioritized Variant Seeds",
    "",
    markdownTable(patternMdRows, ["Rank", "Pattern", "Why It Matters", "Next Read-Only Step", "Gate"]),
    "",
    "## Step 1 Closeout",
    "",
    steammMarketability?.generatedAt
      ? markdownTable([
        {
          Check: "STEAMM marketability",
          Artifact: "reports/raw/steamm-candidate-marketability.json",
          Candidates: String(steammMarketability.summary?.candidateCount ?? steammMarketability.candidateCount),
          "DEX Priced": String(steammMarketability.summary?.dexPricedCount ?? steammMarketability.dexPricedCount),
          "Route Only": String(steammMarketability.summary?.steammRouteOnlyCount ?? steammMarketability.steammRouteOnlyCount),
          Unpriced: String(steammMarketability.summary?.unpricedCount ?? steammMarketability.unpricedCount),
          Verdict: "No route-positive marketable output",
        },
      ], ["Check", "Artifact", "Candidates", "DEX Priced", "Route Only", "Unpriced", "Verdict"])
      : "Pending: run `node tools/steamm_candidate_marketability.js` to close the invariant-zero AMM marketability step.",
    "",
    "## Gate",
    "",
    "No fork, deployment, executor change, signed action, or exploit execution is justified until a follow-up scanner emits `routePositive > 0` with exact positive economics and fork proof.",
    "",
    "## Artifacts",
    "",
    `- JSON: \`${rel(OUT_JSON)}\``,
    `- Scanner: \`${rel(__filename)}\``,
    "",
  ].join("\n");
  fs.writeFileSync(OUT_MD, md);

  console.log(`Confirmed signal variants: patterns=${actionablePatterns.length}; routePositive=0; wrote ${rel(OUT_JSON)} and ${rel(OUT_MD)}`);
}

main();
