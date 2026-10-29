#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');

function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function deepFreeze(value) { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; }

const PROFILE = deepFreeze({
  schema: 'ostium-current-authority-bootstrap-r1-profile/v1', id: 'ostium-current-authority-bootstrap-r1', version: 1,
  productionEnabled: false, chainId: 42161, pin: { mode: 'finalized', maxAgeSeconds: 3600, futureSkewSeconds: 60 },
  locator: { sourceIdSlot: 'OFFICIAL_LOCATOR_SOURCE_ID', contentHashSlot: 'OFFICIAL_LOCATOR_CONTENT_SHA256', commitSlot: 'OFFICIAL_LOCATOR_COMMIT' },
  commitments: {
    rootSet: 'ostium-current-bootstrap-root-set-commitment/v1',
    locatorSource: 'ostium-current-bootstrap-locator-source-commitment/v1',
    observation: 'ostium-current-bootstrap-observation-commitment/v1',
  },
  rootRoles: ['VAULT_PROXY', 'REGISTRY', 'OPEN_PNL_PROXY', 'ASSET'],
  slots: {
    implementation: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
    admin: '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103',
    beacon: '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50',
  },
  selectors: { registry: '0x7b103999', asset: '0x38d52e0f', lastSettlementId: '0x39598fae', getContractAddress: '0x0d2020dd', decimals: '0x313ce567' },
  registryKeys: {
    vault: '0x7661756c74000000000000000000000000000000000000000000000000000000',
    openPnl: '0x6f70656e506e6c00000000000000000000000000000000000000000000000000',
  },
  qualification: [
    { id: 1, method: 'eth_chainId' }, { id: 2, method: 'eth_getBlockByNumber', kind: 'finalized' },
    { id: 3, method: 'eth_getBlockByNumber', kind: 'numericReread' }, { id: 4, method: 'eth_call', kind: 'multicallBlockNumber' },
    { id: 5, method: 'eth_getCode', role: 'VAULT_PROXY' }, { id: 6, method: 'eth_getStorageAt', role: 'VAULT_PROXY', slot: 'implementation' },
    { id: 7, method: 'eth_call', role: 'VAULT_PROXY', selector: 'lastSettlementId' },
  ],
  operations: [
    { id: 1, kind: 'ROOT_CODE', role: 'VAULT_PROXY' }, { id: 2, kind: 'ROOT_CODE', role: 'REGISTRY' },
    { id: 3, kind: 'ROOT_CODE', role: 'OPEN_PNL_PROXY' }, { id: 4, kind: 'ROOT_CODE', role: 'ASSET' },
    { id: 5, kind: 'PROXY_SLOT', role: 'VAULT_PROXY', slot: 'implementation' }, { id: 6, kind: 'PROXY_SLOT', role: 'VAULT_PROXY', slot: 'admin' },
    { id: 7, kind: 'PROXY_SLOT', role: 'VAULT_PROXY', slot: 'beacon' }, { id: 8, kind: 'PROXY_SLOT', role: 'OPEN_PNL_PROXY', slot: 'implementation' },
    { id: 9, kind: 'PROXY_SLOT', role: 'OPEN_PNL_PROXY', slot: 'admin' }, { id: 10, kind: 'PROXY_SLOT', role: 'OPEN_PNL_PROXY', slot: 'beacon' },
    { id: 11, kind: 'POINTER_CODE', source: 5 }, { id: 12, kind: 'POINTER_CODE', source: 6 }, { id: 13, kind: 'POINTER_CODE', source: 7 },
    { id: 14, kind: 'POINTER_CODE', source: 8 }, { id: 15, kind: 'POINTER_CODE', source: 9 }, { id: 16, kind: 'POINTER_CODE', source: 10 },
    { id: 17, kind: 'REGISTRY_LINK', key: 'vault' }, { id: 18, kind: 'REGISTRY_LINK', key: 'openPnl' },
    { id: 19, kind: 'ROOT_LINK', role: 'VAULT_PROXY', selector: 'registry' }, { id: 20, kind: 'ROOT_LINK', role: 'VAULT_PROXY', selector: 'asset' },
    { id: 21, kind: 'ROOT_LINK', role: 'OPEN_PNL_PROXY', selector: 'registry' }, { id: 22, kind: 'DECIMALS', role: 'ASSET' },
  ],
  roundsPerFamily: 2, selectedFamilies: 2, expectedAssetDecimals: 6,
});
const PROFILE_HASH = crypto.createHash('sha256').update(canonical(PROFILE)).digest('hex');

module.exports = { PROFILE, PROFILE_HASH, canonical, deepFreeze };
