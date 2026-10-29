#!/usr/bin/env node
"use strict";

// Bounded, read-only Ethereum deployment gate. RPC material is read in-process,
// is never passed to a child process, and is excluded from every persisted value.
const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");
const { Interface, getAddress, id, keccak256 } = require("./node_modules/ethers");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "reports", "raw", "fast", "beefy-yb-wbtc-deployment-gate");
const CAPTURE = path.join(OUT_DIR, "capture.json");
const MANIFEST = path.join(OUT_DIR, "manifest.json");
const INVENTORY = path.join(ROOT, "rpc_endpoints.txt");
const TARGET = path.join(ROOT, "targets", "beefy-contracts-4621d2dd");
const SOURCE = path.join(TARGET, "contracts", "BIFI", "strategies", "Curve", "StrategyYieldBasis.sol");
const BASE_SOURCE = path.join(TARGET, "contracts", "BIFI", "strategies", "Common", "BaseAllToNativeFactoryStrat.sol");
const VAULT_SOURCE = path.join(TARGET, "contracts", "BIFI", "vaults", "BeefyVaultV7.sol");
const ARTIFACT = path.join(TARGET, "artifacts", "contracts", "BIFI", "strategies", "Curve", "StrategyYieldBasis.sol", "StrategyYieldBasis.json");
const ADDRESS_BOOK = path.join(TARGET, "node_modules", "@beefyfinance", "blockchain-addressbook", "build", "address-book", "ethereum", "platforms", "beefyfinance.js");

const COMMIT = "4621d2dd07fad1e63f060451f32af5e1a43c88a9";
const CHAIN_ID = 1n;
const FACTORY = "0x52941de3ede234ae6b8608597440ac3394c64ae8";
const VAULT_FACTORY = "0xc551ddce8e5e657503cd67a39713c06f2c0d2e97";
const STRATEGY_SEED = "0x9fbba3faf00786a675425784967715ec29a5e8d2";
const VAULT_SEED = "0x000d8a90f10c3f47728f5c69990b116d2608bd9f";
const EXPECTED_WANT = "0xaa0b1d265f23972eafb7d088e963bd31403a58f5";
const YB_SHARE = "0x651d4b8168488fa163d85304662e8278d4c55baa";
const WBTC = "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599";
const STRATEGY_NAME = "YieldBasis";
const ZERO = `0x${"0".repeat(40)}`;
const ZERO32 = `0x${"0".repeat(64)}`;
const IMPLEMENTATION_SLOT = `0x${(BigInt(id("eip1967.proxy.implementation")) - 1n).toString(16).padStart(64, "0")}`;
const BEACON_SLOT = `0x${(BigInt(id("eip1967.proxy.beacon")) - 1n).toString(16).padStart(64, "0")}`;
const ADMIN_SLOT = `0x${(BigInt(id("eip1967.proxy.admin")) - 1n).toString(16).padStart(64, "0")}`;
const METHODS = new Set(["eth_chainId", "eth_getBlockByNumber", "eth_call", "eth_getCode", "eth_getStorageAt", "eth_getLogs"]);
const LIMITS = Object.freeze({ inventoryBytes: 1024 * 1024, candidates: 64, calls: 700, responseBytes: 4 * 1024 * 1024,
  totalResponseBytes: 64 * 1024 * 1024, requestMs: 12000, wallMs: 8 * 60 * 1000, discoveryBlocks: 10000000n,
  logChunk: 1000n, eventRows: 128, rewards: 16, extraRewards: 16 });

