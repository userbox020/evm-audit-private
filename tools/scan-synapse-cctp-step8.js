#!/usr/bin/env node
"use strict";

// Defensive, read-only Synapse CCTP deployment/state/history scanner.
// RPC endpoint material is resolved in memory and is never emitted or persisted.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { resolveRpc, rpcCall, loadRpcUrls, PUBLIC_FALLBACKS } = require("./shared-rpc");

const ROOT = path.resolve(__dirname, "..");
const TARGET = path.join(ROOT, "targets", "synapse-contracts");
const OUT = path.join(ROOT, "reports", "raw", "fast", "synapse-cctp-step8.json");
const PUBLIC_OUT = path.join(ROOT, "reports", "raw", "fast", "synapse-cctp-step8.public-calldata.json");
const PROXY = "0x12715a66773bd9c54534a01abf01d05f6b4bd35e";
const ROUTER = "0xd5a597d6e7ddf373a92c8f477daaa673b0902f48";
const ALT_CALLER = "0x000000000000000000000000000000000000a11c";
const WINDOW_DAYS = Number(process.env.WINDOW_DAYS || 30);
const WINDOW_START_TS = process.env.WINDOW_START_TS ? BigInt(process.env.WINDOW_START_TS) : null;
const ONLY_CHAIN_IDS = process.env.CHAIN_IDS ? new Set(process.env.CHAIN_IDS.split(",").map(Number)) : null;
const FIXED_HEADS = new Map((process.env.FIXED_HEADS || "").split(",").filter(Boolean).map(entry => {
  const [chainId, blockNumber] = entry.split(":");
  if (!chainId || !blockNumber) throw new Error("FIXED_HEADS must use chainId:blockNumber entries");
  return [Number(chainId), BigInt(blockNumber)];
}));
const REVISION = process.env.STEP8_REVISION || "oracle-packaging-r2";
const SELECTED_FORK_TX_HASH = (process.env.SELECTED_FORK_TX_HASH || "0x9729751e464c0e0f0d88fb99259ed3ef0a0d18d2bd0941b871dc96e5ab0826b8").toLowerCase();
const EVENT_FULFILLED = "0x7864397c00beabf21ab17a04795e450354505d879a634dd2632f4fdc4b5ba04e";
const EVENT_FEE = "0x108516ddcf5ba43cea6bb2cd5ff6d59ac196c1c86ccb9178332b9dd72d1ca561";
const EVENT_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const EVENT_COLLECTOR = "0x9dfcadd14a1ddfb19c51e84b87452ca32a43c5559e9750d1575c77105cdeac1e";
const RECEIVE_SELECTOR = "0x4a5ae51d";
const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

const CHAINS = [
  { name: "mainnet", chainId: 1 },
  { name: "arbitrum", chainId: 42161 },
  { name: "base", chainId: 8453 },
  { name: "optimism", chainId: 10 },
  { name: "polygon", chainId: 137 },
  { name: "avalanche", chainId: 43114 },
];

