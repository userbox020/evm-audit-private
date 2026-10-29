#!/usr/bin/env node
"use strict";

// scan-brix-full-test.js
// Defensive Brix full-test scanner. Static/local/public-facts only; no endpoint
// inventory reads, network fetches, RPC calls, forks, signed actions, or wallets.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const REPORTS_DIR = path.join(WORKSPACE, "reports");
const OUT_JSON = path.join(RAW_DIR, "brix-full-test.json");
const OUT_MD = path.join(REPORTS_DIR, "brix-full-test-triage.md");
const OUT_JSON_REL = "reports/raw/fast/brix-full-test.json";
const OUT_MD_REL = "reports/brix-full-test-triage.md";

const QUIET = process.argv.includes("--quiet");
const GENERATED_AT = process.env.SCAN_GENERATED_AT || "2026-07-07T00:00:00.000Z";

const MAX_FILE_BYTES = 24 * 1024 * 1024;
const MAX_LOCAL_MATCH_ROWS = 760;
const MAX_ROWS_PER_FILE = 34;

const TARGET = {
  slug: "brix",
  name: "Brix",
  kind: "yield",
  project: "brix",
  discoveryRank: 19,
  category: "Yield",
  poolId: "da8c4ac9-733d-4a98-85a5-83b76b7e84d1",
  discoverySymbol: "WITRY",
  publicTokenSymbols: ["iTRY", "wiTRY", "WITRY"],
  tokenNamePublic: "iTry / iTRY",
  symbolAmbiguity: "Discovery uses WITRY while public pages/docs use iTRY / wiTRY; scanner treats symbol identity as unresolved until exact share/underlying role is proven.",
  tvlContextUsd: 7_128_000,
  tvlContext: "$7.128M",
  earlierDiscoveryTvlContext: "$7.788M",
  apyContext: "61.9%",
  earlierDiscoveryApyContext: "41.88%",
  stablecoin: false,
  ilRisk: "no",
  surface: "vault-yield-allocator",
  primaryChains: ["Ethereum"],
  caveatChains: [],
  routeGraph: "vault share -> rate/strategy accounting -> consumer or exit venue -> borrow/redeem/unwind",
  firstReadOnlyChecks: [
    "resolve exact vault/share token and underlying role",
    "probe ERC4626/share-rate/donation/rounding semantics",
    "join shares to lending and DEX consumers with exact exit economics",
  ],
  underlyingTokenFromDiscovery: "0xb492B4aFD9658093694CF9452D5C272e8230F3B0",
  implementation: "0x0679EAa2443e5fEA70Eea7aC9508fD357406FdAD",
};

const CHAIN_SEEDS = [
  { chain: "Ethereum", chainLabel: "Ethereum", chainId: 1, adapterKey: "ethereum", evmFirst: true, caveat: false, classification: "primary-evm-discovery-chain" },
];

const ADDRESS_SEEDS = [
  {
    role: "Brix target token/proxy from discovery and public token page",
    chain: "Ethereum",
    address: "0xb492B4aFD9658093694CF9452D5C272e8230F3B0",
    surface: "iTRY/WITRY/wiTRY identity; EIP-1967 proxy; decimals 18",
    classification: "public-static-address-not-live-state-proof",
  },
  {
    role: "Brix public implementation for iTry proxy",
    chain: "Ethereum",
    address: "0x0679EAa2443e5fEA70Eea7aC9508fD357406FdAD",
    surface: "verified implementation/function-role context",
    classification: "public-static-implementation-not-live-state-proof",
  },
];

const SURFACE_ROWS = [
  { component: "iTRY / WITRY / wiTRY identity", surface: "share/underlying ambiguity and token role resolution", routeRole: "producer asset identity", watchTerms: ["iTRY", "wiTRY", "WITRY", TARGET.underlyingTokenFromDiscovery] },
  { component: "ERC4626 / StakediTry vaults", surface: "convertToAssets/convertToShares/totalAssets accounting", routeRole: "vault share rate and donation sensitivity", watchTerms: ["ERC4626", "StakediTry", "convertToAssets", "totalAssets", "MIN_SHARES"] },
  { component: "FastAccessVault / Fast redeem", surface: "same-block or fast redemption liquidity", routeRole: "redeem/unwind exit", watchTerms: ["FastAccessVault", "StakediTryFastRedeem", "redeem", "cooldown"] },
  { component: "YieldForwarder / strategy accounting", surface: "yield allocator, NAV, and rate updates", routeRole: "rate/strategy accounting producer", watchTerms: ["YieldForwarder", "NAV", "DLF", "Digital Liquidity Fund"] },
  { component: "Proof of reserves / backing", surface: "off-chain backing, oracle, and reserve assertions", routeRole: "NAV/backing proof gap", watchTerms: ["Accountable", "proof of reserves", "RedStone", "Zodia"] },
  { component: "Issuer/minter roles", surface: "unbacked mint or privileged supply mutation", routeRole: "producer-side authority blocker", watchTerms: ["iTryIssuer", "MINTER_CONTRACT", "mint", "burn", "rescueToken"] },
  { component: "Transfer-state restrictions", surface: "blacklist/whitelist/transfer state", routeRole: "transferability and liquidation gate", watchTerms: ["transferState", "BLACKLISTED_ROLE", "WHITELISTED_ROLE", "redistributeLockedAmount"] },
  { component: "Cross-chain OFT / LayerZero", surface: "OFT adapters/composers and cross-chain share movement", routeRole: "bridge/finality/custody context", watchTerms: ["iTryTokenOFT", "wiTryOFT", "LayerZero", "wiTryVaultComposer", "UnstakeMessenger"] },
  { component: "Consumers / exits", surface: "lending/oracle/DEX/settlement joins", routeRole: "borrow/redeem/unwind economics", watchTerms: ["Morpho", "Aave", "Euler", "Silo", "Compound", "DEX", "Uniswap", "Curve", "Balancer"] },
];

