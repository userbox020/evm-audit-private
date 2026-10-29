#!/usr/bin/env node
"use strict";

// Ephemeral, no-key Anvil replay of one public historical Synapse CCTP receive.
// No live transaction is signed or broadcast. Fork endpoint material stays in memory.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { loadRpcUrls, rpcCall, PUBLIC_FALLBACKS } = require("./shared-rpc");

const ROOT = path.resolve(__dirname, "..");
const CAPTURE = path.join(ROOT, "reports", "raw", "fast", "synapse-cctp-step8.json");
const PUBLIC = path.join(ROOT, "reports", "raw", "fast", "synapse-cctp-step8.public-calldata.json");
const OUT = path.join(ROOT, "reports", "raw", "fast", "synapse-cctp-step8.fork.json");
const CHAIN_ID = 42161;
const PROXY = "0x12715a66773bd9c54534a01abf01d05f6b4bd35e";
const ALT_CALLER = "0x000000000000000000000000000000000000a11c";
const ALT_COLLECTOR = "0x000000000000000000000000000000000000c011";
const ETH_USD_FEED = "0x639fe6ab55c921f74e7fac1ee960c0b6293ba612";
const PORT = Number(process.env.ANVIL_PORT || 18548);

const padA = a => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const padU = x => BigInt(x).toString(16).padStart(64, "0");
const hex = x => "0x" + BigInt(x).toString(16);
const bi = x => x == null ? 0n : BigInt(x);
const dec = x => bi(x).toString();
const word = (data, i) => "0x" + data.slice(2 + i * 64, 2 + (i + 1) * 64);
const addr = x => "0x" + x.slice(-40).toLowerCase();

