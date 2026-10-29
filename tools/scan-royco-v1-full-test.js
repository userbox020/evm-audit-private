#!/usr/bin/env node
"use strict";

// scan-royco-v1-full-test.js
// Defensive Royco V1 full-test scanner. Artifact/static/local-first; no endpoint inventory reads.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const REPORTS_DIR = path.join(WORKSPACE, "reports");
const OUT_JSON = path.join(RAW_DIR, "royco-v1-full-test.json");
const OUT_MD = path.join(REPORTS_DIR, "royco-v1-full-test-triage.md");
const OUT_JSON_REL = "reports/raw/fast/royco-v1-full-test.json";
const OUT_MD_REL = "reports/royco-v1-full-test-triage.md";

const QUIET = process.argv.includes("--quiet");
const GENERATED_AT = process.env.SCAN_GENERATED_AT || "2026-07-07T00:00:00.000Z";

const MAX_FILE_BYTES = 24 * 1024 * 1024;
const MAX_LOCAL_MATCH_ROWS = 440;
const MAX_LOCAL_OBJECT_ROWS = 360;
const MAX_ROWS_PER_FILE = 34;
const MAX_JSON_DEPTH = 9;

const TARGET = {
  slug: "royco-v1",
  name: "Royco V1",
  kind: "protocol",
  category: "Yield",
  discoveryRank: 15,
  tvlContextUsd: 15_957_446.43,
  tvlContext: "$15.957M",
  surface: "vault-yield-allocator",
  primaryChains: ["Berachain", "Arbitrum", "Ethereum", "Sonic", "Base"],
  routeGraph: "vault share -> rate/strategy accounting -> consumer or exit venue -> borrow/redeem/unwind",
  module: "projects/royco/index.js",
  adapterPathLabel: "defillama-adapter:projects/royco/index.js",
};

const CHAIN_SEEDS = [
  { chain: "Berachain", chainLabel: "Berachain", chainId: 80094, adapterKey: "berachain", evmFirst: true, caveat: false, classification: "primary-evm-discovery-chain" },
  { chain: "Arbitrum", chainLabel: "Arbitrum", chainId: 42161, adapterKey: "arbitrum", evmFirst: true, caveat: false, classification: "primary-evm-discovery-chain" },
  { chain: "Ethereum", chainLabel: "Ethereum", chainId: 1, adapterKey: "ethereum", evmFirst: true, caveat: false, classification: "primary-evm-discovery-chain" },
  { chain: "Sonic", chainLabel: "Sonic", chainId: 146, adapterKey: "sonic", evmFirst: true, caveat: false, classification: "primary-evm-discovery-chain" },
  { chain: "Base", chainLabel: "Base", chainId: 8453, adapterKey: "base", evmFirst: true, caveat: false, classification: "primary-evm-discovery-chain" },
  { chain: "Plume Mainnet", chainLabel: "Plume Mainnet", chainId: null, adapterKey: "plume", evmFirst: false, caveat: true, classification: "caveat-unless-safe-read-only-coverage" },
  { chain: "Hyperliquid L1", chainLabel: "Hyperliquid L1 / HyperEVM", chainId: null, adapterKey: "hyperliquid", evmFirst: false, caveat: true, classification: "caveat-unless-safe-read-only-coverage" },
  { chain: "Corn", chainLabel: "Corn", chainId: null, adapterKey: "corn", evmFirst: false, caveat: true, classification: "caveat-unless-safe-read-only-coverage" },
];