const PUBLIC_DOCS = [
  "https://brix.money/",
  "https://docs.brix.money/",
  "https://app.brix.money/",
  "https://accountable.brix.money/",
  "https://github.com/InverterNetwork",
  "https://github.com/code-423n4/2025-11-brix-money",
  "https://code4rena.com/audits/2025-11-brix-money",
  "https://etherscan.io/token/0xb492B4aFD9658093694CF9452D5C272e8230F3B0",
  "https://repo.sourcify.dev/1/0xb492B4aFD9658093694CF9452D5C272e8230F3B0",
  "https://etherscan.io/address/0x0679EAa2443e5fEA70Eea7aC9508fD357406FdAD#code",
];

const BUG_CLASS_ROWS = [
  { label: "ERC4626 share-rate manipulation or rounding", surface: "convertToAssets/convertToShares/preview functions", classification: "bug-class-context-no-current-route-proof" },
  { label: "MIN_SHARES griefing or first-deposit inflation", surface: "StakediTry/FastAccessVault share math", classification: "bug-class-context-no-current-route-proof" },
  { label: "insufficient backing or stale NAV", surface: "Accountable/proof-of-reserves/DLF accounting", classification: "bug-class-context-no-current-route-proof" },
  { label: "oracle scale/freshness failure", surface: "RedStone/oracle price path", classification: "bug-class-context-no-current-route-proof" },
  { label: "transfer-state, blacklist, or whitelist bypass/overblocking", surface: "iTry transfer gates", classification: "bug-class-context-no-current-route-proof" },
  { label: "unbacked minting through issuer/minter role", surface: "iTryIssuer/MINTER_CONTRACT", classification: "bug-class-context-no-current-route-proof" },
  { label: "fast redemption liquidity exhaustion", surface: "FastAccessVault/StakediTryFastRedeem", classification: "bug-class-context-no-current-route-proof" },
  { label: "cooldown accounting mismatch", surface: "StakediTryCooldown", classification: "bug-class-context-no-current-route-proof" },
  { label: "cross-chain OFT/LayerZero failure", surface: "OFT adapters/composer/messenger", classification: "bug-class-context-no-current-route-proof" },
  { label: "rescue or redistribution affects supply/accounting", surface: "rescueToken/redistributeLockedAmount", classification: "bug-class-context-no-current-route-proof" },
  { label: "consumer misprices restricted or illiquid shares", surface: "lending/oracle/DEX consumer", classification: "bug-class-context-no-current-route-proof" },
  { label: "iTRY backing below 1:1 on NAV drop", surface: "backing/NAV/consumer accepted value", classification: "bug-class-context-no-current-route-proof" },
];

