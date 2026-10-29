#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');

const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const EXPIRY = 1787788800;
const word = (value) => BigInt(value).toString(16).padStart(64, '0');
const canonical = (value) => {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
};
const deepFreeze = (value) => { if (value && typeof value === 'object') { for (const item of Object.values(value)) deepFreeze(item); Object.freeze(value); } return value; };
const call = (id, address, data, result) => ({ id, kind: 'call', address: address.toLowerCase(), data: data.toLowerCase(), result });

const ethereum = deepFreeze({
  id: 'ethereum-morpho-apyusd-pt-boundary',
  version: 1,
  chainId: 1,
  probeAddress: '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb',
  pin: { mode: 'finalized', maxAgeSeconds: 3600, futureSkewSeconds: 60 },
  boundary: {
    expiryTimestamp: EXPIRY,
    operations: ['morpho-market-apyusd-discounted', 'morpho-oracle-price-discounted', 'morpho-oracle-price-par', 'pt-expiry', 'pt-is-expired'],
    transitions: { 'pt-is-expired': { pre: false, post: true } },
  },
  operations: [
    { id: 'morpho-runtime', kind: 'code', address: '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb', result: { type: 'nonemptyCode' } },
    call('morpho-market-apyusd-discounted', '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb', `0x50d8db4e${'62878115c6ee109c256237eb6daef589d006258202682d2e210cad3bb19e0f09'}`, { type: 'tupleWords', words: 6 }),
    call('morpho-oracle-price-discounted', '0x2c0a8c81d61529bc08e0a4f780d098c8595c9158', '0xa035b1fe', { type: 'positiveUint256' }),
    call('morpho-oracle-price-par', '0x60c98189f7c21540d4a3b8aeade5d5d0aac82aa0', '0xa035b1fe', { type: 'positiveUint256' }),
    call('pt-expiry', '0xee5c7cda577484b70b65c21235ecbd302bb290e2', '0xe184c9be', { type: 'uint256Exact', value: EXPIRY }),
    call('pt-is-expired', '0xee5c7cda577484b70b65c21235ecbd302bb290e2', '0x2f13b60c', { type: 'bool' }),
    call('apyusd-asset', '0x38eeb52f0771140d10c4e9a9a72349a329fe8a6a', '0x38d52e0f', { type: 'expectedAddress', value: '0x98a878b1cd98131b271883b390f68d2c90674665' }),
    call('receipt-paused', '0x9bf51f33955ec70f87c4b5c49441815589043237', '0x5c975abb', { type: 'bool' }),
    call('curve-get-dy-int128', '0xe41be7b340f7c2eda4da1e99b42ee1b228b526b7', `0x5e0d443f${word(1)}${word(0)}${word(10n ** 18n)}`, { type: 'positiveUint256' }),
    { id: 'apyusd-runtime', kind: 'code', address: '0x38eeb52f0771140d10c4e9a9a72349a329fe8a6a', result: { type: 'nonemptyCode' } },
    { id: 'receipt-runtime', kind: 'code', address: '0x9bf51f33955ec70f87c4b5c49441815589043237', result: { type: 'nonemptyCode' } },
  ],
  runtimeEquality: { mode: 'cross-family-exact', operations: ['morpho-runtime', 'apyusd-runtime', 'receipt-runtime'] },
});

const PROFILE_HASH = crypto.createHash('sha256').update(canonical(ethereum)).digest('hex');
const PROFILES = deepFreeze({ [ethereum.id]: ethereum });
const DEFERRED_PHASE2 = deepFreeze({ arbitrumOstium: { enabled: false, chainId: 42161, historicalPin: 491203233,
  reason: 'DEFERRED_PHASE2_NOT_CAPTURABLE_OR_VALIDATABLE' } });

function getProfile(id) {
  if (!Object.prototype.hasOwnProperty.call(PROFILES, id)) { const error = new Error('PROFILE_NOT_FOUND'); error.code = 'PROFILE_NOT_FOUND'; throw error; }
  return PROFILES[id];
}

module.exports = { IMPLEMENTATION_SLOT, EXPIRY, PROFILE_HASH, ethereum, PROFILES, DEFERRED_PHASE2, getProfile };
