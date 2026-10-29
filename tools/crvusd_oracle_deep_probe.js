#!/usr/bin/env node
// Second-pass: deeper oracle + pool probing.
// For "Unknown" oracles: check bytecode for known selectors.
// For CryptoFromPool: get balances per coin, TVL properly, MANIPULATABILITY ASSESSMENT.

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const ROOT = path.resolve(__dirname, '..');
const IN_FILE = path.join(ROOT, 'reports', 'raw', 'crvusd-oracle-probe.json');
const OUT_FILE = path.join(ROOT, 'reports', 'raw', 'crvusd-oracle-deep-probe.json');

function getRpc() {
  const f = path.join(ROOT, 'rpc_endpoints.txt');
  const content = fs.readFileSync(f, 'utf8');
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (/^Ethereum\s/i.test(trimmed) || trimmed === 'Ethereum') {
      const rest = lines[i].replace(/^Ethereum\s*/i, '');
      if (/^https?:\/\//.test(rest)) return rest.trim();
      if (i + 1 < lines.length) {
        const next = lines[i + 1].trim();
        if (/^https?:\/\//.test(next)) return next;
      }
    }
  }
  throw new Error('no ETH RPC found');
}

// Known oracle types and their VYPER selectors
const VYPER_SELECTORS = {
  'CryptoWithStablePrice': ['0x313ce567', '0x4c5407f8'], // price(), tricrypto()
  'EmaPriceOracle':         ['0x313ce567', '0xa035b1fe'], // price(), MA_EXP_TIME()
  'ChainlinkWrapper':       ['0x313ce567'],                // price()
  'CryptoFromPool':         ['0x313ce567', '0x21f8a721'],  // price(), POOL()
  'CryptoWithStablePriceETH': ['0x313ce567', '0xfe8bdefb'],
  'CryptoWithStablePriceWBTC': ['0x313ce567', '0x5021a4d1'], // has CHAINLINK check
};

// Vyper ABI for oracle-specific calls
const DEEP_ORACLE_ABI = [
  // CryptoWithStablePrice
  'function tricrypto() external view returns (address)',
  'function stableswap() external view returns (address)',
  'function stable_aggregator() external view returns (address)',
  'function N_POOLS() external view returns (uint256)',
  'function tricrypto(uint256) external view returns (address)',
  'function stableswap(uint256) external view returns (address)',
  // ChainlinkWrapper
  'function CHAINLINK_STALE_THRESHOLD() external view returns (uint256)',
  'function chainlink_feed() external view returns (address)',
  // EmaPriceOracle
  'function MA_EXP_TIME() external view returns (uint256)',
  'function last_timestamp() external view returns (uint256)',
  'function SIG_ADDRESS() external view returns (address)',
  'function SIG_METHOD() external view returns (bytes)',
  // Common
  'function price() external view returns (uint256)',
  'function price_w() external view returns (uint256)',
  // CryptoFromPool
  'function POOL() external view returns (address)',
  'function COLLATERAL_IX() external view returns (uint256)',
  'function BORROWED_IX() external view returns (uint256)',
  'function NO_ARGUMENT() external view returns (bool)',
];

// Pool-specific for deep TVL
const ADVANCED_POOL_ABI = [
  'function coins(uint256) external view returns (address)',
  'function balances(uint256) external view returns (uint256)',
  'function N_COINS() external view returns (uint256)',
  'function price_oracle() external view returns (uint256)',
  'function price_oracle(uint256) external view returns (uint256)',
  'function get_virtual_price() external view returns (uint256)',
  'function totalSupply() external view returns (uint256)',
  'function get_dy(int128,int128,uint256) external view returns (uint256)',
  'function A() external view returns (uint256)',
  'function fee() external view returns (uint256)',
  'function gamma() external view returns (uint256)',
];

const ERC20_ABI = [
  'function symbol() external view returns (string)',
  'function decimals() external view returns (uint8)',
];

async function tryCall(contract, method, args = []) {
  try {
    return await contract[method](...args);
  } catch (e) {
    return `ERR:${e.reason || e.message || String(e).slice(0, 60)}`;
  }
}

function isErr(v) { return typeof v === 'string' && v.startsWith('ERR:'); }

async function main() {
  const data = JSON.parse(fs.readFileSync(IN_FILE, 'utf8'));
  const rpc = getRpc();
  const provider = new ethers.JsonRpcProvider(rpc);
  console.error(`RPC: ${rpc.slice(0, 50)}...`);

  for (const c of data.controllers) {
    console.error(`\n=== ${c.label} ===`);

    // --- Deep oracle probe ---
    if (!ethers.isAddress(c.oracle_contract)) {
      c.deep = { error: 'No valid oracle contract' };
      continue;
    }

    const oracle = new ethers.Contract(c.oracle_contract, DEEP_ORACLE_ABI, provider);
    const deep = {};

    // Try all known methods
    const methods = [
      'price', 'price_w', 'MA_EXP_TIME', 'last_timestamp',
      'SIG_ADDRESS', 'SIG_METHOD', 'chainlink_feed', 'CHAINLINK_STALE_THRESHOLD',
      'POOL', 'COLLATERAL_IX', 'BORROWED_IX', 'NO_ARGUMENT',
      'tricrypto', 'stableswap', 'stable_aggregator', 'N_POOLS',
    ];

    for (const m of methods) {
      const v = await tryCall(oracle, m).catch(() => 'SKIP');
      if (!isErr(v) && v !== 'SKIP' && v !== undefined) {
        if (typeof v === 'object' && v !== null) {
          deep[m] = v.toString();
        } else if (ethers.isAddress(String(v))) {
          deep[m] = String(v);
        } else if (typeof v === 'bigint') {
          deep[m] = v.toString();
        } else {
          deep[m] = String(v);
        }
      }
    }

    // Try array variant for tricrypto/stableswap
    if (deep.N_POOLS && !isErr(deep.N_POOLS)) {
      const nPools = Number(deep.N_POOLS);
      deep.tricrypto_pools = [];
      deep.stableswap_pools = [];
      for (let i = 0; i < Math.min(nPools, 10); i++) {
        const t = await tryCall(oracle, 'tricrypto', [i]);
        const s = await tryCall(oracle, 'stableswap', [i]);
        if (!isErr(t) && ethers.isAddress(String(t))) deep.tricrypto_pools.push(String(t));
        if (!isErr(s) && ethers.isAddress(String(s))) deep.stableswap_pools.push(String(s));
      }
    }

    // Classify oracle
    if (deep.POOL && !isErr(deep.POOL)) {
      c.oracle_type = 'CryptoFromPool';
    } else if (deep.N_POOLS !== undefined && !isErr(String(deep.N_POOLS)) && Number(deep.N_POOLS) > 0) {
      c.oracle_type = 'CryptoWithStablePrice' + (Number(deep.N_POOLS) > 1 ? '' : '');
    } else if (deep.MA_EXP_TIME !== undefined && !isErr(String(deep.MA_EXP_TIME))) {
      c.oracle_type = 'EmaPriceOracle';
    } else if (deep.chainlink_feed !== undefined && !isErr(String(deep.chainlink_feed))) {
      c.oracle_type = 'ChainlinkWrapper';
    } else if (deep.price && !isErr(String(deep.price))) {
      c.oracle_type = 'PriceOnly'; // Minimal oracle, just price()
    }

    c.deep = deep;
    console.error(`  oracle_type: ${c.oracle_type}`);

    // --- Deep pool probe (for CryptoFromPool and CryptoWithStablePrice) ---
    const poolAddresses = [];
    if (deep.POOL && !isErr(deep.POOL)) poolAddresses.push(String(deep.POOL));
    if (deep.tricrypto_pools) poolAddresses.push(...deep.tricrypto_pools);
    if (deep.stableswap_pools) poolAddresses.push(...deep.stableswap_pools);

    if (poolAddresses.length > 0) {
      c.deep_pools = [];
      for (const poolAddr of poolAddresses) {
        if (!ethers.isAddress(poolAddr)) continue;
        const pool = new ethers.Contract(poolAddr, ADVANCED_POOL_ABI, provider);
        const pinfo = { address: poolAddr };

        // Get N_COINS
        const nCoinsV = await tryCall(pool, 'N_COINS');
        const nCoins = !isErr(nCoinsV) ? Number(nCoinsV) : 2;
        pinfo.n_coins = nCoins;

        // Get coins and balances
        pinfo.coins = [];
        pinfo.balances_raw = [];
        for (let i = 0; i < nCoins; i++) {
          const coinAddr = await tryCall(pool, 'coins', [i]);
          const bal = await tryCall(pool, 'balances', [i]);
          if (!isErr(coinAddr) && ethers.isAddress(String(coinAddr))) {
            const tok = new ethers.Contract(String(coinAddr), ERC20_ABI, provider);
            const [sym, dec] = await Promise.all([
              tryCall(tok, 'symbol').catch(() => '?'),
              tryCall(tok, 'decimals').catch(() => 18),
            ]);
            const symbol = isErr(sym) ? '?' : String(sym);
            const decimals = isErr(dec) ? 18 : Number(dec);
            const balVal = isErr(bal) ? 0n : BigInt(String(bal));
            pinfo.coins.push({
              index: i,
              address: String(coinAddr),
              symbol,
              decimals,
              balance_raw: bal.toString(),
              balance_human: Number(ethers.formatUnits(balVal, decimals)).toFixed(2),
            });
          }
        }

        // Get virtual_price for TVL
        const vp = await tryCall(pool, 'get_virtual_price');
        const ts = await tryCall(pool, 'totalSupply');
        if (!isErr(vp) && !isErr(ts)) {
          const vpVal = Number(ethers.formatEther(BigInt(String(vp))));
          const tsVal = Number(ethers.formatEther(BigInt(String(ts))));
          pinfo.tvl_approx = vpVal * tsVal;
        }

        // Get pool price_oracle
        const po = await tryCall(pool, 'price_oracle');
        if (!isErr(po)) pinfo.price_oracle = ethers.formatEther(BigInt(String(po)));

        // Get A, fee, gamma (manipulation cost indicators)
        for (const mp of ['A', 'fee', 'gamma']) {
          const v = await tryCall(pool, mp);
          if (!isErr(v)) pinfo[mp] = String(v);
        }

        c.deep_pools.push(pinfo);
        console.error(`  pool ${poolAddr.slice(0, 10)}... coins=${pinfo.coins.map(co => co.symbol).join('/')} TVL≈${pinfo.tvl_approx?.toLocaleString() || '?'}`);
      }
    }
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(data, null, 2));
  console.error(`\nWrote ${OUT_FILE}`);

  // ── FINAL ANALYSIS ──
  console.log('\n═════════════════════════════════════════════════════');
  console.log('  crvUSD DEEP ORACLE ANALYSIS');
  console.log('═════════════════════════════════════════════════════\n');

  for (const c of data.controllers) {
    const pools = c.deep_pools || [];
    const poolTvl = pools.length > 0 ? pools.reduce((s, p) => s + (p.tvl_approx || 0), 0) : null;
    const isManipulable = poolTvl !== null && poolTvl < 1_000_000; // <$1M pool
    const isStaleFeasible = c.oracle_type === 'ChainlinkWrapper' && c.chainlink_feed_stale;

    console.log(`${c.label.padEnd(12)} oracle=${c.oracle_type?.padEnd(30) || '?'} | pools=${pools.length} TVL≈$${poolTvl?.toLocaleString() || '?'} | debt=$${Number(c.controller_total_debt).toLocaleString()}/${Number(c.controller_debt_ceiling).toLocaleString()}`);
    if (pools.length > 0) {
      for (const p of pools) {
        const coinStr = p.coins?.map(c => `${c.symbol}(${c.balance_human})`).join('/') || '?';
        console.log(`  ↳ pool: TVL≈$${(p.tvl_approx || 0).toLocaleString()} | coins: ${coinStr}`);
      }
    }
    if (c.chainlink_feed_stale) console.log(`  ↳ ⚠️ STALE FEED: age=${c.chainlink_feed_age_seconds}s`);
    if (isManipulable) console.log(`  ↳ ⚠️ LOW TVL POOL — MANIPULABLE via flash loan`);
  }

  const viable = data.controllers.filter(c => {
    const pools = c.deep_pools || [];
    const poolTvl = pools.length > 0 ? pools.reduce((s, p) => s + (p.tvl_approx || 0), 0) : null;
    return poolTvl !== null && poolTvl < 1_000_000;
  });
  const staleViable = data.controllers.filter(c => c.chainlink_feed_stale);

  console.log(`\n📍 VIABLE TARGETS:
  Low-TVL pool (<$1M): ${viable.length}  (${viable.map(c => c.label).join(', ') || 'none'})
  Stale Chainlink: ${staleViable.length}  (${staleViable.map(c => c.label).join(', ') || 'none'})
  Total exploitable: ${viable.length + staleViable.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
