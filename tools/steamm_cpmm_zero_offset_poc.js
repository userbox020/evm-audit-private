#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const IN_FILE = path.join(ROOT, 'reports', 'raw', 'suilend-suite-candidate-probe.json');
const OUT_FILE = path.join(ROOT, 'reports', 'raw', 'steamm-cpmm-zero-offset-poc.json');

function divUp(x, y) {
  return (x + y - 1n) / y;
}

function cpmmQuote(amountIn, reserveIn, reserveOut, offset, a2b) {
  const reserveInAdjusted = a2b ? reserveIn : reserveIn + offset;
  const reserveOutAdjusted = a2b ? reserveOut + offset : reserveOut;
  if (reserveInAdjusted + amountIn === 0n) throw new Error('division by zero');
  return reserveOutAdjusted * amountIn / (reserveInAdjusted + amountIn);
}

function fees(grossOut, protocolFeeConfig, poolFeeConfig) {
  const poolNum = BigInt(poolFeeConfig && poolFeeConfig.fee_numerator || 0);
  const poolDen = BigInt(poolFeeConfig && poolFeeConfig.fee_denominator || 1);
  const protocolNum = BigInt(protocolFeeConfig && protocolFeeConfig.fee_numerator || 0);
  const protocolDen = BigInt(protocolFeeConfig && protocolFeeConfig.fee_denominator || 1);
  const totalFees = poolNum === 0n ? 0n : divUp(grossOut * poolNum, poolDen);
  const protocolFees = protocolNum === 0n ? 0n : divUp(totalFees * protocolNum, protocolDen);
  const poolFees = totalFees - protocolFees;
  return { totalFees, protocolFees, poolFees, netOut: grossOut - totalFees };
}

function k(reserveA, reserveB, offset) {
  return reserveA * (reserveB + offset);
}

function compactType(type) {
  return String(type || '').split('::').slice(-2).join('::');
}

function main() {
  const probe = JSON.parse(fs.readFileSync(IN_FILE, 'utf8'));
  const pools = probe.steamm.zeroOffsetOneSidedCpmmPools || [];
  const amountIn = 1n;
  const cases = pools.map((pool) => {
    const reserveA = BigInt(pool.balanceA);
    const reserveB = BigInt(pool.balanceB);
    const offset = BigInt(pool.offset);
    const bEmpty = reserveB === 0n;
    const a2b = !bEmpty;
    const reserveIn = bEmpty ? reserveB : reserveA;
    const reserveOut = bEmpty ? reserveA : reserveB;
    const grossOut = cpmmQuote(amountIn, reserveIn, reserveOut, offset, a2b);
    const fee = fees(grossOut, pool.protocolFeeConfig, pool.poolFeeConfig);
    const reserveAAfter = bEmpty ? reserveA - fee.protocolFees - fee.netOut : reserveA + amountIn;
    const reserveBAfter = bEmpty ? reserveB + amountIn : reserveB - fee.protocolFees - fee.netOut;
    const k0 = k(reserveA, reserveB, offset);
    const k1 = k(reserveAAfter, reserveBAfter, offset);
    const outputBankFunds = BigInt(pool.outputBankFundsAvailable || 0);
    return {
      poolId: pool.objectId,
      direction: bEmpty ? 'B to A' : 'A to B',
      inputBTokenType: compactType(pool.inputBTokenType),
      outputBTokenType: compactType(pool.outputBTokenType),
      amountIn: amountIn.toString(),
      reserveA: reserveA.toString(),
      reserveB: reserveB.toString(),
      offset: offset.toString(),
      grossOut: grossOut.toString(),
      totalFees: fee.totalFees.toString(),
      protocolFees: fee.protocolFees.toString(),
      poolFeesLeftInReserve: fee.poolFees.toString(),
      netOut: fee.netOut.toString(),
      k0: k0.toString(),
      k1: k1.toString(),
      invariantPasses: k1 > 0n && k1 >= k0,
      directOutputBankFundsAvailable: outputBankFunds.toString(),
      directOutputBankCanCoverNetOut: outputBankFunds >= fee.netOut,
    };
  });

  cases.sort((a, b) => BigInt(b.netOut) > BigInt(a.netOut) ? 1 : -1);
  const exploitableMath = cases.filter((x) => x.invariantPasses && BigInt(x.netOut) > 0n);
  const directlyRedeemable = exploitableMath.filter((x) => x.directOutputBankCanCoverNetOut);
  const out = {
    generatedAt: new Date().toISOString(),
    source: path.relative(ROOT, IN_FILE),
    result: {
      zeroOffsetOneSidedCpmmPools: pools.length,
      exploitableByFormula: exploitableMath.length,
      directlyCoveredByOutputBankFunds: directlyRedeemable.length,
    },
    formula: {
      cpmm: 'amount_out = reserve_out_adjusted * amount_in / (reserve_in_adjusted + amount_in)',
      oneSidedZeroOffset: 'reserve_in_adjusted = 0, offset = 0, amount_in = 1 => amount_out = reserve_out',
      invariant: 'k = reserve_a * (reserve_b + offset); pool fees left in reserve make k1 > 0 while k0 = 0',
    },
    cases,
  };
  fs.writeFileSync(OUT_FILE, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`wrote ${path.relative(ROOT, OUT_FILE)}`);
  console.log(`formula-positive pools: ${exploitableMath.length}/${pools.length}`);
  console.log(`direct output-bank coverage: ${directlyRedeemable.length}/${pools.length}`);
  if (directlyRedeemable[0]) {
    console.log(`top net output: ${directlyRedeemable[0].netOut} ${directlyRedeemable[0].outputBTokenType} from pool ${directlyRedeemable[0].poolId}`);
  }
}

main();
