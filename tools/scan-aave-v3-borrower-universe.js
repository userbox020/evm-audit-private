#!/usr/bin/env node
"use strict";

// scan-aave-v3-borrower-universe.js
// Read-only, fail-closed full-history enumeration of the Aave V3 Ethereum mainnet
// Borrow universe for Pool 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2 (chainId 1).
//
// Closes the workspace gate gap: tools/aave-v3-liquidation-watch.js reports
// SOURCE_INCOMPLETE because "Monitor inputs are bounded historical samples;
// active-position coverage is not complete." This lane derives a COMPLETE
// historical borrower set (the position owner = the event's onBehalfOf field,
// matching the monitor's discovery logic) from V3's deployment floor to head.
//
// Method (adaptive-windows-v2, same machinery as the Balancer PoolRegistered scan):
//   1. Derive the Borrow topic0 from the pinned checkout's IPool.sol declaration
//      (event Borrow(address indexed reserve, address user, address indexed
//      onBehalfOf, uint256 amount, InterestRateMode, uint256 borrowRate,
//      uint16 indexed referralCode)) — computed with ethers, never trusted.
//   2. Verify the emitter: the Pool proxy emits (delegatecall), not the impl.
//   3. Establish the deployment floor with a bounded eth_getCode binary search.
//   4. Scan Borrow logs backward from head in <= 24 top-level windows (~500k),
//      subdivided into adaptive chunks (silent-truncation guard + one verify
//      re-fetch per non-zero chunk; halve on error/suspicion).
//   5. Deduplicate the onBehalfOf universe, record each user's last Borrow block.
//
// Properties: keyless archive RPC only; rpc_endpoints.txt read in-process;
// endpoints (URL/host/path) NEVER printed or persisted; no signing; no chain writes.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { ethers } = require(path.join(__dirname, "node_modules", "ethers"));
const watcher = require("./watch-liquity-liquidation-triggers.js");

const ROOT = path.resolve(__dirname, "..");
const INVENTORY = path.join(ROOT, "rpc_endpoints.txt");
const OUT = path.join(ROOT, "reports", "raw", "fast", "aave-v3-borrower-universe.json");
const CSV_OUT = path.join(ROOT, "reports", "raw", "fast", "aave-v3-borrower-universe-users.csv");

const SCHEMA = "aave-v3-borrower-universe/v1";
const CHAIN_ID = 1;
const POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";

// PUBLIC_KEYLESS_ARCHIVE family (Liquity Phase 2 pattern) + keyless fallbacks.
const ARCHIVE_URLS = ["https://eth.blockscout.com/api/eth-rpc", "https://eth.drpc.org"];
const ARCHIVE_FALLBACK_URLS = ["https://gateway.tenderly.co/public/mainnet", "https://rpc.mevblocker.io"];

const POLICY = "adaptive-windows-v2";
const TOP_WINDOW_BLOCKS = 500_000;
const MAX_TOP_WINDOWS = 24;
const MAX_CHUNK_BLOCKS = 100_000; // observed safe ceiling; providers silently truncate >= ~200k
const MIN_CHUNK_BLOCKS = 10_000;
const FLOOR_SEARCH_LO = 13_000_000;
const FLOOR_SEARCH_HI = 17_000_000;
const MAX_REQUESTS = 1_200;
const WALL_BUDGET_MS = 1_800_000;
const RESPONSE_BOUND = 24 * 1024 * 1024;
const MAX_UNIVERSE_ROWS = 5_000;
const CSV_HARD_CAP = 16 * 1024 * 1024;
const ARCHIVE_PROBE_SPAN = 1_000;
// density guard: a chunk with a non-zero but implausibly low count is treated as
// provider-truncated (observed: >=200k spans returned 4-5 logs instead of ~15-30k).
const MIN_DENSITY_PER_BLOCK = 0.0002;

const IFACE = new ethers.Interface([
  "event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)",
]);
const BORROW_TOPIC = IFACE.getEvent("Borrow").topicHash;

