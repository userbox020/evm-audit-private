#!/usr/bin/env node
"use strict";

// watch-euler-l.js - read-only continuous Euler EVK (Euler V2) liquidation watcher.
//
// LOOP SEMANTICS (changed): the standing watchdog form `--loop <seconds>` now defaults
// untilTrigger=FALSE (persistent; rides through non-trigger sweeps and keeps writing the
// status artifact each sweep). With no `--loop` flag the legacy untilTrigger=true default
// is preserved. `--until-trigger` remains an explicit opt-in (aave-v3-liquidation-watch convention).
//
// Mirrors the standing monitor conventions used by
// tools/aave-v3-liquidation-watch.js (per-sweep status artifact, atomic write,
// producer-health durability flags, fail-closed classification) and the
// archive-first/keyless RPC qualification pattern from
// tools/probe-liquity-v1-liquidation-activity.js / its copy family
// (tools/scan-aave-v3-borrower-universe.js).
//
// Per sweep:
//   1. Read the fresh surface artifact reports/raw/fast/euler-l.json produced by
//      tools/scan-euler-l.js (scannedAt, pin, contracts, inventory/vaults).
//   2. Qualify an RPC family in-process (archive-first keyless: blockscout + drpc,
//      then the keyless rpc_endpoints.txt pool). Endpoints stay process-only.
//   3. Live-sweep the TOP-N vaults with outstanding borrows (N <= 40) across the
//      surface artifact's top vaults plus a rotating tail. Per vault: batched
//      Multicall3 reads of asset/oracle/unitOfAccount/totalBorrows/cash/totalAssets,
//      the EVK liquidation view checkLiquidation(liquidator, violator, collateral)
//      (EVault.sol:137) for a bounded violator sample taken ONLY from the surface
//      artifact rows, and LTVBorrow/LTVLiquidation for the probed collaterals.
//   4. Emit one solvency row per vault with counts, then aggregate totals.
//
// Read-only. No private keys, no signing, no transactions, no executors. RPC
// material (URL/host/path) is NEVER printed or persisted. Fail-closed everywhere:
// a missing/stale surface artifact reports {"ok":false,"reason":"surface-artifact-missing"}
// and never fabricates candidates.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { ethers } = require("./node_modules/ethers");
const { loadRpcUrls } = require("./shared-rpc");
const { forceMonitorOnlyArtifact } = require("./monitor-minimal-env");

const WORKSPACE = path.resolve(__dirname, "..");
const SURFACE_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "euler-l.json");
const CORE_ADDRESSES = path.join(WORKSPACE, "targets", "euler-interfaces", "addresses", "1", "CoreAddresses.json");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "euler-l-watch-status.json");
const HISTORY = path.join(WORKSPACE, "reports", "raw", "fast", "euler-l-watch-history.json");

const SCHEMA = "euler-l-watch/v1";
const CHAIN_ID = 1;
const CHAIN_ID_HEX = "0x1";
const SURFACE_SCHEMA = "euler-l-observation/v1";
const HISTORY_LIMIT = 40;

// Pinned from targets/euler-interfaces/addresses/1/CoreAddresses.json.
const FACTORY_FALLBACK = "0x29a56a1b8214D9Cf7c5561811750D5cBDb45CC8e";
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
// Fixed non-violator sentinel for the checkLiquidation `liquidator` argument.
// Only used for the same-account self-liquidation guard inside the view.
const LIQUIDATOR_SENTINEL = "0x0000000000000000000000000000000000000001";

// PUBLIC_KEYLESS_ARCHIVE family (Liquity Phase 2 pattern) leads the pool.
const ARCHIVE_URLS = ["https://eth.blockscout.com/api/eth-rpc", "https://eth.drpc.org"];

const MAX_REQUESTS = 60;
const REQUEST_TIMEOUT_MS_DEFAULT = 10_000;
const REQUEST_TIMEOUT_MS_MAX = 30_000;
const RESPONSE_BOUND = 8 * 1024 * 1024;
const MAX_QUALIFY_CANDIDATES = 12;
const QUALIFY_REQUEST_CEILING = 44; // leave >= 16 requests for the sweep body
const ARCHIVE_PROBE_SPAN = 1_000_000;
const MAX_VAULTS_PER_SWEEP = 40;
const HEAD_VAULTS = 30;
const MAX_VIOLATORS_PER_VAULT = 5;
const MC_BATCH = 300;
const MAX_SURFACE_AGE_MS_DEFAULT = 90 * 60_000;
const MAX_SURFACE_AGE_MS_MAX = 24 * 60 * 60_000;
const CONSECUTIVE_QUALIFICATION_FAILURE_LIMIT = 3;

// Surface-artifact freshness bound (the standing scanner's own cadence). Overridable.
let MAX_SURFACE_AGE_MS = MAX_SURFACE_AGE_MS_DEFAULT;