const SOURCE_FACTS = [
  {
    sourceLabel: "local-prefilter-discovery-json:2026-06-24:1194-1232",
    kind: "local-discovery-json",
    slug: TARGET.slug,
    name: TARGET.name,
    category: TARGET.category,
    poolId: TARGET.poolId,
    chain: "Ethereum",
    symbol: TARGET.discoverySymbol,
    surface: TARGET.surface,
    tvlContext: TARGET.tvlContext,
    apyContext: TARGET.apyContext,
    stablecoin: TARGET.stablecoin,
    ilRisk: TARGET.ilRisk,
    underlyingToken: TARGET.underlyingTokenFromDiscovery,
    routePositive: 0,
    classification: "structured-target-seed-route-negative",
  },
  {
    sourceLabel: "local-public-audit-target-discovery:11119-11144",
    kind: "local-discovery-json",
    poolId: TARGET.poolId,
    symbol: TARGET.discoverySymbol,
    underlyingToken: TARGET.underlyingTokenFromDiscovery,
    tvlContext: TARGET.earlierDiscoveryTvlContext,
    apyContext: TARGET.earlierDiscoveryApyContext,
    classification: "earlier-target-seed-route-negative",
  },
  {
    sourceLabel: "prefilter-deep-search-ranks-11-20-assessment:17-24",
    kind: "local-markdown-context",
    finding: "Brix was previously treated as small/below materiality; this scanner refreshes it as a bounded full-test target without promoting route-positive status.",
    classification: "prior-materiality-context-not-route-proof",
  },
  {
    sourceLabel: "official-public-docs-pages-and-audit-repos",
    kind: "public-static-label",
    urls: PUBLIC_DOCS,
    classification: "allowed-public-doc-url-context-no-fetch-in-this-run",
  },
  {
    sourceLabel: "public-token-proxy-implementation-labels",
    kind: "public-static-label",
    tokenProxy: TARGET.underlyingTokenFromDiscovery,
    implementation: TARGET.implementation,
    tokenNamePublic: TARGET.tokenNamePublic,
    decimals: 18,
    classification: "static-token-proxy-labels-no-live-state-proof",
  },
  {
    sourceLabel: "verified-implementation-function-role-surface",
    kind: "public-static-label",
    functionsAndRoles: ["totalSupply", "balanceOf", "transfer", "transferFrom", "approve", "permit", "mint", "burn", "burnFrom", "DEFAULT_ADMIN_ROLE", "MINTER_CONTRACT", "BLACKLISTED_ROLE", "WHITELISTED_ROLE", "updateTransferState", "rescueToken", "redistributeLockedAmount"],
    classification: "verified-abi-surface-no-permissionless-value-proof",
  },
  {
    sourceLabel: "public-code4rena-audit-scope",
    kind: "public-static-label",
    scopeContracts: ["iTryIssuer.sol", "FastAccessVault.sol", "YieldForwarder.sol", "iTry.sol", "StakediTry.sol", "StakediTryCooldown.sol", "StakediTryFastRedeem.sol", "StakediTryCrosschain.sol", "iTryTokenOFT", "iTryTokenOFTAdapter", "wiTryOFT", "wiTryOFTAdapter", "wiTryVaultComposer", "UnstakeMessenger"],
    classification: "public-audit-scope-context-no-current-deployed-route-proof",
  },
  {
    sourceLabel: "product-model-public-static-context",
    kind: "public-static-label",
    model: "iTRY Turkish Lira stablecoin backed by Turkish Lira money-market funds/DLF with wiTRY yield-bearing counterpart and proof-of-reserves context.",
    counterpartiesAndServices: ["Accountable", "Zodia", "Circle", "RedStone", "LayerZero"],
    classification: "product-model-context-no-live-state-proof",
  },
  {
    sourceLabel: "local-vault-erc4626-consumer-artifacts",
    kind: "local-artifact-context",
    artifacts: [
      "reports/raw/fast/erc4626-consumer-joiner.json",
      "reports/raw/fast/critical-erc4626-consumer-donation-review.json",
      "reports/raw/fast/consumer-first-high-ltv-collateral.json",
      "reports/raw/fast/aave-euler-silo-consumer-graph.json",
      "reports/raw/fast/euler-v2-phase0.json",
      "reports/raw/fast/silo-v2-phase0.json",
      "reports/raw/fast/compound-v3-phase0.json",
    ],
    classification: "local-consumer-context-only-no-brix-route-positive",
  },
  {
    sourceLabel: "local-dex-exit-context",
    kind: "local-artifact-context",
    artifacts: [
      "reports/raw/fast/morpho-exit-liquidity-stress.json",
      "reports/raw/fast/morpho-high-apy-liquidation-routes.json",
      "reports/raw/fast/morpho-pyth-unsafe-consumers.json",
      "reports/raw/fast/dex-exit-quotes.json",
      "reports/raw/fast/dex-consumer-routes.json",
      "reports/raw/fast/curve-dex-phase0.json",
      "reports/raw/fast/balancer-v3-phase0.json",
      "reports/raw/fast/uniswap-v2-phase0.json",
      "reports/raw/fast/uniswap-v3-phase0.json",
    ],
    classification: "exit-context-only-no-brix-exact-economics",
  },
];

const STATIC_CONTEXT_ROWS = [
  { sourceLabel: "discovery-target-row", matched: "Brix WITRY pool and token seed", categories: ["vaultShare", "underlyingToken", "shareRate", "navBacking"], sample: `rank=19 pool=${TARGET.poolId} chain=Ethereum symbol=WITRY tvl=${TARGET.tvlContext} apy=${TARGET.apyContext} underlying=${TARGET.underlyingTokenFromDiscovery}`, classification: "static-target-seed-no-route-positive" },
  { sourceLabel: "public-token-proxy-row", matched: "iTRY / WITRY token proxy", categories: ["underlyingToken", "transferRestriction", "roleAdmin"], sample: `target token/proxy ${TARGET.underlyingTokenFromDiscovery}; public name iTry/iTRY; discovery symbol WITRY; decimals 18`, classification: "static-token-identity-ambiguous-no-live-state-proof" },
  { sourceLabel: "public-implementation-row", matched: "iTry implementation functions and roles", categories: ["roleAdmin", "transferRestriction"], sample: `implementation ${TARGET.implementation}; mint/burn/roles/transferState/rescue/redistribute surfaces`, classification: "static-implementation-surface-no-permissionless-proof" },
  { sourceLabel: "code4rena-scope-row", matched: "Brix vault and issuer scope", categories: ["vaultShare", "erc4626Probe", "redemption", "crossChain", "donationRisk", "shareRate"], sample: "iTryIssuer, FastAccessVault, YieldForwarder, StakediTry, cooldown/fastRedeem/crosschain/OFT scope", classification: "public-audit-scope-context-no-current-route-proof" },
  { sourceLabel: "proof-of-reserves-row", matched: "Accountable / RedStone / DLF backing context", categories: ["oracle", "navBacking", "shareRate"], sample: "Accountable proof-of-reserves, RedStone oracle, DLF/money-market-fund backing context; not a live NAV proof in this run", classification: "public-backing-context-no-live-state-proof" },
  { sourceLabel: "route-gap-row", matched: "vault share -> accounting -> consumer/exit", categories: ["consumerJoin", "dexLiquidity", "exitLiquidity", "economics"], sample: "No exact share-rate anomaly, material consumer acceptance, DEX/redeem liquidity, or positive route economics was proven from local artifacts", classification: "route-gap-fail-closed" },
].map((row) => ({
  rowSource: "static-public-fact",
  matchType: "static-public-fact",
  termType: "static",
  routePositive: 0,
  sourceRoutePositiveNotPromoted: false,
  ...row,
}));

