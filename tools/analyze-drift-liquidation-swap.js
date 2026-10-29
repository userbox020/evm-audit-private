#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MAP_FILE = path.join(ROOT, 'reports', 'raw', 'drift-live-map.json');
const OUT_FILE = path.join(ROOT, 'reports', 'raw', 'fast', 'drift-liquidation-swap-analysis.json');

const PRICE_PRECISION = 1_000_000n;
const LIQUIDATION_MULTIPLIER_PRECISION = 1_000_000n;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function activeFeeBps(market) {
  const fee = market.token2022TransferFee?.active?.transferFeeBasisPoints;
  return Number.isFinite(fee) ? fee : null;
}

function scheduledFeeBps(market) {
  const fee = market.token2022TransferFee?.newer?.transferFeeBasisPoints;
  return Number.isFinite(fee) ? fee : null;
}

function extensionNames(market) {
  return (market.token2022Extensions || []).map((ext) => ext.name);
}

function validateSwapWithinLiquidationBoundaries({
  assetTransfer,
  liabilityTransfer,
  assetDecimals = 6,
  liabilityDecimals = 6,
  assetPrice = PRICE_PRECISION,
  liabilityPrice = PRICE_PRECISION,
  assetLiquidationMultiplier = LIQUIDATION_MULTIPLIER_PRECISION,
  liabilityLiquidationMultiplier = LIQUIDATION_MULTIPLIER_PRECISION,
}) {
  assetTransfer = BigInt(assetTransfer);
  liabilityTransfer = BigInt(liabilityTransfer);
  if (assetTransfer === 0n || liabilityTransfer === 0n) return false;

  const assetPrecision = 10n ** BigInt(assetDecimals);
  const liabilityPrecision = 10n ** BigInt(liabilityDecimals);
  const swapPrice = liabilityTransfer
    * PRICE_PRECISION
    / liabilityPrecision
    * assetPrecision
    / assetTransfer;
  const worstCasePrice = BigInt(assetPrice)
    * PRICE_PRECISION
    * BigInt(liabilityLiquidationMultiplier)
    / BigInt(liabilityPrice)
    / BigInt(assetLiquidationMultiplier);
  return swapPrice >= worstCasePrice;
}

function modelCase(name, swapAmount, residualReturned, liabilityDelivered) {
  const amountIn = BigInt(swapAmount) - BigInt(residualReturned);
  const amountOut = BigInt(liabilityDelivered);
  return {
    name,
    swapAmount: String(swapAmount),
    residualReturned: String(residualReturned),
    effectiveAssetTransfer: String(amountIn),
    liabilityTransfer: String(amountOut),
    boundaryPasses: validateSwapWithinLiquidationBoundaries({
      assetTransfer: amountIn,
      liabilityTransfer: amountOut,
    }),
    economicInterpretation:
      amountIn <= 0n
        ? 'invalid: zero effective asset transfer fails boundary math'
        : amountOut <= 0n
          ? 'invalid: end handler requires a nonzero liability delta'
          : 'not free: credited liability equals real liability tokens delivered; seized asset equals effective asset transfer',
  };
}

function oracleReuseSummary(liveMap) {
  const groups = new Map();
  for (const market of liveMap.spotMarkets || []) {
    if (!market.oracle) continue;
    const key = `${market.oracle}|${market.oracleSource || ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ type: 'spot', symbol: market.symbol, marketIndex: market.marketIndex });
  }
  for (const market of liveMap.perpMarkets || []) {
    if (!market.oracle) continue;
    const key = `${market.oracle}|${market.oracleSource || ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ type: 'perp', symbol: market.symbol, marketIndex: market.marketIndex });
  }

  const duplicates = [...groups.entries()]
    .filter(([, markets]) => markets.length > 1)
    .map(([id, markets]) => ({ id, markets }));
  const sharedSpotPerpGroups = duplicates.filter(
    (group) => group.markets.some((market) => market.type === 'spot')
      && group.markets.some((market) => market.type === 'perp')
  );

  return {
    totalOracleIds: groups.size,
    duplicateOracleIds: duplicates.length,
    sharedSpotPerpOracleIds: sharedSpotPerpGroups.length,
    examples: sharedSpotPerpGroups.slice(0, 12),
    residualVerdict: sharedSpotPerpGroups.length > 0
      ? 'REVIEW_MARKET_SPECIFIC_ORACLE_VALIDITY_CACHE'
      : 'NO_SHARED_SPOT_PERP_ORACLE_CACHE_TRIGGER',
  };
}

