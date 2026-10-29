"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { MAX_QUEUE, normalizeQueue, runDispatcher } = require("../monitor-alert-dispatcher");

const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const EMPTY = { schema: "monitor-alert-queue/v1", dropped: 0, alerts: [] };

function row(index, status = "QUEUED", overrides = {}) {
  return {
    id: `id-${index}`, eventKey: `event-${index}`, source: `source-${index}`,
    key: `key-${index}`, kind: "health", severity: "warning", message: "Synthetic alert",
    createdAt: new Date(NOW - 1_000).toISOString(), pending: status !== "DELIVERED",
    acknowledged: status === "DELIVERED", delivery: { status, attemptedAt: null },
    ...overrides,
  };
}

function pass(priorQueue, nowMs = NOW, extras = {}) {
  let writes = 0;
  const result = runDispatcher({
    inputs: {}, priorState: null, priorQueue, clock: () => nowMs,
    testNotification: true, dispatchCap: 0,
    delivery: () => { throw new Error("delivery must not run"); },
    write: ({ queue, status }) => {
      writes += 1;
      assert.deepEqual(status.summary.retention, queue.retention);
    },
    ...extras,
  });
  assert.equal(writes, 1);
  assert.deepEqual(result.status.summary.retention, result.queue.retention);
  assert.notStrictEqual(result.status.summary.retention, result.queue.retention);
  assert.equal(result.status.summary.dropped, result.queue.dropped);
  return result;
}

function totals(queue) {
  const { deliveredAcknowledged, pendingUnacknowledged, legacyUnclassified } = queue.retention;
  assert.equal(deliveredAcknowledged + pendingUnacknowledged + legacyUnclassified, queue.dropped);
  for (const count of [queue.dropped, deliveredAcknowledged, pendingUnacknowledged, legacyUnclassified]) {
    assert.ok(Number.isSafeInteger(count) && count >= 0);
  }
}

test("legacy 1340 drops remain unclassified, not inferred alert loss or delivery", () => {
  const queue = normalizeQueue({ ...EMPTY, dropped: 1340 });
  assert.deepEqual(queue.retention, { deliveredAcknowledged: 0, pendingUnacknowledged: 0, legacyUnclassified: 1340 });
  assert.deepEqual(pass(queue).status.summary.retention, queue.retention);
  totals(queue);
  assert.deepEqual(normalizeQueue(null).retention, normalizeQueue(EMPTY).retention);
});

test("valid zero and mixed counters survive normalization and repeated injected passes", () => {
  assert.deepEqual(normalizeQueue({ ...EMPTY, retention: { deliveredAcknowledged: 0, pendingUnacknowledged: 0, legacyUnclassified: 0 } }).retention,
    { deliveredAcknowledged: 0, pendingUnacknowledged: 0, legacyUnclassified: 0 });
  let queue = { ...EMPTY, dropped: 8, retention: { deliveredAcknowledged: 2, pendingUnacknowledged: 1, legacyUnclassified: 5 },
    alerts: Array.from({ length: MAX_QUEUE }, (_, i) => row(i, i === 18 || i === 240 ? "DELIVERED" : "QUEUED")) };
  const first = pass(queue);
  assert.equal(first.queue.alerts.some((alert) => alert.id === "id-18"), false);
  assert.equal(first.queue.alerts.some((alert) => alert.id === "id-240"), true);
  assert.deepEqual(first.queue.retention, { deliveredAcknowledged: 3, pendingUnacknowledged: 1, legacyUnclassified: 5 });
  totals(first.queue);
  queue = normalizeQueue(JSON.parse(JSON.stringify(first.queue)));
  const second = pass(queue, NOW + 1_000);
  assert.equal(second.queue.alerts.some((alert) => alert.id === "id-240"), false);
  assert.deepEqual(second.queue.retention, { deliveredAcknowledged: 4, pendingUnacknowledged: 1, legacyUnclassified: 5 });
  totals(second.queue);
});

test("invalid, tampered, negative, and unsafe retention counters preserve aggregate as unknown", () => {
  const bad = [
    { deliveredAcknowledged: 2, pendingUnacknowledged: 0, legacyUnclassified: 0 },
    { deliveredAcknowledged: -1, pendingUnacknowledged: 0, legacyUnclassified: 8 },
    { deliveredAcknowledged: Number.MAX_SAFE_INTEGER + 1, pendingUnacknowledged: 0, legacyUnclassified: 0 },
    { deliveredAcknowledged: 0, pendingUnacknowledged: 0 },
  ];
  for (const retention of bad) {
    const normalized = normalizeQueue({ ...EMPTY, dropped: 7, retention });
    assert.deepEqual(normalized.retention, { deliveredAcknowledged: 0, pendingUnacknowledged: 0, legacyUnclassified: 7 });
    totals(normalized);
  }
});

