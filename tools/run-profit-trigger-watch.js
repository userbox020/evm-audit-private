#!/usr/bin/env node
"use strict";

// Bounded, read-only profit-trigger watch. Emits exactly one sanitized artifact.
// RPC endpoint material, endpoint identities, and raw responses remain process-only.
// No signing, no transactions. Each producer gets bounded endpoint qualification
// and bounded per-read retry (never unbounded); it still fails closed per producer.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const shared = require("./shared-rpc");
const crossDex = require("./scan-cross-dex-arbitrage");
const joinExit = require("./scan-balancer-v2-join-exit");
const curveJoinExit = require("./scan-curve-join-exit");
const morphoBlueL = require("./scan-morpho-blue-l");
const aaveOf = require("./scan-aave-v3-of");
const aaveL = require("./scan-aave-v3-l");
const deadline = require("./lib/producer-deadline");

const CLAIM = "monitor/profit-trigger-watch-producer";
const SCHEMA = "profit-trigger-watch/v1";
const WORKSPACE = path.resolve(__dirname, "..");
const OUTPUT = path.join(WORKSPACE, "reports", "monitor", "profit-trigger-watch.json");

const MAX_NETWORK_CALLS = 96;
const RPC_TIMEOUT_MS = 9000;
const PRODUCER_TIMEOUT_MS = 20000;
const SIGN_BIT = 1n << 255n;
const TWO_256 = 1n << 256n;
const LEAK_PATTERN = /(?:https?|wss?):\/\/|authorization\s*:|bearer\s|api[_-]?key|private[_-]?key|mnemonic|rpc_endpoints|\.env\b|secret/i;

const ADDRESSES = Object.freeze({
  kelpBasePool: "0x291088312150482826b3a37d5a69a4c54daa9118",
  kelpBaseWrapper: "0xedfa23602d0ec14714057867a78d01e94176bea0",
  rseth: "0xa1290d69c65a6fe4df752f95823fae25cb99e5a7",
  ostiumVault: "0x20d419a8e12c45f88fda7c5760bb6923cee27f98",
  ostiumOpenPnl: "0xe607ac9ff58697c5978afa1fc1c5c437a6d1858c",
  metaClever: "0xeb0ea9d24235ab37196111eedd656d56ce4f53b1"
});

// Pinned baseline for the MetaCLever active strategy address list.
const STRATEGY_BASELINE = Object.freeze(["0xadc6a89d6df7374629ea3cfd0737843709d29f66"]);

// keccak256(signature)[0:4], pinned as constants to avoid an ABI dependency.
const SELECTOR = Object.freeze({
  paused: "0x5c975abb",
  getRate: "0x679aefce",
  totalSupply: "0x18160ddd",
  maxMintAmountPerDay: "0x8068f91a",
  currentPeriodMintedAmount: "0x4a9d4c47",
  getActiveYieldStrategies: "0xb2a20d25",
  maxSettlementInterval: "0xc996a956",
  lastSettlementTs: "0x5ae45c26",
  getOpenPnlWithRollover: "0x807949e9",
  lastTradePrice: "0xa70a391e"
});

const PRODUCER_IDS = Object.freeze([
  "kelp-composite",
  "ostium-settlement-window",
  "clever-harvest",
  "frax-usdc-cross-venue",
  "base-usdc-usdt-cross-venue",
  "balancer-v2-eth-cross-venue",
  "balancer-v2-base-cross-venue",
  "balancer-v2-eth-join-exit",
  "curve-eth-join-exit",
  "curve-base-join-exit",
  "morpho-blue-eth-l",
  "morpho-blue-base-l",
  "aave-v3-eth-reserve-watch",
  "aave-v3-base-reserve-watch",
  "aave-v3-eth-l",
  "aave-v3-base-l"
]);

const REASON = Object.freeze({
  BLOCKED_PAUSED: "POOL_PAUSED",
  UNPAUSE_TRIGGER: "POOL_UNPAUSED",
  WINDOW_OPEN: "SETTLEMENT_INTERVAL_ELAPSED",
  WINDOW_CLOSED: "SETTLEMENT_INTERVAL_PENDING",
  NO_CHANGE: "ACTIVE_STRATEGY_SET_UNCHANGED",
  STRATEGY_SET_CHANGED: "ACTIVE_STRATEGY_SET_CHANGED",
  NO_GROSS_EDGE: "NO_GROSS_EDGE",
  GROSS_EDGE_NET_BLOCKED: "GROSS_EDGE_NET_BLOCKED",
  ATOMIC_FORK_REQUIRED: "ATOMIC_FORK_REQUIRED",
  TIMEOUT: "PRODUCER_TIMEOUT",
  FAILED: "PRODUCER_FAILED"
});

const FAILURE_REASONS = Object.freeze([
  "ENDPOINT_UNAVAILABLE", "RPC_READ_FAILED", "RPC_CALL_CAP", "PRODUCER_TIMEOUT",
  "ABI_DECODE_FAILED", "POOL_CAP", "PRODUCER_FAILED", "SCHEMA_INVALID"
]);
const FAILURE_STATUSES = Object.freeze(["FAILED", "TIMEOUT"]);
const SUCCESS_STATUSES = Object.freeze({
  "kelp-composite": Object.freeze(["BLOCKED_PAUSED", "TRIGGER_UNPAUSE"]),
  "ostium-settlement-window": Object.freeze(["WINDOW_OPEN", "WINDOW_CLOSED"]),
  "clever-harvest": Object.freeze(["NO_CHANGE", "STRATEGY_SET_CHANGED"])
  ,"frax-usdc-cross-venue": Object.freeze(["NO_GROSS_EDGE", "GROSS_EDGE_NET_BLOCKED", "ATOMIC_FORK_REQUIRED"])
  ,"base-usdc-usdt-cross-venue": Object.freeze(["NO_GROSS_EDGE", "GROSS_EDGE_NET_BLOCKED", "ATOMIC_FORK_REQUIRED"])
  ,"balancer-v2-eth-cross-venue": Object.freeze(["NO_GROSS_EDGE", "GROSS_EDGE_NET_BLOCKED", "ATOMIC_FORK_REQUIRED"])
  ,"balancer-v2-base-cross-venue": Object.freeze(["NO_GROSS_EDGE", "GROSS_EDGE_NET_BLOCKED", "ATOMIC_FORK_REQUIRED"])
  ,"balancer-v2-eth-join-exit": Object.freeze(["NO_GROSS_EDGE", "GROSS_EDGE_NET_BLOCKED", "ATOMIC_FORK_REQUIRED"])
  ,"curve-eth-join-exit": Object.freeze(["NO_GROSS_EDGE", "GROSS_EDGE_NET_BLOCKED", "ATOMIC_FORK_REQUIRED"])
  ,"curve-base-join-exit": Object.freeze(["NO_GROSS_EDGE", "GROSS_EDGE_NET_BLOCKED", "ATOMIC_FORK_REQUIRED"])
  ,"morpho-blue-eth-l": Object.freeze(["NO_GROSS_EDGE", "GROSS_EDGE_NET_BLOCKED", "ATOMIC_FORK_REQUIRED"])
  ,"morpho-blue-base-l": Object.freeze(["NO_GROSS_EDGE", "GROSS_EDGE_NET_BLOCKED", "ATOMIC_FORK_REQUIRED"])
  ,"aave-v3-eth-reserve-watch": Object.freeze(["NO_CHANGE", "ATOMIC_FORK_REQUIRED"])
  ,"aave-v3-base-reserve-watch": Object.freeze(["NO_CHANGE", "ATOMIC_FORK_REQUIRED"])
  ,"aave-v3-eth-l": Object.freeze(["NO_GROSS_EDGE", "GROSS_EDGE_NET_BLOCKED", "ATOMIC_FORK_REQUIRED"])
  ,"aave-v3-base-l": Object.freeze(["NO_GROSS_EDGE", "GROSS_EDGE_NET_BLOCKED", "ATOMIC_FORK_REQUIRED"])
});

class WorkError extends Error {
  constructor(code) { super(code); this.name = "WorkError"; this.code = code; }
}
function fail(code) { throw new WorkError(code); }
function lower(value) { return String(value).toLowerCase(); }
function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
function iso(value) {
  if (typeof value !== "string") return false;
  try { return new Date(value).toISOString() === value; } catch (_) { return false; }
}
function unsigned(value) { return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value); }
function signed(value) { return typeof value === "string" && /^(?:0|-?[1-9][0-9]*)$/.test(value); }
function address(value) { return typeof value === "string" && /^0x[0-9a-f]{40}$/.test(value); }
function addressHex(value) {
  const raw = lower(value);
  return /^0x[0-9a-f]{40}$/.test(raw) ? raw : fail("ADDRESS_INVALID");
}
function sanitizeReason(error) {
  const code = error && typeof error.code === "string" ? error.code : "";
  const table = {
    ENDPOINT_UNAVAILABLE: "ENDPOINT_UNAVAILABLE", RPC_READ_FAILED: "RPC_READ_FAILED",
    RPC_CALL_CAP: "RPC_CALL_CAP", POOL_CAP: "POOL_CAP", TIMEOUT: "PRODUCER_TIMEOUT",
    ABI_HEX_INVALID: "ABI_DECODE_FAILED", ABI_LENGTH_INVALID: "ABI_DECODE_FAILED",
    ABI_BOOL_INVALID: "ABI_DECODE_FAILED", ABI_ADDRESS_INVALID: "ABI_DECODE_FAILED",
    ADDRESS_INVALID: "ABI_DECODE_FAILED", SELECTOR_INVALID: "ABI_DECODE_FAILED",
    BLOCK_SCHEMA: "ABI_DECODE_FAILED", SCHEMA: "SCHEMA_INVALID"
  };
  return table[code] || "PRODUCER_FAILED";
}

