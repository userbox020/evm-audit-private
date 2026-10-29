"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const resolverPath = path.resolve(__dirname, "..", "monitor-ws-endpoints.js");
const {
  WsResolutionError,
  getResolvedProvider,
  readLatestBlock,
  registerWsSubscription,
  resolveWsProvider,
  sanitizedErrorClass,
} = require(resolverPath);

function fakeProvider(chainId, extra = {}) {
  return {
    ...extra,
    async send(method) {
      assert.equal(method, "eth_chainId");
      return `0x${chainId.toString(16)}`;
    },
    async destroy() {
      this.destroyed = true;
    },
  };
}

test("candidate extraction is bounded, deduplicated, and capability ordered", async () => {
  const text = [
    "wss://generic-one.invalid/ws",
    "wss://shared.publicnode.com/ws",
    "wss://premium.infura.io/ws/value",
    "wss://generic-one.invalid/ws",
    "wss://ignored.invalid/ws",
  ].join("\n");
  const calls = [];
  await assert.rejects(resolveWsProvider({
    chainId: 10,
    candidateText: text,
    providerFactory: async value => {
      calls.push(value);
      return fakeProvider(1);
    },
    publicFallbacks: {},
    concurrency: 1,
    maxCandidates: 3,
    timeoutMs: 25,
  }), WsResolutionError);

  assert.equal(calls.length, 3);
  assert.match(calls[0], /premium\.infura\.io/);
  assert.match(calls[1], /generic-one\.invalid/);
  assert.match(calls[2], /ignored\.invalid/);
});

test("candidate bound is applied after capability-tier pooling", async () => {
  const text = [
    "wss://generic-first.invalid/ws",
    "wss://generic-second.invalid/ws",
    "wss://shared.publicnode.com/ws",
    "wss://preferred.infura.io/ws/late",
  ].join("\n");
  const calls = [];

  await assert.rejects(resolveWsProvider({
    chainId: 10,
    candidateText: text,
    providerFactory: async value => {
      calls.push(value);
      return fakeProvider(1);
    },
    publicFallbacks: {},
    concurrency: 1,
    maxCandidates: 3,
    timeoutMs: 25,
  }), WsResolutionError);

  assert.equal(calls.length, 3);
  assert.match(calls[0], /preferred\.infura\.io/);
  assert.match(calls[1], /generic-first\.invalid/);
  assert.match(calls[2], /generic-second\.invalid/);
});

test("qualifies actual chainId and returns an opaque inventory result", async () => {
  const selected = fakeProvider(8453, { marker: "selected" });
  const result = await resolveWsProvider({
    chainId: 8453,
    candidateText: "wss://synthetic-provider.invalid/path",
    providerFactory: async () => selected,
    publicFallbacks: {},
    timeoutMs: 25,
  });

  assert.deepEqual(Object.keys(result), ["sourceClass"]);
  assert.equal(result.sourceClass, "inventory");
  assert.equal(getResolvedProvider(result), selected);
  assert.equal(JSON.stringify(result), '{"sourceClass":"inventory"}');
});

test("excludes wrong-chain candidates before selecting a matching chain", async () => {
  const calls = [];
  const providers = new Map([
    ["wss://first.invalid/ws", fakeProvider(1)],
    ["wss://second.invalid/ws", fakeProvider(10, { marker: "right-chain" })],
  ]);
  const result = await resolveWsProvider({
    chainId: 10,
    candidateText: [...providers.keys()].join("\n"),
    providerFactory: async value => {
      calls.push(value);
      return providers.get(value);
    },
    publicFallbacks: {},
    concurrency: 1,
    timeoutMs: 25,
  });

  assert.equal(calls.length, 2);
  assert.equal(providers.get(calls[0]).destroyed, true);
  assert.equal(getResolvedProvider(result).marker, "right-chain");
});

test("uses a public fallback only after inventory qualification fails", async () => {
  const inventory = "wss://inventory-wrong.invalid/ws";
  const fallback = "wss://fallback-sentinel.invalid/ws/FALLBACK_TOKEN_SENTINEL";
  const calls = [];
  const result = await resolveWsProvider({
    chainId: 42161,
    candidateText: inventory,
    providerFactory: async value => {
      calls.push(value);
      return fakeProvider(value === fallback ? 42161 : 1);
    },
    publicFallbacks: { 42161: fallback },
    concurrency: 1,
    timeoutMs: 25,
  });

  assert.deepEqual(calls, [inventory, fallback]);
  assert.equal(result.sourceClass, "public-fallback");
  assert.doesNotMatch(JSON.stringify(result), /fallback-sentinel|FALLBACK_TOKEN_SENTINEL/i);
});

