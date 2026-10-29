#!/usr/bin/env node
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_DISPATCH_PER_PASS,
  MAX_MESSAGE_CHARS,
  MAX_QUEUE,
  collectObservations,
  runDispatcher,
  sanitizeMessage,
} = require("./monitor-alert-dispatcher");
const producer = require("./run-profit-trigger-watch.js");
const autopilot = require("./trigger-fork-autopilot.js");
const bridge = require("./run-trigger-fork-poc.js");

const NOW = Date.parse("2026-09-19T12:00:00.000Z");
const stamp = (delta = 0) => new Date(NOW + delta).toISOString();

function inputs(overrides = {}) {
  return {
    autopilotHealth: {
      generatedAt: stamp(), cycle: 10, summary: { triggerStatus: "clear", frozenOracleTriggered: 0 },
      triggerStatus: { status: "clear", triggered: 0 },
      services: [{ id: "alpha", running: true, readiness: "ready", artifact: { exists: true, fresh: true, acceptable: true } }],
    },
    scheduler: {
      generatedAt: stamp(), cadenceSeconds: 900, cycle: { sequence: 5 },
      producers: [{ id: "critical-one", triggerStatus: "INCOMPLETE", generatedAt: stamp() }],
    },
    profitTrigger: { generatedAt: stamp(), producers: [{ id: "legacy", status: "NO_CHANGE", generatedAt: stamp() }] },
    frozenOracle: { capturedAt: stamp(-1), summary: { TRIGGERED: 0 } },
    watchdog: { generatedAt: stamp(), wallClockCapped: false, services: [{ id: "alpha", state: "running", attempts: 0 }] },
    ...overrides,
  };
}

function forkInputs(producerId, { sourceAt = stamp(-1000), statusAt = stamp(),
  producerStatus = "ATOMIC_FORK_REQUIRED", execution = null, ...statusOverrides } = {}) {
  return inputs({
    profitTrigger: {
      schema: "profit-trigger-watch/v1", generatedAt: sourceAt,
      producers: [{ id: producerId, status: producerStatus, generatedAt: sourceAt }],
    },
    triggerForkAutopilot: {
      schema: "trigger-fork-autopilot-status/v1", generatedAt: statusAt,
      mode: "APPLY", classification: execution ? "EXECUTED" : "NO_FIRED_EVENT", blocker: null,
      source: { path: "reports/monitor/profit-trigger-watch.json", schema: "profit-trigger-watch/v1",
        generatedAt: sourceAt, fresh: true },
      execution: execution ? { producerId, firedStatus: producerStatus, success: true,
        promoted: true, blocker: null, ...execution } : null,
      ...statusOverrides,
    },
  });
}

function invoke(options = {}) {
  return runDispatcher({
    inputs: inputs(), clock: () => NOW, priorQueue: null, delivery: () => "DELIVERED",
    write: () => {}, ...options,
  });
}

test("first apply establishes a baseline without replaying existing faults", () => {
  const bad = inputs();
  bad.autopilotHealth.services[0].artifact.fresh = false;
  bad.watchdog.services[0] = { id: "alpha", state: "failed", attempts: 5, reason: "retry-limit", lastAttemptAt: stamp() };
  const result = invoke({ inputs: bad, apply: true, priorState: null });
  assert.equal(result.status.baselineEstablished, true);
  assert.equal(result.queue.alerts.length, 0);
});

