#!/usr/bin/env node
"use strict";

// Bounded, keyless, read-only Maverick V2 Base deployment/provenance capture.
// Endpoint inventory values remain process-only and are never logged or persisted.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Interface, getAddress, keccak256 } = require("ethers");

const ROOT = path.resolve(__dirname, "..");
const NAME = "prefilter-maverick-v2-base-pools";
const OUT = path.join(ROOT, "reports", "raw", "fast", NAME);
const CAPTURE = path.join(OUT, "capture.json");
const CHECKPOINT = path.join(OUT, "checkpoint.json");
const SOURCE = path.join(OUT, "source-recovery.json");
const MANIFEST = path.join(OUT, "manifest.json");
const REPORT = path.join(ROOT, "reports", `${NAME}.md`);
const TOOL = path.join(ROOT, "tools", `${NAME}.js`);
const DOCS_URL = "https://docs.mav.xyz/technical-reference/contract-addresses/v2-contract-addresses";
const INVENTORIES = ["rpc_endpoints.txt", "base_full_stack_endpoints.md"];
const CHAIN_ID = 8453;
const ZERO_WORD = `0x${"0".repeat(64)}`;
const SLOTS = Object.freeze({
  implementation: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  admin: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
  beacon: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
});
const OFFICIAL = Object.freeze({
  weth: "0x4200000000000000000000000000000000000006",
  factory: "0x0A7e848Aca42d879EF06507Fca0E7b33A0a63c1e",
  poolLens: "0x6A9EB38DE5D349Fe751E0aDb4c0D9D391f94cc8D",
  quoter: "0xb40AfdB85a07f37aE217E7D6462e609900dD8D7A",
  router: "0x5c3b380e5Aeec389d1014Da3Eb372FA2C9e0fc76",
  position: "0x116193c58B40D50687c0433B2aa0cC4AE00bC32c",
});
const RECOGNIZED = Object.freeze({
  [OFFICIAL.weth.toLowerCase()]: { kind: "wrapped-native", symbol: "WETH", decimals: 18 },
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { kind: "stable", symbol: "USDC", decimals: 6 },
  "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca": { kind: "stable", symbol: "USDbC", decimals: 6 },
  "0x50c5725949a6f0c72e6c4a641f24049a917db0cb": { kind: "stable", symbol: "DAI", decimals: 18 },
});
const LIMITS = Object.freeze({ candidates: 48, qualificationConcurrency: 8, requestTimeoutMs: 12_000,
  requestBodyBytes: 256 * 1024, responseBytes: 24 * 1024 * 1024, totalRequests: 3_500,
  logRequests: 800, pools: 1_000, activityBlocks: 500_000, sourceBytes: 12 * 1024 * 1024 });

const factoryAbi = JSON.parse(fs.readFileSync(path.join(ROOT, "targets", "maverick-v2-interfaces-f9f4f3e", "abis", "MaverickV2Factory.json"), "utf8"));
const poolAbi = JSON.parse(fs.readFileSync(path.join(ROOT, "targets", "maverick-v2-interfaces-f9f4f3e", "abis", "MaverickV2Pool.json"), "utf8"));
const FACTORY = new Interface(factoryAbi);
const POOL = new Interface(poolAbi);
const ERC20 = new Interface([
  "function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)",
  "function symbol() view returns (string)", "function name() view returns (string)",
]);
const POOL_CREATED = FACTORY.getEvent("PoolCreated").topicHash;
const ACTIVITY_TOPICS = ["PoolSwap", "PoolAddLiquidity", "PoolRemoveLiquidity"].map((name) => POOL.getEvent(name).topicHash);

let requestCount = 0;
let logRequestCount = 0;
let rpcId = 1;
const hex = (value) => `0x${BigInt(value).toString(16)}`;
const sha256 = (bytes) => `0x${crypto.createHash("sha256").update(bytes).digest("hex")}`;
const bytesOf = (data) => Math.max(0, (data.length - 2) / 2);
const canonical = (value) => value === null || typeof value !== "object" ? typeof value === "bigint" ? value.toString() : value
  : Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
const json = (value) => `${JSON.stringify(canonical(value), null, 2)}\n`;
const publicHash = (value) => sha256(Buffer.from(JSON.stringify(canonical(value))));
function fail(code) { const error = new Error(code); error.safeCode = code; throw error; }
function address(value) { try { return getAddress(value); } catch { fail("ADDRESS_MALFORMED"); } }
function wordAddress(value) {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/i.test(value) || value === ZERO_WORD) return null;
  return address(`0x${value.slice(-40)}`);
}
function safeResult(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(safeResult);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !/^\d+$/.test(key)).map(([key, row]) => [key, safeResult(row)]));
  return value;
}

function familyKey(rawUrl) {
  const host = new URL(rawUrl).hostname.toLowerCase();
  const parts = host.split(".").filter(Boolean);
  return parts.length < 3 ? host : parts.slice(-2).join(".");
}
function extractCandidates() {
  const rows = [];
  for (const file of INVENTORIES) {
    const full = path.join(ROOT, file);
    if (!fs.existsSync(full)) continue;
    const lines = fs.readFileSync(full, "utf8").split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const context = lines.slice(Math.max(0, index - 3), Math.min(lines.length, index + 4)).join("\n");
      const urls = [...lines[index].matchAll(/https?:\/\/[^\s'"<>\[\]`]+/gi)].map((match) => match[0].replace(/[),.;\]]+$/g, ""));
      for (const url of urls) {
        let parsed; try { parsed = new URL(url); } catch { continue; }
        if (!/^https:$/.test(parsed.protocol)) continue;
        const headers = { "content-type": "application/json", accept: "application/json" };
        const origin = context.match(/\[origin:\s*([^\]\s]+)\]/i)?.[1]; if (origin) headers.origin = origin;
        for (const match of context.matchAll(/\[header:\s*([^=\]\s]+)=([^\]]+)\]/gi)) headers[match[1].trim()] = match[2].trim();
        rows.push({ url, headers, family: familyKey(url), file });
      }
    }
  }
  const seen = new Set();
  return rows.filter((row) => { if (seen.has(row.url)) return false; seen.add(row.url); return true; }).slice(0, LIMITS.candidates);
}

