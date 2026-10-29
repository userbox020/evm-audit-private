#!/usr/bin/env node
"use strict";

// Authorized, bounded, read-only Ethereum capture. Endpoint material and raw RPC
// responses remain in memory. Only public contract/event/state facts are written.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");
const { getOrigin } = require("./shared-rpc");

const ROOT = path.resolve(__dirname, "..");
const INVENTORY = path.join(ROOT, "rpc_endpoints.txt");
const RAW = path.join(ROOT, "reports", "raw", "fast", "critical-yearn-v3-tokenized-strategy-accounting-step2.json");
const REPORT = path.join(ROOT, "reports", "critical-yearn-v3-tokenized-strategy-accounting-step2.md");
const HANDOFF = path.join(ROOT, "coordination", "handoffs", "2026-07-27-critical-yearn-v3-step2.md");
const INBOX = path.join(ROOT, "coordination", "inbox", "critical", "yearn-v3-tokenized-strategy-accounting-step2.json");
const NAME = "critical-yearn-v3-tokenized-strategy-accounting-step2";
const AGENT = "critical-yearn-v3-step2-20260727";
const CHAIN_ID = 1n;
const MAX_RPC = 8_000;
const MAX_ENDPOINT_PROBES = 256;
const MAX_FACTORIES = 16;
const MAX_VAULTS = 2_000;
const MAX_PAIRS = 2_000;
const INITIAL_LOG_CHUNK = 1_000_000;
const MIN_LOG_CHUNK = 2_000;
const STRATEGY_START_BLOCK = 20_823_293;
const ZERO = "0x0000000000000000000000000000000000000000";
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ATTACKER = "0x1111111111111111111111111111111111111111";

const ADDR = Object.freeze({
  registry: "0xd40ecF29e001c76Dcc4cC0D9cd50520CE845B038",
  legacyRegistry: "0xff31A1B020c868F6eA3f61Eb953344920EeCA3af",
  addressProvider: "0x775F09d6f3c8D2182DFA8bce8628acf51105653c",
  releaseRegistry: "0x0377b4daDDA86C89A0091772B79ba67d0E5F7198",
  legacyReleaseRegistry: "0x990089173D5d5287c344092Be0bB37950A67d17B",
  factory303: "0x5577EdcB8A856582297CdBbB07055E6a6E38eb5f",
  factory310: "0x310aC28ACF5E514abDbFF9Ab25e21f1bfe22bcAC",
  tokenizedStrategy303: "0x254A93feff3BEeF9cA004E913bB5443754e8aB19",
  daiPot: "0x197E90f9FAD81970bA7976f33CbD77088E5D7cf7"
});

const ABI = Object.freeze({
  registry: new ethers.Interface([
    "function getAllEndorsedVaults() view returns(address[][])",
    "function releaseRegistry() view returns(address)",
    "function isEndorsed(address) view returns(bool)",
    "function isLegacyVault(address) view returns(bool)"
  ]),
  provider: new ethers.Interface([
    "function getReleaseRegistry() view returns(address)",
    "function getReplacement() view returns(address)",
    "function governance() view returns(address)"
  ]),
  releases: new ethers.Interface([
    "function numReleases() view returns(uint256)",
    "function factories(uint256) view returns(address)",
    "function tokenizedStrategies(uint256) view returns(address)",
    "function latestFactory() view returns(address)",
    "function latestRelease() view returns(string)"
  ]),
  factory: new ethers.Interface([
    "function apiVersion() view returns(string)",
    "function vault_original() view returns(address)",
    "function shutdown() view returns(bool)",
    "function protocol_fee_config(address) view returns(uint16,address)",
    "event NewVault(address indexed vault_address,address indexed asset)"
  ]),
  vault: new ethers.Interface([
    "function apiVersion() view returns(string)",
    "function FACTORY() view returns(address)",
    "function asset() view returns(address)",
    "function isShutdown() view returns(bool)",
    "function totalAssets() view returns(uint256)",
    "function totalSupply() view returns(uint256)",
    "function profitMaxUnlockTime() view returns(uint256)",
    "function strategies(address) view returns(uint256 activation,uint256 lastReport,uint256 currentDebt,uint256 maxDebt)",
    "event StrategyChanged(address indexed strategy,uint256 indexed change_type)",
    "event StrategyReported(address indexed strategy,uint256 gain,uint256 loss,uint256 current_debt,uint256 protocol_fees,uint256 total_fees,uint256 total_refunds)"
  ]),
  strategy: new ethers.Interface([
    "function apiVersion() view returns(string)",
    "function tokenizedStrategyAddress() view returns(address)",
    "function FACTORY() view returns(address)",
    "function asset() view returns(address)",
    "function isShutdown() view returns(bool)",
    "function totalAssets() view returns(uint256)",
    "function totalSupply() view returns(uint256)",
    "function balanceOf(address) view returns(uint256)",
    "function maxDeposit(address) view returns(uint256)",
    "function lastReport() view returns(uint256)",
    "function profitMaxUnlockTime() view returns(uint256)",
    "function fullProfitUnlockDate() view returns(uint256)",
    "function management() view returns(address)",
    "function keeper() view returns(address)",
    "function performanceFee() view returns(uint16)",
    "function report() returns(uint256 profit,uint256 loss)",
    "event NewTokenizedStrategy(address indexed strategy,address indexed asset,string apiVersion)",
    "event Reported(uint256 profit,uint256 loss,uint256 protocolFees,uint256 performanceFees)"
  ]),
  pot: new ethers.Interface([
    "function dsr() view returns(uint256)",
    "function chi() view returns(uint256)",
    "function rho() view returns(uint256)",
    "function live() view returns(uint256)"
  ])
});

const TOPIC = Object.freeze({
  newVault: ABI.factory.getEvent("NewVault").topicHash,
  strategyChanged: ABI.vault.getEvent("StrategyChanged").topicHash,
  newStrategy: ABI.strategy.getEvent("NewTokenizedStrategy").topicHash,
  reported: ABI.strategy.getEvent("Reported").topicHash
});

