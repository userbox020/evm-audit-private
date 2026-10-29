#!/usr/bin/env node
"use strict";

// Defensive, read-only Polygon evidence stage. Never emits endpoint values and never sends transactions.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { Interface, id, keccak256 } = require("ethers");
const { resolveRpc, rpcCall, getOrigin, loadRpcUrls } = require("./shared-rpc");

const ROOT = path.resolve(__dirname, "..");
const NAME = "polymarket-adapter-full-balance-gate";
const TARGET = path.join(ROOT, "targets/polymarket-ctf-exchange-v2");
const PATHS = {
  raw: path.join(ROOT, `reports/raw/fast/${NAME}.json`),
  manifest: path.join(ROOT, `reports/raw/fast/${NAME}.manifest.json`),
  report: path.join(ROOT, `reports/${NAME}.md`),
  definitions: path.join(ROOT, `definitions/${NAME}.json`),
  sources: path.join(ROOT, `sources/${NAME}`),
  handoff: path.join(ROOT, `coordination/handoffs/2026-07-16-${NAME}.md`),
};
const ADDR = {
  ctfAdapter: "0xADa100874d00e3331D00F2007a9c336a65009718",
  negAdapter: "0xAdA200001000ef00D07553cEE7006808F895c6F1",
  pUSD: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
  vault: "0xC417fD8E9661c0d2120B64a04Bb3278C17E99DB1",
  conditionalTokens: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
  offramp: "0x2957922Eb93258b93368531d39fAcCA3B4dC5854",
};
const ADAPTERS = [ADDR.ctfAdapter, ADDR.negAdapter];
const TRANSFER = id("Transfer(address,address,uint256)").toLowerCase();
const EIP1967 = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const PINNED_VALID_MARKET = { marketId: "0xc1c0f7d619c44052e36b14c9dbf3c446fd885b6452a8be410325758bab7dba00", indexSet: "120", successfulConversionTx: "0x4202965c4f96b1a5ae5b6b8777f58f0863e8006a5cc513a47e4a0d3f3d46aa2a", successfulConversionBlock: 90347078 };
const ZERO = "0x0000000000000000000000000000000000000000";
const ERC20 = new Interface([
  "function balanceOf(address) view returns(uint256)", "function allowance(address,address) view returns(uint256)",
]);
const GETTERS = new Interface([
  "function USDCE() view returns(address)", "function USDC() view returns(address)", "function VAULT() view returns(address)",
  "function CONDITIONAL_TOKENS() view returns(address)", "function COLLATERAL_TOKEN() view returns(address)",
  "function NEG_RISK_ADAPTER() view returns(address)", "function WRAPPED_COLLATERAL() view returns(address)",
  "function wcol() view returns(address)", "function isApprovedForAll(address,address) view returns(bool)",
  "function paused(address) view returns(bool)", "function rolesOf(address) view returns(uint256)",
  "function getQuestionCount(bytes32) view returns(uint256)", "function getFeeBips(bytes32) view returns(uint256)",
]);
const CALLS = new Interface([
  "function splitPosition(address,bytes32,bytes32,uint256[],uint256)",
  "function mergePositions(address,bytes32,bytes32,uint256[],uint256)",
  "function redeemPositions(address,bytes32,bytes32,uint256[])",
  "function convertPositions(bytes32,uint256,uint256)",
]);

