#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const { ethers } = require('C:/Users/MiPC/AppData/Local/Temp/opencode/node_modules/ethers');

const ROOT = path.resolve(__dirname, '..');
const LIVE_MAP = path.join(ROOT, 'reports', 'raw', 'etherfi-cash-live-map.json');
const OUT_FILE = path.join(ROOT, 'reports', 'raw', 'etherfi-cash-custom-oracle-probe.json');
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const ZERO = '0x0000000000000000000000000000000000000000';

const oracleAbi = [
  'function getRate() view returns (uint256)',
  'function updatedAt() view returns (uint64)',
  'function paused() view returns (bool)',
  'function roleRegistry() view returns (address)',
  'function ORACLE_UPDATER_ROLE() view returns (bytes32)',
  'function decimals() view returns (uint8)',
];

const roleRegistryAbi = [
  'function roleHolders(bytes32 role) view returns (address[])',
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function rpcUrl(label) {
  if (process.env.OPTIMISM_RPC) return process.env.OPTIMISM_RPC;
  const lines = fs.readFileSync(path.join(ROOT, 'RPC_URLS.txt'), 'utf8')
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].toLowerCase() === label.toLowerCase() && /^https?:\/\//i.test(lines[i + 1])) return lines[i + 1];
  }
  throw new Error(`RPC label not found: ${label}`);
}

function asAddressFromSlot(slot) {
  const v = ethers.BigNumber.from(slot);
  if (v.isZero()) return ZERO;
  return ethers.utils.getAddress(`0x${slot.slice(-40)}`);
}

async function optional(label, fn) {
  try {
    const value = await fn();
    return ethers.BigNumber.isBigNumber(value) ? value.toString() : value;
  } catch (err) {
    return { error: `${label}: ${err.reason || err.message}` };
  }
}

async function main() {
  const live = readJson(LIVE_MAP);
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl('optimism'));
  const block = await provider.getBlock('latest');
  const rows = [];

  for (const token of live.tokens) {
    const cfg = token.priceConfig;
    if (!cfg || cfg.error || cfg.isChainlinkType || !cfg.oracle || cfg.oracle === ZERO) continue;
    const oracle = new ethers.Contract(cfg.oracle, oracleAbi, provider);
    const updatedAt = await optional('updatedAt', () => oracle.updatedAt());
    const ageSec = typeof updatedAt === 'string' ? block.timestamp - Number(updatedAt) : null;

    rows.push({
      tokenSymbol: token.erc20Symbol || token.configuredSymbol,
      token: token.address,
      isCollateral: token.debt && token.debt.isCollateral,
      isBorrow: token.debt && token.debt.isBorrow,
      configuredPrice: token.price,
      oracle: cfg.oracle,
      oracleImpl: asAddressFromSlot(await provider.getStorageAt(cfg.oracle, IMPL_SLOT)),
      rate: await optional('getRate', () => oracle.getRate()),
      decimals: await optional('decimals', () => oracle.decimals()),
      paused: await optional('paused', () => oracle.paused()),
      updatedAt,
      ageSec,
      configuredMaxStaleness: cfg.maxStaleness,
      staleByConfiguredLimit: ageSec === null ? null : ageSec > cfg.maxStaleness,
      priceProviderEnforcesCustomStaleness: false,
      roleRegistry: await optional('roleRegistry', () => oracle.roleRegistry()),
      oracleUpdaterRole: await optional('ORACLE_UPDATER_ROLE', () => oracle.ORACLE_UPDATER_ROLE()),
    });
  }

  const roleHolderCache = {};
  for (const row of rows) {
    if (typeof row.roleRegistry !== 'string' || typeof row.oracleUpdaterRole !== 'string') continue;
    const key = `${row.roleRegistry}:${row.oracleUpdaterRole}`;
    if (roleHolderCache[key]) {
      row.oracleUpdaterRoleHolders = roleHolderCache[key];
      continue;
    }
    const roleRegistry = new ethers.Contract(row.roleRegistry, roleRegistryAbi, provider);
    const holders = await optional('roleHolders', () => roleRegistry.roleHolders(row.oracleUpdaterRole));
    roleHolderCache[key] = holders;
    row.oracleUpdaterRoleHolders = holders;
  }

  const output = {
    capturedAt: new Date().toISOString(),
    blockNumber: block.number,
    blockTimestamp: block.timestamp,
    customOracleCount: rows.length,
    rows,
  };

  fs.writeFileSync(OUT_FILE, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