const STATE_FNS = Object.freeze(["asset", "oracle", "unitOfAccount", "totalBorrows", "cash", "totalAssets"]);
const STATE_INDEX = Object.freeze(Object.fromEntries(STATE_FNS.map((fn, i) => [fn, i])));

const CODES = new Set([
  "authorized-inventory-unavailable", "no-eligible-candidates", "no-qualified-provider",
  "request-budget-exhausted", "transport-failure", "response-bound-exceeded", "rpc-error",
  "rpc-shape-failure", "chain-not-mainnet", "head-invalid", "archive-probe-unavailable",
  "surface-artifact-missing", "surface-artifact-unreadable", "surface-artifact-undated",
  "sweep-failed", "artifact-write-failure", "invalid-arguments",
]);
const safeCode = (error) => (CODES.has(error && error.message) ? error.message : "transport-failure");

const EV = new ethers.Interface([
  "function asset() view returns (address)",
  "function oracle() view returns (address)",
  "function unitOfAccount() view returns (address)",
  "function totalBorrows() view returns (uint256)",
  "function cash() view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function LTVBorrow(address collateral) view returns (uint16)",
  "function LTVLiquidation(address collateral) view returns (uint16)",
  "function checkLiquidation(address liquidator,address violator,address collateral) view returns (uint256 maxRepay,uint256 maxYield)",
]);
const MC = new ethers.Interface([
  "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[])",
]);

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function hexBlock(value) { return `0x${BigInt(value).toString(16)}`; }
function isQuantity(value) { return typeof value === "string" && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value); }
function isHash(value) { return typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value); }
function normAddr(value) {
  try { return ethers.getAddress(String(value)).toLowerCase(); } catch (_) { return null; }
}
function bigOrNull(value) {
  if (typeof value === "bigint") return value;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  try { return BigInt(value); } catch (_) { return null; }
}
function toStr(value) { return value === null || value === undefined ? null : BigInt(value).toString(); }

function argValue(args, name) {
  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : null;
}

function finitePositive(value, fallback, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) { return fallback; }
}

function pinnedFactory() {
  const core = readJson(CORE_ADDRESSES, null);
  const pinned = core && normAddr(core.eVaultFactory);
  return pinned || FACTORY_FALLBACK.toLowerCase();
}

// ---------------------------------------------------------------------------
// bounded sequential transport (10s default per request, process-only material)
// ---------------------------------------------------------------------------
function createTransport(options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch;
  const timeoutMs = finitePositive(options.timeoutMs, REQUEST_TIMEOUT_MS_DEFAULT, REQUEST_TIMEOUT_MS_MAX);
  let count = 0;
  const remaining = () => MAX_REQUESTS - count;
  async function rpc(url, method, params) {
    let lastCode = "transport-failure";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (count >= MAX_REQUESTS) throw new Error("request-budget-exhausted");
      count += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchFn(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({ jsonrpc: "2.0", id: count, method, params }),
        });
        const raw = await response.arrayBuffer();
        if (raw.byteLength > RESPONSE_BOUND) throw new Error("response-bound-exceeded");
        const body = JSON.parse(Buffer.from(raw).toString("utf8"));
        if (body && body.error) throw new Error("rpc-error");
        if (Array.isArray(body) || !body || body.result === undefined) throw new Error("rpc-shape-failure");
        return body.result;
      } catch (error) {
        lastCode = safeCode(error);
        if (attempt < 1 && ["rpc-error", "transport-failure", "rpc-shape-failure"].includes(lastCode)) {
          await delay(300);
          continue;
        }
        throw new Error(lastCode);
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(lastCode);
  }
  return { rpc, remaining, get count() { return count; } };
}

