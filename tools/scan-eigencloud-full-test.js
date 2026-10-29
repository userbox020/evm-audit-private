#!/usr/bin/env node
"use strict";

// scan-eigencloud-full-test.js
// Defensive EigenCloud/EigenLayer full-test scanner. Artifact/static/local-first only;
// no endpoint inventory reads, network fetches, RPC calls, forks, or signed actions.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const REPORTS_DIR = path.join(WORKSPACE, "reports");
const OUT_JSON = path.join(RAW_DIR, "eigencloud-full-test.json");
const OUT_MD = path.join(REPORTS_DIR, "eigencloud-full-test-triage.md");
const OUT_JSON_REL = "reports/raw/fast/eigencloud-full-test.json";
const OUT_MD_REL = "reports/eigencloud-full-test-triage.md";

const QUIET = process.argv.includes("--quiet");
const GENERATED_AT = process.env.SCAN_GENERATED_AT || "2026-07-07T00:00:00.000Z";

const MAX_FILE_BYTES = 24 * 1024 * 1024;
const MAX_LOCAL_MATCH_ROWS = 840;
const MAX_LOCAL_OBJECT_ROWS = 460;
const MAX_ROWS_PER_FILE = 36;
const MAX_JSON_DEPTH = 9;
const MAX_TOKEN_ROWS = 220;

const TARGET = {
  slug: "eigencloud",
  name: "EigenCloud",
  protocolFamily: "EigenLayer",
  kind: "protocol",
  category: "Restaking",
  discoveryRank: 16,
  tvlContextUsd: 4_317_281_559.28,
  tvlContext: "$4.317B",
  surface: "vault-yield-allocator",
  primaryChains: ["Ethereum"],
  evmFirstChain: "Ethereum",
  caveatChains: [],
  routeGraph: "vault share -> rate/strategy accounting -> consumer or exit venue -> borrow/redeem/unwind",
  firstReadOnlyChecks: [
    "resolve vault/share token",
    "probe ERC4626/share-rate/donation semantics",
    "join shares to lending and DEX consumers",
  ],
  module: "eigenlayer/index.js",
  adapterFetched: true,
  adapterAddressCount: 4,
  adapterHints: ["bridge/custody", "redeem/withdraw"],
};

const CHAIN_SEEDS = [
  { chain: "Ethereum", chainLabel: "Ethereum", chainId: 1, adapterKey: "ethereum", evmFirst: true, caveat: false, classification: "primary-evm-discovery-chain" },
];

const DEPLOYMENT_ROWS = [
  { role: "StrategyManager", chain: "Ethereum", chainId: 1, address: "0x858646372CC42E1A627fcE94aa7A7033e7CF075A", source: "targets/eigenlayer-contracts/README.md:32; user-public-context", surface: "strategy/share-accounting", adapterSample: true, classification: "mainnet-proxy-static-local-deployment-row" },
  { role: "DelegationManager", chain: "Ethereum", chainId: 1, address: "0x39053D51B77DC0d36036Fc1fCc8Cb819df8Ef37A", source: "targets/eigenlayer-contracts/README.md:31", surface: "delegation-withdrawal-queue", classification: "mainnet-proxy-static-local-deployment-row" },
  { role: "AllocationManager", chain: "Ethereum", chainId: 1, address: "0x948a420b8CC1d6BFd0B6087C2E7c344a2CD0bc39", source: "targets/eigenlayer-contracts/README.md:37", surface: "slashing/allocation", classification: "mainnet-proxy-static-local-deployment-row" },
  { role: "EigenPodManager", chain: "Ethereum", chainId: 1, address: "0x91E677b07F7AF907ec9a428aafA9fc14a0d3A338", source: "targets/eigenlayer-contracts/README.md:33; user-public-context", surface: "eigenpod/native-eth", adapterSample: true, classification: "mainnet-proxy-static-local-deployment-row" },
  { role: "EigenPod beacon", chain: "Ethereum", chainId: 1, address: "0x5a2a4F2F3C18f09179B6703e63D9eDD165909073", source: "targets/eigenlayer-contracts/README.md:80", surface: "eigenpod/native-eth", classification: "mainnet-beacon-static-local-deployment-row" },
  { role: "StrategyBase beacon", chain: "Ethereum", chainId: 1, address: "0x0ed6703C298d28aE0878d1b28e88cA87F9662fE9", source: "targets/eigenlayer-contracts/README.md:47", surface: "strategy/share-accounting", classification: "mainnet-beacon-static-local-deployment-row" },
  { role: "StrategyBase stETH", chain: "Ethereum", chainId: 1, address: "0x93c4b944D05dfe6df7645A86cd2206016c51564D", source: "targets/eigenlayer-contracts/README.md:55", assetSymbol: "stETH", surface: "strategy/share-accounting", classification: "mainnet-proxy-static-local-deployment-row" },
  { role: "StrategyBase rETH", chain: "Ethereum", chainId: 1, address: "0x1BeE69b7dFFfA4E2d53C2a2Df135C388AD25dCD2", source: "targets/eigenlayer-contracts/README.md:56", assetSymbol: "rETH", surface: "strategy/share-accounting", classification: "mainnet-proxy-static-local-deployment-row" },
  { role: "StrategyBase ETHx", chain: "Ethereum", chainId: 1, address: "0x9d7eD45EE2E8FC5482fa2428f15C971e6369011d", source: "targets/eigenlayer-contracts/README.md:57", assetSymbol: "ETHx", surface: "strategy/share-accounting", classification: "mainnet-proxy-static-local-deployment-row" },
  { role: "StrategyBase osETH", chain: "Ethereum", chainId: 1, address: "0x57ba429517c3473B6d34CA9aCd56c0e735b94c02", source: "targets/eigenlayer-contracts/README.md:60", assetSymbol: "osETH", surface: "strategy/share-accounting", classification: "mainnet-proxy-static-local-deployment-row" },
  { role: "StrategyBase swETH", chain: "Ethereum", chainId: 1, address: "0x0Fe4F44beE93503346A3Ac9EE5A26b130a5796d6", source: "targets/eigenlayer-contracts/README.md:61", assetSymbol: "swETH", surface: "strategy/share-accounting", classification: "mainnet-proxy-static-local-deployment-row" },
  { role: "StrategyBase sfrxETH", chain: "Ethereum", chainId: 1, address: "0x8CA7A5d6f3acd3A7A8bC468a8CD0FB14B6BD28b6", source: "targets/eigenlayer-contracts/README.md:63", assetSymbol: "sfrxETH", surface: "strategy/share-accounting", classification: "mainnet-proxy-static-local-deployment-row" },
  { role: "StrategyBase lsETH", chain: "Ethereum", chainId: 1, address: "0xAe60d8180437b5C34bB956822ac2710972584473", source: "targets/eigenlayer-contracts/README.md:64", assetSymbol: "lsETH", surface: "strategy/share-accounting", classification: "mainnet-proxy-static-local-deployment-row" },
  { role: "StrategyBase mETH", chain: "Ethereum", chainId: 1, address: "0x298aFB19A105D59E74658C4C334Ff360BadE6dd2", source: "targets/eigenlayer-contracts/README.md:65", assetSymbol: "mETH", surface: "strategy/share-accounting", classification: "mainnet-proxy-static-local-deployment-row" },
  { role: "EigenStrategy (EIGEN)", chain: "Ethereum", chainId: 1, address: "0xaCB55C530Acdb2849e6d4f36992Cd8c9D50ED8F7", source: "targets/eigenlayer-contracts/README.md:73; user-public-context", assetSymbol: "EIGEN", surface: "strategy/share-accounting", adapterSample: true, classification: "mainnet-proxy-static-local-deployment-row" },
  { role: "Beacon Chain ETH shares", chain: "Ethereum", chainId: 1, address: "0xbeaC0eeEeeeeEEeEeEEEEeeEEeEeeeEeeEEBEaC0", source: "targets/eigenlayer-contracts/README.md:74", assetSymbol: "Native ETH", surface: "eigenpod/native-eth", classification: "special-share-address-not-real-contract" },
  { role: "Eigen token", chain: "Ethereum", chainId: 1, address: "0xec53bf9167f50cdeb3ae105f56099aaab9061f83", source: "targets/eigenlayer-contracts/README.md:86", assetSymbol: "EIGEN", surface: "token", classification: "mainnet-token-proxy-static-local-deployment-row" },
  { role: "Backing Eigen", chain: "Ethereum", chainId: 1, address: "0x83E9115d334D248Ce39a6f36144aEaB5b3456e75", source: "targets/eigenlayer-contracts/README.md:87; user-public-context", assetSymbol: "bEIGEN", surface: "bridge/custody", adapterSample: true, classification: "mainnet-proxy-static-local-deployment-row" },
  { role: "RewardsCoordinator", chain: "Ethereum", chainId: 1, address: "0x7750d328b314EfFa365A0402CcfD489B80B0adda", source: "targets/eigenlayer-contracts/README.md:35", surface: "rewards", classification: "mainnet-proxy-static-local-deployment-row" },
  { role: "CrossChainRegistry", chain: "Ethereum", chainId: 1, address: "0x9376A5863F2193cdE13e1aB7c678F22554E2Ea2b", source: "targets/eigenlayer-contracts/README.md:105", surface: "bridge/custody", classification: "mainnet-proxy-static-local-deployment-row" },
];

