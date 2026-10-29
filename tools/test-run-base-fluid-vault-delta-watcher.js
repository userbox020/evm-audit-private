"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const watcher = require("./run-base-fluid-vault-delta-watcher");

const FACTORY = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const defs = Object.fromEntries(watcher.EVENT_DEFINITIONS.map((item) => [item.eventClass, item]));
const word = (value) => `0x${BigInt(value).toString(16).padStart(64, "0")}`;
const addressWord = (address) => `0x${"0".repeat(24)}${address.slice(2)}`;
const hash = (number) => `0x${BigInt(number).toString(16).padStart(64, "0")}`;

function readManifest(filePath) {
  assert.ok(filePath.replaceAll("\\", "/").endsWith(watcher.FACTORY_MANIFEST));
  return Buffer.from(JSON.stringify({ address: FACTORY.toUpperCase().replace("0X", "0x"), ignored: OTHER }));
}

function eventLog(eventClass, logIndex, overrides = {}) {
  const definition = defs[eventClass];
  const values = definition.topicKinds.map((kind, index) => {
    if (kind === "address") return addressWord(index % 2 === 0 ? FACTORY : OTHER);
    if (kind === "bool") return word(1);
    return word(9);
  });
  return {
    address: FACTORY,
    topics: [definition.topic0, ...values],
    data: definition.dataWords === 0 ? "0x" : word(77),
    logIndex,
    ...overrides
  };
}

function block(number, logs = [], overrides = {}) {
  return {
    header: {
      number,
      hash: hash(number + 1),
      parentHash: hash(number),
      timestamp: 1_800_000_000 + number,
      ...(overrides.header || {})
    },
    logs,
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "header"))
  };
}

function traceBlock(number, traces = [], overrides = {}) {
  return {
    header: {
      number,
      hash: hash(number + 1),
      parentHash: hash(number),
      timestamp: 1_800_000_000 + number,
      ...(overrides.header || {})
    },
    traces,
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "header"))
  };
}

function spellTrace(traceAddress, overrides = {}) {
  return {
    type: "call",
    callTo: FACTORY,
    callSighash: watcher.SPELL_SELECTOR,
    traceAddress,
    error: null,
    ...overrides
  };
}

function ndjson(records) {
  return `${records.map((item) => JSON.stringify(item)).join("\n")}\n`;
}

function injectedFetch(head, pages, requests = []) {
  let page = 0;
  return async (url, init) => {
    if (url.endsWith("/head")) return new Response(String(head), { status: 200 });
    requests.push(JSON.parse(init.body));
    const next = pages[page++];
    if (next instanceof Error) throw next;
    if (next && typeof next === "object" && Object.hasOwn(next, "status")) {
      return new Response(next.body || null, { status: next.status });
    }
    return new Response(next, { status: 200 });
  };
}

function options(fetchFn, extra = {}) {
  return { fetchFn, readFileFn: readManifest, fromBlock: 100, toBlock: 101, ...extra };
}

test("decodes all six exact source event classes into sanitized aggregates", async () => {
  const requests = [];
  const logs = watcher.EVENT_DEFINITIONS.map((definition, index) => eventLog(definition.eventClass, index));
  const result = await watcher.runWatcher(options(injectedFetch(200, [ndjson([block(100, logs), block(101)])], requests)));

  assert.equal(result.status, watcher.SUCCESS_STATUS);
  assert.equal(result.headerCount, 2);
  for (const definition of watcher.EVENT_DEFINITIONS) assert.equal(result.eventClassCounts[definition.eventClass], 1);
  assert.equal(result.eventClassBlockPositionCommitments.length, 6);
  assert.equal(result.canonicalParentContinuity, true);
  assert.equal(result.paginationComplete, true);
  assert.equal(result.finalized, true);
  assert.equal(result.forkEligible, false);
  assert.equal(result.routePositive, false);
  assert.equal(result.execution, false);
  assert.equal(result.signed, false);
  assert.equal(requests[0].includeAllBlocks, true);
  assert.deepEqual(requests[0].logs[0].address, [FACTORY]);
  assert.deepEqual(requests[0].logs[0].topic0, watcher.EVENT_DEFINITIONS.map((item) => item.topic0));
});

