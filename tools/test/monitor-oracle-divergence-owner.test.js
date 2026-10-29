"use strict";

// Offline output ownership: synthetic chain pins and sentinels, no transport or API reads.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ethers } = require("../node_modules/ethers");
const { acquireCanaryOutputOwner, CanaryOutputOwnershipError, LOCK_NAME } =
  require("../lib/canary-output-owner.js");
const { runOnce, main, HISTORY_SCHEMA, evaluateSentinel, evaluateChainSentinels } = require("../monitor-oracle-divergence.js");
const sha = "a".repeat(64);
const sourceDigest = "d8e47e5034747b901007f6d47c5a07b431fb99a8fb2f73af70466575aa6fa5bd";
function fixedUniverse() {
  return { sha256: sha, sourceConstantSha256: sourceDigest, rows: Array.from({ length: 351 }, (_, i) => {
    const chainId = i < 33 ? 8453 : i === 350 ? 42161 : 1;
    const oracle = `0x${i.toString(16).padStart(8, "0")}${"0".repeat(32)}`;
    return { sentinel: `div:${chainId}:${oracle.slice(2, 10)}`, chainId, oracle,
      marketId: `0x${(i + 1).toString(16).padStart(64, "0")}`, pair: "historical",
      kind: "constant-oracle", provenanceConstant: i < 33 };
  }) };
}

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "divergence-owner-offline-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function offline() {
  let block = 100;
  return {
    nextBlock() { block++; },
    qualifyChain: async (cid) => cid === 1
      ? { chain: { qualified: true, block, hash: "0x" + "aa".repeat(32), timestamp: 1 }, ctx: {} }
      : { chain: { qualified: false, reason: "endpoint-unavailable" }, ctx: null },
    loadConstantOracles: () => [{ chainId: 1, oracle: "0x" + "11".repeat(20),
      kind: "constant-oracle", provenanceConstant: true }],
    bindOracles: async () => new Map(),
    fetchApiMarkets: async () => [],
    evaluateChainSentinels: async (_cid, specs, _ctx, carry) => specs.map((spec) => ({
      sentinel: "synthetic", chainId: spec.chainId, oracle: spec.oracle,
      ok: true, fired: false, feedless: false, kind: spec.kind,
      referenceOk: false, sustained: false, consecutiveOver: carry.previousChains["1"] ? 2 : 1,
      measurements: { oraclePrice: "123", priceStreak: 1, priceFirstSeenMs: carry.nowMs },
    })),
  };
}

test("same output (including alternate status name) refuses before RPC and preserves status, history and cursors", async (t) => {
  const dir = temporary(t);
  const out = path.join(dir, "status.json");
  const historyPath = path.join(dir, "history-divergence.json");
  const deps = offline();
  const first = acquireCanaryOutputOwner(out);
  try {
    await runOnce(out, first, () => false, deps);
    const status = fs.readFileSync(out, "utf8");
    const history = fs.readFileSync(historyPath, "utf8");
    let unexpectedReads = 0;
    const forbidden = { ...deps, qualifyChain: async () => { unexpectedReads++; throw new Error("RPC called"); },
      runOnce: async () => { unexpectedReads++; throw new Error("RPC called"); } };
    for (const args of [["--once", "--out", out], ["--loop", "60", "--out", out],
      ["--out", path.join(dir, "alternate-status.json")]]) {
      await assert.rejects(main(args, forbidden), /EEXIST/);
    }
    assert.equal(unexpectedReads, 0);
    assert.equal(fs.readFileSync(out, "utf8"), status);
    assert.equal(fs.readFileSync(historyPath, "utf8"), history);
    assert.equal(fs.existsSync(path.join(dir, "alternate-status.json")), false);
    deps.nextBlock();
    await new Promise((resolve) => setTimeout(resolve, 5)); // run IDs have millisecond precision
    await runOnce(out, first, () => false, deps);
    const runs = JSON.parse(fs.readFileSync(historyPath, "utf8")).runs;
    assert.equal(runs.length, 2);
    assert.deepEqual(runs.map((run) => run.chains["1"]), [100, 101]);
    assert.deepEqual(runs.map((run) => run.consecutiveOver["1:0x" + "11".repeat(20)]), [1, 2]);
  } finally { assert.equal(first.release(), true); }
});

