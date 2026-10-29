#!/usr/bin/env node
"use strict";
// tools/execute-bridge-wallet-rebalance.js
//
// Orchestrator-lane runner for a MINIMAL signed Across V3 bridge rebalance:
// move ~0.0065 native ETH from Arbitrum One (chainId 42161) to Ethereum mainnet
// (chainId 1) for the bot wallet, using the in-tree-verified Arbitrum SpokePool.
//
// Gated by coordination/live-execution-batch-eth-bridge-rebalance.json.
// Default mode is --dry-run (offline build + estimate only). --execute signs.
//
// Address provenance (NO address is taken from memory; every one is cited):
//   Arbitrum SpokePool  0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A
//     targets/across-contracts-v2/broadcast/deployed-addresses.md:367
//     targets/across-contracts-v2/broadcast/deployed-addresses.json:1357
//   Arbitrum WETH (inputToken) 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1
//     targets/across-contracts-v2/generated/constants.json:574
//     targets/across-contracts-v2/broadcast/DeployArbitrumSpokePool.s.sol/42161/run-latest.json:10
//   Mainnet WETH (outputToken) 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
//     targets/across-contracts-v2/generated/constants.json:552
//     targets/across-contracts-v2/broadcast/DeployEthereumSpokePool.s.sol/1/run-latest.json:9
//   depositV3 interface: contracts/spoke-pools/SpokePool.sol:583 (address overload)
//     -> :505 deposit() -> :1304 _depositV3(); native path :1353-1355; dest unwrap :1657-1665.
//
// Key material convention: referenced ONLY via the process path selector
// LIVE_EXECUTION_KEY_PATH (strict loader tools/live-execution-evm-key.js) or, when
// that selector is unset, the gated env files (.env / .env.exploit) via exactly the
// mechanism used by tools/deploy-flash-liquidate-euler-evk.js. Key bytes never leave
// the process, are never printed/hashed/persisted, and are never passed on a command line.
//
// CLI: --dry-run (default; offline) | --execute | --batch <path>
// Exit code 0 on ANY honest fail-closed refusal (the tool must not crash non-zero when
// it correctly refuses); non-zero only on an unexpected internal error.

const fs = require("node:fs");
const path = require("node:path");
const {
  Wallet,
  Interface,
  getAddress,
  id,
} = require(path.join(__dirname, "node_modules", "ethers"));
const { resolveRpc } = require("./shared-rpc");
const keyModule = require("./live-execution-evm-key.js");

const WORKSPACE = path.resolve(__dirname, "..");
const DEFAULT_BATCH = path.join(WORKSPACE, "coordination", "live-execution-batch-eth-bridge-rebalance.json");
const HANDOFF = path.join(WORKSPACE, "coordination", "eth-bridge-rebalance-handoff.md");
const ENV_FILES = [path.join(WORKSPACE, ".env"), path.join(WORKSPACE, ".env.exploit")];

const MAIN_ACCOUNT = "0x24e46e91dfaad1fa3d49c48aa85ca9306885ce0a";
const CHAIN_ID = 42161;

// In-tree-cited trusted addresses (see header). Used as a cross-check against the
// batch so a tampered/edited batch cannot silently redirect the deposit.
const SPOKE_POOL = "0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A";
const ARB_WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
const MAINNET_WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const DEST_CHAIN_ID = 1;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const IFACE = new Interface([
  "function depositV3(address depositor,address recipient,address inputToken,address outputToken,uint256 inputAmount,uint256 outputAmount,uint256 destinationChainId,address exclusiveRelayer,uint32 quoteTimestamp,uint32 fillDeadline,uint32 exclusivityDeadline,bytes message) payable",
  "event FundsDeposited(bytes32 inputToken,bytes32 outputToken,uint256 inputAmount,uint256 outputAmount,uint256 indexed destinationChainId,uint256 indexed depositId,uint32 quoteTimestamp,uint32 fillDeadline,uint32 exclusivityDeadline,bytes32 indexed depositor,bytes32 recipient,bytes32 exclusiveRelayer,bytes message)",
]);
const WRAPPED_NATIVE_TOKEN_SELECTOR = id("wrappedNativeToken()").slice(0, 10);
const FUNDS_DEPOSITED_TOPIC = id(
  "FundsDeposited(bytes32,bytes32,uint256,uint256,uint256,uint256,uint32,uint32,uint32,bytes32,bytes32,bytes32,bytes)"
);

