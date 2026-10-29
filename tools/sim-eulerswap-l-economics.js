'use strict';

// Offline only: built-in filesystem/crypto modules; no provider, signer or RPC imports.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const DIR = 'reports/raw/fast/novelty-rerank-20261017';
const SCAN = 'reports/raw/fast/eulerswap-l.json';
const CSV = 'reports/raw/fast/eulerswap-l.csv';
const EXTRACT = `${DIR}/A05-stage4-evidence/surface-extraction.json`;
const SURFACE = `${DIR}/A05-stage4-surface.md`;
const WAD = 10n ** 18n;
// This is the REQUESTED arbitrary normalization, NOT a source-backed USD oracle.
const HINT_SCALE = 10n ** 27n;
const MAX112 = (1n << 112n) - 1n;
const MAX256 = (1n << 256n) - 1n;
const SIZES = [1000n, 10000n, 50000n];
const GAS = 50n * HINT_SCALE;
const FIELDS = ['reserve0', 'reserve1', 'equilibriumReserve0', 'equilibriumReserve1',
  'priceX', 'priceY', 'concentrationX', 'concentrationY', 'fee0', 'fee1'];

function read(file) { return fs.readFileSync(path.join(ROOT, file)); }
function hash(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function ceilDiv(a, b) { assert(b > 0n); return (a + b - 1n) / b; }
function max(a, b) { return a > b ? a : b; }
function bitLength(a) { return a === 0n ? 0n : BigInt(a.toString(2).length); }
function sqrt(a) {
  assert(a >= 0n);
  if (a < 2n) return a;
  let x = 1n << ceilDiv(bitLength(a), 2n);
  for (;;) {
    const next = (x + a / x) / 2n;
    if (next >= x) return x;
    x = next;
  }
}
function sqrtUp(a) { const r = sqrt(a); return r * r === a ? r : r + 1n; }
function decimal(a) {
  const sign = a < 0n ? '-' : '';
  const n = a < 0n ? -a : a;
  const fraction = (n % HINT_SCALE).toString().padStart(27, '0').replace(/0+$/, '');
  return `${sign}${n / HINT_SCALE}${fraction ? `.${fraction}` : ''}`;
}

// CurveLib.sol:59-79. All surfaced parameters fit the documented arithmetic bounds.
function f(x, px, py, x0, y0, c) {
  assert(x > 0n && x <= x0 && py > 0n && c <= WAD);
  const y = y0 + (c === WAD ? ceilDiv((x0 - x) * px, py)
    : ceilDiv(px * (x0 - x) * (c * x + (WAD - c) * x0), WAD * x * py));
  return y > MAX112 ? MAX256 : y;
}

// CurveLib.sol:94-170, including the sign-dependent rounding and root rescaling.
function fInverse(y, px, py, x0, y0, c) {
  assert(y >= y0 && y <= MAX112 && px > 0n && py > 0n && c <= WAD);
  const term1 = WAD * ((y - y0) * py + x0 * px);
  const term2 = 2n * c * x0 * px;
  assert(term1 <= MAX256 && term2 <= MAX256, 'fInverse intermediate exceeds uint256');
  const negative = term1 < term2;
  const difference = negative ? term2 - term1 : term1 - term2;
  const b = negative ? ceilDiv(difference, px) : difference / px;
  const shift = max(max(0n, bitLength(b) - 127n),
    max(0n, bitLength(x0 * 3814697265625n) - 109n));
  const scale = 1n << (shift * 2n);
  const ac = 4n * c * (WAD - c) * x0 * x0;
  let x;
  if (negative) {
    const root = sqrtUp(ceilDiv(b * b, scale) + ceilDiv(ac, scale)) << shift;
    x = ceilDiv(b + root, 2n * c);
  } else {
    const root = sqrt(b * b / scale + ac / scale) << shift;
    const denominator = b + root;
    // EVM unsafe division's 0/0 -> 0, including the constant-sum endpoint.
    x = denominator === 0n ? 0n : ceilDiv(2n * (WAD - c) * x0 * x0, denominator);
  }
  return x > x0 ? x - 1n : x;
}

// CurveExtrasLib.sol:55-59: signed derivative, NOT a token amount-out.
function dfDx(x, px, py, x0, c) {
  if (x === 0n) return null;
  const r = ceilDiv((x0 * x0 / x) * WAD, x);
  return -(px * (c + (WAD - c) * r / WAD) / py);
}
function marginalPrice(p, r0, r1, input0) {
  let derivative;
  let reciprocal = false;
  if (input0 && r0 <= p.equilibriumReserve0) {
    derivative = dfDx(r0, p.priceX, p.priceY, p.equilibriumReserve0, p.concentrationX);
  } else if (input0) {
    derivative = dfDx(fInverse(r0, p.priceY, p.priceX, p.equilibriumReserve1,
      p.equilibriumReserve0, p.concentrationY), p.priceY, p.priceX,
    p.equilibriumReserve1, p.concentrationY);
    reciprocal = true;
  } else if (r1 <= p.equilibriumReserve1) {
    derivative = dfDx(r1, p.priceY, p.priceX, p.equilibriumReserve1, p.concentrationY);
    reciprocal = true;
  } else {
    derivative = dfDx(fInverse(r1, p.priceX, p.priceY, p.equilibriumReserve0,
      p.equilibriumReserve1, p.concentrationX), p.priceX, p.priceY,
    p.equilibriumReserve0, p.concentrationX);
  }
  if (derivative === null || derivative === 0n) return null;
  return -(reciprocal ? WAD * WAD / derivative : derivative);
}

// QuoteLib.findCurvePoint exact-in reserve deltas; SwapLib:138-144 state update.
function swap(p, r0, r1, amount, input0) {
  assert(amount >= 0n && amount <= MAX112, 'input exceeds uint112');
  if (amount === 0n) return { out: 0n, fee: 0n, r0, r1, marginal: null };
  const fee = amount * (input0 ? p.fee0 : p.fee1) / WAD;
  const effective = amount - fee;
  let out;
  if (input0) {
    r0 += effective;
    assert(r0 <= MAX112, 'new reserve0 exceeds uint112');
    const y = r0 <= p.equilibriumReserve0
      ? f(r0, p.priceX, p.priceY, p.equilibriumReserve0, p.equilibriumReserve1, p.concentrationX)
      : fInverse(r0, p.priceY, p.priceX, p.equilibriumReserve1, p.equilibriumReserve0, p.concentrationY);
    out = r1 > y ? r1 - y : 0n;
    r1 -= out;
  } else {
    r1 += effective;
    assert(r1 <= MAX112, 'new reserve1 exceeds uint112');
    const x = r1 <= p.equilibriumReserve1
      ? f(r1, p.priceY, p.priceX, p.equilibriumReserve1, p.equilibriumReserve0, p.concentrationY)
      : fInverse(r1, p.priceX, p.priceY, p.equilibriumReserve0, p.equilibriumReserve1, p.concentrationX);
    out = r0 > x ? r0 - x : 0n;
    r0 -= out;
  }
  return { out, fee, r0, r1, marginal: marginalPrice(p, r0, r1, input0) };
}

function simulate(p, pair, size, input0) {
  const inputPrice = input0 ? p.priceX : p.priceY;
  const outputPrice = input0 ? p.priceY : p.priceX;
  const amount = size * HINT_SCALE / inputPrice;
  const first = swap(p, p.reserve0, p.reserve1, amount, input0);
  // Crucial: unwind against the post-first-leg state, never the original scan state.
  const second = swap(p, first.r0, first.r1, first.out, !input0);
  const quote = second.out * inputPrice;
  const fees = first.fee * inputPrice + second.fee * outputPrice;
  const net = quote - size * HINT_SCALE - fees - GAS;
  return {
    direction: input0 ? 'asset0-asset1-asset0' : 'asset1-asset0-asset1',
    quoteOut: decimal(quote), feeTotal: decimal(fees), net: decimal(net),
    routePositive: net > 0n,
    netWithoutExtraFeeDebit: decimal(quote - size * HINT_SCALE - GAS),
    inputRaw: amount.toString(), inputHintActual: decimal(amount * inputPrice),
    firstLegOutRaw: first.out.toString(), secondLegOutRaw: second.out.toString(),
    firstLegFeeRaw: first.fee.toString(), secondLegFeeRaw: second.fee.toString(),
    firstLegMarginalPriceRawRatioWad: first.marginal === null ? null : first.marginal.toString(),
    secondLegMarginalPriceRawRatioWad: second.marginal === null ? null : second.marginal.toString(),
    withinObservedForwardLimits: input0 ? effectiveWithinLimits(amount, first, pair) : null,
    reverseLimitsValidated: false,
    netNumerator: net,
  };
}
function effectiveWithinLimits(amount, first, pair) {
  if (pair.limitInRaw == null || pair.limitOutRaw == null) return null;
  return amount - first.fee <= BigInt(pair.limitInRaw) && first.out <= BigInt(pair.limitOutRaw);
}

function main() {
  const scanBytes = read(SCAN);
  const csvBytes = read(CSV);
  assert.equal(hash(scanBytes), '28565b91e458eb8d8b2ff74e28d903aed7e6cdbec96659ffae3ba3a6087aa3da',
    'scan changed: refusing to silently rebind');
  assert.equal(hash(csvBytes), '41c4489af5837f5812fa20552a249e6b8593a7ae6284deaa6704c224592e41f3');
  const scan = JSON.parse(scanBytes);
  const extraction = JSON.parse(read(EXTRACT));
  assert.equal(scan.scannedAt, extraction.scannedAt);
  const listedSection = read(SURFACE).toString().split('### Conservative operational-surface pool addresses')[1]
    .split('## Reproduction')[0];
  const listed = listedSection.match(/0x[0-9a-f]{40}/g);
  const rows = [];
  const pools = [];
  for (const chain of extraction.chains) {
    const scanned = scan.chains.find(c => c.chainId === chain.chainId);
    assert.deepEqual(scanned.pin, chain.pinBlock);
    for (const address of chain.operationalSurfacePoolAddresses) {
      assert(listed.includes(address), 'candidate not in Stage-4 source list');
      const extracted = chain.pools.find(p => p.address === address);
      const pair = scanned.pairs.find(p => p.pool === address);
      assert(extracted && pair && extracted.operationalSurfaceCandidate);
      for (const field of FIELDS) {
        const value = field.startsWith('reserve') ? pair[`${field}Raw`]
          : pair.dynamicParams[`${field}Raw`];
        assert.equal(extracted[field], value, `${address}: extraction mismatch in ${field}`);
      }
      for (const field of ['asset0', 'asset1', 'swapVolumeObserved', 'staticParamsSource']) {
        assert.equal(extracted[field], pair[field]);
      }
      const missing = FIELDS.filter(field => extracted[field] == null || BigInt(extracted[field]) === 0n);
      const p = Object.fromEntries(FIELDS.map(field => [field,
        extracted[field] == null ? null : BigInt(extracted[field])]));
      if (!missing.length) {
        assert(p.concentrationX <= WAD && p.concentrationY <= WAD);
        assert(p.fee0 < WAD && p.fee1 < WAD);
        assert.equal(BigInt(pair.dynamicParams.swapHookedOperations), 0n, 'unmodeled swap hook');
      }
      const pool = {
        chainId: chain.chainId, poolAddress: address, asset0: pair.asset0, asset1: pair.asset1,
        pin: scanned.pin, staticParamsSource: pair.staticParamsSource,
        parameters: Object.fromEntries(FIELDS.map(field => [field, extracted[field]])),
        tvlUSD: null,
        tvlUSDHint: p.priceX === null || p.priceY === null ? null
          : decimal(p.reserve0 * p.priceX + p.reserve1 * p.priceY),
        valuationStatus: 'INCOMPLETE_DATA_NO_ABSOLUTE_USD_ANCHOR',
        swapVolumeObserved: pair.swapVolumeObserved,
        observationNovel: pair.swapVolumeObserved === 0,
        missingOrZeroFields: missing,
      };
      pools.push(pool);
      for (const size of SIZES) {
        const row = {
          chainId: chain.chainId, poolAddress: address, asset0: pair.asset0, asset1: pair.asset1,
          size: size.toString(), quoteOut: null, feeTotal: null, net: null, routePositive: null,
          observationNovel: pool.observationNovel, swapVolumeObserved: pool.swapVolumeObserved,
          economics: missing.length ? 'INCOMPLETE' : 'COMPUTED_SCALAR_HINT_ONLY',
          usdEconomics: 'INCOMPLETE_DATA',
          quoteCurrency: 'UNVALIDATED_USD_SCALAR_HINT_NOT_USDC',
          tvlUSD: null, tvlUSDHint: pool.tvlUSDHint,
          missingOrZeroFields: missing, gas: '50',
        };
        if (!missing.length) {
          const directions = [true, false].map(input0 => simulate(p, pair, size, input0));
          const best = directions.reduce((a, b) => a.netNumerator >= b.netNumerator ? a : b);
          for (const field of ['quoteOut', 'feeTotal', 'net', 'routePositive', 'direction']) row[field] = best[field];
          row.directionQuotes = directions.map(({ netNumerator, ...result }) => result);
        }
        rows.push(row);
      }
    }
  }
  assert.equal(pools.length, 11);
  assert.equal(listed.length, pools.length);
  assert.equal(new Set(pools.map(p => `${p.chainId}:${p.poolAddress}`)).size, 11);
  assert.equal(rows.length, 33);
  const counts = SIZES.map(size => ({
    size: size.toString(),
    positive: rows.filter(r => r.size === size.toString() && r.routePositive === true).length,
    negative: rows.filter(r => r.size === size.toString() && r.routePositive === false).length,
    incomplete: rows.filter(r => r.size === size.toString() && r.routePositive === null).length,
  }));
  const positivePools = pools.filter(p => rows.some(r => r.poolAddress === p.poolAddress && r.routePositive === true));
  const output = {
    schema: 'a05-stage5-offline-economics/v1',
    signal: 'WATCH; arbitrary scalar-hint sensitivity, not validated USD economics or an executable route',
    sourceScannedAt: scan.scannedAt,
    sourceBindings: [SCAN, CSV, EXTRACT, SURFACE].map(file => ({ file, sha256: hash(read(file)) })),
    safety: { offlineOnly: true, newRpc: false, fork: false, signing: false, broadcast: false },
    methodology: {
      amountOut: 'QuoteLib.findCurvePoint exact-in reserve deltas, with CurveLib f/fInverse; unwind uses updated reserves',
      derivative: 'CurveExtrasLib df_dx and 1e36/df_dx are marginal-price diagnostics only, not amount-out',
      scalarHint: 'raw reserve/amount multiplied by priceX or priceY then divided by 1e27, literally as requested',
      valuationWarning: 'Curve coefficients have arbitrary common scale and only establish relative raw-unit prices. No absolute USD anchor or token decimals are present in the supplied data; all monetary outputs are unvalidated scalar hints. tvlUSD remains null.',
      roundTrip: 'Same-pool two-leg unwind; both starting assets evaluated and larger net selected per size',
      feeAccounting: 'quoteOut is after both input fees; requested net additionally subtracts feeTotal (conservative double debit). netWithoutExtraFeeDebit is also provided per direction.',
      gasGweiAssumption: '30', gasUSDScalarHintAssumption: '50',
      limits: 'Captured forward limits checked diagnostically; no reverse limits, hooks, vault/EVC execution, external USDC liquidation or funding path validated',
      zeroFieldPolicy: 'Zero concentrations/fees marked INCOMPLETE per request, although zero is legal in contract math; null routePositive means unknown, never negative',
    },
    aggregateGates: { routePositive: 'unknown', executableNow: 'unknown', signedActionJustified: false },
    counts: {
      candidates: pools.length, rows: rows.length,
      observationNovelPools: pools.filter(p => p.observationNovel).length,
      observationNovelRows: rows.filter(r => r.observationNovel).length,
      computedHintRows: rows.filter(r => r.economics === 'COMPUTED_SCALAR_HINT_ONLY').length,
      incompleteParameterRows: rows.filter(r => r.economics === 'INCOMPLETE').length,
      validatedUSDEconomicsRows: 0, bySize: counts,
    },
    cycle6TriggerCandidates: [],
    offlineHintPositivePools: positivePools.map(p => ({ chainId: p.chainId, poolAddress: p.poolAddress })),
    pools, rows,
  };
  fs.writeFileSync(path.join(ROOT, `${DIR}/A05-stage5-economics.json`), `${JSON.stringify(output, null, 2)}\n`);
  fs.writeFileSync(path.join(ROOT, `${DIR}/A05-stage5-economics-summary.md`), summary(output));
  console.log(JSON.stringify(output.counts, null, 2));
}

function summary(o) {
  return `# A05 Stage-5 offline economics\n\n**WATCH — scalar-hint sensitivity only; USD economics INCOMPLETE_DATA, aggregate route/execution UNKNOWN.**\n\n` +
    `## Results\n\n11 candidates (Ethereum 10, Base 1), 33 pool/size rows; both round-trip orientations evaluated. ` +
    `${o.counts.computedHintRows} computed scalar-hint rows; ${o.counts.incompleteParameterRows} parameter-incomplete rows. ` +
    `${o.counts.observationNovelPools} observation-novel pools (${o.counts.observationNovelRows} rows).\n\n` +
    `| Nominal size | Hint-positive | Hint-negative | Incomplete/unknown |\n|---|---:|---:|---:|\n` +
    o.counts.bySize.map(c => `| $${c.size} | ${c.positive} | ${c.negative} | ${c.incomplete} |`).join('\n') +
    `\n\nPools positive at any size under the literal hint normalization: ${o.offlineHintPositivePools.length ? o.offlineHintPositivePools.map(p => `\`${p.poolAddress}\``).join(', ') : '**none**'}.\n\n` +
    `**Cycle-6 trigger-wiring candidate list: empty.** No pool class passes validated USD Stage-5 economics. ` +
    `Do not promote hint-negative or incomplete rows into a real-world route-negative gate.\n\n` +
    `## Per-pool reserve and observation tally\n\n` +
    `Reserve metric below is (reserve0Raw * priceX + reserve1Raw * priceY) / 1e27, exactly the requested scalar-hint normalization. ` +
    `It is NOT established USD TVL or backing; genuine tvlUSD is null for every pool.\n\n` +
    `| Chain | Pool | Reserve-value hint (not USD) | Observed Swap events | Observation novel | Parameter status |\n|---|---|---:|---:|---|---|\n` +
    o.pools.map(p => `| ${p.chainId} | \`${p.poolAddress}\` | ${p.tvlUSDHint} | ${p.swapVolumeObserved} | ${p.observationNovel} | ${p.missingOrZeroFields.length ? `INCOMPLETE: ${p.missingOrZeroFields.join(', ')}` : 'complete curve inputs'} |`).join('\n') +
    `\n\nZero observed events means no events recorded in the scanner's bounded observation window, NOT proof of no historical trading. ` +
    `The only nonzero counts are 8, 5 and 1; these do not establish a high-volume/competitive-MEV-thick class.\n\n` +
    `## Math and monetary assumptions\n\n` +
    `- Node BigInt for all curve, amount, fee and monetary calculations; decimal strings retain 27 fractional digits without floating-point conversion.\n` +
    `- CurveLib.sol:94-170 fInverse is mirrored with sign-dependent rounding/root rescaling. QuoteLib.sol:237-280 reserve deltas supply amount-out. CurveExtrasLib.sol:38 is a marginal-price traversal, not a quote-out or a profit formula; its derivative traversal is included separately as raw-unit WAD diagnostics.\n` +
    `- Each first leg deducts floor(amount * directional fee / 1e18); the second leg starts from the UPDATED reserves and deducts the opposite directional fee. Both asset0->asset1->asset0 and asset1->asset0->asset1 are computed; the larger net is selected. These are same-pool unwinds, not a supplied external arbitrage/EVC extraction path.\n` +
    `- The requested net = quoteOut - nominal input - feeTotal - 50 is used literally. quoteOut already includes both swap fees, so the extra feeTotal subtraction double-debits fees conservatively; each direction also records netWithoutExtraFeeDebit. Quotes returning non-USDC assets are NOT USDC liquidation quotes.\n` +
    `- 30 gwei and flat $50 gas on either chain are arbitrary user-supplied assumptions, not estimates based on gas units/ETH-USD. Price coefficients divided by 1e27 are likewise an unvalidated requested sensitivity, not USD prices.\n` +
    `- IMPORTANT dimensional correction: supplied CurveLib.sol:87-91 describes coefficient/concentration bases of 1e18, not a mandatory common 1e27 USD basis. Only priceX/priceY matters to the curve: multiplying both coefficients by the same positive scalar leaves swaps unchanged but changes this hint metric and nominal-size mapping. Two USDC/USDT pools use priceX=priceY=1 and another uses 1e18. Applying /1e27 therefore yields incomparable nominal reserve values. No absolute USD anchor or token decimals were supplied; we do NOT invent those. usdEconomics=INCOMPLETE_DATA for all 33 rows.\n` +
    `- Zero concentrationX/Y and fee0/1 in pool 0x719529e99b7b272c5ef4ce07c30d15bc57cd68a8 produce economics=INCOMPLETE and null quotes/net/routePositive for its three sizes. Zero is legal on-chain, but excluded under the requested zero-field policy; poolDeployed-log provenance alone is not treated as missing data.\n` +
    `- Observed forward-direction limits are diagnostics only; reverse limits and actual vault liquidity, funding, minimum reserves, hooks, authentication and EVC dispatch are not fully validated. Most nominal hint sizes need not be feasible. No execution claim follows from a computed flag.\n\n` +
    `## Source bindings and address correction\n\n` +
    o.sourceBindings.map(s => `- \`${s.file}\`: SHA-256 \`${s.sha256}\`.`).join('\n') +
    `\n\nScanned at ${o.sourceScannedAt}; exact chain/block hashes are retained per pool. ` +
    `The prompt's Base address 0x4687e171bea250e3048d8f426b32cb16be7a8a8 is malformed (39 hex digits) and absent from the authoritative surface. ` +
    `Stage-4 line 312, extraction and scanner all bind **0x4687e171bea250e3048d8f426b32cb16be17a8a8**; that address is used, without heuristic matching.\n\n` +
    `## Scope and recommended next cycle\n\n` +
    `No new RPC, fork rehearsal, signing, broadcast, provider/key access or shared-rpc modification. Economics inputs came ONLY from the existing scanner JSON and surface-extraction JSON; CSV/report were used for integrity/candidate-list binding.\n\n` +
    `Next cycle: resolve source-backed absolute USD/unit calibration (or explicitly approve a calibrated valuation scenario), zero-field completeness, and a concrete funded actor-to-extraction route before trigger wiring. ` +
    `Any subsequent live validation/trade requires fresh chainstate, the appropriate EVC batch caller deployment/binding, and a fresh named expiring batch envelope. None is authorized or attempted here. Offline routePositive flags never establish executability.\n\n` +
    `Reproduce: \`node tools/sim-eulerswap-l-economics.js\`. Aggregate routePositive=unknown; executableNow=unknown; signedActionJustified=false.\n`;
}

if (require.main === module) main();
