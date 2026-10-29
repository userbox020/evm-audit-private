#!/usr/bin/env node
"use strict";
// tools/execute-bridge-l2-sweep.js
//
// Orchestrator-lane runner for a MULTI-LEG signed Across V3 bridge sweep:
// three native-ETH depositV3 legs into Ethereum mainnet (chainId 1) for the bot
// wallet -- Base (8453) -> 1, Optimism (10) -> 1, Scroll (534352) -> 1 -- using
// only in-tree-verified SpokePools (>=2 corroborations per chain).
//
// Mirrors tools/execute-bridge-wallet-rebalance.js exactly, with the loop
// generalized over legs. Gated by
// coordination/live-execution-batch-eth-bridge-l2-sweep.json.
// Default mode is --dry-run (offline build + estimate only). --execute signs.
//
// Address provenance (NO address is taken from memory; every one is cited):
//   Base SpokePool    0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64
//     targets/across-contracts-v2/broadcast/deployed-addresses.md:321
//     targets/across-contracts-v2/broadcast/deployed-addresses.json:1181
//   Optimism SpokePool 0x6f26Bf09B1C792e3228e5467807a900A503c0281
//     targets/across-contracts-v2/broadcast/deployed-addresses.md:78
//     targets/across-contracts-v2/broadcast/deployed-addresses.json:259
//   Scroll SpokePool  0x3baD7AD0728f9917d1Bf08af5782dCbD516cDd96
//     targets/across-contracts-v2/broadcast/deployed-addresses.md:434
//     targets/across-contracts-v2/broadcast/deployed-addresses.json:1688
//   Base WETH (inputToken)     0x4200000000000000000000000000000000000006
//     targets/across-contracts-v2/generated/constants.json:569
//     targets/across-contracts-v2/broadcast/DeployBaseSpokePool.s.sol/8453/run-latest.json:10
//   Optimism WETH (inputToken) 0x4200000000000000000000000000000000000006
//     targets/across-contracts-v2/generated/constants.json:553
//     targets/across-contracts-v2/broadcast/DeployOptimismSpokePool.s.sol/10/run-latest.json:10
//   Scroll WETH (inputToken)   0x5300000000000000000000000000000000000004
//     targets/across-contracts-v2/generated/constants.json:582
//     targets/across-contracts-v2/broadcast/DeployScrollSpokePool.s.sol/534352/run-latest.json:9
//   Mainnet WETH (outputToken) 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
//     targets/across-contracts-v2/generated/constants.json:552
//     targets/across-contracts-v2/broadcast/DeployEthereumSpokePool.s.sol/1/run-latest.json:9
//   depositV3 interface: contracts/spoke-pools/SpokePool.sol:583 (address overload)
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
const DEFAULT_BATCH = path.join(WORKSPACE, "coordination", "live-execution-batch-eth-bridge-l2-sweep.json");
const HANDOFF = path.join(WORKSPACE, "coordination", "eth-bridge-l2-sweep-handoff.md");
const STATUS_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "eth-bridge-l2-sweep-status.json");
const ENV_FILES = [path.join(WORKSPACE, ".env"), path.join(WORKSPACE, ".env.exploit")];

