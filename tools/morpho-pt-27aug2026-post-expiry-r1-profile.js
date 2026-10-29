#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');

const EXPIRY = 1787788800;
const SELECTORS = Object.freeze({
  market: '50d8db4e',
  idToMarketParams: '2c3c9157',
  price: 'a035b1fe',
  latestRoundData: 'feaf968c',
  expiry: 'e184c9be',
  isExpired: '2f13b60c',
});
const ADDRESSES = Object.freeze({
  morpho: '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb',
  loanToken: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  irm: '0x870ac11d48b15db9a138cf899d20f13f79ba00bc',
  apxPt: '0xd28b0d694b8e814fa905a8b480b30691e18396eb',
  apxYt: '0xc95541af9925035eed46051466d7ae011574293c',
  apyPt: '0xee5c7cda577484b70b65c21235ecbd302bb290e2',
  apyYt: '0x67553fb2ab2a411029387e1c53c0a3e55f8d10c9',
  apxOracle: '0x5a25dd4c2fcb3f260407102eff711f54e22d5408',
  apyDiscountedOracle: '0x2c0a8c81d61529bc08e0a4f780d098c8595c9158',
  apyParOracle: '0x60c98189f7c21540d4a3b8aeade5d5d0aac82aa0',
  apxWrapper: '0x130e1c3c755588ccfa08482ce8066c0d94676efe',
  apyWrapper: '0xbdf49b12043906b646e4faee7413ca61f2262aec',
  apxInner: '0x88cdf49e2e75486a5d14cf4919bcae8172ce0f11',
  apyInner: '0xe2f3f39beed93e632f051325b916c688819d7f63',
  underlyingFeed: '0x651b101f72f82630cf59c68e6ee4305afbd3b1f5',
  discountedQuoteFeed: '0x7886fe58b96f0f285bec3a2522f938c8133a5ff8',
  parQuoteFeed: '0xc3866d726c204c0836e0677a31973c649888973d',
});
const MARKETS = Object.freeze({
  apx: '4483b864209c50da2be8fc75371db0e92fdc6bc8920d86fc9b56ea7383f8c9d1',
  apyDiscounted: '62878115c6ee109c256237eb6daef589d006258202682d2e210cad3bb19e0f09',
  apyPar: 'b0dc5da84948f8c4bc35721b1c1c263f5fa966a8ab179cc964c7577d2d2f30ea',
});
const RUNTIME_BASELINES = Object.freeze({
  morpho: [15623, '0xfd5aa16eea01735e0e33e51e913a27f7d5ed998adc0cec2bf1f9ea368d9e1bdf'],
  apxOracle: [2598, '0x77d3d9cf08882f7b4a75ec0f0b671613d3bdc64a428e2f65ca52aaf3b2868a13'],
  apyDiscountedOracle: [2598, '0x8016ec3412e86104edc7ba3c54c273b051a76f09725b427da0c31c9b39ea9f82'],
  apyParOracle: [2598, '0x607400bb82dd741eb39b6bf817763d257580d2c245e8dc43d5d8d0828e11eafd'],
  apxWrapper: [923, '0x6751e331fcf1d4f73b33f26506dbf6dba5de95c56209601750273fa5e178895b'],
  apyWrapper: [923, '0x117f1336acbb025133de584cb70e51d16beca9a7e8ae014baa5c5368f52a8ee4'],
  apxInner: [951, '0xcacf50327e8f619877c4e9e04decc2da221d59fef0615cec038fac1068a1eda7'],
  apyInner: [951, '0x30dc9484f2544c2cb65fb2262a59a1b401ec3aafd5043073502b13f4013e5e84'],
  apxPt: [5858, '0xe769be83c12cd110b249a594697787eb3f80ead0ca00a84e3e8365ed257178d6'],
  apyPt: [5858, '0x386af811cd521bf67b81d7dedde04e0149a410768f5aecf5841a35694cef1d81'],
  apxYt: [19330, '0xde2050e865c6e51994d3130b7ace422248f0ae253421b082e091926c3d2f039c'],
  apyYt: [19330, '0x000e199cfb83ad9cc8366b927d85bc7f24f206a4c410d564139201fc25928b76'],
});

const canonical = (value) => {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
};
const deepFreeze = (value) => { if (value && typeof value === 'object') { for (const item of Object.values(value)) deepFreeze(item); Object.freeze(value); } return value; };
const word = (value) => BigInt(value).toString(16).padStart(64, '0');
const addressWord = (value) => value.toLowerCase().slice(2).padStart(64, '0');
const calldata = (selector, argument = '') => `0x${selector}${argument}`;
const call = (id, address, data, result) => ({ id, scope: 'boundary', kind: 'call', address, data, result });
const code = (id, key) => ({ id, scope: 'boundary', kind: 'code', address: ADDRESSES[key], result: { type: 'codeSha256Baseline', bytes: RUNTIME_BASELINES[key][0], sha256: RUNTIME_BASELINES[key][1] } });
const marketCall = (id, marketId) => call(id, ADDRESSES.morpho, calldata(SELECTORS.market, marketId), { type: 'tupleWords', words: 6 });
const paramsValue = (collateral, oracle) => `0x${addressWord(ADDRESSES.loanToken)}${addressWord(collateral)}${addressWord(oracle)}${addressWord(ADDRESSES.irm)}${word(860000000000000000n)}`;
const paramsCall = (id, marketId, collateral, oracle) => call(id, ADDRESSES.morpho, calldata(SELECTORS.idToMarketParams, marketId), { type: 'bytesBaseline', value: paramsValue(collateral, oracle) });
const priceCall = (id, address) => call(id, address, calldata(SELECTORS.price), { type: 'positiveUint256' });
const roundCall = (id, address, role) => call(id, address, calldata(SELECTORS.latestRoundData), { type: 'roundData', role });
const expiryCall = (id, address) => call(id, address, calldata(SELECTORS.expiry), { type: 'uint256Exact', value: EXPIRY });
const expiredCall = (id, address) => call(id, address, calldata(SELECTORS.isExpired), { type: 'bool' });

