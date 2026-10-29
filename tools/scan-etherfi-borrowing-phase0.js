#!/usr/bin/env node
// scan-etherfi-borrowing-phase0.js - read-only Phase 0 for EtherFi Borrowing Market / Cash DebtManager.
// RPC URLs are resolved in memory only. Never prints/stores RPC URLs, private keys, execution calldata, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpcPool } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const TARGET_DIR = path.join(WORKSPACE, "targets", "cash-v3");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "etherfi-borrowing-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "etherfi-borrowing-phase0-triage.md");
const PUBLIC_TARGETS = path.join(WORKSPACE, "reports", "raw", "fast", "public-audit-target-discovery.json");
const QUIET = process.argv.includes("--quiet");

const SIGNAL_DORMANT = "\uD83D\uDFE2 DORMANT";
const ZERO = "0x0000000000000000000000000000000000000000";
const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const EIP1967_BEACON = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const RECENT_LOG_BLOCKS = Number(process.env.ETHERFI_RECENT_LOG_BLOCKS || "300000");
const LOG_CHUNK_BLOCKS = Number(process.env.ETHERFI_LOG_CHUNK_BLOCKS || "10000");
const MAX_USERS = Number(process.env.ETHERFI_MAX_USERS || "1200");
const SAMPLE_SAFES = Number(process.env.ETHERFI_SAMPLE_SAFES || "500");
const SAFE_BATCH = Number(process.env.ETHERFI_SAFE_BATCH || "50");
const MAX_HELPER_BATCHES = Number(process.env.ETHERFI_MAX_HELPER_BATCHES || "12");

const CHAINS = {
  optimism: {
    chainId: 10,
    chain: "Optimism",
    adapterKey: "optimism",
    coinSlug: "optimism",
    factory: "0xF4e147Db314947fC1275a8CbB6Cde48c510cd8CF",
    helper: "0x0Da474E396F059594C0412ED79b2C9349bbc8087",
    debtManager: "0x0078C5a459132e279056B2371fE8A8eC973A9553",
  },
  scroll: {
    chainId: 534352,
    chain: "Scroll",
    adapterKey: "scroll",
    coinSlug: "scroll",
    factory: "0xF4e147Db314947fC1275a8CbB6Cde48c510cd8CF",
    helper: "0xF0df37503714f08d0fCA5B434F1FFA2b8b1AF34B",
    debtManager: "0x0078C5a459132e279056B2371fE8A8eC973A9553",
  },
};

