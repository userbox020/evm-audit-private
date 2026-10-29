#!/usr/bin/env node
// scan-route-positive-sweep.js - read-only distance-to-profit sweep over decoded dormant route artifacts.

const fs = require("fs");
const path = require("path");
const { authorizationRow } = require("./live-execution-batch");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "route-positive-sweep.json");
const QUIET = process.argv.includes("--quiet");

const FILES = {
  aaveV4Hubs: path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-hubs.json"),
  aaveV4Borrowers: path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-spoke-borrowers.json"),
  aaveV4LiquidationQuotes: path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-liquidation-quotes.json"),
  aaveV4LiquidationShadowQuotes: path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-liquidation-shadow-quotes.json"),
  aaveV4StablePairRouteProbe: path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-stable-pair-route-probe.json"),
  aaveV4OracleInfluence: path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-oracle-influence-proof.json"),
  aaveV3RouteDistance: path.join(WORKSPACE, "reports", "raw", "fast", "aave-v3-route-distance.json"),
  aaveV3TriggerReadiness: path.join(WORKSPACE, "reports", "raw", "fast", "aave-v3-trigger-readiness.json"),
  hyperlendStaleSource: path.join(WORKSPACE, "reports", "raw", "fast", "hyperlend-stale-source-routes.json"),
  venusBaseWsteth: path.join(WORKSPACE, "reports", "raw", "fast", "venus-base-wsteth-routes.json"),
  lorenzoSusd1Plus: path.join(WORKSPACE, "reports", "raw", "fast", "lorenzo-susd1plus-live.json"),
  lorenzoSameEpochExit: path.join(WORKSPACE, "reports", "raw", "fast", "lorenzo-same-epoch-exit-probe.json"),
  lorenzoRouteRefresh: path.join(WORKSPACE, "reports", "raw", "fast", "prefilter-lorenzo-susd1plus-route-refresh.json"),
  lorenzoStep6Accounting: path.join(WORKSPACE, "reports", "raw", "fast", "lorenzo-susd1plus-step6-accounting.json"),
  lombardRatioDomainStep7: path.join(WORKSPACE, "reports", "raw", "fast", "critical-lombard-ratio-domain-step7.json"),
  morphoHighApyLiquidationRoutes: path.join(WORKSPACE, "reports", "raw", "fast", "morpho-high-apy-liquidation-routes.json"),
  morphoHighApyNonDexExitClassification: path.join(WORKSPACE, "reports", "raw", "fast", "morpho-high-apy-nondex-exit-classification.json"),
  morphoPythUnsafeConsumers: path.join(WORKSPACE, "reports", "raw", "fast", "morpho-pyth-unsafe-consumers.json"),
  morphoPythWatchPreflight: path.join(WORKSPACE, "reports", "raw", "fast", "morpho-pyth-watch-row-preflight.json"),
  curveIbStable: path.join(WORKSPACE, "reports", "raw", "fast", "curve-ib-stable-wrapper-route.json"),
  e12xRoutes: path.join(WORKSPACE, "reports", "raw", "fast", "e12x-route-dry-runs.json"),
  e2QuoteVault: path.join(WORKSPACE, "reports", "raw", "fast", "e2-quotevault-candidates.json"),
  currentProfitTriage: path.join(WORKSPACE, "reports", "raw", "fast", "current-profit-lead-triage.json"),
  publicLeadCompoundLikeRoutes: path.join(WORKSPACE, "reports", "raw", "fast", "public-lead-compound-like-routes.json"),
  publicLeadConsumerJoins: path.join(WORKSPACE, "reports", "raw", "fast", "public-lead-consumer-joins.json"),
  centrifugeNavConsumerGraph: path.join(WORKSPACE, "reports", "raw", "fast", "centrifuge-nav-consumer-graph.json"),
  anemoyCapitalPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "anemoy-capital-phase0.json"),
  reservoirPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "reservoir-phase0.json"),
  blackrockBuidlPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "blackrock-buidl-phase0.json"),
  paxosGoldPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "paxos-gold-phase0.json"),
  rePhase0: path.join(WORKSPACE, "reports", "raw", "fast", "re-phase0.json"),
  bifiPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "bifi-phase0.json"),
  tetherGoldPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "tether-gold-phase0.json"),
  usdAiPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "usd-ai-phase0.json"),
  circleUsycPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "circle-usyc-phase0.json"),
  midasRwaPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "midas-rwa-phase0.json"),
  spikoPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "spiko-phase0.json"),
  fortyAcresPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "40acres-phase0.json"),
  nativeCreditPoolPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "native-credit-pool-phase0.json"),
  matrixdockStbtPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "matrixdock-stbt-phase0.json"),
  arbitrumBridgePhase0: path.join(WORKSPACE, "reports", "raw", "fast", "arbitrum-bridge-phase0.json"),
  polygonZkevmBridgePhase0: path.join(WORKSPACE, "reports", "raw", "fast", "polygon-zkevm-bridge-phase0.json"),
  cronosZkevmBridgePhase0: path.join(WORKSPACE, "reports", "raw", "fast", "cronos-zkevm-bridge-phase0.json"),
  flyingTulipLendPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "flying-tulip-lend-phase0.json"),
  capyfiPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "capyfi-phase0.json"),
  fluxFinancePhase0: path.join(WORKSPACE, "reports", "raw", "fast", "flux-finance-phase0.json"),
  ethenaUsdtbPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "ethena-usdtb-phase0.json"),
  openTradePhase0: path.join(WORKSPACE, "reports", "raw", "fast", "opentrade-phase0.json"),
  wisdomTreePhase0: path.join(WORKSPACE, "reports", "raw", "fast", "wisdomtree-phase0.json"),
  resupplyPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "resupply-phase0.json"),
  firaPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "fira-phase0.json"),
  republicNotePhase0: path.join(WORKSPACE, "reports", "raw", "fast", "republic-note-phase0.json"),
  kasuPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "kasu-phase0.json"),
  hastraPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "hastra-phase0.json"),
  templarProtocolPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "templar-protocol-phase0.json"),
  bituProtocolPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "bitu-protocol-phase0.json"),
  inverseFinanceFirmPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "inverse-finance-firm-phase0.json"),
  csigmaFinancePhase0: path.join(WORKSPACE, "reports", "raw", "fast", "csigma-finance-phase0.json"),
  gravityByGalxePhase0: path.join(WORKSPACE, "reports", "raw", "fast", "gravity-by-galxe-phase0.json"),
  alpacaFinance2Phase0: path.join(WORKSPACE, "reports", "raw", "fast", "alpaca-finance-2-phase0.json"),
  openedenTbillPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "openeden-tbill-phase0.json"),
  lighterBridgePrefilter: path.join(WORKSPACE, "reports", "raw", "fast", "prefilter-lighter-bridge-route-prefilter.json"),
  asterBridgePrefilter: path.join(WORKSPACE, "reports", "raw", "fast", "prefilter-aster-bridge-route-prefilter.json"),
  digiftRwaPrefilter: path.join(WORKSPACE, "reports", "raw", "fast", "prefilter-digift-rwa-route-prefilter.json"),
  gaibRwaPrefilter: path.join(WORKSPACE, "reports", "raw", "fast", "prefilter-gaib-rwa-route-prefilter.json"),
  emberProtocolPrefilter: path.join(WORKSPACE, "reports", "raw", "fast", "prefilter-ember-protocol-route-prefilter.json"),
  mainstreetPrefilter: path.join(WORKSPACE, "reports", "raw", "fast", "prefilter-mainstreet-route-prefilter.json"),
  overnightFinancePrefilter: path.join(WORKSPACE, "reports", "raw", "fast", "prefilter-overnight-finance-route-prefilter.json"),
  spectraMetavaultsPrefilter: path.join(WORKSPACE, "reports", "raw", "fast", "prefilter-spectra-metavaults-route-prefilter.json"),
  coinbaseWrappedStakedEthPrefilter: path.join(WORKSPACE, "reports", "raw", "fast", "prefilter-coinbase-wrapped-staked-eth-route-prefilter.json"),
  coinbaseWrappedStakedEthFullTest: path.join(WORKSPACE, "reports", "raw", "fast", "coinbase-wrapped-staked-eth-full-test.json"),
  wrappedFiPrefilter: path.join(WORKSPACE, "reports", "raw", "fast", "prefilter-wrappedfi-route-prefilter.json"),
  wrappedFiFullTest: path.join(WORKSPACE, "reports", "raw", "fast", "wrappedfi-full-test.json"),
  wrappedFiForkRouteTest: path.join(WORKSPACE, "reports", "raw", "fast", "wrappedfi-fork-route-test.json"),
  summerFiProPrefilter: path.join(WORKSPACE, "reports", "raw", "fast", "prefilter-summer-fi-pro-route-prefilter.json"),
  summerFiProFullTest: path.join(WORKSPACE, "reports", "raw", "fast", "summer-fi-pro-full-test.json"),
  summerFiProForkRouteTest: path.join(WORKSPACE, "reports", "raw", "fast", "summer-fi-pro-fork-route-test.json"),
  b2BuzzPrefilter: path.join(WORKSPACE, "reports", "raw", "fast", "prefilter-b2-buzz-route-prefilter.json"),
  b2BuzzFullTest: path.join(WORKSPACE, "reports", "raw", "fast", "b2-buzz-full-test.json"),
  b2BuzzForkRouteTest: path.join(WORKSPACE, "reports", "raw", "fast", "b2-buzz-fork-route-test.json"),
  etherfusePrefilter: path.join(WORKSPACE, "reports", "raw", "fast", "prefilter-etherfuse-route-prefilter.json"),
  etherfuseFullTest: path.join(WORKSPACE, "reports", "raw", "fast", "etherfuse-full-test.json"),
  etherfuseForkRouteTest: path.join(WORKSPACE, "reports", "raw", "fast", "etherfuse-fork-route-test.json"),
  merlinsSealFullTest: path.join(WORKSPACE, "reports", "raw", "fast", "merlins-seal-full-test.json"),
  upshiftFullTest: path.join(WORKSPACE, "reports", "raw", "fast", "upshift-full-test.json"),
  staderFullTest: path.join(WORKSPACE, "reports", "raw", "fast", "stader-full-test.json"),
  staderForkTransactionTest: path.join(WORKSPACE, "reports", "raw", "fast", "stader-fork-transaction-test.json"),
  mapleFullTest: path.join(WORKSPACE, "reports", "raw", "fast", "maple-full-test.json"),
  gauntletFullTest: path.join(WORKSPACE, "reports", "raw", "fast", "gauntlet-full-test.json"),
  pumpbtcFullTest: path.join(WORKSPACE, "reports", "raw", "fast", "pumpbtc-full-test.json"),
  capFullTest: path.join(WORKSPACE, "reports", "raw", "fast", "cap-full-test.json"),
  spectraV2FullTest: path.join(WORKSPACE, "reports", "raw", "fast", "spectra-v2-full-test.json"),
  spectraMetavaultsOutsideV2FullTest: path.join(WORKSPACE, "reports", "raw", "fast", "spectra-metavaults-outside-v2-full-test.json"),
  ringFewFullTest: path.join(WORKSPACE, "reports", "raw", "fast", "ring-few-full-test.json"),
  rockawayxFullTest: path.join(WORKSPACE, "reports", "raw", "fast", "rockawayx-full-test.json"),
  roycoV1FullTest: path.join(WORKSPACE, "reports", "raw", "fast", "royco-v1-full-test.json"),
  eigencloudFullTest: path.join(WORKSPACE, "reports", "raw", "fast", "eigencloud-full-test.json"),
  stakeDaoFullTest: path.join(WORKSPACE, "reports", "raw", "fast", "stake-dao-full-test.json"),
  stoboxFullTest: path.join(WORKSPACE, "reports", "raw", "fast", "stobox-full-test.json"),
  brixFullTest: path.join(WORKSPACE, "reports", "raw", "fast", "brix-full-test.json"),
  memeDollarFullTest: path.join(WORKSPACE, "reports", "raw", "fast", "meme-dollar-full-test.json"),
  fluidLendingPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "fluid-lending-phase0.json"),
  benqiLendingPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "benqi-lending-phase0.json"),
  crvusdPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "crvusd-phase0.json"),
  curveLlamalendPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "curve-llamalend-phase0.json"),
  optimismBridgePhase0: path.join(WORKSPACE, "reports", "raw", "fast", "optimism-bridge-phase0.json"),
  baseBridgePhase0: path.join(WORKSPACE, "reports", "raw", "fast", "base-bridge-phase0.json"),
  sankoBridgePhase0: path.join(WORKSPACE, "reports", "raw", "fast", "sanko-bridge-phase0.json"),
  moonwellLendingPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "moonwell-lending-phase0.json"),
  liquityV1Phase0: path.join(WORKSPACE, "reports", "raw", "fast", "liquity-v1-phase0.json"),
  liquityV2Phase0: path.join(WORKSPACE, "reports", "raw", "fast", "liquity-v2-phase0.json"),
  fraxUsdPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "frax-usd-phase0.json"),
  worldChainBridgePhase0: path.join(WORKSPACE, "reports", "raw", "fast", "world-chain-bridge-phase0.json"),
  avalancheCoreBridgePhase0: path.join(WORKSPACE, "reports", "raw", "fast", "avalanche-core-bridge-phase0.json"),
  apolloAcredPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "apollo-acred-phase0.json"),
  sxRollupBridgePhase0: path.join(WORKSPACE, "reports", "raw", "fast", "sx-rollup-bridge-phase0.json"),
  usddPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "usdd-phase0.json"),
  txflowBridgePhase0: path.join(WORKSPACE, "reports", "raw", "fast", "txflow-bridge-phase0.json"),
  frankencoinPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "frankencoin-phase0.json"),
  invescoUstbPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "invesco-ustb-phase0.json"),
  listaCdpPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "lista-cdp-phase0.json"),
  listaDexPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "lista-dex-phase0.json"),
  joeV22Phase0: path.join(WORKSPACE, "reports", "raw", "fast", "joe-v22-phase0.json"),
  balancerV3Phase0: path.join(WORKSPACE, "reports", "raw", "fast", "balancer-v3-phase0.json"),
  uniswapV2Phase0: path.join(WORKSPACE, "reports", "raw", "fast", "uniswap-v2-phase0.json"),
  uniswapV3Phase0: path.join(WORKSPACE, "reports", "raw", "fast", "uniswap-v3-phase0.json"),
  pancakeswapAmmPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "pancakeswap-amm-phase0.json"),
  pancakeswapAmmV3Phase0: path.join(WORKSPACE, "reports", "raw", "fast", "pancakeswap-amm-v3-phase0.json"),
  pancakeswapInfinityPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "pancakeswap-infinity-phase0.json"),
  ekuboPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "ekubo-phase0.json"),
  thorchainDexPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "thorchain-dex-phase0.json"),
  curveDexPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "curve-dex-phase0.json"),
  quickswapDexPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "quickswap-dex-phase0.json"),
  fluidDexPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "fluid-dex-phase0.json"),
  aerodromeSlipstreamPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "aerodrome-slipstream-phase0.json"),
  aerodromeV1Phase0: path.join(WORKSPACE, "reports", "raw", "fast", "aerodrome-v1-phase0.json"),
  velodromeV3Phase0: path.join(WORKSPACE, "reports", "raw", "fast", "velodrome-v3-phase0.json"),
  nadoSpotPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "nado-spot-phase0.json"),
  threeFPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "3f-phase0.json"),
  siloV2Phase0: path.join(WORKSPACE, "reports", "raw", "fast", "silo-v2-phase0.json"),
  harmonixPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "harmonix-phase0.json"),
  eulerV2Phase0: path.join(WORKSPACE, "reports", "raw", "fast", "euler-v2-phase0.json"),
  nestCreditPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "nest-credit-phase0.json"),
  compoundV3Phase0: path.join(WORKSPACE, "reports", "raw", "fast", "compound-v3-phase0.json"),
  paretoCreditPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "pareto-credit-phase0.json"),
  etherfiBorrowingPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "etherfi-borrowing-phase0.json"),
  felixCdpPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "felix-cdp-phase0.json"),
  metisBridgePhase0: path.join(WORKSPACE, "reports", "raw", "fast", "metis-bridge-phase0.json"),
  ccipPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "ccip-phase0.json"),
  solvbtcPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "solvbtc-phase0.json"),
  solvbtcAdminSurface: path.join(WORKSPACE, "reports", "raw", "fast", "solvbtc-admin-surface.json"),
  usdcxPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "usdcx-phase0.json"),
  staderPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "stader-phase0.json"),
  robinhoodChainPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "robinhood-chain-phase0.json"),
  robinhoodChainAttackVectors: path.join(WORKSPACE, "reports", "raw", "fast", "robinhood-chain-attack-vectors.json"),
  venusCorePoolPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "venus-core-pool-phase0.json"),
  venusFluxPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "venus-flux-phase0.json"),
  bendPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "bend-phase0.json"),
  saturnSusdatPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "saturn-susdat-phase0.json"),
  portalPhase0: path.join(WORKSPACE, "reports", "raw", "fast", "portal-phase0.json"),
  erc4626Joiner: path.join(WORKSPACE, "reports", "raw", "fast", "erc4626-consumer-joiner.json"),
  newVaultDonationAttack: path.join(WORKSPACE, "reports", "raw", "fast", "new-vault-donation-attack.json"),
  erc4626V4HookOverlaps: path.join(WORKSPACE, "reports", "raw", "fast", "erc4626-v4-hook-overlaps.json"),
  dexHookCallbackAbuse: path.join(WORKSPACE, "reports", "raw", "fast", "dex-hook-callback-abuse.json"),
  dexHookSourceGating: path.join(WORKSPACE, "reports", "raw", "fast", "dex-hook-source-gating.json"),
  consumerFirstHighLtv: path.join(WORKSPACE, "reports", "raw", "fast", "consumer-first-high-ltv-collateral.json"),
  crossProtocolComposition: path.join(WORKSPACE, "reports", "raw", "fast", "cross-protocol-composition.json"),
  smallCapOracleCurrentPaths: path.join(WORKSPACE, "reports", "raw", "fast", "small-cap-oracle-current-paths.json"),
  postAuditNewMarketDrift: path.join(WORKSPACE, "reports", "raw", "fast", "post-audit-new-market-drift.json"),
  smallCapOracleManipulation: path.join(WORKSPACE, "reports", "raw", "fast", "small-cap-oracle-manipulation-routes.json"),
  marketLaunchChoreography: path.join(WORKSPACE, "reports", "raw", "fast", "market-launch-choreography-routes.json"),
  factoryLaunchDonationWatch: path.join(WORKSPACE, "reports", "raw", "fast", "factory-launch-donation-watch.json"),
  governanceListingWatch: path.join(WORKSPACE, "reports", "raw", "fast", "governance-listing-watch.json"),
  governanceTimelockPayloads: path.join(WORKSPACE, "reports", "raw", "fast", "governance-timelock-payloads.json"),
  governanceAttackSurface: path.join(WORKSPACE, "reports", "raw", "fast", "governance-attack-surface.json"),
  governanceFlashloanVoting: path.join(WORKSPACE, "reports", "raw", "fast", "governance-flashloan-voting.json"),
  sevenChainLendingCoverage: path.join(WORKSPACE, "reports", "raw", "fast", "seven-chain-lending-coverage.json"),
  blastNativeYieldLending: path.join(WORKSPACE, "reports", "raw", "fast", "blast-native-yield-lending.json"),
  nftLendingOracleRoutes: path.join(WORKSPACE, "reports", "raw", "fast", "nft-lending-oracle-routes.json"),
  kaminoOracleConfig: path.join(WORKSPACE, "reports", "raw", "fast", "kamino-oracle-config.json"),
  kaminoLiquidationProfitability: path.join(WORKSPACE, "reports", "raw", "fast", "kamino-liquidation-profitability.json"),
  kaminoLiveWindowRanker: path.join(WORKSPACE, "reports", "raw", "fast", "kamino-live-window-ranker.json"),
  kaminoReducedStatusRecertification: path.join(WORKSPACE, "reports", "raw", "fast", "kamino-reduced-status-liquidation-recertification.json"),
  synapseCctpStep8: path.join(WORKSPACE, "reports", "raw", "fast", "synapse-cctp-step8.json"),
  synapseCctpStep8Manifest: path.join(WORKSPACE, "reports", "raw", "fast", "synapse-cctp-step8.manifest.json"),
  marginfiHealthRecompute: path.join(WORKSPACE, "reports", "raw", "fast", "marginfi-health-recompute.json"),
  solanaReceiptTokenConsumerGraph: path.join(WORKSPACE, "reports", "raw", "fast", "solana-receipt-token-consumer-graph.json"),
  hyperliquidPerpsMeta: path.join(WORKSPACE, "reports", "raw", "fast", "hyperliquid-perps-meta.json"),
  hyperliquidPerpsSpotDivergence: path.join(WORKSPACE, "reports", "raw", "fast", "hyperliquid-perps-spot-divergence.json"),
  hyperliquidFundingArbRoutes: path.join(WORKSPACE, "reports", "raw", "fast", "hyperliquid-funding-arb-routes.json"),
  eigenlayerLrtNavDexDivergence: path.join(WORKSPACE, "reports", "raw", "fast", "eigenlayer-lrt-nav-dex-divergence.json"),
  eigenlayerSlashingRehypothecation: path.join(WORKSPACE, "reports", "raw", "fast", "eigenlayer-slashing-rehypothecation.json"),
  coolerLoansLiveState: path.join(WORKSPACE, "reports", "raw", "fast", "cooler-loans-live-state.json"),
  venusDeepBsc: path.join(WORKSPACE, "reports", "raw", "fast", "venus-bsc-legacy-deep.json"),
  venusDeepMulti: path.join(WORKSPACE, "reports", "raw", "fast", "venus-multichain-deep.json"),
  listaDeepOracle: path.join(WORKSPACE, "reports", "raw", "fast", "lista-oracle-deep.json"),
  lidoWithdrawalQueue: path.join(WORKSPACE, "reports", "raw", "fast", "lido-withdrawal-queue-scan.json"),
  lidoOracleStaleness: path.join(WORKSPACE, "reports", "raw", "fast", "lido-oracle-staleness.json"),
  stablecoinDepegLendingRoutes: path.join(WORKSPACE, "reports", "raw", "fast", "stablecoin-depeg-lending-routes.json"),
  lrtOracleDriftRoutes: path.join(WORKSPACE, "reports", "raw", "fast", "lrt-oracle-drift-routes.json"),
  lrtOraclePremiumProbe: path.join(WORKSPACE, "reports", "raw", "fast", "lrt-oracle-premium-probe.json"),
  morphoFlashloanTokenOverlap: path.join(WORKSPACE, "reports", "raw", "fast", "morpho-flashloan-token-overlap.json"),
  evaultCollateralNavManipulation: path.join(WORKSPACE, "reports", "raw", "fast", "evault-collateral-nav-manipulation.json"),
  evaultDonationSensitivity: path.join(WORKSPACE, "reports", "raw", "fast", "evault-donation-sensitivity.json"),
  twoMarketLeverageLoops: path.join(WORKSPACE, "reports", "raw", "fast", "two-market-leverage-loops.json"),
  focusedMorphoReview: path.join(WORKSPACE, "reports", "raw", "fast", "focused-morpho-review-producers.json"),
  focusedEulerReview: path.join(WORKSPACE, "reports", "raw", "fast", "focused-euler-evk-review-producers.json"),
  morphoPublicAllocatorForceFeed: path.join(WORKSPACE, "reports", "raw", "fast", "morpho-public-allocator-force-feed.json"),
  hyperevmLstLrtOracleRoutes: path.join(WORKSPACE, "reports", "raw", "fast", "hyperevm-lst-lrt-oracle-routes.json"),
  hyperevmLstLrtExactQuotes: path.join(WORKSPACE, "reports", "raw", "fast", "hyperevm-lst-lrt-exact-quotes.json"),
  hyperliquidLinkedTokenConsumers: path.join(WORKSPACE, "reports", "raw", "fast", "hyperliquid-linked-token-consumers.json"),
  hyperliquidCoreDexDepth: path.join(WORKSPACE, "reports", "raw", "fast", "hyperliquid-core-dex-depth-routes.json"),
  layerzeroOftDvnConsumerJoins: path.join(WORKSPACE, "reports", "raw", "fast", "layerzero-oft-dvn-consumer-joins.json"),
  usdt0ConsumerRoutes: path.join(WORKSPACE, "reports", "raw", "fast", "usdt0-consumer-routes.json"),
  usdt0OftRoutes: path.join(WORKSPACE, "reports", "raw", "fast", "usdt0-oft-routes.json"),
  pendlePtConsumerGraph: path.join(WORKSPACE, "reports", "raw", "fast", "pendle-pt-consumer-graph.json"),
  pendlePtMultichainConsumerGraph: path.join(WORKSPACE, "reports", "raw", "fast", "pendle-pt-multichain-consumer-graph.json"),
  siloPtOracleRoutes: path.join(WORKSPACE, "reports", "raw", "fast", "silo-pt-oracle-routes.json"),
  pendleYtCollateral: path.join(WORKSPACE, "reports", "raw", "fast", "pendle-yt-collateral-routes.json"),
  baseSyrupUsdc: path.join(WORKSPACE, "reports", "raw", "fast", "base-syrupusdc-routes.json"),
  baseCadc: path.join(WORKSPACE, "reports", "raw", "fast", "base-cadc-routes.json"),
  avalancheStableYield: path.join(WORKSPACE, "reports", "raw", "fast", "avalanche-stable-yield-routes.json"),
  originArmGrowth: path.join(WORKSPACE, "reports", "raw", "fast", "origin-arm-growth-map.json"),
  bridgersGrowth: path.join(WORKSPACE, "reports", "raw", "fast", "bridgers-growth-map.json"),
  xstocksConsumerRoutes: path.join(WORKSPACE, "reports", "raw", "fast", "xstocks-consumer-routes.json"),
  dexConsumerRoutes: path.join(WORKSPACE, "reports", "raw", "fast", "dex-consumer-routes.json"),
  solanaConsumerRoutes: path.join(WORKSPACE, "reports", "raw", "fast", "solana-consumer-routes.json"),
  perpsConsumerRoutes: path.join(WORKSPACE, "reports", "raw", "fast", "perps-consumer-routes.json"),
  perpsLendingComposability: path.join(WORKSPACE, "reports", "raw", "fast", "perps-lending-composability.json"),
  currentLiquidatableExitRoutes: path.join(WORKSPACE, "reports", "raw", "fast", "current-liquidatable-exit-routes.json"),
  morphoLiquidatableMarketability: path.join(WORKSPACE, "reports", "raw", "fast", "morpho-liquidatable-marketability.json"),
  morphoWrapperExitProofGaps: path.join(WORKSPACE, "reports", "raw", "fast", "morpho-wrapper-exit-proof-gaps.json"),
  morphoYethAlternateExits: path.join(WORKSPACE, "reports", "raw", "fast", "morpho-yeth-alternate-exits.json"),
  dexExitQuotes: path.join(WORKSPACE, "reports", "raw", "fast", "dex-exit-quotes.json"),
  socketRouteQuotes: path.join(WORKSPACE, "reports", "raw", "fast", "socket-route-quotes.json"),
  socketBranchEnrichment: path.join(WORKSPACE, "reports", "raw", "fast", "socket-branch-enrichment.json"),
  lorenzoBscSupplyWatch: path.join(WORKSPACE, "reports", "raw", "fast", "lorenzo-bsc-supply-route-watch.json"),
  oracleStalenessCrossRef: path.join(WORKSPACE, "reports", "raw", "fast", "oracle-staleness-cross-ref.json"),
  hgethDexWatch: path.join(WORKSPACE, "reports", "raw", "fast", "hgeth-dex-liquidity-watch.json"),
  pendlePtMaturityRoutes: path.join(WORKSPACE, "reports", "raw", "fast", "pendle-pt-maturity-routes.json"),
  avalonUsdaLive: path.join(WORKSPACE, "reports", "raw", "fast", "avalon-usda-live.json"),
  avalonUsdaAbiClassification: path.join(WORKSPACE, "reports", "raw", "fast", "avalon-usda-abi-classification.json"),
  avalonUsdaSelectorProbe: path.join(WORKSPACE, "reports", "raw", "fast", "avalon-usda-classified-selector-probe.json"),
  avalonUsdaDeep: path.join(WORKSPACE, "reports", "raw", "fast", "avalon-usda-deep-probe.json"),
  crossChainPriceDiscrepancy: path.join(WORKSPACE, "reports", "raw", "fast", "cross-chain-price-discrepancy.json"),
  crossChainOracleDrift: path.join(WORKSPACE, "reports", "raw", "fast", "cross-chain-oracle-drift.json"),
  deriveV2Live: path.join(WORKSPACE, "reports", "raw", "fast", "derive-v2-live.json"),
  bridgeEscrowReconciliation: path.join(WORKSPACE, "reports", "raw", "fast", "bridge-escrow-reconciliation.json"),
  suiLendingConfig: path.join(WORKSPACE, "reports", "raw", "fast", "sui-lending-config.json"),
  apyusdRedeemRoute: path.join(WORKSPACE, "reports", "raw", "fast", "apyusd-erc4626-redeem-route.json"),
  apyusdForkProof: path.join(WORKSPACE, "reports", "raw", "fast", "apyusd-erc4626-fork-proof.json"),
  confirmedSignalVariants: path.join(WORKSPACE, "reports", "raw", "fast", "confirmed-signal-variants.json"),
  steammMarketability: path.join(WORKSPACE, "reports", "raw", "steamm-candidate-marketability.json"),
  validationDifferentialLiquidations: path.join(WORKSPACE, "reports", "raw", "fast", "validation-differential-liquidations.json"),
  jupiterLendOracleDivergence: path.join(WORKSPACE, "reports", "raw", "fast", "jupiter-lend-oracle-divergence.json"),
  jupiterXstockMultiplierImpact: path.join(WORKSPACE, "reports", "raw", "fast", "jupiter-xstock-multiplier-impact.json"),
  ptOracleUnitMismatch: path.join(WORKSPACE, "reports", "raw", "fast", "pt-oracle-unit-mismatch.json"),
  routerRfqSettlementDrift: path.join(WORKSPACE, "reports", "raw", "fast", "router-rfq-settlement-drift.json"),
  deprecatedOrphanedReachability: path.join(WORKSPACE, "reports", "raw", "fast", "deprecated-orphaned-reachability.json"),
  bridgeProofBinding: path.join(WORKSPACE, "reports", "raw", "fast", "bridge-proof-binding.json"),
  fakeAssetPoolValidation: path.join(WORKSPACE, "reports", "raw", "fast", "fake-asset-pool-validation.json"),
  poolShareSnapshotDrift: path.join(WORKSPACE, "reports", "raw", "fast", "pool-share-snapshot-drift.json"),
  strategyMigrationRebalance: path.join(WORKSPACE, "reports", "raw", "fast", "strategy-migration-rebalance.json"),
  postAuditScopeDrift: path.join(WORKSPACE, "reports", "raw", "fast", "post-audit-scope-drift.json"),
  postAuditDeployedMap: path.join(WORKSPACE, "reports", "raw", "fast", "post-audit-deployed-map.json"),
  bridgeDomainSeparation: path.join(WORKSPACE, "reports", "raw", "fast", "bridge-domain-separation.json"),
  bridgeNonLosslessCollateralJoin: path.join(WORKSPACE, "reports", "raw", "fast", "bridge-nonlossless-collateral-join.json"),
  bridgeDeltaPreflight: path.join(WORKSPACE, "reports", "raw", "fast", "bridge-delta-preflight.json"),
  bridgeSyntheticConsumerExposure: path.join(WORKSPACE, "reports", "raw", "fast", "bridge-synthetic-consumer-exposure.json"),
  bridgeLendingCollateralJoin: path.join(WORKSPACE, "reports", "raw", "fast", "bridge-lending-collateral-join.json"),
  signedPayloadReplay: path.join(WORKSPACE, "reports", "raw", "fast", "signed-payload-replay.json"),
  claimDistributorReplay: path.join(WORKSPACE, "reports", "raw", "fast", "claim-distributor-replay.json"),
  predictionMarketLiveRoutes: path.join(WORKSPACE, "reports", "raw", "fast", "prediction-market-live-routes.json"),
  polymarketAdapterFullBalanceGate: path.join(WORKSPACE, "reports", "raw", "fast", "polymarket-adapter-full-balance-gate.json"),
  crossChainSettlementQuotes: path.join(WORKSPACE, "reports", "raw", "fast", "cross-chain-settlement-quotes.json"),
  intentSolverSettlementAbuse: path.join(WORKSPACE, "reports", "raw", "fast", "intent-solver-settlement-abuse.json"),
  mevSandwichOrderEconomics: path.join(WORKSPACE, "reports", "raw", "fast", "mev-sandwich-order-economics.json"),
  recentContractsOldMoneyProbes: path.join(WORKSPACE, "reports", "raw", "fast", "recent-contracts-old-money-probes.json"),
  gasAccountingTipRace: path.join(WORKSPACE, "reports", "raw", "fast", "gas-accounting-tip-race.json"),
  deployedPathProofGaps: path.join(WORKSPACE, "reports", "raw", "fast", "deployed-path-proof-gaps.json"),
  insuranceFundDrainV2: path.join(WORKSPACE, "reports", "raw", "fast", "insurance-fund-drain-v2.json"),
  feeOnTransferRebase: path.join(WORKSPACE, "reports", "raw", "fast", "fee-on-transfer-rebase.json"),
  nonBorrowDrainSurface: path.join(WORKSPACE, "reports", "raw", "fast", "non-borrow-drain-surface.json"),
  aaveV3EmodeEscalation: path.join(WORKSPACE, "reports", "raw", "fast", "aave-v3-emode-escalation.json"),
  recentMorphoCreateMarkets: path.join(WORKSPACE, "reports", "raw", "fast", "recent-morpho-create-markets.json"),
  defillamaTopNewDeepDive: path.join(WORKSPACE, "reports", "raw", "fast", "defillama-top-new-deep-dive.json"),
  defillamaTopNewConsumerJoins: path.join(WORKSPACE, "reports", "raw", "fast", "defillama-top-new-consumer-joins.json"),
  babylonLateQuorumProductionExposure: path.join(WORKSPACE, "reports", "raw", "fast", "babylon-late-quorum-production-exposure.json"),
  babylonLateQuorumProductionExposureManifest: path.join(WORKSPACE, "reports", "raw", "fast", "babylon-late-quorum-production-exposure.manifest.json"),
  babylonPreRetentionSourceReadiness: path.join(WORKSPACE, "reports", "raw", "fast", "babylon-pre-retention-source-readiness.json"),
  babylonPreRetentionSourceReadinessManifest: path.join(WORKSPACE, "reports", "raw", "fast", "babylon-pre-retention-source-readiness.manifest.json"),
  babylonMintscanPreRetentionEnumerator: path.join(WORKSPACE, "reports", "raw", "fast", "babylon-mintscan-pre-retention-enumerator.json"),
  babylonMintscanPreRetentionEnumeratorManifest: path.join(WORKSPACE, "reports", "raw", "fast", "babylon-mintscan-pre-retention-enumerator.manifest.json"),
  criticalUnitProxyControl: path.join(WORKSPACE, "reports", "raw", "fast", "critical-unit-proxy-control.json"),
  criticalUnitProxyControlManifest: path.join(WORKSPACE, "reports", "raw", "fast", "critical-unit-proxy-control-manifest.json"),
  criticalAsterBnbTreasuryControl: path.join(WORKSPACE, "reports", "raw", "fast", "critical-aster-bnb-treasury-control.json"),
  criticalAsterBnbTreasuryControlManifest: path.join(WORKSPACE, "reports", "raw", "fast", "critical-aster-bnb-treasury-control-manifest.json"),
  criticalCcipSyrupusdtReleaseAuth: path.join(WORKSPACE, "reports", "raw", "fast", "critical-ccip-syrupusdt-release-auth.json"),
  criticalCcipSyrupusdtReleaseAuthOfflineBuild: path.join(WORKSPACE, "reports", "raw", "fast", "critical-ccip-syrupusdt-release-auth-offline-build.json"),
  criticalCcipSyrupusdtReleaseAuthManifest: path.join(WORKSPACE, "reports", "raw", "fast", "critical-ccip-syrupusdt-release-auth-manifest.json"),
  criticalCcipSyrupusdtBackingConservation: path.join(WORKSPACE, "reports", "raw", "fast", "critical-ccip-syrupusdt-backing-conservation.json"),
  criticalCcipSyrupusdtBackingConservationWorksheet: path.join(WORKSPACE, "reports", "raw", "fast", "critical-ccip-syrupusdt-backing-conservation-worksheet.json"),
  criticalCcipSyrupusdtBackingConservationManifest: path.join(WORKSPACE, "reports", "raw", "fast", "critical-ccip-syrupusdt-backing-conservation-manifest.json"),
  criticalEtherfiDefaultModuleCapability: path.join(WORKSPACE, "reports", "raw", "fast", "critical-etherfi-default-module-capability.json"),
  criticalEtherfiDefaultModuleCapabilityManifest: path.join(WORKSPACE, "reports", "raw", "fast", "critical-etherfi-default-module-capability-manifest.json"),
  criticalEtherfiPinboundBuildBinding: path.join(WORKSPACE, "reports", "raw", "fast", "critical-etherfi-pinbound-build-binding.json"),
  criticalEtherfiPinboundBuildBindingManifest: path.join(WORKSPACE, "reports", "raw", "fast", "critical-etherfi-pinbound-build-binding-manifest.json"),
  criticalEtherfiPendingWithdrawalTuple: path.join(WORKSPACE, "reports", "raw", "fast", "critical-etherfi-pending-withdrawal-tuple.json"),
  criticalEtherfiPendingWithdrawalTupleManifest: path.join(WORKSPACE, "reports", "raw", "fast", "critical-etherfi-pending-withdrawal-tuple-manifest.json"),
  criticalEtherfiStargateValidAuthTupleInvariant: path.join(WORKSPACE, "reports", "raw", "fast", "critical-etherfi-stargate-valid-auth-tuple-invariant.json"),
  criticalEtherfiStargateValidAuthTupleInvariantManifest: path.join(WORKSPACE, "reports", "raw", "fast", "critical-etherfi-stargate-valid-auth-tuple-invariant-manifest.json"),
  criticalEtherfiStargateAssetConfigDrift: path.join(WORKSPACE, "reports", "raw", "fast", "critical-etherfi-stargate-asset-config-drift.json"),
  criticalEtherfiStargateAssetConfigDriftManifest: path.join(WORKSPACE, "reports", "raw", "fast", "critical-etherfi-stargate-asset-config-drift-manifest.json"),
  criticalEtherfiUnknownDefaultIdentityBinding: path.join(WORKSPACE, "reports", "raw", "fast", "critical-etherfi-unknown-default-identity-binding.json"),
  criticalEtherfiUnknownDefaultIdentityBindingManifest: path.join(WORKSPACE, "reports", "raw", "fast", "critical-etherfi-unknown-default-identity-binding-manifest.json"),
  criticalEtherfiSafeAssetRecoveryInvariant: path.join(WORKSPACE, "reports", "raw", "fast", "critical-etherfi-safe-asset-recovery-invariant.json"),
  criticalEtherfiSafeAssetRecoveryInvariantManifest: path.join(WORKSPACE, "reports", "raw", "fast", "critical-etherfi-safe-asset-recovery-invariant-manifest.json"),
  criticalEtherfiBehypeFeeRefundDeliveryInvariant: path.join(WORKSPACE, "reports", "raw", "fast", "critical-etherfi-behype-fee-refund-delivery-invariant.json"),
  criticalEtherfiBehypeFeeRefundDeliveryInvariantManifest: path.join(WORKSPACE, "reports", "raw", "fast", "critical-etherfi-behype-fee-refund-delivery-invariant-manifest.json"),
  criticalEtherfiBehypeStakerLayerzeroBinding: path.join(WORKSPACE, "reports", "raw", "fast", "critical-etherfi-behype-staker-layerzero-binding.json"),
  criticalEtherfiBehypeStakerLayerzeroBindingManifest: path.join(WORKSPACE, "reports", "raw", "fast", "critical-etherfi-behype-staker-layerzero-binding-manifest.json"),
  criticalEtherfiBehypeEndpointCoverageRepair: path.join(WORKSPACE, "reports", "raw", "fast", "critical-etherfi-behype-endpoint-coverage-repair.json"),
  criticalEtherfiBehypeEndpointCoverageRepairManifest: path.join(WORKSPACE, "reports", "raw", "fast", "critical-etherfi-behype-endpoint-coverage-repair-manifest.json"),
  criticalEtherfiBehypeSelectedLibraryBinding: path.join(WORKSPACE, "reports", "raw", "fast", "critical-etherfi-behype-selected-library-binding.json"),
  criticalEtherfiBehypeSelectedLibraryBindingManifest: path.join(WORKSPACE, "reports", "raw", "fast", "critical-etherfi-behype-selected-library-binding-manifest.json"),
  criticalEtherfiBehypeReceiveType1NegativeCheck: path.join(WORKSPACE, "reports", "raw", "fast", "critical-etherfi-behype-receive-type1-negative-check.json"),
  criticalEtherfiBehypeReceiveType1NegativeCheckManifest: path.join(WORKSPACE, "reports", "raw", "fast", "critical-etherfi-behype-receive-type1-negative-check-manifest.json"),
  criticalEtherfiBehypeHyperevmDiagnosticR10R2: path.join(WORKSPACE, "reports", "raw", "fast", "critical-etherfi-behype-hyperevm-diagnostic-r10-r2.json"),
  criticalEtherfiBehypeHyperevmDiagnosticR10R2Manifest: path.join(WORKSPACE, "reports", "raw", "fast", "critical-etherfi-behype-hyperevm-diagnostic-r10-r2-manifest.json"),
  criticalEtherfiHyperevmStateCanaryR14R3: path.join(WORKSPACE, "reports", "raw", "fast", "critical-etherfi-hyperevm-state-canary-r14-r3.json"),
  criticalEtherfiHyperevmStateCanaryR14R3Manifest: path.join(WORKSPACE, "reports", "raw", "fast", "critical-etherfi-hyperevm-state-canary-r14-r3-manifest.json"),
  criticalEtherfiHyperevmBehavioralCaptureR2: path.join(WORKSPACE, "reports", "raw", "fast", "critical-etherfi-behype-hyperevm-behavioral-requalification-capture-r2.json"),
  criticalEtherfiHyperevmBehavioralCaptureR2Manifest: path.join(WORKSPACE, "reports", "raw", "fast", "critical-etherfi-behype-hyperevm-behavioral-requalification-capture-r2-manifest.json"),
  criticalEtherfiHyperevmBehavioralRetryCaptureR8: path.join(WORKSPACE, "reports", "raw", "fast", "critical-etherfi-behype-hyperevm-behavioral-retry-capture-r8.json"),
  criticalEtherfiHyperevmBehavioralRetryCaptureR8Manifest: path.join(WORKSPACE, "reports", "raw", "fast", "critical-etherfi-behype-hyperevm-behavioral-retry-capture-r8-manifest.json"),
};

function loadJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value).replace(/[$,%\s,]/g, "");
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function valueAt(obj, field) {
  if (!obj || !field) return null;
  return String(field).split(".").reduce((acc, key) => acc?.[key], obj);
}

function maxNumeric(obj, fields) {
  const values = (fields || []).map((field) => asNumber(valueAt(obj, field))).filter((n) => n !== null);
  if (!values.length) return null;
  return Math.max(...values);
}

function sumNumeric(obj, fields) {
  return (fields || []).reduce((acc, field) => acc + (asNumber(valueAt(obj, field)) || 0), 0);
}

function round(value, decimals = 2) {
  const n = asNumber(value);
  if (n === null) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function revertLabel(revert) {
  if (!revert) return null;
  const base = revert.signature || revert.name || revert.selector || null;
  if (!base) return null;
  const args = Array.isArray(revert.args) && revert.args.length ? ` args=${revert.args.join(",")}` : "";
  return `${base}${args}`;
}

function clamp(value, min = 0, max = 1) {
  const n = asNumber(value);
  if (n === null) return min;
  return Math.max(min, Math.min(max, n));
}

function maxBy(items, fn) {
  let best = null;
  let bestScore = -Infinity;
  for (const item of items || []) {
    const score = Number(fn(item));
    if (Number.isFinite(score) && score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return best;
}

function sum(items, fn) {
  return (items || []).reduce((acc, item) => acc + (asNumber(fn(item)) || 0), 0);
}

function routePositiveCount(...values) {
  return values.reduce((acc, value) => acc + (asNumber(value) || 0), 0);
}

function routePositiveMax(...values) {
  return Math.max(0, ...values.map((value) => asNumber(value) || 0));
}

function canonicalizeExecutableFields(value) {
  function visit(current) {
    if (Array.isArray(current)) {
      const children = current.map(visit);
      return {
        value: children.map((child) => child.value),
        observed: children.some((child) => child.observed),
        invalid: children.some((child) => child.invalid),
      };
    }
    if (!current || typeof current !== "object") return { value: current, observed: false, invalid: false };

    const out = {};
    let observed = false;
    let invalid = false;
    for (const [key, child] of Object.entries(current)) {
      if (key === "executableNow") {
        observed ||= child === true || (typeof child === "number" && Number.isFinite(child) && child > 0);
        invalid ||= child !== false && child !== 0
          && !(child === true || (typeof child === "number" && Number.isFinite(child) && child > 0));
        out[key] = false;
      } else if (key === "executableNowCount") {
        observed ||= child === true || (typeof child === "number" && Number.isFinite(child) && child > 0);
        invalid ||= child !== 0
          && !(child === true || (typeof child === "number" && Number.isFinite(child) && child > 0));
        out[key] = 0;
      } else {
        const nested = visit(child);
        out[key] = nested.value;
        observed ||= nested.observed;
        invalid ||= nested.invalid;
      }
    }
    observed ||= out.observedUpstreamAuthorizationSignal === true;
    invalid ||= out.invalidUpstreamAuthorizationSignal === true;
    if (observed) out.observedUpstreamAuthorizationSignal = true;
    if (invalid) out.invalidUpstreamAuthorizationSignal = true;
    if (invalid || out.hardStop === true || (observed && out.authorizationState !== "VALID")) out.hardStop = true;
    return { value: out, observed, invalid };
  }

  return visit(value).value;
}

function rankCandidate(candidate) {
  const routePositive = asNumber(candidate.routePositive) || 0;
  const status = String(candidate.status || "");
  return {
    ...candidate,
    priorityScore: Math.round(clamp(candidate.priorityScore, 0, 100)),
    routePositive,
    executableNow: false,
    signedActionJustified: false,
    forkGate: candidate.forkGate || (routePositive > 0
      ? status.includes("fork-positive") ? "fork-positive-needs-live-preflight" : "route-positive-needs-fork-proof"
      : "closed-route-positive-zero"),
  };
}

function aaveV4Candidate(hubs = {}, borrowers = {}, quotes = {}, shadowQuotes = {}, stablePairProbe = {}, oracleInfluence = {}) {
  const hubSummary = hubs?.summary || {};
  const borrowerSummary = borrowers?.summary || {};
  const quoteSummary = quotes?.summary || {};
  const shadowSummary = shadowQuotes?.summary || {};
  const stablePairSummary = stablePairProbe?.summary || {};
  const oracleSummary = oracleInfluence?.summary || {};
  const stablePairPlan = stablePairProbe?.collateralFlashPlan || null;
  const stableCollateralFlashResearchPositive = Boolean(stablePairSummary.collateralFlashResearchPositive || stablePairPlan?.researchPositive);
  const oracleInfluenceClosed = Boolean(
    oracleInfluence?.generatedAt
    && !oracleSummary.permissionlessOracleInfluence
    && /conditional-only|no-permissionless/.test(String(oracleSummary.verdict || ""))
  );
  const users = [];
  for (const spoke of borrowers?.spokes || []) {
    for (const user of spoke.topUsers || []) {
      const reserves = Array.isArray(user.reserves) ? user.reserves : [];
      const debts = reserves
        .filter((r) => r.borrowing && (asNumber(r.debtUsd) || 0) > 0)
        .sort((a, b) => (asNumber(b.debtUsd) || 0) - (asNumber(a.debtUsd) || 0));
      const collateral = reserves
        .filter((r) => r.usingAsCollateral && (asNumber(r.suppliedUsd) || 0) > 0)
        .sort((a, b) => (asNumber(b.suppliedUsd) || 0) - (asNumber(a.suppliedUsd) || 0));
      const healthFactor = asNumber(user.account?.healthFactor);
      const debtUsd = sum(debts, (r) => r.debtUsd);
      const collateralUsd = sum(collateral, (r) => r.suppliedUsd);
      if (debtUsd <= 0 || healthFactor === null) continue;
      const bestCollateral = collateral[0] || null;
      const bestDebt = debts[0] || null;
      const maxBonusBps = Math.max(0, ...collateral.map((r) => asNumber(r.dynamicConfig?.maxLiquidationBonusBps) || 0));
      const bonusBps = Math.max(0, maxBonusBps - 10_000);
      const bpsToLiquidation = Math.max(0, healthFactor - 1) * 10_000;
      const potentialGrossBonusUsd = Math.min(debtUsd, collateralUsd) * bonusBps / 10_000;
      const proximityScore = clamp(1 - (bpsToLiquidation / 1_000), 0, 1);
      const profitPriorityScore = Math.round(
        proximityScore * 45
        + clamp(potentialGrossBonusUsd / 1_000, 0, 1) * 35
        + clamp(debtUsd / 50_000, 0, 1) * 20
        + (healthFactor < 1 ? 25 : 0)
        - (debtUsd < 1_000 ? 35 : 0)
      );
      users.push({
        hub: spoke.hub,
        spoke: spoke.spoke,
        user: user.user,
        healthFactor: round(healthFactor, 6),
        bpsToLiquidation: round(bpsToLiquidation, 2),
        debtUsd: round(debtUsd, 2),
        collateralUsd: round(collateralUsd, 2),
        topDebt: bestDebt ? { symbol: bestDebt.symbol, debtUsd: round(bestDebt.debtUsd, 2), priceVsReferenceBps: round(bestDebt.oracleData?.priceVsReferenceBps, 2) } : null,
        topCollateral: bestCollateral ? { symbol: bestCollateral.symbol, suppliedUsd: round(bestCollateral.suppliedUsd, 2), priceVsReferenceBps: round(bestCollateral.oracleData?.priceVsReferenceBps, 2), maxLiquidationBonusBps: maxBonusBps || null } : null,
        potentialGrossBonusUsd: round(potentialGrossBonusUsd, 2),
        estimatedGrossBonusUsd: healthFactor < 1 ? round(potentialGrossBonusUsd, 2) : 0,
        materialDebt: debtUsd >= 1_000,
        profitPriorityScore,
      });
    }
  }

  const closestRows = users.slice().sort((a, b) => (a.bpsToLiquidation - b.bpsToLiquidation) || (b.debtUsd - a.debtUsd));
  const profitRankedRows = users.slice().sort((a, b) => {
    const ar = asNumber(a.profitPriorityScore) ?? -Infinity;
    const br = asNumber(b.profitPriorityScore) ?? -Infinity;
    return br - ar
      || (asNumber(b.potentialGrossBonusUsd) || 0) - (asNumber(a.potentialGrossBonusUsd) || 0)
      || (asNumber(a.bpsToLiquidation) ?? Infinity) - (asNumber(b.bpsToLiquidation) ?? Infinity);
  });
  const materialRows = profitRankedRows.filter((u) => u.materialDebt);
  const best = materialRows[0] || profitRankedRows[0] || null;
  const closest = closestRows[0] || null;
  const bestBps = asNumber(best?.bpsToLiquidation) ?? 10_000;
  const closestBps = asNumber(closest?.bpsToLiquidation) ?? 10_000;
  const nearLiquidation = asNumber(borrowerSummary.nearLiquidation) || users.filter((u) => (asNumber(u.bpsToLiquidation) ?? Infinity) <= 500).length;
  const materialNearLiquidation = materialRows.filter((u) => (asNumber(u.bpsToLiquidation) ?? Infinity) <= 500).length;
  const liquidatable = asNumber(borrowerSummary.liquidatable) || users.filter((u) => (asNumber(u.healthFactor) || 2) < 1).length;
  const quoteRequiredRows = asNumber(quoteSummary.quoteRequiredRows) || 0;
  const rowsQuoted = asNumber(quoteSummary.rowsQuoted) || 0;
  const shadowRowsQuoted = asNumber(shadowSummary.shadowRowsQuoted) || 0;
  const shadowResearchPositiveRoutes = asNumber(shadowSummary.shadowResearchPositiveRoutes) || 0;
  const shadowBestNetProfitUsd = asNumber(shadowSummary.bestNetProfitUsd);
  const shadowClosestBestNetProfitUsd = asNumber(shadowSummary.closestBestNetProfitUsd);
  const materialLiquidatable = materialRows.filter((u) => (asNumber(u.healthFactor) || 2) < 1).length;
  const dustLiquidatable = Math.max(0, liquidatable - materialLiquidatable);
  const routePositive = routePositiveCount(hubSummary.routePositive, borrowerSummary.routePositive, quoteSummary.routePositive);
  const priorityScore = 62
    + clamp(1 - (bestBps / 1_000), 0, 1) * 12
    + clamp((asNumber(best?.potentialGrossBonusUsd) || 0) / 1_000, 0, 1) * 10
    + clamp(materialNearLiquidation / 3, 0, 1) * 6
    + clamp(Math.max(quoteRequiredRows, materialLiquidatable) / 2, 0, 1) * 8
    + clamp((asNumber(borrowerSummary.activeBorrowers) || 0) / 60, 0, 1) * 4
    + (stableCollateralFlashResearchPositive ? 5 : 0)
    + (routePositive > 0 ? 20 : 0);
  const status = routePositive > 0
    ? "route-positive-needs-fork-proof"
    : quoteRequiredRows > 0 || materialLiquidatable > 0
      ? "liquidatable-needs-exact-quotes"
      : liquidatable > 0
        ? "dust-liquidatable-no-route"
        : stableCollateralFlashResearchPositive
          ? oracleInfluenceClosed ? "stable-pair-conditional-only-no-oracle-influence" : "stable-pair-flash-route-pretrigger-watch"
          : nearLiquidation > 0
          ? "near-liquidation-watch"
          : "mapped-no-liquidatable-user";

  return rankCandidate({
    id: "aave-v4-near-liquidation-sweep",
    protocol: "Aave V4",
    chain: "Ethereum",
    surface: "Aave V4 decoded spoke borrower liquidation/oracle routes",
    status,
    priorityScore,
    routePositive,
    distance: {
      bestHealthFactor: round(best?.healthFactor, 6) ?? round(borrowerSummary.bestHealthFactor, 6),
      bestBpsToLiquidation: round(bestBps, 2),
      closestHealthFactor: round(closest?.healthFactor, 6) ?? round(borrowerSummary.bestHealthFactor, 6),
      closestBpsToLiquidation: round(closestBps, 2),
      closestDebtUsd: round(closest?.debtUsd, 2),
      activeBorrowers: asNumber(borrowerSummary.activeBorrowers) || 0,
      nearLiquidation,
      materialNearLiquidation,
      materialRows: materialRows.length,
      liquidatable,
      materialLiquidatable,
      dustLiquidatable,
      borrowerRowsRanked: users.length,
      quoteRequiredRows,
      rowsQuoted,
      researchPositiveQuoteRoutes: asNumber(quoteSummary.researchPositiveRoutes) || 0,
      shadowRowsQuoted,
      shadowResearchPositiveRoutes,
      stablePairRouteRows: asNumber(stablePairSummary.routeRows) || 0,
      stablePairCollateralFlashResearchPositive: stableCollateralFlashResearchPositive ? 1 : 0,
    },
    economics: {
      totalOwedUsd: round(hubSummary.totalOwedUsd, 2),
      totalCashUsd: round(hubSummary.totalCashUsd, 2),
      bestDebtUsd: round(best?.debtUsd, 2),
      bestCollateralUsd: round(best?.collateralUsd, 2),
      bestPotentialGrossBonusUsd: round(best?.potentialGrossBonusUsd, 2),
      maxGrossBonusUsd: round(borrowerSummary.maxGrossBonusUsd, 2),
      quoteGasUsd: round(quotes?.gas?.gasUsd, 2),
      shadowBestNetProfitUsd: round(shadowBestNetProfitUsd, 2),
      shadowBestPair: shadowSummary.bestPair || null,
      shadowBestRepayUsd: round(shadowSummary.bestRepayUsd, 2),
      shadowClosestBestNetProfitUsd: round(shadowClosestBestNetProfitUsd, 2),
      shadowClosestBestPair: shadowSummary.closestBestPair || null,
      shadowClosestBestSource: shadowSummary.closestBestSource || null,
      shadowClosestBestPathKind: shadowSummary.closestBestPathKind || null,
      shadowClosestBestFraction: round(shadowSummary.closestBestFraction, 4),
      stablePairBestNetProfitUsd: round(stablePairSummary.bestNetProfitUsd, 2),
      stablePairCollateralFlashNetUsd: round(stablePairSummary.collateralFlashNetUsd, 2),
      stablePairBestSource: stablePairSummary.bestSource || null,
      stablePairBestPathKind: stablePairSummary.bestPathKind || null,
      stablePairDebtFlashSufficient: stablePairSummary.flashSufficientForProbe ?? null,
      stablePairCollateralFlashSufficient: stablePairSummary.collateralFlashSufficientForProbe ?? null,
      oracleInfluenceVerdict: oracleSummary.verdict || null,
      oraclePermissionlessInfluence: Boolean(oracleSummary.permissionlessOracleInfluence),
      oracleCollateralDropBpsToLiquidation: round(oracleSummary.collateralDropBpsToLiquidation, 2),
      oracleDebtIncreaseBpsToLiquidation: round(oracleSummary.debtPriceIncreaseBpsToLiquidation, 2),
    },
    topRows: (materialRows.length ? materialRows : profitRankedRows).slice(0, 5),
    closestRows: closestRows.slice(0, 5),
    blockers: routePositive > 0
      ? ["Needs fork extraction proof before any signed action"]
      : quoteRequiredRows > 0 || materialLiquidatable > 0
        ? [quoteSummary.blocker || "Aave V4 quote artifact is not route-positive", "No fork-positive extraction proof"]
      : liquidatable > 0
        ? ["Only liquidatable Aave V4 rows are dust below the material debt gate", "No quote-required material liquidation row", "No fork-positive extraction proof"]
        : [
          "No currently liquidatable Aave V4 spoke borrower",
          closest && (asNumber(closest.debtUsd) || 0) < 1_000 ? "Closest HF rows are dust below the material debt gate" : "Best material borrower still above HF 1.0",
          stableCollateralFlashResearchPositive
            ? oracleInfluenceClosed
              ? "Stable-pair USDC-flash route is positive in shadow mode, but the oracle influence probe found no permissionless same-tx HF push; borrower must organically cross HF < 1 before fork/executor work"
              : "Stable-pair USDC-flash route is positive in shadow mode, but borrower must cross HF < 1 and a flash-token != debt-token fork proof is still required"
            : shadowRowsQuoted > 0
            ? shadowResearchPositiveRoutes > 0
              ? "Shadow quote is positive but pre-trigger only; borrower must cross HF < 1 and fork proof is still required"
              : "Shadow quote exists but is not net positive after gas/slippage"
            : "No pre-trigger shadow quote artifact yet",
        ],
    requiredForRoutePositive: ["HF below 1.0 or oracle-drift route with decoded debt/collateral", "exact repay-token acquisition quote", "exact collateral-exit quote", "gas/slippage-adjusted net positive", "fork extraction proof", "for flash-token != debt-token routes: pre-liquidation swap staticCall/estimateGas and minOut/minProfit gates"],
    nextReadOnlyStep: shadowRowsQuoted > 0
      ? stableCollateralFlashResearchPositive
        ? oracleInfluenceClosed
          ? "Keep Aave V4 watcher-only; do not build the flash-token != debt-token executor unless HF crosses below 1 or a new permissionless oracle influence proof appears."
          : "Keep the Aave watcher running; if HF crosses below 1, fork-proof the USDC-flash -> Curve USDC/FRAX/frxUSD -> Aave liquidation -> USDC repay flow before any signed action."
        : "Keep the Aave watcher running; if HF crosses below 1, re-run exact trigger quotes/staticCall and fork-proof the same pair before any signed action."
      : "Refresh the Aave V4 borrower scan and exact-quote only if a top borrower crosses HF < 1 or oracle drift makes a concrete pair route-positive.",
    sourceArtifacts: ["reports/raw/fast/aave-v4-hubs.json", "reports/raw/fast/aave-v4-spoke-borrowers.json", "reports/raw/fast/aave-v4-liquidation-quotes.json", "reports/raw/fast/aave-v4-liquidation-shadow-quotes.json", "reports/raw/fast/aave-v4-stable-pair-route-probe.json", "reports/raw/fast/aave-v4-oracle-influence-proof.json"],
  });
}

function aaveV3Candidate(artifact = {}, readiness = {}) {
  const summary = artifact?.summary || {};
  const readinessSummary = readiness?.summary || {};
  const hasReadiness = Boolean(readiness?.generatedAt);
  const rows = Array.isArray(artifact?.globalTopRows) ? artifact.globalTopRows : [];
  const best = rows[0] || null;
  const bestEcon = best?.economics || {};
  const routePositive = routePositiveCount(summary.routePositive, summary.exactEconomicsRows);
  const watchCandidates = asNumber(summary.watchCandidates) || 0;
  const currentLiquidatable = asNumber(summary.currentLiquidatable) || 0;
  const materialLiquidatable = asNumber(summary.materialLiquidatable) || 0;
  const exactEconomicsRows = asNumber(summary.exactEconomicsRows) || 0;
  const rowsWithAnyQuote = asNumber(summary.rowsWithAnyQuote) || 0;
  const bestBps = asNumber(summary.bestBpsToLiquidation) ?? asNumber(best?.bpsToLiquidation) ?? 10_000;
  const triggerReady = readinessSummary.triggerReady === true;
  const exactEconomicsReady = readinessSummary.exactEconomicsReady === true;
  const sourceAbiReady = readinessSummary.sourceAbiReady === true;
  const monitorMathReady = readinessSummary.monitorMathReady === true;
  const deployedSelectorReady = readinessSummary.deployedSelectorReady === true;
  const flashLiquidityReady = readinessSummary.flashLiquidityReady === true;
  const forkProofReady = readinessSummary.forkProofReady === true;
  const liveExecutorReady = readinessSummary.liveExecutorReady === true;
  const priorityScore = 50
    + clamp(1 - (Math.max(0, bestBps) / 1_000), 0, 1) * 18
    + clamp((asNumber(summary.bestDebtUsd) || 0) / 1_000_000, 0, 1) * 10
    + clamp(watchCandidates / 4, 0, 1) * 8
    + clamp(materialLiquidatable / 2, 0, 1) * 12
    + (routePositive > 0 ? 25 : 0);
  const status = routePositive > 0
    ? "route-positive-needs-fork-proof"
    : materialLiquidatable > 0
      ? "liquidatable-needs-exact-quotes-and-fork"
      : currentLiquidatable > 0
        ? "dust-liquidatable-needs-route"
        : watchCandidates > 0
          ? hasReadiness && !liveExecutorReady ? "near-liquidation-watch-executor-blocked" : "near-liquidation-watch"
          : "mapped-no-near-liquidation";

  const baseBlockers = routePositive > 0
    ? ["Needs fork extraction proof before any signed action"]
    : materialLiquidatable > 0
      ? ["Aave V3 borrower is liquidatable, but exact repay acquisition and collateral-exit quotes are missing", "No fork extraction proof", "Signed action remains fail-closed"]
      : watchCandidates > 0
        ? ["Closest Aave V3 borrower remains above HF 1.0", "Shadow liquidation bonus is pre-trigger only and not an executable route", "No exact quote, staticCall, gas, minOut/minProfit, or fork proof"]
        : ["No Aave V3 borrower in the scan is within the HF watch band", "No exact quote or fork-positive liquidation route"];
  const readinessBlockers = hasReadiness
    ? [
        triggerReady ? null : "Aave V3 trigger-readiness audit: HF remains above 1.0",
        exactEconomicsReady ? null : "Aave V3 trigger-readiness audit: exact repay/acquisition and collateral-exit economics are missing",
        deployedSelectorReady ? null : "Aave V3 trigger-readiness audit: configured deployed liquidator does not prove the Aave V3 liquidationCall selector",
        forkProofReady ? null : "Aave V3 trigger-readiness audit: no fresh fork/staticCall/estimateGas proof",
      ].filter(Boolean)
    : [];
  const blockers = [...new Set([...baseBlockers, ...readinessBlockers])];

  return rankCandidate({
    id: "aave-v3-route-distance-sweep",
    protocol: "Aave V3",
    chain: "Ethereum/Base/Arbitrum/Optimism/Polygon/Avalanche/Gnosis/Scroll/BSC",
    surface: "Aave V3 multichain borrower liquidation route-distance",
    status,
    priorityScore,
    routePositive,
    distance: {
      watchCandidates,
      currentLiquidatable,
      materialLiquidatable,
      exactEconomicsRows,
      rowsWithAnyQuote,
      shadowPositiveRows: asNumber(summary.shadowPositiveRows) || 0,
      borrowersDiscovered: asNumber(summary.borrowersDiscovered) || 0,
      accountDataChecked: asNumber(summary.accountDataChecked) || 0,
      rowsPassingDebtGate: asNumber(summary.rowsPassingDebtGate) || 0,
      bestHealthFactor: round(summary.bestHealthFactor ?? best?.healthFactor, 6),
      bestBpsToLiquidation: round(bestBps, 2),
      chainsScanned: asNumber(summary.chainsScanned) || 0,
      readiness: hasReadiness ? {
        status: readinessSummary.status || null,
        triggerReady,
        exactEconomicsReady,
        sourceAbiReady,
        monitorMathReady,
        deployedSelectorReady,
        flashLiquidityReady,
        forkProofReady,
        liveExecutorReady,
        findingCount: asNumber(readinessSummary.findingCount) || 0,
        liveHealthFactor: round(readinessSummary.currentHealthFactor, 9),
        liveBpsToLiquidation: round(readinessSummary.bpsToLiquidation, 2),
      } : null,
    },
    economics: {
      bestDebtUsd: round(summary.bestDebtUsd ?? best?.totalDebtUsd, 2),
      bestCollateralUsd: round(best?.totalCollateralUsd, 2),
      bestGrossBonusUsd: round(bestEcon.grossBonusUsd, 2),
      bestPretriggerShadowNetUsd: round(summary.bestShadowNetUsd, 2),
      bestRepayUsd: round(bestEcon.repayUsd, 2),
      exactQuoteRows: exactEconomicsRows,
    },
    topRows: rows.slice(0, 5).map((row) => ({
      chain: row.chain,
      user: row.user,
      status: row.status,
      healthFactor: round(row.healthFactor, 6),
      bpsToLiquidation: round(row.bpsToLiquidation, 2),
      totalDebtUsd: round(row.totalDebtUsd, 2),
      topDebt: row.topDebt ? { symbol: row.topDebt.symbol, usd: round(row.topDebt.usd, 2), flashLoanEnabled: row.topDebt.flashLoanEnabled, paused: row.topDebt.paused } : null,
      topCollateral: row.topCollateral ? { symbol: row.topCollateral.symbol, usd: round(row.topCollateral.usd, 2), bonusBps: row.topCollateral.bonusBps, paused: row.topCollateral.paused } : null,
      shadowNetUsd: round(row.economics?.shadowNetUsd, 2),
      routePositive: asNumber(row.routePositive) || 0,
    })),
    blockers,
    requiredForRoutePositive: ["current HF < 1.0 for a material borrower", "decoded debt/collateral pair", "exact repay-token acquisition quote", "exact seized-collateral exit quote", "gas/slippage/flash-fee adjusted net profit > 0", "fork/static proof"],
    requiredForSignedAction: ["explicit authorization", "fresh HF/staticCall/estimateGas", "verified executor or direct calldata", "minProfit/minOut gates"],
    nextReadOnlyStep: materialLiquidatable > 0
      ? "Run exact repay-token and seized-collateral exit quotes for the liquidatable Aave V3 row, then fork-proof before any signed action."
      : watchCandidates > 0
        ? "Keep the Aave V3 route-distance scanner on watch; exact-quote only after HF crosses below 1.0 or a row gains a permissionless oracle influence proof."
        : "Refresh Aave V3 borrower discovery periodically; no executor or fork work until HF < 1 and exact economics are positive.",
    sourceArtifacts: ["reports/raw/fast/aave-v3-route-distance.json", ...(hasReadiness ? ["reports/raw/fast/aave-v3-trigger-readiness.json"] : [])],
  });
}

function hyperlendCandidate(artifact = {}) {
  const summary = artifact?.summary || {};
  const minStaleSeconds = asNumber(artifact?.gates?.minStaleSeconds) || 3600;
  const minRouteLiquidityUsd = asNumber(artifact?.gates?.minRouteLiquidityUsd) || 10_000;
  const rows = (artifact?.watchRows || []).map((row) => {
    const age = asNumber(row.oracleFeedAgeSeconds) || 0;
    const div = Math.abs(asNumber(row.oracleVsRefPct) || 0);
    const threshold = asNumber(row.minDivergencePct) || (row.kind === "stable" ? 1 : 5);
    const routeLiquidityUsd = asNumber(row.route?.routeLiquidityUsd ?? row.cashUsd) || 0;
    return {
      symbol: row.symbol,
      kind: row.kind,
      direction: row.route?.direction || null,
      staleAccepted: Boolean(row.staleAccepted),
      feedAgeSeconds: round(age, 0),
      secondsToStaleGate: round(Math.max(0, minStaleSeconds - age), 0),
      divergencePct: round(row.oracleVsRefPct, 4),
      absDivergencePct: round(div, 4),
      minDivergencePct: threshold,
      divergenceMissingPct: round(Math.max(0, threshold - div), 4),
      routeLiquidityUsd: round(routeLiquidityUsd, 2),
      estimatedGrossEdgeUsd: round(row.route?.estimatedGrossEdgeUsd, 2),
      routePositive: Boolean(row.routePositive),
      watchCandidate: Boolean(row.watchCandidate),
    };
  });
  rows.sort((a, b) => {
    const aScore = (a.staleAccepted ? 1 : 0) * 25 + clamp((a.absDivergencePct || 0) / (a.minDivergencePct || 1), 0, 1) * 50 + clamp((a.routeLiquidityUsd || 0) / minRouteLiquidityUsd, 0, 1) * 10;
    const bScore = (b.staleAccepted ? 1 : 0) * 25 + clamp((b.absDivergencePct || 0) / (b.minDivergencePct || 1), 0, 1) * 50 + clamp((b.routeLiquidityUsd || 0) / minRouteLiquidityUsd, 0, 1) * 10;
    return bScore - aScore;
  });
  const best = rows[0] || null;
  const routePositive = routePositiveCount(summary.routePositive, rows.filter((r) => r.routePositive).length);
  const priorityScore = 52
    + (best?.staleAccepted ? 8 : 0)
    + clamp((best?.absDivergencePct || 0) / (best?.minDivergencePct || 1), 0, 1) * 18
    + clamp((best?.routeLiquidityUsd || 0) / minRouteLiquidityUsd, 0, 1) * 6
    + (routePositive > 0 ? 20 : 0);

  return rankCandidate({
    id: "hyperlend-stale-source-sweep",
    protocol: "HyperLend",
    chain: "HyperEVM",
    surface: "Stale-source borrow/collateral route distance",
    status: routePositive > 0 ? "route-positive-needs-fork-proof" : (asNumber(summary.watchCandidates) || 0) > 0 ? "watch-candidate-no-fork-proof" : "stale-but-divergence-below-route-gate",
    priorityScore,
    routePositive,
    distance: {
      staleAcceptedRows: summary.staleAcceptedRows || rows.filter((r) => r.staleAccepted).length,
      materialDivergenceRows: summary.materialDivergenceRows || 0,
      bestSymbol: best?.symbol || null,
      bestDivergenceMissingPct: round(best?.divergenceMissingPct, 4),
      bestSecondsToStaleGate: round(best?.secondsToStaleGate, 0),
      minRouteLiquidityUsd,
    },
    economics: {
      bestRouteLiquidityUsd: round(best?.routeLiquidityUsd, 2),
      bestEstimatedGrossEdgeUsd: round(best?.estimatedGrossEdgeUsd, 2),
    },
    topRows: rows.slice(0, 5),
    blockers: routePositive > 0
      ? ["Needs HyperEVM fork extraction proof before live action"]
      : ["Divergence below per-asset route gate", "No fresh executable route quote with gas/slippage/minProfit checks"],
    requiredForRoutePositive: ["stale accepted source", "material accepted-vs-reference divergence", "borrow/collateral liquidity above threshold", "fresh executable route quote with gas/slippage/minProfit checks"],
    requiredForSignedAction: ["HyperEVM fork extraction proof", "deployed verified executor/staticCall/gas/minProfit gate", "explicit operator authorization"],
    nextReadOnlyStep: "Re-score stale rows when any accepted source crosses its divergence gate or routeCandidates becomes nonzero.",
    sourceArtifacts: ["reports/raw/fast/hyperlend-stale-source-routes.json"],
  });
}

function venusBaseCandidate(artifact = {}) {
  const summary = artifact?.summary || {};
  const thresholds = artifact?.thresholds || {};
  const assessment = artifact?.assessment || {};
  const minRouteLiquidityUsd = asNumber(thresholds.minRouteLiquidityUsd) || 10_000;
  const minOvervaluedCollateralPct = asNumber(thresholds.minOvervaluedCollateralPct) || 30;
  const minUnderpricedBorrowPct = asNumber(thresholds.minUnderpricedBorrowPct) || 5;
  const divergence = Math.abs(asNumber(summary.divergencePct) || 0);
  const feedAge = asNumber(summary.feedAgeSeconds) || 0;
  const maxStale = asNumber(summary.maxStaleSeconds) || 93_600;
  const routeLiquidity = asNumber(summary.bestBorrowRouteLiquidityUsd) || 0;
  const routes = (assessment.routes || []).map((row) => ({
    direction: row.direction,
    collateralSymbol: row.collateralSymbol || null,
    borrowSymbol: row.borrowSymbol || row.bestBorrowRoute || null,
    grossEdgePct: round(row.grossEdgePct ?? row.edgePct, 4),
    breakEvenDivergencePct: round(row.breakEvenDivergencePct, 4),
    routeLiquidityUsd: round(row.routeLiquidityUsd ?? routeLiquidity, 2),
    researchPositive: Boolean(row.researchPositive),
    routePositive: Boolean(row.routePositive),
  }));
  const routePositive = routePositiveCount(summary.routePositive, assessment.routePositive, routes.filter((r) => r.routePositive).length);
  const overvaluedMissing = Math.max(0, minOvervaluedCollateralPct - divergence);
  const underpricedMissing = Math.max(0, minUnderpricedBorrowPct - divergence);
  const priorityScore = 42
    + clamp(feedAge / maxStale, 0, 1) * 7
    + clamp(routeLiquidity / minRouteLiquidityUsd, 0, 1) * 6
    + clamp(divergence / minOvervaluedCollateralPct, 0, 1) * 18
    + (routePositive > 0 ? 20 : 0);

  return rankCandidate({
    id: "venus-base-wsteth-sweep",
    protocol: "Venus",
    chain: "Base",
    surface: "Venus Base wstETH stale-ratio borrow route distance",
    status: routePositive > 0 ? "route-positive-needs-fork-proof" : summary.classification || assessment.classification || "stale-but-no-route",
    priorityScore,
    routePositive,
    distance: {
      feedAgeSeconds: round(feedAge, 0),
      feedAgePctOfMax: round(summary.pctOfMax, 2),
      divergencePct: round(summary.divergencePct, 4),
      overvaluedCollateralMissingPct: round(overvaluedMissing, 4),
      underpricedBorrowMissingPct: round(underpricedMissing, 4),
      routeLiquidityMissingUsd: round(Math.max(0, minRouteLiquidityUsd - routeLiquidity), 2),
    },
    economics: {
      collateralFactor: summary.collateralFactor ?? null,
      bestBorrowRoute: summary.bestBorrowRoute || null,
      bestBorrowRouteLiquidityUsd: round(routeLiquidity, 2),
      wstethBorrowLiquidityUsd: round(summary.wstethBorrowLiquidityUsd, 2),
    },
    topRows: routes,
    blockers: routePositive > 0
      ? ["Needs Base fork extraction proof before any live action"]
      : [...new Set(assessment.blockers || ["Ratio divergence below route threshold", "Borrow route below liquidity/cap/pause gate", "No fork-positive extraction proof"])],
    requiredForRoutePositive: ["nonzero wstETH ratio divergence above route gate", "borrow-side route liquidity above threshold", "unpaused/cap-available path", "gas-adjusted positive borrow route", "fork extraction proof"],
    nextReadOnlyStep: "Watch for wstETH ratio divergence plus Base borrow liquidity; fork only if exact route economics turn positive.",
    sourceArtifacts: ["reports/raw/fast/venus-base-wsteth-routes.json"],
  });
}

function lorenzoCandidate(artifact = {}, sameEpochProbe = {}) {
  const thresholdBps = 75;
  const artifactSummary = artifact?.summary || {};
  const sameEpochSummary = sameEpochProbe?.summary || {};
  const rows = [];
  const inverseRows = [];
  for (const chain of artifact?.result || []) {
    for (const pool of chain.dexPools || []) {
      const navDiffBps = asNumber(pool.navDiffBps);
      const susdLower = String(chain.contract?.address || "").toLowerCase();
      const token0IsSusd = String(pool.token0?.address || "").toLowerCase() === susdLower;
      const stableLiquidity = asNumber(pool.balances?.[token0IsSusd ? 1 : 0]?.formatted) || 0;
      rows.push({
        chain: chain.chain,
        chainId: chain.chainId,
        pool: pool.name,
        address: pool.address,
        nav: round(chain.views?.currentUnitNav?.formatted18, 8),
        quotePerShare: round(pool.quotePerSusd1Plus, 8),
        navDiffBps: round(navDiffBps, 2),
        thresholdBps,
        spreadMissingBps: round(Math.max(0, thresholdBps - (navDiffBps || 0)), 2),
        stableLiquidityUsd: round(stableLiquidity, 2),
        transferable: chain.views?.transferable ?? null,
        paused: chain.views?.paused ?? null,
      });
    }
    for (const quote of chain.inverseRoute?.topExactBuyQuotes || []) {
      inverseRows.push({
        chain: chain.chain,
        chainId: chain.chainId,
        pool: quote.pool,
        stableSymbol: quote.stableSymbol,
        stableIn: round(quote.stableIn, 2),
        amountOutSusd1Plus: round(quote.amountOutSusd1Plus, 6),
        navExitValue: round(quote.navExitValue, 6),
        grossEdgeUsd: round(quote.grossEdgeUsd, 6),
        grossEdgeBps: round(quote.grossEdgeBps, 2),
        sameEpochPublicExitProven: Boolean(chain.inverseRoute?.sameEpochPublicExitProven),
      });
    }
  }
  rows.sort((a, b) => (b.navDiffBps - a.navDiffBps) || (b.stableLiquidityUsd - a.stableLiquidityUsd));
  inverseRows.sort((a, b) => (b.grossEdgeBps - a.grossEdgeBps) || (b.grossEdgeUsd - a.grossEdgeUsd));
  const best = rows[0] || null;
  const bestInverse = inverseRows[0] || null;
  const routePositive = asNumber(artifactSummary.routePositive) || 0;
  const bestSpread = asNumber(best?.navDiffBps) || 0;
  const bestLiquidity = asNumber(best?.stableLiquidityUsd) || 0;
  const bestInverseGrossBps = asNumber(bestInverse?.grossEdgeBps) || 0;
  const priorityScore = 47
    + clamp(bestSpread / thresholdBps, 0, 1) * 18
    + clamp(bestInverseGrossBps / 100, 0, 1) * 8
    + clamp(bestLiquidity / 5_000, 0, 1) * 6
    + (routePositive > 0 ? 20 : 0);
  const inverseBlockers = [];
  for (const chain of artifact?.result || []) {
    for (const blocker of chain.inverseRoute?.blockers || []) inverseBlockers.push(blocker);
  }

  return rankCandidate({
    id: "lorenzo-susd1plus-premium-sweep",
    protocol: "Lorenzo sUSD1+",
    chain: "Ethereum/BNB",
    surface: "sUSD1+ DEX premium and inverse NAV-exit route distance",
    status: routePositive > 0 ? "route-positive-needs-fork-proof" : bestInverseGrossBps > 0 ? "inverse-gross-positive-exit-blocked" : "dormant-spread-too-small",
    priorityScore,
    routePositive,
    distance: {
      bestChain: best?.chain || null,
      bestNavDiffBps: round(bestSpread, 2),
      thresholdBps,
      spreadMissingBps: round(Math.max(0, thresholdBps - bestSpread), 2),
      poolsRanked: rows.length,
      exactInverseBuyQuotes: asNumber(artifactSummary.exactBuyQuotes) || inverseRows.length,
      bestInverseGrossEdgeBps: round(bestInverseGrossBps, 2),
      sameEpochPublicExitProven: Boolean(artifactSummary.sameEpochPublicExitProven || sameEpochSummary.sameEpochPublicExitProven),
      sameEpochProbeChains: asNumber(sameEpochSummary.chainsScanned) || 0,
    },
    economics: {
      bestQuotePerShare: round(best?.quotePerShare, 8),
      bestNav: round(best?.nav, 8),
      bestStableLiquidityUsd: round(bestLiquidity, 2),
      bestInverseGrossEdgeUsd: round(bestInverse?.grossEdgeUsd, 6),
      bestInverseStableIn: round(bestInverse?.stableIn, 2),
    },
    topRows: rows.slice(0, 5),
    inverseTopRows: inverseRows.slice(0, 8),
    blockers: routePositive > 0
      ? ["Needs fork extraction proof before any signed action"]
      : [...new Set([artifactSummary.blocker, sameEpochSummary.blocker, ...inverseBlockers, "DEX premium below execution-review threshold", "No fork-positive supply-sell or buy-redeem proof"].filter(Boolean))],
    requiredForRoutePositive: ["DEX premium above NAV plus fees/slippage/gas or exact inverse buy quote with positive net", "stable liquidity above threshold", "vault unpaused and transferable", "public same-epoch NAV exit proven for inverse route", "fork extraction proof"],
    nextReadOnlyStep: bestInverseGrossBps > 0 ? "Prove or rule out a public same-epoch NAV exit path; keep routePositive=0 while withdrawal remains queued/cash-blocked." : "Keep NAV and Pancake/DEX quotes on watch; fork only if exact route economics and exit semantics become positive.",
    sourceArtifacts: ["reports/raw/fast/lorenzo-susd1plus-live.json", "reports/raw/fast/lorenzo-same-epoch-exit-probe.json"],
  });
}

function lorenzoStep6AccountingCandidate(artifact = {}) {
  const gates = artifact.gates || {};
  const accounting = artifact.accounting || {};
  const historical = artifact.historical || {};
  const economics = artifact.economics100Usd1 || {};
  const reset = artifact.stateMachine?.resetBoundary || {};
  const routePositive = gates.routePositive === true ? 1 : 0;
  return rankCandidate({
    id: "lorenzo-susd1plus-step6-accounting-sweep",
    protocol: "Lorenzo sUSD1+",
    chain: "BNB Chain",
    surface: "Stale-NAV supply, withdrawal-request, manager settlement, and claim accounting",
    status: routePositive > 0 ? "route-positive-needs-fork-proof" : "watch-no-locked-exit-edge",
    priorityScore: 42,
    routePositive,
    forkGate: "blocked-future-nav-timing-payout-and-net-null",
    historicalCoverageComplete: historical.periodHistoryComplete === true && historical.deploymentToPinComplete === true,
    closureEligible: false,
    sourceRuntimeEquivalence: artifact.sourceBinding?.sourceRuntimeEquivalence ?? null,
    supersedesRouteIds: ["lorenzo-susd1plus-premium-sweep", "lorenzo-susd1plus-route-refresh-sweep"],
    distance: {
      watchCandidates: economics.directionalExposure === true ? 1 : 0,
      researchRows: Array.isArray(historical.exactFiveEventSequence) ? historical.exactFiveEventSequence.length : 0,
      quoteRows: economics.dexQuoteSharesRaw ? 1 : 0,
      fixedBlock: artifact.pin?.blockNumber ?? null,
      fixedBlockHash: artifact.pin?.blockHash ?? null,
      currentPeriod: accounting.currentPeriod ?? null,
      currentLastSettledNavRaw: accounting.currentLastSettledNavRaw ?? null,
      reportedSupplyExcludingSettledQueueRaw: accounting.reportedTotalSupplyExcludingSettledQueueRaw ?? null,
      currentPeriodRequestedSharesRaw: accounting.currentPeriodRequestedSharesRaw ?? null,
      unsettledSettledClaimSharesRaw: accounting.unsettledSettledClaimSharesRaw ?? null,
      totalOutstandingQueueSharesDerivedRaw: accounting.totalOutstandingQueueSharesDerivedRaw ?? null,
      vaultCashRaw: accounting.vaultCashRaw ?? null,
      portfolioCashRaw: accounting.portfolioCashRaw ?? null,
      offchainAssetsMeasured: false,
      legalAggregateQueuePayout: null,
      linkedLifecycleEventsComplete: historical.linkedLifecycleEventsComplete === true,
      linkedLifecycleReceiptsComplete: historical.linkedLifecycleReceiptsComplete === true,
      periodHistoryComplete: historical.periodHistoryComplete === true,
      deploymentToPinComplete: historical.deploymentToPinComplete ?? null,
      sourceRuntimeEquivalence: artifact.sourceBinding?.sourceRuntimeEquivalence ?? null,
      resetSelectorAllowlistedAtFixedPin: reset.fixedPinSelectorAllowlisted === true,
      operationalResetAuthorityAtFixedPin: reset.operationalResetAuthorityAtFixedPin === true,
      futureAuthorityComplete: false,
    },
    economics: {
      historicalInputRaw: "105000000000000000000",
      historicalMintedSharesRaw: historical.mintedSharesRaw ?? null,
      historicalRequestedAndBurnedSharesRaw: historical.requestedSharesRaw ?? null,
      historicalClaimOutputRaw: historical.claimOutputRaw ?? null,
      historicalDirectionalUpliftRaw: historical.realizedClaimUpliftRaw ?? null,
      historicalRemainderSharesRaw: historical.remainderSharesRaw ?? null,
      historicalProfitCharacter: historical.positiveHistoricalClaimCharacter ?? null,
      modelInputRaw: economics.inputRaw ?? null,
      modelOutputAtCurrentNavRaw: economics.outputAtCurrentNavRaw ?? null,
      breakEvenFutureSettlementNavRawBeforeCosts: economics.breakEvenFutureSettlementNavRawBeforeCosts ?? null,
      futureSettlementNavRaw: economics.settlementNavRaw ?? null,
      guaranteedClaimRaw: economics.guaranteedClaimRaw ?? null,
      gasCostUsd: economics.gasCostUsd ?? null,
      opportunityCostRaw: economics.opportunityCostRaw ?? null,
      deterministicProfitRaw: economics.deterministicProfitRaw ?? null,
    },
    topRows: [],
    blockers: Array.isArray(artifact.blockers) && artifact.blockers.length ? artifact.blockers : [
      "requestWithdraw snapshots shares, not NAV or assets",
      "future claim NAV and timing are manager-controlled and not locked",
      "future payout, full costs, and net economics remain null",
    ],
    requiredForRoutePositive: [
      "permissionless request locks an exact claim NAV, asset amount, or independently bounded settlement formula",
      "future settlement timing and claim eligibility are enforceable without privileged manager discretion",
      "claim-paying liquidity is reserved or otherwise proven available for the exact route",
      "acquisition, request, delay, claim, gas, fees, slippage, and opportunity-cost economics are exact and net-positive",
      "route-specific fork value-delta proof before any signed or live action",
    ],
    nextReadOnlyStep: "Selection pending. Do not refresh or fork Lorenzo unless a later coordinator selection identifies new evidence that locks exit entitlement and makes complete net economics positive.",
    sourceArtifacts: [
      "reports/raw/fast/lorenzo-susd1plus-step6-accounting.json",
      "reports/raw/fast/lorenzo-susd1plus-step6-accounting.manifest.json",
      "reports/lorenzo-susd1plus-step6-accounting.md",
      "definitions/lorenzo-susd1plus-step6-accounting.json",
    ],
  });
}

function lombardRatioDomainStep7Candidate(artifact = {}) {
  const gates = artifact.gates || {};
  const t2 = artifact.t2 || {};
  const accepted = Array.isArray(t2.acceptedPriceSummary) ? t2.acceptedPriceSummary : [];
  const latest = accepted.find((row) => row.window === "latest-same-block-ordered-model")?.rows || [];
  const historical = accepted.find((row) => row.window === "maximum-historical")?.rows || [];
  const routePositive = gates.routePositive === 1 || gates.routePositive === true ? 1 : 0;
  return rankCandidate({
    id: "critical-lombard-ratio-domain-step7-sweep",
    protocol: "Lombard LBTC / Fluid",
    chain: "Base -> Ethereum",
    surface: "Cross-chain ratio-proof domain separation and direct Fluid DEX/T2 accepted-price impact",
    status: routePositive > 0 ? "route-positive-needs-fork-proof" : "watch-domain-separation-absent-price-delta-no-liquidation-boundary",
    priorityScore: 44,
    routePositive,
    forkGate: "closed-no-current-compatible-opportunity-or-positive-economics",
    coverageOpen: true,
    closureEligible: false,
    evidenceComplete: gates.evidenceComplete === true,
    sourceRuntimeEquivalence: gates.deploymentSourceEquivalence ?? null,
    supersedesLegacyClassification: "lombard-ratio-domain-watch-with-unqualified-t2-no-delta-wording",
    distance: {
      watchCandidates: gates.t2AcceptedPriceDelta === true ? 3 : 0,
      researchRows: (t2.liveMaterialIntegration?.positionsAcrossThreeVaultsAtLatestTestedWindow || 0),
      quoteRows: gates.directDexQuoteDelta === true ? 1 : 0,
      proofCompatibility: gates.proofCompatibility === true,
      timingWindow: gates.timingWindow === true,
      crossChainDomainSeparationAdequate: false,
      exactBaseCalldataAcceptedOnEthereumFork: gates.proofCompatibility === true,
      directDexQuoteDelta: gates.directDexQuoteDelta === true,
      t2AcceptedPriceDelta: gates.t2AcceptedPriceDelta === true,
      t2VaultsBound: Array.isArray(t2.deployments) ? t2.deployments.length : 0,
      scopedPositionsLatestTested: t2.liveMaterialIntegration?.positionsAcrossThreeVaultsAtLatestTestedWindow ?? null,
      scopedPositionInventoryComplete: t2.liveMaterialIntegration?.inventoryComplete === true,
      latestSameBlockSignedDeltasBps: latest.map((row) => row.signedDeltaBps),
      maximumHistoricalSignedDeltasBps: historical.map((row) => row.signedDeltaBps),
      resolverLiquidationAmountsNonzero: false,
      resolverAbsorbAmountsNonzero: false,
      maximumSimulationError: "FluidVaultError(31029)",
      maximumSimulationDebt: 0,
      liquidationBoundaryCrossed: gates.liquidationBoundaryCrossed === true,
      replayedRatioValidSignedState: t2.replaySemantics?.validSignedState === true,
      replayPersistsAfterNativeUpdate: t2.replaySemantics?.persistsAfterNativePublicationTime === true,
      replayInterpretation: t2.replaySemantics?.interpretation || null,
      currentCompatibleOpportunity: false,
      sourceRuntimeEquivalence: gates.deploymentSourceEquivalence ?? null,
      evidenceComplete: gates.evidenceComplete === true,
    },
    economics: {
      exactPositiveEconomics: gates.exactPositiveEconomics ?? null,
      exactNet: artifact.economics?.exactNet ?? null,
      completeUnwind: false,
      fundedRoute: false,
    },
    topRows: latest.map((row) => ({
      protocol: "Fluid T2",
      chain: "Ethereum",
      symbol: row.label,
      edgeBps: asNumber(row.signedDeltaBps),
      routePositive: false,
      blocker: "accepted-price delta does not cross a liquidation boundary",
    })),
    blockers: Array.isArray(artifact.blockers) && artifact.blockers.length ? artifact.blockers : [
      "No tested liquidation boundary crossing or non-zero liquidatable debt",
      "No complete funded unwind or exact positive economics",
      "Source/runtime and broader consumer/borrower inventory remain open",
    ],
    requiredForRoutePositive: [
      "fresh cross-chain-compatible proof produces a material accepted-price delta in a currently active consumer",
      "specific borrower or DEX route crosses an executable value boundary with non-zero debt or funded inventory",
      "complete acquisition, action, unwind, fees, slippage, gas, and liquidity economics are exact and net-positive",
      "source/runtime and route-specific consumer bindings are sufficient for the claimed path",
      "fresh route-specific fork value-delta proof before any signed or live action",
    ],
    nextReadOnlyStep: "Keep this branch Informational/WATCH. Reopen only if a fresh compatible window crosses a borrower or funded DEX boundary with a complete exact-positive unwind; otherwise proceed to separate branch selection.",
    sourceArtifacts: [
      "reports/raw/fast/critical-lombard-ratio-domain-step7.json",
      "reports/raw/fast/critical-lombard-ratio-domain-step7.manifest.json",
      "reports/raw/fast/critical-lombard-ratio-domain-step7.fork.json",
      "reports/raw/fast/critical-lombard-ratio-domain-step7.dex-fork.json",
      "reports/raw/fast/critical-lombard-ratio-domain-step7.t2-fork.json",
      "reports/critical-lombard-ratio-domain-step7.md",
    ],
  });
}

function quoteRowsFromMorphoResult(row) {
  const out = [];
  for (const size of row.sizeResults || []) {
    for (const quote of size.quotes || []) {
      out.push({
        fraction: size.fraction,
        source: quote.source,
        pathKind: quote.pathKind,
        repayUsd: round(size.repayUsd, 6),
        expectedOutUsd: round(quote.expectedOutUsd, 6),
        grossProfitUsd: round(quote.grossProfitUsd, 6),
        gasUsd: round(quote.gasUsd, 6),
        slippageUsd: round(quote.slippageUsd, 6),
        netProfitUsd: round(quote.netProfitUsd, 6),
        routePositive: Boolean(quote.routePositive),
      });
    }
  }
  return out;
}

function morphoHighApyCandidate(artifact = {}, nonDex = {}) {
  const summary = artifact?.summary || {};
  const nonDexSummary = nonDex?.summary || {};
  const nonDexByRow = new Map((nonDex?.rows || []).map((row) => [`${String(row.marketId || "").toLowerCase()}:${String(row.borrower || "").toLowerCase()}`, row]));
  const rows = (artifact?.results || []).map((row) => {
    const quotes = quoteRowsFromMorphoResult(row);
    const bestQuote = maxBy(quotes, (q) => q.netProfitUsd ?? -Infinity);
    const nonDexRow = nonDexByRow.get(`${String(row.marketId || "").toLowerCase()}:${String(row.borrower || "").toLowerCase()}`);
    return {
      borrower: row.borrower,
      marketId: row.marketId,
      pair: row.pair,
      healthFactor: round(row.healthFactor, 6),
      currentLiquidatable: Boolean(row.currentLiquidatable),
      debtUsd: round(row.graph?.borrowAssetsUsd, 2),
      collateralSymbol: row.collateral?.symbol || null,
      loanSymbol: row.loanAsset?.symbol || null,
      borrowApy: round(row.market?.borrowApy, 2),
      utilization: round(row.market?.utilization, 6),
      bestNetProfitUsd: round(bestQuote?.netProfitUsd, 6),
      netGapToPositiveUsd: round(Math.max(0, -(asNumber(bestQuote?.netProfitUsd) || 0)), 6),
      nonDexTags: nonDexRow?.classification?.tags || [],
      nonDexExactSameBlockExitProven: Boolean(nonDexRow?.classification?.exactSameBlockExitProven),
      bestQuote,
      routePositive: Boolean(row.routePositive || bestQuote?.routePositive),
    };
  });
  rows.sort((a, b) => {
    const aNet = asNumber(a.bestNetProfitUsd) ?? -Infinity;
    const bNet = asNumber(b.bestNetProfitUsd) ?? -Infinity;
    return bNet - aNet || Number(b.currentLiquidatable) - Number(a.currentLiquidatable);
  });
  const best = rows[0] || null;
  const bestNet = asNumber(best?.bestNetProfitUsd);
  const routePositive = routePositiveCount(summary.routePositive, rows.filter((r) => r.routePositive).length);
  const priorityScore = 50
    + clamp((asNumber(summary.currentLiquidatable) || 0) / 10, 0, 1) * 6
    + clamp((asNumber(summary.rowsWithAnyQuote) || 0) / 5, 0, 1) * 5
    + clamp(1 - (Math.max(0, -(bestNet ?? -100)) / 25), 0, 1) * 12
    + (routePositive > 0 ? 25 : 0)
    - (bestNet !== null && bestNet <= 0 ? 6 : 0);

  return rankCandidate({
    id: "morpho-high-apy-liquidation-sweep",
    protocol: "Morpho Blue",
    chain: "Ethereum",
    surface: "High-APY/high-utilization borrower liquidation exact-route distance",
    status: routePositive > 0 ? "route-positive-needs-fork-proof" : (asNumber(summary.rowsWithAnyQuote) || 0) > 0 ? "exact-quoted-route-negative" : "liquidatable-no-exit-quote",
    priorityScore,
    routePositive,
    distance: {
      currentLiquidatable: summary.currentLiquidatable || 0,
      rowsWithAnyQuote: summary.rowsWithAnyQuote || 0,
      nonDexRowsClassified: nonDexSummary.rowsClassified || 0,
      nonDexExactSameBlockExitProvenRows: nonDexSummary.exactSameBlockExitProvenRows || 0,
      nonDexRoutePositive: nonDexSummary.routePositive || 0,
      bestNetProfitUsd: round(bestNet, 6),
      bestNetGapToPositiveUsd: round(Math.max(0, -(bestNet ?? 0)), 6),
      positionsScored: summary.positionsScored || 0,
    },
    economics: {
      gasUsd: round(artifact?.gas?.liquidationGasUsd, 6),
      maxBorrowApy: round(summary.maxBorrowApy, 2),
      bestPair: best?.pair || null,
      bestDebtUsd: round(best?.debtUsd, 2),
    },
    topRows: rows.slice(0, 5),
    blockers: routePositive > 0
      ? ["Needs fork extraction proof before any signed action"]
      : ["Exact collateral-exit quotes are net negative", nonDexSummary.blocker || "No exact same-block non-DEX collateral exit is proven", "Top liquidatable rows are bad-debt/dust or illiquid collateral", "No fork-positive liquidation route"],
    requiredForRoutePositive: ["currently liquidatable borrower", "exact DEX or non-DEX exit covers repay plus gas/slippage", "trusted loan-token price", "positive fork proof"],
    nextReadOnlyStep: "Refresh as a fast liquidation branch; fork only if exact DEX or non-DEX exit economics turn positive after gas/slippage.",
    sourceArtifacts: ["reports/raw/fast/morpho-high-apy-liquidation-routes.json", "reports/raw/fast/morpho-high-apy-nondex-exit-classification.json"],
  });
}

function curveIbStableCandidate(artifact = {}) {
  const summary = artifact?.summary || {};
  const routePositive = routePositiveCount(summary.routePositive);
  const bestNet = asNumber(summary.bestNetProfitUsd) || 0;
  const cashBlocked = asNumber(summary.cashBlockedRoutes) || 0;
  const externalExitPositive = asNumber(summary.externalExitPositiveRoutes) || 0;
  const priorityScore = 35
    + clamp((asNumber(summary.researchPositiveRoutes) || 0) / 15, 0, 1) * 7
    + clamp(Math.max(0, bestNet) / 10_000, 0, 1) * 8
    + (externalExitPositive > 0 ? 10 : 0)
    + (routePositive > 0 ? 20 : 0)
    - (cashBlocked > 0 ? 8 : 0);

  return rankCandidate({
    id: "curve-ib-stable-wrapper-sweep",
    protocol: "Curve / Iron Bank",
    chain: "Ethereum",
    surface: "ib3CRV stable-wrapper NAV route exact-exit distance",
    status: routePositive > 0 ? "route-positive-needs-fork-proof" : cashBlocked > 0 ? "cash-blocked-no-external-exit" : "route-negative",
    priorityScore,
    routePositive,
    distance: {
      researchPositiveRoutes: summary.researchPositiveRoutes || 0,
      cashBlockedRoutes: cashBlocked,
      externalExitQuotedRoutes: summary.externalExitQuotedRoutes || 0,
      externalExitPositiveRoutes: externalExitPositive,
      bestNetProfitUsd: round(bestNet, 2),
    },
    economics: {
      routeQuotes: summary.routeQuotes || 0,
      bestRoute: summary.bestRoute || null,
    },
    topRows: [],
    blockers: routePositive > 0
      ? ["Needs fork extraction proof before any signed action"]
      : ["Output wrapper redeem cash is dust", "No exact positive external output-wrapper sale", "Positive modeled NAV rows are trapped-liquidity research only"],
    requiredForRoutePositive: ["wrapper getCash recovers", "external output-wrapper buyer/exit quote", "gas-adjusted positive route", "fork exchange/redeem proof"],
    nextReadOnlyStep: "Reopen only if Iron Bank wrapper redeem cash recovers or an external output-wrapper exit route appears.",
    sourceArtifacts: ["reports/raw/fast/curve-ib-stable-wrapper-route.json"],
  });
}

function summarizeGenericRows(artifact = {}) {
  const nestedRows = Array.isArray(artifact.results)
    ? artifact.results.flatMap((result) => result?.highLtvRowsDetail || result?.topRows || [])
    : [];
  const rows = [artifact.topRows, artifact.topPayloadRows, artifact.rankedRows, artifact.rows, artifact.payloadRows, nestedRows, artifact.results, artifact.vaultRows]
    .find((items) => Array.isArray(items) && items.length) || [];
  return rows.slice(0, 5).map((row) => ({
    protocol: row.protocol || row.project || row.target || row.address || null,
    chain: row.chain || row.chainName || row.chainId || null,
    symbol: row.symbol || row.token?.symbol || row.vault?.symbol || row.collateral?.symbol || row.function || row.name || null,
    pair: row.pair || (row.supplySymbol && row.borrowSymbol ? `${row.supplySymbol}/${row.borrowSymbol}` : null) || row.file || row.source || null,
    collateral: row.collateral?.symbol || row.collateralSymbol || row.collateral?.token?.symbol || row.consumers?.[0]?.collateralAsset?.symbol || null,
    loanAsset: row.loanAsset?.symbol || row.borrowAsset?.symbol || row.loanSymbol || row.borrowSymbol || row.consumers?.[0]?.loanAsset?.symbol || null,
    netUsd: round(row.netUsd ?? row.bestNetUsd ?? row.bestNetProfitUsd ?? row.quote?.bestNetUsd ?? row.quote?.bestNetProfitUsd ?? row.bestEstimatedRoute?.netUsd ?? row.bestRouteAttempt?.estimatedNetUsd ?? row.economics?.netEdgeUsd, 6),
    edgeBps: round(row.edgeBps ?? row.bestEdgeBps ?? row.acceptedVsReferenceBps ?? row.bestEstimatedRoute?.edgeBps ?? row.bestRouteAttempt?.edgeBps ?? row.economics?.acceptedVsReferenceBps ?? row.oracleDivergence?.liquidateVsOperateBps, 4),
    liquidityUsd: round(row.liquidityUsd ?? row.routeLiquidityUsd ?? row.dex?.liquidityUsd ?? row.morpho?.routeLiquidityUsd ?? row.totalBorrowUsd, 2),
    routePositive: Boolean(row.routePositive),
    blocker: Array.isArray(row.blockers) ? row.blockers[0] : row.blocker || null,
  }));
}

function genericSummaryCandidate(artifact = {}, cfg = {}) {
  const summary = artifact.summary || {};
  const routePositive = routePositiveMax(
    ...((cfg.routePositiveFields || ["routePositive"]).map((field) => valueAt(summary, field))),
    artifact.safety?.routePositive === true ? 1 : 0
  );
  const watchCandidates = sumNumeric(summary, cfg.watchFields || ["watchCandidates"]);
  const researchRows = sumNumeric(summary, cfg.researchFields || ["researchPositiveRows", "researchPositiveRoutes", "researchPositive", "reviewCandidates"]);
  const quoteRows = sumNumeric(summary, cfg.quoteFields || ["exactPoolQuoteRows", "morphoExecutableQuotes", "siloExecutableQuotes", "quoteRows", "rowsWithAnyQuote"]);
  const bestNet = maxNumeric(summary, cfg.bestNetFields || ["bestNetUsd", "bestNetProfitUsd", "bestLiquidNetUsd", "bestEstimatedNetUsd", "netProfitUsd"]);
  const bestGap = bestNet === null ? null : Math.max(0, -bestNet);
  const priorityScore = (cfg.baseScore || 24)
    + (routePositive > 0 ? 25 : 0)
    + clamp(watchCandidates / (cfg.watchScale || 5), 0, 1) * 8
    + clamp(researchRows / (cfg.researchScale || 20), 0, 1) * 7
    + clamp(quoteRows / (cfg.quoteScale || 20), 0, 1) * 4
    + clamp(Math.max(0, bestNet || 0) / (cfg.netScale || 1_000), 0, 1) * 8
    - (bestNet !== null && bestNet < 0 ? Math.min(6, clamp(bestGap / 100, 0, 1) * 6) : 0);

  return rankCandidate({
    id: cfg.id,
    protocol: cfg.protocol,
    chain: cfg.chain,
    surface: cfg.surface,
    status: routePositive > 0
      ? "route-positive-needs-fork-proof"
      : watchCandidates > 0 && cfg.watchStatus
        ? cfg.watchStatus
        : cfg.closedStatus || (bestNet !== null ? "quoted-route-negative" : "mapped-no-route-positive"),
    priorityScore,
    routePositive,
    distance: {
      watchCandidates,
      researchRows,
      quoteRows,
      bestNetUsd: round(bestNet, 6),
      bestNetGapToPositiveUsd: round(bestGap, 6),
      routePositive,
      summary: Object.fromEntries(Object.entries(summary).filter(([, value]) => typeof value !== "object").slice(0, 16)),
    },
    economics: {
      bestEdgeBps: round(maxNumeric(summary, cfg.edgeFields || ["bestEdgeBps", "bestLiquidEdgeBps", "bestRouteEdgeBps", "navSpreadBps", "marketVsCadFxBps"]), 4),
      bestLiquidityUsd: round(maxNumeric(summary, cfg.liquidityFields || ["bestLiquidLiquidityUsd", "bestBorrowRouteLiquidityUsd", "dexLiquidityUsd", "maxForceFeedCapacityUsd"]), 2),
    },
    topRows: summarizeGenericRows(artifact),
    blockers: routePositive > 0
      ? ["Needs route-specific fork extraction proof before any signed action"]
      : cfg.blockers || ["No route-positive source artifact", "No fork-positive extraction proof", "Signed action remains unjustified"],
    requiredForRoutePositive: cfg.requiredForRoutePositive || ["source artifact routePositive > 0", "exact route economics positive after gas/slippage", "fork extraction proof"],
    nextReadOnlyStep: cfg.nextReadOnlyStep || "Refresh this artifact only when fresh data changes route economics; fork only after routePositive > 0.",
    sourceArtifacts: cfg.sourceArtifacts,
  });
}

function polymarketAdapterFullBalanceCandidate(artifact = {}) {
  const gates = artifact.gates || {};
  const history = artifact.history || {};
  const usdce = history.usdce || {};
  const pUSD = history.pUSD || {};
  const capital = artifact.currentCapital?.adapters || [];
  const currentResidual = asNumber(gates.currentSweepableResidual) || 0;
  const exactGain = asNumber(gates.exactAttackerGain) || 0;
  const strictPositive = gates.routePositive === true
    && usdce.complete === true
    && currentResidual > 0
    && gates.nonAttackerFundedResidualProven === true
    && exactGain > 0;
  const routePositive = strictPositive ? 1 : 0;
  const ctf = usdce.breakdown?.ctfAdapter || {};
  const neg = usdce.breakdown?.negAdapter || {};
  return rankCandidate({
    id: "polymarket-adapter-full-balance-gate-sweep",
    protocol: "Polymarket CTF adapters",
    chain: "Polygon",
    surface: "Full-balance USDC.e payout primitive with current-capital and provenance gate",
    status: routePositive > 0 ? "route-positive-needs-fork-proof" : "dormant-conditional-full-balance-sweep-history-incomplete",
    priorityScore: 39,
    routePositive,
    forkGate: "blocked-no-current-nonattacker-residual-and-history-incomplete",
    historicalCoverageComplete: usdce.complete === true,
    closureEligible: false,
    distance: {
      watchCandidates: gates.zeroInputSweepReachable === true ? 1 : 0,
      researchRows: (asNumber(usdce.logCount) || 0) + (asNumber(pUSD.logCount) || 0),
      quoteRows: 0,
      currentSweepableResidual: currentResidual,
      exactAttackerGain: exactGain,
      usdceHistoryComplete: usdce.complete === true,
      pUSDHistoryComplete: pUSD.complete === true,
      historicalResidualEpisodes: history.residualEpisodeCount ?? null,
      inputClassification: gates.inputClassification || null,
      setupFree: gates.setupFree === true,
      testsPassed: artifact.tests?.passed === true,
      runtimeBindingsPassed: Array.isArray(artifact.bindings) && artifact.bindings.every((row) => row.exactReviewedBuildCoreBound === true),
      adapterTouchingLogs: asNumber(usdce.logCount) || 0,
      adapterTouchingTransactions: asNumber(usdce.transactionCount) || 0,
      ctfLogs: asNumber(ctf.logCount) || 0,
      ctfTransactions: asNumber(ctf.transactionCount) || 0,
      negRiskLogs: asNumber(neg.logCount) || 0,
      negRiskTransactions: asNumber(neg.transactionCount) || 0,
      currentUsdceBalances: capital.map((row) => ({ label: row.label, raw: row.usdce })),
      noncapturablePusdBalances: capital.map((row) => ({ label: row.label, raw: row.pUSD })),
    },
    economics: { bestNetUsd: 0, currentSweepableResidual: currentResidual, exactAttackerGain: exactGain },
    topRows: [],
    blockers: [
      "Both adapter USDC.e balances are zero at the fixed Polygon head; current attacker gain is zero",
      "The sweep is zero-token-input only after caller ERC1155 approval, a valid live market/index, unpaused adapter state, and pUSD wrapper authorization",
      "The observed 7,672 adapter-touching USDC.e logs / 3,831 transactions are bounded incomplete history; historical residual and complete call counts remain null",
      "Existing pUSD balances are not consumed by the USDC.e full-balance payout primitive",
      "No material non-attacker-funded current residual, exact positive economics, or fork justification exists",
    ],
    requiredForRoutePositive: [
      "fresh nonzero adapter USDC.e residual with non-attacker-funded provenance or a permissionless preceding operation that creates one",
      "zero-token-input-after-setup path remains permissionless and valid in current deployed state",
      "exact attacker gain remains positive after all costs without counting attacker donation and reclamation as profit",
      "complete enough provenance evidence and route-specific fork value-delta proof",
    ],
    nextReadOnlyStep: "Keep this branch dormant; reopen only on a material non-attacker-funded USDC.e residual or a proven permissionless preceding operation that creates one. Historical coverage gaps remain open and do not establish full closure.",
    sourceArtifacts: [
      "reports/raw/fast/polymarket-adapter-full-balance-gate.json",
      "reports/raw/fast/polymarket-adapter-full-balance-gate.manifest.json",
      "reports/polymarket-adapter-full-balance-gate.md",
      "definitions/polymarket-adapter-full-balance-gate.json",
      "sources/polymarket-adapter-full-balance-gate/forge-test-output.txt",
    ],
  });
}

function kaminoReducedStatusRecertificationCandidate(artifact = {}) {
  const gates = artifact.gates || {};
  const scan = artifact.scan || {};
  const historical = scan.historicalObservation || {};
  const counts = historical.aggregateCounts || {};
  const providerRows = historical.providerRows || {};
  const sourceRuntimeEquivalence = artifact.binding?.sourceRuntimeEquivalence ?? null;
  const routePositive = gates.routePositive === true
    && gates.currentDifferentialProven === true
    && artifact.economics?.netUsd > 0 ? 1 : 0;
  return rankCandidate({
    id: "kamino-reduced-status-liquidation-recertification-sweep",
    protocol: "Kamino Klend",
    chain: "Solana",
    surface: "Reduced-price-status liquidation deployment/source semantics and one-window differential recertification",
    status: routePositive > 0 ? "route-positive-needs-fork-proof" : "watch-coverage-open-no-current-differential-observed",
    priorityScore: 40,
    routePositive,
    forkGate: "blocked-coverage-open-no-current-differential-or-economics",
    coverageOpen: true,
    routeNegativeClosure: gates.routeNegativeClosure === true,
    closureEligible: false,
    sourceRuntimeEquivalence,
    distance: {
      watchCandidates: gates.zeroSameSlotReducedStatusObservedInSingleWindow === true ? 1 : 0,
      researchRows: (asNumber(providerRows.reservesParsed) || 0) + (asNumber(providerRows.obligationsParsed) || 0),
      quoteRows: 0,
      finalizedSlot: artifact.fixedObservation?.slot ?? null,
      reservesObserved: asNumber(providerRows.reservesParsed),
      obligationsObserved: asNumber(providerRows.obligationsParsed),
      debtRowsObserved: asNumber(counts.debtRows),
      sameSlotReducedStatusObligationsObserved: asNumber(counts.sameSlotReducedStatusObligations),
      independentlyProvenChainWideCompleteness: scan.coverage?.independentlyProvenChainWideCompleteness ?? null,
      perAccountTranscriptAvailable: scan.coverage?.perAccountTranscriptAvailable === true,
      exactOnchainEligibilityRows: scan.exactOnchainEligibilityRows ?? null,
      currentDifferentialRows: scan.currentDifferentialRows ?? null,
      referencePricing: artifact.referencePricing ?? null,
      economics: artifact.economics ?? null,
      sourceRuntimeEquivalence,
      localTestsPassed: artifact.local?.test?.passed === true,
      localTestsPassedCount: artifact.local?.test?.passedTestNames?.length || 0,
      deploymentLinkageValid: artifact.deployment?.linkageValid === true,
    },
    economics: { bestNetUsd: null, exactEconomics: artifact.economics ?? null },
    topRows: [],
    blockers: Array.isArray(artifact.blockers) && artifact.blockers.length ? artifact.blockers : [
      "Exact deployed SBF build reproduction is unavailable; source/runtime equivalence remains null",
      "Independent chain-wide completeness, exact eligibility, reference pricing, differential, and economics remain null",
      "The single observed zero is not route-negative closure",
    ],
    requiredForRoutePositive: [
      "exact deployed SBF/source equivalence or equivalent deployed-logic proof",
      "independently replayable same-slot account evidence proving exact reduced-vs-full eligibility differential",
      "permissionless liquidation reachability against an exact eligible obligation",
      "same-observation reference pricing and exact positive repay/acquisition/collateral-exit economics",
      "local/fork-equivalent value-delta proof before any signed action",
    ],
    nextReadOnlyStep: "Keep the branch WATCH/COVERAGE_OPEN. Reopen only with replayable same-slot account evidence and exact reference/economic joins; do not infer route-negative closure from the one retained zero observation.",
    sourceArtifacts: [
      "reports/raw/fast/kamino-reduced-status-liquidation-recertification.json",
      "reports/raw/fast/kamino-reduced-status-liquidation-recertification.manifest.json",
      "reports/kamino-reduced-status-liquidation-recertification.md",
      "definitions/kamino-reduced-status-liquidation-recertification.json",
    ],
  });
}

function synapseCctpStep8Candidate(artifact = {}, manifest = {}) {
  const classification = manifest.classification || "UNCLASSIFIED";
  const closed = classification.toUpperCase().includes("CLOSED");
  const informational = classification.toUpperCase().includes("INFORMATIONAL");
  const pass = manifest.validation?.pass === true;
  const deterministicHeads = artifact.deterministicHeads || {};
  const corpus = artifact.corpusMinimization || {};
  const exactCommon = artifact.exactCommonAddresses || {};
  return rankCandidate({
    id: "synapse-cctp-step8-r2-sweep",
    protocol: "Synapse CCTP",
    chain: "Ethereum/Arbitrum",
    surface: "Permissionless relay fee-collector semantics and consumed-payload replay boundary (Step 8 oracle-packaging-r2)",
    status: closed ? "closed-no-principal-diversion" : "revisit-fork-semantics",
    priorityScore: closed ? 30 : 45,
    routePositive: 0,
    forkGate: "blocked-intended-fee-competition-no-extraction",
    coverageOpen: false,
    closureEligible: closed && pass,
    sourceRuntimeEquivalence: true,
    distance: {
      fixedHeadsPinned: deterministicHeads.allSelectedChainsExplicitlyPinned === true,
      fixedHeads: deterministicHeads.requested || null,
      ledgerRecords: asNumber(corpus.ledgerRecords),
      consumedPayloadsRetained: asNumber(corpus.fullPayloadsRetained),
      pendingOrUnconsumedAttestations: asNumber(corpus.pendingOrUnconsumedAttestationsRetained),
      completeWindowHistory: artifact.completeWindowHistory === true,
      manifestPass: pass,
      manifestClassification: classification,
      synapseCCTPProxy: exactCommon.synapseCCTPProxy || null,
      synapseCCTPRouter: exactCommon.synapseCCTPRouter || null,
      highestActivityDestinationChain: artifact.highestActivityDestinationChain?.name || null,
      corroboratingChain: artifact.corroboratingChain?.name || null,
      manifestAggregateHash: manifest.aggregateHash || null,
    },
    economics: { bestNetUsd: null, exactEconomics: null },
    topRows: [],
    blockers: closed
      ? ["closed at fixed heads: no principal diversion, no pending attestation, no exclusive relayer entitlement; reopen only on semantic/activity change or source/runtime mismatch"]
      : ["r2 classification is not CLOSED; re-evaluate fee-collector entitlement and replay boundary"],
    requiredForRoutePositive: [
      "live replay proof that an alternate caller can divert principal or recipient funds",
      "Circle/request binding permits caller-chosen forwarder or recipient other than self-collector",
      "pending/unconsumed attestation exists and is replayable to a different recipient",
      "exact positive extraction after gas, bridge, and slippage costs",
      "fork/local proof before any signed relay action",
    ],
    nextReadOnlyStep: "Keep Synapse CCTP closed on fast monitor; reopen only if semantic/activity change creates a pending attestation, caller-chosen recipient diversion, or source/runtime mismatch.",
    sourceArtifacts: [
      "reports/raw/fast/synapse-cctp-step8.json",
      "reports/raw/fast/synapse-cctp-step8.manifest.json",
      "reports/raw/fast/synapse-cctp-step8.fork.json",
      "reports/raw/fast/synapse-cctp-step8.final-check.json",
      "reports/raw/fast/synapse-cctp-step8.activity-ranking.json",
      "reports/raw/fast/synapse-cctp-step8.public-calldata.json",
      "reports/synapse-cctp-step8.md",
    ],
  });
}

function babylonLateQuorumProductionExposureCandidate(artifact = {}, manifest = {}) {
  const classification = manifest.classification || "UNCLASSIFIED";
  const auditClassification = artifact.auditClassification || "VULNERABLE/CONDITIONAL-HIGH";
  const vulnerable = auditClassification.toUpperCase().includes("VULNERABLE");
  const pass = Object.values(artifact.tests || {}).every(
    (v) => v === "PASS" || (typeof v === "string" && v.startsWith("PASS"))
  );
  const retained = artifact.retainedRangeExposure || "NO_CANDIDATE_IN_RETAINED_INDEX_COVERAGE";
  const production = artifact.productionExposure || "UNKNOWN/COVERAGE_OPEN";
  const coverage = artifact.coverage || {};
  const preIndex = coverage.preIndexArchiveState || {};
  const current = artifact.currentExposure || {};
  const power = current.power || {};
  const delegations = artifact.delegations || {};
  const tx = artifact.transactions || {};
  const pin = artifact.pin || {};
  return rankCandidate({
    id: "babylon-late-quorum-production-exposure-r3-sweep",
    protocol: "Babylon",
    chain: "Bitcoin/Cosmos (bbn-1)",
    surface: "BTC staking delegation late-quorum / pre-expiry covenant signature aggregation boundary (Step 9 oracle-remediation-r3)",
    status: vulnerable
      ? "vulnerable-coverage-open-incomplete"
      : "revisit-source-classification",
    priorityScore: vulnerable ? 70 : 50,
    routePositive: 0,
    forkGate: "blocked-no-live-extraction-without-complete-pre-retention-index",
    coverageOpen: true,
    closureEligible: false,
    sourceRuntimeEquivalence: false,
    distance: {
      auditClassification,
      manifestClassification: classification,
      retainedRangeExposure: retained,
      productionExposure: production,
      evidenceComplete: artifact.evidenceComplete === true,
      canonicalUniqueIds: asNumber(artifact.canonicalIdentity?.canonicalUniqueIds),
      witnessDifferentCount: asNumber(artifact.canonicalIdentity?.witnessDifferentCount),
      currentPageCount: asNumber(delegations.pagination?.pageCount),
      currentUniqueRows: asNumber(delegations.pagination?.uniqueRows),
      activeDelegations: asNumber(delegations.statusCounts?.ACTIVE),
      verifiedDelegations: asNumber(delegations.statusCounts?.VERIFIED),
      expansionRows: asNumber(delegations.expansionRows),
      uniqueExpansionPredecessors: asNumber(delegations.uniqueExpansionPredecessors),
      predecessorFetches: asNumber(delegations.predecessorFetches),
      unresolvedPredecessors: asNumber(delegations.unresolvedPredecessors),
      preIndexUniqueRows: asNumber(preIndex.pagination?.uniqueRows),
      preIndexSignerEntriesStaking: asNumber(preIndex.signerEntries?.staking),
      retainedSuccessfulTx: asNumber(tx.successfulTx),
      retainedMinHeight: tx.minHeight || null,
      retainedMaxHeight: tx.maxHeight || null,
      retainedMessagesAndEvents: asNumber(tx.messagesAndSignatureEvents),
      quorumEvents: asNumber(tx.quorumEvents),
      activeQuorumEvents: asNumber(tx.activeQuorumEvents),
      expectedTotalSat: asNumber(power.expectedTotalSat),
      numActiveFps: asNumber(power.numActiveFps),
      activeExpansionCount: asNumber(power.activeExpansionCount),
      activeMultiFpDelegations: asNumber(power.activeMultiFpDelegations),
      noAggregateCacheMismatchAtPin: power.noAggregateCacheMismatchAtPin === true,
      exactPinChainId: pin.chainId || null,
      exactPinHeight: pin.height || null,
      exactPinBtcTipHeight: pin.btcTip?.height || null,
      exactPinAppVersion: pin.appVersion || null,
      exactPinGitCommit: pin.gitCommit || null,
      manifestPass: pass,
      manifestAggregateHash: manifest.aggregateHash || null,
    },
    economics: {
      bestNetUsd: null,
      exactEconomics: null,
      expectedTotalSat: asNumber(power.expectedTotalSat),
    },
    topRows: [],
    blockers: [
      "retained index coverage is NO_CANDIDATE: cannot prove or disprove a pre-retention exploitation route",
      "production exposure is UNKNOWN/COVERAGE_OPEN: no independent complete pre-retention transaction/event index or authoritative import ledger",
      "node self-reports exact vulnerable source commit (v4.3.0 / 16e00c88d9cfd2e9f92bb786c474f6e79628a49f); no cryptographic production-binary equivalence",
      "forward remediation tests PASS but the fix is undeployed; exact reward economics and poisoned-delegation effects remain null",
      "closure is ineligible by design until full pre-retention tx/event coverage or authoritative ledger is available",
    ],
    requiredForRoutePositive: [
      "complete independent pre-retention transaction/event index for all add-covenant-sigs and quorum transitions",
      "or authoritative import ledger reconstructing canonical delegation state before the retention boundary",
      "reconstruct any historical pre-expiry ACTIVE->UNBONDED/EXPIRED transition where quorum was assembled after the safe window",
      "quantify attributable reward loss or slashing-evasion in satoshis at exact pinned heights",
      "demonstrate live extraction, replay, or signing path against current network state after the fix window",
      "fork/local proof before any signed action or key import",
    ],
    nextReadOnlyStep:
      "Keep Babylon as required-active-closeout/incomplete: obtain complete pre-retention tx/event index or authoritative import ledger; otherwise rotate to an unrelated exploit-class branch. Do not deploy or sign.",
    sourceArtifacts: [
      "reports/raw/fast/babylon-late-quorum-production-exposure.json",
      "reports/raw/fast/babylon-late-quorum-production-exposure.manifest.json",
      "reports/raw/fast/babylon-late-quorum-production-exposure.docker-tests.json",
      "reports/raw/fast/babylon-late-quorum-production-exposure.preindex-rows.json",
      "reports/babylon-late-quorum-production-exposure.md",
    ],
  });
}

function babylonPreRetentionSourceReadinessCandidate(artifact = {}, manifest = {}) {
  const classification = artifact.classification || "UNCLASSIFIED";
  const accessBlocked = /ACCESS_BLOCKED/i.test(classification);
  const pass = manifest.validations?.passed === true;
  const gates = artifact.gates || {};
  const archive = artifact.archive || {};
  const current = archive.current || {};
  const provider = artifact.provider || {};
  const retained = artifact.retained || {};
  const retainedRoles = retained.roles || {};
  const target = retainedRoles.targetMsgAddCovenantSigs || {};
  const messages = retainedRoles.messagePositions || {};
  const r1 = artifact.r1IntegrityDisposition || {};
  return rankCandidate({
    id: "babylon-pre-retention-source-readiness-r3-sweep",
    protocol: "Babylon",
    chain: "Bitcoin/Cosmos (bbn-1)",
    surface: "Step 10 pre-retention source-readiness gate: public snapshot, Mintscan docs, provider reachability, retained-cursor role decoding",
    status: accessBlocked ? "access-blocked-coverage-open-incomplete" : "revisit-source-gate",
    priorityScore: accessBlocked ? 68 : 50,
    routePositive: 0,
    forkGate: "blocked-no-complete-pre-retention-index-or-authoritative-ledger",
    coverageOpen: true,
    closureEligible: false,
    sourceRuntimeEquivalence: false,
    historicalCoverageComplete: false,
    distance: {
      classification,
      manifestClassification: manifest.classification || null,
      productionExposure: artifact.productionExposure || "UNKNOWN/COVERAGE_OPEN",
      evidenceComplete: artifact.evidenceComplete === true,
      archiveHeight: current.height || null,
      archiveCompressedBytes: current.compressedBytes || null,
      archiveSuitability: archive.suitability || null,
      archiveIntegrityReady: artifact.capacity?.gates?.integrityReady === true,
      providersDiscovered: asNumber(provider.discoveredCandidates),
      providersReachable: asNumber(provider.reachable),
      cometProviders: asNumber(provider.comet),
      restProviders: asNumber(provider.rest),
      txSearchProviders: asNumber(provider.txSearch),
      preRetentionProviders: asNumber(provider.preRetentionBlock),
      earliestObservedHeight: provider.earliestObservedHeight || null,
      retainedTransactions: asNumber(retained.txCount ?? retainedRoles.transactionCount),
      retainedTargetMessages: asNumber(target.messages),
      retainedUniqueSignerHashes: asNumber(target.uniqueSignerAddressHashCount),
      retainedMultiMessageTx: asNumber(messages.multiMessageTransactions),
      retainedMsgExecCount: asNumber(retainedRoles.authz?.msgExecCount),
      explicitFeePayerOccurrences: asNumber(retainedRoles.fee?.explicitFeePayerFieldOccurrences),
      explicitFeeGranterOccurrences: asNumber(retainedRoles.fee?.explicitFeeGranterFieldOccurrences),
      mintscanDocsCaptured: asNumber(artifact.genuineSourceCapture?.mintscanRecords),
      archiveRecordsCaptured: asNumber(artifact.genuineSourceCapture?.archiveRecords),
      mintscanBearerRequired: artifact.mintscan?.approvedBearerRequired === true,
      mintscanUnauthenticatedProbe401: artifact.mintscan?.accountTransactions?.unauthenticatedProbe?.statusCode === 401,
      globalTransactionCollectionDocumented: artifact.mintscan?.globalTransactionCollection?.documented === true,
      r1Excluded: r1.disposition === "INVALID/SUPERSEDED-HISTORICAL-ARTIFACT-INTEGRITY-FAILED",
      manifestPass: pass,
      manifestAggregateHash: manifest.aggregateSha256 || null,
    },
    economics: {
      bestNetUsd: null,
      exactEconomics: null,
    },
    topRows: [],
    blockers: [
      "Pre-retention global transaction/event index or authoritative import ledger is not available locally",
      "Authoritative public snapshot is pruned/non-indexed (keep-recent 100, keep-every 0, indexer null) and unsuitable for pre-retention history",
      "Mintscan historical data API requires approved Bearer token; no token read/used and no unauthenticated UI/backend alternative established",
      "Public RPC/REST nodes only reproduce the retained tail from approximately height 2,556,426",
      "Retained direct-action cursor binds 9 signer hashes, 10,185 tx, 11,412 target messages, 0 MsgExec; authz closure requires separate MsgExec or global tx source",
      "R1 integrity failure is excluded; current evidence depends on R2 superseded and R3 source captures only",
    ],
    requiredForRoutePositive: [
      "complete independent pre-retention transaction/event index or authoritative import ledger",
      "or independently complete historical signer roster plus exhaustive exact-filter account histories and transaction-detail reconciliation",
      "separate complete MsgExec enumeration/decoding or complete global transaction source for authz closure",
      "exact decoding and reconciliation of all MsgAddCovenantSigs and quorum transitions before the retention boundary",
      "live extraction/replay/signing path against current state after the fix window, with fork/local proof before any signed action",
    ],
    nextReadOnlyStep:
      "Keep Babylon as required-active-closeout/incomplete: obtain a complete pre-retention tx/event index or authoritative import ledger; otherwise rotate to an unrelated unclosed exploit-class branch. No signatures, no live mutation, no deployment.",
    sourceArtifacts: [
      "reports/raw/fast/babylon-pre-retention-source-readiness.json",
      "reports/raw/fast/babylon-pre-retention-source-readiness.manifest.json",
      "reports/raw/fast/babylon-pre-retention-source-readiness.source-doc-fixtures.json",
      "reports/babylon-pre-retention-source-readiness.md",
    ],
  });
}

function babylonMintscanPreRetentionEnumeratorCandidate(artifact = {}, manifest = {}) {
  const classification = artifact.classification || "UNCLASSIFIED";
  const blocked = /TOKEN_AUTH_BLOCKED/i.test(classification);
  const gates = artifact.gates || {};
  const completeness = artifact.completeness || {};
  const boundary = artifact.boundarySemantics || {};
  const blockedDiagnostic = artifact.blockedDiagnostic || {};
  return rankCandidate({
    id: "babylon-mintscan-pre-retention-enumerator-sweep",
    protocol: "Babylon",
    chain: "Bitcoin/Cosmos (bbn-1)",
    surface: "Step 11 Mintscan token-safe pre-retention enumeration companion (blocked)",
    status: blocked ? "token-auth-blocked-coverage-open-incomplete" : "revisit-mintscan-gate",
    priorityScore: blocked ? 68 : 50,
    routePositive: 0,
    forkGate: "blocked-no-active-mintscan-token-with-tx-detail-account-history-scope",
    coverageOpen: true,
    closureEligible: false,
    historicalCoverageComplete: false,
    sourceRuntimeEquivalence: false,
    distance: {
      classification,
      blockedCategory: blockedDiagnostic.category || null,
      blockedCause: blockedDiagnostic.cause || null,
      blockedStatus: blockedDiagnostic.status || null,
      productionExposure: completeness.productionExposure || "UNKNOWN/COVERAGE_OPEN",
      evidenceComplete: gates.evidenceComplete === true,
      globalCollectionDocumented: completeness.globalCollectionDocumented === true,
      knownSeedApiSemantics: completeness.knownSeedApiSemantics || null,
      unavailableHeight: boundary.unavailableHeight || null,
      firstAvailableHeight: boundary.firstAvailableHeight || null,
      retainedExpectedTransactions: asNumber(artifact.retainedOverlap?.expectedTransactions),
      retainedExpectedMessagePairs: asNumber(artifact.retainedOverlap?.expectedMessagePairs),
      manifestAggregateHash: manifest.aggregateSha256 || null,
      manifestRunId: manifest.runId || null,
    },
    economics: { bestNetUsd: null, exactEconomics: null },
    topRows: [],
    blockers: [
      "Mintscan access is TOKEN_AUTH_BLOCKED with MINTSCAN_TOKEN_SCOPE_REJECTED (401); API keys are PENDING",
      "No active Mintscan token carrying tx-detail/account-history scope; rerun once an ACTIVE scoped key is available",
      "Known-seed enumeration and global transaction collection are NOT_ESTABLISHED_FAIL_CLOSED",
      "Production exposure remains UNKNOWN/COVERAGE_OPEN; Step 9 VULNERABLE/CONDITIONAL-HIGH is not downgraded",
      "Closure is ineligible until a complete pre-retention transaction/event index or authoritative import ledger is available",
    ],
    requiredForRoutePositive: [
      "ACTIVE Mintscan API token with tx-detail and account-history scope",
      "complete independent pre-retention transaction/event index or authoritative import ledger",
      "or independently complete historical signer roster plus exhaustive exact-filter account histories and transaction-detail reconciliation",
      "separate complete MsgExec enumeration/decoding or complete global transaction source for authz closure",
      "exact decoding and reconciliation of all MsgAddCovenantSigs and quorum transitions before the retention boundary",
      "live extraction/replay/signing path against current state after the fix window, with fork/local proof before any signed action",
    ],
    nextReadOnlyStep:
      "Keep Babylon as required-active-closeout/incomplete: wait for ACTIVE Mintscan key with tx-detail/account-history scope and rerun once; otherwise rotate to an unrelated unclosed exploit-class branch. No signatures, no live mutation, no deployment.",
    sourceArtifacts: [
      "reports/raw/fast/babylon-mintscan-pre-retention-enumerator.json",
      "reports/raw/fast/babylon-mintscan-pre-retention-enumerator.manifest.json",
      "reports/babylon-mintscan-pre-retention-enumerator.md",
      "reports/babylon-mintscan-pre-retention-enumerator-definitions.md",
      "reports/babylon-mintscan-pre-retention-enumerator-sources.md",
      "coordination/handoffs/2026-07-18-critical-babylon-step11-mintscan-handoff.md",
      "coordination/inbox/critical/2026-07-18-critical-babylon-step11-mintscan.json",
    ],
  });
}

function criticalUnitProxyControlCandidate(artifact = {}, manifest = {}) {
  const classification = artifact.classification || "UNCLASSIFIED";
  const subbranchClean = /SUBBRANCH-ONLY CLEAN/i.test(classification);
  const gates = artifact.gates || {};
  const pin = artifact.pin || {};
  const proxies = Array.isArray(artifact.proxies) ? artifact.proxies : [];
  const implementationGroups = artifact.runtimeComparison?.implementation?.groups || [];
  const unresolvedInterfaces = artifact.unresolvedInterfaces || [];
  const openDomains = [
    "guardian/exactly-once processing",
    "conversion conservation",
    "reserve/liability reconciliation",
    "alternate control interfaces",
    "source semantics",
  ];
  return rankCandidate({
    id: "critical-unit-proxy-control-sweep",
    protocol: "Unit / Hyperunit",
    chain: "HyperEVM",
    surface: "Six-proxy initializer/UUPS control probe (subbranch clean)",
    status: subbranchClean ? "subbranch-clean-overall-unit-incomplete-watch" : "revisit-proxy-control-gate",
    priorityScore: subbranchClean ? 82 : 50,
    routePositive: 0,
    forkGate: "blocked-subbranch-clean-overall-unit-coverage-open",
    coverageOpen: true,
    closureEligible: false,
    historicalCoverageComplete: false,
    sourceRuntimeEquivalence: false,
    distance: {
      classification,
      subbranchClosed: artifact.closeSubbranch === true,
      proxiesProbed: proxies.length,
      codeBoundCount: proxies.filter((p) => p.codeBound === true).length,
      initializeProbeGatedCount: proxies.filter((p) => p.controls?.initialize?.classification === "already-initialized").length,
      upgradeProbeGatedCount: proxies.filter((p) => p.controls?.upgradeToAndCall?.classification === "authorization").length,
      uniqueImplementationHashes: asNumber(artifact.runtimeComparison?.implementation?.uniqueImplementationHashes),
      implementationHashesIdentical: artifact.runtimeComparison?.implementation?.allCoveredImplementationsRuntimeIdentical === true,
      unresolvedInterfaces: unresolvedInterfaces.length,
      rpcReads: asNumber(artifact.rpcReadCount),
      rpcReadCap: asNumber(artifact.rpcReadCap),
      blockNumberBound: pin.postPinReadTag === "block-number",
      eip1898HashTaggedReads: pin.eip1898HashTaggedReads === true,
      terminalHashRechecked: pin.terminalHashRechecked === true,
      manifestAggregateHash: manifest.aggregateSha256 || null,
      manifestRunId: manifest.runId || null,
      openDomains,
    },
    economics: { bestNetUsd: null, exactEconomics: null },
    topRows: proxies.slice(0, 6).map((p) => ({
      symbol: p.symbol || null,
      proxyAddress: p.proxyAddress || null,
      implementationAddress: p.implementationAddress || null,
      owner: p.views?.owner?.decoded || null,
      hyperCoreDeployer: p.views?.hyperCoreDeployer?.decoded || null,
      decimals: p.views?.decimals?.decoded || null,
      initializeClassification: p.controls?.initialize?.classification || null,
      upgradeClassification: p.controls?.upgradeToAndCall?.classification || null,
      codeBound: p.codeBound === true,
    })),
    blockers: [
      "Proxy-control subbranch is clean: all six proxies are code-bound and initialize/upgrade probes are gated",
      "Overall Unit remains INCOMPLETE/WATCH because guardian/exactly-once processing, conversion conservation, reserve/liability reconciliation, alternate control interfaces, and source semantics are unresolved",
      "Implementation runtime hashes differ across symbols; semantic/interface differences beyond retained calls remain unresolved without source/build equivalence",
      `Unresolved interfaces/runtime differences: ${unresolvedInterfaces.join("; ") || "none"}`,
      "No asset-loss route or economic execution is established by these read-only control probes",
    ],
    requiredForRoutePositive: [
      "prove overall Unit guardian/indexer exactly-once processing and source/spec semantics",
      "reconcile same-timestamp reserve/liability across Bitcoin/Ethereum/Solana/Plasma/Monad domains",
      "establish Core/EVM decimal conversion conservation and alternate control interfaces",
      "resolve UXPL hyperCoreDeployer revert and implementation-hash/source equivalence",
      "demonstrate exact positive route economics joined to acquisition, accepted value, and exit liquidity",
      "fork/local proof before any signed action",
    ],
    nextReadOnlyStep:
      "Proxy-control subbranch is closed; continue read-only work on overall Unit domains (guardian, conversion conservation, reserve/liability reconciliation, alternate controls, source semantics). Reopen control probing only if implementation drift or new authoritative source changes the gated outcome.",
    sourceArtifacts: [
      "reports/raw/fast/critical-unit-proxy-control.json",
      "reports/raw/fast/critical-unit-proxy-control-manifest.json",
      "reports/critical-unit-proxy-control.md",
    ],
  });
}

function lrtOracleDriftCandidate(inventory = {}, premiumProbe = {}) {
  const invSummary = inventory.summary || {};
  const premiumSummary = premiumProbe.summary || {};
  const premiumRows = Array.isArray(premiumProbe.topRows) ? premiumProbe.topRows : [];
  const routePositive = routePositiveMax(invSummary.routePositive, premiumSummary.routePositive, premiumProbe.safety?.routePositive);
  const watchCandidates = asNumber(invSummary.watchCandidates) || 0;
  const rowsScanned = asNumber(invSummary.rowsScanned) || 0;
  const rowsProbed = asNumber(premiumSummary.rowsProbed) || 0;
  const positivePremiumRows = asNumber(premiumSummary.positivePremiumRows) || 0;
  const preforkPremiumPositiveRows = asNumber(premiumSummary.preforkPremiumPositiveRows) || 0;
  const bestPremiumRow = maxBy(premiumRows, (row) => row.premiumBps ?? -Infinity);
  const bestNetRow = maxBy(premiumRows, (row) => row.economics?.estimatedNetUsd ?? -Infinity);
  const bestLiquidityRow = maxBy(premiumRows, (row) => row.routeLiquidityUsd ?? -Infinity);
  const priorityScore = 35
    + (routePositive > 0 ? 25 : 0)
    + clamp(watchCandidates / 20, 0, 1) * 5
    + clamp(rowsScanned / 45, 0, 1) * 4
    + (premiumProbe.generatedAt ? 3 : 0)
    + (positivePremiumRows > 0 ? 6 : 0)
    + (preforkPremiumPositiveRows > 0 ? 8 : 0);

  return rankCandidate({
    id: "lrt-oracle-drift-inventory-sweep",
    protocol: "LRT/LST lending",
    chain: "Ethereum",
    surface: "LRT/LST multi-protocol collateral inventory with oracle drift gates",
    status: routePositive > 0
      ? "route-positive-needs-fork-proof"
      : premiumProbe.generatedAt
        ? "lrt-premium-probe-route-negative"
        : "lrt-morpho-watch-needs-oracle-verification",
    priorityScore,
    routePositive,
    distance: {
      watchCandidates,
      researchRows: rowsScanned + rowsProbed,
      morphoRows: asNumber(invSummary.morphoRows) || 0,
      aaveRows: asNumber(invSummary.aaveRows) || 0,
      eulerRows: asNumber(invSummary.eulerRows) || 0,
      rowsProbed,
      positivePremiumRows,
      preforkPremiumPositiveRows,
      routePositive,
      summary: {
        ...Object.fromEntries(Object.entries(invSummary).filter(([, value]) => typeof value !== "object").slice(0, 12)),
        premiumProbeRows: rowsProbed,
        positivePremiumRows,
        preforkPremiumPositiveRows,
      },
    },
    economics: {
      bestPremiumBps: round(bestPremiumRow?.premiumBps, 4),
      bestRequiredPremiumBps: round(bestPremiumRow?.economics?.requiredPremiumBps, 4),
      bestPremiumGapBps: round(bestPremiumRow?.economics?.premiumGapBps, 4),
      bestEstimatedNetUsd: round(bestNetRow?.economics?.estimatedNetUsd, 6),
      bestLiquidityUsd: round(bestLiquidityRow?.routeLiquidityUsd, 2),
    },
    topRows: (premiumProbe.generatedAt ? premiumRows : (inventory.topRows || [])).slice(0, 5).map((row) => ({
      protocol: row.protocol || null,
      collateral: row.collateral?.symbol || row.collateralSymbol || null,
      loanAsset: row.borrowAsset?.symbol || row.loanAsset?.symbol || row.loanSymbol || null,
      lltv: round(row.lltv, 4),
      liquidityUsd: round(row.routeLiquidityUsd ?? row.liquidityUsd, 2),
      premiumBps: round(row.premiumBps, 4),
      requiredPremiumBps: round(row.economics?.requiredPremiumBps, 4),
      premiumGapBps: round(row.economics?.premiumGapBps, 4),
      estimatedNetUsd: round(row.economics?.estimatedNetUsd, 6),
      routePositive: Boolean(row.routePositive),
      blocker: Array.isArray(row.blockers) ? row.blockers[0] : row.blocker || null,
    })),
    blockers: routePositive > 0
      ? ["Needs fork extraction proof before any signed action"]
      : premiumProbe.generatedAt
        ? [premiumSummary.blocker || "No LRT row clears LLTV break-even and cost gates", "Premium probe found no positive-premium row", "No fork-positive oracle drift proof"]
        : ["Morpho LRT markets have material liquidity but oracle premium is not yet verified", "Aave V3 LRT reserves have borrowing disabled", "Euler EVK returned 0 LRT in LTV lists", "No fork-positive oracle drift proof"],
    requiredForRoutePositive: [
      "Morpho LRT oracle overvalues collateral relative to exact acquisition market value",
      "premium clears LLTV break-even plus slippage, flash fee, gas, and min-profit gates",
      "borrow-side liquidity is material and unpaused",
      "fork extraction proof demonstrates positive net value",
    ],
    nextReadOnlyStep: routePositive > 0
      ? "Fork-proof the top premium-positive LRT market before any live action."
      : "Keep LRT markets on watch; rerun premium probe only when oracle/market premium approaches LLTV break-even or liquidity materially changes.",
    sourceArtifacts: ["reports/raw/fast/lrt-oracle-drift-routes.json", "reports/raw/fast/lrt-oracle-premium-probe.json"],
  });
}

function criticalEtherfiDefaultModuleCapabilityCandidate(artifact = {}, manifest = {}, binding = {}, bindingManifest = {}, pendingTuple = {}, pendingTupleManifest = {}, stargateInvariant = {}, stargateInvariantManifest = {}, configDrift = {}, configDriftManifest = {}, unknownIdentity = {}, unknownIdentityManifest = {}, recoveryInvariant = {}, recoveryInvariantManifest = {}, behypeInvariant = {}, behypeInvariantManifest = {}, behypeBinding = {}, behypeBindingManifest = {}, endpointCoverage = {}, endpointCoverageManifest = {}, selectedLibrary = {}, selectedLibraryManifest = {}, receiveType1 = {}, receiveType1Manifest = {}, hyperDiagnostic = {}, hyperDiagnosticManifest = {}, stateCanary = {}, stateCanaryManifest = {}, behavioralCapture = {}, behavioralCaptureManifest = {}, retryCapture = {}, retryCaptureManifest = {}) {
  const pin = artifact.pin || {};
  const coverage = artifact.reviewCoverage || {};
  const deployment = artifact.deployment || {};
  const probes = artifact.probeSemantics || {};
  const localVerification = artifact.localVerification || {};
  const sourceClosure = artifact.source?.closure || {};
  const matrix = Array.isArray(artifact.authorizationMatrix) ? artifact.authorizationMatrix : [];
  const scopedModules = Array.isArray(coverage.scopedModuleNames) ? coverage.scopedModuleNames : [];
  const identifiedDefaults = Array.isArray(deployment.identifiedDefaults) ? deployment.identifiedDefaults : [];
  const unidentifiedDefaults = Array.isArray(deployment.unidentifiedDefaults) ? deployment.unidentifiedDefaults : [];
  const bindingComponents = Array.isArray(binding.componentResults) ? binding.componentResults : [];
  const immutableCoverage = binding.dependencies?.immutableProvenanceCoverage || {};
  const closureLinkage = binding.source?.closureBuildLinkage || {};
  const selectedPending = pendingTuple.selected || {};
  const pendingChecks = selectedPending.comparison?.checks || {};
  const pendingCoverage = pendingTuple.searchCoverage || {};
  const pendingGuards = pendingTuple.deployedSemanticsBinding?.guardSemantics || {};
  const invariantChecks = stargateInvariant.semantics?.checks || {};
  const invariantTests = stargateInvariant.testResults?.tests || {};
  const configHistory = configDrift.historyCoverage?.moduleConfigHistory || {};
  const retainedConfigWindow = configDrift.historyCoverage?.retainedWindow || {};
  const selectedConfigs = configDrift.selectedRequest?.configs || {};
  const unknownModules = Array.isArray(unknownIdentity.modules) ? unknownIdentity.modules : [];
  const recoveryObservations = Array.isArray(recoveryInvariant.observations) ? recoveryInvariant.observations : [];
  const behypeObservations = Array.isArray(behypeInvariant.observations) ? behypeInvariant.observations : [];
  const bindingExact = binding.classification === "exact"
    && bindingComponents.length === 6
    && bindingComponents.every((row) => row.proxyComparison?.exactRuntimeEqual === true)
    && bindingComponents.every((row) => row.implementationComparison?.exactReconstructedEqual === true)
    && immutableCoverage.astImmutableRowCount === 12
    && immutableCoverage.independentlyBoundRowCount === 12
    && closureLinkage.scopedClosureFileCount === 80
    && closureLinkage.matchedClosureFileCount === 80
    && closureLinkage.standardJsonBuildInputSourceCount === 296;
  const pendingTupleExact = bindingExact
    && pendingTuple.classification === "exact-pending-tuple-equal"
    && pendingTuple.pin?.blockNumber === 154534581
    && pendingTuple.pin?.blockHash === "0x9e2d47b4f179b068df84fe73f11601cfa0af372d769902848222dc3a6e3c8b13"
    && pendingTuple.deployedSemanticsBinding?.exact === true
    && selectedPending.module === "StargateModule"
    && selectedPending.moduleState?.key?.safe === selectedPending.safe
    && selectedPending.cashState?.key?.safe === selectedPending.safe
    && pendingChecks.cashHasOneToken === true
    && pendingChecks.recipientIsModule === true
    && pendingChecks.assetEqual === true
    && pendingChecks.amountEqual === true
    && selectedPending.comparison?.equal === true
    && Number(selectedPending.cashState?.finalizeTime) === 1784667943
    && Number(selectedPending.cashState?.finalizeTime) > Number(pendingTuple.pin?.timestamp)
    && selectedPending.latestRequestMatchesState === true
    && selectedPending.laterNonmatchingEventExists === false
    && pendingCoverage.retainedWindowStartBlock === 154529180
    && pendingCoverage.retainedWindowEndBlock === 154534581
    && pendingCoverage.retainedLogConsensusCount === 3
    && pendingCoverage.fullModuleHistoryCovered === false
    && pendingGuards.stargateExecuteBridge?.equalityGuardPresent === true
    && pendingGuards.cashProcessWithdrawal?.finalizeTimeGuardPresent === true;
  const stargateInvariantExact = pendingTupleExact
    && stargateInvariant.classification === "PASS/BOUNDED-VALID-AUTH-TUPLE-INVARIANT"
    && stargateInvariant.pin?.chainId === 10
    && stargateInvariant.pin?.blockNumber === 154534581
    && stargateInvariant.pin?.blockHash === "0x9e2d47b4f179b068df84fe73f11601cfa0af372d769902848222dc3a6e3c8b13"
    && stargateInvariant.sourceBinding?.sourceCommitMatch === true
    && stargateInvariant.sourceBinding?.allStep1ClosureRowsExact === true
    && stargateInvariant.runtimeBindings?.stargate?.exactCurrentReconstructionEqualsStep2DeployedRuntime === true
    && stargateInvariant.runtimeBindings?.safeImplementation?.exactCurrentReconstructionHashEqualsPinObservedImplementation === true
    && stargateInvariant.semantics?.allChecksPass === true
    && Object.values(invariantChecks).every((value) => value === true)
    && invariantTests.testsPassed === 13
    && invariantTests.testsFailed === 0
    && invariantTests.fuzzPropertiesPassed === 2
    && invariantTests.fuzzRunsPerProperty === 256
    && invariantTests.totalFuzzCases === 512
    && stargateInvariant.safety?.localOnly === true
    && stargateInvariant.safety?.endpointInventoryRead === false
    && stargateInvariant.safety?.forkCreated === false
    && stargateInvariant.safety?.realWithdrawalExecuted === false;
  const configDriftBoundedPass = stargateInvariantExact
    && configDrift.classification === "CLEAN/PRIVILEGED-CONFIG-DRIFT-POSSIBLE-BUT-UNOBSERVED"
    && configDrift.pin?.chainId === 10
    && configDrift.pin?.blockNumber === 154534581
    && configDrift.pin?.blockHash === "0x9e2d47b4f179b068df84fe73f11601cfa0af372d769902848222dc3a6e3c8b13"
    && configDrift.source?.commitMatch === true
    && configDrift.runtimeBinding?.stargateStep2Exact === true
    && configDrift.runtimeBinding?.stargateStep3ReconstructionExact === true
    && configDrift.runtimeBinding?.roleRegistry?.proxyRuntimeExact === true
    && configDrift.runtimeBinding?.roleRegistry?.implementationRuntime?.exact === true
    && configDrift.semantics?.configMutation?.role === "STARGATE_MODULE_ADMIN_ROLE"
    && configDrift.semantics?.configMutation?.roleRequired === true
    && configDrift.semantics?.configMutation?.noPerRequestConfigSnapshot === true
    && configDrift.semantics?.signature?.commitsAsset === true
    && configDrift.semantics?.signature?.commitsPool === false
    && configDrift.semantics?.signature?.commitsRouterOrConfigIdentity === false
    && configDrift.semantics?.executeAndQuote?.executeReadsCurrentIsOFT === true
    && configDrift.semantics?.executeAndQuote?.executeReadsCurrentPool === true
    && configDrift.semantics?.executeAndQuote?.quoteReadsCurrentConfig === true
    && selectedConfigs.preRequestBlock?.blockNumber === 154534577
    && selectedConfigs.requestBlockEnd?.blockNumber === 154534578
    && selectedConfigs.pin?.blockNumber === 154534581
    && configDrift.selectedRequest?.configStablePreRequestThroughPin === true
    && configDrift.selectedRequest?.configEventsAfterRequestThroughPin?.length === 0
    && configDrift.selectedRequest?.poolIdentityStable === true
    && retainedConfigWindow.requestCount === 50
    && retainedConfigWindow.bridgeCount === 48
    && retainedConfigWindow.cancelCount === 0
    && configDrift.lifecyclePairs?.exactPairCount === 48
    && configDrift.lifecyclePairs?.configCoveredPairCount === 48
    && configDrift.lifecyclePairs?.configDriftPairCount === 0
    && configHistory.startBlock === 149807571
    && configHistory.endBlock === 154534581
    && configHistory.boundaryConsensus === true
    && configHistory.consensusCount === 2
    && Array.isArray(configHistory.boundaries)
    && configHistory.boundaries.length === 2
    && configHistory.boundaries.every((row) => row.firstPresentBlock === 149807571 && row.absentImmediatelyBefore === true)
    && Array.isArray(configHistory.providerScanSummaries)
    && configHistory.providerScanSummaries.length === 2
    && configHistory.providerScanSummaries.every((row) => row.complete === true && row.logCount === 3 && row.inConsensus === true)
    && configDrift.findings?.privilegedMutationPossible === true
    && configDrift.findings?.selectedRequestDriftObservedThroughPin === false
    && configDrift.findings?.coveredRequestExecuteDriftObserved === false
    && configDrift.findings?.concreteIntegrityOrEconomicIssueEstablished === false;
  const unknownIdentityExact = configDriftBoundedPass
    && unknownIdentity.classification === "EXACT/IDENTIFIED-DIRECT-MODULES"
    && unknownIdentity.pin?.chainId === 10
    && unknownIdentity.pin?.blockNumber === 154548072
    && unknownIdentity.pin?.blockHash === "0x8b474465bf8cc9a5d8e11743942473e9c5bedbd751114e733c69994d4e08b125"
    && unknownIdentity.pin?.finalizedSelected === true
    && unknownIdentity.providerCoverage?.finalizedPinAgreementCount === 3
    && unknownIdentity.providerCoverage?.fullStateDigestMatchCount === 2
    && unknownIdentity.providerCoverage?.fullStateDigestProviderCount === 3
    && unknownIdentity.providerCoverage?.fullStateDigestThresholdMet === true
    && unknownIdentity.providerCoverage?.allFinalizedProvidersMatchedFullStateDigest === false
    && unknownModules.length === 2
    && unknownModules.some((row) => row.name === "BeHYPEStakeModule" && row.address === "0xd12efd5067DE109F9D00e1A31a34991d58DbB9F3")
    && unknownModules.some((row) => row.name === "SafeAssetRecoveryModule" && row.address === "0x0AD7FDf0ED3BF0943753047B7C8F0922c624A6F2")
    && unknownModules.every((row) => row.isDefault === true && row.isWhitelisted === true && row.structure?.direct === true && row.structure?.implementation === null && row.structure?.beacon === null && row.reconstruction?.exact === true)
    && unknownIdentity.findings?.bothRemainReturnedDefaults === true
    && unknownIdentity.findings?.bothRemainWhitelisted === true
    && unknownIdentity.findings?.bothDirectNonProxyNonBeaconNonClone === true
    && unknownIdentity.findings?.bothExactSourceRuntimeReconstructed === true
    && unknownIdentity.findings?.safeRecoveryExactCreationTransactionAttribution === false
    && unknownIdentity.findings?.safeRecoveryBoundaryAndBuildIdentitySupport === true
    && unknownIdentity.findings?.beHYPERefundRiskClassification === "PRIVILEGED/REFUND-AVAILABILITY-RISK-ONLY"
    && unknownIdentity.findings?.beHYPERefundOutsiderLossEstablished === false
    && unknownIdentity.findings?.vulnerabilityOrLossEstablished === false;
  const recoveryInvariantBoundedPass = unknownIdentityExact
    && recoveryInvariant.classification === "PASS/BOUNDED-VALID-AUTH-FULL-BALANCE-INVARIANT"
    && recoveryInvariant.revision === "safe-asset-recovery-invariant-step2-reviewer-r2"
    && recoveryInvariant.predecessor?.runId === unknownIdentity.runId
    && recoveryInvariant.predecessor?.immutablePatchedRuntimeExact === true
    && recoveryInvariant.localHarness?.exactProductionModuleSource === true
    && recoveryInvariant.localHarness?.completeProductionSafeAuthorizationProof === false
    && recoveryInvariant.tests?.sourceFunctionCount === 35
    && recoveryInvariant.tests?.passedFunctionCount === 35
    && recoveryInvariant.tests?.fuzzCaseCount === 128
    && recoveryInvariant.tests?.supportedOverlapLocalCaseCount === 7
    && recoveryInvariant.tests?.totalExecutedCasesIncludingOverlapLoop === 168
    && recoveryInvariant.foundry?.semanticReplayEqual === true
    && recoveryInvariant.findings?.unauthorizedPathFound === false
    && recoveryInvariant.findings?.allSignedFieldsBound === true
    && recoveryInvariant.findings?.fullCurrentBalanceSemantics === true
    && recoveryInvariant.findings?.arbitraryTargetOrCalldataFound === false
    && recoveryInvariant.findings?.permissionlessLossEstablished === false
    && recoveryInvariant.findings?.profitablePathEstablished === false
    && recoveryInvariant.scopeQualifications?.completeProductionSafeAuthorizationProof === false
    && recoveryInvariant.safety?.localOnly === true
    && recoveryInvariant.safety?.rpcUsed === false
    && recoveryInvariant.safety?.deployedRecoverCalled === false
    && recoveryInvariant.safety?.forkCreated === false
    && recoveryInvariant.safety?.liveSigning === false
    && recoveryObservations.some((row) => row.id === "SAR-I01" && row.classification === "DOCUMENTATION-MISMATCH" && row.permissionlessExploit === false)
    && recoveryObservations.some((row) => row.id === "SAR-I02" && row.classification === "OWNER-AUTHORIZED/INTEGRATION-ACCOUNTING-CAVEAT" && row.permissionlessExploit === false)
    && recoveryObservations.some((row) => row.id === "SAR-I03" && row.classification === "DOCUMENTED/OPERATIONAL-AVAILABILITY-CONSTRAINT" && row.permissionlessExploit === false)
    && recoveryInvariantManifest.aggregateSha256 === "e92c0396030c72e74739a03ea741ab7e360c182ff74c7a6d0458afa83ee579c3";
  const behypeInvariantBoundedPass = recoveryInvariantBoundedPass
    && behypeInvariant.classification === "PASS/BOUNDED-VALID-ADMIN-FEE-REFUND-DELIVERY-INVARIANT/EXTERNAL-INTEGRATIONS-OPEN"
    && behypeInvariant.revision === "behype-fee-refund-delivery-invariant-step3-r1"
    && behypeInvariant.predecessor?.runId === unknownIdentity.runId
    && behypeInvariant.predecessor?.immutablePatchedRuntimeExact === true
    && behypeInvariant.localHarness?.exactProductionModuleSource === true
    && behypeInvariant.scopeQualifications?.completeDeployedSystemProof === false
    && behypeInvariant.tests?.sourceFunctionCount === 45
    && behypeInvariant.tests?.passedFunctionCount === 45
    && behypeInvariant.tests?.fuzzCaseCount === 256
    && behypeInvariant.tests?.totalExecutedCases === 300
    && behypeInvariant.foundry?.semanticReplayEqual === true
    && behypeInvariant.source?.semantics?.digestBindsChainModuleNonceSafeAmount === true
    && behypeInvariant.source?.semantics?.singleSafeAdminSigner === true
    && behypeInvariant.source?.semantics?.callerFundsQuoteThroughSafe === true
    && behypeInvariant.source?.semantics?.excessRefundedToCaller === true
    && behypeInvariant.source?.semantics?.fixedReceiverSafe === true
    && behypeInvariant.source?.semantics?.fixedTargetsAndApprovalReset === true
    && behypeInvariant.findings?.unauthorizedAuthorizationBypassFound === false
    && behypeInvariant.findings?.arbitraryCallerResidueCaptureFound === false
    && behypeInvariant.findings?.exactLocalUnauthorizedResidueCaptureGainWei === "0"
    && behypeInvariant.findings?.relayerCanRedirectReceiver === false
    && behypeInvariant.findings?.immediateModuleCallerReceivesOnlyCurrentCallExcess === true
    && behypeInvariant.findings?.safeEthPrincipalChanged === false
    && behypeInvariant.findings?.allowanceResetAfterSuccess === true
    && behypeInvariant.findings?.healthFailureAtomicRollback === true
    && behypeInvariant.findings?.permissionlessLossEstablished === false
    && behypeInvariant.findings?.profitablePathEstablished === false
    && behypeInvariant.safety?.localOnly === true
    && behypeInvariant.safety?.rpcUsed === false
    && behypeInvariant.safety?.deployedStakeCalled === false
    && behypeInvariant.safety?.forkCreated === false
    && behypeInvariant.safety?.liveSigning === false
    && behypeObservations.some((row) => row.id === "BH-I01" && row.classification === "DOCUMENTATION-MISMATCH/PRIVILEGED-REFUND-AVAILABILITY-RISK-ONLY" && row.permissionlessExploit === false)
    && behypeObservations.some((row) => row.id === "BH-I02" && row.classification === "OWNER-AUTHORIZED/EXTERNAL-STAKER-DELIVERY-TRUST-CAVEAT" && row.permissionlessExploit === false)
    && behypeObservations.some((row) => row.id === "BH-I03" && row.classification === "OWNER-AUTHORIZED/INTEGRATION-EVENT-ACCOUNTING-CAVEAT" && row.permissionlessExploit === false)
    && behypeObservations.some((row) => row.id === "BH-I04" && row.classification === "NONCAPTURABLE-RESIDUE/NO-SWEEP-PATH-OBSERVED" && row.permissionlessExploit === false)
    && behypeInvariantManifest.aggregateSha256 === "65b38a1c8acd6fc5a546e47a3b7673ffdd8b881432eae2c60bf2d58b91d9fcb8";
  const behypeBindingCoverageOpen = behypeInvariantBoundedPass
    && behypeBinding.classification === "INCOMPLETE/WATCH/EXACT-STAKER-RECEIVER-BINDING/ACCESS-COVERAGE_OPEN/OPTIMISM-TERMINAL-RECHECK-GAPPED/DESTINATION-SINGLE-PROVIDER"
    && behypeBinding.revision === "behype-staker-layerzero-binding-step4-reviewer-r2"
    && behypeBinding.captureProvenance?.predecessorStep3RunId === behypeInvariant.runId
    && behypeBinding.pin?.chainId === 10
    && behypeBinding.pin?.blockNumber === 154552969
    && behypeBinding.pin?.blockHash === "0x35aca493986e10237f0a45ddfde6e37ce947eb1b09df5ff3b5c6351fcb93cd91"
    && behypeBinding.pin?.finalizedSelected === true
    && behypeBinding.pin?.terminalSameNumberHashVerified === false
    && behypeBinding.pin?.terminalSameNumberHashMatchCount === 1
    && behypeBinding.pin?.terminalSameNumberHashThreshold === 2
    && behypeBinding.providerCoverage?.optimism?.finalizedConsensusCount === 3
    && behypeBinding.providerCoverage?.optimism?.stateConsensusCount === 2
    && behypeBinding.providerCoverage?.optimism?.archiveHistoryConsensusCount === 2
    && behypeBinding.providerCoverage?.destination?.stateConsensusCount === 1
    && behypeBinding.providerCoverage?.destination?.historyConsensusCount === 1
    && behypeBinding.providerCoverage?.destination?.multiProviderConsensus === false
    && behypeBinding.currentBindings?.l2Staker?.sourceRuntimeExact === true
    && behypeBinding.currentBindings?.destinationReceiver?.sourceRuntimeExact === true
    && behypeBindingManifest.localExactBuildRuntimeScope?.length === 4
    && behypeBindingManifest.adapterExplorerRuntimeBoundWithoutEqualLocalRebuild === true
    && behypeBindingManifest.fullRouteLocalExactBuildRuntimeBound === false
    && behypeBinding.history?.destination?.evidenceQualification === "single-provider event evidence; not delivery-finality proof"
    && behypeBinding.findings?.permissionlessDirectStakerCallsObserved === true
    && behypeBinding.findings?.destinationFeeSubsidyPermissionlessReachable === true
    && behypeBinding.findings?.publicWholeBalanceDeliveryCanIncludePriorBehypeResidue === true
    && behypeBinding.findings?.directNativePayoutToCallerFound === false
    && behypeBinding.findings?.permissionlessArbitrarySweepFound === false
    && behypeBinding.findings?.currentCompleteProfitableRouteEstablished === false
    && behypeBinding.findings?.permissionlessProtocolLossEstablished === false
    && behypeBinding.findings?.destinationDeliveryFinalityProven === false
    && behypeBinding.findings?.unmatchedDestinationComposeClassification === "unresolved/pending-or-failed-observation"
    && behypeBinding.providerCoverage?.repairAttempt?.economicsAttempted === false
    && behypeBinding.safety?.stakeCalled === false
    && behypeBinding.safety?.messageSent === false
    && behypeBinding.safety?.forkCreated === false
    && behypeBinding.safety?.signingUsed === false
    && behypeBindingManifest.aggregateSha256 === "713032351d1b6e00c0d3234f538a7836295fb1e266a569bd37d4b3224bc076b1";
  const endpointCoverageR5Final = behypeBindingCoverageOpen
    && endpointCoverage.classification === "ACCESS/COVERAGE_OPEN/OFFLINE-DIAGNOSTICS-FINAL/R3-INVENTORY-SNAPSHOT-TESTING-STOPPED"
    && endpointCoverage.revision === "etherfi-behype-endpoint-coverage-repair-reviewer-r5-offline-final"
    && endpointCoverage.safety?.offlineOnly === true
    && endpointCoverage.safety?.endpointInventoriesReadThisRun === false
    && endpointCoverage.safety?.networkCalls === false
    && endpointCoverage.safety?.endpointValuesPersisted === false
    && endpointCoverage.safety?.economicsCalls === false
    && endpointCoverage.immutableInputs?.copiedByteForByteBeforeMutableOverwrite === true
    && endpointCoverage.provenance?.derivedFromImmutableR4Inputs === true
    && endpointCoverage.provenance?.r4WasOfflineDiagnosticDerivationOfR3TestedSnapshot === true
    && endpointCoverage.provenance?.originalR3MutableArtifactsAvailable === false
    && endpointCoverage.optimism?.readiness?.minimalCoreProviderFamilyConsensusReady === true
    && endpointCoverage.optimism?.readiness?.configExtensionProviderFamilyConsensusReady === false
    && endpointCoverage.optimism?.readiness?.fullTupleProviderFamilyConsensusReady === false
    && endpointCoverage.optimism?.metrics?.minimalCoreConsensusProviderFamilyGroups === 2
    && endpointCoverage.optimism?.metrics?.anchorWindowDigestEqualityProviderFamilyGroups >= 2
    && endpointCoverage.providerFamilyConsensusReadiness?.hyperevm?.minimalCoreProviderFamilyConsensusReady === false
    && endpointCoverage.providerFamilyConsensusReadiness?.hyperevm?.configExtensionProviderFamilyConsensusReady === false
    && endpointCoverage.providerFamilyConsensusReadiness?.hyperevm?.fullTupleProviderFamilyConsensusReady === false
    && endpointCoverage.disposition?.optimism === "TWO-FAMILY-MINIMAL-CORE-PLUS-ANCHOR-CONSENSUS-ONLY/CONFIG-AND-FULL-UNRESOLVED"
    && endpointCoverage.disposition?.hyperevm === "ONE-FAMILY-CORE-OBSERVATION-ONLY/CONFIG-AND-FULL-UNRESOLVED/NO-SECOND-FAMILY-IN-R3-TESTED-INVENTORY-SNAPSHOT"
    && endpointCoverage.graphql?.finalityUseful === 0
    && endpointCoverage.providerFamilyConsensusReadiness?.bothFullTuple === false
    && endpointCoverageManifest.backendOrOperatorIndependenceClaimed === false
    && endpointCoverageManifest.failureSummaryCountSemanticsWarning === "Failure-summary counts are aggregate per-field incidences, not unique providers/families and cannot be compared to chain-level Families."
    && endpointCoverageManifest.aggregateSha256 === "379f8022d2f8b0fab47439f8b55535cf80662fdd10ccbc471794eade797c2551";
  const receiveType1R8Current = behypeBindingCoverageOpen
    && endpointCoverage.runId === "etherfi-behype-endpoint-coverage-r6-9ecd47738575f124-9bcf58578f5d"
    && selectedLibrary.runId === "etherfi-behype-selected-library-r7-47dc893bdbb47d85f77d-c713be7385c1"
    && selectedLibrary.rejectedPredecessorR6?.status === "REJECTED/SUPERSEDED-FOR-SELECTED-LIBRARY-FAMILY-INFERENCE"
    && selectedLibraryManifest.aggregateSha256 === "8ff0d2f557895200b2e37fccd15a98654ad8107bd25c49cc22340d3d8a24fa6c"
    && receiveType1.classification === "WATCH/COVERAGE_OPEN/OPTIMISM-RECEIVE-TYPE1-NEGATIVE-SEMANTICS-BOUND/HYPEREVM-UNOBSERVED/NO-BACKEND-INDEPENDENCE-CLAIM"
    && receiveType1.revision === "etherfi-behype-receive-type1-negative-check-r8-r2-reviewer-wording-offline"
    && receiveType1.immutablePredecessorR7?.status === "IMMUTABLE-PREDECESSOR/SELECTED-LIBRARY-R7"
    && receiveType1.pin?.blockNumber === 154576710
    && receiveType1.pin?.blockHash === "0xbe73ab02b779223c5a3a47e2d45cc8258c0c264dd82791f9d1e1baec5358e149"
    && receiveType1.behavioralConsensusReady === true
    && receiveType1.metrics?.completeFamilies === 2
    && receiveType1.consensus?.selection === 2
    && receiveType1.consensus?.codeVersion === 2
    && receiveType1.consensus?.config === 2
    && receiveType1.consensus?.state === 2
    && receiveType1.consensus?.negativeType1 === 2
    && receiveType1.backendOperatorIndependenceClaimed === false
    && receiveType1.backendOperatorIndependenceEstablished === false
    && receiveType1.providerFamilyQualification === "The two agreeing groups are observed hostname-derived provider-family groups; backend/operator independence is not established."
    && receiveType1.officialLayerZero?.exactOfficialRuntimeEquivalence === null
    && receiveType1.officialLayerZero?.qualification === "behavioral binding only"
    && receiveType1.expectedReceiveType1Semantics?.errorSignature === "LZ_ULN_InvalidConfigType(uint32)"
    && receiveType1.expectedReceiveType1Semantics?.argument === 1
    && receiveType1.hyperevm?.familyCount === 0
    && receiveType1.hyperevm?.observedThisRun === false
    && receiveType1.hyperevm?.status === "COVERAGE_OPEN/NO-DATA-INVENTED"
    && receiveType1.gates?.economicsBlocked === true
    && receiveType1.gates?.bothChainsComplete === false
    && receiveType1.reviewerCorrection?.offlineOnly === true
    && receiveType1.safety?.endpointInventoriesReadThisRun === false
    && receiveType1.safety?.networkCalls === false
    && receiveType1.safety?.forkCreated === false
    && receiveType1.safety?.signing === false
    && receiveType1Manifest.aggregateSha256 === "d92d80e872a02e944654305730e688523a09434eaa7c061d319ef4f217216707";
  const hyperDiagnosticR10R2Current = receiveType1R8Current
    && hyperDiagnostic.classification === "WATCH/COVERAGE_OPEN/HYPEREVM-SOLE-FAMILY-FULL-BEHAVIORAL-OBSERVATION/PROVISIONAL-FINALITY/NO-BACKEND-INDEPENDENCE-CLAIM"
    && hyperDiagnostic.runId === "etherfi-behype-hyperevm-diagnostic-r10-r2-8a1a3f7b31ae7fc4d6b2-6e488ac40cf2"
    && hyperDiagnostic.immutablePredecessorR8?.status === "IMMUTABLE-PREDECESSOR/OPTIMISM-R8-R2"
    && hyperDiagnostic.immutablePredecessorR9?.status === "IMMUTABLE-PREDECESSOR/HYPEREVM-R9"
    && hyperDiagnostic.immutablePredecessorR10?.status === "IMMUTABLE-PREDECESSOR/HYPEREVM-R10"
    && hyperDiagnostic.families?.length === 1
    && hyperDiagnostic.families?.[0]?.complete === true
    && hyperDiagnostic.families?.[0]?.familyClass === "declared-official-public"
    && hyperDiagnostic.families?.[0]?.routeCompleteCount === 2
    && hyperDiagnostic.metrics?.completeRouteCount === 2
    && hyperDiagnostic.metrics?.exactPinFamilies === 1
    && hyperDiagnostic.metrics?.exactPinProviders === 1
    && hyperDiagnostic.gates?.hyperRoutesDiagnosticallyComplete === true
    && hyperDiagnostic.gates?.crossFamilyConsensus === false
    && hyperDiagnostic.gates?.reviewedTwoChainConsensus === false
    && hyperDiagnostic.gates?.economicsBlocked === true
    && hyperDiagnostic.pin?.qualification === "sole-family-provisional-reported-finalized-candidate"
    && hyperDiagnostic.pin?.crossFamilyFinalityConsensus === false
    && hyperDiagnostic.pin?.crossFamilyHashConsensus === false
    && hyperDiagnostic.backendOperatorIndependenceClaimed === false
    && hyperDiagnostic.backendOperatorIndependenceEstablished === false
    && hyperDiagnosticManifest.reportPresentation?.some((row) => row.routeLabel === "behype-send-30111" && row.routeComplete === true && row.directionNotApplicable?.includes("receive-type1-negative"))
    && hyperDiagnosticManifest.reportPresentation?.some((row) => row.routeLabel === "whype-receive-30111" && row.routeComplete === true && row.successfulEvidence?.includes("receive-type1-negative"))
    && hyperDiagnostic.offlineCorrectionR2?.endpointInventoryReads === false
    && hyperDiagnostic.offlineCorrectionR2?.networkCalls === false
    && hyperDiagnostic.safety?.forkCreated === false
    && hyperDiagnostic.safety?.signing === false
    && hyperDiagnosticManifest.aggregateSha256 === "6cb5ad2fc506f4919a6b13c90e74e1170410d6bc255c6a1d3e58534e47ff269e";
  const stateCanaryFamilies = Array.isArray(stateCanary.anonymousFamilies) ? stateCanary.anonymousFamilies : [];
  const strictStateCanaryFamilies = stateCanaryFamilies.filter((row) => row.assessmentStatus === "strict-qualified");
  const zeroEligibleStateCanaryFamilies = stateCanaryFamilies.filter((row) => row.eligibleEndpointCount === 0);
  const stateCanaryR14R3Current = hyperDiagnosticR10R2Current
    && stateCanary.classification === "WATCH/R14-R3-PASS/HYPEREVM-STRICT-NONVACUOUS-ALL-ELIGIBLE-ENDPOINT-EIGHT-CANARY-THRESHOLD/BEHAVIORAL-REQUALIFICATION-MAY-BE-PROPOSED/NO-BACKEND-INDEPENDENCE-CLAIM"
    && stateCanary.runId === "etherfi-hyperevm-state-canary-r14-r3-d489e40374a8f5aa4b446fb731018908d48662de7c65e4ecaa745ecd8c906fee-8fab5e6b9063f3c25495f8efc796fcc23f6765efbead022eb1bb9e071ba3b322"
    && stateCanary.revision === "etherfi-hyperevm-state-canary-r14-r3-nonvacuous-family-assessment"
    && stateCanary.predecessorBinding?.status === "IMMUTABLE-PREDECESSOR/R14-R2-STRICT-QUALIFICATION"
    && stateCanary.matrix?.stateCanaryCount === 8
    && stateCanary.matrix?.exactEqualityCheckCount === 7
    && stateCanary.matrix?.nonEmptyDeploymentCodePredicateCount === 1
    && stateCanary.strictQualification?.status === "PASS"
    && stateCanary.strictQualification?.strictArchiveQualifiedFamilyCount === 5
    && strictStateCanaryFamilies.length === 5
    && strictStateCanaryFamilies.every((row) => row.eligibleEndpointCount > 0 && row.eligibleFailingEndpointCount === 0 && row.passingEndpointCount === row.eligibleEndpointCount && row.strictArchiveQualified === true && row.matrixBoundObservedResultCommitment && row.matrixBoundObservedResultCommitmentsInternallyConsistent === true)
    && stateCanary.familyAssessment?.zeroEligibleConsistencyNullCount === 98
    && zeroEligibleStateCanaryFamilies.length === 98
    && zeroEligibleStateCanaryFamilies.every((row) => row.assessmentStatus === "not-assessed" && row.matrixBoundObservedResultCommitmentsInternallyConsistent === null)
    && stateCanary.matrixBoundObservedResultCommitments?.independentEvidence === false
    && stateCanary.matrixBoundObservedResultCommitments?.largestStrictFamilyCount === 5
    && stateCanary.backendOperatorIndependenceClaimed === false
    && stateCanary.backendOperatorIndependenceEstablished === false
    && stateCanary.behavioralRequalification?.executed === false
    && stateCanary.behavioralRequalification?.mayBeProposed === true
    && stateCanary.behavioralRequalification?.requiresSeparateReview === true
    && stateCanary.gates?.behaviorClosed === true
    && stateCanary.gates?.economicsClosed === true
    && stateCanary.safety?.behavior === false
    && stateCanary.safety?.anchors === false
    && stateCanary.safety?.economics === false
    && stateCanary.safety?.endpointReads === false
    && stateCanary.safety?.forkCreated === false
    && stateCanary.safety?.signing === false
    && stateCanaryManifest.aggregateSha256 === "2b3ccb37a959d918c0bdede1509e184d1a9caeea5de1505a33959d51dec3aad7";
  const behavioralCaptureApprovalExhausted = behavioralCapture.approval?.authorization === "exactly-one-bounded-read-only-HyperEVM-behavioral-requalification-capture"
    && behavioralCapture.approval?.approvedProposalRevision === "etherfi-behype-hyperevm-behavioral-requalification-proposal-review-only-r3"
    && behavioralCapture.originalCaptureSafety?.exactlyOneCaptureInvocation === true
    && behavioralCapture.newProposalBoundary === "A new separately scoped read-only behavioral-capture proposal may be drafted for review; r2 does not authorize another capture, endpoint access, economics, or state change.";
  const behavioralCaptureR2Current = stateCanaryR14R3Current
    && behavioralCapture.classification === "CAPTURE_INCONCLUSIVE/rate-limited/NO-PARTIAL-THRESHOLD/NO-ECONOMICS/REVIEWER-R2"
    && behavioralCapture.runId === "etherfi-behype-hyperevm-behavioral-requalification-capture-r2-ba8f3f7627cfe733579ea1463c3d503922553914d2505f5af6480c2ab540674c-3b64155cdb33f5831a2b5be44635b58756f375db67ebb6aafdd9deacc0a857a8"
    && behavioralCapture.revision === "etherfi-behype-hyperevm-behavioral-requalification-capture-reviewer-r2"
    && behavioralCapture.blockers?.length === 1
    && behavioralCapture.blockers[0] === "rate-limited"
    && behavioralCapture.failure?.category === "rate-limited"
    && behavioralCapture.failure?.stage === "route"
    && behavioralCapture.failure?.noPartialThresholdClaim === true
    && behavioralCapture.pin?.finalizedQualified === true
    && behavioralCapture.pin?.exactPinFamilyCount === 4
    && behavioralCapture.pin?.exactPinEndpointCount === 5
    && behavioralCapture.pinInterpretation?.behavioralCompletionReachedByAnyFamily === false
    && behavioralCapture.pinInterpretation?.familyQualificationClaimed === false
    && behavioralCapture.pinInterpretation?.thresholdClaimed === false
    && behavioralCapture.initialQualification?.strictFamilyCount === 5
    && behavioralCapture.initialQualification?.selectedEligibleEndpointCount === 7
    && behavioralCapture.budgetsUsed?.rpcRequestsTotal === 132
    && behavioralCapture.operationalCaps?.maxRpcRequestsTotal === 2600
    && behavioralCapture.budgetsUsed?.maxRpcRequestsOnAnyEndpoint === 62
    && behavioralCapture.operationalCaps?.maxRpcRequestsPerEndpoint === 220
    && behavioralCapture.budgetsUsed?.retriesTotal === 2
    && behavioralCapture.operationalCaps?.retries?.maxRetriesTotal === 40
    && behavioralCapture.budgetsUsed?.elapsedMilliseconds === 10359
    && behavioralCapture.anchorExecution?.anchorStageReached === false
    && behavioralCapture.anchorExecution?.anchorsExecuted === false
    && behavioralCapture.anchorExecution?.logsExecuted === false
    && behavioralCapture.anchorExecution?.namespacesExecuted === false
    && behavioralCapture.anchorExecution?.transactionLookupsExecuted === false
    && behavioralCapture.results?.routeResult === "INCONCLUSIVE"
    && behavioralCapture.results?.anchorResult === "NOT_REACHED"
    && behavioralCapture.results?.namespaceResult === "NOT_REACHED"
    && behavioralCapture.results?.terminalRecheckResult === "NOT_REACHED"
    && Array.isArray(behavioralCapture.endpointResults)
    && behavioralCapture.endpointResults.length === 0
    && Array.isArray(behavioralCapture.familyQualification)
    && behavioralCapture.familyQualification.length === 0
    && behavioralCapture.canonicalAggregation?.familyCount === 0
    && behavioralCapture.canonicalAggregation?.thresholdMet === false
    && behavioralCapture.gates?.routePositive === 0
    && behavioralCapture.gates?.executableNow === false
    && behavioralCapture.gates?.signedActionJustified === false
    && behavioralCapture.gates?.economicsExecuted === false
    && behavioralCapture.gates?.stateChangeExecuted === false
    && behavioralCapture.gates?.fork === false
    && behavioralCapture.economicsModelDesignReviewExecuted === false
    && behavioralCapture.economicsModelDesignReviewMayBeProposed === false
    && behavioralCapture.newBehavioralCaptureProposalMayBeDrafted === true
    && behavioralCaptureApprovalExhausted
    && behavioralCaptureManifest.aggregateSha256 === "7958862e0a4e0f8db2299536175920870bb12313d09719d27b839f073538f7bf";
  const retryStageAttemptSum = Object.values(retryCapture.sanitizedResult?.stageDebits || {}).reduce((sum, value) => sum + (asNumber(value) || 0), 0);
  const retryEndpointAttemptSum = Object.values(retryCapture.sanitizedResult?.perEndpointAttempts || {}).reduce((sum, value) => sum + (asNumber(value) || 0), 0);
  const behavioralRetryCaptureR8Current = retryCapture.classification === "CAPTURE_INCONCLUSIVE/NAMESPACE_LOOKUP_MISMATCH/NO-PARTIAL-THRESHOLD/NO-ECONOMICS"
    && retryCapture.approval?.decisionTimestamp === "2026-07-23T04:56:18.752Z"
    && retryCapture.approval?.authorizedRunnerSha256 === "00e6e6736e7797c458c90181c687a98852263be54a61d34f7661cf5775a18fd2"
    && retryCapture.approval?.authorizedPackageManifestAggregateSha256 === "aeabbee080db109d35f838de937c6275732a48b1dd23d3e337c1fa8d7e6a6aa6"
    && retryCapture.approval?.authorizationExhausted === true
    && retryCapture.sanitizedResult?.status === "INCONCLUSIVE/NAMESPACE_LOOKUP_MISMATCH"
    && retryCapture.sanitizedResult?.failureStage === "namespace-lookups"
    && retryCapture.sanitizedResult?.attempts === 269
    && retryStageAttemptSum === 269
    && retryEndpointAttemptSum === 269
    && retryCapture.sanitizedResult?.retries === 0
    && retryCapture.interpretation?.partialFamilyThresholdClaimed === false
    && retryCapture.interpretation?.behavioralConsensusClaimed === false
    && retryCapture.captureFacts?.exactlyOneNetworkCaptureOccurred === true
    && retryCapture.captureFacts?.networkCaptureCount === 1
    && retryCapture.captureFacts?.rawResponsesPersisted === false
    && retryCapture.captureFacts?.endpointMaterialPersisted === false
    && retryCapture.captureFacts?.economicsExecuted === false
    && retryCapture.captureFacts?.stateOperationsExecuted === false
    && retryCapture.packagingSafety?.runnerRerun === false
    && retryCapture.packagingSafety?.inventoryRead === false
    && retryCapture.packagingSafety?.networkCalls === false
    && retryCapture.gates?.routePositive === 0
    && retryCapture.gates?.executableNow === false
    && retryCapture.gates?.signedActionJustified === false
    && retryCapture.gates?.fork === false
    && retryCaptureManifest.aggregateSha256 === "d2e9ae8139457550b0f34ecb6ab4f87049482da222034f762da47894cf51a94d";

  return rankCandidate({
    id: "critical-etherfi-default-module-capability-sweep",
    protocol: "EtherFi Cash / Borrowing Market",
    chain: "Optimism",
    surface: "Six named non-Cash default-module authorization, Safe/Cash transfer, and tuple-isolation coverage",
    status: behavioralRetryCaptureR8Current
      ? "watch-hyperevm-retry-capture-r8-inconclusive-namespace-lookup-mismatch-no-partial-threshold-no-economics"
      : behavioralCaptureR2Current
      ? "watch-hyperevm-capture-r2-inconclusive-rate-limited-no-partial-threshold-no-economics"
      : stateCanaryR14R3Current
      ? "watch-hyperevm-r14-r3-strict-nonvacuous-eight-canary-threshold-behavioral-requalification-proposal-only"
      : hyperDiagnosticR10R2Current
      ? "watch-behype-r10-r2-hyperevm-sole-family-full-behavioral-observation-provisional-finality-no-backend-independence"
      : receiveType1R8Current
      ? "watch-behype-r8-optimism-receive-type1-negative-semantics-bound-hyperevm-unobserved-no-backend-independence"
      : endpointCoverageR5Final
      ? "watch-behype-endpoint-r5-offline-diagnostics-final-r3-snapshot-testing-stopped-coverage-open"
      : behypeBindingCoverageOpen
      ? "watch-behype-step4-exact-staker-receiver-binding-access-coverage-open-terminal-gapped-destination-single-provider"
      : behypeInvariantBoundedPass
      ? "watch-behype-step3-bounded-valid-admin-fee-refund-delivery-invariant-external-integrations-and-broader-coverage-open"
      : recoveryInvariantBoundedPass
      ? "watch-recovery-step2-bounded-valid-auth-full-balance-invariant-behype-and-broader-coverage-open"
      : unknownIdentityExact
      ? "watch-unknown-default-step1-exact-identified-direct-modules-recovery-invariant-and-broader-coverage-open"
      : configDriftBoundedPass
      ? "watch-step4-privileged-config-drift-possible-unobserved-current-deployment-history-broader-coverage-open"
      : stargateInvariantExact
      ? "watch-step3-bounded-valid-auth-tuple-invariant-asset-config-and-broader-coverage-open"
      : pendingTupleExact
      ? "watch-step2-selected-pending-tuple-exact-valid-signature-and-broader-coverage-open"
      : bindingExact
      ? "watch-step1-six-component-binding-exact-tuple-and-broader-coverage-open"
      : "watch-runtime-and-valid-signature-tuple-coverage-open",
    priorityScore: 88,
    routePositive: 0,
    executableNow: false,
    signedActionJustified: false,
    fork: false,
    forkGate: "closed-no-exploit-route-pending-withdrawal-or-execution-authority",
    coverageOpen: true,
    closureEligible: false,
    historicalCoverageComplete: false,
    sourceRuntimeEquivalence: null,
    routeNegativeClosure: false,
    classification: behavioralRetryCaptureR8Current ? retryCapture.classification : artifact.classification || "INCOMPLETE/WATCH/SCOPED-SIX-RUNTIME-AND-TUPLE-COVERAGE-OPEN",
    runId: behavioralRetryCaptureR8Current ? retryCapture.runId : artifact.runId || null,
    revision: behavioralRetryCaptureR8Current ? retryCapture.revision : artifact.revision || null,
    pin: {
      chainId: pin.chainId ?? null,
      blockNumber: pin.blockNumber ?? null,
      blockHash: pin.blockHash || null,
      timestamp: pin.timestamp ?? null,
      finalizedSelected: pin.finalizedSelected === true,
      exactNumberHashMatch: pin.exactNumberHashMatch === true,
      terminalSameNumberHashMatch: pin.terminalSameNumberHashMatch === true,
    },
    distance: {
      classification: artifact.classification || null,
      runId: artifact.runId || null,
      revision: artifact.revision || null,
      manifestAggregateSha256: manifest.aggregateSha256 || null,
      scopedModuleNames: scopedModules,
      observedDefaultCount: asNumber(coverage.observedDefaultCount) || 0,
      scopedDefaultCount: asNumber(coverage.scopedDefaultCount) || 0,
      unreviewedDefaultCount: asNumber(coverage.unreviewedDefaultCount) || 0,
      otherUnreviewedDefaultCountExcludingCashModule: asNumber(coverage.otherUnreviewedDefaultCountExcludingCashModule) || 0,
      identifiedDefaultCount: identifiedDefaults.length,
      unidentifiedDefaultCount: unidentifiedDefaults.length,
      authorizationMatrixRows: matrix.length,
      authorizationMatrixScope: artifact.authorizationMatrixScope || null,
      cashModuleIncludedInAuthorizationMatrix: artifact.cashModuleIncludedInAuthorizationMatrix === true,
      strictProbeTotal: asNumber(probes.total) || 0,
      strictProbeReverted: asNumber(probes.reverted) || 0,
      strictExpectedSelectorMatches: asNumber(probes.strictExpectedSelectorMatches) || 0,
      strictProbeProviderErrors: asNumber(probes.providerErrors) || 0,
      outsiderRejectionOnly: true,
      validSignatureTupleIsolationProven: false,
      verifierPinBound: localVerification.pinBound === true,
      verifierAuthoritativeForFixedPinEquality: localVerification.authoritativeForFixedPinEquality === true,
      fixedPinSourceRuntimeEquality: localVerification.fixedPinSourceRuntimeEquality ?? null,
      step1PinboundBinding: {
        runId: binding.runId || null,
        revision: binding.revision || null,
        classification: binding.classification || null,
        exactForBoundedSixComponentScope: bindingExact,
        componentNames: bindingComponents.map((row) => row.name),
        proxyRuntimeExact: bindingComponents.filter((row) => row.proxyComparison?.exactRuntimeEqual === true).length,
        implementationReconstructedExact: bindingComponents.filter((row) => row.implementationComparison?.exactReconstructedEqual === true).length,
        astImmutableRows: asNumber(immutableCoverage.astImmutableRowCount) || 0,
        independentlyBoundImmutableRows: asNumber(immutableCoverage.independentlyBoundRowCount) || 0,
        scopedClosureFiles: asNumber(closureLinkage.scopedClosureFileCount) || 0,
        matchedClosureFiles: asNumber(closureLinkage.matchedClosureFileCount) || 0,
        standardJsonBuildInputSources: asNumber(closureLinkage.standardJsonBuildInputSourceCount) || 0,
        manifestAggregateSha256: bindingManifest.aggregateSha256 || null,
        step2ApprovedOnlyAsSeparatelyClaimedReadOnlyDiscovery: binding.step2SafeToBegin === true,
        exploitProven: false,
        routeProven: false,
        pendingWithdrawalConditionProven: false,
        executionAuthorityProven: false,
      },
      step2PendingWithdrawalTuple: {
        runId: pendingTuple.runId || null,
        revision: pendingTuple.revision || null,
        classification: pendingTuple.classification || null,
        exactForSelectedTupleOnly: pendingTupleExact,
        manifestAggregateSha256: pendingTupleManifest.aggregateSha256 || null,
        module: selectedPending.module || null,
        moduleAddress: selectedPending.moduleAddress || null,
        safe: selectedPending.safe || null,
        moduleRecordKey: selectedPending.comparison?.keying?.moduleRecordKey || null,
        cashRecordKey: selectedPending.comparison?.keying?.cashPendingWithdrawalKey || null,
        oneToken: pendingChecks.cashHasOneToken === true,
        recipientIsModule: pendingChecks.recipientIsModule === true,
        assetEqual: pendingChecks.assetEqual === true,
        amountEqual: pendingChecks.amountEqual === true,
        tupleEqual: selectedPending.comparison?.equal === true,
        finalizeTime: selectedPending.cashState?.finalizeTime || null,
        pinTimestamp: pendingTuple.pin?.timestamp ?? null,
        notFinalizableAtPin: selectedPending.finalizedAtPin === false,
        latestRetainedWindowEventMatchesState: selectedPending.latestRequestMatchesState === true,
        retainedWindowStartBlock: pendingCoverage.retainedWindowStartBlock ?? null,
        retainedWindowEndBlock: pendingCoverage.retainedWindowEndBlock ?? null,
        retainedLogProviderConsensus: pendingCoverage.retainedLogConsensusCount || 0,
        fullModuleHistoryCovered: pendingCoverage.fullModuleHistoryCovered === true,
        deployedGuardBindingExact: pendingTuple.deployedSemanticsBinding?.exact === true,
        validSignatureTupleIsolationProven: false,
        fullHistoryAbsenceProven: false,
        executionSuccessProven: false,
        settlementProven: false,
        economicsProven: false,
        permissionlessExtractionProven: false,
        authorityToActProven: false,
      },
      step3StargateValidAuthTupleInvariant: {
        runId: stargateInvariant.runId || null,
        revision: stargateInvariant.revision || null,
        classification: stargateInvariant.classification || null,
        exactForBoundedMockAndFixedRuntimeBasis: stargateInvariantExact,
        manifestAggregateSha256: stargateInvariantManifest.aggregateSha256 || null,
        signedDigestCommits: ["chainId", "moduleAddress", "safeGlobalNonce", "safe", "destinationEid", "asset", "amount", "destinationRecipient", "maxSlippage"],
        callerSigned: false,
        callerRelayerNeutral: invariantChecks.requestCallerNotCryptographicallyBound === true,
        cashExecuteRechecks: ["recipientIsModule", "oneTokenShape", "asset", "amount"],
        destinationFieldsAndSlippagePreservedInSafeKeyedModuleStorage: invariantChecks.executeUsesStoredDestinationRecipientAndSlippage === true,
        destinationFieldsAndSlippageCashRechecked: false,
        validNextNonceRequestAtomicallyReplacesPriorState: true,
        replayRejectedWithRollback: true,
        invalidOverwriteRejectedWithPriorStatePreserved: true,
        testsPassed: invariantTests.testsPassed || 0,
        fuzzPropertiesPassed: invariantTests.fuzzPropertiesPassed || 0,
        fuzzRunsPerProperty: invariantTests.fuzzRunsPerProperty || 0,
        totalFixedSeedPropertyCases: invariantTests.totalFuzzCases || 0,
        mockOwnerCount: 1,
        mockThreshold: 1,
        productionMultiOwnerRecoveryFactoryVariantsDynamicallyExhausted: false,
        signerIntentProven: false,
        executionProven: false,
        bridgeDeliveryProven: false,
        economicsProven: false,
        historyProven: false,
        extractionRouteProven: false,
        assetConfigDriftBlocksBoundedInvariant: false,
      },
      step4StargateAssetConfigDrift: {
        runId: configDrift.runId || null,
        revision: configDrift.revision || null,
        classification: configDrift.classification || null,
        qualifiedBoundedPass: configDriftBoundedPass,
        manifestAggregateSha256: configDriftManifest.aggregateSha256 || null,
        privilegedMutationPossible: configDrift.findings?.privilegedMutationPossible === true,
        requiredRole: configDrift.semantics?.configMutation?.role || null,
        mutableFields: configDrift.semantics?.configMutation?.mutableFields || [],
        signatureCommitsAsset: configDrift.semantics?.signature?.commitsAsset === true,
        signatureCommitsConfigPoolRouterIdentity: false,
        requestSnapshotsConfig: false,
        quoteAndExecuteReadCurrentConfig: true,
        selectedConfigBlocks: [selectedConfigs.preRequestBlock?.blockNumber, selectedConfigs.requestBlockEnd?.blockNumber, selectedConfigs.pin?.blockNumber],
        selectedConfigEqualAcrossBlocks: configDrift.selectedRequest?.configStablePreRequestThroughPin === true,
        laterConfigEventsThroughPin: configDrift.selectedRequest?.configEventsAfterRequestThroughPin?.length ?? null,
        retainedRequests: retainedConfigWindow.requestCount || 0,
        retainedBridges: retainedConfigWindow.bridgeCount || 0,
        retainedCancellations: retainedConfigWindow.cancelCount || 0,
        exactConfigCoveredPairs: configDrift.lifecyclePairs?.configCoveredPairCount || 0,
        observedDriftPairs: configDrift.lifecyclePairs?.configDriftPairCount || 0,
        currentObservedDeploymentBoundary: configHistory.startBlock ?? null,
        codeAbsentImmediatelyBeforeAndPresentAtBoundaryTwoProviderConsensus: configHistory.boundaries?.length === 2 && configHistory.boundaries.every((row) => row.absentImmediatelyBefore === true),
        configEventsFromCurrentObservedDeploymentBoundaryThroughPin: configHistory.providerScanSummaries?.[0]?.logCount ?? null,
        fullConfigEventHistoryFromCurrentObservedDeploymentBoundaryThroughPin: configHistory.complete === true && configHistory.boundaryConsensus === true && configHistory.consensusCount === 2,
        fullAddressLifetimeHistoryAcrossHypotheticalPriorIncarnationsProven: false,
        currentAuthorityThreshold: configDrift.authority?.rows?.[0]?.multisigLikeThreshold ?? null,
        currentAuthorityOwnerCount: configDrift.authority?.rows?.[0]?.multisigLikeOwnerCount ?? null,
        authorityCountsDescriptiveOnly: true,
        exactNestedModuleCallersAttributedFromTransactionOrigin: false,
        roleRegistryLinkageExact: configDrift.runtimeBinding?.roleRegistry?.proxyRuntimeExact === true && configDrift.runtimeBinding?.roleRegistry?.implementationRuntime?.exact === true,
        selectedPoolCodeTokenAndStandardProxySlotsStable: configDrift.selectedRequest?.poolIdentityStable === true,
        configuredPoolGovernanceAndImplementationSafetyInScope: false,
        permissionlessActorProven: false,
        futureImmutabilityProven: false,
        economicIssueProven: false,
        executionProven: false,
        routeProven: false,
      },
      unknownDefaultStep1IdentityBinding: {
        runId: unknownIdentity.runId || null,
        revision: unknownIdentity.revision || null,
        classification: unknownIdentity.classification || null,
        exactForIdentitySubstepOnly: unknownIdentityExact,
        manifestAggregateSha256: unknownIdentityManifest.aggregateSha256 || null,
        pin: unknownIdentity.pin || null,
        finalizedPinProviderAgreement: unknownIdentity.providerCoverage?.finalizedPinAgreementCount || 0,
        fullStateDigestMatches: unknownIdentity.providerCoverage?.fullStateDigestMatchCount || 0,
        fullStateDigestProviderCount: unknownIdentity.providerCoverage?.fullStateDigestProviderCount || 0,
        allFinalizedProvidersMatchedFullStateDigest: unknownIdentity.providerCoverage?.allFinalizedProvidersMatchedFullStateDigest === true,
        sourceCommit: unknownIdentity.source?.commit || null,
        modules: unknownModules.map((row) => ({
          name: row.name || null,
          address: row.address || null,
          defaultEnabled: row.isDefault === true,
          whitelisted: row.isWhitelisted === true,
          directDeployment: row.structure?.direct === true,
          proxyImplementation: row.structure?.implementation || null,
          beacon: row.structure?.beacon || null,
          exactImmutablePatchedRuntime: row.reconstruction?.exact === true,
          selectors: Array.isArray(row.source?.selectors) ? row.source.selectors.map((entry) => ({ selector: entry.selector, signature: entry.signature, valueClass: entry.valueClass })) : [],
          valueEntrypoint: row.source?.semantics?.valueEntrypoint || null,
        })),
        capabilityDefaultCountAfterIdentification: 11,
        capabilityUnidentifiedDefaultCountAfterIdentification: 0,
        recoveryCreationTransactionAttributionProven: false,
        recoveryBoundaryBuildRuntimeIdentityExact: unknownIdentity.findings?.safeRecoveryBoundaryAndBuildIdentitySupport === true,
        recoverySignedFields: ["chainId", "moduleAddress", "safeNonce", "safe", "token", "recipient", "deadline"],
        recoveryAmountSigned: false,
        recoverySweepsUnsignedCurrentFullBalance: true,
        beHYPERefundRiskClassification: unknownIdentity.findings?.beHYPERefundRiskClassification || null,
        beHYPERefundOutsiderLossEstablished: false,
        vulnerabilityProven: false,
        lossProven: false,
        authorizationBypassProven: false,
        profitProven: false,
        routeProven: false,
      },
      safeAssetRecoveryStep2Invariant: {
        runId: recoveryInvariant.runId || null,
        revision: recoveryInvariant.revision || null,
        classification: recoveryInvariant.classification || null,
        boundedValidAuthorizationFullBalanceInvariantPassed: recoveryInvariantBoundedPass,
        manifestAggregateSha256: recoveryInvariantManifest.aggregateSha256 || null,
        exactProductionModuleSourceLinkedToStep1Runtime: recoveryInvariant.predecessor?.immutablePatchedRuntimeExact === true && recoveryInvariant.localHarness?.exactProductionModuleSource === true,
        passedFunctionCount: recoveryInvariant.tests?.passedFunctionCount || 0,
        fixedSeedFuzzCases: recoveryInvariant.tests?.fuzzCaseCount || 0,
        supportedTokenOverlapMasks: recoveryInvariant.tests?.supportedOverlapLocalCaseCount || 0,
        effectiveExecutedCases: recoveryInvariant.tests?.totalExecutedCasesIncludingOverlapLoop || 0,
        semanticReplayEqual: recoveryInvariant.foundry?.semanticReplayEqual === true,
        fullCurrentBalanceSemantics: recoveryInvariant.findings?.fullCurrentBalanceSemantics === true,
        outsiderAuthorizationBypassFound: recoveryInvariant.findings?.unauthorizedPathFound === true,
        arbitraryTargetOrCalldataFound: recoveryInvariant.findings?.arbitraryTargetOrCalldataFound === true,
        permissionlessExtractionOrLossEstablished: recoveryInvariant.findings?.permissionlessLossEstablished === true,
        profitEstablished: recoveryInvariant.findings?.profitablePathEstablished === true,
        observations: recoveryObservations.map((row) => ({ id: row.id || null, severity: row.severity || null, classification: row.classification || null, permissionlessExploit: row.permissionlessExploit === true })),
        completeDeployedSafeAuthorizationProof: false,
        erc1271AndMixedOwnersCovered: false,
        malformedAndDuplicateSignatureMatrixComplete: false,
        incomingOwnerTransitionsCovered: false,
        callbacksReentrancyAndAdversarialTokensComplete: false,
        liveHookDataProviderAndRegistrySafeContinuityProven: false,
        fork: false,
      },
      beHYPEStep3FeeRefundDeliveryInvariant: {
        runId: behypeInvariant.runId || null,
        revision: behypeInvariant.revision || null,
        classification: behypeInvariant.classification || null,
        boundedValidAdminFeeRefundDeliveryInvariantPassed: behypeInvariantBoundedPass,
        manifestAggregateSha256: behypeInvariantManifest.aggregateSha256 || null,
        exactProductionModuleSourceLinkedToStep1Runtime: behypeInvariant.predecessor?.immutablePatchedRuntimeExact === true && behypeInvariant.localHarness?.exactProductionModuleSource === true,
        passedFunctionCount: behypeInvariant.tests?.passedFunctionCount || 0,
        fixedSeedFuzzCases: behypeInvariant.tests?.fuzzCaseCount || 0,
        effectiveExecutedCases: behypeInvariant.tests?.totalExecutedCases || 0,
        semanticReplayEqual: behypeInvariant.foundry?.semanticReplayEqual === true,
        singleAdminAuthorizationAndDigestBinding: behypeInvariant.source?.semantics?.singleSafeAdminSigner === true && behypeInvariant.source?.semantics?.digestBindsChainModuleNonceSafeAmount === true,
        callerFundedQuoteAndImmediateCallerExcessRefund: behypeInvariant.source?.semantics?.callerFundsQuoteThroughSafe === true && behypeInvariant.source?.semantics?.excessRefundedToCaller === true,
        fixedSafeReceiverTargetsAndApprovalReset: behypeInvariant.source?.semantics?.fixedReceiverSafe === true && behypeInvariant.source?.semantics?.fixedTargetsAndApprovalReset === true,
        outsiderAuthorizationBypassFound: behypeInvariant.findings?.unauthorizedAuthorizationBypassFound === true,
        arbitraryDestinationFound: behypeInvariant.findings?.relayerCanRedirectReceiver === true,
        arbitraryCallerResidueCaptureFound: behypeInvariant.findings?.arbitraryCallerResidueCaptureFound === true,
        exactLocalUnauthorizedResidueCaptureGainWei: behypeInvariant.findings?.exactLocalUnauthorizedResidueCaptureGainWei || null,
        permissionlessLossEstablished: behypeInvariant.findings?.permissionlessLossEstablished === true,
        profitEstablished: behypeInvariant.findings?.profitablePathEstablished === true,
        observations: behypeObservations.map((row) => ({ id: row.id || null, severity: row.severity || null, classification: row.classification || null, permissionlessExploit: row.permissionlessExploit === true })),
        completeDeployedSystemProof: false,
        deployedStakerWhypeBehypeLayerZeroBound: false,
        callbackRetryRefundFullSafeCurrentConfigBound: false,
        fork: false,
      },
      beHYPEStep4StakerLayerZeroBinding: {
        runId: behypeBinding.runId || null,
        revision: behypeBinding.revision || null,
        classification: behypeBinding.classification || null,
        reviewedPackagePromotedOnlyAsIncompleteWatch: behypeBindingCoverageOpen,
        manifestAggregateSha256: behypeBindingManifest.aggregateSha256 || null,
        optimismFinalizedProviders: behypeBinding.providerCoverage?.optimism?.finalizedConsensusCount || 0,
        optimismMatchingStateProviders: behypeBinding.providerCoverage?.optimism?.stateConsensusCount || 0,
        optimismHistoryProviders: behypeBinding.providerCoverage?.optimism?.archiveHistoryConsensusCount || 0,
        optimismTerminalSameNumberMatchCount: behypeBinding.pin?.terminalSameNumberHashMatchCount || 0,
        optimismTerminalSameNumberThreshold: behypeBinding.pin?.terminalSameNumberHashThreshold || 0,
        optimismTerminalThresholdMet: behypeBinding.pin?.terminalSameNumberHashVerified === true,
        destinationStateProviders: behypeBinding.providerCoverage?.destination?.stateConsensusCount || 0,
        destinationHistoryProviders: behypeBinding.providerCoverage?.destination?.historyConsensusCount || 0,
        destinationMultiProviderConsensus: behypeBinding.providerCoverage?.destination?.multiProviderConsensus === true,
        localExactBuildRuntimeScope: behypeBindingManifest.localExactBuildRuntimeScope || [],
        adaptersExplorerRuntimeBoundOnly: behypeBindingManifest.adapterExplorerRuntimeBoundWithoutEqualLocalRebuild === true,
        fullRouteLocalExactBuildRuntimeBound: false,
        publicStakerCallsObserved: behypeBinding.findings?.permissionlessDirectStakerCallsObserved === true,
        destinationFundedReturnFeeReachable: behypeBinding.findings?.destinationFeeSubsidyPermissionlessReachable === true,
        wholeRoundedBalanceResidueReachable: behypeBinding.findings?.publicWholeBalanceDeliveryCanIncludePriorBehypeResidue === true,
        directNativePayoutToCallerFound: false,
        arbitrarySweepFound: false,
        currentProfitableRouteEstablished: false,
        destinationDeliveryFinalityProven: false,
        unmatchedDestinationRowClassification: behypeBinding.findings?.unmatchedDestinationComposeClassification || null,
        economicsAttempted: false,
        fork: false,
      },
      beHYPEEndpointCoverageR5Diagnostics: {
        runId: endpointCoverage.runId || null,
        revision: endpointCoverage.revision || null,
        classification: endpointCoverage.classification || null,
        independentlyReviewedDiagnosticsPromoted: endpointCoverageR5Final,
        manifestAggregateSha256: endpointCoverageManifest.aggregateSha256 || null,
        offlineOnly: endpointCoverage.safety?.offlineOnly === true,
        endpointInventoriesReadThisRun: endpointCoverage.safety?.endpointInventoriesReadThisRun === true,
        endpointValuesPersisted: endpointCoverage.safety?.endpointValuesPersisted === true,
        immutableR4InputsBound: endpointCoverage.provenance?.derivedFromImmutableR4Inputs === true,
        originalR3MutableArtifactsAvailable: endpointCoverage.provenance?.originalR3MutableArtifactsAvailable === true,
        optimismMinimalCoreFamilyConsensusReady: endpointCoverage.optimism?.readiness?.minimalCoreProviderFamilyConsensusReady === true,
        optimismMinimalCoreConsensusFamilies: endpointCoverage.optimism?.metrics?.minimalCoreConsensusProviderFamilyGroups || 0,
        optimismAnchorWindowDigestFamilies: endpointCoverage.optimism?.metrics?.anchorWindowDigestEqualityProviderFamilyGroups || 0,
        optimismConfigConsensusReady: endpointCoverage.optimism?.readiness?.configExtensionProviderFamilyConsensusReady === true,
        optimismFullTupleConsensusReady: endpointCoverage.optimism?.readiness?.fullTupleProviderFamilyConsensusReady === true,
        hyperevmCoreConsensusReady: endpointCoverage.providerFamilyConsensusReadiness?.hyperevm?.minimalCoreProviderFamilyConsensusReady === true,
        hyperevmConfigConsensusReady: endpointCoverage.providerFamilyConsensusReadiness?.hyperevm?.configExtensionProviderFamilyConsensusReady === true,
        hyperevmFullTupleConsensusReady: endpointCoverage.providerFamilyConsensusReadiness?.hyperevm?.fullTupleProviderFamilyConsensusReady === true,
        secondHyperEVMFamilyInR3Snapshot: false,
        backendOrOperatorIndependenceClaimed: false,
        graphqlProtocolResponsesAreFinalityProof: false,
        diagnosticsCountsArePerFieldIncidencesNotUniqueFamilies: true,
        currentSnapshotTestingStopped: true,
        economicsBlocked: true,
        routePositive: 0,
        executableNow: false,
        signedActionJustified: false,
        fork: false,
      },
      beHYPEReceiveType1R8: {
        runId: receiveType1.runId || null,
        revision: receiveType1.revision || null,
        classification: receiveType1.classification || null,
        reviewedCurrentR8R2: receiveType1R8Current,
        manifestAggregateSha256: receiveType1Manifest.aggregateSha256 || null,
        r6: {
          runId: endpointCoverage.runId || null,
          classification: endpointCoverage.classification || null,
          disposition: "rejected-conditional-correction-for-selected-library-family-inference",
          rejectionStatus: selectedLibrary.rejectedPredecessorR6?.status || null,
        },
        r7: {
          runId: selectedLibrary.runId || null,
          revision: selectedLibrary.revision || null,
          disposition: "predecessor",
          manifestAggregateSha256: selectedLibraryManifest.aggregateSha256 || null,
        },
        r8R2Disposition: "current",
        freshOptimismPin: receiveType1.pin || null,
        observedHostnameDerivedProviderFamilyGroupsAgreeing: receiveType1.metrics?.completeFamilies || 0,
        selectionCodeVersionConfigStateAndAnchorAgreement: receiveType1.behavioralConsensusReady === true,
        receiveType1StrictExpectedCustomErrorSemanticsBound: receiveType1.gates?.optimismReceiveType1BehavioralConsensus === true,
        backendOperatorIndependenceClaimed: false,
        exactOfficialRuntimeEquivalence: null,
        behavioralBindingOnly: true,
        hyperEVMObservedInFreshCapture: receiveType1.hyperevm?.observedThisRun === true,
        hyperEVMFamilyCount: receiveType1.hyperevm?.familyCount || 0,
        hyperEVMDataInvented: false,
        economicsBlocked: true,
        requiredHyperEVMProviderFamilyGroupsBeforeEconomics: 2,
        routePositive: 0,
        executableNow: false,
        signedActionJustified: false,
        fork: false,
      },
      beHYPEHyperEvmDiagnosticR10R2: {
        runId: hyperDiagnostic.runId || null,
        classification: hyperDiagnostic.classification || null,
        reviewedVersionedPackageCurrent: hyperDiagnosticR10R2Current,
        manifestAggregateSha256: hyperDiagnosticManifest.aggregateSha256 || null,
        r8OptimismBehavioralPredecessorStatus: hyperDiagnostic.immutablePredecessorR8?.status || null,
        r9HyperEvmPredecessorStatus: hyperDiagnostic.immutablePredecessorR9?.status || null,
        r10PredecessorRunId: hyperDiagnostic.immutablePredecessorR10?.runId || null,
        r10PredecessorStatus: hyperDiagnostic.immutablePredecessorR10?.status || null,
        r10R2Disposition: "current",
        declaredObservedUsableFamilyGroups: hyperDiagnostic.families?.length || 0,
        completeConfiguredRoutes: hyperDiagnostic.metrics?.completeRouteCount || 0,
        configuredBehavioralTupleCount: 2,
        sendReceiveType1DirectionNotApplicable: hyperDiagnosticManifest.reportPresentation?.some((row) => row.routeLabel === "behype-send-30111" && row.directionNotApplicable?.includes("receive-type1-negative")) === true,
        soleFamilyProvisionalReportedFinalizedStablePin: hyperDiagnostic.pin || null,
        crossFamilyFinalityConsensus: false,
        crossFamilyHashConsensus: false,
        backendOperatorIndependenceClaimed: false,
        economicsBlocked: true,
        requiredSecondDistinctUsableHyperEvmFamily: true,
        routePositive: 0,
        executableNow: false,
        signedActionJustified: false,
        fork: false,
      },
      hyperEvmStateCanaryR14R3: {
        runId: stateCanary.runId || null,
        revision: stateCanary.revision || null,
        classification: stateCanary.classification || null,
        reviewedExactVersionedPackageCurrent: stateCanaryR14R3Current,
        manifestAggregateSha256: stateCanaryManifest.aggregateSha256 || null,
        lineage: {
          r12: { runId: "etherfi-behype-hyperevm-requalification-r12-78e53e0347dfa32c9543-06c259018048", disposition: "malformed-matrix-predecessor-corrected-before-r13-r3" },
          r13R3: { runId: "etherfi-hyperevm-header-consensus-r13-r3-48c9c273035946b42688c6d83b95aff01b05e53ffe029823dbfd06356139efe2-07929dda6a48a52fe19e499fb09f476a5460cc1d9f1af977dd7276e266ea0aa8", disposition: "header-consensus-and-corrected-matrix-governance" },
          r14: { runId: "etherfi-hyperevm-state-canary-r14-abc6540ce5d67ef43473e9f8e6e22b3de77bc1bef63a0dd672c0a35793c32508-7d67e7eeb1f75f9cd800c9d530fe03f5054e46ec94f4cc9886f856afd3acafb7", disposition: "initial-eight-canary-threshold" },
          r14R2: { runId: stateCanary.predecessorBinding?.runId || null, disposition: "strict-all-eligible-endpoint-predecessor" },
          r14R3: { runId: stateCanary.runId || null, disposition: "current-nonvacuous-family-assessment" },
        },
        stateCanaryCount: stateCanary.matrix?.stateCanaryCount || 0,
        exactEqualityCanaries: stateCanary.matrix?.exactEqualityCheckCount || 0,
        nonEmptyCodePredicateCanaries: stateCanary.matrix?.nonEmptyDeploymentCodePredicateCount || 0,
        strictQualifiedFamilyCount: stateCanary.strictQualification?.strictArchiveQualifiedFamilyCount || 0,
        zeroEligibleFamilyCount: zeroEligibleStateCanaryFamilies.length,
        zeroEligibleFamiliesAssessed: false,
        zeroEligibleConsistencyNull: zeroEligibleStateCanaryFamilies.every((row) => row.matrixBoundObservedResultCommitmentsInternallyConsistent === null),
        matrixBoundCommitmentIndependentEvidence: false,
        backendOperatorIndependenceClaimed: false,
        behavioralRequalificationMayBeProposed: true,
        behavioralRequalificationExecuted: false,
        behaviorExecuted: false,
        anchorsExecuted: false,
        economicsExecuted: false,
        routePositive: 0,
        executableNow: false,
        signedActionJustified: false,
        fork: false,
      },
      hyperEvmBehavioralRequalificationCaptureR2: {
        runId: behavioralCapture.runId || null,
        revision: behavioralCapture.revision || null,
        classification: behavioralCapture.classification || null,
        reviewedInconclusiveCaptureCurrent: behavioralCaptureR2Current,
        manifestAggregateSha256: behavioralCaptureManifest.aggregateSha256 || null,
        predecessorStateCanary: {
          runId: stateCanary.runId || null,
          classification: stateCanary.classification || null,
          manifestAggregateSha256: stateCanaryManifest.aggregateSha256 || null,
          disposition: "preserved-current-strict-historical-state-qualification",
        },
        approvedProposalRevision: behavioralCapture.approval?.approvedProposalRevision || null,
        approvalAuthorization: behavioralCapture.approval?.authorization || null,
        exactlyOneCaptureInvocation: behavioralCapture.originalCaptureSafety?.exactlyOneCaptureInvocation === true,
        priorApprovalExhausted: behavioralCaptureApprovalExhausted,
        blocker: behavioralCapture.blockers?.[0] || null,
        failureStage: behavioralCapture.failure?.stage || null,
        noPartialThresholdClaim: behavioralCapture.failure?.noPartialThresholdClaim === true,
        pinSelectionCandidateFinalizedFamilies: behavioralCapture.pinInterpretation?.pinSelectionCandidateFinalizedFamilies || 0,
        pinSelectionCandidateEndpoints: behavioralCapture.pinInterpretation?.pinSelectionCandidateEndpoints || 0,
        behaviorallyCompletedFamilies: behavioralCapture.canonicalAggregation?.familyCount || 0,
        familyQualificationCount: Array.isArray(behavioralCapture.familyQualification) ? behavioralCapture.familyQualification.length : 0,
        rpcRequests: { used: behavioralCapture.budgetsUsed?.rpcRequestsTotal || 0, cap: behavioralCapture.operationalCaps?.maxRpcRequestsTotal || 0 },
        maximumEndpointRpcRequests: { used: behavioralCapture.budgetsUsed?.maxRpcRequestsOnAnyEndpoint || 0, cap: behavioralCapture.operationalCaps?.maxRpcRequestsPerEndpoint || 0 },
        retries: { used: behavioralCapture.budgetsUsed?.retriesTotal || 0, cap: behavioralCapture.operationalCaps?.retries?.maxRetriesTotal || 0 },
        elapsedMilliseconds: behavioralCapture.budgetsUsed?.elapsedMilliseconds || 0,
        routeResult: behavioralCapture.results?.routeResult || null,
        anchorResult: behavioralCapture.results?.anchorResult || null,
        namespaceResult: behavioralCapture.results?.namespaceResult || null,
        terminalRecheckResult: behavioralCapture.results?.terminalRecheckResult || null,
        anchorsExecuted: behavioralCapture.anchorExecution?.anchorsExecuted === true,
        logsExecuted: behavioralCapture.anchorExecution?.logsExecuted === true,
        transactionLookupsExecuted: behavioralCapture.anchorExecution?.transactionLookupsExecuted === true,
        economicsExecuted: behavioralCapture.gates?.economicsExecuted === true,
        routePositive: 0,
        executableNow: false,
        signedActionJustified: false,
        fork: false,
        nextActionProposalOnly: behavioralCapture.newBehavioralCaptureProposalMayBeDrafted === true,
      },
      hyperEvmBehavioralRetryCaptureR8: {
        runId: retryCapture.runId || null,
        revision: retryCapture.revision || null,
        classification: retryCapture.classification || null,
        reviewedInconclusiveCaptureCurrent: behavioralRetryCaptureR8Current,
        manifestAggregateSha256: retryCaptureManifest.aggregateSha256 || null,
        approvalTimestamp: retryCapture.approval?.decisionTimestamp || null,
        authorizedRunnerSha256: retryCapture.approval?.authorizedRunnerSha256 || null,
        authorizedPackageAggregateSha256: retryCapture.approval?.authorizedPackageManifestAggregateSha256 || null,
        exactlyOneNetworkCaptureOccurred: retryCapture.captureFacts?.exactlyOneNetworkCaptureOccurred === true,
        authorizationExhausted: retryCapture.approval?.authorizationExhausted === true,
        status: retryCapture.sanitizedResult?.status || null,
        failureStage: retryCapture.sanitizedResult?.failureStage || null,
        attempts: retryCapture.sanitizedResult?.attempts || 0,
        stageAttemptSum: retryStageAttemptSum,
        endpointAttemptSum: retryEndpointAttemptSum,
        retries: retryCapture.sanitizedResult?.retries || 0,
        completedStages: retryCapture.sanitizedResult?.executionOrder || [],
        namespaceLookupAttemptsBeforeMismatch: retryCapture.sanitizedResult?.stageDebits?.["namespace-lookups"] || 0,
        positiveSystemReceiptStageReached: retryCapture.interpretation?.positiveSystemReceiptStageReached === true,
        terminalPinRecheckReached: retryCapture.interpretation?.terminalPinRecheckReached === true,
        partialFamilyThresholdClaimed: retryCapture.interpretation?.partialFamilyThresholdClaimed === true,
        rawResponsesPersisted: retryCapture.captureFacts?.rawResponsesPersisted === true,
        endpointMaterialPersisted: retryCapture.captureFacts?.endpointMaterialPersisted === true,
        economicsExecuted: retryCapture.captureFacts?.economicsExecuted === true,
        stateOperationsExecuted: retryCapture.captureFacts?.stateOperationsExecuted === true,
        packagingOffline: retryCapture.packagingSafety?.offlineOnly === true,
        packagingRunnerRerun: retryCapture.packagingSafety?.runnerRerun === true,
        packagingInventoryRead: retryCapture.packagingSafety?.inventoryRead === true,
        packagingNetworkCalls: retryCapture.packagingSafety?.networkCalls === true,
        routePositive: 0,
        executableNow: false,
        signedActionJustified: false,
        fork: false,
      },
      sourceImportClosureComplete: sourceClosure.complete === true,
      sourceImportClosureFileCount: Array.isArray(sourceClosure.files) ? sourceClosure.files.length : 0,
      sourceImportClosureUnresolvedCount: Array.isArray(sourceClosure.unresolved) ? sourceClosure.unresolved.length : null,
      persistentApprovalCallbackNonstandardTokenResidualOpen: true,
      finalStateSolvencyResidual: artifact.finalStateSolvency || null,
    },
    economics: {
      permissionlessRouteEstablished: false,
      exactEconomics: null,
      bestNetUsd: null,
    },
    topRows: matrix.map((row) => ({
      module: row.module || null,
      entrypoint: row.entrypoint || null,
      callerRestriction: row.callerRestriction || null,
      binding: row.binding || null,
      executionPath: row.executionPath || null,
      healthEnforcement: row.healthEnforcement || null,
    })),
    blockers: behavioralRetryCaptureR8Current ? [
      "The exactly-one authorized R8 read-only network capture stopped fail-closed during namespace lookups with INCONCLUSIVE/NAMESPACE_LOOKUP_MISMATCH after 269 attempts",
      "Stage and endpoint attempt sums both equal 269; namespace lookups used 62 attempts, retries were zero, and positive system receipt, post-read finality, mandatory canary rerun, and terminal pin recheck were not reached",
      "No partial family threshold or behavioral consensus is claimed because namespace classification did not complete",
      "No endpoint material or raw responses were persisted, so the exact mismatching namespace representation cannot be reconstructed from this sanitized package",
      "The R8 authorization is exhausted; no further inventory or endpoint access is authorized. Economics, state operations, route/executable/signing, and fork gates remain closed",
    ] : behavioralCaptureR2Current ? [
      "Behavioral capture r2 stopped at the route stage as rate-limited after 132/2600 RPC requests, at most 62/220 on one endpoint, 2/40 retries, and 10.359 seconds",
      "Pin selection found four candidate finalized families across five endpoints, but no family completed behavioral qualification; familyQualification is empty and no partial threshold is claimed",
      "Anchors, logs, namespaces, transaction lookups, and terminal recheck were not reached; route result is INCONCLUSIVE",
      "Proposal r3 approval was limited to exactly one bounded read-only capture and is exhausted; capture r2 authorizes no further endpoint access, economics, execution, or state change",
      "R14-r3 remains the strict historical-state predecessor; route/executable/signing stay 0/0/false, fork=false, and economics remains closed",
    ] : stateCanaryR14R3Current ? [
      "R14-r3 qualifies five anonymous hostname-derived families only because every selected-header-matched eligible endpoint in each passes all eight historical-state canaries",
      "The canaries are seven exact-equality checks plus one non-empty deployment-code predicate; zero-eligible families are not assessed and retain null consistency",
      "Matrix-bound observed-result commitment agreement is not independent evidence, and backend/operator independence is not established",
      "R12 malformed-matrix evidence was corrected; R13-r3 governs the corrected header/matrix preflight; R14, R14-r2, and current R14-r3 retain distinct lineage",
      "Behavior, anchors, and economics were not executed; behavioral requalification may only be proposed under a separate scope and review",
    ] : hyperDiagnosticR10R2Current ? [
      "R10-r2 observes one declared/hostname-derived HyperEVM provider-family group completing both configured selected-library behavioral tuples at a sole-family provisional reported-finalized stable pin",
      "The send route receive-type1 check is direction-not-applicable, not missing or failed evidence",
      "One family does not establish cross-family finality/hash consensus or backend/operator independence",
      "R8 is the immutable Optimism behavioral predecessor; R9 and R10 are immutable HyperEVM predecessors; the reviewed versioned R10-r2 package is current",
      "Economics remains blocked until a second distinct declared/observed usable HyperEVM family matches a fresh full behavioral tuple plus anchor",
    ] : receiveType1R8Current ? [
      "R8-r2 binds fresh Optimism selected-library, code/version, applicable config, state, anchor, and strict receive-type1 expected custom-error behavior across two observed hostname-derived provider-family groups",
      "The observed groups do not establish backend/operator independence; this is behavioral binding only and exact official LayerZero runtime equivalence remains null",
      "HyperEVM is unobserved in the fresh capture and no data is invented",
      "R6 is retained as a rejected conditional correction for selected-library family inference; R7 is the immutable predecessor; R8-r2 is current",
      "Economics remains blocked until at least two distinct declared/observed HyperEVM provider-family groups agree a fresh fixed-pin full behavioral tuple plus anchor",
    ] : endpointCoverageR5Final ? [
      "R5 is an offline diagnostics final disposition for the already tested r3 inventory snapshot; stop testing that snapshot",
      "Optimism reaches two-family minimal-core plus bounded anchor-window value-digest consensus only; config and full tuples remain unresolved",
      "HyperEVM has one-family core observation only, config/full unresolved, and no second family in the r3-tested snapshot; no backend/operator independence is claimed",
      "GraphQL probes establish protocol responses only, not finality; diagnostics counts are per-field incidences rather than unique providers or families",
      "Original mutable r3 artifacts are unavailable; immutable versioned r4 inputs are bound. Economics remains blocked pending separately authorized second-family access and corrected offline ABI handling",
    ] : behypeBindingCoverageOpen ? [
      "Step 4 is promoted only as INCOMPLETE/WATCH: Optimism retained coverage has three finalized providers and two matching state/history providers, but terminal same-number recheck is 1/2 and threshold-unmet",
      "HyperEVM destination state and history are single-provider observations; destination joins are not delivery-finality proof and the unmatched row remains unresolved/pending-or-failed",
      "Local exact build/runtime scope covers only the L2 staker and destination receiver proxy/implementation pairs; adapters are explorer/runtime-bound only",
      "Public staker access, destination-funded return fee, and whole-rounded-balance residue are reachability/watch observations, not profitability, extraction, or loss proof",
      "Economics remains blocked until independent authorized Optimism terminal and HyperEVM state/history thresholds are met in a fixed-pin coverage-only rerun",
    ] : behypeInvariantBoundedPass ? [
      "Step 3 passes bounded local single-admin authorization, fee/refund, fixed-call, approval-reset, rollback, and delivery-boundary invariants on exact BeHYPE module source; external integrations remain open",
      "Deployed staker, WHYPE, beHYPE, LayerZero receiver/options/delivery/retry/refund, callbacks, full EtherFiSafe behavior, and current configuration are not proven by this local harness",
      "BH-I01 is privileged refund documentation/availability risk; BH-I02 and BH-I03 are owner-authorized staker/delivery/accounting caveats; BH-I04 is possible forced residue with no observed capture path",
      "No arbitrary destination, outsider bypass, residue capture, permissionless loss, positive economics, execution authority, or route is established",
      "Broader EtherFi capability and economic coverage remains incomplete",
    ] : recoveryInvariantBoundedPass ? [
      "Step 2 passes bounded local valid-authorization and full-current-balance invariants on exact Recovery source linked to the Step 1 runtime; it is not complete deployed EtherFiSafe authorization proof",
      "ERC-1271 and mixed owners, malformed and duplicate signatures, incoming-owner transitions, callbacks/reentrancy, adversarial tokens, live hook/DataProvider configuration, and current registry/Safe continuity remain open",
      "SAR-I01 is an informational documentation mismatch; SAR-I02 is an owner-authorized integration-accounting caveat; SAR-I03 is a documented operational availability constraint",
      "No outsider bypass, arbitrary target, permissionless extraction, protocol loss, positive economics, execution authority, or route is established",
      "BeHYPE fee/refund/delivery behavior and broader EtherFi capability/economic coverage remain incomplete",
    ] : unknownIdentityExact ? [
      "The two formerly unidentified defaults are exactly identified and runtime-bound, but this is identity/capability evidence only and does not establish vulnerability, loss, authorization bypass, profit, or a route",
      "Three providers agreed on the finalized pin, while only two of three matched the retained full-state digest; this satisfies the retained threshold but is not three-provider full-state consensus",
      "SafeAssetRecovery creation-transaction attribution is unproven; identity rests on exact code boundary plus immutable-patched build/runtime equality",
      "SafeAssetRecovery current-state continuity, authorization, replay, deadline, supported-token exclusion, full-balance behavior, hook/debt interaction, and token behavior remain open",
      "BeHYPE downstream staker/delivery and token behavior remain open; the zero refund-gas mismatch is privileged refund-availability risk only, not outsider loss",
      "Broader EtherFi capability and economic coverage remains incomplete despite identifying all 11 defaults",
    ] : configDriftBoundedPass ? [
      "Qualified Step 4 result only: privileged asset-config drift is possible but unobserved across the selected request and 48 exact config-covered request/bridge pairs",
      "Full config-event history is established only from the current observed code-absent/code-present deployment boundary at block 149807571 through the pin, not across hypothetical prior address incarnations",
      "Current authority threshold and owner count are descriptive; exact nested module callers are not attributed from transaction origin",
      "Selected pool code, token, and standard proxy slots are stable, but configured-pool governance and implementation safety are outside this scope",
      "No permissionless actor, future immutability, economic issue, execution, bridge delivery, settlement, or extraction route is proven",
      "Broader EtherFi capability coverage, five out-of-scope defaults, persistent approvals/callbacks, non-standard token behavior, and bounded Safe sampling remain open",
    ] : stargateInvariantExact ? [
      "Step 3 proves only a bounded valid-authorization tuple invariant on the fixed source/runtime basis; the local mock is one-owner/one-threshold, while production multi-owner, recovery, and factory variants are source-linked but not dynamically exhausted",
      "Caller is intentionally unsigned and relayer-neutral; the proof establishes field integrity, not current signer intent or caller exclusivity",
      "Execute Cash-rechecks recipient, one-token shape, asset, and amount; destination EID, destination recipient, and max slippage are signed and preserved in Safe-keyed module storage but are not Cash-rechecked",
      "No withdrawal execution, bridge delivery, recipient receipt, economics, historical completeness, permissionless extraction, or authority to act is proven",
      "Asset-to-pool configuration can drift between request and execute; that does not invalidate this bounded invariant but requires a separate read-only assessment",
      "Broader EtherFi capability coverage, five out-of-scope defaults, persistent approvals/callbacks, non-standard token behavior, and bounded Safe sampling remain open",
    ] : pendingTupleExact ? [
      "Step 2 closes tuple discovery only for one selected StargateModule/CashModule safe-keyed pending tuple at the exact pin; it does not prove valid-signature tuple isolation",
      "Retained event coverage is limited to blocks 154529180-154534581 with three-provider log-set consensus; full module history and full-history absence remain unproven",
      "No withdrawal execution, execution success, settlement, recipient receipt, bridge delivery, economics, permissionless extraction, or authority to act is proven",
      "The capability review still covers only six named non-Cash modules; five live defaults including CashModule remain outside the authorization matrix and broad-negative conclusion",
      "Persistent approvals, later integration pulls/callbacks, non-standard token behavior, and bounded Safe sampling remain open",
    ] : bindingExact ? [
      "Step 1 establishes exact source/build/runtime binding only for the bounded six-component fixed-pin scope; it proves no exploit, route, pending-withdrawal condition, or execution authority",
      "All 14 capability probes matched their concrete expected revert selectors, but empty-signature altered-Safe/recipient probes establish outsider rejection only; valid-signature tuple isolation remains unproven",
      "The capability review covers only six named non-Cash modules; five live defaults including CashModule remain outside the matrix and broad-negative conclusion",
      "Persistent approvals, later integration pulls/callbacks, and non-standard token behavior remain open",
      "Bounded Safe sampling is not proof over every deployed Safe; exact DataProvider predicates are retained separately",
    ] : (Array.isArray(artifact.blockers) ? artifact.blockers : []),
    requiredForRoutePositive: Array.isArray(artifact.requiredForRoutePositive) ? artifact.requiredForRoutePositive : [],
    nextReadOnlyStep: behavioralRetryCaptureR8Current
      ? "Perform independent offline review of the sanitized R8 namespace-mismatch package and arithmetic only; do not infer absent raw details, and require a new separately reviewed authorization before any further capture."
      : behavioralCaptureR2Current
      ? "Draft a separate lower-concurrency/cooldown behavioral-capture proposal for independent review; do not execute automatically."
      : stateCanaryR14R3Current
      ? "Draft a separately scoped behavioral-requalification proposal for independent review; do not execute automatically."
      : hyperDiagnosticR10R2Current
      ? "Obtain a second distinct declared/observed usable HyperEVM provider-family group and match a fresh full behavioral tuple plus anchor; economics remains blocked until then."
      : receiveType1R8Current
      ? "Obtain at least two distinct declared/observed HyperEVM provider-family groups and bind a fresh fixed-pin full behavioral tuple plus anchor; economics remains blocked until that threshold is met."
      : endpointCoverageR5Final
      ? "Obtain separately authorized access to a declared second HyperEVM provider family and implement offline-correct library/config-selection ABI handling; economics remains blocked."
      : behypeBindingCoverageOpen
      ? "Provision responsive independent read-only providers and rerun coverage-only; do not model economics before threshold."
      : behypeInvariantBoundedPass
      ? "Next immediate task: under a separate read-only claim, bind the exact deployed staker identity/source/runtime and LayerZero receiver/options/delivery/retry/refund state; do not call stake or send a message."
      : recoveryInvariantBoundedPass
      ? "Next immediate task: under a separate claim, run local-only BeHYPE fee/refund/delivery invariants using the exact reviewed source; do not call the deployed stake entrypoint."
      : unknownIdentityExact
      ? "Next immediate task: under a separate claim, run one local-only SafeAssetRecoveryModule authorization/full-balance invariant test; do not call the deployed recover entrypoint."
      : configDriftBoundedPass
      ? "Conditional monitor only: revalidate if AssetConfigSet occurs or configured-pool code or standard proxy slots change; rotate now and do not execute."
      : stargateInvariantExact
      ? "Single next defensive action: under a separate read-only claim, assess Stargate asset-to-pool configuration drift between request and execute at a fixed pin; do not fork or execute any withdrawal."
      : pendingTupleExact
      ? "Next defensive action: under a separate claim, build one local-only invariant/property proof that every validly authorized Stargate request binds Safe, asset, amount, destination, recipient, and slippage through request and execute guards; do not execute any withdrawal."
      : bindingExact
      ? "Step 1 is complete. Step 2 may begin only under a separate claim as read-only discovery; do not presume a pending-withdrawal condition, exploit, route, or execution authority."
      : artifact.nextReadOnlyStep || "Recover pin-bound build inputs, then inspect one real pending scoped-module tuple read-only at the same finalized pin.",
    sourceArtifacts: [
      "reports/raw/fast/critical-etherfi-default-module-capability.json",
      "reports/raw/fast/critical-etherfi-default-module-capability-manifest.json",
      "reports/critical-etherfi-default-module-capability.md",
      "reports/raw/fast/critical-etherfi-pinbound-build-binding.json",
      "reports/raw/fast/critical-etherfi-pinbound-build-binding-manifest.json",
      "reports/critical-etherfi-pinbound-build-binding.md",
      "reports/raw/fast/critical-etherfi-pending-withdrawal-tuple.json",
      "reports/raw/fast/critical-etherfi-pending-withdrawal-tuple-manifest.json",
      "reports/critical-etherfi-pending-withdrawal-tuple.md",
      "reports/raw/fast/critical-etherfi-stargate-valid-auth-tuple-invariant.json",
      "reports/raw/fast/critical-etherfi-stargate-valid-auth-tuple-invariant-manifest.json",
      "reports/critical-etherfi-stargate-valid-auth-tuple-invariant.md",
      "reports/raw/fast/critical-etherfi-stargate-asset-config-drift.json",
      "reports/raw/fast/critical-etherfi-stargate-asset-config-drift-manifest.json",
      "reports/critical-etherfi-stargate-asset-config-drift.md",
      "reports/raw/fast/critical-etherfi-unknown-default-identity-binding.json",
      "reports/raw/fast/critical-etherfi-unknown-default-identity-binding-manifest.json",
      "reports/critical-etherfi-unknown-default-identity-binding.md",
      "reports/raw/fast/critical-etherfi-safe-asset-recovery-invariant.json",
      "reports/raw/fast/critical-etherfi-safe-asset-recovery-invariant-manifest.json",
      "reports/critical-etherfi-safe-asset-recovery-invariant.md",
      "reports/raw/fast/critical-etherfi-behype-fee-refund-delivery-invariant.json",
      "reports/raw/fast/critical-etherfi-behype-fee-refund-delivery-invariant-manifest.json",
      "reports/critical-etherfi-behype-fee-refund-delivery-invariant.md",
      "reports/raw/fast/critical-etherfi-behype-staker-layerzero-binding.json",
      "reports/raw/fast/critical-etherfi-behype-staker-layerzero-binding-manifest.json",
      "reports/critical-etherfi-behype-staker-layerzero-binding.md",
      "reports/raw/fast/critical-etherfi-behype-endpoint-coverage-repair.json",
      "reports/raw/fast/critical-etherfi-behype-endpoint-coverage-repair-manifest.json",
      "reports/critical-etherfi-behype-endpoint-coverage-repair.md",
      "reports/raw/fast/critical-etherfi-behype-selected-library-binding.json",
      "reports/raw/fast/critical-etherfi-behype-selected-library-binding-manifest.json",
      "reports/critical-etherfi-behype-selected-library-binding.md",
      "reports/raw/fast/critical-etherfi-behype-receive-type1-negative-check.json",
      "reports/raw/fast/critical-etherfi-behype-receive-type1-negative-check-manifest.json",
      "reports/critical-etherfi-behype-receive-type1-negative-check.md",
      "reports/raw/fast/critical-etherfi-behype-hyperevm-diagnostic-r10-r2.json",
      "reports/raw/fast/critical-etherfi-behype-hyperevm-diagnostic-r10-r2-manifest.json",
      "reports/critical-etherfi-behype-hyperevm-diagnostic-r10-r2.md",
      "reports/raw/fast/critical-etherfi-hyperevm-state-canary-r14-r3.json",
      "reports/raw/fast/critical-etherfi-hyperevm-state-canary-r14-r3-manifest.json",
      "reports/critical-etherfi-hyperevm-state-canary-r14-r3.md",
      "reports/raw/fast/critical-etherfi-behype-hyperevm-requalification-r12.json",
      "reports/raw/fast/critical-etherfi-hyperevm-header-consensus-r13-r3.json",
      "reports/raw/fast/critical-etherfi-hyperevm-state-canary-r14.json",
      "reports/raw/fast/critical-etherfi-hyperevm-state-canary-r14-r2.json",
      "reports/raw/fast/critical-etherfi-behype-hyperevm-behavioral-requalification-capture-r2.json",
      "reports/raw/fast/critical-etherfi-behype-hyperevm-behavioral-requalification-capture-r2-manifest.json",
      "reports/critical-etherfi-behype-hyperevm-behavioral-requalification-capture-r2.md",
      "reports/raw/fast/critical-etherfi-behype-hyperevm-behavioral-retry-capture-r8.json",
      "reports/raw/fast/critical-etherfi-behype-hyperevm-behavioral-retry-capture-r8-manifest.json",
      "reports/critical-etherfi-behype-hyperevm-behavioral-retry-capture-r8.md",
    ],
  });
}

function morphoPythCandidate(scan = {}, preflight = {}) {
  const scanSummary = scan.summary || {};
  const preSummary = preflight.summary || {};
  const routePositive = routePositiveMax(scanSummary.routePositive, preSummary.routePositive, preflight.safety?.routePositive);
  const watchCandidates = asNumber(scanSummary.watchCandidates) || 0;
  const inspected = asNumber(scanSummary.routeRelevantMarketsInspected) || 0;
  const maxAcceptedVsReferenceBps = asNumber(preSummary.maxAcceptedVsReferenceBps);
  const minRequiredPremiumBps = asNumber(preSummary.minRequiredPremiumBps);
  const preflightRows = Array.isArray(preflight.rows) ? preflight.rows : [];
  const staleFeedRows = asNumber(preSummary.staleFeedRows) || 0;
  const priorityScore = 34
    + (routePositive > 0 ? 25 : 0)
    + clamp(watchCandidates / 3, 0, 1) * 8
    + clamp(inspected / 150, 0, 1) * 6
    + (preflight.generatedAt ? 3 : 0);
  return rankCandidate({
    id: "morpho-pyth-unsafe-consumer-sweep",
    protocol: "Morpho Blue",
    chain: "Ethereum/Base/Arbitrum",
    surface: "Pyth-linked/unsafe-oracle consumer join",
    status: routePositive > 0 ? "route-positive-needs-fork-proof" : preflight.generatedAt ? preSummary.status || "bounded-pyth-route-negative" : "pyth-consumer-watch-needs-feed-decode-and-exact-economics",
    priorityScore,
    routePositive,
    distance: {
      watchCandidates,
      routeRelevantMarketsInspected: inspected,
      pythLinkedMarkets: asNumber(scanSummary.pythLinkedMarkets) || 0,
      pythUnsafeMarkets: asNumber(scanSummary.pythUnsafeMarkets) || 0,
      staleFeedRows,
      referencePricedRows: asNumber(preSummary.referencePricedRows) || 0,
      routePositive,
      summary: { ...scanSummary, preflightStatus: preSummary.status || null, maxAcceptedVsReferenceBps, minRequiredPremiumBps },
    },
    economics: {
      bestEdgeBps: round(maxAcceptedVsReferenceBps, 6),
      requiredPremiumBps: round(minRequiredPremiumBps, 6),
      bestLiquidityUsd: round(asNumber(scanSummary.maxWatchLiquidityUsd) ?? asNumber(scanSummary.maxLiquidityUsd), 2),
      bestEstimatedEdgeUsdAtLiquidity: round(maxBy(preflightRows, (row) => row.estimatedEdgeUsdAtLiquidity)?.estimatedEdgeUsdAtLiquidity, 6),
    },
    topRows: summarizeGenericRows(preflight.generatedAt ? preflight : scan),
    blockers: routePositive > 0
      ? ["Needs fork extraction proof before any signed action"]
      : preflight.generatedAt
        ? [
            "Pyth getPriceNoOlderThan succeeds for the watch row; no stale feed window is active",
            "Accepted-vs-reference value is below LLTV break-even plus gas/slippage",
            "No exact borrow/unwind route or fork-positive extraction proof",
          ]
        : [
            "Only current watch row uses bounded getPriceNoOlderThan, not unsafe Pyth",
            "Borrow liquidity is small and exact collateral acquisition/borrow/unwind economics are not proven",
            "No feed-id staleness/deviation decode or fork-positive extraction proof",
          ],
    requiredForRoutePositive: [
      "Morpho market uses a stale, unsafe, or materially divergent Pyth value",
      "accepted collateral value exceeds exact acquisition cost after LLTV haircut",
      "borrow-side liquidity and unwind route are positive after gas/slippage",
      "local fork extraction proof",
    ],
    nextReadOnlyStep: routePositive > 0
      ? "Build a local fork extraction harness before any live action."
      : "Keep wSPYx/AUSD on watch; refresh preflight only if feed age approaches maxAge, liquidity grows, or accepted-vs-reference premium nears LLTV break-even.",
    sourceArtifacts: ["reports/raw/fast/morpho-pyth-unsafe-consumers.json", "reports/raw/fast/morpho-pyth-watch-row-preflight.json"],
  });
}

function apyusdForkProofCandidate(routeArtifact = {}, proof = {}) {
  const routeSummary = routeArtifact.summary || {};
  const result = proof.result || {};
  const forkPositive = result.success === true && result.forkProfitPositive === true && (asNumber(result.netProfitUsd) || 0) > 0;
  const staleRoutePositive = routePositiveCount(routeSummary.routePositive, routeArtifact.safety?.routePositive);
  const exitReverts = [revertLabel(result.redeemRevert), revertLabel(result.withdrawRevert)].filter(Boolean);
  return rankCandidate({
    id: "apyusd-erc4626-fork-proof-sweep",
    protocol: "apyUSD / Curve",
    chain: "Ethereum",
    surface: "apyUSD ERC4626 redeem route fork proof override",
    status: forkPositive ? "fork-positive-needs-live-preflight" : staleRoutePositive > 0 ? "fork-proof-negative-route-revoked" : "fork-proof-negative",
    priorityScore: forkPositive ? 88 : staleRoutePositive > 0 ? 44 : 26,
    routePositive: forkPositive ? 1 : 0,
    distance: {
      staleRoutePositive,
      forkProfitPositive: Boolean(result.forkProfitPositive),
      success: Boolean(result.success),
      redeemError: result.redeemError || null,
      redeemRevert: result.redeemRevert || null,
      withdrawError: result.withdrawError || null,
      withdrawRevert: result.withdrawRevert || null,
      exitMethod: result.exitMethod || null,
      netProfitUsd: round(result.netProfitUsd, 6),
    },
    economics: {
      routeExpectedNetUsd: round(routeArtifact?.route?.expectedNetUsd ?? routeSummary.bestNetUsd, 6),
      forkNetProfitUsd: round(result.netProfitUsd, 6),
      gasUsd: round(result.gasUsd, 6),
    },
    topRows: [],
    blockers: forkPositive
      ? ["Needs fresh exact route preflight and explicit authorization before any live action"]
      : [...(result.blockers || ["Fork proof is not positive", "No signed action justified"]), ...exitReverts.map((label) => `Decoded exit revert: ${label}`)],
    requiredForRoutePositive: ["fork redeem/extraction succeeds", "netProfitUsd > 0 after gas", "fresh exact quote remains positive"],
    nextReadOnlyStep: "Keep apyUSD fail-closed unless a new exact route and fork proof both turn positive.",
    sourceArtifacts: ["reports/raw/fast/apyusd-erc4626-redeem-route.json", "reports/raw/fast/apyusd-erc4626-fork-proof.json"],
  });
}

function staderForkTransactionCandidate(forkArtifact = {}, fullArtifact = {}) {
  const metrics = forkArtifact.metrics || {};
  const rawRoutePositive = routePositiveMax(
    forkArtifact.routePositive,
    metrics.routePositive,
    forkArtifact.sourceRoutePositives?.routePositive,
    fullArtifact.routePositive,
    fullArtifact.summary?.routePositive,
  );
  const txAttempts = asNumber(metrics.txAttempts) || 0;
  const txSuccesses = asNumber(metrics.txSuccesses) || 0;
  const txReverts = asNumber(metrics.txReverts) || 0;
  const valueDeltaPositiveRows = asNumber(metrics.valueDeltaPositiveRows) || 0;
  const forkJustified = Boolean(forkArtifact.forkJustified || metrics.forkJustified);
  const hasPositiveEvidence = rawRoutePositive > 0 && valueDeltaPositiveRows > 0 && forkJustified;
  const effectiveRoutePositive = hasPositiveEvidence ? rawRoutePositive : 0;
  const blocked = Boolean(forkArtifact.blocked);

  const topRows = (Array.isArray(forkArtifact.targetsResults) ? forkArtifact.targetsResults : [])
    .slice(0, 5)
    .map((target) => {
      const attempts = Array.isArray(target.attempts) ? target.attempts : [];
      return {
        protocol: "Stader",
        chain: "Ethereum fork",
        symbol: target.tokenContext?.tokenSymbol || null,
        pair: target.address || null,
        routePositive: attempts.some((attempt) => attempt.valueDeltaPositive),
        blocker: `${attempts.filter((attempt) => attempt.success).length}/${attempts.length} tx attempts succeeded; ${attempts.filter((attempt) => attempt.valueDeltaPositive).length} positive value deltas`,
      };
    });

  return rankCandidate({
    id: "stader-fork-transaction-test-sweep",
    protocol: "Stader",
    chain: "Ethereum local fork; BNB/Fantom/Hedera/Terra2/Near remain outside this tx harness",
    surface: "Local Anvil transaction test for Stader redeem, withdraw, claim, unstake, and instantRedeem selectors",
    status: blocked
      ? "stader-fork-transaction-test-blocked"
      : hasPositiveEvidence
        ? "fork-positive-needs-review"
        : rawRoutePositive > 0
          ? "stader-fork-proof-negative-route-revoked"
          : txAttempts > 0
            ? "stader-fork-transaction-test-no-positive-delta"
            : "stader-fork-transaction-test-no-attempts",
    priorityScore: 40
      + (txAttempts > 0 ? 3 : 0)
      + (fullArtifact.generatedAt ? 2 : 0)
      + (hasPositiveEvidence ? 35 : 0),
    routePositive: effectiveRoutePositive,
    forkGate: hasPositiveEvidence ? "fork-positive-needs-live-preflight" : forkArtifact.forkGate || "closed-route-positive-zero",
    distance: {
      txAttempts,
      txSuccesses,
      txReverts,
      valueDeltaPositiveRows,
      rawRoutePositive,
      effectiveRoutePositive,
      forkJustified,
      anvilAvailable: Boolean(forkArtifact.anvilAvailable),
      sourceFullTestRoutePositive: asNumber(fullArtifact.routePositive ?? fullArtifact.summary?.routePositive) || 0,
    },
    economics: {
      positiveValueDeltaRows: valueDeltaPositiveRows,
      txSuccesses,
    },
    topRows,
    blockers: hasPositiveEvidence
      ? [
          "Local fork-positive evidence requires independent reviewer/oracle validation before any live preflight",
          "Exact acquisition, unwind, gas, liquidity, and minProfit/minOut gates must be rebuilt from fresh read-only state",
          "Live signed action remains prohibited without explicit route-specific authorization",
        ]
      : blocked
        ? (forkArtifact.blockers || ["Fork transaction test did not complete; rerun local-only harness before changing gates"])
        : [
            `Local fork harness ran ${txAttempts} transaction attempts with ${txSuccesses} successes and ${valueDeltaPositiveRows} positive value-delta rows`,
            "Sampled redeem, withdraw, claim, unstake, and instantRedeem selectors did not produce attacker-controlled positive balances",
            "No Stader producer rate/accounting/queue/oracle anomaly is proven by the fork attempts",
            "No exact positive acquisition, borrow, redeem, liquidation, claim, or DEX unwind economics exist",
            "Live transactions, broadcasts, and signed actions remain closed",
          ],
    requiredForRoutePositive: [
      "local fork transaction path produces attacker-controlled positive value delta",
      "selector success maps to a current permissionless Stader redeem, withdraw, claim, unstake, liquidation, or exit route",
      "exact route economics remain positive after gas, queues, slippage, haircuts, caps, and liquidity",
      "independent review confirms no artifact/measurement ambiguity before any live preflight",
      "explicit route-specific authorization before any live signed action",
    ],
    nextReadOnlyStep: hasPositiveEvidence
      ? "Stop before live action; send the fork-positive artifact to reviewer/oracle, then rebuild fresh read-only preflight and exact economics."
      : "Keep Stader dormant; rerun local fork tx tests only if a future Stader rate/accounting/queue anomaly maps to a material consumer or exit venue with exact-positive economics.",
    sourceArtifacts: [
      "reports/raw/fast/stader-fork-transaction-test.json",
      "reports/stader-fork-transaction-test.md",
      "reports/raw/fast/stader-full-test.json",
    ],
  });
}

const GENERIC_SURFACES = [
  {
    key: "digiftRwaPrefilter",
    id: "digift-rwa-route-prefilter-sweep",
    protocol: "DigiFT",
    chain: "Ethereum/Arbitrum/BNB Chain/Plume context",
    surface: "DigiFT RWA registry/token, public-price supply, local consumer, DEX liquidity, and route prefilter",
    baseScore: 39,
    routePositiveFields: ["routePositive", "executableNow"],
    watchFields: ["consumerJoinRows", "exactEconomicsRows", "dexLiquidityRows"],
    researchFields: ["registryRecords", "scopedTokenRows", "tokensScanned", "codePresentRows", "localConsumerRows"],
    liquidityFields: ["maxDexLiquidityUsd"],
    closedStatus: "digift-rwa-prefilter-no-route-positive",
    watchStatus: "digift-watch-needs-consumer-dex-or-public-redemption-route",
    sourceArtifacts: ["reports/raw/fast/prefilter-digift-rwa-route-prefilter.json"],
    blockers: [
      "No exact lending, Pendle, vault, or borrow consumer join was found in local artifacts for scanned DigiFT tokens",
      "No material DEX liquidity row was found for public acquisition or unwind",
      "Redemption and transfer constraints remain likely permissioned until source/role paths are proven public",
      "Plume registry rows returned no token code in this pass, so Plume mapping remains inconclusive rather than route-negative",
      "No accepted-value divergence or positive exact route exists from current evidence",
      "No fork extraction proof",
    ],
    requiredForRoutePositive: [
      "Exact DigiFT token accepted by a live lending, margin, redemption, PT/vault, or liquidation consumer with material liquidity",
      "public acquisition, redemption, or DEX route prices below accepted NAV/value after haircuts",
      "borrow, redemption, liquidation, or unwind economics are exact-positive after fees, slippage, caps, queues, and gas",
      "fork/static proof before any live or signed action",
    ],
    nextReadOnlyStep: "Keep DigiFT closed unless a registry token appears in a live consumer, DEX liquidity materializes, or public redemption/acquisition can be priced against accepted NAV.",
  },
  {
    key: "gaibRwaPrefilter",
    id: "gaib-rwa-route-prefilter-sweep",
    protocol: "GAIB",
    chain: "Ethereum/Arbitrum/Base/BNB Chain/Sei; Story blocked",
    surface: "GAIB AID/AIDa migration, pool-share accounting, DEX liquidity, local artifact matches, and route prefilter",
    baseScore: 39,
    routePositiveFields: ["routePositive", "executableNow"],
    watchFields: ["consumerJoinRows", "exactEconomicsRows"],
    researchFields: ["aidRows", "poolRows", "codePresentPoolRows", "localArtifactMatchRows", "publicRedeemRows"],
    liquidityFields: ["maxDexLiquidityUsd"],
    closedStatus: "gaib-rwa-prefilter-no-route-positive-story-blocked",
    watchStatus: "gaib-watch-needs-public-redeem-migration-or-consumer-route",
    sourceArtifacts: ["reports/raw/fast/prefilter-gaib-rwa-route-prefilter.json", "reports/raw/fast/rpc-blocked-backlog.json"],
    blockers: [
      "AIDa pool accounting is visible through totalAssets, totalSupply, convertToAssets, and previewRedeem, but no public same-transaction redeem, migrate, or claim extraction path is proven",
      "Migration-held shares reduce claimable adapter TVL and do not create a permissionless extraction route by themselves",
      "Local artifact matches are references, not true lending/vault/borrow consumers with accepted-value liquidity",
      "DEX liquidity is too small and not joined to a positive accepted-value route",
      "Story chain coverage is RPC-blocked and must be retested before closing Story route coverage",
      "No exact positive borrow, redeem, liquidation, migration-claim, or DEX unwind route exists from current evidence",
      "No fork extraction proof",
    ],
    requiredForRoutePositive: [
      "public redeem, migrate, or claim path converts exact AIDa shares into underlying in the same transaction or without capital/delay blockers",
      "AID or AIDa accepted by a live consumer with borrow, redeem, liquidation, or migration liquidity",
      "accepted value exceeds acquisition and unwind cost after fees, slippage, caps, queues, and gas",
      "Story coverage is resolved if the route depends on Story",
      "fork/static proof before any live or signed action",
    ],
    nextReadOnlyStep: "Keep GAIB closed for queried chains but blocked for Story; reopen if public redeem/migration is proven, AID/AIDa joins a live consumer with positive economics, or a sanitized Story RPC/preset becomes available.",
  },
  {
    key: "emberProtocolPrefilter",
    id: "ember-protocol-route-prefilter-sweep",
    protocol: "Ember Protocol",
    chain: "Ethereum/Base; Pharos and Sui caveats",
    surface: "Ember/Bluefin public vault config, ERC4626-style accounting, deposit/redeem gates, local artifact matches, DEX liquidity, and route prefilter",
    baseScore: 39,
    routePositiveFields: ["routePositive", "executableNow"],
    watchFields: ["consumerJoinRows", "exactEconomicsRows", "dexLiquidityRows"],
    researchFields: ["configVaults", "configChainRows", "evmScannedRows", "codePresentRows", "activePublicRows", "sameEpochConfigRows", "publicDepositRows", "localArtifactMatchRows"],
    liquidityFields: ["maxDexLiquidityUsd"],
    closedStatus: "ember-protocol-prefilter-no-route-positive-pharos-sui-caveats",
    watchStatus: "ember-watch-needs-public-redeem-or-consumer-route",
    sourceArtifacts: ["reports/raw/fast/prefilter-ember-protocol-route-prefilter.json", "reports/raw/fast/rpc-blocked-backlog.json"],
    blockers: [
      "ERC4626/accounting probes are visible on scanned EVM vaults, but no accepted-value consumer join is proven",
      "Several top rows are blocked by maxDeposit=0, private status, or configured withdrawal delays",
      "Local Pendle artifact references are not exact live consumer rows with material borrow, redemption, or liquidation liquidity",
      "Receipt-token DEX liquidity is absent at scanner threshold, so acquisition and unwind are not executable at material size",
      "Pharos and Sui coverage remain unresolved if a route depends on those chains",
      "No exact positive borrow, redeem, liquidation, or DEX unwind route exists from current evidence",
      "No fork extraction proof",
    ],
    requiredForRoutePositive: [
      "Ember receipt can be acquired below same-block redeemable value with no cap, private, or delay blocker",
      "receipt accepted by a live consumer with material borrow, redeem, or liquidation liquidity",
      "accepted value exceeds acquisition and unwind cost after withdrawal delay, caps, fees, slippage, and gas",
      "Pharos or Sui coverage is resolved if the route depends on those chains",
      "fork/static proof before any live or signed action",
    ],
    nextReadOnlyStep: "Keep Ember closed for queried EVM rows but blocked for Pharos/Sui caveats; reopen if public same-block redeem is proven, a live consumer join appears, or sanitized Pharos/Sui state becomes available.",
  },
  {
    key: "mainstreetPrefilter",
    id: "mainstreet-route-prefilter-sweep",
    protocol: "Mainstreet",
    chain: "Ethereum/Base context",
    surface: "Mainstreet msUSD/msUSDC/msY token, ERC4626 accounting, Balancer/Pendle/Euler consumer, DEX liquidity, and route prefilter",
    baseScore: 40,
    routePositiveFields: ["routePositive", "executableNow"],
    watchFields: ["consumerJoinRows", "dexLiquidityRows", "currentProfitLeadRows", "donationRows"],
    researchFields: ["tokenRows", "codePresentRows", "erc4626ProbeRows", "balancerPoolRows", "pendleRows", "eulerVaultRows", "evaultRouteRows", "localArtifactMatchRows"],
    liquidityFields: ["materialDexLiquidityUsd", "balancerLiquidityUsd", "pendleLiquidityUsd"],
    closedStatus: "mainstreet-prefilter-no-route-positive",
    watchStatus: "mainstreet-watch-needs-msusd-msy-exact-positive-consumer-or-redemption-route",
    sourceArtifacts: ["reports/raw/fast/prefilter-mainstreet-route-prefilter.json"],
    blockers: [
      "The msUSD depeg/price discrepancy is not extractive without public redemption, accepted-value overvaluation, or a positive wrapper route",
      "msUSD selector scan did not find common public redeem, withdraw, deposit, or ERC4626 selectors",
      "Euler/EVK msUSD borrow-side cash is below material low/no-capital thresholds",
      "msUSDC donation route is blocked by maxDeposit=0, no consumers, and negative modeled net",
      "Pendle and Balancer rows provide liquidity context but no current producer anomaly or consumer-specific positive economics",
      "No exact positive borrow, redeem, liquidation, donation, PT, or DEX unwind route exists from current evidence",
      "No fork extraction proof",
    ],
    requiredForRoutePositive: [
      "msUSD, msUSDC, msY, or PT/YT token is accepted by a live material borrow, redemption, liquidation, or margin consumer",
      "public acquisition or wrapper redemption can realize value above acquisition plus LTV/LLTV haircuts, fees, slippage, caps, queues, and gas",
      "Euler/EVK, Pendle, Balancer, or another joined route has exact positive same-block economics with material liquidity",
      "fork/static proof before any live or signed action",
    ],
    nextReadOnlyStep: "Keep Mainstreet on watch; reopen only if exact quotes show positive msY or msUSD acquire/redeem/sell economics, or if a live lending consumer materially overvalues Mainstreet collateral with enough borrow cash.",
  },
  {
    key: "overnightFinancePrefilter",
    id: "overnight-finance-route-prefilter-sweep",
    protocol: "Overnight Finance",
    chain: "Blast/Base/Arbitrum",
    surface: "Overnight USD+/USDC+/DAI+/ETH+ m2m strategy NAV, consumer, DEX liquidity, and route prefilter",
    baseScore: 38,
    routePositiveFields: ["routePositive", "executableNow"],
    watchFields: ["consumerJoinRows", "dexLiquidityRows", "exactEconomicsRows"],
    researchFields: ["tokenRows", "codePresentRows", "strategyProbeRows", "totalStrategyRows", "localArtifactMatchRows"],
    liquidityFields: ["strategyNetAssetValueUsd", "strategyLiquidationValueUsd", "maxDexLiquidityUsd"],
    closedStatus: "overnight-finance-prefilter-no-route-positive",
    watchStatus: "overnight-watch-needs-consumer-dex-or-nav-gap-route",
    sourceArtifacts: ["reports/raw/fast/prefilter-overnight-finance-route-prefilter.json"],
    blockers: [
      "strategyAssets exposes readable NAV and liquidation value, but no NAV/liquidation divergence was found",
      "Exact scoped Overnight addresses do not join to local lending, oracle, or route artifacts",
      "No public DEX liquidity rows were found for the scoped m2m addresses",
      "ERC20-like metadata/supply calls do not prove transferable receipt acquisition or atomic redemption",
      "No borrow, liquidation, redemption, or unwind edge has positive read-only economics after fees, slippage, caps, and gas",
      "No fork extraction proof",
    ],
    requiredForRoutePositive: [
      "Overnight receipt or m2m-linked asset can be acquired below same-block redeemable value with transfer/acquisition proven",
      "live lending/oracle consumer materially overvalues the exact Overnight asset with enough borrow or liquidation value",
      "borrow, redemption, liquidation, or DEX unwind economics are exact-positive after fees, slippage, caps, queues, and gas",
      "fork/static proof before any live or signed action",
    ],
    nextReadOnlyStep: "Keep Overnight closed unless an exact Overnight receipt joins a live material consumer, public liquidity appears, or NAV/redeemable value diverges enough to make acquire/redeem/unwind economics positive.",
  },
  {
    key: "spectraMetavaultsPrefilter",
    id: "spectra-metavaults-route-prefilter-sweep",
    protocol: "Spectra MetaVaults Outside V2",
    chain: "Ethereum/Arbitrum/Avalanche/Base; Flare/Katana caveats",
    surface: "Spectra MetaVaults adapter-address, vault/share, local consumer, DEX liquidity, and route prefilter",
    baseScore: 39,
    routePositiveFields: ["routePositive", "executableNow"],
    watchFields: ["consumerJoinRows", "exactEconomicsRows", "dexLiquidityRows", "rpcBlockedRows"],
    researchFields: ["addressRowsChecked", "localArtifactMatchRows"],
    liquidityFields: ["maxDexLiquidityUsd"],
    closedStatus: "spectra-metavaults-prefilter-no-route-positive-rpc-caveat",
    watchStatus: "spectra-metavaults-watch-needs-onchain-consumer-or-exit-proof",
    sourceArtifacts: ["reports/raw/fast/prefilter-spectra-metavaults-route-prefilter.json"],
    blockers: [
      "Adapter/source discovery found candidate MetaVault addresses, but local matches are context-only",
      "No material trusted consumer join with borrow cash was found for the candidate shares",
      "No same-block redeem, exit, acquisition, donation, or liquidation route was proven",
      "No DEX liquidity or exact-positive economics were proven in the bounded safe run",
      "On-chain RPC probing was intentionally skipped; coverage gap is a caveat, not route-negative proof",
      "No fork/static value-delta proof",
    ],
    requiredForRoutePositive: [
      "exact Spectra share or receipt token is accepted by a live material lending/oracle consumer",
      "accepted value exceeds acquisition, redeem, liquidation, or unwind costs after haircuts, fees, slippage, caps, queues, and gas",
      "same-block redeem/exit or another permissionless value path is proven for the exact token and size",
      "Flare/Katana or any needed chain coverage is resolved with sanitized endpoints or public state artifacts",
      "fork/static proof before any live or signed action",
    ],
    nextReadOnlyStep: "Keep Spectra dormant unless on-chain consumer/DEX coverage shows a material joined share route or a same-block redeem/exit proof with exact positive economics.",
  },
  {
    key: "wrappedFiPrefilter",
    id: "wrappedfi-route-prefilter-sweep",
    protocol: "WrappedFi",
    chain: "Ethereum/Celo; Ripple caveat",
    surface: "WrappedFi bridge/custody, wrapped-token, local consumer, DEX liquidity, and route prefilter",
    baseScore: 38,
    routePositiveFields: ["routePositive", "executableNow"],
    watchFields: ["consumerJoinRows", "exactEconomicsRows", "bridgeProbeRows", "rpcBlockedRows"],
    researchFields: ["addressRowsChecked", "addressRowsCount", "localArtifactMatchRows", "onchainRows", "codePresentRows"],
    quoteFields: ["selectorRowsSuccessful"],
    liquidityFields: ["maxDexLiquidityUsd"],
    closedStatus: "wrappedfi-prefilter-no-route-positive-ripple-caveat",
    watchStatus: "wrappedfi-watch-needs-proof-bypass-consumer-or-dex-route",
    sourceArtifacts: ["reports/raw/fast/prefilter-wrappedfi-route-prefilter.json"],
    blockers: [
      "Adapter/source context resolved only a bounded candidate set and no code-present EVM candidate rows",
      "No bridge proof/domain/nonce/token/recipient binding bypass was demonstrated",
      "No WrappedFi-specific wrapped token joined a material lending, oracle, or liquidation consumer in local artifacts",
      "No DEX liquidity or exact-positive acquisition, borrow, redeem, liquidation, or unwind economics were proven",
      "Ripple remains non-EVM coverage caveat and is not closed route-negative in this EVM pass",
      "No fork/static value-delta proof",
    ],
    requiredForRoutePositive: [
      "deployed WrappedFi bridge/wrapper row exposes a permissionless proof, custody, mint, unlock, or backing mismatch path",
      "affected wrapped asset is accepted by a material lending, oracle, redemption, DEX, or liquidation consumer",
      "exact acquisition/unlock/borrow/redeem/liquidation/unwind economics are positive after fees, caps, queues, finality, slippage, and gas",
      "Ripple or any non-EVM dependency is resolved if the route depends on it",
      "fork/static proof before any live or signed action",
    ],
    nextReadOnlyStep: "Keep WrappedFi dormant unless exact deployed bridge/wrapped-token rows gain code, consumer joins, proof/balance-delta evidence, or DEX liquidity with positive economics.",
  },
  {
    key: "wrappedFiFullTest",
    id: "wrappedfi-full-test-sweep",
    protocol: "WrappedFi",
    chain: "Ethereum/Celo; Ripple caveat",
    surface: "Full WrappedFi custody/backing, proof/domain/nonce, mint/burn/unlock/redeem, admin/gateway, WXRP/Ripple caveat, consumer, DEX/exit, fork-prerequisite, and exact-economics route-positive test",
    baseScore: 42,
    routePositiveFields: ["routePositive", "executableNow"],
    watchFields: ["consumerJoinRows", "dexExitContextRows", "dexLiquidityRows", "exitLiquidityRows", "proofDomainNonceRows", "mintBurnUnlockRedeemRows", "custodyBackingRows", "wxrpTokenRows", "forkPrereqRows"],
    researchFields: ["sourceFactRows", "chainSeedRows", "addressSeedRows", "priorPrefilterRows", "priorPrefilterAddressRowsCount", "priorPrefilterLocalArtifactMatchRows", "priorPrefilterCodePresentRows", "priorPrefilterBridgeProbeRows", "localArtifactMatchRows", "exactLocalArtifactMatchRows", "filesWithLocalMatches", "candidateMatrixRows", "skippedNoCodeRows", "candidateMatrixProofGapRows"],
    quoteFields: ["exactEconomicsRows", "candidatesWithExactEconomics"],
    liquidityFields: [],
    closedStatus: "wrappedfi-full-test-no-route-positive",
    watchStatus: "wrappedfi-watch-needs-proof-bypass-consumer-or-dex-route",
    sourceArtifacts: ["reports/raw/fast/wrappedfi-full-test.json", "reports/wrappedfi-full-test-triage.md"],
    blockers: [
      "Known EVM candidate samples are no-code/static custody owner rows in prior prefilter; no deployed code-present bridge/wrapper/gateway/escrow/verifier route is proven",
      "Static/local candidate matrix covers both fallback custody-owner samples on Ethereum and Celo, Ethereum WXRP token context, and Ripple custody owner caveat, but every candidate lacks required code/state/proof/economics",
      "WXRP token and implementation rows are public static context only; active proxy/state, custody backing, consumer acceptance, and exit economics are not proven",
      "No proof/domain/nonce/recipient binding bypass, processed-message replay, claim reuse, or used-nonce flaw is proven",
      "No material lending/DEX consumer accepts a proven WrappedFi wrapped asset with exact positive borrow/unlock/exit economics",
      "Ripple remains non-EVM coverage caveat and cannot be closed by local EVM fork testing",
      "No fork/static value-delta proof and no signed action justified",
    ],
    requiredForRoutePositive: [
      "code-present deployed bridge/wrapper/gateway/escrow/verifier/wrapped ERC20 is mapped for Ethereum or Celo, with Ripple dependency resolved if relevant",
      "permissionless mint/burn/burnFrom/redeem/withdraw/claim/completeTransfer/finalizeBridgeERC20/unlock/executeMessage path is reachable without privileged roles",
      "proof/domain/nonce/recipient/token binding flaw or custody/backing mismatch is proven for a specific asset and chain pair",
      "affected wrapped asset is accepted by a material solvent lending/DEX/redeem consumer or has exact route-size exit liquidity",
      "exact economics show netLiquidUsd > 0 after gas, fees, slippage, bridge costs, finality, and custody constraints",
      "local fork/value-delta harness demonstrates positive attacker-controlled balance movement before any live preflight",
      "independent defensive review and explicit route-specific authorization before any signed transaction consideration",
    ],
    nextReadOnlyStep: "Keep WrappedFi dormant until a code-present bridge/wrapper/gateway/escrow/verifier/wrapped ERC20 maps to a permissionless proof/custody or mint/unlock path plus a solvent consumer/DEX/redeem exit with exact positive economics; then run the local-only fork harness for value-delta proof.",
  },
  {
    key: "wrappedFiForkRouteTest",
    id: "wrappedfi-fork-route-test-sweep",
    protocol: "WrappedFi local fork harness",
    chain: "localhost Anvil only when route-positive; skipped now",
    surface: "Local-only WrappedFi route/value-delta harness gated by route-positive candidate, code-present value-moving selector, and exact positive economics",
    baseScore: 30,
    routePositiveFields: ["routePositive", "valueDeltaPositiveRows", "executableNow"],
    watchFields: ["routePositiveCandidateRows", "skippedNoCodeRows"],
    researchFields: ["candidateRows", "nonEvmRows"],
    quoteFields: ["valueDeltaPositiveRows", "txAttempts"],
    closedStatus: "wrappedfi-fork-no-route-positive-candidate",
    watchStatus: "wrappedfi-fork-watch-route-positive-required",
    sourceArtifacts: ["reports/raw/fast/wrappedfi-fork-route-test.json", "reports/wrappedfi-fork-route-test.md", "reports/raw/fast/wrappedfi-full-test.json"],
    blockers: [
      "Harness emitted no-route-positive-candidate and attempted zero transactions",
      "Known EVM candidates are no-code/static or scanner routePositive=0",
      "No code-present value-moving selector with exact positive netLiquidUsd exists",
      "No local fork value-delta proof and no signed action justified",
    ],
    requiredForRoutePositive: [
      "scanner emits routePositive > 0 for a code-present deployed target",
      "exact positive netLiquidUsd route exists with solvent consumer or exit",
      "localhost-only Anvil simulation shows positive attacker-controlled balance delta",
      "no privileged impersonation/storage/code edits beyond gas funding and no broadcast",
    ],
    nextReadOnlyStep: "Do not run fork transactions until the WrappedFi full-test scanner emits a code-present route-positive candidate with exact positive economics.",
  },
  {
    key: "summerFiProPrefilter",
    id: "summer-fi-pro-route-prefilter-sweep",
    protocol: "Summer.fi Pro",
    chain: "Ethereum/Arbitrum/Optimism/Base",
    surface: "Summer.fi Pro/Oasis automation/CDP manager, MakerDAO/Aave/Spark/Morpho trigger, oracle, liquidation, and unwind route prefilter",
    baseScore: 37,
    routePositiveFields: ["routePositive", "executableNow"],
    watchFields: ["totalActiveTriggers", "consumerJoinRows", "dexLiquidityRows", "exactEconomicsRows", "rpcBlockedRows"],
    researchFields: ["contractRows", "codePresentRows", "totalTriggerAdded", "totalTriggerRemoved", "localArtifactMatchRows"],
    quoteFields: ["exactEconomicsRows"],
    liquidityFields: ["maxDexLiquidityUsd"],
    closedStatus: "summer-fi-pro-prefilter-no-route-positive",
    watchStatus: "summer-fi-pro-watch-needs-decoded-trigger-position-or-liquidation-economics",
    sourceArtifacts: ["reports/raw/fast/prefilter-summer-fi-pro-route-prefilter.json", "reports/prefilter-summer-fi-pro-route-prefilter.md"],
    blockers: [
      "Summer.fi Pro is an automation/management layer on top of MakerDAO/Aave/Spark/Morpho and does not issue its own token or oracle",
      "Code-present automation/data-provider rows are context only; no decoded active trigger maps to an exploitable managed position",
      "No Summer.fi-specific consumer join or DEX liquidity exists in the prefilter artifact",
      "No exact positive liquidation, borrow, redemption, unwind, or deprecated-command value route is proven",
      "Sunset/wind-down context is a monitoring caveat, not route-positive proof",
      "No fork/static value-delta proof and no signed action justified",
    ],
    requiredForRoutePositive: [
      "permissionless trigger takeover/removal or command execution is proven for a position the caller does not own",
      "deprecated AutomationBot/command/service-registry address has nonzero exploitable balance, allowance, or proxy authority",
      "managed MakerDAO/Aave/Spark/Morpho position is currently liquidatable or unwindable with exact route-size positive economics",
      "oracle/action data mismatch creates attacker-positive value that underlying protocols accept",
      "local fork/static value-delta proof before any live or signed action",
    ],
    nextReadOnlyStep: "Run the full-test scanner before any fork; decode trigger/position/permission/economics only through sanitized read-only artifacts and keep signed actions closed.",
  },
  {
    key: "summerFiProFullTest",
    id: "summer-fi-pro-full-test-sweep",
    protocol: "Summer.fi Pro",
    chain: "Ethereum/Arbitrum/Optimism/Base",
    surface: "Full Summer.fi Pro automation/CDP manager, trigger, command, service-registry, Maker/Aave/Spark/Morpho position, oracle, liquidation, DEX/unwind, and exact-economics route-positive test",
    baseScore: 42,
    routePositiveFields: ["routePositive", "executableNow"],
    watchFields: ["consumerJoinRows", "dexExitContextRows", "exactEconomicsContextRows", "triggerStateRows", "underlyingPositionRows", "oracleLiquidationRows", "ownershipProxyPermissionRows", "deprecatedCommandBalanceAllowanceRows", "forkPrereqRows", "candidatesWithEstimatedActiveTriggers"],
    researchFields: ["sourceFactRows", "chainSeedRows", "contractSeedRows", "priorPrefilterRows", "priorPrefilterContractRows", "priorPrefilterCodePresentRows", "localArtifactMatchRows", "exactLocalArtifactMatchRows", "candidateMatrixRows", "candidateMatrixProofGapRows", "inconsistencyRows"],
    quoteFields: ["exactEconomicsRows", "candidatesWithExactExitEconomics", "candidatesWithCurrentLiquidationCondition"],
    liquidityFields: [],
    closedStatus: "summer-fi-pro-full-test-no-route-positive",
    watchStatus: "summer-fi-pro-watch-needs-decoded-trigger-position-permission-or-liquidation-economics",
    sourceArtifacts: ["reports/raw/fast/summer-fi-pro-full-test.json", "reports/summer-fi-pro-full-test-triage.md", "reports/raw/fast/prefilter-summer-fi-pro-route-prefilter.json"],
    blockers: [
      "No decoded active trigger maps to a current owned position, position id, market id, or attacker-controllable recipient",
      "Code-present automation/data-provider rows are context only and do not prove permissionless value movement",
      "No permissionless trigger takeover/removal, service-registry/command misbinding, or deprecated command balance/allowance/proxy authority is proven",
      "No current MakerDAO/Aave/Spark/Morpho liquidation condition or exact Summer-linked position economics is proven",
      "Prior trigger-chain attribution and McdMonitorV2 code-status inconsistencies are preserved fail-closed until recomputed",
      "No fork/static value-delta proof and no signed action justified",
    ],
    requiredForRoutePositive: [
      "specific AutomationV1/V2 trigger/record decodes to owner/proxy, protocol, position id or market id, assets, thresholds, and recipient",
      "caller can permissionlessly mutate or execute a value-moving path for an unowned position, or a deprecated command/bot has exploitable public authority",
      "underlying MakerDAO/Aave/Spark/Morpho position is currently liquidatable/unwindable with exact route-size liquidity and positive netLiquidUsd",
      "service registry, adapter, command, validator, ownership, pause, and proxy permission blockers are resolved for the exact route",
      "local fork/value-delta harness demonstrates positive attacker-controlled balance movement before any live preflight",
      "independent defensive review and explicit route-specific authorization before any signed transaction consideration",
    ],
    nextReadOnlyStep: "Keep Summer.fi Pro dormant until a decoded trigger/position or deprecated command authority maps to permissionless value movement plus exact positive liquidation/unwind economics; then run the local-only fork harness for value-delta proof.",
  },
  {
    key: "summerFiProForkRouteTest",
    id: "summer-fi-pro-fork-route-test-sweep",
    protocol: "Summer.fi Pro local fork harness",
    chain: "localhost Anvil only when route-positive; skipped now",
    surface: "Local-only Summer.fi Pro value-delta harness gated by decoded trigger/position, permissionless value movement, exact positive economics, and route-positive scanner candidate",
    baseScore: 30,
    routePositiveFields: ["routePositive", "valueDeltaPositiveRows", "executableNow"],
    watchFields: ["routePositiveCandidateRows", "estimatedActiveTriggerRows", "codePresentContextRows"],
    researchFields: ["candidateRows", "scannerCandidateMatrixRows"],
    quoteFields: ["valueDeltaPositiveRows", "txAttempts"],
    closedStatus: "summer-fi-pro-fork-no-route-positive-candidate",
    watchStatus: "summer-fi-pro-fork-watch-route-positive-required",
    sourceArtifacts: ["reports/raw/fast/summer-fi-pro-fork-route-test.json", "reports/summer-fi-pro-fork-route-test.md", "reports/raw/fast/summer-fi-pro-full-test.json"],
    blockers: [
      "Harness emitted no-route-positive-candidate and attempted zero transactions",
      "No decoded trigger/position, permissionless value-moving selector, exact positive netLiquidUsd route, or fork value-delta proof exists",
      "Estimated active triggers and code-present rows are context only",
      "No signed action justified",
    ],
    requiredForRoutePositive: [
      "scanner emits routePositive > 0 for a decoded Summer.fi Pro candidate with exact position/permission/economics",
      "localhost-only Anvil simulation shows positive attacker-controlled balance delta",
      "no owner/admin/user impersonation, storage edits, private-key files, or broadcast",
    ],
    nextReadOnlyStep: "Do not run fork transactions until the Summer.fi Pro full-test scanner emits a decoded route-positive candidate with exact positive economics.",
  },
  {
    key: "b2BuzzPrefilter",
    id: "b2-buzz-route-prefilter-sweep",
    protocol: "B2 Buzz / BSquared",
    chain: "Ethereum/Polygon/BSC; Bitcoin custody caveat",
    surface: "B2 Buzz/BSquared BTC custody, EVM multisig owner/token, local consumer, DEX liquidity, and route prefilter",
    baseScore: 38,
    routePositiveFields: ["routePositive", "executableNow"],
    watchFields: ["consumerJoinRows", "dexLiquidityRows", "exactEconomicsRows", "rpcBlockedRows"],
    researchFields: ["custodyRows", "contractOwnerRows", "tokenRows", "localArtifactMatchRows", "totalCustodyValueHints"],
    quoteFields: ["exactEconomicsRows"],
    liquidityFields: ["maxDexLiquidityUsd"],
    closedStatus: "b2-buzz-prefilter-no-route-positive-bitcoin-custody-caveat",
    watchStatus: "b2-buzz-watch-needs-proof-custody-consumer-or-dex-route",
    sourceArtifacts: ["reports/raw/fast/prefilter-b2-buzz-route-prefilter.json", "reports/prefilter-b2-buzz-route-prefilter.md"],
    blockers: [
      "B2 Buzz TVL is dominated by off-chain Bitcoin custody, which is a non-EVM coverage caveat rather than an EVM route-positive proof",
      "EVM custody rows are Safe/multisig wallets with near-zero route balances and no permissionless sweep path",
      "No B2 Buzz bridge/proof verifier, mint/burn, wrapped-token issuance, or permissionless unlock path is proven",
      "No BSquared-specific custody/token row joins a material lending/oracle/liquidation consumer or DEX exit",
      "No exact positive borrow, liquidation, redemption, backing-mismatch, or unwind route exists",
      "No fork/static value-delta proof",
    ],
    requiredForRoutePositive: [
      "permissionless B2 Buzz custody sweep, proof verifier bypass, mint/unlock path, or custody-backing mismatch is proven for a specific asset",
      "native token sentinel remains excluded; only valid 20-byte EVM addresses enter the candidate matrix",
      "affected wrapped/claimed asset joins a material lending, oracle, redemption, liquidation, or DEX consumer",
      "exact route-size economics are positive after gas, fees, slippage, custody/bridge/finality constraints, and LTV/LLTV haircuts",
      "local fork/static value-delta proof before any live or signed action",
    ],
    nextReadOnlyStep: "Run/refresh the B2 Buzz full-test scanner and keep route gates closed unless a BSquared bridge/proof/wrapped-token contract or custody-backing mismatch maps to a material consumer/DEX/redeem route with exact positive economics.",
  },
  {
    key: "b2BuzzFullTest",
    id: "b2-buzz-full-test-sweep",
    protocol: "B2 Buzz / BSquared",
    chain: "Ethereum/Polygon/BSC; Bitcoin custody caveat",
    surface: "Full B2 Buzz BTC custody, EVM multisig owner/token, proof/mint/unlock, wrapped asset, backing mismatch, consumer, DEX/exit, address-schema, and exact-economics route-positive test",
    baseScore: 42,
    routePositiveFields: ["routePositive", "executableNow"],
    watchFields: ["consumerJoinRows", "dexExitContextRows", "exactEconomicsContextRows", "bitcoinCustodyRows", "bridgeProofRows", "mintBurnUnlockRows", "backingMismatchRows", "forkPrereqRows", "nativeSentinelExcludedRows", "candidatesWithConsumerContext", "candidatesWithDexExitContext"],
    researchFields: ["sourceFactRows", "chainSeedRows", "custodyRows", "surfaceRows", "bugClassRows", "priorPrefilterRows", "priorPrefilterCustodyRows", "localArtifactMatchRows", "exactLocalArtifactMatchRows", "filesWithLocalMatches", "candidateMatrixRows", "validAddressCandidateRows", "candidateMatrixProofGapRows"],
    quoteFields: ["exactEconomicsRows", "candidatesWithExactEconomics"],
    liquidityFields: [],
    closedStatus: "b2-buzz-full-test-no-route-positive",
    watchStatus: null,
    sourceArtifacts: ["reports/raw/fast/b2-buzz-full-test.json", "reports/b2-buzz-full-test-triage.md", "reports/raw/fast/prefilter-b2-buzz-route-prefilter.json"],
    blockers: [
      "Off-chain Bitcoin custody was not queried and remains a non-EVM coverage caveat, not EVM route-positive proof",
      "No B2 Buzz EVM bridge contract, proof verifier, mint/burn/unlock path, wrapped-token issuance contract, or permissionless claim path is proven",
      "EVM-side custody rows are Safe/multisig context only with no permissionless sweep path; multisig compromise/signature collection is out of scope",
      "Native token sentinel is excluded from candidate-address schema and not treated as a token-contract candidate",
      "No BSquared-specific wrapped/claimed asset joins a local material lending/oracle/liquidation consumer or DEX/redeem exit",
      "No exact positive borrow, liquidation, redemption, backing mismatch, unwind economics, or fork value-delta proof exists",
    ],
    requiredForRoutePositive: [
      "code-present BSquared EVM bridge/proof/wrapped-token contract is mapped to permissionless proof, mint, burn, unlock, claim, sweep, or custody-backing path",
      "or a custody backing mismatch is proven between user claims/wrapped supply and verifiable custody balances, including Bitcoin if the route depends on Bitcoin",
      "BSquared-issued wrapped/claimed asset is accepted by a material consumer or has route-size DEX/redeem/bridge/unwind liquidity",
      "exact economics show netLiquidUsd > 0 after gas, fees, slippage, custody/bridge/finality constraints, and LTV/LLTV haircuts",
      "local fork/static value-delta proof with ephemeral local accounts only and no broadcast",
      "independent defensive review and explicit route-specific authorization before any signed transaction consideration",
    ],
    nextReadOnlyStep: "Keep B2 Buzz dormant unless a BSquared bridge/proof/wrapped-token contract or custody-backing mismatch is proven locally and joins a material consumer/DEX/redeem route with exact positive economics; only then run the local-only fork harness.",
  },
  {
    key: "b2BuzzForkRouteTest",
    id: "b2-buzz-fork-route-test-sweep",
    protocol: "B2 Buzz / BSquared local fork harness",
    chain: "localhost Anvil only when route-positive; skipped now",
    surface: "Local-only B2 Buzz route/value-delta harness gated by route-positive scanner candidate, valid address schema, permissionless value movement, exact positive economics, and fork/static proof prerequisites",
    baseScore: 30,
    routePositiveFields: ["routePositive", "valueDeltaPositiveRows", "executableNow"],
    watchFields: ["routePositiveCandidateRows", "candidateRows", "nativeSentinelExcludedRows"],
    researchFields: ["scannerCandidateMatrixRows", "scannerValidAddressCandidateRows", "candidateRows"],
    quoteFields: ["valueDeltaPositiveRows", "txAttempts"],
    closedStatus: "b2-buzz-fork-no-route-positive-candidate",
    watchStatus: "b2-buzz-fork-watch-route-positive-required",
    sourceArtifacts: ["reports/raw/fast/b2-buzz-fork-route-test.json", "reports/b2-buzz-fork-route-test.md", "reports/raw/fast/b2-buzz-full-test.json"],
    blockers: [
      "Harness emitted no-route-positive-candidate and attempted zero transactions",
      "Scanner routePositive=0 and no code-present value-moving B2 Buzz bridge/proof/custody/consumer/economics route exists",
      "Native token sentinel rows remain excluded from token-contract candidates",
      "No local fork value-delta proof and no signed action justified",
    ],
    requiredForRoutePositive: [
      "scanner emits routePositive > 0 for a code-present deployed BSquared candidate with valid address schema",
      "candidate exposes permissionless custody/proof/mint/unlock/claim/sweep or backing-mismatch value movement",
      "exact positive netLiquidUsd route exists with solvent consumer, DEX, redeem, or unwind exit",
      "localhost-only Anvil simulation shows positive attacker-controlled balance delta using ephemeral local accounts only",
      "no private-key files, endpoint inventory, privileged impersonation, storage edits, broadcast, or signed live action",
    ],
    nextReadOnlyStep: "Do not run fork transactions until the B2 Buzz full-test scanner emits a route-positive candidate with exact positive economics and a permissionless value-moving path.",
  },
  {
    key: "etherfusePrefilter",
    id: "etherfuse-route-prefilter-sweep",
    protocol: "Etherfuse",
    chain: "Polygon/Base; Solana/Stellar/Monad caveats",
    surface: "Etherfuse tokenized-bond token, ERC4626/NAV, local consumer, DEX liquidity, and route prefilter",
    baseScore: 38,
    routePositiveFields: ["routePositive", "executableNow"],
    watchFields: ["consumerJoinRows", "dexLiquidityRows", "exactEconomicsRows", "rpcBlockedRows"],
    researchFields: ["tokenRows", "codePresentRows", "erc4626Rows", "localArtifactMatchRows"],
    quoteFields: ["exactEconomicsRows"],
    liquidityFields: ["maxDexLiquidityUsd"],
    closedStatus: "etherfuse-prefilter-no-route-positive-non-evm-caveats",
    watchStatus: "etherfuse-watch-needs-consumer-dex-nav-or-redemption-route",
    sourceArtifacts: ["reports/raw/fast/prefilter-etherfuse-route-prefilter.json", "reports/prefilter-etherfuse-route-prefilter.md"],
    blockers: [
      "All 10 EVM token rows are code-present context, but no ERC4626 interface, local material consumer join, or DEX liquidity was found",
      "RWA tokenized-bond issuance/redemption and transferability are treated as permissioned or restricted absent public same-block proof",
      "No current NAV/oracle/accepted-value divergence is joined to a material lending or DEX route",
      "Solana, Stellar, and Monad remain coverage caveats and are not EVM route-negative closeouts",
      "No exact positive borrow, liquidation, redemption, or unwind economics exist",
      "No fork/static value-delta proof",
    ],
    requiredForRoutePositive: [
      "specific Etherfuse tokenized bond is accepted by a live material lending/oracle/liquidation consumer or has public route-size DEX/redeem exit liquidity",
      "current NAV/oracle/accepted-value or redeemable value exceeds acquisition/exit value after LTV/LLTV haircut and costs",
      "transfer, redemption, KYC/allowlist, blacklist, pause, role, and timing blockers are resolved for the exact route",
      "Solana/Stellar/Monad coverage is resolved if the route depends on those chains",
      "exact route economics and fork/static proof before any live or signed action",
    ],
    nextReadOnlyStep: "Run/refresh the Etherfuse full-test scanner and keep route gates closed unless a tokenized-bond row gains a public redemption/NAV/oracle/consumer/DEX route with exact positive economics.",
  },
  {
    key: "etherfuseFullTest",
    id: "etherfuse-full-test-sweep",
    protocol: "Etherfuse",
    chain: "Polygon/Base; Solana/Stellar/Monad caveats",
    surface: "Full Etherfuse tokenized-bond token, ERC4626/NAV/oracle, redemption, transfer restriction, role/admin, consumer, DEX/exit, address-schema, and exact-economics route-positive test",
    baseScore: 42,
    routePositiveFields: ["routePositive", "executableNow"],
    watchFields: ["consumerJoinRows", "dexExitContextRows", "exactEconomicsContextRows", "oracleNavContextRows", "redemptionContextRows", "transferRestrictionRows", "roleAdminRows", "forkPrereqRows", "nonEvmCaveatRows", "candidatesWithConsumerContext", "candidatesWithDexExitContext"],
    researchFields: ["sourceFactRows", "chainSeedRows", "tokenRows", "codePresentRows", "erc4626Rows", "surfaceRows", "bugClassRows", "priorPrefilterRows", "localArtifactMatchRows", "exactLocalArtifactMatchRows", "filesWithLocalMatches", "candidateMatrixRows", "validAddressCandidateRows", "candidateMatrixProofGapRows"],
    quoteFields: ["exactEconomicsRows", "candidatesWithExactEconomics"],
    liquidityFields: [],
    closedStatus: "etherfuse-full-test-no-route-positive",
    watchStatus: null,
    sourceArtifacts: ["reports/raw/fast/etherfuse-full-test.json", "reports/etherfuse-full-test-triage.md", "reports/raw/fast/prefilter-etherfuse-route-prefilter.json"],
    blockers: [
      "Solana, Stellar, and Monad coverage remains a caveat and is not closed route-negative by this EVM-first local/static scan",
      "No Etherfuse tokenized bond is proven to be accepted by a material lending/oracle/liquidation consumer in local artifacts",
      "No DEX liquidity or public same-block redeem/unwind path exists for route-size Etherfuse token acquisition or exit",
      "Prefilter ERC4626 probes found zero ERC4626 asset/totalAssets rows; no share-rate redemption edge is proven",
      "RWA issuance/redemption/transferability and owner/admin/minter/upgrade/pauser controls remain permissioned or role-gated absent bypass proof",
      "No exact positive borrow, liquidation, redemption, NAV, accepted-value, unwind economics, or fork value-delta proof exists",
    ],
    requiredForRoutePositive: [
      "code-present Etherfuse Polygon/Base token or non-EVM representation maps to a permissionless transfer, redeem, burn, claim, settlement, NAV/oracle, or role-bypass value path",
      "or an Etherfuse token is accepted by a material lending/oracle/liquidation consumer with current collateral factor, borrow cash, and attacker-favorable accepted value",
      "Solana/Stellar/Monad dependencies are resolved if the route depends on those chains",
      "public acquisition and exit liquidity exists through DEX/redeem/borrow/unwind venues at route size without KYC/allowlist/blacklist/pause blockers",
      "exact economics show netLiquidUsd > 0 after gas, fees, slippage, redemption/settlement timing, transfer restrictions, caps, and LTV/LLTV haircuts",
      "local fork/static value-delta proof with ephemeral local accounts only and no broadcast",
      "independent defensive review and explicit route-specific authorization before any signed transaction consideration",
    ],
    nextReadOnlyStep: "Keep Etherfuse dormant unless a tokenized-bond row gains a proven public redemption/NAV/oracle/transfer path or material consumer/DEX/redeem route with exact positive economics; only then run the local-only fork harness.",
  },
  {
    key: "etherfuseForkRouteTest",
    id: "etherfuse-fork-route-test-sweep",
    protocol: "Etherfuse local fork harness",
    chain: "localhost Anvil only when route-positive; skipped now",
    surface: "Local-only Etherfuse route/value-delta harness gated by route-positive scanner candidate, valid address schema, permissionless value movement, exact positive economics, and fork/static proof prerequisites",
    baseScore: 30,
    routePositiveFields: ["routePositive", "valueDeltaPositiveRows", "executableNow"],
    watchFields: ["routePositiveCandidateRows", "candidateRows", "nonAddressExcludedRows"],
    researchFields: ["scannerCandidateMatrixRows", "scannerValidAddressCandidateRows", "candidateRows"],
    quoteFields: ["valueDeltaPositiveRows", "txAttempts"],
    closedStatus: "etherfuse-fork-no-route-positive-candidate",
    watchStatus: "etherfuse-fork-watch-route-positive-required",
    sourceArtifacts: ["reports/raw/fast/etherfuse-fork-route-test.json", "reports/etherfuse-fork-route-test.md", "reports/raw/fast/etherfuse-full-test.json"],
    blockers: [
      "Harness emitted no-route-positive-candidate and attempted zero transactions",
      "Scanner routePositive=0 and no permissionless Etherfuse tokenized-bond redemption/transfer/NAV/consumer/economics route exists",
      "Solana/Stellar/Monad dependencies remain caveats if a future route depends on them",
      "No local fork value-delta proof and no signed action justified",
    ],
    requiredForRoutePositive: [
      "scanner emits routePositive > 0 for a code-present Etherfuse candidate with valid address schema",
      "candidate exposes permissionless transfer/redeem/NAV/oracle/role-bypass value movement",
      "exact positive netLiquidUsd route exists with solvent consumer, DEX, redeem, or unwind exit",
      "localhost-only Anvil simulation shows positive attacker-controlled balance delta using ephemeral local accounts only",
      "no private-key files, endpoint inventory, privileged impersonation, storage edits, broadcast, or signed live action",
    ],
    nextReadOnlyStep: "Do not run fork transactions until the Etherfuse full-test scanner emits a route-positive candidate with exact positive economics and a permissionless value-moving path.",
  },
  {
    key: "coinbaseWrappedStakedEthPrefilter",
    id: "coinbase-wrapped-staked-eth-route-prefilter-sweep",
    protocol: "Coinbase Wrapped Staked ETH",
    chain: "Ethereum; Base/PulseChain liquidity context",
    surface: "cbETH liquid-staking token accounting, local consumer joins, DEX liquidity, and route prefilter",
    baseScore: 37,
    routePositiveFields: ["routePositive", "executableNow"],
    watchFields: ["consumerJoinRows", "dexLiquidityRows", "rpcBlockedRows"],
    researchFields: ["tokenRows", "localArtifactMatchRows"],
    quoteFields: ["exactEconomicsRows"],
    liquidityFields: ["topDexLiquidityUsd", "maxDexLiquidityUsd"],
    closedStatus: "cbeth-prefilter-no-route-positive-no-rpc",
    watchStatus: "cbeth-watch-needs-producer-consumer-exact-economics",
    sourceArtifacts: ["reports/raw/fast/prefilter-coinbase-wrapped-staked-eth-route-prefilter.json"],
    blockers: [
      "This pass intentionally used no RPC or endpoint inventory, so cbETH producer and consumer contract state were not directly probed",
      "Local token, lending, DEX, and oracle references are context-only and do not prove a permissionless route",
      "No cbETH producer accounting, oracle, exchange-rate, or accepted-value anomaly is proven",
      "No exact acquisition, borrow, liquidation, redeem, or unwind economics are positive after costs",
      "DexScreener liquidity is public context only and not executable route proof",
      "No fork/static value-delta proof",
    ],
    requiredForRoutePositive: [
      "public read-only contract probes confirm cbETH accounting/oracle/accepted-value state for the exact producer and consumers",
      "specific material lending, oracle, redemption, liquidation, or DEX consumer accepts cbETH with attacker-favorable mismatch or live liquidatable state",
      "exact acquisition -> consumer action -> exit/redeem/unwind route is positive after LTV/LLTV, slippage, fees, caps, queues, and gas",
      "fork/static proof before any live or signed action",
    ],
    nextReadOnlyStep: "Keep cbETH dormant unless public read-only probes of cbETH producer and top cited consumers prove a current accepted-value/accounting mismatch with exact-positive route economics.",
  },
  {
    key: "coinbaseWrappedStakedEthFullTest",
    id: "coinbase-wrapped-staked-eth-full-test-sweep",
    protocol: "Coinbase Wrapped Staked ETH",
    chain: "Ethereum; Base bridge/liquidity context",
    surface: "Full cbETH token/exchange-rate producer accounting, oracle/consumer acceptance, proxy/admin/role, mint/redeem, pause/blacklist, bridge/custody, DEX/exit, and exact-economics route-positive test",
    baseScore: 42,
    routePositiveFields: ["routePositive", "executableNow"],
    watchFields: ["contextConsumerJoinRows", "consumerJoinRows", "dexExitContextRows", "dexLiquidityRows", "exitLiquidityRows", "candidatesWithOracleConsumerContext", "candidatesWithDexExitContext", "candidatesWithProducerContext", "producerAccountingRows", "exchangeRateRows", "oraclePriceFeedContextRows", "bridgeBaseCustodyRows"],
    researchFields: ["sourceFactRows", "chainSeedRows", "tokenRows", "surfaceRows", "priorPrefilterRows", "priorPrefilterLocalArtifactMatchRows", "priorPrefilterConsumerJoinRows", "priorPrefilterDexLiquidityRows", "localArtifactMatchRows", "exactLocalArtifactMatchRows", "filesWithLocalMatches", "candidateMatrixRows", "candidateMatrixProofGapRows"],
    quoteFields: ["exactEconomicsRows"],
    liquidityFields: [],
    closedStatus: "cbeth-full-test-no-route-positive",
    watchStatus: "cbeth-watch-needs-producer-consumer-exact-economics",
    sourceArtifacts: ["reports/raw/fast/coinbase-wrapped-staked-eth-full-test.json", "reports/coinbase-wrapped-staked-eth-full-test-triage.md", "reports/raw/fast/prefilter-coinbase-wrapped-staked-eth-route-prefilter.json"],
    blockers: [
      "No exact-positive cbETH vault share -> exchange-rate/accounting -> consumer or exit venue -> borrow/redeem/unwind route is proven in local artifacts",
      "Static/local candidate matrix covers Ethereum cbETH and Base bridged cbETH, but every candidate is blocked by missing producer accounting, current exchange-rate, exact consumer/exit, role, bridge/custody, and economics proof",
      "Existing cbETH prefilter is dormant/route-negative and is prior context only; no endpoint inventory, live RPC, fork, or signed action was used",
      "exchangeRate(), updateExchangeRate(uint256), oracle/updater delta limits, and accepted consumer values require current state before any value-mismatch claim",
      "Aave, Compound V3, Euler, Morpho, Moonwell, bridge, and DEX rows are context-only without current caps, liquidity, oracle freshness, borrower state, or exact route-size quotes",
      "MintForwarder/minter, owner, pauser, blacklister, masterMinter, oracle, and proxy/admin controls remain role/admin blockers",
      "Base bridged cbETH rows do not prove live L1 escrow/custody, L2 supply reconciliation, bridge finality, or route-size exit liquidity",
      "No fork/static value-delta proof and no signed action justified",
    ],
    requiredForRoutePositive: [
      "specific Ethereum or Base cbETH token, proxy/implementation, exchangeRate(), totalSupply, oracle/updater, rate-limit state, and role assignments are resolved from sanitized read-only state",
      "same cbETH token/bridge representation is accepted by a material lending/oracle/settlement consumer with current collateral factor, caps, cash/borrow liquidity, and oracle freshness",
      "mint/wrap/burn/redeem/withdraw, bridge, or DEX exit path is permissionless, unpaused, not blacklisted, and available at route size",
      "accepted value exceeds exact acquisition, borrow/liquidation, redeem/bridge/DEX unwind value after LTV/LLTV, fees, slippage, caps, queues, bridge finality, and gas",
      "Base bridge/custody rows reconcile L1 escrow, L2 supply, bridge semantics, and remote liquidity for the exact route",
      "local static/fork value-delta proof shows positive attacker-controlled balance movement before any live preflight",
      "independent defensive review and explicit route-specific authorization before any signed transaction consideration",
    ],
    nextReadOnlyStep: "Keep cbETH dormant unless a concrete Ethereum or Base cbETH row maps to a material consumer or permissionless redeem/DEX/bridge exit; then refresh sanitized read-only exchange-rate, consumer oracle/caps/liquidity, role/proxy/blacklist/pause, bridge custody/supply, and exact economics before any fork/static proof.",
  },
  {
    key: "merlinsSealFullTest",
    id: "merlins-seal-full-test-sweep",
    protocol: "Merlins Seal",
    chain: "Ethereum/Arbitrum; Bitcoin/Zkfair caveats",
    surface: "Full read-only bridge proof/custody/backing, wrapped-token consumer, DEX, oracle, admin, and route-positive gate test",
    baseScore: 42,
    routePositiveFields: ["routePositive", "executableNow"],
    watchFields: ["exactConsumerJoinRows", "dexLiquidityRows", "selectorProbeHits", "rpcBlockedRows"],
    researchFields: ["addressRows", "codePresentRows", "exactLocalArtifactMatchRows", "filesWithTargetExactOrContextMatch", "fullTestReadOnlyComplete"],
    quoteFields: ["exactEconomicsRows"],
    liquidityFields: ["topDexLiquidityUsd", "maxDexLiquidityUsd"],
    closedStatus: "merlins-seal-full-test-no-route-positive",
    watchStatus: "merlins-seal-watch-needs-proof-binding-custody-or-exact-consumer-economics",
    sourceArtifacts: ["reports/raw/fast/merlins-seal-full-test.json", "reports/merlins-seal-full-test-triage.md"],
    blockers: [
      "Full read-only test completed, but no permissionless Merlins proof/domain/nonce/token/recipient binding bypass was proven",
      "Bitcoin custody and Zkfair semantics remain coverage caveats and cannot be closed route-negative from EVM-only evidence",
      "Adapter/source address rows include code-present EVM rows, but no bridge/custody balance-delta or unlock/mint path is proven",
      "STONE and MBTC/M-BTC consumer/DEX/oracle rows are context-only without a Merlins-specific backing or accepted-value anomaly",
      "No exact acquisition, cross-domain action, borrow, liquidation, redeem, or DEX unwind economics are positive after costs",
      "Arbitrum public probing was blocked/rate-limited in this bounded pass",
      "No fork/static value-delta proof",
    ],
    requiredForRoutePositive: [
      "source-confirmed Merlins bridge/custody/proof path with explicit permissionless proof/domain/nonce/token/recipient binding failure or backing mismatch",
      "affected MBTC/M-BTC/STONE or other exact wrapped asset accepted by a material lending, oracle, liquidation, redemption, or DEX consumer",
      "exact acquisition -> proof/unlock/mint/borrow/liquidation/redeem -> exit route is positive after slippage, fees, caps, finality, queues, and gas",
      "Bitcoin/Zkfair dependencies resolved if the route depends on them",
      "fork/static value-delta proof before any live or signed action",
    ],
    nextReadOnlyStep: "Keep Merlins Seal dormant unless a source-confirmed bridge/custody proof row maps to a live consumer and exact-positive same-block economics; then run focused fork/static value-delta proof only for that explicit route.",
  },
  {
    key: "upshiftFullTest",
    id: "upshift-full-test-sweep",
    protocol: "Upshift",
    chain: "Ethereum/Base/Ink/Avalanche/BNB; Stellar/Sui and unsupported-chain caveats",
    surface: "Full read-only vault-yield allocator, ERC4626/share-rate, queued/instant redemption, consumer, DEX, and route-positive gate test",
    baseScore: 43,
    routePositiveFields: ["routePositive", "executableNow"],
    watchFields: ["contextConsumerJoinRows", "consumerJoinRows", "queueRows", "caveatChains"],
    researchFields: ["addressRows", "sourceFactRows", "exactLocalArtifactMatchRows", "fullTestReadOnlyComplete"],
    quoteFields: ["exactEconomicsRows"],
    liquidityFields: ["maxDexLiquidityUsd"],
    closedStatus: "upshift-full-test-no-route-positive",
    watchStatus: "upshift-watch-needs-share-rate-consumer-or-exact-redeem-economics",
    sourceArtifacts: ["reports/raw/fast/upshift-full-test.json", "reports/upshift-full-test-triage.md"],
    blockers: [
      "No Upshift vault/share token is proven to be accepted by a material lending/oracle consumer with overvalued collateral semantics",
      "Prior funnel note found ERC4626-style Upshift vaults sane and no Morpho share-token consumer; this full test did not contradict that",
      "Local source shows queued redemption and instantRedeem semantics, but no exact same-block positive fee/capacity route is proven",
      "Infinifi UpshiftFarm integration operations are role-gated and receiver/claim accounting is guarded; no arbitrary public drain path is proven",
      "Public DEX/liquidity rows, if any, are exit context only and do not prove profitable acquire/redeem/unwind economics",
      "Several non-EVM or unsupported chains remain coverage caveats in this no-endpoint-inventory pass",
      "No fork/static value-delta proof",
    ],
    requiredForRoutePositive: [
      "source-confirmed Upshift share-rate/accounting, queued/instant redemption, or strategy valuation anomaly",
      "exact Upshift share or receipt accepted by a material lending/oracle/settlement consumer, or a same-block DEX/redeem exit venue",
      "exact acquisition -> deposit/redeem/borrow/liquidate/unwind economics positive after fees, instant-redeem discount, slippage, caps, queues, finality, and gas",
      "endpoint-backed live-state proof for in-scope EVM chains and explicit caveats for non-EVM/unsupported chains",
      "fork/static value-delta proof before any live or signed action",
    ],
    nextReadOnlyStep: "Keep Upshift dormant unless live endpoint-backed ERC4626/share-rate/lagDuration state plus a material consumer or exit venue produces exact-positive economics and fork/static value-delta proof.",
  },
  {
    key: "staderFullTest",
    id: "stader-full-test-sweep",
    protocol: "Stader",
    chain: "Ethereum/BNB/Fantom; Hedera/Terra2/Near caveats",
    surface: "Full read-only liquid-staking token, share-rate/accounting, unstake/claim queue, consumer, DEX, and route-positive gate test",
    baseScore: 43,
    routePositiveFields: ["routePositive", "executableNow"],
    watchFields: ["exactConsumerJoinRows", "consumerJoinRows", "liveProbeRowsWithCode", "caveatChains"],
    researchFields: ["addressRows", "exactLocalArtifactMatchRows", "filesWithExactMatch", "chainResolvedFromInventory"],
    quoteFields: ["exactEconomicsRows"],
    liquidityFields: ["maxDexLiquidityUsd", "topDexLiquidityUsd"],
    closedStatus: "stader-full-test-no-route-positive",
    watchStatus: "stader-watch-needs-rate-anomaly-consumer-or-exact-exit-economics",
    sourceArtifacts: ["reports/raw/fast/stader-full-test.json", "reports/stader-full-test-triage.md"],
    blockers: [
      "No Stader ETHx/BNBx/SD/ynETHx/ynBNBx producer accounting, rate, queue, or oracle anomaly is proven",
      "Exact local consumer joins are watch context and do not prove attacker-favorable accepted value, material borrow liquidity, or liquidatable state",
      "Endpoint live probes found code/state context, but no permissionless redeem, withdraw, claim, unstake, or value-moving path is proven",
      "No exact acquisition, borrow, redeem, liquidation, claim, or DEX unwind economics are positive after haircuts, fees, queues, slippage, and gas",
      "Hedera/Terra2/Near remain coverage caveats and are not closed route-negative from this EVM pass",
      "No fork/static value-delta proof",
    ],
    requiredForRoutePositive: [
      "concrete Stader ETHx/BNBx/SD/ynETHx/ynBNBx rate/accounting, queue, or oracle anomaly exists in current live state",
      "a material trusted consumer accepts the affected Stader asset at attacker-favorable value without a protective cap, pause, or stale/divergence rejection",
      "permissionless borrow/redeem/claim/withdraw/liquidation/exit liquidity is available and exact-positive after fees, queues, slippage, haircuts, and gas",
      "non-EVM or cross-chain dependencies are resolved if the route depends on them",
      "fork/static value-delta proof before any live or signed action",
    ],
    nextReadOnlyStep: "Keep Stader dormant unless a live Stader rate/accounting/queue anomaly maps to a material consumer or exit venue with exact-positive economics and fork/static value-delta proof.",
  },
  {
    key: "mapleFullTest",
    id: "maple-full-test-sweep",
    protocol: "Maple",
    chain: "Ethereum; Solana caveat",
    surface: "Full lending/oracle/liquidation route-positive test over Maple pools, loan managers, withdrawal queues, strategies, local consumers, and existing syrup economics",
    baseScore: 43,
    routePositiveFields: ["routePositive", "executableNow"],
    watchFields: ["exactConsumerJoinRows", "consumerJoinRows", "selectorProbeSuccessRows"],
    researchFields: ["addressRows", "codePresentRows", "poolProbeRows", "registryPoolRows", "localArtifactMatchRows"],
    quoteFields: ["exactEconomicsRows"],
    liquidityFields: [],
    closedStatus: "maple-full-test-no-route-positive",
    watchStatus: "maple-watch-needs-accounting-oracle-consumer-or-exact-liquidation-economics",
    sourceArtifacts: ["reports/raw/fast/maple-full-test.json", "reports/maple-full-test-triage.md"],
    blockers: [
      "No concrete Maple pool, loan, oracle, collateral, withdrawal, or accounting anomaly is proven in current live/read-only state",
      "Local Maple artifact and consumer joins are context-only and do not prove attacker-favorable accepted value, borrow liquidity, or liquidatable state",
      "Existing base syrupUSDC route context remains route-negative and does not clear exact-positive economics gates",
      "PoolManager, PoolPermissionManager, withdrawal queue, loan manager, governor/security-admin, and pool delegate controls remain permission/queue/admin gates unless a permissionless value path is proven",
      "Selector eth_call results are availability/revert classification only and do not prove state-changing value deltas",
      "Solana Maple context remains a non-EVM caveat",
      "No fork/static value-delta proof and no signed action justified",
    ],
    requiredForRoutePositive: [
      "specific Maple pool/loan/collateral/oracle/accounting state is attacker-favorable in current live state",
      "permissionless path can move value, borrow, redeem, withdraw, claim, liquidate, or unwind without role/admin/queue blockers",
      "exact acquisition, borrow/repay, redeem/withdraw/claim/liquidation, and exit economics are positive after fees, queues, caps, slippage, and gas",
      "local fork/static value-delta proof confirms attacker-controlled positive balance movement",
      "independent review before any live preflight and explicit route-specific authorization before any signed action",
    ],
    nextReadOnlyStep: "Keep Maple dormant unless a current pool/loan/oracle/accounting anomaly maps to a material permissionless route with exact-positive economics; then run focused local fork/static value-delta proof before any live preflight.",
  },
  {
    key: "gauntletFullTest",
    id: "gauntlet-full-test-sweep",
    protocol: "Gauntlet",
    chain: "Ethereum/Base/Arbitrum/Optimism/Polygon/BNB/Unichain; Solana/dYdX/indexer caveats",
    surface: "Full Gauntlet/Aera risk-curator vault, provisioner, oracle/calculator, local consumer, and exit-liquidity route-positive test",
    baseScore: 43,
    routePositiveFields: ["routePositive", "executableNow"],
    watchFields: ["exactConsumerJoinRows", "consumerJoinRows", "selectorProbeSuccessRows"],
    researchFields: ["addressRows", "seedAddressRows", "codePresentRows", "localArtifactMatchRows", "brandedLocalRows"],
    quoteFields: ["exactEconomicsRows"],
    liquidityFields: ["dexLiquidityRows"],
    closedStatus: "gauntlet-full-test-no-route-positive",
    watchStatus: "gauntlet-watch-needs-aera-vault-consumer-or-exact-exit-economics",
    sourceArtifacts: ["reports/raw/fast/gauntlet-full-test.json", "reports/gauntlet-full-test-triage.md"],
    blockers: [
      "No exact Gauntlet/Aera seed vault or provisioner is joined to a material consumer with attacker-favorable accepted-value semantics",
      "Local Gauntlet-branded Morpho/ERC4626/RWA rows are context-only and do not prove a permissionless value-movement path from producer asset to consumer to exit liquidity",
      "Read-only selector successes are availability/revert classification only and do not prove state-changing value deltas",
      "No exact-positive acquisition, deposit/request/claim/redeem, borrow/liquidation, or unwind economics were found",
      "Provisioner, owner/guardian/pauser, curator, registry, queue, and chain/indexer constraints remain unresolved gates",
      "Solana/dYdX/indexer and newer/caveated chains remain outside this EVM-first closeout",
      "No fork/static value-delta proof and no signed action justified",
    ],
    requiredForRoutePositive: [
      "exact seed or newly resolved Gauntlet/Aera vault/provisioner/calculator address maps to a material lending/oracle/DEX/RWA consumer with accepted value",
      "permissionless path can move value through deposit/request/claim/redeem/withdraw/borrow/liquidate/unwind without role, allowlist, queue, or pause blockers",
      "concrete economics are positive after fees, caps, delays, slippage, oracle freshness, liquidity depth, and gas",
      "local fork/static value-delta proof shows attacker-controlled positive balance movement",
      "independent defensive review and explicit route-specific authorization before any signed transaction consideration",
    ],
    nextReadOnlyStep: "Keep Gauntlet dormant unless an exact seed or newly resolved Aera vault joins to a material consumer with exact-positive economics; then run focused local fork/static value-delta proof before any live preflight.",
  },
  {
    key: "pumpbtcFullTest",
    id: "pumpbtc-full-test-sweep",
    protocol: "PumpBTC",
    chain: "Ethereum/BNB/Base/Arbitrum/Mantle; Bitcoin/Sei/BOB caveats",
    surface: "Full PumpBTC bridge/custody/backing, minter/OFT, wrapped BTC consumer, oracle, DEX-liquidity, and route-positive gate test",
    baseScore: 43,
    routePositiveFields: ["routePositive", "executableNow"],
    watchFields: ["exactConsumerJoinRows", "consumerJoinRows", "dexLiquidityRows", "liveProbeRows", "bridgeCustodyContextRows"],
    researchFields: ["sourceFactRows", "localArtifactMatchRows", "exactLocalArtifactMatchRows", "localObjectRows", "codePresentRows"],
    quoteFields: ["exactEconomicsRows"],
    liquidityFields: ["maxDexLiquidityUsd", "topDexLiquidityUsd", "dexLiquidityRows"],
    closedStatus: "pumpbtc-full-test-no-route-positive",
    watchStatus: "pumpbtc-watch-needs-bridge-custody-proof-or-exact-consumer-economics",
    sourceArtifacts: ["reports/raw/fast/pumpbtc-full-test.json", "reports/pumpbtc-full-test-triage.md"],
    blockers: [
      "No exact-positive PumpBTC producer-to-consumer-to-exit route is proven; high-signal Compound, Curve, Euler, and Morpho rows are watch/context only",
      "Compound WBTC market references pumpBTC collateral/oracle configuration, but no material accepted-value divergence, liquidatable route, or positive borrow/unwind economics are proven",
      "Curve pumpBTC/WBTC liquidity is exit context only and does not prove attacker-favorable acquisition, manipulation, or profitable unwind economics",
      "Euler epumpBTC rows have zero cash/assets/borrows/supply in the local artifact and do not prove a material consumer route",
      "Morpho pumpBTC/WBTC row remains near-empty/watch-only with borrowUsd=0, exactEconomicsPositive=false, and forkProof=false",
      "Bridge/custody/backing proof, owner-controlled minter mapping, OFT roles, domain/nonce/token/recipient binding, and custody attestations remain unresolved gates",
      "Read-only ERC20/code probes are metadata availability checks only and do not justify fork escalation, signed actions, or live transactions",
      "No fork/static value-delta proof and no signed action justified",
    ],
    requiredForRoutePositive: [
      "authoritative PumpBTC bridge/custody contract map with verified source/ABI, minter/owner/role graph, and no role/allowlist/pause blockers",
      "permissionless proof/backing invariant failure covering domain, nonce, token, recipient, replay, and custody-balance checks",
      "material PumpBTC consumer join with accepted collateral value, caps, cash/borrow liquidity, oracle freshness/scaling, and no zero-supply/zero-borrow blocker",
      "exact acquisition, borrow/liquidation/redeem/bridge, and unwind economics positive after haircuts, fees, slippage, queues, caps, finality, and gas",
      "local static/fork value-delta proof showing attacker-controlled positive balance movement before any live preflight",
      "independent defensive review and explicit route-specific authorization before any signed transaction consideration",
    ],
    nextReadOnlyStep: "Keep PumpBTC dormant unless verified bridge/custody/minter/OFT semantics or refreshed Compound/Curve/Euler/Morpho state produce exact-positive consumer economics; then run focused local fork/static value-delta proof before any live preflight.",
  },
  {
    key: "capFullTest",
    id: "cap-full-test-sweep",
    protocol: "Cap",
    chain: "Ethereum; MegaETH/Tempo/Katana/Monad OFT caveats",
    surface: "Full Cap cUSD/stcUSD vault, lender/liquidation, oracle, fractional-reserve, OFT, consumer, and exact-economics route-positive test",
    baseScore: 43,
    routePositiveFields: ["routePositive", "executableNow"],
    watchFields: ["exactConsumerJoinRows", "consumerJoinRows", "dexLiquidityRows", "oracleRows", "agentLiquidationRows"],
    researchFields: ["sourceFactRows", "localSourceRows", "deploymentRows", "assetRows", "localArtifactMatchRows", "exactLocalArtifactMatchRows", "liveCodeProbeRows"],
    quoteFields: ["exactEconomicsRows", "vaultQuoteRows"],
    liquidityFields: ["dexLiquidityRows"],
    closedStatus: "cap-full-test-no-route-positive",
    watchStatus: "cap-watch-needs-current-liquidatable-agent-or-oracle-economics",
    sourceArtifacts: ["reports/raw/fast/cap-full-test.json", "reports/cap-full-test-triage.md"],
    blockers: [
      "Prior Cap triage found public cUSD mint, burn, and redeem cycles value-negative after the 10 bps mint fee, with redeem returning a pro-rata basket rather than a favorable single-asset exit",
      "USDC and wWTGXX backing assets are visible and unpaused in prior state, but no accepted-value/redeem-market comparison produced a positive public route",
      "All checked debt-bearing agents were healthy and maxLiquidatable(USDC)=0, so the public liquidation route is dormant",
      "Oracle adapter and staleness setters are access-gated; prior USDC feeds were fresh and wWTGXX fixed-price behavior is a governance/NAV caveat rather than a permissionless mutation path",
      "Fractional-reserve ERC4626 public maxDeposit/maxWithdraw checks returned 0 for a random user, blocking the direct donation/share-entry route in prior evidence",
      "OFT/cross-chain rows are context/caveat only and do not establish a permissionless bridge/custody accounting bypass on Ethereum",
      "Read-only code/selector probes only confirm metadata/state availability and do not prove attacker-controlled value movement",
      "No fork/static value-delta proof and no signed action justified",
    ],
    requiredForRoutePositive: [
      "fresh read-only state shows an exact public path through mint/burn/redeem, liquidation, fractional reserve, or OFT/custody logic with no role/allowlist/pause/grace-window blockers",
      "accepted oracle/accounting value is measurably above immediate market/redeem/unwind value after mint/redeem fees, liquidation bonus/caps, slippage, and gas",
      "for liquidation, a material agent has health below 1, an open or openable liquidation window, and positive maxLiquidatable for an asset with available exit liquidity",
      "for oracle/accounting, the adapter source is permissionlessly mutable or manipulable; admin-gated setters alone are insufficient",
      "for fractional reserve, a public entry/donation/share-price path affects cUSD accounting and is withdrawable by the attacker",
      "local static/fork value-delta proof shows positive attacker-controlled balance movement before any live preflight",
      "independent defensive review and explicit route-specific authorization before any signed transaction consideration",
    ],
    nextReadOnlyStep: "Keep Cap dormant unless a new asset/oracle/agent state change appears; then refresh read-only vault/oracle/lender assets, pauses, caps, prices, agent health/maxLiquidatable, and redeem/DEX exit quotes before any fork/static proof.",
  },
  {
    key: "spectraV2FullTest",
    id: "spectra-v2-full-test-sweep",
    protocol: "Spectra V2",
    chain: "Avalanche/Ethereum/Base/Sonic; Arbitrum/Optimism/Hemi/BNB/Hyperliquid/Katana/Flare/Monad caveats",
    surface: "Full Spectra V2 PT/YT/SY/IBT vault, registry/factory/router, oracle/rate, consumer, DEX/AMM, and exact-economics route-positive test",
    baseScore: 43,
    routePositiveFields: ["routePositive", "executableNow"],
    watchFields: ["exactConsumerJoinRows", "consumerJoinRows", "dexLiquidityRows", "oracleRows", "erc4626Rows", "ptYtRows", "marketRows", "routerRows"],
    researchFields: ["sourceFactRows", "chainSeedRows", "coreComponentRows", "localArtifactMatchRows", "exactLocalArtifactMatchRows", "filesWithLocalMatches"],
    quoteFields: ["exactEconomicsRows"],
    liquidityFields: ["dexLiquidityRows"],
    closedStatus: "spectra-v2-full-test-no-route-positive",
    watchStatus: "spectra-v2-watch-needs-current-consumer-exit-or-oracle-economics",
    sourceArtifacts: ["reports/raw/fast/spectra-v2-full-test.json", "reports/spectra-v2-full-test-triage.md"],
    blockers: [
      "No exact permissionless Spectra V2 value movement is proven from local artifacts; rows remain source/static/context only",
      "No accepted-value/accounting overvaluation is quantified for a PT/YT/SY/IBT/vault share versus immediate redeem, swap, or unwind value",
      "No consumer acceptance row proves current borrow/redeem/exit capacity, caps, oracle freshness, and borrower-side overvaluation in the same route",
      "No exact acquisition, redeem, swap, or unwind economics are present after Curve/AMM liquidity, fees, slippage, maturity discount, negative-yield behavior, and gas",
      "No same-block exit path is proven from acquisition through router/market/factory/registry accounting into a liquid exit venue",
      "Maturity and negative-yield caveats remain unresolved for PT/YT pricing, discount model behavior, and IBT/SY exchange-rate assumptions",
      "Oracle/rate manipulation proof is absent; admin-controlled setters or stale labels alone are insufficient",
      "Spectra MetaVaults prior artifacts are related/context-only and do not close the distinct spectra-v2 target",
      "No fork/static value-delta proof and no signed action justified",
    ],
    requiredForRoutePositive: [
      "accepted-value/accounting overvaluation in current Spectra V2 registry/factory/market state prices PT/YT/SY/IBT/vault shares above immediate market/redeem value after all fees",
      "a lending, vault, or exit consumer currently accepts the specific Spectra asset with material caps, cash/borrow capacity, oracle freshness, and no allowlist/pause/role blocker",
      "exact acquisition, split/merge, redeem, router, Curve/AMM, and unwind path amounts are positive after slippage, maturity discounts, negative-yield effects, and gas",
      "same-block or otherwise executable acquisition -> accounting acceptance -> borrow/redeem/unwind -> exit sequence is proven for the exact token and size",
      "maturity, expiry, negative-yield, PT/YT redemption, SY/IBT exchange-rate, and discount-model caveats are resolved",
      "oracle/rate/accounting inputs are permissionlessly manipulable or stale/divergent in a way that affects accepted value",
      "local static/fork value-delta proof shows positive attacker-controlled balance movement before any live preflight",
      "independent defensive review and explicit route-specific authorization before any signed transaction consideration",
    ],
    nextReadOnlyStep: "Map Spectra V2 Registry/Factory/Router/RouterUtil market assets from verified public/static sources, then refresh local-only PT/YT/SY/IBT consumer and Curve/AMM/oracle rows to test accepted-value versus redeem/swap/unwind value without endpoint inventory or signed actions.",
  },
  {
    key: "spectraMetavaultsOutsideV2FullTest",
    id: "spectra-metavaults-outside-v2-full-test-sweep",
    protocol: "Spectra MetaVaults Outside V2",
    chain: "Base/Arbitrum/Ethereum/Avalanche; Flare/Katana caveats",
    surface: "Full Spectra MetaVault vault share, wrapper/infra vault, ERC-7540 async flow, ERC4626/rate conversion, PT/LP/IBT strategy accounting, roles/curator, bridge/custody, consumer, DEX-liquidity, and exact-economics route-positive test",
    baseScore: 41,
    routePositiveFields: ["routePositive", "executableNow"],
    watchFields: ["exactConsumerJoinRows", "consumerJoinRows", "candidatesWithExactConsumerOrExit", "candidatesWithCurrentErc7540StateProof", "candidatesWithCurrentErc4626Proof", "candidatesWithExitEconomicsProof", "dexLiquidityRows", "exitLiquidityRows", "registryRows", "metavaultRows", "wrapperRows", "infraRows", "erc7540AsyncFlowRows", "erc4626RateRows", "ptYtIbtRows", "rateProviderOracleRows", "curatorRolesRows", "bridgeRemoteCustodyRows"],
    researchFields: ["sourceFactRows", "chainSeedRows", "addressSeedRows", "adapterRows", "surfaceRows", "priorPrefilterRows", "localArtifactMatchRows", "exactLocalArtifactMatchRows", "filesWithLocalMatches", "metavaultCandidateRows", "candidateMatrixRows", "candidatesWithAllStaticSeeds", "candidatesWithLocalArtifactRows", "candidateMatrixProofGapRows"],
    quoteFields: ["exactEconomicsRows"],
    liquidityFields: [],
    closedStatus: "spectra-metavaults-outside-v2-full-test-no-route-positive",
    watchStatus: "spectra-metavaults-outside-v2-watch-needs-share-consumer-or-exit-economics",
    sourceArtifacts: ["reports/raw/fast/spectra-metavaults-outside-v2-full-test.json", "reports/spectra-metavaults-outside-v2-full-test-triage.md", "reports/raw/fast/prefilter-spectra-metavaults-route-prefilter.json"],
    blockers: [
      "No exact-positive Spectra MetaVault vault share -> rate/strategy accounting -> consumer or exit venue -> borrow/redeem/unwind route is proven in local artifacts; registry/vault rows are static seeds only",
      "Static/local candidate matrix now covers smvUSDC, gamisUSDC, and csmv-cbETH, but every candidate is blocked by missing current state, exact consumer/exit, and economics proof",
      "Existing route prefilter is dormant/route-negative and is prior context only; this full-test did not read endpoint inventories or refresh live state",
      "ERC-7540 async request->settle->claim timing and epoch semantics can block same-block acquisition/redeem/unwind until exact current state is proven",
      "ERC4626 convertToAssets/convertToShares/totalAssets and intentionally reverting previews require current values before any accepted-value claim can be made",
      "Wrapper/infra vault and single-underlying rows do not prove live balances, custody, totalAssets, totalSupply, or redeemability at route size",
      "Curator PT/LP/IBT/idle allocations, performance fee on settle, and RolesModifier/validation constraints require exact accounting and role-state proof",
      "Flare and Katana remain caveat chains without new safe local coverage; no cross-chain/remote custody or bridge bypass with liquid value is proven",
      "No fork/static value-delta proof and no signed action justified",
    ],
    requiredForRoutePositive: [
      "specific deployed MetaVault share, wrapper, infra vault, underlying asset, totalSupply, totalAssets, convertToAssets/convertToShares, and live epoch/request state are resolved",
      "ERC-7540 requestDeposit/requestRedeem, settle, claimable/pending amounts, decrease paths, operator rights, epochId, and fees are quantified for the same asset and size",
      "strategy PT/LP/IBT/idle allocations, rate/oracle/accounting inputs, performance fee, and wrapper/infra custody values reconcile to redeem/market value",
      "same MetaVault share/wrapper or claim is accepted by a material lending/oracle/settlement consumer or has immediate permissionless redeem/claim/DEX exit liquidity at route size",
      "Zodiac RolesModifier, validation constraints, curator/admin/guardian/setOperator controls, bridge/remote/custody, and caveat-chain semantics do not block the attacker path",
      "accepted value exceeds exact acquisition, redeem/claim, borrow/liquidation, or DEX unwind value after fees, performance fee, slippage, queues/epochs, caps, and LTV/LLTV haircuts",
      "local static/fork value-delta proof shows positive attacker-controlled balance movement before any live preflight",
      "independent defensive review and explicit route-specific authorization before any signed transaction consideration",
    ],
    nextReadOnlyStep: "Keep the static/local Spectra MetaVault candidate matrix refreshed; only move to sanitized read-only state refresh if a concrete share/wrapper/claim maps to a material consumer or permissionless redeem/claim/DEX exit, then prove ERC-7540 state, ERC4626 conversions, wrapper/infra custody, strategy allocation, roles, and exact economics before any fork/static proof.",
  },
  {
    key: "ringFewFullTest",
    id: "ring-few-full-test-sweep",
    protocol: "Ring Few",
    chain: "Ethereum/BNB/Blast/Base/Arbitrum; Hyperliquid L1/HyperEVM caveat",
    surface: "Full Ring Few factory/wrapper custody, backing/proof, role, consumer, DEX/AMM, and exact-economics route-positive test",
    baseScore: 42,
    routePositiveFields: ["routePositive", "executableNow"],
    watchFields: ["consumerJoinRows", "dexLiquidityRows", "bridgeCustodyRows", "wrapperRows", "roleRows", "proofBindingRows"],
    researchFields: ["sourceFactRows", "chainSeedRows", "factorySeedRows", "coreSurfaceRows", "localArtifactMatchRows", "exactLocalArtifactMatchRows", "localFactoryContextRows"],
    quoteFields: ["exactEconomicsRows"],
    liquidityFields: ["dexLiquidityRows", "bridgeCustodyRows"],
    closedStatus: "ring-few-full-test-no-route-positive",
    watchStatus: "ring-few-watch-needs-backing-proof-consumer-or-exact-exit-economics",
    sourceArtifacts: ["reports/raw/fast/ring-few-full-test.json", "reports/ring-few-full-test-triage.md"],
    blockers: [
      "No exact permissionless Ring Few value movement is proven from local artifacts; rows remain source/static/context only",
      "No backing mismatch or proof bypass is quantified for a specific wrapped token, custody asset, domain, nonce, recipient, and chain pair",
      "Wrapper supply versus custody holdings is not locally proven at route scale; factory addresses are static seeds and not live code/state proof",
      "FewWrappedToken mint, burnFrom, and core role surfaces appear role-gated in public/static context; no public role bypass is proven",
      "Wrap/unwrap routes remain blocked unless token transfer restrictions, paused state, allowlists, underlying custody, and same-asset redemption are proven open",
      "No exact consumer acceptance row proves current lending/borrow capacity, caps, oracle freshness, and borrower-side overvaluation for a Ring Few wrapped asset",
      "Few/Ring V2 AMM or other DEX liquidity is not tied to exact acquisition/unlock/unwrap/swap/borrow economics after fees, slippage, restrictions, and gas",
      "Hyperliquid L1/HyperEVM remains caveat/context without local support for chain semantics, endpoint-free state, and exit path",
      "No fork/static value-delta proof and no signed action justified",
    ],
    requiredForRoutePositive: [
      "exact proof/domain/nonce/token/recipient binding flaw permissionlessly unlocks or mints value without equivalent custody movement",
      "current wrapped supply and wrapper-held underlying balances show exploitable divergence at route scale, not just static factory labels",
      "mint, burnFrom, unwrap, pause, governor/guardian/minter/burner/pauser checks are bypassable or irrelevant to the route",
      "wrapped and underlying token transfer, allowlist, blacklist, tokenized-stock, and permit behavior are valid along the full route",
      "a live lending, vault, borrow, or exit consumer accepts the exact wrapped asset with material caps, liquidity, oracle configuration, and no pause/role blocker",
      "Few/Ring V2 or external AMM liquidity, price impact, fees, transfer restrictions, and exit depth are exact-quoted for the same asset",
      "acquisition, unlock, unwrap, swap, borrow, liquidation, and exit economics are positive after proof costs, bridge fees, AMM slippage, borrow limits, liquidation factors, and gas",
      "Hyperliquid L1/HyperEVM chain semantics and bridge finality are resolved before treating that context as executable",
      "local static/fork value-delta proof shows positive attacker-controlled balance movement before any live preflight",
      "independent defensive review and explicit route-specific authorization before any signed transaction consideration",
    ],
    nextReadOnlyStep: "Map Ring Few FewFactory/FewWrappedToken wrappers from static verified source labels and local artifacts, then join each wrapped token to local lending/DEX/oracle rows to compare wrapper supply, custody backing, and exact exit economics without endpoint inventory or signed actions.",
  },
  {
    key: "rockawayxFullTest",
    id: "rockawayx-full-test-sweep",
    protocol: "RockawayX",
    chain: "Ethereum/BNB/Base; Solana/Sei/Etherlink/Plume caveats",
    surface: "Full RockawayX risk-curator producer/vault/token, ERC4626, Morpho, oracle/accounting, bridge/custody, consumer, DEX-liquidity, and exact-economics route-positive test",
    baseScore: 42,
    routePositiveFields: ["routePositive", "executableNow"],
    watchFields: ["exactConsumerJoinRows", "consumerJoinRows", "dexLiquidityRows", "oracleRows", "custodyRows", "erc4626Rows", "curatorRows"],
    researchFields: ["sourceFactRows", "chainSeedRows", "addressSeedRows", "surfaceRows", "localArtifactMatchRows", "exactLocalArtifactMatchRows", "filesWithLocalMatches"],
    quoteFields: ["exactEconomicsRows"],
    liquidityFields: [],
    closedStatus: "rockawayx-full-test-no-route-positive",
    watchStatus: "rockawayx-watch-needs-current-consumer-exit-or-accounting-economics",
    sourceArtifacts: ["reports/raw/fast/rockawayx-full-test.json", "reports/rockawayx-full-test-triage.md"],
    blockers: [
      "No exact-positive RockawayX producer asset -> accepted value -> consumer -> exit route is proven in local artifacts; address rows are static seeds only",
      "Adapter TVL and curator labels do not prove live code, current vault state, accepted collateral value, or exit liquidity",
      "Morpho curator/owner rows require exact vault/market membership, caps, oracle configuration, cash/borrow capacity, and borrower-side value delta before route-positive status",
      "ERC4626/Upshift/Accountable/Midas rows require current asset, totalAssets, totalSupply, convertToAssets, token pricing, and redeem/withdraw behavior with no pause/role/proxy blockers",
      "No oracle/accounting overvaluation is quantified versus immediate redeem, swap, or unwind value after fees, slippage, caps, and gas",
      "Bridge/custody/backing caveats remain context-only; no permissionless custody mismatch, proof bypass, or unlock path is locally proven",
      "Solana, Sei, Etherlink, and Plume Mainnet remain caveats unless safe read-only coverage exists and endpoint details remain sanitized",
      "No fork/static value-delta proof and no signed action justified",
    ],
    requiredForRoutePositive: [
      "specific RockawayX-linked vault/token/curator asset is accepted by a current consumer with material caps, cash/borrow capacity, oracle configuration, and no role/pause blocker",
      "accepted consumer/oracle/accounting value exceeds immediate market, redeem, or unwind value after LTV/LLTV haircuts, fees, slippage, caps, and gas",
      "ERC4626/vault semantics for asset, totalAssets, totalSupply, convertToAssets, deposit/withdraw/mint/redeem limits, transferability, and roles are verified for the exact asset",
      "Morpho market/vault membership, curator/owner authority implications, LLTV, oracle freshness/scaling, supply/borrow cash, and liquidation/borrow route viability are proven",
      "Midas/Upshift/Accountable pricing, getTotalAssets/lastTotalAssets/totalSupply semantics, custody/backing, and redeemability are resolved",
      "acquisition, borrow/liquidation/redeem, and DEX/AMM/unwind liquidity are exact-quoted positive at route scale after all costs",
      "caveat-chain coverage uses only sanitized read-only endpoint inventory or equivalent public artifacts and stores no raw endpoint details",
      "local static/fork value-delta proof shows positive attacker-controlled balance movement before any live preflight",
      "independent defensive review and explicit route-specific authorization before any signed transaction consideration",
    ],
    nextReadOnlyStep: "Map RockawayX static address seeds to local Morpho/ERC4626/Upshift/Accountable/Midas artifacts, then compare accepted accounting value against redeem/swap/exit liquidity with sanitized read-only endpoint coverage only if a concrete candidate appears.",
  },
  {
    key: "roycoV1FullTest",
    id: "royco-v1-full-test-sweep",
    protocol: "Royco V1",
    chain: "Berachain/Arbitrum/Ethereum/Sonic/Base; Plume/HyperEVM/Corn caveats",
    surface: "Full Royco V1 IAM recipe/vault, WrappedVault/BoringVault share accounting, Weiroll execution, rewards/points, CCDM bridge/custody, consumer, DEX-liquidity, and exact-economics route-positive test",
    baseScore: 41,
    routePositiveFields: ["routePositive", "executableNow"],
    watchFields: ["exactConsumerJoinRows", "consumerJoinRows", "dexLiquidityRows", "oracleRows", "vaultRows", "iamRows", "rewardRows", "ccdmRows", "queueEpochRows"],
    researchFields: ["sourceFactRows", "chainSeedRows", "addressSeedRows", "surfaceRows", "localArtifactMatchRows", "exactLocalArtifactMatchRows", "filesWithLocalMatches"],
    quoteFields: ["exactEconomicsRows"],
    liquidityFields: [],
    closedStatus: "royco-v1-full-test-no-route-positive",
    watchStatus: "royco-v1-watch-needs-share-rate-offer-reward-or-exit-economics",
    sourceArtifacts: ["reports/raw/fast/royco-v1-full-test.json", "reports/royco-v1-full-test-triage.md"],
    blockers: [
      "No exact-positive Royco V1 vault/share -> accounting -> consumer/exit route is proven in local artifacts; address rows are static seeds only",
      "Adapter TVL, subgraph-style rows, and deterministic deployment labels do not prove live code, current vault state, accepted collateral value, or exit liquidity",
      "WrappedVault/BoringVault rows require exact asset, totalAssets, totalSupply, convertToAssets/preview/max limits, teller/accountant semantics, and redeemability before route-positive status",
      "RecipeMarketHub/VaultMarketHub offer rows require concrete fill/allocate/cancel/claim/forfeit economics and no pause/role/script blocker",
      "WeirollWallet execution/forfeit/lockedUntil paths require exact permissionless execution and attacker-controlled value delta, not just function/event presence",
      "Rewards/Points/CCDM/LayerZero/receipt-token/unlock timestamp contexts are not value-positive without exact claim/unlock/redeem and exit amounts",
      "No oracle/share-rate/accounting overvaluation is quantified versus immediate redeem, swap, or unwind value after fees, slippage, queue/epoch delays, and gas",
      "DEX/consumer joins are context only until a concrete accepted share asset, consumer caps/cash/oracle, and exit route are quantified at size",
      "Plume Mainnet, Hyperliquid L1/HyperEVM, and Corn remain caveats unless safe read-only coverage exists and endpoint details remain sanitized",
      "No fork/static value-delta proof and no signed action justified",
    ],
    requiredForRoutePositive: [
      "specific Royco WrappedVault, BoringVault, IAM share, recipe receipt, or incentive asset is accepted by a current consumer or exit venue with material caps and liquidity",
      "asset, totalAssets, totalSupply, convertToAssets, previewRedeem, maxWithdraw/maxRedeem, teller/accountant rates, queues, epochs, and fees are quantified for the exact asset",
      "create/fill/allocate/cancel/claim/forfeit/executeWithdrawalScript economics are positive and unblocked by pause, role, lockedUntil, script, or withdrawal constraints",
      "claimable reward token value is real transferable value rather than event-only points and can be captured/unwound by the attacker after fees and restrictions",
      "CCDM DepositLocker/DepositExecutor/LayerZero/receipt-token/unlock timestamp flow has a permissionless custody/finality/queue edge with positive economics if used",
      "consumer oracle freshness/scaling, accepted value, caps, cash/borrow capacity, and no role/pause/proxy blocker are verified",
      "DEX/AMM/CEX unwind liquidity, price impact, transfer restrictions, and gas are exact-quoted for the share, underlying, reward, or receipt asset at route scale",
      "caveat-chain coverage uses only sanitized read-only endpoint inventory or equivalent public artifacts and stores no raw endpoint details",
      "local static/fork value-delta proof shows positive attacker-controlled balance movement before any live preflight",
      "independent defensive review and explicit route-specific authorization before any signed transaction consideration",
    ],
    nextReadOnlyStep: "Map Royco V1 deterministic IAM and vault/accountant/teller seeds to local ERC4626/BoringVault/consumer artifacts, then compare share-rate accounting against redeem/unwind/exit liquidity with sanitized read-only endpoint coverage only if a concrete candidate appears.",
  },
  {
    key: "eigencloudFullTest",
    id: "eigencloud-full-test-sweep",
    protocol: "EigenCloud",
    chain: "Ethereum",
    surface: "Full EigenCloud/EigenLayer strategy-share accounting, delegation/slashing, EigenPod/native ETH, withdrawal queue, rewards, bridge/custody, LRT consumer, DEX-liquidity, and exact-economics route-positive test",
    baseScore: 42,
    routePositiveFields: ["routePositive", "executableNow"],
    watchFields: ["exactConsumerJoinRows", "consumerJoinRows", "exactTokenConsumerReferenceRows", "tokenReferenceRows", "strategyShareAccountingRows", "withdrawalQueueRows", "slashingAllocationRows", "eigenpodNativeEthRows", "rewardsRows", "bridgeCustodyRows"],
    researchFields: ["sourceFactRows", "chainSeedRows", "deploymentRows", "surfaceRows", "localArtifactMatchRows", "exactLocalArtifactMatchRows", "filesWithLocalMatches"],
    quoteFields: ["exactEconomicsRows"],
    liquidityFields: [],
    closedStatus: "eigencloud-full-test-no-route-positive",
    watchStatus: "eigencloud-watch-needs-current-withdrawal-share-accounting-or-exact-consumer-economics",
    sourceArtifacts: ["reports/raw/fast/eigencloud-full-test.json", "reports/eigencloud-full-test-triage.md"],
    blockers: [
      "No exact-positive EigenCloud/EigenLayer strategy-share -> accounting -> consumer/exit route is proven in local artifacts; deployment rows are static seeds only",
      "Adapter TVL and official deployment labels do not prove live code state, user shares, current withdrawability, accepted collateral value, or exit liquidity",
      "StrategyManager, StrategyBase/EigenStrategy, DelegationManager, EigenPodManager, and EigenPod rows require current deposit shares, underlying conversion, slashing factors, delegation state, and withdrawal maturity before route-positive status",
      "Queued withdrawal and reward rows require valid roots, maturity/activation, caller authorization, transferability, and exact claim/withdraw/unwind amounts",
      "Prior EigenLayer NAV/DEX and slashing/rehypothecation rows are watch context only and are not promoted without current exact economics",
      "LRT/LST consumer joins are context only until a concrete accepted asset, consumer caps/cash/oracle, and exit route are quantified at size",
      "No oracle/accounting overvaluation is quantified versus immediate redeem, withdraw, swap, or unwind value after fees, slashing, queue delays, and gas",
      "No fork/static value-delta proof and no signed action justified",
    ],
    requiredForRoutePositive: [
      "specific EigenLayer strategy share, EigenPod/native ETH share, EIGEN/bEIGEN asset, withdrawal claim, reward claim, or LRT receipt is accepted by a current consumer or exit venue with material caps and liquidity",
      "strategy underlying, total shares, staker deposit shares, sharesToUnderlying/underlyingToShares, slashing factors, and withdrawal delay/maturity are quantified for the exact asset",
      "queued withdrawal or reward route has active roots/proofs, caller authorization, maturity, and transferable positive value after all constraints",
      "consumer oracle freshness/scaling, accepted value, caps, cash/borrow capacity, and no role/pause/proxy blocker are verified",
      "DEX/AMM/CEX unwind liquidity, price impact, transfer restrictions, slashing/deallocation adjustments, and gas are exact-quoted for the strategy, LRT/LST, EIGEN/bEIGEN, reward, or withdrawal asset at route scale",
      "acquisition, withdraw/complete/claim/redeem, borrow/liquidation, and exit economics are positive after fees, slippage, queue delay, slashing, LTV/LLTV haircuts, and gas",
      "local static/fork value-delta proof shows positive attacker-controlled balance movement before any live preflight",
      "independent defensive review and explicit route-specific authorization before any signed transaction consideration",
    ],
    nextReadOnlyStep: "Map EigenCloud/EigenLayer StrategyManager, DelegationManager, EigenPodManager, EigenStrategy/bEIGEN, withdrawal queue, and RewardsCoordinator rows to concrete current strategy shares, matured withdrawals, rewards, LRT/LST consumers, and exact exit economics with sanitized read-only endpoint coverage only if a concrete candidate appears.",
  },
  {
    key: "stakeDaoFullTest",
    id: "stake-dao-full-test-sweep",
    protocol: "Stake DAO",
    chain: "Ethereum/Base/Arbitrum/Polygon/Optimism/Avalanche/Sonic/Linea; Fraxtal/xDai-Gnosis caveats",
    surface: "Full Stake DAO sdToken, LiquidLocker, vault/yield allocator, gauge/reward, Curve LP, Convex wrapper, Votemarket oracle, LaPoste/OFT bridge, consumer, DEX-liquidity, and exact-economics route-positive test",
    baseScore: 41,
    routePositiveFields: ["routePositive", "executableNow"],
    watchFields: ["exactConsumerJoinRows", "consumerJoinRows", "dexLiquidityRows", "exitLiquidityRows", "oracleRows", "stakeDaoVaultRows", "sdTokenRows", "veSdtLockerRows", "gaugeRows", "rewardClaimRows", "bridgeCustodyRows"],
    researchFields: ["sourceFactRows", "chainSeedRows", "addressSeedRows", "surfaceRows", "localArtifactMatchRows", "exactLocalArtifactMatchRows", "filesWithLocalMatches"],
    quoteFields: ["exactEconomicsRows"],
    liquidityFields: [],
    closedStatus: "stake-dao-full-test-no-route-positive",
    watchStatus: "stake-dao-watch-needs-current-sdtoken-locker-gauge-consumer-or-exit-economics",
    sourceArtifacts: ["reports/raw/fast/stake-dao-full-test.json", "reports/stake-dao-full-test-triage.md"],
    blockers: [
      "No exact-positive Stake DAO vault/sdToken/gauge -> accepted value -> consumer/exit route is proven in local artifacts; address rows are static seeds only",
      "Adapter TVL, public deployment labels, offchain registry labels, and Reserve/Curve/Convex local context do not prove live code state, current balances, accepted collateral value, or exit liquidity",
      "sdToken, LiquidLocker, depositor, accumulator, and veSDT/vlSDT rows require exact mint/burn/redeem/lock state, transferability, fees, and permissionless action paths before route-positive status",
      "Gauge, GaugeController, Curve pool/LP, and Convex wrapper rows require current gauge staking, reward accounting, virtual price, pool liquidity, unwind depth, and no pause/killed/emergency blocker",
      "Reserve StakeDAORecursiveCollateral is concrete consumer-plugin context, but no current accepted-value divergence, material borrow/redeem capacity, or borrower-side value delta is proven",
      "Votemarket/oracle/verifier and LaPoste/OFT/TokenFactory rows are historical or architectural risk context only; no current proof/message/peer/config bypass with liquid value is proven",
      "Fraxtal and xDai/Gnosis remain caveat chains unless safe local coverage exists and endpoint details remain sanitized",
      "No fork/static value-delta proof and no signed action justified",
    ],
    requiredForRoutePositive: [
      "specific Stake DAO sdToken, LiquidLocker receipt, vault share, gauge stake, reward claim, Votemarket claim, or OFT/bridge asset is accepted by a current consumer or exit venue with material caps and liquidity",
      "mint/burn/redeem, locker/depositor, gauge share, reward claim, Curve LP virtual-price, oracle/verifier, and bridge/OFT peer semantics are quantified for the exact asset",
      "consumer oracle freshness/scaling, accepted value, caps, cash/borrow capacity, and no role/pause/proxy/killed-gauge blocker are verified",
      "DEX/Curve/Convex/redeem/unwind liquidity, price impact, transfer restrictions, and gas are exact-quoted for the share, sdToken, LP, gauge, reward, or bridge asset at route scale",
      "acquisition, claim/redeem/withdraw/bridge, borrow/liquidation, and exit economics are positive after fees, slippage, queues, LTV/LLTV haircuts, and gas",
      "Fraxtal/xDai-Gnosis coverage uses only sanitized read-only endpoint inventory or equivalent public artifacts and stores no raw endpoint details",
      "local static/fork value-delta proof shows positive attacker-controlled balance movement before any live preflight",
      "independent defensive review and explicit route-specific authorization before any signed transaction consideration",
    ],
    nextReadOnlyStep: "Map Stake DAO sdToken/LiquidLocker/vault/gauge/Curve-LP/reward/bridge rows to concrete current producer assets, consumers, killed/paused/role states, and exact exit economics with sanitized read-only endpoint coverage only if a concrete candidate appears.",
  },
  {
    key: "stoboxFullTest",
    id: "stobox-full-test-sweep",
    protocol: "Stobox",
    chain: "Arbitrum/BNB Chain/Polygon",
    surface: "Full Stobox RWA receipt, STV3 Diamond/facets, STBU/STBX token identity, DID/KYC transfer gates, NAV/rate provider, offering/refund/custody, consumer, DEX-liquidity, and exact-economics route-positive test",
    baseScore: 41,
    routePositiveFields: ["routePositive", "executableNow"],
    watchFields: ["exactConsumerJoinRows", "consumerJoinRows", "dexLiquidityRows", "exitLiquidityRows", "oracleRows", "receiptTokenRows", "navRateProviderRows", "tokenizedSecurityRows", "transferRestrictionRows", "redemptionCustodyRows", "roleAdminRows"],
    researchFields: ["sourceFactRows", "chainSeedRows", "addressSeedRows", "surfaceRows", "localArtifactMatchRows", "exactLocalArtifactMatchRows", "filesWithLocalMatches"],
    quoteFields: ["exactEconomicsRows"],
    liquidityFields: [],
    closedStatus: "stobox-full-test-no-route-positive",
    watchStatus: "stobox-watch-needs-nav-consumer-transfer-or-exit-economics",
    sourceArtifacts: ["reports/raw/fast/stobox-full-test.json", "reports/stobox-full-test-triage.md"],
    blockers: [
      "No exact-positive Stobox RWA receipt -> NAV/rate provider -> accepted-value consumer -> borrow/redeem/exit route is proven in local artifacts; address rows are static seeds only",
      "The Stobox adapter sample maps to the documented Arbitrum RWAVaultFactory, but adapter/TVL/docs labels do not prove live vault state, receipt supply, NAV/rate values, accepted collateral value, or exit liquidity",
      "No confirmed public NAV/rate-provider contract was found in supplied docs context; stale/manual/wrong-decimal NAV/rate risks remain proof gaps, not route-positive evidence",
      "STV3 Diamond/facet, role/admin, trusted-address, and compliance-rule surfaces require deployed selector/facet/role state and a permissionless value path before impact can be claimed",
      "DID/KYC/KYB, frozen/paused/locked/forced-transfer/forced-burn rules can invalidate transferability or liquidation assumptions; no downstream consumer ignoring those restrictions is proven",
      "Offering, soft-cap, refund, lockup, treasury, and custody rows require exact state-machine amounts and backing evidence before redemption/custody economics can be trusted",
      "Legacy STBU chain addresses create identity/confusion context only; no bridge/cross-chain or consumer route ties a wrong token to liquid accepted value",
      "No fork/static value-delta proof and no signed action justified",
    ],
    requiredForRoutePositive: [
      "specific Stobox STV3/STBX/RWA receipt, vault share, offering receipt, refund claim, or STBU/STBX chain-specific token is accepted by a current consumer or exit venue with material caps and liquidity",
      "deployed NAV/rate/MonetaryFacet/pricing path, decimals, freshness, authority, and consumer use are resolved for the exact asset",
      "DID/KYC/KYB, canTransfer/canTransact, frozen/paused/locked/lockup, forcedTransfer/forcedBurn, jurisdiction and trusted-address rules do not block the route",
      "Diamond/facet selector state, upgrade authority, issuer/admin/operator roles, emergency controls, registry and offering permissions do not require privileged action",
      "consumer oracle freshness/scaling, accepted value, caps, cash/borrow capacity, and no role/pause/proxy/compliance blocker are verified",
      "acquisition, redemption, refund, borrow/liquidation, and DEX/settlement unwind economics are exact-quoted positive after fees, slippage, gas, caps, locks, and LTV/LLTV haircuts",
      "local static/fork value-delta proof shows positive attacker-controlled balance movement before any live preflight",
      "independent defensive review and explicit route-specific authorization before any signed transaction consideration",
    ],
    nextReadOnlyStep: "Map Stobox STV3/STBX/RWA receipt and vault/factory/offering rows to current NAV/rate provider, Diamond facets/roles, DID/KYC transfer gates, consumers, and exact exit economics with sanitized read-only endpoint coverage only if a concrete candidate appears.",
  },
  {
    key: "brixFullTest",
    id: "brix-full-test-sweep",
    protocol: "Brix",
    chain: "Ethereum",
    surface: "Full Brix iTRY/wiTRY/WITRY vault-yield allocator, ERC4626 share-rate/donation, NAV/backing/oracle, transfer/role gates, redemption/OFT, consumer, DEX-liquidity, and exact-economics route-positive test",
    baseScore: 41,
    routePositiveFields: ["routePositive", "executableNow"],
    watchFields: ["exactConsumerJoinRows", "consumerJoinRows", "dexLiquidityRows", "exitLiquidityRows", "oracleRows", "vaultShareRows", "underlyingTokenRows", "erc4626ProbeRows", "shareRateRows", "donationRiskRows", "navBackingRows", "transferRestrictionRows", "redemptionRows"],
    researchFields: ["sourceFactRows", "chainSeedRows", "addressSeedRows", "surfaceRows", "localArtifactMatchRows", "exactLocalArtifactMatchRows", "filesWithLocalMatches"],
    quoteFields: ["exactEconomicsRows"],
    liquidityFields: [],
    closedStatus: "brix-full-test-no-route-positive",
    watchStatus: "brix-watch-needs-share-rate-consumer-or-exit-economics",
    sourceArtifacts: ["reports/raw/fast/brix-full-test.json", "reports/brix-full-test-triage.md"],
    blockers: [
      "No exact-positive Brix vault share -> rate/strategy accounting -> consumer or exit venue -> borrow/redeem/unwind route is proven in local artifacts; address rows are static seeds only",
      "Discovery symbol WITRY and public iTRY/wiTRY naming remain exact-asset role ambiguity until current proxy/vault/share state is resolved",
      "No current ERC4626 share-rate, donation, rounding, totalAssets, or convertToAssets anomaly is quantified against a material accepted-value consumer",
      "No Brix-specific lending/oracle consumer row proves current collateral acceptance, caps, cash/borrow capacity, oracle freshness, and borrower-side overvaluation",
      "No DEX, fast redemption, cooldown, or permissionless redeem exit has exact route-size liquidity and positive unwind economics after fees, slippage, gas, locks, and transfer restrictions",
      "Transfer-state, blacklist/whitelist, cooldown, issuer/minter, rescue, redistribution, proxy/admin, and OFT/LayerZero controls remain blockers until proven irrelevant to the route",
      "Accountable/proof-of-reserves, DLF backing, RedStone oracle, and partner labels are public context only; they do not prove live NAV/backing or accepted value in this bounded pass",
      "No fork/static value-delta proof and no signed action justified",
    ],
    requiredForRoutePositive: [
      "specific Brix iTRY/wiTRY/WITRY vault share or underlying token is identified with exact proxy/implementation, decimals, asset(), totalSupply, totalAssets, and share/underlying role",
      "ERC4626/share-rate, convertToAssets/convertToShares, donation/rounding, MIN_SHARES, limits, and redemption behavior are quantified for the exact asset",
      "same Brix token/share is accepted by a material lending/oracle/settlement consumer or has immediate permissionless redeem/fast-redeem/DEX exit liquidity at route size",
      "Accountable/DLF/RedStone/backing path, decimals, freshness, authority, and consumer use are resolved for the exact asset",
      "transferState, blacklist/whitelist, cooldown, fast-redeem, lock, pause, OFT/bridge, and transfer restrictions do not block acquisition, collateralization, liquidation, redemption, or exit",
      "issuer/minter/admin/proxy/rescue/redistribution controls are not required for the attacker path",
      "acquisition, borrow/liquidation, redeem/withdraw, and DEX/unwind economics are exact-quoted positive after fees, slippage, gas, caps, queues, locks, and LTV/LLTV haircuts",
      "local static/fork value-delta proof shows positive attacker-controlled balance movement before any live preflight",
      "independent defensive review and explicit route-specific authorization before any signed transaction consideration",
    ],
    nextReadOnlyStep: "Map the exact Brix iTRY/wiTRY/WITRY vault share and underlying token to current ERC4626 share-rate, donation/rounding, NAV/backing/oracle, transfer-state/role gates, consumers, redeem/fast-redeem and DEX exits, with sanitized read-only endpoint coverage only if a concrete candidate appears.",
  },
  {
    key: "memeDollarFullTest",
    id: "meme-dollar-full-test-sweep",
    protocol: "Meme Dollar",
    chain: "Ethereum",
    surface: "Full Meme Dollar/PINA stable receipt, peg/NAV/oracle, role-minter/admin, coupon/epoch redemption, transfer controls, consumer, DEX-liquidity, and exact-economics route-positive test",
    baseScore: 40,
    routePositiveFields: ["routePositive", "executableNow"],
    watchFields: ["exactConsumerJoinRows", "consumerJoinRows", "dexLiquidityRows", "exitLiquidityRows", "oraclePegNavRows", "stableReceiptRows", "underlyingTokenRows", "shareRateAccountingRows", "roleMinterAdminRows", "redemptionCouponEpochRows", "transferRestrictionRows"],
    researchFields: ["sourceFactRows", "chainSeedRows", "addressSeedRows", "surfaceRows", "localArtifactMatchRows", "exactLocalArtifactMatchRows", "filesWithLocalMatches"],
    quoteFields: ["exactEconomicsRows"],
    liquidityFields: [],
    closedStatus: "meme-dollar-full-test-no-route-positive",
    watchStatus: "meme-dollar-watch-needs-current-peg-oracle-consumer-or-exit-economics",
    sourceArtifacts: ["reports/raw/fast/meme-dollar-full-test.json", "reports/meme-dollar-full-test-triage.md"],
    blockers: [
      "No exact-positive Meme Dollar/PINA stable receipt -> peg/NAV assumption -> lending or DEX exit route is proven in local artifacts; token rows are static seeds only",
      "Verified ERC20/Burnable/Permit/AccessControl surfaces do not prove live collateral backing, redeemability, or accepted-value semantics",
      "Role-controlled MINTER_ROLE minting and admin/upgrade controls remain proof gaps; no permissionless unbacked mint or role bypass is proven",
      "Bootstrap fixed oracle at $1.5 and later Uniswap price are public-doc context only; no current oracle/feed consumer, freshness, scale, or accepted-value divergence is proven",
      "Hard collateral/NAV backing is unproven; peg or Algo-Stables labels cannot support route-positive impact without current backing, supply, and consumer state",
      "Epoch/coupon/redemption semantics are not joined to a same-block permissionless redeem/borrow/unwind path with exact positive economics",
      "Local lending/consumer and DEX artifacts do not show a Meme Dollar/PINA-specific material consumer or route-size exact acquisition/unwind liquidity",
      "No fork/static value-delta proof and no signed action justified",
    ],
    requiredForRoutePositive: [
      "deployed PINA/MemeDollar token, supply, decimals, minter/admin state, and any deposit/receipt or redeem/coupon contract used for value are resolved",
      "current oracle/peg/NAV source, bootstrap-to-Uniswap transition, decimals, freshness, manipulation bounds, and trusted-consumer use are proven",
      "PINA is accepted by a material lending/oracle/settlement consumer or has immediate permissionless DEX/redeem/coupon exit liquidity at route size",
      "hard collateral, reserves, coupon/epoch liabilities, mint/burn state, and public redeemability are quantified without admin/upgrade/pause blockers",
      "no pause, transfer restriction, blacklist, upgrade, epoch, or role gate blocks acquisition, collateralization, liquidation, redemption, or exit",
      "accepted value exceeds exact acquisition, redeem/coupon, borrow/liquidation, or DEX unwind value after fees, slippage, gas, caps, locks, epochs, and LTV/LLTV haircuts",
      "local static/fork value-delta proof shows positive attacker-controlled balance movement before any live preflight",
      "independent defensive review and explicit route-specific authorization before any signed transaction consideration",
    ],
    nextReadOnlyStep: "Map Meme Dollar/PINA to current token supply, MINTER_ROLE/admin controls, peg/oracle/NAV source, backing/redeemability, consumer caps/cash/oracles, DEX pairs, coupon/epoch exits, and exact route economics with sanitized read-only endpoint coverage only if a concrete candidate appears.",
  },
  { key: "recentContractsOldMoneyProbes", id: "recent-contracts-old-money-probe-sweep", protocol: "Recent value-holding contracts", chain: "Ethereum/Base/Arbitrum", surface: "Top recent blue-chip inflow contract static probes", baseScore: 37, routePositiveFields: ["routePositive", "executableNow"], watchFields: ["watchCandidates", "publicTokenDrainProbeSuccessRows"], researchFields: ["rowsProbed", "uniqueContracts", "targetStaticSuccessRows"], liquidityFields: ["maxLiveBalanceUsd"], closedStatus: "recent-old-money-static-probes-no-route-positive", watchStatus: "recent-old-money-watch-needs-fork-state-delta-proof", sourceArtifacts: ["reports/raw/fast/recent-contracts-old-money-probes.json", "reports/recent-contracts-old-money-probes.md", "reports/raw/fast/recent-contracts-old-money.json"], blockers: ["No arbitrary-sender token transferFrom probe succeeded", "Target selector static-call successes, if any, are ambiguous without balance-delta proof and decoded caller entitlement", "No fork/state-delta extraction proof", "No signed action authorization"], requiredForRoutePositive: ["arbitrary-sender static probe proves token balance movement or allowance bypass", "exact extractable token amount is positive and material", "fork/state-delta proof confirms controlled asset movement", "no owner, role, allowance, caller-entitlement, or no-op blocker remains"], nextReadOnlyStep: "Keep old-money candidates as review-only; expand probes or fork only if public token-drain static proof or decoded permissionless value movement appears." },
  { key: "openedenTbillPhase0", id: "openeden-tbill-phase0-sweep", protocol: "OpenEden TBILL", chain: "Ethereum/Arbitrum/BNB Chain", surface: "OpenEden TBILL RWA token/NAV, exact EVM deployments, DEX liquidity, legacy Euler context, and focused consumer graph Phase 0", baseScore: 43, routePositiveFields: ["routePositive", "executableNow"], watchFields: ["currentWatchCandidates", "watchCandidates"], researchFields: ["tokenRows", "codePresentRows", "currentConsumerMatches", "currentWatchCandidates"], liquidityFields: ["topDexLiquidityUsd"], closedStatus: "openeden-tbill-phase0-no-route-positive", watchStatus: "openeden-tbill-watch-needs-consumer-liquidity-or-public-exit", sourceArtifacts: ["reports/raw/fast/openeden-tbill-phase0.json", "reports/raw/fast/openeden-tbill-rwa-nav-consumer-graph-quick.json"], blockers: ["Focused current RWA/NAV graph found no OpenEden TBILL consumer matches", "Older Euler eTBILL rows have zero cash, zero borrows, zero supply, and zero LTV", "TBILL is not ERC4626-like in observed calls and no public same-block redemption path was resolved", "Public GeckoTerminal and Dexscreener checks found no executable TBILL DEX liquidity", "RWA redemption is permissioned or restricted until a public atomic exit is proven", "No fork extraction proof"], requiredForRoutePositive: ["Exact TBILL accepted as collateral, oracle input, redemption asset, or liquidation asset with positive LTV/LLTV and material liquidity", "permissionless acquisition and exit liquidity for exact TBILL at route size", "accepted value exceeds acquisition and unwind value after haircuts, slippage, fees, caps, queues, and gas", "fork/static proof before any live or signed action"], nextReadOnlyStep: "Keep OpenEden closed unless TBILL gains a material trusted consumer with borrow/redeem/liquidation liquidity, public DEX or redemption exit appears, or NAV/accepted-value divergence becomes exact-positive." },
  { key: "lighterBridgePrefilter", id: "lighter-bridge-route-prefilter-sweep", protocol: "Lighter Bridge", chain: "Ethereum/Arbitrum", surface: "Lighter Bridge public proof, state-root, withdrawal, pending-balance, custody, source-review, and consumer route prefilter", baseScore: 43, routePositiveFields: ["routePositive", "executableNow"], watchFields: ["proofBypassRows", "consumerJoinRows", "exactEconomicsRows"], researchFields: ["materialTokenBalanceRows"], liquidityFields: ["totalTrackedCustodyUsd", "nativeBalanceUsd"], closedStatus: "lighter-bridge-prefilter-no-route-positive", watchStatus: "lighter-bridge-watch-needs-proof-bypass-or-consumer-route", sourceArtifacts: ["reports/raw/fast/prefilter-lighter-bridge-route-prefilter.json"], blockers: ["No public proof/state-root/withdrawal binding bypass was identified", "No attacker-controlled pending-balance credit path was identified", "No Lighter-specific wrapped token consumer join was found in local artifacts", "Material custody is not extractive without a permissionless unlock, mint, or withdrawal flaw", "No exact borrow, redeem, liquidation, DEX unwind, or unlock economics exist", "No fork extraction proof"], requiredForRoutePositive: ["invalid, replayed, or under-bound Lighter withdrawal/proof can unlock a tracked liquid asset", "verified-batch or on-chain-operation path can credit attacker-controlled pending balances", "unlocked asset can be sold or used in a consumer route with positive net value after gas and fees", "fork/static proof before any live or signed action"], nextReadOnlyStep: "Keep Lighter closed unless a proof/state-root/withdrawal binding flaw, pending-balance credit path, or bridge-specific consumer route appears with exact-positive economics." },
  { key: "asterBridgePrefilter", id: "aster-bridge-route-prefilter-sweep", protocol: "Aster Bridge", chain: "BNB Chain/Ethereum/Arbitrum", surface: "Aster Bridge treasury custody, wrapper supply, local consumer joins, proof/ledger bypass, and exact route prefilter", baseScore: 43, routePositiveFields: ["routePositive", "executableNow"], watchFields: ["proofBypassRows", "mintBurnBypassRows", "exactEconomicsRows", "localRoutePositiveRows"], researchFields: ["materialTreasuryBalanceRows", "wrappersScanned", "localConsumerRows"], liquidityFields: ["totalTrackedTreasuryUsd", "maxWrapperDexLiquidityUsd"], closedStatus: "aster-bridge-prefilter-no-route-positive", watchStatus: "aster-bridge-watch-needs-ledger-bypass-or-wrapper-consumer-route", sourceArtifacts: ["reports/raw/fast/prefilter-aster-bridge-route-prefilter.json"], blockers: ["Treasury custody is material but not extractive without a public mint, burn, withdrawal, bridge proof, or ledger-bypass flaw", "Aster wrapper consumer edges exist, but no wrapper acquisition anomaly is proven", "Venus Core asBNB context is borrowPaused/borrowCap=0 for the asBNB market in the local artifact", "USDF and asUSDF have DEX/Lista context, but no exact-positive borrow, redeem, liquidation, or unwind route", "No proof-binding, bridge-ledger, wrapper accounting bypass, exact positive route, or fork proof was identified"], requiredForRoutePositive: ["Aster wrapper can be minted or acquired below accepted consumer value through a public accounting or bridge flaw", "bridge or treasury ledger exposes a permissionless withdrawal or unlock path for tracked liquid assets", "joined Venus, Lista, Pancake, or Pendle route has exact positive economics after caps, pauses, liquidity, slippage, fees, and gas", "fork/static proof before any live or signed action"], nextReadOnlyStep: "Keep Aster closed unless a public bridge/ledger/proof bypass or wrapper acquisition anomaly appears and joined consumer economics turn exact-positive." },
  { key: "lorenzoRouteRefresh", id: "lorenzo-susd1plus-route-refresh-sweep", protocol: "Lorenzo sUSD1+", chain: "BNB Chain/Ethereum", surface: "Lorenzo sUSD1+ dormant route refresh across live quotes, same-epoch exit probe, NAV timing, queue state, and BSC supply watch", baseScore: 40, routePositiveFields: ["routePositive", "executableNow"], watchFields: ["watchCandidates"], researchFields: ["requestWithdrawPublicObserved"], edgeFields: ["bestExecutableSellEdgeBps", "bestInverseGrossEdgeBps"], closedStatus: "lorenzo-susd1plus-refresh-no-route-positive", watchStatus: "lorenzo-watch-needs-same-epoch-exit-or-positive-sell-window", sourceArtifacts: ["reports/raw/fast/prefilter-lorenzo-susd1plus-route-refresh.json", "reports/raw/fast/lorenzo-susd1plus-live.json", "reports/raw/fast/lorenzo-same-epoch-exit-probe.json", "reports/raw/fast/lorenzo-bsc-supply-route-watch.json"], blockers: ["Same-epoch public NAV exit is still unproven", "requestWithdraw/withdraw remains period-queue based and queue claims are not proven transferable", "public supply is unpaused but no NAV timing window is present", "best executable sell route is still negative before gas", "best inverse buy route is only gross-positive before the blocked NAV exit", "No fork extraction proof"], requiredForRoutePositive: ["DEX sell quote crosses current NAV plus gas and fees while public supply remains available", "NAV update timing window appears with positive pending NAV delta and enough sell liquidity", "same-epoch public NAV redeem/withdraw or transferable queue claim is proven for exact bought shares", "fork/static proof before any live or signed action"], nextReadOnlyStep: "Keep Lorenzo on fast dormant monitor; reopen only if sell economics turn positive, NAV timing window appears, or same-epoch/transferable queue exit is proven." },
  { key: "alpacaFinance2Phase0", id: "alpaca-finance-2-phase0-sweep", protocol: "Alpaca Finance 2.0", chain: "BNB Chain", surface: "Alpaca v2 money-market diamond, account manager, oracle stack, market cash/debt, borrower-log sampling, and consumer-join Phase 0", baseScore: 42, routePositiveFields: ["routePositive", "executableNow"], watchFields: ["watchCandidates", "permissionlessRepurchaseRows", "materialLiquidatableRows", "acceptedValueDivergentRows"], researchFields: ["marketRows", "oracleRows", "sampledSubaccounts", "singleSourceOracleRows", "localArtifactRows"], liquidityFields: ["bnbTvlUsd", "totalReserveUsd", "totalDebtUsd", "totalIbCollateralUsd"], edgeFields: ["maxAcceptedValueDivergenceBps", "maxOraclePublicDivergenceBps", "bestEdgeBps"], closedStatus: "alpaca-finance-2-phase0-no-route-positive-bounded", watchStatus: "alpaca-watch-needs-repurchase-liquidation-or-accepted-value-economics", sourceArtifacts: ["reports/raw/fast/alpaca-finance-2-phase0.json"], blockers: ["LiquidationFacet.liquidationCall is liquidator-whitelist gated; public route requires a whitelisted caller or the permissionless repurchase path", "Bounded event-window sampling found no material subaccount that is currently repurchasable or liquidatable", "No material market has current accepted oracle/public price divergence above threshold with usable borrow or unwind economics", "No Alpaca-specific ib/debt/diamond address joined to a material external trusted-consumer route in local artifacts", "Config provenance used a public GitHub mirror because the original upstream config URL returned 404", "No exact repay, repurchase/liquidation, seized-collateral exit, gas, slippage, and fee-positive route was proven", "No fork extraction proof"], requiredForRoutePositive: ["specific Alpaca subaccount is currently repurchasable or otherwise liquidatable through a permissionless path", "repay, repurchase, or liquidation action is not blocked by whitelists, account-manager-only checks, pause state, or role gates", "collateral acquisition or seized-collateral exit is exact-quoted positive after repurchase/liquidation fees, gas, and slippage", "oracle or accepted-value divergence is current, material, and maps to borrow cash or liquidation economics", "fork/static proof before any live or signed action"], nextReadOnlyStep: "Keep Alpaca Finance 2.0 on borrower-log, oracle-source, and ib/debt-token consumer watch; exact-quote/fork only if a material subaccount becomes permissionlessly repurchasable/liquidatable or an accepted-value divergence maps to usable borrow cash and positive exit liquidity." },
  { key: "gravityByGalxePhase0", id: "gravity-by-galxe-phase0-sweep", protocol: "Gravity by Galxe", chain: "Ethereum; Gravity L1 public RPC", surface: "Gravity L1 Native Bridge and legacy Alpha bridge G custody, proof/callback binding, and consumer-join Phase 0", baseScore: 41, routePositiveFields: ["routePositive", "executableNow"], watchFields: ["watchCandidates", "bridgeSpecificJoinRows"], researchFields: ["contractsWithCode", "tokensLockedLogs", "portalMessagesFromGBridgeSender", "nativeOracleLatestNonce", "bridgeSpecificJoinRows"], liquidityFields: ["defillamaCurrentTvlUsd", "legacyBridgeCustodyUsd", "gBridgeSenderBalanceUsd", "totalTrackedCustodyUsd", "topDexLiquidityUsd"], edgeFields: ["materialCustodyDeltaRows", "materialLegacyCustodyRows", "logErrors"], closedStatus: "gravity-by-galxe-phase0-no-route-positive-bounded", watchStatus: "gravity-watch-needs-proof-bypass-legacy-custody-or-consumer-economics", sourceArtifacts: ["reports/raw/fast/gravity-by-galxe-phase0.json"], blockers: ["Current L1 bridge is one-way Ethereum G lock to Gravity native mint; no permissionless Ethereum unlock/release path exists in this design", "Legacy Alpha bridge custody explains the public DeFiLlama TVL context and is treated as legacy/deprecating custody, not proof of a current extraction path", "GravityPortal binds msg.sender plus nonce into emitted payloads and NativeOracle reports synced sequential nonce state for Ethereum messages", "Receiver trustedBridge/trustedSourceId match GBridgeSender and Ethereum in the public Gravity L1 read-only state", "No bridge-specific trusted consumer join, proof/domain/nonce/token binding bypass, exact backing deficit, mint/unlock, borrow, redeem, liquidation, or DEX unwind route is exact-positive", "No fork extraction proof"], requiredForRoutePositive: ["deployed Gravity proof/domain/nonce/token/finality binding flaw permits mint/unlock without a corresponding locked event", "current or legacy G custody diverges materially from minted/backing state with a permissionless path to extract value", "exact G or a bridge receipt is accepted by a material trusted consumer with attacker-favorable accepted value", "acquisition, mint/unlock/borrow/redeem/liquidate, and G/borrowed-asset exit route are exact-quoted positive after fees, gas, and slippage", "fork/static proof before any live or signed action"], nextReadOnlyStep: "Keep Gravity closed unless a proof-binding flaw, legacy bridge reachability issue, or exact G consumer route maps to current positive economics." },
  { key: "csigmaFinancePhase0", id: "csigma-finance-phase0-sweep", protocol: "cSigma Finance", chain: "Ethereum/Arbitrum/Base; Hedera context", surface: "cSigma institutional factories, Edge pools, PDN logs, csUSD/csLYD vaults, and consumer-join Phase 0", baseScore: 41, routePositiveFields: ["routePositive", "executableNow"], watchFields: ["watchCandidates", "directConsumerRows"], researchFields: ["institutionalPaymentsScanned", "edgePoolEvents", "pdnLogsDecoded", "localArtifactRows"], liquidityFields: ["defillamaCurrentTvlUsd", "institutionalNetInvestmentUsd", "pdnNetInvestmentUsd", "edgeTotalAssetsUsd", "vaultBalanceUsd"], edgeFields: ["directConsumerRows", "materialEdgeRows", "materialVaultRows", "logErrors"], closedStatus: "csigma-finance-phase0-no-route-positive-bounded", watchStatus: "csigma-watch-needs-consumer-borrower-or-redemption-economics", sourceArtifacts: ["reports/raw/fast/csigma-finance-phase0.json"], blockers: ["Hedera adapter deployment is context-only in this EVM pass and is not closed route-negative", "Institutional/Edge/PDN accounting maps TVL and pool context but no public borrower/account-health or liquidation endpoint was resolved", "Only common stablecoin context joins appeared in local artifacts; no cSigma-specific pool, vault, factory, or token joined to material trusted-consumer economics", "csUSD/csLYD vault balances and Edge pool rows did not expose exact-positive borrow, redemption, liquidation, or unwind economics", "No fork extraction proof"], requiredForRoutePositive: ["specific cSigma pool, vault, or pool token is accepted by a material trusted consumer or exposes a permissionless accounting/redemption/borrow/liquidation path", "accepted value diverges from executable acquisition/redemption/DEX reference value or a borrower/liquidation row becomes exact-positive", "route is permissionless and unblocked with exact positive economics after gas, slippage, fees, and exit liquidity", "fork/static proof before any live or signed action"], nextReadOnlyStep: "Keep cSigma closed unless a cSigma pool/vault token gains a material trusted consumer, a public borrower/liquidation endpoint appears, or accepted-value/redemption/DEX divergence maps to exact-positive economics; otherwise continue to Alpaca Finance 2.0." },
  { key: "inverseFinanceFirmPhase0", id: "inverse-finance-firm-phase0-sweep", protocol: "Inverse Finance FiRM", chain: "Ethereum", surface: "FiRM market/oracle/borrower/liquidation/replenishment Phase 0", baseScore: 42, routePositiveFields: ["routePositive", "executableNow"], watchFields: ["watchCandidates"], researchFields: ["marketsDiscovered", "activeDbrMarkets", "sampledPositions", "materialSampledDebtRows", "localArtifactRows"], liquidityFields: ["defillamaCurrentTvlUsd", "totalDebtUsd", "totalDolaCashUsd"], edgeFields: ["nearLiquidationRows", "materialLiquidatableRows", "oracleDivergentRows", "staleFeedRows", "keeperRewardRows"], closedStatus: "inverse-finance-firm-phase0-no-route-positive-bounded", watchStatus: "firm-watch-needs-liquidatable-borrower-or-stale-oracle-economics", sourceArtifacts: ["reports/raw/fast/inverse-finance-firm-phase0.json"], blockers: ["Borrower/account coverage is bounded to recent on-chain event sampling and public aggregate context, not full historical per-account enumeration", "No sampled material borrower was below credit limit with exact positive repay/seize/unwind economics", "High-CF and single-source Chainlink rows are configuration context only without current stale/divergent accepted value plus exact borrow/liquidation economics", "Forced replenishment is an intended keeper flow and not treated as exploit route-positive without separate exact economics and authorization gates", "No fork extraction proof"], requiredForRoutePositive: ["specific FiRM market accepts attacker-favorable stale, divergent, or under-bound oracle/accounting value, or a material borrower is currently liquidatable", "borrow, liquidation, or replenishment path is permissionless and unblocked in current live state", "DOLA acquisition/repay and seized collateral or keeper reward unwind are exact-quoted positive after gas, slippage, and fees", "fork/static proof before any live or signed action"], nextReadOnlyStep: "Keep FiRM on oracle/feed staleness, high-CF borrow cash, borrower liquidation, and DBR-deficit keeper watch; exact-quote/fork only if a material row becomes route-positive, otherwise proceed to cSigma Finance." },
  { key: "bituProtocolPhase0", id: "bitu-protocol-phase0-sweep", protocol: "BitU Protocol", chain: "BNB Chain", surface: "BitU minting, collateral/oracle, sBITU staking, custody, and bounded borrower/liquidation Phase 0", baseScore: 41, routePositiveFields: ["routePositive", "executableNow"], watchFields: ["watchCandidates"], researchFields: ["contractsScanned", "supportedMarketRows", "sampledActivePositions", "materialSampledPositions", "localArtifactRows"], liquidityFields: ["defillamaCurrentTvlUsd", "materialCustodyBalanceUsd", "topBituDexLiquidityUsd", "topSbituDexLiquidityUsd"], edgeFields: ["oracleDivergentRows", "nearLiquidationRows", "materialLiquidatableRows", "sbituShareAssetsVsPegBps"], closedStatus: "bitu-protocol-phase0-no-route-positive-bounded", watchStatus: "bitu-watch-needs-public-liquidator-or-sbitu-exit-economics", sourceArtifacts: ["reports/raw/fast/bitu-protocol-phase0.json"], blockers: ["Minting is whitelist/role gated and not a permissionless borrow surface in current docs/app/on-chain config", "DefiLlama BitU subgraph endpoint was unavailable; borrower coverage is bounded to app/docs constants and recent event-window sampling", "No recent active position sample, material liquidatable borrower, or exact repay/seize/exit economics was found", "sBITU has a positive share price versus BITU but redemption is cooldown-gated and no BITU/sBITU DEX exit route was proven", "No material oracle/reference divergence, trusted consumer join, or exact-positive DEX unwind economics", "No fork extraction proof"], requiredForRoutePositive: ["specific BitU borrower/account has material liquidatable debt in fresh live state", "liquidate or equivalent state-changing path is permissionless or economically accessible", "repay/acquire, seize/redeem, and DEX/USDT/BTCB unwind route is exact-quoted positive after costs", "mint/redeem or sBITU share-price edge clears whitelist, cooldown, cap, and exit-liquidity constraints", "fork extraction proof"], nextReadOnlyStep: "Keep BitU closed for the declared bounded scope unless a public-liquidator path, fresh material liquidatable borrower, or BITU/sBITU accepted-value divergence maps to exact-positive economics; otherwise proceed to Inverse Finance FiRM." },
  { key: "templarProtocolPhase0", id: "templar-protocol-phase0-sweep", protocol: "Templar Protocol", chain: "Ethereum-attributed assets; NEAR live market state blocked", surface: "Templar DefiLlama adapter/source, EVM-origin asset attribution, local artifact context, and NEAR market-state blocker Phase 0", baseScore: 41, routePositiveFields: ["routePositive", "executableNow"], watchFields: ["watchCandidates"], researchFields: ["registryContracts", "nearRegistryRows", "localArtifactRows", "blockedScopeRows"], liquidityFields: ["defillamaCurrentTvlUsd", "ethereumAttributedTvlUsd", "totalBorrowedUsd"], edgeFields: ["oracleRiskScore"], closedStatus: "templar-protocol-no-evm-route-positive-near-scope-blocked", watchStatus: "templar-watch-needs-near-market-state-and-exact-economics", sourceArtifacts: ["reports/raw/fast/templar-protocol-phase0.json"], blockers: ["DefiLlama Templar adapter enumerates NEAR market contracts and attributes assets back to origin chains; no Ethereum lending deployment was resolved", "NEAR list_deployments, market snapshots, borrower state, Pyth freshness, and liquidation economics are blocked by missing sanitized NEAR endpoint/preset and are not closed route-negative", "No exact Templar-controlled EVM contract, token, custody, oracle, or lending consumer route was resolved", "Pyth single-source context is a NEAR-market risk signal only until live market state and exit routes are enumerated", "No fork/local extraction proof"], requiredForRoutePositive: ["sanitized NEAR endpoint/preset or equivalent public market-state artifact enumerates Templar deployments and market snapshots", "specific Templar market has live borrow cash, collateral, borrower/liquidation state, and Pyth/oracle data with attacker-favorable stale or divergent value", "affected collateral/borrow asset maps to permissionless EVM or cross-chain acquisition and exit liquidity with exact-positive economics", "no role, queue, intent, bridge-finality, or cross-chain settlement blocker prevents the route", "fork/local extraction proof"], nextReadOnlyStep: "Keep Templar closed only for declared EVM metadata scope; add a sanitized NEAR endpoint/preset and enumerate NEAR market deployments before claiming route-negative coverage for live Templar lending." },
  { key: "hastraPhase0", id: "hastra-phase0-sweep", protocol: "Hastra", chain: "Ethereum; Solana context unsupported", surface: "Hastra wYLDS/PRIME RWA/NAV tokens, Morpho/Pendle consumer joins, adapter accounting, and DEX exit-liquidity Phase 0", baseScore: 43, routePositiveFields: ["routePositive", "executableNow"], watchFields: ["watchCandidates"], researchFields: ["consumerMatches", "reviewCandidates", "localArtifactRows", "dexLiquidityRows"], liquidityFields: ["defillamaCurrentTvlUsd", "ethereumTvlUsd", "primeMaxGraphLiquidityUsd", "topDexLiquidityUsd"], edgeFields: ["primeMaxPendleLiquidityUsd"], closedStatus: "hastra-phase0-no-route-positive", watchStatus: "hastra-watch-needs-prime-nav-or-exit-economics", sourceArtifacts: ["reports/raw/fast/hastra-phase0.json", "reports/raw/fast/hastra-phase0-rwa-nav-consumer-graph.json"], blockers: ["Hastra TVL is adapter accounting context from vaulted wYLDS plus redemption-vault USDC, not proof of a permissionless extraction path", "PRIME joins Morpho/Pendle and has public DEX liquidity, but no current NAV/reference anomaly or accepted-value edge above route threshold was resolved", "Morpho source artifacts classify PRIME rows route-negative due negative exact acquisition/stress economics or zero allocator flow caps", "Pendle PRIME PT/YT rows lack consumer-specific positive economics", "Solana Hastra accounts are outside current EVM Phase 0 and are not closed route-negative", "No fork extraction proof"], requiredForRoutePositive: ["exact wYLDS, PRIME, PT-PRIME, YT-PRIME, or another Hastra receipt token accepted by a material consumer with usable live liquidity", "current NAV/oracle/accepted value exceeds exact acquisition or redemption/DEX value after LTV/LLTV haircuts and costs", "borrow, redemption, liquidation, or DEX/Pendle exit liquidity is live, permissionless, and exact-quoted positive after gas/slippage/fees", "transfer/redemption path for the exact token and size is not role-gated, queued, or delayed beyond the route model", "fork extraction proof"], nextReadOnlyStep: "Keep Hastra closed unless PRIME/wYLDS gains a current NAV, oracle, accepted-value, Morpho/Pendle, DEX, redemption, or Solana-consumer edge with exact-positive economics." },
  { key: "kasuPhase0", id: "kasu-phase0-sweep", protocol: "Kasu", chain: "Base; XDC/Plume unsupported", surface: "Kasu Base pool accounting, external TVL, selector hints, exact consumer joins, and DEX exit-liquidity Phase 0", baseScore: 39, routePositiveFields: ["routePositive", "executableNow"], watchFields: ["watchCandidates"], researchFields: ["poolsDiscovered", "materialPoolRows", "loanLikeRows", "localArtifactRows", "dexLiquidityRows"], liquidityFields: ["defillamaCurrentTvlUsd", "baseTvlUsd", "totalPoolTvlUsd", "totalExternalTvlUsd", "topDexLiquidityUsd"], edgeFields: ["poolsWithBorrowSelectorHints", "poolsWithLiquidationSelectorHints"], closedStatus: "kasu-phase0-no-route-positive", watchStatus: "kasu-watch-needs-borrower-consumer-or-exit-economics", sourceArtifacts: ["reports/raw/fast/kasu-phase0.json"], blockers: ["Kasu Base TVL is pool and external-management accounting context, not proof of a permissionless extraction path", "No exact Kasu pool-token or external-contract join in local consumer artifacts mapped to route-positive economics", "No public DEX exit liquidity was proven for Kasu pool tokens", "No decoded borrower/account-health or liquidation-profit route with exact repay/acquire/collateral-exit economics was resolved", "XDC and Plume Mainnet are outside current sanitized RPC support and are not closed route-negative", "No fork extraction proof"], requiredForRoutePositive: ["specific Kasu pool or borrower state exposes a permissionless borrow, liquidation, redemption, or withdrawal path", "account health, oracle/accepted value, or pool accounting is attacker-favorable in current live state", "acquisition, repay/borrow/redeem/liquidate action, and exit/unwind liquidity are exact-quoted positive after fees, gas, and slippage", "unsupported XDC/Plume scope is resolved with sanitized RPC endpoints before route-negative closure", "fork extraction proof"], nextReadOnlyStep: "Keep Kasu closed unless a material borrower/account-health source, accepted-value/oracle divergence, pool-token consumer, public liquidation path, or DEX/redemption exit appears with exact-positive economics." },
  { key: "republicNotePhase0", id: "republic-note-phase0-sweep", protocol: "Republic Note", chain: "Avalanche", surface: "Republic Note NOTE RWA/NAV token, consumer graph, adapter accounting, and DEX exit-liquidity Phase 0", baseScore: 41, routePositiveFields: ["routePositive", "executableNow"], watchFields: ["watchCandidates"], researchFields: ["tokenRows", "consumerMatches", "localArtifactRows", "dexLiquidityRows", "reviewCandidates"], liquidityFields: ["defillamaCurrentTvlUsd", "avalancheTvlUsd", "noteContractBalanceUsd", "topDexLiquidityUsd"], edgeFields: ["graphWatchCandidates"], closedStatus: "republic-note-phase0-no-route-positive", watchStatus: "republic-note-watch-needs-note-consumer-or-exit-economics", sourceArtifacts: ["reports/raw/fast/republic-note-phase0.json", "reports/raw/fast/republic-note-phase0-rwa-nav-consumer-graph.json"], blockers: ["The public adapter values NOTE using contractBalanceOf and a public token price, not a permissionless NAV or redemption route", "No exact NOTE lending/oracle consumer match was found on Avalanche", "No public DEX pair rows were returned for exact NOTE, so no same-block acquisition or exit route is proven", "Republic Note issuance/redemption/transferability remains treated as permissioned or restricted absent public atomic exit proof", "No fork extraction proof"], requiredForRoutePositive: ["Exact NOTE accepted by a material lending, margin, redemption, PT/vault, or liquidation consumer", "Current accepted value, oracle value, NAV, or redemption value exceeds exact acquisition/exit value after LTV/LLTV haircut and costs", "Permissionless acquisition plus borrow, redemption, liquidation, or DEX exit liquidity is live and exact-quoted positive", "Transfer/redemption path for the exact NOTE size is not role-gated, queued, or delayed beyond the route model", "fork extraction proof"], nextReadOnlyStep: "Keep Republic Note closed unless NOTE gains a material trusted consumer, a public DEX or permissionless redemption exit appears, or a current accepted-value/NAV/oracle divergence maps to exact-positive economics." },
  { key: "resupplyPhase0", id: "resupply-phase0-sweep", protocol: "Resupply", chain: "Ethereum", surface: "Resupply pair registry, reUSD/sreUSD, Curve LlamaLend, and Curve DEX Phase 0", baseScore: 42, routePositiveFields: ["routePositive", "executableNow"], watchFields: ["watchCandidates"], researchFields: ["pairsDiscovered", "materialDebtPairs", "curveLlamalendRows", "curveDexRows"], liquidityFields: ["defillamaCurrentTvlUsd", "totalBorrowUsd", "totalCollateralAssetUsd", "topDexLiquidityUsd"], edgeFields: ["directWatchCandidates", "curveLlamalendGrossPositiveRows", "staleExternalTriggerRows"], closedStatus: "resupply-phase0-no-route-positive", watchStatus: "resupply-watch-needs-fresh-borrower-or-accepted-value-economics", sourceArtifacts: ["reports/raw/fast/resupply-phase0.json", "reports/raw/fast/curve-llamalend-phase0.json", "reports/raw/fast/curve-dex-phase0.json"], blockers: ["Resupply pair rows are high-LTV debt/collateral context, but pair-level utilization is not borrower-level liquidation proof", "Fresh Curve LlamaLend sreUSD sampling has zero material liquidatable/gross-positive rows for this market", "Older Curve stablecoin sreUSD liquidatable flags are stale and require fresh proof before use", "Curve DEX reUSD liquidity is exit context only without a current accepted-value, oracle, redemption, or liquidation edge", "No exact positive borrow, liquidation, redemption, or unwind economics and no fork extraction proof"], requiredForRoutePositive: ["specific Resupply pair or sreUSD consumer has a current liquidatable borrower or accepted-value divergence", "collateral acquisition, borrow/repay, liquidation/redeem, and exit route are exact-quoted after fees, gas, and slippage", "borrower/account state is fresh and not stale-artifact-only", "fork extraction proof"], nextReadOnlyStep: "Keep Resupply on pair-level high-LTV, sreUSD LlamaLend, and reUSD Curve DEX watch; exact-quote/fork only if fresh borrower-level liquidation or accepted-value divergence becomes route-positive." },
  { key: "firaPhase0", id: "fira-phase0-sweep", protocol: "Fira", chain: "Ethereum", surface: "Fira lending market/oracle/liquidation Phase 0", baseScore: 42, routePositiveFields: ["routePositive", "executableNow"], watchFields: ["watchCandidates", "materialSampledLiquidatableBorrowers"], researchFields: ["marketRows", "marketsDiscoveredFromLogs", "acceptedValueDivergentRows", "sampledBorrowers"], liquidityFields: ["defillamaBorrowedUsd", "totalBorrowUsd", "totalCashUsd"], edgeFields: ["acceptedValueDivergentRows", "borrowRouteGrossPositiveRows", "nearLiquidationRows"], closedStatus: "fira-phase0-no-route-positive", watchStatus: "fira-watch-needs-dog-liquidity-or-uzr-borrower-economics", sourceArtifacts: ["reports/raw/fast/fira-phase0.json"], blockers: ["Legacy UZR bUSD0 accepted-value divergence is negative after the 88% LTV haircut versus public reference pricing", "Royal Dog/DOG has extreme accepted-value divergence but zero supplied/borrowable assets in market(bytes32)", "Bounded anonymized borrower sampling found no material liquidatable row", "No exact positive borrow, liquidation, redemption, or unwind economics and no fork extraction proof"], requiredForRoutePositive: ["specific Fira market accepts attacker-favorable stale, divergent, or under-bound oracle/accounting value", "borrowable supply or liquidatable borrower state is current and material", "collateral acquisition or liquidation repay path is permissionless and exact-quoted", "borrowed or seized asset exit is positive after LTV/LLTV haircut, gas, slippage, and fees", "fork extraction proof"], nextReadOnlyStep: "Keep Fira on UZR accepted-value, DOG zero-liquidity market, and borrower-liquidation watch; exact-quote/fork only if DOG gains borrowable supply, bUSD0 acquisition cheapens enough to overcome the 88% LTV haircut, or a material borrower becomes liquidatable." },
  { key: "wisdomTreePhase0", id: "wisdomtree-phase0-sweep", protocol: "WisdomTree", chain: "Ethereum; Stellar context", surface: "WisdomTree WTGXX RWA/NAV token, generic consumer graph, nWISDOM context, and DEX exit-liquidity Phase 0", baseScore: 41, routePositiveFields: ["routePositive", "executableNow"], watchFields: ["watchCandidates"], researchFields: ["tokenRows", "consumerMatches", "localArtifactRows", "nWisdomPositiveBalanceRows"], liquidityFields: ["defillamaCurrentTvlUsd", "ethereumTvlUsd", "wtgxxSupplyUsdAtNav", "topDexLiquidityUsd"], edgeFields: ["navVsPriceBps", "graphWatchCandidates"], closedStatus: "wisdomtree-phase0-no-route-positive", watchStatus: "wisdomtree-watch-needs-wtgxx-consumer-or-exit-economics", sourceArtifacts: ["reports/raw/fast/wisdomtree-phase0.json", "reports/raw/fast/wisdomtree-phase0-rwa-nav-consumer-graph.json"], blockers: ["WTGXX has no public DEX acquisition or exit liquidity in this pass", "No generic RWA/NAV lending/oracle consumer match for exact WTGXX was found on Ethereum", "nWISDOM appears only as Nest context with tiny stablecoin balances and no consumer-grade join in the source Nest artifact", "WisdomTree RWA issuance/redemption and transferability remain treated as permissioned or non-atomic absent public same-block exit proof", "Stellar WisdomTree assets are non-EVM context for this pass", "No fork extraction proof"], requiredForRoutePositive: ["WTGXX or nWISDOM accepted by a material lending, margin, redemption, or liquidation consumer", "current NAV/oracle/accepted-value divergence favorable after LTV/LLTV haircut and costs", "borrow, redemption, liquidation, or DEX exit liquidity is live and exact-quoted positive", "permissionless transfer/redemption path for the exact token and size", "fork extraction proof"], nextReadOnlyStep: "Keep WisdomTree closed unless WTGXX/nWISDOM gains a material consumer, public exit, or accepted-value divergence with exact-positive economics." },
  { key: "openTradePhase0", id: "opentrade-phase0-sweep", protocol: "OpenTrade", chain: "Avalanche/Ethereum; Plume blocked", surface: "OpenTrade factory-discovered RWA/NAV pool shares, liquidityAssetAddr NAV, consumer graph, and pool-share DEX exit Phase 0", baseScore: 41, routePositiveFields: ["routePositive", "executableNow"], watchFields: ["watchCandidates"], researchFields: ["poolsDiscovered", "materialPoolRows", "consumerMatches", "localArtifactRows", "failedLogRanges"], liquidityFields: ["defillamaCurrentTvlUsd", "mappedPoolAssetsUsd", "topPoolShareDexLiquidityUsd", "plumeMainnetTvlUsd"], edgeFields: ["graphWatchCandidates"], closedStatus: "opentrade-phase0-no-route-positive-on-supported-chains", watchStatus: "opentrade-watch-needs-pool-share-consumer-or-exit-economics", sourceArtifacts: ["reports/raw/fast/opentrade-phase0.json", "reports/raw/fast/opentrade-phase0-rwa-nav-consumer-graph.json"], blockers: ["OpenTrade pool shares have no exact-positive public acquisition or exit route in this pass", "Factory-discovered pool NAV is underlying-asset accounting context, not extractive impact without a trusted consumer and exit path", "Generic RWA/NAV consumer joins found no OpenTrade pool-share consumer matches on Avalanche or Ethereum", "RWA/private-credit mint, redeem, and withdrawal flows remain treated as permissioned or non-atomic unless public same-block execution is proven", "Plume Mainnet coverage is blocked by missing local RPC/chain preset and is not closed route-negative", "No fork extraction proof"], requiredForRoutePositive: ["exact OpenTrade pool share accepted by a material lending, margin, redemption, or liquidation consumer", "current accepted value materially above executable acquisition cost after LTV/LLTV haircut and costs", "borrow, redemption, liquidation, or DEX exit liquidity is live and exact-quoted positive", "permissionless transfer/redemption path for the exact pool share and size", "fork extraction proof"], nextReadOnlyStep: "Keep OpenTrade closed on Avalanche/Ethereum unless a pool-share consumer, public exit, or accepted-value divergence becomes exact-positive; retest Plume after a sanitized RPC/chain preset is provided." },
  { key: "e12xRoutes", id: "e12x-morpho-new-market-sweep", protocol: "Morpho Blue", chain: "multi-chain", surface: "Morpho new-market stale-oracle dry-run routes", baseScore: 40, routePositiveFields: ["routePositive", "positiveCount"], researchFields: ["candidateCount"], closedStatus: "dormant-no-route-positive", sourceArtifacts: ["reports/raw/fast/e12x-route-dry-runs.json"], blockers: ["No route-positive dry runs", "Non-Ethereum candidates remain non-executable without deployment and verifier gates"] },
  { key: "e2QuoteVault", id: "e2-quotevault-sweep", protocol: "Morpho Blue", chain: "multi-chain", surface: "Morpho quoteVault oracle borrower scan", baseScore: 24, researchFields: ["candidateCount"], closedStatus: "dormant-zero-candidates", sourceArtifacts: ["reports/raw/fast/e2-quotevault-candidates.json"], blockers: ["No live targets with borrowers in current artifact", "Needs borrower/route/fork ranking if candidates appear"] },
  { key: "currentProfitTriage", id: "current-profit-public-leads-sweep", protocol: "Public growth leads", chain: "multi-chain", surface: "Public high-APY/growth token route triage", baseScore: 28, sourceArtifacts: ["reports/raw/fast/current-profit-lead-triage.json"], blockers: ["No current positive NAV/market route", "No fork-positive extraction proof"] },
  { key: "publicLeadCompoundLikeRoutes", id: "public-lead-compound-like-sweep", protocol: "Public Compound-like leads", chain: "Ethereum", surface: "High-APY public Compound-like lead route filter", baseScore: 30, watchFields: ["watchCandidates"], researchFields: ["compoundLikeRows"], quoteFields: ["rowsWithDexLiquidity", "rowsWithRedeemCash"], edgeFields: ["materialNavDivergenceRows", "bestAbsNavDivergencePct"], liquidityFields: ["bestRedeemCashUsd"], closedStatus: "compound-like-public-leads-no-route", watchStatus: "compound-like-watch-needs-liquidity-cash-divergence", sourceArtifacts: ["reports/raw/fast/public-lead-compound-like-routes.json", "reports/raw/fast/current-profit-lead-triage.json"], blockers: ["No public Compound-like lead has cToken liquidity, redeem cash, and material NAV/market divergence simultaneously", "No exact redeem/DEX route or fork proof"], requiredForRoutePositive: ["cToken/share acquisition has material DEX liquidity", "market has material same-block redeem cash", "NAV/market divergence clears costs", "fork extraction proof"], nextReadOnlyStep: "Keep high-APY Compound-like public leads closed unless liquidity, redeem cash, and NAV divergence become positive together." },
  { key: "publicLeadConsumerJoins", id: "public-lead-consumer-join-sweep", protocol: "Public lead token joins", chain: "multi-chain", surface: "Public high-APY lead token to consumer graph joins", baseScore: 31, watchFields: ["watchCandidates"], researchFields: ["joinedRows", "leadTokensConsidered"], liquidityFields: ["maxContextLiquidityUsd"], closedStatus: "public-lead-consumer-joins-no-route", watchStatus: "public-lead-consumer-watch-needs-exact-economics", sourceArtifacts: ["reports/raw/fast/public-lead-consumer-joins.json", "reports/raw/fast/current-profit-lead-triage.json"], blockers: ["Existing consumer artifacts do not show route-positive economics for joined public lead tokens", "No exact acquisition/borrow/redeem/unwind route or fork proof"], requiredForRoutePositive: ["public lead token joins a material lending/redeem/liquidation consumer", "accepted value diverges from exact acquisition/unwind value", "borrow/redeem/exit economics are positive after costs", "fork extraction proof"], nextReadOnlyStep: "Refresh consumer joins after new public leads or when joined rows gain exact positive economics." },
  { key: "centrifugeNavConsumerGraph", id: "centrifuge-nav-consumer-graph-sweep", protocol: "Centrifuge Protocol", chain: "Ethereum/Base/Arbitrum", surface: "Centrifuge RWA share-class NAV producer inventory and lending/oracle consumer graph", baseScore: 40, watchFields: ["watchCandidates"], researchFields: ["matches", "producersDiscovered", "producersWithVaults", "reviewCandidates"], liquidityFields: ["totalNavUsd"], edgeFields: ["producerAnomalies"], closedStatus: "centrifuge-nav-consumer-graph-no-route-positive", watchStatus: "centrifuge-watch-needs-nav-consumer-economics", sourceArtifacts: ["reports/raw/fast/centrifuge-nav-consumer-graph.json"], blockers: ["Current Centrifuge producer NAV/reference anomalies are below route threshold or zero-supply artifacts", "Morpho consumer matches have zero or dust borrow-side liquidity", "Issuance/redemption remains treated as permissioned or non-atomic absent public same-block exit proof", "No exact positive borrow, liquidation, redemption, or unwind economics", "No fork extraction proof"], requiredForRoutePositive: ["Exact Centrifuge share-class token accepted by a material lending, margin, redemption, or liquidation consumer", "Current NAV/oracle/reference divergence or liquidatable borrower condition favorable after LTV/LLTV haircut", "Borrow, redemption, liquidation, or DEX exit liquidity is live and exact-quoted positive after costs", "fork extraction proof"], nextReadOnlyStep: "Keep Centrifuge on RWA/NAV and Morpho collateral watch; exact-quote/fork only if material borrow liquidity appears with current NAV/oracle divergence or a liquidatable borrower." },
  { key: "anemoyCapitalPhase0", id: "anemoy-capital-phase0-sweep", protocol: "Anemoy Capital", chain: "Ethereum/Base/Celo", surface: "Anemoy RWA/NAV producer inventory, Morpho consumer joins, and local artifact Phase 0", baseScore: 40, routePositiveFields: ["routePositive", "executableNow"], watchFields: ["watchCandidates"], researchFields: ["producerRows", "directConsumerRows", "localArtifactRows"], liquidityFields: ["defillamaCurrentTvlUsd", "mappedProducerNavUsd", "maxConsumerLiquidityUsd"], edgeFields: ["maxAbsNavDivergenceBps"], closedStatus: "anemoy-capital-phase0-no-route-positive", watchStatus: "anemoy-capital-watch-needs-nav-consumer-economics", sourceArtifacts: ["reports/raw/fast/anemoy-capital-phase0.json", "reports/raw/fast/centrifuge-nav-consumer-graph.json"], blockers: ["Anemoy/JTRSY/JAAA producer NAV/reference deltas are below the route threshold or not joined to usable liquidity", "Matched Morpho markets have zero or dust borrow-side liquidity", "Local Euler/Morpho/3F/Pareto/Nest symbol hits are context-only and already route-negative in source artifacts", "RWA issuance/redemption/transferability remains treated as permissioned or non-atomic absent public same-block exit proof", "No exact positive borrow, liquidation, redemption, or DEX unwind economics and no fork extraction proof"], requiredForRoutePositive: ["exact Anemoy token or wrapper accepted by a material lending, margin, redemption, or liquidation consumer", "current NAV/oracle/reference divergence or liquidatable borrower condition favorable after LTV/LLTV haircut", "borrow, redemption, liquidation, or DEX exit liquidity is live and exact-quoted positive after costs", "permissionless transfer/redemption path for the exact token and size", "fork extraction proof"], nextReadOnlyStep: "Keep Anemoy closed unless a material consumer row gains liquidity plus current NAV/oracle divergence, a liquidatable borrower appears, or permissionless redemption/DEX exit becomes exact-positive." },
  { key: "reservoirPhase0", id: "reservoir-deep-sweep", protocol: "Reservoir Protocol", chain: "Ethereum", surface: "rUSD/srUSD/wsrUSD PSM, Credit Enforcer adapter, DEX premium, and local consumer joins", baseScore: 39, watchFields: ["watchCandidates"], researchFields: ["localArtifactJoinRows", "assetAdapterRows", "reviewCandidates"], liquidityFields: ["psmBackingUsd", "rUsdTopLiquidityUsd", "rUsdSupplyUsd"], edgeFields: ["rUsdPremiumBps"], closedStatus: "reservoir-phase0-no-route-positive", watchStatus: "reservoir-watch-needs-adapter-or-premium-economics", sourceArtifacts: ["reports/raw/fast/reservoir-phase0.json"], blockers: ["No active Credit Enforcer vault/asset adapter row was resolved by bounded probes", "rUSD is not premium-priced versus peg in the top DEX row", "PSM mint/redeem and DEX unwind are not exact-quoted positive", "No fork extraction proof"], requiredForRoutePositive: ["Credit Enforcer has an active asset/vault adapter with public mint/borrow/redeem path and material liquidity", "rUSD/srUSD/wsrUSD accepted value, PSM mint/redeem value, or DEX market value diverges favorably after fees and slippage", "DEX/PSM route is exact-quoted with staticCall/estimateGas and positive net economics", "fork extraction proof"], nextReadOnlyStep: "Keep Reservoir on adapter-list and rUSD premium watch; exact-quote/fork only if an active adapter appears or rUSD/srUSD/wsrUSD market value becomes favorable with material liquidity." },
  { key: "blackrockBuidlPhase0", id: "blackrock-buidl-phase0-sweep", protocol: "BlackRock BUIDL", chain: "Ethereum/Avalanche/Arbitrum/Optimism/BNB/Polygon context", surface: "RWA/NAV BUIDL and sBUIDL token, consumer graph, and local artifact Phase 0", baseScore: 38, watchFields: ["watchCandidates"], researchFields: ["tokenRows", "matches", "localArtifactRows", "eulerBuidlRows", "siloBuidlRows", "fraxBuidlRows", "reviewCandidates"], liquidityFields: ["defillamaCurrentTvlUsd", "topDexLiquidityUsd"], edgeFields: ["producerAnomalies"], closedStatus: "blackrock-buidl-phase0-no-route-positive", watchStatus: "blackrock-buidl-watch-needs-nav-consumer-economics", sourceArtifacts: ["reports/raw/fast/blackrock-buidl-phase0.json"], blockers: ["BUIDL issuance/redemption/custody remains treated as permissioned/restricted absent public atomic exit proof", "No ERC4626 NAV interface or current NAV/reference divergence above threshold was resolved for exact BUIDL token rows", "Euler, Silo, Frax, Morpho, and DEX rows are context-only or blocked by zero liquidity/borrows, missing exact acquisition/exit economics, or permission constraints", "No public DEX, borrow, redemption, liquidation, or unwind route is exact-positive", "No fork extraction proof"], requiredForRoutePositive: ["BUIDL or sBUIDL accepted by a material lending, margin, redemption, or liquidation consumer", "permissionless NAV/oracle/backing/accepted-value divergence or current liquidatable borrower condition", "exact acquisition, borrow/repay, redeem/liquidate, and exit economics positive after costs", "fork extraction proof"], nextReadOnlyStep: "Keep BUIDL/sBUIDL on RWA/NAV and Euler/Silo/Frax/Morpho consumer watch; exact-quote/fork only if a material borrower becomes liquidatable, a trusted accepted-value divergence clears the haircut, or permissionless redemption/DEX exit becomes exact-positive." },
  { key: "paxosGoldPhase0", id: "paxos-gold-phase0-sweep", protocol: "Paxos Gold", chain: "Ethereum", surface: "RWA/NAV PAXG token, consumer graph, local Fluid/Euler/PAXG-XAUt joins, and DEX exit-liquidity Phase 0", baseScore: 39, watchFields: ["watchCandidates"], researchFields: ["tokenRows", "matches", "localArtifactRows", "fluidPaxgRows", "eulerPaxgRows", "fluidDexPaxgRows", "reviewCandidates"], liquidityFields: ["defillamaCurrentTvlUsd", "topDexLiquidityUsd"], edgeFields: ["producerAnomalies"], closedStatus: "paxos-gold-phase0-no-route-positive", watchStatus: "paxos-gold-watch-needs-nav-consumer-economics", sourceArtifacts: ["reports/raw/fast/paxos-gold-phase0.json"], blockers: ["PAXG issuance/redemption/custody remains treated as permissioned/restricted absent public atomic exit proof", "No ERC4626 NAV interface or current NAV/reference divergence above threshold was resolved for the exact PAXG token row", "Fluid PAXG, Euler PAXG, PAXG/XAUt, Morpho, and public DEX rows are context-only or blocked by missing exact acquisition/exit economics, no accepted-value divergence, or permission constraints", "No borrow, redemption, liquidation, or unwind route is exact-positive", "No fork extraction proof"], requiredForRoutePositive: ["PAXG accepted by a material lending, margin, redemption, or liquidation consumer", "permissionless NAV/oracle/backing/accepted-value divergence or current liquidatable borrower condition", "exact acquisition, borrow/repay, redeem/liquidate, and exit economics positive after costs", "fork extraction proof"], nextReadOnlyStep: "Keep PAXG on RWA/NAV, Fluid/Euler, Morpho, and PAXG-XAUt consumer watch; exact-quote/fork only if a material borrower becomes liquidatable, accepted-value divergence clears the haircut, or permissionless redemption/DEX exit becomes exact-positive." },
  { key: "rePhase0", id: "re-phase0-sweep", protocol: "Re", chain: "Ethereum/Base/Arbitrum/Avalanche", surface: "RWA/NAV Re custody, redemption, off-chain oracle, token, consumer graph, Pendle/Fluid/Euler/Silo/Curve joins, and DEX exit-liquidity Phase 0", baseScore: 39, watchFields: ["watchCandidates"], researchFields: ["tokenRows", "matches", "localArtifactRows", "ownerRows", "materialCustodyBalanceRows", "fluidReRows", "eulerReRows", "siloReRows", "curveReRows", "pendleReRows", "reviewCandidates"], liquidityFields: ["defillamaCurrentTvlUsd", "trackedCustodyBalanceUsd", "offchainOracleUsd", "topDexLiquidityUsd"], edgeFields: ["producerAnomalies"], closedStatus: "re-phase0-no-route-positive", watchStatus: "re-watch-needs-nav-consumer-economics", sourceArtifacts: ["reports/raw/fast/re-phase0.json", "reports/raw/fast/re-phase0-rwa-nav-consumer-graph.json"], blockers: ["Re issuance, custody, off-chain asset accounting, and redemption remain treated as permissioned/restricted absent public atomic exit proof", "No ERC4626 NAV interface or current NAV/reference divergence above threshold was resolved for exact Re token rows", "Pendle, Fluid, Euler, Silo, Curve, Morpho, and public DEX rows are context-only or source-classified route-negative", "No material borrow, redemption, liquidation, or unwind route is exact-positive", "No fork extraction proof"], requiredForRoutePositive: ["Re token accepted by a material lending, margin, redemption, or liquidation consumer", "permissionless NAV/oracle/backing/accepted-value divergence or current liquidatable borrower condition", "exact acquisition, borrow/repay, redeem/liquidate, and exit economics positive after costs", "fork extraction proof"], nextReadOnlyStep: "Keep Re on RWA/NAV, Pendle PT, Fluid, Euler, Silo, Curve, Morpho, and DEX watch; exact-quote/fork only if a material borrower becomes liquidatable, accepted-value divergence clears the haircut, or permissionless redemption/DEX exit becomes exact-positive." },
  { key: "bifiPhase0", id: "bifi-phase0-sweep", protocol: "BiFi", chain: "Ethereum/BNB/Avalanche", surface: "BiFi adapter pools, generic lending hints, borrow logs, and exact pool-address joins", baseScore: 31, watchFields: ["watchCandidates"], researchFields: ["poolRows", "materialBalanceRows", "borrowLikeRows", "borrowLogRows", "uniqueBorrowersSeen", "localPoolJoinRows"], liquidityFields: ["defillamaCurrentTvlUsd", "trackedPoolBalanceUsd", "borrowLikeUsd"], closedStatus: "bifi-phase0-no-route-positive", watchStatus: "bifi-watch-needs-verified-market-health-and-exact-economics", sourceArtifacts: ["reports/raw/fast/bifi-phase0.json"], blockers: ["Public BiFi adapter is pool-balance based and does not expose decoded account-health/liquidation semantics", "No BiFi-specific oracle divergence, borrow path, liquidation path, or exact positive unwind route was proven", "No exact local pool-address consumer join maps to extractive economics", "Klaytn and Bifrost Network adapter rows are outside current EVM RPC scope", "No fork extraction proof"], requiredForRoutePositive: ["verified BiFi market/account-health source", "permissionless borrow/liquidation trigger with material liquidity", "exact positive borrow/liquidation and unwind economics after costs", "fork extraction proof"], nextReadOnlyStep: "Reopen BiFi only if verified source/ABI or a live account-health endpoint maps these pools to material borrow/liquidation economics; otherwise continue to the next public Phase 0 target." },
  { key: "tetherGoldPhase0", id: "tether-gold-phase0-sweep", protocol: "Tether Gold", chain: "Ethereum/Avalanche/Arbitrum/Celo/Ink/BNB context", surface: "RWA/NAV XAUt token, consumer graph, and local artifact Phase 0", baseScore: 38, watchFields: ["watchCandidates"], researchFields: ["tokenRows", "matches", "localArtifactRows", "fluidXautVaultRows", "compoundXautRows", "eulerXautRows", "aaveV4XautRows", "listaXautRows"], liquidityFields: ["defillamaCurrentTvlUsd", "topDexLiquidityUsd", "fluidXautBorrowableUsd"], edgeFields: ["producerAnomalies"], closedStatus: "tether-gold-phase0-no-route-positive", watchStatus: "tether-gold-watch-needs-nav-consumer-economics", sourceArtifacts: ["reports/raw/fast/tether-gold-phase0.json"], blockers: ["XAUt redemption/custody and transferability remain treated as permissioned/restricted absent public atomic exit proof", "No ERC4626 NAV interface or current NAV/reference divergence above threshold was resolved for exact XAUt rows", "Fluid, Compound, Euler, Aave, Lista, and DEX rows are context-only or blocked by collateral haircuts, low/dust liquidity, non-watch source classification, or missing exact acquisition/exit economics", "No public DEX, borrow, redemption, liquidation, or unwind route is exact-positive", "No fork extraction proof"], requiredForRoutePositive: ["XAUt accepted by a material lending, margin, redemption, or liquidation consumer", "permissionless NAV/oracle/backing/accepted-value divergence or current liquidatable borrower condition", "exact acquisition, borrow/repay, redeem/liquidate, and exit economics positive after costs", "fork extraction proof"], nextReadOnlyStep: "Keep XAUt on RWA/NAV and Fluid/Compound/Aave consumer watch; exact-quote/fork only if a material borrower becomes liquidatable, a trusted accepted-value divergence clears the haircut, or permissionless redemption/DEX exit becomes exact-positive." },
  { key: "usdAiPhase0", id: "usd-ai-phase0-sweep", protocol: "USD AI", chain: "Arbitrum", surface: "USDai/sUSDai RWA lending token, queue, and consumer-route Phase 0", baseScore: 39, watchFields: ["watchCandidates"], researchFields: ["fluidUsdaiVaultRows", "eulerUsdaiVaultRows", "pendlePtConsumerMatches", "reviewCandidates"], liquidityFields: ["defillamaCurrentTvlUsd", "topDexLiquidityUsd", "protocolStableBalanceUsd"], edgeFields: ["depositVsRedemptionBps", "pendlePtBestAcceptedVsAcquisitionBps"], closedStatus: "usd-ai-phase0-no-route-positive", watchStatus: "usd-ai-watch-needs-redemption-or-consumer-trigger", sourceArtifacts: ["reports/raw/fast/usd-ai-phase0.json"], blockers: ["sUSDai deposit share price is above redemption share price, so direct deposit/redeem is negative before gas", "maxWithdraw(self)=0 and redemption queue serviced balance is limited", "Queued depositor scanned USDC/USDT/PYUSD balances are zero", "Fluid, Euler, and Pendle consumer joins do not expose exact-positive borrow, liquidation, redemption, or unwind economics", "No fork extraction proof"], requiredForRoutePositive: ["USDai or sUSDai accepted value exceeds exact acquisition or redemption value after LTV/LLTV haircut and costs", "borrow, redemption, liquidation, or queue exit path is permissionless, unpaused, and material", "borrowed, redeemed, or seized asset has exact positive unwind liquidity", "fork extraction proof"], nextReadOnlyStep: "Keep USD AI on redemption spread, Fluid/Euler/Pendle consumer, and queue-liquidity watch; exact-quote/fork only if accepted value or redemption value becomes route-positive after costs." },
  { key: "circleUsycPhase0", id: "circle-usyc-phase0-sweep", protocol: "Circle USYC", chain: "Ethereum/BNB Chain", surface: "RWA/NAV USYC token and consumer graph Phase 0", baseScore: 36, watchFields: ["watchCandidates"], researchFields: ["tokenRows", "matches", "reviewCandidates", "producerAnomalies"], liquidityFields: ["defillamaCurrentTvlUsd", "topDexLiquidityUsd"], closedStatus: "circle-usyc-phase0-no-route-positive", watchStatus: "circle-usyc-watch-needs-nav-consumer-economics", sourceArtifacts: ["reports/raw/fast/circle-usyc-phase0.json"], blockers: ["USYC RWA issuance/redemption and transferability remain treated as permissioned/restricted absent public atomic exit proof", "No ERC4626 NAV interface or current NAV/reference divergence above threshold was resolved for the USYC producer rows", "Observed consumer matches are dust or loan-side/context-only and do not expose material exact-positive borrow/liquidation economics", "No public DEX liquidity or exact positive acquisition, redeem, borrow, liquidation, or unwind route was proven", "No fork extraction proof"], requiredForRoutePositive: ["USYC accepted by a material lending, margin, redemption, or liquidation consumer", "permissionless NAV/oracle/backing/accepted-value divergence or current liquidatable borrower condition", "exact acquisition, borrow/repay, redeem/liquidate, and exit economics positive after costs", "fork extraction proof"], nextReadOnlyStep: "Reopen Circle USYC only if a material consumer listing appears, a stale/NAV/accepted-value divergence becomes current, or a permissionless redemption/DEX exit path becomes exact-positive after costs." },
  { key: "midasRwaPhase0", id: "midas-rwa-phase0-sweep", protocol: "Midas RWA", chain: "Ethereum primary; Arbitrum/Base/BNB/Optimism TVL context", surface: "Midas RWA/NAV exact token seeds, Euler/Morpho/Silo/Pendle consumer graph, and DEX exit-liquidity Phase 0", baseScore: 40, watchFields: ["watchCandidates"], researchFields: ["tokenRows", "matches", "localArtifactRows", "reviewCandidates", "producerAnomalies"], liquidityFields: ["defillamaCurrentTvlUsd", "topDexLiquidityUsd", "ethereumTvlUsd"], edgeFields: ["producerAnomalies"], closedStatus: "midas-rwa-phase0-no-route-positive", watchStatus: "midas-rwa-watch-needs-nav-consumer-economics", sourceArtifacts: ["reports/raw/fast/midas-rwa-phase0.json", "reports/raw/fast/midas-rwa-phase0-rwa-nav-consumer-graph.json"], blockers: ["Other public Midas chains remain TVL context until exact token addresses and consumers are resolved", "Midas issuance/redemption is treated as permissioned or delayed absent public atomic exit proof", "Euler, Morpho, Silo, and Pendle joins lack current accepted-value divergence plus exact positive borrow, liquidation, redeem, or unwind economics", "Public DEX liquidity is low/context-only and no exact acquisition/exit route is positive", "No fork extraction proof"], requiredForRoutePositive: ["Exact Midas token or PT accepted by a material consumer with usable LTV/LLTV and live liquidity", "Current NAV/oracle/market divergence or liquidatable condition favorable to an attacker", "Exact acquisition, borrow/liquidation/redeem, and exit route positive after gas/slippage/fees", "fork extraction proof"], nextReadOnlyStep: "Keep Midas on NAV/consumer-join watch; exact-quote/fork only if a Midas consumer row gains material liquidity plus current NAV/oracle/market divergence or a Pendle/Euler/Morpho/Silo row becomes exact-positive after costs." },
  { key: "spikoPhase0", id: "spiko-phase0-sweep", protocol: "Spiko", chain: "Ethereum/Polygon/Arbitrum/Base", surface: "Spiko RWA/NAV exact EVM token seeds, lending/oracle consumer graph, local Morpho/Silo/Euler joins, and DEX exit-liquidity Phase 0", baseScore: 42, watchFields: ["watchCandidates"], researchFields: ["tokenRows", "matches", "localArtifactRows", "reviewCandidates", "producerAnomalies"], liquidityFields: ["defillamaCurrentTvlUsd", "topDexLiquidityUsd", "ethereumTvlUsd", "polygonTvlUsd", "arbitrumTvlUsd", "baseTvlUsd"], edgeFields: ["producerAnomalies"], closedStatus: "spiko-phase0-no-route-positive", watchStatus: "spiko-watch-needs-nav-consumer-economics", sourceArtifacts: ["reports/raw/fast/spiko-phase0.json", "reports/raw/fast/spiko-phase0-rwa-nav-consumer-graph.json"], blockers: ["Spiko issuance/redemption/transferability remains treated as permissioned or restricted absent public atomic exit proof", "Known Morpho EUTBL/EURCV and Silo USTBL/EUTBL rows lack current accepted-value divergence plus exact positive borrow, liquidation, redeem, or unwind economics", "Public DEX liquidity is context-only and no exact acquisition/exit route is positive", "No fork extraction proof"], requiredForRoutePositive: ["Exact Spiko token or PT accepted by a material lending, margin, redemption, or liquidation consumer", "Current NAV/oracle/market divergence or liquidatable condition favorable after LTV/LLTV haircut", "Borrow, redemption, liquidation, or DEX exit liquidity is live and exact-quoted positive after costs", "fork extraction proof"], nextReadOnlyStep: "Keep Spiko on NAV/consumer-join watch; exact-quote/fork only if a Spiko consumer row gains material liquidity plus current NAV/oracle/market divergence or a Morpho/Silo/Euler/Pendle row becomes exact-positive after costs." },
  { key: "fortyAcresPhase0", id: "40acres-phase0-sweep", protocol: "40 Acres", chain: "Base/Optimism/Avalanche; Ethereum YieldBasis context", surface: "40 Acres lending/vault, YieldBasis harvest, portfolio sampling, source patch, and Pendle context Phase 0", baseScore: 39, routePositiveFields: ["routePositive", "executableNow"], watchFields: ["watchCandidates", "yieldBasisWatchRows"], researchFields: ["contractRows", "factoryRows", "yieldBasisHarvestRows", "pendleRows"], liquidityFields: ["defillamaCurrentTvlUsd", "defillamaBorrowedUsd", "vaultLiquidAssetsUsd", "loanActiveAssetsUsd", "maxPendleLiquidityUsd"], edgeFields: ["sampleYieldUsd", "maxSampleYieldUsd"], closedStatus: "40acres-phase0-no-route-positive", watchStatus: "40acres-watch-needs-yieldbasis-or-borrow-economics", sourceArtifacts: ["reports/raw/fast/40acres-phase0.json"], blockers: ["harvestLpFees is gated by portfolio-manager authorized-caller checks and is not directly permissionless in current public state", "Live patch status cannot be fully proven from read-only facet bytecode where linked libraries are involved", "Vault liquid assets, sampled YieldBasis yield, and Pendle 40acresUSDC rows are context-only and do not expose exact-positive borrow, harvest, redeem, liquidation, or unwind economics", "No permissionless same-block borrower/portfolio route is exact-positive", "No fork extraction proof"], requiredForRoutePositive: ["permissionless 40 Acres or YieldBasis state-changing path affects collateral, debt, harvest, redemption, or portfolio accounting", "material borrow, redeem, liquidation, harvest, or Pendle unwind liquidity is live and unblocked", "exact acquisition, action, and exit economics are positive after gas/slippage/fees", "fork extraction proof"], nextReadOnlyStep: "Keep 40 Acres closed unless a live YieldBasis facet/account state, authorization change, or Pendle/borrow/harvest condition creates exact-positive economics ready for static-call or fork proof." },
  { key: "nativeCreditPoolPhase0", id: "native-credit-pool-phase0-sweep", protocol: "Native Credit Pool", chain: "Ethereum/Base; BNB/Arbitrum/Monad context", surface: "Native Credit adapter vault/LP market, borrowed-cash, bytecode selector, and local consumer-join Phase 0", baseScore: 38, routePositiveFields: ["routePositive", "executableNow"], watchFields: ["watchCandidates"], researchFields: ["marketRows", "directConsumerRows", "tokenContextRows", "selectorHintRows"], liquidityFields: ["defillamaCurrentTvlUsd", "defillamaBorrowedUsd", "totalVaultCashUsd", "totalBorrowedUsd", "maxMarketTotalUnderlyingUsd", "maxMarketBorrowedUsd"], edgeFields: ["logErrorRows"], closedStatus: "native-credit-pool-phase0-no-route-positive", watchStatus: "native-credit-pool-watch-needs-borrower-or-consumer-economics", sourceArtifacts: ["reports/raw/fast/native-credit-pool-phase0.json"], blockers: ["DeFiLlama adapter exposes vault cash and borrowed accounting but not account-level PMM borrower health or a public liquidation path", "No direct Native vault/LP consumer join mapped to material external lending, oracle, redemption, bridge, or liquidation economics", "Borrow-like and admin selector hints are bytecode context only until source/ABI and role checks are verified", "BNB/Arbitrum historical log coverage is bounded by RPC eth_getLogs range limits and Monad is outside current sanitized RPC scope", "No exact positive borrow, repay, withdrawal, liquidation, redemption, or DEX unwind economics and no fork extraction proof"], requiredForRoutePositive: ["verified Native Credit source/ABI or account-health endpoint maps LP markets to a permissionless borrow, liquidation, redemption, or withdrawal path", "material borrower/account or trusted consumer route is live and unblocked", "exact acquisition, action, and exit economics are positive after gas/slippage/fees", "fork extraction proof"], nextReadOnlyStep: "Keep Native Credit Pool closed unless verified borrower/account-health data or a direct trusted consumer join creates exact-positive borrow, liquidation, redemption, or unwind economics." },
  { key: "matrixdockStbtPhase0", id: "matrixdock-stbt-phase0-sweep", protocol: "MatrixDock STBT", chain: "Ethereum", surface: "RWA/NAV STBT Phase 0 consumer graph", baseScore: 30, researchFields: ["producersInput", "producersResolved", "producersCodePresent", "matches", "reviewCandidates"], closedStatus: "rwa-nav-no-consumer-match", sourceArtifacts: ["reports/raw/fast/matrixdock-stbt-phase0.json"], blockers: ["STBT was not found as collateral, borrow asset, reserve asset, or oracle bytecode reference in scanned consumers", "No ERC4626-like NAV reference or current NAV divergence was resolved", "RWA redemption is tagged permissioned; no permissionless exact exit is proven"], requiredForRoutePositive: ["STBT accepted by a material lending/PT/vault consumer", "accepted value diverges from exact acquisition/redemption/DEX value", "borrow, liquidation, or redemption liquidity is live and exact-quoted", "fork extraction proof"], nextReadOnlyStep: "Reopen MatrixDock STBT only if a new consumer listing or exact permissionless exit path appears; otherwise proceed to the next Phase 0 target." },
  { key: "arbitrumBridgePhase0", id: "arbitrum-bridge-phase0-sweep", protocol: "Arbitrum Bridge", chain: "Ethereum -> Arbitrum One", surface: "Canonical bridge retryable/outbox/token-gateway custody and consumer-join Phase 0", baseScore: 38, routePositiveFields: ["routePositive", "executableNow"], watchFields: ["watchCandidates", "bridgeSpecificWatchJoins"], researchFields: ["contractsScanned", "gatewayRows", "tokenPairsScanned", "materialTokenRows", "materialContextDeltaRows", "artifactJoinRows", "bridgeSpecificJoinRows"], liquidityFields: ["defillamaCurrentTvlUsd", "trackedGatewayBalanceUsd"], closedStatus: "arbitrum-bridge-phase0-no-route-positive", watchStatus: "arbitrum-bridge-watch-needs-proof-retryable-or-backing-economics", sourceArtifacts: ["reports/raw/fast/arbitrum-bridge-phase0.json"], blockers: ["No Arbitrum-specific proof-acceptance, domain, delayed-inbox, retryable, outbox, nonce, or token-binding bypass identified", "Gateway balances and Arbitrum token supplies are backing context only without a mint/unlock flaw", "Common-token consumer joins are not bridge-specific exploit evidence without a backing/proof flaw", "Material token-list balance deltas are bounded context and not extraction proof", "No exact positive bridge, borrow, redemption, liquidation, or DEX unwind economics and no fork extraction proof"], requiredForRoutePositive: ["deployed Arbitrum proof/domain/message/nonce/token/finality binding weakness, retryable/outbox bypass, or material exact backing mismatch", "permissionless path to mint, unlock, transfer, or borrow against affected assets", "exact unwind, borrow, redeem, or liquidation economics positive after costs", "fork extraction proof"], nextReadOnlyStep: "Keep Arbitrum Bridge closed unless a deployed proof/retryable/outbox weakness or exact backing mismatch maps to material consumer economics." },
  { key: "polygonZkevmBridgePhase0", id: "polygon-zkevm-bridge-phase0-sweep", protocol: "Polygon zkEVM Bridge", chain: "Ethereum -> Polygon zkEVM", surface: "Canonical bridge custody, proof-root, exact token balance, and local consumer-join Phase 0", baseScore: 36, routePositiveFields: ["routePositive", "executableNow"], watchFields: ["watchCandidates", "bridgeSpecificWatchJoins"], researchFields: ["contractRows", "trackedAssetRows", "artifactJoinRows", "bridgeSpecificJoinRows", "unresolvedPublicTokenSymbols"], liquidityFields: ["defillamaCurrentTvlUsd", "trackedCustodyUsd", "nativeEthBalanceUsd", "trackedAssetBalanceUsd"], closedStatus: "polygon-zkevm-bridge-phase0-no-route-positive", watchStatus: "polygon-zkevm-bridge-watch-needs-proof-or-backing-economics", sourceArtifacts: ["reports/raw/fast/polygon-zkevm-bridge-phase0.json"], blockers: ["No deployed proof-acceptance or message-binding bypass was identified for the Polygon zkEVM bridge path", "Native ETH and common ERC20 custody balances are context only without a mint/unlock/backing flaw", "Top public token symbols include exact-address caveats in this bounded pass", "No Polygon zkEVM destination-chain wrapped supply check was performed in current Ethereum-adapter scope", "No exact positive bridge, borrow, redemption, liquidation, or DEX unwind economics and no fork extraction proof"], requiredForRoutePositive: ["deployed Polygon zkEVM proof/domain/message/nonce/token binding weakness or material exact backing mismatch", "permissionless path to mint, unlock, transfer, or borrow against affected assets", "exact unwind, borrow, redeem, or liquidation economics positive after costs", "fork extraction proof"], nextReadOnlyStep: "Keep Polygon zkEVM Bridge closed unless a proof-binding flaw, exact backing mismatch, or bridge-specific consumer route maps to live liquidity with positive economics." },
  { key: "cronosZkevmBridgePhase0", id: "cronos-zkevm-bridge-phase0-sweep", protocol: "Cronos zkEVM Bridge", chain: "Ethereum -> Cronos zkEVM", surface: "Canonical bridge Phase 0 lockbox/backing and consumer join", baseScore: 31, watchFields: ["watchCandidates"], researchFields: ["trackedKnownAddressRows", "trackedAddressRowsWithAssetId", "artifactJoinRows"], liquidityFields: ["defillamaCurrentTvlUsd"], closedStatus: "bridge-phase0-no-route-positive", watchStatus: "bridge-phase0-watch-needs-proof-binding-economics", sourceArtifacts: ["reports/raw/fast/cronos-zkevm-bridge-phase0.json"], blockers: ["No deployed proof-acceptance or message-binding bypass identified for the Cronos zkEVM bridge path", "Bridge balance and destination chainBalance reads are backing context only, not a proof of mint/unlock bypass", "Common asset consumer joins are not bridge-specific exploit evidence without a backing mismatch", "No exact positive bridge, borrow, redemption, liquidation, or DEX unwind economics"], requiredForRoutePositive: ["deployed proof/domain/message/nonce/token binding weakness or material backing mismatch", "permissionless path to mint, unlock, transfer, or borrow against the affected asset", "exact unwind, borrow, redeem, or liquidation economics positive after costs", "fork extraction proof"], nextReadOnlyStep: "Reopen Cronos zkEVM Bridge only if a deployed proof-binding weakness or exact backing mismatch maps to material consumer economics; otherwise continue to the next Phase 0 target." },
  { key: "flyingTulipLendPhase0", id: "flying-tulip-lend-phase0-sweep", protocol: "Flying Tulip Lend", chain: "Ethereum/Sonic", surface: "Lending Phase 0 reserve/wrapper/lens and consumer join", baseScore: 33, watchFields: ["watchCandidates"], researchFields: ["reservesWithAssetState", "rowsWithBorrows", "wrappersWithStrategies", "artifactJoinRows"], liquidityFields: ["defillamaCurrentTvlUsd", "lensCashUsd", "lensBorrowedUsd"], closedStatus: "lending-phase0-no-route-positive", watchStatus: "lending-phase0-watch-needs-borrower-or-oracle-economics", sourceArtifacts: ["reports/raw/fast/flying-tulip-lend-phase0.json"], blockers: ["Phase 0 mapped Ethereum reserves and wrappers but did not discover account-level borrower health or liquidatable accounts", "Sonic live reserve scan is blocked by missing current RPC endpoint for chain id 146", "Reserve and wrapper reads do not prove oracle manipulation, cap bypass, paused-state drift, or liquidation profitability", "Unique wrappers and strategy tokens did not join to route-positive consumer economics"], requiredForRoutePositive: ["reserve/oracle/cap/borrower condition with permissionless impact", "borrower/account or wrapper route with material live liquidity", "exact repay/acquire/borrow/redeem/liquidation and exit economics positive after costs", "fork extraction proof"], nextReadOnlyStep: "Reopen Flying Tulip only after Sonic RPC is available, a borrower/account discovery source exists, or reserve/oracle config exposes a concrete divergence with exact economics." },
  { key: "capyfiPhase0", id: "capyfi-phase0-sweep", protocol: "Capyfi", chain: "Ethereum/World Chain/LaChain", surface: "Compound V2 fork market/oracle/whitelist/liquidation Phase 0 scan", baseScore: 38, watchFields: ["watchCandidates", "materialSampledLiquidatableBorrowers"], researchFields: ["marketRows", "highCfBorrowableRows", "fixedOracleRows", "chainlinkNoStaleGuardRows", "sampledBorrowers"], liquidityFields: ["defillamaCurrentTvlUsd", "totalCashUsd", "totalBorrowsUsd"], closedStatus: "capyfi-phase0-no-route-positive", watchStatus: "capyfi-watch-needs-oracle-divergence-or-liquidation-economics", sourceArtifacts: ["reports/raw/fast/capyfi-phase0.json"], blockers: ["Fixed-price and Chainlink-no-stale-guard oracle rows are configuration dependencies, not extractive routes without a current accepted-value divergence", "Active whitelist gates direct mint/supply paths; cToken acquisition, borrow, and unwind economics are not exact-quoted", "High-CF rows require stale/divergent accepted price plus material borrow cash and exact positive exit economics", "Bounded recent borrower sampling is not exhaustive and found no fork-proven exact positive liquidation route", "No fork extraction proof"], requiredForRoutePositive: ["specific Capyfi market accepts an attacker-favorable stale, fixed, or divergent oracle value", "collateral acquisition or mint path is permissionless/unblocked and has material same-block liquidity", "borrow or liquidation path is unpaused and has material live liquidity", "borrowed/seized asset exit is exact-quoted positive after gas/slippage/fees", "fork extraction proof"], nextReadOnlyStep: "Keep Capyfi on oracle/whitelist/liquidation watch; exact-quote/fork only if a fixed or no-stale-guard oracle row becomes accepted-divergent, or a material liquidatable borrower appears." },
  { key: "fluxFinancePhase0", id: "flux-finance-phase0-sweep", protocol: "Flux Finance", chain: "Ethereum", surface: "Compound V2 fToken market/oracle/liquidation Phase 0 scan", baseScore: 40, routePositiveFields: ["routePositive", "executableNow"], watchFields: ["watchCandidates", "materialSampledLiquidatableBorrowers"], researchFields: ["marketRows", "listedRows", "highCfBorrowableRows", "divergentRows", "staleButAcceptedRows", "sampledBorrowers", "localArtifactRows"], liquidityFields: ["defillamaCurrentTvlUsd", "totalCashUsd", "totalBorrowsUsd"], edgeFields: ["divergentRows", "staleButAcceptedRows"], closedStatus: "flux-finance-phase0-no-route-positive", watchStatus: "flux-finance-watch-needs-oracle-divergence-or-liquidation-economics", sourceArtifacts: ["reports/raw/fast/flux-finance-phase0.json"], blockers: ["fOUSG has high collateral factor but borrow is paused, so it is not a current borrow-extraction route", "USDC, USDT, DAI, and FRAX fToken rows are borrow markets with 0% collateral factor in current state", "Oracle/reference differences are below route gates and do not map to positive borrow or liquidation economics", "Bounded anonymized borrower sampling found no material liquidatable borrower", "No fork extraction proof"], requiredForRoutePositive: ["specific Flux fToken market accepts attacker-favorable stale or divergent oracle/accounting value", "borrow or liquidation path is permissionless, unpaused, and has material live liquidity", "collateral acquisition, borrow/repay, seized asset exit, and unwind are exact-quoted after gas/slippage/fees", "fork extraction proof"], nextReadOnlyStep: "Keep Flux Finance on fOUSG pause, stablecoin oracle/reference, and liquidation watch; exact-quote/fork only if a material borrower becomes liquidatable or accepted-value divergence clears full route costs." },
  { key: "ethenaUsdtbPhase0", id: "ethena-usdtb-phase0-sweep", protocol: "Ethena USDtb", chain: "Ethereum", surface: "USDtb RWA/stable token, minting-cap, custody, DEX/reference, Fluid/Euler/Morpho consumer-join Phase 0", baseScore: 41, routePositiveFields: ["routePositive", "executableNow"], watchFields: ["watchCandidates", "materialConsumerRows"], researchFields: ["artifactJoinRows", "usdTbConsumerRows", "fluidConsumerRows", "eulerConsumerRows", "morphoConsumerRows", "permissionlessProbeOpenRows"], liquidityFields: ["defillamaCurrentTvlUsd", "topDexLiquidityUsd", "fUsdTbTotalAssetsUsd", "custodyBalanceUsd"], edgeFields: ["usdTbPriceVsPegBps"], closedStatus: "ethena-usdtb-phase0-no-route-positive", watchStatus: "ethena-usdtb-watch-needs-depeg-consumer-or-minting-economics", sourceArtifacts: ["reports/raw/fast/ethena-usdtb-phase0.json"], blockers: ["USDtb price/reference divergence is below the route threshold and does not overcome lending haircuts, slippage, gas, or flash fees", "Ethena mint/redeem flows are role/signed-order gated in current read-only probes; no arbitrary-sender mint, redeem, custody, or admin path is executable", "Fluid, Euler, Morpho, DEX, and local artifact USDtb joins are context-only without a current accepted-value, depeg, liquidation, or redemption edge", "fUSDtb and USDtb lending rows do not prove a donation, stale-rate, or same-block accounting route with positive borrow/redeem/unwind economics", "No fork extraction proof"], requiredForRoutePositive: ["specific USDtb or fUSDtb trusted consumer accepts attacker-favorable stale, overvalued, or undercollateralized accounting state", "borrow, liquidation, redeem, or mint path is permissionless, unpaused, and has material live liquidity", "acquisition, borrow/repay, redeem/liquidate, and DEX/PSM/market exit are exact-quoted positive after gas/slippage/fees", "fork extraction proof"], nextReadOnlyStep: "Keep USDtb on Fluid/Euler/Morpho consumer, minting-cap, and depeg/reference watch; exact-quote/fork only if USDtb accepted value diverges materially from acquisition/redemption value, a material borrower becomes liquidatable, or a USDtb lending row exposes exact-positive economics." },
  { key: "fluidLendingPhase0", id: "fluid-lending-phase0-sweep", protocol: "Fluid Lending", chain: "Ethereum/Arbitrum/Base/Polygon", surface: "Fluid shared Liquidity/fToken/vault/oracle/liquidation Phase 0 scan", baseScore: 39, watchFields: ["watchCandidates", "materialLiquidationHintRows"], researchFields: ["listedTokenRows", "vaultRowsResolved", "highCfBorrowableRows", "smartDebtHighCfRows", "positionSampleRows", "positionSampleDebtRows"], liquidityFields: ["defillamaCurrentTvlUsd", "totalBorrowUsd", "totalAvailableLiquidityUsd"], closedStatus: "fluid-lending-phase0-no-route-positive", watchStatus: "fluid-lending-watch-needs-liquidation-or-oracle-economics", sourceArtifacts: ["reports/raw/fast/fluid-lending-phase0.json"], blockers: ["High-CF and smart-debt vault rows are configuration context without a current accepted-value divergence or exact positive borrow/liquidation route", "Resolver liquidation hints are raw context only until exact quote normalization, route unwind, gas, slippage, and fork proof are added", "Bounded position sampling does not prove a liquidatable account with positive economics", "Fluid DEX share consumers remain protocol-internal and separately route-negative absent an external trusted consumer", "No fork extraction proof"], requiredForRoutePositive: ["specific Fluid vault accepts attacker-favorable stale, under-bound, or overvalued oracle/accounting state", "borrow or liquidation path is permissionless and has material live liquidity", "collateral acquisition, repay/borrow, seized asset exit, and unwind are exact-quoted after gas/slippage/fees", "fork extraction proof"], nextReadOnlyStep: "Keep Fluid Lending on high-CF/oracle/liquidation watch; exact-quote/fork only if a material resolver liquidation or stale/overvalued vault row becomes exact-positive." },
  { key: "benqiLendingPhase0", id: "benqi-lending-phase0-sweep", protocol: "Benqi Lending", chain: "Avalanche", surface: "Compound-style market/dual-oracle/liquidation Phase 0 scan", baseScore: 40, watchFields: ["watchCandidates", "materialSampledLiquidatableBorrowers"], researchFields: ["marketRows", "listedRows", "highCfBorrowableRows", "divergentRows", "staleButAcceptedRows", "sampledBorrowers"], liquidityFields: ["defillamaCurrentTvlUsd", "totalCashUsd", "totalBorrowsUsd"], closedStatus: "benqi-lending-phase0-no-route-positive", watchStatus: "benqi-lending-watch-needs-oracle-divergence-or-liquidation-economics", sourceArtifacts: ["reports/raw/fast/benqi-lending-phase0.json"], blockers: ["Dual-oracle/feed and high-CF rows are configuration context without a current accepted-value divergence plus exact positive borrow or liquidation economics", "The only material oracle-vs-DEX divergent legacy row is paused and not a borrowable route", "Bounded recent borrower sampling is not exhaustive and found no material liquidatable borrower", "Secondary adapter comptroller rows are live token context but not listed under current market state", "No fork extraction proof"], requiredForRoutePositive: ["specific Benqi market accepts an attacker-favorable stale or divergent oracle/accounting value", "borrow or liquidation path is unpaused and has material live liquidity", "collateral acquisition, borrow/repay, seized asset exit, and unwind are exact-quoted after gas/slippage/fees", "fork extraction proof"], nextReadOnlyStep: "Keep Benqi on dual-oracle/high-CF/liquidation watch; exact-quote/fork only if a material market or borrower becomes exact-positive." },
  { key: "crvusdPhase0", id: "crvusd-phase0-sweep", protocol: "crvUSD", chain: "Ethereum", surface: "CDP LLAMMA controller/oracle/PegKeeper/liquidation Phase 0 scan", baseScore: 40, watchFields: ["watchCandidates", "materialSampledLiquidatableBorrowers", "materialPegKeeperProfitRows", "staleFeedRows"], researchFields: ["marketRows", "factoryMarketsScanned", "uniqueOracleRows", "pegKeeperRows", "sampledBorrowers"], liquidityFields: ["defillamaCurrentTvlUsd", "totalDebtUsd", "availableCrvusdUsd"], edgeFields: ["oracleDiffRows", "feedWarnRows"], closedStatus: "crvusd-phase0-no-route-positive", watchStatus: "crvusd-watch-needs-oracle-liquidation-or-keeper-economics", sourceArtifacts: ["reports/raw/fast/crvusd-phase0.json"], blockers: ["Oracle and LLAMMA rows are context only without current stale/divergent accepted value plus exact positive borrow/liquidation/unwind economics", "Bounded borrower sampling found no material liquidatable borrower and does not prove exact liquidation profitability", "PegKeeper caller-profit estimates are intended keeper-incentive context without exact LP exit, gas, slippage, MEV, and authorization", "No fork extraction proof"], requiredForRoutePositive: ["specific crvUSD market accepts attacker-favorable stale or divergent oracle/accounting state", "borrower liquidation, borrow, or PegKeeper path is permissionless and has material live liquidity", "repay/acquire/borrow/redeem/seized-collateral or LP exit route is exact-quoted after gas/slippage/fees", "fork extraction proof"], nextReadOnlyStep: "Keep crvUSD on oracle staleness, material borrower liquidation, and PegKeeper-profit watch; exact-quote/fork only if a material row becomes exact-positive." },
  { key: "curveLlamalendPhase0", id: "curve-llamalend-phase0-sweep", protocol: "Curve LlamaLend", chain: "Ethereum/Arbitrum/Optimism/Fraxtal/Sonic", surface: "LlamaLend controller, LLAMMA, vault, oracle, and bounded liquidation Phase 0 scan", baseScore: 42, watchFields: ["watchCandidates", "grossPositiveLiquidationRows", "exactEconomicsRows"], researchFields: ["marketRows", "apiVaultRows", "materialDebtRows", "highLtvRows", "sampledBorrowers", "materialSampledLiquidatableBorrowers", "rektNoCollateralLiquidatableRows"], liquidityFields: ["defillamaCurrentTvlUsd", "apiBorrowedUsd", "apiAvailableUsd", "liveTotalDebtUsd"], edgeFields: ["oracleDiffRows", "staleFeedRows", "feedWarnRows"], closedStatus: "curve-llamalend-phase0-no-route-positive", watchStatus: "curve-llamalend-watch-needs-oracle-or-liquidation-economics", sourceArtifacts: ["reports/raw/fast/curve-llamalend-phase0.json"], blockers: ["LLAMMA/oracle rows are context only without current stale/divergent accepted value plus exact positive borrow/liquidation/unwind economics", "Sampled material liquidatable rows are bad-debt/no-collateral in this pass and have zero gross-positive liquidation rows", "Oracle-vs-spot divergence rows require exact acquisition, liquidation, collateral exit, gas/slippage/fee modeling, and fork proof", "No fork extraction proof"], requiredForRoutePositive: ["specific LlamaLend market accepts attacker-favorable stale or divergent oracle/accounting state", "borrow or liquidation path is permissionless and has material live liquidity", "repay/acquire/borrow/seized-collateral exit route is exact-quoted after gas/slippage/fees", "fork extraction proof"], nextReadOnlyStep: "Keep Curve LlamaLend on oracle-divergence and material liquidation watch; exact-quote/fork only if a row has gross-positive collateral output or an accepted-value divergence clears full liquidation/unwind costs." },
  { key: "liquityV1Phase0", id: "liquity-v1-phase0-sweep", protocol: "Liquity V1", chain: "Ethereum", surface: "Immutable ETH CDP price-feed/liquidation/redemption Phase 0 scan", baseScore: 40, watchFields: ["watchCandidates", "materialSampledLiquidatableTroves", "nearMcrRows"], researchFields: ["sampledTroves"], liquidityFields: ["defillamaCurrentTvlUsd", "totalSystemDebtLusd", "totalSystemCollUsd", "stabilityPoolLusdUsd"], closedStatus: "liquity-v1-phase0-no-route-positive", watchStatus: "liquity-v1-watch-needs-liquidation-redemption-or-oracle-trigger", sourceArtifacts: ["reports/raw/fast/liquity-v1-phase0.json"], blockers: ["No sampled active trove is below the execution-path liquidation threshold", "LUSD market price is not below peg enough to clear current redemption fee and exact route costs", "Liquity PriceFeed is chainlinkWorking with no stale-but-accepted feed condition", "No trove IDs are persisted and no fork extraction proof exists"], requiredForRoutePositive: ["specific Liquity V1 trove is currently liquidatable with material debt under fetchPrice()", "liquidation or redemption route has exact acquisition, hinting/staticCall, gas, slippage, and exit economics", "route remains positive after fees and MEV assumptions", "fork extraction proof"], nextReadOnlyStep: "Keep Liquity V1 on tail-trove, PriceFeed, and LUSD redemption watch; fork only if a material liquidation or exact-positive redemption trigger appears." },
  { key: "liquityV2Phase0", id: "liquity-v2-phase0-sweep", protocol: "Liquity V2", chain: "Ethereum", surface: "Bold multi-collateral CDP registry/oracle/liquidation/redemption Phase 0 scan", baseScore: 42, watchFields: ["watchCandidates", "materialSampledLiquidatableTroves", "nearMcrRows", "oraclePremiumWatchRows"], researchFields: ["sampledTroves", "branches"], liquidityFields: ["defillamaCurrentTvlUsd", "totalBranchDebtBold", "totalBranchCollUsd", "stabilityPoolBoldUsd", "boldTopDexLiquidityUsd"], edgeFields: ["redemptionGrossEdgeAfterFeeBps"], closedStatus: "liquity-v2-phase0-no-route-positive", watchStatus: "liquity-v2-watch-needs-liquidation-redemption-or-oracle-trigger", sourceArtifacts: ["reports/raw/fast/liquity-v2-phase0.json"], blockers: ["No sampled Bold trove is proven exact-positive for liquidation", "BOLD redemption requires exact hinting/staticCall, collateral exit quote, gas, slippage, and fork proof", "LST oracle rows are context only without current accepted overvaluation and exact extraction economics", "Borrower addresses and trove IDs are intentionally not persisted", "No fork extraction proof"], requiredForRoutePositive: ["specific Bold trove is currently liquidatable with material debt under fetchPrice() or BOLD redemption is net-positive", "liquidation/redemption path has exact acquisition, hints/staticCall, gas, slippage, and collateral exit economics", "route remains positive after fees and MEV assumptions", "fork extraction proof"], nextReadOnlyStep: "Keep Liquity V2 on tail-trove, BOLD redemption, and LST oracle watch; exact-quote/fork only if a material liquidation or redemption trigger becomes route-positive." },
  { key: "optimismBridgePhase0", id: "optimism-bridge-phase0-sweep", protocol: "Optimism Bridge", chain: "Ethereum -> Optimism", surface: "Canonical OP-stack bridge Phase 0 custody/proof/backing and consumer join", baseScore: 36, watchFields: ["watchCandidates"], researchFields: ["contractsScanned", "bridgeOwnerRows", "dynamicBridgeOwners", "tokenPairsScanned", "materialTokenRows", "materialContextDeltaRows", "artifactJoinRows", "bridgeSpecificJoinRows"], liquidityFields: ["defillamaCurrentTvlUsd", "trackedBridgeBalanceUsd"], closedStatus: "bridge-phase0-no-route-positive", watchStatus: "bridge-phase0-watch-needs-proof-binding-economics", sourceArtifacts: ["reports/raw/fast/optimism-bridge-phase0.json"], blockers: ["No Optimism-specific proof-acceptance, finality, domain, nonce, or token-binding bypass identified", "Adapter owner balances and OP token supplies are backing context only, not a proof of mint/unlock bypass", "Common-token consumer joins are not bridge-specific exploit evidence without a backing/proof flaw", "Base and PGN adapter chain rows are currently zero TVL for this slug", "No exact positive bridge, borrow, redemption, liquidation, or DEX unwind economics"], requiredForRoutePositive: ["deployed Optimism proof/domain/message/nonce/token/finality binding weakness or material exact backing mismatch", "permissionless path to mint, unlock, transfer, or borrow against the affected asset", "exact unwind, borrow, redeem, or liquidation economics positive after costs", "fork extraction proof"], nextReadOnlyStep: "Reopen Optimism Bridge only if a deployed proof-binding weakness or exact backing mismatch maps to material consumer economics; otherwise proceed to the next public Phase 0 target." },
  { key: "baseBridgePhase0", id: "base-bridge-phase0-sweep", protocol: "Base Bridge", chain: "Ethereum -> Base", surface: "Canonical OP-stack bridge Phase 0 custody/proof/backing and consumer join", baseScore: 38, routePositiveFields: ["routePositive", "executableNow"], watchFields: ["watchCandidates"], researchFields: ["contractsScanned", "bridgeOwnerRows", "dynamicBridgeOwners", "tokenPairsScanned", "materialTokenRows", "materialContextDeltaRows", "artifactJoinRows", "bridgeSpecificJoinRows"], liquidityFields: ["defillamaCurrentTvlUsd", "trackedBridgeBalanceUsd"], closedStatus: "base-bridge-phase0-no-route-positive", watchStatus: "base-bridge-watch-needs-proof-binding-or-backing-economics", sourceArtifacts: ["reports/raw/fast/base-bridge-phase0.json"], blockers: ["No Base-specific proof-acceptance, finality, domain, nonce, or token-binding bypass identified", "Adapter owner balances and Base token supplies are backing context only, not proof of a permissionless mint/unlock bypass", "Native ETH, native USDC/CCTP, special bridge owners, in-flight messages, and token-list coverage can explain context deltas absent exact proof", "Common-token consumer joins are not bridge-specific exploit evidence without a backing/proof flaw", "No exact positive bridge, borrow, redemption, liquidation, or DEX unwind economics and no fork extraction proof"], requiredForRoutePositive: ["deployed Base proof/domain/message/nonce/token/finality binding weakness or material exact backing mismatch", "permissionless path to mint, unlock, transfer, or borrow against the affected asset", "exact unwind, borrow, redeem, or liquidation economics positive after costs", "fork extraction proof"], nextReadOnlyStep: "Reopen Base Bridge only if a deployed proof-binding weakness or exact backing mismatch maps to material consumer economics; otherwise proceed to BitU Protocol." },
  { key: "sankoBridgePhase0", id: "sanko-bridge-phase0-sweep", protocol: "Sanko Bridge", chain: "Arbitrum", surface: "Bridge custody-owner dynamic-token Phase 0 backing/proof and consumer join", baseScore: 31, watchFields: ["watchCandidates"], researchFields: ["ownerRows", "ownersWithCode", "tokenRows", "dynamicTokenRows", "materialTokenRows", "artifactJoinRows", "custodySpecificJoinRows", "bridgeSpecificJoinRows"], liquidityFields: ["defillamaCurrentTvlUsd", "trackedOwnerBalanceUsd", "defillamaTokenUsd"], closedStatus: "sanko-bridge-phase0-no-route-positive", watchStatus: "sanko-bridge-watch-needs-custody-proof-economics", sourceArtifacts: ["reports/raw/fast/sanko-bridge-phase0.json"], blockers: ["Adapter exposes two Arbitrum custody owners with dynamic token discovery, not a proof verifier or permissionless bridge entry point", "No Sanko-specific custody/proof/balance-delta weakness is proven", "Token consumer joins are common-token/context rows without Sanko-specific impact", "Dynamic token coverage is bounded to known tokens plus recent owner Transfer logs", "No exact positive bridge, borrow, redemption, liquidation, or DEX unwind route", "No fork extraction proof"], requiredForRoutePositive: ["Sanko-specific custody/proof/balance-delta weakness or material exact backing mismatch", "permissionless path to mint, unlock, transfer, borrow, redeem, or liquidate against affected assets", "exact route economics positive after gas/slippage/fees", "fork extraction proof"], nextReadOnlyStep: "Reopen Sanko Bridge only if a custody/proof/balance-delta weakness or exact backing mismatch maps to a permissionless consumer route with exact positive economics." },
  { key: "moonwellLendingPhase0", id: "moonwell-lending-phase0-sweep", protocol: "Moonwell Lending", chain: "Base/Optimism", surface: "Compound-style market/oracle/cap/liquidation Phase 0 scan", baseScore: 39, watchFields: ["watchCandidates", "materialSampledLiquidatableBorrowers"], researchFields: ["marketRows", "listedRows", "highCfBorrowableRows", "highCfSingleFeedRows", "sampledBorrowers", "logErrorRows"], liquidityFields: ["defillamaCurrentTvlUsd", "totalCashUsd", "totalBorrowsUsd"], edgeFields: ["divergentRows", "staleButAcceptedRows"], closedStatus: "moonwell-lending-phase0-no-route-positive", watchStatus: "moonwell-lending-watch-needs-oracle-divergence-or-liquidation-economics", sourceArtifacts: ["reports/raw/fast/moonwell-lending-phase0.json"], blockers: ["High-CF and Chainlink/feed rows are configuration context without a current accepted-value divergence plus exact positive borrow or liquidation economics", "Bounded recent borrower sampling is not exhaustive and found no material liquidatable borrower", "Moonbeam, Ethereum docs-only, and Moonriver deprecated/sunset scope are caveated outside the declared Base/Optimism pass", "No fork extraction proof"], requiredForRoutePositive: ["specific Moonwell market accepts an attacker-favorable stale or divergent oracle/accounting value", "borrow or liquidation path is unpaused and has material live liquidity", "collateral acquisition, borrow/repay, seized asset exit, and unwind are exact-quoted after gas/slippage/fees", "fork extraction proof"], nextReadOnlyStep: "Keep Moonwell on high-CF/oracle/liquidation watch; exact-quote/fork only if a material market or borrower becomes exact-positive." },
  { key: "fraxUsdPhase0", id: "frax-usd-phase0-sweep", protocol: "Frax USD", chain: "Ethereum", surface: "RWA/NAV frxUSD Phase 0 backing/oracle/consumer join", baseScore: 34, watchFields: ["watchCandidates"], researchFields: ["tokensScanned", "backingTokenRows", "aaveFrxUsdBorrowerRows", "artifactJoinRows"], liquidityFields: ["defillamaCurrentTvlUsd", "topDexLiquidityUsd", "aaveFrxUsdCashUsd", "aaveFrxUsdOwedUsd"], edgeFields: ["oraclePriceVsMarketBps", "sfrxUsdNavMarketDivergencePct"], closedStatus: "frax-usd-phase0-no-route-positive", watchStatus: "frax-usd-watch-needs-consumer-trigger-and-exact-economics", sourceArtifacts: ["reports/raw/fast/frax-usd-phase0.json"], blockers: ["frxUSD Aave V4 exposure is debt-side or zero-CF in observed rows; no collateral-side borrow extraction route is proven", "Aave V4 frxUSD borrower rows are not currently liquidatable and no exact liquidation route is quote-required", "frxUSD oracle path is capped Chainlink/AggregatorV3-compatible with no permissionless update surface proven", "sfrxUSD NAV/market state is not joined to material consumer economics or exact positive redemption/DEX route"], requiredForRoutePositive: ["frxUSD or sfrxUSD accepted by a material collateral, redemption, liquidation, or margin consumer", "permissionless oracle/NAV/backing divergence or currently liquidatable borrower condition", "exact acquisition, borrow/repay, redeem/liquidate, and exit economics positive after costs", "fork extraction proof"], nextReadOnlyStep: "Reopen Frax USD only if a material frxUSD/sfrxUSD consumer trigger appears, Aave V4 borrowers cross HF < 1 with exact economics, or a permissionless oracle/NAV/backing divergence maps to live liquidity." },
  { key: "worldChainBridgePhase0", id: "world-chain-bridge-phase0-sweep", protocol: "World Chain", chain: "Ethereum -> World Chain", surface: "Canonical OP-stack bridge Phase 0 lockbox/backing/proof and consumer join", baseScore: 35, watchFields: ["watchCandidates"], researchFields: ["contractsScanned", "tokenPairsScanned", "materialContextDeltaRows", "artifactJoinRows", "bridgeSpecificJoinRows"], liquidityFields: ["defillamaCurrentTvlUsd"], closedStatus: "bridge-phase0-no-route-positive", watchStatus: "bridge-phase0-watch-needs-proof-binding-economics", sourceArtifacts: ["reports/raw/fast/world-chain-bridge-phase0.json"], blockers: ["No World Chain-specific proof-acceptance, finality, domain, nonce, or token-binding bypass identified", "WLD bridge balance and World Chain supply are close and not a material exact backing mismatch", "Native ETH and ERC20 custody reads are context only without a permissionless mint/unlock route", "Common token consumer joins are not bridge-specific exploit evidence without a backing/proof flaw", "No exact positive bridge, borrow, redemption, liquidation, or DEX unwind economics"], requiredForRoutePositive: ["deployed World Chain proof/domain/message/nonce/token/finality binding weakness or material exact backing mismatch", "permissionless path to mint, unlock, transfer, or borrow against the affected asset", "exact unwind, borrow, redeem, or liquidation economics positive after costs", "fork extraction proof"], nextReadOnlyStep: "Reopen World Chain only if a deployed proof-binding weakness or exact backing mismatch maps to material consumer economics; otherwise proceed to the next Phase 0 target." },
  { key: "avalancheCoreBridgePhase0", id: "avalanche-core-bridge-phase0-sweep", protocol: "Avalanche Core Bridge", chain: "Ethereum -> Avalanche", surface: "SGX custody bridge Phase 0 backing/proof and consumer join", baseScore: 36, watchFields: ["watchCandidates"], researchFields: ["addressRows", "addressRowsWithCode", "tokenRows", "resolvedAvalancheTokenRows", "materialContextDeltaRows", "artifactJoinRows", "bridgeSpecificJoinRows"], liquidityFields: ["defillamaCurrentTvlUsd", "trackedL1BackingUsd", "defillamaTokenUsd"], closedStatus: "avalanche-core-bridge-phase0-no-route-positive", watchStatus: "avalanche-core-bridge-watch-needs-proof-binding-or-backing-economics", sourceArtifacts: ["reports/raw/fast/avalanche-core-bridge-phase0.json"], blockers: ["Official Ethereum and Avalanche bridge addresses are no-code custody endpoints in current read-only state", "No bridge-node signature, SGX, proof-domain, nonce, finality, token, or amount-binding bypass is proven", "Custody-vs-wrapped-supply deltas are context only without an exact permissionless mint/unlock route", "Common-token joins are not Avalanche-Bridge-specific impact without a bridge flaw", "No exact positive bridge, borrow, redemption, liquidation, or DEX unwind economics"], requiredForRoutePositive: ["Avalanche Bridge-specific proof/domain/nonce/token/finality or bridge-node-signature weakness, or material exact backing mismatch", "permissionless path to mint, unlock, transfer, borrow, redeem, or liquidate against affected assets", "exact unwind, borrow, redeem, or liquidation economics positive after costs", "fork extraction proof"], nextReadOnlyStep: "Reopen Avalanche Core Bridge only if a concrete bridge proof/signature/backing weakness maps to material consumer economics; otherwise proceed to Fluid Lending or the next public Phase 0 target." },
  { key: "metisBridgePhase0", id: "metis-bridge-phase0-sweep", protocol: "Metis Bridge", chain: "Ethereum -> Metis", surface: "Canonical bridge Phase 0 custody/proof and consumer join", baseScore: 35, watchFields: ["watchCandidates"], researchFields: ["contractRows", "tokenRows", "materialContextDeltaRows", "artifactJoinRows", "bridgeSpecificJoinRows"], liquidityFields: ["defillamaCurrentTvlUsd", "trackedBridgeBalanceUsd", "defillamaTokenUsd"], closedStatus: "bridge-phase0-no-route-positive", watchStatus: "bridge-phase0-watch-needs-proof-binding-economics", sourceArtifacts: ["reports/raw/fast/metis-bridge-phase0.json"], blockers: ["No Metis-specific proof-acceptance, domain, nonce, or token-binding bypass identified", "Adapter dynamic METIS token context is not a proven exact backing mismatch without token identity/backing invariant resolution", "Common token consumer joins are not bridge-specific exploit evidence without a backing/proof flaw", "No exact positive bridge, borrow, redemption, liquidation, or DEX unwind economics"], requiredForRoutePositive: ["deployed Metis bridge proof/domain/message/nonce/token binding weakness or material exact backing mismatch", "permissionless path to mint, unlock, transfer, or borrow against the affected asset", "exact unwind, borrow, redeem, or liquidation economics positive after costs", "fork extraction proof"], nextReadOnlyStep: "Reopen Metis Bridge only if a deployed proof-binding weakness or exact backing mismatch maps to material consumer economics; otherwise proceed to CCIP or the next Phase 0 target." },
  { key: "ccipPhase0", id: "ccip-phase0-sweep", protocol: "CCIP", chain: "Ethereum/Avalanche/Base/Arbitrum/BNB/Optimism/World Chain/Polygon/Linea/Sonic", surface: "CCIP TokenAdminRegistry LockRelease pool Phase 0 custody/proof and consumer join", baseScore: 36, watchFields: ["watchCandidates"], researchFields: ["chainsWithRpc", "configuredTokenRows", "lockReleasePoolRows", "materialLockReleasePoolRows", "artifactJoinRows", "ccipSpecificJoinRows", "localCcipSourceRows"], liquidityFields: ["defillamaCurrentTvlUsd", "totalLockReleaseUsd", "maxLockReleasePoolUsd"], closedStatus: "ccip-phase0-no-route-positive", watchStatus: "ccip-watch-needs-proof-binding-or-consumer-economics", sourceArtifacts: ["reports/raw/fast/ccip-phase0.json"], blockers: ["TokenAdminRegistry LockRelease balances are custody context, not a proof of forged message or permissionless unlock impact", "BurnMint/BurnWithFromMint pools need a deployed verifier/router/offramp weakness before they become extractable supply", "No CCIP-specific pool, registry, router, or local consumer join maps to exact positive borrow, redeem, unlock, liquidation, or unwind economics", "Common-token joins are context only without a CCIP-specific proof/accounting flaw", "No fork extraction proof"], requiredForRoutePositive: ["deployed CCIP TokenPool/router/offramp proof, domain, nonce, token, sender, or amount-binding weakness", "permissionless path to mint, unlock, transfer, borrow, redeem, or liquidate against the affected asset", "exact unwind, borrow, redeem, or liquidation economics positive after costs", "fork extraction proof"], nextReadOnlyStep: "Reopen CCIP only if a deployed CCIP proof-binding or TokenPool accounting weakness maps to material consumer economics; otherwise proceed to Venus Core Pool or the next Phase 0 target." },
  { key: "solvbtcPhase0", id: "solvbtc-phase0-sweep", protocol: "SolvBTC", chain: "Ethereum/BNB/Avalanche/Base/Arbitrum/Optimism/Polygon/Scroll/Linea/Ink/X Layer", surface: "SolvBTC wrapped BTC, CCIP token-pool, custody, proof-binding, wrapper supply, and consumer-join Phase 0", baseScore: 43, routePositiveFields: ["routePositive", "executableNow"], watchFields: ["watchCandidates", "consumerGradeJoinRows"], researchFields: ["tokenRows", "contractRows", "consumerJoinRows", "publicEconomicStaticSuccessRows"], liquidityFields: ["defillamaTvlUsd", "trackedDepositBalanceUsd"], closedStatus: "solvbtc-phase0-no-route-positive", watchStatus: "solvbtc-watch-needs-proof-bypass-accounting-or-exact-positive-consumer-economics", sourceArtifacts: ["reports/raw/fast/solvbtc-phase0.json", "reports/solvbtc-phase0-triage.md"], blockers: ["No forged proof, mint, unlock, bridge accounting, or wrapper-supply bypass is proven for current SolvBTC/CCIP rows", "Consumer joins are watch-only without a producer-side discount, accepted-value divergence, or exact acquisition anomaly", "Morpho SolvBTC/WBTC has high LLTV and material WBTC liquidity, but no exact-positive collateral acquisition, borrow, and unwind route is proven", "Benqi SolvBTC is mint/borrow paused with 0% collateral factor, and observed Euler EVK SolvBTC rows have zero or dust usable borrow cash", "X Layer SolvBTC coverage is blocked by missing sanitized RPC and is tracked in the RPC-blocked backlog", "No fork extraction proof"], requiredForRoutePositive: ["deployed SolvBTC or CCIP proof/domain/nonce/token/recipient/finality bypass or wrapper accounting edge", "affected SolvBTC wrapper accepted by a live lending, bridge, redemption, liquidation, or margin consumer with material usable liquidity", "exact acquisition, unlock, borrow, redeem, liquidation, and DEX/borrowed-asset exit economics positive after fees, caps, queues, finality, slippage, and gas", "fork/static proof before any live or signed action"], nextReadOnlyStep: "Run a targeted exact-output acquisition/economics snapshot for the Morpho SolvBTC/WBTC market, then only fork if a producer-side anomaly or accepted-value divergence makes the joined route exact-positive." },
  { key: "solvbtcAdminSurface", id: "solvbtc-admin-surface-sweep", protocol: "SolvBTC", chain: "Ethereum/BNB/Avalanche/Base/Arbitrum/Optimism/Polygon/Scroll/Linea/Ink", surface: "SolvBTC wrapper and CCIP token-pool owner/admin/beacon permissioned surface", baseScore: 33, routePositiveFields: ["routePositive", "executableNow"], watchFields: ["contractPrivilegedSurfaceRows", "eoaPrivilegedSurfaceRows"], researchFields: ["surfaceRows", "privilegedReferenceRows", "uniquePrivilegedAddresses", "upgradeReferenceRows"], liquidityFields: ["wrapperSupplyUsd"], closedStatus: "solvbtc-admin-surface-no-route-positive", watchStatus: "solvbtc-admin-watch-permissioned-context-only", sourceArtifacts: ["reports/raw/fast/solvbtc-admin-surface.json", "reports/solvbtc-admin-surface-triage.md"], blockers: ["Observed owner/admin/beacon controls are permissioned-risk context and not a public exploit route", "No EOA privileged reference was observed in the bounded wrapper/pool scan", "Contract owner/beacon thresholds, timelocks, and source details are not decoded in this bounded pass", "No public mint, unlock, arbitrary value movement, accounting bypass, accepted-value divergence, or exact positive economics", "No fork extraction proof"], requiredForRoutePositive: ["public SolvBTC or CCIP mint/unlock/accounting/proof path reachable by an unprivileged caller", "affected wrapper or pool has material trusted consumer liquidity or directly extractable custody", "exact positive economics after fees, slippage, caps, queues, finality, and gas", "fork/local proof before any live or signed action"], nextReadOnlyStep: "Decode owner/beacon contracts only for permissioned-risk disclosure context unless a public route-positive path appears." },
  { key: "usdcxPhase0", id: "usdcx-phase0-sweep", protocol: "USDCx / Circle xReserve", chain: "Ethereum", surface: "Circle xReserve USDC custody, withdrawal attestation, deposit-to-remote, and consumer-join Phase 0", baseScore: 38, routePositiveFields: ["routePositive", "executableNow"], watchFields: ["consumerJoinRows", "permissionlessProbeSuccessRows"], researchFields: ["contractRows", "permissionlessProbeRows", "consumerJoinRows", "blockers"], liquidityFields: ["defillamaCurrentTvlUsd", "usdcBalanceUsd"], closedStatus: "usdcx-phase0-no-route-positive", watchStatus: "usdcx-watch-needs-attestation-bypass-or-consumer-economics", sourceArtifacts: ["reports/raw/fast/usdcx-phase0.json", "reports/usdcx-phase0-triage.md"], blockers: ["Withdrawal path requires valid Circle-signed GatewayMinter attestation; no attestation bypass proven", "depositToRemote requires registered remote domain and supported token; USDC is custodied in GatewayWallet", "All state-changing functions are owner/pauser/registration-manager gated", "No xReserve address referenced by material trusted consumer in scanned local artifacts", "No public mint, burn, withdraw, drain, attestation, proof, domain, nonce, token, or accounting bypass proven", "No exact positive borrow, redemption, liquidation, or unwind economics", "No fork extraction proof"], requiredForRoutePositive: ["deployed Circle xReserve / GatewayMinter / GatewayWallet / TokenMessenger attestation, proof, domain, nonce, token, or accounting bypass reachable by unprivileged caller", "OR material trusted consumer accepts xReserve or custodied USDC with attacker-favorable accepted value and exact positive economics", "fork/local proof before any live or signed action"], nextReadOnlyStep: "Keep USDCx on Circle xReserve/GatewayMinter attestation and consumer-join watch; reopen only if an attestation/proof bypass or material consumer listing appears with exact positive economics." },
  { key: "staderPhase0", id: "stader-phase0-sweep", protocol: "Stader", chain: "Ethereum/BNB Chain/Polygon/Fantom", surface: "Liquid staking ETH vault, node operator registry, SD collateral pool, and SD token Phase 0", baseScore: 36, routePositiveFields: ["routePositive", "executableNow"], watchFields: ["consumerJoinRows", "totalProbeSuccesses"], researchFields: ["contractRows", "codePresentRows"], liquidityFields: ["defillamaCurrentTvlUsd"], closedStatus: "stader-phase0-no-route-positive", watchStatus: "stader-watch-needs-consumer-or-permissionless-surface", sourceArtifacts: ["reports/raw/fast/stader-phase0.json", "reports/stader-phase0-triage.md"], blockers: ["Only Ethereum has on-chain contract addresses; BNB/Polygon/Fantom use Stader Labs API", "ETH vault, SD collateral pool, and node operator registry are permission-gated staking infrastructure", "0/32 permissionless probes succeeded across 4 contracts", "No Stader-specific contract address joined to material trusted consumers", "No exact positive borrow, liquidation, redemption, or unwind economics", "No fork extraction proof"], requiredForRoutePositive: ["deployed Stader contract with permissionless mint/burn/withdraw/redeem path", "OR SD/ETHx token accepted by material trusted consumer with attacker-favorable accepted value", "exact positive economics after costs", "fork proof"], nextReadOnlyStep: "Close Stader as dormant. Move to next fresh target." },
  { key: "venusCorePoolPhase0", id: "venus-core-pool-phase0-sweep", protocol: "Venus Core Pool", chain: "BNB/Ethereum/Arbitrum/Base/Optimism/Unichain/zkSync/opBNB", surface: "Venus Core Pool market/oracle/cap/liquidation Phase 0 scan", baseScore: 39, watchFields: ["watchCandidates", "materialSampledLiquidatableBorrowers"], researchFields: ["marketRows", "highCfBorrowableRows", "highCfSingleOracleBorrowableRows", "sampledBorrowers"], liquidityFields: ["defillamaCurrentTvlUsd", "totalCashUsd", "totalBorrowsUsd"], closedStatus: "venus-core-pool-phase0-no-route-positive", watchStatus: "venus-core-watch-needs-oracle-divergence-or-liquidation-economics", sourceArtifacts: ["reports/raw/fast/venus-core-pool-phase0.json"], blockers: ["High-CF rows do not prove accepted-value overpricing or cheap manipulation by themselves", "Single-source oracle rows require a current stale/divergent accepted value plus exact positive borrow/liquidation economics", "Bounded recent borrower sampling is not exhaustive and found no fork-proven exact positive liquidation route", "Wrapper/PT/LST rows remain blocked unless collateral, caps, pause state, acquisition, and exit economics all become favorable", "No fork extraction proof"], requiredForRoutePositive: ["specific Venus market accepts an attacker-favorable stale/divergent oracle or accounting value", "borrow or liquidation path is permissionless, unpaused, and has material live liquidity", "collateral acquisition and borrowed/seized asset exit are exact-quoted after gas/slippage/fees", "fork extraction proof"], nextReadOnlyStep: "Keep Venus Core Pool on oracle/liquidation watch; exact-quote/fork only if a high-CF single-source row becomes accepted-divergent or a material liquidatable borrower appears." },
  { key: "venusFluxPhase0", id: "venus-flux-phase0-sweep", protocol: "Venus Flux", chain: "BNB Chain", surface: "Venus Flux Fluid-style Liquidity/fToken/vault/oracle/liquidation Phase 0 scan", baseScore: 40, watchFields: ["watchCandidates", "materialLiquidationHintRows"], researchFields: ["listedTokenRows", "vaultRowsResolved", "highCfBorrowableRows", "smartDebtHighCfRows", "positionSampleRows", "positionSampleDebtRows"], liquidityFields: ["defillamaCurrentTvlUsd", "totalBorrowUsd", "totalAvailableLiquidityUsd"], closedStatus: "venus-flux-phase0-no-route-positive", watchStatus: "venus-flux-watch-needs-liquidation-or-oracle-economics", sourceArtifacts: ["reports/raw/fast/venus-flux-phase0.json"], blockers: ["Venus Flux is Fluid-style venus-fluid, not a legacy Venus isolated PoolRegistry market", "High-CF and smart-debt vault rows are configuration context without a current accepted-value divergence or exact positive borrow/liquidation route", "Resolver liquidation hints are raw context only until exact quote normalization, route unwind, gas, slippage, and fork proof are added", "Bounded position sampling does not prove a liquidatable account with positive economics", "No fork extraction proof"], requiredForRoutePositive: ["specific Venus Flux vault accepts attacker-favorable stale, under-bound, or overvalued oracle/accounting state", "borrow or liquidation path is permissionless and has material live liquidity", "collateral acquisition, repay/borrow, seized asset exit, and unwind are exact-quoted after gas/slippage/fees", "fork extraction proof"], nextReadOnlyStep: "Keep Venus Flux on high-CF/oracle/liquidation watch; exact-quote/fork only if a material resolver liquidation or stale/overvalued vault row becomes exact-positive." },
  { key: "bendPhase0", id: "bend-phase0-sweep", protocol: "BEND", chain: "Berachain", surface: "Berachain Morpho Blue/PoL vault market, oracle, borrower, and consumer-join Phase 0 scan", baseScore: 40, watchFields: ["watchCandidates", "materialLiquidatableRows", "exactEconomicsRows"], researchFields: ["marketRows", "materialBorrowRows", "highLltvRows", "artifactJoinRows", "sampledPositions"], liquidityFields: ["defillamaCurrentTvlUsd", "totalBorrowCashUsd", "totalBorrowUsd"], edgeFields: ["staleFeedRows", "proofWeaknessRows"], closedStatus: "bend-phase0-no-route-positive", watchStatus: "bend-watch-needs-oracle-liquidation-or-accounting-economics", sourceArtifacts: ["reports/raw/fast/bend-phase0.json"], blockers: ["No BEND-specific oracle, vault, market-accounting, or PoL integration weakness proven", "High-LLTV and material-cash Morpho rows are context only without a current attacker-favorable oracle/accounting trigger", "Bounded recent-log borrower sampling is not exhaustive and found no material liquidatable borrower", "No exact positive repay, liquidation seize, collateral exit, borrow, redemption, or DEX unwind economics", "No fork extraction proof"], requiredForRoutePositive: ["specific BEND market accepts stale, manipulable, under-bound, or overvalued oracle/accounting state, or a material borrower is currently liquidatable", "collateral acquisition or liquidation repay path is permissionless and exact-quoted", "borrowed or seized asset exit is positive after gas/slippage/fees", "fork extraction proof"], nextReadOnlyStep: "Reopen BEND only if a material liquidatable borrower, stale/manipulable oracle row, or accepted-value divergence maps to exact positive economics; otherwise proceed to the next public Phase 0 target." },
  { key: "saturnSusdatPhase0", id: "saturn-susdat-phase0-sweep", protocol: "saturn SUSDAT", chain: "Ethereum", surface: "Saturn USDat/sUSDat backing, ERC4626 accounting, DEX, Pendle, CCIP, and consumer-join Phase 0 scan", baseScore: 39, watchFields: ["watchCandidates", "exactEconomicsRows"], researchFields: ["artifactJoinRows", "saturnSpecificJoinRows", "pendleJoinRows", "ccipJoinRows", "materialJoinRows"], liquidityFields: ["yieldPoolTvlUsd", "topDexLiquidityUsd", "usdatBackingUsd", "strcBackingUsd"], edgeFields: ["usdatBackingVsMarketBps", "susdatBackingVsYieldPpsBps", "yieldPoolApyPct"], closedStatus: "saturn-susdat-phase0-no-route-positive", watchStatus: "saturn-susdat-watch-needs-backing-consumer-or-redemption-economics", sourceArtifacts: ["reports/raw/fast/saturn-susdat-phase0.json"], blockers: ["Public APY and share-price movement are not impact without a trusted consumer route or permissionless redemption edge", "USDat backing and sUSDat STRC accounting are context only until mint/redeem/liquidation/borrow economics are exact and permissionless", "Pendle, CCIP, DEX, and local artifact joins are consumer leads, not proof of a proof-binding, accounting, or accepted-value exploit", "No material current liquidatable borrower or exact positive borrow/redeem/liquidation/unwind route was proven", "No fork extraction proof"], requiredForRoutePositive: ["specific USDat/sUSDat accepted-value, backing, oracle, bridge, or ERC4626 accounting divergence with permissionless impact", "trusted consumer with material borrow, redemption, liquidation, bridge, or DEX unwind liquidity", "exact acquisition, borrow/repay, redeem/liquidate, and exit economics positive after gas/slippage/fees", "fork extraction proof"], nextReadOnlyStep: "Reopen saturn only if USDat/sUSDat backing, STRC accounting, Pendle maturity state, bridge proof state, or a trusted consumer listing creates exact positive borrow, redemption, liquidation, or unwind economics." },
  { key: "portalPhase0", id: "portal-phase0-sweep", protocol: "Portal", chain: "Ethereum/BNB/Polygon/Base/Avalanche/Arbitrum/Optimism/Celo", surface: "Wormhole/Portal Token Bridge peer, custody, Token-2022 residual, proof-binding, and consumer-join Phase 0 scan", baseScore: 39, watchFields: ["watchCandidates", "balanceBelowOutstandingRows", "nonzeroWrapperRows"], researchFields: ["artifactJoinRows", "proofWeaknessRows", "wrapperProbeRows", "peerRows", "custodyRows"], liquidityFields: ["defillamaCurrentTvlUsd", "totalSampledCustodyUsd", "publicChainTvlUsd"], edgeFields: ["peerMismatchRows", "concreteMismatchRows", "exactEconomicsRows"], closedStatus: "portal-phase0-no-route-positive", watchStatus: "portal-watch-needs-proof-backing-or-wrapper-economics", sourceArtifacts: ["reports/raw/fast/portal-phase0.json"], blockers: ["Guardian quorum and peer-contract checks do not expose a public forged-proof or replay path in the current EVM state", "Sampled custody balances and outstanding-wrapped rows are context only unless a Portal-specific backing mismatch is proven", "The Solana Token-2022 fee-mint residual still has no nonzero priority EVM wrapper in this refresh", "Static proof-binding rows are research leads only; no deployed proof-acceptance row has exact positive economics", "No fork extraction proof"], requiredForRoutePositive: ["deployed Portal proof/domain/nonce/token/finality weakness or material exact backing mismatch", "permissionless path to mint, unlock, transfer, borrow, redeem, liquidate, or unwind affected assets", "exact route economics positive after gas/slippage/fees", "fork extraction proof"], nextReadOnlyStep: "Reopen Portal only if a deployed proof/domain/nonce/token/finality weakness, material exact backing mismatch, or Token-2022 residual with nonzero wrapped liquidity maps to permissionless exact-positive economics." },
  { key: "apolloAcredPhase0", id: "apollo-acred-phase0-sweep", protocol: "Apollo/Securitize ACRED", chain: "Ethereum/Ink/Avalanche/Polygon", surface: "RWA ACRED Phase 0 token/NAV supply and consumer join", baseScore: 34, watchFields: ["watchCandidates"], researchFields: ["tokenRows", "erc4626LikeRows", "oracleLikeRows", "materialSupplyMismatchRows", "artifactJoinRows"], liquidityFields: ["defillamaCurrentTvlUsd", "topDexLiquidityUsd"], closedStatus: "rwa-acred-phase0-no-route-positive", watchStatus: "rwa-acred-watch-needs-consumer-trigger-and-exact-economics", sourceArtifacts: ["reports/raw/fast/apollo-acred-phase0.json"], blockers: ["ACRED token supply matches public DeFiLlama context with no material supply mismatch", "No ACRED address joined to material lending, margin, redemption, or liquidation consumers in scanned local artifacts", "ACRED is not ERC4626-like or oracle-like in the observed EVM token deployments", "No public DEX liquidity rows or exact positive acquisition/redeem/unwind economics", "RWA issuance/redemption remains treated as permissioned absent a public atomic exit proof"], requiredForRoutePositive: ["ACRED accepted by a material lending, margin, redemption, or liquidation consumer", "permissionless NAV/oracle/backing divergence or current liquidatable borrower condition", "exact acquisition, borrow/repay, redeem/liquidate, and exit economics positive after costs", "fork extraction proof"], nextReadOnlyStep: "Reopen ACRED only if a material consumer listing appears, an oracle/NAV/backing divergence maps to liquidity, or public exit liquidity becomes exact-positive." },
  { key: "sxRollupBridgePhase0", id: "sx-rollup-bridge-phase0-sweep", protocol: "SX Rollup Bridge", chain: "Ethereum", surface: "Bridge custody-owner Phase 0 balances/proof and consumer join", baseScore: 31, watchFields: ["watchCandidates"], researchFields: ["ownerRows", "ownersWithCode", "tokenRows", "artifactJoinRows", "custodySpecificJoinRows"], liquidityFields: ["defillamaCurrentTvlUsd", "trackedOwnerBalanceUsd"], closedStatus: "bridge-custody-phase0-no-route-positive", watchStatus: "bridge-custody-watch-needs-proof-binding-economics", sourceArtifacts: ["reports/raw/fast/sx-rollup-bridge-phase0.json"], blockers: ["No SX-specific proof/custody bypass or exact backing mismatch proven", "DeFiLlama adapter exposes custody owners but no permissionless mint/unlock path in this bounded pass", "USDC/WETH joins are common-token context only without bridge-specific impact", "SX/GRG balances lack material consumer acceptance and exact positive exit economics", "No fork extraction proof"], requiredForRoutePositive: ["deployed SX bridge/custody proof weakness or material exact backing mismatch", "permissionless path to mint, unlock, transfer, or borrow against the affected asset", "exact unwind, borrow, redeem, or liquidation economics positive after costs", "fork extraction proof"], nextReadOnlyStep: "Reopen SX Rollup Bridge only if a custody/proof weakness or exact backing mismatch maps to material consumer economics." },
  { key: "usddPhase0", id: "usdd-phase0-sweep", protocol: "USDD", chain: "Ethereum/BNB Chain", surface: "Stablecoin PSM/backing/depeg and consumer join Phase 0", baseScore: 34, watchFields: ["watchCandidates"], researchFields: ["tokenRows", "backingRows", "contractRows", "erc4626LikeRows", "directConsumerRows", "artifactJoinRows"], liquidityFields: ["defillamaCurrentTvlUsd", "evmBackingUsd", "topDexLiquidityUsd"], edgeFields: ["maxUsddDepegBps"], closedStatus: "usdd-phase0-no-route-positive", watchStatus: "usdd-watch-needs-depeg-or-backing-trigger-and-exact-economics", sourceArtifacts: ["reports/raw/fast/usdd-phase0.json"], blockers: ["No material USDD depeg, oracle divergence, or backing mismatch is mapped to an extractive consumer route", "No permissionless PSM mint/redeem edge with exact positive economics is proven", "sUSDD Morpho and Pendle appearances are consumer leads only without positive borrow/liquidation/unwind economics", "BNB Venus context is not a proven borrow extraction route without exact market config, borrower state, oracle divergence, and positive economics", "No fork extraction proof"], requiredForRoutePositive: ["USDD/sUSDD accepted by material lending, margin, redemption, or liquidation consumer", "permissionless depeg/oracle/backing/NAV trigger", "exact acquisition, borrow/repay, redeem/liquidate, and exit economics positive after costs", "fork extraction proof"], nextReadOnlyStep: "Reopen USDD only if a material depeg/oracle/backing/NAV trigger maps to live borrow, liquidation, redemption, or margin liquidity with exact positive economics." },
  { key: "txflowBridgePhase0", id: "txflow-bridge-phase0-sweep", protocol: "TxFlow Bridge", chain: "Arbitrum", surface: "Bridge custody-wallet Phase 0 backing/proof and consumer join", baseScore: 30, watchFields: ["watchCandidates"], researchFields: ["walletRows", "walletRowsWithCode", "selectorHintRows", "tokenRows", "artifactJoinRows", "custodySpecificJoinRows"], liquidityFields: ["defillamaCurrentTvlUsd", "trackedWalletBalanceUsd"], closedStatus: "txflow-bridge-phase0-no-route-positive", watchStatus: "txflow-bridge-watch-needs-custody-proof-economics", sourceArtifacts: ["reports/raw/fast/txflow-bridge-phase0.json"], blockers: ["Adapter exposes a single Arbitrum USDC system-wallet balance, not a proof verifier or permissionless bridge entry point", "No TxFlow-specific custody/proof/balance-delta weakness is proven", "USDC consumer joins are common-token context without TxFlow-specific impact", "No exact positive bridge, borrow, redemption, liquidation, or DEX unwind route", "No fork extraction proof"], requiredForRoutePositive: ["TxFlow-specific custody/proof/balance-delta weakness or material exact backing mismatch", "permissionless path to mint, unlock, transfer, borrow, redeem, or liquidate against affected assets", "exact route economics positive after gas/slippage/fees", "fork extraction proof"], nextReadOnlyStep: "Reopen TxFlow only if a custody/proof/balance-delta weakness or material exact backing mismatch maps to a permissionless consumer route with exact positive economics." },
  { key: "frankencoinPhase0", id: "frankencoin-phase0-sweep", protocol: "Frankencoin", chain: "Ethereum", surface: "Oracle-free CDP/challenge/bridge Phase 0 consumer join", baseScore: 34, watchFields: ["watchCandidates"], researchFields: ["activePositionRows", "expiredPositionRows", "activeChallengeRows", "bridgeRows", "directConsumerRows", "artifactJoinRows"], liquidityFields: ["defillamaCurrentTvlUsd", "topDexLiquidityUsd", "totalBridgeBackingZchf"], closedStatus: "frankencoin-phase0-no-route-positive", watchStatus: "frankencoin-watch-needs-challenge-bridge-consumer-economics", sourceArtifacts: ["reports/raw/fast/frankencoin-phase0.json"], blockers: ["No active challenge or expired force-sale row maps to exact positive acquisition, bid, redemption, and DEX unwind economics", "Stablecoin bridge balances are backing context only; no permissionless bridge imbalance is route-positive", "ZCHF/FPS consumer joins are leads only without accepted-value divergence and live borrow/liquidation liquidity", "No fork extraction proof"], requiredForRoutePositive: ["active challenge, expired force-sale, bridge-reserve, or consumer listing trigger with permissionless impact", "exact ZCHF/collateral acquisition, borrow/redeem/liquidation, and DEX exit economics positive after costs", "no cooldown, challenge-period, role, or capital-lock blocker for the selected route", "fork extraction proof"], nextReadOnlyStep: "Reopen Frankencoin only if an active challenge, expired force-sale row, bridge reserve mismatch, or ZCHF/FPS consumer listing maps to live liquidity with exact positive acquisition, borrow/redeem/liquidation, and unwind economics." },
  { key: "invescoUstbPhase0", id: "invesco-ustb-phase0-sweep", protocol: "Invesco USTB", chain: "Ethereum", surface: "RWA/NAV USTB Phase 0 consumer graph", baseScore: 32, watchFields: ["watchCandidates"], researchFields: ["producersInput", "producersResolved", "producersCodePresent", "matches", "reviewCandidates"], liquidityFields: ["defillamaCurrentTvlUsd"], closedStatus: "rwa-ustb-phase0-no-route-positive", watchStatus: "rwa-ustb-watch-needs-liquidity-or-nav-trigger", sourceArtifacts: ["reports/raw/fast/invesco-ustb-phase0.json"], blockers: ["Only discovered USTB consumer is an empty Morpho collateral market with zero supply, borrow, and liquidity", "No ERC4626 NAV interface or current NAV/reference divergence was resolved", "RWA mint/redeem/transfer remains treated as permissioned absent a public atomic exit proof", "No exact positive acquisition, borrow, liquidation, redemption, or unwind economics", "No fork extraction proof"], requiredForRoutePositive: ["USTB accepted by a material live lending, margin, redemption, or liquidation consumer", "permissionless NAV/oracle/reference divergence or current liquidatable borrower condition", "exact acquisition, borrow/repay, redeem/liquidate, and exit economics positive after costs", "fork extraction proof"], nextReadOnlyStep: "Reopen Invesco USTB only if USTB gains material live borrow/liquidation/redeem liquidity, an oracle/NAV/reference divergence appears, or a permissionless exit route becomes exact-positive after costs." },
  { key: "listaCdpPhase0", id: "lista-cdp-phase0-sweep", protocol: "Lista CDP", chain: "BNB Chain", surface: "Maker-style lisUSD CDP vault-list/oracle/liquidation Phase 0 scan", baseScore: 40, watchFields: ["watchCandidates"], researchFields: ["vaultListRows", "uniqueOwners", "materialBalanceRows", "priorOracleResidualRows", "priorListaDexWatchCandidates"], liquidityFields: ["defillamaCurrentTvlUsd", "trackedBalanceUsd", "lisUsdPriorDexLiquidityUsd"], edgeFields: ["lisUsdMaxPriorDexDepegBps"], closedStatus: "lista-cdp-phase0-no-route-positive", watchStatus: "lista-cdp-watch-needs-position-or-oracle-trigger", sourceArtifacts: ["reports/raw/fast/lista-cdp-phase0.json"], blockers: ["Public CDP adapter exposes vault token/owner balances, not borrower-level vault health or liquidation queue state", "Existing Lista oracle issue is timing-dependent and current pass does not prove stale-but-accepted accepted-value divergence", "Prior Lista DEX/Moolah smart-lending rows are consumer joins only without exact positive manipulation/borrow/exit economics", "No permissionless lisUSD redemption, liquidation, or CDP unwind path is exact-quoted positive", "No fork extraction proof"], requiredForRoutePositive: ["specific Lista CDP position, vault, oracle, or lisUSD peg state exposes a permissionless value-changing trigger", "collateral acquisition/liquidation/redemption/borrow path is live and unblocked", "borrowed, redeemed, or seized assets have exact positive DEX/repay/unwind economics after costs", "fork extraction proof"], nextReadOnlyStep: "Keep Lista CDP on lisUSD peg, vault-list, and oracle residual watch; exact-quote only if borrower/position data or a live stale/depeg trigger appears." },
  { key: "listaDexPhase0", id: "lista-dex-phase0-sweep", protocol: "Lista DEX", chain: "BNB Chain/Ethereum", surface: "Moolah smart-lending DEX-pool collateral consumer graph", baseScore: 34, watchFields: ["watchCandidates"], researchFields: ["activeSmartMarketRows", "directConsumerRows", "singleCollateralOracleRows", "highLltvRows"], liquidityFields: ["defillamaCurrentTvlUsd", "maxPoolTvlUsd", "maxBorrowLiquidityUsd"], closedStatus: "lista-dex-phase0-no-route-positive", watchStatus: "lista-dex-watch-needs-provider-sensitivity-and-economics", sourceArtifacts: ["reports/raw/fast/lista-dex-phase0.json"], blockers: ["Lista smart-lending pools are consumer joins, not proof that pool/provider valuation can be moved profitably", "Single collateral-provider rows require static/fork proof of attacker-favorable price movement", "No exact acquisition, manipulation, borrow, and borrowed-asset exit economics are positive", "Existing Lista oracle stale/pivot conditions are not currently met", "No fork extraction proof"], requiredForRoutePositive: ["permissionless pool/provider valuation movement or currently exploitable stale oracle state", "accepted Moolah collateral value exceeds exact acquisition/manipulation cost after LLTV haircut", "borrow-side liquidity and exit route are material and exact-quoted", "fork extraction proof"], nextReadOnlyStep: "Inspect top provider/dexInfo bytecode and run valuation sensitivity only for watch rows; fork only after an exact-positive route appears." },
  { key: "joeV22Phase0", id: "joe-v22-phase0-sweep", protocol: "Joe V2.2", chain: "Avalanche/Arbitrum", surface: "Liquidity Book pair and oracle-consumer Phase 0 scan", baseScore: 32, watchFields: ["watchCandidates"], researchFields: ["materialPairRows", "oracleEnabledRows", "hookEnabledRows", "directLbConsumerRows", "tokenContextRows"], liquidityFields: ["defillamaCurrentTvlUsd", "maxPoolTvlUsd"], closedStatus: "joe-v22-phase0-no-route-positive", watchStatus: "joe-v22-watch-needs-lb-consumer-and-economics", sourceArtifacts: ["reports/raw/fast/joe-v22-phase0.json"], blockers: ["No Joe V2.2 LB pair address is referenced by scanned lending/oracle consumer artifacts", "Token-level matches are common-asset context and not Joe-specific impact", "Native LB flash loans and bin movement need an external trusted consumer before they matter", "No exact positive acquisition, manipulation, borrow, and exit economics or fork proof"], requiredForRoutePositive: ["deployed lending, vault, margin, or oracle consumer references a Joe V2.2 LB pair or LB oracle state", "pair or oracle state is permissionlessly movable or stale in an attacker-favorable direction", "borrow, redemption, liquidation, or settlement route is exact-quoted and positive", "fork extraction proof"], nextReadOnlyStep: "Reopen Joe V2.2 only if a lending/oracle consumer references an LB pair or a new adapter consumes LB oracle state." },
  { key: "balancerV3Phase0", id: "balancer-v3-phase0-sweep", protocol: "Balancer V3", chain: "Ethereum/Arbitrum/Base/Avalanche/Optimism/Gnosis", surface: "Pool, hook, ERC4626, and rate-provider consumer graph", baseScore: 33, watchFields: ["watchCandidates"], researchFields: ["materialPoolRows", "erc4626TokenRows", "rateProviderRows", "hookEnabledRows", "tokenContextRows"], liquidityFields: ["defillamaCurrentTvlUsd", "maxPoolTvlUsd"], closedStatus: "balancer-v3-phase0-no-route-positive", watchStatus: "balancer-v3-watch-needs-consumer-and-economics", sourceArtifacts: ["reports/raw/fast/balancer-v3-phase0.json"], blockers: ["No Balancer V3 pool, hook, or rate-provider match currently has exact-positive manipulation and consumer economics", "Token-level matches are common-asset context and not Balancer-specific impact", "Donation/unbalanced-liquidity/rate-provider rows need static or fork proof that accepted value moves attacker-favorably", "No exact positive acquisition, manipulation, borrow, and exit economics or fork proof"], requiredForRoutePositive: ["deployed consumer references a Balancer V3 pool, BPT, hook, or rate provider", "referenced Balancer V3 state is permissionlessly movable, stale, donation-sensitive, or rounding-sensitive", "borrow, redemption, liquidation, or settlement route is exact-quoted and positive", "fork extraction proof"], nextReadOnlyStep: "Reopen Balancer V3 only if a consumer references a Balancer pool/hook/rate-provider or a new adapter consumes Balancer V3 state." },
  { key: "uniswapV2Phase0", id: "uniswap-v2-phase0-sweep", protocol: "Uniswap V2", chain: "Ethereum/Base/Polygon/Arbitrum/BNB/Optimism/Avalanche/Celo/Unichain", surface: "V2 pair/LP and oracle-consumer Phase 0 scan", baseScore: 33, watchFields: ["watchCandidates"], researchFields: ["materialPairRows", "publicYieldRows", "directPairConsumerRows", "tokenContextRows"], liquidityFields: ["defillamaCurrentTvlUsd", "maxPoolTvlUsd"], closedStatus: "uniswap-v2-phase0-no-route-positive", watchStatus: "uniswap-v2-watch-needs-lp-consumer-and-economics", sourceArtifacts: ["reports/raw/fast/uniswap-v2-phase0.json"], blockers: ["No Uniswap V2 pair/LP address is referenced by scanned consumer-grade artifacts", "Token-level matches are common-asset context and not Uniswap-specific impact", "Public yield APY and V2 reserves do not prove accepted-value divergence or extractive consumer economics", "No exact positive acquisition, manipulation, borrow, and exit economics or fork proof"], requiredForRoutePositive: ["deployed consumer references a Uniswap V2 pair/LP or V2 oracle path", "pair or oracle state is permissionlessly movable or stale in attacker-favorable direction", "borrow, redemption, liquidation, or settlement route is exact-quoted and positive", "fork extraction proof"], nextReadOnlyStep: "Reopen Uniswap V2 only if a lending/oracle consumer references a V2 pair/LP or a new adapter consumes V2 oracle state." },
  { key: "uniswapV3Phase0", id: "uniswap-v3-phase0-sweep", protocol: "Uniswap V3", chain: "Ethereum/Base/Polygon/Arbitrum/BNB/Optimism", surface: "V3 pool/TWAP and oracle-consumer Phase 0 scan", baseScore: 34, watchFields: ["watchCandidates"], researchFields: ["materialPoolRows", "publicYieldRows", "directPoolConsumerRows", "tokenContextRows"], liquidityFields: ["defillamaCurrentTvlUsd", "maxPoolTvlUsd"], closedStatus: "uniswap-v3-phase0-no-route-positive", watchStatus: "uniswap-v3-watch-needs-pool-consumer-and-economics", sourceArtifacts: ["reports/raw/fast/uniswap-v3-phase0.json"], blockers: ["No Uniswap V3 pool address is referenced by scanned consumer-grade artifacts", "Token-level matches are common-asset context and not Uniswap-specific impact", "Public yield APY and V3 pool token balances do not prove accepted-value divergence or extractive consumer economics", "No exact positive acquisition, manipulation, borrow, and exit economics or fork proof"], requiredForRoutePositive: ["deployed consumer references a Uniswap V3 pool, TWAP, or NFT-position value path", "pool or oracle state is permissionlessly movable or stale in attacker-favorable direction", "borrow, redemption, liquidation, or settlement route is exact-quoted and positive", "fork extraction proof"], nextReadOnlyStep: "Reopen Uniswap V3 only if a lending/oracle consumer references a V3 pool/TWAP or a new adapter consumes V3 state." },
  { key: "pancakeswapAmmPhase0", id: "pancakeswap-amm-phase0-sweep", protocol: "PancakeSwap AMM", chain: "BNB/Ethereum/Base/Arbitrum/Linea", surface: "V2-style pair/LP and oracle-consumer Phase 0 scan", baseScore: 34, watchFields: ["watchCandidates"], researchFields: ["materialPairRows", "publicYieldRows", "directPairConsumerRows", "tokenContextRows"], liquidityFields: ["defillamaCurrentTvlUsd", "maxPoolTvlUsd"], closedStatus: "pancakeswap-amm-phase0-no-route-positive", watchStatus: "pancakeswap-amm-watch-needs-lp-consumer-and-economics", sourceArtifacts: ["reports/raw/fast/pancakeswap-amm-phase0.json"], blockers: ["No PancakeSwap AMM pair/LP address is referenced by scanned consumer-grade artifacts", "Token-level matches are common-asset context and not PancakeSwap-specific impact", "Public yield APY and V2 reserves do not prove accepted-value divergence or extractive consumer economics", "No exact positive acquisition, manipulation, borrow, and exit economics or fork proof"], requiredForRoutePositive: ["deployed consumer references a PancakeSwap AMM pair/LP or V2 oracle path", "pair or oracle state is permissionlessly movable or stale in attacker-favorable direction", "borrow, redemption, liquidation, or settlement route is exact-quoted and positive", "fork extraction proof"], nextReadOnlyStep: "Reopen PancakeSwap AMM only if a lending/oracle consumer references a Pancake pair/LP or a new adapter consumes Pancake V2 state." },
  { key: "pancakeswapAmmV3Phase0", id: "pancakeswap-amm-v3-phase0-sweep", protocol: "PancakeSwap AMM V3", chain: "BNB/Ethereum/Base/Arbitrum/Linea", surface: "V3 pool/TWAP and oracle-consumer Phase 0 scan", baseScore: 34, watchFields: ["watchCandidates"], researchFields: ["materialPoolRows", "publicYieldRows", "directPoolConsumerRows", "tokenContextRows"], liquidityFields: ["defillamaCurrentTvlUsd", "maxPoolTvlUsd"], closedStatus: "pancakeswap-amm-v3-phase0-no-route-positive", watchStatus: "pancakeswap-amm-v3-watch-needs-pool-consumer-and-economics", sourceArtifacts: ["reports/raw/fast/pancakeswap-amm-v3-phase0.json"], blockers: ["No PancakeSwap AMM V3 pool address is referenced by scanned consumer-grade artifacts", "Token-level matches are common-asset context and not PancakeSwap-specific impact", "Public yield APY and V3 pool token balances do not prove accepted-value divergence or extractive consumer economics", "No exact positive acquisition, manipulation, borrow, and exit economics or fork proof"], requiredForRoutePositive: ["deployed consumer references a PancakeSwap AMM V3 pool, TWAP, or NFT-position value path", "pool or oracle state is permissionlessly movable or stale in attacker-favorable direction", "borrow, redemption, liquidation, or settlement route is exact-quoted and positive", "fork extraction proof"], nextReadOnlyStep: "Reopen PancakeSwap AMM V3 only if a lending/oracle consumer references a Pancake V3 pool/TWAP or a new adapter consumes Pancake V3 state." },
  { key: "pancakeswapInfinityPhase0", id: "pancakeswap-infinity-phase0-sweep", protocol: "PancakeSwap Infinity", chain: "BNB/Base", surface: "Hook-based PoolManager/Vault and consumer-route Phase 0 scan", baseScore: 34, watchFields: ["watchCandidates"], researchFields: ["poolRows", "materialPoolContextRows", "hookRows", "hookRowsWithCode", "tokenRows", "materialTokenRows", "directConsumerRows", "tokenContextRows"], liquidityFields: ["defillamaCurrentTvlUsd", "totalVaultBalanceUsd", "maxVaultTokenBalanceUsd"], closedStatus: "pancakeswap-infinity-phase0-no-route-positive", watchStatus: "pancakeswap-infinity-watch-needs-manager-vault-hook-consumer-economics", sourceArtifacts: ["reports/raw/fast/pancakeswap-infinity-phase0.json"], blockers: ["Infinity pools are bytes32 IDs in a shared manager/vault architecture, not standalone LP/pool contracts", "No Infinity vault, pool manager, or hook address is referenced by scanned consumer-grade artifacts", "Token-level matches are common-asset context and not Infinity-specific impact", "Vault token balances do not prove per-pool manipulability or accepted-value divergence without a consumer that reads Infinity state", "No exact positive borrow, redemption, liquidation, settlement, or DEX unwind economics or proof"], requiredForRoutePositive: ["deployed consumer references Infinity vault, manager, hook, pool ID, or accounting state", "referenced state is permissionlessly movable, stale, hook-manipulable, or otherwise attacker-favorable", "borrow, redemption, liquidation, bridge, settlement, or unwind route is exact-quoted and positive", "fork/local proof"], nextReadOnlyStep: "Reopen PancakeSwap Infinity only if a consumer references Infinity vault, manager, hook, pool ID, or accounting state." },
  { key: "ekuboPhase0", id: "ekubo-phase0-sweep", protocol: "Ekubo", chain: "Ethereum/Starknet", surface: "Ethereum owner/token custody and consumer-route Phase 0 scan", baseScore: 31, watchFields: ["watchCandidates"], researchFields: ["ownersScanned", "ownersWithCode", "trackedTokenRows", "materialBalanceRows", "ownerSpecificJoinRows", "tokenContextRows"], liquidityFields: ["defillamaCurrentTvlUsd", "trackedKnownBalanceUsd", "nativeBalanceUsd"], closedStatus: "ekubo-phase0-no-route-positive", watchStatus: "ekubo-watch-needs-owner-or-cross-domain-consumer-economics", sourceArtifacts: ["reports/raw/fast/ekubo-phase0.json"], blockers: ["Ethereum adapter surface is owner/token custody context, not an EVM AMM pool factory", "No Ekubo owner address is referenced by scanned consumer-grade artifacts", "Token-level matches are common-asset context and not Ekubo-specific impact", "No exact positive bridge, borrow, redemption, liquidation, settlement, or DEX unwind economics or proof"], requiredForRoutePositive: ["deployed consumer references Ekubo owner, receipt, LP/accounting state, or cross-domain message path", "referenced state is permissionlessly movable or stale in attacker-favorable direction", "borrow, redemption, bridge, liquidation, or settlement route is exact-quoted and positive", "fork/local proof"], nextReadOnlyStep: "Reopen Ekubo only if an EVM/cross-domain consumer references Ekubo owner, receipt, LP/accounting, or message state." },
  { key: "thorchainDexPhase0", id: "thorchain-dex-phase0-sweep", protocol: "Thorchain DEX", chain: "Thorchain/Ethereum/BNB/Avalanche/Base", surface: "Midgard EVM asset/token and inbound router/vault Phase 0 scan", baseScore: 31, watchFields: ["watchCandidates"], researchFields: ["evmPoolRows", "materialPoolRows", "tokenRows", "tokenRowsWithCode", "inboundRows", "vaultAddressRows", "inboundBalanceRows", "inboundSpecificJoinRows", "tokenContextRows"], liquidityFields: ["defillamaCurrentTvlUsd", "maxPoolTvlUsd", "totalEvmLiquidityUsd", "inboundVaultBalanceUsd"], closedStatus: "thorchain-dex-phase0-no-route-positive", watchStatus: "thorchain-dex-watch-needs-router-vault-consumer-economics", sourceArtifacts: ["reports/raw/fast/thorchain-dex-phase0.json"], blockers: ["Public adapter uses Midgard pool-depth data and no EVM AMM factory was identified", "Sanitized Thorchain endpoint returned current EVM inbound router/vault rows; no consumer-grade artifact referenced those Thorchain-specific addresses with value impact", "EVM token joins are common-asset context and not Thorchain-specific impact", "No deployed consumer was found that trusts Thorchain router, vault, synth, savers, or pool accounting state with exact positive economics", "No exact positive bridge, borrow, redemption, liquidation, settlement, or DEX unwind economics or proof"], requiredForRoutePositive: ["deployed consumer references Thorchain router/vault/pool/synth/savers state", "referenced state is permissionlessly movable, stale, under-bound, or otherwise attacker-favorable", "borrow, redemption, bridge, liquidation, settlement, or unwind route is exact-quoted and positive", "fork/local proof"], nextReadOnlyStep: "Reopen Thorchain DEX only if a consumer references Thorchain-specific router/vault/pool/synth/savers state or inbound state changes materially." },
  { key: "curveDexPhase0", id: "curve-dex-phase0-sweep", protocol: "Curve DEX", chain: "Ethereum/Arbitrum/Base/Polygon/Avalanche/Optimism/BNB/Celo/Sonic/Mantle/Hyperliquid", surface: "Curve pool/LP/gauge and oracle-consumer Phase 0 scan", baseScore: 35, watchFields: ["watchCandidates"], researchFields: ["materialPoolRows", "publicYieldRows", "directConsumerRows", "tokenContextRows", "usesRateOracleRows"], liquidityFields: ["defillamaCurrentTvlUsd", "maxPoolTvlUsd"], closedStatus: "curve-dex-phase0-no-route-positive", watchStatus: "curve-dex-watch-needs-pool-consumer-and-economics", sourceArtifacts: ["reports/raw/fast/curve-dex-phase0.json"], blockers: ["No Curve pool/LP/gauge address is referenced by scanned consumer-grade artifacts", "Coin-level matches are common-asset context and not Curve-specific impact", "Curve pool TVL, APY, virtual price, and rate-oracle context do not prove accepted-value divergence or extractive consumer economics", "No exact positive acquisition, manipulation, borrow, and exit economics or fork proof"], requiredForRoutePositive: ["deployed consumer references a Curve pool, LP token, gauge, or pool oracle path", "pool or oracle state is permissionlessly movable or stale in attacker-favorable direction", "borrow, redemption, liquidation, or settlement route is exact-quoted and positive", "fork extraction proof"], nextReadOnlyStep: "Reopen Curve DEX only if a lending/oracle consumer references a Curve pool/LP/gauge or a new adapter consumes Curve state." },
  { key: "quickswapDexPhase0", id: "quickswap-dex-phase0-sweep", protocol: "Quickswap Dex", chain: "Polygon/Base", surface: "V2-style pair/LP and oracle-consumer Phase 0 scan", baseScore: 33, watchFields: ["watchCandidates"], researchFields: ["materialPairRows", "publicYieldRows", "directPairConsumerRows", "tokenContextRows"], liquidityFields: ["defillamaCurrentTvlUsd", "maxPoolTvlUsd"], closedStatus: "quickswap-dex-phase0-no-route-positive", watchStatus: "quickswap-dex-watch-needs-lp-consumer-and-economics", sourceArtifacts: ["reports/raw/fast/quickswap-dex-phase0.json"], blockers: ["No Quickswap Dex pair/LP address is referenced by scanned consumer-grade artifacts", "Token-level matches are common-asset context and not Quickswap-specific impact", "Public yield APY and V2 reserves do not prove accepted-value divergence or extractive consumer economics", "No exact positive acquisition, manipulation, borrow, and exit economics or fork proof"], requiredForRoutePositive: ["deployed consumer references a Quickswap Dex pair/LP or V2 oracle path", "pair or oracle state is permissionlessly movable or stale in attacker-favorable direction", "borrow, redemption, liquidation, or settlement route is exact-quoted and positive", "fork extraction proof"], nextReadOnlyStep: "Reopen Quickswap Dex only if a lending/oracle consumer references a V2 pair/LP or a new adapter consumes Quickswap V2 state." },
  { key: "fluidDexPhase0", id: "fluid-dex-phase0-sweep", protocol: "Fluid DEX", chain: "Ethereum/Arbitrum/Base/Polygon", surface: "Fluid DEX resolver/share and consumer-route Phase 0 scan", baseScore: 34, watchFields: ["watchCandidates"], researchFields: ["materialDexRows", "fluidVaultConsumerRows", "externalDirectConsumerRows", "tokenContextRows"], liquidityFields: ["defillamaCurrentTvlUsd", "maxPoolTvlUsd"], closedStatus: "fluid-dex-phase0-no-route-positive", watchStatus: "fluid-dex-watch-needs-share-consumer-and-economics", sourceArtifacts: ["reports/raw/fast/fluid-dex-phase0.json"], blockers: ["No external Fluid DEX address is referenced by scanned consumer-grade artifacts", "Fluid VaultT2/T3/T4 rows are internal protocol-native consumers and prior triage found no positive donation/reserve-skew path", "Token-level matches are common-asset context and not Fluid DEX-specific impact", "No exact positive acquisition, share/reserve manipulation, borrow, and exit economics or fork proof"], requiredForRoutePositive: ["deployed consumer references a Fluid DEX address/share path or Fluid DEX oracle state", "Fluid DEX share/reserve state is permissionlessly movable or stale in attacker-favorable direction", "borrow, redemption, liquidation, or settlement route is exact-quoted and positive", "fork extraction proof"], nextReadOnlyStep: "Reopen Fluid DEX only if an external lending/oracle consumer references a Fluid DEX address/share path or a new adapter consumes Fluid DEX state." },
  { key: "aerodromeSlipstreamPhase0", id: "aerodrome-slipstream-phase0-sweep", protocol: "Aerodrome Slipstream", chain: "Base", surface: "CL pool/TWAP and oracle-consumer Phase 0 scan", baseScore: 34, watchFields: ["watchCandidates"], researchFields: ["materialPoolRows", "publicYieldRows", "directPoolConsumerRows", "tokenContextRows"], liquidityFields: ["defillamaCurrentTvlUsd", "maxPoolTvlUsd"], closedStatus: "aerodrome-slipstream-phase0-no-route-positive", watchStatus: "aerodrome-slipstream-watch-needs-pool-consumer-and-economics", sourceArtifacts: ["reports/raw/fast/aerodrome-slipstream-phase0.json"], blockers: ["No Aerodrome Slipstream pool address is referenced by scanned consumer-grade artifacts", "Token-level matches are common-asset context and not Aerodrome-specific impact", "Public yield APY and CL pool token balances do not prove accepted-value divergence or extractive consumer economics", "No exact positive acquisition, manipulation, borrow, and exit economics or fork proof"], requiredForRoutePositive: ["deployed consumer references an Aerodrome Slipstream pool, TWAP, or NFT-position value path", "pool or oracle state is permissionlessly movable or stale in attacker-favorable direction", "borrow, redemption, liquidation, or settlement route is exact-quoted and positive", "fork extraction proof"], nextReadOnlyStep: "Reopen Aerodrome Slipstream only if a lending/oracle consumer references a Slipstream pool/TWAP or a new adapter consumes Slipstream state." },
  { key: "aerodromeV1Phase0", id: "aerodrome-v1-phase0-sweep", protocol: "Aerodrome V1", chain: "Base", surface: "Stable/volatile pool LP and oracle-consumer Phase 0 scan", baseScore: 34, watchFields: ["watchCandidates"], researchFields: ["materialPoolRows", "publicYieldRows", "directPoolConsumerRows", "tokenContextRows"], liquidityFields: ["defillamaCurrentTvlUsd", "maxPoolTvlUsd"], closedStatus: "aerodrome-v1-phase0-no-route-positive", watchStatus: "aerodrome-v1-watch-needs-pool-consumer-and-economics", sourceArtifacts: ["reports/raw/fast/aerodrome-v1-phase0.json"], blockers: ["No Aerodrome V1 pool/LP address is referenced by scanned consumer-grade artifacts", "Token-level matches are common-asset context and not Aerodrome-specific impact", "Public yield APY and pool reserves do not prove accepted-value divergence or extractive consumer economics", "No exact positive acquisition, manipulation, borrow, and exit economics or fork proof"], requiredForRoutePositive: ["deployed consumer references an Aerodrome V1 pool/LP or oracle path", "pool or oracle state is permissionlessly movable or stale in attacker-favorable direction", "borrow, redemption, liquidation, or settlement route is exact-quoted and positive", "fork extraction proof"], nextReadOnlyStep: "Reopen Aerodrome V1 only if a lending/oracle consumer references a V1 pool/LP or a new adapter consumes Aerodrome V1 state." },
  { key: "velodromeV3Phase0", id: "velodrome-v3-phase0-sweep", protocol: "Velodrome V3", chain: "Optimism/Ink/Lisk/Unichain/Fraxtal/Celo/Soneium/Superseed/Mode/Swellchain", surface: "Stable/volatile pool LP and oracle-consumer Phase 0 scan", baseScore: 34, watchFields: ["watchCandidates"], researchFields: ["materialPoolRows", "directPoolConsumerRows", "tokenContextRows", "priceAnomalyRows"], liquidityFields: ["defillamaCurrentTvlUsd", "maxPoolTvlUsd"], closedStatus: "velodrome-v3-phase0-no-route-positive", watchStatus: "velodrome-v3-watch-needs-pool-consumer-and-economics", sourceArtifacts: ["reports/raw/fast/velodrome-v3-phase0.json"], blockers: ["No Velodrome V3 pool/LP address is referenced by scanned consumer-grade artifacts", "Token/factory/router-level matches are context and not Velodrome-specific impact", "Pool reserves and observation length do not prove accepted-value divergence or extractive consumer economics", "No exact positive acquisition/manipulation/borrow/exit economics or fork proof"], requiredForRoutePositive: ["deployed consumer references a Velodrome V3 pool, LP, or oracle value path", "pool/oracle state is permissionlessly movable or stale in attacker-favorable direction", "borrow, redemption, liquidation, or settlement route is exact-quoted and positive", "fork extraction proof"], nextReadOnlyStep: "Reopen Velodrome V3 only if a lending/oracle consumer references a Velodrome pool/LP or a new adapter consumes Velodrome state." },
  { key: "nadoSpotPhase0", id: "nado-spot-phase0-sweep", protocol: "Nado Spot", chain: "Ink", surface: "Custody/engine balance and consumer-route Phase 0 scan", baseScore: 31, watchFields: ["watchCandidates"], researchFields: ["contractsWithCode", "trackedTokens", "materialBalanceRows", "contractSpecificJoinRows", "tokenContextRows"], liquidityFields: ["defillamaCurrentTvlUsd", "trackedCustodyBalanceUsd", "maxCustodyTokenBalanceUsd"], closedStatus: "nado-spot-phase0-no-route-positive", watchStatus: "nado-spot-watch-needs-custody-engine-consumer-economics", sourceArtifacts: ["reports/raw/fast/nado-spot-phase0.json"], blockers: ["Adapter exposes custody/engine balances, not an AMM pool factory", "No Nado-specific contract address is referenced by scanned consumer-grade artifacts", "USDT0/WETH/KBTC/USDC joins are common-asset context without Nado-specific impact", "Clearinghouse and endpoint balances do not prove a permissionless custody, accounting, oracle, or settlement weakness", "No exact positive bridge, borrow, redemption, liquidation, settlement, or DEX unwind economics or proof"], requiredForRoutePositive: ["deployed consumer references Nado custody, engine, endpoint, account, or settlement state, or a Nado-specific permissionless state/balance weakness is proven", "referenced state is permissionlessly movable, stale, under-bound, or otherwise attacker-favorable", "borrow, redemption, bridge, liquidation, or settlement route is exact-quoted and positive", "fork/local proof"], nextReadOnlyStep: "Reopen Nado Spot only if a consumer references Nado custody/engine/accounting state or a Nado-specific permissionless state weakness appears." },
  { key: "threeFPhase0", id: "3f-phase0-sweep", protocol: "3F", chain: "Ethereum", surface: "Wrapper-token TVL and Morpho collateral consumer Phase 0 scan", baseScore: 34, watchFields: ["watchCandidates"], researchFields: ["validWrapperPairs", "materialBalanceRows", "wrapperConsumerRows", "tokenContextRows"], liquidityFields: ["defillamaCurrentTvlUsd", "trackedWrapperBalanceUsd", "maxWrapperBalanceUsd"], closedStatus: "3f-phase0-no-route-positive", watchStatus: "3f-morpho-collateral-watch-needs-exact-economics", sourceArtifacts: ["reports/raw/fast/3f-phase0.json"], blockers: ["3F wrapper collateral rows exist in Morpho Blue, but scanned economics remain watch-only", "Existing Morpho exit-liquidity stress found no routed exact-output acquisition quote for wJAAA", "Wrapper balances do not prove a permissionless redemption, mint, accounting, oracle, or settlement weakness", "No exact positive borrow, redemption, liquidation, settlement, or DEX unwind economics or proof"], requiredForRoutePositive: ["3F wrapper state or wrapper-specific oracle path is attacker-favorable", "borrow-side liquidity is material and unpaused", "collateral acquisition and borrowed-asset exit are exact-quoted", "gas/slippage/flash-fee adjusted economics are positive", "fork/local proof"], nextReadOnlyStep: "Keep 3F on Morpho collateral watch; exact-quote only if wrapper acquisition/redeem/NAV/oracle state becomes attacker-favorable." },
  { key: "siloV2Phase0", id: "silo-v2-phase0-sweep", protocol: "Silo V2", chain: "Ethereum/Arbitrum/Avalanche/Sonic", surface: "Lending factory/config high-LTV Phase 0 scan", baseScore: 36, watchFields: ["watchCandidates"], researchFields: ["configsEnumerated", "siloRows", "materialAssetRows", "highLtvPairRows"], liquidityFields: ["defillamaCurrentTvlUsd"], closedStatus: "silo-v2-phase0-no-route-positive", watchStatus: "silo-v2-high-ltv-watch-needs-oracle-and-exact-economics", sourceArtifacts: ["reports/raw/fast/silo-v2-phase0.json"], blockers: ["Watch rows are high-LTV/material-lending shapes only and do not prove stale, manipulable, or overvalued oracle state", "Arbitrum inventory used idToSiloConfig fallback because NewSilo RPC logs were empty despite live factory IDs", "Adapter bad-debt rows are excluded from TVL and are not treated as exploitable collateral routes", "No exact positive collateral acquisition, borrow, liquidation, redemption, DEX unwind economics, or fork proof"], requiredForRoutePositive: ["specific Silo V2 market uses stale, manipulable, under-bound, or otherwise attacker-favorable oracle/accounting state", "borrow-side liquidity is material and unpaused", "collateral acquisition, borrow, and unwind or liquidation route are exact-quoted after gas/slippage/fees", "fork/local proof"], nextReadOnlyStep: "Decode oracle adapters for top high-LTV watch rows and exact-quote only if accepted collateral value is attacker-favorable." },
  { key: "harmonixPhase0", id: "harmonix-phase0-sweep", protocol: "Harmonix Finance", chain: "Ethereum/Arbitrum/Base/Hyperliquid", surface: "Factory/vault/yield allocator Phase 0 consumer-route scan", baseScore: 31, watchFields: ["watchCandidates"], researchFields: ["factoryRows", "vaultRows", "yieldRows", "directConsumerRows", "tokenContextRows"], liquidityFields: ["defillamaCurrentTvlUsd", "factoryAggregateTvlUsd", "vaultResolvedTvlUsd", "yieldTvlUsd"], closedStatus: "harmonix-phase0-no-route-positive", watchStatus: "harmonix-watch-needs-vault-consumer-and-exact-economics", sourceArtifacts: ["reports/raw/fast/harmonix-phase0.json"], blockers: ["Adapter state is aggregate factory/vault TVL context, not a lending or AMM value source by itself", "Harmonix vault shares use custom/queued-withdrawal accounting rather than a proven same-block ERC4626 redemption path", "No Harmonix factory/vault address is referenced by scanned consumer-grade artifacts", "Underlying-token joins are common-asset yield context only", "No exact positive borrow, redemption, liquidation, settlement, or DEX unwind economics or proof"], requiredForRoutePositive: ["deployed consumer references Harmonix vault/factory/share accounting state", "shares are permissionlessly acquirable and accepted by a material borrower, redeemer, liquidator, or settlement path", "withdrawal or unwind path is exact-quoted and positive after fees, queue delay, slippage, and gas", "fork/local proof"], nextReadOnlyStep: "Reopen Harmonix only if a consumer references Harmonix vault/factory/share state or a public same-epoch exit route becomes exact-positive." },
  { key: "eulerV2Phase0", id: "euler-v2-phase0-sweep", protocol: "Euler V2", chain: "Ethereum/Base/Sonic/Unichain/Berachain/Avalanche/BNB/Arbitrum/Linea/Mantle/Hyperliquid", surface: "EVK factory/vault/LTV live-state Phase 0 scan", baseScore: 38, watchFields: ["watchCandidates"], researchFields: ["vaultRows", "materialBorrowCashRows", "highLtvPairRows", "externalEulerSpecificContextRows", "assetContextRows"], liquidityFields: ["defillamaCurrentTvlUsd", "totalBorrowCashUsd", "totalBorrowsUsd"], closedStatus: "euler-v2-phase0-no-route-positive", watchStatus: "euler-v2-high-ltv-watch-needs-oracle-and-exact-economics", sourceArtifacts: ["reports/raw/fast/euler-v2-phase0.json"], blockers: ["High LTV plus borrow cash is watch-only without an attacker-favorable oracle/accounting trigger", "No exact positive collateral acquisition, borrow, liquidation, redemption, settlement, or DEX unwind economics", "Unsupported adapter chains make the live-state pass bounded rather than exhaustive protocol-wide proof", "No fork/local extraction proof"], requiredForRoutePositive: ["specific Euler vault pair uses stale, manipulable, under-bound, or otherwise attacker-favorable oracle/accounting state", "collateral acquisition is permissionless and exact-quoted", "borrow-side liquidity and borrowed-asset exit are positive after gas/slippage/fees", "fork/local proof"], nextReadOnlyStep: "Decode oracle adapters for top high-LTV/material-cash watch rows and exact-quote only if accepted collateral value is attacker-favorable." },
  { key: "bridgeLendingCollateralJoin", id: "bridge-lending-collateral-join-sweep", protocol: "Bridge+Lending", chain: "multi-chain artifact", surface: "Bridge wrapper token as lending collateral consumer join", baseScore: 38, watchFields: ["watchCandidates"], researchFields: ["bridgeTokens", "lendingMatches"], closedStatus: "bridge-lending-join-no-route-positive", watchStatus: "bridge-lending-join-watch-needs-bridge-proof-and-economics", sourceArtifacts: ["reports/raw/fast/bridge-lending-collateral-join.json"], blockers: ["Bridge wrapper token — route depends on bridge security model", "No bridge manipulation proof", "No lending accepted-value edge", "No fork extraction proof"], requiredForRoutePositive: ["bridge wrapper token accepted as collateral by material lending consumer", "bridge security model weakness or balance-delta mismatch proven", "consumer state permits permissionless value extraction", "exact acquisition and exit economics positive after gas/slippage/fees", "fork/local extraction proof"], nextReadOnlyStep: "Prove bridge security weakness or balance-delta mismatch for top watch candidate rows; only then model exact borrow/exit economics and fork." },
  { key: "morphoFlashloanTokenOverlap", id: "morpho-flashloan-token-overlap-sweep", protocol: "Morpho Blue", chain: "Ethereum", surface: "0-fee flashLoan token overlap ranker across Morpho LRT rows and external consumers", baseScore: 39, watchFields: ["watchCandidates"], researchFields: ["morphoRows", "rowsWithAnyOverlap", "rowsWithLoanAssetOverlap", "rowsWithCollateralOverlap"], liquidityFields: ["topRouteLiquidityUsd"], closedStatus: "morpho-flashloan-overlap-no-exact-route", watchStatus: "morpho-flashloan-overlap-watch-needs-exact-economics", sourceArtifacts: ["reports/raw/fast/morpho-flashloan-token-overlap.json"], blockers: ["Token overlaps are leads only and do not prove an extractive route", "No overlap clears LLTV break-even premium even after removing external flash-fee bps", "Existing Morpho liquidation executor uses Balancer flash loans, not Morpho flashLoan", "No exact cross-protocol borrow/deposit/unwind quote", "No fork extraction proof"], requiredForRoutePositive: ["Morpho flashLoan asset is available with enough same-block liquidity", "overlapped consumer accepts the same asset or collateral in an unpaused public path", "accepted value exceeds acquisition/reference value after LTV/LLTV and zero flash fee", "exact unwind quote is positive after gas/slippage/caps", "fork proof demonstrates positive net extraction"], nextReadOnlyStep: "Only exact-quote top overlap rows if an accepted-value premium or stale/oracle condition appears; do not build a Morpho flashLoan executor until route economics are positive." },
  { key: "twoMarketLeverageLoops", id: "two-market-leverage-loop-sweep", protocol: "Euler EVK", chain: "Ethereum/multichain artifact", surface: "Reciprocal two-market leverage-loop economics", baseScore: 37, watchFields: ["watchCandidates", "grossUncappedRows"], researchFields: ["reciprocalPairs", "directedCollateralEdges", "eulerVaultRows"], edgeFields: ["maxGrossLoopRatio", "topRankedGrossLoopRatio"], closedStatus: "two-market-loop-net-ratio-below-one", watchStatus: "two-market-loop-watch-needs-premium-and-quotes", sourceArtifacts: ["reports/raw/fast/two-market-leverage-loops.json"], blockers: ["No reciprocal pair has net loop ratio above 1 after costs", "Current top material pairs are finite amplification only", "No exact conversion/acquisition/unwind quote", "No fork extraction proof"], requiredForRoutePositive: ["net reciprocal loop ratio exceeds 1 after accepted/reference value, conversion quotes, gas, slippage, and flash fees", "both markets have material live cash and cap headroom", "deposit and borrow paths are public and unpaused", "exact conversion/acquisition/unwind route is positive at target size", "fork proof demonstrates positive net extraction"], nextReadOnlyStep: "Keep top Euler reciprocal rows on oracle/reference-premium watch; exact-quote/fork only if R_net can exceed 1." },
  { key: "nestCreditPhase0", id: "nest-credit-phase0-sweep", protocol: "Nest Credit", chain: "Ethereum/BNB Chain/Plasma", surface: "Vault-owner stablecoin balance and consumer-route Phase 0 scan", baseScore: 31, watchFields: ["watchCandidates"], researchFields: ["vaultRows", "tokenRows", "balanceRows", "directConsumerRows", "tokenContextRows"], liquidityFields: ["defillamaCurrentTvlUsd", "totalTrackedBalanceUsd"], closedStatus: "nest-credit-phase0-no-route-positive", watchStatus: "nest-credit-watch-needs-vault-consumer-or-custody-economics", sourceArtifacts: ["reports/raw/fast/nest-credit-phase0.json"], blockers: ["Adapter surface is vault-owner stablecoin balances, not a lending/oracle/AMM value source by itself", "No Nest vault-owner address was found in scanned consumer-grade artifacts", "Stablecoin token joins are common-asset context only and not Nest-specific impact", "Plasma USDT0 is outside current local RPC scope", "No exact positive borrow, redemption, liquidation, settlement, bridge, or DEX unwind economics or proof"], requiredForRoutePositive: ["deployed consumer references Nest vault-owner, receipt, NAV, redemption, or accounting state", "permissionless vault/custody/redeem/bridge weakness affects liquid asset balance", "exact unwind, borrow, redeem, bridge, or liquidation economics positive after costs", "fork/local proof"], nextReadOnlyStep: "Reopen Nest Credit only if a Nest-specific consumer or permissionless custody/redemption/bridge weakness appears; otherwise proceed to the next Phase 0 target." },
  { key: "compoundV3Phase0", id: "compound-v3-phase0-sweep", protocol: "Compound V3", chain: "Ethereum/Base/Arbitrum/Optimism/Polygon/Unichain/Scroll/Linea/Mantle", surface: "Comet market/oracle/collateral live-state Phase 0 scan", baseScore: 39, watchFields: ["watchCandidates"], researchFields: ["marketsScanned", "assetRows", "highCfRows", "configDriftRows", "borrowerRows"], liquidityFields: ["defillamaCurrentTvlUsd", "totalBaseCashUsd", "totalBorrowUsd"], closedStatus: "compound-v3-phase0-no-route-positive", watchStatus: "compound-v3-watch-needs-oracle-or-liquidation-economics", sourceArtifacts: ["reports/raw/fast/compound-v3-phase0.json"], blockers: ["High-CF collateral rows do not prove accepted-value overpricing or cheap manipulation", "Feed wrapper/rate-provider context needs source-specific manipulation or stale acceptance proof", "Recent borrower sampling is disabled/bounded and not exhaustive account-level liquidation coverage", "Current liquidatable or buyCollateral rows still need exact absorb/buy/exit economics and fork proof", "No exact positive borrow, liquidation, buyCollateral, redemption, DEX unwind economics, or proof"], requiredForRoutePositive: ["specific Comet collateral oracle/accounting path overvalues collateral or exposes profitable liquidation/buyCollateral state", "borrow-side base liquidity and collateral acquisition/exit liquidity are exact-quoted", "positive net value after gas, slippage, flash fees, and liquidation/buyCollateral sequencing", "fork/local proof"], nextReadOnlyStep: "Reopen Compound V3 if a high-CF oracle/rate wrapper becomes attacker-favorable, a sampled liquidatable account maps to exact positive absorb/buy/exit economics, or governance/config drift creates a concrete unsafe window." },
  { key: "paretoCreditPhase0", id: "pareto-credit-phase0-sweep", protocol: "Pareto Credit", chain: "Ethereum/Polygon/Arbitrum/Optimism", surface: "Credit-vault/tranche accounting and consumer-route Phase 0 scan", baseScore: 32, watchFields: ["watchCandidates"], researchFields: ["creditRows", "activeCreditRows", "factoryDiscoveredCreditVaults", "directConsumerRows", "tokenContextRows", "factoryLogErrors"], liquidityFields: ["defillamaCurrentTvlUsd", "trackedCreditUsd", "trancheLiabilityUsd", "uspTvlUsd"], closedStatus: "pareto-credit-phase0-no-route-positive", watchStatus: "pareto-credit-watch-needs-material-consumer-or-accounting-economics", sourceArtifacts: ["reports/raw/fast/pareto-credit-phase0.json"], blockers: ["Adapter surface is credit-vault/tranche accounting, not an open pooled borrower liquidation market", "Pareto address matches are context-only without trusted Pareto NAV, redemption, queue, tranche, or accounting state with exact economics", "Tranche liability versus tracked value is accounting context only without a permissionless redeem/borrow/liquidation route", "Underlying-token joins are common USDC/USDT-style context and not Pareto-specific impact", "No exact positive redemption, borrow, liquidation, settlement, bridge, or DEX unwind economics or proof"], requiredForRoutePositive: ["deployed consumer references Pareto vault, tranche, USP, queue, NAV, redemption, or accounting state", "permissionless vault/tranche/redeem/accounting weakness affects liquid assets or accepted collateral value", "exact borrow, redeem, liquidate, bridge, or unwind economics are positive after costs", "fork/local proof"], nextReadOnlyStep: "Reopen Pareto only if a Pareto-specific consumer appears, a permissionless tranche/redeem/accounting weakness is proven, or factory-discovered credit vault state maps to exact positive economics." },
  { key: "etherfiBorrowingPhase0", id: "etherfi-borrowing-phase0-sweep", protocol: "EtherFi Borrowing Market", chain: "Optimism/Scroll", surface: "Cash DebtManager safe-based lending and liquidation Phase 0 scan", baseScore: 34, watchFields: ["watchCandidates"], researchFields: ["borrowerRows", "materialLiquidatableRows", "nearLiquidationRows", "oracleDivergenceRows", "logErrors"], liquidityFields: ["defillamaCurrentTvlUsd", "totalBorrowUsd", "totalSupplyUsd"], closedStatus: "etherfi-borrowing-phase0-no-route-positive", watchStatus: "etherfi-borrowing-watch-needs-borrower-or-oracle-economics", sourceArtifacts: ["reports/raw/fast/etherfi-borrowing-phase0.json"], blockers: ["Borrowing is restricted to registered EtherFi Safes; arbitrary external borrow is not public", "No material collateralized liquidatable borrower with exact positive repay and collateral-exit economics was found", "Checked Chainlink feeds are not stale; custom/common collateral rows need accepted-value divergence plus exact route economics", "Stable/common-token collateral and borrow rows require exact oracle/acquisition/exit dislocation, not just high LTV", "No fork/local extraction proof"], requiredForRoutePositive: ["specific EtherFi collateral oracle/accounting path overvalues collateral or a material borrower becomes liquidatable", "repay token acquisition and seized-collateral exit are exact-quoted and positive after gas/slippage/fees", "borrow or liquidation path is permissionless for the selected account and not paused/capped/role-gated", "fork/local proof"], nextReadOnlyStep: "Reopen EtherFi Borrowing only if a material borrower crosses HF < 1, a collateral oracle/accounting path becomes attacker-favorable, or custom oracle state diverges enough to support exact positive liquidation/borrow economics." },
  { key: "felixCdpPhase0", id: "felix-cdp-phase0-sweep", protocol: "Felix CDP", chain: "Hyperliquid L1/HyperEVM", surface: "feUSD CDP branch/oracle/liquidation Phase 0 scan", baseScore: 36, watchFields: ["watchCandidates", "lastGoodFetchDivergenceRows"], researchFields: ["activeTroveRows", "liquidatableRows", "materialLiquidatableRows", "nearMcrRows", "consumerContextRows"], liquidityFields: ["defillamaCurrentTvlUsd", "totalFeUSDDebtUsd", "totalCollateralUsdAtFelixOracle", "totalStabilityPoolDepositsUsd"], bestNetFields: ["bestDirectGasCompNetUsd"], closedStatus: "felix-cdp-phase0-no-route-positive", watchStatus: "felix-cdp-watch-needs-fetchprice-liquidation-and-exact-economics", sourceArtifacts: ["reports/raw/fast/felix-cdp-phase0.json"], blockers: ["Execution-path liquidation uses fetchPrice(), not stale lastGoodPrice() context", "No current active trove is below branch MCR under fetchPrice()", "lastGood-vs-fetch divergence is context only unless the liquidation call path becomes liquidatable", "Felix-specific source was not found in public metadata; scope is bounded to public docs/live bytecode/upstream Liquity interfaces", "No exact positive liquidation caller-compensation, SP-deposit, redemption, borrow, or unwind route"], requiredForRoutePositive: ["specific Felix branch has material active troves below MCR under fetchPrice()", "batchLiquidateTroves static call succeeds for the selected rows", "caller compensation or SP-depositor route has exact positive unwind after gas/slippage/fees", "fork/local proof"], nextReadOnlyStep: "Keep Felix on execution-path oracle/liquidation watch; fork only if fetchPrice() creates material liquidatable rows with exact positive compensation economics." },
  { key: "erc4626Joiner", id: "erc4626-consumer-joiner-sweep", protocol: "ERC4626", chain: "Ethereum/Base", surface: "Low-TVL ERC4626 vault consumer joins", baseScore: 34, researchFields: ["vaultsInput"], sourceArtifacts: ["reports/raw/fast/erc4626-consumer-joiner.json"], blockers: ["No linked low-TVL vault with liquid borrow route", "Consumer joins are not route-positive"] },
  { key: "newVaultDonationAttack", id: "new-vault-donation-attack-sweep", protocol: "ERC4626", chain: "Ethereum/Base", surface: "New/low-TVL ERC4626 donation-inflation route scanner", baseScore: 36, watchFields: ["watchCandidates"], researchFields: ["consumerLinkedRows", "collateralConsumerRows", "lowTvlConsumerRows", "preforkDonationPositive", "recentFactoryVaults"], bestNetFields: ["bestModeledNetUsd"], closedStatus: "no-low-tvl-collateral-consumer", watchStatus: "watch-candidate-needs-exact-route-and-fork", sourceArtifacts: ["reports/raw/fast/new-vault-donation-attack.json"], blockers: ["No consumer-linked low-TVL collateral vault in current scan", "Linked rows are loan-side, live-grown, deposit-closed, or borrow-liquidity constrained", "No fork-positive donation route proof"], requiredForRoutePositive: ["new or low-TVL ERC4626 vault has public share acquisition", "vault shares are accepted as collateral by a liquid lending consumer", "LLTV-adjusted borrow value exceeds seed + donation + gas + slippage", "local fork proof demonstrates extractable net profit"], nextReadOnlyStep: "Keep monitoring recent factory deployments and rerun with wider caps after material changes; fork only if watchCandidates or preforkDonationPositive becomes positive and exact borrow/exit economics validate." },
  { key: "erc4626V4HookOverlaps", id: "erc4626-v4-hook-overlap-sweep", protocol: "ERC4626 / Uniswap V4", chain: "Ethereum/Base", surface: "ERC4626 low-TVL vault and V4 pool/hook overlaps", baseScore: 26, researchFields: ["hookOverlaps", "currentLowTvlVaultAlerts"], sourceArtifacts: ["reports/raw/fast/erc4626-v4-hook-overlaps.json"], blockers: ["Overlaps are not actual hook-controlled vault rows", "No route-positive borrow/exit path"] },
  { key: "consumerFirstHighLtv", id: "consumer-first-high-ltv-sweep", protocol: "Lending consumers", chain: "multi-chain", surface: "High-LTV collateral consumer graph", baseScore: 32, researchFields: ["reviewCandidates", "highLtvRows"], sourceArtifacts: ["reports/raw/fast/consumer-first-high-ltv-collateral.json"], blockers: ["High-LTV review rows lack positive producer/NAV/DEX economics", "No route-positive fork target"] },
  { key: "postAuditNewMarketDrift", id: "post-audit-new-market-drift-sweep", protocol: "Post-audit market drift", chain: "multi-chain artifact", surface: "New Morpho/Euler/Silo market or vault drift since the 2026-06-24 high-LTV baseline", baseScore: 41, routePositiveFields: ["routePositive", "executableNow"], watchFields: ["watchCandidates"], watchScale: 20, researchFields: ["marketsScanned", "vaultsScanned", "factoryLogRows", "recentMarketRows", "recentVaultRows", "highLtvRows", "materialBorrowRows", "customOracleRows", "lowTvlCollateralRows", "consumerJoinRows", "donationSensitiveRows"], researchScale: 2500, quoteFields: ["exactEconomicsRows", "forkProofRows"], liquidityFields: ["bestRouteLiquidityUsd", "maxBorrowCashUsd"], closedStatus: "post-audit-new-market-drift-no-route-positive", watchStatus: "post-audit-new-market-drift-watch-needs-exact-economics", sourceArtifacts: ["reports/raw/fast/post-audit-new-market-drift.json", "reports/post-audit-new-market-drift-triage.md", "reports/raw/fast/consumer-first-high-ltv-collateral.json", "reports/raw/fast/recent-morpho-create-markets.json", "reports/raw/fast/euler-v2-phase0.json", "reports/raw/fast/silo-v2-phase0.json", "reports/raw/fast/new-vault-donation-attack.json", "reports/raw/fast/evault-donation-sensitivity.json", "reports/raw/fast/erc4626-consumer-joiner.json", "reports/raw/fast/market-launch-choreography-routes.json"], blockers: ["Watch candidates are drift leads only and do not prove accepted-value overvaluation", "Direct log discovery is bounded; artifact evidence dominates until refreshed factory coverage is available", "No exact collateral acquisition, borrow, and exit economics are positive", "No fork/local value-delta proof; signed action remains unjustified"], requiredForRoutePositive: ["post-baseline market/vault creation or configuration is confirmed on chain", "new market is high-LTV/LLTV with material borrow-side liquidity and unblocked public paths", "collateral has an attacker-favorable donation, stale/custom oracle, or ERC4626 accounting path", "collateral acquisition/deposit, borrow, and exit routes are exact-quoted after slippage/fees/gas", "fork/local proof demonstrates positive net value without privileged actions"], nextReadOnlyStep: "Decode oracle/producer paths and exact-quote acquisition plus borrow/exit only for the 17 watch candidates; fork only after exact economics become positive." },
  { key: "crossProtocolComposition", id: "cross-protocol-composition-sweep", protocol: "Cross-protocol lending composition", chain: "multi-chain artifact", surface: "Artifact-only 3+ hop receipt/vault/bridge/PT token -> lending market -> lending market -> terminal exit composition scanner", baseScore: 42, routePositiveFields: ["routePositive", "executableNow"], watchFields: ["watchCandidates"], watchScale: 40, researchFields: ["candidateChains", "crossProtocolChains", "highSignalChains", "rootProducerTokens", "lendingMarkets"], researchScale: 900, quoteFields: ["exactEconomicsRows", "forkProofRows"], liquidityFields: ["topMinHopLiquidityUsd"], closedStatus: "cross-protocol-composition-artifact-only-no-route-positive", watchStatus: "cross-protocol-composition-watch-needs-root-anomaly-exact-economics", sourceArtifacts: ["reports/raw/fast/cross-protocol-composition.json", "reports/cross-protocol-composition-triage.md", "reports/raw/fast/consumer-first-high-ltv-collateral.json", "reports/raw/fast/aave-euler-silo-consumer-graph.json", "reports/raw/fast/erc4626-consumer-joiner.json", "reports/raw/fast/pendle-pt-consumer-graph.json", "reports/raw/fast/pendle-pt-multichain-consumer-graph.json", "reports/raw/fast/bridge-lending-collateral-join.json", "reports/raw/fast/bridge-nonlossless-collateral-join.json", "reports/raw/fast/bridge-collateral-exposure.json"], blockers: ["Candidate chains are watch/context only without a proven root producer anomaly or accepted-value overvaluation", "Terminal exits are token-class hints only; no exact DEX/repay/unwind quote is present", "No exact multi-hop economics after gas/slippage/fees/caps and no local/fork value-delta proof", "Fork/executor/signed-action gates remain blocked while routePositive=0"], requiredForRoutePositive: ["same-chain or otherwise atomically executable multi-hop chain across at least two distinct protocols", "material hop liquidity/capacity on every lending leg", "proven root producer anomaly, accepted-value overvaluation, bridge/accounting mismatch, or permissionless manipulation trigger", "terminal borrowed-asset exit route exact-quoted after gas, slippage, fees, caps, and unwind costs", "exact positive economics plus local/fork value-delta proof before any executor or signed action"], nextReadOnlyStep: "For highest-signal watch rows, gather producer-specific anomaly evidence and exact terminal-exit quotes; do not fork until exact-positive economics exist." },
  { key: "smallCapOracleCurrentPaths", id: "small-cap-oracle-manipulation-sweep", protocol: "Lending oracle / DEX", chain: "multi-chain", surface: "Small-cap deployed oracle path coverage resolver", baseScore: 35, routePositiveFields: ["routePositive"], watchFields: ["uniqueRoutes.unresolved"], researchFields: ["uniqueRoutes.total", "uniqueRoutes.pathResolved", "uniqueRoutes.graphContainsChainlinkNode", "uniqueRoutes.graphContainsERC4626Node"], quoteFields: ["uniqueRoutes.exactEconomicsRoutes"], closedStatus: "small-cap-oracle-current-paths-coverage-complete-no-route-proof", watchStatus: "small-cap-oracle-watch-coverage-open-no-route-proof", sourceArtifacts: ["reports/raw/fast/small-cap-oracle-current-paths.json", "reports/small-cap-oracle-current-paths-triage.md", "reports/raw/fast/small-cap-oracle-manipulation-routes.json"], blockers: ["4 unresolved unique deployed oracle paths remain", "Zero exact DEX-linked paths", "Zero exact economics or fork proof"], requiredForRoutePositive: ["exact deployed DEX oracle link", "material borrow path", "positive exact economics", "fork proof"], nextReadOnlyStep: "Resolve the four open deployed oracle paths; exact-quote and fork only after a material borrow path is joined to an exact deployed DEX oracle link." },
  { key: "marketLaunchChoreography", id: "market-launch-choreography-sweep", protocol: "Lending market launch", chain: "multi-chain", surface: "Sonne-style market launch/config choreography route scanner", baseScore: 36, watchFields: ["exactLaunchOrderingRows", "exactAcquisitionRouteRows", "exactBorrowExitRouteRows", "exactEconomicsRows", "forkProofRows"], watchScale: 5, researchFields: ["watchCandidates", "preforkLaunchRisk", "lowProducerTvlRows", "lowMarketSupplyRows", "zeroCollateralRows", "recentProducerRows", "exactEconomicsNegativeRows"], researchScale: 120, liquidityFields: ["bestRouteLiquidityUsd"], closedStatus: "launch-order-research-only-no-exact-route", watchStatus: "launch-order-watch-needs-exact-economics-and-fork", sourceArtifacts: ["reports/raw/fast/market-launch-choreography-routes.json"], blockers: ["Current launch-risk rows are research leads, not exact unsafe transaction sequences", "Focused Euler rows with exact negative economics are closed, and remaining rows lack exact collateral acquisition plus borrow/exit quotes", "No exact positive economics or fork-positive launch simulation"], requiredForRoutePositive: ["governance or market-launch ordering creates a public deposit/borrow window before caps/oracles/pause constraints are safe", "exact unsafe transaction ordering is proven for a deployed market", "collateral acquisition is permissionless and exact-quoted", "borrow-side liquidity and exit route are material and exact-quoted", "gas/slippage-adjusted economics are positive", "fork extraction proof"], nextReadOnlyStep: "Treat current launch-risk rows as research-only; decode exact unsafe ordering plus collateral acquisition and borrow/exit quotes before any fork." },
  { key: "factoryLaunchDonationWatch", id: "factory-launch-donation-watch-sweep", protocol: "Vault factories / Silo", chain: "multi-chain", surface: "ResupplyFi-style factory launch/donation watch", baseScore: 35, watchFields: ["watchCandidates"], researchFields: ["factoryCandidates", "vaultRows", "siloRows", "lowTvlVaultRows", "depositOpenVaultRows", "preforkDonationPositive"], bestNetFields: ["bestModeledNetUsd"], closedStatus: "no-current-factory-donation-route", watchStatus: "factory-launch-watch-needs-exact-simulation-and-fork", sourceArtifacts: ["reports/raw/fast/factory-launch-donation-watch.json"], blockers: ["Only watch row is a Silo config row requiring protocol-specific oracle/deposit/borrow simulation", "No prefork donation-positive vault row", "No exact acquisition, borrow, and exit economics or fork proof"], requiredForRoutePositive: ["new or low-TVL collateral producer is permissionlessly acquirable", "producer is accepted by a material lending consumer", "donation/share-price or launch-order math is positive after LTV haircut, gas, and slippage", "borrow and exit routes are exact-quoted", "fork extraction proof"], nextReadOnlyStep: "Keep factory rows on watch; add Silo-specific exact simulation only if a config row has material borrow liquidity plus exact PT/share acquisition economics." },
  { key: "governanceListingWatch", id: "governance-listing-watch-sweep", protocol: "Governance / listings", chain: "multi-chain", surface: "Sonne-style governance/listing proposal watch", baseScore: 27, watchFields: ["watchCandidates", "activeWatchCandidates", "recentWatchCandidates"], researchFields: ["proposalsScored"], closedStatus: "no-active-recent-listing-trigger", watchStatus: "governance-listing-watch-needs-onchain-payload-and-economics", sourceArtifacts: ["reports/raw/fast/governance-listing-watch.json"], blockers: ["No active or recent high-signal listing/config proposal in current Snapshot scan", "Snapshot text is not mapped to executable payloads or on-chain config changes", "No live collateral-consumer route economics or fork proof"], requiredForRoutePositive: ["active or recent listing/config payload changes collateral, oracle, LTV/LT, caps, or pause state", "target asset maps to a material lending consumer", "acquisition and exit routes are exact-quoted and positive", "fork extraction proof"], nextReadOnlyStep: "Refresh after new governance/risk proposals; decode on-chain payloads only if watchCandidates becomes positive." },
  { key: "governanceTimelockPayloads", id: "governance-timelock-payload-sweep", protocol: "Governance / timelocks", chain: "Ethereum", surface: "On-chain governance/timelock queued payload decoder", baseScore: 32, watchFields: ["activeCriticalPayloadRows", "lowDelayRows", "openExecutorRows"], researchFields: ["timelockRows", "queuedPayloadRows", "governorPayloadRows", "decodedCriticalPayloadRows"], researchScale: 10, closedStatus: "governance-payload-inventory-only-no-active-critical-route", watchStatus: "governance-payload-watch-needs-config-consumer-economics", sourceArtifacts: ["reports/raw/fast/governance-timelock-payloads.json"], blockers: ["Decoded governance/timelock rows are inventory, not route-positive exploit proof", "No active critical payload is joined to a target config diff and material consumer", "No exact acquisition/borrow/redeem/liquidation economics or fork proof"], requiredForRoutePositive: ["queued or active executable payload changes collateral, oracle, LTV/LT, caps, pause state, implementation, roles, or market listing", "decoded payload maps to a deployed target and concrete before/after config diff", "affected asset maps to material live lending, DEX, redeem, or liquidation consumers", "exact route economics are positive after gas/slippage/fees", "fork extraction proof demonstrates value extraction"], nextReadOnlyStep: "Keep governance payloads in watch mode; add target-specific config-diff decoders only if activeCriticalPayloadRows becomes positive." },
  { key: "governanceAttackSurface", id: "governance-attack-surface-sweep", protocol: "Multi-protocol", chain: "Ethereum", surface: "Phase 3.X governance attack surface (admin/owner/upgrade/timelock EOA-vs-contract assessment across Aave V3, Compound V3, Morpho Blue, Euler EVK, Silo V3, Venus Core Pool)", baseScore: 38, watchFields: ["highRiskCount", "mediumRiskCount"], researchFields: ["protocolsScanned", "topRows"], edgeFields: ["highRiskCount", "mediumRiskCount"], closedStatus: "governance-attack-surface-dormant-no-confirmed-risk", watchStatus: "governance-attack-surface-watch-needs-confirmed-risk-or-timelock-bypass", sourceArtifacts: ["reports/raw/fast/governance-attack-surface.json", "reports/raw/fast/governance-listing-watch.json", "reports/raw/fast/governance-timelock-payloads.json"], blockers: ["No current CONFIRMED RISK row where a single EOA admin can drain in one tx", "No governance timelock bypass or malicious proposal path mapped to exact positive economics", "Admin multisig rows are inactive/secure without key compromise or insider collusion proof", "No fork extraction proof or signed action justified"], requiredForRoutePositive: ["A CONFIRMED RISK row appears (single EOA admin, no timelock) with material TVL", "A timelock bypass, governance attack, or malicious proposal can drain in one proposal", "Admin multisig threshold drops below safe threshold via key compromise or insider collusion", "Extraction path is fork-proven with positive net value before any signed action"], nextReadOnlyStep: "Keep governance attack surface on dormant watch; reopen if a CONFIRMED RISK row appears or a timelock/governance bypass is mapped to exact positive consumer economics. Integrate with novelty-groundbreaking skill for cross-protocol governance attack route discovery." },
  { key: "governanceFlashloanVoting", id: "governance-flashloan-voting-sweep", protocol: "Governance flash-loan voting", chain: "Ethereum/Arbitrum/Avalanche", surface: "Token-of-Power style live-balance voting, checkpoint, holder concentration, and governance damage classification across major DeFi governance tokens", baseScore: 39, routePositiveFields: ["routePositive", "executableNow"], watchFields: ["watchCandidates", "unknownMechanismRows", "concentrationUnknownRows"], watchScale: 12, researchFields: ["targetProtocols", "criticalDamageRows", "highDamageRows"], researchScale: 20, quoteFields: ["confirmedRiskRows", "vulnerableRows"], closedStatus: "governance-flashloan-artifact-only-no-route-positive", watchStatus: "governance-flashloan-watch-needs-onchain-selector-and-holder-data", sourceArtifacts: ["reports/raw/fast/governance-flashloan-voting.json", "reports/governance-flashloan-voting-triage.md", "reports/raw/fast/governance-attack-surface.json", "reports/raw/fast/governance-timelock-payloads.json"], blockers: ["Artifact-only pass found no FLASH_LOANABLE_BALANCEOF row", "Top-holder concentration versus quorum remains unresolved without current holder/quorum snapshots", "GMX on-chain Governor/token vote source remains unresolved", "No malicious proposal payload, exact value-delta economics, or fork proof"], requiredForRoutePositive: ["governance token or governor uses current balanceOf/live-balance voting in the exploitable proposal window", "top-holder or top-3 concentration reaches quorum, or flash-loan liquidity can reach quorum", "malicious proposal can upgrade, drain, alter oracle/LTV/caps, or otherwise move material value", "exact economics are positive after proposal timing, fees, slippage, and borrowed voting power costs", "fork/local proof demonstrates positive value delta before any signed action"], nextReadOnlyStep: "Add a read-only selector/holder snapshot pass only with explicit endpoint/indexer authorization or user-provided holder artifacts; fork only if confirmedRiskRows or vulnerableRows becomes positive." },
  { key: "sevenChainLendingCoverage", id: "seven-chain-lending-coverage-sweep", protocol: "Lending coverage expansion", chain: "Gnosis/Linea/Scroll/Celo/Fantom/Blast/Mantle", surface: "First-pass lending coverage for RPC-available unscanned chains", baseScore: 30, watchFields: ["watchCandidates"], researchFields: ["protocolDiscoveryRows", "rowsScanned", "highLtvRows", "aavePoolsValid", "morphoMarketsScanned"], closedStatus: "no-risky-high-ltv-row", watchStatus: "new-chain-watch-needs-exact-economics-and-fork", sourceArtifacts: ["reports/raw/fast/seven-chain-lending-coverage.json"], blockers: ["Only material high-LTV row is canonical Linea WETH", "No producer/oracle/accounting anomaly mapped to borrow liquidity", "Gnosis RPC resolution failed in current run", "No exact acquisition, borrow, and exit economics or fork proof"], requiredForRoutePositive: ["high-LTV lending row maps to a current producer/oracle/accounting anomaly", "borrow-side liquidity is material and unpaused", "collateral acquisition and borrowed-asset exit are exact-quoted", "gas/slippage/flash-fee adjusted economics are positive", "fork extraction proof"], nextReadOnlyStep: "Proceed to Blast-native-yield scanner; reopen this breadth branch if new Aave/Morpho/Compound deployments appear on the seven target chains or Gnosis RPC resolves." },
  { key: "blastNativeYieldLending", id: "blast-native-yield-lending-sweep", protocol: "Blast lending", chain: "Blast", surface: "Native-yield WETH/USDB lending accounting scan", baseScore: 34, watchFields: ["watchCandidates"], researchFields: ["nativeYieldRows", "highNativeLtvRows", "compoundMarketsScanned", "initRebaseWrapperPools"], closedStatus: "native-yield-rows-no-current-route", watchStatus: "blast-native-yield-watch-needs-exact-economics-and-fork", sourceArtifacts: ["reports/raw/fast/blast-native-yield-lending.json"], blockers: ["INIT pools need protocol-specific collateral/account-mode simulation", "Orbit high-LTV rows are marked insolvent/dead in public adapter metadata", "No active non-insolvent high-native-LTV row with exact positive economics", "No fork-positive native-yield route proof"], requiredForRoutePositive: ["live non-insolvent Blast lending market accepts native-yield WETH/USDB collateral", "accepted accounting/oracle value diverges from exact redeem/swap/acquisition value", "borrow-side liquidity and exit route are exact-quoted", "gas/slippage/flash-fee adjusted economics are positive", "fork extraction proof"], nextReadOnlyStep: "Proceed to NFT lending oracle scanner; reopen Blast only after INIT account-mode config is decoded or a live non-insolvent high-native-LTV market appears." },
   { key: "nftLendingOracleRoutes", id: "nft-lending-oracle-route-sweep", protocol: "NFT lending", chain: "Ethereum", surface: "BendDAO/NFTfi NFT floor-oracle lending route scan", baseScore: 29, watchFields: ["watchCandidates"], researchFields: ["bendNftsScanned", "bendReservesScanned", "nftfiVaultOwners", "highLtvRows"], closedStatus: "no-high-ltv-nft-oracle-route", watchStatus: "nft-oracle-watch-needs-exact-floor-and-fork", sourceArtifacts: ["reports/raw/fast/nft-lending-oracle-routes.json"], blockers: ["BendDAO active NFT LTVs are below watch threshold", "No exact marketplace acquisition/resale floor edge", "NFTfi is peer-to-peer rather than pooled flash-compatible borrow liquidity", "No fork-positive NFT route proof"], requiredForRoutePositive: ["NFT collection accepted at material LTV with pooled/atomic borrow liquidity", "oracle floor exceeds exact acquisition plus unwind value", "borrow path is permissionless for exact token/collection size", "gas/fees/slippage adjusted economics are positive", "fork extraction proof"], nextReadOnlyStep: "Reopen only if BendDAO/NFT lending LTVs rise, a pooled NFT lender with higher LTV appears, or exact marketplace floor data shows a material oracle premium." },
  { key: "kaminoOracleConfig", id: "kamino-oracle-config-sweep", protocol: "Kamino Klend", chain: "Solana", surface: "Kamino oracle config, TWAP, heuristic, price status scan", baseScore: 30, watchFields: ["reduced_liquidation_checks"], researchFields: ["reserves_scanned", "twap_disabled"], closedStatus: "no-reduced-status-window-active", sourceArtifacts: ["reports/raw/fast/kamino-oracle-config.json"], blockers: ["All 55 reserves use Scope oracle, 0 have reduced-status liquidation window", "Existing Kamino monitor already reports LIVE_WINDOW=none consistently", "Solana CPI flash-loan execution requires a deployed Rust program"], requiredForRoutePositive: ["same-slot reduced-status obligation with debt", "liquidation bonus > DEX cost + protocol fee", "deployed Solana Rust program or direct-repay execution", "fork/local proof"], nextReadOnlyStep: "Keep existing Kamino monitor running; reopen only if sameSlotLiquidatable > 0." },
  { key: "kaminoLiquidationProfitability", id: "kamino-liquidation-profitability-sweep", protocol: "Kamino Klend", chain: "Solana", surface: "Kamino liquidation profitability model", baseScore: 28, researchFields: ["reservesAnalyzed", "theoreticallyPositive"], closedStatus: "theoretically-positive-no-live-candidates", sourceArtifacts: ["reports/raw/fast/kamino-liquidation-profitability.json"], blockers: ["15 reserves theoretically profitable (best 4.0%) but no live same-slot liquidation candidates", "Jupiter quote API unavailable at scan time; modeled with conservative 1.0% DEX cost", "Solana flash-loan execution requires a Rust program"], requiredForRoutePositive: ["live same-slot liquidatable obligation", "exact Jupiter/Solana DEX quote confirms profitability", "deployed Rust program or direct-repay execution", "fork/local proof"], nextReadOnlyStep: "Keep monitor running; profitability model confirms liquidations would be profitable if a candidate appears." },
  { key: "kaminoLiveWindowRanker", id: "kamino-live-window-ranker-sweep", protocol: "Kamino Klend", chain: "Solana", surface: "Kamino reduced-status live-window ranker", baseScore: 38, watchFields: ["liveWindowCandidates", "sameSlotReducedDebtRows", "sameSlotLiquidatableRows", "liveRowsQuoteAvailable"], researchFields: ["historicalReducedLiquidatableRows", "rankedReserveWatchRows", "staleReducedDebtRows"], closedStatus: "dormant-no-live-window", watchStatus: "live-window-needs-exact-quote-and-proof", sourceArtifacts: ["reports/raw/fast/kamino-live-window-ranker.json"], blockers: ["No current same-slot reduced-status liquidatable Kamino obligation", "Theoretical reserve profitability does not matter without a live liquidation window", "No exact collateral-exit quote or Solana execution proof exists for a live row"], requiredForRoutePositive: ["liveWindowCandidates > 0", "exact repay acquisition and seized-collateral exit are positive", "local/fork-equivalent Solana liquidation proof", "explicit authorization before any signed action"], nextReadOnlyStep: "Refresh the live-window ranker periodically; if liveWindowCandidates appears, exact-quote and local-proof before any send." },
  { key: "marginfiHealthRecompute", id: "marginfi-health-recompute-sweep", protocol: "Marginfi", chain: "Solana", surface: "Candidate health recompute from balances and decoded bank cache", baseScore: 36, watchFields: ["freshObservedUnhealthy", "freshCleanCachedConservativeLiquidatable", "materialCleanCachedConservativeLiquidatable"], researchFields: ["debtHealthRows", "staleObservedUnhealthy", "conservativeLiquidatable", "recomputedRowsWithStaleOrZeroBankPrice"], closedStatus: "no-fresh-recomputed-liquidation-window", watchStatus: "cached-recompute-watch-needs-live-oracle-proof", sourceArtifacts: ["reports/raw/fast/marginfi-health-recompute.json"], blockers: ["No fresh observed-unhealthy Marginfi account", "Cached-bank recompute rows are dominated by stale oracle cache and are not executable", "No live oracle-account recompute, exact liquidation quote, or local/fork-equivalent proof"], requiredForRoutePositive: ["fresh account health is negative under live oracle-account recompute", "material liability and liquid collateral/debt route exist", "exact repay acquisition and seized-collateral exit are positive", "local/fork-equivalent Solana liquidation proof", "explicit authorization before any signed action"], nextReadOnlyStep: "If freshCleanCachedConservativeLiquidatable or fresh observed-unhealthy rows appear, parse those banks' live oracle accounts and then exact-quote liquidation economics." },
  { key: "solanaReceiptTokenConsumerGraph", id: "solana-receipt-token-consumer-graph-sweep", protocol: "Solana receipt/Token-2022 consumers", chain: "Solana", surface: "Accepted-asset graph across Kamino, Marginfi, Jupiter Lend, and Drift", baseScore: 39, watchFields: ["currentValueChangingProducerRows", "accountingDivergenceRows", "exactEconomicsRows", "localProofRows"], watchScale: 5, researchFields: ["watchCandidates", "consumerRows", "riskyConsumerMatches", "materialRiskyConsumerMatches", "token2022ConsumerMints", "receiptLikeConsumerMints"], researchScale: 1000, closedStatus: "solana-consumer-graph-research-only-no-exact-route", watchStatus: "solana-consumer-watch-needs-economics-and-proof", sourceArtifacts: ["reports/raw/fast/solana-receipt-token-consumer-graph.json"], blockers: ["Consumer-linked risk rows are research leads, not proven exploitable routes", "No current value-changing producer impact is proven for any accepted mint", "No exact DEX/redeem/borrow/liquidation economics or local/fork-equivalent proof exists", "Signed action remains fail-closed"], requiredForRoutePositive: ["accepted mint has a current producer-side exploit signal, not just an authority or Token-2022 extension", "consumer uses the mint as borrowable collateral or margin with material liquidity", "accepted oracle/accounting value diverges from exact acquisition, transfer, redeem, or unwind value", "exact route economics are positive after fees/slippage/priority fees", "local/fork-equivalent Solana proof", "explicit authorization before any signed action"], nextReadOnlyStep: "Treat current consumer-linked rows as research-only; verify current producer-side value impact before exact-quoting borrow/liquidation and exit economics." },
  { key: "stablecoinDepegLendingRoutes", id: "stablecoin-depeg-lending-sweep", protocol: "Stablecoin depeg", chain: "Ethereum", surface: "Depegged stablecoin as high-LTV lending collateral scan", baseScore: 28, watchFields: ["watchCandidates"], researchFields: ["rowsScanned", "materialDepegRows", "aaveRows", "morphoRows", "eulerRows"], closedStatus: "no-depegged-stablecoin-high-ltv-route", sourceArtifacts: ["reports/raw/fast/stablecoin-depeg-lending-routes.json"], blockers: ["FRAX (47bps depeg) is not listed as collateral in any lending protocol", "USDe (6bps depeg) is listed but depeg too small to overcome flash fee", "Aave V3 has GHO/DAI at LTV=0", "No depegged stablecoin with both material depeg and material high-LTV listing"], requiredForRoutePositive: ["depegged stablecoin accepted as collateral at high LTV with material borrow liquidity", "depeg exceeds flash fee + gas + slippage", "exact borrow and exit route are positive", "fork extraction proof"], nextReadOnlyStep: "Reopen only if a currently depegged stablecoin (FRAX, crvUSD, etc.) newly appears as high-LTV collateral in a major lending protocol." },
  { key: "evaultCollateralNavManipulation", id: "evault-collateral-nav-manipulation-sweep", protocol: "Euler EVK", chain: "Ethereum", surface: "eVault share-to-eVault collateral NAV donation manipulation scan", baseScore: 33, watchFields: ["watchCandidates"], researchFields: ["vaultsScanned", "evaultAsCollateralPairs", "rowsScanned", "lowTvlRows"], closedStatus: "low-tvl-evault-watch-needs-mintability-and-simulation", watchStatus: "evault-donation-watch-needs-oracle-and-fork", sourceArtifacts: ["reports/raw/fast/evault-collateral-nav-manipulation.json"], blockers: ["Watch rows are low-TVL publicly mintable eVault collateral pairs, but donation/oracle premium has not been proven", "No exact donation/deposit/borrow simulation", "No fork-positive donation route proof"], requiredForRoutePositive: ["low-TVL eVault is publicly mintable", "eVault shares accepted as collateral at high LTV in liquid borrow eVault", "donation or oracle accounting creates value above LTV haircut after gas/slippage", "fork extraction proof demonstrates positive net value"], nextReadOnlyStep: "Run focused oracle/donation-sensitivity preflight for the top watch rows; fork only if exact premium or donation economics are positive." },
  { key: "evaultDonationSensitivity", id: "evault-donation-sensitivity-sweep", protocol: "Euler EVK", chain: "Ethereum", surface: "eVault donation/oracle sensitivity preflight", baseScore: 35, researchFields: ["sourceWatchCandidates"], quoteFields: ["rowsQuoted", "rowsWithOracleQuote"], bestNetFields: ["bestNetEdgeUsd"], edgeFields: ["bestPremiumBps"], closedStatus: "oracle-donation-sensitivity-negative", sourceArtifacts: ["reports/raw/fast/evault-donation-sensitivity.json", "reports/raw/fast/evault-collateral-nav-manipulation.json"], blockers: ["Accepted Euler oracle value equals redeemable NAV for all watch rows", "Donation borrowable value remains below donated cost under current LTVs", "No fork-positive donation route proof"], requiredForRoutePositive: ["accepted oracle value exceeds redeemable NAV by more than LTV haircut plus gas/slippage", "donation borrowable value per dollar exceeds donated cost", "borrowed asset exit route is exact-quoted", "fork extraction proof demonstrates positive net value"], nextReadOnlyStep: "Keep Euler branch dormant unless refreshed sensitivity shows positive premium or a new low-TVL public-mint row with donationBorrowablePerDollar > 1 after costs." },
  { key: "focusedMorphoReview", id: "focused-morpho-review-sweep", protocol: "Morpho Blue", chain: "multi-chain", surface: "Focused Morpho high-LTV producer route probes", baseScore: 31, quoteFields: ["rowsWithExactAcquisitionRoute"], researchFields: ["rowsWithReferencePrice", "rowsWithErc4626LikeProducer"], closedStatus: "exact-acquisition-negative", sourceArtifacts: ["reports/raw/fast/focused-morpho-review-producers.json"], blockers: ["Focused rows are exact-acquisition negative", "No LLTV-adjusted executable acquisition route"], requiredForRoutePositive: ["producer acquisition route is exact and permissionless", "Morpho accepted value exceeds acquisition cost after LLTV haircut", "net economics are positive after gas/slippage", "fork extraction proof"], nextReadOnlyStep: "Resolve remaining unknown producers and add routed acquisition paths only for rows that can clear the LLTV premium gap." },
  { key: "focusedEulerReview", id: "focused-euler-evk-review-sweep", protocol: "Euler EVK", chain: "Ethereum", surface: "Focused Euler EVK high-LTV eVault collateral oracle/NAV probe", baseScore: 33, quoteFields: ["rowsWithOracleQuote"], researchFields: ["rowsWithNavReference", "rowsWithPublicMintOpen", "reviewCandidates"], bestNetFields: ["bestNetEdgeUsd"], closedStatus: "reference-below-lltv-break-even", sourceArtifacts: ["reports/raw/fast/focused-euler-evk-review-producers.json"], blockers: ["Euler oracle/reference rows remain below LTV break-even", "No exact underlying acquisition/exit quote", "No fork-positive Euler EVK route"], requiredForRoutePositive: ["Euler accepted value exceeds executable eVault share acquisition cost after LTV haircut", "collateral eVault has public mint/deposit capacity or another exact acquisition route", "underlying acquisition and borrow-asset exit are exact-quoted", "fork extraction proof"], nextReadOnlyStep: "Expand oracle adapter decoding only for rows whose accepted/reference premium approaches LTV break-even; fork only after exact acquisition and exit economics are positive." },
  { key: "morphoPublicAllocatorForceFeed", id: "morpho-public-allocator-force-feed-sweep", protocol: "Morpho Blue", chain: "Ethereum", surface: "Public allocator force-feed route capacity", baseScore: 33, researchFields: ["allocatorCapacityRows", "preforkAllocatorPositive"], quoteFields: ["marketsWithExactAcquisition", "allocatorExactOverlapRows"], bestNetFields: ["bestPostAllocatorNetUsd"], liquidityFields: ["maxForceFeedCapacityUsd", "totalForceFeedCapacityUsd"], sourceArtifacts: ["reports/raw/fast/morpho-public-allocator-force-feed.json"], blockers: ["Allocator capacity does not overlap exact acquisition rows", "Exact-acquisition rows have zero or missing target maxIn capacity", "No fork-positive allocator route"] },
  { key: "hyperevmLstLrtOracleRoutes", id: "hyperevm-lst-lrt-oracle-sweep", protocol: "HyperEVM", chain: "HyperEVM", surface: "HYPE LST/LRT oracle route model", baseScore: 35, researchFields: ["researchPositiveRows", "watchCandidates"], bestNetFields: ["bestLiquidNetUsd", "bestNetUsd"], sourceArtifacts: ["reports/raw/fast/hyperevm-lst-lrt-oracle-routes.json"], blockers: ["LLTV-adjusted accepted values are below acquisition costs", "Needs exact DEX quote and fork-positive proof"] },
  { key: "hyperevmLstLrtExactQuotes", id: "hyperevm-lst-lrt-exact-quote-sweep", protocol: "HyperEVM", chain: "HyperEVM", surface: "HYPE LST/LRT exact DEX quote route model", baseScore: 38, quoteFields: ["exactPoolQuoteRows", "configuredQuoterRows"], bestNetFields: ["bestNetUsd"], sourceArtifacts: ["reports/raw/fast/hyperevm-lst-lrt-exact-quotes.json"], blockers: ["Exact quotes are net-negative after LLTV/gas", "No HyperEVM fork-positive extraction proof"] },
  { key: "hyperliquidLinkedTokenConsumers", id: "hyperliquid-linked-consumer-sweep", protocol: "Hyperliquid", chain: "HyperEVM/HyperCore", surface: "Linked-token consumers and DEX joins", baseScore: 31, researchFields: ["researchPositiveRows", "joinedRows"], sourceArtifacts: ["reports/raw/fast/hyperliquid-linked-token-consumers.json"], blockers: ["Consumer-linked rows lack exact executable depth", "No route-positive transfer/unwind proof"] },
  { key: "hyperliquidCoreDexDepth", id: "hyperliquid-core-dex-depth-sweep", protocol: "Hyperliquid", chain: "HyperEVM/HyperCore", surface: "HyperCore depth plus HyperEVM DEX route model", baseScore: 30, researchFields: ["researchPositiveRows", "depthAvailable"], quoteFields: ["exactDexQuoteRows", "multiHopExactRows"], bestNetFields: ["bestExactNetUsd", "bestNetUsd"], sourceArtifacts: ["reports/raw/fast/hyperliquid-core-dex-depth-routes.json"], blockers: ["No target clears conservative net-profit threshold", "Exact DEX routes are net-negative or lack USD-like unwind/acquisition", "No fork-positive extraction proof"] },
  { key: "layerzeroOftDvnConsumerJoins", id: "layerzero-oft-dvn-consumer-join-sweep", protocol: "LayerZero/OFT", chain: "multi-chain", surface: "LayerZero/OFT DVN config-to-consumer joins", baseScore: 34, watchFields: ["weakConfigConsumerRows", "joinedWeakConfigRows", "exactEconomicsRows", "forkProofRows"], watchScale: 5, researchFields: ["weakDefaultConfigRows", "defaultConfigOnlyRows", "oappRouteConfigRows", "consumerRows", "joinedRows", "materialJoinedRows"], researchScale: 600, liquidityFields: ["topLiquidityUsd"], closedStatus: "layerzero-oft-config-join-research-only-no-exact-route", watchStatus: "layerzero-oft-watch-needs-oapp-specific-weakness-economics-and-fork", sourceArtifacts: ["reports/raw/fast/layerzero-oft-dvn-consumer-joins.json"], blockers: ["Endpoint default weak DVN rows are inventory only without proof that a concrete OApp uses the affected default", "Current OApp/OFT rows do not join an OApp-specific weak peer/DVN/escrow condition to material consumer economics", "No exact positive acquisition/bridge/borrow/redeem/exit economics or fork/local proof"], requiredForRoutePositive: ["concrete OFT/OApp peer, DVN, or escrow weakness on a deployed route", "affected token is accepted by a material same-chain consumer", "exact route economics are positive after gas/slippage/fees", "fork/local proof demonstrates net value extraction"], nextReadOnlyStep: "Treat LayerZero endpoint-default DVN flags as inventory; only exact-quote/fork if a concrete OApp-specific weak route maps to a material consumer." },
  { key: "usdt0ConsumerRoutes", id: "usdt0-consumer-route-sweep", protocol: "USDT0", chain: "multi-chain", surface: "USDT0 lending consumer route joins", baseScore: 29, sourceArtifacts: ["reports/raw/fast/usdt0-consumer-routes.json"], blockers: ["No material USDT0 depeg/stale divergence", "Consumer-linked rows remain route-negative"] },
  { key: "usdt0OftRoutes", id: "usdt0-oft-route-sweep", protocol: "USDT0", chain: "multi-chain", surface: "USDT0 OFT peer/DVN/escrow route checks", baseScore: 27, researchFields: ["peerMismatches", "weakDvnConfigHints"], sourceArtifacts: ["reports/raw/fast/usdt0-oft-routes.json"], blockers: ["No current OFT peer/DVN/escrow anomaly", "No positive lending/DEX route economics"] },
  { key: "pendlePtConsumerGraph", id: "pendle-pt-consumer-sweep", protocol: "Pendle PT", chain: "multi-chain", surface: "Pendle principal-token consumer graph", baseScore: 31, quoteFields: ["morphoExecutableQuotes"], researchFields: ["reviewCandidates", "matches"], sourceArtifacts: ["reports/raw/fast/pendle-pt-consumer-graph.json"], blockers: ["Accepted PT values remain below LTV/LLTV break-even", "No fork-positive PT route"] },
  { key: "pendlePtMultichainConsumerGraph", id: "pendle-pt-multichain-consumer-sweep", protocol: "Pendle PT", chain: "multi-chain", surface: "Multi-chain Pendle principal-token consumer graph", baseScore: 35, watchFields: ["watchCandidates"], quoteFields: ["morphoExecutableQuotes"], researchFields: ["ptProducers", "matches", "reviewCandidates", "morphoOraclePricedReviews"], bestNetFields: ["bestNetEdgeUsd"], edgeFields: ["bestAcceptedVsAcquisitionBps", "minBreakEvenGapBps"], closedStatus: "pt-consumer-routes-below-break-even", watchStatus: "pt-watch-needs-exact-positive-economics-and-fork", sourceArtifacts: ["reports/raw/fast/pendle-pt-multichain-consumer-graph.json"], blockers: ["Accepted PT valuation remains below LTV/LLTV break-even", "Only one Morpho executable quote and it is route-negative", "No fork-positive PT extraction proof"], requiredForRoutePositive: ["PT is accepted by a material lending consumer", "accepted oracle value exceeds exact acquisition cost after LTV/LLTV haircut", "borrow-side liquidity and exit route are material", "gas/slippage-adjusted economics are positive", "fork extraction proof"], nextReadOnlyStep: "Refresh as PT markets mature or new consumers appear; fork only if a material row clears break-even with exact acquisition and exit quotes." },
  { key: "siloPtOracleRoutes", id: "silo-pt-oracle-sweep", protocol: "Silo / Pendle PT", chain: "multi-chain", surface: "Silo PT oracle route quotes", baseScore: 29, quoteFields: ["pendleExecutableQuotes"], researchFields: ["reviewCandidates"], sourceArtifacts: ["reports/raw/fast/silo-pt-oracle-routes.json"], blockers: ["PT oracle rows remain route-negative", "No fork-positive Silo route"] },
  { key: "pendleYtCollateral", id: "pendle-yt-collateral-sweep", protocol: "Pendle YT", chain: "multi-chain", surface: "Pendle yield-token-as-collateral consumer scan", baseScore: 34, watchFields: ["watchCandidates"], researchFields: ["ytProducers", "matches", "reviewCandidates"], closedStatus: "no-yt-consumer-match", watchStatus: "yt-collateral-watch-needs-exact-economics", sourceArtifacts: ["reports/raw/fast/pendle-yt-collateral-routes.json"], blockers: ["No lending consumer currently accepts active Pendle YT as collateral/oracle input", "No exact YT acquisition/decay/unwind economics", "No fork-positive YT route"], requiredForRoutePositive: ["Pendle YT is accepted as collateral or oracle input", "borrow-side liquidity is material", "YT acquisition and unwind/decay economics are exact-quoted", "fork extraction proof"], nextReadOnlyStep: "Keep YT branch on watch; fork only if a refreshed artifact shows a collateral-side YT match with material borrow liquidity and exact positive economics." },
  { key: "baseSyrupUsdc", id: "base-syrupusdc-sweep", protocol: "syrupUSDC", chain: "Base", surface: "Base syrupUSDC DEX/NAV/lending routes", baseScore: 28, edgeFields: ["navSpreadBps", "aaveBorrowableVsMarketBps", "fluidBestBorrowableVsMarketBps"], sourceArtifacts: ["reports/raw/fast/base-syrupusdc-routes.json"], blockers: ["Base token mint/burn is role-gated", "Lending haircuts make borrow routes negative"] },
  { key: "baseCadc", id: "base-cadc-sweep", protocol: "CADC", chain: "Base", surface: "Base CADC DEX/FX/lending routes", baseScore: 27, edgeFields: ["marketVsCadFxBps", "aaveBorrowableVsMarketBps", "morphoBestBorrowableVsMarketBps"], sourceArtifacts: ["reports/raw/fast/base-cadc-routes.json"], blockers: ["No public on-chain CADC mint/redeem route", "No positive lending-consumer route"] },
  { key: "avalancheStableYield", id: "avalanche-stable-yield-sweep", protocol: "Avalanche stable yield", chain: "Avalanche", surface: "Avalanche stable-yield DEX/redeem/lending routes", baseScore: 27, edgeFields: ["bestRouteEdgeBps", "usdtDexVsReferenceBps", "susdeDexVsReferenceBps"], sourceArtifacts: ["reports/raw/fast/avalanche-stable-yield-routes.json"], blockers: ["High APY is reward-only", "DEX/reference spreads below route threshold"] },
  { key: "originArmGrowth", id: "origin-arm-growth-sweep", protocol: "Origin ARM", chain: "Ethereum/Sonic", surface: "Origin ARM growth and ERC4626-like route map", baseScore: 22, researchFields: ["erc4626Like", "armsMapped"], sourceArtifacts: ["reports/raw/fast/origin-arm-growth-map.json"], blockers: ["No watch candidates", "No route-positive consumer/exit economics"] },
  { key: "bridgersGrowth", id: "bridgers-growth-sweep", protocol: "Bridgers", chain: "multi-chain", surface: "Bridgers growth bridge/wrapper route map", baseScore: 22, researchFields: ["evmRowsCodePresent", "nonLosslessHintTokens"], sourceArtifacts: ["reports/raw/fast/bridgers-growth-map.json"], blockers: ["No non-lossless hint tokens", "No route-positive bridge/lending consumer"] },
  { key: "dexConsumerRoutes", id: "dex-consumer-route-sweep", protocol: "DEX consumer bridge", chain: "multi-chain", surface: "DEX pool consumer bridge for producer tokens without direct lending listings", baseScore: 22, researchFields: ["dexConsumerMatches", "factoryPairsChecked", "uniqueProducers"], sourceArtifacts: ["reports/raw/fast/dex-consumer-routes.json"], blockers: ["No DEX pool connects any anomalous producer token to a known lending consumer asset", "No exact swap economics or fork proof"], requiredForRoutePositive: ["DEX pool liquidity is material", "exact swap quote is positive after gas/slippage", "consumer lending state permits deposit/borrow", "fork extraction proof"], nextReadOnlyStep: "Refresh producer/consumer artifacts and DEX factory coverage; reopen only if DEX links new producer tokens to liquid consumer assets." },
  { key: "solanaConsumerRoutes", id: "solana-consumer-route-sweep", protocol: "Solana protocols", chain: "Solana", surface: "Solana lending/perps consumer scan for Token-2022 mints", baseScore: 24, researchFields: ["protocolMatches", "matchedMints", "totalAccountsChecked"], sourceArtifacts: ["reports/raw/fast/solana-consumer-routes.json"], blockers: ["No xStocks mint deposited in known Solana lending/perps protocols", "Token-2022 freeze/mint/permanent-delegate authorities remain centralized", "No exact Solana route economics or fork proof"], requiredForRoutePositive: ["Token-2022 mint is deposited in a Solana lending/perps protocol", "protocol allows borrowing/margin against the token", "xStocks-side signal is exploitable", "exact Solana swap/liquidation economics are positive", "fork extraction proof"], nextReadOnlyStep: "Reopen only if xStocks or new Token-2022 mints appear as collateral/margin in Solana protocols, or extend to DEX pool ownership patterns." },
  { key: "perpsConsumerRoutes", id: "perps-consumer-route-sweep", protocol: "Perps margin", chain: "multi-chain", surface: "EVM perps margin consumer scan", baseScore: 20, researchFields: ["perpsMatches", "totalTokensQueried", "totalErc20Tokens"], sourceArtifacts: ["reports/raw/fast/perps-consumer-routes.json"], blockers: ["Perps protocol ABI queries yielded zero tokens due to function-signature mismatches against deployed bytecode", "No exact perps route economics or fork proof"], requiredForRoutePositive: ["perps protocol asset list is successfully queried", "anomalous producer appears as perps margin", "exact position/swap/liquidation economics positive", "fork extraction proof"], nextReadOnlyStep: "Verify perps protocol function selectors against deployed bytecode; reopen only when asset lists can be read and producer overlap found." },
  { key: "perpsLendingComposability", id: "perps-lending-composability-sweep", protocol: "Perps ↔ Lending", chain: "HyperEVM/multi-chain", surface: "Mango Markets $115M exploit pattern: perps margin ↔ lending collateral composability", baseScore: 40, watchFields: ["watchCandidates"], researchFields: ["composabilityPairs", "highScorePairs", "uniqueTokens", "uniqueLendingProtocols"], bestNetFields: [], liquidityFields: ["bestBorrowCashUsd"], closedStatus: "no-fork-proof-no-atomic-cross-layer", watchStatus: "high-score-composability-needs-fork-proof", sourceArtifacts: ["reports/raw/fast/perps-lending-composability.json"], blockers: ["No perps-spot DEX manipulation proof for composable tokens", "Cross-layer/chain composability may not be atomic (HyperCore↔HyperEVM)", "No fork extraction proof"], requiredForRoutePositive: ["Perps-spot DEX manipulation proof for the composable token", "Exact perps position size, liquidation price, and PnL modeled", "Exact lending borrow capacity and exit route positive after gas/slippage/flash fees", "Fork extraction proof demonstrating net profit"], nextReadOnlyStep: "Build fork test for top high-score pairs; verify composability mechanics on Ethereum mainnet via GMX+Aave or on HyperEVM when fork infrastructure matures." },
  { key: "currentLiquidatableExitRoutes", id: "current-liquidatable-exit-route-sweep", protocol: "Current liquidations", chain: "Ethereum", surface: "Currently liquidatable positions ranked by exact exit-route proof gap", baseScore: 42, watchFields: ["researchPositiveRows", "exactPositiveRows", "executorCompatiblePositiveRows", "nonDexExactSameBlockExitRows"], watchScale: 3, researchFields: ["currentLiquidatableRows", "materialLiquidatableRows"], researchScale: 20, quoteFields: ["rowsWithAnyQuote"], bestNetFields: ["bestNetUsd"], closedStatus: "current-liquidatable-exit-routes-negative", watchStatus: "current-liquidatable-exit-watch-needs-proof", sourceArtifacts: ["reports/raw/fast/current-liquidatable-exit-routes.json", "reports/raw/fast/e9-liquidation-salvage-routes.json", "reports/raw/fast/morpho-high-apy-liquidation-routes.json", "reports/raw/fast/morpho-high-apy-nondex-exit-classification.json", "reports/raw/fast/morpho-yeth-alternate-exits.json"], blockers: ["Current liquidatable rows either have negative exact exit quotes or only research-positive preview/non-executor exits", "No fork-proven same-block wrapper/non-DEX exit", "No verified executor-compatible route", "No signed action justified"], requiredForRoutePositive: ["borrower is currently liquidatable", "repay amount and seized collateral are exact and non-overseizing", "collateral exit quote is exact and positive into repay token after gas/slippage/flash fees", "wrapper/non-DEX path is fork-proven same-block, not preview-only", "executor/staticCall/minProfit gates pass"], nextReadOnlyStep: "Fork-probe only if a current row has exact-positive economics or a research-positive wrapper preview has enough edge to justify proving same-block redeem semantics; otherwise keep refreshing current liquidation rows." },
  { key: "morphoLiquidatableMarketability", id: "morpho-liquidatable-marketability-sweep", protocol: "Morpho Blue", chain: "Ethereum", surface: "Broad current-liquidatable marketability and bounded exact-exit ranker", baseScore: 41, watchFields: ["exactPositiveRows"], watchScale: 2, researchFields: ["materialRows", "rowsRanked"], researchScale: 40, quoteFields: ["rowsWithAnyQuote", "rowsQuoteProbed"], quoteScale: 20, bestNetFields: ["bestNetProfitUsd"], closedStatus: "morpho-liquidatable-exits-negative", watchStatus: "morpho-liquidatable-exact-positive-needs-proof", sourceArtifacts: ["reports/raw/fast/morpho-liquidatable-marketability.json"], blockers: ["No bounded exact Uniswap/Curve exit quote is positive after gas/slippage", "No fork extraction proof", "No signed action justified"], requiredForRoutePositive: ["current borrower remains liquidatable on-chain", "non-overseizing repay size has an exact collateral exit quote into the loan token", "loan-token price is trusted", "net remains positive after gas and slippage", "fork/static proof verifies liquidation and unwind semantics"], nextReadOnlyStep: "Keep this breadth scanner refreshed; if exactPositiveRows becomes positive, build route-specific fork/static proof before executor work." },
  { key: "morphoWrapperExitProofGaps", id: "morpho-wrapper-exit-proof-gap-sweep", protocol: "Morpho Blue", chain: "Ethereum", surface: "Current-liquidation wrapper/non-DEX same-block exit proof gaps", baseScore: 40, watchFields: ["instantCapacityRows", "sameBlockAssetTransferProvenRows"], watchScale: 4, researchFields: ["wrapperLikeRows", "directLoanAssetRows", "positivePreviewRows", "managerBlockedRows"], researchScale: 20, bestNetFields: ["bestResearchNetUsd"], closedStatus: "wrapper-exit-blocked-no-instant-capacity", watchStatus: "wrapper-exit-capacity-needs-fork-transfer-proof", sourceArtifacts: ["reports/raw/fast/morpho-wrapper-exit-proof-gaps.json", "reports/raw/fast/current-liquidatable-exit-routes.json", "reports/raw/fast/morpho-liquidatable-marketability.json", "reports/raw/fast/e9-liquidation-salvage-routes.json", "reports/raw/fast/morpho-yeth-alternate-exits.json"], blockers: ["Research-positive wrapper previews are not same-block transfer proof", "No current wrapper row has sufficient instant redeem cap and asset liquidity", "No fork/static trace proves seized collateral can transfer loan asset in the same transaction", "No signed action justified"], requiredForRoutePositive: ["current Morpho borrower remains liquidatable on-chain", "non-overseizing seized collateral size is exact", "wrapper asset is the loan token or has an exact positive DEX tail", "instant redeem cap and asset liquidity cover seized shares and preview assets", "same-block asset transfer is proven by fork/static trace", "net remains positive after gas/slippage/flash fees", "fork extraction proof before any signed action"], nextReadOnlyStep: "Keep wrapper rows fail-closed; reopen only if a wrapper row has positive exact economics plus instant capacity, then fork/static-trace the same-block asset transfer before executor work." },
  { key: "morphoYethAlternateExits", id: "morpho-yeth-alternate-exit-sweep", protocol: "Morpho Blue", chain: "Ethereum", surface: "WETH/yETH current-liquidation alternate exit inventory and exact quote probe", baseScore: 40, watchFields: ["previewPositiveRows", "exactPositiveRows"], watchScale: 3, researchFields: ["quotesScored", "exactSameBlockQuotes", "uniswapV3Pairs", "curveYethPools", "balancerYethPools"], researchScale: 20, quoteFields: ["quotesScored", "exactSameBlockQuotes"], bestNetFields: ["bestExactNetUsd"], closedStatus: "morpho-yeth-alternate-exits-no-exact-positive", watchStatus: "morpho-yeth-preview-capacity-blocked", sourceArtifacts: ["reports/raw/fast/morpho-yeth-alternate-exits.json", "reports/raw/fast/current-liquidatable-exit-routes.json", "reports/raw/fast/morpho-wrapper-exit-proof-gaps.json"], blockers: ["No exact same-block yETH->WETH route is positive after repay, gas, and slippage", "Best positive edge is wrapper preview-only, not same-block transfer proof", "Wrapper manager instant redeem cap and instant WETH liquidity are zero", "Balancer yETH pool coverage is API-blocked in this pass and remains a coverage caveat", "No fork extraction proof"], requiredForRoutePositive: ["current WETH/yETH borrower remains liquidatable on-chain", "seized yETH size and repay WETH size are exact and non-overseizing", "same-block yETH->WETH exit is exact-quoted positive after repay, gas, slippage, and flash fees", "wrapper redeem path has instant cap and WETH liquidity if wrapper preview is used", "fork/static trace proves seized yETH can transfer WETH in the same transaction", "fork extraction proof before any signed action"], nextReadOnlyStep: "Keep WETH/yETH fail-closed; rerun only if yETH DEX liquidity, wrapper instant capacity, or current liquidation size materially changes." },
  { key: "dexExitQuotes", id: "dex-exit-quote-sweep", protocol: "DEX exit pipeline", chain: "Ethereum", surface: "Reusable exact DEX exit quote pipeline for liquidatable collateral", baseScore: 26, researchFields: ["tokensWithSuccessfulQuote", "tokensWithNoQuote", "totalQuotesAttempted"], sourceArtifacts: ["reports/raw/fast/dex-exit-quotes.json"], blockers: ["Exit quotes exist but all are net-negative after gas/fees", "No route-positive exit economics or fork proof"], requiredForRoutePositive: ["collateral has liquid DEX exit route", "exit output exceeds repay amount after gas", "integration with liquidation scanner shows net-positive route", "fork extraction proof"], nextReadOnlyStep: "Feed exit quotes into Morpho liquidation scanner; fork-proof only net-positive routes." },
  { key: "socketRouteQuotes", id: "socket-route-quote-sweep", protocol: "Socket/Bungee v3", chain: "multi-chain", surface: "Read-only Socket v3 same-chain and cross-chain route quote adapter", baseScore: 24, watchFields: ["exactEconomicsRows", "forkProofRows"], watchScale: 5, researchFields: ["requestedPairs", "successfulRequests", "routeCount", "rowsWithAnyQuote"], researchScale: 80, quoteFields: ["routeCount", "rowsWithAnyQuote"], closedStatus: "socket-quotes-fail-closed-no-route-proof", watchStatus: "socket-watch-needs-exact-economics-and-fork", sourceArtifacts: ["reports/raw/fast/socket-route-quotes.json"], blockers: ["Socket quotes are route intelligence only and do not prove exploit economics", "No branch-specific exact positive route after gas/slippage/bridge fees", "No fork extraction proof or execution allowlist validation"], requiredForRoutePositive: ["Socket quote maps to a concrete live exploit, liquidation, or bridge-funding branch", "input acquisition and output unwind economics are exact and positive after gas/slippage/fees", "returned spender and tx target are chain-specific allowlisted", "fork extraction proof demonstrates positive net value", "fresh preflight and explicit authorization before any signed action"], nextReadOnlyStep: "Use Socket quotes to enrich Aave V4, Morpho, HyperLend, and cross-chain funding comparisons; fork only after a branch has exact positive economics." },
  { key: "socketBranchEnrichment", id: "socket-branch-enrichment-sweep", protocol: "Socket/Bungee v3", chain: "Ethereum/HyperEVM", surface: "Branch-specific Socket quote enrichment for Aave V4, Morpho high-APY, and HyperLend stale-source routes", baseScore: 32, watchFields: ["triggerReadyExactEconomicsRows", "forkProofRows"], watchScale: 3, researchFields: ["exactEconomicsRows", "quotedRows", "aaveRowsQuoted", "morphoRowsQuoted", "hyperlendRowsSkipped"], researchScale: 30, quoteFields: ["quotedRows", "totalRoutesReturned"], bestNetFields: ["bestConservativeNetUsd"], closedStatus: "socket-branch-enrichment-trigger-blocked", watchStatus: "socket-branch-watch-needs-live-trigger-and-fork", sourceArtifacts: ["reports/raw/fast/socket-branch-enrichment.json", "reports/raw/fast/aave-v4-liquidation-watch.json", "reports/raw/fast/morpho-high-apy-liquidation-routes.json", "reports/raw/fast/hyperlend-stale-source-routes.json"], blockers: ["Aave Socket exit quotes are positive only in shadow mode because the hot borrower HF is above 1", "Morpho current liquidation rows remain conservative-net negative after Socket quotes", "HyperLend rows remain below stale/divergence gates", "No fork extraction proof or execution allowlist validation"], requiredForRoutePositive: ["branch trigger is live now: Aave HF < 1, Morpho exact positive liquidation, or HyperLend material divergence", "Socket quote remains conservative-net positive after gas/slippage/branch costs", "returned spender and tx target are chain-specific allowlisted and independently simulated", "fork extraction proof demonstrates positive net value", "fresh staticCall/estimateGas/minOut/minProfit gates and explicit authorization before any signed action"], nextReadOnlyStep: "Keep Aave V4 hot-watch; rerun Socket branch enrichment only after HF < 1 or Morpho/HyperLend route gates materially improve." },
  { key: "lorenzoBscSupplyWatch", id: "lorenzo-bsc-supply-watch-sweep", protocol: "Lorenzo sUSD1+", chain: "BSC", surface: "BSC Lorenzo NAV-update supply-route watch", baseScore: 30, researchFields: ["navPendingUpwardBps", "sellRoutePositive", "buyRoutePositive", "navTimingWindow"], sourceArtifacts: ["reports/raw/fast/lorenzo-bsc-supply-route-watch.json"], blockers: ["Supply-and-sell DEX spread (-46bps) is below breakeven", "No NAV-update timing window detected (next period NAV not yet set)", "Inverse buy route is gross-positive (+25bps) but same-epoch exit is not proven"], requiredForRoutePositive: ["NAV update is pending with positive delta", "supply() is callable and unpaused", "exact DEX sell quote is positive after NAV uplift and gas", "fork extraction proof"], nextReadOnlyStep: "Keep BSC Lorenzo on fast watch; reopen only if NAV delta narrows supply-sell spread or next-period NAV is set above current NAV." },
  { key: "oracleStalenessCrossRef", id: "oracle-staleness-cross-ref-sweep", protocol: "Oracle staleness", chain: "Ethereum", surface: "Chainlink feed age vs protocol staleness threshold cross-reference", baseScore: 24, researchFields: ["feedsQueried", "nearHeartbeat", "exceededHeartbeat"], sourceArtifacts: ["reports/raw/fast/oracle-staleness-cross-ref.json"], blockers: ["No feed exceeds both Chainlink heartbeat AND protocol-specific staleness threshold", "USDC 13.77h feed age is within 24h heartbeat", "ETH/USD proxy artifact is not actually stale"], requiredForRoutePositive: ["feed age exceeds Chainlink heartbeat", "feed age exceeds protocol maxStalePeriod for a material market", "borrow capacity exists at stale price", "fork extraction proof"], nextReadOnlyStep: "Reopen only if any feed crosses both Chainlink heartbeat and a specific protocol's staleness threshold with material market liquidity." },
  { key: "hgethDexWatch", id: "hgeth-dex-liquidity-watch-sweep", protocol: "Morpho+hgETH", chain: "Ethereum", surface: "hgETH DEX exit liquidity watch for Morpho WETH/hgETH liquidation (HF 0.8874)", baseScore: 32, researchFields: ["v3PoolsFound", "v3Quotes", "v2Quotes", "hasLiquidity"], sourceArtifacts: ["reports/raw/fast/hgeth-dex-liquidity-watch.json"], blockers: ["No hgETH DEX pool on any UniV3/V2/Sushi on Ethereum", "Morpho liquidation (HF 0.8874) cannot exit seized collateral", "hgETH has no known DEX market"], requiredForRoutePositive: ["hgETH DEX pool appears with material liquidity", "exact position-size exit quote exceeds repay + gas", "Morpho liquidation is profitable", "fork extraction proof"], nextReadOnlyStep: "Poll daily; reopen only if hgETH gains DEX exit liquidity." },
  { key: "pendlePtMaturityRoutes", id: "pendle-pt-maturity-sweep", protocol: "Pendle PT", chain: "Ethereum", surface: "Pendle PT maturity-boundary consumer routes (<7d to expiry)", baseScore: 22, researchFields: ["ptTokensNearMaturity", "consumerMatches"], sourceArtifacts: ["reports/raw/fast/pendle-pt-maturity-routes.json"], blockers: ["No PT tokens within 7-day maturity window", "No mature-near PT mapped to Morpho/Silo borrow markets"], requiredForRoutePositive: ["PT maturity < 7 days", "PT has liquid borrow market", "borrow + hold-to-maturity yields positive return after gas", "fork extraction proof"], nextReadOnlyStep: "Re-run daily as PT tokens approach maturity." },
  { key: "avalonUsdaLive", id: "avalon-usda-cdp-sweep", protocol: "Avalon USDa", chain: "Ethereum", surface: "Avalon USDa CDP live/deep closeout (unverified implementation)", baseScore: 28, researchFields: ["totalDebt", "paused", "oracleAge", "audits"], closedStatus: "avalon-usda-final-closeout-no-route-positive", sourceArtifacts: ["reports/raw/fast/avalon-usda-live.json", "reports/raw/fast/avalon-usda-deep-probe.json"], blockers: ["No verified source code (21438 bytes unverified bytecode)", "Deep probe found zero implementation oracle literal matches", "Money-path selectors revert for probe caller or are view-only", "No exact route economics or fork-positive proof"], requiredForRoutePositive: ["verified source code or decompiled semantics for oracle/risk/liquidation paths", "permissionless money path reaches past account/pool guards", "exact positive economics after gas/slippage/fees", "fork extraction proof"], nextReadOnlyStep: "Keep Avalon dormant unless verified source/decompiled oracle semantics or real user-state probes reveal a permissionless exact-positive money path." },
  { key: "crossChainPriceDiscrepancy", id: "cross-chain-price-discrepancy-sweep", protocol: "Cross-chain oracle", chain: "multi-chain", surface: "Cross-chain Chainlink feed price discrepancy scan", baseScore: 22, researchFields: ["pairsScanned", "totalFeedsSuccess", "discrepanciesFound"], sourceArtifacts: ["reports/raw/fast/cross-chain-price-discrepancy.json"], blockers: ["All 8 pairs across 5 chains within 50bps", "No cross-chain arbitrage route found"], requiredForRoutePositive: ["cross-chain price gap exceeds bridge cost + DEX spread + gas", "bridge or DEX route available and permissionless", "exact arbitrage economics positive", "fork extraction proof"], nextReadOnlyStep: "Re-scan when market volatility increases." },
  { key: "crossChainOracleDrift", id: "cross-chain-oracle-drift-sweep", protocol: "Cross-chain oracle", chain: "multi-chain artifact", surface: "Same-asset cross-chain oracle/staleness drift joined to lending consumer context", baseScore: 37, routePositiveFields: ["routePositive", "executableNow"], watchFields: ["materialDriftRows", "sourceRoutePositiveDowngradedRows"], watchScale: 20, researchFields: ["assetsCompared", "chainPriceRows", "driftRows", "staleOrDivergentRows", "consumerRowsJoined", "sourceWatchCandidates", "watchCandidates"], researchScale: 1000, quoteFields: ["exactEconomicsRows", "forkProofRows"], bestNetFields: ["bestNetUsd"], liquidityFields: ["bestRouteLiquidityUsd"], closedStatus: "cross-chain-oracle-drift-no-route-positive", watchStatus: "cross-chain-oracle-drift-watch-needs-exact-bridge-or-borrow-economics", sourceArtifacts: ["reports/raw/fast/cross-chain-oracle-drift.json", "reports/cross-chain-oracle-drift-triage.md", "reports/raw/fast/cross-chain-chainlink-staleness.json", "reports/raw/fast/cross-chain-price-discrepancy.json", "reports/raw/fast/oracle-staleness-cross-ref.json", "reports/raw/fast/lrt-oracle-drift-routes.json", "reports/raw/fast/lrt-oracle-premium-probe.json", "reports/raw/fast/stablecoin-depeg-lending-routes.json", "reports/raw/fast/hyperevm-lst-lrt-oracle-routes.json", "reports/raw/fast/consumer-first-high-ltv-collateral.json", "reports/raw/fast/aave-euler-silo-consumer-graph.json"], blockers: ["Cross-chain feed/staleness gaps are watch-only until joined to a current consumer stale-read path", "One source artifact routePositive signal is downgraded because it lacks exact positive economics and fork proof", "Consumer joins are symbol/context matches and may use historical artifact prices/liquidity", "No exact bridge, borrow, redeem, liquidation, or exit economics are positive", "No fork/local value-delta proof; signed action remains unjustified"], requiredForRoutePositive: ["same-asset cross-chain price/staleness gap exceeds bridge, DEX spread, gas, slippage, and flash-fee costs", "affected lending/consumer market accepts the stale/divergent oracle value at material borrow/liquidation liquidity", "permissionless acquisition, bridge, borrow/redeem/liquidation, and exit route is available now", "exact economics are positive after all costs and liquidity limits", "fork/local proof demonstrates net value extraction without privileged roles or signed-action assumptions"], nextReadOnlyStep: "For top drift rows, run route-specific read-only exact quote/economics probes; fork only after net-positive economics are demonstrated." },
  { key: "deriveV2Live", id: "derive-v2-options-sweep", protocol: "Derive V2", chain: "Ethereum", surface: "Derive V2 options protocol config scan (0 audits)", baseScore: 24, researchFields: ["proxiesFound", "implCodeBytes", "chainCount"], sourceArtifacts: ["reports/raw/fast/derive-v2-live.json"], blockers: ["No verified source code", "0 audits on $126M options protocol", "Options-specific settlement/exercise functions not yet probed", "Single chain probed (Ethereum) of 5 deployed chains"], requiredForRoutePositive: ["verified source or decompiled semantics", "options settlement oracle manip exploitable", "exercise-spot arbitrage positive", "fork extraction proof"], nextReadOnlyStep: "Extend to Optimism/Arbitrum/Base deployments; probe settlement/exercise functions; fork-proof only after invariants mapped." },
  { key: "bridgeEscrowReconciliation", id: "bridge-escrow-reconciliation-sweep", protocol: "Bridge escrow", chain: "multi-chain", surface: "Bridge escrow vs circulating supply reconciliation", baseScore: 20, researchFields: ["xstocksBacked", "shortfallsFound"], sourceArtifacts: ["reports/raw/fast/bridge-escrow-reconciliation.json"], blockers: ["All xStocks proof rows backed (60/61 backed, 0 shortfalls)", "NVDAx proof row has data gap but is known and dust"], requiredForRoutePositive: ["proof-of-reserves shortfall or escrow mismatch on a material token", "public mint/burn bridge call exploitable", "exact extractive economics positive", "fork extraction proof"], nextReadOnlyStep: "Re-scan when new proof-of-reserves data is published." },
  { key: "suiLendingConfig", id: "sui-lending-config-sweep", protocol: "Sui Move lending", chain: "Sui", surface: "Sui Move lending protocol config decoding (NAVI, Scallop)", baseScore: 30, watchFields: ["accountLevelLiquidationRows", "exactEconomicsRows", "forkProofRows"], researchFields: ["protocolsSuccessful", "naviReserveObjectsFetched", "riskHintRows", "ltvHintRows", "oracleHintRows", "pauseOrCapHintRows", "naviReserveOracleCrossRefRows", "naviOracleRowsFetched", "naviBorrowLiquidityHintRows", "naviHighLtvRows", "naviPublicApiJoinedRows", "naviPublicApiAvailableBorrowRows", "naviUserInfoDecodedRows", "naviUserPositionHintRows", "naviAccountRows", "naviAccountRowsWithDebt", "naviAccountRowsWithDebtAndCollateral", "naviBorrowerReserveTablesScanned", "naviBorrowerTableRowsScanned", "naviBorrowerDebtRows", "naviUniqueBorrowers", "naviBorrowerRowsRanked", "naviBorrowerUserInfoDecodedRows", "naviBorrowerRowsWithDebt", "naviBorrowerRowsWithDebtAndCollateral", "naviBorrowerHighLtvCollateralRows", "naviHealthFactorRows", "naviHealthFactorSuccessRows", "naviHealthFactorErrorRows", "naviExactLiquidatableRows"], sourceArtifacts: ["reports/raw/fast/sui-lending-config.json"], blockers: ["NAVI live Move reserve/config fields, borrower user-state rows, and exact health-factor rows are decoded but remain route-negative without exact economics", "Scallop local source/deployment layout is still missing from current targets", "No decoded account row has both account-level liquidation state, exact route economics, and local proof"], requiredForRoutePositive: ["Sui Move oracle/LTV/cap/pause/liquidation config decoded from live objects", "decoded condition maps to a material lending asset with live borrow or liquidation liquidity", "exact account-level liquidation state is current", "exact repay/acquire, borrow/redeem, and collateral-exit economics are positive after fees", "local/fork-equivalent Sui proof demonstrates net extraction"], nextReadOnlyStep: "Exact-quote repay/acquire and collateral-exit economics only if a discovered borrower is currently liquidatable by the NAVI health-factor getter." },
  { key: "xstocksConsumerRoutes", id: "xstocks-consumer-route-sweep", protocol: "xStocks", chain: "Arbitrum/Solana", surface: "xStocks Token-2022 and Arbitrum wrapper consumer joins", baseScore: 25, researchFields: ["consumerMatches", "matchedTokens", "anomalyRows", "consumerLinkedAnomalies"], sourceArtifacts: ["reports/raw/fast/xstocks-consumer-routes.json"], blockers: ["No current xStocks wrapper appears in reusable lending-consumer artifacts", "Residual authority/proof signals are not consumer-linked", "No exact positive route economics or fork proof"], requiredForRoutePositive: ["xStock wrapper maps to a liquid consumer", "current xStocks-side anomaly is permissionless-impacting", "exact route economics are positive after gas/slippage", "fork extraction proof"], nextReadOnlyStep: "Refresh xstocks-live and consumer artifacts; fork only if a consumer-linked xStock anomaly becomes route-positive." },
  { key: "robinhoodChainPhase0", id: "robinhood-chain-phase0-sweep", protocol: "Robinhood Chain", chain: "Robinhood Chain / Ethereum L1", surface: "Robinhood Chain Arbitrum L2 bridge, official stock tokens, docs/explorer inventory, and consumer-route Phase 0", baseScore: 39, watchFields: ["watchCandidates"], researchFields: ["docsAddressRows", "stockTokenRows", "codePresentRows", "bridgeContractRows", "blockscoutTokenRows", "localConsumerArtifactMentions", "publicProbeSuccessRows"], researchScale: 250, quoteFields: ["exactEconomicsRows"], closedStatus: "robinhood-chain-phase0-no-route-positive", watchStatus: "robinhood-chain-watch-needs-consumer-join-or-proof-bypass", sourceArtifacts: ["reports/raw/fast/robinhood-chain-phase0.json"], blockers: ["Robinhood Chain stock tokens and bridge infrastructure are code-present context, not an extractive route by themselves", "No official Robinhood Chain stock token is joined to a material local lending/DEX consumer artifact", "No bridge proof bypass, token accounting mismatch, stale oracle impact, public mint/burn/config path, exact positive economics, or fork proof"], requiredForRoutePositive: ["Robinhood Chain token/bridge/accounting state is consumed by a material lending, DEX, bridge, or settlement route", "permissionless producer-side issue is proven: bridge proof bypass, token accounting/transfer restriction mismatch, stale/incorrect oracle, or public mint/burn/config path", "borrow/redeem/liquidate/swap/bridge route is exact-quoted and positive after gas, slippage, fees, bridge delays, and RWA restrictions", "fork/local proof demonstrates net extraction before executor or signed action work"], nextReadOnlyStep: "Keep Robinhood Chain on watch for consumer listings, DEX liquidity, bridge/gateway config changes, stock-token oracle/feed exposure, and exact route economics before any fork work." },
  { key: "robinhoodChainAttackVectors", id: "robinhood-chain-attack-vector-sweep", protocol: "Robinhood Chain", chain: "Robinhood Chain / Ethereum L1", surface: "Expanded Robinhood donation/ERC4626, oracle/feed, bridge/gateway, DEX, and smart-contract attack-vector battery", baseScore: 41, watchFields: ["donationWatchRows", "oracleStale24hRows", "bridgeProbeSuccessRows", "genericProbeSuccessRows", "proxyAdminEoaRows"], watchScale: 10, researchFields: ["contractsInventoried", "codePresentContracts", "erc4626Rows", "oracleRows", "commonDexFactoriesWithCode", "stockTokenDexPools"], researchScale: 350, quoteFields: ["exactEconomicsRows", "forkProofRows"], closedStatus: "robinhood-attack-vectors-no-route-positive", watchStatus: "robinhood-attack-vector-watch-needs-value-impact-and-economics", sourceArtifacts: ["reports/raw/fast/robinhood-chain-attack-vectors.json", "reports/robinhood-chain-attack-vectors-triage.md"], blockers: ["Donation/ERC4626 rows, oracle/feed rows, bridge/gateway probes, and smart-contract inventory are watch-only unless joined to material value movement", "No official stock-token DEX pool or local material consumer join was found", "No bridge proof/retryable/gateway bypass, token accounting mismatch, stale oracle impact, exact positive economics, or fork proof"], requiredForRoutePositive: ["specific Robinhood vector has permissionless value impact", "material consumer, bridge, redeem, liquidation, DEX, or settlement route exists", "exact economics are positive after gas/slippage/fees/bridge delays/RWA restrictions", "fork/local proof demonstrates net extraction before any signed action"], nextReadOnlyStep: "Keep vectors on watch; fork only after consumer linkage, exact positive economics, and a concrete permissionless value-impact proof." },
  { key: "confirmedSignalVariants", id: "confirmed-signal-variant-sweep", protocol: "Confirmed signal variants", chain: "multi-chain", surface: "Confirmed exploit-pattern seeds converted into route-discovery branches", baseScore: 36, researchFields: ["actionablePatternSeeds", "confirmedReportsFound"], sourceArtifacts: ["reports/raw/fast/confirmed-signal-variants.json", "reports/confirmed-signal-variant-plan.md"], blockers: ["Confirmed signals are historical/testnet/event-driven or already executed; no current exact positive route", "Variant scanners must emit routePositive before fork proof"], requiredForRoutePositive: ["variant scanner links a pattern to live state", "exact route economics are positive after gas/slippage/fees", "fork/local extraction proof", "explicit authorization before any signed action"], nextReadOnlyStep: "Start with invariant-zero AMM marketability ranking and validation-differential liquidation source/live scans; keep routePositive=0 until exact economics are proven." },
  { key: "routerRfqSettlementDrift", id: "router-rfq-settlement-drift-sweep", protocol: "Routers / RFQ settlement", chain: "multi-chain", surface: "Deprecated router/RFQ signed-field vs settlement drift scan", baseScore: 39, watchFields: ["verifiedFieldDiffRows", "liveApprovalOrEscrowRows", "balanceDeltaMismatchRows", "exactEconomicsRows", "forkProofRows"], watchScale: 5, researchFields: ["sourceRows", "deployedRouterInventoryRows", "deployedWatchRows", "deprecatedReachabilityRows", "fieldBindingProofRows"], researchScale: 100, closedStatus: "router-rfq-inventory-only-no-verified-route-proof", watchStatus: "router-rfq-watch-needs-balance-delta-economics-and-fork", sourceArtifacts: ["reports/raw/fast/router-rfq-settlement-drift.json"], blockers: ["Deployed selector and deprecated-reachability rows are inventory, not route-positive evidence", "Current source rows do not prove verified signed-field vs settlement-field mismatch on a deployed path", "No live approval/escrow reachability, exact positive balance-delta economics, or fork-positive router/RFQ extraction proof"], requiredForRoutePositive: ["deployed router/RFQ/deprecated settlement path is permissionlessly callable", "verified-source field diff proves maker-signed fields differ from settlement transfer/callback fields", "live approvals, escrow, or protocol balances are reachable", "exact balance-delta mismatch and simulation are positive after gas/fees", "fork extraction proof"], nextReadOnlyStep: "Treat deployed bytecode watch rows as inventory only; reopen only if verified source proves field drift and live approvals/escrow plus exact positive balance-delta economics are present." },
  { key: "bridgeProofBinding", id: "bridge-proof-binding-sweep", protocol: "Bridge proof verifiers", chain: "multi-chain", surface: "Bridge proof/message binding verifier scan", baseScore: 35, watchFields: ["deployedProofAcceptanceRows", "liquidMintUnlockRows", "exactEconomicsRows"], watchScale: 5, researchFields: ["proofRows", "staticProofRows", "underBoundProofRows", "highStaticRows", "mediumStaticRows", "filesScanned"], researchScale: 800, closedStatus: "bridge-proof-source-only-no-deployed-acceptance", watchStatus: "bridge-proof-watch-needs-exact-economics-and-fork", sourceArtifacts: ["reports/raw/fast/bridge-proof-binding.json"], blockers: ["Static under-bound proof rows are not deployed forged-proof routes", "No deployed verifier acceptance proof mints or unlocks liquid assets", "No exact unwind/collateral route or fork-positive proof"], requiredForRoutePositive: ["deployed verifier accepts replayed, forged, or under-bound proof", "proof path is permissionless or attacker-reachable without trusted operator compromise", "accepted proof mints/unlocks/transfers liquid assets", "exact unwind or lending-collateral route is positive after gas/fees/slippage", "fork/local proof demonstrates value extraction"], nextReadOnlyStep: "Treat current proof rows as source-only research. Add deployed verifier/escrow acceptance mapping only if a concrete proof path can mint or unlock liquid assets, then exact-quote economics before any fork." },
  { key: "fakeAssetPoolValidation", id: "fake-asset-pool-validation-sweep", protocol: "Fake asset/pool validation", chain: "multi-chain", surface: "Fake token, fake pool, hook, LP, and collateral acceptance scan", baseScore: 36, watchFields: ["deployedAcceptanceRows", "consumerLinkedRows", "exactEconomicsRows"], watchScale: 5, researchFields: ["validationRows", "staticSourceRows", "highStaticRows", "mediumStaticRows", "poolRows", "receiptRows", "filesScanned"], researchScale: 2000, closedStatus: "fake-asset-source-only-no-deployed-acceptance", watchStatus: "fake-asset-watch-needs-exact-economics-and-fork", sourceArtifacts: ["reports/raw/fast/fake-asset-pool-validation.json"], blockers: ["Static validation rows do not prove deployed attacker-created asset acceptance", "No row maps fake token/pool/hook/LP acceptance to live borrow, redeem, swap, or liquidation liquidity", "No exact positive unwind/collateral economics or fork proof"], requiredForRoutePositive: ["deployed value-moving consumer accepts attacker-created token, pool, hook, LP, receipt, or collateral", "acceptance path is permissionless and not role-gated by governance/admin/oracle configuration", "borrow, redeem, swap, or liquidation liquidity is live and material", "exact route economics are positive after gas, slippage, flash fees, and unwind costs", "fork/local proof demonstrates value extraction"], nextReadOnlyStep: "Treat current rows as source-only research. Add deployed acceptance mapping only when a specific consumer accepts an attacker-created asset/pool/hook/LP, then exact-quote economics before any fork." },
  { key: "strategyMigrationRebalance", id: "strategy-migration-rebalance-sweep", protocol: "Vault strategy migration/rebalance", chain: "multi-chain", surface: "Strategy migration, rebalance, withdrawal queue, and NAV/accounting drift scanner", baseScore: 36, routePositiveFields: ["routePositive", "executableNow"], watchFields: ["watchCandidates", "exactEconomicsRows"], watchScale: 5, researchFields: ["strategyArtifactRows", "sourceRows", "strategyRows", "migrationRows", "withdrawalQueueRows", "rebalanceRows"], researchScale: 1000, liquidityFields: ["strategyNetAssetValueUsd", "strategyLiquidationValueUsd", "maxDexLiquidityUsd"], closedStatus: "strategy-migration-no-route-positive", watchStatus: "strategy-migration-watch-needs-exact-economics-and-fork", sourceArtifacts: ["reports/raw/fast/strategy-migration-rebalance.json", "reports/strategy-migration-rebalance-triage.md"], blockers: ["Strategy, migration, rebalance, and withdrawal-queue rows are context until mapped to deployed value-moving entrypoints", "Role-gated strategy controls are not permissionless drain paths", "No row proves a same-block accounting drift joined to material accepted-value consumer liquidity", "No exact positive acquisition/action/redeem/borrow/liquidation/unwind economics or fork/local extraction proof"], requiredForRoutePositive: ["specific deployed vault/strategy migration, rebalance, report, or withdrawal-queue path is permissionless or attacker-reachable without role compromise", "path changes share price, NAV, queue claim, withdrawal value, reward value, or accepted collateral value in attacker-favorable direction", "affected share/token is accepted by a material consumer or has permissionless redeem/DEX exit liquidity", "acquisition/action/redeem/borrow/liquidation/unwind economics are exact-quoted positive after gas, slippage, fees, queues, and timing", "fork/local proof demonstrates net value extraction"], nextReadOnlyStep: "Keep strategy migration/rebalance on artifact watch; exact-quote/fork only if a concrete deployed row has permissionless state movement, material consumer/redeem liquidity, and positive economics." },
  { key: "poolShareSnapshotDrift", id: "pool-share-snapshot-drift-sweep", protocol: "Pool-share snapshot drift", chain: "multi-chain", surface: "LP/share/reward snapshot drift around same-block mutations", baseScore: 35, watchFields: ["deployedSnapshotDriftRows", "sameBlockMutationProofRows", "exactEconomicsRows"], watchScale: 5, researchFields: ["snapshotRows", "staticSnapshotRows", "readBeforeAndAfterRows", "perShareRows", "flashAdjacentRows", "collateralRows", "highStaticRows", "mediumStaticRows", "filesScanned"], researchScale: 1200, closedStatus: "pool-share-source-only-no-deployed-snapshot-drift", watchStatus: "pool-share-watch-needs-exact-economics-and-fork", sourceArtifacts: ["reports/raw/fast/pool-share-snapshot-drift.json"], blockers: ["Static snapshot rows do not prove a deployed same-block stale-read path", "No deployed row maps snapshot drift to live collateral/redeem/liquidation accounting with exact economics", "No fork-positive pool-share extraction proof"], requiredForRoutePositive: ["deployed path reads LP/share/reward state before a same-block external mutation and consumes stale state after the mutation", "mutation is permissionless or flash-loan/callback reachable without trusted role compromise", "stale value changes borrow, redeem, liquidation, reward, or collateral accounting in attacker-favorable direction", "borrow/redeem/swap/liquidation liquidity is live and exact-quoted", "fork/local proof demonstrates positive net extraction after gas, slippage, and flash fees"], nextReadOnlyStep: "Treat current rows as source-only research. Add deployed same-block snapshot-drift mapping only for a specific path that consumes stale state in value accounting, then exact-quote economics before any fork." },
  { key: "bridgeNonLosslessCollateralJoin", id: "bridge-nonlossless-collateral-join-sweep", protocol: "Bridge non-lossless accounting", chain: "multi-chain", surface: "Bridge value-bearing/non-lossless token signals joined to lending collateral consumers", baseScore: 36, watchFields: ["materialConsumerMismatchRows", "exactEconomicsRows", "forkProofRows"], watchScale: 5, researchFields: ["watchCandidates", "bridgeSignalRows", "bridgeSignalsWithProducerAnomaly", "concreteMismatchJoinedRows", "joinedRows", "materialJoinedRows", "consumerRows"], researchScale: 500, liquidityFields: ["topLiquidityUsd"], closedStatus: "bridge-accounting-join-research-only-no-delta-proof", watchStatus: "bridge-accounting-watch-needs-economics-and-fork", sourceArtifacts: ["reports/raw/fast/bridge-nonlossless-collateral-join.json"], blockers: ["Material joined rows are consumer exposure leads, not bridge balance-delta proofs", "Value-bearing bridge legs are not transfer-loss proof by themselves", "No material joined row has concrete bridge mismatch, exact positive borrow/exit economics, and fork/local extraction proof"], requiredForRoutePositive: ["bridge-side nominal accounting differs from observed token balance deltas on a deployed path", "the mismatched token is accepted by a material lending/DEX consumer on the same chain", "entry, borrow/redeem, and exit routes are exact-quoted and positive after gas/slippage/fees", "fork/local proof demonstrates extractable net profit"], nextReadOnlyStep: "Treat material bridge-consumer joins as research-only. Prove or rule out actual bridge transfer-delta/rebase mismatch before adding exact quote or fork work." },
  { key: "bridgeDeltaPreflight", id: "bridge-delta-preflight-sweep", protocol: "Bridge non-lossless accounting", chain: "multi-chain", surface: "Focused bridge balance-delta/backing preflight for top consumer joins", baseScore: 34, watchFields: ["materialMismatchRows", "exactEconomicsRows", "forkProofRows"], watchScale: 5, researchFields: ["concreteMismatchRows", "uniqueJoinRows", "routeProbeRows", "sourceLockboxConsumerRows", "remoteSyntheticConsumerRows"], liquidityFields: ["topLiquidityUsd"], closedStatus: "bridge-delta-closed-no-synthetic-consumer-mismatch", watchStatus: "bridge-delta-watch-needs-exact-economics-and-fork", sourceArtifacts: ["reports/raw/fast/bridge-delta-preflight.json"], blockers: ["Top material joins are source-chain lockbox/collateral-token consumers, not remote wrapped/synthetic exposure", "No material bridge balance-delta or backing mismatch was observed", "No exact positive borrow/exit economics or fork/local extraction proof"], requiredForRoutePositive: ["bridge path credits or releases nominal amount above observed received/burned/locked balance", "the over-credited wrapped/synthetic token is accepted by a material consumer", "consumer state permits permissionless value extraction", "exact acquisition and exit economics are positive after gas/slippage/fees", "fork/local proof demonstrates extractable net profit"], nextReadOnlyStep: "Search for wrapped/synthetic bridge legs accepted by consumers; skip lockbox-only matches unless a live bridge backing deficit appears." },
  { key: "bridgeSyntheticConsumerExposure", id: "bridge-synthetic-consumer-exposure-sweep", protocol: "Bridge non-lossless accounting", chain: "Ethereum/Base/Arbitrum/Ink", surface: "Wrapped/synthetic bridge leg consumer exposure search", baseScore: 33, watchFields: ["materialMismatchRows", "exactEconomicsRows", "forkProofRows"], watchScale: 5, researchFields: ["aaveSyntheticReserveMatches", "materialAaveSyntheticRows", "step17SyntheticJoinedRows", "syntheticLegRows", "riskSyntheticLegRows", "aaveReserveScans"], closedStatus: "bridge-synthetic-no-consumer-exposure", watchStatus: "bridge-synthetic-watch-needs-delta-proof-and-economics", sourceArtifacts: ["reports/raw/fast/bridge-synthetic-consumer-exposure.json"], blockers: ["Synthetic/reserve matches are consumer-exposure leads, not bridge balance-delta proofs", "Live Aave reserve checks found no synthetic bridge token with a proven material mismatch", "No exact positive economics or fork/local proof"], requiredForRoutePositive: ["consumer accepts the wrapped/synthetic bridge token, not only a source lockbox/collateral token", "bridge-side balance-delta or backing mismatch is proven live for that token", "consumer has material unpaused borrow/redeem/liquidation/exit liquidity", "exact economics are positive after gas/slippage/fees", "fork/local proof demonstrates extractable net profit"], nextReadOnlyStep: "Extend synthetic-leg consumer search beyond Aave only if new consumer artifacts list synthetic bridge tokens or a bridge backing mismatch appears." },
  { key: "steammMarketability", id: "steamm-zero-offset-marketability-sweep", protocol: "STEAMM", chain: "Sui", surface: "One-sided zero-offset CPMM output marketability ranking", baseScore: 37, researchFields: ["candidateCount", "steammRouteOnlyCount"], liquidityFields: ["bestLiquidityUsd"], sourceArtifacts: ["reports/raw/steamm-candidate-marketability.json", "reports/raw/suilend-suite-candidate-probe.json", "reports/raw/steamm-cpmm-zero-offset-poc.json"], blockers: ["No DexScreener-priced output token", "Only one internal STEAMM route-only row and 38 unpriced rows", "No exact external unwind economics or fork/local route-positive proof"], requiredForRoutePositive: ["zero-offset pool remains live", "output token has redeemable or externally priced liquidity", "net unwind value exceeds input/gas/fees", "Sui local/fork proof"], nextReadOnlyStep: "Keep the marketability scanner on watch; reopen only if dexPricedCount > 0 or an internal route can be exact-quoted into a valuable token." },
  { key: "validationDifferentialLiquidations", id: "validation-differential-liquidation-sweep", protocol: "Lending/perps validation gates", chain: "multi-chain", surface: "Kamino-style liquidation-specific reduced validation scan", baseScore: 35, researchFields: ["candidateFiles", "highConfidenceFiles", "kaminoStaleReducedDebtRows"], watchFields: ["liveWindowCandidates", "kaminoSameSlotReducedDebtRows", "kaminoSameSlotLiquidatableRows"], sourceArtifacts: ["reports/raw/fast/validation-differential-liquidations.json", "reports/validation-differential-liquidations-triage.md"], blockers: ["Kamino LIVE_WINDOW is none", "No same-slot reduced-status liquidatable row", "Source hits require protocol-specific proof and exact repay/collateral-exit economics"], requiredForRoutePositive: ["same-slot reduced validation window on a live obligation", "obligation is liquidatable under reduced status", "exact repay acquisition and collateral exit are positive", "local/fork proof"], nextReadOnlyStep: "Keep Kamino live-window monitor running periodically; inspect non-Kamino heuristic source hits only after a live/status-gated candidate appears." },
  { key: "jupiterLendOracleDivergence", id: "jupiter-lend-oracle-divergence-sweep", protocol: "Jupiter Lend", chain: "Solana", surface: "Operate-vs-liquidate oracle divergence joined to debt ticks", baseScore: 35, researchFields: ["debtVaultsWithDivergentOracle", "divergentDebtWatchRows", "liquidationFavorableDebtVaults"], watchFields: ["candidateRows"], quoteFields: ["maxAddedDebtTicksFromLiquidateRate", "maxAddedRiskyPositionsFromLiquidateRate"], closedStatus: "no-current-debt-bearing-divergence", sourceArtifacts: ["reports/raw/fast/jupiter-lend-oracle-divergence.json", "reports/jupiter-lend-oracle-divergence-triage.md"], blockers: ["No current debt-bearing operate-vs-liquidate oracle divergence", "No exact repay acquisition/collateral exit economics", "No local/fork proof"], requiredForRoutePositive: ["liquidation view newly makes debt-bearing tick/position liquidatable", "repay token acquisition and seized collateral exit are exact-quoted", "route is positive after fees/slippage", "local/fork proof"], nextReadOnlyStep: "Keep Jupiter Lend on watch; add exact repay/collateral-exit modeling only if candidateRows > 0 or a refreshed divergence flips a debt-bearing tick." },
  { key: "jupiterXstockMultiplierImpact", id: "jupiter-xstock-multiplier-impact-sweep", protocol: "Jupiter Lend / xStocks", chain: "Solana", surface: "xStock displayed-vs-prescaled multiplier impact joined to debt ticks", baseScore: 37, watchFields: ["tickFlipRows", "nearFlipRows", "overborrowPositiveRows"], watchScale: 5, researchFields: ["watchCandidates", "xstockVaultRowsScanned", "priceRowsFetched"], edgeFields: ["maxPriceModeGapBps"], closedStatus: "dormant-no-current-multiplier-impact-route", watchStatus: "xstock-multiplier-watch-needs-exact-quotes-and-proof", sourceArtifacts: ["reports/raw/fast/jupiter-xstock-multiplier-impact.json"], blockers: ["SPYx/QQQx multiplier semantics are real, but current tick state does not create liquidation or borrow-route impact", "Current price-mode gap is far below multiplier-only overborrow break-even", "USDG transfer fee is 0 and transfer hook is inactive", "No exact repay/acquire, collateral-exit, or local/fork-equivalent proof"], requiredForRoutePositive: ["xStock displayed-vs-prescaled price mode creates a current debt-tick flip or positive unwind value", "repay/acquisition and seized-collateral exit are exact-quoted after fees/slippage/priority fees", "route economics are positive", "local/fork-equivalent Solana proof", "explicit authorization before any signed action"], nextReadOnlyStep: "Keep SPYx/QQQx on multiplier watch; exact-quote only if tickFlipRows, nearFlipRows, or overborrowPositiveRows becomes positive." },
  { key: "ptOracleUnitMismatch", id: "pt-oracle-unit-mismatch-sweep", protocol: "PT/RWA receipt consumers", chain: "Ethereum", surface: "LoopScale-style PT oracle unit-mismatch consolidation", baseScore: 36, researchFields: ["rows", "materialRows", "positivePremiumRows", "materialPositivePremiumRows"], quoteFields: ["exactQuoteRows"], bestNetFields: ["bestMaterialNetEdgeUsd", "bestNetEdgeUsd"], sourceArtifacts: ["reports/raw/fast/pt-oracle-unit-mismatch.json", "reports/pt-oracle-unit-mismatch-triage.md"], blockers: ["Material PT premium rows remain below LTV/LLTV break-even", "Exact acquisition/exit routes are missing or net-negative", "No PT consumer row has fork-ready positive economics"], requiredForRoutePositive: ["PT/RWA receipt accepted in a material consumer", "consumer oracle value exceeds executable acquisition/redemption value after LTV", "borrow/liquidation liquidity exists", "exact route economics positive after gas/slippage", "fork/local proof"], nextReadOnlyStep: "Refresh Pendle/Silo/Morpho PT artifacts; reopen only if a material row has accepted-vs-acquisition above LTV break-even with exact quotes." },
  { key: "deprecatedOrphanedReachability", id: "deprecated-orphaned-reachability-sweep", protocol: "Deprecated/orphaned contracts", chain: "multi-chain", surface: "Generic deprecated/orphaned deployed reachability inventory", baseScore: 36, watchFields: ["permissionlessValuePathRows", "liveApprovalOrEscrowRows", "exactEconomicsRows", "forkProofRows"], watchScale: 5, researchFields: ["deprecatedReachabilityRows", "liveCodeRows", "selectorReachabilityRows", "orphanImplementationCandidateRows", "uniqueAddressCandidates"], researchScale: 220, liquidityFields: ["liveBalanceRows"], closedStatus: "deprecated-orphaned-inventory-only-no-value-path", watchStatus: "deprecated-orphaned-watch-needs-approval-escrow-economics", sourceArtifacts: ["reports/raw/fast/deprecated-orphaned-reachability.json"], blockers: ["Code-positive deprecated/orphaned rows are inventory only; selector presence does not prove permissionless value movement", "No row proves live approvals, escrow accounting, registry reachability, or protocol balances are extractable", "No exact positive economics or fork extraction proof"], requiredForRoutePositive: ["deprecated/orphaned deployed path is permissionlessly callable without trusted role compromise", "path reaches live approvals, escrow, protocol balances, or registry-consumed accounting", "exact extraction, borrow, redeem, claim, swap, or liquidation economics are positive after gas/slippage/fees", "fork/local proof demonstrates net value extraction"], nextReadOnlyStep: "Manually inspect top code-positive deprecated rows for live approvals, escrow, and registry references; only exact-quote/fork after a concrete value path is proven." },
  { key: "bridgeDomainSeparation", id: "bridge-domain-separation-sweep", protocol: "Bridge messaging", chain: "multi-chain", surface: "Hop-style bridge root/message identifier domain-separation static scan", baseScore: 30, researchFields: ["identifierRows", "missingDomainRows", "highStaticRows", "nonHopHighStaticRows"], sourceArtifacts: ["reports/raw/fast/bridge-domain-separation.json", "reports/bridge-domain-separation-triage.md", "reports/hop-triage.md"], blockers: ["Only the known Hop transferRootId row remains high-static", "Hop row requires registered-bonder capability and is liveness/freeze impact, not permissionless TVL extraction", "No non-Hop deployed path proves a permissionless domain collision with extractable funds"], requiredForRoutePositive: ["domain-colliding identifier exists in a deployed bridge path", "attacker can call the colliding action without privileged bridge/bonder/operator role", "collision maps to extractable funds or settlement capture", "exact route economics are positive", "fork/local proof"], nextReadOnlyStep: "Proceed to signed-payload replay scanning; reopen bridge domain rows only if a non-Hop high-static deployed path appears or Hop role/access assumptions change." },
  { key: "postAuditScopeDrift", id: "post-audit-scope-drift-sweep", protocol: "Post-audit drift", chain: "multi-chain", surface: "Changed or out-of-scope source/deployment surfaces after local audits", baseScore: 34, watchFields: ["deployedReachabilityRows", "permissionlessValuePathRows", "exactEconomicsRows"], watchScale: 5, researchFields: ["driftRows", "staticDriftRows", "highStaticRows", "mediumStaticRows", "postAuditChangedRows", "outOfScopeRows", "valuePathRows", "privilegedConfigRows"], researchScale: 2000, closedStatus: "post-audit-drift-source-only-no-deployed-value-path", watchStatus: "post-audit-drift-watch-needs-exact-economics-and-fork", sourceArtifacts: ["reports/raw/fast/post-audit-scope-drift.json"], blockers: ["Rows are source/audit-scope drift leads, not deployed exploit routes", "No row is mapped to a permissionless deployed value path with live balances or borrow/redeem liquidity", "No exact positive route economics or fork/local proof"], requiredForRoutePositive: ["changed or out-of-scope code is mapped to deployed bytecode or an active governance/deployment payload", "entrypoint is permissionless or externally triggerable without trusted role compromise", "path moves funds or changes oracle/config/settlement/borrow/redeem accounting", "live route economics are exact-quoted and positive after gas/slippage/fees", "fork/local proof demonstrates extractable net profit"], nextReadOnlyStep: "Treat current source drift rows as research-only. Reopen only when a specific changed/out-of-scope row is mapped to deployed bytecode or active payload plus permissionless value path, then exact-quote economics before fork." },
  { key: "postAuditDeployedMap", id: "post-audit-deployed-map-sweep", protocol: "Post-audit deployed map", chain: "multi-chain", surface: "TermMax/Dolomite deployed mapping for post-audit drift rows", baseScore: 35, watchFields: ["permissionlessAcceptedMarketRows", "permissionlessValuePathRows", "exactEconomicsRows"], watchScale: 5, researchFields: ["liveCodeRows", "deployedAddressRows", "findings", "roleOrMarketStateBlockedFindings", "driftRowsConsidered", "termmaxBroadcastRows", "dolomiteDeploymentRows"], researchScale: 500, closedStatus: "deployed-drift-map-role-state-blocked-no-value-path", watchStatus: "deployed-drift-watch-needs-exact-economics-and-fork", sourceArtifacts: ["reports/raw/fast/post-audit-deployed-map.json"], blockers: ["TermMax feed/market acceptance is role-gated through AccessManager ORACLE_ROLE/MARKET_ROLE", "Dolomite MagicGLP/POL oracle rows require closing/non-borrowable markets and router upgrades are owner-gated", "No deployed row is joined to a permissionless accepted market/value path with exact positive borrow/redeem/liquidation or settlement economics"], requiredForRoutePositive: ["deployed drift implementation is actively used by an accepted market or route", "entrypoint is permissionless or externally triggerable without role compromise", "market/oracle state permits value extraction", "live acquisition and exit liquidity are exact-quoted and positive after gas/slippage/fees", "fork/local proof demonstrates extractable net profit"], nextReadOnlyStep: "Treat current live-code rows as deployed inventory only. Decode concrete TermMax/Dolomite market configs only if a row can be joined to a permissionless accepted market/value path, then exact-quote economics before any fork." },
  { key: "deployedPathProofGaps", id: "deployed-path-proof-gap-sweep", protocol: "Static/deployed proof gaps", chain: "multi-chain", surface: "Aggregate deployed-path proof coverage for static/source-only scans", baseScore: 34, watchFields: ["deployedValuePathRows", "exactEconomicsRows", "forkProofRows"], watchScale: 5, researchFields: ["branchesScanned", "staticRows", "highStaticRows", "deployedPathRows", "liveCodeRows", "deployedReachabilityRows", "selectorReachabilityRows"], researchScale: 1000, closedStatus: "deployed-path-proof-gaps-no-value-path", watchStatus: "deployed-path-watch-needs-value-path-economics-and-fork", sourceArtifacts: ["reports/raw/fast/deployed-path-proof-gaps.json"], blockers: ["Static/source-only rows and deployed inventories are aggregate proof gaps, not route-positive evidence", "No row maps deployed bytecode or selector reachability to a permissionless value path", "No exact positive economics or fork/local extraction proof"], requiredForRoutePositive: ["specific static row maps to deployed bytecode or verified deployed source", "entrypoint is permissionless or attacker-reachable without privileged compromise", "deployed path moves, mints, unlocks, prices, or accounts for live value", "exact acquisition/borrow/redeem/liquidation/unwind economics are positive after costs", "fork/local proof demonstrates net value extraction"], nextReadOnlyStep: "Use this aggregate only as a proof-gap checklist; pursue route-specific deployed mapping only when a branch gains deployed value-path rows." },
  { key: "signedPayloadReplay", id: "signed-payload-replay-sweep", protocol: "Signed-write APIs/contracts", chain: "multi-chain", surface: "Hypercall-style signed payload replay static/source scan", baseScore: 29, researchFields: ["signatureRows", "confirmedSeedRows", "highStaticRows", "mediumStaticRows"], sourceArtifacts: ["reports/raw/fast/signed-payload-replay.json", "reports/signed-payload-replay-triage.md", "reports/synapse-hypercall-triage.md"], blockers: ["Hypercall replay is confirmed only on testnet/prelaunch", "Current source rows show domain, nonce/expiry, and consumption/fill-state or no live write route", "No controlled-account/fork proof of replayable mainnet asset movement"], requiredForRoutePositive: ["signed write endpoint or contract is live/mainnet", "captured signature replays after intended one-time use, fill, cancellation, or revocation", "replay causes asset movement or position-control impact", "controlled-account or fork proof is positive"], nextReadOnlyStep: "Proceed to gas-accounting tip-race scan; reopen signed replay only if a live API/source path lacks nonce consumption or Hypercall mainnet launches unchanged." },
  { key: "predictionMarketLiveRoutes", id: "prediction-market-live-route-sweep", protocol: "Prediction markets", chain: "Polygon", surface: "Prediction-market order, collateral, resolution, and payout live-route scanner", baseScore: 36, routePositiveFields: ["routePositive", "executableNow"], watchFields: ["watchCandidates", "adapterWatchRows", "noProofProbeSuccessRows"], watchScale: 3, researchFields: ["liveTargets", "codePresentTargets", "balanceRows", "materialBalanceRows", "signedReplayScopedRows", "artifactRows"], researchScale: 50, liquidityFields: ["vaultCollateralUsd", "adapterUsdcEUsd"], closedStatus: "prediction-market-no-route-positive", watchStatus: "prediction-market-watch-needs-delta-economics-and-fork", sourceArtifacts: ["reports/raw/fast/prediction-market-live-routes.json", "reports/prediction-market-live-routes-triage.md", "reports/raw/fast/signed-payload-replay.json", "reports/polymarket-ctf-exchange-v2-triage.md"], blockers: ["Material prediction-market escrow balances are context only without a permissionless value-moving path", "Adapter USDC.e full-balance sweep trigger is zero", "No dummy no-proof staticcall succeeds against order, adapter, claim, or sweep probes", "Signed Polymarket order rows remain domain/nonce/fill-state/action scoped", "No exact positive economics or fork/local extraction proof"], requiredForRoutePositive: ["specific live market/order/condition/collateral target is reachable without privileged operator/admin action", "attacker can move collateral or outcome-token value through order fill, adapter conversion, resolution, payout redemption, or sweep", "exact input/output economics are positive after fees, gas, slippage, outcome-token depth, and collateral exit", "read-only probe or fork/local proof shows attacker-controlled positive balance delta"], nextReadOnlyStep: "Keep Polymarket/CTF balances on watch; reopen only if adapter USDC.e appears, no-proof value movement succeeds, or a condition-specific resolution/payout bypass is proven." },
  { key: "crossChainSettlementQuotes", id: "cross-chain-settlement-quote-sweep", protocol: "Cross-chain settlement", chain: "multi-chain", surface: "Cross-chain bridge/settlement exact quote consolidation", baseScore: 36, routePositiveFields: ["routePositive", "executableNow"], watchFields: ["watchCandidates", "concreteMismatchRows", "priceDiscrepancies"], watchScale: 3, quoteFields: ["exactQuoteRows", "socketCrossChainRoutes", "branchQuoteRows"], quoteScale: 20, researchFields: ["socketRoutes", "uniqueBridgeProviders", "bridgeConsumerWatchRows", "bridgeMaterialJoinedRows"], researchScale: 60, bestNetFields: ["bestNetUsd"], liquidityFields: ["bestOutputValueUsd"], closedStatus: "cross-chain-settlement-no-route-positive", watchStatus: "cross-chain-settlement-watch-needs-mismatch-economics-and-fork", sourceArtifacts: ["reports/raw/fast/cross-chain-settlement-quotes.json", "reports/cross-chain-settlement-quotes-triage.md", "reports/raw/fast/socket-route-quotes.json", "reports/raw/fast/bridge-delta-preflight.json"], blockers: ["Socket cross-chain quotes are exact route metadata only until joined to an exploit branch", "No bridge telemetry row has concrete proof/custody/balance-delta mismatch joined to exact quotes", "Cross-chain price feed scan found no discrepancy above threshold", "No finality/fee/gas/slippage adjusted route is branch-positive", "No fork/local extraction proof"], requiredForRoutePositive: ["specific bridge, settlement, or cross-chain price mismatch is proven live and permissionless", "route has exact bridge quote including minOut, gas, bridge fees, estimated finality, token accounting, and destination exit liquidity", "economics remain positive after source/destination gas, slippage, finality risk, and fees", "approval spender and tx target are allowlisted and simulated", "fork/local proof demonstrates net extraction before any signed action"], nextReadOnlyStep: "Keep Socket quote refresh available for route-specific branches; reopen cross-chain settlement only if a concrete bridge mismatch or price discrepancy appears." },
  { key: "intentSolverSettlementAbuse", id: "intent-solver-settlement-abuse-sweep", protocol: "Intent / solver settlement", chain: "multi-chain artifact", surface: "Artifact-only consolidation of router/RFQ field-binding, UniswapX filler telemetry, solver architecture, cross-chain quote, and signed-payload settlement-abuse context", baseScore: 40, routePositiveFields: ["routePositive", "executableNow"], watchFields: ["watchCandidates"], watchScale: 40, researchFields: ["sourceRows", "fieldBindingProofRows", "deployedRouterInventoryRows", "deployedWatchRows", "transferOnlyProfitDowngradedRows", "fillEvents", "uniqueFillers", "transferProfitRows", "crossChainExactQuoteRows", "branchQuoteRows"], researchScale: 150, quoteFields: ["decodedOrderRows", "sandwichSimulationRows", "exactEconomicsRows", "forkProofRows"], closedStatus: "intent-solver-settlement-no-route-positive", watchStatus: "intent-solver-settlement-watch-needs-decoded-order-balance-delta-economics", sourceArtifacts: ["reports/raw/fast/intent-solver-settlement-abuse.json", "reports/intent-solver-settlement-abuse-triage.md", "reports/raw/fast/router-rfq-settlement-drift.json", "reports/raw/fast/mev-sandwich-order-economics.json", "reports/raw/fast/uniswapx-filler-profit.json", "reports/raw/fast/uniswapx-filler-mev.json", "reports/raw/fast/fusion-resolver-analysis.json", "reports/raw/fast/cross-chain-settlement-quotes.json", "reports/raw/fast/signed-payload-replay.json"], blockers: ["Transfer-only positive fill rows are downgraded because they lack decoded order fields, exact token pricing, balance-delta economics, and fork/local proof", "Cross-chain quote rows are route-intelligence context only until joined to a proven settlement or bridge mismatch branch", "Router/RFQ deployed selector and field-binding context has no verified signed-field versus settlement-field drift on a deployed value path", "No live approval/escrow reachability, exact balance-delta mismatch, exact positive economics, or fork/local extraction proof", "Fork/executor/signed-action gates remain blocked while routePositive=0"], requiredForRoutePositive: ["decoded intent/order/settlement fields including maker/taker, tokens, amounts, recipient, deadline, nonce/fill state, user limits, and auction/solver terms", "verified deployed settlement path where signed fields differ from executed transfer fields or solver execution can permissionlessly extract value", "live approval, escrow, balance, or custody reachability on the deployed path without privileged roles or off-chain-only solver access", "exact balance-delta economics positive after gas, fees, slippage, token pricing, finality/bridge costs, and user-loss/filler-profit accounting", "fork/local proof demonstrating net extraction before any signed action, broadcast, wallet operation, or exploit execution"], nextReadOnlyStep: "Join positive transfer-only fills to decoded order payloads and per-token balance deltas; only exact-quote/fork after a deployed settlement mismatch and exact positive economics are proven." },
  { key: "mevSandwichOrderEconomics", id: "mev-sandwich-order-economics-sweep", protocol: "MEV / order settlement", chain: "Ethereum", surface: "MEV, sandwich, filler, and RFQ exact-order economics gate", baseScore: 36, routePositiveFields: ["routePositive", "executableNow"], watchFields: ["watchCandidates", "decodedOrderRows", "sandwichSimulationRows", "exactEconomicsRows"], watchScale: 3, researchFields: ["fillEvents", "uniqueFillers", "transferProfitRows", "transferOnlyPositiveRows", "routerFieldBindingProofRows"], researchScale: 80, quoteFields: ["decodedOrderRows", "sandwichSimulationRows"], closedStatus: "mev-order-economics-no-route-positive", watchStatus: "mev-order-economics-watch-needs-decoded-order-and-fork", sourceArtifacts: ["reports/raw/fast/mev-sandwich-order-economics.json", "reports/mev-sandwich-order-economics-triage.md", "reports/raw/fast/uniswapx-filler-mev.json", "reports/raw/fast/uniswapx-filler-profit.json", "reports/raw/fast/router-rfq-settlement-drift.json"], blockers: ["Transfer-only profit rows do not decode order inputs, outputs, limits, auction curves, or exact token prices", "No sandwich simulation or counterfactual route exists for observed fills", "Router/RFQ scan has no verified field diff, live approval/escrow row, balance-delta mismatch, or exact economics", "No fork/local extraction proof"], requiredForRoutePositive: ["specific order or router settlement is decoded with maker/taker tokens, amounts, limits, deadline, recipient, and auction curve", "counterfactual fill/sandwich path is permissionless and executable without privileged filler role", "exact token prices, gas, fees, slippage, and user-loss/filler-profit economics are positive", "settlement field binding or pool-ordering weakness is proven on deployed path", "fork/local proof demonstrates net extraction before any signed action"], nextReadOnlyStep: "Keep UniswapX telemetry as context; reopen only if decoded order-level data or a target-specific router/pool sandwich simulation becomes available." },
  { key: "claimDistributorReplay", id: "claim-distributor-replay-sweep", protocol: "Claim/reward distributors", chain: "multi-chain", surface: "Airdrop, reward, and claim replay / receiver-binding scanner", baseScore: 36, watchFields: ["liveWatchCandidates", "publicNoProofProbeSuccessRows"], watchScale: 5, researchFields: ["sourceClaimRows", "highStaticRows", "mediumStaticRows", "liveTargetsWithClaimSelectors"], researchScale: 300, closedStatus: "claim-distributor-no-route-positive", watchStatus: "claim-distributor-watch-needs-state-delta-and-fork", sourceArtifacts: ["reports/raw/fast/claim-distributor-replay.json", "reports/claim-distributor-replay.md"], blockers: ["Static claim rows are source review leads until mapped to deployed bytecode and live balances", "No live row proves replayable proof, arbitrary receiver drain, or no-proof asset movement", "No exact positive value movement or fork/local extraction proof"], requiredForRoutePositive: ["live deployed claim or reward distributor has material token balance", "proof/signature/claim can be replayed or receiver can be redirected without authorization", "claim transfers assets or mints value in a controlled static/fork proof", "exact token value is positive after gas and any required setup"], nextReadOnlyStep: "Extend live distributor seeds for any prioritized protocol; only fork after a row proves weak claim scoping plus material live balance and controlled state-delta asset movement." },
  { key: "nonBorrowDrainSurface", id: "non-borrow-drain-surface-sweep", protocol: "Non-borrow drain surfaces", chain: "multi-chain", surface: "Consolidated non-borrow drain coverage and route gate", baseScore: 34, watchFields: ["routePositiveSurfaces", "executableNowSurfaces"], watchScale: 5, researchFields: ["surfaces", "covered", "partialGaps", "watchCandidates", "reviewRows"], researchScale: 600, closedStatus: "non-borrow-drain-surfaces-route-negative", watchStatus: "non-borrow-drain-watch-needs-route-positive-artifact", sourceArtifacts: ["reports/raw/fast/non-borrow-drain-surface.json", "reports/non-borrow-drain-surface.md"], blockers: ["No consolidated non-borrow surface has route-positive or executable-now status", "All tracked non-borrow surfaces have a dedicated route-negative coverage artifact", "No exact positive economics or fork/local extraction proof"], requiredForRoutePositive: ["a specific non-borrow surface emits routePositive > 0", "route is tied to live deployed state and material liquidity", "exact economics remain positive after gas, slippage, fees, queues, and timing", "fork/local proof demonstrates net value extraction"], nextReadOnlyStep: "Close current non-borrow pass as route-negative; reopen a surface only when a route-positive artifact appears or a target-specific signal is prioritized." },
  { key: "gasAccountingTipRace", id: "gas-accounting-tip-race-sweep", protocol: "Executor gas accounting", chain: "multi-chain", surface: "Synapse-style EIP-150 under-supply first-failure tip race scan", baseScore: 29, researchFields: ["gasRelevantRows", "highStaticRows", "mediumStaticRows"], sourceArtifacts: ["reports/raw/fast/gas-accounting-tip-race.json", "reports/gas-accounting-tip-race-triage.md", "reports/synapse-hypercall-triage.md"], blockers: ["Only Synapse Sanguine Core matches the complete high-static shape", "Confirmed impact is tip/liveness scoped and Synapse mainnet message flow is dormant", "No permissionless principal-drain or positive value route is proven"], requiredForRoutePositive: ["executor path is live/mainnet and permissionless", "EIP-150 under-supply can force recorded failure before successful execution", "first-failure attribution captures material fees/tips or asset movement", "controlled/fork proof shows positive net value after gas"], nextReadOnlyStep: "Reopen only if Synapse message flow resumes with material tips, or another executor row combines weak gas gate, bounded call, and fee attribution." },
  { key: "dexHookSourceGating", id: "dex-hook-callback-abuse-sweep", protocol: "DEX Hook Callbacks", chain: "Ethereum", surface: "Cork Protocol $12M pattern source-gating for two Uniswap V4/ERC4626 hook callback rows", baseScore: 39, routePositiveFields: ["routePositive", "executableNow"], watchFields: ["bytecodeOnlyRows", "callbackFunctionRows", "erc4626SelectorRows"], watchScale: 6, researchFields: ["hooksReviewed"], closedStatus: "dex-hook-source-gated-no-route-positive", watchStatus: "dex-hook-source-gated-blocked-no-route-positive", sourceArtifacts: ["reports/raw/fast/dex-hook-source-gating.json", "reports/dex-hook-source-gating-triage.md", "reports/raw/fast/dex-hook-callback-cfg.json", "reports/raw/fast/dex-hook-callback-abuse.json"], blockers: ["Focused source lookup for both high-risk hooks returned bytecode-only/no verified source or decompile", "No source-level msg.sender/PoolManager gate proof or callback body evidence is available", "ERC4626 selector evidence remains selector-only and is not proven reachable from callbacks", "Observed ERC4626 vaults are V4 pool currencies, not proven callback-reached external value-moving targets", "No attacker-created pool/currency acceptance, exact receiver/value flow, exact-positive economics, or fork/local value-delta proof"], requiredForRoutePositive: ["Verified source/decompile or bounded trace proves callback body and msg.sender/PoolManager gate semantics", "ERC4626/value-moving call is reachable from a permissionless hook callback", "Attacker-controlled pool/currency path is accepted and reaches a deployed value target", "Exact receiver/value flow and economics are positive after gas/slippage/fees", "fork/local proof demonstrates positive value delta before any signed action"], nextReadOnlyStep: "Reopen only if verified source/decompile, callback trace evidence, or deployed value-target proof appears for either focused hook; do not fork/executor until routePositive>0 plus exact-positive economics." },
  { key: "insuranceFundDrainV2", id: "insurance-fund-drain-v2-sweep", protocol: "Insurance Funds / SP / SM", chain: "Ethereum/Arbitrum/Avalanche/dYdX/Solana", surface: "GMX GLP, Liquity SP, Aave SM, dYdX, Drift, Compound insurance fund drain surfaces", baseScore: 37, watchFields: ["watchCandidates"], researchFields: ["results"], liquidityFields: ["totalUSD"], edgeFields: ["coverageRatio"], closedStatus: "insurance-fund-drain-v2-dormant-no-route-positive", watchStatus: "insurance-fund-drain-v2-watch-needs-coverage-or-basket-exploit", sourceArtifacts: ["reports/raw/fast/insurance-fund-drain-v2.json"], blockers: ["GLP has known basket manipulation surface (score 40) but no live basket divergence at scan time", "Liquity V1 SP has 12.7% coverage ratio — above 10% threshold but depositors have limited protection", "Aave SM coverage vs total protocol debt is approximate", "dYdX Chain is Cosmos-based non-EVM; insurance fund requires dYdX Indexer API", "Drift Insurance Fund requires Solana RPC; marked as coverage caveat", "No fork extraction proof for any target"], requiredForRoutePositive: ["GLP basket token divergence >5% from market with DEX exit liquidity", "Liquity SP coverage ratio drops below 5%", "Aave SM total debt enumeration shows SM coverage below 5%", "fork extraction proof"], nextReadOnlyStep: "Keep as fast periodic refresh; reopen if GLP basket tokens diverge, SP coverage drops, or Solana RPC becomes available." },
  { key: "feeOnTransferRebase", id: "fee-on-transfer-rebase-sweep", protocol: "Multi-token", chain: "Ethereum", surface: "Fee-on-transfer and rebase token collateral risk", baseScore: 35, watchFields: ["watchCandidates"], researchFields: ["tokensScanned"], closedStatus: "fee-on-transfer-no-route-positive", watchStatus: "fee-on-transfer-watch-needs-live-divergence", sourceArtifacts: ["reports/raw/fast/fee-on-transfer-rebase.json"], blockers: ["No live fee/rebase divergence proven at current block", "No exact borrow/unwind economics", "No fork extraction proof"], requiredForRoutePositive: ["Fee-on-transfer or rebase token is accepted as collateral by a material lending consumer", "Live on-chain rebase or fee creates collateral value divergence favorable to attacker", "Exact borrow/unwind economics are positive after gas/slippage", "Fork extraction proof demonstrating positive net value"], nextReadOnlyStep: "Keep on watch; reopen only if a live fee/rebase divergence appears for a token listed as collateral in a material lending consumer." },
  { key: "aaveV3EmodeEscalation", id: "aave-v3-emode-escalation-sweep", protocol: "Aave V3", chain: "Ethereum", surface: "eMode category escalation risk", baseScore: 36, watchFields: ["watchCandidates"], researchFields: ["reservesInEmode"], closedStatus: "aave-emode-no-route-positive", watchStatus: "aave-emode-watch-needs-correlated-depeg", sourceArtifacts: ["reports/raw/fast/aave-v3-emode-escalation.json"], blockers: ["eMode category escalation not proven", "All enrolled reserves require user opt-in", "No depeg/category-escape route proven", "No fork extraction proof"], requiredForRoutePositive: ["eMode category escalation creates collateral/LTV mismatch that can be exploited", "Correlated depeg or price divergence within an eMode category", "Borrow-side liquidity is material and unpaused", "Exact borrow/liquidation/unwind economics are positive after gas/slippage/fees", "Fork extraction proof demonstrating positive net value"], nextReadOnlyStep: "Keep Aave V3 eMode categories on watch; reopen only if a correlated depeg or category-escape route appears within an eMode group with material reserves." },
  { key: "recentMorphoCreateMarkets", id: "recent-morpho-create-market-sweep", protocol: "Morpho Blue", chain: "multi-chain (14 chains)", surface: "Recent CreateMarket events across configured Morpho chains with oracle classification", baseScore: 38, watchFields: ["watchCandidates"], researchFields: ["recentMarkets", "highLltvRows", "materialLiquidityRows", "materialBorrowRows", "nonChainlinkLikeRows"], liquidityFields: [], closedStatus: "recent-create-markets-no-route-positive", watchStatus: "recent-morpho-create-market-watch-needs-cash-and-borrow", sourceArtifacts: ["reports/raw/fast/recent-morpho-create-markets.json"], blockers: ["16 recent high-LLTV Morpho markets exist on Ethereum but all have zero or dust liquidity/borrow", "No fresh market has both a non-Chainlink oracle and material borrowable liquidity"], requiredForRoutePositive: ["fresh Morpho market has high LLTV, non-Chainlink/custom oracle, and material borrow cash", "oracle/source decode proves accepted-vs-realizable value divergence", "borrow and exit routes are exact-quoted positive after gas/slippage/fees", "fork extraction proof"], nextReadOnlyStep: "Keep recent Morpho markets on cash/borrow watch; escalate only if a high-LLTV custom-oracle market gains material liquidity/borrow." },
  { key: "defillamaTopNewDeepDive", id: "defillama-top-new-deep-dive-sweep", protocol: "Top new DeFiLlama targets", chain: "multi-chain", surface: "Top new DeFiLlama oracle-classifier targets deep dive with adapter source and yield joins", baseScore: 35, watchFields: ["watchCandidates"], researchFields: ["targets", "withAdapterSource", "adapterAddressRows", "withYieldRows", "withLocalCoverage"], liquidityFields: [], closedStatus: "defillama-top-new-no-route-positive", watchStatus: "defillama-top-new-watch-needs-consumer-join-or-economics", sourceArtifacts: ["reports/raw/fast/defillama-top-new-deep-dive.json", "reports/raw/fast/defillama-oracle-classifier.json"], blockers: ["7 top-new targets researched; all are yield-aggregator/CDP shape with no consumer join proving material borrow/redeem/liquidation liquidity", "Reservoir has dedicated phase-0 with routePositive=0; Homora V2 is covered dormant"], requiredForRoutePositive: ["specific top-new target maps a deployed producer anomaly to a live material consumer", "borrow/redeem/liquidation/unwind economics exact-quoted positive", "fork extraction proof"], nextReadOnlyStep: "For top-new yield aggregators, reopen only after a share token joins a lending/borrow consumer or accepted-value route." },
  { key: "defillamaTopNewConsumerJoins", id: "defillama-top-new-consumer-join-sweep", protocol: "Top new DeFiLlama target joins", chain: "multi-chain", surface: "DeFiLlama top-new adapter-extracted address to local consumer artifact join", baseScore: 30, watchFields: ["watchCandidates"], researchFields: ["addressesChecked", "targetsWithMatches", "targetsWithConsumerLikeMatches"], liquidityFields: [], closedStatus: "defillama-top-new-consumer-joins-no-route-positive", watchStatus: "defillama-consumer-join-watch-needs-exact-economics", sourceArtifacts: ["reports/raw/fast/defillama-top-new-consumer-joins.json", "reports/raw/fast/defillama-top-new-deep-dive.json"], blockers: ["86 adapter-extracted addresses checked; 5 have local matches but only Reservoir has consumer-like matches (51 rows)", "Reservoir PSM address matches are consumer-like but route-negative in dedicated phase-0 artifact"], requiredForRoutePositive: ["local consumer artifact match maps to live material borrow/redeem/liquidation liquidity", "exact positive economics and fork extraction proof"], nextReadOnlyStep: "Reservoir PSM adapter address remains the only consumer-like match; keep on dedicated-adapter dormant watch." },

];

function buildArtifact(artifacts = Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, loadJson(file, {})]))) {
  const candidates = [
    artifacts.aaveV3RouteDistance?.generatedAt ? aaveV3Candidate(artifacts.aaveV3RouteDistance, artifacts.aaveV3TriggerReadiness) : null,
    artifacts.aaveV4Borrowers?.generatedAt || artifacts.aaveV4Hubs?.generatedAt ? aaveV4Candidate(artifacts.aaveV4Hubs, artifacts.aaveV4Borrowers, artifacts.aaveV4LiquidationQuotes, artifacts.aaveV4LiquidationShadowQuotes, artifacts.aaveV4StablePairRouteProbe, artifacts.aaveV4OracleInfluence) : null,
    artifacts.hyperlendStaleSource?.generatedAt ? hyperlendCandidate(artifacts.hyperlendStaleSource) : null,
    artifacts.venusBaseWsteth?.generatedAt ? venusBaseCandidate(artifacts.venusBaseWsteth) : null,
    artifacts.lorenzoSusd1Plus?.generatedAt ? lorenzoCandidate(artifacts.lorenzoSusd1Plus, artifacts.lorenzoSameEpochExit) : null,
    artifacts.lorenzoStep6Accounting?.generatedAt ? lorenzoStep6AccountingCandidate(artifacts.lorenzoStep6Accounting) : null,
    artifacts.lombardRatioDomainStep7?.generatedAt ? lombardRatioDomainStep7Candidate(artifacts.lombardRatioDomainStep7) : null,
    artifacts.morphoHighApyLiquidationRoutes?.generatedAt ? morphoHighApyCandidate(artifacts.morphoHighApyLiquidationRoutes, artifacts.morphoHighApyNonDexExitClassification) : null,
    artifacts.morphoPythUnsafeConsumers?.generatedAt ? morphoPythCandidate(artifacts.morphoPythUnsafeConsumers, artifacts.morphoPythWatchPreflight) : null,
    artifacts.lrtOracleDriftRoutes?.generatedAt ? lrtOracleDriftCandidate(artifacts.lrtOracleDriftRoutes, artifacts.lrtOraclePremiumProbe) : null,
    artifacts.curveIbStable?.generatedAt ? curveIbStableCandidate(artifacts.curveIbStable) : null,
    artifacts.apyusdForkProof?.generatedAt ? apyusdForkProofCandidate(artifacts.apyusdRedeemRoute, artifacts.apyusdForkProof) : null,
    artifacts.staderForkTransactionTest?.generatedAt ? staderForkTransactionCandidate(artifacts.staderForkTransactionTest, artifacts.staderFullTest) : null,
    artifacts.polymarketAdapterFullBalanceGate?.generatedAt ? polymarketAdapterFullBalanceCandidate(artifacts.polymarketAdapterFullBalanceGate) : null,
    artifacts.kaminoReducedStatusRecertification?.generatedAt ? kaminoReducedStatusRecertificationCandidate(artifacts.kaminoReducedStatusRecertification) : null,
    artifacts.synapseCctpStep8?.generatedAt ? synapseCctpStep8Candidate(artifacts.synapseCctpStep8, artifacts.synapseCctpStep8Manifest) : null,
    artifacts.babylonLateQuorumProductionExposure?.generatedAt ? babylonLateQuorumProductionExposureCandidate(artifacts.babylonLateQuorumProductionExposure, artifacts.babylonLateQuorumProductionExposureManifest) : null,
    artifacts.babylonPreRetentionSourceReadiness?.generatedAt ? babylonPreRetentionSourceReadinessCandidate(artifacts.babylonPreRetentionSourceReadiness, artifacts.babylonPreRetentionSourceReadinessManifest) : null,
    artifacts.babylonMintscanPreRetentionEnumerator?.generatedAt ? babylonMintscanPreRetentionEnumeratorCandidate(artifacts.babylonMintscanPreRetentionEnumerator, artifacts.babylonMintscanPreRetentionEnumeratorManifest) : null,
    artifacts.criticalUnitProxyControl?.generatedAt ? criticalUnitProxyControlCandidate(artifacts.criticalUnitProxyControl, artifacts.criticalUnitProxyControlManifest) : null,
    artifacts.criticalEtherfiDefaultModuleCapability?.generatedAt ? criticalEtherfiDefaultModuleCapabilityCandidate(artifacts.criticalEtherfiDefaultModuleCapability, artifacts.criticalEtherfiDefaultModuleCapabilityManifest, artifacts.criticalEtherfiPinboundBuildBinding, artifacts.criticalEtherfiPinboundBuildBindingManifest, artifacts.criticalEtherfiPendingWithdrawalTuple, artifacts.criticalEtherfiPendingWithdrawalTupleManifest, artifacts.criticalEtherfiStargateValidAuthTupleInvariant, artifacts.criticalEtherfiStargateValidAuthTupleInvariantManifest, artifacts.criticalEtherfiStargateAssetConfigDrift, artifacts.criticalEtherfiStargateAssetConfigDriftManifest, artifacts.criticalEtherfiUnknownDefaultIdentityBinding, artifacts.criticalEtherfiUnknownDefaultIdentityBindingManifest, artifacts.criticalEtherfiSafeAssetRecoveryInvariant, artifacts.criticalEtherfiSafeAssetRecoveryInvariantManifest, artifacts.criticalEtherfiBehypeFeeRefundDeliveryInvariant, artifacts.criticalEtherfiBehypeFeeRefundDeliveryInvariantManifest, artifacts.criticalEtherfiBehypeStakerLayerzeroBinding, artifacts.criticalEtherfiBehypeStakerLayerzeroBindingManifest, artifacts.criticalEtherfiBehypeEndpointCoverageRepair, artifacts.criticalEtherfiBehypeEndpointCoverageRepairManifest, artifacts.criticalEtherfiBehypeSelectedLibraryBinding, artifacts.criticalEtherfiBehypeSelectedLibraryBindingManifest, artifacts.criticalEtherfiBehypeReceiveType1NegativeCheck, artifacts.criticalEtherfiBehypeReceiveType1NegativeCheckManifest, artifacts.criticalEtherfiBehypeHyperevmDiagnosticR10R2, artifacts.criticalEtherfiBehypeHyperevmDiagnosticR10R2Manifest, artifacts.criticalEtherfiHyperevmStateCanaryR14R3, artifacts.criticalEtherfiHyperevmStateCanaryR14R3Manifest, artifacts.criticalEtherfiHyperevmBehavioralCaptureR2, artifacts.criticalEtherfiHyperevmBehavioralCaptureR2Manifest, artifacts.criticalEtherfiHyperevmBehavioralRetryCaptureR8, artifacts.criticalEtherfiHyperevmBehavioralRetryCaptureR8Manifest) : null,
    ...GENERIC_SURFACES.map((cfg) => artifacts[cfg.key]?.generatedAt ? genericSummaryCandidate(artifacts[cfg.key], cfg) : null),
  ].filter(Boolean).sort((a, b) => (b.routePositive - a.routePositive) || (b.priorityScore - a.priorityScore));

  const avalon = candidates.find((row) => row.id === "avalon-usda-cdp-sweep");
  if (avalon) {
    const deepSummary = artifacts.avalonUsdaDeep?.summary || {};
    avalon.status = "avalon-usda-final-closeout-no-route-positive";
    avalon.sourceArtifacts = [
      "reports/raw/fast/avalon-usda-live.json",
      "reports/raw/fast/avalon-usda-deep-probe.json",
      "reports/raw/fast/avalon-usda-abi-classification.json",
      "reports/raw/fast/avalon-usda-classified-selector-probe.json",
      "reports/raw/fast/avalon-usda-heimdall-resolved/decompile/decompiled.sol",
    ];
    avalon.distance.avalonDeepProbe = {
      generatedAt: artifacts.avalonUsdaDeep?.generatedAt || null,
      selectorsProbed: asNumber(deepSummary.selectorsProbed) || 0,
      selectorOk: asNumber(deepSummary.selectorOk) || 0,
      selectorReverts: asNumber(deepSummary.selectorReverts) || 0,
      oracleCandidatesProbed: asNumber(deepSummary.oracleCandidatesProbed) || 0,
      oracleCandidatesOk: asNumber(deepSummary.oracleCandidatesOk) || 0,
      implementationOracleMatches: asNumber(deepSummary.implementationOracleMatches) || 0,
    };
    avalon.blockers = [
      "Implementation remains unverified/opaque despite ABI/pseudocode and deep selector probes",
      "Deep probe found zero implementation oracle literal matches among probed candidates",
      "Money-path selectors revert for probe caller or are view-only; liquidation/config paths remain access-controlled or reverting",
      "No exact-positive borrow/redeem/liquidation economics and no fork value-delta proof",
    ];
    avalon.requiredForRoutePositive = [
      "verified source or decompiled semantics for oracle/risk/liquidation paths",
      "public money path reaches past account/pool guards for attacker-controlled state",
      "CDP allows exact-positive borrow/redeem/liquidation economics after gas/slippage/fees",
      "local fork extraction/value-delta proof before any executor or signed action",
    ];
    avalon.nextReadOnlyStep = "Avalon is fully closed for now; reopen only if verified source, decompiled oracle semantics, or real user-state probes reveal a permissionless exact-positive money path.";
  }

  const aster = candidates.find((row) => row.id === "aster-bridge-route-prefilter-sweep");
  const asterArtifact = artifacts.criticalAsterBnbTreasuryControl;
  if (aster && asterArtifact?.generatedAt) {
    const pin = asterArtifact.pin || {};
    const terminal = asterArtifact.terminalPinConsistency || {};
    const implementation = asterArtifact.implementation || {};
    aster.status = "aster-bnb-treasury-control-watch-source-unproven-update-hourly-limit-untested";
    aster.sourceArtifacts = [
      "reports/raw/fast/prefilter-aster-bridge-route-prefilter.json",
      "reports/raw/fast/critical-aster-bnb-treasury-control.json",
      "reports/raw/fast/critical-aster-bnb-treasury-control-manifest.json",
      "reports/critical-aster-bnb-treasury-control.md",
    ];
    aster.distance.asterBnbTreasuryControl = {
      generatedAt: asterArtifact.generatedAt,
      runId: asterArtifact.runId,
      revision: asterArtifact.revision,
      blockNumber: pin.blockNumberDecimal,
      blockHash: pin.blockHash,
      terminalHashRecheck: terminal.consistent === true,
      implementationAddress: implementation.address,
      recordedHypothesis: implementation.recordedHypothesis,
      recordedHypothesisMatch: implementation.recordedHypothesisMatch,
      sourceRuntimeEquivalence: asterArtifact.sourceRuntimeEquivalence,
      localExactBuildEquivalence: asterArtifact.localExactBuildEquivalence,
      localBuildAttempted: asterArtifact.localBuildAttempted,
      updateHourlyLimit: asterArtifact.updateHourlyLimit,
      finalTranscriptReadCountExact: asterArtifact.networkRunProvenance?.finalTranscriptReadCountExact,
      taskTotalExact: asterArtifact.networkRunProvenance?.taskTotalExact,
    };
    aster.blockers = [
      "Source/runtime equivalence is UNPROVEN_NO_STANDARD_JSON; explorer verification is an assertion, not a local recompilation",
      "updateHourlyLimit(uint256) remains untested and requires a separate minimal new-pin run with immutable pre-run runner hash",
      "Network runner source was not retained; final transcript is exactly 84 reads but task total is reconstructed 168 (taskTotalExact=false)",
      "Recorded implementation hypothesis drifted; fixed EIP-1967 slot resolves to 0xc01AEFDaa49416FC8f68c6513EC5E6131D45c019, not the hypothesized address",
      "17/18 outsider mutation/control probes reverted or were benign self-renounce; no permissionless control acquisition or direct-release success",
      "Substantial treasury balances are observed but no permissionless value motion is proven",
      "No fork extraction proof or exact positive route economics",
    ];
    aster.requiredForRoutePositive = [
      "Recovered standard-json compiler input and exact source/runtime equivalence equal to true",
      "Separate minimal new-pin run binds proxy/implementation, no-code caller, calls updateHourlyLimit(1) exactly once, and terminally rechecks the pin",
      "A permissionless path moves material treasury value without role/authorization compromise",
      "Exact route economics positive after gas, slippage, fees, and exit liquidity",
      "Fork/static proof before any live or signed action",
    ];
    aster.nextReadOnlyStep = "Rotate to another bounded permissionless exploit-class branch. Do not rerun the full Aster scanner in this revision; revisit Aster only on implementation drift, recovered source availability, or explicit closeout need.";
  }

  const ccip = candidates.find((row) => row.id === "ccip-phase0-sweep");
  const ccipArtifact = artifacts.criticalCcipSyrupusdtReleaseAuth;
  if (ccip && ccipArtifact?.generatedAt) {
    const pin = ccipArtifact.pin || {};
    const offline = ccipArtifact.offlineRevision || {};
    const compiler = offline.compilerSettings || {};
    ccip.status = "ccip-syrupusdt-release-auth-subbranch-clean-overall-incomplete-watch";
    ccip.sourceArtifacts = [
      "reports/raw/fast/ccip-phase0.json",
      "reports/raw/fast/critical-ccip-syrupusdt-release-auth.json",
      "reports/raw/fast/critical-ccip-syrupusdt-release-auth-offline-build.json",
      "reports/raw/fast/critical-ccip-syrupusdt-release-auth-manifest.json",
      "reports/critical-ccip-syrupusdt-release-auth.md",
    ];
    ccip.distance.ccipSyrupusdtReleaseAuth = {
      generatedAt: ccipArtifact.generatedAt,
      runId: ccipArtifact.runId,
      revision: ccipArtifact.revision,
      blockNumber: pin.blockNumberDecimal,
      blockHash: pin.blockHash,
      terminalHashRecheck: pin.terminalSameHash === true,
      chainConfigured: ccipArtifact.chain?.configuredChainId,
      chainTranscriptBound: ccipArtifact.chain?.chainIdTranscriptBound,
      poolTypeAndVersion: ccipArtifact.pool?.getters?.typeAndVersion?.decoded,
      poolRuntimeBytes: ccipArtifact.pool?.runtime?.bytes,
      poolRuntimeHash: ccipArtifact.pool?.runtime?.keccak256,
      tokenMatch: ccipArtifact.pool?.tokenMatch,
      localExactBuildEquivalence: ccipArtifact.localExactBuildEquivalence,
      callOrderExact: ccipArtifact.callOrderExact,
      sourceRuntimeEquivalence: ccipArtifact.sourceRuntimeEquivalence,
      packageVersion: offline.packageVersion,
      compilerVersion: offline.compilerVersion,
      optimizerRuns: compiler.optimizer?.runs,
      viaIR: compiler.viaIR,
      bytecodeHash: compiler.metadata?.bytecodeHash,
      exactRuntimeBytes: offline.exactRuntimeBytes,
      exactRuntimeHash: offline.exactRuntimeKeccak256,
      sourceClosureFileCount: offline.sourceClosureFileCount,
      immutableAstIds: offline.immutableAstIds,
      immutableReferenceCount: offline.immutableReferenceCount,
      deterministicRepeat: offline.deterministicRepeat,
      outsiderRevert: ccipArtifact.outsider?.revertDecoded,
      overallCcipClassification: ccipArtifact.overallCcipClassification,
    };
  }

  const ccipBackingArtifact = artifacts.criticalCcipSyrupusdtBackingConservation;
  const ccipBackingWorksheet = artifacts.criticalCcipSyrupusdtBackingConservationWorksheet;
  const ccipBackingManifest = artifacts.criticalCcipSyrupusdtBackingConservationManifest;
  if (ccip && ccipBackingArtifact?.generatedAt && ccipBackingWorksheet?.ethereumCustody) {
    const backingWorksheet = ccipBackingWorksheet;
    ccip.status = "ccip-syrupusdt-release-auth-clean-backing-incomplete-watch";
    ccip.sourceArtifacts = [
      "reports/raw/fast/ccip-phase0.json",
      "reports/raw/fast/critical-ccip-syrupusdt-release-auth.json",
      "reports/raw/fast/critical-ccip-syrupusdt-release-auth-offline-build.json",
      "reports/raw/fast/critical-ccip-syrupusdt-release-auth-manifest.json",
      "reports/critical-ccip-syrupusdt-release-auth.md",
      "reports/raw/fast/critical-ccip-syrupusdt-backing-conservation.json",
      "reports/raw/fast/critical-ccip-syrupusdt-backing-conservation-worksheet.json",
      "reports/raw/fast/critical-ccip-syrupusdt-backing-conservation-manifest.json",
      "reports/critical-ccip-syrupusdt-backing-conservation.md",
    ];
    ccip.distance.ccipSyrupusdtBackingConservation = {
      generatedAt: ccipBackingArtifact.generatedAt,
      runId: ccipBackingArtifact.runId,
      revision: ccipBackingArtifact.revision,
      classification: ccipBackingArtifact.classification,
      signal: ccipBackingArtifact.signal,
      custodyRaw: backingWorksheet.ethereumCustody.raw,
      custodyExact: backingWorksheet.ethereumCustody.exact,
      attributableLiabilityNormalized: backingWorksheet.totals.attributableLiabilityNormalized,
      unknownKnownAmountNormalized: backingWorksheet.totals.unknownKnownAmountNormalized,
      unquantifiedUnknownRouteCount: backingWorksheet.totals.unquantifiedUnknownRouteCount,
      chainCoverage: ccipBackingArtifact.chainCoverage,
      routeCoverage: ccipBackingArtifact.routeCoverage,
      counterpartChainsPinned: ccipBackingArtifact.routeCoverage?.counterpartChainsPinned,
      counterpartRoutesStateCovered: ccipBackingArtifact.routeCoverage?.counterpartRoutesStateCovered,
      topologyCompleteRoutes: ccipBackingArtifact.routeCoverage?.topologyCompleteRoutes,
      successorPassFailGateStatus: ccipBackingArtifact.successorPassFailGate?.status,
      successorPassFailGatePass: ccipBackingArtifact.successorPassFailGate?.pass,
      accountingStateTimestampSpreadSeconds: ccipBackingArtifact.successorPassFailGate?.accountingStateTimestampSpreadSeconds,
      runnerSha256: ccipBackingArtifact.runner?.sha256,
      captureSha256: ccipBackingArtifact.captureProvenance?.sha256,
      priorAuthorizationManifestAggregateSha256: ccipBackingArtifact.priorAuthorizationBinding?.manifestAggregateSha256,
      backingManifestAggregateSha256: ccipBackingManifest?.aggregateSha256,
      requestCounts: ccipBackingArtifact.requestCounts,
    };
    ccip.blockers = [
      "Authorization subbranch CLEAN: outsider releaseOrMint eth_call reverts with CallerIsNotARampOnRouter(dead) for supported uncursed selector 1556008542357238666; isOffRamp=false",
      "Local exact build is true: CCIP 1.5.1-beta.2, solc 0.8.26, optimizer 1,000,000, viaIR, bytecodeHash none, 19,030 runtime bytes, exact runtime hash matches, deterministic repeat true",
      "Call order exact: off-ramp authorization (router.isOffRamp) precedes source-pool validation, rate-limit, and transfer",
      "External verified-source/Sourcify provenance remains null; conclusion relies on hash-bound local package closure, not external attestation",
      "Backing conservation subbranch INCOMPLETE/WATCH/MODEL_NOT_ESTABLISHED: global backing/liability model not established",
      "Ethereum custody exact 281839554875315 raw (6 decimals); attributable liability proven subset is 0; BNB totalSupply context 2771830779781 raw excluded because authority interface/provenance unestablished",
      "Mantle fixed-pin state calls unavailable (HTTP 403); reciprocal topology, identity, supply, authority, and runtime presence are not established",
      "Plasma/Ink fixed-pin chainId unavailable; no state, topology, or authority data retained",
      "BNB Chain minter/burner authority interface reverted; enumeration and historical mint/migration/alternate-bridge provenance not established",
      "Successor PASS/FAIL accounting gate NOT_MET: pin spread 777 seconds; no synchronized/as-of accounting or explicit CCIP in-flight reconciliation retained",
      "No solvency or deficit claim asserted; no fork extraction proof or exact positive route economics",
    ];
    ccip.requiredForRoutePositive = [
      "Authorization subbranch remains closed or reopened only on pool/router/RMN/runtime drift or contradictory evidence",
      "Complete fixed-pin topology/source for all 4 EVM selectors with authoritative mint/migration/alternate-bridge attribution",
      "Synchronized/as-of accounting or explicit CCIP in-flight reconciliation across all counterpart chains",
      "Exhaustive router/off-ramp/RMN configuration and upgrade-authority review proves a permissionless flaw",
      "Cross-chain message/proof/domain/nonce conservation review across every supported selector and remote pool proves a bypass",
      "Global LockRelease backing/liability reconciliation across remote representations proves extractable mismatch",
      "Privileged owner/rebalancer/rate-limit/admin/governance control assessment proves a permissionless impact path",
      "Exact route economics positive after gas, slippage, fees, and exit liquidity; fork/static proof before any live or signed action",
    ];
    ccip.nextReadOnlyStep = "STOP/ROTATE. Authorization subbranch is clean; backing conservation subbranch is INCOMPLETE/WATCH/MODEL_NOT_ESTABLISHED. Do not assert solvency or deficit. Preserve prior CCIP authorization CLEAN subbranch and Concrete quarantine. Reopen CCIP only on pool/router/RMN/runtime drift, contradictory evidence, or when fixed-pin state/source coverage, authoritative authority, and historical mint/migration/alternate-bridge attribution plus synchronized/as-of accounting or explicit CCIP in-flight reconciliation are available.";
  }

  const ranked = candidates.map((candidate, idx) => ({ rank: idx + 1, ...candidate }));
  const routePositive = ranked.reduce((acc, row) => acc + (asNumber(row.routePositive) || 0), 0);
  const authorization = authorizationRow();
  const out = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-route-positive-sweep.js",
    scope: "Read-only route-positive distance sweep across decoded dormant surfaces",
    authorizationState: authorization.authorizationState,
    safety: {
      rpcInventoryRead: false,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: routePositive > 0,
      signedActionJustified: false,
    },
    gates: {
      forkOnlyAfter: [
        "source artifact routePositive > 0",
        "live exact route economics positive after gas and slippage",
        "fork extraction proof",
      ],
      signedActionRequires: [
        "explicit authorization",
        "fresh staticCall and estimateGas",
        "deployed bytecode/artifact verification",
        "minProfit/minOut gates",
      ],
    },
    sourceArtifacts: Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, path.relative(WORKSPACE, file)])),
    summary: {
      artifactsAvailable: Object.values(artifacts).filter((artifact) => artifact?.generatedAt).length,
      candidatesRanked: ranked.length,
      routePositive,
      executableNow: false,
      executableNowCount: 0,
      signedActionJustified: false,
      authorizationState: authorization.authorizationState,
      hardStop: false,
      topCandidate: ranked[0]?.id || null,
      topStatus: ranked[0]?.status || null,
      topPriorityScore: ranked[0]?.priorityScore || null,
      nextBranch: ranked[0]?.nextReadOnlyStep || null,
    },
    ranked,
  };

  const canonical = canonicalizeExecutableFields(out);
  if (canonical.hardStop === true) {
    canonical.summary.hardStop = true;
    if (canonical.observedUpstreamAuthorizationSignal === true) {
      canonical.summary.observedUpstreamAuthorizationSignal = true;
    }
    if (canonical.invalidUpstreamAuthorizationSignal === true) {
      canonical.summary.invalidUpstreamAuthorizationSignal = true;
    }
  }
  return canonical;
}

function main() {
  const out = buildArtifact();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);

  if (!QUIET) {
    console.log(`Wrote ${path.relative(WORKSPACE, OUT)}`);
    console.log(`Ranked ${out.ranked.length} route surfaces; routePositive=${out.summary.routePositive}; executableNow=false; signedActionJustified=false`);
    for (const row of out.ranked.slice(0, 8)) {
      console.log(`#${row.rank} ${row.id} score=${row.priorityScore} status=${row.status} routePositive=${row.routePositive}`);
    }
  }
}

if (require.main === module) main();

module.exports = { buildArtifact };