const SURFACE_ROWS = [
  { component: "StrategyManager", surface: "strategy/share accounting", sourceFiles: ["src/contracts/core/StrategyManager.sol", "interfaces/IStrategyManager.sol"], routeRole: "deposit/redeem accounting seed", watchTerms: ["depositIntoStrategy", "shares", "removeShares", "strategyWhitelister"] },
  { component: "DelegationManager", surface: "delegation + withdrawal queue", sourceFiles: ["src/contracts/core/DelegationManager.sol", "interfaces/IDelegationManager.sol"], routeRole: "delegation, queue, complete withdrawal semantics", watchTerms: ["delegateTo", "queueWithdrawals", "completeQueuedWithdrawal", "withdrawalDelayBlocks"] },
  { component: "AllocationManager", surface: "slashing/allocation", sourceFiles: ["src/contracts/core/AllocationManager.sol", "libraries/SlashingLib.sol"], routeRole: "operator-set allocation and slash accounting", watchTerms: ["modifyAllocations", "slashOperator", "deallocationDelay", "maxMagnitude"] },
  { component: "EigenPodManager", surface: "eigenpod/native ETH", sourceFiles: ["src/contracts/pods/EigenPodManager.sol", "interfaces/IEigenPodManager.sol"], routeRole: "native restaking shares and pod creation", watchTerms: ["createPod", "stake", "recordBeaconChainETHBalanceUpdate", "beaconChainETHStrategy"] },
  { component: "EigenPod", surface: "beacon proofs + native ETH withdrawals", sourceFiles: ["src/contracts/pods/EigenPod.sol", "interfaces/IEigenPod.sol"], routeRole: "validator balance/checkpoint/withdrawal proof handling", watchTerms: ["verifyWithdrawalCredentials", "startCheckpoint", "verifyCheckpointProofs", "withdrawRestakedBeaconChainETH"] },
  { component: "StrategyBase/EigenStrategy", surface: "strategy share accounting", sourceFiles: ["src/contracts/strategies/StrategyBase.sol", "src/contracts/strategies/EigenStrategy.sol"], routeRole: "share/underlying conversion and EIGEN/bEIGEN flows", watchTerms: ["sharesToUnderlying", "underlyingToShares", "deposit", "withdraw"] },
  { component: "RewardsCoordinator", surface: "rewards", sourceFiles: ["src/contracts/core/RewardsCoordinator.sol", "interfaces/IRewardsCoordinator.sol"], routeRole: "reward root/claim accounting", watchTerms: ["processClaim", "submitRoot", "cumulativeEarnings", "Merkle"] },
  { component: "CrossChainRegistry/OperatorTableUpdater", surface: "bridge/custody", sourceFiles: ["src/contracts/multichain/*"], routeRole: "multichain operator table transport context", watchTerms: ["CrossChainRegistry", "OperatorTableUpdater", "destination", "certificate"] },
];

const SOURCE_FACTS = [
  {
    sourceLabel: "local-prefilter-discovery-json:2026-06-24:1013-1064",
    kind: "local-discovery-json",
    slug: TARGET.slug,
    name: TARGET.name,
    category: TARGET.category,
    surface: TARGET.surface,
    tvlContext: TARGET.tvlContext,
    chains: TARGET.primaryChains,
    blockedOrCaveatChains: [],
    module: TARGET.module,
    adapterFetched: true,
    adapterAddressCount: 4,
    adapterHints: TARGET.adapterHints,
    routePositive: 0,
    classification: "structured-target-seed-route-negative",
  },
  {
    sourceLabel: "local-prefilter-triage-md:rank-16-context",
    kind: "local-discovery-md",
    slug: TARGET.slug,
    routeGraph: TARGET.routeGraph,
    firstReadOnlyChecks: TARGET.firstReadOnlyChecks,
    classification: "queue-context-no-route-positive",
  },
  {
    sourceLabel: "defillama-adapter-label:eigenlayer/index.js",
    kind: "public-static-label",
    module: TARGET.module,
    adapterFetched: true,
    adapterAddressCount: 4,
    adapterHints: TARGET.adapterHints,
    classification: "source-label-only-no-url-stored",
  },
  {
    sourceLabel: "official-local-deployment-table:targets/eigenlayer-contracts/README.md",
    kind: "local-source-doc",
    addressSeedRows: DEPLOYMENT_ROWS.length,
    classification: "static-deployment-rows-no-live-state-proof",
  },
  {
    sourceLabel: "prior-eigenlayer-audit-plan",
    kind: "prior-local-context",
    artifact: "reports/eigenlayer-audit-plan.md",
    classification: "watch-plan-context-only",
  },
  {
    sourceLabel: "prior-eigenlayer-phase1-triage",
    kind: "prior-local-context",
    artifact: "reports/eigenlayer-phase1-triage.md",
    classification: "prior-watch-surface-not-current-full-test-route-positive",
  },
  {
    sourceLabel: "prior-lrt-nav-dex-divergence-artifact",
    kind: "prior-local-context",
    artifact: "reports/raw/fast/eigenlayer-lrt-nav-dex-divergence.json",
    classification: "prior-route-signal-not-promoted-without-current-exact-economics",
  },
  {
    sourceLabel: "prior-slashing-rehypothecation-artifact",
    kind: "prior-local-context",
    artifact: "reports/raw/fast/eigenlayer-slashing-rehypothecation.json",
    classification: "prior-context-no-current-route-positive",
  },
  {
    sourceLabel: "local-source-and-integration-context",
    kind: "local-source",
    sourceRoots: ["targets/eigenlayer-contracts/src/contracts", "targets/etherfi-contracts/src/eigenlayer-interfaces", "targets/cap-contracts/contracts/delegation/providers/eigenlayer"],
    classification: "source-static-context-only",
  },
  {
    sourceLabel: "local-consumer-and-exit-context",
    kind: "local-artifact-context",
    artifacts: ["reports/raw/fast/aave-euler-silo-consumer-graph.json", "reports/raw/fast/consumer-first-high-ltv-collateral.json", "reports/morpho-pyth-unsafe-consumers-triage.md", "reports/aave-v4-hubs-triage.md", "reports/compound-v3-phase0-triage.md", "reports/bridge-nonlossless-collateral-join-triage.md"],
    classification: "consumer-context-only-no-route-positive-promotion",
  },
];

const LRT_TOKENS = ["wstETH", "weETH", "ezETH", "pufETH", "rsETH", "rETH", "ETHx", "osETH", "swETH", "sfrxETH", "lsETH", "mETH", "EIGEN", "bEIGEN"];

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const ADDRESS_RULES = DEPLOYMENT_ROWS
  .map((row) => ({ label: `${row.role} ${row.address}`, regex: new RegExp(escapeRegExp(row.address), "i") }));