const ADDRESS_SEEDS = [
  { chain: "Ethereum/Arbitrum/Base", role: "PointsFactory", address: "0x19112AdBDAfB465ddF0b57eCC07E68110Ad09c50", surface: "iam-points", classification: "deterministic-deployment-static-not-live-state-proof" },
  { chain: "Ethereum/Arbitrum/Base", role: "WrappedVaultFactory", address: "0x75E502644284eDf34421f9c355D75DB79e343Bca", surface: "iam-wrapped-vault-factory", classification: "deterministic-deployment-static-not-live-state-proof" },
  { chain: "Ethereum/Arbitrum/Base", role: "VaultMarketHub", address: "0xa97eCc6Bfda40baf2fdd096dD33e88bd8e769280", surface: "iam-vault-market", classification: "deterministic-deployment-static-not-live-state-proof" },
  { chain: "Ethereum/Arbitrum/Base", role: "WeirollWallet implementation", address: "0x40a1c08084671E9A799B73853E82308225309Dc0", surface: "iam-weiroll", classification: "deterministic-deployment-static-not-live-state-proof" },
  { chain: "Ethereum/Arbitrum/Base", role: "RecipeMarketHub", address: "0x783251f103555068c1E9D755f69458f39eD937c0", surface: "iam-recipe-market", classification: "deterministic-deployment-static-not-live-state-proof" },
  { chain: "Ethereum", role: "RoyUSDCMainnet vault", symbol: "RoyUSDCMainnet", address: "0x74D1fAfa4e0163b2f1035F1b052137F3f9baD5cC", surface: "boring-vault-share", classification: "static-vault-seed-not-live-state-proof" },
  { chain: "Ethereum/Sonic/Plume", role: "BoringVault lens", address: "0x90983EBF38E981AE38f7Da9e71804380e316A396", surface: "boring-vault-lens", classification: "static-lens-seed-not-live-state-proof" },
  { chain: "Ethereum/Sonic", role: "RoyUSDC accountant", address: "0x80f0B206B7E5dAa1b1ba4ea1478A33241ee6baC9", surface: "boring-vault-accountant", classification: "static-accountant-seed-not-live-state-proof" },
  { chain: "Ethereum/Sonic", role: "RoyUSDC teller", address: "0x60EBb5d1454Bb99aa35F63F609E79179b342B0b8", surface: "boring-vault-teller", classification: "static-teller-seed-not-live-state-proof" },
  { chain: "Sonic", role: "RoySonicUSDC vault", symbol: "RoySonicUSDC", address: "0x45088fb2FfEBFDcf4dFf7b7201bfA4Cd2077c30E", surface: "boring-vault-share", classification: "static-vault-seed-not-live-state-proof" },
  { chain: "Sonic", role: "RoySonicUSDC accountant", address: "0x8301294E84cA5a2644E7F3CD47A86369F1b0416e", surface: "boring-vault-accountant", classification: "static-accountant-seed-not-live-state-proof" },
  { chain: "Sonic", role: "RoySonicUSDC teller", address: "0x0F75c8176d4eBDff78d9a0c486B35d8F94b00A42", surface: "boring-vault-teller", classification: "static-teller-seed-not-live-state-proof" },
  { chain: "Plume Mainnet", role: "RoyPlumeUSDC vault", symbol: "RoyPlumeUSDC", address: "0x83A6F6034ee44De6648B1885e24D837D8D98698f", surface: "boring-vault-share-caveat", caveat: true, classification: "plume-context-caveat-not-live-state-proof" },
  { chain: "Plume Mainnet", role: "RoyPlumeUSDC accountant", address: "0xfFfBF5B884AdF7297B94e62535D1b031387041Bd", surface: "boring-vault-accountant-caveat", caveat: true, classification: "plume-context-caveat-not-live-state-proof" },
  { chain: "Plume Mainnet", role: "RoyPlumeUSDC teller", address: "0x4Fc294112fD0b7226ecA095FEE9909E30882Cb11", surface: "boring-vault-teller-caveat", caveat: true, classification: "plume-context-caveat-not-live-state-proof" },
];

const SURFACE_ROWS = [
  { label: "IAM legacy/non-custodial context", category: "iam" },
  { label: "RecipeMarketHub createMarket/createAPOffer/createIPOffer/fill/cancel/claim/forfeit/executeWithdrawalScript", category: "recipe-market" },
  { label: "VaultMarketHub createAPOffer/allocateOffer/cancelOffer/getOfferHash/setOffersPaused", category: "vault-market" },
  { label: "WrappedVault ERC4626 asset/totalAssets/deposit/mint/withdraw/redeem/convert/preview/max", category: "wrapped-vault" },
  { label: "WrappedVault rewards intervals/claim/fees/frontend fee", category: "reward" },
  { label: "WeirollWallet executeWeiroll/manualExecuteWeiroll/execute/forfeit/lockedUntil/isValidSignature", category: "weiroll" },
  { label: "PointsFactory and event-only points", category: "points" },
  { label: "CCDM DepositLocker/DepositExecutor/LayerZero/green-lighter/rage-quit/receipt-token/unlock timestamp", category: "ccdm" },
  { label: "BoringVault lens/accountant/teller share-rate accounting", category: "boring-vault" },
  { label: "queue/epoch/role/access/proxy contexts", category: "access" },
  { label: "oracle/DEX/consumer join contexts", category: "consumer-dex-oracle" },
];

