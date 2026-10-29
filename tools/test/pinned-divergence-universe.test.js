"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadPinnedDivergenceUniverse } = require("../lib/pinned-divergence-universe.js");

const ROOT = path.resolve(__dirname, "../..");
const BASELINE = "reports/raw/fast/all-sentinels-coverage-20260926/coverage-r3.json";
const SOURCE = "reports/raw/fast/exploit-rearm-canary/status-divergence.json";
const SOURCE_CONSTANT = "reports/raw/fast/w9-strike-routes-20260922/drain-route-spec.json";
const BASELINE_HASH = "9bd9ddb6a622c3dbfdea0f90e5491374f2473888b1e1d24ef3180d0bf1b9886a";
const SOURCE_HASH = "ed62283d99d674f61d445c49a3cda4bfb021cb7fb684b900299cd7d738bf549a";
const SOURCE_CONSTANT_HASH = "d8e47e5034747b901007f6d47c5a07b431fb99a8fb2f73af70466575aa6fa5bd";
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pinned-divergence-offline-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const relative of [BASELINE, SOURCE, SOURCE_CONSTANT]) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(ROOT, relative), target);
  }
  return root;
}

function edit(root, relative, transform) {
  const target = path.join(root, relative);
  const json = JSON.parse(fs.readFileSync(target, "utf8"));
  transform(json);
  fs.writeFileSync(target, JSON.stringify(json));
}

function repinned(root) {
  return loadPinnedDivergenceUniverse({ root, testPins: {
    baseline: sha256(fs.readFileSync(path.join(root, BASELINE))),
    source: sha256(fs.readFileSync(path.join(root, SOURCE))),
    sourceConstant: sha256(fs.readFileSync(path.join(root, SOURCE_CONSTANT))),
  } });
}

function rejectsCode(fn, code) {
  assert.throws(fn, (error) => error.code === code && error.message === code && !/0x[0-9a-f]{8}/i.test(error.message));
}

test("fixed historical pins give exactly 351 deterministically ordered observational identities", () => {
  const result = loadPinnedDivergenceUniverse();
  assert.equal(result.sha256, SOURCE_HASH);
  assert.equal(result.sourceConstantSha256, SOURCE_CONSTANT_HASH);
  assert.equal(result.rows.length, 351);
  assert.equal(sha256(fs.readFileSync(path.join(ROOT, BASELINE))), BASELINE_HASH);
  assert.equal(sha256(fs.readFileSync(path.join(ROOT, SOURCE))), SOURCE_HASH);
  assert.equal(sha256(fs.readFileSync(path.join(ROOT, SOURCE_CONSTANT))), SOURCE_CONSTANT_HASH);
  assert.deepEqual(result, loadPinnedDivergenceUniverse());
  assert.deepEqual(result.rows.map((r) => r.id).sort(), JSON.parse(fs.readFileSync(path.join(ROOT, BASELINE), "utf8"))
    .records.filter((r) => r.source === "divergence").map((r) => r.id).sort());
  assert.ok(result.rows.some((r) => r.collateralToken === null && r.loanToken === null));
  assert.equal(result.rows.filter((r) => r.provenanceConstant).length, 238);
  assert.ok(result.rows.every((r) => r.provenanceConstant === (r.kind === "constant-oracle" && r.chainId === 8453)));
  const group = JSON.parse(fs.readFileSync(path.join(ROOT, SOURCE_CONSTANT), "utf8"))
    .groups.find((item) => item.class === "stub-constant-price-oracle");
  assert.equal(group.rows.length, 238);
  const indexed = new Map(result.rows.map((r) => [`${r.chainId}:${r.oracle.toLowerCase()}`, r]));
  for (const item of group.rows) {
    const row = indexed.get(`${group.chainId}:${item.oracle.toLowerCase()}`);
    assert.equal(row.provenanceConstant, true);
    assert.equal(row.pair, item.pair);
    if (item.marketId !== null) assert.equal(row.marketId, item.marketId);
  }
  for (const [index, row] of result.rows.entries()) {
    assert.deepEqual(Object.keys(row), ["id", "chainId", "sentinel", "oracle", "marketId", "pair", "kind", "collateralToken", "loanToken", "provenanceConstant"]);
    assert.equal(row.id, row.sentinel);
    assert.equal(row.sentinel, `div:${row.chainId}:${row.oracle.slice(2, 10)}`);
    assert.match(row.oracle, /^0x[0-9a-f]{40}$/i);
    assert.match(row.marketId, /^0x[0-9a-f]{64}$/i);
    assert.equal(row.collateralToken === null, row.loanToken === null);
    if (index) assert.ok(result.rows[index - 1].chainId < row.chainId ||
      (result.rows[index - 1].chainId === row.chainId && result.rows[index - 1].oracle.toLowerCase() < row.oracle.toLowerCase()));
  }
});

