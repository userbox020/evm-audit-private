"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const r2 = require("./run-base-paper-usdplus-fresh-redemption-r15-r2");
const r3 = require("./run-base-paper-usdplus-fresh-redemption-r15-r3");

const ROOT = path.resolve(__dirname, "..");
const NOW = 2_000_000;
const H = byte => `0x${byte.repeat(64)}`;
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function entry(index, family, overrides = {}) { return { url: `https://host-${index}.invalid/base`, family, capabilityRank: 1, ordinal: index, baseSuitability: 0, ...overrides }; }
function pin(number = 100n, byte = "1", timestamp = 1900n) { return { number: number.toString(), hash: H(byte), parentHash: H("2"), stateRoot: H("3"), timestamp: timestamp.toString() }; }
function raw(value) { return { number: `0x${BigInt(value.number).toString(16)}`, hash: value.hash, parentHash: value.parentHash, stateRoot: value.stateRoot, timestamp: `0x${BigInt(value.timestamp).toString(16)}` }; }
function proof(overrides = {}) { return { address: r2.USD_PLUS, nonce: "0x0", balance: "0x0", codeHash: H("4"), storageHash: H("5"), accountProof: ["0x12"], storageProof: [], ...overrides }; }
function authority() { return { root: ROOT, immutable: {} }; }
function fixture(options = {}) {
  const entries = options.entries || [entry(1, "alpha"), entry(2, "beta")], finalized = options.finalized || entries.map(() => pin()), exact = options.exact || entries.map(() => pin());
  const calls = [], blockCalls = new Map();
  const transport = async (url, body) => {
    const index = entries.findIndex(row => new URL(row.url).href === url.href); calls.push({ index, method: body.method, params: body.params }); let result;
    if (body.method === "eth_chainId") result = options.chain?.[index] || "0x2105";
    else if (body.method === "eth_getCode") result = options.code?.[index] ?? "0x6000";
    else if (body.method === "eth_getProof") result = options.proofs && Object.hasOwn(options.proofs, index) ? options.proofs[index] : proof();
    else if (body.method === "eth_getBlockByNumber") {
      const count = blockCalls.get(index) || 0; blockCalls.set(index, count + 1);
      if (body.params[0] === "finalized") result = raw(finalized[index]);
      else if (count >= 2 && options.terminal?.[index]) result = raw(options.terminal[index]);
      else result = raw(exact[index]);
    } else throw new Error("unexpected method");
    return { value: { jsonrpc: "2.0", id: body.id, result }, bytes: options.bytes || 100 };
  };
  return { entries, calls, transport, now: options.now || (() => NOW) };
}

test("CLI requires exactly --once and output is no-overwrite", async () => {
  assert.equal(r3.parseCli(["--once"]), true);
  for (const args of [[], ["--run-once"], ["--once", "again"]]) assert.throws(() => r3.parseCli(args), /EXPLICIT_ONCE_REQUIRED/);
  await assert.rejects(() => r3.runOnce({ exists: () => true }), /OUTPUT_EXISTS_NO_OVERWRITE/);
});

test("canonical-equivalent exact URLs collapse by href", () => {
  const rows = [entry(0, "alpha", { url: "https://EXAMPLE.com:443/a" }), entry(1, "discarded", { url: "https://example.com/a" }), entry(2, "beta")];
  const out = r3.selectCandidates(rows, { strictMetadata: true }); assert.equal(out.counts.duplicateHrefCount, 1); assert.equal(out.counts.duplicateOriginCount, 0); assert.equal(out.counts.retainedCount, 2);
});

test("different paths and queries under one origin collapse", () => {
  const rows = [entry(0, "alpha", { url: "https://same.invalid/one?q=1" }), entry(1, "discarded", { url: "https://same.invalid/two?q=2" }), entry(2, "beta")];
  const out = r3.selectCandidates(rows, { strictMetadata: true }); assert.equal(out.counts.duplicateOriginCount, 1); assert.equal(out.counts.retainedCount, 2);
});

