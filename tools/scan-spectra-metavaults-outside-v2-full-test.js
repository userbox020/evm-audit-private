#!/usr/bin/env node
"use strict";

// scan-spectra-metavaults-outside-v2-full-test.js
// Defensive Spectra MetaVaults Outside V2 full-test scanner. Deterministic
// local/static/public-context only; no endpoint inventory reads, network calls,
// RPC, forks, signed actions, broadcasts, or wallets.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const REPORTS_DIR = path.join(WORKSPACE, "reports");
const OUT_JSON = path.join(RAW_DIR, "spectra-metavaults-outside-v2-full-test.json");
const OUT_MD = path.join(REPORTS_DIR, "spectra-metavaults-outside-v2-full-test-triage.md");
const OUT_JSON_REL = "reports/raw/fast/spectra-metavaults-outside-v2-full-test.json";
const OUT_MD_REL = "reports/spectra-metavaults-outside-v2-full-test-triage.md";

const QUIET = process.argv.includes("--quiet");
const GENERATED_AT = process.env.SCAN_GENERATED_AT || "2026-07-07T00:00:00.000Z";

const MAX_FILE_BYTES = 24 * 1024 * 1024;
const MAX_LOCAL_MATCH_ROWS = 760;
const MAX_ROWS_PER_FILE = 36;

const TARGET = {
  slug: "spectra-metavaults-outside-v2",
  name: "Spectra MetaVaults Outside V2",
  kind: "protocol",
  category: "Onchain Capital Allocator",
  surface: "vault-yield-allocator",
  tvlContextUsdLow: 10_080_000,
  tvlContextUsdHigh: 10_213_934,
  tvlContext: "$10.08M-$10.21M",
  primaryChains: ["Base", "Arbitrum", "Ethereum", "Avalanche"],
  caveatChains: ["Flare", "Katana"],
  routeGraph: "vault share -> rate/strategy accounting -> consumer or exit venue -> borrow/redeem/unwind",
  module: "spectra-metavaults/index.js",
  adapterFetched: true,
  adapterAddressCount: 6,
  adapterHints: ["ERC4626", "oracle", "bridge-custody"],
  coordinatorClaim: "coordinator-spectra-metavaults-fulltest-01",
};

const CHAIN_SEEDS = [
  { chain: "Base", chainLabel: "Base", chainId: 8453, adapterKey: "base", evmFirst: true, caveat: false, classification: "primary-evm-first-chain" },
  { chain: "Arbitrum", chainLabel: "Arbitrum", chainId: 42161, adapterKey: "arbitrum", evmFirst: true, caveat: false, classification: "primary-evm-first-chain" },
  { chain: "Ethereum", chainLabel: "Ethereum", chainId: 1, adapterKey: "ethereum", evmFirst: true, caveat: false, classification: "primary-evm-first-chain" },
  { chain: "Avalanche", chainLabel: "Avalanche", chainId: 43114, adapterKey: "avax", evmFirst: true, caveat: false, classification: "primary-evm-first-chain" },
  { chain: "Flare", chainLabel: "Flare", chainId: 14, adapterKey: "flare", evmFirst: true, caveat: true, classification: "caveat-chain-no-new-endpoint-read" },
  { chain: "Katana", chainLabel: "Katana", chainId: 747474, adapterKey: "katana", evmFirst: true, caveat: true, classification: "caveat-chain-no-new-endpoint-read" },
];

const REGISTRY_ROWS = [
  { role: "MetaVault registry/factory", chain: "Ethereum", address: "0x16b28223b607b4d90e2ec628fdc1a0ad9ee1f6b8", surface: "adapter registry address", classification: "adapter-static-address-not-live-state-proof" },
  { role: "MetaVault registry/factory", chain: "Arbitrum", address: "0xa355dd06f35bcfe98e45f743397b729b93c560be", surface: "adapter registry address", classification: "adapter-static-address-not-live-state-proof" },
  { role: "MetaVault registry/factory", chain: "Base", address: "0xa2c9da26c1982cacaf01c5c691e0cf0aeb031ac1", surface: "adapter registry address", classification: "adapter-static-address-not-live-state-proof" },
  { role: "MetaVault registry/factory", chain: "Avalanche", address: "0xacf33983cab5f9e914e6a93a2f4d531b5c516602", surface: "adapter registry address", classification: "adapter-static-address-not-live-state-proof" },
  { role: "MetaVault registry/factory", chain: "Katana", address: "0x191ea03cccc27546ba9f5161b4948b6afce5263f", surface: "adapter registry address", classification: "caveat-chain-static-address-not-live-state-proof" },
  { role: "MetaVault registry/factory", chain: "Flare", address: "0x2154a519d08bfd3f6e0303fd3ac0511c58424bbe", surface: "adapter registry address", classification: "caveat-chain-static-address-not-live-state-proof" },
];

