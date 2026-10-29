"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const r2 = require("./run-base-paper-usdplus-fresh-redemption-r15-r2");

const ROOT = path.resolve(__dirname, "..");
const NOW = 2_000_000;
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const H = byte => `0x${byte.repeat(64)}`;
function pin(number = 100n, byte = "1", timestamp = 1900n) { return { number: number.toString(), hash: H(byte), parentHash: H("2"), stateRoot: H("3"), timestamp: timestamp.toString() }; }
function raw(value) { return { number: `0x${BigInt(value.number).toString(16)}`, hash: value.hash, parentHash: value.parentHash, stateRoot: value.stateRoot, timestamp: `0x${BigInt(value.timestamp).toString(16)}` }; }
function proof(overrides = {}) { return { address: r2.USD_PLUS, nonce: "0x0", balance: "0x0", codeHash: H("4"), storageHash: H("5"), accountProof: ["0x12"], storageProof: [], ...overrides }; }
function candidates(families = ["alpha", "beta"]) { return families.map((family, i) => ({ url: new URL(`https://candidate-${i + 1}.invalid/path`), family })); }
function authority() { return { root: ROOT, immutable: {} }; }

function fixture(options = {}) {
  const rows = options.candidates || candidates(options.families), finalized = options.finalized || rows.map(() => pin(100n)), exact = options.exact || rows.map(() => pin(100n));
  const calls = [], blockCalls = new Map();
  const transport = async (url, body) => {
    const index = rows.findIndex(row => row.url === url || row.url.href === url.href); calls.push({ index, method: body.method, params: body.params });
    let result;
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
  return { rows, calls, transport, now: options.now || (() => NOW) };
}

test("CLI is exact and output is no-overwrite", async () => {
  assert.equal(r2.parseCli(["--run-once"]), true);
  for (const args of [[], ["--run-once", "extra"], ["--dry-run"]]) assert.throws(() => r2.parseCli(args), /EXPLICIT_RUN_ONCE_REQUIRED/);
  await assert.rejects(() => r2.runOnce({ exists: () => true }), /OUTPUT_EXISTS_NO_OVERWRITE/);
});

test("source, R1 artifact, and immutable baselines have exact provenance", () => {
  const p = r2.runnerProvenance();
  assert.equal(p.runnerSha256, hash(fs.readFileSync(require.resolve("./run-base-paper-usdplus-fresh-redemption-r15-r2"))));
  for (const [relative, expected] of Object.entries(r2.BASELINES)) assert.equal(hash(fs.readFileSync(path.join(ROOT, relative))), expected);
  const authority = r2.preflight(); assert.equal(Object.keys(authority.immutable).length, Object.keys(r2.BASELINES).length);
});

test("R1 rejection is explicit and narrow", () => {
  const value = r2.r1Disposition();
  assert.equal(value.runnerDisposition, "DO_NOT_USE_FOR_FORK_OR_FULL_EXIT_EVIDENCE");
  assert.deepEqual(value.canonicalOnlyFor, ["PROCESS_STOPPED_BEFORE_RELAY_ANVIL_MINT_REDEMPTION", "ONE_INVENTORY_READ", "ZERO_RETRIES"]);
  assert.equal(value.rejectedClaims.length, 4); assert.equal(value.rejectionReasons.length, 5);
  assert.equal(value.runnerSha256, r2.BASELINES[value.runner]); assert.equal(value.artifactSha256, r2.BASELINES[value.artifact]);
});

test("real mode reads inventory exactly once and never retries", async () => {
  const f = fixture(), reads = { count: 0 };
  const out = await r2.runOnce({ exists: () => false, preflight: authority(), readCandidates: () => { reads.count++; return f.rows; }, transport: f.transport, now: f.now });
  assert.equal(reads.count, 1); assert.equal(out.inventoryReads, 1); assert.equal(out.retries, 0);
});

test("duplicate endpoint and origin are rejected before requests", async () => {
  const exact = candidates(); exact[1] = { url: new URL(exact[0].url.href), family: "beta" };
  assert.throws(() => r2.validateCandidates(exact), /DUPLICATE_ENDPOINT_OR_ORIGIN/);
  const origin = candidates(); origin[1] = { url: new URL(`${origin[0].url.origin}/other`), family: "beta" };
  assert.throws(() => r2.validateCandidates(origin), /DUPLICATE_ENDPOINT_OR_ORIGIN/);
  let calls = 0; await assert.rejects(() => r2.qualify({ candidates: origin, transport: async () => { calls++; } }), /DUPLICATE_ENDPOINT_OR_ORIGIN/); assert.equal(calls, 0);
});

test("strict proof validator accepts complete proof and rejects malformed shapes", () => {
  assert.equal(r2.validateProof(proof()), true);
  const invalid = [null, {}, proof({ address: "0x0000000000000000000000000000000000000000" }), proof({ nonce: "0x00" }), proof({ balance: "1" }),
    proof({ codeHash: "0x12" }), proof({ storageHash: "0x12" }), proof({ accountProof: [] }), proof({ accountProof: ["0x"] }), proof({ storageProof: null })];
  for (const value of invalid) assert.throws(() => r2.validateProof(value), /PROOF_SHAPE_INVALID/);
});

test("malformed proof prevents that row from qualifying", async () => {
  const f = fixture({ proofs: [proof(), null] });
  await assert.rejects(() => r2.qualify({ candidates: f.rows, transport: f.transport, now: f.now }), error => {
    assert.equal(error.code, "COHERENT_PIN_NOT_OBSERVED_IN_BOUNDED_SAMPLE"); assert.equal(error.context.stats.phaseB.proofValidated, 1);
    assert.equal(error.context.stats.phaseB.failures.PROOF_SHAPE_INVALID, 1); assert.equal(error.context.rows.length, 1); return true;
  });
});

test("separate phase request and response-byte caps enforce actual accounting", async () => {
  const f = fixture(), oversized = async (url, body) => ({ value: { jsonrpc: "2.0", id: body.id, result: "0x2105" }, bytes: r2.CAPS.responseBytes + 1 });
  await assert.rejects(() => r2.qualify({ candidates: f.rows, transport: oversized, now: f.now }), error => {
    assert.equal(error.context.stats.phaseA.calls, 1); assert.equal(error.context.stats.phaseA.bytes, r2.CAPS.responseBytes + 1); assert.equal(error.context.stats.phaseB.calls, 0); return true;
  });
  const budget = r2.createBudget(async (_url, body) => ({ value: { jsonrpc: "2.0", id: body.id, result: "0x1" }, bytes: 1 }), f.now);
  for (let i = 0; i < r2.CAPS.phaseARequests; i++) await budget.call("A", f.rows[0], "x", []);
  await assert.rejects(() => budget.call("A", f.rows[0], "x", []), error => { assert.equal(error.code, "REQUEST_CAP"); assert.equal(error.context.phaseA.calls, r2.CAPS.phaseARequests); return true; });
});

test("successful accounting is exact and all material calls use EIP-1898", async () => {
  const f = fixture(), result = await r2.qualify({ candidates: f.rows, transport: f.transport, now: f.now });
  assert.equal(result.stats.phaseA.calls, 4); assert.equal(result.stats.phaseA.bytes, 400); assert.equal(result.stats.phaseB.calls, 8); assert.equal(result.stats.phaseB.bytes, 800);
  assert.equal(result.stats.aggregate.calls, 12); assert.equal(result.stats.aggregate.bytes, 1200);
  const material = f.calls.filter(row => ["eth_getCode", "eth_getProof"].includes(row.method)); assert.equal(material.length, 4);
  assert.equal(material.every(row => row.params.at(-1).requireCanonical === true && row.params.at(-1).blockHash === pin().hash), true);
});

test("initial outlier does not hide a later two-family coherent group", async () => {
  const rows = candidates(["outlier", "alpha", "beta"]), exact = [pin(100n, "7"), pin(100n, "1"), pin(100n, "1")], f = fixture({ candidates: rows, exact });
  const result = await r2.qualify({ candidates: rows, transport: f.transport, now: f.now });
  assert.equal(result.coherent, true); assert.equal(result.pin.hash, pin().hash); assert.equal(result.selectedFamilyCount, 2); assert.equal(result.maxDistinctLabels, 2);
});

test("same-family and all-different-pin samples fail with the narrow classification", async () => {
  const sameFamily = fixture({ families: ["alpha", "alpha"] });
  await assert.rejects(() => r2.qualify({ candidates: sameFamily.rows, transport: sameFamily.transport, now: sameFamily.now }), error => error.code === "COHERENT_PIN_NOT_OBSERVED_IN_BOUNDED_SAMPLE" && error.context.maxDistinctLabels === 1);
  const different = fixture({ exact: [pin(100n, "1"), pin(100n, "7")] });
  await assert.rejects(() => r2.qualify({ candidates: different.rows, transport: different.transport, now: different.now }), error => error.code === "COHERENT_PIN_NOT_OBSERVED_IN_BOUNDED_SAMPLE" && error.context.maxDistinctLabels === 1);
});

test("common-height resampling closes sequential finalized movement", async () => {
  const f = fixture({ finalized: [pin(102n, "8"), pin(101n, "9")], exact: [pin(101n), pin(101n)] });
  const result = await r2.qualify({ candidates: f.rows, transport: f.transport, now: f.now }); assert.equal(result.commonHeight, "101");
  const sampled = f.calls.filter(row => row.method === "eth_getBlockByNumber" && row.params[0] !== "finalized"); assert.equal(sampled.every(row => row.params[0] === "0x65"), true);
});

test("all-row grouping and selection are independent of first-row order", async () => {
  for (const exact of [[pin(100n, "7"), pin(), pin()], [pin(), pin(100n, "7"), pin()]]) {
    const f = fixture({ candidates: candidates(["a", "b", "c"]), exact }), out = await r2.qualify({ candidates: f.rows, transport: f.transport, now: f.now }); assert.equal(out.pin.hash, pin().hash);
  }
});

test("output aliases and pairability expose neither labels nor endpoint material", async () => {
  const f = fixture({ candidates: candidates(["secret-family-one", "secret-family-two", "secret-family-one"]) }), out = await r2.qualify({ candidates: f.rows, transport: f.transport, now: f.now });
  assert.deepEqual(out.rows.map(row => row.alias), ["F1", "F2", "F1"]); assert.equal(out.matrix.length, 3);
  assert.deepEqual(out.matrix.map(row => row.distinctLabel), [true, false, true]);
  const text = JSON.stringify({ rows: out.rows, matrix: out.matrix }); assert.equal(text.includes("secret-family"), false); assert.equal(r2.sanitized(text), true);
});

test("actual maximum distinct count is retained without a pair", async () => {
  const f = fixture({ families: ["same", "same"] });
  await assert.rejects(() => r2.qualify({ candidates: f.rows, transport: f.transport, now: f.now }), error => { assert.equal(error.context.maxDistinctLabels, 1); return true; });
});

test("terminal recheck detects reorg and freshness expiry", async () => {
  const changed = fixture({ terminal: [pin(100n, "9"), null] });
  await assert.rejects(() => r2.qualify({ candidates: changed.rows, transport: changed.transport, now: changed.now }), error => error.stage === "TERMINAL_RECHECK" && error.code === "TERMINAL_HEADER_CHANGED");
  const expired = fixture({ terminal: [pin(100n, "1", 1n), null], now: () => 4_000_000 });
  await assert.rejects(() => r2.qualify({ candidates: expired.rows, transport: expired.transport, now: expired.now }), error => error.stage === "TERMINAL_RECHECK" && error.code === "FINALIZED_HEADER_STALE");
});

test("qualification-only source has no fork execution or mutation API", () => {
  const source = fs.readFileSync(require.resolve("./run-base-paper-usdplus-fresh-redemption-r15-r2"), "utf8");
  for (const token of ["node:child_process", "createServer(", "executeFork", "impersonateAccount", "setBalance", "eth_sendTransaction", "eth_sendRawTransaction"]) assert.equal(source.includes(token), false, token);
  for (const key of ["executeFork", "redeem", "mint", "spawn", "createRelay"]) assert.equal(Object.hasOwn(r2, key), false);
});

test("coherent result remains review-required and cannot promote semantics", async () => {
  const f = fixture(), output = await r2.runOnce({ exists: () => false, preflight: authority(), candidates: f.rows, transport: f.transport, now: f.now });
  assert.equal(output.classification, "FRESH_COHERENT_PIN_CANDIDATE_OBSERVED / PREFORK_BINDING_NOT_RUN"); assert.equal(output.preForkGates, null); assert.equal(output.notRunReason, "R2_QUALIFICATION_ONLY");
  assert.equal(output.fullExitVerified, false); assert.deepEqual(output.localSemantic, { status: "UNKNOWN", result: "inconclusive" }); assert.equal(output.reproducibility, "UNKNOWN");
  assert.equal(output.quoteEligible, false); assert.equal(output.routePositive, "unknown"); assert.equal(output.executableNow, "unknown"); assert.equal(r2.assertClosed(output), true);
  let exitCode, writes = 0; await r2.runCli(["--run-once"], { options: { exists: () => false, preflight: authority(), candidates: f.rows, transport: f.transport, now: f.now }, writeOutput: () => { writes++; }, stdout: () => {}, stderr: () => {}, setExitCode: code => { exitCode = code; } });
  assert.equal(exitCode, 3); assert.equal(writes, 1);
});

test("incomplete result is non-success with narrow terminal classification", async () => {
  const f = fixture({ families: ["same", "same"] }); let exitCode, captured;
  captured = await r2.runCli(["--run-once"], { options: { exists: () => false, preflight: authority(), candidates: f.rows, transport: f.transport, now: f.now }, writeOutput: () => {}, stdout: () => {}, stderr: () => {}, setExitCode: code => { exitCode = code; } });
  assert.equal(exitCode, 2); assert.equal(captured.classification, "INCOMPLETE / QUALIFICATION / COHERENT_PIN_NOT_OBSERVED_IN_BOUNDED_SAMPLE"); assert.equal(captured.selectedFamilyCount, 0);
});

test("checked-in R2 artifact, when present, has bound provenance and terminal fields", () => {
  if (!fs.existsSync(r2.OUTPUT_FILE)) { assert.equal(path.basename(r2.OUTPUT_FILE), "fresh-redemption-r2.json"); return; }
  const artifact = JSON.parse(fs.readFileSync(r2.OUTPUT_FILE, "utf8")); assert.equal(artifact.schema, r2.SCHEMA);
  assert.equal(artifact.provenance.runnerSha256, hash(fs.readFileSync(require.resolve("./run-base-paper-usdplus-fresh-redemption-r15-r2")))); assert.ok(artifact.generatedAt); assert.ok(artifact.completedAt);
  assert.equal(artifact.preForkGates, null); assert.equal(artifact.notRunReason, "R2_QUALIFICATION_ONLY"); assert.equal(artifact.fullExitVerified, false); assert.equal(artifact.quoteEligible, false);
  assert.equal(r2.sanitized(artifact), true); r2.assertClosed(artifact);
});