test("duplicate identity with another label contributes only the retained label", () => {
  const rows = [entry(0, "discarded", { url: "https://same.invalid/a", capabilityRank: 2 }), entry(1, "retained", { url: "https://same.invalid/a", capabilityRank: 0 }), entry(2, "retained")];
  assert.throws(() => r3.selectCandidates(rows, { strictMetadata: true }), error => error.code === "INSUFFICIENT_DISTINCT_OPAQUE_FAMILY_LABELS_AFTER_DEDUPLICATION" && error.context.selection.distinctRetainedFamilyCount === 1);
});

test("capability rank wins and original ordinal breaks ties", () => {
  const rows = [entry(5, "c", { capabilityRank: 2, ordinal: 0 }), entry(4, "b", { capabilityRank: 0, ordinal: 9 }), entry(3, "a", { capabilityRank: 0, ordinal: 2 })];
  const out = r3.selectCandidates(rows, { strictMetadata: true }); assert.deepEqual(out.candidates.map(row => row.family), ["a", "b", "c"]);
});

test("duplicates consume neither per-family quota nor final cap", () => {
  const rows = [entry(0, "a", { url: "https://dup.invalid/x" }), entry(1, "z", { url: "https://dup.invalid/x" }), entry(2, "a"), entry(3, "a"),
    entry(4, "b"), entry(5, "c"), entry(6, "d"), entry(7, "e"), entry(8, "f"), entry(9, "g")];
  const out = r3.selectCandidates(rows, { strictMetadata: true }); assert.equal(out.counts.duplicateHrefCount, 1); assert.equal(out.counts.familyQuotaDiscardedCount, 1);
  assert.equal(out.candidates.length, 8); assert.equal(out.counts.finalCapDiscardedCount, 0); assert.equal(out.candidates.filter(row => row.family === "a").length, 2);
});

test("candidate errors have deterministic precedence", () => {
  assert.throws(() => r3.selectCandidates([], { strictMetadata: true }), error => error.code === "CANDIDATE_POOL_INVALID");
  assert.throws(() => r3.selectCandidates([{ url: "bad", family: "a", capabilityRank: 1 }], { strictMetadata: true }), error => error.code === "CANDIDATE_URL_INVALID");
  assert.throws(() => r3.selectCandidates([{ url: "https://one.invalid", family: "", capabilityRank: 1 }], { strictMetadata: true }), error => error.code === "CANDIDATE_FAMILY_INVALID");
});

test("one endpoint stops before transport with zero phase accounting", async () => {
  let calls = 0; const out = await r3.runOnce({ exists: () => false, preflight: authority(), entries: [entry(1, "a")], transport: async () => { calls++; } });
  assert.equal(out.classification, "INCOMPLETE / CANDIDATES / INSUFFICIENT_UNIQUE_ENDPOINTS_AFTER_DEDUPLICATION"); assert.equal(calls, 0); assert.equal(out.qualification.aggregate.calls, 0); assert.equal(out.qualification.aggregate.bytes, 0);
});

test("multiple endpoints from one family stop before transport", async () => {
  let calls = 0; const out = await r3.runOnce({ exists: () => false, preflight: authority(), entries: [entry(1, "a"), entry(2, "a")], transport: async () => { calls++; } });
  assert.equal(out.firstFailure.code, "INSUFFICIENT_DISTINCT_OPAQUE_FAMILY_LABELS_AFTER_DEDUPLICATION"); assert.equal(calls, 0); assert.equal(out.qualification.phaseA.calls, 0);
});

test("two distinct endpoints and labels enter qualification", async () => {
  const f = fixture(), out = await r3.runOnce({ exists: () => false, preflight: authority(), entries: f.entries, transport: f.transport, now: f.now });
  assert.equal(out.coherentPinCandidateObserved, true); assert.equal(out.qualification.phaseA.calls, 4); assert.equal(out.qualification.phaseB.calls, 8); assert.equal(out.selectedFamilyCount, 2);
  assert.equal(out.pairabilityMatrix[0].distinctEndpoint, true); assert.equal(out.pairabilityMatrix[0].distinctOrigin, true);
});

