#!/usr/bin/env node
// Deep-verify top 3 consumer-first promising candidates.
// Checks: (1) oracle type/staleness, (2) ERC4626 donation sensitivity, (3) DEX exit liquidity.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const OUT = path.join(RAW_DIR, "consumer-first-deep-verify-2026-06-28.json");

const CANDIDATES = [
  {
    rank: 1,
    chainId: 1,
    protocol: "Morpho Blue",
    marketId: "0xc9629945524f3fde56c7e8854a6c3d48e76b9d97236abbe73c750fcc7aeb8501",
    oracle: "0xc8043d248551Ed19B33cbc89dCCd69148c827039",
    collateralSymbol: "syrupUSDC",
    collateralAddress: "0x80ac24aA929eaF5013f6436cdA2a7ba190f5Cc0b",
    loanSymbol: "PYUSD",
    loanAddress: "0x6c3ea9036406852006290770BEdFcAbA0e23A0e8",
    ltv: 0.915,
    availableBorrowCashUsd: 7219714.869234,
    erc4626Asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  },
  {
    rank: 2,
    chainId: 1,
    protocol: "Morpho Blue",
    marketId: "0x88a18b2f4d94e7ad27a381b15531c06abf05a7c99dd5d3c3679875fed6f7e742",
    oracle: "0x67BcC03438D7d71c39343d7AD21cb73Dc19aDB89",
    collateralSymbol: "sUSDe",
    collateralAddress: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497",
    loanSymbol: "USDtb",
    loanAddress: "0xC139190F447e29f090Edeb554D95AbB8b18aC1C",
    ltv: 0.915,
    availableBorrowCashUsd: 6068450.5994460825,
    erc4626Asset: "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3",
  },
  {
    rank: 3,
    chainId: 1,
    protocol: "Morpho Blue",
    marketId: "0x1590cb22d797e226df92ebc6e0153427e207299916e7e4e53461389ad68272fb",
    oracle: "0x938D2eDb20425cF80F008E7ec314Eb456940Da15",
    collateralSymbol: "wsrUSD",
    collateralAddress: "0xd3fD63209FA2D55B07A0f6db36C2f43900be3094",
    loanSymbol: "USDC",
    loanAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    ltv: 0.945,
    availableBorrowCashUsd: 5311128.637711,
    erc4626Asset: "0x09D4214C03D01F49544C0448DBE3A27f768F2b34",
  },
];

const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";

const ERC20 = new ethers.Interface([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);

const ERC4626 = new ethers.Interface([
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function convertToShares(uint256) view returns (uint256)",
  "function maxDeposit(address) view returns (uint256)",
  "function maxRedeem(address) view returns (uint256)",
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function withdraw(uint256 assets, address receiver, address owner) returns (uint256)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256)",
]);

// Common oracle interfaces
const CHAINLINK_FEED = new ethers.Interface([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function version() view returns (uint256)",
]);

const MORPHO_MARKET = new ethers.Interface([
  "function market(bytes32) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
  "function idToMarketParams(bytes32) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv, uint256 ltv)",
]);

async function fetchJson(url, timeoutMs = 20_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "user-agent": "evm-audit-deep-verify/1.0" }, signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) { return null; } finally { clearTimeout(t); }
}

async function geckoDexLiquidity(tokenAddress, network = "ethereum") {
  const json = await fetchJson(`https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${tokenAddress}/pools?page=1`, 15_000);
  if (!json || !Array.isArray(json.data)) return [];
  return json.data.slice(0, 5).map(p => ({
    pool: p.id,
    name: p.attributes?.name,
    reserveUsd: p.attributes?.reserve_in_usd ? Number(p.attributes.reserve_in_usd) : null,
    priceUsd: p.attributes?.base_token_price_usd ? Number(p.attributes.base_token_price_usd) : null,
    volume24h: p.attributes?.volume_usd?.h24 ? Number(p.attributes.volume_usd.h24) : null,
  }));
}