test("wrong-factory, malformed, unknown, and transport-failed logs fail closed", async (t) => {
  const cases = [
    ["wrong factory", eventLog("VaultDeployed", 0, { address: OTHER }), "FACTORY_EMITTER_INVALID"],
    ["malformed bool", eventLog("LogSetDeployer", 0, { topics: [defs.LogSetDeployer.topic0, addressWord(OTHER), word(2)] }), "TOPIC_BOOL_INVALID"],
    ["malformed data", eventLog("VaultT4Deployed", 0, { data: "0x00" }), "LOG_DATA_BOUNDS_INVALID"],
    ["unknown topic", eventLog("VaultDeployed", 0, { topics: [hash(999), addressWord(OTHER), word(1)] }), "UNKNOWN_TOPIC"]
  ];
  for (const [name, log, code] of cases) {
    await t.test(name, async () => {
      const result = await watcher.runWatcher(options(injectedFetch(200, [ndjson([block(100, [log]), block(101)])])));
      assert.equal(result.status, "ERROR");
      assert.equal(result.error, code);
      assert.ok(Object.values(result.eventClassCounts).every((count) => count === 0));
      assert.deepEqual(result.eventClassBlockPositionCommitments, []);
      assert.equal(result.finalized, false);
    });
  }
  await t.test("transport failure", async () => {
    const result = await watcher.runWatcher(options(injectedFetch(200, [new TypeError("fixture transport failure")])));
    assert.equal(result.status, "ERROR");
    assert.equal(result.error, "STREAM_FETCH_FAILED");
  });
});

test("continues from last header plus one and enforces parent continuity", async () => {
  const requests = [];
  const result = await watcher.runWatcher(options(injectedFetch(200, [
    ndjson([block(100)]),
    ndjson([block(101, [eventLog("VaultDeployed", 3)])])
  ], requests)));
  assert.equal(result.status, watcher.SUCCESS_STATUS);
  assert.deepEqual(requests.map((request) => request.fromBlock), [100, 101]);
  assert.deepEqual(requests.map((request) => request.toBlock), [101, 101]);

  const broken = block(101);
  broken.header.parentHash = hash(999);
  const failed = await watcher.runWatcher(options(injectedFetch(200, [ndjson([block(100), broken])])));
  assert.equal(failed.status, "ERROR");
  assert.equal(failed.error, "PARENT_HASH_CONTINUITY_INVALID");
});

test("page, response-byte, and record caps fail closed", async (t) => {
  await t.test("page cap", async () => {
    const result = await watcher.runWatcher(options(injectedFetch(200, [ndjson([block(100)])]), { maxPages: 1 }));
    assert.equal(result.error, "PAGE_CAP_EXCEEDED");
  });
  await t.test("response cap", async () => {
    const result = await watcher.runWatcher(options(injectedFetch(200, [ndjson([block(100), block(101)])]), { maxResponseBytes: 8 }));
    assert.equal(result.error, "RESPONSE_BYTES_CAP_EXCEEDED");
  });
  await t.test("record cap after decoded event", async () => {
    const result = await watcher.runWatcher(options(injectedFetch(200, [ndjson([
      block(100, [eventLog("VaultDeployed", 0)]), block(101)
    ])]), { maxRecords: 2 }));
    assert.equal(result.error, "RECORD_CAP_EXCEEDED");
    assert.ok(Object.values(result.eventClassCounts).every((count) => count === 0));
    assert.deepEqual(result.eventClassBlockPositionCommitments, []);
  });
});

test("result leaks no raw identifiers, topics, data, actors, or endpoint", async () => {
  const rawData = word(123456);
  const log = eventLog("VaultT4Deployed", 7, { data: rawData });
  const result = await watcher.runWatcher(options(injectedFetch(200, [ndjson([block(100, [log]), block(101)])])));
  const serialized = JSON.stringify(result).toLowerCase();
  assert.equal(result.status, watcher.SUCCESS_STATUS);
  for (const forbidden of [FACTORY, OTHER, rawData, log.topics[0], hash(100), hash(101), "portal.sqd.dev", "/finalized-stream"]) {
    assert.equal(serialized.includes(forbidden.toLowerCase()), false, `leaked ${forbidden}`);
  }
  assert.doesNotMatch(serialized, /0x[0-9a-f]{8,}/u);
  assert.match(result.derivedHash, /^derived_[A-Za-z0-9_-]{43}$/u);
});