// --- ABI decode/encode (built-ins only) ---------------------------------------------------
function strictHex(raw) {
  if (typeof raw !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(raw)) fail("ABI_HEX_INVALID");
  return lower(raw);
}
function words(raw, count) {
  const value = strictHex(raw);
  if ((value.length - 2) / 2 !== count * 32) fail("ABI_LENGTH_INVALID");
  return Array.from({ length: count }, (_, index) => value.slice(2 + index * 64, 2 + (index + 1) * 64));
}
function decodeUint(raw) { return BigInt(`0x${words(raw, 1)[0]}`).toString(); }
function decodeInt(raw) {
  let value = BigInt(`0x${words(raw, 1)[0]}`);
  if (value >= SIGN_BIT) value -= TWO_256;
  return value.toString();
}
function decodeBool(raw) {
  const value = BigInt(`0x${words(raw, 1)[0]}`);
  if (value !== 0n && value !== 1n) fail("ABI_BOOL_INVALID");
  return value === 1n;
}
function decodeAddressWord(word) {
  if (!/^0{24}[0-9a-f]{40}$/.test(word)) fail("ABI_ADDRESS_INVALID");
  return `0x${word.slice(24)}`;
}
function decodeDynamicAddressArray(raw, offsetIndex) {
  const value = strictHex(raw);
  const totalWords = (value.length - 2) / 64;
  if (!Number.isInteger(totalWords) || totalWords < offsetIndex + 1) fail("ABI_LENGTH_INVALID");
  const wordAt = (index) => {
    if (!Number.isInteger(index) || index < 0 || index >= totalWords) fail("ABI_LENGTH_INVALID");
    return value.slice(2 + index * 64, 2 + (index + 1) * 64);
  };
  const offset = BigInt(`0x${wordAt(offsetIndex)}`);
  if (offset % 32n !== 0n || offset > BigInt(value.length)) fail("ABI_LENGTH_INVALID");
  const base = Number(offset / 32n);
  const lengthBig = BigInt(`0x${wordAt(base)}`);
  if (lengthBig > BigInt(totalWords)) fail("ABI_LENGTH_INVALID");
  const result = [];
  for (let index = 0; index < Number(lengthBig); index += 1) {
    result.push(decodeAddressWord(wordAt(base + 1 + index)));
  }
  return result;
}
function encodeWord(value) { return BigInt(value).toString(16).padStart(64, "0"); }
function encodeAddressWord(value) {
  const raw = addressHex(value).slice(2);
  return raw.padStart(64, "0");
}
function callData(to, selector, scalarWords = []) {
  const target = addressHex(to);
  const selectorHex = lower(selector);
  if (!/^0x[0-9a-f]{8}$/.test(selectorHex)) fail("SELECTOR_INVALID");
  return { to: target, data: selectorHex + scalarWords.join("") };
}
function hexQuantity(value) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) fail("BLOCK_SCHEMA");
  return BigInt(value).toString();
}
function decodeBlock(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) fail("BLOCK_SCHEMA");
  return { number: hexQuantity(result.number), timestamp: hexQuantity(result.timestamp) };
}

// --- bounded chain transport (shared helper + bounded endpoint qualification/retry) -----
const sleep = deadline.sleep;

const RPC_QUALIFY_CANDIDATES = 20;
const RPC_CALL_ATTEMPTS = 3;

function defaultRpcCandidates() {
  try { deadline.check(); return shared.loadRpcUrls({ maxCandidates: 64 }); } catch (_) { deadline.check(); return []; }
}

// Qualify a working endpoint for the chain. The primary shared resolver result is
// probed first; if it cannot serve a finalized-block read, bounded inventory
// candidates are probed for chain-id match and a finalized block. Injected
// resolver/candidate/call functions keep this unit-testable. Endpoint values stay
// process-only and are never printed or persisted.
async function resolveWorkingEndpoint(chainId, { resolveRpc, rpcCall, rpcCandidates, timeoutMs }) {
  deadline.check();
  const candidates = [];
  let primary = null;
  try { primary = await deadline.invoke(() => resolveRpc(chainId)); } catch (_) { deadline.check(); primary = null; }
  if (typeof primary === "string" && /^https?:\/\//i.test(primary)) candidates.push(primary);
  let extra = [];
  try { deadline.check(); extra = rpcCandidates ? rpcCandidates() : []; deadline.check(); } catch (_) { deadline.check(); extra = []; }
  for (const url of (Array.isArray(extra) ? extra : [])) if (!candidates.includes(url)) candidates.push(url);
  for (const url of candidates.slice(0, RPC_QUALIFY_CANDIDATES)) {
    deadline.check();
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) continue;
    try {
      const chainRaw = await deadline.invoke(() => rpcCall(url, "eth_chainId", [], timeoutMs, { signal: deadline.current()?.signal }));
      if (!chainRaw || Number(BigInt(chainRaw)) !== chainId) continue;
      const block = await deadline.invoke(() => rpcCall(url, "eth_getBlockByNumber", ["finalized", false], timeoutMs, { signal: deadline.current()?.signal }));
      if (block && block.number && block.hash) return url;
    } catch (_) { deadline.check(); /* try next candidate */ }
  }
  deadline.check();
  return typeof primary === "string" ? primary : null;
}

function createLedger() { return { calls: 0 }; }