const TOKEN_RULES = LRT_TOKENS.map((symbol) => ({ label: symbol, regex: new RegExp(`\\b${escapeRegExp(symbol)}\\b`, "i") }));

const EXACT_RULES = [
  { label: "eigencloud", regex: /\beigencloud\b/i },
  { label: "EigenCloud", regex: /\bEigenCloud\b/ },
  { label: "EigenLayer", regex: /\bEigenLayer\b/i },
  { label: "eigenlayer/index.js", regex: /\beigenlayer[\\/]index\.js\b/i },
  { label: "eigenlayer-contracts", regex: /\beigenlayer-contracts\b/i },
  { label: "StrategyManager", regex: /\bStrategyManager\b/ },
  { label: "DelegationManager", regex: /\bDelegationManager\b/ },
  { label: "AllocationManager", regex: /\bAllocationManager\b/ },
  { label: "EigenPodManager", regex: /\bEigenPodManager\b/ },
  { label: "EigenPod", regex: /\bEigenPod\b/ },
  { label: "StrategyBase", regex: /\bStrategyBase(?:TVLLimits)?\b/ },
  { label: "EigenStrategy", regex: /\bEigenStrategy\b/ },
  { label: "RewardsCoordinator", regex: /\bRewardsCoordinator\b/ },
  { label: "Backing Eigen", regex: /\bBacking\s+Eigen\b/i },
  { label: "bEIGEN", regex: /\bbEIGEN\b/i },
  { label: "AVS", regex: /\bAVS(?:s)?\b/ },
  ...TOKEN_RULES,
  ...ADDRESS_RULES,
];

const CONTEXT_RULES = [
  { label: "restaking", regex: /\brestak(?:e|ing|ed)\b/i },
  { label: "LRT", regex: /\bLRTs?\b/i },
  { label: "share accounting", regex: /\bshare[-\s]?accounting\b/i },
  { label: "shares", regex: /\bshares?\b/i },
  { label: "strategy", regex: /\bstrateg(?:y|ies)\b/i },
  { label: "delegation", regex: /\bdelegat(?:e|ed|ion|or)\b/i },
  { label: "withdrawal queue", regex: /\b(?:queue(?:d)?\s+withdrawals?|withdrawal\s+queue|completeQueuedWithdrawal)\b/i },
  { label: "withdraw", regex: /\bwithdra(?:w|wal|wable|wn)\b/i },
  { label: "slashing", regex: /\bslash(?:ing|ed|able)?\b/i },
  { label: "allocation", regex: /\ballocat(?:e|ed|ion|or)\b/i },
  { label: "native ETH", regex: /\bnative\s+ETH\b/i },
  { label: "beacon", regex: /\bbeacon\b/i },
  { label: "rewards", regex: /\brewards?\b/i },
  { label: "bridge/custody", regex: /\b(?:bridge|custody|multichain|cross[-\s]?chain|destination\s+chain)\b/i },
  { label: "oracle/consumer", regex: /\b(?:oracle|consumer|collateral|borrow|lending|LLTV|LTV|Morpho|Aave|Euler|Silo|Comet|Compound)\b/i },
  { label: "dex/exit", regex: /\b(?:DEX|swap|pool|liquidity|slippage|unwind|exit\s+venue|Curve|Uniswap|Balancer)\b/i },
  { label: "NAV-DEX", regex: /\b(?:NAV[-\s]?DEX|navDex|NAV|depeg|amountForShare|convertToAssets)\b/i },
  { label: "routePositive", regex: /\broutePositive\b/i },
];

const CATEGORY_RULES = {
  strategyShareAccounting: ["strategy", "share", "shares", "share accounting", "share-accounting", "sharemanager", "sharesToUnderlying", "underlyingToShares", "depositIntoStrategy", "removeShares", "addShares", "StrategyBase", "EigenStrategy", "beaconChainETHStrategy", "totalShares", "convertTo", "underlying"],
  delegation: ["delegation", "delegate", "delegated", "delegator", "operator", "undelegate", "delegationManager", "isDelegated", "delegateTo"],
  withdrawalQueue: ["queuewithdrawal", "queuewithdrawals", "queued withdrawal", "queuedwithdrawal", "completequeuedwithdrawal", "withdrawal delay", "withdrawal queue", "withdrawalRoot", "delayed withdrawal", "100800", "14 days"],
  slashingAllocation: ["slash", "slashing", "allocation", "allocate", "deallocate", "operator set", "operatorset", "maxmagnitude", "allocationmanager", "slashinglib"],
  eigenpodNativeEth: ["eigenpod", "eigenpodmanager", "native eth", "beacon chain eth", "validator", "checkpoint", "beaconchain", "podowner", "withdrawalcredentials", "restakedbeaconchaineth"],
  rewards: ["rewardscoordinator", "reward", "rewards", "claim", "merkle", "earner", "cumulativeearnings", "submitroot", "rewardsupdater"],
  bridgeCustody: ["bridge", "custody", "crosschainregistry", "operatortableupdater", "multichain", "destination", "certificate", "transport", "chain table", "source chain"],
  redeemWithdraw: ["redeem", "withdraw", "withdrawal", "withdrawable", "undelegate", "completequeuedwithdrawal", "delayedwithdrawal", "queuewithdrawal", "exit"],
  oracleConsumer: ["oracle", "consumer", "collateral", "borrow", "lending", "morpho", "aave", "euler", "silo", "comet", "compound", "lltv", "ltv", "price", "feed", "pyth", "chainlink", "redstone"],
  dexExit: ["dex", "swap", "pool", "uniswap", "curve", "balancer", "liquidity", "slippage", "exit", "unwind", "market price"],
  highLtvCollateral: ["high-ltv", "high ltv", "lltv", "ltv", "0.945", "94.5", "collateral", "borrow", "liquidityusd"],
  lrtNavDexDivergence: ["lrt", "nav", "nav-dex", "navdex", "weeth", "ezeth", "pufeth", "rseth", "wsteth", "amountforshare", "converttoassets", "depeg", "divergence"],
  economics: ["routepositive", "executable", "netbps", "effectivebps", "positive", "profit", "bps", "liquidityusd", "tvl", "exacteconomics", "forkproof"],
};

const JSON_FIELD_ALLOWLIST = [
  "rank", "kind", "slug", "name", "category", "tvlUsd", "tvl", "currentTvlUsd", "chains", "primaryChain", "accessibleEvmChains", "blockedOrCaveatChains", "surface", "routeGraph", "firstReadOnlyChecks", "audits", "module", "score", "chain", "chainId", "adapterKey", "symbol", "assetSymbol", "asset", "underlying", "token", "vault", "vaultSymbol", "market", "loan", "collateral", "oracle", "lltv", "ltv", "liquidityUsd", "navEth", "dexEth", "navDexBps", "significant", "hasOnChainRate", "withdrawalDelayBlocks", "layer", "rate", "description", "routePositive", "executableNow", "signedActionJustified", "forkJustified", "status", "classification", "verdict",
];

const EXPLICIT_FILES = [
  "reports/raw/fast/prefilter-deep-new-target-search-2026-06-24.json",
  "reports/prefilter-deep-new-target-search-2026-06-24.md",
  "reports/eigenlayer-audit-plan.md",
  "reports/eigenlayer-phase1-triage.md",
  "reports/raw/fast/eigenlayer-lrt-nav-dex-divergence.json",
  "reports/raw/fast/eigenlayer-slashing-rehypothecation.json",
  "reports/raw/fast/aave-euler-silo-consumer-graph.json",
  "reports/raw/fast/consumer-first-high-ltv-collateral.json",
  "reports/morpho-pyth-unsafe-consumers-triage.md",
  "reports/aave-v4-hubs-triage.md",
  "reports/compound-v3-phase0-triage.md",
  "reports/bridge-nonlossless-collateral-join-triage.md",
  "targets/eigenlayer-contracts/README.md",
  "tools/scan-eigenlayer-lrt-nav-dex-divergence.js",
  "tools/scan-eigenlayer-slashing-rehypothecation.js",
  "tools/frontier-restaking-eigenlayer.js",
];