test("pending legacy fork namespace quarantined without ACK/delete while health delivers",()=>{
  const baseline=invoke({apply:true,priorState:null});
  const row=(id,key,source)=>({id,eventKey:id,key,source,kind:"health",severity:"critical",message:"synthetic",createdAt:stamp(-1000),observedAt:stamp(-1000),delivery:{status:"QUEUED",attemptedAt:null},pending:true,acknowledged:false});
  const priorQueue={schema:baseline.queue.schema,updatedAt:stamp(-1000),dropped:0,retention:{deliveredAcknowledged:0,pendingUnacknowledged:0,legacyUnclassified:0},alerts:[row("old-key","fork-promotion:frax-usdc-cross-venue","legacy"),row("old-source","legacy-key","fork-promotion-base-usdc-usdt-cross-venue"),row("health","health:alpha","health-alpha")]};
  const sent=[];const r=invoke({apply:true,priorState:baseline.state,priorQueue,delivery:e=>{sent.push(e.id);return "DELIVERED";}});
  assert.deepEqual(sent,["health"]);assert.equal(r.queue.alerts.length,3);
  for(const e of r.queue.alerts.filter(e=>e.id!=="health")){assert.equal(e.pending,true);assert.equal(e.acknowledged,false);assert.equal(e.delivery.status,"QUEUED");assert.equal(e.delivery.attemptedAt,null);assert.equal(e.heldDiagnostic,"LEGACY_FORK_PROMOTION_HELD");}
  assert.deepEqual(r.queue.retention,priorQueue.retention);
  const again=invoke({apply:true,priorState:r.state,priorQueue:r.queue,delivery:()=>{throw new Error("quarantine sent");}});assert.equal(again.queue.alerts.filter(e=>e.pending).length,2);
});
test("queue overflow retains quarantined legacy fork while health retention stays accounted",()=>{
  const baseline=invoke({apply:true,priorState:null}),alerts=Array.from({length:MAX_QUEUE},(_,i)=>({id:"old-"+i,eventKey:"old-"+i,key:i===0?"fork-promotion:frax-usdc-cross-venue":"health:"+i,source:"health-"+i,kind:"health",severity:"warning",message:"synthetic",createdAt:stamp(-1000),delivery:{status:"QUEUED",attemptedAt:null}}));
  const priorQueue={...baseline.queue,alerts},changed=inputs();changed.autopilotHealth.services[0].artifact.fresh=false;
  const r=invoke({apply:true,priorState:baseline.state,priorQueue,inputs:changed,dispatchCap:0});assert.equal(r.queue.alerts.length,MAX_QUEUE);assert.equal(r.queue.alerts.some(e=>e.id==="old-0"),true);assert.equal(r.queue.alerts.find(e=>e.id==="old-0").pending,true);assert.equal(r.queue.retention.pendingUnacknowledged,1);
});

test("ready to not-ready emits one health alert", () => {
  const baseline = invoke({ apply: true, priorState: null });
  const bad = inputs();
  bad.autopilotHealth.services[0].artifact.fresh = false;
  const result = invoke({ inputs: bad, apply: true, priorState: baseline.state });
  assert.equal(result.candidates.filter((row) => row.key === "service:alpha").length, 1);
});

test("duplicate health state is suppressed", () => {
  const baseline = invoke({ apply: true, priorState: null });
  const bad = inputs();
  bad.autopilotHealth.services[0].running = false;
  const first = invoke({ inputs: bad, apply: true, priorState: baseline.state });
  const second = invoke({ inputs: bad, apply: true, priorState: first.state, priorQueue: first.queue });
  assert.equal(second.candidates.length, 0);
});

test("health recovery is emitted at info severity", () => {
  const baseline = invoke({ apply: true, priorState: null });
  const bad = inputs();
  bad.autopilotHealth.services[0].running = false;
  const failed = invoke({ inputs: bad, apply: true, priorState: baseline.state });
  const recovered = invoke({ apply: true, priorState: failed.state, priorQueue: failed.queue, cooldownMs: 0 });
  const alert = recovered.candidates.find((row) => row.key === "service:alpha");
  assert.equal(alert.severity, "info");
  assert.match(alert.message, /^\[RECOVERY\]/u);
});

test("watchdog relaunch emits a warning once", () => {
  const baseline = invoke({ apply: true, priorState: null });
  const changed = inputs();
  changed.watchdog.services[0] = { id: "alpha", state: "relaunched", attempts: 1, lastAttemptAt: stamp() };
  const first = invoke({ inputs: changed, apply: true, priorState: baseline.state });
  const second = invoke({ inputs: changed, apply: true, priorState: first.state, priorQueue: first.queue });
  assert.equal(first.candidates[0].severity, "warning");
  assert.equal(second.candidates.length, 0);
});

test("watchdog failure and cutoff emit critical alerts", () => {
  const baseline = invoke({ apply: true, priorState: null });
  const changed = inputs();
  changed.watchdog.services[0] = { id: "alpha", state: "failed", attempts: 5, reason: "retry-limit", lastAttemptAt: stamp() };
  changed.watchdog.wallClockCapped = true;
  const result = invoke({ inputs: changed, apply: true, priorState: baseline.state });
  assert.equal(result.candidates.filter((row) => row.severity === "critical").length, 2);
});

test("trigger transition and count increase alert, unchanged trigger does not", () => {
  const baseline = invoke({ apply: true, priorState: null });
  const one = inputs({ frozenOracle: { capturedAt: stamp(1), summary: { TRIGGERED: 1 } } });
  const first = invoke({ inputs: one, apply: true, priorState: baseline.state });
  const duplicate = invoke({ inputs: one, apply: true, priorState: first.state, priorQueue: first.queue });
  const two = inputs({ frozenOracle: { capturedAt: stamp(2), summary: { TRIGGERED: 2 } } });
  const increased = invoke({ inputs: two, apply: true, priorState: first.state, priorQueue: first.queue, cooldownMs: 0 });
  assert.equal(first.candidates.length, 1);
  assert.equal(duplicate.candidates.length, 0);
  assert.equal(increased.candidates.length, 1);
});

