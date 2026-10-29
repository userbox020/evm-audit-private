#!/usr/bin/env node
// monitor-aave-v3-liquidation.js — Block-level Aave V3 liquidation watcher.
// Polls borrower HF on a configurable cadence. When HF < 1.0, preflights flash-liquidation
// via deployed FlashLiquidateAaveV3 contract. Live sends are fail-closed and
// require --live or AAVE_V3_EXECUTE_LIVE=true.
// RPC URLs are resolved in memory only and never printed.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const CHAIN_ID = 1;
const ARGS = process.argv.slice(2);

const AAVE_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const WEETH = "0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const BORROWER = "0x1A557354C5b8d7Df38ea914209e416Dc7065b158";
const LIQUIDATOR = process.env.LIQUIDATOR_CONTRACT || "0x1C4Bc8d8b5806C1D73b47bC7ae4c2b6552c858A1";
const POLL_MS = parsePollMs();
const RUN_ONCE = ARGS.includes("--once");
const MIN_PROFIT_USD = 100;
const CLOSE_FACTOR = 0.5;
const FEE_POOL = 3000; // 0.30% Uniswap V3 weETH/WETH pool
const LIVE_EXECUTE = ARGS.includes("--live") || process.env.AAVE_V3_EXECUTE_LIVE === "true";
const INVALID_AAVE_LIQUIDATE_SELECTOR = ethers.id("liquidate(address,address,address,uint256,bool)").slice(0, 10).toLowerCase();
const CORRECT_AAVE_LIQUIDATION_CALL_SELECTOR = ethers.id("liquidationCall(address,address,address,uint256,bool)").slice(0, 10).toLowerCase();
const EXECUTE_SELECTOR = ethers.id("execute(uint256,uint256,uint256,bytes)").slice(0, 10).toLowerCase();

const AAVE_ABI = [
  "function getUserAccountData(address user) view returns (uint256,uint256,uint256,uint256,uint256,uint256)",
  "function getReserveData(address asset) view returns (tuple(uint256,uint128,uint128,uint128,uint128,uint128,uint40,uint16,address,address,address,address,uint128,uint128,uint128))",
];
const LIQ_ABI = [
  "function execute(uint256 debtToCover, uint256 minProfitWei, bytes swapPath) external",
  "function isLiquidatable() view returns (bool,uint256)",
  "function owner() view returns (address)",
];

function argValue(name) {
  const prefix = `${name}=`;
  const item = ARGS.find((arg) => arg.startsWith(prefix));
  if (item) return item.slice(prefix.length);
  const idx = ARGS.indexOf(name);
  return idx >= 0 ? ARGS[idx + 1] : null;
}

function parsePollMs() {
  const raw = argValue("--interval-ms") || process.env.AAVE_V3_POLL_MS || "12000";
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 12_000;
  return Math.max(5_000, Math.floor(parsed));
}

function loadRpcUrls() { if(!fs.existsSync(RPC_FILE)) return []; return [...fs.readFileSync(RPC_FILE,"utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map(m=>m[0]); }
async function rpcCall(url,method,params=[],ms=15000){const c=new AbortController();const t=setTimeout(()=>c.abort(),ms);try{const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method,params}),signal:c.signal});const j=await r.json();if(j.error)throw new Error(j.error.message);return j.result??null}finally{clearTimeout(t)}}
async function resolveRpc(chainId){for(const url of loadRpcUrls()){try{const id=Number(BigInt(await rpcCall(url,"eth_chainId",[],6000)));if(id===chainId)return url}catch(_){}}return null}

function ts() { return new Date().toISOString(); }
async function waitForNextPoll() { if (RUN_ONCE) return false; await new Promise(r => setTimeout(r, POLL_MS)); return true; }

async function getHf(provider) {
  const pool = new ethers.Contract(AAVE_POOL, AAVE_ABI, provider);
  const data = await pool.getUserAccountData(BORROWER);
  return {
    totalCollateral: Number(data[0]) / 1e8,
    totalDebt: Number(data[1]) / 1e8,
    hf: Number(data[5]) / 1e18,
    ltv: Number(data[4]) / 100,
    lt: Number(data[3]) / 100,
  };
}