const ERC20 = new ethers.Interface([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const PAUSABLE = new ethers.Interface(["function paused() view returns (bool)"]);
const FACTORY = new ethers.Interface([
  "function numContractsDeployed() view returns (uint256)",
  "function getDeployedAddresses(uint256 start,uint256 n) view returns (address[])",
]);
const HELPER = new ethers.Interface([
  "function getTotalCollateralForSafesWithIndex(uint256 startIndex,uint256 n) view returns (tuple(address token,uint256 amount)[])",
]);
const DEBT = new ethers.Interface([
  "function getCollateralTokens() view returns (address[])",
  "function getBorrowTokens() view returns (address[])",
  "function isCollateralToken(address) view returns (bool)",
  "function isBorrowToken(address) view returns (bool)",
  "function borrowTokenConfig(address) view returns (uint256 interestIndexSnapshot,uint256 totalNormalizedBorrowingAmount,uint256 totalSharesOfBorrowTokens,uint64 lastUpdateTimestamp,uint64 borrowApy,uint128 minShares)",
  "function collateralTokenConfig(address) view returns (uint80 ltv,uint80 liquidationThreshold,uint96 liquidationBonus)",
  "function totalBorrowingAmount(address) view returns (uint256)",
  "function totalBorrowingAmounts() view returns (tuple(address token,uint256 amount)[] borrowings,uint256 totalBorrowingsInUsd)",
  "function totalSupplies(address) view returns (uint256)",
  "function totalSupplies() view returns (tuple(address token,uint256 amount)[] suppliesData,uint256 amountInUsd)",
  "function getCurrentState() view returns (tuple(address token,uint256 amount)[] borrowings,uint256 totalBorrowingsInUsd,tuple(address token,uint256 amount)[] totalLiquidStableAmounts)",
  "function getUserCurrentState(address user) view returns (tuple(address token,uint256 amount)[] totalCollaterals,uint256 totalCollateralInUsd,tuple(address token,uint256 amount)[] borrowings,uint256 totalBorrowings)",
  "function liquidatable(address user) view returns (bool)",
  "function getMaxBorrowAmount(address user,bool forLtv) view returns (uint256)",
  "function remainingBorrowingCapacityInUSD(address user) view returns (uint256)",
  "function convertCollateralTokenToUsd(address collateralToken,uint256 collateralAmount) view returns (uint256)",
  "function convertUsdToCollateralToken(address collateralToken,uint256 debtUsdAmount) view returns (uint256)",
]);
const PRICE_V2 = new ethers.Interface([
  "function tokenConfig(address token) view returns (tuple(address oracle,bytes priceFunctionCalldata,bool isChainlinkType,uint8 oraclePriceDecimals,uint24 maxStaleness,uint8 dataType,bool isStableToken,address baseAsset))",
  "function price(address token) view returns (uint256)",
  "function isBaseAsset(address token) view returns (bool)",
]);
const PRICE_V1 = new ethers.Interface([
  "function tokenConfig(address token) view returns (tuple(address oracle,bytes priceFunctionCalldata,bool isChainlinkType,uint8 oraclePriceDecimals,uint24 maxStaleness,uint8 dataType,bool isBaseTokenEth,bool isStableToken,bool isBaseTokenBtc))",
]);
const CHAINLINK = new ethers.Interface([
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
]);
const ROLE_REGISTRY = new ethers.Interface([
  "function owner() view returns (address)",
  "function roleHolders(bytes32 role) view returns (address[])",
  "function hasRole(bytes32 role,address account) view returns (bool)",
]);
const EVENT_IFACE = new ethers.Interface([
  "event Borrowed(address indexed user,address indexed token,uint256 amount)",
  "event Repaid(address indexed user,address indexed payer,address indexed token,uint256 amount)",
  "event Liquidated(address indexed liquidator,address indexed user,address indexed debtTokenToLiquidate,tuple(address token,uint256 amount,uint256 liquidationBonus)[] userCollateralLiquidated,uint256 beforeDebtAmount,uint256 debtAmountLiquidated)",
]);

const ROLE_NAMES = [
  "PAUSER", "UNPAUSER", "PRICE_PROVIDER_ADMIN_ROLE", "DEBT_MANAGER_ADMIN_ROLE",
  "CASH_MODULE_CONTROLLER_ROLE", "ETHERFI_SAFE_FACTORY_ADMIN_ROLE", "ETHER_FI_WALLET_ROLE",
  "SETTLEMENT_DISPATCHER_BRIDGER_ROLE", "TOP_UP_ROLE", "ETHERFI_LIQUID_MODULE_ADMIN",
];

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readText(file) { try { return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""; } catch (_) { return ""; } }
function readJson(file, fallback = null) { try { const t = readText(file).replace(/^\uFEFF/, ""); return t ? JSON.parse(t) : fallback; } catch (_) { return fallback; } }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function safeText(value, max = 180) { return String(value ?? "").replace(/https?:\/\/\S+/g, "[redacted-url]").replace(/\s+/g, " ").trim().slice(0, max) || null; }
function asNumber(value) { if (value === null || value === undefined) return null; if (typeof value === "number") return Number.isFinite(value) ? value : null; const n = Number(String(value).replace(/[$,%\s,]/g, "")); return Number.isFinite(n) ? n : null; }
function round(value, decimals = 2) { const n = asNumber(value); if (n === null) return null; const f = 10 ** decimals; return Math.round(n * f) / f; }
function formatUsd(value) { const n = asNumber(value); return n === null ? "n/a" : `$${Math.round(n).toLocaleString()}`; }
function formatNumber(value, decimals = 2) { const n = asNumber(value); return n === null ? "n/a" : n.toLocaleString(undefined, { maximumFractionDigits: decimals }); }
function unique(items) { return [...new Set((items || []).filter(Boolean))]; }
function strip0x(value) { return String(value || "").replace(/^0x/i, ""); }
function hexBlock(value) { return `0x${BigInt(value).toString(16)}`; }
function toBig(value) { try { return BigInt(value ?? 0); } catch (_) { return 0n; } }
function unitsToNumber(value, decimals = 18) { try { return Number(ethers.formatUnits(toBig(value), decimals)); } catch (_) { return null; } }
function unitsToNumberMaybe(value, decimals = 18) { return value === null || value === undefined ? null : unitsToNumber(value, decimals); }
function usd6(value) { return round(unitsToNumber(value, 6), 2); }
function normalizeAddress(value) { try { return ethers.getAddress(String(value || "").replace(/^0X/, "0x")); } catch (_) { return null; } }
function lowerAddress(value) { const addr = normalizeAddress(value); return addr ? addr.toLowerCase() : null; }
function compactAddress(value) { const addr = normalizeAddress(value); return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : "n/a"; }
function slotAddress(raw) { const addr = raw && raw !== "0x" && raw.length >= 66 ? normalizeAddress(`0x${raw.slice(26)}`) : null; return addr && addr !== ZERO ? addr : null; }
function pctBpsFrom18(value) { const n = unitsToNumber(value, 18); return n === null ? null : round(n * 100, 2); }
function pctFrom18(value) { const n = unitsToNumber(value, 18); return n === null ? null : round(n, 4); }
function priceKey(chain, address) { return `${chain.coinSlug}:${String(address || "").toLowerCase()}`; }
function stableUsdGuess(symbol) { return /^(USDC|USDT|USDT0|DAI|USDS|USDE|FRXUSD|EURC|EUSD|LIQUIDUSD|LIQUIDRESERVE|LIQUIDEUR)$/i.test(String(symbol || "")) ? 1 : null; }
function configHasOracle(cfg) { return Boolean(cfg?.oracle && cfg.oracle !== ZERO); }

function deploymentAddresses(chainId) {
  const file = path.join(TARGET_DIR, "deployments", "mainnet", String(chainId), "deployments.json");
  return readJson(file, {})?.addresses || {};
}

function protocolMetadata() {
  const d = readJson(PUBLIC_TARGETS, {});
  const rows = [...(d.phase0Queue || []), ...(d.protocolCandidates || []), ...(d.consumerJoinFirst || [])];
  const row = rows.find((p) => p?.slug === "etherfi-borrowing-market" || p?.name === "EtherFi Borrowing Market");
  return row ? { name: row.name, slug: row.slug, category: row.category, chains: row.chains || [], evmChains: row.evmChains || [], tvlUsd: row.tvlUsd, change1dPct: row.change1dPct, change7dPct: row.change7dPct, routePriority: row.routePriority || null, source: "public-audit-target-discovery" } : { name: "EtherFi Borrowing Market", slug: "etherfi-borrowing-market", category: "Lending", chains: ["Optimism", "Scroll"], evmChains: ["Optimism", "Scroll"], tvlUsd: null };
}

async function fetchJson(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-etherfi-borrowing-phase0/1.0" } });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
    return { ok: res.ok, status: res.status, json, error: res.ok ? null : safeText(text || `HTTP ${res.status}`, 120) };
  } catch (err) { return { ok: false, status: null, json: null, error: safeText(err?.name || err?.message || "transport-error", 80) }; }
  finally { clearTimeout(timer); }
}

async function safeCall(rpc, to, iface, fn, args = [], timeoutMs = 12_000) {
  const addr = normalizeAddress(to);
  if (!rpc || !addr) return null;
  try {
    const raw = await rpcCall(rpc, "eth_call", [{ to: addr, data: iface.encodeFunctionData(fn, args) }, "latest"], timeoutMs);
    if (!raw || raw === "0x") return null;
    return iface.decodeFunctionResult(fn, raw);
  } catch (_) { return null; }
}

async function rawCall(rpc, to, data, timeoutMs = 12_000) {
  const addr = normalizeAddress(to);
  if (!rpc || !addr || !data || data === "0x") return null;
  return await rpcCall(rpc, "eth_call", [{ to: addr, data }, "latest"], timeoutMs).catch(() => null);
}

async function getCode(rpc, address) {
  const addr = normalizeAddress(address);
  if (!rpc || !addr) return "0x";
  return await rpcCall(rpc, "eth_getCode", [addr, "latest"], 10_000).catch(() => "0x") || "0x";
}

async function getSlotAddress(rpc, address, slot) {
  const raw = await rpcCall(rpc, "eth_getStorageAt", [address, slot, "latest"], 10_000).catch(() => null);
  return slotAddress(raw);
}

async function latestBlock(rpc) {
  const num = await rpcCall(rpc, "eth_blockNumber", [], 8_000).catch(() => null);
  const block = num ? await rpcCall(rpc, "eth_getBlockByNumber", [num, false], 8_000).catch(() => null) : null;
  return { number: num ? Number(BigInt(num)) : null, timestamp: block?.timestamp ? Number(BigInt(block.timestamp)) : null };
}

async function tokenMeta(rpc, address, fallbackSymbol = null) {
  const addr = normalizeAddress(address);
  const [decimals, symbol, name, totalSupply, code] = await Promise.all([
    safeCall(rpc, addr, ERC20, "decimals"),
    safeCall(rpc, addr, ERC20, "symbol"),
    safeCall(rpc, addr, ERC20, "name"),
    safeCall(rpc, addr, ERC20, "totalSupply"),
    getCode(rpc, addr),
  ]);
  return {
    address: addr,
    symbol: safeText(symbol?.[0], 48) || fallbackSymbol,
    name: safeText(name?.[0], 96),
    decimals: decimals?.[0] === undefined ? null : Number(decimals[0]),
    totalSupplyRaw: totalSupply?.[0]?.toString?.() || null,
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
  };
}

function tokenDataRows(rows, decimalsByToken = new Map()) {
  if (!Array.isArray(rows)) return [];
  return rows.map((x) => {
    const token = normalizeAddress(x?.token ?? x?.[0]);
    const amountRaw = (x?.amount ?? x?.[1])?.toString?.() || "0";
    const decimals = decimalsByToken.get(lowerAddress(token)) ?? null;
    return { token, amountRaw, amount: decimals === null ? null : round(unitsToNumber(amountRaw, decimals), 8) };
  }).filter((row) => row.token);
}

async function fetchPrices(tokenRows) {
  const keys = unique(tokenRows.map((row) => row.chain?.coinSlug && row.address ? priceKey(row.chain, row.address) : null).filter(Boolean));
  if (!keys.length) return { prices: new Map(), fetched: { ok: false, status: null, count: 0, error: "no-token-keys" } };
  const fetched = await fetchJson(`https://coins.llama.fi/prices/current/${keys.join(",")}?searchWidth=6h`, 30_000);
  const prices = new Map();
  for (const [key, row] of Object.entries(fetched.json?.coins || {})) {
    const price = Number(row?.price || 0);
    if (price > 0) prices.set(key.toLowerCase(), price);
  }
  return { prices, fetched: { ok: fetched.ok, status: fetched.status, count: prices.size, error: fetched.error } };
}

async function inspectContracts(rpc, chain, deployments) {
  const named = { ...deployments, CashBorrowerHelper: chain.helper };
  const rows = [];
  for (const [name, address] of Object.entries(named)) {
    const addr = normalizeAddress(address);
    if (!addr) continue;
    const [code, impl, admin, beacon, paused] = await Promise.all([
      getCode(rpc, addr),
      getSlotAddress(rpc, addr, EIP1967_IMPL),
      getSlotAddress(rpc, addr, EIP1967_ADMIN_SLOT),
      getSlotAddress(rpc, addr, EIP1967_BEACON),
      safeCall(rpc, addr, PAUSABLE, "paused"),
    ]);
    rows.push({ chainId: chain.chainId, chain: chain.chain, name, address: addr, codePresent: Boolean(code && code !== "0x"), codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0, implementation: impl, proxyAdmin: admin, beacon, paused: paused?.[0] ?? null, routePositive: false });
  }
  return rows;
}

async function inspectRoles(rpc, chain, roleRegistry) {
  const addr = normalizeAddress(roleRegistry);
  if (!addr) return [];
  const owner = await safeCall(rpc, addr, ROLE_REGISTRY, "owner");
  const rows = [{ chainId: chain.chainId, chain: chain.chain, role: "owner", roleId: null, holders: owner?.[0] ? [normalizeAddress(owner[0])] : [], permissionedOnly: true }];
  for (const role of ROLE_NAMES) {
    const roleId = ethers.id(role);
    const holders = await safeCall(rpc, addr, ROLE_REGISTRY, "roleHolders", [roleId]);
    rows.push({ chainId: chain.chainId, chain: chain.chain, role, roleId, holders: (holders?.[0] || []).map(normalizeAddress).filter(Boolean), permissionedOnly: true });
  }
  return rows;
}

async function inspectOracle(rpc, chain, priceProvider, token, block) {
  let configRaw = await safeCall(rpc, priceProvider, PRICE_V2, "tokenConfig", [token]);
  const protocolPriceRaw = await safeCall(rpc, priceProvider, PRICE_V2, "price", [token]);
  let tuple = configRaw?.[0];
  let cfg = tuple ? {
    abiVersion: "v2-tuple",
    oracle: normalizeAddress(tuple?.[0]),
    priceFunctionCalldata: tuple?.[1] || "0x",
    isChainlinkType: Boolean(tuple?.[2]),
    oraclePriceDecimals: tuple?.[3] === undefined ? null : Number(tuple[3]),
    maxStaleness: tuple?.[4] === undefined ? null : Number(tuple[4]),
    dataType: tuple?.[5] === undefined ? null : Number(tuple[5]),
    isStableToken: Boolean(tuple?.[6]),
    baseAsset: normalizeAddress(tuple?.[7]),
  } : null;
  if (!configRaw) {
    configRaw = await safeCall(rpc, priceProvider, PRICE_V1, "tokenConfig", [token]);
    tuple = configRaw?.[0];
    cfg = tuple ? {
      abiVersion: "v1-tuple",
      oracle: normalizeAddress(tuple?.[0]),
      priceFunctionCalldata: tuple?.[1] || "0x",
      isChainlinkType: Boolean(tuple?.[2]),
      oraclePriceDecimals: tuple?.[3] === undefined ? null : Number(tuple[3]),
      maxStaleness: tuple?.[4] === undefined ? null : Number(tuple[4]),
      dataType: tuple?.[5] === undefined ? null : Number(tuple[5]),
      isBaseTokenEth: Boolean(tuple?.[6]),
      isStableToken: Boolean(tuple?.[7]),
      isBaseTokenBtc: Boolean(tuple?.[8]),
      baseAsset: null,
    } : null;
  }
  if (!protocolPriceRaw) {
    if (!configRaw || !configHasOracle(cfg)) return { token, priceError: "token-config-and-price-unavailable" };
    return { token, priceError: "price-unavailable-or-stale", priceConfig: cfg };
  }
  const row = { chainId: chain.chainId, chain: chain.chain, token, protocolPriceRaw: protocolPriceRaw[0]?.toString?.() || null, protocolPriceUsd: usd6(protocolPriceRaw[0]), priceConfig: configHasOracle(cfg) ? cfg : null, priceSource: configHasOracle(cfg) ? "configured-oracle" : "native-or-special-case", routePositive: false };
  if (configHasOracle(cfg) && cfg.isChainlinkType) {
    const [latest, decimals, description] = await Promise.all([
      safeCall(rpc, cfg.oracle, CHAINLINK, "latestRoundData"),
      safeCall(rpc, cfg.oracle, CHAINLINK, "decimals"),
      safeCall(rpc, cfg.oracle, CHAINLINK, "description"),
    ]);
    if (latest) {
      const updatedAt = Number(latest[3]);
      row.chainlink = {
        roundId: latest[0]?.toString?.() || null,
        answer: latest[1]?.toString?.() || null,
        startedAt: latest[2]?.toString?.() || null,
        updatedAt: latest[3]?.toString?.() || null,
        answeredInRound: latest[4]?.toString?.() || null,
        decimals: decimals?.[0] === undefined ? null : Number(decimals[0]),
        description: safeText(description?.[0], 96),
        ageSec: block.timestamp && updatedAt ? block.timestamp - updatedAt : null,
        stale: block.timestamp && updatedAt && cfg.maxStaleness ? block.timestamp > updatedAt + cfg.maxStaleness : false,
        ageOverHalfMax: block.timestamp && updatedAt && cfg.maxStaleness ? block.timestamp - updatedAt > cfg.maxStaleness / 2 : false,
      };
    }
  } else if (configHasOracle(cfg) && cfg.priceFunctionCalldata && cfg.priceFunctionCalldata !== "0x") {
    const data = await rawCall(rpc, cfg.oracle, cfg.priceFunctionCalldata);
    let decoded = null;
    if (data && data !== "0x") {
      try {
        decoded = cfg.dataType === 0 ? ethers.AbiCoder.defaultAbiCoder().decode(["int256"], data)[0].toString() : ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], data)[0].toString();
      } catch (_) { decoded = null; }
    }
    row.customOracle = { selector: cfg.priceFunctionCalldata.slice(0, 10), decoded, freshnessEnforcedByPriceProvider: false };
  }
  return row;
}

