#!/usr/bin/env node
"use strict";

// scan-stobox-full-test.js
// Defensive Stobox full-test scanner. Static/local/public-facts only; no endpoint
// inventory reads, network fetches, RPC calls, forks, signed actions, or wallets.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const REPORTS_DIR = path.join(WORKSPACE, "reports");
const OUT_JSON = path.join(RAW_DIR, "stobox-full-test.json");
const OUT_MD = path.join(REPORTS_DIR, "stobox-full-test-triage.md");
const OUT_JSON_REL = "reports/raw/fast/stobox-full-test.json";
const OUT_MD_REL = "reports/stobox-full-test-triage.md";

const QUIET = process.argv.includes("--quiet");
const GENERATED_AT = process.env.SCAN_GENERATED_AT || "2026-07-07T00:00:00.000Z";

const MAX_FILE_BYTES = 24 * 1024 * 1024;
const MAX_LOCAL_MATCH_ROWS = 720;
const MAX_ROWS_PER_FILE = 32;

const TARGET = {
  slug: "stobox",
  name: "Stobox",
  kind: "protocol",
  category: "RWA",
  discoveryRank: 18,
  tvlContextUsd: 15_122_059,
  tvlContext: "$15.122M",
  surface: "rwa-nav-consumer-join",
  primaryChains: ["Arbitrum", "BNB Chain", "Polygon"],
  caveatChains: [],
  routeGraph: "RWA receipt -> NAV/rate provider -> accepted-value consumer -> borrow/redeem/exit",
  firstReadOnlyChecks: [
    "resolve exact receipt and NAV contracts",
    "join receipts to lending/oracle consumers",
    "check redemption/transfer gates and DEX exits",
  ],
  module: "stobox/index.js",
  adapterFetched: true,
  adapterAddressCount: 1,
  adapterHints: [],
};

const CHAIN_SEEDS = [
  { chain: "Arbitrum", chainLabel: "Arbitrum", chainId: 42161, adapterKey: "arbitrum", evmFirst: true, caveat: false, classification: "primary-evm-discovery-chain" },
  { chain: "BNB Chain", chainLabel: "BNB Chain", chainId: 56, adapterKey: "bsc", evmFirst: true, caveat: false, classification: "primary-evm-discovery-chain" },
  { chain: "Polygon", chainLabel: "Polygon", chainId: 137, adapterKey: "polygon", evmFirst: true, caveat: false, classification: "primary-evm-discovery-chain" },
];

const ADDRESS_SEEDS = [
  { role: "StoboxRWAVaultFactory v1.0.8", chain: "Arbitrum", address: "0x096D75d0501c3B1479FFe15569192CeC998223b4", surface: "rwa-vault-factory/adapter-sample", adapterSample: true, classification: "public-static-docs-address-not-live-state-proof" },
  { role: "StoboxRWAOfferingRegistry v1.0.5", chain: "Arbitrum", address: "0xb05cf4f652eb5475c3e4246ab976785678a1806a", surface: "offering/soft-cap/refund-registry", classification: "public-static-docs-address-not-live-state-proof" },
  { role: "StoboxDID v0.1", chain: "Arbitrum", address: "0x25E6036178656b1329ee51696407b367D8C6ba84", surface: "DID/KYC-compliance", classification: "public-static-docs-address-not-live-state-proof" },
  { role: "STBU Token v3", chain: "Arbitrum", address: "0x1cb9bD2c6E7F4A7DE3778547d46C8D4c22abC093", surface: "utility/governance token", classification: "public-static-docs-address-not-live-state-proof" },
  { role: "STBX Security Token v3", chain: "Arbitrum", address: "0x998a0beaf37ca4ba61b5cfac59fdee0da2211a46", surface: "tokenized-security/receipt", classification: "public-static-docs-address-not-live-state-proof" },
  { role: "Legacy STBU", chain: "Ethereum", address: "0xa6422e3e219ee6d4c1b18895275fe43556fd50ed", surface: "legacy-token-address", classification: "legacy-public-docs-address-not-live-state-proof" },
  { role: "Legacy STBU", chain: "BNB Chain", address: "0xb0c4080a8fa7afa11a09473f3be14d44af3f8743", surface: "legacy-token-address", classification: "legacy-public-docs-address-not-live-state-proof" },
  { role: "Legacy STBU", chain: "Polygon", address: "0xcf403036bc139d30080d2cf0f5b48066f98191bb", surface: "legacy-token-address", classification: "legacy-public-docs-address-not-live-state-proof" },
];

