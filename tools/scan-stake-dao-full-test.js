#!/usr/bin/env node
"use strict";

// scan-stake-dao-full-test.js
// Defensive Stake DAO full-test scanner. Static/local-first only; no endpoint
// inventory reads, network fetches, RPC calls, forks, signed actions, or wallets.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const REPORTS_DIR = path.join(WORKSPACE, "reports");
const OUT_JSON = path.join(RAW_DIR, "stake-dao-full-test.json");
const OUT_MD = path.join(REPORTS_DIR, "stake-dao-full-test-triage.md");
const OUT_JSON_REL = "reports/raw/fast/stake-dao-full-test.json";
const OUT_MD_REL = "reports/stake-dao-full-test-triage.md";

const QUIET = process.argv.includes("--quiet");
const GENERATED_AT = process.env.SCAN_GENERATED_AT || "2026-07-07T00:00:00.000Z";

const MAX_FILE_BYTES = 24 * 1024 * 1024;
const MAX_LOCAL_MATCH_ROWS = 760;
const MAX_ROWS_PER_FILE = 34;
const MAX_ALCHEMIX_SOLC_INPUTS = 260;

const TARGET = {
  slug: "stake-dao",
  name: "Stake DAO",
  kind: "protocol",
  category: "Yield",
  discoveryRank: 17,
  tvlContextUsd: 96_254_000,
  tvlContext: "$96.254M",
  surface: "vault-yield-allocator",
  primaryChains: ["Ethereum", "Base", "Arbitrum", "Polygon", "Optimism", "Avalanche", "Sonic", "Linea"],
  caveatChains: ["Fraxtal", "xDai/Gnosis"],
  routeGraph: "vault share -> rate/strategy accounting -> consumer or exit venue -> borrow/redeem/unwind",
  firstReadOnlyChecks: [
    "resolve vault/share token",
    "probe ERC4626/share-rate/donation semantics",
    "join shares to lending and DEX consumers",
  ],
  module: "stakedao/index.js",
  adapterFetched: true,
  adapterAddressCount: 6,
  adapterHints: ["oracle", "bridge/custody"],
};

const CHAIN_SEEDS = [
  { chain: "Ethereum", chainLabel: "Ethereum", chainId: 1, adapterKey: "ethereum", evmFirst: true, caveat: false, classification: "primary-evm-discovery-chain" },
  { chain: "Base", chainLabel: "Base", chainId: 8453, adapterKey: "base", evmFirst: true, caveat: false, classification: "primary-evm-discovery-chain" },
  { chain: "Arbitrum", chainLabel: "Arbitrum", chainId: 42161, adapterKey: "arbitrum", evmFirst: true, caveat: false, classification: "primary-evm-discovery-chain" },
  { chain: "Polygon", chainLabel: "Polygon", chainId: 137, adapterKey: "polygon", evmFirst: true, caveat: false, classification: "primary-evm-discovery-chain" },
  { chain: "Optimism", chainLabel: "Optimism", chainId: 10, adapterKey: "optimism", evmFirst: true, caveat: false, classification: "primary-evm-discovery-chain" },
  { chain: "Avalanche", chainLabel: "Avalanche", chainId: 43114, adapterKey: "avax", evmFirst: true, caveat: false, classification: "primary-evm-discovery-chain" },
  { chain: "Sonic", chainLabel: "Sonic", chainId: 146, adapterKey: "sonic", evmFirst: true, caveat: false, classification: "primary-evm-discovery-chain" },
  { chain: "Linea", chainLabel: "Linea", chainId: 59144, adapterKey: "linea", evmFirst: true, caveat: false, classification: "primary-evm-discovery-chain" },
  { chain: "Fraxtal", chainLabel: "Fraxtal", chainId: 252, adapterKey: "fraxtal", evmFirst: true, caveat: true, classification: "caveat-unless-safe-local-coverage" },
  { chain: "xDai/Gnosis", chainLabel: "xDai/Gnosis", chainId: 100, adapterKey: "xdai", evmFirst: true, caveat: true, classification: "caveat-unless-safe-local-coverage" },
];

