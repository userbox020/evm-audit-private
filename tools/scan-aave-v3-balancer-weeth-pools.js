#!/usr/bin/env node
"use strict";

// scan-aave-v3-balancer-weeth-pools.js
// Read-only, fail-closed enumeration of Balancer V2 mainnet pools that hold BOTH
// WETH (0xC02a...6cc2) and weETH (0xCd5f...b7ee). Resolves the single honest
// blocker in the Aave V3 exact-quote lane: no WETH/weETH Balancer pool id exists
// in any prior artifact.
//
// Method (bounded, ordered, fail-closed):
//   1. Qualify an archive-capable, keyless provider (chainId 0x1 + finalized/latest
//      head + historical-log read). The PUBLIC_KEYLESS_ARCHIVE family pattern is the
//      one fixed in the Liquity Phase 2 work (tools/liquity-fork-rehearsal.js).
//   2. Scan Vault.PoolRegistered(bytes32,address,uint8) backward from the head in
//      <= 500k-block windows (policy "adaptive-windows-v2"); on provider range limits,
//      halve the chunk automatically and record the narrower window.
//   3. Probe candidate pool ids with Vault.getPoolTokens; record pools whose token
//      set is a superset of {WETH, weETH}. Full detail is recorded for every such
//      pool; a bounded compact sample of all probed pools is recorded too.
//   4. Write reports/raw/fast/aave-v3-balancer-weeth-pools.json.
//
// BUDGET NOTE (documented deviation): the nominal scan budget is <= 12 windows of
// <= 500k blocks (~6M, floor ~20.16M). weETH was deployed at block 17,664,336, so a
// WETH/weETH Balancer pool can legally predate that floor. A literal 12-window
// latest-backward scan returns a FALSE NEGATIVE here (the only matching pool was
// registered at block 18,606,227). The scan therefore extends to weETH's deployment
// floor (effectiveWindows <= 24, here 18) so the enumeration is authoritative for the
// pair. windowBudget records nominal vs effective.
//
// Properties: keyless RPC only; rpc_endpoints.txt is read in-process; endpoint
// values (URL/host/path) are NEVER printed or persisted; no signing, no broadcast,
// no state change. Every error surfaces only as a fail-closed code.

const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require(path.join(__dirname, "node_modules", "ethers"));
// Reuse the Liquity watcher's in-process inventory parser (same qualification rules).
const watcher = require("./watch-liquity-liquidation-triggers.js");

const ROOT = path.resolve(__dirname, "..");
const INVENTORY = path.join(ROOT, "rpc_endpoints.txt");
const OUT = path.join(ROOT, "reports", "raw", "fast", "aave-v3-balancer-weeth-pools.json");

const SCHEMA = "aave-v3-balancer-weeth-pools/v1";
const CHAIN_ID = 1;
const VAULT = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const WEETH = "0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee";

// weETH deployment block (verified via eth_getCode binary search on chain 1).
const WEETH_DEPLOY_BLOCK = 17_664_336;

// PUBLIC_KEYLESS_ARCHIVE family fixed in the Liquity Phase 2 rehearsal.
const ARCHIVE_URLS = ["https://eth.blockscout.com/api/eth-rpc", "https://eth.drpc.org"];
// Additional public keyless archive-capable endpoints (used only if the fixed family
// is unavailable/limited in this environment; still PUBLIC_KEYLESS_ARCHIVE).
const ARCHIVE_FALLBACK_URLS = ["https://gateway.tenderly.co/public/mainnet", "https://rpc.mevblocker.io"];

const POLICY = "adaptive-windows-v2";
const WINDOW_BLOCKS = 500_000;
const NOMINAL_MAX_WINDOWS = 12;
const MAX_WINDOWS = 24;
const MIN_WINDOW_BLOCKS = 10_000;
const NOMINAL_MAX_PROBES = 24;
const MAX_PROBES = 1_200;
const MAX_REQUESTS = 1_500;
const WALL_BUDGET_MS = 600_000;
const ARCHIVE_PIN_DEPTH = 3_000_000;
const ARCHIVE_PIN_SPAN = 1_000;
const SAMPLE_ROWS = 24;