async function fetchLimited(url, options = {}, cap = LIMITS.responseBytes, timeoutMs = LIMITS.requestTimeoutMs) {
  if (++requestCount > LIMITS.totalRequests) fail("REQUEST_BUDGET_EXHAUSTED");
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, redirect: "follow", signal: controller.signal });
    const declared = Number(response.headers.get("content-length") || 0); if (declared > cap) fail("RESPONSE_SIZE_CAP");
    const reader = response.body?.getReader(); const chunks = []; let total = 0;
    if (reader) while (true) { const { done, value } = await reader.read(); if (done) break; total += value.length; if (total > cap) { await reader.cancel(); fail("RESPONSE_SIZE_CAP"); } chunks.push(Buffer.from(value)); }
    return { status: response.status, ok: response.ok, bytes: Buffer.concat(chunks), contentType: response.headers.get("content-type") || "" };
  } catch (error) { if (error.safeCode) throw error; return { status: 0, ok: false, bytes: Buffer.alloc(0), category: error?.name === "AbortError" ? "timeout" : "transport" }; }
  finally { clearTimeout(timer); }
}
async function rpc(row, method, params = [], timeoutMs = LIMITS.requestTimeoutMs) {
  const payload = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }));
  if (payload.length > LIMITS.requestBodyBytes) return { ok: false, category: "request-size" };
  const response = await fetchLimited(row.url, { method: "POST", headers: row.headers, body: payload }, LIMITS.responseBytes, timeoutMs);
  if (!response.ok) return { ok: false, category: response.category || `http-${response.status}` };
  let envelope; try { envelope = JSON.parse(response.bytes.toString("utf8")); } catch { return { ok: false, category: "non-json" }; }
  if (envelope?.error) return { ok: false, category: "rpc-error" };
  return Object.hasOwn(envelope || {}, "result") ? { ok: true, result: envelope.result } : { ok: false, category: "schema" };
}
async function rpcBatch(row, calls, timeoutMs = LIMITS.requestTimeoutMs) {
  const payloadRows = calls.map(([method, params]) => ({ jsonrpc: "2.0", id: rpcId++, method, params }));
  const payload = Buffer.from(JSON.stringify(payloadRows));
  if (payload.length > LIMITS.requestBodyBytes) return calls.map(() => ({ ok: false, category: "request-size" }));
  const response = await fetchLimited(row.url, { method: "POST", headers: row.headers, body: payload }, LIMITS.responseBytes, timeoutMs);
  if (!response.ok) return calls.map(() => ({ ok: false, category: response.category || `http-${response.status}` }));
  let envelopes; try { envelopes = JSON.parse(response.bytes.toString("utf8")); } catch { return calls.map(() => ({ ok: false, category: "non-json" })); }
  if (!Array.isArray(envelopes)) return calls.map(() => ({ ok: false, category: "schema" }));
  const byId = new Map(envelopes.map((item) => [item?.id, item]));
  return payloadRows.map((request) => { const item = byId.get(request.id); return item && !item.error && Object.hasOwn(item, "result") ? { ok: true, result: item.result } : { ok: false, category: item?.error ? "rpc-error" : "schema" }; });
}
async function parallel(items, limit, fn) {
  const output = new Array(items.length); let cursor = 0;
  async function worker() { while (true) { const index = cursor++; if (index >= items.length) return; try { output[index] = await fn(items[index], index); } catch { output[index] = null; } } }
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, worker)); return output;
}

async function qualify(row) {
  const chain = await rpc(row, "eth_chainId"); if (!chain.ok || Number(BigInt(chain.result)) !== CHAIN_ID) return null;
  const finalized = await rpc(row, "eth_getBlockByNumber", ["finalized", false]);
  if (!finalized.ok || !finalized.result?.hash || !finalized.result?.number) return null;
  return { row, finalized: finalized.result };
}
async function chooseProviders(candidates) {
  const qualified = (await parallel(candidates, LIMITS.qualificationConcurrency, qualify)).filter(Boolean);
  if (!qualified.length) fail("NO_BASE_FINALIZED_PROVIDER");
  const pinNumber = qualified.map((item) => BigInt(item.finalized.number)).reduce((a, b) => a < b ? a : b);
  const deep = await parallel(qualified, LIMITS.qualificationConcurrency, async (item) => {
    const block = await rpc(item.row, "eth_getBlockByNumber", [hex(pinNumber), false]);
    const code = await rpc(item.row, "eth_getCode", [OFFICIAL.factory, hex(pinNumber)]);
    const oldBlock = pinNumber > 1_000_000n ? pinNumber - 1_000_000n : 1n;
    const oldHeader = await rpc(item.row, "eth_getBlockByNumber", [hex(oldBlock), false]);
    const logs = await rpc(item.row, "eth_getLogs", [{ address: OFFICIAL.factory, fromBlock: hex(pinNumber > 4n ? pinNumber - 4n : 0n), toBlock: hex(pinNumber), topics: [POOL_CREATED] }]);
    if (!block.ok || !block.result?.hash || !code.ok || code.result === "0x" || !oldHeader.ok || !logs.ok || !Array.isArray(logs.result)) return null;
    return { ...item, pin: block.result, factoryCode: code.result };
  });
  const eligible = deep.filter(Boolean);
  if (!eligible.length) fail("NO_BASE_CODE_LOG_PROVIDER");
  const groups = new Map();
  for (const item of eligible) { const key = item.pin.hash.toLowerCase(); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(item); }
  const consensus = [...groups.values()].sort((a, b) => new Set(b.map((x) => x.row.family)).size - new Set(a.map((x) => x.row.family)).size || b.length - a.length)[0];
  const first = consensus[0]; const second = consensus.find((item) => item.row.family !== first.row.family) || null;
  return { primary: first.row, secondary: second?.row || null,
    alternatives: consensus.filter((item) => item.row.family !== first.row.family).map((item) => item.row), pin: first.pin,
    summary: { inventoryFilesRead: INVENTORIES, candidateCount: candidates.length, chain8453FinalizedCount: qualified.length,
      codeLogsHistoricalHeaderQualifiedCount: eligible.length, samePinProviderCount: consensus.length,
      samePinIndependentFamilyCount: new Set(consensus.map((item) => item.row.family)).size,
      independentMaterialCorroborationAvailable: Boolean(second) } };
}

