#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT_FILE = path.join(ROOT, 'reports', 'raw', 'steamm-valuable-pool-check.json');

const STEAMM = {
  currentPackage: '0xd8d2601f4a787e732d1e8f017b2bb6b613e4ab2f683ced63296d9e81786d886f',
  originalPackage: '0x4fb1cf45dffd6230305f1d269dd1816678cc8e3ba0b747a813a556921219f261',
  registry: '0x8584948e8c0a2809ec192ede7e030b0a32bd602e5ca6c91bde8dc35fb8b0068d',
};

const VALUABLE_TOKENS = [
  'sui', 'usdc', 'usdt', 'weth', 'eth', 'wbtc', 'btc', 'dai', 'wrapped',
  'fsui', 'vsui', 'afsui', 'hasui', 'lsui', 'staked', 'wormhole',
  'usdy', 'apt', 'sol', 'deep', 'navx', 'cetus'
];

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
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    const json = JSON.parse(text);
    if (json.error) throw new Error(JSON.stringify(json.error));
    return json.result;
  } finally {
    clearTimeout(timeout);
  }
}

function makeRpc(url) {
  let id = 1;
  return async (method, params = []) => {
    return postJson(url, { jsonrpc: '2.0', id: id++, method, params });
  };
}

const OPTIONS = { showType: true, showOwner: true, showContent: true, showBcs: false, showDisplay: false, showPreviousTransaction: false, showStorageRebate: false };

async function getDynamicFields(rpc, id, limit = 50) {
  const out = [];
  let cursor = null;
  do {
    const page = await rpc('suix_getDynamicFields', [id, cursor, limit]);
    out.push(...(page.data || []));
    cursor = page.hasNextPage ? page.nextCursor : null;
  } while (cursor && out.length < 1000);
  return out;
}

async function multiGet(rpc, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    out.push(...await rpc('sui_multiGetObjects', [ids.slice(i, i + 50), OPTIONS]));
  }
  return out;
}

function fields(obj) {
  return obj && obj.data && obj.data.content && obj.data.content.fields;
}

