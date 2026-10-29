"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const RUN = path.join(__dirname, "..", "atomic", "ethereum-top-trades-7d-reconstruction", "run.js");

test("offline CLI writes a complete atomic endpoint-free bundle without network configuration", (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "eth-top-trades-v1-"));
  const output = path.join(parent, "artifacts");
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [RUN, "--offline-fixture", "--output-dir", output], { encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, mode: "offline-fixture", wroteArtifacts: true, fileCount: 5 });
  const names = fs.readdirSync(output).sort();
  assert.deepEqual(names, ["candidates.json", "fork-plan.json", "manifest.json", "reconciled.json", "window.json"]);
  const manifest = JSON.parse(fs.readFileSync(path.join(output, "manifest.json"), "utf8"));
  assert.equal(manifest.endpointFree, true);
  assert.equal(manifest.atomicVisibility, true);
  assert.equal(manifest.durabilityClaimed, false);
  assert.equal(Object.prototype.hasOwnProperty.call(manifest, "atomicWrite"), false);
  assert.equal(Object.keys(manifest.files).length, 4);
  for (const name of names) {
    const content = fs.readFileSync(path.join(output, name), "utf8");
    assert.doesNotMatch(content, /https?:\/\//i);
    assert.doesNotMatch(content, /x-api-key|authorization|bearer/i);
  }
});

test("offline mode rejects collection-only options before any work", () => {
  const result = spawnSync(process.execPath, [RUN, "--offline-fixture", "--traces", "--no-write"], { encoding: "utf8", timeout: 30000 });
  assert.notEqual(result.status, 0);
  assert.deepEqual(JSON.parse(result.stderr), { ok: false, code: "offline-mode-does-not-read-inventory-or-network" });
});

test("deep validation failures emit only fixed sanitized stderr codes and no artifacts", (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "deep-cli-failure-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const source = path.join(parent, "missing-source"); const hashes = path.join(parent, "missing-hashes.json");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:RPC|ENDPOINT|PROVIDER).*URL|URL.*(?:RPC|ENDPOINT|PROVIDER)|ALCHEMY|INFURA|QUICKNODE|^(?:ETH_|WEB3_|RPC_|JSON_RPC|ENDPOINT)/i.test(key)));
  const result = spawnSync(process.execPath, [RUN, "--deep-reconstruct", "--source-dir", source, "--hashes-file", hashes], { encoding: "utf8", timeout: 30000, env });
  assert.notEqual(result.status, 0);
  assert.deepEqual(JSON.parse(result.stderr), { ok: false, code: "invalid-source-directory" });
  assert.deepEqual(fs.readdirSync(parent), []);
});