const MAIN_ACCOUNT = "0x24e46e91dfaad1fa3d49c48aa85ca9306885ce0a";
const BATCH_CHAIN_LABEL = "multi-l2-to-mainnet";
const DEST_CHAIN_ID = 1;
const MAINNET_WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// In-tree-verified registry (see header). Each chain must carry >=2 independent
// corroboration citations, otherwise a matching batch leg is EXCLUDED as
// bridge-protocol-unverified-chain:<id> (honest MISS, never fabricated).
const LEGS = {
  8453: {
    chain: "base",
    spokePool: "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64",
    weth: "0x4200000000000000000000000000000000000006",
    corroborations: [
      "targets/across-contracts-v2/broadcast/deployed-addresses.md:321",
      "targets/across-contracts-v2/broadcast/deployed-addresses.json:1181",
    ],
  },
  10: {
    chain: "optimism",
    spokePool: "0x6f26Bf09B1C792e3228e5467807a900A503c0281",
    weth: "0x4200000000000000000000000000000000000006",
    corroborations: [
      "targets/across-contracts-v2/broadcast/deployed-addresses.md:78",
      "targets/across-contracts-v2/broadcast/deployed-addresses.json:259",
    ],
  },
  534352: {
    chain: "scroll",
    spokePool: "0x3baD7AD0728f9917d1Bf08af5782dCbD516cDd96",
    weth: "0x5300000000000000000000000000000000000004",
    corroborations: [
      "targets/across-contracts-v2/broadcast/deployed-addresses.md:434",
      "targets/across-contracts-v2/broadcast/deployed-addresses.json:1688",
    ],
  },
};

const IFACE = new Interface([
  "function depositV3(address depositor,address recipient,address inputToken,address outputToken,uint256 inputAmount,uint256 outputAmount,uint256 destinationChainId,address exclusiveRelayer,uint32 quoteTimestamp,uint32 fillDeadline,uint32 exclusivityDeadline,bytes message) payable",
  "event FundsDeposited(bytes32 inputToken,bytes32 outputToken,uint256 inputAmount,uint256 outputAmount,uint256 indexed destinationChainId,uint256 indexed depositId,uint32 quoteTimestamp,uint32 fillDeadline,uint32 exclusivityDeadline,bytes32 indexed depositor,bytes32 recipient,bytes32 exclusiveRelayer,bytes message)",
]);
const WRAPPED_NATIVE_TOKEN_SELECTOR = id("wrappedNativeToken()").slice(0, 10);
const FUNDS_DEPOSITED_TOPIC = id(
  "FundsDeposited(bytes32,bytes32,uint256,uint256,uint256,uint256,uint32,uint32,uint32,bytes32,bytes32,bytes32,bytes)"
);

const legRows = [];
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

// Structural (batch-level) parse gate. Approval + expiry are enforced AFTER the
// read-only in-tree per-leg verification pass so an unapproved/expired DRAFT still
// reports honest per-leg corroboration status before it fails closed.
function loadBatch(batchPath) {
  const b = JSON.parse(fs.readFileSync(batchPath, "utf8"));
  if (!b || typeof b !== "object") return { error: "batch-unreadable" };
  if (b.schema !== "live-execution-batch/v1") return { error: "batch-schema-mismatch" };
  if (b.chain !== BATCH_CHAIN_LABEL) return { error: "batch-chain-label-mismatch" };
  if (Number(b.chainId) !== DEST_CHAIN_ID) return { error: "batch-dest-chain-mismatch" };
  if (!b.account || String(b.account.address).toLowerCase() !== MAIN_ACCOUNT) return { error: "batch-account-mismatch" };
  if (!Array.isArray(b.targets) || b.targets.length === 0) return { error: "batch-targets-empty" };
  return { batch: b };
}

// Batch-level approval + expiry, surfaced as a per-leg fail-closed reason.
function approvalGateError(batch) {
  if (batch.approved !== true) return "batch-not-approved";
  if (Number.isNaN(Date.parse(batch.expiresAt)) || Date.parse(batch.expiresAt) < Date.now()) return "batch-expired";
  return null;
}

