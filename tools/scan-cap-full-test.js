#!/usr/bin/env node
"use strict";

// scan-cap-full-test.js
// Defensive Cap full-test scanner. Local artifacts + optional sanitized read-only Ethereum eth_call probes only.

const fs = require("fs");
const path = require("path");

let sharedRpc = null;
try {
  sharedRpc = require("./shared-rpc");
} catch (_error) {
  sharedRpc = null;
}

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const REPORTS_DIR = path.join(WORKSPACE, "reports");
const OUT_JSON = path.join(RAW_DIR, "cap-full-test.json");
const OUT_MD = path.join(REPORTS_DIR, "cap-full-test-triage.md");
const OUT_JSON_REL = "reports/raw/fast/cap-full-test.json";
const OUT_MD_REL = "reports/cap-full-test-triage.md";

const DEEP_DISCOVERY_FILE = path.join(RAW_DIR, "prefilter-deep-new-target-search-2026-06-24.json");
const TRIAGE_FILE = path.join(REPORTS_DIR, "cap-triage.md");
const PROTOCOL_TRIAGE_FILE = path.join(REPORTS_DIR, "cap-protocol-triage.md");
const OFT_REPORT_FILE = path.join(WORKSPACE, "targets", "cap-contracts", "oft-config-report.txt");

const QUIET = process.argv.includes("--quiet");
const MAX_FILE_BYTES = 24 * 1024 * 1024;
const MAX_LOCAL_MATCH_ROWS = 360;
const MAX_ROWS_PER_FILE = 30;
const RPC_TIMEOUT_MS = 2_500;
const ETH_CALL_TIMEOUT_MS = 2_500;

const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dEaD";
const ONE_18 = 10n ** 18n;
const THOUSAND_18 = 1_000n * ONE_18;
const THOUSAND_USDC = 1_000_000_000n;

const TARGET = {
  slug: "cap",
  name: "Cap",
  category: "Lending",
  discoveryRank: 11,
  tvlContextUsd: 217_238_000,
  tvlContext: "$217.238M",
  primaryChain: "Ethereum",
  surface: "lending-oracle-liquidation",
  routeGraph: "collateral token -> oracle/accounting value -> borrow/liquidation path -> DEX/stable exit",
  firstReadOnlyChecks: [
    "map markets/oracles",
    "query caps/pauses/borrow cash",
    "compare accepted value to market/redeem value",
  ],
  module: "cap-money/index.js",
  adapterHints: ["oracle", "bridge/custody"],
};

const CHAIN_SEEDS = [
  { chain: "Ethereum", chainLabel: "Ethereum", chainId: 1, adapterKey: "ethereum", inScope: true, caveat: false },
  { chain: "MegaETH", chainLabel: "MegaETH", chainId: null, adapterKey: "megaeth", inScope: false, caveat: true },
  { chain: "Tempo", chainLabel: "Tempo", chainId: null, adapterKey: "tempo", inScope: false, caveat: true },
  { chain: "Katana", chainLabel: "Katana", chainId: null, adapterKey: "katana", inScope: false, caveat: true },
  { chain: "Monad", chainLabel: "Monad", chainId: null, adapterKey: "monad", inScope: false, caveat: true, source: "local-oft-report" },
];

const CONTRACT_SEEDS = [
  { role: "cUSD/Vault", symbol: "cUSD", address: "0xcCcc62962d17b8914c62D74FfB843d73B2a3cccC", implementation: "0xa76645E15c267b876999bf7689E0b2C1EE29BFE6", chain: "Ethereum", chainId: 1, type: "vault-token", source: "reports/cap-triage.md" },
  { role: "stcUSD", symbol: "stcUSD", address: "0x88887bE419578051FF9F4eb6C858A951921D8888", implementation: "0x42c0e0ef7C2F35de073F4d6f9c0e4483429c3D31", chain: "Ethereum", chainId: 1, type: "staked-token", source: "reports/cap-triage.md" },
  { role: "Oracle", address: "0xcD7f45566bc0E7303fB92A93969BB4D3f6e662bb", implementation: "0xbFe4D64E61a3a02C4781a65FA343007de7ea9F14", chain: "Ethereum", chainId: 1, type: "oracle", source: "reports/cap-triage.md" },
  { role: "Lender", address: "0x15622c3dbbc5614E6DFa9446603c1779647f01FC", implementation: "0x68c4F03b8640C0393a832987147BaE7A0b27aaa7", chain: "Ethereum", chainId: 1, type: "lender", source: "reports/cap-triage.md" },
  { role: "AccessControl", address: "0x7731129a10d51e18cDE607C5C115F26503D2c683", chain: "Ethereum", chainId: 1, type: "access-control", source: "user-public-context" },
  { role: "Delegation", address: "0xF3E3Eae671000612CE3Fd15e1019154C1a4d693F", implementation: "0x7e2D738042376BF48bEbC49932869eAC3d7E38b5", chain: "Ethereum", chainId: 1, type: "delegation", source: "reports/cap-triage.md" },
  { role: "Fee Auction", address: "0xa1a20aBdc873CF291c22Ce3C8968EC06277324D0", implementation: "0x57e1E8e5576c5CFbBB0000Ef3f1aF24E3a452074", chain: "Ethereum", chainId: 1, type: "fee-auction", source: "reports/cap-triage.md" },
  { role: "USDC Fractional Reserve Vault", symbol: "frUSDC", address: "0x3Ed6aa32c930253fc990dE58fF882B9186cd0072", chain: "Ethereum", chainId: 1, type: "fractional-reserve", source: "reports/cap-triage.md" },
  { role: "wWTGXX Fractional Reserve Vault", symbol: "frwWTGXX", address: "0xb1c1C80FDbBde5B40264e1410550F3C864113bF8", chain: "Ethereum", chainId: 1, type: "fractional-reserve", source: "reports/cap-triage.md" },
  { role: "Debt USDC", symbol: "debtUSDC", address: "0xfa8C6D0b95d9191B5A1D51C868Da2BDFd6C04Ff9", chain: "Ethereum", chainId: 1, type: "debt-token", source: "user-public-context" },
  { role: "CAP token", symbol: "CAP", address: "0x99991c6AAbba5a096f24f250b73580F5179b9999", chain: "Ethereum", chainId: 1, type: "governance-token", source: "user-public-context" },
];

const ASSET_SEEDS = [
  { symbol: "USDC", name: "USD Coin", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, chain: "Ethereum", chainId: 1, source: "reports/cap-triage.md" },
  { symbol: "wWTGXX", name: "wrapped WTGXX", address: "0x434558CB1EBe9950e8A66f1ef8A15A473Dce7D8c", decimals: 18, chain: "Ethereum", chainId: 1, source: "reports/cap-triage.md" },
  { symbol: "cUSD", name: "Cap USD", address: "0xcCcc62962d17b8914c62D74FfB843d73B2a3cccC", decimals: 18, chain: "Ethereum", chainId: 1, source: "user-public-context" },
  { symbol: "stcUSD", name: "Staked Cap USD", address: "0x88887bE419578051FF9F4eb6C858A951921D8888", decimals: 18, chain: "Ethereum", chainId: 1, source: "user-public-context" },
  { symbol: "CAP", name: "CAP", address: "0x99991c6AAbba5a096f24f250b73580F5179b9999", decimals: 18, chain: "Ethereum", chainId: 1, source: "user-public-context" },
];

const ADDRESSES = {
  cUSD: CONTRACT_SEEDS[0].address,
  stcUSD: CONTRACT_SEEDS[1].address,
  oracle: CONTRACT_SEEDS[2].address,
  lender: CONTRACT_SEEDS[3].address,
  usdc: ASSET_SEEDS[0].address,
  wwtgxx: ASSET_SEEDS[1].address,
  cap: CONTRACT_SEEDS[10].address,
  frUsdc: CONTRACT_SEEDS[7].address,
  frWwtgxx: CONTRACT_SEEDS[8].address,
};

const EXACT_TEXT_TERMS = [
  "cap protocol",
  "cap labs",
  "cap-contracts",
  "cap-money/index.js",
  "cap.app",
  "docs.cap.app",
  "cUSD",
  "stcUSD",
  "wWTGXX",
  "Debt USDC",
  "FractionalReserve",
  "fractional reserve",
  "PriceOracle",
  "VaultAdapter",
  "getPrice(address)",
  "getMintAmount",
  "getBurnAmount",
  "getRedeemAmount",
  "maxLiquidatable",
  "openLiquidation",
  "closeLiquidation",
  "realizeInterest",
  "OFT: cUSD",
  "OFT: stcUSD",
];

const ADDRESS_TERMS = Array.from(new Set([
  ...CONTRACT_SEEDS.map((row) => normalizeAddress(row.address)),
  ...CONTRACT_SEEDS.map((row) => normalizeAddress(row.implementation)),
  ...ASSET_SEEDS.map((row) => normalizeAddress(row.address)),
].filter(Boolean)));

const CONTEXT_TERMS = [
  "lending-oracle-liquidation",
  "collateral token",
  "oracle",
  "liquidation",
  "liquidate",
  "borrow",
  "repay",
  "delegation",
  "underwriter",
  "agent",
  "coverage",
  "slash",
  "health",
  "ltv",
  "target health",
  "grace",
  "expiry",
  "bonus cap",
  "emergency liquidation",
  "vault",
  "mint",
  "burn",
  "redeem",
  "deposit cap",
  "paused",
  "available balance",
  "supplied",
  "borrowed",
  "fixed $1",
  "redstone",
  "chainlink",
  "staleness",
  "erc4626",
  "maxDeposit",
  "maxWithdraw",
  "OFT",
  "LayerZero",
  "DVN",
  "peer",
  "swap",
  "DEX",
  "stable exit",
  "routePositive",
  "executableNow",
];

const CATEGORY_RULES = {
  consumer: ["consumer", "accepted", "collateral", "borrow", "lending", "market", "agent", "underwriter", "coverage", "ltv", "cap", "cash"],
  oracle: ["oracle", "price", "feed", "redstone", "chainlink", "staleness", "fixed $1", "adapter", "getprice", "fallback"],
  vault: ["vault", "mint", "burn", "redeem", "deposit cap", "available balance", "supplied", "borrowed", "fee", "cUSD", "stcUSD", "basket"],
  liquidation: ["liquidate", "liquidation", "maxliquidatable", "grace", "expiry", "bonus", "health", "slash", "emergency"],
  fractionalReserve: ["fractional reserve", "erc4626", "maxdeposit", "maxwithdraw", "realizeinterest", "reserve", "donation", "share"],
  dex: ["dex", "swap", "pool", "uniswap", "curve", "liquidity", "slippage", "exit"],
  bridgeOft: ["oft", "layerzero", "dvn", "peer", "megaeth", "tempo", "katana", "monad", "bridge", "custody"],
  access: ["admin", "access", "checkaccess", "owner", "governance", "role", "permission", "pause", "whitelist", "setter"],
  economics: ["profit", "positive", "routepositive", "executable", "fee", "bps", "spread", "tvl", "available", "cash", "borrowed", "supply"],
};