function emit(obj) { process.stdout.write(JSON.stringify(obj, null, 2) + "\n"); }
// Honest fail-closed refusal: report and exit 0.
function refuse(reason, extra) { emit({ ok: false, failClosed: true, reason, ...(extra || {}) }); return null; }

async function rpcOn(url, method, params) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 15_000);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: c.signal,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const b = await r.json();
    if (b.error) throw new Error("rpc:" + String(b.error.message || "").slice(0, 40));
    if (b.result === undefined || b.result === null) throw new Error("rpc-shape-failure");
    return b.result;
  } finally {
    clearTimeout(t);
  }
}

function isQuantity(v) { return typeof v === "string" && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(v); }

function loadBatch(batchPath) {
  const b = JSON.parse(fs.readFileSync(batchPath, "utf8"));
  if (!b || typeof b !== "object") return { error: "batch-unreadable" };
  if (b.schema !== "live-execution-batch/v1") return { error: "batch-schema-mismatch" };
  if (b.approved !== true) return { error: "batch-not-approved" };
  if (Number.isNaN(Date.parse(b.expiresAt)) || Date.parse(b.expiresAt) < Date.now()) return { error: "batch-expired" };
  if (b.chainId !== CHAIN_ID) return { error: "batch-chain-mismatch" };
  if (!b.account || String(b.account.address).toLowerCase() !== MAIN_ACCOUNT) return { error: "batch-account-mismatch" };
  const target = Array.isArray(b.targets) ? b.targets[0] : null;
  if (!target || target.kind !== "bridge-deposit") return { error: "batch-target-not-bridge-deposit" };
  if (getAddress(target.address) !== getAddress(SPOKE_POOL)) return { error: "batch-target-address-mismatch" };
  if (getAddress(target.inputToken) !== getAddress(ARB_WETH)) return { error: "batch-input-token-mismatch" };
  if (getAddress(target.outputToken) !== getAddress(MAINNET_WETH)) return { error: "batch-output-token-mismatch" };
  if (Number(target.destChainId) !== DEST_CHAIN_ID) return { error: "batch-dest-chain-mismatch" };
  if (!target.recipient || getAddress(target.recipient) !== getAddress(MAIN_ACCOUNT)) return { error: "batch-recipient-mismatch" };
  return { batch: b, target };
}

// Process-path-selector (strict) first; gated env-file mechanism (deploy-flash) second.
// If the selector is present but unusable we fail closed rather than silently falling back.
function loadPrivateKey() {
  const selector = process.env.LIVE_EXECUTION_KEY_PATH;
  if (typeof selector === "string" && selector.length > 0) {
    try {
      const loaded = keyModule.load({ keyPath: selector });
      try {
        if (getAddress(loaded.signer.address).toLowerCase() === MAIN_ACCOUNT) return loaded.signer.privateKey;
      } finally {
        if (loaded.keyBytes && typeof loaded.keyBytes.fill === "function") loaded.keyBytes.fill(0);
      }
    } catch (_) {
      return null; // selector set but unusable -> honest fail-closed
    }
    return null;
  }
  for (const file of ENV_FILES) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^(?:[A-Z0-9_]+)\s*=\s*(0x[0-9a-fA-F]{64}|[0-9a-fA-F]{64})\s*(?:#.*)?$/);
      if (!m) continue;
      try {
        const wallet = new Wallet(m[1].startsWith("0x") ? m[1] : "0x" + m[1]);
        if (wallet.address.toLowerCase() === MAIN_ACCOUNT) return m[1].startsWith("0x") ? m[1] : "0x" + m[1];
      } catch (_) { continue; }
    }
  }
  return null;
}