test("copied original pins pass; changed bytes fail before parsing", (t) => {
  const root = fixture(t);
  assert.equal(loadPinnedDivergenceUniverse({ root }).rows.length, 351);
  fs.appendFileSync(path.join(root, SOURCE), "not-json");
  rejectsCode(() => loadPinnedDivergenceUniverse({ root }), "PINNED_HASH_MISMATCH");
});

test("changed W9 bytes fail the fixed digest before JSON parsing", (t) => {
  const root = fixture(t);
  fs.appendFileSync(path.join(root, SOURCE_CONSTANT), "not-json");
  rejectsCode(() => loadPinnedDivergenceUniverse({ root }), "PINNED_HASH_MISMATCH");
});

test("W9 duplicate, omitted, and unknown full oracle identities fail closed", (t) => {
  const root = fixture(t);
  const mutate = (fn) => edit(root, SOURCE_CONSTANT, (json) => fn(json.groups.find((g) => g.class === "stub-constant-price-oracle").rows));
  mutate((rows) => { rows[1] = { ...rows[0] }; });
  rejectsCode(() => repinned(root), "PINNED_CONSTANT_DUPLICATE");
  fs.copyFileSync(path.join(ROOT, SOURCE_CONSTANT), path.join(root, SOURCE_CONSTANT));
  mutate((rows) => { rows.pop(); });
  rejectsCode(() => repinned(root), "PINNED_CONSTANT_SHAPE_INVALID");
  fs.copyFileSync(path.join(ROOT, SOURCE_CONSTANT), path.join(root, SOURCE_CONSTANT));
  mutate((rows) => { rows[0].oracle = "0x" + "ff".repeat(20); });
  rejectsCode(() => repinned(root), "PINNED_CONSTANT_MISMATCH");
});

test("W9 pair, nonnull market ID, and source kind must match pinned original", (t) => {
  const root = fixture(t);
  const mutate = (fn) => edit(root, SOURCE_CONSTANT, (json) => fn(json.groups.find((g) => g.class === "stub-constant-price-oracle").rows));
  mutate((rows) => { rows[0].pair = "wrong-pair"; });
  rejectsCode(() => repinned(root), "PINNED_CONSTANT_MISMATCH");
  fs.copyFileSync(path.join(ROOT, SOURCE_CONSTANT), path.join(root, SOURCE_CONSTANT));
  mutate((rows) => { rows[0].marketId = "0x" + "ff".repeat(32); });
  rejectsCode(() => repinned(root), "PINNED_CONSTANT_MISMATCH");
  fs.copyFileSync(path.join(ROOT, SOURCE_CONSTANT), path.join(root, SOURCE_CONSTANT));
  mutate((rows) => { rows[0].kind = "not-stub"; });
  rejectsCode(() => repinned(root), "PINNED_CONSTANT_ROW_INVALID");
  fs.copyFileSync(path.join(ROOT, SOURCE_CONSTANT), path.join(root, SOURCE_CONSTANT));
  mutate((rows) => { rows[0].marketId = loadPinnedDivergenceUniverse().rows.find((r) => r.oracle.toLowerCase() === rows[0].oracle.toLowerCase()).marketId; });
  assert.equal(repinned(root).rows.filter((r) => r.provenanceConstant).length, 238);
  fs.copyFileSync(path.join(ROOT, SOURCE_CONSTANT), path.join(root, SOURCE_CONSTANT));
  edit(root, SOURCE, (json) => {
    const oracle = JSON.parse(fs.readFileSync(path.join(root, SOURCE_CONSTANT), "utf8"))
      .groups.find((g) => g.class === "stub-constant-price-oracle").rows[0].oracle.toLowerCase();
    json.sentinels.find((r) => r.chainId === 8453 && r.oracle.toLowerCase() === oracle).kind = "custom-oracle";
  });
  rejectsCode(() => repinned(root), "PINNED_CONSTANT_MISMATCH");
});

