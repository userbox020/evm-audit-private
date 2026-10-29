'use strict';

// Source: reviewed pairImpl/contracts, not the canary model. Pure/integer-only.
const MAX = (1n << 256n) - 1n;
const Q72 = 1n << 72n;
const TRANCHE_B = 0x10cd2b2ae53a69d3552n;
function u(v) {
  if (typeof v === 'number' && !Number.isSafeInteger(v)) throw new Error('unsafe uint');
  if (!['bigint', 'number', 'string'].includes(typeof v) || !/^(0|[1-9][0-9]*)$/.test(String(v))) throw new Error('invalid uint');
  const n = BigInt(v); if (n > MAX) throw new Error('uint overflow'); return n;
}
function checked(n) { if (n < 0n || n > MAX) throw new Error('uint underflow/overflow'); return n; }
function mulDiv(a, b, d, ceil = false) {
  const product = checked(u(a) * u(b)), divisor = u(d);
  if (divisor === 0n) throw new Error('division by zero');
  return product / divisor + (ceil && product % divisor !== 0n ? 1n : 0n);
}
function toAssets(shares, assets, totalShares, ceil = false) {
  return u(totalShares) === 0n ? u(shares) : mulDiv(shares, assets, totalShares, ceil);
}
function six(v) { if (!Array.isArray(v) || v.length !== 6) throw new Error('six values required'); return v.map(u); }
function pack(v) {
  if (typeof v === 'bigint') return String(v);
  if (Array.isArray(v)) return v.map(pack);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, pack(x)]));
  return v;
}
function userAssets(balances, assets, shares) {
  const b = six(balances), a = six(assets), s = six(shares);
  return b.map((x, i) => toAssets(x, a[i], s[i], i >= 3));
}
function snapshotAccounting({ accruedAssets, accruedShares, rawAssets, rawShares, balances, pairHeldDepositLShares, externalLiquidity, fragileShares }) {
  const a = six(accruedAssets), s = six(accruedShares), ra = six(rawAssets), rs = six(rawShares);
  const stagedL = toAssets(pairHeldDepositLShares, a[0], s[0], false);
  const base = checked(a[0] - a[3]);
  const activeL = checked(checked(base - stagedL) + u(externalLiquidity));
  // TokenController:308-317 deliberately uses RAW deposit-L assets/shares.
  const fragileDeduction = checked(toAssets(fragileShares, ra[0], rs[0], true) * 95n) / 100n;
  if (fragileDeduction > activeL) throw new Error('FragileLiquidityExceedsActiveLiquidity');
  return pack({ userAssets: userAssets(balances, a, s), stagedL, activeL, fragileDeduction, activeAfterFragile: activeL - fragileDeduction,
    domain: 'interest-view snapshot, BEFORE global/account penalty transition', eligibility: 'UNKNOWN', eligibilityComplete: false });
}
function sqrt(value) {
  const n = u(value); if (n < 2n) return n;
  let x = n, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + n / x) / 2n; } return x;
}
// Validation:192-235. Callers swap min/max INTENTIONALLY for HARD.
function lSides(assets, sqrtMin, sqrtMax) {
  const a = six(assets), min = u(sqrtMin), max = u(sqrtMax);
  if (min === 0n || max === 0n) throw new Error('zero sqrt price');
  return { depositX: checked(a[0] + mulDiv(a[1], Q72, max)), depositY: checked(a[0] + mulDiv(a[2], min, Q72)),
    borrowX: checked(a[3] + mulDiv(a[4], Q72, min, true)), borrowY: checked(a[3] + mulDiv(a[5], max, Q72, true)) };
}
function hardNet(assets, sqrtMin, sqrtMax) {
  const p = lSides(assets, sqrtMax, sqrtMin); // Liquidation:175-178
  let debt = 0n, collateral = 0n, netDebtX = false;
  if (p.depositX <= p.borrowX && p.depositY <= p.borrowY) debt = checked(p.borrowX - p.depositX + p.borrowY - p.depositY);
  else if (p.depositX <= p.borrowX) { debt = p.borrowX - p.depositX; collateral = p.depositY - p.borrowY; netDebtX = true; }
  else if (p.depositY <= p.borrowY) { debt = p.borrowY - p.depositY; collateral = p.depositX - p.borrowX; }
  return pack({ ...p, debt, collateral, netDebtX, priceDomain: 'HARD intentional min/max swap' });
}
function hardPremium(ltvBips) {
  const ltv = u(ltvBips);
  return ltv <= 6000n ? 0n : ltv < 7500n ? mulDiv(66667n, ltv, 10000n) - 40000n : mulDiv(7408n, ltv, 10000n) + 4444n;
}
function hardActualPremium(repaid, seized) { return u(repaid) === 0n ? MAX : mulDiv(seized, 10000n, repaid, true); }
function hardSlicePremium(assets, activeL, sqrtMin, sqrtMax) {
  const net = hardNet(assets, sqrtMin, sqrtMax), debt = u(net.debt), active = u(activeL);
  if (debt >= active) throw new Error('AmmalgamMaxSlippage');
  const debtWithSlippage = mulDiv(active, debt, active - debt, true);
  const ltv = u(net.collateral) > 0n ? mulDiv(debtWithSlippage, 10000n, net.collateral) : 0n;
  return pack({ ...net, debtWithSlippage, ltvBips: ltv, maxSeizedPerRepaidBips: hardPremium(ltv), premiumIsBonus: false });
}
// PartialLiquidations:120-172. Full and zero-repay returns are exact; do NOT
// substitute a proportional slice for unported calcMutation/TickMath geometry.
function partialTranches({ tranches, lastTranche, userAssetAmounts, netRepaidL, netSeizedL, netDebtX }) {
  const a = six(userAssetAmounts), repay = u(netRepaidL), seize = u(netSeizedL);
  if (typeof netDebtX !== 'boolean' || !Number.isInteger(lastTranche) || lastTranche < -32768 || lastTranche > 32767) throw new Error('invalid tranche direction');
  if (!Array.isArray(tranches)) throw new Error('tranches required');
  if (repay === 0n) return { status: 'SOURCE_EXACT_ZERO_REPAY', amounts: a.map(() => '0'), includedTranches: 0 };
  const seizedLimit = mulDiv(seize, 85n, 100n);
  const limit = repay > seizedLimit ? repay : seizedLimit;
  let measured = 0n, partial = 0n, total = 0n, factor = Q72, included = 0;
  for (let i = tranches.length - 1; i >= 0; i--) {
    const relative = mulDiv(tranches[i].satRelativeToL, Q72, factor);
    factor = mulDiv(factor, TRANCHE_B, Q72);
    if (limit > measured) { included++; partial = checked(partial + relative); }
    total = checked(total + relative); measured = checked(measured + u(tranches[i].satInLAssets));
  }
  if (included === tranches.length) return pack({ status: 'SOURCE_EXACT_FULL_SLICE', amounts: a, includedTranches: included });
  const remaining = tranches.length - included;
  return pack({ status: 'UNKNOWN', reason: 'PARTIAL_MUTATION_GEOMETRY_UNPORTED', includedTranches: included, remainingTranches: remaining,
    boundaryTick: (netDebtX ? lastTranche + remaining : lastTranche + 1 - remaining) * 25,
    partialSaturation: partial, totalSaturation: total, requiredMissingInputs: ['source-parity TickMath boundary and calcMutation geometry', 'post-penalty active liquidity'] });
}
function saturationPremium(ratioBips) { const r = u(ratioBips); return r < 10000n ? 0n : (r - 10000n) / 10n; }
function saturationSeized({ depositAssets, ratioBips, remainingShares, rawAssets, rawShares }) {
  if (![depositAssets, remainingShares, rawAssets, rawShares].every(v => Array.isArray(v) && v.length === 3)) throw new Error('three deposit legs required');
  const premium = saturationPremium(ratioBips);
  const seizedAssets = depositAssets.map(v => mulDiv(v, premium, 10000n));
  // Assets floor in Liquidation; Pair.liquidationTransfer converts to shares
  // UP, then caps the actual remaining borrower shares (AmmalgamPair:1024-26).
  const seizedShares = seizedAssets.map((v, i) => {
    const converted = u(rawAssets[i]) === 0n ? v : mulDiv(v, rawShares[i], rawAssets[i], true);
    return converted < u(remainingShares[i]) ? converted : u(remainingShares[i]);
  });
  return pack({ premiumBipsOfDeposits: premium, seizedAssets, seizedShares, eligibility: 'UNKNOWN',
    requiredMissingInputs: ['both official Saturation.calcLiqSqrtPriceQ72 roots', 'actual pair+borrower calcSatChangeRatioBips on post-penalty state'] });
}
// Liquidation:236-326 complete standalone arithmetic for PROVIDED inputParams.
// This is not the preceding on-chain penalties/interest/repayment transition.
function leverageProjection({ assets, sqrtMin, sqrtMax }) {
  const a = six(assets), averageSqrtPrice = sqrt(checked(u(sqrtMin) * u(sqrtMax)));
  const p = lSides(a, averageSqrtPrice, averageSqrtPrice);
  const deposit = checked(p.depositX + p.depositY) / 2n, borrow = checked(p.borrowX + p.borrowY) / 2n;
  if (checked(100n * borrow) <= checked(99n * deposit + 1000n)) return pack({ status: 'SOURCE_REVERT', reason: 'LiquidationZeroPremium', averageSqrtPrice, depositL: deposit, borrowL: borrow });
  let premium = (100n * borrow - 99n * deposit) / 1000n, remaining = 0n, badDebt = false;
  if (deposit < premium) premium = deposit; else remaining = deposit - premium;
  let repay;
  if (borrow < remaining) repay = checked(remaining - 100n * (remaining - borrow));
  else { repay = remaining; badDebt = true; }
  const seized = checked(repay + premium);
  const amounts = a.map((v, i) => {
    const amount = mulDiv(v, i < 3 ? seized : repay, i < 3 ? deposit : borrow, i >= 3);
    return v < amount ? v : amount;
  });
  return pack({ status: 'SOURCE_EXACT_CONDITIONAL_ARITHMETIC', averageSqrtPrice, depositL: deposit, borrowL: borrow, premiumValueL: premium, repayL: repay, seizedL: seized, badDebt, amounts, eligibility: 'UNKNOWN', eligibilityComplete: false });
}
function accountBranches(assets) {
  const a = six(assets), hasBorrow = a.slice(3).some(v => v > 0n);
  return { hasBorrowInInterestView: hasBorrow, eligibility: 'UNKNOWN', eligibilityComplete: false,
    preTransitionNoBorrowWouldNoop: !hasBorrow,
    HARD: { status: 'UNKNOWN', reason: 'PENALTY_TRANSITION_AND_DIRECTIONAL_TRANCHE_SLICE_NOT_COMPLETE', requiredMissingInputs: ['post-penalty getInputParams(borrower,false)', 'raw reserves and min/max TickMath sqrt prices', 'directional saturation account and partial geometry'] },
    SATURATION: { status: 'UNKNOWN', reason: 'OFFICIAL_ROOTS_AND_POST_PENALTY_RATIO_NOT_PROJECTED', requiredMissingInputs: ['raw fragile deduction', 'both official liquidation roots', 'pair+borrower saturation ratio', 'actual remaining shares'] },
    LEVERAGE: { status: 'UNKNOWN', reason: 'ARITHMETIC_PORTED_BUT_POST_PENALTY_INPUTS_MISSING', requiredMissingInputs: ['global penalty mint and account-specific debt-share transfer', 'subsequent interest and getInputParams(borrower,false) sqrt prices', 'actual repayment and bad-debt burn transitions'] } };
}
module.exports = { MAX, Q72, TRANCHE_B, u, checked, mulDiv, toAssets, six, pack, userAssets, snapshotAccounting, sqrt, lSides, hardNet, hardPremium, hardActualPremium, hardSlicePremium, partialTranches, saturationPremium, saturationSeized, leverageProjection, accountBranches };
