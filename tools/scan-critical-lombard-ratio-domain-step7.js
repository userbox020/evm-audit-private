#!/usr/bin/env node
"use strict";

// Lombard Step 7: defensive, read-only cross-chain ratio-attestation/domain analysis.
// Network mode captures public fixed-head state and already-public transaction calldata.
// Offline mode deterministically rebuilds derived artifacts from the retained public capture.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");
const { resolveRpcPool, rpcCall } = require("./shared-rpc");

const ROOT = path.resolve(__dirname, "..");
const STEM = "critical-lombard-ratio-domain-step7";
const CAPTURE = path.join(ROOT, `reports/raw/fast/${STEM}.capture.json`);
const CALLDATA = path.join(ROOT, `reports/raw/fast/${STEM}.public-calldata.json`);
const RAW = path.join(ROOT, `reports/raw/fast/${STEM}.json`);
const MANIFEST = path.join(ROOT, `reports/raw/fast/${STEM}.manifest.json`);
const FORK_ARTIFACT = path.join(ROOT, `reports/raw/fast/${STEM}.fork.json`);
const DEX_FORK_ARTIFACT = path.join(ROOT, `reports/raw/fast/${STEM}.dex-fork.json`);
const T2_FORK_ARTIFACT = path.join(ROOT, `reports/raw/fast/${STEM}.t2-fork.json`);
const FORK_SCRIPT = path.join(ROOT, `tools/prove-${STEM}-fork.js`);
const DEX_FORK_SCRIPT = path.join(ROOT, `tools/prove-${STEM}-dex-fork.js`);
const T2_FORK_SCRIPT = path.join(ROOT, `tools/prove-${STEM}-t2-fork.js`);
const REPORT = path.join(ROOT, `reports/${STEM}.md`);
const DEFINITIONS = path.join(ROOT, `reports/${STEM}-definitions.md`);
const SOURCES = path.join(ROOT, `reports/${STEM}-sources.md`);
const OFFLINE = process.argv.includes("--offline");
const QUIET = process.argv.includes("--quiet");

const EXPECTED_LOMBARD_COMMIT = "5ec153c2803991ac2b0240565b1498d85375c7a5";
const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const ZERO = ethers.ZeroAddress;
const EPHEMERAL_FROM = "0x000000000000000000000000000000000000dEaD";
const RATIO_SELECTOR = "0x6c722c2c";
const EVENT_TOPIC = ethers.id("Oracle_RatioChanged(uint256,uint256,uint256)");
const READ_METHODS = new Set([
  "eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getCode", "eth_getStorageAt",
  "eth_call", "eth_getLogs", "eth_getTransactionByHash", "eth_getTransactionReceipt"
]);

const CHAINS = [
  { key: "mainnet", chainId: 1, name: "Ethereum", destinationConsumerChain: true },
  { key: "base", chainId: 8453, name: "Base", destinationConsumerChain: false },
];

const LOMBARD_CONFIG = "targets/lombard-evm-smart-contracts/mainnet.json";
const SOURCE_FILES = [
  "targets/lombard-evm-smart-contracts/contracts/LBTC/StakedLBTCOracle.sol",
  "targets/lombard-evm-smart-contracts/contracts/LBTC/interfaces/IOracle.sol",
  "targets/lombard-evm-smart-contracts/contracts/libs/Actions.sol",
  "targets/lombard-evm-smart-contracts/contracts/consortium/Consortium.sol",
  "targets/lombard-evm-smart-contracts/contracts/consortium/INotaryConsortium.sol",
  "targets/lombard-evm-smart-contracts/test/helpers.ts",
  "targets/lombard-evm-smart-contracts/test/StakedLBTCOracle.ts",
  "targets/fluid-contracts-public/contracts/oracle/fluidCappedRate.sol",
  "targets/fluid-contracts-public/contracts/oracle/oracles/genericOracleBase.sol",
  "targets/fluid-contracts-public/contracts/protocols/vault/vaultTypesCommon/coreModule/mainOperate.sol",
  "targets/fluid-contracts-public/contracts/protocols/vault/vaultTypesCommon/coreModule/main.sol",
];

const FLUID = {
  capped: { label: "CappedRateBalancer_LBTC", file: "targets/fluid-contracts-public/deployments/mainnet/CappedRateBalancer_LBTC.json" },
  generic: [
    { label: "LBTC/USDC", file: "targets/fluid-contracts-public/deployments/mainnet/GenericOracle_LBTC_USDC.json" },
    { label: "LBTC/USDT", file: "targets/fluid-contracts-public/deployments/mainnet/GenericOracle_LBTC_USDT.json" },
    { label: "LBTC/GHO", file: "targets/fluid-contracts-public/deployments/mainnet/GenericOracle_LBTC_GHO.json" },
  ],
  vaults: [
    { label: "LBTC/USDC", file: "targets/fluid-contracts-public/deployments/mainnet/VaultT1_LBTC_USDC.json", decimals: 6 },
    { label: "LBTC/USDT", file: "targets/fluid-contracts-public/deployments/mainnet/VaultT1_LBTC_USDT.json", decimals: 6 },
    { label: "LBTC/GHO", file: "targets/fluid-contracts-public/deployments/mainnet/VaultT1_LBTC_GHO.json", decimals: 18 },
  ],
  resolverFile: "targets/fluid-contracts-public/deployments/mainnet/VaultResolver.json",
};

const ORACLE_IFACE = new ethers.Interface([
  "function publishNewRatio(bytes rawPayload,bytes proof)",
  "function consortium() view returns (address)",
  "function token() view returns (address)",
  "function denomHash() view returns (bytes32)",
  "function ratio() view returns (uint256)",
  "function nextRatio() view returns (uint256,uint256)",
  "function getRate() view returns (uint256)",
  "function maxAheadInterval() view returns (uint256)",
  "function ratioThreshold() view returns (uint256)",
  "function owner() view returns (address)",
]);
const CONSORTIUM_IFACE = new ethers.Interface([
  "function curEpoch() view returns (uint256)",
  "function getValidatorSet(uint256 epoch) view returns (tuple(address[] validators,uint256[] weights,uint256 weightThreshold))",
  "function checkProof(bytes32 payloadHash,bytes proof) view",
]);
const FLUID_ORACLE_IFACE = new ethers.Interface([
  "function getExchangeRate() view returns (uint256)",
  "function getExchangeRateOperate() view returns (uint256)",
  "function getExchangeRateLiquidate() view returns (uint256)",
  "function configPercentDiff() view returns (uint256)",
  "function isHeartbeatTrigger() view returns (bool)",
  "function configData() view returns (address,uint16,uint24,uint40,address,bool,bool,bool,uint256,uint24,uint24,uint256)",
]);
const LEGACY_RATE_IFACE = new ethers.Interface([
  "function configData() view returns (uint256 minUpdateDiffPercent,uint256 minHeartbeat,uint40 lastUpdateTime,address rateSource)",
  "function getExchangeRate() view returns (uint256)",
  "function getExchangeRateOperate() view returns (uint256)",
  "function getExchangeRateLiquidate() view returns (uint256)",
]);
const AGGREGATOR_IFACE = new ethers.Interface([
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
]);

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), "utf8"); }
function readJson(relOrAbs) { const p = path.isAbsolute(relOrAbs) ? relOrAbs : path.join(ROOT, relOrAbs); return JSON.parse(fs.readFileSync(p, "utf8")); }
function ensure(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function sha256Hex(hex) { return `0x${sha256(Buffer.from(String(hex).replace(/^0x/, ""), "hex"))}`; }
function rel(file) { return path.relative(ROOT, file).replace(/\\/g, "/"); }
function fileMeta(file) { const b = fs.readFileSync(file); return { path: rel(file), bytes: b.length, sha256: sha256(b) }; }
function sourceMeta(relative) { const p = path.join(ROOT, relative), b = fs.readFileSync(p); return { path: relative, bytes: b.length, sha256: sha256(b) }; }
function blockTag(n) { return `0x${BigInt(n).toString(16)}`; }
function normalizeAddress(value) { try { return ethers.getAddress(value); } catch { return null; } }
function slotAddress(raw) { if (!raw || !/^0x[0-9a-fA-F]{64}$/.test(raw)) return null; const a = normalizeAddress(`0x${raw.slice(-40)}`); return a && a !== ZERO ? a : null; }
function round(value, digits = 6) { const n = Number(value); return Number.isFinite(n) ? Math.round(n * 10 ** digits) / 10 ** digits : null; }
function bigintString(value) { try { return BigInt(value).toString(); } catch { return null; } }
function redactError(error) { return String(error?.message || error || "unknown").replace(/https?:\/\/\S+/g, "[redacted]").slice(0, 180); }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable(value[k])]));
  if (typeof value === "bigint") return value.toString();
  return value;
}
function canonical(value) { return JSON.stringify(stable(value)); }

function loadDeployment(relative) {
  const json = readJson(relative);
  return { label: path.basename(relative, ".json"), file: relative, address: normalizeAddress(json.address), abi: json.abi || [], args: json.args || [], deployedBytecode: json.deployedBytecode || null };
}

function makeRpc(url, stats) {
  return async (method, params, timeout = 15000) => {
    if (!READ_METHODS.has(method)) throw new Error(`disallowed RPC method ${method}`);
    stats.requests++;
    stats.methods[method] = (stats.methods[method] || 0) + 1;
    const result = await rpcCall(url, method, params, timeout);
    if (result === null) stats.nullResponses++;
    else stats.successes++;
    return result;
  };
}

