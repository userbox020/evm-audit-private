#!/usr/bin/env node
"use strict";

// scan-maple-full-test.js
// Defensive Maple route-positive full test. Read-only RPC/static probes only; no signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { loadRpcUrls, resolveRpcPool, rpcCall, getImpl } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const REPORTS_DIR = path.join(WORKSPACE, "reports");
const OUT_JSON = path.join(RAW_DIR, "maple-full-test.json");
const OUT_MD = path.join(REPORTS_DIR, "maple-full-test-triage.md");
const OUT_JSON_REL = "reports/raw/fast/maple-full-test.json";
const OUT_MD_REL = "reports/maple-full-test-triage.md";

const DEEP_METADATA_FILE = path.join(RAW_DIR, "prefilter-deep-new-target-search-2026-06-24.json");
const REGISTRY_FILE = path.join(WORKSPACE, "targets", "address-registry", "address-registry.json");
const BASE_SYRUP_FILE = path.join(RAW_DIR, "base-syrupusdc-routes.json");

const QUIET = process.argv.includes("--quiet");
const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dEaD";
const ETH_CHAIN_ID = 1;
const CALL_TIMEOUT_MS = 9_000;
const MAX_STRATEGIES = 20;
const MAX_SELECTOR_TARGETS = 80;

const TARGET = {
  slug: "maple",
  name: "Maple",
  category: "Lending",
  surface: "lending-oracle-liquidation",
  module: "maple/index.js",
  routeGraph: "pool share or loan/collateral accounting -> accepted value or liquidation route -> stable/DEX exit",
  sampleAddresses: ["0xc7E8b36E0766D9B04c93De68A9D47dD11f260B45"],
};

const CATEGORY_RULES = {
  consumer: ["consumer", "accepted", "collateral", "market", "join", "borrow", "liquidation", "loan", "aave", "morpho", "euler", "silo", "compound"],
  lending: ["lending", "loan", "borrow", "debt", "repay", "liquidat", "credit", "poolmanager", "loanmanager"],
  oracle: ["oracle", "price", "feed", "chainlink", "stale", "scalar", "rateprovider", "rate provider", "nav", "valuation"],
  dex: ["dex", "swap", "pool", "amm", "uniswap", "curve", "balancer", "aerodrome", "liquidity", "router", "quote"],
  vault: ["erc4626", "vault", "share", "totalassets", "converttoshares", "converttoassets", "redeem", "withdraw", "requestredeem"],
  access: ["role", "admin", "permission", "allowlist", "pause", "governor", "timelock", "delegate", "canCall", "poolpermission"],
};

