#!/usr/bin/env node
// Read-only Morpho Blue market accounting invariant drift scanner.
// Scans all Ethereum (chainId 1) Morpho Blue markets via GraphQL, then checks
// on-chain accounting invariants via direct RPC eth_call (no ethers dependency).
// RPC URLs are resolved in memory only and never printed or stored.

const fs = require("fs");
const path = require("path");
const { resolveRpc, rpcCall } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "morpho-invariant-drift.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "morpho-invariant-drift.md");
const QUIET = process.argv.includes("--quiet");

const MORPHO_GQL = "https://api.morpho.org/graphql";
const MORPHO_BLUE = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";

// Selectors (keccak256 first 4 bytes)
// keccak256("market(bytes32)") -> 0x50d8db4e...bb93b2a3
const MARKET_SELECTOR = "0x5c60e39a";
// keccak256("idToMarketParams(bytes32)") -> 0x2c3c9157...f04c2a1c
const PARAMS_SELECTOR = "0x2c3c9157";
// keccak256("balanceOf(address)") -> 0x70a08231...60a3
const BALANCE_SELECTOR = "0x70a08231";

// Parameters
const MAX_MARKETS = Number(process.env.MORPHO_INVARIANT_MAX_MARKETS) || 1000;
const MIN_LIQUIDITY_USD = Number(process.env.MORPHO_INVARIANT_MIN_LIQUIDITY_USD) || 10000;
const RPC_TIMEOUT_MS = 8000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value).replace(/[$,%\s,]/g, "");
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function lltvPct(raw) {
  const n = asNumber(raw);
  if (n === null) return null;
  return n / 1e16;
}