test("timeout and provider failures produce only sanitized errors", async () => {
  const sentinel = "SENSITIVE_URL_TOKEN_SENTINEL";
  const text = [
    `wss://timeout.invalid/ws/${sentinel}`,
    `wss://failure.invalid/ws/${sentinel}`,
  ].join("\n");
  let calls = 0;

  await assert.rejects(
    resolveWsProvider({
      chainId: 1,
      candidateText: text,
      providerFactory: async () => {
        calls += 1;
        if (calls === 1) return new Promise(() => {});
        throw Object.assign(new Error(`failed ${sentinel}`), { code: "SERVER_ERROR" });
      },
      publicFallbacks: {},
      concurrency: 1,
      timeoutMs: 5,
    }),
    error => {
      assert.ok(error instanceof WsResolutionError);
      assert.equal(error.message, "WS_RESOLUTION_FAILED");
      assert.doesNotMatch(JSON.stringify(error), new RegExp(sentinel));
      return true;
    },
  );

  const logLike = {
    errorClass: sanitizedErrorClass(new Error(`provider leaked ${sentinel}`)),
    timeoutClass: sanitizedErrorClass(Object.assign(new Error(sentinel), { code: "TIMEOUT" })),
  };
  assert.deepEqual(logLike, { errorClass: "ProviderError", timeoutClass: "TimeoutError" });
  assert.doesNotMatch(JSON.stringify(logLike), new RegExp(sentinel));
});

test("subscription registration and latest-block observation are bounded and sanitized", async () => {
  const listeners = new Map();
  const provider = {
    async on(event, listener) {
      listeners.set(event, listener);
      return this;
    },
    async getBlockNumber() {
      return 123456;
    },
  };
  const listener = () => {};

  await registerWsSubscription(provider, "block", listener, 25);
  assert.equal(listeners.get("block"), listener);
  assert.equal(await readLatestBlock(provider, 25), 123456);

  const sentinel = "SENSITIVE_PROVIDER_IDENTITY";
  await assert.rejects(
    registerWsSubscription({ on: async () => { throw new Error(sentinel); } }, "block", listener, 25),
    error => error instanceof WsResolutionError
      && error.message === "WS_SUBSCRIPTION_FAILED"
      && !JSON.stringify(error).includes(sentinel),
  );
  await assert.rejects(
    readLatestBlock({ getBlockNumber: () => new Promise(() => {}) }, 5),
    error => error instanceof WsResolutionError && error.message === "WS_OBSERVATION_FAILED",
  );
});