const ADDRESS_SEEDS = [
  { role: "adapter sample 1", chain: "multi-chain", address: "0x98b540fa89690969D111D045afCa575C91519B1A", surface: "adapter/static-address", adapterSample: true, classification: "adapter-sample-static-not-live-state-proof" },
  { role: "adapter sample 2", chain: "multi-chain", address: "0x58900d761Ae3765B75DDFc235c1536B527F25d8F", surface: "adapter/static-address", adapterSample: true, classification: "adapter-sample-static-not-live-state-proof" },
  { role: "adapter sample 3", chain: "multi-chain", address: "0xaC14864ce5A98aF3248Ffbf549441b04421247D3", surface: "adapter/static-address", adapterSample: true, classification: "adapter-sample-static-not-live-state-proof" },
  { role: "adapter sample 4", chain: "multi-chain", address: "0x20D1b558Ef44a6e23D9BF4bf8Db1653626e642c3", surface: "adapter/static-address", adapterSample: true, classification: "adapter-sample-static-not-live-state-proof" },
  { role: "adapter sample 5", chain: "multi-chain", address: "0x0C30476f66034E11782938DF8e4384970B6c9e8a", surface: "adapter/static-address", adapterSample: true, classification: "adapter-sample-static-not-live-state-proof" },
  { role: "adapter sample 6", chain: "multi-chain", address: "0x73968b9a57c6E53d41345FD57a6E6ae27d6CDB2F", surface: "adapter/static-address", adapterSample: true, classification: "adapter-sample-static-not-live-state-proof" },
  { role: "LaPoste", chain: "Ethereum/Polygon/Arbitrum/Optimism/Base", address: "0xF0000058000021003E4754dCA700C766DE7601C2", surface: "bridge/cross-chain-message", classification: "public-static-same-address-deployment-row" },
  { role: "TokenFactory", chain: "multi-chain", address: "0x96006425Da428E45c282008b00004a00002B345e", surface: "sdtoken/token-factory", classification: "public-static-deployment-row" },
  { role: "Adapter", chain: "multi-chain", address: "0xbF0000F5C600B1a84FE08F8d0013002ebC0064fe", surface: "oracle/bridge-custody-adapter", classification: "public-static-deployment-row" },
  { role: "Reserve StakeDAO USDC/USDC+ gauge", chain: "Ethereum", address: "networkConfig['1'].tokens.sdUSDCUSDCPlus", surface: "gauge/collateral", classification: "local-config-symbolic-address" },
  { role: "Reserve USDC/USDC+ Curve pool", chain: "Ethereum", address: "0xf2b25362a03f6eacca8de8d5350a9f37944c1e59", surface: "curve-pool", classification: "local-static-address-row" },
  { role: "Reserve USDC/USDC+ Curve LP", chain: "Ethereum", address: "0xfed2B54453F75634bcdaEA5e5b11a3f99b9C28Fa", surface: "curve-lp", classification: "local-static-address-row" },
  { role: "Reserve USDC/USDC+ gauge holder", chain: "Ethereum", address: "0xC6625129C9df3314a4dd604845488f4bA62F9dB8", surface: "gauge-holder/test-fixture", classification: "local-static-address-row" },
];

const SURFACE_ROWS = [
  { component: "sdToken / LiquidLocker", surface: "sdToken mint/burn, locker/depositor accounting", routeRole: "producer share/token accounting", watchTerms: ["sdToken", "LiquidLocker", "Depositor", "sdCRV", "sdFXN", "sdBAL", "sdPENDLE"] },
  { component: "StakeDAO vault/strategy", surface: "vault-yield allocator", routeRole: "vault/share value and strategy accounting", watchTerms: ["Vault", "Strategy", "Harvester", "Accumulator"] },
  { component: "veSDT / vlSDT", surface: "locker/governance staking", routeRole: "locking, voting and reward constraints", watchTerms: ["veSDT", "vlSDT", "Locker"] },
  { component: "Gauge / GaugeController", surface: "liquidity gauge and reward accounting", routeRole: "stake/unstake/claim rewards", watchTerms: ["LiquidityGauge", "GaugeController", "claim_rewards", "reward_tokens"] },
  { component: "Curve pool / LP", surface: "Curve LP, virtual price, pool exit", routeRole: "exit liquidity and accepted-value reference", watchTerms: ["Curve", "get_virtual_price", "LP token", "gauge"] },
  { component: "Convex wrapper context", surface: "Convex reward/gauge wrapper integration", routeRole: "consumer or reward wrapper context", watchTerms: ["Convex", "Booster", "BaseRewardPool", "claimRewards"] },
  { component: "Votemarket oracle/verifier", surface: "campaign/oracle/verifier authorization", routeRole: "oracle/campaign message risk", watchTerms: ["Votemarket", "Campaign", "Oracle", "Verifier"] },
  { component: "LaPoste / OFT / TokenFactory", surface: "cross-chain transport and token factory", routeRole: "bridge/custody and peer config context", watchTerms: ["LaPoste", "TokenFactory", "OFT", "trustedPeer", "bridge"] },
  { component: "Reserve collateral plugin", surface: "external consumer of StakeDAO gauge", routeRole: "consumer join and oracle/collateral accounting", watchTerms: ["StakeDAORecursiveCollateral", "USDC_USDCPLUS_GAUGE", "claimRewards"] },
];