test("aggregate result and derived hash are stable", async () => {
  const body = ndjson([block(100, [eventLog("LogSetGlobalAuth", 1)]), block(101)]);
  const first = await watcher.runWatcher(options(injectedFetch(200, [body])));
  const second = await watcher.runWatcher(options(injectedFetch(200, [body])));
  assert.deepEqual(second, first);
});

test("204 and over-wide windows cannot produce success", async () => {
  const incomplete = await watcher.runWatcher(options(injectedFetch(200, [{ status: 204 }])));
  assert.equal(incomplete.error, "FINALIZED_WINDOW_INCOMPLETE");
  const wide = await watcher.runWatcher({
    fetchFn: injectedFetch(10_000, []), readFileFn: readManifest, fromBlock: 1, toBlock: 4097
  });
  assert.equal(wide.error, "WINDOW_BOUNDS_INVALID");
});

test("complete spell trace pass with no events or traces closes discovery only", async () => {
  const requests = [];
  const result = await watcher.runWatcher(options(injectedFetch(200, [
    ndjson([block(100), block(101)]),
    ndjson([traceBlock(100), traceBlock(101)])
  ], requests), { includeSpellTrace: true }));

  assert.equal(result.status, watcher.COMPLETE_STATUS);
  assert.equal(result.traceCompleteness, "COMPLETE");
  assert.equal(result.spellTraceCount, 0);
  assert.deepEqual(result.spellTraceBlockPositionCommitments, []);
  assert.equal(result.forkEligible, false);
  assert.equal(result.routePositive, false);
  assert.equal(result.execution, false);
  assert.equal(result.signed, false);
  const traceRequest = requests.find((request) => Array.isArray(request.traces));
  assert.deepEqual(traceRequest.traces[0], {
    type: ["call", "delegatecall", "staticcall"],
    callTo: [FACTORY],
    callSighash: [watcher.SPELL_SELECTOR]
  });
  assert.deepEqual(Object.keys(traceRequest.fields.trace).sort(), ["callSighash", "callTo", "error", "traceAddress", "type"]);
  assert.equal(Object.hasOwn(traceRequest.fields.trace, "input"), false);
});

test("matching spell traces produce symbolic count and opaque positions", async () => {
  const result = await watcher.runWatcher(options(injectedFetch(200, [
    ndjson([block(100), block(101)]),
    ndjson([
      traceBlock(100, [spellTrace([0]), spellTrace([1, 0], { type: "delegatecall" })]),
      traceBlock(101)
    ])
  ]), { includeSpellTrace: true }));

  assert.equal(result.status, watcher.DELTA_STATUS);
  assert.equal(result.traceCompleteness, "COMPLETE");
  assert.equal(result.spellTraceCount, 2);
  assert.equal(result.spellTraceBlockPositionCommitments.length, 2);
  assert.ok(result.spellTraceBlockPositionCommitments.every((value) => /^spell-position_[A-Za-z0-9_-]{43}$/u.test(value)));
});

test("trace errors, malformed shapes, wrong targets, and wrong selectors reject", async (t) => {
  const cases = [
    ["trace error", spellTrace([0], { error: "reverted" }), "TRACE_ERROR"],
    ["malformed address", spellTrace(["0"]), "TRACE_ADDRESS_INVALID"],
    ["wrong target", spellTrace([0], { callTo: OTHER }), "TRACE_TARGET_INVALID"],
    ["wrong selector", spellTrace([0], { callSighash: "0x12345678" }), "TRACE_SELECTOR_INVALID"],
    ["wrong type", spellTrace([0], { type: "create" }), "TRACE_TYPE_INVALID"]
  ];
  for (const [name, trace, code] of cases) {
    await t.test(name, async () => {
      const result = await watcher.runWatcher(options(injectedFetch(200, [
        ndjson([block(100), block(101)]),
        ndjson([traceBlock(100, [trace]), traceBlock(101)])
      ]), { includeSpellTrace: true }));
      assert.equal(result.status, "ERROR");
      assert.equal(result.error, code);
      assert.equal(result.traceCompleteness, "FAILED");
      assert.equal(result.spellTraceCount, 0);
      assert.deepEqual(result.spellTraceBlockPositionCommitments, []);
      assert.ok(Object.values(result.eventClassCounts).every((count) => count === 0));
    });
  }
});