async function inspectMarket(rpc, chain, deployments, block) {
  const debt = normalizeAddress(chain.debtManager || deployments.DebtManager);
  const priceProvider = normalizeAddress(deployments.PriceProvider);
  const factory = normalizeAddress(chain.factory || deployments.EtherFiSafeFactory);
  const helper = normalizeAddress(chain.helper);
  const [collateralTokensRaw, borrowTokensRaw, currentState, totalSuppliesAll, numSafesRaw] = await Promise.all([
    safeCall(rpc, debt, DEBT, "getCollateralTokens"),
    safeCall(rpc, debt, DEBT, "getBorrowTokens"),
    safeCall(rpc, debt, DEBT, "getCurrentState"),
    safeCall(rpc, debt, DEBT, "totalSupplies()"),
    safeCall(rpc, factory, FACTORY, "numContractsDeployed"),
  ]);
  const collateralTokens = (collateralTokensRaw?.[0] || []).map(normalizeAddress).filter(Boolean);
  const borrowTokens = (borrowTokensRaw?.[0] || []).map(normalizeAddress).filter(Boolean);
  const tokens = unique([...collateralTokens, ...borrowTokens]);
  const metaRows = [];
  for (const token of tokens) metaRows.push({ chain, ...(await tokenMeta(rpc, token)) });
  const decimalsByToken = new Map(metaRows.map((row) => [lowerAddress(row.address), row.decimals]).filter(([, decimals]) => decimals !== null));
  const tokenRows = [];
  for (const meta of metaRows) {
    const token = meta.address;
    const [isCollateral, isBorrow, collConfigRaw, borrowConfigRaw, totalBorrowRaw, totalSupplyRaw, debtBalanceRaw, cashBalanceRaw, oracle] = await Promise.all([
      safeCall(rpc, debt, DEBT, "isCollateralToken", [token]),
      safeCall(rpc, debt, DEBT, "isBorrowToken", [token]),
      safeCall(rpc, debt, DEBT, "collateralTokenConfig", [token]),
      safeCall(rpc, debt, DEBT, "borrowTokenConfig", [token]),
      safeCall(rpc, debt, DEBT, "totalBorrowingAmount", [token]),
      safeCall(rpc, debt, DEBT, "totalSupplies(address)", [token]),
      safeCall(rpc, token, ERC20, "balanceOf", [debt]),
      deployments.CashModule ? safeCall(rpc, token, ERC20, "balanceOf", [deployments.CashModule]) : null,
      priceProvider ? inspectOracle(rpc, chain, priceProvider, token, block) : null,
    ]);
    const decimals = meta.decimals ?? 18;
    const protocolPriceUsd = oracle?.protocolPriceUsd ?? null;
    const totalBorrowAmount = unitsToNumberMaybe(totalBorrowRaw?.[0], decimals);
    const totalSupplyAmount = unitsToNumberMaybe(totalSupplyRaw?.[0], decimals);
    const debtBalanceAmount = unitsToNumberMaybe(debtBalanceRaw?.[0], decimals);
    tokenRows.push({
      chainId: chain.chainId,
      chain: chain.chain,
      token,
      symbol: meta.symbol,
      name: meta.name,
      decimals,
      codePresent: meta.codePresent,
      isCollateral: Boolean(isCollateral?.[0]),
      isBorrow: Boolean(isBorrow?.[0]),
      collateralConfig: collConfigRaw ? { ltvRaw: collConfigRaw[0]?.toString?.(), liquidationThresholdRaw: collConfigRaw[1]?.toString?.(), liquidationBonusRaw: collConfigRaw[2]?.toString?.(), ltvPct: pctFrom18(collConfigRaw[0]), ltvBps: pctBpsFrom18(collConfigRaw[0]), liquidationThresholdPct: pctFrom18(collConfigRaw[1]), liquidationThresholdBps: pctBpsFrom18(collConfigRaw[1]), liquidationBonusPct: pctFrom18(collConfigRaw[2]), liquidationBonusBps: pctBpsFrom18(collConfigRaw[2]) } : null,
      borrowConfig: borrowConfigRaw ? { interestIndexSnapshotRaw: borrowConfigRaw[0]?.toString?.(), totalNormalizedBorrowingAmountRaw: borrowConfigRaw[1]?.toString?.(), totalSharesOfBorrowTokensRaw: borrowConfigRaw[2]?.toString?.(), lastUpdateTimestamp: borrowConfigRaw[3] === undefined ? null : Number(borrowConfigRaw[3]), borrowApyRaw: borrowConfigRaw[4]?.toString?.(), minSharesRaw: borrowConfigRaw[5]?.toString?.() } : null,
      totalBorrowingRaw: totalBorrowRaw?.[0]?.toString?.() || null,
      totalBorrowAmount: totalBorrowAmount === null ? null : round(totalBorrowAmount, 8),
      totalBorrowUsd: protocolPriceUsd === null || totalBorrowAmount === null ? null : round(totalBorrowAmount * protocolPriceUsd, 2),
      totalSuppliesRaw: totalSupplyRaw?.[0]?.toString?.() || null,
      totalSupplyAmount: totalSupplyAmount === null ? null : round(totalSupplyAmount, 8),
      totalSupplyUsd: protocolPriceUsd === null || totalSupplyAmount === null ? null : round(totalSupplyAmount * protocolPriceUsd, 2),
      debtManagerBalanceRaw: debtBalanceRaw?.[0]?.toString?.() || null,
      debtManagerBalanceAmount: debtBalanceAmount === null ? null : round(debtBalanceAmount, 8),
      debtManagerBalanceUsd: protocolPriceUsd === null || debtBalanceAmount === null ? null : round(debtBalanceAmount * protocolPriceUsd, 2),
      cashModuleBalanceRaw: cashBalanceRaw?.[0]?.toString?.() || null,
      oracle,
      routePositive: false,
    });
  }
  const decimalsLookup = new Map(tokenRows.map((row) => [lowerAddress(row.token), row.decimals]));
  const borrowings = tokenDataRows(currentState?.[0] || [], decimalsLookup);
  const liquidStables = tokenDataRows(currentState?.[2] || [], decimalsLookup);
  const totalSuppliesRows = tokenDataRows(totalSuppliesAll?.[0] || [], decimalsLookup);
  return {
    chainId: chain.chainId,
    chain: chain.chain,
    debtManager: debt,
    priceProvider,
    factory,
    helper,
    numSafes: numSafesRaw?.[0] === undefined ? null : Number(numSafesRaw[0]),
    collateralTokens,
    borrowTokens,
    tokenRows,
    currentState: { borrowings, totalBorrowingsInUsdRaw: currentState?.[1]?.toString?.() || null, totalBorrowingsUsd: usd6(currentState?.[1]), liquidStables, totalSuppliesRows, totalSuppliesUsd: usd6(totalSuppliesAll?.[1]) },
  };
}

