"use strict";
// Entire pipeline is offline: ABI responses, reference prices, clock, storage and
// delivery are injected. No producer CLI, notification or filesystem write runs.
const test = require("node:test");
const assert = require("node:assert/strict");
const { runMonitor, SELECTORS, refKey } = require("../monitor-morpho-frozen-oracle");
const { runDispatcher, normalizeQueue, collectObservations } = require("../monitor-alert-dispatcher");
const { runIdFor } = require("../monitor-evidence");

const NOW = Date.parse("2026-10-25T12:00:00.000Z"), SEC = NOW / 1000;
const iso = (ms = NOW) => new Date(ms).toISOString();
const hex = (n, size) => "0x" + n.toString(16).padStart(size * 2, "0");
const words = (...values) => "0x" + values.map((v) => BigInt(v).toString(16).padStart(64, "0")).join("");
const EMPTY = { schema: "monitor-alert-queue/v1", alerts: [], dropped: 0 };
function market(n) {
  return { chainId: 1, marketId: hex(n, 32), oracle: hex(n + 20, 20), collateral: `TEST${n}`, loan: "USDC",
    collateralAddress: hex(n + 40, 20), loanAddress: hex(70, 20), collateralDecimals: 18, loanDecimals: 6,
    lltv: "915000000000000000", loanUsdStable: true, feeds: [{ address: hex(n + 80, 20), decimals: 8 }] };
}
async function producer(active = [1], ms = NOW) {
  const markets = [market(1), market(2)];
  return runMonitor({ markets, nowSeconds: ms / 1000,
    transport: { callEth: async (_chain, _to, data) => {
      if (data.startsWith(SELECTORS.market)) return { ok: true,
        result: words(active.some((n) => data.endsWith(hex(n, 32).slice(2))) ? 10169 : 0, 0, 0, 0) };
      if (data === SELECTORS.price) return { ok: true, result: words(10n ** 24n) };
      assert.equal(data, SELECTORS.latestRoundData);
      return { ok: true, result: words(0, 100000000, SEC - 864000, SEC - 864000, 0) };
    } },
    referenceProvider: { resolveMany: async () => new Map(markets.map((m) => [refKey(1, m.collateralAddress),
      { ok: true, price: 0.1, asOf: SEC - 7200, source: "synthetic" }])) },
  });
}
function inputs(frozenOracle, ms = NOW, count = 0) {
  return { frozenOracle, autopilotHealth: { generatedAt: iso(ms), services: [],
    triggerStatus: { status: count ? "triggered" : "clear", triggered: count } } };
}
function pass(input, previous = {}, ms = NOW) {
  return runDispatcher({ inputs: input, priorState: previous.state ?? null, priorQueue: previous.queue ?? EMPTY,
    clock: () => ms, apply: true, dispatchCap: 0,
    delivery: () => { throw Error("unexpected notification"); }, write: () => {},
    fsImpl: { lstatSync: () => { throw Error("unexpected filesystem read"); } } });
}
const alerts = (result) => result.candidates.filter((r) => r.source === "morpho-frozen-oracle");
const stateRow = (result) => result.state.observations["trigger:morpho-frozen-oracle"];

function assertInvalidEvidence(alert) {
  assert.deepEqual(alert.monitorEvidence, {
    schema: "monitor-evidence/v1", producer: "morpho-frozen-oracle",
    observedAt: alert.observedAt, runId: runIdFor(alert.observedAt), scope: "MARKET_SET",
    executionEvaluation: "NOT_EVALUATED", predicate: "UNKNOWN", quality: "UNAVAILABLE",
    gaps: ["EVIDENCE_INVALID", "DETAILS_NOT_RETAINED", "ECONOMICS_NOT_EVALUATED"], markets: [],
  });
}

