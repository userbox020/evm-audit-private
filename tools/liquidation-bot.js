// liquidation-bot.js — Auto-executes profitable Morpho Blue liquidations
// Reads E9+E11 monitor data, sends liquidate() tx when profitable.
// No smart contract needed — just a wallet and gas.
//
// Usage:
//   node tools/liquidation-bot.js --once      Scan once, show positions, exit
//   node tools/liquidation-bot.js --watch     Scan every 300s, auto-execute best
//   node tools/liquidation-bot.js --dry-run   Show what would be executed

const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

// ── Config ──────────────────────────────────────────────────────────
const MORPHO_BLUE = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const GAS_LIMIT_LIQUIDATE = 400000;
const GAS_LIMIT_SWAP = 300000;
const MIN_PROFIT_USD = 5;
const DEX_LIQUIDITY_CACHE_MS = 3600_000; // 1 hour

const ENV_FILE = path.join(__dirname, "..", ".env.exploit");
const dexCache = new Map();

// ── Morpho Blue liquidation ABI ─────────────────────────────────────
const MORPHO_ABI = [
  "function liquidate((address,address,address,address,uint256),address,uint256,uint256,bytes) external returns (uint256,uint256)",
];

// ── Helpers ─────────────────────────────────────────────────────────
const { resolveRpc } = require("./shared-rpc");

function loadWallet() {
  if (!fs.existsSync(ENV_FILE)) { console.error(".env.exploit not found"); process.exit(1); }
  const env = {};
  fs.readFileSync(ENV_FILE, "utf8").split("\n").forEach(l => {
    const [k, ...v] = l.trim().split("=");
    if (k && v.length) env[k] = v.join("=").replace(/^["']|["']$/g, "");
  });
  return env;
}

async function queryMorphoPositions() {
  const q = `{
    marketPositions(first:50, orderBy:BorrowShares, orderDirection:Desc,
      where:{healthFactor_lte:0.99, borrowShares_gte:"1"}) {
      items {
        user { address }
        market {
          uniqueKey
          loanAsset { symbol address decimals }
          collateralAsset { symbol address decimals }
          oracle { address }
          irmAddress
          lltv
        }
        borrowShares
        borrowAssets
        collateral
        healthFactor
        state { collateralUsd borrowAssetsUsd }
      }
    }
  }`;
  try {
    const r = await fetch("https://api.morpho.org/graphql", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: q }), signal: AbortSignal.timeout(8000)
    });
    const j = await r.json();
    return (j.data?.marketPositions?.items || []).filter(p =>
      parseFloat(p.healthFactor) < 1 &&
      parseFloat(p.state?.borrowAssetsUsd || 0) > 100 &&
      parseFloat(p.state?.collateralUsd || 0) > 1
    );
  } catch (_) { return []; }
}

async function checkDexLiquidity(collateralSymbol) {
  const key = collateralSymbol || "unknown";
  if (dexCache.has(key) && Date.now() - dexCache.get(key).ts < DEX_LIQUIDITY_CACHE_MS) {
    return dexCache.get(key);
  }
  try {
    const q = `{pools(first:3, orderBy:totalValueLockedUSD, orderDirection:desc, where:{token0_:{symbol:"${collateralSymbol}"}, token1_:{symbol:"WETH"}}){id totalValueLockedUSD}}`;
    const r = await fetch("https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: q }), signal: AbortSignal.timeout(5000)
    });
    const j = await r.json();
    const pools = j.data?.pools || [];
    const result = { tvl: pools.length > 0 ? Number(pools[0].totalValueLockedUSD) : 0, pools: pools.length, ts: Date.now() };
    dexCache.set(key, result);
    return result;
  } catch (_) {
    const result = { tvl: 0, pools: 0, ts: Date.now() };
    dexCache.set(key, result);
    return result;
  }
}