const SOURCE_ROOTS = [
  "targets/eigenlayer-contracts/src/contracts",
  "targets/etherfi-contracts/src/eigenlayer-interfaces",
  "targets/cap-contracts/contracts/delegation/providers/eigenlayer",
];

const BLOCKERS = [
  "No current exact EigenCloud/EigenLayer vault/share -> consumer/exit route is proven by this static/local pass; source and deployment rows are context only.",
  "Prior LRT NAV/DEX rows are retained as stale watch context and are not promoted because this scanner did not refresh current rates, consumer cash/caps, DEX exit liquidity, gas, or same-block fork proof.",
  "Strategy/share accounting, delegation, queued withdrawal, and EigenPod/native ETH surfaces require exact share conversion, delay, slash, pause, and completion-state evidence before any economics can be trusted.",
  "Allocation/slashing and AVS rows are not value-positive without a concrete permissionless slash/deallocate or magnitude-accounting route that yields attacker-controlled profit.",
  "RewardsCoordinator rows are not value-positive without exact claimable token value, proof validity, recipient control, and liquid exit after fees.",
  "Bridge/custody/multichain rows are adapter/source context only; no proof finality, custody unlock, or cross-chain accounting bypass is shown.",
  "Consumer/oracle/DEX/high-LTV references for LRT tokens remain join context until accepted value, borrow capacity, exit liquidity, fees, queues, and slippage are quantified for the same block/current state.",
  "No endpoint inventory was read and no live eth_call/fork refresh was performed in this bounded pass, so route gate stays fail-closed.",
  "Fork and signed-action gates remain closed because routePositive=0 and exactEconomicsRows=0.",
];

const REQUIRED_FOR_ROUTE_POSITIVE = [
  "Exact producer asset: identify a specific EigenLayer strategy share, EigenPod/native-ETH balance, EIGEN/bEIGEN position, reward claim, or LRT token with current state and owner/permissionless action path.",
  "Exact consumer/exit join: prove that the same asset or derivative is accepted by a current lending/consumer or has an immediate DEX/redeem/unwind route with material size.",
  "Accounting proof: quantify strategy share-to-underlying, EigenPod/native ETH, delegation/withdrawal queue, allocation/slashing, reward, and any bridge/custody conversions without stale assumptions.",
  "Positive economics: accepted value must exceed acquisition/redeem/exit value after LLTV haircuts, queues, fees, slippage, gas, caps, pauses, withdrawal delays, and oracle freshness checks.",
  "Permissionless execution: no allowlist, owner, pauser, operator-only, AVS-only, proof-authority, recipient-control, or timelock blocker can exist on the proposed path.",
  "Current read-only state or local fork/static value-delta proof must show positive attacker-controlled balance movement before routePositive, forkJustified, or signedActionJustified can change.",
  "Explicit route-specific authorization and independent defensive review are required before any signed transaction path is discussed.",
];

const NEXT_READ_ONLY_STEP = "Keep EigenCloud dormant until a concrete LRT/strategy/EigenPod/reward/bridge-consumer pair is selected; then refresh sanitized read-only state for exact share rates, withdrawal queues, slash/allocation magnitudes, consumer caps/cash/oracles, and DEX/redeem exits without endpoint inventory reads unless coordinator authorizes a bounded read-only refresh.";

