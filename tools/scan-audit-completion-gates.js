#!/usr/bin/env node
// scan-audit-completion-gates.js - read-only project completion gate summary.
// Does not read RPC inventory, secrets, env files, or live endpoints.

const fs = require("fs");
const path = require("path");
const { authorizationSafetySignals, forceMonitorOnlyArtifact, rememberAuthorizationSnapshot } = require("./monitor-minimal-env");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "audit-completion-gates.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "audit-completion-gates.md");
const ROUTE_SWEEP = path.join(WORKSPACE, "reports", "raw", "fast", "route-positive-sweep.json");
const PROXIMITY = path.join(WORKSPACE, "reports", "raw", "fast", "evaluator-proximity.json");
const REPORTS_DIR = path.join(WORKSPACE, "reports");
const QUIET = process.argv.includes("--quiet");

const TOP_BRANCH_COUNT = Number(process.env.AUDIT_COMPLETION_TOP_BRANCHES || "12");
const META_FRESH_HOURS = Number(process.env.AUDIT_COMPLETION_META_FRESH_HOURS || "24");
const TOP_BRANCH_FRESH_HOURS = Number(process.env.AUDIT_COMPLETION_TOP_BRANCH_FRESH_HOURS || "72");
const REQUIRED_BRANCH_IDS = unique((process.env.AUDIT_COMPLETION_REQUIRED_BRANCH_IDS || [
  "summer-fi-pro-route-prefilter-sweep",
  "summer-fi-pro-full-test-sweep",
  "summer-fi-pro-fork-route-test-sweep",
  "b2-buzz-route-prefilter-sweep",
  "b2-buzz-full-test-sweep",
  "b2-buzz-fork-route-test-sweep",
  "etherfuse-route-prefilter-sweep",
  "etherfuse-full-test-sweep",
  "etherfuse-fork-route-test-sweep",
  "polymarket-adapter-full-balance-gate-sweep",
  "kamino-reduced-status-liquidation-recertification-sweep",
  "lorenzo-susd1plus-step6-accounting-sweep",
  "critical-lombard-ratio-domain-step7-sweep",
  "synapse-cctp-step8-r2-sweep",
  "babylon-late-quorum-production-exposure-r3-sweep",
  "babylon-pre-retention-source-readiness-r3-sweep",
  "babylon-mintscan-pre-retention-enumerator-sweep",
  "critical-unit-proxy-control-sweep",
  "critical-etherfi-default-module-capability-sweep",
].join(",")).split(",").map((id) => id.trim()).filter(Boolean));

const SIGNALS = {
  CONFIRMED: "\uD83D\uDD34 CONFIRMED",
  VULNERABLE: "\uD83D\uDFE1 VULNERABLE",
  WATCH: "\uD83D\uDFE0 WATCH",
  DORMANT: "\uD83D\uDFE2 DORMANT",
  CLEAN: "\u26AA CLEAN",
};