test("distinct directories can publish independently and normal one-shot lock is released", async (t) => {
  const dir = temporary(t);
  const firstOut = path.join(dir, "a", "status.json");
  const secondOut = path.join(dir, "b", "status.json");
  const first = acquireCanaryOutputOwner(firstOut);
  try {
    const code = await main(["--once", "--out", secondOut], offline());
    assert.equal(code, 1); // incomplete synthetic chains, not an ownership error
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "b", "history-divergence.json"), "utf8")).schema, HISTORY_SCHEMA);
    assert.equal(fs.existsSync(path.join(dir, "b", LOCK_NAME)), false);
    assert.equal(fs.existsSync(first.lockDir), true);
  } finally { assert.equal(first.release(), true); }
  assert.equal(fs.existsSync(first.lockDir), false);
  assert.equal(await main(["--once", "--out", firstOut], offline()), 1);
  assert.equal(fs.existsSync(first.lockDir), false);
});

test("loop FIRE exits with code 3 and releases its output lock", async (t) => {
  const dir = temporary(t);
  const out = path.join(dir, "status.json");
  const deps = offline();
  deps.evaluateChainSentinels = async (_cid, specs) => specs.map((spec) => ({
    sentinel: "synthetic", chainId: spec.chainId, oracle: spec.oracle, kind: spec.kind,
    ok: true, fired: true, feedless: true, referenceOk: false, sustained: false,
    consecutiveOver: 0, measurements: { oraclePrice: "123" },
  }));
  assert.equal(await main(["--loop", "60", "--out", out], deps), 3);
  assert.equal(JSON.parse(fs.readFileSync(out, "utf8")).verdict, "FIRED");
  assert.equal(fs.existsSync(path.join(dir, LOCK_NAME)), false);
});

test("opt-in unbounded keep-watching polls after FIRE and retains the alarm after a dormant observation", async (t) => {
  const dir = temporary(t);
  const out = path.join(dir, "status.json");
  let nowMs = Date.parse("2026-09-26T00:00:00.000Z");
  let polls = 0;
  let waits = 0;
  const deps = offline();
  deps.now = () => nowMs;
  deps.evaluateChainSentinels = async (_cid, specs) => {
    polls++;
    return specs.map((spec) => ({
      sentinel: "synthetic", chainId: spec.chainId, oracle: spec.oracle, kind: spec.kind,
      ok: true, fired: polls === 1, feedless: false, referenceOk: false, sustained: false,
      consecutiveOver: 0, measurements: { oraclePrice: "123" },
    }));
  };
  deps.sleep = async (_ms, stop) => {
    waits++;
    if (waits === 1) nowMs += 73 * 3600_000; // past the normal 72-hour cutoff
    else stop();
  };
  const code = await main(["--loop", "60", "--keep-watching-on-fire", "--no-deadline", "--out", out], deps);
  assert.equal(code, 3);
  assert.equal(polls, 2);
  assert.equal(waits, 2);
  const status = JSON.parse(fs.readFileSync(out, "utf8"));
  const history = JSON.parse(fs.readFileSync(path.join(dir, "history-divergence.json"), "utf8"));
  assert.equal(status.verdict, "INCOMPLETE"); // current snapshot; previous FIRE remains latched
  assert.equal(status.firedCount, 0);
  assert.deepEqual(history.runs.map((run) => run.verdict), ["FIRED", "INCOMPLETE"]);
  assert.deepEqual(status.lastFire, { runId: history.runs[0].runId, at: history.runs[0].at, fired: ["synthetic"] });
  assert.deepEqual(history.lastFire, status.lastFire);
  assert.equal(fs.existsSync(path.join(dir, LOCK_NAME)), false);
});

