#!/usr/bin/env node
"use strict";
// Read-only USD0 venue/price discovery at a pinned finalized block (Ethereum mainnet).
// Endpoint material is process-only and never printed. No signing/transactions.
const fs = require("fs");
const path = require("path");
const { ethers } = require("./node_modules/ethers");
const { resolveRpc, rpcCall } = require("./shared-rpc.js");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "reports/raw/fast/usual-usd0-venues-step1.json");

const USD0 = "0x73A15FeD60Bf67631dC6cd7Bc5B6e8da8190aCF5";
const TOKENS = {
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  DAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
  WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
};
const UNIV3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const UNIV2_FACTORY = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f";
const SUSHI_FACTORY = "0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac";
const QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const CURVE_DC_USD0PP = "0x1d08E7adC263CfC70b1BaBe6dC5Bb339c16Eec52";

const iface = new ethers.Interface([
  "function getPool(address,address,uint24) view returns (address)",
  "function getPair(address,address) view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function decimals() view returns (uint8)",
  "function coins(uint256) view returns (address)",
  "function balances(uint256) view returns (uint256)",
  "function get_dy(int128,int128,uint256) view returns (uint256)",
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);

async function main() {
  const url = await resolveRpc(1);
  if (!url) { console.error(JSON.stringify({ status: "NO_RPC" })); process.exitCode = 1; return; }
  const fin = await rpcCall(url, "eth_getBlockByNumber", ["finalized", false]);
  if (!fin || !fin.number) { console.error(JSON.stringify({ status: "NO_FINALIZED" })); process.exitCode = 1; return; }
  const block = fin.number;
  const at = (m, p) => rpcCall(url, m, p, 15000).catch(() => null);
  const call = async (to, data) => { const v = await at("eth_call", [{ to, data }, block]); return typeof v === "string" && v !== "0x" ? v : null; };
  const sc = async (to, fn, args) => { const r = await call(to, iface.encodeFunctionData(fn, args)); if (!r) return null; try { return iface.decodeFunctionResult(fn, r); } catch { return null; } };
  const dec = async (t) => { const d = await sc(t, "decimals", []); return d ? Number(d[0]) : null; };

  const result = { schema: "usual-usd0-venues-step1/v1", retrievedAt: new Date().toISOString(), chainId: 1, finalizedBlock: BigInt(block).toString(), usd0: USD0, uniswapV3: [], uniswapV2: [], curve: [] };

  // --- Uniswap V3 discovery ---
  for (const [sym, tok] of Object.entries(TOKENS)) {
    for (const fee of [100, 500, 3000, 10000]) {
      const r = await sc(UNIV3_FACTORY, "getPool", [USD0, tok, fee]);
      const pool = r ? ethers.getAddress(r[0]) : null;
      if (!pool || pool === ethers.ZeroAddress) continue;
      const [t0, t1, liq, s0] = await Promise.all([sc(pool, "token0", []), sc(pool, "token1", []), sc(pool, "liquidity", []), sc(pool, "slot0", [])]);
      if (!t0 || !s0) continue;
      const dec0 = await dec(t0[0]); const dec1 = await dec(t1[0]);
      const sqrtP = s0[0];
      const P = (Number(sqrtP) / 2 ** 96) ** 2; // raw token1/token0
      let usd0Price = null; // USDC/USDT/DAI/WETH per USD0 (exit value if quote token ~ $1)
      if (t0[0].toLowerCase() === USD0.toLowerCase()) usd0Price = P * 10 ** (dec0 - dec1);
      else usd0Price = (1 / P) * 10 ** (dec0 - dec1);
      // QuoterV2 quotes USD0 -> quote token at sizes
      const quotes = [];
      for (const size of ["1", "1000", "100000", "1000000"]) {
        const amt = ethers.parseUnits(size, 18);
        const qr = await call(QUOTER_V2, iface.encodeFunctionData("quoteExactInputSingle", [{ tokenIn: USD0, tokenOut: tok, amountIn: amt, fee, sqrtPriceLimitX96: 0n }]));
        if (qr) { const d = iface.decodeFunctionResult("quoteExactInputSingle", qr); quotes.push({ sizeUsd0: size, outRaw: d[0].toString() }); }
      }
      result.uniswapV3.push({ pair: `USD0/${sym}`, fee, pool, token0: ethers.getAddress(t0[0]), token1: ethers.getAddress(t1[0]), decimals0: dec0, decimals1: dec1, liquidity: liq ? liq[0].toString() : null, spotPriceQuotePerUsd0: usd0Price, quotes });
    }
  }

  // --- Uniswap V2 / Sushi V2 discovery ---
  for (const [fname, fac] of [["uniswapV2", UNIV2_FACTORY], ["sushiV2", SUSHI_FACTORY]]) {
    for (const [sym, tok] of Object.entries(TOKENS)) {
      const r = await sc(fac, "getPair", [USD0, tok]);
      const pair = r ? ethers.getAddress(r[0]) : null;
      if (!pair || pair === ethers.ZeroAddress) continue;
      const [t0, t1, res] = await Promise.all([sc(pair, "token0", []), sc(pair, "token1", []), sc(pair, "getReserves", [])]);
      if (!t0 || !res) continue;
      const dec0 = await dec(t0[0]); const dec1 = await dec(t1[0]);
      const r0 = Number(res[0]); const r1 = Number(res[1]);
      let usd0Price = null;
      if (t0[0].toLowerCase() === USD0.toLowerCase()) usd0Price = (r1 / r0) * 10 ** (dec0 - dec1);
      else usd0Price = (r0 / r1) * 10 ** (dec0 - dec1);
      result.uniswapV2.push({ dex: fname, pair: `USD0/${sym}`, pool: pair, token0: ethers.getAddress(t0[0]), token1: ethers.getAddress(t1[0]), decimals0: dec0, decimals1: dec1, reserve0: r0.toString(), reserve1: r1.toString(), spotPriceQuotePerUsd0: usd0Price });
    }
  }

  // --- Known Curve USD0/USD0++ pool ---
  {
    const names = [];
    for (const i of [0, 1]) { const c = await sc(CURVE_DC_USD0PP, "coins", [i]); names.push(c ? ethers.getAddress(c[0]) : null); }
    const bals = [];
    for (const i of [0, 1]) { const b = await sc(CURVE_DC_USD0PP, "balances", [i]); bals.push(b ? b[0].toString() : null); }
    let dyUsd0To1 = null, dy1ToUsd0 = null;
    try { const a = await sc(CURVE_DC_USD0PP, "get_dy", [0, 1, ethers.parseUnits("1", 18)]); dyUsd0To1 = a ? a[0].toString() : null; } catch {}
    try { const b = await sc(CURVE_DC_USD0PP, "get_dy", [1, 0, ethers.parseUnits("1", 18)]); dy1ToUsd0 = b ? b[0].toString() : null; } catch {}
    result.curve.push({ pool: CURVE_DC_USD0PP, symbol: "USD0/USD0++", coins: names, balances: bals, get_dy_0to1_1e18: dyUsd0To1, get_dy_1to0_1e18: dy1ToUsd0 });
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ status: "OK", finalizedBlock: result.finalizedBlock, v3Pools: result.uniswapV3.length, v2Pools: result.uniswapV2.length, v3: result.uniswapV3.map(p => ({ pair: p.pair, fee: p.fee, pool: p.pool, liquidity: p.liquidity, spotPriceQuotePerUsd0: p.spotPriceQuotePerUsd0, topQuote: p.quotes[p.quotes.length - 1] })), v2: result.uniswapV2, curve: result.curve }, null, 2));
}

main().catch((e) => { console.error(JSON.stringify({ status: "FAIL_CLOSED", error: String(e && e.message || e).slice(0, 160) })); process.exitCode = 1; });