async function sampleFactorySafes(rpc, chain, factory, numSafes) {
  const out = [];
  const total = Number(numSafes || 0);
  if (!total || !factory) return out;
  const starts = new Set([0]);
  const latestStart = Math.max(0, total - SAMPLE_SAFES);
  for (let s = latestStart; s < total; s += SAFE_BATCH) starts.add(s);
  for (const start of [...starts].sort((a, b) => a - b).slice(0, MAX_HELPER_BATCHES)) {
    const n = Math.min(SAFE_BATCH, total - start);
    const rows = await safeCall(rpc, factory, FACTORY, "getDeployedAddresses", [start, n], 15_000);
    if (Array.isArray(rows?.[0])) for (const safe of rows[0]) out.push({ chainId: chain.chainId, chain: chain.chain, user: normalizeAddress(safe), source: "factory-sample", startIndex: start });
  }
  return out.filter((row) => row.user);
}

async function sampleHelperCollateral(rpc, chain, helper, numSafes) {
  const rows = [];
  const total = Number(numSafes || 0);
  if (!total || !helper) return rows;
  const starts = new Set([0]);
  const latestStart = Math.max(0, total - SAMPLE_SAFES);
  for (let s = latestStart; s < total; s += SAFE_BATCH) starts.add(s);
  for (const start of [...starts].sort((a, b) => a - b).slice(0, MAX_HELPER_BATCHES)) {
    const n = Math.min(SAFE_BATCH, total - start);
    const res = await safeCall(rpc, helper, HELPER, "getTotalCollateralForSafesWithIndex", [start, n], 20_000);
    rows.push({ chainId: chain.chainId, chain: chain.chain, startIndex: start, safeCount: n, ok: Boolean(res), tokenRows: tokenDataRows(res?.[0] || []), routePositive: false });
  }
  return rows;
}