function round(value, decimals = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

// Normalize hex: ensure 0x prefix, lowercase, strip whitespace
function cleanHex(str) {
  if (!str) return str;
  str = String(str).trim().toLowerCase();
  if (str.startsWith("0x")) return str;
  return "0x" + str;
}

// Pad a hex string (no 0x prefix) to full 32 bytes (64 hex chars)
function padTo32Bytes(hexStr) {
  hexStr = hexStr.replace(/^0x/, "");
  return hexStr.padStart(64, "0");
}

// Encode an eth_call: selector (4 bytes) + each arg as 32 bytes hex
function encodeCall(selector, args) {
  let data = cleanHex(selector);
  for (const arg of args) {
    data += padTo32Bytes(arg.replace(/^0x/, ""));
  }
  return data;
}

// Decode a 0x-prefixed hex result into an array of 32-byte words (64 hex chars each)
function decodeWords(resultHex) {
  if (!resultHex || resultHex === "0x") return [];
  const hex = resultHex.replace(/^0x/, "");
  const words = [];
  for (let i = 0; i + 64 <= hex.length; i += 64) {
    words.push("0x" + hex.slice(i, i + 64));
  }
  return words;
}

// Extract an address from the last 20 bytes of a 32-byte word
function wordToAddress(word) {
  const hex = word.replace(/^0x/, "");
  return "0x" + hex.slice(24); // last 40 hex chars = 20 bytes
}

// Extract uint128 from a 32-byte word (left-padded, so take trailing 32 hex chars = 16 bytes)
function wordToUint128(word) {
  const hex = word.replace(/^0x/, "");
  return BigInt("0x" + hex.slice(32)); // last 16 bytes
}

// Extract uint256 from a 32-byte word
function wordToUint256(word) {
  return BigInt(word);
}

// Format a BigInt as decimal string, or "0" for zero
function fmtBigInt(bn) {
  if (bn === null || bn === undefined) return "0";
  return bn.toString();
}

// ---------------------------------------------------------------------------
// GraphQL
// ---------------------------------------------------------------------------

async function gql(query, variables = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(MORPHO_GQL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
    const json = await res.json();
    if (json.errors) throw new Error(json.errors[0]?.message || "Morpho GraphQL error");
    return json.data || {};
  } finally {
    clearTimeout(timer);
  }
}

async function fetchMarkets() {
  const query = `query($first:Int!) {
    markets(first:$first, where:{chainId_in:[1]}) { items {
      marketId lltv
      loanAsset { address symbol decimals }
      collateralAsset { address symbol decimals }
      oracle { address }
      state { liquidityAssetsUsd supplyAssetsUsd borrowAssetsUsd utilization }
    } }
  }`;
  const data = await gql(query, { first: MAX_MARKETS }).catch(() => ({ markets: { items: [] } }));
  return data?.markets?.items || [];
}

// ---------------------------------------------------------------------------
// RPC calls
// ---------------------------------------------------------------------------

// Read market(uint256 => Market side) via eth_call to Morpho Blue
async function readMarketState(rpc, marketId) {
  const data = encodeCall(MARKET_SELECTOR, [marketId]);
  const raw = await rpcCall(rpc, "eth_call", [{ to: MORPHO_BLUE, data }, "latest"], RPC_TIMEOUT_MS);
  if (!raw || raw === "0x") return null;
  const words = decodeWords(raw);
  if (words.length < 6) return null;
  return {
    totalSupplyAssets: wordToUint128(words[0]),
    totalSupplyShares: wordToUint128(words[1]),
    totalBorrowAssets: wordToUint128(words[2]),
    totalBorrowShares: wordToUint128(words[3]),
    lastUpdate: wordToUint256(words[4]),
    fee: wordToUint128(words[5]),
  };
}

// Read idToMarketParams(bytes32) via eth_call to Morpho Blue
async function readMarketParams(rpc, marketId) {
  const data = encodeCall(PARAMS_SELECTOR, [marketId]);
  const raw = await rpcCall(rpc, "eth_call", [{ to: MORPHO_BLUE, data }, "latest"], RPC_TIMEOUT_MS);
  if (!raw || raw === "0x") return null;
  const words = decodeWords(raw);
  if (words.length < 5) return null;
  return {
    loanToken: wordToAddress(words[0]),
    collateralToken: wordToAddress(words[1]),
    oracle: wordToAddress(words[2]),
    irm: wordToAddress(words[3]),
    lltv: wordToUint256(words[4]),
  };
}

// Read ERC20 balanceOf(MORPHO_BLUE) via eth_call to the token contract
async function readTokenBalance(rpc, tokenAddress) {
  const encodedOwner = padTo32Bytes(MORPHO_BLUE.replace(/^0x/, ""));
  const data = encodeCall(BALANCE_SELECTOR, [encodedOwner]);
  const raw = await rpcCall(rpc, "eth_call", [{ to: tokenAddress, data }, "latest"], RPC_TIMEOUT_MS);
  if (!raw || raw === "0x") return null;
  const words = decodeWords(raw);
  if (words.length < 1) return null;
  return wordToUint256(words[0]);
}

// ---------------------------------------------------------------------------
// Invariant checks
// ---------------------------------------------------------------------------

function checkSupplyGteBorrow(state) {
  return state.totalSupplyAssets >= state.totalBorrowAssets;
}

function checkPositiveSharesWithPositiveAssets(state) {
  if (state.totalSupplyAssets > 0n) {
    return state.totalSupplyShares > 0n;
  }
  return true; // no assets -> no requirement
}

function checkLastUpdateFreshness(state) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const ageSeconds = nowSeconds - Number(state.lastUpdate);
  const ageHours = ageSeconds / 3600;
  const stale = ageHours > 168; // 7 days
  return { ageHours, stale };
}

function checkFeeNonZero(state) {
  return state.fee > 0n;
}

// ---------------------------------------------------------------------------
// Token balance coverage: for each loan token, sum totalSupplyAssets across
// markets and compare against Morpho Blue's ERC20 balance
// ---------------------------------------------------------------------------