const SURFACE_ROWS = [
  { component: "STV3 programmable asset infrastructure", surface: "EIP-2535 Diamond/facet architecture", routeRole: "producer contract upgrade and selector-routing context", watchTerms: ["Diamond", "DiamondCutFacet", "CreateSTV3Facet", "TokenBlueprintFacet"] },
  { component: "STBX / tokenized securities", surface: "ERC-7943/uRWA-aligned transfer-restricted receipt", routeRole: "RWA receipt token and transferability gate", watchTerms: ["STBX", "canTransfer", "canTransact", "forcedTransfer", "forcedBurn"] },
  { component: "STBU / legacy multi-chain token", surface: "utility token and legacy-chain confusion", routeRole: "exact-token identity and chain-address validation", watchTerms: ["STBU", "legacy", "Arbitrum", "BNB", "Polygon"] },
  { component: "StoboxDID", surface: "DID/KYC/KYB identity and attribute validation", routeRole: "eligibility/compliance gate", watchTerms: ["DID", "KYC", "KYB", "HasDIDRule", "AccreditedUSMinInvestmentRule"] },
  { component: "Validation engine", surface: "trusted-address and jurisdiction restrictions", routeRole: "transfer/redeem/consumer eligibility", watchTerms: ["ValidationFacet", "ExcludeUSAandCANRule", "canTransfer", "setFrozenTokens"] },
  { component: "RWA vault/factory", surface: "vault treasury, custody, token lifecycle", routeRole: "receipt producer and backing/custody context", watchTerms: ["StoboxRWAVaultFactory", "treasury", "custody", "vault"] },
  { component: "Offering registry", surface: "purchase, soft cap, refund, lockup", routeRole: "issuance/refund/redeem state machine", watchTerms: ["StoboxRWAOfferingRegistry", "PurchaseFacet", "soft cap", "refund", "LockupFacet"] },
  { component: "NAV/rate provider", surface: "manual/stale/wrong-decimal NAV or rate", routeRole: "accepted-value/reference-price proof gap", watchTerms: ["NAV", "rateProvider", "MonetaryFacet", "price"] },
  { component: "Consumers / exits", surface: "lending/oracle/DEX/redemption joins", routeRole: "borrow/redeem/exit economics", watchTerms: ["Morpho", "Aave", "Euler", "Silo", "Compound", "DEX"] },
];

const PUBLIC_DOCS = [
  "https://www.stobox.io/",
  "https://docs.stobox.io",
  "https://app.stobox.io",
  "https://www.stobox.io/stbu",
  "https://www.stobox.io/stbx",
  "https://github.com/StoboxTechnologies",
  "https://github.com/StoboxTechnologies/Stobox_STV3_Protocol",
  "https://github.com/StoboxTechnologies/Stobox-STV3-Programmable-Asset-Infrastructure",
  "https://github.com/StoboxTechnologies/Stobox_STV2_Standard_Security_Token",
  "https://github.com/StoboxTechnologies/Stobox-Decentralized-ID",
  "https://github.com/StoboxTechnologies/Stobox-STV3-Programmable-Asset-Infrastructure/blob/main/docs/deployed-contracts.md",
];

const BUG_CLASS_ROWS = [
  { label: "diamond/facet selector misconfiguration", surface: "EIP-2535 Diamond", classification: "bug-class-context-no-current-route-proof" },
  { label: "unauthorized facet upgrade or role escalation", surface: "DiamondCutFacet/access control", classification: "bug-class-context-no-current-route-proof" },
  { label: "trusted-address validation bypass", surface: "ValidationFacet/compliance rules", classification: "bug-class-context-no-current-route-proof" },
  { label: "DID/KYC stale, blocked, expired, or wrong attribute", surface: "StoboxDID and compliance rules", classification: "bug-class-context-no-current-route-proof" },
  { label: "downstream consumer ignores transfer restrictions or forced-transfer powers", surface: "consumer-join", classification: "bug-class-context-no-current-route-proof" },
  { label: "paused/frozen/locked tokens counted as liquid NAV", surface: "accepted-value/NAV", classification: "bug-class-context-no-current-route-proof" },
  { label: "treasury/custody undercollateralization", surface: "vault/treasury", classification: "bug-class-context-no-current-route-proof" },
  { label: "offering soft-cap/refund state mismatch", surface: "offering registry", classification: "bug-class-context-no-current-route-proof" },
  { label: "stale/manual/wrong-decimal NAV/rate", surface: "NAV/rate provider", classification: "bug-class-context-no-current-route-proof" },
  { label: "cross-chain legacy token confusion", surface: "STBU/STBX chain identity", classification: "bug-class-context-no-current-route-proof" },
];