test("keep-watching without no-deadline still honors default and explicit finite caps", async (t) => {
  const dir = temporary(t);
  for (const [name, options, jumpHours] of [["default", [], 73], ["explicit", ["--max-hours", "1"], 2]]) {
    let nowMs = Date.parse("2026-09-26T00:00:00.000Z");
    let polls = 0;
    const deps = offline();
    deps.now = () => nowMs;
    deps.evaluateChainSentinels = async (_cid, specs) => {
      polls++;
      return specs.map((spec) => ({ sentinel: "synthetic", chainId: spec.chainId, oracle: spec.oracle,
        kind: spec.kind, fired: true, ok: true, feedless: true, referenceOk: false,
        sustained: false, consecutiveOver: 0, measurements: { oraclePrice: "123" } }));
    };
    deps.sleep = async () => { nowMs += jumpHours * 3600_000; };
    const out = path.join(dir, name, "status.json");
    assert.equal(await main(["--loop", "60", "--keep-watching-on-fire", ...options, "--out", out], deps), 3);
    assert.equal(polls, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, name, "history-divergence.json"), "utf8")).runs.length, 1);
    assert.equal(fs.existsSync(path.join(dir, name, LOCK_NAME)), false);
  }
});

test("unbounded mode and malformed options fail before acquiring owner or reading chains", async (t) => {
  const dir = temporary(t);
  const out = path.join(dir, "status.json");
  let called = 0;
  const deps = { runOnce: async () => { called++; }, qualifyChain: async () => { called++; } };
  for (const flags of [
    ["--no-deadline"], ["--loop", "60", "--no-deadline"], ["--keep-watching-on-fire"],
    ["--loop", "60", "--keep-watching-on-fire", "--no-deadline", "--max-hours", "1"],
    ["--once", "--loop", "60"], ["--loop"], ["--loop", "NaN"], ["--loop", "0"],
    ["--loop", "60", "--max-hours"], ["--loop", "60", "--max-hours", "Infinity"],
    ["--max-hours", "1"], ["--loop", "60", "--loop", "60"],
  ]) {
    await assert.rejects(main([...flags, "--out", out], deps));
  }
  assert.equal(called, 0);
  assert.equal(fs.existsSync(out), false);
  assert.equal(fs.existsSync(path.join(dir, LOCK_NAME)), false);
});

test("lost ownership during scan stops before status or history write", async (t) => {
  const dir = temporary(t);
  const out = path.join(dir, "status.json");
  const owner = acquireCanaryOutputOwner(out);
  const originalStatus = "original status";
  const originalHistory = JSON.stringify({ schema: HISTORY_SCHEMA, runs: [{ chains: { "1": 77 } }] });
  fs.writeFileSync(out, originalStatus);
  fs.writeFileSync(path.join(dir, "history-divergence.json"), originalHistory);
  const deps = offline();
  const qualifyChain = deps.qualifyChain;
  deps.qualifyChain = async (cid) => {
    const result = await qualifyChain(cid);
    if (cid === 4663) fs.writeFileSync(path.join(owner.lockDir, "owner.json"),
      JSON.stringify({ token: "replacement", pid: process.pid, startedAt: new Date().toISOString() }));
    return result;
  };
  await assert.rejects(runOnce(out, owner, () => false, deps), CanaryOutputOwnershipError);
  assert.equal(fs.readFileSync(out, "utf8"), originalStatus);
  assert.equal(fs.readFileSync(path.join(dir, "history-divergence.json"), "utf8"), originalHistory);
  assert.equal(owner.release(), false); // never remove a replaced lock
  assert.equal(fs.existsSync(owner.lockDir), true);
});