test("scheduler producer positive transition alerts once", () => {
  const baseline = invoke({ apply: true, priorState: null });
  const changed = inputs();
  changed.scheduler.producers[0].triggerStatus = "POSITIVE_FLOW";
  const first = invoke({ inputs: changed, apply: true, priorState: baseline.state });
  const second = invoke({ inputs: changed, apply: true, priorState: first.state, priorQueue: first.queue });
  assert.equal(first.candidates[0].key, "scheduler:critical-one");
  assert.equal(second.candidates.length, 0);
});

test("legacy FRAX status promotion remains held even after a quiet transition", () => {
  const baselineInputs = forkInputs("frax-usdc-cross-venue");
  const baseline = invoke({ inputs: baselineInputs, apply: true, priorState: null });
  const unpromoted = forkInputs("frax-usdc-cross-venue", { statusAt: stamp(-200), execution: { promoted: false } });
  const noAlert = invoke({ inputs: unpromoted, apply: true, priorState: baseline.state });
  assert.equal(noAlert.candidates.length, 0);
  const promoted = forkInputs("frax-usdc-cross-venue", { statusAt: stamp(-100), execution: {} });
  const result = invoke({ inputs: promoted, apply: true, priorState: noAlert.state });
  assert.equal(result.candidates.length, 0);
});

test("standalone dispatcher rejects unqualified or replayed fork promotion", () => {
  const id = "frax-usdc-cross-venue";
  const key = `fork-promotion:${id}`;
  const baseline = invoke({ inputs: forkInputs(id), apply: true, priorState: null });
  const invalid = [
    ["CHECK mode", (value) => { value.triggerForkAutopilot.mode = "CHECK"; }],
    ["wrong schema", (value) => { value.triggerForkAutopilot.schema = "other/v1"; }],
    ["incomplete execution", (value) => { value.triggerForkAutopilot.classification = "EXECUTED_FAILED"; }],
    ["overlap blocker", (value) => { value.triggerForkAutopilot.blocker = "OVERLAP_LOCKED"; }],
    ["execution failure", (value) => { value.triggerForkAutopilot.execution.success = false; }],
    ["execution blocker", (value) => { value.triggerForkAutopilot.execution.blocker = "FORK_FAILED"; }],
    ["not promoted", (value) => { value.triggerForkAutopilot.execution.promoted = false; }],
    ["wrong producer", (value) => { value.triggerForkAutopilot.execution.producerId = "base-usdc-usdt-cross-venue"; }],
    ["old source vs new producer", (value) => { value.profitTrigger.generatedAt = stamp(-500); }],
    ["no source", (value) => { delete value.triggerForkAutopilot.source; }],
    ["unfresh source", (value) => { value.triggerForkAutopilot.source.fresh = false; }],
    ["wrong source path", (value) => { value.triggerForkAutopilot.source.path = "other.json"; }],
    ["wrong source schema", (value) => { value.triggerForkAutopilot.source.schema = "other/v1"; }],
    ["missing profit source", (value) => { value.profitTrigger = null; }],
    ["not fired current producer", (value) => { value.profitTrigger.producers[0].status = "NO_GROSS_EDGE"; }],
    ["malformed status time", (value) => { value.triggerForkAutopilot.generatedAt = "not-a-date"; }],
    ["malformed source time", (value) => { value.triggerForkAutopilot.source.generatedAt = "yesterday";
      value.profitTrigger.generatedAt = "yesterday"; }],
    ["source after status", (value) => { value.triggerForkAutopilot.source.generatedAt = stamp(1);
      value.profitTrigger.generatedAt = stamp(1); }],
    ["future status", (value) => { value.triggerForkAutopilot.generatedAt = stamp(1); }],
    ["old status", (value) => { value.triggerForkAutopilot.generatedAt = stamp(-2 * 60_000 - 1); }],
    ["old source", (value) => { value.triggerForkAutopilot.source.generatedAt = stamp(-10 * 60_000 - 1);
      value.profitTrigger.generatedAt = stamp(-10 * 60_000 - 1); }],
  ];
  for (const [label, mutate] of invalid) {
    const value = forkInputs(id, { execution: {} });
    mutate(value);
    const observation = collectObservations(value, NOW).find((row) => row.key === key);
    assert.notEqual(observation?.active, true, label);
    const result = invoke({ inputs: value, apply: true, priorState: baseline.state });
    assert.equal(result.candidates.some((row) => row.key === key), false, label);
  }
});