test("spell trace continuation is exact and independently parent-continuous", async () => {
  const requests = [];
  const result = await watcher.runWatcher(options(injectedFetch(200, [
    ndjson([block(100), block(101)]),
    ndjson([traceBlock(100)]),
    ndjson([traceBlock(101, [spellTrace([2])])])
  ], requests), { includeSpellTrace: true }));
  assert.equal(result.status, watcher.DELTA_STATUS);
  const traceRequests = requests.filter((request) => Array.isArray(request.traces));
  assert.deepEqual(traceRequests.map((request) => request.fromBlock), [100, 101]);

  const broken = traceBlock(101);
  broken.header.parentHash = hash(999);
  const failed = await watcher.runWatcher(options(injectedFetch(200, [
    ndjson([block(100), block(101)]),
    ndjson([traceBlock(100), broken])
  ]), { includeSpellTrace: true }));
  assert.equal(failed.error, "TRACE_PARENT_HASH_CONTINUITY_INVALID");
});

test("spell trace output is sanitized and deterministic", async () => {
  const pages = () => [
    ndjson([block(100), block(101)]),
    ndjson([traceBlock(100, [spellTrace([7, 8, 9], { type: "staticcall" })]), traceBlock(101)])
  ];
  const first = await watcher.runWatcher(options(injectedFetch(200, pages()), { includeSpellTrace: true }));
  const second = await watcher.runWatcher(options(injectedFetch(200, pages()), { includeSpellTrace: true }));
  assert.deepEqual(second, first);
  const serialized = JSON.stringify(first).toLowerCase();
  for (const forbidden of [FACTORY, OTHER, watcher.SPELL_SELECTOR, "7,8,9", hash(100), "portal.sqd.dev", "/finalized-stream"]) {
    assert.equal(serialized.includes(forbidden.toLowerCase()), false, `leaked ${forbidden}`);
  }
  assert.doesNotMatch(serialized, /0x[0-9a-f]{8,}/u);
});

function requalManifest(filePath) {
  assert.ok(filePath.replaceAll("\\", "/").endsWith(watcher.FACTORY_MANIFEST));
  return Buffer.from(JSON.stringify({ address: FACTORY, abi: [{ type: "function", name: "spell", stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "bytes" }], outputs: [{ type: "bytes" }] }] }));
}

function rpcHeader(number, variant = 0) {
  return { number: `0x${BigInt(number).toString(16)}`, hash: hash(number + 1 + variant), parentHash: hash(number + variant),
    stateRoot: hash(number + 10_000 + variant), timestamp: `0x${BigInt(1_800_000_000 + number).toString(16)}` };
}

function boundaryTransport(config = {}) {
  const calls = [];
  const transport = async ({ candidate, envelope }) => {
    calls.push({ family: candidate.family, method: envelope.method, params: envelope.params });
    let result;
    if (envelope.method === "eth_chainId") result = "0x2105";
    else {
      const number = envelope.params[0] === "finalized" ? 200 : Number(BigInt(envelope.params[0]));
      const variant = config.variant && config.variant(candidate, number) || 0;
      result = rpcHeader(number, variant);
    }
    const value = { jsonrpc: "2.0", id: envelope.id, result };
    if (config.delayMs) await new Promise((resolve) => setTimeout(resolve, config.delayMs));
    return { value, bytes: Buffer.byteLength(JSON.stringify(value)) };
  };
  transport.calls = calls;
  return transport;
}