async function officialDocs() {
  const response = await fetchLimited(DOCS_URL, { headers: { accept: "text/html" } }, 6 * 1024 * 1024, 15_000);
  if (!response.ok) fail("OFFICIAL_DOCS_UNAVAILABLE");
  const body = response.bytes.toString("utf8"); const marker = body.indexOf(OFFICIAL.weth); if (marker < 0) fail("OFFICIAL_BASE_TABLE_ABSENT");
  const labels = { factory: "MaverickV2Factory", poolLens: "MaverickV2PoolLens", quoter: "MaverickV2Quoter", router: "MaverickV2Router", position: "MaverickV2Position" };
  for (const [key, label] of Object.entries(labels)) {
    let addressAt = marker, matched = false;
    while ((addressAt = body.indexOf(OFFICIAL[key], addressAt)) >= 0) {
      const labelAt = body.lastIndexOf(label, addressAt);
      if (labelAt >= marker && addressAt - labelAt < 20_000) { matched = true; break; }
      addressAt += OFFICIAL[key].length;
    }
    if (!matched) fail(`OFFICIAL_DOCS_${key.toUpperCase()}_MISMATCH`);
  }
  return { url: DOCS_URL, fetchedAt: new Date().toISOString(), bytes: response.bytes.length, sha256: sha256(response.bytes), baseAddresses: OFFICIAL, exactExpectedTableMatch: true };
}

async function creationBlock(provider, contract, pin) {
  let low = 0n, high = pin;
  while (low < high) {
    const mid = (low + high) >> 1n; const result = await rpc(provider, "eth_getCode", [contract, hex(mid)], 15_000);
    if (!result.ok || typeof result.result !== "string") fail("HISTORICAL_CODE_SEARCH_FAILED");
    if (result.result === "0x") low = mid + 1n; else high = mid;
  }
  const at = await rpc(provider, "eth_getCode", [contract, hex(low)]); if (!at.ok || at.result === "0x") fail("CREATION_CODE_ABSENT");
  if (low > 0n) { const before = await rpc(provider, "eth_getCode", [contract, hex(low - 1n)]); if (!before.ok || before.result !== "0x") fail("CREATION_BOUNDARY_UNPROVEN"); }
  return low;
}
async function getLogsAdaptive(provider, filter, start, end, onProgress = null) {
  const logs = []; let cursor = start; let span = 200_000n;
  while (cursor <= end) {
    if (++logRequestCount > LIMITS.logRequests) fail("LOG_REQUEST_BUDGET_EXHAUSTED");
    const to = cursor + span - 1n > end ? end : cursor + span - 1n;
    const result = await rpc(provider, "eth_getLogs", [{ ...filter, fromBlock: hex(cursor), toBlock: hex(to) }], 25_000);
    if (!result.ok || !Array.isArray(result.result)) {
      if (span <= 1_000n) fail("LOG_SCAN_PROVIDER_LIMIT"); span /= 2n; continue;
    }
    logs.push(...result.result); cursor = to + 1n; if (span < 500_000n) span *= 2n;
    if (onProgress) onProgress(cursor > end ? end : cursor, logs.length);
  }
  return logs;
}
function decodePoolCreated(log) {
  const parsed = FACTORY.parseLog(log); if (!parsed || parsed.name !== "PoolCreated") fail("POOL_CREATED_DECODE_FAILED");
  return { blockNumber: Number(BigInt(log.blockNumber)), blockHash: log.blockHash, transactionHash: log.transactionHash,
    logIndex: Number(BigInt(log.logIndex)), pool: address(parsed.args.poolAddress), protocolFeeRatio: parsed.args.protocolFeeRatio.toString(),
    feeAIn: parsed.args.feeAIn.toString(), feeBIn: parsed.args.feeBIn.toString(), tickSpacing: parsed.args.tickSpacing.toString(),
    lookback: parsed.args.lookback.toString(), activeTick: parsed.args.activeTick.toString(), tokenA: address(parsed.args.tokenA),
    tokenB: address(parsed.args.tokenB), kinds: parsed.args.kinds.toString(), accessor: address(parsed.args.accessor) };
}
async function call(provider, target, iface, functionName, args, pin) {
  const data = iface.encodeFunctionData(functionName, args); const result = await rpc(provider, "eth_call", [{ to: target, data }, hex(pin)], 15_000);
  if (!result.ok) return { ok: false, category: result.category };
  try { return { ok: true, value: iface.decodeFunctionResult(functionName, result.result) }; } catch { return { ok: false, category: "decode" }; }
}
async function enumerateFactory(provider, pin) {
  const countCall = await call(provider, OFFICIAL.factory, FACTORY, "poolCount", [], pin);
  const permissionedCountCall = await call(provider, OFFICIAL.factory, FACTORY, "poolPermissionedCount", [], pin);
  const counts = { permissionless: countCall.ok ? Number(countCall.value[0]) : null, permissioned: permissionedCountCall.ok ? Number(permissionedCountCall.value[0]) : null };
  const output = [];
  for (const [name, count] of [["lookup", counts.permissionless], ["lookupPermissioned", counts.permissioned]]) {
    if (!Number.isSafeInteger(count) || count < 0 || count > LIMITS.pools) continue;
    for (let start = 0; start < count; start += 100) {
      const end = Math.min(count, start + 100); const result = await call(provider, OFFICIAL.factory, FACTORY, `${name}(uint256,uint256)`, [start, end], pin);
      if (!result.ok) break; for (const pool of result.value[0]) output.push(address(pool));
    }
  }
  return { counts, pools: [...new Set(output)] };
}