const PUBLIC_DOCS = [
  "https://docs.stakedao.org/",
  "https://www.stakedao.org/",
  "https://github.com/stake-dao",
  "https://github.com/stake-dao/contracts-monorepo",
  "https://github.com/stake-dao/offchain-registry",
  "https://github.com/stake-dao/stake-dao-security",
  "https://raw.githubusercontent.com/stake-dao/offchain-registry/main/data/address-book/address-book.json",
  "https://raw.githubusercontent.com/stake-dao/offchain-registry/main/data/votemarket/votemarkets.json",
];

const DISCLOSURE_ROWS = [
  { year: 2023, label: "wrong gauge implementation / authorization flaw", surface: "gauge/deployment authorization", classification: "historical-public-bug-class-not-current-route-proof" },
  { year: 2026, label: "cross-chain/oracle message authorization bypass", surface: "Votemarket oracle/verifier pipeline", classification: "historical-public-bug-class-not-current-route-proof" },
  { year: 2026, label: "privileged-role / OFT peer config failure causing unbacked minting risk", surface: "OFT peer and privileged config", classification: "historical-public-bug-class-not-current-route-proof" },
];

const SOURCE_FACTS = [
  {
    sourceLabel: "local-prefilter-discovery-json:2026-06-24:1085-1139",
    kind: "local-discovery-json",
    slug: TARGET.slug,
    name: TARGET.name,
    category: TARGET.category,
    surface: TARGET.surface,
    tvlContext: TARGET.tvlContext,
    chains: TARGET.primaryChains,
    blockedOrCaveatChains: TARGET.caveatChains,
    module: TARGET.module,
    adapterFetched: true,
    adapterAddressCount: 6,
    adapterHints: TARGET.adapterHints,
    routePositive: 0,
    classification: "structured-target-seed-route-negative",
  },
  {
    sourceLabel: "defillama-adapter-label:stakedao/index.js",
    kind: "public-static-label",
    module: TARGET.module,
    adapterFetched: true,
    adapterAddressCount: TARGET.adapterAddressCount,
    adapterHints: TARGET.adapterHints,
    classification: "source-label-only-no-live-state-proof",
  },
  {
    sourceLabel: "official-public-docs-and-repos",
    kind: "public-static-label",
    urls: PUBLIC_DOCS,
    classification: "allowed-public-doc-url-context-no-fetch-in-this-run",
  },
  {
    sourceLabel: "local-reserve-protocol-stakedao-collateral-plugin",
    kind: "local-source",
    artifacts: [
      "targets/reserve-protocol/contracts/plugins/assets/curve/stakedao/StakeDAORecursiveCollateral.sol",
      "targets/reserve-protocol/scripts/deployment/phase2-assets/collaterals/deploy_stakedao_usdc_usdcplus.ts",
      "targets/reserve-protocol/scripts/verification/collateral-plugins/verify_stakedao_usdc_usdcplus.ts",
    ],
    classification: "consumer-plugin-context-only-no-current-positive-economics",
  },
  {
    sourceLabel: "local-curve-convex-ccip-context",
    kind: "local-artifact-context",
    artifacts: ["reports/raw/fast/curve-dex-phase0.json", "reports/raw/fast/ccip-phase0.json", "reports/convex-finance-triage.md"],
    classification: "curve-convex-bridge-context-only-no-route-positive-promotion",
  },
  {
    sourceLabel: "known-public-disclosure-classes",
    kind: "public-static-label",
    disclosureRows: DISCLOSURE_ROWS.length,
    classification: "historical-risk-class-context-no-current-route-proof",
  },
];

const EXPLICIT_FILES = [
  "reports/raw/fast/prefilter-deep-new-target-search-2026-06-24.json",
  "reports/raw/defillama-flashloan-top25.json",
  "reports/raw/defillama-scored-candidates.json",
  "reports/raw/defillama-filtered-top.json",
  "reports/raw/fast/curve-dex-phase0.json",
  "reports/curve-dex-phase0-triage.md",
  "reports/raw/fast/ccip-phase0.json",
  "reports/ccip-phase0-triage.md",
  "reports/convex-finance-triage.md",
  "targets/reserve-protocol/contracts/plugins/assets/curve/stakedao/StakeDAORecursiveCollateral.sol",
  "targets/reserve-protocol/scripts/deployment/phase2-assets/collaterals/deploy_stakedao_usdc_usdcplus.ts",
  "targets/reserve-protocol/scripts/verification/collateral-plugins/verify_stakedao_usdc_usdcplus.ts",
  "targets/reserve-protocol/test/plugins/individual-collateral/curve/constants.ts",
  "targets/reserve-protocol/test/plugins/individual-collateral/curve/stakedao/StakeDAORecursiveCollateral.test.ts",
  "targets/reserve-protocol/test/plugins/individual-collateral/curve/stakedao/helpers.ts",
  "targets/convex-platform/contracts/contracts/interfaces/IGaugeController.sol",
];