async function local(method, params = [], allowError = false) {
  const r = await fetch(`http://127.0.0.1:${PORT}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error && !allowError) throw new Error(`${method}: ${j.error.message}`);
  return j.error ? { error: j.error.message, data: j.error.data || null } : j.result;
}

async function waitLocal(ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await local("eth_chainId") === "0xa4b1") return; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error("ephemeral fork did not become ready");
}

async function receipt(hash) {
  for (let i = 0; i < 120; i++) {
    const r = await local("eth_getTransactionReceipt", [hash]);
    if (r) return r;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("local receipt timeout");
}

async function call(to, data, from = null) {
  const tx = { to, data };
  if (from) tx.from = from;
  return local("eth_call", [tx, "latest"]);
}
async function balanceOf(token, account) { return dec(await call(token, "0x70a08231" + padA(account))); }
async function accumulated(collector, token) { return dec(await call(PROXY, "0xd4a67c6d" + padA(collector) + padA(token))); }
async function nativeBalance(account) { return dec(await local("eth_getBalance", [account, "latest"])); }

function parseCircle(message) {
  const b = Buffer.from(message.replace(/^0x/, ""), "hex");
  return { sourceDomain: b.readUInt32BE(4), nonce: b.readBigUInt64BE(12).toString() };
}

async function snapshot(token, recipient, messageTransmitter, nonceKey) {
  const used = await local("eth_call", [{ to: messageTransmitter, data: "0xfeb61724" + nonceKey.slice(2) }, "latest"], true);
  return {
    alternateCollectorAccumulatedUsdc: await accumulated(ALT_COLLECTOR, token),
    protocolAccumulatedUsdc: await accumulated("0x0000000000000000000000000000000000000000", token),
    recipientTokenBalance: await balanceOf(token, recipient),
    recipientNativeBalanceWei: await nativeBalance(recipient),
    proxyTokenBalance: await balanceOf(token, PROXY),
    circleNonceUsed: typeof used === "string" ? (bi(used) !== 0n) : null,
    circleNonceReadError: typeof used === "string" ? null : "usedNonces(bytes32) unavailable",
  };
}

function delta(after, before, key) { return (bi(after[key]) - bi(before[key])).toString(); }
function deterministicCore(result) {
  return {
    historicalTransactionHash: result.binding.historicalTransactionHash,
    calldataSha256: result.binding.calldataSha256,
    forkBlock: result.binding.forkBlock,
    configStatus: result.configuration.status,
    configGasUsed: result.configuration.gasUsed,
    replayStatus: result.replay.status,
    replayGasUsed: result.replay.gasUsed,
    retryStatus: result.originalRelayerRetry.receiptStatus,
    deltas: result.deltas,
    netUsdc: result.economics.netUsdc,
  };
}
function objectHash(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

async function chooseForkRpc(blockNumber) {
  const candidates = [...new Set([...loadRpcUrls(), PUBLIC_FALLBACKS[CHAIN_ID]].filter(Boolean))];
  for (const url of candidates) {
    const id = await rpcCall(url, "eth_chainId", [], 4000);
    if (!id || parseInt(id, 16) !== CHAIN_ID) continue;
    const [code, block] = await Promise.all([
      rpcCall(url, "eth_getCode", [PROXY, hex(blockNumber)], 12000),
      rpcCall(url, "eth_getBlockByNumber", [hex(blockNumber), false], 12000),
    ]);
    if (code && code !== "0x" && block) return url;
  }
  throw new Error("no in-memory endpoint could serve the historical fork block");
}

async function main() {
  const capture = JSON.parse(fs.readFileSync(CAPTURE, "utf8"));
  const publicCorpus = JSON.parse(fs.readFileSync(PUBLIC, "utf8"));
  const prior = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : null;
  const chain = capture.chains.find(x => x.chain.chainId === CHAIN_ID && !x.blocked);
  if (!chain) throw new Error("bound Arbitrum capture missing");
  const payload = publicCorpus.retainedConsumedPayloads?.[0];
  const chosen = chain.history.find(x => x.transactionHash.toLowerCase() === payload?.transactionHash?.toLowerCase());
  if (!chosen || bi(chosen.event.fee) === 0n || !payload || payload.classification !== "public-already-successful-nonce-consumed" || payload.pendingOrUnconsumed) throw new Error("gated consumed public calldata missing or not minimized");
  if (!chain.bindings.implementation.normalizedImmutableMatch || !chain.bindings.router.normalizedImmutableMatch) throw new Error("source/runtime binding gate closed");
  const forkBlock = bi(chosen.blockNumber) - 1n;
  const forkUrl = await chooseForkRpc(forkBlock);
  const anvil = spawn("anvil", ["--fork-url", forkUrl, "--fork-block-number", forkBlock.toString(), "--chain-id", String(CHAIN_ID), "--port", String(PORT), "--silent"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let forkOutput = "";
  anvil.stdout.on("data", d => { forkOutput += d.toString(); if (forkOutput.length > 4096) forkOutput = forkOutput.slice(-4096); });
  anvil.stderr.on("data", d => { forkOutput += d.toString(); if (forkOutput.length > 4096) forkOutput = forkOutput.slice(-4096); });
  try {
    await waitLocal();
    for (const account of [ALT_CALLER, chosen.originalCaller]) {
      await local("anvil_impersonateAccount", [account]);
      await local("anvil_setBalance", [account, "0x56bc75e2d63100000"]); // 100 ETH, fork-only.
    }
    const token = chosen.event.mintToken;
    const recipient = chosen.event.recipient;
    const messageTransmitter = chain.state.messageTransmitter;
    const circle = parseCircle(payload.message);
    const packed = "0x" + circle.sourceDomain.toString(16).padStart(8, "0") + BigInt(circle.nonce).toString(16).padStart(16, "0");
    const nonceKey = await local("web3_sha3", [packed]);
    const before = await snapshot(token, recipient, messageTransmitter, nonceKey);
    const gasPrice = chosen.effectiveGasPriceWei;

    const configHash = await local("eth_sendTransaction", [{ from: ALT_CALLER, to: PROXY, data: "0xa42dce80" + padA(ALT_COLLECTOR), gas: hex(300000), gasPrice: hex(gasPrice) }]);
    const configReceipt = await receipt(configHash);
    const configured = addr(await call(PROXY, "0x41f355ee" + padA(ALT_CALLER)));
    const afterConfig = await snapshot(token, recipient, messageTransmitter, nonceKey);

    const receiveHash = await local("eth_sendTransaction", [{ from: ALT_CALLER, to: PROXY, data: payload.input, value: hex(payload.value), gas: hex(5000000), gasPrice: hex(gasPrice) }]);
    const receiveReceipt = await receipt(receiveHash);
    const afterReceive = await snapshot(token, recipient, messageTransmitter, nonceKey);

    const retryHash = await local("eth_sendTransaction", [{ from: chosen.originalCaller, to: PROXY, data: payload.input, value: hex(payload.value), gas: hex(5000000), gasPrice: hex(gasPrice) }], true);
    let retryReceipt = null;
    let retrySubmissionError = null;
    if (typeof retryHash === "string") retryReceipt = await receipt(retryHash);
    else retrySubmissionError = retryHash.error;

    const feed = await call(ETH_USD_FEED, "0xfeaf968c");
    const ethUsdAnswer = bi(word(feed, 1));
    const ethUsdDecimals = 8n;
    const configGas = bi(configReceipt.gasUsed);
    const receiveGas = bi(receiveReceipt.gasUsed);
    const totalGasWei = (configGas + receiveGas) * bi(gasPrice);
    const msgValueWei = bi(payload.value);
    const grossFeeUnits = bi(chosen.event.fee);
    const gasCostUsdc8 = totalGasWei * ethUsdAnswer / 1000000000000000000n;
    const msgValueCostUsdc8 = msgValueWei * ethUsdAnswer / 1000000000000000000n;
    const grossFeeUsdc8 = grossFeeUnits * 100n; // USDC 6 decimals -> price units 8 decimals.
    const netUsdc8 = grossFeeUsdc8 - gasCostUsdc8 - msgValueCostUsdc8;

    const result = {
      schemaVersion: 2, revision: capture.revision, runId: `${capture.runId}-fork-${chosen.transactionHash.slice(2, 10)}`, generatedAt: new Date().toISOString(),
      safety: { ephemeralFork: true, impersonationOnly: true, privateKeysUsed: false, signedActions: false, liveBroadcasts: false, endpointMaterialPersisted: false, liveFundMovement: false },
      binding: { chain: chain.chain, captureFixedHead: chain.fixedHead, forkBlock: forkBlock.toString(), historicalBlock: chosen.blockNumber, historicalBlockHash: chosen.blockHash, historicalTransactionHash: chosen.transactionHash, calldataSha256: chosen.calldataBinding.inputSha256, implementation: chain.bindings.implementation, router: chain.bindings.router },
      actors: { historicalCaller: chosen.originalCaller, alternateCaller: ALT_CALLER, alternateCollector: ALT_COLLECTOR, recipient },
      configuration: { selector: "setFeeCollector(address)", configuredCollector: configured, transactionHash: configHash, status: dec(configReceipt.status), gasUsed: dec(configReceipt.gasUsed), gasPriceWei: gasPrice, gasCostWei: (configGas * bi(gasPrice)).toString(), priorTransactionRequired: true },
      replay: { transactionHash: receiveHash, status: dec(receiveReceipt.status), gasUsed: dec(receiveReceipt.gasUsed), gasPriceWei: gasPrice, gasCostWei: (receiveGas * bi(gasPrice)).toString(), msgValueWei: payload.value, exactHistoricalInput: true, exactHistoricalInputSha256: chosen.calldataBinding.inputSha256, retainedPayloadClassification: payload.classification },
      originalRelayerRetry: { transactionHash: typeof retryHash === "string" ? retryHash : null, receiptStatus: retryReceipt ? dec(retryReceipt.status) : null, gasUsed: retryReceipt ? dec(retryReceipt.gasUsed) : null, submissionError: retrySubmissionError, unableToCompleteAfterAlternate: retryReceipt ? bi(retryReceipt.status) === 0n : true },
      snapshots: { before, afterConfig, afterReceive },
      deltas: {
        alternateCollectorAccumulatedUsdc: delta(afterReceive, before, "alternateCollectorAccumulatedUsdc"),
        protocolAccumulatedUsdc: delta(afterReceive, before, "protocolAccumulatedUsdc"),
        recipientToken: delta(afterReceive, before, "recipientTokenBalance"),
        recipientNativeWei: delta(afterReceive, before, "recipientNativeBalanceWei"),
        proxyToken: delta(afterReceive, before, "proxyTokenBalance"),
        circleNonceBefore: before.circleNonceUsed, circleNonceAfter: afterReceive.circleNonceUsed,
      },
      expectedHistoricalEvent: chosen.event,
      economics: {
        classification: "pre-withdrawal-modeled-net",
        grossFeeUsdcUnits: grossFeeUnits.toString(), grossFeeUsdc: (Number(grossFeeUnits) / 1e6).toFixed(6),
        chainlinkEthUsdAnswer: ethUsdAnswer.toString(), chainlinkEthUsdDecimals: ethUsdDecimals.toString(),
        totalAttackerGasWei: totalGasWei.toString(), requiredGasAirdropCapitalWei: msgValueWei.toString(),
        gasCostUsdc8: gasCostUsdc8.toString(), gasAirdropCapitalCostUsdc8: msgValueCostUsdc8.toString(), netUsdc8: netUsdc8.toString(), netUsdc: (Number(netUsdc8) / 1e8).toFixed(8),
        formula: "gross fee - (setFeeCollector gas + receive gas) * historical effective gas price * Chainlink ETH/USD - required msg.value gas airdrop",
        collectorWithdrawalGasIncluded: false,
        collectorWithdrawalRequiredToRealizeTokenBalance: true,
        configurationCostTreatment: "included once in this model; configuration is persistent and amortizable across later receives",
      },
      forkProcessOutputPersisted: false,
    };
    const currentCoreHash = objectHash(deterministicCore(result));
    const priorCoreHash = prior?.binding?.historicalTransactionHash === result.binding.historicalTransactionHash ? objectHash(deterministicCore(prior)) : null;
    result.determinism = { coreSchema: "synapse-cctp-step8-fork-core-v1", currentCoreHash, priorCoreHash, priorComparableRunFound: priorCoreHash !== null, match: priorCoreHash !== null && priorCoreHash === currentCoreHash };
    fs.writeFileSync(OUT, JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify({ runId: result.runId, forkBlock: result.binding.forkBlock, status: result.replay.status, feeDelta: result.deltas.alternateCollectorAccumulatedUsdc, userDelta: result.deltas.recipientToken, nonce: [result.deltas.circleNonceBefore, result.deltas.circleNonceAfter], originalRetryStatus: result.originalRelayerRetry.receiptStatus, netUsdc: result.economics.netUsdc }, null, 2));
  } finally {
    anvil.kill();
  }
}

main().catch(e => { console.error(e.message); process.exitCode = 1; });