const BASE_METAVAULT_ROWS = [
  { role: "smvUSDC vault", chain: "Base", address: "0x3878e834246dc1d081b852fa3c6d5d26509b4efa", symbol: "smvUSDC", surface: "public API sample vault", classification: "public-static-vault-sample-not-live-state-proof" },
  { role: "smvUSDC wrapper", chain: "Base", address: "0x81fcec19f92da474fc30bbec6747f6d23a104955", symbol: "smvUSDC", surface: "wrapper", classification: "public-static-wrapper-sample-not-live-state-proof" },
  { role: "smvUSDC infra vault", chain: "Base", address: "0x74782ba2fc346d5470072a89b7374bf5563f1c27", symbol: "smvUSDC", surface: "infra vault", classification: "public-static-infra-sample-not-live-state-proof" },
  { role: "Base USDC underlying", chain: "Base", address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", symbol: "USDC", surface: "single ERC20 underlying", classification: "public-static-underlying-sample-not-live-state-proof" },
  { role: "gamisUSDC vault", chain: "Base", address: "0x5e93e1193a5e297cba0856e9b3f22b6e05429b9a", symbol: "gamisUSDC", surface: "public API sample vault", classification: "public-static-vault-sample-not-live-state-proof" },
  { role: "gamisUSDC wrapper", chain: "Base", address: "0x776f95321a0285f8bcde149e3264d16dc08da69a", symbol: "gamisUSDC", surface: "wrapper", classification: "public-static-wrapper-sample-not-live-state-proof" },
  { role: "gamisUSDC infra vault", chain: "Base", address: "0xc62734aecb095d2cb74b3ccebfdf973ec23fbaa1", symbol: "gamisUSDC", surface: "infra vault", classification: "public-static-infra-sample-not-live-state-proof" },
  { role: "csmv-cbETH vault", chain: "Base", address: "0xccb76aa1d7f257c437ac4ea9a05e0d46dea5213a", symbol: "csmv-cbETH", surface: "public API sample vault", classification: "public-static-vault-sample-not-live-state-proof" },
  { role: "csmv-cbETH wrapper", chain: "Base", address: "0x5fb79c4f8b6d8ccfb7fc804d8666042ac42c7928", symbol: "csmv-cbETH", surface: "wrapper", classification: "public-static-wrapper-sample-not-live-state-proof" },
  { role: "csmv-cbETH infra vault", chain: "Base", address: "0xb0f24dfb55e04da5ea1d756fdc31cad90efcd5d3", symbol: "csmv-cbETH", surface: "infra vault", classification: "public-static-infra-sample-not-live-state-proof" },
  { role: "Base WETH underlying", chain: "Base", address: "0x4200000000000000000000000000000000000006", symbol: "WETH", surface: "single ERC20 underlying", classification: "public-static-underlying-sample-not-live-state-proof" },
];

const METAVAULT_CANDIDATES = [
  {
    symbol: "smvUSDC",
    chain: "Base",
    vault: "0x3878e834246dc1d081b852fa3c6d5d26509b4efa",
    wrapper: "0x81fcec19f92da474fc30bbec6747f6d23a104955",
    infraVault: "0x74782ba2fc346d5470072a89b7374bf5563f1c27",
    underlyingSymbol: "USDC",
    underlyingAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  },
  {
    symbol: "gamisUSDC",
    chain: "Base",
    vault: "0x5e93e1193a5e297cba0856e9b3f22b6e05429b9a",
    wrapper: "0x776f95321a0285f8bcde149e3264d16dc08da69a",
    infraVault: "0xc62734aecb095d2cb74b3ccebfdf973ec23fbaa1",
    underlyingSymbol: "USDC",
    underlyingAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  },
  {
    symbol: "csmv-cbETH",
    chain: "Base",
    vault: "0xccb76aa1d7f257c437ac4ea9a05e0d46dea5213a",
    wrapper: "0x5fb79c4f8b6d8ccfb7fc804d8666042ac42c7928",
    infraVault: "0xb0f24dfb55e04da5ea1d756fdc31cad90efcd5d3",
    underlyingSymbol: "WETH",
    underlyingAddress: "0x4200000000000000000000000000000000000006",
  },
];

const ADDRESS_SEEDS = [...REGISTRY_ROWS, ...BASE_METAVAULT_ROWS];

const ADAPTER_ROWS = REGISTRY_ROWS.map((row) => ({
  chain: row.chain,
  adapterKey: CHAIN_SEEDS.find((chain) => chain.chain === row.chain)?.adapterKey || row.chain.toLowerCase(),
  address: row.address,
  module: TARGET.module,
  adapterFetched: TARGET.adapterFetched,
  classification: row.classification,
}));

const SURFACE_ROWS = [
  { component: "Registry/factory", surface: "chain-specific registry/factory addresses", routeRole: "vault discovery and exact asset resolution", watchTerms: ["registry", "factory", "MetaVaultWrapperInitialized", "chainsCount"] },
  { component: "MetaVault vault token", surface: "vault share / ERC20 share", routeRole: "producer asset", watchTerms: ["smvUSDC", "gamisUSDC", "csmv-cbETH", "share"] },
  { component: "Wrapper + infra vault", surface: "wrapper/infra vault accounting split", routeRole: "rate/strategy accounting and custody layer", watchTerms: ["wrapper", "infraVault", "getInfraVault"] },
  { component: "ERC-7540 async flow", surface: "request -> settle -> claim deposit/redeem", routeRole: "timing/queue and redeemability blocker", watchTerms: ["requestDeposit", "requestRedeem", "settle", "claimable", "epochId"] },
  { component: "ERC4626/rate conversions", surface: "convertToShares/convertToAssets/totalAssets; previews may revert", routeRole: "accepted-value/reference-rate proof", watchTerms: ["convertToShares", "convertToAssets", "totalAssets", "previewRedeem"] },
  { component: "Curator strategy allocation", surface: "PTs, LP positions, IBTs, idle DeFi yield", routeRole: "strategy/accounting and unwind risk", watchTerms: ["PT", "LP", "IBT", "idle", "curator"] },
  { component: "Roles/guardian constraints", surface: "Zodiac RolesModifier and validation constraints", routeRole: "operator/curator/admin blocker", watchTerms: ["RolesModifier", "validation", "setOperator", "curator"] },
  { component: "Rate/oracle/accounting", surface: "rate provider, oracle, performance fee on settle", routeRole: "accepted-value and fee proof gap", watchTerms: ["oracle", "rate", "performance fee", "settle"] },
  { component: "Bridge/remote/custody", surface: "cross-chain managed vault and remote custody", routeRole: "remote/finality/custody caveat", watchTerms: ["bridge", "remote", "custody", "chainsCount"] },
  { component: "Consumers / exits", surface: "lending/oracle/DEX/redeem joins", routeRole: "borrow/redeem/unwind economics", watchTerms: ["Morpho", "Aave", "Euler", "Silo", "Compound", "DEX"] },
];

const PUBLIC_DOCS = [
  "Spectra MetaVault docs context: cross-chain managed yield vaults with ERC-7540 async request->settle->claim flow (not fetched here)",
  "Public docs context: single ERC20 underlying per vault, wrapper plus infra vault architecture, curator allocates to PTs/LP positions/IBTs/idle DeFi yield",
  "Public docs context: Zodiac RolesModifier and validation constraints, performance fee on settle(), operator authorization, previews may intentionally revert",
  "Public API sample context: Base smvUSDC, gamisUSDC, csmv-cbETH vault/wrapper/infra rows with USDC/WETH underlyings",
  "Existing prefilter context: reports/raw/fast/prefilter-spectra-metavaults-route-prefilter.json and reports/prefilter-spectra-metavaults-route-prefilter.md",
];

const BUG_CLASS_ROWS = [
  { label: "ERC-7540 async request/settle/claim accounting mismatch", surface: "requestDeposit/requestRedeem/settle/claim", classification: "bug-class-context-no-current-route-proof" },
  { label: "preview functions intentionally reverting hides unsafe downstream assumptions", surface: "previewDeposit/previewRedeem/previewWithdraw/previewMint", classification: "bug-class-context-no-current-route-proof" },
  { label: "convertToAssets/convertToShares stale or wrong during epoch", surface: "ERC4626/rate conversion", classification: "bug-class-context-no-current-route-proof" },
  { label: "curator allocation overvalues PT/LP/IBT/idle positions", surface: "strategy accounting", classification: "bug-class-context-no-current-route-proof" },
  { label: "performance fee on settle changes share value unexpectedly", surface: "fee/accounting", classification: "bug-class-context-no-current-route-proof" },
  { label: "Zodiac RolesModifier or validation misconfiguration", surface: "roles/curator/guardian", classification: "bug-class-context-no-current-route-proof" },
  { label: "wrapper/infra vault custody mismatch", surface: "wrapper/infra accounting", classification: "bug-class-context-no-current-route-proof" },
  { label: "bridge/remote custody or chain accounting drift", surface: "cross-chain/custody", classification: "bug-class-context-no-current-route-proof" },
  { label: "downstream consumer prices queued/illiquid shares as liquid NAV", surface: "consumer join", classification: "bug-class-context-no-current-route-proof" },
  { label: "DEX/redeem exit unavailable or delayed beyond route model", surface: "exit liquidity", classification: "bug-class-context-no-current-route-proof" },
];

const SOURCE_FACTS = [
  {
    sourceLabel: "target-context:Spectra MetaVaults Outside V2",
    kind: "target-seed",
    slug: TARGET.slug,
    name: TARGET.name,
    category: TARGET.category,
    surface: TARGET.surface,
    tvlContext: TARGET.tvlContext,
    chains: [...TARGET.primaryChains, ...TARGET.caveatChains],
    evmFirstChains: TARGET.primaryChains,
    caveatChains: TARGET.caveatChains,
    module: TARGET.module,
    adapterFetched: TARGET.adapterFetched,
    adapterAddressCount: TARGET.adapterAddressCount,
    adapterHints: TARGET.adapterHints,
    routePositive: 0,
    classification: "structured-target-seed-route-negative",
  },
  {
    sourceLabel: "prior-prefilter-artifact:spectra-metavaults-route-prefilter",
    kind: "local-prefilter-context",
    artifacts: ["reports/raw/fast/prefilter-spectra-metavaults-route-prefilter.json", "reports/prefilter-spectra-metavaults-route-prefilter.md"],
    priorStatus: "dormant-route-negative",
    priorCandidateAddresses: 6,
    priorConsumerJoinRows: 0,
    priorRoutePositive: 0,
    note: "Existing sanitized prefilter artifact is parsed as local context only; this full-test scanner does not read endpoint inventories.",
    classification: "prior-prefilter-context-no-route-positive",
  },
  {
    sourceLabel: "adapter-source-context",
    kind: "public-static-label",
    module: TARGET.module,
    adapterRows: ADAPTER_ROWS.length,
    classification: "adapter-static-context-no-live-state-proof",
  },
  {
    sourceLabel: "public-docs-metavault-model",
    kind: "public-static-label",
    model: "Cross-chain managed yield vaults with ERC-7540 async flow, wrapper+infra vault, single ERC20 underlying, curator allocations, roles constraints, performance fee on settle.",
    classification: "public-docs-context-no-current-route-proof",
  },
  {
    sourceLabel: "base-public-api-sample-vaults",
    kind: "public-static-label",
    rows: BASE_METAVAULT_ROWS.length,
    classification: "public-api-sample-static-no-current-route-proof",
  },
  {
    sourceLabel: "local-consumer-and-exit-artifacts",
    kind: "local-artifact-context",
    artifacts: [
      "reports/raw/fast/erc4626-consumer-joiner.json",
      "reports/raw/fast/consumer-first-high-ltv-collateral.json",
      "reports/raw/fast/aave-euler-silo-consumer-graph.json",
      "reports/raw/fast/euler-v2-phase0.json",
      "reports/raw/fast/silo-v2-phase0.json",
      "reports/raw/fast/compound-v3-phase0.json",
      "reports/raw/fast/morpho-high-apy-liquidation-routes.json",
      "reports/raw/fast/dex-exit-quotes.json",
      "reports/raw/fast/dex-consumer-routes.json",
    ],
    classification: "local-consumer-exit-context-only-no-metavault-route-positive",
  },
];

const STATIC_CONTEXT_ROWS = [
  { sourceLabel: "adapter-registry-row", matched: "six chain registry/factory adapter rows", categories: ["registry", "bridgeRemoteCustody"], sample: "Ethereum, Arbitrum, Base, Avalanche, Katana, Flare static adapter addresses; not live code/state proof", classification: "static-adapter-context-no-route-positive" },
  { sourceLabel: "base-metavault-sample-row", matched: "Base smvUSDC/gamisUSDC/csmv-cbETH samples", categories: ["metavault", "wrapper", "infra", "erc4626Rate", "consumerJoin", "exitLiquidity"], sample: "Public API sample vault/wrapper/infra rows with Base USDC or WETH underlying; no current consumer/exit economics proven", classification: "public-api-sample-context-no-route-proof" },
  { sourceLabel: "erc7540-flow-row", matched: "ERC-7540 request-settle-claim flow", categories: ["erc7540AsyncFlow", "redemption", "economics"], sample: "requestDeposit/requestRedeem then settle and claim; queue/epoch semantics block route-positive status until exact timing/economics are proven", classification: "async-flow-context-no-current-route-proof" },
  { sourceLabel: "erc4626-rate-row", matched: "convertToShares/convertToAssets/totalAssets", categories: ["erc4626Rate", "rateProviderOracle", "economics"], sample: "Previews may revert; conversions and totalAssets need exact current state before accepted-value claims", classification: "rate-conversion-context-no-current-economics" },
  { sourceLabel: "curator-roles-row", matched: "curator allocation and Zodiac RolesModifier constraints", categories: ["curatorRoles", "ptYtIbt", "roleAdmin"], sample: "Curator allocates to PTs/LP positions/IBTs/idle DeFi yield under validation constraints; no permissionless role bypass proven", classification: "roles-curator-context-no-permissionless-proof" },
  { sourceLabel: "route-gap-row", matched: "vault share -> accounting -> consumer/exit", categories: ["consumerJoin", "dexLiquidity", "exitLiquidity", "economics"], sample: "No exact share-rate anomaly, material consumer acceptance, redeem/claim/DEX exit, or positive route economics was proven", classification: "route-gap-fail-closed" },
].map((row) => ({ rowSource: "static-public-fact", matchType: "static-public-fact", termType: "static", routePositive: 0, sourceRoutePositiveNotPromoted: false, ...row }));

const EXPLICIT_FILES = [
  "reports/raw/fast/prefilter-spectra-metavaults-route-prefilter.json",
  "reports/prefilter-spectra-metavaults-route-prefilter.md",
  "reports/raw/fast/prefilter-deep-new-target-search-2026-06-24.json",
  "reports/raw/fast/erc4626-consumer-joiner.json",
  "reports/raw/fast/consumer-first-high-ltv-collateral.json",
  "reports/raw/fast/aave-euler-silo-consumer-graph.json",
  "reports/raw/fast/euler-v2-phase0.json",
  "reports/raw/fast/silo-v2-phase0.json",
  "reports/raw/fast/compound-v3-phase0.json",
  "reports/raw/fast/morpho-high-apy-liquidation-routes.json",
  "reports/raw/fast/morpho-wrapper-exit-proof-gaps.json",
  "reports/raw/fast/morpho-liquidatable-marketability.json",
  "reports/raw/fast/dex-exit-quotes.json",
  "reports/raw/fast/dex-consumer-routes.json",
  "reports/raw/fast/curve-dex-phase0.json",
  "reports/raw/fast/balancer-v3-phase0.json",
  "reports/raw/fast/uniswap-v2-phase0.json",
  "reports/raw/fast/uniswap-v3-phase0.json",
  "reports/raw/fast/pendle-pt-consumer-graph.json",
  "reports/raw/fast/pendle-pt-multichain-consumer-graph.json",
  "reports/raw/fast/silo-pt-oracle-routes.json",
  "reports/raw/fast/pendle-yield-strategy-routes.json",
  "reports/raw/fast/oracle-staleness-cross-ref.json",
];

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const ADDRESS_RULES = ADDRESS_SEEDS
  .filter((row) => !/underlying/i.test(row.role))
  .map((row) => ({ label: `${row.role} ${row.address}`, regex: new RegExp(escapeRegExp(row.address), "i") }));

const EXACT_RULES = [
  { label: "spectra-metavaults-outside-v2", regex: /\bspectra[-_\s]?metavaults[-_\s]?outside[-_\s]?v2\b/i },
  { label: "Spectra MetaVaults", regex: /\bSpectra\s+MetaVaults?\b/i },
  { label: "MetaVaultWrapperInitialized", regex: /\bMetaVaultWrapperInitialized\b/i },
  { label: "MetaVault", regex: /\bMetaVaults?\b/i },
  { label: "smvUSDC", regex: /\bsmvUSDC\b/i },
  { label: "gamisUSDC", regex: /\bgamisUSDC\b/i },
  { label: "csmv-cbETH", regex: /\bcsmv[-_]?cbETH\b/i },
  { label: "getInfraVault", regex: /\bgetInfraVault\b/i },
  { label: "chainsCount", regex: /\bchainsCount\b/i },
  { label: "requestDeposit", regex: /\brequestDeposit\b/i },
  { label: "requestRedeem", regex: /\brequestRedeem\b/i },
  { label: "claimableDepositRequest", regex: /\bclaimableDepositRequest\b/i },
  { label: "claimableRedeemRequest", regex: /\bclaimableRedeemRequest\b/i },
  { label: "pendingDepositRequest", regex: /\bpendingDepositRequest\b/i },
  { label: "pendingRedeemRequest", regex: /\bpendingRedeemRequest\b/i },
  { label: "epochId", regex: /\bepochId\b/i },
  { label: "RolesModifier", regex: /\bRolesModifier\b/i },
  ...ADDRESS_RULES,
];

const CONTEXT_RULES = [
  { label: "registry", regex: /\b(?:registry|factory|wrapperinitialized)\b/i },
  { label: "vault/share", regex: /\b(?:vault|share|wrapper|infra\s*vault|underlying|asset\(\))\b/i },
  { label: "ERC7540", regex: /\b(?:ERC[-_]?7540|requestDeposit|requestRedeem|claimable|pending|epoch|settle)\b/i },
  { label: "ERC4626/rate", regex: /\b(?:ERC[-_]?4626|convertToAssets|convertToShares|totalAssets|previewRedeem|previewWithdraw|maxRedeem|maxDeposit)\b/i },
  { label: "PT/YT/IBT", regex: /\b(?:PTs?|YTs?|IBTs?|principal\s+token|yield\s+token|LP\s+positions?|idle\s+DeFi)\b/i },
  { label: "oracle/rate", regex: /\b(?:oracle|rate|accounting|performance\s+fee|price|NAV)\b/i },
  { label: "curator/roles", regex: /\b(?:curator|RolesModifier|operator|setOperator|guardian|validation|role)\b/i },
  { label: "bridge/custody", regex: /\b(?:bridge|cross[-\s]?chain|remote|custody|chainsCount)\b/i },
  { label: "consumer", regex: /\b(?:consumer|collateral|borrow|lending|Morpho|Aave|Euler|Silo|Compound|oracle)\b/i },
  { label: "DEX/exit", regex: /\b(?:DEX|swap|pool|liquidity|Uniswap|Curve|Balancer|exit|redeem|claim|withdraw|slippage)\b/i },
  { label: "routePositive", regex: /\broutePositive\b/i },
];

const CATEGORY_RULES = {
  registry: ["registry", "factory", "metavaultwrapperinitialized", "adapter", "chaincount", "chainscount"],
  metavault: ["metavault", "meta vault", "smvusdc", "gamisusdc", "csmv-cbeth", "vault share", "vault"],
  wrapper: ["wrapper", "metavaultwrapperinitialized"],
  infra: ["infra", "infravault", "getinfravault"],
  erc7540AsyncFlow: ["erc7540", "erc-7540", "requestdeposit", "requestredeem", "settle", "claimable", "pending", "epochid", "decreasedepositrequest", "decreaseredeemrequest"],
  erc4626Rate: ["erc4626", "erc-4626", "converttoassets", "converttoshares", "totalassets", "previewredeem", "previewwithdraw", "previewmint", "previewdeposit", "maxredeem", "maxdeposit", "asset()"],
  ptYtIbt: ["pt", "yt", "ibt", "principal token", "yield token", "lp position", "idle defi", "pendle"],
  rateProviderOracle: ["oracle", "rate", "price", "accounting", "performance fee", "settle", "nav", "totalassets"],
  curatorRoles: ["curator", "rolesmodifier", "operator", "setoperator", "guardian", "validation", "zodiac", "role"],
  bridgeRemoteCustody: ["bridge", "cross-chain", "cross chain", "remote", "custody", "chaincount", "chainscount", "flare", "katana"],
  consumerJoin: ["consumer", "collateral", "borrow", "lending", "reserve", "accepted", "morpho", "aave", "euler", "silo", "compound"],
  dexLiquidity: ["dex", "swap", "pool", "liquidity", "curve", "balancer", "uniswap", "slippage", "amm"],
  exitLiquidity: ["exit", "unwind", "redeem", "redemption", "claim", "withdraw", "swap", "liquidity", "settle"],
  economics: ["routepositive", "executable", "profit", "netbps", "positive", "liquidityusd", "tvl", "exacteconomics", "forkproof", "performance fee", "slippage"],
};

const BLOCKERS = [
  "No exact-positive Spectra MetaVault vault share -> rate/strategy accounting -> consumer or exit venue -> borrow/redeem/unwind route is proven in local artifacts; registry/vault rows are static seeds only.",
  "Existing route prefilter is dormant/route-negative and is prior context only; this full-test did not read endpoint inventories or refresh live state.",
  "ERC-7540 async request->settle->claim timing and epoch semantics can block same-block acquisition/redeem/unwind until exact current state is proven.",
  "ERC4626 convertToAssets/convertToShares/totalAssets and intentionally reverting previews require current values before any accepted-value claim can be made.",
  "Wrapper/infra vault and single-underlying rows do not prove live balances, custody, totalAssets, totalSupply, or redeemability at route size.",
  "Curator PT/LP/IBT/idle allocations and performance fee on settle require exact strategy accounting, valuation, and unwind amounts before route-positive status.",
  "Zodiac RolesModifier, validation constraints, setOperator, curator/admin, and guardian controls remain blockers until proven irrelevant to the route.",
  "Flare and Katana remain caveat chains without new safe local coverage; no cross-chain/remote custody or bridge bypass with liquid value is proven.",
  "Local lending/consumer and DEX artifacts do not show a Spectra MetaVault-specific material consumer or route-size exact acquisition/redeem/unwind liquidity.",
  "No endpoint inventory was read and no live eth_call/fork refresh was performed in this bounded pass, so route gate stays fail-closed.",
  "Fork and signed-action gates remain closed because routePositive=0 and exactEconomicsRows=0.",
];

const REQUIRED_FOR_ROUTE_POSITIVE = [
  "Exact producer asset: identify the deployed MetaVault share, wrapper, infra vault, underlying asset, totalSupply, totalAssets, convertToAssets/convertToShares, and live epoch/request state.",
  "Exact ERC-7540 flow: requestDeposit/requestRedeem, settle, claimable/pending amounts, decrease paths, operator rights, epochId, and fees must be quantified for the same asset and size.",
  "Exact accounting proof: strategy PT/LP/IBT/idle allocations, rate/oracle/accounting inputs, performance fee, and wrapper/infra custody values must reconcile to redeem/market value.",
  "Exact consumer/exit join: the same MetaVault share/wrapper or claim must be accepted by a material lending/oracle/settlement consumer or have immediate permissionless redeem/claim/DEX exit liquidity at route size.",
  "Role and chain proof: Zodiac RolesModifier, validation constraints, curator/admin/guardian/setOperator controls, bridge/remote/custody and caveat-chain semantics must not block the attacker path.",
  "Positive economics: accepted value must exceed exact acquisition, redeem/claim, borrow/liquidation, or DEX unwind value after fees, performance fee, slippage, queues/epochs, caps, and LTV/LLTV haircuts.",
  "Local static/fork value-delta proof must show positive attacker-controlled balance movement before routePositive, forkJustified, or signedActionJustified can change.",
  "Explicit route-specific authorization and independent defensive review are required before any signed transaction path is discussed.",
];

const NEXT_READ_ONLY_STEP = "Keep Spectra MetaVaults Outside V2 dormant. The static/local candidate matrix should be refreshed only if a specific MetaVault share/wrapper/claim maps to a material consumer or permissionless redeem/claim/DEX exit; then refresh sanitized read-only state for ERC-7540 request/settle/claim, ERC4626 conversions, wrapper/infra custody, strategy PT/LP/IBT allocation, roles/validation controls, and exact exit economics before any fork/static proof.";

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
  if (r === "tools/scan-spectra-metavaults-outside-v2-full-test.js") return true;
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

function writeJson(filePath, value) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, jsonReplacer, 2)}\n`, "utf8");
}

function writeText(filePath, value) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, value, "utf8");
}

function listFilesRecursive(rootDir, filterFn = null) {
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
      if (filterFn && !filterFn(full)) continue;
      out.push(full);
    }
  }
  walk(rootDir);
  return out;
}

function listRelatedReportFiles() {
  const fast = path.join(WORKSPACE, "reports", "raw", "fast");
  return listFilesRecursive(fast, (file) => /(?:spectra-metavaults|metavault|erc4626|erc7540|consumer|aave|euler|silo|compound|morpho-|dex|exit|curve|balancer|uniswap|pendle|pt-|oracle)/i.test(path.basename(file)));
}

function listScanFiles() {
  const files = [];
  for (const file of EXPLICIT_FILES) {
    const full = path.join(WORKSPACE, file);
    if (fs.existsSync(full) && !isExcludedScanPath(full)) files.push(full);
  }
  files.push(...listRelatedReportFiles());
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

function matchForText(line, windowText) {
  const exact = firstRuleMatch(line, EXACT_RULES) || firstRuleMatch(windowText, EXACT_RULES);
  if (exact) return { matchType: "exact-name-address-token-module", matched: exact.label, termType: "text" };
  const context = firstRuleMatch(line, CONTEXT_RULES) || firstRuleMatch(windowText, CONTEXT_RULES);
  if (!context) return null;
  if (hasRuleMatch(windowText, EXACT_RULES)) return { matchType: "context", matched: context.label, termType: "text" };
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
  if (routeValue === true || routeValue === "true" || routeValue === 1) return "prior-positive-or-watch-signal-not-promoted-without-current-exact-economics";
  if (r.includes("prefilter-spectra-metavaults")) return "prior-prefilter-context-only-no-route-positive";
  if (r.includes("prefilter-deep-new-target-search")) return "discovery-context-only-no-route-positive";
  if (r.includes("erc4626") || r.includes("vault")) return "erc4626-vault-context-only-no-spectra-metavault-exact-route";
  if (r.includes("pendle") || r.includes("pt-") || categories.includes("ptYtIbt")) return "pt-yt-ibt-context-only-no-metavault-exact-economics";
  if (r.includes("morpho") || r.includes("aave") || r.includes("euler") || r.includes("silo") || r.includes("compound")) return "consumer-artifact-context-only-no-spectra-metavault-exact-route";
  if (r.includes("curve") || r.includes("balancer") || r.includes("uniswap") || r.includes("dex") || r.includes("exit")) return "dex-exit-context-only-no-spectra-metavault-exact-economics";
  if (categories.includes("consumerJoin") || categories.includes("dexLiquidity") || categories.includes("exitLiquidity") || categories.includes("rateProviderOracle")) return "consumer-or-exit-context-only-no-positive-economics";
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
      const routeValue = /\broutePositive\b[^\n,}]*\b(?:true|1)\b/i.test(windowText);
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
        sourceRoutePositiveNotPromoted: Boolean(routeValue),
        classification: classificationForRow(file, match, categories, routeValue),
      });
      sampled += 1;
    }
    if (fileMatched) filesWithMatch += 1;
    if (fileExact) filesWithExact += 1;
    if (rows.length >= MAX_LOCAL_MATCH_ROWS) break;
  }
  return { filesScanned, filesWithMatch, filesWithExact, rows, exactRows: rows.filter((row) => row.matchType === "exact-name-address-token-module"), categoryCounts };
}

function exactish(row) {
  return row.matchType === "exact-name-address-token-module";
}

function discoveryContextOnly(row) {
  return row.classification === "discovery-context-only-no-route-positive";
}

function includesAnyTerm(text, terms) {
  const hay = String(text || "").toLowerCase();
  return terms.some((term) => term && hay.includes(String(term).toLowerCase()));
}

function rowSearchText(row) {
  return `${row.file || ""} ${row.matched || ""} ${row.sample || ""} ${row.classification || ""}`;
}

function candidateTerms(candidate) {
  return [
    candidate.symbol,
    candidate.vault,
    candidate.wrapper,
    candidate.infraVault,
    candidate.underlyingAddress,
  ].filter(Boolean);
}

function candidateRowsByCategory(rows, category) {
  return rows.filter((row) => (row.categories || []).includes(category));
}

function firstSources(rows, max = 4) {
  return uniqBy(rows, sourceForRow).slice(0, max).map(sourceForRow);
}

function buildCandidateProofCheck({ key, status, evidenceRows = [], routeBlocking, blocker }) {
  return {
    key,
    status,
    evidenceRows: evidenceRows.length,
    evidenceSources: firstSources(evidenceRows),
    routeBlocking: Boolean(routeBlocking),
    blocker,
  };
}

function buildCandidateRouteMatrix(localRows, exactConsumerJoinRows, exactEconomicsRows) {
  const candidates = METAVAULT_CANDIDATES.map((candidate) => {
    const terms = candidateTerms(candidate);
    const candidateLocalRows = localRows.filter((row) => includesAnyTerm(rowSearchText(row), terms));
    const exactRows = candidateLocalRows.filter(exactish);
    const erc7540Rows = candidateRowsByCategory(candidateLocalRows, "erc7540AsyncFlow");
    const erc4626Rows = candidateRowsByCategory(candidateLocalRows, "erc4626Rate");
    const wrapperRows = candidateLocalRows.filter((row) => (row.categories || []).some((cat) => ["wrapper", "infra"].includes(cat)));
    const strategyRows = candidateLocalRows.filter((row) => (row.categories || []).some((cat) => ["ptYtIbt", "rateProviderOracle"].includes(cat)));
    const roleRows = candidateRowsByCategory(candidateLocalRows, "curatorRoles");
    const consumerRows = candidateRowsByCategory(candidateLocalRows, "consumerJoin").filter((row) => /\b(?:consumer|collateral|borrow|lending|accepted|morpho|aave|euler|silo|compound)\b/i.test(rowSearchText(row)));
    const exitRows = candidateLocalRows.filter((row) => (row.categories || []).some((cat) => ["dexLiquidity", "exitLiquidity"].includes(cat)) && /\b(?:dex|swap|pool|liquidity|redeem|claim|exit|unwind|withdraw|curve|balancer|uniswap)\b/i.test(rowSearchText(row)));
    const categories = Array.from(new Set(candidateLocalRows.flatMap((row) => row.categories || []))).sort();
    const proofChecks = [
      buildCandidateProofCheck({
        key: "staticSeed",
        status: "present-static-seed-only",
        evidenceRows: exactRows,
        routeBlocking: false,
        blocker: "Vault/wrapper/infra/underlying rows are static public samples, not live state proof.",
      }),
      buildCandidateProofCheck({
        key: "currentErc7540State",
        status: erc7540Rows.length ? "context-only-no-current-state" : "missing",
        evidenceRows: erc7540Rows,
        routeBlocking: true,
        blocker: "No current request/settle/claim, epochId, pending, or claimable state is resolved for this candidate.",
      }),
      buildCandidateProofCheck({
        key: "currentErc4626Conversions",
        status: erc4626Rows.length ? "context-only-no-current-conversion" : "missing",
        evidenceRows: erc4626Rows,
        routeBlocking: true,
        blocker: "No current totalAssets, totalSupply, convertToAssets, or convertToShares value is resolved for this candidate.",
      }),
      buildCandidateProofCheck({
        key: "wrapperInfraCustody",
        status: wrapperRows.length ? "context-only-no-balance-proof" : "missing",
        evidenceRows: wrapperRows,
        routeBlocking: true,
        blocker: "Wrapper/infra rows do not prove live balances, custody, caps, or redeemability at route size.",
      }),
      buildCandidateProofCheck({
        key: "strategyAllocation",
        status: strategyRows.length ? "context-only-no-valuation-proof" : "missing",
        evidenceRows: strategyRows,
        routeBlocking: true,
        blocker: "PT/LP/IBT/idle allocation, rate, oracle, and performance-fee valuation is not reconciled for this candidate.",
      }),
      buildCandidateProofCheck({
        key: "rolesValidation",
        status: roleRows.length ? "context-only-no-bypass-proof" : "missing",
        evidenceRows: roleRows,
        routeBlocking: true,
        blocker: "RolesModifier, operator, curator, guardian, and validation constraints are not proven irrelevant to the path.",
      }),
      buildCandidateProofCheck({
        key: "materialConsumerAcceptance",
        status: consumerRows.length ? "candidate-context-only-not-exact-consumer" : "missing",
        evidenceRows: consumerRows,
        routeBlocking: true,
        blocker: "No material lending/oracle/settlement consumer is joined to this exact MetaVault share/wrapper/claim with current liquidity and caps.",
      }),
      buildCandidateProofCheck({
        key: "permissionlessExitLiquidity",
        status: exitRows.length ? "candidate-context-only-not-exact-exit" : "missing",
        evidenceRows: exitRows,
        routeBlocking: true,
        blocker: "No immediate permissionless redeem/claim/DEX exit is exact-quoted for this candidate at route size.",
      }),
      buildCandidateProofCheck({
        key: "exactEconomicsAndProof",
        status: exactEconomicsRows > 0 ? "unexpected-context-not-promoted" : "missing",
        evidenceRows: [],
        routeBlocking: true,
        blocker: "No exact positive economics or local/fork/static attacker-controlled value-delta proof exists.",
      }),
    ];
    const routeBlockingProofGaps = proofChecks.filter((check) => check.routeBlocking).map((check) => check.key);
    const hasConsumerOrExit = consumerRows.length > 0 || exitRows.length > 0;
    return {
      symbol: candidate.symbol,
      chain: candidate.chain,
      vault: candidate.vault,
      wrapper: candidate.wrapper,
      infraVault: candidate.infraVault,
      underlyingSymbol: candidate.underlyingSymbol,
      underlyingAddress: candidate.underlyingAddress,
      localArtifactRows: candidateLocalRows.length,
      exactLocalRows: exactRows.length,
      categories,
      erc7540ContextRows: erc7540Rows.length,
      erc4626ContextRows: erc4626Rows.length,
      wrapperInfraContextRows: wrapperRows.length,
      strategyContextRows: strategyRows.length,
      roleContextRows: roleRows.length,
      consumerContextRows: consumerRows.length,
      exitContextRows: exitRows.length,
      proofChecks,
      routeBlockingProofGaps,
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      status: hasConsumerOrExit ? "watch-context-needs-current-state-and-exact-economics" : "blocked-no-exact-consumer-or-exit",
      blocker: hasConsumerOrExit
        ? "Candidate has local consumer/exit context only; current state, liquidity, caps, and positive economics remain unproven."
        : "Candidate has static seed/local context only; no exact material consumer or exit venue is joined.",
    };
  });
  const proofGapRows = candidates.flatMap((candidate) => candidate.proofChecks
    .filter((check) => check.routeBlocking)
    .map((check) => ({
      symbol: candidate.symbol,
      chain: candidate.chain,
      gate: check.key,
      status: check.status,
      evidenceRows: check.evidenceRows,
      blocker: check.blocker,
    })));
  return {
    candidates,
    proofGapRows,
    summary: {
      candidateRows: candidates.length,
      candidatesWithAllStaticSeeds: candidates.length,
      candidatesWithLocalArtifactRows: candidates.filter((candidate) => candidate.localArtifactRows > 0).length,
      candidatesWithExactConsumerOrExit: candidates.filter((candidate) => candidate.consumerContextRows > 0 || candidate.exitContextRows > 0).length,
      candidatesWithCurrentErc7540StateProof: 0,
      candidatesWithCurrentErc4626Proof: 0,
      candidatesWithWrapperInfraCustodyProof: 0,
      candidatesWithStrategyValuationProof: 0,
      candidatesWithRolesBypassProof: 0,
      candidatesWithExitEconomicsProof: 0,
      candidateMatrixProofGapRows: proofGapRows.length,
      exactConsumerJoinRows: exactConsumerJoinRows.length,
      exactEconomicsRows,
      routePositive: 0,
    },
  };
}

function selectNotableRows(rows) {
  const priority = [];
  const files = new Set();
  for (const row of rows) {
    const key = row.file || row.sourceLabel || row.matched;
    const cats = row.categories || [];
    if (row.rowSource === "static-public-fact" || exactish(row) || cats.some((cat) => ["registry", "metavault", "wrapper", "infra", "erc7540AsyncFlow", "erc4626Rate", "ptYtIbt", "rateProviderOracle", "curatorRoles", "bridgeRemoteCustody", "consumerJoin", "dexLiquidity", "exitLiquidity"].includes(cat))) {
      if (!files.has(key) || exactish(row) || row.rowSource === "static-public-fact") {
        priority.push(row);
        files.add(key);
      }
    }
    if (priority.length >= 44) break;
  }
  return priority.length ? priority : rows.slice(0, 24);
}

function sourceForRow(row) {
  if (row.file) return `${row.file}${row.line ? `:${row.line}` : ""}`;
  return row.sourceLabel || row.rowSource || "static";
}

function buildPayload({ lineScan }) {
  const localRows = lineScan.rows;
  const combinedRows = [...STATIC_CONTEXT_ROWS, ...localRows];
  const exactRows = lineScan.exactRows;
  const categoryRows = {};
  for (const category of Object.keys(CATEGORY_RULES)) categoryRows[`${category}Rows`] = pickRows(combinedRows, (row) => row.categories.includes(category), 180);
  const priorPrefilterRows = pickRows(localRows, (row) => row.file && row.file.includes("prefilter-spectra-metavaults"), 180);
  const discoveryContextRows = localRows.filter(discoveryContextOnly).length;
  const consumerJoinRows = pickRows(
    combinedRows,
    (row) => !discoveryContextOnly(row) && row.categories.includes("consumerJoin"),
    190,
  );
  const exactConsumerJoinRows = pickRows(
    consumerJoinRows,
    (row) => exactish(row) && !/underlying|\bUSDC\b|\bWETH\b/i.test(row.matched || "") && /(?:morpho|aave|euler|silo|compound|consumer-first-high-ltv|erc4626-consumer)/i.test(row.file || "") && /\b(?:collateral|borrow|lending|accepted|morpho|aave|euler|silo|compound)\b/i.test(`${row.sample || ""}`),
    150,
  );
  const exactEconomicsRows = 0;
  const candidateRouteMatrix = buildCandidateRouteMatrix(localRows, exactConsumerJoinRows, exactEconomicsRows);
  const notableRows = selectNotableRows(combinedRows);
  const priorArtifactPositiveRowsNotPromoted = localRows.filter((row) => row.sourceRoutePositiveNotPromoted).length;
  const producerAnomalies = 0;
  const watchCandidates = 0;
  const routePositive = 0;
  const executableNow = 0;
  const signedActionJustified = false;
  const forkJustified = false;
  const forkGate = "closed-route-positive-zero";

  const summary = {
    sourceFactRows: SOURCE_FACTS.length,
    chainSeedRows: CHAIN_SEEDS.length,
    addressSeedRows: ADDRESS_SEEDS.length,
    adapterRows: ADAPTER_ROWS.length,
    registryRows: REGISTRY_ROWS.length,
    metavaultRows: BASE_METAVAULT_ROWS.filter((row) => row.role.includes("vault") && !row.role.includes("infra")).length,
    wrapperRows: BASE_METAVAULT_ROWS.filter((row) => row.role.includes("wrapper")).length,
    infraRows: BASE_METAVAULT_ROWS.filter((row) => row.role.includes("infra")).length,
    surfaceRows: SURFACE_ROWS.length,
    publicDocRows: PUBLIC_DOCS.length,
    bugClassRows: BUG_CLASS_ROWS.length,
    staticContextRows: STATIC_CONTEXT_ROWS.length,
    priorPrefilterRows: priorPrefilterRows.length,
    filesScanned: lineScan.filesScanned,
    filesWithLocalMatches: lineScan.filesWithMatch,
    filesWithExactLocalMatches: lineScan.filesWithExact,
    localArtifactMatchRows: localRows.length,
    exactLocalArtifactMatchRows: exactRows.length,
    localLineRows: lineScan.rows.length,
    discoveryContextRows,
    erc7540AsyncFlowRows: categoryRows.erc7540AsyncFlowRows.length,
    erc4626RateRows: categoryRows.erc4626RateRows.length,
    ptYtIbtRows: categoryRows.ptYtIbtRows.length,
    rateProviderOracleRows: categoryRows.rateProviderOracleRows.length,
    curatorRolesRows: categoryRows.curatorRolesRows.length,
    bridgeRemoteCustodyRows: categoryRows.bridgeRemoteCustodyRows.length,
    consumerJoinRows: consumerJoinRows.length,
    exactConsumerJoinRows: exactConsumerJoinRows.length,
    metavaultCandidateRows: candidateRouteMatrix.summary.candidateRows,
    candidateMatrixRows: candidateRouteMatrix.summary.candidateRows,
    candidatesWithAllStaticSeeds: candidateRouteMatrix.summary.candidatesWithAllStaticSeeds,
    candidatesWithLocalArtifactRows: candidateRouteMatrix.summary.candidatesWithLocalArtifactRows,
    candidatesWithExactConsumerOrExit: candidateRouteMatrix.summary.candidatesWithExactConsumerOrExit,
    candidatesWithCurrentErc7540StateProof: candidateRouteMatrix.summary.candidatesWithCurrentErc7540StateProof,
    candidatesWithCurrentErc4626Proof: candidateRouteMatrix.summary.candidatesWithCurrentErc4626Proof,
    candidatesWithWrapperInfraCustodyProof: candidateRouteMatrix.summary.candidatesWithWrapperInfraCustodyProof,
    candidatesWithStrategyValuationProof: candidateRouteMatrix.summary.candidatesWithStrategyValuationProof,
    candidatesWithRolesBypassProof: candidateRouteMatrix.summary.candidatesWithRolesBypassProof,
    candidatesWithExitEconomicsProof: candidateRouteMatrix.summary.candidatesWithExitEconomicsProof,
    candidateMatrixProofGapRows: candidateRouteMatrix.summary.candidateMatrixProofGapRows,
    dexLiquidityRows: categoryRows.dexLiquidityRows.length,
    exitLiquidityRows: categoryRows.exitLiquidityRows.length,
    economicsContextRows: categoryRows.economicsRows.length,
    producerAnomalies,
    watchCandidates,
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
    fullTestReadOnlyComplete: true,
  };

  return {
    generatedAt: GENERATED_AT,
    deterministicOutput: true,
    scanner: "tools/scan-spectra-metavaults-outside-v2-full-test.js",
    target: TARGET,
    scope: {
      kind: "bounded defensive/read-only full-test scanner",
      artifactStaticLocalFirst: true,
      publicFactsOnly: true,
      evmFirst: true,
      evmFirstChains: TARGET.primaryChains,
      caveatChains: TARGET.caveatChains,
      routeGraph: TARGET.routeGraph,
      writesLimitedTo: [OUT_JSON_REL, OUT_MD_REL],
      coordinatorClaim: TARGET.coordinatorClaim,
      aggregatePromotionStateHandoffEdited: false,
      endpointPolicy: "No endpoint inventory was read by this full-test scanner; no raw endpoints, domains, keys, or tokens are persisted.",
    },
    safety: {
      localArtifactsRead: true,
      publicSourcesRead: true,
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
    publicDocs: PUBLIC_DOCS,
    bugClasses: BUG_CLASS_ROWS,
    discoveredSeeds: { chainSeeds: CHAIN_SEEDS, addressSeedRows: ADDRESS_SEEDS, adapterRows: ADAPTER_ROWS, registryRows: REGISTRY_ROWS, baseMetavaultRows: BASE_METAVAULT_ROWS, surfaceRows: SURFACE_ROWS },
    staticContextRows: STATIC_CONTEXT_ROWS,
    priorPrefilterRows,
    localArtifacts: {
      filesScanned: lineScan.filesScanned,
      filesWithMatch: lineScan.filesWithMatch,
      filesWithExact: lineScan.filesWithExact,
      categoryCounts: lineScan.categoryCounts,
      rows: localRows,
      exactRows: exactRows.slice(0, 200),
      notableRows,
    },
    categoryRows: { ...categoryRows, consumerJoinRows, exactConsumerJoinRows },
    candidateRouteMatrix,
    rows: notableRows.slice(0, 14),
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
      reason: "Static/local scan found Spectra MetaVaults discovery, adapter, registry, vault/wrapper/infra, ERC-7540, ERC4626/rate, curator/roles, bridge/custody, consumer, and DEX context rows only; no current exact permissionless value movement, positive economics, or local/fork/static value-delta proof is present.",
    },
    blockers: BLOCKERS,
    requiredForRoutePositive: REQUIRED_FOR_ROUTE_POSITIVE,
    nextReadOnlyStep: NEXT_READ_ONLY_STEP,
    summary,
  };
}

function metricRows(summary) {
  const keys = [
    "sourceFactRows", "chainSeedRows", "addressSeedRows", "adapterRows", "registryRows", "metavaultRows", "wrapperRows", "infraRows", "surfaceRows", "publicDocRows", "bugClassRows", "staticContextRows", "priorPrefilterRows", "filesScanned", "filesWithLocalMatches", "filesWithExactLocalMatches", "localArtifactMatchRows", "exactLocalArtifactMatchRows", "erc7540AsyncFlowRows", "erc4626RateRows", "ptYtIbtRows", "rateProviderOracleRows", "curatorRolesRows", "bridgeRemoteCustodyRows", "consumerJoinRows", "exactConsumerJoinRows", "metavaultCandidateRows", "candidateMatrixRows", "candidatesWithAllStaticSeeds", "candidatesWithLocalArtifactRows", "candidatesWithExactConsumerOrExit", "candidatesWithCurrentErc7540StateProof", "candidatesWithCurrentErc4626Proof", "candidatesWithWrapperInfraCustodyProof", "candidatesWithStrategyValuationProof", "candidatesWithRolesBypassProof", "candidatesWithExitEconomicsProof", "candidateMatrixProofGapRows", "dexLiquidityRows", "exitLiquidityRows", "economicsContextRows", "producerAnomalies", "watchCandidates", "priorArtifactPositiveRowsNotPromoted", "publicFetchRows", "rpcInventoryRows", "graphqlInventoryRows", "ethCallRows", "forkRows", "exactEconomicsRows", "routePositive", "executableNow", "signedActionJustified", "forkJustified", "forkGate", "fullTestReadOnlyComplete",
  ];
  return keys.map((key) => `| ${key} | ${mdEscape(summary[key])} |`).join("\n");
}

function safetyRows(safety) {
  const keys = [
    "localArtifactsRead", "publicSourcesRead", "publicStaticLabelsUsed", "publicNetworkFetch", "endpointInventoryRead", "rpcInventoryRead", "graphqlInventoryRead", "envFilesRead", "privateKeysRead", "keyMaterialRead", "rawEndpointUrlsStored", "rpcUrlsStored", "graphqlUrlsStored", "rawUrlsStored", "rawDomainsStored", "rawKeysTokensStored", "signedActions", "liveTransactions", "broadcasts", "walletOperations", "forkTransactions", "sanitizedOutputOnly", "secretLikePathsExcluded",
  ];
  return keys.map((key) => `| ${key} | ${mdEscape(safety[key])} |`).join("\n");
}

function formatLocalRow(row) {
  const categories = (row.categories || []).join(",");
  const detail = row.sample || "context-only";
  return `| ${mdEscape(sourceForRow(row))} | ${mdEscape(categories)} | ${mdEscape(row.matched)} | ${mdEscape(detail)} | ${mdEscape(row.routePositive)} | ${mdEscape(row.classification)} |`;
}

function formatAddressRow(row) {
  return `| ${mdEscape(row.role)} | ${mdEscape(row.chain)} | ${mdEscape(row.address)} | ${mdEscape(row.surface)} | ${mdEscape(row.classification)} |`;
}

function shortAddress(value) {
  const text = String(value || "");
  return /^0x[0-9a-fA-F]{40}$/.test(text) ? `${text.slice(0, 6)}...${text.slice(-4)}` : text;
}

function formatCandidateRouteRow(row) {
  const seed = `vault=${shortAddress(row.vault)}, wrapper=${shortAddress(row.wrapper)}, infra=${shortAddress(row.infraVault)}, underlying=${row.underlyingSymbol}/${shortAddress(row.underlyingAddress)}`;
  const missing = row.routeBlockingProofGaps.length ? row.routeBlockingProofGaps.join(", ") : "none";
  const evidence = `local=${row.localArtifactRows}, exact=${row.exactLocalRows}, consumer=${row.consumerContextRows}, exit=${row.exitContextRows}`;
  return `| ${mdEscape(row.symbol)} | ${mdEscape(row.chain)} | ${mdEscape(seed)} | ${mdEscape(evidence)} | ${mdEscape(missing)} | ${mdEscape(row.status)} |`;
}

function formatSurfaceRow(row) {
  return `| ${mdEscape(row.component)} | ${mdEscape(row.surface)} | ${mdEscape(row.routeRole)} | ${mdEscape((row.watchTerms || []).join(", "))} |`;
}

function formatBugClassRow(row) {
  return `| ${mdEscape(row.label)} | ${mdEscape(row.surface)} | ${mdEscape(row.classification)} |`;
}

function buildMarkdown(payload) {
  const notableRows = payload.localArtifacts.notableRows.length
    ? payload.localArtifacts.notableRows.map(formatLocalRow).join("\n")
    : "| (none) | n/a | n/a | no local context rows found | 0 | dormant |";
  const addressRows = payload.discoveredSeeds.addressSeedRows.map(formatAddressRow).join("\n");
  const surfaceRows = payload.discoveredSeeds.surfaceRows.map(formatSurfaceRow).join("\n");
  const candidateRows = payload.candidateRouteMatrix.candidates.map(formatCandidateRouteRow).join("\n");
  const bugClassRows = payload.bugClasses.map(formatBugClassRow).join("\n");
  const docRows = payload.publicDocs.map((item) => `- ${item}`).join("\n");

  return `# 🟢 DORMANT - Spectra MetaVaults Outside V2 Full Test

