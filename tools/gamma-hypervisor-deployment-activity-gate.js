#!/usr/bin/env node
"use strict";

// Bounded, read-only Ethereum capture. Endpoint inventory material remains
// process-only and is rejected from every persisted artifact.
const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");
const { Interface, getAddress, id, keccak256, solidityPackedKeccak256 } = require("./node_modules/ethers");

const ROOT = path.resolve(__dirname, "..");
const TARGET = path.join(ROOT, "targets", "gamma-hypervisor-b4d90b3");
const SOURCE = path.join(TARGET, "contracts", "Hypervisor.sol");
const UNIPROXY_SOURCE = path.join(TARGET, "contracts", "UniProxy.sol");
const INVENTORY = path.join(ROOT, "rpc_endpoints.txt");
const OUT = path.join(ROOT, "reports", "raw", "fast", "gamma-hypervisor-deployment-activity-gate");
const CAPTURE = path.join(OUT, "capture.json");
const CHECKPOINT = path.join(OUT, "checkpoint.json");
const ARTIFACT = path.join(OUT, "partial-artifact.json");
const MANIFEST = path.join(OUT, "manifest.json");

const COMMIT = "b4d90b3160873304684bd2c38ea4412cabda5021";
const CHAIN = 1n;
const HYPERVISOR = "0xd5f4877263b736625ba363385983c2d02b41f35b";
const POOL = "0xd1d5a4c0ea98971894772dcd6d2f1dc71083c44e";
const LQTY = "0x6dea81c8171d0ba574754ef6f8b412f2ed88c54d";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const HISTORICAL_BLOCK = 20639738n;
const ZERO = `0x${"0".repeat(40)}`;
const ZERO32 = `0x${"0".repeat(64)}`;
const METHODS = new Set(["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_getStorageAt", "eth_call", "eth_getLogs"]);
const LIMITS = Object.freeze({ inventoryBytes: 1024 * 1024, candidates: 64, qualifyFamilies: 32, calls: 1800,
  responseBytes: 8 * 1024 * 1024, totalResponseBytes: 160 * 1024 * 1024, requestMs: 15000,
  wallMs: 12 * 60 * 1000, logChunk: 50000n, minimumLogChunk: 1000n, eventRows: 20000, apiBytes: 32 * 1024 * 1024 });
const API_URL = "https://wire2.gamma.xyz/hypervisors/allData";

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function addr(value) { try { return getAddress(value).toLowerCase(); } catch (_) { return null; } }
function quantity(value) { return `0x${BigInt(value).toString(16)}`; }
function pinArg(pin) { return { blockHash: pin.hash, requireCanonical: true }; }
function serial(value) {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return /^0x[0-9a-fA-F]{40}$/u.test(value) ? value.toLowerCase() : value;
  if (Array.isArray(value)) return value.map(serial);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/^\d+$/u.test(key)).map(([key, item]) => [key, serial(item)]));
  return value;
}
function bytes(hex) { return typeof hex === "string" && /^0x(?:[0-9a-fA-F]{2})*$/u.test(hex) ? Buffer.from(hex.slice(2), "hex") : null; }
function codeSummary(code) { const raw = bytes(code); return raw ? { present: raw.length > 0, bytes: raw.length,
  keccak256: raw.length ? keccak256(code) : null, sha256: raw.length ? sha256(raw) : null } : null; }
function header(block) { return block && block.hash ? { number: BigInt(block.number).toString(), hash: block.hash.toLowerCase(),
  timestamp: BigInt(block.timestamp).toString() } : null; }
function value(row) { return row && row.reason === null ? row.value : null; }
function decimal18(raw) { const amount = BigInt(raw), whole = amount / 10n ** 18n, fraction = (amount % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/u, "");
  return fraction ? `${whole}.${fraction}` : whole.toString(); }

