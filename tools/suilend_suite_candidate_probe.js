#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'reports', 'raw');
const OUT_FILE = path.join(OUT_DIR, 'suilend-suite-candidate-probe.json');

const OBJECT_OPTIONS = {
  showType: true,
  showOwner: true,
  showPreviousTransaction: false,
  showDisplay: false,
  showContent: true,
  showBcs: false,
  showStorageRebate: false,
};

const TARGETS = {
  suilend: {
    originalPackage: '0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf',
    mainMarket: '0x84030d26d85eaa7035084a057f2f11f701b7e2e4eda87551becbc7c97505ece1',
  },
  strategyWrapper: {
    originalPackage: '0xba97dc73a07638d03d77ad2161484eb21db577edc9cadcd7035fef4b4f2f6fa1',
    currentPackage: '0x864b66441e95323c320ee7584592769930a2d236b45d731011ee7a98eb785b35',
  },
  springSui: {
    liquidStakingInfo: '0x15eda7330c8f99c30e430b4d82fd7ab2af3ead4ae17046fcb224aa9bad394f6b',
  },
  steamm: {
    originalPackage: '0x4fb1cf45dffd6230305f1d269dd1816678cc8e3ba0b747a813a556921219f261',
    registry: '0x8584948e8c0a2809ec192ede7e030b0a32bd602e5ca6c91bde8dc35fb8b0068d',
  },
};

