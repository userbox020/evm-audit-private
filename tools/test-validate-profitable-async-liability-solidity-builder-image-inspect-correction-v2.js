"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const correction = require("./validate-profitable-async-liability-solidity-builder-image-inspect-correction-v2.js");

const MATCH_PATH = path.join(__dirname, "vendor", "profitable-async-liability-solidity-builder-image-inspect-diagnostic-v2", "fixtures", "image-inspect-match.json");
function base() { return JSON.parse(fs.readFileSync(MATCH_PATH, "utf8"))[0]; }
function clone(v) { return JSON.parse(JSON.stringify(v)); }
function field(result, id) { return result.fields.find((row) => row.fieldId === id); }

test("exports only strict pure helpers", () => {
  assert.deepEqual(Object.keys(correction).sort(), ["NAMESPACE", "compareCorrectedInspect", "normalizeHistoricalDefaultsStrict", "validateAndCopyJsonTree"].sort());
});

test("User accepts exactly missing null and empty compatibility defaults", () => {
  for (const mode of ["missing", "null", "empty"]) {
    const image = base(); if (mode === "missing") delete image.Config.User; else image.Config.User = mode === "null" ? null : "";
    assert.equal(field(correction.compareCorrectedInspect(image), "CONFIG_USER").matched, true, mode);
  }
  for (const value of ["root", 0, false, [], {}, ["root"]]) { const image = base(); image.Config.User = value; assert.throws(() => correction.compareCorrectedInspect(image), /CONFIG_USER_COMPATIBILITY_REJECTED/); }
});

test("Cmd accepts exactly missing or null and rejects all else", () => {
  for (const mode of ["missing", "null"]) { const image = base(); if (mode === "missing") delete image.Config.Cmd; else image.Config.Cmd = null; assert.equal(field(correction.compareCorrectedInspect(image), "CONFIG_CMD").matched, true); }
  for (const value of [[], ["x"], "", "x", {}, 0, false]) { const image = base(); image.Config.Cmd = value; assert.throws(() => correction.compareCorrectedInspect(image), /CONFIG_CMD_COMPATIBILITY_REJECTED/); }
});

test("rejects undefined function symbol bigint and nonfinite values anywhere", () => {
  for (const value of [undefined, () => 1, Symbol("x"), 1n, NaN, Infinity, -Infinity]) {
    const image = base(); image.Extra = value; assert.throws(() => correction.validateAndCopyJsonTree(image));
  }
});

test("rejects symbol keys without reading unrelated values", () => {
  const image = base(); image[Symbol("x")] = 1; assert.throws(() => correction.validateAndCopyJsonTree(image), /SYMBOL_KEY_REJECTED/);
});

test("rejects own and inherited custom toJSON without invoking it", () => {
  let calls = 0;
  const own = base(); Object.defineProperty(own.Config, "toJSON", { value() { calls += 1; return {}; }, enumerable: false });
  assert.throws(() => correction.validateAndCopyJsonTree(own), /OWN_TOJSON_REJECTED/); assert.equal(calls, 0);
  const inheritedProto = Object.create(Object.prototype); Object.defineProperty(inheritedProto, "toJSON", { value() { calls += 1; return {}; } });
  const inherited = base(); Object.setPrototypeOf(inherited.Config, inheritedProto);
  assert.throws(() => correction.validateAndCopyJsonTree(inherited), /NONPLAIN_OBJECT_REJECTED|INHERITED_TOJSON_REJECTED/); assert.equal(calls, 0);
  Object.defineProperty(Array.prototype, "toJSON", { configurable: true, value() { calls += 1; return []; } });
  try { assert.throws(() => correction.validateAndCopyJsonTree(base()), /INHERITED_TOJSON_REJECTED/); assert.equal(calls, 0); }
  finally { delete Array.prototype.toJSON; }
});

test("rejects getters and setters without executing tripwire", () => {
  let calls = 0; const image = base();
  Object.defineProperty(image.Config, "Trap", { enumerable: true, get() { calls += 1; return "x"; }, set(_) { calls += 1; } });
  assert.throws(() => correction.validateAndCopyJsonTree(image), /ACCESSOR_REJECTED/); assert.equal(calls, 0);
});

test("rejects cycles", () => {
  const direct = base(); direct.Self = direct; assert.throws(() => correction.validateAndCopyJsonTree(direct), /CYCLE_REJECTED/);
  const indirect = base(); indirect.A = {}; indirect.A.B = indirect; assert.throws(() => correction.validateAndCopyJsonTree(indirect), /CYCLE_REJECTED/);
});