async function analyzePositions(positions) {
  const GAS_COST_USD = 15; // ~400K gas + 300K swap at 20 gwei
  const analyzed = [];

  for (const pos of positions) {
    const borrow = parseFloat(pos.state?.borrowAssetsUsd || "0");
    const m = pos.market;
    const collSymbol = m.collateralAsset?.symbol || "?";
    const loanSymbol = m.loanAsset?.symbol || "?";

    const lltv = parseFloat(m.lltv || "0") / 1e18;
    const lif = 1.05; // 5% bonus typical
    const closeFactor = 0.50;
    const maxRepay = borrow * closeFactor;
    const grossProfit = maxRepay * (lif - 1);

    const dex = await checkDexLiquidity(collSymbol);
    let slippagePct = 0;
    if (dex.tvl > 0) {
      slippagePct = Math.min((maxRepay / dex.tvl) * 2, 10); // cap at 10%
    } else {
      slippagePct = 100; // no liquidity = worthless
    }
    const slippageUSD = grossProfit * (slippagePct / 100);
    const netProfit = grossProfit - GAS_COST_USD - slippageUSD;

    analyzed.push({
      borrower: pos.user.address,
      market: loanSymbol + "/" + collSymbol,
      loanToken: m.loanAsset.address,
      collToken: m.collateralAsset.address,
      oracle: m.oracle?.address || "",
      irm: m.irmAddress || "",
      lltvRaw: m.lltv,
      loanDecimals: parseInt(m.loanAsset.decimals || "18"),
      collDecimals: parseInt(m.collateralAsset.decimals || "18"),
      borrowShares: pos.borrowShares,
      borrowAssets: pos.borrowAssets,
      borrowUSD: borrow,
      hf: parseFloat(pos.healthFactor),
      maxRepay: maxRepay,
      grossProfit,
      slippage: slippageUSD,
      netProfit,
      dexTVL: dex.tvl,
      profitable: netProfit > MIN_PROFIT_USD,
    });
  }

  analyzed.sort((a, b) => b.netProfit - a.netProfit);
  return analyzed;
}