const REPORT_BY_ROUTE_ID = {
  "aave-v3-route-distance-sweep": ["reports/aave-v3-route-distance-triage.md", "reports/aave-v3-trigger-readiness-triage.md"],
  "aave-v3-emode-escalation-sweep": ["reports/aave-v3-emode-escalation-triage.md"],
  "aave-v4-near-liquidation-sweep": ["reports/aave-v4-hubs-triage.md"],
  "hyperlend-stale-source-sweep": ["reports/hyperlend-triage.md"],
  "socket-branch-enrichment-sweep": ["reports/aave-v4-hubs-triage.md", "reports/morpho-high-apy-liquidation-routes-triage.md", "reports/hyperlend-triage.md"],
  "morpho-high-apy-liquidation-sweep": ["reports/morpho-high-apy-liquidation-routes-triage.md"],
  "morpho-liquidatable-marketability-sweep": ["reports/morpho-liquidatable-marketability-triage.md"],
  "morpho-wrapper-exit-proof-gap-sweep": ["reports/morpho-wrapper-exit-proof-gaps-triage.md"],
  "current-liquidatable-exit-route-sweep": ["reports/current-liquidatable-exit-routes-triage.md"],
  "morpho-yeth-alternate-exit-sweep": ["reports/morpho-yeth-alternate-exits-triage.md"],
  "morpho-pyth-unsafe-consumer-sweep": ["reports/morpho-pyth-unsafe-consumers-triage.md", "reports/morpho-pyth-watch-row-preflight.md"],
  "lorenzo-susd1plus-premium-sweep": ["reports/lorenzo-susd1plus-triage.md"],
  "lorenzo-susd1plus-route-refresh-sweep": ["reports/prefilter-lorenzo-susd1plus-route-refresh.md"],
  "lorenzo-susd1plus-step6-accounting-sweep": ["reports/lorenzo-susd1plus-step6-accounting.md"],
  "critical-lombard-ratio-domain-step7-sweep": ["reports/critical-lombard-ratio-domain-step7.md"],
  "venus-base-wsteth-sweep": ["reports/venus-base-triage.md"],
  "venus-core-pool-phase0-sweep": ["reports/venus-core-pool-phase0-triage.md"],
  "e12x-morpho-new-market-sweep": ["reports/morpho-new-market-exploit-triage.md"],
  "hyperliquid-linked-consumer-sweep": ["reports/hyperliquid-linked-token-consumers-triage.md", "reports/hyperliquid-linked-token-invariants-triage.md"],
  "hyperliquid-core-dex-depth-sweep": ["reports/hyperliquid-core-dex-depth-routes-triage.md"],
  "steamm-zero-offset-marketability-sweep": ["reports/suilend-suite-triage.md"],
  "hyperevm-lst-lrt-oracle-sweep": ["reports/hyperevm-lst-lrt-oracle-routes-triage.md"],
  "pt-oracle-unit-mismatch-sweep": ["reports/pt-oracle-unit-mismatch-triage.md"],
  "validation-differential-liquidation-sweep": ["reports/validation-differential-liquidations-triage.md"],
  "consumer-first-high-ltv-collateral-sweep": ["reports/consumer-first-high-ltv-collateral-triage.md"],
  "post-audit-new-market-drift-sweep": ["reports/post-audit-new-market-drift-triage.md"],
  "small-cap-oracle-manipulation-sweep": ["reports/small-cap-oracle-manipulation-routes-triage.md"],
  "market-launch-choreography-sweep": ["reports/market-launch-choreography-routes-triage.md"],
  "factory-launch-donation-watch-sweep": ["reports/factory-launch-donation-watch-triage.md"],
  "governance-listing-watch-sweep": ["reports/governance-listing-watch-triage.md"],
  "governance-timelock-payload-sweep": ["reports/governance-timelock-payloads-triage.md"],
  "governance-attack-surface-sweep": ["reports/governance-attack-surface-triage.md"],
  "seven-chain-lending-coverage-sweep": ["reports/seven-chain-lending-coverage-triage.md"],
  "blast-native-yield-lending-sweep": ["reports/blast-native-yield-lending-triage.md"],
  "nft-lending-oracle-route-sweep": ["reports/nft-lending-oracle-routes-triage.md"],
  "kamino-oracle-config-sweep": ["reports/kamino-oracle-borrow-liquidation-triage.md"],
  "kamino-liquidation-profitability-sweep": ["reports/kamino-oracle-borrow-liquidation-triage.md"],
  "kamino-live-window-ranker-sweep": ["reports/kamino-oracle-borrow-liquidation-triage.md"],
  "kamino-reduced-status-liquidation-recertification-sweep": ["reports/kamino-reduced-status-liquidation-recertification.md"],
  "synapse-cctp-step8-r2-sweep": ["reports/synapse-cctp-step8.md"],
  "babylon-late-quorum-production-exposure-r3-sweep": ["reports/babylon-late-quorum-production-exposure.md"],
  "babylon-pre-retention-source-readiness-r3-sweep": ["reports/babylon-pre-retention-source-readiness.md"],
  "babylon-mintscan-pre-retention-enumerator-sweep": ["reports/babylon-mintscan-pre-retention-enumerator.md"],
  "critical-unit-proxy-control-sweep": ["reports/critical-unit-proxy-control.md"],
  "critical-etherfi-default-module-capability-sweep": ["reports/critical-etherfi-default-module-capability.md", "reports/critical-etherfi-pinbound-build-binding.md", "reports/critical-etherfi-pending-withdrawal-tuple.md", "reports/critical-etherfi-stargate-valid-auth-tuple-invariant.md", "reports/critical-etherfi-stargate-asset-config-drift.md", "reports/critical-etherfi-unknown-default-identity-binding.md", "reports/critical-etherfi-safe-asset-recovery-invariant.md", "reports/critical-etherfi-behype-fee-refund-delivery-invariant.md", "reports/critical-etherfi-behype-staker-layerzero-binding.md", "reports/critical-etherfi-behype-endpoint-coverage-repair.md", "reports/critical-etherfi-behype-selected-library-binding.md", "reports/critical-etherfi-behype-receive-type1-negative-check.md", "reports/critical-etherfi-behype-hyperevm-diagnostic-r10-r2.md", "reports/critical-etherfi-hyperevm-state-canary-r14-r3.md", "reports/critical-etherfi-behype-hyperevm-behavioral-requalification-capture-r2.md", "reports/critical-etherfi-behype-hyperevm-behavioral-retry-capture-r8.md"],
  "solana-receipt-token-consumer-graph-sweep": ["reports/solana-receipt-token-consumer-graph-triage.md"],
  "layerzero-oft-dvn-consumer-join-sweep": ["reports/layerzero-oft-dvn-consumer-joins-triage.md"],
  "hyperliquid-perps-meta-sweep": ["reports/hyperliquid-perps-funding-triage.md"],
  "hyperliquid-perps-spot-divergence-sweep": ["reports/hyperliquid-perps-funding-triage.md"],
  "hyperliquid-funding-arb-sweep": ["reports/hyperliquid-perps-funding-triage.md"],
  "eigenlayer-lrt-nav-dex-sweep": ["reports/eigenlayer-phase1-triage.md"],
  "eigenlayer-slashing-rehypothecation-sweep": ["reports/eigenlayer-phase1-triage.md"],
  "cooler-loans-sweep": ["reports/cooler-loans-triage.md"],
  "venus-bsc-legacy-sweep": ["reports/venus-deep-triage.md"],
  "venus-multichain-iso-sweep": ["reports/venus-deep-triage.md"],
  "lista-oracle-deep-sweep": ["reports/lista-oracle-deep-triage.md"],
  "ajna-v2-architecture-sweep": ["reports/ajna-v2-triage.md"],
  "bucket-cdp-sweep": ["reports/bucket-cdp-triage.md"],
  "homora-v2-sweep": ["reports/homora-v2-triage.md"],
  "oracle-protocol-discovery-sweep": ["reports/oracle-protocol-discovery-triage.md"],
  "compound-v2-sweep": ["reports/compound-v2-triage.md"],
  "intent-solver-frontier-sweep": ["reports/intent-solver-frontier-triage.md"],
  "dex-frontier-sweep": ["reports/dex-frontier-triage.md"],
  "reservoir-deep-sweep": ["reports/reservoir-deep-triage.md"],
  "defillama-rescan-top10-sweep": ["reports/defillama-rescan-top10-triage.md"],
  "meteora-dlmm-phase2-sweep": ["reports/meteora-dlmm-phase2-triage.md"],
  "avalon-usda-deep-sweep": ["reports/avalon-usda-deep-triage.md"],
  "radiant-capital-sweep": ["reports/radiant-capital-triage.md"],
  "seamless-abracadabra-sweep": ["reports/seamless-abracadabra-quick-triage.md"],
  "spark-crosschain-sweep": ["reports/spark-crosschain-triage.md"],
  "lido-withdrawal-queue-sweep": ["reports/lido-phase1-triage.md"],
  "lido-oracle-staleness-sweep": ["reports/lido-phase1-triage.md"],
  "marginfi-scan-sweep": ["reports/marginfi-scan-triage.md"],
  "marginfi-health-recompute-sweep": ["reports/marginfi-scan-triage.md"],
  "fluid-vault-deepdive-sweep": ["reports/marginfi-scan-triage.md"],
  "marginfi-metadata-sweep": ["reports/marginfi-scan-triage.md"],
  "uniswap-v3-quoter-sweep": ["reports/uniswap-v3-quoter-triage.md"],
  "stablecoin-depeg-lending-sweep": ["reports/stablecoin-depeg-lending-routes-triage.md"],
  "lrt-oracle-drift-inventory-sweep": ["reports/lrt-oracle-drift-routes-triage.md"],
  "morpho-flashloan-token-overlap-sweep": ["reports/morpho-flashloan-token-overlap-triage.md"],
  "evault-collateral-nav-manipulation-sweep": ["reports/evault-collateral-nav-manipulation-triage.md"],
  "focused-euler-evk-review-sweep": ["reports/focused-euler-evk-review-producers-triage.md"],
  "two-market-leverage-loop-sweep": ["reports/two-market-leverage-loops-triage.md"],
  "morpho-public-allocator-force-feed-sweep": ["reports/morpho-public-allocator-force-feed-triage.md"],
  "focused-morpho-review-sweep": ["reports/focused-morpho-review-producers-triage.md"],
  "jupiter-lend-oracle-divergence-sweep": ["reports/jupiter-lend-oracle-divergence-triage.md"],
  "jupiter-xstock-multiplier-impact-sweep": ["reports/jupiter-xstock-multiplier-impact-triage.md"],
  "deprecated-orphaned-reachability-sweep": ["reports/deprecated-orphaned-reachability-triage.md"],
  "dex-hook-callback-abuse-sweep": ["reports/dex-hook-callback-abuse-triage.md"],
  "perps-lending-composability-sweep": ["reports/perps-lending-composability-triage.md"],
  "insurance-fund-drain-v2-sweep": ["reports/insurance-fund-drain-v2-triage.md"],
  "fee-on-transfer-rebase-sweep": ["reports/fee-on-transfer-rebase-triage.md"],
  "router-rfq-settlement-drift-sweep": ["reports/router-rfq-settlement-drift-triage.md"],
  "bridge-proof-binding-sweep": ["reports/bridge-proof-binding-triage.md"],
  "fake-asset-pool-validation-sweep": ["reports/fake-asset-pool-validation-triage.md"],
  "pool-share-snapshot-drift-sweep": ["reports/pool-share-snapshot-drift-triage.md"],
  "strategy-migration-rebalance-sweep": ["reports/strategy-migration-rebalance-triage.md"],
  "prediction-market-live-route-sweep": ["reports/prediction-market-live-routes-triage.md", "reports/polymarket-ctf-exchange-v2-triage.md"],
  "polymarket-adapter-full-balance-gate-sweep": ["reports/polymarket-adapter-full-balance-gate.md"],
  "cross-chain-oracle-drift-sweep": ["reports/cross-chain-oracle-drift-triage.md"],
  "cross-chain-settlement-quote-sweep": ["reports/cross-chain-settlement-quotes-triage.md"],
  "intent-solver-settlement-abuse-sweep": ["reports/intent-solver-settlement-abuse-triage.md"],
  "mev-sandwich-order-economics-sweep": ["reports/mev-sandwich-order-economics-triage.md"],
  "recent-contracts-old-money-probe-sweep": ["reports/recent-contracts-old-money-probes.md"],
  "post-audit-scope-drift-sweep": ["reports/post-audit-scope-drift-triage.md"],
  "post-audit-deployed-map-sweep": ["reports/post-audit-deployed-map-triage.md"],
  "deployed-path-proof-gap-sweep": ["reports/deployed-path-proof-gaps-triage.md"],
  "bridge-nonlossless-collateral-join-sweep": ["reports/bridge-nonlossless-collateral-join-triage.md"],
  "bridge-delta-preflight-sweep": ["reports/bridge-delta-preflight-triage.md"],
  "bridge-synthetic-consumer-exposure-sweep": ["reports/bridge-synthetic-consumer-exposure-triage.md"],
  "bridge-lending-collateral-join-sweep": ["reports/bridge-lending-collateral-join-triage.md"],
  "sui-lending-config-sweep": ["reports/sui-lending-config-triage.md"],
  "blackrock-buidl-phase0-sweep": ["reports/blackrock-buidl-phase0-triage.md"],
  "paxos-gold-phase0-sweep": ["reports/paxos-gold-phase0-triage.md"],
  "re-phase0-sweep": ["reports/re-phase0-triage.md"],
  "centrifuge-nav-consumer-graph-sweep": ["reports/centrifuge-nav-consumer-graph-triage.md"],
  "anemoy-capital-phase0-sweep": ["reports/anemoy-capital-phase0-triage.md"],
  "bifi-phase0-sweep": ["reports/bifi-phase0-triage.md"],
  "tether-gold-phase0-sweep": ["reports/tether-gold-phase0-triage.md"],
  "usd-ai-phase0-sweep": ["reports/usd-ai-phase0-triage.md"],
  "circle-usyc-phase0-sweep": ["reports/circle-usyc-phase0-triage.md"],
  "midas-rwa-phase0-sweep": ["reports/midas-rwa-phase0-triage.md"],
  "spiko-phase0-sweep": ["reports/spiko-phase0-triage.md"],
  "40acres-phase0-sweep": ["reports/40acres-phase0-triage.md"],
  "native-credit-pool-phase0-sweep": ["reports/native-credit-pool-phase0-triage.md"],
  "matrixdock-stbt-phase0-sweep": ["reports/matrixdock-stbt-phase0-triage.md"],
  "arbitrum-bridge-phase0-sweep": ["reports/arbitrum-bridge-phase0-triage.md"],
  "polygon-zkevm-bridge-phase0-sweep": ["reports/polygon-zkevm-bridge-phase0-triage.md"],
  "cronos-zkevm-bridge-phase0-sweep": ["reports/cronos-zkevm-bridge-phase0-triage.md"],
  "flying-tulip-lend-phase0-sweep": ["reports/flying-tulip-lend-phase0-triage.md"],
  "capyfi-phase0-sweep": ["reports/capyfi-phase0-triage.md"],
  "flux-finance-phase0-sweep": ["reports/flux-finance-phase0-triage.md"],
  "ethena-usdtb-phase0-sweep": ["reports/ethena-usdtb-phase0-triage.md"],
  "opentrade-phase0-sweep": ["reports/opentrade-phase0-triage.md"],
  "wisdomtree-phase0-sweep": ["reports/wisdomtree-phase0-triage.md"],
  "resupply-phase0-sweep": ["reports/resupply-phase0-triage.md"],
  "fira-phase0-sweep": ["reports/fira-phase0-triage.md"],
  "republic-note-phase0-sweep": ["reports/republic-note-phase0-triage.md"],
  "kasu-phase0-sweep": ["reports/kasu-phase0-triage.md"],
  "hastra-phase0-sweep": ["reports/hastra-phase0-triage.md"],
  "templar-protocol-phase0-sweep": ["reports/templar-protocol-phase0-triage.md"],
  "fluid-lending-phase0-sweep": ["reports/fluid-lending-phase0-triage.md"],
  "benqi-lending-phase0-sweep": ["reports/benqi-lending-phase0-triage.md"],
  "crvusd-phase0-sweep": ["reports/crvusd-phase0-triage.md"],
  "curve-llamalend-phase0-sweep": ["reports/curve-llamalend-phase0-triage.md"],
  "venus-flux-phase0-sweep": ["reports/venus-flux-phase0-triage.md"],
  "bend-phase0-sweep": ["reports/bend-phase0-triage.md"],
  "saturn-susdat-phase0-sweep": ["reports/saturn-susdat-phase0-triage.md"],
  "portal-phase0-sweep": ["reports/portal-phase0-triage.md"],
  "optimism-bridge-phase0-sweep": ["reports/optimism-bridge-phase0-triage.md"],
  "base-bridge-phase0-sweep": ["reports/base-bridge-phase0-triage.md"],
  "bitu-protocol-phase0-sweep": ["reports/bitu-protocol-phase0-triage.md"],
  "inverse-finance-firm-phase0-sweep": ["reports/inverse-finance-firm-phase0-triage.md"],
  "csigma-finance-phase0-sweep": ["reports/csigma-finance-phase0-triage.md"],
  "gravity-by-galxe-phase0-sweep": ["reports/gravity-by-galxe-phase0-triage.md"],
  "alpaca-finance-2-phase0-sweep": ["reports/alpaca-finance-2-phase0-triage.md"],
  "digift-rwa-route-prefilter-sweep": ["reports/prefilter-digift-rwa-route-prefilter.md"],
  "gaib-rwa-route-prefilter-sweep": ["reports/prefilter-gaib-rwa-route-prefilter.md"],
  "ember-protocol-route-prefilter-sweep": ["reports/prefilter-ember-protocol-route-prefilter.md"],
  "mainstreet-route-prefilter-sweep": ["reports/prefilter-mainstreet-route-prefilter.md"],
  "overnight-finance-route-prefilter-sweep": ["reports/prefilter-overnight-finance-route-prefilter.md"],
  "spectra-metavaults-route-prefilter-sweep": ["reports/prefilter-spectra-metavaults-route-prefilter.md"],
  "spectra-v2-full-test-sweep": ["reports/spectra-v2-full-test-triage.md"],
  "spectra-metavaults-outside-v2-full-test-sweep": ["reports/spectra-metavaults-outside-v2-full-test-triage.md"],
  "ring-few-full-test-sweep": ["reports/ring-few-full-test-triage.md"],
  "rockawayx-full-test-sweep": ["reports/rockawayx-full-test-triage.md"],
  "royco-v1-full-test-sweep": ["reports/royco-v1-full-test-triage.md"],
  "eigencloud-full-test-sweep": ["reports/eigencloud-full-test-triage.md"],
  "stake-dao-full-test-sweep": ["reports/stake-dao-full-test-triage.md"],
  "stobox-full-test-sweep": ["reports/stobox-full-test-triage.md"],
  "brix-full-test-sweep": ["reports/brix-full-test-triage.md"],
  "meme-dollar-full-test-sweep": ["reports/meme-dollar-full-test-triage.md"],
  "coinbase-wrapped-staked-eth-route-prefilter-sweep": ["reports/prefilter-coinbase-wrapped-staked-eth-route-prefilter.md"],
  "coinbase-wrapped-staked-eth-full-test-sweep": ["reports/coinbase-wrapped-staked-eth-full-test-triage.md"],
  "wrappedfi-route-prefilter-sweep": ["reports/prefilter-wrappedfi-route-prefilter.md"],
  "wrappedfi-full-test-sweep": ["reports/wrappedfi-full-test-triage.md"],
  "wrappedfi-fork-route-test-sweep": ["reports/wrappedfi-fork-route-test.md"],
  "summer-fi-pro-route-prefilter-sweep": ["reports/prefilter-summer-fi-pro-route-prefilter.md"],
  "summer-fi-pro-full-test-sweep": ["reports/summer-fi-pro-full-test-triage.md"],
  "summer-fi-pro-fork-route-test-sweep": ["reports/summer-fi-pro-fork-route-test.md"],
  "b2-buzz-route-prefilter-sweep": ["reports/prefilter-b2-buzz-route-prefilter.md"],
  "b2-buzz-full-test-sweep": ["reports/b2-buzz-full-test-triage.md"],
  "b2-buzz-fork-route-test-sweep": ["reports/b2-buzz-fork-route-test.md"],
  "etherfuse-route-prefilter-sweep": ["reports/prefilter-etherfuse-route-prefilter.md"],
  "etherfuse-full-test-sweep": ["reports/etherfuse-full-test-triage.md"],
  "etherfuse-fork-route-test-sweep": ["reports/etherfuse-fork-route-test.md"],
  "merlins-seal-full-test-sweep": ["reports/merlins-seal-full-test-triage.md"],
  "upshift-full-test-sweep": ["reports/upshift-full-test-triage.md"],
  "stader-full-test-sweep": ["reports/stader-full-test-triage.md"],
  "stader-fork-transaction-test-sweep": ["reports/stader-fork-transaction-test.md"],
  "maple-full-test-sweep": ["reports/maple-full-test-triage.md"],
  "gauntlet-full-test-sweep": ["reports/gauntlet-full-test-triage.md"],
  "pumpbtc-full-test-sweep": ["reports/pumpbtc-full-test-triage.md"],
  "cap-full-test-sweep": ["reports/cap-full-test-triage.md"],
  "openeden-tbill-phase0-sweep": ["reports/openeden-tbill-phase0-triage.md"],
  "lighter-bridge-route-prefilter-sweep": ["reports/prefilter-lighter-bridge-route-prefilter.md"],
  "aster-bridge-route-prefilter-sweep": ["reports/critical-aster-bnb-treasury-control.md"],
  "sanko-bridge-phase0-sweep": ["reports/sanko-bridge-phase0-triage.md"],
  "moonwell-lending-phase0-sweep": ["reports/moonwell-lending-phase0-triage.md"],
  "liquity-v1-phase0-sweep": ["reports/liquity-v1-phase0-triage.md"],
  "liquity-v2-phase0-sweep": ["reports/liquity-v2-phase0-triage.md"],
  "frax-usd-phase0-sweep": ["reports/frax-usd-phase0-triage.md"],
  "world-chain-bridge-phase0-sweep": ["reports/world-chain-bridge-phase0-triage.md"],
  "avalanche-core-bridge-phase0-sweep": ["reports/avalanche-core-bridge-phase0-triage.md"],
  "metis-bridge-phase0-sweep": ["reports/metis-bridge-phase0-triage.md"],
  "ccip-phase0-sweep": ["reports/critical-ccip-syrupusdt-release-auth.md", "reports/critical-ccip-syrupusdt-backing-conservation.md"],
  "solvbtc-phase0-sweep": ["reports/solvbtc-phase0-triage.md"],
  "solvbtc-admin-surface-sweep": ["reports/solvbtc-admin-surface-triage.md"],
  "usdcx-phase0-sweep": ["reports/usdcx-phase0-triage.md"],
  "stader-phase0-sweep": ["reports/stader-phase0-triage.md"],
  "robinhood-chain-phase0-sweep": ["reports/robinhood-chain-phase0-triage.md"],
  "robinhood-chain-attack-vector-sweep": ["reports/robinhood-chain-attack-vectors-triage.md"],
  "apollo-acred-phase0-sweep": ["reports/apollo-acred-phase0-triage.md"],
  "sx-rollup-bridge-phase0-sweep": ["reports/sx-rollup-bridge-phase0-triage.md"],
  "usdd-phase0-sweep": ["reports/usdd-phase0-triage.md"],
  "txflow-bridge-phase0-sweep": ["reports/txflow-bridge-phase0-triage.md"],
  "frankencoin-phase0-sweep": ["reports/frankencoin-phase0-triage.md"],
  "invesco-ustb-phase0-sweep": ["reports/invesco-ustb-phase0-triage.md"],
  "lista-cdp-phase0-sweep": ["reports/lista-cdp-phase0-triage.md"],
  "lista-dex-phase0-sweep": ["reports/lista-dex-phase0-triage.md"],
  "joe-v22-phase0-sweep": ["reports/joe-v22-phase0-triage.md"],
  "balancer-v3-phase0-sweep": ["reports/balancer-v3-phase0-triage.md"],
  "uniswap-v2-phase0-sweep": ["reports/uniswap-v2-phase0-triage.md"],
  "uniswap-v3-phase0-sweep": ["reports/uniswap-v3-phase0-triage.md"],
  "pancakeswap-amm-phase0-sweep": ["reports/pancakeswap-amm-phase0-triage.md"],
  "pancakeswap-amm-v3-phase0-sweep": ["reports/pancakeswap-amm-v3-phase0-triage.md"],
  "pancakeswap-infinity-phase0-sweep": ["reports/pancakeswap-infinity-phase0-triage.md"],
  "ekubo-phase0-sweep": ["reports/ekubo-phase0-triage.md"],
  "thorchain-dex-phase0-sweep": ["reports/thorchain-dex-phase0-triage.md"],
  "curve-dex-phase0-sweep": ["reports/curve-dex-phase0-triage.md"],
  "quickswap-dex-phase0-sweep": ["reports/quickswap-dex-phase0-triage.md"],
  "fluid-dex-phase0-sweep": ["reports/fluid-dex-phase0-triage.md"],
  "aerodrome-slipstream-phase0-sweep": ["reports/aerodrome-slipstream-phase0-triage.md"],
  "aerodrome-v1-phase0-sweep": ["reports/aerodrome-v1-phase0-triage.md"],
  "velodrome-v3-phase0-sweep": ["reports/velodrome-v3-phase0-triage.md"],
  "nado-spot-phase0-sweep": ["reports/nado-spot-phase0-triage.md"],
  "3f-phase0-sweep": ["reports/3f-phase0-triage.md"],
  "silo-v2-phase0-sweep": ["reports/silo-v2-phase0-triage.md"],
  "harmonix-phase0-sweep": ["reports/harmonix-phase0-triage.md"],
  "euler-v2-phase0-sweep": ["reports/euler-v2-phase0-triage.md"],
  "nest-credit-phase0-sweep": ["reports/nest-credit-phase0-triage.md"],
  "compound-v3-phase0-sweep": ["reports/compound-v3-phase0-triage.md"],
  "pareto-credit-phase0-sweep": ["reports/pareto-credit-phase0-triage.md"],
  "etherfi-borrowing-phase0-sweep": ["reports/etherfi-borrowing-phase0-triage.md"],
  "felix-cdp-phase0-sweep": ["reports/felix-cdp-phase0-triage.md"],
  "erc4626-consumer-joiner-sweep": ["reports/erc4626-consumer-joiner-triage.md"],
  "new-vault-donation-attack-sweep": ["reports/new-vault-donation-attack-triage.md"],
  "silo-pt-oracle-routes-sweep": ["reports/silo-pt-oracle-routes-triage.md"],
  "pendle-pt-consumer-graph-sweep": ["reports/pendle-pt-consumer-graph-triage.md"],
  "pendle-pt-multichain-consumer-sweep": ["reports/pendle-pt-multichain-consumer-graph-triage.md"],
  "pendle-yt-collateral-sweep": ["reports/pendle-yt-collateral-routes-triage.md"],
  "usdt0-consumer-routes-sweep": ["reports/usdt0-consumer-routes-triage.md"],
  "usdt0-oft-routes-sweep": ["reports/usdt0-oft-routes-triage.md"],
  "apyusd-erc4626-fork-proof-sweep": ["reports/apyusd-erc4626-redeem-route-triage.md"],
  "perpsLendingComposability": ["reports/perps-lending-composability-triage.md"],
};

