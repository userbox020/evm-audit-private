#!/usr/bin/env node
"use strict";

// deploy-aave-v4-v3-morpho-liquidator.js
// Orchestrator-lane deployment runner for the unified AaveV4FlashLoanLiquidator.
// Gated by coordination/live-execution-batch-aave-v4-v3-morpho.json.
// Private key material and RPC URLs stay strictly in-process and are never printed or persisted.
// CLI: --dry-run (default) | --execute

const fs = require("node:fs");
const path = require("node:path");
const { Wallet, Interface, getAddress } = require(path.join(__dirname, "node_modules", "ethers"));
const { resolveRpc, rpcCall } = require("./shared-rpc.js");

const ROOT = path.resolve(__dirname, "..");
const BUNDLE = path.join(ROOT, "coordination", "live-execution-batch-aave-v4-v3-morpho.json");
const ARTIFACT = path.join(ROOT, "exploits", "liquidation-bot", "out", "AaveV4FlashLoanLiquidator.sol", "AaveV4FlashLoanLiquidator.json");
const OUTDIR = path.join(ROOT, "reports", "raw", "fast", "aave-v4-v3-morpho-liquidator-deploy");
const ENV_FILES = [path.join(ROOT, ".env"), path.join(ROOT, ".env.exploit")];
const MAIN_ACCOUNT = "0x24e46e91dfaad1fa3d49c48aa85ca9306885ce0a";

function fail(code, detail = null) {
  console.log(JSON.stringify({ ok: false, reason: code, ...(detail ? { detail } : {}) }, null, 2));
  process.exit(1);
}

function loadBatch() {
  if (!fs.existsSync(BUNDLE)) fail("batch-missing");
  const b = JSON.parse(fs.readFileSync(BUNDLE, "utf8"));
  if (b.approved !== true) fail("batch-not-approved");
  if (Date.parse(b.expiresAt) < Date.now()) fail("batch-expired");
  if (String(b.account?.address || "").toLowerCase() !== MAIN_ACCOUNT.toLowerCase()) fail("batch-account-mismatch");
  return b;
}

function loadPrivateKey() {
  for (const file of ENV_FILES) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^(?:export\s+)?(?:[A-Za-z0-9_]+)\s*=\s*["']?(0x[0-9a-fA-F]{64}|[0-9a-fA-F]{64})["']?\s*(?:#.*)?$/);
      if (!m) continue;
      try {
        const candidate = m[1].startsWith("0x") ? m[1] : "0x" + m[1];
        const wallet = new Wallet(candidate);
        if (wallet.address.toLowerCase() === MAIN_ACCOUNT.toLowerCase()) return candidate;
      } catch (_) { continue; }
    }
  }
  fail("key-file-unavailable");
}