test("monitors become healthy only after injected subscriptions and an actual observation", async () => {
  const monitors = [
    require(path.resolve(__dirname, "..", "monitor-morpho-ws.js")),
    require(path.resolve(__dirname, "..", "monitor-chainlink-ws.js")),
  ];

  for (const monitor of monitors) {
    const config = Object.values(monitor.CHAINS || monitor.FEEDS)[0];
    const status = monitor.connectionState[config.key];
    Object.assign(status, {
      connected: false,
      degraded: true,
      connectedAt: null,
      sourceClass: null,
      errorClass: null,
      subscriptionState: "UNSUBSCRIBED",
      subscribedAt: null,
      lastObservedBlock: null,
      observationUpdatedAt: null,
    });

    const subscriptions = [];
    const transportListeners = new Map();
    const provider = {
      websocket: {
        on(event, listener) { transportListeners.set(event, listener); },
      },
      async on(event, listener) {
        assert.equal(status.connected, false);
        assert.equal(status.degraded, true);
        assert.equal(status.subscriptionState, "UNSUBSCRIBED");
        subscriptions.push({ event, listener });
        return this;
      },
      async getBlockNumber() {
        assert.equal(status.subscriptionState, "SUBSCRIBED");
        assert.equal(status.connected, false);
        return 987654;
      },
    };
    const writes = [];
    const reconnects = [];

    const connectedProvider = await monitor.connectChain(config, {
      resolveWsProvider: async () => ({ sourceClass: "inventory" }),
      getResolvedProvider: () => provider,
      scheduleReconnect: (failedConfig, failedProvider, error) => {
        reconnects.push({ failedConfig, failedProvider, errorClass: sanitizedErrorClass(error) });
        monitor.markDegraded(failedConfig, error);
      },
      writeStatus: trigger => writes.push(trigger),
      log: () => {},
    });

    assert.equal(connectedProvider, provider);
    assert.equal(subscriptions.length, 2);
    assert.equal(subscriptions[1].event, "block");
    assert.equal(status.subscriptionState, "SUBSCRIBED");
    assert.equal(status.connected, true);
    assert.equal(status.degraded, false);
    assert.equal(status.lastObservedBlock, 987654);
    assert.ok(status.observationUpdatedAt);
    assert.deepEqual(writes, ["observed"]);

    const observationTimestamp = status.observationUpdatedAt;
    writes.push("interval");
    assert.equal(status.observationUpdatedAt, observationTimestamp);
    subscriptions[1].listener(987655);
    assert.equal(status.lastObservedBlock, 987655);
    assert.equal(writes.at(-1), "observation");
    const writesAfterProgress = writes.length;
    const progressedAt = status.observationUpdatedAt;
    subscriptions[1].listener(987655);
    assert.equal(writes.length, writesAfterProgress);
    assert.equal(status.observationUpdatedAt, progressedAt);

    transportListeners.get("close")();
    assert.equal(reconnects.length, 1);
    assert.equal(status.subscriptionState, "UNSUBSCRIBED");
    assert.equal(status.connected, false);
    assert.equal(status.degraded, true);
    assert.equal(status.lastObservedBlock, 987655);
    assert.ok(status.observationUpdatedAt);
  }
});

test("failed heartbeat subscription remains fail-closed without leaking provider errors", async () => {
  const monitor = require(path.resolve(__dirname, "..", "monitor-chainlink-ws.js"));
  const config = Object.values(monitor.FEEDS)[1];
  const status = monitor.connectionState[config.key];
  const sentinel = "PRIVATE_PROVIDER_SENTINEL";
  let registrations = 0;
  let reconnectErrorClass = null;
  Object.assign(status, {
    connected: false,
    degraded: true,
    connectedAt: null,
    subscriptionState: "UNSUBSCRIBED",
    subscribedAt: null,
    lastObservedBlock: null,
    observationUpdatedAt: null,
  });

  await monitor.connectChain(config, {
    resolveWsProvider: async () => ({ sourceClass: "inventory" }),
    getResolvedProvider: () => ({
      async on() {
        registrations += 1;
        if (registrations === 2) throw new Error(sentinel);
        return this;
      },
    }),
    scheduleReconnect: (failedConfig, _provider, error) => {
      reconnectErrorClass = sanitizedErrorClass(error);
      monitor.markDegraded(failedConfig, error);
    },
    writeStatus: () => {},
    log: () => {},
  });

  assert.equal(registrations, 2);
  assert.equal(reconnectErrorClass, "ResolutionError");
  assert.equal(status.subscriptionState, "UNSUBSCRIBED");
  assert.equal(status.connected, false);
  assert.equal(status.lastObservedBlock, null);
  assert.doesNotMatch(JSON.stringify(status), new RegExp(sentinel));
});

test("requiring monitor modules does not start monitor execution", () => {
  const morpho = require(path.resolve(__dirname, "..", "monitor-morpho-ws.js"));
  const chainlink = require(path.resolve(__dirname, "..", "monitor-chainlink-ws.js"));
  assert.equal(typeof morpho.main, "function");
  assert.equal(typeof chainlink.main, "function");
});

test("placeholder and malformed candidate hostnames are skipped before the factory is called", async () => {
  const placeholder = "wss://{chain}.infura.io";
  const malformed = [
    placeholder,
    "wss://a..b.invalid/ws",
    "wss://-leading.invalid/ws",
    "wss://trailing-.invalid/ws",
    "wss://.leading.invalid/ws",
    "wss://trailingdot.invalid./ws",
    `wss://${"a".repeat(260)}.invalid/ws`,
  ];
  const valid = "wss://valid-sentinel.invalid/ws";
  const calls = [];

  const result = await resolveWsProvider({
    chainId: 1,
    candidateText: [...malformed, valid].join("\n"),
    providerFactory: async value => {
      calls.push(value);
      return fakeProvider(1);
    },
    publicFallbacks: {},
    maxCandidates: 24,
    timeoutMs: 25,
  });

  assert.deepEqual(calls, [valid]);
  assert.equal(result.sourceClass, "inventory");
  const serialized = JSON.stringify({ calls, result });
  for (const bad of malformed) {
    assert.equal(serialized.includes(bad), false, bad);
  }
  assert.equal(serialized.includes("{chain}"), false);
});