function createChainRpc(chainId, options, ledger) {
  const resolveRpc = options.resolveRpc || shared.resolveRpc;
  const rpcCall = options.rpcCall || shared.rpcCall;
  const rpcCandidates = options.rpcCandidates || defaultRpcCandidates;
  const qualify = options.qualifyEndpoint;
  let resolved = null;
  async function call(method, params, ms) {
    deadline.check();
    if (ledger.calls >= MAX_NETWORK_CALLS) fail("RPC_CALL_CAP");
    if (resolved === null) {
      const url = qualify
        ? await deadline.invoke(() => qualify(chainId))
        : await deadline.invoke(() => resolveWorkingEndpoint(chainId, { resolveRpc, rpcCall, rpcCandidates, timeoutMs: ms || RPC_TIMEOUT_MS }));
      if (typeof url !== "string" || !/^https?:\/\//i.test(url)) fail("ENDPOINT_UNAVAILABLE");
      resolved = url;
    }
    ledger.calls += 1;
    // Bounded retry of a transient null response within the same logical read;
    // the ledger counts the logical read once, exactly as before.
    let result = null;
    for (let attempt = 0; attempt < RPC_CALL_ATTEMPTS; attempt += 1) {
      result = await deadline.invoke(() => rpcCall(resolved, method, params, ms || RPC_TIMEOUT_MS, { signal: deadline.current()?.signal }));
      if (result !== null && result !== undefined) return result;
      if (attempt < RPC_CALL_ATTEMPTS - 1) await sleep(200 * (attempt + 1));
    }
    fail("RPC_READ_FAILED");
  }
  return Object.freeze({
    chainId,
    call,
    async readUint(to, selector, scalarWords) {
      return decodeUint(await call("eth_call", [callData(to, selector, scalarWords), "latest"]));
    },
    async readInt(to, selector, scalarWords) {
      return decodeInt(await call("eth_call", [callData(to, selector, scalarWords), "latest"]));
    },
    async readBool(to, selector) {
      return decodeBool(await call("eth_call", [callData(to, selector), "latest"]));
    }
  });
}

function createContext(options, ledger) {
  const cache = new Map();
  const context = {
    now: options.now || Date.now,
    scanCrossDex: options.scanCrossDex || crossDex.scan,
    publishCrossDex: options.publishCrossDex || crossDex.publish,
    scanBaseCrossDex: options.scanBaseCrossDex || (() => crossDex.scan({ route: crossDex.BASE_ROUTE })),
    publishBaseCrossDex: options.publishBaseCrossDex || ((artifact) => crossDex.publish(artifact, { route: crossDex.BASE_ROUTE })),
    scanBalancerCrossDex: options.scanBalancerCrossDex || (() => crossDex.scan({ route: crossDex.BALANCER_ROUTE })),
    publishBalancerCrossDex: options.publishBalancerCrossDex || ((artifact) => crossDex.publish(artifact, { route: crossDex.BALANCER_ROUTE })),
    scanBalancerBaseCrossDex: options.scanBalancerBaseCrossDex || (() => crossDex.scan({ route: crossDex.BALANCER_BASE_ROUTE })),
    publishBalancerBaseCrossDex: options.publishBalancerBaseCrossDex || ((artifact) => crossDex.publish(artifact, { route: crossDex.BALANCER_BASE_ROUTE })),
    scanBalancerJoinExit: options.scanBalancerJoinExit || (() => joinExit.scan({ route: joinExit.JOIN_EXIT_ROUTE })),
    publishBalancerJoinExit: options.publishBalancerJoinExit || ((artifact) => joinExit.publish(artifact, { route: joinExit.JOIN_EXIT_ROUTE })),
    scanCurveJoinExitEth: options.scanCurveJoinExitEth || (() => curveJoinExit.scan({ route: curveJoinExit.CURVE_ETH_ROUTE })),
    publishCurveJoinExitEth: options.publishCurveJoinExitEth || ((artifact) => curveJoinExit.publish(artifact, { route: curveJoinExit.CURVE_ETH_ROUTE })),
    scanCurveJoinExitBase: options.scanCurveJoinExitBase || (() => curveJoinExit.scan({ route: curveJoinExit.CURVE_BASE_ROUTE })),
    publishCurveJoinExitBase: options.publishCurveJoinExitBase || ((artifact) => curveJoinExit.publish(artifact, { route: curveJoinExit.CURVE_BASE_ROUTE })),
    scanMorphoBlueL: options.scanMorphoBlueL || (() => morphoBlueL.scan({ full: false, chainId: 1 })),
    publishMorphoBlueL: options.publishMorphoBlueL || ((artifact) => morphoBlueL.publish(artifact)),
    scanMorphoBlueBaseL: options.scanMorphoBlueBaseL || (() => morphoBlueL.scan({ full: false, chainId: 8453 })),
    publishMorphoBlueBaseL: options.publishMorphoBlueBaseL || ((artifact) => morphoBlueL.publish(artifact)),
    scanAaveOf: options.scanAaveOf || ((chainId, triggerClass) => aaveOf.scanClass(chainId, triggerClass)),
    publishAaveOf: options.publishAaveOf || ((result) => aaveOf.publish(result)),
    scanAaveL: options.scanAaveL || (() => aaveL.scan({ full: false, chainId: 1 })),
    publishAaveL: options.publishAaveL || ((artifact) => aaveL.publish(artifact)),
    scanAaveBaseL: options.scanAaveBaseL || (() => aaveL.scan({ full: false, chainId: 8453 })),
    publishAaveBaseL: options.publishAaveBaseL || ((artifact) => aaveL.publish(artifact)),
    rpc(chainId) {
      if (!cache.has(chainId)) cache.set(chainId, createChainRpc(chainId, options, ledger));
      return cache.get(chainId);
    }
  };
  for (const key of Object.keys(context)) {
    const operation = context[key];
    if (key.startsWith("scan")) context[key] = (...args) => deadline.invoke(() => operation(...args));
    if (key.startsWith("publish")) context[key] = (...args) => {
      deadline.check();
      const result = operation(...args);
      deadline.check();
      return result;
    };
  }
  return Object.freeze(context);
}

// --- producers ----------------------------------------------------------------------------
async function runKelpComposite(ctx) {
  const base = ctx.rpc(8453);
  const eth = ctx.rpc(1);
  const poolPaused = await base.readBool(ADDRESSES.kelpBasePool, SELECTOR.paused);
  const getRate = await base.readUint(ADDRESSES.kelpBasePool, SELECTOR.getRate);
  const wrapperSupply = await base.readUint(ADDRESSES.kelpBaseWrapper, SELECTOR.totalSupply);
  const rsethPaused = await eth.readBool(ADDRESSES.rseth, SELECTOR.paused);
  const maxMintAmountPerDay = await eth.readUint(ADDRESSES.rseth, SELECTOR.maxMintAmountPerDay);
  const currentPeriodMintedAmount = await eth.readUint(ADDRESSES.rseth, SELECTOR.currentPeriodMintedAmount);
  return {
    status: poolPaused ? "BLOCKED_PAUSED" : "TRIGGER_UNPAUSE",
    reason: poolPaused ? REASON.BLOCKED_PAUSED : REASON.UNPAUSE_TRIGGER,
    evidence: {
      chainId: 8453, rsethChainId: 1,
      pool: ADDRESSES.kelpBasePool, wrapper: ADDRESSES.kelpBaseWrapper, rseth: ADDRESSES.rseth,
      poolPaused, getRate, wrapperSupply, rsethPaused, maxMintAmountPerDay, currentPeriodMintedAmount
    }
  };
}

async function runOstiumSettlement(ctx) {
  const rpc = ctx.rpc(42161);
  const block = decodeBlock(await rpc.call("eth_getBlockByNumber", ["latest", false]));
  const maxSettlementIntervalRaw = await rpc.readUint(ADDRESSES.ostiumVault, SELECTOR.maxSettlementInterval);
  const lastSettlementTsRaw = await rpc.readUint(ADDRESSES.ostiumVault, SELECTOR.lastSettlementTs);
  const openPnlRaw = await rpc.readInt(ADDRESSES.ostiumOpenPnl, SELECTOR.getOpenPnlWithRollover);
  const lastTradePricesRaw = [];
  for (let index = 0; index < 4; index += 1) {
    lastTradePricesRaw.push(await rpc.readInt(ADDRESSES.ostiumOpenPnl, SELECTOR.lastTradePrice, [encodeWord(index)]));
  }
  const due = BigInt(lastSettlementTsRaw) + BigInt(maxSettlementIntervalRaw);
  const nowTs = BigInt(block.timestamp);
  const open = nowTs >= due;
  const secondsRemaining = open ? "0" : (due - nowTs).toString();
  return {
    status: open ? "WINDOW_OPEN" : "WINDOW_CLOSED",
    reason: open ? REASON.WINDOW_OPEN : REASON.WINDOW_CLOSED,
    evidence: {
      chainId: 42161, vault: ADDRESSES.ostiumVault, openPnl: ADDRESSES.ostiumOpenPnl,
      blockNumberRaw: block.number, blockTimestampRaw: block.timestamp,
      maxSettlementIntervalRaw, lastSettlementTsRaw, settlementDueTsRaw: due.toString(),
      secondsRemaining, openPnlRaw, lastTradePricesRaw
    }
  };
}

async function runCleverHarvest(ctx) {
  const rpc = ctx.rpc(1);
  const raw = await rpc.call("eth_call", [callData(ADDRESSES.metaClever, SELECTOR.getActiveYieldStrategies), "latest"]);
  const strategies = decodeDynamicAddressArray(raw, 1);
  const changed = strategies.length !== STRATEGY_BASELINE.length
    || strategies.some((value, index) => value !== STRATEGY_BASELINE[index]);
  return {
    status: changed ? "STRATEGY_SET_CHANGED" : "NO_CHANGE",
    reason: changed ? REASON.STRATEGY_SET_CHANGED : REASON.NO_CHANGE,
    evidence: {
      chainId: 1, metaClever: ADDRESSES.metaClever,
      strategyCount: strategies.length, strategies
    }
  };
}

function crossVenueOutcome(artifact, chainId, expectedRows, allowExhaustedReserve = false) {
  const rows = artifact?.economics?.rows;
  if (!Array.isArray(rows) || rows.length !== expectedRows) fail("SCHEMA");
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)
      || !["NO_GROSS_EDGE", "GROSS_EDGE_NET_BLOCKED", "ATOMIC_FORK_REQUIRED", "FAILED"].includes(row.status)) fail("SCHEMA");
  }
  const fired = rows.filter((row) => row.status === "ATOMIC_FORK_REQUIRED");
  const failed = rows.filter((row) => {
    if (row.status !== "FAILED") return false;
    // The scanner retains reserve diagnostics on the full rows, not the
    // flattened economics rows. Bind the exact direction and input size.
    const matches = allowExhaustedReserve && Array.isArray(artifact.rows)
      ? artifact.rows.filter(item => item?.direction === row.direction && item?.amountInRaw === row.amountInRaw) : [];
    return !(matches.length === 1 && matches[0]?.economics?.status === "FAILED"
      && matches[0]?.liquidityDiagnostic?.inputExceedsRegisteredReserve === true);
  });
  const blocked = rows.filter((row) => row.status === "GROSS_EDGE_NET_BLOCKED");
  const candidates = fired.map((row) => {
    const candidate = Array.isArray(artifact.forkCandidates)
      ? artifact.forkCandidates.find((item) => item && item.eventId === row.eventId) : null;
    if (!candidate) fail("SCHEMA");
    return candidate;
  });
  // Validate every row/candidate binding before classifying a quote failure.
  if (failed.length) fail("PRODUCER_FAILED");
  const selected = fired[0] || null;
  const candidate = candidates[0] || null;
  return {
    status: selected ? "ATOMIC_FORK_REQUIRED" : blocked.length ? "GROSS_EDGE_NET_BLOCKED" : "NO_GROSS_EDGE",
    reason: selected ? REASON.ATOMIC_FORK_REQUIRED : blocked.length ? REASON.GROSS_EDGE_NET_BLOCKED : REASON.NO_GROSS_EDGE,
    evidence: {
      chainId,
      blockNumberRaw: String(artifact.pin.number),
      blockHash: artifact.pin.hash.toLowerCase(),
      blockTimestamp: artifact.pin.timestamp,
      routeCount: rows.length,
      failedCount: failed.length,
      firedCount: fired.length,
      candidate: candidate ? {
        routeKey: candidate.routeKey,
        eventId: candidate.eventId,
        direction: candidate.direction,
        amountInRaw: candidate.amountInRaw,
        expectedOutRaw: candidate.expectedOutRawAtPin,
        grossDeltaRaw: candidate.grossDeltaRawAtPin,
        gasCeilingUsdcRaw: candidate.gasCeilingUsdcRaw,
        baseFeePerGasRaw: artifact.pin.baseFeePerGasRaw,
        ethUsdRaw: artifact.oracle.ethUsdRaw,
        curvePool: candidate.curve.pool.toLowerCase(),
        uniPool: candidate.uniswapV3.pool.toLowerCase(),
      } : null,
    },
  };
}