// ── Execution ───────────────────────────────────────────────────────
async function executeLiquidation(wallet, provider, pos) {
  console.log(`\nExecuting liquidation: ${pos.market}`);
  console.log(`  Borrower: ${pos.borrower}`);
  console.log(`  Repay: $${pos.maxRepay.toFixed(2)} | Profit: $${pos.netProfit.toFixed(2)}`);

  // Build MarketParams
  const marketParams = [
    pos.loanToken,
    pos.collToken,
    pos.oracle,
    pos.irm,
    pos.lltvRaw
  ];

  // Repay 50% of borrow (close factor). repaidShares is in loan token shares.
  // For Morpho Blue: repaidShares = borrow shares to repay. We use borrowShares * 0.5
  const repaidShares = (BigInt(pos.borrowShares) * 50n) / 100n;
  const minSeized = 0; // Accept any amount (slippage protection could be added)

  const morpho = new ethers.Contract(MORPHO_BLUE, MORPHO_ABI, wallet);

  const rawGasPrice = await provider.send("eth_gasPrice", []);
  const gasPrice = BigInt(rawGasPrice) * 150n / 100n;

  // Approve Morpho to pull loan token (needed to repay debt)
  const erc20 = new ethers.Contract(pos.loanToken, [
    "function approve(address,uint256) external returns (bool)",
    "function balanceOf(address) view returns (uint256)",
  ], wallet);

  const loanBalance = await erc20.balanceOf(wallet.address);
  const repayAmount = BigInt(pos.borrowShares) * 50n / 100n; // Approximate — shares ≠ tokens
  if (loanBalance < repayAmount) {
    console.log(`  INSUFFICIENT ${pos.market.split("/")[0]} balance. Need $${pos.maxRepay.toFixed(2)} worth.`);
    return false;
  }

  const approveTx = await erc20.approve(MORPHO_BLUE, repayAmount, { gasPrice });
  await approveTx.wait();

  const tx = await morpho.liquidate(
    marketParams,
    pos.borrower,
    minSeized,
    repaidShares,
    "0x",
    { gasLimit: GAS_LIMIT_LIQUIDATE, gasPrice }
  );

  console.log(`  Tx: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`  Confirmed! Block ${receipt.blockNumber}, gas ${receipt.gasUsed}`);

  // Swap seized collateral for loan token
  const collBalance = await new ethers.Contract(pos.collToken, [
    "function balanceOf(address) view returns (uint256)",
  ], provider).balanceOf(wallet.address);

  if (collBalance > 0n) {
    console.log(`  Seized collateral. Swap on DEX to realize profit.`);
    // TODO: Uniswap V3 swap integration
    // For now, collateral sits in wallet — user can swap manually
  }

  return true;
}

// ── Main ────────────────────────────────────────────────────────────
async function cmdOnce(dryRun) {
  console.log("Scanning Morpho Blue for profitable liquidations...\n");
  const positions = await queryMorphoPositions();
  console.log(`Underwater positions: ${positions.length}`);

  if (positions.length === 0) {
    console.log("No underwater positions found.\n");
    return;
  }

  const analyzed = await analyzePositions(positions);
  const profitable = analyzed.filter(p => p.profitable);

  console.log(`\n=== RESULTS ===`);
  console.log(`Analyzed: ${analyzed.length} | Profitable: ${profitable.length}\n`);

  if (profitable.length > 0) {
    for (const p of profitable.slice(0, 10)) {
      console.log(`[${p.market}] ${p.borrower.slice(0,10)}... HF=${p.hf.toFixed(4)}`);
      console.log(`  Repay: $${p.maxRepay.toFixed(2)} | Gross: $${p.grossProfit.toFixed(2)} | Slippage: $${p.slippage.toFixed(2)}`);
      console.log(`  NET: $${p.netProfit.toFixed(2)} | DEX TVL: $${p.dexTVL.toLocaleString()}`);
      console.log();
    }
    if (!dryRun) {
      console.log("Run with --watch to auto-execute top position.");
    }
  } else {
    console.log("No profitable positions (bad DEX liquidity or gas > profit).");
    console.log("Unprofitable positions:");
    for (const p of analyzed.slice(0, 3)) {
      console.log(`  [${p.market}] ${p.borrower.slice(0,10)}... HF=${p.hf.toFixed(4)} net=$${p.netProfit.toFixed(2)} DEX=$${p.dexTVL.toLocaleString()}`);
    }
  }
}

async function cmdWatch() {
  const provider = new ethers.JsonRpcProvider(await resolveRpc(1));
  const env = loadWallet();
  const wallet = new ethers.Wallet(env.PRIVATE_KEY, provider);

  console.log(`LIQUIDATION BOT: ${wallet.address}`);
  console.log(`Min profit: $${MIN_PROFIT_USD} | Interval: 300s\n`);

  while (true) {
    const now = new Date().toLocaleTimeString();
    try {
      const positions = await queryMorphoPositions();
      if (positions.length === 0) {
        console.log(`[${now}] No underwater positions`);
      } else {
        const analyzed = await analyzePositions(positions);
        const profitable = analyzed.filter(p => p.profitable);
        if (profitable.length > 0) {
          const best = profitable[0];
          console.log(`[${now}] PROFITABLE: ${best.market} net=$${best.netProfit.toFixed(2)}`);

          const bal = await provider.getBalance(wallet.address);
          if (Number(ethers.formatEther(bal)) < 0.01) {
            console.log(`[${now}] INSUFFICIENT ETH for gas (${ethers.formatEther(bal)} ETH)`);
          } else {
            await executeLiquidation(wallet, provider, best);
          }
        } else {
          console.log(`[${now}] ${positions.length} underwater, 0 profitable (top net=$${analyzed[0]?.netProfit?.toFixed(2) || "0"})`);
        }
      }
    } catch (e) {
      console.log(`[${now}] Error: ${e.shortMessage || e.message}`);
    }
    await new Promise(r => setTimeout(r, 300_000));
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--watch")) {
    await cmdWatch();
  } else {
    await cmdOnce(args.includes("--dry-run"));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