const SOURCE_FACTS = [
  {
    sourceLabel: "local-prefilter-discovery-json:2026-06-24:1142-1191",
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
    adapterAddressCount: TARGET.adapterAddressCount,
    adapterHints: TARGET.adapterHints,
    routePositive: 0,
    classification: "structured-target-seed-route-negative",
  },
  {
    sourceLabel: "defillama-adapter-label:stobox/index.js",
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
    sourceLabel: "official-arbitrum-deployed-contracts-docs",
    kind: "public-static-label",
    addressSeedRows: ADDRESS_SEEDS.filter((row) => row.chain === "Arbitrum").length,
    classification: "static-address-map-no-live-state-proof",
  },
  {
    sourceLabel: "local-rwa-nav-and-consumer-artifacts",
    kind: "local-artifact-context",
    artifacts: [
      "reports/raw/fast/rwa-nav-consumer-graph.json",
      "reports/raw/fast/consumer-first-high-ltv-collateral.json",
      "reports/raw/fast/aave-euler-silo-consumer-graph.json",
      "reports/raw/fast/euler-v2-phase0.json",
      "reports/raw/fast/silo-v2-phase0.json",
      "reports/raw/fast/compound-v3-phase0.json",
    ],
    classification: "local-consumer-context-only-no-stobox-route-positive",
  },
  {
    sourceLabel: "local-dex-bridge-context",
    kind: "local-artifact-context",
    artifacts: [
      "reports/raw/fast/curve-dex-phase0.json",
      "reports/raw/fast/balancer-v3-phase0.json",
      "reports/raw/fast/uniswap-v2-phase0.json",
      "reports/raw/fast/uniswap-v3-phase0.json",
      "reports/raw/fast/ccip-phase0.json",
      "reports/raw/fast/bridge-nonlossless-collateral-join.json",
    ],
    classification: "exit-bridge-context-only-no-stobox-route-positive",
  },
  {
    sourceLabel: "public-docs-nav-rate-gap",
    kind: "public-static-label",
    finding: "No confirmed public NAV/rate-provider contract was found in supplied docs context; scanner treats NAV/rate proof as unresolved and fail-closed.",
    classification: "nav-rate-provider-unverified-fail-closed",
  },
  {
    sourceLabel: "bug-class-seeds",
    kind: "public-static-label",
    bugClassRows: BUG_CLASS_ROWS.length,
    classification: "risk-class-context-no-current-route-proof",
  },
];

const EXPLICIT_FILES = [
  "reports/raw/fast/prefilter-deep-new-target-search-2026-06-24.json",
  "reports/raw/defillama-filtered-top.json",
  "reports/raw/defillama-scored-candidates.json",
  "reports/raw/defillama-flashloan-top25.json",
  "reports/raw/fast/rwa-nav-consumer-graph.json",
  "reports/raw/fast/consumer-first-high-ltv-collateral.json",
  "reports/raw/fast/aave-euler-silo-consumer-graph.json",
  "reports/raw/fast/euler-v2-phase0.json",
  "reports/raw/fast/silo-v2-phase0.json",
  "reports/raw/fast/compound-v3-phase0.json",
  "reports/raw/fast/morpho-pyth-unsafe-consumers.json",
  "reports/raw/fast/morpho-wrapper-exit-proof-gaps.json",
  "reports/raw/fast/morpho-liquidatable-marketability.json",
  "reports/raw/fast/ccip-phase0.json",
  "reports/raw/fast/bridge-nonlossless-collateral-join.json",
  "reports/raw/fast/bridge-lending-collateral-join.json",
  "reports/raw/fast/curve-dex-phase0.json",
  "reports/raw/fast/balancer-v3-phase0.json",
  "reports/raw/fast/uniswap-v2-phase0.json",
  "reports/raw/fast/uniswap-v3-phase0.json",
  "reports/blackrock-buidl-phase0-triage.md",
  "reports/circle-usyc-phase0-triage.md",
  "reports/anemoy-capital-phase0-triage.md",
];

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const ADDRESS_RULES = ADDRESS_SEEDS.map((row) => ({ label: `${row.role} ${row.address}`, regex: new RegExp(escapeRegExp(row.address), "i") }));