(async () => {
  const argv = process.argv.slice(2);
  const execute = argv.includes("--execute");
  const batchIdx = argv.indexOf("--batch");
  const batchPath = batchIdx !== -1 && argv[batchIdx + 1]
    ? path.resolve(process.cwd(), argv[batchIdx + 1])
    : DEFAULT_BATCH;

  // ---- gate ladder (batch present / approved / unexpired / account+chain+caps) ----
  let loadedBatch;
  try { loadedBatch = loadBatch(batchPath); }
  catch (_) { return refuse("batch-unreadable"); }
  if (loadedBatch.error) return refuse(loadedBatch.error);
  const { batch, target } = loadedBatch;
  const caps = batch.caps || {};

  const sourceAmountWei = BigInt(target.sourceAmountWei);
  if (sourceAmountWei <= 0n) return refuse("batch-source-amount-invalid");

  const outputAmountWei = target.outputAmountWei !== undefined
    ? BigInt(target.outputAmountWei)
    : sourceAmountWei - (sourceAmountWei * BigInt(target.relayerFeeCeilingBps ?? 100)) / 10000n;
  if (outputAmountWei <= 0n || outputAmountWei > sourceAmountWei) return refuse("output-amount-invalid");
  const minOutput = BigInt(target.minOutputAmountWei ?? 0);
  if (minOutput > 0n && outputAmountWei < minOutput) return refuse("output-below-batch-floor");

  const privateKey = loadPrivateKey();
  if (!privateKey) return refuse("key-file-unavailable");
  const wallet = new Wallet(privateKey);
  if (wallet.address.toLowerCase() !== MAIN_ACCOUNT) return refuse("key-account-mismatch");

  // ---- qualified L2 endpoint (shared-rpc; URL never logged) ----
  const provider = await resolveRpc(CHAIN_ID);
  if (!provider) return refuse("no-qualified-provider");

  // ---- SpokePool integrity: deployed code present + wrappedNativeToken matches in-tree WETH ----
  let code;
  try { code = await rpcOn(provider, "eth_getCode", [SPOKE_POOL, "latest"]); }
  catch (_) { return refuse("spokepool-code-unreadable"); }
  if (typeof code !== "string" || code.length <= 2) return refuse("spokepool-code-empty");

  let wrappedNative;
  try {
    const raw = await rpcOn(provider, "eth_call", [{ to: SPOKE_POOL, data: WRAPPED_NATIVE_TOKEN_SELECTOR }, "latest"]);
    if (typeof raw !== "string" || raw.length < 42) return refuse("spokepool-staticcall-unreadable");
    wrappedNative = getAddress("0x" + raw.slice(-40));
  } catch (_) { return refuse("spokepool-staticcall-failed"); }
  if (wrappedNative !== getAddress(ARB_WETH)) return refuse("spokepool-native-token-mismatch");

  // ---- live chain state ----
  let nonce, block, gasPriceHex, gasEstimate;
  try {
    [nonce, block, gasPriceHex] = await Promise.all([
      rpcOn(provider, "eth_getTransactionCount", [wallet.address, "pending"]),
      rpcOn(provider, "eth_getBlockByNumber", ["latest", false]),
      rpcOn(provider, "eth_gasPrice", []),
    ]);
  } catch (_) { return refuse("rpc-state-read-failed"); }
  if (!isQuantity(gasPriceHex) || !block || !isQuantity(block.timestamp)) return refuse("rpc-state-shape-failure");

  const quoteTimestamp = Number(BigInt(block.timestamp));
  const fillDeadline = quoteTimestamp + Number(target.fillDeadlineOffset ?? 21600);

  const data = IFACE.encodeFunctionData("depositV3", [
    wallet.address,
    getAddress(MAIN_ACCOUNT),
    getAddress(ARB_WETH),
    getAddress(MAINNET_WETH),
    sourceAmountWei,
    outputAmountWei,
    BigInt(DEST_CHAIN_ID),
    getAddress(ZERO_ADDRESS),
    quoteTimestamp,
    fillDeadline,
    Number(target.exclusivityDeadline ?? 0),
    "0x",
  ]);

  try {
    gasEstimate = await rpcOn(provider, "eth_estimateGas", [
      { from: wallet.address, to: SPOKE_POOL, data, value: "0x" + sourceAmountWei.toString(16) },
    ]);
  } catch (_) { return refuse("gas-estimate-failed"); }

  const gasLimit = (BigInt(gasEstimate) * 125n) / 100n;
  const batchMaxGasLimit = BigInt(caps.maxGasLimitPerTransaction ?? 0);
  const batchMaxValue = BigInt(caps.maxNativeSpendPerTransactionWei ?? 0);
  const batchMaxTotal = BigInt(caps.maxTotalNativeSpendPerTransactionWei ?? caps.maxNativeSpendPerTransactionWei ?? 0);
  if (batchMaxGasLimit > 0n && gasLimit > batchMaxGasLimit) return refuse("gas-limit-exceeds-batch-cap");
  if (batchMaxValue > 0n && sourceAmountWei > batchMaxValue) return refuse("bridge-value-exceeds-batch-cap");

  const gasPrice = BigInt(gasPriceHex);
  const maxFeePerGas = gasPrice * 2n;
  if (maxFeePerGas <= 0n) return refuse("zero-fee");
  const maxPriorityFeePerGas = 0n; // Arbitrum accepts a zero tip; eth_gasPrice already carries the L1 surcharge.
  const estGasCost = gasLimit * maxFeePerGas;
  if (batchMaxTotal > 0n && (sourceAmountWei + estGasCost) > batchMaxTotal) return refuse("total-spend-exceeds-batch-cap");

  // ---- source-balance precheck (value + gas) ----
  let balance;
  try { balance = BigInt(await rpcOn(provider, "eth_getBalance", [wallet.address, "latest"])); }
  catch (_) { return refuse("balance-read-failed"); }
  if (balance < sourceAmountWei + estGasCost) return refuse("insufficient-source-balance");

  const tx = {
    type: 2,
    chainId: CHAIN_ID,
    nonce: Number(BigInt(nonce)),
    to: getAddress(SPOKE_POOL),
    value: sourceAmountWei,
    data,
    gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas,
  };

  emit({
    ok: true,
    stage: "ESTIMATE",
    batchId: batch.batchId,
    mode: execute ? "EXECUTE" : "DRY_RUN",
    protocol: "across-v3",
    spokePool: getAddress(SPOKE_POOL),
    chainId: CHAIN_ID,
    nonce: tx.nonce,
    inputToken: getAddress(ARB_WETH),
    outputToken: getAddress(MAINNET_WETH),
    sourceAmountWei: sourceAmountWei.toString(),
    outputAmountWei: outputAmountWei.toString(),
    destinationChainId: DEST_CHAIN_ID,
    quoteTimestamp,
    fillDeadline,
    gasLimit: gasLimit.toString(),
    maxFeePerGasWei: maxFeePerGas.toString(),
    estimatedGasCostWei: estGasCost.toString(),
  });

  if (!execute) { emit({ ok: true, stage: "DRY_RUN_ONLY_NOT_SENT" }); return; }

  // ---- exactly ONE signed bridge tx ----
  const signed = await wallet.signTransaction(tx);
  let txHash;
  try { txHash = await rpcOn(provider, "eth_sendRawTransaction", [signed]); }
  catch (_) { return refuse("broadcast-failed"); }
  emit({ ok: true, stage: "SENT", txHash });

  // ---- first receipt capture only (bounded); never poll for fill completion ----
  let receipt = null;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 4_000));
    try {
      receipt = await rpcOn(provider, "eth_getTransactionReceipt", [txHash]);
      if (receipt && receipt.status) break;
    } catch (_) { /* keep waiting within bound */ }
  }
  if (!receipt || receipt.status === null || receipt.status === undefined) {
    emit({ ok: false, failClosed: true, reason: "receipt-timeout", txHash });
    return;
  }

  let depositId = null;
  for (const log of receipt.logs || []) {
    if (String(log.address).toLowerCase() !== SPOKE_POOL.toLowerCase()) continue;
    if (log.topics && log.topics[0] === FUNDS_DEPOSITED_TOPIC && log.topics.length > 2) {
      depositId = BigInt(log.topics[2]).toString();
      break;
    }
  }

  const statusOk = receipt.status === "0x1" || receipt.status === "0x01";
  const result = {
    ok: statusOk,
    stage: "RECEIPT",
    txHash,
    spokePoolDepositId: depositId,
    blockNumber: Number(BigInt(receipt.blockNumber)),
    gasUsed: BigInt(receipt.gasUsed).toString(),
    effectiveGasPriceWei: BigInt(receipt.effectiveGasPrice || 0).toString(),
  };
  emit(result);

  const handoffLine =
    `- ${new Date().toISOString()} | batch ${batch.batchId} | across-v3 depositV3 | tx ${txHash} | ` +
    `spokePoolDepositId ${depositId ?? "unparsed"} | block ${result.blockNumber} | status ${statusOk ? "success" : "failed"}\n`;
  try {
    if (!fs.existsSync(HANDOFF)) {
      fs.writeFileSync(
        HANDOFF,
        "# Handoff — Arbitrum→Ethereum Across V3 bridge rebalance\n\n" +
          "Runner-written record of the single signed bridge deposit. No fill polling; fill is relayer-executed.\n\n",
        "utf8"
      );
    }
    fs.appendFileSync(HANDOFF, handoffLine, "utf8");
  } catch (_) { /* handoff write is best-effort */ }
})().catch((e) => { emit({ ok: false, failClosed: true, reason: "internal-error" }); process.exitCode = 1; });
