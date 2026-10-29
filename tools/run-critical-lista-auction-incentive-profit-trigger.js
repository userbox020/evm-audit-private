#!/usr/bin/env node
"use strict";

// Narrow, read-only monitor for public reset rewards on already-active mBTC auctions.
// Endpoint material, RPC envelopes, auction ids, and actors remain process-only.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");
const { rpcCall: sharedRpcCall } = require("./shared-rpc");

const CLAIM = "critical/lista-auction-reset-trigger-producer";
const SCHEMA = "lista-auction-incentive-profit-trigger/v1";
const EVIDENCE_CLASS = "FINALIZED_MULTI_FAMILY_READ_ONLY";
const CHAIN_ID = 56;
const MAX_CANDIDATES = 8;
const REQUIRED_FAMILIES = 2;
const MAX_ACTIVE_AUCTIONS = 32;
const MAX_NETWORK_CALLS = 112;
const ROOT = path.resolve(__dirname, "..");
const INVENTORY = path.join(ROOT, "rpc_endpoints.txt");
const OUTPUT = path.join(ROOT, "reports", "monitor", "lista-auction-incentive-profit-trigger.json");
const EIP1967 = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_HASH = `0x${"0".repeat(64)}`;
const WAD = 10n ** 18n;
const RAY = 10n ** 27n;
const BLN = 10n ** 9n;

const ADDRESSES = Object.freeze({
  interaction: "0xb68443ee3e828bad1526b3e0bdf2dfc6b1975ec4",
  clip: "0x117b4a02d1bb3a32f4bf5cd6103e633b2b651063",
  oracle: "0xd5e1b35d7dfb1b20546d3bb63aee3d8b7cc66870",
  spotter: "0x49bc2c4e5b035341b7d92da4e6b267f7426f3038"
});
const BASELINE = Object.freeze({
  interactionImplementation: "0xce338985a4b241605955dd77c917aa040e110ed3",
  clipImplementation: "0x9b878823cf06fac1edb02b44eada8bb4274ab7ea",
  clipImplementationRuntimeHash: "0x2e8f86f47cbb3dcd3d803dd488140995cf0616c6e317ee63bee063dcccc745b3"
});
const ABI = Object.freeze({
  auctionWhitelistMode: ethers.id("auctionWhitelistMode()").slice(0, 10),
  count: ethers.id("count()").slice(0, 10),
  list: ethers.id("list()").slice(0, 10),
  getStatus: ethers.id("getStatus(uint256)").slice(0, 10),
  stopped: ethers.id("stopped()").slice(0, 10),
  tip: ethers.id("tip()").slice(0, 10),
  chip: ethers.id("chip()").slice(0, 10),
  chost: ethers.id("chost()").slice(0, 10),
  peek: ethers.id("peek()").slice(0, 10),
  par: ethers.id("par()").slice(0, 10)
});
const TOP_KEYS = Object.freeze(["schema", "generatedAt", "chainId", "evidenceClass", "pin", "runtime", "controls", "auctions", "economics", "trigger", "gates", "safety"]);
const PIN_KEYS = Object.freeze(["number", "hash", "stateRoot", "timestamp", "finalized", "headerFamilies", "stateFamilies"]);
const RUNTIME_KEYS = Object.freeze(["interactionImplementation", "clipImplementation", "interactionImplementationRuntimeHash", "clipImplementationRuntimeHash", "changedFromBaseline", "sourceRuntimeAttested"]);
const CONTROL_KEYS = Object.freeze(["auctionWhitelistModeRaw", "publicAuctionCaller", "stoppedRaw", "tipRad", "chipWad", "chostRad"]);
const AUCTION_KEYS = Object.freeze(["activeCount", "scannedCount", "needsRedoCount", "rewardEligibleRedoCount", "scanComplete"]);
const ECONOMICS_KEYS = Object.freeze(["status", "maximumGrossRewardRad", "maximumGrossRewardLisUSDRaw", "gasRaw", "l1FeeRaw", "competitionRaw", "uncertaintyRaw", "conservativeNetRaw", "netBps"]);
const GATE_KEYS = Object.freeze(["sourceCurrent", "runtimeBaseline", "publicCaller", "activeAuction", "eligibleRedo", "grossPositive", "economicsComplete", "conservativeNetPositive", "keylessForkJustified"]);
const SAFETY_KEYS = Object.freeze(["inventoryReadInMemoryOnly", "networkCalls", "automaticRetries", "transactions", "signing", "broadcast", "borrowerScanning", "auctionIdsPersisted"]);
const TRIGGER_REASON = Object.freeze({
  INCOMPLETE: "EVIDENCE_INCOMPLETE_ZERO_PLACEHOLDERS_ARE_NON_OBSERVATIONS",
  RUNTIME_DRIFT_REVIEW: "IMPLEMENTATION_OR_BASELINE_RUNTIME_CHANGED",
  BLOCKED_WHITELIST: "AUCTION_CALLER_NOT_PUBLIC",
  BLOCKED_STOPPED: "AUCTION_REDO_STOPPED",
  BLOCKED_NO_ACTIVE_AUCTION: "NO_ACTIVE_MBTC_AUCTION",
  BLOCKED_SCAN_CAP: "ACTIVE_AUCTION_SCAN_INCOMPLETE_OR_OVER_CAP",
  BLOCKED_NO_ELIGIBLE_REDO: "NO_REDO_SATISFIES_CHOST_TAB_AND_LOT_FEED_GATES",
  BLOCKED_NONPOSITIVE_GROSS: "MAXIMUM_ELIGIBLE_GROSS_REWARD_IS_ZERO",
  POSITIVE_GROSS_FORK_WARRANTED: "PUBLIC_ELIGIBLE_REDO_HAS_POSITIVE_GROSS_REWARD"
});