const EXACT_RULES = [
  { label: "Stobox", regex: /\bStobox\b/i },
  { label: "stobox/index.js", regex: /\bstobox[\\/]index\.js\b/i },
  { label: "STBU", regex: /\bSTBU\b/i },
  { label: "STBX", regex: /\bSTBX\b/i },
  { label: "StoboxRWAVaultFactory", regex: /\bStoboxRWAVaultFactory\b/i },
  { label: "StoboxRWAOfferingRegistry", regex: /\bStoboxRWAOfferingRegistry\b/i },
  { label: "StoboxProtocolSTV3", regex: /\bStoboxProtocolSTV3\b/i },
  { label: "StoboxDID", regex: /\bStoboxDID\b/i },
  { label: "STV3", regex: /\bSTV3\b/i },
  { label: "STV2", regex: /\bSTV2\b/i },
  { label: "DiamondCutFacet", regex: /\bDiamondCutFacet\b/i },
  { label: "TokenBlueprintFacet", regex: /\bTokenBlueprintFacet\b/i },
  { label: "CreateSTV3Facet", regex: /\bCreateSTV3Facet\b/i },
  { label: "STV3TokenManagementFacet", regex: /\bSTV3TokenManagementFacet\b/i },
  { label: "MonetaryFacet", regex: /\bMonetaryFacet\b/i },
  { label: "ValidationFacet", regex: /\bValidationFacet\b/i },
  { label: "PurchaseFacet", regex: /\bPurchaseFacet\b/i },
  { label: "LockupFacet", regex: /\bLockupFacet\b/i },
  { label: "EmergencyFacet", regex: /\bEmergencyFacet\b/i },
  { label: "HasDIDRule", regex: /\bHasDIDRule\b/i },
  { label: "canTransfer", regex: /\bcanTransfer\b/i },
  { label: "canTransact", regex: /\bcanTransact\b/i },
  { label: "forcedTransfer", regex: /\bforcedTransfer\b/i },
  { label: "forcedBurn", regex: /\bforcedBurn\b/i },
  { label: "setFrozenTokens", regex: /\bsetFrozenTokens\b/i },
  ...ADDRESS_RULES,
];

const CONTEXT_RULES = [
  { label: "RWA", regex: /\bRWA\b/i },
  { label: "receipt", regex: /\breceipts?\b/i },
  { label: "NAV/rate", regex: /\b(?:NAV|rate[-\s]?provider|rateProvider|rate|price|valuation)\b/i },
  { label: "tokenized security", regex: /\b(?:security\s+token|tokeni[sz]ed\s+securit|programmable\s+asset|ERC[-_]?7943|uRWA)\b/i },
  { label: "DID/KYC", regex: /\b(?:DID|KYC|KYB|accredited|identity)\b/i },
  { label: "transfer restriction", regex: /\b(?:canTransfer|canTransact|transfer\s+restriction|frozen|paused|locked|lockup|forcedTransfer|forcedBurn|blocked)\b/i },
  { label: "redemption/custody", regex: /\b(?:redeem|redemption|custody|treasury|vault|backing|offering|soft\s+cap|refund|purchase)\b/i },
  { label: "role/admin", regex: /\b(?:role|admin|owner|issuer|operator|facet|diamond|upgrade|emergency|trusted)\b/i },
  { label: "consumer", regex: /\b(?:consumer|collateral|borrow|lending|Morpho|Aave|Euler|Silo|Compound|oracle)\b/i },
  { label: "DEX/exit", regex: /\b(?:DEX|swap|pool|liquidity|Uniswap|Curve|Balancer|exit|withdraw|slippage)\b/i },
  { label: "routePositive", regex: /\broutePositive\b/i },
];

