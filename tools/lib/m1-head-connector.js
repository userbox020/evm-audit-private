"use strict";

const { performance } = require("node:perf_hooks");
const { classifyProvider } = require("./rpc-provider-reliability.js");
const MAX_BYTES = 128 * 1024, REQUEST_MS = 3000, TOTAL_MS = 8000;
// Explicit public-service mappings only. None is used unless supplied by the
// caller's loader. No generic scheme conversion or external fallback discovery.
const PUBLIC_WS = new Map([
  ["https://ethereum.publicnode.com/", "wss://ethereum.publicnode.com/"],
  ["https://ethereum-rpc.publicnode.com/", "wss://ethereum-rpc.publicnode.com/"],
  ["https://eth.drpc.org/", "wss://eth.drpc.org/"]
]);
class HeadConnectorError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = code => { throw new HeadConnectorError(code); };
function normalizedHeader(raw) {
  const quantity = value => typeof value === "string" && /^0x(?:0|[1-9a-f][0-9a-f]{0,13})$/i.test(value);
  const hash = value => typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value);
  if (!raw || !quantity(raw.number) || !quantity(raw.timestamp) || !hash(raw.hash) || !hash(raw.parentHash)) fail("M1_HEAD_HEADER_INVALID");
  const number = Number(BigInt(raw.number)), timestamp = Number(BigInt(raw.timestamp));
  if (!Number.isSafeInteger(number) || !Number.isSafeInteger(timestamp)) fail("M1_HEAD_HEADER_INVALID");
  return { number, timestamp, hash: raw.hash.toLowerCase(), parentHash: raw.parentHash.toLowerCase() };
}
function eligible(candidates) {
  if (!Array.isArray(candidates)) fail("M1_HEAD_NO_ELIGIBLE_CANDIDATES");
  const pool = [], seen = new Set();
  // The production loader already bounds its input at 32. Bound inspection too.
  for (const candidate of candidates.slice(0, 32)) {
    try {
      const handle = candidate?.handle;
      if (typeof handle !== "string" || !/^https:\/\/[^/?#:@]+\/?$/i.test(handle)) continue;
      const url = new URL(handle), family = classifyProvider(url.href)?.family, wsHandle = PUBLIC_WS.get(url.href);
      if (!wsHandle || !["publicnode", "drpc"].includes(family) || url.username || url.password || url.port ||
        url.pathname !== "/" || url.search || url.hash || seen.has(url.href)) continue;
      seen.add(url.href); pool.push(Object.freeze({ handle: url.href, wsHandle }));
      if (pool.length === 6) break;
    } catch (_) { /* Never expose candidate values or parsing failures. */ }
  }
  return pool;
}

function createM1HeadConnector({ loadCandidates, loadHeadCandidates, WebSocketImpl, fetchImpl, _test = {} } = {}) {
  const legacy = typeof loadCandidates === "function", inventory = typeof loadHeadCandidates === "function";
  if (legacy === inventory || loadCandidates !== undefined && !legacy || loadHeadCandidates !== undefined && !inventory ||
      typeof WebSocketImpl !== "function" || typeof fetchImpl !== "function") fail("M1_HEAD_OPTIONS_INVALID");
  if (inventory) return createInventoryHeadConnector({ loadHeadCandidates, WebSocketImpl, fetchImpl, _test });
  const setTimer = _test.setTimeout || setTimeout, clearTimer = _test.clearTimeout || clearTimeout;
  const monotonic = _test.monotonic || (() => performance.now());
  return async function connect() {
    const controller = new AbortController(), sockets = [], work = new Set();
    let last, deadline, totalTimer, chosen = null;
    function clock() {
      const value = monotonic();
      if (!Number.isFinite(value) || (last !== undefined && value < last)) fail("M1_HEAD_CLOCK_INVALID");
      last = value; return value;
    }
    const alive = () => { if (controller.signal.aborted || clock() >= deadline) fail("M1_HEAD_CONNECT_TIMEOUT"); };
    // Abort-aware waits consume the common budget. Late results cannot launch
    // another request; a late fetch response has its body cancelled separately.
    function wait(promise, signal = controller.signal) {
      return new Promise((resolve, reject) => {
        const abort = () => { signal.removeEventListener("abort", abort); reject(new HeadConnectorError("M1_HEAD_CONNECT_TIMEOUT")); };
        if (signal.aborted) { abort(); Promise.resolve(promise).catch(() => {}); return; }
        signal.addEventListener("abort", abort, { once: true });
        Promise.resolve(promise).then(value => { signal.removeEventListener("abort", abort); resolve(value); },
          () => { signal.removeEventListener("abort", abort); reject(new HeadConnectorError("M1_HEAD_REQUEST_FAILED")); });
      });
    }
    async function http(candidate, method, params) {
      alive();
      if (!["eth_chainId", "eth_getBlockByNumber"].includes(method)) fail("M1_HEAD_REQUEST_FAILED");
      const ctl = new AbortController(); let reader;
      const abort = () => ctl.abort(); controller.signal.addEventListener("abort", abort, { once: true });
      const timer = setTimer(abort, Math.max(1, Math.min(REQUEST_MS, deadline - clock())));
      const task = (async () => {
        try {
          const fetching = Promise.resolve().then(() => {
            alive(); if (ctl.signal.aborted) fail("M1_HEAD_REQUEST_FAILED");
            return fetchImpl(candidate.handle, { method: "POST", redirect: "error", credentials: "omit", signal: ctl.signal,
              headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
          });
          fetching.then(response => { if (ctl.signal.aborted) { try { Promise.resolve(response.body?.cancel()).catch(() => {}); } catch (_) {} } }, () => {});
          const response = await wait(fetching, ctl.signal);
          if (!response?.ok || !response.body?.getReader) fail("M1_HEAD_REQUEST_FAILED");
          reader = response.body.getReader(); const buffer = Buffer.alloc(MAX_BYTES); let bytes = 0;
          while (true) {
            alive(); const chunk = await wait(reader.read(), ctl.signal); if (chunk.done) break;
            if (!(chunk.value instanceof Uint8Array) || bytes + chunk.value.byteLength > MAX_BYTES) fail("M1_HEAD_RESPONSE_INVALID");
            buffer.set(chunk.value, bytes); bytes += chunk.value.byteLength;
          }
          const body = JSON.parse(buffer.toString("utf8", 0, bytes));
          if (body?.jsonrpc !== "2.0" || body.id !== 1 || !Object.hasOwn(body, "result") || Object.hasOwn(body, "error")) fail("M1_HEAD_RESPONSE_INVALID");
          alive(); return body.result;
        } finally {
          clearTimer(timer); ctl.abort(); controller.signal.removeEventListener("abort", abort);
          if (reader) { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch (_) {} try { reader.releaseLock(); } catch (_) {} }
        }
      })();
      work.add(task); try { return await task; } finally { work.delete(task); }
    }
    function open(candidate) {
      alive(); let socket, ended = false, id = 0, messages = 0, openTimer;
      const pending = new Map(); let readyResolve, readyReject;
      const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; }); ready.catch(() => {});
      function stop() {
        if (ended) return; ended = true; clearTimer(openTimer); readyReject(new HeadConnectorError("M1_HEAD_REQUEST_FAILED"));
        for (const job of pending.values()) { clearTimer(job.timer); job.reject(new HeadConnectorError("M1_HEAD_REQUEST_FAILED")); } pending.clear();
      }
      const onOpen = () => { clearTimer(openTimer); readyResolve(); };
      const onError = () => stop(), onClose = () => stop();
      const onMessage = (raw, binary) => {
        if (ended) return;
        try {
          if (++messages > 64 || binary || !(typeof raw === "string" || raw instanceof Uint8Array) || Buffer.byteLength(raw) > MAX_BYTES) { stop(); return; }
          const body = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
          const job = body?.jsonrpc === "2.0" && pending.get(body.id);
          if (!job) return; pending.delete(body.id); clearTimer(job.timer);
          if (!Object.hasOwn(body, "result") || Object.hasOwn(body, "error")) job.reject(new HeadConnectorError("M1_HEAD_RESPONSE_INVALID"));
          else job.resolve(body.result);
        } catch (_) { stop(); }
      };
      socket = new WebSocketImpl(candidate.wsHandle, { maxPayload: MAX_BYTES, handshakeTimeout: REQUEST_MS,
        followRedirects: false, perMessageDeflate: false });
      const row = { socket, qualified: false, get ended() { return ended; }, stop,
        detach: () => {
          clearTimer(openTimer); controller.signal.removeEventListener("abort", stop);
          for (const [event, listener] of [["open", onOpen], ["error", onError], ["close", onClose], ["message", onMessage]]) socket.removeListener(event, listener);
        },
        request: async (method, params) => {
          await ready; alive(); if (ended || pending.size >= 8) fail("M1_HEAD_REQUEST_FAILED");
          return new Promise((resolve, reject) => {
            const requestId = ++id, timer = setTimer(() => stop(), Math.max(1, Math.min(REQUEST_MS, deadline - clock())));
            pending.set(requestId, { resolve, reject, timer });
            try { socket.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }), error => { if (error) stop(); }); } catch (_) { stop(); }
          });
        }
      };
      sockets.push(row);
      socket.on("open", onOpen); socket.on("error", onError); socket.on("close", onClose); socket.on("message", onMessage);
      controller.signal.addEventListener("abort", stop, { once: true });
      openTimer = setTimer(stop, Math.max(1, Math.min(REQUEST_MS, deadline - clock())));
      return row;
    }
    async function dispose(row) {
      row.stop(); const socket = row.socket;
      const ignore = () => {}; socket.on("error", ignore);
      let closeListener, timer, didClose = socket.readyState === 3;
      const closed = new Promise(resolve => { closeListener = () => { didClose = true; socket.removeListener("error", ignore); resolve(); }; socket.on("close", closeListener); });
      try { if (socket.terminate) socket.terminate(); else socket.close(); } catch (_) {}
      row.detach();
      let remaining = 0; try { remaining = Math.max(0, deadline - clock()); } catch (_) {}
      if (!didClose) await Promise.race([closed, new Promise(resolve => { timer = setTimer(resolve, Math.min(250, remaining)); })]);
      clearTimer(timer); socket.removeListener("close", closeListener);
      if (didClose) socket.removeListener("error", ignore);
      // If a nonconforming transport never closes, retain just its error sink;
      // all timers, requests and qualification listeners are still removed.
    }
    try {
      deadline = clock() + TOTAL_MS; totalTimer = setTimer(() => controller.abort(), TOTAL_MS);
      const pool = eligible(await wait(Promise.resolve().then(loadCandidates))); alive();
      if (!pool.length) fail("M1_HEAD_NO_ELIGIBLE_CANDIDATES");
      const results = new Array(pool.length); let next = 0;
      await Promise.allSettled(Array.from({ length: Math.min(2, pool.length) }, async () => {
        while (next < pool.length && !controller.signal.aborted) {
          const index = next++, candidate = pool[index]; let row;
          try {
            row = open(candidate); results[index] = row;
            const chains = await Promise.allSettled([http(candidate, "eth_chainId", []), row.request("eth_chainId", [])]);
            if (!chains.every(result => result.status === "fulfilled" && result.value === "0x1")) fail("M1_HEAD_WRONG_CHAIN");
            const pin = normalizedHeader(await http(candidate, "eth_getBlockByNumber", ["latest", false]));
            const params = ["0x" + pin.number.toString(16), false];
            const headers = await Promise.allSettled([http(candidate, "eth_getBlockByNumber", params), row.request("eth_getBlockByNumber", params)]);
            for (const result of headers) {
              if (result.status !== "fulfilled") fail("M1_HEAD_REQUEST_FAILED");
              const h = normalizedHeader(result.value);
              if (h.number !== pin.number || h.hash !== pin.hash || h.parentHash !== pin.parentHash || h.timestamp !== pin.timestamp) fail("M1_HEAD_HEADER_DISAGREEMENT");
            }
            alive(); if (row.ended) fail("M1_HEAD_REQUEST_FAILED"); row.qualified = true;
          } catch (_) { if (row) { row.stop(); try { row.socket.terminate ? row.socket.terminate() : row.socket.close(); } catch (_) {} } }
        }
      }));
      alive(); chosen = results.find(row => row?.qualified && !row.ended && (row.socket.readyState === undefined || row.socket.readyState === 1));
      if (!chosen) fail("M1_HEAD_NO_QUALIFIED_CANDIDATES");
      await Promise.allSettled(sockets.filter(row => row !== chosen).map(dispose));
      await Promise.allSettled([...work]); alive();
      if (chosen.ended || chosen.socket.readyState !== undefined && chosen.socket.readyState !== 1) fail("M1_HEAD_NO_QUALIFIED_CANDIDATES");
      chosen.detach(); clearTimer(totalTimer); return chosen.socket;
    } catch (error) {
      controller.abort(); await Promise.allSettled(sockets.map(dispose)); await Promise.allSettled([...work]);
      // Fixed outward codes only; never relay a constructor, HTTP or WS error.
      const code = error instanceof HeadConnectorError && ["M1_HEAD_NO_ELIGIBLE_CANDIDATES", "M1_HEAD_NO_QUALIFIED_CANDIDATES",
        "M1_HEAD_CONNECT_TIMEOUT", "M1_HEAD_CLOCK_INVALID"].includes(error.code) ? error.code : "M1_HEAD_CONNECT_FAILED";
      throw new HeadConnectorError(code);
    } finally { clearTimer(totalTimer); }
  };
}