class CaptureError extends Error { constructor(code) { super(code); this.code = code; } }
function fail(code) { throw new CaptureError(code); }
function lower(value) { return String(value).toLowerCase(); }
function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function unsigned(value) { return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value); }
function nullableUnsigned(value) { return value === null || unsigned(value); }
function hash32(value) { return typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value); }
function address(value) { return typeof value === "string" && /^0x[0-9a-f]{40}$/.test(value); }
function gate(value) { return value === "PASS" || value === "FAIL" || value === "UNKNOWN"; }

function emptyEconomics(status = "NOT_RUN") {
  return {
    status, maximumGrossRewardRad: null, maximumGrossRewardLisUSDRaw: null,
    gasRaw: null, l1FeeRaw: null, competitionRaw: null, uncertaintyRaw: null,
    conservativeNetRaw: null, netBps: null
  };
}
function baseArtifact(now = Date.now) {
  return {
    schema: SCHEMA,
    generatedAt: new Date(now()).toISOString(),
    chainId: CHAIN_ID,
    evidenceClass: EVIDENCE_CLASS,
    pin: { number: "0", hash: ZERO_HASH, stateRoot: ZERO_HASH, timestamp: "0", finalized: true, headerFamilies: 0, stateFamilies: 0 },
    runtime: {
      interactionImplementation: ZERO_ADDRESS, clipImplementation: ZERO_ADDRESS,
      interactionImplementationRuntimeHash: ZERO_HASH, clipImplementationRuntimeHash: ZERO_HASH,
      changedFromBaseline: false, sourceRuntimeAttested: false
    },
    controls: { auctionWhitelistModeRaw: "0", publicAuctionCaller: false, stoppedRaw: "0", tipRad: "0", chipWad: "0", chostRad: "0" },
    auctions: { activeCount: 0, scannedCount: 0, needsRedoCount: 0, rewardEligibleRedoCount: 0, scanComplete: false },
    economics: emptyEconomics(),
    trigger: { status: "INCOMPLETE", positive: false, reason: TRIGGER_REASON.INCOMPLETE },
    gates: {
      sourceCurrent: "UNKNOWN", runtimeBaseline: "UNKNOWN", publicCaller: "UNKNOWN", activeAuction: "UNKNOWN",
      eligibleRedo: "UNKNOWN", grossPositive: "UNKNOWN", economicsComplete: "UNKNOWN",
      conservativeNetPositive: "UNKNOWN", keylessForkJustified: "UNKNOWN"
    },
    safety: {
      inventoryReadInMemoryOnly: true, networkCalls: 0, automaticRetries: 0, transactions: 0,
      signing: false, broadcast: false, borrowerScanning: false, auctionIdsPersisted: false
    }
  };
}

