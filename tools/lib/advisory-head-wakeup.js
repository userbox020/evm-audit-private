"use strict";

const { performance } = require("node:perf_hooks");
const MAX_BYTES = 128 * 1024, REQUEST_MS = 3000, CONNECT_MS = 8500;
const MIN_WAKE_MS = 300, KEEPALIVE_MS = 20000, MAX_RECONNECTS = 3;
class AdvisoryHeadError extends Error { constructor(code) { super(code); this.code = code; } }
const failure = () => new AdvisoryHeadError("ADVISORY_HEAD_UNAVAILABLE");
function headKey(value) {
  const quantity = x => typeof x === "string" && /^0x(?:0|[1-9a-f][0-9a-f]{0,13})$/i.test(x);
  const hash = x => typeof x === "string" && /^0x[0-9a-f]{64}$/i.test(x);
  if (!value || !quantity(value.number) || !quantity(value.timestamp) || !hash(value.hash) || !hash(value.parentHash)) return null;
  const number = Number(BigInt(value.number)), timestamp = Number(BigInt(value.timestamp));
  return Number.isSafeInteger(number) && Number.isSafeInteger(timestamp) ? number + ":" + value.hash.toLowerCase() : null;
}
function createAdvisoryHeadWakeup({ connect, now = Date.now, monotonic = () => performance.now(), onWake, onTiming, _test = {} } = {}) {
  if (typeof connect !== "function" || typeof now !== "function" || typeof monotonic !== "function" || typeof onWake !== "function" ||
    onTiming !== undefined && typeof onTiming !== "function") throw new AdvisoryHeadError("ADVISORY_HEAD_OPTIONS_INVALID");
  const setTimer = _test.setTimeout || setTimeout, clearTimer = _test.clearTimeout || clearTimeout, random = _test.random || Math.random;
  let started = false, closed = false, retries = 0, active = null, task = Promise.resolve(), closing;
  let reconnectTimer, wakeTimer, lastMono, lastWake = -Infinity, wakePending = false, wakeBusy = false;
  const seen = new Set(); // Insertion-ordered, bounded dedup; alternate hashes survive.
  function clock() {
    const value = monotonic();
    if (!Number.isFinite(value) || (lastMono !== undefined && value < lastMono)) throw failure();
    lastMono = value; return value;
  }
  function timing(atMonoMs) {
    if (closed || !onTiming) return;
    try {
      const atWallMs = now(); if (!Number.isFinite(atWallMs)) return;
      Promise.resolve(onTiming({ phase: "wsArrival", edge: "point", atMonoMs, atWallMs })).catch(() => {});
    } catch (_) { /* Instrumentation must never affect the HTTP fallback. */ }
  }
  function scheduleWake() {
    if (closed || !wakePending || wakeBusy || wakeTimer !== undefined) return;
    let delay; try { delay = Math.max(0, MIN_WAKE_MS - (clock() - lastWake)); } catch (_) { wakePending = false; return; }
    wakeTimer = setTimer(() => {
      wakeTimer = undefined;
      if (closed || !wakePending || wakeBusy) return;
      try { lastWake = clock(); } catch (_) { wakePending = false; return; }
      wakePending = false; wakeBusy = true;
      const finished = () => { wakeBusy = false; scheduleWake(); };
      // Exactly zero arguments. Observe completion to prevent concurrent consumers,
      // but never await user callbacks in the socket/request/close lifecycle.
      try { Promise.resolve(onWake()).then(finished, finished); } catch (_) { finished(); }
    }, delay);
  }
  function wake() { if (!closed) { wakePending = true; scheduleWake(); } }
  async function disposeSocket(socket) {
    if (!socket || typeof socket.on !== "function") return;
    const ignore = () => {}; socket.on("error", ignore);
    let didClose = socket.readyState === 3, listener, timer;
    const done = new Promise(resolve => { listener = () => { didClose = true; socket.removeListener?.("error", ignore); resolve(); }; socket.on("close", listener); });
    try { if (typeof socket.terminate === "function") socket.terminate(); else socket.close?.(); } catch (_) {}
    if (!didClose) await Promise.race([done, new Promise(resolve => { timer = setTimer(resolve, 250); })]);
    clearTimer(timer); socket.removeListener?.("close", listener);
    if (didClose) socket.removeListener?.("error", ignore);
  }
  function boundedConnect() {
    let expired = false, timer;
    const connection = Promise.resolve().then(() => closed ? null : connect());
    const guarded = connection.then(async socket => {
      if (expired || closed) { await disposeSocket(socket); return null; }
      return socket;
    }, () => { throw failure(); });
    const timeout = new Promise((_, reject) => { timer = setTimer(() => { expired = true; reject(failure()); }, CONNECT_MS); });
    return Promise.race([guarded, timeout]).finally(() => clearTimer(timer));
  }
  function attach(socket) {
    if (!socket || typeof socket.on !== "function" || typeof socket.removeListener !== "function" || typeof socket.send !== "function" ||
      typeof socket.terminate !== "function" && typeof socket.close !== "function" || socket.readyState !== undefined && socket.readyState !== 1) throw failure();
    let ended = false, nextId = 0, subscription = null, keepaliveTimer, rateStart = clock(), messages = 0;
    const pending = new Map(); let finish;
    const done = new Promise(resolve => { finish = resolve; });
    const stop = () => {
      if (ended) return; ended = true; clearTimer(keepaliveTimer);
      for (const job of pending.values()) { clearTimer(job.timer); job.reject(failure()); } pending.clear(); finish();
    };
    const onError = () => stop(), onClose = () => stop();
    const onMessage = (raw, binary) => {
      if (ended || closed) return;
      try {
        const at = clock();
        if (at - rateStart >= 1000) { rateStart = at; messages = 0; }
        if (++messages > 64 || !(typeof raw === "string" || raw instanceof Uint8Array) || Buffer.byteLength(raw) > MAX_BYTES) { stop(); return; }
        if (binary) return;
        let body; try { body = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8")); } catch (_) { return; }
        if (!body || body.jsonrpc !== "2.0") return;
        if (Object.hasOwn(body, "id")) {
          const job = pending.get(body.id); if (!job) return;
          pending.delete(body.id); clearTimer(job.timer);
          if (!Object.hasOwn(body, "result") || Object.hasOwn(body, "error")) { job.reject(failure()); stop(); return; }
          if (job.method === "eth_subscribe") {
            if (typeof body.result !== "string" || !/^0x[0-9a-f]{1,128}$/i.test(body.result)) { job.reject(failure()); stop(); return; }
            subscription = body.result;
          }
          job.resolve(body.result); return;
        }
        if (body.method !== "eth_subscription" || !subscription || body.params?.subscription !== subscription) return;
        const key = headKey(body.params.result); if (!key) return;
        timing(at); // Only numeric arrival timing, never header/provider metadata.
        if (closed) return;
        if (seen.has(key)) return;
        seen.add(key); if (seen.size > 128) seen.delete(seen.values().next().value);
        // Reorg variants, gaps and out-of-order arrivals are merely reconcile hints.
        wake();
      } catch (_) { stop(); }
    };
    socket.on("message", onMessage); socket.on("error", onError); socket.on("close", onClose);
    function request(method, params) {
      if (closed || ended || pending.size >= 8 || !(method === "eth_chainId" && params.length === 0 ||
        method === "eth_subscribe" && params.length === 1 && params[0] === "newHeads")) return Promise.reject(failure());
      return new Promise((resolve, reject) => {
        const id = ++nextId, timer = setTimer(stop, REQUEST_MS); pending.set(id, { resolve, reject, timer, method });
        try { socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }), error => { if (error) stop(); }); } catch (_) { stop(); }
      });
    }
    function keepalive() {
      if (closed || ended) return;
      keepaliveTimer = setTimer(() => {
        keepaliveTimer = undefined;
        request("eth_chainId", []).then(chain => { if (chain !== "0x1") stop(); else keepalive(); }, stop);
      }, KEEPALIVE_MS);
    }
    return { stop, done, request, keepalive, get ended() { return ended; },
      detach: () => { socket.removeListener("message", onMessage); socket.removeListener("error", onError); socket.removeListener("close", onClose); } };
  }
  function retry() {
    if (closed || retries >= MAX_RECONNECTS) return;
    let jitter = 0.5; try { const value = random(); if (Number.isFinite(value)) jitter = Math.max(0, Math.min(1, value)); } catch (_) {}
    const delay = Math.min(10000, 1000 * 2 ** retries * (0.75 + jitter * 0.5)); retries++;
    reconnectTimer = setTimer(() => { reconnectTimer = undefined; if (!closed) task = attempt().catch(() => {}); }, delay);
  }
  async function attempt() {
    let socket, connection;
    try {
      socket = await boundedConnect(); if (closed || !socket) return;
      connection = attach(socket); active = connection;
      if (await connection.request("eth_chainId", []) !== "0x1") throw failure();
      await connection.request("eth_subscribe", ["newHeads"]);
      if (closed || connection.ended) return;
      connection.keepalive(); if (retries > 0) wake();
      await connection.done;
    } catch (_) { /* Advisory failure: retain HTTP fallback, never throw outward. */ }
    finally {
      connection?.stop(); await disposeSocket(socket); connection?.detach();
      if (active === connection) active = null;
      retry();
    }
  }
  function start() { if (!started && !closed) { started = true; task = attempt().catch(() => {}); } }
  function close() {
    if (!closing) {
      closed = true; wakePending = false; clearTimer(wakeTimer); wakeTimer = undefined;
      clearTimer(reconnectTimer); reconnectTimer = undefined; active?.stop(); seen.clear();
      closing = task.then(() => {}, () => {});
    }
    return closing;
  }
  return Object.freeze({ start, close });
}

module.exports = { createAdvisoryHeadWakeup };