const EXPLICIT_FILES = [
  "reports/raw/fast/prefilter-deep-new-target-search-2026-06-24.json",
  "reports/raw/fast/public-audit-target-discovery.json",
  "reports/prefilter-deep-search-ranks-11-20-assessment-2026-06-27.md",
  "reports/raw/defillama-filtered-top.json",
  "reports/raw/defillama-scored-candidates.json",
  "reports/raw/defillama-flashloan-top25.json",
  "reports/raw/fast/erc4626-consumer-joiner.json",
  "reports/raw/fast/critical-erc4626-consumer-donation-review.json",
  "reports/raw/fast/new-vault-donation-attack.json",
  "reports/raw/fast/erc4626-v4-hook-overlaps.json",
  "reports/raw/fast/consumer-first-high-ltv-collateral.json",
  "reports/raw/fast/aave-euler-silo-consumer-graph.json",
  "reports/raw/fast/euler-v2-phase0.json",
  "reports/raw/fast/silo-v2-phase0.json",
  "reports/raw/fast/compound-v3-phase0.json",
  "reports/raw/fast/morpho-exit-liquidity-stress.json",
  "reports/raw/fast/morpho-high-apy-liquidation-routes.json",
  "reports/raw/fast/morpho-pyth-unsafe-consumers.json",
  "reports/raw/fast/morpho-wrapper-exit-proof-gaps.json",
  "reports/raw/fast/morpho-liquidatable-marketability.json",
  "reports/raw/fast/dex-exit-quotes.json",
  "reports/raw/fast/dex-consumer-routes.json",
  "reports/raw/fast/curve-dex-phase0.json",
  "reports/raw/fast/balancer-v3-phase0.json",
  "reports/raw/fast/uniswap-v2-phase0.json",
  "reports/raw/fast/uniswap-v3-phase0.json",
  "reports/raw/fast/oracle-staleness-cross-ref.json",
  "reports/raw/fast/layerzero-oft-dvn-consumer-joins.json",
  "reports/raw/fast/bridge-nonlossless-collateral-join.json",
  "reports/raw/fast/bridge-lending-collateral-join.json",
  "reports/raw/fast/public-lead-consumer-joins.json",
  "reports/raw/fast/public-lead-compound-like-routes.json",
];

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const ADDRESS_RULES = ADDRESS_SEEDS.map((row) => ({ label: `${row.role} ${row.address}`, regex: new RegExp(escapeRegExp(row.address), "i") }));

const EXACT_RULES = [
  { label: "Brix", regex: /\bBrix\b/i },
  { label: "brix", regex: /\bbrix\b/i },
  { label: "brix.money", regex: /\bbrix\.money\b/i },
  { label: "WITRY", regex: /\bWITRY\b/i },
  { label: "wiTRY", regex: /\bwiTRY\b/i },
  { label: "iTRY", regex: /\biTRY\b/i },
  { label: "iTry", regex: /\biTry\b/i },
  { label: "StakediTry", regex: /\bStakediTry\b/i },
  { label: "iTryIssuer", regex: /\biTryIssuer\b/i },
  { label: "FastAccessVault", regex: /\bFastAccessVault\b/i },
  { label: "YieldForwarder", regex: /\bYieldForwarder\b/i },
  { label: "StakediTryCooldown", regex: /\bStakediTryCooldown\b/i },
  { label: "StakediTryFastRedeem", regex: /\bStakediTryFastRedeem\b/i },
  { label: "StakediTryCrosschain", regex: /\bStakediTryCrosschain\b/i },
  { label: "iTryTokenOFT", regex: /\biTryTokenOFT\b/i },
  { label: "iTryTokenOFTAdapter", regex: /\biTryTokenOFTAdapter\b/i },
  { label: "wiTryOFT", regex: /\bwiTryOFT\b/i },
  { label: "wiTryOFTAdapter", regex: /\bwiTryOFTAdapter\b/i },
  { label: "wiTryVaultComposer", regex: /\bwiTryVaultComposer\b/i },
  { label: "UnstakeMessenger", regex: /\bUnstakeMessenger\b/i },
  { label: "MINTER_CONTRACT", regex: /\bMINTER_CONTRACT\b/i },
  { label: "BLACKLISTED_ROLE", regex: /\bBLACKLISTED_ROLE\b/i },
  { label: "WHITELISTED_ROLE", regex: /\bWHITELISTED_ROLE\b/i },
  { label: "transferState", regex: /\btransferState\b/i },
  { label: "redistributeLockedAmount", regex: /\bredistributeLockedAmount\b/i },
  { label: "rescueToken", regex: /\brescueToken\b/i },
  { label: TARGET.poolId, regex: new RegExp(escapeRegExp(TARGET.poolId), "i") },
  ...ADDRESS_RULES,
];