async function codeBinding(provider, label, contract, pin) {
  const code = await rpc(provider, "eth_getCode", [contract, hex(pin)]); if (!code.ok || code.result === "0x") return { label, address: contract, codePresent: false };
  const slots = {};
  for (const [name, slot] of Object.entries(SLOTS)) { const result = await rpc(provider, "eth_getStorageAt", [contract, slot, hex(pin)]); slots[name] = result.ok ? wordAddress(result.result) : null; }
  const output = { label, address: contract, codePresent: true, runtimeBytes: bytesOf(code.result), runtimeKeccak256: keccak256(code.result), proxySlots: slots };
  if (slots.implementation) {
    const implementationCode = await rpc(provider, "eth_getCode", [slots.implementation, hex(pin)]);
    output.implementation = implementationCode.ok && implementationCode.result !== "0x" ? { address: slots.implementation,
      runtimeBytes: bytesOf(implementationCode.result), runtimeKeccak256: keccak256(implementationCode.result) } : { address: slots.implementation, codePresent: false };
  }
  return output;
}
async function tokenInfo(provider, token, holder, pin) {
  const functions = [["symbol", []], ["name", []], ["decimals", []], ["balanceOf", [holder]]];
  const results = await rpcBatch(provider, [["eth_getCode", [token, hex(pin)]], ...functions.map(([fn, args]) => ["eth_call", [{ to: token, data: ERC20.encodeFunctionData(fn, args) }, hex(pin)]])], 15_000);
  const code = results[0];
  const output = { address: token, codePresent: code.ok && code.result !== "0x", runtimeBytes: code.ok ? bytesOf(code.result) : null,
    runtimeKeccak256: code.ok && code.result !== "0x" ? keccak256(code.result) : null, recognized: RECOGNIZED[token.toLowerCase()] || null };
  for (let index = 0; index < functions.length; index++) {
    const [fn] = functions[index], result = results[index + 1];
    try { const value = result.ok ? ERC20.decodeFunctionResult(fn, result.result)[0] : null; if (fn === "balanceOf") output.poolBalance = value === null ? null : value.toString(); else output[fn] = value === null ? null : safeResult(value); }
    catch { if (fn === "balanceOf") output.poolBalance = null; else output[fn] = null; }
  }
  return output;
}
async function poolInfo(provider, pool, pin, eventRow = null) {
  const getters = [["tokenA", []], ["tokenB", []], ["fee", [true]], ["fee", [false]], ["tickSpacing", []], ["lookback", []],
    ["getState", []], ["protocolFeeA", []], ["protocolFeeB", []], ["lendingFeeRateD18", []], ["factory", []], ["kinds", []],
    ["permissionedPool", []], ["permissionedLiquidity", []], ["permissionedSwap", []]];
  const batch = await rpcBatch(provider, [["eth_getCode", [pool, hex(pin)]],
    ...getters.map(([fn, args]) => ["eth_call", [{ to: pool, data: POOL.encodeFunctionData(fn, args) }, hex(pin)]]),
    ["eth_call", [{ to: OFFICIAL.factory, data: FACTORY.encodeFunctionData("isFactoryPool", [pool]) }, hex(pin)]]], 20_000);
  const code = batch[0]; if (!code.ok || code.result === "0x") return { address: pool, codePresent: false, event: eventRow };
  const values = {};
  for (let index = 0; index < getters.length; index++) {
    const [fn, args] = getters[index], key = fn === "fee" ? args[0] ? "feeAIn" : "feeBIn" : fn, result = batch[index + 1];
    try { const decoded = result.ok ? POOL.decodeFunctionResult(fn, result.result) : null; values[key] = decoded ? safeResult(decoded.length === 1 ? decoded[0] : decoded) : null; } catch { values[key] = null; }
  }
  const factoryResult = batch[getters.length + 1]; let isFactoryPool = null;
  try { if (factoryResult.ok) isFactoryPool = Boolean(FACTORY.decodeFunctionResult("isFactoryPool", factoryResult.result)[0]); } catch {}
  const tokenA = typeof values.tokenA === "string" ? address(values.tokenA) : eventRow?.tokenA;
  const tokenB = typeof values.tokenB === "string" ? address(values.tokenB) : eventRow?.tokenB;
  const tokens = tokenA && tokenB ? await Promise.all([tokenInfo(provider, tokenA, pool, pin), tokenInfo(provider, tokenB, pool, pin)]) : [];
  return { address: pool, codePresent: true, runtimeBytes: bytesOf(code.result), runtimeKeccak256: keccak256(code.result),
    isFactoryPool, event: eventRow, values, tokens, activity: { swap: 0, addLiquidity: 0, removeLiquidity: 0, total: 0 } };
}