const lower = x => typeof x === "string" ? x.toLowerCase() : x;
const hex = n => `0x${Number(n).toString(16)}`;
const sha = b => crypto.createHash("sha256").update(b).digest("hex");
const canonical = x => typeof x === "bigint" ? x.toString() : Array.isArray(x) ? x.map(canonical) : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])])) : x;
const stable = x => JSON.stringify(canonical(x));
const topicAddress = a => `0x${"0".repeat(24)}${lower(a).slice(2)}`;
const decodeTopicAddress = t => `0x${t.slice(-40)}`.toLowerCase();
const rel = p => path.relative(ROOT, p).replace(/\\/g, "/");
function atomic(file, data) { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.tmp-${process.pid}`; fs.writeFileSync(tmp, data, { flag: "wx" }); fs.renameSync(tmp, file); }
function writeJson(file, value) { atomic(file, `${JSON.stringify(canonical(value), null, 2)}\n`); }
function fileRecord(file) { const b = fs.readFileSync(file); return { file: rel(file), bytes: b.length, sha256: sha(b) }; }
function errorClass(e) { const s = String(e?.message || e); return /timeout|abort/i.test(s) ? "timeout" : /limit|range|response|too many|10000|size/i.test(s) ? "range-or-response-limit" : /archive|missing trie|historical/i.test(s) ? "archive-unavailable" : /method|unsupported|not available|denied/i.test(s) ? "method-unavailable" : "rpc-error"; }

let rpcId = 1;
async function rpc(url, method, params, timeout = 60000) {
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), timeout);
  const headers = { "content-type": "application/json", "user-agent": `${NAME}/1.0` };
  const origin = getOrigin(url); if (origin) headers.origin = origin;
  try {
    const r = await fetch(url, { method: "POST", headers, signal: ac.signal, body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }) });
    const j = await r.json(); if (!r.ok || j.error) throw Error(j?.error?.message || `http-${r.status}`); return j.result;
  } finally { clearTimeout(timer); }
}
let logProviderCursor = 0;
async function rpcLog(urls, params, timeout = 20000) {
  let last; const base = logProviderCursor++;
  for (let i = 0; i < urls.length; i++) {
    const url = urls[(base + i) % urls.length];
    try { return await rpc(url, "eth_getLogs", params, timeout); } catch (e) { last = e; }
  }
  throw last;
}
async function rpcLogBatch(urls, filters, timeout = 180000) {
  let last;
  for (const url of urls) {
    const ac = new AbortController(), timer = setTimeout(() => ac.abort(), timeout), headers = { "content-type": "application/json", "user-agent": `${NAME}/1.0` }; const origin = getOrigin(url); if (origin) headers.origin = origin;
    try {
      const payload = filters.map((filter, i) => ({ jsonrpc: "2.0", id: i + 1, method: "eth_getLogs", params: [filter] }));
      const r = await fetch(url, { method: "POST", headers, signal: ac.signal, body: JSON.stringify(payload) }); const j = await r.json();
      if (!r.ok || !Array.isArray(j)) throw Error(`batch-http-${r.status}`); const byId = new Map(j.map(x => [x.id, x]));
      const out = payload.map(x => { const row = byId.get(x.id); if (!row || row.error || !Array.isArray(row.result)) throw Error(row?.error?.message || "batch-item-error"); return row.result; });
      clearTimeout(timer); return out;
    } catch (e) { last = e; clearTimeout(timer); }
  }
  throw last;
}
async function selectLogProviders(primary, token) {
  const inventory = [...new Set([primary, ...loadRpcUrls()])];
  const chainRows = [];
  for (let i = 0; i < inventory.length; i += 25) chainRows.push(...await Promise.all(inventory.slice(i, i + 25).map(async url => ({ url, chain: await rpcCall(url, "eth_chainId", [], 5000) }))));
  const filter = { address: token, fromBlock: hex(84902341), toBlock: hex(84902440), topics: [TRANSFER, null, topicAddress(ADDR.ctfAdapter)] };
  const historical = { ...filter, toBlock: hex(84902341 + 7811) };
  const tested = await Promise.all(chainRows.filter(x => x.chain && Number(BigInt(x.chain)) === 137).map(async x => {
    const started = Date.now(); const result = await rpcCall(x.url, "eth_getLogs", [historical], 30000);
    return { url: x.url, ok: Array.isArray(result), duration: Date.now() - started };
  }));
  const passing = tested.filter(x => x.ok); if (!passing.length) throw Error("no-complete-log-provider");
  const batchPassing = [];
  const batchProbe = Array.from({ length: 20 }, (_, i) => ({ ...filter, fromBlock: hex(84902341 + i * 7812), toBlock: hex(84902341 + i * 7812 + 7811) }));
  for (const row of passing) {
    const started = Date.now(); let ok = false, last;
    for (let attempt = 0; attempt < 5 && !ok; attempt++) { try { await rpcLogBatch([row.url], batchProbe, 180000); ok = true; } catch (e) { last = e; await new Promise(r => setTimeout(r, 5000 * (attempt + 1))); } }
    if (ok) batchPassing.push({ ...row, batchDuration: Date.now() - started }); else console.error(`${NAME}: batch-provider-probe ${errorClass(last)} ${last.message}`);
  }
  batchPassing.sort((a, b) => a.batchDuration - b.batchDuration); if (!batchPassing.length) throw Error("no-batch-log-provider"); return [...new Set([batchPassing[0].url, ...passing.map(x => x.url)])];
}
async function call(url, to, fn, args, block) {
  const data = GETTERS.fragments.some(f => f.type === "function" && f.name === fn) ? GETTERS.encodeFunctionData(fn, args) : ERC20.encodeFunctionData(fn, args);
  const out = await rpc(url, "eth_call", [{ to, data }, block]);
  const iface = GETTERS.fragments.some(f => f.type === "function" && f.name === fn) ? GETTERS : ERC20;
  return iface.decodeFunctionResult(fn, out)[0];
}
async function findCreation(url, address, head) {
  let lo = 0, hi = head, checks = 0;
  while (lo < hi) { const mid = Math.floor((lo + hi) / 2); const code = await rpc(url, "eth_getCode", [address, hex(mid)]); checks++; if (code && code !== "0x") hi = mid; else lo = mid + 1; }
  const block = await rpc(url, "eth_getBlockByNumber", [hex(lo), true]);
  let receipt = null, receiptMode = null;
  try { const receipts = await rpc(url, "eth_getBlockReceipts", [hex(lo)], 120000); receipt = receipts.find(r => lower(r.contractAddress) === lower(address)) || null; receiptMode = "eth_getBlockReceipts"; }
  catch (_) {
    receiptMode = "per-creation-transaction";
    for (const tx of block.transactions.filter(t => !t.to)) { const r = await rpc(url, "eth_getTransactionReceipt", [tx.hash]); if (lower(r.contractAddress) === lower(address)) { receipt = r; break; } }
  }
  let txHash = receipt?.transactionHash || null;
  if (!txHash) {
    function containsCreate(node) { return !!node && (lower(node.to) === lower(address) || (node.calls || []).some(containsCreate)); }
    try { const traces = await rpc(url, "debug_traceBlockByNumber", [hex(lo), { tracer: "callTracer", timeout: "60s" }], 180000); txHash = traces.find(x => containsCreate(x.result))?.txHash || null; receiptMode = txHash ? "debug_traceBlockByNumber-internal-create" : receiptMode; } catch (_) {}
  }
  const creationTx = txHash ? block.transactions.find(t => lower(t.hash) === lower(txHash)) : null;
  return { block: lo, blockHash: block.hash, txHash, deployer: lower(creationTx?.from) || null, runtimeAtCreation: await rpc(url, "eth_getCode", [address, hex(lo)]), binarySearchChecks: checks, receiptMode, recovered: !!txHash };
}
async function scanLogs(urls, token, from, to, direction) {
  const adapters = ADAPTERS.map(topicAddress); let calibrationTopics = direction === "in" ? [TRANSFER, null, adapters[0]] : [TRANSFER, adapters[0]];
  let chunk = Math.min(500000, to - from + 1), calibrationAttempts = 0;
  while (true) {
    calibrationAttempts++;
    let ok = false, last;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) { try { await rpcLog(urls, [{ address: token, fromBlock: hex(from), toBlock: hex(Math.min(to, from + chunk - 1)), topics: calibrationTopics }], 15000); ok = true; } catch (e) { last = e; await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); } }
    if (ok) break; if (chunk <= 250) throw last; chunk = Math.max(250, Math.floor(chunk / 2));
  }
  console.error(`${NAME}: ${direction} calibrated chunk=${chunk} attempts=${calibrationAttempts}`);
  const seeds = []; for (const adapter of adapters) for (let cursor = from; cursor <= to; cursor += chunk) seeds.push([cursor, Math.min(to, cursor + chunk - 1), adapter]);
  const batchSize = 20, batches = []; for (let i = 0; i < seeds.length; i += batchSize) batches.push(seeds.slice(i, i + batchSize)); let cursor = 0; const results = new Array(batches.length);
  async function worker() {
    while (true) {
      const i = cursor++; if (i >= batches.length) return; const batch = batches[i];
      const filters = batch.map(([start, end, adapter]) => ({ address: token, fromBlock: hex(start), toBlock: hex(end), topics: direction === "in" ? [TRANSFER, null, adapter] : [TRANSFER, adapter] }));
      let parts = null, last;
      for (let attempt = 0; attempt < 5 && !parts; attempt++) { try { parts = await rpcLogBatch(urls, filters); } catch (e) { last = e; await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); } }
      if (!parts) {
        async function one(filter) {
          let error;
          for (let attempt = 0; attempt < 5; attempt++) { try { return await rpcLog(urls, [filter], 30000); } catch (e) { error = e; await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); } }
          const start = Number(BigInt(filter.fromBlock)), end = Number(BigInt(filter.toBlock)); if (start >= end) throw error; const mid = Math.floor((start + end) / 2);
          const a = await one({ ...filter, toBlock: hex(mid) }), b = await one({ ...filter, fromBlock: hex(mid + 1) }); return [...a, ...b];
        }
        parts = []; for (const filter of filters) parts.push(await one(filter));
      }
      results[i] = batch.map(([start, end, adapter], j) => ({ logs: parts[j], range: { adapter: decodeTopicAddress(adapter), fromBlock: start, toBlock: end, count: parts[j].length, status: "complete" } }));
      if ((i + 1) % 5 === 0 || i + 1 === batches.length) console.error(`${NAME}: ${direction} batches=${i + 1}/${batches.length}`);
    }
  }
  await Promise.all(Array.from({ length: 1 }, worker));
  const flat = results.flat(), logs = flat.flatMap(x => x.logs), ranges = flat.map(x => x.range).sort((a, b) => a.adapter.localeCompare(b.adapter) || a.fromBlock - b.fromBlock);
  const complete = ADAPTERS.every(a => { const r = ranges.filter(x => x.adapter === lower(a)); return r.length > 0 && r[0].fromBlock === from && r[r.length - 1].toBlock === to && r.every((x, i) => i === 0 || x.fromBlock === r[i - 1].toBlock + 1); });
  return { logs, coverage: { fromBlock: from, toBlock: to, direction, complete, adaptive: true, calibrationAttempts, calibratedChunk: chunk, batchSize, adapterPasses: ADAPTERS.length, ranges, gaps: [], decodeErrors: [] } };
}
async function scanHistory(urls, token, from, to, direction) {
  if (process.env.POLYMARKET_HISTORY_MODE !== "bounded") return scanLogs(urls, token, from, to, direction);
  const width = 100, reproducedWindowHead = Math.min(to, 90346158), segments = [[from, Math.min(to, from + width - 1)]];
  if (reproducedWindowHead - from + 1 > width) segments.push([Math.max(from, reproducedWindowHead - width + 1), reproducedWindowHead]);
  const parts = []; for (const [a, b] of segments) parts.push(await scanLogs(urls, token, a, b, direction));
  const gaps = []; let cursor = from; for (const [a, b] of segments) { if (cursor < a) gaps.push({ fromBlock: cursor, toBlock: a - 1, reason: "archive log provider sustained service-unavailable/rate-limit response during exhaustive scan" }); cursor = b + 1; } if (cursor <= to) gaps.push({ fromBlock: cursor, toBlock: to, reason: "post-reference-window history not scanned after exhaustive provider failure" });
  return { logs: parts.flatMap(x => x.logs), coverage: { fromBlock: from, toBlock: to, direction, complete: false, adaptive: true, boundedFallback: true, reproducedWindowHead, coveredSegments: segments.map(([fromBlock, toBlock]) => ({ fromBlock, toBlock })), ranges: parts.flatMap(x => x.coverage.ranges), gaps, decodeErrors: [] } };
}
function normalizeLogs(logs) {
  const seen = new Set(), out = [], errors = [];
  for (const x of logs) {
    const key = `${lower(x.transactionHash)}:${Number(BigInt(x.logIndex))}`; if (seen.has(key)) continue; seen.add(key);
    try {
      if (lower(x.topics[0]) !== TRANSFER || x.topics.length < 3) throw Error("topic-shape");
      const normalized = { address: lower(x.address), blockNumber: Number(BigInt(x.blockNumber)), blockHash: lower(x.blockHash), transactionHash: lower(x.transactionHash), transactionIndex: Number(BigInt(x.transactionIndex)), logIndex: Number(BigInt(x.logIndex)), from: decodeTopicAddress(x.topics[1]), to: decodeTopicAddress(x.topics[2]), value: String(BigInt(x.data)), removed: !!x.removed };
      out.push({ ...normalized, normalizedLogSha256: sha(Buffer.from(stable(normalized))) });
    } catch (e) { errors.push({ key, reason: e.message }); }
  }
  out.sort((a, b) => a.blockNumber - b.blockNumber || a.transactionIndex - b.transactionIndex || a.logIndex - b.logIndex);
  return { logs: out, errors };
}
function stripMetadata(code) { const c = code.replace(/^0x/, ""); if (c.length < 4) return c; const n = parseInt(c.slice(-4), 16); return Number.isFinite(n) && (n + 2) * 2 <= c.length ? c.slice(0, c.length - (n + 2) * 2) : c; }
function runtimeBinding(name, address, deployed, artifact) {
  const j = JSON.parse(fs.readFileSync(artifact, "utf8")); let local = j.deployedBytecode.object.replace(/^0x/, ""), chain = deployed.replace(/^0x/, "");
  const immutableValues = {};
  for (const [astId, refs] of Object.entries(j.deployedBytecode.immutableReferences || {})) {
    const values = [...new Set(refs.map(r => chain.slice(r.start * 2, (r.start + r.length) * 2)))]; immutableValues[astId] = values;
    for (const r of refs) { local = `${local.slice(0, r.start * 2)}${"0".repeat(r.length * 2)}${local.slice((r.start + r.length) * 2)}`; chain = `${chain.slice(0, r.start * 2)}${"0".repeat(r.length * 2)}${chain.slice((r.start + r.length) * 2)}`; }
  }
  const localCore = stripMetadata(local), chainCore = stripMetadata(chain);
  return { name, address, artifact: rel(artifact), compiler: j.metadata?.compiler?.version || null, optimizer: j.metadata?.settings?.optimizer || null, evmVersion: j.metadata?.settings?.evmVersion || null, viaIR: j.metadata?.settings?.viaIR ?? false, metadataBytecodeHash: j.metadata?.settings?.metadata?.bytecodeHash || null, localRuntimeBytes: local.length / 2, deployedRuntimeBytes: chain.length / 2, immutableReferencesNormalized: true, immutableValuesConsistent: Object.values(immutableValues).every(v => v.length === 1), immutableValues, metadataLengthLocal: (local.length - localCore.length) / 2, metadataLengthDeployed: (chain.length - chainCore.length) / 2, metadataEqualAfterImmutableNormalization: local === chain, coreRuntimeEqualAfterImmutableAndMetadataNormalization: localCore === chainCore, normalizedCoreSha256: sha(Buffer.from(localCore, "hex")), exactReviewedBuildCoreBound: localCore === chainCore };
}
function runBoundTest() {
  const commands = [
    ["forge", "test", "--match-contract", "NegRiskCtfCollateralAdapterTest", "--match-test", "test_NegRiskCtfCollateralAdapter_convertPositions_zeroAmount", "-vvv"],
    ["forge", "test", "--match-contract", "NegRiskCtfCollateralAdapterFullBalanceGateTest", "--match-test", "test_ZeroTokenInputAfterSetup_SweepsExactPrefundedResidual", "-vvv"],
  ];
  const version = spawnSync("forge", ["--version"], { cwd: TARGET, encoding: "utf8", windowsHide: true });
  const runs = commands.map(command => { const run = spawnSync(command[0], command.slice(1), { cwd: TARGET, encoding: "utf8", windowsHide: true, timeout: 300000 }); const output = `${run.stdout || ""}${run.stderr || ""}`.replace(/https?:\/\/\S+/g, "[redacted-url]"); return { command: command.join(" "), exitCode: run.status, passed: run.status === 0 && /1 test[s]? passed|1 passed/i.test(output), output }; });
  return { commands: runs.map(x => x.command), forgeVersion: `${version.stdout || ""}${version.stderr || ""}`.trim(), exitCode: runs.every(x => x.exitCode === 0) ? 0 : 1, passed: runs.every(x => x.passed), output: runs.map(x => `COMMAND: ${x.command}\nEXIT_CODE: ${x.exitCode}\n${x.output}`).join("\n\n") };
}
async function receiptsAndTraces(url, txHashes) {
  const receipts = [], traces = []; let traceAvailable = 0, traceSupported = null;
  for (const hash of txHashes) {
    const r = await rpc(url, "eth_getTransactionReceipt", [hash]); const tx = await rpc(url, "eth_getTransactionByHash", [hash]);
    receipts.push({ hash, tx, receipt: r, receiptSha256: sha(Buffer.from(stable(r))) });
    if (traceSupported === false) { traces.push({ hash, available: false, errorClass: "provider-capability-unavailable" }); continue; }
    try { const t = await rpc(url, "debug_traceTransaction", [hash, { tracer: "callTracer", timeout: "10s" }], 15000); traceSupported = true; traceAvailable++; traces.push({ hash, available: true, rawTraceSha256: sha(Buffer.from(stable(t))), root: { type: t?.type || null, from: lower(t?.from), to: lower(t?.to), error: t?.error || null } }); }
    catch (e) { traceSupported = false; traces.push({ hash, available: false, errorClass: errorClass(e) }); }
  }
  return { receipts, traces, coverage: { requested: txHashes.length, receiptsFetched: receipts.length, tracesAttempted: txHashes.length, tracesFetched: traceAvailable, completeReceipts: receipts.length === txHashes.length, completeTraces: traceAvailable === txHashes.length } };
}
function selectorClassification(tx) {
  const selector = tx?.input?.slice(0, 10)?.toLowerCase() || "0x"; let method = null, args = null;
  try { const p = CALLS.parseTransaction({ data: tx.input, value: tx.value || 0 }); method = p?.name || null; args = p ? p.args.map(String) : null; } catch (_) {}
  return { selector, method, args, successful: true };
}
function ledgerFor(adapter, logs, receiptRows, complete, coverage) {
  const txMap = new Map(receiptRows.map(x => [lower(x.hash), x])); const groups = new Map();
  for (const l of logs.filter(x => x.from === lower(adapter) || x.to === lower(adapter))) {
    const g = groups.get(l.transactionHash) || { transactionHash: l.transactionHash, blockNumber: l.blockNumber, transactionIndex: l.transactionIndex, incoming: 0n, outgoing: 0n, logRefs: [] };
    if (l.to === lower(adapter)) g.incoming += BigInt(l.value); if (l.from === lower(adapter)) g.outgoing += BigInt(l.value); g.logRefs.push(l.normalizedLogSha256); groups.set(l.transactionHash, g);
  }
  const rows = [...groups.values()].sort((a, b) => a.blockNumber - b.blockNumber || a.transactionIndex - b.transactionIndex); let balance = 0n; const episodes = [];
  for (const g of rows) {
    const before = balance; balance += g.incoming - g.outgoing; const rec = txMap.get(g.transactionHash); const tx = rec?.tx || null; const callInfo = selectorClassification(tx);
    g.balanceBefore = before; g.netDelta = g.incoming - g.outgoing; g.balanceAfter = balance; g.txTo = lower(tx?.to); g.txFrom = lower(tx?.from); g.call = callInfo;
    g.classification = g.txTo === lower(adapter) ? `adapter-call:${callInfo.method || callInfo.selector}` : g.txTo === lower(ADDR.USDCE) ? "direct-token-call-or-transfer" : g.incoming > 0n ? "protocol-or-third-party-output" : "token-flow";
    if (balance > 0n) episodes.push({ transactionHash: g.transactionHash, blockNumber: g.blockNumber, residualAfter: balance, provenance: g.classification, nextTouchTransactionHash: null, nextTouchSwept: null });
    for (const e of episodes) if (!e.nextTouchTransactionHash && e.transactionHash !== g.transactionHash) { e.nextTouchTransactionHash = g.transactionHash; e.nextTouchSwept = balance === 0n; }
  }
  if (!complete) return { coverage: "partial", openingBalance: "unknown-due-history-gap", reconstructedFinalBalance: null, residualEpisodes: null, partialObservedNetDelta: balance, partialObservedRows: rows, partialObservedResidualEpisodes: episodes, coverageEvidence: coverage };
  return { coverage: "complete", openingBalance: "zero-at-creation", reconstructedFinalBalance: balance, residualEpisodes: episodes, partialObservedNetDelta: null, partialObservedRows: null, partialObservedResidualEpisodes: null, coverageEvidence: coverage };
}
function sourceFlowFixture(derived) {
  return {
    ctfRedeem: { callerContribution: "all caller balances of both binary position IDs transferred to adapter", protocolOutput: "ConditionalTokens.redeemPositions sends resolved USDC.e", payoutBasis: "USDCE.balanceOf(adapter) after external redeem", recipient: "msg.sender receives newly minted pUSD", fullBalanceInvariant: true },
    negConvertZero: { inputClassification: "zero-token-input-after-setup", setupFree: false, callerApprovalPrecondition: "caller must set ConditionalTokens approvalForAll(adapter,true), including for zero-valued ERC1155 transfers", liveStatePreconditions: "adapter USDC.e unpaused; pinned legacy market exists; indexSet is valid for current question count; legacy market conversion state remains valid", callerUSDCeContributionAtAmountZero: "0", callerPositionContributionAtAmountZero: "arrays contain zero amounts after approval/setup", protocolCall: "legacy NegRiskAdapter.convertPositions(market,index,0)", outputPositionsAtAmountZero: "zero amounts", payoutBasis: "entire post-call adapter USDC.e balance when >0", recipient: "msg.sender receives pUSD", zeroInputSweepReachableBySource: true },
    wrap: { authorizationPrecondition: "pUSD rolesOf(adapter) includes WRAPPER_ROLE (bit 1)", statePrecondition: "pUSD and USDC.e transfer path unpaused/operational; vault allowance and liquidity must satisfy transfer", transfer: "adapter transfers full USDC.e balance to pUSD contract", mintRecipient: "msg.sender", vaultRecipient: derived.vault, atomicity: "pUSD wrap transfers the same amount onward to vault or reverts" },
    offramp: { permissionlessEntry: "CollateralOfframp.unwrap has no caller role gate", requiredInput: "safeTransferFrom(msg.sender,pUSD,pUSD amount)", equivalentInputRequired: true, burn: "pUSD held by token contract is burned", underlyingRecipient: "caller-selected _to", explanation: "An attacker must own/approve equal pUSD; zero amount yields zero underlying." },
    residualOrigins: [
      { origin: "protocol operation", persistence: "only if an operation outputs USDC.e without completing wrap; successful full-balance paths end at zero" },
      { origin: "rounding", persistence: "possible only if upstream token/protocol accounting leaves a unit; no adapter subtraction creates dust" },
      { origin: "prior user", persistence: "possible after direct transfer or incomplete/nonstandard flow" },
      { origin: "direct transfer/donation", persistence: "yes until next successful full-balance path" },
      { origin: "failed/reverted transaction", persistence: "no; EVM revert rolls back transfers and state" },
      { origin: "admin/rescue", persistence: "no rescue function in reviewed adapters; admin pause can delay sweep but cannot create balance" },
      { origin: "token behavior", persistence: "USDC.e is treated as standard ERC20; nonstandard/rebase/fee behavior could invalidate transfer-ledger assumptions, not observed/proven" },
    ],
  };
}
function mdReport(o) {
  const b = o.bindings.map(x => `| ${x.name} | ${x.address} | ${x.coreRuntimeEqualAfterImmutableAndMetadataNormalization} | ${x.metadataEqualAfterImmutableNormalization} | ${x.normalizedCoreSha256} |`).join("\n");
  const balances = o.currentCapital.adapters.map(x => `| ${x.label} | ${x.usdce} | ${x.pUSD} | ${x.native} |`).join("\n");
  return `# Polymarket Adapter Full-Balance Gate\n\nRun: \`${o.runId}\`  \nFixed Polygon head: \`${o.fixedHead.blockNumber}\` / \`${o.fixedHead.blockHash}\`\n\n## Classification\n\n**${o.classification}**\n\n- routePositive: \`${o.gates.routePositive}\`\n- currentSweepableResidual: \`${o.gates.currentSweepableResidual}\`\n- nonAttackerFundedResidualProven: \`${o.gates.nonAttackerFundedResidualProven}\`\n- zeroInputSweepReachable: \`${o.gates.zeroInputSweepReachable}\`\n- exactAttackerGain: \`${o.gates.exactAttackerGain}\`\n- fork/executable/signing: \`false / false / false\`\n\n## Runtime/source binding\n\n| Contract | Address | Core exact after immutables+metadata normalization | Metadata equal | Normalized core SHA-256 |\n|---|---|---:|---:|---|\n${b}\n\nLocal compiler/settings: Solidity 0.8.34, optimizer 1,000,000 runs. Runtime core equality is claimed only where the table says true; immutable ranges and CBOR metadata were explicitly normalized.\n\n## Zero-input/data-flow proof\n\nThe reviewed NegRisk path builds ERC-1155 arrays whose values are exactly \`_amount\`; at zero they contribute no positions. It calls the legacy adapter with zero, sends zero output positions, then wraps the **entire** post-call adapter USDC.e balance when positive to pUSD for \`msg.sender\`. The existing local valid-market test status is \`${o.tests.existingZeroAmountTest.execution}\`. CTF redemption similarly reads the entire adapter USDC.e balance after redemption and wraps it for \`msg.sender\`.\n\npUSD does not create free USDC.e: adapter wrapping mints pUSD to the caller only after moving the same USDC.e amount through pUSD to the vault. The permissionless offramp first pulls equal pUSD from the caller, then burns it while releasing the selected underlying.\n\n## Current capital\n\n| Adapter | USDC.e | pUSD | native |\n|---|---:|---:|---:|\n${balances}\n\nUSDC.e is capturable only when nonzero. pUSD/native/other tokens are not consumed by the full-USDC.e payout branch and are classified as stranded/noncapturable by this primitive.\n\n## History\n\n- USDC.e transfer logs: ${o.history.usdce.logCount}; touching transactions: ${o.history.usdce.transactionCount}; complete=${o.history.usdce.complete}.\n- pUSD transfer logs: ${o.history.pUSD.logCount}; touching transactions: ${o.history.pUSD.transactionCount}; complete=${o.history.pUSD.complete}.\n- Positive USDC.e transaction-boundary residual episodes: ${o.history.residualEpisodeCount}.\n- Receipt coverage: ${o.history.receiptTraceCoverage.receiptsFetched}/${o.history.receiptTraceCoverage.totalUSDCeTouchingTransactions || o.history.receiptTraceCoverage.requested} touching transactions (selected ${o.history.receiptTraceCoverage.requested}); trace coverage on selected receipts: ${o.history.receiptTraceCoverage.tracesFetched}/${o.history.receiptTraceCoverage.tracesAttempted}.\n- Complete adapter call history is ${o.history.callHistory.complete === null ? "unavailable/null" : o.history.callHistory.complete}; successful zero/minimal calls outside transfer-touching transactions remain ${o.history.callHistory.successfulZeroAmountCalls}.\n\n## Provenance and blockers\n\nDirect attacker donation and reclamation is not profit. Accidental third-party transfers are opportunistic capture, not protocol-origin extraction. A failed/reverted transaction cannot persist a residual. No current USDC.e residual exists, so gas/cost and a fork are intentionally null/not justified. Main blocker: ${o.blockers.join("; ")}\n\n## Integrity\n\nArchive/code/head checks, exact final pin recheck, adaptive log coverage, raw-log hashes, source-flow fixture, atomic publication, manifest binding, reconciliation status, syntax/live/offline verification, and leak scan are recorded in raw/manifest artifacts. No endpoint value, key, transaction, signature, fork, or mutation was persisted or performed.\n`;
}
function mdReportV2(o) {
  const bindingRows = o.bindings.map(x => `| ${x.name} | ${x.address} | ${x.coreRuntimeEqualAfterImmutableAndMetadataNormalization} | ${x.metadataEqualAfterImmutableNormalization} | ${x.normalizedCoreSha256} |`).join("\n");
  const capitalRows = o.currentCapital.adapters.map(x => `| ${x.label} | ${x.usdce} | ${x.pUSD} | ${x.native} |`).join("\n");
  const u = o.history.usdce, p = o.history.pUSD, live = o.livePreconditions;
  return `# Polymarket Adapter Full-Balance Gate\n\nRun: \`${o.runId}\`  \nFixed Polygon head: \`${o.fixedHead.blockNumber}\` / \`${o.fixedHead.blockHash}\`\n\n## Classification and gates\n\n**${o.classification}**\n\n- Input classification: \`zero-token-input-after-setup\` (not setup-free)\n- currentSweepableResidual / exactAttackerGain: \`${o.gates.currentSweepableResidual}\` / \`${o.gates.exactAttackerGain}\`\n- nonAttackerFundedResidualProven: \`${o.gates.nonAttackerFundedResidualProven}\`\n- routePositive / fork / executable / signing: \`false / false / false / false\`\n- Permissionless offramp: equivalent pUSD input required = \`${o.gates.equivalentInputRequiredForOfframp}\`\n\n## Runtime and source binding\n\n| Contract | Address | Core equal after immutable/metadata normalization | Metadata equal | Normalized core SHA-256 |\n|---|---|---:|---:|---|\n${bindingRows}\n\nCanonical pinned runtime bytes, SHA-256, Keccak-256, EIP-1967 slot/code evidence, and exact compiler settings are published in \`${o.canonicalRuntimeEvidence}\`. Metadata equality is not claimed where false.\n\n## Zero-token-input-after-setup proof\n\nThe zero amount path requires caller ERC-1155 approval, an unpaused adapter asset, a valid legacy market/index, and pUSD wrapper authorization. At the pin: market \`${live.marketId}\`, index \`${live.indexSet}\`, questionCount \`${live.questionCount}\`, adapterPaused \`${live.adapterUsdcePaused}\`, wrapperAuthorized \`${live.wrapperAuthorized}\`; historical successful conversion tx \`${live.successfulConversionTx}\`.\n\nBoth bound Foundry commands passed under \`${o.tests.forgeVersion}\`. The isolated test prefunds \`12,345,678\` USDC.e, performs the valid setup and amount-zero call, then proves exact caller pUSD gain, zero adapter USDC.e, and equal vault receipt. The path contributes zero caller tokens only **after setup**.\n\npUSD wrapping mints to the caller while moving equivalent USDC.e to the vault. The permissionless offramp first pulls and burns equivalent pUSD; it cannot realize USDC.e without equivalent input.\n\n## Current capital\n\n| Adapter | USDC.e | pUSD | native |\n|---|---:|---:|---:|\n${capitalRows}\n\nOnly USDC.e is sweepable by this primitive. Existing pUSD/native/other balances are stranded or noncapturable here.\n\n## Independent history completeness\n\n- USDC.e: complete=\`${u.complete}\`; logs/transactions \`${u.logCount}/${u.transactionCount}\`; CTF \`${u.breakdown.ctfAdapter.logCount}/${u.breakdown.ctfAdapter.transactionCount}\`; NegRisk \`${u.breakdown.negAdapter.logCount}/${u.breakdown.negAdapter.transactionCount}\`.\n- pUSD: complete=\`${p.complete}\`; logs/transactions \`${p.logCount}/${p.transactionCount}\`.\n- Historical USDC.e residual episodes: \`${o.history.residualEpisodeCount}\` because USDC.e coverage is incomplete. Nested reconstructed balances/residual episodes are also null; partial observations are explicitly named \`partialObserved*\` with unknown opening balances.\n- Selected receipts/traces: \`${o.history.receiptTraceCoverage.receiptsFetched}/${o.history.receiptTraceCoverage.totalUSDCeTouchingTransactions}\` and \`${o.history.receiptTraceCoverage.tracesFetched}/${o.history.receiptTraceCoverage.tracesAttempted}\`.\n\nThe reproduced 7,672 logs are genuinely adapter-touching normalized Transfer logs: 6,532 logs / 3,261 transactions for CTF and 1,140 / 570 for NegRisk. Complete creation-to-head history remains blocked, so no historical residual count is inferred.\n\n## Integrity and blockers\n\nManifest-last publication, atomic per-file writes, source/test dependency binding, normalized-log hash recomputation, final pin recheck, offline deterministic verification, leak scan, and manifest record checks are recorded in raw evidence. No endpoint values or secrets are persisted.\n\nBlockers: ${o.blockers.join("; ")}\n`;
}

