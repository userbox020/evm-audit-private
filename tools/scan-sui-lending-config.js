#!/usr/bin/env node
// scan-sui-lending-config.js - read-only Sui Move lending config decoder.
// Uses Sui JSON-RPC decoded Move object content; never prints or stores RPC URLs.

const fs = require("fs");
const path = require("path");

let SuiClient = null;
let Transaction = null;
let bcs = null;
const LOCAL_SUI_SDK = path.join(__dirname, "sui-scanner", "node_modules", "@mysten", "sui");
try { ({ SuiClient } = require(path.join(LOCAL_SUI_SDK, "client"))); } catch (_) {}
try { ({ Transaction } = require(path.join(LOCAL_SUI_SDK, "transactions"))); } catch (_) {}
try { ({ bcs } = require(path.join(LOCAL_SUI_SDK, "bcs"))); } catch (_) {}
try { if (!SuiClient) ({ SuiClient } = require("@mysten/sui/client")); } catch (_) {}
try { if (!Transaction) ({ Transaction } = require("@mysten/sui/transactions")); } catch (_) {}
try { if (!bcs) ({ bcs } = require("@mysten/sui/bcs")); } catch (_) {}

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const NAVI_ADDRESS_FILE = path.join(WORKSPACE, "targets", "navi-sdk", "src", "address.ts");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "sui-lending-config.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "sui-lending-config-triage.md");
const QUIET = process.argv.includes("--quiet");
const MAX_RESERVES = Number(process.env.SUI_LENDING_MAX_RESERVES || "60");
const MAX_USERS = Number(process.env.SUI_LENDING_MAX_USERS || "25");
const MAX_ACCOUNT_USERS = Number(process.env.SUI_LENDING_MAX_ACCOUNT_USERS || "8");
const MAX_BORROWER_RESERVES = Number(process.env.SUI_LENDING_MAX_BORROWER_RESERVES || "16");
const MAX_BORROWERS_PER_RESERVE = Number(process.env.SUI_LENDING_MAX_BORROWERS_PER_RESERVE || "25");
const MAX_DISCOVERED_BORROWERS = Number(process.env.SUI_LENDING_MAX_DISCOVERED_BORROWERS || "12");
const MAX_HEALTH_QUERY_USERS = Number(process.env.SUI_LENDING_MAX_HEALTH_QUERY_USERS || "12");
const MAX_LIQUIDATION_ECONOMICS_ROWS = Number(process.env.SUI_LENDING_MAX_LIQUIDATION_ECONOMICS_ROWS || "8");
const MAX_LIQUIDATION_EXIT_QUOTES = Number(process.env.SUI_LENDING_MAX_LIQUIDATION_EXIT_QUOTES || "4");
const LIQUIDATION_EXIT_SLIPPAGE_BPS = Number(process.env.SUI_LENDING_EXIT_SLIPPAGE_BPS || "100");
const LIQUIDATION_GAS_USD_ESTIMATE = Number(process.env.SUI_LENDING_GAS_USD_ESTIMATE || "0.25");
const SUI_RPC_RETRIES = Number(process.env.SUI_RPC_RETRIES || "2");
const INCLUDE_ORACLE_UPDATE_PRELUDE = /^(1|true|yes)$/i.test(process.env.SUI_LENDING_INCLUDE_ORACLE_UPDATE_PRELUDE || "");
const RAY = 10n ** 27n;
const NAVI_PUBLIC_POOLS_API = "https://open-api.naviprotocol.io/api/navi/pools";
const NAVI_PUBLIC_CONFIG_API = "https://open-api.naviprotocol.io/api/navi/config";
const NAVI_AGGREGATOR_API = "https://open-aggregator-api.naviprotocol.io/find_routes";

const FALLBACK_SCALLOP = {
  name: "Scallop",
  storageId: "0x07871c4b3c847a0f674b4a5c9a1a5a44e94f3c6c98ef8e7e6f52ec5bbecb3df0",
  source: "static-prior-artifact-id",
};

function exists(filePath) {
  try { return fs.existsSync(filePath); } catch (_) { return false; }
}

function readText(filePath, fallback = "") {
  try { return exists(filePath) ? fs.readFileSync(filePath, "utf8") : fallback; } catch (_) { return fallback; }
}

function rel(filePath) {
  return path.relative(WORKSPACE, filePath).replace(/\\/g, "/");
}

function normalizeObjectId(value) {
  const text = String(value || "").trim();
  return /^0x[a-fA-F0-9]{40,64}$/.test(text) ? text : null;
}

function asNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const n = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 2) {
  const n = asNumber(value);
  if (n === null) return null;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function asBigInt(value) {
  if (value === null || value === undefined || value === "") return null;
  try {
    if (typeof value === "bigint") return value;
    if (typeof value === "number") return Number.isFinite(value) ? BigInt(Math.trunc(value)) : null;
    const text = String(value).trim();
    if (!/^-?\d+$/.test(text)) return null;
    return BigInt(text);
  } catch (_) {
    return null;
  }
}

function rawString(value) {
  const n = asBigInt(value);
  return n === null ? null : n.toString();
}

function rawPositive(value) {
  const n = asBigInt(value);
  return n !== null && n > 0n;
}

function rawZero(value) {
  const n = asBigInt(value);
  return n !== null && n === 0n;
}

function rawAbs(value) {
  const n = asBigInt(value);
  if (n === null) return null;
  return (n < 0n ? -n : n).toString();
}

function getPath(value, parts) {
  return (parts || []).reduce((acc, key) => (acc && typeof acc === "object" ? acc[key] : undefined), value);
}

function rayToBps(value) {
  const n = asBigInt(value);
  if (n === null) return null;
  return Number((n * 10_000n) / RAY);
}

function ratioBps(numerator, denominator) {
  const n = asBigInt(numerator);
  const d = asBigInt(denominator);
  if (n === null || d === null || d <= 0n) return null;
  return Number((n * 10_000n) / d);
}

function rawDifference(a, b) {
  const left = asBigInt(a);
  const right = asBigInt(b);
  if (left === null || right === null) return null;
  return (left - right).toString();
}

function rawCompare(a, b) {
  const left = asBigInt(a);
  const right = asBigInt(b);
  if (left === null || right === null) return null;
  return left < right ? -1 : left > right ? 1 : 0;
}

function decimalFromRay(value, decimals = 6) {
  let n = asBigInt(value);
  if (n === null) return null;
  const negative = n < 0n;
  if (negative) n = -n;
  const scale = 10n ** BigInt(decimals);
  const whole = n / RAY;
  const fraction = ((n % RAY) * scale) / RAY;
  const fractionText = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toString()}${fractionText ? `.${fractionText}` : ""}`;
}

function rawMulDiv(value, multiplier, divisor = RAY, roundUp = false) {
  const n = asBigInt(value);
  const m = asBigInt(multiplier);
  const d = asBigInt(divisor);
  if (n === null || m === null || d === null || d <= 0n) return null;
  const product = n * m;
  return ((product + (roundUp ? d - 1n : 0n)) / d).toString();
}

function rawAmountToNumber(raw, decimals) {
  const n = asBigInt(raw);
  const d = asNumber(decimals);
  if (n === null || d === null || d < 0 || d > 30) return null;
  return Number(n) / (10 ** d);
}

function amountToRawFloor(amount, decimals) {
  const n = asNumber(amount);
  const d = asNumber(decimals);
  if (n === null || d === null || d < 0 || d > 18 || n <= 0) return null;
  try {
    return BigInt(Math.floor(n * (10 ** d))).toString();
  } catch (_) {
    return null;
  }
}

function roundUsd(value) {
  const n = asNumber(value);
  if (n === null) return null;
  return Math.round(n * 1_000_000) / 1_000_000;
}

function bpsFromRay(value) {
  const n = asBigInt(value);
  if (n === null) return null;
  const raw = (n * 10_000n) / RAY;
  if (raw > BigInt(Number.MAX_SAFE_INTEGER) || raw < BigInt(Number.MIN_SAFE_INTEGER)) return null;
  return Number(raw);
}

function bytesLeToBigInt(bytes) {
  let n = 0n;
  const arr = Array.from(bytes || []);
  for (let i = 0; i < arr.length; i += 1) n += BigInt(arr[i]) << (8n * BigInt(i));
  return n;
}

function decodeBcsU256(returnValue) {
  const bytes = returnValue?.[0];
  if (!Array.isArray(bytes) && !(bytes instanceof Uint8Array)) return null;
  const arr = Uint8Array.from(bytes);
  try {
    return bcs?.u256 ? bcs.u256().parse(arr).toString() : bytesLeToBigInt(arr).toString();
  } catch (_) {
    return bytesLeToBigInt(arr).toString();
  }
}

function shortRaw(value) {
  const text = String(value ?? "n/a");
  if (text.length <= 12) return text;
  return `${text.slice(0, 8)}...${text.slice(-4)}`;
}

function readRpcCandidates() {
  const text = readText(RPC_FILE);
  const candidates = [];
  let suiLabelWindow = 0;
  for (const line of text.split(/\r?\n/)) {
    if (/sui/i.test(line)) suiLabelWindow = 3;
    const urls = [...line.matchAll(/https?:\/\/[^\s'"<>]+/g)].map((match) => match[0]);
    for (const url of urls) {
      candidates.push({ url, preferred: /sui/i.test(line) || suiLabelWindow > 0 || /sui/i.test(url) });
    }
    if (suiLabelWindow > 0) suiLabelWindow -= 1;
  }
  candidates.push({ url: "https://fullnode.mainnet.sui.io:443", preferred: false, publicFallback: true });
  return candidates;
}

async function resolveSuiRpcUrl() {
  const candidates = readRpcCandidates();
  const probeObjectId = parseNaviSdkConfig().storageId || FALLBACK_SCALLOP.storageId;
  const ordered = [
    ...candidates.filter((entry) => entry.preferred),
    ...candidates.filter((entry) => !entry.preferred),
  ];
  const seen = new Set();
  for (const entry of ordered) {
    if (!entry.url || seen.has(entry.url)) continue;
    seen.add(entry.url);
    try {
      const state = await suiCall(entry.url, "suix_getLatestSuiSystemState", [], 8000);
      if (!state?.epoch) throw new Error("missing Sui epoch");
      const probe = await suiCall(entry.url, "sui_getObject", [probeObjectId, { showType: true }], 8000);
      if (!probe?.data?.type) throw new Error("missing Sui object probe");
      return entry.url;
    } catch (_) {
      // Never print or persist RPC URLs.
    }
  }
  return null;
}

async function suiCall(rpcUrl, method, params = [], timeoutMs = 20_000) {
  let lastError = null;
  for (let attempt = 0; attempt <= SUI_RPC_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: controller.signal,
      });
      const text = await response.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch (_) {
        throw new Error(`non-json rpc response (${response.status})`);
      }
      if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
      return json.result;
    } catch (error) {
      lastError = error;
      if (attempt < SUI_RPC_RETRIES) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

async function fetchDynamicFields(rpcUrl, parentObjectId, limit = 100) {
  if (!parentObjectId) return [];
  const rows = [];
  let cursor = null;
  while (rows.length < limit) {
    const page = await suiCall(rpcUrl, "suix_getDynamicFields", [parentObjectId, cursor, Math.min(50, limit - rows.length)]);
    rows.push(...(page?.data || []));
    if (!page?.hasNextPage || !page?.nextCursor) break;
    cursor = page.nextCursor;
  }
  return rows;
}

async function fetchDynamicFieldValue(rpcUrl, parentObjectId, nameType, nameValue) {
  if (!parentObjectId || !nameType || nameValue === null || nameValue === undefined) return null;
  try {
    const obj = await suiCall(rpcUrl, "suix_getDynamicFieldObject", [parentObjectId, { type: nameType, value: String(nameValue) }], 12_000);
    return rawString(obj?.data?.content?.fields?.value);
  } catch (_) {
    return null;
  }
}

async function fetchDynamicFieldObjectSummary(rpcUrl, parentObjectId, nameType, nameValue, role) {
  if (!parentObjectId || !nameType || nameValue === null || nameValue === undefined) return null;
  try {
    const obj = await suiCall(rpcUrl, "suix_getDynamicFieldObject", [parentObjectId, { type: nameType, value: String(nameValue) }], 12_000);
    const objectId = obj?.data?.objectId || obj?.data?.object_id || null;
    return {
      role,
      nameType,
      nameValue: String(nameValue),
      objectId,
      decoded: objectSummary(objectId, obj),
    };
  } catch (error) {
    return {
      role,
      nameType,
      nameValue: String(nameValue),
      objectId: null,
      decoded: { exists: false, error: String(error?.message || error).slice(0, 180) },
    };
  }
}

async function fetchPublicJson(url, timeoutMs = 12_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: "GET", signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchNaviPublicPools() {
  try {
    const json = await fetchPublicJson(NAVI_PUBLIC_POOLS_API);
    return Array.isArray(json?.data) ? json.data : [];
  } catch (error) {
    return { error: String(error?.message || error).slice(0, 180), rows: [] };
  }
}

async function fetchNaviPublicConfig() {
  try {
    const json = await fetchPublicJson(NAVI_PUBLIC_CONFIG_API);
    return json?.data && typeof json.data === "object" ? json.data : null;
  } catch (error) {
    return { error: String(error?.message || error).slice(0, 180) };
  }
}

function quotedValue(text, key) {
  const re = new RegExp(`${key}\\s*:\\s*\\n?\\s*["'](0x[a-fA-F0-9]+)["']`, "m");
  return normalizeObjectId(text.match(re)?.[1]);
}

function parseOracleProConfig(text) {
  const start = text.indexOf("export const OracleProConfig");
  const body = start >= 0 ? text.slice(start, text.indexOf("export const ProFundsPoolInfo", start) >= 0 ? text.indexOf("export const ProFundsPoolInfo", start) : undefined) : text;
  return {
    packageId: quotedValue(body, "PackageId"),
    priceOracle: quotedValue(body, "PriceOracle"),
    oracleConfig: quotedValue(body, "OracleConfig"),
    supraOracleHolder: quotedValue(body, "SupraOracleHolder"),
  };
}

function parsePriceFeedConfigs(text) {
  const start = text.indexOf("export const PriceFeedConfig");
  const end = text.indexOf("export interface IOracleProConfig", start >= 0 ? start : 0);
  const section = start >= 0 ? text.slice(start, end >= 0 ? end : undefined) : "";
  const bodyStart = section.indexOf("= {");
  const body = bodyStart >= 0 ? section.slice(bodyStart + 3) : section;
  const rows = [];
  const rowRe = /([A-Za-z0-9_]+)\s*:\s*\{([\s\S]*?)\n\s*\},/g;
  for (const match of body.matchAll(rowRe)) {
    const rowBody = match[2];
    const oracleId = asNumber(rowBody.match(/oracleId\s*:\s*(\d+)/)?.[1]);
    const feedId = normalizeObjectId(rowBody.match(/feedId\s*:\s*\n?\s*["'](0x[a-fA-F0-9]+)["']/)?.[1]);
    const pythPriceInfoObject = normalizeObjectId(rowBody.match(/pythPriceInfoObject\s*:\s*\n?\s*["'](0x[a-fA-F0-9]+)["']/)?.[1]);
    if (oracleId !== null && feedId && pythPriceInfoObject) rows.push({ key: match[1], oracleId, feedId, pythPriceInfoObject });
  }
  return rows;
}

function parseCoinInfoConfigs(text) {
  const rows = [];
  const re = /export const\s+([A-Za-z0-9_]+)\s*:\s*CoinInfo\s*=\s*\{([\s\S]*?)\n\s*\};/g;
  for (const match of text.matchAll(re)) {
    const body = match[2];
    const symbol = body.match(/symbol\s*:\s*["']([^"']+)["']/)?.[1] || match[1];
    const address = body.match(/address\s*:\s*\n?\s*["']([^"']+)["']/)?.[1] || null;
    const decimal = asNumber(body.match(/decimal\s*:\s*(\d+)/)?.[1]);
    if (symbol && address && decimal !== null) rows.push({ key: match[1], symbol, address, decimal });
  }
  return rows;
}

function mergeNaviPublicConfig(config, publicConfigResult) {
  const data = publicConfigResult && !publicConfigResult.error ? publicConfigResult : null;
  if (!data) return config;
  const oracle = data.oracle || {};
  const feeds = Array.isArray(oracle.feeds) ? oracle.feeds : [];
  return {
    ...config,
    protocolPackage: normalizeObjectId(data.package) || config.protocolPackage,
    storageId: normalizeObjectId(data.storage) || config.storageId,
    priceOracle: normalizeObjectId(data.priceOracle) || normalizeObjectId(oracle.priceOracle) || config.priceOracle,
    reserveParentId: normalizeObjectId(data.reserveParentId) || config.reserveParentId,
    uiGetter: normalizeObjectId(data.uiGetter) || config.uiGetter,
    flashloanConfig: normalizeObjectId(data.flashloanConfig) || config.flashloanConfig,
    flashloanSupportedAssets: normalizeObjectId(data.flashloanSupportedAssets) || config.flashloanSupportedAssets,
    oracleProConfig: {
      ...config.oracleProConfig,
      packageId: normalizeObjectId(oracle.packageId) || config.oracleProConfig?.packageId,
      priceOracle: normalizeObjectId(oracle.priceOracle) || config.oracleProConfig?.priceOracle,
      oracleConfig: normalizeObjectId(oracle.oracleConfig) || config.oracleProConfig?.oracleConfig,
      supraOracleHolder: normalizeObjectId(oracle.supraOracleHolder) || config.oracleProConfig?.supraOracleHolder,
    },
    priceFeedConfigs: feeds.length > 0 ? feeds.map((feed) => ({
      key: `oracle-${feed.oracleId}`,
      oracleId: asNumber(feed.oracleId),
      assetId: asNumber(feed.assetId),
      feedId: normalizeObjectId(feed.feedId),
      pythPriceInfoObject: normalizeObjectId(feed.pythPriceInfoObject),
      priceDecimal: asNumber(feed.priceDecimal),
    })).filter((feed) => feed.oracleId !== null && feed.feedId && feed.pythPriceInfoObject) : config.priceFeedConfigs,
    publicConfigMeta: {
      source: "open-api.naviprotocol.io/api/navi/config",
      fetched: true,
      package: normalizeObjectId(data.package) || null,
      uiGetter: normalizeObjectId(data.uiGetter) || null,
      oraclePackageId: normalizeObjectId(oracle.packageId) || null,
      oracleFeedRows: feeds.length,
    },
  };
}

function parseNaviSdkConfig() {
  const text = readText(NAVI_ADDRESS_FILE);
  const coinInfos = parseCoinInfoConfigs(text);
  const coinByAddress = new Map(coinInfos.map((row) => [row.address, row]));
  const coinBySymbol = new Map(coinInfos.flatMap((row) => [[row.symbol, row], [row.key, row]]));
  const config = {
    source: rel(NAVI_ADDRESS_FILE),
    protocolPackage: quotedValue(text, "ProtocolPackage") || quotedValue(text, "defaultProtocolPackage"),
    storageId: quotedValue(text, "StorageId"),
    priceOracle: quotedValue(text, "PriceOracle"),
    reserveParentId: quotedValue(text, "ReserveParentId"),
    uiGetter: quotedValue(text, "uiGetter"),
    flashloanConfig: quotedValue(text, "flashloanConfig"),
    flashloanSupportedAssets: quotedValue(text, "flashloanSupportedAssets"),
    oracleProConfig: parseOracleProConfig(text),
    priceFeedConfigs: parsePriceFeedConfigs(text),
    coinInfos,
    pools: [],
  };
  const poolStart = text.indexOf("export const pool");
  const poolText = poolStart >= 0 ? text.slice(poolStart) : text;
  const rowRe = /([A-Za-z0-9_]+)\s*:\s*\{([\s\S]*?)\n\s*\},/g;
  for (const match of poolText.matchAll(rowRe)) {
    const symbolKey = match[1];
    const body = match[2];
    const row = {
      symbolKey,
      name: body.match(/name\s*:\s*["']([^"']+)["']/)?.[1] || symbolKey,
      assetId: asNumber(body.match(/assetId\s*:\s*(\d+)/)?.[1]),
      poolId: normalizeObjectId(body.match(/poolId\s*:\s*\n?\s*["'](0x[a-fA-F0-9]+)["']/)?.[1]),
      type: body.match(/type\s*:\s*["']([^"']+)["']/)?.[1] || null,
      reserveObjectId: normalizeObjectId(body.match(/reserveObjectId\s*:\s*\n?\s*["'](0x[a-fA-F0-9]+)["']/)?.[1]),
      borrowBalanceParentId: normalizeObjectId(body.match(/borrowBalanceParentId\s*:\s*\n?\s*["'](0x[a-fA-F0-9]+)["']/)?.[1]),
      supplyBalanceParentId: normalizeObjectId(body.match(/supplyBalanceParentId\s*:\s*\n?\s*["'](0x[a-fA-F0-9]+)["']/)?.[1]),
      rewardFundId: normalizeObjectId(body.match(/rewardFundId\s*:\s*\n?\s*["'](0x[a-fA-F0-9]+)["']/)?.[1]),
    };
    const coin = coinByAddress.get(row.type) || coinBySymbol.get(symbolKey) || coinBySymbol.get(row.name) || null;
    row.coinSymbol = coin?.symbol || null;
    row.decimal = coin?.decimal ?? null;
    if (row.reserveObjectId || row.poolId) config.pools.push(row);
  }
  return config;
}

function sampleValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return String(value).slice(0, 140);
  if (Array.isArray(value)) return `array[${value.length}]`;
  if (value.type && value.fields) return `moveObject:${value.type}`;
  if (value.id?.id) return value.id.id;
  return JSON.stringify(value).slice(0, 180);
}

function extractTableIds(fields) {
  const ids = {};
  for (const [key, value] of Object.entries(fields || {})) {
    const tableId = value?.fields?.id?.id;
    if (tableId && /^0x[a-fA-F0-9]{40,64}$/.test(tableId)) ids[key] = tableId;
  }
  return ids;
}

function extractReserveMetrics(fields) {
  const reserve = fields?.value?.fields;
  if (!reserve || typeof reserve !== "object") return null;
  const borrowRaw = rawString(getPath(reserve, ["borrow_balance", "fields", "total_supply"]));
  const supplyRaw = rawString(getPath(reserve, ["supply_balance", "fields", "total_supply"]));
  const currentBorrowIndexRaw = rawString(reserve.current_borrow_index);
  const currentSupplyIndexRaw = rawString(reserve.current_supply_index);
  const borrowUserStateTableId = getPath(reserve, ["borrow_balance", "fields", "user_state", "fields", "id", "id"]) || null;
  const supplyUserStateTableId = getPath(reserve, ["supply_balance", "fields", "user_state", "fields", "id", "id"]) || null;
  const availableRawApprox = rawDifference(supplyRaw, borrowRaw);
  const ltvBps = rayToBps(reserve.ltv);
  const thresholdBps = rayToBps(getPath(reserve, ["liquidation_factors", "fields", "threshold"]));
  if (borrowRaw === null && supplyRaw === null && ltvBps === null && thresholdBps === null) return null;
  const borrowCapRaw = rawString(reserve.borrow_cap_ceiling);
  const supplyCapRaw = rawString(reserve.supply_cap_ceiling);
  return {
    oracleId: asNumber(reserve.oracle_id),
    ltvBps,
    liquidationThresholdBps: thresholdBps,
    liquidationBonusBps: rayToBps(getPath(reserve, ["liquidation_factors", "fields", "bonus"])),
    liquidationRatioBps: rayToBps(getPath(reserve, ["liquidation_factors", "fields", "ratio"])),
    borrowRaw,
    supplyRaw,
    currentBorrowIndexRaw,
    currentSupplyIndexRaw,
    borrowUserStateTableId,
    supplyUserStateTableId,
    availableLiquidityRawApprox: availableRawApprox,
    utilizationBpsApprox: ratioBps(borrowRaw, supplyRaw),
    borrowCapRaw,
    supplyCapRaw,
    borrowCapZero: rawZero(borrowCapRaw),
    supplyCapZero: rawZero(supplyCapRaw),
    collateralEnabledHint: (ltvBps || 0) > 0,
    borrowLiquidityHint: rawPositive(availableRawApprox),
  };
}

function extractOracleMetrics(fields) {
  if (!fields || extractReserveMetrics(fields)) return null;
  const hints = flatten(fields)
    .filter((entry) => /price|oracle|pyth|switchboard|supra|feed|confidence|decimal|expo|publish|updated|timestamp|time|stale|delay/i.test(entry.path))
    .slice(0, 24)
    .map((entry) => ({ path: entry.path, value: sampleValue(entry.value) }));
  if (!hints.length) return null;
  return {
    priceHintRows: hints.filter((hint) => /price|confidence|decimal|expo/i.test(hint.path)).length,
    updateHintRows: hints.filter((hint) => /publish|updated|timestamp|time|stale|delay/i.test(hint.path)).length,
    sampleHints: hints.slice(0, 8),
  };
}

function extractFlashloanMetrics(fields) {
  if (!fields || extractReserveMetrics(fields) || extractOracleMetrics(fields)) return null;
  const value = fields?.value?.fields || fields?.value || {};
  const assetId = asNumber(value.asset_id ?? value.assetId);
  const poolId = normalizeObjectId(value.pool_id ?? value.poolId);
  const coinTypeRaw = value.coin_type ?? value.coinType ?? null;
  const rateToSupplier = asNumber(value.rate_to_supplier ?? value.rateToSupplier);
  const rateToTreasury = asNumber(value.rate_to_treasury ?? value.rateToTreasury);
  const max = rawString(value.max);
  const min = rawString(value.min);
  if (assetId === null && !poolId && !coinTypeRaw && rateToSupplier === null && rateToTreasury === null && !max && !min) return null;
  return {
    assetId,
    poolId,
    coinType: coinTypeRaw ? (String(coinTypeRaw).startsWith("0x") ? String(coinTypeRaw) : `0x${coinTypeRaw}`) : null,
    minRaw: min,
    maxRaw: max,
    rateToSupplierBpsHint: rateToSupplier,
    rateToTreasuryBpsHint: rateToTreasury,
    totalFeeBpsHint: rateToSupplier !== null || rateToTreasury !== null ? (rateToSupplier || 0) + (rateToTreasury || 0) : null,
  };
}

function extractUserMetrics(fields) {
  if (!fields || extractReserveMetrics(fields) || extractOracleMetrics(fields) || extractFlashloanMetrics(fields)) return null;
  const collaterals = Array.isArray(getPath(fields, ["value", "fields", "collaterals"]))
    ? getPath(fields, ["value", "fields", "collaterals"]).map((value) => asNumber(value)).filter((value) => value !== null)
    : [];
  const hints = flatten(fields)
    .filter((entry) => /asset|borrow|supply|collateral|debt|balance|health|ltv|liquid/i.test(entry.path))
    .slice(0, 24)
    .map((entry) => ({ path: entry.path, value: sampleValue(entry.value) }));
  if (!hints.length) return null;
  return {
    collaterals,
    collateralCount: collaterals.length,
    positionHintRows: hints.length,
    borrowHintRows: hints.filter((hint) => /borrow|debt/i.test(hint.path)).length,
    supplyHintRows: hints.filter((hint) => /supply|collateral/i.test(hint.path)).length,
    sampleHints: hints.slice(0, 8),
  };
}

function flatten(value, prefix = "", out = [], depth = 0) {
  if (out.length >= 80 || depth > 5 || value === null || value === undefined) return out;
  if (typeof value !== "object") {
    out.push({ path: prefix, value });
    return out;
  }
  if (Array.isArray(value)) {
    out.push({ path: prefix, value: `array[${value.length}]` });
    for (let i = 0; i < Math.min(value.length, 3); i++) flatten(value[i], `${prefix}[${i}]`, out, depth + 1);
    return out;
  }
  for (const [key, nested] of Object.entries(value)) {
    const next = prefix ? `${prefix}.${key}` : key;
    if (typeof nested === "object" && nested !== null) flatten(nested, next, out, depth + 1);
    else out.push({ path: next, value: nested });
    if (out.length >= 80) break;
  }
  return out;
}

function riskHints(fields) {
  return flatten(fields)
    .filter((entry) => /ltv|collateral|liquid|borrow|supply|cap|pause|oracle|pyth|switchboard|supra|threshold|stale|delay|max|min|factor|ratio|price|fee/i.test(entry.path))
    .slice(0, 24)
    .map((entry) => ({ path: entry.path, value: sampleValue(entry.value) }));
}

function objectSummary(objectId, obj) {
  const data = obj?.data || null;
  const content = data?.content || null;
  const fields = content?.dataType === "moveObject" ? content.fields || {} : null;
  const keys = fields ? Object.keys(fields) : [];
  const fieldsSample = {};
  for (const key of keys.slice(0, 14)) fieldsSample[key] = sampleValue(fields[key]);
  return {
    objectId,
    exists: Boolean(data),
    version: data?.version || null,
    digest: data?.digest || null,
    objectType: data?.type || null,
    contentDataType: content?.dataType || null,
    tableIds: fields ? extractTableIds(fields) : {},
    fieldKeys: keys.slice(0, 40),
    fieldsSample,
    dynamicFieldValueRaw: fields ? rawString(fields.value) : null,
    reserveMetrics: fields ? extractReserveMetrics(fields) : null,
    oracleMetrics: fields ? extractOracleMetrics(fields) : null,
    flashloanMetrics: fields ? extractFlashloanMetrics(fields) : null,
    userMetrics: fields ? extractUserMetrics(fields) : null,
    riskHints: fields ? riskHints(fields) : [],
  };
}

function dynamicFieldNameValue(row) {
  const value = row?.name?.value ?? row?.name?.fields?.name ?? row?.name?.fields?.id ?? null;
  if (value === null || value === undefined) return null;
  return String(value);
}

async function fetchDynamicFieldObjectRows(rpcUrl, parentObjectId, role, limit = 100) {
  const fields = await fetchDynamicFields(rpcUrl, parentObjectId, limit);
  const rows = [];
  for (const field of fields) {
    const objectId = field.objectId || field.objectIdHex || field.digest || null;
    rows.push({
      role,
      nameType: field.name?.type || null,
      nameValue: dynamicFieldNameValue(field),
      objectId,
      decoded: await fetchObject(rpcUrl, objectId),
    });
  }
  return rows;
}

async function fetchObject(rpcUrl, objectId) {
  if (!objectId) return null;
  try {
    const obj = await suiCall(rpcUrl, "sui_getObject", [objectId, { showType: true, showContent: true, showOwner: true }]);
    return objectSummary(objectId, obj);
  } catch (error) {
    return { objectId, exists: false, error: String(error?.message || error).slice(0, 180) };
  }
}

function rowHasHint(row, pattern) {
  return (row.decoded?.riskHints || []).some((hint) => pattern.test(hint.path) || pattern.test(String(hint.value || "")));
}

function apiPoolTimestampAgeMs(timestamp) {
  const n = asNumber(timestamp);
  if (n === null || n <= 0) return null;
  const ms = n > 10_000_000_000 ? n : n * 1000;
  return Math.max(0, Math.round(Date.now() - ms));
}

function normalizeApiPools(apiPools) {
  const rows = Array.isArray(apiPools) ? apiPools : [];
  return rows.map((row) => ({
    id: asNumber(row.id),
    oracleId: asNumber(row.oracleId ?? row.oracle?.oracleId),
    coinType: row.coinType || null,
    ltv: row.ltv ?? null,
    lastUpdateTimestamp: row.lastUpdateTimestamp ?? null,
    lastUpdateAgeMs: apiPoolTimestampAgeMs(row.lastUpdateTimestamp),
    totalSupplyAmount: row.totalSupplyAmount ?? null,
    borrowedAmount: row.borrowedAmount ?? null,
    currentSupplyIndex: row.currentSupplyIndex ?? row.current_supply_index ?? null,
    currentBorrowIndex: row.currentBorrowIndex ?? row.current_borrow_index ?? null,
    leftBorrowAmount: row.leftBorrowAmount ?? null,
    availableBorrow: row.availableBorrow ?? null,
    validBorrowAmount: row.validBorrowAmount ?? null,
    oraclePrice: row.oracle?.price ?? row.oracle?.value ?? null,
    oracleDecimal: asNumber(row.oracle?.decimal),
    oracleValid: row.oracle?.valid === true,
  }));
}

function buildReserveOracleLiquidityRows(reserveRows, oracleRows, apiPoolRows = []) {
  const oracleById = new Map();
  for (const oracle of oracleRows || []) {
    if (oracle.nameValue !== null && oracle.nameValue !== undefined) oracleById.set(String(oracle.nameValue), oracle);
  }
  const apiByAssetId = new Map(apiPoolRows.filter((row) => row.id !== null).map((row) => [String(row.id), row]));
  const apiByOracleId = new Map(apiPoolRows.filter((row) => row.oracleId !== null).map((row) => [String(row.oracleId), row]));
  return (reserveRows || []).map((row) => {
    const metrics = row.decoded?.reserveMetrics || {};
    const oracle = metrics.oracleId !== null && metrics.oracleId !== undefined ? oracleById.get(String(metrics.oracleId)) : null;
    const apiPool = apiByAssetId.get(String(row.assetId)) || apiByOracleId.get(String(metrics.oracleId)) || null;
    const blockers = [];
    if (!row.decoded?.objectType) blockers.push("reserve object not decoded");
    if (!metrics.collateralEnabledHint) blockers.push("collateral LTV is zero or missing");
    if (!metrics.borrowLiquidityHint) blockers.push("borrow/liquidity raw balance hint is zero or missing");
    if (!oracle?.decoded?.objectType) blockers.push("oracle table entry not decoded");
    blockers.push("no account-level liquidation state, exact repay/acquire quote, collateral-exit quote, or local proof");
    return {
      symbolKey: row.symbolKey,
      name: row.name,
      assetId: row.assetId,
      type: row.type || null,
      coinSymbol: row.coinSymbol || null,
      decimal: row.decimal ?? apiPool?.oracleDecimal ?? null,
      reserveObjectId: row.reserveObjectId,
      oracleId: metrics.oracleId ?? null,
      oracleObjectId: oracle?.objectId || null,
      oracleObjectType: oracle?.decoded?.objectType || null,
      ltvBps: metrics.ltvBps ?? null,
      liquidationThresholdBps: metrics.liquidationThresholdBps ?? null,
      liquidationBonusBps: metrics.liquidationBonusBps ?? null,
      liquidationRatioBps: metrics.liquidationRatioBps ?? null,
      borrowRaw: metrics.borrowRaw ?? null,
      supplyRaw: metrics.supplyRaw ?? null,
      currentBorrowIndexRaw: metrics.currentBorrowIndexRaw ?? null,
      currentSupplyIndexRaw: metrics.currentSupplyIndexRaw ?? null,
      borrowUserStateTableIdPresent: Boolean(metrics.borrowUserStateTableId),
      supplyUserStateTableIdPresent: Boolean(metrics.supplyUserStateTableId),
      availableLiquidityRawApprox: metrics.availableLiquidityRawApprox ?? null,
      utilizationBpsApprox: metrics.utilizationBpsApprox ?? null,
      borrowCapZero: Boolean(metrics.borrowCapZero),
      supplyCapZero: Boolean(metrics.supplyCapZero),
      collateralEnabledHint: Boolean(metrics.collateralEnabledHint),
      borrowLiquidityHint: Boolean(metrics.borrowLiquidityHint),
      oraclePriceHintRows: oracle?.decoded?.oracleMetrics?.priceHintRows || 0,
      oracleUpdateHintRows: oracle?.decoded?.oracleMetrics?.updateHintRows || 0,
      publicApi: apiPool ? {
        oracleValid: apiPool.oracleValid,
        oraclePrice: apiPool.oraclePrice,
        oracleDecimal: apiPool.oracleDecimal,
        lastUpdateTimestamp: apiPool.lastUpdateTimestamp,
        lastUpdateAgeMs: apiPool.lastUpdateAgeMs,
        availableBorrow: apiPool.availableBorrow,
        leftBorrowAmount: apiPool.leftBorrowAmount,
        borrowedAmount: apiPool.borrowedAmount,
        totalSupplyAmount: apiPool.totalSupplyAmount,
        currentBorrowIndex: apiPool.currentBorrowIndex,
        currentSupplyIndex: apiPool.currentSupplyIndex,
      } : null,
      status: "inventory-only-no-exact-economics",
      blockers,
    };
  });
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function reserveByAssetId(reserveRows) {
  return new Map((reserveRows || []).map((row) => [String(row.assetId), row]));
}

function positionCurrentRaw(rawBalance, cross, side) {
  const indexRaw = side === "borrow" ? cross?.currentBorrowIndexRaw : cross?.currentSupplyIndexRaw;
  const converted = rawMulDiv(rawBalance, indexRaw, RAY, side === "borrow");
  return converted || rawString(rawBalance);
}

function positionPrice(row, cross) {
  return asNumber(row?.publicApiPrice ?? cross?.publicApi?.oraclePrice);
}

function positionDecimal(row, cross) {
  return asNumber(row?.decimal ?? cross?.decimal ?? cross?.publicApi?.oracleDecimal);
}

function mergeUserRows(rows) {
  const byUser = new Map();
  for (const row of rows || []) {
    if (!row?.nameValue) continue;
    if (!byUser.has(row.nameValue) || row.decoded?.exists) byUser.set(row.nameValue, row);
  }
  return [...byUser.values()];
}

function scoreReserveForBorrowerDiscovery(reserve, cross) {
  return ((cross?.ltvBps || 0) * 10)
    + ((cross?.liquidationThresholdBps || 0) * 2)
    + (cross?.borrowLiquidityHint ? 5_000 : 0)
    + (cross?.publicApi?.oracleValid ? 2_000 : 0)
    + (rawPositive(reserve?.decoded?.reserveMetrics?.borrowRaw) ? 1_000 : 0);
}

async function discoverBorrowersFromBorrowTables(rpcUrl, reserveRows, reserveCrossRows) {
  const crossMap = reserveByAssetId(reserveCrossRows);
  const candidates = (reserveRows || [])
    .filter((reserve) => reserve.decoded?.reserveMetrics?.borrowUserStateTableId && rawPositive(reserve.decoded?.reserveMetrics?.borrowRaw))
    .map((reserve) => ({ reserve, cross: crossMap.get(String(reserve.assetId)) || {} }))
    .sort((a, b) => scoreReserveForBorrowerDiscovery(b.reserve, b.cross) - scoreReserveForBorrowerDiscovery(a.reserve, a.cross))
    .slice(0, MAX_BORROWER_RESERVES);

  const reserveTableRows = [];
  const debtRows = [];
  for (const { reserve, cross } of candidates) {
    const tableId = reserve.decoded.reserveMetrics.borrowUserStateTableId;
    let fields = [];
    try {
      fields = await fetchDynamicFields(rpcUrl, tableId, MAX_BORROWERS_PER_RESERVE);
    } catch (error) {
      reserveTableRows.push({
        assetId: reserve.assetId,
        symbolKey: reserve.symbolKey,
        tableScanned: false,
        rowsScanned: 0,
        error: String(error?.message || error).slice(0, 180),
      });
      continue;
    }
    reserveTableRows.push({
      assetId: reserve.assetId,
      symbolKey: reserve.symbolKey,
      ltvBps: cross.ltvBps ?? null,
      tableScanned: true,
      rowsScanned: fields.length,
      tableCapHit: fields.length >= MAX_BORROWERS_PER_RESERVE,
    });
    const values = await mapLimit(fields, 8, async (field) => {
      const borrower = dynamicFieldNameValue(field);
      const rawDebt = await fetchDynamicFieldValue(rpcUrl, tableId, field.name?.type || "address", borrower);
      return { field, borrower, rawDebt };
    });
    for (const row of values) {
      if (!row.borrower || !rawPositive(row.rawDebt)) continue;
      debtRows.push({
        borrower: row.borrower,
        assetId: reserve.assetId,
        symbolKey: reserve.symbolKey,
        rawDebt: row.rawDebt,
        ltvBps: cross.ltvBps ?? null,
        liquidationThresholdBps: cross.liquidationThresholdBps ?? null,
        oracleId: cross.oracleId ?? null,
        publicApiOracleValid: cross.publicApi?.oracleValid === true,
        publicApiPrice: cross.publicApi?.oraclePrice || null,
      });
    }
  }

  const grouped = new Map();
  for (const row of debtRows) {
    const entry = grouped.get(row.borrower) || { borrower: row.borrower, debtPositions: [], debtPositionCount: 0, highLtvDebtCount: 0 };
    entry.debtPositions.push(row);
    entry.debtPositionCount += 1;
    if ((row.ltvBps || 0) >= 7000) entry.highLtvDebtCount += 1;
    grouped.set(row.borrower, entry);
  }
  const borrowerRows = [...grouped.values()]
    .map((row) => ({ ...row, debtPositions: row.debtPositions.slice(0, 12) }))
    .sort((a, b) => (b.highLtvDebtCount - a.highLtvDebtCount) || (b.debtPositionCount - a.debtPositionCount))
    .slice(0, MAX_DISCOVERED_BORROWERS);

  return {
    reserveTableRows,
    debtRows,
    borrowerRows,
    uniqueBorrowers: grouped.size,
  };
}

async function fetchUserInfoRowsForBorrowers(rpcUrl, userInfoTableId, borrowerRows) {
  return mapLimit((borrowerRows || []).slice(0, MAX_DISCOVERED_BORROWERS), 2, async (row) => (
    fetchDynamicFieldObjectSummary(rpcUrl, userInfoTableId, "address", row.borrower, "borrowerUserInfoEntry")
  ));
}

function addOracleUpdateCalls(tx, naviConfig, oracleIds) {
  const cfg = naviConfig?.oracleProConfig || {};
  if (!cfg.packageId || !cfg.oracleConfig || !cfg.priceOracle || !cfg.supraOracleHolder) return [];
  const byId = new Map((naviConfig.priceFeedConfigs || []).map((row) => [Number(row.oracleId), row]));
  const added = [];
  for (const oracleId of [...new Set(oracleIds || [])]) {
    const feed = byId.get(Number(oracleId));
    if (!feed?.feedId || !feed?.pythPriceInfoObject) continue;
    tx.moveCall({
      target: `${cfg.packageId}::oracle_pro::update_single_price`,
      arguments: [
        tx.object("0x06"),
        tx.object(cfg.oracleConfig),
        tx.object(cfg.priceOracle),
        tx.object(cfg.supraOracleHolder),
        tx.object(feed.pythPriceInfoObject),
        tx.pure.address(feed.feedId),
      ],
    });
    added.push({ oracleId: Number(oracleId), key: feed.key });
  }
  return added;
}

function healthFactorFields(raw) {
  const bps = bpsFromRay(raw);
  const cmp = rawCompare(raw, RAY);
  return {
    healthFactorRaw: raw,
    healthFactorExact: decimalFromRay(raw, 9),
    healthFactorBps: bps,
    marginToLiquidationBps: bps === null ? null : bps - 10_000,
    liquidatableExact: cmp === null ? false : cmp < 0,
  };
}

async function queryNaviHealthFactor(client, naviConfig, address, oracleIds = []) {
  if (!client || !Transaction || !naviConfig?.uiGetter || !naviConfig?.storageId || !naviConfig?.priceOracle) {
    const missing = [];
    if (!client) missing.push("SuiClient");
    if (!Transaction) missing.push("Transaction");
    if (!naviConfig?.uiGetter) missing.push("uiGetter");
    if (!naviConfig?.storageId) missing.push("StorageId");
    if (!naviConfig?.priceOracle) missing.push("PriceOracle");
    return { user: address, success: false, error: `sui-sdk-or-config-unavailable:${missing.join(",")}` };
  }
  const target = `${naviConfig.uiGetter}::logic_getter_unchecked::user_health_factor`;
  let lastError = null;
  for (let attempt = 0; attempt <= SUI_RPC_RETRIES; attempt += 1) {
    try {
      const tx = new Transaction();
      const oracleUpdates = INCLUDE_ORACLE_UPDATE_PRELUDE ? addOracleUpdateCalls(tx, naviConfig, oracleIds) : [];
      tx.moveCall({
        target,
        arguments: [
          tx.object("0x06"),
          tx.object(naviConfig.storageId),
          tx.object(naviConfig.priceOracle),
          tx.pure.address(address),
        ],
      });
      const result = await client.devInspectTransactionBlock({ transactionBlock: tx, sender: address });
      const executionStatus = result?.effects?.status?.status || null;
      const executionError = result?.effects?.status?.error || result?.error || null;
      const returnValues = result?.results?.flatMap((entry) => entry.returnValues || []) || [];
      const returnValue = returnValues[returnValues.length - 1] || null;
      const raw = decodeBcsU256(returnValue);
      if (!raw || executionStatus === "failure" || executionError) {
        return {
          user: address,
          success: false,
          target,
          oracleUpdateRows: oracleUpdates.length,
          oracleUpdates,
          executionStatus,
          error: String(executionError || "missing-health-factor-return").slice(0, 220),
        };
      }
      return {
        user: address,
        success: true,
        target,
        oracleUpdateRows: oracleUpdates.length,
        oracleUpdates,
        executionStatus,
        returnType: returnValue?.[1] || null,
        ...healthFactorFields(raw),
      };
    } catch (error) {
      lastError = error;
      if (attempt < SUI_RPC_RETRIES) await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  return {
    user: address,
    success: false,
    target,
    executionStatus: null,
    error: String(lastError?.message || lastError).slice(0, 220),
  };
}

async function queryNaviHealthFactors(rpcUrl, naviConfig, accountHealthRows) {
  const candidates = (accountHealthRows || [])
    .filter((row) => row.debtAndCollateral)
    .sort((a, b) => (b.highLtvCollateralCount - a.highLtvCollateralCount) || (b.borrowPositionCount - a.borrowPositionCount))
    .slice(0, MAX_HEALTH_QUERY_USERS);
  if (!candidates.length) return [];
  const client = SuiClient ? new SuiClient({ url: rpcUrl }) : null;
  return mapLimit(candidates, 1, async (row, index) => {
    const oracleIds = [...new Set((row.positions || []).map((pos) => pos.oracleId).filter((id) => id !== null && id !== undefined))];
    const health = await queryNaviHealthFactor(client, naviConfig, row.user, oracleIds);
    return {
      rank: index + 1,
      user: row.user,
      oracleIds,
      collateralCount: row.collateralCount,
      highLtvCollateralCount: row.highLtvCollateralCount,
      borrowPositionCount: row.borrowPositionCount,
      supplyPositionCount: row.supplyPositionCount,
      debtSymbols: [...new Set((row.positions || []).filter((pos) => pos.side === "borrow").map((pos) => pos.symbolKey))].slice(0, 8),
      collateralSymbols: [...new Set((row.positions || []).filter((pos) => pos.side === "supply" || pos.collateralEnabledForUser).map((pos) => pos.symbolKey))].slice(0, 8),
      ...health,
      status: health.success
        ? (health.liquidatableExact ? "exact-liquidatable-needs-economics" : "exact-health-not-liquidatable")
        : "health-factor-query-failed-closed",
      blockers: health.success && health.liquidatableExact
        ? ["no exact repay/acquire quote", "no collateral-exit quote", "no local/fork-equivalent proof"]
        : ["not currently liquidatable by exact NAVI health-factor getter", "no exact liquidation economics", "no local/fork-equivalent proof"],
    };
  });
}

function applyHealthFactorRows(accountHealthRows, healthFactorRows) {
  const byUser = new Map((healthFactorRows || []).map((row) => [row.user, row]));
  for (const row of accountHealthRows || []) {
    const health = byUser.get(row.user);
    if (!health) continue;
    row.healthFactorRaw = health.healthFactorRaw || null;
    row.healthFactorExact = health.healthFactorExact || null;
    row.healthFactorBps = health.healthFactorBps ?? null;
    row.marginToLiquidationBps = health.marginToLiquidationBps ?? null;
    row.liquidatable = health.success && health.liquidatableExact === true;
    row.status = health.status;
    row.blockers = health.blockers;
  }
}

function flashloanFeeByAssetId(flashloanRows) {
  const byAsset = new Map();
  for (const row of flashloanRows || []) {
    const metrics = row?.decoded?.flashloanMetrics;
    if (metrics?.assetId === null || metrics?.assetId === undefined) continue;
    byAsset.set(String(metrics.assetId), metrics);
  }
  return byAsset;
}

function routeProviderSummary(routes) {
  const providers = new Set();
  for (const route of routes || []) {
    for (const key of ["provider", "dex", "name", "protocol"]) {
      const value = route?.[key];
      if (value) providers.add(String(value).slice(0, 40));
    }
    for (const nested of route?.routes || route?.paths || []) {
      for (const key of ["provider", "dex", "name", "protocol"]) {
        const value = nested?.[key];
        if (value) providers.add(String(value).slice(0, 40));
      }
    }
  }
  return [...providers].slice(0, 8);
}

async function quoteNaviAggregator(fromCoinAddress, toCoinAddress, amountInRaw) {
  if (!fromCoinAddress || !toCoinAddress || !rawPositive(amountInRaw)) {
    return { success: false, error: "missing-route-input" };
  }
  const params = new URLSearchParams({
    from: fromCoinAddress,
    target: toCoinAddress,
    amount: String(amountInRaw),
    by_amount_in: "true",
    depth: "3",
    version: "10",
  });
  try {
    const json = await fetchPublicJson(`${NAVI_AGGREGATOR_API}?${params.toString()}`, 12_000);
    const data = json?.data || json || {};
    const routes = Array.isArray(data.routes) ? data.routes : [];
    const amountOut = rawString(data.amount_out ?? data.amountOut ?? data.toAmount ?? data.returnAmount);
    return {
      success: rawPositive(amountOut),
      source: "open-aggregator-api.naviprotocol.io/find_routes",
      amountInRaw: rawString(data.amount_in ?? data.amountIn ?? amountInRaw),
      amountOutRaw: amountOut,
      isAccurate: data.is_accurate ?? data.isAccurate ?? null,
      routeCount: routes.length,
      providers: routeProviderSummary(routes),
      error: rawPositive(amountOut) ? null : "missing-positive-amount-out",
    };
  } catch (error) {
    return { success: false, source: "open-aggregator-api.naviprotocol.io/find_routes", error: String(error?.message || error).slice(0, 180) };
  }
}

function modelLiquidationPair(userRow, debt, collateral, flashFeeMetrics) {
  const debtRaw = rawString(debt.currentBalanceRaw || debt.rawBalance);
  const collateralRaw = rawString(collateral.currentBalanceRaw || collateral.rawBalance);
  const debtDecimals = positionDecimal(debt, {});
  const collateralDecimals = positionDecimal(collateral, {});
  const debtPrice = positionPrice(debt, {});
  const collateralPrice = positionPrice(collateral, {});
  const closeFactorBps = asNumber(debt.liquidationRatioBps) ?? 3500;
  const bonusBps = asNumber(collateral.liquidationBonusBps) ?? 0;
  const debtAmount = rawAmountToNumber(debtRaw, debtDecimals);
  const collateralAmount = rawAmountToNumber(collateralRaw, collateralDecimals);
  if (debtAmount === null || collateralAmount === null || debtPrice === null || collateralPrice === null || closeFactorBps <= 0) {
    return null;
  }
  const maxCloseRepayAmount = debtAmount * Math.min(closeFactorBps, 10_000) / 10_000;
  const maxByCollateralAmount = collateralPrice > 0 && debtPrice > 0
    ? (collateralAmount * collateralPrice) / (debtPrice * (1 + (bonusBps / 10_000)))
    : 0;
  const repayAmount = Math.max(0, Math.min(maxCloseRepayAmount, maxByCollateralAmount));
  const repayRaw = amountToRawFloor(repayAmount, debtDecimals);
  const repayUsd = repayAmount * debtPrice;
  const seizedCollateralAmount = collateralPrice > 0
    ? Math.min(collateralAmount, repayUsd * (1 + (bonusBps / 10_000)) / collateralPrice)
    : 0;
  const seizedCollateralRaw = amountToRawFloor(seizedCollateralAmount, collateralDecimals);
  const seizedCollateralUsd = seizedCollateralAmount * collateralPrice;
  const grossBonusUsd = seizedCollateralUsd - repayUsd;
  const flashFeeBpsHint = asNumber(flashFeeMetrics?.totalFeeBpsHint);
  return {
    user: userRow.user,
    healthFactorExact: userRow.healthFactorExact || null,
    healthFactorBps: userRow.healthFactorBps ?? null,
    marginToLiquidationBps: userRow.marginToLiquidationBps ?? null,
    debtAssetId: debt.assetId,
    debtSymbol: debt.coinSymbol || debt.symbolKey,
    debtType: debt.type || null,
    debtDecimals,
    debtPrice,
    debtRaw,
    debtAmount: round(debtAmount, 9),
    collateralAssetId: collateral.assetId,
    collateralSymbol: collateral.coinSymbol || collateral.symbolKey,
    collateralType: collateral.type || null,
    collateralDecimals,
    collateralPrice,
    collateralRaw,
    collateralAmount: round(collateralAmount, 9),
    closeFactorBps,
    liquidationBonusBps: bonusBps,
    collateralCapApplied: repayAmount < maxCloseRepayAmount,
    repayRaw,
    repayAmount: round(repayAmount, 9),
    repayUsd: roundUsd(repayUsd),
    estimatedSeizedCollateralRaw: seizedCollateralRaw,
    estimatedSeizedCollateralAmount: round(seizedCollateralAmount, 9),
    estimatedSeizedCollateralUsd: roundUsd(seizedCollateralUsd),
    grossBonusUsd: roundUsd(grossBonusUsd),
    flashloanFeeBpsHint: flashFeeBpsHint,
    flashloanFeeUsdHint: flashFeeBpsHint !== null ? roundUsd(repayUsd * flashFeeBpsHint / 10_000) : null,
    balanceSources: [...new Set([debt.currentBalanceSource, collateral.currentBalanceSource].filter(Boolean))],
    status: "modeled-needs-collateral-exit-quote-and-local-proof",
    blockers: [
      "pairwise model only; collateral is not allocated across all borrower debts",
      "NAVI user-state unit normalization is not proof without full liquidation devInspect",
      "no full NAVI flashloan/liquidation/swap/repay devInspect proof",
      "no local/fork-equivalent proof",
    ],
  };
}

async function buildNaviLiquidationEconomics(rpcUrl, naviConfig, accountHealthRows, flashloanRows) {
  void rpcUrl;
  void naviConfig;
  const flashFees = flashloanFeeByAssetId(flashloanRows);
  const candidates = [];
  for (const userRow of (accountHealthRows || []).filter((row) => row.liquidatable)) {
    const debts = (userRow.positions || []).filter((pos) => pos.side === "borrow" && rawPositive(pos.currentBalanceRaw || pos.rawBalance));
    const collaterals = (userRow.positions || []).filter((pos) => (pos.side === "supply" || pos.collateralEnabledForUser) && pos.collateralEnabledForUser && rawPositive(pos.currentBalanceRaw || pos.rawBalance));
    for (const debt of debts) {
      for (const collateral of collaterals) {
        const row = modelLiquidationPair(userRow, debt, collateral, flashFees.get(String(debt.assetId)) || null);
        if (row && rawPositive(row.repayRaw) && rawPositive(row.estimatedSeizedCollateralRaw)) candidates.push(row);
      }
    }
  }
  const rows = candidates
    .sort((a, b) => (asNumber(b.grossBonusUsd) || 0) - (asNumber(a.grossBonusUsd) || 0))
    .slice(0, MAX_LIQUIDATION_ECONOMICS_ROWS)
    .map((row, index) => ({ rank: index + 1, ...row }));

  let quotesAttempted = 0;
  for (const row of rows) {
    const sameAsset = row.debtType && row.collateralType && row.debtType === row.collateralType;
    if (sameAsset) {
      row.collateralExitQuote = {
        success: true,
        source: "same-asset-no-swap",
        amountInRaw: row.estimatedSeizedCollateralRaw,
        amountOutRaw: row.estimatedSeizedCollateralRaw,
        routeCount: 0,
        providers: [],
      };
    } else if (quotesAttempted < MAX_LIQUIDATION_EXIT_QUOTES) {
      quotesAttempted += 1;
      row.collateralExitQuote = await quoteNaviAggregator(row.collateralType, row.debtType, row.estimatedSeizedCollateralRaw);
    } else {
      row.collateralExitQuote = { success: false, error: "bounded-quote-cap-not-attempted" };
    }
    const quoteOutRaw = row.collateralExitQuote?.amountOutRaw || null;
    const quoteOutAmount = rawAmountToNumber(quoteOutRaw, row.debtDecimals);
    if (quoteOutAmount !== null && row.debtPrice !== null) {
      const quoteOutUsd = quoteOutAmount * row.debtPrice;
      const slippageUsd = quoteOutUsd * LIQUIDATION_EXIT_SLIPPAGE_BPS / 10_000;
      const flashFeeUsd = asNumber(row.flashloanFeeUsdHint) || 0;
      const conservativeNetUsd = quoteOutUsd - (asNumber(row.repayUsd) || 0) - slippageUsd - flashFeeUsd - LIQUIDATION_GAS_USD_ESTIMATE;
      row.exitQuoteOutAmount = round(quoteOutAmount, 9);
      row.exitQuoteOutUsd = roundUsd(quoteOutUsd);
      row.slippageUsdEstimate = roundUsd(slippageUsd);
      row.gasUsdEstimate = LIQUIDATION_GAS_USD_ESTIMATE;
      row.conservativeNetUsd = roundUsd(conservativeNetUsd);
      row.status = conservativeNetUsd > 0
        ? "modeled-positive-needs-full-devinspect-proof"
        : "modeled-exit-quoted-route-negative";
    } else {
      row.status = "modeled-needs-collateral-exit-quote-and-local-proof";
    }
    if (!row.collateralExitQuote?.success) row.blockers.unshift("collateral-exit quote missing or failed");
    if ((asNumber(row.conservativeNetUsd) || 0) <= 0) row.blockers.push("not positive after quote/slippage/gas/fee estimates");
  }

  return {
    method: "pairwise-model-plus-public-aggregator-quotes",
    quoteSource: "open-aggregator-api.naviprotocol.io/find_routes",
    rows,
    quotesAttempted,
    warning: "Rows are not exact proof. Keep routePositive=0 until a full NAVI liquidation plus collateral-exit proof succeeds locally or in fork-equivalent simulation.",
  };
}

async function buildAccountHealthRows(rpcUrl, userInfoRows, reserveRows, reserveCrossRows, preferredAddresses = [], discoveredDebtRows = []) {
  const crossMap = reserveByAssetId(reserveCrossRows);
  const preferred = new Set((preferredAddresses || []).filter(Boolean));
  const discoveredDebtByBorrower = new Map();
  for (const debt of discoveredDebtRows || []) {
    if (!debt?.borrower || !rawPositive(debt.rawDebt)) continue;
    const rows = discoveredDebtByBorrower.get(debt.borrower) || [];
    rows.push(debt);
    discoveredDebtByBorrower.set(debt.borrower, rows);
  }
  const users = mergeUserRows(userInfoRows)
    .filter((row) => row.nameValue && (row.decoded?.userMetrics || preferred.has(row.nameValue)))
    .sort((a, b) => {
      const ap = preferred.has(a.nameValue) ? 1 : 0;
      const bp = preferred.has(b.nameValue) ? 1 : 0;
      return (bp - ap) || ((b.decoded?.userMetrics?.collateralCount || 0) - (a.decoded?.userMetrics?.collateralCount || 0));
    })
    .slice(0, Math.max(MAX_ACCOUNT_USERS, Math.min(MAX_DISCOVERED_BORROWERS, preferred.size)));
  return mapLimit(users, 3, async (userRow, index) => {
    const address = userRow.nameValue;
    const collaterals = userRow.decoded?.userMetrics?.collaterals || [];
    const tasks = [];
    for (const reserve of reserveRows || []) {
      const metrics = reserve.decoded?.reserveMetrics || {};
      tasks.push({ reserve, side: "borrow", tableId: metrics.borrowUserStateTableId });
      tasks.push({ reserve, side: "supply", tableId: metrics.supplyUserStateTableId });
    }
    const values = await mapLimit(tasks, 3, async (task) => ({
      reserve: task.reserve,
      side: task.side,
      value: await fetchDynamicFieldValue(rpcUrl, task.tableId, "address", address),
    }));
    const positions = [];
    for (const valueRow of values) {
      if (!rawPositive(valueRow.value)) continue;
      const assetId = valueRow.reserve.assetId;
      const cross = crossMap.get(String(assetId)) || {};
      const currentBalanceRaw = positionCurrentRaw(valueRow.value, cross, valueRow.side);
      positions.push({
        side: valueRow.side,
        assetId,
        symbolKey: valueRow.reserve.symbolKey,
        coinSymbol: valueRow.reserve.coinSymbol || cross.coinSymbol || null,
        type: valueRow.reserve.type || cross.type || null,
        decimal: positionDecimal(valueRow.reserve, cross),
        rawBalance: valueRow.value,
        currentBalanceRaw,
        currentBalanceSource: currentBalanceRaw && currentBalanceRaw !== rawString(valueRow.value) ? "reserve-index" : "raw-user-state-fallback",
        source: "userStateProbe",
        collateralEnabledForUser: collaterals.includes(assetId),
        ltvBps: cross.ltvBps ?? null,
        liquidationThresholdBps: cross.liquidationThresholdBps ?? null,
        liquidationBonusBps: cross.liquidationBonusBps ?? null,
        liquidationRatioBps: cross.liquidationRatioBps ?? null,
        oracleId: cross.oracleId ?? null,
        publicApiOracleValid: cross.publicApi?.oracleValid === true,
        publicApiPrice: cross.publicApi?.oraclePrice || null,
      });
    }
    for (const debt of discoveredDebtByBorrower.get(address) || []) {
      const existing = positions.some((row) => row.side === "borrow" && String(row.assetId) === String(debt.assetId));
      if (existing) continue;
      const cross = crossMap.get(String(debt.assetId)) || {};
      const currentBalanceRaw = positionCurrentRaw(debt.rawDebt, cross, "borrow");
      positions.push({
        side: "borrow",
        assetId: debt.assetId,
        symbolKey: debt.symbolKey,
        coinSymbol: cross.coinSymbol || null,
        type: cross.type || null,
        decimal: positionDecimal(debt, cross),
        rawBalance: debt.rawDebt,
        currentBalanceRaw,
        currentBalanceSource: currentBalanceRaw && currentBalanceRaw !== rawString(debt.rawDebt) ? "reserve-index" : "raw-user-state-fallback",
        source: "borrowerTableDiscovery",
        collateralEnabledForUser: collaterals.includes(debt.assetId),
        ltvBps: debt.ltvBps ?? null,
        liquidationThresholdBps: debt.liquidationThresholdBps ?? null,
        liquidationBonusBps: cross.liquidationBonusBps ?? null,
        liquidationRatioBps: cross.liquidationRatioBps ?? debt.liquidationRatioBps ?? null,
        oracleId: debt.oracleId ?? null,
        publicApiOracleValid: debt.publicApiOracleValid === true,
        publicApiPrice: debt.publicApiPrice || null,
      });
    }
    const borrowPositions = positions.filter((row) => row.side === "borrow");
    const supplyPositions = positions.filter((row) => row.side === "supply");
    const highLtvCollateralIds = collaterals.filter((assetId) => (crossMap.get(String(assetId))?.ltvBps || 0) >= 7000);
    const debtAndCollateral = borrowPositions.length > 0 && (supplyPositions.length > 0 || collaterals.length > 0);
    return {
      rank: index + 1,
      user: address,
      collateralAssetIds: collaterals,
      collateralCount: collaterals.length,
      highLtvCollateralCount: highLtvCollateralIds.length,
      borrowPositionCount: borrowPositions.length,
      supplyPositionCount: supplyPositions.length,
      debtAndCollateral,
      positionRows: positions.length,
      positions: positions.slice(0, 24),
      healthFactorExact: null,
      liquidatable: false,
      status: debtAndCollateral ? "sampled-debt-collateral-needs-health-factor" : "sampled-no-debt-collateral-route",
      blockers: [
        "health factor not exact-queried from NAVI Move getter",
        "raw user-state balances are not exact USD economics",
        "no exact repay/acquire or collateral-exit quote",
      ],
    };
  });
}

function markdown(artifact) {
  const s = artifact.summary;
  const navi = artifact.protocols.find((p) => p.name === "NAVI") || {};
  const lines = [
    "# 🟢 DORMANT - Sui Move Lending Config Decoder",
    "",
    "Date: 2026-06-17",
    "",
    "## Result",
    "",
    `Decoded Sui Move lending configuration using local SDK object IDs plus read-only Sui JSON-RPC decoded Move object content. The branch remains fail-closed: \`riskHintRows=${s.riskHintRows}\`, \`accountLevelLiquidationRows=${s.accountLevelLiquidationRows}\`, \`exactEconomicsRows=0\`, \`forkProofRows=0\`, \`routePositive=0\`, \`executableNow=0\`, \`signedActionJustified=false\`. Field decoding is inventory only until exact liquidation state maps to positive repay/acquire and collateral-exit economics.`,
    "",
    "## Coverage",
    "",
    "| Epoch | Protocols | Successful | NAVI Pools | Reserve Objects | Decoded Reserves | Risk Hints | Oracle Objects | Flash Objects |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    `| ${artifact.suiNetwork.epoch || "n/a"} | ${s.protocolsScanned} | ${s.protocolsSuccessful} | ${s.naviPoolsConfigured} | ${s.naviReserveObjectsConfigured} | ${s.naviReserveObjectsFetched} | ${s.riskHintRows} | ${s.oracleObjectDecodedRows} | ${s.flashloanObjectDecodedRows} |`,
    "",
    "## NAVI Reserve/Oracle/Liquidity Cross-Reference",
    "",
    `Cross-referenced decoded NAVI reserve fields against decoded oracle table entries and raw reserve balance hints. This remains inventory-only: \`naviReserveOracleCrossRefRows=${s.naviReserveOracleCrossRefRows}\`, \`naviOracleRowsFetched=${s.naviOracleRowsFetched}\`, \`naviBorrowLiquidityHintRows=${s.naviBorrowLiquidityHintRows}\`, \`naviHighLtvRows=${s.naviHighLtvRows}\`, \`exactEconomicsRows=0\`.`,
    "",
    "| Symbol | Oracle ID | LTV bps | LT bps | Borrow Raw | Supply Raw | Avail Raw Approx | Util bps | Oracle Hints | Blocker |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---|",
  ];
  for (const row of [...(navi.reserveOracleLiquidityRows || [])].sort((a, b) => (b.ltvBps || 0) - (a.ltvBps || 0)).slice(0, 12)) {
    lines.push(`| ${row.symbolKey} | ${row.oracleId ?? "n/a"} | ${row.ltvBps ?? "n/a"} | ${row.liquidationThresholdBps ?? "n/a"} | ${shortRaw(row.borrowRaw)} | ${shortRaw(row.supplyRaw)} | ${shortRaw(row.availableLiquidityRawApprox)} | ${row.utilizationBpsApprox ?? "n/a"} | ${row.oraclePriceHintRows}/${row.oracleUpdateHintRows} | ${(row.blockers || []).slice(0, 2).join("; ")} |`);
  }
  lines.push(
    "",
    "## NAVI Public Pool/API And User-State Feasibility",
    "",
    `Public NAVI pool API rows are used only as read-only enrichment and not as proof: \`naviPublicApiPoolRows=${s.naviPublicApiPoolRows}\`, \`naviPublicApiJoinedRows=${s.naviPublicApiJoinedRows}\`, \`naviPublicApiOracleValidRows=${s.naviPublicApiOracleValidRows}\`, \`naviPublicApiAvailableBorrowRows=${s.naviPublicApiAvailableBorrowRows}\`. Bounded user-state table sampling remains proof-gap work: \`naviUserInfoSampleRows=${s.naviUserInfoSampleRows}\`, \`naviUserInfoDecodedRows=${s.naviUserInfoDecodedRows}\`, \`naviUserPositionHintRows=${s.naviUserPositionHintRows}\`, \`accountLevelLiquidationRows=${s.accountLevelLiquidationRows}\`.`,
    "",
    "## Bounded Account-State Ranker",
    "",
    `Sampled decoded user-info rows against per-reserve borrow/supply user-state tables with \`SUI_LENDING_MAX_ACCOUNT_USERS=${artifact.thresholds.maxAccountUsers}\`. This remains a ranker, not proof: \`naviAccountRows=${s.naviAccountRows}\`, \`naviAccountRowsWithDebt=${s.naviAccountRowsWithDebt}\`, \`naviAccountRowsWithDebtAndCollateral=${s.naviAccountRowsWithDebtAndCollateral}\`, \`accountLevelLiquidationRows=${s.accountLevelLiquidationRows}\`.`,
    "",
    "## Borrower Table Discovery",
    "",
    `Enumerated bounded NAVI borrow user-state tables directly: \`naviBorrowerReserveTablesScanned=${s.naviBorrowerReserveTablesScanned}\`, \`naviBorrowerTableRowsScanned=${s.naviBorrowerTableRowsScanned}\`, \`naviBorrowerDebtRows=${s.naviBorrowerDebtRows}\`, \`naviUniqueBorrowers=${s.naviUniqueBorrowers}\`, \`naviBorrowerUserInfoDecodedRows=${s.naviBorrowerUserInfoDecodedRows}\`, \`naviBorrowerRowsWithDebt=${s.naviBorrowerRowsWithDebt}\`, \`naviBorrowerRowsWithDebtAndCollateral=${s.naviBorrowerRowsWithDebtAndCollateral}\`, \`naviBorrowerHighLtvCollateralRows=${s.naviBorrowerHighLtvCollateralRows}\`. Borrower discovery alone is not proof; exact health-factor rows are reported below.`,
    "",
    "| Borrower Rank | Debt Positions | High-LTV Debt Positions | First Debt Asset | Status |",
    "|---:|---:|---:|---|---|",
  );
  for (const row of (navi.borrowerRows || []).slice(0, 10)) {
    const first = row.debtPositions?.[0]?.symbolKey || "n/a";
    lines.push(`| ${row.rank || "n/a"} | ${row.debtPositionCount} | ${row.highLtvDebtCount} | ${first} | borrower-discovered-needs-user-info-health-factor |`);
  }
  lines.push(
    "",
    "## Exact NAVI Health-Factor Query",
    "",
    `Queried NAVI \`logic_getter_unchecked::user_health_factor\` via read-only \`devInspectTransactionBlock\` for bounded debt+collateral borrowers with \`SUI_LENDING_MAX_HEALTH_QUERY_USERS=${artifact.thresholds.maxHealthQueryUsers}\`: \`naviHealthFactorRows=${s.naviHealthFactorRows}\`, \`naviHealthFactorSuccessRows=${s.naviHealthFactorSuccessRows}\`, \`naviHealthFactorErrorRows=${s.naviHealthFactorErrorRows}\`, \`naviExactLiquidatableRows=${s.naviExactLiquidatableRows}\`, \`accountLevelLiquidationRows=${s.accountLevelLiquidationRows}\`.`,
    "",
    "| Rank | Health Factor | Margin bps | Liquidatable | Debt | Collateral/Supply | Status |",
    "|---:|---:|---:|---|---|---|---|",
  );
  for (const row of (navi.healthFactorQuery?.rows || []).slice(0, 10)) {
    const hf = row.success ? row.healthFactorExact : `error: ${String(row.error || "failed").slice(0, 80)}`;
    lines.push(`| ${row.rank} | ${hf} | ${row.marginToLiquidationBps ?? "n/a"} | ${row.liquidatableExact === true ? "yes" : "no"} | ${(row.debtSymbols || []).join(", ") || "n/a"} | ${(row.collateralSymbols || []).join(", ") || "n/a"} | ${row.status} |`);
  }
  lines.push(
    "",
    "## NAVI Liquidation Economics Model",
    "",
    `Built bounded pairwise liquidation models only for exact liquidatable NAVI rows: \`naviLiquidationModeledRows=${s.naviLiquidationModeledRows}\`, \`naviLiquidationExitQuoteRows=${s.naviLiquidationExitQuoteRows}\`, \`naviLiquidationExitQuoteSuccessRows=${s.naviLiquidationExitQuoteSuccessRows}\`, \`naviLiquidationModeledPositiveRows=${s.naviLiquidationModeledPositiveRows}\`. These rows are not proof; \`exactEconomicsRows=0\`, \`forkProofRows=0\`, and \`routePositive=0\` remain fail-closed until a full liquidation plus exit proof succeeds.`,
    "",
    "| Rank | Debt -> Collateral | Repay USD | Seized USD | Gross Bonus USD | Exit Quote | Conservative Net USD | Status |",
    "|---:|---|---:|---:|---:|---|---:|---|",
  );
  for (const row of (navi.liquidationEconomics?.rows || []).slice(0, 10)) {
    const quote = row.collateralExitQuote?.success ? `ok:${row.collateralExitQuote.source || "quote"}` : `blocked:${String(row.collateralExitQuote?.error || "missing").slice(0, 40)}`;
    lines.push(`| ${row.rank} | ${row.debtSymbol} -> ${row.collateralSymbol} | ${row.repayUsd ?? "n/a"} | ${row.estimatedSeizedCollateralUsd ?? "n/a"} | ${row.grossBonusUsd ?? "n/a"} | ${quote} | ${row.conservativeNetUsd ?? "n/a"} | ${row.status} |`);
  }
  lines.push(
    "",
    "| Rank | HF | Margin bps | Collaterals | High-LTV Collaterals | Borrow Positions | Supply Positions | Status |",
    "|---:|---:|---:|---:|---:|---:|---:|---|",
  );
  for (const row of (navi.accountHealthRows || []).slice(0, 10)) {
    lines.push(`| ${row.rank} | ${row.healthFactorExact || "n/a"} | ${row.marginToLiquidationBps ?? "n/a"} | ${row.collateralCount} | ${row.highLtvCollateralCount} | ${row.borrowPositionCount} | ${row.supplyPositionCount} | ${row.status} |`);
  }
  lines.push(
    "",
    "",
    "## NAVI Objects",
    "",
    "| Object | ID | Type | Fields | Risk Hints |",
    "|---|---|---|---:|---:|",
  );
  for (const row of navi.coreObjects || []) {
    lines.push(`| ${row.role} | \`${String(row.objectId || "n/a").slice(0, 18)}...\` | ${row.decoded?.objectType || row.decoded?.error || "n/a"} | ${(row.decoded?.fieldKeys || []).length} | ${(row.decoded?.riskHints || []).length} |`);
  }
  lines.push(
    "",
    "## Top Reserve Field Hints",
    "",
    "| Symbol | Reserve | Type | Hint Count | Sample Hints |",
    "|---|---|---|---:|---|",
  );
  for (const row of (navi.reserves || []).filter((r) => (r.decoded?.riskHints || []).length > 0).slice(0, 12)) {
    const hints = row.decoded.riskHints.slice(0, 4).map((hint) => `${hint.path}=${hint.value}`).join("; ");
    lines.push(`| ${row.symbolKey} | \`${String(row.reserveObjectId || "n/a").slice(0, 18)}...\` | ${row.decoded?.objectType || "n/a"} | ${row.decoded.riskHints.length} | ${hints} |`);
  }
  lines.push(
    "",
    "## Route-Positive Gate",
    "",
    "Do not fork or build Sui executors from this branch unless a decoded config row proves a live oracle/LTV/cap/pause/liquidation condition, the affected asset maps to material borrow or liquidation liquidity, exact route economics are positive after fees/slippage/priority costs, and local/fork-equivalent proof demonstrates net extraction.",
    "",
    "## Artifacts",
    "",
    "- JSON: `reports/raw/fast/sui-lending-config.json`",
    "- Scanner: `tools/scan-sui-lending-config.js`",
    "- Source layout: `targets/navi-sdk/src/address.ts`",
  );
  return lines.join("\n") + "\n";
}

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.mkdirSync(path.dirname(REPORT_OUT), { recursive: true });
  const rpcUrl = await resolveSuiRpcUrl();
  if (!rpcUrl) throw new Error("No Sui RPC found in rpc_endpoints.txt");

  let epoch = null;
  try {
    const state = await suiCall(rpcUrl, "suix_getLatestSuiSystemState");
    epoch = state?.epoch || null;
  } catch (_) {
    // Keep artifact fail-closed if epoch read fails.
  }

  const publicConfigResult = await fetchNaviPublicConfig();
  const naviConfig = mergeNaviPublicConfig(parseNaviSdkConfig(), publicConfigResult);
  const coreObjects = [];
  for (const [role, objectId] of Object.entries({
    storage: naviConfig.storageId,
    priceOracle: naviConfig.priceOracle,
    reserveParent: naviConfig.reserveParentId,
    flashloanConfig: naviConfig.flashloanConfig,
    flashloanSupportedAssets: naviConfig.flashloanSupportedAssets,
    uiGetter: naviConfig.uiGetter,
  })) {
    coreObjects.push({ role, objectId, decoded: await fetchObject(rpcUrl, objectId) });
  }

  const reserveRows = [];
  for (const pool of naviConfig.pools.slice(0, MAX_RESERVES)) {
    reserveRows.push({
      ...pool,
      decoded: await fetchObject(rpcUrl, pool.reserveObjectId),
    });
  }

  const storage = coreObjects.find((row) => row.role === "storage")?.decoded || {};
  const priceOracle = coreObjects.find((row) => row.role === "priceOracle")?.decoded || {};
  const oracleTableId = priceOracle.tableIds?.price_oracles || null;
  const oracleRows = await fetchDynamicFieldObjectRows(rpcUrl, oracleTableId, "priceOracleEntry", 80);
  let flashloanRows = [];
  try {
    flashloanRows = await fetchDynamicFieldObjectRows(rpcUrl, naviConfig.flashloanSupportedAssets, "flashloanSupportedAsset", 80);
  } catch (error) {
    flashloanRows = [{
      role: "flashloanSupportedAsset",
      nameType: null,
      nameValue: null,
      objectId: null,
      decoded: { exists: false, error: String(error?.message || error).slice(0, 180) },
    }];
  }
  const publicPoolsResult = await fetchNaviPublicPools();
  const publicPoolRows = normalizeApiPools(Array.isArray(publicPoolsResult) ? publicPoolsResult : publicPoolsResult.rows);
  const reserveOracleLiquidityRows = buildReserveOracleLiquidityRows(reserveRows, oracleRows, publicPoolRows);
  const userInfoTableId = storage.tableIds?.user_info || null;
  const userInfoRows = await fetchDynamicFieldObjectRows(rpcUrl, userInfoTableId, "userInfoEntry", MAX_USERS);
  const borrowerDiscovery = await discoverBorrowersFromBorrowTables(rpcUrl, reserveRows, reserveOracleLiquidityRows);
  const borrowerUserInfoRows = await fetchUserInfoRowsForBorrowers(rpcUrl, userInfoTableId, borrowerDiscovery.borrowerRows);
  const discoveredBorrowers = borrowerDiscovery.borrowerRows.map((row) => row.borrower);
  const accountHealthRows = await buildAccountHealthRows(
    rpcUrl,
    [...userInfoRows, ...borrowerUserInfoRows],
    reserveRows,
    reserveOracleLiquidityRows,
    discoveredBorrowers,
    borrowerDiscovery.debtRows,
  );
  const healthFactorRows = await queryNaviHealthFactors(rpcUrl, naviConfig, accountHealthRows);
  applyHealthFactorRows(accountHealthRows, healthFactorRows);
  const liquidationEconomics = await buildNaviLiquidationEconomics(rpcUrl, naviConfig, accountHealthRows, flashloanRows);

  const scallopDecoded = await fetchObject(rpcUrl, FALLBACK_SCALLOP.storageId);
  const protocols = [
    {
      name: "NAVI",
      source: naviConfig.source,
      protocolPackage: naviConfig.protocolPackage,
      storageId: naviConfig.storageId,
      priceOracle: naviConfig.priceOracle,
      publicConfig: {
        ...(naviConfig.publicConfigMeta || { source: "open-api.naviprotocol.io/api/navi/config", fetched: false }),
        error: publicConfigResult?.error || null,
      },
      oracleProConfig: {
        packageId: naviConfig.oracleProConfig?.packageId || null,
        oracleConfig: naviConfig.oracleProConfig?.oracleConfig || null,
        supraOracleHolder: naviConfig.oracleProConfig?.supraOracleHolder || null,
        feedConfigRows: naviConfig.priceFeedConfigs?.length || 0,
      },
      reserveParentId: naviConfig.reserveParentId,
      poolsConfigured: naviConfig.pools.length,
      coreObjects,
      oracleTableId,
      oracleRows,
      publicPoolApi: {
        source: "open-api.naviprotocol.io/api/navi/pools",
        rows: publicPoolRows,
        error: Array.isArray(publicPoolsResult) ? null : publicPoolsResult.error || null,
      },
      flashloanAssetRows: flashloanRows,
      userInfoTableId,
      userInfoRows,
      borrowerDiscovery: {
        reserveTableRows: borrowerDiscovery.reserveTableRows,
        debtRows: borrowerDiscovery.debtRows.slice(0, 250),
      },
      borrowerRows: borrowerDiscovery.borrowerRows.map((row, index) => ({ ...row, rank: index + 1 })),
      borrowerUserInfoRows,
      accountHealthRows,
      healthFactorQuery: {
        method: "devInspectTransactionBlock",
        target: naviConfig.uiGetter ? `${naviConfig.uiGetter}::logic_getter_unchecked::user_health_factor` : null,
        sender: "borrower-address",
        clockObjectId: "0x06",
        storageId: naviConfig.storageId,
        priceOracle: naviConfig.priceOracle,
        rows: healthFactorRows,
      },
      liquidationEconomics,
      reserves: reserveRows,
      reserveOracleLiquidityRows,
      objectType: coreObjects.find((row) => row.role === "storage")?.decoded?.objectType || null,
    },
    {
      name: FALLBACK_SCALLOP.name,
      source: FALLBACK_SCALLOP.source,
      storageId: FALLBACK_SCALLOP.storageId,
      decoded: scallopDecoded,
      objectType: scallopDecoded?.objectType || null,
      blocker: "No local Scallop deployment/source layout file was found in current targets; static prior object ID did not decode into usable market parameters unless objectType is present.",
    },
  ];

  const decodedReserves = reserveRows.filter((row) => row.decoded?.objectType);
  const riskHintRows = reserveRows.filter((row) => (row.decoded?.riskHints || []).length > 0).length;
  const ltvHintRows = reserveRows.filter((row) => rowHasHint(row, /ltv|collateral|factor|ratio/i)).length;
  const oracleHintRows = reserveRows.filter((row) => rowHasHint(row, /oracle|pyth|switchboard|supra|price|stale/i)).length;
  const pauseOrCapHintRows = reserveRows.filter((row) => rowHasHint(row, /pause|cap|max|min|borrow|supply/i)).length;
  const oracleRowsDecoded = oracleRows.filter((row) => row.decoded?.objectType).length;
  const oracleRowsWithUpdateHints = oracleRows.filter((row) => (row.decoded?.oracleMetrics?.updateHintRows || 0) > 0).length;
  const borrowLiquidityHintRows = reserveOracleLiquidityRows.filter((row) => row.borrowLiquidityHint).length;
  const collateralEnabledRows = reserveOracleLiquidityRows.filter((row) => row.collateralEnabledHint).length;
  const highLtvRows = reserveOracleLiquidityRows.filter((row) => (row.ltvBps || 0) >= 7000).length;
  const publicApiJoinedRows = reserveOracleLiquidityRows.filter((row) => row.publicApi).length;
  const publicApiOracleValidRows = reserveOracleLiquidityRows.filter((row) => row.publicApi?.oracleValid).length;
  const publicApiAvailableBorrowRows = reserveOracleLiquidityRows.filter((row) => rawPositive(row.publicApi?.availableBorrow) || rawPositive(row.publicApi?.leftBorrowAmount)).length;
  const userInfoDecodedRows = userInfoRows.filter((row) => row.decoded?.objectType).length;
  const userPositionHintRows = userInfoRows.filter((row) => (row.decoded?.userMetrics?.positionHintRows || 0) > 0).length;
  const accountRowsWithDebt = accountHealthRows.filter((row) => row.borrowPositionCount > 0).length;
  const accountRowsWithCollateral = accountHealthRows.filter((row) => row.collateralCount > 0 || row.supplyPositionCount > 0).length;
  const accountRowsWithDebtAndCollateral = accountHealthRows.filter((row) => row.debtAndCollateral).length;
  const discoveredBorrowerSet = new Set(discoveredBorrowers);
  const borrowerAccountRows = accountHealthRows.filter((row) => discoveredBorrowerSet.has(row.user));
  const borrowerRowsWithDebt = borrowerAccountRows.filter((row) => row.borrowPositionCount > 0).length;
  const borrowerRowsWithDebtAndCollateral = borrowerAccountRows.filter((row) => row.debtAndCollateral).length;
  const borrowerHighLtvCollateralRows = borrowerAccountRows.filter((row) => row.highLtvCollateralCount > 0).length;
  const borrowerUserInfoDecodedRows = borrowerUserInfoRows.filter((row) => row?.decoded?.objectType).length;
  const borrowerTableRowsScanned = borrowerDiscovery.reserveTableRows.reduce((acc, row) => acc + (asNumber(row.rowsScanned) || 0), 0);
  const healthFactorSuccessRows = healthFactorRows.filter((row) => row.success).length;
  const healthFactorErrorRows = healthFactorRows.filter((row) => !row.success).length;
  const exactLiquidatableRows = healthFactorRows.filter((row) => row.success && row.liquidatableExact).length;
  const flashloanAssetRowsDecoded = flashloanRows.filter((row) => row.decoded?.flashloanMetrics).length;
  const liquidationModeledRows = liquidationEconomics.rows.length;
  const liquidationExitQuoteRows = liquidationEconomics.rows.filter((row) => row.collateralExitQuote).length;
  const liquidationExitQuoteSuccessRows = liquidationEconomics.rows.filter((row) => row.collateralExitQuote?.success).length;
  const liquidationModeledPositiveRows = liquidationEconomics.rows.filter((row) => (asNumber(row.conservativeNetUsd) || 0) > 0).length;
  const summary = {
    epoch,
    protocolsScanned: protocols.length,
    protocolsSuccessful: protocols.filter((p) => p.objectType || p.decoded?.objectType).length,
    naviPoolsConfigured: naviConfig.pools.length,
    naviReserveObjectsConfigured: naviConfig.pools.filter((p) => p.reserveObjectId).length,
    naviReserveObjectsFetched: decodedReserves.length,
    reserveFieldDecodedRows: decodedReserves.length,
    riskHintRows,
    ltvHintRows,
    oracleHintRows,
    pauseOrCapHintRows,
    oracleObjectDecodedRows: coreObjects.filter((row) => row.role === "priceOracle" && row.decoded?.objectType).length,
    naviOracleTableId: oracleTableId,
    naviOracleRowsFetched: oracleRowsDecoded,
    naviOracleRowsWithUpdateHints: oracleRowsWithUpdateHints,
    naviReserveOracleCrossRefRows: reserveOracleLiquidityRows.length,
    naviBorrowLiquidityHintRows: borrowLiquidityHintRows,
    naviCollateralEnabledRows: collateralEnabledRows,
    naviHighLtvRows: highLtvRows,
    naviPublicApiPoolRows: publicPoolRows.length,
    naviPublicApiJoinedRows: publicApiJoinedRows,
    naviPublicApiOracleValidRows: publicApiOracleValidRows,
    naviPublicApiAvailableBorrowRows: publicApiAvailableBorrowRows,
    naviPublicConfigFetched: naviConfig.publicConfigMeta?.fetched ? 1 : 0,
    naviOracleFeedConfigRows: naviConfig.priceFeedConfigs?.length || 0,
    naviUserInfoTableId: userInfoTableId,
    naviUserInfoSampleRows: userInfoRows.length,
    naviUserInfoDecodedRows: userInfoDecodedRows,
    naviUserPositionHintRows: userPositionHintRows,
    naviAccountRows: accountHealthRows.length,
    naviAccountRowsWithDebt: accountRowsWithDebt,
    naviAccountRowsWithCollateral: accountRowsWithCollateral,
    naviAccountRowsWithDebtAndCollateral: accountRowsWithDebtAndCollateral,
    naviBorrowerReserveTablesScanned: borrowerDiscovery.reserveTableRows.filter((row) => row.tableScanned).length,
    naviBorrowerTableRowsScanned: borrowerTableRowsScanned,
    naviBorrowerDebtRows: borrowerDiscovery.debtRows.length,
    naviUniqueBorrowers: borrowerDiscovery.uniqueBorrowers,
    naviBorrowerRowsRanked: borrowerDiscovery.borrowerRows.length,
    naviBorrowerUserInfoDecodedRows: borrowerUserInfoDecodedRows,
    naviBorrowerRowsWithDebt: borrowerRowsWithDebt,
    naviBorrowerRowsWithDebtAndCollateral: borrowerRowsWithDebtAndCollateral,
    naviBorrowerHighLtvCollateralRows: borrowerHighLtvCollateralRows,
    naviHealthFactorRows: healthFactorRows.length,
    naviHealthFactorSuccessRows: healthFactorSuccessRows,
    naviHealthFactorErrorRows: healthFactorErrorRows,
    naviExactLiquidatableRows: exactLiquidatableRows,
    naviFlashloanAssetRows: flashloanAssetRowsDecoded,
    naviLiquidationModeledRows: liquidationModeledRows,
    naviLiquidationExitQuoteRows: liquidationExitQuoteRows,
    naviLiquidationExitQuoteSuccessRows: liquidationExitQuoteSuccessRows,
    naviLiquidationModeledPositiveRows: liquidationModeledPositiveRows,
    accountLevelLiquidationRows: exactLiquidatableRows,
    flashloanObjectDecodedRows: coreObjects.filter((row) => /flashloan/i.test(row.role) && row.decoded?.objectType).length,
    exactEconomicsRows: 0,
    forkProofRows: 0,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    blocker: "Sui Move config fields are decoded as inventory; no live oracle/LTV/cap/pause condition is joined to material exact route economics or local proof.",
  };

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-sui-lending-config.js",
    scope: "Read-only Sui Move lending protocol config scan via decoded JSON-RPC Move objects",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
    },
    thresholds: {
      maxReserves: MAX_RESERVES,
      maxUsers: MAX_USERS,
      maxAccountUsers: MAX_ACCOUNT_USERS,
      maxBorrowerReserves: MAX_BORROWER_RESERVES,
      maxBorrowersPerReserve: MAX_BORROWERS_PER_RESERVE,
      maxDiscoveredBorrowers: MAX_DISCOVERED_BORROWERS,
      maxHealthQueryUsers: MAX_HEALTH_QUERY_USERS,
      maxLiquidationEconomicsRows: MAX_LIQUIDATION_ECONOMICS_ROWS,
      maxLiquidationExitQuotes: MAX_LIQUIDATION_EXIT_QUOTES,
      liquidationExitSlippageBps: LIQUIDATION_EXIT_SLIPPAGE_BPS,
      liquidationGasUsdEstimate: LIQUIDATION_GAS_USD_ESTIMATE,
      suiRpcRetries: SUI_RPC_RETRIES,
      includeOracleUpdatePrelude: INCLUDE_ORACLE_UPDATE_PRELUDE,
    },
    suiNetwork: { epoch },
    protocols,
    summary,
    requiredForRoutePositive: [
      "Sui Move oracle/LTV/cap/pause/liquidation config decoded from live objects",
      "decoded condition maps to a material lending asset with live borrow or liquidation liquidity",
      "Pyth/Switchboard/Supra stale or divergence window is current and attacker-reachable",
      "exact repay/acquire, borrow/redeem, and collateral-exit economics are positive after fees",
      "local/fork-equivalent Sui proof demonstrates net extraction",
    ],
    nextReadOnlyStep: liquidationModeledPositiveRows > 0
      ? "Build full NAVI liquidation proof for modeled-positive rows: exact flashloan/acquisition, liquidation, collateral-exit, repay, gas/slippage/fee proof; keep routePositive=0 until proof is positive."
      : exactLiquidatableRows > 0
        ? "Refine exact NAVI liquidation economics for the liquidatable borrower; keep routePositive=0 until collateral-exit economics and local/fork-equivalent proof are positive."
      : "Broaden NAVI borrower discovery or rerun health-factor queries later; exact repay/acquire and collateral-exit quotes wait until a discovered account is currently liquidatable.",
  };

  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");
  fs.writeFileSync(REPORT_OUT, markdown(artifact));
  if (!QUIET) console.log(`Sui lending config: epoch=${epoch} naviReserves=${summary.naviReserveObjectsFetched}/${summary.naviReserveObjectsConfigured} oracleRows=${summary.naviOracleRowsFetched} borrowerDebtRows=${summary.naviBorrowerDebtRows} uniqueBorrowers=${summary.naviUniqueBorrowers} healthRows=${summary.naviHealthFactorRows} liquidatable=${summary.accountLevelLiquidationRows} modeledRows=${summary.naviLiquidationModeledRows} modeledPositive=${summary.naviLiquidationModeledPositiveRows} routePositive=0`);
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exit(1);
});