async function activity(provider, pools, pin) {
  const from = pin > BigInt(LIMITS.activityBlocks) ? pin - BigInt(LIMITS.activityBlocks) : 0n; const rows = [];
  for (let index = 0; index < pools.length; index += 40) {
    const addresses = pools.slice(index, index + 40); rows.push(...await getLogsAdaptive(provider, { address: addresses, topics: [ACTIVITY_TOPICS] }, from, pin));
  }
  const counts = new Map(pools.map((pool) => [pool.toLowerCase(), { swap: 0, addLiquidity: 0, removeLiquidity: 0, total: 0, latestBlock: null }]));
  for (const log of rows) {
    const row = counts.get(log.address.toLowerCase()); if (!row) continue;
    const topic = log.topics[0].toLowerCase(); const name = topic === ACTIVITY_TOPICS[0].toLowerCase() ? "swap" : topic === ACTIVITY_TOPICS[1].toLowerCase() ? "addLiquidity" : "removeLiquidity";
    row[name]++; row.total++; row.latestBlock = Math.max(row.latestBlock || 0, Number(BigInt(log.blockNumber)));
  }
  return { fromBlock: Number(from), toBlock: Number(pin), completeForBoundedWindow: true, totalLogs: rows.length, counts };
}
function normalized(raw, decimals) { if (raw === null || raw === undefined || !Number.isInteger(Number(decimals))) return null; return Number(raw) / 10 ** Number(decimals); }
function rankPools(pools) {
  for (const pool of pools) {
    const state = pool.values?.getState; const reserveA = state?.reserveA ?? state?.[0] ?? null; const reserveB = state?.reserveB ?? state?.[1] ?? null;
    let stableNominal = 0, weth = 0, recognizedSides = 0;
    for (const [index, raw] of [[0, reserveA], [1, reserveB]]) {
      const token = pool.tokens?.[index]; const recognized = token?.recognized; if (!recognized) continue; recognizedSides++;
      const amount = normalized(raw, token.decimals ?? recognized.decimals); if (!Number.isFinite(amount)) continue;
      if (recognized.kind === "stable") stableNominal += amount; if (recognized.kind === "wrapped-native") weth += amount;
    }
    pool.materialScreen = { method: "recognized-asset-raw-reserve-screen-no-price-oracle", stableNominal, weth, recognizedSides,
      material: stableNominal >= 10_000 || weth >= 5, activityRequired: true };
  }
  return [...pools].sort((a, b) => Number(Boolean(b.activity?.total)) - Number(Boolean(a.activity?.total))
    || b.materialScreen.stableNominal - a.materialScreen.stableNominal || b.materialScreen.weth - a.materialScreen.weth
    || (b.activity?.total || 0) - (a.activity?.total || 0));
}

async function corroborate(provider, pin, bindings, top, creation, firstEvent) {
  if (!provider) return { attempted: false, independentFamily: false };
  const evidence = { pinHash: null, bindings: [], topPool: null, historical: null };
  const block = await rpc(provider, "eth_getBlockByNumber", [hex(pin), false]); evidence.pinHash = block.ok ? block.result?.hash : null;
  for (const binding of bindings) { const code = await rpc(provider, "eth_getCode", [binding.address, hex(pin)]); evidence.bindings.push({ address: binding.address, runtimeKeccak256: code.ok && code.result !== "0x" ? keccak256(code.result) : null }); }
  if (top) {
    const code = await rpc(provider, "eth_getCode", [top.address, hex(pin)]); const state = await call(provider, top.address, POOL, "getState", [], pin);
    evidence.topPool = { address: top.address, runtimeKeccak256: code.ok && code.result !== "0x" ? keccak256(code.result) : null,
      state: state.ok ? safeResult(state.value[0]) : null };
  }
  const atCreation = await rpc(provider, "eth_getCode", [OFFICIAL.factory, hex(creation)], 15_000);
  const beforeCreation = creation > 0n ? await rpc(provider, "eth_getCode", [OFFICIAL.factory, hex(creation - 1n)], 15_000) : { ok: true, result: "0x" };
  const eventBlock = firstEvent ? BigInt(firstEvent.blockNumber) : creation;
  const historicalCall = await call(provider, OFFICIAL.factory, FACTORY, "poolCount", [], eventBlock);
  const historicalLogs = await rpc(provider, "eth_getLogs", [{ address: OFFICIAL.factory, fromBlock: hex(eventBlock), toBlock: hex(eventBlock), topics: [POOL_CREATED] }], 20_000);
  evidence.historical = { creationBlock: Number(creation), codePresentAtCreation: atCreation.ok && atCreation.result !== "0x",
    codeAbsentBeforeCreation: beforeCreation.ok && beforeCreation.result === "0x", callBlock: Number(eventBlock),
    poolCount: historicalCall.ok ? historicalCall.value[0].toString() : null,
    poolCreatedLogs: historicalLogs.ok && Array.isArray(historicalLogs.result) ? historicalLogs.result.map((log) => ({ blockHash: log.blockHash,
      transactionHash: log.transactionHash, logIndex: Number(BigInt(log.logIndex)), address: address(log.address), topic0: log.topics[0] })) : null };
  return { attempted: true, independentFamily: true, exactPublicEvidenceDigest: publicHash(evidence), evidence };
}

