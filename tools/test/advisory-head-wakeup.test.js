"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), { EventEmitter } = require("node:events");
const { createAdvisoryHeadWakeup } = require("../lib/advisory-head-wakeup.js");
const hash = n => "0x" + BigInt(n).toString(16).padStart(64, "0");
const head = (number = 100, blockHash = hash(number)) => ({ number: "0x" + number.toString(16), hash: blockHash, parentHash: hash(number - 1), timestamp: "0x1000" });
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
function fakeClock() {
  let time = 0, id = 0; const timers = new Map();
  return { timers, monotonic: () => time, now: () => 1800000000000 + time, random: () => 0.5,
    setTimeout: (fn, ms) => { const key = ++id; timers.set(key, { fn, at: time + ms }); return key; },
    clearTimeout: key => timers.delete(key),
    advance: async ms => {
      const end = time + ms;
      while (true) {
        const next = [...timers.entries()].filter(([, row]) => row.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break; time = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
      }
      time = end; await flush();
    }
  };
}
class Socket extends EventEmitter {
  constructor(mode = "ok") { super(); this.readyState = 1; this.mode = mode; this.requests = []; }
  send(text, callback) {
    const row = JSON.parse(text); this.requests.push(row);
    assert.ok(["eth_chainId", "eth_subscribe"].includes(row.method));
    if (this.mode === "timeout" || this.mode === "keepalive-timeout" && this.requests.length > 2) return;
    queueMicrotask(() => {
      if (this.readyState !== 1) return;
      const result = row.method === "eth_chainId" ? this.mode === "wrong-chain" ? "0x2" : "0x1" : this.mode === "bad-ack" ? "SECRET_ACK" : "0x1234";
      this.message({ jsonrpc: "2.0", id: this.mode === "wrong-id" ? row.id + 100 : row.id, result });
    }); callback?.();
  }
  message(body) { this.emit("message", Buffer.from(JSON.stringify(body)), false); }
  head(value = head(), subscription = "0x1234") { this.message({ jsonrpc: "2.0", method: "eth_subscription", params: { subscription, result: value } }); }
  terminate() { if (this.readyState === 3) return; this.readyState = 3; queueMicrotask(() => this.emit("close")); }
}
function fixture({ mode = "ok", onWake, onTiming, connect, now, monotonic } = {}) {
  const clock = fakeClock(), sockets = [], wakes = [], timings = []; let connections = 0;
  const notifier = createAdvisoryHeadWakeup({ connect: async () => {
    connections++; if (connect) return connect(); const socket = new Socket(mode); sockets.push(socket); return socket;
  }, now: now || clock.now, monotonic: monotonic || clock.monotonic, _test: clock,
  onWake: onWake || ((...args) => { assert.equal(args.length, 0); wakes.push(clock.monotonic()); }),
  onTiming: onTiming || (row => timings.push(row)) });
  return { notifier, clock, sockets, wakes, timings, get connections() { return connections; } };
}
async function close(f) { await f.notifier.close(); await flush(); assert.equal(f.clock.timers.size, 0); assert.ok(f.sockets.every(socket => socket.readyState === 3)); }

test("import and construction are inert; start is nonblocking/idempotent and close is terminal", async () => {
  const f = fixture(); assert.equal(f.connections, 0); assert.equal(f.clock.timers.size, 0);
  assert.equal(f.notifier.start(), undefined); f.notifier.start(); f.notifier.start(); await flush();
  assert.equal(f.connections, 1); assert.equal(f.sockets.length, 1); assert.equal(f.wakes.length, 0);
  await close(f); f.notifier.start(); await flush(); assert.equal(f.connections, 1); assert.equal(f.clock.timers.size, 0);
  const filename = require.resolve("../lib/advisory-head-wakeup.js"), original = require.cache[filename];
  delete require.cache[filename]; assert.equal(typeof require(filename).createAdvisoryHeadWakeup, "function"); require.cache[filename] = original;
});

test("matched chain/subscription ack gates notifications and timing contains numeric clocks only", async () => {
  const f = fixture(); f.notifier.start(); await flush();
  f.sockets[0].head(head(), "0x999"); f.sockets[0].head({ ...head(), timestamp: "SECRET_BAD" });
  f.sockets[0].head({ ...head(), secretMetadata: "SECRET_ENDPOINT_DETAIL" }); await f.clock.advance(0);
  assert.deepEqual(f.wakes, [0]); assert.equal(f.timings.length, 1);
  assert.deepEqual(f.timings[0], { phase: "wsArrival", edge: "point", atMonoMs: 0, atWallMs: 1800000000000 });
  assert.doesNotMatch(JSON.stringify(f.timings), /SECRET_|hash|number|family|handle/);
  assert.deepEqual(f.sockets[0].requests.map(row => [row.method, row.params]), [["eth_chainId", []], ["eth_subscribe", ["newHeads"]]]);
  await close(f);
});

test("duplicates do not wake; reorg variants, gaps and out-of-order arrivals coalesce at minimum 300ms", async () => {
  const f = fixture(); f.notifier.start(); await flush(); const socket = f.sockets[0];
  socket.head(); await f.clock.advance(0); socket.head(); await f.clock.advance(400); assert.deepEqual(f.wakes, [0]);
  socket.head(head(100, hash(999))); socket.head(head(110)); socket.head(head(99)); await f.clock.advance(0);
  assert.deepEqual(f.wakes, [0, 400]); socket.head(head(111)); socket.head(head(112)); await f.clock.advance(299);
  assert.deepEqual(f.wakes, [0, 400]); await f.clock.advance(1); assert.deepEqual(f.wakes, [0, 400, 700]); await close(f);
});

test("asynchronous wake consumers never overlap and their failures are contained", async () => {
  let release, active = 0, peak = 0, calls = 0;
  const f = fixture({ onWake: (...args) => {
    assert.equal(args.length, 0); calls++; active++; peak = Math.max(peak, active);
    return new Promise((_, reject) => { release = () => { active--; reject(new Error("SECRET_CALLBACK_REJECTION")); }; });
  } });
  f.notifier.start(); await flush(); f.sockets[0].head(); await f.clock.advance(0);
  f.sockets[0].head(head(101)); await f.clock.advance(500); assert.equal(calls, 1);
  release(); await flush(); await f.clock.advance(0); assert.equal(calls, 2); assert.equal(peak, 1);
  await close(f); release(); await flush(); assert.equal(f.clock.timers.size, 0);
});

test("throwing/rejecting timing and wake callbacks never escape or disable subsequent advisory use", async () => {
  for (const rejected of [false, true]) {
    let calls = 0;
    const bad = () => { if (rejected) return Promise.reject(new Error("SECRET_CALLBACK")); throw new Error("SECRET_CALLBACK"); };
    const f = fixture({ onWake: () => { calls++; return bad(); }, onTiming: bad }); f.notifier.start(); await flush();
    f.sockets[0].head(); await f.clock.advance(0); f.sockets[0].head(head(101)); await f.clock.advance(300);
    assert.equal(calls, 2); assert.equal(f.connections, 1); await close(f);
  }
});

test("wall-clock instrumentation failures do not suppress wakeups", async () => {
  const f = fixture({ now: () => { throw new Error("SECRET_CLOCK"); } }); f.notifier.start(); await flush();
  f.sockets[0].head(); await f.clock.advance(0); assert.equal(f.wakes.length, 1); assert.equal(f.timings.length, 0); await close(f);
});

test("disconnect uses only three lifetime reconnects, never resetting after successful subscriptions", async () => {
  const f = fixture(); f.notifier.start(); await flush();
  for (const delay of [1000, 2000, 4000]) {
    f.sockets.at(-1).terminate(); await flush(); const before = f.connections;
    await f.clock.advance(delay - 1); assert.equal(f.connections, before); await f.clock.advance(1); assert.equal(f.connections, before + 1);
  }
  assert.equal(f.connections, 4); f.sockets.at(-1).terminate(); await flush(); await f.clock.advance(100000);
  assert.equal(f.connections, 4); assert.equal(f.clock.timers.size, 0); assert.equal(f.wakes.length, 3); await close(f);
});

test("connection rejection is contained and exhausts the same finite retry budget", async () => {
  const f = fixture({ connect: () => Promise.reject(new Error("SECRET_ENDPOINT_CONNECT")) }); f.notifier.start(); await flush();
  await f.clock.advance(7000); assert.equal(f.connections, 4); assert.equal(f.clock.timers.size, 0); await close(f);
});

for (const mode of ["wrong-chain", "bad-ack", "wrong-id", "timeout"]) test(`${mode} cannot admit head notifications and cleans up on close`, async () => {
  const f = fixture({ mode }); f.notifier.start(); await flush();
  f.sockets[0].head(); assert.equal(f.wakes.length, 0);
  if (["wrong-id", "timeout"].includes(mode)) await f.clock.advance(3000);
  await close(f); assert.equal(f.wakes.length, 0);
});

test("malformed and mismatched frames are ignored; payload/rate overflow terminates the connection", async () => {
  for (const mode of ["size", "rate"]) {
    const f = fixture(); f.notifier.start(); await flush(); const socket = f.sockets[0];
    socket.emit("message", Buffer.from("SECRET_MALFORMED"), false); socket.message({ jsonrpc: "2.0", id: 999, result: "SECRET" });
    assert.equal(f.wakes.length, 0);
    if (mode === "size") socket.emit("message", Buffer.alloc(128 * 1024 + 1), false);
    else for (let i = 0; i < 65; i++) socket.message({ jsonrpc: "2.0", id: 999, result: "SECRET" });
    await flush(); assert.equal(socket.readyState, 3); await close(f);
  }
});

test("dedup memory is bounded and accepted messages remain rate-bounded", async () => {
  const f = fixture(); f.notifier.start(); await flush();
  for (let wave = 0; wave < 3; wave++) {
    for (let i = 0; i < 50; i++) f.sockets[0].head(head(100 + wave * 50 + i));
    await f.clock.advance(1000);
  }
  const before = f.wakes.length; f.sockets[0].head(head(100)); await f.clock.advance(0);
  assert.equal(f.wakes.length, before + 1); assert.equal(f.connections, 1); await close(f);
});

test("keepalive is chainId-only every 20s; its 3s deadline triggers finite reconnect", async () => {
  const f = fixture({ mode: "keepalive-timeout" }); f.notifier.start(); await flush();
  await f.clock.advance(19999); assert.equal(f.sockets[0].requests.length, 2);
  await f.clock.advance(1); assert.equal(f.sockets[0].requests.length, 3); assert.equal(f.sockets[0].requests[2].method, "eth_chainId");
  await f.clock.advance(3000); assert.equal(f.sockets[0].readyState, 3); await close(f);
});

test("close during connect drains a late socket and suppresses every callback/retry", async () => {
  let resolve; const socket = new Socket();
  const f = fixture({ connect: () => new Promise(done => { resolve = done; }) }); f.notifier.start(); await flush();
  let done = false; const closing = f.notifier.close().then(() => { done = true; }); await flush(); assert.equal(done, false);
  resolve(socket); await flush(); await closing;
  assert.equal(socket.readyState, 3); assert.equal(socket.requests.length, 0); assert.equal(f.clock.timers.size, 0); assert.equal(f.wakes.length, 0);
});

test("an unresponsive connect is bounded; sockets delivered even after close timeout are discarded", async () => {
  let resolve; const f = fixture({ connect: () => new Promise(done => { resolve = done; }) }); f.notifier.start(); await flush();
  const closing = f.notifier.close(); await f.clock.advance(8500); await closing; assert.equal(f.clock.timers.size, 0);
  const socket = new Socket(); resolve(socket); await flush(); assert.equal(socket.readyState, 3); assert.equal(f.clock.timers.size, 0);
  assert.equal(f.connections, 1); assert.equal(f.timings.length, 0);
});

test("close cancels queued coalesced wake and does not wait forever on a consumer promise", async () => {
  let calls = 0; const f = fixture({ onWake: () => { calls++; return new Promise(() => {}); } });
  f.notifier.start(); await flush(); f.sockets[0].head(); await f.clock.advance(0);
  f.sockets[0].head(head(101)); await close(f); await f.clock.advance(100000); assert.equal(calls, 1);
});