// Single-venue Balancer V2 mint/redeem (R class). The candidate carries the
// Balancer pool/vault binding instead of the cross-venue curve/uni pair.
function joinExitOutcome(artifact, chainId, expectedRows) {
  const rows = artifact.economics?.rows;
  if (!Array.isArray(rows) || rows.length !== expectedRows) fail("SCHEMA");
  const fired = rows.filter((row) => row.status === "ATOMIC_FORK_REQUIRED");
  const failed = rows.filter((row) => row.status === "FAILED");
  const blocked = rows.filter((row) => row.status === "GROSS_EDGE_NET_BLOCKED");
  if (failed.length) fail("SCHEMA");
  const selected = fired[0] || null;
  const candidate = selected ? artifact.forkCandidates.find((row) => row.eventId === selected.eventId) : null;
  if (selected && !candidate) fail("SCHEMA");
  return {
    status: selected ? "ATOMIC_FORK_REQUIRED" : blocked.length ? "GROSS_EDGE_NET_BLOCKED" : "NO_GROSS_EDGE",
    reason: selected ? REASON.ATOMIC_FORK_REQUIRED : blocked.length ? REASON.GROSS_EDGE_NET_BLOCKED : REASON.NO_GROSS_EDGE,
    evidence: {
      chainId,
      blockNumberRaw: String(artifact.pin.number),
      blockHash: artifact.pin.hash.toLowerCase(),
      blockTimestamp: artifact.pin.timestamp,
      routeCount: rows.length,
      failedCount: failed.length,
      firedCount: fired.length,
      candidate: candidate ? {
        routeKey: candidate.routeKey,
        eventId: candidate.eventId,
        direction: candidate.direction,
        amountInRaw: candidate.amountInRaw,
        expectedOutRaw: candidate.expectedOutRawAtPin,
        grossDeltaRaw: candidate.grossDeltaRawAtPin,
        gasCeilingUsdcRaw: candidate.gasCeilingUsdcRaw,
        baseFeePerGasRaw: artifact.pin.baseFeePerGasRaw,
        ethUsdRaw: artifact.oracle.ethUsdRaw,
        pool: candidate.pool.toLowerCase(),
        poolId: candidate.poolId.toLowerCase(),
        vault: candidate.vault.toLowerCase(),
      } : null,
    },
  };
}

// Single-venue Curve LP mint/redeem (R class). The candidate binds the Curve
// pool and its LP token instead of a second venue.
function curveJoinExitOutcome(artifact, chainId, expectedRows) {
  const rows = artifact.economics?.rows;
  if (!Array.isArray(rows) || rows.length !== expectedRows) fail("SCHEMA");
  const fired = rows.filter((row) => row.status === "ATOMIC_FORK_REQUIRED");
  const failed = rows.filter((row) => row.status === "FAILED");
  const blocked = rows.filter((row) => row.status === "GROSS_EDGE_NET_BLOCKED");
  if (failed.length) fail("SCHEMA");
  const selected = fired[0] || null;
  const candidate = selected ? artifact.forkCandidates.find((row) => row.eventId === selected.eventId) : null;
  if (selected && !candidate) fail("SCHEMA");
  return {
    status: selected ? "ATOMIC_FORK_REQUIRED" : blocked.length ? "GROSS_EDGE_NET_BLOCKED" : "NO_GROSS_EDGE",
    reason: selected ? REASON.ATOMIC_FORK_REQUIRED : blocked.length ? REASON.GROSS_EDGE_NET_BLOCKED : REASON.NO_GROSS_EDGE,
    evidence: {
      chainId,
      blockNumberRaw: String(artifact.pin.number),
      blockHash: artifact.pin.hash.toLowerCase(),
      blockTimestamp: artifact.pin.timestamp,
      routeCount: rows.length,
      failedCount: failed.length,
      firedCount: fired.length,
      candidate: candidate ? {
        routeKey: candidate.routeKey,
        eventId: candidate.eventId,
        direction: candidate.direction,
        amountInRaw: candidate.amountInRaw,
        expectedOutRaw: candidate.expectedOutRawAtPin,
        grossDeltaRaw: candidate.grossDeltaRawAtPin,
        gasCeilingUsdcRaw: candidate.gasCeilingUsdcRaw,
        baseFeePerGasRaw: artifact.pin.baseFeePerGasRaw,
        ethUsdRaw: artifact.oracle.ethUsdRaw,
        pool: candidate.pool.toLowerCase(),
        lpToken: candidate.lpToken.toLowerCase(),
      } : null,
    },
  };
}

async function runFraxUsdcCrossVenue(ctx) {
  const artifact = await ctx.scanCrossDex();
  ctx.publishCrossDex(artifact);
  return crossVenueOutcome(artifact, 1, 8);
}

async function runBaseUsdcUsdtCrossVenue(ctx) {
  const artifact = await ctx.scanBaseCrossDex();
  ctx.publishBaseCrossDex(artifact);
  return crossVenueOutcome(artifact, 8453, 8);
}

async function runBalancerV2EthCrossVenue(ctx) {
  const artifact = await ctx.scanBalancerCrossDex();
  ctx.publishBalancerCrossDex(artifact);
  return crossVenueOutcome(artifact, 1, 8);
}

async function runBalancerV2BaseCrossVenue(ctx) {
  const artifact = await ctx.scanBalancerBaseCrossDex();
  ctx.publishBalancerBaseCrossDex(artifact);
  return crossVenueOutcome(artifact, 8453, 8, true);
}

async function runBalancerV2EthJoinExit(ctx) {
  const artifact = await ctx.scanBalancerJoinExit();
  ctx.publishBalancerJoinExit(artifact);
  return joinExitOutcome(artifact, 1, 6);
}

async function runCurveEthJoinExit(ctx) {
  const artifact = await ctx.scanCurveJoinExitEth();
  ctx.publishCurveJoinExitEth(artifact);
  return curveJoinExitOutcome(artifact, 1, 8);
}

async function runCurveBaseJoinExit(ctx) {
  const artifact = await ctx.scanCurveJoinExitBase();
  ctx.publishCurveJoinExitBase(artifact);
  return curveJoinExitOutcome(artifact, 8453, 6);
}

// Morpho Blue Ethereum liquidation observation. The read-only cycle re-derives
// exact actionable liquidatability (accrued to the finalized pin) and emits the
// trigger-coverage binder; it never fabricates a route-positive candidate, so it
// only ever reports NO_GROSS_EDGE (no actionable positions) or
// GROSS_EDGE_NET_BLOCKED (positions exist but no qualified unwind route). It is
// granted a larger per-producer timeout because it enumerates the whole active
// set through batched Multicall3 reads.
const MORPHO_L_USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const MORPHO_L_USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

