#!/usr/bin/env node
// probe-wsrusd-usdc-donation.js - read-only economics probe for wsrUSD Morpho USDC donation attack.
// Borrow asset IS USDC, so no DEX swap needed — simpler route.
// Never prints or stores RPC URLs, keys, calldata, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpc, rpcCall } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "wsrusd-usdc-donation-probe.json");
const REPORT = path.join(WORKSPACE, "reports", "wsrusd-usdc-donation-probe-triage.md");
const CHAIN_ID = 1;

const ADDR = {
  wsrUSD: "0xd3fD63209FA2D55B07A0f6db36C2f43900be3094",
  srUSD: "0x09D4214C03D01F49544C0448DBE3A27f768F2b34",  // underlying asset
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  morpho: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
  oracle: "0x938D2eDb20425cF80F008E7ec314Eb456940Da15",
  marketId: "0x1590cb22d797e226df92ebc6e0153427e207299916e7e4e53461389ad68272fb",
};

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

function round(value, decimals = 2) { const n = Number(value); return Number.isFinite(n) ? Math.round(n * (10 ** decimals)) / (10 ** decimals) : null; }
function formatUsd(value) { return `$${Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })}`; }

function modelDonation(totalAssets, totalSupply, lltv, maxBorrow, donationPct) {
  const R = totalAssets / totalSupply;
  const donation = totalAssets * donationPct / 100;
  const TAnew = totalAssets + donation;
  const Rnew = TAnew / totalSupply;

  // To borrow maxBorrow at inflated rate: shares = maxBorrow / (Rnew * lltv)
  // But forward-looking: attacker flash-loans srUSD, deposits to get ws shares, donates, borrows USDC
  // Cost: shares * R + donation (in srUSD = USDC equivalent at 1:1 peg)
  // Revenue: shares * Rnew * lltv (in USDC)
  // Net = shares * Rnew * lltv - shares * R - donation
  //     = shares * (Rnew * lltv - R) - donation
  
  const maxShares = Math.floor(maxBorrow / (Rnew * lltv));
  const shares = maxShares;
  const cost = shares * R + donation;
  const borrow = Math.min(shares * Rnew * lltv, maxBorrow);
  const net = borrow - cost;

  return {
    donationPct,
    donation,
    R: round(R, 8),
    Rnew: round(Rnew, 8),
    inflationPct: round((Rnew / R - 1) * 100, 6),
    shares: Math.floor(shares),
    cost,
    borrow,
    net: round(net, 2),
    routePositive: net > 0,
  };
}