async function getReserveConfig(provider) {
  const pool = new ethers.Contract(AAVE_POOL, AAVE_ABI, provider);
  const rd = await pool.getReserveData(WEETH);
  // Liquidation bonus is stored in bps at bits 32..47 as 10000 + bonusBps.
  const config = BigInt(rd[0]);
  const liquidationBonusBps = Number((config >> 32n) & 0xFFFFn);
  return { liqBonus: Math.max(0, liquidationBonusBps - 10000) / 100 };
}

function buildSwapPath(weethAmount, wethOutMin) {
  // weETH (0xCd5f) -> WETH (0xC02a) 0.30% pool
  return ethers.solidityPacked(
    ["address", "uint24", "address"],
    [WEETH, FEE_POOL, WETH]
  );
}

function extractPush4Selectors(bytecode) {
  const hex = String(bytecode || "").replace(/^0x/i, "");
  const selectors = new Set();
  for (let i = 0; i + 10 <= hex.length; i += 2) {
    if (hex.slice(i, i + 2).toLowerCase() === "63") selectors.add(`0x${hex.slice(i + 2, i + 10).toLowerCase()}`);
  }
  return selectors;
}

async function verifyLiquidatorSelector(provider) {
  const code = await provider.getCode(LIQUIDATOR).catch(() => "0x");
  const selectors = extractPush4Selectors(code);
  const blockers = [];
  if (!LIQUIDATOR || code === "0x") blockers.push("liquidator contract has no deployed bytecode");
  if (!selectors.has(EXECUTE_SELECTOR)) blockers.push("liquidator execute selector missing");
  if (!selectors.has(CORRECT_AAVE_LIQUIDATION_CALL_SELECTOR)) blockers.push("liquidator does not prove Aave V3 liquidationCall selector");
  if (selectors.has(INVALID_AAVE_LIQUIDATE_SELECTOR)) blockers.push("liquidator bytecode contains invalid Aave liquidate selector");
  return { ok: blockers.length === 0, blockers };
}