(async () => {
  const argv = process.argv.slice(2);
  const execute = argv.includes("--execute");
  const batch = loadBatch();

  const existingResultPath = path.join(OUTDIR, "result.json");
  if (fs.existsSync(existingResultPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(existingResultPath, "utf8"));
      if (prev.ok === true && prev.contractAddress) {
        console.log(JSON.stringify({ ok: true, stage: "ALREADY_DEPLOYED", contractAddress: prev.contractAddress, txHash: prev.txHash, blockNumber: prev.blockNumber }, null, 2));
        return;
      }
    } catch (_) {}
  }

  const artifact = JSON.parse(fs.readFileSync(ARTIFACT, "utf8"));
  const creationHex = "0x" + String(artifact.bytecode?.object || artifact.bytecode).replace(/^0x/i, "");

  const walletKey = loadPrivateKey();
  const wallet = new Wallet(walletKey);
  if (wallet.address.toLowerCase() !== MAIN_ACCOUNT.toLowerCase()) fail("key-account-mismatch");

  const rpc = await resolveRpc(1);
  if (!rpc) fail("no-qualified-provider");

  const [nonceHex, chainIdHex, latestBlock, balanceHex] = await Promise.all([
    rpcCall(rpc, "eth_getTransactionCount", [wallet.address, "pending"], 15000),
    rpcCall(rpc, "eth_chainId", [], 15000),
    rpcCall(rpc, "eth_getBlockByNumber", ["latest", false], 15000),
    rpcCall(rpc, "eth_getBalance", [wallet.address, "latest"], 15000),
  ]);

  if (!nonceHex || !chainIdHex || !latestBlock || !balanceHex) fail("rpc-preread-failed");
  if (Number(BigInt(chainIdHex)) !== 1) fail("wrong-chain-id");

  const gasEstHex = await rpcCall(rpc, "eth_estimateGas", [{ from: wallet.address, data: creationHex }, "latest"], 15000);
  if (!gasEstHex) fail("gas-estimate-failed");

  const gasLimit = (BigInt(gasEstHex) * 108n) / 100n;
  const maxDeployGasLimit = BigInt(batch.caps.maxDeployGasLimit || 3200000);
  const maxDeploySpendWei = BigInt(batch.caps.maxDeploySpendWei || "450000000000000");
  if (gasLimit > maxDeployGasLimit) fail("gas-limit-exceeds-batch-cap", { gasLimit: gasLimit.toString(), maxDeployGasLimit: maxDeployGasLimit.toString() });

  const baseFeeWei = latestBlock.baseFeePerGas ? BigInt(latestBlock.baseFeePerGas) : 40_000_000n;
  const tipWei = 50_000_000n; // 0.05 gwei priority tip for deployment
  const desiredMaxFeePerGas = baseFeeWei * 2n + tipWei;
  const capMaxFeePerGas = maxDeploySpendWei / gasLimit;
  const maxFeePerGas = desiredMaxFeePerGas <= capMaxFeePerGas ? desiredMaxFeePerGas : capMaxFeePerGas;
  if (maxFeePerGas <= baseFeeWei) fail("base-fee-above-batch-cap", { baseFeeWei: baseFeeWei.toString(), capMaxFeePerGas: capMaxFeePerGas.toString() });

  const maxSpendWei = gasLimit * maxFeePerGas;
  const balanceWei = BigInt(balanceHex);
  if (maxSpendWei > maxDeploySpendWei) fail("spend-exceeds-batch-cap");
  if (balanceWei < maxSpendWei) fail("insufficient-eth-balance");

  const nonce = Number(BigInt(nonceHex));
  const predictedAddress = getAddress(require(path.join(__dirname, "node_modules", "ethers")).getCreateAddress({ from: wallet.address, nonce }));

  const tx = {
    type: 2,
    chainId: 1,
    nonce,
    data: creationHex,
    gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas: tipWei < maxFeePerGas - baseFeeWei ? tipWei : (maxFeePerGas - baseFeeWei),
  };

  console.log(JSON.stringify({
    ok: true,
    stage: "ESTIMATE",
    mode: execute ? "EXECUTE" : "DRY_RUN",
    account: wallet.address,
    nonce,
    predictedContractAddress: predictedAddress,
    gasEstimate: BigInt(gasEstHex).toString(),
    gasLimit: gasLimit.toString(),
    baseFeeWei: baseFeeWei.toString(),
    maxFeePerGasWei: maxFeePerGas.toString(),
    maxPriorityFeePerGasWei: tx.maxPriorityFeePerGas.toString(),
    estimatedActualCostEth: Number(BigInt(gasEstHex) * (baseFeeWei + tx.maxPriorityFeePerGas)) / 1e18,
    maxPossibleSpendEth: Number(maxSpendWei) / 1e18,
    walletBalanceEth: Number(balanceWei) / 1e18
  }, null, 2));

  if (!execute) {
    console.log(JSON.stringify({ ok: true, stage: "DRY_RUN_ONLY_NOT_SENT", predictedContractAddress: predictedAddress }, null, 2));
    return;
  }

  const signedTx = await wallet.signTransaction(tx);
  const txHash = await rpcCall(rpc, "eth_sendRawTransaction", [signedTx], 20000);
  if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) fail("send-raw-transaction-failed");
  console.log(JSON.stringify({ ok: true, stage: "SENT", txHash, predictedContractAddress: predictedAddress }, null, 2));

  let receipt = null;
  for (let i = 0; i < 45; i++) {
    await new Promise(r => setTimeout(r, 3000));
    receipt = await rpcCall(rpc, "eth_getTransactionReceipt", [txHash], 12000).catch(() => null);
    if (receipt && receipt.status !== undefined && receipt.status !== null) break;
  }
  if (!receipt) fail("receipt-timeout", { txHash });

  const contractAddress = receipt.contractAddress ? getAddress(receipt.contractAddress) : predictedAddress;
  const iface = new Interface(["function owner() view returns (address)", "function MORPHO_BLUE() view returns (address)"]);
  const [ownerRaw, morphoRaw, codeHex] = await Promise.all([
    rpcCall(rpc, "eth_call", [{ to: contractAddress, data: iface.encodeFunctionData("owner", []) }, "latest"], 12000),
    rpcCall(rpc, "eth_call", [{ to: contractAddress, data: iface.encodeFunctionData("MORPHO_BLUE", []) }, "latest"], 12000),
    rpcCall(rpc, "eth_getCode", [contractAddress, "latest"], 12000),
  ]);
  const onchainOwner = ownerRaw ? iface.decodeFunctionResult("owner", ownerRaw)[0] : null;
  const onchainMorpho = morphoRaw ? iface.decodeFunctionResult("MORPHO_BLUE", morphoRaw)[0] : null;

  const gasUsed = BigInt(receipt.gasUsed);
  const effGasPrice = BigInt(receipt.effectiveGasPrice || maxFeePerGas);
  const actualFeeWei = gasUsed * effGasPrice;

  const result = {
    ok: receipt.status === "0x1" || receipt.status === "0x01",
    stage: "RECEIPT_VERIFIED",
    batchId: batch.batchId,
    deployedAt: new Date().toISOString(),
    txHash,
    contractAddress,
    blockNumber: Number(BigInt(receipt.blockNumber)),
    gasUsed: gasUsed.toString(),
    effectiveGasPriceWei: effGasPrice.toString(),
    actualFeeWei: actualFeeWei.toString(),
    actualFeeEth: Number(actualFeeWei) / 1e18,
    deployedCodeBytes: codeHex ? (codeHex.length - 2) / 2 : 0,
    onchainOwner,
    onchainMorphoBlue: onchainMorpho,
  };

  fs.mkdirSync(OUTDIR, { recursive: true });
  fs.writeFileSync(path.join(OUTDIR, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
})().catch((e) => {
  fail("unexpected-error", e && e.message ? e.message.replace(/https?:\/\/\S+/g, "[redacted]").replace(/0x[0-9a-fA-F]{64}/g, "<redacted>") : "error");
});