async function main() {
  const rpc = await resolveRpc(CHAIN_ID);
  if (!rpc) throw new Error("No RPC for chain 1");

  const ERC4626 = new ethers.Interface([
    "function totalAssets() view returns (uint256)",
    "function totalSupply() view returns (uint256)",
    "function convertToAssets(uint256) view returns (uint256)",
    "function maxDeposit(address) view returns (uint256)",
  ]);
  const ERC20 = new ethers.Interface(["function decimals() view returns (uint8)"]);
  const MORPHO_IF = new ethers.Interface([
    "function market(bytes32) view returns (tuple(uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee))",
    "function idToMarketParams(bytes32) view returns (tuple(address loanToken,address collateralToken,address oracle,address irm,uint256 lltv))",
  ]);
  const ORACLE_IF = new ethers.Interface(["function price() view returns (uint256)"]);

  const [srUsdDec, ta, ts, md, ca, mkt, params, op, wsrCode, oracleCode] = await Promise.all([
    safeCall(rpc, ADDR.srUSD, ERC20, "decimals"),
    safeCall(rpc, ADDR.wsrUSD, ERC4626, "totalAssets"),
    safeCall(rpc, ADDR.wsrUSD, ERC20, "totalSupply"),
    safeCall(rpc, ADDR.wsrUSD, ERC4626, "maxDeposit", [ADDR.wsrUSD]),
    safeCall(rpc, ADDR.wsrUSD, ERC4626, "convertToAssets", [10n ** 18n]),
    safeCall(rpc, ADDR.morpho, MORPHO_IF, "market", [ADDR.marketId]),
    safeCall(rpc, ADDR.morpho, MORPHO_IF, "idToMarketParams", [ADDR.marketId]),
    safeCall(rpc, ADDR.oracle, ORACLE_IF, "price"),
    getCode(rpc, ADDR.wsrUSD),
    getCode(rpc, ADDR.oracle),
  ]);

  const assetDec = srUsdDec ? Number(srUsdDec[0]) : 18;
  const totalAssets = ta ? Number(ethers.formatUnits(ta[0], assetDec)) : 0;
  let totalSupply = ts ? Number(ethers.formatUnits(ts[0], assetDec)) : 0;
  const exchangeRate = ca ? Number(ethers.formatUnits(ca[0], 18)) : 0;
  // Fallback: derive totalSupply from exchangeRate if totalSupply is 0 or NaN
  if (!totalSupply || totalSupply <= 0 || !Number.isFinite(totalSupply)) {
    totalSupply = exchangeRate > 0 ? totalAssets / exchangeRate : 1;
  }
  const maxDeposit = md ? md[0].toString() : "0";
  const maxDepositIsZero = maxDeposit === "0";

  const borrowAssets = mkt ? Number(ethers.formatUnits(mkt[0][2], 6)) : 0; // USDC = 6 decimals
  const lltv = params ? Number(params[0][4]) / 1e18 : 0;

  const oraclePrice = op ? Number(ethers.formatUnits(op[0], 36)) : 0;

  // Model at various donation sizes
  const pcts = [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 25, 50, 100];
  const results = pcts.map(p => modelDonation(totalAssets, totalSupply, lltv, borrowAssets, p));
  const best = results.reduce((b, r) => r.net > (b?.net ?? -Infinity) ? r : b, null);

  const output = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/probe-wsrusd-usdc-donation.js",
    scope: "wsrUSD Morpho USDC donation-attack read-only economics",
    safety: {
      rpcInventoryRead: true, rpcUrlsStored: false, envFilesRead: false,
      privateKeysRead: false, signedActions: false, exploitExecuteCalls: false, forkTransactions: false,
    },
    liveState: {
      wsrUSD: {
        totalAssets, totalAssetsUsd: round(totalAssets),
        totalSupply, exchangeRate: round(exchangeRate, 8),
        maxDeposit, maxDepositIsZero,
        codeBytes: Math.max(0, (wsrCode.length - 2) / 2),
      },
      morpho: {
        borrowAssets, borrowAssetsUsd: round(borrowAssets),
        lltv, lltvPct: round(lltv * 100),
        lossFromLltv: round(borrowAssets * (1 - lltv) / lltv),
      },
      oracle: {
        address: ADDR.oracle,
        codeBytes: Math.max(0, (oracleCode.length - 2) / 2),
        price: round(oraclePrice, 8),
        note: oracleCode && (oracleCode.length - 2) / 2 <= 100 ? "minimal code — likely constant or simple proxy" : null,
      },
    },
    donationModel: { results, best },
    summary: {
      routePositive: results.some(r => r.routePositive),
      executableNow: false,
      signedActionJustified: false,
      forkJustified: results.some(r => r.routePositive),
    },
    blockers: [],
  };

  const b = [];
  if (maxDepositIsZero) b.push("wsrUSD maxDeposit is zero — no new deposits possible");
  if (borrowAssets <= 0) b.push("No borrow cash available");
  if (!results.some(r => r.routePositive)) b.push("No donation size produces positive economics");
  b.push("Flash loan fees, gas, and supply caps not modeled");
  b.push("No fork test executed");
  output.blockers = b;

  ensureDir(OUT);
  fs.writeFileSync(OUT, `${JSON.stringify(output, jsonReplacer, 2)}\n`);

  // Report
  const s = output.liveState;
  const lines = [];
  lines.push(`# ${output.summary.routePositive ? "🟡 VULNERABLE" : "🟢 DORMANT"} — wsrUSD Morpho USDC Donation Attack Probe`);
  lines.push("");
  lines.push(`Generated: ${output.generatedAt}`);
  lines.push("");
  lines.push("## Key Insight");
  lines.push("");
  lines.push("The Morpho borrow asset is **USDC directly** — no DEX swap needed for exit. The route is: flash-loan srUSD → deposit wsrUSD → donate srUSD to inflate share price → supply wsrUSD to Morpho → borrow USDC → repay flash loan.");
  lines.push("");
  lines.push("## Live State");
  lines.push("");
  lines.push("| Field | Value |");
  lines.push("|---|---|");
  lines.push(`| wsrUSD totalAssets | ${formatUsd(s.wsrUSD.totalAssetsUsd)} srUSD |`);
  lines.push(`| wsrUSD totalSupply | ${s.wsrUSD.totalSupply.toLocaleString()} shares |`);
  lines.push(`| wsrUSD exchange rate | ${s.wsrUSD.exchangeRate} |`);
  lines.push(`| wsrUSD maxDeposit | ${s.wsrUSD.maxDepositIsZero ? "zero — DEPOSITS CLOSED" : "open"} |`);
  lines.push(`| Morpho borrow cash | ${formatUsd(s.morpho.borrowAssetsUsd)} USDC |`);
  lines.push(`| LLTV | ${s.morpho.lltvPct}% |`);
  lines.push(`| LLTV structural loss | ${formatUsd(s.morpho.lossFromLltv)} (if borrowing max) |`);
  lines.push(`| Oracle | ${ADDR.oracle} (${s.oracle.codeBytes} bytes) |`);
  if (s.oracle.note) lines.push(`| Oracle note | ${s.oracle.note} |`);
  lines.push("");
  lines.push("## Donation Attack Model");
  lines.push("");
  lines.push("| Donation % | Donation srUSD | Inflation % | Cost srUSD | Borrow USDC | Net USDC | Positive |");
  lines.push("|---:|---:|---:|---:|---:|---:|---:|");
  for (const r of results) {
    lines.push(`| ${r.donationPct}% | ${formatUsd(r.donation)} | ${r.inflationPct}% | ${formatUsd(r.cost)} | ${formatUsd(r.borrow)} | ${formatUsd(r.net)} | ${r.routePositive} |`);
  }
  if (best) {
    lines.push("");
    lines.push(`**Best**: ${best.donationPct}% donation → ${formatUsd(best.net)} net${best.routePositive ? " ✅ POSITIVE" : " ❌ NEGATIVE"}`);
  }
  lines.push("");
  lines.push("## Blockers");
  lines.push("");
  for (const bl of output.blockers) lines.push(`- ${bl}`);
  fs.writeFileSync(REPORT, `${lines.join("\n")}\n`);

  console.log(JSON.stringify({
    ok: true,
    totalAssets: round(s.wsrUSD.totalAssetsUsd),
    borrowCash: round(s.morpho.borrowAssetsUsd),
    maxDepositIsZero: s.wsrUSD.maxDepositIsZero,
    lltvPct: s.morpho.lltvPct,
    oracleBytes: s.oracle.codeBytes,
    bestNet: best?.net,
    routePositive: output.summary.routePositive,
  }, null, 2));
}

main().catch(err => {
  console.error(JSON.stringify({ ok: false, error: String(err) }));
  process.exit(1);
});
