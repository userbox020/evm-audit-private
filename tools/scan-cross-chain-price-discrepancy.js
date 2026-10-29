#!/usr/bin/env node
// Cross-chain Chainlink feed price discrepancy scanner.
// Queries same token feeds across chains, flags gaps > threshold.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "cross-chain-price-discrepancy.json");
const QUIET = process.argv.includes("--quiet");
const TIMEOUT_MS = 15_000;
const DISCREPANCY_THRESHOLD_BPS = 50;

const CHAIN_FEEDS = {
  ETH_USD: {
    1: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
    42161: "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612",
    8453: "0x71041dddad3595F9CEd3DcCBe3D617386023750a",
    10: "0x13e3Ee699D1909E989722E753853AE30b17e08c5",
    56: "0x9ef1B8c0E4F7dc8bF5719Ea496883DC6401d0b79",
  },
  BTC_USD: {
    1: "0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c",
    42161: "0x6ce185860a4963106506C203335A2910413708e9",
    8453: "0x619ab19F0eae6F1ec5C4FBe5F6cFe5b806A029E2",
    10: "0xD702DD976Fb76Fffc2D3963D037dfDae5b04E593",
    56: "0x264990fbd0A4796A3E3d8E37C4D5F87a3aCa5Ebf",
  },
  USDC_USD: {
    1: "0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6",
    42161: "0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3",
    8453: "0x7e860098F58bBFC8648a4311be72562AeD2A8D04",
    10: "0x16a9FA2FDa030272Ce99B29CF780dFA30361E0f3",
    56: "0x51597f405303C4377E36123cBc172b13269EA163",
  },
  USDT_USD: {
    1: "0x3E7d1eAB13ad0104d2750B8863b489D65364e32D",
    42161: "0x3f3f5dF88dC9F13eac63DF89EC16ef6e7E633D0a",
    8453: "0xf19d560eB8d2ADf07BD6D13ed03e1D11215721F9",
  },
  DAI_USD: {
    1: "0xAed0c38402a5d19df6E4c03F4E2DceD6e29c1ee9",
    42161: "0xc5C8E77B397E531B8eC06BFb0048328B30E9eB0c",
    56: "0x132d3C0B1D2cEa0BC552588063bdBb210FDeecfA",
  },
  LINK_USD: {
    1: "0x2c1d072e956AFFC0D435Cb7AC38EF18d24d9127c",
    42161: "0x86E53CF1B870786351Da77A57575e79CB55812CB",
    10: "0xCc232dcFAAE6354cE191Bd574108c1aD03f86450",
    56: "0xca236E327F629f9Fc2c30A4E95775EbF0B89fac8",
  },
  ARB_USD: {
    42161: "0xb2A824043730FE05FEd3F08403fa979d1867Cc46",
  },
  OP_USD: {
    10: "0x0D276FC14719f9292D5C1eA2198673d1f4269246",
  },
};

const CHAIN_NAMES = { 1: "Ethereum", 42161: "Arbitrum", 8453: "Base", 10: "Optimism", 56: "BNB" };

const FEED_IFACE = new ethers.Interface([
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  "function decimals() view returns (uint8)",
]);

function readJson(f, fb = null) { try { if (!fs.existsSync(f)) return fb; return JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { return fb; } }
function asNumber(v) { if (v === null || v === undefined) return null; if (typeof v === "number") return Number.isFinite(v) ? v : null; const n = Number(String(v).replace(/[$,%\s,]/g, "")); return Number.isFinite(n) ? n : null; }
function round(v, d = 2) { const n = asNumber(v); if (n === null) return null; return Math.round(n * 10 ** d) / 10 ** d; }
function bps(a, b) { const x = asNumber(a), y = asNumber(b); if (!x || !y) return null; return ((x - y) / y) * 10000; }
function loadRpcUrls() { if (!fs.existsSync(RPC_FILE)) return []; return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map(m => m[0]); }
async function rpcCall(url, method, params = [], timeoutMs = TIMEOUT_MS) { const c = new AbortController(); const t = setTimeout(() => c.abort(), timeoutMs); try { const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: c.signal }); const j = await r.json(); if (j.error) throw new Error(j.error.message || JSON.stringify(j.error)); return j.result ?? null; } finally { clearTimeout(t); } }
async function resolveRpcPool(ids) { const p = {}; for (const u of loadRpcUrls()) { try { const h = await rpcCall(u, "eth_chainId", [], 6000); const c = Number(BigInt(h)); if (ids.includes(c) && !p[c]) p[c] = u; } catch (_) {} } return p; }