test("selection is capped at eight after dedupe and inventory is read once with zero retries", async () => {
  const entries = Array.from({ length: 10 }, (_, i) => entry(i, `f${i}`)), f = fixture({ entries }); let reads = 0;
  const out = await r3.runOnce({ exists: () => false, preflight: authority(), readInventory: () => { reads++; return entries; }, transport: f.transport, now: f.now });
  assert.equal(reads, 1); assert.equal(out.inventoryReads, 1); assert.equal(out.retries, 0); assert.equal(out.selection.retainedCount, 8); assert.equal(out.selection.finalCapDiscardedCount, 2);
});

test("aggregate selection counts reconcile without identities labels or hashes", () => {
  const rows = [entry(0, "a", { url: "https://dup.invalid/a" }), entry(1, "b", { url: "https://dup.invalid/a" }), entry(2, "a"), entry(3, "c")];
  const counts = r3.selectCandidates(rows, { strictMetadata: true }).counts, text = JSON.stringify(counts);
  assert.equal(counts.parsedCount, counts.eligibleCount + counts.securityFilteredCount); assert.equal(counts.eligibleCount, counts.deduplicatedCount + counts.duplicateHrefCount + counts.duplicateOriginCount);
  assert.equal(counts.deduplicatedCount, counts.postQuotaCount + counts.familyQuotaDiscardedCount); assert.equal(counts.postQuotaCount, counts.retainedCount + counts.finalCapDiscardedCount);
  assert.equal(/https?:|invalid|\b(?:alpha|beta)\b|0x[0-9a-f]{64}/i.test(text), false);
});

test("common-height resampling, all-row grouping, EIP-1898, and accounting are inherited", async () => {
  const entries = [entry(0, "outlier"), entry(1, "alpha"), entry(2, "beta")], f = fixture({ entries, finalized: [pin(102n, "8"), pin(101n, "9"), pin(101n, "9")], exact: [pin(101n, "7"), pin(101n), pin(101n)] });
  const out = await r3.runOnce({ exists: () => false, preflight: authority(), entries, transport: f.transport, now: f.now });
  assert.equal(out.coherentPinCandidateObserved, true); assert.equal(out.commonHeight, "101"); assert.equal(out.maxDistinctLabelsInBestExactPinGroup, 2);
  assert.equal(out.qualification.phaseA.calls, 6); assert.equal(out.qualification.phaseB.calls, 11); assert.equal(out.qualification.aggregate.calls, 17); assert.equal(out.qualification.aggregate.bytes, 1700);
  const material = f.calls.filter(row => ["eth_getCode", "eth_getProof"].includes(row.method)); assert.equal(material.every(row => row.params.at(-1).requireCanonical === true), true);
});

test("strict proof failure and same-pin miss remain bounded-sample qualification outcomes", async () => {
  const malformed = fixture({ proofs: [proof(), null] }), a = await r3.runOnce({ exists: () => false, preflight: authority(), entries: malformed.entries, transport: malformed.transport, now: malformed.now });
  assert.equal(a.classification, "INCOMPLETE / QUALIFICATION / COHERENT_PIN_NOT_OBSERVED_IN_BOUNDED_SAMPLE"); assert.equal(a.qualification.phaseB.failures.PROOF_SHAPE_INVALID, 1);
  const different = fixture({ exact: [pin(100n, "1"), pin(100n, "7")] }), b = await r3.runOnce({ exists: () => false, preflight: authority(), entries: different.entries, transport: different.transport, now: different.now });
  assert.equal(b.firstFailure.code, "COHERENT_PIN_NOT_OBSERVED_IN_BOUNDED_SAMPLE");
});

test("terminal recheck detects change and preserves actual accounting", async () => {
  const f = fixture({ terminal: [pin(100n, "9"), null] }), out = await r3.runOnce({ exists: () => false, preflight: authority(), entries: f.entries, transport: f.transport, now: f.now });
  assert.equal(out.firstFailure.stage, "TERMINAL_RECHECK"); assert.equal(out.firstFailure.code, "TERMINAL_HEADER_CHANGED"); assert.equal(out.qualification.phaseB.failures.TERMINAL_HEADER_CHANGED, 1);
});

