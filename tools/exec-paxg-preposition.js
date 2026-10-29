#!/usr/bin/env node
"use strict";
// exec-paxg-preposition.js — batch exploit-rearm-canary-renewal-20260924, action "preposition".
// One-time prep for the morpho-paxg-misscale strike: acquire dust PAXG collateral
// (swap ETH->PAXG, target ~$8, hard cap 0.01 ETH capital, slippage <= 3%) and
// pre-approve Morpho Blue to spend it, so fire-time needs only supplyCollateral+borrow.
// Caps (batch): <= 0.01 ETH capital/action, <= 0.05 ETH gas/tx.
// Key material from .env.exploit is read in-process and NEVER printed/logged/persisted.
// Subcommands: probe (read-only) | swap | approve | status

const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const { ethers } = require(path.join(ROOT, "tools", "node_modules", "ethers"));
const { resolveRpc, PUBLIC_FALLBACKS } = require(path.join(ROOT, "tools", "shared-rpc.js"));

const BOT_WALLET = "0x24e46e91dfaad1fa3d49c48aa85ca9306885ce0a";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const PAXG = "0x45804880De22913dAFE09f4980848ECE6EcbAf78";
const MORPHO_BLUE = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const V2_ROUTER = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";
const V2_FACTORY = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f";
const PAXG_USD_APPROX = 4527; // sizing only; strike economics re-check at fire time
const TARGET_USD = 8;
const SWAP_CAP_ETH = "0.01";  // batch capital cap
const GAS_CAP_ETH = "0.05";   // batch gas cap
const SLIPPAGE_PCT = 3;       // batch: <= 300 bips

const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
]);
const V2_FACTORY_IF = new ethers.Interface(["function getPair(address,address) view returns (address)"]);
const V2_ROUTER_IF = new ethers.Interface([
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[])",
  "function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[])",
]);

function loadKey() {
  const envPath = path.join(ROOT, ".env.exploit");
  if (!fs.existsSync(envPath)) throw new Error(".env.exploit missing");
  const m = fs.readFileSync(envPath, "utf8").match(/PRIVATE_KEY=([a-fA-F0-9x]+)/);
  if (!m) throw new Error("PRIVATE_KEY not found");
  return m[1].startsWith("0x") ? m[1] : "0x" + m[1];
}

function sanitize(s) { return String(s || "").replace(/https?:\/\/\S+/g, "<rpc>").slice(0, 300); }

function capsOk(gasCostWei, valueWei) {
  if (valueWei > ethers.parseEther(SWAP_CAP_ETH)) { console.error("FAIL capital-cap"); process.exit(2); }
  if (gasCostWei > ethers.parseEther(GAS_CAP_ETH)) { console.error("FAIL gas-cap"); process.exit(2); }
}

async function sendWithFallback(wallet, txRequest) {
  try {
    return await wallet.sendTransaction(txRequest);
  } catch (e) {
    if (/sendRawTransaction|method not found|not supported|403|forbidden/i.test(String(e && e.message))) {
      const p2 = new ethers.JsonRpcProvider(PUBLIC_FALLBACKS[1], 1, { staticNetwork: true });
      return await wallet.connect(p2).sendTransaction(txRequest);
    }
    throw e;
  }
}

