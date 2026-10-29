#!/usr/bin/env node
// Morpho hgETH DEX exit liquidity monitor.
// Polls Uniswap V3 Factory, V2 Router, and SushiSwap for hgETH pools.
// If liquidity appears, the HF 0.8874 Morpho liquidation becomes executable.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "hgeth-dex-liquidity-watch.json");
const QUIET = process.argv.includes("--quiet");
const TIMEOUT_MS = 15_000;

const HGETH = "0xc824A08dB624942c5E5F330d56530cD1598859fD";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const UNI_V3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const UNI_V3_QUOTER = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const UNI_V2_ROUTER = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";
const SUSHI_V2_ROUTER = "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F";
const FEE_TIERS = [100, 500, 3000, 10000];
const OUTPUT_TOKENS = [WETH, USDC];

const FACTORY_I = new ethers.Interface(["function getPool(address,address,uint24) view returns (address)"]);
const QUOTER_I = new ethers.Interface(["function quoteExactInputSingle((address,address,uint256,uint24,uint160)) returns (uint256,uint160,uint32,uint256)"]);
const V2_I = new ethers.Interface(["function getAmountsOut(uint256,address[]) view returns (uint256[])"]);
const ERC20_I = new ethers.Interface(["function balanceOf(address) view returns (uint256)", "function totalSupply() view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)"]);

function readJson(f, fb = null) { try { if (!fs.existsSync(f)) return fb; return JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { return fb; } }
function asNumber(v) { if (v === null || v === undefined) return null; if (typeof v === "number") return Number.isFinite(v) ? v : null; const n = Number(String(v).replace(/[$,%\s,]/g, "")); return Number.isFinite(n) ? n : null; }
function round(v, d = 6) { const n = asNumber(v); if (n === null) return null; return Math.round(n * 10 ** d) / 10 ** d; }
function loadRpcUrls() { if (!fs.existsSync(RPC_FILE)) return []; return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map(m => m[0]); }
async function rpcCall(url, method, params = [], timeoutMs = TIMEOUT_MS) { const c = new AbortController(); const t = setTimeout(() => c.abort(), timeoutMs); try { const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: c.signal }); const j = await r.json(); if (j.error) throw new Error(j.error.message || JSON.stringify(j.error)); return j.result ?? null; } finally { clearTimeout(t); } }
async function resolveRpcPool(ids) { const p = {}; for (const u of loadRpcUrls()) { try { const h = await rpcCall(u, "eth_chainId", [], 6000); const c = Number(BigInt(h)); if (ids.includes(c) && !p[c]) p[c] = u; } catch (_) {} } return p; }

