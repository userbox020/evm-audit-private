#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { ethers } = require('C:/Users/MiPC/AppData/Local/Temp/opencode/node_modules/ethers');

const ROOT = path.resolve(__dirname, '..');
const TARGET = path.join(ROOT, 'targets', 'cash-v3');
const OUT_DIR = path.join(ROOT, 'reports', 'raw');
const OUT_FILE = path.join(OUT_DIR, 'etherfi-cash-borrower-scan.json');
const CHAIN_ID = '10';

function arg(name, def) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : def;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function rpcUrl(label) {
  if (process.env.OPTIMISM_RPC) return process.env.OPTIMISM_RPC;
  const lines = fs.readFileSync(path.join(ROOT, 'RPC_URLS.txt'), 'utf8').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].toLowerCase() === label.toLowerCase() && /^https?:\/\//i.test(lines[i + 1])) return lines[i + 1];
  }
  throw new Error(`RPC label not found: ${label}`);
}

function artifact(source, name) {
  return readJson(path.join(TARGET, 'out', source, `${name}.json`)).abi;
}

function bn(value) {
  if (value === undefined || value === null) return value;
  if (ethers.BigNumber.isBigNumber(value)) return value.toString();
  if (Array.isArray(value)) return value.map(bn);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/^\d+$/.test(k)) continue;
      out[k] = bn(v);
    }
    return out;
  }
  return value;
}

function tokenRows(rows) {
  return (rows || []).map((x) => ({ token: x.token || x[0], amount: bn(x.amount ?? x[1]) }));
}

async function optional(label, fn) {
  try {
    return await fn();
  } catch (err) {
    return { error: `${label}: ${String(err.reason || err.message).replace(/https?:\/\/\S+/g, '[RPC]')}` };
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function main() {
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl('optimism'));
  const deployments = readJson(path.join(TARGET, 'deployments', 'mainnet', CHAIN_ID, 'deployments.json')).addresses;
  const abi = artifact('DebtManagerCore.sol', 'DebtManagerCore');
  const iface = new ethers.utils.Interface(abi);
  const debt = new ethers.Contract(deployments.DebtManager, abi, provider);
  const latest = await provider.getBlockNumber();
  const fromBlock = Number(arg('--from-block', Math.max(0, latest - Number(arg('--lookback', '3000000'))).toString()));
  const toBlock = Number(arg('--to-block', latest.toString()));
  const chunk = Math.min(10000, Number(arg('--chunk', '10000')));
  const concurrency = Number(arg('--concurrency', '10'));
  const top = Number(arg('--top', '1000'));

  const eventNames = ['Borrowed', 'Repaid', 'Liquidated'];
  const eventTopics = Object.fromEntries(eventNames.map((name) => [name, iface.getEventTopic(name)]));
  const users = new Map();
  const logCounts = Object.fromEntries(eventNames.map((name) => [name, 0]));

  for (let start = fromBlock; start <= toBlock; start += chunk + 1) {
    const end = Math.min(toBlock, start + chunk);
    for (const name of eventNames) {
      const logs = await provider.getLogs({ address: deployments.DebtManager, topics: [eventTopics[name]], fromBlock: start, toBlock: end });
      logCounts[name] += logs.length;
      for (const log of logs) {
        const parsed = iface.parseLog(log);
        const user = parsed.args.user || parsed.args[0];
        if (!user) continue;
        const key = ethers.utils.getAddress(user);
        const item = users.get(key) || { user: key, lastBlock: 0, events: { Borrowed: 0, Repaid: 0, Liquidated: 0 } };
        item.events[name]++;
        if (log.blockNumber > item.lastBlock) item.lastBlock = log.blockNumber;
        users.set(key, item);
      }
    }
    if ((start - fromBlock) % (chunk * 20 + 20) === 0) console.log(`Scanned blocks ${start}-${end}, users=${users.size}`);
  }

  const byRecent = [...users.values()].sort((a, b) => b.lastBlock - a.lastBlock).slice(0, top);
  let done = 0;
  const positions = await mapLimit(byRecent, concurrency, async (item) => {
    const [state, liquidatable, maxBorrowLtv, maxBorrowLiq, remaining] = await Promise.all([
      optional('state', () => debt.getUserCurrentState(item.user)),
      optional('liquidatable', () => debt.liquidatable(item.user)),
      optional('maxBorrowLtv', () => debt.getMaxBorrowAmount(item.user, true)),
      optional('maxBorrowLiq', () => debt.getMaxBorrowAmount(item.user, false)),
      optional('remaining', () => debt.remainingBorrowingCapacityInUSD(item.user)),
    ]);
    done++;
    if (done % 100 === 0) console.log(`Evaluated ${done}/${byRecent.length}`);
    if (state.error) return { ...item, state };
    const totalCollateralUsd = state.totalCollateralInUsd ?? state[1];
    const totalBorrowingsUsd = state.totalBorrowings ?? state[3];
    const debtUsd = Number(ethers.utils.formatUnits(totalBorrowingsUsd, 6));
    const liqUsd = ethers.BigNumber.isBigNumber(maxBorrowLiq) ? Number(ethers.utils.formatUnits(maxBorrowLiq, 6)) : 0;
    return {
      ...item,
      liquidatable,
      healthFactor: debtUsd > 0 ? liqUsd / debtUsd : null,
      maxBorrowLtv: bn(maxBorrowLtv),
      maxBorrowLiq: bn(maxBorrowLiq),
      remainingBorrowingCapacityInUsd: bn(remaining),
      totalCollateralUsd: bn(totalCollateralUsd),
      totalBorrowingsUsd: bn(totalBorrowingsUsd),
      collaterals: tokenRows(state.totalCollaterals || state[0]),
      borrowings: tokenRows(state.borrowings || state[2]),
    };
  });

  const active = positions.filter((p) => BigInt(p.totalBorrowingsUsd || '0') > 0n).sort((a, b) => Number(BigInt(b.totalBorrowingsUsd) - BigInt(a.totalBorrowingsUsd)));
  const unhealthy = active.filter((p) => p.liquidatable === true || (p.healthFactor !== null && p.healthFactor < 1)).sort((a, b) => (a.healthFactor ?? 99) - (b.healthFactor ?? 99));

  const result = {
    capturedAt: new Date().toISOString(),
    chainId: Number(CHAIN_ID),
    fromBlock,
    toBlock,
    logCounts,
    uniqueUsers: users.size,
    evaluatedUsers: positions.length,
    activeUsers: active.length,
    unhealthy,
    topActive: active.slice(0, 100),
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2));
  console.log(`Logs: ${JSON.stringify(logCounts)} uniqueUsers=${users.size} active=${active.length} unhealthy=${unhealthy.length}`);
  for (const p of unhealthy.slice(0, 20)) {
    console.log(`${p.user} HF=${p.healthFactor?.toFixed(4)} debt=$${(Number(p.totalBorrowingsUsd || 0) / 1e6).toFixed(2)} coll=$${(Number(p.totalCollateralUsd || 0) / 1e6).toFixed(2)} lastBlock=${p.lastBlock}`);
  }
  console.log(`Wrote ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(String(err.stack || err.message).replace(/https?:\/\/\S+/g, '[RPC]'));
  process.exitCode = 1;
});
