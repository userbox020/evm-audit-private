'use strict';

// Bounded observational capture (--capture), then replayable BigInt economics (--offline).
// No signer, wallet, transaction, fork, dotenv, or endpoint output.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const scanner = require('./scan-eulerswap-l');
const { rpcCall } = require('./shared-rpc');
const ROOT = path.resolve(__dirname, '..');
const DIR = 'reports/raw/fast/novelty-rerank-20261017';
const OUT = `${DIR}/A05-cycle7-stage5-economics.json`;
const SUMMARY = `${DIR}/A05-cycle7-stage5-economics-summary.md`;
const HANDOFF = 'coordination/handoffs/20261017-a05-cycle7-fresh-chainstate.md';
const SCAN = 'reports/raw/fast/eulerswap-l.json';
const PRIOR = `${DIR}/A05-stage5-economics.json`;
const SCAN_RUN = {
  command: 'node tools/scan-eulerswap-l.js', exitCode: 0,
  start: '2026-10-17T04:13:31.3398603Z', end: '2026-10-17T04:13:45.6904085Z',
  elapsedSeconds: 14.3505482, scannerRequests: 50,
  beforeSha256: '28565b91e458eb8d8b2ff74e28d903aed7e6cdbec96659ffae3ba3a6087aa3da',
  afterSha256: 'b0fcc675e66858b54037d245f41b6b7806720526477aeaa2e46a84aa41fe8a44',
};
const WAD = 10n ** 18n;
const MAX112 = (1n << 112n) - 1n;
const MAX256 = (1n << 256n) - 1n;
const USD = '0x0000000000000000000000000000000000000348';
const ZERO = ethers.ZeroAddress;
const SIZES = [1000n, 10000n, 50000n];
const VAULT = new ethers.Interface([
  'function oracle() view returns(address)', 'function unitOfAccount() view returns(address)',
]);
const TOKEN = new ethers.Interface(['function decimals() view returns(uint8)', 'function symbol() view returns(string)']);
const ORACLE = new ethers.Interface([
  'function resolveOracle(uint256,address,address) view returns(uint256,address,address,address)',
  'function getQuote(uint256,address,address) view returns(uint256)',
  'function name() view returns(string)', 'function base() view returns(address)',
  'function quote() view returns(address)', 'function cross() view returns(address)',
  'function feed() view returns(address)', 'function maxStaleness() view returns(uint256)',
  'function oracleBaseCross() view returns(address)', 'function oracleCrossQuote() view returns(address)',
]);
const FEED = new ethers.Interface([
  'function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)',
  'function decimals() view returns(uint8)', 'function description() view returns(string)',
]);
const REGISTRY = new ethers.Interface(['function getFeed(address,address) view returns(address)']);
// Local reference authority: tools/monitor-oracle-divergence.js:109-122.
const REFERENCES = {
  1: {
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': ['0x8fffffd4afb6115b954bd326cbe7b4ba576818f6', 'USDC / USD', 93600],
    '0xdac17f958d2ee523a2206206994597c13d831ec7': ['0x3e7d1eab13ad0104d2750b8863b489d65364e32d', 'USDT / USD', 93600],
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': ['0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419', 'ETH / USD', 7200],
  },
  8453: {
    '0x4200000000000000000000000000000000000006': ['0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70', 'ETH / USD', 7200],
  },
};
let requests = 0;
let logicalCalls = 0;
const bytes = file => fs.readFileSync(path.join(ROOT, file));
const json = file => JSON.parse(bytes(file));
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const lower = address => String(address).toLowerCase();
const clean = value => JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v));
const spec = (to, iface, fn, args = []) => ({ to, iface, fn, args, data: iface.encodeFunctionData(fn, args) });
function decode(entry, raw) {
  try { return entry.iface.decodeFunctionResult(entry.fn, raw); } catch (_) { return null; }
}
async function rpc(r, method, args) {
  requests++;
  try { return await rpcCall(r, method, args, 12000); } catch (_) { return null; }
}
async function direct(r, pin, entry) {
  const raw = await rpc(r, 'eth_call', [{ to: entry.to, data: entry.data }, { blockHash: pin.hash, requireCanonical: true }]);
  return decode(entry, raw);
}
async function batch(r, pin, entries) {
  if (!entries.length) return [];
  logicalCalls += entries.length;
  const call = spec(scanner.MULTICALL3, scanner.I.multicall, 'aggregate3', [entries.map(e => [e.to, true, e.data])]);
  const decoded = await direct(r, pin, call);
  if (!decoded) return Promise.all(entries.map(e => direct(r, pin, e)));
  return Promise.all(decoded[0].map(async (item, i) => {
    // A reverted subcall can be caller-sensitive; retry directly once, still at the same pin.
    return item[0] ? decode(entries[i], item[1]) : direct(r, pin, entries[i]);
  }));
}
async function checkPin(r, pin) {
  const block = await rpc(r, 'eth_getBlockByNumber', [scanner.hexBlock(pin.number), false]);
  assert(block && lower(block.hash) === lower(pin.hash), 'PIN_BINDING_FAILED');
  assert.equal(BigInt(block.timestamp), BigInt(Date.parse(pin.timestamp) / 1000));
}