function requalTraceBlock(number, traces = []) {
  return { header: { number, hash: hash(number + 1), parentHash: hash(number), timestamp: 1_800_000_000 + number }, traces };
}

function requalSpell(transactionIndex, traceAddressValue, overrides = {}) {
  return { type: "call", callTo: FACTORY, callSighash: watcher.SPELL_SELECTOR, transactionIndex,
    traceAddress: traceAddressValue, error: null, ...overrides };
}

function requalFetch(head, pages, requests = []) {
  let page = 0;
  return async (url, init) => {
    if (url.endsWith("/head")) return new Response(String(head), { status: 200 });
    requests.push(JSON.parse(init.body));
    const next = pages[page++];
    if (next && typeof next === "object" && Object.hasOwn(next, "status")) return new Response(next.body || null, { status: next.status });
    return new Response(next, { status: 200 });
  };
}

function requalOptions(fetchFn, extra = {}) {
  return { requalifyTrace: true, fromBlock: 100, toBlock: 101, fetchFn, readFileFn: requalManifest,
    boundaryCandidates: [{ family: "fixture-a" }, { family: "fixture-b" }, { family: "fixture-c" }],
    rpcTransport: boundaryTransport(), requestMs: 500, ...extra };
}

test("requalification continues finalized NDJSON exactly and agrees across two anonymous boundary families", async () => {
  const requests = [];
  const transport = boundaryTransport();
  const result = await watcher.runWatcher(requalOptions(requalFetch(200, [
    ndjson([requalTraceBlock(100)]), ndjson([requalTraceBlock(101, [requalSpell(4, [0])])])
  ], requests), { rpcTransport: transport }));
  assert.equal(result.status, "COMPLETE");
  assert.equal(result.sqdCompleteness, "COMPLETE");
  assert.deepEqual(result.anonymousBoundaryFamilyCounts, { candidates: 3, qualified: 3, selected: 2 });
  assert.equal(result.traceCount, 1);
  assert.equal(result.spellCount, 1);
  assert.deepEqual(requests.map((item) => item.fromBlock), [100, 101]);
  assert.deepEqual(requests.map((item) => item.toBlock), [101, 101]);
  assert.deepEqual(requests[0].traces[0], { type: ["call", "delegatecall", "staticcall"], callTo: [FACTORY],
    callSighash: [watcher.SPELL_SELECTOR] });
  assert.equal(result.retries, 0);
  assert.equal(result.pages, 2);
  assert.equal(result.cleanup, "NOT_REQUIRED");
  assert.equal(result.independentTraceRedundancyAvailable, false);
  assert.ok(transport.calls.every((item) => ["eth_chainId", "eth_getBlockByNumber"].includes(item.method)));
});

test("requalification fails closed on prior 529, partial NDJSON, and non-progress", async (t) => {
  await t.test("529", async () => {
    const result = await watcher.runWatcher(requalOptions(requalFetch(200, [{ status: 529 }])));
    assert.equal(result.status, "ERROR");
    assert.equal(result.code, "SQD_TRACE_HTTP_529");
    assert.equal(result.traceCount, null);
  });
  await t.test("partial", async () => {
    const body = JSON.stringify(requalTraceBlock(100));
    const result = await watcher.runWatcher(requalOptions(requalFetch(200, [body])));
    assert.equal(result.code, "SQD_TRACE_NDJSON_PARTIAL");
    assert.equal(result.sqdCompleteness, "FAILED");
  });
  await t.test("non-progress", async () => {
    const result = await watcher.runWatcher(requalOptions(requalFetch(200, [""])));
    assert.equal(result.code, "SQD_TRACE_NON_PROGRESS");
  });
});