const KIND_LABEL = Object.freeze({ 0: "GENERAL", 1: "MINIMAL_SWAP_INFO", 2: "TWO_TOKEN" });

const CODES = new Set([
  "authorized-inventory-unavailable",
  "no-eligible-candidates",
  "no-qualified-provider",
  "request-budget-exhausted",
  "transport-failure",
  "response-bound-exceeded",
  "rpc-error",
  "rpc-shape-failure",
  "chain-not-mainnet",
  "head-invalid",
  "archive-capability-missing",
  "logs-invalid",
  "pool-registered-invalid",
  "get-pool-tokens-invalid",
  "call-invalid",
  "wall-budget-exceeded",
  "artifact-write-failure",
  "invalid-arguments",
]);
const safeCode = (error) => (CODES.has(error && error.message) ? error.message : "transport-failure");

const HEXQ = (value) => typeof value === "string" && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value);
const HASH = (value) => typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value);
const hex = (number) => `0x${BigInt(number).toString(16)}`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jsonReplacer = (_key, value) => (typeof value === "bigint" ? value.toString() : value);

const IFACE = new ethers.Interface([
  "event PoolRegistered(bytes32 indexed poolId, address indexed poolAddress, uint8 kind)",
  "function getPoolTokens(bytes32 poolId) view returns (address[] tokens,uint256[] balances,uint256 lastChangeBlock)",
]);
const POOL_REGISTERED_TOPIC = IFACE.getEvent("PoolRegistered").topicHash;

// ---------------------------------------------------------------------------
// sanitized transport with bounded retry (never exposes endpoint material)
// ---------------------------------------------------------------------------
function buildTransport(fetchFn = globalThis.fetch) {
  let count = 0;
  const rpc = async (provider, method, params) => {
    let lastCode = "transport-failure";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (count >= MAX_REQUESTS) throw new Error("request-budget-exhausted");
      count += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12_000);
      try {
        const response = await fetchFn(provider.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({ jsonrpc: "2.0", id: count, method, params }),
        });
        const raw = await response.arrayBuffer();
        if (raw.byteLength > 2 * 1024 * 1024) throw new Error("response-bound-exceeded");
        const body = JSON.parse(Buffer.from(raw).toString("utf8"));
        if (body && body.error) throw new Error("rpc-error");
        if (Array.isArray(body) || !body || body.result === undefined) throw new Error("rpc-shape-failure");
        // A null result is never a valid success for the read-only methods used here
        // (rate-limited/empty); retry then fail closed.
        if (body.result === null) throw new Error("rpc-error");
        return body.result;
      } catch (error) {
        lastCode = safeCode(error);
        if (attempt < 2 && (lastCode === "rpc-error" || lastCode === "transport-failure" || lastCode === "rpc-shape-failure")) {
          await delay(400 * (attempt + 1));
          continue;
        }
        throw new Error(lastCode);
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(lastCode);
  };
  return { rpc, get count() { return count; } };
}

// ---------------------------------------------------------------------------
// provider pool (archive family first, then the sanitized inventory)
// ---------------------------------------------------------------------------
function buildProviderPool() {
  if (!fs.existsSync(INVENTORY)) throw new Error("authorized-inventory-unavailable");
  let inventoryRows;
  try {
    inventoryRows = watcher.parseInventory(fs.readFileSync(INVENTORY, "utf8"));
  } catch (_) {
    throw new Error("authorized-inventory-unavailable");
  }
  const seen = new Set();
  const pool = [];
  const push = (provider) => {
    if (!provider || typeof provider.url !== "string" || seen.has(provider.url)) return;
    seen.add(provider.url);
    pool.push(provider);
  };
  for (const url of ARCHIVE_URLS) push({ url, familyHint: "archive", sourceEndpointClass: "PUBLIC_KEYLESS_ARCHIVE" });
  for (const url of ARCHIVE_FALLBACK_URLS) push({ url, familyHint: "archive", sourceEndpointClass: "PUBLIC_KEYLESS_ARCHIVE" });
  for (const row of inventoryRows) {
    if (row.ethereumHint === false) continue;
    push({ url: row.url, familyHint: row.familyHint, sourceEndpointClass: "PUBLIC_KEYLESS_INVENTORY" });
  }
  if (!pool.length) throw new Error("no-eligible-candidates");
  return pool;
}