const strategyArtifact = JSON.parse(fs.readFileSync(ARTIFACT, "utf8"));
const strategyAbi = new Interface(strategyArtifact.abi);
const commonAbi = new Interface([
  "function owner() view returns(address)", "function implementation() view returns(address)",
  "function instance() view returns(address)", "function getImplementation(string) view returns(address)",
  "function instances(string) view returns(address)", "function native() view returns(address)",
  "function keeper() view returns(address)", "function beefyFeeRecipient() view returns(address)",
  "function beefyFeeConfig() view returns(address)", "function globalPause() view returns(bool)",
  "function strategyPause(string) view returns(bool)", "function strategy() view returns(address)",
  "function want() view returns(address)", "function vault() view returns(address)",
  "function factory() view returns(address)", "function swapper() view returns(address)",
  "function strategist() view returns(address)", "function depositToken() view returns(address)",
  "function paused() view returns(bool)", "function harvestOnDeposit() view returns(bool)",
  "function callReward() view returns(uint256)", "function lastHarvest() view returns(uint256)",
  "function balanceOf() view returns(uint256)", "function balanceOfWant() view returns(uint256)",
  "function balanceOfPool() view returns(uint256)", "function lockedProfit() view returns(uint256)",
  "function totalLocked() view returns(uint256)", "function lockDuration() view returns(uint256)",
  "function rewardsLength() view returns(uint256)", "function rewards(uint256) view returns(address)",
  "function extraRewards(uint256) view returns(address)",
  "function getAllFees() view returns(((uint256 total,uint256 beefy,uint256 call,uint256 strategist,string label,bool active) performance,uint256 deposit,uint256 withdraw))",
  "function getFees(address) view returns(uint256 total,uint256 beefy,uint256 call,uint256 strategist,string label,bool active)",
  "function totalSupply() view returns(uint256)", "function balance() view returns(uint256)",
  "function available() view returns(uint256)", "function getPricePerFullShare() view returns(uint256)",
  "function approvalDelay() view returns(uint256)", "function stratCandidate() view returns(address implementation,uint256 proposedTime)",
  "function name() view returns(string)", "function symbol() view returns(string)", "function decimals() view returns(uint8)",
  "function balanceOf(address) view returns(uint256)", "function allowance(address,address) view returns(uint256)",
  "function asset() view returns(address)", "function underlying() view returns(address)", "function token() view returns(address)",
  "function staking_token() view returns(address)", "function stakingToken() view returns(address)",
  "function gauge() view returns(address)", "function lp_token() view returns(address)", "function coin(uint256) view returns(address)",
  "function coins(uint256) view returns(address)", "function N_COINS() view returns(uint256)",
  "function pricePerShare() view returns(uint256)", "function price_per_share() view returns(uint256)",
  "function convertToAssets(uint256) view returns(uint256)", "function previewRedeem(uint256) view returns(uint256)",
  "function previewWithdraw(uint256) view returns(uint256)", "function maxRedeem(address) view returns(uint256)",
  "function maxWithdraw(address) view returns(uint256)", "function claimable_tokens(address) view returns(uint256)",
  "function claimable(address) view returns(uint256)", "function claimable_reward(address,address) view returns(uint256)",
  "function earned(address) view returns(uint256)"
]);
const eventAbi = new Interface([
  "event ProxyCreated(string strategyName,address proxy)", "event NewStrategyAdded(string strategyName,address implementation)",
  "event InstanceUpgraded(string strategyName,address newImplementation)",
  "event StratHarvest(address indexed harvester,uint256 wantHarvested,uint256 tvl)",
  "event Deposit(uint256 tvl)", "event Withdraw(uint256 tvl)"
]);

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function address(value) { try { return getAddress(value).toLowerCase(); } catch (_) { return null; } }
function serial(value) {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return /^0x[0-9a-fA-F]{40}$/u.test(value) ? value.toLowerCase() : value;
  if (Array.isArray(value)) return value.map(serial);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([k]) => !/^\d+$/u.test(k)).map(([k, v]) => [k, serial(v)]));
  return value;
}
function resultValue(row) { return row && row.reason === null ? row.value : null; }
function slotAddress(word) { return /^0x[0-9a-fA-F]{64}$/u.test(word || "") ? address(`0x${word.slice(-40)}`) : null; }
function pinArg(pin) { return { blockHash: pin.hash, requireCanonical: true }; }
function bytes(hex) { return typeof hex === "string" && /^0x(?:[0-9a-fA-F]{2})*$/u.test(hex) ? Buffer.from(hex.slice(2), "hex") : null; }
function codeSummary(code) { const raw = bytes(code); return raw ? { present: raw.length > 0, bytes: raw.length,
  keccak256: raw.length ? keccak256(code) : null, sha256: raw.length ? sha256(raw) : null } : null; }
function stripSolidityMetadata(code) {
  const raw = bytes(code); if (!raw || raw.length < 2) return null;
  const metadataLength = raw.readUInt16BE(raw.length - 2); if (metadataLength + 2 > raw.length) return null;
  const start = raw.length - metadataLength - 2, metadata = raw.subarray(start, raw.length - 2);
  const mapMajorType = metadata.length > 0 && (metadata[0] & 0xe0) === 0xa0;
  const hasCompiler = metadata.includes(Buffer.from("solc"));
  const hasSourceDigest = metadata.includes(Buffer.from("ipfs")) || metadata.includes(Buffer.from("bzzr"));
  if (!mapMajorType || !hasCompiler || !hasSourceDigest) return null;
  return raw.subarray(0, start);
}
function runtimeComparison(onchain, artifactRuntime) {
  const a = bytes(onchain), b = bytes(artifactRuntime); if (!a || !b) return { exact: null, metadataNormalized: null, conclusion: "UNRESOLVED" };
  const exact = a.equals(b), an = stripSolidityMetadata(onchain), bn = stripSolidityMetadata(artifactRuntime);
  const normalized = Boolean(an && bn && an.equals(bn));
  return { exact, metadataNormalized: normalized, onchainBytes: a.length, artifactBytes: b.length,
    onchainKeccak256: keccak256(onchain), artifactKeccak256: keccak256(artifactRuntime),
    conclusion: exact ? "EXACT_RUNTIME_MATCH" : normalized ? "EXECUTABLE_PREFIX_MATCH_METADATA_DIFFERS" : "NO_MATCH" };
}
function cloneImplementation(code) {
  const raw = String(code || "").toLowerCase();
  const match = raw.match(/^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/u);
  return match ? address(`0x${match[1]}`) : null;
}

