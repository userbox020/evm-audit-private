#!/usr/bin/env node
// Read-only BSC Lorenzo sUSD1+ NAV-update supply-route watch scanner.
// Focuses on the supply-and-sell route (public supply() at NAV -> sell on DEX above NAV)
// and watches for narrowing DEX sell spreads or NAV-update timing windows.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "lorenzo-bsc-supply-route-watch.json");
const QUIET = process.argv.includes("--quiet");
const SKIP_RPC_INVENTORY = process.env.LORENZO_SKIP_RPC_INVENTORY === "1";

const BSC_SUSD1PLUS = "0x4F2760B32720F013E900DC92F65480137391199b";
const BSC_QUOTER_V2 = "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997";
const BSC_RPC_CHAIN_ID = 56;
const BSC_PUBLIC_FALLBACKS = ["https://bsc-dataseed.binance.org"];
const TIMEOUT_MS = 15_000;

const USD1 = "0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d";
const USDT = "0x55d398326f99059fF775485246999027B3197955";

const DEX_POOLS = [
  { name: "PancakeSwap V3 sUSD1+/USD1 0.05%", address: "0x479a86165f288C9CE7bB4238258584B259EB5fc7", fee: 500, stable: USD1, stableSymbol: "USD1", stableDecimals: 18 },
  { name: "PancakeSwap V3 sUSD1+/USDT 0.05%", address: "0xd2144852d15331F8551fD310F16fD3c070dBC898", fee: 500, stable: USDT, stableSymbol: "USDT", stableDecimals: 18 },
];

const SELL_AMOUNTS_SUSD = [ethers.parseUnits("100", 18), ethers.parseUnits("500", 18), ethers.parseUnits("1000", 18), ethers.parseUnits("5000", 18)];
const BUY_AMOUNTS_STABLE = [ethers.parseUnits("100", 18), ethers.parseUnits("500", 18), ethers.parseUnits("1000", 18), ethers.parseUnits("5000", 18)];

const VAULT_CALLS = {
  currentUnitNav: "0x4924afaf",
  settlementPeriod: "0x0f1071be",
  paused: "0x5c975abb",
  transferable: "0x92ff0d31",
  totalSupply: "0x18160ddd",
  symbol: "0x95d89b41",
  decimals: "0x313ce567",
  unsettledWithdrawShares: "0x96ffc0f5",
  owner: "0x8da5cb5b",
  minWithdrawAmount: "0x457e1a49",
};

const PARAM_CALLS = {
  periodUnitNav: "0xaea5b21d",
  periodWithdrawShares: "0x48cf1f21",
};

const QUOTER_I = new ethers.Interface([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

const SUPPLY_SELECTOR = "0xf2b9fdb8";

function readJson(file, fallback = null) {
  try { if (!fs.existsSync(file)) return fallback; return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return fallback; }
}

function asNumber(v) { if (v === null || v === undefined) return null; if (typeof v === "number") return Number.isFinite(v) ? v : null; const n = Number(String(v).replace(/[$,%\s,]/g, "")); return Number.isFinite(n) ? n : null; }
function round(v, d = 6) { const n = asNumber(v); if (n === null) return null; return Math.round(n * 10 ** d) / 10 ** d; }
function bps(a, b) { const x = asNumber(a), y = asNumber(b); if (!x || !y) return null; return ((x - y) / y) * 10000; }

function loadRpcUrls() { if (SKIP_RPC_INVENTORY || !fs.existsSync(RPC_FILE)) return []; return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map(m => m[0]); }

async function rpcCall(url, method, params = [], timeoutMs = TIMEOUT_MS) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try { const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: ctrl.signal }); const j = await r.json(); if (j.error) throw new Error(j.error.message || JSON.stringify(j.error)); return j.result ?? null; } finally { clearTimeout(t); }
}

async function resolveBscRpc() {
  for (const url of [...loadRpcUrls(), ...BSC_PUBLIC_FALLBACKS]) {
    try { const idHex = await rpcCall(url, "eth_chainId", [], 6000); if (Number(BigInt(idHex)) === BSC_RPC_CHAIN_ID) return url; } catch (_) {}
  }
  return null;
}