test("lost owner after status publication stops before history/cursor update", async (t) => {
  const dir = temporary(t);
  const out = path.join(dir, "status.json");
  const historyPath = path.join(dir, "history-divergence.json");
  const history = JSON.stringify({ schema: HISTORY_SCHEMA, runs: [{ chains: { "1": 77 } }] });
  fs.writeFileSync(historyPath, history);
  const owner = acquireCanaryOutputOwner(out);
  const originalWrite = fs.writeFileSync;
  fs.writeFileSync = function (file, ...args) {
    const result = originalWrite.call(this, file, ...args);
    if (file === out) originalWrite.call(fs, path.join(owner.lockDir, "owner.json"),
      JSON.stringify({ token: "replacement", pid: process.pid, startedAt: new Date().toISOString() }));
    return result;
  };
  try {
    await assert.rejects(runOnce(out, owner, () => false, offline()), CanaryOutputOwnershipError);
  } finally { fs.writeFileSync = originalWrite; }
  assert.equal(fs.readFileSync(historyPath, "utf8"), history);
  assert.equal(owner.release(), false);
});

test("history output alias is refused and stop requested during scan publishes nothing", async (t) => {
  const dir = temporary(t);
  const historyPath = path.join(dir, "history-divergence.json");
  await assert.rejects(main(["--out", historyPath], offline()), CanaryOutputOwnershipError);
  assert.equal(fs.existsSync(dir), true);
  const out = path.join(dir, "status.json");
  const owner = acquireCanaryOutputOwner(out);
  try {
    await assert.rejects(runOnce(out, owner, () => true, offline()), /divergence-scan-stopped/);
    assert.equal(fs.existsSync(out), false);
    assert.equal(fs.existsSync(historyPath), false);
  } finally { assert.equal(owner.release(), true); }
});

test("pinned 351 identities survive top100 churn, 33 Base rows and unqualified chain without API calls", async (t) => {
  const dir = temporary(t);
  const out = path.join(dir, "status.json");
  let apiCalls = 0;
  let pinnedLoads = 0;
  let seenCarry;
  const deps = { pinnedUniverse: true, now: () => Date.parse("2026-09-26T00:01:00Z"),
    loadPinnedDivergenceUniverse: () => { pinnedLoads++; return fixedUniverse(); },
    loadConstantOracles: () => { apiCalls++; throw new Error("legacy constant universe"); },
    fetchApiMarkets: () => { apiCalls++; throw new Error("top100 churn"); },
    bindOracles: () => { apiCalls++; throw new Error("API bind"); },
    qualifyChain: async (cid) => ({ chain: cid === 42161
      ? { qualified: false, reason: "endpoint-unavailable" }
      : { qualified: true, block: 100, hash: "0x" + "ab".repeat(32), timestamp: 1 },
    ctx: cid === 42161 ? null : {} }),
    evaluateChainSentinels: async (_cid, specs, ctx, carry) => {
      seenCarry = carry;
      return specs.map((spec) => ({ sentinel: spec.sentinel, chainId: spec.chainId,
        oracle: spec.oracle, marketId: spec.marketId, pair: spec.pair, kind: spec.kind,
        ok: !!ctx, fired: false, actionable: false, referenceOk: !!ctx, sustained: false,
        noRouteProof: true, observationalOnly: true, feedless: false,
        consecutiveOver: 0, measurements: { marketBound: !!ctx, marketStateReadable: !!ctx, oraclePrice: "1" } }));
    } };
  const oldHistory = { schema: HISTORY_SCHEMA, lastFire: { fired: ["old-unpinned-fire"] },
    runs: [{ runId: "old", at: "2026-09-26T00:00:00.000Z", verdict: "FIRED", fired: ["old-unpinned-fire"],
      chains: { "1": 99 }, prices: { arbitrary: "99" }, consecutiveOver: { arbitrary: 7 },
      structuralZero: { poisoned: true } }] };
  fs.writeFileSync(path.join(dir, "history-divergence.json"), JSON.stringify(oldHistory));
  const owner = acquireCanaryOutputOwner(out);
  try {
    const result = await runOnce(out, owner, () => false, deps);
    assert.equal(pinnedLoads, 1);
    assert.equal(apiCalls, 0);
    assert.equal(result.pinnedUniverseSha256, sha);
    assert.equal(result.sourceConstantSha256, sourceDigest);
    assert.equal(result.noRouteProof, true);
    assert.equal(result.sentinels.length, 351);
    assert.equal(result.sentinels.filter((s) => s.chainId === 8453).length, 33);
    assert.deepEqual(result.sentinels.map((s) => [s.sentinel, s.oracle, s.marketId, s.pair, s.kind]),
      fixedUniverse().rows.map((s) => [s.sentinel, s.oracle, s.marketId, s.pair, s.kind]));
    assert.equal(result.sentinels.at(-1).ok, false);
    assert.equal(result.lastFire, null);
    assert.deepEqual(seenCarry.consecutiveOver, {});
    assert.equal(seenCarry.structuralZero, undefined);
    const history = JSON.parse(fs.readFileSync(path.join(dir, "history-divergence.json"), "utf8"));
    assert.equal(history.runs.length, 1);
    assert.equal(history.runs[0].pinnedUniverseSha256, sha);
    assert.equal(history.runs[0].sourceConstantSha256, sourceDigest);
  } finally { assert.equal(owner.release(), true); }
});

