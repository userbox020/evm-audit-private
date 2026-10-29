#!/usr/bin/env node
"use strict";

const assert = require("assert");
const runner = require("./run-critical-across-hyperevm-cctp-build-recovery-step5.js");

function varint(value) {
  let n = BigInt(value), bytes = [];
  do { let byte = Number(n & 0x7fn); n >>= 7n; if (n) byte |= 0x80; bytes.push(byte); } while (n);
  return Buffer.from(bytes);
}
const key = (number, wire) => varint(number * 8 + wire);
const vfield = (number, value) => Buffer.concat([key(number, 0), varint(value)]);
const bfield = (number, value) => { const body = Buffer.from(value); return Buffer.concat([key(number, 2), varint(body.length), body]); };

function unixFs(inline = Buffer.alloc(0), fileSize = inline.length) {
  return Buffer.concat([vfield(1, 2), ...(inline.length ? [bfield(2, inline)] : []), vfield(3, fileSize)]);
}
function dagPb(inline = Buffer.alloc(0), links = []) {
  const encodedLinks = links.map((link) => {
    const pbLink = Buffer.concat([bfield(1, link.cidBytes), ...(link.name ? [bfield(2, Buffer.from(link.name))] : []), vfield(3, link.totalSize || 0)]);
    return bfield(2, pbLink);
  });
  return Buffer.concat([bfield(1, unixFs(inline, inline.length + links.reduce((sum, link) => sum + (link.totalSize || 0), 0))), ...encodedLinks]);
}

function stream(chunks, delay = 0) {
  return { async *[Symbol.asyncIterator]() { for (const chunk of chunks) { if (delay) await new Promise((resolve) => setTimeout(resolve, delay)); yield Buffer.from(chunk); } } };
}
function response(status, chunks = [], contentType = "application/vnd.ipld.raw", extra = {}) {
  const headers = new Map([["content-type", contentType], ...(extra.contentLength == null ? [] : [["content-length", String(extra.contentLength)]])]);
  return { status, ok: status >= 200 && status < 300, redirected: Boolean(extra.redirected), headers: { get: (name) => headers.get(String(name).toLowerCase()) || null }, body: stream(chunks, extra.delay || 0) };
}
function expectStop(code, fn) {
  return Promise.resolve().then(fn).then(() => { throw new Error(`expected:${code}`); }, (error) => { assert(error instanceof runner.RetrievalStop, `not-retrieval-stop:${error}`); assert.strictEqual(error.code, code); return error; });
}

const NOW = Date.parse("2026-07-25T01:30:00.000Z");
const BINDING = Object.freeze({ proposalRunId: "mock-step5-run", packageManifestAggregateSha256: "a".repeat(64), runnerSha256: "b".repeat(64), cid: runner.ACTIVE_CID, digestSha256: runner.ACTIVE_DIGEST });
function approval(overrides = {}) {
  return { schemaVersion: 1, decision: "APPROVED_FOR_MOCK_FIXTURE_ONLY", decisionTimestamp: new Date(NOW - 60_000).toISOString(), executionId: "c".repeat(64), exactlyOneExecution: true, ...BINDING, ...overrides };
}
function packageVerifier(options) {
  const approved = runner.validateApproval(options.approval, BINDING, options.now, "mock");
  return { manifest: { runId: BINDING.proposalRunId }, binding: BINDING, approved };
}
function mockRun(block, fetchImpl, overrides = {}) {
  return runner.runRetrieval({ mode: "mock", approval: approval(), now: NOW, packageVerifier, guard: overrides.guard || new runner.MemoryExecutionGuard(), fetchImpl, expectedDigest: runner.sha(block), persist: false, timeoutMs: overrides.timeoutMs || 100, maxBytes: overrides.maxBytes || runner.POLICY.maxResponseBytes });
}