const SOURCE_HINTS = [
  { file: "targets/cap-contracts/contracts/lendingPool/Lender.sol", start: 55, end: 107, label: "public lender borrow/repay/interest/liquidation actions", categories: ["consumer", "liquidation"] },
  { file: "targets/cap-contracts/contracts/lendingPool/Lender.sol", start: 161, end: 203, label: "lender read methods for agent/maxBorrowable/maxLiquidatable/bonus/debt/maxRealization", categories: ["consumer", "liquidation"] },
  { file: "targets/cap-contracts/contracts/lendingPool/libraries/LiquidationLogic.sol", start: 60, end: 105, label: "liquidation flow health/grace/expiry/oracle bonus/slash", categories: ["liquidation", "oracle"] },
  { file: "targets/cap-contracts/contracts/lendingPool/libraries/ViewLogic.sol", start: 29, end: 65, label: "maxBorrowable health/delegation/oracle/vault available balance", categories: ["consumer", "oracle", "vault"] },
  { file: "targets/cap-contracts/contracts/lendingPool/libraries/ViewLogic.sol", start: 72, end: 97, label: "maxLiquidatable health/min-borrow cap", categories: ["liquidation", "consumer"] },
  { file: "targets/cap-contracts/contracts/lendingPool/libraries/ValidationLogic.sol", start: 59, end: 68, label: "borrow validation pause/minBorrow/maxBorrowable", categories: ["consumer", "access"] },
  { file: "targets/cap-contracts/contracts/lendingPool/libraries/ValidationLogic.sol", start: 75, end: 96, label: "liquidation window validation grace/expiry/emergency", categories: ["liquidation"] },
  { file: "targets/cap-contracts/contracts/oracle/PriceOracle.sol", start: 14, end: 35, label: "admin-gated oracle adapter/staleness setters", categories: ["oracle", "access"] },
  { file: "targets/cap-contracts/contracts/oracle/PriceOracle.sol", start: 38, end: 49, label: "oracle getPrice primary/backup fallback stale-zero behavior", categories: ["oracle"] },
  { file: "targets/cap-contracts/contracts/vault/Minter.sol", start: 23, end: 56, label: "admin-gated fee/redeem/whitelist/deposit cap setters", categories: ["vault", "access"] },
  { file: "targets/cap-contracts/contracts/vault/Minter.sol", start: 59, end: 129, label: "mint/burn/redeem quote methods and whitelist/depositCap reads", categories: ["vault", "economics"] },
  { file: "targets/cap-contracts/contracts/vault/Vault.sol", start: 35, end: 115, label: "public vault mint/burn/redeem flows", categories: ["vault", "economics"] },
  { file: "targets/cap-contracts/contracts/vault/Vault.sol", start: 118, end: 153, label: "vault borrow and pause controls are checkAccess-gated", categories: ["vault", "access"] },
  { file: "targets/cap-contracts/contracts/vault/Vault.sol", start: 173, end: 194, label: "vault assets/totalSupplies/borrows/paused/availableBalance reads", categories: ["vault", "consumer"] },
  { file: "targets/cap-contracts/contracts/vault/FractionalReserve.sol", start: 19, end: 45, label: "fractional reserve admin controls and public realizeInterest", categories: ["fractionalReserve", "access"] },
  { file: "targets/cap-contracts/contracts/vault/FractionalReserve.sol", start: 49, end: 65, label: "fractional reserve vault/reserve read methods", categories: ["fractionalReserve", "vault"] },
  { file: "targets/cap-contracts/contracts/oracle/libraries/VaultAdapter.sol", start: 27, end: 49, label: "stateful VaultAdapter rate reads utilization data", categories: ["oracle", "vault"] },
  { file: "targets/cap-contracts/contracts/oracle/libraries/VaultAdapter.sol", start: 80, end: 88, label: "VaultAdapter setLimits checkAccess residual", categories: ["oracle", "access"] },
  { file: "targets/cap-contracts/script/manage/CapAddPriceOracle.s.sol", start: 24, end: 49, label: "config clues for USDC asset/feed/staleness/oracle adapters", categories: ["oracle", "consumer"] },
];

const TRIAGE_SECTIONS = [
  { file: TRIAGE_FILE, start: 11, end: 11, section: "prior-clean-result" },
  { file: TRIAGE_FILE, start: 15, end: 22, section: "live-deployment-table" },
  { file: TRIAGE_FILE, start: 24, end: 39, section: "vault-assets-and-prices" },
  { file: TRIAGE_FILE, start: 41, end: 51, section: "mint-burn-redeem-quotes" },
  { file: TRIAGE_FILE, start: 53, end: 60, section: "fractional-reserve" },
  { file: TRIAGE_FILE, start: 62, end: 73, section: "lender-and-liquidation-state" },
  { file: TRIAGE_FILE, start: 75, end: 85, section: "ruled-out-candidates" },
  { file: PROTOCOL_TRIAGE_FILE, start: 9, end: 9, section: "protocol-prior-clean-result" },
  { file: PROTOCOL_TRIAGE_FILE, start: 23, end: 32, section: "permissionless-and-admin-surfaces" },
  { file: PROTOCOL_TRIAGE_FILE, start: 36, end: 46, section: "protocol-candidate-residuals" },
];

const ERC20_PROBES = [
  { group: "erc20", name: "name", signature: "name()", selector: "0x06fdde03", decode: "string" },
  { group: "erc20", name: "symbol", signature: "symbol()", selector: "0x95d89b41", decode: "string" },
  { group: "erc20", name: "decimals", signature: "decimals()", selector: "0x313ce567", decode: "uint" },
  { group: "erc20", name: "totalSupply", signature: "totalSupply()", selector: "0x18160ddd", decode: "uint" },
];

const SELECTORS = {
  getPrice: { signature: "getPrice(address)", selector: "0x41976e09" },
  reservesCount: { signature: "reservesCount()", selector: "0x54b768bb" },
  grace: { signature: "grace()", selector: "0x1eefddb1" },
  expiry: { signature: "expiry()", selector: "0xe184c9be" },
  targetHealth: { signature: "targetHealth()", selector: "0x440364df" },
  bonusCap: { signature: "bonusCap()", selector: "0xe325fb4b" },
  emergencyLiquidationThreshold: { signature: "emergencyLiquidationThreshold()", selector: "0xa555d689" },
  reservesData: { signature: "reservesData(address)", selector: "0x08cf6fec" },
  getMintAmount: { signature: "getMintAmount(address,uint256)", selector: "0x195d0e28" },
  getBurnAmount: { signature: "getBurnAmount(address,uint256)", selector: "0xb7c4a6bf" },
  getRedeemAmount: { signature: "getRedeemAmount(uint256)", selector: "0x2c3ee88c" },
  getRedeemFee: { signature: "getRedeemFee()", selector: "0xc6d98f1a" },
  depositCap: { signature: "depositCap(address)", selector: "0x20b71534" },
  totalSupplies: { signature: "totalSupplies(address)", selector: "0x9782e821" },
  totalBorrows: { signature: "totalBorrows(address)", selector: "0x8d730124" },
  paused: { signature: "paused(address)", selector: "0x2e48152c" },
  availableBalance: { signature: "availableBalance(address)", selector: "0xa0821be3" },
  assets: { signature: "assets()", selector: "0x71a97305" },
  maxDeposit: { signature: "maxDeposit(address)", selector: "0x402d267d" },
  maxWithdraw: { signature: "maxWithdraw(address)", selector: "0xce96cb77" },
  totalAssets: { signature: "totalAssets()", selector: "0x01e1d114" },
  asset: { signature: "asset()", selector: "0x38d52e0f" },
};

function log(...args) {
  if (!QUIET) console.log(...args);
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function writeJson(filePath, value) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, jsonReplacer, 2)}\n`, "utf8");
}

function rel(filePath) {
  return path.relative(WORKSPACE, filePath).replace(/\\/g, "/");
}

function safeText(value, max = 260) {
  const text = String(value ?? "")
    .replace(/[\r\n|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, max) : null;
}

function sanitizeText(value, max = 320) {
  let text = safeText(value, max);
  if (text === null) return null;
  text = text
    .replace(/\bhttps?:\/\/[^\s"'`<>|)]+/gi, "[redacted-url]")
    .replace(/\bwww\.[^\s"'`<>|)]+/gi, "[redacted-url]")
    .replace(/\b(?:[a-z0-9-]+\.)+(?:com|app|org|io|net|finance|xyz|pro|money|fun|ag|dev|co|fi)\b/gi, "[redacted-domain]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/= -]+/gi, "Bearer [redacted]")
    .replace(/\b(authorization|api[-_]?key|access[-_]?key|private[-_]?key|secret[-_]?key|secret|token|password|pwd)\s*[:=]\s*["']?[^\s"',}\]]{8,}/gi, "$1=[redacted]")
    .replace(/\b0x[0-9a-fA-F]{64}\b/g, "[redacted-hex-key]")
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9._-]{20,}\.[A-Za-z0-9._-]{20,}\b/g, "[redacted-jwt]");
  return text.slice(0, max) || null;
}

function sanitizeError(error, max = 220) {
  return sanitizeText(error?.shortMessage || error?.message || error || "call failed", max);
}

function normalizeAddress(value) {
  const raw = String(value || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) return null;
  return `0x${raw.slice(2).toLowerCase()}`;
}

function displayAddress(value) {
  const norm = normalizeAddress(value);
  if (!norm) return null;
  const seed = [...CONTRACT_SEEDS, ...ASSET_SEEDS].find((row) => normalizeAddress(row.address) === norm || normalizeAddress(row.implementation) === norm);
  return seed?.address && normalizeAddress(seed.address) === norm ? seed.address : norm;
}

function uniqBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    const lower = String(key).toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(item);
  }
  return out;
}

function uniq(items) {
  return uniqBy(items, (item) => item);
}

function asNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSecretLikePath(filePath) {
  const r = rel(filePath).replace(/\\/g, "/").toLowerCase();
  const base = path.basename(filePath).toLowerCase();
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (base === "rpc_endpoints.txt" || base === "graphql_endpoints.txt") return true;
  if (/\.(pem|key|p12|pfx)$/i.test(base)) return true;
  if (/(^|[\/\\])(private|secret|mnemonic|seed|wallet|keypair|api[-_]?key|access[-_]?key)([\/\\._-]|$)/i.test(r)) return true;
  return false;
}