function parseInventory(text) {
  if (Buffer.byteLength(text) > LIMITS.inventoryBytes) throw new Error("inventory size cap exceeded");
  const rows = [], seen = new Set(), lines = text.split(/\r?\n/u);
  for (let i = 0; i < lines.length; i++) for (const match of lines[i].matchAll(/https:\/\/[^\s<'"`\])}]+/giu)) {
    let url; try { url = new URL(match[0].replace(/[>,.;]+$/u, "")); } catch (_) { continue; }
    if (url.protocol !== "https:" || url.username || url.password || url.hash) continue;
    const headers = {}; for (const found of lines[i].matchAll(/\[header:\s*([^=\]\s]+)=([^\]]+)\]/giu)) headers[found[1].trim()] = found[2].trim();
    const key = `${url.href}\0${JSON.stringify(headers)}`; if (seen.has(key)) continue; seen.add(key);
    const context = lines.slice(Math.max(0, i - 3), i + 4).join(" ");
    const ethereumHint = /(?:ethereum|eth-mainnet|chain(?:id)?[^a-z0-9]{0,8}(?:1|0x1))(?!\d)/iu.test(context);
    rows.push({ url, headers, family: url.hostname.toLowerCase(), ethereumHint });
  }
  return rows.sort((a, b) => Number(b.ethereumHint) - Number(a.ethereumHint)).slice(0, LIMITS.candidates)
    .map(({ url, headers, family }) => ({ url, headers, family }));
}
function secretCorpus(rows) {
  const out = new Set(); for (const row of rows) for (const item of [row.url.href, ...row.url.pathname.split("/"),
    ...row.url.searchParams.values(), ...Object.values(row.headers)]) if (String(item).length >= 16) {
    out.add(String(item)); out.add(String(item).toLowerCase());
  } return [...out];
}
function secretGuard(object, corpus) {
  const text = JSON.stringify(object), lower = text.toLowerCase();
  if (/(?:https?|wss?):\/\//iu.test(text)) throw new Error("secret guard: URL in output");
  if (/"(?:endpoint|provider|hostname|domain|headers)"\s*:/iu.test(text)) throw new Error("secret guard: provider key in output");
  for (const item of corpus) if (text.includes(item) || lower.includes(item.toLowerCase())) throw new Error("secret guard: inventory material in output");
}

class Budget {
  constructor() { this.started = Date.now(); this.calls = 0; this.responseBytes = 0; }
  use() { if (++this.calls > LIMITS.calls || Date.now() - this.started > LIMITS.wallMs) throw new Error("bounded RPC budget exceeded"); }
  add(size) { this.responseBytes += size; if (size > LIMITS.responseBytes || this.responseBytes > LIMITS.totalResponseBytes) throw new Error("RPC response budget exceeded"); }
  summary() { return { calls: this.calls, responseBytes: this.responseBytes, elapsedMs: Date.now() - this.started,
    limits: { calls: LIMITS.calls, responseBytes: LIMITS.totalResponseBytes, wallMs: LIMITS.wallMs }, withinLimits: true }; }
}
async function rpc(candidate, method, params, budget) {
  if (!METHODS.has(method)) throw new Error("RPC method not permitted"); budget.use();
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: budget.calls, method, params }));
  return new Promise((resolve) => {
    let done = false, request; const finish = (row) => { if (done) return; done = true; clearTimeout(timer); try { request?.destroy(); } catch (_) {} resolve(row); };
    const timer = setTimeout(() => finish({ ok: false, reason: "TIMEOUT" }), LIMITS.requestMs);
    const options = { protocol: "https:", hostname: candidate.url.hostname, port: candidate.url.port || 443,
      path: `${candidate.url.pathname}${candidate.url.search}`, method: "POST", agent: false,
      headers: { ...candidate.headers, "content-type": "application/json", accept: "application/json", "accept-encoding": "identity", "content-length": body.length } };
    try { request = https.request(options, (response) => { const chunks = []; let size = 0;
      response.on("data", (chunk) => { size += chunk.length; if (size > LIMITS.responseBytes) finish({ ok: false, reason: "RESPONSE_CAP" }); else chunks.push(Buffer.from(chunk)); });
      response.on("end", () => { if (done) return; try { budget.add(size); } catch (error) { return finish({ ok: false, reason: error.message }); }
        if (response.statusCode !== 200) return finish({ ok: false, reason: "HTTP_STATUS" });
        try { const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          finish(parsed.error ? { ok: false, reason: "RPC_ERROR" } : { ok: true, result: parsed.result });
        } catch (_) { finish({ ok: false, reason: "INVALID_JSON" }); } }); });
      request.on("error", () => finish({ ok: false, reason: "TRANSPORT_ERROR" })); request.end(body);
    } catch (_) { finish({ ok: false, reason: "TRANSPORT_ERROR" }); }
  });
}