function log(...args) {
  if (!QUIET) console.log(...args);
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function rel(filePath) {
  return path.relative(WORKSPACE, filePath).replace(/\\/g, "/");
}

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function sanitizeText(value, max = 360) {
  let text = String(value ?? "")
    .replace(/[\r\n|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  text = text
    .replace(/\brpc_endpoints\.txt\b/gi, "[redacted-endpoint-inventory]")
    .replace(/\bgraphql_endpoints\.txt\b/gi, "[redacted-endpoint-inventory]")
    .replace(/\bhttps?:\/\/[^\s"'`<>|)]+/gi, "[redacted-url]")
    .replace(/\bwww\.[^\s"'`<>|)]+/gi, "[redacted-url]")
    .replace(/\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|fi|app|xyz|finance|protocol|dev|co|so|network|tech|exchange|build|money|info|ai|eth|gg)\b/gi, "[redacted-domain]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/= -]+/gi, "Bearer [redacted]")
    .replace(/\b(authorization|api[-_]?key|access[-_]?key|private[-_]?key|secret[-_]?key|secret|token|password|pwd)\s*[:=]\s*["']?[^\s"',}\]]{8,}/gi, "$1=[redacted]")
    .replace(/\b0x[0-9a-fA-F]{64}\b/g, "[redacted-hex-key]")
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9._-]{20,}\.[A-Za-z0-9._-]{20,}\b/g, "[redacted-jwt]");
  return text.slice(0, max) || null;
}

function mdEscape(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function uniqBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    const norm = String(key).toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(item);
  }
  return out;
}

function pickRows(rows, predicate, max = 120) {
  const out = [];
  for (const row of rows) {
    if (!predicate(row)) continue;
    out.push(row);
    if (out.length >= max) break;
  }
  return out;
}

function isSecretLikePath(filePath) {
  const r = rel(filePath).replace(/\\/g, "/").toLowerCase();
  const base = path.basename(filePath).toLowerCase();
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (base === "rpc_endpoints.txt" || base === "graphql_endpoints.txt") return true;
  if (/\.(pem|key|p12|pfx|keystore)$/i.test(base)) return true;
  if (/(^|[\/\\])(?:private|secret|secrets|mnemonic|seed|wallet|keypair|keystore|api[-_]?key|access[-_]?key)(?:[\/\\._-]|$)/i.test(r)) return true;
  return false;
}

function isExcludedScanPath(filePath) {
  const r = rel(filePath).toLowerCase();
  const base = path.basename(filePath).toLowerCase();
  if (r === OUT_JSON_REL.toLowerCase() || r === OUT_MD_REL.toLowerCase()) return true;
  if (r === "tools/scan-eigencloud-full-test.js") return true;
  if (isSecretLikePath(filePath)) return true;
  if (base.includes("endpoint")) return true;
  if (r.includes("/node_modules/") || r.includes("/.git/")) return true;
  if (r.includes("/cache/") || r.includes("/out/") || r.includes("/broadcast/") || r.includes("/artifacts/")) return true;
  if (r.startsWith(".opencode/") || r.startsWith("coordination/")) return true;
  if (/(?:handoff|shared_context|state\.md|audit-completion-gates|route-positive-sweep|low-fund-executable-route-filter|exploit-findings-summary|full-test)/i.test(r)) return true;
  return false;
}

function isUnsafeSampleText(text) {
  const raw = String(text || "");
  return /\b(?:rpc_endpoints\.txt|graphql_endpoints\.txt|private[-_]?key|secret[-_]?key|mnemonic|seed\s+phrase|bearer\s+|authorization\s*[:=]|password\s*[:=]|pwd\s*[:=])\b/i.test(raw);
}

function readText(filePath) {
  try {
    if (isSecretLikePath(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    return fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  } catch (_error) {
    return null;
  }
}

function readJson(filePath) {
  const text = readText(filePath);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_error) {
    return null;
  }
}

function writeJson(filePath, value) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, jsonReplacer, 2)}\n`, "utf8");
}

function writeText(filePath, value) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, value, "utf8");
}

function listFilesRecursive(rootDir) {
  const out = [];
  if (!fs.existsSync(rootDir)) return out;
  function walk(dir) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_error) {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (/^(?:node_modules|\.git|cache|out|broadcast|artifacts|lib)$/i.test(entry.name)) continue;
        if (rel(full).toLowerCase().startsWith("coordination/")) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!/\.(json|md|txt|js|ts|sol|yaml|yml|toml|csv)$/i.test(entry.name)) continue;
      if (isExcludedScanPath(full)) continue;
      out.push(full);
    }
  }
  walk(rootDir);
  return out;
}

function listToolFiles() {
  const toolDir = path.join(WORKSPACE, "tools");
  const files = listFilesRecursive(toolDir);
  return files.filter((file) => /(?:^|[\\/])(?:scan-)?eigenlayer-.*\.js$/i.test(file) || /(?:^|[\\/])frontier-restaking-eigenlayer\.js$/i.test(file));
}

function listScanFiles() {
  const files = [];
  const priorityFiles = ["targets/eigenlayer-contracts/README.md"];
  for (const file of priorityFiles) {
    const full = path.join(WORKSPACE, file);
    if (fs.existsSync(full) && !isExcludedScanPath(full)) files.push(full);
  }
  for (const root of SOURCE_ROOTS) files.push(...listFilesRecursive(path.join(WORKSPACE, root)));
  for (const file of EXPLICIT_FILES) {
    if (priorityFiles.includes(file)) continue;
    const full = path.join(WORKSPACE, file);
    if (fs.existsSync(full) && !isExcludedScanPath(full)) files.push(full);
  }
  files.push(...listToolFiles());
  return uniqBy(files, (file) => path.resolve(file));
}

function firstRuleMatch(text, rules) {
  const raw = String(text || "");
  for (const rule of rules) {
    rule.regex.lastIndex = 0;
    if (rule.regex.test(raw)) return rule;
  }
  return null;
}

function hasRuleMatch(text, rules) {
  return Boolean(firstRuleMatch(text, rules));
}

function matchForText(line, windowText, fileHasExact) {
  const exact = firstRuleMatch(line, EXACT_RULES) || firstRuleMatch(windowText, EXACT_RULES);
  if (exact) return { matchType: "exact-name-address-token-module", matched: exact.label, termType: "text" };
  const context = firstRuleMatch(line, CONTEXT_RULES) || firstRuleMatch(windowText, CONTEXT_RULES);
  if (!context) return null;
  if (fileHasExact || hasRuleMatch(windowText, EXACT_RULES)) return { matchType: "context", matched: context.label, termType: "text" };
  return null;
}

function categoriesFor(text, filePath = "") {
  const hay = `${filePath} ${String(text || "")}`.toLowerCase();
  const categories = [];
  for (const [category, terms] of Object.entries(CATEGORY_RULES)) {
    if (terms.some((term) => hay.includes(term.toLowerCase()))) categories.push(category);
  }
  return categories.length ? categories : ["context"];
}

function countOccurrences(text, term) {
  if (!text || !term) return 0;
  let count = 0;
  let cursor = 0;
  const hay = String(text).toLowerCase();
  const needle = String(term).toLowerCase();
  while (needle && cursor <= hay.length) {
    const pos = hay.indexOf(needle, cursor);
    if (pos < 0) break;
    count += 1;
    cursor = pos + Math.max(needle.length, 1);
  }
  return count;
}

function classificationForRow(file, match, categories, routeValue) {
  const r = rel(file).toLowerCase();
  if (routeValue === true || routeValue === "local-row-true-untrusted-not-promoted") return "prior-positive-or-watch-signal-not-promoted-without-current-exact-economics";
  if (r.includes("eigenlayer-lrt-nav-dex-divergence")) return "prior-lrt-nav-dex-watch-context-not-current-route-positive";
  if (r.includes("eigenlayer-phase1-triage")) return "prior-eigenlayer-watch-context-not-current-route-positive";
  if (categories.includes("oracleConsumer") || categories.includes("dexExit") || categories.includes("highLtvCollateral")) return "consumer-or-exit-context-only-no-positive-economics";
  return match.matchType === "exact-name-address-token-module" ? "exact-local-watch-context-only-no-current-positive-economics" : "local-artifact-watch-context-only-no-route-positive";
}

function scanLocalArtifactLines(files) {
  const rows = [];
  let filesScanned = 0;
  let filesWithMatch = 0;
  let filesWithExact = 0;
  const categoryCounts = {};
  for (const file of files) {
    const text = readText(file);
    if (!text) continue;
    filesScanned += 1;
    const fileHasExact = hasRuleMatch(text, EXACT_RULES);
    if (!fileHasExact && !hasRuleMatch(text, CONTEXT_RULES)) continue;
    const lines = text.split(/\r?\n/);
    let sampled = 0;
    let fileMatched = false;
    let fileExact = false;
    const seen = new Set();
    for (let i = 0; i < lines.length && rows.length < MAX_LOCAL_MATCH_ROWS && sampled < MAX_ROWS_PER_FILE; i += 1) {
      const line = String(lines[i] || "");
      if (!line.trim()) continue;
      const windowText = [lines[i - 2], lines[i - 1], lines[i], lines[i + 1], lines[i + 2]].map((x) => String(x || "")).join(" ");
      if (isUnsafeSampleText(line) || isUnsafeSampleText(windowText)) continue;
      const match = matchForText(line, windowText, fileHasExact);
      if (!match) continue;
      const key = `${rel(file)}:${i + 1}:${match.matchType}:${match.matched}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fileMatched = true;
      if (match.matchType === "exact-name-address-token-module") fileExact = true;
      const categories = categoriesFor(windowText, rel(file));
      for (const category of categories) categoryCounts[category] = (categoryCounts[category] || 0) + 1;
      rows.push({
        rowSource: "line-scan",
        file: rel(file),
        line: i + 1,
        matchType: match.matchType,
        termType: match.termType,
        matched: sanitizeText(match.matched, 120),
        count: countOccurrences(line, match.matched),
        categories,
        sample: sanitizeText(windowText, 460),
        routePositive: 0,
        classification: classificationForRow(file, match, categories, false),
      });
      sampled += 1;
    }
    if (fileMatched) filesWithMatch += 1;
    if (fileExact) filesWithExact += 1;
    if (rows.length >= MAX_LOCAL_MATCH_ROWS) break;
  }
  return { filesScanned, filesWithMatch, filesWithExact, rows, exactRows: rows.filter((row) => row.matchType === "exact-name-address-token-module"), categoryCounts };
}

function shouldSkipJsonKey(key) {
  return /(url|uri|endpoint|hostname|host|domain|rpc|graphql|env|secret|password|private|api[-_]?key|access[-_]?key|auth|bearer|cookie|header)/i.test(String(key || ""));
}

function compactValue(value) {
  if (value === null || value === undefined) return null;
  if (["string", "number", "boolean"].includes(typeof value)) return typeof value === "string" ? sanitizeText(value, 240) : value;
  if (Array.isArray(value)) return value.slice(0, 14).map((item) => compactValue(item)).filter((item) => item !== null);
  if (isObject(value)) {
    const out = {};
    for (const [key, val] of Object.entries(value).slice(0, 18)) {
      if (shouldSkipJsonKey(key)) continue;
      const compacted = compactValue(val);
      if (compacted !== null && !(Array.isArray(compacted) && compacted.length === 0)) out[key] = compacted;
    }
    return out;
  }
  return sanitizeText(String(value), 240);
}

function extractFields(value) {
  const fields = {};
  if (!isObject(value)) return fields;
  for (const field of JSON_FIELD_ALLOWLIST) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) continue;
    if (shouldSkipJsonKey(field)) continue;
    const compacted = compactValue(value[field]);
    if (compacted !== null && !(Array.isArray(compacted) && compacted.length === 0)) fields[field] = compacted;
  }
  if (isObject(value.adapter)) {
    fields.adapterModule = compactValue(value.adapter.module);
    fields.adapterFetched = compactValue(value.adapter.adapterFetched);
    fields.adapterAddressCount = compactValue(value.adapter.adapterAddressCount);
    fields.adapterHints = compactValue(value.adapter.adapterHints);
    fields.adapterAddressSamples = compactValue(value.adapter.adapterAddressSamples);
  }
  if (isObject(value.routeGate)) {
    fields.routeGateStatus = compactValue(value.routeGate.status);
    fields.exactEconomicsPositive = compactValue(value.routeGate.exactEconomicsPositive);
    fields.forkProof = compactValue(value.routeGate.forkProof);
  }
  return fields;
}

