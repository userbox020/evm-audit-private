#!/usr/bin/env node
// Queries all 8 crvUSD controllers on Ethereum to identify exploitable oracle surfaces.
//   ChainlinkWrapper? → check feed staleness (24h stale threshold = E1/E8 pattern)
//   EmaPriceOracle? → check MA_EXP_TIME (short = pool-manipulable)
//   CryptoFromPool? → check pool TVL + price()

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'reports', 'raw', 'crvusd-oracle-probe.json');

// ── RPC ──
function getRpc() {
  const f = path.join(ROOT, 'rpc_endpoints.txt');
  if (!fs.existsSync(f)) throw new Error('rpc_endpoints.txt not found');
  const content = fs.readFileSync(f, 'utf8');
  const lines = content.split(/\r?\n/);
  // Find line with "Ethereum" label, next line is URL
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (/^Ethereum\s/i.test(trimmed) || trimmed === 'Ethereum') {
      // Check if URL is on same line or next line
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

// ── 8 Controllers (from scripts/foundry-deploy-mpol4.s.sol) ──
const CONTROLLERS = [
  { label: 'wstETH',  addr: '0x100dAa78fC509Db39Ef7D04DE0c1ABD299f4C6CE' },
  { label: 'WBTC',    addr: '0x4e59541306910aD6dC1daC0AC9dFB29bD9F15c67' },
  { label: 'WETH',    addr: '0xA920De414eA4Ab66b97dA1bFE9e6EcA7d4219635' },
  { label: 'sfrxETH2',addr: '0xEC0820EfafC41D8943EE8dE495fC9Ba8495B15cf' },
  { label: 'tBTC',    addr: '0x1C91da0223c763d2e0173243eAdaA0A2ea47E704' },
  { label: 'weETH',   addr: '0x652aEa6B22310C89DCc506710CaD24d2Dba56B11' },
  { label: 'cbBTC',   addr: '0xf8C786b1064889fFd3c8A08B48D5e0c159F4cBe3' },
  { label: 'LBTC',    addr: '0x8aca5A776a878Ea1F8967e70a23b8563008f58Ef' },
];

// ── Oracle contract interfaces (minimal) ──
const CONTROLLER_ABI = [
  'function amm() external view returns (address)',
  'function collateral_token() external view returns (address)',
  'function borrowed_token() external view returns (address)',
  'function debt_ceiling() external view returns (uint256)',
  'function total_debt() external view returns (uint256)',
];

const AMM_ABI = [
  'function price_oracle_contract() external view returns (address)',
  'function price_oracle() external view returns (uint256)',
  'function get_p() external view returns (uint256)',
  'function admin_fees_x() external view returns (uint256)',
  'function admin_fees_y() external view returns (uint256)',
  'function totalSupply() external view returns (uint256)',
];

const CHAINLINK_WRAPPER_ABI = [
  'function price() external view returns (uint256)',
  'function price_w() external view returns (uint256)',
];

const EMA_ORACLE_ABI = [
  'function price() external view returns (uint256)',
  'function MA_EXP_TIME() external view returns (uint256)',
  'function last_timestamp() external view returns (uint256)',
  'function last_price() external view returns (uint256)',
];

const CHAINLINK_FEED_ABI = [
  'function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() external view returns (uint8)',
  'function description() external view returns (string)',
];

const CRYPTO_FROM_POOL_ABI = [
  'function price() external view returns (uint256)',
  'function POOL() external view returns (address)',
];

const POOL_ABI = [
  'function price_oracle() external view returns (uint256)',
  'function balances(uint256) external view returns (uint256)',
  'function get_virtual_price() external view returns (uint256)',
  'function totalSupply() external view returns (uint256)',
];

async function tryCall(contract, method, args = []) {
  try {
    return await contract[method](...args);
  } catch (e) {
    return `ERROR: ${e.reason || e.message || String(e).slice(0, 80)}`;
  }
}

async function main() {
  if (process.argv.includes('--from-existing')) {
    const existing = OUT;
    if (fs.existsSync(existing)) {
      console.log(`Re-analyzing existing data from ${existing}...`);
      const data = JSON.parse(fs.readFileSync(existing, 'utf8'));
      analyzeResults(data);
      return;
    }
  }

  const rpc = getRpc();
  console.error(`Using RPC: ${rpc.slice(0, 50)}...`);
  const provider = new ethers.JsonRpcProvider(rpc);

  const ethAbi = ['function decimals() view returns (uint8)', 'function symbol() view returns (string)', 'function balanceOf(address) view returns (uint256)'];
  const chainlinkOracleAbi = ['function aggregator() view returns (address)', 'function latestAnswer() view returns (int256)'];

  const results = [];
  const now = Math.floor(Date.now() / 1000);

  for (const c of CONTROLLERS) {
    const entry = { 
      label: c.label, 
      controller: c.addr,
      controller_debt_ceiling: null,
      controller_total_debt: null,
      amm: null,
      collateral_token: null,
      borrowed_token: null,
      oracle_contract: null,
      oracle_type: null,
      chainlink_feed: null,
      chainlink_feed_desc: null,
      chainlink_feed_updatedAt: null,
      chainlink_feed_age_seconds: null,
      chainlink_feed_stale: null,
      ema_ma_exp_time: null,
      ema_last_timestamp: null,
      ema_last_price: null,
      pool_address: null,
      pool_liquidity_usd: null,
      pool_tvl_usd: null,
      oracle_price: null,
    };

    try {
      const ctrl = new ethers.Contract(c.addr, CONTROLLER_ABI, provider);

      const [amm, coll, borrowed, ceiling, debt] = await Promise.all([
        tryCall(ctrl, 'amm'),
        tryCall(ctrl, 'collateral_token'),
        tryCall(ctrl, 'borrowed_token'),
        tryCall(ctrl, 'debt_ceiling'),
        tryCall(ctrl, 'total_debt'),
      ]);

      entry.amm = typeof amm === 'string' && ethers.isAddress(amm) ? amm : String(amm);
      entry.collateral_token = typeof coll === 'string' && ethers.isAddress(coll) ? coll : String(coll);
      entry.borrowed_token = typeof borrowed === 'string' && ethers.isAddress(borrowed) ? borrowed : String(borrowed);
      entry.controller_debt_ceiling = ethers.formatEther(typeof ceiling === 'bigint' ? ceiling : 0n);
      entry.controller_total_debt = ethers.formatEther(typeof debt === 'bigint' ? debt : 0n);

      // Query AMM for oracle
      if (ethers.isAddress(entry.amm)) {
        const ammContract = new ethers.Contract(entry.amm, AMM_ABI, provider);
        const oracleAddr = await tryCall(ammContract, 'price_oracle_contract');
        const oraclePrice = await tryCall(ammContract, 'price_oracle');

        if (typeof oraclePrice === 'bigint') {
          entry.oracle_price = ethers.formatEther(oraclePrice);
        } else {
          entry.oracle_price = String(oraclePrice);
        }

        if (typeof oracleAddr === 'string' && ethers.isAddress(oracleAddr)) {
          entry.oracle_contract = oracleAddr;

          // --- Detect oracle type ---
          // Try ChainlinkWrapper whitelist first (by-looking for Chainlink aggregator signature)
          const clContract = new ethers.Contract(oracleAddr, chainlinkOracleAbi, provider);
          const aggregator = await tryCall(clContract, 'aggregator');

          if (typeof aggregator === 'string' && ethers.isAddress(aggregator) && aggregator !== '0x0000000000000000000000000000000000000000') {
            entry.oracle_type = 'ChainlinkWrapper';
            entry.chainlink_feed = aggregator;

            const feed = new ethers.Contract(aggregator, CHAINLINK_FEED_ABI, provider);
            const [desc, decimals, roundData] = await Promise.all([
              tryCall(feed, 'description').catch(() => 'N/A'),
              tryCall(feed, 'decimals').catch(() => 8),
              tryCall(feed, 'latestRoundData').catch(() => null),
            ]);

            entry.chainlink_feed_desc = String(desc);
            if (roundData && typeof roundData === 'object' && roundData.updatedAt) {
              const updatedAt = Number(roundData.updatedAt);
              entry.chainlink_feed_updatedAt = updatedAt;
              entry.chainlink_feed_age_seconds = now - updatedAt;
              entry.chainlink_feed_stale = entry.chainlink_feed_age_seconds > 86400; // 24h threshold from the code
            }
          }

          // Try EmaPriceOracle interface
          const emaContract = new ethers.Contract(oracleAddr, EMA_ORACLE_ABI, provider);
          const maExpTime = await tryCall(emaContract, 'MA_EXP_TIME').catch(() => null);
          if (maExpTime !== null && typeof maExpTime !== 'string') {
            if (!entry.oracle_type) entry.oracle_type = 'EmaPriceOracle';
            entry.ema_ma_exp_time = Number(maExpTime);
            const lastTs = await tryCall(emaContract, 'last_timestamp').catch(() => null);
            if (typeof lastTs === 'bigint') entry.ema_last_timestamp = Number(lastTs);
            const lastPrice = await tryCall(emaContract, 'last_price').catch(() => null);
            if (typeof lastPrice === 'bigint') entry.ema_last_price = ethers.formatEther(lastPrice);
          }

          // Try CryptoFromPool interface
          if (!entry.oracle_type) {
            const cfpContract = new ethers.Contract(oracleAddr, CRYPTO_FROM_POOL_ABI, provider);
            const poolAddr = await tryCall(cfpContract, 'POOL').catch(() => null);
            if (typeof poolAddr === 'string' && ethers.isAddress(poolAddr) && poolAddr !== '0x0000000000000000000000000000000000000000') {
              entry.oracle_type = 'CryptoFromPool';
              entry.pool_address = poolAddr;

              const poolContract = new ethers.Contract(poolAddr, POOL_ABI, provider);
              const [virtualPrice, poolTs] = await Promise.all([
                tryCall(poolContract, 'get_virtual_price').catch(() => null),
                tryCall(poolContract, 'totalSupply').catch(() => null),
              ]);
              if (typeof virtualPrice === 'bigint' && typeof poolTs === 'bigint') {
                const vp = Number(ethers.formatEther(virtualPrice));
                const ts = Number(ethers.formatEther(poolTs));
                entry.pool_tvl_usd = Math.round(vp * ts);
                entry.pool_liquidity_usd = entry.pool_tvl_usd; // rough
              }
            } else {
              entry.oracle_type = 'Unknown';
            }
          }
        }
      }

      // Get collateral symbol
      if (ethers.isAddress(entry.collateral_token)) {
        const tok = new ethers.Contract(entry.collateral_token, ethAbi, provider);
        entry.collateral_symbol = String(await tryCall(tok, 'symbol').catch(() => '?'));

        // Check if the oracle contract IS the collateral token (like some vaults)
        if (entry.collateral_token.toLowerCase() === entry.oracle_contract?.toLowerCase()) {
          entry.oracle_type = 'SelfReferencing' + (entry.oracle_type || '');
        }
      }
    } catch (e) {
      entry.error = String(e).slice(0, 200);
    }

    results.push(entry);
    console.error(`  ${c.label}: oracle=${entry.oracle_type || '?'} feed_stale=${entry.chainlink_feed_stale} ma_exp=${entry.ema_ma_exp_time}s`);
  }

  const out = {
    generatedAt: new Date().toISOString(),
    nowTimestamp: now,
    controllers: results,
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.error(`\nWrote ${OUT}`);

  analyzeResults(out);
}

function analyzeResults(data) {
  console.log('\n═════════════════════════════════════════════');
  console.log('  crvUSD CONTROLLER ORACLE ANALYSIS');
  console.log('═════════════════════════════════════════════\n');

  const ChainlinkWrappers = data.controllers.filter(c => c.oracle_type === 'ChainlinkWrapper');
  const EmaOracles = data.controllers.filter(c => c.oracle_type === 'EmaPriceOracle');
  const CryptoFromPools = data.controllers.filter(c => c.oracle_type === 'CryptoFromPool');

  console.log(`CHAINLINK WRAPPERS (${ChainlinkWrappers.length}):`);
  for (const c of ChainlinkWrappers) {
    const age = c.chainlink_feed_age_seconds;
    const stale = c.chainlink_feed_stale;
    console.log(`  ${c.label.padEnd(12)} feed=${c.chainlink_feed_desc || c.chainlink_feed}  age=${age}s  ${stale ? '⚠️ STALE (24h+)' : '✓ fresh'}  debt=${c.controller_total_debt}/${c.controller_debt_ceiling}`);
  }

  console.log(`\nEMA ORACLES (${EmaOracles.length}):`);
  for (const c of EmaOracles) {
    const ma = c.ema_ma_exp_time;
    const short = ma < 3600;
    console.log(`  ${c.label.padEnd(12)} MA_EXP_TIME=${ma}s (${(ma/60).toFixed(1)}m)  ${short ? '⚠️ SHORT (<1h)' : '  long'}  debt=${c.controller_total_debt}/${c.controller_debt_ceiling}`);
  }

  console.log(`\nCRYPTO FROM POOL (${CryptoFromPools.length}):`);
  for (const c of CryptoFromPools) {
    console.log(`  ${c.label.padEnd(12)} pool=${c.pool_address}  TVL=$${(c.pool_tvl_usd || 0).toLocaleString()}  debt=${c.controller_total_debt}/${c.controller_debt_ceiling}`);
  }

  console.log('\n📍 ATTACK VECTORS:');
  const staleFeeds = ChainlinkWrappers.filter(c => c.chainlink_feed_stale);
  if (staleFeeds.length) {
    console.log(`  ⚠️  ${staleFeeds.length} STALE CHAINLINK FEEDS → E1/E8 pattern viable`);
    for (const c of staleFeeds) console.log(`     - ${c.label}: ${c.chainlink_feed_desc} age=${c.chainlink_feed_age_seconds}s`);
  } else {
    console.log('  ✗  No stale Chainlink feeds found');
  }

  const shortEma = EmaOracles.filter(c => c.ema_ma_exp_time < 3600);
  if (shortEma.length) {
    console.log(`  ⚠️  ${shortEma.length} SHORT EMA ORACLES (<1h) → pool manipulation viable`);
    for (const c of shortEma) console.log(`     - ${c.label}: MA_EXP_TIME=${c.ema_ma_exp_time}s`);
  } else {
    console.log('  ✗  No short EMA oracles (<1h)');
  }

  const lowTvlPools = CryptoFromPools.filter(c => c.pool_tvl_usd && c.pool_tvl_usd < 5_000_000);
  if (lowTvlPools.length) {
    console.log(`  ⚠️  ${lowTvlPools.length} LOW-TVL POOLS (<$5M) → partial EMA skew possible`);
    for (const c of lowTvlPools) console.log(`     - ${c.label}: TVL=$${c.pool_tvl_usd?.toLocaleString()}`);
  } else {
    console.log('  ✗  No low-TVL pools (<$5M)');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