async function runMorphoBlueL(ctx, { chainId, usdc, scanKey, publishKey }) {
  const artifact = await ctx[scanKey]();
  ctx[publishKey](artifact);
  // The binder is published first, so an incomplete enumeration is still
  // evidenced. Fail this producer closed rather than emit a success row with a
  // non-zero failed read count: that row cannot validate, and letting it reach
  // validateArtifact would abort the whole watch publish (leaving a stale
  // artifact) instead of recording one honest FAILED row.
  if (artifact.reads?.failed !== 0 || artifact.coverage?.complete === false) fail("INCOMPLETE");
  const liquidatable = artifact.totals.exactLiquidatable;
  // A candidate only promotes when the conservative view gate reports
  // routePositive for a USDC-settled loan, so the fork's actual-gas accounting is
  // single-unit. Non-USDC positives remain recorded but are not promoted by this
  // adapter. Nothing is ever fabricated.
  const positives = (artifact.valuation.candidates || []).filter(
    (row) => row.routePositive === true && String(row.loanToken).toLowerCase() === usdc,
  );
  positives.sort((a, b) => (BigInt(b.netUsdcRaw) > BigInt(a.netUsdcRaw) ? 1 : -1));
  const selected = positives[0] || null;
  let candidate = null;
  if (selected) {
    const eventId = crypto.createHash("sha256")
      .update([selected.marketId, selected.borrower, selected.collateralToken, selected.seizedCollateralRaw, selected.netUsdcRaw].join("|"))
      .digest("hex");
    candidate = {
      routeKey: eventId, eventId,
      marketId: selected.marketId, borrower: selected.borrower,
      loanToken: selected.loanToken, collateralToken: selected.collateralToken,
      oracle: selected.oracle, irm: selected.irm,
      lltv: selected.lltvRaw, seizedAssets: selected.seizedCollateralRaw,
      swapTarget: selected.swapTarget, swapHops: selected.swapHops, swapFees: selected.swapFees,
      minLoanOut: selected.minLoanOutRaw,
      principalUsdcRaw: selected.repaidUsdcRaw, expectedNetUsdcRaw: selected.netUsdcRaw,
      ethUsdRaw: artifact.valuation.ethUsdRaw, routePositive: true,
    };
  }
  const fired = selected ? 1 : 0;
  return {
    status: selected ? "ATOMIC_FORK_REQUIRED" : liquidatable > 0 ? "GROSS_EDGE_NET_BLOCKED" : "NO_GROSS_EDGE",
    reason: selected ? REASON.ATOMIC_FORK_REQUIRED : liquidatable > 0 ? REASON.GROSS_EDGE_NET_BLOCKED : REASON.NO_GROSS_EDGE,
    evidence: {
      chainId,
      blockNumberRaw: String(artifact.pin.number),
      blockHash: artifact.pin.hash.toLowerCase(),
      blockTimestamp: artifact.pin.timestamp,
      routeCount: liquidatable,
      failedCount: artifact.reads.failed,
      firedCount: fired,
      candidate,
    },
  };
}

async function runMorphoBlueEthL(ctx) {
  return runMorphoBlueL(ctx, { chainId: 1, usdc: MORPHO_L_USDC, scanKey: "scanMorphoBlueL", publishKey: "publishMorphoBlueL" });
}

async function runMorphoBlueBaseL(ctx) {
  return runMorphoBlueL(ctx, { chainId: 8453, usdc: MORPHO_L_USDC_BASE, scanKey: "scanMorphoBlueBaseL", publishKey: "publishMorphoBlueBaseL" });
}

// Aave V3 reserve-oracle (O) + flash-liquidity/fee (F) observation. Emits both
// binders for the chain and promotes only on a real anomaly (invalid oracle
// price/answer, an extreme source outage, a premium change, or zero flash
// liquidity). The keyless fixed-pin fork is a bounded state-consistency probe,
// not an extraction.
async function runAaveReserveWatch(ctx, chainId) {
  const o = await ctx.scanAaveOf(chainId, "O");
  ctx.publishAaveOf(o);
  const f = await ctx.scanAaveOf(chainId, "F");
  ctx.publishAaveOf(f);
  const anomalies = [...o.anomalies.map((row) => ({ class: "O", ...row })), ...f.anomalies.map((row) => ({ class: "F", ...row }))];
  const fired = anomalies.length > 0;
  const pin = o.artifact.pin;
  let candidate = null;
  if (fired) {
    const first = anomalies[0];
    const eventId = crypto.createHash("sha256")
      .update([chainId, first.class, first.asset || "pool", first.reason, pin.hash].join("|"))
      .digest("hex");
    candidate = { routeKey: eventId, eventId, class: first.class, anomalyReason: first.reason, asset: first.asset || null, anomalyCount: anomalies.length };
  }
  return {
    status: fired ? "ATOMIC_FORK_REQUIRED" : "NO_CHANGE",
    reason: fired ? REASON.ATOMIC_FORK_REQUIRED : REASON.NO_CHANGE,
    evidence: {
      chainId,
      blockNumberRaw: String(pin.number),
      blockHash: pin.hash.toLowerCase(),
      blockTimestamp: pin.timestamp,
      routeCount: o.artifact.reservesObserved,
      failedCount: 0,
      firedCount: fired ? 1 : 0,
      candidate,
    },
  };
}

async function runAaveV3EthReserveWatch(ctx) { return runAaveReserveWatch(ctx, 1); }
async function runAaveV3BaseReserveWatch(ctx) { return runAaveReserveWatch(ctx, 8453); }

// Aave V3 liquidation observation (Ethereum and Base). The full-history borrower
// index plus exact HF/eMode/flag math is emitted as the trigger-coverage binder;
// a candidate only promotes when a collateral->debt unwind route is genuinely
// qualified, so today (all eligible accounts are dust vs the gas ceiling) it
// reports GROSS_EDGE_NET_BLOCKED with no fired event.
async function runAaveL(ctx, chainId) {
  const baseChain = chainId === 8453;
  const artifact = baseChain ? await ctx.scanAaveBaseL() : await ctx.scanAaveL();
  (baseChain ? ctx.publishAaveBaseL : ctx.publishAaveL)(artifact);
  // See runMorphoBlueL: publish the binder, then fail this producer closed if its
  // read accounting is incomplete instead of aborting the whole watch publish.
  if (artifact.reads?.failed !== 0 || artifact.coverage?.complete === false) fail("INCOMPLETE");
  const liquidatable = artifact.totals.exactLiquidatable;
  const positives = (artifact.valuation.candidates || []).filter((row) => row.routePositive === true);
  positives.sort((a, b) => (BigInt(b.netBoundBaseRaw || "0") > BigInt(a.netBoundBaseRaw || "0") ? 1 : -1));
  const selected = positives[0] || null;
  let candidate = null;
  if (selected) {
    const eventId = crypto.createHash("sha256")
      .update([selected.user, selected.borrowAssets[0], selected.collateralAssets[0], selected.debtToCoverBaseRaw, artifact.pin.hash].join("|"))
      .digest("hex");
    candidate = {
      routeKey: eventId, eventId,
      user: selected.user, debtAsset: selected.borrowAssets[0], collateralAsset: selected.collateralAssets[0],
      debtToCoverRaw: selected.debtToCoverBaseRaw, swapTarget: selected.swapTarget,
      swapHops: selected.swapHops, swapFees: selected.swapFees,
      seizedCollateralRaw: selected.seizedCollateralRaw, minDebtOut: selected.minDebtOutRaw,
      ethUsdRaw: artifact.valuation.ethUsdRaw, routePositive: true,
    };
  }
  const fired = selected ? 1 : 0;
  return {
    status: selected ? "ATOMIC_FORK_REQUIRED" : liquidatable > 0 ? "GROSS_EDGE_NET_BLOCKED" : "NO_GROSS_EDGE",
    reason: selected ? REASON.ATOMIC_FORK_REQUIRED : liquidatable > 0 ? REASON.GROSS_EDGE_NET_BLOCKED : REASON.NO_GROSS_EDGE,
    evidence: {
      chainId, blockNumberRaw: String(artifact.pin.number), blockHash: artifact.pin.hash.toLowerCase(),
      blockTimestamp: artifact.pin.timestamp, routeCount: liquidatable, failedCount: artifact.reads.failed, firedCount: fired, candidate,
    },
  };
}

async function runAaveV3EthL(ctx) { return runAaveL(ctx, 1); }
async function runAaveV3BaseL(ctx) { return runAaveL(ctx, 8453); }

const PRODUCERS = Object.freeze([
  Object.freeze({ id: "kelp-composite", run: runKelpComposite }),
  Object.freeze({ id: "ostium-settlement-window", run: runOstiumSettlement }),
  Object.freeze({ id: "clever-harvest", run: runCleverHarvest })
  ,Object.freeze({ id: "frax-usdc-cross-venue", run: runFraxUsdcCrossVenue })
  ,Object.freeze({ id: "base-usdc-usdt-cross-venue", run: runBaseUsdcUsdtCrossVenue })
  ,Object.freeze({ id: "balancer-v2-eth-cross-venue", run: runBalancerV2EthCrossVenue })
  ,Object.freeze({ id: "balancer-v2-base-cross-venue", run: runBalancerV2BaseCrossVenue })
  ,Object.freeze({ id: "balancer-v2-eth-join-exit", run: runBalancerV2EthJoinExit })
  ,Object.freeze({ id: "curve-eth-join-exit", run: runCurveEthJoinExit })
  ,Object.freeze({ id: "curve-base-join-exit", run: runCurveBaseJoinExit })
  ,Object.freeze({ id: "morpho-blue-eth-l", run: runMorphoBlueEthL, timeoutMs: 60_000 })
  ,Object.freeze({ id: "morpho-blue-base-l", run: runMorphoBlueBaseL, timeoutMs: 150_000 })
  ,Object.freeze({ id: "aave-v3-eth-reserve-watch", run: runAaveV3EthReserveWatch, timeoutMs: 60_000 })
  ,Object.freeze({ id: "aave-v3-base-reserve-watch", run: runAaveV3BaseReserveWatch, timeoutMs: 60_000 })
  ,Object.freeze({ id: "aave-v3-eth-l", run: runAaveV3EthL, timeoutMs: 150_000 })
  ,Object.freeze({ id: "aave-v3-base-l", run: runAaveV3BaseL, timeoutMs: 150_000 })
]);

