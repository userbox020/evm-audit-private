#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MAP_FILE = path.join(ROOT, 'reports', 'raw', 'dolomite-berachain-live-map.json');
const OUT_FILE = path.join(ROOT, 'reports', 'raw', 'dolomite-berachain-oracle-candidate-analysis.json');
const WAD = 10n ** 18n;

function bn(value) {
  if (value === undefined || value === null) return 0n;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  if (typeof value === 'string') return BigInt(value);
  return 0n;
}

function asNumWad(value) {
  return Number(bn(value)) / 1e18;
}

function fmtToken(value, decimals) {
  const scale = 10n ** BigInt(decimals || 18);
  const whole = bn(value) / scale;
  const frac = (bn(value) % scale).toString().padStart(Number(decimals || 18), '0').slice(0, 6);
  return `${whole.toString()}.${frac}`;
}

function marketByToken(map, token) {
  return map.markets.find((m) => m.token.toLowerCase() === token.toLowerCase());
}

function borrowFactor(map, market) {
  const marginRatio = asNumWad(map.globalRisk.marginRatio[0]);
  const marginPremium = asNumWad(market.marginPremium && market.marginPremium[0]);
  return 1 / ((1 + marginRatio) * (1 + marginPremium));
}

function usd(value, decimals, priceUsd) {
  return Number(bn(value)) / (10 ** Number(decimals || 18)) * Number(priceUsd || 0);
}

function main() {
  const map = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'));
  const erc4626 = [];
  const twap = [];

  for (const market of map.markets) {
    const routes = map.oracleRoutes[String(market.marketId)] || [];
    for (const route of routes) {
      const details = route.details || {};
      if (details.erc4626) {
        const vaultSupply = bn(details.erc4626.totalSupply);
        const marketSupply = bn(market.totalWei && market.totalWei[1]);
        const maxSupply = bn(market.maxSupplyWei && market.maxSupplyWei[1]);
        const headroom = maxSupply > marketSupply ? maxSupply - marketSupply : 0n;
        const ownershipAfterMaxDeposit = vaultSupply + headroom > 0n
          ? Number(headroom) / Number(vaultSupply + headroom)
          : 0;
        const factor = borrowFactor(map, market);
        const donationProfitCoefficient = factor * ownershipAfterMaxDeposit - (1 - ownershipAfterMaxDeposit);
        const thresholdOwnershipForProfit = 1 / (1 + factor);
        const assetMarket = marketByToken(map, route.tokenPair);
        erc4626.push({
          marketId: market.marketId,
          symbol: market.tokenInfo.symbol,
          token: market.token,
          routePairToken: route.tokenPair,
          routePairSymbol: assetMarket && assetMarket.tokenInfo.symbol,
          closing: market.isClosing,
          priceUsdPerVaultShare: market.priceUsdPerToken,
          marginPremium: market.marginPremium && market.marginPremium[0],
          borrowFactorAgainstZeroPremiumDebt: factor,
          maxSupply: maxSupply.toString(),
          marketSupply: marketSupply.toString(),
          supplyHeadroom: headroom.toString(),
          supplyHeadroomHuman: fmtToken(headroom, market.tokenInfo.decimals),
          vaultTotalSupply: vaultSupply.toString(),
          vaultTotalAssets: details.erc4626.totalAssets,
          convertOneShare: details.erc4626.convertOneShare,
          ownershipAfterMintingHeadroom: ownershipAfterMaxDeposit,
          thresholdOwnershipForDonationProfit: thresholdOwnershipForProfit,
          donationProfitCoefficientAtHeadroom: donationProfitCoefficient,
          verdict: donationProfitCoefficient > 0
            ? 'potentially profitable if headroom can be fully minted/deposited and borrowed against'
            : 'not profitable from mint-headroom donation; donation loss exceeds extra borrow capacity',
        });
      }

      if (details.twap) {
        const pair = details.twap.pairDetails || {};
        const b0 = pair.balances && pair.balances.token0;
        const b1 = pair.balances && pair.balances.token1;
        const maxSupply = bn(market.maxSupplyWei && market.maxSupplyWei[1]);
        const marketSupply = bn(market.totalWei && market.totalWei[1]);
        const headroom = maxSupply > marketSupply ? maxSupply - marketSupply : 0n;
        const exposureUsd = usd(headroom, market.tokenInfo.decimals, market.priceUsdPerToken) * borrowFactor(map, market);
        twap.push({
          marketId: market.marketId,
          symbol: market.tokenInfo.symbol,
          oracleName: details.names && details.names[0],
          closing: market.isClosing,
          priceUsdPerToken: market.priceUsdPerToken,
          marginPremium: market.marginPremium && market.marginPremium[0],
          borrowFactorAgainstZeroPremiumDebt: borrowFactor(map, market),
          maxSupply: maxSupply.toString(),
          marketSupply: marketSupply.toString(),
          supplyHeadroom: headroom.toString(),
          supplyHeadroomHuman: fmtToken(headroom, market.tokenInfo.decimals),
          approximateBorrowCapacityOnHeadroomUsd: exposureUsd,
          routeWeight: route.weight,
          routePairToken: route.tokenPair,
          observationInterval: details.twap.observationInterval,
          floorPrice: details.twap.floorPrice,
          oracleRawPriceVsPair: details.price && details.price[0],
          pool: pair.pair,
          poolLiquidity: pair.liquidity,
          poolSlot0: pair.slot0,
          poolBalances: {
            token0: b0 && { symbol: b0.symbol, balance: b0.balance, decimals: b0.decimals, human: fmtToken(b0.balance, b0.decimals) },
            token1: b1 && { symbol: b1.symbol, balance: b1.balance, decimals: b1.decimals, human: fmtToken(b1.balance, b1.decimals) },
          },
          floorVerdict: typeof details.twap.floorPrice === 'string' && details.price && details.price[0]
            ? (bn(details.price[0]) <= bn(details.twap.floorPrice)
              ? 'oracle at/below floor; check spot/redeem discount'
              : 'oracle above floor; current price not pinned by floor')
            : 'no floor or unavailable',
        });
      }
    }
  }

  const out = {
    generatedAt: new Date().toISOString(),
    source: path.relative(ROOT, MAP_FILE),
    assumptions: [
      'Borrow factor assumes borrowing a zero-margin-premium debt asset and ignores slippage/gas.',
      'ERC4626 donation model assumes attacker mints only available Dolomite supply headroom, donates underlying, and can recover donation pro-rata by share ownership.',
      'TWAP pool balances are rough TVL indicators for concentrated liquidity and are not a full manipulation-cost proof.',
    ],
    erc4626,
    twap,
  };
  fs.writeFileSync(OUT_FILE, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`wrote ${path.relative(ROOT, OUT_FILE)} with ${erc4626.length} ERC4626 and ${twap.length} TWAP candidates`);
}

main();