test("RH run keeps its own typed snapshot in rolling history before the next status replaces it", async () => {
  const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
  const filename = path.resolve(__dirname, "../monitor-rearm-canary-multichain.js");
  const localRequire = require("node:module").createRequire(filename);
  const files = new Map(), outPath = path.resolve(__dirname, "synthetic/status-multichain.json");
  const historyPath = path.join(path.dirname(outPath), "history-multichain.json");
  const missing = () => Object.assign(Error("synthetic absent file"), { code: "ENOENT" });
  const owner = {};
  const sandbox = { module: { exports: {} }, __dirname: path.dirname(filename),
    setInterval: () => ({ unref() {} }), clearInterval() {},
    require: (name) => name === "fs" ? {
      lstatSync: (file) => { if (!files.has(file)) throw missing(); return { isFile: () => true, isSymbolicLink: () => false }; },
      readFileSync: (file) => { if (!files.has(file)) throw missing(); return files.get(file); },
      writeFileSync: (file, text) => { assert.ok([outPath, historyPath].includes(file)); files.set(file, text); },
    } : name === "./monitor-evidence" ? {
      ...localRequire(name),
      // The vm isolates the producer's I/O. Marshal its JSON across the realm
      // boundary just as the real artifact reader does; no foreign prototypes.
      envelope: (...args) => localRequire(name).envelope(...JSON.parse(JSON.stringify(args))),
    } : name.endsWith("canary-output-owner.js") ? {
      assertCanaryOutputOwner: (actual, file) => { assert.equal(actual, owner); assert.equal(file, outPath); },
      CanaryOutputOwnershipError: class extends Error {},
    } : localRequire(name),
  };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), sandbox, { filename });
  const monitor = sandbox.module.exports;
  const { ethers } = require("../node_modules/ethers");
  const abi = new ethers.Interface([
    "function market(bytes32) view returns (uint128,uint128,uint128,uint128,uint128,uint128)",
    "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
    "function getRoundData(uint80) view returns (uint80,int256,uint256,uint256,uint80)",
  ]);
  let tick = 0;
  const selected = monitor.RH_EQUITY_MARKETS[0].marketId;
  const deps = {
    now: () => NOW + tick * 1000, loadStrikeSentinels: () => [], loadExecutions: () => null,
    qualifyChain: async (cid) => ({ chain: { qualified: cid === 4663, block: 12, hash: hex(12, 32), timestamp: SEC },
      url: cid === 4663 ? "synthetic" : null }),
    sentinelUsdeModt: async () => ({ sentinel: "rh:usde-usdg-modt-deviation", fired: false, ok: true }),
    sentinelRhEquity: (_url, blockHex, options) => monitor.sentinelRhEquity(null, blockHex, { ...options,
      caller: { call: async (_to, data) => {
        const name = abi.getFunction(data.slice(0, 10)).name;
        if (name === "market") return abi.encodeFunctionResult(name,
          [0, 0, tick === 0 && abi.decodeFunctionData(name, data)[0] === selected ? 10_000_000n : 0n, 0, 0, 0]);
        if (name === "latestRoundData") return abi.encodeFunctionResult(name, [2, 100, 0, SEC - 86401, 2]);
        return "0x"; // a real stale-positive with partial evidence
      } },
    }),
    evaluateUpgradeConfig: async (_url, _hex, _block, spec) => ({ row: { sentinel: spec.id, ok: false, fired: false } }),
  };
  const first = await monitor.runOnce(outPath, {}, owner, () => false, deps);
  tick++;
  const second = await monitor.runOnce(outPath, {}, owner, () => false, deps);
  const history = JSON.parse(files.get(historyPath));
  const latest = JSON.parse(files.get(outPath));
  assert.equal(history.runs.length, 2);
  assert.equal(history.runs[0].runId, first.runId);
  assert.equal(history.runs[0].monitorEvidence.observedAt, history.runs[0].at);
  assert.equal(history.runs[0].monitorEvidence.runId, history.runs[0].runId);
  assert.equal(history.runs[0].monitorEvidence.predicate, "TRUE");
  assert.equal(history.runs[1].monitorEvidence.predicate, "FALSE");
  assert.equal(latest.runId, second.runId);
  assert.deepEqual(latest.sentinels.find((r) => r.sentinel === "rh:rh-equity-gap-threshold").monitorEvidence,
    history.runs[1].monitorEvidence);
  assert.deepEqual(history.runs[0].fired, ["rh:rh-equity-gap-threshold"]);
});