async function capturePool(r, pin, prior, scanned) {
  const address = prior.poolAddress;
  logicalCalls++;
  const reservesDirect = await direct(r, pin, spec(address, scanner.I.pool, 'getReserves'));
  const methods = ['getReserves', 'getStaticParams', 'getDynamicParams', 'getAssets', 'isInstalled'];
  const results = await batch(r, pin, methods.map(fn => spec(address, scanner.I.pool, fn)));
  const [reserves, statics, dynamic, assets, installed] = results;
  const agreement = reserves && reservesDirect ? JSON.stringify(clean(reserves)) === JSON.stringify(clean(reservesDirect)) : null;
  assert(agreement !== false, 'DIRECT_MULTICALL_RESERVE_MISMATCH');
  const asset0 = assets ? lower(assets[0]) : null;
  const asset1 = assets ? lower(assets[1]) : null;
  const limits = assets ? await batch(r, pin, [
    spec(address, scanner.I.pool, 'getLimits', [asset0, asset1]),
    spec(address, scanner.I.pool, 'getLimits', [asset1, asset0]),
  ]) : [null, null];
  const dNames = ['equilibriumReserve0', 'equilibriumReserve1', 'minReserve0', 'minReserve1',
    'priceX', 'priceY', 'concentrationX', 'concentrationY', 'fee0', 'fee1', 'expiration',
    'swapHookedOperations', 'swapHook'];
  const sNames = ['supplyVault0', 'supplyVault1', 'borrowVault0', 'borrowVault1', 'eulerAccount', 'feeRecipient'];
  const state = {
    chainId: prior.chainId, poolAddress: address, pin, asset0, asset1,
    observationNovelCycle3: prior.observationNovel,
    swapVolumeObservedCycle3: prior.swapVolumeObserved,
    swapVolumeObservedCycle7: scanned?.swapVolumeObserved ?? null,
    directMulticallReserveAgreement: agreement,
    reserve0Raw: reserves ? String(reserves[0]) : null,
    reserve1Raw: reserves ? String(reserves[1]) : null,
    status: reserves ? Number(reserves[2]) : null,
    isInstalled: installed ? installed[0] : null,
    staticParams: statics ? Object.fromEntries(sNames.map((n, i) => [n, lower(statics[i])])) : null,
    dynamicParams: dynamic ? Object.fromEntries(dNames.map((n, i) => [n, i === 12 ? lower(dynamic[i]) : String(dynamic[i])])) : null,
    limits01: limits[0] ? { limitInRaw: String(limits[0][0]), limitOutRaw: String(limits[0][1]) } : null,
    limits10: limits[1] ? { limitInRaw: String(limits[1][0]), limitOutRaw: String(limits[1][1]) } : null,
  };
  const complete = results.every(Boolean) && agreement === true && limits.every(Boolean);
  state.readStatus = complete ? 'COMPLETE' : 'INCOMPLETE_DATA';
  state.operationalSurfaceCandidate = !complete ? 'unknown' : state.status === 1 && state.isInstalled === true
    && (BigInt(state.reserve0Raw) > 0n || BigInt(state.reserve1Raw) > 0n)
    && (BigInt(state.dynamicParams.expiration) === 0n || BigInt(state.dynamicParams.expiration) > BigInt(Date.parse(pin.timestamp) / 1000))
    && BigInt(state.limits01.limitInRaw) > 0n && BigInt(state.limits01.limitOutRaw) > 0n;
  return state;
}

async function readFeed(r, pin, address, maxAge, expectedDescription = null) {
  const [round, decimals, description] = await batch(r, pin,
    ['latestRoundData', 'decimals', 'description'].map(fn => spec(address, FEED, fn)));
  const timestamp = BigInt(Date.parse(pin.timestamp) / 1000);
  const age = round ? timestamp - round[3] : null;
  const identity = !expectedDescription || description?.[0] === expectedDescription;
  const fresh = Boolean(round && decimals && identity && round[1] > 0n && round[3] > 0n
    && round[3] <= timestamp && round[2] <= round[3] && round[4] >= round[0]
    && age <= BigInt(maxAge) && decimals[0] <= 36n);
  return {
    feed: lower(address), description: description?.[0] ?? null, decimals: decimals ? Number(decimals[0]) : null,
    round: round ? clean({ roundId: round[0], answer: round[1], startedAt: round[2], updatedAt: round[3], answeredInRound: round[4] }) : null,
    ageSeconds: age === null ? null : String(age), maxAgeSeconds: String(maxAge), identityChecked: identity,
    status: fresh ? 'FRESH' : 'INCOMPLETE_DATA',
  };
}

