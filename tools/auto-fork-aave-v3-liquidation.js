#!/usr/bin/env node
// Auto-fork proof: Aave V3 weETH/WETH liquidation profitability.
// Triggered when monitored borrower HF < 1.0 (liquidatable).
// Uses Anvil fork + impersonated liquidator.
// Fork port: 8548 (vs V4 on 8547 to avoid conflicts).
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const cp = require("child_process");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "fork-proof-aave-v3-liquidation.json");
const CHAIN_ID = 1;
const PORT = 8548;
const TIMEOUT_MS = 120_000;
const MIN_NET_PROFIT_USD = 25;

const POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const BORROWER = "0x1A557354C5b8d7Df38ea914209e416Dc7065b158";
// Aave V3 aTokens/debtTokens for weETH and WETH on Ethereum
const AWEETH = "0xB76a622645990fDCbEe91e699EdcD7d2B117F04f"; // aEthweETH
const VDEBT_WETH = "0xeA51d7853EEFb32b6ee06b1C12E6dcCA88Be0fFE"; // variableDebtEthWETH
const WEETH = "0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const AAVE_ORACLE = "0x54586bE62E3c3580375aE3723C145253060Ca0C2";

// WETH whales for liquidation funding
const WETH_WHALES = [
  "0x2F0b23f53734252Bda2277357e97e1517d6B042A", // Maker
  "0xF04a5cC80B1E94C69B48f5ee68a08CD2F09A7c3E", // Binance
  "0xBeef047a543E45807105E737EfBdECDbC1195252", // Beefy
];

function jsonReplacer(k,v){return typeof v==="bigint"?v.toString():v}
function round(v,d=6){const n=typeof v==="number"?v:Number(String(v).replace(/[$,%_\\s]/g,""));if(!Number.isFinite(n))return null;const f=10**d;return Math.round(n*f)/f}

function loadRpcUrls(){const{loadRpcUrls:l}=require("./shared-rpc");return l()}
async function resolveRpc(chainId){const{resolveRpc:r}=require("./shared-rpc");return r(chainId)}

const POOL_ABI = [
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
  "function liquidate(address collateralAsset, address debtAsset, address user, uint256 debtToCover, bool receiveAToken) returns (uint256)",
  "function getReserveData(address asset) view returns (tuple(uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))",
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];
const ORACLE_ABI = [
  "function getAssetPrice(address) view returns (uint256)",
];