test("actual producer evidence survives observation -> alert -> normalizeQueue, despite newer health", async () => {
  const baseline = pass(inputs(await producer([])));
  const artifact = await producer([1], NOW + 1000);
  const result = pass(inputs(artifact, NOW + 2000, 0), baseline, NOW + 2000);
  assert.equal(alerts(result).length, 1);
  const alert = alerts(result)[0];
  assert.equal(alert.observedAt, artifact.capturedAt);
  assert.equal(alert.monitorEvidence.observedAt, artifact.capturedAt);
  assert.equal(alert.monitorEvidence.runId, artifact.runId);
  assert.equal(alert.monitorEvidence.markets.length, 1);
  assert.equal(alert.monitorEvidence.markets[0].marketId, hex(1, 32));
  assert.equal(alert.monitorEvidence.executionEvaluation, "NOT_EVALUATED");
  const retained = normalizeQueue(JSON.parse(JSON.stringify(result.queue))).alerts[0];
  assert.deepEqual(retained.monitorEvidence, alert.monitorEvidence);
  assert.equal(retained.eventKey, alert.eventKey);
  assert.equal(retained.id, result.queue.alerts[0].id);
  assert.equal(retained.pending, true);
  for (const status of ["DELIVERY_UNAVAILABLE", "DELIVERED"]) {
    const persisted = JSON.parse(JSON.stringify(result.queue));
    persisted.alerts[0].delivery = { status, attemptedAt: iso(NOW + 2000) };
    const normalized = normalizeQueue(persisted).alerts[0];
    assert.deepEqual(normalized.monitorEvidence, alert.monitorEvidence);
    assert.deepEqual(normalized.delivery, persisted.alerts[0].delivery);
    assert.equal(normalized.pending, status !== "DELIVERED");
  }
});

test("same-count replacement updates once; timestamp/measurements/restart alone do not replay", async () => {
  const baseline = pass(inputs(await producer([1])));
  const changed = pass(inputs(await producer([2], NOW + 1000), NOW + 1000), baseline, NOW + 1000);
  assert.equal(alerts(changed).length, 1);
  assert.equal(alerts(changed)[0].monitorEvidence.markets[0].marketId, hex(2, 32));
  const restarted = JSON.parse(JSON.stringify(changed));
  const stable = pass(inputs(await producer([2], NOW + 2000), NOW + 2000), restarted, NOW + 2000);
  assert.equal(alerts(stable).length, 0);
  assert.equal(stable.queue.alerts.length, 1);
});

test("aggregate fallback cannot recover or erase identity; detailed recovery remains possible", async () => {
  const baseline = pass(inputs(await producer([1])));
  const fallback = pass(inputs(null, NOW + 1000, 0), baseline, NOW + 1000);
  assert.equal(alerts(fallback).length, 0);
  assert.equal(stateRow(fallback).active, true);
  assert.deepEqual(stateRow(fallback).activeMarketSet, stateRow(baseline).activeMarketSet);
  const stable = pass(inputs(await producer([1], NOW + 2000), NOW + 2000), fallback, NOW + 2000);
  assert.equal(alerts(stable).length, 0);
  const recovered = pass(inputs(await producer([], NOW + 3000), NOW + 3000), stable, NOW + 3000);
  assert.equal(alerts(recovered).length, 1);
  assert.equal(alerts(recovered)[0].severity, "info");
  assert.deepEqual(alerts(recovered)[0].monitorEvidence.markets, []);
  assert.equal(alerts(recovered)[0].monitorEvidence.predicate, "FALSE");
});