test("fork promotion needs a matching producer; raw profit trigger alone cannot promote", () => {
  const id = "frax-usdc-cross-venue";
  const baseline = invoke({ inputs: forkInputs(id, { producerStatus: "NO_GROSS_EDGE" }), apply: true, priorState: null });
  const raw = forkInputs(id);
  const observation = collectObservations(raw, NOW).find((row) => row.key === `fork-promotion:${id}`);
  assert.equal(observation, undefined);
  const result = invoke({ inputs: raw, apply: true, priorState: baseline.state });
  assert.equal(result.candidates.some((row) => row.key === `fork-promotion:${id}`), false);
});

test("legacy Base status promotion is held even for matching producer identity", () => {
  const baselineInputs = forkInputs("base-usdc-usdt-cross-venue");
  const baseline = invoke({ inputs: baselineInputs, apply: true, priorState: null });
  const unpromoted = forkInputs("base-usdc-usdt-cross-venue", { statusAt: stamp(-200), execution: { promoted: false } });
  const noAlert = invoke({ inputs: unpromoted, apply: true, priorState: baseline.state });
  assert.equal(noAlert.candidates.length, 0);
  const promoted = forkInputs("base-usdc-usdt-cross-venue", { statusAt: stamp(-100), execution: {} });
  const result = invoke({ inputs: promoted, apply: true, priorState: noAlert.state });
  assert.equal(result.candidates.length, 0);

  const mismatched = forkInputs("base-usdc-usdt-cross-venue", { statusAt: stamp(-100), execution: { producerId: "kelp-composite" } });
  const ignored = invoke({ inputs: mismatched, apply: true, priorState: baseline.state });
  assert.equal(ignored.candidates.filter((row) => row.key === "fork-promotion:base-usdc-usdt-cross-venue").length, 0);
  assert.equal(ignored.candidates.length, 0);
});

test("a fired profit-trigger producer status alone never alerts before fork promotion", () => {
  const baseline = invoke({ apply: true, priorState: null });
  const fired = inputs();
  fired.profitTrigger.producers[0].status = "ATOMIC_FORK_REQUIRED";
  const result = invoke({ inputs: fired, apply: true, priorState: baseline.state });
  assert.equal(result.candidates.length, 0);
});

test("kelp producer contract status is an alert-positive fired event", () => {
  const status = producer.SUCCESS_STATUSES["kelp-composite"][1];
  assert.equal(status, "TRIGGER_UNPAUSE");
  assert.equal(autopilot.SUPPORTED_EVENTS.get("kelp-composite"), status);
  assert.equal(bridge.isFired(status), true);
  const initial = inputs();
  initial.profitTrigger.producers[0] = { id: "kelp-composite", status: "BLOCKED_PAUSED", generatedAt: stamp() };
  const baseline = invoke({ inputs: initial, apply: true, priorState: null });
  const changed = inputs();
  changed.profitTrigger.producers[0] = { id: "kelp-composite", status, generatedAt: stamp() };
  const observed = collectObservations(changed, NOW).find((row) => row.key === "profit-trigger:kelp-composite");
  assert.equal(observed.active, true);
  const result = invoke({ inputs: changed, apply: true, priorState: baseline.state });
  assert.equal(result.candidates.filter((row) => row.key === "profit-trigger:kelp-composite").length, 1);

  const old = inputs();
  old.profitTrigger.producers[0] = { id: "kelp-composite", status: "UNPAUSE_TRIGGER", generatedAt: stamp() };
  assert.equal(collectObservations(old, NOW).find((row) => row.key === "profit-trigger:kelp-composite").active, false);
});

test("fork promotion alert requires the exact FRAX producer identity", () => {
  const baseline = invoke({
    inputs: forkInputs("frax-usdc-cross-venue"),
    apply: true, priorState: null,
  });
  const mismatched = forkInputs("frax-usdc-cross-venue", { statusAt: stamp(-100), execution: { producerId: "kelp-composite" } });
  const result = invoke({ inputs: mismatched, apply: true, priorState: baseline.state });
  assert.equal(result.candidates.filter((row) => row.key === "fork-promotion:frax-usdc-cross-venue").length, 0);
  assert.equal(result.candidates.length, 0);
});

test("stale profit-trigger input is ignored", () => {
  const observed = collectObservations(inputs({
    profitTrigger: { generatedAt: stamp(-31 * 60_000), producers: [{ id: "legacy", status: "WINDOW_OPEN", generatedAt: stamp(-31 * 60_000) }] },
  }), NOW);
  assert.equal(observed.some((row) => row.key === "profit-trigger:legacy"), false);
});

