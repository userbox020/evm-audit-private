#!/usr/bin/env node
// Auto-fork proof: Aave V4 Balancer ERC20 flash-loan liquidation.
// Reads current artifacts, verifies live HF first, and never signs live transactions.
// RPC URLs are resolved in memory only and never printed or stored.

const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const WATCH_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-liquidation-watch.json");
const QUOTE_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v4-liquidation-quotes.json");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "fork-proof-aave-v4-flash-liquidation.json");
const LIQUIDATION_BOT_DIR = path.join(WORKSPACE, "exploits", "liquidation-bot");
const CONTRACT_ARTIFACT = path.join(LIQUIDATION_BOT_DIR, "out", "AaveV4FlashLoanLiquidator.sol", "AaveV4FlashLoanLiquidator.json");

const CHAIN_ID = 1;
const PORT = Number(process.env.AAVE_V4_FLASH_FORK_PORT || "8548");
const WAD = 10n ** 18n;
const SLIPPAGE_BPS = BigInt(Number(process.env.AAVE_V4_LIQUIDATION_SLIPPAGE_BPS || "100"));
const MIN_NET_PROFIT_USD = Number(process.env.AAVE_V4_MIN_NET_PROFIT_USD || "25");

const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const BALANCER_VAULT = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";
const UNISWAP_V3_ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564";

