#!/usr/bin/env node
"use strict";

// Bounded, authorized, read-only deployment/state capture. Endpoint inventory
// material and raw RPC responses remain memory-only and are leak-guarded before
// any output is written. This runner never signs, broadcasts, mutates state,
// uses state overrides, or calls reallocateTo/estimateGas.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ROOT = path.resolve(__dirname, "..");
const TARGET = path.join(ROOT, "targets", "silo-contracts-v2", "silo-vaults");
const INVENTORIES = ["rpc_endpoints.txt", "graphql_endpoints.txt"];
const RAW = path.join(ROOT, "reports", "raw", "fast", "critical-silo-v3-public-allocator-deployment-economics-step2.json");
const REPORT = path.join(ROOT, "reports", "critical-silo-v3-public-allocator-deployment-economics-step2.md");
const NAME = "critical-silo-v3-public-allocator-deployment-economics-step2";
const ZERO = "0x0000000000000000000000000000000000000000";
const SYNTHETIC = "0x1111111111111111111111111111111111111111";
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const RUN_KEY = crypto.randomBytes(32);
const LIMITS = Object.freeze({ endpointCandidates: 360, rpcCalls: 7000, timeoutMs: 10000, responseBytes: 6 * 1024 * 1024, selectedFamilies: 2, vaultsPerChain: 256, marketsPerVault: 32, logCallsPerChain: 900 });
const ALLOWED = new Set(["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_getStorageAt", "eth_call", "eth_getLogs", "eth_gasPrice"]);

const CHAIN_INPUTS = Object.freeze([
  [1, "mainnet"], [10, "optimism"], [50, "xdc"], [56, "bnb"], [146, "sonic"], [196, "okx"],
  [1776, "injective"], [4326, "megaeth"], [5000, "mantle"], [8453, "base"], [42161, "arbitrum_one"],
  [43114, "avalanche"], [57073, "ink"]
]);

const FACTORY_ABI = [
  "function VERSION() view returns(string)",
  "function isSiloVault(address) view returns(bool)",
  "event CreateSiloVault(address indexed SiloVault,address indexed caller,address initialOwner,uint256 initialTimelock,address indexed asset,string name,string symbol)"
];
const VAULT_ABI = [
  "function asset() view returns(address)", "function owner() view returns(address)", "function curator() view returns(address)",
  "function guardian() view returns(address)", "function totalAssets() view returns(uint256)", "function totalSupply() view returns(uint256)",
  "function DEFAULT_LOST_THRESHOLD() view returns(uint256)", "function isAllocator(address) view returns(bool)",
  "function supplyQueueLength() view returns(uint256)", "function supplyQueue(uint256) view returns(address)",
  "function withdrawQueueLength() view returns(uint256)", "function withdrawQueue(uint256) view returns(address)",
  "function config(address) view returns(uint184 cap,bool enabled,uint64 removableAt)",
  "function arbitraryLossThreshold(address) view returns(uint256 threshold)", "function balanceTracker(address) view returns(uint256)"
];
const ALLOCATOR_ABI = [
  "function admin(address) view returns(address)", "function fee(address) view returns(uint256)",
  "function accruedFee(address) view returns(uint256)", "function flowCaps(address,address) view returns(uint128 maxIn,uint128 maxOut)"
];
const MARKET_ABI = [
  "function asset() view returns(address)", "function totalAssets() view returns(uint256)", "function totalSupply() view returns(uint256)",
  "function balanceOf(address) view returns(uint256)", "function convertToAssets(uint256) view returns(uint256)",
  "function maxWithdraw(address) view returns(uint256)", "function maxRedeem(address) view returns(uint256)",
  "function maxDeposit(address) view returns(uint256)", "function previewDeposit(uint256) view returns(uint256)",
  "function decimals() view returns(uint8)", "function symbol() view returns(string)"
];
const TOKEN_ABI = ["function decimals() view returns(uint8)", "function symbol() view returns(string)", "function balanceOf(address) view returns(uint256)"];
const IFACE = Object.freeze({ factory: new ethers.Interface(FACTORY_ABI), vault: new ethers.Interface(VAULT_ABI), allocator: new ethers.Interface(ALLOCATOR_ABI), market: new ethers.Interface(MARKET_ABI), token: new ethers.Interface(TOKEN_ABI) });
const CREATE_TOPIC = IFACE.factory.getEvent("CreateSiloVault").topicHash.toLowerCase();