async function callVault(provider, selector, format = "uint256") {
  try { const raw = await provider.call({ to: BSC_SUSD1PLUS, data: selector }); if (!raw || raw === "0x") return null; if (format === "uint256") return BigInt(raw); if (format === "bool") return Boolean(BigInt(raw)); if (format === "address") return ethers.AbiCoder.defaultAbiCoder().decode(["address"], raw)[0]; if (format === "string") { try { return ethers.AbiCoder.defaultAbiCoder().decode(["string"], raw)[0]; } catch (_) { return Buffer.from(raw.slice(2), "hex").toString("utf8").replace(/\0+$/g, "") || null; } } return raw; } catch (_) { return null; }
}

async function callParam(provider, period, selector) {
  const data = selector + ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [period]).slice(2);
  try { const raw = await provider.call({ to: BSC_SUSD1PLUS, data }); if (!raw || raw === "0x") return null; return BigInt(raw); } catch (_) { return null; }
}

async function quoteExactInput(provider, tokenIn, tokenOut, amountIn, fee) {
  try {
    const data = QUOTER_I.encodeFunctionData("quoteExactInputSingle", [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }]);
    const raw = await provider.call({ to: BSC_QUOTER_V2, data });
    return QUOTER_I.decodeFunctionResult("quoteExactInputSingle", raw);
  } catch (_) { return null; }
}

async function hasSelector(provider) {
  try {
    const implSlot = await provider.getStorage(BSC_SUSD1PLUS, "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc");
    const impl = ethers.AbiCoder.defaultAbiCoder().decode(["address"], implSlot)[0];
    const code = await provider.getCode(impl);
    return code.includes(SUPPLY_SELECTOR.slice(2));
  } catch (_) {
    try {
      const code = await provider.getCode(BSC_SUSD1PLUS);
      return code.includes(SUPPLY_SELECTOR.slice(2));
    } catch (__) { return false; }
  }
}