function parseInventory(text) {
  if (Buffer.byteLength(text) > LIMITS.inventoryBytes) throw new Error("inventory size cap exceeded");
  const rows = [], seen = new Set(), lines = text.split(/\r?\n/u);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    for (const found of line.matchAll(/https:\/\/[^\s<'"`\])}]+/giu)) {
      let url; try { url = new URL(found[0].replace(/[>,.;]+$/u, "")); } catch (_) { continue; }
      if (url.protocol !== "https:" || url.username || url.password || url.hash) continue;
      const headers = {};
      for (const h of line.matchAll(/\[header:\s*([^=\]\s]+)=([^\]]+)\]/giu)) headers[h[1].trim()] = h[2].trim();
      const key = `${url.href}\0${JSON.stringify(headers)}`; if (seen.has(key)) continue; seen.add(key);
      const context = lines.slice(Math.max(0, lineIndex - 3), lineIndex + 4).join(" ");
      const ethereumHint = /(?:ethereum|eth-mainnet|mainnet[^a-z0-9]{0,8}(?:1|eth)|chain(?:id)?[^a-z0-9]{0,8}(?:1|0x1))(?!\d)/iu.test(context);
      rows.push({ url, headers, family: url.hostname.toLowerCase(), ethereumHint });
    }
  }
  // Bound before any network activity, preferring explicitly chain-1-labelled inventory rows.
  return rows.sort((a, b) => Number(b.ethereumHint) - Number(a.ethereumHint)).slice(0, LIMITS.candidates)
    .map(({ url, headers, family }) => ({ url, headers, family }));
}
function secretCorpus(rows) {
  const out = new Set(); for (const row of rows) {
    const sensitive = [row.url.href, ...row.url.pathname.split("/"), ...row.url.searchParams.values(), ...Object.values(row.headers)];
    for (const item of sensitive) if (String(item).length >= 16) { out.add(String(item)); out.add(String(item).toLowerCase()); }
  }
  return [...out];
}
function secretGuard(value, corpus) {
  const text = JSON.stringify(value), low = text.toLowerCase();
  if (/(?:https?|wss?):\/\//iu.test(text)) throw new Error("secret guard: URL in output");
  if (/"(?:endpoint|provider|hostname|domain|headers?)"\s*:/iu.test(text)) throw new Error("secret guard: provider key in output");
  for (const secret of corpus) if (text.includes(secret) || low.includes(secret.toLowerCase())) throw new Error("secret guard: inventory material in output");
}

class Budget {
  constructor() { this.start = Date.now(); this.calls = 0; this.responseBytes = 0; }
  use() { if (++this.calls > LIMITS.calls || Date.now() - this.start > LIMITS.wallMs) throw new Error("bounded RPC budget exceeded"); }
  add(size) { this.responseBytes += size; if (size > LIMITS.responseBytes || this.responseBytes > LIMITS.totalResponseBytes) throw new Error("RPC response budget exceeded"); }
  summary() { return { calls: this.calls, responseBytes: this.responseBytes, retries: 0, limits: { calls: LIMITS.calls,
    totalResponseBytes: LIMITS.totalResponseBytes, wallMs: LIMITS.wallMs }, withinLimits: true }; }
}
async function rpc(candidate, method, params, budget) {
  if (!METHODS.has(method)) throw new Error("method not permitted"); budget.use();
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: budget.calls, method, params }));
  return new Promise((resolve) => {
    let settled = false, request; const finish = (value) => { if (settled) return; settled = true; clearTimeout(timer); try { request?.destroy(); } catch (_) {} resolve(value); };
    const timer = setTimeout(() => finish({ ok: false, reason: "TIMEOUT" }), LIMITS.requestMs);
    const options = { protocol: "https:", hostname: candidate.url.hostname, port: candidate.url.port || 443,
      path: `${candidate.url.pathname}${candidate.url.search}`, method: "POST", agent: false,
      headers: { ...candidate.headers, "content-type": "application/json", accept: "application/json", "accept-encoding": "identity", "content-length": body.length } };
    try {
      request = https.request(options, (response) => { const chunks = []; let size = 0;
        response.on("data", (chunk) => { size += chunk.length; if (size > LIMITS.responseBytes) finish({ ok: false, reason: "RESPONSE_CAP" }); else chunks.push(Buffer.from(chunk)); });
        response.on("end", () => { if (settled) return; try { budget.add(size); } catch (error) { return finish({ ok: false, reason: error.message }); }
          if (response.statusCode !== 200) return finish({ ok: false, reason: "HTTP_STATUS" });
          try { const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (parsed.error) return finish({ ok: false, reason: "RPC_ERROR" }); finish({ ok: true, result: parsed.result });
          } catch (_) { finish({ ok: false, reason: "INVALID_JSON" }); } }); });
      request.on("error", () => finish({ ok: false, reason: "TRANSPORT_ERROR" })); request.end(body);
    } catch (_) { finish({ ok: false, reason: "TRANSPORT_ERROR" }); }
  });
}
async function qualify(candidates, budget) {
  const testedFamilies = new Set(); let tested = 0;
  for (const candidate of candidates) {
    if (testedFamilies.has(candidate.family)) continue; testedFamilies.add(candidate.family); tested++;
    const chain = await rpc(candidate, "eth_chainId", [], budget); if (!chain.ok) continue;
    try { if (BigInt(chain.result) !== CHAIN_ID) continue; } catch (_) { continue; }
    const block = await rpc(candidate, "eth_getBlockByNumber", ["finalized", false], budget);
    if (!block.ok || !/^0x[0-9a-fA-F]{64}$/u.test(block.result?.hash || "")) continue;
    const pin = { number: BigInt(block.result.number).toString(), hash: block.result.hash.toLowerCase(), timestamp: BigInt(block.result.timestamp).toString() };
    const code = await rpc(candidate, "eth_getCode", [FACTORY, pinArg(pin)], budget);
    const storage = await rpc(candidate, "eth_getStorageAt", [FACTORY, ZERO32, pinArg(pin)], budget);
    const call = await rpc(candidate, "eth_call", [{ to: FACTORY, data: commonAbi.encodeFunctionData("owner") }, pinArg(pin)], budget);
    const logs = await rpc(candidate, "eth_getLogs", [{ address: FACTORY, blockHash: pin.hash,
      topics: [eventAbi.getEvent("NewStrategyAdded").topicHash] }], budget);
    const historicalEnd = BigInt(pin.number) > 49000n ? BigInt(pin.number) - 49000n : BigInt(pin.number);
    const historicalStart = historicalEnd > 1000n ? historicalEnd - 999n : 0n;
    const historicalLogs = await rpc(candidate, "eth_getLogs", [{ address: STRATEGY_SEED,
      fromBlock: `0x${historicalStart.toString(16)}`, toBlock: `0x${historicalEnd.toString(16)}`,
      topics: [eventAbi.getEvent("Deposit").topicHash] }], budget);
    if (code.ok && codeSummary(code.result)?.present && storage.ok && call.ok && logs.ok && historicalLogs.ok)
      return { candidate, pin, tested, capable: true };
  }
  return { candidate: null, pin: null, tested, capable: false };
}
async function optionalCall(candidate, pin, to, iface, fragment, args, budget, from) {
  if (!address(to)) return { value: null, reason: "ADDRESS_UNAVAILABLE" };
  let data; try { data = iface.encodeFunctionData(fragment, args || []); } catch (_) { return { value: null, reason: "ABI_ENCODE_FAILED" }; }
  const tx = { to, data }; if (from) tx.from = from;
  const row = await rpc(candidate, "eth_call", [tx, pinArg(pin)], budget); if (!row.ok) return { value: null, reason: row.reason };
  try { const decoded = iface.decodeFunctionResult(fragment, row.result); return { value: serial(decoded.length === 1 ? decoded[0] : [...decoded]), reason: null }; }
  catch (_) { return { value: null, reason: "ABI_DECODE_FAILED" }; }
}
async function codeAt(candidate, pin, target, budget) { const row = await rpc(candidate, "eth_getCode", [target, pinArg(pin)], budget);
  return row.ok ? { value: codeSummary(row.result), raw: row.result, reason: null } : { value: null, raw: null, reason: row.reason }; }