const CONTEXT_RULES = [
  { label: "vault/share", regex: /\b(?:vault|share|shares|staking|staked|yield[-\s]?bearing)\b/i },
  { label: "ERC4626", regex: /\b(?:ERC[-_]?4626|convertToAssets|convertToShares|previewRedeem|previewWithdraw|totalAssets|asset\(\))\b/i },
  { label: "share rate", regex: /\b(?:share[-\s]?rate|exchange[-\s]?rate|price[-\s]?per[-\s]?share|pps|rate|APY|yield|strategy|allocator)\b/i },
  { label: "donation/rounding", regex: /\b(?:donation|inflate|inflation|rounding|MIN_SHARES|first[-\s]?deposit|grief)\b/i },
  { label: "oracle/NAV/backing", regex: /\b(?:oracle|NAV|proof[-\s]?of[-\s]?reserves?|reserve|backing|DLF|money[-\s]?market|RedStone|Accountable|Zodia)\b/i },
  { label: "transfer restriction", regex: /\b(?:transferState|blacklist|blacklisted|whitelist|whitelisted|restricted|paused|frozen|locked|cooldown|allowlist)\b/i },
  { label: "role/admin", regex: /\b(?:role|admin|owner|issuer|minter|MINTER_CONTRACT|DEFAULT_ADMIN_ROLE|rescue|redistribute|upgrade|proxy|implementation)\b/i },
  { label: "redemption", regex: /\b(?:redeem|redemption|withdraw|unstake|cooldown|fast\s*redeem|FastAccessVault|liquidity\s+exhaustion)\b/i },
  { label: "cross-chain", regex: /\b(?:OFT|LayerZero|cross[-\s]?chain|adapter|composer|messenger|bridge|endpoint|DVN)\b/i },
  { label: "consumer", regex: /\b(?:consumer|collateral|borrow|lending|Morpho|Aave|Euler|Silo|Compound|oracle)\b/i },
  { label: "DEX/exit", regex: /\b(?:DEX|swap|pool|liquidity|Uniswap|Curve|Balancer|exit|unwind|slippage)\b/i },
  { label: "routePositive", regex: /\broutePositive\b/i },
];

const CATEGORY_RULES = {
  vaultShare: ["vault", "share", "shares", "erc4626", "stakeditry", "fastaccessvault", "yield-bearing", "witry", "wtry"],
  underlyingToken: ["itry", "witry", "underlying", TARGET.underlyingTokenFromDiscovery.toLowerCase(), "turkish lira", "stablecoin", "token/proxy"],
  erc4626Probe: ["erc4626", "converttoassets", "converttoshares", "previewredeem", "previewwithdraw", "maxwithdraw", "maxredeem", "totalassets", "asset()"],
  shareRate: ["share-rate", "share rate", "exchange-rate", "price per share", "pps", "converttoassets", "totalassets", "apy", "yield", "yieldforwarder", "strategy", "nav"],
  donationRisk: ["donation", "inflation", "rounding", "min_shares", "first-deposit", "first deposit", "grief"],
  oracle: ["oracle", "redstone", "feed", "price", "scale", "freshness", "stale", "accountable"],
  navBacking: ["nav", "backing", "reserve", "proof-of-reserves", "proof of reserves", "accountable", "dlf", "digital liquidity fund", "money market", "zodia"],
  transferRestriction: ["transferstate", "blacklisted_role", "whitelisted_role", "blacklist", "whitelist", "restricted", "paused", "frozen", "locked", "cooldown", "allowlist"],
  roleAdmin: ["role", "admin", "owner", "issuer", "minter", "minter_contract", "default_admin_role", "mint", "burn", "rescuetoken", "redistributelockedamount", "proxy", "implementation", "upgrade"],
  redemption: ["redeem", "redemption", "withdraw", "unstake", "cooldown", "fast redeem", "fastredeem", "fastaccessvault", "exit"],
  crossChain: ["oft", "layerzero", "crosschain", "cross-chain", "adapter", "composer", "unstakemessenger", "bridge", "dvn"],
  consumerJoin: ["consumer", "collateral", "borrow", "lending", "reserve", "accepted", "morpho", "aave", "euler", "silo", "compound"],
  dexLiquidity: ["dex", "swap", "pool", "liquidity", "curve", "balancer", "uniswap", "slippage"],
  exitLiquidity: ["exit", "unwind", "redeem", "redemption", "withdraw", "unstake", "swap", "liquidity", "fast redeem"],
  economics: ["routepositive", "executable", "profit", "netbps", "positive", "liquidityusd", "tvl", "apy", "exacteconomics", "forkproof"],
};