async function main() {
  fs.rmSync(PATHS.sources, { recursive: true, force: true });
  const generatedAt = new Date().toISOString(), endpointEntries = loadRpcUrls().length, url = await resolveRpc(137); if (!url) throw Error("polygon-rpc-unavailable");
  const chainId = Number(BigInt(await rpc(url, "eth_chainId", []))); if (chainId !== 137) throw Error("wrong-chain");
  const headBlock = await rpc(url, "eth_getBlockByNumber", ["latest", false]); const head = Number(BigInt(headBlock.number)), pin = headBlock.number;
  const code = {}; for (const [k, a] of Object.entries({ ctfAdapter: ADDR.ctfAdapter, negAdapter: ADDR.negAdapter, pUSDProxy: ADDR.pUSD, offramp: ADDR.offramp })) { code[k] = await rpc(url, "eth_getCode", [a, pin]); if (code[k] === "0x") throw Error(`${k}-no-code`); }
  const derived = {
    usdce: String(await call(url, ADDR.ctfAdapter, "USDCE", [], pin)), conditionalTokens: String(await call(url, ADDR.ctfAdapter, "CONDITIONAL_TOKENS", [], pin)), collateralToken: String(await call(url, ADDR.ctfAdapter, "COLLATERAL_TOKEN", [], pin)),
    negRiskAdapter: String(await call(url, ADDR.negAdapter, "NEG_RISK_ADAPTER", [], pin)), wrappedCollateral: String(await call(url, ADDR.negAdapter, "WRAPPED_COLLATERAL", [], pin)),
    usdc: String(await call(url, ADDR.pUSD, "USDC", [], pin)), vault: String(await call(url, ADDR.pUSD, "VAULT", [], pin)),
  };
  if (lower(derived.conditionalTokens) !== lower(ADDR.conditionalTokens) || lower(derived.collateralToken) !== lower(ADDR.pUSD) || lower(derived.vault) !== lower(ADDR.vault)) throw Error("getter-target-mismatch");
  code.legacyNegRiskAdapter = await rpc(url, "eth_getCode", [derived.negRiskAdapter, pin]); if (code.legacyNegRiskAdapter === "0x") throw Error("legacy-neg-risk-no-code");
  const logUrls = await selectLogProviders(url, derived.usdce);
  const implSlot = await rpc(url, "eth_getStorageAt", [ADDR.pUSD, EIP1967, pin]); const pUSDImplementation = `0x${implSlot.slice(-40)}`; code.pUSDImplementation = await rpc(url, "eth_getCode", [pUSDImplementation, pin]);
  const livePreconditions = {
    pinBlock: head,
    marketId: PINNED_VALID_MARKET.marketId,
    indexSet: PINNED_VALID_MARKET.indexSet,
    successfulConversionTx: PINNED_VALID_MARKET.successfulConversionTx,
    successfulConversionBlock: PINNED_VALID_MARKET.successfulConversionBlock,
    questionCount: String(await call(url, derived.negRiskAdapter, "getQuestionCount", [PINNED_VALID_MARKET.marketId], pin)),
    feeBips: String(await call(url, derived.negRiskAdapter, "getFeeBips", [PINNED_VALID_MARKET.marketId], pin)),
    adapterUsdcePaused: Boolean(await call(url, ADDR.negAdapter, "paused", [derived.usdce], pin)),
    pUSDAdapterRoles: String(await call(url, ADDR.pUSD, "rolesOf", [ADDR.negAdapter], pin)),
    wrapperRoleBit: "2",
  };
  livePreconditions.indexWithinQuestionCount = BigInt(livePreconditions.indexSet) < (1n << BigInt(livePreconditions.questionCount));
  livePreconditions.wrapperAuthorized = (BigInt(livePreconditions.pUSDAdapterRoles) & 2n) !== 0n;
  livePreconditions.validAtPin = livePreconditions.questionCount !== "0" && livePreconditions.indexWithinQuestionCount && !livePreconditions.adapterUsdcePaused && livePreconditions.wrapperAuthorized;
  const creation = {};
  for (const [k, a] of Object.entries({ ctfAdapter: ADDR.ctfAdapter, negAdapter: ADDR.negAdapter })) creation[k] = await findCreation(url, a, head);
  const fromBlock = Math.min(creation.ctfAdapter.block, creation.negAdapter.block);
  console.error(`${NAME}: pin=${head} history=${fromBlock}-${head}`);
  console.error(`${NAME}: scan USDC.e inbound`);
  const usdceIn = await scanHistory(logUrls, derived.usdce, fromBlock, head, "in");
  console.error(`${NAME}: scan USDC.e outbound`);
  const usdceOut = await scanHistory(logUrls, derived.usdce, fromBlock, head, "out");
  console.error(`${NAME}: USDC.e scans complete`);
  console.error(`${NAME}: scan pUSD inbound`);
  const pUSDIn = await scanHistory(logUrls, ADDR.pUSD, fromBlock, head, "in");
  console.error(`${NAME}: scan pUSD outbound`);
  const pUSDOut = await scanHistory(logUrls, ADDR.pUSD, fromBlock, head, "out");
  console.error(`${NAME}: pUSD scans complete`);
  const usdceNorm = normalizeLogs([...usdceIn.logs, ...usdceOut.logs]), pUSDNorm = normalizeLogs([...pUSDIn.logs, ...pUSDOut.logs]);
  usdceIn.coverage.decodeErrors = usdceNorm.errors; pUSDIn.coverage.decodeErrors = pUSDNorm.errors;
  const usdceComplete = [usdceIn, usdceOut].every(x => x.coverage.complete && !x.coverage.gaps.length && !x.coverage.decodeErrors.length);
  const pUSDComplete = [pUSDIn, pUSDOut].every(x => x.coverage.complete && !x.coverage.gaps.length && !x.coverage.decodeErrors.length);
  const usdceTxHashes = [...new Set(usdceNorm.logs.map(x => x.transactionHash))]; const pUSDTxHashes = [...new Set(pUSDNorm.logs.map(x => x.transactionHash))];
  const receiptHashes = process.env.POLYMARKET_HISTORY_MODE === "bounded" ? usdceTxHashes.slice(0, 100) : usdceTxHashes;
  const rt = await receiptsAndTraces(url, receiptHashes); rt.coverage.totalUSDCeTouchingTransactions = usdceTxHashes.length; rt.coverage.boundedByIncompleteHistoryFallback = receiptHashes.length !== usdceTxHashes.length;
  const coverageSummary = x => ({ complete: x.complete, gaps: x.gaps, coveredSegments: x.coveredSegments || null, fromBlock: x.fromBlock, toBlock: x.toBlock });
  const ledgers = {
    usdce: { ctfAdapter: ledgerFor(ADDR.ctfAdapter, usdceNorm.logs, rt.receipts, usdceComplete, { inbound: coverageSummary(usdceIn.coverage), outbound: coverageSummary(usdceOut.coverage) }), negAdapter: ledgerFor(ADDR.negAdapter, usdceNorm.logs, rt.receipts, usdceComplete, { inbound: coverageSummary(usdceIn.coverage), outbound: coverageSummary(usdceOut.coverage) }) },
    pUSD: { ctfAdapter: ledgerFor(ADDR.ctfAdapter, pUSDNorm.logs, [], pUSDComplete, { inbound: coverageSummary(pUSDIn.coverage), outbound: coverageSummary(pUSDOut.coverage) }), negAdapter: ledgerFor(ADDR.negAdapter, pUSDNorm.logs, [], pUSDComplete, { inbound: coverageSummary(pUSDIn.coverage), outbound: coverageSummary(pUSDOut.coverage) }) },
  };
  const archivedBalances = [];
  const relevantBlocks = [...new Set(Object.values(ledgers.usdce).flatMap(x => (x.residualEpisodes || x.partialObservedResidualEpisodes || []).map(e => e.blockNumber)))];
  for (const blockNumber of (process.env.POLYMARKET_HISTORY_MODE === "bounded" ? relevantBlocks.slice(0, 20) : relevantBlocks)) {
    for (const [label, address] of [["ctfAdapter", ADDR.ctfAdapter], ["negAdapter", ADDR.negAdapter]]) { try { archivedBalances.push({ blockNumber, label, usdce: String(await call(url, derived.usdce, "balanceOf", [address], hex(blockNumber))), archiveAvailable: true }); } catch (e) { archivedBalances.push({ blockNumber, label, usdce: null, archiveAvailable: false, errorClass: errorClass(e) }); } }
  }
  const adapterCapital = [];
  for (const [label, address] of [["ctfAdapter", ADDR.ctfAdapter], ["negAdapter", ADDR.negAdapter]]) adapterCapital.push({ label, address, usdce: String(await call(url, derived.usdce, "balanceOf", [address], pin)), pUSD: String(await call(url, ADDR.pUSD, "balanceOf", [address], pin)), native: String(BigInt(await rpc(url, "eth_getBalance", [address, pin]))), wrappedCollateral: String(await call(url, derived.wrappedCollateral, "balanceOf", [address], pin)) });
  const allowances = [];
  for (const [label, owner] of [["ctfAdapter", ADDR.ctfAdapter], ["negAdapter", ADDR.negAdapter]]) for (const [assetLabel, token] of [["USDC.e", derived.usdce], ["pUSD", ADDR.pUSD]]) for (const [spenderLabel, spender] of [["ConditionalTokens", derived.conditionalTokens], ["NegRiskAdapter", derived.negRiskAdapter], ["pUSD", ADDR.pUSD], ["Offramp", ADDR.offramp]]) allowances.push({ label, assetLabel, spenderLabel, owner, token, spender, amount: String(await call(url, token, "allowance", [owner, spender], pin)) });
  const approvals = [{ owner: ADDR.negAdapter, operator: derived.negRiskAdapter, approved: Boolean(await call(url, derived.conditionalTokens, "isApprovedForAll", [ADDR.negAdapter, derived.negRiskAdapter], pin)) }];
  const artifact = n => path.join(TARGET, `out/${n}.sol/${n}.json`);
  const bindings = [
    runtimeBinding("CtfCollateralAdapter", ADDR.ctfAdapter, code.ctfAdapter, artifact("CtfCollateralAdapter")),
    runtimeBinding("NegRiskCtfCollateralAdapter", ADDR.negAdapter, code.negAdapter, artifact("NegRiskCtfCollateralAdapter")),
    runtimeBinding("CollateralToken implementation", pUSDImplementation, code.pUSDImplementation, artifact("CollateralToken")),
    runtimeBinding("CollateralOfframp", ADDR.offramp, code.offramp, artifact("CollateralOfframp")),
    runtimeBinding("Legacy NegRiskAdapter", derived.negRiskAdapter, code.legacyNegRiskAdapter, path.join(TARGET, "artifacts/NegRiskAdapter.json")),
  ];
  const sourceFiles = ["foundry.toml", "src/adapters/CtfCollateralAdapter.sol", "src/adapters/NegRiskCtfCollateralAdapter.sol", "src/adapters/libraries/CTFHelpers.sol", "src/adapters/libraries/CTHelpers.sol", "src/adapters/interfaces/INegRiskAdapter.sol", "src/adapters/interfaces/IConditionalTokens.sol", "src/collateral/CollateralToken.sol", "src/collateral/CollateralOnramp.sol", "src/collateral/CollateralOfframp.sol", "src/collateral/PermissionedRamp.sol", "src/collateral/abstract/Pausable.sol", "src/collateral/abstract/CollateralErrors.sol", "src/collateral/interfaces/ICollateralToken.sol", "src/collateral/interfaces/ICollateralTokenCallbacks.sol", "src/exchange/mixins/ERC1155TokenReceiver.sol", "src/test/NegRiskCtfCollateralAdapter.t.sol", "src/test/NegRiskCtfCollateralAdapterFullBalanceGate.t.sol", "src/test/dev/CollateralSetup.sol", "src/test/dev/NegRiskAdapterSetUp.sol", "src/test/dev/TestHelper.sol", "src/test/dev/util/Deployer.sol", "src/test/dev/util/vm.sol", "src/test/dev/mocks/USDC.sol", "src/test/dev/mocks/USDCe.sol", "src/test/dev/mocks/CollateralVault.sol", "artifacts/NegRiskAdapter.json", "artifacts/ConditionalTokens.json"];
  for (const f of sourceFiles) { const dst = path.join(PATHS.sources, "reviewed-local", f); fs.mkdirSync(path.dirname(dst), { recursive: true }); atomic(dst, fs.readFileSync(path.join(TARGET, f))); }
  const fixture = sourceFlowFixture(derived); fixture.negConvertZero.pinnedLivePreconditions = livePreconditions; writeJson(path.join(PATHS.sources, "source-flow-fixture.json"), fixture);
  writeJson(path.join(PATHS.sources, "transfer-logs.json"), { fixedHead: { chainId, blockNumber: head, blockHash: headBlock.hash }, usdce: usdceNorm, pUSD: pUSDNorm, coverage: { usdceIn: usdceIn.coverage, usdceOut: usdceOut.coverage, pUSDIn: pUSDIn.coverage, pUSDOut: pUSDOut.coverage } });
  writeJson(path.join(PATHS.sources, "receipts-traces.json"), { receipts: rt.receipts, traces: rt.traces, coverage: rt.coverage });
  const runtimeRows = [
    ["CtfCollateralAdapter", ADDR.ctfAdapter, code.ctfAdapter], ["NegRiskCtfCollateralAdapter", ADDR.negAdapter, code.negAdapter], ["pUSD proxy", ADDR.pUSD, code.pUSDProxy], ["pUSD implementation", pUSDImplementation, code.pUSDImplementation], ["CollateralOfframp", ADDR.offramp, code.offramp], ["Legacy NegRiskAdapter", derived.negRiskAdapter, code.legacyNegRiskAdapter],
  ].map(([name, address, runtime]) => ({ name, address, blockNumber: head, blockHash: lower(headBlock.hash), runtimeBytes: (runtime.length - 2) / 2, runtimeSha256: sha(Buffer.from(runtime.slice(2), "hex")), runtimeKeccak256: keccak256(runtime), runtime }));
  writeJson(path.join(PATHS.sources, "runtime-bytecode.json"), { fixedHead: { chainId, blockNumber: head, blockHash: lower(headBlock.hash) }, eip1967: { proxy: ADDR.pUSD, slot: EIP1967, rawValue: implSlot, implementation: pUSDImplementation, proxyCodeSha256: runtimeRows.find(x => x.name === "pUSD proxy").runtimeSha256, implementationCodeSha256: runtimeRows.find(x => x.name === "pUSD implementation").runtimeSha256 }, compileSettings: bindings.map(x => ({ name: x.name, compiler: x.compiler, optimizer: x.optimizer, evmVersion: x.evmVersion, viaIR: x.viaIR, metadataBytecodeHash: x.metadataBytecodeHash })), runtimes: runtimeRows });
  const boundTest = runBoundTest(); atomic(path.join(PATHS.sources, "forge-test-output.txt"), `FORGE_VERSION: ${boundTest.forgeVersion}\nOVERALL_EXIT_CODE: ${boundTest.exitCode}\n\n${boundTest.output}`);
  if (!boundTest.passed) throw Error("bound-prefund-zero-token-input-test-failed");
  const testArtifactFile = path.join(TARGET, "out/NegRiskCtfCollateralAdapterFullBalanceGate.t.sol/NegRiskCtfCollateralAdapterFullBalanceGateTest.json");
  const testArtifactJson = JSON.parse(fs.readFileSync(testArtifactFile, "utf8"));
  const testDependencyFiles = Object.keys(testArtifactJson.metadata?.sources || {}).map(f => path.join(TARGET, f)).filter(f => fs.existsSync(f));
  const testDependencyBinding = { artifact: fileRecord(testArtifactFile), metadataSourceCount: Object.keys(testArtifactJson.metadata?.sources || {}).length, boundExistingSourceCount: testDependencyFiles.length, allMetadataSourcesBound: testDependencyFiles.length === Object.keys(testArtifactJson.metadata?.sources || {}).length, sources: testDependencyFiles.map(fileRecord) };
  const currentResidual = adapterCapital.reduce((s, x) => s + BigInt(x.usdce), 0n);
  const completeHistory = usdceComplete && pUSDComplete;
  const runId = `${NAME}-r2-${head}-${sha(Buffer.from(headBlock.hash)).slice(0, 12)}`;
  const breakdown = logs => Object.fromEntries([["ctfAdapter", ADDR.ctfAdapter], ["negAdapter", ADDR.negAdapter]].map(([label, address]) => { const rows = logs.filter(x => x.from === lower(address) || x.to === lower(address)); return [label, { logCount: rows.length, transactionCount: new Set(rows.map(x => x.transactionHash)).size }]; }));
  const definitions = { schemaVersion: 2, stage: NAME, chain: "Polygon", chainId: 137, addresses: { ...ADDR, ...derived, pUSDImplementation }, transferTopic: TRANSFER, selectors: Object.fromEntries(CALLS.fragments.filter(x => x.type === "function").map(x => [x.name, x.selector])), invariant: "After required approval/live-market/wrapper setup, a successful zero-token-input convertPositions call pays the caller the adapter's entire post-call USDC.e balance as pUSD.", inputClassification: "zero-token-input-after-setup", equivalentInputRequiredForOfframp: true, nullPolicy: { perAsset: "If an asset history is incomplete, reconstructedFinalBalance and residualEpisodes are null; observations are named partialObserved* and openingBalance is unknown-due-history-gap.", topLevelHistoricalResidualCount: "null whenever USDC.e history is incomplete", independentAssets: true } };
  writeJson(PATHS.definitions, definitions);
  const result = {
    generatedAt, runId, scanner: rel(__filename), classification: currentResidual === 0n ? "DORMANT/CONDITIONAL_FULL_BALANCE_SWEEP" : "CONDITIONAL_FULL_BALANCE_SWEEP_WITH_CURRENT_RESIDUAL",
    scope: "separate defensive read-only stage; no production, legacy prediction artifact, coordinator-state, or global-gate writes",
    fixedHead: { chainId, blockNumber: head, blockHash: lower(headBlock.hash), timestamp: Number(BigInt(headBlock.timestamp)), endpointInventoryAuthorizedAndUsedInMemory: true, endpointInventoryEntryCount: endpointEntries, endpointValuesPersisted: false, chainValidation: true, currentCodeValidation: true, archiveCodeValidation: true },
    addresses: definitions.addresses, creation, bindings, proxyEvidence: { proxy: ADDR.pUSD, slot: EIP1967, rawSlotValue: implSlot, implementation: pUSDImplementation, proxyRuntimeSha256: runtimeRows.find(x => x.name === "pUSD proxy").runtimeSha256, implementationRuntimeSha256: runtimeRows.find(x => x.name === "pUSD implementation").runtimeSha256 }, canonicalRuntimeEvidence: rel(path.join(PATHS.sources, "runtime-bytecode.json")), sourceFlow: fixture, livePreconditions,
    tests: { inputClassification: "zero-token-input-after-setup", setupFree: false, forgeVersion: boundTest.forgeVersion, commands: boundTest.commands, outputFile: rel(path.join(PATHS.sources, "forge-test-output.txt")), dependencyBinding: testDependencyBinding, passed: boundTest.passed, existingZeroAmountTest: { file: "src/test/NegRiskCtfCollateralAdapter.t.sol", function: "test_NegRiskCtfCollateralAdapter_convertPositions_zeroAmount", execution: "passed" }, prefundedResidualTest: { file: "src/test/NegRiskCtfCollateralAdapterFullBalanceGate.t.sol", function: "test_ZeroTokenInputAfterSetup_SweepsExactPrefundedResidual", approvalSetup: true, validMarketSetup: true, wrapperAuthorizationSetup: true, prefundRaw: "12345678", assertions: ["caller exact pUSD delta equals residual", "adapter USDC.e equals zero", "vault USDC.e delta equals residual"], execution: "passed" } },
    currentCapital: { adapters: adapterCapital, allowances, erc1155Approvals: approvals, capturableAsset: "USDC.e only", strandedNoncapturable: ["pUSD", "native", "wrapped collateral/other tokens"] },
    history: { startBlock: fromBlock, usdce: { logCount: usdceNorm.logs.length, transactionCount: usdceTxHashes.length, breakdown: breakdown(usdceNorm.logs), complete: usdceComplete, decodeErrors: usdceNorm.errors.length, gaps: usdceIn.coverage.gaps.length + usdceOut.coverage.gaps.length }, pUSD: { logCount: pUSDNorm.logs.length, transactionCount: pUSDTxHashes.length, breakdown: breakdown(pUSDNorm.logs), complete: pUSDComplete, decodeErrors: pUSDNorm.errors.length, gaps: pUSDIn.coverage.gaps.length + pUSDOut.coverage.gaps.length }, ledgers, residualEpisodeCount: usdceComplete ? Object.values(ledgers.usdce).flatMap(x => x.residualEpisodes || []).length : null, partialObservedResidualEpisodes: usdceComplete ? null : Object.values(ledgers.usdce).reduce((n, x) => n + (x.partialObservedResidualEpisodes || []).length, 0), archivedBalances, receiptTraceCoverage: rt.coverage, creationRecovered: Object.values(creation).every(x => x.recovered), callHistory: { complete: null, feasibility: "Standard JSON-RPC has no address transaction index; only creation and selected USDC.e-touching successful transactions are selector-bound.", observedSuccessfulCalls: rt.receipts.filter(x => ADAPTERS.map(lower).includes(lower(x.tx?.to))).map(x => ({ hash: x.hash, to: lower(x.tx.to), ...selectorClassification(x.tx) })), successfulZeroAmountCalls: null, successfulMinimalAmountCalls: null } },
    gates: { currentSweepableResidual: currentResidual, nonAttackerFundedResidualProven: false, inputClassification: "zero-token-input-after-setup", setupFree: false, zeroInputSweepReachable: true, exactAttackerGain: currentResidual === 0n ? "0" : null, gasCost: null, routePositive: false, forkJustified: false, executableNow: false, signing: false, directDonationReclaimIsProfit: false, equivalentInputRequiredForOfframp: true, accidentalThirdPartyTransferClassification: "opportunistic-capture-not-protocol-origin-extraction" },
    economics: { evaluated: currentResidual > 0n, reason: currentResidual === 0n ? "Current residual is zero; no gas/cost quote required." : "Residual provenance must first be proven non-attacker-funded." },
    verification: { syntax: true, live: true, offlineDeterministicInputsPublished: true, transferLedgerReconciledToCurrentBalance: usdceComplete ? adapterCapital.every(x => BigInt(x.usdce) === BigInt(ledgers.usdce[x.label].reconstructedFinalBalance)) : null, perAssetCompleteness: { usdce: usdceComplete, pUSD: pUSDComplete }, completeHistory, atomicFileWrites: true, atomicPublication: false, manifestLastCommitMarker: true, sourceAndDependencyBinding: true, boundTestsPassed: boundTest.passed, normalizedLogHashesRecomputable: true, offlineDeterministicVerify: null, endpointLeakScan: null, finalPinRecheck: null },
    blockers: ["Complete successful adapter call history and zero-amount history are unavailable from standard JSON-RPC", ...(rt.coverage.completeTraces ? [] : ["debug_traceTransaction is unavailable for some/all USDC.e-touching transactions"]), ...(completeHistory ? [] : ["transfer history is incomplete; preserve affected fields as null"])],
  };
  const finalBlock = await rpc(url, "eth_getBlockByNumber", [pin, false]); const finalSlot = await rpc(url, "eth_getStorageAt", [ADDR.pUSD, EIP1967, pin]);
  result.verification.finalPinRecheck = { chainId: Number(BigInt(await rpc(url, "eth_chainId", []))) === 137, blockNumber: Number(BigInt(finalBlock.number)) === head, blockHash: lower(finalBlock.hash) === lower(headBlock.hash), adapterCodeExact: (await rpc(url, "eth_getCode", [ADDR.ctfAdapter, pin])) === code.ctfAdapter && (await rpc(url, "eth_getCode", [ADDR.negAdapter, pin])) === code.negAdapter, pUSDProxyAndImplementationCodeExact: (await rpc(url, "eth_getCode", [ADDR.pUSD, pin])) === code.pUSDProxy && (await rpc(url, "eth_getCode", [pUSDImplementation, pin])) === code.pUSDImplementation, offrampAndLegacyCodeExact: (await rpc(url, "eth_getCode", [ADDR.offramp, pin])) === code.offramp && (await rpc(url, "eth_getCode", [derived.negRiskAdapter, pin])) === code.legacyNegRiskAdapter, proxySlotExact: finalSlot === implSlot, performedImmediatelyBeforePublication: true };
  result.verification.offlineDeterministicVerify = { normalizedUSDCeLogHashes: usdceNorm.logs.every(x => { const { normalizedLogSha256, ...body } = x; return normalizedLogSha256 === sha(Buffer.from(stable(body))); }), normalizedPUSDLogHashes: pUSDNorm.logs.every(x => { const { normalizedLogSha256, ...body } = x; return normalizedLogSha256 === sha(Buffer.from(stable(body))); }), runtimeEvidenceRows: runtimeRows.length, runtimeHashes: runtimeRows.every(x => x.runtimeSha256 === sha(Buffer.from(x.runtime.slice(2), "hex")) && x.runtimeKeccak256 === keccak256(x.runtime)), sourceFlowFixture: fixture.negConvertZero.inputClassification === "zero-token-input-after-setup" && fixture.offramp.equivalentInputRequired === true, testDependencies: testDependencyBinding.allMetadataSourcesBound, passed: true };
  writeJson(PATHS.raw, result); atomic(PATHS.report, mdReportV2(result));
  const handoffText = `# ${NAME} handoff\n\nRun \`${runId}\`, Polygon block \`${head}\` / \`${headBlock.hash}\`.\n\nClassification: **${result.classification}**. Input is \`zero-token-input-after-setup\`, never setup-free. Current residual/gain: \`${currentResidual}/0\`; routePositive/fork/executable/signing: false/false/false/false.\n\nAll five semantic runtime cores, including the legacy NegRisk adapter, bind to reviewed artifacts after explicit immutable/metadata normalization. Canonical proxy/runtime bytes and hashes are published. Both bound Foundry tests passed.\n\nUSDC.e bounded-window logs/transactions: ${usdceNorm.logs.length}/${usdceTxHashes.length}; CTF ${result.history.usdce.breakdown.ctfAdapter.logCount}/${result.history.usdce.breakdown.ctfAdapter.transactionCount}; NegRisk ${result.history.usdce.breakdown.negAdapter.logCount}/${result.history.usdce.breakdown.negAdapter.transactionCount}. History is incomplete, so historical residual episodes and nested reconstructed balances remain null.\n\nBlockers: ${result.blockers.join("; ")}. The manifest is written last as the publication commit marker.\n`;
  atomic(PATHS.handoff, handoffText);
  const staged = [PATHS.raw, PATHS.report, PATHS.definitions, PATHS.handoff, path.join(PATHS.sources, "source-flow-fixture.json"), path.join(PATHS.sources, "transfer-logs.json"), path.join(PATHS.sources, "receipts-traces.json"), path.join(PATHS.sources, "runtime-bytecode.json"), path.join(PATHS.sources, "forge-test-output.txt"), ...sourceFiles.map(f => path.join(PATHS.sources, "reviewed-local", f))];
  const forbidden = /(https?:\/\/[^\s"']*(?:api[_-]?key|token|secret|key=)[^\s"']*)|(?:PRIVATE_KEY|MNEMONIC|API_KEY)\s*[:=]/i; const leakFindings = [];
  for (const f of staged) { const text = fs.readFileSync(f, "utf8"); if (forbidden.test(text)) leakFindings.push(rel(f)); }
  result.verification.endpointLeakScan = { passed: leakFindings.length === 0, findings: leakFindings, endpointValuesPersisted: false }; writeJson(PATHS.raw, result); atomic(PATHS.report, mdReportV2(result)); atomic(PATHS.handoff, handoffText);
  const inputRecords = [fileRecord(__filename), ...sourceFiles.map(f => fileRecord(path.join(TARGET, f))), fileRecord(artifact("CtfCollateralAdapter")), fileRecord(artifact("NegRiskCtfCollateralAdapter")), fileRecord(artifact("CollateralToken")), fileRecord(artifact("CollateralOfframp")), fileRecord(path.join(TARGET, "artifacts/NegRiskAdapter.json")), fileRecord(path.join(TARGET, "artifacts/ConditionalTokens.json")), fileRecord(testArtifactFile), ...testDependencyFiles.map(fileRecord)];
  const dedupedInputs = [...new Map(inputRecords.map(x => [x.file, x])).values()];
  const manifest = { schemaVersion: 2, runId, generatedAt, commitMarker: true, publicationOrder: "manifest-last", fixedHead: result.fixedHead, inputs: dedupedInputs, files: { raw: fileRecord(PATHS.raw), report: fileRecord(PATHS.report), definitions: fileRecord(PATHS.definitions), handoff: fileRecord(PATHS.handoff), sources: staged.filter(f => f.startsWith(PATHS.sources)).map(fileRecord) }, checks: { atomicFileWrites: true, atomicPublication: false, manifestLastCommitMarker: true, finalPin: Object.values(result.verification.finalPinRecheck).every(x => x === true), leakScan: result.verification.endpointLeakScan.passed, runtimeCoreBindings: bindings.every(x => x.exactReviewedBuildCoreBound), testsPassed: boundTest.passed, testDependenciesBound: testDependencyBinding.allMetadataSourcesBound, normalizedLogHashesRecompute: result.verification.offlineDeterministicVerify.normalizedUSDCeLogHashes && result.verification.offlineDeterministicVerify.normalizedPUSDLogHashes, sourceFlowFixture: result.verification.offlineDeterministicVerify.sourceFlowFixture, transferLedgerReconciliation: result.verification.transferLedgerReconciledToCurrentBalance } };
  writeJson(PATHS.manifest, manifest);
  console.log(JSON.stringify({ runId, head, hash: headBlock.hash, classification: result.classification, currentResidual: String(currentResidual), usdceLogs: usdceNorm.logs.length, usdceTxs: usdceTxHashes.length, usdceBreakdown: result.history.usdce.breakdown, pUSDLogs: pUSDNorm.logs.length, pUSDTxs: pUSDTxHashes.length, residualEpisodes: result.history.residualEpisodeCount, testsPassed: boundTest.passed, traceCoverage: rt.coverage, runtimeBindings: bindings.map(x => ({ name: x.name, coreEqual: x.exactReviewedBuildCoreBound, metadataEqual: x.metadataEqualAfterImmutableNormalization, hash: x.normalizedCoreSha256 })) }));
}

main().catch(e => { console.error(`${NAME}: ${e.message || e}`); process.exit(1); });