function sanitize(text) {
  return String(text || '').replace(/https?:\/\/[^\s"']+/g, '[redacted-url]');
}

function rpcCandidates() {
  const candidates = [];
  for (const key of ['SUI_RPC', 'SUI_RPC_URL']) {
    if (process.env[key]) candidates.push(process.env[key]);
  }
  const rpcFile = path.join(ROOT, 'rpc_endpoints.txt');
  if (process.env.SUI_SKIP_RPC_INVENTORY !== '1' && fs.existsSync(rpcFile)) {
    const lines = fs.readFileSync(rpcFile, 'utf8').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    for (const line of lines) {
      if (/sui/i.test(line) && /^https?:\/\//i.test(line)) candidates.push(line);
    }
  }
  candidates.push('https://fullnode.mainnet.sui.io:443');
  return [...new Set(candidates)];
}

async function postJson(url, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${sanitize(text)}`);
    const json = JSON.parse(text);
    if (json.error) throw new Error(JSON.stringify(json.error));
    return json.result;
  } finally {
    clearTimeout(timeout);
  }
}

async function connectRpc() {
  let lastError;
  for (const url of rpcCandidates()) {
    try {
      const checkpoint = await postJson(url, { jsonrpc: '2.0', id: 1, method: 'sui_getLatestCheckpointSequenceNumber', params: [] });
      const chain = await postJson(url, { jsonrpc: '2.0', id: 2, method: 'sui_getChainIdentifier', params: [] });
      return { url, checkpoint, chain };
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`No working Sui RPC candidate (${lastError ? sanitize(lastError.message) : 'unknown error'})`);
}

function makeRpc(url) {
  let id = 100;
  return async function rpc(method, params = []) {
    return postJson(url, { jsonrpc: '2.0', id: id++, method, params });
  };
}

async function optional(label, fn) {
  try {
    return await fn();
  } catch (err) {
    return { error: `${label}: ${sanitize(err.message || err)}` };
  }
}

function fields(obj) {
  return obj && obj.data && obj.data.content && obj.data.content.fields;
}

function asId(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (value.id) return typeof value.id === 'string' ? value.id : value.id.id;
  return null;
}

function typeName(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (value.fields && value.fields.name) return value.fields.name;
  if (value.name) return value.name;
  return null;
}

function normalizeType(value) {
  return String(value || '').trim().replace(/^0x/i, '').toLowerCase();
}

function splitTopLevel(value) {
  const out = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '<') depth++;
    if (ch === '>') depth--;
    if (ch === ',' && depth === 0) {
      out.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(value.slice(start).trim());
  return out;
}

function poolTypeArgs(poolType) {
  const marker = '::pool::Pool<';
  const start = poolType.indexOf(marker);
  if (start < 0 || !poolType.endsWith('>')) return [];
  return splitTopLevel(poolType.slice(start + marker.length, -1));
}

async function getObject(rpc, id, options = OBJECT_OPTIONS) {
  return rpc('sui_getObject', [id, options]);
}

async function multiGetObjects(rpc, ids, options = OBJECT_OPTIONS) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    out.push(...await rpc('sui_multiGetObjects', [ids.slice(i, i + 50), options]));
  }
  return out;
}

async function getDynamicFields(rpc, id, limit = 50, max = Infinity) {
  const out = [];
  let cursor = null;
  do {
    const page = await rpc('suix_getDynamicFields', [id, cursor, limit]);
    out.push(...(page.data || []));
    cursor = page.hasNextPage ? page.nextCursor : null;
  } while (cursor && out.length < max);
  return out;
}

async function queryEvents(rpc, eventType, limit = 50) {
  return rpc('suix_queryEvents', [{ MoveEventType: eventType }, null, limit, true]);
}

function parsePoolDataVecSet(objectResult) {
  const f = fields(objectResult);
  const contents = f && (
    f.contents
    || (f.value && f.value.fields && f.value.fields.contents)
    || (f.contents && f.contents.fields && f.contents.fields.contents)
  );
  if (!Array.isArray(contents)) return [];
  return contents.map((entry) => {
    const value = entry.fields ? entry.fields : entry;
    return {
      poolId: asId(value.pool_id),
      quoterType: typeName(value.quoter_type),
      lpTokenType: typeName(value.lp_token_type),
      swapFeeBps: value.swap_fee_bps,
    };
  }).filter((x) => x.poolId);
}

function parsePoolObject(objectResult) {
  const f = fields(objectResult);
  if (!f) return null;
  const lpSupply = f.lp_supply && f.lp_supply.fields && f.lp_supply.fields.value;
  const protocolFeeConfig = f.protocol_fees && f.protocol_fees.fields && f.protocol_fees.fields.config && f.protocol_fees.fields.config.fields;
  const poolFeeConfig = f.pool_fee_config && f.pool_fee_config.fields;
  return {
    objectId: objectResult.data.objectId,
    type: objectResult.data.type,
    balanceA: f.balance_a,
    balanceB: f.balance_b,
    lpSupply,
    protocolFeeConfig,
    poolFeeConfig,
    quoter: f.quoter,
    owner: objectResult.data.owner,
  };
}

function divUp(x, y) {
  return (x + y - 1n) / y;
}

function feeQuote(grossOut, protocolFeeConfig, poolFeeConfig) {
  const gross = BigInt(grossOut || '0');
  const poolNum = BigInt(poolFeeConfig && poolFeeConfig.fee_numerator || '0');
  const poolDen = BigInt(poolFeeConfig && poolFeeConfig.fee_denominator || '1');
  const protocolNum = BigInt(protocolFeeConfig && protocolFeeConfig.fee_numerator || '0');
  const protocolDen = BigInt(protocolFeeConfig && protocolFeeConfig.fee_denominator || '1');
  const totalFees = poolNum === 0n ? 0n : divUp(gross * poolNum, poolDen);
  const protocolFees = protocolNum === 0n ? 0n : divUp(totalFees * protocolNum, protocolDen);
  const poolFees = totalFees - protocolFees;
  return {
    grossOut: gross.toString(),
    totalFees: totalFees.toString(),
    protocolFees: protocolFees.toString(),
    poolFees: poolFees.toString(),
    netOut: (gross - totalFees).toString(),
  };
}

function parseBankDataObject(objectResult) {
  const raw = fields(objectResult);
  const f = raw && raw.value && raw.value.fields || raw;
  if (!f) return null;
  return {
    bankId: asId(f.bank_id),
    btokenType: typeName(f.btoken_type),
    lendingMarketType: typeName(f.lending_market_type),
  };
}

function parseBankObject(objectResult) {
  const f = fields(objectResult);
  if (!f) return null;
  const lendingFields = f.lending && f.lending.fields || null;
  return {
    objectId: objectResult.data.objectId,
    type: objectResult.data.type,
    owner: objectResult.data.owner,
    fundsAvailable: f.funds_available,
    btokenSupply: f.btoken_supply && f.btoken_supply.fields && f.btoken_supply.fields.value,
    minTokenBlockSize: f.min_token_block_size,
    lending: lendingFields ? {
      ctokens: lendingFields.ctokens,
      reserveArrayIndex: lendingFields.reserve_array_index,
      targetUtilisationBps: lendingFields.target_utilisation_bps,
      utilisationBufferBps: lendingFields.utilisation_buffer_bps,
      obligationId: lendingFields.obligation_cap && lendingFields.obligation_cap.fields && lendingFields.obligation_cap.fields.obligation_id,
    } : null,
  };
}

function quoterName(pool) {
  const quoterType = pool.quoter && pool.quoter.type || '';
  const parts = quoterType.split('::');
  return parts.length >= 2 ? `${parts[parts.length - 2]}::${parts[parts.length - 1]}` : quoterType;
}

function cpmmOffset(pool) {
  if (!pool.type.includes('::cpmm::CpQuoter')) return null;
  return pool.quoter && pool.quoter.fields && pool.quoter.fields.offset;
}

async function steammProbe(rpc) {
  const registry = await getObject(rpc, TARGETS.steamm.registry);
  const registryFields = fields(registry);
  const poolsBag = registryFields && registryFields.pools && registryFields.pools.fields && registryFields.pools.fields.id && registryFields.pools.fields.id.id;
  const banksBag = registryFields && registryFields.banks && registryFields.banks.fields && registryFields.banks.fields.id && registryFields.banks.fields.id.id;
  const bankFieldRefs = banksBag ? await getDynamicFields(rpc, banksBag, 100) : [];
  const bankDataObjects = await multiGetObjects(rpc, bankFieldRefs.map((x) => x.objectId));
  const bankData = bankDataObjects.map(parseBankDataObject).filter(Boolean);
  const bankObjects = await multiGetObjects(rpc, [...new Set(bankData.map((x) => x.bankId).filter(Boolean))]);
  const banks = bankObjects.map(parseBankObject).filter(Boolean);
  const bankInfoById = new Map(banks.map((x) => [x.objectId, x]));
  const bankInfoByBTokenType = new Map();
  for (const data of bankData) {
    const bank = bankInfoById.get(data.bankId);
    bankInfoByBTokenType.set(normalizeType(data.btokenType), { ...data, bank });
  }
  const poolFieldRefs = poolsBag ? await getDynamicFields(rpc, poolsBag, 100) : [];
  const poolSetObjects = await multiGetObjects(rpc, poolFieldRefs.map((x) => x.objectId));
  const poolData = poolSetObjects.flatMap(parsePoolDataVecSet);
  const uniquePoolIds = [...new Set(poolData.map((x) => x.poolId))];
  const poolObjects = await multiGetObjects(rpc, uniquePoolIds);
  const pools = poolObjects.map(parsePoolObject).filter(Boolean);
  const ommV2Pools = pools.filter((p) => p.type.includes('::omm_v2::OracleQuoterV2'));
  const oneSidedPools = pools.filter((p) => p.lpSupply !== '0' && (p.balanceA === '0' || p.balanceB === '0'));
  const oneSidedByQuoter = oneSidedPools.reduce((acc, p) => {
    const key = quoterName(p);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const zeroOffsetOneSidedCpmmPools = oneSidedPools
    .filter((p) => p.type.includes('::cpmm::CpQuoter') && cpmmOffset(p) === '0')
    .map((p) => {
      const args = poolTypeArgs(p.type);
      const tokenA = args[0];
      const tokenB = args[1];
      const inputBTokenType = p.balanceA === '0' ? tokenA : tokenB;
      const outputBTokenType = p.balanceA === '0' ? tokenB : tokenA;
      const inputBank = bankInfoByBTokenType.get(normalizeType(inputBTokenType));
      const outputBank = bankInfoByBTokenType.get(normalizeType(outputBTokenType));
      const grossOut = p.balanceA === '0' ? p.balanceB : p.balanceA;
      return {
        objectId: p.objectId,
        type: p.type,
        balanceA: p.balanceA,
        balanceB: p.balanceB,
        lpSupply: p.lpSupply,
        offset: cpmmOffset(p),
        drainDirection: p.balanceA === '0' ? 'A empty: swap A for all B' : 'B empty: swap B for all A',
        inputBTokenType,
        outputBTokenType,
        poolFeeConfig: p.poolFeeConfig,
        protocolFeeConfig: p.protocolFeeConfig,
        oneUnitGrossOut: grossOut,
        oneUnitFeeQuote: feeQuote(grossOut, p.protocolFeeConfig, p.poolFeeConfig),
        inputBank,
        outputBank,
        outputBankFundsAvailable: outputBank && outputBank.bank && outputBank.bank.fundsAvailable,
        outputBankBtokenSupply: outputBank && outputBank.bank && outputBank.bank.btokenSupply,
      };
    });
  const zeroOffsetOneSidedWithOutputBank = zeroOffsetOneSidedCpmmPools.filter((p) => p.outputBank && p.outputBank.bank);
  const zeroOffsetOneSidedWithOutputFunds = zeroOffsetOneSidedCpmmPools.filter((p) => BigInt(p.outputBankFundsAvailable || '0') > 0n);
  const zeroLpPools = pools.filter((p) => p.lpSupply === '0');
  const updateFlagChecks = [];
  for (const p of ommV2Pools.slice(0, 25)) {
    const dfs = await optional(`pool dynamic fields ${p.objectId}`, () => getDynamicFields(rpc, p.objectId, 50, 50));
    updateFlagChecks.push({
      poolId: p.objectId,
      hasUpdateFlag: Array.isArray(dfs) && dfs.some((x) => String(x.name && x.name.type || '').includes('::omm_v2::UpdateFlag')),
      dynamicFieldCount: Array.isArray(dfs) ? dfs.length : null,
      error: dfs.error,
    });
  }
  const newOmmV2Events = await optional('NewOracleQuoterV2 events', () => queryEvents(rpc, `${TARGETS.steamm.originalPackage}::omm_v2::NewOracleQuoterV2`, 50));
  return {
    registry: TARGETS.steamm.registry,
    poolsBag,
    banksBag,
    bankKeyCount: bankFieldRefs.length,
    bankDataCount: bankData.length,
    bankObjectCount: banks.length,
    poolKeyCount: poolFieldRefs.length,
    poolDataCount: poolData.length,
    uniquePoolCount: uniquePoolIds.length,
    ommV2PoolCount: ommV2Pools.length,
    zeroLpPoolCount: zeroLpPools.length,
    oneSidedPoolCount: oneSidedPools.length,
    oneSidedByQuoter,
    zeroOffsetOneSidedCpmmPoolCount: zeroOffsetOneSidedCpmmPools.length,
    zeroOffsetOneSidedWithOutputBankCount: zeroOffsetOneSidedWithOutputBank.length,
    zeroOffsetOneSidedWithOutputFundsCount: zeroOffsetOneSidedWithOutputFunds.length,
    zeroOffsetOneSidedCpmmPools: zeroOffsetOneSidedCpmmPools.slice(0, 50),
    zeroOffsetOneSidedWithOutputFunds: zeroOffsetOneSidedWithOutputFunds.slice(0, 50),
    oneSidedPools: oneSidedPools.slice(0, 25),
    ommV2UpdateFlagSample: updateFlagChecks,
    newOmmV2Events,
  };
}

async function springSuiProbe(rpc) {
  const latestSystemState = await optional('latest system state', () => rpc('suix_getLatestSuiSystemState', []));
  const object = await getObject(rpc, TARGETS.springSui.liquidStakingInfo);
  const f = fields(object);
  const storage = f && f.storage && f.storage.fields;
  const feeConfig = f && f.fee_config && f.fee_config.fields && f.fee_config.fields.element && f.fee_config.fields.element.fields;
  const currentEpoch = latestSystemState && latestSystemState.epoch;
  return {
    objectId: TARGETS.springSui.liquidStakingInfo,
    currentEpoch,
    lastRefreshEpoch: storage && storage.last_refresh_epoch,
    isFreshForCurrentEpoch: currentEpoch !== undefined && storage && String(currentEpoch) === String(storage.last_refresh_epoch),
    suiPool: storage && storage.sui_pool,
    totalSuiSupply: storage && storage.total_sui_supply,
    totalLstSupply: f && f.lst_treasury_cap && f.lst_treasury_cap.fields && f.lst_treasury_cap.fields.total_supply && f.lst_treasury_cap.fields.total_supply.fields && f.lst_treasury_cap.fields.total_supply.fields.value,
    accruedSpreadFees: f && f.accrued_spread_fees,
    fees: f && f.fees,
    validatorCount: storage && Array.isArray(storage.validator_infos) ? storage.validator_infos.length : null,
    feeConfig,
  };
}

async function strategyWrapperProbe(rpc) {
  const eventTypes = [
    `${TARGETS.strategyWrapper.originalPackage}::strategy_wrapper::ConvertedToWrappedCap`,
    `${TARGETS.strategyWrapper.currentPackage}::strategy_wrapper::ConvertedToWrappedCap`,
    `${TARGETS.strategyWrapper.originalPackage}::strategy_wrapper::ReturnedObligationCap`,
    `${TARGETS.strategyWrapper.currentPackage}::strategy_wrapper::ReturnedObligationCap`,
  ];
  const events = {};
  for (const eventType of eventTypes) {
    events[eventType] = await optional(`events ${eventType}`, () => queryEvents(rpc, eventType, 50));
  }
  return { events };
}

async function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const connection = await connectRpc();
  const rpc = makeRpc(connection.url);
  const out = {
    generatedAt: new Date().toISOString(),
    chain: { identifier: connection.chain, latestCheckpoint: connection.checkpoint },
    steamm: await optional('steamm probe', () => steammProbe(rpc)),
    springSui: await optional('springSui probe', () => springSuiProbe(rpc)),
    strategyWrapper: await optional('strategy wrapper probe', () => strategyWrapperProbe(rpc)),
  };
  fs.writeFileSync(OUT_FILE, `${JSON.stringify(out, null, 2)}\n`);
  const steamm = out.steamm || {};
  const spring = out.springSui || {};
  console.log(`wrote ${path.relative(ROOT, OUT_FILE)} at checkpoint ${connection.checkpoint}`);
  console.log(`STEAMM pools: ${steamm.uniquePoolCount || 0}, OMM v2: ${steamm.ommV2PoolCount || 0}, one-sided: ${steamm.oneSidedPoolCount || 0}`);
  console.log(`SpringSui epoch fresh: ${spring.isFreshForCurrentEpoch} (last ${spring.lastRefreshEpoch}, current ${spring.currentEpoch})`);
}

main().catch((err) => {
  console.error(sanitize(err.stack || err.message));
  process.exit(1);
});