const CATEGORY_RULES = {
  receiptToken: ["receipt", "stbu", "stbx", "security token", "tokenized", "rwa", "erc-7943", "urawa", "programmable asset"],
  navRateProvider: ["nav", "rateprovider", "rate provider", "rate", "price", "valuation", "monetaryfacet", "oracle", "wrong-decimal", "manual"],
  tokenizedSecurity: ["security token", "tokenized", "stv3", "stv2", "diamond", "facet", "erc-7943", "urawa", "programmable asset"],
  transferRestriction: ["cantransfer", "cantransact", "kyc", "kyb", "did", "compliance", "validation", "frozen", "forcedtransfer", "forcedburn", "lockup", "blocked", "attribute"],
  redemptionCustody: ["redemption", "redeem", "treasury", "custody", "vault", "backing", "offering", "soft cap", "refund", "purchase", "rwavaultfactory"],
  roleAdmin: ["role", "admin", "owner", "issuer", "operator", "diamondcut", "facet", "upgrade", "emergency", "trusted", "registry"],
  consumerJoin: ["consumer", "collateral", "borrow", "lending", "reserve", "accepted", "morpho", "aave", "euler", "silo", "compound"],
  oracle: ["oracle", "nav", "rate", "price", "feed", "provider", "monetaryfacet", "valuation"],
  dexLiquidity: ["dex", "swap", "pool", "liquidity", "curve", "balancer", "uniswap", "slippage", "tvl"],
  exitLiquidity: ["exit", "unwind", "redeem", "redemption", "refund", "transfer", "swap", "liquidity", "withdraw"],
  economics: ["routepositive", "executable", "profit", "netbps", "positive", "liquidityusd", "tvl", "exacteconomics", "forkproof"],
};

const BLOCKERS = [
  "No exact-positive Stobox RWA receipt -> NAV/rate provider -> accepted-value consumer -> borrow/redeem/exit route is proven in local artifacts; address rows are static seeds only.",
  "The Stobox adapter sample maps to the documented Arbitrum RWAVaultFactory, but adapter/TVL/docs labels do not prove live vault state, receipt supply, NAV/rate values, accepted collateral value, or exit liquidity.",
  "No confirmed public NAV/rate-provider contract was found in supplied docs context; stale/manual/wrong-decimal NAV/rate risks remain proof gaps, not route-positive evidence.",
  "STV3 Diamond/facet, role/admin, trusted-address, and compliance-rule surfaces require deployed selector/facet/role state and a permissionless value path before impact can be claimed.",
  "DID/KYC/KYB, frozen/paused/locked/forced-transfer/forced-burn rules can invalidate transferability or liquidation assumptions; no downstream consumer ignoring those restrictions is proven.",
  "Offering, soft-cap, refund, lockup, treasury, and custody rows require exact state-machine amounts and backing evidence before redemption/custody economics can be trusted.",
  "Legacy STBU chain addresses create identity/confusion context only; no bridge/cross-chain or consumer route ties a wrong token to liquid accepted value.",
  "Local RWA/NAV, lending, bridge, and DEX artifacts do not provide a Stobox-specific material consumer join with exact acquisition, borrow/redeem/liquidation, and exit economics.",
  "No endpoint inventory was read and no live eth_call/fork refresh was performed in this bounded pass, so route gate stays fail-closed.",
  "Fork and signed-action gates remain closed because routePositive=0 and exactEconomicsRows=0.",
];

const REQUIRED_FOR_ROUTE_POSITIVE = [
  "Exact producer asset: identify a specific Stobox STV3/STBX/RWA receipt, vault share, offering receipt, refund claim, or STBU/STBX chain-specific token with current deployed state.",
  "Exact NAV/rate proof: resolve the deployed NAV/rate/MonetaryFacet/pricing path, decimals, freshness, authority, and whether it is consumed by any trusted external protocol.",
  "Exact consumer/exit join: prove the same Stobox receipt/token is accepted by a material lending/oracle/redeem/DEX/settlement consumer or has immediate permissionless redemption/exit liquidity at route size.",
  "Transferability proof: DID/KYC/KYB, canTransfer/canTransact, frozen/paused/locked/lockup, forcedTransfer/forcedBurn, jurisdiction and trusted-address rules must not block the route.",
  "Role/admin proof: Diamond/facet selector state, upgrade authority, issuer/admin/operator roles, emergency controls, registry and offering permissions must not be required for the attacker path.",
  "Positive economics: accepted value must exceed acquisition, redemption, refund, borrow/liquidation, or DEX unwind value after LTV/LLTV haircuts, fees, slippage, gas, caps, locks, and compliance constraints.",
  "Local static/fork value-delta proof must show positive attacker-controlled balance movement before routePositive, forkJustified, or signedActionJustified can change.",
  "Explicit route-specific authorization and independent defensive review are required before any signed transaction path is discussed.",
];

