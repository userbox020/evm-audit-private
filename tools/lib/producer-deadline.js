"use strict";

// Cooperative in-process lifetime only: an ignored signal is not containment.
const { AsyncLocalStorage } = require("node:async_hooks");
const { performance } = require("node:perf_hooks");
const { setMaxListeners } = require("node:events");
const storage = new AsyncLocalStorage();

class DeadlineError extends Error {
  constructor(code) { super(code); this.name = "DeadlineError"; this.code = code; }
}

function current() { return storage.getStore()?.view || null; }

function check() {
  const scope = storage.getStore();
  if (!scope) return;
  if (!scope.closed && scope.clock() >= scope.deadline) scope.expire();
  if (scope.closed) throw new DeadlineError(scope.expired ? "TIMEOUT" : "PRODUCER_CLOSED");
}

function observe(scope, promise) {
  const original = Promise.resolve(promise);
  scope.pending.add(original);
  const settled = () => {
    scope.pending.delete(original);
    if (!scope.pending.size) for (const notify of scope.waiters) notify();
  };
  // Both observers fulfill, including for original promises that reject late.
  original.then(settled, settled);
  return original;
}

function invoke(factory) {
  check();
  const scope = storage.getStore();
  if (!scope) return factory();
  const original = observe(scope, factory());
  const guarded = original.then(
    value => { check(); return value; },
    error => { check(); throw error; },
  );
  guarded.then(() => {}, () => {});
  return guarded;
}

async function join(promises) {
  const scope = storage.getStore();
  const originals = Array.from(promises, promise => scope ? observe(scope, promise) : promise);
  const settled = await Promise.allSettled(originals);
  check();
  const failed = settled.find(result => result.status === "rejected");
  if (failed) throw failed.reason;
  return settled.map(result => result.value);
}

function sleep(ms) {
  return invoke(() => new Promise((resolve, reject) => {
    const signal = current()?.signal;
    let timer;
    const finish = error => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve();
    };
    const abort = () => finish(new DeadlineError("TIMEOUT"));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => finish(), ms);
  }));
}

async function drain(scope, graceMs) {
  if (!scope.pending.size) return true;
  let timer;
  let notify;
  try {
    return await Promise.race([
      new Promise(resolve => {
        notify = () => resolve(true);
        scope.waiters.add(notify);
      }),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), graceMs); }),
    ]);
  } finally {
    clearTimeout(timer);
    scope.waiters.delete(notify);
  }
}

async function run(factory, timeoutMs, { drainGraceMs = 1000, clock = () => performance.now() } = {}) {
  if (!(timeoutMs > 0) || !Number.isFinite(timeoutMs) || !(drainGraceMs >= 0)
    || !Number.isFinite(drainGraceMs)) throw new RangeError("INVALID_DEADLINE");
  const controller = new AbortController();
  // Existing bounded worker pools (e.g. 16 IRM reads) share this one signal.
  setMaxListeners(0, controller.signal);
  const deadline = clock() + timeoutMs;
  let timer;
  let expired;
  const expiry = new Promise(resolve => { expired = resolve; });
  const scope = { clock, deadline, closed: false, expired: false, pending: new Set(), waiters: new Set() };
  const close = () => {
    scope.closed = true;
    clearTimeout(timer);
    controller.abort();
  };
  scope.expire = () => {
    if (scope.closed) return;
    scope.expired = true;
    close();
    expired();
  };
  scope.view = Object.freeze({ deadline, signal: controller.signal, remainingMs: () => Math.max(0, deadline - clock()) });
  const arm = () => {
    const remaining = deadline - clock();
    if (remaining <= 0) scope.expire();
    else timer = setTimeout(arm, remaining);
  };
  return storage.run(scope, async () => {
    arm();
    const producer = observe(scope, Promise.resolve().then(() => { check(); return factory(); }));
    const outcome = producer.then(
      value => {
        try { check(); return { ok: true, value }; }
        catch (error) { return { ok: false, error }; }
        finally { close(); }
      },
      error => {
        try { check(); } catch (terminal) { if (scope.expired) error = terminal; }
        close();
        return { ok: false, error };
      },
    );
    try {
      await Promise.race([outcome, expiry]);
      close();
      if (!await drain(scope, drainGraceMs)) throw new DeadlineError("DRAIN_UNCONFIRMED");
      const result = await outcome;
      if (scope.expired) throw new DeadlineError("TIMEOUT");
      if (!result.ok) throw result.error;
      return result.value;
    } finally { clearTimeout(timer); }
  });
}

module.exports = { DeadlineError, run, current, check, invoke, sleep, join };