function fieldsContext(fields) {
  const parts = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    const rendered = typeof value === "object" ? JSON.stringify(value, jsonReplacer).slice(0, 190) : String(value);
    parts.push(`${key}=${rendered}`);
  }
  return sanitizeText(parts.join("; "), 560);
}

function primitiveBlob(value, jsonPath) {
  const parts = [jsonPath];
  if (!isObject(value)) return parts.join(" ");
  for (const [key, val] of Object.entries(value)) {
    if (shouldSkipJsonKey(key)) continue;
    if (val === null || val === undefined) continue;
    if (["string", "number", "boolean"].includes(typeof val)) parts.push(key, String(val));
    else if (Array.isArray(val) && val.every((item) => item === null || ["string", "number", "boolean"].includes(typeof item))) {
      parts.push(key, val.slice(0, 18).join(" "));
    }
  }
  return parts.join(" ");
}

function scanLocalJsonObjects(files) {
  const rows = [];
  let jsonFilesParsed = 0;
  const categoryCounts = {};
  const seen = new Set();
  function visit(value, file, jsonPath, depth) {
    if (rows.length >= MAX_LOCAL_OBJECT_ROWS || depth > MAX_JSON_DEPTH) return;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length && rows.length < MAX_LOCAL_OBJECT_ROWS; i += 1) visit(value[i], file, `${jsonPath}[${i}]`, depth + 1);
      return;
    }
    if (!isObject(value)) return;
    const blob = primitiveBlob(value, jsonPath);
    const fields = extractFields(value);
    const context = fieldsContext(fields) || sanitizeText(blob, 460);
    if (isUnsafeSampleText(blob) || isUnsafeSampleText(context)) return;
    const objectHasExact = hasRuleMatch(`${blob} ${context || ""}`, EXACT_RULES);
    const match = objectHasExact ? matchForText(blob, `${blob} ${context || ""}`, true) : null;
    if (match && context) {
      const categories = categoriesFor(`${blob} ${context}`, rel(file));
      const key = `${rel(file)}:${jsonPath}:${match.matchType}:${match.matched}`;
      if (!seen.has(key)) {
        seen.add(key);
        for (const category of categories) categoryCounts[category] = (categoryCounts[category] || 0) + 1;
        const sourceRoutePositive = value.routePositive === true ? true : (value.routePositive || 0);
        const routeValue = value.routePositive === true ? "local-row-true-untrusted-not-promoted" : (value.routePositive ?? 0);
        rows.push({
          rowSource: "json-object-scan",
          file: rel(file),
          jsonPath,
          matchType: match.matchType,
          termType: match.termType,
          matched: sanitizeText(match.matched, 120),
          categories,
          fields,
          context,
          sourceRoutePositive,
          routePositive: 0,
          sourceRoutePositiveNotPromoted: routeValue === "local-row-true-untrusted-not-promoted",
          classification: classificationForRow(file, match, categories, routeValue),
        });
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (shouldSkipJsonKey(key)) continue;
      if (isObject(child) || Array.isArray(child)) visit(child, file, `${jsonPath}.${key}`, depth + 1);
      if (rows.length >= MAX_LOCAL_OBJECT_ROWS) break;
    }
  }
  for (const file of files) {
    if (!/\.json$/i.test(file)) continue;
    const text = readText(file);
    if (!text || !hasRuleMatch(text, EXACT_RULES)) continue;
    const json = readJson(file);
    if (json === null) continue;
    jsonFilesParsed += 1;
    visit(json, file, "$", 0);
    if (rows.length >= MAX_LOCAL_OBJECT_ROWS) break;
  }
  return { jsonFilesParsed, rows, exactRows: rows.filter((row) => exactish(row)), categoryCounts };
}

function exactish(row) {
  return row.matchType === "exact-name-address-token-module";
}

function sourceForRow(row) {
  if (row.line) return `${row.file}:${row.line}`;
  return `${row.file}:${row.jsonPath || "$"}`;
}

function mergeCategoryCounts(...countMaps) {
  const out = {};
  for (const map of countMaps) {
    for (const [key, value] of Object.entries(map || {})) out[key] = (out[key] || 0) + value;
  }
  return out;
}

function selectNotableRows(rows) {
  const exact = rows.filter(exactish);
  const highSignal = rows.filter((row) => row.categories.some((cat) => ["strategyShareAccounting", "withdrawalQueue", "slashingAllocation", "eigenpodNativeEth", "rewards", "bridgeCustody", "oracleConsumer", "dexExit", "highLtvCollateral", "lrtNavDexDivergence"].includes(cat)));
  return uniqBy([...exact, ...highSignal], (row) => `${sourceForRow(row)}:${row.matchType}:${row.matched}`).slice(0, 32);
}

function rowText(row) {
  return `${row.file || ""} ${row.matched || ""} ${row.context || ""} ${row.sample || ""} ${fieldsContext(row.fields || {}) || ""}`;
}

function buildTokenReferences(rows) {
  const tokenRows = [];
  const byToken = {};
  for (const token of LRT_TOKENS) byToken[token] = { exactConsumerRows: 0, contextualRows: 0, totalRows: 0 };
  for (const row of rows) {
    const text = rowText(row);
    for (const token of LRT_TOKENS) {
      const regex = new RegExp(`\\b${escapeRegExp(token)}\\b`, "i");
      if (!regex.test(text)) continue;
      const consumerish = row.categories.some((cat) => ["oracleConsumer", "dexExit", "highLtvCollateral", "lrtNavDexDivergence", "redeemWithdraw", "economics"].includes(cat));
      const sourceRoutePositive = row.sourceRoutePositive === true || row.sourceRoutePositiveNotPromoted === true || /routePositive[=:]true/i.test(text);
      const ref = {
        token,
        source: sourceForRow(row),
        referenceType: consumerish ? "exact-local-consumer-or-exit-reference" : "contextual-local-reference",
        categories: row.categories,
        matched: row.matched,
        detail: row.context || row.sample || fieldsContext(row.fields || {}) || "context-only",
        routePositive: 0,
        sourceRoutePositiveNotPromoted: Boolean(sourceRoutePositive),
        classification: sourceRoutePositive
          ? "prior-positive-watch-signal-not-promoted-without-current-exact-economics"
          : (consumerish ? "exact-token-consumer-context-no-current-positive-economics" : "token-context-only-no-route-positive"),
      };
      tokenRows.push(ref);
      byToken[token].totalRows += 1;
      if (consumerish) byToken[token].exactConsumerRows += 1;
      else byToken[token].contextualRows += 1;
    }
  }
  return finalizeTokenRefs(tokenRows, byToken);
}

function finalizeTokenRefs(tokenRows, byToken) {
  const unique = uniqBy(tokenRows, (row) => `${row.token}:${row.source}:${row.referenceType}`);
  const exact = unique.filter((row) => row.referenceType === "exact-local-consumer-or-exit-reference");
  const contextual = unique.filter((row) => row.referenceType === "contextual-local-reference");
  const rows = uniqBy([...exact.slice(0, 170), ...contextual.slice(0, 70), ...unique], (row) => `${row.token}:${row.source}:${row.referenceType}`).slice(0, MAX_TOKEN_ROWS);
  return {
    rows,
    exactConsumerRows: rows.filter((row) => row.referenceType === "exact-local-consumer-or-exit-reference"),
    contextualRows: rows.filter((row) => row.referenceType === "contextual-local-reference"),
    byToken,
  };
}

function countRoutePositiveTruths(value) {
  let count = 0;
  function visit(node, depth) {
    if (depth > MAX_JSON_DEPTH + 4 || node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth + 1);
      return;
    }
    if (!isObject(node)) return;
    if (node.routePositive === true) count += 1;
    for (const [key, child] of Object.entries(node)) {
      if (shouldSkipJsonKey(key)) continue;
      if (isObject(child) || Array.isArray(child)) visit(child, depth + 1);
    }
  }
  visit(value, 0);
  return count;
}