const BLOCKERS = [
  "No exact-positive Brix vault share -> rate/strategy accounting -> consumer or exit venue -> borrow/redeem/unwind route is proven in local artifacts; address rows are static seeds only.",
  "The discovery token/proxy address maps to public iTry/iTRY context while the pool symbol uses WITRY and docs use iTRY/wiTRY, so exact share-vs-underlying identity remains unresolved for route purposes.",
  "No current ERC4626 share-rate, donation, rounding, totalAssets, or convertToAssets anomaly is quantified against a material accepted-value consumer.",
  "No Brix-specific lending/oracle consumer row proves current collateral acceptance, caps, cash/borrow capacity, oracle freshness, and borrower-side overvaluation.",
  "No DEX, fast redemption, cooldown, or permissionless redeem exit has exact route-size liquidity and positive unwind economics after fees, slippage, gas, locks, and transfer restrictions.",
  "Transfer-state, blacklist/whitelist, cooldown, fast-redeem, issuer/minter, rescue, redistribution, and proxy/admin roles remain blockers until current state proves they do not gate the route.",
  "Accountable/proof-of-reserves, DLF backing, RedStone oracle, and partner labels are public context only; they do not prove live NAV, backing, oracle freshness, or consumer accepted value in this bounded pass.",
  "Cross-chain OFT/LayerZero scope is architectural risk context only; no current peer/config/finality/custody bypass with liquid value is proven.",
  "Prior below-materiality assessment is not a route proof and is not promoted without exact current economics.",
  "No endpoint inventory was read and no live eth_call/fork refresh was performed in this bounded pass, so route gate stays fail-closed.",
  "Fork and signed-action gates remain closed because routePositive=0 and exactEconomicsRows=0.",
];

const REQUIRED_FOR_ROUTE_POSITIVE = [
  "Exact producer asset: identify the precise Brix iTRY/wiTRY/WITRY vault share or underlying token, its proxy/implementation, decimals, asset(), totalSupply, totalAssets, and current share/underlying role.",
  "ERC4626/share-rate proof: quantify convertToAssets/convertToShares/previewRedeem/previewWithdraw/totalAssets/share supply behavior, donation/rounding sensitivity, MIN_SHARES effects, and limits for the exact asset.",
  "Exact consumer/exit join: prove the same Brix share/token is accepted by a material lending/oracle/settlement consumer or has immediate permissionless redeem/fast-redeem/DEX exit liquidity at route size.",
  "NAV/backing/oracle proof: resolve Accountable/DLF/RedStone/backing path, decimals, freshness, authority, and whether a trusted external consumer uses that value.",
  "Transferability proof: transferState, blacklist/whitelist, cooldown, fast-redeem, lock, pause, OFT/bridge, and transfer restrictions must not block acquisition, collateralization, liquidation, redemption, or exit.",
  "Role/admin proof: issuer/minter, DEFAULT_ADMIN_ROLE, MINTER_CONTRACT, rescueToken, redistributeLockedAmount, proxy/admin, and upgrade controls must not be required for the attacker path.",
  "Positive economics: accepted value must exceed exact acquisition, redemption, borrow/liquidation, or DEX unwind value after LTV/LLTV haircuts, fees, slippage, cooldown/queue delays, locks, caps, and gas.",
  "Local static/fork value-delta proof must show positive attacker-controlled balance movement before routePositive, forkJustified, or signedActionJustified can change.",
  "Explicit route-specific authorization and independent defensive review are required before any signed transaction path is discussed.",
];

const NEXT_READ_ONLY_STEP = "Keep Brix dormant unless the exact iTRY/wiTRY/WITRY vault share or underlying token maps to a material consumer or permissionless redeem/DEX exit; then refresh sanitized read-only state for ERC4626 share-rate, donation/rounding sensitivity, NAV/backing/oracle freshness, transfer-state/role gates, redemption liquidity, and exact exit economics before any fork/static proof.";

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
  if (r === "tools/scan-brix-full-test.js") return true;
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
  return listFilesRecursive(fast, (file) => /(?:erc4626|vault|donation|share|consumer|aave|euler|silo|compound|morpho-|dex|exit|curve|balancer|uniswap|oracle|layerzero|oft|bridge|brix|itry|witry)/i.test(path.basename(file)));
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
  if (r.includes("prefilter-deep-new-target-search") || r.includes("public-audit-target-discovery")) return "discovery-context-only-no-route-positive";
  if (r.includes("prefilter-deep-search-ranks-11-20")) return "prior-assessment-context-only-no-current-route-proof";
  if (r.includes("erc4626") || r.includes("vault") || r.includes("donation")) return "erc4626-vault-context-only-no-brix-exact-route";
  if (r.includes("morpho") || r.includes("aave") || r.includes("euler") || r.includes("silo") || r.includes("compound")) return "consumer-artifact-context-only-no-brix-exact-route";
  if (r.includes("curve") || r.includes("balancer") || r.includes("uniswap") || r.includes("dex") || r.includes("exit")) return "dex-exit-context-only-no-brix-exact-economics";
  if (r.includes("bridge") || r.includes("layerzero") || r.includes("oft")) return "cross-chain-context-only-no-brix-proof-bypass";
  if (categories.includes("consumerJoin") || categories.includes("dexLiquidity") || categories.includes("exitLiquidity") || categories.includes("oracle")) return "consumer-or-exit-context-only-no-positive-economics";
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