// Only explicitly recognized adapter paths are freshness-qualified. An opaque
// getQuote response alone is NOT evidence of fresh absolute USD valuation.
async function inspectAdapter(r, pin, address, base, quote, depth = 0, seen = new Set()) {
  if (depth > 3 || seen.has(lower(address))) return { address, status: 'INCOMPLETE_DATA', reason: 'PATH_BOUND' };
  const next = new Set(seen).add(lower(address));
  const names = ['name', 'base', 'quote', 'feed', 'maxStaleness', 'cross', 'oracleBaseCross', 'oracleCrossQuote'];
  const values = await batch(r, pin, names.map(fn => spec(address, ORACLE, fn)));
  const fields = Object.fromEntries(names.map((n, i) => [n, values[i] ? String(values[i][0]) : null]));
  const identity = fields.base && fields.quote && ((lower(fields.base) === base && lower(fields.quote) === quote)
    || (lower(fields.base) === quote && lower(fields.quote) === base));
  const out = { address, expectedBase: base, expectedQuote: quote, fields, status: 'INCOMPLETE_DATA' };
  if (!identity) { out.reason = 'UNBOUND_PAIR_OR_UNSUPPORTED_ADAPTER'; return out; }
  if (fields.name === 'ChainlinkOracle' && fields.feed && fields.maxStaleness) {
    // Cap observational freshness at 26h even if adapter permits a longer age.
    const maxAge = BigInt(fields.maxStaleness) < 93600n ? BigInt(fields.maxStaleness) : 93600n;
    out.feed = await readFeed(r, pin, fields.feed, maxAge);
    out.status = out.feed.status === 'FRESH' ? 'FRESH' : 'INCOMPLETE_DATA';
  } else if (fields.name === 'CrossAdapter' && fields.cross && fields.oracleBaseCross && fields.oracleCrossQuote) {
    out.children = await Promise.all([
      inspectAdapter(r, pin, fields.oracleBaseCross, lower(fields.base), lower(fields.cross), depth + 1, next),
      inspectAdapter(r, pin, fields.oracleCrossQuote, lower(fields.cross), lower(fields.quote), depth + 1, next),
    ]);
    out.status = out.children.every(c => c.status === 'FRESH') ? 'FRESH' : 'INCOMPLETE_DATA';
  } else out.reason = 'UNSUPPORTED_FRESHNESS_PATH';
  return out;
}

async function capturePricing(r, pin, chainId, asset, vaults) {
  const [decimals, symbol] = await batch(r, pin, ['decimals', 'symbol'].map(fn => spec(asset, TOKEN, fn)));
  const out = { chainId, asset, pin, decimals: decimals ? Number(decimals[0]) : null,
    symbol: symbol?.[0] ?? null, status: 'INCOMPLETE_DATA', priceUSDWad: null, attempts: [] };
  if (!decimals || decimals[0] > 36n) { out.reason = 'TOKEN_DECIMALS_UNAVAILABLE'; return out; }
  const ref = REFERENCES[chainId]?.[asset];
  if (ref) {
    const feed = await readFeed(r, pin, ref[0], ref[2], ref[1]);
    out.attempts.push({ kind: 'LOCAL_REFERENCE_CHAINLINK', ...feed });
    if (feed.status === 'FRESH') {
      out.priceUSDWad = String(BigInt(feed.round.answer) * WAD / 10n ** BigInt(feed.decimals));
      out.status = 'COMPLETE'; return out;
    }
  }
  // Feed registry address authority: tools/scan-config-deltas.js:288.
  if (chainId === 1 && !ref) {
    const [result] = await batch(r, pin, [spec('0x47fb2585d2c56fe188d0e6ec628a38b74fceeedf', REGISTRY, 'getFeed', [asset, USD])]);
    const attempt = { kind: 'CHAINLINK_FEED_REGISTRY_USD', feed: result ? lower(result[0]) : null };
    out.attempts.push(attempt);
    if (result && result[0] !== ZERO) {
      attempt.read = await readFeed(r, pin, result[0], 93600);
      if (attempt.read.status === 'FRESH') {
        out.priceUSDWad = String(BigInt(attempt.read.round.answer) * WAD / 10n ** BigInt(attempt.read.decimals));
        out.status = 'COMPLETE'; return out;
      }
    }
  }
  for (const vault of [...new Set(vaults)].slice(0, 3)) {
    const [oracle, uoa] = await batch(r, pin, ['oracle', 'unitOfAccount'].map(fn => spec(vault, VAULT, fn)));
    const attempt = { kind: 'VAULT_ORACLE_PATH', vault, oracle: oracle ? lower(oracle[0]) : null,
      unitOfAccount: uoa ? lower(uoa[0]) : null, paths: [] };
    out.attempts.push(attempt);
    if (!oracle || oracle[0] === ZERO) continue;
    const weth = chainId === 1 ? '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' : '0x4200000000000000000000000000000000000006';
    for (const quote of [USD, weth]) {
      const unit = 10n ** BigInt(out.decimals);
      const [resolved, quoted] = await batch(r, pin, [
        spec(oracle[0], ORACLE, 'resolveOracle', [unit, asset, quote]),
        spec(oracle[0], ORACLE, 'getQuote', [unit, asset, quote]),
      ]);
      const probe = { quote, resolved: resolved ? clean(resolved) : null, quotedRaw: quoted ? String(quoted[0]) : null };
      attempt.paths.push(probe);
      if (!resolved || !quoted || quoted[0] <= 0n || resolved[3] === ZERO) continue;
      // ERC4626 resolution is retained but not assumed to provide a fresh share rate.
      if (resolved[0] !== unit || lower(resolved[1]) !== asset || lower(resolved[2]) !== quote) {
        probe.reason = 'RESOLVED_SHARE_RATE_FRESHNESS_UNPROVEN'; continue;
      }
      probe.adapter = await inspectAdapter(r, pin, lower(resolved[3]), asset, quote);
      if (probe.adapter.status !== 'FRESH') continue;
      if (quote === USD) out.priceUSDWad = String(quoted[0]); // Euler USD sentinel has 18 decimals.
      else {
        const anchor = REFERENCES[chainId][weth];
        probe.usdAnchor = await readFeed(r, pin, anchor[0], anchor[2], anchor[1]);
        if (probe.usdAnchor.status !== 'FRESH') continue;
        out.priceUSDWad = String(quoted[0] * BigInt(probe.usdAnchor.round.answer) / 10n ** BigInt(probe.usdAnchor.decimals));
      }
      out.status = 'COMPLETE'; return out;
    }
  }
  out.reason = 'NO_REACHABLE_FRESHNESS_QUALIFIED_USD_PATH';
  return out;
}