const SPOKE_ABI = [
  "function getUserAccountData(address user) view returns (uint256,uint256,uint256,uint256,uint256,uint256,uint256)",
  "function getUserTotalDebt(uint256 reserveId,address user) view returns (uint256)",
  "function getUserSuppliedAssets(uint256 reserveId,address user) view returns (uint256)",
  "function getLiquidationBonus(uint256 reserveId,address user,uint256 healthFactor) view returns (uint256)",
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];
const UNISWAP_ABI = [
  "function exactInput((bytes path,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum)) payable returns (uint256 amountOut)",
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
];
const CURVE_ABI = [
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

function writeArtifact(out) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(out, jsonReplacer, 2)}\n`);
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

function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const n = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function rawAmountToNumber(raw, decimals) {
  const amount = toBigInt(raw, 0n);
  const d = Number(decimals);
  if (amount <= 0n || !Number.isInteger(d) || d < 0) return null;
  const n = Number(ethers.formatUnits(amount, d));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function priceUsdFromRaw(raw, amountUsd, decimals) {
  const usd = asNumber(amountUsd);
  const amount = rawAmountToNumber(raw, decimals);
  return usd !== null && usd > 0 && amount !== null && amount > 0 ? usd / amount : null;
}

function usdToTokenRaw(usd, priceUsd, decimals) {
  const d = Number(decimals);
  if (!(usd > 0) || !(priceUsd > 0) || !Number.isInteger(d) || d < 0) return 0n;
  const precision = Math.min(d, 18);
  return ethers.parseUnits((usd / priceUsd).toFixed(precision), d);
}

function inferDebtPriceUsd(row, debtInfo, ethUsd) {
  const repayPrice = priceUsdFromRaw(row?.repay?.amountRaw, row?.repay?.amountUsd, debtInfo.decimals);
  if (repayPrice && repayPrice > 0) return { priceUsd: repayPrice, source: "repay-amount-usd" };

  const quotePrice = priceUsdFromRaw(row?.quote?.amountOutRaw, row?.quote?.amountOutUsd, debtInfo.decimals);
  if (quotePrice && quotePrice > 0) return { priceUsd: quotePrice, source: "quote-output-usd" };

  if (sameAddress(debtInfo.address, WETH) && ethUsd > 0) return { priceUsd: ethUsd, source: "coingecko-eth" };

  const symbol = String(row?.repay?.symbol || debtInfo.symbol || "").toUpperCase();
  if (/USD|DAI|FRAX/.test(symbol)) return { priceUsd: 1, source: "stable-symbol-fallback" };

  return { priceUsd: 0, source: "unavailable" };
}

function encodeUniswapPath(tokens, fees) {
  let out = tokens[0].toLowerCase();
  for (let i = 0; i < fees.length; i++) {
    out += Number(fees[i]).toString(16).padStart(6, "0") + tokens[i + 1].toLowerCase().replace(/^0x/, "");
  }
  return out;
}

async function tokenInfo(provider, address, fallbackSymbol = null) {
  const normalized = normalizeAddress(address);
  if (!normalized) throw new Error("invalid token address");
  const token = new ethers.Contract(normalized, ERC20_ABI, provider);
  const [decimalsRaw, symbolRaw] = await Promise.all([
    token.decimals().catch(() => 18),
    token.symbol().catch(() => fallbackSymbol || null),
  ]);
  const decimals = Number(decimalsRaw);
  return {
    address: normalized,
    symbol: typeof symbolRaw === "string" && symbolRaw ? symbolRaw : fallbackSymbol,
    decimals: Number.isInteger(decimals) && decimals >= 0 ? decimals : 18,
  };
}

function baseArtifact(extra = {}) {
  return {
    generatedAt: new Date().toISOString(),
    scanner: "tools/auto-fork-aave-v4-flash-liquidation.js",
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
      contractArtifact: path.relative(WORKSPACE, CONTRACT_ARTIFACT),
    },
    ...extra,
  };
}

function exactQuoteRows() {
  const exact = loadJson(QUOTE_FILE, {});
  const rows = Array.isArray(exact?.rows) ? exact.rows : [];
  return rows.map((row) => ({ ...row, quoteArtifactKind: "exact" }));
}

function chooseTarget() {
  const rows = exactQuoteRows();
  const quoted = rows.find((row) => row.researchPositive || row.routePositive) || rows[0] || null;
  if (quoted?.user && quoted?.spoke) return quoted;

  const watch = loadJson(WATCH_FILE, {});
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
  const { resolveRpc } = require("./shared-rpc");
  return resolveRpc(chainId);
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

function ensureContractArtifact() {
  if (fs.existsSync(CONTRACT_ARTIFACT)) return loadJson(CONTRACT_ARTIFACT, null);
  const result = cp.spawnSync("forge", ["build", "--contracts", "src/AaveV4FlashLoanLiquidator.sol"], {
    cwd: LIQUIDATION_BOT_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    encoding: "utf8",
  });
  if (result.status !== 0 || !fs.existsSync(CONTRACT_ARTIFACT)) {
    throw new Error((result.stderr || result.stdout || "forge build failed").trim().slice(0, 500));
  }
  return loadJson(CONTRACT_ARTIFACT, null);
}

function quotePathTokens(row) {
  const pathInfo = row?.quote?.path || {};
  const tokens = Array.isArray(pathInfo.tokens) ? pathInfo.tokens.map(normalizeAddress).filter(Boolean) : [];
  const tokenIn = normalizeAddress(pathInfo.tokenIn || pathInfo.coinIn?.address || tokens[0] || row?.collateral?.address);
  const tokenOut = normalizeAddress(pathInfo.tokenOut || pathInfo.coinOut?.address || tokens[tokens.length - 1] || row?.repay?.address || WETH);
  return { tokenIn, tokenOut, tokens, pathInfo };
}

function buildSwapRoute(row, liquidatorAddress, blockTimestamp) {
  const quote = row.quote || {};
  const { tokenIn, tokenOut, pathInfo } = quotePathTokens(row);
  const amountIn = toBigInt(row?.collateral?.seizedRaw);
  const quotedOut = toBigInt(quote.amountOutRaw);
  if (!tokenIn || !tokenOut || amountIn <= 0n || quotedOut <= 0n) return null;
  const minOut = quotedOut * (10_000n - SLIPPAGE_BPS) / 10_000n;

  if (quote.pathKind === "uniswap-v3-direct") {
    const fees = Array.isArray(pathInfo.fees) ? pathInfo.fees : quote.fees;
    const fee = Number(fees?.[0]);
    if (!Number.isInteger(fee) || fee <= 0) return null;
    const iface = new ethers.Interface(UNISWAP_ABI);
    const calldata = iface.encodeFunctionData("exactInputSingle", [[
      tokenIn,
      tokenOut,
      fee,
      liquidatorAddress,
      BigInt(blockTimestamp + 600),
      amountIn,
      minOut,
      0,
    ]]);
    return {
      kind: "uniswap-v3-direct",
      target: UNISWAP_V3_ROUTER,
      spender: UNISWAP_V3_ROUTER,
      calldata,
      amountIn,
      quotedOut,
      minOut,
      tokenIn,
      tokenOut,
      fee,
    };
  }

  if (quote.pathKind === "uniswap-v3-routed") {
    const fees = Array.isArray(pathInfo.fees) ? pathInfo.fees.map(Number) : [];
    const routeTokens = Array.isArray(pathInfo.tokens) ? pathInfo.tokens.map(normalizeAddress).filter(Boolean) : [];
    if (routeTokens.length < 2 || fees.length !== routeTokens.length - 1 || fees.some((fee) => !Number.isInteger(fee) || fee <= 0)) return null;
    const iface = new ethers.Interface(UNISWAP_ABI);
    const calldata = iface.encodeFunctionData("exactInput", [[
      encodeUniswapPath(routeTokens, fees),
      liquidatorAddress,
      BigInt(blockTimestamp + 600),
      amountIn,
      minOut,
    ]]);
    return {
      kind: "uniswap-v3-routed",
      target: UNISWAP_V3_ROUTER,
      spender: UNISWAP_V3_ROUTER,
      calldata,
      amountIn,
      quotedOut,
      minOut,
      tokenIn,
      tokenOut,
      fees,
      tokens: routeTokens,
    };
  }

  if (quote.pathKind === "curve-direct") {
    const pool = normalizeAddress(pathInfo.pool || quote.pool);
    const coinIn = pathInfo.coinIn || {};
    const coinOut = pathInfo.coinOut || {};
    if (!pool || !Number.isInteger(Number(coinIn.index)) || !Number.isInteger(Number(coinOut.index))) return null;
    const iface = new ethers.Interface(CURVE_ABI);
    const sig = pathInfo.indexType === "uint256" ? "exchange(uint256,uint256,uint256,uint256)" : "exchange(int128,int128,uint256,uint256)";
    const calldata = iface.encodeFunctionData(sig, [BigInt(coinIn.index), BigInt(coinOut.index), amountIn, minOut]);
    return {
      kind: "curve-direct",
      target: pool,
      spender: pool,
      calldata,
      amountIn,
      quotedOut,
      minOut,
      tokenIn,
      tokenOut,
      coinIn,
      coinOut,
    };
  }

  return null;
}

async function main() {
  const rpc = await resolveRpc(CHAIN_ID);
  if (!rpc) throw new Error("No Ethereum RPC endpoint resolved from local inventory");

  const target = chooseTarget();
  if (!target?.user || !target?.spoke) {
    writeArtifact(baseArtifact({ verdict: "no-target", blocker: "No Aave V4 watch or exact quote target available." }));
    console.log("Aave V4 flash fork: no target.");
    return;
  }

  const providerLive = new ethers.JsonRpcProvider(rpc, CHAIN_ID, { staticNetwork: true });
  const block = await providerLive.getBlockNumber();
  const blockInfo = await providerLive.getBlock(block);
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
    console.log(`Aave V4 flash fork: not liquidatable HF=${account.healthFactor.toFixed(9)}; no fork.`);
    return;
  }

  if (target.quoteArtifactKind !== "exact" || !target.quote?.path || !target.repay?.amountRaw || !target.collateral?.seizedRaw) {
    writeArtifact(baseArtifact({ verdict: "missing-exact-quote", live, blocker: "Liquidatable row exists, but exact flash repay/collateral-exit quote is missing." }));
    console.log("Aave V4 flash fork: missing exact quote; no fork.");
    return;
  }

  const repayAmount = toBigInt(target.repay.amountRaw);
  if (repayAmount <= 0n) {
    writeArtifact(baseArtifact({ verdict: "zero-repay", live, blocker: "Repay amount is zero." }));
    console.log("Aave V4 flash fork: zero repay; no fork.");
    return;
  }

  const { tokenIn: collateralToken, tokenOut: debtToken } = quotePathTokens(target);
  if (!collateralToken || !debtToken) {
    writeArtifact(baseArtifact({ verdict: "missing-route-tokens", live, route: target.quote, blocker: "Exact quote route does not identify collateral and debt tokens." }));
    console.log("Aave V4 flash fork: missing route tokens; no fork.");
    return;
  }

  const [debtInfo, collateralInfo, balancerDebtLiquidity] = await Promise.all([
    tokenInfo(providerLive, debtToken, target.repay?.symbol || null),
    tokenInfo(providerLive, collateralToken, target.collateral?.symbol || null),
    new ethers.Contract(debtToken, ERC20_ABI, providerLive).balanceOf(BALANCER_VAULT).catch(() => null),
  ]);
  Object.assign(live, {
    debtToken: debtInfo.address,
    debtSymbol: debtInfo.symbol,
    debtDecimals: debtInfo.decimals,
    collateralToken: collateralInfo.address,
    collateralSymbol: collateralInfo.symbol,
    collateralDecimals: collateralInfo.decimals,
    balancerFlashLiquidityRaw: balancerDebtLiquidity,
  });

  if (balancerDebtLiquidity !== null && balancerDebtLiquidity < repayAmount) {
    writeArtifact(baseArtifact({ verdict: "insufficient-flash-liquidity", live, repayAmountRaw: repayAmount, blocker: "Balancer Vault debt-token balance is below repay amount." }));
    console.log("Aave V4 flash fork: insufficient Balancer debt-token liquidity; no fork.");
    return;
  }

  const ethUsd = await ethPriceUsd();
  const debtPrice = inferDebtPriceUsd(target, debtInfo, ethUsd);
  Object.assign(live, { debtPriceUsd: round(debtPrice.priceUsd, 8), debtPriceSource: debtPrice.source, ethPriceUsd: round(ethUsd, 2) });
  if (!(debtPrice.priceUsd > 0)) {
    writeArtifact(baseArtifact({ verdict: "missing-debt-price", live, blocker: "Cannot convert minimum USD profit into debt-token units." }));
    console.log("Aave V4 flash fork: missing debt-token price; no fork.");
    return;
  }

  const routePreview = buildSwapRoute(target, BALANCER_VAULT, blockInfo?.timestamp || Math.floor(Date.now() / 1000));
  if (!routePreview || !sameAddress(routePreview.tokenIn, collateralToken) || !sameAddress(routePreview.tokenOut, debtToken)) {
    writeArtifact(baseArtifact({ verdict: "unsupported-route", live, route: target.quote, blocker: "Exact quote route is not supported by flash fork harness." }));
    console.log("Aave V4 flash fork: unsupported route; no fork.");
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
    const artifact = ensureContractArtifact();
    if (!artifact?.abi || !artifact?.bytecode?.object) throw new Error("Aave V4 flash liquidator artifact is invalid");

    const attackerWallet = ethers.Wallet.createRandom().connect(provider);
    const attacker = attackerWallet.address;
    await provider.send("anvil_setBalance", [attacker, ethers.toBeHex(10n ** 19n)]);

    const minProfitDebtToken = usdToTokenRaw(MIN_NET_PROFIT_USD, debtPrice.priceUsd, debtInfo.decimals);

    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode.object, attackerWallet);
    const liquidator = await factory.deploy();
    await waitTx(liquidator.deploymentTransaction());

    const route = buildSwapRoute(target, await liquidator.getAddress(), blockInfo?.timestamp || Math.floor(Date.now() / 1000));
    if (!route || !sameAddress(route.tokenIn, collateralToken) || !sameAddress(route.tokenOut, debtToken)) throw new Error("Exact quote route became unsupported after deployment");

    await waitTx(liquidator.setSwapAllowance(route.target, route.spender, true, { gasLimit: 120_000 }));

    const data = {
      spoke: target.spoke,
      borrower: target.user,
      debtToken,
      collateralToken,
      collateralReserveId,
      minCollateralSeized: route.amountIn,
      swapTarget: route.target,
      swapSpender: route.spender,
      swapCalldata: route.calldata,
      minDebtTokenOut: route.minOut,
      minProfitDebtToken,
    };

    const debt = new ethers.Contract(debtToken, ERC20_ABI, attackerWallet);
    const ownerDebtBefore = await debt.balanceOf(attacker);
    await liquidator.execute.staticCall(repayAmount, data);
    const estimatedGas = await liquidator.execute.estimateGas(repayAmount, data);
    const receipt = await waitTx(liquidator.execute(repayAmount, data, { gasLimit: estimatedGas * 13n / 10n }));
    const ownerDebtAfter = await debt.balanceOf(attacker);

    const debtProfit = ownerDebtAfter - ownerDebtBefore;
    const grossProfitUsd = Number(ethers.formatUnits(debtProfit, debtInfo.decimals)) * debtPrice.priceUsd;
    const gasUsd = ethUsd > 0 ? Number(ethers.formatUnits(gasCostWei, 18)) * ethUsd : null;
    const netUsd = gasUsd === null ? null : grossProfitUsd - gasUsd;
    const success = debtProfit > 0n && netUsd !== null && netUsd > MIN_NET_PROFIT_USD;

    writeArtifact(baseArtifact({
      safety: { ...baseArtifact().safety, forkTransactions: true, routePositive: success },
      verdict: success ? "fork-positive" : "fork-non-positive",
      live,
      route: {
        source: target.quote.source || null,
        pathKind: target.quote.pathKind,
        target: route.target,
        spender: route.spender,
        tokenIn: route.tokenIn,
        tokenOut: route.tokenOut,
        amountInRaw: route.amountIn,
        quotedOutRaw: route.quotedOut,
        minOutRaw: route.minOut,
      },
      economics: {
        repayAmount: ethers.formatUnits(repayAmount, debtInfo.decimals),
        repayToken: debtInfo,
        ownerDebtTokenProfit: ethers.formatUnits(debtProfit, debtInfo.decimals),
        grossProfitUsd: round(grossProfitUsd, 2),
        gasCostEth: ethers.formatUnits(gasCostWei, 18),
        gasUsd: gasUsd === null ? null : round(gasUsd, 2),
        ethPriceUsd: round(ethUsd, 2),
        debtPriceUsd: round(debtPrice.priceUsd, 8),
        debtPriceSource: debtPrice.source,
        netUsd: netUsd === null ? null : round(netUsd, 2),
        minNetProfitUsd: MIN_NET_PROFIT_USD,
        contractMinProfitDebtToken: ethers.formatUnits(minProfitDebtToken, debtInfo.decimals),
      },
      fork: { success, block, attacker, liquidator: await liquidator.getAddress(), executeTx: receipt.hash, txHashes },
    }));
    console.log(`Aave V4 flash fork: success=${success} netUsd=${netUsd === null ? "n/a" : netUsd.toFixed(2)}`);
  } catch (e) {
    writeArtifact(baseArtifact({
      safety: { ...baseArtifact().safety, forkTransactions: txHashes.length > 0 },
      verdict: "fork-failed",
      live,
      error: e?.reason || e?.shortMessage || e?.message || String(e),
      txHashes,
    }));
    console.log(`Aave V4 flash fork failed: ${e?.reason || e?.shortMessage || e?.message || String(e)}`);
  } finally {
    child.kill();
  }
}

main().catch((e) => {
  console.error(`auto-fork-aave-v4-flash-liquidation failed: ${e?.stack || e?.message || String(e)}`);
  process.exitCode = 1;
});