async function main() {
  const rpc = await resolveRpc(CHAIN_ID);
  if (!rpc) { console.error("No ETH RPC"); process.exit(1); }
  const provider = new ethers.JsonRpcProvider(rpc, CHAIN_ID, { staticNetwork: true });
  console.log(`${ts()} Liquidator watcher started. Polling every ${POLL_MS / 1000}s${RUN_ONCE ? " (one-shot)" : ""}...`);
  console.log(`${ts()} Live execution: ${LIVE_EXECUTE ? "ENABLED" : "DISABLED (set AAVE_V3_EXECUTE_LIVE=true or pass --live)"}`);

  let lastHf = null;
  while (true) {
    try {
      const data = await getHf(provider);
      const hfStr = data.hf.toFixed(5);
      const distBps = ((data.hf - 1) * 10000).toFixed(1);

      if (hfStr !== lastHf) {
        console.log(`${ts()} HF=${hfStr} debt=$${Math.round(data.totalDebt).toLocaleString()} distance=${distBps}bps`);
        lastHf = hfStr;
      }

      if (data.hf < 1.0) {
        console.log(`${ts()} TRIGGER: HF=${hfStr} < 1.0 — borrower is LIQUIDATABLE!`);

        // Compute liquidation params
        const debtToCoverUsd = data.totalDebt * CLOSE_FACTOR;
        const { liqBonus } = await getReserveConfig(provider);
        // Get current prices for debt amount calculation
        const wethPrice = await rpcCall(rpc, "eth_call", [{ to: "0x54586bE62E3c3580375aE3723C145253060Ca0C2", data: "0xb3596f07000000000000000000000000" + WETH.slice(2) }, "latest"]).catch(() => null);
        const weethPrice = await rpcCall(rpc, "eth_call", [{ to: "0x54586bE62E3c3580375aE3723C145253060Ca0C2", data: "0xb3596f07000000000000000000000000" + WEETH.slice(2) }, "latest"]).catch(() => null);
        const wethPriceUsd = wethPrice ? Number(BigInt(wethPrice)) / 1e8 : null;
        const weethPriceUsd = weethPrice ? Number(BigInt(weethPrice)) / 1e8 : null;

        if (!wethPriceUsd || !weethPriceUsd) {
          console.log("ERROR: could not get oracle prices");
          if (!(await waitForNextPoll())) break;
          continue;
        }

        const debtToCover = ethers.parseUnits((debtToCoverUsd / wethPriceUsd).toFixed(8), 18);

        // Compute expected profit
        const seizedWeethEst = debtToCoverUsd * (1 + liqBonus / 100) / weethPriceUsd;
        const grossProfit = seizedWeethEst * weethPriceUsd * 0.995 - debtToCoverUsd; // 0.5% slippage
        const minProfitWei = ethers.parseUnits(Math.max(0, (grossProfit * 0.8) / wethPriceUsd).toFixed(8), 18); // 80% of expected as minimum

        console.log(`  Debt to cover: $${Math.round(debtToCoverUsd).toLocaleString()} (${ethers.formatUnits(debtToCover, 18)} WETH)`);
        console.log(`  Liq bonus: ${liqBonus}%`);
        console.log(`  Est profit: $${Math.round(grossProfit).toLocaleString()}`);
        console.log(`  Min profit: ${ethers.formatUnits(minProfitWei, 18)} WETH`);

        // Build swap path
        const swapPath = buildSwapPath();

        if (!LIQUIDATOR) {
          console.log(`${ts()} NO liquidator contract configured. Set LIQUIDATOR_CONTRACT env var.`);
          console.log(`${ts()} Dry-run only — not executing.`);
          if (!(await waitForNextPoll())) break;
          continue;
        }

        const selectorReadiness = await verifyLiquidatorSelector(provider);
        if (!selectorReadiness.ok) {
          console.log(`${ts()} LIQUIDATOR SELECTOR GATE CLOSED: ${selectorReadiness.blockers.join("; ")}`);
          console.log(`${ts()} Not executing. Redeploy/verify a liquidator that calls Aave V3 liquidationCall(...).`);
          if (!(await waitForNextPoll())) break;
          continue;
        }

        // Verify contract
        const liq = new ethers.Contract(LIQUIDATOR, LIQ_ABI, provider);
        const [isLiq, liveHf] = await liq.isLiquidatable();
        if (!isLiq) {
          console.log(`${ts()} Contract disagrees: HF=${Number(liveHf)/1e18} — race condition or stale data`);
          if (!(await waitForNextPoll())) break;
          continue;
        }

        if (!LIVE_EXECUTE) {
          console.log(`${ts()} LIVE EXECUTION DISABLED. Preflight passed; would execute if --live or AAVE_V3_EXECUTE_LIVE=true were set.`);
          if (!(await waitForNextPoll())) break;
          continue;
        }

        const pk = process.env.PRIVATE_KEY || "";
        if (!/^0x?[0-9a-fA-F]{64}$/.test(pk)) {
          console.log(`${ts()} PRIVATE_KEY missing or invalid. Not executing.`);
          if (!(await waitForNextPoll())) break;
          continue;
        }

        // Execute
        console.log(`${ts()} SENDING LIQUIDATION TX...`);
        try {
          const wallet = new ethers.Wallet(pk.startsWith("0x") ? pk : `0x${pk}`, provider);
          const signedLiq = liq.connect(wallet);
          const tx = await signedLiq.execute(debtToCover, minProfitWei, swapPath, {
            gasLimit: 1_500_000,
          });
          console.log(`${ts()} TX SENT: ${tx.hash}`);
          const receipt = await tx.wait();
          console.log(`${ts()} CONFIRMED: block=${receipt.blockNumber} gas=${Number(receipt.gasUsed).toLocaleString()}`);
          
          // Report profit
          const wethBal = await new ethers.Contract(WETH, ["function balanceOf(address) view returns (uint256)"], provider).balanceOf(LIQUIDATOR);
          console.log(`${ts()} Liquidation complete. Contract WETH balance: ${ethers.formatUnits(wethBal, 18)}`);
          break; // exit after successful execution
        } catch (e) {
          console.log(`${ts()} TX FAILED: ${e.reason || e.message?.slice(0, 200)}`);
        }
      }
    } catch (e) {
      console.error(`${ts()} Error: ${e.message?.slice(0, 150)}`);
    }
    if (!(await waitForNextPoll())) break;
  }
}

main().catch(e => { console.error(e); process.exit(1); });