// ---------------------------------------------------------------------------
// provider pool + archive-first keyless qualification
// ---------------------------------------------------------------------------
function buildCandidatePool() {
  const pool = [];
  const seen = new Set();
  const push = (url, cls) => {
    if (typeof url !== "string" || !/^https:\/\//i.test(url) || seen.has(url)) return;
    seen.add(url);
    pool.push({ url, cls });
  };
  for (const url of ARCHIVE_URLS) push(url, "PUBLIC_KEYLESS_ARCHIVE");
  let urls = [];
  try {
    urls = loadRpcUrls({
      maxCandidates: 40,
      preferredChainId: CHAIN_ID,
      // Filter before inventory family/candidate caps. A cross-chain pool can
      // otherwise spend the entire qualification budget before mainnet reads.
      candidateFilter: (value) => {
        try {
          const url = new URL(value);
          if (/YOUR|PLACEHOLDER|<|>|\$\{|%3c|%3e/i.test(value)) return false;
          const host = url.hostname.toLowerCase();
          return host.split(".").some((label) => /^(?:eth|ethereum|eth-mainnet|ethereum-mainnet|ethereum-rpc)$/.test(label))
            || host === "mainnet.infura.io"
            || (["rpc.ankr.com", "1rpc.io", "0xrpc.io"].includes(host) && /^\/(?:eth|ethereum)(?:\/|$)/i.test(url.pathname));
        } catch (_) { return false; }
      },
    }) || [];
  } catch (_) { urls = []; }
  // Put known public mainnet reads ahead of credential/rate-limited inventory
  // rows; endpoints themselves remain process-only and still require probes.
  urls.sort((a, b) => Number(new URL(b).hostname.endsWith(".publicnode.com"))
    - Number(new URL(a).hostname.endsWith(".publicnode.com")));
  for (const url of urls) push(url, "PUBLIC_KEYLESS_INVENTORY");
  return pool.slice(0, MAX_QUALIFY_CANDIDATES);
}

async function qualifyArchive(provider, factory, transport) {
  if (await transport.rpc(provider.url, "eth_chainId", []) !== CHAIN_ID_HEX) return null;
  let head = await transport.rpc(provider.url, "eth_getBlockByNumber", ["finalized", false]).catch(() => null);
  if (!head || !isHash(head.hash) || !isQuantity(head.number)) {
    head = await transport.rpc(provider.url, "eth_getBlockByNumber", ["latest", false]);
  }
  if (!head || !isHash(head.hash) || !isQuantity(head.number)) return null;
  const headNumber = Number(BigInt(head.number));
  const probeBlock = headNumber - ARCHIVE_PROBE_SPAN;
  if (probeBlock < 1) return null;
  const hist = await transport.rpc(provider.url, "eth_getBlockByNumber", [hexBlock(probeBlock), false]);
  if (!hist || !isHash(hist.hash) || Number(BigInt(hist.number)) !== probeBlock) return null;
  const code = await transport.rpc(provider.url, "eth_getCode", [factory, hexBlock(probeBlock)]);
  if (typeof code !== "string" || code.length <= 2) return null;
  return { tier: "PUBLIC_KEYLESS_ARCHIVE", headNumber, archiveProbeBlock: probeBlock };
}

async function qualifyRead(provider, factory, transport) {
  if (await transport.rpc(provider.url, "eth_chainId", []) !== CHAIN_ID_HEX) return null;
  const head = await transport.rpc(provider.url, "eth_getBlockByNumber", ["latest", false]).catch(() => null);
  if (!head || !isHash(head.hash) || !isQuantity(head.number)) return null;
  const code = await transport.rpc(provider.url, "eth_getCode", [factory, "latest"]);
  if (typeof code !== "string" || code.length <= 2) return null;
  return { tier: "PUBLIC_KEYLESS_READ", headNumber: Number(BigInt(head.number)), archiveProbeBlock: null };
}

async function qualifyProvider(transport, factory) {
  const pool = buildCandidatePool();
  let candidatesQualified = 0;
  const attempts = [];
  // Pass 1: archive-capable (preferred).
  for (const provider of pool) {
    // Preserve a bounded read-only fallback budget if archive state is pruned.
    if (transport.count >= QUALIFY_REQUEST_CEILING - 12) break;
    try {
      const result = await qualifyArchive(provider, factory, transport);
      attempts.push({ cls: provider.cls, tier: "archive", ok: Boolean(result) });
      if (result) { candidatesQualified += 1; return { provider, ...result, candidatesQualified }; }
    } catch (_) { attempts.push({ cls: provider.cls, tier: "archive", ok: false }); }
  }
  // Pass 2: read-capable fallback (still keyless, still mainnet-pinned).
  for (const provider of pool) {
    if (transport.count >= QUALIFY_REQUEST_CEILING) break;
    try {
      const result = await qualifyRead(provider, factory, transport);
      attempts.push({ cls: provider.cls, tier: "read", ok: Boolean(result) });
      if (result) { candidatesQualified += 1; return { provider, ...result, candidatesQualified }; }
    } catch (_) { attempts.push({ cls: provider.cls, tier: "read", ok: false }); }
  }
  return { provider: null, candidatesQualified, attempts };
}

// ---------------------------------------------------------------------------
// surface artifact discovery (fail-closed)
// ---------------------------------------------------------------------------
function readSurface(file = SURFACE_FILE) {
  if (!fs.existsSync(file)) return { present: false, fresh: false, reason: "surface-artifact-missing", artifact: null };
  let artifact;
  try { artifact = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (_) { return { present: false, fresh: false, reason: "surface-artifact-unreadable", artifact: null }; }
  if (!artifact || typeof artifact !== "object") return { present: false, fresh: false, reason: "surface-artifact-unreadable", artifact: null };
  const scannedAt = Date.parse(artifact.scannedAt);
  if (!Number.isFinite(scannedAt)) return { present: true, fresh: false, reason: "surface-artifact-undated", artifact, scannedAt: null, ageMs: null };
  const ageMs = Date.now() - scannedAt;
  const fresh = ageMs <= MAX_SURFACE_AGE_MS;
  return { present: true, fresh, reason: fresh ? null : "surface-artifact-stale", artifact, scannedAt, ageMs };
}

// ---------------------------------------------------------------------------
// vault selection: surface top-borrows head + rotating tail
// ---------------------------------------------------------------------------
function selectVaults(artifact, cursor, options = {}) {
  const headTarget = Math.min(options.headVaults || HEAD_VAULTS, options.maxVaults || MAX_VAULTS_PER_SWEEP);
  const rows = artifact && Array.isArray(artifact.vaults) ? artifact.vaults : [];
  const withBorrows = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const vault = normAddr(row.vault);
    if (!vault) continue;
    const borrows = bigOrNull(row.currentTotalBorrowsRaw);
    if (borrows === null || borrows <= 0n) continue;
    withBorrows.push({ vault, borrows, row });
  }
  withBorrows.sort((a, b) => (a.borrows === b.borrows ? a.vault.localeCompare(b.vault) : (a.borrows > b.borrows ? -1 : 1)));
  const headCount = Math.min(headTarget, withBorrows.length);
  const head = withBorrows.slice(0, headCount);
  const tailPool = withBorrows.slice(headCount);
  const tailCount = Math.max(0, Math.min((options.maxVaults || MAX_VAULTS_PER_SWEEP) - headCount, tailPool.length));
  const tail = [];
  if (tailCount > 0) {
    const start = ((cursor % tailPool.length) + tailPool.length) % tailPool.length;
    for (let i = 0; i < tailCount; i += 1) tail.push(tailPool[(start + i) % tailPool.length]);
  }
  const nextCursor = tailPool.length ? (cursor + tailCount) % tailPool.length : 0;
  return { selected: [...head, ...tail], withBorrowsCount: withBorrows.length, headCount: head.length, tailCount: tail.length, nextCursor };
}

// Bounded violator sample: ONLY addresses the fresh surface artifact exposes.
function sampleViolators(row, max = MAX_VIOLATORS_PER_VAULT) {
  const events = row && Array.isArray(row.topLiquidateEvents) ? row.topLiquidateEvents : [];
  const seen = new Set();
  const checks = [];
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const violator = normAddr(event.violator);
    const collateral = normAddr(event.collateralAsset);
    if (!violator || !collateral || seen.has(violator)) continue;
    seen.add(violator);
    checks.push({ violator, collateral });
    if (checks.length >= max) break;
  }
  return checks;
}

// ---------------------------------------------------------------------------
// batched Multicall3 reads (pinned address) with bounded per-vault fallback
// ---------------------------------------------------------------------------
async function runMulticall(transport, url, tag, entries) {
  const results = new Array(entries.length).fill(null);
  let fallbacks = 0;
  let multicallSucceeded = false;
  for (let start = 0; start < entries.length; start += MC_BATCH) {
    const batch = entries.slice(start, start + MC_BATCH);
    let decoded = null;
    try {
      const tuples = batch.map((entry) => ({ target: entry.to, allowFailure: true, callData: entry.data }));
      const data = MC.encodeFunctionData("aggregate3", [tuples]);
      const raw = await transport.rpc(url, "eth_call", [{ to: MULTICALL3, data }, tag]);
      const [out] = MC.decodeFunctionResult("aggregate3", raw);
      if (Array.isArray(out) && out.length === batch.length) decoded = out;
    } catch (_) { decoded = null; }
    if (decoded === null) {
      // Per-vault fallback: direct eth_call, sequential, budget-bounded.
      for (let i = 0; i < batch.length; i += 1) {
        if (transport.remaining() <= 1) break;
        const entry = batch[i];
        try {
          const raw = await transport.rpc(url, "eth_call", [{ to: entry.to, data: entry.data }, tag]);
          results[start + i] = { success: true, returnData: raw };
        } catch (_) { results[start + i] = { success: false, returnData: "0x" }; }
        fallbacks += 1;
      }
      continue;
    }
    multicallSucceeded = true;
    decoded.forEach((item, i) => { results[start + i] = { success: item[0] === true, returnData: item[1] }; });
  }
  return { results, fallbacks, multicallSucceeded };
}

function decodeUint(iface, fn, item) {
  if (!item || item.success !== true) return null;
  try { return iface.decodeFunctionResult(fn, item.returnData)[0]; } catch (_) { return null; }
}
function decodeAddress(iface, fn, item) {
  const value = decodeUint(iface, fn, item);
  return value === null ? null : normAddr(value);
}

// ---------------------------------------------------------------------------
// sweep
// ---------------------------------------------------------------------------
async function runSweep(context) {
  const { cycle, startedAt, cursor, transport, factory, surface } = context;
  const status = {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    scanner: "tools/watch-euler-l.js",
    scope: "Read-only Euler EVK continuous liquidation/violator monitor",
    cycle,
    startedAt,
    ok: false,
    reason: null,
    reasonDetail: null,
    blockNumber: null,
    surface: {
      artifact: "reports/raw/fast/euler-l.json",
      present: surface.present === true,
      fresh: surface.fresh === true,
      scannedAt: surface.artifact ? surface.artifact.scannedAt || null : null,
      ageMs: surface.ageMs === undefined ? null : surface.ageMs,
      pin: surface.artifact && surface.artifact.pin ? {
        number: Number.isInteger(surface.artifact.pin.number) ? surface.artifact.pin.number : null,
        hash: typeof surface.artifact.pin.hash === "string" ? surface.artifact.pin.hash : null,
      } : null,
      vaultsWithBorrows: null,
      reason: surface.reason || null,
    },
    rpcQualification: { qualified: false, archiveCapable: false, tier: null, candidatesQualified: 0 },
    safety: {
      readOnly: true,
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: false,
    },
    producer_health: {
      surfaceArtifactPresent: surface.present === true,
      surfaceArtifactFresh: surface.fresh === true,
      surfaceArtifactAgeMs: surface.ageMs === undefined ? null : surface.ageMs,
      rpcQualified: false,
      rpcArchiveCapable: false,
      rpcCandidatesQualified: 0,
      sweepCompleted: false,
      liveStateRead: false,
      multicallSucceeded: false,
      multicallFallbacks: 0,
      vaultsSelected: 0,
      vaultsSwept: 0,
      consecutiveQualificationFailures: context.consecutiveQualificationFailures || 0,
      failClosed: true,
      routePositive: false,
      requests: 0,
    },
    config: {
      intervalMs: context.config.intervalMs,
      maxRuns: context.config.maxRuns,
      untilTrigger: context.config.untilTrigger,
      maxSurfaceAgeMs: MAX_SURFACE_AGE_MS,
      requestTimeoutMs: context.config.requestTimeoutMs,
      maxRequests: MAX_REQUESTS,
      maxVaultsPerSweep: MAX_VAULTS_PER_SWEEP,
    },
    rotation: { cursor, nextCursor: cursor },
    totals: {
      vaultsWithBorrowsInSurface: null,
      vaultsSelected: 0,
      vaultsSwept: 0,
      vaultsWithStateRead: 0,
      vaultsReadFailed: 0,
      liquidatableVaults: 0,
      violatorChecksAttempted: 0,
      violatorChecksHealthy: 0,
      violatorChecksLiquidatable: 0,
      violatorChecksNotProven: 0,
      stateReadsAttempted: 0,
      stateReadsSucceeded: 0,
      requests: 0,
    },
    vaults: [],
    blockers: [],
  };

  const qualification = await qualifyProvider(transport, factory);
  status.rpcQualification = {
    qualified: Boolean(qualification.provider),
    archiveCapable: qualification.tier === "PUBLIC_KEYLESS_ARCHIVE",
    tier: qualification.tier || null,
    candidatesQualified: qualification.candidatesQualified,
  };
  status.producer_health.rpcQualified = Boolean(qualification.provider);
  status.producer_health.rpcArchiveCapable = qualification.tier === "PUBLIC_KEYLESS_ARCHIVE";
  status.producer_health.rpcCandidatesQualified = qualification.candidatesQualified;

  if (!qualification.provider) {
    status.reason = "no-qualified-provider";
    status.blockers.push("no-qualified-provider");
    status.producer_health.requests = transport.count;
    status.totals.requests = transport.count;
    return { status, qualificationFailed: true, trigger: false };
  }

  const providerUrl = qualification.provider.url;
  let latest;
  try {
    latest = await transport.rpc(providerUrl, "eth_getBlockByNumber", ["latest", false]);
  } catch (_) { latest = null; }
  if (!latest || !isQuantity(latest.number)) {
    status.reason = "head-invalid";
    status.blockers.push("head-invalid");
    status.producer_health.requests = transport.count;
    status.totals.requests = transport.count;
    return { status, qualificationFailed: false, trigger: false };
  }
  const blockNumber = Number(BigInt(latest.number));
  const tag = latest.number;
  status.blockNumber = blockNumber;

  // Fail-closed: surface missing/stale still attempts live binds above, but never
  // fabricates candidates.
  if (!surface.fresh) {
    status.reason = "surface-artifact-missing";
    status.reasonDetail = surface.reason || "surface-artifact-missing";
    status.blockers.push(surface.reason || "surface-artifact-missing");
    status.producer_health.requests = transport.count;
    status.totals.requests = transport.count;
    return { status, qualificationFailed: false, trigger: false };
  }

  const selection = selectVaults(surface.artifact, cursor);
  status.surface.vaultsWithBorrows = selection.withBorrowsCount;
  status.totals.vaultsWithBorrowsInSurface = selection.withBorrowsCount;
  status.rotation = { cursor, nextCursor: selection.nextCursor };

  const plan = selection.selected.map((sel) => ({
    vault: sel.vault,
    checks: sampleViolators(sel.row),
    stateBase: 0, checkBase: 0, ltvBase: 0, collaterals: [],
  }));

  const entries = [];
  for (const item of plan) {
    item.stateBase = entries.length;
    for (const fn of STATE_FNS) entries.push({ to: item.vault, data: EV.encodeFunctionData(fn, []) });
    item.checkBase = entries.length;
    for (const check of item.checks) {
      entries.push({ to: item.vault, data: EV.encodeFunctionData("checkLiquidation", [LIQUIDATOR_SENTINEL, check.violator, check.collateral]) });
    }
    item.collaterals = [...new Set(item.checks.map((check) => check.collateral))];
    item.ltvBase = entries.length;
    for (const collateral of item.collaterals) {
      entries.push({ to: item.vault, data: EV.encodeFunctionData("LTVBorrow", [collateral]) });
      entries.push({ to: item.vault, data: EV.encodeFunctionData("LTVLiquidation", [collateral]) });
    }
  }

  let read = { results: [], fallbacks: 0, multicallSucceeded: false };
  if (entries.length > 0) read = await runMulticall(transport, providerUrl, tag, entries);
  const results = read.results;

  status.producer_health.multicallSucceeded = read.multicallSucceeded;
  status.producer_health.multicallFallbacks = read.fallbacks;

  const rows = [];
  for (const item of plan) {
    const pick = (fn) => decodeUint(EV, fn, results[item.stateBase + STATE_INDEX[fn]]);
    const totalBorrows = toStr(pick("totalBorrows"));
    const cash = toStr(pick("cash"));
    const totalAssets = toStr(pick("totalAssets"));
    const asset = decodeAddress(EV, "asset", results[item.stateBase + STATE_INDEX.asset]);
    const oracle = decodeAddress(EV, "oracle", results[item.stateBase + STATE_INDEX.oracle]);
    const unitOfAccount = decodeAddress(EV, "unitOfAccount", results[item.stateBase + STATE_INDEX.unitOfAccount]);
    const stateRead = totalBorrows !== null || cash !== null || totalAssets !== null || oracle !== null;

    const ltvByCollateral = {};
    item.collaterals.forEach((collateral, k) => {
      const borrowBps = decodeUint(EV, "LTVBorrow", results[item.ltvBase + k * 2]);
      const liquidationBps = decodeUint(EV, "LTVLiquidation", results[item.ltvBase + k * 2 + 1]);
      ltvByCollateral[collateral] = {
        borrowBps: borrowBps === null ? null : Number(borrowBps),
        liquidationBps: liquidationBps === null ? null : Number(liquidationBps),
      };
    });

    const violatorChecks = item.checks.map((check, k) => {
      const result = results[item.checkBase + k];
      let maxRepay = null;
      let maxYield = null;
      let statusCode = "not-proven-revert";
      if (result && result.success === true) {
        try {
          const decoded = EV.decodeFunctionResult("checkLiquidation", result.returnData);
          maxRepay = BigInt(decoded[0]).toString();
          maxYield = BigInt(decoded[1]).toString();
          statusCode = (BigInt(decoded[0]) > 0n || BigInt(decoded[1]) > 0n) ? "liquidatable" : "no-violation";
        } catch (_) { statusCode = "not-proven-revert"; }
      }
      // Fail-closed: only a decoded non-zero (maxRepay, maxYield) is liquidatable.
      const healthy = statusCode !== "liquidatable";
      return { violator: check.violator, collateral: check.collateral, maxRepay, maxYield, healthy, status: statusCode };
    });

    const liquidatableCount = violatorChecks.filter((check) => check.status === "liquidatable").length;
    const notProvenCount = violatorChecks.filter((check) => check.status === "not-proven-revert").length;
    const healthyCount = violatorChecks.filter((check) => check.healthy).length;

    rows.push({
      vault: item.vault,
      blockNumber,
      asset,
      oracle,
      unitOfAccount,
      totalBorrows,
      cash,
      totalAssets,
      ltvBounds: {
        byCollateral: ltvByCollateral,
        status: item.collaterals.length ? "OBSERVED_PER_COLLATERAL" : "UNAVAILABLE_NO_COLLATERAL_PARAM",
      },
      violatorChecks,
      counts: {
        violatorChecks: violatorChecks.length,
        healthy: healthyCount,
        liquidatable: liquidatableCount,
        notProven: notProvenCount,
      },
      stateRead,
      routePositive: false,
    });
  }

  status.vaults = rows;
  const totals = status.totals;
  totals.vaultsSelected = rows.length;
  totals.vaultsSwept = rows.length;
  totals.vaultsWithStateRead = rows.filter((row) => row.stateRead).length;
  totals.vaultsReadFailed = rows.filter((row) => !row.stateRead).length;
  totals.liquidatableVaults = rows.filter((row) => row.counts.liquidatable > 0).length;
  totals.violatorChecksAttempted = rows.reduce((sum, row) => sum + row.counts.violatorChecks, 0);
  totals.violatorChecksHealthy = rows.reduce((sum, row) => sum + row.counts.healthy, 0);
  totals.violatorChecksLiquidatable = rows.reduce((sum, row) => sum + row.counts.liquidatable, 0);
  totals.violatorChecksNotProven = rows.reduce((sum, row) => sum + row.counts.notProven, 0);
  totals.stateReadsAttempted = rows.length * STATE_FNS.length;
  totals.stateReadsSucceeded = totals.vaultsWithStateRead * STATE_FNS.length;

  status.producer_health.vaultsSelected = rows.length;
  status.producer_health.vaultsSwept = rows.length;
  status.producer_health.liveStateRead = totals.vaultsWithStateRead > 0;
  status.producer_health.sweepCompleted = true;
  status.producer_health.failClosed = true;

  status.ok = true;
  status.reason = null;
  status.producer_health.requests = transport.count;
  totals.requests = transport.count;

  return { status, qualificationFailed: false, trigger: totals.liquidatableVaults > 0 };
}

// ---------------------------------------------------------------------------
// atomic persistence
// ---------------------------------------------------------------------------
function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch (_) { /* already renamed */ }
  }
}