test("mismatched pinned digest cannot carry streak, price or latched FIRE", async (t) => {
  const dir = temporary(t);
  const out = path.join(dir, "status.json");
  const history = { schema: HISTORY_SCHEMA, lastFire: { fired: ["wrong-hash"] }, runs: [
    { at: "2026-09-26T00:00:00.000Z", pinnedUniverseSha256: sha,
      sourceConstantSha256: "b".repeat(64), chains: { "1": 99 }, prices: { poisoned: "99" },
      consecutiveOver: { poisoned: 7 }, structuralZero: { poisoned: true } }] };
  fs.writeFileSync(path.join(dir, "history-divergence.json"), JSON.stringify(history));
  let carry;
  const deps = { pinnedUniverse: true, now: () => Date.parse("2026-09-26T00:01:00Z"),
    loadPinnedDivergenceUniverse: fixedUniverse,
    qualifyChain: async () => ({ chain: { qualified: false, reason: "offline" }, ctx: null }),
    evaluateChainSentinels: async (_cid, specs, _ctx, prior) => {
      carry = prior;
      return specs.map((s) => ({ sentinel: s.sentinel, chainId: s.chainId, oracle: s.oracle,
        marketId: s.marketId, kind: s.kind, ok: false, fired: false, referenceOk: false,
        sustained: false, actionable: false, feedless: false, consecutiveOver: 0,
        measurements: { marketBound: false, marketStateReadable: false } }));
    } };
  const owner = acquireCanaryOutputOwner(out);
  try {
    const status = await runOnce(out, owner, () => false, deps);
    assert.deepEqual(carry.prices, {});
    assert.deepEqual(carry.consecutiveOver, {});
    assert.equal(carry.structuralZero, undefined);
    assert.equal(carry.lastAt, null);
    assert.equal(status.lastFire, null);
    const next = JSON.parse(fs.readFileSync(path.join(dir, "history-divergence.json"), "utf8"));
    assert.equal(next.runs.length, 1);
    assert.equal(next.runs[0].pinnedUniverseSha256, sha);
    assert.equal(next.runs[0].sourceConstantSha256, sourceDigest);
  } finally { assert.equal(owner.release(), true); }
});

test("explicit pinned CLI loads identities before RPC and refuses malformed source without publication", async (t) => {
  const dir = temporary(t);
  const out = path.join(dir, "status.json");
  let reads = 0;
  const printed = console.error;
  console.error = () => {};
  try {
    const code = await main(["--once", "--pinned-universe", "--out", out], {
      loadPinnedDivergenceUniverse: () => ({ sha256: sha, rows: [] }),
      qualifyChain: async () => { reads++; throw new Error("RPC forbidden"); },
      fetchApiMarkets: async () => { reads++; throw new Error("API forbidden"); },
    });
    assert.equal(code, 1);
  } finally { console.error = printed; }
  assert.equal(reads, 0);
  assert.equal(fs.existsSync(out), false);
  assert.equal(fs.existsSync(path.join(dir, "history-divergence.json")), false);
  assert.equal(fs.existsSync(path.join(dir, LOCK_NAME)), false);
});