Generated: ${payload.generatedAt}

Route remains closed: routePositive=${payload.routeGate.routePositive}, executableNow=${payload.routeGate.executableNow}, signedActionJustified=${payload.routeGate.signedActionJustified}, forkJustified=${payload.routeGate.forkJustified}, forkGate=${payload.routeGate.forkGate}.

## Summary

| Metric | Value |
|---|---:|
${metricRows(payload.summary)}

## Target / Scope

- Target: ${payload.target.name} (${payload.target.slug}), category=${payload.target.category}, surface=${payload.target.surface}, module=${payload.target.module}, TVL context≈${payload.target.tvlContext}.
- EVM-first chains: ${payload.scope.evmFirstChains.join(", ")}; caveat chains: ${payload.scope.caveatChains.join(", ")}.
- Route graph: ${payload.target.routeGraph}.
- Adapter context: adapterFetched=${payload.target.adapterFetched}, adapterAddressCount=${payload.target.adapterAddressCount}, hints=${payload.target.adapterHints.join(", ")}.
- Writes limited to: ${payload.scope.writesLimitedTo.join(", ")}.

## Safety

| Field | Value |
|---|---:|
${safetyRows(payload.safety)}

## Public Static Docs / Deployment Facts (allowed context; not fetched here)

${docRows}

