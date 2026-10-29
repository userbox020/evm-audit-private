#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'reports', 'raw');
const OUT_FILE = path.join(OUT_DIR, 'sui-cpmm-hunt.json');

const TARGETS = {
  steamm: {
    currentPackage: '0xd8d2601f4a787e732d1e8f017b2bb6b613e4ab2f683ced63296d9e81786d886f',
    originalPackage: '0x4fb1cf45dffd6230305f1d269dd1816678cc8e3ba0b747a813a556921219f261',
    registry: '0x8584948e8c0a2809ec192ede7e030b0a32bd602e5ca6c91bde8dc35fb8b0068d',
  },
  turbos: {
    package: '0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1',
  },
  knownDexes: {
    cetus: ['0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb',
            '0x95b8e028e35a5ef8366c1ca91f9013f3e2f176a230c287c0aa9a8b7020ae8cf8',
            '0x5fada2ea3f2a60b177008aa89e3486f5bac88db5cdebd41ec1b1173186cdb353'],
    aftermath: ['0xc4049b2d1cc0f6e017fda8260b4378cecd236bd9b54de01c5584b79e07f87c43',
                '0x1c7a8e4497135aca7e0ec3e5a8e1bb12d8d476f76b1b6e2c2bdc46f5d57c2ade'],
    flowx: ['0xba153169476e8c3114962261d1edc70de5ad9781b83cc617ecca8c1924c3ec4e',
            '0x9ab76c5c4e64863c2e4b7ab881890221d40c6cc18680a4de6e2e2768327800e1'],
    kriya: ['0xa0eba10b173538b8b7020b28ad60bd8f0a4a5c2c4702068df80c4b0b6f0e3814',
            '0x6c5b0963bdd4be511318a25b70317b2c97237e1a08f1b227ec4cbc26a91d1d4c'],
    bluemove: ['0x3b3c62c2a0ce7c064fa8dfbae7f335d7ed5b1a51ba5d82a7e2980f5c3dafae02',
               '0xb1bb7f2c312e87e3c3f9e9584d25d4b388d1a975c4fe239b6973660ab9924bbe'],
    deepbook: ['0xdee9a24b5c8b7f7fea3b4bd7cb85e69eadeac8465e376dbfa1e0f6691e49fd71'],
    haedal: ['0x4b166a9e2f8f7515b607684106ad08239ef7d620e064addc94f1c83141a1afc8'],
    suiSwap: ['0xf0e4dda3975be6e3f1ebfb77b189985096444da4aaecdeb0f3bad90edc97fd98',
              '0x78d96ef7f46e7cc6c0633e16e81b4ec49b33f6d4ccef4b284ec76ae58ed01f6b'],
  },
};