function compilePartialArtifact() {
  const solc = require(path.join(TARGET, "node_modules", "solc-0.7"));
  const sourceUnits = { "contracts/Hypervisor.sol": { content: fs.readFileSync(SOURCE, "utf8") },
    "contracts/UniProxy.sol": { content: fs.readFileSync(UNIPROXY_SOURCE, "utf8") } };
  const input = { language: "Solidity", sources: sourceUnits, settings: { optimizer: { enabled: true, runs: 800 },
    metadata: { bytecodeHash: "none" }, outputSelection: { "*": { "*": ["abi", "evm.deployedBytecode.object"] } } } };
  const findImport = (name) => { for (const candidate of [path.join(TARGET, name), path.join(TARGET, "node_modules", name)]) {
    try { return { contents: fs.readFileSync(candidate, "utf8") }; } catch (_) {} } return { error: `missing import ${name}` }; };
  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImport }));
  const errors = (output.errors || []).filter((row) => row.severity === "error");
  if (errors.length) throw new Error(`standalone compile failed: ${errors.map((row) => row.formattedMessage).join(" | ")}`);
  const hype = output.contracts["contracts/Hypervisor.sol"].Hypervisor;
  const uni = output.contracts["contracts/UniProxy.sol"].UniProxy;
  return { schema: "gamma-hypervisor-partial-artifact/v1", compiler: solc.version(), settings: input.settings,
    source: { commit: COMMIT, hypervisor: "targets/gamma-hypervisor-b4d90b3/contracts/Hypervisor.sol",
      hypervisorSha256: sha256(fs.readFileSync(SOURCE)), uniProxy: "targets/gamma-hypervisor-b4d90b3/contracts/UniProxy.sol",
      uniProxySha256: sha256(fs.readFileSync(UNIPROXY_SOURCE)) },
    contracts: { Hypervisor: { abi: hype.abi, deployedBytecode: `0x${hype.evm.deployedBytecode.object}` },
      UniProxy: { abi: uni.abi, deployedBytecode: `0x${uni.evm.deployedBytecode.object}` } } };
}
function runtimeCompare(onchain, expected) {
  const left = bytes(onchain), right = bytes(expected); if (!left || !right) return { exact: null, conclusion: "UNRESOLVED" };
  const common = Math.min(left.length, right.length), differences = []; let differingBytes = 0;
  for (let index = 0; index < common; index++) if (left[index] !== right[index]) { differingBytes++; if (differences.length < 32) differences.push(index); }
  differingBytes += Math.abs(left.length - right.length);
  const core = (raw) => { if (raw.length < 2) return raw; const length = raw.readUInt16BE(raw.length - 2) + 2;
    return length <= raw.length ? raw.subarray(0, raw.length - length) : raw; };
  const leftCore = core(left), rightCore = core(right), coreCommon = Math.min(leftCore.length, rightCore.length); let coreDifferingBytes = 0;
  for (let index = 0; index < coreCommon; index++) if (leftCore[index] !== rightCore[index]) coreDifferingBytes++;
  coreDifferingBytes += Math.abs(leftCore.length - rightCore.length);
  return { exact: left.equals(right), metadataNormalized: leftCore.equals(rightCore), differingBytes, firstDifferingByteOffsets: differences,
    coreDifferingBytes, onchainCoreBytes: leftCore.length, expectedCoreBytes: rightCore.length, onchainBytes: left.length, expectedBytes: right.length,
    onchainKeccak256: keccak256(onchain), expectedKeccak256: keccak256(expected), conclusion: left.equals(right) ? "EXACT_RUNTIME_MATCH" : "NO_MATCH" };
}

async function call(candidate, block, target, iface, fragment, args, budget) {
  let data; try { data = iface.encodeFunctionData(fragment, args || []); } catch (_) { return { value: null, reason: "ABI_ENCODE_FAILED" }; }
  const row = await rpc(candidate, "eth_call", [{ to: target, data }, block], budget); if (!row.ok) return { value: null, reason: row.reason };
  try { const decoded = iface.decodeFunctionResult(fragment, row.result); return { value: serial(decoded.length === 1 ? decoded[0] : [...decoded]), reason: null }; }
  catch (_) { return { value: null, reason: "ABI_DECODE_FAILED" }; }
}
async function codeAt(candidate, block, target, budget) { const row = await rpc(candidate, "eth_getCode", [target, block], budget);
  return row.ok ? { raw: row.result, summary: codeSummary(row.result), reason: null } : { raw: null, summary: null, reason: row.reason }; }
async function callMap(candidate, block, target, iface, specs, budget) { const out = {};
  for (const [key, fragment, args = []] of specs) out[key] = await call(candidate, block, target, iface, fragment, args, budget); return out; }

async function qualify(candidates, iface, topics, budget, exactPin = null) {
  const qualified = [], families = new Set(); let tested = 0;
  for (const candidate of candidates) {
    if (families.has(candidate.family) || tested >= LIMITS.qualifyFamilies) continue; families.add(candidate.family); tested++;
    const chain = await rpc(candidate, "eth_chainId", [], budget); if (!chain.ok) continue;
    try { if (BigInt(chain.result) !== CHAIN) continue; } catch (_) { continue; }
    const finalized = await rpc(candidate, "eth_getBlockByNumber", ["finalized", false], budget);
    if (!finalized.ok || !header(finalized.result)) continue;
    const selectedBlock = exactPin ? await rpc(candidate, "eth_getBlockByNumber", [quantity(BigInt(exactPin.number)), false], budget) : finalized;
    const pin = selectedBlock.ok ? header(selectedBlock.result) : null;
    if (exactPin && pin?.hash !== exactPin.hash) continue;
    if (!pin || BigInt(pin.number) <= HISTORICAL_BLOCK) continue;
    const currentBlock = pinArg(pin), historical = quantity(HISTORICAL_BLOCK);
    const code = await rpc(candidate, "eth_getCode", [HYPERVISOR, currentBlock], budget);
    const storage = await rpc(candidate, "eth_getStorageAt", [HYPERVISOR, ZERO32, currentBlock], budget);
    const owner = await call(candidate, currentBlock, HYPERVISOR, iface, "owner", [], budget);
    const historicalCode = await rpc(candidate, "eth_getCode", [HYPERVISOR, historical], budget);
    const historicalCall = await call(candidate, historical, HYPERVISOR, iface, "getTotalAmounts", [], budget);
    const historicalLogs = await rpc(candidate, "eth_getLogs", [{ address: HYPERVISOR, fromBlock: historical,
      toBlock: historical, topics: [topics] }], budget);
    if (code.ok && codeSummary(code.result)?.present && storage.ok && owner.reason === null && historicalCode.ok &&
      codeSummary(historicalCode.result)?.present && historicalCall.reason === null && historicalLogs.ok) qualified.push({ candidate, pin });
  }
  return { rows: qualified, tested, selected: qualified[0] || null };
}