async function main() {
  const rpcUrl = resolveRpcUrl();
  const rpc = makeRpc(rpcUrl);
  const checkpoint = await rpc('sui_getLatestCheckpointSequenceNumber', []);
  console.log(`Checkpoint: ${checkpoint}`);

  // Get registry
  const regObj = await rpc('sui_getObject', [STEAMM.registry, OPTIONS]);
  const regFields = fields(regObj);
  const banksBagId = regFields.banks.fields.id.id;
  const poolsBagId = regFields.pools.fields.id.id;

  // Get bank keys
  const bankKeys = await getDynamicFields(rpc, banksBagId, 100);
  console.log(`Bank keys: ${bankKeys.length}`);

  // Get bank data objects
  const bankDataObjs = await multiGet(rpc, bankKeys.map((x) => x.objectId));
  const bankData = bankDataObjs.map((obj) => {
    const f = fields(obj);
    const inner = f && f.value && f.value.fields || f;
    if (!inner) return null;
    return {
      btokenType: typeof inner.btoken_type === 'object' && inner.btoken_type.fields ? inner.btoken_type.fields.name : String(inner.btoken_type || ''),
      bankId: String(inner.bank_id || ''),
    };
  }).filter(Boolean);

  // Get actual bank objects for funds info
  const uniqueBankIds = [...new Set(bankData.map((x) => x.bankId))];
  console.log(`Unique bank IDs: ${uniqueBankIds.length}`);
  const bankObjs = await multiGet(rpc, uniqueBankIds);
  const bankInfo = new Map();
  for (const obj of bankObjs) {
    const f = fields(obj);
    if (f) bankInfo.set(obj.data.objectId, {
      fundsAvailable: f.funds_available,
      btokenSupply: f.btoken_supply && f.btoken_supply.fields && f.btoken_supply.fields.value,
      minTokenBlockSize: f.min_token_block_size,
    });
  }

  // Map b-token type -> bank funds
  const bTokenToBank = new Map();
  for (const bd of bankData) {
    const info = bankInfo.get(bd.bankId);
    bTokenToBank.set(bd.btokenType.toLowerCase(), { ...bd, funds: info });
  }

  // Print all bank types
  console.log('\n=== ALL BANK B-TOKEN TYPES ===');
  for (const [key, val] of bTokenToBank) {
    const isVal = VALUABLE_TOKENS.some((t) => key.includes(t));
    console.log(`${isVal ? '***' : '   '} ${key} (bank: ${val.bankId.substring(0, 10)}...) funds=${val.funds ? val.funds.fundsAvailable : '?'}`);
  }

  // Get pool keys (grouped by quoter type)
  const poolKeys = await getDynamicFields(rpc, poolsBagId, 100);
  console.log(`\nPool key groups: ${poolKeys.length}`);

  // Get pool set objects
  const poolSetObjs = await multiGet(rpc, poolKeys.map((x) => x.objectId));
  const poolSetData = poolSetObjs.flatMap((obj) => {
    const f = fields(obj);
    const contents = f && (f.contents || (f.value && f.value.fields && f.value.fields.contents));
    if (!Array.isArray(contents)) return [];
    return contents.map((entry) => {
      const val = entry.fields || entry;
      return {
        poolId: val.pool_id,
        quoterType: typeof val.quoter_type === 'object' && val.quoter_type.fields ? val.quoter_type.fields.name : String(val.quoter_type || ''),
        lpTokenType: typeof val.lp_token_type === 'object' && val.lp_token_type.fields ? val.lp_token_type.fields.name : String(val.lp_token_type || ''),
        swapFeeBps: val.swap_fee_bps,
      };
    });
  });

  const uniquePoolIds = [...new Set(poolSetData.map((x) => x.poolId))];
  console.log(`Unique pool IDs: ${uniquePoolIds.length}`);

  // Get all pool objects
  const poolObjs = await multiGet(rpc, uniquePoolIds);
  const pools = poolObjs.map((obj) => {
    const f = fields(obj);
    if (!f) return null;
    return {
      objectId: obj.data.objectId,
      type: obj.data.type,
      balanceA: f.balance_a,
      balanceB: f.balance_b,
      lpSupply: f.lp_supply && f.lp_supply.fields && f.lp_supply.fields.value,
      quoter: f.quoter,
      poolFeeConfig: f.pool_fee_config,
      protocolFees: f.protocol_fees,
    };
  }).filter(Boolean);

  // Extract token types from pool type
  function poolTypeArgs(poolType) {
    const marker = '::pool::Pool<';
    const start = poolType.indexOf(marker);
    if (start < 0 || !poolType.endsWith('>')) return [];
    const inner = poolType.slice(start + marker.length, -1);
    const out = [];
    let s = 0, depth = 0;
    for (let i = 0; i < inner.length; i++) {
      if (inner[i] === '<') depth++;
      if (inner[i] === '>') depth--;
      if (inner[i] === ',' && depth === 0) {
        out.push(inner.slice(s, i).trim());
        s = i + 1;
      }
    }
    out.push(inner.slice(s).trim());
    return out;
  }

  function isValuable(typeStr) {
    const lower = typeStr.toLowerCase();
    return VALUABLE_TOKENS.some((t) => lower.includes(t));
  }

  // Analyze ALL pools for potentially valuable token pairs
  console.log('\n=== POOLS WITH POTENTIALLY VALUABLE TOKENS ===');
  const valuablePools = pools.filter((p) => {
    const args = poolTypeArgs(p.type);
    const tokenA = args[0] || '';
    const tokenB = args[1] || '';
    return isValuable(tokenA) || isValuable(tokenB);
  });

  console.log(`Count: ${valuablePools.length}`);

  for (const p of valuablePools) {
    const args = poolTypeArgs(p.type);
    const tokenA = args[0] || '?';
    const tokenB = args[1] || '?';
    const quoterName = p.quoter && p.quoter.type ? p.quoter.type.split('::').slice(-2).join('::') : '?';
    const offset = p.quoter && p.quoter.fields && p.quoter.fields.offset;
    const isEmpty = p.balanceA === '0' || p.balanceB === '0';
    console.log(`  ${isEmpty ? '*** ONE-SIDED' : '   PAIRED'} | ${p.objectId.substring(0,10)}... | A:${compact(tokenA)} B:${compact(tokenB)} | balA=${p.balanceA} balB=${p.balanceB} | quoter=${quoterName} offset=${offset} | lpSupply=${p.lpSupply}`);
  }

  // Specifically: zero-offset one-sided CPMM pools with valuable tokens
  const exploitCandidates = valuablePools.filter((p) => {
    const args = poolTypeArgs(p.type);
    const quoter = p.quoter;
    if (!quoter || !quoter.type || !quoter.type.includes('::cpmm::CpQuoter')) return false;
    const offset = quoter.fields && quoter.fields.offset;
    if (offset !== '0') return false;
    if (p.lpSupply === '0') return false;
    if (p.balanceA !== '0' && p.balanceB !== '0') return false;
    return true;
  });

  console.log(`\n=== ZERO-OFFSET ONE-SIDED CPMM WITH VALUABLE TOKENS ===`);
  console.log(`Count: ${exploitCandidates.length}`);
  for (const p of exploitCandidates) {
    const args = poolTypeArgs(p.type);
    const tokenA = args[0] || '?';
    const tokenB = args[1] || '?';
    const isEmptyA = p.balanceA === '0';
    const outToken = isEmptyA ? tokenB : tokenA;
    const reserveOut = isEmptyA ? p.balanceB : p.balanceA;
    const outBank = bTokenToBank.get(outToken.toLowerCase());
    const outFunds = outBank && outBank.funds ? outBank.funds.fundsAvailable : 'N/A';
    console.log(`  ${p.objectId} | empty=${isEmptyA ? 'A' : 'B'} | out=${compact(outToken)} | reserve=${reserveOut} | bankFunds=${outFunds}`);
  }

  // Save
  const out = {
    generatedAt: new Date().toISOString(),
    checkpoint,
    bankTypes: [...bTokenToBank.entries()].map(([k, v]) => ({ btokenType: k, bankId: v.bankId, fundsAvailable: v.funds ? v.funds.fundsAvailable : null })),
    totalPools: pools.length,
    cpmmPools: pools.filter((p) => p.type && p.type.includes('::cpmm::')).length,
    valuablePoolCount: valuablePools.length,
    exploitCandidateCount: exploitCandidates.length,
    exploitCandidates: exploitCandidates.map((p) => {
      const args = poolTypeArgs(p.type);
      const isEmptyA = p.balanceA === '0';
      return {
        poolId: p.objectId,
        type: p.type,
        tokenA: args[0], tokenB: args[1],
        balanceA: p.balanceA, balanceB: p.balanceB,
        emptySide: isEmptyA ? 'A' : 'B',
        offset: p.quoter && p.quoter.fields && p.quoter.fields.offset,
        lpSupply: p.lpSupply,
      };
    }),
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${OUT_FILE}`);
}

function compact(type) {
  return String(type || '').split('::').slice(-2).join('::');
}

function resolveRpcUrl() {
  for (const key of ['SUI_RPC_URL', 'SUI_RPC']) {
    if (process.env[key]) return process.env[key];
  }

  if (process.env.SUI_SKIP_RPC_INVENTORY === '1') {
    return 'https://fullnode.mainnet.sui.io:443';
  }

  const endpointsPath = path.join(ROOT, 'rpc_endpoints.txt');
  if (fs.existsSync(endpointsPath)) {
    const lines = fs.readFileSync(endpointsPath, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
      if (/sui/i.test(line) && /^https?:\/\//i.test(line)) return line;
    }
  }

  return 'https://fullnode.mainnet.sui.io:443';
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