const ceilDiv = (a, b) => { assert(b > 0n); return (a + b - 1n) / b; };
const max = (a, b) => a > b ? a : b;
const bits = a => a === 0n ? 0n : BigInt(a.toString(2).length);
function sqrt(a) {
  assert(a >= 0n);
  if (a < 2n) return a;
  let x = 1n << ceilDiv(bits(a), 2n);
  for (;;) { const n = (x + a / x) / 2n; if (n >= x) return x; x = n; }
}
const sqrtUp = a => { const s = sqrt(a); return s * s === a ? s : s + 1n; };
function decimal(a) {
  const n = a < 0n ? -a : a;
  const fraction = (n % WAD).toString().padStart(18, '0').replace(/0+$/, '');
  return `${a < 0n ? '-' : ''}${n / WAD}${fraction ? `.${fraction}` : ''}`;
}
// CurveLib.sol:59-79,94-170; same mirror as cycle-5, without scalar-hint pricing.
function f(x, px, py, x0, y0, c) {
  assert(x > 0n && x <= x0 && py > 0n && c <= WAD);
  const y = y0 + (c === WAD ? ceilDiv((x0 - x) * px, py)
    : ceilDiv(px * (x0 - x) * (c * x + (WAD - c) * x0), WAD * x * py));
  return y > MAX112 ? MAX256 : y;
}
function fInverse(y, px, py, x0, y0, c) {
  assert(y >= y0 && y <= MAX112 && px > 0n && py > 0n && c <= WAD);
  const t1 = WAD * ((y - y0) * py + x0 * px), t2 = 2n * c * x0 * px;
  assert(t1 <= MAX256 && t2 <= MAX256);
  const negative = t1 < t2, d = negative ? t2 - t1 : t1 - t2;
  const b = negative ? ceilDiv(d, px) : d / px;
  const shift = max(max(0n, bits(b) - 127n), max(0n, bits(x0 * 3814697265625n) - 109n));
  const scale = 1n << (2n * shift), ac = 4n * c * (WAD - c) * x0 * x0;
  let x;
  if (negative) x = ceilDiv(b + (sqrtUp(ceilDiv(b * b, scale) + ceilDiv(ac, scale)) << shift), 2n * c);
  else {
    const denominator = b + (sqrt(b * b / scale + ac / scale) << shift);
    x = denominator === 0n ? 0n : ceilDiv(2n * (WAD - c) * x0 * x0, denominator);
  }
  return x > x0 ? x - 1n : x;
}
function dfDx(x, px, py, x0, c) {
  if (x === 0n) return null;
  const r = ceilDiv((x0 * x0 / x) * WAD, x);
  return -(px * (c + (WAD - c) * r / WAD) / py);
}
function marginal(p, r0, r1, input0) {
  let d, reciprocal = false;
  if (input0 && r0 <= p.equilibriumReserve0) d = dfDx(r0, p.priceX, p.priceY, p.equilibriumReserve0, p.concentrationX);
  else if (input0) {
    d = dfDx(fInverse(r0, p.priceY, p.priceX, p.equilibriumReserve1, p.equilibriumReserve0, p.concentrationY), p.priceY, p.priceX, p.equilibriumReserve1, p.concentrationY);
    reciprocal = true;
  } else if (r1 <= p.equilibriumReserve1) {
    d = dfDx(r1, p.priceY, p.priceX, p.equilibriumReserve1, p.concentrationY); reciprocal = true;
  } else d = dfDx(fInverse(r1, p.priceX, p.priceY, p.equilibriumReserve0, p.equilibriumReserve1, p.concentrationX), p.priceX, p.priceY, p.equilibriumReserve0, p.concentrationX);
  return d === null || d === 0n ? null : -(reciprocal ? WAD * WAD / d : d);
}
function swap(p, r0, r1, amount, input0) {
  assert(amount >= 0n && amount <= MAX112);
  const fee = amount * (input0 ? p.fee0 : p.fee1) / WAD;
  const effective = amount - fee;
  let out;
  if (input0) {
    r0 += effective; assert(r0 <= MAX112);
    const y = r0 <= p.equilibriumReserve0 ? f(r0, p.priceX, p.priceY, p.equilibriumReserve0, p.equilibriumReserve1, p.concentrationX)
      : fInverse(r0, p.priceY, p.priceX, p.equilibriumReserve1, p.equilibriumReserve0, p.concentrationY);
    out = r1 > y ? r1 - y : 0n; r1 -= out;
  } else {
    r1 += effective; assert(r1 <= MAX112);
    const x = r1 <= p.equilibriumReserve1 ? f(r1, p.priceY, p.priceX, p.equilibriumReserve1, p.equilibriumReserve0, p.concentrationY)
      : fInverse(r1, p.priceX, p.priceY, p.equilibriumReserve0, p.equilibriumReserve1, p.concentrationX);
    out = r0 > x ? r0 - x : 0n; r0 -= out;
  }
  let diagnostic = null;
  try { diagnostic = marginal(p, r0, r1, input0); } catch (_) { /* marginal is not amount-out */ }
  return { out, fee, effective, r0, r1, marginalRawWad: diagnostic };
}
function simulate(pool, prices, size, input0) {
  const p = Object.fromEntries(Object.entries(pool.dynamicParams).filter(([k]) => k !== 'swapHook').map(([k, v]) => [k, BigInt(v)]));
  assert(p.priceX > 0n && p.priceY > 0n && p.equilibriumReserve0 > 0n && p.equilibriumReserve1 > 0n);
  assert(p.concentrationX <= WAD && p.concentrationY <= WAD && p.fee0 < WAD && p.fee1 < WAD);
  assert.equal(p.swapHookedOperations, 0n, 'UNMODELED_HOOK');
  const [a, b] = input0 ? prices : [...prices].reverse();
  const unitA = 10n ** BigInt(a.decimals), unitB = 10n ** BigInt(b.decimals);
  const priceA = BigInt(a.priceUSDWad), priceB = BigInt(b.priceUSDWad);
  assert(priceA > 0n && priceB > 0n);
  const amount = size * WAD * unitA / priceA;
  const first = swap(p, BigInt(pool.reserve0Raw), BigInt(pool.reserve1Raw), amount, input0);
  const second = swap(p, first.r0, first.r1, first.out, !input0);
  const quote = second.out * priceA / unitA;
  const input = amount * priceA / unitA;
  const fees = first.fee * priceA / unitA + second.fee * priceB / unitB;
  const net = quote - input - fees;
  const limits = input0 ? pool.limits01 : pool.limits10;
  const withinInitialLimits = limits ? first.effective <= BigInt(limits.limitInRaw) && first.out <= BigInt(limits.limitOutRaw) : null;
  const minReserves = [first, second].every(s => s.r0 >= p.minReserve0 && s.r1 >= p.minReserve1);
  return {
    direction: input0 ? 'asset0-asset1-asset0' : 'asset1-asset0-asset1', inputRaw: String(amount),
    inputActualUSD: decimal(input), quoteOutUSD: decimal(quote), feeTotalUSD: decimal(fees),
    netUSD: decimal(net), netNominalUSD: decimal(quote - size * WAD - fees),
    netWithoutExtraFeeDebitUSD: decimal(quote - input),
    firstLeg: clean(first), secondLeg: clean(second), withinInitialLimits, withinMinReserves: minReserves,
    postFirstLegVaultLimitsValidated: false, gasUSD: null,
    modelRoutePositive: net > 0n,
    // Scope is the modeled same-pool round trip only, never the whole A05 class.
    routePositive: quote - input <= 0n ? false : 'unknown', netNumerator: net,
  };
}