test("oversize inputs and symlinked source files fail before parsing", (t) => {
  const root = fixture(t);
  const target = path.join(root, SOURCE);
  fs.appendFileSync(target, Buffer.alloc(1024 * 1024));
  rejectsCode(() => loadPinnedDivergenceUniverse({ root }), "PINNED_FILE_UNSAFE");
  fs.rmSync(target);
  try { fs.symlinkSync(path.join(ROOT, SOURCE), target, "file"); }
  catch (error) { if (error.code === "EPERM" || error.code === "EACCES") return; throw error; }
  rejectsCode(() => loadPinnedDivergenceUniverse({ root }), "PINNED_FILE_UNSAFE");
});

test("duplicate and truncated source identities fail closed", (t) => {
  const root = fixture(t);
  edit(root, SOURCE, (json) => { json.sentinels[1] = { ...json.sentinels[0] }; });
  rejectsCode(() => repinned(root), "PINNED_DUPLICATE_IDENTITY");
  fs.copyFileSync(path.join(ROOT, SOURCE), path.join(root, SOURCE));
  edit(root, SOURCE, (json) => { json.sentinels.pop(); });
  rejectsCode(() => repinned(root), "PINNED_SHAPE_INVALID");
});

test("short-id collision with distinct full oracles is rejected", (t) => {
  const root = fixture(t);
  edit(root, SOURCE, (json) => {
    const first = json.sentinels[0];
    const second = json.sentinels[1];
    second.chainId = first.chainId;
    second.oracle = `${first.oracle.slice(0, -1)}${first.oracle.at(-1) === "a" ? "b" : "a"}`;
    second.sentinel = first.sentinel;
  });
  rejectsCode(() => repinned(root), "PINNED_DUPLICATE_IDENTITY");
});

test("malformed market ID and partial tokens never promote a made-up binding", (t) => {
  const root = fixture(t);
  edit(root, SOURCE, (json) => { json.sentinels[0].marketId = "0x1234"; });
  rejectsCode(() => repinned(root), "PINNED_ROW_INVALID");
  fs.copyFileSync(path.join(ROOT, SOURCE), path.join(root, SOURCE));
  edit(root, SOURCE, (json) => { json.sentinels[0].oracle = "0x1234"; });
  rejectsCode(() => repinned(root), "PINNED_ROW_INVALID");
  fs.copyFileSync(path.join(ROOT, SOURCE), path.join(root, SOURCE));
  edit(root, SOURCE, (json) => {
    json.sentinels[0].measurements.collateralToken = "0x" + "ab".repeat(20);
    json.sentinels[0].measurements.loanToken = null;
  });
  const row = repinned(root).rows.find((r) => r.id === JSON.parse(fs.readFileSync(path.join(root, SOURCE), "utf8")).sentinels[0].sentinel);
  assert.equal(row.collateralToken, null);
  assert.equal(row.loanToken, null);
});

test("baseline ID and chain mismatches fail despite repinning fixture bytes", (t) => {
  const root = fixture(t);
  edit(root, BASELINE, (json) => {
    json.records.find((r) => r.source === "divergence").id = "div:1:ffffffff";
  });
  rejectsCode(() => repinned(root), "PINNED_BASELINE_MISMATCH");
  fs.copyFileSync(path.join(ROOT, BASELINE), path.join(root, BASELINE));
  edit(root, BASELINE, (json) => {
    json.records.find((r) => r.source === "divergence").chainId = 8453;
  });
  rejectsCode(() => repinned(root), "PINNED_BASELINE_MISMATCH");
});
