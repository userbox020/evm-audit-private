#!/usr/bin/env node
// Auto-fork proof: Aave V4 liquidation profitability.
// Reads current artifacts, verifies live HF first, and never signs live transactions.
// RPC URLs are resolved in memory only and never printed or stored.

const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const WATCH_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-liquidation-watch.json");
const QUOTE_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-liquidation-quotes.json");
const SHADOW_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-liquidation-shadow-quotes.json");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "fork-proof-aave-v4-liquidation.json");

const CHAIN_ID = 1;
const PORT = Number(process.env.AAVE_V4_FORK_PORT || "8547");
const WAD = 10n ** 18n;
const MIN_NET_PROFIT_USD = Number(process.env.AAVE_V4_MIN_NET_PROFIT_USD || "25");
const SLIPPAGE_BPS = BigInt(Number(process.env.AAVE_V4_LIQUIDATION_SLIPPAGE_BPS || "100"));

const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const WEETH = "0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee";

const SPOKE_ABI = [
  "function getUserAccountData(address user) view returns (uint256,uint256,uint256,uint256,uint256,uint256,uint256)",
  "function getUserTotalDebt(uint256 reserveId,address user) view returns (uint256)",
  "function getUserSuppliedAssets(uint256 reserveId,address user) view returns (uint256)",
  "function getLiquidationBonus(uint256 reserveId,address user,uint256 healthFactor) view returns (uint256)",
  "function liquidate(address user,uint256 collateralReserveId,uint256 debtToCover) returns (uint256)",
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];
const WETH_ABI = [...ERC20_ABI, "function deposit() payable"];
const CURVE_ABI = [
  "function get_dy(int128 i,int128 j,uint256 dx) view returns (uint256)",
  "function get_dy(uint256 i,uint256 j,uint256 dx) view returns (uint256)",
  "function exchange(int128 i,int128 j,uint256 dx,uint256 min_dy) returns (uint256)",
  "function exchange(uint256 i,uint256 j,uint256 dx,uint256 min_dy) returns (uint256)",
];

function loadJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function round(value, decimals = 6) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function normalizeAddress(value) {
  try { return ethers.getAddress(value); } catch (_) { return null; }
}

function sameAddress(a, b) {
  const aa = normalizeAddress(a);
  const bb = normalizeAddress(b);
  return Boolean(aa && bb && aa.toLowerCase() === bb.toLowerCase());
}

function toBigInt(value, fallback = 0n) {
  try {
    if (value === null || value === undefined || value === "") return fallback;
    return BigInt(value);
  } catch (_) {
    return fallback;
  }
}