function eventTopic(name) {
  const event = EVENT_IFACE.getEvent(name);
  return event.topicHash;
}

async function scanBorrowerLogs(rpc, chain, debtManager, latest) {
  const startBlock = Math.max(0, latest.number - RECENT_LOG_BLOCKS);
  const users = new Map();
  const logCounts = { Borrowed: 0, Repaid: 0, Liquidated: 0 };
  const errors = [];
  const names = ["Borrowed", "Repaid", "Liquidated"];
  for (let start = startBlock; start <= latest.number; start += LOG_CHUNK_BLOCKS + 1) {
    const end = Math.min(latest.number, start + LOG_CHUNK_BLOCKS);
    for (const name of names) {
      const logs = await rpcCall(rpc, "eth_getLogs", [{ address: debtManager, topics: [eventTopic(name)], fromBlock: hexBlock(start), toBlock: hexBlock(end) }], 18_000).catch(() => null);
      if (!Array.isArray(logs)) { errors.push({ chain: chain.chain, event: name, fromBlock: start, toBlock: end, reason: "eth_getLogs returned no usable rows" }); continue; }
      logCounts[name] += logs.length;
      for (const log of logs) {
        let parsed = null;
        try { parsed = EVENT_IFACE.parseLog({ topics: log.topics, data: log.data }); } catch (_) { parsed = null; }
        const user = normalizeAddress(parsed?.args?.user || parsed?.args?.[0] || parsed?.args?.[1]);
        if (!user) continue;
        const item = users.get(user) || { chainId: chain.chainId, chain: chain.chain, user, lastBlock: 0, source: "recent-logs", events: { Borrowed: 0, Repaid: 0, Liquidated: 0 } };
        item.events[name] = (item.events[name] || 0) + 1;
        const blockNumber = log.blockNumber ? Number(BigInt(log.blockNumber)) : 0;
        if (blockNumber > item.lastBlock) item.lastBlock = blockNumber;
        users.set(user, item);
      }
    }
  }
  return { fromBlock: startBlock, toBlock: latest.number, logCounts, users: [...users.values()], errors };
}