async function creationBlock(candidate, pin, budget) {
  let low = 0n, high = BigInt(pin.number); while (low < high) { const mid = (low + high) >> 1n;
    const row = await codeAt(candidate, quantity(mid), HYPERVISOR, budget); if (row.reason !== null) throw new Error(`creation search failed: ${row.reason}`);
    if (row.summary.present) high = mid; else low = mid + 1n;
  } return low;
}
function rawLog(log) { return { blockNumber: BigInt(log.blockNumber).toString(), transactionHash: log.transactionHash.toLowerCase(),
  transactionIndex: BigInt(log.transactionIndex).toString(), logIndex: BigInt(log.logIndex).toString(), data: log.data.toLowerCase(),
  topics: log.topics.map((item) => item.toLowerCase()) }; }
function decodeLog(log, iface) { try { const parsed = iface.parseLog({ data: log.data, topics: log.topics });
  const args = Object.fromEntries(parsed.fragment.inputs.map((input, index) => [input.name || String(index), serial(parsed.args[index])]));
  return { ...log, event: parsed.name, args }; } catch (_) { return { ...log, event: "UNDECODED", args: null }; } }
function saveCheckpoint(checkpoint, secrets) { secretGuard(checkpoint, secrets); fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(CHECKPOINT, `${JSON.stringify(checkpoint, null, 2)}\n`); }
async function scanHistory(candidate, pin, from, iface, topics, budget, secrets) {
  let checkpoint = { schema: "gamma-hypervisor-deployment-activity-gate-checkpoint/v1", chainId: "1", pin,
    target: HYPERVISOR, fromBlock: from.toString(), nextBlock: from.toString(), complete: false, events: [], failures: [] };
  try { const prior = JSON.parse(fs.readFileSync(CHECKPOINT, "utf8"));
    if (prior.schema === checkpoint.schema && prior.pin?.hash === pin.hash && prior.target === HYPERVISOR) {
      checkpoint = prior; checkpoint.events = checkpoint.events.map((row) => decodeLog(row, iface));
      if (checkpoint.complete) return checkpoint;
    }
  } catch (_) {}
  const end = BigInt(pin.number); let start = BigInt(checkpoint.nextBlock), chunk = LIMITS.logChunk;
  while (start <= end) {
    const stop = start + chunk - 1n > end ? end : start + chunk - 1n;
    const row = await rpc(candidate, "eth_getLogs", [{ address: HYPERVISOR, fromBlock: quantity(start), toBlock: quantity(stop), topics: [topics] }], budget);
    if (!row.ok) { if (chunk > LIMITS.minimumLogChunk) { chunk = chunk / 2n < LIMITS.minimumLogChunk ? LIMITS.minimumLogChunk : chunk / 2n; continue; }
      checkpoint.failures.push({ fromBlock: start.toString(), toBlock: stop.toString(), reason: row.reason }); saveCheckpoint(checkpoint, secrets);
      throw new Error(`complete event scan blocked at ${start}: ${row.reason}`); }
    for (const log of row.result || []) { if (checkpoint.events.length >= LIMITS.eventRows) throw new Error("event row cap exceeded");
      checkpoint.events.push(decodeLog(rawLog(log), iface)); }
    start = stop + 1n; checkpoint.nextBlock = start.toString(); if (checkpoint.events.length % 64 === 0 || start > end) saveCheckpoint(checkpoint, secrets);
  }
  checkpoint.complete = true; checkpoint.completedAt = new Date().toISOString(); saveCheckpoint(checkpoint, secrets); return checkpoint;
}

function eventSummary(events) {
  const counts = {}, first = {}, last = {}; for (const row of events) { counts[row.event] = (counts[row.event] || 0) + 1;
    if (!first[row.event]) first[row.event] = row; last[row.event] = row; }
  const operationNames = new Set(["Deposit", "Withdraw", "Rebalance", "ZeroBurn", "SetFee"]);
  const activity = events.filter((row) => operationNames.has(row.event));
  return { counts, first: Object.fromEntries(Object.entries(first).map(([key, row]) => [key, { blockNumber: row.blockNumber,
    transactionHash: row.transactionHash, logIndex: row.logIndex }])), last: Object.fromEntries(Object.entries(last).map(([key, row]) => [key,
    { blockNumber: row.blockNumber, transactionHash: row.transactionHash, logIndex: row.logIndex }])),
    lastOperation: activity.length ? { event: activity[activity.length - 1].event, blockNumber: activity[activity.length - 1].blockNumber,
      transactionHash: activity[activity.length - 1].transactionHash } : null };
}
function deriveHolders(events) {
  const balances = new Map(); for (const row of events) if (row.event === "Transfer" && row.args) {
    const from = addr(row.args.from), to = addr(row.args.to), amount = BigInt(row.args.value);
    if (from && from !== ZERO) balances.set(from, (balances.get(from) || 0n) - amount);
    if (to && to !== ZERO) balances.set(to, (balances.get(to) || 0n) + amount);
  }
  return [...balances.entries()].filter(([, amount]) => amount !== 0n).map(([address, amount]) => ({ address, derivedBalance: amount.toString() }))
    .sort((a, b) => a.address.localeCompare(b.address));
}