async function runFixtures() {
  const rows = [];
  async function fixture(id, fn) { await fn(); rows.push({ id, passed: true }); }

  const inline = Buffer.from('{"compiler":{"version":"0.8.23"},"language":"Solidity"}', "utf8");
  const validBlock = dagPb(inline);
  await fixture("valid-raw-block", async () => {
    let calls = 0, observed;
    const result = await mockRun(validBlock, async (url, options) => { calls++; observed = { url, options }; return response(200, [validBlock.subarray(0, 7), validBlock.subarray(7)]); });
    assert.strictEqual(calls, 1); assert.strictEqual(observed.options.method, "GET"); assert.strictEqual(observed.options.redirect, "manual");
    assert.strictEqual(result.digestSha256, runner.sha(validBlock)); assert.strictEqual(result.decoded.unixFs.inlineMetadataBytesExist, true); assert.strictEqual(result.decoded.unixFs.inlineMetadataBytes, inline.length); assert.strictEqual(result.decoded.linkCount, 0);
  });

  await fixture("wrong-hash", async () => {
    let calls = 0;
    await expectStop("RAW_BLOCK_HASH_MISMATCH", () => runner.runRetrieval({ mode: "mock", approval: approval(), now: NOW, packageVerifier, guard: new runner.MemoryExecutionGuard(), fetchImpl: async () => { calls++; return response(200, [validBlock]); }, expectedDigest: "d".repeat(64), persist: false, timeoutMs: 100 }));
    assert.strictEqual(calls, 1);
  });

  await fixture("redirect-rejected", async () => {
    let calls = 0;
    await expectStop("HTTP_REDIRECT_REJECTED", () => mockRun(validBlock, async (_url, options) => { calls++; assert.strictEqual(options.redirect, "manual"); return response(302, [], "application/vnd.ipld.raw"); }));
    assert.strictEqual(calls, 1);
  });

  await fixture("oversize-stream", async () => {
    let calls = 0;
    await expectStop("RESPONSE_SIZE_CAP_EXCEEDED", () => mockRun(validBlock, async () => { calls++; return response(200, [Buffer.alloc(9), Buffer.alloc(8)]); }, { maxBytes: 16 }));
    assert.strictEqual(calls, 1);
  });

  await fixture("timeout", async () => {
    let calls = 0;
    const fetchImpl = (_url, options) => new Promise((_resolve, reject) => { calls++; options.signal.addEventListener("abort", () => { const error = new Error("aborted"); error.name = "AbortError"; reject(error); }, { once: true }); });
    await expectStop("REQUEST_TIMEOUT", () => mockRun(validBlock, fetchImpl, { timeoutMs: 15 }));
    assert.strictEqual(calls, 1);
  });

  await fixture("malformed-dag-pb", async () => {
    const malformed = Buffer.from([0x0a, 0x02, 0xff]);
    await expectStop("PROTOBUF_LENGTH_INVALID", () => mockRun(malformed, async () => response(200, [malformed])));
  });

  await fixture("raw-json-not-dag", async () => {
    const json = Buffer.from('{"language":"Solidity"}', "utf8");
    await expectStop("PROTOBUF_SCHEMA_INVALID", () => mockRun(json, async () => response(200, [json], "application/octet-stream")));
  });

  const linkCid = Buffer.from(`01701220${"11".repeat(32)}`, "hex");
  const linkedBlock = dagPb(Buffer.alloc(0), [{ cidBytes: linkCid, name: "metadata.json", totalSize: 1234 }]);
  let linkedResult;
  await fixture("linked-unixfs-no-follow", async () => {
    let calls = 0;
    linkedResult = await mockRun(linkedBlock, async () => { calls++; return response(200, [linkedBlock]); });
    assert.strictEqual(calls, 1); assert.strictEqual(linkedResult.requestCount, 1); assert.strictEqual(linkedResult.decoded.linkCount, 1); assert.strictEqual(linkedResult.decoded.linksFollowed, 0); assert.strictEqual(linkedResult.linksFetched, 0); assert.strictEqual(linkedResult.decoded.linkCidCommitments[0].cidCommitmentSha256, runner.sha(linkCid));
  });

  await fixture("second-request-prevention", async () => {
    let calls = 0; const guard = new runner.MemoryExecutionGuard();
    await mockRun(validBlock, async () => { calls++; return response(200, [validBlock]); }, { guard });
    await expectStop("EXECUTION_ALREADY_CONSUMED", () => mockRun(validBlock, async () => { calls++; return response(200, [validBlock]); }, { guard }));
    assert.strictEqual(calls, 1);
    const transport = runner.createSingleRequestTransport(async () => response(200, [])); await transport.request("mock", {}); await expectStop("SECOND_REQUEST_PREVENTED", () => transport.request("mock", {}));
  });

  await fixture("stale-approval", async () => {
    assert.throws(() => runner.validateApproval(approval({ decisionTimestamp: new Date(NOW - runner.POLICY.approvalStartWindowMs - 1).toISOString() }), BINDING, NOW, "mock"), (error) => error.code === "APPROVAL_START_WINDOW_INVALID");
  });

  await fixture("wrong-approval-binding", async () => {
    assert.throws(() => runner.validateApproval(approval({ runnerSha256: "e".repeat(64) }), BINDING, NOW, "mock"), (error) => error.code === "APPROVAL_BINDING_MISMATCH");
  });

  await fixture("prerequisite-before-transport", async () => {
    let calls = 0;
    await expectStop("PACKAGE_PREREQUISITE_REJECTED", () => runner.runRetrieval({ mode: "mock", approval: approval(), now: NOW, packageVerifier: () => { throw new runner.RetrievalStop("PACKAGE_PREREQUISITE_REJECTED"); }, guard: new runner.MemoryExecutionGuard(), fetchImpl: async () => { calls++; return response(200, [validBlock]); }, expectedDigest: runner.sha(validBlock), persist: false }));
    assert.strictEqual(calls, 0);
  });

  await fixture("output-leak", async () => {
    const output = JSON.stringify(linkedResult);
    assert(!/https?:\/\//i.test(output)); assert(!/format=raw/i.test(output)); assert(!/authorization|x-api-key|set-cookie/i.test(output)); assert(!output.includes(inline.toString("utf8"))); assert(!output.includes(linkCid.toString("hex"))); assert.strictEqual(linkedResult.gatewayQueryPersisted, false); assert.strictEqual(linkedResult.responseHeadersPersisted, false);
  });

  return runner.canonical({ schemaVersion: 1, passed: true, fixtureCount: rows.length, fixturesPassed: rows.length, fixtures: rows, controls: { exactRequests: 1, maxResponseBytes: runner.POLICY.maxResponseBytes, requestTimeoutMs: runner.POLICY.requestTimeoutMs, retries: runner.POLICY.retries, redirectMode: runner.POLICY.redirects, approvalStartWindowMs: runner.POLICY.approvalStartWindowMs, linksFollowed: 0 }, networkRequests: 0, publicRetrievalExecuted: false });
}

module.exports = { varint, vfield, bfield, unixFs, dagPb, stream, response, approval, packageVerifier, runFixtures };
if (require.main === module) runFixtures().then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => { process.stderr.write(`${JSON.stringify({ ok: false, category: String(error.code || error.message || error) })}\n`); process.exit(1); });