async function call(rpc, to, iface, fn, args, tag, from = null) {
  try {
    const tx = { to, data: iface.encodeFunctionData(fn, args || []) };
    if (from) tx.from = from;
    const raw = await rpc("eth_call", [tx, tag], 25000);
    if (raw === null) return { ok: false, value: null, status: "null-response" };
    const fragment = iface.getFunction(fn);
    if (raw === "0x" && (fragment.outputs?.length || 0) === 0) return { ok: true, value: [], status: "success-empty-void-return" };
    if (raw === "0x") return { ok: false, value: null, status: "empty-response" };
    return { ok: true, value: iface.decodeFunctionResult(fn, raw), status: "success" };
  } catch (error) { return { ok: false, value: null, status: `decode-or-call:${redactError(error)}` }; }
}

async function fixedHead(rpc, chainId) {
  const id = await rpc("eth_chainId", []);
  if (!id || Number(BigInt(id)) !== chainId) return { status: "chain-id-unavailable-or-mismatch", blockNumber: null, blockHash: null, timestamp: null };
  const n = await rpc("eth_blockNumber", []);
  const b = n ? await rpc("eth_getBlockByNumber", [n, false]) : null;
  if (!b?.number || !b?.hash || !b?.timestamp) return { status: "head-unavailable", blockNumber: null, blockHash: null, timestamp: null };
  return { status: "fixed-head-bound", blockNumber: Number(BigInt(b.number)), blockHash: b.hash.toLowerCase(), timestamp: Number(BigInt(b.timestamp)) };
}

async function finalRecheck(rpc, head) {
  if (!head?.blockNumber) return { attempted: false, matches: null };
  const b = await rpc("eth_getBlockByNumber", [blockTag(head.blockNumber), false]);
  const observed = b ? { blockNumber: Number(BigInt(b.number)), blockHash: String(b.hash).toLowerCase(), timestamp: Number(BigInt(b.timestamp)) } : null;
  return { attempted: true, matches: Boolean(observed && observed.blockNumber === head.blockNumber && observed.blockHash === head.blockHash && observed.timestamp === head.timestamp), observed };
}

async function codeBinding(rpc, address, tag, artifactBytecode = null) {
  const [code, implRaw, adminRaw] = await Promise.all([
    rpc("eth_getCode", [address, tag]), rpc("eth_getStorageAt", [address, EIP1967_IMPL, tag]), rpc("eth_getStorageAt", [address, EIP1967_ADMIN, tag]),
  ]);
  const implementation = slotAddress(implRaw);
  const implCode = implementation ? await rpc("eth_getCode", [implementation, tag]) : null;
  const runtimeHash = code && code !== "0x" ? ethers.keccak256(code) : null;
  const implRuntimeHash = implCode && implCode !== "0x" ? ethers.keccak256(implCode) : null;
  const artifactRuntimeHash = artifactBytecode ? ethers.keccak256(artifactBytecode) : null;
  return {
    codePresent: Boolean(code && code !== "0x"), runtimeBytes: code && code !== "0x" ? (code.length - 2) / 2 : 0, runtimeHash,
    implementation, implementationRuntimeBytes: implCode && implCode !== "0x" ? (implCode.length - 2) / 2 : null,
    implementationRuntimeHash: implRuntimeHash, admin: slotAddress(adminRaw), artifactRuntimeHash,
    artifactRuntimeMatches: artifactRuntimeHash ? artifactRuntimeHash === runtimeHash : null,
  };
}

