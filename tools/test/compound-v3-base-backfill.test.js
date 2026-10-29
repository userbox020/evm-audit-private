"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { Interface } = require("../node_modules/ethers");
const indexer = require("../lib/compound-borrower-index");
const { runBackfill, createPacedTransports } = require("../compound-v3-base-backfill");
const { MARKET, CHAIN_ID, SEED_SCHEMA, TOPICS } = indexer;
const PIN = { number: 52825711, hash: `0x${"a".repeat(64)}`, timestamp: 1792441900 };
const START = 52685147;
const addr = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const hash = (n) => `0x${n.toString(16).padStart(64, "0")}`;
const hex = (n) => `0x${n.toString(16)}`;
const bytes = (value) => Buffer.from(JSON.stringify(value));
const EVENTS = new Interface(["event Withdraw(address indexed src,address indexed to,uint256 amount)"]);
const seed = (users = [], extra = {}) => bytes({ schema: SEED_SCHEMA, updatedAt: "2020-01-01T00:00:00.000Z",
  chainId: CHAIN_ID, market: MARKET, pin: { ...PIN, number: START - 1 }, users, ...extra });
function log(user, block, n = 1) {
  return { address: MARKET, removed: false, blockNumber: hex(block), blockHash: hash(block), transactionHash: hash(n),
    logIndex: hex(n), ...EVENTS.encodeEventLog(EVENTS.getEvent("Withdraw"), [user, addr(90), 1]) };
}
function clock() {
  let tick = 0;
  return { now: () => tick, sleep: async (ms) => { tick += ms; }, advance: (ms) => { tick += ms; } };
}
function fixture(time, { logs = [], failAt = null, drift = false, delay = 0 } = {}) {
  const calls = []; let active = 0, maximum = 0, headers = 0;
  const send = async (method, params, id, timeoutMs) => {
    active++; maximum = Math.max(maximum, active);
    calls.push({ method, params, id, timeoutMs, started: time.now() });
    try {
      await Promise.resolve();
      if (delay) time.advance(delay);
      if (method === "eth_chainId") return hex(CHAIN_ID);
      if (method === "eth_getBlockByNumber") {
        headers++;
        return { number: hex(PIN.number), hash: drift && headers > 1 ? hash(9) : PIN.hash, timestamp: hex(PIN.timestamp) };
      }
      assert.equal(method, "eth_getLogs");
      assert.equal(params[0].address, MARKET); assert.deepEqual(params[0].topics, [TOPICS]);
      const from = Number(BigInt(params[0].fromBlock)), to = Number(BigInt(params[0].toBlock));
      if (from === failAt) throw new Error("PRIVATE_UPSTREAM_DIAGNOSTIC_MUST_NOT_LEAK");
      return logs.filter((row) => Number(BigInt(row.blockNumber)) >= from && Number(BigInt(row.blockNumber)) <= to);
    } finally { active--; }
  };
  return { send, calls, maximum: () => maximum, active: () => active };
}
function options(t, extra = {}, left = {}, right = left) {
  // All generated artifacts are isolated; never touch workspace reports/inventories.
  const root = process.platform === "win32" ? path.join(os.homedir(), "AppData/Local/Temp/opencode") : os.tmpdir();
  const outDir = fs.mkdtempSync(path.join(root, "compound-backfill-test-"));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  const time = clock(), a = fixture(time, left), b = fixture(time, right);
  return { time, a, b, args: { transports: [a.send, b.send], pin: PIN, fromBlock: START, totalBlocks: 200,
    outDir, runId: "fixture", now: time.now, sleep: time.sleep, ...extra } };
}
const getLogs = (provider) => provider.calls.filter((call) => call.method === "eth_getLogs");
async function priorIndex({ logs = [], users = [] } = {}) {
  const time = clock(), a = fixture(time, { logs }), b = fixture(time, { logs });
  return indexer.scanBorrowerIndex({ transports: [a.send, b.send], pin: PIN, seedBytes: seed(users),
    fromBlock: START, windowBlocks: 12000, chunkBlocks: 100, maxChunks: 55, backfill: true, now: time.now });
}