test("message sanitizer removes URLs, credential labels, and controls", () => {
  const output = sanitizeMessage("see https://bad.invalid/x token=abc\npassword: xyz");
  assert.equal(/https?:|abc|xyz|\n/u.test(output), false);
});

test("messages are capped at the configured character bound", () => {
  assert.equal(sanitizeMessage("x".repeat(MAX_MESSAGE_CHARS + 100)).length, MAX_MESSAGE_CHARS);
});

test("unavailable delivery remains pending in durable queue", () => {
  const baseline = invoke({ apply: true, priorState: null });
  const changed = inputs();
  changed.autopilotHealth.services[0].running = false;
  const result = invoke({ inputs: changed, apply: true, priorState: baseline.state, delivery: () => "DELIVERY_UNAVAILABLE" });
  assert.equal(result.queue.alerts[0].pending, true);
  assert.equal(result.queue.alerts[0].acknowledged, false);
  assert.equal(result.queue.alerts[0].delivery.status, "DELIVERY_UNAVAILABLE");
});

test("dry-run performs no writes or delivery", () => {
  const baseline = invoke({ apply: true, priorState: null });
  const changed = inputs();
  changed.autopilotHealth.services[0].running = false;
  let writes = 0, sends = 0;
  const result = invoke({ inputs: changed, priorState: baseline.state, write: () => { writes += 1; }, delivery: () => { sends += 1; return "DELIVERED"; } });
  assert.equal(result.candidates.length, 1);
  assert.equal(writes, 0);
  assert.equal(sends, 0);
});

test("dispatch cap and per-source cooldown are enforced", () => {
  const baselineInputs = inputs();
  baselineInputs.autopilotHealth.services = Array.from({ length: 8 }, (_, index) => ({ id: `s${index}`, running: true, artifact: { exists: true, fresh: true, acceptable: true } }));
  const baseline = invoke({ inputs: baselineInputs, apply: true, priorState: null });
  const changed = structuredClone(baselineInputs);
  changed.autopilotHealth.services.forEach((row) => { row.running = false; });
  let sends = 0;
  const result = invoke({ inputs: changed, apply: true, priorState: baseline.state, delivery: () => { sends += 1; return "DELIVERED"; } });
  assert.equal(sends, MAX_DISPATCH_PER_PASS);
  assert.equal(result.queue.alerts.filter((row) => row.pending).length, 8 - MAX_DISPATCH_PER_PASS);
});

test("queue is bounded and drops acknowledged entries first", () => {
  const alerts = Array.from({ length: MAX_QUEUE }, (_, index) => ({
    id: `old-${index}`, eventKey: `old-event-${index}`, key: `old-${index}`, source: `old-${index}`, kind: "health",
    severity: "info", message: "old", observedAt: stamp(), createdAt: stamp(), test: false,
    pending: false, acknowledged: true, delivery: { status: "DELIVERED", attemptedAt: stamp() },
  }));
  const baseline = invoke({ apply: true, priorState: null });
  const changed = inputs();
  changed.autopilotHealth.services[0].running = false;
  const result = invoke({ inputs: changed, apply: true, priorState: baseline.state, priorQueue: { schema: "monitor-alert-queue/v1", alerts, dropped: 0 } });
  assert.equal(result.queue.alerts.length, MAX_QUEUE);
  assert.equal(result.queue.dropped, 1);
  assert.equal(result.queue.alerts.some((row) => row.key === "service:alpha"), true);
});

test("test notification is clearly labelled and contains no execution fields", () => {
  const result = invoke({ testNotification: true, priorState: null });
  const alert = result.queue.alerts[0];
  assert.match(alert.message, /^\[TEST\]/u);
  assert.equal(alert.test, true);
  assert.equal(Object.hasOwn(alert, "routePositive"), false);
  assert.equal(Object.hasOwn(alert, "executableNow"), false);
});

test("apply writes state, queue, and status through injected writer", () => {
  let written;
  invoke({ apply: true, priorState: null, write: (artifacts) => { written = artifacts; } });
  assert.equal(written.state.schema, "monitor-alert-dispatcher-state/v1");
  assert.equal(written.queue.schema, "monitor-alert-queue/v1");
  assert.equal(written.status.schema, "monitor-alert-dispatcher-status/v1");
});

test("apply harness never falls through to live artifact writes", () => {
  const fsImpl = new Proxy({}, {
    get: (_, operation) => () => assert.fail(`unexpected filesystem operation: ${String(operation)}`),
  });
  const result = invoke({ apply: true, priorState: null, fsImpl });
  assert.equal(result.status.baselineEstablished, true);
});
