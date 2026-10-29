#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const RPC = 'https://fullnode.mainnet.sui.io:443';
const ROOT = path.resolve(__dirname, '..');
const LIVE_MAP = path.join(ROOT, 'reports', 'raw', 'navi-live-map.json');
const DEFAULT_OUT_FILE = path.join(ROOT, 'reports', 'raw', 'navi-liquidation-scan.json');
const RAY = 10n ** 27n;
const NORMAL_DECIMALS = 9n;

function arg(name, def) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : def;
}

const MAX_TABLE_SIZE = Number(arg('--max-table-size', '20000'));
const TOP_BORROWERS = Number(arg('--top', '500'));
const MIN_RESERVE_BORROW_USD = Number(arg('--min-reserve-borrow-usd', '1000'));
const INCLUDE = arg('--include', '')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean)
  .map(Number);
const POSITION_CONCURRENCY = Number(arg('--position-concurrency', '25'));
const OUT_FILE = path.resolve(arg('--out', DEFAULT_OUT_FILE));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt) {
  return Math.min(15000, 750 * 2 ** attempt);
}

async function rpc(method, params, attempt = 0) {
  try {
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!res.ok) {
      if ((res.status === 429 || res.status >= 500) && attempt < 10) {
        await sleep(backoffMs(attempt));
        return rpc(method, params, attempt + 1);
      }
      throw new Error(`${method} HTTP ${res.status}`);
    }
    const json = await res.json();
    if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
    return json.result;
  } catch (err) {
    if (attempt < 10 && /fetch failed|ETIMEDOUT|ECONNRESET|HTTP 429|HTTP 5\d\d/i.test(err.message)) {
      await sleep(backoffMs(attempt));
      return rpc(method, params, attempt + 1);
    }
    throw err;
  }
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

async function multiGetObjects(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const part = ids.slice(i, i + 50);
    const res = await rpc('sui_multiGetObjects', [part, { showContent: true, showType: true, showOwner: true }]);
    out.push(...res);
  }
  return out;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

async function dynamicFieldObject(parentId, type, value) {
  try {
    const res = await rpc('suix_getDynamicFieldObject', [parentId, { type, value }]);
    if (res?.error?.code === 'dynamicFieldNotFound') return null;
    if (res?.error) throw new Error(`dynamicFieldObject: ${JSON.stringify(res.error)}`);
    return res?.data ? res : null;
  } catch (err) {
    if (/does not exist|not found|DynamicFieldNotFound/i.test(err.message)) return null;
    throw err;
  }
}

function fields(obj) {
  return obj?.data?.content?.fields;
}

function asBig(value) {
  if (value === undefined || value === null) return 0n;
  return BigInt(value.toString());
}

function rayMul(a, b) {
  return (a * b) / RAY;
}

function rayPct(value) {
  return Number(asBig(value)) / 1e27;
}

function unitsFromNormal(normalAmount) {
  return Number(normalAmount) / Number(10n ** NORMAL_DECIMALS);
}

function valueUsd(normalAmount, price) {
  return unitsFromNormal(normalAmount) * Number(price || 0);
}

function scaledActual(scaled, index) {
  return rayMul(asBig(scaled), asBig(index));
}

function getFieldValue(obj) {
  const f = fields(obj);
  if (!f) return undefined;
  return f.value;
}

function addressFromBorrowEntry(obj) {
  const name = fields(obj)?.name;
  return typeof name === 'string' ? name : name?.value;
}

function getTableFromStorageDynamic(live, keyPart) {
  return live.storage.dynamicFields.find((x) => (x.keyType || '').includes(keyPart))?.table?.id;
}

function getEmodeTables(live) {
  const emode = live.storage.dynamicFields.find((x) => (x.keyType || '').includes('EMODE_KEY'));
  return {
    pairTableId: emode?.rawValueFields?.emodes_pair?.fields?.id?.id,
    userTableId: emode?.rawValueFields?.user_emode_id?.fields?.id?.id,
  };
}

async function loadEmodeConfigs(pairTableId) {
  if (!pairTableId) return new Map();
  const dyn = await dynamicFields(pairTableId);
  const objs = await multiGetObjects(dyn.map((x) => x.objectId));
  const out = new Map();
  for (const obj of objs) {
    const f = fields(obj);
    const id = Number(f?.name);
    const cfg = f?.value?.fields;
    if (!cfg) continue;
    function asset(a) {
      return {
        assetId: Number(a.assetId),
        isCollateral: Boolean(a.isCollateral),
        isDebt: Boolean(a.isDebt),
        ltv: rayPct(a.ltv),
        lt: rayPct(a.lt),
        liquidationBonus: rayPct(a.liquidation_bonus),
      };
    }
    out.set(id, {
      id,
      isActive: Boolean(cfg.isActive),
      assetA: asset(cfg.assetA?.fields || cfg.assetA),
      assetB: asset(cfg.assetB?.fields || cfg.assetB),
    });
  }
  return out;
}