async function main() {
  const rpc = await resolveRpc(CHAIN_ID);
  if (!rpc) { console.error("No RPC"); process.exit(1); }

  // Step 1: Read live borrower data
  console.log("Step 1: Reading Aave V3 borrower data...");
  const provider = new ethers.JsonRpcProvider(rpc, CHAIN_ID, { staticNetwork: true });
  const block = await provider.getBlockNumber();
  const pool = new ethers.Contract(POOL, POOL_ABI, provider);
  const oracle = new ethers.Contract(AAVE_ORACLE, ORACLE_ABI, provider);

  const accData = await pool.getUserAccountData(BORROWER);
  const hf = Number(accData.healthFactor) / 1e18;
  const totalCollateral = Number(accData.totalCollateralBase) / 1e8;
  const totalDebt = Number(accData.totalDebtBase) / 1e8;
  const lt = Number(accData.currentLiquidationThreshold) / 100;
  console.log(`  HF=${hf.toFixed(5)} collateral=$${Math.round(totalCollateral).toLocaleString()} debt=$${Math.round(totalDebt).toLocaleString()} LT=${lt.toFixed(2)}%`);

  // Get prices
  const weethPriceRaw = await oracle.getAssetPrice(WEETH);
  const wethPriceRaw = await oracle.getAssetPrice(WETH);
  const weethPrice = Number(weethPriceRaw) / 1e8;
  const wethPrice = Number(wethPriceRaw) / 1e8;
  console.log(`  weETH=$${weethPrice.toFixed(2)} WETH=$${wethPrice.toFixed(2)}`);

  // Get reserve data to find correct aToken/variableDebtToken addresses
  const weethReserve = await pool.getReserveData(WEETH);
  const wethReserve = await pool.getReserveData(WETH);
  const aWeeth = weethReserve.aTokenAddress;
  const vDebtWeth = wethReserve.variableDebtTokenAddress;
  console.log(`  aWeETH=${aWeeth} vDebtWETH=${vDebtWeth}`);

  // Step 2: Check if currently liquidatable
  if (hf >= 1.0) {
    console.log(`\nStep 2: Borrower NOT liquidatable (HF=${hf.toFixed(5)} >= 1.0)`);
    console.log(`  Distance to liquidation: ${((hf - 1) * 10000).toFixed(1)} bps`);
    console.log(`  Required weETH price drop: weETH must fall to $${(weethPrice * (1/hf)).toFixed(2)} (from $${weethPrice.toFixed(2)})`);
    
    const result = {
      scannedAt: new Date().toISOString(),
      blockNumber: block,
      status: "not-liquidatable",
      healthFactor: hf,
      distanceToLiquidationBps: round((hf - 1) * 10000, 2),
      totalCollateralUsd: round(totalCollateral, 2),
      totalDebtUsd: round(totalDebt, 2),
      weethPrice,
      wethPrice,
      requiredWeethDrop: round(weethPrice * (1/hf), 2),
      note: "Position approaches liquidation — fork proof will execute when HF < 1.0",
    };
    fs.writeFileSync(OUT, JSON.stringify(result, jsonReplacer, 2));
    console.log(`\nArtifact: ${OUT}`);
    return;
  }

  // Step 3: Position IS liquidatable — compute profit
  const closeFactor = 0.5; // Aave V3 default: 50%
  const weethReserveConfig = weethReserve.configuration;
  // ReserveConfiguration._getLiquidationBonus: bits 32*8+0..15
  const liqBonusRaw = Number((BigInt(weethReserveConfig) >> (32n * 8n)) & 0xFFFFn);
  const liqBonus = liqBonusRaw / 100; // percentage (e.g., 10500 = 5% bonus)
  console.log(`\nStep 3: Position LIQUIDATABLE! HF=${hf.toFixed(5)} < 1.0`);
  console.log(`  Liquidation bonus: ${liqBonus.toFixed(2)}%`);

  const maxDebtToCover = totalDebt * closeFactor;
  // seizedCollateral = debtToCover * (1 + liqBonus%) / collateralPrice
  const seizedWeeth = maxDebtToCover * (1 + liqBonus / 100) / weethPrice;
  const profitWeeth = seizedWeeth - (maxDebtToCover / weethPrice); // seized - what's needed to cover debt
  const profitUsd = profitWeeth * weethPrice;

  console.log(`  Max debt to cover: $${Math.round(maxDebtToCover).toLocaleString()}`);
  console.log(`  Seized weETH: ${seizedWeeth.toFixed(4)} worth $${Math.round(seizedWeeth * weethPrice).toLocaleString()}`);
  console.log(`  Estimated profit: $${Math.round(profitUsd).toLocaleString()}`);

  // Step 4: Anvil fork + execute
  console.log(`\nStep 4: Starting Anvil fork on port ${PORT}...`);
  const anvil = cp.spawn("anvil", [
    "--fork-url", rpc,
    "--fork-block-number", String(block),
    "--port", String(PORT),
    "--no-mining",
    "--silent",
  ], { stdio: ["ignore", "pipe", "pipe"], detached: false });
  anvil.on("error", () => {});
  let anvilStarted = false;
  anvil.stdout?.on("data", d => { if (d.toString().includes("Listening")) anvilStarted = true; });

  try {
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => { if (!anvilStarted) reject(new Error("Anvil timeout")); }, 30000);
      const check = setInterval(() => { if (anvilStarted) { clearTimeout(deadline); clearInterval(check); resolve(); } }, 500);
    });
    console.log("  Anvil ready");

    const forkProvider = new ethers.JsonRpcProvider(`http://127.0.0.1:${PORT}`, CHAIN_ID, { staticNetwork: true });
    const forkPool = new ethers.Contract(POOL, POOL_ABI, forkProvider);
    const forkWeeth = new ethers.Contract(WEETH, ERC20_ABI, forkProvider);
    const forkWeth = new ethers.Contract(WETH, ERC20_ABI, forkProvider);

    // Impersonate WETH whale for liquidation funding
    let whaleAddr = null;
    for (const w of WETH_WHALES) {
      try {
        const bal = await forkWeth.balanceOf(w);
        if (Number(bal) > Number(ethers.parseUnits(String(Math.ceil(maxDebtToCover / wethPrice)), 18))) {
          whaleAddr = w;
          break;
        }
      } catch (_) {}
    }
    if (!whaleAddr) {
      console.log("  ⚠️ No WETH whale with sufficient balance found");
      const result = { scannedAt: new Date().toISOString(), blockNumber: block, status: "fork-failed", reason: "no-whale" };
      fs.writeFileSync(OUT, JSON.stringify(result, jsonReplacer, 2));
      return;
    }

    await forkProvider.send("anvil_impersonateAccount", [whaleAddr]);
    await forkProvider.send("anvil_setBalance", [whaleAddr, "0x1000000000000000000"]); // 1 ETH gas
    const signer = await forkProvider.getSigner(whaleAddr);
    const wethForSigner = forkWeth.connect(signer);

    const debtToCover = ethers.parseUnits(String(Math.ceil(maxDebtToCover / wethPrice)), 18);
    console.log(`  Whale: ${whaleAddr}  debtToCover: ${ethers.formatUnits(debtToCover, 18)} WETH`);

    // Transfer WETH to whale if needed (whale already has it)
    const preGas = await forkProvider.send("eth_estimateGas", [{
      from: whaleAddr,
      to: POOL,
      data: pool.interface.encodeFunctionData("liquidate", [WEETH, WETH, BORROWER, debtToCover, false]),
    }]);
    console.log(`  Estimated gas: ${Number(BigInt(preGas)).toLocaleString()}`);

    // 7. Execute liquidation on fork (impersonated whale as liquidator)
    try {
      // Ensure WETH approval to pool
      const wethApproval = await forkWeth.allowance(whaleAddr, POOL);
      if (wethApproval < debtToCover) {
        console.log(`  Approving WETH transfer...`);
        const approveTx = await wethForSigner.approve(POOL, ethers.MaxUint256);
        await approveTx.wait();
      }

      const tx = await forkPool.connect(signer).liquidate(WEETH, WETH, BORROWER, debtToCover, false);
      const receipt = await tx.wait();
      console.log(`  Liquidation tx: ${receipt.hash}  gas: ${Number(receipt.gasUsed).toLocaleString()}`);

      // 8. Measure profit
      const weethSeized = await forkWeeth.balanceOf(whaleAddr);
      const wethSpent = debtToCover;
      const profitEth = Number(ethers.formatUnits(weethSeized, 18)) * weethPrice - Number(ethers.formatUnits(wethSpent, 18)) * wethPrice;
      const gasCost = Number(receipt.gasUsed) * Number(await forkProvider.send("eth_gasPrice", [])) / 1e18;
      const gasCostUsd = gasCost * wethPrice;
      const netProfitUsd = profitEth - gasCostUsd;

      console.log(`\n  === Fork Result ===`);
      console.log(`  weETH seized: ${ethers.formatUnits(weethSeized, 18)} ($${Math.round(Number(ethers.formatUnits(weethSeized, 18)) * weethPrice).toLocaleString()})`);
      console.log(`  WETH spent: ${ethers.formatUnits(wethSpent, 18)} ($${Math.round(Number(ethers.formatUnits(wethSpent, 18)) * wethPrice).toLocaleString()})`);
      console.log(`  Gross profit: $${Math.round(profitEth).toLocaleString()}`);
      console.log(`  Gas cost: $${gasCostUsd.toFixed(2)}`);
      console.log(`  Net profit: $${netProfitUsd.toFixed(2)}`);

      const result = {
        scannedAt: new Date().toISOString(),
        blockNumber: block,
        status: netProfitUsd >= MIN_NET_PROFIT_USD ? "positive" : "below-threshold",
        healthFactor: hf,
        totalCollateralUsd: round(totalCollateral, 2),
        totalDebtUsd: round(totalDebt, 2),
        weethPrice,
        wethPrice,
        liquidationBonus: liqBonus,
        closeFactor,
        debtToCoverUsd: round(maxDebtToCover, 2),
        weethSeized: ethers.formatUnits(weethSeized, 18),
        grossProfitUsd: round(profitEth, 2),
        gasCostUsd: round(gasCostUsd, 2),
        netProfitUsd: round(netProfitUsd, 2),
        liquidatorWhale: whaleAddr,
        txHash: receipt.hash,
      };
      fs.writeFileSync(OUT, JSON.stringify(result, jsonReplacer, 2));
      console.log(`\nArtifact: ${OUT}`);
    } catch (e) {
      console.log(`  Liquidation failed: ${e.reason || e.message?.slice(0, 200)}`);
      const result = { scannedAt: new Date().toISOString(), blockNumber: block, status: "fork-failed", reason: e.reason || e.message?.slice(0, 200) };
      fs.writeFileSync(OUT, JSON.stringify(result, jsonReplacer, 2));
    }
  } finally {
    try { cp.execSync(`taskkill /F /PID ${anvil.pid}`); } catch (_) {}
    console.log("  Anvil stopped");
  }
}

main().catch(e => { console.error(e); process.exit(1); });