const SOURCE_FACTS = [
  {
    sourceLabel: "local-prefilter-discovery-row-2026-06-24",
    kind: "local-discovery",
    slug: TARGET.slug,
    name: TARGET.name,
    surface: TARGET.surface,
    tvlContext: TARGET.tvlContext,
    chains: TARGET.primaryChains,
    routeGraph: TARGET.routeGraph,
    classification: "target-seed",
  },
  {
    sourceLabel: "local-structured-discovery-row-2026-06-24",
    kind: "local-discovery-json",
    slug: TARGET.slug,
    module: "royco/index.js",
    adapterFetched: true,
    adapterAddressCount: 10,
    adapterHints: [],
    routePositive: 0,
    classification: "structured-target-seed-route-negative",
  },
  {
    sourceLabel: "defillama-protocol-label:royco-v1",
    kind: "public-static-label",
    slug: TARGET.slug,
    module: TARGET.module,
    adapterChains: CHAIN_SEEDS.map((row) => row.adapterKey),
    classification: "source-label-only-no-url-stored",
  },
  {
    sourceLabel: "defillama-adapter-label:projects/royco/index.js",
    kind: "public-static-label",
    addressSeedRows: ADDRESS_SEEDS.length,
    classification: "address-seeds-static-not-live-code-or-state-proof",
  },
  {
    sourceLabel: "official-docs-label",
    kind: "public-static-label",
    surfaceRows: SURFACE_ROWS.length,
    classification: "surface-labels-only-no-url-stored",
  },
];

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const EXACT_RULES = [
  { label: "royco-v1", regex: /\broyco[\s_-]*v1\b/i },
  { label: "Royco V1", regex: /\bRoyco\s+V1\b/ },
  { label: "projects/royco/index.js", regex: /projects[\\/]royco[\\/]index\.js/i },
  { label: "royco/index.js", regex: /\broyco[\\/]index\.js/i },
  { label: "PointsFactory", regex: /\bPointsFactory\b/ },
  { label: "WrappedVaultFactory", regex: /\bWrappedVaultFactory\b/ },
  { label: "VaultMarketHub", regex: /\bVaultMarketHub\b/ },
  { label: "RecipeMarketHub", regex: /\bRecipeMarketHub\b/ },
  { label: "WeirollWallet", regex: /\bWeirollWallet\b/ },
  { label: "RoyUSDCMainnet", regex: /\bRoyUSDCMainnet\b/i },
  { label: "RoyUSDCSonic", regex: /\bRoyUSDCSonic\b/i },
  { label: "RoySonicUSDC", regex: /\bRoySonicUSDC\b/i },
  { label: "RoyPlumeUSDC", regex: /\bRoyPlumeUSDC\b/i },
  ...ADDRESS_SEEDS.map((row) => ({ label: `${row.chain} ${row.role}`, regex: new RegExp(escapeRegExp(row.address), "i") })),
];

const CONTEXT_RULES = [
  { label: "IAM", regex: /\bIAM\b/ },
  { label: "Royco", regex: /\broyco\b/i },
  { label: "RecipeMarketHub", regex: /\bRecipeMarketHub\b/ },
  { label: "VaultMarketHub", regex: /\bVaultMarketHub\b/ },
  { label: "WrappedVault", regex: /\bWrappedVault\b/ },
  { label: "Weiroll", regex: /\bWeiroll\b/i },
  { label: "PointsFactory", regex: /\bPointsFactory\b/ },
  { label: "CCDM", regex: /\bCCDM\b/ },
  { label: "DepositLocker", regex: /\bDepositLocker\b/ },
  { label: "DepositExecutor", regex: /\bDepositExecutor\b/ },
  { label: "LayerZero", regex: /\bLayerZero\b/i },
  { label: "green-lighter", regex: /\bgreen[-\s]?lighter\b/i },
  { label: "rage-quit", regex: /\brage[-\s]?quit\b/i },
  { label: "receipt-token", regex: /\breceipt[-\s]?tokens?\b/i },
  { label: "unlock timestamp", regex: /\bunlock\s+timestamp\b/i },
  { label: "BoringVault", regex: /\bBoringVault\b/i },
  { label: "accountant", regex: /\baccountant\b/i },
  { label: "teller", regex: /\bteller\b/i },
  { label: "lens", regex: /\blens\b/i },
  { label: "ERC4626", regex: /\berc[-_]?4626\b/i },
  { label: "totalAssets", regex: /\btotalAssets\b/i },
  { label: "convertToAssets", regex: /\bconvertToAssets\b/i },
  { label: "previewRedeem", regex: /\bpreviewRedeem\b/i },
  { label: "maxWithdraw", regex: /\bmaxWithdraw\b/i },
  { label: "rewards", regex: /\brewards?\b/i },
  { label: "epoch", regex: /\bepoch\b/i },
  { label: "queue", regex: /\bqueue\b/i },
  { label: "offer", regex: /\boffers?\b/i },
  { label: "forfeit", regex: /\bforfeit\b/i },
  { label: "claim", regex: /\bclaim\b/i },
  { label: "role/access", regex: /\b(role|access|owner|admin|pauser|guardian|proxy)\b/i },
  { label: "oracle", regex: /\boracle\b/i },
  { label: "DEX", regex: /\bdex\b/i },
  { label: "consumer", regex: /\bconsumer\b/i },
  { label: "redeem", regex: /\bredeem\b/i },
  { label: "unwind", regex: /\bunwind\b/i },
  { label: "routePositive", regex: /\broutePositive\b/i },
];