function emodeAssetOverride(emodeConfig, assetId) {
  if (!emodeConfig || !emodeConfig.isActive) return null;
  if (emodeConfig.assetA.assetId === assetId) return emodeConfig.assetA;
  if (emodeConfig.assetB.assetId === assetId) return emodeConfig.assetB;
  return null;
}

async function getUserInfo(userInfoTableId, user) {
  const obj = await dynamicFieldObject(userInfoTableId, 'address', user);
  const v = getFieldValue(obj)?.fields;
  if (!v) return { collaterals: [], loans: [] };
  return {
    collaterals: Array.isArray(v.collaterals) ? v.collaterals.map(Number) : [],
    loans: Array.isArray(v.loans) ? v.loans.map(Number) : [],
  };
}

async function getBalance(tableId, user) {
  if (!tableId) return 0n;
  const obj = await dynamicFieldObject(tableId, 'address', user);
  const v = getFieldValue(obj);
  return asBig(v);
}

async function getOptionalU64(tableId, user) {
  if (!tableId) return undefined;
  const obj = await dynamicFieldObject(tableId, 'address', user);
  const v = getFieldValue(obj);
  return v === undefined ? undefined : Number(v);
}

async function getOptionalBool(tableId, user) {
  if (!tableId) return false;
  const obj = await dynamicFieldObject(tableId, 'address', user);
  const v = getFieldValue(obj);
  return Boolean(v);
}

async function scanBorrowTable(reserve) {
  const parentId = reserve.borrowUserTable?.id;
  if (!parentId) return [];
  const dyn = await dynamicFields(parentId);
  const entries = [];
  for (let i = 0; i < dyn.length; i += 50) {
    const objs = await multiGetObjects(dyn.slice(i, i + 50).map((x) => x.objectId));
    for (const obj of objs) {
      const user = addressFromBorrowEntry(obj);
      const scaled = asBig(getFieldValue(obj));
      if (!user || scaled === 0n) continue;
      const normal = scaledActual(scaled, reserve.currentBorrowIndex);
      const usd = valueUsd(normal, reserve.price);
      if (usd <= 0) continue;
      entries.push({ user, assetId: reserve.id, symbol: reserve.symbol, normal: normal.toString(), usd });
    }
  }
  return entries;
}

async function buildPosition(live, reservesById, user, emodeUserTableId, emodeConfigs, protectedTableId) {
  const [info, emodeId, isProtected] = await Promise.all([
    getUserInfo(live.storage.userInfoTable.id, user),
    getOptionalU64(emodeUserTableId, user),
    getOptionalBool(protectedTableId, user),
  ]);
  const emodeConfig = emodeId === undefined ? null : emodeConfigs.get(emodeId);

  const supplies = (await Promise.all(info.collaterals.map(async (assetId) => {
    const r = reservesById.get(assetId);
    if (!r) return null;
    const scaled = await getBalance(r.supplyUserTable?.id, user);
    const normal = scaledActual(scaled, r.currentSupplyIndex);
    const usd = valueUsd(normal, r.price);
    const ov = emodeAssetOverride(emodeConfig, assetId);
    return {
      assetId,
      symbol: r.symbol,
      normal: normal.toString(),
      usd,
      lt: ov ? ov.lt : r.liquidationThresholdPct / 100,
      ltv: ov ? ov.ltv : r.ltvPct / 100,
      liquidationBonus: ov ? ov.liquidationBonus : r.liquidationBonusPct / 100,
      treasuryFactor: r.treasuryFactorPct / 100,
      price: r.price,
    };
  }))).filter(Boolean);

  const borrows = (await Promise.all(info.loans.map(async (assetId) => {
    const r = reservesById.get(assetId);
    if (!r) return null;
    const scaled = await getBalance(r.borrowUserTable?.id, user);
    const normal = scaledActual(scaled, r.currentBorrowIndex);
    const usd = valueUsd(normal, r.price);
    return { assetId, symbol: r.symbol, normal: normal.toString(), usd, price: r.price };
  }))).filter(Boolean);

  const collateralUsd = supplies.reduce((acc, x) => acc + x.usd, 0);
  const weightedCollateralUsd = supplies.reduce((acc, x) => acc + x.usd * x.lt, 0);
  const debtUsd = borrows.reduce((acc, x) => acc + x.usd, 0);
  const healthFactor = debtUsd > 0 ? weightedCollateralUsd / debtUsd : Number.POSITIVE_INFINITY;

  let best = null;
  if (healthFactor < 1) {
    for (const debt of borrows) {
      for (const collateral of supplies) {
        if (debt.usd <= 0 || collateral.usd <= 0) continue;
        const collateralReserve = reservesById.get(collateral.assetId);
        const collateralPoolCapUsd = collateralReserve?.poolLiquidityUsd === undefined
          ? Number.POSITIVE_INFINITY
          : collateralReserve.poolLiquidityUsd / (1 + collateral.liquidationBonus);
        const liquidableValue = Math.min(collateral.usd * (collateralReserve.liquidationRatioPct / 100), debt.usd, collateralPoolCapUsd);
        if (liquidableValue <= 0) continue;
        const totalBonusUsd = liquidableValue * collateral.liquidationBonus;
        const treasuryUsd = totalBonusUsd * collateral.treasuryFactor;
        const executorBonusUsd = totalBonusUsd - treasuryUsd;
        const candidate = {
          debtAsset: debt.assetId,
          debtSymbol: debt.symbol,
          collateralAsset: collateral.assetId,
          collateralSymbol: collateral.symbol,
          repayUsd: liquidableValue,
          executorBonusUsd,
          treasuryUsd,
          collateralPoolLiquidityUsd: collateralReserve?.poolLiquidityUsd,
          liquidityLimited: Number.isFinite(collateralPoolCapUsd) && liquidableValue === collateralPoolCapUsd,
        };
        if (!best || candidate.executorBonusUsd > best.executorBonusUsd) best = candidate;
      }
    }
  }

  return {
    user,
    collaterals: info.collaterals,
    loans: info.loans,
    emodeId,
    isProtected,
    collateralUsd,
    weightedCollateralUsd,
    debtUsd,
    healthFactor,
    supplies,
    borrows,
    bestLiquidation: best,
  };
}