const originalFetch = globalThis.fetch;
test.before(() => { globalThis.fetch = () => { throw new Error("OFFLINE_NETWORK_FORBIDDEN"); }; });
test.after(() => { globalThis.fetch = originalFetch; });

test("default pacing spaces each provider independently, keeps one outstanding, and shrinks request timeout", async (t) => {
  const { args, a, b } = options(t);
  const result = await runBackfill(args);
  assert.equal(result.manifest.status, "COMPLETE");
  assert.deepEqual(result.manifest.diagnostics.requestsByProvider, [5, 5]);
  for (const provider of [a, b]) {
    assert.equal(provider.maximum(), 1); assert.equal(provider.active(), 0);
    for (let i = 1; i < provider.calls.length; i++) assert.ok(provider.calls[i].started - provider.calls[i - 1].started >= 1100);
    assert.equal(provider.calls[0].timeoutMs, 15000);
    assert.ok(provider.calls[1].timeoutMs <= 13900);
  }
  assert.equal(a.calls[0].started, b.calls[0].started);
  assert.deepEqual([...a.calls, ...b.calls].map((call) => call.id).sort((x, y) => x - y), Array.from({ length: 10 }, (_, i) => i + 1));
});

test("queued calls cannot overlap or renew timeout; one slow provider does not lock the other", async () => {
  const time = clock(); let release, active = 0, max = 0;
  const starts = [];
  const slow = async (_method, _params, _id, timeout) => {
    active++; max = Math.max(max, active); starts.push({ at: time.now(), timeout });
    if (starts.length === 1) await new Promise((resolve) => { release = resolve; });
    active--; return "ok";
  };
  const paced = createPacedTransports({ transports: [slow, async () => "independent"], now: time.now, sleep: time.sleep });
  const first = paced.transports[0]("eth_chainId", [], 1, 5000);
  const queued = paced.transports[0]("eth_chainId", [], 2, 5000);
  assert.equal(await paced.transports[1]("eth_chainId", [], 3, 5000), "independent");
  assert.equal(starts.length, 1);
  time.advance(1500); release();
  await Promise.all([first, queued]);
  assert.equal(max, 1); assert.deepEqual(starts, [{ at: 0, timeout: 5000 }, { at: 1500, timeout: 3500 }]);
});

test("global request budget fails closed, persists a gap and never advances an unverified window", async (t) => {
  const { args, a, b } = options(t, { maxRequests: 6 }, { logs: [log(addr(2), START)] });
  const result = await runBackfill(args);
  assert.equal(result.manifest.reason, "RPC_BUDGET_EXCEEDED");
  assert.equal(result.manifest.diagnostics.requests, 6); assert.equal(a.calls.length + b.calls.length, 6);
  assert.equal(result.manifest.coveredBlocks, 0); assert.equal(result.manifest.nextCursor, START);
  assert.equal(result.index.pinVerified, false); assert.deepEqual(result.index.users, [addr(2)]);
  assert.deepEqual(result.manifest.gaps, [{ fromBlock: START, toBlock: START + 199, reason: "RPC_BUDGET_EXCEEDED" }]);
  assert.equal(indexer.loadSeed(result.indexPath).document.nextCursor, START);
  assert.equal(JSON.parse(fs.readFileSync(result.manifestPath)).status, "INCOMPLETE");
});