function priorRouteSignalsNotPromoted() {
  const priorJsonFiles = [
    "reports/raw/fast/eigenlayer-lrt-nav-dex-divergence.json",
    "reports/raw/fast/eigenlayer-slashing-rehypothecation.json",
  ];
  let count = 0;
  for (const file of priorJsonFiles) {
    const full = path.join(WORKSPACE, file);
    const json = readJson(full);
    if (json !== null) count += countRoutePositiveTruths(json);
  }
  return count;
}

function buildPayload({ lineScan, objectScan }) {
  const combinedRows = uniqBy([...objectScan.rows, ...lineScan.rows], (row) => `${sourceForRow(row)}:${row.matchType}:${row.matched}:${row.rowSource}`);
  const exactRows = combinedRows.filter(exactish);
  const categoryRows = {};
  for (const category of Object.keys(CATEGORY_RULES)) categoryRows[`${category}Rows`] = pickRows(combinedRows, (row) => row.categories.includes(category), 150);
  const consumerJoinRows = pickRows(combinedRows, (row) => row.categories.some((cat) => ["oracleConsumer", "highLtvCollateral", "dexExit", "lrtNavDexDivergence"].includes(cat)), 180);
  const exactConsumerJoinRows = pickRows(consumerJoinRows, exactish, 140);
  const tokenReferences = buildTokenReferences(combinedRows);
  const notableRows = selectNotableRows(combinedRows);
  const priorArtifactPositiveRowsNotPromoted = combinedRows.filter((row) => row.sourceRoutePositiveNotPromoted).length + tokenReferences.rows.filter((row) => row.sourceRoutePositiveNotPromoted).length + priorRouteSignalsNotPromoted();
  const exactEconomicsRows = 0;
  const routePositive = 0;
  const executableNow = 0;
  const signedActionJustified = false;
  const forkJustified = false;
  const forkGate = "closed-route-positive-zero";

  const summary = {
    sourceFactRows: SOURCE_FACTS.length,
    chainSeedRows: CHAIN_SEEDS.length,
    deploymentRows: DEPLOYMENT_ROWS.length,
    surfaceRows: SURFACE_ROWS.length,
    filesScanned: lineScan.filesScanned,
    filesWithLocalMatches: lineScan.filesWithMatch,
    filesWithExactLocalMatches: lineScan.filesWithExact,
    jsonFilesParsed: objectScan.jsonFilesParsed,
    localArtifactMatchRows: combinedRows.length,
    exactLocalArtifactMatchRows: exactRows.length,
    localLineRows: lineScan.rows.length,
    localObjectRows: objectScan.rows.length,
    exactLocalObjectRows: objectScan.exactRows.length,
    strategyShareAccountingRows: categoryRows.strategyShareAccountingRows.length,
    delegationRows: categoryRows.delegationRows.length,
    withdrawalQueueRows: categoryRows.withdrawalQueueRows.length,
    slashingAllocationRows: categoryRows.slashingAllocationRows.length,
    eigenpodNativeEthRows: categoryRows.eigenpodNativeEthRows.length,
    rewardsRows: categoryRows.rewardsRows.length,
    bridgeCustodyRows: categoryRows.bridgeCustodyRows.length,
    redeemWithdrawRows: categoryRows.redeemWithdrawRows.length,
    oracleConsumerRows: categoryRows.oracleConsumerRows.length,
    dexExitRows: categoryRows.dexExitRows.length,
    highLtvCollateralRows: categoryRows.highLtvCollateralRows.length,
    lrtNavDexDivergenceRows: categoryRows.lrtNavDexDivergenceRows.length,
    economicsContextRows: categoryRows.economicsRows.length,
    consumerJoinRows: consumerJoinRows.length,
    exactConsumerJoinRows: exactConsumerJoinRows.length,
    tokenReferenceRows: tokenReferences.rows.length,
    exactTokenConsumerReferenceRows: tokenReferences.exactConsumerRows.length,
    contextualTokenReferenceRows: tokenReferences.contextualRows.length,
    priorArtifactPositiveRowsNotPromoted,
    publicFetchRows: 0,
    rpcInventoryRows: 0,
    graphqlInventoryRows: 0,
    ethCallRows: 0,
    forkRows: 0,
    exactEconomicsRows,
    routePositive,
    executableNow,
    signedActionJustified,
    forkJustified,
    forkGate,
  };

  return {
    generatedAt: GENERATED_AT,
    deterministicOutput: true,
    scanner: "tools/scan-eigencloud-full-test.js",
    target: TARGET,
    scope: {
      kind: "bounded defensive/read-only full-test scanner",
      artifactStaticLocalFirst: true,
      evmFirst: true,
      evmFirstChains: CHAIN_SEEDS.filter((row) => row.evmFirst).map((row) => row.chainLabel),
      caveatChains: [],
      routeGraph: TARGET.routeGraph,
      writesLimitedTo: [OUT_JSON_REL, OUT_MD_REL],
      coordinatorClaim: "fixer-eigencloud-fulltest-01",
      aggregatePromotionStateHandoffEdited: false,
      endpointPolicy: "No endpoint inventory was read; no raw endpoints, domains, keys, or tokens are persisted.",
    },
    safety: {
      localArtifactsRead: true,
      publicStaticLabelsUsed: true,
      publicNetworkFetch: false,
      endpointInventoryRead: false,
      rpcInventoryRead: false,
      rpcInventoryRows: 0,
      graphqlInventoryRead: false,
      graphqlInventoryRows: 0,
      envFilesRead: false,
      privateKeyEnvRead: false,
      privateKeysRead: false,
      keyFilesRead: false,
      keyMaterialRead: false,
      pemFilesRead: false,
      keypairJsonRead: false,
      rawEndpointUrlsStored: false,
      rpcUrlsStored: false,
      graphqlUrlsStored: false,
      rawUrlsStored: false,
      rawDomainsStored: false,
      rawKeysTokensStored: false,
      signedActions: false,
      liveTransactions: false,
      broadcasts: false,
      walletOperations: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      ethCallOnly: false,
      sanitizedOutputOnly: true,
      secretLikePathsExcluded: true,
    },
    sourceFacts: SOURCE_FACTS,
    discoveredSeeds: { chainSeeds: CHAIN_SEEDS, deploymentRows: DEPLOYMENT_ROWS, surfaceRows: SURFACE_ROWS },
    localArtifacts: {
      filesScanned: lineScan.filesScanned,
      filesWithMatch: lineScan.filesWithMatch,
      filesWithExact: lineScan.filesWithExact,
      jsonFilesParsed: objectScan.jsonFilesParsed,
      categoryCounts: mergeCategoryCounts(lineScan.categoryCounts, objectScan.categoryCounts),
      rows: combinedRows,
      exactRows: exactRows.slice(0, 180),
      notableRows,
    },
    categoryRows: { ...categoryRows, consumerJoinRows, exactConsumerJoinRows },
    tokenConsumerReferences: tokenReferences,
    priorEigenLayerContext: {
      artifacts: ["reports/eigenlayer-audit-plan.md", "reports/eigenlayer-phase1-triage.md", "reports/raw/fast/eigenlayer-lrt-nav-dex-divergence.json", "reports/raw/fast/eigenlayer-slashing-rehypothecation.json"],
      routeSignalsNotPromoted: priorArtifactPositiveRowsNotPromoted,
      exactEconomicsRowsPromoted: 0,
      classification: "prior-context-only-current-route-gate-fail-closed",
    },
    routeGate: {
      routePositive,
      executableNow,
      signedActionJustified,
      forkJustified,
      forkGate,
      exactPermissionlessValueMovement: false,
      exactPositiveEconomics: false,
      localForkStaticProof: false,
      exactEconomicsRows,
      status: "dormant-fail-closed",
      reason: "Static/local scan found deployment/source/consumer/LRT context rows only; no current exact permissionless value movement, positive economics, or local/fork/static value-delta proof is present.",
    },
    blockers: BLOCKERS,
    requiredForRoutePositive: REQUIRED_FOR_ROUTE_POSITIVE,
    nextReadOnlyStep: NEXT_READ_ONLY_STEP,
    summary,
  };
}