test("pinned qualifier transport exceptions preserve all 351 rows and truthful history without endpoint text", async (t) => {
  const dir = temporary(t);
  const out = path.join(dir, "status.json");
  const owner = acquireCanaryOutputOwner(out);
  let calls = 0;
  try {
    const result = await runOnce(out, owner, () => false, {
      pinnedUniverse: true, loadPinnedDivergenceUniverse: fixedUniverse,
      qualifyChain: async (cid) => {
        calls++;
        if (cid === 1 || cid === 8453) throw new Error("secret endpoint transport failure https://private.invalid/key");
        return { chain: { qualified: false, reason: "offline" }, ctx: null };
      },
    });
    assert.equal(calls, 5);
    assert.equal(result.verdict, "INCOMPLETE");
    assert.equal(result.sentinels.length, 351);
    assert.deepEqual(result.sentinels.map((row) => [row.sentinel, row.oracle, row.marketId]),
      fixedUniverse().rows.map((row) => [row.sentinel, row.oracle, row.marketId]));
    assert.ok(result.sentinels.every((row) => !row.ok && !row.fired && !row.actionable && !row.sustained));
    assert.equal(result.chains["1"].qualified, false);
    assert.equal(result.chains["1"].reason, "chain-qualification-failed");
    assert.equal(result.chains["8453"].reason, "chain-qualification-failed");
    assert.equal(result.firedCount, 0);
    const statusText = fs.readFileSync(out, "utf8");
    const historyText = fs.readFileSync(path.join(dir, "history-divergence.json"), "utf8");
    assert.doesNotMatch(statusText + historyText, /private\.invalid|transport failure|secret endpoint/);
    const recorded = JSON.parse(historyText).runs.at(-1);
    assert.equal(recorded.pinnedUniverseSha256, sha);
    assert.equal(recorded.chains["1"], null);
    assert.equal(recorded.chains["8453"], null);
    assert.equal(recorded.firedCount, 0);
    assert.deepEqual(recorded.prices, {});
  } finally { assert.equal(owner.release(), true); }
});

test("pinned qualifier ownership error aborts instead of publishing unavailable rows", async (t) => {
  const dir = temporary(t);
  const out = path.join(dir, "status.json");
  const owner = acquireCanaryOutputOwner(out);
  try {
    await assert.rejects(runOnce(out, owner, () => false, {
      pinnedUniverse: true, loadPinnedDivergenceUniverse: fixedUniverse,
      qualifyChain: async () => { throw new CanaryOutputOwnershipError(); },
    }), CanaryOutputOwnershipError);
    assert.equal(fs.existsSync(out), false);
    assert.equal(fs.existsSync(path.join(dir, "history-divergence.json")), false);
  } finally { assert.equal(owner.release(), true); }
});