function isExcludedScanPath(filePath) {
  const r = rel(filePath).toLowerCase();
  if ([OUT_JSON_REL.toLowerCase(), OUT_MD_REL.toLowerCase()].includes(r)) return true;
  if (isSecretLikePath(filePath)) return true;
  if (r.includes("/node_modules/") || r.includes("/.git/") || r.includes("/cache/") || r.includes("/out/") || r.includes("/broadcast/")) return true;
  if (r.includes("/artifacts/") || r.includes("/lib/")) return true;
  if (r.startsWith("coordination/claims/") || r.startsWith("coordination/archive/") || r.startsWith("coordination/handoffs/")) return true;
  if (/(?:handoff|shared_context|audit-completion-gates|route-positive-sweep|low-fund-executable-route-filter|exploit-findings-summary)/i.test(r)) return true;
  if (/cap-full-test/i.test(r)) return true;
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

function readJson(filePath, fallback = null) {
  const text = readText(filePath);
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch (_error) {
    return fallback;
  }
}

function lineAt(filePath, lineNo) {
  const text = readText(filePath);
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  return lines[lineNo - 1] || null;
}

function sampleRange(filePath, start, end, max = 520) {
  const text = readText(filePath);
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  const selected = [];
  for (let i = Math.max(1, start); i <= Math.min(lines.length, end); i += 1) {
    const line = String(lines[i - 1] || "").trim();
    if (line) selected.push(`${i}: ${line}`);
  }
  return sanitizeText(selected.join(" "), max);
}

function cleanCell(cell) {
  return sanitizeText(String(cell || "").replace(/`/g, "").trim(), 260);
}

function parseMarkdownTable(filePath, headerNeedle) {
  const text = readText(filePath);
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.toLowerCase().includes(headerNeedle.toLowerCase()));
  if (start < 0) return [];
  const header = lines[start].split("|").map((x) => x.trim()).filter(Boolean);
  const rows = [];
  for (let i = start + 2; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || !line.includes("|")) break;
    if (/^\s*\|?\s*-+/.test(line)) continue;
    const cells = line.split("|").map((x) => x.trim()).filter((x, idx, arr) => !(idx === 0 && x === "") && !(idx === arr.length - 1 && x === ""));
    if (cells.length < 2) break;
    const row = { source: rel(filePath), line: i + 1 };
    for (let j = 0; j < Math.min(header.length, cells.length); j += 1) {
      const key = header[j].toLowerCase().replace(/[^a-z0-9]+(.)/g, (_m, chr) => chr.toUpperCase()).replace(/[^a-z0-9]/gi, "");
      row[key || `col${j}`] = cleanCell(cells[j]);
    }
    row.sample = sanitizeText(line, 420);
    rows.push(row);
  }
  return rows;
}

function lowerContainsAny(haystack, terms) {
  return terms.some((term) => haystack.includes(String(term).toLowerCase()));
}

function findFirstTerm(haystack, terms) {
  for (const term of terms) {
    const needle = String(term || "").toLowerCase();
    if (needle && haystack.includes(needle)) return term;
  }
  return null;
}

function hasCapContext(text, filePath = "") {
  const lower = `${filePath} ${String(text || "")}`.toLowerCase();
  return lower.includes("targets/cap-contracts")
    || lower.includes("cap-triage")
    || lower.includes("cap-protocol-triage")
    || lowerContainsAny(lower, EXACT_TEXT_TERMS)
    || lowerContainsAny(lower, ADDRESS_TERMS);
}

function categoriesFor(text, filePath = "") {
  const hay = `${filePath} ${String(text || "")}`.toLowerCase();
  const categories = [];
  for (const [category, terms] of Object.entries(CATEGORY_RULES)) {
    if (terms.some((term) => hay.includes(term.toLowerCase()))) categories.push(category);
  }
  return categories.length ? categories : ["context"];
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
      const r = rel(full).toLowerCase();
      if (entry.isDirectory()) {
        if (/^(node_modules|\.git|cache|out|broadcast|artifacts|lib)$/i.test(entry.name)) continue;
        if (r.startsWith("coordination/claims/") || r.startsWith("coordination/archive/") || r.startsWith("coordination/handoffs/")) continue;
        if (/(?:handoff|shared_context)$/i.test(entry.name)) continue;
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
  const roots = [
    path.join(WORKSPACE, "reports"),
    path.join(WORKSPACE, "targets", "cap-contracts"),
    path.join(WORKSPACE, "tools"),
  ];
  return uniqBy(roots.flatMap(listFilesRecursive), (file) => path.resolve(file)).sort((a, b) => rel(a).localeCompare(rel(b)));
}

function countOccurrences(text, term) {
  if (!text || !term) return 0;
  let count = 0;
  let cursor = 0;
  const needle = String(term).toLowerCase();
  while (true) {
    const pos = text.indexOf(needle, cursor);
    if (pos < 0) break;
    count += 1;
    cursor = pos + needle.length;
  }
  return count;
}

function scanLocalArtifactLines(files) {
  const rows = [];
  let filesScanned = 0;
  let filesWithMatch = 0;
  let filesWithExact = 0;
  const categoryCounts = {};
  const allTerms = uniq([...EXACT_TEXT_TERMS, ...ADDRESS_TERMS, ...CONTEXT_TERMS]);

  for (const file of files) {
    const text = readText(file);
    if (!text) continue;
    filesScanned += 1;
    const lower = text.toLowerCase();
    if (!lowerContainsAny(lower, allTerms.map((term) => String(term).toLowerCase()))) continue;
    const lines = text.split(/\r?\n/);
    let sampled = 0;
    let fileMatched = false;
    let fileExact = false;
    const seen = new Set();
    for (let i = 0; i < lines.length && rows.length < MAX_LOCAL_MATCH_ROWS && sampled < MAX_ROWS_PER_FILE; i += 1) {
      const line = String(lines[i] || "");
      const lineLower = line.toLowerCase();
      if (!lineLower.trim()) continue;
      const window = [lines[i - 2], lines[i - 1], lines[i], lines[i + 1], lines[i + 2]].map((x) => String(x || "")).join(" ");
      const windowLower = window.toLowerCase();
      const exactAddress = findFirstTerm(lineLower, ADDRESS_TERMS);
      const exactText = findFirstTerm(lineLower, EXACT_TEXT_TERMS);
      const contextTerm = hasCapContext(windowLower, rel(file)) ? findFirstTerm(lineLower, CONTEXT_TERMS) : null;
      if (!exactAddress && !exactText && !contextTerm) continue;
      const matchType = exactAddress ? "exact-address" : exactText ? "exact-name" : "context";
      const term = exactAddress || exactText || contextTerm;
      const key = `${rel(file)}:${i + 1}:${matchType}:${term}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const categories = categoriesFor(windowLower, rel(file));
      for (const category of categories) categoryCounts[category] = (categoryCounts[category] || 0) + 1;
      rows.push({
        file: rel(file),
        line: i + 1,
        matchType,
        termType: exactAddress ? "address" : "text",
        matched: sanitizeText(exactAddress ? displayAddress(exactAddress) || exactAddress : term, 140),
        count: countOccurrences(lineLower, term),
        categories,
        sample: sanitizeText(window, 520),
        classification: matchType === "context" ? "cap-context-watch-only" : "cap-exact-local-watch-only-not-route-positive",
      });
      sampled += 1;
      fileMatched = true;
      if (matchType !== "context") fileExact = true;
    }
    if (fileMatched) filesWithMatch += 1;
    if (fileExact) filesWithExact += 1;
    if (rows.length >= MAX_LOCAL_MATCH_ROWS) break;
  }
  const exactRows = rows.filter((row) => row.matchType === "exact-address" || row.matchType === "exact-name");
  return { filesScanned, filesWithMatch, filesWithExact, rows, exactRows, categoryCounts };
}

function findRowsBySlug(data, slug, max = 8) {
  const out = [];
  const seen = new Set();
  function visit(value, depth = 0) {
    if (out.length >= max || depth > 10 || value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (!isObject(value)) return;
    if (String(value.slug || "").toLowerCase() === slug) {
      const key = JSON.stringify({ slug: value.slug, name: value.name, rank: value.rank, tvlUsd: value.tvlUsd, module: value.module || value.adapter?.module });
      if (!seen.has(key)) {
        seen.add(key);
        out.push(value);
      }
    }
    for (const child of Object.values(value)) visit(child, depth + 1);
  }
  visit(data, 0);
  return out;
}

function sanitizeDiscoveryRow(row, source, sourceKind) {
  if (!row) return null;
  return {
    source,
    sourceKind,
    rank: row.rank ?? null,
    kind: row.kind ?? null,
    slug: row.slug || null,
    name: row.name || null,
    category: row.category || null,
    surface: row.surface || null,
    routeGraph: row.routeGraph || null,
    tvlUsd: asNumber(row.tvlUsd ?? row.tvl) ?? null,
    chains: Array.isArray(row.chains) ? row.chains.map((x) => sanitizeText(x, 80)).filter(Boolean) : [],
    primaryChain: sanitizeText(row.primaryChain || null, 80),
    accessibleEvmChains: Array.isArray(row.accessibleEvmChains) ? row.accessibleEvmChains.map((x) => sanitizeText(x, 80)).filter(Boolean) : Array.isArray(row.evmChains) ? row.evmChains.map((x) => sanitizeText(x, 80)).filter(Boolean) : [],
    accessibleNonEvmChains: Array.isArray(row.accessibleNonEvmChains) ? row.accessibleNonEvmChains.map((x) => sanitizeText(x, 80)).filter(Boolean) : [],
    blockedOrCaveatChains: Array.isArray(row.blockedOrCaveatChains) ? row.blockedOrCaveatChains.map((x) => sanitizeText(x, 80)).filter(Boolean) : [],
    firstReadOnlyChecks: Array.isArray(row.firstReadOnlyChecks) ? row.firstReadOnlyChecks.map((x) => sanitizeText(x, 160)).filter(Boolean) : [],
    module: sanitizeText(row.adapter?.module || row.module || null, 120),
    adapterFetched: row.adapter?.adapterFetched ?? null,
    adapterAddressCount: asNumber(row.adapter?.adapterAddressCount) ?? null,
    adapterHints: Array.isArray(row.adapter?.adapterHints) ? row.adapter.adapterHints.map((x) => sanitizeText(x, 120)).filter(Boolean) : [],
    routePositive: asNumber(row.routePositive) ?? 0,
    executableNow: asNumber(row.executableNow) ?? 0,
    signedActionJustified: Boolean(row.signedActionJustified),
    forkJustified: Boolean(row.forkJustified),
  };
}

function loadSourceFacts() {
  const facts = [];
  const deep = readJson(DEEP_DISCOVERY_FILE, null);
  for (const row of findRowsBySlug(deep, TARGET.slug, 6)) {
    const sanitized = sanitizeDiscoveryRow(row, rel(DEEP_DISCOVERY_FILE), "local-prefilter-deep-discovery");
    if (sanitized) facts.push(sanitized);
  }
  facts.push(
    {
      source: "user-public-context",
      sourceKind: "official-docs-and-repo",
      fact: "Official public context identifies Cap documentation/site and the cap-labs-dev/cap-contracts repository; raw domains are intentionally not persisted.",
      classification: "public-context-sanitized",
    },
    {
      source: "user-public-context",
      sourceKind: "ethereum-contract-seeds",
      fact: "Ethereum cUSD/Vault, stcUSD, Oracle, Lender, AccessControl, Delegation, Fee Auction, fractional reserve, debt token, and CAP token addresses were supplied as read-only seeds.",
      contractSeedRows: CONTRACT_SEEDS.length,
      classification: "seed-addresses-only",
    },
    {
      source: "user-public-context",
      sourceKind: "core-surfaces",
      fact: "Core surfaces are stablecoin mint/burn/redeem, lender/liquidation, delegation/underwriters, oracle getPrice(address), fractional reserve vaults, and OFT/cross-chain context.",
      classification: "route-first-watch-context",
    }
  );
  return uniqBy(facts, (row) => `${row.source}:${row.sourceKind}:${row.slug || row.fact}`);
}

function extractSourceRows() {
  return SOURCE_HINTS.map((hint) => {
    const filePath = path.join(WORKSPACE, hint.file);
    return {
      file: hint.file,
      startLine: hint.start,
      endLine: hint.end,
      label: hint.label,
      categories: hint.categories,
      sample: sampleRange(filePath, hint.start, hint.end, 680),
      exists: fs.existsSync(filePath),
      classification: "local-source-evidence-watch-only",
    };
  });
}

function extractPriorTriageRows() {
  return TRIAGE_SECTIONS.map((section) => ({
    source: rel(section.file),
    startLine: section.start,
    endLine: section.end,
    section: section.section,
    sample: sampleRange(section.file, section.start, section.end, 720),
    classification: "prior-triage-evidence-no-route-positive",
  })).filter((row) => row.sample);
}

function loadDeploymentRows() {
  const tableRows = parseMarkdownTable(TRIAGE_FILE, "| Component | Address | Implementation |").map((row) => ({
    component: row.component,
    address: displayAddress(row.address) || row.address,
    implementation: displayAddress(row.implementation) || row.implementation,
    source: row.source,
    line: row.line,
    classification: "prior-live-deployment-table",
  }));
  const seeded = CONTRACT_SEEDS.map((row) => ({
    component: row.role,
    symbol: row.symbol || null,
    address: row.address,
    implementation: row.implementation || null,
    chain: row.chain,
    chainId: row.chainId,
    type: row.type,
    source: row.source,
    classification: "ethereum-contract-seed",
  }));
  return uniqBy([...tableRows, ...seeded], (row) => `${row.component}:${normalizeAddress(row.address)}`);
}

function loadAssetRows() {
  const vaultRows = parseMarkdownTable(TRIAGE_FILE, "| Asset | Symbol | Supplied | Borrowed | Available | Deposit Cap | Paused | Oracle |").map((row) => ({
    asset: displayAddress(row.asset) || row.asset,
    symbol: row.symbol,
    supplied: row.supplied,
    borrowed: row.borrowed,
    available: row.available,
    depositCap: row.depositCap,
    paused: row.paused,
    oracle: row.oracle,
    source: row.source,
    line: row.line,
    classification: "prior-live-vault-asset-state",
  }));
  const valueRows = [33, 34, 35, 36, 37, 38, 39].map((line) => ({
    kind: "additional-live-value",
    source: rel(TRIAGE_FILE),
    line,
    sample: sanitizeText(lineAt(TRIAGE_FILE, line), 360),
    classification: "prior-live-asset-or-fee-value",
  })).filter((row) => row.sample);
  return [...vaultRows, ...valueRows];
}

function loadVaultQuoteRows() {
  return parseMarkdownTable(TRIAGE_FILE, "| Action | Input | Output | Fee | Verdict |").map((row) => ({
    action: row.action,
    input: row.input,
    output: row.output,
    fee: row.fee,
    verdict: row.verdict,
    source: row.source,
    line: row.line,
    classification: "prior-live-vault-quote-value-negative-or-pro-rata",
  }));
}

function loadFractionalReserveRows() {
  const rows = parseMarkdownTable(TRIAGE_FILE, "| Asset | Fractional Reserve Vault | Public Deposit | Public Withdraw | Vault-held Value |").map((row) => ({
    asset: row.asset,
    fractionalReserveVault: displayAddress(row.fractionalReserveVault) || row.fractionalReserveVault,
    publicDeposit: row.publicDeposit,
    publicWithdraw: row.publicWithdraw,
    vaultHeldValue: row.vaultHeldValue,
    source: row.source,
    line: row.line,
    classification: "prior-live-fr-vault-gated-public-entry",
  }));
  const caveatLine = sanitizeText(lineAt(TRIAGE_FILE, 60), 420);
  if (caveatLine) {
    rows.push({
      asset: "all",
      source: rel(TRIAGE_FILE),
      line: 60,
      note: caveatLine,
      classification: "prior-fr-share-entry-blocker",
    });
  }
  return rows;
}

function loadLenderParameterRows() {
  const out = [];
  for (let line = 65; line <= 71; line += 1) {
    const raw = lineAt(TRIAGE_FILE, line);
    if (!raw) continue;
    const m = raw.match(/-\s*([^:]+):\s*`?([^`]+)`?/);
    out.push({
      parameter: sanitizeText(m?.[1] || raw, 120),
      value: sanitizeText(m?.[2] || raw, 160),
      source: rel(TRIAGE_FILE),
      line,
      classification: "prior-live-lender-parameter",
    });
  }
  return out;
}

function loadAgentLiquidationRows() {
  const rows = [];
  for (const [filePath, lines] of [[TRIAGE_FILE, [73]], [PROTOCOL_TRIAGE_FILE, [38, 57, 60]]]) {
    for (const line of lines) {
      const sample = sanitizeText(lineAt(filePath, line), 460);
      if (!sample) continue;
      rows.push({
        source: rel(filePath),
        line,
        sample,
        classification: /maxLiquidatable\(USDC\)=0|requires unhealthy|becomes liquidatable/i.test(sample)
          ? "prior-agent-liquidation-dormant"
          : "prior-liquidation-revisit-context",
      });
    }
  }
  return rows;
}

function loadOracleRows() {
  const rows = [];
  for (const line of [35, 36, 37, 82, 95, 97]) {
    const sample = sanitizeText(lineAt(TRIAGE_FILE, line), 460);
    if (!sample) continue;
    rows.push({ source: rel(TRIAGE_FILE), line, sample, classification: "prior-oracle-or-pricing-evidence" });
  }
  rows.push({
    source: "targets/cap-contracts/script/manage/CapAddPriceOracle.s.sol",
    line: 24,
    asset: ADDRESSES.usdc,
    clue: "USDC asset and Chainlink feed/staleness config clues are present in local manage script; raw endpoint/domain data is not persisted.",
    classification: "local-oracle-config-clue",
  });
  return rows;
}

function loadPermissionlessEntrypointRows() {
  return [
    { module: "Vault", signature: "mint(address,uint256,uint256,address,uint256)", file: "targets/cap-contracts/contracts/vault/Vault.sol", line: 35, gating: "whenNotPaused; deposit cap and quote/minOut checks", classification: "permissionless-public-but-economics-negative-prior" },
    { module: "Vault", signature: "burn(address,uint256,uint256,address,uint256)", file: "targets/cap-contracts/contracts/vault/Vault.sol", line: 61, gating: "whenNotPaused; burns caller cUSD and divests asset", classification: "permissionless-public-but-no-positive-cycle-prior" },
    { module: "Vault", signature: "redeem(uint256,uint256[],address,uint256)", file: "targets/cap-contracts/contracts/vault/Vault.sol", line: 88, gating: "whenNotPaused; pro-rata basket output", classification: "permissionless-public-pro-rata-not-route-positive" },
    { module: "Lender", signature: "borrow(address,uint256,address)", file: "targets/cap-contracts/contracts/lendingPool/Lender.sol", line: 55, gating: "public caller as agent; borrow validation/capacity required", classification: "public-covered-agent-constrained" },
    { module: "Lender", signature: "repay(address,uint256,address)", file: "targets/cap-contracts/contracts/lendingPool/Lender.sol", line: 69, gating: "public repay on behalf of agent; no direct extraction", classification: "permissionless-helper-no-direct-profit" },
    { module: "Lender", signature: "realizeInterest(address)", file: "targets/cap-contracts/contracts/lendingPool/Lender.sol", line: 77, gating: "public realization; proceeds routed by protocol", classification: "permissionless-accounting-no-caller-drain-prior" },
    { module: "Lender", signature: "openLiquidation(address)", file: "targets/cap-contracts/contracts/lendingPool/Lender.sol", line: 87, gating: "requires health < 1 and no active window", classification: "permissionless-dormant-with-healthy-agents-prior" },
    { module: "Lender", signature: "closeLiquidation(address)", file: "targets/cap-contracts/contracts/lendingPool/Lender.sol", line: 92, gating: "requires healthy agent", classification: "permissionless-window-management" },
    { module: "Lender", signature: "liquidate(address,address,uint256,uint256)", file: "targets/cap-contracts/contracts/lendingPool/Lender.sol", line: 97, gating: "requires unhealthy/opened/grace-or-emergency and positive maxLiquidatable", classification: "permissionless-dormant-maxLiquidatable-zero-prior" },
    { module: "FractionalReserve", signature: "realizeInterest(address)", file: "targets/cap-contracts/contracts/vault/FractionalReserve.sol", line: 44, gating: "public accounting; FR vault entry is gated in prior live checks", classification: "permissionless-accounting-no-direct-profit-prior" },
  ];
}

function loadAdminGatedRows() {
  return [
    { module: "PriceOracle", signatures: ["setPriceOracleData", "setPriceBackupOracleData", "setStaleness"], file: "targets/cap-contracts/contracts/oracle/PriceOracle.sol", line: 14, gating: "checkAccess", classification: "admin-gated-oracle-mutation" },
    { module: "Minter", signatures: ["setFeeData", "setRedeemFee", "setWhitelist", "setDepositCap"], file: "targets/cap-contracts/contracts/vault/Minter.sol", line: 23, gating: "checkAccess", classification: "admin-gated-vault-economics" },
    { module: "Vault", signatures: ["borrow", "repay", "addAsset", "removeAsset", "pauseAsset", "pauseProtocol", "rescueERC20"], file: "targets/cap-contracts/contracts/vault/Vault.sol", line: 118, gating: "checkAccess", classification: "admin-gated-vault-controls" },
    { module: "FractionalReserve", signatures: ["investAll", "divestAll", "setFractionalReserveVault", "setReserve"], file: "targets/cap-contracts/contracts/vault/FractionalReserve.sol", line: 19, gating: "checkAccess", classification: "admin-gated-fr-controls" },
    { module: "Lender", signatures: ["addAsset", "removeAsset", "pauseAsset", "setInterestReceiver", "setMinBorrow", "setGrace", "setExpiry", "setBonusCap"], file: "targets/cap-contracts/contracts/lendingPool/Lender.sol", line: 110, gating: "checkAccess", classification: "admin-gated-lender-controls" },
    { module: "VaultAdapter", signatures: ["setSlopes", "setLimits"], file: "targets/cap-contracts/contracts/oracle/libraries/VaultAdapter.sol", line: 73, gating: "checkAccess", classification: "admin-gated-oracle-adapter-controls" },
  ];
}

function parseOftContextRows() {
  const text = readText(OFT_REPORT_FILE);
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const rows = [];
  let currentOft = null;
  let currentRoute = null;
  function flushRoute(lineNo) {
    if (!currentRoute) return;
    rows.push({
      source: rel(OFT_REPORT_FILE),
      line: currentRoute.line || lineNo,
      oft: currentOft?.symbol || null,
      oftAddress: currentOft?.address || null,
      destination: currentRoute.destination,
      eid: currentRoute.eid,
      sendConfirmations: currentRoute.sendConfirmations ?? null,
      recvConfirmations: currentRoute.recvConfirmations ?? null,
      requiredDvnsSend: currentRoute.requiredDvnsSend ?? null,
      requiredDvnsRecv: currentRoute.requiredDvnsRecv ?? null,
      maxMsgSize: currentRoute.maxMsgSize ?? null,
      peerStatus: currentRoute.peerStatus ?? null,
      peerAddress: currentRoute.peerAddress ?? null,
      classification: "oft-cross-chain-context-caveat-not-route-positive",
    });
    currentRoute = null;
  }
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const oft = line.match(/OFT:\s*(\S+)\s+addr:\s*(0x[0-9a-fA-F]{40})/);
    if (oft) {
      flushRoute(i + 1);
      currentOft = { symbol: oft[1], address: displayAddress(oft[2]) || oft[2], line: i + 1 };
      rows.push({ source: rel(OFT_REPORT_FILE), line: i + 1, oft: currentOft.symbol, oftAddress: currentOft.address, classification: "oft-token-context-caveat" });
      continue;
    }
    const dest = line.match(/->\s*([^()]+)\s*\(eid:\s*(\d+)\)/);
    if (dest) {
      flushRoute(i + 1);
      currentRoute = { destination: sanitizeText(dest[1], 80), eid: Number(dest[2]), line: i + 1 };
      continue;
    }
    if (!currentRoute) continue;
    const maxMsg = line.match(/MaxMsgSize\s*:\s*(\d+)/);
    if (maxMsg) currentRoute.maxMsgSize = Number(maxMsg[1]);
    const sendConf = line.match(/\[SEND\]\s*Confirmations\s*:\s*(\d+)/);
    if (sendConf) currentRoute.sendConfirmations = Number(sendConf[1]);
    const recvConf = line.match(/\[RECV\]\s*Confirmations\s*:\s*(\d+)/);
    if (recvConf) currentRoute.recvConfirmations = Number(recvConf[1]);
    const sendDvn = line.match(/\[SEND\]\s*RequiredDVNs\s*:\s*(\d+)/);
    if (sendDvn) currentRoute.requiredDvnsSend = Number(sendDvn[1]);
    const recvDvn = line.match(/\[RECV\]\s*RequiredDVNs\s*:\s*(\d+)/);
    if (recvDvn) currentRoute.requiredDvnsRecv = Number(recvDvn[1]);
    const peer = line.match(/Peer\s*:\s*(NOT SET|0x[0-9a-fA-F]{40}|0x[0-9a-fA-F.]+\s*\([^)]*\))/);
    if (peer) {
      currentRoute.peerStatus = /not set/i.test(peer[1]) ? "not-set" : "set";
      const addr = peer[1].match(/0x[0-9a-fA-F]{40}/);
      currentRoute.peerAddress = addr ? displayAddress(addr[0]) || addr[0] : null;
      flushRoute(i + 1);
    }
  }
  flushRoute(lines.length);
  return rows.slice(0, 80);
}

function hexPayload(raw) {
  return String(raw || "").replace(/^0x/, "").toLowerCase();
}

function wordAt(rawOrHex, index) {
  const h = hexPayload(rawOrHex);
  const start = index * 64;
  if (start + 64 > h.length) return null;
  return h.slice(start, start + 64);
}

function wordAtByteOffset(rawOrHex, byteOffset) {
  const h = hexPayload(rawOrHex);
  const start = Number(byteOffset) * 2;
  if (!Number.isFinite(start) || start < 0 || start + 64 > h.length) return null;
  return h.slice(start, start + 64);
}

function toBigIntFromHex(raw) {
  const clean = String(raw || "").replace(/^0x/, "");
  if (!clean) return null;
  try {
    return BigInt(`0x${clean}`);
  } catch (_error) {
    return null;
  }
}

function decodeUint(raw, index = 0) {
  const word = wordAt(raw, index);
  if (!word) return null;
  const v = toBigIntFromHex(word);
  return v === null ? null : v.toString();
}

function decodeBool(raw, index = 0) {
  const v = decodeUint(raw, index);
  if (v === null) return null;
  return v !== "0";
}

function decodeAddress(raw, index = 0) {
  const word = wordAt(raw, index);
  if (!word) return null;
  return displayAddress(`0x${word.slice(24)}`) || `0x${word.slice(24)}`;
}

function encodeAddress(value) {
  const address = normalizeAddress(value);
  if (!address) return null;
  return address.slice(2).padStart(64, "0");
}

function encodeUint(value) {
  try {
    return BigInt(value).toString(16).padStart(64, "0");
  } catch (_error) {
    return null;
  }
}

function makeCallData(selector, args = []) {
  const encoded = args.join("");
  if (args.some((arg) => !arg)) return null;
  return `${selector}${encoded}`;
}

function decodeAbiString(raw) {
  if (!raw || raw === "0x") return null;
  const h = hexPayload(raw);
  if (!h) return null;
  if (h.length === 64) {
    try {
      return Buffer.from(h, "hex").toString("utf8").replace(/\u0000+$/g, "").trim() || null;
    } catch (_error) {
      return null;
    }
  }
  try {
    const offsetWord = wordAt(h, 0);
    if (!offsetWord) return null;
    const offset = Number(BigInt(`0x${offsetWord}`));
    const lengthWord = wordAtByteOffset(h, offset);
    if (!lengthWord) return null;
    const length = Number(BigInt(`0x${lengthWord}`));
    const dataStart = offset * 2 + 64;
    const dataHex = h.slice(dataStart, dataStart + length * 2);
    if (dataHex.length < length * 2) return null;
    return Buffer.from(dataHex, "hex").toString("utf8").trim() || null;
  } catch (_error) {
    return null;
  }
}

function decodeUintArrayAt(raw, offsetBytes, max = 16) {
  const h = hexPayload(raw);
  const lenWord = wordAtByteOffset(h, offsetBytes);
  if (!lenWord) return [];
  const len = Number(toBigIntFromHex(lenWord));
  if (!Number.isFinite(len) || len < 0) return [];
  const out = [];
  for (let i = 0; i < Math.min(len, max); i += 1) {
    const w = wordAtByteOffset(h, Number(offsetBytes) + 32 + i * 32);
    if (!w) break;
    const v = toBigIntFromHex(w);
    out.push(v === null ? null : v.toString());
  }
  return out;
}

function decodeAddressArray(raw, max = 16) {
  const h = hexPayload(raw);
  const offset = toBigIntFromHex(wordAt(h, 0));
  if (offset === null) return [];
  const lenWord = wordAtByteOffset(h, Number(offset));
  if (!lenWord) return [];
  const len = Number(toBigIntFromHex(lenWord));
  if (!Number.isFinite(len) || len < 0) return [];
  const out = [];
  for (let i = 0; i < Math.min(len, max); i += 1) {
    const w = wordAtByteOffset(h, Number(offset) + 32 + i * 32);
    if (!w) break;
    out.push(displayAddress(`0x${w.slice(24)}`) || `0x${w.slice(24)}`);
  }
  return out;
}

function decodeErc20Probe(probe, raw) {
  if (!raw || raw === "0x") return null;
  if (probe.decode === "string") return sanitizeText(decodeAbiString(raw) || raw, 180);
  if (probe.decode === "uint") return decodeUint(raw, 0);
  return sanitizeText(raw, 180);
}

function decodeCallResult(kind, raw) {
  if (!raw || raw === "0x") return null;
  if (kind === "uint") return { valueRaw: decodeUint(raw, 0) };
  if (kind === "bool") return { value: decodeBool(raw, 0) };
  if (kind === "address") return { address: decodeAddress(raw, 0) };
  if (kind === "price") return { priceRaw: decodeUint(raw, 0), lastUpdated: decodeUint(raw, 1) };
  if (kind === "quote") return { amountOutRaw: decodeUint(raw, 0), feeRaw: decodeUint(raw, 1) };
  if (kind === "redeemQuote") {
    const amountOffset = toBigIntFromHex(wordAt(raw, 0));
    const feeOffset = toBigIntFromHex(wordAt(raw, 1));
    return {
      amountsOutRaw: amountOffset === null ? [] : decodeUintArrayAt(raw, Number(amountOffset), 8),
      feesRaw: feeOffset === null ? [] : decodeUintArrayAt(raw, Number(feeOffset), 8),
    };
  }
  if (kind === "addressArray") return { addresses: decodeAddressArray(raw, 16) };
  if (kind === "reservesData") {
    return {
      id: decodeUint(raw, 0),
      vault: decodeAddress(raw, 1),
      debtToken: decodeAddress(raw, 2),
      interestReceiver: decodeAddress(raw, 3),
      decimals: decodeUint(raw, 4),
      paused: decodeBool(raw, 5),
      minBorrow: decodeUint(raw, 6),
    };
  }
  return { raw: sanitizeText(raw, 180) };
}

function rpcCallClassification(resp) {
  if (!resp) return { ok: false, status: "unknown", transportOk: false, rpcError: "no-response" };
  if (resp.ok) return { ok: true, status: "ok", transportOk: true, rpcError: null };
  const rawError = sanitizeText(resp.error || "rpc-error", 180);
  if (!resp.transport) return { ok: false, status: rawError || "transport-error", transportOk: false, rpcError: rawError };
  if (/execution reverted|revert|reverted/i.test(rawError || "")) return { ok: false, status: "reverted", transportOk: true, rpcError: rawError };
  return { ok: false, status: rawError || "rpc-error", transportOk: true, rpcError: rawError };
}

async function rpcPost(url, method, params, timeoutMs = RPC_TIMEOUT_MS) {
  if (!url) return { ok: false, transport: false, error: "no-rpc-url" };
  if (typeof fetch !== "function") return { ok: false, transport: false, error: "fetch-unavailable" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { "content-type": "application/json" };
  try {
    const origin = sharedRpc?.getOrigin ? sharedRpc.getOrigin(url) : null;
    if (origin) headers.origin = origin;
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_error) {
      json = null;
    }
    if (!res.ok) return { ok: false, status: res.status, transport: true, error: `http-${res.status}` };
    if (!json) return { ok: false, status: res.status, transport: true, error: "invalid-json" };
    if (json.error && !("result" in json)) return { ok: false, status: res.status, transport: true, error: sanitizeText(json.error.message || json.error.code || "rpc-error", 180) };
    return { ok: true, status: res.status, transport: true, result: json.result ?? null };
  } catch (error) {
    return { ok: false, status: 0, transport: false, error: error?.name === "AbortError" ? "timeout" : sanitizeError(error, 80) || "network" };
  } finally {
    clearTimeout(timer);
  }
}

async function probeChainState(rpcUrl) {
  const row = {
    chain: "Ethereum",
    chainLabel: "Ethereum",
    chainId: 1,
    rpcResolved: Boolean(rpcUrl),
    rpcSource: rpcUrl ? "shared-rpc-public-fallback" : "none",
    rpcStatus: rpcUrl ? "not-probed" : "unresolved",
    chainIdObserved: null,
    chainIdMatch: null,
    blockNumber: null,
    blockNumberHex: null,
    blockStatus: "not-probed",
    rpcError: null,
    _rpcUrl: rpcUrl || null,
  };
  if (!rpcUrl) return row;
  const chainResp = await rpcPost(rpcUrl, "eth_chainId", [], RPC_TIMEOUT_MS);
  const chainClass = rpcCallClassification(chainResp);
  if (!chainClass.ok) {
    row.rpcStatus = chainClass.status;
    row.rpcError = chainClass.rpcError;
    return row;
  }
  row.rpcStatus = "ready";
  const observed = toBigIntFromHex(chainResp.result);
  if (observed !== null) {
    row.chainIdObserved = Number(observed);
    row.chainIdMatch = row.chainIdObserved === 1;
  }
  const blockResp = await rpcPost(rpcUrl, "eth_blockNumber", [], RPC_TIMEOUT_MS);
  const blockClass = rpcCallClassification(blockResp);
  if (blockClass.ok && blockResp.result) {
    row.blockStatus = "ok";
    row.blockNumberHex = String(blockResp.result);
    const block = toBigIntFromHex(blockResp.result);
    row.blockNumber = block === null ? null : block.toString();
  } else {
    row.blockStatus = blockClass.status;
  }
  return row;
}

function sanitizedChainProbe(row) {
  return {
    chain: row.chain,
    chainLabel: row.chainLabel,
    chainId: row.chainId,
    rpcResolved: row.rpcResolved,
    rpcSource: row.rpcSource,
    rpcStatus: row.rpcStatus,
    chainIdObserved: row.chainIdObserved,
    chainIdMatch: row.chainIdMatch,
    blockNumber: row.blockNumber,
    blockNumberHex: row.blockNumberHex,
    blockStatus: row.blockStatus,
    rpcError: row.rpcError,
  };
}

async function probeCode(chainProbe, target) {
  const row = {
    chain: "Ethereum",
    chainId: 1,
    blockNumber: chainProbe.blockNumber,
    role: target.role,
    symbol: target.symbol || null,
    address: target.address,
    type: target.type || null,
    rpcStatus: chainProbe.rpcStatus,
    codePresent: false,
    codeBytes: null,
    codeStatus: "not-probed",
    classification: "read-only-code-length-probe",
  };
  if (!chainProbe.rpcResolved || chainProbe.rpcStatus !== "ready" || !chainProbe._rpcUrl) {
    row.codeStatus = "no-rpc";
    return row;
  }
  const resp = await rpcPost(chainProbe._rpcUrl, "eth_getCode", [target.address, "latest"], RPC_TIMEOUT_MS);
  const cls = rpcCallClassification(resp);
  if (!cls.ok) {
    row.codeStatus = cls.status;
    row.errorSnippet = sanitizeText(cls.rpcError || cls.status, 160);
    return row;
  }
  const codeHex = resp.result || "0x";
  const codeBytes = Math.max(0, Math.floor(hexPayload(codeHex).length / 2));
  row.codePresent = codeHex !== "0x" && codeBytes > 0;
  row.codeBytes = codeBytes;
  row.codeStatus = row.codePresent ? "present" : "empty";
  return row;
}

async function ethCall(chainProbe, target, probe, data, decodeKind) {
  const row = {
    chain: "Ethereum",
    chainId: 1,
    blockNumber: chainProbe.blockNumber,
    targetRole: target.role || null,
    targetSymbol: target.symbol || null,
    address: target.address,
    group: probe.group || null,
    name: probe.name,
    signature: probe.signature,
    selector: probe.selector,
    success: false,
    status: "not-probed",
    result: null,
    errorSnippet: null,
    classification: "read-only-eth-call-probe",
  };
  if (!data) {
    row.status = "encode-error";
    return row;
  }
  if (!chainProbe.rpcResolved || chainProbe.rpcStatus !== "ready" || !chainProbe._rpcUrl) {
    row.status = "no-rpc";
    return row;
  }
  const resp = await rpcPost(chainProbe._rpcUrl, "eth_call", [{ from: DEAD, to: target.address, data }, "latest"], ETH_CALL_TIMEOUT_MS);
  const cls = rpcCallClassification(resp);
  row.success = cls.ok;
  row.status = cls.status;
  row.errorSnippet = cls.ok ? null : sanitizeText(cls.rpcError || cls.status, 160);
  if (cls.ok) row.result = decodeKind ? decodeCallResult(decodeKind, resp.result) : { raw: sanitizeText(resp.result, 180) };
  return row;
}

async function probeErc20Metadata(chainProbe, tokenSeed) {
  const row = {
    chain: "Ethereum",
    chainId: 1,
    blockNumber: chainProbe.blockNumber,
    symbolExpected: tokenSeed.symbol,
    address: tokenSeed.address,
    expectedDecimals: tokenSeed.decimals ?? null,
    name: null,
    symbol: null,
    decimals: null,
    totalSupplyRaw: null,
    selectorResults: [],
    classification: "erc20-metadata-only-not-route-positive",
  };
  for (const probe of ERC20_PROBES) {
    const callRow = await ethCall(chainProbe, { ...tokenSeed, role: tokenSeed.symbol, type: "erc20" }, probe, probe.selector, null);
    const decoded = callRow.success ? decodeErc20Probe(probe, callRow.result?.raw || null) : null;
    if (callRow.success) {
      const rawResp = await rpcPost(chainProbe._rpcUrl, "eth_call", [{ from: DEAD, to: tokenSeed.address, data: probe.selector }, "latest"], ETH_CALL_TIMEOUT_MS);
      const rawClass = rpcCallClassification(rawResp);
      callRow.success = rawClass.ok && decodeErc20Probe(probe, rawResp.result) !== null;
      callRow.status = rawClass.ok ? "ok" : rawClass.status;
      callRow.result = rawClass.ok ? decodeErc20Probe(probe, rawResp.result) : null;
      callRow.errorSnippet = rawClass.ok ? null : sanitizeText(rawClass.rpcError || rawClass.status, 160);
    } else {
      callRow.result = decoded;
    }
    callRow.classification = "read-only-erc20-metadata-probe";
    row.selectorResults.push(callRow);
    if (callRow.success) {
      if (probe.name === "name") row.name = callRow.result;
      if (probe.name === "symbol") row.symbol = callRow.result;
      if (probe.name === "decimals") row.decimals = Number(callRow.result);
      if (probe.name === "totalSupply") row.totalSupplyRaw = callRow.result;
    }
  }
  return row;
}

async function runLiveProbes() {
  const rpcUrl = sharedRpc?.PUBLIC_FALLBACKS?.[1] || null;
  const rpcInventoryRead = false;
  const rpcInventoryRows = 0;
  const chainProbe = await probeChainState(rpcUrl);
  const codeProbeRows = [];
  const erc20MetadataRows = [];
  const oracleLiveRows = [];
  const lenderLiveRows = [];
  const vaultLiveRows = [];
  const fractionalReserveLiveRows = [];
  const selectorProbeRows = [];

  const codeTargets = uniqBy([
    ...CONTRACT_SEEDS,
    ...ASSET_SEEDS.map((row) => ({ ...row, role: row.symbol, type: "asset-token" })),
  ], (row) => normalizeAddress(row.address));
  for (const target of codeTargets) {
    codeProbeRows.push(await probeCode(chainProbe, target));
  }

  const metadataSeeds = ASSET_SEEDS.filter((row) => ["cUSD", "stcUSD", "USDC", "CAP"].includes(row.symbol));
  for (const token of metadataSeeds) {
    const meta = await probeErc20Metadata(chainProbe, token);
    erc20MetadataRows.push(meta);
    selectorProbeRows.push(...meta.selectorResults);
  }

  const oracleTargets = [
    { symbol: "cUSD", address: ADDRESSES.cUSD },
    { symbol: "stcUSD", address: ADDRESSES.stcUSD },
    { symbol: "USDC", address: ADDRESSES.usdc },
    { symbol: "wWTGXX", address: ADDRESSES.wwtgxx },
  ];
  for (const asset of oracleTargets) {
    const probe = { group: "oracle", name: `getPrice(${asset.symbol})`, ...SELECTORS.getPrice };
    const data = makeCallData(SELECTORS.getPrice.selector, [encodeAddress(asset.address)]);
    const row = await ethCall(chainProbe, { role: "Oracle", address: ADDRESSES.oracle, symbol: null }, probe, data, "price");
    row.assetSymbol = asset.symbol;
    row.asset = asset.address;
    row.classification = row.success ? "read-only-oracle-price-probe-not-route-positive" : "oracle-price-probe-unavailable";
    oracleLiveRows.push(row);
    selectorProbeRows.push(row);
  }

  for (const name of ["reservesCount", "grace", "expiry", "targetHealth", "bonusCap", "emergencyLiquidationThreshold"]) {
    const s = SELECTORS[name];
    const row = await ethCall(chainProbe, { role: "Lender", address: ADDRESSES.lender }, { group: "lender", name, ...s }, s.selector, "uint");
    row.classification = row.success ? "read-only-lender-param-probe" : "lender-param-probe-unavailable";
    lenderLiveRows.push(row);
    selectorProbeRows.push(row);
  }
  const reservesRow = await ethCall(
    chainProbe,
    { role: "Lender", address: ADDRESSES.lender },
    { group: "lender", name: "reservesData(USDC)", ...SELECTORS.reservesData },
    makeCallData(SELECTORS.reservesData.selector, [encodeAddress(ADDRESSES.usdc)]),
    "reservesData"
  );
  reservesRow.asset = ADDRESSES.usdc;
  reservesRow.assetSymbol = "USDC";
  reservesRow.classification = reservesRow.success ? "read-only-lender-reserve-data-probe" : "lender-reserve-data-probe-unavailable";
  lenderLiveRows.push(reservesRow);
  selectorProbeRows.push(reservesRow);

  const assetCallRow = await ethCall(chainProbe, { role: "cUSD/Vault", address: ADDRESSES.cUSD }, { group: "vault", name: "assets", ...SELECTORS.assets }, SELECTORS.assets.selector, "addressArray");
  assetCallRow.classification = assetCallRow.success ? "read-only-vault-assets-probe" : "vault-assets-probe-unavailable";
  vaultLiveRows.push(assetCallRow);
  selectorProbeRows.push(assetCallRow);
  for (const asset of [{ symbol: "USDC", address: ADDRESSES.usdc, amountIn: THOUSAND_USDC }, { symbol: "wWTGXX", address: ADDRESSES.wwtgxx, amountIn: THOUSAND_18 }]) {
    for (const name of ["totalSupplies", "totalBorrows", "availableBalance", "depositCap"]) {
      const s = SELECTORS[name];
      const row = await ethCall(chainProbe, { role: "cUSD/Vault", address: ADDRESSES.cUSD }, { group: "vault", name: `${name}(${asset.symbol})`, ...s }, makeCallData(s.selector, [encodeAddress(asset.address)]), "uint");
      row.assetSymbol = asset.symbol;
      row.asset = asset.address;
      row.classification = row.success ? "read-only-vault-asset-state-probe" : "vault-asset-state-probe-unavailable";
      vaultLiveRows.push(row);
      selectorProbeRows.push(row);
    }
    const pausedRow = await ethCall(chainProbe, { role: "cUSD/Vault", address: ADDRESSES.cUSD }, { group: "vault", name: `paused(${asset.symbol})`, ...SELECTORS.paused }, makeCallData(SELECTORS.paused.selector, [encodeAddress(asset.address)]), "bool");
    pausedRow.assetSymbol = asset.symbol;
    pausedRow.asset = asset.address;
    pausedRow.classification = pausedRow.success ? "read-only-vault-pause-state-probe" : "vault-pause-state-probe-unavailable";
    vaultLiveRows.push(pausedRow);
    selectorProbeRows.push(pausedRow);

    const mintQuote = await ethCall(chainProbe, { role: "cUSD/Vault", address: ADDRESSES.cUSD }, { group: "vaultQuote", name: `getMintAmount(${asset.symbol},1000)`, ...SELECTORS.getMintAmount }, makeCallData(SELECTORS.getMintAmount.selector, [encodeAddress(asset.address), encodeUint(asset.amountIn)]), "quote");
    mintQuote.assetSymbol = asset.symbol;
    mintQuote.asset = asset.address;
    mintQuote.classification = mintQuote.success ? "read-only-mint-quote-probe-not-economics-positive" : "mint-quote-probe-unavailable";
    vaultLiveRows.push(mintQuote);
    selectorProbeRows.push(mintQuote);

    const burnQuote = await ethCall(chainProbe, { role: "cUSD/Vault", address: ADDRESSES.cUSD }, { group: "vaultQuote", name: `getBurnAmount(${asset.symbol},1000 cUSD)`, ...SELECTORS.getBurnAmount }, makeCallData(SELECTORS.getBurnAmount.selector, [encodeAddress(asset.address), encodeUint(THOUSAND_18)]), "quote");
    burnQuote.assetSymbol = asset.symbol;
    burnQuote.asset = asset.address;
    burnQuote.classification = burnQuote.success ? "read-only-burn-quote-probe-not-economics-positive" : "burn-quote-probe-unavailable";
    vaultLiveRows.push(burnQuote);
    selectorProbeRows.push(burnQuote);
  }
  const redeemFeeRow = await ethCall(chainProbe, { role: "cUSD/Vault", address: ADDRESSES.cUSD }, { group: "vaultQuote", name: "getRedeemFee", ...SELECTORS.getRedeemFee }, SELECTORS.getRedeemFee.selector, "uint");
  redeemFeeRow.classification = redeemFeeRow.success ? "read-only-redeem-fee-probe" : "redeem-fee-probe-unavailable";
  vaultLiveRows.push(redeemFeeRow);
  selectorProbeRows.push(redeemFeeRow);
  const redeemQuoteRow = await ethCall(chainProbe, { role: "cUSD/Vault", address: ADDRESSES.cUSD }, { group: "vaultQuote", name: "getRedeemAmount(1000 cUSD)", ...SELECTORS.getRedeemAmount }, makeCallData(SELECTORS.getRedeemAmount.selector, [encodeUint(THOUSAND_18)]), "redeemQuote");
  redeemQuoteRow.classification = redeemQuoteRow.success ? "read-only-redeem-quote-probe-pro-rata-not-positive" : "redeem-quote-probe-unavailable";
  vaultLiveRows.push(redeemQuoteRow);
  selectorProbeRows.push(redeemQuoteRow);

  for (const fr of [{ symbol: "USDC", address: ADDRESSES.frUsdc }, { symbol: "wWTGXX", address: ADDRESSES.frWwtgxx }]) {
    for (const probeDef of [
      { name: "maxDeposit(random)", selectorDef: SELECTORS.maxDeposit, kind: "uint", args: [encodeAddress(DEAD)] },
      { name: "maxWithdraw(random)", selectorDef: SELECTORS.maxWithdraw, kind: "uint", args: [encodeAddress(DEAD)] },
      { name: "totalAssets", selectorDef: SELECTORS.totalAssets, kind: "uint", args: [] },
      { name: "asset", selectorDef: SELECTORS.asset, kind: "address", args: [] },
    ]) {
      const s = probeDef.selectorDef;
      const row = await ethCall(chainProbe, { role: `${fr.symbol} Fractional Reserve Vault`, address: fr.address }, { group: "fractionalReserve", name: probeDef.name, ...s }, makeCallData(s.selector, probeDef.args), probeDef.kind);
      row.assetSymbol = fr.symbol;
      row.classification = row.success ? "read-only-fr-erc4626-probe" : "fr-erc4626-probe-unavailable";
      fractionalReserveLiveRows.push(row);
      selectorProbeRows.push(row);
    }
  }

  const rpcBlockedRows = [];
  if (chainProbe.rpcStatus !== "ready") rpcBlockedRows.push(sanitizedChainProbe(chainProbe));
  for (const row of [...codeProbeRows, ...erc20MetadataRows]) {
    if (row.codeStatus === "no-rpc" || row.rpcStatus === "no-rpc") rpcBlockedRows.push({ chain: "Ethereum", address: row.address, status: "no-rpc" });
  }

  return {
    rpcInventoryRead,
    rpcInventoryRows,
    chainProbes: [chainProbe],
    codeProbeRows,
    erc20MetadataRows,
    oracleLiveRows,
    lenderLiveRows,
    vaultLiveRows,
    fractionalReserveLiveRows,
    selectorProbeRows,
    rpcBlockedRows,
  };
}

function pickRows(rows, predicate, max = 80) {
  return rows.filter(predicate).slice(0, max);
}

function exactish(row) {
  return row.matchType === "exact-address" || row.matchType === "exact-name";
}

function selectNotableExactRows({ deploymentRows, assetRows, vaultQuoteRows, fractionalReserveRows, lenderParameterRows, agentLiquidationRows, oracleRows, sourceRows, exactLocalRows }) {
  const rows = [];
  for (const row of deploymentRows.slice(0, 6)) rows.push({ kind: "deployment", source: row.source, line: row.line || null, match: row.component, detail: `${row.address}${row.implementation ? ` impl=${row.implementation}` : ""}`, classification: row.classification });
  for (const row of assetRows.filter((r) => r.asset).slice(0, 4)) rows.push({ kind: "asset", source: row.source, line: row.line || null, match: row.symbol || row.kind, detail: `supplied=${row.supplied || "n/a"}; borrowed=${row.borrowed || "n/a"}; available=${row.available || "n/a"}; paused=${row.paused || "n/a"}`, classification: row.classification });
  for (const row of vaultQuoteRows.slice(0, 5)) rows.push({ kind: "vaultQuote", source: row.source, line: row.line || null, match: row.action, detail: `${row.input} -> ${row.output}; fee=${row.fee}; verdict=${row.verdict}`, classification: row.classification });
  for (const row of fractionalReserveRows.slice(0, 3)) rows.push({ kind: "fractionalReserve", source: row.source, line: row.line || null, match: row.asset, detail: `${row.fractionalReserveVault || "all"}; deposit=${row.publicDeposit || "n/a"}; withdraw=${row.publicWithdraw || "n/a"}`, classification: row.classification });
  for (const row of lenderParameterRows.slice(0, 4)) rows.push({ kind: "lenderParam", source: row.source, line: row.line || null, match: row.parameter, detail: row.value, classification: row.classification });
  for (const row of agentLiquidationRows.slice(0, 2)) rows.push({ kind: "liquidation", source: row.source, line: row.line || null, match: "agent/liquidation", detail: row.sample, classification: row.classification });
  for (const row of oracleRows.slice(0, 3)) rows.push({ kind: "oracle", source: row.source, line: row.line || null, match: row.asset || "oracle", detail: row.sample || row.clue, classification: row.classification });
  for (const row of sourceRows.slice(0, 5)) rows.push({ kind: "source", source: row.file, line: row.startLine, match: row.label, detail: row.sample, classification: row.classification });
  for (const row of exactLocalRows.slice(0, 12)) rows.push({ kind: "localExact", source: row.file, line: row.line || null, match: row.matched, detail: row.sample, classification: row.classification });
  return rows.slice(0, 36);
}

function buildPayload({ generatedAt, sourceFacts, sourceRows, priorTriageRows, deploymentRows, assetRows, vaultQuoteRows, fractionalReserveRows, lenderParameterRows, agentLiquidationRows, oracleRows, permissionlessEntrypointRows, adminGatedRows, oftContextRows, lineScan, live }) {
  const exactLocalRows = lineScan.exactRows;
  const consumerJoinRows = pickRows(lineScan.rows, (row) => row.categories.some((category) => ["consumer", "oracle", "vault", "liquidation"].includes(category)), 120);
  const exactConsumerJoinRows = pickRows(consumerJoinRows, exactish, 100);
  const dexLiquidityRows = pickRows(lineScan.rows, (row) => row.categories.includes("dex"), 80);
  const exactEconomicsRows = 0;
  const routePositive = 0;
  const executableNow = 0;
  const signedActionJustified = false;
  const forkJustified = false;
  const forkGate = "closed-route-positive-zero";
  const liveSelectorSuccessRows = live.selectorProbeRows.filter((row) => row.success).length;
  const codePresentRows = live.codeProbeRows.filter((row) => row.codePresent).length;

  const blockers = [
    "Prior Cap triage concluded no confirmed permissionless value-extracting exploit: public cUSD mint/burn/redeem cycles were value-negative after the 10 bps mint fee and redeem is pro-rata basket output.",
    "Live prior state showed USDC and wWTGXX backing assets not paused, but accepted-value/redeem-market comparison did not produce a positive public route.",
    "All debt-bearing agents checked in prior triage were healthy and every checked maxLiquidatable(USDC) returned 0, so the public liquidation route is dormant.",
    "Oracle adapter/staleness setters are checkAccess-gated; prior USDC feeds were fresh and wWTGXX fixed-price behavior is a governance/NAV caveat rather than a permissionless mutation path.",
    "Fractional reserve ERC4626 vault public maxDeposit/maxWithdraw checks returned 0 for a random user, blocking the direct donation/share-entry route in prior evidence.",
    "OFT/cross-chain rows are context/caveat only and do not establish a permissionless bridge/custody accounting bypass on Ethereum.",
    "Read-only code/selector probes, when available, only confirm metadata/state availability and do not prove attacker-controlled value movement.",
    "Fork and signed-action gates remain closed because routePositive=0 and exactEconomicsRows=0.",
  ];

  const requiredForRoutePositive = [
    "Fresh read-only state must show an exact public path through mint/burn/redeem, liquidation, fractional reserve, or OFT/custody logic with no role/allowlist/pause/grace-window blockers.",
    "Accepted oracle/accounting value must be measurably above immediate market/redeem/unwind value after mint/redeem fees, liquidation bonus/caps, slippage, and gas.",
    "For liquidation, at least one material agent must have health below 1, an open or openable liquidation window, and positive maxLiquidatable for an asset with available exit liquidity.",
    "For oracle/accounting, the adapter source must be permissionlessly mutable or manipulable; admin-gated setters alone are insufficient.",
    "For fractional reserve, a public entry/donation/share-price path must affect cUSD accounting and be withdrawable by the attacker.",
    "A local static or fork value-delta proof must show positive attacker-controlled balance movement before any live preflight or signed action is considered.",
  ];

  const nextReadOnlyStep = "Keep Cap dormant unless a new asset/oracle/agent state change appears; then refresh read-only vault/oracle/lender assets, pauses, caps, prices, agent health/maxLiquidatable, and redeem/DEX exit quotes without signed transactions.";
  const caveatChains = uniq([
    ...CHAIN_SEEDS.filter((row) => row.caveat).map((row) => row.chainLabel),
    ...sourceFacts.flatMap((row) => Array.isArray(row.blockedOrCaveatChains) ? row.blockedOrCaveatChains : []),
  ]);
  const notableExactRows = selectNotableExactRows({ deploymentRows, assetRows, vaultQuoteRows, fractionalReserveRows, lenderParameterRows, agentLiquidationRows, oracleRows, sourceRows, exactLocalRows });

  const summary = {
    sourceFactRows: sourceFacts.length,
    localSourceRows: sourceRows.length,
    priorTriageRows: priorTriageRows.length,
    deploymentRows: deploymentRows.length,
    assetRows: assetRows.length,
    vaultQuoteRows: vaultQuoteRows.length,
    fractionalReserveRows: fractionalReserveRows.length,
    lenderParameterRows: lenderParameterRows.length,
    agentLiquidationRows: agentLiquidationRows.length,
    oracleRows: oracleRows.length + live.oracleLiveRows.length,
    permissionlessEntrypointRows: permissionlessEntrypointRows.length,
    adminGatedRows: adminGatedRows.length,
    oftContextRows: oftContextRows.length,
    filesScanned: lineScan.filesScanned,
    filesWithLocalMatches: lineScan.filesWithMatch,
    filesWithExactLocalMatches: lineScan.filesWithExact,
    localArtifactMatchRows: lineScan.rows.length,
    exactLocalArtifactMatchRows: exactLocalRows.length,
    consumerJoinRows: consumerJoinRows.length,
    exactConsumerJoinRows: exactConsumerJoinRows.length,
    dexLiquidityRows: dexLiquidityRows.length,
    liveCodeProbeRows: live.codeProbeRows.length,
    codePresentRows,
    erc20MetadataRows: live.erc20MetadataRows.length,
    oracleLiveRows: live.oracleLiveRows.length,
    lenderLiveRows: live.lenderLiveRows.length,
    vaultLiveRows: live.vaultLiveRows.length,
    fractionalReserveLiveRows: live.fractionalReserveLiveRows.length,
    selectorProbeRows: live.selectorProbeRows.length,
    selectorProbeSuccessRows: liveSelectorSuccessRows,
    rpcBlockedRows: live.rpcBlockedRows.length,
    rpcInventoryRead: live.rpcInventoryRead,
    exactEconomicsRows,
    routePositive,
    executableNow,
    signedActionJustified,
    forkJustified,
    forkGate,
    caveatChains,
  };

  return {
    generatedAt,
    scanner: "tools/scan-cap-full-test.js",
    target: TARGET,
    scope: {
      kind: "defensive route-first full-test scanner",
      evmFirst: true,
      evmChains: CHAIN_SEEDS.filter((row) => row.inScope && Number.isFinite(row.chainId)).map((row) => row.chainLabel),
      caveatChains,
      routeGraph: TARGET.routeGraph,
      writesLimitedTo: [OUT_JSON_REL, OUT_MD_REL],
      aggregatePromotionStateHandoffEdited: false,
    },
    safety: {
      localArtifactsRead: true,
      rpcInventoryRead: live.rpcInventoryRead,
      rpcInventoryRows: live.rpcInventoryRows,
      graphqlInventoryRead: false,
      envFilesRead: false,
      privateKeysRead: false,
      keyMaterialRead: false,
      rpcUrlsStored: false,
      rawUrlsStored: false,
      rawDomainsStored: false,
      signedActions: false,
      liveTransactions: false,
      broadcasts: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      ethCallOnly: true,
      sanitizedOutputOnly: true,
      secretLikePathsExcluded: true,
    },
    discoveredSeeds: {
      chainSeeds: CHAIN_SEEDS,
      contracts: CONTRACT_SEEDS,
      assets: ASSET_SEEDS,
    },
    sourceFacts,
    localSourceRows: sourceRows,
    priorTriageRows,
    deploymentRows,
    assetRows,
    vaultQuoteRows,
    fractionalReserveRows,
    lenderParameterRows,
    agentLiquidationRows,
    oracleRows: [...oracleRows, ...live.oracleLiveRows],
    permissionlessEntrypointRows,
    adminGatedRows,
    oftContextRows,
    localArtifactMatchRows: lineScan.rows,
    exactLocalArtifactMatchRows: exactLocalRows,
    localArtifactCategoryCounts: lineScan.categoryCounts,
    consumerJoinRows,
    exactConsumerJoinRows,
    dexLiquidityRows,
    exactEconomicsRows,
    exactEconomicsEvidenceRows: [],
    liveProbeRows: {
      codeProbeRows: live.codeProbeRows,
      erc20MetadataRows: live.erc20MetadataRows,
      lenderLiveRows: live.lenderLiveRows,
      vaultLiveRows: live.vaultLiveRows,
      fractionalReserveLiveRows: live.fractionalReserveLiveRows,
    },
    selectorProbeRows: live.selectorProbeRows,
    endpointCoverage: {
      rpcInventoryRead: live.rpcInventoryRead,
      rpcInventoryRows: live.rpcInventoryRows,
      chainProbes: live.chainProbes.map(sanitizedChainProbe),
      rpcBlockedRows: live.rpcBlockedRows,
    },
    notableExactRows,
    blockers,
    requiredForRoutePositive,
    nextReadOnlyStep,
    routePositive,
    executableNow,
    signedActionJustified,
    forkJustified,
    forkGate,
    summary,
  };
}

function mdEscape(value) {
  return String(value ?? "").replace(/\|/g, " ").replace(/\r?\n/g, " ");
}

function renderSummaryTable(summary) {
  const keys = [
    "sourceFactRows", "localSourceRows", "priorTriageRows", "deploymentRows", "assetRows", "vaultQuoteRows",
    "fractionalReserveRows", "lenderParameterRows", "agentLiquidationRows", "oracleRows", "permissionlessEntrypointRows",
    "adminGatedRows", "oftContextRows", "localArtifactMatchRows", "exactLocalArtifactMatchRows", "consumerJoinRows",
    "exactConsumerJoinRows", "dexLiquidityRows", "liveCodeProbeRows", "codePresentRows", "erc20MetadataRows", "selectorProbeRows",
    "selectorProbeSuccessRows", "rpcBlockedRows", "exactEconomicsRows", "routePositive", "executableNow", "signedActionJustified", "forkJustified", "forkGate",
  ];
  return [
    "| Metric | Value |",
    "|---|---:|",
    ...keys.map((key) => `| ${key} | ${mdEscape(Array.isArray(summary[key]) ? summary[key].join(", ") : summary[key])} |`),
  ].join("\n");
}

function renderMarkdown(payload) {
  const lines = [];
  lines.push("# 🟢 DORMANT - Cap Full Test");
  lines.push("");
  lines.push(`Generated: ${payload.generatedAt}`);
  lines.push("");
  lines.push("Route remains closed: routePositive=0/executableNow=0/signedActionJustified=false/forkJustified=false/forkGate=closed-route-positive-zero.");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(renderSummaryTable(payload.summary));
  lines.push("");
  lines.push("## Scope/Safety");
  lines.push("");
  lines.push(`- Target: ${payload.target.name} (${payload.target.slug}), category=${payload.target.category}, chain=${payload.target.primaryChain}, surface=${payload.target.surface}, module=${payload.target.module}, rank≈${payload.target.discoveryRank}, TVL context≈${payload.target.tvlContext}.`);
  lines.push(`- Route graph: ${payload.target.routeGraph}.`);
  lines.push(`- Caveat chains/context: ${payload.scope.caveatChains.join(", ") || "none"}.`);
  lines.push("- No aggregate gate scripts, state/context, or handoff files are written by this scanner.");
  lines.push("- RPC output is sanitized: no raw URLs/domains/endpoints are persisted; probes are read-only eth_call/code checks only.");
  lines.push("");
  lines.push("## Notable Exact Rows");
  lines.push("");
  if (!payload.notableExactRows.length) {
    lines.push("- No notable exact rows extracted.");
  } else {
    lines.push("| Kind | Source | Match | Detail | Classification |");
    lines.push("|---|---|---|---|---|");
    for (const row of payload.notableExactRows.slice(0, 24)) {
      lines.push(`| ${mdEscape(row.kind)} | ${mdEscape(`${row.source || "n/a"}${row.line ? `:${row.line}` : ""}`)} | ${mdEscape(row.match)} | ${mdEscape(sanitizeText(row.detail, 260))} | ${mdEscape(row.classification)} |`);
    }
  }
  lines.push("");
  lines.push("## Live Read-Only Probe Snapshot");
  lines.push("");
  lines.push(`- Chain probes: ${payload.endpointCoverage.chainProbes.map((row) => `${row.chainLabel}:${row.rpcStatus}${row.blockNumber ? `@${row.blockNumber}` : ""}`).join(", ") || "none"}.`);
  lines.push(`- Code probes: ${payload.summary.liveCodeProbeRows}; code present: ${payload.summary.codePresentRows}; selector probes: ${payload.summary.selectorProbeRows}; selector successes: ${payload.summary.selectorProbeSuccessRows}; rpcBlockedRows: ${payload.summary.rpcBlockedRows}.`);
  lines.push("");
  lines.push("## Blockers");
  lines.push("");
  for (const blocker of payload.blockers) lines.push(`- ${blocker}`);
  lines.push("");
  lines.push("## Required For RoutePositive");
  lines.push("");
  for (const req of payload.requiredForRoutePositive) lines.push(`- ${req}`);
  lines.push("");
  lines.push("## Next Read-Only Step");
  lines.push("");
  lines.push(payload.nextReadOnlyStep);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function main() {
  const generatedAt = new Date().toISOString();
  const scanFiles = listScanFiles();
  const sourceFacts = loadSourceFacts();
  const sourceRows = extractSourceRows();
  const priorTriageRows = extractPriorTriageRows();
  const deploymentRows = loadDeploymentRows();
  const assetRows = loadAssetRows();
  const vaultQuoteRows = loadVaultQuoteRows();
  const fractionalReserveRows = loadFractionalReserveRows();
  const lenderParameterRows = loadLenderParameterRows();
  const agentLiquidationRows = loadAgentLiquidationRows();
  const oracleRows = loadOracleRows();
  const permissionlessEntrypointRows = loadPermissionlessEntrypointRows();
  const adminGatedRows = loadAdminGatedRows();
  const oftContextRows = parseOftContextRows();
  const lineScan = scanLocalArtifactLines(scanFiles);
  const live = await runLiveProbes();
  const payload = buildPayload({ generatedAt, sourceFacts, sourceRows, priorTriageRows, deploymentRows, assetRows, vaultQuoteRows, fractionalReserveRows, lenderParameterRows, agentLiquidationRows, oracleRows, permissionlessEntrypointRows, adminGatedRows, oftContextRows, lineScan, live });
  writeJson(OUT_JSON, payload);
  ensureDir(OUT_MD);
  fs.writeFileSync(OUT_MD, renderMarkdown(payload), "utf8");
  log(JSON.stringify({ raw: OUT_JSON_REL, report: OUT_MD_REL, summary: payload.summary }, jsonReplacer, 2));
}

main().catch((error) => {
  console.error(sanitizeError(error) || "scan failed");
  process.exit(1);
});