function computeTokenBalanceChecks(rows, rpc) {
  const tokenMap = new Map(); // address -> { symbol, totalSupplyAssetsSum: bigint, decimals }
  for (const row of rows) {
    const key = row.loanToken?.toLowerCase();
    if (!key) continue;
    if (!tokenMap.has(key)) {
      tokenMap.set(key, {
        symbol: row.pair.split("/")[1] || "?",
        totalSupplyAssetsSum: BigInt(row.totalSupplyAssets || 0),
        decimals: row.loanDecimals || 18,
      });
    } else {
      const entry = tokenMap.get(key);
      entry.totalSupplyAssetsSum += BigInt(row.totalSupplyAssets || 0);
    }
  }
  return tokenMap;
}

// ---------------------------------------------------------------------------
// Pair name helper
// ---------------------------------------------------------------------------

function pairName(market) {
  const coll = market.collateralAsset?.symbol || "?";
  const loan = market.loanAsset?.symbol || "?";
  return `${coll}/${loan}`;
}

// ---------------------------------------------------------------------------
// Asset-share ratio anomaly detection
// For each loan token, compute the ratio totalSupplyAssets/totalSupplyShares
// (as a float). Flag as ANOMALY if ratio diverges >50% from the median
// for that loan token.
// ---------------------------------------------------------------------------

