#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CANDIDATE_FILE = path.join(ROOT, 'reports', 'raw', 'suilend-suite-candidate-probe.json');
const OUT_FILE = path.join(ROOT, 'reports', 'raw', 'steamm-candidate-marketability.json');

const STEAMM_REGISTRY = '0x8584948e8c0a2809ec192ede7e030b0a32bd602e5ca6c91bde8dc35fb8b0068d';

const OBJECT_OPTIONS = {
  showType: true,
  showOwner: true,
  showPreviousTransaction: false,
  showDisplay: false,
  showContent: true,
  showBcs: false,
  showStorageRebate: false,
};

function sanitize(text) {
  return String(text || '').replace(/https?:\/\/\S+/g, '[redacted-url]');
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
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${sanitize(text.slice(0, 200))}`);
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
  throw new Error(`No working Sui RPC candidate (${lastError ? sanitize(lastError.message || lastError) : 'unknown error'})`);
}

function makeRpc(url) {
  let id = 100;
  return async function rpc(method, params = []) {
    return postJson(url, { jsonrpc: '2.0', id: id++, method, params });
  };
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

function compact(type) {
  return String(type || '').split('::').slice(-2).join('::');
}

function splitTopLevel(value) {
  const out = [];
  let start = 0;
  let depth = 0;
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

function poolTypeArgs(poolType) {
  const marker = '::pool::Pool<';
  const start = String(poolType || '').indexOf(marker);
  if (start < 0 || !String(poolType || '').endsWith('>')) return [];
  return splitTopLevel(poolType.slice(start + marker.length, -1));
}

function parseBankUnderlying(bank) {
  const type = bank && bank.bank && bank.bank.type || '';
  const match = type.match(/::bank::Bank<([^,]+),\s*([^,]+),\s*([^>]+)>/);
  return match ? match[2].trim() : null;
}

async function getDynamicFields(rpc, id, limit = 100, max = Infinity) {
  const out = [];
  let cursor = null;
  do {
    const page = await rpc('suix_getDynamicFields', [id, cursor, limit]);
    out.push(...(page.data || []));
    cursor = page.hasNextPage ? page.nextCursor : null;
  } while (cursor && out.length < max);
  return out;
}

async function multiGetObjects(rpc, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    out.push(...await rpc('sui_multiGetObjects', [ids.slice(i, i + 50), OBJECT_OPTIONS]));
  }
  return out;
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
  const args = poolTypeArgs(objectResult.data.type);
  return {
    objectId: objectResult.data.objectId,
    type: objectResult.data.type,
    tokenA: args[0] || null,
    tokenB: args[1] || null,
    balanceA: f.balance_a,
    balanceB: f.balance_b,
    lpSupply: f.lp_supply && f.lp_supply.fields && f.lp_supply.fields.value,
    quoter: f.quoter && f.quoter.type ? compact(f.quoter.type) : null,
    offset: f.quoter && f.quoter.fields && f.quoter.fields.offset,
  };
}

async function fetchSteammPools(rpc) {
  const registry = await rpc('sui_getObject', [STEAMM_REGISTRY, OBJECT_OPTIONS]);
  const registryFields = fields(registry);
  const poolsBag = registryFields && registryFields.pools && registryFields.pools.fields && registryFields.pools.fields.id && registryFields.pools.fields.id.id;
  if (!poolsBag) throw new Error('Could not resolve STEAMM pools bag');

  const poolRefs = await getDynamicFields(rpc, poolsBag, 100);
  const poolSetObjects = await multiGetObjects(rpc, poolRefs.map((x) => x.objectId));
  const poolData = poolSetObjects.flatMap(parsePoolDataVecSet);
  const uniquePoolIds = [...new Set(poolData.map((x) => x.poolId))];
  const poolObjects = await multiGetObjects(rpc, uniquePoolIds);
  return poolObjects.map(parsePoolObject).filter(Boolean);
}

function isValuableLikeBToken(type) {
  const lower = normalizeType(type);
  return [
    '::b_sui::b_sui',
    '::b_usdc::b_usdc',
    '::b_usdt::b_usdt',
    '::b_weth::b_weth',
    '::b_wbtc::b_wbtc',
    '::b_btc::b_btc',
    '::b_wal::b_wal',
    '::b_hasui::b_hasui',
    '::b_vsui::b_vsui',
    '::b_afsui::b_afsui',
    '::b_lsui::b_lsui',
    '::b_deep::b_deep',
    '::b_cetus::b_cetus',
    '::b_navx::b_navx',
  ].some((needle) => lower.includes(needle));
}

async function dexScreener(tokenType) {
  const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(tokenType)}`);
  if (!response.ok) return { error: `HTTP ${response.status}`, pairCount: 0, totalLiquidityUsd: 0, bestLiquidityUsd: 0 };
  const json = await response.json();
  const pairs = (json.pairs || []).filter((pair) => pair.chainId === 'sui');
  let totalLiquidityUsd = 0;
  let best = null;
  for (const pair of pairs) {
    const liquidityUsd = Number(pair.liquidity && pair.liquidity.usd || 0);
    totalLiquidityUsd += liquidityUsd;
    if (!best || liquidityUsd > Number(best.liquidity && best.liquidity.usd || 0)) best = pair;
  }
  return {
    pairCount: pairs.length,
    totalLiquidityUsd,
    bestLiquidityUsd: best ? Number(best.liquidity && best.liquidity.usd || 0) : 0,
    bestDex: best && best.dexId,
    bestPair: best && best.pairAddress,
    bestPriceUsd: best && best.priceUsd,
  };
}

