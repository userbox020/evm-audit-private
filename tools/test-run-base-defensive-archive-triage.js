"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const triage = require("./run-base-defensive-archive-triage");

const FLUID_PATH = "targets/fluid-contracts-public/deployments/base/Liquidity.json";
const ADDRESSES = Object.freeze({
  shared: "0x1111111111111111111111111111111111111111",
  weth: "0x2222222222222222222222222222222222222222",
  usdc: "0x3333333333333333333333333333333333333333",
  fluid: "0x4444444444444444444444444444444444444444",
  sender: "0x5555555555555555555555555555555555555555"
});

function manifestReader(filePath) {
  const normalized = filePath.replaceAll("\\", "/");
  if (normalized.endsWith("/compound-comet/deployments/base/weth/roots.json")) {
    return Buffer.from(JSON.stringify({ comet: ADDRESSES.weth.toUpperCase().replace("0X", "0x"), configurator: ADDRESSES.shared }));
  }
  if (normalized.endsWith("/compound-comet/deployments/base/usdc/roots.json")) {
    return Buffer.from(JSON.stringify({ comet: ADDRESSES.usdc, configurator: ADDRESSES.shared }));
  }
  if (normalized.endsWith("/fluid-contracts-public/deployments/base/Liquidity.json")) {
    return Buffer.from(JSON.stringify({ address: ADDRESSES.fluid, transactionHash: `0x${"a".repeat(64)}` }));
  }
  throw new Error("unexpected fixture path");
}