const CATEGORY_RULES = {
  consumer: ["consumer", "accepted", "collateral", "borrow", "lending", "market", "vault", "lltv", "ltv", "supplycap", "cash", "exit venue"],
  dex: ["dex", "swap", "pool", "amm", "curve", "uniswap", "balancer", "liquidity", "router", "quote", "exit", "unwind"],
  oracle: ["oracle", "price", "feed", "rate", "accounting", "accountant", "share-rate", "valuation", "totalassets", "converttoassets"],
  vault: ["wrappedvault", "boringvault", "vault", "erc4626", "share", "asset", "totalassets", "totalsupply", "deposit", "withdraw", "mint", "redeem", "preview", "maxwithdraw"],
  iam: ["iam", "recipemarkethub", "vaultmarkethub", "weiroll", "pointsfactory", "offer", "forfeit", "claim", "recipe"],
  reward: ["reward", "rewards", "claim", "fees", "frontendfee", "interval", "epoch"],
  ccdm: ["ccdm", "depositlocker", "depositexecutor", "layerzero", "green-lighter", "rage-quit", "receipt-token", "unlock timestamp"],
  access: ["role", "access", "owner", "admin", "guardian", "pauser", "proxy", "implementation", "paused"],
  queueEpoch: ["queue", "epoch", "lockeduntil", "unlock", "delay"],
  economics: ["routepositive", "positive", "profit", "overvalue", "overvaluation", "tvl", "liquidity", "slippage", "supplyusd", "borrowusd", "exacteconomics"],
};

const JSON_FIELD_ALLOWLIST = [
  "rank", "kind", "slug", "name", "category", "tvlUsd", "tvl", "currentTvlUsd", "chains", "primaryChain", "evmChains", "accessibleEvmChains", "blockedOrCaveatChains", "surface", "routeGraph", "firstReadOnlyChecks", "audits", "module", "score", "chain", "chainId", "adapterKey", "adapterChain", "symbol", "assetSymbol", "assetName", "asset", "underlying", "token", "vault", "vaultSymbol", "vaultName", "market", "hub", "factory", "lens", "accountant", "teller", "owner", "implementation", "proxy", "role", "totalAssets", "totalAssetsRaw", "totalSupply", "totalSupplyRaw", "convertToAssets", "previewRedeem", "maxWithdraw", "cashRaw", "supplyUsd", "borrowUsd", "usdTotal", "liquidity", "routePositive", "executableNow", "signedActionJustified", "forkJustified", "classification", "status", "watchCandidate",
];

const BLOCKERS = [
  "No exact-positive Royco V1 vault/share -> accounting -> consumer/exit route is proven in local artifacts; address rows are static seeds only.",
  "Adapter TVL, subgraph-style rows, and deterministic deployment labels do not prove live code, current vault state, accepted collateral value, or exit liquidity.",
  "WrappedVault/BoringVault rows require exact asset, totalAssets, totalSupply, convertToAssets/preview/max limits, teller/accountant semantics, and redeemability before route-positive status.",
  "RecipeMarketHub/VaultMarketHub offer rows require concrete fill/allocate/cancel/claim/forfeit economics and no pause/role/script blocker.",
  "WeirollWallet execution/forfeit/lockedUntil paths require exact permissionless execution and attacker-controlled value delta, not just function/event presence.",
  "Rewards/Points/CCDM/LayerZero/receipt-token/unlock timestamp contexts are not value-positive without exact claim/unlock/redeem and exit amounts.",
  "No oracle/share-rate/accounting overvaluation is quantified versus immediate redeem, swap, or unwind value after fees, slippage, queue/epoch delays, and gas.",
  "DEX/consumer joins are context only until a concrete accepted share asset, consumer caps/cash/oracle, and exit route are quantified at size.",
  "Plume Mainnet, Hyperliquid L1/HyperEVM, and Corn remain caveats unless safe read-only coverage exists and endpoint details remain sanitized.",
  "Fork and signed-action gates remain closed because routePositive=0 and exactEconomicsRows=0.",
];

const REQUIRED_FOR_ROUTE_POSITIVE = [
  "Exact producer share and consumer: identify a specific Royco WrappedVault/BoringVault/IAM asset accepted by a current consumer or exit venue with material caps and liquidity.",
  "Share-rate/accounting proof: quantify asset(), totalAssets(), totalSupply(), convertToAssets(), previewRedeem(), maxWithdraw/maxRedeem, teller/accountant rates, queues, epochs, and fees.",
  "IAM offer proof: compute create/fill/allocate/cancel/claim/forfeit/executeWithdrawalScript economics with no pause/role/lockedUntil/script blockers.",
  "Rewards/points proof: prove claimable token value (not event-only points) can be captured and unwound by the attacker after fees and restrictions.",
  "CCDM/bridge proof: validate DepositLocker/DepositExecutor/LayerZero/receipt-token/unlock timestamp flows and prove no custody/finality/queue blocker.",
  "Oracle/consumer proof: verify consumer oracle freshness/scaling, accepted value, caps, cash/borrow capacity, and no role/pause/proxy blocker.",
  "Exit liquidity proof: compute DEX/AMM/CEX unwind liquidity, price impact, transfer restrictions, and gas for the exact share/underlying/reward asset.",
  "Caveat-chain proof: only include Plume/HyperEVM/Corn if safe read-only coverage exists and endpoint details remain fully sanitized.",
  "Fork/static value-delta proof: local static proof or fork simulation must show positive attacker-controlled balance delta before any live preflight or signed action is considered.",
  "Explicit route-specific authorization and independent defensive review are required before any signed transaction path is discussed.",
];