function q(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function hex(n) { return "0x" + BigInt(n).toString(16); }
function bi(x) { return x == null ? 0n : BigInt(x); }
function dec(x) { return bi(x).toString(); }
function word(data, i) { return "0x" + data.slice(2 + i * 64, 2 + (i + 1) * 64); }
function addrWord(x) { return "0x" + x.slice(-40).toLowerCase(); }
function padAddress(a) { return a.toLowerCase().replace(/^0x/, "").padStart(64, "0"); }
function padUint(x) { return BigInt(x).toString(16).padStart(64, "0"); }
function sha256HexText(hexText) {
  return crypto.createHash("sha256").update(Buffer.from(hexText.replace(/^0x/, ""), "hex")).digest("hex");
}
function parseStorageAddress(x) { return !x || /^0x0*$/.test(x) ? null : addrWord(x); }
function iso(ts) { return new Date(Number(ts) * 1000).toISOString(); }

async function must(url, method, params, label) {
  const v = await rpcCall(url, method, params, 30000);
  if (v == null) throw new Error(`${label || method} returned null`);
  return v;
}

async function block(url, n) {
  return must(url, "eth_getBlockByNumber", [typeof n === "string" ? n : hex(n), false], "block");
}

async function findBlockAtOrAfter(url, head, targetTs) {
  let lo = 0n, hi = head;
  while (lo < hi) {
    const mid = (lo + hi) >> 1n;
    const b = await block(url, mid);
    if (bi(b.timestamp) < targetTs) lo = mid + 1n;
    else hi = mid;
  }
  return lo;
}

async function logsAdaptive(url, address, topic0, from, to, initialSpan = 50000n) {
  const out = [];
  let cursor = from;
  let span = initialSpan;
  while (cursor <= to) {
    const end = cursor + span - 1n > to ? to : cursor + span - 1n;
    const got = await rpcCall(url, "eth_getLogs", [{ address, fromBlock: hex(cursor), toBlock: hex(end), topics: [topic0] }], 20000);
    if (got == null) {
      if (span <= 500n) throw new Error(`eth_getLogs unavailable at ${cursor}-${end}`);
      span = span / 2n;
      continue;
    }
    out.push(...got);
    cursor = end + 1n;
    if (got.length < 100 && span < 100000n) span *= 2n;
  }
  return out;
}

async function resolveArchiveLogRpc(chainId, historicalFrom, head) {
  const candidates = [...new Set([...loadRpcUrls(), PUBLIC_FALLBACKS[chainId]].filter(Boolean))];
  let fallback = null;
  for (const url of candidates) {
    const id = await rpcCall(url, "eth_chainId", [], 4000);
    if (!id || parseInt(id, 16) !== chainId) continue;
    // Require historical log access at the exact declared-window boundary.
    const historicalTo = historicalFrom + 9n > head ? head : historicalFrom + 9n;
    const archive = await rpcCall(url, "eth_getLogs", [{ address: PROXY, fromBlock: hex(historicalFrom), toBlock: hex(historicalTo), topics: [EVENT_FULFILLED] }], 15000);
    if (archive == null) continue;
    for (const span of [5000000n, 1000000n, 100000n, 50000n]) {
      const from = head > span ? head - span + 1n : 0n;
      const test = await rpcCall(url, "eth_getLogs", [{ address: PROXY, fromBlock: hex(from), toBlock: hex(head), topics: [EVENT_FULFILLED] }], 20000);
      if (test != null) {
        if (span >= 5000000n) return { url, span };
        if (!fallback || span > fallback.span) fallback = { url, span };
        break;
      }
    }
  }
  if (!fallback) throw new Error("no endpoint with historical log coverage at declared window boundary");
  return fallback;
}

async function resolveFixedStateRpc(chainId, requestedHead = null) {
  const candidates = [...new Set([...loadRpcUrls(), PUBLIC_FALLBACKS[chainId]].filter(Boolean))];
  for (const url of candidates) {
    const id = await rpcCall(url, "eth_chainId", [], 4000);
    if (!id || parseInt(id, 16) !== chainId) continue;
    const headHex = requestedHead == null ? await rpcCall(url, "eth_blockNumber", [], 10000) : hex(requestedHead);
    if (!headHex) continue;
    const [b, impl, admin, code] = await Promise.all([
      rpcCall(url, "eth_getBlockByNumber", [headHex, false], 20000),
      rpcCall(url, "eth_getStorageAt", [PROXY, EIP1967_IMPL, headHex], 20000),
      rpcCall(url, "eth_getStorageAt", [PROXY, EIP1967_ADMIN, headHex], 20000),
      rpcCall(url, "eth_getCode", [PROXY, headHex], 20000),
    ]);
    if (!b || !parseStorageAddress(impl) || !parseStorageAddress(admin) || !code || code === "0x") continue;
    return { url, head: b, headNo: bi(b.number), implementation: parseStorageAddress(impl), admin: parseStorageAddress(admin) };
  }
  throw new Error("no state-capable read-only provider served nonzero proxy slots at the requested fixed head");
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function decodeDynamicArgs(input) {
  if (!input || input.slice(0, 10).toLowerCase() !== RECEIVE_SELECTOR) return null;
  const args = "0x" + input.slice(10);
  const dyn = (headIndex) => {
    const off = Number(bi(word(args, headIndex)));
    const len = Number(bi("0x" + args.slice(2 + off * 2, 2 + (off + 32) * 2)));
    return "0x" + args.slice(2 + (off + 32) * 2, 2 + (off + 32 + len) * 2);
  };
  return { message: dyn(0), attestation: dyn(1), requestVersion: dec(word(args, 2)), formattedRequest: dyn(3) };
}

function parseCircleMessage(message) {
  try {
    const b = Buffer.from(message.replace(/^0x/, ""), "hex");
    if (b.length < 116) return { parseError: "short Circle message", bytes: b.length };
    const u32 = o => b.readUInt32BE(o);
    const u64 = o => b.readBigUInt64BE(o).toString();
    const a32 = o => "0x" + b.subarray(o, o + 32).toString("hex");
    const out = {
      bytes: b.length, version: u32(0), sourceDomain: u32(4), destinationDomain: u32(8), nonce: u64(12),
      sender: a32(20), recipient: a32(52), destinationCaller: a32(84),
    };
    if (b.length >= 248) {
      out.body = { version: u32(116), burnToken: a32(120), mintRecipient: a32(152), amount: BigInt("0x" + b.subarray(184, 216).toString("hex")).toString(), messageSender: a32(216) };
    }
    return out;
  } catch (e) { return { parseError: e.message }; }
}

function decodeFulfilled(log) {
  const d = log.data;
  return {
    originDomain: Number(bi(word(d, 0))), recipient: addrWord(log.topics[1]), mintToken: addrWord(word(d, 1)),
    fee: dec(word(d, 2)), tokenOut: addrWord(word(d, 3)), userAmountOut: dec(word(d, 4)), requestId: word(d, 5).toLowerCase(),
  };
}

function decodeFee(log) {
  return { collector: addrWord(word(log.data, 0)), relayerFeeAmount: dec(word(log.data, 1)), protocolFeeAmount: dec(word(log.data, 2)) };
}

function decodeTransfer(log) {
  if (log.topics.length < 3) return null;
  return { token: log.address.toLowerCase(), from: addrWord(log.topics[1]), to: addrWord(log.topics[2]), amount: dec(word(log.data, 0)) };
}

function canonicalLedgerRecord(chainId, record) {
  const normalized = {
    chainId,
    blockNumber: record.blockNumber,
    blockHash: record.blockHash.toLowerCase(),
    transactionHash: record.transactionHash.toLowerCase(),
    status: record.status,
    inputSha256: record.calldataBinding.inputSha256,
    messageSha256: record.calldataBinding.messageSha256,
    attestationSha256: record.calldataBinding.attestationSha256,
    formattedRequestSha256: record.calldataBinding.formattedRequestSha256,
    requestVersion: record.calldataBinding.requestVersion,
    event: record.event,
  };
  return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

async function ethCall(url, to, data, tag) {
  return must(url, "eth_call", [{ to, data }, tag], `eth_call ${data.slice(0, 10)}`);
}
async function callAddress(url, to, selector, tag) { return addrWord(await ethCall(url, to, selector, tag)); }
async function callUint(url, to, selector, tag) { return dec(await ethCall(url, to, selector, tag)); }
async function callBool(url, to, selector, tag) { return bi(await ethCall(url, to, selector, tag)) !== 0n; }
async function callTuple4(url, to, selector, argAddress, tag) {
  const r = await ethCall(url, to, selector + padAddress(argAddress), tag);
  return { relayerFee: dec(word(r, 0)), minBaseFee: dec(word(r, 1)), minSwapFee: dec(word(r, 2)), maxFee: dec(word(r, 3)) };
}
async function callMapAddress(url, to, selector, key, tag) { return callAddress(url, to, selector + padAddress(key), tag); }
async function callMap2Uint(url, to, selector, a, b, tag) { return callUint(url, to, selector + padAddress(a) + padAddress(b), tag); }

function deployment(chain, name) {
  const file = path.join(TARGET, "deployments", chain, `${name}.json`);
  return fs.existsSync(file) ? q(file).address.toLowerCase() : null;
}
function config(chain) {
  const file = path.join(TARGET, "script", "configs", chain, "SynapseCCTP.dc.json");
  return fs.existsSync(file) ? q(file) : null;
}

function bindRuntime(chainName, contractName, liveCode) {
  const artifactFile = path.join(TARGET, "artifacts", `${contractName}.sol`, `${contractName}.json`);
  if (!fs.existsSync(artifactFile)) return { artifactFile: path.relative(ROOT, artifactFile).replaceAll("\\", "/"), available: false };
  const art = q(artifactFile);
  const built = (art.deployedBytecode && (art.deployedBytecode.object || art.deployedBytecode)) || "0x";
  const refs = art.deployedBytecode?.immutableReferences || {};
  const normalize = (code, zeroBuilt) => {
    const b = Buffer.from(code.replace(/^0x/, ""), "hex");
    for (const entries of Object.values(refs)) for (const r of entries) b.fill(0, r.start, r.start + r.length);
    return b;
  };
  const bn = normalize(built, true), ln = normalize(liveCode, false);
  return {
    artifactFile: path.relative(ROOT, artifactFile).replaceAll("\\", "/"), available: true,
    compiler: art.metadata?.compiler?.version || art.metadata?.compiler || "0.8.17 (forge artifact)",
    liveBytes: (liveCode.length - 2) / 2, buildBytes: (built.length - 2) / 2,
    liveSha256: sha256HexText(liveCode), buildSha256: sha256HexText(built),
    immutableReferences: refs,
    normalizedImmutableMatch: bn.length === ln.length && crypto.timingSafeEqual(bn, ln),
    chain: chainName,
  };
}

async function scanChain(c, cutoffTs) {
  // Endpoint inventory remains in-memory and endpoint material is never emitted.
  const fixedHeadRequest = FIXED_HEADS.get(c.chainId) ?? null;
  const stateResolution = await resolveFixedStateRpc(c.chainId, fixedHeadRequest);
  const stateUrl = stateResolution.url;
  const headNo = stateResolution.headNo;
  const head = stateResolution.head;
  const fromNo = await findBlockAtOrAfter(stateUrl, headNo, cutoffTs);
  const from = await block(stateUrl, fromNo);
  const logResolution = await resolveArchiveLogRpc(c.chainId, fromNo, headNo);
  const url = logResolution.url;
  const readUrls = [...new Set([url, stateUrl, PUBLIC_FALLBACKS[c.chainId]].filter(Boolean))];
  const mustAny = async (method, params, label) => {
    for (const candidate of readUrls) {
      const v = await rpcCall(candidate, method, params, 30000);
      if (v != null) return v;
    }
    throw new Error(`${label || method} returned null across read endpoint set`);
  };
  const tag = hex(headNo);
  const implSlot = await must(stateUrl, "eth_getStorageAt", [PROXY, EIP1967_IMPL, tag], "implementation slot");
  const adminSlot = await must(stateUrl, "eth_getStorageAt", [PROXY, EIP1967_ADMIN, tag], "admin slot");
  const implementation = parseStorageAddress(implSlot);
  const proxyAdmin = parseStorageAddress(adminSlot);
  const expectedProxyAdmin = deployment(c.name, "ProxyAdmin.SynapseCCTP");
  if (!proxyAdmin || proxyAdmin !== expectedProxyAdmin) throw new Error("fixed-head proxy admin is zero or differs from deployment artifact");
  if (implementation !== stateResolution.implementation || proxyAdmin !== stateResolution.admin) throw new Error("fixed-head state provider slot reads are nondeterministic");
  const [proxyCode, implCode, routerCode] = await Promise.all([
    must(stateUrl, "eth_getCode", [PROXY, tag], "proxy code"), must(stateUrl, "eth_getCode", [implementation, tag], "implementation code"), must(stateUrl, "eth_getCode", [ROUTER, tag], "router code"),
  ]);
  const cfg = config(c.name);
  const token = cfg?.tokens?.USDC?.token?.toLowerCase() || null;
  const tokenMessenger = await callAddress(stateUrl, PROXY, "0x46117830", tag);
  const messageTransmitter = await callAddress(stateUrl, PROXY, "0x7b04c181", tag);
  const messengerTransmitter = await callAddress(stateUrl, tokenMessenger, "0x2c121921", tag);
  const state = {
    owner: await callAddress(stateUrl, PROXY, "0x8da5cb5b", tag), paused: await callBool(stateUrl, PROXY, "0x5c975abb", tag),
    localDomain: await callUint(stateUrl, PROXY, "0x8d3638f4", tag), protocolFee: await callUint(stateUrl, PROXY, "0xb0e21e8a", tag),
    chainGasAmount: await callUint(stateUrl, PROXY, "0xe00a83e0", tag), tokenMessenger, messageTransmitter,
    tokenMessengerLocalMessageTransmitter: messengerTransmitter,
    routerSynapseCCTP: await callAddress(stateUrl, ROUTER, "0xe701d26e", tag),
    usdc: token,
    usdcFeeStructure: token ? await callTuple4(stateUrl, PROXY, "0xdc72495b", token, tag) : null,
    protocolAccumulatedUsdc: token ? await callMap2Uint(stateUrl, PROXY, "0xd4a67c6d", "0x0000000000000000000000000000000000000000", token, tag) : null,
    alternateCallerCurrentCollector: await callMapAddress(stateUrl, PROXY, "0x41f355ee", ALT_CALLER, tag),
  };
  const fulfilledLogs = await logsAdaptive(url, PROXY, EVENT_FULFILLED, fromNo, headNo, logResolution.span);
  const history = await mapLimit(fulfilledLogs, 8, async (l) => {
    const [tx, receipt, b] = await Promise.all([
      mustAny("eth_getTransactionByHash", [l.transactionHash], "tx"), mustAny("eth_getTransactionReceipt", [l.transactionHash], "receipt"), mustAny("eth_getBlockByNumber", [l.blockNumber, false], "historical block"),
    ]);
    const event = decodeFulfilled(l);
    const args = decodeDynamicArgs(tx.input);
    const feeLog = receipt.logs.find(x => x.address.toLowerCase() === PROXY && x.topics[0]?.toLowerCase() === EVENT_FEE);
    const collectorEvent = feeLog ? decodeFee(feeLog) : null;
    const transfers = receipt.logs.filter(x => x.topics[0]?.toLowerCase() === EVENT_TRANSFER).map(decodeTransfer).filter(Boolean);
    const recipientTransfers = transfers.filter(x => x.to === event.recipient);
    let circle = null;
    if (args) {
      circle = parseCircleMessage(args.message);
    }
    return {
      blockNumber: dec(l.blockNumber), blockHash: l.blockHash, timestamp: dec(b.timestamp), timestampIso: iso(b.timestamp),
      transactionHash: l.transactionHash, transactionIndex: dec(l.transactionIndex), originalCaller: tx.from.toLowerCase(), txTo: tx.to.toLowerCase(),
      status: dec(receipt.status), gasUsed: dec(receipt.gasUsed), effectiveGasPriceWei: dec(receipt.effectiveGasPrice || tx.gasPrice),
      gasCostWei: (bi(receipt.gasUsed) * bi(receipt.effectiveGasPrice || tx.gasPrice)).toString(), msgValueWei: dec(tx.value),
      event, collectorEvent, historicalCallerCollectorEvidence: collectorEvent ? "FeeCollected receipt event" : "missing FeeCollected event", recipientTransfers,
      circle, circleNonceConsumptionEvidence: "successful MessageTransmitter receive in status-1 receipt; direct mapping rechecked in gated fork",
      calldataBinding: args ? { selector: RECEIVE_SELECTOR, inputSha256: sha256HexText(tx.input), messageSha256: sha256HexText(args.message), attestationSha256: sha256HexText(args.attestation), formattedRequestSha256: sha256HexText(args.formattedRequest), requestVersion: args.requestVersion } : null,
      _publicPayload: args ? { to: tx.to.toLowerCase(), value: dec(tx.value), input: tx.input, message: args.message, attestation: args.attestation, requestVersion: args.requestVersion, formattedRequest: args.formattedRequest } : null,
    };
  });
  history.sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)));
  for (const h of history) {
    if (!h.calldataBinding) throw new Error("successful receive lacks decodable calldata binding");
    h.ledgerBinding = { canonicalization: "synapse-cctp-step8-ledger-v1", canonicalRecordSha256: canonicalLedgerRecord(c.chainId, h) };
  }
  const bindings = {
    proxy: { address: PROXY, codeBytes: (proxyCode.length - 2) / 2, codeSha256: sha256HexText(proxyCode), implementation, admin: proxyAdmin, expectedAdminArtifact: expectedProxyAdmin, adminNonzeroAndMatchesArtifact: true },
    implementation: { address: implementation, artifactAddress: deployment(c.name, "SynapseCCTP.Implementation"), ...bindRuntime(c.name, "SynapseCCTP", implCode) },
    router: { address: ROUTER, artifactAddress: deployment(c.name, "SynapseCCTPRouter"), ...bindRuntime(c.name, "SynapseCCTPRouter", routerCode) },
  };
  return {
    chain: c, fixedHead: { number: headNo.toString(), hash: head.hash, timestamp: dec(head.timestamp), timestampIso: iso(head.timestamp), explicitlyRequested: fixedHeadRequest != null },
    fixedHeadStateEvidence: { stateCapableProviderSelectedInMemory: true, endpointMaterialPersisted: false, implementationSlotNonzero: true, adminSlotNonzero: true, adminMatchesDeploymentArtifact: true },
    window: { days: WINDOW_START_TS ? null : WINDOW_DAYS, cutoffTimestamp: cutoffTs.toString(), fromBlock: fromNo.toString(), fromBlockHash: from.hash, fromBlockTimestamp: dec(from.timestamp), fromBlockIso: iso(from.timestamp), toBlock: headNo.toString(), logChunkSpan: logResolution.span.toString() },
    bindings, configArtifact: cfg, state, successfulReceives: history.length, nonzeroFeeReceives: history.filter(x => bi(x.event.fee) > 0n).length,
    totalGrossFeeUsdcUnits: history.reduce((n, x) => n + bi(x.event.fee), 0n).toString(), feeCollectorUpdateEvents: "not-scanned-separately",
    history,
  };
}