const erc20 = new Interface(["function name() view returns(string)", "function symbol() view returns(string)", "function decimals() view returns(uint8)",
  "function balanceOf(address) view returns(uint256)", "function totalSupply() view returns(uint256)"]);
const poolAbi = new Interface(["function token0() view returns(address)", "function token1() view returns(address)", "function fee() view returns(uint24)",
  "function tickSpacing() view returns(int24)", "function liquidity() view returns(uint128)",
  "function slot0() view returns(uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function positions(bytes32) view returns(uint128 liquidity,uint256 feeGrowthInside0LastX128,uint256 feeGrowthInside1LastX128,uint128 tokensOwed0,uint128 tokensOwed1)"]);
const ingressAbi = new Interface(["function owner() view returns(address)", "function clearance() view returns(address)", "function paused() view returns(bool)"]);

async function stateAt(candidate, block, hypervisorAbi, budget) {
  const hype = await callMap(candidate, block, HYPERVISOR, hypervisorAbi, [["owner", "owner"], ["whitelistedAddress", "whitelistedAddress"],
    ["directDeposit", "directDeposit"], ["fee", "fee"], ["feeRecipient", "feeRecipient"], ["maxTotalSupply", "maxTotalSupply"],
    ["deposit0Max", "deposit0Max"], ["deposit1Max", "deposit1Max"], ["totalSupply", "totalSupply"], ["getTotalAmounts", "getTotalAmounts"],
    ["getBasePosition", "getBasePosition"], ["getLimitPosition", "getLimitPosition"], ["pool", "pool"], ["token0", "token0"], ["token1", "token1"],
    ["tickSpacing", "tickSpacing"], ["baseLower", "baseLower"], ["baseUpper", "baseUpper"], ["limitLower", "limitLower"], ["limitUpper", "limitUpper"]], budget);
  const token0 = addr(value(hype.token0)), token1 = addr(value(hype.token1));
  const token0State = token0 ? await callMap(candidate, block, token0, erc20, [["name", "name"], ["symbol", "symbol"], ["decimals", "decimals"],
    ["hypervisorBalance", "balanceOf", [HYPERVISOR]], ["poolBalance", "balanceOf", [POOL]]], budget) : null;
  const token1State = token1 ? await callMap(candidate, block, token1, erc20, [["name", "name"], ["symbol", "symbol"], ["decimals", "decimals"],
    ["hypervisorBalance", "balanceOf", [HYPERVISOR]], ["poolBalance", "balanceOf", [POOL]]], budget) : null;
  const pool = await callMap(candidate, block, POOL, poolAbi, [["token0", "token0"], ["token1", "token1"], ["fee", "fee"],
    ["tickSpacing", "tickSpacing"], ["liquidity", "liquidity"], ["slot0", "slot0"]], budget);
  const baseKey = solidityPackedKeccak256(["address", "int24", "int24"], [HYPERVISOR, BigInt(value(hype.baseLower) || 0), BigInt(value(hype.baseUpper) || 0)]);
  const limitKey = solidityPackedKeccak256(["address", "int24", "int24"], [HYPERVISOR, BigInt(value(hype.limitLower) || 0), BigInt(value(hype.limitUpper) || 0)]);
  pool.basePositionKey = baseKey; pool.limitPositionKey = limitKey;
  pool.basePosition = await call(candidate, block, POOL, poolAbi, "positions", [baseKey], budget);
  pool.limitPosition = await call(candidate, block, POOL, poolAbi, "positions", [limitKey], budget);
  return { hypervisor: hype, tokens: { [token0 || "unresolved0"]: token0State, [token1 || "unresolved1"]: token1State }, pool };
}

async function ingressState(candidate, pin, whitelist, partial, budget) {
  if (!whitelist || whitelist === ZERO) return { address: whitelist, code: null, exactUniProxyRuntime: false, abiCompatibleUniProxy: false,
    owner: null, clearance: null, clearanceCode: null, clearancePaused: null, currentPublicIngress: false, reason: "ZERO_WHITELIST" };
  const block = pinArg(pin), code = await codeAt(candidate, block, whitelist, budget), comparison = runtimeCompare(code.raw, partial.contracts.UniProxy.deployedBytecode);
  const selectors = ["deposit(uint256,uint256,address,address,uint256[4])", "clearance()", "getDepositAmount(address,address,uint256)"].map((sig) => id(sig).slice(2, 10));
  const abiCompatible = Boolean(code.raw && selectors.every((selector) => code.raw.toLowerCase().includes(selector)));
  const owner = await call(candidate, block, whitelist, ingressAbi, "owner", [], budget);
  const clearance = await call(candidate, block, whitelist, ingressAbi, "clearance", [], budget); const clearanceAddress = addr(value(clearance));
  const clearanceCode = clearanceAddress ? await codeAt(candidate, block, clearanceAddress, budget) : null;
  const clearancePaused = clearanceAddress ? await call(candidate, block, clearanceAddress, ingressAbi, "paused", [], budget) : null;
  return { address: whitelist, code: { summary: code.summary, reason: code.reason }, exactUniProxyRuntime: comparison.exact === true,
    runtimeComparison: comparison, abiCompatibleUniProxy: abiCompatible, owner, clearance, clearanceCode: clearanceCode ? { summary: clearanceCode.summary,
      reason: clearanceCode.reason } : null, clearancePaused, currentPublicIngress: Boolean(code.summary?.present && abiCompatible && clearanceAddress && clearanceCode?.summary?.present && value(clearancePaused) === false),
    rationale: "No mutative call or access simulation was made; ingress is classified from exact selectors and read-only configuration." };
}