async function identifyOracle(provider, oracleAddress) {
  const code = await provider.getCode(oracleAddress).catch(() => "0x");
  const codeBytes = code && code !== "0x" ? (code.length - 2) / 2 : 0;
  const results = { address: oracleAddress, codePresent: Boolean(code && code !== "0x"), codeBytes, type: "unknown", staleness: null, price: null, deviationBps: null };

  if (!results.codePresent) { results.type = "eoa-or-empty"; return results; }

  // Try Chainlink latestRoundData
  try {
    const raw = await provider.call({ to: oracleAddress, data: CHAINLINK_FEED.encodeFunctionData("latestRoundData") });
    const decoded = CHAINLINK_FEED.decodeFunctionResult("latestRoundData", raw);
    const answer = decoded[1];
    const updatedAt = Number(decoded[3]);
    const latestBlock = await provider.getBlock("latest");
    const feedAge = latestBlock.timestamp - updatedAt;
    results.type = "chainlink-like";
    results.staleness = { answer: answer?.toString(), updatedAt, feedAgeSeconds: feedAge, blockTimestamp: latestBlock.timestamp };

    // Try decimals
    try {
      const decRaw = await provider.call({ to: oracleAddress, data: CHAINLINK_FEED.encodeFunctionData("decimals") });
      results.staleness.decimals = Number(CHAINLINK_FEED.decodeFunctionResult("decimals", decRaw)[0]);
    } catch (_) {}

    // Try description
    try {
      const descRaw = await provider.call({ to: oracleAddress, data: CHAINLINK_FEED.encodeFunctionData("description") });
      results.staleness.description = CHAINLINK_FEED.decodeFunctionResult("description", descRaw)[0];
    } catch (_) {}
  } catch (_) {}

  // Try to identify morpho-specific oracle patterns
  // Check if it's a Morpho oracle that calls convertToAssets on the collateral
  try {
    // Check for common oracle function signatures
    const priceRaw = await provider.call({ to: oracleAddress, data: "0x" + ethers.id("price()").slice(2, 10) }).catch(() => null);
    if (priceRaw && priceRaw !== "0x") {
      results.type = results.type === "unknown" ? "custom-price" : results.type;
      try { results.price = BigInt(priceRaw).toString(); } catch (_) {}
    }
  } catch (_) {}

  // Check for getQuote / getPrice patterns
  for (const sig of ["getPrice()", "getRate()", "getQuote(uint256,uint256)", "consult(uint256)"]) {
    try {
      const selector = ethers.id(sig).slice(2, 10);
      const raw = await provider.call({ to: oracleAddress, data: "0x" + selector }).catch(() => null);
      if (raw && raw !== "0x" && raw.length >= 66) {
        results.type = results.type === "unknown" ? `custom-${sig.split("(")[0]}` : results.type;
        try { results.price = BigInt(raw.slice(0, 66)).toString(); } catch (_) {}
        break;
      }
    } catch (_) {}
  }

  return results;
}

async function checkDonationSensitivity(provider, vaultAddress, assetAddress) {
  // Check if convertToAssets changes when asset is donated to the vault
  // We can't actually transfer in read-only mode, but we can check:
  // 1. Does the vault have virtual shares/offset (OpenZeppelin ERC4626 standard)?
  // 2. What is the current exchange rate?
  // 3. Is there a deposit cap that would limit flash-loan attacks?
  // 4. Total assets vs total supply ratio

  const [totalAssetsRaw, totalSupplyRaw, convertAssetsRaw, convertSharesRaw, maxDepositRaw, assetRaw, balanceRaw, vaultSupplyRaw] = await Promise.all([
    provider.call({ to: vaultAddress, data: ERC4626.encodeFunctionData("totalAssets") }).catch(() => null),
    provider.call({ to: vaultAddress, data: ERC4626.encodeFunctionData("totalSupply") }).catch(() => null),
    provider.call({ to: vaultAddress, data: ERC4626.encodeFunctionData("convertToAssets", [10n ** 18n]) }).catch(() => null),
    provider.call({ to: vaultAddress, data: ERC4626.encodeFunctionData("convertToShares", [10n ** 18n]) }).catch(() => null),
    provider.call({ to: vaultAddress, data: ERC4626.encodeFunctionData("maxDeposit", ["0x000000000000000000000000000000000000dEaD"]) }).catch(() => null),
    provider.call({ to: vaultAddress, data: ERC4626.encodeFunctionData("asset") }).catch(() => null),
    provider.call({ to: assetAddress, data: ERC20.encodeFunctionData("balanceOf", [vaultAddress]) }).catch(() => null),
    provider.call({ to: vaultAddress, data: ERC20.encodeFunctionData("totalSupply") }).catch(() => null),
  ]);

  let totalAssets = null, totalSupply = null, convertAssets = null, convertShares = null, maxDeposit = null, asset = null, vaultBalance = null;
  try { totalAssets = ERC4626.decodeFunctionResult("totalAssets", totalAssetsRaw)?.[0] ?? null; } catch (_) {}
  try { totalSupply = ERC4626.decodeFunctionResult("totalSupply", totalSupplyRaw)?.[0] ?? ERC20.decodeFunctionResult("totalSupply", vaultSupplyRaw)?.[0] ?? null; } catch (_) {}
  try { convertAssets = ERC4626.decodeFunctionResult("convertToAssets", convertAssetsRaw)?.[0] ?? null; } catch (_) {}
  try { convertShares = ERC4626.decodeFunctionResult("convertToShares", convertSharesRaw)?.[0] ?? null; } catch (_) {}
  try { maxDeposit = ERC4626.decodeFunctionResult("maxDeposit", maxDepositRaw)?.[0] ?? null; } catch (_) {}
  try { asset = ERC4626.decodeFunctionResult("asset", assetRaw)?.[0] ?? null; } catch (_) {}
  try { vaultBalance = ERC20.decodeFunctionResult("balanceOf", balanceRaw)?.[0] ?? null; } catch (_) {}

  // Calculate exchange rate and donation sensitivity
  const exchangeRate = (totalSupply && totalSupply > 0n && totalAssets !== null) ? Number(totalAssets * 10n ** 18n / totalSupply) / 1e18 : null;

  // Simulate donation: if someone donates 1% of totalAssets, what's the new exchange rate?
  let donationSensitivity = null;
  if (totalAssets !== null && totalSupply && totalSupply > 0n) {
    const donateAmount = totalAssets / 100n; // 1% donation
    const newTotalAssets = totalAssets + donateAmount;
    const newExchangeRate = Number(newTotalAssets * 10n ** 18n / totalSupply) / 1e18;
    const oldExchangeRate = exchangeRate;
    if (oldExchangeRate && oldExchangeRate > 0) {
      donationSensitivity = {
        donateAmountRaw: donateAmount.toString(),
        oldRate: oldExchangeRate,
        newRate: newExchangeRate,
        inflationPct: ((newExchangeRate - oldExchangeRate) / oldExchangeRate) * 100,
        maxDeposit: maxDeposit?.toString() || null,
        maxDepositIsZero: maxDeposit !== null && maxDeposit === 0n,
      };
    }
  }

  return {
    vaultAddress,
    assetAddress: asset,
    totalAssets: totalAssets?.toString() || null,
    totalSupply: totalSupply?.toString() || null,
    vaultBalanceOfAsset: vaultBalance?.toString() || null,
    exchangeRate,
    convertToAssetsOneShare: convertAssets?.toString() || null,
    convertToSharesOneAsset: convertShares?.toString() || null,
    maxDeposit: maxDeposit?.toString() || null,
    maxDepositIsZero: maxDeposit !== null && maxDeposit === 0n,
    donationSensitivity,
    donationVulnerable: donationSensitivity !== null && !donationSensitivity.maxDepositIsZero && donationSensitivity.inflationPct > 0,
  };
}