function consumerMetricContextOnly(row) {
  return discoveryContextOnly(row) || /^(?:route-gap-fail-closed|static-|public-.*context|local-.*context|prior-)/i.test(row.classification || "");
}

function selectNotableRows(rows) {
  const priority = [];
  const files = new Set();
  for (const row of rows) {
    const key = row.file || row.sourceLabel || row.matched;
    const cats = row.categories || [];
    if (row.rowSource === "static-public-fact" || exactish(row) || cats.some((cat) => ["vaultShare", "underlyingToken", "erc4626Probe", "shareRate", "donationRisk", "oracle", "navBacking", "transferRestriction", "roleAdmin", "redemption", "crossChain", "consumerJoin", "dexLiquidity", "exitLiquidity"].includes(cat))) {
      if (!files.has(key) || exactish(row) || row.rowSource === "static-public-fact") {
        priority.push(row);
        files.add(key);
      }
    }
    if (priority.length >= 42) break;
  }
  return priority.length ? priority : rows.slice(0, 22);
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
  for (const category of Object.keys(CATEGORY_RULES)) categoryRows[`${category}Rows`] = pickRows(combinedRows, (row) => row.categories.includes(category), 170);
  const discoveryContextRows = localRows.filter(discoveryContextOnly).length;
  const consumerJoinRows = pickRows(
    combinedRows,
    (row) => !consumerMetricContextOnly(row) && row.categories.includes("consumerJoin"),
    190,
  );
  const exactConsumerJoinRows = pickRows(
    consumerJoinRows,
    (row) => exactish(row) && !/discovery|prior-assessment|static/i.test(row.classification || "") && /\b(?:consumer|collateral|borrow|lending|accepted|morpho|aave|euler|silo|compound)\b/i.test(`${row.file || ""} ${row.sample || ""}`),
    150,
  );
  const notableRows = selectNotableRows(combinedRows);
  const priorArtifactPositiveRowsNotPromoted = localRows.filter((row) => row.sourceRoutePositiveNotPromoted).length;
  const exactEconomicsRows = 0;
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
    surfaceRows: SURFACE_ROWS.length,
    publicDocRows: PUBLIC_DOCS.length,
    bugClassRows: BUG_CLASS_ROWS.length,
    staticContextRows: STATIC_CONTEXT_ROWS.length,
    filesScanned: lineScan.filesScanned,
    filesWithLocalMatches: lineScan.filesWithMatch,
    filesWithExactLocalMatches: lineScan.filesWithExact,
    localArtifactMatchRows: localRows.length,
    exactLocalArtifactMatchRows: exactRows.length,
    localLineRows: lineScan.rows.length,
    discoveryContextRows,
    vaultShareRows: categoryRows.vaultShareRows.length,
    underlyingTokenRows: categoryRows.underlyingTokenRows.length,
    erc4626ProbeRows: categoryRows.erc4626ProbeRows.length,
    shareRateRows: categoryRows.shareRateRows.length,
    donationRiskRows: categoryRows.donationRiskRows.length,
    oracleRows: categoryRows.oracleRows.length,
    navBackingRows: categoryRows.navBackingRows.length,
    transferRestrictionRows: categoryRows.transferRestrictionRows.length,
    roleAdminRows: categoryRows.roleAdminRows.length,
    redemptionRows: categoryRows.redemptionRows.length,
    crossChainRows: categoryRows.crossChainRows.length,
    consumerJoinRows: consumerJoinRows.length,
    exactConsumerJoinRows: exactConsumerJoinRows.length,
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
    scanner: "tools/scan-brix-full-test.js",
    target: TARGET,
    scope: {
      kind: "bounded defensive/read-only full-test scanner",
      artifactStaticLocalFirst: true,
      publicFactsOnly: true,
      evmFirst: true,
      evmFirstChains: CHAIN_SEEDS.map((row) => row.chainLabel),
      caveatChains: [],
      routeGraph: TARGET.routeGraph,
      writesLimitedTo: [OUT_JSON_REL, OUT_MD_REL],
      coordinatorClaim: "fixer-brix-fulltest-01",
      aggregatePromotionStateHandoffEdited: false,
      endpointPolicy: "No endpoint inventory was read; no raw endpoints, domains, keys, or tokens are persisted.",
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
    discoveredSeeds: { chainSeeds: CHAIN_SEEDS, addressSeedRows: ADDRESS_SEEDS, surfaceRows: SURFACE_ROWS },
    staticContextRows: STATIC_CONTEXT_ROWS,
    localArtifacts: {
      filesScanned: lineScan.filesScanned,
      filesWithMatch: lineScan.filesWithMatch,
      filesWithExact: lineScan.filesWithExact,
      categoryCounts: lineScan.categoryCounts,
      rows: localRows,
      exactRows: exactRows.slice(0, 190),
      notableRows,
    },
    categoryRows: { ...categoryRows, consumerJoinRows, exactConsumerJoinRows },
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
      reason: "Static/local scan found Brix discovery, public proxy/implementation, ERC4626/vault, role/transfer, proof-of-reserves/oracle, redemption, cross-chain, and consumer/exit context rows only; no current exact permissionless value movement, positive economics, or local/fork/static value-delta proof is present.",
    },
    blockers: BLOCKERS,
    requiredForRoutePositive: REQUIRED_FOR_ROUTE_POSITIVE,
    nextReadOnlyStep: NEXT_READ_ONLY_STEP,
    summary,
  };
}