class Stop extends Error { constructor(code) { super(code); this.code = code; } }
const fail = code => { throw new Stop(code); };
const lower = value => String(value).toLowerCase();
const hex = value => ethers.toQuantity(BigInt(value));
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function grossCapture(assets, attackerDeposit, profit, performanceFeeBps) { const A = BigInt(assets), x = BigInt(attackerDeposit), p = BigInt(profit), fee = p * BigInt(performanceFeeBps) / 10_000n, denominator = A + x + fee; return denominator === 0n ? 0n : x * (p - fee) / denominator; }
function rmul(x, y, base = 10n ** 27n) { return (x * y + base / 2n) / base; }
function rpow(x, n, base = 10n ** 27n) { let z = n % 2n ? x : base; for (n /= 2n; n > 0n; n /= 2n) { x = rmul(x, x, base); if (n % 2n) z = rmul(z, x, base); } return z; }
function fixedRatio(numerator, denominator, decimals) { const scale = 10n ** BigInt(decimals), q = BigInt(numerator) * scale / BigInt(denominator), s = q.toString().padStart(decimals + 1, "0"); return `${s.slice(0, -decimals)}.${s.slice(-decimals)}`; }
function terminalRowsExactlyTrue(rows, expected) { return Array.isArray(rows) && rows.length === expected && rows.every(row => row && row.sameHash === true && row.finalizedAtOrAbove === true); }
function canon(value) {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canon(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function publicAddress(value) { return ethers.getAddress(value); }
function topicAddress(value) { return publicAddress(`0x${String(value).slice(-40)}`); }
function jsonSafe(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonSafe(v)]));
  return value;
}
function familyKey(url) {
  const parts = new URL(url).hostname.toLowerCase().split(".").filter(Boolean);
  return parts.length <= 2 ? parts.join(".") : `${parts.at(-2)}.${parts.at(-1)}`;
}
function parseInventory(text) {
  const lines = String(text).replace(/\\\//g, "/").split(/\r?\n/), byUrl = new Map();
  for (let index = 0; index < lines.length; index++) {
    for (const match of lines[index].matchAll(/https?:\/\/[^\s"'`<>{}\[\]]+/gi)) {
      const raw = match[0].replace(/[)>`,.;\]]+$/g, ""); let parsed;
      try { parsed = new URL(raw); } catch { continue; }
      const context = lines.slice(Math.max(0, index - 3), Math.min(lines.length, index + 4)).join("\n"), headers = {};
      for (const h of context.matchAll(/\[header:\s*([^=\]\s]+)=([^\]]+)\]/gi)) headers[h[1].trim()] = h[2].trim();
      const origin = context.match(/\[origin:\s*([^\]\s]+)\]/i)?.[1] || getOrigin(parsed.href); if (origin) headers.origin = origin;
      if (!byUrl.has(parsed.href)) byUrl.set(parsed.href, { url: parsed.href, headers, family: familyKey(parsed.href) });
    }
  }
  return [...byUrl.values()];
}
function secretsFrom(records) {
  const out = new Set();
  for (const row of records) {
    out.add(lower(row.url)); const parsed = new URL(row.url); out.add(lower(parsed.hostname));
    for (const v of Object.values(row.headers)) if (String(v).length >= 4) out.add(lower(v));
    for (const v of parsed.searchParams.values()) if (v.length >= 6) out.add(lower(v));
    for (const v of parsed.pathname.split("/")) if (v.length >= 12) out.add(lower(v));
  }
  return [...out].filter(x => x.length >= 4);
}

const budget = { cap: MAX_RPC, attempted: 0, succeeded: 0, failed: 0, byMethod: {}, logCalls: 0 };
async function rpc(row, method, params, timeoutMs = 12_000, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (++budget.attempted > budget.cap) fail("RPC_BUDGET_EXCEEDED");
    budget.byMethod[method] = (budget.byMethod[method] || 0) + 1; if (method === "eth_getLogs") budget.logCalls++;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(row.url, { method: "POST", headers: { "content-type": "application/json", ...row.headers }, body: JSON.stringify({ jsonrpc: "2.0", id: budget.attempted, method, params }), signal: controller.signal });
      if (!response.ok) throw new Error("HTTP"); const body = await response.json();
      if (body.error || body.result === undefined || body.result === null) throw new Error("RPC");
      budget.succeeded++; return body.result;
    } catch (_) { budget.failed++; if (attempt === retries) throw new Stop("RPC_CALL_FAILED"); await sleep(500 * (attempt + 1)); }
    finally { clearTimeout(timer); }
  }
}
async function maybeRpc(row, method, params, timeoutMs = 12_000) { try { return await rpc(row, method, params, timeoutMs, 0); } catch { return null; } }
async function mapLimit(items, limit, worker) {
  const out = new Array(items.length); let cursor = 0;
  async function run() { while (true) { const index = cursor++; if (index >= items.length) return; out[index] = await worker(items[index], index); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run)); return out;
}
function compareRpc(method, value) {
  if (method === "eth_getBlockByNumber") return canon({ number: lower(value.number), hash: lower(value.hash), timestamp: lower(value.timestamp), baseFeePerGas: lower(value.baseFeePerGas || "0x0") });
  return lower(value);
}
async function consensus(rows, method, params, timeoutMs = 12_000) {
  const values = []; for (const row of rows) values.push(await rpc(row, method, params, timeoutMs));
  if (values.some(value => compareRpc(method, value) !== compareRpc(method, values[0]))) fail(`CONSENSUS_${method.toUpperCase()}_MISMATCH`);
  return values[0];
}
async function call(rows, target, iface, method, args, blockTag) {
  const data = iface.encodeFunctionData(method, args), raw = await consensus(rows, "eth_call", [{ to: target, data }, blockTag], 20_000);
  return iface.decodeFunctionResult(method, raw);
}
async function maybeCall(row, target, iface, method, args, blockTag, from) {
  const tx = { to: target, data: iface.encodeFunctionData(method, args) }; if (from) tx.from = from;
  const raw = await maybeRpc(row, "eth_call", [tx, blockTag], 30_000); if (!raw) return null;
  try { return iface.decodeFunctionResult(method, raw); } catch { return null; }
}

async function qualify(records) {
  const candidates = [], used = new Set(), diagnostics = { chain: 0, finalized: 0, currentCode: 0, historicalCode: 0, historicalLogs: 0, releaseCalls: 0 }; let probed = 0;
  for (const row of records) {
    if (probed++ >= MAX_ENDPOINT_PROBES || candidates.length >= 5) break;
    if (used.has(row.family)) continue;
    const chain = await maybeRpc(row, "eth_chainId", [], 5_000); if (!chain || BigInt(chain) !== CHAIN_ID) continue; diagnostics.chain++;
    const finalized = await maybeRpc(row, "eth_getBlockByNumber", ["finalized", false], 8_000); if (!finalized?.number || !finalized?.hash || !finalized?.timestamp) continue; diagnostics.finalized++;
    const code = await maybeRpc(row, "eth_getCode", [ADDR.registry, finalized.number], 8_000); if (!code || code === "0x") continue; diagnostics.currentCode++;
    const historicalCode = await maybeRpc(row, "eth_getCode", [ADDR.tokenizedStrategy303, hex(STRATEGY_START_BLOCK)], 8_000); if (!historicalCode || historicalCode === "0x") continue; diagnostics.historicalCode++;
    const historicalLogs = await maybeRpc(row, "eth_getLogs", [{ address: ADDR.factory303, fromBlock: hex(20_822_382), toBlock: hex(20_872_381), topics: [TOPIC.newVault] }], 15_000), logCapable = Array.isArray(historicalLogs);
    if (logCapable) diagnostics.historicalLogs++;
    const currentReleaseCount = await maybeRpc(row, "eth_call", [{ to: ADDR.releaseRegistry, data: ABI.releases.encodeFunctionData("numReleases", []) }, finalized.number], 10_000);
    const legacyReleaseCount = await maybeRpc(row, "eth_call", [{ to: ADDR.legacyReleaseRegistry, data: ABI.releases.encodeFunctionData("numReleases", []) }, finalized.number], 10_000);
    if (!currentReleaseCount || !legacyReleaseCount) continue; diagnostics.releaseCalls++;
    candidates.push({ ...row, finalized, logCapable }); used.add(row.family);
  }
  if (candidates.length < 2) { process.stderr.write(`Yearn Step2 anonymous qualification counts: ${JSON.stringify(diagnostics)}\n`); fail("TWO_HOSTNAME_FAMILIES_UNAVAILABLE"); }
  const pinNumber = Math.min(...candidates.map(row => Number(BigInt(row.finalized.number)))), tag = hex(pinNumber), groups = new Map();
  for (const row of candidates) {
    const header = await maybeRpc(row, "eth_getBlockByNumber", [tag, false], 8_000); if (!header?.hash || Number(BigInt(header.number)) !== pinNumber) continue;
    const key = lower(header.hash), group = groups.get(key) || []; group.push({ ...row, header }); groups.set(key, group);
  }
  const best = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)[0]; if (!best || best[1].length < 2) fail("TWO_FAMILY_FINALIZED_PIN_UNAVAILABLE");
  const ordered = best[1].sort((a, b) => Number(b.logCapable) - Number(a.logCapable)), selected = ordered.slice(0, 2), historyRows = selected.filter(x => x.logCapable);
  if (!historyRows.length) fail("NO_BOUNDED_HISTORY_FAMILY_AVAILABLE");
  return { rows: selected, historyRows, pin: { number: pinNumber, tag, hash: best[0], timestamp: Number(BigInt(best[1][0].header.timestamp)), baseFeePerGasWei: BigInt(best[1][0].header.baseFeePerGas || 0).toString() }, probed, responsiveFamilies: candidates.length };
}

function normalizeLogs(logs) {
  return logs.map(log => ({ address: lower(log.address), blockNumber: Number(BigInt(log.blockNumber)), blockHash: lower(log.blockHash), transactionHash: lower(log.transactionHash), transactionIndex: Number(BigInt(log.transactionIndex)), logIndex: Number(BigInt(log.logIndex)), topics: log.topics.map(lower), data: lower(log.data) })).sort((a, b) => a.blockNumber - b.blockNumber || a.transactionIndex - b.transactionIndex || a.logIndex - b.logIndex);
}
async function logHistory(row, filter, from, to) {
  let calls = 0; const logs = [], ranges = []; for (let cursor = from; cursor <= to; cursor += 50_000) ranges.push({ from: cursor, to: Math.min(to, cursor + 49_999) });
  const results = await mapLimit(ranges, 4, async range => { for (let attempt = 0; attempt < 3; attempt++) { calls++; const result = await maybeRpc(row, "eth_getLogs", [{ ...filter, fromBlock: hex(range.from), toBlock: hex(range.to) }], 25_000); if (Array.isArray(result)) return result; await sleep(750 * (attempt + 1)); } return null; });
  if (results.some(result => !Array.isArray(result))) return { complete: false, failure: "FIFTY_THOUSAND_BLOCK_LOG_RANGE_UNAVAILABLE", calls, logs: [] };
  for (let i = 0; i < ranges.length; i++) { ranges[i].count = results[i].length; logs.push(...results[i]); }
  const normalized = normalizeLogs(logs); return { complete: true, failure: null, calls, ranges: ranges.length, logs: normalized, digest: sha(canon(normalized)) };
}
async function agreedHistory(rows, filter, from, to, label) {
  const histories = []; for (const row of rows) histories.push(await logHistory(row, filter, from, to));
  if (histories.some(x => !x.complete) || histories.some(x => x.digest !== histories[0].digest)) fail(`HISTORY_${label}_UNAVAILABLE_OR_MISMATCH`);
  return { from, to, rows: histories[0].logs.length, digest: histories[0].digest, callsByFamily: histories.map(x => x.calls), logs: histories[0].logs };
}
async function firstCodeBlock(row, address, high) {
  let lo = 0, hi = high; const atHigh = await rpc(row, "eth_getCode", [address, hex(hi)], 10_000); if (atHigh === "0x") fail("FACTORY_CODE_ABSENT_AT_PIN");
  while (lo < hi) { const mid = Math.floor((lo + hi) / 2), code = await rpc(row, "eth_getCode", [address, hex(mid)], 10_000); if (code === "0x") lo = mid + 1; else hi = mid; }
  return lo;
}
function semverTarget(version) { return /^3\.(?:0\.[1-9]\d*|[1-9]\d*\.\d+)$/.test(version); }

function flattenAddresses(decoded) {
  const output = [];
  for (const group of decoded[0]) for (const address of group) output.push(publicAddress(address));
  return [...new Map(output.map(address => [lower(address), address])).values()].sort((a, b) => lower(a).localeCompare(lower(b)));
}
async function registryState(rows, tag) {
  const current = flattenAddresses(await call(rows, ADDR.registry, ABI.registry, "getAllEndorsedVaults", [], tag));
  const legacy = flattenAddresses(await call(rows, ADDR.legacyRegistry, ABI.registry, "getAllEndorsedVaults", [], tag));
  const release = publicAddress((await call(rows, ADDR.registry, ABI.registry, "releaseRegistry", [], tag))[0]);
  const legacyRelease = publicAddress((await call(rows, ADDR.legacyRegistry, ABI.registry, "releaseRegistry", [], tag))[0]);
  const providerRelease = publicAddress((await call(rows, ADDR.addressProvider, ABI.provider, "getReleaseRegistry", [], tag))[0]);
  const replacement = publicAddress((await call(rows, ADDR.addressProvider, ABI.provider, "getReplacement", [], tag))[0]);
  return { current, legacy, bindings: { currentReleaseRegistry: release, legacyReleaseRegistry: legacyRelease, addressProviderReleaseRegistry: providerRelease, addressProviderReplacement: replacement, expectedCurrentReleaseRegistry: ADDR.releaseRegistry, expectedLegacyReleaseRegistry: ADDR.legacyReleaseRegistry, releaseBindingsMatch: lower(release) === lower(ADDR.releaseRegistry) && lower(legacyRelease) === lower(ADDR.legacyReleaseRegistry) && lower(providerRelease) === lower(ADDR.releaseRegistry) } };
}
async function releases(rows, tag) {
  const out = [];
  for (const [kind, address] of [["current", ADDR.releaseRegistry], ["legacy", ADDR.legacyReleaseRegistry]]) {
    let count; try { count = Number((await call(rows, address, ABI.releases, "numReleases", [], tag))[0]); } catch { fail(`RELEASE_${kind.toUpperCase()}_COUNT_FAILED`); } if (count > MAX_FACTORIES) fail("FACTORY_COUNT_CAP");
    for (let i = 0; i < count; i++) {
      let factory; try { factory = publicAddress((await call(rows, address, ABI.releases, "factories", [i], tag))[0]); } catch { continue; }
      if (factory === ZERO) continue;
      let version; try { version = String((await call(rows, factory, ABI.factory, "apiVersion", [], tag))[0]); } catch { continue; }
      let original = null; try { original = publicAddress((await call(rows, factory, ABI.factory, "vault_original", [], tag))[0]); } catch {}
      let shutdown = null; try { shutdown = Boolean((await call(rows, factory, ABI.factory, "shutdown", [], tag))[0]); } catch {}
      let tokenizedStrategy = null; if (kind === "current") { try { const decoded = await call(rows, address, ABI.releases, "tokenizedStrategies", [i], tag); tokenizedStrategy = publicAddress(decoded[0]); } catch {} }
      out.push({ registry: kind, releaseId: i, factory, version, vaultOriginal: original, shutdown, tokenizedStrategy });
    }
  }
  for (const [version, factory] of [["3.0.3", ADDR.factory303], ["3.1.0", ADDR.factory310]]) if (!out.some(x => lower(x.factory) === lower(factory))) {
    let code; try { code = await consensus(rows, "eth_getCode", [factory, tag]); } catch { continue; } if (code === "0x") continue;
    let vaultOriginal = null, shutdown = null; try { vaultOriginal = publicAddress((await call(rows, factory, ABI.factory, "vault_original", [], tag))[0]); } catch {} try { shutdown = Boolean((await call(rows, factory, ABI.factory, "shutdown", [], tag))[0]); } catch {}
    out.push({ registry: "official-bootstrap", releaseId: null, factory: publicAddress(factory), version, vaultOriginal, shutdown, tokenizedStrategy: version === "3.0.3" ? publicAddress(ADDR.tokenizedStrategy303) : null });
  }
  return [...new Map(out.filter(x => semverTarget(x.version)).map(x => [lower(x.factory), x])).values()].sort((a, b) => a.version.localeCompare(b.version) || lower(a.factory).localeCompare(lower(b.factory)));
}

async function factoryVaultHistory(rows, factories, pinNumber) {
  const all = [], coverage = [], firstCodes = new Map();
  for (const factory of factories) firstCodes.set(lower(factory.factory), await firstCodeBlock(rows[0], factory.factory, pinNumber));
  const minimum = Math.min(...firstCodes.values()), history = await agreedHistory(rows, { topics: [TOPIC.newVault] }, minimum, pinNumber, "NEW_VAULT_GLOBAL_FILTERED");
  const factoryMap = new Map(factories.map(x => [lower(x.factory), x]));
  for (const log of history.logs) { const factory = factoryMap.get(log.address); if (!factory || log.topics.length < 3) continue; all.push({ vault: topicAddress(log.topics[1]), asset: topicAddress(log.topics[2]), factory: factory.factory, factoryVersion: factory.version, blockNumber: log.blockNumber, transactionHash: log.transactionHash, logIndex: log.logIndex }); }
  for (const factory of factories) { const selected = history.logs.filter(log => log.address === lower(factory.factory)); coverage.push({ factory: factory.factory, version: factory.version, firstCodeBlock: firstCodes.get(lower(factory.factory)), eventCount: selected.length, eventDigest: sha(canon(selected)), globalHistoryDigest: history.digest, callsByFamily: history.callsByFamily }); }
  const unique = [...new Map(all.map(x => [lower(x.vault), x])).values()]; if (unique.length > MAX_VAULTS) fail("VAULT_CAP");
  return { vaults: unique, coverage };
}
async function batchedAddressHistory(rows, addresses, topic, from, to, label) {
  const logs = []; let callsByFamily = [0, 0]; const batches = [];
  for (let i = 0; i < addresses.length; i += 500) {
    const batch = addresses.slice(i, i + 500), history = await agreedHistory(rows, { address: batch, topics: [topic] }, from, to, `${label}_${i / 500}`);
    logs.push(...history.logs); callsByFamily = callsByFamily.map((x, j) => x + history.callsByFamily[j]); batches.push({ addresses: batch.length, rows: history.rows, digest: history.digest });
  }
  const deduped = [...new Map(normalizeLogs(logs).map(log => [`${log.address}:${log.transactionHash}:${log.logIndex}`, log])).values()];
  return { from, to, rows: deduped.length, digest: sha(canon(deduped)), callsByFamily, batches, logs: deduped };
}
async function scopedHistories(rows, from, to, vaultAddresses) {
  const changed = await batchedAddressHistory(rows, vaultAddresses, TOPIC.strategyChanged, from, to, "STRATEGY_CHANGED");
  const candidates = [...new Set(changed.logs.filter(log => log.topics.length >= 2).map(log => lower(topicAddress(log.topics[1]))))].map(publicAddress);
  if (!candidates.length) return { initialized: { from, to, rows: 0, digest: sha("[]"), callsByFamily: [0, 0], logs: [] }, changed, reported: { from, to, rows: 0, digest: sha("[]"), callsByFamily: [0, 0], logs: [] } };
  const initialized = await batchedAddressHistory(rows, candidates, TOPIC.newStrategy, STRATEGY_START_BLOCK, to, "NEW_TOKENIZED_STRATEGY");
  const reported = await batchedAddressHistory(rows, candidates, TOPIC.reported, STRATEGY_START_BLOCK, to, "REPORTED");
  return { initialized, changed, reported };
}
function strategyUniverse(history) {
  const out = [];
  for (const log of history.logs) try { const decoded = ABI.strategy.decodeEventLog("NewTokenizedStrategy", log.data, log.topics); if (String(decoded.apiVersion) === "3.0.3" && lower(decoded.strategy) === lower(log.address)) out.push({ strategy: publicAddress(decoded.strategy), asset: publicAddress(decoded.asset), apiVersion: String(decoded.apiVersion), blockNumber: log.blockNumber, transactionHash: log.transactionHash, logIndex: log.logIndex }); } catch {}
  return [...new Map(out.map(x => [lower(x.strategy), x])).values()];
}
function strategyPairs(changed, vaultSet, strategySet) {
  const pairs = new Map();
  for (const log of changed.logs) {
    if (!vaultSet.has(log.address) || log.topics.length < 3) continue; const strategy = topicAddress(log.topics[1]); if (!strategySet.has(lower(strategy))) continue;
    const key = `${log.address}:${lower(strategy)}`, changeType = Number(BigInt(log.topics[2]));
    const prior = pairs.get(key) || { vault: publicAddress(log.address), strategy, changes: [] }; prior.changes.push({ blockNumber: log.blockNumber, transactionHash: log.transactionHash, logIndex: log.logIndex, changeType }); pairs.set(key, prior);
  }
  if (pairs.size > MAX_PAIRS) fail("PAIR_CAP"); return [...pairs.values()];
}
function reportHistory(logs, strategySet) {
  const map = new Map();
  for (const log of logs) {
    if (!strategySet.has(log.address)) continue; let decoded; try { decoded = ABI.strategy.decodeEventLog("Reported", log.data, log.topics); } catch { continue; }
    const prior = map.get(log.address) || { count: 0, cumulativeProfitRaw: 0n, cumulativeLossRaw: 0n, last: null }; prior.count++; prior.cumulativeProfitRaw += BigInt(decoded.profit); prior.cumulativeLossRaw += BigInt(decoded.loss); prior.last = { blockNumber: log.blockNumber, transactionHash: log.transactionHash, profitRaw: BigInt(decoded.profit).toString(), lossRaw: BigInt(decoded.loss).toString(), protocolFeesRaw: BigInt(decoded.protocolFees).toString(), performanceFeesRaw: BigInt(decoded.performanceFees).toString() }; map.set(log.address, prior);
  }
  return map;
}

async function pairState(rows, pair, tag) {
  let stage = "strategies";
  try {
    const vp = await call(rows, pair.vault, ABI.vault, "strategies", [pair.strategy], tag), activation = BigInt(vp.activation), currentDebt = BigInt(vp.currentDebt);
    stage = "implementation-slot";
    const implWords = []; for (const row of rows) { const word = await maybeRpc(row, "eth_getStorageAt", [pair.strategy, IMPL_SLOT, tag], 12_000); if (/^0x[0-9a-fA-F]{64}$/.test(word || "")) implWords.push(lower(word)); }
    const implementationSlotAgreement = implWords.length === rows.length && implWords.every(word => word === implWords[0]), implementation = implWords.length ? publicAddress(`0x${implWords[0].slice(-40)}`) : null;
    const specs = [
      [pair.vault, ABI.vault, "apiVersion", []], [pair.vault, ABI.vault, "FACTORY", []], [pair.vault, ABI.vault, "asset", []], [pair.vault, ABI.vault, "isShutdown", []], [pair.vault, ABI.vault, "totalAssets", []], [pair.vault, ABI.vault, "totalSupply", []], [pair.vault, ABI.vault, "profitMaxUnlockTime", []],
      [pair.strategy, ABI.strategy, "apiVersion", []], [pair.strategy, ABI.strategy, "tokenizedStrategyAddress", []], [pair.strategy, ABI.strategy, "FACTORY", []], [pair.strategy, ABI.strategy, "asset", []], [pair.strategy, ABI.strategy, "isShutdown", []], [pair.strategy, ABI.strategy, "totalAssets", []], [pair.strategy, ABI.strategy, "totalSupply", []], [pair.strategy, ABI.strategy, "balanceOf", [pair.vault]], [pair.strategy, ABI.strategy, "maxDeposit", [ATTACKER]], [pair.strategy, ABI.strategy, "lastReport", []], [pair.strategy, ABI.strategy, "profitMaxUnlockTime", []], [pair.strategy, ABI.strategy, "fullProfitUnlockDate", []], [pair.strategy, ABI.strategy, "management", []], [pair.strategy, ABI.strategy, "keeper", []], [pair.strategy, ABI.strategy, "performanceFee", []]
    ], values = [];
    for (const spec of specs) { stage = spec[2]; values.push(await call(rows, spec[0], spec[1], spec[2], spec[3], tag)); }
    const [vaultVersion, vaultFactory, vaultAsset, vaultShutdown, vaultTotalAssets, vaultTotalSupply, vaultUnlock, strategyVersion, strategyImpl, strategyFactory, strategyAsset, strategyShutdown, strategyTotalAssets, strategyTotalSupply, vaultShares, maxDeposit, lastReport, strategyUnlock, fullUnlock, management, keeper, performanceFee] = values;
    const keeperAddress = publicAddress(keeper[0]), managementAddress = publicAddress(management[0]), caller = keeperAddress !== ZERO ? keeperAddress : managementAddress, simulations = [];
    for (const row of rows) { const decoded = await maybeCall(row, pair.strategy, ABI.strategy, "report", [], tag, caller); simulations.push(decoded ? { success: true, profitRaw: BigInt(decoded.profit).toString(), lossRaw: BigInt(decoded.loss).toString() } : { success: false, profitRaw: null, lossRaw: null }); }
    const simulationAgreed = simulations.every(x => canon(x) === canon(simulations[0])), simulated = simulationAgreed && simulations[0].success ? simulations[0] : null;
    const A = BigInt(strategyTotalAssets[0]), capacity = BigInt(maxDeposit[0]), x = capacity < A ? capacity : A, profit = simulated ? BigInt(simulated.profitRaw) : 0n, feeBps = BigInt(performanceFee[0]), feeProfit = profit * feeBps / 10_000n, netProfit = profit - feeProfit, gross = grossCapture(A, x, profit, feeBps);
    const exactImplementation = implementation !== null && lower(implementation) === lower(ADDR.tokenizedStrategy303) && lower(strategyImpl[0]) === lower(ADDR.tokenizedStrategy303), assetMatch = lower(vaultAsset[0]) === lower(strategyAsset[0]), active = activation > 0n && currentDebt > 0n && BigInt(vaultShares[0]) > 0n;
    return { vault: pair.vault, strategy: pair.strategy, changes: pair.changes, vaultState: { apiVersion: String(vaultVersion[0]), factory: publicAddress(vaultFactory[0]), asset: publicAddress(vaultAsset[0]), shutdown: Boolean(vaultShutdown[0]), totalAssetsRaw: BigInt(vaultTotalAssets[0]).toString(), totalSupplyRaw: BigInt(vaultTotalSupply[0]).toString(), profitMaxUnlockTimeSeconds: BigInt(vaultUnlock[0]).toString(), strategyParams: { activation: activation.toString(), lastReport: BigInt(vp.lastReport).toString(), currentDebtRaw: currentDebt.toString(), maxDebtRaw: BigInt(vp.maxDebt).toString() } }, strategyState: { apiVersion: String(strategyVersion[0]), implementationSlot: implementation, implementationSlotFamiliesObserved: implWords.length, implementationSlotAgreement, tokenizedStrategyAddress: publicAddress(strategyImpl[0]), factory: publicAddress(strategyFactory[0]), asset: publicAddress(strategyAsset[0]), shutdown: Boolean(strategyShutdown[0]), totalAssetsRaw: A.toString(), totalSupplyRaw: BigInt(strategyTotalSupply[0]).toString(), vaultShareBalanceRaw: BigInt(vaultShares[0]).toString(), arbitraryReceiverMaxDepositRaw: capacity.toString(), lastReport: BigInt(lastReport[0]).toString(), profitMaxUnlockTimeSeconds: BigInt(strategyUnlock[0]).toString(), fullProfitUnlockDate: BigInt(fullUnlock[0]).toString(), management: managementAddress, keeper: keeperAddress, performanceFeeBps: Number(feeBps) }, binding: { exactImplementation, implementationGetterExact: lower(strategyImpl[0]) === lower(ADDR.tokenizedStrategy303), implementationSlotAgreement, assetMatch, activeVaultDebtAndShares: active }, reportSimulation: { attemptedFamilies: simulations.length, exactAgreement: simulationAgreed, result: simulated, failures: simulations.filter(x => !x.success).length }, conservativeGrossModel: { attackerDepositRaw: x.toString(), simulatedProfitRaw: profit.toString(), modeledFeeOnProfitRaw: feeProfit.toString(), modeledNetProfitAfterPerformanceFeeRaw: netProfit.toString(), modeledGrossCaptureAfterFullStrategyUnlockRaw: gross.toString(), formula: "x*(profit-feeProfit)/(strategyTotalAssets+x+feeProfit)", capitalCappedAtOneTimesStrategyTotalAssets: true, withdrawalLossSlippageGasCapitalCostAndAssetUsdValueIncluded: false }, watchQualified: exactImplementation && assetMatch && active && !Boolean(strategyShutdown[0]) && capacity > 0n && simulated !== null && profit > 0n && gross > 0n };
  } catch (error) { return { vault: pair.vault, strategy: pair.strategy, changes: pair.changes, stateComplete: false, watchQualified: false, blocker: "fixed-pin pair state or ABI unavailable", failedStage: stage, failureCategory: error.code || "DECODE_OR_STATE_FAILURE" }; }
}

function renderReport(raw) {
  const p = raw.pin, rows = raw.watchCandidates.length ? raw.watchCandidates.map(c => `| \`${c.vault}\` | \`${c.strategy}\` | ${c.strategyState.asset} | ${c.vaultState.strategyParams.currentDebtRaw} | ${c.reportSimulation.result.profitRaw} | ${c.strategyState.arbitraryReceiverMaxDepositRaw} | ${c.conservativeGrossModel.modeledGrossCaptureAfterFullStrategyUnlockRaw} |`).join("\n") : "| none | none | none | 0 | 0 | 0 | 0 |", allPairStatesComplete = raw.discovery.completePairStates === raw.discovery.historicalPairs;
  return `# 🟠 WATCH — Yearn V3 pre-report yield dilution deployment discovery Step 2\n\n**Classification:** \`${raw.classification}\`\n**Pipeline:** \`${raw.pipeline.stage}/5\`; **route-positive:** \`false\`; **fork/live action:** \`false\`.\n\n## Result\n\nAt finalized Ethereum pin \`${p.number}\` / \`${p.hash}\` (${new Date(p.timestamp * 1000).toISOString()}), two distinct hostname-derived RPC families agreed the header, registry/release state, ${allPairStatesComplete ? "all joined fixed-pin pair states except the separately qualified storage-slot read" : "the successfully completed fixed-pin pair states"}, and terminal same-number hash recheck. These are capability groupings; backend/operator independence is not established. Event histories are bounded single-family observations because only ${raw.endpointCoverage.selectedHistoryFamilies} selected family passed the 50,000-block archive-log canary; no cross-family history agreement is claimed.\n\nThe scan found **${raw.discovery.exactTokenizedStrategies}** exact v3.0.3 TokenizedStrategy deployments, **${raw.discovery.factoryVaults}** target-version factory vaults, **${raw.discovery.historicalPairs}** event-joined vault/strategy pairs, **${raw.discovery.completePairStates}** complete pair states, and **${raw.watchCandidates.length}** current gross-positive WATCH candidate${raw.watchCandidates.length === 1 ? "" : "s"}.${allPairStatesComplete ? "" : " Current-candidate absence is not established while pair-state coverage is incomplete."} A candidate requires an exact one-family EIP-1967 slot observation plus exact two-family immutable implementation getter, matching underlying, active nonzero vault debt and strategy shares, non-shutdown strategy, positive arbitrary-receiver \`maxDeposit\`, and an exact two-family positive read-only \`report()\` simulation.\n\n| vault | strategy | asset | vault debt raw | simulated pre-report profit raw | public capacity raw | modeled gross capture raw |\n|---|---|---|---:|---:|---:|---:|\n${rows}\n\n## Evidence and limitations\n\n- Registry bindings: ${raw.registry.bindings.releaseBindingsMatch ? "match" : "do not match"}; endorsed current/legacy vault counts ${raw.registry.current.length}/${raw.registry.legacy.length}.\n- Factory \`NewVault\`, scoped \`NewTokenizedStrategy\`, \`StrategyChanged\`, and \`Reported\` histories have contiguous bounded ranges and recorded commitments on one family. The second-family history gap remains open, and event emission outside the queried signatures is not proven.\n- \`report()\` was executed only through historical \`eth_call\` at the fixed pin from the public keeper/management address for complete pair states. No state was retained and no transaction was signed or broadcast.\n- The gross model caps attacker capital at one current strategy TVL and subtracts the configured performance fee. It excludes withdrawal loss/slippage, gas, capital cost, asset USD value, nested-vault timing, MEV, and execution feasibility. Historical reports do **not** imply current unrealized profit; only the fixed-pin simulation is used for qualification.\n- Exact local/runtime equality for each strategy implementation shell was not established. The official implementation getter agreed across two families, while the EIP-1967 slot was available on only one; slot-family agreement is explicitly false.\n\n## Preconditions and impact\n\nA qualified route still requires an attacker to source the underlying, deposit before the same positive report, remain exposed until strategy profit unlock (and potentially the parent vault unlock), then exit without losses exceeding gross capture. If feasible, existing strategy holders bear the captured share of net report yield; principal is not directly seized by this primitive.\n\n## Defensive tests and mitigation\n\n- Re-run a local fixed-pin fork only after closing history and economics gates, proving deposit → report → both unlock horizons → redeem and exact net profit after gas/slippage.\n- Restrict direct strategy deposits to approved vaults, or snapshot/exclude shares minted inside a report lookback window from the next report's profit.\n- Randomize report timing only as defense-in-depth; it does not remove the accounting primitive. Monitor large deposits shortly before keeper reports.\n\n**Reopen/fork gate:** ${raw.nextGate}\n\nSource references: \`lib/tokenized-strategy/src/TokenizedStrategy.sol:1081-1255\`, \`lib/tokenized-strategy/src/BaseStrategy.sol:168-174\`, \`contracts/VaultV3.vy:160-170\`.\n`;
}
function renderHandoff(raw) { return `# Yearn V3 TokenizedStrategy accounting Step 2 handoff\n\n- ${raw.classification}; pipeline ${raw.pipeline.stage}/5; routePositive=false; fork=false.\n- Finalized Ethereum pin ${raw.pin.number} / ${raw.pin.hash}; two hostname-derived state families agree and terminal recheck passed; backend independence unproven.\n- Event histories and EIP-1967 slot evidence are bounded single-family observations; second-family agreement remains open.\n- Exact v3.0.3 strategies ${raw.discovery.exactTokenizedStrategies}; factory vaults ${raw.discovery.factoryVaults}; joined pairs ${raw.discovery.historicalPairs}; complete states ${raw.discovery.completePairStates}; current gross-positive WATCH candidates ${raw.watchCandidates.length}.\n- Candidate gate requires one-family exact slot plus two-family exact implementation getter, asset match, active debt/shares, public capacity, and positive two-family read-only report simulation.\n- Gross only: no asset pricing, gas, slippage, capital cost, nested unlock execution, or fork proof. Historical yield is not treated as current yield.\n- No endpoint/raw-response persistence, .env/key read, signing, transaction, broadcast, fork, state override, or production mutation.\n- Next: ${raw.nextGate}\n`; }

async function refreshState() {
  if (!fs.existsSync(RAW) || !fs.existsSync(INVENTORY)) fail("STATE_REFRESH_INPUT_MISSING");
  const prior = JSON.parse(fs.readFileSync(RAW, "utf8")), inventoryText = fs.readFileSync(INVENTORY, "utf8"), records = parseInventory(inventoryText), secrets = secretsFrom(records);
  process.stderr.write("Yearn Step2 state refresh: qualify families\n"); const qualified = await qualify(records), oldTag = hex(prior.pin.number), rows = [];
  for (const row of qualified.rows) { const header = await maybeRpc(row, "eth_getBlockByNumber", [oldTag, false], 10_000); if (header?.hash && lower(header.hash) === lower(prior.pin.hash)) rows.push(row); }
  if (rows.length < 2) fail("STATE_REFRESH_OLD_PIN_TWO_FAMILY_UNAVAILABLE");
  const states = [];
  for (let i = 0; i < prior.pairStates.length; i++) { const old = prior.pairStates[i]; process.stderr.write(`Yearn Step2 state refresh pair ${i + 1}/${prior.pairStates.length}\r`); const state = await pairState(rows, { vault: old.vault, strategy: old.strategy, changes: old.changes }, oldTag); state.reportHistory = old.reportHistory; states.push(state); await sleep(250); }
  process.stderr.write("\nYearn Step2 state refresh: terminal cooldown and recheck\n"); const watchCandidates = states.filter(x => x.watchQualified), complete = states.filter(x => x.stateComplete !== false).length, terminal = []; await sleep(15_000);
  for (const row of rows) { const same = await maybeRpc(row, "eth_getBlockByNumber", [oldTag, false], 10_000), finalized = await maybeRpc(row, "eth_getBlockByNumber", ["finalized", false], 10_000); terminal.push({ sameHash: same?.hash ? lower(same.hash) === lower(prior.pin.hash) : null, finalizedAtOrAbove: finalized?.number ? Number(BigInt(finalized.number)) >= prior.pin.number : null }); }
  if (!terminalRowsExactlyTrue(terminal, rows.length)) fail("STATE_REFRESH_TERMINAL_RECHECK_FAILED");
  const allComplete = complete === states.length, classification = watchCandidates.length ? "WATCH/CURRENT-GROSS-POSITIVE/NET-ECONOMICS-UNRESOLVED/DEPLOYMENT-BOUND" : allComplete ? "WATCH/SOURCE-CONDITIONAL/NO-CURRENT-GROSS-POSITIVE-CANDIDATE/DEPLOYMENT-BOUND" : "WATCH/DEPLOYMENT-BOUND/CURRENT-STATE-COVERAGE-INCOMPLETE";
  const raw = { ...prior, revision: (prior.revision || 1) + 1, generatedAt: new Date().toISOString(), runId: `${NAME}-${prior.pin.number}-${prior.pin.hash.slice(2, 14)}-state-r2`, classification, pin: { ...prior.pin, initialCaptureTerminalRecheck: prior.pin.initialCaptureTerminalRecheck || prior.pin.terminalRecheck, stateRefreshTerminalRecheck: terminal, terminalRecheck: prior.pin.initialCaptureTerminalRecheck || prior.pin.terminalRecheck }, endpointCoverage: { ...prior.endpointCoverage, selectedStateFamilies: rows.length }, pairStates: states, watchCandidates, discovery: { ...prior.discovery, completePairStates: complete, watchCandidates: watchCandidates.length }, pipeline: { ...prior.pipeline, stage: watchCandidates.length ? 2 : 1, currentPositiveReportSimulation: watchCandidates.length > 0 }, rpcBudget: { initialCapture: prior.rpcBudget, stateRefresh: budget }, nextGate: watchCandidates.length ? "Close the second-family history gap, price the underlying, and model gas/capital/withdrawal losses before requesting a bounded fixed-pin fork." : allComplete ? "Close the second-family history gap and repeat at a fresh finalized pin near an authorized keeper report; do not fork without a positive current simulation and conservative net model." : "Close the listed fixed-pin pair-state failures across two families before making a current-candidate conclusion." };
  const rawText = `${JSON.stringify(raw, null, 2)}\n`, reportText = renderReport(raw), handoffText = renderHandoff(raw), inboxText = `${JSON.stringify({ findingId: NAME, runId: raw.runId, agentId: AGENT, role: "critical-research", status: watchCandidates.length ? "current-gross-positive-watch" : allComplete ? "deployment-bound-no-current-positive" : "state-coverage-incomplete", classification, pipeline: raw.pipeline, gates: raw.gates, pin: raw.pin, candidateCount: watchCandidates.length, artifacts: [path.relative(ROOT, RAW).replace(/\\/g, "/"), path.relative(ROOT, REPORT).replace(/\\/g, "/"), path.relative(ROOT, HANDOFF).replace(/\\/g, "/"), "tools/run-critical-yearn-v3-step2.js"], nextAction: raw.nextGate }, null, 2)}\n`;
  for (const [label, text] of [["raw", rawText], ["report", reportText], ["handoff", handoffText], ["inbox", inboxText]]) { const low = lower(text); if (/(?:https?|wss?):\/\//i.test(text) || /"(?:url|headers|apiKey|token|rawResponse|responseBody)"\s*:/i.test(text)) fail(`${label.toUpperCase()}_FORBIDDEN_FIELD_LEAK`); for (const secret of secrets) if (low.includes(secret)) fail(`${label.toUpperCase()}_ENDPOINT_LEAK`); }
  fs.writeFileSync(RAW, rawText); fs.writeFileSync(REPORT, reportText); fs.writeFileSync(HANDOFF, handoffText); fs.writeFileSync(INBOX, inboxText); process.stdout.write(`${JSON.stringify({ runId: raw.runId, classification, completePairStates: complete, pairs: states.length, watchCandidates: watchCandidates.length, rpcCalls: budget.attempted })}\n`);
}

async function queryDaiOpportunityCost(records, prior) {
  const oldTag = hex(prior.pin.number), oldHashTag = { blockHash: prior.pin.hash, requireCanonical: true }, groups = new Map(), used = new Set(), diagnostics = { chain: 0, fixedPin: 0, code: 0, dsrStorage: 0, dsrEthCallCrossCheck: 0, chi: 0, rho: 0, live: 0, complete: 0 }; let probed = 0, fixedPinFamilies = 0;
  for (const row of records) {
    if (probed++ >= MAX_ENDPOINT_PROBES) break; if (used.has(row.family)) continue; used.add(row.family);
    const chain = await maybeRpc(row, "eth_chainId", [], 5_000); if (!chain || BigInt(chain) !== 1n) continue; diagnostics.chain++;
    const header = await maybeRpc(row, "eth_getBlockByNumber", [oldTag, false], 8_000); if (!header?.hash || lower(header.hash) !== lower(prior.pin.hash)) continue; fixedPinFamilies++; diagnostics.fixedPin++;
    const code = await maybeRpc(row, "eth_getCode", [ADDR.daiPot, oldTag], 10_000), codeValid = /^0x[0-9a-fA-F]{4,}$/.test(code || ""); if (codeValid) diagnostics.code++;
    let dsrWord = await maybeRpc(row, "eth_getStorageAt", [ADDR.daiPot, "0x3", oldTag], 12_000); if (!/^0x[0-9a-fA-F]{64}$/.test(dsrWord || "")) dsrWord = await maybeRpc(row, "eth_getStorageAt", [ADDR.daiPot, "0x3", oldHashTag], 12_000); const storageDsr = /^0x[0-9a-fA-F]{64}$/.test(dsrWord || "") ? BigInt(dsrWord) : null; if (storageDsr !== null) diagnostics.dsrStorage++;
    let decoded = null; for (const blockParam of [oldTag, oldHashTag]) { try { const result = await rpc(row, "eth_call", [{ to: ADDR.daiPot, data: ABI.pot.encodeFunctionData("dsr", []) }, blockParam], 15_000, 2); decoded = ABI.pot.decodeFunctionResult("dsr", result); break; } catch {} } const callDsr = decoded ? BigInt(decoded[0]) : null; if (callDsr !== null) diagnostics.dsrEthCallCrossCheck++;
    if (storageDsr !== null && callDsr !== null && storageDsr !== callDsr) continue; const dsr = storageDsr ?? callDsr; if (dsr === null || dsr < 10n ** 27n || dsr > 2n * 10n ** 27n) continue;
    diagnostics.complete++; const tuple = { dsr: dsr.toString() }, runtime = codeValid ? { runtimeBytes: (code.length - 2) / 2, runtimeKeccak256: ethers.keccak256(code) } : null, readMethod = storageDsr !== null && callDsr !== null ? "storage-slot-3+eth_call" : storageDsr !== null ? "storage-slot-3" : "eth_call";
    const key = sha(canon(tuple)), group = groups.get(key) || []; group.push({ row, tuple, runtime, readMethod }); groups.set(key, group); if (group.length >= 2) break;
  }
  const best = [...groups.values()].sort((a, b) => b.length - a.length)[0]; if (!best || best.length < 2) { process.stderr.write(`Yearn Step2 anonymous DAI query counts: ${JSON.stringify(diagnostics)}\n`); fail("DAI_POT_TWO_FAMILY_FIXED_PIN_STATE_UNAVAILABLE"); }
  const selected = best.slice(0, 2), terminal = [], supplemental = {};
  for (const method of ["chi", "rho", "live"]) { let value = null; try { const result = await rpc(selected[0].row, "eth_call", [{ to: ADDR.daiPot, data: ABI.pot.encodeFunctionData(method, []) }, oldTag], 15_000, 3); value = BigInt(ABI.pot.decodeFunctionResult(method, result)[0]).toString(); } catch {} supplemental[method] = value; }
  for (const item of selected) { const same = await rpc(item.row, "eth_getBlockByNumber", [oldTag, false], 10_000, 5), finalized = await rpc(item.row, "eth_getBlockByNumber", ["finalized", false], 10_000, 5); terminal.push({ sameHash: lower(same.hash) === lower(prior.pin.hash), finalizedAtOrAbove: Number(BigInt(finalized.number)) >= prior.pin.number }); }
  if (!terminalRowsExactlyTrue(terminal, 2)) fail("DAI_POT_TERMINAL_RECHECK_NOT_EXACT_TRUE");
  const runtime = selected.find(x => x.runtime)?.runtime || null;
  return { state: { ...selected[0].tuple, ...supplemental, runtimeBytes: runtime?.runtimeBytes || null, runtimeKeccak256: runtime?.runtimeKeccak256 || null }, coverage: { inventoryReadInMemoryOnly: true, candidatesProbed: probed, fixedPinFamilies, agreeingStateFamilies: selected.length, exactDsrAgreement: selected.every(x => x.tuple.dsr === selected[0].tuple.dsr), dsrReadMethods: selected.map(x => x.readMethod), storageSlotSemantics: "slot 3 from verified Pot storage declaration order", runtimeFamiliesObserved: selected.filter(x => x.runtime).length, supplementalChiRhoLiveFamilies: 1, terminalRecheck: terminal, backendOperatorIndependenceEstablished: false } };
}

function correctPairClaims(state) {
  if (state.strategyState) {
    state.strategyState.freshReceiverMaxDepositQuoteRaw = state.strategyState.arbitraryReceiverMaxDepositRaw; delete state.strategyState.arbitraryReceiverMaxDepositRaw;
    state.strategyState.maxDepositMeaning = "Quoted receiver capacity only; no executable arbitrary-depositor proof.";
    state.strategyState.implementationSlotRole = "Informational EIP-1967 convention only; BaseStrategy fallback dispatches to its compiled tokenizedStrategyAddress constant, not this slot.";
    state.strategyState.hypotheticalPostReportWeightedUnlockSeconds = null;
    state.strategyState.hypotheticalPostReportFullProfitUnlockDate = null;
  }
  if (state.binding) {
    state.binding.v303EventApiAndImplementationGetterMatched = state.binding.implementationGetterExact === true;
    state.binding.informationalImplementationSlotObserved = state.strategyState?.implementationSlot || null;
    state.binding.customStrategyShellRuntimeExact = false;
    state.binding.customHooksExact = false;
    state.binding.baseStrategyFallbackDispatchProvenBySlot = false;
    delete state.binding.exactImplementation;
  }
  if (state.reportSimulation) state.reportSimulation.returnSemantics = "Keeper-authorized report() eth_call return: newTotalAssets minus cached totalAssets after any simulated strategy harvest/sales; not independently measured unrealized profit.";
  if (state.reportHistory) Object.assign(state.reportHistory, { cadencePredictabilityEstablished: false, reportIntervalDistribution: null, actionableTimingEstablished: false, singleFamilyHistory: true });
  state.directRoute = { entry: "direct TokenizedStrategy deposit", parentVaultProcessReportRequired: false, parentVaultTenDayUnlockRequired: false, parentVaultRouteEstablished: false };
  state.exitFeasibility = { established: false, postDepositMaxRedeem: null, availableWithdrawLimit: null, liquidityOrFreeFunds: null, withdrawalLoss: null, slippage: null, redeemSimulation: null, mandatoryOnlyIfEconomicsSurvives: true };
  return state;
}

function renderEconomicReport(raw) {
  const c = raw.grossCounterfactualCandidates[0], e = raw.economicCloseout, cost = e.capitalOpportunityCost;
  return `# 🟢 CLOSED — Yearn V3 Step2 DAI candidate is route-negative in the three-day counterfactual\n\n**Classification:** \`${raw.classification}\`\n**Pipeline:** \`2/5\`; **route-positive:** \`false\`; **fork/live action:** \`false\`.\n\n## Corrected discovery scope\n\nAt finalized Ethereum pin \`${raw.pin.number}\` / \`${raw.pin.hash}\`, the fixed package contains **${raw.discovery.eventClassifiedStrategiesInDiscoveredVaultJoinedUniverse} event-classified v3.0.3 strategies in the discovered vault-joined universe**, not a global deployment census. History is single-family; no provider/backend independence is claimed. The v3.0.3 event/API and implementation getter are evidence only. The custom strategy shell/runtime and exact custom hooks are unproven. Its EIP-1967 slot is informational and does not control \`BaseStrategy\` fallback dispatch.\n\nThe sole gross-positive counterfactual joins vault \`${c.vault}\` to strategy \`${c.strategy}\` with DAI. \`maxDeposit(freshReceiver)\` is only a quoted receiver capacity. The \`report()\` result of **${ethers.formatUnits(e.counterfactual.reportReturnRaw, 18)} DAI** is a keeper-authorized \`eth_call\` return (new total assets minus cached assets after any simulated harvest/sales), not independently measured unrealized profit.\n\n## Exact counterfactual and impact\n\n- \`A = x = ${ethers.formatUnits(e.counterfactual.assetsRaw, 18)} DAI\`\n- \`p = ${ethers.formatUnits(e.counterfactual.reportReturnRaw, 18)} DAI\`; performance fee \`0\`\n- \`capture = x*p/(A+x) = floor(p/2) = ${ethers.formatUnits(e.counterfactual.grossCaptureRaw, 18)} DAI\`\n- Gross rate: **${e.counterfactual.grossRatePercent}%**; three-day annualized break-even **${e.counterfactual.breakEvenAnnualizedBps3d} bps**; ten-day illustration **${e.counterfactual.breakEvenAnnualizedBps10d} bps**.\n\nIncumbents lose that share of report yield; principal remains intact. This is the **direct TokenizedStrategy deposit** counterfactual. Parent-vault \`process_report\` and its ten-day maximum are not required, and no parent-vault route is established. Three and ten days are configured maxima; the actual weighted unlock/full-unlock date after the hypothetical report was not captured.\n\n## Economic close-out\n\nThe official DAI Pot at \`${cost.contract}\` returned identical fixed-pin \`dsr\` across two hostname-derived state families; runtime and \`chi/rho/live\` are supplemental context only. Local semantics: \`dsr\` is the Pot per-second RAY factor; the exact three-day foregone-savings calculation uses Maker-style RAY exponentiation.\n\n- Pot \`dsr\`: \`${cost.dsrRay}\`; effective annual rate: **${cost.effectiveAnnualBps} bps**.\n- Exact three-day growth factor: \`${cost.growthRay}\` RAY.\n- Foregone DAI savings on exact capital: **${ethers.formatUnits(cost.costRaw, 18)} DAI**.\n- Gross minus capital opportunity cost: **-${ethers.formatUnits(e.net.negativeMagnitudeRaw, 18)} DAI** before gas and exit losses.\n- Gas is conservatively floored at zero DAI for closure; separately, two attacker transactions imply at least \`${e.gas.intrinsicGasUnitsLowerBound}\` intrinsic gas and \`${e.gas.intrinsicBaseFeeWeiLowerBound}\` wei at the fixed-pin base fee. Capital cost alone exceeds gross.\n\nTherefore the three-day modeled route is **net-negative before gas, free-funds/liquidity limits, withdrawal loss, slippage, or redemption risk**. No fork is warranted.\n\n## Remaining non-route claims\n\n- Exit feasibility is absent: no post-deposit \`maxRedeem\`, withdraw-limit, liquidity/free-funds, loss/slippage, or redeem simulation. It is unnecessary after economic closure.\n- The 142 retained report events do not prove cadence or predictable/actionable timing; no interval distribution was computed.\n- No additional history, transaction, signature, exploit call, fork, state override, or mutation was performed.\n\n**Reopen only if:** a fresh bounded package shows materially larger report return, an executable direct deposit, exact post-report unlock/exit behavior, and conservative positive net economics.\n\nLocal semantics: \`targets/sparklend-advanced/src/PotRateSource.sol:6-23\`; \`targets/spark-vaults-v2/lib/dss-test/lib/dss-interfaces/src/dss/PotAbstract.sol:4-20\`; Yearn source references remain those in Step1.\n`;
}

async function economicCloseout() {
  if (!fs.existsSync(RAW) || !fs.existsSync(INVENTORY)) fail("ECONOMIC_CLOSEOUT_INPUT_MISSING");
  const prior = JSON.parse(fs.readFileSync(RAW, "utf8")), inventoryText = fs.readFileSync(INVENTORY, "utf8"), records = parseInventory(inventoryText), secrets = secretsFrom(records);
  process.stderr.write("Yearn Step2 R2: bounded same-pin DAI Pot query\n"); const pot = await queryDaiOpportunityCost(records, prior);
  const candidateAddress = "0xAeDF7d5F3112552E110e5f9D08c9997Adce0b78d", pairStates = prior.pairStates.map(state => correctPairClaims(state));
  const candidate = pairStates.find(state => lower(state.strategy) === lower(candidateAddress)); if (!candidate) fail("CORRECTED_CANDIDATE_MISSING");
  const A = BigInt(candidate.strategyState.totalAssetsRaw), x = A, p = BigInt(candidate.reportSimulation.result.profitRaw), fee = 0n, gross = x * p / (A + x), RAY = 10n ** 27n, duration = 259_200n, growth = rpow(BigInt(pot.state.dsr), duration, RAY), costRaw = A * (growth - RAY) / RAY, net = gross - costRaw;
  if (A !== 1_269_083_508_555_249_382_456_318n || p !== 11_818_666_578_642_154_609n || gross !== 5_909_333_289_321_077_304n) fail("COUNTERFACTUAL_CONSTANT_MISMATCH");
  if (costRaw <= gross || net >= 0n) fail("CAPITAL_COST_DOES_NOT_CLOSE_ROUTE");
  candidate.conservativeGrossModel = { assetsRaw: A.toString(), attackerDepositRaw: x.toString(), keeperAuthorizedReportReturnRaw: p.toString(), performanceFeeBps: "0", grossCaptureRaw: gross.toString(), exactFormula: "x*p/(A+x)=floor(p/2) when A=x and fee=0", incumbentReportYieldShareLossRaw: gross.toString(), incumbentPrincipalLossRaw: "0", grossOnly: true };
  candidate.grossCounterfactualQualified = true; delete candidate.watchQualified;
  const annualGrowth = rpow(BigInt(pot.state.dsr), 31_536_000n, RAY), effectiveAnnualBps = fixedRatio((annualGrowth - RAY) * 10_000n, RAY, 4), grossRatePercent = fixedRatio(gross * 100n, A, 7), breakEven3 = fixedRatio(gross * 10_000n * 365n, A * 3n, 4), breakEven10 = fixedRatio(gross * 10_000n * 365n, A * 10n, 4), intrinsicGas = 42_000n, baseFee = BigInt(prior.pin.baseFeePerGasWei);
  const classification = "WATCH/CONDITIONAL-PRIMITIVE/CURRENT-DAI-CANDIDATE-ROUTE-NEGATIVE-AT-THREE-DAY-MODEL/EXIT-UNPROVEN";
  const raw = { ...prior, schemaVersion: 2, revision: (prior.revision || 3) + 1, generatedAt: new Date().toISOString(), runId: `${NAME}-${prior.pin.number}-${prior.pin.hash.slice(2, 14)}-oracle-r2`, classification, oracleRequestChangesApplied: ["22 count corrected to event-classified strategies in discovered vault-joined universe", "custom shell/runtime and exact hooks unproven", "implementation slot informational and not fallback dispatch", "fresh receiver maxDeposit is quote only", "report return semantics corrected", "direct strategy route separated from parent vault", "configured maxima separated from hypothetical weighted unlock", "exact A=x/p/fee/capture counterfactual", "exit feasibility absent and unnecessary after closure", "142 events do not prove cadence", "same-pin DAI Pot opportunity-cost closeout", "manifest generation split from check-only validation"], discovery: { ...prior.discovery, watchCandidates: 0, grossCounterfactualCandidates: 1, eventClassifiedStrategiesInDiscoveredVaultJoinedUniverse: prior.discovery.exactTokenizedStrategies, globalStrategyDeploymentCount: null, historySingleFamily: true }, pairStates, eventClassifiedStrategies: prior.exactStrategies, grossCounterfactualCandidates: [candidate], watchCandidates: [], economicCloseout: { disposition: "NET_NEGATIVE_BEFORE_GAS_AND_EXIT_AT_THREE_DAY_COUNTERFACTUAL", counterfactual: { assetsRaw: A.toString(), attackerDepositRaw: x.toString(), reportReturnRaw: p.toString(), performanceFeeBps: fee.toString(), grossCaptureRaw: gross.toString(), exactFormula: "x*p/(A+x)=floor(p/2)", grossRatePercent, breakEvenAnnualizedBps3d: breakEven3, breakEvenAnnualizedBps10d: breakEven10, durationSeconds: duration.toString(), durationMeaning: "Configured three-day strategy maximum used by the Step2 full-unlock counterfactual; actual post-hypothetical weighted unlock was not captured." }, capitalOpportunityCost: { source: "Official on-chain DAI Pot savings factor", contract: ADDR.daiPot, semantics: "dsr is the per-second RAY growth factor; exact cost uses RAY exponentiation over the modeled duration", localSourceReferences: ["targets/sparklend-advanced/src/PotRateSource.sol:6-23", "targets/spark-vaults-v2/lib/dss-test/lib/dss-interfaces/src/dss/PotAbstract.sol:4-20"], fixedPin: { number: prior.pin.number, hash: prior.pin.hash }, stateFamilies: pot.coverage.agreeingStateFamilies, exactDsrAgreement: pot.coverage.exactDsrAgreement, runtimeFamiliesObserved: pot.coverage.runtimeFamiliesObserved, supplementalChiRhoLiveFamilies: pot.coverage.supplementalChiRhoLiveFamilies, runtimeBytes: pot.state.runtimeBytes, runtimeKeccak256: pot.state.runtimeKeccak256, dsrRay: pot.state.dsr, chiRay: pot.state.chi, rho: pot.state.rho, live: pot.state.live, effectiveAnnualBps, growthRay: growth.toString(), capitalRaw: A.toString(), durationSeconds: duration.toString(), costRaw: costRaw.toString() }, gas: { daiCostLowerBoundRaw: "0", daiFloorReason: "Capital opportunity cost alone closes; no unsupported ETH/DAI conversion used.", minimumAttackerTransactions: 2, intrinsicGasUnitsLowerBound: intrinsicGas.toString(), fixedPinBaseFeePerGasWei: baseFee.toString(), intrinsicBaseFeeWeiLowerBound: (intrinsicGas * baseFee).toString(), includedInNetClosure: false }, exit: candidate.exitFeasibility, net: { grossRaw: gross.toString(), capitalCostRaw: costRaw.toString(), gasDaiLowerBoundRaw: "0", beforeGasAndExitRawSigned: net.toString(), negativeMagnitudeRaw: (-net).toString(), netNegative: true } }, daiOpportunityQueryCoverage: pot.coverage, pipeline: { ...prior.pipeline, stage: 2, currentPositiveReportSimulation: true, economicsResolved: true, candidateRouteNegative: true, netEconomics: true, forkProof: false }, gates: { routePositive: false, executableNow: false, signedActionJustified: false, fork: false }, nextGate: "No fork. Reopen only for materially larger return plus executable direct deposit, exact weighted unlock/exit, and positive conservative net economics." };
  delete raw.discovery.exactTokenizedStrategies; delete raw.exactStrategies;
  const reportText = renderEconomicReport(raw), handoffText = `# Yearn V3 Step2 oracle R2 handoff\n\n- ${classification}; pipeline 2/5; routePositive=false; fork=false.\n- Corrected count: 22 event-classified strategies in the discovered vault-joined universe; not global; history single-family.\n- Custom strategy shell/runtime and hooks unproven. Getter/API/event matched; EIP-1967 slot informational only and single-family.\n- Direct DAI strategy counterfactual: A=x=${ethers.formatUnits(A, 18)}, p=${ethers.formatUnits(p, 18)}, fee=0, gross=${ethers.formatUnits(gross, 18)} DAI.\n- Same-pin two-family Pot DSR cost over modeled 259200 seconds: ${ethers.formatUnits(costRaw, 18)} DAI; net before gas/exit = -${ethers.formatUnits(-net, 18)} DAI.\n- maxDeposit is receiver quote only; report return may include simulated harvest/sales; exit and actual hypothetical weighted unlock unproven.\n- 142 events do not establish cadence/predictability. Parent-vault route unestablished and unnecessary for direct route.\n- Validator is check-only; manifest generator is separate. No additional history/fork/signing/transaction/mutation.\n`, inbox = { findingId: NAME, runId: raw.runId, agentId: "critical-yearn-v3-step2-oracle-r2-20260728", role: "critical-research", status: "candidate-route-negative-three-day-model", classification, correctedCounts: { eventClassifiedStrategiesInDiscoveredVaultJoinedUniverse: 22, globalDeployments: null, factoryVaults: raw.discovery.factoryVaults, joinedPairs: raw.discovery.historicalPairs }, economics: raw.economicCloseout, gates: raw.gates, artifacts: [path.relative(ROOT, RAW).replace(/\\/g, "/"), path.relative(ROOT, REPORT).replace(/\\/g, "/"), path.relative(ROOT, HANDOFF).replace(/\\/g, "/"), "tools/run-critical-yearn-v3-step2.js", "tools/test-critical-yearn-v3-step2.js", "tools/validate-critical-yearn-v3-step2.js", "tools/generate-critical-yearn-v3-step2-manifest.js"], nextAction: raw.nextGate }, rawText = `${JSON.stringify(raw, null, 2)}\n`, inboxText = `${JSON.stringify(inbox, null, 2)}\n`;
  for (const [label, text] of [["raw", rawText], ["report", reportText], ["handoff", handoffText], ["inbox", inboxText]]) { const low = lower(text); if (/(?:https?|wss?):\/\//i.test(text) || /"(?:url|headers|apiKey|token|rawResponse|responseBody)"\s*:/i.test(text)) fail(`${label.toUpperCase()}_FORBIDDEN_FIELD_LEAK`); for (const secret of secrets) if (low.includes(secret)) fail(`${label.toUpperCase()}_ENDPOINT_LEAK`); }
  fs.writeFileSync(RAW, rawText); fs.writeFileSync(REPORT, reportText); fs.writeFileSync(HANDOFF, handoffText); fs.writeFileSync(INBOX, inboxText);
  process.stdout.write(`${JSON.stringify({ runId: raw.runId, classification, dsrRay: pot.state.dsr, capitalCostRaw: costRaw.toString(), grossRaw: gross.toString(), netRaw: net.toString(), routePositive: false, rpcCalls: budget.attempted })}\n`);
}

function renderFinalUnresolvedReport(raw) {
  const c = raw.grossCounterfactualCandidates[0], s = raw.economicSensitivity, b = s.daiPotBenchmark;
  return `# 🟠 WATCH — Yearn V3 Step2 DAI candidate economics unresolved\n\n**Classification:** \`${raw.classification}\`\n**Gates:** \`0/0/false\`; **route-positive:** \`false\`; **fork:** \`false\`.\n\n## Corrected scope\n\nThe fixed package at finalized Ethereum pin \`${raw.pin.number}\` / \`${raw.pin.hash}\` contains **22 event-classified v3.0.3 strategies in the discovered vault-joined universe**, not global deployments. History is single-family. The custom strategy shell/runtime and exact hooks remain unproven; the EIP-1967 slot is informational and does not control \`BaseStrategy\` fallback dispatch. \`maxDeposit(freshReceiver)\` remains a receiver-capacity quote, not executable arbitrary-deposit proof.\n\nThe candidate is the direct DAI TokenizedStrategy route at vault \`${c.vault}\` / strategy \`${c.strategy}\`. Parent-vault \`process_report\` and the parent ten-day maximum are unnecessary for that direct route and remain separately unestablished. The keeper-authorized \`report()\` simulation returned **11.818666578642154609 DAI**, meaning simulated new total assets minus cached assets after any simulated harvest/sales—not independently measured unrealized profit.\n\n## Partial gross model only\n\n- \`A = x = 1,269,083.508555249382456318 DAI\`; \`p = 11.818666578642154609 DAI\`; fee \`0\`.\n- \`x*p/(A+x) = floor(p/2) = 5.909333289321077304 DAI\`.\n- Incumbents lose that modeled share of the **new simulated report return**; principal remains intact.\n\nThis is not a complete attacker-cashflow model. It omits already-unlocking profit and ordinary strategy yield during the holding period. The actual post-hypothetical weighted unlock, shortest feasible hold, partial exit, and full/partial redemption cashflows are unknown. Three days is only the configured strategy maximum; using it maximizes the modeled DSR benchmark amount and is not conservative for route closure.\n\n## DSR sensitivity — not a floor\n\nThe retained same-pin two-family Pot observation is \`dsr=${b.dsrRay}\` (effective annual sensitivity **${b.effectiveAnnualBps} bps**). If, purely as a scenario, the exact capital could earn that rate continuously for the full configured maximum of 259,200 seconds, the modeled DSR amount is **129.583727090881369588 DAI** and the arithmetic difference versus the partial gross is **-123.674393801560292284 DAI**.\n\nThat number is **non-promoting sensitivity only**, not a capital-cost floor: exact-capital public access/capacity, rate persistence, and the strategy's concurrent yield are unbound. A shorter weighted unlock or partial exit reduces the benchmark duration. Therefore neither route-negative nor route-positive net economics is established.\n\n## Remaining blockers and action\n\n- No executable direct deposit proof.\n- No exact custom runtime/source or hook semantics.\n- No weighted post-report unlock or partial-exit timing.\n- No post-deposit \`maxRedeem\`, withdraw limit, free-funds/liquidity, loss/slippage, or redeem simulation.\n- The 142 retained reports do not prove cadence, predictability, or actionable timing.\n\n**Recommended action:** stop/rotate. Reopen only if exact custom runtime/source, executable deposit and exit, weighted unlock, complete attacker cashflows, and report predictability become available. No fork is justified.\n\nThis final correction was offline-only: no network, RPC, history, fork, state query, transaction, signature, exploit call, or mutation.\n`;
}

function finalOracleOfflineCorrection() {
  if (!fs.existsSync(RAW)) fail("FINAL_OFFLINE_CORRECTION_INPUT_MISSING"); const prior = JSON.parse(fs.readFileSync(RAW, "utf8")), old = prior.economicCloseout; if (!old) fail("FINAL_OFFLINE_SENSITIVITY_SOURCE_MISSING");
  const classification = "WATCH/CONDITIONAL-PRIMITIVE/CURRENT-DAI-CANDIDATE/MODEL-NOT-ESTABLISHED/EXIT-UNPROVEN/NET-ECONOMICS-UNRESOLVED", candidate = prior.grossCounterfactualCandidates[0];
  candidate.newSimulatedReportOnlyGrossModel = candidate.conservativeGrossModel; delete candidate.conservativeGrossModel;
  candidate.allAttackerCashflowModel = { complete: false, newSimulatedReportReturnIncluded: true, alreadyUnlockingProfitIncluded: false, ordinaryStrategyYieldDuringHoldIncluded: false, shortestFeasibleHoldingPeriod: null, partialExitCashflows: null, fullExitCashflows: null };
  const sensitivity = { disposition: "NON_PROMOTING_DSR_SENSITIVITY_ONLY", economicsResolved: false, routeNegativeEstablished: false, routePositiveEstablished: false, counterfactual: { ...old.counterfactual, durationMeaning: "Configured three-day strategy maximum; maximizes this modeled DSR amount and is not a conservative closure duration. Actual weighted unlock/shortest feasible hold/partial exit are unknown." }, daiPotBenchmark: { ...old.capitalOpportunityCost, benchmarkOnly: true, opportunityCostFloorEstablished: false, exactCapitalPublicAccessAndCapacityEstablished: false, ratePersistenceEstablished: false, concurrentStrategyYieldBound: false, modeledThreeDayAmountRaw: old.capitalOpportunityCost.costRaw }, gasSensitivity: { ...old.gas, daiFloorReason: "Zero DAI sensitivity only; no ETH/DAI conversion used and no economic closure claimed.", usedForClosure: false }, exit: { ...old.exit, economicsSurvivalGateReached: false }, threeDayDifferenceSensitivity: { partialGrossRaw: old.net.grossRaw, modeledDsrAmountRaw: old.net.capitalCostRaw, arithmeticDifferenceRawSigned: old.net.beforeGasAndExitRawSigned, interpretation: "Scenario arithmetic only; not net economics because benchmark accessibility/persistence, duration, concurrent yield, and full cashflows are unbound." } };
  const raw = { ...prior, revision: (prior.revision || 4) + 1, generatedAt: new Date().toISOString(), runId: `${NAME}-${prior.pin.number}-${prior.pin.hash.slice(2, 14)}-oracle-final-r3`, agentId: "critical-yearn-v3-step2-final-r3-20260728", classification, oracleFinalCorrections: ["DSR reclassified from floor to same-pin benchmark sensitivity", "three-day configured maximum is not conservative for closure", "partial gross omits already-unlocking profit and ordinary strategy yield", "all-attacker-cashflow model incomplete", "net economics unresolved; no route-negative claim", "runner terminal predicates require exact boolean true"], grossCounterfactualCandidates: [candidate], economicSensitivity: sensitivity, pipeline: { ...prior.pipeline, stage: 2, economicsResolved: false, candidateRouteNegative: false, netEconomics: false, modelEstablished: false, forkProof: false }, gates: { routePositive: false, executableNow: false, signedActionJustified: false, fork: false }, finalCorrectionActivity: { offlineOnly: true, networkReads: 0, rpcReads: 0, historyReads: 0, fork: false, stateQueries: 0, transactions: 0, signing: 0, mutation: 0 }, nextGate: "Stop/rotate. Reopen only with exact custom runtime/source, executable deposit/exit, weighted unlock, complete cashflows, and report predictability." }; delete raw.economicCloseout; delete raw.oracleRequestChangesApplied;
  const reportText = renderFinalUnresolvedReport(raw), handoffText = `# Yearn V3 Step2 final oracle handoff\n\n- ${classification}; gates 0/0/false; routePositive=false; fork=false.\n- 22 is event-classified strategies in the discovered vault-joined universe, not global; history single-family.\n- Partial gross: 5.909333289321077304 DAI from only the new 11.818666578642154609 DAI simulated report return. Already-unlocking profit and ordinary strategy yield omitted.\n- Three days is a configured maximum, not a conservative closure duration; weighted unlock/shortest hold/partial exit unknown.\n- Same-pin Pot scenario: 129.583727090881369588 DAI and -123.674393801560292284 DAI arithmetic difference, benchmark sensitivity only—not a floor. Access/capacity, persistence, concurrent yield, and full cashflows unbound.\n- Economics unresolved; do not claim route-negative or economically closed. Stop/rotate unless exact runtime/source, executable deposit/exit, weighted unlock, full cashflows, and report predictability become available.\n- Runner and validator reject null and truthy nonboolean terminal fields. Validator check-only; generator separate. Offline correction only; no network/RPC/history/fork/state query.\n`, inbox = { findingId: NAME, runId: raw.runId, agentId: raw.agentId, role: "critical-research", status: "model-not-established-net-economics-unresolved", classification, correctedCounts: { eventClassifiedStrategiesInDiscoveredVaultJoinedUniverse: 22, globalDeployments: null, factoryVaults: raw.discovery.factoryVaults, joinedPairs: raw.discovery.historicalPairs }, grossCounterfactual: raw.grossCounterfactualCandidates[0].newSimulatedReportOnlyGrossModel, allAttackerCashflowModel: raw.grossCounterfactualCandidates[0].allAttackerCashflowModel, economicSensitivity: sensitivity, gates: raw.gates, recommendedAction: raw.nextGate, artifacts: [path.relative(ROOT, RAW).replace(/\\/g, "/"), path.relative(ROOT, REPORT).replace(/\\/g, "/"), path.relative(ROOT, HANDOFF).replace(/\\/g, "/"), "tools/run-critical-yearn-v3-step2.js", "tools/test-critical-yearn-v3-step2.js", "tools/validate-critical-yearn-v3-step2.js", "tools/generate-critical-yearn-v3-step2-manifest.js"] }, rawText = `${JSON.stringify(raw, null, 2)}\n`, inboxText = `${JSON.stringify(inbox, null, 2)}\n`;
  for (const [label, text] of [["raw", rawText], ["report", reportText], ["handoff", handoffText], ["inbox", inboxText]]) if (/(?:https?|wss?):\/\//i.test(text) || /"(?:url|headers|apiKey|token|rawResponse|responseBody)"\s*:/i.test(text)) fail(`${label.toUpperCase()}_FORBIDDEN_FIELD_LEAK`);
  fs.writeFileSync(RAW, rawText); fs.writeFileSync(REPORT, reportText); fs.writeFileSync(HANDOFF, handoffText); fs.writeFileSync(INBOX, inboxText); process.stdout.write(`${JSON.stringify({ runId: raw.runId, classification, economicsResolved: false, routePositive: false, offlineOnly: true })}\n`);
}

async function main() {
  if (!fs.existsSync(INVENTORY)) fail("AUTHORIZED_INVENTORY_MISSING"); const inventoryText = fs.readFileSync(INVENTORY, "utf8"), records = parseInventory(inventoryText), secrets = secretsFrom(records); if (!records.length) fail("AUTHORIZED_INVENTORY_EMPTY");
  process.stderr.write("Yearn Step2 stage: qualify finalized families\n");
  const qualified = await qualify(records), rows = qualified.rows, historyRows = qualified.historyRows, { pin } = qualified, tag = pin.tag;
  process.stderr.write("Yearn Step2 stage: registry and release state\n");
  const registry = await registryState(rows, tag); if (!registry.bindings.releaseBindingsMatch) fail("OFFICIAL_REGISTRY_BINDING_MISMATCH");
  process.stderr.write("Yearn Step2 stage: release enumeration and factory histories\n");
  const factoryRows = await releases(rows, tag); process.stderr.write(`Yearn Step2 release rows: ${factoryRows.length}\n`);
  const factoryHistory = await factoryVaultHistory(historyRows, factoryRows, pin.number), minimumFactoryBlock = Math.min(...factoryHistory.coverage.map(x => x.firstCodeBlock));
  const vaultMap = new Map(factoryHistory.vaults.map(x => [lower(x.vault), x])); for (const vault of [...registry.current, ...registry.legacy]) if (!vaultMap.has(lower(vault))) vaultMap.set(lower(vault), { vault, asset: null, factory: null, factoryVersion: null, endorsedOnly: true });
  process.stderr.write("Yearn Step2 stage: vault-scoped strategy histories\n");
  const global = await scopedHistories(historyRows, minimumFactoryBlock, pin.number, [...vaultMap.values()].map(x => x.vault)), strategies = strategyUniverse(global.initialized), strategySet = new Set(strategies.map(x => lower(x.strategy)));
  const vaultSet = new Set(vaultMap.keys()), pairs = strategyPairs(global.changed, vaultSet, strategySet), historyMap = reportHistory(global.reported.logs, strategySet), states = [];
  for (let i = 0; i < pairs.length; i++) { process.stderr.write(`Yearn Step2 pair ${i + 1}/${pairs.length}\r`); states.push(await pairState(rows, pairs[i], tag)); }
  process.stderr.write("\n");
  for (const state of states) { const h = historyMap.get(lower(state.strategy)); state.reportHistory = h ? { count: h.count, cumulativeProfitRaw: h.cumulativeProfitRaw.toString(), cumulativeLossRaw: h.cumulativeLossRaw.toString(), last: h.last } : { count: 0, cumulativeProfitRaw: "0", cumulativeLossRaw: "0", last: null }; }
  const watchCandidates = states.filter(x => x.watchQualified).sort((a, b) => { const x = BigInt(a.conservativeGrossModel.modeledGrossCaptureAfterFullStrategyUnlockRaw), y = BigInt(b.conservativeGrossModel.modeledGrossCaptureAfterFullStrategyUnlockRaw); return x === y ? 0 : x > y ? -1 : 1; });
  const terminal = []; for (const row of rows) { const [same, final] = await Promise.all([rpc(row, "eth_getBlockByNumber", [tag, false], 8_000), rpc(row, "eth_getBlockByNumber", ["finalized", false], 8_000)]); terminal.push({ sameHash: lower(same.hash) === lower(pin.hash), finalizedAtOrAbove: Number(BigInt(final.number)) >= pin.number }); }
  if (!terminalRowsExactlyTrue(terminal, rows.length)) fail("TERMINAL_RECHECK_FAILED");
  const classification = watchCandidates.length ? "WATCH/CURRENT-GROSS-POSITIVE/NET-ECONOMICS-UNRESOLVED/DEPLOYMENT-BOUND" : "WATCH/SOURCE-CONDITIONAL/NO-CURRENT-GROSS-POSITIVE-CANDIDATE/DEPLOYMENT-BOUND";
  const raw = jsonSafe({ schemaVersion: 1, generatedAt: new Date().toISOString(), runId: `${NAME}-${pin.number}-${pin.hash.slice(2, 14)}`, agentId: AGENT, role: "critical-research", classification, authorization: { currentTurn: true, readOnlyEthereumRpcOnly: true }, safety: { endpointMaterialPersisted: false, providerIdentitiesPersisted: false, rawResponsesPersisted: false, envRead: false, keyFilesRead: false, signedTransactions: false, broadcast: false, stateMutation: false, fork: false, stateOverride: false }, pin: { chainId: 1, number: pin.number, hash: pin.hash, timestamp: pin.timestamp, baseFeePerGasWei: pin.baseFeePerGasWei, finalizedSelected: true, selectedHostnameDerivedFamilies: rows.length, terminalRecheck: terminal, backendOperatorIndependenceEstablished: false }, endpointCoverage: { inventoryReadInMemoryOnly: true, inventoryCandidateCount: records.length, candidatesProbed: qualified.probed, responsiveFinalizedFamilies: qualified.responsiveFamilies, selectedStateFamilies: rows.length, selectedHistoryFamilies: historyRows.length, historyCrossFamilyAgreement: historyRows.length >= 2, historyCoverageBlocker: historyRows.length < 2 ? "Only one selected hostname-derived family satisfied the bounded 50,000-block archive-log canary; event commitments are single-family observations." : null }, registry, releases: factoryRows, factoryHistory: factoryHistory.coverage, globalHistory: { newTokenizedStrategy: { from: global.initialized.from, to: global.initialized.to, rows: global.initialized.rows, digest: global.initialized.digest, callsByFamily: global.initialized.callsByFamily }, strategyChanged: { from: global.changed.from, to: global.changed.to, rows: global.changed.rows, digest: global.changed.digest, callsByFamily: global.changed.callsByFamily }, reported: { from: global.reported.from, to: global.reported.to, rows: global.reported.rows, digest: global.reported.digest, callsByFamily: global.reported.callsByFamily } }, discovery: { targetFactories: factoryRows.length, factoryVaults: factoryHistory.vaults.length, endorsedUnionVaults: vaultMap.size, exactTokenizedStrategies: strategies.length, historicalPairs: pairs.length, completePairStates: states.filter(x => x.stateComplete !== false).length, watchCandidates: watchCandidates.length }, exactStrategies: strategies, vaults: [...vaultMap.values()], pairStates: states, watchCandidates, pipeline: { stage: watchCandidates.length ? 2 : 1, total: 5, sourcePrimitive: true, deploymentBinding: true, currentPositiveReportSimulation: watchCandidates.length > 0, netEconomics: false, forkProof: false }, gates: { routePositive: false, executableNow: false, signedActionJustified: false, fork: false }, rpcBudget: budget, nextGate: watchCandidates.length ? "Close the second-family history gap, price the underlying, and model gas/capital/withdrawal losses before requesting a bounded fixed-pin fork." : "Close the second-family history gap and repeat at a fresh finalized pin near an authorized keeper report; do not fork without a positive current simulation and conservative net model." });
  const rawText = `${JSON.stringify(raw, null, 2)}\n`, reportText = renderReport(raw), handoffText = renderHandoff(raw), inboxText = `${JSON.stringify({ findingId: NAME, runId: raw.runId, agentId: AGENT, role: "critical-research", status: watchCandidates.length ? "current-gross-positive-watch" : "deployment-bound-no-current-positive", classification, pipeline: raw.pipeline, gates: raw.gates, pin: raw.pin, candidateCount: watchCandidates.length, artifacts: [path.relative(ROOT, RAW).replace(/\\/g, "/"), path.relative(ROOT, REPORT).replace(/\\/g, "/"), path.relative(ROOT, HANDOFF).replace(/\\/g, "/"), "tools/run-critical-yearn-v3-step2.js"], nextAction: raw.nextGate }, null, 2)}\n`;
  for (const [label, text] of [["raw", rawText], ["report", reportText], ["handoff", handoffText], ["inbox", inboxText]]) { const low = lower(text); if (/(?:https?|wss?):\/\//i.test(text) || /"(?:url|headers|apiKey|token|rawResponse|responseBody)"\s*:/i.test(text)) fail(`${label.toUpperCase()}_FORBIDDEN_FIELD_LEAK`); for (const secret of secrets) if (low.includes(secret)) fail(`${label.toUpperCase()}_ENDPOINT_LEAK`); }
  fs.writeFileSync(RAW, rawText); fs.writeFileSync(REPORT, reportText); fs.writeFileSync(HANDOFF, handoffText); fs.writeFileSync(INBOX, inboxText);
  process.stdout.write(`${JSON.stringify({ runId: raw.runId, classification, pin: pin.number, factories: factoryRows.length, vaults: factoryHistory.vaults.length, strategies: strategies.length, pairs: pairs.length, watchCandidates: watchCandidates.length, rpcCalls: budget.attempted })}\n`);
}

if (require.main === module) (process.argv.includes("--final-oracle-offline") ? Promise.resolve(finalOracleOfflineCorrection()) : process.argv.includes("--economic-closeout") ? economicCloseout() : process.argv.includes("--refresh-state") ? refreshState() : main()).catch(error => { process.stderr.write(`Yearn V3 Step2 stopped: ${error.code || "FAIL_CLOSED"}\n`); process.exit(1); });
module.exports = { canon, parseInventory, familyKey, semverTarget, normalizeLogs, strategyUniverse, strategyPairs, grossCapture, rmul, rpow, fixedRatio, terminalRowsExactlyTrue, renderReport, renderHandoff, correctPairClaims, renderFinalUnresolvedReport };