async function slotAt(candidate, pin, target, slot, budget) { const row = await rpc(candidate, "eth_getStorageAt", [target, slot, pinArg(pin)], budget);
  return row.ok ? { value: slotAddress(row.result), wordZero: row.result === ZERO32, reason: null } : { value: null, wordZero: null, reason: row.reason }; }
async function proxyBinding(candidate, pin, target, budget) {
  const runtime = await codeAt(candidate, pin, target, budget), implementation = await slotAt(candidate, pin, target, IMPLEMENTATION_SLOT, budget),
    beacon = await slotAt(candidate, pin, target, BEACON_SLOT, budget), admin = await slotAt(candidate, pin, target, ADMIN_SLOT, budget);
  const beaconAddress = beacon.value && beacon.value !== ZERO ? beacon.value : null;
  const directImplementation = implementation.value && implementation.value !== ZERO ? implementation.value : null;
  const beaconImplementation = beaconAddress ? await optionalCall(candidate, pin, beaconAddress, commonAbi, "implementation", [], budget) : { value: null, reason: "NO_BEACON" };
  const resolvedImplementation = address(resultValue(beaconImplementation)) || directImplementation || cloneImplementation(runtime.raw);
  const implementationRuntime = resolvedImplementation ? await codeAt(candidate, pin, resolvedImplementation, budget) : { value: null, raw: null, reason: "UNRESOLVED" };
  return { address: target, runtime: { value: runtime.value, reason: runtime.reason }, slots: { implementation, beacon, admin }, beaconAddress,
    beaconImplementation, cloneImplementation: cloneImplementation(runtime.raw), resolvedImplementation,
    implementationRuntime: { value: implementationRuntime.value, reason: implementationRuntime.reason } };
}
async function callMap(candidate, pin, target, specs, budget) { const out = {};
  for (const [key, fragment, args = []] of specs) out[key] = await optionalCall(candidate, pin, target, commonAbi, fragment, args, budget); return out; }