function metricRows(summary) {
  const keys = [
    "sourceFactRows", "chainSeedRows", "addressSeedRows", "surfaceRows", "publicDocRows", "bugClassRows", "staticContextRows", "filesScanned", "filesWithLocalMatches", "filesWithExactLocalMatches", "localArtifactMatchRows", "exactLocalArtifactMatchRows", "vaultShareRows", "underlyingTokenRows", "erc4626ProbeRows", "shareRateRows", "donationRiskRows", "oracleRows", "navBackingRows", "transferRestrictionRows", "roleAdminRows", "redemptionRows", "crossChainRows", "consumerJoinRows", "exactConsumerJoinRows", "dexLiquidityRows", "exitLiquidityRows", "economicsContextRows", "producerAnomalies", "watchCandidates", "priorArtifactPositiveRowsNotPromoted", "publicFetchRows", "rpcInventoryRows", "graphqlInventoryRows", "ethCallRows", "forkRows", "exactEconomicsRows", "routePositive", "executableNow", "signedActionJustified", "forkJustified", "forkGate", "fullTestReadOnlyComplete",
  ];
  return keys.map((key) => `| ${key} | ${mdEscape(summary[key])} |`).join("\n");
}

function safetyRows(safety) {
  const keys = [
    "localArtifactsRead", "publicSourcesRead", "publicNetworkFetch", "endpointInventoryRead", "rpcInventoryRead", "graphqlInventoryRead", "envFilesRead", "privateKeysRead", "keyMaterialRead", "rawEndpointUrlsStored", "rpcUrlsStored", "rawUrlsStored", "rawDomainsStored", "rawKeysTokensStored", "signedActions", "liveTransactions", "broadcasts", "walletOperations", "forkTransactions", "sanitizedOutputOnly", "secretLikePathsExcluded",
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
  const bugClassRows = payload.bugClasses.map(formatBugClassRow).join("\n");
  const docRows = payload.publicDocs.map((url) => `- ${url}`).join("\n");

  return `# 🟢 DORMANT - Brix Full Test

Generated: ${payload.generatedAt}

Route remains closed: routePositive=${payload.routeGate.routePositive}, executableNow=${payload.routeGate.executableNow}, signedActionJustified=${payload.routeGate.signedActionJustified}, forkJustified=${payload.routeGate.forkJustified}, forkGate=${payload.routeGate.forkGate}.

## Summary

| Metric | Value |
|---|---:|
${metricRows(payload.summary)}

## Target / Scope

- Target: ${payload.target.name} (${payload.target.slug}), kind=${payload.target.kind}, category=${payload.target.category}, surface=${payload.target.surface}, rank≈${payload.target.discoveryRank}, pool=${payload.target.poolId}, TVL context≈${payload.target.tvlContext}, APY context≈${payload.target.apyContext}.
- EVM chains: ${payload.scope.evmFirstChains.join(", ")}; caveat chains: none from discovery row.
- Route graph: ${payload.target.routeGraph}.
- Token/proxy seed: ${payload.target.underlyingTokenFromDiscovery}; implementation seed: ${payload.target.implementation}; public name/symbol context=${payload.target.tokenNamePublic}; discovery symbol=${payload.target.discoverySymbol}.
- Symbol ambiguity: ${payload.target.symbolAmbiguity}
- Writes limited to: ${payload.scope.writesLimitedTo.join(", ")}.

## Safety

| Field | Value |
|---|---:|
${safetyRows(payload.safety)}

## Public Static Docs / Deployment Facts (allowed URL context; not fetched here)

${docRows}

## Address Rows (static, not live state proof)

| Role | Chain | Address | Surface | Classification |
|---|---|---|---|---|
${addressRows}

## Surface Rows

| Component | Surface | Route Role | Watch Terms |
|---|---|---|---|
${surfaceRows}

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
- No exact Brix share-rate, donation, NAV/backing, consumer acceptance, or exit-liquidity route was resolved with positive economics.
- Local ERC4626, lending, DEX, bridge/OFT, oracle, and public-audit rows are not promoted without a Brix-specific exact consumer/exit join and current economics.
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
  log("Scanning Brix local artifacts (sanitized, no endpoint inventory read)...");
  const files = listScanFiles();
  const lineScan = scanLocalArtifactLines(files);
  const payload = buildPayload({ lineScan });
  writeJson(OUT_JSON, payload);
  writeText(OUT_MD, buildMarkdown(payload));
  log(`Wrote ${OUT_JSON_REL} and ${OUT_MD_REL}`);
  log(`routePositive=${payload.summary.routePositive}; exactEconomicsRows=${payload.summary.exactEconomicsRows}; localArtifactMatchRows=${payload.summary.localArtifactMatchRows}; exactConsumerJoinRows=${payload.summary.exactConsumerJoinRows}`);
}

main();
