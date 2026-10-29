/**
 * Bounded read-only verification: PendleChainlinkOracleFactory deployed instances.
 *
 * Security hygiene: rpc_endpoints.txt is read in-process only. Endpoint values,
 * hosts, keys and raw transports are never printed, hashed, or persisted.
 * Provider identities are reported as anonymized family labels (F1, F2, ...).
 *
 * Read-only: eth_chainId / eth_blockNumber / eth_getCode / eth_call / eth_getLogs.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { keccak256, toUtf8Bytes, dataSlice, dataLength, toBeHex, getAddress, AbiCoder } = require(path.join(
  __dirname, '..', '.audit-tools', 'node', 'node_modules', 'ethers'
));

const ROOT = path.resolve(__dirname, '..');
const INVENTORY = path.join(ROOT, 'rpc_endpoints.txt');

const FACTORY = '0x6502cda86f9110f3655512237C9FF2B9CE247c69';
const CHAINS = { 1: 'Ethereum', 42161: 'Arbitrum', 8453: 'Base', 999: 'Hyperliquid', 56: 'BSC', 10: 'Optimism', 80094: 'Berachain', 5000: 'Mantle', 9745: 'Plasma', 146: 'Sonic' };

function loadInventory() {
  const text = fs.readFileSync(INVENTORY, 'utf8');
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z][A-Za-z0-9 ._()/-]*?)\s+(https?:\/\/\S+)\s*(\[.*\])?$/);
    if (!m) continue;
    rows.push({ label: m[1].trim(), url: m[2], tag: m[3] || '' });
  }
  return rows;
}

function familyOf(url) {
  try { return new URL(url).hostname.split('.').slice(-3).join('.'); } catch { return 'invalid'; }
}

async function rpc(url, method, params, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error('http_' + res.status);
    const json = JSON.parse(text);
    if (json.error) throw new Error('rpc:' + (json.error.code || '') + ':' + String(json.error.message || '').slice(0, 90));
    return json.result;
  } finally {
    clearTimeout(t);
  }
}

function sanitize(msg) {
  return String(msg)
    .replace(/https?:\/\/\S+/g, '[redacted-url]')
    .replace(/[a-z0-9-]+\.(alchemy|infura|drpc|nodies|quiknode|publicnode|gateway|goldsky|merkle|blockpi|llamarpc|1rpc|ankr)\.[a-z.]+/gi, '[redacted-host]');
}

async function selectEndpoints(chainLabel, want, opts = {}) {
  const ALIASES = {
    Hyperliquid: ['Hyperliquid', 'Purroof', 'Sentio', 'Nodeflare', 'Pinax', 'OnFinality'],
    Arbitrum: ['Arbitrum', 'Arbitrum (official)', 'Arbitrum One (42161)'],
    Optimism: ['Optimism', 'Optimism (official)'],
  };
  const labels = ALIASES[chainLabel] || [chainLabel];
  const rows = loadInventory().filter((r) => labels.some((l) => r.label === l || r.label.startsWith(l + ' ')));
  const seenFamily = new Set();
  const out = [];
  const tested = [];
  for (const r of rows) {
    const fam = familyOf(r.url);
    if (seenFamily.has(fam)) continue;
    seenFamily.add(fam);
    tested.push(fam);
    try {
      const cid = await rpc(r.url, 'eth_chainId', []);
      if (!cid) continue;
      if (opts.requireArchive) {
        // lightweight: historical code read far back
        const code = await rpc(r.url, 'eth_getCode', [FACTORY, opts.probeBlock || '0x1']);
        if (!code) continue;
      }
      out.push({ url: r.url, family: fam, chainId: parseInt(cid, 16), label: 'F' + tested.length });
      if (out.length >= want && !opts.preferWideLogs) break;
    } catch (e) {
      // record failure only as sanitized class
    }
  }
  if (opts.preferWideLogs && out.length) {
    const want2 = parseInt(process.env.PENDLE_PROBE_SPAN || '5000000', 10);
    for (const s of out) {
      try {
        const head = parseInt(await rpc(s.url, 'eth_blockNumber', []), 16);
        const from = Math.max(0, head - want2);
        await rpc(s.url, 'eth_getLogs', [{ address: FACTORY, fromBlock: qty(from), toBlock: qty(head), topics: [[TOPICS.OracleCreated, TOPICS.OracleWithQuoteCreated]] }], 60000);
        s.logWidth = want2;
      } catch (e) {
        const m = /(?:exceeds (?:limit of|max block range) |maximum allowed is |limit of )(\d+)/i.exec(e.message);
        s.logWidth = m ? parseInt(m[1], 10) : (s.logWidth || 0);
      }
    }
    out.sort((a, b) => (b.logWidth || 0) - (a.logWidth || 0));
    if (process.env.PENDLE_PRIMARY_ONLY === '1' && out.length > 1) out.splice(1);
  }
  return { out, tested: tested.length };
}

const SELECTORS = {
  pyLpOracle: keccak256(toUtf8Bytes('pyLpOracle()')).slice(0, 10),
  market: keccak256(toUtf8Bytes('market()')).slice(0, 10),
  twapDuration: keccak256(toUtf8Bytes('twapDuration()')).slice(0, 10),
  baseOracleType: keccak256(toUtf8Bytes('baseOracleType()')).slice(0, 10),
  quoteOracle: keccak256(toUtf8Bytes('quoteOracle()')).slice(0, 10),
  decimals: keccak256(toUtf8Bytes('decimals()')).slice(0, 10),
  description: keccak256(toUtf8Bytes('description()')).slice(0, 10),
  factory: keccak256(toUtf8Bytes('factory()')).slice(0, 10),
};

const TOPICS = {
  OracleCreated: keccak256(toUtf8Bytes('OracleCreated(address,uint32,uint8,address,bytes32)')),
  OracleWithQuoteCreated: keccak256(toUtf8Bytes('OracleWithQuoteCreated(address,uint32,uint8,address,address,bytes32)')),
};

const coder = AbiCoder.defaultAbiCoder();

function decUint(slot) { return BigInt(slot); }
function decAddr(slot) { return getAddress('0x' + slot.slice(26)); }
function qty(n) { const b = BigInt(n); return '0x' + (b === 0n ? '0' : b.toString(16)); }
function decodeString(hex) {
  if (!hex || hex === '0x') return null;
  try { return coder.decode(['string'], hex)[0]; } catch { return null; }
}
function decodeRound(hex) {
  if (!hex || hex === '0x') return null;
  const [roundId, answer, startedAt, updatedAt, answeredInRound] = coder.decode(['uint80', 'int256', 'uint256', 'uint256', 'uint80'], hex);
  return { roundId: roundId.toString(), answer: answer.toString(), startedAt: startedAt.toString(), updatedAt: updatedAt.toString(), answeredInRound: answeredInRound.toString() };
}

async function main() {
  const mode = process.argv[2] || 'probe';
  const chainId = parseInt(process.argv[3] || '1', 10);
  const chainLabel = CHAINS[chainId];
  const out = { schema: 'pendle-chainlink-oracle-instance-verification/v1', mode, chainId, factory: FACTORY, addresses: {}, results: {}, notes: [] };

  if (mode === 'probe') {
    const sel = await selectEndpoints(chainLabel, 3, { requireArchive: true, probeBlock: '0x1' });
    out.endpointFamiliesConsidered = sel.tested;
    out.endpointFamiliesSelected = sel.out.length;
    const primary = sel.out[0];
    if (!primary) { out.results.error = 'no_working_endpoint'; console.log(JSON.stringify(out, null, 2)); return; }
    if (primary.chainId !== chainId) { out.results.error = 'chain_id_mismatch'; console.log(JSON.stringify(out, null, 2)); return; }

    const code = await rpc(primary.url, 'eth_getCode', [FACTORY, 'latest']);
    out.results.codeSize = dataLength(code);
    out.results.codeHash = keccak256(code);
    out.results.factoryIsContract = out.results.codeSize > 0;
    if (!out.results.factoryIsContract) { console.log(JSON.stringify(out, null, 2)); return; }

    // pyLpOracle() immutable
    try {
      const r = await rpc(primary.url, 'eth_call', [{ to: FACTORY, data: SELECTORS.pyLpOracle }, 'latest']);
      out.addresses.pyLpOracle = decAddr(r).toLowerCase();
    } catch (e) { out.notes.push('pyLpOracle call failed: ' + sanitize(e.message)); }

    // topic probes against latest block by scanning a tiny range (latest 5 blocks) - just to be safe returns []
    out.topics = TOPICS;

    // deployment block binary search via code presence
    const head = parseInt(await rpc(primary.url, 'eth_blockNumber', []), 16);
    out.results.head = head;
    let lo = 0, hi = head;
    // confirm code at head
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const c = await rpc(primary.url, 'eth_getCode', [FACTORY, qty(mid)]);
      if (c && c !== '0x') hi = mid; else lo = mid + 1;
    }
    out.results.deploymentBlock = lo;
    out.addresses.factory = FACTORY;

    // event topic sanity: getLogs full range for both topics
    const ranges = [];
    try {
      const logsIn = await rpc(primary.url, 'eth_getLogs', [{ address: FACTORY, fromBlock: qty(lo), toBlock: 'latest', topics: [[TOPICS.OracleCreated, TOPICS.OracleWithQuoteCreated]] }], 60000);
      out.results.fullRangeSupported = true;
      ranges.push({ from: lo, to: head, count: logsIn.length, via: 'primary-full-range' });
      out.results.sampleLogCount = logsIn.length;
    } catch (e) {
      out.results.fullRangeSupported = false;
      out.notes.push('full-range logs failed: ' + sanitize(e.message));
    }
    out.results.ranges = ranges;
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (mode === 'logcap') {
    // Probes each candidate family for eth_getLogs width using a synthetic 1M-block window.
    const span = parseInt(process.argv[4] || '1000000', 10);
    const head = parseInt(await (async () => {
      const rows = loadInventory().filter((r) => r.label === chainLabel || r.label.startsWith(chainLabel + ' '));
      for (const r of rows) { try { return await rpc(r.url, 'eth_blockNumber', []); } catch { /* next */ } }
      return '0x0';
    })(), 16);
    const rows = loadInventory().filter((r) => r.label === chainLabel || r.label.startsWith(chainLabel + ' '));
    const seen = new Set();
    out.results.probes = [];
    for (const r of rows) {
      const fam = familyOf(r.url);
      if (seen.has(fam)) continue; seen.add(fam);
      const rec = { label: 'F' + (out.results.probes.length + 1) };
      try {
        const cid = parseInt(await rpc(r.url, 'eth_chainId', []), 16);
        rec.chainId = cid;
        if (cid !== chainId) { rec.skip = 'chain_mismatch'; out.results.probes.push(rec); continue; }
      } catch (e) { rec.error = sanitize(e.message); out.results.probes.push(rec); continue; }
      const from = Math.max(0, head - span);
      try {
        const logs = await rpc(r.url, 'eth_getLogs', [{ address: FACTORY, fromBlock: qty(from), toBlock: qty(head), topics: [[TOPICS.OracleCreated, TOPICS.OracleWithQuoteCreated]] }], 90000);
        rec.width = span; rec.logs = logs.length; rec.ok = true;
      } catch (e) {
        const m = /(?:exceeds (?:limit of|max block range) |maximum allowed is |limit of )(\d+)/i.exec(e.message);
        rec.allowed = m ? parseInt(m[1], 10) : null;
        rec.error = sanitize(e.message);
      }
      out.results.probes.push(rec);
    }
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (mode === 'blockcheck') {
    const blocks = (process.argv[4] || '0x1').split(',');
    const sel = await selectEndpoints(chainLabel, 2, { requireArchive: true, probeBlock: '0x1' });
    out.results.checks = [];
    for (const s of sel.out) {
      const per = { label: s.label, chainId: s.chainId, codeAt: {} };
      for (const b of blocks) {
        try { per.codeAt[b] = ((dataLength(await rpc(s.url, 'eth_getCode', [FACTORY, qty(b)])) - 2) / 2); }
        catch (e) { per.codeAt[b] = 'ERR:' + sanitize(e.message); }
      }
      out.results.checks.push(per);
    }
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (mode === 'enumerate') {
    const sel = await selectEndpoints(chainLabel, 3, { preferWideLogs: true });
    out.endpointFamiliesSelected = sel.out.length;
    if (!sel.out.length) { out.results.error = 'no_working_endpoint'; console.log(JSON.stringify(out, null, 2)); return; }
    const url = sel.out[0].url;
    const head = parseInt(await rpc(url, 'eth_blockNumber', []), 16);
    const code = await rpc(url, 'eth_getCode', [FACTORY, 'latest']);
    out.results.codeSize = dataLength(code);
    if (out.results.codeSize === 0) { out.results.error = 'no_code'; console.log(JSON.stringify(out, null, 2)); return; }

    // deployment block (needs archive-capable endpoint)
    let lo = 0;
    if (process.env.PENDLE_FROM_BLOCK) {
      lo = parseInt(process.env.PENDLE_FROM_BLOCK, 10);
      out.results.fromBlockSource = 'supplied';
    } else {
      let found = false;
      for (const s of sel.out) {
        try {
          let a = 0, b = head;
          while (a < b) {
            const mid = Math.floor((a + b) / 2);
            const c = await rpc(s.url, 'eth_getCode', [FACTORY, qty(mid)]);
            if (c && c !== '0x') b = mid; else a = mid + 1;
          }
          if (a <= head) {
            // sanity: no code just before, code at a
            const before = await rpc(s.url, 'eth_getCode', [FACTORY, qty(Math.max(0, a - 1))]);
            if (before === '0x' && a > 0) { lo = a; found = true; out.results.fromBlockSource = s.label; break; }
          }
        } catch (e) { out.notes.push('search ' + s.label + ': ' + sanitize(e.message)); }
      }
      if (!found) { out.results.error = 'deployment_block_unavailable'; console.log(JSON.stringify(out, null, 2)); return; }
    }
    out.results.fromBlock = lo; out.results.head = head;

    const maxFamilies = parseInt(process.env.PENDLE_MAX_FAMILIES || '2', 10);
    const all = [];
    const failed = [];
    let coverageMeta = null;
    let chosen = null;
    for (const s of sel.out.slice(0, maxFamilies)) {
      const url = s.url;
      const got = [];
      let complete = true;
      let chunk = parseInt(process.env.PENDLE_LOG_CHUNK || '0', 10) || s.logWidth || 20000;
      let cursor = lo;
      let guard = 0;
      while (cursor <= head && guard++ < 200000) {
        const end = Math.min(cursor + chunk - 1, head);
        try {
          const logs = await rpc(url, 'eth_getLogs', [{ address: FACTORY, fromBlock: qty(cursor), toBlock: qty(end), topics: [[TOPICS.OracleCreated, TOPICS.OracleWithQuoteCreated]] }], 60000);
          got.push(...logs);
        } catch (e) {
          const m = /maximum allowed is (\d+)/.exec(e.message);
          if (m && chunk > 100) { chunk = parseInt(m[1], 10); continue; }
          if (chunk > 200) { chunk = Math.max(200, Math.floor(chunk / 2)); continue; }
          complete = false; failed.push(sanitize(e.message)); cursor = end + 1; continue;
        }
        cursor = end + 1;
      }
      if (!chosen) { chosen = s; all.push(...got); coverageMeta = { mode: 'chunked-adaptive', finalChunk: chunk, from: lo, to: head, complete }; }
      out.results.perFamily = out.results.perFamily || [];
      out.results.perFamily.push({ label: s.label, count: got.length, complete, distinctTx: new Set(got.map((l) => l.transactionHash)).size });
    }
    out.notes.push(...failed.slice(0, 20));

    out.results.coverage = coverageMeta;
    out.results.logCount = all.length;    out.results.logs = all.map((l) => {
      const t0 = l.topics[0];
      if (t0 === TOPICS.OracleWithQuoteCreated) {
        const market = decAddr(l.topics[1]).toLowerCase();
        const twap = Number(BigInt(l.topics[2]));
        const baseType = Number(BigInt(l.topics[3]));
        const [quoteOracle, oracle, oracleId] = coder.decode(['address', 'address', 'bytes32'], l.data);
        return { kind: 'WithQuote', block: parseInt(l.blockNumber, 16), tx: l.transactionHash, market, twapDuration: twap, baseOracleType: baseType, quoteOracle: quoteOracle.toLowerCase(), oracle: oracle.toLowerCase(), oracleId };
      }
      const market = decAddr(l.topics[1]).toLowerCase();
      const twap = Number(BigInt(l.topics[2]));
      const baseType = Number(BigInt(l.topics[3]));
      const [oracle, oracleId] = coder.decode(['address', 'bytes32'], l.data);
      return { kind: 'Plain', block: parseInt(l.blockNumber, 16), tx: l.transactionHash, market, twapDuration: twap, baseOracleType: baseType, oracle: oracle.toLowerCase(), oracleId };
    });
    if (process.env.PENDLE_DUMP) fs.writeFileSync(process.env.PENDLE_DUMP, JSON.stringify(out.results.logs, null, 2));
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (mode === 'inspect') {
    const listFile = process.argv[4];
    const list = JSON.parse(fs.readFileSync(listFile, 'utf8'));
    const sel = await selectEndpoints(chainLabel, 2);
    if (!sel.out.length) { out.results.error = 'no_working_endpoint'; console.log(JSON.stringify(out, null, 2)); return; }
    const url = sel.out[0].url;
    const rows = [];
    for (const inst of list) {
      const rec = { oracle: inst.oracle.toLowerCase(), kind: inst.kind, block: inst.block, tx: inst.tx };
      async function call(to, data, block = 'latest') { return rpc(url, 'eth_call', [{ to, data }, block]); }
      try {
        const [m, t, b] = await Promise.all([
          call(inst.oracle, SELECTORS.market),
          call(inst.oracle, SELECTORS.twapDuration),
          call(inst.oracle, SELECTORS.baseOracleType),
        ]);
        rec.market = decAddr(m).toLowerCase();
        rec.twapDuration = Number(BigInt(t));
        rec.baseOracleType = Number(BigInt(b));
      } catch (e) { rec.error = sanitize(e.message); rows.push(rec); continue; }
      try {
        const f = await call(inst.oracle, SELECTORS.factory);
        rec.factory = decAddr(f).toLowerCase();
      } catch (e) { rec.factory = null; }
      if (inst.kind === 'WithQuote') {
        try {
          const q = decAddr(await call(inst.oracle, SELECTORS.quoteOracle)).toLowerCase();
          rec.quoteOracle = q;
          const qd = await call(q, SELECTORS.decimals);
          rec.quoteOracleDecimals = Number(BigInt(qd));
          try { rec.quoteOracleDescription = decodeString(await call(q, SELECTORS.description)); } catch (e) { rec.quoteOracleDescriptionError = sanitize(e.message); }
          try { rec.quoteOracleVersion = Number(BigInt(await call(q, keccak256(toUtf8Bytes('version()')).slice(0, 10)))); } catch (e) { /* optional */ }
          try { rec.quoteOracleLatestRoundData = decodeRound(await call(q, keccak256(toUtf8Bytes('latestRoundData()')).slice(0, 10))); } catch (e) { rec.quoteOracleLatestRoundDataError = sanitize(e.message); }
        } catch (e) { rec.quoteOracleError = sanitize(e.message); }
      }
      try {
        rec.oracleDecimals = Number(BigInt(await call(inst.oracle, SELECTORS.decimals)));
        rec.oracleLatestRoundData = decodeRound(await call(inst.oracle, keccak256(toUtf8Bytes('latestRoundData()')).slice(0, 10)));
      } catch (e) { rec.oracleLatestRoundDataError = sanitize(e.message); }
      // market tokens
      try {
        const readTokens = keccak256(toUtf8Bytes('readTokens()')).slice(0, 10);
        const rt = await call(rec.market, readTokens);
        const [sy, pt, yt] = coder.decode(['address', 'address', 'address'], rt);
        rec.sy = sy.toLowerCase(); rec.pt = pt.toLowerCase(); rec.yt = yt.toLowerCase();
        const assetInfo = keccak256(toUtf8Bytes('assetInfo()')).slice(0, 10);
        try {
          const ai = await call(rec.sy, assetInfo);
          const dec = coder.decode(['address', 'address', 'uint8'], ai);
          rec.syAsset = dec[0].toLowerCase(); rec.syAssetAddr = dec[1].toLowerCase(); rec.syAssetDecimals = Number(dec[2]);
          try { rec.syAssetSymbol = decodeString(await call(rec.syAsset, keccak256(toUtf8Bytes('symbol()')).slice(0, 10))); } catch (e) { /* optional */ }
          try { rec.syAssetName = decodeString(await call(rec.syAsset, keccak256(toUtf8Bytes('name()')).slice(0, 10))); } catch (e) { /* optional */ }
          try { rec.assetTokenSymbol = decodeString(await call(rec.syAssetAddr, keccak256(toUtf8Bytes('symbol()')).slice(0, 10))); } catch (e) { /* optional */ }
          try { rec.assetTokenDecimals = Number(BigInt(await call(rec.syAssetAddr, SELECTORS.decimals))); } catch (e) { /* optional */ }
        } catch (e) { rec.syAssetInfoError = sanitize(e.message); }
        try {
          const sd = await call(rec.sy, SELECTORS.decimals);
          rec.syDecimals = Number(BigInt(sd));
        } catch (e) { rec.syDecimalsError = sanitize(e.message); }
        try { rec.sySymbol = decodeString(await call(rec.sy, keccak256(toUtf8Bytes('symbol()')).slice(0, 10))); } catch (e) { /* optional */ }
        try { rec.syName = decodeString(await call(rec.sy, keccak256(toUtf8Bytes('name()')).slice(0, 10))); } catch (e) { /* optional */ }
        try {
          const er = await call(rec.sy, keccak256(toUtf8Bytes('exchangeRate()')).slice(0, 10));
          rec.syExchangeRate = BigInt(er).toString();
        } catch (e) { rec.syExchangeRateError = sanitize(e.message); }
        try { rec.marketName = decodeString(await call(rec.market, keccak256(toUtf8Bytes('name()')).slice(0, 10))); } catch (e) { /* optional */ }
        try {
          const ptDec = await call(rec.pt, SELECTORS.decimals);
          const ytDec = await call(rec.yt, SELECTORS.decimals);
          rec.ptDecimals = Number(BigInt(ptDec)); rec.ytDecimals = Number(BigInt(ytDec));
          rec.ptSymbol = decodeString(await call(rec.pt, keccak256(toUtf8Bytes('symbol()')).slice(0, 10)));
        } catch (e) { rec.ptError = sanitize(e.message); }
        // expiry
        try {
          const exp = await call(rec.market, keccak256(toUtf8Bytes('expiry()')).slice(0, 10));
          rec.marketExpiry = Number(BigInt(exp));
        } catch (e) { /* optional */ }
      } catch (e) { rec.marketError = sanitize(e.message); }
      rows.push(rec);
    }
    out.results.instances = rows;
    if (process.env.PENDLE_DUMP) fs.writeFileSync(process.env.PENDLE_DUMP, JSON.stringify(out, null, 2));
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (mode === 'sqd') {
    // Alternate data plane: SQD Portal (keyless public dev access). Used only where
    // direct eth_getLogs ranges make full coverage impractical.
    const DATASETS = { 1: 'ethereum-mainnet', 42161: 'arbitrum-one', 8453: 'base-mainnet', 56: 'binance-mainnet', 137: 'polygon-mainnet', 9745: 'plasma-mainnet' };
    const ds = DATASETS[chainId];
    if (!ds) { out.results.error = 'no_dataset_for_chain'; console.log(JSON.stringify(out, null, 2)); return; }
    const fromBlock = parseInt(process.argv[4] || '0', 10);
    const toBlock = parseInt(process.argv[5] || '999999999', 10);
    const body = {
      type: 'evm',
      fromBlock,
      toBlock,
      includeAllBlocks: false,
      fields: { block: { number: true, timestamp: true }, log: { address: true, topics: true, data: true, transactionHash: true, logIndex: true } },
      logs: [{ address: [FACTORY.toLowerCase()], topic0: [TOPICS.OracleCreated, TOPICS.OracleWithQuoteCreated] }],
    };
    const res = await fetch('https://portal.sqd.dev/datasets/' + ds + '/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
      body: JSON.stringify(body),
    });
    if (!res.ok) { out.results.error = 'http_' + res.status; console.log(JSON.stringify(out, null, 2)); return; }
    const text = await res.text();
    const lines = text.split('\n').filter((l) => l.trim());
    const logs = [];
    for (const l of lines) {
      let blk; try { blk = JSON.parse(l); } catch { continue; }
      for (const lg of blk.logs || []) logs.push(lg);
    }
    out.results.sqd = { dataset: ds, fromBlock, toBlock, blockLines: lines.length, logCount: logs.length };
    try {
      const nums = lines.map((l) => { try { return JSON.parse(l).header?.number ?? JSON.parse(l).number; } catch { return null; } }).filter((x) => x !== null && x !== undefined);
      if (nums.length) out.results.sqd.observedBlockSpan = { first: Math.min(...nums), last: Math.max(...nums) };
      out.results.sqd.firstLineKeys = Object.keys(JSON.parse(lines[0]));
    } catch (e) { out.results.sqd.parseNote = sanitize(e.message); }
    out.results.logs = logs.map((l) => {
      const t0 = l.topics[0];
      if (t0 === TOPICS.OracleWithQuoteCreated) {
        const [quoteOracle, oracle, oracleId] = coder.decode(['address', 'address', 'bytes32'], l.data);
        return { kind: 'WithQuote', market: decAddr(l.topics[1]).toLowerCase(), twapDuration: Number(BigInt(l.topics[2])), baseOracleType: Number(BigInt(l.topics[3])), quoteOracle: quoteOracle.toLowerCase(), oracle: oracle.toLowerCase(), oracleId, tx: l.transactionHash };
      }
      const [oracle, oracleId] = coder.decode(['address', 'bytes32'], l.data);
      return { kind: 'Plain', market: decAddr(l.topics[1]).toLowerCase(), twapDuration: Number(BigInt(l.topics[2])), baseOracleType: Number(BigInt(l.topics[3])), oracle: oracle.toLowerCase(), oracleId, tx: l.transactionHash };
    });
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (mode === 'latest') {
    const sel = await selectEndpoints(chainLabel, 1);
    if (!sel.out.length) { out.results.error = 'no_working_endpoint'; console.log(JSON.stringify(out, null, 2)); return; }
    const b = await rpc(sel.out[0].url, 'eth_getBlockByNumber', ['latest', false]);
    out.results.latest = { number: parseInt(b.number, 16), timestamp: parseInt(b.timestamp, 16), hash: b.hash };
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (mode === 'code') {
    const addrs = (process.argv[4] || '').split(',');
    const sel = await selectEndpoints(chainLabel, 2);
    if (!sel.out.length) { out.results.error = 'no_working_endpoint'; console.log(JSON.stringify(out, null, 2)); return; }
    const url = sel.out[0].url;
    out.results.addresses = [];
    for (const a of addrs) {
      const c = await rpc(url, 'eth_getCode', [a, 'latest']);
      out.results.addresses.push({ address: a, codeSize: dataLength(c), codeHash: c === '0x' ? null : keccak256(c) });
    }
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (mode === 'tx') {
    const hashes = (process.argv[4] || '').split(',');
    const sel = await selectEndpoints(chainLabel, 2);
    if (!sel.out.length) { out.results.error = 'no_working_endpoint'; console.log(JSON.stringify(out, null, 2)); return; }
    const url = sel.out[0].url;
    out.results.txs = [];
    for (const h of hashes) {
      try {
        const t = await rpc(url, 'eth_getTransactionByHash', [h]);
        out.results.txs.push({ hash: h, from: t.from, to: t.to, blockNumber: parseInt(t.blockNumber, 16), inputSelector: (t.input || '0x').slice(0, 10), value: BigInt(t.value).toString() });
      } catch (e) { out.results.txs.push({ hash: h, error: sanitize(e.message) }); }
    }
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  console.log(JSON.stringify({ error: 'unknown_mode' }));
}

main().catch((e) => { console.error(JSON.stringify({ fatal: sanitize(e && e.stack ? e.stack : e) })); process.exit(1); });
