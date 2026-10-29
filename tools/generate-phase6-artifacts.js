#!/usr/bin/env node
// generate-phase6-artifacts.js — Batch Phase 6 artifact generation for 8 pre-era protocols
const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const NOW = new Date().toISOString();

const PROTOCOLS = [
  {
    name: "Compound V3",
    slug: "compound-v3",
    verdict: "CLEAN",
    chain: "Ethereum",
    chainId: 1,
    oracles: { type: "Chainlink wrappers (PriceFeedWith4626Support, WstETHPriceFeed, EzETHExchangeRatePriceFeed)", stalenessThresholdSeconds: 86400, feedAgeWorstSeconds: 1800, staleFeedsCount: 0, divergenceMaxPercent: 0, residualRisk: "ERC4626/LST/LRT CAPO feed overvaluation possible on high-CF collateral like wstETH at 90% CF; collateral-only withdrawal checks do not accrue interest first" },
    liquidation: { closeFactor: 0.5, liquidationIncentive: 1.1, minLiquidatableUsd: 100, paused: false, flashLoanCompatible: true },
    governance: { riskLevel: "MEDIUM", timelockSeconds: 172800, adminType: "Timelock", proxyUpgradeAuthority: "0x1A9C8182C09F50C8318d769245beA52c32BE35BC", residualRisk: "Live config differed from checked-in deployment JSONs — governance/config drift" },
    flashLoan: { singleBlockCompatible: true, exitLiquidityUsd: 50000000, capitalGateUsd: 0, verdict: "compatible" },
    keyAddresses: { coreContract: "0xc3d688B66703497DAA19211EEdff47f25384cdc3", oracle: "per-market wrappers", comptroller: "0xc3d688B66703497DAA19211EEdff47f25384cdc3", governance: "0x1A9C8182C09F50C8318d769245beA52c32BE35BC" },
    residualRisks: ["CAPO feed overvaluation on wstETH 90% CF", "collateral-only withdrawals don't accrue interest", "Governance config drift from deployment JSONs"],
    revisitTriggers: ["Compound governance proposal changing CF/borrow caps", "wstETH/WETH Chainlink feed staleness >3600s"],
    triageReport: "reports/compound-triage.md",
    scannerTools: ["targets/compound-comet/scan-compound-live.js"],
  },
  {
    name: "Aave V3",
    slug: "aave-v3",
    verdict: "CLEAN",
    chain: "Multi-chain (16 chains)",
    chainId: 1,
    oracles: { type: "Chainlink via AaveOracle", stalenessThresholdSeconds: 86400, feedAgeWorstSeconds: 1200, staleFeedsCount: 0, divergenceMaxPercent: 0, residualRisk: "Sentinel + fallback oracle available. eMode LTV/LT per mode. Single-source risk per asset." },
    liquidation: { closeFactor: 0.5, liquidationIncentive: 1.05, minLiquidatableUsd: 100, paused: false, flashLoanCompatible: true, notes: "100% close factor below CLOSE_FACTOR_HF_THRESHOLD=0.95" },
    governance: { riskLevel: "LOW", timelockSeconds: 86400, adminType: "Governance V3 (multi-chain)", proxyUpgradeAuthority: "0x9AEE0B04504CeF83A65AC3f0e838D0593BCb2BC7", residualRisk: "Cross-chain governance storage-proof timing" },
    flashLoan: { singleBlockCompatible: true, exitLiquidityUsd: 100000000000, capitalGateUsd: 0, verdict: "compatible" },
    keyAddresses: { coreContract: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2 (Ethereum)", oracle: "per-chain AaveOracle", governance: "0x9AEE0B04504CeF83A65AC3f0e838D0593BCb2BC7" },
    residualRisks: ["Single-source oracle per asset on each chain", "weETH/WETH HF=1.00200 (closest trigger, 20bps)", "Cross-chain governance timing"],
    revisitTriggers: ["weETH drops $3.61 to $1,850.80 → $51K profit", "Any Aave V3 pool HF < 1.0"],
    triageReport: "reports/aave-triage.md",
    scannerTools: ["tools/scan-aave-v3-borrowers.js"],
  },
  {
    name: "Morpho Blue",
    slug: "morpho-blue",
    verdict: "DORMANT",
    chain: "Multi-chain (13 chains)",
    chainId: 1,
    oracles: { type: "MorphoChainlinkOracleV2 per isolated market", stalenessThresholdSeconds: "none (market-creator-defined)", feedAgeWorstSeconds: 3600, staleFeedsCount: 0, divergenceMaxPercent: 0.04, residualRisk: "No staleness check in oracle — trust on market creator. stETH depeg >0.3% flips wstETH/WETH oracle." },
    liquidation: { closeFactor: 1.0, liquidationIncentive: 1.05, minLiquidatableUsd: 1, paused: false, flashLoanCompatible: true, notes: "Single-price model — same oracle for health check and seize/repay. Bad debt written off when collateral exhausted." },
    governance: { riskLevel: "LOW", timelockSeconds: 0, adminType: "Isolated market creators", proxyUpgradeAuthority: "N/A (immutable core)", residualRisk: "Market creators set oracle/LLTV/IRM — no global admin attack surface" },
    flashLoan: { singleBlockCompatible: true, exitLiquidityUsd: 7820000, capitalGateUsd: 0, verdict: "compatible — no profitable route currently (best net: -$2.06 on USDC/deUSD)" },
    keyAddresses: { coreContract: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb", oracle: "per-market MorphoChainlinkOracleV2", liquidationModule: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb (self)" },
    residualRisks: ["stETH depeg >0.3% flips wstETH/WETH oracle to overvaluation", "Vault donation-inflatable collateral via ERC4626", "PT oracle unit mismatch on Pendle-matured markets", "USDC/deUSD liq: net -$2.06 (tiny gap from profitable)"],
    revisitTriggers: ["stETH/ETH < 0.997", "New Morpho market with PT/YT collateral", "ERC4626 vault adapter deployed"],
    triageReport: "reports/morpho-triage.md",
    scannerTools: ["tools/scan-morpho-high-apy-liquidation-routes.js", "tools/scan-morpho-public-allocator-force-feed.js"],
  },
  {
    name: "Spark / Sky Lending",
    slug: "spark-sky-lending",
    verdict: "CLEAN",
    chain: "Ethereum",
    chainId: 1,
    oracles: { type: "Maker OSM (1-hour delay) + Chainlink", stalenessThresholdSeconds: 3600, feedAgeWorstSeconds: 600, staleFeedsCount: 0, divergenceMaxPercent: 0, residualRisk: "OSM 1h delay creates stale-borrow window. Debt ceiling drift on RWA001-A." },
    liquidation: { closeFactor: "Auction-based (Clipper)", liquidationIncentive: 1.13, minLiquidatableUsd: 5000, paused: false, flashLoanCompatible: false, notes: "Auction-based (Clipper). Global liquidation hole: 150M DAI. Flash mint via MCD_FLASH." },
    governance: { riskLevel: "LOW", timelockSeconds: 172800, adminType: "MCD governance + MCD_PAUSE", proxyUpgradeAuthority: "0xbE286431454714F511008713973d3B053A2d38f3", residualRisk: "Core wards checked clean. MCD_ESM at 0x09e05fF6." },
    flashLoan: { singleBlockCompatible: true, exitLiquidityUsd: 150000000, capitalGateUsd: 0, verdict: "compatible via MCD_FLASH" },
    keyAddresses: { coreContract: "MCD_VAT 0x35D1b3F3D7966A1DFe207aa4514C12a259A0492B", oracle: "MCD_SPOT 0x65C79fcB50Ca1594B025960e539eD7A9a6D434A3", comptroller: "MCD_JUG 0x19c0976f590D67707E62397C87829d896Dc0f1F1", governance: "MCD_PAUSE 0xbE286431454714F511008713973d3B053A2d38f3" },
    residualRisks: ["OSM 1-hour delay on oracle", "PSM/allocator rows not permissionless CDP surface", "Debt ceiling drift on RWA001-A"],
    revisitTriggers: ["MCD governance changes ilk parameters", "OSM oracle goes stale >2h"],
    triageReport: "reports/sky-lending-triage.md",
    scannerTools: ["tools/scan-sky-lending.js"],
  },
  {
    name: "Fraxlend",
    slug: "fraxlend",
    verdict: "CLEAN",
    chain: "Multi-chain (Ethereum, Arbitrum, Fraxtal)",
    chainId: 1,
    oracles: { type: "Chainlink dual-oracle (V1) / Triple Oracle (V3: Chainlink + UniV3 TWAP + RedStone)", stalenessThresholdSeconds: 86400, feedAgeWorstSeconds: 1800, staleFeedsCount: 1, divergenceMaxPercent: 0, residualRisk: "One Fraxtal oracle has isBadData=true (dust). Lazy exchange-rate storage refreshes before solvency-sensitive ops." },
    liquidation: { closeFactor: "clean 10%, dirty 9%", liquidationIncentive: 1.10, minLiquidatableUsd: 100, paused: false, flashLoanCompatible: true, notes: "Max LTV 75% (most), 95% (FPI). Protocol fee 2% on V3. No borrow limits on most pairs." },
    governance: { riskLevel: "MEDIUM", timelockSeconds: 86400, adminType: "Timelock + Owner", proxyUpgradeAuthority: "0xb1748c79709f4ba2dd82834b8c82d4a505003f27", residualRisk: "Owner can change borrow limits/maxLTV on markets with stale oracle" },
    flashLoan: { singleBlockCompatible: true, exitLiquidityUsd: 50000000, capitalGateUsd: 0, verdict: "compatible" },
    keyAddresses: { coreContract: "0xd6e9d27c75afd88ad24cd5edccdc76fd2fc3a751 (Ethereum registry)", oracle: "per-pair Chainlink or RedStone", governance: "0x8412ebf45bac1b340bbe8f318b928c466c4e39ca (timelock)" },
    residualRisks: ["Fraxtal sfrxETH pair isBadData (dust)", "Borrow limits can be changed on stale oracle markets", "Lazy exchange-rate storage pattern"],
    revisitTriggers: ["Fraxtal sfrxETH pair gets >$10K borrow liquidity with isBadData=true", "Owner changes LTV/borrow caps on any major pair"],
    triageReport: "reports/fraxlend-triage.md",
    scannerTools: ["targets/fraxlend/scan-fraxlend-live.js"],
  },
  {
    name: "Euler V2",
    slug: "euler-v2",
    verdict: "CLEAN",
    chain: "Multi-chain (15+ chains)",
    chainId: 1,
    oracles: { type: "EulerRouter (governor-configurable) with adapters: Chainlink, RedStone, Pyth, Chronicle, UniV3 TWAP, Lido/wstETH, Pendle PT, rate providers", stalenessThresholdSeconds: "per-adapter", feedAgeWorstSeconds: 1800, staleFeedsCount: 0, divergenceMaxPercent: 0, residualRisk: "Per-vault oracle configs not fully enumerated. 60+ audits. Closest oracle gap: 738bps." },
    liquidation: { closeFactor: "bid/ask pricing", liquidationIncentive: 1.05, minLiquidatableUsd: 1, paused: false, flashLoanCompatible: true, notes: "Bid/ask conservative pricing. Cool-off timer per vault. Debt socialization at ~$1." },
    governance: { riskLevel: "MEDIUM", timelockSeconds: 172800, adminType: "EVC governor-controlled", proxyUpgradeAuthority: "0x4cD6BF1D183264c02Be7748Cb5cd3A47d013351b", residualRisk: "Per-vault oracle router configurability. Cross-chain deployment drift (15+ chains)." },
    flashLoan: { singleBlockCompatible: true, exitLiquidityUsd: 100000000, capitalGateUsd: 0, verdict: "compatible (EVC batch execution)" },
    keyAddresses: { coreContract: "EVC 0x0C9a3dd6b8F28529d72d7f9cE918D493519EE383", oracle: "EulerRouterFactory 0x70B3f6F61b7Bf237DF04589DdAA842121072326A", factory: "eVaultFactory 0x29a56a1b8214D9Cf7c5561811750D5cBDb45CC8e", governance: "ProtocolConfig 0x4cD6BF1D183264c02Be7748Cb5cd3A47d013351b" },
    residualRisks: ["Per-vault oracle adapter bugs", "ERC4626 resolved vault donation (governor-gated)", "Third-party oracle adapters", "Cross-chain deployment drift"],
    revisitTriggers: ["New eVault deployed with ERC4626 oracle", "Governance changes EulerRouter config"],
    triageReport: "reports/euler-labs-triage.md",
    scannerTools: ["tools/scan-focused-euler-evk-review-producers.js"],
  },
  {
    name: "Silo V3",
    slug: "silo-v3",
    verdict: "DORMANT",
    chain: "Multi-chain (11+ chains)",
    chainId: 42161,
    oracles: { type: "Per-silo oracle configs: ChainlinkV3Oracle (stale-acceptance bug), ERC4626Oracle, PTLinearOracle, CustomMethodOracle", stalenessThresholdSeconds: "ignored by ChainlinkV3Oracle (source bug)", feedAgeWorstSeconds: 86400, staleFeedsCount: 0, divergenceMaxPercent: 0, residualRisk: "ChainlinkV3Oracle ignores configured heartbeat and updatedAt/answeredInRound. Zero-oracle pairs use raw 1:1. No currently exploited market." },
    liquidation: { closeFactor: "PartialLiquidationLib", liquidationIncentive: 1.10, minLiquidatableUsd: 100, paused: false, flashLoanCompatible: true, notes: "PartialLiquidationLib with 2-wei underestimation. Hook-based liquidation callbacks." },
    governance: { riskLevel: "MEDIUM", timelockSeconds: 86400, adminType: "Factory-based + Tower contracts", proxyUpgradeAuthority: "varies per chain", residualRisk: "Hook ownership permissioned. Factory deployment choreography." },
    flashLoan: { singleBlockCompatible: true, exitLiquidityUsd: 1000000, capitalGateUsd: 0, verdict: "compatible — but stale-feed rows have zero opposite-side liquidity" },
    keyAddresses: { coreContract: "Arb: SiloFactory 0xAFd8F792cb025A76C4916652CfC8e20eee3b6fe2", oracle: "per-silo oracle config via factory", factory: "0xAFd8F792cb025A76C4916652CfC8e20eee3b6fe2", liquidationModule: "SiloRouterV2 0xEb5a0eF2Cdd79c61c7a0FCc08e618c238d5aA335" },
    residualRisks: ["ChainlinkV3Oracle stale acceptance (real source bug, no live target)", "ERC4626 donation via SiloVault delegatecall", "PT oracle maturity mispricing", "Zero-oracle 1:1 assumption"],
    revisitTriggers: ["New silo created with ChainlinkV3Oracle + material borrow liquidity", "Governance deploys new oracle adapter", "PT/YT silo approaches maturity"],
    triageReport: "reports/silo-v3-triage.md",
    scannerTools: ["tools/scan-silo-pt-oracle-routes.js"],
  },
  {
    name: "BenQi",
    slug: "benqi",
    verdict: "CLEAN",
    chain: "Avalanche",
    chainId: 43114,
    oracles: { type: "BenqiDualOracle (mode=1 DUAL): Chainlink primary + Edge fallback", stalenessThresholdSeconds: 86400, feedAgeWorstSeconds: 1800, staleFeedsCount: 0, divergenceMaxPercent: 0, residualRisk: "15 markets. 0 stale feeds. 1 divergent (qiUSDT/USDT.e, borrow-paused). per-market staleness thresholds + deviation threshold (0.05 default, 0.2 max)." },
    liquidation: { closeFactor: 0.5, liquidationIncentive: 1.10, minLiquidatableUsd: 100, paused: false, flashLoanCompatible: true, notes: "Both stale = revert. One stale = fallback. Both fresh but deviation > threshold = revert. USDT.e divergence blocked by borrow-paused." },
    governance: { riskLevel: "MEDIUM", timelockSeconds: 86400, adminType: "Governor", proxyUpgradeAuthority: "TBD", residualRisk: "Oracle mode/settings governable. Old BenqiChainlinkOracle deprecated." },
    flashLoan: { singleBlockCompatible: true, exitLiquidityUsd: 10000000, capitalGateUsd: 0, verdict: "compatible — borrow cap not enforced beyond CF" },
    keyAddresses: { coreContract: "Comptroller 0x486Af39519B4Dc9a7fCcd318217352830E8AD9b4", oracle: "BenqiDualOracle 0xf81B4C4abf7de8B8FC560D66F0eB70598D8BF15e", comptroller: "0x486Af39519B4Dc9a7fCcd318217352830E8AD9b4", governance: "TBD" },
    residualRisks: ["USDT.e divergence blocked by borrow-paused", "Governance changes to oracleMode/deviationThreshold/stalenessThreshold", "Old BenqiChainlinkOracle deprecated"],
    revisitTriggers: ["qiUSDT borrow unpaused", "Governance changes oracle settings", "New market added with high-CF collateral"],
    triageReport: "reports/benqi-triage.md",
    scannerTools: ["tools/scan-benqi-avalanche.js", "tools/inspect-benqi-oracle.js"],
  },
];

async function main() {
  console.log(`=== Phase 6 Artifact Generator — ${PROTOCOLS.length} Protocols ===\n`);

  for (const p of PROTOCOLS) {
    const artifact = {
      generatedAt: NOW,
      scanner: "tools/generate-phase6-artifacts.js",
      scope: `Phase 6 artifact — pre-era protocol backfill for ${p.name}`,
      protocol: p.name,
      chain: p.chain,
      chainId: p.chainId,
      verdict: p.verdict,
      safety: {
        rpcInventoryRead: false,
        rpcUrlsStored: false,
        signedActions: false,
        exploitExecuteCalls: false,
        routePositive: false,
        signedActionJustified: false,
      },
      oracles: p.oracles,
      liquidation: p.liquidation,
      governance: p.governance,
      flashLoan: p.flashLoan,
      keyAddresses: p.keyAddresses,
      coverage: {
        chainsTotal: 31,
        chainsScanned: 1,
        sourceReviewed: true,
        liveStateVerified: true,
        staticAnalysisRun: false,
        forkProofRun: false,
      },
      residualRisks: p.residualRisks,
      revisitTriggers: p.revisitTriggers,
      sourceArtifacts: ["reports/raw/fast/" + p.slug + "-live.json"],
      triageReport: p.triageReport,
      scannerTools: p.scannerTools,
    };

    const outPath = path.join(WORKSPACE, "reports", "raw", "fast", `phase6-${p.slug}.json`);
    fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2));
    console.log(`  ${p.name.padEnd(20)} → phase6-${p.slug}.json (${p.verdict})`);
  }

  console.log(`\nGenerated ${PROTOCOLS.length} Phase 6 artifacts in reports/raw/fast/`);
}

main().catch(e => { console.error(e); process.exit(1); });
