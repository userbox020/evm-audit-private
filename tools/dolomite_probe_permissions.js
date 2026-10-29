#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const { ethers } = require('C:/Users/MiPC/AppData/Local/Temp/opencode/node_modules/ethers');

const ROOT = path.resolve(__dirname, '..');
const MAP_FILE = path.join(ROOT, 'reports', 'raw', 'dolomite-berachain-live-map.json');
const OUT_FILE = path.join(ROOT, 'reports', 'raw', 'dolomite-berachain-permissions.json');
const CHAIN_ID = 80094;
const ZERO = '0x0000000000000000000000000000000000000000';

const coreAbi = [
  'function getIsGlobalOperator(address operator) view returns (bool)',
  'function getIsAutoTraderSpecial(address autoTrader) view returns (bool)',
];
const authAbi = [
  'function isCallerAuthorized(address caller) view returns (bool)',
];
const registryAbi = [
  'function isTrustedInternalTrader(address trader) view returns (bool)',
];

function rpcCandidates() {
  const candidates = [];
  for (const key of ['BERACHAIN_RPC', 'BERACHAIN_RPC_URL']) {
    if (process.env[key]) candidates.push(process.env[key]);
  }
  const rpcFile = path.join(ROOT, 'RPC_URLS.txt');
  if (fs.existsSync(rpcFile)) {
    const lines = fs.readFileSync(rpcFile, 'utf8').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    const labels = new Set(['berachain', 'bera', 'bera chain', 'berachain mainnet', '80094']);
    for (let i = 0; i < lines.length - 1; i++) {
      if (labels.has(lines[i].toLowerCase()) && /^https?:\/\//i.test(lines[i + 1])) candidates.push(lines[i + 1]);
    }
  }
  candidates.push('https://rpc.berachain.com');
  candidates.push('https://berachain-rpc.publicnode.com');
  return [...new Set(candidates)];
}

async function connectProvider() {
  let lastError;
  for (const url of rpcCandidates()) {
    try {
      const provider = new ethers.providers.JsonRpcProvider(url, { chainId: CHAIN_ID, name: 'berachain' });
      const network = await provider.getNetwork();
      if (Number(network.chainId) !== CHAIN_ID) throw new Error(`unexpected chain ${network.chainId}`);
      await provider.getBlockNumber();
      return provider;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`No working Berachain RPC candidate (${lastError ? lastError.message : 'unknown error'})`);
}

async function optional(label, fn) {
  try {
    return await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout`)), 10_000)),
    ]);
  } catch (err) {
    return { error: `${label}: ${err.reason || err.message}` };
  }
}

function addCandidate(candidates, label, address) {
  if (!address || address === ZERO || !ethers.utils.isAddress(address)) return;
  const checksum = ethers.utils.getAddress(address);
  if (!candidates[checksum]) candidates[checksum] = { address: checksum, labels: [] };
  candidates[checksum].labels.push(label);
}

async function main() {
  const map = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'));
  const provider = await connectProvider();
  const core = new ethers.Contract(map.addresses.DolomiteMargin, coreAbi, provider);
  const registry = new ethers.Contract(map.addresses.DolomiteRegistryProxy, registryAbi, provider);
  const genericTrader = new ethers.Contract(map.registry.genericTraderProxy, authAbi, provider);

  const candidates = {};
  addCandidate(candidates, 'docs.BorrowPositionRouter', map.addresses.BorrowPositionRouter);
  addCandidate(candidates, 'docs.DepositWithdrawalRouter', map.addresses.DepositWithdrawalRouter);
  addCandidate(candidates, 'docs.GenericTraderRouter', map.addresses.GenericTraderRouter);
  addCandidate(candidates, 'docs.LiquidatorProxyV5', map.addresses.LiquidatorProxyV5);
  addCandidate(candidates, 'registry.borrowPositionProxy', map.registry.borrowPositionProxy);
  addCandidate(candidates, 'registry.depositWithdrawalRouter', map.registry.depositWithdrawalRouter);
  addCandidate(candidates, 'registry.genericTraderProxy', map.registry.genericTraderProxy);
  addCandidate(candidates, 'registry.liquidatorAssetRegistry', map.registry.liquidatorAssetRegistry);
  addCandidate(candidates, 'rewards.polLiquidator', map.rewards && map.rewards.polLiquidator);
  addCandidate(candidates, 'rewards.polLiquidatorProxy', map.rewards && map.rewards.polLiquidatorProxy);
  addCandidate(candidates, 'rewards.polUnwrapperTrader', map.rewards && map.rewards.polUnwrapperTrader);
  addCandidate(candidates, 'rewards.polWrapperTrader', map.rewards && map.rewards.polWrapperTrader);
  addCandidate(candidates, 'rewards.iBgtIsolationModeVaultFactory', map.rewards && map.rewards.iBgtIsolationModeVaultFactory);

  const block = await provider.getBlock('latest');
  const rows = [];
  for (const item of Object.values(candidates)) {
    rows.push({
      ...item,
      isGlobalOperator: await optional('getIsGlobalOperator', () => core.getIsGlobalOperator(item.address)),
      isSpecialAutoTrader: await optional('getIsAutoTraderSpecial', () => core.getIsAutoTraderSpecial(item.address)),
      isGenericTraderCallerAuthorized: await optional('isCallerAuthorized', () => genericTrader.isCallerAuthorized(item.address)),
      isTrustedInternalTrader: await optional('isTrustedInternalTrader', () => registry.isTrustedInternalTrader(item.address)),
    });
  }

  fs.writeFileSync(OUT_FILE, `${JSON.stringify({ generatedAt: new Date().toISOString(), chainId: CHAIN_ID, block, rows }, null, 2)}\n`);
  console.log(`wrote ${path.relative(ROOT, OUT_FILE)} with ${rows.length} candidates`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