const SOURCE_ROOTS = [
  "targets/reserve-protocol/contracts/plugins/assets/curve/stakedao",
  "targets/reserve-protocol/test/plugins/individual-collateral/curve/stakedao",
  "targets/convex-platform/contracts/contracts",
];

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const ADDRESS_RULES = ADDRESS_SEEDS
  .filter((row) => /^0x[0-9a-fA-F]{40}$/.test(row.address))
  .map((row) => ({ label: `${row.role} ${row.address}`, regex: new RegExp(escapeRegExp(row.address), "i") }));

const EXACT_RULES = [
  { label: "StakeDAO", regex: /\bStakeDAO\b/i },
  { label: "Stake DAO", regex: /\bStake\s+DAO\b/i },
  { label: "stake-dao", regex: /\bstake[-_\s]?dao\b/i },
  { label: "stakedao/index.js", regex: /\bstakedao[\\/]index\.js\b/i },
  { label: "StakeDAORecursiveCollateral", regex: /\bStakeDAORecursiveCollateral\b/ },
  { label: "IStakeDAOGauge", regex: /\bIStakeDAOGauge\b/ },
  { label: "sdToken", regex: /\bsdToken\b/i },
  { label: "sdCRV", regex: /\bsdCRV\b/i },
  { label: "sdFXN", regex: /\bsdFXN\b/i },
  { label: "sdBAL", regex: /\bsdBAL\b/i },
  { label: "sdANGLE", regex: /\bsdANGLE\b/i },
  { label: "sdPENDLE", regex: /\bsdPENDLE\b/i },
  { label: "sdCAKE", regex: /\bsdCAKE\b/i },
  { label: "sdUSDCUSDCPlus", regex: /\bsdUSDCUSDCPlus\b/i },
  { label: "LiquidLocker", regex: /\bLiquidLocker\b/i },
  { label: "Depositor", regex: /\bDepositor\b/i },
  { label: "Accumulator", regex: /\bAccumulator\b/i },
  { label: "veSDT", regex: /\bveSDT\b/i },
  { label: "vlSDT", regex: /\bvlSDT\b/i },
  { label: "SDT", regex: /\bSDT\b/ },
  { label: "LiquidityGauge", regex: /\bLiquidityGauge\b/i },
  { label: "GaugeController", regex: /\bGaugeController\b/i },
  { label: "Votemarket", regex: /\bVotemarket\b/i },
  { label: "LaPoste", regex: /\bLaPoste\b/i },
  { label: "TokenFactory", regex: /\bTokenFactory\b/ },
  { label: "OFT", regex: /\bOFT\b/ },
  ...ADDRESS_RULES,
];

const CONTEXT_RULES = [
  { label: "vault", regex: /\bvaults?\b/i },
  { label: "strategy", regex: /\bstrateg(?:y|ies)\b/i },
  { label: "gauge", regex: /\bgauges?\b/i },
  { label: "Curve", regex: /\bCurve\b/i },
  { label: "LP token", regex: /\bLP[-\s]?tokens?\b/i },
  { label: "claim rewards", regex: /\bclaim(?:_rewards|Rewards| rewards?)\b/i },
  { label: "reward token", regex: /\breward(?:s)?[-_\s]?tokens?\b/i },
  { label: "oracle", regex: /\boracle\b/i },
  { label: "feed", regex: /\b(?:feed|chainlink|price|virtual\s+price|get_virtual_price)\b/i },
  { label: "collateral", regex: /\bcollateral\b/i },
  { label: "consumer", regex: /\b(?:consumer|borrow|lending|reserve|RToken|morpho|aave|euler|silo|compound)\b/i },
  { label: "bridge/custody", regex: /\b(?:bridge|custody|cross[-\s]?chain|LayerZero|CCIP|trustedPeer|peer|mint|burn|unlock)\b/i },
  { label: "DEX/exit", regex: /\b(?:DEX|swap|pool|liquidity|slippage|unwind|exit|redeem|withdraw|Curve|Balancer|Uniswap)\b/i },
  { label: "routePositive", regex: /\broutePositive\b/i },
];