function writeArtifact(out) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(out, jsonReplacer, 2)}\n`);
}

function baseArtifact(extra = {}) {
  return {
    generatedAt: new Date().toISOString(),
    scanner: "tools/auto-fork-aave-v4-liquidation.js",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: false,
      signedActionJustified: false,
    },
    sourceArtifacts: {
      watch: path.relative(WORKSPACE, WATCH_FILE),
      quotes: path.relative(WORKSPACE, QUOTE_FILE),
      shadowQuotes: path.relative(WORKSPACE, SHADOW_FILE),
    },
    ...extra,
  };
}

function quoteRows() {
  const exact = loadJson(QUOTE_FILE, {});
  const exactRows = Array.isArray(exact?.rows) ? exact.rows : [];
  if (exactRows.length) return exactRows.map((row) => ({ ...row, quoteArtifactKind: "exact" }));
  const shadow = loadJson(SHADOW_FILE, {});
  const shadowRows = Array.isArray(shadow?.rows) ? shadow.rows : [];
  return shadowRows.map((row) => ({ ...row, quoteArtifactKind: "shadow" }));
}

function chooseTarget() {
  const watch = loadJson(WATCH_FILE, {});
  const rows = quoteRows();
  const quoted = rows.find((row) => row.researchPositive || row.shadowResearchPositive) || rows[0] || null;
  if (quoted?.user && quoted?.spoke) return quoted;
  const latest = watch?.latest || {};
  return (Array.isArray(latest.quoteRequiredRows) && latest.quoteRequiredRows[0])
    || (Array.isArray(latest.topRows) && latest.topRows[0])
    || (Array.isArray(latest.closestRows) && latest.closestRows[0])
    || null;
}

function decodeAccountData(acc) {
  const [riskPremium, avgCollateralFactor, healthFactor, totalCollateralValue, totalDebtValueRay, activeCollateralCount, borrowCount] = acc;
  return {
    riskPremiumBps: Number(riskPremium),
    avgCollateralFactor: Number(ethers.formatUnits(avgCollateralFactor, 18)),
    healthFactorRaw: healthFactor,
    healthFactor: healthFactor === ethers.MaxUint256 ? Number.POSITIVE_INFINITY : Number(ethers.formatUnits(healthFactor, 18)),
    totalCollateralValueRaw: totalCollateralValue,
    totalDebtValueRayRaw: totalDebtValueRay,
    activeCollateralCount: Number(activeCollateralCount),
    borrowCount: Number(borrowCount),
  };
}

async function resolveRpc(chainId) {
  const { resolveRpc: resolve } = require("./shared-rpc");
  return resolve(chainId);
}

async function waitForFork(provider, deadlineMs = 45_000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try { await provider.send("eth_blockNumber", []); return; } catch (_) { await new Promise((r) => setTimeout(r, 500)); }
  }
  throw new Error("Anvil fork did not become ready");
}

async function ethPriceUsd() {
  const json = await fetch("https://coins.llama.fi/prices/current/coingecko:ethereum?searchWidth=6h")
    .then((r) => r.json())
    .catch(() => null);
  const p = Number(json?.coins?.["coingecko:ethereum"]?.price || 0);
  return Number.isFinite(p) && p > 0 ? p : 0;
}

async function curveGetDy(provider, pool, i, j, dx) {
  const iface = new ethers.Interface(CURVE_ABI);
  for (const sig of ["get_dy(int128,int128,uint256)", "get_dy(uint256,uint256,uint256)"]) {
    try {
      const raw = await provider.call({ to: pool, data: iface.encodeFunctionData(sig, [BigInt(i), BigInt(j), dx]) });
      return iface.decodeFunctionResult(sig, raw)[0];
    } catch (_) {
      // Try the alternate Curve index type.
    }
  }
  return null;
}

async function curveExchange(wallet, pool, i, j, dx, minDy) {
  const iface = new ethers.Interface(CURVE_ABI);
  for (const sig of ["exchange(int128,int128,uint256,uint256)", "exchange(uint256,uint256,uint256,uint256)"]) {
    try {
      return await wallet.sendTransaction({ to: pool, data: iface.encodeFunctionData(sig, [BigInt(i), BigInt(j), dx, minDy]), gasLimit: 1_200_000 });
    } catch (_) {
      // Try the alternate Curve index type.
    }
  }
  throw new Error("Curve exchange failed for both int128 and uint256 index signatures");
}

async function main() {
  const rpc = await resolveRpc(CHAIN_ID);
  if (!rpc) throw new Error("No Ethereum RPC endpoint resolved from local inventory");

  const target = chooseTarget();
  if (!target?.user || !target?.spoke) {
    writeArtifact(baseArtifact({ verdict: "no-target", blocker: "No Aave V4 watch or quote target available." }));
    console.log("Aave V4 fork: no target.");
    return;
  }

  const providerLive = new ethers.JsonRpcProvider(rpc, CHAIN_ID, { staticNetwork: true });
  const block = await providerLive.getBlockNumber();
  const spoke = new ethers.Contract(target.spoke, SPOKE_ABI, providerLive);
  const account = decodeAccountData(await spoke.getUserAccountData(target.user));
  const liquidatable = account.healthFactorRaw < WAD;
  const debtReserveId = Number(target.repay?.reserveId ?? target.topDebt?.reserveId ?? 1);
  const collateralReserveId = Number(target.collateral?.reserveId ?? target.topCollateral?.reserveId ?? 0);
  const [liveDebtRaw, liveCollateralRaw, bonusRaw] = await Promise.all([
    spoke.getUserTotalDebt(debtReserveId, target.user).catch(() => null),
    spoke.getUserSuppliedAssets(collateralReserveId, target.user).catch(() => null),
    spoke.getLiquidationBonus(collateralReserveId, target.user, account.healthFactorRaw).catch(() => null),
  ]);

  const live = {
    chainId: CHAIN_ID,
    block,
    user: target.user,
    spoke: target.spoke,
    healthFactorRaw: account.healthFactorRaw,
    healthFactor: round(account.healthFactor, 12),
    liquidatable,
    debtReserveId,
    collateralReserveId,
    liveDebtRaw,
    liveCollateralRaw,
    liquidationBonusBps: bonusRaw === null ? null : Number(bonusRaw),
    quoteArtifactKind: target.quoteArtifactKind || null,
  };

  if (!liquidatable) {
    writeArtifact(baseArtifact({ verdict: "not-liquidatable", live, forkGate: "closed-hf-above-1" }));
    console.log(`Aave V4 fork: not liquidatable HF=${account.healthFactor.toFixed(9)}; no fork.`);
    return;
  }

  if (!target.quote?.path || !target.repay?.amountRaw || !target.collateral?.reserveId) {
    writeArtifact(baseArtifact({ verdict: "missing-exact-quote", live, blocker: "Liquidatable row exists, but exact repay/collateral-exit quote is missing." }));
    console.log("Aave V4 fork: missing exact quote; no fork.");
    return;
  }

  const pathInfo = target.quote.path;
  const pool = normalizeAddress(pathInfo.pool);
  const coinIn = pathInfo.coinIn || {};
  const coinOut = pathInfo.coinOut || {};
  const collateralToken = normalizeAddress(pathInfo.tokenIn || coinIn.address || WEETH);
  const debtToken = normalizeAddress(pathInfo.tokenOut || coinOut.address || WETH);
  if (!pool || !sameAddress(debtToken, WETH) || !sameAddress(collateralToken, WEETH) || target.quote.pathKind !== "curve-direct") {
    writeArtifact(baseArtifact({ verdict: "unsupported-route", live, route: target.quote, blocker: "Current fork script only supports direct Curve weETH->WETH liquidation exit." }));
    console.log("Aave V4 fork: unsupported route; no fork.");
    return;
  }

  const quotedRepay = toBigInt(target.repay.amountRaw);
  const repayAmount = liveDebtRaw && liveDebtRaw > 0n && quotedRepay > liveDebtRaw ? liveDebtRaw : quotedRepay;
  if (repayAmount <= 0n) {
    writeArtifact(baseArtifact({ verdict: "zero-repay", live, blocker: "Repay amount is zero." }));
    console.log("Aave V4 fork: zero repay; no fork.");
    return;
  }

  const child = cp.spawn("anvil", ["--fork-url", rpc, "--fork-block-number", String(block), "--port", String(PORT)], { stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
  const forkUrl = `http://127.0.0.1:${PORT}`;
  const provider = new ethers.JsonRpcProvider(forkUrl, CHAIN_ID);
  let gasCostWei = 0n;
  const txHashes = [];

  async function waitTx(txPromise) {
    const tx = await txPromise;
    const receipt = await tx.wait();
    const gasPrice = receipt.gasPrice || receipt.effectiveGasPrice || (await provider.getFeeData()).gasPrice || 0n;
    gasCostWei += receipt.gasUsed * gasPrice;
    txHashes.push(receipt.hash);
    return receipt;
  }

  try {
    await waitForFork(provider);
    const attackerWallet = ethers.Wallet.createRandom().connect(provider);
    const attacker = attackerWallet.address;
    await provider.send("anvil_setBalance", [attacker, ethers.toBeHex(repayAmount + 10n ** 19n)]);

    const spokeFork = new ethers.Contract(target.spoke, SPOKE_ABI, attackerWallet);
    const weth = new ethers.Contract(WETH, WETH_ABI, attackerWallet);
    const collateral = new ethers.Contract(collateralToken, ERC20_ABI, attackerWallet);
    await waitTx(weth.deposit({ value: repayAmount, gasLimit: 120_000 }));
    await waitTx(weth.approve(target.spoke, repayAmount, { gasLimit: 120_000 }));

    await spokeFork.liquidate.staticCall(target.user, collateralReserveId, repayAmount);
    const liqReceipt = await waitTx(spokeFork.liquidate(target.user, collateralReserveId, repayAmount, { gasLimit: 2_000_000 }));

    const seized = await collateral.balanceOf(attacker);
    if (seized <= 0n) throw new Error("Liquidation seized zero collateral");

    const quotedOut = await curveGetDy(provider, pool, coinIn.index, coinOut.index, seized);
    if (!quotedOut || quotedOut <= 0n) throw new Error("Curve get_dy returned zero");
    const minOut = quotedOut * (10_000n - SLIPPAGE_BPS) / 10_000n;
    await waitTx(collateral.approve(pool, seized, { gasLimit: 120_000 }));
    const swapTx = await curveExchange(attackerWallet, pool, coinIn.index, coinOut.index, seized, minOut);
    const swapReceipt = await waitTx(Promise.resolve(swapTx));

    const wethAfter = await weth.balanceOf(attacker);
    const netWethBeforeGas = wethAfter - repayAmount;
    const netWethAfterGas = netWethBeforeGas - gasCostWei;
    const ethUsd = await ethPriceUsd();
    const netUsd = ethUsd ? Number(ethers.formatUnits(netWethAfterGas, 18)) * ethUsd : null;
    const success = netWethAfterGas > 0n && (netUsd === null || netUsd > MIN_NET_PROFIT_USD);
    writeArtifact(baseArtifact({
      safety: { ...baseArtifact().safety, forkTransactions: true, routePositive: success },
      verdict: success ? "fork-positive" : "fork-non-positive",
      live,
      route: {
        source: target.quote.source || null,
        pathKind: target.quote.pathKind,
        pool,
        coinIn,
        coinOut,
      },
      economics: {
        repayAmountWeth: ethers.formatUnits(repayAmount, 18),
        seizedCollateral: ethers.formatUnits(seized, 18),
        curveQuotedOutWeth: ethers.formatUnits(quotedOut, 18),
        minOutWeth: ethers.formatUnits(minOut, 18),
        wethAfter: ethers.formatUnits(wethAfter, 18),
        gasCostEth: ethers.formatUnits(gasCostWei, 18),
        netWethBeforeGas: ethers.formatUnits(netWethBeforeGas, 18),
        netWethAfterGas: ethers.formatUnits(netWethAfterGas, 18),
        ethPriceUsd: round(ethUsd, 2),
        netUsd: netUsd === null ? null : round(netUsd, 2),
        minNetProfitUsd: MIN_NET_PROFIT_USD,
      },
      fork: { success, block, attacker, liquidationTx: liqReceipt.hash, swapTx: swapReceipt.hash, txHashes },
    }));
    console.log(`Aave V4 fork: success=${success} netUsd=${netUsd === null ? "n/a" : netUsd.toFixed(2)}`);
  } catch (e) {
    writeArtifact(baseArtifact({
      safety: { ...baseArtifact().safety, forkTransactions: true },
      verdict: "fork-failed",
      live,
      error: e?.reason || e?.shortMessage || e?.message || String(e),
      txHashes,
    }));
    console.log(`Aave V4 fork failed: ${e?.reason || e?.shortMessage || e?.message || String(e)}`);
  } finally {
    child.kill();
  }
}

main().catch((e) => {
  console.error(`auto-fork-aave-v4-liquidation failed: ${e?.stack || e?.message || String(e)}`);
  process.exitCode = 1;
});
