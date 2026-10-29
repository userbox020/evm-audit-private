#!/usr/bin/env node
// probe-susde-usdtb-donation.js - read-only economics probe for sUSDe Morpho USDtb donation attack.
// Never prints or stores RPC URLs, keys, calldata, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpc, rpcCall } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "susde-usdtb-donation-probe.json");
const REPORT = path.join(WORKSPACE, "reports", "susde-usdtb-donation-probe-triage.md");
const CHAIN_ID = 1;

const ADDR = {
  sUSDe: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497",
  USDe: "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3",
  USDtb: "0xC139190F447e929f090Edeb554D95AbB8b18aC1C",
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  morpho: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
  oracle: "0x67BcC03438D7d71c39343d7AD21cb73Dc19aDB89",
  curvePool: "0xC2921134073151490193AC7369313c8e0b08e1E7",
};

const ERC20 = new ethers.Interface([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const ERC4626 = new ethers.Interface([
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function convertToShares(uint256) view returns (uint256)",
  "function maxDeposit(address) view returns (uint256)",
  "function maxMint(address) view returns (uint256)",
  "function previewDeposit(uint256) view returns (uint256)",
  "function previewMint(uint256) view returns (uint256)",
]);
const MORPHO = new ethers.Interface([
  "function market(bytes32) view returns (tuple(uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee))",
  "function idToMarketParams(bytes32) view returns (tuple(address loanToken,address collateralToken,address oracle,address irm,uint256 lltv))",
]);
const ORACLE_IFACE = new ethers.Interface(["function price() view returns (uint256)"]);
const CURVE_POOL = new ethers.Interface([
  "function get_dy(int128,int128,uint256) view returns (uint256)",
  "function coins(uint256) view returns (address)",
  "function balances(uint256) view returns (uint256)",
]);

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function normalizeAddress(value) { try { return ethers.getAddress(String(value || "")); } catch (_) { return null; } }

async function safeCall(rpc, to, iface, fn, args = [], timeoutMs = 12_000) {
  const addr = normalizeAddress(to);
  if (!rpc || !addr) return null;
  try {
    const raw = await rpcCall(rpc, "eth_call", [{ to: addr, data: iface.encodeFunctionData(fn, args) }, "latest"], timeoutMs);
    if (!raw || raw === "0x") return null;
    return iface.decodeFunctionResult(fn, raw);
  } catch (_) { return null; }
}

async function getCode(rpc, address) {
  const addr = normalizeAddress(address);
  if (!rpc || !addr) return "0x";
  return await rpcCall(rpc, "eth_getCode", [addr, "latest"], 10_000).catch(() => "0x") || "0x";
}

async function fetchJson(url, timeoutMs = 30_000) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "user-agent": "evm-audit/1.0" } });
    return res.ok ? await res.json() : null;
  } catch (_) { return null; } finally { clearTimeout(t); }
}

function roundBps(value) { return Math.round(value * 10000) / 10000; }
function formatUsd(value) { return `$${Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })}`; }

// Model the donation attack economics
function modelDonationAttack(totalAssets, totalSupply, lltv, maxBorrowCash, donationPct, curveLiquidityUsd) {
  const R = totalAssets / totalSupply; // current exchange rate
  const donation = totalAssets * donationPct / 100;
  const newTotalAssets = totalAssets + donation;
  const Rnew = newTotalAssets / totalSupply; // inflated exchange rate

  // Attacker: for each share supplied, can borrow Rnew * LLTV
  // Cost to acquire S shares: deposit S * R USDe (but attacker already holds them after minting)
  // Actually: attacker flash-loans USDe, deposits to get shares, then donates additional
  // Flash loan repayment = S * R + donation (the total USDe spent)
  // Borrowable value = S * Rnew * LLTV
  // Net = S * Rnew * LLTV - (S * R + donation)

  // For optimization: we need S sufficient that borrow doesn't exceed maxBorrowCash
  // Max S based on borrow cap: S * Rnew * LLTV <= maxBorrowCash
  // S <= maxBorrowCash / (Rnew * LLTV)

  const maxShares = Math.floor(maxBorrowCash / (Rnew * lltv));
  const shares = maxShares; // Use max possible for maximum profit

  const costUsde = shares * R + donation; // total USDe spent
  const borrowUsdtb = shares * Rnew * lltv; // USDtb borrowed
  const borrowUsdtbCapped = Math.min(borrowUsdtb, maxBorrowCash);

  // Curve exit: swap USDtb -> USDC at near-peg rate (assume 1:1 less slippage)
  const slippageBps = (borrowUsdtbCapped / curveLiquidityUsd) * 10000; // basic slippage estimate
  const usdcOut = borrowUsdtbCapped * (1 - slippageBps / 10000);
  const usdeIn = usdcOut; // assume 1:1 USDC->USDe swap (approximation)

  const netUsd = usdeIn - costUsde;
  const netPct = costUsde > 0 ? (netUsd / costUsde) * 100 : 0;

  return {
    donationPct,
    donation,
    R,
    Rnew,
    inflationPct: ((Rnew / R) - 1) * 100,
    shares,
    costUsde,
    borrowUsdtb,
    borrowUsdtbCapped,
    slippageBps: roundBps(slippageBps),
    usdcOut,
    usdeIn,
    netUsd: roundBps(netUsd),
    netPct: roundBps(netPct),
    routePositive: netUsd > 0,
  };
}