function main() {
  const liveMap = readJson(MAP_FILE);
  const token2022 = (liveMap.spotMarkets || [])
    .filter((market) => market.tokenProgramKind === 'token-2022')
    .map((market) => ({
      symbol: market.symbol,
      marketIndex: market.marketIndex,
      mint: market.mint,
      oracleSource: market.oracleSource,
      extensions: extensionNames(market),
      activeTransferFeeBps: activeFeeBps(market),
      scheduledTransferFeeBps: scheduledFeeBps(market),
      transferHookProgramId: market.token2022TransferHook?.programId || null,
      transferHookAuthority: market.token2022TransferHook?.authority || null,
    }));

  const nonZeroFeeMarkets = token2022.filter(
    (market) => (market.activeTransferFeeBps || 0) > 0 || (market.scheduledTransferFeeBps || 0) > 0
  );
  const nonNullHookMarkets = token2022.filter((market) => market.transferHookProgramId);

  const model = [
    modelCase('honest-par-asset-to-liability', 100_000_000n, 0n, 100_000_000n),
    modelCase('residual-return-without-liability', 100_000_000n, 90_000_000n, 0n),
    modelCase('residual-return-with-real-liability', 100_000_000n, 90_000_000n, 10_000_000n),
    modelCase('inflated-liability-delta-requires-real-tokens', 100_000_000n, 90_000_000n, 100_000_000n),
    modelCase('full-residual-zero-effective-asset', 100_000_000n, 100_000_000n, 100_000_000n),
  ];

  const analysis = {
    generatedAt: new Date().toISOString(),
    sourceArtifact: path.relative(ROOT, MAP_FILE),
    live: {
      slot: liveMap.rpcSlot,
      programId: liveMap.program?.programId,
      programDataSlot: liveMap.program?.programDataSlot,
      upgradeAuthority: liveMap.program?.upgradeAuthority || null,
      perpMarkets: liveMap.liveCounts?.perpAccountsFound,
      spotMarkets: liveMap.liveCounts?.spotAccountsFound,
      token2022SpotMints: liveMap.liveCounts?.token2022SpotMints,
    },
    token2022,
    oracleReuse: oracleReuseSummary(liveMap),
    token2022Triggers: {
      nonZeroFeeMarkets,
      nonNullHookMarkets,
      currentTrigger: nonZeroFeeMarkets.length > 0 || nonNullHookMarkets.length > 0,
    },
    liquidationSwapBalanceDeltaModel: model,
    sourceInvariants: [
      {
        invariant: 'Nonzero Token-2022 transfer fees are rejected before protocol token transfers.',
        source: 'programs/drift/src/controller/token.rs:214-223',
      },
      {
        invariant: 'Liquidation-with-swap begin records initial token-account balances and sends only the requested asset amount.',
        source: 'programs/drift/src/instructions/keeper.rs:1657-1686',
      },
      {
        invariant: 'End returns any residual asset tokens to the vault and reduces effective asset_transfer by exactly that residual.',
        source: 'programs/drift/src/instructions/keeper.rs:1881-1904',
      },
      {
        invariant: 'End credits only the observed liability token-account delta, which must be real tokens received into the vault.',
        source: 'programs/drift/src/instructions/keeper.rs:1912-1949',
      },
      {
        invariant: 'The user asset debit equals effective asset_transfer and the liability credit equals observed liability_transfer.',
        source: 'programs/drift/src/controller/liquidation.rs:2267-2289',
      },
      {
        invariant: 'Swap price must be at least oracle worst-case liquidation price.',
        source: 'programs/drift/src/math/liquidation.rs:555-589',
      },
      {
        invariant: 'Oracle validity is cached by oracle pubkey/source, while calculation inputs include market type/index, market TWAP, confidence multiplier, and stale-delay overrides.',
        source: 'programs/drift/src/state/oracle_map.rs:84-126',
      },
    ],
    harnessBlockers: [
      {
        command: 'npx -p mocha@8 -p ts-node@10 -p typescript mocha -r ts-node/register tests/liquidateSpotWithSwap.ts',
        blocker: '@triton-one/yellowstone-grpc native binding fails on this Windows/Node 24 environment before bankrun starts.',
      },
      {
        command: 'cargo test -p drift validate_swap_within_liquidation_boundaries --features no-entrypoint --locked',
        blocker: 'pyth-crosschain nested git submodule checkout fails with Windows path-too-long under Cargo.',
      },
    ],
    verdict: nonZeroFeeMarkets.length === 0 && nonNullHookMarkets.length === 0
      ? 'NO_CURRENT_TOKEN2022_LIQUIDATION_SWAP_TRIGGER'
      : 'REVIEW_TOKEN2022_TRIGGER',
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, `${JSON.stringify(analysis, null, 2)}\n`);
  console.log(`Wrote ${path.relative(ROOT, OUT_FILE)}`);
  console.log(`token2022=${token2022.length} nonZeroFees=${nonZeroFeeMarkets.length} nonNullHooks=${nonNullHookMarkets.length} verdict=${analysis.verdict}`);
}

main();