const profile = deepFreeze({
  id: 'ethereum-morpho-pt-27aug2026-post-expiry-r1',
  version: 1,
  chainId: 1,
  probeAddress: ADDRESSES.morpho,
  pin: { mode: 'finalized', maxAgeSeconds: 3600, futureSkewSeconds: 60 },
  candidatePolicy: { minimum: 3, maximum: 4, evidenceFamilies: 2, separateBoundaryLocator: true, authoritativeOperatorFamilyRequired: true },
  boundary: {
    expiryTimestamp: EXPIRY,
    requireObservable: true,
    operationScope: 'boundary',
    transitions: {
      'apx-pt-is-expired': { pre: false, post: true },
      'apy-pt-is-expired': { pre: false, post: true },
      'apx-yt-is-expired': { pre: false, post: true },
      'apy-yt-is-expired': { pre: false, post: true },
    },
  },
  formula: { secondsPerYear: 31536000, one: '1000000000000000000', baseDiscountPerYear: '200000000000000000' },
  operations: [
    marketCall('morpho-market-apx', MARKETS.apx),
    paramsCall('morpho-params-apx', MARKETS.apx, ADDRESSES.apxPt, ADDRESSES.apxOracle),
    marketCall('morpho-market-apy-discounted', MARKETS.apyDiscounted),
    paramsCall('morpho-params-apy-discounted', MARKETS.apyDiscounted, ADDRESSES.apyPt, ADDRESSES.apyDiscountedOracle),
    marketCall('morpho-market-apy-par', MARKETS.apyPar),
    paramsCall('morpho-params-apy-par', MARKETS.apyPar, ADDRESSES.apyPt, ADDRESSES.apyParOracle),
    priceCall('oracle-price-apx', ADDRESSES.apxOracle),
    priceCall('oracle-price-apy-discounted', ADDRESSES.apyDiscountedOracle),
    priceCall('oracle-price-apy-par', ADDRESSES.apyParOracle),
    roundCall('round-apx-wrapper', ADDRESSES.apxWrapper, 'wrapper'),
    roundCall('round-apy-wrapper', ADDRESSES.apyWrapper, 'wrapper'),
    roundCall('round-apx-inner', ADDRESSES.apxInner, 'inner'),
    roundCall('round-apy-inner', ADDRESSES.apyInner, 'inner'),
    roundCall('round-underlying', ADDRESSES.underlyingFeed, 'underlying'),
    roundCall('round-quote-discounted', ADDRESSES.discountedQuoteFeed, 'discountedQuote'),
    roundCall('round-quote-par', ADDRESSES.parQuoteFeed, 'parQuote'),
    expiryCall('apx-pt-expiry', ADDRESSES.apxPt),
    expiryCall('apy-pt-expiry', ADDRESSES.apyPt),
    expiredCall('apx-pt-is-expired', ADDRESSES.apxPt),
    expiredCall('apy-pt-is-expired', ADDRESSES.apyPt),
    expiredCall('apx-yt-is-expired', ADDRESSES.apxYt),
    expiredCall('apy-yt-is-expired', ADDRESSES.apyYt),
    code('runtime-morpho', 'morpho'),
    code('runtime-apx-oracle', 'apxOracle'),
    code('runtime-apy-discounted-oracle', 'apyDiscountedOracle'),
    code('runtime-apy-par-oracle', 'apyParOracle'),
    code('runtime-apx-wrapper', 'apxWrapper'),
    code('runtime-apy-wrapper', 'apyWrapper'),
    code('runtime-apx-inner', 'apxInner'),
    code('runtime-apy-inner', 'apyInner'),
    code('runtime-apx-pt', 'apxPt'),
    code('runtime-apy-pt', 'apyPt'),
    code('runtime-apx-yt', 'apxYt'),
    code('runtime-apy-yt', 'apyYt'),
  ],
  historicalLineage: {
    gate0CaptureSha256: 'ff98edf6dc14fc16bc3a3a9e9f36c618c543330295ee5175daa18285bed6af4b',
    gate0SourceRuntimeManifestSha256: '5e346c07febe50a72597e4b2c301da876c3984eab44a11f30b3a51d7af6522e0',
    gate0CorrectionManifestSha256: 'f06b54d45af7ad0deff774e5c0436dfe75b76fc78d851c7466aefaeac1e3f7cc',
    boundaryModelV2Sha256: 'cb4840ff41c6392024b5b1293ffc971d88f001cda65a95225adb3012287d52c8',
    boundaryValidationV2Sha256: '9a39e093eb3a1231e25481ff9774a05a7470aabb5afa67ea317d56f3f013d7ac',
    boundaryTestResultV2Sha256: '3bd8a7c96d3e88a57917a17b54dc7712c7950b52fcc4b480d529c38998aaf548',
    boundaryModelStatus: 'OFFLINE_FORMULA_ONLY',
  },
});

const PROFILE_HASH = crypto.createHash('sha256').update(canonical(profile)).digest('hex');

module.exports = { EXPIRY, SELECTORS, ADDRESSES, MARKETS, RUNTIME_BASELINES, PROFILE_HASH, profile, canonical };
