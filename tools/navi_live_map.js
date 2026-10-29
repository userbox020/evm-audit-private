#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const RPC = 'https://fullnode.mainnet.sui.io:443';
const POOLS_API = 'https://open-api.naviprotocol.io/api/navi/pools';
const PACKAGE_API = 'https://open-api.naviprotocol.io/api/package';

const ROOT = path.resolve(__dirname, '..');
const ADDRESS_TS = path.join(ROOT, 'targets', 'navi-sdk', 'src', 'address.ts');
const OUT_DIR = path.join(ROOT, 'reports', 'raw');
const OUT_FILE = path.join(OUT_DIR, 'navi-live-map.json');

const STORAGE_ID = '0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe';
const PRICE_ORACLE_ID = '0x1568865ed9a0b5ec414220e8f79b3d04c77acc82358f6e5ae4635687392ffbef';
const ORACLE_CONFIG_ID = '0x1afe1cb83634f581606cc73c4487ddd8cc39a944b951283af23f7d69d5589478';

const RAY = 10n ** 27n;
const NORMAL_DECIMALS = 9n;

function parseNum(raw) {
  if (!raw) return undefined;
  const cleaned = raw.replace(/\/\/.*$/gm, '').replace(/_/g, '').trim();
  try {
    if (/^\d+\s*\*\s*\d+$/.test(cleaned)) {
      const [a, b] = cleaned.split('*').map((x) => Number(x.trim()));
      return a * b;
    }
    if (/^\d+\s*\*\s*\d+\s*\*\s*\d+$/.test(cleaned)) {
      return cleaned.split('*').map((x) => Number(x.trim())).reduce((a, b) => a * b, 1);
    }
    if (/^\d+(\.\d+)?e\+?\d+$/i.test(cleaned)) return Number(cleaned);
    if (/^\d+$/.test(cleaned)) return Number(cleaned);
  } catch (_) {}
  return undefined;
}

function extractString(block, key) {
  const match = block.match(new RegExp(`${key}\\s*:\\s*\"([^\"]+)\"`));
  return match ? match[1] : undefined;
}

function extractRaw(block, key) {
  const match = block.match(new RegExp(`${key}\\s*:\\s*([^,\\n]+)`));
  return match ? match[1].trim() : undefined;
}

function blockBetween(source, startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start);
  if (start < 0 || end < 0) return '';
  return source.slice(start, end);
}