const CODES = new Set([
  "authorized-inventory-unavailable", "no-eligible-candidates", "no-qualified-provider",
  "request-budget-exhausted", "transport-failure", "response-bound-exceeded", "rpc-error",
  "rpc-shape-failure", "chain-not-mainnet", "head-invalid", "pool-code-missing",
  "emitter-unverified", "floor-unproven", "logs-invalid", "borrow-decode-invalid",
  "wall-budget-exceeded", "artifact-write-failure", "invalid-arguments",
]);
const safeCode = (error) => (CODES.has(error && error.message) ? error.message : "transport-failure");

const HEXQ = (value) => typeof value === "string" && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value);
const ADDR = (value) => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
const hex = (number) => `0x${BigInt(number).toString(16)}`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jsonReplacer = (_key, value) => (typeof value === "bigint" ? value.toString() : value);
const EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

// ---------------------------------------------------------------------------
// sanitized transport with bounded retry
// ---------------------------------------------------------------------------
function buildTransport(fetchFn = globalThis.fetch) {
  let count = 0;
  const rpc = async (provider, method, params) => {
    let lastCode = "transport-failure";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (count >= MAX_REQUESTS) throw new Error("request-budget-exhausted");
      count += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      try {
        const response = await fetchFn(provider.url, {
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
// provider pool + qualification
// ---------------------------------------------------------------------------
function buildProviderPool() {
  if (!fs.existsSync(INVENTORY)) throw new Error("authorized-inventory-unavailable");
  let inventoryRows;
  try { inventoryRows = watcher.parseInventory(fs.readFileSync(INVENTORY, "utf8")); }
  catch (_) { throw new Error("authorized-inventory-unavailable"); }
  const seen = new Set();
  const pool = [];
  const push = (provider) => {
    if (!provider || typeof provider.url !== "string" || seen.has(provider.url)) return;
    seen.add(provider.url);
    pool.push(provider);
  };
  for (const url of ARCHIVE_URLS) push({ url, sourceEndpointClass: "PUBLIC_KEYLESS_ARCHIVE" });
  for (const url of ARCHIVE_FALLBACK_URLS) push({ url, sourceEndpointClass: "PUBLIC_KEYLESS_ARCHIVE" });
  for (const row of inventoryRows) {
    if (row.ethereumHint === false) continue;
    push({ url: row.url, sourceEndpointClass: "PUBLIC_KEYLESS_INVENTORY" });
  }
  if (!pool.length) throw new Error("no-eligible-candidates");
  return pool;
}

async function qualify(provider, rpc) {
  try {
    if (await rpc(provider, "eth_chainId", []) !== "0x1") return null;
    let head = null;
    try { head = await rpc(provider, "eth_getBlockByNumber", ["finalized", false]); } catch (_) { head = null; }
    if (!head || !HEXQ(head.number)) head = await rpc(provider, "eth_getBlockByNumber", ["latest", false]);
    if (!head || !HEXQ(head.number)) return null;
    const latest = Number(BigInt(head.number));
    const code = await rpc(provider, "eth_getCode", [POOL, "latest"]);
    if (typeof code !== "string" || code.length <= 2) return null;
    const probe = await rpc(provider, "eth_getLogs", [
      { address: POOL, fromBlock: hex(latest - ARCHIVE_PROBE_SPAN + 1), toBlock: hex(latest), topics: [BORROW_TOPIC] },
    ]);
    if (!Array.isArray(probe)) return null;
    return { latest };
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function decodeBorrow(log) {
  if (!log || typeof log !== "object") return null;
  const topics = Array.isArray(log.topics) ? log.topics : null;
  if (!topics || topics.length < 3) return null;
  if (String(topics[0]).toLowerCase() !== BORROW_TOPIC.toLowerCase()) return null;
  const onBehalfOf = "0x" + String(topics[2]).slice(-40).toLowerCase();
  if (!ADDR(onBehalfOf)) return null;
  const blockNumber = HEXQ(log.blockNumber) ? Number(BigInt(log.blockNumber)) : null;
  return { onBehalfOf, blockNumber };
}

async function findFloor(provider, rpc) {
  const hasCode = async (block) => {
    const code = await rpc(provider, "eth_getCode", [POOL, hex(block)]);
    return typeof code === "string" && code.length > 2;
  };
  if (!(await hasCode(FLOOR_SEARCH_HI))) throw new Error("floor-unproven");
  if (await hasCode(FLOOR_SEARCH_LO)) throw new Error("floor-unproven");
  let lo = FLOOR_SEARCH_LO;
  let hi = FLOOR_SEARCH_HI;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (await hasCode(mid)) hi = mid; else lo = mid;
  }
  const atFloor = await hasCode(hi);
  const beforeFloor = await hasCode(hi - 1);
  if (!atFloor || beforeFloor) throw new Error("floor-unproven");
  return hi;
}

async function verifyEmitter(provider, rpc, head) {
  const implRaw = await rpc(provider, "eth_getStorageAt", [POOL, EIP1967_IMPL_SLOT, hex(head)]).catch(() => null);
  const impl = implRaw && implRaw !== "0x" ? "0x" + implRaw.slice(-40) : null;
  const probe = async (address) => {
    const logs = await rpc(provider, "eth_getLogs", [
      { address, fromBlock: hex(head - ARCHIVE_PROBE_SPAN + 1), toBlock: hex(head), topics: [BORROW_TOPIC] },
    ]);
    return Array.isArray(logs) ? logs.length : -1;
  };
  const proxyLogs = await probe(POOL);
  let implLogs = null;
  if (impl && ADDR(impl) && impl.toLowerCase() !== POOL.toLowerCase()) implLogs = await probe(impl);
  if (!(proxyLogs > 0)) throw new Error("emitter-unverified");
  return { impl, proxyLogs, implLogs };
}

// ---------------------------------------------------------------------------
// adaptive full-history scan
// ---------------------------------------------------------------------------
async function fetchChunk(provider, rpc, fromBlock, toBlock) {
  const logs = await rpc(provider, "eth_getLogs", [
    { address: POOL, fromBlock: hex(fromBlock), toBlock: hex(toBlock), topics: [BORROW_TOPIC] },
  ]);
  if (!Array.isArray(logs)) throw new Error("logs-invalid");
  return logs;
}

async function scanWindow(provider, rpc, fromBlock, toBlock, learned, attempts) {
  const found = [];
  let cursor = toBlock;
  let ok = true;
  let covered = 0;
  let chunkCount = 0;
  while (cursor >= fromBlock) {
    const chunk = learned.chunk;
    const chunkFrom = Math.max(fromBlock, cursor - chunk + 1);
    const span = cursor - chunkFrom + 1;
    let failCode = null;
    try {
      let logs = await fetchChunk(provider, rpc, chunkFrom, cursor);
      // one verify re-fetch for non-zero chunks (completeness / silent-truncation guard)
      if (logs.length > 0) {
        const recheck = await fetchChunk(provider, rpc, chunkFrom, cursor);
        if (recheck.length !== logs.length) { failCode = "count-mismatch"; throw new Error("rpc-shape-failure"); }
        logs = recheck;
      }
      if (logs.length > 0 && logs.length < Math.max(10, Math.floor(span * MIN_DENSITY_PER_BLOCK))) {
        failCode = "density-suspicious";
        throw new Error("rpc-shape-failure");
      }
      attempts.push({ fromBlock: chunkFrom, toBlock: cursor, span, ok: true, logs: logs.length });
      for (const log of logs) {
        const decoded = decodeBorrow(log);
        if (decoded) found.push(decoded);
      }
      covered += span;
      chunkCount += 1;
      if (chunkFrom <= fromBlock) break;
      cursor = chunkFrom - 1;
    } catch (error) {
      attempts.push({ fromBlock: chunkFrom, toBlock: cursor, span, ok: false, code: failCode || safeCode(error) });
      if (chunk <= MIN_CHUNK_BLOCKS) { ok = false; break; }
      learned.chunk = Math.max(MIN_CHUNK_BLOCKS, Math.floor(chunk / 2));
    }
  }
  return { ok, found, covered, chunkCount };
}

async function scanHistory(provider, rpc, head, floor, startedMs) {
  const windows = [];
  const attempts = [];
  const learned = { chunk: MAX_CHUNK_BLOCKS };
  const byUser = new Map();
  let sent = 0;
  let okCount = 0;
  let failedCount = 0;
  let to = head;
  for (let i = 0; i < MAX_TOP_WINDOWS && to > floor; i += 1) {
    if (Date.now() - startedMs > WALL_BUDGET_MS) break;
    const fromBlock = Math.max(floor, to - TOP_WINDOW_BLOCKS + 1);
    sent += 1;
    const result = await scanWindow(provider, rpc, fromBlock, to, learned, attempts);
    windows.push({ index: i, fromBlock, toBlock: to, spanBlocks: to - fromBlock + 1, ok: result.ok, covered: result.covered, chunks: result.chunkCount });
    if (result.ok) okCount += 1; else failedCount += 1;
    for (const { onBehalfOf, blockNumber } of result.found) {
      const prev = byUser.get(onBehalfOf);
      if (prev === undefined) byUser.set(onBehalfOf, blockNumber === null ? -1 : blockNumber);
      else if (blockNumber !== null && blockNumber > prev) byUser.set(onBehalfOf, blockNumber);
    }
    to = fromBlock - 1;
  }
  const reachedFloor = to <= floor;
  return { windows, attempts, byUser, sent, okCount, failedCount, reachedFloor, chunk: learned.chunk };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function emptyArtifact(blockers, extra = {}) {
  return {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-aave-v3-borrower-universe.js",
    scope: "Read-only full-history Aave V3 Ethereum mainnet Borrow borrower universe",
    chainId: CHAIN_ID,
    pool: POOL,
    policy: POLICY,
    sourceEndpointClass: null,
    rpcUrlsStored: false,
    endpointProcessOnly: true,
    readonly: true,
    signedActionJustified: false,
    floorBlock: null,
    headBlock: null,
    windowsSent: 0, windowsOk: 0, windowsFailed: 0,
    dedupedBorrowersCount: 0,
    fullHistoryProven: false,
    coverageClass: "BOUNDED_ATTEMPT",
    reason: blockers[0] || null,
    blockers,
    borrowerUniverse: [],
    requestsUsed: 0,
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
    if (net.count >= 60) break;
    if (Date.now() - startedMs > WALL_BUDGET_MS) return emptyArtifact(["wall-budget-exceeded"], { requestsUsed: net.count });
    qual = await qualify(candidate, net.rpc);
    if (qual) { provider = candidate; break; }
  }
  if (!provider) return emptyArtifact(["no-qualified-provider"], { requestsUsed: net.count });

  const head = qual.latest;
  const emitter = await verifyEmitter(provider, net.rpc, head).catch(() => { throw new Error("emitter-unverified"); });
  const floor = await findFloor(provider, net.rpc);

  const scan = await scanHistory(provider, net.rpc, head, floor, startedMs);
  const fullHistoryProven = scan.reachedFloor && scan.failedCount === 0;

  const users = [...scan.byUser.entries()].map(([user, lastBorrowBlock]) => ({ user, lastBorrowBlock })).sort((a, b) => (a.user < b.user ? -1 : a.user > b.user ? 1 : 0));

  // canonical CSV (full set) + SHA256
  const csvLines = users.map((row) => `${row.user},${row.lastBorrowBlock}`);
  const csvBody = "user,lastBorrowBlock\n" + csvLines.join("\n") + "\n";
  const universeSha256 = crypto.createHash("sha256").update(csvBody, "utf8").digest("hex");
  const csvBytes = Buffer.byteLength(csvBody, "utf8");
  let storedAs = "inline";
  let universeFile = null;
  if (users.length > MAX_UNIVERSE_ROWS || csvBytes > 8 * 1024 * 1024) {
    storedAs = "csv";
    universeFile = "reports/raw/fast/aave-v3-borrower-universe-users.csv";
    if (csvBytes <= CSV_HARD_CAP) fs.writeFileSync(CSV_OUT, csvBody, "utf8");
    else universeFile = null; // keep hash+count only
  }

  const blockers = [];
  if (scan.failedCount > 0) blockers.push(`windows-failed:${scan.failedCount}`);
  if (!scan.reachedFloor) blockers.push("floor-not-reached");

  return {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-aave-v3-borrower-universe.js",
    scope: "Read-only full-history Aave V3 Ethereum mainnet Borrow borrower universe",
    chainId: CHAIN_ID,
    pool: POOL,
    poolImplementation: emitter.impl,
    emitter: "proxy",
    borrowEventSignature: "Borrow(address,address,address,uint256,uint8,uint256,uint16)",
    borrowTopic0: BORROW_TOPIC,
    policy: POLICY,
    sourceEndpointClass: provider.sourceEndpointClass,
    rpcUrlsStored: false,
    endpointProcessOnly: true,
    readonly: true,
    signedActionJustified: false,
    floorBlock: floor,
    headBlock: head,
    windowBlocksNominal: TOP_WINDOW_BLOCKS,
    effectiveChunkBlocks: scan.chunk,
    providerTruncationNote: "Keyless providers silently truncate large Borrow ranges (observed 4-5 logs at >=200k spans); scan capped at 100k chunks with a density guard + one verify re-fetch per non-zero chunk.",
    windowsSent: scan.sent,
    windowsOk: scan.okCount,
    windowsFailed: scan.failedCount,
    reachedFloor: scan.reachedFloor,
    scanned: { fromBlock: floor, toBlock: head, spanBlocks: head - floor + 1, windows: scan.windows, attempts: scan.attempts },
    dedupedBorrowersCount: users.length,
    fullHistoryProven,
    coverageClass: fullHistoryProven ? "FULL_HISTORICAL_BORROWERS_MAINNET_V3" : "BOUNDED_ATTEMPT",
    historyScope: fullHistoryProven ? "PROVEN_START_TO_TIP" : "RECENT_BLOCK_SUFFIX",
    borrowerUniverse: users.slice(0, MAX_UNIVERSE_ROWS),
    borrowerUniverseTruncated: users.length > MAX_UNIVERSE_ROWS,
    universeSha256,
    universeBytes: csvBytes,
    storedAs,
    universeFile,
    blockers,
    requestsUsed: net.count,
    timing: { wallMs: Date.now() - startedMs },
  };
}

function persist(artifact) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const temp = path.join(path.dirname(OUT), `.aave-v3-borrower-universe.${process.pid}.${Date.now()}.tmp`);
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
    floorBlock: artifact.floorBlock,
    headBlock: artifact.headBlock,
    windowsSent: artifact.windowsSent,
    windowsOk: artifact.windowsOk,
    windowsFailed: artifact.windowsFailed,
    dedupedBorrowersCount: artifact.dedupedBorrowersCount,
    fullHistoryProven: artifact.fullHistoryProven,
    coverageClass: artifact.coverageClass,
    storedAs: artifact.storedAs,
    universeSha256: artifact.universeSha256,
    blockers: artifact.blockers,
    requestsUsed: artifact.requestsUsed,
    artifact: path.relative(ROOT, OUT).replace(/\\/g, "/"),
  }) + "\n");
}

module.exports = {
  SCHEMA,
  BORROW_TOPIC,
  POOL,
  buildProviderPool,
  buildTransport,
  qualify,
  decodeBorrow,
  findFloor,
  verifyEmitter,
  scanWindow,
  scanHistory,
  run,
  main,
};

if (require.main === module) {
  main().catch(() => {
    process.stdout.write(JSON.stringify({ ok: false, reason: "artifact-write-failure" }) + "\n");
    process.exitCode = 1;
  });
}