async function main() {
  const live = JSON.parse(fs.readFileSync(LIVE_MAP, 'utf8'));
  const reservesById = new Map(live.reserves.map((r) => [r.id, r]));
  const protectedTableId = getTableFromStorageDynamic(live, 'PROTECTED_LIQUIDATION_USERS_KEY');
  const { pairTableId, userTableId: emodeUserTableId } = getEmodeTables(live);
  const emodeConfigs = await loadEmodeConfigs(pairTableId);

  const reserves = live.reserves
    .filter((r) => r.borrowUserTable?.id)
    .filter((r) => (INCLUDE.length ? INCLUDE.includes(r.id) : (r.borrowUsd || 0) >= MIN_RESERVE_BORROW_USD && r.borrowUserTable.size <= MAX_TABLE_SIZE))
    .sort((a, b) => (b.borrowUsd || 0) - (a.borrowUsd || 0));

  console.log(`Scanning ${reserves.length} reserve borrow tables: ${reserves.map((r) => `${r.id}:${r.symbol}(${r.borrowUserTable.size})`).join(', ')}`);

  const byUser = new Map();
  const scanned = [];
  for (const reserve of reserves) {
    const entries = await scanBorrowTable(reserve);
    scanned.push({ assetId: reserve.id, symbol: reserve.symbol, entries: entries.length });
    for (const e of entries) {
      const cur = byUser.get(e.user) || { user: e.user, scannedDebtUsd: 0, assets: [] };
      cur.scannedDebtUsd += e.usd;
      cur.assets.push(e);
      byUser.set(e.user, cur);
    }
    console.log(`Scanned ${reserve.id}:${reserve.symbol} borrowers=${entries.length}`);
  }

  const top = [...byUser.values()].sort((a, b) => b.scannedDebtUsd - a.scannedDebtUsd).slice(0, TOP_BORROWERS);
  console.log(`Evaluating top ${top.length} unique borrowers from ${byUser.size} scanned users`);

  let completed = 0;
  const positions = await mapLimit(top, POSITION_CONCURRENCY, async (item) => {
    const pos = await buildPosition(live, reservesById, item.user, emodeUserTableId, emodeConfigs, protectedTableId);
    pos.scannedDebtUsd = item.scannedDebtUsd;
    completed++;
    if (completed % 50 === 0) console.log(`Evaluated ${completed}/${top.length}`);
    return pos;
  });

  const unhealthy = positions
    .filter((p) => p.debtUsd > 0 && p.healthFactor < 1)
    .sort((a, b) => (b.bestLiquidation?.executorBonusUsd || 0) - (a.bestLiquidation?.executorBonusUsd || 0));

  const result = {
    capturedAt: new Date().toISOString(),
    liveMapCapturedAt: live.capturedAt,
    parameters: { maxTableSize: MAX_TABLE_SIZE, topBorrowers: TOP_BORROWERS, minReserveBorrowUsd: MIN_RESERVE_BORROW_USD, include: INCLUDE, positionConcurrency: POSITION_CONCURRENCY },
    scanned,
    uniqueBorrowersScanned: byUser.size,
    evaluatedBorrowers: positions.length,
    unhealthy,
    topPositions: positions.sort((a, b) => a.healthFactor - b.healthFactor).slice(0, 50),
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2));

  console.log(`Unhealthy among evaluated: ${unhealthy.length}`);
  for (const p of unhealthy.slice(0, 20)) {
    const b = p.bestLiquidation;
    console.log(`${p.user} HF=${p.healthFactor.toFixed(4)} debt=$${p.debtUsd.toFixed(2)} coll=$${p.collateralUsd.toFixed(2)} protected=${p.isProtected} best=${b ? `${b.debtSymbol}->${b.collateralSymbol} repay=$${b.repayUsd.toFixed(2)} bonus=$${b.executorBonusUsd.toFixed(2)}` : 'n/a'}`);
  }
  console.log(`Wrote ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