const ERC20_IFACE = new ethers.Interface([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);

const POOL_IFACE = new ethers.Interface([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function asset() view returns (address)",
  "function manager() view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function unrealizedLosses() view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function convertToExitAssets(uint256) view returns (uint256)",
  "function convertToShares(uint256) view returns (uint256)",
  "function maxDeposit(address) view returns (uint256)",
  "function maxMint(address) view returns (uint256)",
  "function maxWithdraw(address) view returns (uint256)",
  "function maxRedeem(address) view returns (uint256)",
  "function BOOTSTRAP_MINT() view returns (uint256)",
]);

const MANAGER_IFACE = new ethers.Interface([
  "function active() view returns (bool)",
  "function configured() view returns (bool)",
  "function asset() view returns (address)",
  "function pool() view returns (address)",
  "function poolDelegate() view returns (address)",
  "function poolDelegateCover() view returns (address)",
  "function poolPermissionManager() view returns (address)",
  "function withdrawalManager() view returns (address)",
  "function liquidityCap() view returns (uint256)",
  "function strategyListLength() view returns (uint256)",
  "function strategyList(uint256) view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function unrealizedLosses() view returns (uint256)",
  "function hasSufficientCover() view returns (bool)",
]);

const LOAN_MANAGER_IFACE = new ethers.Interface([
  "function assetsUnderManagement() view returns (uint256)",
  "function principalOut() view returns (uint128)",
  "function accountedInterest() view returns (uint112)",
  "function unrealizedLosses() view returns (uint128)",
  "function issuanceRate() view returns (uint256)",
]);

const WITHDRAWAL_MANAGER_IFACE = new ethers.Interface([
  "function lockedLiquidity() view returns (uint256)",
  "function totalShares() view returns (uint256)",
]);

const STRATEGY_IFACE = new ethers.Interface([
  "function assetsUnderManagement() view returns (uint256)",
  "function unrealizedLosses() view returns (uint256)",
  "function lastRecordedTotalAssets() view returns (uint256)",
  "function fundsAsset() view returns (address)",
  "function poolManager() view returns (address)",
]);

const ROUTER_IFACE = new ethers.Interface([
  "function pool() view returns (address)",
  "function poolManager() view returns (address)",
  "function poolPermissionManager() view returns (address)",
]);

const RATE_PROVIDER_IFACE = new ethers.Interface([
  "function pool() view returns (address)",
  "function getRate() view returns (uint256)",
]);

const SELECTOR_PROBES = [
  { role: "pool", name: "deposit", signature: "deposit(uint256,address)", args: () => [1n, DEAD] },
  { role: "pool", name: "mint", signature: "mint(uint256,address)", args: () => [1n, DEAD] },
  { role: "pool", name: "requestRedeem", signature: "requestRedeem(uint256,address,address)", args: () => [1n, DEAD, DEAD] },
  { role: "pool", name: "redeem", signature: "redeem(uint256,address,address)", args: () => [1n, DEAD, DEAD] },
  { role: "pool", name: "withdraw", signature: "withdraw(uint256,address,address)", args: () => [1n, DEAD, DEAD] },
  { role: "withdrawalManager", name: "processRedemptions", signature: "processRedemptions(uint256)", args: () => [1n] },
  { role: "withdrawalManager", name: "processExit", signature: "processExit(uint256)", args: () => [0n] },
  { role: "withdrawalManager", name: "removeRequest", signature: "removeRequest(uint256)", args: () => [0n] },
  { role: "loanManager", name: "fund", signature: "fund(address)", args: () => [DEAD] },
  { role: "loanManager", name: "claim", signature: "claim(address)", args: () => [DEAD] },
  { role: "loanManager", name: "triggerDefault", signature: "triggerDefault(address,address)", args: () => [DEAD, DEAD] },
  { role: "loanManager", name: "finishCollateralLiquidation", signature: "finishCollateralLiquidation(address)", args: () => [DEAD] },
  { role: "loanManager", name: "updateAccounting", signature: "updateAccounting(address)", args: () => [DEAD] },
  { role: "manager", name: "requestFunds", signature: "requestFunds(address,uint256)", args: () => [DEAD, 1n] },
  { role: "manager", name: "triggerDefault", signature: "triggerDefault(address,address)", args: () => [DEAD, DEAD] },
  { role: "manager", name: "finishCollateralLiquidation", signature: "finishCollateralLiquidation(address)", args: () => [DEAD] },
  { role: "manager", name: "setLiquidityCap", signature: "setLiquidityCap(uint256)", args: () => [1n] },
  { role: "poolOrLoan", name: "removeCollateral", signature: "removeCollateral(uint256,address)", args: () => [1n, DEAD] },
  { role: "poolOrLoan", name: "repossess", signature: "repossess(address)", args: () => [DEAD] },
  { role: "poolOrLoan", name: "skim", signature: "skim(address)", args: () => [DEAD] },
];

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

function readText(filePath) {
  try { return fs.readFileSync(filePath, "utf8"); } catch (_) { return null; }
}

function readJson(filePath, fallback = null) {
  const text = readText(filePath);
  if (!text) return fallback;
  try { return JSON.parse(text); } catch (_) { return fallback; }
}

function rel(filePath) {
  return path.relative(WORKSPACE, filePath).replace(/\\/g, "/");
}

function safeText(value, max = 260) {
  return String(value || "")
    .replace(/[\r\n|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max) || null;
}

function sanitizeText(value, max = 320) {
  let text = safeText(value, max);
  if (text === null) return null;
  text = text
    .replace(/\bhttps?:\/\/[^\s"'`<>|)]+/gi, "[redacted-url]")
    .replace(/\bwww\.[^\s"'`<>|)]+/gi, "[redacted-url]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/= -]+/gi, "Bearer [redacted]")
    .replace(/\b(authorization|api[-_]?key|access[-_]?key|private[-_]?key|secret[-_]?key|secret|token|password|pwd)\s*[:=]\s*["']?[^\s"',}\]]{8,}/gi, "$1=[redacted]")
    .replace(/\b0x[0-9a-fA-F]{64}\b/g, "[redacted-hex-key]")
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9._-]{20,}\.[A-Za-z0-9._-]{20,}\b/g, "[redacted-jwt]");
  return text;
}

function sanitizeError(error) {
  return sanitizeText(error?.shortMessage || error?.message || error || "call failed", 220);
}

function normalizeAddress(value) {
  const raw = String(value || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) return null;
  try { return ethers.getAddress(raw); } catch (_) { return raw.toLowerCase(); }
}

function addressKey(value) {
  const address = normalizeAddress(value);
  return address ? address.toLowerCase() : null;
}

function toBigInt(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === "string") {
    try { return BigInt(value); } catch (_) { return fallback; }
  }
  if (typeof value.toString === "function") {
    try { return BigInt(value.toString()); } catch (_) { return fallback; }
  }
  return fallback;
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  const text = String(value).replace(/[$,%\s,]/g, "");
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function formatUnits(raw, decimals) {
  const value = toBigInt(raw, null);
  if (value === null || decimals === null || decimals === undefined) return null;
  try { return ethers.formatUnits(value, Number(decimals)); } catch (_) { return null; }
}

function formatNumber(raw, decimals) {
  const text = formatUnits(raw, decimals);
  if (text === null) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function firstResult(result) {
  if (!result || !result.ok) return null;
  return Array.isArray(result.value) ? result.value[0] : result.value?.[0] ?? result.value;
}

async function callView(rpc, to, iface, name, args = []) {
  if (!rpc || !normalizeAddress(to)) return { ok: false, error: "missing-rpc-or-address" };
  try {
    const data = iface.encodeFunctionData(name, args);
    const raw = await rpcCall(rpc, "eth_call", [{ to, data }, "latest"], CALL_TIMEOUT_MS);
    if (!raw) return { ok: false, error: "empty-call-result" };
    return { ok: true, value: iface.decodeFunctionResult(name, raw), raw };
  } catch (error) {
    return { ok: false, error: sanitizeError(error) };
  }
}

async function getCodeSafe(rpc, address) {
  if (!rpc || !normalizeAddress(address)) return null;
  try {
    const code = await rpcCall(rpc, "eth_getCode", [address, "latest"], CALL_TIMEOUT_MS);
    return code && code !== "0x" ? { codePresent: true, codeSizeBytes: Math.max(0, (String(code).length - 2) / 2) } : { codePresent: false, codeSizeBytes: 0 };
  } catch (_) {
    return null;
  }
}

async function readToken(rpc, address) {
  if (!normalizeAddress(address)) return { address, symbol: null, name: null, decimals: 18, totalSupplyRaw: null, totalSupply: null };
  const [symbol, name, decimals, totalSupply] = await Promise.all([
    callView(rpc, address, ERC20_IFACE, "symbol"),
    callView(rpc, address, ERC20_IFACE, "name"),
    callView(rpc, address, ERC20_IFACE, "decimals"),
    callView(rpc, address, ERC20_IFACE, "totalSupply"),
  ]);
  const dec = Number(firstResult(decimals) ?? 18);
  const supply = firstResult(totalSupply);
  return {
    address,
    symbol: sanitizeText(firstResult(symbol), 64),
    name: sanitizeText(firstResult(name), 96),
    decimals: Number.isFinite(dec) ? dec : 18,
    totalSupplyRaw: supply?.toString?.() || null,
    totalSupply: formatUnits(supply, Number.isFinite(dec) ? dec : 18),
  };
}

async function readBalance(rpc, token, owner, decimals = null) {
  if (!normalizeAddress(token) || !normalizeAddress(owner)) return { raw: null, formatted: null, number: null, error: "invalid-token-or-owner" };
  const result = await callView(rpc, token, ERC20_IFACE, "balanceOf", [owner]);
  if (!result.ok) return { raw: null, formatted: null, number: null, error: result.error };
  const raw = firstResult(result);
  return { raw: raw?.toString?.() || null, formatted: decimals === null ? null : formatUnits(raw, decimals), number: decimals === null ? null : formatNumber(raw, decimals) };
}

function addAddress(rows, seen, row) {
  const address = normalizeAddress(row.address);
  if (!address) return;
  const key = `${row.chainLabel || "unknown"}:${address.toLowerCase()}:${row.type || "unknown"}:${row.name || ""}`;
  if (seen.has(key)) return;
  seen.add(key);
  rows.push({ ...row, address });
}

function buildAddressRows(registry, discoveryRow) {
  const rows = [];
  const seen = new Set();
  const chains = Array.isArray(registry?.chains) ? registry.chains : [];
  for (const chain of chains) {
    const chainLabel = chain.name || "unknown";
    const contracts = chain.contracts || {};
    for (const actor of contracts.actors || []) addAddress(rows, seen, { chainLabel, chainId: chainLabel === "ETH" ? 1 : null, type: "actor", name: actor.name, address: actor.address, source: "address-registry" });
    for (const factory of contracts.factories || []) addAddress(rows, seen, { chainLabel, chainId: chainLabel === "ETH" ? 1 : null, type: "factory", name: factory.name, address: factory.address, source: "address-registry" });
    for (const singleton of contracts.singletons || []) addAddress(rows, seen, { chainLabel, chainId: chainLabel === "ETH" ? 1 : null, type: "singleton", name: singleton.name, address: singleton.address, source: "address-registry" });
    for (const receiver of contracts.mapleCCIPReceiver || []) addAddress(rows, seen, { chainLabel, chainId: chainLabel === "ETH" ? 1 : null, type: "ccipReceiver", name: receiver.name, address: receiver.proxy || receiver.address, source: "address-registry" });
    for (const pool of contracts.pools || []) {
      const poolName = pool.name || pool.label || "pool";
      addAddress(rows, seen, { chainLabel, chainId: chainLabel === "ETH" ? 1 : null, type: "pool", name: poolName, address: pool.address, source: "address-registry", poolConfig: pool });
      for (const [field, type] of [
        ["poolManager", "poolManager"],
        ["fixedTermLoanManager", "fixedTermLoanManager"],
        ["openTermLoanManager", "openTermLoanManager"],
        ["withdrawalManagerQueue", "withdrawalManager"],
        ["withdrawalManagerCyclical", "withdrawalManager"],
        ["poolDelegateCover", "poolDelegateCover"],
        ["syrupRouter", "router"],
        ["aaveStrategy", "strategy"],
        ["skyStrategy", "strategy"],
        ["basicStrategy", "strategy"],
      ]) {
        if (pool[field]) addAddress(rows, seen, { chainLabel, chainId: chainLabel === "ETH" ? 1 : null, type, name: `${poolName}.${field}`, address: pool[field], source: "address-registry", parentPool: normalizeAddress(pool.address) });
      }
    }
    for (const proxy of contracts.proxies || []) {
      for (const [field, type] of [["implementation", "proxyImplementation"], ["initializer", "proxyInitializer"], ["migrator", "proxyMigrator"]]) {
        if (proxy[field]) addAddress(rows, seen, { chainLabel, chainId: chainLabel === "ETH" ? 1 : null, type, name: `${proxy.name}.${field}`, address: proxy[field], source: "address-registry" });
      }
    }
  }

  for (const address of TARGET.sampleAddresses) addAddress(rows, seen, { chainLabel: "Ethereum", chainId: 1, type: "discoverySample", name: "deep-target-sample", address, source: "deep-target-search" });
  if (discoveryRow?.adapter?.adapterAddressSamples) {
    for (const address of discoveryRow.adapter.adapterAddressSamples) addAddress(rows, seen, { chainLabel: "Ethereum", chainId: 1, type: "adapterSample", name: "adapter-sample", address, source: "deep-target-search" });
  }
  return rows;
}

async function enrichCodeRows(rpc, addressRows) {
  const out = [];
  for (const row of addressRows) {
    if (row.chainId !== ETH_CHAIN_ID) {
      out.push({ ...row, codePresent: null, codeSizeBytes: null, implementation: null });
      continue;
    }
    const code = await getCodeSafe(rpc, row.address);
    let implementation = null;
    if (code?.codePresent) {
      try { implementation = await getImpl(rpc, row.address, CALL_TIMEOUT_MS); } catch (_) { implementation = null; }
    }
    out.push({ ...row, codePresent: Boolean(code?.codePresent), codeSizeBytes: code?.codeSizeBytes ?? null, implementation: implementation ? normalizeAddress(implementation) : null });
  }
  return out;
}

async function scanManager(rpc, address, asset, assetDecimals, config) {
  if (!normalizeAddress(address)) return null;
  const [active, configured, managerAsset, pool, withdrawalManager, liquidityCap, totalAssets, unrealizedLosses, strategyListLength, hasSufficientCover, poolDelegateCover, poolDelegate, poolPermissionManager] = await Promise.all([
    callView(rpc, address, MANAGER_IFACE, "active"),
    callView(rpc, address, MANAGER_IFACE, "configured"),
    callView(rpc, address, MANAGER_IFACE, "asset"),
    callView(rpc, address, MANAGER_IFACE, "pool"),
    callView(rpc, address, MANAGER_IFACE, "withdrawalManager"),
    callView(rpc, address, MANAGER_IFACE, "liquidityCap"),
    callView(rpc, address, MANAGER_IFACE, "totalAssets"),
    callView(rpc, address, MANAGER_IFACE, "unrealizedLosses"),
    callView(rpc, address, MANAGER_IFACE, "strategyListLength"),
    callView(rpc, address, MANAGER_IFACE, "hasSufficientCover"),
    callView(rpc, address, MANAGER_IFACE, "poolDelegateCover"),
    callView(rpc, address, MANAGER_IFACE, "poolDelegate"),
    callView(rpc, address, MANAGER_IFACE, "poolPermissionManager"),
  ]);
  const cover = normalizeAddress(firstResult(poolDelegateCover) || config.poolDelegateCover || ZERO);
  const coverBalance = cover ? await readBalance(rpc, asset, cover, assetDecimals) : null;
  return {
    address,
    active: firstResult(active),
    configured: firstResult(configured),
    asset: normalizeAddress(firstResult(managerAsset)),
    pool: normalizeAddress(firstResult(pool)),
    withdrawalManager: normalizeAddress(firstResult(withdrawalManager)),
    poolDelegate: normalizeAddress(firstResult(poolDelegate)),
    poolDelegateCover: cover,
    poolPermissionManager: normalizeAddress(firstResult(poolPermissionManager)),
    liquidityCapRaw: firstResult(liquidityCap)?.toString?.() || null,
    liquidityCap: formatUnits(firstResult(liquidityCap), assetDecimals),
    totalAssetsRaw: firstResult(totalAssets)?.toString?.() || null,
    totalAssets: formatUnits(firstResult(totalAssets), assetDecimals),
    unrealizedLossesRaw: firstResult(unrealizedLosses)?.toString?.() || null,
    unrealizedLosses: formatUnits(firstResult(unrealizedLosses), assetDecimals),
    strategyListLength: Number(firstResult(strategyListLength) || 0n),
    hasSufficientCover: firstResult(hasSufficientCover),
    coverBalance,
    errors: [active, configured, managerAsset, pool, withdrawalManager, liquidityCap, totalAssets, unrealizedLosses, strategyListLength, hasSufficientCover, poolDelegateCover, poolDelegate, poolPermissionManager]
      .filter((r) => r && !r.ok).map((r) => r.error).filter(Boolean).slice(0, 5),
  };
}

async function scanLoanManager(rpc, address, assetDecimals) {
  if (!normalizeAddress(address)) return null;
  const [aum, principalOut, accountedInterest, unrealizedLosses, issuanceRate] = await Promise.all([
    callView(rpc, address, LOAN_MANAGER_IFACE, "assetsUnderManagement"),
    callView(rpc, address, LOAN_MANAGER_IFACE, "principalOut"),
    callView(rpc, address, LOAN_MANAGER_IFACE, "accountedInterest"),
    callView(rpc, address, LOAN_MANAGER_IFACE, "unrealizedLosses"),
    callView(rpc, address, LOAN_MANAGER_IFACE, "issuanceRate"),
  ]);
  return {
    address,
    assetsUnderManagementRaw: firstResult(aum)?.toString?.() || null,
    assetsUnderManagement: formatUnits(firstResult(aum), assetDecimals),
    principalOutRaw: firstResult(principalOut)?.toString?.() || null,
    principalOut: formatUnits(firstResult(principalOut), assetDecimals),
    accountedInterestRaw: firstResult(accountedInterest)?.toString?.() || null,
    accountedInterest: formatUnits(firstResult(accountedInterest), assetDecimals),
    unrealizedLossesRaw: firstResult(unrealizedLosses)?.toString?.() || null,
    unrealizedLosses: formatUnits(firstResult(unrealizedLosses), assetDecimals),
    issuanceRateRaw: firstResult(issuanceRate)?.toString?.() || null,
    errors: [aum, principalOut, accountedInterest, unrealizedLosses, issuanceRate].filter((r) => r && !r.ok).map((r) => r.error).filter(Boolean).slice(0, 5),
  };
}

async function scanWithdrawalManager(rpc, address, assetDecimals, shareDecimals) {
  if (!normalizeAddress(address)) return null;
  const [lockedLiquidity, totalShares] = await Promise.all([
    callView(rpc, address, WITHDRAWAL_MANAGER_IFACE, "lockedLiquidity"),
    callView(rpc, address, WITHDRAWAL_MANAGER_IFACE, "totalShares"),
  ]);
  return {
    address,
    lockedLiquidityRaw: firstResult(lockedLiquidity)?.toString?.() || null,
    lockedLiquidity: formatUnits(firstResult(lockedLiquidity), assetDecimals),
    totalSharesRaw: firstResult(totalShares)?.toString?.() || null,
    totalShares: formatUnits(firstResult(totalShares), shareDecimals),
    errors: [lockedLiquidity, totalShares].filter((r) => r && !r.ok).map((r) => r.error).filter(Boolean).slice(0, 5),
  };
}

async function strategyAddresses(rpc, managerAddress, config) {
  const out = new Set();
  for (const [key, value] of Object.entries(config || {})) {
    if (key.toLowerCase().includes("strategy") && normalizeAddress(value)) out.add(normalizeAddress(value));
  }
  const lengthResult = await callView(rpc, managerAddress, MANAGER_IFACE, "strategyListLength");
  const length = Math.min(MAX_STRATEGIES, Number(firstResult(lengthResult) || 0n));
  for (let i = 0; i < length; i += 1) {
    const result = await callView(rpc, managerAddress, MANAGER_IFACE, "strategyList", [BigInt(i)]);
    const address = normalizeAddress(firstResult(result));
    if (address) out.add(address);
  }
  return [...out];
}

async function scanStrategy(rpc, address, assetDecimals) {
  if (!normalizeAddress(address)) return null;
  const [aum, losses, lastRecordedTotalAssets, fundsAsset, poolManager] = await Promise.all([
    callView(rpc, address, STRATEGY_IFACE, "assetsUnderManagement"),
    callView(rpc, address, STRATEGY_IFACE, "unrealizedLosses"),
    callView(rpc, address, STRATEGY_IFACE, "lastRecordedTotalAssets"),
    callView(rpc, address, STRATEGY_IFACE, "fundsAsset"),
    callView(rpc, address, STRATEGY_IFACE, "poolManager"),
  ]);
  const token = normalizeAddress(firstResult(fundsAsset));
  const directBalance = token ? await readBalance(rpc, token, address, assetDecimals) : null;
  return {
    address,
    fundsAsset: token,
    poolManager: normalizeAddress(firstResult(poolManager)),
    assetsUnderManagementRaw: firstResult(aum)?.toString?.() || null,
    assetsUnderManagement: formatUnits(firstResult(aum), assetDecimals),
    unrealizedLossesRaw: firstResult(losses)?.toString?.() || null,
    unrealizedLosses: formatUnits(firstResult(losses), assetDecimals),
    lastRecordedTotalAssetsRaw: firstResult(lastRecordedTotalAssets)?.toString?.() || null,
    lastRecordedTotalAssets: formatUnits(firstResult(lastRecordedTotalAssets), assetDecimals),
    directBalance,
    errors: [aum, losses, lastRecordedTotalAssets, fundsAsset, poolManager].filter((r) => r && !r.ok).map((r) => r.error).filter(Boolean).slice(0, 5),
  };
}

async function scanRouter(rpc, address, asset, pool, assetDecimals, shareDecimals) {
  if (!normalizeAddress(address)) return null;
  const [routerPool, poolManager, permissionManager] = await Promise.all([
    callView(rpc, address, ROUTER_IFACE, "pool"),
    callView(rpc, address, ROUTER_IFACE, "poolManager"),
    callView(rpc, address, ROUTER_IFACE, "poolPermissionManager"),
  ]);
  return {
    address,
    pool: normalizeAddress(firstResult(routerPool)),
    poolManager: normalizeAddress(firstResult(poolManager)),
    poolPermissionManager: normalizeAddress(firstResult(permissionManager)),
    assetBalance: await readBalance(rpc, asset, address, assetDecimals),
    shareBalance: await readBalance(rpc, pool, address, shareDecimals),
  };
}

async function scanPool(rpc, config) {
  const poolAddress = normalizeAddress(config.address);
  if (!poolAddress) return null;
  const [name, symbol, decimals, asset, manager, totalSupply, totalAssets, unrealizedLosses, bootstrapMint] = await Promise.all([
    callView(rpc, poolAddress, POOL_IFACE, "name"),
    callView(rpc, poolAddress, POOL_IFACE, "symbol"),
    callView(rpc, poolAddress, POOL_IFACE, "decimals"),
    callView(rpc, poolAddress, POOL_IFACE, "asset"),
    callView(rpc, poolAddress, POOL_IFACE, "manager"),
    callView(rpc, poolAddress, POOL_IFACE, "totalSupply"),
    callView(rpc, poolAddress, POOL_IFACE, "totalAssets"),
    callView(rpc, poolAddress, POOL_IFACE, "unrealizedLosses"),
    callView(rpc, poolAddress, POOL_IFACE, "BOOTSTRAP_MINT"),
  ]);
  const shareDecimals = Number(firstResult(decimals) ?? 18);
  const assetAddress = normalizeAddress(firstResult(asset));
  const assetToken = await readToken(rpc, assetAddress);
  const assetDecimals = Number(assetToken.decimals ?? 18);
  const shareUnit = 10n ** BigInt(Math.max(0, shareDecimals));
  const assetUnit = 10n ** BigInt(Math.max(0, assetDecimals));
  const [convertToAssets, convertToExitAssets, convertToShares, maxDeposit, maxMint, maxWithdraw, maxRedeem, poolCash] = await Promise.all([
    callView(rpc, poolAddress, POOL_IFACE, "convertToAssets", [shareUnit]),
    callView(rpc, poolAddress, POOL_IFACE, "convertToExitAssets", [shareUnit]),
    callView(rpc, poolAddress, POOL_IFACE, "convertToShares", [assetUnit]),
    callView(rpc, poolAddress, POOL_IFACE, "maxDeposit", [DEAD]),
    callView(rpc, poolAddress, POOL_IFACE, "maxMint", [DEAD]),
    callView(rpc, poolAddress, POOL_IFACE, "maxWithdraw", [DEAD]),
    callView(rpc, poolAddress, POOL_IFACE, "maxRedeem", [DEAD]),
    readBalance(rpc, assetAddress, poolAddress, assetDecimals),
  ]);
  const managerAddress = normalizeAddress(firstResult(manager) || config.poolManager);
  const managerState = await scanManager(rpc, managerAddress, assetAddress, assetDecimals, config);
  const fixedTerm = await scanLoanManager(rpc, config.fixedTermLoanManager, assetDecimals);
  const openTerm = await scanLoanManager(rpc, config.openTermLoanManager, assetDecimals);
  const withdrawal = await scanWithdrawalManager(rpc, config.withdrawalManagerQueue || config.withdrawalManagerCyclical || managerState?.withdrawalManager, assetDecimals, shareDecimals);
  const router = await scanRouter(rpc, config.syrupRouter, assetAddress, poolAddress, assetDecimals, shareDecimals);
  const strategies = [];
  for (const strategy of await strategyAddresses(rpc, managerAddress, config)) strategies.push(await scanStrategy(rpc, strategy, assetDecimals));
  return {
    chain: "Ethereum",
    chainId: ETH_CHAIN_ID,
    name: sanitizeText(config.name || config.label || firstResult(name), 96),
    label: sanitizeText(config.label || config.name || firstResult(name), 96),
    pool: poolAddress,
    symbol: sanitizeText(firstResult(symbol), 64),
    decimals: shareDecimals,
    asset: assetAddress,
    assetToken,
    manager: managerAddress,
    totalSupplyRaw: firstResult(totalSupply)?.toString?.() || null,
    totalSupply: formatUnits(firstResult(totalSupply), shareDecimals),
    totalAssetsRaw: firstResult(totalAssets)?.toString?.() || null,
    totalAssets: formatUnits(firstResult(totalAssets), assetDecimals),
    unrealizedLossesRaw: firstResult(unrealizedLosses)?.toString?.() || null,
    unrealizedLosses: formatUnits(firstResult(unrealizedLosses), assetDecimals),
    bootstrapMintRaw: firstResult(bootstrapMint)?.toString?.() || null,
    bootstrapMint: formatUnits(firstResult(bootstrapMint), shareDecimals),
    convertToAssetsOneShareRaw: firstResult(convertToAssets)?.toString?.() || null,
    convertToAssetsOneShare: formatUnits(firstResult(convertToAssets), assetDecimals),
    convertToExitAssetsOneShareRaw: firstResult(convertToExitAssets)?.toString?.() || null,
    convertToExitAssetsOneShare: formatUnits(firstResult(convertToExitAssets), assetDecimals),
    convertToSharesOneAssetRaw: firstResult(convertToShares)?.toString?.() || null,
    convertToSharesOneAsset: formatUnits(firstResult(convertToShares), shareDecimals),
    maxDepositRaw: firstResult(maxDeposit)?.toString?.() || null,
    maxDeposit: formatUnits(firstResult(maxDeposit), assetDecimals),
    maxMintRaw: firstResult(maxMint)?.toString?.() || null,
    maxMint: formatUnits(firstResult(maxMint), shareDecimals),
    maxWithdrawRaw: firstResult(maxWithdraw)?.toString?.() || null,
    maxWithdraw: formatUnits(firstResult(maxWithdraw), assetDecimals),
    maxRedeemRaw: firstResult(maxRedeem)?.toString?.() || null,
    maxRedeem: formatUnits(firstResult(maxRedeem), shareDecimals),
    poolCash,
    managerState,
    fixedTermLoanManager: fixedTerm,
    openTermLoanManager: openTerm,
    withdrawalManager: withdrawal,
    router,
    strategies: strategies.filter(Boolean),
    errors: [name, symbol, decimals, asset, manager, totalSupply, totalAssets, unrealizedLosses, bootstrapMint, convertToAssets, convertToExitAssets, convertToShares, maxDeposit, maxMint, maxWithdraw, maxRedeem]
      .filter((r) => r && !r.ok).map((r) => r.error).filter(Boolean).slice(0, 8),
  };
}

async function selectorProbe(rpc, target) {
  try {
    const iface = new ethers.Interface([`function ${target.signature}`]);
    const data = iface.encodeFunctionData(target.name, target.args());
    const raw = await rpcCall(rpc, "eth_call", [{ from: DEAD, to: target.address, data }, "latest"], CALL_TIMEOUT_MS);
    return { ...target, dataSelector: data.slice(0, 10), ok: Boolean(raw), reverted: !raw, error: raw ? null : "empty-call-result" };
  } catch (error) {
    return { ...target, dataSelector: selectorFromSignature(target.signature), ok: false, reverted: true, error: sanitizeError(error) };
  }
}

function selectorFromSignature(signature) {
  try { return ethers.id(signature).slice(0, 10); } catch (_) { return null; }
}

async function runSelectorProbes(rpc, poolRows) {
  const targets = [];
  for (const pool of poolRows) {
    const push = (role, address) => {
      if (!normalizeAddress(address)) return;
      for (const probe of SELECTOR_PROBES.filter((item) => item.role === role || (item.role === "poolOrLoan" && ["pool", "loanManager"].includes(role)))) {
        targets.push({ ...probe, targetRole: role, address: normalizeAddress(address), pool: pool.pool, poolName: pool.name });
      }
    };
    push("pool", pool.pool);
    push("manager", pool.manager);
    push("withdrawalManager", pool.withdrawalManager?.address);
    push("loanManager", pool.fixedTermLoanManager?.address);
    push("loanManager", pool.openTermLoanManager?.address);
  }
  const deduped = [];
  const seen = new Set();
  for (const target of targets) {
    const key = `${target.address}:${target.signature}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(target);
    if (deduped.length >= MAX_SELECTOR_TARGETS) break;
  }
  const out = [];
  for (const target of deduped) out.push(await selectorProbe(rpc, target));
  return out.map((row) => ({
    poolName: row.poolName,
    pool: row.pool,
    targetRole: row.targetRole,
    address: row.address,
    function: row.name,
    signature: row.signature,
    selector: row.dataSelector,
    ok: row.ok,
    reverted: row.reverted,
    error: row.error,
    classification: row.ok ? "watch-only-nonreverting-eth-call" : "reverted-or-unavailable",
  }));
}

function listFiles(root, predicate, max = 2_000) {
  const out = [];
  function walk(dir) {
    if (out.length >= max) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      const relative = rel(file).toLowerCase();
      if (entry.isDirectory()) {
        if (/node_modules|\.git|cache|dist|build/.test(relative)) continue;
        walk(file);
      } else if (predicate(file)) {
        out.push(file);
      }
      if (out.length >= max) break;
    }
  }
  walk(root);
  return out;
}

function categoriesFor(text) {
  const lower = String(text || "").toLowerCase();
  const cats = [];
  for (const [category, words] of Object.entries(CATEGORY_RULES)) {
    if (words.some((word) => lower.includes(word))) cats.push(category);
  }
  return cats.length ? cats : ["context"];
}

function snippetAround(text, index, width = 180) {
  const start = Math.max(0, index - width);
  const end = Math.min(text.length, index + width);
  return sanitizeText(text.slice(start, end), 360);
}

function searchLocalArtifacts(addressRows) {
  const exactTerms = [...new Set(addressRows.map((row) => addressKey(row.address)).filter(Boolean))];
  const broadTerms = ["maple", "syrup", "syrupusdc", "syrupusdt", "poolmanager", "loanmanager"];
  const files = [
    ...listFiles(path.join(WORKSPACE, "reports"), (file) => file.endsWith(".md"), 1_000),
    ...listFiles(path.join(RAW_DIR), (file) => file.endsWith(".json"), 1_000),
    ...listFiles(path.join(WORKSPACE, "tools"), (file) => file.endsWith(".js"), 1_000),
  ];
  const rows = [];
  const generatedExclude = /maple-full-test|route-positive-sweep|audit-completion-gates|low-fund-executable-route-filter|route-gate-consistency-audit|exploit-findings-summary/i;
  for (const file of files) {
    const relative = rel(file);
    if (generatedExclude.test(relative)) continue;
    const text = readText(file);
    if (!text) continue;
    const lower = text.toLowerCase();
    let countForFile = 0;
    for (const term of exactTerms) {
      const index = lower.indexOf(term);
      if (index >= 0) {
        rows.push({ file: relative, matchType: "exact-address", term, categories: categoriesFor(`${relative} ${snippetAround(text, index)}`), snippet: snippetAround(text, index) });
        countForFile += 1;
      }
      if (countForFile >= 5) break;
    }
    if (countForFile < 5) {
      for (const term of broadTerms) {
        const index = lower.indexOf(term);
        if (index >= 0) {
          rows.push({ file: relative, matchType: "broad-term", term, categories: categoriesFor(`${relative} ${snippetAround(text, index)}`), snippet: snippetAround(text, index) });
          countForFile += 1;
          break;
        }
      }
    }
  }
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.file}:${row.matchType}:${row.term}:${row.snippet}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 400);
}

function discoveryRow() {
  const metadata = readJson(DEEP_METADATA_FILE, {});
  return (metadata.rankedQueue || []).find((row) => String(row.slug || "").toLowerCase() === TARGET.slug) || null;
}

function baseSyrupContext() {
  const artifact = readJson(BASE_SYRUP_FILE, null);
  if (!artifact) return null;
  const summary = artifact.summary || {};
  const blockers = artifact.blockers || artifact.route?.blockers || [];
  return {
    sourceArtifact: "reports/raw/fast/base-syrupusdc-routes.json",
    generatedAt: artifact.generatedAt || null,
    routePositive: asNumber(summary.routePositive) || 0,
    signedActionJustified: Boolean(summary.signedActionJustified),
    marketPriceUsd: round(summary.marketPriceUsd, 6),
    mapleNavUsd: round(summary.mapleNavUsd, 6),
    mapleExitUsd: round(summary.mapleExitUsd, 6),
    navSpreadBps: round(summary.navSpreadBps, 2),
    exitSpreadBps: round(summary.exitSpreadBps, 2),
    aaveBorrowableVsMarketBps: round(summary.aaveBorrowableVsMarketBps, 2),
    fluidBestBorrowableVsMarketBps: round(summary.fluidBestBorrowableVsMarketBps, 2),
    watchCandidates: asNumber(summary.watchCandidates) || 0,
    blockers: Array.isArray(blockers) ? blockers.slice(0, 8).map((item) => sanitizeText(item, 240)) : [],
  };
}

function renderMarkdown(payload) {
  const s = payload.summary;
  const lines = [];
  lines.push("# 🟢 DORMANT — Maple Full Test");
  lines.push("");
  lines.push(`Generated: ${payload.generatedAt}`);
  lines.push("");
  lines.push("## Verdict");
  lines.push("");
  lines.push("No route-positive or executable Maple path is proven. Current evidence is registry/live-state/context mapping only, with no exact-positive economics or fork/static value-delta proof.");
  lines.push("");
  lines.push("## Safety");
  for (const [key, value] of Object.entries(payload.safety)) lines.push(`- ${key}: ${value}`);
  lines.push("");
  lines.push("## Metrics");
  for (const key of ["addressRows", "registryPoolRows", "codePresentRows", "poolProbeRows", "selectorProbeRows", "selectorProbeSuccessRows", "localArtifactMatchRows", "exactLocalArtifactMatchRows", "consumerJoinRows", "exactConsumerJoinRows", "dexLiquidityRows", "exactEconomicsRows", "baseSyrupRoutePositive", "routePositive", "executableNow", "signedActionJustified", "forkJustified", "forkGate"]) {
    lines.push(`- ${key}: ${s[key]}`);
  }
  lines.push(`- caveatChains: ${(s.caveatChains || []).join(", ") || "none"}`);
  lines.push("");
  lines.push("## Top Pool Rows");
  if (!payload.poolProbeRows.length) lines.push("- No pool probes completed.");
  for (const row of payload.poolProbeRows.slice(0, 8)) {
    lines.push(`- ${row.name || row.label || row.pool}: asset=${row.assetToken?.symbol || row.asset || "n/a"}, totalAssets=${row.totalAssets || "n/a"}, poolCash=${row.poolCash?.formatted || "n/a"}, shareToAssets=${row.convertToAssetsOneShare || "n/a"}, active=${row.managerState?.active}, configured=${row.managerState?.configured}, lockedLiquidity=${row.withdrawalManager?.lockedLiquidity || "n/a"}`);
  }
  lines.push("");
  lines.push("## Route / Economics Context");
  if (payload.routeContext?.baseSyrup) {
    const base = payload.routeContext.baseSyrup;
    lines.push(`- Base syrupUSDC context: routePositive=${base.routePositive}, navSpreadBps=${base.navSpreadBps}, exitSpreadBps=${base.exitSpreadBps}, Aave borrowable-vs-market bps=${base.aaveBorrowableVsMarketBps}, Fluid best borrowable-vs-market bps=${base.fluidBestBorrowableVsMarketBps}.`);
  } else {
    lines.push("- No prior base syrupUSDC route artifact found.");
  }
  lines.push("- Selector successes, if any, are eth_call-only watch context and not treated as value movement.");
  lines.push("");
  lines.push("## Blockers");
  for (const blocker of payload.blockers) lines.push(`- ${blocker}`);
  lines.push("");
  lines.push("## Required For Route Positive");
  for (const req of payload.requiredForRoutePositive) lines.push(`- ${req}`);
  lines.push("");
  lines.push("## Next Step");
  lines.push("");
  lines.push(payload.nextReadOnlyStep);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function main() {
  const generatedAt = new Date().toISOString();
  const discovery = discoveryRow();
  const registry = readJson(REGISTRY_FILE, {});
  const addressRows = buildAddressRows(registry, discovery);
  const skipRpcInventory = process.env.MAPLE_SKIP_RPC_INVENTORY === "1";
  const rpcUrls = skipRpcInventory ? [] : loadRpcUrls();
  const rpcPool = await resolveRpcPool([ETH_CHAIN_ID], rpcUrls);
  const ethRpc = rpcPool[ETH_CHAIN_ID] || null;

  const enrichedAddressRows = ethRpc ? await enrichCodeRows(ethRpc, addressRows) : addressRows.map((row) => ({ ...row, codePresent: null, codeSizeBytes: null, implementation: null }));
  const ethRegistry = (registry.chains || []).find((chain) => chain.name === "ETH") || {};
  const poolConfigs = ethRegistry.contracts?.pools || [];
  const poolProbeRows = [];
  if (ethRpc) {
    for (const config of poolConfigs) poolProbeRows.push(await scanPool(ethRpc, config));
  }
  const selectorProbeRows = ethRpc ? await runSelectorProbes(ethRpc, poolProbeRows.filter(Boolean)) : [];
  const localArtifactMatches = searchLocalArtifacts(enrichedAddressRows);
  const routeContext = { baseSyrup: baseSyrupContext() };

  const routePositive = 0;
  const executableNow = 0;
  const signedActionJustified = false;
  const forkJustified = false;
  const forkGate = "closed-route-positive-zero";
  const exactMatches = localArtifactMatches.filter((row) => row.matchType === "exact-address");
  const consumerRows = localArtifactMatches.filter((row) => row.categories.some((cat) => ["consumer", "lending", "oracle"].includes(cat)));
  const exactConsumerRows = consumerRows.filter((row) => row.matchType === "exact-address");
  const dexRows = localArtifactMatches.filter((row) => row.categories.includes("dex"));
  const baseSyrupRoutePositive = asNumber(routeContext.baseSyrup?.routePositive) || 0;
  const exactEconomicsRows = baseSyrupRoutePositive > 0 ? 1 : 0;

  const summary = {
    addressRows: enrichedAddressRows.length,
    registryPoolRows: poolConfigs.length,
    codePresentRows: enrichedAddressRows.filter((row) => row.codePresent === true).length,
    poolProbeRows: poolProbeRows.filter(Boolean).length,
    selectorProbeRows: selectorProbeRows.length,
    selectorProbeSuccessRows: selectorProbeRows.filter((row) => row.ok).length,
    localArtifactMatchRows: localArtifactMatches.length,
    exactLocalArtifactMatchRows: exactMatches.length,
    consumerJoinRows: consumerRows.length,
    exactConsumerJoinRows: exactConsumerRows.length,
    dexLiquidityRows: dexRows.length,
    exactEconomicsRows,
    baseSyrupRoutePositive,
    caveatChains: ["Solana"],
    routePositive,
    executableNow,
    signedActionJustified,
    forkJustified,
    forkGate,
  };

  const blockers = [
    "No concrete Maple pool, loan, oracle, collateral, withdrawal, or accounting anomaly is proven in current live/read-only state.",
    "Local Maple artifact and consumer matches are context-only and do not prove attacker-favorable accepted value, borrow liquidity, or liquidatable state.",
    routeContext.baseSyrup
      ? "Existing base syrupUSDC route context remains route-negative: market/NAV/borrowable edges do not clear exact-positive route gates."
      : "No exact Maple acquisition/borrow/redeem/liquidation/unwind economics artifact is positive.",
    "Maple PoolManager, PoolPermissionManager, withdrawal queue, loan manager, governor/security-admin, and pool delegate controls remain permission/queue/admin gates unless a permissionless value path is proven.",
    "Selector eth_call results are revert/availability classification only; no state-changing value delta was measured or proven.",
    "Solana Maple context remains a non-EVM caveat and is not closed route-negative by this EVM pass.",
    "No local fork/static value-delta proof exists, and no signed action is justified.",
  ];

  const requiredForRoutePositive = [
    "specific Maple pool/loan/collateral/oracle/accounting state is attacker-favorable in current live state",
    "permissionless path can move value, borrow, redeem, withdraw, claim, liquidate, or unwind without role/admin/queue blockers",
    "exact acquisition, borrow/repay, redeem/withdraw/claim/liquidation, and exit economics are positive after fees, queues, caps, slippage, and gas",
    "local fork/static value-delta proof confirms attacker-controlled positive balance movement",
    "independent review before any live preflight, and explicit route-specific authorization before any signed action",
  ];

  const payload = {
    generatedAt,
    scanner: "tools/scan-maple-full-test.js",
    scope: "Maple defensive route-positive full test over registry, live read-only Ethereum state, local artifacts, and existing syrup route economics",
    target: TARGET,
    discoveryRow: discovery,
    sourceArtifacts: ["targets/address-registry/address-registry.json", "reports/raw/fast/prefilter-deep-new-target-search-2026-06-24.json", "reports/raw/fast/base-syrupusdc-routes.json"],
    safety: {
      rpcInventoryRead: !skipRpcInventory && rpcUrls.length > 0,
      graphqlInventoryRead: false,
      envFilesRead: false,
      privateKeysRead: false,
      rpcUrlsStored: false,
      rawUrlsStored: false,
      signedActions: false,
      liveTransactions: false,
      broadcasts: false,
      forkTransactions: false,
      ethCallOnly: true,
    },
    routePositive,
    executableNow,
    signedActionJustified,
    forkJustified,
    forkGate,
    summary,
    addressRows: enrichedAddressRows,
    poolProbeRows: poolProbeRows.filter(Boolean),
    selectorProbeRows,
    localArtifactMatches,
    routeContext,
    blockers,
    requiredForRoutePositive,
    nextReadOnlyStep: "Keep Maple dormant unless a current pool/loan/oracle/accounting anomaly maps to a material permissionless route with exact-positive economics; then run focused local fork/static value-delta proof before any live preflight.",
  };

  writeJson(OUT_JSON, payload);
  ensureDir(OUT_MD);
  fs.writeFileSync(OUT_MD, renderMarkdown(payload), "utf8");
  log(`wrote ${OUT_JSON_REL}`);
  log(`wrote ${OUT_MD_REL}`);
  log(`routePositive=${routePositive}; poolProbeRows=${summary.poolProbeRows}; localArtifactMatchRows=${summary.localArtifactMatchRows}`);
}

main().catch((error) => {
  console.error(sanitizeError(error) || "scan failed");
  process.exit(1);
});