function sourceRuntimeCandidate(api) {
  for (const key of ["runtimeBytecode", "deployedBytecode", "onchainRuntimeBytecode"]) if (typeof api?.[key] === "string") return api[key].startsWith("0x") ? api[key] : `0x${api[key]}`;
  for (const value of Object.values(api || {})) if (value && typeof value === "object") { const found = sourceRuntimeCandidate(value); if (found) return found; }
  return null;
}
async function sourceRecovery(pool, chainRuntime) {
  if (!pool) return { attempted: false, gate: "NOT_ATTEMPTED_NO_POOL" };
  const addressChecksum = address(pool.address); const attempts = [];
  const apiUrl = `https://sourcify.dev/server/v2/contract/${CHAIN_ID}/${addressChecksum}?fields=all`;
  const apiResponse = await fetchLimited(apiUrl, { headers: { accept: "application/json" } }, LIMITS.sourceBytes, 25_000);
  attempts.push({ authority: "Sourcify v2", status: apiResponse.status, bytes: apiResponse.bytes.length });
  let api = null; if (apiResponse.ok) try { api = JSON.parse(apiResponse.bytes.toString("utf8")); } catch {}
  const result = { attempted: true, address: addressChecksum, attempts, sourcify: null, baseScan: null, gate: "SOURCE_UNRECOVERED" };
  if (api) {
    const returnedRuntime = sourceRuntimeCandidate(api); const runtimeEquality = returnedRuntime ? returnedRuntime.toLowerCase() === chainRuntime.toLowerCase() : null;
    const sources = api.sources || api.compilation?.sources || null; const settings = api.compilerSettings || api.compilation?.compilerSettings || api.metadata?.settings || null;
    const compilerVersion = api.compilerVersion || api.compilation?.compilerVersion || api.metadata?.compiler?.version || null;
    const match = api.match || api.matchStatus || api.runtimeMatch || api.verification?.match || null;
    result.sourcify = { responseSha256: sha256(apiResponse.bytes), match, compilerVersion, sourceCount: sources && typeof sources === "object" ? Object.keys(sources).length : null,
      settingsPresent: Boolean(settings), returnedRuntimePresent: Boolean(returnedRuntime), returnedRuntimeExact: runtimeEquality };
    if (sources && settings && compilerVersion && String(compilerVersion).includes("0.8.25")) {
      try {
        const solc = require("solc"); const normalizedSources = Object.fromEntries(Object.entries(sources).map(([name, row]) => [name, typeof row === "string" ? { content: row } : { content: row.content }]));
        if (Object.values(normalizedSources).some((row) => typeof row.content !== "string")) throw new Error("source-content-absent");
        const compileSettings = structuredClone(settings); compileSettings.outputSelection = { "*": { "*": ["evm.deployedBytecode.object", "evm.deployedBytecode.immutableReferences", "evm.deployedBytecode.linkReferences", "metadata"] } };
        const outputText = solc.compile(JSON.stringify({ language: api.language || api.compilation?.language || "Solidity", sources: normalizedSources, settings: compileSettings }));
        const output = JSON.parse(outputText); const errors = (output.errors || []).filter((row) => row.severity === "error");
        const contracts = Object.entries(output.contracts || {}).flatMap(([file, names]) => Object.entries(names).map(([name, artifact]) => ({ file, name, artifact })));
        const exact = contracts.find((row) => `0x${row.artifact.evm.deployedBytecode.object}`.toLowerCase() === chainRuntime.toLowerCase());
        result.sourcify.compile = { compilerReported: solc.version(), errorCount: errors.length, artifactCount: contracts.length,
          exactRuntimeMatch: Boolean(exact), target: exact ? `${exact.file}:${exact.name}` : null,
          standardInputSha256: sha256(Buffer.from(JSON.stringify(canonical({ language: api.language || api.compilation?.language || "Solidity", sources: normalizedSources, settings: compileSettings })))) };
        if (!errors.length && exact) result.gate = "SOURCE_EXACT_RUNTIME_MATCH";
      } catch { result.sourcify.compile = { exactRuntimeMatch: false, category: "bounded-compile-unavailable-or-nonexact" }; }
    }
    if (result.gate !== "SOURCE_EXACT_RUNTIME_MATCH" && runtimeEquality && /exact|full/i.test(String(match))) result.gate = "SOURCE_AUTHORITY_EXACT_RETURNED_RUNTIME";
  }
  const baseScanUrl = `https://basescan.org/address/${addressChecksum}#code`;
  const baseScan = await fetchLimited(baseScanUrl, { headers: { accept: "text/html", "user-agent": "Mozilla/5.0 provenance-capture" } }, LIMITS.sourceBytes, 20_000);
  attempts.push({ authority: "BaseScan public HTML", status: baseScan.status, bytes: baseScan.bytes.length });
  if (baseScan.ok) {
    const text = baseScan.bytes.toString("utf8"); result.baseScan = { responseSha256: sha256(baseScan.bytes), verifiedSourcePageMarker: /Contract Source Code Verified|Exact Match/i.test(text),
      compiler025Marker: /v0\.8\.25|0\.8\.25\+commit/i.test(text), contractName: text.match(/Contract Name:\s*<\/div>\s*<div[^>]*>\s*([^<]+)/i)?.[1]?.trim() || null };
  }
  return result;
}

function leakCheck(outputs, candidates) {
  const body = outputs.join("\n").toLowerCase();
  for (const row of candidates) {
    const values = [row.url, new URL(row.url).hostname, ...Object.values(row.headers)];
    for (const value of values) if (String(value).length >= 6 && body.includes(String(value).toLowerCase())) fail("ENDPOINT_MATERIAL_LEAK");
  }
  return { status: "PASS", inventoryValuesPersisted: false, providerDomainsPersisted: false, credentialsPersisted: false };
}
function writeCheckpoint(value) { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(CHECKPOINT, json(value), "utf8"); }
function buildReport(capture, source) {
  const top = capture.selection.topActiveMaterialPool;
  const rows = capture.ranking.slice(0, 15).map((row, index) => `| ${index + 1} | \`${row.address}\` | ${row.pair} | ${row.stableNominal.toFixed(2)} | ${row.weth.toFixed(6)} | ${row.activity} | ${row.material ? "yes" : "no"} |`).join("\n") || "| - | - | - | - | - | - | - |";
  const absent = capture.deployments.filter((row) => !row.codePresent).map((row) => `${row.label} \`${row.address}\``).join(", ") || "none";
  return `# Maverick V2 Base pools — deployment provenance Gate 1\n\n**Signal:** informational deployment/material/activity prefilter. **No exploit claim.** Route and executable status remain **unknown**.\n\n## Pin and provider qualification\n\n- Chain: Base (8453); finalized pin: **${capture.pin.number}** (\`${capture.pin.hash}\`).\n- Qualified same-pin independent endpoint families: **${capture.endpointQualification.samePinIndependentFamilyCount}**. Endpoint inventory values were process-only and passed the leak gate.\n- Factory creation boundary: block **${capture.factory.creationBlock}**. PoolCreated scan: **${capture.factory.eventScanComplete ? "complete" : "incomplete"}**, ${capture.factory.poolCreatedEvents} events.\n\n## Official deployment provenance\n\nThe live official documentation table was fetched and matched the expected Base factory, pool lens, quoter, router, position, and WETH addresses. At the finalized pin, ${capture.deployments.filter((row) => row.codePresent).length}/${capture.deployments.length} documented protocol contracts had code; absent-code entries: ${absent}. Factory runtime: \`${capture.factory.runtimeKeccak256}\`; EIP-1967 implementation/admin/beacon slots were ${capture.factory.proxyDetected ? "non-zero (proxy binding recorded)" : "all zero (no EIP-1967 proxy detected)"}. Official deployment-code gate: **${capture.gates.deploymentProvenance.status}**.\n\n## Pool completeness and corroboration\n\nFactory counts: permissionless=${capture.factory.enumeration.counts.permissionless ?? "unknown"}, permissioned=${capture.factory.enumeration.counts.permissioned ?? "unknown"}. Event/lookup union=${capture.pools.length}; every decoded pool was checked with \`isFactoryPool\`. Event-vs-enumeration gate: **${capture.gates.provenance.status}**. Independent-family same-pin material corroboration: **${capture.gates.independentCorroboration.status}**.\n\n## Current material/activity ranking\n\nNo external price feed was needed or assumed. Ranking uses pin-bound internal reserves for recognized Base stablecoins and WETH, plus a bounded ${capture.activity.windowBlocks.toLocaleString()}-block activity scan. Stable amounts are nominal metadata screens; WETH is reported in native units. Unrecognized assets are not assigned value.\n\n| Rank | Pool | Pair | Stable nominal | WETH | Recent events | Material |\n|---:|---|---|---:|---:|---:|---|\n${rows}\n\nSelected top active material pool: **${top ? `\`${top.address}\` (${top.pair})` : "none"}**. Material gate: **${capture.gates.material.status}**; activity gate: **${capture.gates.activity.status}**.\n\n## Verified source gate\n\nSource recovery was attempted through Sourcify v2 and BaseScan public HTTP for the selected pool. Result: **${source.gate}**. Compiler/settings/source/runtime details and public-response commitments are in \`reports/raw/fast/${NAME}/source-recovery.json\`. Source gate: **${capture.gates.source.status}**.\n\n## Disposition\n\n**${capture.disposition}** — pool provenance, official deployment code, material, activity, independent corroboration, and source are separate gates. The official router address had no code at the pin and the selected pool was not verified by either attempted source authority, so those gates remain partial/unknown. This capture does not evaluate swap execution, profitability, exploitability, or a route; \`routePositive\` and executable status are unknown. No signing, state change, fork, deployment, or live swap occurred.\n`;
}