async function apiLookup() {
  return new Promise((resolve) => { let done = false, request; const finish = (row) => { if (done) return; done = true; clearTimeout(timer); try { request?.destroy(); } catch (_) {} resolve(row); };
    const timer = setTimeout(() => finish({ status: "UNAVAILABLE", reason: "TIMEOUT" }), 15000);
    try { request = https.get(API_URL, { headers: { accept: "application/json", "accept-encoding": "identity", "user-agent": "defensive-readonly-audit" }, agent: false }, (response) => {
      const chunks = []; let size = 0; response.on("data", (chunk) => { size += chunk.length; if (size > LIMITS.apiBytes) finish({ status: "UNAVAILABLE", reason: "RESPONSE_CAP" }); else chunks.push(Buffer.from(chunk)); });
      response.on("end", () => { if (done) return; if (response.statusCode !== 200) return finish({ status: "UNAVAILABLE", reason: "HTTP_STATUS" });
        try { const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); const seen = new Set(); let found = null;
          function walk(node) { if (found || !node || typeof node !== "object" || seen.has(node)) return; seen.add(node);
            if (!Array.isArray(node)) { for (const [key, child] of Object.entries(node)) {
              if (key.toLowerCase() === HYPERVISOR || (typeof child === "object" && addr(child?.address || child?.id || child?.hypervisor) === HYPERVISOR)) { found = child; return; }
            } } for (const child of Object.values(node)) walk(child); }
          walk(parsed); if (!found || typeof found !== "object") return finish({ status: "NOT_FOUND", reason: null });
          const allow = /^(address|id|symbol|name|tvl|tvlusd|tvl0|tvl1|totalamount0|totalamount1|token0price|token1price|token0priceusd|token1priceusd|pool|fee)$/iu;
          finish({ status: "FOUND", reason: null, nominal: Object.fromEntries(Object.entries(found).filter(([key, val]) => allow.test(key) &&
            ["string", "number", "boolean"].includes(typeof val)).map(([key, val]) => [key, val])) });
        } catch (_) { finish({ status: "UNAVAILABLE", reason: "INVALID_JSON" }); } }); });
      request.on("error", () => finish({ status: "UNAVAILABLE", reason: "TRANSPORT_ERROR" }));
    } catch (_) { finish({ status: "UNAVAILABLE", reason: "TRANSPORT_ERROR" }); }
  });
}