test("requalification enforces exact target, selector, success, order, and deterministic dedup", async (t) => {
  const cases = [
    ["target", requalSpell(0, [0], { callTo: OTHER }), "SQD_TRACE_TARGET_INVALID"],
    ["selector", requalSpell(0, [0], { callSighash: "0x12345678" }), "SQD_TRACE_SELECTOR_INVALID"],
    ["error", requalSpell(0, [0], { error: "reverted" }), "SQD_TRACE_EXECUTION_ERROR"]
  ];
  for (const [name, trace, code] of cases) {
    await t.test(name, async () => {
      const result = await watcher.runWatcher(requalOptions(requalFetch(200, [ndjson([
        requalTraceBlock(100, [trace]), requalTraceBlock(101)
      ])])));
      assert.equal(result.code, code);
      assert.equal(result.spellCount, null);
    });
  }
  await t.test("duplicate", async () => {
    const duplicate = requalSpell(0, [0]);
    const result = await watcher.runWatcher(requalOptions(requalFetch(200, [ndjson([
      requalTraceBlock(100, [duplicate, { ...duplicate }]), requalTraceBlock(101)
    ])])));
    assert.equal(result.code, "SQD_TRACE_DUPLICATE");
  });
});

test("requalification requires exact two-family boundary agreement", async () => {
  const transport = boundaryTransport({ variant: (candidate, number) => candidate.family === "fixture-c" && number === 101 ? 9 : 0 });
  const pass = await watcher.runWatcher(requalOptions(requalFetch(200, [ndjson([
    requalTraceBlock(100), requalTraceBlock(101)
  ])]), { rpcTransport: transport }));
  assert.equal(pass.status, "COMPLETE");
  assert.deepEqual(pass.anonymousBoundaryFamilyCounts, { candidates: 3, qualified: 3, selected: 2 });

  const disagree = boundaryTransport({ variant: (candidate) => candidate.family === "fixture-a" ? 1 : candidate.family === "fixture-b" ? 2 : 3 });
  const failed = await watcher.runWatcher(requalOptions(requalFetch(200, []), { rpcTransport: disagree }));
  assert.equal(failed.code, "BOUNDARY_AGREEMENT_FAILED");
  assert.equal(failed.traceCount, null);
});

test("requalification output leaks no endpoints, providers, target, selector, headers, or raw responses", async () => {
  const result = await watcher.runWatcher(requalOptions(requalFetch(200, [ndjson([
    requalTraceBlock(100, [requalSpell(7, [3, 4])]), requalTraceBlock(101)
  ])])));
  const serialized = JSON.stringify(result).toLowerCase();
  assert.equal(result.status, "COMPLETE");
  for (const forbidden of [FACTORY, OTHER, watcher.SPELL_SELECTOR, hash(100), hash(101), "fixture-a", "portal.sqd.dev", "provider", "endpoint", "rpc_endpoints"]) {
    assert.equal(serialized.includes(forbidden.toLowerCase()), false, `leaked ${forbidden}`);
  }
  assert.doesNotMatch(serialized, /https?:\/\//u);
  assert.deepEqual(Object.keys(result).sort(), ["anonymousBoundaryFamilyCounts", "cleanup", "code", "independentTraceRedundancyAvailable",
    "pages", "phase", "reads", "retries", "spellCount", "sqdCompleteness", "status", "traceCount", "window"].sort());
});

test("requalification request, wall, response, record, and page caps fail closed", async (t) => {
  const cases = [
    ["request", { maxRequests: 1 }, "REQUEST_CAP_EXCEEDED"],
    ["wall", { maxWallMs: 1, rpcTransport: boundaryTransport({ delayMs: 5 }) }, "WALL_CAP_EXCEEDED"],
    ["response", { maxResponseBytes: 8 }, "RESPONSE_BYTES_CAP_EXCEEDED"],
    ["record", { maxRecords: 1 }, "TRACE_RECORD_CAP_EXCEEDED"],
    ["page", { maxPages: 1 }, "TRACE_PAGE_CAP_EXCEEDED"]
  ];
  for (const [name, extra, code] of cases) {
    await t.test(name, async () => {
      const pages = name === "record" || name === "page"
        ? [ndjson([requalTraceBlock(100)]), ndjson([requalTraceBlock(101)])]
        : [ndjson([requalTraceBlock(100), requalTraceBlock(101)])];
      const result = await watcher.runWatcher(requalOptions(requalFetch(200, pages), extra));
      assert.equal(result.status, "ERROR");
      assert.equal(result.code, code);
      assert.equal(result.traceCount, null);
      assert.equal(result.retries, 0);
    });
  }
});