function serializeValidatorSet(result) {
  if (!result?.ok) return null;
  const row = result.value[0];
  const validators = [...row.validators].map(normalizeAddress);
  const weights = [...row.weights].map((x) => x.toString());
  const threshold = row.weightThreshold.toString();
  const totalWeight = weights.reduce((a, b) => a + BigInt(b), 0n);
  return { validators, weights, threshold, totalWeight: totalWeight.toString(), thresholdBps: totalWeight ? Number(BigInt(threshold) * 10000n / totalWeight) : null, setHash: ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address[]", "uint256[]", "uint256"], [validators, weights, threshold])) };
}

async function consortiumState(rpc, address, tag) {
  const epochR = await call(rpc, address, CONSORTIUM_IFACE, "curEpoch", [], tag);
  const epoch = epochR.ok ? epochR.value[0].toString() : null;
  const setR = epoch ? await call(rpc, address, CONSORTIUM_IFACE, "getValidatorSet", [epoch], tag) : null;
  return { epoch, validatorSet: serializeValidatorSet(setR), complete: Boolean(epoch && setR?.ok), epochStatus: epochR.status, setStatus: setR?.status || "not-attempted" };
}

async function oracleState(rpc, cfg, tag) {
  const fields = {};
  for (const fn of ["consortium", "token", "denomHash", "ratio", "nextRatio", "getRate", "maxAheadInterval", "ratioThreshold", "owner"]) {
    const r = await call(rpc, cfg.oracle, ORACLE_IFACE, fn, [], tag);
    fields[fn] = r.ok ? (r.value.length === 1 ? r.value[0] : [...r.value]) : null;
    fields[`${fn}Status`] = r.status;
  }
  return {
    consortium: normalizeAddress(fields.consortium), token: normalizeAddress(fields.token), denomHash: fields.denomHash,
    ratio: bigintString(fields.ratio), nextRatio: fields.nextRatio ? { ratio: fields.nextRatio[0].toString(), switchTime: fields.nextRatio[1].toString() } : null,
    getRate: bigintString(fields.getRate), maxAheadInterval: bigintString(fields.maxAheadInterval), ratioThreshold: bigintString(fields.ratioThreshold), owner: normalizeAddress(fields.owner),
    statuses: Object.fromEntries(Object.entries(fields).filter(([k]) => k.endsWith("Status"))),
  };
}

async function findCreationBlock(rpc, address, head) {
  const atHead = await rpc("eth_getCode", [address, blockTag(head)]);
  if (!atHead || atHead === "0x") return { status: "no-code-at-head", blockNumber: null, archiveComplete: null };
  let lo = 0, hi = head, probes = 0;
  while (lo < hi && probes < 40) {
    const mid = Math.floor((lo + hi) / 2), code = await rpc("eth_getCode", [address, blockTag(mid)]); probes++;
    if (code === null) return { status: "archive-code-gap", blockNumber: null, archiveComplete: false, probes };
    if (code === "0x") lo = mid + 1; else hi = mid;
  }
  return { status: "creation-bound", blockNumber: lo, archiveComplete: true, probes };
}

async function completeLogs(rpc, address, topic, from, to) {
  const logs = [], gaps = [], stats = { calls: 0, splits: 0, maxAcceptedSpan: 0, minFailedSpan: null };
  async function visit(a, b) {
    stats.calls++;
    const result = await rpc("eth_getLogs", [{ address, topics: [topic], fromBlock: blockTag(a), toBlock: blockTag(b) }], 30000);
    if (Array.isArray(result)) {
      logs.push(...result); stats.maxAcceptedSpan = Math.max(stats.maxAcceptedSpan, b - a + 1); return;
    }
    const span = b - a + 1; stats.minFailedSpan = stats.minFailedSpan === null ? span : Math.min(stats.minFailedSpan, span);
    if (a === b) { gaps.push({ fromBlock: a, toBlock: b, reason: "single-block-log-query-null" }); return; }
    stats.splits++; const mid = Math.floor((a + b) / 2); await visit(a, mid); await visit(mid + 1, b);
  }
  await visit(from, to);
  const dedup = [...new Map(logs.map((x) => [`${x.transactionHash}:${x.logIndex}`, x])).values()].sort((a, b) => Number(BigInt(a.blockNumber)) - Number(BigInt(b.blockNumber)) || Number(BigInt(a.logIndex)) - Number(BigInt(b.logIndex)));
  return { logs: dedup, gaps, complete: gaps.length === 0, stats };
}

function decodeRatioPayload(rawPayload) {
  try {
    const bytes = ethers.getBytes(rawPayload);
    if (bytes.length !== 100 || rawPayload.slice(0, 10).toLowerCase() !== RATIO_SELECTOR) return { valid: false, reason: "selector-or-length" };
    const [denom, ratio, switchTime] = ethers.AbiCoder.defaultAbiCoder().decode(["bytes32", "uint256", "uint256"], `0x${rawPayload.slice(10)}`);
    return { valid: true, selector: RATIO_SELECTOR, denom, ratio: ratio.toString(), switchTime: switchTime.toString(), payloadHash: ethers.sha256(rawPayload), signedFields: ["selector", "denom", "ratio", "switchTime"] };
  } catch (error) { return { valid: false, reason: `decode:${redactError(error)}` }; }
}

function proofShape(proof) {
  try {
    const [sigs] = ethers.AbiCoder.defaultAbiCoder().decode(["bytes[]"], proof);
    return { valid: true, signatures: [...sigs].map((x) => ({ bytes: ethers.getBytes(x).length, hash: ethers.sha256(x) })), signatureCount: sigs.length, nonempty64Count: [...sigs].filter((x) => ethers.getBytes(x).length === 64).length };
  } catch (error) { return { valid: false, reason: `decode:${redactError(error)}`, signatures: [], signatureCount: null, nonempty64Count: null }; }
}

function verifyProofLocally(payloadHash, proof, set) {
  if (!set) return { assessable: false, accepted: null, reason: "validator-set-unavailable" };
  try {
    const [sigs] = ethers.AbiCoder.defaultAbiCoder().decode(["bytes[]"], proof);
    if (sigs.length !== set.validators.length) return { assessable: true, accepted: false, reason: "length-mismatch", recoveredWeight: "0", threshold: set.threshold };
    let weight = 0n; const rows = [];
    for (let i = 0; i < sigs.length; i++) {
      const b = ethers.getBytes(sigs[i]); let recovered = null, matches = false;
      if (b.length === 64) {
        const r = ethers.hexlify(b.slice(0, 32)), s = ethers.hexlify(b.slice(32, 64));
        for (const v of [27, 28]) {
          try { const candidate = ethers.recoverAddress(payloadHash, { r, s, v }); if (candidate.toLowerCase() === set.validators[i].toLowerCase()) { recovered = candidate; matches = true; break; } } catch {}
        }
      }
      if (matches) weight += BigInt(set.weights[i]);
      rows.push({ index: i, signatureBytes: b.length, expectedValidator: set.validators[i], recovered, matches, weight: set.weights[i] });
    }
    return { assessable: true, accepted: weight >= BigInt(set.threshold), reason: weight >= BigInt(set.threshold) ? "threshold-met" : "threshold-not-met", recoveredWeight: weight.toString(), threshold: set.threshold, rows };
  } catch (error) { return { assessable: false, accepted: null, reason: `decode:${redactError(error)}` }; }
}

function proofSummary(result) {
  if (!result) return null;
  return { assessable: result.assessable, accepted: result.accepted, reason: result.reason, recoveredWeight: result.recoveredWeight ?? null, threshold: result.threshold ?? null, matchingSignatures: result.rows ? result.rows.filter((x) => x.matches).length : null, signatureSlots: result.rows?.length ?? null };
}

function consortiumSummary(state) {
  if (!state) return null;
  const set = state.validatorSet;
  return { epoch: state.epoch, complete: state.complete, epochStatus: state.epochStatus, setStatus: state.setStatus, validatorSet: set ? { setHash: set.setHash, validators: set.validators.length, threshold: set.threshold, totalWeight: set.totalWeight, thresholdBps: set.thresholdBps } : null };
}

async function historyForChain(rpc, cfg, head, calldataRows) {
  const creation = await findCreationBlock(rpc, cfg.oracle, head.blockNumber);
  if (!creation.blockNumber) return { creation, logScan: { complete: false, gaps: [{ reason: creation.status }] }, events: [], publicPublishUpdates: [], completeness: "unknown" };
  const scan = await completeLogs(rpc, cfg.oracle, EVENT_TOPIC, creation.blockNumber, head.blockNumber);
  const blockCache = new Map();
  async function getBlock(n) { if (!blockCache.has(n)) blockCache.set(n, await rpc("eth_getBlockByNumber", [blockTag(n), false])); return blockCache.get(n); }
  const events = [], updates = [];
  for (const log of scan.logs) {
    const blockNumber = Number(BigInt(log.blockNumber));
    const [prevVal, newVal, switchTime] = ethers.AbiCoder.defaultAbiCoder().decode(["uint256", "uint256", "uint256"], log.data);
    const [tx, receipt, block] = await Promise.all([rpc("eth_getTransactionByHash", [log.transactionHash]), rpc("eth_getTransactionReceipt", [log.transactionHash]), getBlock(blockNumber)]);
    const base = { chainId: cfg.chainId, chain: cfg.name, blockNumber, blockHash: String(log.blockHash || block?.hash || "").toLowerCase() || null, blockTimestamp: block?.timestamp ? Number(BigInt(block.timestamp)) : null, transactionHash: log.transactionHash.toLowerCase(), transactionIndex: receipt?.transactionIndex ? Number(BigInt(receipt.transactionIndex)) : null, logIndex: Number(BigInt(log.logIndex)), receiptStatus: receipt?.status ? Number(BigInt(receipt.status)) : null, prevVal: prevVal.toString(), newVal: newVal.toString(), switchTime: switchTime.toString() };
    events.push(base);
    if (!tx?.input || tx.input.slice(0, 10).toLowerCase() !== ORACLE_IFACE.getFunction("publishNewRatio").selector.toLowerCase()) continue;
    try {
      const [rawPayload, proof] = ORACLE_IFACE.decodeFunctionData("publishNewRatio", tx.input);
      const payload = decodeRatioPayload(rawPayload), shape = proofShape(proof);
      const fixture = { dataClass: "already-public-onchain-transaction-calldata", necessity: "exact cross-chain proof compatibility and no-key fork reproduction", minimizedDuplication: true, chainId: cfg.chainId, chain: cfg.name, blockNumber, transactionHash: base.transactionHash, to: normalizeAddress(tx.to), from: normalizeAddress(tx.from), input: tx.input, inputBytes: ethers.getBytes(tx.input).length, inputHash: ethers.keccak256(tx.input), rawPayloadHash: payload.payloadHash || null, proofHash: ethers.keccak256(proof), proofBytes: ethers.getBytes(proof).length };
      calldataRows.push(fixture);
      updates.push({ ...base, payload, proof: { hash: fixture.proofHash, bytes: fixture.proofBytes, shape }, calldataRef: `${cfg.chainId}:${base.transactionHash}`, inputHash: fixture.inputHash });
    } catch (error) { updates.push({ ...base, payload: null, proof: null, calldataRef: null, decodeError: redactError(error) }); }
  }
  return { creation, logScan: { complete: scan.complete, gaps: scan.gaps, stats: scan.stats, fromBlock: creation.blockNumber, toBlock: head.blockNumber }, events, publicPublishUpdates: updates, completeness: creation.archiveComplete && scan.complete && updates.every((x) => !x.decodeError) ? "complete-through-fixed-head" : "unknown-incomplete" };
}

function fixtureIndex(fixture) { return new Map(fixture.rows.map((x) => [`${x.chainId}:${x.transactionHash}`, x])); }

async function historicalStateAndCompatibility(rpcs, configs, capture, fixture) {
  const idx = fixtureIndex(fixture), byChain = new Map(capture.chains.map((x) => [x.chainId, x]));
  for (const chain of capture.chains) {
    const rpc = rpcs[chain.chainId], cfg = configs.get(chain.chainId);
    for (const update of chain.history.publicPublishUpdates) {
      const tag = blockTag(update.blockNumber);
      update.historicalOracleImplementation = (await codeBinding(rpc, cfg.oracle, tag)).implementation;
      const fullHistoricalConsortium = await consortiumState(rpc, cfg.consortium, tag);
      update.historicalConsortium = consortiumSummary(fullHistoricalConsortium);
      const input = idx.get(update.calldataRef)?.input;
      if (input && update.payload?.payloadHash) {
        const decoded = ORACLE_IFACE.decodeFunctionData("publishNewRatio", input);
        update.localProofVerification = proofSummary(verifyProofLocally(update.payload.payloadHash, decoded[1], fullHistoricalConsortium.validatorSet));
      } else update.localProofVerification = { assessable: false, accepted: null, reason: "fixture-or-payload-unavailable" };
    }
  }

  const eth = byChain.get(1), base = byChain.get(8453), windows = [];
  if (!eth || !base) return windows;
  const pairs = [];
  for (const s of base.history.publicPublishUpdates) for (const d of eth.history.publicPublishUpdates) {
    if (!s.payload?.valid || !d.payload?.valid) continue;
    if (s.payload.denom === d.payload.denom && s.payload.ratio === d.payload.ratio && s.payload.switchTime === d.payload.switchTime) pairs.push({ source: s, destination: d });
  }
  for (const pair of pairs) {
    const s = pair.source, d = pair.destination;
    const sourceBeforeDestination = Number(s.blockTimestamp) < Number(d.blockTimestamp);
    const destinationPreBlock = d.blockNumber - 1;
    const fixtureRow = idx.get(s.calldataRef);
    const rpc = rpcs[1], cfg = configs.get(1), preTag = blockTag(destinationPreBlock);
    let destinationPreState = null, proofCall = { ok: false, status: "not-attempted" }, oracleCall = { ok: false, status: "not-attempted" }, destinationConsortium = null;
    if (sourceBeforeDestination && fixtureRow?.input) {
      destinationPreState = await oracleState(rpc, cfg, preTag);
      destinationConsortium = await consortiumState(rpc, cfg.consortium, preTag);
      const [rawPayload, proof] = ORACLE_IFACE.decodeFunctionData("publishNewRatio", fixtureRow.input);
      proofCall = await call(rpc, cfg.consortium, CONSORTIUM_IFACE, "checkProof", [ethers.sha256(rawPayload), proof], preTag, EPHEMERAL_FROM);
      try {
        const raw = await rpc("eth_call", [{ from: EPHEMERAL_FROM, to: cfg.oracle, data: fixtureRow.input }, preTag], 30000);
        oracleCall = { ok: raw !== null, status: raw !== null ? "accepted-static-call" : "reverted-or-unavailable" };
      } catch (error) { oracleCall = { ok: false, status: `reverted:${redactError(error)}` }; }
    }
    const effectiveStart = Math.max(Number(s.blockTimestamp), Number(s.payload.switchTime));
    const effectiveTimingWindowSeconds = sourceBeforeDestination ? Math.max(0, Number(d.blockTimestamp) - effectiveStart) : 0;
    const sameProof = Boolean(s.proof?.hash && d.proof?.hash && s.proof.hash === d.proof.hash);
    windows.push({
      key: `${s.payload.denom}:${s.payload.ratio}:${s.payload.switchTime}`,
      sourceChainId: 8453, destinationChainId: 1, sourceTransactionHash: s.transactionHash, destinationTransactionHash: d.transactionHash,
      sourceTimestamp: s.blockTimestamp, destinationTimestamp: d.blockTimestamp, sourceBeforeDestination, submissionLeadSeconds: sourceBeforeDestination ? d.blockTimestamp - s.blockTimestamp : 0,
      switchTime: s.payload.switchTime, effectiveStart, effectiveTimingWindowSeconds, samePayloadHash: s.payload.payloadHash === d.payload.payloadHash, sameProofHash: sameProof,
      destinationPreBlock, destinationPreState, destinationConsortium: consortiumSummary(destinationConsortium),
      proofCompatibility: { ethCallAccepted: proofCall.ok, status: proofCall.status, localVerification: fixtureRow && destinationConsortium?.validatorSet ? proofSummary(verifyProofLocally(s.payload.payloadHash, ORACLE_IFACE.decodeFunctionData("publishNewRatio", fixtureRow.input)[1], destinationConsortium.validatorSet)) : { assessable: false, accepted: null, reason: "unavailable" } },
      oracleGuardCompatibility: { ethCallAccepted: oracleCall.ok, status: oracleCall.status },
      compatible: sourceBeforeDestination && proofCall.ok && oracleCall.ok,
      exploitableTimingCandidate: sourceBeforeDestination && proofCall.ok && oracleCall.ok && effectiveTimingWindowSeconds > 0,
      interpretation: effectiveTimingWindowSeconds > 0 ? "potential-destination-effective-acceleration-needs-consumer-fork" : "same-globally-intended-update-has-no-effective-destination-only-price-window",
    });
  }
  return windows;
}

function decodeFluidConfig(result) {
  if (!result?.ok) return null;
  const v = result.value;
  return { liquidity: normalizeAddress(v[0]), minUpdateDiffPercent: v[1].toString(), minHeartbeat: v[2].toString(), lastUpdateTime: v[3].toString(), rateSource: normalizeAddress(v[4]), invertCenterPrice: v[5], avoidForcedLiquidationsCol: v[6], avoidForcedLiquidationsDebt: v[7], maxAPRPercent: v[8].toString(), maxDownFromMaxReachedPercentCol: v[9].toString(), maxDownFromMaxReachedPercentDebt: v[10].toString(), maxDebtUpCapPercent: v[11].toString() };
}

async function rateSourceChain(rpc, address, tag, depth = 0) {
  if (!address || depth > 3) return null;
  const full = await call(rpc, address, FLUID_ORACLE_IFACE, "configData", [], tag);
  if (full.ok) {
    const config = decodeFluidConfig(full);
    return { address, kind: "fluid-capped-rate", config, child: config.rateSource && config.rateSource.toLowerCase() !== address.toLowerCase() ? await rateSourceChain(rpc, config.rateSource, tag, depth + 1) : null };
  }
  const legacy = await call(rpc, address, LEGACY_RATE_IFACE, "configData", [], tag);
  if (legacy.ok) return { address, kind: "fluid-legacy-contract-rate", config: { minUpdateDiffPercent: legacy.value[0].toString(), minHeartbeat: legacy.value[1].toString(), lastUpdateTime: legacy.value[2].toString(), rateSource: normalizeAddress(legacy.value[3]) }, child: null };
  const round = await call(rpc, address, AGGREGATOR_IFACE, "latestRoundData", [], tag);
  const decimals = await call(rpc, address, AGGREGATOR_IFACE, "decimals", [], tag);
  const description = await call(rpc, address, AGGREGATOR_IFACE, "description", [], tag);
  if (round.ok && decimals.ok) return { address, kind: "chainlink-compatible-aggregator", config: { roundId: round.value[0].toString(), answer: round.value[1].toString(), startedAt: round.value[2].toString(), updatedAt: round.value[3].toString(), answeredInRound: round.value[4].toString(), decimals: Number(decimals.value[0]), description: description.ok ? description.value[0] : null }, child: null };
  return { address, kind: "not-fluid-rate-config", config: null, child: null };
}

function parseVaultData(result, label, deployment, decimals) {
  if (!result?.ok) return { label, address: deployment.address, resolved: false, status: result?.status || "unavailable" };
  const data = result.value[0], constants = data.constantVariables ?? data[3], configs = data.configs ?? data[4], totals = data.totalSupplyAndBorrow ?? data[6], limits = data.limitsAndAvailability ?? data[7], state = data.vaultState ?? data[8];
  const borrowable = (limits.borrowable ?? limits[5]).toString(), borrowLimit = (limits.borrowLimit ?? limits[3]).toString(), totalBorrow = (totals.totalBorrowVault ?? totals[1]).toString(), totalSupply = (totals.totalSupplyVault ?? totals[0]).toString();
  return {
    label, address: deployment.address, resolved: true, vaultId: (constants.vaultId ?? constants[10]).toString(), vaultType: Number(constants.vaultType ?? constants[11]),
    supplyToken: normalizeAddress((constants.supplyToken ?? constants[8]).token0 ?? (constants.supplyToken ?? constants[8])[0]), borrowToken: normalizeAddress((constants.borrowToken ?? constants[9]).token0 ?? (constants.borrowToken ?? constants[9])[0]),
    collateralFactorBps: Number(configs.collateralFactor ?? configs[2]), liquidationThresholdBps: Number(configs.liquidationThreshold ?? configs[3]), liquidationMaxLimitBps: Number(configs.liquidationMaxLimit ?? configs[4]), liquidationPenaltyBps: Number(configs.liquidationPenalty ?? configs[6]), borrowFeeBps: Number(configs.borrowFee ?? configs[7]), oracle: normalizeAddress(configs.oracle ?? configs[8]),
    oraclePriceOperate: (configs.oraclePriceOperate ?? configs[9]).toString(), oraclePriceLiquidate: (configs.oraclePriceLiquidate ?? configs[10]).toString(),
    totalSupplyRaw: totalSupply, totalBorrowRaw: totalBorrow, borrowLimitRaw: borrowLimit, borrowableRaw: borrowable,
    borrowableHuman: ethers.formatUnits(borrowable, decimals), totalBorrowHuman: ethers.formatUnits(totalBorrow, decimals), borrowLimitHuman: ethers.formatUnits(borrowLimit, decimals), positions: Number(state.totalPositions ?? state[0]),
  };
}

async function fluidCapture(rpc, head) {
  const tag = blockTag(head.blockNumber), cappedDep = loadDeployment(FLUID.capped.file), genericDeps = FLUID.generic.map((x) => ({ ...x, deployment: loadDeployment(x.file) })), vaultDeps = FLUID.vaults.map((x) => ({ ...x, deployment: loadDeployment(x.file) })), resolverDep = loadDeployment(FLUID.resolverFile), resolverIface = new ethers.Interface(resolverDep.abi);
  const cappedBinding = await codeBinding(rpc, cappedDep.address, tag, cappedDep.deployedBytecode);
  const cappedConfigR = await call(rpc, cappedDep.address, FLUID_ORACLE_IFACE, "configData", [], tag);
  const cappedRates = {};
  for (const fn of ["getExchangeRate", "getExchangeRateOperate", "getExchangeRateLiquidate", "configPercentDiff", "isHeartbeatTrigger"]) { const r = await call(rpc, cappedDep.address, FLUID_ORACLE_IFACE, fn, [], tag); cappedRates[fn] = r.ok ? (typeof r.value[0] === "boolean" ? r.value[0] : r.value[0].toString()) : null; }
  const generic = [];
  for (const row of genericDeps) {
    const binding = await codeBinding(rpc, row.deployment.address, tag, row.deployment.deployedBytecode), rates = {};
    for (const fn of ["getExchangeRate", "getExchangeRateOperate", "getExchangeRateLiquidate"]) { const r = await call(rpc, row.deployment.address, FLUID_ORACLE_IFACE, fn, [], tag); rates[fn] = r.ok ? r.value[0].toString() : null; }
    const sources = (row.deployment.args?.[0]?.[2] || []).map((x) => normalizeAddress(x.source)).filter(Boolean), sourceChains = [];
    for (const source of sources) sourceChains.push(await rateSourceChain(rpc, source, tag));
    generic.push({ label: row.label, address: row.deployment.address, binding, rates, configuredSources: sources, sourceChains, directlyReferencesLombardOracle: sources.some((x) => x.toLowerCase() === cappedDep.args[0][0].rateSource.toLowerCase()) });
  }
  const vaults = [];
  for (const row of vaultDeps) {
    const result = await call(rpc, resolverDep.address, resolverIface, "getVaultEntireData", [row.deployment.address], tag);
    vaults.push({ ...parseVaultData(result, row.label, row.deployment, row.decimals), binding: await codeBinding(rpc, row.deployment.address, tag, row.deployment.deployedBytecode) });
  }
  const maxCapacity = vaults.filter((x) => x.resolved).reduce((a, x) => a + Number(x.borrowableHuman), 0);
  return {
    fixedBlock: head.blockNumber,
    capped: { address: cappedDep.address, binding: cappedBinding, config: decodeFluidConfig(cappedConfigR), rates: cappedRates, directLombardRateSource: decodeFluidConfig(cappedConfigR)?.rateSource || null },
    generic, vaults, maxNominalBorrowCapacityStableUnits: Number.isFinite(maxCapacity) ? round(maxCapacity, 6) : null,
    permissionlessPaths: { borrow: true, liquidation: true, evidence: ["mainOperate.sol:388-435", "main.sol:86-123"], caveat: "entrypoints are public but position, health, limit, oracle, token and liquidity checks still apply" },
  };
}

function semanticDefinitions() {
  const oracle = read(SOURCE_FILES[0]), actions = read(SOURCE_FILES[2]), consortium = read(SOURCE_FILES[3]), helpers = read(SOURCE_FILES[5]);
  const checks = {
    publishHashesRawPayload: /bytes32 payloadHash = sha256\(rawPayload\);[\s\S]{0,160}checkProof\(payloadHash, proof\)/.test(oracle),
    exactPayloadLengthThreeSlots: /payload\.length != ABI_SLOT_SIZE \* 3/.test(actions),
    decodedFieldsOnlyDenomRatioTimestamp: /abi\.decode\([\s\S]{0,100}\(bytes32, uint256, uint256\)/.test(actions),
    consortiumUsesCurrentEpochOnly: /validatorSet\[\$\.epoch\]\.validators/.test(consortium) && /validatorSet\[\$\.epoch\]\.weightThreshold/.test(consortium),
    proofIsBytesArray: /abi\.decode\(_proof, \(bytes\[\]\)\)/.test(consortium),
    directRawEcdsaNoEthPrefix: /tryRecover\(_payloadHash, 27, r, s\)/.test(consortium) && !/toEthSignedMessageHash/.test(consortium),
    testHashesSha256Payload: /const hash = ethers\.sha256\(payload\)/.test(helpers),
  };
  if (Object.values(checks).some((x) => !x)) throw new Error(`semantic source fixture failed: ${JSON.stringify(checks)}`);
  return {
    fixture: { status: "passed", checks },
    digest: "sha256(rawPayload)", payloadEncoding: "0x6c722c2c || abi.encode(bytes32 denom,uint256 ratio,uint256 switchTime)", proofEncoding: "abi.encode(bytes[] signatures), one indexed slot per current-epoch validator; accepted signatures are 64-byte r||s with v tried as 27 then 28", validatorEpochBinding: "not in signed payload; verifier selects destination contract current epoch at verification time",
    replayState: "none in StakedLBTCOracle or Consortium for ratio proofs; monotonic switchTime and ratio-delta/ahead guards are the only effective replay constraints",
    signedMaterialPresence: { actionSelector: true, denomination: true, ratio: true, switchTime: true, blockChainId: false, oracleAddress: false, lbtcTokenAddress: false, validatorEpoch: false, nonce: false, nullifier: false, eip712Domain: false },
    validationOrder: ["selector", "decode exact 96-byte body", "denomination", "strictly increasing switchTime", "maxAheadInterval", "time-scaled ratio delta", "sha256(rawPayload)", "current destination Consortium proof", "set next ratio/switchTime"],
  };
}

function derive(capture, fixture) {
  const semantics = semanticDefinitions(), eth = capture.chains.find((x) => x.chainId === 1), base = capture.chains.find((x) => x.chainId === 8453);
  const windows = capture.compatibilityWindows || [];
  const compatible = windows.filter((x) => x.compatible), timing = windows.filter((x) => x.exploitableTimingCandidate);
  const deploymentSourceEquivalence = capture.chains.every((x) => x.oracleBinding?.codePresent && x.oracleBinding?.implementationRuntimeHash) ? null : null;
  const historyComplete = capture.chains.every((x) => x.history.completeness === "complete-through-fixed-head");
  const currentSetEqual = Boolean(eth?.consortiumState?.validatorSet?.setHash && eth.consortiumState.validatorSet.setHash === base?.consortiumState?.validatorSet?.setHash);
  const currentDenomEqual = Boolean(eth?.oracleState?.denomHash && eth.oracleState.denomHash === base?.oracleState?.denomHash);
  const proofCompatibility = compatible.length > 0 ? true : (historyComplete && windows.length > 0 ? false : null);
  const timingWindow = timing.length > 0 ? true : (historyComplete && windows.length > 0 ? false : null);
  const t1ControlConsumerDelta = capture.fork?.t1ControlFork?.consumerDeltaPositive ?? capture.fork?.consumerDeltaPositive;
  const consumerDelta = timing.length > 0 && capture.fork?.ran ? t1ControlConsumerDelta : (timing.length === 0 ? false : null);
  const permissionlessExtraction = consumerDelta === true ? null : false;
  const exactPositiveEconomics = null;
  const classification = capture.fork?.ran && t1ControlConsumerDelta === false
    ? "WATCH/DOMAIN-SEPARATION-ABSENT/FORK-ACCEPTED-NO-T1-CONTROL-CONSUMER-DELTA"
    : timing.length === 0 && historyComplete
      ? "WATCH/DOMAIN-SEPARATION-ABSENT/NO-EFFECTIVE-CROSS-CHAIN-CONSUMER-WINDOW"
      : "WATCH/COVERAGE-OPEN/NO-ROUTE-PROOF";
  const gates = {
    deploymentSourceEquivalence,
    proofCompatibility,
    timingWindow,
    consumerDelta,
    permissionlessExtraction,
    exactPositiveEconomics,
    routePositive: 0,
    routeEvidenceStatus: capture.fork?.ran && t1ControlConsumerDelta === false ? "t1-control-negative-only" : timing.length === 0 && historyComplete ? "route-negative-for-covered-history" : "unknown",
    evidenceComplete: false,
    forkJustified: timing.length > 0,
    forkRan: Boolean(capture.fork?.ran),
    executableNow: 0,
    signedActionJustified: false,
  };
  return {
    generatedAt: capture.capturedAt,
    runId: capture.runId,
    scanner: `tools/${path.basename(__filename)}`,
    signal: "🟠 WATCH",
    classification,
    safety: capture.safety,
    scope: "Lombard StakedLBTCOracle cross-chain ratio proof/domain separation and exact Fluid Ethereum consumers",
    semantics,
    selectedChains: capture.chains.map((x) => ({ chainId: x.chainId, chain: x.chain, head: x.head, finalRecheck: x.finalRecheck, oracle: x.oracle, token: x.token, consortium: x.consortium, oracleBinding: x.oracleBinding, tokenBinding: x.tokenBinding, consortiumBinding: x.consortiumBinding, oracleState: x.oracleState, consortiumState: x.consortiumState })),
    history: capture.chains.map((x) => ({ chainId: x.chainId, chain: x.chain, creation: x.history.creation, logScan: x.history.logScan, completeness: x.history.completeness, ratioEvents: x.history.events.length, publicPublishUpdates: x.history.publicPublishUpdates.length, updates: x.history.publicPublishUpdates })),
    compatibility: { currentSetEqual, currentDenomEqual, windows, pairedWindows: windows.length, compatibleWindows: compatible.length, effectiveTimingWindows: timing.length },
    fluid: capture.fluid,
    fork: capture.fork || { justified: false, ran: false, reason: "no compatible effective timing window" },
    economics: { evaluated: false, exactNet: null, reason: "exact economics remain unevaluated; T1 control has no delta and T2 accepted-price evidence is incorporated separately" },
    provenance: { sourceCommit: capture.sourceCommit, sourceInputs: SOURCE_FILES.map(sourceMeta), localConfig: sourceMeta(LOMBARD_CONFIG), publicCalldataFixture: { path: rel(CALLDATA), rows: fixture.rows.length, sha256: sha256(fs.readFileSync(CALLDATA)) }, rpc: capture.rpcCoverage },
    gates,
    blockers: [
      deploymentSourceEquivalence === null ? "Lombard implementation runtime is pinned, but exact local source/build-to-runtime equivalence is not proven by an available checked-in build artifact." : null,
      !historyComplete ? "At least one selected chain history is incomplete or archive/log coverage is unavailable." : null,
      windows.length === 0 ? "No exact ratio/switchTime pair was recovered across selected deployments." : null,
      compatible.length === 0 ? "No source-before-Ethereum proof passed both destination consortium and oracle guard compatibility in covered history." : null,
      timing.length === 0 ? "No compatible proof produced an effective destination-only accepted-value interval after switchTime and before Ethereum native publication." : null,
      consumerDelta !== true ? "No fork-positive Fluid consumer price delta." : null,
      exactPositiveEconomics !== true ? "No exact positive extraction economics; capital, fees, slippage, gas and unwind remain intentionally unevaluated." : null,
    ].filter(Boolean),
  };
}

function definitionsMarkdown(raw) {
  const s = raw.semantics;
  return `# Lombard Step 7 Definitions\n\nSignal: **${raw.signal}**\n\n- **Signed payload:** ${s.payloadEncoding}.\n- **Digest:** ${s.digest}. No Ethereum signed-message prefix or EIP-712 wrapper is applied.\n- **Proof:** ${s.proofEncoding}.\n- **Compatibility window:** a source proof passes the destination current-epoch Consortium check and destination oracle guards at the block immediately before the destination native update.\n- **Effective timing window:** compatibility plus time after \`switchTime\` while destination still exposes the prior ratio. Submission lead before \`switchTime\` alone is not a consumer price differential.\n- **Route-positive:** requires a fork-positive Fluid accepted-price delta, permissionless value extraction and exact positive economics after all costs.\n- **Completeness:** \`complete-through-fixed-head\` requires creation-block archive binding, gap-free event-log coverage, receipts/transactions and decodable public publication calldata.\n\n## Signed material presence\n\n${Object.entries(s.signedMaterialPresence).map(([k,v]) => `- ${k}: ${v}`).join("\n")}\n\n## Fail-closed nulls\n\nA null gate means unavailable or insufficient evidence, never PASS or absence.\n`;
}

function sourcesMarkdown(raw) {
  const rows = raw.provenance.sourceInputs;
  return `# Lombard Step 7 Sources\n\nSignal: **${raw.signal}**\n\nPinned Lombard source commit: \`${raw.provenance.sourceCommit.observed || "null"}\`; expected: \`${raw.provenance.sourceCommit.expected}\`; match: ${raw.provenance.sourceCommit.matches}.\n\n| Path | Bytes | SHA-256 |\n|---|---:|---|\n${rows.map((x) => `| \`${x.path}\` | ${x.bytes} | \`${x.sha256}\` |`).join("\n")}\n\nDeployment files are checked-in public artifacts. Runtime equality is separately reported per deployment; it does not imply Lombard source/build equivalence where no compiled runtime artifact exists.\n`;
}

function reportMarkdown(raw) {
  const h = raw.history, c = raw.compatibility, g = raw.gates, f = raw.fluid;
  const chainRows = raw.selectedChains.map((x) => `| ${x.chain} | ${x.head.status} | ${x.head.blockNumber ?? "null"} | \`${x.head.blockHash || "null"}\` | ${x.finalRecheck.matches} | \`${x.oracle}\` | \`${x.oracleBinding.implementation || "null"}\` | ${x.consortiumState.epoch ?? "null"} | ${x.consortiumState.validatorSet?.threshold ?? "null"}/${x.consortiumState.validatorSet?.totalWeight ?? "null"} |`).join("\n");
  const historyRows = h.map((x) => `| ${x.chain} | ${x.creation.blockNumber ?? "null"} | ${x.ratioEvents} | ${x.publicPublishUpdates} | ${x.completeness} | ${x.logScan.gaps?.length ?? "null"} |`).join("\n");
  const windowRows = c.windows.length ? c.windows.map((x) => `| \`${x.sourceTransactionHash.slice(0,10)}…\` | \`${x.destinationTransactionHash.slice(0,10)}…\` | ${x.submissionLeadSeconds} | ${x.proofCompatibility.ethCallAccepted} | ${x.oracleGuardCompatibility.ethCallAccepted} | ${x.effectiveTimingWindowSeconds} | ${x.exploitableTimingCandidate} |`).join("\n") : "| none | none | 0 | null | null | 0 | false |";
  const fluidRows = f.vaults.map((x) => `| ${x.label} | \`${x.address}\` | \`${x.oracle || "null"}\` | ${x.collateralFactorBps ?? "null"} | ${x.liquidationThresholdBps ?? "null"} | ${x.borrowableHuman ?? "null"} | ${x.totalBorrowHuman ?? "null"} | ${x.binding.artifactRuntimeMatches} |`).join("\n");
  return `# Lombard Step 7 — Ratio Attestation Domain and Fluid Consumer Impact\n\nSignal: **${raw.signal}**  \nClassification: **${raw.classification}**\n\n## Result\n\nThe signed ratio material is exactly \`sha256(0x6c722c2c || abi.encode(denom, ratio, switchTime))\`. It contains no chain ID, oracle address, LBTC address, validator epoch, nonce or nullifier. That omission is a real domain-separation weakness, but omission alone is not exploit evidence. Covered history produced **${c.compatibleWindows}** destination-compatible source-before-Ethereum window(s) and **${c.effectiveTimingWindows}** effective post-switchTime destination-only price window(s). Fork ran: **${g.forkRan}**. Route-positive remains **0**.\n\n## Fixed heads and deployments\n\n| Chain | Pin | Block | Hash | Final recheck | Oracle | Implementation | Epoch | Threshold/weight |\n|---|---|---:|---|---|---|---|---:|---|\n${chainRows}\n\n- Current validator-set equality: ${c.currentSetEqual}. Current denomination equality: ${c.currentDenomEqual}.\n- Exact Lombard source/build/runtime equivalence: ${g.deploymentSourceEquivalence === null ? "null" : g.deploymentSourceEquivalence}. Runtime and implementation hashes are pinned, but no checked-in compiled Lombard runtime artifact proves equality.\n\n## Exact digest, validation and replay\n\n- Payload: ${raw.semantics.payloadEncoding}.\n- Digest: ${raw.semantics.digest}.\n- Proof: ${raw.semantics.proofEncoding}.\n- Validator epoch is selected from the destination Consortium's current storage; it is not signed.\n- Ratio proofs have no consumed-hash map. Replay is constrained only by denomination, strictly increasing switchTime, max-ahead and time-scaled ratio-delta checks.\n- Validation order: ${raw.semantics.validationOrder.join(" → ")}.\n\n## Historical publication coverage\n\n| Chain | Creation block | Ratio events | Public publish updates | Completeness | Log gaps |\n|---|---:|---:|---:|---|---:|\n${historyRows}\n\nPublic transaction calldata needed for compatibility is retained once in \`${rel(CALLDATA)}\`, explicitly labeled already-public onchain data.\n\n## Base proof → Ethereum compatibility\n\n| Base tx | Ethereum tx | Submission lead (s) | Consortium accepts | Oracle guards accept | Effective window (s) | Timing candidate |\n|---|---|---:|---|---|---:|---|\n${windowRows}\n\nA source submission before Ethereum is harmless acceleration when both submissions precede the absolute switchTime and Ethereum has installed the same globally intended update before it becomes effective.\n\n## Fluid binding\n\n- Direct Lombard-source capped rate: \`${f.capped.address}\`; configured rateSource \`${f.capped.config?.rateSource || "null"}\`; current runtime equals checked-in Fluid deployment artifact: ${f.capped.binding.artifactRuntimeMatches}.\n- Capped operate/liquidate rates: ${f.capped.rates.getExchangeRateOperate ?? "null"} / ${f.capped.rates.getExchangeRateLiquidate ?? "null"}; max APR and down-cap parameters are retained in raw evidence.\n- Generic LBTC/USDC, LBTC/USDT and LBTC/GHO oracle source chains are resolved in raw evidence. A direct checked-in constructor reference to the Lombard oracle is reported per oracle instead of inferred from names.\n\n| Vault | Address | Oracle | CF bps | LT bps | Borrowable units | Current borrow units | Runtime artifact match |\n|---|---|---|---:|---:|---:|---:|---|\n${fluidRows}\n\nMaximum nominal current stable borrow capacity across the three resolver rows: **${f.maxNominalBorrowCapacityStableUnits ?? "null"}** units. This is capacity context, not extractable value. Borrow and liquidation entrypoints are permissionless but remain position/config/liquidity constrained.\n\n## Fork and economics\n\n- Fork justified: ${g.forkJustified}; fork ran: ${g.forkRan}; reason: ${raw.fork.reason || "n/a"}.\n- Fluid consumer delta: ${g.consumerDelta}; permissionless extraction: ${g.permissionlessExtraction}; exact positive economics: ${g.exactPositiveEconomics}.\n- Economics were not opened without a fork-positive differential. Exact net remains null.\n\n## Gates\n\n\`${JSON.stringify(g)}\`\n\n## Blockers\n\n${raw.blockers.map((x) => `- ${x}`).join("\n") || "- none"}\n\n## Mitigation\n\nUse a domain-separated digest that commits to \`block.chainid\`, \`address(this)\`, token identity, denomination, validator epoch and a per-domain sequence/nullifier. Migrate pending updates carefully so a fix cannot strand an already scheduled ratio.\n\n## Safety\n\nOnly public read-only RPC methods and already-public transaction data were used. No proof or signature was submitted live, no wallet/key was used, no broadcast occurred, and no funds moved.\n`;
}