test("missing legacy identity baseline seeds silently and legacy queued delivery/IDs survive", async () => {
  const baseline = pass(inputs(await producer([1])));
  delete stateRow(baseline).activeMarketSet;
  const legacy = { id: "legacy-id", eventKey: "legacy-event", key: "trigger:morpho-frozen-oracle",
    source: "morpho-frozen-oracle", kind: "trigger", severity: "critical", message: "Old aggregate event",
    createdAt: iso(), observedAt: iso(), delivery: { status: "DELIVERY_UNAVAILABLE", attemptedAt: iso() } };
  baseline.queue.alerts.push(legacy);
  const seeded = pass(inputs(await producer([2], NOW + 1000), NOW + 1000), baseline, NOW + 1000);
  assert.equal(alerts(seeded).length, 0);
  assert.deepEqual(stateRow(seeded).activeMarketSet, [`1:${hex(2, 32)}`]);
  assert.equal(seeded.queue.alerts[0].id, "legacy-id");
  assert.equal(seeded.queue.alerts[0].eventKey, "legacy-event");
  assert.deepEqual(seeded.queue.alerts[0].delivery, legacy.delivery);
  assert.equal(seeded.queue.alerts[0].monitorEvidence, undefined);
});

test("stale detail cannot decorate a health fallback; returning detail compares the retained membership", async () => {
  const artifact = await producer([1]);
  const baseline = pass(inputs(artifact));
  const later = NOW + 21 * 60_000;
  const fallback = pass(inputs(artifact, later, 2), baseline, later);
  assert.equal(alerts(fallback).length, 1);
  assert.equal(alerts(fallback)[0].observedAt, iso(later));
  assert.deepEqual(alerts(fallback)[0].monitorEvidence.markets, []);
  assert.deepEqual(stateRow(fallback).activeMarketSet, stateRow(baseline).activeMarketSet);
  const returning = pass(inputs(await producer([1], later + 1000), later + 1000), fallback, later + 1000);
  assert.equal(alerts(returning).length, 0);
  const replacement = pass(inputs(await producer([2], later + 2000), later + 2000), returning, later + 2000);
  assert.equal(alerts(replacement).length, 1);
  assert.equal(alerts(replacement)[0].monitorEvidence.markets[0].marketId, hex(2, 32));
});

test("health and legacy-detail fallback retain aggregate-only gaps without inferred market identity", async () => {
  const baseline = pass(inputs(null));
  const triggered = pass(inputs(null, NOW + 1000, 1), baseline, NOW + 1000);
  const evidence = alerts(triggered)[0].monitorEvidence;
  assert.deepEqual(evidence.markets, []);
  assert.ok(evidence.gaps.includes("AGGREGATE_ONLY"));
  assert.equal(evidence.runId, runIdFor(iso(NOW + 1000)));
  const legacy = await producer([1]);
  delete legacy.monitorEvidence;
  const row = collectObservations(inputs(legacy), NOW).find((r) => r.source === "morpho-frozen-oracle");
  assert.equal(row.activeMarketSet, null);
  assert.deepEqual(row.monitorEvidence.markets, []);
  assert.ok(row.monitorEvidence.gaps.includes("DETAILS_NOT_RETAINED"));
});