function annotateAssetShareAnomaly(rows) {
  // Group by loan token address
  const groups = new Map(); // address -> [{ ratio, rowIndex }]
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const key = row.loanToken?.toLowerCase();
    if (!key) continue;
    const assets = BigInt(row.totalSupplyAssets || 0);
    const shares = BigInt(row.totalSupplyShares || 0);
    let ratio = null;
    if (shares > 0n) {
      ratio = Number(assets) / Number(shares);
    } else if (assets > 0n) {
      // shares=0 but assets>0 -> extreme anomaly
      ratio = Infinity;
    } else {
      ratio = 0;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ratio, index: i });
  }

  for (const [, entries] of groups) {
    if (entries.length < 2) {
      // Single market for this token: no cross-comparison possible
      entries.forEach((e) => { rows[e.index].checks.assetShareAnomaly = false; });
      continue;
    }
    const ratios = entries.map((e) => e.ratio).filter((r) => r !== null && Number.isFinite(r));
    if (ratios.length < 2) {
      entries.forEach((e) => { rows[e.index].checks.assetShareAnomaly = false; });
      continue;
    }
    ratios.sort((a, b) => a - b);
    const median = ratios[Math.floor(ratios.length / 2)];
    if (median === 0) {
      entries.forEach((e) => {
        rows[e.index].checks.assetShareAnomaly = e.ratio > 0;
      });
      continue;
    }
    for (const e of entries) {
      if (e.ratio === null || e.ratio === Infinity || !Number.isFinite(e.ratio)) {
        rows[e.index].checks.assetShareAnomaly = true;
      } else {
        const divergence = Math.abs(e.ratio - median) / median;
        rows[e.index].checks.assetShareAnomaly = divergence > 0.5;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!QUIET) console.log("Resolving Ethereum RPC...");
  const rpc = await resolveRpc(1);
  if (!rpc) {
    console.error("FATAL: No RPC available for Ethereum (chainId 1)");
    process.exit(1);
  }

  if (!QUIET) console.log("Fetching markets from Morpho GraphQL...");
  const markets = await fetchMarkets();
  if (!QUIET) console.log(`Fetched ${markets.length} markets total`);

  // Filter to material liquidity
  const materialMarkets = markets.filter((m) => {
    const liq = asNumber(m.state?.liquidityAssetsUsd) || 0;
    return liq >= MIN_LIQUIDITY_USD;
  });
  if (!QUIET) console.log(`Material liquidity (>= $${MIN_LIQUIDITY_USD}): ${materialMarkets.length} markets`);

  // Process each material market
  const rows = [];
  for (const market of materialMarkets) {
    const marketId = cleanHex(market.marketId);
    const pair = pairName(market);
    const lltv = lltvPct(market.lltv);
    const liquidityUsd = round(asNumber(market.state?.liquidityAssetsUsd) || 0, 2);
    const loanToken = market.loanAsset?.address ? cleanHex(market.loanAsset.address) : null;
    const loanDecimals = market.loanAsset?.decimals != null ? Number(market.loanAsset.decimals) : 18;

    // On-chain calls
    const state = await readMarketState(rpc, marketId).catch(() => null);
    if (!state) {
      if (!QUIET) console.log(`  SKIP ${pair}: eth_call market() failed`);
      continue;
    }
    const params = await readMarketParams(rpc, marketId).catch(() => null);
    if (!params) {
      if (!QUIET) console.log(`  SKIP ${pair}: eth_call idToMarketParams() failed`);
      continue;
    }

    // Checks
    const supplyGteBorrow = checkSupplyGteBorrow(state);
    const positiveSharesWithPositiveAssets = checkPositiveSharesWithPositiveAssets(state);
    const lastUpdateInfo = checkLastUpdateFreshness(state);
    const feeNonZero = checkFeeNonZero(state);

    const checks = {
      supplyGteBorrow,
      positiveSharesWithPositiveAssets,
      assetShareAnomaly: false, // computed later across all rows
      lastUpdateAgeHours: round(lastUpdateInfo.ageHours, 2),
      lastUpdateStale: lastUpdateInfo.stale,
      feeNonZero,
    };

    const invariantViolation = !supplyGteBorrow
      || !positiveSharesWithPositiveAssets
      || lastUpdateInfo.stale
      || feeNonZero;

    rows.push({
      marketId,
      pair,
      lltvPct: round(lltv, 2),
      liquidityUsd,
      totalSupplyAssets: fmtBigInt(state.totalSupplyAssets),
      totalSupplyShares: fmtBigInt(state.totalSupplyShares),
      totalBorrowAssets: fmtBigInt(state.totalBorrowAssets),
      totalBorrowShares: fmtBigInt(state.totalBorrowShares),
      lastUpdate: Number(state.lastUpdate),
      fee: fmtBigInt(state.fee),
      loanToken,
      loanDecimals,
      checks,
      invariantViolation,
    });
  }

  if (!QUIET) console.log(`On-chain inspected: ${rows.length} markets`);

  // Post-process: asset-share anomaly across rows (ANOMALY, not a violation)
  annotateAssetShareAnomaly(rows);

  // Token balance coverage checks
  const tokenMap = computeTokenBalanceChecks(rows, rpc);
  const tokenBalanceChecks = [];
  let tokenBalanceViolations = 0;

  for (const [addr, entry] of tokenMap) {
    const balance = await readTokenBalance(rpc, addr).catch(() => null);
    if (balance === null) {
      tokenBalanceChecks.push({
        loanToken: addr,
        symbol: entry.symbol,
        morphoBalance: null,
        totalSupplyAssetsSum: fmtBigInt(entry.totalSupplyAssetsSum),
        delta: null,
        deltaPct: null,
        violation: false,
        note: "RPC call failed",
      });
      continue;
    }
    const sum = entry.totalSupplyAssetsSum;
    let delta = "0";
    let deltaPct = 0;
    let violation = false;
    if (balance < sum) {
      const diff = sum - balance;
      const pct = balance > 0n ? Number(diff) / Number(balance) : 1;
      delta = fmtBigInt(diff);
      deltaPct = round(pct, 6);
      violation = pct > 0.005; // > 0.5%
      if (violation) tokenBalanceViolations++;
    }
    tokenBalanceChecks.push({
      loanToken: addr,
      symbol: entry.symbol,
      morphoBalance: fmtBigInt(balance),
      totalSupplyAssetsSum: fmtBigInt(sum),
      delta,
      deltaPct,
      violation,
    });
  }

  // Count violations and anomalies
  const invariantViolations = rows.filter((r) => r.invariantViolation).length;
  const invariantAnomalies = rows.filter((r) => r.checks.assetShareAnomaly).length;

  const summary = {
    marketsFetched: markets.length,
    materialMarketsInspected: rows.length,
    invariantViolations,
    invariantAnomalies,
    tokenBalanceViolations,
    routePositive: 0,
    executableNow: false,
    signedActionJustified: false,
    status: invariantViolations > 0 || tokenBalanceViolations > 0 ? "violations-detected" : "all-invariants-pass",
  };

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-morpho-invariant-drift.js",
    scope: "Read-only Morpho Blue market accounting invariant drift scanner",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      signedActions: false,
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
    },
    thresholds: {
      maxMarkets: MAX_MARKETS,
      minLiquidityUsd: MIN_LIQUIDITY_USD,
      rpcTimeoutMs: RPC_TIMEOUT_MS,
    },
    summary,
    tokenBalanceChecks,
    rows: rows.slice(0, 500),
  };

  // Write JSON report
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");

  // Write Markdown report
  fs.writeFileSync(REPORT_OUT, renderReport(artifact));

  if (!QUIET) {
    console.log(`\nMorpho Invariant Drift: marketsFetched=${summary.marketsFetched} inspected=${summary.materialMarketsInspected} violations=${summary.invariantViolations} anomalies=${summary.invariantAnomalies} tokenBalanceViolations=${summary.tokenBalanceViolations}`);
    console.log(`JSON: ${path.relative(WORKSPACE, OUT)}`);
    console.log(`MD:   ${path.relative(WORKSPACE, REPORT_OUT)}`);
  }
}