// --- artifact -----------------------------------------------------------------------------
function baseArtifact(now = Date.now, running = false) {
  return {
    schema: SCHEMA,
    generatedAt: new Date(now()).toISOString(),
    running: running === true,
    producers: PRODUCERS.map((spec) => ({
      id: spec.id, status: "FAILED", reason: REASON.FAILED, evidence: {}, generatedAt: new Date(now()).toISOString()
    })),
    safety: {
      localOnly: true, readOnly: true, automaticRetries: 0,
      transactionsInitiated: 0, signing: false, broadcast: false
    }
  };
}

// Shared exact-schema validator for the two cross-venue producers. The route
// (and therefore the chain id) is the only per-producer difference, so FRAX and
// Base share byte-identical semantics.
function crossVenueEvidence(status, evidence, chainId) {
  if (!exactKeys(evidence, ["chainId", "blockNumberRaw", "blockHash", "blockTimestamp", "routeCount", "failedCount", "firedCount", "candidate"])) return false;
  if (evidence.chainId !== chainId || !unsigned(evidence.blockNumberRaw) || !/^0x[0-9a-f]{64}$/.test(evidence.blockHash)
    || !iso(evidence.blockTimestamp) || evidence.routeCount !== 8 || evidence.failedCount !== 0
    || !Number.isSafeInteger(evidence.firedCount) || evidence.firedCount < 0 || evidence.firedCount > 8) return false;
  if (status === "ATOMIC_FORK_REQUIRED") {
    const candidate = evidence.candidate;
    if (!exactKeys(candidate, ["routeKey", "eventId", "direction", "amountInRaw", "expectedOutRaw", "grossDeltaRaw", "gasCeilingUsdcRaw", "baseFeePerGasRaw", "ethUsdRaw", "curvePool", "uniPool"])) return false;
    if (!/^[0-9a-f]{64}$/.test(candidate.routeKey) || !/^[0-9a-f]{64}$/.test(candidate.eventId)
      || !["CURVE_TO_UNIV3", "UNIV3_TO_CURVE"].includes(candidate.direction)
      || ![candidate.amountInRaw, candidate.expectedOutRaw, candidate.gasCeilingUsdcRaw, candidate.baseFeePerGasRaw, candidate.ethUsdRaw].every(unsigned)
      || !signed(candidate.grossDeltaRaw) || BigInt(candidate.grossDeltaRaw) <= BigInt(candidate.gasCeilingUsdcRaw)
      || !address(candidate.curvePool) || !address(candidate.uniPool) || evidence.firedCount < 1) return false;
  } else if (evidence.candidate !== null || evidence.firedCount !== 0) return false;
  return true;
}

// Single-venue Balancer V2 mint/redeem evidence. Same envelope as the
// cross-venue producers, but the candidate binds the Balancer pool/vault and a
// same-token mint/redeem direction.
function joinExitEvidence(status, evidence, chainId) {
  if (!exactKeys(evidence, ["chainId", "blockNumberRaw", "blockHash", "blockTimestamp", "routeCount", "failedCount", "firedCount", "candidate"])) return false;
  if (evidence.chainId !== chainId || !unsigned(evidence.blockNumberRaw) || !/^0x[0-9a-f]{64}$/.test(evidence.blockHash)
    || !iso(evidence.blockTimestamp) || evidence.routeCount !== 6 || evidence.failedCount !== 0
    || !Number.isSafeInteger(evidence.firedCount) || evidence.firedCount < 0 || evidence.firedCount > 6) return false;
  if (status === "ATOMIC_FORK_REQUIRED") {
    const candidate = evidence.candidate;
    if (!exactKeys(candidate, ["routeKey", "eventId", "direction", "amountInRaw", "expectedOutRaw", "grossDeltaRaw", "gasCeilingUsdcRaw", "baseFeePerGasRaw", "ethUsdRaw", "pool", "poolId", "vault"])) return false;
    if (!/^[0-9a-f]{64}$/.test(candidate.routeKey) || !/^[0-9a-f]{64}$/.test(candidate.eventId)
      || !["JOIN_EXIT_USDC", "JOIN_EXIT_USDT"].includes(candidate.direction)
      || ![candidate.amountInRaw, candidate.expectedOutRaw, candidate.gasCeilingUsdcRaw, candidate.baseFeePerGasRaw, candidate.ethUsdRaw].every(unsigned)
      || !signed(candidate.grossDeltaRaw) || BigInt(candidate.grossDeltaRaw) <= BigInt(candidate.gasCeilingUsdcRaw)
      || !address(candidate.pool) || !/^0x[0-9a-f]{64}$/.test(candidate.poolId) || !address(candidate.vault)
      || evidence.firedCount < 1) return false;
  } else if (evidence.candidate !== null || evidence.firedCount !== 0) return false;
  return true;
}

// Single-venue Curve LP mint/redeem evidence.
function curveJoinExitEvidence(status, evidence, chainId, expectedRows, directions) {
  if (!exactKeys(evidence, ["chainId", "blockNumberRaw", "blockHash", "blockTimestamp", "routeCount", "failedCount", "firedCount", "candidate"])) return false;
  if (evidence.chainId !== chainId || !unsigned(evidence.blockNumberRaw) || !/^0x[0-9a-f]{64}$/.test(evidence.blockHash)
    || !iso(evidence.blockTimestamp) || evidence.routeCount !== expectedRows || evidence.failedCount !== 0
    || !Number.isSafeInteger(evidence.firedCount) || evidence.firedCount < 0 || evidence.firedCount > expectedRows) return false;
  if (status === "ATOMIC_FORK_REQUIRED") {
    const candidate = evidence.candidate;
    if (!exactKeys(candidate, ["routeKey", "eventId", "direction", "amountInRaw", "expectedOutRaw", "grossDeltaRaw", "gasCeilingUsdcRaw", "baseFeePerGasRaw", "ethUsdRaw", "pool", "lpToken"])) return false;
    if (!/^[0-9a-f]{64}$/.test(candidate.routeKey) || !/^[0-9a-f]{64}$/.test(candidate.eventId)
      || !directions.includes(candidate.direction)
      || ![candidate.amountInRaw, candidate.expectedOutRaw, candidate.gasCeilingUsdcRaw, candidate.baseFeePerGasRaw, candidate.ethUsdRaw].every(unsigned)
      || !signed(candidate.grossDeltaRaw) || BigInt(candidate.grossDeltaRaw) <= BigInt(candidate.gasCeilingUsdcRaw)
      || !address(candidate.pool) || !address(candidate.lpToken) || evidence.firedCount < 1) return false;
  } else if (evidence.candidate !== null || evidence.firedCount !== 0) return false;
  return true;
}

// Morpho Blue liquidation observation (Ethereum and Base). The bound is the
// exact actionable liquidatable set at the pin; no candidate is promoted while
// the unwind valuation is unqualified, so firedCount is always zero.
function morphoLiquidationEvidence(status, evidence, chainId, usdc) {
  if (!exactKeys(evidence, ["chainId", "blockNumberRaw", "blockHash", "blockTimestamp", "routeCount", "failedCount", "firedCount", "candidate"])) return false;
  if (evidence.chainId !== chainId || !unsigned(evidence.blockNumberRaw) || !/^0x[0-9a-f]{64}$/.test(evidence.blockHash)
    || !iso(evidence.blockTimestamp)) return false;
  if (!Number.isSafeInteger(evidence.routeCount) || evidence.routeCount < 0) return false;
  if (evidence.failedCount !== 0 || !Number.isSafeInteger(evidence.firedCount) || evidence.firedCount < 0) return false;
  if (status === "ATOMIC_FORK_REQUIRED") {
    const candidate = evidence.candidate;
    if (!exactKeys(candidate, ["routeKey", "eventId", "marketId", "borrower", "loanToken", "collateralToken", "oracle", "irm", "lltv", "seizedAssets", "swapTarget", "swapHops", "swapFees", "minLoanOut", "principalUsdcRaw", "expectedNetUsdcRaw", "ethUsdRaw", "routePositive"])) return false;
    if (!/^[0-9a-f]{64}$/.test(candidate.routeKey) || candidate.routeKey !== candidate.eventId) return false;
    if (!/^0x[0-9a-f]{64}$/.test(candidate.marketId)) return false;
    if (![candidate.borrower, candidate.loanToken, candidate.collateralToken, candidate.oracle, candidate.irm, candidate.swapTarget].every((value) => address(String(value).toLowerCase()))) return false;
    if (![candidate.lltv, candidate.seizedAssets, candidate.minLoanOut, candidate.principalUsdcRaw, candidate.expectedNetUsdcRaw, candidate.ethUsdRaw].every(unsigned)) return false;
    if (candidate.routePositive !== true || BigInt(candidate.expectedNetUsdcRaw) <= 0n) return false;
    if (!Array.isArray(candidate.swapHops) || ![2, 3].includes(candidate.swapHops.length) || !candidate.swapHops.every((value) => address(String(value).toLowerCase()))) return false;
    if (!Array.isArray(candidate.swapFees) || candidate.swapFees.length !== candidate.swapHops.length - 1 || !candidate.swapFees.every((fee) => Number.isSafeInteger(fee) && fee > 0)) return false;
    if (String(candidate.loanToken).toLowerCase() !== usdc) return false;
    return evidence.firedCount >= 1;
  }
  if (evidence.candidate !== null || evidence.firedCount !== 0) return false;
  return status === (evidence.routeCount === 0 ? "NO_GROSS_EDGE" : "GROSS_EDGE_NET_BLOCKED");
}