test("malformed public fallback hostnames are rejected without ever dialing", async () => {
  const fallbacks = [
    "wss://bad host.invalid/ws",
    "wss://angle<bad.invalid/ws",
    "wss://angle>bad.invalid/ws",
    "wss://{chain}.infura.io",
    "wss://a..b.invalid/ws",
    "wss://-bad.invalid/ws",
  ];
  for (const fallback of fallbacks) {
    const calls = [];
    await assert.rejects(resolveWsProvider({
      chainId: 1,
      candidateText: "",
      providerFactory: async value => {
        calls.push(value);
        return fakeProvider(1);
      },
      publicFallbacks: { 1: fallback },
      timeoutMs: 25,
    }), WsResolutionError);
    assert.deepEqual(calls, []);
  }
});

test("emitted socket errors cannot crash qualification and fall through to the next candidate", async () => {
  const synchronousSocket = new EventEmitter();
  const synchronous = {
    websocket: synchronousSocket,
    async send() {
      synchronousSocket.emit("error", new Error("synthetic synchronous socket failure"));
      return new Promise(() => {});
    },
    async destroy() { this.destroyed = true; },
  };
  const deferredSocket = new EventEmitter();
  const deferred = {
    websocket: deferredSocket,
    async send() {
      setTimeout(() => deferredSocket.emit("error", new Error("synthetic deferred socket failure")), 0);
      return new Promise(() => {});
    },
    async destroy() { this.destroyed = true; },
  };
  const good = fakeProvider(1, { marker: "good" });
  const providers = [synchronous, deferred, good];
  const calls = [];

  const result = await resolveWsProvider({
    chainId: 1,
    candidateText: [
      "wss://first.invalid/ws",
      "wss://second.invalid/ws",
      "wss://third.invalid/ws",
    ].join("\n"),
    providerFactory: async value => {
      calls.push(value);
      return providers.shift();
    },
    publicFallbacks: {},
    concurrency: 1,
    timeoutMs: 25,
  });

  assert.equal(calls.length, 3);
  assert.equal(synchronous.destroyed, true);
  assert.equal(deferred.destroyed, true);
  assert.equal(getResolvedProvider(result).marker, "good");
});

test("wrong-chain candidates are rejected and destroyed before a fallback is considered", async () => {
  const wrong = fakeProvider(10, { marker: "wrong" });
  const fallback = "wss://fallback-sentinel.invalid/ws/FALLBACK_TOKEN_SENTINEL";
  const good = fakeProvider(1, { marker: "fallback-good" });
  const calls = [];

  const result = await resolveWsProvider({
    chainId: 1,
    candidateText: "wss://inventory-wrong.invalid/ws",
    providerFactory: async value => {
      calls.push(value);
      return value === fallback ? good : wrong;
    },
    publicFallbacks: { 1: fallback },
    concurrency: 1,
    timeoutMs: 25,
  });

  assert.deepEqual(calls, ["wss://inventory-wrong.invalid/ws", fallback]);
  assert.equal(wrong.destroyed, true);
  assert.equal(result.sourceClass, "public-fallback");
  assert.equal(getResolvedProvider(result).marker, "fallback-good");
});

test("all-fail resolution throws sanitized errors and surfaces no candidate text", async () => {
  const sentinel = "WS_CANDIDATE_SECRET_SENTINEL";
  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(" "));
  console.error = (...args) => logs.push(args.join(" "));

  try {
    await assert.rejects(
      resolveWsProvider({
        chainId: 1,
        candidateText: `wss://dead-${sentinel}.invalid/ws`,
        providerFactory: async () => {
          throw Object.assign(new Error(`failed ${sentinel}`), { code: "ENOTFOUND" });
        },
        publicFallbacks: {},
        timeoutMs: 25,
      }),
      error => error instanceof WsResolutionError
        && error.message === "WS_RESOLUTION_FAILED"
        && !JSON.stringify(error).includes(sentinel),
    );
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  assert.deepEqual(logs, []);
  assert.equal(JSON.stringify(logs).includes(sentinel), false);
});