test("overflow evicts acknowledged first and trusts normalized delivery status over stale flags", () => {
  const queue = { ...EMPTY, alerts: Array.from({ length: MAX_QUEUE }, (_, i) => row(i,
    i === 210 ? "DELIVERED" : "QUEUED", i === 210 ? { pending: true, acknowledged: false } : {})) };
  assert.equal(normalizeQueue(queue).alerts[210].acknowledged, true);
  const result = pass(queue);
  assert.equal(result.queue.alerts.some((alert) => alert.id === "id-210"), false);
  assert.equal(result.queue.alerts.some((alert) => alert.id === "id-0"), true);
  assert.deepEqual(result.queue.retention, { deliveredAcknowledged: 1, pendingUnacknowledged: 0, legacyUnclassified: 0 });
  totals(result.queue);
});

test("all-pending and DELIVERY_UNAVAILABLE overflow count unacknowledged rather than delivered", () => {
  for (const status of ["QUEUED", "DELIVERY_UNAVAILABLE"]) {
    const result = pass({ ...EMPTY, alerts: Array.from({ length: MAX_QUEUE }, (_, i) => row(i, status,
      i === 0 ? { acknowledged: true, pending: false } : {})) });
    assert.equal(result.queue.alerts.some((alert) => alert.id === "id-0"), false);
    assert.deepEqual(result.queue.retention, { deliveredAcknowledged: 0, pendingUnacknowledged: 1, legacyUnclassified: 0 });
    totals(result.queue);
  }
});

test("ambiguous duplicate IDs preserve existing removal behavior but classify excess as unknown", () => {
  const alerts = Array.from({ length: MAX_QUEUE }, (_, i) => row(i, i < 2 ? "DELIVERED" : "QUEUED"));
  alerts[1].id = alerts[0].id;
  const result = pass({ ...EMPTY, alerts });
  assert.equal(result.queue.alerts.length, MAX_QUEUE - 1); // existing ID-set policy removes two rows
  assert.deepEqual(result.queue.retention, { deliveredAcknowledged: 0, pendingUnacknowledged: 0, legacyUnclassified: 1 });
  totals(result.queue);
});

test("saturated aggregate remains safe and does not speculate on further evictions", () => {
  const result = pass({ ...EMPTY, dropped: Number.MAX_SAFE_INTEGER,
    alerts: Array.from({ length: MAX_QUEUE }, (_, i) => row(i)) });
  assert.equal(result.queue.dropped, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(result.queue.retention,
    { deliveredAcknowledged: 0, pendingUnacknowledged: 0, legacyUnclassified: Number.MAX_SAFE_INTEGER });
  totals(result.queue);
});

test("check does not mutate source queue, deliver, write, enqueue, or account overflow", () => {
  const priorQueue = { ...EMPTY, dropped: 7, alerts: Array.from({ length: MAX_QUEUE }, (_, i) => row(i)) };
  const snapshot = JSON.stringify(priorQueue);
  const result = runDispatcher({ inputs: {}, priorState: null, priorQueue, clock: () => NOW,
    delivery: () => { throw new Error("delivery called"); }, write: () => { throw new Error("write called"); },
    fsImpl: { readFileSync: () => { throw new Error("fs read called"); } },
  });
  assert.equal(JSON.stringify(priorQueue), snapshot);
  assert.equal(result.status.mode, "check");
  assert.equal(result.status.summary.enqueued, 0);
  assert.equal(result.status.summary.dispatched, 0);
  assert.deepEqual(result.queue.retention, { deliveredAcknowledged: 0, pendingUnacknowledged: 0, legacyUnclassified: 7 });
  totals(result.queue);
});

test("existing event dedupe does not enqueue twice; injected delivery is the only delivery", () => {
  const existing = row(0, "DELIVERY_UNAVAILABLE", { eventKey: `test-local-notification-${NOW}` });
  let delivered = 0;
  const result = pass({ ...EMPTY, alerts: [existing] }, NOW, {
    dispatchCap: 1, delivery: () => { delivered += 1; return "DELIVERY_UNAVAILABLE"; },
  });
  assert.equal(result.status.summary.enqueued, 0);
  assert.equal(result.queue.alerts.length, 1);
  assert.equal(delivered, 1);
  assert.equal(result.dispatches[0].status, "DELIVERY_UNAVAILABLE");
  totals(result.queue);
});