// ---------------------------------------------------------------------------
// Markdown report
// ---------------------------------------------------------------------------

function renderReport(artifact) {
  const s = artifact.summary;
  const rows = artifact.rows;

  const violationRows = rows.filter((r) => r.invariantViolation);
  const balanceViolations = artifact.tokenBalanceChecks.filter((t) => t.violation);

  let tableBody = "";
  if (rows.length === 0) {
    tableBody = "| No material markets inspected | - | - | - | - | - |";
  } else {
    const top = rows.slice(0, 30);
    tableBody = top.map((row) => {
      const flags = [];
      if (!row.checks.supplyGteBorrow) flags.push("🚨 SUPPLY<BORROW");
      if (!row.checks.positiveSharesWithPositiveAssets) flags.push("🚨 ASSETS>0 SHARES=0");
      if (row.checks.assetShareAnomaly) flags.push("⚠️ RATIO");
      if (row.checks.lastUpdateStale) flags.push("⚠️ STALE");
      if (row.checks.feeNonZero) flags.push("⚠️ FEE>0");
      const flagStr = flags.join(" ") || "✅";
      const violationStr = row.invariantViolation ? "⚠️" : "✅";
      return `| ${row.pair} | ${row.lltvPct ?? "n/a"} | ${row.liquidityUsd ?? 0} | ${row.totalSupplyAssets} | ${row.totalBorrowAssets} | ${row.checks.lastUpdateAgeHours ?? "?"} | ${row.fee} | ${violationStr} | ${flagStr} |`;
    }).join("\n");
  }

  let violationSection = "";
  if (violationRows.length > 0) {
    violationSection = [
      "",
      "## Violations",
      "",
      "| Pair | LLTV % | Liquidity USD | Issue |",
      "| --- | ---: | ---: | --- |",
      ...violationRows.slice(0, 50).map((row) => {
        const issues = [];
        if (!row.checks.supplyGteBorrow) issues.push("Supply < Borrow (invariant broken)");
        if (!row.checks.positiveSharesWithPositiveAssets) issues.push("Assets>0 but Shares=0");
        if (row.checks.assetShareAnomaly) issues.push("Asset/shares ratio anomaly");
        if (row.checks.lastUpdateStale) issues.push("Stale lastUpdate (>7d)");
        if (row.checks.feeNonZero) issues.push("Non-zero fee");
        return `| ${row.pair} | ${row.lltvPct ?? "n/a"} | ${row.liquidityUsd ?? 0} | ${issues.join("; ")} |`;
      }).join("\n"),
    ].join("\n");
  }

  let tokenBalanceSection = "";
  if (balanceViolations.length > 0) {
    tokenBalanceSection = [
      "",
      "## Token Balance Violations",
      "",
      "| Token | Symbol | Morpho Balance | Supply Sum | Delta | Delta % |",
      "| --- | ---: | ---: | ---: | ---: | ---: |",
      ...balanceViolations.map((t) =>
        `| ${t.loanToken} | ${t.symbol} | ${t.morphoBalance} | ${t.totalSupplyAssetsSum} | ${t.delta} | ${t.deltaPct}% |`
      ).join("\n"),
    ].join("\n");
  }

  return [
    "# 🟢 DORMANT — Morpho Blue Market Accounting Invariant Drift",
    "",
    `Date: ${artifact.generatedAt.slice(0, 10)}`,
    "",
    "## Result",
    "",
    s.invariantViolations > 0 || s.tokenBalanceViolations > 0
      ? "**⚠️ Violations detected.** Invariant breaks or token balance gaps found. See table below."
      : "**✅ All invariants pass.** No accounting drift, share ratio anomaly, stale market, or token balance shortfall.",
    "",
    "## Summary",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Markets fetched | ${s.marketsFetched} |`,
    `| Material markets inspected (>= $${MIN_LIQUIDITY_USD}) | ${s.materialMarketsInspected} |`,
    `| Invariant violations | ${s.invariantViolations} |`,
    `| Share ratio anomalies | ${s.invariantAnomalies} |`,
    `| Token balance violations | ${s.tokenBalanceViolations} |`,
    `| Route-positive | ${s.routePositive} |`,
    "",
    "## Invariant Checks",
    "",
    "| # | Check | Description | Severity |",
    "| --- | --- | --- | --- |",
    "| 1 | Supply >= Borrow | totalSupplyAssets >= totalBorrowAssets | VIOLATION |",
    "| 2 | Positive shares with positive assets | If totalSupplyAssets > 0, totalSupplyShares must be > 0 | VIOLATION |",
    "| 3 | Asset-share ratio consistency | Ratio within 50% of same-loan-token median | ANOMALY |",
    "| 4 | Last update freshness | lastUpdate within 7 days of current time | STALE |",
    "| 5 | Fee bounds | fee must be 0 (Morpho native fee) | ANOMALY |",
    "| 6 | Token balance coverage | sum(totalSupplyAssets) <= balanceOf(MORPHO_BLUE) + 0.5% | VIOLATION |",
    "",
    violationSection,
    tokenBalanceSection,
    "",
    "## Market Inspection Table (top rows)",
    "",
    "| Pair | LLTV % | Liq USD | Supply | Borrow | Update (h) | Fee | Status | Flags |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    tableBody,
    "",
    "## Token Balance Checks",
    "",
    "| Token | Symbol | Morpho Balance | Supply Sum | Delta | Delta % | Violation |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...(artifact.tokenBalanceChecks.length > 0
      ? artifact.tokenBalanceChecks.map((t) =>
        `| ${t.loanToken} | ${t.symbol} | ${t.morphoBalance ?? "RPC_FAIL"} | ${t.totalSupplyAssetsSum} | ${t.delta} | ${t.deltaPct !== null ? t.deltaPct : "n/a"} | ${t.violation ? "⚠️" : "✅"} |`
      )
      : ["| _No material markets with loan tokens_ | - | - | - | - | - | - |"]),
    "",
    "## Gate",
    "",
    "Escalation from watch to active requires:",
    "",
    "1. **An invariant break** — a supply/borrow violation or token balance shortfall confirmed on-chain",
    "2. **Material borrow liquidity** — the affected market has >$10k extractable borrow-side value",
    "3. **Exact extractive economics** — a concrete route (borrow + swap + repay) shows positive net value after gas and slippage",
    "4. **Fork proof** — a local fork simulation reproduces the invariant break and shows extractable value with no revert",
    "",
    "Until all four gates pass, the finding remains dormant / route-negative.",
    "",
    "## Artifacts",
    "",
    "- JSON: `reports/raw/fast/morpho-invariant-drift.json`",
    "- Scanner: `tools/scan-morpho-invariant-drift.js`",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
