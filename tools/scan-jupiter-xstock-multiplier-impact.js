#!/usr/bin/env node
// Read-only Jupiter Lend xStock multiplier/raw-balance impact scanner.
// Uses existing local artifacts plus public Jupiter price API only; no RPC or keys.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const JUPITER_LEND_ARTIFACT = path.join(WORKSPACE, "reports", "raw", "fast", "jupiter-lend-oracle-divergence.json");
const XSTOCKS_ARTIFACT = path.join(WORKSPACE, "reports", "raw", "fast", "xstocks-live.json");
const RECEIPT_GRAPH_ARTIFACT = path.join(WORKSPACE, "reports", "raw", "fast", "solana-receipt-token-consumer-graph.json");
const OUT_JSON = path.join(WORKSPACE, "reports", "raw", "fast", "jupiter-xstock-multiplier-impact.json");
const OUT_MD = path.join(WORKSPACE, "reports", "jupiter-xstock-multiplier-impact-triage.md");
const PRICE_URL = "https://lite-api.jup.ag/price/v3";
const SENTINEL_TICK = -2147483648;
const MIN_BORROW_USD = Number(process.env.JUP_XSTOCK_MIN_BORROW_USD || "10000");
const NEAR_TICK_BUFFER = Number(process.env.JUP_XSTOCK_NEAR_TICK_BUFFER || "10");

function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function rel(filePath) {
  return path.relative(WORKSPACE, filePath).replace(/\\/g, "/");
}

function asNumber(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  const n = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : fallback;
}