function ndjson(records) {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function transaction(to, status, input, transactionIndex) {
  return { to, status, input, transactionIndex, from: ADDRESSES.sender, hash: `0x${"b".repeat(64)}` };
}

function record(number, transactions = []) {
  return { header: { number, hash: `0x${"c".repeat(64)}` }, transactions };
}

function fixtureFetch(head, pageBodies, requests = []) {
  let page = 0;
  return async (url, init) => {
    if (url.endsWith("/head")) return new Response(String(head), { status: 200 });
    assert.ok(url.endsWith("/finalized-stream"));
    requests.push(JSON.parse(init.body));
    const body = pageBodies[page];
    page += 1;
    if (body && typeof body === "object" && Object.hasOwn(body, "status")) {
      return new Response(body.body || null, { status: body.status });
    }
    return new Response(body, { status: 200 });
  };
}

function options(fetchFn, extra = {}) {
  return {
    fetchFn,
    readFileFn: manifestReader,
    fluidManifestPaths: [FLUID_PATH],
    fromBlock: 100,
    toBlock: 102,
    ...extra
  };
}

test("filters failed transactions and counts successful selectors for every bound role", async () => {
  const requests = [];
  const fetchFn = fixtureFetch(200, [ndjson([
    record(100, [
      transaction(ADDRESSES.weth, 1, "0x12345678aabb", 0),
      transaction(ADDRESSES.weth, 0, "0xdeadbeef", 1),
      transaction(ADDRESSES.shared, 1, "0x12345678", 2)
    ]),
    record(102, [transaction(ADDRESSES.fluid, 1, "0x", 0)])
  ])], requests);
  const result = await triage.runTriage(options(fetchFn));

  assert.equal(result.status, "COMPLETE");
  assert.equal(result.headersProcessed, 2);
  assert.equal(result.successCounts.find((row) => row.roleLabel === "compound-weth.comet").count, 1);
  assert.equal(result.successCounts.find((row) => row.roleLabel === "compound-weth.configurator").count, 1);
  assert.equal(result.successCounts.find((row) => row.roleLabel === "compound-usdc.configurator").count, 1);
  assert.equal(result.successCounts.find((row) => row.roleLabel === "fluid-liquidity").count, 1);
  assert.equal(requests.length, 1);
  assert.ok(requests[0].transactions[0].to.every((address) => /^0x[0-9a-f]{40}$/u.test(address)));
  assert.equal(requests[0].fields.transaction.hash, undefined);
  assert.equal(requests[0].fields.transaction.from, undefined);
});

test("continues NDJSON pages from the last header plus one", async () => {
  const requests = [];
  const fetchFn = fixtureFetch(200, [
    ndjson([record(100), record(101, [transaction(ADDRESSES.usdc, 1, "0xabcdef01", 0)])]),
    ndjson([record(102)])
  ], requests);
  const result = await triage.runTriage(options(fetchFn));

  assert.equal(result.status, "COMPLETE");
  assert.deepEqual(requests.map((request) => request.fromBlock), [100, 102]);
  assert.deepEqual(requests.map((request) => request.toBlock), [102, 102]);
  assert.equal(result.headersProcessed, 3);
});

test("releases the head response reader before the sequential stream fetch", async () => {
  let headReaderReleased = false;
  let calls = 0;
  const fetchFn = async (url) => {
    calls += 1;
    if (calls === 1) {
      assert.ok(url.endsWith("/head"));
      let sent = false;
      return {
        status: 200,
        headers: { get: () => null },
        body: {
          getReader: () => ({
            read: async () => {
              if (!sent) {
                sent = true;
                return { done: false, value: Buffer.from("200") };
              }
              return { done: true, value: undefined };
            },
            cancel: async () => {},
            releaseLock: () => { headReaderReleased = true; }
          })
        }
      };
    }
    assert.ok(url.endsWith("/finalized-stream"));
    if (!headReaderReleased) throw new TypeError("fixture transport is still occupied by the head response");
    return new Response(ndjson([record(102)]), { status: 200 });
  };

  const result = await triage.runTriage(options(fetchFn));
  assert.equal(result.status, "COMPLETE");
  assert.equal(result.error, null);
  assert.equal(calls, 2);
  assert.equal(headReaderReleased, true);
});

test("default transport preserves healthy sequential head then stream invocation", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const plainResponse = (body) => {
    let sent = false;
    return {
      status: 200,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: async () => {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: Buffer.from(body) };
          },
          cancel: async () => {},
          releaseLock: () => {}
        })
      }
    };
  };
  const injectedGlobalFetch = async (url) => {
    calls += 1;
    if (calls === 1) {
      assert.ok(url.endsWith("/head"));
      return plainResponse("200");
    }
    return plainResponse(ndjson([record(102)]));
  };
  globalThis.fetch = injectedGlobalFetch;
  try {
    const runOptions = options(undefined);
    delete runOptions.fetchFn;
    const result = await triage.runTriage(runOptions);
    assert.equal(result.status, "COMPLETE", result.error);
    assert.equal(result.error, null);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("page, response-byte, and record caps fail closed", async (t) => {
  await t.test("page cap", async () => {
    const fetchFn = fixtureFetch(200, [ndjson([record(100)]), ndjson([record(102)])]);
    const result = await triage.runTriage(options(fetchFn, { maxPages: 1 }));
    assert.equal(result.status, "ERROR");
    assert.equal(result.error, "PAGE_CAP_EXCEEDED");
    assert.ok(result.successCounts.every((row) => row.count === 0));
    assert.ok(result.selectorFrequencies.every((row) => row.frequencies.length === 0));
  });

  await t.test("response-byte cap", async () => {
    const fetchFn = fixtureFetch(200, [ndjson([record(102)])]);
    const result = await triage.runTriage(options(fetchFn, { maxResponseBytes: 8 }));
    assert.equal(result.status, "ERROR");
    assert.equal(result.error, "RESPONSE_BYTES_CAP_EXCEEDED");
    assert.ok(result.successCounts.every((row) => row.count === 0));
  });

  await t.test("record cap after a success", async () => {
    const fetchFn = fixtureFetch(200, [ndjson([
      record(102, [
        transaction(ADDRESSES.weth, 1, "0x12345678", 0),
        transaction(ADDRESSES.fluid, 1, "0xabcdef01", 1)
      ])
    ])]);
    const result = await triage.runTriage(options(fetchFn, { maxRecords: 2 }));
    assert.equal(result.status, "ERROR");
    assert.equal(result.error, "RECORD_CAP_EXCEEDED");
    assert.ok(result.successCounts.every((row) => row.count === 0));
    assert.ok(result.selectorFrequencies.every((row) => row.frequencies.length === 0));
  });
});

test("public result is sanitized and contains no identifiers, endpoint, or calldata", async () => {
  const input = "0xfeedface00112233445566778899";
  const fetchFn = fixtureFetch(102, [ndjson([
    record(102, [transaction(ADDRESSES.fluid, 1, input, 0)])
  ])]);
  const result = await triage.runTriage(options(fetchFn));
  const serialized = JSON.stringify(result);

  assert.equal(result.status, "COMPLETE");
  for (const forbidden of [...Object.values(ADDRESSES), input, input.slice(0, 10), "portal.sqd.dev", "/finalized-stream", "0x" + "b".repeat(64)]) {
    assert.equal(serialized.toLowerCase().includes(forbidden.toLowerCase()), false, `leaked ${forbidden}`);
  }
  assert.doesNotMatch(serialized, /0x[0-9a-f]{8,}/iu);
  assert.match(result.derivedHash, /^derived_[A-Za-z0-9_-]{43}$/u);
});

test("aggregate output and derived hash are deterministic", async () => {
  const body = ndjson([
    record(100, [transaction(ADDRESSES.weth, 1, "0x11112222", 0)]),
    record(102, [transaction(ADDRESSES.weth, 1, "0x33334444", 0)])
  ]);
  const first = await triage.runTriage(options(fixtureFetch(200, [body])));
  const second = await triage.runTriage(options(fixtureFetch(200, [body])));
  assert.deepEqual(second, first);
});

test("HTTP 204 before the pinned end is incomplete and fail closed", async () => {
  const fetchFn = fixtureFetch(200, [{ status: 204 }]);
  const result = await triage.runTriage(options(fetchFn));
  assert.equal(result.status, "ERROR");
  assert.equal(result.error, "FINALIZED_WINDOW_INCOMPLETE");
  assert.ok(result.successCounts.every((row) => row.count === 0));
});