function parseSdkConfig() {
  const src = fs.readFileSync(ADDRESS_TS, 'utf8');
  const poolsSrc = blockBetween(src, 'export const pool:', 'export interface IPriceFeed');
  const feedSrc = blockBetween(src, 'export const PriceFeedConfig', 'export interface IOracleProConfig');

  const pools = [];
  const poolRe = /\n\s*([A-Za-z0-9_]+):\s*{([\s\S]*?)\n\s*},/g;
  let match;
  while ((match = poolRe.exec(poolsSrc)) !== null) {
    const block = match[2];
    const assetId = parseNum(extractRaw(block, 'assetId'));
    if (assetId === undefined) continue;
    pools.push({
      key: match[1],
      name: extractString(block, 'name'),
      assetId,
      poolId: extractString(block, 'poolId'),
      type: extractString(block, 'type'),
      reserveObjectId: extractString(block, 'reserveObjectId'),
      borrowBalanceParentId: extractString(block, 'borrowBalanceParentId'),
      supplyBalanceParentId: extractString(block, 'supplyBalanceParentId'),
    });
  }

  const feeds = [];
  const feedRe = /\n\s*([A-Za-z0-9_]+):\s*{([\s\S]*?)\n\s*},/g;
  while ((match = feedRe.exec(feedSrc)) !== null) {
    const block = match[2];
    const oracleId = parseNum(extractRaw(block, 'oracleId'));
    if (oracleId === undefined) continue;
    feeds.push({
      key: match[1],
      oracleId,
      maxTimestampDiff: parseNum(extractRaw(block, 'maxTimestampDiff')),
      priceDiffThreshold1: parseNum(extractRaw(block, 'priceDiffThreshold1')),
      priceDiffThreshold2: parseNum(extractRaw(block, 'priceDiffThreshold2')),
      maxDurationWithinThresholds: parseNum(extractRaw(block, 'maxDurationWithinThresholds')),
      maximumAllowedSpanPercentage: parseNum(extractRaw(block, 'maximumAllowedSpanPercentage')),
      maximumEffectivePrice: parseNum(extractRaw(block, 'maximumEffectivePrice')),
      minimumEffectivePrice: parseNum(extractRaw(block, 'minimumEffectivePrice')),
      historicalPriceTTL: parseNum(extractRaw(block, 'historicalPriceTTL')),
      coinType: extractString(block, 'coinType'),
      feedId: extractString(block, 'feedId'),
      supraPairId: parseNum(extractRaw(block, 'supraPairId')),
      pythPriceFeedId: extractString(block, 'pythPriceFeedId'),
      pythPriceInfoObject: extractString(block, 'pythPriceInfoObject'),
      priceDecimal: parseNum(extractRaw(block, 'priceDecimal')),
      expiration: parseNum(extractRaw(block, 'expiration')),
    });
  }

  return { pools, feeds };
}

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`${method} HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
  return json.result;
}

async function getObject(id) {
  return rpc('sui_getObject', [id, { showContent: true, showType: true, showOwner: true }]);
}

async function multiGetObjects(ids) {
  if (!ids.length) return [];
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const part = ids.slice(i, i + 50);
    const res = await rpc('sui_multiGetObjects', [part, { showContent: true, showType: true, showOwner: true }]);
    out.push(...res);
  }
  return out;
}

async function dynamicFields(parentId) {
  const out = [];
  let cursor = null;
  do {
    const res = await rpc('suix_getDynamicFields', [parentId, cursor, 50]);
    out.push(...(res.data || []));
    cursor = res.hasNextPage ? res.nextCursor : null;
  } while (cursor);
  return out;
}

function fields(obj) {
  return obj?.data?.content?.fields;
}

function tableInfo(value) {
  const id = value?.fields?.id?.id;
  const sizeRaw = value?.fields?.size;
  return { id, size: sizeRaw === undefined ? undefined : Number(sizeRaw) };
}

function summarizeDynamicFieldObject(obj) {
  const f = fields(obj);
  const value = f?.value;
  const valueFields = value?.fields;
  const keyType = f?.name?.type || '';
  const valueType = value?.type || '';
  return {
    objectId: obj?.data?.objectId,
    objectType: obj?.data?.type,
    keyType,
    valueType,
    table: tableInfo(value),
    rawValueFields: valueFields && Object.keys(valueFields).length <= 5 ? valueFields : undefined,
  };
}

function asBig(value) {
  if (value === undefined || value === null) return 0n;
  return BigInt(value.toString());
}

function rayMul(a, b) {
  return (a * b) / RAY;
}

function asPct(rayValue) {
  return Number(asBig(rayValue)) / 1e25;
}

function amountToNumber(normalAmount) {
  return Number(normalAmount) / Number(10n ** NORMAL_DECIMALS);
}

function amountToNumberWithDecimals(amount, decimals) {
  if (amount === undefined || amount === null || decimals === undefined) return undefined;
  return Number(asBig(amount)) / 10 ** Number(decimals);
}

function priceToNumber(price, decimal) {
  const dec = decimal === undefined ? 0 : Number(decimal);
  return Number(asBig(price)) / 10 ** dec;
}

function shortType(type) {
  if (!type) return '';
  const parts = type.split('::');
  return parts.length >= 3 ? `${parts[1]}::${parts[2]}` : type;
}

function asciiField(value) {
  if (typeof value === 'string') return value;
  const bytes = value?.bytes || value?.fields?.bytes;
  if (Array.isArray(bytes)) return String.fromCharCode(...bytes);
  return value?.fields?.name ? asciiField(value.fields.name) : '';
}

function providerName(provider) {
  if (!provider) return '';
  if (typeof provider === 'string') return provider;
  return asciiField(provider.fields?.name || provider.name || provider);
}

function providerPair(providerConfig) {
  const pair = providerConfig?.fields?.pair_id;
  if (!Array.isArray(pair)) return undefined;
  return '0x' + pair.map((x) => Number(x).toString(16).padStart(2, '0')).join('');
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
  return res.json();
}

function pickApiPools(api) {
  if (Array.isArray(api)) return api;
  if (Array.isArray(api?.data)) return api.data;
  if (Array.isArray(api?.data?.data)) return api.data.data;
  return [];
}

function reserveFromObject(obj) {
  const v = fields(obj)?.value?.fields;
  if (!v) return undefined;
  const supplyScaled = rayMul(asBig(v.supply_balance?.fields?.total_supply), asBig(v.current_supply_index));
  const borrowScaled = rayMul(asBig(v.borrow_balance?.fields?.total_supply), asBig(v.current_borrow_index));
  const lf = v.liquidation_factors?.fields || {};
  const brf = v.borrow_rate_factors?.fields || {};
  return {
    reserveObjectId: obj.data.objectId,
    id: Number(v.id),
    oracleId: Number(v.oracle_id),
    coinType: v.coin_type,
    shortCoinType: shortType(v.coin_type),
    isIsolated: Boolean(v.is_isolated),
    ltvPct: asPct(v.ltv),
    liquidationRatioPct: asPct(lf.ratio),
    liquidationBonusPct: asPct(lf.bonus),
    liquidationThresholdPct: asPct(lf.threshold),
    supplyCapCeilingRay: v.supply_cap_ceiling,
    borrowCapCeilingRay: v.borrow_cap_ceiling,
    supplyCapRatioPct: asPct(v.supply_cap_ceiling),
    borrowCapRatioPct: asPct(v.borrow_cap_ceiling),
    currentSupplyIndex: v.current_supply_index,
    currentBorrowIndex: v.current_borrow_index,
    currentSupplyRatePct: asPct(v.current_supply_rate),
    currentBorrowRatePct: asPct(v.current_borrow_rate),
    totalSupplyNormal: supplyScaled.toString(),
    totalBorrowNormal: borrowScaled.toString(),
    totalSupplyUnits: amountToNumber(supplyScaled),
    totalBorrowUnits: amountToNumber(borrowScaled),
    utilizationPct: supplyScaled > 0n ? Number((borrowScaled * 10000n) / supplyScaled) / 100 : 0,
    lastUpdateTimestamp: Number(v.last_update_timestamp),
    supplyUserTable: tableInfo(v.supply_balance?.fields?.user_state),
    borrowUserTable: tableInfo(v.borrow_balance?.fields?.user_state),
    treasuryFactorPct: asPct(v.treasury_factor),
    treasuryBalance: v.treasury_balance,
    borrowRateFactors: {
      baseRatePct: asPct(brf.base_rate),
      multiplierPct: asPct(brf.multiplier),
      jumpRateMultiplierPct: asPct(brf.jump_rate_multiplier),
      reserveFactorPct: asPct(brf.reserve_factor),
      optimalUtilizationPct: asPct(brf.optimal_utilization),
    },
  };
}

function priceFromObject(obj) {
  const f = fields(obj);
  const value = f?.value?.fields;
  if (!value) return undefined;
  const id = Number(f.name);
  return {
    oracleId: id,
    objectId: obj.data.objectId,
    value: value.value,
    decimal: Number(value.decimal),
    timestamp: Number(value.timestamp),
    price: priceToNumber(value.value, value.decimal),
  };
}

async function mapOracleConfig(cfgObj) {
  const f = fields(cfgObj);
  const feedsTable = tableInfo(f?.feeds);
  const feedDyn = feedsTable.id ? await dynamicFields(feedsTable.id) : [];
  const feedObjects = await multiGetObjects(feedDyn.map((x) => x.objectId));
  const feeds = [];

  for (const obj of feedObjects) {
    const pf = fields(obj)?.value?.fields;
    if (!pf) continue;
    const providerTable = tableInfo(pf.oracle_provider_configs);
    const providers = [];
    if (providerTable.id) {
      const dyn = await dynamicFields(providerTable.id);
      const providerObjects = await multiGetObjects(dyn.map((x) => x.objectId));
      for (const pobj of providerObjects) {
        const pc = fields(pobj)?.value;
        if (!pc) continue;
        providers.push({
          name: providerName(pc.fields?.provider),
          enable: Boolean(pc.fields?.enable),
          pairId: providerPair(pc),
        });
      }
    }
    feeds.push({
      feedId: pf.id?.id || obj.data.objectId,
      objectId: obj.data.objectId,
      enable: Boolean(pf.enable),
      oracleId: Number(pf.oracle_id),
      coinType: pf.coin_type,
      shortCoinType: shortType(pf.coin_type),
      primary: providerName(pf.primary),
      secondary: providerName(pf.secondary),
      maxTimestampDiffMs: Number(pf.max_timestamp_diff),
      priceDiffThreshold1Bps: Number(pf.price_diff_threshold1),
      priceDiffThreshold2Bps: Number(pf.price_diff_threshold2),
      maxDurationWithinThresholdsMs: Number(pf.max_duration_within_thresholds),
      diffThreshold2Timer: Number(pf.diff_threshold2_timer),
      maximumAllowedSpanBps: Number(pf.maximum_allowed_span_percentage),
      maximumEffectivePrice: pf.maximum_effective_price,
      minimumEffectivePrice: pf.minimum_effective_price,
      historicalPriceTtlMs: Number(pf.historical_price_ttl),
      history: {
        price: pf.history?.fields?.price,
        updatedTime: Number(pf.history?.fields?.updated_time || 0),
      },
      providerTable,
      providers,
    });
  }
  feeds.sort((a, b) => a.oracleId - b.oracleId);
  return {
    id: cfgObj.data.objectId,
    paused: Boolean(f?.paused),
    version: Number(f?.version),
    feedsTable,
    vecFeedCount: Array.isArray(f?.vec_feeds) ? f.vec_feeds.length : undefined,
    feeds,
  };
}

async function main() {
  const now = Date.now();
  const sdk = parseSdkConfig();
  const apiPoolsPromise = fetchJson(POOLS_API).catch((err) => ({ error: err.message }));
  const packagePromise = fetchJson(PACKAGE_API).catch((err) => ({ error: err.message }));

  const [storageObj, oracleObj, cfgObj, apiPoolsRaw, packageInfo] = await Promise.all([
    getObject(STORAGE_ID),
    getObject(PRICE_ORACLE_ID),
    getObject(ORACLE_CONFIG_ID),
    apiPoolsPromise,
    packagePromise,
  ]);

  const sf = fields(storageObj);
  const reservesTable = tableInfo(sf?.reserves);
  const userInfoTable = tableInfo(sf?.user_info);
  const storageDyn = await dynamicFields(STORAGE_ID);
  const storageDynObjects = await multiGetObjects(storageDyn.map((x) => x.objectId));
  const storageDynamicFields = storageDynObjects.map(summarizeDynamicFieldObject);
  const reserveDyn = await dynamicFields(reservesTable.id);
  const reserveObjects = await multiGetObjects(reserveDyn.map((x) => x.objectId));
  const reserves = reserveObjects.map(reserveFromObject).filter(Boolean).sort((a, b) => a.id - b.id);

  const of = fields(oracleObj);
  const priceTable = tableInfo(of?.price_oracles);
  const priceDyn = await dynamicFields(priceTable.id);
  const priceObjects = await multiGetObjects(priceDyn.map((x) => x.objectId));
  const prices = priceObjects.map(priceFromObject).filter(Boolean).sort((a, b) => a.oracleId - b.oracleId);
  const priceById = new Map(prices.map((p) => [p.oracleId, p]));

  const oracleConfig = await mapOracleConfig(cfgObj);
  const feedByOracleId = new Map(oracleConfig.feeds.map((f) => [f.oracleId, f]));
  const sdkPoolByAssetId = new Map(sdk.pools.map((p) => [p.assetId, p]));
  const sdkFeedByOracleId = new Map(sdk.feeds.map((f) => [f.oracleId, f]));
  const poolObjects = await multiGetObjects(sdk.pools.map((p) => p.poolId).filter(Boolean));
  const poolById = new Map(poolObjects.filter((p) => p?.data?.objectId).map((p) => [p.data.objectId, p]));
  const apiPools = pickApiPools(apiPoolsRaw);
  const apiById = new Map(apiPools.map((p) => [Number(p.id), p]));

  const reserveRows = reserves.map((r) => {
    const price = priceById.get(r.oracleId);
    const feed = feedByOracleId.get(r.oracleId);
    const sdkPool = sdkPoolByAssetId.get(r.id);
    const sdkFeed = sdkFeedByOracleId.get(r.oracleId);
    const poolFields = fields(poolById.get(sdkPool?.poolId));
    const api = apiById.get(r.id) || {};
    const priceAgeMs = price ? now - price.timestamp : undefined;
    const oracleValid = price ? price.value !== '0' && priceAgeMs <= Number(of?.update_interval || 0) : false;
    const supplyUsd = price ? r.totalSupplyUnits * price.price : undefined;
    const borrowUsd = price ? r.totalBorrowUnits * price.price : undefined;
    const poolBalanceUnits = amountToNumberWithDecimals(poolFields?.balance, poolFields?.decimal);
    const poolTreasuryUnits = amountToNumberWithDecimals(poolFields?.treasury_balance, poolFields?.decimal);
    return {
      ...r,
      symbol: api?.token?.symbol || sdkPool?.name || sdkFeed?.key || r.shortCoinType,
      apiStatus: api?.status || api?.token?.status || null,
      apiPrice: api?.oracle?.price ?? null,
      price: price?.price,
      priceRaw: price?.value,
      priceDecimal: price?.decimal,
      priceTimestamp: price?.timestamp,
      priceAgeMs,
      priceOracleValidByUpdateInterval: oracleValid,
      feedEnabled: feed?.enable,
      feedPrimary: feed?.primary,
      feedSecondary: feed?.secondary,
      feedMaxTimestampDiffMs: feed?.maxTimestampDiffMs,
      feedMaximumAllowedSpanBps: feed?.maximumAllowedSpanBps,
      sdkPythPriceFeedId: sdkFeed?.pythPriceFeedId,
      sdkPythPriceInfoObject: sdkFeed?.pythPriceInfoObject,
      sdkSupraPairId: sdkFeed?.supraPairId,
      poolId: sdkPool?.poolId,
      poolBalance: poolFields?.balance,
      poolDecimal: poolFields?.decimal === undefined ? undefined : Number(poolFields.decimal),
      poolTreasuryBalance: poolFields?.treasury_balance,
      poolBalanceUnits,
      poolTreasuryUnits,
      poolLiquidityUsd: price && poolBalanceUnits !== undefined ? poolBalanceUnits * price.price : undefined,
      supplyUsd,
      borrowUsd,
    };
  });

  const stalePrices = reserveRows.filter((r) => !r.priceOracleValidByUpdateInterval || (r.feedMaxTimestampDiffMs !== undefined && r.priceAgeMs > r.feedMaxTimestampDiffMs));
  const configuredSingleSource = oracleConfig.feeds.filter((f) => !f.secondary || f.primary === f.secondary || !f.providers.some((p) => p.name === f.secondary && p.enable));
  const nonActiveMarkets = reserveRows.filter((r) => r.apiStatus && !/^(active|online|normal)$/i.test(String(r.apiStatus)));
  const isolatedMarkets = reserveRows.filter((r) => r.isIsolated);

  const result = {
    capturedAt: new Date(now).toISOString(),
    packageInfo,
    storage: {
      objectId: STORAGE_ID,
      version: storageObj?.data?.version,
      digest: storageObj?.data?.digest,
      type: storageObj?.data?.type,
      paused: Boolean(sf?.paused),
      storageVersion: Number(sf?.version),
      reservesCount: Number(sf?.reserves_count),
      reservesTable,
      usersVectorLength: Array.isArray(sf?.users) ? sf.users.length : undefined,
      userInfoTable,
      dynamicFields: storageDynamicFields,
    },
    oracle: {
      objectId: PRICE_ORACLE_ID,
      version: oracleObj?.data?.version,
      digest: oracleObj?.data?.digest,
      type: oracleObj?.data?.type,
      oracleVersion: Number(of?.version),
      updateIntervalMs: Number(of?.update_interval),
      priceTable,
      prices,
    },
    oracleConfig,
    reserves: reserveRows,
    sdk: { pools: sdk.pools, feeds: sdk.feeds },
    apiPoolsRawError: apiPoolsRaw.error,
    findings: {
      staleOrInvalidPrices: stalePrices.map((r) => ({ id: r.id, symbol: r.symbol, oracleId: r.oracleId, priceAgeMs: r.priceAgeMs, feedMaxTimestampDiffMs: r.feedMaxTimestampDiffMs, validByUpdateInterval: r.priceOracleValidByUpdateInterval })),
      singleSourceFeeds: configuredSingleSource.map((f) => ({ oracleId: f.oracleId, symbol: sdkFeedByOracleId.get(f.oracleId)?.key || f.shortCoinType, primary: f.primary, secondary: f.secondary, providers: f.providers })),
      nonActiveMarkets: nonActiveMarkets.map((r) => ({ id: r.id, symbol: r.symbol, status: r.apiStatus, borrowUsd: r.borrowUsd, supplyUsd: r.supplyUsd })),
      isolatedMarkets: isolatedMarkets.map((r) => ({ id: r.id, symbol: r.symbol, ltvPct: r.ltvPct, borrowUsd: r.borrowUsd, supplyUsd: r.supplyUsd })),
    },
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2));

  console.log(`Captured NAVI live map at ${result.capturedAt}`);
  console.log(`Storage paused=${result.storage.paused} reserves=${result.storage.reservesCount} reserveTableSize=${result.storage.reservesTable.size} userTableSize=${result.storage.userInfoTable.size}`);
  for (const df of result.storage.dynamicFields) {
    if (/LIQUIDAT|EMODE|BORROW_WEIGHT|MARKET/i.test(df.keyType + df.valueType)) {
      console.log(`Storage dynamic field ${df.keyType.split('::').pop()} value=${df.valueType.split('::').pop()} tableSize=${df.table.size ?? 'n/a'}`);
    }
  }
  console.log(`PriceOracle updateIntervalSec=${Math.round(result.oracle.updateIntervalMs / 1000)} priceCount=${result.oracle.priceTable.size} OracleConfig paused=${result.oracleConfig.paused} feeds=${result.oracleConfig.feeds.length}`);
  if (packageInfo?.data?.packageId) console.log(`Latest package=${packageInfo.data.packageId}`);
  console.log('Markets:');
  for (const r of reserveRows) {
    const priceAge = r.priceAgeMs === undefined ? 'n/a' : `${Math.round(r.priceAgeMs / 1000)}s`;
    const supply = r.supplyUsd === undefined ? 'n/a' : `$${r.supplyUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
    const borrow = r.borrowUsd === undefined ? 'n/a' : `$${r.borrowUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
    const status = r.apiStatus ? ` status=${r.apiStatus}` : '';
    console.log(`${String(r.id).padStart(2)} ${String(r.symbol).padEnd(12)} oracle=${String(r.oracleId).padStart(2)} price=${r.price?.toPrecision(8) || 'n/a'} age=${priceAge} valid=${r.priceOracleValidByUpdateInterval} LTV=${r.ltvPct.toFixed(1)} LT=${r.liquidationThresholdPct.toFixed(1)} bonus=${r.liquidationBonusPct.toFixed(1)} util=${r.utilizationPct.toFixed(1)} supply=${supply} borrow=${borrow}${status}`);
  }
  console.log(`Stale/invalid by live checks: ${stalePrices.length}`);
  console.log(`Single-source configured feeds: ${configuredSingleSource.length}`);
  console.log(`Non-active API markets: ${nonActiveMarkets.length}`);
  console.log(`Isolated markets: ${isolatedMarkets.length}`);
  console.log(`Wrote ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