function toBigInt(value) {
  try { return BigInt(value || 0); } catch { return 0n; }
}

async function main() {
  const candidateArtifact = JSON.parse(fs.readFileSync(CANDIDATE_FILE, 'utf8'));
  const candidates = candidateArtifact.steamm.zeroOffsetOneSidedCpmmPools.map((candidate) => ({
    poolId: candidate.objectId,
    outputBTokenType: candidate.outputBTokenType,
    outputBTokenCompact: compact(candidate.outputBTokenType),
    outputUnderlyingType: parseBankUnderlying(candidate.outputBank),
    outputUnderlyingCompact: compact(parseBankUnderlying(candidate.outputBank)),
    netOutRaw: candidate.oneUnitFeeQuote && candidate.oneUnitFeeQuote.netOut,
    outputBankFundsAvailable: candidate.outputBankFundsAvailable,
    outputBankBtokenSupply: candidate.outputBankBtokenSupply,
  }));

  const connection = await connectRpc();
  const rpc = makeRpc(connection.url);
  const pools = await fetchSteammPools(rpc);

  const byOutput = new Map(candidates.map((candidate) => [normalizeType(candidate.outputBTokenType), []]));
  for (const pool of pools) {
    for (const side of ['A', 'B']) {
      const token = side === 'A' ? pool.tokenA : pool.tokenB;
      const otherToken = side === 'A' ? pool.tokenB : pool.tokenA;
      const tokenBalance = side === 'A' ? pool.balanceA : pool.balanceB;
      const otherBalance = side === 'A' ? pool.balanceB : pool.balanceA;
      const bucket = byOutput.get(normalizeType(token));
      if (!bucket) continue;
      bucket.push({
        poolId: pool.objectId,
        otherToken,
        otherTokenCompact: compact(otherToken),
        matchedSide: side,
        tokenBalance,
        otherBalance,
        isCandidatePool: candidates.some((candidate) => candidate.poolId === pool.objectId),
        isPaired: tokenBalance !== '0' && otherBalance !== '0',
        otherTokenValuableLike: isValuableLikeBToken(otherToken),
        quoter: pool.quoter,
        offset: pool.offset,
      });
    }
  }

  const dexCache = new Map();
  async function cachedDex(tokenType) {
    if (!tokenType) return { pairCount: 0, totalLiquidityUsd: 0, bestLiquidityUsd: 0 };
    if (!dexCache.has(tokenType)) {
      dexCache.set(tokenType, await dexScreener(tokenType).catch((err) => ({
        error: sanitize(err.message || err),
        pairCount: 0,
        totalLiquidityUsd: 0,
        bestLiquidityUsd: 0,
      })));
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    return dexCache.get(tokenType);
  }

  const ranked = [];
  for (const candidate of candidates) {
    const steammMatches = byOutput.get(normalizeType(candidate.outputBTokenType)) || [];
    const pairedSteammMatches = steammMatches.filter((match) => match.isPaired && !match.isCandidatePool);
    const valuableLikeSteammMatches = pairedSteammMatches.filter((match) => match.otherTokenValuableLike);
    const underlyingDex = await cachedDex(candidate.outputUnderlyingType);
    const bTokenDex = await cachedDex(candidate.outputBTokenType);
    const bestLiquidityUsd = Math.max(underlyingDex.bestLiquidityUsd || 0, bTokenDex.bestLiquidityUsd || 0);
    const status = bestLiquidityUsd > 0
      ? 'dex-priced'
      : valuableLikeSteammMatches.length > 0
        ? 'steamm-route-only'
        : 'unpriced';
    ranked.push({
      ...candidate,
      status,
      bestLiquidityUsd,
      underlyingDex,
      bTokenDex,
      steammMatchCount: steammMatches.length,
      pairedSteammMatchCount: pairedSteammMatches.length,
      valuableLikeSteammMatchCount: valuableLikeSteammMatches.length,
      valuableLikeSteammMatches: valuableLikeSteammMatches.slice(0, 10),
      pairedSteammMatches: pairedSteammMatches.slice(0, 10),
    });
  }

  ranked.sort((a, b) => {
    if (b.bestLiquidityUsd !== a.bestLiquidityUsd) return b.bestLiquidityUsd - a.bestLiquidityUsd;
    if (b.valuableLikeSteammMatchCount !== a.valuableLikeSteammMatchCount) return b.valuableLikeSteammMatchCount - a.valuableLikeSteammMatchCount;
    return Number((toBigInt(b.netOutRaw) - toBigInt(a.netOutRaw)) / 1000000n);
  });

  const out = {
    generatedAt: new Date().toISOString(),
    scanner: 'tools/steamm_candidate_marketability.js',
    scope: 'Read-only STEAMM one-sided zero-offset CPMM marketability ranking',
    safety: {
      rpcInventoryRead: process.env.SUI_SKIP_RPC_INVENTORY !== '1',
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: false,
      signedActionJustified: false,
    },
    chain: { identifier: connection.chain, latestCheckpoint: connection.checkpoint },
    source: path.relative(ROOT, CANDIDATE_FILE),
    steammPoolCount: pools.length,
    candidateCount: ranked.length,
    dexPricedCount: ranked.filter((candidate) => candidate.status === 'dex-priced').length,
    steammRouteOnlyCount: ranked.filter((candidate) => candidate.status === 'steamm-route-only').length,
    unpricedCount: ranked.filter((candidate) => candidate.status === 'unpriced').length,
    summary: {
      steammPoolCount: pools.length,
      candidateCount: ranked.length,
      dexPricedCount: ranked.filter((candidate) => candidate.status === 'dex-priced').length,
      steammRouteOnlyCount: ranked.filter((candidate) => candidate.status === 'steamm-route-only').length,
      unpricedCount: ranked.filter((candidate) => candidate.status === 'unpriced').length,
      bestLiquidityUsd: Math.max(0, ...ranked.map((candidate) => candidate.bestLiquidityUsd || 0)),
      routePositive: 0,
      signedActionJustified: false,
      blocker: 'No DexScreener-priced output token; only internal STEAMM route-only or unpriced outputs remain.',
    },
    ranked,
  };

  fs.writeFileSync(OUT_FILE, `${JSON.stringify(out, null, 2)}\n`);

  console.log(`Wrote ${OUT_FILE}`);
  console.log(`checkpoint=${connection.checkpoint} pools=${pools.length} candidates=${ranked.length}`);
  console.log(`dexPriced=${out.dexPricedCount} steammRouteOnly=${out.steammRouteOnlyCount} unpriced=${out.unpricedCount}`);
  for (const [index, candidate] of ranked.slice(0, 15).entries()) {
    console.log(`${index + 1}\t${candidate.status}\t${candidate.outputBTokenCompact}\tunder=${candidate.outputUnderlyingCompact}\tnet=${candidate.netOutRaw}\tbestLiqUsd=${candidate.bestLiquidityUsd.toFixed(2)}\tsteammValuablePairs=${candidate.valuableLikeSteammMatchCount}\tpool=${candidate.poolId.slice(0, 10)}...`);
  }
}

main().catch((err) => {
  console.error(sanitize(err.stack || err.message || err));
  process.exit(1);
});