const NON_TRIAGE_REPORTS = new Set([
  "bounty-eligibility-matrix.md",
  "next-top5-audit-targets.md",
  "phase0-coverage-audit.md",
]);

// Documented, deliberately narrow allowlist of historical document kinds that are not
// triage/findings reports. Only exact filename suffixes listed here are classified; broad
// heuristics are intentionally avoided so a genuine findings report (for example any
// *-triage.md) can never be hidden. Review this list before extending it.
const NON_TRIAGE_REPORT_SUFFIXES = Object.freeze([
  "-definitions.md",
  "-sources.md",
  "-exact-source-acquisition.md",
]);

function isNonTriageReport(file) {
  const name = String(file || "");
  return NON_TRIAGE_REPORTS.has(name) || NON_TRIAGE_REPORT_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

function readJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function readText(file, fallback = "") {
  try {
    if (!fs.existsSync(file)) return fallback;
    return fs.readFileSync(file, "utf8");
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

function round(value, decimals = 2) {
  const n = asNumber(value);
  if (n === null) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function safeRelative(file) {
  return path.relative(WORKSPACE, file).replace(/\\/g, "/");
}

function absFromWorkspace(relativePath) {
  return path.join(WORKSPACE, String(relativePath || "").replace(/[\\/]+/g, path.sep));
}

function unique(items) {
  return [...new Set((items || []).filter(Boolean))];
}

function firstLine(text) {
  return String(text || "").split(/\r?\n/).find((line) => line.trim()) || "";
}

function hasSignalBanner(text) {
  const content = String(text || "");
  return Object.values(SIGNALS).some((signal) => content.includes(signal))
    || /DORMANT\/CONDITIONAL_FULL_BALANCE_SWEEP/i.test(content)
    || /WATCH\/NO_LOCKED_EXIT_EDGE/i.test(content)
    || /No confirmed permissionless/i.test(content);
}

function classifySignal(text) {
  const content = String(text || "");
  if (content.includes(SIGNALS.CONFIRMED)) return "CONFIRMED";
  if (content.includes(SIGNALS.VULNERABLE)) return "VULNERABLE";
  if (content.includes(SIGNALS.WATCH)) return "WATCH";
  if (content.includes(SIGNALS.DORMANT)) return "DORMANT";
  if (/DORMANT\/CONDITIONAL_FULL_BALANCE_SWEEP/i.test(content)) return "DORMANT";
  if (/WATCH\/NO_LOCKED_EXIT_EDGE/i.test(content)) return "WATCH";
  if (content.includes(SIGNALS.CLEAN) || /No confirmed permissionless/i.test(content)) return "CLEAN";
  return "UNTAGGED";
}

function scanReportSignals() {
  const results = { CONFIRMED: [], VULNERABLE: [], WATCH: [], DORMANT: [], CLEAN: [], UNTAGGED: [] };
  const files = fs.existsSync(REPORTS_DIR)
    ? fs.readdirSync(REPORTS_DIR).filter((file) => file.endsWith(".md") && !NON_TRIAGE_REPORTS.has(file)).sort()
    : [];
  for (const file of files) {
    const content = readText(path.join(REPORTS_DIR, file));
    results[classifySignal(content)].push(file);
  }
  return {
    counts: Object.fromEntries(Object.entries(results).map(([key, value]) => [key, value.length])),
    files: results,
    totalReports: files.length,
  };
}

function artifactInfo(relativePath, freshnessHours = TOP_BRANCH_FRESH_HOURS) {
  const normalized = String(relativePath || "").replace(/\\/g, "/");
  const file = absFromWorkspace(normalized);
  if (!fs.existsSync(file)) {
    return { path: normalized, exists: false, generatedAt: null, ageHours: null, stale: true };
  }
  const stat = fs.statSync(file);
  const json = file.endsWith(".json") ? readJson(file, {}) : {};
  const generated = json?.generatedAt || json?.timestamp || json?.date || null;
  const generatedTime = generated ? Date.parse(generated) : NaN;
  const basisMs = Number.isFinite(generatedTime) ? generatedTime : stat.mtimeMs;
  const ageHours = Math.max(0, (Date.now() - basisMs) / 3_600_000);
  return {
    path: normalized,
    exists: true,
    generatedAt: Number.isFinite(generatedTime) ? new Date(generatedTime).toISOString() : null,
    modifiedAt: stat.mtime.toISOString(),
    ageHours: round(ageHours, 2),
    stale: ageHours > freshnessHours,
  };
}

function reportInfo(relativePath) {
  const normalized = String(relativePath || "").replace(/\\/g, "/");
  const file = absFromWorkspace(normalized);
  const exists = fs.existsSync(file);
  const text = exists ? readText(file) : "";
  return {
    path: normalized,
    exists,
    signal: exists ? classifySignal(text) : "MISSING",
    tagged: exists ? hasSignalBanner(text) : false,
    title: exists ? firstLine(text).replace(/^#\s*/, "") : null,
  };
}

function freshnessRequiredFor(row) {
  const rank = asNumber(row.rank) || 999;
  const routePositive = asNumber(row.routePositive) || 0;
  const status = String(row.status || "");
  if (routePositive > 0) return true;
  // Branches explicitly recorded as not eligible for full closure retain their source artifacts as
  // historical evidence; requiring those closed artifacts to be refreshed only creates stale noise.
  if (row.closureEligible === false || row.coverageOpen === true || row.historicalCoverageComplete === false) return false;
  return rank <= 6 || /watch|near|trigger/i.test(status);
}

// Only these three explicit, operator-recorded permanent states are terminal-non-closable.
// Every other branch keeps the existing closeout/incompleteness behaviour so no real blocker
// is downgraded or hidden.
//
// 2026-09-15 DECISION (leave failing, do NOT reclassify): the `fresh-completionGates` monitor
// assertion stays fail-closed while the residual backlog is open. The residual counts are real
// signal (stale active-branch source artifacts and untagged triage reports), so this scanner
// deliberately does not flip `completeForNow`, widen `healthyStatuses`, or relax the stale /
// untagged gates to make the monitor pass. Terminal branches are still excluded from the active
// blocker count using exactly the three flags below, and nothing else is classified as terminal.
// The residual branch ids are surfaced on the summary (`incompleteBranchIds`) so the evidence is
// reviewable without changing any gate.
function terminalNonClosable(row) {
  return row?.closureEligible === false || row?.coverageOpen === true || row?.historicalCoverageComplete === false;
}

function branchCompletion(row) {
  const freshnessRequired = freshnessRequiredFor(row);
  const reportFiles = REPORT_BY_ROUTE_ID[row.id] || [];
  const reports = reportFiles.map(reportInfo);
  const sourceArtifacts = unique(row.sourceArtifacts || []).map((artifact) => artifactInfo(artifact, TOP_BRANCH_FRESH_HOURS));
  const reportsPresent = reports.length > 0 && reports.every((report) => report.exists);
  const reportsTagged = reportsPresent && reports.every((report) => report.tagged);
  const sourceArtifactsPresent = sourceArtifacts.length > 0 && sourceArtifacts.every((artifact) => artifact.exists);
  const sourceArtifactsFresh = !freshnessRequired || (sourceArtifactsPresent && sourceArtifacts.every((artifact) => !artifact.stale));
  const hasBlockers = Array.isArray(row.blockers) && row.blockers.length > 0;
  const hasRequiredForRoutePositive = Array.isArray(row.requiredForRoutePositive) && row.requiredForRoutePositive.length > 0;
  const hasNextStep = Boolean(row.nextReadOnlyStep);
  const routePositive = asNumber(row.routePositive) || 0;
  const forkPositive = String(row.status || "").includes("fork-positive") || String(row.forkGate || "").includes("fork-positive");
  const incompleteReasons = [];
  if (!reports.length) incompleteReasons.push("report mapping missing from completion scanner");
  if (reports.length && !reportsPresent) incompleteReasons.push("triage report missing");
  if (reportsPresent && !reportsTagged) incompleteReasons.push("triage report lacks signal banner");
  if (!sourceArtifacts.length) incompleteReasons.push("source artifact list missing");
  if (sourceArtifacts.length && !sourceArtifactsPresent) incompleteReasons.push("source artifact missing");
  if (sourceArtifactsPresent && freshnessRequired && !sourceArtifactsFresh) incompleteReasons.push("source artifact stale");
  if (!hasBlockers) incompleteReasons.push("blockers missing");
  if (!hasRequiredForRoutePositive) incompleteReasons.push("requiredForRoutePositive missing");
  if (!hasNextStep) incompleteReasons.push("nextReadOnlyStep missing");
  if (routePositive > 0 && !forkPositive) incompleteReasons.push("route-positive branch requires fork proof");
  if (row.historicalCoverageComplete === false) incompleteReasons.push("bounded PASS retained with incomplete historical coverage; not eligible for full closure");
  else if (row.coverageOpen === true || row.closureEligible === false) incompleteReasons.push("coverage remains open; branch is not eligible for full closure");

  const terminal = terminalNonClosable(row);
  return {
    rank: row.rank,
    id: row.id,
    protocol: row.protocol,
    chain: row.chain,
    status: row.status,
    forkGate: row.forkGate || null,
    priorityScore: row.priorityScore,
    routePositive,
    freshnessRequired,
    executableNow: false,
    signedActionJustified: Boolean(row.signedActionJustified),
    historicalCoverageComplete: row.historicalCoverageComplete ?? null,
    coverageOpen: row.coverageOpen === true,
    routeNegativeClosure: row.routeNegativeClosure ?? null,
    sourceRuntimeEquivalence: row.sourceRuntimeEquivalence ?? null,
    closureEligible: row.closureEligible ?? null,
    completionCoverage: row.completionCoverage || "top-ranked",
    complete: incompleteReasons.length === 0,
    // A distinct, visible terminal state; the underlying incomplete reasons are retained so
    // the permanent non-closability is explicit rather than silently dropped.
    terminal,
    completionStatus: terminal ? "terminal-non-closable" : incompleteReasons.length === 0 ? "complete" : "incomplete",
    incompleteReasons,
    reports,
    sourceArtifacts,
    blockers: row.blockers || [],
    requiredForRoutePositive: row.requiredForRoutePositive || [],
    nextReadOnlyStep: row.nextReadOnlyStep || null,
  };
}

function selectedCompletionRows(ranked) {
  const selected = ranked.slice(0, TOP_BRANCH_COUNT).map((row) => ({
    ...row,
    completionCoverage: row.id === "critical-etherfi-default-module-capability-sweep"
      ? "required-active-closeout"
      : `top-${TOP_BRANCH_COUNT}`,
  }));
  const seen = new Set(selected.map((row) => row.id));
  const missingRequiredBranchIds = [];
  for (const id of REQUIRED_BRANCH_IDS) {
    if (seen.has(id)) continue;
    const row = ranked.find((item) => item.id === id);
    if (!row) {
      missingRequiredBranchIds.push(id);
      continue;
    }
    selected.push({ ...row, completionCoverage: "required-active-closeout" });
    seen.add(id);
  }
  return { rows: selected, missingRequiredBranchIds };
}

function topBlocker(branch) {
  if (branch.routePositive > 0 && String(branch.forkGate || "").includes("fork-positive")) return "fork-positive: live preflight and explicit authorization required";
  if (branch.routePositive > 0) return "route-positive: fork proof required";
  if (branch.blockers?.length) return branch.blockers[0];
  if (branch.incompleteReasons?.length) return branch.incompleteReasons[0];
  return "closed with explicit reopen criteria";
}

function completionStatus({ routeSummary, proximitySummary, reportSignals, branches, criticalArtifacts, missingRequiredBranchIds = [], upstreamSafety = null }) {
  const routePositive = asNumber(routeSummary.routePositive) || 0;
  const executableNowTypeValid = typeof routeSummary.executableNow === "boolean"
    && Number.isSafeInteger(routeSummary.executableNowCount)
    && routeSummary.executableNowCount >= 0;
  const upstreamExecutableNow = routeSummary.executableNow === true;
  const executableNowCount = executableNowTypeValid
    ? Math.max(routeSummary.executableNowCount, upstreamExecutableNow ? 1 : 0)
    : 0;
  const upstreamSignedActionSignal = Boolean(routeSummary.signedActionJustified || proximitySummary.signedActionJustified);
  const incompleteBranches = branches.filter((branch) => !branch.complete && branch.terminal !== true);
  const terminalBranches = branches.filter((branch) => branch.terminal === true);
  const staleCriticalArtifacts = criticalArtifacts.filter((artifact) => artifact.stale);
  const missingCriticalArtifacts = criticalArtifacts.filter((artifact) => !artifact.exists);
  const untaggedReports = reportSignals.files.UNTAGGED || [];
  // The raw untagged total is retained. Historical document kinds are classified separately
  // (explicit suffix allowlist only) so the actionable triage count never hides a findings
  // report. The raw count is always reported alongside the classified and actionable counts.
  const classifiedNonTriageUntaggedReports = untaggedReports.filter((file) => isNonTriageReport(file));
  const actionableUntaggedReports = untaggedReports.filter((file) => !isNonTriageReport(file));
  const safetySignals = upstreamSafety || authorizationSafetySignals([routeSummary, proximitySummary]);
  const hardStop = safetySignals.hardStop === true;
  const completeForNow = routePositive === 0
    && !hardStop
    && executableNowTypeValid
    && !upstreamExecutableNow
    && executableNowCount === 0
    && !upstreamSignedActionSignal
    && incompleteBranches.length === 0
    && staleCriticalArtifacts.length === 0
    && missingCriticalArtifacts.length === 0
    && missingRequiredBranchIds.length === 0
    && actionableUntaggedReports.length === 0;

  let status = "watch-ready";
  let nextAction = "No fork/executor work. Continue trigger watchers and refresh completion gates after material market changes.";
  if (hardStop) {
    status = "hard-stop-upstream-authorization-signal";
    nextAction = "Stop before live action. Regenerate all upstream artifacts with canonical closed authorization fields and require explicit authorization before any signed action.";
  } else if (!executableNowTypeValid) {
    status = "invalid-route-gate-types";
    nextAction = "Regenerate route sweep with canonical executableNow boolean and executableNowCount numeric fields.";
  } else if (routePositive > 0 || upstreamExecutableNow || executableNowCount > 0) {
    const topForkPositive = String(routeSummary.topStatus || "").includes("fork-positive")
      || branches.some((branch) => branch.rank === 1 && String(branch.forkGate || "").includes("fork-positive"));
    status = topForkPositive ? "fork-positive-needs-live-preflight" : "route-positive-needs-fork-proof";
    nextAction = topForkPositive
      ? "Stop before live action. Run fresh read-only preflight/staticCall/estimateGas and require explicit authorization."
      : "Fork-test the top route-positive candidate before any signed action.";
  } else if (upstreamSignedActionSignal) {
    status = "signed-gate-open-needs-authorization";
    nextAction = "Stop and require explicit operator authorization plus fresh staticCall/estimateGas/minProfit gates.";
  } else if (missingCriticalArtifacts.length > 0) {
    status = "missing-critical-artifacts";
    nextAction = `Regenerate missing critical artifacts: ${missingCriticalArtifacts.slice(0, 3).map((a) => a.path).join(", ")}.`;
  } else if (missingRequiredBranchIds.length > 0) {
    status = "missing-required-branch-coverage";
    nextAction = `Add route-sweep rows or completion mappings for required branch id(s): ${missingRequiredBranchIds.slice(0, 3).join(", ")}.`;
  } else if (staleCriticalArtifacts.length > 0) {
    status = "stale-critical-artifacts";
    nextAction = `Refresh stale critical artifacts: ${staleCriticalArtifacts.slice(0, 3).map((a) => a.path).join(", ")}.`;
  } else if (incompleteBranches.length > 0) {
    status = "branch-closeout-incomplete";
    nextAction = `Complete branch closeout metadata for ${incompleteBranches[0].id}: ${incompleteBranches[0].incompleteReasons[0]}.`;
  } else if (actionableUntaggedReports.length > 0) {
    status = "report-signal-housekeeping";
    nextAction = `Add signal banners or explicitly classify untagged report(s): ${actionableUntaggedReports.slice(0, 3).join(", ")}.`;
  }

  return {
    status,
    completeForNow,
    routePositive,
    executableNow: false,
    executableNowCount: 0,
    signedActionJustified: false,
    observedUpstreamAuthorizationSignal: safetySignals.observedUpstreamAuthorizationSignal === true,
    observedInvalidAuthorizationSignal: safetySignals.observedInvalidAuthorizationSignal === true,
    hardStop,
    incompleteBranchCount: incompleteBranches.length,
    // Residual evidence for review: the exact ids still blocking closure. These are genuine
    // active branches only; terminal-non-closable ids are reported separately below.
    incompleteBranchIds: incompleteBranches.map((branch) => branch.id),
    terminalBranchCount: terminalBranches.length,
    terminalBranchIds: terminalBranches.map((branch) => branch.id),
    staleCriticalArtifactCount: staleCriticalArtifacts.length,
    missingCriticalArtifactCount: missingCriticalArtifacts.length,
    missingRequiredBranchCount: missingRequiredBranchIds.length,
    missingRequiredBranchIds,
    untaggedReportCount: untaggedReports.length,
    classifiedNonTriageUntaggedReportCount: classifiedNonTriageUntaggedReports.length,
    actionableUntaggedReportCount: actionableUntaggedReports.length,
    nonTriageUntaggedReports: untaggedReports.filter((file) => NON_TRIAGE_REPORTS.has(file)),
    classifiedNonTriageUntaggedReports,
    nextAction,
  };
}

function markdownTable(rows, headers) {
  const lines = [];
  lines.push(`| ${headers.join(" | ")} |`);
  lines.push(`| ${headers.map(() => "---").join(" | ")} |`);
  for (const row of rows) {
    lines.push(`| ${headers.map((header) => String(row[header] ?? "").replace(/\r?\n/g, " ")).join(" | ")} |`);
  }
  return lines.join("\n");
}

function renderReport(artifact) {
  const signalCounts = artifact.reportSignals.counts;
  const status = artifact.summary.status;
  const verdict = artifact.summary.completeForNow
    ? "Complete for now: all selected top and required route branches are closed or watch-ready, and no fork/signed gate is open."
    : `Not complete for now: ${artifact.summary.nextAction}`;
  const topRows = artifact.branchCompletion.slice(0, 8).map((branch) => ({
    Rank: branch.rank,
    Surface: branch.id,
    Status: branch.status,
    Complete: branch.terminal ? "terminal" : branch.complete ? "yes" : "no",
    Blocker: topBlocker(branch),
  }));
  const requiredRows = artifact.branchCompletion
    .filter((branch) => branch.completionCoverage === "required-active-closeout" || REQUIRED_BRANCH_IDS.includes(branch.id))
    .map((branch) => ({
      Rank: branch.rank,
      Surface: branch.id,
      Coverage: branch.completionCoverage,
      Complete: branch.terminal ? "terminal" : branch.complete ? "yes" : "no",
      Blocker: topBlocker(branch),
    }));
  const criteriaRows = [
    { Gate: "Fork", Requirement: "source artifact routePositive > 0 plus exact positive economics after gas/slippage", Current: artifact.summary.routePositive > 0 ? "open" : "closed" },
    { Gate: "Signed action", Requirement: "fork proof, explicit authorization, bytecode/artifact verification, staticCall, estimateGas, minProfit/minOut", Current: artifact.summary.signedActionJustified ? "open" : "closed" },
    { Gate: "Branch closeout", Requirement: "raw artifact, tagged triage report, route-sweep row, blockers, requiredForRoutePositive, nextReadOnlyStep", Current: `${artifact.summary.incompleteBranchCount} incomplete / ${artifact.summary.terminalBranchCount} terminal-non-closable` },
    { Gate: "Artifact freshness", Requirement: `meta <= ${META_FRESH_HOURS}h, active branch artifacts <= ${TOP_BRANCH_FRESH_HOURS}h`, Current: artifact.summary.staleCriticalArtifactCount ? `${artifact.summary.staleCriticalArtifactCount} stale` : "fresh" },
    { Gate: "Report signals", Requirement: "all exploit triage reports explicitly tagged or clean-classified", Current: artifact.summary.actionableUntaggedReportCount ? `${artifact.summary.actionableUntaggedReportCount} actionable untagged (${artifact.summary.classifiedNonTriageUntaggedReportCount} historical classified)` : artifact.summary.untaggedReportCount ? `${artifact.summary.untaggedReportCount} non-triage untagged` : "complete" },
    { Gate: "Required branch coverage", Requirement: `explicitly check required branch ids: ${REQUIRED_BRANCH_IDS.join(", ")}`, Current: artifact.missingRequiredBranchIds.length ? `missing ${artifact.missingRequiredBranchIds.join(", ")}` : "covered" },
  ];

  return [
    `# ${SIGNALS.DORMANT} - Audit Completion Gates`,
    "",
    `Date: ${artifact.generatedAt.slice(0, 10)}`,
    "",
    "## Result",
    "",
    `**${status}.** ${verdict}`,
    "",
    "No RPC inventory, RPC URLs, private keys, env files, fork transactions, signed actions, or exploit execute calls were used by this scanner.",
    "",
    "## Current Gates",
    "",
    markdownTable([
      { Metric: "Route-positive surfaces", Value: artifact.summary.routePositive },
      { Metric: "Executable now", Value: artifact.summary.executableNow },
      { Metric: "Signed action justified", Value: artifact.summary.signedActionJustified },
      { Metric: "Confirmed reports", Value: signalCounts.CONFIRMED || 0 },
      { Metric: "Dormant reports", Value: signalCounts.DORMANT || 0 },
      { Metric: "Clean reports", Value: signalCounts.CLEAN || 0 },
      { Metric: "Untagged reports (raw)", Value: signalCounts.UNTAGGED || 0 },
      { Metric: "Untagged historical classified", Value: artifact.summary.classifiedNonTriageUntaggedReportCount || 0 },
      { Metric: "Untagged actionable", Value: artifact.summary.actionableUntaggedReportCount || 0 },
      { Metric: "Terminal non-closable branches", Value: artifact.summary.terminalBranchCount || 0 },
    ], ["Metric", "Value"]),
    "",
    "## Completion Criteria",
    "",
    markdownTable(criteriaRows, ["Gate", "Requirement", "Current"]),
    "",
    "## Top Branches",
    "",
    markdownTable(topRows, ["Rank", "Surface", "Status", "Complete", "Blocker"]),
    "",
    "## Required / Active Closeout Branches",
    "",
    requiredRows.length ? markdownTable(requiredRows, ["Rank", "Surface", "Coverage", "Complete", "Blocker"]) : "No required branch ids configured.",
    "",
    "## Next Action",
    "",
    artifact.summary.nextAction,
    "",
    "## Artifacts",
    "",
    `- JSON: \`${safeRelative(RAW_OUT)}\``,
    "- Sources: `reports/raw/fast/route-positive-sweep.json`, `reports/raw/fast/evaluator-proximity.json`, `reports/*.md`",
    "",
  ].join("\n");
}

function buildArtifact(options = {}) {
  const routeSweep = options.routeSweep ?? readJson(ROUTE_SWEEP, {});
  const proximity = options.proximity ?? readJson(PROXIMITY, {});
  const routeSummary = routeSweep.summary || {};
  const proximitySummary = proximity.summary || {};
  const upstreamSafety = authorizationSafetySignals([routeSweep, proximity], options);
  const authorization = upstreamSafety.liveBatchStatus;
  const reportSignals = options.reportSignals ?? scanReportSignals();
  const ranked = Array.isArray(routeSweep.ranked) ? routeSweep.ranked : [];
  const selected = selectedCompletionRows(ranked);
  const branches = options.branches ?? selected.rows.map(branchCompletion);
  const topArtifactPaths = unique([
    "reports/raw/fast/route-positive-sweep.json",
    "reports/raw/fast/evaluator-proximity.json",
    ...branches.filter((branch) => branch.freshnessRequired).flatMap((branch) => branch.sourceArtifacts.map((artifact) => artifact.path)),
  ]);
  const criticalArtifacts = options.criticalArtifacts ?? topArtifactPaths.map((artifact) => artifactInfo(
    artifact,
    artifact.endsWith("route-positive-sweep.json") || artifact.endsWith("evaluator-proximity.json") ? META_FRESH_HOURS : TOP_BRANCH_FRESH_HOURS,
  ));
  const missingRequiredBranchIds = options.missingRequiredBranchIds ?? selected.missingRequiredBranchIds;
  const summary = completionStatus({ routeSummary, proximitySummary, reportSignals, branches, criticalArtifacts, missingRequiredBranchIds, upstreamSafety });
  const artifact = {
    generatedAt: options.generatedAt || new Date().toISOString(),
    scanner: "tools/scan-audit-completion-gates.js",
    scope: "Read-only audit completion gates over sanitized artifacts and triage reports",
    liveBatchStatus: authorization,
    safety: {
      rpcInventoryRead: false,
      rpcUrlsStored: false,
      envFilesRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: summary.routePositive > 0,
      signedActionJustified: summary.signedActionJustified,
      observedUpstreamAuthorizationSignal: summary.observedUpstreamAuthorizationSignal,
      observedInvalidAuthorizationSignal: summary.observedInvalidAuthorizationSignal,
      hardStop: summary.hardStop,
    },
    thresholds: {
      topBranchCount: TOP_BRANCH_COUNT,
      metaFreshHours: META_FRESH_HOURS,
      topBranchFreshHours: TOP_BRANCH_FRESH_HOURS,
      requiredBranchIds: REQUIRED_BRANCH_IDS,
    },
    completionCriteria: {
      forkOnlyAfter: [
        "source artifact routePositive > 0",
        "live exact route economics positive after gas and slippage",
        "fork extraction proof with measured profit",
      ],
      signedActionRequires: [
        "explicit operator authorization",
        "fresh staticCall and estimateGas",
        "deployed bytecode/artifact verification",
        "minProfit/minOut gates",
      ],
      branchCloseoutRequires: [
        "raw artifact exists",
        "triage report has a signal banner",
        "route sweep row exists",
        "explicit blockers are listed",
        "requiredForRoutePositive is listed",
        "nextReadOnlyStep is listed",
      ],
    },
    summary,
    routeSweepSummary: forceMonitorOnlyArtifact({ ...routeSummary, executableNow: false, executableNowCount: summary.executableNowCount }, upstreamSafety),
    proximitySummary: forceMonitorOnlyArtifact({ ...proximitySummary, executableNow: false, executableNowCount: 0 }, upstreamSafety),
    reportSignals,
    reportClassification: {
      nonTriageExactNames: [...NON_TRIAGE_REPORTS],
      nonTriageSuffixAllowlist: [...NON_TRIAGE_REPORT_SUFFIXES],
    },
    criticalArtifacts,
    missingRequiredBranchIds,
    branchCompletion: branches,
    openTriggers: branches
      .filter((branch) => /watch|near|trigger|blocked|negative|dormant/i.test(branch.status || ""))
      .slice(0, 10)
      .map((branch) => ({
        rank: branch.rank,
        id: branch.id,
        status: branch.status,
        routePositive: branch.routePositive,
        nextReadOnlyStep: branch.nextReadOnlyStep,
        topBlocker: topBlocker(branch),
      })),
  };

  return forceMonitorOnlyArtifact(rememberAuthorizationSnapshot(artifact, upstreamSafety), upstreamSafety);
}

function main() {
  const artifact = buildArtifact();
  fs.mkdirSync(path.dirname(RAW_OUT), { recursive: true });
  fs.writeFileSync(RAW_OUT, JSON.stringify(artifact, null, 2) + "\n");
  fs.writeFileSync(REPORT_OUT, renderReport(artifact));

  if (!QUIET) {
    console.log("Audit completion gate scan");
    console.log(`status=${artifact.summary.status} completeForNow=${artifact.summary.completeForNow}`);
    console.log(`routePositive=${artifact.summary.routePositive} executableNow=${artifact.summary.executableNow} signedActionJustified=${artifact.summary.signedActionJustified}`);
    console.log(`nextAction=${artifact.summary.nextAction}`);
    console.log(`Report: ${safeRelative(REPORT_OUT)}`);
  }
}

if (require.main === module) main();

module.exports = { buildArtifact, branchCompletion, completionStatus, isNonTriageReport, NON_TRIAGE_REPORT_SUFFIXES, terminalNonClosable };