function evaluate(capture) {
  const rows = [], pools = [];
  for (const state of capture.watchlist.filter(p => p.observationNovelCycle3)) {
    const prices = [state.asset0, state.asset1].map(a => capture.pricing.find(p => p.chainId === state.chainId && p.asset === a));
    const completeUSD = prices.every(p => p?.status === 'COMPLETE');
    const pool = { ...state, pricingAssets: prices.map(p => p?.asset ?? null),
      usdEconomics: completeUSD ? 'COMPLETE' : 'INCOMPLETE_DATA', tvlUSD: null, routePositive: 'unknown',
      executableNow: 'pending-owner-batch-envelope' };
    if (completeUSD && state.reserve0Raw !== null && state.reserve1Raw !== null) {
      pool.tvlUSD = decimal(prices.reduce((sum, p, i) => sum + BigInt(state[`reserve${i}Raw`]) * BigInt(p.priceUSDWad) / 10n ** BigInt(p.decimals), 0n));
    }
    for (const size of SIZES) {
      const row = { chainId: state.chainId, poolAddress: state.poolAddress, pin: state.pin, sizeUSD: String(size),
        usdEconomics: pool.usdEconomics, quoteOutUSD: null, feeTotalUSD: null, netUSD: null,
        routePositive: 'unknown', executableNow: 'pending-owner-batch-envelope', directions: [] };
      if (completeUSD && state.readStatus === 'COMPLETE') {
        for (const input0 of [true, false]) {
          try { row.directions.push(simulate(state, prices, size, input0)); }
          catch (_) { row.directions.push({ direction: input0 ? 'asset0-asset1-asset0' : 'asset1-asset0-asset1',
            error: BigInt(state.dynamicParams?.swapHookedOperations ?? '0') !== 0n ? 'UNMODELED_SWAP_HOOK' : 'PARAMETER_OR_ARITHMETIC_BOUND', routePositive: 'unknown' }); }
        }
        if (row.directions.every(d => d.netNumerator !== undefined)) {
          const best = row.directions.reduce((a, b) => a.netNumerator >= b.netNumerator ? a : b);
          for (const k of ['quoteOutUSD', 'feeTotalUSD', 'netUSD', 'direction']) row[k] = best[k];
          row.routePositive = row.directions.every(d => d.routePositive === false) ? false : 'unknown';
          row.economics = 'COMPUTED_PRE_GAS_SAME_POOL';
        } else row.economics = 'INCOMPLETE_DATA';
        row.directions = row.directions.map(({ netNumerator, ...rest }) => rest);
      } else row.economics = 'INCOMPLETE_DATA';
      rows.push(row);
    }
    const ownRows = rows.filter(r => r.poolAddress === pool.poolAddress);
    if (ownRows.every(r => r.routePositive === false)) pool.routePositive = false;
    pool.economics = ownRows.every(r => r.economics === 'COMPUTED_PRE_GAS_SAME_POOL') ? 'COMPUTED_PRE_GAS_SAME_POOL' : 'INCOMPLETE_DATA';
    pool.economicsBlocker = !completeUSD ? 'MISSING_FRESH_USD_PATH'
      : BigInt(state.dynamicParams?.swapHookedOperations ?? '0') !== 0n ? 'UNMODELED_SWAP_HOOK' : pool.economics === 'INCOMPLETE_DATA' ? 'READ_OR_ARITHMETIC_BOUND' : null;
    pools.push(pool);
  }
  assert.equal(capture.watchlist.length, 11); assert.equal(pools.length, 8); assert.equal(rows.length, 24);
  return { pools, rows };
}

