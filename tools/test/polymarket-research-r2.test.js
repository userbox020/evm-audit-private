"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

const {
  CaptureAccumulator,
  HEARTBEAT_MS,
  MarketCaptureSession,
  analyzeCapture,
  buildSubscription,
  demoFixture,
  normalizeEvent,
  replayFixture,
  selectMarketMapping,
} = require("../polymarket-research-r2");

function nestedMarket(id, yes = `${id}-yes`, no = `${id}-no`, overrides = {}) {
  return {
    id,
    conditionId: `${id}-condition`,
    question: `Question ${id}`,
    active: true,
    closed: false,
    acceptingOrders: true,
    outcomes: ["Yes", "No"],
    tokenIds: [yes, no],
    prices: [0.5, 0.5],
    tickSize: 0.01,
    minOrderSize: 5,
    rewards: { minSize: 20, maxSpread: 0.03 },
    ...overrides,
  };
}

function mapping() {
  return selectMarketMapping({ events: [{ id: "event", markets: [nestedMarket("market")] }] }, { marketIds: "market", tokenCap: 2 });
}

class MockWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.sent = [];
    this.closed = false;
    MockWebSocket.instances.push(this);
  }

  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(listener);
  }

  emit(name, value = {}) {
    for (const listener of this.listeners.get(name) || []) listener(value);
  }

  send(value) {
    this.sent.push(value);
  }

  close() {
    this.closed = true;
  }
}

function fakeClock(start = 1_700_000_000_000) {
  const timers = [];
  const intervals = [];
  return {
    timers,
    intervals,
    now: () => start,
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => { if (timer) timer.cleared = true; },
    setInterval: (fn, ms) => {
      const interval = { fn, ms, cleared: false };
      intervals.push(interval);
      return interval;
    },
    clearInterval: (interval) => { if (interval) interval.cleared = true; },
  };
}

test("subscription has the exact bounded public market channel shape", () => {
  assert.deepEqual(buildSubscription(["yes", "no"]), {
    assets_ids: ["yes", "no"],
    type: "market",
    initial_dump: true,
    level: 2,
    custom_feature_enabled: true,
  });
});

test("snapshot selection requires active correlated binary markets and enforces token caps", () => {
  const snapshot = { events: [{ id: "event", markets: [nestedMarket("one"), nestedMarket("closed", "c-y", "c-n", { closed: true })] }] };
  const selected = selectMarketMapping(snapshot, { marketIds: "one", tokenCap: 2 });
  assert.deepEqual(selected.tokenIds, ["one-yes", "one-no"]);
  assert.throws(() => selectMarketMapping(snapshot, { allMarkets: true, tokenCap: 4 }), /selected-market-not-active-open-correlated-binary/);
  assert.throws(() => selectMarketMapping({ events: [{ id: "e", markets: [nestedMarket("a"), nestedMarket("b")] }] }, { allMarkets: true, tokenCap: 2 }), /token-cap-exceeded/);
});

test("strict event normalization accepts documented types and rejects malformed timestamps and levels", () => {
  const tokens = new Set(["yes"]);
  const book = normalizeEvent({ event_type: "book", asset_id: "yes", timestamp: "1700000000000", bids: [{ price: "0.4", size: "2" }], asks: [{ price: "0.6", size: "3" }] }, tokens);
  assert.deepEqual(book.event.bids, [{ price: 0.4, size: 2 }]);
  assert.equal(normalizeEvent({ event_type: "book", asset_id: "yes", timestamp: 1700000000000, bids: [], asks: [] }, tokens).error, "invalid-unix-ms-timestamp-string");
  assert.equal(normalizeEvent({ event_type: "book", asset_id: "yes", timestamp: "1700000000000", bids: [{ price: 2, size: 1 }], asks: [] }, tokens).error, "invalid-book-levels");
  assert.equal(normalizeEvent({ event_type: "tick_size_change", asset_id: "yes", timestamp: "1700000000001", old_tick_size: "0.01", new_tick_size: "0.001" }, tokens).event.newTickSize, 0.001);
  assert.equal(normalizeEvent({ event_type: "price_change", timestamp: "1700000000002", price_changes: [{ asset_id: "yes", price: "0.5", size: "1", side: "BUY", best_bid: "0.49", best_ask: "0.51" }] }, tokens).event.changes[0].bestAsk, 0.51);
});

test("PING is sent every configured heartbeat and PONG is accepted without becoming an event", async () => {
  MockWebSocket.instances = [];
  const clock = fakeClock();
  const session = new MarketCaptureSession({ mapping: mapping(), durationMs: 1_000, maxEvents: 10, maxBytes: 10_000 }, { WebSocketImpl: MockWebSocket, ...clock });
  const completed = session.start();
  const socket = MockWebSocket.instances[0];
  socket.emit("open");
  assert.deepEqual(JSON.parse(socket.sent[0]), buildSubscription(["market-yes", "market-no"]));
  assert.equal(clock.intervals[0].ms, HEARTBEAT_MS);
  clock.intervals[0].fn();
  assert.equal(socket.sent[1], "PING");
  socket.emit("message", { data: "PONG" });
  session.stop("test-complete");
  const artifact = await completed;
  assert.equal(artifact.capture.pongCount, 1);
  assert.equal(artifact.capture.eventCount, 0);
  assert.equal(JSON.stringify(artifact).includes("wss://"), false);
});