function validateArtifact(value) {
  try {
    if (!exactKeys(value, TOP_KEYS) || value.schema !== SCHEMA || value.evidenceClass !== EVIDENCE_CLASS
        || value.chainId !== CHAIN_ID || typeof value.generatedAt !== "string"
        || new Date(value.generatedAt).toISOString() !== value.generatedAt) return false;
    const pin = value.pin;
    if (!exactKeys(pin, PIN_KEYS) || !unsigned(pin.number) || !hash32(pin.hash) || !hash32(pin.stateRoot)
        || !unsigned(pin.timestamp) || pin.finalized !== true || !Number.isInteger(pin.headerFamilies)
        || pin.headerFamilies < 0 || pin.headerFamilies > MAX_CANDIDATES || !Number.isInteger(pin.stateFamilies)
        || pin.stateFamilies < 0 || pin.stateFamilies > pin.headerFamilies) return false;
    const runtime = value.runtime;
    if (!exactKeys(runtime, RUNTIME_KEYS) || !address(runtime.interactionImplementation) || !address(runtime.clipImplementation)
        || !hash32(runtime.interactionImplementationRuntimeHash) || !hash32(runtime.clipImplementationRuntimeHash)
        || typeof runtime.changedFromBaseline !== "boolean" || runtime.sourceRuntimeAttested !== false) return false;
    const controls = value.controls;
    if (!exactKeys(controls, CONTROL_KEYS) || !unsigned(controls.auctionWhitelistModeRaw)
        || (pin.stateFamilies >= REQUIRED_FAMILIES && controls.publicAuctionCaller !== (controls.auctionWhitelistModeRaw === "0"))
        || ![controls.stoppedRaw, controls.tipRad, controls.chipWad, controls.chostRad].every(unsigned)) return false;
    const auctions = value.auctions;
    if (!exactKeys(auctions, AUCTION_KEYS) || ![auctions.activeCount, auctions.scannedCount, auctions.needsRedoCount, auctions.rewardEligibleRedoCount].every(Number.isInteger)
        || auctions.activeCount < 0 || auctions.scannedCount < 0 || auctions.scannedCount > MAX_ACTIVE_AUCTIONS
        || auctions.needsRedoCount < 0 || auctions.rewardEligibleRedoCount < 0
        || auctions.rewardEligibleRedoCount > auctions.needsRedoCount || auctions.needsRedoCount > auctions.scannedCount
        || typeof auctions.scanComplete !== "boolean" || (auctions.scanComplete && auctions.scannedCount !== auctions.activeCount)) return false;
    const economics = value.economics;
    if (!exactKeys(economics, ECONOMICS_KEYS) || !["NOT_RUN", "INCOMPLETE", "NONPOSITIVE_GROSS", "POSITIVE_GROSS_ONLY"].includes(economics.status)
        || ![economics.maximumGrossRewardRad, economics.maximumGrossRewardLisUSDRaw, economics.gasRaw, economics.l1FeeRaw,
          economics.competitionRaw, economics.uncertaintyRaw, economics.conservativeNetRaw, economics.netBps].every(nullableUnsigned)) return false;
    if (["NONPOSITIVE_GROSS", "POSITIVE_GROSS_ONLY"].includes(economics.status)
        && (economics.maximumGrossRewardRad === null || economics.maximumGrossRewardLisUSDRaw === null)) return false;
    if (economics.status === "NONPOSITIVE_GROSS" && economics.maximumGrossRewardRad !== "0") return false;
    if (economics.status === "POSITIVE_GROSS_ONLY" && BigInt(economics.maximumGrossRewardRad) <= 0n) return false;
    if ([economics.gasRaw, economics.l1FeeRaw, economics.competitionRaw, economics.uncertaintyRaw, economics.conservativeNetRaw, economics.netBps].some((item) => item !== null)) return false;
    const trigger = value.trigger;
    if (!exactKeys(trigger, ["status", "positive", "reason"]) || !Object.hasOwn(TRIGGER_REASON, trigger.status)
        || trigger.positive !== (trigger.status === "POSITIVE_GROSS_FORK_WARRANTED") || trigger.reason !== TRIGGER_REASON[trigger.status]) return false;
    if (trigger.status !== "INCOMPLETE" && (pin.headerFamilies < REQUIRED_FAMILIES || pin.stateFamilies < REQUIRED_FAMILIES)) return false;
    if (!exactKeys(value.gates, GATE_KEYS) || !Object.values(value.gates).every(gate)
        || value.gates.sourceCurrent !== "UNKNOWN" || value.gates.economicsComplete !== "UNKNOWN"
        || value.gates.conservativeNetPositive !== "UNKNOWN") return false;
    const forkPass = !runtime.changedFromBaseline && controls.publicAuctionCaller && auctions.scanComplete
      && auctions.rewardEligibleRedoCount > 0 && economics.maximumGrossRewardRad !== null && BigInt(economics.maximumGrossRewardRad) > 0n;
    if ((value.gates.keylessForkJustified === "PASS") !== forkPass) return false;
    if (trigger.status !== "INCOMPLETE") {
      let expectedStatus;
      if (runtime.changedFromBaseline) expectedStatus = "RUNTIME_DRIFT_REVIEW";
      else if (!controls.publicAuctionCaller) expectedStatus = "BLOCKED_WHITELIST";
      else if (BigInt(controls.stoppedRaw) >= 2n) expectedStatus = "BLOCKED_STOPPED";
      else if (auctions.activeCount === 0) expectedStatus = "BLOCKED_NO_ACTIVE_AUCTION";
      else if (!auctions.scanComplete) expectedStatus = "BLOCKED_SCAN_CAP";
      else if (auctions.rewardEligibleRedoCount === 0) expectedStatus = "BLOCKED_NO_ELIGIBLE_REDO";
      else if (economics.maximumGrossRewardRad === null || BigInt(economics.maximumGrossRewardRad) <= 0n) expectedStatus = "BLOCKED_NONPOSITIVE_GROSS";
      else expectedStatus = "POSITIVE_GROSS_FORK_WARRANTED";
      if (trigger.status !== expectedStatus
          || value.gates.runtimeBaseline !== (runtime.changedFromBaseline ? "FAIL" : "PASS")
          || value.gates.publicCaller !== (controls.publicAuctionCaller ? "PASS" : "FAIL")
          || value.gates.activeAuction !== (auctions.activeCount > 0 ? "PASS" : "FAIL")
          || value.gates.eligibleRedo !== (!auctions.scanComplete ? "UNKNOWN" : auctions.rewardEligibleRedoCount > 0 ? "PASS" : "FAIL")
          || value.gates.grossPositive !== (!auctions.scanComplete ? "UNKNOWN" : economics.maximumGrossRewardRad !== null && BigInt(economics.maximumGrossRewardRad) > 0n ? "PASS" : "FAIL")
          || value.gates.keylessForkJustified !== (forkPass ? "PASS" : "FAIL")) return false;
    }
    const safety = value.safety;
    if (!exactKeys(safety, SAFETY_KEYS) || safety.inventoryReadInMemoryOnly !== true
        || !Number.isInteger(safety.networkCalls) || safety.networkCalls < 0 || safety.networkCalls > MAX_NETWORK_CALLS
        || safety.automaticRetries !== 0 || safety.transactions !== 0 || safety.signing !== false || safety.broadcast !== false
        || safety.borrowerScanning !== false || safety.auctionIdsPersisted !== false) return false;
    const serialized = JSON.stringify(value);
    return !/(?:https?|wss?):\/\/|authorization\s*:|bearer\s|api[_-]?key|rpc_endpoints|\.env\b|transactionHash|\b(?:usr|user|actor|borrower|auctionId|ids)\b/i.test(serialized);
  } catch (_) { return false; }
}