function persist(status) {
  atomicWriteJson(OUT, forceMonitorOnlyArtifact(status));
  const existing = readJson(HISTORY, []);
  const history = Array.isArray(existing) ? existing : [];
  atomicWriteJson(HISTORY, [...history.slice(-(HISTORY_LIMIT - 1)), forceMonitorOnlyArtifact(status)]);
}

function priorRotationCursor() {
  const existing = readJson(OUT, null);
  const cursor = existing && existing.rotation && Number.isInteger(existing.rotation.nextCursor) ? existing.rotation.nextCursor : 0;
  return cursor >= 0 ? cursor : 0;
}

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------
function printStatus(status, quiet) {
  const prefix = status.ok ? (status.totals.liquidatableVaults > 0 ? "TRIGGER" : "WATCH") : "FAILD";
  process.stdout.write(
    `[${prefix} cycle=${status.cycle}] block=${status.blockNumber ?? "n/a"} `
    + `vaults=${status.totals.vaultsSwept} liq=${status.totals.liquidatableVaults} `
    + `checks=${status.totals.violatorChecksAttempted} healthy=${status.totals.violatorChecksHealthy} `
    + `requests=${status.totals.requests}${status.reason ? ` reason=${status.reason}` : ""}\n`,
  );
  if (quiet) return;
  for (const row of status.vaults) {
    process.stdout.write(
      `  ${row.vault} totalBorrows=${row.totalBorrows ?? "n/a"} cash=${row.cash ?? "n/a"} `
      + `totalAssets=${row.totalAssets ?? "n/a"} checks=${row.counts.violatorChecks} liq=${row.counts.liquidatable}\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
// Pure untilTrigger resolution (exported for tests). Precedence:
//   1. an explicit `--until-trigger` always opts in (aave-v3-liquidation-watch convention);
//   2. the watchdog-manifest standing form `--loop <seconds>` is persistent: it rides
//      through non-trigger sweeps and only latches trigger state into the status artifact;
//   3. otherwise (no --loop/--once/--max-runs) the legacy untilTrigger=true default is kept.
function resolveUntilTrigger({ once, loop, explicitMaxRuns, explicitUntilTrigger }) {
  if (explicitUntilTrigger) return true;
  if (loop) return false;
  return !once && explicitMaxRuns === null;
}

// Pure loop-control decision extracted from main(): a trigger-bearing sweep stops the
// loop only when untilTrigger resolved true. With a persistent --loop this is false, so
// the runner rides through trigger-bearing sweeps instead of exiting and churning.
function shouldStopOnTrigger(untilTrigger, result) {
  return Boolean(untilTrigger) && Boolean(result && result.trigger === true);
}

function parseArgs(args) {
  const once = args.includes("--once");
  const quiet = args.includes("--quiet");
  const verbose = args.includes("--verbose");
  const loop = args.includes("--loop");
  const explicitMaxRuns = argValue(args, "--max-runs") ?? argValue(args, "--max-cycles");
  // until-trigger semantics apply when explicitly requested, or when an unbounded
  // invocation runs without a standing --loop. The watchdog calls this runner as
  // `--loop 300`, which is persistent (untilTrigger=false) so it does not exit on the
  // first trigger-bearing sweep. An explicit --max-runs cap runs exactly that many sweeps.
  const untilTrigger = resolveUntilTrigger({
    once,
    loop,
    explicitMaxRuns,
    explicitUntilTrigger: args.includes("--until-trigger"),
  });
  const intervalSeconds = loop ? Math.max(1, Number(argValue(args, "--loop") || "300") || 300) : 300;
  const intervalOverride = argValue(args, "--interval-ms");
  const intervalMs = intervalOverride !== null ? Math.max(1000, Number(intervalOverride) || 3000) : intervalSeconds * 1000;
  const maxRuns = Math.max(1, Number(explicitMaxRuns || (once ? "1" : "1000000")) || 1);
  const timeoutMs = finitePositive(argValue(args, "--timeout-ms"), REQUEST_TIMEOUT_MS_DEFAULT, REQUEST_TIMEOUT_MS_MAX);
  MAX_SURFACE_AGE_MS = finitePositive(argValue(args, "--max-surface-age-ms"), MAX_SURFACE_AGE_MS_DEFAULT, MAX_SURFACE_AGE_MS_MAX);
  return { once, quiet, verbose, untilTrigger, intervalMs, maxRuns, timeoutMs };
}

async function main(argv = process.argv.slice(2)) {
  const args = argv;
  const options = parseArgs(args);
  const startedAt = new Date().toISOString();
  const factory = pinnedFactory();
  let cursor = priorRotationCursor();
  let consecutiveQualificationFailures = 0;
  let finalStatus = null;

  if (!options.quiet) {
    process.stdout.write("Euler EVK read-only liquidation watch\n");
    process.stdout.write(`intervalMs=${options.intervalMs} maxRuns=${options.maxRuns}${options.untilTrigger ? " untilTrigger=true" : ""}\n`);
    process.stdout.write("Safety: no private keys, no signed actions, no execute calls. Endpoints process-only.\n");
  }

  for (let cycle = 1; cycle <= options.maxRuns; cycle += 1) {
    // MAX_REQUESTS bounds one sweep, not the lifetime of the standing loop.
    const transport = createTransport({ timeoutMs: options.timeoutMs });
    const surface = readSurface(SURFACE_FILE);
    let result;
    try {
      result = await runSweep({
        cycle, startedAt, cursor, transport, factory, surface,
        config: { intervalMs: options.intervalMs, maxRuns: options.maxRuns, untilTrigger: options.untilTrigger, requestTimeoutMs: options.timeoutMs },
        consecutiveQualificationFailures,
      });
    } catch (error) {
      result = {
        status: {
          schema: SCHEMA, generatedAt: new Date().toISOString(), scanner: "tools/watch-euler-l.js",
          cycle, startedAt, ok: false, reason: "sweep-failed", blockNumber: null,
          blockers: [safeCode(error)], vaults: [],
          totals: { requests: transport.count }, producer_health: { requests: transport.count },
        },
        qualificationFailed: true, trigger: false,
      };
    }
    cursor = result.status.rotation ? result.status.rotation.nextCursor : cursor;
    consecutiveQualificationFailures = result.qualificationFailed ? consecutiveQualificationFailures + 1 : 0;
    if (result.status.producer_health) result.status.producer_health.consecutiveQualificationFailures = consecutiveQualificationFailures;
    finalStatus = result.status;

    try { persist(finalStatus); }
    catch (_) {
      finalStatus.ok = false;
      finalStatus.reason = "artifact-write-failure";
      process.exitCode = 1;
      printStatus(finalStatus, options.quiet);
      return;
    }
    printStatus(finalStatus, options.quiet);

    if (options.once) break;
    if (shouldStopOnTrigger(options.untilTrigger, result)) {
      process.stdout.write("Euler EVK liquidation trigger observed (read-only stop; no action taken).\n");
      break;
    }
    if (consecutiveQualificationFailures >= CONSECUTIVE_QUALIFICATION_FAILURE_LIMIT) {
      process.stdout.write("Stopping after repeated qualification failures (fail-closed).\n");
      process.exitCode = 1;
      break;
    }
    if (cycle >= options.maxRuns) break;
    await delay(options.intervalMs);
  }

  if (finalStatus && !options.quiet) {
    process.stdout.write(`No Euler EVK liquidation action. Status artifact: ${path.relative(WORKSPACE, OUT).split(path.sep).join("/")}\n`);
  }
  if (finalStatus && finalStatus.ok === false) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`watch-euler-l failed: ${safeCode(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  WORKSPACE, SURFACE_FILE, OUT, HISTORY, SCHEMA, CHAIN_ID, HISTORY_LIMIT,
  FACTORY_FALLBACK, MULTICALL3, LIQUIDATOR_SENTINEL, ARCHIVE_URLS, MAX_REQUESTS,
  MAX_VAULTS_PER_SWEEP, HEAD_VAULTS, MAX_VIOLATORS_PER_VAULT,
  STATE_FNS, EV, MC,
  createTransport, buildCandidatePool, qualifyArchive, qualifyRead, qualifyProvider,
  readSurface, selectVaults, sampleViolators, runMulticall, runSweep, atomicWriteJson, persist, parseArgs, main,
  resolveUntilTrigger, shouldStopOnTrigger,
};