test("global time budget includes pacing and RPC time, without cursor advancement or unfinished siblings", async (t) => {
  const { args, a, b } = options(t, { maxRuntimeMs: 2000 });
  const result = await runBackfill(args);
  assert.equal(result.manifest.reason, "TIME_BUDGET_EXCEEDED");
  assert.equal(result.manifest.nextCursor, START); assert.equal(result.manifest.coveredBlocks, 0);
  assert.ok(result.manifest.diagnostics.elapsedMs <= 2000);
  assert.equal(getLogs(a).length + getLogs(b).length, 0);
  assert.equal(a.active() + b.active(), 0);
  const time = clock(), late = fixture(time, { delay: 50 }), other = fixture(time);
  const paced = createPacedTransports({ transports: [late.send, other.send], now: time.now, sleep: time.sleep });
  await assert.rejects(paced.transports[0]("eth_chainId", [], 1, 10), /TIME_BUDGET_EXCEEDED/);
  assert.equal(late.active(), 0);
});

test("same-pin 55/120 resume finishes the exact window without rescanning or dropping zero-debt candidates", async (t) => {
  const users = Array.from({ length: 48 }, (_, i) => addr(i + 1));
  const prior = await priorIndex({ users, logs: [log(addr(1), START)] });
  assert.equal(prior.nextCursor, 52690647); assert.equal(prior.coveredBlocks, 5500);
  const raw = bytes(prior), preserved = Buffer.from(raw);
  const { args, a } = options(t, { seedBytes: raw, totalBlocks: 12000 }, { logs: [log(addr(49), START + 5500)] });
  const result = await runBackfill(args);
  assert.deepEqual(raw, preserved);
  assert.equal(getLogs(a).length, 65);
  assert.equal(getLogs(a)[0].params[0].fromBlock, hex(52690647));
  assert.equal(result.index.window.toBlock, 52697146); assert.equal(result.index.window.chunkBlocks, 100);
  assert.deepEqual(result.index.coveredRanges.slice(0, 55), prior.coveredRanges);
  assert.deepEqual(result.index.users, [...users, addr(49)]);
  assert.equal(result.manifest.status, "COMPLETE"); assert.equal(result.manifest.coveredBlocks, 12000);
  assert.equal(result.manifest.resumedCoveredBlocks, 5500); assert.equal(result.manifest.newlyCoveredBlocks, 6500);
  assert.equal(result.manifest.successfulChunks, 120); assert.equal(result.manifest.sources.length, 1);
  assert.equal(result.manifest.fullHistoryEstablished, false); assert.equal(result.manifest.fullMarketCoverageEstablished, false);
});

test("resume crosses into contiguous default windows with no gaps, duplicate ranges or counters", async (t) => {
  const prior = await priorIndex({ users: [addr(1)] });
  const { args, a } = options(t, { seedBytes: bytes(prior), totalBlocks: 17100 });
  const result = await runBackfill(args);
  assert.equal(result.manifest.coveredBlocks, 17100); assert.equal(result.manifest.newlyCoveredBlocks, 11600);
  assert.equal(result.manifest.nextCursor, START + 17100); assert.deepEqual(result.manifest.gaps, []);
  assert.equal(result.manifest.successfulChunks, 171); assert.equal(getLogs(a).length, 116);
  assert.deepEqual(result.manifest.sources.map((source) => [source.window.fromBlock, source.window.toBlock, source.successfulChunks]),
    [[START, START + 11999, 120], [START + 12000, START + 16999, 50], [START + 17000, START + 17099, 1]]);
  let cursor = START;
  for (const range of result.manifest.ranges) { assert.equal(range.fromBlock, cursor); cursor = range.toBlock + 1; }
  assert.equal(new Set(result.manifest.ranges.map((range) => range.fromBlock)).size, 171);
  assert.deepEqual(result.index.users, [addr(1)]);
});