test("rejects Date Map Set Buffer typed arrays and other nonplain objects", () => {
  for (const value of [new Date(0), new Map(), new Set(), Buffer.from([1]), new Uint8Array([1]), /x/]) {
    const image = base(); image.Extra = value; assert.throws(() => correction.validateAndCopyJsonTree(image), /NONPLAIN_OBJECT_REJECTED/);
  }
});

test("rejects sparse arrays and arrays with extra keys", () => {
  const sparse = base(); sparse.Config.Env = new Array(2); assert.throws(() => correction.validateAndCopyJsonTree(sparse), /SPARSE_OR_EXTRA_ARRAY_KEY_REJECTED/);
  const extra = base(); extra.Config.Env.extra = "x"; assert.throws(() => correction.validateAndCopyJsonTree(extra), /SPARSE_OR_EXTRA_ARRAY_KEY_REJECTED/);
});

test("accepts null-prototype root Config and nested plain maps by explicit rationale", () => {
  const source = base(); const root = Object.assign(Object.create(null), source); root.Config = Object.assign(Object.create(null), source.Config); root.Extra = Object.assign(Object.create(null), { safe: true });
  const copy = correction.validateAndCopyJsonTree(root);
  assert.equal(Object.getPrototypeOf(copy), null); assert.equal(Object.getPrototypeOf(copy.Config), null); assert.equal(Object.getPrototypeOf(copy.Extra), null);
  assert.equal(correction.compareCorrectedInspect(root).summary.fieldsMismatched, 0);
});

test("rejects nonplain custom root and Config prototypes", () => {
  const customRoot = Object.create({ inherited: true }); Object.assign(customRoot, base()); assert.throws(() => correction.validateAndCopyJsonTree(customRoot), /NONPLAIN_OBJECT_REJECTED/);
  const customConfig = base(); customConfig.Config = Object.assign(Object.create({ inherited: true }), customConfig.Config); assert.throws(() => correction.validateAndCopyJsonTree(customConfig), /NONPLAIN_OBJECT_REJECTED/);
});

test("rejects proxies without executing traps", () => {
  let calls = 0;
  const proxy = new Proxy(base(), { getPrototypeOf() { calls += 1; throw new Error("TRIPWIRE"); }, ownKeys() { calls += 1; throw new Error("TRIPWIRE"); } });
  assert.throws(() => correction.validateAndCopyJsonTree(proxy), /PROXY_REJECTED/);
  assert.equal(calls, 0);
});

test("copy is explicit nonlossy and preserves own presence without mutating input", () => {
  const image = base(); delete image.Config.User; delete image.Config.Cmd;
  const copied = correction.validateAndCopyJsonTree(image); assert.equal(Object.hasOwn(copied.Config, "User"), false); assert.equal(Object.hasOwn(copied.Config, "Cmd"), false);
  const normalized = correction.normalizeHistoricalDefaultsStrict(image); assert.equal(normalized.Config.User, ""); assert.equal(normalized.Config.Cmd, null);
  assert.equal(Object.hasOwn(image.Config, "User"), false); assert.equal(Object.hasOwn(image.Config, "Cmd"), false);
});

test("other seven fields remain strict diagnostic-v2 semantics", () => {
  const cases = [
    [(x) => { x.Id = "bad"; }, "IMAGE_ID"], [(x) => { x.RepoDigests = []; }, "REPO_DIGEST"],
    [(x) => { x.Os = "windows"; }, "OS"], [(x) => { x.Architecture = "arm64"; }, "ARCHITECTURE"],
    [(x) => { x.RootFS.Layers = []; }, "ROOTFS_DIFF_IDS"], [(x) => { x.Config.Entrypoint = []; }, "CONFIG_ENTRYPOINT"],
    [(x) => { x.Config.Env.push("EXTRA=x"); }, "CONFIG_ENV"],
  ];
  for (const [mutate, id] of cases) { const image = base(); mutate(image); const result = correction.compareCorrectedInspect(image); assert.equal(field(result, id).matched, false); assert.equal(result.summary.fieldsMismatched, 1); }
});

test("production validator has no process API and test sentinel makes no call", () => {
  const source = fs.readFileSync(path.join(__dirname, "validate-profitable-async-liability-solidity-builder-image-inspect-correction-v2.js"), "utf8");
  assert.equal(source.includes("child_process"), false); assert.equal(source.includes("spawnSync"), false); assert.equal(source.includes("execSync"), false);
  const original = childProcess.spawnSync; let calls = 0; childProcess.spawnSync = () => { calls += 1; throw new Error("PROCESS_FORBIDDEN"); };
  try { correction.compareCorrectedInspect(base()); assert.equal(calls, 0); } finally { childProcess.spawnSync = original; }
});