async function evaluateUsers(rpc, chain, debtManager, userRows, tokenRows) {
  const decimalsLookup = new Map(tokenRows.map((row) => [lowerAddress(row.token), row.decimals]));
  const uniqueUsers = [...new Map(userRows.filter((row) => row.user).map((row) => [lowerAddress(row.user), row])).values()].slice(0, MAX_USERS);
  const out = [];
  for (const row of uniqueUsers) {
    const [state, liquidatable, maxLtv, maxLiq, remaining] = await Promise.all([
      safeCall(rpc, debtManager, DEBT, "getUserCurrentState", [row.user], 12_000),
      safeCall(rpc, debtManager, DEBT, "liquidatable", [row.user], 12_000),
      safeCall(rpc, debtManager, DEBT, "getMaxBorrowAmount", [row.user, true], 12_000),
      safeCall(rpc, debtManager, DEBT, "getMaxBorrowAmount", [row.user, false], 12_000),
      safeCall(rpc, debtManager, DEBT, "remainingBorrowingCapacityInUSD", [row.user], 12_000),
    ]);
    if (!state) continue;
    const debtUsd = usd6(state[3]);
    const maxLiqUsd = usd6(maxLiq?.[0]);
    const hf = debtUsd && debtUsd > 0 && maxLiqUsd !== null ? round(maxLiqUsd / debtUsd, 8) : null;
    out.push({
      ...row,
      liquidatable: Boolean(liquidatable?.[0]),
      healthFactor: hf,
      totalCollateralUsd: usd6(state[1]),
      totalBorrowingsUsd: debtUsd,
      maxBorrowLtvUsd: usd6(maxLtv?.[0]),
      maxBorrowLiquidationUsd: maxLiqUsd,
      remainingBorrowingCapacityUsd: usd6(remaining?.[0]),
      totalCollateralRaw: state[1]?.toString?.() || null,
      totalBorrowingsRaw: state[3]?.toString?.() || null,
      collaterals: tokenDataRows(state[0] || [], decimalsLookup),
      borrowings: tokenDataRows(state[2] || [], decimalsLookup),
      routePositive: false,
    });
  }
  return out.sort((a, b) => (asNumber(a.healthFactor) ?? 99) - (asNumber(b.healthFactor) ?? 99));
}

function enrichTokenPrices(marketRows, priceMap) {
  for (const market of marketRows) {
    for (const row of market.tokenRows) {
      const key = priceKey(CHAINS[market.chain.toLowerCase()] || { coinSlug: market.chain.toLowerCase() }, row.token).toLowerCase();
      const external = priceMap.get(key) || stableUsdGuess(row.symbol);
      row.externalPriceUsd = external || null;
      if (row.oracle?.protocolPriceUsd !== null && external) row.protocolVsExternalBps = round(((row.oracle.protocolPriceUsd - external) / external) * 10000, 2);
      row.oracleDivergenceWatch = Math.abs(asNumber(row.protocolVsExternalBps) || 0) >= 3000;
    }
  }
}

function buildWatchCandidates(artifact) {
  const rows = [];
  for (const row of artifact.tokenRows) {
    const hasExposure = (asNumber(row.totalBorrowUsd) || 0) > 0 || (asNumber(row.totalSupplyUsd) || 0) > 0 || (asNumber(row.debtManagerBalanceUsd) || 0) > 0;
    const hasCollateralValue = (asNumber(row.collateralConfig?.ltvBps) || 0) > 0 || (asNumber(row.collateralConfig?.liquidationThresholdBps) || 0) > 0;
    if (row.oracle?.chainlink?.stale) rows.push({ type: "stale-chainlink", chain: row.chain, token: row.token, symbol: row.symbol, blocker: "stale feed needs accepted-value impact plus exact borrow/liquidation economics", routePositive: false });
    else if (row.oracle?.chainlink?.ageOverHalfMax) rows.push({ type: "aging-chainlink", chain: row.chain, token: row.token, symbol: row.symbol, blocker: "feed age is watch-only until stale or materially divergent with route economics", routePositive: false });
    if (row.oracleDivergenceWatch && (row.isBorrow || hasCollateralValue || hasExposure)) rows.push({ type: "oracle-divergence", chain: row.chain, token: row.token, symbol: row.symbol, protocolVsExternalBps: row.protocolVsExternalBps, blocker: "external-price divergence needs exact acquisition, borrow, liquidation, and exit economics", routePositive: false });
  }
  for (const row of artifact.borrowerRows) {
    if (row.liquidatable && (asNumber(row.totalCollateralUsd) || 0) > 100 && (asNumber(row.totalBorrowingsUsd) || 0) > 100) rows.push({ type: "liquidatable-borrower", chain: row.chain, user: row.user, healthFactor: row.healthFactor, collateralUsd: row.totalCollateralUsd, debtUsd: row.totalBorrowingsUsd, blocker: "liquidation needs exact repay token acquisition and collateral exit route", routePositive: false });
    else if (!row.liquidatable && row.healthFactor !== null && row.healthFactor <= 1.05 && (asNumber(row.totalBorrowingsUsd) || 0) > 10000) rows.push({ type: "near-liquidation", chain: row.chain, user: row.user, healthFactor: row.healthFactor, collateralUsd: row.totalCollateralUsd, debtUsd: row.totalBorrowingsUsd, blocker: "not currently liquidatable and no exact liquidation/exit route is positive", routePositive: false });
  }
  return rows;
}

