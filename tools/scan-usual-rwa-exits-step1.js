#!/usr/bin/env node
"use strict";
// Read-only exit-venue discovery for RWA collateral returned by DaoCollateral.redeem.
// Pinned finalized block; endpoint material process-only; no signing/transactions.
const fs = require("fs");
const path = require("path");
const { ethers } = require("./node_modules/ethers");
const { resolveRpc, rpcCall } = require("./shared-rpc.js");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "reports/raw/fast/usual-rwa-exits-step1.json");

const RWA = {
  USYC: "0x136471a34f6ef19fE571EFFC1CA711fdb8E49f2b",
  USUALM: "0x4Cbc25559DbBD1272EC5B64c7b5F48a2405e6470",
  EUSD04: "0xd001f0a15D272542687b2677BA627f48A4333b5d",
  USUALUSDTB: "0x58073531a2809744D1bF311D30FD76B27D662abB",
  USUALUSDC: "0xb672B3976bAa3952bFb2eCE8eeFB784f8daB1424",
  USTBL: "0xe4880249745eAc5F1eD9d8F7DF844792D560e750",
  U0R: "0xFE7C47895eDb12a990b311Df33B90Cfea1D44c24",
};
const QUOTE = {
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  DAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
};
const UNIV3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const CURVE_REGISTRY = "0x90E00ACe148ca3b23Ac1bC8C240C2a7Dd9c2d7f5";
const CURVE_ADDR_PROVIDER = "0x0000000022D53366457F9d5E68Ec105046FC4383";

const iface = new ethers.Interface([
  "function getPool(address,address,uint24) view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function liquidity() view returns (uint128)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function find_pool_for_coins(address,address) view returns (address)",
  "function get_address(uint256) view returns (address)",
  "function coins(uint256) view returns (address)",
  "function balances(uint256) view returns (uint256)",
  "function get_dy(int128,int128,uint256) view returns (uint256)",
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);

async function main() {
  const url = await resolveRpc(1);
  if (!url) { console.error(JSON.stringify({ status: "NO_RPC" })); process.exitCode = 1; return; }
  const fin = await rpcCall(url, "eth_getBlockByNumber", ["finalized", false]);
  const block = fin.number;
  const at = (m, p) => rpcCall(url, m, p, 15000).catch(() => null);
  const call = async (to, data) => { const v = await at("eth_call", [{ to, data }, block]); return typeof v === "string" && v !== "0x" ? v : null; };
  const sc = async (to, fn, args) => { const r = await call(to, iface.encodeFunctionData(fn, args)); if (!r) return null; try { return iface.decodeFunctionResult(fn, r); } catch { return null; } };
  const dec = async (t) => { const d = await sc(t, "decimals", []); return d ? Number(d[0]) : null; };

  const out = { schema: "usual-rwa-exits-step1/v1", retrievedAt: new Date().toISOString(), chainId: 1, finalizedBlock: BigInt(block).toString(), rwa: [], curveUsd0Pools: [] };

  // Curve pools involving USD0 via main registry lookups
  const USD0 = "0x73A15FeD60Bf67631dC6cd7Bc5B6e8da8190aCF5";
  for (const [sym, q] of Object.entries({ USDC: QUOTE.USDC, USDT: QUOTE.USDT, DAI: QUOTE.DAI })) {
    const r = await sc(CURVE_REGISTRY, "find_pool_for_coins", [USD0, q]);
    const p = r ? r[0] : null;
    if (p && p !== ethers.ZeroAddress) {
      const coins = []; const bals = [];
      for (const i of [0, 1]) { const c = await sc(p, "coins", [i]); coins.push(c ? ethers.getAddress(c[0]) : null); }
      for (const i of [0, 1]) { const b = await sc(p, "balances", [i]); bals.push(b ? b[0].toString() : null); }
      out.curveUsd0Pools.push({ quote: sym, pool: ethers.getAddress(p), coins, balances: bals });
    } else {
      out.curveUsd0Pools.push({ quote: sym, pool: null });
    }
  }

  // RWA exit discovery: V3 pools vs USDC/USDT/DAI
  for (const [sym, tok] of Object.entries(RWA)) {
    const entry = { symbol: sym, token: tok, decimals: await dec(tok), v3: [] };
    for (const [qsym, q] of Object.entries(QUOTE)) {
      for (const fee of [100, 500, 3000, 10000]) {
        const r = await sc(UNIV3_FACTORY, "getPool", [tok, q, fee]);
        const pool = r ? ethers.getAddress(r[0]) : null;
        if (!pool || pool === ethers.ZeroAddress) continue;
        const [liq] = [await sc(pool, "liquidity", [])];
        const liquidity = liq ? liq[0].toString() : null;
        // quote selling 1000 RWA units -> quote token
        const amt = ethers.parseUnits("1000", entry.decimals || 18);
        const qr = await call(QUOTER_V2, iface.encodeFunctionData("quoteExactInputSingle", [{ tokenIn: tok, tokenOut: q, amountIn: amt, fee, sqrtPriceLimitX96: 0n }]));
        let out1k = null;
        if (qr) { const d = iface.decodeFunctionResult("quoteExactInputSingle", qr); out1k = d[0].toString(); }
        entry.v3.push({ quote: qsym, fee, pool, liquidity, sell1000Out: out1k });
      }
    }
    out.rwa.push(entry);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify({ status: "OK", finalizedBlock: out.finalizedBlock, curveUsd0Pools: out.curveUsd0Pools, rwa: out.rwa.map(r => ({ symbol: r.symbol, decimals: r.decimals, pools: r.v3.filter(x => x.liquidity && x.liquidity !== "0").map(x => ({ quote: x.quote, fee: x.fee, pool: x.pool, liquidity: x.liquidity, sell1000Out: x.sell1000Out })) })) }, null, 2));
}

main().catch((e) => { console.error(JSON.stringify({ status: "FAIL_CLOSED", error: String(e && e.message || e).slice(0, 160) })); process.exitCode = 1; });