function metricRows(summary) {
  const keys = [
    "sourceFactRows", "chainSeedRows", "deploymentRows", "surfaceRows", "filesScanned", "filesWithLocalMatches", "filesWithExactLocalMatches", "jsonFilesParsed", "localArtifactMatchRows", "exactLocalArtifactMatchRows", "localLineRows", "localObjectRows", "strategyShareAccountingRows", "delegationRows", "withdrawalQueueRows", "slashingAllocationRows", "eigenpodNativeEthRows", "rewardsRows", "bridgeCustodyRows", "redeemWithdrawRows", "oracleConsumerRows", "dexExitRows", "highLtvCollateralRows", "lrtNavDexDivergenceRows", "consumerJoinRows", "exactConsumerJoinRows", "tokenReferenceRows", "exactTokenConsumerReferenceRows", "contextualTokenReferenceRows", "priorArtifactPositiveRowsNotPromoted", "publicFetchRows", "rpcInventoryRows", "graphqlInventoryRows", "ethCallRows", "forkRows", "exactEconomicsRows", "routePositive", "executableNow", "signedActionJustified", "forkJustified", "forkGate",
  ];
  return keys.map((key) => `| ${key} | ${mdEscape(summary[key])} |`).join("\n");
}

function safetyRows(safety) {
  const keys = [
    "localArtifactsRead", "publicStaticLabelsUsed", "publicNetworkFetch", "endpointInventoryRead", "rpcInventoryRead", "graphqlInventoryRead", "envFilesRead", "privateKeyEnvRead", "privateKeysRead", "keyFilesRead", "keyMaterialRead", "pemFilesRead", "keypairJsonRead", "rawEndpointUrlsStored", "rpcUrlsStored", "graphqlUrlsStored", "rawUrlsStored", "rawDomainsStored", "rawKeysTokensStored", "signedActions", "liveTransactions", "broadcasts", "walletOperations", "forkTransactions", "ethCallOnly", "sanitizedOutputOnly", "secretLikePathsExcluded",
  ];
  return keys.map((key) => `| ${key} | ${mdEscape(safety[key])} |`).join("\n");
}

function formatLocalRow(row) {
  const categories = (row.categories || []).join(",");
  const detail = row.context || row.sample || fieldsContext(row.fields || {}) || "context-only";
  return `| ${mdEscape(sourceForRow(row))} | ${mdEscape(categories)} | ${mdEscape(row.matched)} | ${mdEscape(detail)} | ${mdEscape(row.routePositive)} | ${mdEscape(row.classification)} |`;
}

function formatDeploymentRow(row) {
  return `| ${mdEscape(row.role)} | ${mdEscape(row.chain)} | ${mdEscape(row.assetSymbol || "-")} | ${mdEscape(row.address)} | ${mdEscape(row.surface)} | ${mdEscape(row.classification)} |`;
}

function formatSurfaceRow(row) {
  return `| ${mdEscape(row.component)} | ${mdEscape(row.surface)} | ${mdEscape(row.routeRole)} | ${mdEscape((row.watchTerms || []).join(", "))} |`;
}

function formatTokenRow(row) {
  return `| ${mdEscape(row.token)} | ${mdEscape(row.referenceType)} | ${mdEscape(row.source)} | ${mdEscape((row.categories || []).join(","))} | ${mdEscape(row.detail)} | ${mdEscape(row.classification)} |`;
}

function buildMarkdown(payload) {
  const notableRows = payload.localArtifacts.notableRows.length
    ? payload.localArtifacts.notableRows.map(formatLocalRow).join("\n")
    : "| (none) | n/a | n/a | no local context rows found | 0 | dormant |";
  const deploymentRows = payload.discoveredSeeds.deploymentRows.slice(0, 22).map(formatDeploymentRow).join("\n");
  const surfaceRows = payload.discoveredSeeds.surfaceRows.map(formatSurfaceRow).join("\n");
  const tokenRows = payload.tokenConsumerReferences.rows.length
    ? payload.tokenConsumerReferences.rows.slice(0, 22).map(formatTokenRow).join("\n")
    : "| (none) | n/a | n/a | n/a | no token consumer refs sampled | token-context-only |";

  return `# 🟢 DORMANT - EigenCloud Full Test

Generated: ${payload.generatedAt}

Route remains closed: routePositive=${payload.routeGate.routePositive}, executableNow=${payload.routeGate.executableNow}, signedActionJustified=${payload.routeGate.signedActionJustified}, forkJustified=${payload.routeGate.forkJustified}, forkGate=${payload.routeGate.forkGate}.

## Summary

| Metric | Value |
|---|---:|
${metricRows(payload.summary)}

## Target / Scope

- Target: ${payload.target.name} (${payload.target.slug}), category=${payload.target.category}, surface=${payload.target.surface}, module=${payload.target.module}, rank≈${payload.target.discoveryRank}, TVL context≈${payload.target.tvlContext}.
- EVM-first chain: ${payload.scope.evmFirstChains.join(", ")}; caveat chains: ${payload.scope.caveatChains.join(", ") || "none"}.
- Route graph: ${payload.target.routeGraph}.
- Adapter context: adapterFetched=${payload.target.adapterFetched}, adapterAddressCount=${payload.target.adapterAddressCount}, hints=${payload.target.adapterHints.join(", ")}.
- Writes limited to: ${payload.scope.writesLimitedTo.join(", ")}.
- Coordinator claim: ${payload.scope.coordinatorClaim}; aggregate/state/shared-context/handoff files edited=false.

## Safety

| Field | Value |
|---|---:|
${safetyRows(payload.safety)}

## Deployment / Address Rows (static, not live state proof)

| Role | Chain | Asset | Address | Surface | Classification |
|---|---|---|---|---|---|
${deploymentRows}

## Surface Rows

| Component | Surface | Route Role | Watch Terms |
|---|---|---|---|
${surfaceRows}

## Notable Local Rows (watch/context only)

| Source | Categories | Match | Detail | Route | Classification |
|---|---|---|---|---:|---|
${notableRows}

## Local LRT / EigenLayer Token Consumer References

Exact token/consumer rows are still context-only; prior positive-looking rows are not promoted without current exact economics.

| Token | Reference Type | Source | Categories | Detail | Classification |
|---|---|---|---|---|---|
${tokenRows}

## Route Gate

- Status: ${payload.routeGate.status}.
- Required fail-closed conjunction is absent: exactPermissionlessValueMovement=${payload.routeGate.exactPermissionlessValueMovement}, exactPositiveEconomics=${payload.routeGate.exactPositiveEconomics}, localForkStaticProof=${payload.routeGate.localForkStaticProof}.
- Prior EigenLayer artifacts included as context only: routeSignalsNotPromoted=${payload.priorEigenLayerContext.routeSignalsNotPromoted}; exactEconomicsRowsPromoted=0.
- Fork gate: ${payload.routeGate.forkGate}.

## Blockers

${payload.blockers.map((item) => `- ${item}`).join("\n")}

## Required For RoutePositive

${payload.requiredForRoutePositive.map((item) => `- ${item}`).join("\n")}

## Next Read-Only Step

${payload.nextReadOnlyStep}
`;
}

function main() {
  log("Scanning EigenCloud/EigenLayer local artifacts (sanitized, no endpoint inventory read)...");
  const files = listScanFiles();
  const lineScan = scanLocalArtifactLines(files);
  const objectScan = scanLocalJsonObjects(files);
  const payload = buildPayload({ lineScan, objectScan });
  writeJson(OUT_JSON, payload);
  writeText(OUT_MD, buildMarkdown(payload));
  log(`Wrote ${OUT_JSON_REL} and ${OUT_MD_REL}`);
  log(`routePositive=${payload.summary.routePositive}; exactEconomicsRows=${payload.summary.exactEconomicsRows}; localArtifactMatchRows=${payload.summary.localArtifactMatchRows}; exactTokenConsumerReferenceRows=${payload.summary.exactTokenConsumerReferenceRows}`);
}

main();