test("provider disagreement persists only the agreed prefix, stops at the gap and never retries", async (t) => {
  const { args, a, b } = options(t, { totalBlocks: 6000 }, { logs: [log(addr(1), START + 100)] }, {});
  const result = await runBackfill(args);
  assert.equal(result.manifest.reason, "LOG_MISMATCH"); assert.equal(result.manifest.coveredBlocks, 100);
  assert.equal(result.manifest.nextCursor, START + 100); assert.equal(result.manifest.sources.length, 1);
  assert.equal(getLogs(a).length, 2); assert.equal(getLogs(b).length, 2);
  assert.deepEqual(result.index.gaps, [{ fromBlock: START + 100, toBlock: START + 199, reason: "LOG_MISMATCH" }]);
  assert.deepEqual(result.manifest.gaps, [{ fromBlock: START + 100, toBlock: START + 5999, reason: "LOG_MISMATCH" }]);
});

test("RPC failure in the next window preserves prior proof and candidates but never leaks errors or skips", async (t) => {
  const { args, a } = options(t, { totalBlocks: 600, windowBlocks: 200, maxChunks: 2, seedBytes: seed([addr(3)]) },
    { failAt: START + 300, logs: [log(addr(1), START), log(addr(2), START + 200)] });
  const result = await runBackfill(args);
  assert.equal(result.manifest.reason, "RPC_FAILURE"); assert.equal(result.manifest.coveredBlocks, 300);
  assert.equal(result.manifest.sources.length, 2); assert.equal(result.manifest.nextCursor, START + 300);
  assert.deepEqual(result.index.users, [addr(1), addr(2), addr(3)]); assert.equal(getLogs(a).length, 4);
  for (const file of fs.readdirSync(args.outDir)) assert.ok(!fs.readFileSync(path.join(args.outDir, file), "utf8").includes("PRIVATE_UPSTREAM"));
});

test("canonical pin drift invalidates earlier same-pin coverage", async (t) => {
  const { args } = options(t, { totalBlocks: 400, windowBlocks: 200, maxChunks: 2 }, { drift: true });
  const result = await runBackfill(args);
  assert.equal(result.manifest.reason, "PIN_DRIFT"); assert.equal(result.manifest.coveredBlocks, 0);
  assert.equal(result.manifest.nextCursor, START); assert.deepEqual(result.manifest.ranges, []);
});

test("source files round-trip strict validation and digests; legacy counts/provenance are never history coverage", async (t) => {
  const { args } = options(t, { totalBlocks: 450, windowBlocks: 200, maxChunks: 2,
    seedBytes: seed([addr(9)], { blocksScanned: 120000, activeBorrowerCount: 1 }) });
  const result = await runBackfill(args);
  let covered = 0;
  for (const source of result.manifest.sources) {
    assert.equal(path.basename(source.path), source.path);
    const raw = fs.readFileSync(path.join(args.outDir, source.path));
    const parsed = indexer.parseSeed(raw).document;
    assert.equal(crypto.createHash("sha256").update(raw).digest("hex"), source.sha256);
    assert.equal(parsed.pinVerified, true); assert.equal(parsed.coveredBlocks, source.coveredBlocks);
    assert.equal(parsed.users.includes(addr(9)), true); covered += parsed.coveredBlocks;
  }
  assert.equal(covered, 450); assert.equal(result.manifest.coveredBlocks, 450);
  assert.equal(result.manifest.resumedCoveredBlocks, 0); assert.equal(result.manifest.newlyCoveredBlocks, 450);
  assert.equal(result.manifest.seedProvenance.coverageClaimsTrusted, false);
  assert.deepEqual(fs.readFileSync(result.indexPath), result.seedBytes);
  assert.deepEqual(JSON.parse(fs.readFileSync(result.manifestPath)), result.manifest);
});