const CATEGORY_RULES = {
  stakeDaoVault: ["stake dao", "stakedao", "stakedaorecursivecollateral", "vault", "strategy", "harvester", "allocator", "accumulator", "sdusdcusdcplus"],
  sdToken: ["sdtoken", "sdcrv", "sdfxn", "sdbal", "sdangle", "sdpendle", "sdcake", "sdusdc", "sdt", "tokenfactory"],
  veSdtLocker: ["vesdt", "vlsdt", "locker", "liquidlocker", "depositor", "lock", "locked"],
  gauge: ["gauge", "istakedaogauge", "liquiditygauge", "gaugecontroller", "reward_count", "reward_tokens", "claim_rewards"],
  curvePoolLp: ["curve", "pool", "lp token", "lp_token", "lp", "get_virtual_price", "virtual price", "usdc_usdcplus_pool", "usdc_usdcplus_lp_token"],
  convexWrapper: ["convex", "cvx", "booster", "baserewardpool", "convexstakingwrapper", "cvxcrvoracle"],
  rewardClaim: ["claim_rewards", "claimrewards", "reward_count", "reward_tokens", "rewarddistributor", "rewardsclaimed", "claim", "rewards"],
  oracle: ["oracle", "feed", "chainlink", "price", "virtual price", "get_virtual_price", "verifier", "middleman", "votemarket"],
  bridgeCustody: ["bridge", "custody", "laposte", "tokenfactory", "oft", "trustedpeer", "ccip", "layerzero", "cross-chain", "adapter", "mint", "burn", "peer"],
  consumerJoin: ["consumer", "collateral", "borrow", "lending", "reserve", "rtoken", "stake daorecursive", "stakedaorecursivecollateral", "morpho", "aave", "euler", "silo", "compound"],
  dexLiquidity: ["dex", "swap", "pool", "liquidity", "curve", "balancer", "uniswap", "slippage", "tvl"],
  exitLiquidity: ["exit", "unwind", "redeem", "withdraw", "claim", "swap", "liquidity", "lp", "gauge"],
  economics: ["routepositive", "executable", "profit", "netbps", "effectivebps", "positive", "liquidityusd", "tvl", "exacteconomics", "forkproof"],
};

const BLOCKERS = [
  "No exact-positive Stake DAO vault/sdToken/gauge -> accepted value -> consumer/exit route is proven in local artifacts; address rows are static seeds only.",
  "Adapter TVL, public deployment labels, offchain registry labels, and Reserve/Curve/Convex local context do not prove live code state, current balances, accepted collateral value, or exit liquidity.",
  "sdToken, LiquidLocker, depositor, accumulator, and veSDT/vlSDT rows require exact mint/burn/redeem/lock state, transferability, fees, and permissionless action paths before route-positive status.",
  "Gauge, GaugeController, Curve pool/LP, and Convex wrapper rows require current gauge staking, reward accounting, virtual price, pool liquidity, unwind depth, and no pause/killed/emergency blocker.",
  "Reserve StakeDAORecursiveCollateral is a concrete consumer-plugin context, but the local pass did not prove current accepted-value divergence, material borrow/redeem capacity, or borrower-side value delta.",
  "Votemarket/oracle/verifier and LaPoste/OFT/TokenFactory rows are historical or architectural risk context only; no current proof/message/peer/config bypass with liquid value is proven.",
  "Historical 2023/2026 public bug classes are not promoted without a current deployed target, permissionless value movement, and exact positive economics.",
  "Fraxtal and xDai/Gnosis remain caveat chains unless safe local coverage exists and endpoint details remain sanitized.",
  "No endpoint inventory was read and no live eth_call/fork refresh was performed in this bounded pass, so route gate stays fail-closed.",
  "Fork and signed-action gates remain closed because routePositive=0 and exactEconomicsRows=0.",
];

const REQUIRED_FOR_ROUTE_POSITIVE = [
  "Exact producer asset: identify a specific Stake DAO sdToken, LiquidLocker receipt, vault share, gauge stake, reward claim, Votemarket claim, or OFT/bridge asset with current deployed state.",
  "Exact consumer/exit join: prove that the same asset is accepted by a material lending/oracle/redeem/DEX/Curve/Convex consumer or has immediate exit liquidity at route size.",
  "Accounting proof: quantify mint/burn/redeem, locker/depositor, gauge share, reward claim, Curve LP virtual-price, oracle/verifier, and bridge/OFT peer semantics for the exact asset.",
  "Positive economics: accepted value must exceed acquisition, redeem, claim, bridge, or DEX unwind value after fees, slippage, gas, caps, queues, killed/paused checks, and LTV/LLTV haircuts.",
  "Permissionless execution: no owner, governance multisig, pauser, emergency, killed gauge, trusted peer, verifier, campaign admin, proof authority, or timelock blocker can exist on the proposed path.",
  "Caveat-chain proof: only include Fraxtal/xDai/Gnosis if safe read-only coverage exists and endpoint details remain fully sanitized.",
  "Local static/fork value-delta proof must show positive attacker-controlled balance movement before routePositive, forkJustified, or signedActionJustified can change.",
  "Explicit route-specific authorization and independent defensive review are required before any signed transaction path is discussed.",
];