// Pure in-tree per-leg verification. No network, no key. Returns a row with
// { chain, chainId, verified, excluded, reason, ... }.
function verifyLeg(target) {
  const chainId = Number(target && target.chainId);
  const row = {
    chain: target && target.chain ? String(target.chain) : null,
    chainId: Number.isFinite(chainId) ? chainId : null,
    spokePool: null,
    sourceAmountWei: null,
    verified: false,
    excluded: true,
  };
  if (!target || target.kind !== "bridge-deposit") { row.reason = "leg-not-bridge-deposit"; return row; }
  const reg = Number.isFinite(chainId) ? LEGS[chainId] : null;
  if (!reg || !Array.isArray(reg.corroborations) || reg.corroborations.length < 2) {
    // Honest MISS: no >=2-corrobation in-tree record for this chain.
    row.status = `bridge-protocol-unverified-chain:${chainId}`;
    row.reason = row.status;
    row.corroborations = reg && reg.corroborations ? reg.corroborations : [];
    return row;
  }
  row.chain = reg.chain;
  row.corroborations = reg.corroborations.slice();
  try {
    if (getAddress(target.address) !== getAddress(reg.spokePool)) { row.reason = "leg-spokepool-address-mismatch"; return row; }
    if (getAddress(target.inputToken) !== getAddress(reg.weth)) { row.reason = "leg-input-token-mismatch"; return row; }
    if (getAddress(target.outputToken) !== getAddress(MAINNET_WETH)) { row.reason = "leg-output-token-mismatch"; return row; }
    if (Number(target.destChainId) !== DEST_CHAIN_ID) { row.reason = "leg-dest-chain-mismatch"; return row; }
    if (!target.recipient || getAddress(target.recipient) !== getAddress(MAIN_ACCOUNT)) { row.reason = "leg-recipient-mismatch"; return row; }
  } catch (_) { row.reason = "leg-address-parse-failure"; return row; }
  if (!target.sourceAmountWei) { row.reason = "leg-source-amount-missing"; return row; }
  try { if (BigInt(target.sourceAmountWei) <= 0n) { row.reason = "leg-source-amount-invalid"; return row; } }
  catch (_) { row.reason = "leg-source-amount-invalid"; return row; }
  row.spokePool = reg.spokePool;
  row.weth = reg.weth;
  row.sourceAmountWei = String(target.sourceAmountWei);
  row.verified = true;
  row.excluded = false;
  return row;
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

function writeStatus(summary) {
  try {
    fs.mkdirSync(path.dirname(STATUS_FILE), { recursive: true });
    fs.writeFileSync(STATUS_FILE, JSON.stringify(summary, null, 2) + "\n", "utf8");
  } catch (_) { /* status write is best-effort */ }
}

function appendHandoff(batchId, row) {
  const line =
    `- ${new Date().toISOString()} | batch ${batchId} | across-v3 depositV3 | chain ${row.chain} (${row.chainId}) | tx ${row.txHash} | ` +
    `spokePoolDepositId ${row.spokePoolDepositId ?? "unparsed"} | block ${row.blockNumber} | status ${row.statusOk ? "success" : "failed"}\n`;
  try {
    if (!fs.existsSync(HANDOFF)) {
      fs.writeFileSync(
        HANDOFF,
        "# Handoff — L2→Ethereum Across V3 bridge sweep (Base / Optimism / Scroll -> mainnet)\n\n" +
          "Runner-written record of one signed bridge deposit per leg. No fill polling; fill is relayer-executed.\n\n",
        "utf8"
      );
    }
    fs.appendFileSync(HANDOFF, line, "utf8");
  } catch (_) { /* handoff write is best-effort */ }
}

(async () => {
  const argv = process.argv.slice(2);
  const execute = argv.includes("--execute");
  const batchIdx = argv.indexOf("--batch");
  const batchPath = batchIdx !== -1 && argv[batchIdx + 1]
    ? path.resolve(process.cwd(), argv[batchIdx + 1])
    : DEFAULT_BATCH;

  // ---- global gate ladder (batch present / approved / unexpired / account+chain) ----
  let loadedBatch;
  try { loadedBatch = loadBatch(batchPath); }
  catch (_) { return refuse("batch-unreadable"); }
  if (loadedBatch.error) return refuse(loadedBatch.error);
  const { batch } = loadedBatch;
  const caps = batch.caps || {};

  // ---- PER-LEG in-tree verification pass (no network, no key) ----
  const verified = [];
  for (const target of batch.targets) {
    const row = verifyLeg(target);
    legRows.push(row);
    emit({ ok: true, stage: "LEG_VERIFY", batchId: batch.batchId, ...row });
    if (row.verified) verified.push({ target, row });
  }
  if (verified.length === 0) {
    writeStatus(buildSummary(batch, execute, legRows));
    return refuse("no-verified-legs", { legs: legRows.map((r) => ({ chainId: r.chainId, status: r.reason })) });
  }

  // ---- batch-level approval / expiry gate (per-leg fail-closed reason) ----
  const gateError = approvalGateError(batch);
  if (gateError) {
    for (const { row } of verified) { row.reason = gateError; }
    writeStatus(buildSummary(batch, execute, legRows));
    emit({ ok: true, stage: "LEG_VERIFICATION_SUMMARY", batchId: batch.batchId, verified: verified.length, excluded: legRows.length - verified.length, legs: legRows.map((r) => ({ chain: r.chain, chainId: r.chainId, verified: r.verified, status: r.reason })) });
    return refuse(gateError, { legs: legRows.map((r) => ({ chainId: r.chainId, status: r.reason })) });
  }

  const privateKey = loadPrivateKey();
  if (!privateKey) {
    for (const { row } of verified) { row.reason = "key-file-unavailable"; }
    writeStatus(buildSummary(batch, execute, legRows));
    return refuse("key-file-unavailable");
  }
  const wallet = new Wallet(privateKey);
  if (wallet.address.toLowerCase() !== MAIN_ACCOUNT) {
    for (const { row } of verified) { row.reason = "key-account-mismatch"; }
    writeStatus(buildSummary(batch, execute, legRows));
    return refuse("key-account-mismatch");
  }

  const capPerLegValue = (chainId) => {
    const map = caps.maxNativeSpendPerLegWei;
    if (map && map[String(chainId)] !== undefined) return BigInt(map[String(chainId)]);
    return BigInt(caps.maxNativeSpendPerTransactionWei ?? 0);
  };
  const batchMaxGasLimit = BigInt(caps.maxGasLimitPerTransaction ?? 0);
  const batchMaxTotal = BigInt(caps.maxTotalNativeSpendPerTransactionWei ?? caps.maxNativeSpendPerTransactionWei ?? 0);

  // ---- iterate verified legs; each is independently fail-closed ----
  for (const { target, row } of verified) {
    const chainId = row.chainId;
    const reg = LEGS[chainId];
    const sourceAmountWei = BigInt(target.sourceAmountWei);

    const outputAmountWei = target.outputAmountWei !== undefined
      ? BigInt(target.outputAmountWei)
      : sourceAmountWei - (sourceAmountWei * BigInt(target.relayerFeeCeilingBps ?? 100)) / 10000n;
    if (outputAmountWei <= 0n || outputAmountWei > sourceAmountWei) { row.reason = "output-amount-invalid"; continue; }
    const minOutput = BigInt(target.minOutputAmountWei ?? 0);
    if (minOutput > 0n && outputAmountWei < minOutput) { row.reason = "output-below-batch-floor"; continue; }

    // ---- qualified per-chain endpoint (shared-rpc; URL never logged) ----
    const provider = await resolveRpc(chainId);
    if (!provider) { row.reason = "no-qualified-provider"; continue; }
    row.providerResolved = true;

    // ---- SpokePool integrity: deployed code present + wrappedNativeToken matches in-tree WETH ----
    let code;
    try { code = await rpcOn(provider, "eth_getCode", [reg.spokePool, "latest"]); }
    catch (_) { row.reason = "spokepool-code-unreadable"; continue; }
    if (typeof code !== "string" || code.length <= 2) { row.reason = "spokepool-code-empty"; continue; }

    let wrappedNative;
    try {
      const raw = await rpcOn(provider, "eth_call", [{ to: reg.spokePool, data: WRAPPED_NATIVE_TOKEN_SELECTOR }, "latest"]);
      if (typeof raw !== "string" || raw.length < 42) { row.reason = "spokepool-staticcall-unreadable"; continue; }
      wrappedNative = getAddress("0x" + raw.slice(-40));
    } catch (_) { row.reason = "spokepool-staticcall-failed"; continue; }
    if (wrappedNative !== getAddress(reg.weth)) { row.reason = "spokepool-native-token-mismatch"; continue; }

    // ---- live chain state ----
    let nonce, block, gasPriceHex, gasEstimate;
    try {
      [nonce, block, gasPriceHex] = await Promise.all([
        rpcOn(provider, "eth_getTransactionCount", [wallet.address, "pending"]),
        rpcOn(provider, "eth_getBlockByNumber", ["latest", false]),
        rpcOn(provider, "eth_gasPrice", []),
      ]);
    } catch (_) { row.reason = "rpc-state-read-failed"; continue; }
    if (!isQuantity(gasPriceHex) || !block || !isQuantity(block.timestamp)) { row.reason = "rpc-state-shape-failure"; continue; }

    const quoteTimestamp = Number(BigInt(block.timestamp));
    const fillDeadline = quoteTimestamp + Number(target.fillDeadlineOffset ?? 21600);

    const data = IFACE.encodeFunctionData("depositV3", [
      wallet.address,
      getAddress(MAIN_ACCOUNT),
      getAddress(reg.weth),
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
        { from: wallet.address, to: reg.spokePool, data, value: "0x" + sourceAmountWei.toString(16) },
      ]);
    } catch (_) { row.reason = "gas-estimate-failed"; continue; }

    const gasLimit = (BigInt(gasEstimate) * 125n) / 100n;
    const legValueCap = capPerLegValue(chainId);
    if (batchMaxGasLimit > 0n && gasLimit > batchMaxGasLimit) { row.reason = "gas-limit-exceeds-batch-cap"; continue; }
    if (legValueCap > 0n && sourceAmountWei > legValueCap) { row.reason = "bridge-value-exceeds-batch-cap"; continue; }

    const gasPrice = BigInt(gasPriceHex);
    const maxFeePerGas = gasPrice * 2n;
    if (maxFeePerGas <= 0n) { row.reason = "zero-fee"; continue; }
    const maxPriorityFeePerGas = 0n; // L2 sequencers accept a zero tip; eth_gasPrice already carries the L1 surcharge.
    const estGasCost = gasLimit * maxFeePerGas;
    if (batchMaxTotal > 0n && (sourceAmountWei + estGasCost) > batchMaxTotal) { row.reason = "total-spend-exceeds-batch-cap"; continue; }

    // ---- source-balance precheck (value + gas) ON THIS CHAIN ----
    let balance;
    try { balance = BigInt(await rpcOn(provider, "eth_getBalance", [wallet.address, "latest"])); }
    catch (_) { row.reason = "balance-read-failed"; continue; }
    if (balance < sourceAmountWei + estGasCost) { row.reason = "insufficient-source-balance"; continue; }

    const tx = {
      type: 2,
      chainId,
      nonce: Number(BigInt(nonce)),
      to: getAddress(reg.spokePool),
      value: sourceAmountWei,
      data,
      gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas,
    };

    row.stage = "ESTIMATE";
    row.inputToken = getAddress(reg.weth);
    row.outputToken = getAddress(MAINNET_WETH);
    row.outputAmountWei = outputAmountWei.toString();
    row.nonce = tx.nonce;
    row.gasLimit = gasLimit.toString();
    row.maxFeePerGasWei = maxFeePerGas.toString();
    row.estimatedGasCostWei = estGasCost.toString();
    row.balanceWei = balance.toString();
    emit({
      ok: true,
      stage: "ESTIMATE",
      batchId: batch.batchId,
      mode: execute ? "EXECUTE" : "DRY_RUN",
      protocol: "across-v3",
      chain: reg.chain,
      chainId,
      spokePool: getAddress(reg.spokePool),
      inputToken: getAddress(reg.weth),
      outputToken: getAddress(MAINNET_WETH),
      sourceAmountWei: sourceAmountWei.toString(),
      outputAmountWei: outputAmountWei.toString(),
      destinationChainId: DEST_CHAIN_ID,
      nonce: tx.nonce,
      gasLimit: gasLimit.toString(),
      maxFeePerGasWei: maxFeePerGas.toString(),
      estimatedGasCostWei: estGasCost.toString(),
    });

    if (!execute) { row.stage = "DRY_RUN_ONLY_NOT_SENT"; continue; }

    // ---- exactly ONE signed bridge tx for this leg ----
    const signed = await wallet.signTransaction(tx);
    let txHash;
    try { txHash = await rpcOn(provider, "eth_sendRawTransaction", [signed]); }
    catch (_) { row.reason = "broadcast-failed"; continue; }
    row.txHash = txHash;
    emit({ ok: true, stage: "SENT", chain: reg.chain, chainId, txHash });

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
      row.stage = "RECEIPT";
      row.reason = "receipt-timeout";
      emit({ ok: false, failClosed: true, reason: "receipt-timeout", chain: reg.chain, chainId, txHash });
      continue;
    }

    let depositId = null;
    for (const log of receipt.logs || []) {
      if (String(log.address).toLowerCase() !== reg.spokePool.toLowerCase()) continue;
      if (log.topics && log.topics[0] === FUNDS_DEPOSITED_TOPIC && log.topics.length > 2) {
        depositId = BigInt(log.topics[2]).toString();
        break;
      }
    }

    const statusOk = receipt.status === "0x1" || receipt.status === "0x01";
    row.stage = "RECEIPT";
    row.txHash = txHash;
    row.spokePoolDepositId = depositId;
    row.blockNumber = Number(BigInt(receipt.blockNumber));
    row.gasUsed = BigInt(receipt.gasUsed).toString();
    row.effectiveGasPriceWei = BigInt(receipt.effectiveGasPrice || 0).toString();
    row.statusOk = statusOk;
    emit({
      ok: statusOk,
      stage: "RECEIPT",
      chain: reg.chain,
      chainId,
      txHash,
      spokePoolDepositId: depositId,
      blockNumber: row.blockNumber,
      gasUsed: row.gasUsed,
      effectiveGasPriceWei: row.effectiveGasPriceWei,
    });

    appendHandoff(batch.batchId, row);
  }

  const summary = buildSummary(batch, execute, legRows);
  writeStatus(summary);
  emit({ ok: true, stage: "SWEEP_COMPLETE", batchId: batch.batchId, mode: execute ? "EXECUTE" : "DRY_RUN", summary: summary.summary });
})().catch((e) => { emit({ ok: false, failClosed: true, reason: "internal-error" }); process.exitCode = 1; });

function buildSummary(batch, execute, rows) {
  const sent = rows.filter((r) => r.txHash).length;
  return {
    tool: "execute-bridge-l2-sweep",
    batchId: batch.batchId,
    mode: execute ? "EXECUTE" : "DRY_RUN",
    generatedAt: new Date().toISOString(),
    destination: { chainId: DEST_CHAIN_ID, chain: "ethereum", recipient: MAIN_ACCOUNT, outputToken: MAINNET_WETH },
    legs: rows,
    summary: {
      legs: rows.length,
      verified: rows.filter((r) => r.verified).length,
      excluded: rows.filter((r) => r.excluded).length,
      sent,
      refused: rows.filter((r) => r.verified && !r.txHash).length,
    },
  };
}