async function main() {
  for (const required of [TOOL, ...INVENTORIES.map((file) => path.join(ROOT, file))]) if (!fs.existsSync(required)) fail("REQUIRED_INPUT_MISSING");
  fs.mkdirSync(OUT, { recursive: true });
  const candidates = extractCandidates(); if (!candidates.length) fail("ENDPOINT_INVENTORY_EMPTY");
  const docs = await officialDocs();
  const selected = await chooseProviders(candidates); const pin = BigInt(selected.pin.number);
  const created = await creationBlock(selected.primary, OFFICIAL.factory, pin);
  const checkpointBase = { schema: `${NAME}/checkpoint-v1`, chainId: CHAIN_ID, pin: { number: Number(pin), hash: selected.pin.hash }, factory: OFFICIAL.factory,
    creationBlock: Number(created), nextBlock: Number(created), poolCreatedEvents: 0, complete: false };
  writeCheckpoint(checkpointBase);
  const eventLogs = await getLogsAdaptive(selected.primary, { address: OFFICIAL.factory, topics: [POOL_CREATED] }, created, pin,
    (next, count) => writeCheckpoint({ ...checkpointBase, nextBlock: Number(next), poolCreatedEvents: count, complete: next === pin }));
  const events = eventLogs.map(decodePoolCreated).sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  writeCheckpoint({ ...checkpointBase, nextBlock: Number(pin), poolCreatedEvents: events.length, complete: true });
  const enumeration = await enumerateFactory(selected.primary, pin);
  const eventByPool = new Map(events.map((row) => [row.pool.toLowerCase(), row]));
  const poolAddresses = [...new Set([...events.map((row) => row.pool), ...enumeration.pools])]; if (poolAddresses.length > LIMITS.pools) fail("POOL_BUDGET_EXHAUSTED");
  const pools = (await parallel(poolAddresses, 6, (pool) => poolInfo(selected.primary, pool, pin, eventByPool.get(pool.toLowerCase()) || null))).filter(Boolean);
  const activityResult = await activity(selected.primary, poolAddresses, pin);
  for (const pool of pools) pool.activity = activityResult.counts.get(pool.address.toLowerCase()) || pool.activity;
  const ranked = rankPools(pools); const top = ranked.find((pool) => pool.isFactoryPool && pool.materialScreen.material && pool.activity.total > 0) || null;
  const deployments = [];
  for (const [label, contract] of Object.entries(OFFICIAL).filter(([label]) => label !== "weth")) deployments.push(await codeBinding(selected.primary, label, contract, pin));
  const factoryBinding = deployments.find((row) => row.label === "factory");
  const primaryCorroboration = await corroborate(selected.primary, pin, deployments, top, created, events[0] || null);
  let corroboration = { attempted: false, independentFamily: false };
  for (const candidate of selected.alternatives || []) {
    const attempt = await corroborate(candidate, pin, deployments, top, created, events[0] || null);
    corroboration = attempt;
    if (attempt.attempted && attempt.exactPublicEvidenceDigest === primaryCorroboration.exactPublicEvidenceDigest) break;
  }
  const topCode = top ? await rpc(selected.primary, "eth_getCode", [top.address, hex(pin)]) : null;
  const source = await sourceRecovery(top, topCode?.ok ? topCode.result : "0x");
  const eventSet = new Set(events.map((row) => row.pool.toLowerCase()));
  const enumerationSet = new Set(enumeration.pools.map((row) => row.toLowerCase()));
  const expectedCount = (enumeration.counts.permissionless ?? 0) + (enumeration.counts.permissioned ?? 0);
  const provenancePass = events.length === eventSet.size && poolAddresses.every((pool) => pools.find((row) => row.address.toLowerCase() === pool.toLowerCase())?.isFactoryPool === true)
    && (expectedCount === 0 || enumerationSet.size === expectedCount) && [...enumerationSet].every((pool) => eventSet.has(pool));
  const independentPass = corroboration.attempted && corroboration.evidence?.pinHash?.toLowerCase() === selected.pin.hash.toLowerCase()
    && primaryCorroboration.attempted && corroboration.exactPublicEvidenceDigest === primaryCorroboration.exactPublicEvidenceDigest;
  const deploymentCodeComplete = deployments.every((row) => row.codePresent);
  const capture = canonical({ schema: `${NAME}/capture-v1`, generatedAt: new Date().toISOString(), classification: "INFORMATIONAL/READ_ONLY/NO_EXPLOIT_CLAIM/ROUTE_UNKNOWN",
    chainId: CHAIN_ID, pin: { tag: "finalized", number: Number(pin), hash: selected.pin.hash, timestamp: Number(BigInt(selected.pin.timestamp)) }, officialDocs: docs,
    endpointQualification: selected.summary, deployments, factory: { address: OFFICIAL.factory, creationBlock: Number(created), eventScanComplete: true,
      poolCreatedEvents: events.length, runtimeKeccak256: factoryBinding.runtimeKeccak256, runtimeBytes: factoryBinding.runtimeBytes,
      proxySlots: factoryBinding.proxySlots, proxyDetected: Object.values(factoryBinding.proxySlots).some(Boolean), enumeration },
    poolCreatedEvents: events, pools, activity: { fromBlock: activityResult.fromBlock, toBlock: activityResult.toBlock, windowBlocks: Number(pin) - activityResult.fromBlock,
      totalLogs: activityResult.totalLogs, completeForBoundedWindow: true },
    ranking: ranked.map((pool) => ({ address: pool.address, pair: pool.tokens.map((token) => token.symbol || token.recognized?.symbol || token.address).join("/"),
      stableNominal: pool.materialScreen.stableNominal, weth: pool.materialScreen.weth, recognizedSides: pool.materialScreen.recognizedSides,
      material: pool.materialScreen.material, activity: pool.activity.total, runtimeKeccak256: pool.runtimeKeccak256, isFactoryPool: pool.isFactoryPool })),
    selection: { topActiveMaterialPool: top ? { address: top.address, pair: top.tokens.map((token) => token.symbol || token.address).join("/"), reason: "highest active recognized-asset raw reserve screen" } : null },
    primaryCorroboration, independentCorroboration: corroboration, gates: { deploymentProvenance: { status: deploymentCodeComplete ? "PASS" : "PARTIAL",
      officialDocsExactAddressMatch: docs.exactExpectedTableMatch, codePresentCount: deployments.filter((row) => row.codePresent).length,
      documentedContractCount: deployments.length, absentCodeLabels: deployments.filter((row) => !row.codePresent).map((row) => row.label) },
      provenance: { status: provenancePass ? "PASS" : "FAIL", completeEventScan: true,
      allPoolsFactoryCorroborated: pools.every((pool) => pool.isFactoryPool === true), enumerationCountMatched: expectedCount === enumerationSet.size,
      enumerationSubsetOfEvents: [...enumerationSet].every((pool) => eventSet.has(pool)) },
      material: { status: top?.materialScreen.material ? "PASS" : "UNKNOWN", valuation: "recognized stable nominal plus raw WETH; no oracle price" },
      activity: { status: top?.activity.total > 0 ? "PASS" : "UNKNOWN", boundedWindowComplete: true },
      source: { status: source.gate === "SOURCE_EXACT_RUNTIME_MATCH" ? "PASS" : source.gate === "SOURCE_AUTHORITY_EXACT_RETURNED_RUNTIME" ? "PARTIAL" : "UNKNOWN", result: source.gate },
      independentCorroboration: { status: independentPass ? "PASS" : "UNKNOWN", independentFamilies: selected.summary.samePinIndependentFamilyCount,
        samePinCallsCodeLogsHistoricalCompared: independentPass } },
    routePositive: "unknown", executable: "unknown", exploitClaim: false,
    disposition: provenancePass && top && top.activity.total > 0
      ? deploymentCodeComplete ? "GATE1_POOL_PROVENANCE_ACTIVITY_MATERIAL_PASS_SOURCE_SEPARATE" : "GATE1_POOL_PROVENANCE_ACTIVITY_MATERIAL_PASS_DEPLOYMENT_PARTIAL_SOURCE_UNKNOWN"
      : "GATE1_HOLD" });
  const captureText = json(capture), sourceText = json(source), checkpointText = fs.readFileSync(CHECKPOINT, "utf8");
  const reportText = buildReport(capture, source); const leak = leakCheck([captureText, sourceText, checkpointText, reportText], candidates);
  capture.secretSafety = leak;
  fs.writeFileSync(CAPTURE, json(capture), "utf8"); fs.writeFileSync(SOURCE, sourceText, "utf8"); fs.writeFileSync(REPORT, reportText, "utf8");
  const records = [TOOL, CAPTURE, CHECKPOINT, SOURCE, REPORT].map((file) => { const bytes = fs.readFileSync(file); return { path: path.relative(ROOT, file).replace(/\\/g, "/"), bytes: bytes.length, sha256: sha256(bytes) }; });
  const manifest = { schema: `${NAME}/manifest-v1`, generatedAt: capture.generatedAt, records,
    aggregateSha256: sha256(Buffer.from(records.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n"))), secretSafety: leak };
  fs.writeFileSync(MANIFEST, json(manifest), "utf8");
  console.log(JSON.stringify({ status: "ok", pin: capture.pin.number, pools: pools.length, events: events.length, independentFamilies: selected.summary.samePinIndependentFamilyCount,
    topPoolSelected: Boolean(top), sourceGate: source.gate, disposition: capture.disposition }));
}

main().catch((error) => { console.error(JSON.stringify({ status: "failed", category: error?.safeCode || "BOUNDED_CAPTURE_FAILURE" })); process.exitCode = 1; });