const NEXT_READ_ONLY_STEP = "Keep Stobox dormant unless a current STV3/STBX/RWA receipt or vault token maps to a material consumer or permissionless redemption/DEX exit; then refresh sanitized read-only state for NAV/rate, Diamond facets/roles, DID/KYC transfer gates, offering/refund/custody state, consumer caps/cash/oracles, and exact exit economics before any fork/static proof.";

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
  if (r === "tools/scan-stobox-full-test.js") return true;
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
  return listFilesRecursive(fast, (file) => /(?:rwa-nav-consumer-graph|consumer-first|aave-euler-silo|euler-v2|silo-v2|compound-v3|morpho-|ccip|bridge-.*(?:collateral|join)|curve-dex|balancer|uniswap|dex|exit|stable)/i.test(path.basename(file)));
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

function matchForText(line, windowText, fileHasExact) {
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
  if (r.includes("prefilter-deep-new-target-search")) return "discovery-context-only-no-route-positive";
  if (r.includes("rwa-nav-consumer-graph")) return "rwa-nav-consumer-graph-context-only-no-stobox-exact-route";
  if (r.includes("morpho") || r.includes("aave") || r.includes("euler") || r.includes("silo") || r.includes("compound")) return "consumer-artifact-context-only-no-stobox-exact-route";
  if (r.includes("curve") || r.includes("balancer") || r.includes("uniswap") || r.includes("dex") || r.includes("exit")) return "dex-exit-context-only-no-stobox-exact-economics";
  if (r.includes("bridge") || r.includes("ccip")) return "bridge-context-only-no-stobox-proof-bypass";
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

function selectNotableRows(rows) {
  const priority = [];
  const files = new Set();
  for (const row of rows) {
    const key = row.file;
    const cats = row.categories || [];
    if (exactish(row) || cats.some((cat) => ["receiptToken", "navRateProvider", "tokenizedSecurity", "transferRestriction", "redemptionCustody", "roleAdmin", "consumerJoin", "oracle", "dexLiquidity"].includes(cat))) {
      if (!files.has(key) || exactish(row)) {
        priority.push(row);
        files.add(key);
      }
    }
    if (priority.length >= 34) break;
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
  const discoveryContextRows = combinedRows.filter(discoveryContextOnly).length;
  const consumerJoinRows = pickRows(
    combinedRows,
    (row) => !discoveryContextOnly(row) && row.categories.some((cat) => ["consumerJoin", "oracle", "dexLiquidity", "exitLiquidity", "navRateProvider"].includes(cat)),
    180,
  );
  const exactConsumerJoinRows = pickRows(consumerJoinRows, exactish, 140);
  const notableRows = selectNotableRows(combinedRows);
  const priorArtifactPositiveRowsNotPromoted = combinedRows.filter((row) => row.sourceRoutePositiveNotPromoted).length;
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
    filesScanned: lineScan.filesScanned,
    filesWithLocalMatches: lineScan.filesWithMatch,
    filesWithExactLocalMatches: lineScan.filesWithExact,
    localArtifactMatchRows: combinedRows.length,
    exactLocalArtifactMatchRows: exactRows.length,
    localLineRows: lineScan.rows.length,
    discoveryContextRows,
    receiptTokenRows: categoryRows.receiptTokenRows.length,
    navRateProviderRows: categoryRows.navRateProviderRows.length,
    tokenizedSecurityRows: categoryRows.tokenizedSecurityRows.length,
    transferRestrictionRows: categoryRows.transferRestrictionRows.length,
    redemptionCustodyRows: categoryRows.redemptionCustodyRows.length,
    roleAdminRows: categoryRows.roleAdminRows.length,
    consumerJoinRows: consumerJoinRows.length,
    exactConsumerJoinRows: exactConsumerJoinRows.length,
    oracleRows: categoryRows.oracleRows.length,
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
    scanner: "tools/scan-stobox-full-test.js",
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
      coordinatorClaim: "fixer-stobox-fulltest-01",
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
      reason: "Static/local scan found Stobox discovery, docs/deployment, tokenized-security, compliance, RWA/NAV, and consumer/exit context rows only; no current exact permissionless value movement, positive economics, or local/fork/static value-delta proof is present.",
    },
    blockers: BLOCKERS,
    requiredForRoutePositive: REQUIRED_FOR_ROUTE_POSITIVE,
    nextReadOnlyStep: NEXT_READ_ONLY_STEP,
    summary,
  };
}