function dexSupplementMarkdown(dex) {
  const economics = dex.historicalEconomicsBound || {}, selected = dex.selectedWindow || {};
  const feeRows = (economics.feeBps1e4 || []).map((x) => `| ${x.label} | ${x.rawFee ?? "null"} | ${x.feeBps1e4 == null ? "null" : Number(x.feeBps1e4) / 10000} |`).join("\n");
  const dexDeltas = (economics.oneBtcDexDeltas || []).flatMap((x) => (x.directions || []).map((d) => `| ${x.label} | ${d.swap0to1 ? "token0 -> token1" : "token1 -> token0"} | ${d.before} | ${d.after} | ${d.signedBps1e4} |`)).join("\n");
  const composite = (economics.oneBtcCompositeDeltas || []).map((x) => `| ${x.route} | ${x.before} | ${x.after} | ${x.signedBps1e4} |`).join("\n");
  return `\n## Direct Fluid DEX supplemental fork\n\nThe direct consumer path was fork-bound as Lombard oracle -> Fluid capped rate -> direct/inverted center price -> Fluid DEX. The maximum deployed compatible window selected block \`${selected.destinationPreBlock ?? "null"}\`, lasted **${selected.effectiveTimingWindowSeconds ?? "null"} seconds**, and had a ratio-implied rate change of **${economics.grossRatioImpliedRateChangeBps1e4 == null ? "null" : Number(economics.grossRatioImpliedRateChangeBps1e4) / 10000} bps**. Direct DEX quotes changed after replay plus permissionless capped-rate rebalancing, but no funded external unwind or exact positive extraction was proven.\n\n- \`WBTC/LBTC\` \`0xe0Cc64Ab3712e2087E1D4AAB6f3A14F120449E5f\` uses inverted center price \`0xb0335b5443e19676bA973411C5A18571eB7Cd4B3\`.\n- \`LBTC/cbBTC\` \`0xc8F989E9B7ECE1b4D092Ae4db7fAF1294146bdA4\` uses capped rate \`0x503Ef5B869b3f32D407c7816710f87b1D686C103\`.\n- \`FluidCappedRate.rebalance()\` is externally callable at \`contracts/oracle/fluidCappedRate.sol:714-719\`; DEX pricing fetches the external center price at \`contracts/protocols/dex/poolT1/coreModule/helpers/coreHelpers.sol:313-329\`; inversion is \`1e54 / cappedRate.centerPrice()\` at \`contracts/oracle/centerPrices/cappedRateInvertCenterPrice.sol:23-26\`.\n\n| DEX | Raw fee | Fee (bps) |\n|---|---:|---:|\n${feeRows || "| none | null | null |"}\n\n| One-BTC direct quote | Direction | Before | After | Change (1e-4 bp) |\n|---|---|---:|---:|---:|\n${dexDeltas || "| none | none | null | null | null |"}\n\n| One-BTC composite route | Before | After | Change (1e-4 bp) |\n|---|---:|---:|---:|\n${composite || "| none | null | null | null |"}\n\nThe composite WBTC -> LBTC -> cbBTC output changed by only 11 satoshis at one-BTC size; its larger absolute WBTC/cbBTC basis existed before the replay and is not attributed to this issue. A single-DEX route still needs an external LBTC/BTC unwind. Current compatible timing and fee/slippage/gas-complete positive net remain unproven.\n\nSupplemental evidence: \`reports/raw/fast/${STEM}.dex-fork.json\`.\n`;
}