function report(o) {
  const lines = [
    '# A05 cycle-7 fresh-chainstate Stage-5 economics', '',
    '**WATCH — fresh observational capture; no positive executable route established.**', '',
    `Verdict: **${o.verdict}**. ${o.counts.usdCompletePools}/8 pools have fresh USD calibration; ${o.counts.computedRows}/24 rows computed. ` +
      `${o.counts.routePositiveRows} route-positive rows; ${o.counts.unknownRows} unknown. Aggregate routePositive=unknown; executableNow=pending-owner-batch-envelope.`, '',
    '## Scanner and pins', '',
    `Scanner exit ${o.scannerRun.exitCode}, ${o.scannerRun.elapsedSeconds}s, ${o.scannerRun.scannerRequests} counted requests (excludes endpoint qualification).`,
    `Before SHA-256: \`${o.scannerRun.beforeSha256}\`.`,
    `After SHA-256: \`${o.scannerRun.afterSha256}\`.`,
    ...o.capture.pins.map(p => `- Chain ${p.chainId}: ${p.number} / \`${p.hash}\`; ${p.timestamp}, finalized.`), '',
    '## All 11 prior operational candidates', '',
    '| Chain | Pool | Read status | Direct/MC reserves agree | Operational at pin | Cycle-7 Swap events |',
    '|---|---|---|---|---|---:|',
    ...o.capture.watchlist.map(p => `| ${p.chainId} | \`${p.poolAddress}\` | ${p.readStatus} | ${p.directMulticallReserveAgreement} | ${p.operationalSurfaceCandidate} | ${p.swapVolumeObservedCycle7} |`), '',
    '## Eight cycle-3 observation-novel pools: fresh USD economics', '',
    'Dollar figures below are oracle marks, not realizable external sale quotes. Net is pre-gas and uses the requested extra fee debit.', '',
    '| Chain | Pool | USD status | Reserve TVL estimate USD | Net $1k | Net $10k | Net $50k | routePositive (modeled round trip) |',
    '|---|---|---|---:|---:|---:|---:|---|',
    ...o.pools.map(p => `| ${p.chainId} | \`${p.poolAddress}\` | ${p.usdEconomics} | ${p.tvlUSD ?? 'unknown'} | ` +
      o.rows.filter(r => r.poolAddress === p.poolAddress).map(r => r.netUSD ?? 'unknown').join(' | ') + ` | ${p.routePositive} |`), '',
    'USD calibration is COMPLETE for 5 pools, not complete route economics: pool `0x719529e99b7b272c5ef4ce07c30d15bc57cd68a8` has swapHookedOperations=6 and hook `0x99b97fd05b4f943899358f90855c0bee34584e41`; all three hook-dependent rows remain unknown. Its zero concentrations/fees are legal, not missing data. The other nine unknown rows lack fresh USD paths (srUSDe, liquidETH, agETH; sampled supply-vault oracle and unitOfAccount are zero, and no USD feed was returned by the registry probe). A null probe is not proof that no feed exists elsewhere.', '',
    '## Per-size quote and fee detail', '',
    '| Pool | Size USD | Best direction | Quote out USD | Fee total USD | Requested net USD, pre-gas | Status |',
    '|---|---:|---|---:|---:|---:|---|',
    ...o.rows.map(r => `| \`${r.poolAddress}\` | ${r.sizeUSD} | ${r.direction ?? 'unknown'} | ${r.quoteOutUSD ?? 'unknown'} | ${r.feeTotalUSD ?? 'unknown'} | ${r.netUSD ?? 'unknown'} | ${r.economics} |`), '',
    '## Asset calibration', '',
    '| Chain | Asset | Symbol | Decimals | USD mark per whole token | Status |', '|---|---|---|---:|---:|---|',
    ...o.capture.pricing.map(p => `| ${p.chainId} | \`${p.asset}\` | ${p.symbol ?? 'unknown'} | ${p.decimals ?? 'unknown'} | ${p.priceUSDWad ? decimal(BigInt(p.priceUSDWad)) : 'unknown'} | ${p.status} |`), '',
    '## Method and limitations', '',
    '- All reserves/static/dynamic params, installation, both getLimits directions, token decimals and feeds are eth_call reads at EIP-1898 canonical block-hash pins. getReserves is independently read directly and via Multicall3. Pin number/hash/timestamp are rechecked before and after capture. Raw decoded observations and freshness paths are in the JSON.',
    '- CurveLib f/fInverse and QuoteLib.findCurvePoint reserve deltas supply outputs; CurveExtrasLib:38/45/48/56 df_dx is a marginal-price diagnostic, not an amount-out formula. BigInt throughout. The unwind uses post-first-leg reserves. Zero fees/concentrations are legal and are no longer treated as missing parameters.',
    '- TVL = sum(reserveRaw * fresh whole-token USD mark / 10**tokenDecimals). Reserves are virtual curve state, not proof of cash backing or redeemable TVL. Arbitrary curve priceX/Y scale is never used as an absolute USD anchor.',
    '- NetUSD = fee-inclusive quoteOutUSD - actual inputUSD - feeTotalUSD; netNominalUSD uses the nominal $1k/$10k/$50k input. Extra fee subtraction double-debits fees conservatively. netWithoutExtraFeeDebitUSD separately reports correct pre-gas balance PnL. Gas, funding, slippage to an external asset, latency and MEV costs are unknown, not zero-profit assurances.',
    '- Direct feed labels/addresses come from the local monitor reference registry and are checked live. Freshness ceiling: ETH 2h, stablecoin references 26h, discovered feeds 26h or lower adapter maxStaleness. Positive answer, nonfuture nonzero updatedAt, round completeness and decimals are checked. This is a declared observational threshold, not a claim about every consumer heartbeat.',
    '- Unknown tokens are probed through the Chainlink feed registry on Ethereum and their own supply-vault oracle router to USD and WETH. Only ABI/pair-bound ChainlinkOracle/CrossAdapter paths with fresh leaf rounds qualify. This is observational pointer/ABI evidence, not new exact-runtime/source binding of each adapter. Opaque/custom/share-rate paths remain INCOMPLETE_DATA even when getQuote returns a number. No $1 peg, ETH peg, guessed feed or unverified share conversion is substituted.',
    '- Initial forward/reverse limits and minimum reserves are diagnostics. Second-leg vault limits after state changes, EVC authorization/dispatch, hooks, funding and a public actor-to-extraction path are not executed or established. A false per-pool flag is bounded to the sampled same-pool round-trip model, never a global A05 disproof; incomplete USD rows are unknown, never negative.',
    '- Cycle-3 observation-novel membership is held fixed (zero events in its bounded window, not proof of no trading history). Scanner enumeration done-maps retain old anchors; detail cap is 40 Ethereum pools. Fresh registry reads do not make the history exhaustive. All 11 explicitly named candidates are additionally re-read independently of scanner ranking.',
    '- Supplied Base address is malformed (39 hex digits). Exact Stage-4/extraction/cycle-5 address is 0x4687e171bea250e3048d8f426b32cb16be17a8a8; axes-summary contains a contradictory historical correction note. No heuristic address repair is used.',
    '- No .env/wallet-key reads, signing, broadcast, fork, shared-rpc edit, target edit, scheduler/hold change or promotion. executableNow is pending-owner-batch-envelope for every pool/row.', '',
    '## Cycle-8 staging', '', o.cycle8Recommendation, '',
    '## Bindings and reproduction', '',
    ...o.sourceBindings.map(b => `- \`${b.file}\`: SHA-256 \`${b.sha256}\`.`), '',
    '`node tools/sim-eulerswap-l-cycle7-stage5.js --offline` replays captured data without network. `--capture` re-reads only the fixed scanner pins; it does not rerun the scanner or silently move the pins.', '',
    `Capture: ${o.capture.startedAt} to ${o.capture.finishedAt}; ${o.capture.requests} explicit RPC requests, ${o.capture.logicalEthCalls} logical eth_calls (excludes shared-rpc qualification).`, '',
  ];
  return lines.join('\n');
}