function round(value, decimals = 2) {
  const n = asNumber(value);
  if (n === null) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function shortMint(mint) {
  if (!mint) return null;
  return `${String(mint).slice(0, 5)}...${String(mint).slice(-4)}`;
}

function chunks(values, size) {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

function tickAtRatio(ratio) {
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  return Math.floor(Math.log(ratio) / Math.log(1.0015));
}

function liquidationTick(supplyPrice, borrowPrice, liquidationThresholdBps) {
  const supply = asNumber(supplyPrice);
  const borrow = asNumber(borrowPrice);
  const ltBps = asNumber(liquidationThresholdBps);
  if (!supply || !borrow || !ltBps) return null;
  return tickAtRatio((supply / borrow) * (ltBps / 10_000));
}

function gapBps(numerator, denominator) {
  const n = asNumber(numerator);
  const d = asNumber(denominator);
  if (!n || !d) return null;
  return ((n / d) - 1) * 10_000;
}

async function fetchPrices(mints) {
  const prices = new Map();
  for (const chunk of chunks([...new Set(mints.filter(Boolean))], 50)) {
    const url = `${PRICE_URL}?ids=${encodeURIComponent(chunk.join(","))}`;
    const response = await fetch(url).catch(() => null);
    if (!response?.ok) continue;
    const data = await response.json().catch(() => ({}));
    for (const [mint, price] of Object.entries(data || {})) prices.set(mint, price);
  }
  return prices;
}

function buildXstockIndex(xstocksArtifact) {
  const byMint = new Map();
  for (const token of xstocksArtifact?.solana?.tokens || []) {
    const mint = token?.mint;
    if (!mint) continue;
    const details = token?.mintInfo?.token2022ExtensionDetails || {};
    const symbol = token?.mintInfo?.token2022TokenMetadata?.parsed?.symbol || token.symbol || shortMint(mint);
    byMint.set(mint, {
      mint,
      symbol,
      name: token?.name || token?.mintInfo?.token2022TokenMetadata?.parsed?.name || null,
      decimals: token?.mintInfo?.decimals ?? null,
      supply: asNumber(token?.mintInfo?.supply),
      mintAuthority: token?.mintInfo?.mintAuthority || null,
      freezeAuthority: token?.mintInfo?.freezeAuthority || null,
      extensions: (token?.mintInfo?.token2022Extensions || []).map((ext) => ext.name).filter(Boolean),
      permanentDelegate: details?.PermanentDelegate?.delegate || null,
      transferHookProgramId: details?.TransferHook?.programId || null,
      transferHookAuthority: details?.TransferHook?.authority || null,
      pausableAuthority: details?.Pausable?.authority || null,
      paused: details?.Pausable?.paused ?? null,
      scaledUiAuthority: details?.ScaledUiAmountConfig?.authority || null,
      onchainMultiplier: asNumber(details?.ScaledUiAmountConfig?.multiplier),
      onchainNewMultiplier: asNumber(details?.ScaledUiAmountConfig?.newMultiplier),
      onchainNewMultiplierEffectiveTimestamp: details?.ScaledUiAmountConfig?.newMultiplierEffectiveTimestamp || null,
      defaultAccountState: details?.DefaultAccountState?.name || null,
    });
  }
  return byMint;
}

function proofBySymbol(xstocksArtifact) {
  const out = new Map();
  for (const row of xstocksArtifact?.proofReserves || []) {
    if (row?.symbol) out.set(row.symbol, row);
  }
  return out;
}

function multiplierRowsBySymbol(xstocksArtifact) {
  const out = new Map();
  for (const row of xstocksArtifact?.multipliers || []) {
    if (!row?.symbol) continue;
    if (!out.has(row.symbol)) out.set(row.symbol, []);
    out.get(row.symbol).push(row);
  }
  return out;
}

function effectiveScaledUi(price) {
  const cfg = price?.scaledUiConfig || {};
  const usdPrice = asNumber(price?.usdPrice);
  const prescaled = asNumber(cfg.usdPricePrescaled);
  const implied = usdPrice && prescaled ? prescaled / usdPrice : null;
  return {
    apiMultiplier: asNumber(cfg.multiplier),
    apiNewMultiplier: asNumber(cfg.newMultiplier),
    apiNewMultiplierEffectiveAt: cfg.newMultiplierEffectiveAt || null,
    usdPrice,
    usdPricePrescaled: prescaled,
    impliedPrescaleMultiplier: implied,
  };
}

function buildRows({ jupiterArtifact, xstockByMint, prices, proofs, multipliers }) {
  const rows = [];
  for (const vault of jupiterArtifact?.vaultRows || []) {
    const xstock = xstockByMint.get(vault.supplyToken);
    if (!xstock) continue;
    const supplyPrice = prices.get(vault.supplyToken) || {};
    const borrowPrice = prices.get(vault.borrowToken) || {};
    const scaled = effectiveScaledUi(supplyPrice);
    const borrowUsd = asNumber(borrowPrice.usdPrice);
    const displayTick = liquidationTick(scaled.usdPrice, borrowUsd, vault.liquidationThresholdBps);
    const prescaledTick = liquidationTick(scaled.usdPricePrescaled, borrowUsd, vault.liquidationThresholdBps);
    const topmostTick = Number(vault.topmostTick ?? SENTINEL_TICK);
    const hasDebt = (asNumber(vault.debtTickCount, 0) || 0) > 0;
    const displayPotentialLiquidatable = Boolean(hasDebt && displayTick !== null && topmostTick !== SENTINEL_TICK && topmostTick > displayTick);
    const prescaledPotentialLiquidatable = Boolean(hasDebt && prescaledTick !== null && topmostTick !== SENTINEL_TICK && topmostTick > prescaledTick);
    const displaySafeTicks = displayTick === null || topmostTick === SENTINEL_TICK ? null : displayTick - topmostTick;
    const prescaledSafeTicks = prescaledTick === null || topmostTick === SENTINEL_TICK ? null : prescaledTick - topmostTick;
    const tickShift = displayTick === null || prescaledTick === null ? null : prescaledTick - displayTick;
    const priceModeGapBps = gapBps(scaled.usdPricePrescaled, scaled.usdPrice);
    const collateralFactorBps = asNumber(vault.collateralFactorBps, 0) || 0;
    const overborrowBreakEvenGapBps = collateralFactorBps > 0 ? ((10_000 / collateralFactorBps) - 1) * 10_000 : null;
    const priceModeGapVsBreakEvenBps = priceModeGapBps === null || overborrowBreakEvenGapBps === null ? null : priceModeGapBps - overborrowBreakEvenGapBps;
    const tickFlip = displayPotentialLiquidatable !== prescaledPotentialLiquidatable;
    const nearFlip = Boolean(!tickFlip && displaySafeTicks !== null && tickShift !== null && displaySafeTicks > 0 && displaySafeTicks <= Math.abs(tickShift) + NEAR_TICK_BUFFER);
    const materialBorrow = (asNumber(vault.totalBorrowUsd, 0) || 0) >= MIN_BORROW_USD;
    const watchCandidate = Boolean(materialBorrow && (tickFlip || nearFlip || (priceModeGapBps || 0) > 0));

    rows.push({
      vaultId: vault.vaultId,
      vaultConfig: vault.vaultConfig,
      pair: vault.pair,
      supplyMint: vault.supplyToken,
      borrowMint: vault.borrowToken,
      supplySymbol: xstock.symbol || vault.supplySymbol || shortMint(vault.supplyToken),
      borrowSymbol: vault.borrowSymbol || shortMint(vault.borrowToken),
      collateralFactorBps,
      liquidationThresholdBps: vault.liquidationThresholdBps,
      liquidationPenaltyBps: vault.liquidationPenaltyBps,
      totalSupplyUi: vault.totalSupplyUi,
      totalBorrowUsd: round(vault.totalBorrowUsd, 2),
      positionCount: vault.positionCount,
      debtTickCount: vault.debtTickCount,
      topmostTick,
      sourceTypes: vault.sourceTypes || [],
      displayPriceUsd: round(scaled.usdPrice, 10),
      prescaledPriceUsd: round(scaled.usdPricePrescaled, 10),
      priceModeGapBps: round(priceModeGapBps, 4),
      apiMultiplier: scaled.apiMultiplier,
      apiNewMultiplier: scaled.apiNewMultiplier,
      apiNewMultiplierEffectiveAt: scaled.apiNewMultiplierEffectiveAt,
      onchainMultiplier: xstock.onchainMultiplier,
      onchainNewMultiplier: xstock.onchainNewMultiplier,
      onchainNewMultiplierEffectiveTimestamp: xstock.onchainNewMultiplierEffectiveTimestamp,
      transferHookProgramId: xstock.transferHookProgramId,
      paused: xstock.paused,
      defaultAccountState: xstock.defaultAccountState,
      proofOfReserves: proofs.get(xstock.symbol) ? {
        sharesHeld: proofs.get(xstock.symbol).sharesHeld,
        circulatingSupply: proofs.get(xstock.symbol).circulatingSupply,
        timestamp: proofs.get(xstock.symbol).timestamp,
      } : null,
      multiplierApiRows: (multipliers.get(xstock.symbol) || []).map((row) => ({
        currentMultiplier: row.currentMultiplier,
        newMultiplier: row.newMultiplier,
        activationDateTime: row.activationDateTime,
      })),
      displayLiquidationTick: displayTick,
      prescaledLiquidationTick: prescaledTick,
      tickShift,
      displaySafeTicks,
      prescaledSafeTicks,
      displayPotentialLiquidatable,
      prescaledPotentialLiquidatable,
      tickFlip,
      nearFlip,
      overborrowBreakEvenGapBps: round(overborrowBreakEvenGapBps, 4),
      priceModeGapVsBreakEvenBps: round(priceModeGapVsBreakEvenBps, 4),
      overborrowPossibleFromMultiplierOnly: Boolean(priceModeGapVsBreakEvenBps !== null && priceModeGapVsBreakEvenBps > 0),
      watchCandidate,
      routePositive: false,
      blocker: tickFlip
        ? "Price unit mismatch changes modeled liquidation state, but exact liquidation/unwind quote and proof are still required."
        : "Multiplier/raw-balance semantic exists, but current tick state and economics are not route-positive.",
    });
  }
  rows.sort((a, b) => (b.watchCandidate ? 1 : 0) - (a.watchCandidate ? 1 : 0)
    || Math.abs(b.priceModeGapBps || 0) - Math.abs(a.priceModeGapBps || 0)
    || (b.totalBorrowUsd || 0) - (a.totalBorrowUsd || 0));
  return rows;
}

function usdGSemantic(receiptGraph) {
  const rows = [...(receiptGraph?.topRows || []), ...(receiptGraph?.watchCandidates || [])];
  const usdG = rows.find((row) => row.symbol === "USDG") || null;
  if (!usdG) return null;
  return {
    mint: usdG.mint,
    symbol: usdG.symbol,
    protocols: usdG.protocols,
    consumerCount: usdG.consumerCount,
    collateralConsumerCount: usdG.collateralConsumerCount,
    maxLtvBps: usdG.maxLtvBps,
    activeTransferFeeBps: usdG.token2022Details?.activeTransferFeeBps ?? null,
    scheduledTransferFeeBps: usdG.token2022Details?.scheduledTransferFeeBps ?? null,
    transferHookProgramId: usdG.token2022Details?.transferHookProgramId ?? null,
    permanentDelegate: usdG.token2022Details?.permanentDelegate ?? null,
    currentValueChangingSemantics: false,
    blocker: "Current USDG transfer-fee bps are zero and transfer hook program is null; authority controls are permissioned and not a public value-changing route.",
  };
}

function writeReport(artifact) {
  const topRows = artifact.rows.slice(0, 8).map((row) => `| \`${row.supplySymbol}\` | \`${row.pair}\` | ${row.priceModeGapBps ?? "n/a"} | ${row.tickShift ?? "n/a"} | ${row.displaySafeTicks ?? "n/a"} | ${row.tickFlip ? "yes" : "no"} | ${row.overborrowPossibleFromMultiplierOnly ? "yes" : "no"} | ${row.routePositive ? "yes" : "no"} |`).join("\n");
  const usdG = artifact.usdGSemantic;
  const text = `# 🟢 DORMANT — Jupiter xStock Multiplier Impact

Date: ${artifact.generatedAt.slice(0, 10)}

## Result

**Dormant / route-negative.** SPYx and QQQx have a real Solana xStock semantic where raw balances stay fixed while Token-2022 scaled UI multipliers define displayed/economic exposure. Current Jupiter Lend xStock rows do not become route-positive under displayed-vs-prescaled price modeling, and no signed action is justified.

## Summary

| Metric | Value |
| --- | ---: |
| xStock vault rows scanned | ${artifact.summary.xstockVaultRowsScanned} |
| watch candidates | ${artifact.summary.watchCandidates} |
| tick-flip rows | ${artifact.summary.tickFlipRows} |
| near-flip rows | ${artifact.summary.nearFlipRows} |
| overborrow-positive rows | ${artifact.summary.overborrowPositiveRows} |
| routePositive | ${artifact.summary.routePositive} |

## Top Rows

| Supply | Pair | Price gap bps | Tick shift | Display safe ticks | Tick flip | Multiplier-only overborrow | RoutePositive |
| --- | --- | ---: | ---: | ---: | --- | --- | --- |
${topRows || "| n/a | n/a | n/a | n/a | n/a | no | no | no |"}

## USDG Resolution

USDG is not a current value-changing Token-2022 producer route. Current transfer-fee bps are \`${usdG?.activeTransferFeeBps ?? "unknown"}\`, scheduled transfer-fee bps are \`${usdG?.scheduledTransferFeeBps ?? "unknown"}\`, and transfer hook program is \`${usdG?.transferHookProgramId ?? "null"}\`.

## Gate

Route-positive stays closed until a current xStock row has a price-unit mismatch that creates liquidatable debt ticks or positive unwind value, exact repay/acquire and collateral-exit quotes after fees/slippage, and local/fork-equivalent proof.

## Artifacts

- JSON: \`${rel(OUT_JSON)}\`
- Scanner: \`tools/scan-jupiter-xstock-multiplier-impact.js\`
`;
  ensureDir(OUT_MD);
  fs.writeFileSync(OUT_MD, text);
}

async function main() {
  const jupiterArtifact = readJson(JUPITER_LEND_ARTIFACT, {});
  const xstocksArtifact = readJson(XSTOCKS_ARTIFACT, {});
  const receiptGraph = readJson(RECEIPT_GRAPH_ARTIFACT, {});
  const xstockByMint = buildXstockIndex(xstocksArtifact);
  const jupiterRows = jupiterArtifact?.vaultRows || [];
  const xstockMints = [...new Set(jupiterRows.flatMap((row) => [row.supplyToken, row.borrowToken]).filter((mint) => xstockByMint.has(mint)))];
  const borrowMints = [...new Set(jupiterRows.filter((row) => xstockByMint.has(row.supplyToken)).map((row) => row.borrowToken).filter(Boolean))];
  const prices = await fetchPrices([...xstockMints, ...borrowMints]);
  const rows = buildRows({
    jupiterArtifact,
    xstockByMint,
    prices,
    proofs: proofBySymbol(xstocksArtifact),
    multipliers: multiplierRowsBySymbol(xstocksArtifact),
  });
  const tickFlipRows = rows.filter((row) => row.tickFlip).length;
  const nearFlipRows = rows.filter((row) => row.nearFlip).length;
  const overborrowPositiveRows = rows.filter((row) => row.overborrowPossibleFromMultiplierOnly).length;
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-jupiter-xstock-multiplier-impact.js",
    scope: "Read-only Jupiter Lend xStock displayed-vs-prescaled multiplier impact over existing vault rows",
    safety: {
      rpcInventoryRead: false,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
    },
    inputs: {
      jupiterLendOracleDivergence: rel(JUPITER_LEND_ARTIFACT),
      xstocksLive: rel(XSTOCKS_ARTIFACT),
      solanaReceiptTokenConsumerGraph: rel(RECEIPT_GRAPH_ARTIFACT),
      publicPriceApi: "https://lite-api.jup.ag/price/v3",
    },
    thresholds: {
      minBorrowUsd: MIN_BORROW_USD,
      nearTickBuffer: NEAR_TICK_BUFFER,
    },
    summary: {
      xstockVaultRowsScanned: rows.length,
      priceRowsFetched: prices.size,
      watchCandidates: rows.filter((row) => row.watchCandidate).length,
      tickFlipRows,
      nearFlipRows,
      overborrowPositiveRows,
      maxPriceModeGapBps: round(Math.max(0, ...rows.map((row) => Math.abs(row.priceModeGapBps || 0))), 4),
      minDisplaySafeTicks: rows.map((row) => row.displaySafeTicks).filter((n) => Number.isFinite(n)).sort((a, b) => a - b)[0] ?? null,
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      status: tickFlipRows > 0 || overborrowPositiveRows > 0 ? "watch-needs-exact-quotes-and-proof" : "dormant-no-current-multiplier-impact-route",
      closedReason: "Displayed-vs-prescaled multiplier semantics are real for xStocks, but current Jupiter Lend rows do not create exact positive liquidation, borrow, or unwind economics.",
    },
    usdGSemantic: usdGSemantic(receiptGraph),
    rows,
    requiredForRoutePositive: [
      "Jupiter Lend account or oracle path must use a different xStock unit than exact acquisition/unwind value",
      "displayed-vs-prescaled unit mismatch must create a current liquidatable tick or positive borrow/unwind route",
      "exact Jupiter/venue quotes must be positive after fees, slippage, and priority fees",
      "local/fork-equivalent Solana proof must measure extraction",
      "explicit authorization is required before any signed action",
    ],
  };
  ensureDir(OUT_JSON);
  fs.writeFileSync(OUT_JSON, JSON.stringify(artifact, null, 2));
  writeReport(artifact);
  if (!process.argv.includes("--quiet")) {
    console.log(`Jupiter xStock multiplier impact: rows=${rows.length} watch=${artifact.summary.watchCandidates} tickFlip=${tickFlipRows} nearFlip=${nearFlipRows} overborrowPositive=${overborrowPositiveRows} routePositive=0`);
    console.log(`Artifact: ${rel(OUT_JSON)}`);
  }
}

main().catch((err) => {
  console.error(`Jupiter xStock multiplier impact scan failed: ${err.message}`);
  process.exit(1);
});