const NEXT_READ_ONLY_STEP = "Map Royco V1 deterministic IAM and vault/accountant/teller seeds to local ERC4626/BoringVault/consumer artifacts, then compare share-rate accounting against redeem/unwind/exit liquidity without endpoint inventory reads unless a concrete candidate needs sanitized read-only coverage.";

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

function sanitizeText(value, max = 320) {
  let text = String(value ?? "")
    .replace(/[\r\n|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  text = text
    .replace(/\bhttps?:\/\/[^\s"'`<>|)]+/gi, "[redacted-url]")
    .replace(/\bwww\.[^\s"'`<>|)]+/gi, "[redacted-url]")
    .replace(/\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|fi|app|xyz|finance|protocol|dev|co|so|network|tech|exchange|build|money|info|ai)\b/gi, "[redacted-domain]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/= -]+/gi, "Bearer [redacted]")
    .replace(/\b(authorization|api[-_]?key|access[-_]?key|private[-_]?key|secret[-_]?key|secret|password|pwd)\s*[:=]\s*["']?[^\s"',}\]]{8,}/gi, "$1=[redacted]")
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
  if (/(^|[\/\\])(private|secret|secrets|mnemonic|seed|wallet|keypair|keystore|api[-_]?key|access[-_]?key)([\/\\._-]|$)/i.test(r)) return true;
  return false;
}

function isExcludedScanPath(filePath) {
  const r = rel(filePath).toLowerCase();
  const base = path.basename(filePath).toLowerCase();
  if (r === OUT_JSON_REL.toLowerCase() || r === OUT_MD_REL.toLowerCase()) return true;
  if (r === "tools/scan-royco-v1-full-test.js") return true;
  if (isSecretLikePath(filePath)) return true;
  if (base.includes("endpoint")) return true;
  if (r.includes("/node_modules/") || r.includes("/.git/")) return true;
  if (r.includes("/cache/") || r.includes("/out/") || r.includes("/broadcast/") || r.includes("/artifacts/")) return true;
  if (r.startsWith(".opencode/") || r.startsWith("coordination/")) return true;
  if (/(?:handoff|shared_context|state\.md|audit-completion-gates|route-positive-sweep|low-fund-executable-route-filter|exploit-findings-summary|full-test)/i.test(r)) return true;
  return false;
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
        const relDir = rel(full).toLowerCase();
        if (relDir.startsWith("reports/") && relDir !== "reports/raw" && !relDir.startsWith("reports/raw/")) continue;
        if (/^(?:node_modules|\.git|cache|out|broadcast|artifacts|lib)$/i.test(entry.name)) continue;
        if (relDir.startsWith("coordination/")) continue;
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

function listScanFiles() {
  const roots = [path.join(WORKSPACE, "reports"), path.join(WORKSPACE, "tools")];
  return uniqBy(roots.flatMap(listFilesRecursive), (file) => path.resolve(file)).sort((a, b) => rel(a).localeCompare(rel(b)));
}

function firstRuleMatch(text, rules) {
  const raw = String(text || "");
  for (const rule of rules) {
    if (rule.regex.test(raw)) return rule;
  }
  return null;
}

function hasRuleMatch(text, rules) {
  return Boolean(firstRuleMatch(text, rules));
}

function matchForText(line, windowText, fileHasExact) {
  const exact = firstRuleMatch(line, EXACT_RULES) || firstRuleMatch(windowText, EXACT_RULES);
  if (exact) return { matchType: "exact-name-address-or-module", matched: exact.label, termType: "text" };
  const context = firstRuleMatch(line, CONTEXT_RULES);
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
    if (!fileHasExact) continue;
    const lines = text.split(/\r?\n/);
    let sampled = 0;
    let fileMatched = false;
    let fileExact = false;
    const seen = new Set();
    for (let i = 0; i < lines.length && rows.length < MAX_LOCAL_MATCH_ROWS && sampled < MAX_ROWS_PER_FILE; i += 1) {
      const line = String(lines[i] || "");
      if (!line.trim()) continue;
      const windowText = [lines[i - 2], lines[i - 1], lines[i], lines[i + 1], lines[i + 2]].map((x) => String(x || "")).join(" ");
      const match = matchForText(line, windowText, fileHasExact);
      if (!match) continue;
      const key = `${rel(file)}:${i + 1}:${match.matchType}:${match.matched}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fileMatched = true;
      if (match.matchType === "exact-name-address-or-module") fileExact = true;
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
        sample: sanitizeText(windowText, 420),
        routePositive: 0,
        classification: match.matchType === "exact-name-address-or-module" ? "exact-local-watch-context-only-no-positive-economics" : "local-artifact-watch-context-only-no-route-positive",
      });
      sampled += 1;
    }
    if (fileMatched) filesWithMatch += 1;
    if (fileExact) filesWithExact += 1;
    if (rows.length >= MAX_LOCAL_MATCH_ROWS) break;
  }
  return { filesScanned, filesWithMatch, filesWithExact, rows, exactRows: rows.filter((row) => row.matchType === "exact-name-address-or-module"), categoryCounts };
}

function shouldSkipJsonKey(key) {
  return /(url|uri|endpoint|hostname|host|domain|secret|password|private|api[-_]?key|access[-_]?key|auth|bearer|cookie|header)/i.test(String(key || ""));
}

function compactValue(value) {
  if (value === null || value === undefined) return null;
  if (["string", "number", "boolean"].includes(typeof value)) return typeof value === "string" ? sanitizeText(value, 220) : value;
  if (Array.isArray(value)) return value.slice(0, 12).map((item) => compactValue(item)).filter((item) => item !== null);
  if (isObject(value)) {
    const out = {};
    for (const [key, val] of Object.entries(value).slice(0, 18)) {
      if (shouldSkipJsonKey(key)) continue;
      const compacted = compactValue(val);
      if (compacted !== null && !(Array.isArray(compacted) && compacted.length === 0)) out[key] = compacted;
    }
    return out;
  }
  return sanitizeText(String(value), 220);
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
    fields.exactAccountingBypass = compactValue(value.routeGate.exactAccountingBypass);
    fields.exactEconomicsPositive = compactValue(value.routeGate.exactEconomicsPositive);
    fields.forkProof = compactValue(value.routeGate.forkProof);
  }
  return fields;
}

function fieldsContext(fields) {
  const parts = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    const rendered = typeof value === "object" ? JSON.stringify(value, jsonReplacer).slice(0, 180) : String(value);
    parts.push(`${key}=${rendered}`);
  }
  return sanitizeText(parts.join("; "), 520);
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
    const context = fieldsContext(fields) || sanitizeText(blob, 420);
    const objectHasExact = hasRuleMatch(`${blob} ${context || ""}`, EXACT_RULES);
    const match = objectHasExact ? matchForText(blob, `${blob} ${context || ""}`, true) : null;
    if (match && context) {
      const categories = categoriesFor(`${blob} ${context}`, rel(file));
      const key = `${rel(file)}:${jsonPath}:${match.matchType}:${match.matched}`;
      if (!seen.has(key)) {
        seen.add(key);
        for (const category of categories) categoryCounts[category] = (categoryCounts[category] || 0) + 1;
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
          routePositive: value.routePositive === true ? "local-row-true-untrusted-not-promoted" : (value.routePositive ?? 0),
          classification: match.matchType === "exact-name-address-or-module" ? "exact-local-watch-context-only-no-positive-economics" : "local-artifact-watch-context-only-no-route-positive",
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
    let json;
    try {
      json = JSON.parse(text);
    } catch (_error) {
      continue;
    }
    jsonFilesParsed += 1;
    visit(json, file, "$", 0);
    if (rows.length >= MAX_LOCAL_OBJECT_ROWS) break;
  }
  return { jsonFilesParsed, rows, exactRows: rows.filter((row) => row.matchType === "exact-name-address-or-module"), categoryCounts };
}

function exactish(row) {
  return row.matchType === "exact-name-address-or-module";
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
  const highSignal = rows.filter((row) => row.categories.some((cat) => ["vault", "iam", "reward", "ccdm", "access", "queueEpoch", "consumer", "dex", "oracle"].includes(cat)));
  return uniqBy([...exact, ...highSignal], (row) => `${sourceForRow(row)}:${row.matchType}:${row.matched}`).slice(0, 28);
}

function buildPayload({ lineScan, objectScan }) {
  const combinedRows = uniqBy([...objectScan.rows, ...lineScan.rows], (row) => `${sourceForRow(row)}:${row.matchType}:${row.matched}:${row.rowSource}`);
  const exactRows = combinedRows.filter(exactish);
  const consumerJoinRows = pickRows(combinedRows, (row) => row.categories.includes("consumer"), 140);
  const exactConsumerJoinRows = pickRows(consumerJoinRows, exactish, 120);
  const dexLiquidityRows = pickRows(combinedRows, (row) => row.categories.includes("dex"), 140);
  const oracleRows = pickRows(combinedRows, (row) => row.categories.includes("oracle"), 140);
  const vaultRows = pickRows(combinedRows, (row) => row.categories.includes("vault"), 140);
  const iamRows = pickRows(combinedRows, (row) => row.categories.includes("iam"), 140);
  const rewardRows = pickRows(combinedRows, (row) => row.categories.includes("reward"), 140);
  const ccdmRows = pickRows(combinedRows, (row) => row.categories.includes("ccdm"), 140);
  const accessRows = pickRows(combinedRows, (row) => row.categories.includes("access"), 140);
  const queueEpochRows = pickRows(combinedRows, (row) => row.categories.includes("queueEpoch"), 140);
  const notableRows = selectNotableRows(combinedRows);
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
    filesScanned: lineScan.filesScanned,
    filesWithLocalMatches: lineScan.filesWithMatch,
    filesWithExactLocalMatches: lineScan.filesWithExact,
    jsonFilesParsed: objectScan.jsonFilesParsed,
    localArtifactMatchRows: combinedRows.length,
    exactLocalArtifactMatchRows: exactRows.length,
    localLineRows: lineScan.rows.length,
    localObjectRows: objectScan.rows.length,
    exactLocalObjectRows: objectScan.exactRows.length,
    consumerJoinRows: consumerJoinRows.length,
    exactConsumerJoinRows: exactConsumerJoinRows.length,
    dexLiquidityRows: dexLiquidityRows.length,
    oracleRows: oracleRows.length,
    vaultRows: vaultRows.length,
    iamRows: iamRows.length,
    rewardRows: rewardRows.length,
    ccdmRows: ccdmRows.length,
    accessRows: accessRows.length,
    queueEpochRows: queueEpochRows.length,
    publicFetchRows: 0,
    rpcInventoryRows: 0,
    graphqlInventoryRows: 0,
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
    scanner: "tools/scan-royco-v1-full-test.js",
    target: TARGET,
    scope: {
      kind: "defensive route-first full-test scanner",
      artifactStaticLocalFirst: true,
      evmFirst: true,
      evmFirstChains: CHAIN_SEEDS.filter((row) => row.evmFirst).map((row) => row.chainLabel),
      caveatChains: CHAIN_SEEDS.filter((row) => row.caveat).map((row) => row.chainLabel),
      routeGraph: TARGET.routeGraph,
      writesLimitedTo: [OUT_JSON_REL, OUT_MD_REL],
      aggregatePromotionStateHandoffEdited: false,
      endpointPolicy: "Endpoint inventories are authorized for read-only use when needed, but this first pass did not read them and raw endpoints/domains/keys are never persisted.",
    },
    safety: {
      localArtifactsRead: true,
      publicSourcesRead: true,
      publicNetworkFetch: false,
      rpcInventoryRead: false,
      rpcInventoryRows: 0,
      graphqlInventoryRead: false,
      graphqlInventoryRows: 0,
      envFilesRead: false,
      privateKeysRead: false,
      keyMaterialRead: false,
      rpcUrlsStored: false,
      rawUrlsStored: false,
      rawDomainsStored: false,
      graphqlUrlsStored: false,
      signedActions: false,
      liveTransactions: false,
      broadcasts: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      ethCallOnly: false,
      sanitizedOutputOnly: true,
      secretLikePathsExcluded: true,
    },
    sourceFacts: SOURCE_FACTS,
    discoveredSeeds: { chainSeeds: CHAIN_SEEDS, addressSeeds: ADDRESS_SEEDS, surfaceRows: SURFACE_ROWS },
    localArtifacts: {
      filesScanned: lineScan.filesScanned,
      filesWithMatch: lineScan.filesWithMatch,
      filesWithExact: lineScan.filesWithExact,
      jsonFilesParsed: objectScan.jsonFilesParsed,
      categoryCounts: mergeCategoryCounts(lineScan.categoryCounts, objectScan.categoryCounts),
      rows: combinedRows,
      exactRows: exactRows.slice(0, 160),
      notableRows,
    },
    categoryRows: { consumerJoinRows, exactConsumerJoinRows, dexLiquidityRows, oracleRows, vaultRows, iamRows, rewardRows, ccdmRows, accessRows, queueEpochRows },
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
      reason: "Artifact/static scan found context rows only; exact permissionless value movement + positive economics + local/fork/static proof are absent.",
    },
    blockers: BLOCKERS,
    requiredForRoutePositive: REQUIRED_FOR_ROUTE_POSITIVE,
    nextReadOnlyStep: NEXT_READ_ONLY_STEP,
    summary,
  };
}

function metricRows(summary) {
  const keys = ["sourceFactRows", "chainSeedRows", "addressSeedRows", "surfaceRows", "filesScanned", "filesWithLocalMatches", "filesWithExactLocalMatches", "jsonFilesParsed", "localArtifactMatchRows", "exactLocalArtifactMatchRows", "localLineRows", "localObjectRows", "consumerJoinRows", "exactConsumerJoinRows", "dexLiquidityRows", "oracleRows", "vaultRows", "iamRows", "rewardRows", "ccdmRows", "accessRows", "queueEpochRows", "publicFetchRows", "rpcInventoryRows", "graphqlInventoryRows", "exactEconomicsRows", "routePositive", "executableNow", "signedActionJustified", "forkJustified", "forkGate"];
  return keys.map((key) => `| ${key} | ${mdEscape(summary[key])} |`).join("\n");
}

function safetyRows(safety) {
  const keys = ["localArtifactsRead", "publicSourcesRead", "publicNetworkFetch", "rpcInventoryRead", "graphqlInventoryRead", "envFilesRead", "privateKeysRead", "keyMaterialRead", "rpcUrlsStored", "rawUrlsStored", "rawDomainsStored", "graphqlUrlsStored", "signedActions", "liveTransactions", "broadcasts", "exploitExecuteCalls", "forkTransactions", "ethCallOnly", "sanitizedOutputOnly", "secretLikePathsExcluded"];
  return keys.map((key) => `| ${key} | ${mdEscape(safety[key])} |`).join("\n");
}

function sourceForDisplay(row) {
  return sourceForRow(row);
}

function formatRow(row) {
  const categories = (row.categories || []).join(",");
  const detail = row.context || row.sample || fieldsContext(row.fields || {}) || "context-only";
  return `| ${mdEscape(sourceForDisplay(row))} | ${mdEscape(categories)} | ${mdEscape(row.matched)} | ${mdEscape(detail)} | ${mdEscape(row.routePositive)} | ${mdEscape(row.classification)} |`;
}

function formatAddressSeed(row) {
  return `| ${mdEscape(row.chain)} | ${mdEscape(row.role)} | ${mdEscape(row.symbol || "-")} | ${mdEscape(row.address)} | ${mdEscape(row.surface)} | ${mdEscape(row.classification)} |`;
}

function buildMarkdown(payload) {
  const signal = payload.routeGate.routePositive === 0 ? "🟢 DORMANT" : "🔴 ROUTE-POSITIVE";
  const notableRows = payload.localArtifacts.notableRows.length ? payload.localArtifacts.notableRows.map(formatRow).join("\n") : "| (none) | n/a | n/a | no local context rows found | 0 | dormant |";
  const seedRows = payload.discoveredSeeds.addressSeeds.map(formatAddressSeed).join("\n");
  return `# ${signal} - Royco V1 Full Test

Generated: ${payload.generatedAt}

Route remains closed: routePositive=${payload.routeGate.routePositive}, executableNow=${payload.routeGate.executableNow}, signedActionJustified=${payload.routeGate.signedActionJustified}, forkJustified=${payload.routeGate.forkJustified}, forkGate=${payload.routeGate.forkGate}.

## Summary

| Metric | Value |
|---|---:|
${metricRows(payload.summary)}

## Target

- Target: ${payload.target.name} (${payload.target.slug}), kind=${payload.target.kind}, category=${payload.target.category}, surface=${payload.target.surface}, module=${payload.target.module}, rank≈${payload.target.discoveryRank}, TVL context≈${payload.target.tvlContext}.
- EVM-first chains: ${payload.scope.evmFirstChains.join(", ")}.
- Caveat chains/context: ${payload.scope.caveatChains.join(", ") || "none"}.
- Route graph: ${payload.target.routeGraph}.
- Static public source labels only: ${payload.sourceFacts.map((row) => row.sourceLabel).join(", ")}.

## Scope / Endpoint Policy

- Scanner kind: ${payload.scope.kind}; artifactStaticLocalFirst=${payload.scope.artifactStaticLocalFirst}; evmFirst=${payload.scope.evmFirst}.
- Writes limited to: ${payload.scope.writesLimitedTo.join(", ")}.
- ${payload.scope.endpointPolicy}
- No aggregate gate scripts, state/context files, handoff files, secret/endpoint details, or wallet/key material are written or persisted.

## Safety

| Field | Value |
|---|---:|
${safetyRows(payload.safety)}

## Address / Deployment Seeds (static, not live code/state proof)

| Chain | Role | Symbol | Address | Surface | Classification |
|---|---|---|---|---|---|
${seedRows}

## Notable Local Rows (watch/context only)

| Source | Categories | Match | Detail | Route | Classification |
|---|---|---|---|---:|---|
${notableRows}

## Route Gate

- Status: ${payload.routeGate.status}.
- Required fail-closed conjunction is absent: exactPermissionlessValueMovement=${payload.routeGate.exactPermissionlessValueMovement}, exactPositiveEconomics=${payload.routeGate.exactPositiveEconomics}, localForkStaticProof=${payload.routeGate.localForkStaticProof}.
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
  log("Scanning Royco V1 local artifacts (sanitized, no endpoint inventory read)...");
  const files = listScanFiles();
  const lineScan = scanLocalArtifactLines(files);
  const objectScan = scanLocalJsonObjects(files);
  const payload = buildPayload({ lineScan, objectScan });
  writeJson(OUT_JSON, payload);
  writeText(OUT_MD, buildMarkdown(payload));
  log(`Wrote ${OUT_JSON_REL} and ${OUT_MD_REL}`);
  log(`routePositive=${payload.summary.routePositive}; localArtifactMatchRows=${payload.summary.localArtifactMatchRows}; exactLocalArtifactMatchRows=${payload.summary.exactLocalArtifactMatchRows}`);
}

main();