test("incompatible resume pin, range/end and corrupt coverage reject before requests or writes", async (t) => {
  const prior = await priorIndex();
  const corrupt = structuredClone(prior); corrupt.coveredBlocks++;
  for (const extra of [
    { pin: { ...PIN, hash: hash(1) } }, { pin: { ...PIN, timestamp: PIN.timestamp + 1 } },
    { pin: { ...PIN, number: PIN.number + 1 } }, { fromBlock: prior.nextCursor },
    { totalBlocks: 11999 }, { totalBlocks: PIN.number - START + 2 }, { seedBytes: bytes(corrupt) },
  ]) {
    const { args, a, b } = options(t, { seedBytes: bytes(prior), totalBlocks: 12000, ...extra });
    await assert.rejects(runBackfill(args), /RESUME_INCOMPATIBLE|INDEX_INVALID|SEED_INVALID/);
    assert.equal(a.calls.length + b.calls.length, 0); assert.deepEqual(fs.readdirSync(args.outDir), []);
  }
});

test("existing index or manifest filenames reject without overwriting caller data", async (t) => {
  for (const name of ["compound-backfill-fixture-index-0000.json", "compound-backfill-fixture-manifest.json"]) {
    const { args, a, b } = options(t);
    const file = path.join(args.outDir, name); fs.writeFileSync(file, "preserve me", { flag: "wx" });
    await assert.rejects(runBackfill(args), { code: "EEXIST" });
    assert.equal(fs.readFileSync(file, "utf8"), "preserve me"); assert.equal(a.calls.length + b.calls.length, 0);
  }
  const { args, a } = options(t); const result = await runBackfill(args);
  const original = fs.readFileSync(result.indexPath), calls = a.calls.length;
  await assert.rejects(runBackfill(args), { code: "EEXIST" });
  assert.deepEqual(fs.readFileSync(result.indexPath), original); assert.equal(a.calls.length, calls);
});

test("two distinct caller transports and bounded settings are mandatory; no fallback", async (t) => {
  const { args, a } = options(t);
  for (const transports of [[], [a.send], [a.send, a.send], [a.send, async () => {}, async () => {}]]) {
    await assert.rejects(runBackfill({ ...args, transports }), /DUAL_PROVIDER_REQUIRED/);
  }
  for (const extra of [{ maxRequests: 3501 }, { maxRuntimeMs: 1800001 }, { minIntervalMs: -1 }, { maxChunks: 121 },
    { windowBlocks: 120001 }, { chunkBlocks: 2001 }, { windowBlocks: 5100 }, { runId: "../escape" }]) {
    await assert.rejects(runBackfill({ ...args, ...extra }), /INDEX_INVALID/);
  }
  assert.equal(a.calls.length, 0); assert.deepEqual(fs.readdirSync(args.outDir), []);
});

test("read-only method allowlist rejects all other RPCs without consuming requests", async () => {
  let calls = 0;
  const time = clock(), paced = createPacedTransports({ transports: [async () => { calls++; }, async () => { calls++; }], now: time.now, sleep: time.sleep });
  for (const method of ["eth_sendRawTransaction", "eth_sendTransaction", "eth_sign", "personal_sign", "eth_call", "debug_traceCall", "anvil_mine"]) {
    await assert.rejects(paced.transports[0](method, [], 1, 1000), /READ_ONLY_METHOD_REQUIRED/);
  }
  assert.equal(calls, 0); assert.equal(paced.stats().requests, 0);
});

test("import is inert: no filesystem data IO, endpoint discovery, timers, network or CLI side effects", (t) => {
  const modulePath = require.resolve("../compound-v3-base-backfill");
  const read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (file, ...rest) => {
    assert.equal(file, modulePath); return read(file, ...rest);
  });
  for (const name of ["writeFileSync", "mkdirSync", "readdirSync", "lstatSync"]) t.mock.method(fs, name, () => { throw new Error("IMPORT_IO"); });
  t.mock.method(globalThis, "setTimeout", () => { throw new Error("IMPORT_TIMER"); });
  t.mock.method(crypto, "randomBytes", () => { throw new Error("IMPORT_RANDOM"); });
  delete require.cache[modulePath];
  const imported = require(modulePath);
  assert.equal(typeof imported.runBackfill, "function"); assert.equal(typeof imported.createPacedTransports, "function");
});