## Address Rows (static, not live state proof)

| Role | Chain | Address | Surface | Classification |
|---|---|---|---|---|
${addressRows}

## Surface Rows

| Component | Surface | Route Role | Watch Terms |
|---|---|---|---|
${surfaceRows}

## Exact Candidate Matrix (local/static, fail-closed)

| Candidate | Chain | Static Seed Components | Local Evidence | Missing Current Proofs | Status |
|---|---|---|---|---|---|
${candidateRows}

## Bug Classes / Proof Gaps (context only)

| Class | Surface | Classification |
|---|---|---|
${bugClassRows}

## Notable Local / Static Rows (watch/context only)

| Source | Categories | Match | Detail | Route | Classification |
|---|---|---|---|---:|---|
${notableRows}

## Route Gate

- Status: ${payload.routeGate.status}.
- Required fail-closed conjunction is absent: exactPermissionlessValueMovement=${payload.routeGate.exactPermissionlessValueMovement}, exactPositiveEconomics=${payload.routeGate.exactPositiveEconomics}, localForkStaticProof=${payload.routeGate.localForkStaticProof}.
- No exact MetaVault share-rate/accounting anomaly, material consumer acceptance, redeem/claim path, or DEX exit route was resolved with positive economics.
- Existing Spectra MetaVaults prefilter rows remain prior context only; this full-test did not read endpoint inventories or perform live calls.
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
  log("Scanning Spectra MetaVaults Outside V2 local artifacts (sanitized, no endpoint inventory read)...");
  const files = listScanFiles();
  const lineScan = scanLocalArtifactLines(files);
  const payload = buildPayload({ lineScan });
  writeJson(OUT_JSON, payload);
  writeText(OUT_MD, buildMarkdown(payload));
  log(`Wrote ${OUT_JSON_REL} and ${OUT_MD_REL}`);
  log(`routePositive=${payload.summary.routePositive}; exactEconomicsRows=${payload.summary.exactEconomicsRows}; localArtifactMatchRows=${payload.summary.localArtifactMatchRows}; exactConsumerJoinRows=${payload.summary.exactConsumerJoinRows}`);
}

main();