// Opt-in inventory-record mode. These handles/Origins and provisional witness
// snapshots are private advisory inputs, not strict financial qualification.
// Preserve the loader's ordering; never derive HTTP from WSS or guess WS paths.
function headPools(records) {
  if (!Array.isArray(records)) fail("M1_HEAD_NO_ELIGIBLE_CANDIDATES");
  const ws = [], httpCandidates = [], seenWs = new Set();
  for (const record of records.slice(0, 32)) {
    try {
      if (!record || typeof record !== "object" || Array.isArray(record)) continue;
      const descriptors = Object.getOwnPropertyDescriptors(record);
      if (!["kind", "handle", "origin", "chainHint", "family"].every(key => descriptors[key] && Object.hasOwn(descriptors[key], "value"))) continue;
      const { kind, handle, origin, chainHint, family } = record;
      if (!["WSS", "HTTPS_WS", "HTTPS"].includes(kind) || typeof handle !== "string" || handle.length > 16384 ||
          /[^\x21-\x7e]|[\\#]/.test(handle) || !/^(?:https|wss):\/\//i.test(handle) ||
          !(chainHint === null || Number.isSafeInteger(chainHint)) ||
          !(family === null || typeof family === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/i.test(family))) continue;
      const url = new URL(handle);
      if (url.protocol !== (kind === "WSS" ? "wss:" : "https:") || !url.hostname || url.username || url.password ||
          handle.split("/")[2].includes("@")) continue;
      if (origin !== null) {
        if (typeof origin !== "string" || origin.length > 4096 || /[^\x21-\x7e]|[\\#]/.test(origin) || !/^https?:\/\//i.test(origin)) continue;
        const parsed = new URL(origin);
        if (parsed.username || parsed.password || origin.split("/")[2].includes("@") || parsed.pathname !== "/" || parsed.search) continue;
      }
      const mapped = kind === "HTTPS" ? eligible([{ handle }])[0]?.wsHandle : null;
      const wsHandle = kind === "WSS" ? handle : kind === "HTTPS_WS" ? handle.replace(/^https:/i, "wss:") : mapped;
      const candidate = Object.freeze({ handle, origin });
      if (kind !== "WSS") httpCandidates.push({ candidate, chainRank: chainHint === 1 ? 0 : chainHint === null ? 1 : 2,
        companionRank: kind === "HTTPS_WS" || mapped ? 0 : 1, order: httpCandidates.length });
      if (wsHandle && ws.length < 6) {
        const key = new URL(wsHandle).href;
        if (!seenWs.has(key)) { seenWs.add(key); ws.push(Object.freeze({ handle: wsHandle, origin })); }
      }
    } catch (_) { /* Invalid records/Origins never broaden endpoint scope. */ }
  }
  const http = [], seenHttp = new Set();
  // Companion preference must not evict a higher-priority chain witness.
  // Within equal chain/companion priority retain the upstream inventory order.
  httpCandidates.sort((a, b) => a.chainRank - b.chainRank || a.companionRank - b.companionRank || a.order - b.order);
  for (const { candidate } of httpCandidates) {
    const key = new URL(candidate.handle).href;
    if (seenHttp.has(key)) continue;
    seenHttp.add(key); http.push(candidate); if (http.length === 2) break;
  }
  return { ws, http };
}

function createInventoryHeadConnector({ loadHeadCandidates, WebSocketImpl, fetchImpl, _test }) {
  const setTimer = _test.setTimeout || setTimeout, clearTimer = _test.clearTimeout || clearTimeout;
  const monotonic = _test.monotonic || (() => performance.now());
  const ignore = () => {};
  return async function connect({ signal } = {}) {
    const root = new AbortController(), branches = new Set(), sockets = [], inFlight = new Set();
    let previous, deadline, totalTimer, chosen = null;
    const abort = () => root.abort();
    function clock() {
      const value = monotonic();
      if (!Number.isFinite(value) || previous !== undefined && value < previous) fail("M1_HEAD_CLOCK_INVALID");
      previous = value; return value;
    }
    function alive(local) {
      if (root.signal.aborted || local?.aborted || clock() >= deadline) fail("M1_HEAD_CONNECT_TIMEOUT");
    }
    function branch() {
      alive(); const ctl = new AbortController(), stop = () => ctl.abort();
      root.signal.addEventListener("abort", stop, { once: true }); branches.add(ctl);
      return { ctl, release() { root.signal.removeEventListener("abort", stop); branches.delete(ctl); } };
    }
    function wait(promise, local = root.signal) {
      return new Promise((resolve, reject) => {
        const stop = () => { local.removeEventListener("abort", stop); reject(new HeadConnectorError("M1_HEAD_REQUEST_FAILED")); };
        if (local.aborted) { Promise.resolve(promise).catch(ignore); stop(); return; }
        local.addEventListener("abort", stop, { once: true });
        Promise.resolve(promise).then(value => { local.removeEventListener("abort", stop); resolve(value); },
          () => { local.removeEventListener("abort", stop); reject(new HeadConnectorError("M1_HEAD_REQUEST_FAILED")); });
      });
    }
    function track(promise) {
      const task = Promise.resolve(promise); inFlight.add(task);
      task.then(() => inFlight.delete(task), () => inFlight.delete(task)); return task;
    }
    async function drain() {
      // Do not reuse a worker's physical slot while an abort-ignoring transport
      // is still settling. The root deadline still bounds the drain itself.
      while (inFlight.size) { alive(); await wait(Promise.allSettled([...inFlight])); }
    }
    function methodAllowed(method) {
      if (method !== "eth_chainId" && method !== "eth_getBlockByNumber") fail("M1_HEAD_REQUEST_FAILED");
    }
    async function http(candidate, method, params, local) {
      alive(local); methodAllowed(method);
      const ctl = new AbortController(), stop = () => ctl.abort(); let reader, response;
      const until = Math.min(deadline, clock() + REQUEST_MS);
      const check = () => { alive(local); if (ctl.signal.aborted || clock() >= until) fail("M1_HEAD_REQUEST_FAILED"); };
      local.addEventListener("abort", stop, { once: true });
      const timer = setTimer(stop, Math.max(1, until - clock()));
      try {
        const fetching = track(Promise.resolve().then(() => {
          check();
          return fetchImpl(candidate.handle, { method: "POST", redirect: "error", credentials: "omit", signal: ctl.signal,
            headers: { "content-type": "application/json", ...(candidate.origin === null ? {} : { origin: candidate.origin }) },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
        }));
        // A nonconforming fetch can fulfill after abort. It can never dispatch
        // follow-up work; cancel its late body and consume rejection privately.
        fetching.then(value => { if (ctl.signal.aborted) try { track(value?.body?.cancel()).catch(ignore); } catch (_) {} }, ignore);
        response = await wait(fetching, ctl.signal);
        check();
        if (!response?.ok || typeof response.body?.getReader !== "function") fail("M1_HEAD_REQUEST_FAILED");
        reader = response.body.getReader(); const buffer = Buffer.alloc(MAX_BYTES); let bytes = 0;
        while (true) {
          check(); const part = await wait(track(Promise.resolve().then(() => {
            check(); return reader.read();
          })), ctl.signal);
          if (part.done) break;
          if (!(part.value instanceof Uint8Array) || bytes + part.value.byteLength > MAX_BYTES) fail("M1_HEAD_RESPONSE_INVALID");
          buffer.set(part.value, bytes); bytes += part.value.byteLength;
        }
        const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes)));
        if (!body || Array.isArray(body) || body.jsonrpc !== "2.0" || body.id !== 1 || !Object.hasOwn(body, "result") ||
            Object.hasOwn(body, "error") || Object.hasOwn(body, "method")) fail("M1_HEAD_RESPONSE_INVALID");
        check(); return body.result;
      } finally {
        clearTimer(timer); ctl.abort(); local.removeEventListener("abort", stop);
        try { track(reader ? reader.cancel() : response?.body?.cancel()).catch(ignore); } catch (_) {}
        try { reader?.releaseLock(); } catch (_) {}
      }
    }
    function open(candidate, local) {
      alive(local);
      const openUntil = Math.min(deadline, clock() + REQUEST_MS);
      let socket, ended = false, opened = false, nextId = 0, messages = 0, pending, timer, resolveReady, rejectReady;
      const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; }); ready.catch(ignore);
      function stop() {
        if (ended) return; ended = true; clearTimer(timer); rejectReady(new HeadConnectorError("M1_HEAD_REQUEST_FAILED"));
        if (pending) { const item = pending; pending = null; clearTimer(item.timer); item.reject(new HeadConnectorError("M1_HEAD_REQUEST_FAILED")); }
      }
      const onOpen = () => {
        try { alive(local); if (clock() >= openUntil) fail("M1_HEAD_REQUEST_FAILED"); if (!ended) { opened = true; clearTimer(timer); resolveReady(); } }
        catch (_) { stop(); }
      };
      const onMessage = (raw, binary) => {
        if (ended) return;
        try {
          alive(local);
          if (++messages > 64 || binary || !(typeof raw === "string" || raw instanceof Uint8Array) || Buffer.byteLength(raw) > MAX_BYTES) fail("M1_HEAD_RESPONSE_INVALID");
          const body = JSON.parse(typeof raw === "string" ? raw : new TextDecoder("utf-8", { fatal: true }).decode(raw));
          if (!body || Array.isArray(body) || body.jsonrpc !== "2.0" || !Number.isSafeInteger(body.id) ||
              !pending || clock() >= pending.deadline || body.id !== pending.id || !Object.hasOwn(body, "result") || Object.hasOwn(body, "error") || Object.hasOwn(body, "method")) fail("M1_HEAD_RESPONSE_INVALID");
          const item = pending; pending = null; clearTimer(item.timer); item.resolve(body.result);
        } catch (_) { stop(); }
      };
      // Register the returned socket before any post-constructor clock/abort
      // check: even a constructor that returns after expiry must be disposed.
      socket = new WebSocketImpl(candidate.handle, { maxPayload: MAX_BYTES, handshakeTimeout: REQUEST_MS,
        followRedirects: false, perMessageDeflate: false, rejectUnauthorized: true, ...(candidate.origin === null ? {} : { origin: candidate.origin }) });
      const row = { socket, stop, disposal: null, get ended() { return ended; },
        detach() {
          clearTimer(timer); local.removeEventListener("abort", stop);
          for (const [event, listener] of [["open", onOpen], ["message", onMessage], ["error", stop], ["close", stop]]) {
            try { socket.removeListener(event, listener); } catch (_) {}
          }
        },
        async request(method, params) {
          methodAllowed(method); await ready; alive(local);
          if (ended || !opened || socket.readyState !== 1 || pending) fail("M1_HEAD_REQUEST_FAILED");
          return new Promise((resolve, reject) => {
            const item = { id: ++nextId, resolve, reject, timer: null, deadline: Math.min(deadline, clock() + REQUEST_MS) }; pending = item;
            try {
              const body = JSON.stringify({ jsonrpc: "2.0", id: item.id, method, params });
              item.timer = setTimer(stop, Math.max(1, item.deadline - clock()));
              // Final physical-dispatch guard: serialization/timer setup may
              // have consumed the budget or synchronously ended the socket.
              alive(local);
              if (ended || !opened || socket.readyState !== 1 || pending !== item || clock() >= item.deadline) fail("M1_HEAD_REQUEST_FAILED");
              socket.send(body, failure => { if (failure) stop(); });
            } catch (_) {
              // stop() may already have run during timer setup, before its
              // returned timer was assigned. Always settle/clear this item too.
              clearTimer(item.timer); if (pending === item) pending = null;
              stop(); reject(new HeadConnectorError("M1_HEAD_REQUEST_FAILED"));
            }
          });
        } };
      sockets.push(row);
      // Inert sink survives termination/handoff, consuming late transport errors
      // without retaining qualification state. Stateful listeners are detached.
      try {
        socket.on("error", ignore);
        socket.on("open", onOpen); socket.on("message", onMessage); socket.on("error", stop); socket.on("close", stop);
        local.addEventListener("abort", stop, { once: true });
        alive(local); timer = setTimer(stop, Math.max(1, openUntil - clock()));
        if (clock() >= openUntil) stop(); else if (socket.readyState === 1) onOpen(); else if (socket.readyState === 3) stop();
      } catch (_) { stop(); }
      return row;
    }
    function dispose(row) {
      if (row.disposal) return row.disposal;
      row.disposal = (async () => {
        row.stop(); row.detach(); const socket = row.socket;
        let finish, timer, closed = socket.readyState === 3;
        const onClose = () => { closed = true; finish(); };
        const done = new Promise(resolve => { finish = resolve; });
        socket.on("close", onClose);
        try { if (typeof socket.terminate === "function") socket.terminate(); else socket.close(); } catch (_) {}
        let remaining = 0; try { remaining = Math.max(0, deadline - clock()); } catch (_) {}
        if (!closed && remaining > 0 && !root.signal.aborted) {
          timer = setTimer(finish, Math.min(250, remaining));
          root.signal.addEventListener("abort", finish, { once: true }); await done;
          root.signal.removeEventListener("abort", finish);
        }
        clearTimer(timer); socket.removeListener("close", onClose);
      })();
      return row.disposal;
    }
    try {
      deadline = clock() + TOTAL_MS; totalTimer = setTimer(abort, TOTAL_MS);
      if (signal) { signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort(); }
      alive();
      const records = await wait(Promise.resolve().then(() => { alive(); return loadHeadCandidates(); }));
      alive(); const pool = headPools(records); alive();
      if (!pool.ws.length || !pool.http.length) fail("M1_HEAD_NO_ELIGIBLE_CANDIDATES");
      // First SUCCESSFUL Ethereum witness, not first response or inventory row.
      const witnesses = pool.http.map(candidate => {
        const scope = branch();
        const task = (async () => {
          try {
            if (await http(candidate, "eth_chainId", [], scope.ctl.signal) !== "0x1") fail("M1_HEAD_WRONG_CHAIN");
            const pin = normalizedHeader(await http(candidate, "eth_getBlockByNumber", ["latest", false], scope.ctl.signal));
            alive(scope.ctl.signal); return { candidate, pin };
          } finally { scope.release(); }
        })();
        return { ...scope, task };
      });
      let witness;
      try { witness = await Promise.any(witnesses.map(item => item.task)); }
      catch (_) { alive(); fail("M1_HEAD_NO_QUALIFIED_CANDIDATES"); }
      finally { for (const item of witnesses) item.ctl.abort(); await Promise.allSettled(witnesses.map(item => item.task)); }
      await drain(); alive(); let next = 0;
      await Promise.allSettled(Array.from({ length: Math.min(2, pool.ws.length) }, async () => {
        while (!chosen && !root.signal.aborted && next < pool.ws.length) {
          alive(); const candidate = pool.ws[next++], scope = branch(); let row;
          try {
            row = open(candidate, scope.ctl.signal);
            if (await row.request("eth_chainId", []) !== "0x1") fail("M1_HEAD_WRONG_CHAIN");
            const params = ["0x" + witness.pin.number.toString(16), false];
            const tasks = [http(witness.candidate, "eth_getBlockByNumber", params, scope.ctl.signal), row.request("eth_getBlockByNumber", params)];
            let headers;
            try { headers = await Promise.all(tasks); }
            catch (_) { scope.ctl.abort(); await Promise.allSettled(tasks); fail("M1_HEAD_REQUEST_FAILED"); }
            for (const raw of headers) {
              const h = normalizedHeader(raw), p = witness.pin;
              if (h.number !== p.number || h.hash !== p.hash || h.parentHash !== p.parentHash || h.timestamp !== p.timestamp) fail("M1_HEAD_HEADER_DISAGREEMENT");
            }
            alive(scope.ctl.signal);
            if (row.ended || row.socket.readyState !== 1 || chosen) fail("M1_HEAD_REQUEST_FAILED");
            chosen = row;
            for (const ctl of branches) if (ctl !== scope.ctl) ctl.abort();
          } catch (_) { scope.ctl.abort(); }
          finally {
            try { if (row !== chosen && row) await dispose(row); await drain(); }
            finally { scope.release(); }
          }
        }
      }));
      alive(); if (!chosen) fail("M1_HEAD_NO_QUALIFIED_CANDIDATES");
      await Promise.allSettled(sockets.filter(row => row !== chosen).map(dispose)); alive();
      if (chosen.ended || chosen.socket.readyState !== 1) fail("M1_HEAD_NO_QUALIFIED_CANDIDATES");
      chosen.detach(); return chosen.socket;
    } catch (error) {
      root.abort(); await Promise.allSettled(sockets.map(dispose));
      const code = root.signal.aborted && (() => { try { return clock() >= deadline || signal?.aborted; } catch (_) { return false; } })()
        ? "M1_HEAD_CONNECT_TIMEOUT" : error instanceof HeadConnectorError && ["M1_HEAD_NO_ELIGIBLE_CANDIDATES", "M1_HEAD_NO_QUALIFIED_CANDIDATES",
          "M1_HEAD_CONNECT_TIMEOUT", "M1_HEAD_CLOCK_INVALID"].includes(error.code) ? error.code : "M1_HEAD_CONNECT_FAILED";
      throw new HeadConnectorError(code);
    } finally { clearTimer(totalTimer); signal?.removeEventListener("abort", abort); }
  };
}

module.exports = { createM1HeadConnector };