async function main() {
  const chainIds = [...new Set(Object.values(CHAIN_FEEDS).flatMap(f => Object.keys(f).map(Number)).filter(c => [1,42161,8453,10,56].includes(c)))];
  const rpcs = await resolveRpcPool(chainIds);
  const providers = {};
  for (const [c, r] of Object.entries(rpcs)) providers[Number(c)] = new ethers.JsonRpcProvider(r, Number(c), { staticNetwork: true });

  const prices = {};
  for (const [pair, feeds] of Object.entries(CHAIN_FEEDS)) {
    prices[pair] = {};
    for (const [chainId, feedAddr] of Object.entries(feeds)) {
      const provider = providers[Number(chainId)];
      if (!provider) { prices[pair][chainId] = { error: "noRpc" }; continue; }
      try {
        const raw = await provider.call({ to: feedAddr, data: FEED_IFACE.encodeFunctionData("latestRoundData", []) });
        if (!raw || raw === "0x") { prices[pair][chainId] = { error: "empty" }; continue; }
        const dec = FEED_IFACE.decodeFunctionResult("latestRoundData", raw);
        const decRaw = await provider.call({ to: feedAddr, data: FEED_IFACE.encodeFunctionData("decimals", []) }).catch(() => null);
        const decimals = decRaw ? Number(BigInt(decRaw)) : 8;
        const block = await provider.getBlock("latest").catch(() => null);
        prices[pair][chainId] = {
          price: Number(ethers.formatUnits(dec[1], decimals)),
          updatedAt: Number(dec[3]),
          age: block ? block.timestamp - Number(dec[3]) : null,
          ageHours: block ? round((block.timestamp - Number(dec[3])) / 3600, 2) : null,
          chain: CHAIN_NAMES[chainId] || chainId,
        };
      } catch (e) {
        prices[pair][chainId] = { error: e?.message?.slice(0, 100) || "err" };
      }
    }
  }

  const discrepancies = [];
  for (const [pair, chainPrices] of Object.entries(prices)) {
    const valid = Object.entries(chainPrices).filter(([, v]) => v.price && !v.error);
    if (valid.length < 2) continue;
    valid.sort((a, b) => (b[1].price || 0) - (a[1].price || 0));
    const high = valid[0];
    const low = valid[valid.length - 1];
    const gapBps = bps(high[1].price, low[1].price);
    if (gapBps !== null && Math.abs(gapBps) >= DISCREPANCY_THRESHOLD_BPS) {
      discrepancies.push({
        pair,
        highChain: CHAIN_NAMES[high[0]] || high[0], highPrice: round(high[1].price, 4), highAge: high[1].ageHours,
        lowChain: CHAIN_NAMES[low[0]] || low[0], lowPrice: round(low[1].price, 4), lowAge: low[1].ageHours,
        gapBps: round(gapBps, 2),
        chainsQueried: valid.length,
      });
    }
  }

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-cross-chain-price-discrepancy.js",
    scope: "Read-only cross-chain Chainlink feed price discrepancy scanner",
    safety: { rpcInventoryRead: true, rpcUrlsStored: false, signedActions: false, routePositive: false, signedActionJustified: false },
    thresholdBps: DISCREPANCY_THRESHOLD_BPS,
    chainsQueried: Object.keys(rpcs).map(Number).filter(c => providers[c]),
    chainsMissingRpc: chainIds.filter(c => !rpcs[c]),
    summary: {
      pairsScanned: Object.keys(CHAIN_FEEDS).length,
      totalFeedsQueried: Object.values(prices).reduce((s, cp) => s + Object.keys(cp).length, 0),
      totalFeedsSuccess: Object.values(prices).reduce((s, cp) => s + Object.values(cp).filter(v => v.price && !v.error).length, 0),
      discrepanciesFound: discrepancies.length,
      watchCandidates: discrepancies.length,
      routePositive: 0,
      signedActionJustified: false,
      closedReason: discrepancies.length ? "Cross-chain price gaps found; needs bridge-route economics" : `All pairs within ${DISCREPANCY_THRESHOLD_BPS}bps across chains`,
    },
    prices,
    discrepancies,
    requiredForRoutePositive: ["cross-chain price gap exceeds bridge cost + DEX spread + gas", "bridge or DEX route is available and permissionless", "exact arbitrage economics positive", "fork extraction proof"],
    nextReadOnlyStep: discrepancies.length ? "Evaluate bridge/DEX economics for gapped pairs; fork-proof only if net-positive." : "Re-scan when market volatility increases.",
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");
  if (!QUIET) {
    console.log(`Cross-chain: pairs=${Object.keys(CHAIN_FEEDS).length} feeds=${artifact.summary.totalFeedsSuccess} discrepancies=${discrepancies.length}`);
    for (const d of discrepancies.slice(0, 5)) console.log(`  ${d.pair} ${d.highChain}=${d.highPrice} vs ${d.lowChain}=${d.lowPrice} gap=${d.gapBps}bps`);
  }
}

main().catch(e => { console.error(e?.message || String(e)); process.exit(1); });