test("malformed/unbound evidence and raw message/provider/source fields never enter alerts or queue", async () => {
  const baseline = pass(inputs(await producer([])));
  for (const mutate of [
    (a) => { a.monitorEvidence = null; },
    (a) => { a.monitorEvidence = ["PRIVATE_PROVIDER_MARKER"]; },
    (a) => { a.monitorEvidence.schema = "monitor-evidence/v99"; },
    (a) => { a.monitorEvidence.observedAt = iso(NOW - 1000); },
    (a) => { a.monitorEvidence.observedAt = iso(NOW + 86400_000); },
    (a) => { a.monitorEvidence.runId = "wrong-run"; },
    (a) => { delete a.runId; },
    (a) => { a.monitorEvidence.markets[0].provider = "PRIVATE_PROVIDER_MARKER"; },
    (a) => { a.monitorEvidence.message = "PRIVATE_PROVIDER_MARKER"; },
    (a) => { a.monitorEvidence.source = "PRIVATE_PROVIDER_MARKER"; },
    (a) => { a.markets[0].marketId = hex(99, 32); },
    (a) => { a.monitorEvidence.markets[0].predicate = "FALSE"; },
  ]) {
    const artifact = await producer([1], NOW + 1000);
    mutate(artifact);
    artifact.message = artifact.provider = artifact.source = "PRIVATE_PROVIDER_MARKER";
    const result = pass(inputs(artifact, NOW + 1000), baseline, NOW + 1000);
    assertInvalidEvidence(alerts(result)[0]);
    assertInvalidEvidence(normalizeQueue(result.queue).alerts[0]);
    assert.equal(JSON.stringify(result).includes("PRIVATE_PROVIDER_MARKER"), false);
  }
  const artifact = await producer([1], NOW + 1000);
  const result = pass(inputs(artifact, NOW + 1000), baseline, NOW + 1000);
  for (const mutate of [
    (a) => { a.monitorEvidence = null; },
    (a) => { a.monitorEvidence = { source: "PRIVATE_PROVIDER_MARKER" }; },
    (a) => { a.monitorEvidence.schema = "monitor-evidence/v99"; },
    (a) => { a.observedAt = iso(); },
    (a) => { a.monitorEvidence.observedAt = iso(NOW + 86400_000); },
    (a) => { a.monitorEvidence.runId = "unbound"; },
    (a) => { a.monitorEvidence.markets[0].checks[0].message = "PRIVATE_PROVIDER_MARKER"; },
    (a) => { a.monitorEvidence.markets[0].predicate = "FALSE"; },
  ]) {
    const queue = JSON.parse(JSON.stringify(result.queue));
    mutate(queue.alerts[0]);
    const normalized = normalizeQueue(queue);
    assertInvalidEvidence(normalized.alerts[0]);
    assert.equal(normalized.alerts[0].id, queue.alerts[0].id);
    assert.equal(normalized.alerts[0].eventKey, queue.alerts[0].eventKey);
    assert.deepEqual(normalized.alerts[0].delivery, queue.alerts[0].delivery);
    assert.deepEqual(normalizeQueue(normalized), normalized);
    assert.equal(JSON.stringify(normalized).includes("PRIVATE_PROVIDER_MARKER"), false);
  }
});

test("queue evidence requires exact active/update/recovery eventKey time without rewriting historical identity", async () => {
  const baseline = pass(inputs(await producer([])));
  const result = pass(inputs(await producer([1], NOW + 1000), NOW + 1000), baseline, NOW + 1000);
  for (const phase of ["active", "update", "recovery"]) {
    const queue = JSON.parse(JSON.stringify(result.queue));
    const row = queue.alerts[0];
    row.eventKey = `trigger:morpho-frozen-oracle:${phase}:${row.observedAt}`;
    assert.deepEqual(normalizeQueue(queue).alerts[0].monitorEvidence, row.monitorEvidence);
    row.eventKey = `trigger:morpho-frozen-oracle:${phase}:${iso()}`;
    const normalized = normalizeQueue(queue);
    assertInvalidEvidence(normalized.alerts[0]);
    assert.equal(normalized.alerts[0].eventKey, row.eventKey);
    assert.equal(normalized.alerts[0].id, row.id);
    assert.deepEqual(normalized.alerts[0].delivery, row.delivery);
    assert.deepEqual(normalizeQueue(normalized), normalized);
    delete row.monitorEvidence;
    assert.equal(normalizeQueue(queue).alerts[0].monitorEvidence, undefined); // no legacy retrofit
  }
  for (const observedAt of [null, "not-a-time"]) {
    const queue = JSON.parse(JSON.stringify(result.queue));
    queue.alerts[0].observedAt = observedAt;
    assert.equal(normalizeQueue(queue).alerts[0].monitorEvidence, undefined); // cannot invent an enclosing time
  }
});