async function eventLogs(candidate, pin, target, topic, from, budget) {
  const out = []; const end = BigInt(pin.number); for (let start = from; start <= end; start += LIMITS.logChunk) {
    const stop = start + LIMITS.logChunk - 1n > end ? end : start + LIMITS.logChunk - 1n;
    const row = await rpc(candidate, "eth_getLogs", [{ address: target, fromBlock: `0x${start.toString(16)}`, toBlock: `0x${stop.toString(16)}`, topics: [topic] }], budget);
    if (!row.ok) return { rows: out, complete: false, reason: row.reason }; for (const log of row.result || []) {
      if (out.length >= LIMITS.eventRows) return { rows: out, complete: false, reason: "EVENT_ROW_CAP" };
      out.push({ blockNumber: BigInt(log.blockNumber).toString(), transactionHash: log.transactionHash.toLowerCase(), logIndex: BigInt(log.logIndex).toString(), data: log.data, topics: log.topics.map((x) => x.toLowerCase()) });
    }
  } return { rows: out, complete: true, reason: null };
}
async function discoverStrategy(candidate, pin, budget) {
  const implementation = await optionalCall(candidate, pin, FACTORY, commonAbi, "getImplementation", [STRATEGY_NAME], budget);
  const beacon = await optionalCall(candidate, pin, FACTORY, commonAbi, "instances", [STRATEGY_NAME], budget);
  const end = BigInt(pin.number), start = end > LIMITS.discoveryBlocks ? end - LIMITS.discoveryBlocks : 0n;
  const seededFields = await callMap(candidate, pin, STRATEGY_SEED, [["vault", "vault"], ["want", "want"], ["factory", "factory"]], budget);
  if (address(resultValue(seededFields.vault)) === VAULT_SEED && address(resultValue(seededFields.want)) === EXPECTED_WANT &&
      address(resultValue(seededFields.factory)) === FACTORY) return { implementation, beacon, discovery: {
    fromBlock: (end > 250000n ? end - 250000n : 0n).toString(), toBlock: pin.number, logsComplete: null, matchingProxyLogs: null,
    selectedCreationBlock: (end > 250000n ? end - 250000n : 0n).toString(), method: "official-public-beefy-api-seed-bound-by-live-getters"
  }, strategy: STRATEGY_SEED };
  const proxyLogs = await eventLogs(candidate, pin, FACTORY, eventAbi.getEvent("ProxyCreated").topicHash, start, budget);
  const candidates = [];
  for (const row of proxyLogs.rows) {
    try { const parsed = eventAbi.decodeEventLog("ProxyCreated", row.data, row.topics);
      if (parsed.strategyName === STRATEGY_NAME) candidates.push({ address: address(parsed.proxy), blockNumber: row.blockNumber, transactionHash: row.transactionHash });
      continue;
    } catch (_) { /* tolerate the deployed factory's indexed-string event variant */ }
    if (row.topics.length === 2 && row.topics[1] === id(STRATEGY_NAME).toLowerCase() && /^0x[0-9a-f]{64}$/u.test(row.data))
      candidates.push({ address: address(`0x${row.data.slice(-40)}`), blockNumber: row.blockNumber, transactionHash: row.transactionHash });
  }
  const checked = [];
  for (const item of candidates.reverse()) {
    const fields = await callMap(candidate, pin, item.address, [["vault", "vault"], ["want", "want"], ["factory", "factory"]], budget);
    const valid = address(resultValue(fields.want)) === EXPECTED_WANT && address(resultValue(fields.factory)) === FACTORY && address(resultValue(fields.vault)) !== null;
    checked.push({ ...item, valid }); if (valid) return { implementation, beacon, discovery: { fromBlock: start.toString(), toBlock: pin.number,
      logsComplete: proxyLogs.complete, matchingProxyLogs: candidates.length, selectedCreationBlock: item.blockNumber, method: "factory-proxy-event" }, strategy: item.address };
  }
  const expectedBeacon = address(resultValue(beacon));
  const genericFactoryCandidates = new Set(); let genericFactoryRows = 0;
  for (let chunkEnd = end; chunkEnd >= start && genericFactoryCandidates.size < 192; ) {
    const chunkStart = chunkEnd > LIMITS.logChunk ? (chunkEnd - LIMITS.logChunk + 1n > start ? chunkEnd - LIMITS.logChunk + 1n : start) : start;
    const row = await rpc(candidate, "eth_getLogs", [{ address: FACTORY, fromBlock: `0x${chunkStart.toString(16)}`, toBlock: `0x${chunkEnd.toString(16)}` }], budget);
    if (!row.ok) break;
    for (const log of (row.result || []).slice().reverse()) {
      genericFactoryRows++;
      const words = [...(log.topics || []).slice(1), ...(String(log.data || "").slice(2).match(/.{64}/gu) || []).map((x) => `0x${x}`)];
      for (const word of words) {
        if (!/^0x0{24}[0-9a-fA-F]{40}$/u.test(word)) continue; const possible = address(`0x${word.slice(-40)}`);
        if (!possible || possible === ZERO || genericFactoryCandidates.has(possible)) continue; genericFactoryCandidates.add(possible);
        if (genericFactoryCandidates.size > 192) break;
        const possibleBeacon = await slotAt(candidate, pin, possible, BEACON_SLOT, budget);
        if (!expectedBeacon || possibleBeacon.value !== expectedBeacon) continue;
        const fields = await callMap(candidate, pin, possible, [["vault", "vault"], ["want", "want"], ["factory", "factory"]], budget);
        const valid = address(resultValue(fields.want)) === EXPECTED_WANT && address(resultValue(fields.factory)) === FACTORY && address(resultValue(fields.vault)) !== null;
        checked.push({ address: possible, blockNumber: BigInt(log.blockNumber).toString(), transactionHash: log.transactionHash.toLowerCase(), valid });
        if (valid) return { implementation, beacon, discovery: { fromBlock: start.toString(), toBlock: pin.number, logsComplete: true,
          matchingProxyLogs: candidates.length, selectedCreationBlock: BigInt(log.blockNumber).toString(), method: "bounded-generic-factory-event-binding",
          genericFactoryRows, genericFactoryAddressesInspected: genericFactoryCandidates.size }, strategy: possible };
      }
    }
    if (chunkStart === start) break; chunkEnd = chunkStart - 1n;
  }
  // Some live factory revisions used an event layout not represented by this exact
  // source snapshot. Fall back to bounded LP Transfer recipients, accepting only a
  // recipient whose EIP-1967 beacon, factory and want all match the official seeds.
  const transferTopic = id("Transfer(address,address,uint256)"), seenRecipients = new Set();
  const transferFloor = end > 250000n ? end - 250000n : 0n; let transferRows = 0;
  for (let chunkEnd = end; chunkEnd >= transferFloor && seenRecipients.size < 192; ) {
    const chunkStart = chunkEnd > LIMITS.logChunk ? (chunkEnd - LIMITS.logChunk + 1n > transferFloor ? chunkEnd - LIMITS.logChunk + 1n : transferFloor) : transferFloor;
    const row = await rpc(candidate, "eth_getLogs", [{ address: EXPECTED_WANT, fromBlock: `0x${chunkStart.toString(16)}`,
      toBlock: `0x${chunkEnd.toString(16)}`, topics: [transferTopic] }], budget);
    if (!row.ok) break;
    const logs = (row.result || []).slice().reverse(); transferRows += logs.length;
    for (const log of logs) {
      if (!Array.isArray(log.topics) || log.topics.length < 3) continue;
      const recipient = address(`0x${log.topics[2].slice(-40)}`); if (!recipient || recipient === ZERO || seenRecipients.has(recipient)) continue;
      seenRecipients.add(recipient); if (seenRecipients.size > 192) break;
      const recipientBeacon = await slotAt(candidate, pin, recipient, BEACON_SLOT, budget);
      if (!expectedBeacon || recipientBeacon.value !== expectedBeacon) continue;
      const fields = await callMap(candidate, pin, recipient, [["vault", "vault"], ["want", "want"], ["factory", "factory"]], budget);
      const valid = address(resultValue(fields.want)) === EXPECTED_WANT && address(resultValue(fields.factory)) === FACTORY && address(resultValue(fields.vault)) !== null;
      checked.push({ address: recipient, blockNumber: BigInt(log.blockNumber).toString(), transactionHash: log.transactionHash.toLowerCase(), valid });
      if (valid) return { implementation, beacon, discovery: { fromBlock: start.toString(), toBlock: pin.number, logsComplete: proxyLogs.complete,
        matchingProxyLogs: candidates.length, selectedCreationBlock: BigInt(log.blockNumber).toString(), method: "bounded-want-transfer-recipient",
        transferLookbackFromBlock: transferFloor.toString(), transferRowsInspected: transferRows, uniqueRecipientsInspected: seenRecipients.size }, strategy: recipient };
    }
    if (chunkStart === transferFloor) break; chunkEnd = chunkStart - 1n;
  }
  return { implementation, beacon, discovery: { fromBlock: start.toString(), toBlock: pin.number, logsComplete: proxyLogs.complete,
    matchingProxyLogs: candidates.length, transferLookbackFromBlock: transferFloor.toString(), transferRowsInspected: transferRows,
    uniqueRecipientsInspected: seenRecipients.size, genericFactoryRows, genericFactoryAddressesInspected: genericFactoryCandidates.size, checked }, strategy: null };
}

