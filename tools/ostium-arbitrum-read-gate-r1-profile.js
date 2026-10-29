#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');

const canonical = (value) => {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
};
const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
};
const key = (value) => `0x${Buffer.from(value, 'utf8').toString('hex').padEnd(64, '0')}`;

const PROFILE = deepFreeze({
  schema: 'ostium-arbitrum-read-gate-r1-profile/v1',
  id: 'ostium-arbitrum-read-gate-r1',
  version: 1,
  productionEnabled: false,
  chainId: 42161,
  pin: { mode: 'finalized', maxAgeSeconds: 3600, futureSkewSeconds: 60 },
  slots: {
    implementation: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
    admin: '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103',
    beacon: '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50',
  },
  selectors: {
    registry: '0x7b103999',
    asset: '0x38d52e0f',
    lastSettlementId: '0x39598fae',
    lastSettlementTs: '0x5ae45c26',
    lastSettlementOpenPnl: '0xaa8c9b6a',
    getContractAddress: '0x0d2020dd',
    getOpenPnlWithRollover: '0x807949e9',
    decimals: '0x313ce567',
  },
  registryKeys: { vault: key('vault'), openPnl: key('openPnl') },
  runtimes: {
    VAULT_IMPLEMENTATION_AT_PIN: { length: 19458, keccak256: '0x1bd515c60cb848674f139d52bce3e9b8790f16751629369d3a7662c3e9f6bf1f' },
    REGISTRY: { length: 3175, keccak256: '0x57eecf2cb6dd034155b67edbbe8d6ed1c7c2b75ca2d3b6f184e8245177b51fe9' },
    OPEN_PNL_IMPLEMENTATION_AT_PIN: { length: 4381, keccak256: '0xfbfabb38b4c57a1fa633e307dfc432ed48943007b1882050d58af53d73e6e8a0' },
  },
  authority: {
    productionProxyRuntimeAuthority: 'ABSENT_P0',
    VAULT_IMPLEMENTATION_AT_PIN: 'R3_BEHAVIORAL_AND_BUILD',
    REGISTRY: 'BUILD_CLOSURE_ONLY',
    OPEN_PNL_IMPLEMENTATION_AT_PIN: 'BUILD_CLOSURE_ONLY',
  },
  localModel: {
    repository: { commit: '8390ce497f68fb128900840e0ec30683afa945d3', tree: 'aa149b0ed98e742a9de21aeb1c8d9ebf305d2612' },
    compiler: { version: '0.8.24', longVersion: '0.8.24+commit.e11b9ed9', executableSha256: '580ee56b61bbcaad953117e1e4a0874d90e6af5cb4ce4359571d7da25f6620e9', optimizerEnabled: true, optimizerRuns: 200, viaIR: true, evmVersion: 'paris' },
    buildInfo: { path: 'targets/ostium/artifacts/build-info/e2a08f99c05f7268422dd3a2bdac7ed1.json', sha256: '8a1e8ada63299b9d215d97f9ecaf570d048e67618b2f252f1e7e95b20468bdd9' },
    artifacts: {
      VAULT_IMPLEMENTATION_AT_PIN: { path: 'targets/ostium/artifacts/src/OstiumVault.sol/OstiumVault.json', sha256: 'f23b615df68d00c7435f1ecd4fe179e706bf30286c21ca02759ab29c98fa3948' },
      REGISTRY: { path: 'targets/ostium/artifacts/src/OstiumRegistry.sol/OstiumRegistry.json', sha256: 'b551e481c390ccc508f509c4fc366c18cb7c60f25a3e9a5e0785df5a5a0c08b8' },
      OPEN_PNL_IMPLEMENTATION_AT_PIN: { path: 'targets/ostium/artifacts/src/OstiumOpenPnl.sol/OstiumOpenPnl.json', sha256: '215dc1f4311d888f4eebcc75e4114265055b87a17d7ec78e464b423dd8b8d65f' },
    },
    sources: {
      'src/OstiumVault.sol': '9aefa6ed131cdaf6360c5330980b5e04a36f345b499aa26d79cdebb0da2d1805',
      'src/interfaces/IOstiumVault.sol': '5eec4cb334f8c78837afbd539abf60309adc896abf246c2cbdf4cf35b32cf3d0',
      'src/OstiumRegistry.sol': 'd9502b0fbec84f84170da544d1661dca558aeed7d255105fe5ee1e63bd5f7270',
      'src/interfaces/IOstiumRegistry.sol': '0ce2452ebef81f2cc35c8c317cbe49c6712709a72990217675e808a6dba33a76',
      'src/OstiumOpenPnl.sol': '5f70c63f31b9fa065f42e4149ed57920a937bf4ddf1d4952eec174b3884ff850',
      'src/interfaces/IOstiumOpenPnl.sol': '937cd8437e6f4508e399ff59425d76711f62af40fec3cac42ffdba367a1fa34e',
    },
    astTripwires: ['OstiumVault', 'tryNewSettlement', '_getOpenPnlDelta', '_executeAsyncDepositWithdraw', '_applyMMCashflow', 'mmDeposit', 'mmWithdraw'],
  },
  roles: ['VAULT_PROXY', 'VAULT_IMPLEMENTATION_AT_PIN', 'REGISTRY', 'OPEN_PNL_PROXY', 'OPEN_PNL_IMPLEMENTATION_AT_PIN', 'ASSET'],
  operations: [
    { id: 1, role: 'VAULT_PROXY', method: 'eth_getCode', result: 'proxyCode' },
    { id: 2, role: 'VAULT_PROXY', method: 'eth_getStorageAt', slot: 'implementation', result: 'roleAddress:VAULT_IMPLEMENTATION_AT_PIN' },
    { id: 3, role: 'VAULT_PROXY', method: 'eth_getStorageAt', slot: 'admin', result: 'proxyAdmin' },
    { id: 4, role: 'VAULT_PROXY', method: 'eth_getStorageAt', slot: 'beacon', result: 'zeroWord' },
    { id: 5, role: 'VAULT_IMPLEMENTATION_AT_PIN', method: 'eth_getCode', result: 'runtime:VAULT_IMPLEMENTATION_AT_PIN' },
    { id: 6, role: 'VAULT_PROXY', method: 'eth_call', selector: 'registry', result: 'roleAddress:REGISTRY' },
    { id: 7, role: 'VAULT_PROXY', method: 'eth_call', selector: 'asset', result: 'roleAddress:ASSET' },
    { id: 8, role: 'VAULT_PROXY', method: 'eth_call', selector: 'lastSettlementId', result: 'uint32:lastSettlementId' },
    { id: 9, role: 'VAULT_PROXY', method: 'eth_call', selector: 'lastSettlementTs', result: 'uint32:lastSettlementTs' },
    { id: 10, role: 'VAULT_PROXY', method: 'eth_call', selector: 'lastSettlementOpenPnl', result: 'int256:lastSettlementOpenPnl' },
    { id: 11, role: 'REGISTRY', method: 'eth_getCode', result: 'runtime:REGISTRY' },
    { id: 12, role: 'REGISTRY', method: 'eth_call', selector: 'getContractAddress', key: 'vault', result: 'roleAddress:VAULT_PROXY' },
    { id: 13, role: 'REGISTRY', method: 'eth_call', selector: 'getContractAddress', key: 'openPnl', result: 'roleAddress:OPEN_PNL_PROXY' },
    { id: 14, role: 'OPEN_PNL_PROXY', method: 'eth_getCode', result: 'proxyCode' },
    { id: 15, role: 'OPEN_PNL_PROXY', method: 'eth_getStorageAt', slot: 'implementation', result: 'roleAddress:OPEN_PNL_IMPLEMENTATION_AT_PIN' },
    { id: 16, role: 'OPEN_PNL_PROXY', method: 'eth_getStorageAt', slot: 'admin', result: 'proxyAdmin' },
    { id: 17, role: 'OPEN_PNL_PROXY', method: 'eth_getStorageAt', slot: 'beacon', result: 'zeroWord' },
    { id: 18, role: 'OPEN_PNL_IMPLEMENTATION_AT_PIN', method: 'eth_getCode', result: 'runtime:OPEN_PNL_IMPLEMENTATION_AT_PIN' },
    { id: 19, role: 'OPEN_PNL_PROXY', method: 'eth_call', selector: 'registry', result: 'roleAddress:REGISTRY' },
    { id: 20, role: 'OPEN_PNL_PROXY', method: 'eth_call', selector: 'getOpenPnlWithRollover', result: 'int256:openPnlWithRollover' },
    { id: 21, role: 'ASSET', method: 'eth_call', selector: 'decimals', result: 'uint8Exact:6' },
  ],
});

const PROFILE_HASH = crypto.createHash('sha256').update(canonical(PROFILE)).digest('hex');

module.exports = { PROFILE, PROFILE_HASH, canonical, deepFreeze };