async function main() {
  assert(process.argv.length === 3 && ['--capture', '--offline'].includes(process.argv[2]), 'Use --capture or --offline');
  const offline = process.argv[2] === '--offline';
  assert.equal(hash(bytes(SCAN)), SCAN_RUN.afterSha256, 'Scanner artifact changed: explicit rebind required');
  const prior = json(PRIOR), scan = json(SCAN);
  assert.equal(prior.pools.length, 11); assert.equal(prior.pools.filter(p => p.observationNovel).length, 8);
  let capture;
  if (offline) capture = json(OUT).capture;
  else {
    capture = { startedAt: new Date().toISOString(), pins: [], watchlist: [], pricing: [] };
    for (const chain of scan.chains) {
      const r = await scanner.resolveWorkingRpc(chain.chainId);
      assert(r, 'RPC_UNAVAILABLE');
      await checkPin(r, chain.pin);
      capture.pins.push({ chainId: chain.chainId, ...chain.pin });
      const candidates = prior.pools.filter(p => p.chainId === chain.chainId);
      for (const p of candidates) capture.watchlist.push(await capturePool(r, chain.pin, p, chain.pairs.find(s => s.pool === p.poolAddress)));
      const novel = capture.watchlist.filter(p => p.chainId === chain.chainId && p.observationNovelCycle3);
      const assets = [...new Set(novel.flatMap(p => [p.asset0, p.asset1]).filter(Boolean))];
      for (const asset of assets) {
        const vaults = novel.flatMap(p => [0, 1].filter(i => p[`asset${i}`] === asset).map(i => p.staticParams?.[`supplyVault${i}`])).filter(Boolean);
        capture.pricing.push(await capturePricing(r, chain.pin, chain.chainId, asset, vaults));
      }
      await checkPin(r, chain.pin);
    }
    capture.finishedAt = new Date().toISOString(); capture.requests = requests; capture.logicalEthCalls = logicalCalls;
  }
  const economics = evaluate(capture);
  const bindings = [SCAN, PRIOR, `${DIR}/axes-summary.json`, `${DIR}/A05-stage4-surface.md`,
    `${DIR}/A05-stage4-evidence/surface-extraction.json`, 'tools/scan-eulerswap-l.js', 'tools/shared-rpc.js',
    'tools/sim-eulerswap-l-economics.js', 'tools/sim-eulerswap-l-cycle7-stage5.js',
    'tools/monitor-oracle-divergence.js', 'targets/euler-oracle/src/EulerRouter.sol',
    'targets/euler-oracle/src/adapter/chainlink/ChainlinkOracle.sol', 'targets/euler-oracle/src/adapter/CrossAdapter.sol',
    ...['src/libraries/CurveLib.sol', 'src/libraries/QuoteLib.sol', 'src/libraries/SwapLib.sol', 'test/utils/CurveExtrasLib.sol']
      .map(p => `targets/euler-swap-eulerswap-2.0-81cf6dc98846/${p}`)]
    .map(file => ({ file, sha256: hash(bytes(file)) }));
  const output = {
    schema: 'a05-cycle7-fresh-stage5/v1', signal: 'WATCH; observational USD-calibrated same-pool model, not executable exploit evidence',
    generatedAt: capture.finishedAt, scannerRun: SCAN_RUN, sourceBindings: bindings, capture, ...economics,
    counts: { watchlist: capture.watchlist.length, operational: capture.watchlist.filter(p => p.operationalSurfaceCandidate === true).length,
      observationNovelPools: economics.pools.length, usdCompletePools: economics.pools.filter(p => p.usdEconomics === 'COMPLETE').length,
      rows: economics.rows.length, computedRows: economics.rows.filter(r => r.economics === 'COMPUTED_PRE_GAS_SAME_POOL').length,
      routePositiveRows: economics.rows.filter(r => r.routePositive === true).length,
      boundedNegativeRows: economics.rows.filter(r => r.routePositive === false).length,
      incompleteUSDRows: economics.rows.filter(r => r.usdEconomics === 'INCOMPLETE_DATA').length,
      unmodeledHookRows: economics.rows.filter(r => r.directions.some(d => d.error === 'UNMODELED_SWAP_HOOK')).length,
      unknownRows: economics.rows.filter(r => r.routePositive === 'unknown').length },
    aggregateGates: { routePositive: 'unknown', executableNow: 'pending-owner-batch-envelope', signedActionJustified: false, authorizationState: 'ABSENT' },
    safety: { observationalOnly: true, signing: false, broadcast: false, fork: false, privateKeysRead: false, endpointMaterialPersisted: false },
    cycle8Recommendation: 'Keep A05 WATCH. Resolve the three missing freshness-qualified USD/feed/share-rate paths (srUSDe, liquidETH, agETH) and source-bind/model the 0x719529e99b7b272c5ef4ce07c30d15bc57cd68a8 hook (operations=6) before claiming complete Stage-5 economics. Retain bounded negative same-pool rows without treating them as a class-wide disproof. No trigger wiring or fork/live execution follows automatically; any positive candidate needs a concrete public funding/authorization/extraction path, conservative costs and a separately owner-approved named expiring batch envelope.',
  };
  output.verdict = output.counts.unknownRows ? 'FRESH-WATCH / PARTIAL_USD / INCOMPLETE_DATA' : 'FRESH-WATCH / NO_POSITIVE_SAME_POOL_ROUNDTRIP';
  fs.writeFileSync(path.join(ROOT, OUT), `${JSON.stringify(output, null, 2)}\n`);
  const text = report(output);
  fs.writeFileSync(path.join(ROOT, SUMMARY), text);
  fs.writeFileSync(path.join(ROOT, HANDOFF), '# A05 cycle-7 handoff\n\n**WATCH — no promotion; observational-only.**\n\n' +
    `Outputs: \`${OUT}\`, \`${SUMMARY}\`, \`tools/sim-eulerswap-l-cycle7-stage5.js\`, refreshed \`${SCAN}\` (plus scanner CSV/index).\n\n` +
    text + '\nClaims released after verification by a05-cycle7-20261017. Aggregate state/gates left to coordinator.\n');
  console.log(JSON.stringify({ verdict: output.verdict, counts: output.counts, scannerSha256: SCAN_RUN.afterSha256 }, null, 2));
}

if (require.main === module) main().catch(() => { console.error('A05 cycle-7 failed: bounded capture/replay assertion or read failure (details suppressed to protect endpoint material).'); process.exitCode = 1; });
module.exports = { f, fInverse, dfDx, swap, simulate, evaluate };