async function main() {
  const partial = compilePartialArtifact(), hypervisorAbi = new Interface(partial.contracts.Hypervisor.abi);
  const eventNames = ["Deposit", "Withdraw", "Rebalance", "ZeroBurn", "SetFee", "Transfer"];
  const topics = eventNames.map((name) => hypervisorAbi.getEvent(name).topicHash);
  const inventoryText = fs.readFileSync(INVENTORY, "utf8"), candidates = parseInventory(inventoryText), secrets = secretCorpus(candidates), budget = new Budget();
  let resumePin = null; try { const prior = JSON.parse(fs.readFileSync(CHECKPOINT, "utf8"));
    if (prior.schema === "gamma-hypervisor-deployment-activity-gate-checkpoint/v1" && prior.target === HYPERVISOR) resumePin = prior.pin;
  } catch (_) {}
  const qualification = await qualify(candidates, hypervisorAbi, topics, budget, resumePin);
  if (!qualification.selected) throw new Error("no chain-1 finalized code/storage/log/archive family qualified");
  const { candidate, pin } = qualification.selected, block = pinArg(pin);
  const creation = await creationBlock(candidate, pin, budget), checkpoint = await scanHistory(candidate, pin, creation, hypervisorAbi, topics, budget, secrets);
  const current = await stateAt(candidate, block, hypervisorAbi, budget);
  const historicalHeaderRow = await rpc(candidate, "eth_getBlockByNumber", [quantity(HISTORICAL_BLOCK), false], budget);
  const historicalHeader = historicalHeaderRow.ok ? header(historicalHeaderRow.result) : null;
  const historical = historicalHeader ? await stateAt(candidate, quantity(HISTORICAL_BLOCK), hypervisorAbi, budget) : null;
  const runtime = await codeAt(candidate, block, HYPERVISOR, budget), sourceBinding = runtimeCompare(runtime.raw, partial.contracts.Hypervisor.deployedBytecode);
  const slot0 = await rpc(candidate, "eth_getStorageAt", [HYPERVISOR, ZERO32, block], budget);
  const holders = deriveHolders(checkpoint.events);
  for (const holder of holders) holder.currentBalance = value(await call(candidate, block, HYPERVISOR, hypervisorAbi, "balanceOf", [holder.address], budget));
  const eventStats = eventSummary(checkpoint.events), whitelist = addr(value(current.hypervisor.whitelistedAddress));
  const ingress = await ingressState(candidate, pin, whitelist, partial, budget), api = await apiLookup();
  const totals = value(current.hypervisor.getTotalAmounts), supplyValue = value(current.hypervisor.totalSupply);
  const amount0 = totals ? BigInt(totals[0]) : null, amount1 = totals ? BigInt(totals[1]) : null, supply = supplyValue === null ? null : BigInt(supplyValue);
  const assetsNonzero = amount0 === null || amount1 === null ? null : amount0 > 0n || amount1 > 0n;
  const capacity = assetsNonzero === null || supply === null ? null : assetsNonzero && supply > 0n;
  const deployment = runtime.summary?.present === true && addr(value(current.hypervisor.pool)) === POOL &&
    new Set([addr(value(current.hypervisor.token0)), addr(value(current.hypervisor.token1))]).size === 2 &&
    new Set([addr(value(current.hypervisor.token0)), addr(value(current.hypervisor.token1))]).has(LQTY) &&
    new Set([addr(value(current.hypervisor.token0)), addr(value(current.hypervisor.token1))]).has(WETH);
  const inactivity = eventStats.lastOperation ? BigInt(pin.number) - BigInt(eventStats.lastOperation.blockNumber) : null;
  const reproduciblyEmpty = capacity === false && assetsNonzero === false && supply === 0n && holders.every((row) => row.currentBalance === "0");
  const routePositive = reproduciblyEmpty ? false : null;
  const immediateWithdrawal = assetsNonzero === false ? { assessed: true, capacity: false, reason: "NO_ASSETS_OR_SHARES" } :
    assetsNonzero === true ? { assessed: true, capacity: supply > 0n, totalSupply: supply.toString(), holdersWithNonzeroBalance: holders.filter((row) => BigInt(row.currentBalance || 0) > 0n).length,
      tokenExitLiquidity: { assessed: true, poolLiquidity: value(current.pool.liquidity), token0PoolBalance: value(current.tokens[addr(value(current.hypervisor.token0))]?.poolBalance),
        token1PoolBalance: value(current.tokens[addr(value(current.hypervisor.token1))]?.poolBalance), limitation: "Read-only pool balances/liquidity only; no quote or swap was invoked." } } :
      { assessed: false, capacity: null, reason: "ASSET_STATE_UNRESOLVED" };
  let corroboration = { triggered: capacity === true, available: false, samePin: false, currentStateMatch: null, historicalStateMatch: null };
  if (capacity === true && qualification.rows.length > 1) {
    const second = qualification.rows[1], secondBlock = pinArg(second.pin), secondCode = await codeAt(second.candidate, secondBlock, HYPERVISOR, budget);
    const secondCurrent = await callMap(second.candidate, secondBlock, HYPERVISOR, hypervisorAbi, [["owner", "owner"],
      ["whitelistedAddress", "whitelistedAddress"], ["totalSupply", "totalSupply"], ["getTotalAmounts", "getTotalAmounts"], ["pool", "pool"]], budget);
    const secondHistorical = await callMap(second.candidate, quantity(HISTORICAL_BLOCK), HYPERVISOR, hypervisorAbi,
      [["totalSupply", "totalSupply"], ["getTotalAmounts", "getTotalAmounts"]], budget);
    const firstCompact = { owner: current.hypervisor.owner, whitelistedAddress: current.hypervisor.whitelistedAddress,
      totalSupply: current.hypervisor.totalSupply, getTotalAmounts: current.hypervisor.getTotalAmounts, pool: current.hypervisor.pool };
    const firstHistorical = historical ? { totalSupply: historical.hypervisor.totalSupply, getTotalAmounts: historical.hypervisor.getTotalAmounts } : null;
    corroboration = { triggered: true, available: true, samePin: second.pin.hash === pin.hash,
      runtimeHashMatch: secondCode.summary?.keccak256 === runtime.summary?.keccak256,
      currentStateMatch: JSON.stringify(secondCurrent) === JSON.stringify(firstCompact),
      historicalStateMatch: firstHistorical ? JSON.stringify(secondHistorical) === JSON.stringify(firstHistorical) : null };
  }
  const terminal = await rpc(candidate, "eth_getBlockByNumber", [quantity(BigInt(pin.number)), false], budget);
  const terminalMatch = terminal.ok && terminal.result?.hash?.toLowerCase() === pin.hash;
  const classification = reproduciblyEmpty ? "ROUTE_NEGATIVE_REPRODUCIBLY_EMPTY" :
    sourceBinding.exact !== true ? "WATCH_SOURCE_BINDING_FAILED" : "WATCH_EVIDENCE_OR_CAPACITY_REMAINS";
  const apiNominal = api.status === "FOUND" ? api.nominal : null;
  const apiAssetComparison = amount0 !== null && amount1 !== null && apiNominal ? {
    onchainToken0: decimal18(amount0), apiToken0: apiNominal.tvl0 ?? null,
    token0ApiMinusOnchain: apiNominal.tvl0 === undefined ? null : Number(apiNominal.tvl0) - Number(decimal18(amount0)),
    onchainToken1: decimal18(amount1), apiToken1: apiNominal.tvl1 ?? null,
    token1ApiMinusOnchain: apiNominal.tvl1 === undefined ? null : Number(apiNominal.tvl1) - Number(decimal18(amount1)),
    apiTvlUsd: apiNominal.tvlUSD ?? apiNominal.tvlUsd ?? null,
    usdIndependentRecalculation: null,
    limitation: "No independently sourced finalized token/USD prices were introduced; API USD TVL is not promoted to on-chain fact."
  } : null;

  const capture = { schema: "gamma-hypervisor-deployment-activity-gate/v1", capturedAt: new Date().toISOString(), chainId: "1", pin,
    rpcPolicy: { inventory: "rpc_endpoints.txt", processOnly: true, candidateFamiliesTested: qualification.tested,
      capableFamilies: qualification.rows.length, selectedFamilies: corroboration.available ? 2 : 1, secondIndependentFamilyUsed: corroboration.available,
      secondFamilyPolicy: "only-if-material-candidate", permittedMethods: [...METHODS], terminalPinMatch: terminalMatch },
    source: { repository: "GammaStrategies/hypervisor", commit: COMMIT, partialArtifact: "partial-artifact.json",
      hypervisorSource: partial.source.hypervisor, hypervisorSourceSha256: partial.source.hypervisorSha256, compiler: partial.compiler,
      compileScope: "Hypervisor.sol and UniProxy.sol import closures only; broken proxy/admin.sol excluded; no target edit" },
    officialApiSeed: { address: HYPERVISOR, pool: POOL, pair: "LQTY/WETH", liveLookup: api,
      trustBoundary: "API values are nominal discovery metadata only; gate values use pinned on-chain calls and balances." },
    deployment: { address: HYPERVISOR, expectedPool: POOL, creationBlock: creation.toString(), runtime: runtime.summary,
      storageSlot0: slot0.ok ? slot0.result : null, sourceBinding },
    independentCorroboration: corroboration,
    history: { completeEventScan: checkpoint.complete, fromBlock: checkpoint.fromBlock, toBlock: pin.number,
      configHistoryComplete: false, configHistoryLimitation: "SetFee is complete by logs. owner, whitelist, directDeposit and feeRecipient setters emit no events in exact source, so complete mutation history is not recoverable from permitted standard logs.",
      summary: eventStats, events: checkpoint.events },
    current: { state: current, holders, blocksSinceLastOperation: inactivity?.toString() || null, ingress, immediateWithdrawal },
    historicalLastOperation: { requestedBlock: HISTORICAL_BLOCK.toString(), header: historicalHeader, archiveStateAvailable: historical !== null, state: historical,
      matchesCompleteLogLastOperationBlock: eventStats.lastOperation?.blockNumber === HISTORICAL_BLOCK.toString() },
    comparison: { onchainAssets: totals, onchainTotalSupply: supplyValue, apiNominal, apiAssetComparison,
      conclusion: assetsNonzero === false ? "PINNED_ONCHAIN_EMPTY_API_IS_NONAUTHORITATIVE" : "PINNED_ONCHAIN_ASSETS_RECORDED_API_NOMINAL_ONLY" },
    gates: { deployment, source: sourceBinding.exact === true, access: ingress.currentPublicIngress,
      capacity, activity: inactivity === null ? null : inactivity <= 250000n, completeEventHistory: checkpoint.complete,
      completeConfigHistory: false, historicalArchive: historical !== null, routePositive, executableNow: false,
      signedActionJustified: false },
    classification,
    limitations: ["Read-only finalized/deployment activity gate; no state-changing call, fork, signing, broadcast, deployment, or exploit invocation.",
      "Eventless configuration mutation history cannot be made complete with the permitted standard RPC surface.",
      corroboration.available ? "A second independent RPC family corroborated the material nonzero candidate at the same pin." :
        "A second independent RPC family was attempted only after the material gate and was unavailable."], budget: budget.summary() };
  secretGuard(capture, secrets); secretGuard(partial, secrets); fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(ARTIFACT, `${JSON.stringify(partial, null, 2)}\n`); fs.writeFileSync(CAPTURE, `${JSON.stringify(capture, null, 2)}\n`);
  const files = ["capture.json", "checkpoint.json", "partial-artifact.json"].map((name) => { const file = path.join(OUT, name);
    return { name, bytes: fs.statSync(file).size, sha256: sha256(fs.readFileSync(file)) }; });
  const manifest = { schema: "gamma-hypervisor-deployment-activity-gate-manifest/v1", pin, files, gates: capture.gates,
    classification: capture.classification, jsonValidated: true, secretGuardPassed: true, terminalPinMatch: terminalMatch };
  secretGuard(manifest, secrets); fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  for (const file of [CAPTURE, CHECKPOINT, ARTIFACT, MANIFEST]) JSON.parse(fs.readFileSync(file, "utf8"));
  process.stdout.write(`capture complete: deployment=${deployment} source=${sourceBinding.exact === true} access=${ingress.currentPublicIngress} capacity=${capacity} routePositive=${routePositive}\n`);
}

main().catch((error) => { process.stderr.write(`gamma gate failed: ${String(error.message || error).replace(/https?:\/\/\S+/giu, "[redacted]")}\n`); process.exitCode = 1; });