async function main() {
  const generatedAt = new Date().toISOString();
  const cutoffTs = WINDOW_START_TS || BigInt(Math.floor(Date.now() / 1000) - WINDOW_DAYS * 86400);
  const chains = [];
  for (const c of CHAINS.filter(x => !ONLY_CHAIN_IDS || ONLY_CHAIN_IDS.has(x.chainId))) {
    process.stderr.write(`Scanning ${c.name} at a fixed head (endpoint redacted)...\n`);
    try { chains.push(await scanChain(c, cutoffTs)); }
    catch (e) { chains.push({ chain: c, blocked: e.message }); }
  }
  const available = chains.filter(x => !x.blocked);
  const ranked = [...available].sort((a, b) => b.successfulReceives - a.successfulReceives || Number(BigInt(b.totalGrossFeeUsdcUnits) - BigInt(a.totalGrossFeeUsdcUnits)));
  const allHistory = available.flatMap(c => c.history.map(h => ({ chain: c, history: h })));
  const selected = allHistory.find(x => x.history.transactionHash.toLowerCase() === SELECTED_FORK_TX_HASH);
  if (!selected || !selected.history._publicPayload) throw new Error(`selected consumed fork payload is absent from fixed-head successful history: ${JSON.stringify(chains.map(x => ({ chain: x.chain.name, blocked: x.blocked || null, receives: x.successfulReceives || 0, latest: x.history?.at(-1)?.transactionHash || null })))}`);
  const payloadReferences = allHistory.map(({ chain, history: h }) => ({
    chain: chain.chain,
    blockNumber: h.blockNumber,
    blockHash: h.blockHash,
    transactionHash: h.transactionHash,
    receiptStatus: h.status,
    requestId: h.event.requestId,
    inputSha256: h.calldataBinding.inputSha256,
    messageSha256: h.calldataBinding.messageSha256,
    attestationSha256: h.calldataBinding.attestationSha256,
    formattedRequestSha256: h.calldataBinding.formattedRequestSha256,
    canonicalRecordSha256: h.ledgerBinding.canonicalRecordSha256,
    fullPayloadRetained: h.transactionHash.toLowerCase() === SELECTED_FORK_TX_HASH,
  }));
  const selectedPayload = selected.history._publicPayload;
  const retainedConsumedPayloads = [{
    chain: selected.chain.chain,
    blockNumber: selected.history.blockNumber,
    blockHash: selected.history.blockHash,
    transactionHash: selected.history.transactionHash,
    originalCaller: selected.history.originalCaller,
    receiptStatus: selected.history.status,
    requestId: selected.history.event.requestId,
    classification: "public-already-successful-nonce-consumed",
    publicChainData: true,
    alreadySuccessful: true,
    nonceConsumed: true,
    pendingOrUnconsumed: false,
    calldataBinding: selected.history.calldataBinding,
    to: selectedPayload.to,
    value: selectedPayload.value,
    input: selectedPayload.input,
    message: selectedPayload.message,
    attestation: selectedPayload.attestation,
    requestVersion: selectedPayload.requestVersion,
    formattedRequest: selectedPayload.formattedRequest,
  }];
  for (const { history: h } of allHistory) {
    h.publicPayloadReference = { transactionHash: h.transactionHash, inputSha256: h.calldataBinding.inputSha256, fullPayloadRetained: h.transactionHash.toLowerCase() === SELECTED_FORK_TX_HASH };
    delete h._publicPayload;
  }
  const result = {
    schemaVersion: 2, revision: REVISION, runId: `synapse-cctp-step8-${generatedAt.replace(/[-:.TZ]/g, "")}-${REVISION}`, generatedAt,
    safety: { readOnlyPublicQueries: true, endpointMaterialPersisted: false, privateKeysUsed: false, signedActions: false, broadcasts: false, liveFundMovement: false },
    declaredWindow: { days: WINDOW_START_TS ? null : WINDOW_DAYS, startMode: WINDOW_START_TS ? "fixed-timestamp" : "rolling-days", cutoffTimestamp: cutoffTs.toString(), cutoffIso: iso(cutoffTs) },
    deterministicHeads: { enabled: FIXED_HEADS.size > 0, requested: Object.fromEntries([...FIXED_HEADS].map(([id, n]) => [String(id), n.toString()])), allSelectedChainsExplicitlyPinned: available.every(c => c.fixedHead.explicitlyRequested) },
    exactCommonAddresses: { synapseCCTPProxy: PROXY, synapseCCTPRouter: ROUTER, alternateEphemeralForkCaller: ALT_CALLER },
    highestActivityDestinationChain: ranked[0]?.chain || null,
    corroboratingChain: ranked[1]?.chain || null,
    completeWindowHistory: available.length === (ONLY_CHAIN_IDS ? [...ONLY_CHAIN_IDS].length : CHAINS.length),
    corpusMinimization: { ledgerRecords: payloadReferences.length, fullPayloadsRetained: retainedConsumedPayloads.length, selectedConsumedTransactionHash: SELECTED_FORK_TX_HASH, pendingOrUnconsumedAttestationsRetained: 0, mainRawContainsFullPublicPayloads: false },
    blockers: chains.filter(x => x.blocked).map(x => ({ chain: x.chain, blocker: x.blocked })), chains,
  };
  const publicCalldata = {
    schemaVersion: 2,
    runId: result.runId,
    policy: {
      description: "Hash/reference ledger for all consumed successful receives; exactly one public, already-successful, nonce-consumed payload retained for fork reproducibility.",
      pendingOrUnconsumedAttestationsPermitted: false,
      endpointOrSecretMaterialIncluded: false,
    },
    payloadReferences,
    retainedConsumedPayloads,
  };
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2) + "\n");
  fs.writeFileSync(PUBLIC_OUT, JSON.stringify(publicCalldata, null, 2) + "\n");
  console.log(JSON.stringify({ runId: result.runId, completeWindowHistory: result.completeWindowHistory, highestActivityDestinationChain: result.highestActivityDestinationChain, corroboratingChain: result.corroboratingChain, chains: chains.map(x => ({ chain: x.chain.name, head: x.fixedHead?.number, receives: x.successfulReceives, nonzeroFees: x.nonzeroFeeReceives, grossFee: x.totalGrossFeeUsdcUnits, blocked: x.blocked || null })) }, null, 2));
}

main().catch(e => { console.error(e.stack || e.message); process.exitCode = 1; });