function strictHex(raw, bytes = null) {
  if (typeof raw !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(raw)) fail("ABI_HEX_INVALID");
  if (bytes !== null && (raw.length - 2) / 2 !== bytes) fail("ABI_LENGTH_INVALID");
  return lower(raw);
}
function words(raw, count) {
  const value = strictHex(raw, count * 32);
  return Array.from({ length: count }, (_, index) => value.slice(2 + index * 64, 2 + (index + 1) * 64));
}
function uintWord(word) { return BigInt(`0x${word}`); }
function decodeUint(raw) { return uintWord(words(raw, 1)[0]); }
function decodeBoolWord(word) { const value = uintWord(word); if (value !== 0n && value !== 1n) fail("ABI_BOOL_INVALID"); return value === 1n; }
function decodePeek(raw) { const value = words(raw, 2); return { value: uintWord(value[0]).toString(), valid: decodeBoolWord(value[1]) }; }
function decodeStatus(raw) {
  const value = words(raw, 4);
  return { needsRedo: decodeBoolWord(value[0]), price: uintWord(value[1]).toString(), lot: uintWord(value[2]).toString(), tab: uintWord(value[3]).toString() };
}
function decodeList(raw) {
  const value = strictHex(raw);
  if ((value.length - 2) / 2 < 64 || (value.length - 2) % 64 !== 0) fail("ABI_LIST_LENGTH_INVALID");
  const all = Array.from({ length: (value.length - 2) / 64 }, (_, index) => value.slice(2 + index * 64, 2 + (index + 1) * 64));
  if (uintWord(all[0]) !== 32n) fail("ABI_LIST_OFFSET_INVALID");
  const length = uintWord(all[1]);
  if (length > BigInt(MAX_ACTIVE_AUCTIONS) || length !== BigInt(all.length - 2)) fail("ABI_LIST_LENGTH_INVALID");
  return all.slice(2).map(uintWord);
}
function decodeImplementation(raw) {
  const word = words(raw, 1)[0];
  if (!/^0{24}[0-9a-f]{40}$/.test(word)) fail("IMPLEMENTATION_SLOT_INVALID");
  const value = `0x${word.slice(24)}`;
  if (value === ZERO_ADDRESS) fail("IMPLEMENTATION_ZERO");
  return value;
}
function parseHeader(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof raw.number !== "string"
      || typeof raw.timestamp !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(raw.hash || "")
      || !/^0x[0-9a-fA-F]{64}$/.test(raw.stateRoot || "")) fail("HEADER_SCHEMA");
  let number, timestamp;
  try { number = Number(BigInt(raw.number)); timestamp = BigInt(raw.timestamp); } catch (_) { fail("HEADER_SCHEMA"); }
  if (!Number.isSafeInteger(number) || number < 0 || timestamp < 0n) fail("HEADER_SCHEMA");
  return { number, hash: lower(raw.hash), stateRoot: lower(raw.stateRoot), timestamp: timestamp.toString() };
}
function reward(tab, tip, chip) { return tab * chip / WAD + tip; }
function feedPrice(peekValue, par) { if (par <= 0n) fail("PAR_ZERO"); return peekValue * BLN * RAY / par; }