function t2SupplementMarkdown(t2) {
  const latest = t2.windows.find((x) => x.id === "latest-same-block-ordered-model"), maximum = t2.windows.find((x) => x.id === "maximum-historical");
  const latestPositions = new Map(latest.before.resolverVaults.map((x) => [x.vault.toLowerCase(), x.totalPositions]));
  const rows = t2.currentBindings.rows.map((x) => `| ${x.label} | \`${x.vault}\` / ${x.vaultId} | \`${x.resolverOracle}\` | \`${x.conversionRateSource}\` | ${latestPositions.get(x.vault.toLowerCase())}/${x.totalPositions} | \`${x.vaultRuntime.runtimeKeccak256}\` | \`${x.oracleRuntime.runtimeKeccak256}\` | ${x.deploymentBindingsMatch} |`).join("\n");
  const deltaRows = t2.acceptedPriceSummary.flatMap((w) => w.rows.map((x) => `| ${w.window} | ${x.label} | ${x.beforeRaw} | ${x.controlRaw} | ${x.afterRaw} | ${x.decimals} | ${x.signedDeltaBps} |`)).join("\n");
  const forkRows = t2.historicalForks.map((x) => `| ${x.id} | ${x.blockNumber} | \`${x.blockHash}\` | ${x.timestamp} |`).join("\n");
  return `\n## Direct Fluid T2 vault reproducibility revision\n\nEvidence revision: **${t2.evidenceRevision}**; revised run: \`${t2.revisedRunId}\`. This section supersedes any unqualified statement that VaultResolver accepted prices did not change: the prior no-delta result is scoped only to \`t1ControlFork\`. The three exact T2 integrations are live and material: **217 positions** were present across the three resolver rows at the latest tested fork. The separately fixed current head observed ${t2.currentBindings.totalPositions} positions; this later count does not make borrower or external-consumer inventory complete.\n\n| T2 integration | Vault / ID | Resolver oracle | Oracle conversion rateSource | Positions latest-tested/fixed-head | Vault runtime | Oracle runtime | Bindings match |\n|---|---|---|---|---:|---|---|---|\n${rows}\n\nThe common capped-rate source is \`${t2.currentBindings.cappedRate.address}\`; its live \`configData().rateSource\` is Lombard oracle \`${t2.currentBindings.cappedRateSource}\`. VaultResolver is \`${t2.currentBindings.resolver.address}\` (runtime \`${t2.currentBindings.resolver.runtimeKeccak256}\`). Runtime hashes are pinned, but exact checked-in artifact/source-build equivalence remains null because immutable-linked deployed runtimes do not match the zero-linked checked-in runtime bytes.\n\n### Computed accepted-price operands\n\n| Window | Integration | Before raw | Same-time control raw | After raw | Decimals | Signed delta (bps) |\n|---|---|---:|---:|---:|---:|---:|\n${deltaRows}\n\nEvery row is computed as \`(afterRaw - controlRaw) * 10000 / controlRaw\` and rounded to five bps decimals for display; exact rational numerator/denominator operands remain in the raw artifact. Report values are asserted equal to recomputed raw rows. Thus \`t2AcceptedPriceDelta=true\` while \`t2LiquidatableAmountDelta=false\`, \`liquidationBoundaryCrossed=false\`, and \`permissionlessLiquidationRoute=false\`.\n\n### Chronology and liquidation boundaries\n\n- Latest fork \`${latest.forkBlock}\` is a **same-block ordered counterfactual**, not the prior post-native-timestamp path. At timestamp \`${latest.chronology.sameBlockOrdering.blockTimestamp}\`, replay tx index \`${latest.chronology.sameBlockOrdering.replayTransactionIndex}\` and rebalance tx index \`${latest.chronology.sameBlockOrdering.rebalanceTransactionIndex}\` are modeled before canonical native tx index \`${latest.chronology.sameBlockOrdering.modeledNativeTransactionIndex}\`. The native tx is modeled, not executed. Replay/rebalance succeeded, and all resolver liquidation/absorb amounts remained zero before and after.\n- Maximum historical pre-block \`${maximum.forkBlock}\`: replay \`${maximum.chronology.replayTimestamp}\`, rebalance \`${maximum.chronology.rebalanceTimestamp}\`, native publication \`${maximum.chronology.nativePublicationTimestamp}\`. Direct \`simulateLiquidate(0,false)\` returned \`FluidVaultError(31029)\` with zero liquidatable debt before replay, after replay, and after rebalance for all three vaults.\n- The same valid signed ratio persisted after native-publication time. This is acceleration of persistent intended state, not a temporary false or reverting value, materially limiting extraction theory.\n\n| Fork model | Block | Hash | Parent timestamp |\n|---|---:|---|---:|\n${forkRows}\n\nExecution dependencies: Node \`${t2.executionDependencies.node}\`, ethers \`${t2.executionDependencies.ethers}\`, Anvil \`${t2.executionDependencies.anvil}\`, Forge \`${t2.executionDependencies.forge}\`; \`tools/shared-rpc.js\` is manifested.\n\nNo tested position crossed a liquidation boundary. Accepted-price differences exist, but there is no boundary crossing, unwind, or exact net proof. Exact economics remain **unevaluated/null**. Classification stays **${t2.severity}**, evidence remains incomplete, and route/executable/signing gates remain false.\n\nT2 evidence: \`reports/raw/fast/${STEM}.t2-fork.json\`.\n`;
}