async function main() {
  const cmd = process.argv[2] || "probe";
  const url = await resolveRpc(1, null, { capability: "read", timeoutMs: 15000 });
  if (!url) { console.error("FAIL no-qualified-rpc"); process.exit(1); }
  const provider = new ethers.JsonRpcProvider(url, 1, { staticNetwork: true });
  const wallet = new ethers.Wallet(loadKey(), provider);
  if (wallet.address.toLowerCase() !== BOT_WALLET.toLowerCase()) {
    console.error("FAIL account-mismatch"); process.exit(1);
  }

  const paxgRead = new ethers.Contract(PAXG, ERC20, provider);
  const [ethBal, paxgBal, allowance] = await Promise.all([
    provider.getBalance(BOT_WALLET),
    paxgRead.balanceOf(BOT_WALLET),
    paxgRead.allowance(BOT_WALLET, MORPHO_BLUE),
  ]);

  const v2f = new ethers.Contract(V2_FACTORY, V2_FACTORY_IF, provider);
  const pair = await v2f.getPair(WETH, PAXG);
  const probe = { cmd, block: await provider.getBlockNumber(), v2Pair: pair, hasV2Pair: pair !== ethers.ZeroAddress };
  let probeQuote = 0n;
  if (probe.hasV2Pair) {
    const router = new ethers.Contract(V2_ROUTER, V2_ROUTER_IF, provider);
    try { probeQuote = (await router.getAmountsOut(ethers.parseEther("0.002"), [WETH, PAXG]))[1]; } catch (e) { probeQuote = 0n; }
  }
  probe.ethBalanceWei = ethBal.toString();
  probe.paxgBalanceWei = paxgBal.toString();
  probe.paxgAllowanceMorpho = allowance.toString();

  let valueWei = 0n, minOut = 0n, quote = 0n;
  if (cmd === "swap") {
    if (!probe.hasV2Pair || probeQuote === 0n) { console.error("FAIL no-v2-liquidity"); process.exit(1); }
    // size from the probe quote: implied ETH/USD, target $8, hard caps
    const paxgOut = Number(ethers.formatUnits(probeQuote, 18));
    const ethUsd = (paxgOut * PAXG_USD_APPROX) / 0.002;
    let valueEth = TARGET_USD / ethUsd;
    valueEth = Math.min(valueEth, Number(SWAP_CAP_ETH), Number(ethers.formatEther(ethBal)) * 0.5);
    valueWei = ethers.parseEther(valueEth.toFixed(6));
    const routerR = new ethers.Contract(V2_ROUTER, V2_ROUTER_IF, provider);
    quote = (await routerR.getAmountsOut(valueWei, [WETH, PAXG]))[1];
    if (quote === 0n) { console.error("FAIL no-liquidity-quote"); process.exit(1); }
    minOut = (quote * (100n - BigInt(SLIPPAGE_PCT))) / 100n;
    probe.impliedEthUsd = Math.round(ethUsd);
    probe.swapValueWei = valueWei.toString();
    probe.quotePaxgOutWei = quote.toString();
    probe.minOutWei = minOut.toString();
  }
  console.log(JSON.stringify(probe, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2));

  if (cmd === "swap") {
    if (valueWei === 0n || valueWei > ethBal) { console.error("FAIL insufficient-eth"); process.exit(1); }
    const deadline = Math.floor(Date.now() / 1000) + 1200;
    const router = new ethers.Contract(V2_ROUTER, V2_ROUTER_IF, wallet);
    const gasEst = await router.swapExactETHForTokens.estimateGas(minOut, [WETH, PAXG], BOT_WALLET, deadline, { value: valueWei });
    const fee = await provider.getFeeData();
    const maxFee = fee.maxFeePerGas || fee.gasPrice;
    const gasLimit = (gasEst * 110n) / 100n;
    capsOk(gasLimit * maxFee, valueWei);
    const tx = await sendWithFallback(wallet, await router.swapExactETHForTokens.populateTransaction(minOut, [WETH, PAXG], BOT_WALLET, deadline, { value: valueWei, gasLimit }));
    console.log(JSON.stringify({ swapTx: tx.hash }));
    const rc = await tx.wait(1);
    const got = (await paxgRead.balanceOf(BOT_WALLET)).toString();
    console.log(JSON.stringify({ swapStatus: rc.status, block: rc.blockNumber, paxgBalanceWei: got }));
  } else if (cmd === "approve") {
    const amount = paxgBal;
    if (amount === 0n) { console.error("FAIL no-paxg-run-swap-first"); process.exit(1); }
    if (allowance >= amount) { console.log(JSON.stringify({ approve: "skipped", allowance: allowance.toString(), balance: amount.toString() })); return; }
    const c = new ethers.Contract(PAXG, ERC20, wallet);
    const gasEst = await c.approve.estimateGas(MORPHO_BLUE, amount);
    const fee = await provider.getFeeData();
    const maxFee = fee.maxFeePerGas || fee.gasPrice;
    const gasLimit = (gasEst * 110n) / 100n;
    capsOk(gasLimit * maxFee, 0n);
    const data = ERC20.encodeFunctionData("approve", [MORPHO_BLUE, amount]);
    const tx = await sendWithFallback(wallet, { to: PAXG, data, gasLimit });
    console.log(JSON.stringify({ approveTx: tx.hash }));
    const rc = await tx.wait(1);
    console.log(JSON.stringify({ approveStatus: rc.status, block: rc.blockNumber, amount: amount.toString() }));
  } else if (cmd === "receipt") {
    const hash = process.argv[3];
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash || "")) { console.error("FAIL bad-hash"); process.exit(1); }
    const rc = await provider.getTransactionReceipt(hash);
    if (!rc) {
      const pendingTx = await provider.getTransaction(hash);
      const head = await provider.getBlock("latest");
      console.log(JSON.stringify({ pending: true, nonce: pendingTx ? pendingTx.nonce : null, maxFeePerGas: pendingTx && pendingTx.maxFeePerGas ? pendingTx.maxFeePerGas.toString() : null, gasPrice: pendingTx && pendingTx.gasPrice ? pendingTx.gasPrice.toString() : null, headBaseFee: head && head.baseFeePerGas ? head.baseFeePerGas.toString() : null }));
      return;
    }
    console.log(JSON.stringify({ status: rc.status, block: rc.blockNumber, gasUsed: rc.gasUsed.toString(), effectiveGasPrice: rc.gasPrice ? rc.gasPrice.toString() : null, paxgBalanceWei: paxgBal.toString(), ethBalanceWei: ethBal.toString() }));
  }
}

main().catch(e => { console.error("ERROR " + sanitize(e && e.message)); process.exit(1); });