// Aave V3 reserve-oracle / flash observation. Promotion is a bounded
// state-consistency probe, so the candidate carries the anomaly class and
// reason rather than an economic route.
function aaveReserveEvidence(status, evidence, chainId) {
  if (!exactKeys(evidence, ["chainId", "blockNumberRaw", "blockHash", "blockTimestamp", "routeCount", "failedCount", "firedCount", "candidate"])) return false;
  if (evidence.chainId !== chainId || !unsigned(evidence.blockNumberRaw) || !/^0x[0-9a-f]{64}$/.test(evidence.blockHash)
    || !iso(evidence.blockTimestamp)) return false;
  if (!Number.isSafeInteger(evidence.routeCount) || evidence.routeCount < 0) return false;
  if (evidence.failedCount !== 0 || !Number.isSafeInteger(evidence.firedCount) || evidence.firedCount < 0) return false;
  if (status === "ATOMIC_FORK_REQUIRED") {
    const candidate = evidence.candidate;
    if (!exactKeys(candidate, ["routeKey", "eventId", "class", "anomalyReason", "asset", "anomalyCount"])) return false;
    if (!/^[0-9a-f]{64}$/.test(candidate.routeKey) || candidate.routeKey !== candidate.eventId) return false;
    if (!["O", "F"].includes(candidate.class)) return false;
    if (typeof candidate.anomalyReason !== "string" || !/^[a-z0-9-]{1,64}$/.test(candidate.anomalyReason)) return false;
    if (!Number.isSafeInteger(candidate.anomalyCount) || candidate.anomalyCount < 1) return false;
    if (candidate.asset !== null && !address(String(candidate.asset).toLowerCase())) return false;
    return evidence.firedCount >= 1;
  }
  if (evidence.candidate !== null || evidence.firedCount !== 0) return false;
  return status === "NO_CHANGE";
}

// Aave V3 Ethereum liquidation observation. The bound is the exact eligible
// liquidatable set at the pin; a candidate is promoted only with a qualified
// unwind route and a candidate-bound swap.
function aaveLiquidationEvidence(status, evidence, chainId = 1) {
  if (!exactKeys(evidence, ["chainId", "blockNumberRaw", "blockHash", "blockTimestamp", "routeCount", "failedCount", "firedCount", "candidate"])) return false;
  if (evidence.chainId !== chainId || !unsigned(evidence.blockNumberRaw) || !/^0x[0-9a-f]{64}$/.test(evidence.blockHash)
    || !iso(evidence.blockTimestamp)) return false;
  if (!Number.isSafeInteger(evidence.routeCount) || evidence.routeCount < 0) return false;
  if (evidence.failedCount !== 0 || !Number.isSafeInteger(evidence.firedCount) || evidence.firedCount < 0) return false;
  if (status === "ATOMIC_FORK_REQUIRED") {
    const candidate = evidence.candidate;
    if (!exactKeys(candidate, ["routeKey", "eventId", "user", "debtAsset", "collateralAsset", "debtToCoverRaw", "swapTarget", "swapHops", "swapFees", "seizedCollateralRaw", "minDebtOut", "ethUsdRaw", "routePositive"])) return false;
    if (!/^[0-9a-f]{64}$/.test(candidate.eventId) || candidate.routeKey !== candidate.eventId) return false;
    if (![candidate.user, candidate.debtAsset, candidate.collateralAsset, candidate.swapTarget].every((value) => address(String(value).toLowerCase()))) return false;
    if (![candidate.debtToCoverRaw, candidate.seizedCollateralRaw, candidate.minDebtOut, candidate.ethUsdRaw].every(unsigned)) return false;
    if (candidate.routePositive !== true) return false;
    if (!Array.isArray(candidate.swapHops) || ![2, 3].includes(candidate.swapHops.length) || !candidate.swapHops.every((value) => address(String(value).toLowerCase()))) return false;
    if (!Array.isArray(candidate.swapFees) || candidate.swapFees.length !== candidate.swapHops.length - 1 || !candidate.swapFees.every((fee) => Number.isSafeInteger(fee) && fee > 0)) return false;
    return evidence.firedCount >= 1;
  }
  if (evidence.candidate !== null || evidence.firedCount !== 0) return false;
  if (!["NO_GROSS_EDGE", "GROSS_EDGE_NET_BLOCKED"].includes(status)) return false;
  return status === (evidence.routeCount === 0 ? "NO_GROSS_EDGE" : "GROSS_EDGE_NET_BLOCKED");
}

function validateEvidence(id, status, evidence) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return false;
  if (id === "kelp-composite") {
    if (!exactKeys(evidence, ["chainId", "rsethChainId", "pool", "wrapper", "rseth",
      "poolPaused", "getRate", "wrapperSupply", "rsethPaused",
      "maxMintAmountPerDay", "currentPeriodMintedAmount"])) return false;
    if (evidence.chainId !== 8453 || evidence.rsethChainId !== 1) return false;
    if (!address(evidence.pool) || !address(evidence.wrapper) || !address(evidence.rseth)) return false;
    if (typeof evidence.poolPaused !== "boolean" || typeof evidence.rsethPaused !== "boolean") return false;
    if (![evidence.getRate, evidence.wrapperSupply, evidence.maxMintAmountPerDay,
      evidence.currentPeriodMintedAmount].every(unsigned)) return false;
    return status === (evidence.poolPaused ? "BLOCKED_PAUSED" : "TRIGGER_UNPAUSE");
  }
  if (id === "ostium-settlement-window") {
    if (!exactKeys(evidence, ["chainId", "vault", "openPnl", "blockNumberRaw", "blockTimestampRaw",
      "maxSettlementIntervalRaw", "lastSettlementTsRaw", "settlementDueTsRaw", "secondsRemaining",
      "openPnlRaw", "lastTradePricesRaw"])) return false;
    if (evidence.chainId !== 42161 || !address(evidence.vault) || !address(evidence.openPnl)) return false;
    if (![evidence.blockNumberRaw, evidence.blockTimestampRaw, evidence.maxSettlementIntervalRaw,
      evidence.lastSettlementTsRaw, evidence.settlementDueTsRaw, evidence.secondsRemaining].every(unsigned)) return false;
    if (!signed(evidence.openPnlRaw) || !Array.isArray(evidence.lastTradePricesRaw)
      || evidence.lastTradePricesRaw.length !== 4 || !evidence.lastTradePricesRaw.every(signed)) return false;
    if (BigInt(evidence.settlementDueTsRaw)
      !== BigInt(evidence.lastSettlementTsRaw) + BigInt(evidence.maxSettlementIntervalRaw)) return false;
    const open = BigInt(evidence.blockTimestampRaw) >= BigInt(evidence.settlementDueTsRaw);
    return status === (open ? "WINDOW_OPEN" : "WINDOW_CLOSED");
  }
  if (id === "clever-harvest") {
    if (!exactKeys(evidence, ["chainId", "metaClever", "strategyCount", "strategies"])) return false;
    if (evidence.chainId !== 1 || !address(evidence.metaClever)) return false;
    if (!Number.isInteger(evidence.strategyCount) || evidence.strategyCount < 0) return false;
    if (!Array.isArray(evidence.strategies) || !evidence.strategies.every(address)) return false;
    if (evidence.strategyCount !== evidence.strategies.length) return false;
    const changed = evidence.strategies.length !== STRATEGY_BASELINE.length
      || evidence.strategies.some((value, index) => value !== STRATEGY_BASELINE[index]);
    return status === (changed ? "STRATEGY_SET_CHANGED" : "NO_CHANGE");
  }
  if (id === "frax-usdc-cross-venue") return crossVenueEvidence(status, evidence, 1);
  if (id === "base-usdc-usdt-cross-venue") return crossVenueEvidence(status, evidence, 8453);
  if (id === "balancer-v2-eth-cross-venue") return crossVenueEvidence(status, evidence, 1);
  if (id === "balancer-v2-base-cross-venue") return crossVenueEvidence(status, evidence, 8453);
  if (id === "balancer-v2-eth-join-exit") return joinExitEvidence(status, evidence, 1);
  if (id === "curve-eth-join-exit") return curveJoinExitEvidence(status, evidence, 1, 8, ["ADD_REMOVE_FRAX", "ADD_REMOVE_USDC"]);
  if (id === "curve-base-join-exit") return curveJoinExitEvidence(status, evidence, 8453, 6, ["ADD_REMOVE_USDC", "ADD_REMOVE_USDT"]);
  if (id === "morpho-blue-eth-l") return morphoLiquidationEvidence(status, evidence, 1, MORPHO_L_USDC);
  if (id === "morpho-blue-base-l") return morphoLiquidationEvidence(status, evidence, 8453, MORPHO_L_USDC_BASE);
  if (id === "aave-v3-eth-reserve-watch") return aaveReserveEvidence(status, evidence, 1);
  if (id === "aave-v3-base-reserve-watch") return aaveReserveEvidence(status, evidence, 8453);
  if (id === "aave-v3-eth-l") return aaveLiquidationEvidence(status, evidence, 1);
  if (id === "aave-v3-base-l") return aaveLiquidationEvidence(status, evidence, 8453);
  return false;
}