let budget = { attempted: 0, succeeded: 0, failed: 0, byMethod: {} };
let requestId = 1;
const secrets = new Set();
class Stop extends Error { constructor(code) { super(code); this.code = code; } }
const fail = code => { throw new Stop(code); };
const lower = value => String(value).toLowerCase();
const quantity = value => `0x${BigInt(value).toString(16)}`;
const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
const canon = value => typeof value === "bigint" ? JSON.stringify(value.toString()) : Array.isArray(value) ? `[${value.map(canon).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canon(value[k])}`).join(",")}}` : JSON.stringify(value);
const safeAddress = value => { try { return ethers.getAddress(value); } catch { return null; } };

function canonicalQuantity(value) {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value)) return null;
  try { return BigInt(value); } catch { return null; }
}
function strictHeader(value, expected = null) {
  if (!value || Array.isArray(value)) return null;
  const number = canonicalQuantity(value.number), timestamp = canonicalQuantity(value.timestamp);
  if (number == null || timestamp == null || !/^0x[0-9a-f]{64}$/.test(value.hash || "")) return null;
  if (expected != null && number !== BigInt(expected)) return null;
  const baseFee = value.baseFeePerGas == null ? null : canonicalQuantity(value.baseFeePerGas);
  return { number, timestamp, hash: value.hash, baseFeePerGas: baseFee };
}
function validateExpectedChains(definitions = CHAIN_INPUTS) {
  if (!Array.isArray(definitions) || definitions.length === 0) throw new Error("EMPTY_CHAIN_DEFINITIONS");
  const ids = new Set(), folders = new Set();
  for (const row of definitions) {
    if (!Array.isArray(row) || row.length !== 2 || !Number.isSafeInteger(row[0]) || row[0] <= 0 || typeof row[1] !== "string" || row[1] === "") throw new Error("MALFORMED_CHAIN_DEFINITION");
    if (ids.has(row[0])) throw new Error("DUPLICATE_EXPECTED_CHAIN_ID");
    if (folders.has(row[1])) throw new Error("DUPLICATE_EXPECTED_CHAIN_FOLDER");
    ids.add(row[0]); folders.add(row[1]);
  }
  return { count: definitions.length, uniqueChainIds: true, uniqueFolders: true };
}
function publicAllocatorAuthorization(isAllocatorValue, owner, curator, allocator) {
  const mapping = isAllocatorValue === true, ownerPath = lower(owner) === lower(allocator), curatorPath = lower(curator) === lower(allocator);
  return { isAllocatorMapping: mapping, ownerEqualsAllocator: ownerPath, curatorEqualsAllocator: curatorPath, publicAllocatorAuthorized: mapping || ownerPath || curatorPath };
}
function classifySlotObservation(results, expectedFamilies) {
  const successful = Array.isArray(results) ? results.filter(x => x?.ok === true).length : 0;
  const base = { selectedFamilies: expectedFamilies, successfulFamilies: successful, agreement: null, value: null, implementation: null, proxyDetected: null };
  if (!Array.isArray(results) || results.length !== expectedFamilies || successful !== expectedFamilies) return { ...base, readStatus: "FAILURE" };
  const values = results.map(x => x.result);
  if (values.some(x => !/^0x[0-9a-f]{64}$/.test(x || ""))) return { ...base, readStatus: "MALFORMED" };
  if (values.some(x => x !== values[0])) return { ...base, readStatus: "DISAGREEMENT", agreement: false };
  const implementation = implementationAddress(values[0]);
  return { ...base, readStatus: implementation === null ? "AGREED_ZERO" : "AGREED_NONZERO", agreement: true, value: values[0], implementation, proxyDetected: implementation !== null };
}
function opaqueFamily(url, key = RUN_KEY) {
  return `family-${crypto.createHmac("sha256", key).update(new URL(url).hostname.toLowerCase()).digest("hex").slice(0, 24)}`;
}
function parseInventoryText(text, source, key = RUN_KEY) {
  const records = String(text).replace(/\\\//g, "/").split(/\r?\n[ \t]*\r?\n/), out = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index], headers = {};
    const origin = record.match(/\[origin:\s*([^\]\s]+)\]/i)?.[1]; if (origin) headers.origin = origin;
    for (const h of record.matchAll(/\[header:\s*([^=\]\s]+)=([^\]]+)\]/gi)) headers[h[1].trim().toLowerCase()] = h[2].trim();
    for (const match of record.matchAll(/https?:\/\/[^\s"'`<>{}\[\]]+/gi)) {
      let url; try { url = new URL(match[0].replace(/[)>`,.;\]]+$/g, "")).href; } catch { continue; }
      out.push({ url, headers: { ...headers }, source, record: index, family: opaqueFamily(url, key) });
    }
  }
  return out;
}
function inventory() {
  const byUrl = new Map();
  for (const rel of INVENTORIES) {
    const full = path.join(ROOT, rel); if (!fs.existsSync(full)) continue;
    for (const row of parseInventoryText(fs.readFileSync(full, "utf8"), rel)) if (!byUrl.has(row.url)) byUrl.set(row.url, row);
  }
  const rows = [...byUrl.values()].slice(0, LIMITS.endpointCandidates);
  for (const row of rows) {
    const u = new URL(row.url);
    for (const value of [row.url, u.hostname]) if (String(value).length >= 4) secrets.add(lower(value));
    for (const value of [u.username, u.password, ...u.searchParams.values(), ...Object.values(row.headers)]) if (String(value).length >= 6) secrets.add(lower(value));
    // Short/generic route components (for example a chain label) are not secret
    // preimages and create false positives in sanitized status text. Long route
    // components commonly carrying endpoint credentials remain guarded.
    for (const value of u.pathname.split("/")) if (String(value).length >= 16) secrets.add(lower(value));
  }
  return rows;
}
async function bodyWithCap(response) {
  if (!response.body?.getReader) return null; const reader = response.body.getReader(), chunks = []; let bytes = 0;
  while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > LIMITS.responseBytes) { await reader.cancel(); return null; } chunks.push(Buffer.from(value)); }
  try { return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")); } catch { return null; }
}
async function rpc(row, method, params = [], timeoutMs = LIMITS.timeoutMs) {
  if (!ALLOWED.has(method)) return { ok: false, error: "METHOD_NOT_ALLOWED" };
  if (++budget.attempted > LIMITS.rpcCalls) fail("RPC_BUDGET_EXCEEDED"); budget.byMethod[method] = (budget.byMethod[method] || 0) + 1;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(row.url, { method: "POST", redirect: "error", headers: { "content-type": "application/json", ...row.headers }, body: JSON.stringify({ jsonrpc: "2.0", id: requestId++, method, params }), signal: controller.signal });
    if (!response.ok) throw new Error("HTTP"); const parsed = await bodyWithCap(response); if (!parsed || parsed.error || !Object.hasOwn(parsed, "result") || parsed.result == null) throw new Error("RPC");
    budget.succeeded++; return { ok: true, result: parsed.result };
  } catch { budget.failed++; return { ok: false, error: "UNAVAILABLE" }; } finally { clearTimeout(timer); }
}
async function mapLimit(items, count, worker) { const out = new Array(items.length); let cursor = 0; async function run() { while (true) { const i = cursor++; if (i >= items.length) return; out[i] = await worker(items[i], i); } } await Promise.all(Array.from({ length: Math.min(count, items.length) }, run)); return out; }
async function qualify(rows) {
  const checks = await mapLimit(rows, 12, async row => { const r = await rpc(row, "eth_chainId", [], 6000); const id = r.ok ? canonicalQuantity(r.result) : null; return id == null || id > BigInt(Number.MAX_SAFE_INTEGER) ? null : { row, chainId: Number(id) }; });
  const target = new Set(CHAIN_INPUTS.map(x => x[0])), grouped = new Map();
  for (const item of checks.filter(Boolean)) if (target.has(item.chainId)) { const list = grouped.get(item.chainId) || []; if (!list.some(x => x.family === item.row.family)) list.push(item.row); grouped.set(item.chainId, list); }
  return { parsed: rows.length, parseable: checks.filter(Boolean).length, byChain: grouped };
}
function deployment(chainFolder, contract) { return JSON.parse(fs.readFileSync(path.join(TARGET, "deployments", chainFolder, `${contract}.sol.json`), "utf8")); }
async function selectPin(chainId, rows, addresses) {
  const observed = [];
  for (const row of rows.slice(0, 8)) {
    const r = await rpc(row, "eth_getBlockByNumber", ["finalized", false]); const h = r.ok ? strictHeader(r.result) : null; if (!h) continue;
    const [pa, fac] = await Promise.all([rpc(row, "eth_getCode", [addresses.allocator, quantity(h.number)]), rpc(row, "eth_getCode", [addresses.factory, quantity(h.number)])]);
    if (!pa.ok || pa.result === "0x" || !fac.ok || fac.result === "0x") continue; observed.push({ row, finalized: h });
  }
  if (!observed.length) return { ok: false, blocker: "NO_FINALIZED_FAMILY_WITH_DEPLOYMENT_CODE", qualifiedFamilies: rows.length };
  const number = observed.reduce((a, x) => x.finalized.number < a ? x.finalized.number : a, observed[0].finalized.number), tag = quantity(number), groups = new Map();
  for (const item of observed) { const r = await rpc(item.row, "eth_getBlockByNumber", [tag, false]); const h = r.ok ? strictHeader(r.result, number) : null; if (!h) continue; const g = groups.get(h.hash) || []; g.push({ row: item.row, header: h }); groups.set(h.hash, g); }
  const best = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)[0]; if (!best) return { ok: false, blocker: "COMMON_FINALIZED_PIN_UNAVAILABLE", qualifiedFamilies: rows.length };
  const selected = best[1].slice(0, LIMITS.selectedFamilies); return { ok: true, chainId, number, tag, hash: best[0], timestamp: selected[0].header.timestamp, baseFeePerGas: selected[0].header.baseFeePerGas, selected, historyCandidates: best[1], reportedFinalizedFamilies: observed.length };
}
async function agreedRaw(pin, method, params, required = true) {
  const results = []; for (const item of pin.selected) { const r = await rpc(item.row, method, params); if (!r.ok) { if (required) throw new Error("STATE_UNAVAILABLE"); return null; } results.push(r.result); }
  if (!results.length || results.some(x => canon(x) !== canon(results[0]))) { if (required) throw new Error("STATE_MISMATCH"); return null; } return results[0];
}
async function observedRaw(pin, method, params) {
  const results = []; for (const item of pin.selected) results.push(await rpc(item.row, method, params));
  return results;
}
async function call(pin, target, iface, method, args = [], required = true) {
  const raw = await agreedRaw(pin, "eth_call", [{ from: SYNTHETIC, to: target, data: iface.encodeFunctionData(method, args) }, pin.tag], required); if (raw == null) return null;
  try { return iface.decodeFunctionResult(method, raw); } catch { if (required) throw new Error("DECODE"); return null; }
}
async function firstCodeBlock(row, address, high) {
  let lo = 0n, hi = high; const top = await rpc(row, "eth_getCode", [address, quantity(hi)]); if (!top.ok || top.result === "0x") throw new Error("CODE_ABSENT");
  while (lo < hi) { const mid = (lo + hi) / 2n, r = await rpc(row, "eth_getCode", [address, quantity(mid)]); if (!r.ok) throw new Error("HISTORICAL_CODE_UNAVAILABLE"); if (r.result === "0x") lo = mid + 1n; else hi = mid; }
  return lo;
}
function normalizeLogs(logs) { return logs.map(x => ({ address: lower(x.address), blockNumber: Number(BigInt(x.blockNumber)), blockHash: lower(x.blockHash), transactionHash: lower(x.transactionHash), transactionIndex: Number(BigInt(x.transactionIndex)), logIndex: Number(BigInt(x.logIndex)), topics: x.topics.map(lower), data: lower(x.data) })).sort((a, b) => a.blockNumber - b.blockNumber || a.transactionIndex - b.transactionIndex || a.logIndex - b.logIndex); }
function parseFactoryLogsStrict(logs, expectedFactory = null) {
  if (!Array.isArray(logs)) throw new Error("MALFORMED_FACTORY_LOG_SET");
  const vaults = [];
  for (const log of logs) {
    if (!log || typeof log !== "object" || !Array.isArray(log.topics) || log.topics.length !== 4 || log.topics[0] !== CREATE_TOPIC || !/^0x[0-9a-f]*$/.test(log.data || "") || !/^0x[0-9a-f]{64}$/.test(log.blockHash || "") || !/^0x[0-9a-f]{64}$/.test(log.transactionHash || "") || !Number.isSafeInteger(log.blockNumber) || !Number.isSafeInteger(log.transactionIndex) || !Number.isSafeInteger(log.logIndex)) throw new Error("MALFORMED_FACTORY_LOG");
    if (expectedFactory && lower(log.address) !== lower(expectedFactory)) throw new Error("FACTORY_LOG_ADDRESS_MISMATCH");
    let decoded; try { decoded = IFACE.factory.parseLog(log); } catch { throw new Error("FACTORY_LOG_DECODE_FAILED"); }
    if (!decoded || decoded.name !== "CreateSiloVault") throw new Error("FACTORY_LOG_EVENT_MISMATCH");
    const vault = safeAddress(decoded.args.SiloVault), asset = safeAddress(decoded.args.asset); if (!vault || !asset) throw new Error("FACTORY_LOG_ADDRESS_DECODE_FAILED");
    vaults.push({ vault, assetAtCreation: asset, blockNumber: log.blockNumber });
  }
  return vaults;
}
function localDeploymentBlock(chainId, factory) {
  const rel = path.join(TARGET, "broadcast", "MainnetDeploy.s.sol", String(chainId), "run-latest.json");
  if (!fs.existsSync(rel)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(rel, "utf8"));
    for (const receipt of data.receipts || []) if (lower(receipt.contractAddress || "") === lower(factory)) { const parsed = canonicalQuantity(lower(receipt.blockNumber)); if (parsed != null) return parsed; }
  } catch {}
  return null;
}
async function scanHistoryCandidate(row, factory, first, high) {
  const span = high - first + 1n, widths = [span, 5_000_000n, 2_000_000n, 1_000_000n, 500_000n, 250_000n, 100_000n, 50_000n, 10_000n].filter((x, i, a) => x > 0n && a.indexOf(x) === i);
  let width = null, calls = 0;
  for (const candidateWidth of widths) {
    if (++calls > LIMITS.logCallsPerChain) return null; const end = first + candidateWidth - 1n > high ? high : first + candidateWidth - 1n;
    const probe = await rpc(row, "eth_getLogs", [{ address: factory, fromBlock: quantity(first), toBlock: quantity(end), topics: [CREATE_TOPIC] }], 20000);
    if (probe.ok && Array.isArray(probe.result)) { const projected = Number((span + candidateWidth - 1n) / candidateWidth); if (projected <= LIMITS.logCallsPerChain) { width = candidateWidth; break; } }
  }
  if (width == null) return null;
  const logs = []; let cursor = first;
  while (cursor <= high) {
    if (++calls > LIMITS.logCallsPerChain) return null; const end = cursor + width - 1n > high ? high : cursor + width - 1n;
    const result = await rpc(row, "eth_getLogs", [{ address: factory, fromBlock: quantity(cursor), toBlock: quantity(end), topics: [CREATE_TOPIC] }], 20000);
    if (!result.ok || !Array.isArray(result.result)) return null; logs.push(...result.result); cursor = end + 1n;
  }
  return { logs, calls, width };
}
async function factoryHistory(pin, factory) {
  const localBlock = localDeploymentBlock(pin.chainId, factory), first = localBlock ?? await firstCodeBlock(pin.selected[0].row, factory, pin.number); let scanned = null, familyIndex = -1;
  for (let i = 0; i < pin.historyCandidates.length; i++) { scanned = await scanHistoryCandidate(pin.historyCandidates[i].row, factory, first, pin.number); if (scanned) { familyIndex = i; break; } }
  if (!scanned) throw new Error("BOUNDED_HISTORY_UNAVAILABLE");
  const normalized = normalizeLogs(scanned.logs), vaults = parseFactoryLogsStrict(normalized, factory);
  const unique = [...new Map(vaults.map(x => [lower(x.vault), x])).values()]; if (unique.length > LIMITS.vaultsPerChain) throw new Error("VAULT_CAP");
  return { firstCodeBlock: first.toString(), lowerBoundSource: localBlock == null ? "binary-code-search" : "checked-in-broadcast-receipt", calls: scanned.calls, chunkWidthBlocks: scanned.width.toString(), selectedHistoryCandidateIndex: familyIndex, rows: normalized.length, digest: sha256(canon(normalized)), singleFamily: true, vaults: unique };
}
function implementationAddress(word) { return /^0x[0-9a-f]{64}$/.test(word || "") && !/^0x0{64}$/.test(word) ? safeAddress(`0x${word.slice(-40)}`) : null; }
async function runtime(pin, address, localRuntime = null) {
  const code = await agreedRaw(pin, "eth_getCode", [address, pin.tag]);
  const slotObservation = classifySlotObservation(await observedRaw(pin, "eth_getStorageAt", [address, IMPL_SLOT, pin.tag]), pin.selected.length);
  const localExact = typeof localRuntime === "string" && /^0x[0-9a-f]+$/i.test(localRuntime) ? lower(code) === lower(localRuntime) : null;
  return { codeBytes: (code.length - 2) / 2, codeKeccak256: ethers.keccak256(code), eip1967ImplementationSlot: slotObservation, directRuntimeExactLocalDeploymentArtifact: localExact, proxyDetected: slotObservation.proxyDetected };
}
async function optional(callPromise, fallback = null) { try { return await callPromise; } catch { return fallback; } }
async function marketState(pin, vault, allocator, market, asset) {
  const cfg = await call(pin, vault, IFACE.vault, "config", [market]), tracker = await call(pin, vault, IFACE.vault, "balanceTracker", [market]), threshold = await call(pin, vault, IFACE.vault, "arbitraryLossThreshold", [market]), caps = await call(pin, allocator, IFACE.allocator, "flowCaps", [vault, market]);
  const marketAsset = await call(pin, market, IFACE.market, "asset"), totalAssets = await call(pin, market, IFACE.market, "totalAssets"), totalSupply = await call(pin, market, IFACE.market, "totalSupply"), vaultShares = await call(pin, market, IFACE.market, "balanceOf", [vault]);
  const expected = await call(pin, market, IFACE.market, "convertToAssets", [vaultShares[0]]), maxWithdraw = await optional(call(pin, market, IFACE.market, "maxWithdraw", [vault]), null), maxDeposit = await optional(call(pin, market, IFACE.market, "maxDeposit", [SYNTHETIC]), null), decimals = await optional(call(pin, market, IFACE.market, "decimals"), null), symbol = await optional(call(pin, market, IFACE.market, "symbol"), null);
  const underlyingBalance = lower(marketAsset[0]) === lower(asset) ? await optional(call(pin, asset, IFACE.token, "balanceOf", [market]), null) : null;
  const cap = BigInt(cfg.cap), balance = BigInt(tracker[0]), supplied = BigInt(expected[0]), supply = BigInt(totalSupply[0]), ownShares = BigInt(vaultShares[0]);
  return { market, runtime: await runtime(pin, market), asset: safeAddress(marketAsset[0]), assetMatchesVault: lower(marketAsset[0]) === lower(asset), symbol: symbol ? String(symbol[0]).slice(0, 64) : null, decimals: decimals ? Number(decimals[0]) : null,
    config: { capRaw: cap.toString(), enabled: Boolean(cfg.enabled), removableAt: BigInt(cfg.removableAt).toString() }, arbitraryLossThresholdRaw: BigInt(threshold[0]).toString(), effectiveLossThresholdRaw: (BigInt(threshold[0]) === 0n ? 1_000_000n : BigInt(threshold[0])).toString(), balanceTrackerRaw: balance.toString(),
    flowCaps: { maxInRaw: BigInt(caps.maxIn).toString(), maxOutRaw: BigInt(caps.maxOut).toString() }, totalAssetsRaw: BigInt(totalAssets[0]).toString(), totalSupplyRaw: supply.toString(), vaultSharesRaw: ownShares.toString(), expectedVaultSupplyAssetsRaw: supplied.toString(), maxWithdrawVaultRaw: maxWithdraw ? BigInt(maxWithdraw[0]).toString() : null, freshReceiverMaxDepositRaw: maxDeposit ? BigInt(maxDeposit[0]).toString() : null,
    nonVaultSharesRaw: (supply > ownShares ? supply - ownShares : 0n).toString(), ordinaryCapHeadroomRaw: (cap > supplied ? cap - supplied : 0n).toString(), trackerHeadroomRaw: (cap > balance ? cap - balance : 0n).toString(), underlyingBalanceAtMarketRaw: underlyingBalance ? BigInt(underlyingBalance[0]).toString() : null,
    donationSensitivityEstablished: false, directShareEntryEstablished: false, incompatibleSupplySemanticsEstablished: false };
}
function pairCandidates(vault) {
  const rows = [];
  for (const source of vault.markets) for (const destination of vault.markets) {
    if (lower(source.market) === lower(destination.market)) continue;
    const amount = [BigInt(source.expectedVaultSupplyAssetsRaw), BigInt(source.flowCaps.maxOutRaw), BigInt(destination.flowCaps.maxInRaw), BigInt(destination.ordinaryCapHeadroomRaw), BigInt(destination.trackerHeadroomRaw)].reduce((a, b) => a < b ? a : b);
    if (!vault.authorization?.publicAllocatorAuthorized || !source.config.enabled || !destination.config.enabled || !source.assetMatchesVault || !destination.assetMatchesVault || amount === 0n) continue;
    rows.push({ source: source.market, destination: destination.market, maximumFirstForwardMoveRaw: amount.toString(), effectivePerSupplyThresholdRaw: destination.effectiveLossThresholdRaw, sourceLiquidityRaw: source.maxWithdrawVaultRaw, destinationNonVaultSharesRaw: destination.nonVaultSharesRaw,
      structuralFlowAndCapacityPrerequisites: true, incumbentDestinationSharesObserved: BigInt(destination.nonVaultSharesRaw) > 0n, directShareEntryEstablished: false, donationSensitivityEstablished: false, exactRepeatableLossEstablished: false, exactGrossCaptureRaw: null, exactGasUnits: null, exactNetEconomics: null, routePositive: false });
  }
  return rows;
}
function requiredVaultStateComplete(vault) {
  return Boolean(vault && vault.factoryAuthenticated === true && safeAddress(vault.vault) && safeAddress(vault.owner) && safeAddress(vault.curator) && vault.authorization && typeof vault.authorization.isAllocatorMapping === "boolean" && typeof vault.authorization.ownerEqualsAllocator === "boolean" && typeof vault.authorization.curatorEqualsAllocator === "boolean" && typeof vault.authorization.publicAllocatorAuthorized === "boolean" && typeof vault.totalAssetsRaw === "string" && vault.queueLengths && Number.isSafeInteger(vault.queueLengths.supply) && Number.isSafeInteger(vault.queueLengths.withdraw) && Array.isArray(vault.markets) && Array.isArray(vault.pairCandidates));
}
function evaluateAuthenticatedVaults(vaults) {
  const authenticated = (vaults || []).filter(v => v?.factoryAuthenticated === true), incomplete = authenticated.filter(v => !requiredVaultStateComplete(v));
  return { authenticatedVaults: authenticated.length, incompleteRequiredStateVaults: incomplete.length, chainBlocked: incomplete.length > 0 };
}
async function vaultState(pin, row, allocator) {
  const v = row.vault, [asset, owner, curator, guardian, totalAssets, totalSupply, threshold, granted, sql, wql, admin, fee, accrued] = await Promise.all([
    call(pin, v, IFACE.vault, "asset"), call(pin, v, IFACE.vault, "owner"), call(pin, v, IFACE.vault, "curator"), call(pin, v, IFACE.vault, "guardian"), call(pin, v, IFACE.vault, "totalAssets"), call(pin, v, IFACE.vault, "totalSupply"), call(pin, v, IFACE.vault, "DEFAULT_LOST_THRESHOLD"), call(pin, v, IFACE.vault, "isAllocator", [allocator]), call(pin, v, IFACE.vault, "supplyQueueLength"), call(pin, v, IFACE.vault, "withdrawQueueLength"), call(pin, allocator, IFACE.allocator, "admin", [v]), call(pin, allocator, IFACE.allocator, "fee", [v]), call(pin, allocator, IFACE.allocator, "accruedFee", [v])
  ]);
  const lengths = [Number(sql[0]), Number(wql[0])]; if (lengths.some(x => !Number.isSafeInteger(x) || x > LIMITS.marketsPerVault)) throw new Error("MARKET_CAP");
  const markets = new Map(); for (let kind = 0; kind < 2; kind++) for (let i = 0; i < lengths[kind]; i++) { const q = await call(pin, v, IFACE.vault, kind ? "withdrawQueue" : "supplyQueue", [i]); const a = safeAddress(q[0]); if (a) markets.set(lower(a), a); }
  const assetAddress = safeAddress(asset[0]), tokenDecimals = await optional(call(pin, assetAddress, IFACE.token, "decimals"), null), tokenSymbol = await optional(call(pin, assetAddress, IFACE.token, "symbol"), null), marketRows = [];
  for (const market of markets.values()) marketRows.push(await marketState(pin, v, allocator, market, assetAddress));
  const ownerAddress = safeAddress(owner[0]), curatorAddress = safeAddress(curator[0]);
  const out = { vault: v, factoryAuthenticated: true, creationBlock: row.blockNumber, runtime: await runtime(pin, v), asset: assetAddress, assetDecimals: tokenDecimals ? Number(tokenDecimals[0]) : null, assetSymbol: tokenSymbol ? String(tokenSymbol[0]).slice(0, 64) : null, owner: ownerAddress, curator: curatorAddress, guardian: safeAddress(guardian[0]), totalAssetsRaw: BigInt(totalAssets[0]).toString(), totalSupplyRaw: BigInt(totalSupply[0]).toString(), defaultLostThresholdRaw: BigInt(threshold[0]).toString(), authorization: publicAllocatorAuthorization(Boolean(granted[0]), ownerAddress, curatorAddress, allocator), publicAllocator: { admin: safeAddress(admin[0]), feeWeiPerCall: BigInt(fee[0]).toString(), accruedFeeWei: BigInt(accrued[0]).toString(), requiredFeeWeiFor32Calls: (32n * BigInt(fee[0])).toString() }, queueLengths: { supply: lengths[0], withdraw: lengths[1] }, markets: marketRows };
  out.pairCandidates = pairCandidates(out); out.requiredStateComplete = requiredVaultStateComplete(out); return out;
}
async function terminal(pin) {
  const rows = []; for (const item of pin.selected) { const [same, fin] = await Promise.all([rpc(item.row, "eth_getBlockByNumber", [pin.tag, false]), rpc(item.row, "eth_getBlockByNumber", ["finalized", false])]); const sh = same.ok ? strictHeader(same.result, pin.number) : null, fh = fin.ok ? strictHeader(fin.result) : null; rows.push({ sameHash: sh ? sh.hash === pin.hash : null, finalizedAtOrAbove: fh ? fh.number >= pin.number : null }); }
  return rows;
}
async function captureChain(def, candidates) {
  const [chainId, folder] = def, allocatorArtifact = deployment(folder, "PublicAllocator"), factoryArtifact = deployment(folder, "SiloVaultsFactory"), addresses = { allocator: allocatorArtifact.address, factory: factoryArtifact.address };
  if (!candidates?.length) return { chainId, chain: folder, status: "BLOCKED_NO_ENDPOINT", endpointCoverage: { qualifiedFamilies: 0 }, vaults: [], pairCandidates: [] };
  const pin = await selectPin(chainId, candidates, addresses); if (!pin.ok) return { chainId, chain: folder, status: `BLOCKED_${pin.blocker}`, endpointCoverage: { qualifiedFamilies: candidates.length }, vaults: [], pairCandidates: [] };
  try {
    const allocatorRuntime = await runtime(pin, addresses.allocator, allocatorArtifact.deployedBytecode), factoryRuntime = await runtime(pin, addresses.factory), version = await call(pin, addresses.factory, IFACE.factory, "VERSION"), history = await factoryHistory(pin, addresses.factory), vaults = [];
    for (const row of history.vaults) { const authentic = await call(pin, addresses.factory, IFACE.factory, "isSiloVault", [row.vault]); if (authentic[0] !== true) throw new Error("FACTORY_VAULT_AUTHENTICATION_FAILED"); const state = await vaultState(pin, row, addresses.allocator); if (!state.requiredStateComplete) throw new Error("AUTHENTICATED_VAULT_REQUIRED_STATE_INCOMPLETE"); vaults.push(state); }
    if (evaluateAuthenticatedVaults(vaults).chainBlocked) throw new Error("AUTHENTICATED_VAULT_REQUIRED_STATE_INCOMPLETE");
    const terminalRows = await terminal(pin); if (!terminalRows.every(x => x.sameHash === true && x.finalizedAtOrAbove === true)) throw new Error("TERMINAL_RECHECK_FAILED");
    const pairs = vaults.flatMap(v => (v.pairCandidates || []).map(p => ({ vault: v.vault, asset: v.asset, assetDecimals: v.assetDecimals, assetSymbol: v.assetSymbol, feeWeiPerCall: v.publicAllocator?.feeWeiPerCall || null, requiredFeeWeiFor32Calls: v.publicAllocator?.requiredFeeWeiFor32Calls || null, ...p })));
    return { chainId, chain: folder, status: "CAPTURED", pin: { number: pin.number.toString(), hash: pin.hash, timestamp: pin.timestamp.toString(), baseFeePerGasWei: pin.baseFeePerGas?.toString() || null, terminalRecheck: terminalRows }, endpointCoverage: { qualifiedFamilies: candidates.length, reportedFinalizedFamilies: pin.reportedFinalizedFamilies, selectedStateFamilies: pin.selected.length, familyIds: pin.selected.map(x => x.row.family), hostnameDerivedCapabilityGroupsOnly: true, backendOperatorIndependenceEstablished: false }, deployments: { publicAllocator: addresses.allocator, publicAllocatorRuntime: allocatorRuntime, factory: addresses.factory, factoryVersion: String(version[0]), factoryRuntime }, history: { firstCodeBlock: history.firstCodeBlock, lowerBoundSource: history.lowerBoundSource, calls: history.calls, chunkWidthBlocks: history.chunkWidthBlocks, eventRows: history.rows, digest: history.digest, singleFamily: true }, vaults, pairCandidates: pairs };
  } catch (error) { return { chainId, chain: folder, status: "BLOCKED_CAPTURE_INCOMPLETE", blocker: error.message, pin: { number: pin.number.toString(), hash: pin.hash }, endpointCoverage: { qualifiedFamilies: candidates.length, selectedStateFamilies: pin.selected.length }, vaults: [], pairCandidates: [] }; }
}
function leakGuard(label, text) {
  if (/(?:https?|wss?):\/\//i.test(text) || /"(?:url|headers|apiKey|token|rawResponse|responseBody)"\s*:/i.test(text)) fail(`${label}_FORBIDDEN_ENDPOINT_FIELD`);
  const low = lower(text); for (const secret of secrets) if (low.includes(secret)) fail(`${label}_ENDPOINT_MATERIAL_LEAK`);
}
function report(raw) {
  const rows = raw.chains.map(c => `| ${c.chain} (${c.chainId}) | ${c.status} | ${c.endpointCoverage?.selectedStateFamilies || 0} | ${c.vaults?.length || 0} | ${c.pairCandidates?.length || 0} |`).join("\n");
  const candidates = raw.candidates.length ? raw.candidates.map(c => `| ${c.chain} | \`${c.vault}\` | ${c.assetSymbol || c.asset} | \`${c.source}\` | \`${c.destination}\` | ${c.maximumFirstForwardMoveRaw} | ${c.requiredFeeWeiFor32Calls} |`).join("\n") : "| none | none | none | none | none | 0 | 0 |";
  return `# 🟠 WATCH — Silo V3 PublicAllocator deployment/economics Step 2\n\n**Classification:** \`${raw.classification}\`  \n**Operational gates:** routePositive=\`0\`, executableNow=\`0\`, signedActionJustified=\`false\`, fork=\`false\`.\n\n## Result\n\nThis bounded read-only capture checked the checked-in PublicAllocator/factory deployments on 13 chains. It found **${raw.summary.capturedChains}** captured chains, **${raw.summary.vaults}** factory-authenticated vault rows, **${raw.summary.allocatorGrantedVaults}** vaults granting the checked-in PublicAllocator, and **${raw.summary.structuralPairCandidates}** source/destination pairs with nonzero first-forward flow/capacity prerequisites.\n\nA structural pair is not route-positive. Direct destination-share entry, donation sensitivity, exact repeated loss, complete attacker cashflows, gas units, asset/native pricing, capital cost, and exit liquidity are not established by these state reads. No live reallocation or gas-estimation simulation was called. PA-R2-02 remains unbound because no deployed market was behaviorally shown to under-pull assets or misdirect shares.\n\n| chain | status | state families | vault rows | structural pairs |\n|---|---|---:|---:|---:|\n${rows}\n\n## Structural WATCH pairs\n\n| chain | vault | asset | source | destination | max first move raw | 32-call allocator fee wei |\n|---|---|---|---|---|---:|---:|\n${candidates}\n\n## Evidence and limits\n\n- Fixed pins use strict canonical headers and terminal same-number/finality rechecks on captured chains. Anonymous hostname-derived family IDs are capability groupings only; backend/operator independence is not claimed.\n- Factory history is bounded single-family evidence and is explicitly labeled as such. Current state is read across up to two agreeing families. Missing endpoint or historical-log coverage remains BLOCKED, never route-negative.\n- Exact local runtime equality is assessed for the direct PublicAllocator artifact. EIP-1967 slots are checked on allocator, factory, vaults, and markets; a zero slot is not itself proof of source identity.\n- The Step 1 local route used 32 calls. Each vault row records \`32 × configured allocator fee\`; base fee is retained only as context because exact gas units and native-to-asset conversion are unresolved.\n- No endpoint/provider identity, endpoint material, headers, raw responses, private identity, key, signing, transaction, broadcast, state override, production mutation, or fork is persisted or used.\n\n## Defensive disposition\n\nKeep the local Certora I-01 reproduction as WATCH. Do not fork or promote operational route-positive unless a candidate separately proves public share entry, donation-sensitive exact market semantics, repeated loss at the fixed state, full entry/exit cashflows, and positive net after allocator fees, gas, pricing, slippage, and capital cost. Mitigate with decimal-normalized relative loss limits and a cumulative public-loss budget.\n`;
}
async function main() {
  if (!process.argv.includes("--capture")) fail("CAPTURE_REQUIRES_EXPLICIT_FLAG"); const chainDefinitionValidation = validateExpectedChains(); budget = { attempted: 0, succeeded: 0, failed: 0, byMethod: {} };
  const rows = inventory(), qualification = await qualify(rows), chains = [];
  for (const def of CHAIN_INPUTS) { process.stderr.write(`Silo PublicAllocator Step2: sanitized chain ${def[0]}\n`); chains.push(await captureChain(def, qualification.byChain.get(def[0]) || [])); }
  const candidates = chains.flatMap(c => (c.pairCandidates || []).map(x => ({ chain: c.chain, chainId: c.chainId, ...x }))), vaults = chains.flatMap(c => c.vaults || []), authorized = vaults.filter(v => v.authorization?.publicAllocatorAuthorized === true).length;
  const raw = { schemaVersion: 2, findingId: NAME, runId: `${NAME}-${new Date().toISOString().replace(/[:.]/g, "-")}`, generatedAt: new Date().toISOString(), classification: candidates.length ? "WATCH/DEPLOYMENT-BOUND/STRUCTURAL-PAIR-CANDIDATES/SEMANTICS-AND-NET-ECONOMICS-UNRESOLVED" : "WATCH/DEPLOYMENT-COVERAGE-PARTIAL/NO-STRUCTURAL-PAIR-OBSERVED/SEMANTICS-AND-NET-ECONOMICS-UNRESOLVED", gates: { routePositive: false, executableNow: false, signedActionJustified: false, fork: false }, chainDefinitionValidation, summary: { inventoryCandidatesParsed: qualification.parsed, parseableChainResponses: qualification.parseable, capturedChains: chains.filter(c => c.status === "CAPTURED").length, blockedChains: chains.filter(c => c.status !== "CAPTURED").length, vaults: vaults.length, publicAllocatorAuthorizedVaults: authorized, structuralPairCandidates: candidates.length }, chains, candidates, economics: { exactGrossCaptureEstablished: false, exactGasUnitsEstablished: false, nativeAssetPriceEstablished: false, capitalCostEstablished: false, exitEstablished: false, exactNetEstablished: false }, paR202: { deployedIncompatibleMarketEstablished: false, behavioralSupplySimulationPerformed: false }, safety: { inventoriesReadInMemoryOnly: true, endpointMaterialPersisted: false, providerIdentitiesPersisted: false, rawResponsesPersisted: false, privateIdentityPersisted: false, signedTransactions: false, broadcast: false, stateMutation: false, stateOverride: false, liveReallocationCall: false, gasEstimateCall: false, fork: false }, rpcBudget: { ...budget, cap: LIMITS.rpcCalls }, nextAction: candidates.length ? "Independently review candidate semantics and complete offline gas/cashflow economics before proposing any bounded fork." : "Close listed endpoint/history coverage gaps or monitor for a vault with PublicAllocator authorization and nonzero bidirectional structural capacity." };
  const rawText = `${JSON.stringify(raw, null, 2)}\n`, reportText = report(raw); leakGuard("RAW", rawText); leakGuard("REPORT", reportText);
  fs.writeFileSync(RAW, rawText); fs.writeFileSync(REPORT, reportText); process.stdout.write(`${JSON.stringify({ status: "PASS", classification: raw.classification, capturedChains: raw.summary.capturedChains, vaults: raw.summary.vaults, candidates: raw.summary.structuralPairCandidates, rpcCalls: budget.attempted })}\n`);
}

if (require.main === module) main().catch(error => { process.stderr.write(`Silo PublicAllocator Step2 stopped: ${error.code || error.message}\n`); process.exitCode = 1; });
module.exports = { canonicalQuantity, strictHeader, validateExpectedChains, publicAllocatorAuthorization, classifySlotObservation, opaqueFamily, parseInventoryText, parseFactoryLogsStrict, implementationAddress, requiredVaultStateComplete, evaluateAuthenticatedVaults, pairCandidates, leakGuard, IFACE, CREATE_TOPIC };