async function main() {
  const rpc = await resolveRpc(CHAIN_ID);
  if (!rpc) throw new Error("No RPC for chain 1");

  // Read live state
  const [totalAssetsRaw, totalSupplyRaw, maxDepositRaw, decimalsRaw] = await Promise.all([
    safeCall(rpc, ADDR.sUSDe, ERC4626, "totalAssets"),
    safeCall(rpc, ADDR.sUSDe, ERC20, "totalSupply"),
    safeCall(rpc, ADDR.sUSDe, ERC4626, "maxDeposit", [ADDR.sUSDe]),
    safeCall(rpc, ADDR.sUSDe, ERC20, "decimals"),
  ]);

  const decimals = decimalsRaw ? Number(decimalsRaw[0]) : 18;
  const totalAssets = totalAssetsRaw ? Number(ethers.formatUnits(totalAssetsRaw[0], decimals)) : 0;
  const totalSupply = totalSupplyRaw ? Number(ethers.formatUnits(totalSupplyRaw[0], decimals)) : 0;
  const maxDeposit = maxDepositRaw ? maxDepositRaw[0].toString() : "0";

  // Morpho market state
  const marketId = "0x88a18b2f4d94e7ad27a381b15531c06abf05a7c99dd5d3c3679875fed6f7e742";
  const marketState = await safeCall(rpc, ADDR.morpho, MORPHO, "market", [marketId]);
  const borrowAssets = marketState ? Number(ethers.formatUnits(marketState[0][2], 18)) : 0;
  const supplyAssets = marketState ? Number(ethers.formatUnits(marketState[0][0], 18)) : 0;
  const marketParams = await safeCall(rpc, ADDR.morpho, MORPHO, "idToMarketParams", [marketId]);
  const lltv = marketParams ? Number(marketParams[0][4]) / 1e18 : 0;
  const maxBorrowCash = borrowAssets; // all borrow assets are cash available

  // Oracle
  const oraclePriceRaw = await safeCall(rpc, ADDR.oracle, ORACLE_IFACE, "price");
  const oraclePrice = oraclePriceRaw ? Number(ethers.formatUnits(oraclePriceRaw[0], 36)) : 0;

  // Curve pool
  const curveData = await Promise.all([
    safeCall(rpc, ADDR.curvePool, CURVE_POOL, "coins", [0]),
    safeCall(rpc, ADDR.curvePool, CURVE_POOL, "coins", [1]),
    safeCall(rpc, ADDR.curvePool, CURVE_POOL, "balances", [0]),
    safeCall(rpc, ADDR.curvePool, CURVE_POOL, "balances", [1]),
  ]);
  const coin0 = curveData[0] ? normalizeAddress(curveData[0][0]) : null;
  const coin1 = curveData[1] ? normalizeAddress(curveData[1][0]) : null;
  const usdtbIdx = coin0?.toLowerCase() === ADDR.USDtb.toLowerCase() ? 0 : 1;
  const usdcIdx = usdtbIdx === 0 ? 1 : 0;
  const usdcDecRaw2 = await safeCall(rpc, ADDR.USDC, ERC20, "decimals");
  const usdcDec = usdcDecRaw2 ? Number(usdcDecRaw2[0]) : 6;
  const balanceUSDC = curveData[2 + usdcIdx] ? Number(ethers.formatUnits(curveData[2 + usdcIdx][0], usdcDec)) : 0;

  // Market state check
  const sUSDeCode = await getCode(rpc, ADDR.sUSDe);
  const oracleCode = await getCode(rpc, ADDR.oracle);

  // Prices
  const prices = await fetchJson(`https://coins.llama.fi/prices/current/ethereum:${ADDR.USDe.toLowerCase()},ethereum:${ADDR.USDC.toLowerCase()},ethereum:${ADDR.USDtb.toLowerCase()}`, 30_000).catch(() => ({}));
  const usdePrice = prices?.coins?.[`ethereum:${ADDR.USDe.toLowerCase()}`]?.price || 1;
  const usdcPrice = prices?.coins?.[`ethereum:${ADDR.USDC.toLowerCase()}`]?.price || 1;

  // Model attack at various donation percentages
  const results = [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 25].map(pct =>
    modelDonationAttack(totalAssets, totalSupply, lltv, maxBorrowCash, pct, balanceUSDC)
  );

  const bestResult = results.reduce((best, r) => r.netUsd > (best?.netUsd || -Infinity) ? r : best, results[0]);

  const output = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/probe-susde-usdtb-donation.js",
    scope: "sUSDe Morpho USDtb donation-attack read-only economics",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
    },
    liveState: {
      sUSDe: {
        address: ADDR.sUSDe,
        totalAssets,
        totalSupply,
        totalAssetsUsd: roundBps(totalAssets * usdePrice),
        exchangeRate: roundBps(totalAssets / totalSupply),
        maxDeposit,
        maxDepositIsZero: maxDeposit === "0",
        codePresent: sUSDeCode !== "0x",
        codeBytes: Math.max(0, (sUSDeCode.length - 2) / 2),
      },
      morpho: {
        marketId,
        borrowAssets,
        borrowAssetsUsd: roundBps(borrowAssets * usdcPrice),
        supplyAssets,
        supplyAssetsUsd: roundBps(supplyAssets * usdePrice),
        lltv,
        lltvPct: roundBps(lltv * 100),
        maxBorrowCashUsd: roundBps(maxBorrowCash * usdcPrice),
      },
      oracle: {
        address: ADDR.oracle,
        codePresent: oracleCode !== "0x",
        codeBytes: Math.max(0, (oracleCode.length - 2) / 2),
        price: roundBps(oraclePrice),
        priceUsd: roundBps(oraclePrice),
      },
      curvePool: {
        address: ADDR.curvePool,
        usdtbBalance: roundBps(curveData[2 + usdtbIdx] ? Number(ethers.formatUnits(curveData[2 + usdtbIdx][0], 18)) : 0),
        usdcBalance: roundBps(balanceUSDC),
        usdcBalanceUsd: roundBps(balanceUSDC * usdcPrice),
      },
      prices: { usde: roundBps(usdePrice, 8), usdc: roundBps(usdcPrice, 8) },
    },
    donationModel: {
      results: results.map(r => ({
        donationPct: roundBps(r.donationPct),
        donationUsde: roundBps(r.donation),
        donationUsd: roundBps(r.donation * usdePrice),
        inflationPct: roundBps(r.inflationPct, 6),
        maxShares: Math.floor(r.shares),
        costUsde: roundBps(r.costUsde),
        costUsd: roundBps(r.costUsde * usdePrice),
        borrowUsdtb: roundBps(r.borrowUsdtbCapped),
        borrowUsd: roundBps(r.borrowUsdtbCapped * usdcPrice),
        slippageBps: r.slippageBps,
        usdcOut: roundBps(r.usdcOut),
        netUsd: r.netUsd,
        netPct: r.netPct,
        routePositive: r.routePositive,
      })),
      best: bestResult ? {
        donationPct: roundBps(bestResult.donationPct),
        donationUsd: roundBps(bestResult.donation * usdePrice),
        borrowUsd: roundBps(bestResult.borrowUsdtbCapped * usdcPrice),
        netUsd: bestResult.netUsd,
        routePositive: bestResult.routePositive,
      } : null,
    },
    blockers: [],
  };

  // Run exact Curve quote for best result
  if (bestResult && bestResult.borrowUsdtbCapped > 0) {
    const borrowRaw = ethers.parseUnits(bestResult.borrowUsdtbCapped.toFixed(6), 18);
    try {
      const dyRaw = await safeCall(rpc, ADDR.curvePool, CURVE_POOL, "get_dy", [usdtbIdx, usdcIdx, borrowRaw]);
      if (dyRaw) {
        const usdcOutExact = Number(ethers.formatUnits(dyRaw[0], usdcDec));
        const netExact = usdcOutExact - bestResult.costUsde;
        output.donationModel.exactCurveQuote = {
          usdtbIn: roundBps(bestResult.borrowUsdtbCapped),
          usdcOut: roundBps(usdcOutExact),
          usdcOutUsd: roundBps(usdcOutExact * usdcPrice),
          netUsd: roundBps(netExact),
          routePositive: netExact > 0,
        };
      }
    } catch (_) {}
  }

  // Blockers assessment
  const blockers = [];
  if (totalAssets <= 0) blockers.push("sUSDe vault has zero totalAssets");
  if (maxDeposit === "0") blockers.push("sUSDe maxDeposit is zero - deposits closed");
  if (maxBorrowCash <= 0) blockers.push("No borrow cash available in Morpho market");
  if (!output.donationModel.exactCurveQuote?.routePositive) blockers.push("Best modeled route is net-negative after Curve swap");
  if (output.liveState.oracle.codeBytes < 100) blockers.push("Oracle contract has minimal code - may not be a real-time price oracle");
  blockers.push("Flash loan fees, gas costs, and MEV not yet modeled");
  blockers.push("No fork test has been executed; live state may differ");
  output.blockers = blockers;
  output.summary = {
    routePositive: output.donationModel.best?.routePositive || output.donationModel.exactCurveQuote?.routePositive || false,
    executableNow: false,
    signedActionJustified: false,
    forkJustified: output.donationModel.best?.routePositive || output.donationModel.exactCurveQuote?.routePositive || false,
    nextStep: output.donationModel.best?.routePositive ? "Build fork test to prove exact extraction" : "Negative economics; close the branch",
  };

  ensureDir(OUT);
  fs.writeFileSync(OUT, `${JSON.stringify(output, jsonReplacer, 2)}\n`);

  // Write report
  const s = output.liveState;
  const lines = [];
  lines.push(`# ${output.donationModel.best?.routePositive ? "🟡 VULNERABLE" : "🟢 DORMANT"} — sUSDe Morpho USDtb Donation Attack Probe`);
  lines.push("");
  lines.push(`Generated: ${output.generatedAt}`);
  lines.push("");
  lines.push("## Live State");
  lines.push("");
  lines.push("| Field | Value |");
  lines.push("|---|---|");
  lines.push(`| sUSDe totalAssets | ${formatUsd(s.sUSDe.totalAssetsUsd)} |`);
  lines.push(`| sUSDe totalSupply | ${s.sUSDe.totalSupply.toLocaleString()} |`);
  lines.push(`| sUSDe exchange rate | ${s.sUSDe.exchangeRate} |`);
  lines.push(`| sUSDe maxDeposit | ${s.sUSDe.maxDeposit} (${s.sUSDe.maxDepositIsZero ? "zero — DEPOSITS CLOSED" : "open"}) |`);
  lines.push(`| Morpho borrow cash | ${formatUsd(s.morpho.borrowAssetsUsd)} USDtb |`);
  lines.push(`| Morpho supply | ${formatUsd(s.morpho.supplyAssetsUsd)} |`);
  lines.push(`| LLTV | ${s.morpho.lltvPct}% |`);
  lines.push(`| Oracle | ${ADDR.oracle} (${s.oracle.codeBytes} bytes) |`);
  lines.push(`| Curve pool USDC | ${formatUsd(s.curvePool.usdcBalanceUsd)} |`);
  lines.push("");
  lines.push("## Donation Attack Model");
  lines.push("");
  lines.push("| Donation % | Donation USD | Inflation % | Borrow USD | Net USD | Positive |");
  lines.push("|---:|---:|---:|---:|---:|---:|");
  for (const r of (output.donationModel.results || []).slice(0, 9)) {
    lines.push(`| ${r.donationPct}% | ${formatUsd(r.donationUsd)} | ${r.inflationPct}% | ${formatUsd(r.borrowUsd)} | ${formatUsd(r.netUsd)} | ${r.routePositive} |`);
  }
  if (output.donationModel.exactCurveQuote) {
    const eq = output.donationModel.exactCurveQuote;
    lines.push("");
    lines.push("### Exact Curve Quote (best donation size)");
    lines.push("");
    lines.push(`| USDtb in | USDC out | Net USD | Route Positive |`);
    lines.push("|---:|---:|---:|---:|");
    lines.push(`| ${eq.usdtbIn} | ${formatUsd(eq.usdcOutUsd)} | ${formatUsd(eq.netUsd)} | ${eq.routePositive} |`);
  }
  lines.push("");
  lines.push("## Blockers");
  lines.push("");
  for (const b of output.blockers) lines.push(`- ${b}`);
  lines.push("");
  lines.push("## Gate");
  lines.push("");
  if (output.donationModel.best?.routePositive) {
    lines.push("- The model suggests a **potentially positive** route. A fork test must confirm exact economics before any live action.");
  } else {
    lines.push("- No route-positive path found. All modeled donation sizes produce negative economics.");
  }
  lines.push("- No signed action or live exploit is justified until fork proof confirms positive net extraction.");
  fs.writeFileSync(REPORT, `${lines.join("\n")}\n`);

  console.log(JSON.stringify({
    ok: true,
    generatedAt: output.generatedAt,
    maxDepositIsZero: s.sUSDe.maxDepositIsZero,
    borrowCashUsd: s.morpho.borrowAssetsUsd,
    bestDonationPct: output.donationModel.best?.donationPct,
    bestNetUsd: output.donationModel.best?.netUsd,
    routePositive: output.summary.routePositive,
    exactQuoteNetUsd: output.donationModel.exactCurveQuote?.netUsd,
  }, null, 2));
}

main().catch(err => {
  console.error(JSON.stringify({ ok: false, error: String(err) }));
  process.exit(1);
});