const NEXT_READ_ONLY_STEP = "Keep Stake DAO dormant unless a current sdToken/vault/gauge/Curve-LP/reward/bridge asset maps to a material consumer or exit venue; then refresh sanitized read-only state for exact accounting, killed/paused/role state, consumer caps/cash/oracles, and DEX/redeem unwind economics before any fork/static proof.";

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
  if (/:?\.(pem|key|p12|pfx|keystore)$/i.test(base)) return true;
  if (/(^|[\/\\])(?:private|secret|secrets|mnemonic|seed|wallet|keypair|keystore|api[-_]?key|access[-_]?key)(?:[\/\\._-]|$)/i.test(r)) return true;
  return false;
}

function isExcludedScanPath(filePath) {
  const r = rel(filePath).toLowerCase();
  const base = path.basename(filePath).toLowerCase();
  if (r === OUT_JSON_REL.toLowerCase() || r === OUT_MD_REL.toLowerCase()) return true;
  if (r === "tools/scan-stake-dao-full-test.js") return true;
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

function listAlchemixSolcInputs() {
  const root = path.join(WORKSPACE, "targets", "alchemix-deployments");
  const files = listFilesRecursive(root, (file) => /[\\/]solcInputs[\\/][^\\/]+\.json$/i.test(file));
  return files.slice(0, MAX_ALCHEMIX_SOLC_INPUTS);
}

function listScanFiles() {
  const files = [];
  for (const file of EXPLICIT_FILES) {
    const full = path.join(WORKSPACE, file);
    if (fs.existsSync(full) && !isExcludedScanPath(full)) files.push(full);
  }
  for (const root of SOURCE_ROOTS) files.push(...listFilesRecursive(path.join(WORKSPACE, root)));
  files.push(...listAlchemixSolcInputs());
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
  if (routeValue === true || routeValue === "true" || routeValue === 1) return "prior-positive-or-watch-signal-not-promoted-without-current-exact-economics";
  if (r.includes("reserve-protocol") && r.includes("stakedao")) return "reserve-consumer-plugin-context-only-no-current-positive-economics";
  if (r.includes("curve-dex-phase0")) return "curve-dex-liquidity-context-only-no-stakedao-route-positive";
  if (r.includes("ccip-phase0")) return "bridge-custody-context-only-no-stakedao-proof-bypass";
  if (r.includes("convex-platform") || r.includes("convex-finance")) return "convex-gauge-reward-context-only-no-stakedao-positive-economics";
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

function selectNotableRows(rows) {
  const priority = [];
  const files = new Set();
  for (const row of rows) {
    const key = row.file;
    const cats = row.categories || [];
    if (exactish(row) || cats.some((cat) => ["consumerJoin", "oracle", "bridgeCustody", "gauge", "rewardClaim", "curvePoolLp", "dexLiquidity"].includes(cat))) {
      if (!files.has(key) || exactish(row)) {
        priority.push(row);
        files.add(key);
      }
    }
    if (priority.length >= 32) break;
  }
  return priority.length ? priority : rows.slice(0, 20);
}

function sourceForRow(row) {
  return `${row.file}${row.line ? `:${row.line}` : ""}`;
}

function buildPayload({ lineScan }) {
  const combinedRows = lineScan.rows;
  const exactRows = lineScan.exactRows;
  const categoryRows = {};
  for (const category of Object.keys(CATEGORY_RULES)) categoryRows[`${category}Rows`] = pickRows(combinedRows, (row) => row.categories.includes(category), 150);
  const consumerJoinRows = pickRows(combinedRows, (row) => row.categories.some((cat) => ["consumerJoin", "oracle", "dexLiquidity", "exitLiquidity", "curvePoolLp"].includes(cat)), 180);
  const exactConsumerJoinRows = pickRows(consumerJoinRows, exactish, 140);
  const notableRows = selectNotableRows(combinedRows);
  const priorArtifactPositiveRowsNotPromoted = combinedRows.filter((row) => row.sourceRoutePositiveNotPromoted).length;
  const exactEconomicsRows = 0;
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
    knownDisclosureRows: DISCLOSURE_ROWS.length,
    filesScanned: lineScan.filesScanned,
    filesWithLocalMatches: lineScan.filesWithMatch,
    filesWithExactLocalMatches: lineScan.filesWithExact,
    localArtifactMatchRows: combinedRows.length,
    exactLocalArtifactMatchRows: exactRows.length,
    localLineRows: lineScan.rows.length,
    stakeDaoVaultRows: categoryRows.stakeDaoVaultRows.length,
    sdTokenRows: categoryRows.sdTokenRows.length,
    veSdtLockerRows: categoryRows.veSdtLockerRows.length,
    gaugeRows: categoryRows.gaugeRows.length,
    curvePoolLpRows: categoryRows.curvePoolLpRows.length,
    convexWrapperRows: categoryRows.convexWrapperRows.length,
    rewardClaimRows: categoryRows.rewardClaimRows.length,
    oracleRows: categoryRows.oracleRows.length,
    bridgeCustodyRows: categoryRows.bridgeCustodyRows.length,
    consumerJoinRows: consumerJoinRows.length,
    exactConsumerJoinRows: exactConsumerJoinRows.length,
    dexLiquidityRows: categoryRows.dexLiquidityRows.length,
    exitLiquidityRows: categoryRows.exitLiquidityRows.length,
    economicsContextRows: categoryRows.economicsRows.length,
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
    scanner: "tools/scan-stake-dao-full-test.js",
    target: TARGET,
    scope: {
      kind: "bounded defensive/read-only full-test scanner",
      artifactStaticLocalFirst: true,
      evmFirst: true,
      evmFirstChains: CHAIN_SEEDS.filter((row) => row.evmFirst && !row.caveat).map((row) => row.chainLabel),
      caveatChains: CHAIN_SEEDS.filter((row) => row.caveat).map((row) => row.chainLabel),
      routeGraph: TARGET.routeGraph,
      writesLimitedTo: [OUT_JSON_REL, OUT_MD_REL],
      coordinatorClaim: "fixer-stake-dao-fulltest-01",
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
    publicDocs: PUBLIC_DOCS,
    knownDisclosures: DISCLOSURE_ROWS,
    discoveredSeeds: { chainSeeds: CHAIN_SEEDS, addressSeedRows: ADDRESS_SEEDS, surfaceRows: SURFACE_ROWS },
    localArtifacts: {
      filesScanned: lineScan.filesScanned,
      filesWithMatch: lineScan.filesWithMatch,
      filesWithExact: lineScan.filesWithExact,
      categoryCounts: lineScan.categoryCounts,
      rows: combinedRows,
      exactRows: exactRows.slice(0, 180),
      notableRows,
    },
    categoryRows: { ...categoryRows, consumerJoinRows, exactConsumerJoinRows },
    rows: notableRows.slice(0, 12),
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
      reason: "Static/local scan found Stake DAO source/deployment/consumer/Curve/Convex/bridge context rows only; no current exact permissionless value movement, positive economics, or local/fork/static value-delta proof is present.",
    },
    blockers: BLOCKERS,
    requiredForRoutePositive: REQUIRED_FOR_ROUTE_POSITIVE,
    nextReadOnlyStep: NEXT_READ_ONLY_STEP,
    summary,
  };
}

function metricRows(summary) {
  const keys = [
    "sourceFactRows", "chainSeedRows", "addressSeedRows", "surfaceRows", "publicDocRows", "knownDisclosureRows", "filesScanned", "filesWithLocalMatches", "filesWithExactLocalMatches", "localArtifactMatchRows", "exactLocalArtifactMatchRows", "stakeDaoVaultRows", "sdTokenRows", "veSdtLockerRows", "gaugeRows", "curvePoolLpRows", "convexWrapperRows", "rewardClaimRows", "oracleRows", "bridgeCustodyRows", "consumerJoinRows", "exactConsumerJoinRows", "dexLiquidityRows", "exitLiquidityRows", "economicsContextRows", "priorArtifactPositiveRowsNotPromoted", "publicFetchRows", "rpcInventoryRows", "graphqlInventoryRows", "ethCallRows", "forkRows", "exactEconomicsRows", "routePositive", "executableNow", "signedActionJustified", "forkJustified", "forkGate", "fullTestReadOnlyComplete",
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
  const detail = row.sample || "context-only";
  return `| ${mdEscape(sourceForRow(row))} | ${mdEscape(categories)} | ${mdEscape(row.matched)} | ${mdEscape(detail)} | ${mdEscape(row.routePositive)} | ${mdEscape(row.classification)} |`;
}

function formatAddressRow(row) {
  return `| ${mdEscape(row.role)} | ${mdEscape(row.chain)} | ${mdEscape(row.address)} | ${mdEscape(row.surface)} | ${mdEscape(row.classification)} |`;
}

function formatSurfaceRow(row) {
  return `| ${mdEscape(row.component)} | ${mdEscape(row.surface)} | ${mdEscape(row.routeRole)} | ${mdEscape((row.watchTerms || []).join(", "))} |`;
}

function formatDisclosureRow(row) {
  return `| ${mdEscape(row.year)} | ${mdEscape(row.label)} | ${mdEscape(row.surface)} | ${mdEscape(row.classification)} |`;
}

function buildMarkdown(payload) {
  const notableRows = payload.localArtifacts.notableRows.length
    ? payload.localArtifacts.notableRows.map(formatLocalRow).join("\n")
    : "| (none) | n/a | n/a | no local context rows found | 0 | dormant |";
  const addressRows = payload.discoveredSeeds.addressSeedRows.map(formatAddressRow).join("\n");
  const surfaceRows = payload.discoveredSeeds.surfaceRows.map(formatSurfaceRow).join("\n");
  const disclosureRows = payload.knownDisclosures.map(formatDisclosureRow).join("\n");
  const docRows = payload.publicDocs.map((url) => `- ${url}`).join("\n");

  return `# 🟢 DORMANT - Stake DAO Full Test

Generated: ${payload.generatedAt}

Route remains closed: routePositive=${payload.routeGate.routePositive}, executableNow=${payload.routeGate.executableNow}, signedActionJustified=${payload.routeGate.signedActionJustified}, forkJustified=${payload.routeGate.forkJustified}, forkGate=${payload.routeGate.forkGate}.

## Summary

| Metric | Value |
|---|---:|
${metricRows(payload.summary)}

## Target / Scope

- Target: ${payload.target.name} (${payload.target.slug}), category=${payload.target.category}, surface=${payload.target.surface}, module=${payload.target.module}, rank≈${payload.target.discoveryRank}, TVL context≈${payload.target.tvlContext}.
- EVM-first chains: ${payload.scope.evmFirstChains.join(", ")}; caveat chains: ${payload.scope.caveatChains.join(", ") || "none"}.
- Route graph: ${payload.target.routeGraph}.
- Adapter context: adapterFetched=${payload.target.adapterFetched}, adapterAddressCount=${payload.target.adapterAddressCount}, hints=${payload.target.adapterHints.join(", ")}.
- Writes limited to: ${payload.scope.writesLimitedTo.join(", ")}.
- Coordinator claim: ${payload.scope.coordinatorClaim}; aggregate/state/shared-context/handoff files edited=false.

## Safety

| Field | Value |
|---|---:|
${safetyRows(payload.safety)}

## Public Static Docs / Registry Labels (allowed URL context; not fetched here)

${docRows}

## Address Rows (static, not live state proof)

| Role | Chain | Address | Surface | Classification |
|---|---|---|---|---|
${addressRows}

## Surface Rows

| Component | Surface | Route Role | Watch Terms |
|---|---|---|---|
${surfaceRows}

## Known Public Bug Classes (context only)

| Year | Class | Surface | Classification |
|---:|---|---|---|
${disclosureRows}

## Notable Local Rows (watch/context only)

| Source | Categories | Match | Detail | Route | Classification |
|---|---|---|---|---:|---|
${notableRows}

## Route Gate

- Status: ${payload.routeGate.status}.
- Required fail-closed conjunction is absent: exactPermissionlessValueMovement=${payload.routeGate.exactPermissionlessValueMovement}, exactPositiveEconomics=${payload.routeGate.exactPositiveEconomics}, localForkStaticProof=${payload.routeGate.localForkStaticProof}.
- Historical bug classes and local Curve/Convex/Reserve/CCIP context are not promoted without current exact economics.
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
  log("Scanning Stake DAO local artifacts (sanitized, no endpoint inventory read)...");
  const files = listScanFiles();
  const lineScan = scanLocalArtifactLines(files);
  const payload = buildPayload({ lineScan });
  writeJson(OUT_JSON, payload);
  writeText(OUT_MD, buildMarkdown(payload));
  log(`Wrote ${OUT_JSON_REL} and ${OUT_MD_REL}`);
  log(`routePositive=${payload.summary.routePositive}; exactEconomicsRows=${payload.summary.exactEconomicsRows}; localArtifactMatchRows=${payload.summary.localArtifactMatchRows}; exactConsumerJoinRows=${payload.summary.exactConsumerJoinRows}`);
}

main();