async function main() {
  const rpcs = await resolveRpcPool([1]);
  const rpcUrl = rpcs[1];
  if (!rpcUrl) { const a = { error: "noEthRpc", routePositive: false }; fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(a, null, 2) + "\n"); if (!QUIET) console.log("No Eth RPC"); return; }
  const provider = new ethers.JsonRpcProvider(rpcUrl, 1, { staticNetwork: true });
  const block = await provider.getBlock("latest");

  const v3Pools = [];
  for (const fee of FEE_TIERS) {
    try {
      const data = FACTORY_I.encodeFunctionData("getPool", [HGETH, WETH, fee]);
      const raw = await provider.call({ to: UNI_V3_FACTORY, data });
      if (!raw || raw === "0x") continue;
      const addr = ethers.AbiCoder.defaultAbiCoder().decode(["address"], raw)[0];
      if (addr !== ethers.ZeroAddress) {
        try {
          const bal = await provider.call({ to: HGETH, data: ERC20_I.encodeFunctionData("balanceOf", [addr]) });
          const liq = Number(ethers.formatUnits(BigInt(bal), 18));
          v3Pools.push({ pool: addr.toLowerCase(), fee, hgethBalance: round(liq, 4) });
        } catch (_) { v3Pools.push({ pool: addr.toLowerCase(), fee }); }
      }
    } catch (_) {}
  }

  const v3Quotes = [];
  for (const pool of v3Pools) {
    for (const out of OUTPUT_TOKENS) {
      try {
        const aIn = ethers.parseEther("1");
        const data = QUOTER_I.encodeFunctionData("quoteExactInputSingle", [{ tokenIn: HGETH, tokenOut: out, amountIn: aIn, fee: pool.fee, sqrtPriceLimitX96: 0n }]);
        const raw = await provider.call({ to: UNI_V3_QUOTER, data });
        const dec = QUOTER_I.decodeFunctionResult("quoteExactInputSingle", raw);
        v3Quotes.push({ direction: "hgETH->" + (out === WETH ? "WETH" : "USDC"), feeBps: pool.fee / 100, amountOut: Number(ethers.formatUnits(dec[0], out === WETH ? 18 : 6)), gasEstimate: Number(dec[3]) });
      } catch (_) {}
    }
  }

  const v2Quotes = [];
  for (const router of [[UNI_V2_ROUTER, "Uniswap V2"], [SUSHI_V2_ROUTER, "Sushi V2"]]) {
    for (const out of OUTPUT_TOKENS) {
      try {
        const data = V2_I.encodeFunctionData("getAmountsOut", [ethers.parseEther("1"), [HGETH, out]]);
        const raw = await provider.call({ to: router[0], data });
        const dec = V2_I.decodeFunctionResult("getAmountsOut", raw);
        v2Quotes.push({ dex: router[1], direction: "hgETH->" + (out === WETH ? "WETH" : "USDC"), amountOut: Number(ethers.formatUnits(dec[0][1], out === WETH ? 18 : 6)) });
      } catch (_) {}
    }
  }

  const hgethSupplyRaw = await provider.call({ to: HGETH, data: ERC20_I.encodeFunctionData("totalSupply", []) }).catch(() => null);
  const hgethSupply = hgethSupplyRaw ? Number(ethers.formatUnits(BigInt(hgethSupplyRaw), 18)) : null;
  const hgethDec = await provider.call({ to: HGETH, data: ERC20_I.encodeFunctionData("decimals", []) }).catch(() => null);
  const hgethSymbol = await provider.call({ to: HGETH, data: ERC20_I.encodeFunctionData("symbol", []) }).catch(() => null);

  const hasLiquidity = v3Quotes.length + v2Quotes.length > 0;
  const bestQuote = [...v3Quotes, ...v2Quotes].sort((a, b) => (b.amountOut || 0) - (a.amountOut || 0))[0] || null;

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/watch-hgeth-dex-liquidity.js",
    scope: "Read-only hgETH DEX exit liquidity watch for Morpho WETH/hgETH liquidation trigger (HF 0.8874)",
    safety: { rpcUrlsStored: false, signedActions: false, routePositive: false, signedActionJustified: false },
    chain: { id: 1, block: block.number },
    hgeth: { address: HGETH, symbol: hgethSymbol ? String(hgethSymbol) : null, decimals: hgethDec ? Number(hgethDec) : null, totalSupply: hgethSupply },
    dexState: { v3PoolsFound: v3Pools.length, v3Quotes: v3Quotes.length, v2Quotes: v2Quotes.length, hasLiquidity, bestQuote, allV3Pools: v3Pools, allV3Quotes: v3Quotes, allV2Quotes: v2Quotes },
    morphoContext: { market: "WETH/hgETH", lastHF: 0.8874, lastDebtUsd: 1477, exitBlocked: !hasLiquidity, exitReason: hasLiquidity ? "DEX pool exists; needs exact position-size quote" : "No hgETH DEX pool on any UniV3/V2/Sushi on Ethereum" },
    summary: { watchCandidates: hasLiquidity ? 1 : 0, routePositive: 0, signedActionJustified: false, closedReason: hasLiquidity ? "hgETH DEX exit found; needs exact position-size quote and fork proof" : "No hgETH DEX liquidity on Ethereum — liquidation cannot exit" },
    requiredForRoutePositive: ["hgETH DEX exit pool exists with material liquidity", "exact position-size exit quote exceeds repay + gas", "Morpho liquidation is profitable", "fork extraction proof"],
    nextReadOnlyStep: hasLiquidity ? "Exact-quote the position-size hgETH exit; fork-proof if positive." : "Re-monitor daily; Morpho liquidation only becomes executable when hgETH gains DEX exit liquidity.",
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");
  if (!QUIET) console.log(`hgETH DEX: v3Pools=${v3Pools.length} v3Quotes=${v3Quotes.length} v2Quotes=${v2Quotes.length} hasLiquidity=${hasLiquidity} best=${bestQuote?.dex || bestQuote?.direction || "none"}@${round(bestQuote?.amountOut, 6)}`);
}

main().catch(e => { console.error(e?.message || String(e)); process.exit(1); });