function assertNoLeak(text) {
  const patterns = [/https?:\/\//i, /(?:authorization|x-api-key|api[_-]?key)\s*[:=]/i, /[?&](?:key|token|secret|apikey)=/i];
  if (patterns.some((x) => x.test(text))) throw new Error("endpoint/header/secret leak guard failed");
}

function writeDerived(capture, fixture) {
  const raw = derive(capture, fixture);
  let dex = null, t2 = null;
  try { if (fs.existsSync(DEX_FORK_ARTIFACT)) dex = readJson(DEX_FORK_ARTIFACT); } catch {}
  try { if (fs.existsSync(T2_FORK_ARTIFACT)) t2 = readJson(T2_FORK_ARTIFACT); } catch {}
  if (dex?.dexQuoteDeltaPositive) {
    raw.classification = "WATCH/DOMAIN-SEPARATION-ABSENT/FORK-ACCEPTED-FLUID-DEX-QUOTE-DELTA-NO-EXTRACTION";
    raw.gates.consumerDelta = true;
    raw.gates.genericLendingConsumerDelta = false;
    raw.gates.directDexQuoteDelta = true;
    raw.gates.supplementalDexArtifact = `reports/raw/fast/${STEM}.dex-fork.json`;
    raw.gates.routeEvidenceStatus = "watch-dex-differential-no-complete-extraction";
    raw.blockers = [raw.blockers[0], "Direct Fluid DEX quotes changed on fork, but no funded external unwind or attributable net-positive round trip was demonstrated.", "No current compatible window or exact positive extraction economics; capital, external fees, slippage, gas and unwind remain unresolved."];
  }
  if (t2?.t2AcceptedPriceDelta) {
    raw.baseRunId = t2.baseRunId;
    raw.runId = t2.revisedRunId;
    raw.evidenceRevision = t2.evidenceRevision;
    raw.generatedAt = t2.generatedAt;
    raw.classification = t2.classification;
    raw.severity = t2.severity;
    raw.reason = "T2 accepted-price differentials are computed and bound, but no tested liquidation boundary, non-zero liquidatable amount, unwind, or exact positive net is proven.";
    raw.t1ControlFork = raw.fork?.t1ControlFork || { consumerDeltaPositive: false, reason: "T1-only control scope" };
    raw.t2 = { deployments: t2.currentBindings.rows, acceptedPriceSummary: t2.acceptedPriceSummary, liveMaterialIntegration: t2.liveMaterialIntegration, replaySemantics: t2.replaySemantics, formulaChecks: t2.formulaChecks, executionDependencies: t2.executionDependencies, historicalForks: t2.historicalForks };
    raw.gates.consumerDelta = true;
    raw.gates.t2AcceptedPriceDelta = true;
    raw.gates.t2LiquidatableAmountDelta = false;
    raw.gates.liquidationBoundaryCrossed = false;
    raw.gates.permissionlessLiquidationRoute = false;
    raw.gates.permissionlessExtraction = false;
    raw.gates.exactPositiveEconomics = null;
    raw.gates.routePositive = 0;
    raw.gates.routeEvidenceStatus = "watch-t2-accepted-price-delta-no-liquidation-boundary";
    raw.gates.evidenceComplete = false;
    raw.gates.executableNow = 0;
    raw.gates.signedActionJustified = false;
    raw.gates.supplementalT2Artifact = `reports/raw/fast/${STEM}.t2-fork.json`;
    raw.economics = { evaluated: false, exactNet: null, reason: "accepted-price differential exists, but no liquidation boundary crossing, unwind, fee/slippage/gas-complete route, or exact net proof" };
    raw.blockers = t2.blockers;
  }
  let report = reportMarkdown(raw);
  if (dex?.dexQuoteDeltaPositive) report = report.replace("- Economics were not opened without a fork-positive differential. Exact net remains null.", "- Historical direct and composite DEX quote economics were bounded; no funded external unwind, current compatible window, or exact positive net was established.") + dexSupplementMarkdown(dex);
  if (t2?.t2AcceptedPriceDelta) report += t2SupplementMarkdown(t2);
  const definitions = definitionsMarkdown(raw), sources = sourcesMarkdown(raw) + (t2?.sourceFixtures?.length ? `\n## Fluid T2 supplemental source fixtures\n\n| Path | Bytes | SHA-256 |\n|---|---:|---|\n${t2.sourceFixtures.map((x) => `| \`${x.path}\` | ${x.bytes} | \`${x.sha256}\` |`).join("\n")}\n\nThese fixtures bind exact local deployment/source inputs. Runtime hashes are separately pinned in the T2 fork artifact; source-build-runtime equivalence remains null where linked immutable bytes differ.\n` : "");
  const rawText = JSON.stringify(raw, null, 2) + "\n", fixtureText = fs.readFileSync(CALLDATA, "utf8");
  assertNoLeak(rawText + report + definitions + sources + fixtureText);
  ensure(RAW); fs.writeFileSync(RAW, rawText); fs.writeFileSync(REPORT, report); fs.writeFileSync(DEFINITIONS, definitions); fs.writeFileSync(SOURCES, sources);
  const manifestInputs = [__filename, ...(fs.existsSync(FORK_SCRIPT) ? [FORK_SCRIPT] : []), ...(fs.existsSync(DEX_FORK_SCRIPT) ? [DEX_FORK_SCRIPT] : []), ...(fs.existsSync(T2_FORK_SCRIPT) ? [T2_FORK_SCRIPT] : []), CAPTURE, CALLDATA, ...(fs.existsSync(FORK_ARTIFACT) ? [FORK_ARTIFACT] : []), ...(fs.existsSync(DEX_FORK_ARTIFACT) ? [DEX_FORK_ARTIFACT] : []), ...(fs.existsSync(T2_FORK_ARTIFACT) ? [T2_FORK_ARTIFACT] : []), ...(t2?.sourceFixtures || []).map((x) => path.join(ROOT, x.path)), RAW, REPORT, DEFINITIONS, SOURCES];
  const files = [...new Map(manifestInputs.map((x) => [path.resolve(x), x])).values()].map(fileMeta);
  const manifest = { schema: 1, runId: raw.runId, generatedAt: raw.generatedAt, classification: raw.classification, files, aggregateHash: sha256(files.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n")), safety: { endpointMaterialPersisted: false, privateKeysUsed: false, signedActions: false, broadcasts: false, liveProofSubmission: false } };
  const manifestText = JSON.stringify(manifest, null, 2) + "\n"; assertNoLeak(manifestText); fs.writeFileSync(MANIFEST, manifestText);
  return { raw, manifest };
}

async function captureNetwork() {
  const map = readJson(LOMBARD_CONFIG), rpcsResolved = await resolveRpcPool(CHAINS.map((x) => x.chainId)), configs = new Map();
  for (const c of CHAINS) {
    const local = map[c.key]?.lombard || {};
    configs.set(c.chainId, { ...c, oracle: normalizeAddress(local.StakedLBTCOracle), token: normalizeAddress(local.StakedLBTC), consortium: normalizeAddress(local.Consortium) });
  }
  const sourceCommit = { expected: EXPECTED_LOMBARD_COMMIT, observed: null, matches: false };
  try { sourceCommit.observed = require("child_process").execFileSync("git", ["rev-parse", "HEAD"], { cwd: path.join(ROOT, "targets/lombard-evm-smart-contracts"), encoding: "utf8", windowsHide: true }).trim(); sourceCommit.matches = sourceCommit.observed === sourceCommit.expected; } catch {}
  const capture = { capturedAt: new Date().toISOString(), runId: null, scanner: `tools/${path.basename(__filename)}`, sourceCommit, safety: { authorizedEndpointInventoryUsedInMemory: true, endpointMaterialPersisted: false, rpcMethods: [...READ_METHODS].sort(), liveProofSubmission: false, signedActions: false, broadcasts: false, walletOrPrivateKeyUsed: false, localForkEphemeralOnly: true }, rpcCoverage: {}, chains: [], compatibilityWindows: [], fluid: null, fork: { justified: false, ran: false, reason: "compatibility/timing gate pending" }, economics: null };
  capture.runId = `${STEM}-${capture.capturedAt.replace(/[-:.TZ]/g, "").slice(0, 14)}`;
  const calldataRows = [], rpcFns = {};
  for (const c of CHAINS) {
    const stats = { endpointAvailable: Boolean(rpcsResolved[c.chainId]), requests: 0, successes: 0, nullResponses: 0, methods: {} };
    capture.rpcCoverage[c.chainId] = stats;
    if (!rpcsResolved[c.chainId]) { capture.chains.push({ chainId: c.chainId, chain: c.name, head: { status: "coverage-gap-no-rpc" }, history: { completeness: "unknown-incomplete", events: [], publicPublishUpdates: [] } }); continue; }
    const rpc = makeRpc(rpcsResolved[c.chainId], stats), cfg = configs.get(c.chainId); rpcFns[c.chainId] = rpc;
    const head = await fixedHead(rpc, c.chainId);
    if (head.status !== "fixed-head-bound") { capture.chains.push({ chainId: c.chainId, chain: c.name, head, history: { completeness: "unknown-incomplete", events: [], publicPublishUpdates: [] } }); continue; }
    const tag = blockTag(head.blockNumber);
    const [oracleBinding, tokenBinding, consortiumBinding, oracleStateNow, consortiumStateNow] = await Promise.all([
      codeBinding(rpc, cfg.oracle, tag), codeBinding(rpc, cfg.token, tag), codeBinding(rpc, cfg.consortium, tag), oracleState(rpc, cfg, tag), consortiumState(rpc, cfg.consortium, tag),
    ]);
    const history = await historyForChain(rpc, cfg, head, calldataRows);
    capture.chains.push({ chainId: c.chainId, chain: c.name, head, finalRecheck: null, oracle: cfg.oracle, token: cfg.token, consortium: cfg.consortium, oracleBinding, tokenBinding, consortiumBinding, oracleState: oracleStateNow, consortiumState: consortiumStateNow, configCrossLinks: { oracleConsortiumMatches: oracleStateNow.consortium?.toLowerCase() === cfg.consortium?.toLowerCase(), oracleTokenMatches: oracleStateNow.token?.toLowerCase() === cfg.token?.toLowerCase() }, history });
  }
  ensure(CALLDATA); const fixture = { schema: 1, dataClass: "already-public-onchain-transaction-data", purpose: "exact compatibility and conditional local-fork fixture", warning: "Never submit these proofs live. Retained once to minimize duplication.", rows: calldataRows.sort((a, b) => a.chainId - b.chainId || a.blockNumber - b.blockNumber) }; fs.writeFileSync(CALLDATA, JSON.stringify(fixture, null, 2) + "\n");
  capture.compatibilityWindows = await historicalStateAndCompatibility(rpcFns, configs, capture, fixture);
  const eth = capture.chains.find((x) => x.chainId === 1);
  if (rpcFns[1] && eth?.head?.status === "fixed-head-bound") capture.fluid = await fluidCapture(rpcFns[1], eth.head);
  else capture.fluid = { status: "coverage-gap", capped: null, generic: [], vaults: [], maxNominalBorrowCapacityStableUnits: null };
  const timing = capture.compatibilityWindows.filter((x) => x.exploitableTimingCandidate);
  capture.fork = timing.length ? { justified: true, ran: false, reason: "effective compatibility window exists; separate ephemeral local-fork proof required" } : { justified: false, ran: false, reason: "no compatible effective timing window; fork gate closed" };
  for (const row of capture.chains) if (rpcFns[row.chainId]) row.finalRecheck = await finalRecheck(rpcFns[row.chainId], row.head);
  ensure(CAPTURE); const text = JSON.stringify(capture, null, 2) + "\n"; assertNoLeak(text); fs.writeFileSync(CAPTURE, text);
  return { capture, fixture };
}

async function main() {
  let capture, fixture;
  if (OFFLINE) { capture = readJson(CAPTURE); fixture = readJson(CALLDATA); if (fs.existsSync(FORK_ARTIFACT)) capture.fork = readJson(FORK_ARTIFACT); }
  else ({ capture, fixture } = await captureNetwork());
  const { raw, manifest } = writeDerived(capture, fixture);
  if (!QUIET) process.stdout.write(`run=${raw.runId} heads=${raw.selectedChains.map((x) => `${x.chainId}:${x.head.blockNumber ?? "null"}`).join(",")} updates=${raw.history.map((x) => `${x.chainId}:${x.publicPublishUpdates}/${x.completeness}`).join(",")} windows=${raw.compatibility.pairedWindows}/${raw.compatibility.compatibleWindows}/${raw.compatibility.effectiveTimingWindows} fork=${raw.gates.forkRan} routePositive=${raw.gates.routePositive} manifest=${manifest.aggregateHash}\n`);
}

main().catch((error) => { process.stderr.write(`scan failed: ${redactError(error)}\n`); process.exitCode = 1; });