async function main() {
  const rpcUrl = await resolveBscRpc();
  if (!rpcUrl) { const a = { error: "noBscRpc", routePositive: false }; fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(a, null, 2) + "\n"); if (!QUIET) console.log("No BSC RPC available"); return; }

  const provider = new ethers.JsonRpcProvider(rpcUrl, BSC_RPC_CHAIN_ID, { staticNetwork: true });

  const currentUnitNavRaw = await callVault(provider, VAULT_CALLS.currentUnitNav);
  const settlementPeriod = await callVault(provider, VAULT_CALLS.settlementPeriod);
  const paused = await callVault(provider, VAULT_CALLS.paused, "bool");
  const transferable = await callVault(provider, VAULT_CALLS.transferable, "bool");
  const supplySelectable = await hasSelector(provider);
  const unsettledWithdrawSharesRaw = await callVault(provider, VAULT_CALLS.unsettledWithdrawShares);

  const nav = currentUnitNavRaw ? Number(currentUnitNavRaw) / 1e18 : null;
  const period = settlementPeriod ? Number(settlementPeriod) : null;
  const unsettledShares = unsettledWithdrawSharesRaw ? Number(unsettledWithdrawSharesRaw) / 1e18 : 0;

  const prevPeriodNavRaw = period !== null && period > 57 ? await callParam(provider, period - 1, PARAM_CALLS.periodUnitNav) : null;
  const prevPeriodNav = prevPeriodNavRaw ? Number(prevPeriodNavRaw) / 1e18 : null;
  const nextPeriodNavRaw = period !== null ? await callParam(provider, period + 1, PARAM_CALLS.periodUnitNav) : null;
  const nextPeriodNav = nextPeriodNavRaw ? Number(nextPeriodNavRaw) / 1e18 : null;

  const prevPeriodWithdrawRaw = period !== null && period > 57 ? await callParam(provider, period - 1, PARAM_CALLS.periodWithdrawShares) : null;
  const currentPeriodWithdrawRaw = period !== null ? await callParam(provider, period, PARAM_CALLS.periodWithdrawShares) : null;
  const prevWithdraw = prevPeriodWithdrawRaw ? Number(prevPeriodWithdrawRaw) / 1e18 : 0;
  const currWithdraw = currentPeriodWithdrawRaw ? Number(currentPeriodWithdrawRaw) / 1e18 : 0;

  const sellQuotes = [];
  const buyQuotes = [];

  for (const pool of DEX_POOLS) {
    for (const amount of SELL_AMOUNTS_SUSD) {
      const q = await quoteExactInput(provider, BSC_SUSD1PLUS, pool.stable, amount, pool.fee);
      if (!q) continue;
      const amountOut = Number(ethers.formatUnits(q[0], pool.stableDecimals));
      const amountIn = Number(ethers.formatUnits(amount, 18));
      const navValue = nav ? amountIn * nav : null;
      const grossEdgeUsd = navValue ? amountOut - navValue : null;
      const grossEdgeBps = navValue ? ((amountOut - navValue) / navValue) * 10000 : null;
      sellQuotes.push({
        direction: "sell",
        pool: pool.name,
        stableSymbol: pool.stableSymbol,
        amountInSusd: round(amountIn, 4),
        amountOutStable: round(amountOut, 6),
        navExitValue: round(navValue, 6),
        grossEdgeUsd: round(grossEdgeUsd, 6),
        grossEdgeBps: round(grossEdgeBps, 2),
        gasEstimate: Number(q[3]),
        initializedTicksCrossed: Number(q[2]),
      });
    }

    for (const amount of BUY_AMOUNTS_STABLE) {
      const q = await quoteExactInput(provider, pool.stable, BSC_SUSD1PLUS, amount, pool.fee);
      if (!q) continue;
      const amountOut = Number(ethers.formatUnits(q[0], 18));
      const amountIn = Number(ethers.formatUnits(amount, pool.stableDecimals));
      const navExitValue = nav ? amountOut * nav : null;
      const grossEdgeUsd = navExitValue ? navExitValue - amountIn : null;
      const grossEdgeBps = navExitValue ? ((navExitValue - amountIn) / amountIn) * 10000 : null;
      buyQuotes.push({
        direction: "buy",
        pool: pool.name,
        stableSymbol: pool.stableSymbol,
        stableIn: round(amountIn, 4),
        amountOutSusd: round(amountOut, 6),
        navExitValue: round(navExitValue, 6),
        grossEdgeUsd: round(grossEdgeUsd, 6),
        grossEdgeBps: round(grossEdgeBps, 2),
        gasEstimate: Number(q[3]),
        initializedTicksCrossed: Number(q[2]),
      });
    }
  }

  sellQuotes.sort((a, b) => (b.grossEdgeBps || -Infinity) - (a.grossEdgeBps || -Infinity));
  buyQuotes.sort((a, b) => (b.grossEdgeBps || -Infinity) - (a.grossEdgeBps || -Infinity));

  const bestSell = sellQuotes[0] || null;
  const bestBuy = buyQuotes[0] || null;

  const navDeltaBps = prevPeriodNav && nav ? bps(nav, prevPeriodNav) : null;
  const navPendingUpward = nextPeriodNav && nav ? (nextPeriodNav > nav ? bps(nextPeriodNav, nav) : null) : null;
  const navTimingWindow = navPendingUpward !== null && navPendingUpward > 0 && supplySelectable && !paused;

  const sellRoutePositive = bestSell && (bestSell.grossEdgeUsd || 0) > 0 && supplySelectable && !paused && transferable !== false;
  const buyErc4626ExitPresent = false; // Proven missing by prior scanner (no asset/totalAssets/convertToAssets)
  const buyQueuePresent = unsettledShares > 0 || currWithdraw > 0 || prevWithdraw > 0;
  const buyExitUnblocked = buyErc4626ExitPresent && !buyQueuePresent;
  const buyRoutePositive = bestBuy && (bestBuy.grossEdgeUsd || 0) > 0 && buyExitUnblocked && !paused && transferable !== false;

  const watchCandidates = [];
  if (navTimingWindow) watchCandidates.push({ type: "nav-update-timing", period, nav, prevPeriodNav, nextPeriodNav, navDeltaBps: round(navDeltaBps, 2), navPendingUpwardBps: round(navPendingUpward, 2) });
  if (bestSell && (bestSell.grossEdgeBps || 0) > -50) watchCandidates.push({ type: "sell-spread-narrowing", ...bestSell });

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/watch-lorenzo-nav-supply.js",
    scope: "Read-only BSC Lorenzo sUSD1+ supply-route NAV-update watch scanner",
    safety: { rpcInventorySkipped: SKIP_RPC_INVENTORY, rpcInventoryRead: !SKIP_RPC_INVENTORY, publicFallbackRpcAllowed: true, rpcUrlsStored: false, signedActions: false, exploitExecuteCalls: false, routePositive: sellRoutePositive || buyRoutePositive, signedActionJustified: false },
    chain: { id: BSC_RPC_CHAIN_ID, name: "BSC" },
    vault: { address: BSC_SUSD1PLUS, paused, transferable, supplySelectable, selectorProbed: SUPPLY_SELECTOR },
    navState: { currentNav: round(nav, 8), settlementPeriod: period, prevPeriodNav: round(prevPeriodNav, 8), nextPeriodNav: round(nextPeriodNav, 8), navDeltaVsPrevBps: round(navDeltaBps, 2), navPendingUpwardBps: round(navPendingUpward, 2), navTimingWindow },
    queueState: { unsettledWithdrawShares: round(unsettledShares, 4), prevPeriodWithdrawShares: round(prevWithdraw, 4), currentPeriodWithdrawShares: round(currWithdraw, 4), queuedUsd1Value: round(unsettledShares * (nav || 1), 2) },
    quotes: { sellQuotes: sellQuotes.slice(0, 10), buyQuotes: buyQuotes.slice(0, 10), bestSell, bestBuy },
    summary: {
      sellRoutePositive, buyRoutePositive, watchCandidates: watchCandidates.length, routePositive: (sellRoutePositive || buyRoutePositive) ? 1 : 0, signedActionJustified: false,
      closedReason: navTimingWindow ? "NAV-update timing window detected but exact supply-sell economics are not proven positive after gas/fees" : bestSell && (bestSell.grossEdgeBps || 0) > -35 ? "Sell spread narrowing toward breakeven but NAV update timing not yet favorable" : "Supply-and-sell route below breakeven; inverse buy route blocked by same-epoch exit constraint",
    },
    watchCandidates,
    requiredForRoutePositive: ["supply() is public/unpaused and NAV update is pending with positive delta", "exact DEX sell quote is positive after NAV uplift and gas/fees", "fork extraction proof"],
    nextReadOnlyStep: navTimingWindow ? "Verify exact supply-sell economics at current DEX price; fork-proof only if net-positive." : "Keep BSC Lorenzo on fast watch; reopen if NAV delta narrows supply-sell spread or DEX sell price crosses NAV + gas.",
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");

  if (!QUIET) {
    console.log(`Lorenzo BSC: nav=${round(nav, 6)} period=${period} supplyPublic=${supplySelectable} paused=${paused}`);
    console.log(`  sell best: ${bestSell?.pool || "none"} ${bestSell?.stableSymbol || ""} edgeBps=${round(bestSell?.grossEdgeBps, 2)} sellPos=${sellRoutePositive}`);
    console.log(`  buy  best: ${bestBuy?.pool || "none"} ${bestBuy?.stableSymbol || ""} edgeBps=${round(bestBuy?.grossEdgeBps, 2)} buyPos=${buyRoutePositive}`);
    if (navTimingWindow) console.log(`  NAV timing: prev=${round(prevPeriodNav, 8)} curr=${round(nav, 8)} next=${round(nextPeriodNav, 8)} delta=${round(navDeltaBps, 2)}bps pendingUp=${round(navPendingUpward, 2)}bps`);
  }
}

main().catch(e => { console.error(e?.message || String(e)); process.exit(1); });