function validateArtifact(value) {
  try {
    if (!exactKeys(value, ["schema", "generatedAt", "running", "producers", "safety"])) return false;
    if (value.schema !== SCHEMA || !iso(value.generatedAt) || typeof value.running !== "boolean") return false;
    if (!Array.isArray(value.producers) || value.producers.length !== PRODUCER_IDS.length) return false;
    for (let index = 0; index < PRODUCER_IDS.length; index += 1) {
      const row = value.producers[index], id = PRODUCER_IDS[index];
      if (!exactKeys(row, ["id", "status", "reason", "evidence", "generatedAt"])) return false;
      if (row.id !== id || !iso(row.generatedAt)) return false;
      if (typeof row.reason !== "string" || !/^[A-Z0-9_]{1,64}$/.test(row.reason)) return false;
      const allowed = [...SUCCESS_STATUSES[id], ...FAILURE_STATUSES];
      if (!allowed.includes(row.status)) return false;
      if (FAILURE_STATUSES.includes(row.status)) {
        if (!exactKeys(row.evidence, []) || !FAILURE_REASONS.includes(row.reason)) return false;
      } else if (!validateEvidence(id, row.status, row.evidence)) return false;
    }
    const safety = value.safety;
    if (!exactKeys(safety, ["localOnly", "readOnly", "automaticRetries", "transactionsInitiated", "signing", "broadcast"])) return false;
    if (safety.localOnly !== true || safety.readOnly !== true || safety.automaticRetries !== 0
      || safety.transactionsInitiated !== 0 || safety.signing !== false || safety.broadcast !== false) return false;
    return !LEAK_PATTERN.test(JSON.stringify(value));
  } catch (_) { return false; }
}

function withTimeout(promiseFactory, ms) {
  return deadline.run(promiseFactory, ms);
}

async function runOnce(options = {}) {
  const now = options.now || Date.now;
  const ledger = createLedger();
  const ctx = createContext(options, ledger);
  const timeoutMs = Number.isSafeInteger(options.producerTimeoutMs) && options.producerTimeoutMs > 0
    ? options.producerTimeoutMs : PRODUCER_TIMEOUT_MS;
  const producers = [];
  for (const spec of PRODUCERS) {
    const row = { id: spec.id, status: "FAILED", reason: REASON.FAILED, evidence: {}, generatedAt: new Date(now()).toISOString() };
    try {
      const result = await withTimeout(() => spec.run(ctx), spec.timeoutMs || timeoutMs);
      row.status = result.status;
      row.reason = result.reason;
      row.evidence = result.evidence;
    } catch (error) {
      if (error instanceof deadline.DeadlineError && error.code === "DRAIN_UNCONFIRMED") throw error;
      if (error instanceof deadline.DeadlineError && error.code === "TIMEOUT") {
        row.status = "TIMEOUT";
        row.reason = REASON.TIMEOUT;
      } else {
        row.status = "FAILED";
        row.reason = sanitizeReason(error);
      }
      row.evidence = {};
    }
    row.generatedAt = new Date(now()).toISOString();
    producers.push(row);
  }
  const artifact = {
    schema: SCHEMA,
    generatedAt: new Date(now()).toISOString(),
    running: options.running === true,
    producers,
    safety: {
      localOnly: true, readOnly: true, automaticRetries: 0,
      transactionsInitiated: 0, signing: false, broadcast: false
    }
  };
  if (!validateArtifact(artifact)) fail("SCHEMA");
  return artifact;
}

// --- publish ------------------------------------------------------------------------------
function fsyncDirectory(directory, fsImpl) {
  const descriptor = fsImpl.openSync(directory, "r");
  try { try { fsImpl.fsyncSync(descriptor); } catch (error) { if (!["EINVAL", "EPERM", "EBADF"].includes(error.code)) throw error; } }
  finally { fsImpl.closeSync(descriptor); }
}

function publishAtomic(artifact, options = {}) {
  if (!validateArtifact(artifact)) fail("SCHEMA");
  const fsImpl = options.fsImpl || fs;
  const target = path.resolve(options.outputPath || OUTPUT);
  const allowedRoot = path.resolve(options.allowedRoot || path.dirname(OUTPUT));
  if (path.dirname(target) !== allowedRoot || path.basename(target) !== "profit-trigger-watch.json") fail("SCHEMA");
  const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
  const temporary = path.join(allowedRoot, `.profit-trigger-watch.json.tmp-${process.pid}-${crypto.randomBytes(8).toString("hex")}`);
  let descriptor;
  try {
    descriptor = fsImpl.openSync(temporary, "wx", 0o600);
    fsImpl.writeFileSync(descriptor, bytes);
    fsImpl.fsyncSync(descriptor);
    fsImpl.closeSync(descriptor);
    descriptor = undefined;
    fsImpl.renameSync(temporary, target);
    fsyncDirectory(allowedRoot, fsImpl);
    const readback = fsImpl.readFileSync(target);
    if (!readback.equals(bytes) || !validateArtifact(JSON.parse(readback.toString("utf8")))) fail("SCHEMA");
    return target;
  } finally {
    if (descriptor !== undefined) try { fsImpl.closeSync(descriptor); } catch (_) {}
    if (fsImpl.existsSync(temporary)) try { fsImpl.unlinkSync(temporary); } catch (_) {}
  }
}

// Scheduled-surface refresh for the Balancer V3 coverage binders (F, X, R). The
// 240 s EVM-Audit-Profit-Trigger-Watch task calls this every cycle so the covered
// V3 rows cannot expire inside their 900 s window. Non-fatal and bounded: a
// scanner failure never blocks the watch artifact or the other scanner.
async function refreshBalancerV3CoverageBinders() {
  const result = { flash: null, xr: null, morphoF: null };
  try { result.flash = await require("./scan-balancer-v3-coverage.js").refresh({}); } catch (_) { /* non-fatal */ }
  try { result.xr = await require("./scan-balancer-v3-xr.js").refresh({}); } catch (_) { /* non-fatal */ }
  try { result.morphoF = require("./scan-morpho-f-coverage.js").refresh({}); } catch (_) { /* non-fatal */ }
  return result;
}

async function runAndPublish(options = {}) {
  const artifact = await runOnce(options);
  publishAtomic(artifact, options);
  if (options.refreshCoverageBinders !== false) await refreshBalancerV3CoverageBinders();
  return artifact;
}

async function main(argv = process.argv.slice(2)) {
  const unknown = argv.filter((value) => value !== "--run-once");
  if (unknown.length !== 0) { process.exitCode = 1; return; }
  if (!argv.includes("--run-once")) {
    process.stdout.write("profit-trigger-watch: bounded read-only monitor; pass --run-once to execute.\n");
    return;
  }
  const artifact = await runAndPublish({ running: false });
  process.stdout.write(`${JSON.stringify({
    status: "OK",
    artifact: path.relative(WORKSPACE, OUTPUT).split(path.sep).join("/"),
    producers: artifact.producers.map((row) => ({ id: row.id, status: row.status }))
  })}\n`);
}
if (require.main === module) main().catch(() => { process.exitCode = 1; });

module.exports = Object.freeze({
  CLAIM, SCHEMA, OUTPUT, MAX_NETWORK_CALLS, PRODUCER_IDS, SELECTOR, ADDRESSES, STRATEGY_BASELINE,
  REASON, FAILURE_REASONS, SUCCESS_STATUSES, WorkError, baseArtifact, validateArtifact, validateEvidence,
  decodeUint, decodeInt, decodeBool, decodeAddressWord, decodeDynamicAddressArray, encodeWord,
  encodeAddressWord, callData, decodeBlock, resolveWorkingEndpoint, createChainRpc, createContext, runOnce, publishAtomic,
  runFraxUsdcCrossVenue, runBaseUsdcUsdtCrossVenue, runBalancerV2EthCrossVenue, runBalancerV2BaseCrossVenue,
  runBalancerV2EthJoinExit, runCurveEthJoinExit, runCurveBaseJoinExit, runMorphoBlueEthL, runMorphoBlueBaseL,
  runAaveV3EthReserveWatch, runAaveV3BaseReserveWatch, aaveReserveEvidence,
  runAaveV3EthL, runAaveV3BaseL, aaveLiquidationEvidence,
  MORPHO_L_USDC, MORPHO_L_USDC_BASE, morphoLiquidationEvidence, refreshBalancerV3CoverageBinders, runAndPublish, main
});
