"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const correction = require("./validate-profitable-async-liability-solidity-builder-image-inspect-correction-v1.js");

const MATCH_PATH = path.join(__dirname, "vendor", "profitable-async-liability-solidity-builder-image-inspect-diagnostic-v2", "fixtures", "image-inspect-match.json");

function base() { return JSON.parse(fs.readFileSync(MATCH_PATH, "utf8"))[0]; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function field(result, id) { return result.fields.find((row) => row.fieldId === id); }

test("module exports only pure correction helpers", () => {
  assert.deepEqual(Object.keys(correction).sort(), ["NAMESPACE", "compareCorrectedInspect", "normalizeOciDefaults", "validateTerminalEvidence"].sort());
});

test("missing null and empty CONFIG_USER are equivalent defaults", () => {
  for (const mode of ["missing", "null", "empty"]) {
    const image = base();
    if (mode === "missing") delete image.Config.User;
    if (mode === "null") image.Config.User = null;
    if (mode === "empty") image.Config.User = "";
    assert.equal(field(correction.compareCorrectedInspect(image), "CONFIG_USER").matched, true, mode);
  }
});

test("CONFIG_USER rejects nonempty strings and every non-string non-null value", () => {
  for (const value of ["root", 0, false, [], {}, ["root"]]) {
    const image = base(); image.Config.User = value;
    assert.equal(field(correction.compareCorrectedInspect(image), "CONFIG_USER").matched, false, JSON.stringify(value));
  }
});

test("missing and null CONFIG_CMD are equivalent defaults", () => {
  for (const mode of ["missing", "null"]) {
    const image = base();
    if (mode === "missing") delete image.Config.Cmd;
    else image.Config.Cmd = null;
    assert.equal(field(correction.compareCorrectedInspect(image), "CONFIG_CMD").matched, true, mode);
  }
});

test("CONFIG_CMD rejects empty/nonempty arrays strings objects and scalars", () => {
  for (const value of [[], ["x"], "", "x", {}, 0, false]) {
    const image = base(); image.Config.Cmd = value;
    assert.equal(field(correction.compareCorrectedInspect(image), "CONFIG_CMD").matched, false, JSON.stringify(value));
  }
});

test("normalization changes only missing/null user and missing cmd", () => {
  const image = base(); delete image.Config.User; delete image.Config.Cmd;
  const normalized = correction.normalizeOciDefaults(image);
  assert.equal(normalized.Config.User, ""); assert.equal(normalized.Config.Cmd, null);
  const expected = base();
  assert.deepEqual(normalized, expected);
  assert.equal(Object.hasOwn(image.Config, "User"), false);
  assert.equal(Object.hasOwn(image.Config, "Cmd"), false);
});

test("other seven fields retain diagnostic-v2 strict behavior", () => {
  const cases = [
    ["Id", (x) => { x.Id = "sha256:" + "0".repeat(64); }, "IMAGE_ID"],
    ["RepoDigests", (x) => { x.RepoDigests = []; }, "REPO_DIGEST"],
    ["Os", (x) => { x.Os = "windows"; }, "OS"],
    ["Architecture", (x) => { x.Architecture = "arm64"; }, "ARCHITECTURE"],
    ["RootFS", (x) => { x.RootFS.Layers = []; }, "ROOTFS_DIFF_IDS"],
    ["Entrypoint", (x) => { x.Config.Entrypoint = []; }, "CONFIG_ENTRYPOINT"],
    ["Env", (x) => { x.Config.Env.push("EXTRA=x"); }, "CONFIG_ENV"],
  ];
  for (const [name, mutate, id] of cases) {
    const image = base(); mutate(image);
    const result = correction.compareCorrectedInspect(image);
    assert.equal(field(result, id).matched, false, name);
    assert.equal(result.summary.fieldsMismatched, 1, name);
  }
});

test("normalizing defaults does not hide unrelated mismatches", () => {
  const image = base(); delete image.Config.User; delete image.Config.Cmd; image.Os = "windows";
  const result = correction.compareCorrectedInspect(image);
  assert.deepEqual(result.summary.mismatchFieldIds, ["OS"]);
});

test("invalid Config parent remains four parent mismatches", () => {
  const image = base(); image.Config = null;
  const result = correction.compareCorrectedInspect(image);
  assert.deepEqual(result.summary.mismatchFieldIds, ["CONFIG_USER", "CONFIG_ENTRYPOINT", "CONFIG_CMD", "CONFIG_ENV"]);
});

test("source contains no child_process or process execution", () => {
  const source = fs.readFileSync(path.join(__dirname, "validate-profitable-async-liability-solidity-builder-image-inspect-correction-v1.js"), "utf8");
  assert.equal(source.includes("child_process"), false);
  assert.equal(source.includes("spawnSync"), false);
  assert.equal(source.includes("execSync"), false);
});

test("requiring and using module performs zero process calls", () => {
  const original = childProcess.spawnSync; let calls = 0;
  childProcess.spawnSync = () => { calls += 1; throw new Error("PROCESS_FORBIDDEN"); };
  try { correction.compareCorrectedInspect(base()); assert.equal(calls, 0); }
  finally { childProcess.spawnSync = original; }
});