function metricRows(summary) {
  const keys = [
    "sourceFactRows", "chainSeedRows", "addressSeedRows", "surfaceRows", "publicDocRows", "bugClassRows", "filesScanned", "filesWithLocalMatches", "filesWithExactLocalMatches", "localArtifactMatchRows", "exactLocalArtifactMatchRows", "receiptTokenRows", "navRateProviderRows", "tokenizedSecurityRows", "transferRestrictionRows", "redemptionCustodyRows", "roleAdminRows", "consumerJoinRows", "exactConsumerJoinRows", "oracleRows", "dexLiquidityRows", "exitLiquidityRows", "economicsContextRows", "producerAnomalies", "watchCandidates", "priorArtifactPositiveRowsNotPromoted", "publicFetchRows", "rpcInventoryRows", "graphqlInventoryRows", "ethCallRows", "forkRows", "exactEconomicsRows", "routePositive", "executableNow", "signedActionJustified", "forkJustified", "forkGate", "fullTestReadOnlyComplete",
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

  return `# 🟢 DORMANT - Stobox Full Test

Generated: ${payload.generatedAt}

Route remains closed: routePositive=${payload.routeGate.routePositive}, executableNow=${payload.routeGate.executableNow}, signedActionJustified=${payload.routeGate.signedActionJustified}, forkJustified=${payload.routeGate.forkJustified}, forkGate=${payload.routeGate.forkGate}.

## Summary

| Metric | Value |
|---|---:|
${metricRows(payload.summary)}

## Target / Scope

- Target: ${payload.target.name} (${payload.target.slug}), category=${payload.target.category}, surface=${payload.target.surface}, module=${payload.target.module}, rank≈${payload.target.discoveryRank}, TVL context≈${payload.target.tvlContext}.
- EVM chains: ${payload.scope.evmFirstChains.join(", ")}; caveat chains: none from discovery row.
- Route graph: ${payload.target.routeGraph}.
- Adapter context: adapterFetched=${payload.target.adapterFetched}, adapterAddressCount=${payload.target.adapterAddressCount}, hints=${payload.target.adapterHints.length ? payload.target.adapterHints.join(", ") : "none"}.
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

## Notable Local Rows (watch/context only)

| Source | Categories | Match | Detail | Route | Classification |
|---|---|---|---|---:|---|
${notableRows}

## Route Gate

- Status: ${payload.routeGate.status}.
- Required fail-closed conjunction is absent: exactPermissionlessValueMovement=${payload.routeGate.exactPermissionlessValueMovement}, exactPositiveEconomics=${payload.routeGate.exactPositiveEconomics}, localForkStaticProof=${payload.routeGate.localForkStaticProof}.
- No confirmed public NAV/rate-provider contract was resolved from the supplied docs context; NAV/rate proof remains an explicit blocker.
- Local RWA/NAV, consumer, DEX, and bridge artifacts are not promoted without a Stobox-specific exact consumer/exit join and current economics.
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
  log("Scanning Stobox local artifacts (sanitized, no endpoint inventory read)...");
  const files = listScanFiles();
  const lineScan = scanLocalArtifactLines(files);
  const payload = buildPayload({ lineScan });
  writeJson(OUT_JSON, payload);
  writeText(OUT_MD, buildMarkdown(payload));
  log(`Wrote ${OUT_JSON_REL} and ${OUT_MD_REL}`);
  log(`routePositive=${payload.summary.routePositive}; exactEconomicsRows=${payload.summary.exactEconomicsRows}; localArtifactMatchRows=${payload.summary.localArtifactMatchRows}; exactConsumerJoinRows=${payload.summary.exactConsumerJoinRows}`);
}

main();