test("injected transport cannot promote fork full-exit or PASS fields", async () => {
  const f = fixture(), out = await r3.runOnce({ exists: () => false, preflight: authority(), entries: f.entries, transport: f.transport, now: f.now });
  assert.equal(out.classification, "FRESH_COHERENT_PIN_CANDIDATE_OBSERVED / PREFORK_BINDING_NOT_RUN"); assert.equal(out.preForkGates, null); assert.equal(out.fullExitVerified, false);
  assert.equal(out.localSemantic.status, "UNKNOWN"); assert.equal(out.reproducibility, "UNKNOWN"); assert.equal(out.quoteEligible, false); assert.equal(out.routePositive, "unknown"); assert.equal(out.executableNow, "unknown");
  assert.equal(JSON.stringify(out).includes('"PASS"'), false); assert.equal(r3.assertClosed(out), true);
});

test("R3 source contains no relay fork mutation or executor path", () => {
  const source = fs.readFileSync(require.resolve("./run-base-paper-usdplus-fresh-redemption-r15-r3"), "utf8");
  for (const token of ["node:child_process", "createServer(", "executeFork", "impersonateAccount", "setBalance", "eth_sendTransaction", "eth_sendRawTransaction"]) assert.equal(source.includes(token), false, token);
  for (const key of ["executeFork", "redeem", "mint", "spawn", "createRelay"]) assert.equal(Object.hasOwn(r3, key), false);
});

test("exact R1 and R2 hashes and narrow dispositions are bound", () => {
  assert.equal(Object.keys(r3.PREDECESSORS).length, 4); for (const [relative, expected] of Object.entries(r3.PREDECESSORS)) assert.equal(hash(fs.readFileSync(path.join(ROOT, relative))), expected);
  const bound = r3.preflight(), dispositions = r3.supersession(); assert.equal(Object.keys(bound.immutable).length, 4); assert.equal(dispositions.r1.coherentPinAvailabilitySupported, false);
  assert.equal(dispositions.r2.coherentPinAvailabilitySupported, false); assert.ok(dispositions.r2.canonicalOnlyFor.includes("ZERO_RPC_CALLS_AND_BYTES"));
});

test("correction semantics, source provenance, sanitizer, and review-required exit are closed", async () => {
  const f = fixture(), base = r3.baseOutput(); assert.equal(base.correctionType, "CHANGED_SELECTION_RULE_EFFECTIVE_INPUT_CORRECTION"); assert.equal(base.finalOneShotUnderThisRule, true);
  assert.equal(base.unchangedLaterRetryJustified, false); assert.equal(base.conclusionScope, "BOUNDED_SELECTED_SAMPLE_ONLY"); assert.equal(r3.provenance().runnerSha256, hash(fs.readFileSync(require.resolve("./run-base-paper-usdplus-fresh-redemption-r15-r3"))));
  assert.equal(r3.sanitized("https://secret.invalid"), false); let exitCode, writes = 0;
  await r3.runCli(["--once"], { options: { exists: () => false, preflight: authority(), entries: f.entries, transport: f.transport, now: f.now }, writeOutput: () => { writes++; }, stdout: () => {}, stderr: () => {}, setExitCode: code => { exitCode = code; } });
  assert.equal(exitCode, 3); assert.equal(writes, 1);
});

test("checked-in R3 artifact, when present, is source-bound and terminal", () => {
  if (!fs.existsSync(r3.OUTPUT_FILE)) { assert.equal(path.basename(r3.OUTPUT_FILE), "fresh-redemption-r3.json"); return; }
  const artifact = JSON.parse(fs.readFileSync(r3.OUTPUT_FILE, "utf8")); assert.equal(artifact.schema, r3.SCHEMA); assert.equal(artifact.provenance.runnerSha256, hash(fs.readFileSync(require.resolve("./run-base-paper-usdplus-fresh-redemption-r15-r3"))));
  assert.ok(artifact.generatedAt); assert.ok(artifact.completedAt); assert.equal(artifact.retries, 0); assert.equal(artifact.preForkGates, null); assert.equal(artifact.fullExitVerified, false); assert.equal(r3.sanitized(artifact), true); r3.assertClosed(artifact);
});