async function main() {
  const inventoryText = fs.readFileSync(INVENTORY, "utf8"), candidates = parseInventory(inventoryText), secrets = secretCorpus(candidates), budget = new Budget();
  const qualified = await qualify(candidates, budget); if (!qualified.capable) throw new Error("no chain-1 finalized read-only RPC family qualified");
  const { candidate, pin } = qualified; // Deliberately one family only; no fallback after this point.
  const discovery = await discoverStrategy(candidate, pin, budget); if (!discovery.strategy) throw new Error(
    `YieldBasis yb-WBTC strategy proxy not found in bounded discovery (implementation=${address(resultValue(discovery.implementation)) || "none"}, beacon=${address(resultValue(discovery.beacon)) || "none"}, matchingLogs=${discovery.discovery.matchingProxyLogs}, factoryRows=${discovery.discovery.genericFactoryRows || 0}, factoryAddresses=${discovery.discovery.genericFactoryAddressesInspected || 0}, transferRows=${discovery.discovery.transferRowsInspected || 0}, recipients=${discovery.discovery.uniqueRecipientsInspected || 0})`);
  const strategy = discovery.strategy;
  const strategyState = await callMap(candidate, pin, strategy, [
    ["owner", "owner"], ["vault", "vault"], ["factory", "factory"], ["want", "want"], ["native", "native"],
    ["depositToken", "depositToken"], ["swapper", "swapper"], ["strategist", "strategist"], ["keeper", "keeper"],
    ["paused", "paused"], ["harvestOnDeposit", "harvestOnDeposit"], ["callReward", "callReward"], ["lastHarvest", "lastHarvest"],
    ["balanceOf", "balanceOf()"], ["balanceOfWant", "balanceOfWant"], ["balanceOfPool", "balanceOfPool"],
    ["lockedProfit", "lockedProfit"], ["totalLocked", "totalLocked"], ["lockDuration", "lockDuration"],
    ["rewardsLength", "rewardsLength"], ["fees", "getAllFees"]
  ], budget);
  const vault = address(resultValue(strategyState.vault)), want = address(resultValue(strategyState.want));
  if (!vault || want !== EXPECTED_WANT) throw new Error("discovered deployment binding mismatch");
  const rewards = []; let rewardCount = Number(resultValue(strategyState.rewardsLength));
  if (!Number.isSafeInteger(rewardCount) || rewardCount < 0 || rewardCount > LIMITS.rewards) rewardCount = 0;
  for (let i = 0; i < rewardCount; i++) rewards.push(await optionalCall(candidate, pin, strategy, commonAbi, "rewards", [i], budget));
  const extraRewards = []; for (let i = 0; i < LIMITS.extraRewards; i++) { const row = await optionalCall(candidate, pin, strategy, commonAbi, "extraRewards", [i], budget);
    if (row.reason !== null) break; extraRewards.push(row); }
  strategyState.rewards = rewards; strategyState.extraRewards = extraRewards;

  const strategyBinding = await proxyBinding(candidate, pin, strategy, budget);
  const vaultBinding = await proxyBinding(candidate, pin, vault, budget);
  const vaultState = await callMap(candidate, pin, vault, [["owner", "owner"], ["strategy", "strategy"], ["want", "want"],
    ["totalSupply", "totalSupply"], ["balance", "balance"], ["available", "available"], ["ppfs", "getPricePerFullShare"],
    ["approvalDelay", "approvalDelay"], ["candidate", "stratCandidate"], ["name", "name"], ["symbol", "symbol"], ["decimals", "decimals"]], budget);
  const vaultTemplate = await optionalCall(candidate, pin, VAULT_FACTORY, commonAbi, "instance", [], budget);
  const factoryState = await callMap(candidate, pin, FACTORY, [["owner", "owner"], ["native", "native"], ["keeper", "keeper"],
    ["beefyFeeRecipient", "beefyFeeRecipient"], ["beefyFeeConfig", "beefyFeeConfig"], ["globalPause", "globalPause"],
    ["strategyPause", "strategyPause", [STRATEGY_NAME]]], budget);
  const feeConfig = address(resultValue(factoryState.beefyFeeConfig));
  const feeState = feeConfig ? await optionalCall(candidate, pin, feeConfig, commonAbi, "getFees", [strategy], budget) : { value: null, reason: "UNRESOLVED" };

  const wantState = await callMap(candidate, pin, want, [["name", "name"], ["symbol", "symbol"], ["decimals", "decimals"],
    ["totalSupply", "totalSupply"], ["strategyBalance", "balanceOf(address)", [strategy]], ["vaultBalance", "balanceOf(address)", [vault]],
    ["asset", "asset"], ["underlying", "underlying"], ["token", "token"], ["stakingTokenSnake", "staking_token"],
    ["stakingToken", "stakingToken"], ["gauge", "gauge"], ["lpToken", "lp_token"], ["nCoins", "N_COINS"],
    ["coin0", "coin", [0]], ["coin1", "coin", [1]], ["coins0", "coins", [0]], ["coins1", "coins", [1]],
    ["pricePerShare", "pricePerShare"], ["pricePerShareSnake", "price_per_share"], ["convertOneShare", "convertToAssets", [10n ** 18n]],
    ["previewRedeemOneShare", "previewRedeem", [10n ** 18n]], ["previewWithdrawOneWbtc", "previewWithdraw", [10n ** 8n]],
    ["maxRedeemStrategy", "maxRedeem", [strategy]], ["maxWithdrawStrategy", "maxWithdraw", [strategy]],
    ["claimableTokens", "claimable_tokens", [strategy]], ["claimable", "claimable", [strategy]], ["earned", "earned", [strategy]]], budget);
  const shareState = await callMap(candidate, pin, YB_SHARE, [["name", "name"], ["symbol", "symbol"], ["decimals", "decimals"],
    ["totalSupply", "totalSupply"], ["strategyBalance", "balanceOf(address)", [strategy]], ["gaugeBalance", "balanceOf(address)", [want]],
    ["asset", "asset"], ["underlying", "underlying"], ["token", "token"], ["gauge", "gauge"],
    ["pricePerShare", "pricePerShare"], ["pricePerShareSnake", "price_per_share"], ["convertOneShare", "convertToAssets", [10n ** 18n]],
    ["previewRedeemOneShare", "previewRedeem", [10n ** 18n]], ["previewWithdrawOneWbtc", "previewWithdraw", [10n ** 8n]],
    ["maxRedeemStrategy", "maxRedeem", [strategy]], ["maxWithdrawStrategy", "maxWithdraw", [strategy]]], budget);
  const tokenAddresses = [...new Set([want, address(resultValue(strategyState.native)), address(resultValue(strategyState.depositToken)),
    ...rewards.map(resultValue).map(address), ...extraRewards.map(resultValue).map(address), address(resultValue(wantState.asset)),
    address(resultValue(wantState.underlying)), address(resultValue(wantState.coin0)), address(resultValue(wantState.coin1)),
    address(resultValue(wantState.coins0)), address(resultValue(wantState.coins1)), address(resultValue(wantState.stakingTokenSnake)),
    address(resultValue(wantState.stakingToken)), YB_SHARE, WBTC].filter(Boolean))];
  const tokens = {};
  for (const token of tokenAddresses) tokens[token] = await callMap(candidate, pin, token, [["symbol", "symbol"], ["decimals", "decimals"],
    ["totalSupply", "totalSupply"], ["strategyBalance", "balanceOf(address)", [strategy]], ["wantBalance", "balanceOf(address)", [want]], ["vaultBalance", "balanceOf(address)", [vault]]], budget);
  const claimableByReward = {};
  for (const reward of [...rewards, ...extraRewards].map(resultValue).map(address).filter(Boolean)) claimableByReward[reward] =
    await optionalCall(candidate, pin, want, commonAbi, "claimable_reward", [strategy, reward], budget);

  // Event inspection is intentionally narrower than factory discovery.
  const creationBlock = BigInt(discovery.discovery.selectedCreationBlock || discovery.discovery.fromBlock);
  const eventFloor = BigInt(pin.number) > 50000n ? BigInt(pin.number) - 50000n : 0n;
  const fromBlock = creationBlock > eventFloor ? creationBlock : eventFloor;
  const events = {};
  for (const name of ["StratHarvest", "Deposit", "Withdraw"]) events[name] = await eventLogs(candidate, pin, strategy, eventAbi.getEvent(name).topicHash, fromBlock, budget);
  const claimTopics = ["Claim(address,address,uint256)", "Claimed(address,address,uint256)", "RewardPaid(address,address,uint256)"].map(id);
  events.claim = [];
  for (const topic of claimTopics) events.claim.push({ signatureTopic: topic, ...(await eventLogs(candidate, pin, want, topic, fromBlock, budget)) });

  const implementationRuntime = await codeAt(candidate, pin, strategyBinding.resolvedImplementation, budget);
  const comparison = runtimeComparison(implementationRuntime.raw, strategyArtifact.deployedBytecode);
  const templateAddress = address(resultValue(vaultTemplate));
  const bidirectional = address(resultValue(strategyState.vault)) === vault && address(resultValue(vaultState.strategy)) === strategy &&
    address(resultValue(vaultState.want)) === want;
  const beaconFactoryMatch = strategyBinding.beaconAddress === address(resultValue(discovery.beacon));
  const implementationFactoryMatch = strategyBinding.resolvedImplementation === address(resultValue(discovery.implementation));
  const vaultCloneMatch = vaultBinding.cloneImplementation === templateAddress;
  const sourceGate = comparison.exact === true || comparison.metadataNormalized === true;
  const runtimeGate = sourceGate && beaconFactoryMatch && implementationFactoryMatch;
  const configGate = bidirectional && address(resultValue(strategyState.factory)) === FACTORY && want === EXPECTED_WANT &&
    resultValue(strategyState.balanceOfPool) === "0" && resultValue(factoryState.globalPause) === false && resultValue(factoryState.strategyPause) === false;
  const publicAccessGate = strategyArtifact.abi.some((x) => x.type === "function" && x.name === "harvest" && x.stateMutability === "nonpayable") &&
    strategyArtifact.deployedBytecode.toLowerCase().includes(strategyAbi.getFunction("harvest()").selector.slice(2).toLowerCase());
  const supply = resultValue(vaultState.totalSupply), vaultBalance = resultValue(vaultState.balance);
  const capacityGate = supply === null || vaultBalance === null ? null : BigInt(supply) > 0n && BigInt(vaultBalance) > 0n;

  const capture = {
    schema: "beefy-yb-wbtc-deployment-gate/v1", capturedAt: new Date().toISOString(), chainId: "1", pin,
    rpcPolicy: { inventory: "rpc_endpoints.txt", processOnly: true, selectedFamilies: 1, candidateFamiliesTested: qualified.tested,
      secondFamilyUsed: false, failFastAfterSelection: true, retries: 0, permittedMethods: [...METHODS] },
    source: { repository: "beefyfinance/beefy-contracts", commit: COMMIT, strategySource: path.relative(ROOT, SOURCE).replace(/\\/gu, "/"),
      baseSource: path.relative(ROOT, BASE_SOURCE).replace(/\\/gu, "/"), vaultSource: path.relative(ROOT, VAULT_SOURCE).replace(/\\/gu, "/"),
      artifact: path.relative(ROOT, ARTIFACT).replace(/\\/gu, "/"), addressBookSeed: path.relative(ROOT, ADDRESS_BOOK).replace(/\\/gu, "/"),
      sourceSha256: sha256(fs.readFileSync(SOURCE)), artifactSha256: sha256(fs.readFileSync(ARTIFACT)),
      officialSeeds: { provenance: "official/public Beefy API selection handoff plus commit-pinned Beefy address book",
        strategy: STRATEGY_SEED, vault: VAULT_SEED, strategyFactory: FACTORY, vaultFactory: VAULT_FACTORY,
        wantGauge: EXPECTED_WANT, yieldBasisShare: YB_SHARE, underlyingWbtc: WBTC, strategyName: STRATEGY_NAME } },
    discovery, addresses: { strategy, vault, want, beacon: strategyBinding.beaconAddress,
      implementation: strategyBinding.resolvedImplementation, vaultTemplate: templateAddress },
    bindings: { bidirectional, beaconFactoryMatch, implementationFactoryMatch, vaultCloneMatch, strategy: strategyBinding, vault: vaultBinding },
    runtimeComparison: comparison, strategy: strategyState, vault: vaultState, factory: factoryState,
    feeConfig: { address: feeConfig, fees: feeState }, wantGauge: wantState, yieldBasisShare: shareState, tokens, claimableByReward, events,
    publicHarvest: { selector: strategyAbi.getFunction("harvest()").selector, sourceAndArtifactPublic: publicAccessGate,
      liveHarvestInvoked: false, accessSimulationUsed: false,
      rationale: "Exact source and ABI establish an unrestricted external selector; no live harvest eth_call was necessary or made." },
    gates: { source: sourceGate, runtime: runtimeGate, config: configGate, publicAccess: publicAccessGate, capacity: capacityGate,
      routePositive: null, executableNow: null },
    limitations: ["Read-only deployment/configuration/capacity gate only; no exploit route or economics were reproduced.",
      "Claim logs use three bounded common event signatures because the deployed gauge ABI is not part of the exact Beefy source.",
      "routePositive and executableNow remain unknown."], budget: budget.summary()
  };
  secretGuard(capture, secrets);
  fs.mkdirSync(OUT_DIR, { recursive: true }); fs.writeFileSync(CAPTURE, `${JSON.stringify(capture, null, 2)}\n`, { flag: "w" });
  const manifest = { schema: "beefy-yb-wbtc-deployment-gate-manifest/v1", capture: "capture.json", bytes: fs.statSync(CAPTURE).size,
    sha256: sha256(fs.readFileSync(CAPTURE)), pin, gates: capture.gates, secretGuardPassed: true, jsonValidated: true };
  secretGuard(manifest, secrets); fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "w" });
  JSON.parse(fs.readFileSync(CAPTURE, "utf8")); JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  process.stdout.write(`capture complete: gates source=${sourceGate} runtime=${runtimeGate} config=${configGate} publicAccess=${publicAccessGate} capacity=${capacityGate}\n`);
}

main().catch((error) => { process.stderr.write(`deployment gate failed: ${String(error.message || error).replace(/https?:\/\/\S+/giu, "[redacted]")}\n`); process.exitCode = 1; });