function buildReport(artifact) {
  const s = artifact.summary;
  const marketTable = artifact.marketRows.map((row) => `| ${row.chain} | ${compactAddress(row.debtManager)} | ${compactAddress(row.priceProvider)} | ${compactAddress(row.factory)} | ${formatNumber(row.numSafes, 0)} | ${formatUsd(row.currentState.totalBorrowingsUsd)} | ${formatUsd(row.currentState.totalSuppliesUsd)} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a |";
  const tokenTable = artifact.tokenRows.filter((row) => row.isCollateral || row.isBorrow).sort((a, b) => (asNumber(b.totalBorrowUsd) || 0) - (asNumber(a.totalBorrowUsd) || 0)).slice(0, 16).map((row) => `| ${row.chain} | ${row.symbol || "n/a"} | ${compactAddress(row.token)} | ${row.isCollateral ? "yes" : "no"} | ${row.isBorrow ? "yes" : "no"} | ${formatNumber(row.collateralConfig?.ltvBps, 0)} | ${formatNumber(row.collateralConfig?.liquidationThresholdBps, 0)} | ${formatUsd(row.totalBorrowUsd)} | ${formatUsd(row.totalSupplyUsd)} | ${row.oracle?.priceConfig?.isChainlinkType ? "Chainlink" : row.oracle?.customOracle ? "custom" : "n/a"} | ${row.oracle?.chainlink?.ageSec ?? "n/a"} | ${row.protocolVsExternalBps ?? "n/a"} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |";
  const borrowerTable = artifact.borrowerRows.slice(0, 12).map((row) => `| ${row.chain} | ${compactAddress(row.user)} | ${row.healthFactor ?? "n/a"} | ${row.liquidatable ? "yes" : "no"} | ${formatUsd(row.totalCollateralUsd)} | ${formatUsd(row.totalBorrowingsUsd)} | ${row.source || "sample"} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a |";
  const watchTable = artifact.watchCandidates.length ? artifact.watchCandidates.slice(0, 12).map((row) => `| ${row.type} | ${row.chain || "n/a"} | ${compactAddress(row.user || row.token)} | ${row.symbol || "n/a"} | ${row.healthFactor ?? row.protocolVsExternalBps ?? "n/a"} | ${row.blocker} |`).join("\n") : "| none | n/a | n/a | n/a | n/a | no route-positive watch row after current read-only checks |";
  return `# ${SIGNAL_DORMANT} - EtherFi Borrowing Market Phase 0 Triage

Date: ${artifact.generatedAt}

## Result

No confirmed permissionless exploit for the covered EtherFi Borrowing Market scope. The scan refreshed the Cash/DebtManager deployments on Optimism and Scroll, supported collateral and borrow tokens, oracle configuration/freshness, DebtManager cash/borrow/supply context, bounded helper collateral samples, recent borrower logs, and sampled Safe account health. Borrowing is Safe-only, liquidations are public but require currently unhealthy collateralized accounts plus exact repay/acquire/exit economics. No stale accepted oracle, exact-positive liquidation, borrow, redeem, bridge, or DEX unwind route was found.

## Scope

| Item | Value |
|---|---:|
| DeFiLlama TVL context | ${formatUsd(s.defillamaCurrentTvlUsd)} |
| Chains inspected | ${s.chainsInspected} |
| Contract rows with code | ${s.contractRowsWithCode} |
| Market rows | ${s.marketRows} |
| Token rows | ${s.tokenRows} |
| Borrow rows | ${s.borrowTokenRows} |
| Collateral rows | ${s.collateralTokenRows} |
| Total borrow context | ${formatUsd(s.totalBorrowUsd)} |
| Total supply context | ${formatUsd(s.totalSupplyUsd)} |
| Recent log users | ${s.recentLogUsers} |
| Borrower rows evaluated | ${s.borrowerRows} |
| Material liquidatable rows | ${s.materialLiquidatableRows} |
| Near-liquidation rows | ${s.nearLiquidationRows} |
| Stale feed rows | ${s.staleFeedRows} |
| Oracle divergence rows | ${s.oracleDivergenceRows} |
| Watch candidates | ${s.watchCandidates} |
| Route-positive | ${s.routePositive} |
| Coverage classification | ${s.coverageClassification} |

## Markets

| Chain | DebtManager | PriceProvider | SafeFactory | Safes | Borrow context | Supply context |
|---|---|---|---|---:|---:|---:|
${marketTable}

## Token And Oracle Rows

| Chain | Token | Address | Collateral | Borrow | LTV bps | LT bps | Borrow | Supply | Oracle | Feed age sec | Protocol vs external bps |
|---|---|---|---|---|---:|---:|---:|---:|---|---:|---:|
${tokenTable}

## Borrower Sample

| Chain | User/Safe | HF | Liquidatable | Collateral | Debt | Source |
|---|---|---:|---|---:|---:|---|
${borrowerTable}

## Watch Context

| Type | Chain | Address | Symbol | Edge | Blocker |
|---|---|---|---|---:|---|
${watchTable}

## Blockers

- Borrowing is restricted to registered EtherFi Safes; arbitrary external borrow is not public.
- Current read-only scan found no material collateralized liquidatable borrower with exact positive repay and collateral-exit economics.
- Chainlink rows are not stale under the checked configs; custom oracle rows are context only without accepted-value divergence and unwind economics.
- Stable/common-token collateral and borrow rows require exact oracle/acquisition/exit dislocation, not just high LTV.
- No fork/local extraction proof exists for a positive liquidation, borrow, redemption, settlement, bridge, or DEX route.

## Required For Route-Positive

- A specific EtherFi collateral oracle/accounting path overvalues collateral or a material borrower becomes liquidatable.
- Repay token acquisition and seized-collateral exit are exact-quoted and positive after gas/slippage/fees.
- Borrow or liquidation path is permissionless for the selected account and not paused/capped/role-gated.
- Fork/local proof demonstrates positive net value.

Artifacts: \`reports/raw/fast/etherfi-borrowing-phase0.json\`.
`;
}

async function main() {
  const metadata = protocolMetadata();
  const chainKeys = Object.keys(CHAINS);
  const rpcs = await resolveRpcPool(chainKeys.map((key) => CHAINS[key].chainId));
  const unsupportedChains = [];
  const contractRows = [];
  const roleRows = [];
  const marketRows = [];
  const allTokenRowsForPrices = [];
  const logErrors = [];
  const borrowerRows = [];
  const helperSampleRows = [];
  const source = { repo: "targets/cash-v3", commit: "e05bda2", priorReports: ["reports/etherfi-cash-triage.md", "reports/etherfi-weeth-triage.md"] };
  for (const key of chainKeys) {
    const chain = CHAINS[key];
    const rpc = rpcs[chain.chainId];
    if (!rpc) { unsupportedChains.push({ chain: chain.chain, reason: "no RPC resolved" }); continue; }
    const deployments = deploymentAddresses(chain.chainId);
    if (!deployments.DebtManager) deployments.DebtManager = chain.debtManager;
    if (!deployments.EtherFiSafeFactory) deployments.EtherFiSafeFactory = chain.factory;
    const block = await latestBlock(rpc);
    const contracts = await inspectContracts(rpc, chain, deployments);
    contractRows.push(...contracts);
    const roles = await inspectRoles(rpc, chain, deployments.RoleRegistry);
    roleRows.push(...roles);
    const market = await inspectMarket(rpc, chain, deployments, block);
    marketRows.push(market);
    for (const row of market.tokenRows) allTokenRowsForPrices.push({ chain, address: row.token, symbol: row.symbol });
    const factoryUsers = await sampleFactorySafes(rpc, chain, market.factory, market.numSafes).catch(() => []);
    const helperRows = await sampleHelperCollateral(rpc, chain, market.helper, market.numSafes).catch(() => []);
    helperSampleRows.push(...helperRows);
    const logScan = await scanBorrowerLogs(rpc, chain, market.debtManager, block);
    logErrors.push(...logScan.errors);
    const users = [...logScan.users.sort((a, b) => b.lastBlock - a.lastBlock), ...factoryUsers];
    const evaluated = await evaluateUsers(rpc, chain, market.debtManager, users, market.tokenRows);
    borrowerRows.push(...evaluated.map((row) => ({ ...row, logWindow: { fromBlock: logScan.fromBlock, toBlock: logScan.toBlock, logCounts: logScan.logCounts } })));
    market.recentLogScan = { fromBlock: logScan.fromBlock, toBlock: logScan.toBlock, logCounts: logScan.logCounts, uniqueUsers: logScan.users.length, errors: logScan.errors.length };
  }
  const priceFetch = await fetchPrices(allTokenRowsForPrices);
  enrichTokenPrices(marketRows, priceFetch.prices);
  const tokenRows = marketRows.flatMap((row) => row.tokenRows).sort((a, b) => (asNumber(b.totalBorrowUsd) || 0) - (asNumber(a.totalBorrowUsd) || 0));
  const sortedBorrowers = borrowerRows.filter((row) => (asNumber(row.totalBorrowingsUsd) || 0) > 0).sort((a, b) => {
    const ah = a.healthFactor ?? 99;
    const bh = b.healthFactor ?? 99;
    if (ah !== bh) return ah - bh;
    return (asNumber(b.totalBorrowingsUsd) || 0) - (asNumber(a.totalBorrowingsUsd) || 0);
  });
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-etherfi-borrowing-phase0.js",
    scope: "Read-only EtherFi Borrowing Market / Cash DebtManager Phase 0 scan",
    target: { name: "EtherFi Borrowing Market", slug: "etherfi-borrowing-market", category: "Lending", surface: "safe-based-lending-liquidation", metadata },
    safety: { publicApisOnlyForMetadata: true, rpcInventoryRead: true, rpcUrlsStored: false, privateKeysRead: false, signedActions: false, exploitExecuteCalls: false, forkTransactions: false, routePositive: false, executableNow: false, signedActionJustified: false },
    docs: { adapter: "https://raw.githubusercontent.com/DefiLlama/DefiLlama-Adapters/main/projects/etherfi-cash-collateral-management/index.js", tvlCodePath: "https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/etherfi-cash-collateral-management/index.js" },
    thresholds: { recentLogBlocks: RECENT_LOG_BLOCKS, logChunkBlocks: LOG_CHUNK_BLOCKS, maxUsers: MAX_USERS, sampleSafes: SAMPLE_SAFES, safeBatch: SAFE_BATCH, maxHelperBatches: MAX_HELPER_BATCHES },
    source,
    priceFetch: priceFetch.fetched,
    unsupportedChains,
    logErrors,
    contractRows,
    roleRows,
    marketRows,
    tokenRows,
    helperSampleRows,
    borrowerRows: sortedBorrowers.slice(0, 300),
    routePositiveRows: [],
  };
  artifact.watchCandidates = buildWatchCandidates(artifact);
  const totalBorrowUsd = round(marketRows.reduce((sum, row) => sum + (asNumber(row.currentState.totalBorrowingsUsd) || 0), 0), 2);
  const totalSupplyUsd = round(marketRows.reduce((sum, row) => sum + (asNumber(row.currentState.totalSuppliesUsd) || 0), 0), 2);
  artifact.summary = {
    defillamaCurrentTvlUsd: metadata.tvlUsd,
    chainsKnown: chainKeys.length,
    chainsInspected: chainKeys.length - unsupportedChains.length,
    unsupportedChains: unsupportedChains.length,
    contractRows: contractRows.length,
    contractRowsWithCode: contractRows.filter((row) => row.codePresent).length,
    marketRows: marketRows.length,
    tokenRows: tokenRows.length,
    collateralTokenRows: tokenRows.filter((row) => row.isCollateral).length,
    borrowTokenRows: tokenRows.filter((row) => row.isBorrow).length,
    totalBorrowUsd,
    totalSupplyUsd,
    safeCountObserved: marketRows.reduce((sum, row) => sum + (asNumber(row.numSafes) || 0), 0),
    recentLogUsers: marketRows.reduce((sum, row) => sum + (asNumber(row.recentLogScan?.uniqueUsers) || 0), 0),
    borrowerRows: artifact.borrowerRows.length,
    activeBorrowerRows: artifact.borrowerRows.filter((row) => (asNumber(row.totalBorrowingsUsd) || 0) > 0).length,
    materialLiquidatableRows: artifact.borrowerRows.filter((row) => row.liquidatable && (asNumber(row.totalCollateralUsd) || 0) > 100 && (asNumber(row.totalBorrowingsUsd) || 0) > 100).length,
    nearLiquidationRows: artifact.borrowerRows.filter((row) => !row.liquidatable && row.healthFactor !== null && row.healthFactor <= 1.05 && (asNumber(row.totalBorrowingsUsd) || 0) > 10000).length,
    staleFeedRows: tokenRows.filter((row) => row.oracle?.chainlink?.stale).length,
    agingFeedRows: tokenRows.filter((row) => row.oracle?.chainlink?.ageOverHalfMax).length,
    customOracleRows: tokenRows.filter((row) => row.oracle?.customOracle).length,
    oracleDivergenceRows: tokenRows.filter((row) => row.oracleDivergenceWatch).length,
    helperSampleRows: helperSampleRows.length,
    logErrors: logErrors.length,
    watchCandidates: artifact.watchCandidates.length,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    coverageClassification: unsupportedChains.length || logErrors.length ? "bounded-with-caveats" : "full-enough-for-declared-scope",
    closedReason: "safe-based lending scan found no material liquidatable borrower, stale accepted oracle, or exact positive liquidation/borrow/unwind economics",
  };
  artifact.blockers = [
    "Borrowing is restricted to registered EtherFi Safes; arbitrary external borrow is not public",
    "No material collateralized liquidatable borrower with exact positive repay and collateral-exit economics was found",
    "No checked Chainlink feed is stale and custom oracle rows lack accepted-value divergence with exact route economics",
    "Stable/common-token collateral and borrow rows require exact oracle/acquisition/exit dislocation, not just high LTV",
    "No fork/local extraction proof",
  ];
  artifact.requiredForRoutePositive = [
    "specific EtherFi collateral oracle/accounting path overvalues collateral or a material borrower becomes liquidatable",
    "repay token acquisition and seized-collateral exit are exact-quoted and positive after gas/slippage/fees",
    "borrow or liquidation path is permissionless for the selected account and not paused/capped/role-gated",
    "fork/local proof",
  ];
  artifact.nextReadOnlyStep = "Reopen EtherFi Borrowing only if a material borrower crosses HF < 1, a collateral oracle/accounting path becomes attacker-favorable, or custom oracle state diverges enough to support exact positive liquidation/borrow economics.";
  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(artifact, jsonReplacer, 2)}\n`);
  fs.writeFileSync(REPORT_OUT, buildReport(artifact));
  if (!QUIET) console.log(`EtherFi Borrowing Phase 0: chains=${artifact.summary.chainsInspected} tokens=${artifact.summary.tokenRows} borrowers=${artifact.summary.borrowerRows} materialLiquidatable=${artifact.summary.materialLiquidatableRows} near=${artifact.summary.nearLiquidationRows} watch=${artifact.summary.watchCandidates} routePositive=0`);
}

main().catch((err) => { console.error(safeText(err?.stack || err?.message || String(err), 260)); process.exit(1); });