const OBJECT_OPTIONS = {
  showType: true,
  showOwner: true,
  showContent: true,
  showBcs: false,
  showDisplay: false,
  showPreviousTransaction: false,
  showStorageRebate: false,
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
  if (fs.existsSync(rpcFile)) {
    const lines = fs.readFileSync(rpcFile, 'utf8').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    for (const line of lines) {
      if (/sui/i.test(line) && /^https?:\/\//i.test(line)) candidates.push(line);
    }
  }

  candidates.push('https://fullnode.mainnet.sui.io:443');
  return [...new Set(candidates)];
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
  throw new Error(`No working Sui RPC candidate (${lastError ? sanitize(lastError.message || lastError) : 'unknown error'})`);
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

function makeRpc(url) {
  let id = 100;
  return async function rpc(method, params = []) {
    return postJson(url, { jsonrpc: '2.0', id: id++, method, params });
  };
}

async function optional(label, fn) {
  try { return await fn(); }
  catch (err) { return { error: `${label}: ${sanitize(err.message || err)}` }; }
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

// === STEAMM CPMM probing ===
function parsePoolDataVecSet(objectResult) {
  const f = fields(objectResult);
  const contents = f && (
    f.contents || (f.value && f.value.fields && f.value.fields.contents) ||
    (f.contents && f.contents.fields && f.contents.fields.contents)
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

function parseSteammPool(objectResult) {
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
    lpToken: f.lp_token,
    bankA: f.bank_a,
    bankB: f.bank_b,
    owner: objectResult.data.owner,
  };
}

function cpmmOffset(pool) {
  if (!pool.type || !pool.type.includes('::cpmm::CpQuoter')) return null;
  return pool.quoter && pool.quoter.fields && pool.quoter.fields.offset;
}

async function steammFreshProbe(rpc) {
  const checkpoint = await rpc('sui_getLatestCheckpointSequenceNumber', []);
  const registry = await getObject(rpc, TARGETS.steamm.registry);
  const registryFields = fields(registry);
  const poolsBag = registryFields && registryFields.pools && registryFields.pools.fields &&
    registryFields.pools.fields.id && registryFields.pools.fields.id.id;
  const banksBag = registryFields && registryFields.banks && registryFields.banks.fields &&
    registryFields.banks.fields.id && registryFields.banks.fields.id.id;

  // Get bank info for token type resolution
  const bankFieldRefs = banksBag ? await getDynamicFields(rpc, banksBag, 100) : [];
  const bankDataObjects = await multiGetObjects(rpc, bankFieldRefs.map((x) => x.objectId));
  const bankData = bankDataObjects.map((obj) => {
    const raw = fields(obj);
    const f = raw && raw.value && raw.value.fields || raw;
    if (!f) return null;
    return { bankId: asId(f.bank_id), btokenType: typeName(f.btoken_type) };
  }).filter(Boolean);
  const bankObjects = await multiGetObjects(rpc, [...new Set(bankData.map((x) => x.bankId).filter(Boolean))]);
  const bankFunds = new Map();
  for (const obj of bankObjects) {
    const f = fields(obj);
    if (f) bankFunds.set(obj.data.objectId, {
      fundsAvailable: f.funds_available,
      btokenSupply: f.btoken_supply && f.btoken_supply.fields && f.btoken_supply.fields.value,
    });
  }
  const bankByBTokenType = new Map();
  for (const data of bankData) {
    const funds = bankFunds.get(data.bankId);
    bankByBTokenType.set(normalizeType(data.btokenType), { ...data, funds });
  }

  // Get all pools
  const poolFieldRefs = poolsBag ? await getDynamicFields(rpc, poolsBag, 100) : [];
  const poolSetObjects = await multiGetObjects(rpc, poolFieldRefs.map((x) => x.objectId));
  const poolData = poolSetObjects.flatMap(parsePoolDataVecSet);
  const uniquePoolIds = [...new Set(poolData.map((x) => x.poolId))];
  const poolObjects = await multiGetObjects(rpc, uniquePoolIds);
  const pools = poolObjects.map(parseSteammPool).filter(Boolean);

  // Categorize
  const allPools = pools;
  const cpmmPools = pools.filter((p) => p.type && p.type.includes('::cpmm::'));
  const ommV2Pools = pools.filter((p) => p.type && p.type.includes('::omm_v2::'));
  const oneSidedPools = pools.filter((p) => p.lpSupply !== '0' && (p.balanceA === '0' || p.balanceB === '0'));
  const zeroOffsetOneSidedCpmm = oneSidedPools
    .filter((p) => p.type && p.type.includes('::cpmm::CpQuoter') && cpmmOffset(p) === '0');

  // For each zero-offset one-sided CPMM pool, compute drain potential
  const drainAnalysis = zeroOffsetOneSidedCpmm.map((p) => {
    const typeArgs = poolTypeArgs(p.type);
    const tokenA = typeArgs[0] || '?';
    const tokenB = typeArgs[1] || '?';
    const isEmptyA = p.balanceA === '0';
    const reserveOut = isEmptyA ? BigInt(p.balanceB) : BigInt(p.balanceA);
    const outTokenType = isEmptyA ? tokenB : tokenA;
    const inTokenType = isEmptyA ? tokenA : tokenB;
    const outBank = bankByBTokenType.get(normalizeType(outTokenType));
    const inBank = bankByBTokenType.get(normalizeType(inTokenType));
    return {
      poolId: p.objectId,
      emptySide: isEmptyA ? 'A' : 'B',
      balanceA: p.balanceA,
      balanceB: p.balanceB,
      lpSupply: p.lpSupply,
      offset: cpmmOffset(p),
      inputToken: compactType(inTokenType),
      outputToken: compactType(outTokenType),
      reserveOutRaw: p.balanceA === '0' ? p.balanceB : p.balanceA,
      outputBankFundsAvailable: outBank && outBank.funds && outBank.funds.fundsAvailable,
      poolFeeConfig: p.poolFeeConfig,
      protocolFeeConfig: p.protocolFeeConfig,
    };
  });

  // Quoter type breakdown
  const quoterCounts = {};
  for (const p of pools) {
    const qt = quoterName(p);
    quoterCounts[qt] = (quoterCounts[qt] || 0) + 1;
  }

  return {
    checkpoint,
    registry: TARGETS.steamm.registry,
    totalPools: allPools.length,
    cpmmPoolCount: cpmmPools.length,
    ommV2PoolCount: ommV2Pools.length,
    oneSidedPoolCount: oneSidedPools.length,
    zeroOffsetOneSidedCpmmCount: zeroOffsetOneSidedCpmm.length,
    quoterCounts,
    drainAnalysis: drainAnalysis.slice(0, 100),
  };
}

function quoterName(pool) {
  const qt = pool.quoter && pool.quoter.type || '';
  const parts = qt.split('::');
  return parts.length >= 2 ? `${parts[parts.length - 2]}::${parts[parts.length - 1]}` : qt;
}

function compactType(type) {
  return String(type || '').split('::').slice(-2).join('::');
}

function poolTypeArgs(poolType) {
  const marker = '::pool::Pool<';
  const start = poolType.indexOf(marker);
  if (start < 0 || !poolType.endsWith('>')) return [];
  return splitTopLevel(poolType.slice(start + marker.length, -1));
}

function splitTopLevel(value) {
  const out = [];
  let start = 0, depth = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '<') depth++;
    if (value[i] === '>') depth--;
    if (value[i] === ',' && depth === 0) {
      out.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(value.slice(start).trim());
  return out;
}

// === Searching for other CPMM protocols ===
async function searchDexModules(rpc) {
  const results = {};
  for (const [dexName, packageIds] of Object.entries(TARGETS.knownDexes)) {
    const dexResult = { modules: [], error: null, cpmmLike: [] };
    for (const pkgId of packageIds) {
      try {
        const modules = await rpc('sui_getNormalizedMoveModulesByPackage', [pkgId]);
        const moduleNames = Object.keys(modules);
        dexResult.modules.push({ packageId: pkgId, moduleNames });
        // Check for CPMM-like modules
        for (const modName of moduleNames) {
          const lower = modName.toLowerCase();
          if (lower.includes('cpmm') || lower.includes('constant_product') ||
              lower.includes('constantproduct') || lower.includes('xyk') ||
              lower.includes('amm') || lower.includes('pool')) {
            dexResult.cpmmLike.push({ packageId: pkgId, module: modName });
          }
        }
      } catch (err) {
        dexResult.error = sanitize(err.message);
      }
    }
    results[dexName] = dexResult;
  }
  return results;
}

// === Search events for CPMM-related types ===
async function searchCpmmEvents(rpc) {
  const searchPatterns = [
    // STEAMM events
    `${TARGETS.steamm.currentPackage}::cpmm::SwapEvent`,
    `${TARGETS.steamm.originalPackage}::cpmm::SwapEvent`,
    `${TARGETS.steamm.currentPackage}::cpmm::PoolCreated`,
    `${TARGETS.steamm.originalPackage}::cpmm::PoolCreated`,
    // General patterns - try known module naming
    // Note: suix_queryEvents requires exact event type, can't wildcard
  ];
  const events = {};
  for (const pattern of searchPatterns) {
    events[pattern] = await optional(`events ${compactType(pattern)}`, () => queryEvents(rpc, pattern, 10));
  }
  return events;
}

// === Check recent STEAMM CPMM pool creation events ===
async function checkNewSteammPools(rpc) {
  const oldCheckpoint = 278564193;
  const currentCheckpoint = await rpc('sui_getLatestCheckpointSequenceNumber', []);
  return {
    oldCheckpoint,
    currentCheckpoint,
    checkpointsElapsed: currentCheckpoint - oldCheckpoint,
    approxTimeElapsedMinutes: ((currentCheckpoint - oldCheckpoint) * 0.5).toFixed(1),
  };
}

async function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const connection = await connectRpc();
  const rpc = makeRpc(connection.url);
  const chain = connection.chain;

  const steammFresh = await optional('steamm fresh probe', () => steammFreshProbe(rpc));
  const dexModules = await optional('dex module search', () => searchDexModules(rpc));
  const cpmmEvents = await optional('cpmm event search', () => searchCpmmEvents(rpc));
  const checkpointInfo = await optional('checkpoint delta', () => checkNewSteammPools(rpc));

  const out = {
    generatedAt: new Date().toISOString(),
    chain,
    checkpointInfo,
    steammFresh,
    dexModules,
    cpmmEvents,
  };

  fs.writeFileSync(OUT_FILE, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`wrote ${OUT_FILE}`);

  // Summary
  if (steammFresh && !steammFresh.error) {
    const s = steammFresh;
    console.log(`\n=== STEAMM STATUS ===`);
    console.log(`Total pools: ${s.totalPools} | CPMM: ${s.cpmmPoolCount} | OMMv2: ${s.ommV2PoolCount}`);
    console.log(`One-sided pools: ${s.oneSidedPoolCount} | Zero-offset one-sided CPMM: ${s.zeroOffsetOneSidedCpmmCount}`);
    console.log(`\nQuoters:`, JSON.stringify(s.quoterCounts));
    if (s.drainAnalysis && s.drainAnalysis.length > 0) {
      console.log(`\n=== DRAINABLE CPMM POOLS (zero offset, one side empty) ===`);
      for (const d of s.drainAnalysis) {
        console.log(`  ${d.poolId} | ${d.emptySide} empty | out=${d.outputToken} | reserve=${d.reserveOutRaw} | bankFunds=${d.outputBankFundsAvailable}`);
      }
    }
  }

  if (dexModules && !dexModules.error) {
    console.log(`\n=== DEX MODULE SCAN ===`);
    for (const [dexName, result] of Object.entries(dexModules)) {
      if (result.cpmmLike.length > 0) {
        console.log(`  ${dexName}: CPMM-like modules:`, result.cpmmLike.map((x) => `${x.packageId.substring(0,10)}...::${x.module}`));
      } else if (result.modules.length === 0) {
        console.log(`  ${dexName}: ${result.error || 'no modules found'}`);
      } else {
        const allModules = result.modules.flatMap((x) => x.moduleNames);
        console.log(`  ${dexName}: ${allModules.length} modules, no CPMM-like`);
      }
    }
  }
}

main().catch((err) => {
  console.error(sanitize(err.stack || err.message));
  process.exit(1);
});