test("event and byte bounds stop accumulation deterministically", () => {
  const selected = mapping();
  const accumulator = new CaptureAccumulator(selected, { maxEvents: 1, maxBytes: 10_000 }, () => 1);
  const payload = JSON.stringify([
    { event_type: "book", asset_id: "market-yes", timestamp: "1700000000000", bids: [], asks: [] },
    { event_type: "book", asset_id: "market-no", timestamp: "1700000000000", bids: [], asks: [] },
  ]);
  assert.equal(accumulator.acceptText(payload).stop, "max-events");
  assert.equal(accumulator.events.length, 1);
  const byteBound = new CaptureAccumulator(selected, { maxEvents: 10, maxBytes: 3 }, () => 1);
  assert.equal(byteBound.acceptText("PONG").stop, "max-bytes");
  assert.equal(byteBound.byteCount, 0);
  assert.throws(() => new MarketCaptureSession({ mapping: selected, durationMs: 300_001, maxEvents: 1, maxBytes: 1 }, { WebSocketImpl: MockWebSocket }), /invalid-duration-ms/);
});

test("malformed events are counted by sanitized code and timestamp regression marks a gap", () => {
  const selected = mapping();
  const accumulator = new CaptureAccumulator(selected, { maxEvents: 10, maxBytes: 10_000 }, () => 5);
  accumulator.acceptText("not-json");
  accumulator.acceptText(JSON.stringify({ event_type: "book", asset_id: "market-yes", timestamp: "1700000001000", bids: [], asks: [] }));
  accumulator.acceptText(JSON.stringify({ event_type: "book", asset_id: "market-yes", timestamp: "1700000000000", bids: [], asks: [] }));
  assert.deepEqual(accumulator.malformed.codes, { "invalid-json": 1 });
  assert.equal(accumulator.events[0].receiveSequence, 1);
  assert.equal(accumulator.events[1].receiveSequence, 2);
  assert.equal(accumulator.gap.detected, true);
  assert.ok(accumulator.gap.reasons.includes("source-timestamp-regression"));
});

test("bounded reconnect marks explicit gap flags and uses exponential-backoff first delay", async () => {
  MockWebSocket.instances = [];
  const clock = fakeClock();
  const session = new MarketCaptureSession({ mapping: mapping(), durationMs: 5_000, maxEvents: 10, maxBytes: 10_000, maxReconnects: 1 }, { WebSocketImpl: MockWebSocket, ...clock });
  const completed = session.start();
  MockWebSocket.instances[0].emit("close");
  const reconnect = clock.timers.find((timer) => timer.ms === 250);
  assert.ok(reconnect);
  reconnect.fn();
  assert.equal(MockWebSocket.instances.length, 2);
  session.stop("test-complete");
  const artifact = await completed;
  assert.deepEqual(artifact.capture.reconnect, { attempted: true, count: 1 });
  assert.equal(artifact.capture.gap.detected, true);
  assert.ok(artifact.capture.gap.reasons.includes("reconnect-without-gap-recovery"));
  assert.equal(artifact.capture.guarantees.sequenceReplay, false);
});

test("offline replay derives top levels, durations, possible interactions, and adverse windows", () => {
  const result = replayFixture(demoFixture());
  const yes = result.analysis.topOfBook["demo-yes"];
  assert.equal(yes.points[0].bestBid, 0.48);
  assert.ok(Math.abs(yes.points[0].spread - 0.02) < 1e-12);
  assert.equal(yes.levelDurations[0].durationMs, 2_900);
  assert.equal(result.analysis.publicTrades[0].possibleInteraction, true);
  assert.equal(result.analysis.publicTrades[0].relation, "touch");
  assert.equal(result.analysis.publicTrades[0].classification, "possibleInteraction-only-no-fill-inference");
  assert.equal(result.analysis.adverseSelection[0].windows[0].futureExecutableReference, 0.51);
});

test("analysis maintains strict zero-fill, zero-reward, and no-PnL invariants", () => {
  const analysis = replayFixture(demoFixture()).analysis;
  assert.deepEqual(analysis.invariants, {
    paperFills: 0,
    position: 0,
    makerRebates: 0,
    liquidityRewards: 0,
    realizedPnl: null,
    expectedPnl: null,
    blocker: "Aggregate public market feeds cannot prove queue allocation, cancellations versus fills, account attribution, or maker eligibility.",
  });
  assert.equal(analysis.rewardScoreInputs[0].available, true);
  assert.equal(analysis.rewardScoreInputs[0].payoutEstimate, null);
  assert.deepEqual(analysis.unknowns, [
    "queue priority",
    "cancellations vs fills",
    "hidden competing size",
    "ordering/replay",
    "account attribution",
    "reward competition/sample times",
  ]);
});

test("CLI defaults to offline help and deterministic demo replay never accesses network", () => {
  const cli = path.join(__dirname, "..", "polymarket-research-r2", "cli.js");
  const help = spawnSync(process.execPath, [cli], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Only capture opens the public market WebSocket/);
  const first = spawnSync(process.execPath, [cli, "replay", "--demo"], { encoding: "utf8" });
  const second = spawnSync(process.execPath, [cli, "replay", "--demo"], { encoding: "utf8" });
  assert.equal(first.status, 0);
  assert.equal(first.stdout, second.stdout);
  assert.equal(JSON.parse(first.stdout).analysis.invariants.paperFills, 0);
});