function family(url) {
  const labels = new URL(url).hostname.toLowerCase().split(".");
  const known = ["alchemy.com", "infura.io", "quicknode.com", "quiknode.pro", "ankr.com", "publicnode.com", "1rpc.io", "0xrpc.io", "drpc.org", "nodereal.io"];
  const host = labels.join(".");
  return known.find((suffix) => host === suffix || host.endsWith(`.${suffix}`)) || (labels.length > 1 ? labels.slice(-2).join(".") : host);
}
function parseInventoryText(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 1024 * 1024) return [];
  const rows = [], seen = new Set();
  const standaloneBsc = /(^|[^a-z0-9_])bsc([^a-z0-9_]|$)/i;
  const otherChain = /(^|[^a-z0-9_])(ethereum|eth|base|arbitrum|optimism|polygon|avalanche|fantom|gnosis|linea|scroll|zksync|solana)([^a-z0-9_]|$)/i;
  const rejected = /(^|[^a-z0-9_])(testnet|chapel|op\s*bnb|bnb(?:[-_ ]+smart)?[-_ ]+chain)([^a-z0-9_]|$)/i;
  const indirect = /(url[-_ ]?pattern|template|placeholder|\bproxy\b|chain\s*id.{0,24}(body|request)|custom.{0,24}(envelope|body|request))/i;
  const template = /[<>{}\[\]$]|\b(your|replace|placeholder|template|example|invalid|localhost)\b|127\.0\.0\.1/i;
  for (const line of text.split(/\r?\n/)) {
    if (rows.length === MAX_CANDIDATES) break;
    const tokens = [...line.matchAll(/https:\/\/[^\s"'`]+/gi)].map((match) => match[0].replace(/[)>`,.;]+$/g, ""));
    if (tokens.length === 0) continue;
    let labels = line;
    for (const token of tokens) labels = labels.replace(token, " ");
    if (!standaloneBsc.test(labels) || otherChain.test(labels) || rejected.test(labels) || indirect.test(labels)) continue;
    for (const token of tokens) {
      if (rows.length === MAX_CANDIDATES || seen.has(token) || template.test(token)) continue;
      try {
        const parsed = new URL(token);
        if (parsed.protocol !== "https:" || parsed.username || parsed.password || !parsed.hostname) continue;
        const decoded = decodeURIComponent(`${parsed.pathname}${parsed.search}`);
        if (template.test(decoded) || rejected.test(`${labels} ${parsed.hostname} ${decoded}`)) continue;
        seen.add(token); rows.push(parsed.href);
      } catch (_) { /* malformed or percent-decode failure: reject */ }
    }
  }
  return rows;
}
function candidatePool(options) {
  const supplied = options.candidateUrls;
  const values = supplied || parseInventoryText(options.inventoryText === undefined ? fs.readFileSync(INVENTORY, "utf8") : options.inventoryText);
  const rows = [], seen = new Set();
  for (const value of values) {
    if (rows.length === MAX_CANDIDATES || typeof value !== "string" || !/^https:\/\//i.test(value) || seen.has(value)) continue;
    try { new URL(value); } catch (_) { continue; }
    seen.add(value); rows.push(value);
  }
  return rows;
}
function makeRpc(rawCall) {
  let networkCalls = 0;
  return Object.freeze({
    async call(url, method, params, timeout) {
      if (networkCalls >= MAX_NETWORK_CALLS) fail("NETWORK_CALL_CAP");
      networkCalls += 1;
      const result = await rawCall(url, method, params, timeout);
      if (result === null || result === undefined) fail("RPC_READ_FAILED");
      return result;
    },
    get networkCalls() { return networkCalls; }
  });
}
async function qualify(options, rpc) {
  const qualified = [], families = new Set();
  for (const url of candidatePool(options)) {
    let providerFamily;
    try { providerFamily = family(url); } catch (_) { continue; }
    if (families.has(providerFamily)) continue;
    try {
      const chainId = await rpc.call(url, "eth_chainId", [], 4000);
      if (typeof chainId !== "string" || BigInt(chainId) !== BigInt(CHAIN_ID)) continue;
      const finalized = parseHeader(await rpc.call(url, "eth_getBlockByNumber", ["finalized", false], 6500));
      families.add(providerFamily);
      qualified.push({ url, providerFamily, finalized });
      if (qualified.length === REQUIRED_FAMILIES) break;
    } catch (_) { /* exactly one attempt per RPC read */ }
  }
  if (qualified.length < REQUIRED_FAMILIES) fail("TWO_FAMILIES_UNAVAILABLE");
  return qualified;
}
async function commonPin(rows, rpc) {
  const number = Math.min(...rows.map((row) => row.finalized.number));
  const tag = ethers.toQuantity(number), groups = new Map();
  for (const row of rows) {
    try {
      const current = parseHeader(await rpc.call(row.url, "eth_getBlockByNumber", [tag, false], 6500));
      if (current.number !== number) continue;
      const key = `${current.hash}:${current.stateRoot}:${current.timestamp}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ ...row, header: current });
    } catch (_) { /* no retry */ }
  }
  const best = [...groups.values()].sort((a, b) => b.length - a.length)[0] || [];
  if (best.length < REQUIRED_FAMILIES) fail("HEADER_CONSENSUS_UNAVAILABLE");
  return { number, ...best[0].header, providers: best };
}
async function ethCall(rpc, row, to, data, tag) {
  return rpc.call(row.url, "eth_call", [{ to, data }, tag], 9000);
}
async function readState(row, tag, rpc) {
  const interactionImplementation = decodeImplementation(await rpc.call(row.url, "eth_getStorageAt", [ADDRESSES.interaction, EIP1967, tag], 8000));
  const clipImplementation = decodeImplementation(await rpc.call(row.url, "eth_getStorageAt", [ADDRESSES.clip, EIP1967, tag], 8000));
  const interactionCode = strictHex(await rpc.call(row.url, "eth_getCode", [interactionImplementation, tag], 9000));
  const clipCode = strictHex(await rpc.call(row.url, "eth_getCode", [clipImplementation, tag], 9000));
  if (interactionCode === "0x" || clipCode === "0x") fail("IMPLEMENTATION_CODE_EMPTY");
  const scalar = async (to, selector) => decodeUint(await ethCall(rpc, row, to, selector, tag));
  const auctionWhitelistMode = await scalar(ADDRESSES.interaction, ABI.auctionWhitelistMode);
  const count = await scalar(ADDRESSES.clip, ABI.count);
  const stopped = await scalar(ADDRESSES.clip, ABI.stopped);
  const tip = await scalar(ADDRESSES.clip, ABI.tip);
  const chip = await scalar(ADDRESSES.clip, ABI.chip);
  const chost = await scalar(ADDRESSES.clip, ABI.chost);
  const peek = decodePeek(await ethCall(rpc, row, ADDRESSES.oracle, ABI.peek, tag));
  const par = await scalar(ADDRESSES.spotter, ABI.par);
  if (count > BigInt(Number.MAX_SAFE_INTEGER)) fail("COUNT_UNSAFE");
  const activeCount = Number(count), statuses = [];
  if (activeCount <= MAX_ACTIVE_AUCTIONS) {
    const active = decodeList(await ethCall(rpc, row, ADDRESSES.clip, ABI.list, tag));
    if (active.length !== activeCount || new Set(active.map(String)).size !== active.length) fail("ACTIVE_LIST_INVALID");
    for (const id of active) {
      const data = `${ABI.getStatus}${ethers.toBeHex(id, 32).slice(2)}`;
      statuses.push(decodeStatus(await ethCall(rpc, row, ADDRESSES.clip, data, tag)));
    }
  }
  return {
    runtime: {
      interactionImplementation, clipImplementation,
      interactionImplementationRuntimeHash: ethers.keccak256(interactionCode),
      clipImplementationRuntimeHash: ethers.keccak256(clipCode)
    },
    auctionWhitelistMode: auctionWhitelistMode.toString(), activeCount, stopped: stopped.toString(),
    tip: tip.toString(), chip: chip.toString(), chost: chost.toString(), peek, par: par.toString(), statuses
  };
}
function stateConsensus(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = stable(row.state);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].sort((a, b) => b.length - a.length)[0] || [];
}

function applyGates(artifact, complete) {
  if (!complete) return;
  artifact.gates.runtimeBaseline = artifact.runtime.changedFromBaseline ? "FAIL" : "PASS";
  artifact.gates.publicCaller = artifact.controls.publicAuctionCaller ? "PASS" : "FAIL";
  artifact.gates.activeAuction = artifact.auctions.activeCount > 0 ? "PASS" : "FAIL";
  artifact.gates.eligibleRedo = !artifact.auctions.scanComplete ? "UNKNOWN" : artifact.auctions.rewardEligibleRedoCount > 0 ? "PASS" : "FAIL";
  artifact.gates.grossPositive = !artifact.auctions.scanComplete ? "UNKNOWN"
    : artifact.economics.maximumGrossRewardRad !== null && BigInt(artifact.economics.maximumGrossRewardRad) > 0n ? "PASS" : "FAIL";
  const justified = !artifact.runtime.changedFromBaseline && artifact.controls.publicAuctionCaller && artifact.auctions.scanComplete
    && artifact.auctions.rewardEligibleRedoCount > 0 && artifact.economics.maximumGrossRewardRad !== null
    && BigInt(artifact.economics.maximumGrossRewardRad) > 0n;
  artifact.gates.keylessForkJustified = justified ? "PASS" : "FAIL";
}

async function runTrigger(options = {}) {
  const now = options.now || Date.now;
  const artifact = baseArtifact(now);
  const rpc = makeRpc(options.rpcCall || sharedRpcCall);
  let complete = false;
  try {
    const qualified = await qualify(options, rpc);
    const pin = await commonPin(qualified, rpc);
    artifact.pin = {
      number: String(pin.number), hash: pin.hash, stateRoot: pin.stateRoot, timestamp: pin.timestamp,
      finalized: true, headerFamilies: pin.providers.length, stateFamilies: 0
    };
    const tag = ethers.toQuantity(pin.number), stateRows = [];
    for (const row of pin.providers) {
      try { stateRows.push({ row, state: await readState(row, tag, rpc) }); } catch (_) { /* no retry */ }
    }
    const stateGroup = stateConsensus(stateRows);
    artifact.pin.stateFamilies = stateGroup.length;
    if (stateGroup.length < REQUIRED_FAMILIES) fail("STATE_CONSENSUS_UNAVAILABLE");
    const state = stateGroup[0].state;
    const baseline = options.baseline || BASELINE;
    const changedFromBaseline = lower(state.runtime.interactionImplementation) !== lower(baseline.interactionImplementation)
      || lower(state.runtime.clipImplementation) !== lower(baseline.clipImplementation)
      || lower(state.runtime.clipImplementationRuntimeHash) !== lower(baseline.clipImplementationRuntimeHash);
    artifact.runtime = { ...state.runtime, changedFromBaseline, sourceRuntimeAttested: false };
    artifact.controls = {
      auctionWhitelistModeRaw: state.auctionWhitelistMode,
      publicAuctionCaller: state.auctionWhitelistMode === "0",
      stoppedRaw: state.stopped, tipRad: state.tip, chipWad: state.chip, chostRad: state.chost
    };
    artifact.auctions.activeCount = state.activeCount;
    if (state.activeCount <= MAX_ACTIVE_AUCTIONS) {
      if (state.statuses.length !== state.activeCount) fail("STATUS_SCAN_INCOMPLETE");
      artifact.auctions.scannedCount = state.statuses.length;
      artifact.auctions.needsRedoCount = state.statuses.filter((status) => status.needsRedo).length;
      if (state.activeCount > 0 && (!state.peek.valid || BigInt(state.peek.value) === 0n || BigInt(state.par) === 0n)) fail("FEED_UNAVAILABLE");
      const price = state.activeCount === 0 ? 0n : feedPrice(BigInt(state.peek.value), BigInt(state.par));
      let maximumGross = 0n;
      for (const status of state.statuses) {
        if (!status.needsRedo) continue;
        const tab = BigInt(status.tab), lot = BigInt(status.lot), chost = BigInt(state.chost);
        if (tab < chost || lot * price < chost) continue;
        artifact.auctions.rewardEligibleRedoCount += 1;
        const gross = reward(tab, BigInt(state.tip), BigInt(state.chip));
        if (gross > maximumGross) maximumGross = gross;
      }
      artifact.auctions.scanComplete = true;
      if (artifact.auctions.rewardEligibleRedoCount > 0) {
        artifact.economics = {
          ...emptyEconomics(maximumGross > 0n ? "POSITIVE_GROSS_ONLY" : "NONPOSITIVE_GROSS"),
          maximumGrossRewardRad: maximumGross.toString(),
          maximumGrossRewardLisUSDRaw: (maximumGross / RAY).toString()
        };
      } else {
        artifact.economics.maximumGrossRewardRad = "0";
        artifact.economics.maximumGrossRewardLisUSDRaw = "0";
      }
    } else {
      artifact.economics = emptyEconomics("INCOMPLETE");
    }
    complete = true;
    let status;
    if (artifact.runtime.changedFromBaseline) status = "RUNTIME_DRIFT_REVIEW";
    else if (!artifact.controls.publicAuctionCaller) status = "BLOCKED_WHITELIST";
    else if (BigInt(artifact.controls.stoppedRaw) >= 2n) status = "BLOCKED_STOPPED";
    else if (artifact.auctions.activeCount === 0) status = "BLOCKED_NO_ACTIVE_AUCTION";
    else if (!artifact.auctions.scanComplete) status = "BLOCKED_SCAN_CAP";
    else if (artifact.auctions.rewardEligibleRedoCount === 0) status = "BLOCKED_NO_ELIGIBLE_REDO";
    else if (artifact.economics.maximumGrossRewardRad === null || BigInt(artifact.economics.maximumGrossRewardRad) <= 0n) status = "BLOCKED_NONPOSITIVE_GROSS";
    else status = "POSITIVE_GROSS_FORK_WARRANTED";
    artifact.trigger = { status, positive: status === "POSITIVE_GROSS_FORK_WARRANTED", reason: TRIGGER_REASON[status] };
  } catch (_) {
    artifact.trigger = { status: "INCOMPLETE", positive: false, reason: TRIGGER_REASON.INCOMPLETE };
    if (artifact.economics.status === "POSITIVE_GROSS_ONLY" || artifact.economics.status === "NONPOSITIVE_GROSS") artifact.economics.status = "INCOMPLETE";
  } finally {
    artifact.safety.networkCalls = rpc.networkCalls;
  }
  applyGates(artifact, complete);
  if (!validateArtifact(artifact)) fail("OUTPUT_SCHEMA_INVALID");
  return artifact;
}

function fsyncDirectory(directory, fsImpl) {
  const fd = fsImpl.openSync(directory, "r");
  try { try { fsImpl.fsyncSync(fd); } catch (error) { if (!["EINVAL", "EPERM", "EBADF"].includes(error.code)) throw error; } }
  finally { fsImpl.closeSync(fd); }
}
function publishAtomic(artifact, options = {}) {
  if (!validateArtifact(artifact)) fail("OUTPUT_SCHEMA_INVALID");
  const fsImpl = options.fsImpl || fs;
  const target = path.resolve(options.outputPath || OUTPUT);
  const allowedRoot = path.resolve(options.allowedRoot || path.dirname(OUTPUT));
  if (path.dirname(target) !== allowedRoot || path.basename(target) !== "lista-auction-incentive-profit-trigger.json") fail("OUTPUT_PATH_REJECTED");
  const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
  const temporary = path.join(allowedRoot, `.lista-auction-incentive-profit-trigger.json.tmp-${process.pid}-${crypto.randomBytes(8).toString("hex")}`);
  let fd;
  try {
    fd = fsImpl.openSync(temporary, "wx", 0o600);
    fsImpl.writeFileSync(fd, bytes); fsImpl.fsyncSync(fd); fsImpl.closeSync(fd); fd = undefined;
    fsImpl.renameSync(temporary, target); fsyncDirectory(allowedRoot, fsImpl);
    const readback = fsImpl.readFileSync(target);
    if (!readback.equals(bytes) || !validateArtifact(JSON.parse(readback.toString("utf8")))) fail("READBACK_INVALID");
    return target;
  } finally {
    if (fd !== undefined) try { fsImpl.closeSync(fd); } catch (_) {}
    if (fsImpl.existsSync(temporary)) try { fsImpl.unlinkSync(temporary); } catch (_) {}
  }
}
async function runAndPublish(options = {}) { const artifact = await runTrigger(options); publishAtomic(artifact, options); return artifact; }
async function main(argv = process.argv.slice(2)) { if (argv.length !== 0) fail("ARGUMENTS_REJECTED"); await runAndPublish(); }
if (require.main === module) main().catch(() => { process.exitCode = 1; });

module.exports = Object.freeze({
  CLAIM, SCHEMA, EVIDENCE_CLASS, CHAIN_ID, MAX_CANDIDATES, MAX_ACTIVE_AUCTIONS, MAX_NETWORK_CALLS,
  ADDRESSES, BASELINE, ABI, EIP1967, OUTPUT, TRIGGER_REASON, CaptureError, baseArtifact, validateArtifact,
  decodeUint, decodePeek, decodeStatus, decodeList, decodeImplementation, parseHeader, reward, feedPrice,
  family, parseInventoryText, runTrigger, publishAtomic, runAndPublish, main
});