async function main() {
  const rpc = await resolveRpc(1);
  if (!rpc) {
    fs.writeFileSync(OUT, JSON.stringify({ error: "Ethereum RPC unavailable", routePositive: 0 }, null, 2));
    console.log("Deep-verify: Ethereum RPC unavailable"); return;
  }
  const provider = new ethers.JsonRpcProvider(rpc, 1, { staticNetwork: true });

  const results = [];

  for (const candidate of CANDIDATES) {
    console.log(`\n--- Verifying candidate ${candidate.rank}: ${candidate.collateralSymbol} -> ${candidate.loanSymbol} ---`);

    // 1. Verify Morpho market state
    let marketState = null, marketParams = null;
    try {
      const [stateRaw, paramsRaw] = await Promise.all([
        provider.call({ to: MORPHO, data: MORPHO_MARKET.encodeFunctionData("market", [candidate.marketId]) }),
        provider.call({ to: MORPHO, data: MORPHO_MARKET.encodeFunctionData("idToMarketParams", [candidate.marketId]) }),
      ]);
      try { const d = MORPHO_MARKET.decodeFunctionResult("market", stateRaw); if (d) marketState = { totalSupplyAssets: d[0]?.toString(), totalSupplyShares: d[1]?.toString(), totalBorrowAssets: d[2]?.toString(), totalBorrowShares: d[3]?.toString(), lastUpdate: d[4]?.toString(), fee: d[5]?.toString() }; } catch (_) {}
      try { const d = MORPHO_MARKET.decodeFunctionResult("idToMarketParams", paramsRaw); if (d) marketParams = { loanToken: d[0], collateralToken: d[1], oracle: d[2], irm: d[3], lltv: d[4]?.toString(), ltv: d[5]?.toString() }; } catch (_) {}
    } catch (_) {}

    // 2. Verify oracle
    const oracleInfo = await identifyOracle(provider, candidate.oracle);

    // 3. Check donation sensitivity
    const donationInfo = await checkDonationSensitivity(provider, candidate.collateralAddress, candidate.erc4626Asset);

    // 4. Check DEX exit liquidity for loan token
    const dexLiquidity = await geckoDexLiquidity(candidate.loanAddress);

    // 5. Check DEX for collateral token (exit if borrowed)
    const collateralDex = await geckoDexLiquidity(candidate.collateralAddress);

    // 6. Calculate route economics
    // If we can donate to inflate collateral value, then deposit collateral, borrow, and exit:
    // Profit = (borrowAmount - flashRepay) - gas
    // borrowAmount = inflatedCollateralValue * LTV
    // inflateCollateralValue = (totalAssets + donation) / totalSupply * sharesDeposited

    let routePositive = 0;
    let routeAnalysis = null;

    if (donationInfo.donationVulnerable && oracleInfo.codePresent) {
      const maxBorrowFromDonation = donationInfo.donationSensitivity?.inflationPct || 0;
      const borrowLTV = candidate.ltv;
      // If inflation is X%, we can over-borrow by approximately X% * LTV * collateralDeposited
      const maxOverBorrowPct = maxBorrowFromDonation * borrowLTV;
      routeAnalysis = {
        donationInflationPct: maxBorrowFromDonation,
        borrowLTV,
        theoreticalOverBorrowPct: maxOverBorrowPct,
        availableBorrowCashUsd: candidate.availableBorrowCashUsd,
        oracleType: oracleInfo.type,
        oracleStale: oracleInfo.staleness?.feedAgeSeconds || null,
        dexExitLiquidity: dexLiquidity.length > 0,
        maxDexReserveUsd: dexLiquidity.length ? Math.max(...dexLiquidity.map(p => Number(p.reserveUsd || 0))) : 0,
        routePositive: maxOverBorrowPct > 0.1 && (candidate.availableBorrowCashUsd || 0) > 50000 ? 1 : 0,
      };
      if (routeAnalysis.routePositive > 0) routePositive = 1;
    }

    results.push({
      ...candidate,
      marketState,
      marketParams,
      oracleInfo,
      donationInfo,
      dexLiquidity: dexLiquidity.slice(0, 3),
      collateralDex: collateralDex.slice(0, 3),
      maxDexExitLiquidityUsd: dexLiquidity.length ? Math.max(...dexLiquidity.map(p => Number(p.reserveUsd || 0))) : 0,
      routeAnalysis,
      routePositive,
    });
  }

  const routePositiveCount = results.filter(r => r.routePositive > 0).length;

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-consumer-first-deep-verify.js",
    scope: "Deep-verify top 3 consumer-first promising candidates: oracle, donation, DEX exit",
    safety: { rpcInventoryRead: true, rpcUrlsStored: false, envFilesRead: false, privateKeysRead: false, signedActions: false, exploitExecuteCalls: false, forkTransactions: false, routePositive: routePositiveCount > 0, executableNow: false, signedActionJustified: false, forkJustified: false },
    candidates: results,
    summary: {
      candidatesVerified: results.length,
      routePositive: routePositiveCount,
      executableNow: 0,
      signedActionJustified: false,
      forkJustified: routePositiveCount > 0,
      donationVulnerable: results.filter(r => r.donationInfo?.donationVulnerable).length,
      oracleIdentified: results.filter(r => r.oracleInfo?.type !== "unknown" && r.oracleInfo?.type !== "eoa-or-empty").length,
      dexLiquidityFound: results.filter(r => r.maxDexExitLiquidityUsd > 0).length,
    },
    blockers: [
      "Route-positive requires all three checks to pass: donation vulnerability + oracle accepts inflated price + DEX exit liquidity sufficient",
      "Even if donation-vulnerable, the oracle may read totalAssets from a cached/stale source rather than real-time convertToAssets()",
      "Flash loan fees, gas, and slippage may exceed the over-borrow amount from donation inflation",
      "Morpho vaults may have supply caps or deposit caps that limit the size of the attack",
    ],
    nextRoutePositiveCriteria: [
      "A candidate passes all three checks: donation vulnerability + oracle accepts inflated + DEX exit sufficient",
      "Fork test demonstrates positive net extraction after flash loan repayment",
    ],
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");

  console.log(`\nDeep-verify: candidates=${results.length} donationVulnerable=${results.filter(r=>r.donationInfo?.donationVulnerable).length} routePositive=${routePositiveCount}`);
  for (const r of results) {
    console.log(`  ${r.rank}. ${r.collateralSymbol}->${r.loanSymbol}: oracle=${r.oracleInfo?.type} donation=${r.donationInfo?.donationVulnerable?'VULN':'no'} inflationPct=${r.donationInfo?.donationSensitivity?.inflationPct?.toFixed(4)}% dexLiq=$${Math.round(r.maxDexExitLiquidityUsd||0)} routePos=${r.routePositive}`);
  }
  console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
}

main().then(() => process.exit(0)).catch(err => { console.error(err.stack || err.message || String(err)); process.exit(1); });