test("pinned positive candidate ignores forged prior zero and never fires amid incomplete rows", async (t) => {
  const dir = temporary(t);
  const out = path.join(dir, "status.json");
  const owner = acquireCanaryOutputOwner(out);
  const oracle = "0x" + "11".repeat(20);
  const loan = "0x" + "33".repeat(20);
  const collateral = "0x" + "44".repeat(20);
  const irm = "0x" + "55".repeat(20);
  const params = [loan, collateral, oracle, irm, 915000000000000000n];
  const marketId = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "address", "address", "uint256"], params));
  const iface = new ethers.Interface([
    "function market(bytes32) view returns (uint128,uint128,uint128,uint128,uint128,uint128)",
    "function idToMarketParams(bytes32) view returns ((address,address,address,address,uint256))",
    "function price() view returns (uint256)", "function decimals() view returns (uint8)",
  ]);
  let block = 100;
  let clock = Date.parse("2026-09-26T00:01:00Z");
  const deps = {
    pinnedUniverse: true, now: () => clock,
    loadPinnedDivergenceUniverse: () => {
      const universe = fixedUniverse();
      universe.rows[0] = { ...universe.rows[0], oracle, marketId,
        sentinel: `div:8453:${oracle.slice(2, 10)}`, collateralToken: collateral, loanToken: loan };
      return universe;
    },
    qualifyChain: async (cid) => cid === 8453 ? { chain: { qualified: true, block,
      hash: "0x" + "ab".repeat(32), timestamp: Math.floor(clock / 1000) },
    ctx: { refCache: new Map([[collateral.toLowerCase(), null], [loan.toLowerCase(), null]]),
      async call(_to, data) {
        if (data.startsWith(iface.getFunction("price").selector))
          return iface.encodeFunctionResult("price", [10n ** 36n]);
        if (data.startsWith(iface.getFunction("idToMarketParams").selector))
          return iface.encodeFunctionResult("idToMarketParams", [params]);
        if (data.startsWith(iface.getFunction("market").selector))
          return iface.encodeFunctionResult("market", [block === 100 ? 100n : 1000n, 100n, 100n, 100n, 0n, 0n]);
        if (data.startsWith(iface.getFunction("decimals").selector))
          return iface.encodeFunctionResult("decimals", [18]);
        throw new Error("unexpected synthetic read");
      } } } : { chain: { qualified: false, reason: "offline" }, ctx: null },
    evaluateChainSentinels: async (cid, specs, ctx, carry) => cid === 8453
      ? [await evaluateSentinel(specs[0], ctx, carry),
        ...await evaluateChainSentinels(cid, specs.slice(1), null, carry)]
      : evaluateChainSentinels(cid, specs, null, carry),
  };
  try {
    const zero = await runOnce(out, owner, () => false, deps);
    assert.equal(zero.firedCount, 0);
    assert.equal(zero.sentinels[0].structuralVerified, true);
    assert.equal(zero.sentinels[0].availableRaw, "0");
    const firstHistory = JSON.parse(fs.readFileSync(path.join(dir, "history-divergence.json"), "utf8"));
    assert.equal(firstHistory.runs[0].structuralZero, undefined);
    // Even a legacy pinned FIRED run with a forged structuralZero is not authority.
    firstHistory.runs[0].structuralZero = { [`8453:${oracle.toLowerCase()}:${marketId.toLowerCase()}`]: true };
    firstHistory.runs[0].verdict = "FIRED";
    firstHistory.runs[0].fired = ["forged-edge"];
    firstHistory.lastFire = { runId: firstHistory.runs[0].runId, at: firstHistory.runs[0].at,
      fired: ["forged-edge"] };
    fs.writeFileSync(path.join(dir, "history-divergence.json"), JSON.stringify(firstHistory));
    block++;
    clock += 60_000;
    const positive = await runOnce(out, owner, () => false, deps);
    assert.equal(positive.sentinels.length, 351);
    assert.equal(positive.verdict, "INCOMPLETE");
    assert.equal(positive.firedCount, 0);
    assert.equal(positive.sentinels[0].structuralCandidate, true);
    assert.equal(positive.sentinels[0].signalType, undefined);
    assert.equal(positive.sentinels[0].fired, false);
    assert.equal(positive.sentinels[0].sustained, false);
    assert.equal(positive.lastFire, null);
    assert.equal(positive.sentinels[0].actionable, false);
    assert.equal(positive.sentinels[0].referenceOk, false);
    assert.equal(positive.sentinels[0].noRouteProof, true);
    assert.ok(positive.sentinels.slice(1).every((row) => !row.ok));
    const next = JSON.parse(fs.readFileSync(path.join(dir, "history-divergence.json"), "utf8"));
    assert.equal(next.runs.length, 1); // reject unverifiable legacy edge records
    assert.equal(next.runs[0].sourceConstantSha256, sourceDigest);
    assert.equal(next.runs[0].firedCount, 0);
    assert.equal(next.runs[0].structuralZero, undefined);
    assert.equal(next.lastFire, null);
  } finally { assert.equal(owner.release(), true); }
});