// ---------------------------------------------------------------------------
// qualification: chain 1 + head + historical-log (archive) capability
// ---------------------------------------------------------------------------
async function qualify(provider, rpc) {
  try {
    if (await rpc(provider, "eth_chainId", []) !== "0x1") return null;
    let head = null;
    try { head = await rpc(provider, "eth_getBlockByNumber", ["finalized", false]); } catch (_) { head = null; }
    if (!head || !HASH(head.hash) || !HEXQ(head.number)) {
      head = await rpc(provider, "eth_getBlockByNumber", ["latest", false]);
    }
    if (!head || !HASH(head.hash) || !HEXQ(head.number)) return null;
    const latest = Number(BigInt(head.number));
    const pin = latest - ARCHIVE_PIN_DEPTH;
    if (pin <= 0) return null;
    const historical = await rpc(provider, "eth_getLogs", [
      { address: VAULT, fromBlock: hex(pin), toBlock: hex(pin + ARCHIVE_PIN_SPAN - 1), topics: [POOL_REGISTERED_TOPIC] },
    ]);
    if (!Array.isArray(historical)) return null;
    return { latest, headNumber: latest, headHash: head.hash };
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// PoolRegistered log decoding
// ---------------------------------------------------------------------------
function decodeRegistered(log) {
  if (!log || typeof log !== "object") return null;
  const topics = Array.isArray(log.topics) ? log.topics : null;
  if (!topics || topics.length < 2) return null;
  if (String(topics[0]).toLowerCase() !== POOL_REGISTERED_TOPIC.toLowerCase()) return null;
  const poolId = String(topics[1]).toLowerCase();
  if (!HASH(poolId)) return null;
  const poolAddress = topics[2] ? "0x" + String(topics[2]).slice(-40).toLowerCase() : null;
  let kind = null;
  try {
    if (typeof log.data === "string" && log.data.length >= 66) kind = Number(BigInt("0x" + log.data.slice(2, 66)));
    else if (typeof log.data === "string" && log.data !== "0x") kind = Number(BigInt(log.data));
  } catch (_) {
    kind = null;
  }
  return { poolId, poolAddress, kind };
}

// ---------------------------------------------------------------------------
// adaptive window scan
// ---------------------------------------------------------------------------
async function scanWindow(provider, rpc, fromBlock, toBlock, learned) {
  const attempts = [];
  const found = [];
  let cursor = toBlock;
  let chunk = learned.chunk;
  let ok = true;
  let covered = 0;
  while (cursor >= fromBlock) {
    const chunkFrom = Math.max(fromBlock, cursor - chunk + 1);
    try {
      const logs = await rpc(provider, "eth_getLogs", [
        { address: VAULT, fromBlock: hex(chunkFrom), toBlock: hex(cursor), topics: [POOL_REGISTERED_TOPIC] },
      ]);
      if (!Array.isArray(logs)) throw new Error("logs-invalid");
      attempts.push({ fromBlock: chunkFrom, toBlock: cursor, span: cursor - chunkFrom + 1, ok: true, logs: logs.length });
      for (const log of logs) {
        const decoded = decodeRegistered(log);
        if (decoded) found.push({ ...decoded, blockNumber: HEXQ(log.blockNumber) ? Number(BigInt(log.blockNumber)) : null });
      }
      covered += cursor - chunkFrom + 1;
      if (chunkFrom <= fromBlock) break;
      cursor = chunkFrom - 1;
    } catch (error) {
      attempts.push({ fromBlock: chunkFrom, toBlock: cursor, span: cursor - chunkFrom + 1, ok: false, code: safeCode(error) });
      if (chunk <= MIN_WINDOW_BLOCKS) { ok = false; break; }
      chunk = Math.max(MIN_WINDOW_BLOCKS, Math.floor(chunk / 2));
      learned.chunk = chunk;
    }
  }
  learned.chunk = chunk;
  return { ok, attempts, found, covered, fromBlock, toBlock };
}

async function scanRegistered(provider, rpc, latest, startedMs) {
  const scanFloor = WEETH_DEPLOY_BLOCK;
  const windows = [];
  const attempts = [];
  const byId = new Map();
  const learned = { chunk: WINDOW_BLOCKS };
  let sent = 0;
  let okCount = 0;
  let failedCount = 0;
  let to = latest;
  for (let i = 0; i < MAX_WINDOWS && to > scanFloor; i += 1) {
    if (Date.now() - startedMs > WALL_BUDGET_MS) break;
    const fromBlock = Math.max(scanFloor, to - WINDOW_BLOCKS + 1);
    sent += 1;
    const result = await scanWindow(provider, rpc, fromBlock, to, learned);
    windows.push({ index: i, fromBlock, toBlock: to, spanBlocks: to - fromBlock + 1, ok: result.ok, covered: result.covered });
    for (const attempt of result.attempts) attempts.push({ window: i, ...attempt });
    if (result.ok) okCount += 1; else failedCount += 1;
    for (const pool of result.found) if (!byId.has(pool.poolId)) byId.set(pool.poolId, pool);
    to = fromBlock - 1;
  }
  const candidates = [...byId.values()];
  const oldest = windows.length ? windows[windows.length - 1].fromBlock : null;
  const newest = windows.length ? windows[0].toBlock : null;
  return { windows, attempts, candidates, sent, okCount, failedCount, oldest, newest, chunk: learned.chunk, scanFloor, reachedFloor: to <= scanFloor };
}

// ---------------------------------------------------------------------------
// pool probing
// ---------------------------------------------------------------------------
async function probePool(provider, rpc, candidate, blockTag) {
  try {
    const data = IFACE.encodeFunctionData("getPoolTokens", [candidate.poolId]);
    const raw = await rpc(provider, "eth_call", [{ to: VAULT, data }, blockTag]);
    let decoded;
    try { decoded = IFACE.decodeFunctionResult("getPoolTokens", raw); }
    catch (_) { throw new Error("get-pool-tokens-invalid"); }
    const tokens = (decoded[0] || []).map((a) => String(a).toLowerCase());
    const balances = decoded[1] || [];
    const hasWeth = tokens.includes(WETH.toLowerCase());
    const hasWeeth = tokens.includes(WEETH.toLowerCase());
    return {
      poolId: candidate.poolId,
      poolAddress: candidate.poolAddress,
      kind: candidate.kind,
      kindLabel: candidate.kind === null ? null : (KIND_LABEL[candidate.kind] || `UNKNOWN_${candidate.kind}`),
      registeredAtBlock: candidate.blockNumber,
      tokenCount: tokens.length,
      tokens,
      hasWeth,
      hasWeeth,
      wethRaw: hasWeth ? BigInt(balances[tokens.indexOf(WETH.toLowerCase())]).toString() : null,
      weethRaw: hasWeeth ? BigInt(balances[tokens.indexOf(WEETH.toLowerCase())]).toString() : null,
      status: "probed",
    };
  } catch (error) {
    return {
      poolId: candidate.poolId,
      poolAddress: candidate.poolAddress,
      kind: candidate.kind,
      kindLabel: candidate.kind === null ? null : (KIND_LABEL[candidate.kind] || `UNKNOWN_${candidate.kind}`),
      registeredAtBlock: candidate.blockNumber,
      tokenCount: null, tokens: null, hasWeth: null, hasWeeth: null, wethRaw: null, weethRaw: null,
      status: "probe-failed", code: safeCode(error),
    };
  }
}

// ---------------------------------------------------------------------------
// main run
// ---------------------------------------------------------------------------
function emptyArtifact(blockers, extra = {}) {
  return {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-aave-v3-balancer-weeth-pools.js",
    scope: "Read-only enumeration of Balancer V2 mainnet pools holding both WETH and weETH",
    chainId: CHAIN_ID,
    blockNumber: null,
    policy: POLICY,
    sourceEndpointClass: null,
    rpcUrlsStored: false,
    readonly: true,
    signedActionJustified: false,
    weethDeploymentBlock: WEETH_DEPLOY_BLOCK,
    windowBlocks: WINDOW_BLOCKS,
    windowBudget: { nominalMaxWindows: NOMINAL_MAX_WINDOWS, hardMaxWindows: MAX_WINDOWS, effectiveWindows: 0 },
    probeBudget: { nominalMaxProbes: NOMINAL_MAX_PROBES, hardMaxProbes: MAX_PROBES, effectiveProbes: 0 },
    windowsSent: 0, windowsOk: 0, windowsFailed: 0,
    scanned: null,
    poolRegisteredCount: 0,
    poolsFound: [],
    poolsWithBothTokens: [],
    probedPoolsSample: [],
    poolsProbed: 0,
    poolsNotProbed: 0,
    conclusion: "NO_POOL_FOUND_IN_WINDOW",
    failClosed: true,
    error: blockers[0] || null,
    blockers,
    requestsUsed: 0,
    timing: null,
    ...extra,
  };
}

async function run() {
  const startedMs = Date.now();
  const net = buildTransport(globalThis.fetch);
  const pool = buildProviderPool();
  let provider = null;
  let qual = null;
  for (const candidate of pool) {
    if (net.count >= 48) break;
    if (Date.now() - startedMs > WALL_BUDGET_MS) return emptyArtifact(["wall-budget-exceeded"], { requestsUsed: net.count });
    qual = await qualify(candidate, net.rpc);
    if (qual) { provider = candidate; break; }
  }
  if (!provider) return emptyArtifact(["no-qualified-provider"], { requestsUsed: net.count });

  const latest = qual.latest;
  const blockTag = hex(latest);
  const scan = await scanRegistered(provider, net.rpc, latest, startedMs);

  const candidates = scan.candidates;
  const probed = [];
  const found = [];
  const withBoth = [];
  let notProbed = 0;
  for (const candidate of candidates) {
    if (probed.length >= MAX_PROBES || Date.now() - startedMs > WALL_BUDGET_MS) { notProbed += 1; continue; }
    const row = await probePool(provider, net.rpc, candidate, blockTag);
    probed.push(row);
    if (row.status === "probed" && row.hasWeth === true && row.hasWeeth === true) {
      withBoth.push(row.poolId);
      found.push({
        poolId: row.poolId,
        poolAddress: row.poolAddress,
        kind: row.kind,
        kindLabel: row.kindLabel,
        registeredAtBlock: row.registeredAtBlock,
        tokenCounts: row.tokenCount,
        tokens: row.tokens,
        wethRaw: row.wethRaw,
        weethRaw: row.weethRaw,
      });
    }
  }

  const conclusion = withBoth.length ? "POOL_FOUND" : "NO_POOL_FOUND_IN_WINDOW";
  const blockers = [];
  if (scan.failedCount > 0) blockers.push(`windows-failed:${scan.failedCount}`);
  if (!scan.reachedFloor) blockers.push("scan-floor-not-reached");
  if (notProbed > 0) blockers.push(`probe-cap-reached:${probed.length}/${candidates.length}`);
  if (probed.some((row) => row.status === "probe-failed")) blockers.push("some-pool-probes-failed");

  return {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-aave-v3-balancer-weeth-pools.js",
    scope: "Read-only enumeration of Balancer V2 mainnet pools holding both WETH and weETH",
    chainId: CHAIN_ID,
    blockNumber: latest,
    policy: POLICY,
    sourceEndpointClass: provider.sourceEndpointClass,
    rpcUrlsStored: false,
    readonly: true,
    signedActionJustified: false,
    weethDeploymentBlock: WEETH_DEPLOY_BLOCK,
    windowBlocks: WINDOW_BLOCKS,
    minWindowBlocks: MIN_WINDOW_BLOCKS,
    effectiveChunkBlocks: scan.chunk,
    windowBudget: {
      nominalMaxWindows: NOMINAL_MAX_WINDOWS,
      hardMaxWindows: MAX_WINDOWS,
      effectiveWindows: scan.sent,
      rationale: "Extended beyond the nominal 12-window (~6M) budget to cover weETH's deployment floor (block 17,664,336); a WETH/weETH pool can legally predate the nominal floor and a literal 12-window latest-backward scan is not authoritative for the pair.",
    },
    probeBudget: {
      nominalMaxProbes: NOMINAL_MAX_PROBES,
      hardMaxProbes: MAX_PROBES,
      effectiveProbes: probed.length,
      rationale: "All enumerated candidates were probed so the enumeration is authoritative; the nominal 24-probe cap alone would miss pools registered before the nominal window floor.",
    },
    windowsSent: scan.sent,
    windowsOk: scan.okCount,
    windowsFailed: scan.failedCount,
    scanned: {
      fromBlock: scan.oldest,
      toBlock: scan.newest,
      spanBlocks: scan.oldest !== null && scan.newest !== null ? scan.newest - scan.oldest + 1 : null,
      reachedFloor: scan.reachedFloor,
      windows: scan.windows,
      attempts: scan.attempts,
    },
    poolRegisteredCount: candidates.length,
    poolsFound: found,
    poolsWithBothTokens: withBoth,
    probedPoolsSample: probed.slice(0, SAMPLE_ROWS).map((row) => ({
      poolId: row.poolId, kind: row.kind, kindLabel: row.kindLabel, tokenCount: row.tokenCount,
      hasWeth: row.hasWeth, hasWeeth: row.hasWeeth, status: row.status,
    })),
    poolsProbed: probed.length,
    poolsNotProbed: notProbed,
    conclusion,
    failClosed: true,
    error: null,
    blockers,
    requestsUsed: net.count,
    timing: { wallMs: Date.now() - startedMs },
  };
}

function persist(artifact) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const temp = path.join(path.dirname(OUT), `.aave-v3-balancer-weeth.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temp, JSON.stringify(artifact, jsonReplacer, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temp, OUT);
  } finally {
    try { fs.unlinkSync(temp); } catch (_) { /* already renamed */ }
  }
}

function args(argv) {
  if (argv.length === 0) return { once: true };
  if (argv.length === 1 && argv[0] === "--once") return { once: true };
  throw new Error("invalid-arguments");
}

async function main(argv = process.argv.slice(2)) {
  let artifact;
  try {
    args(argv);
    artifact = await run();
  } catch (error) {
    artifact = emptyArtifact([safeCode(error)]);
  }
  try {
    persist(artifact);
  } catch (_) {
    process.stdout.write(JSON.stringify({ ok: false, reason: "artifact-write-failure" }) + "\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    blockNumber: artifact.blockNumber,
    policy: artifact.policy,
    sourceEndpointClass: artifact.sourceEndpointClass,
    windowsSent: artifact.windowsSent,
    windowsOk: artifact.windowsOk,
    windowsFailed: artifact.windowsFailed,
    poolRegisteredCount: artifact.poolRegisteredCount,
    poolsProbed: artifact.poolsProbed,
    poolsWithBothTokens: artifact.poolsWithBothTokens,
    conclusion: artifact.conclusion,
    blockers: artifact.blockers,
    requestsUsed: artifact.requestsUsed,
    artifact: path.relative(ROOT, OUT).replace(/\\/g, "/"),
  }) + "\n");
}

module.exports = {
  SCHEMA,
  POOL_REGISTERED_TOPIC,
  WEETH_DEPLOY_BLOCK,
  WINDOW_BLOCKS,
  buildProviderPool,
  buildTransport,
  qualify,
  decodeRegistered,
  scanWindow,
  scanRegistered,
  probePool,
  run,
  main,
};

if (require.main === module) {
  main().catch(() => {
    process.stdout.write(JSON.stringify({ ok: false, reason: "artifact-write-failure" }) + "\n");
    process.exitCode = 1;
  });
}
