"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const REGISTRY_PATH = path.join(ROOT, "tools", "monitor-research-watch-registry.json");
const VIEW_PATH = path.join(ROOT, "tools", "view-alerts.js");
const { buildState } = require("../build-monitor-research-watch.js");

function registry() {
  return JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
}

test("registry is source-bound, fail-closed, and complete in this workspace", () => {
  const value = registry();
  const state = buildState(value, ROOT, "2026-08-25T12:00:00Z");
  assert.equal(value.schema, "monitor-research-watch-registry/v1");
  assert.equal(state.schema, "monitor-research-watch/v1");
  assert.deepEqual(state.safety, { readOnly: true, networkAccess: false, execution: false, signedActions: false });
  assert.ok(state.entries.length >= 16);
  assert.equal(new Set(state.entries.map(entry => entry.id)).size, state.entries.length);
  assert.ok(state.entries.every(entry => entry.status === "COMPLETE"));
  assert.ok(state.entries.every(entry => entry.effectiveDisposition === entry.disposition));
  assert.ok(state.entries.every(entry => entry.sources.every(source => source.exists && source.mtime && !Object.hasOwn(source, "hash"))));
  assert.ok(state.entries.every(entry => ["unknown", false].includes(entry.routePositive)));
  assert.ok(state.entries.every(entry => ["unknown", false].includes(entry.executableNow)));
  assert.ok(state.entries.every(entry => entry.signedActionJustified === false));
});

test("required dispositions and truthful scheduled review are retained", () => {
  const state = buildState(registry(), ROOT, "2026-08-25T12:00:00Z");
  const byId = new Map(state.entries.map(entry => [entry.id, entry]));
  assert.deepEqual(
    ["venus-psr-bnb", "venus-psr-ethereum", "venus-psr-arbitrum"].map(id => byId.get(id).disposition),
    ["ACTIVE_WATCH", "ACTIVE_WATCH", "ACTIVE_WATCH"],
  );
  assert.equal(byId.get("forty-acres-v2-jit").disposition, "HOLD");
  assert.equal(byId.get("uniswapx-empty-batch").disposition, "HOLD");
  for (const id of ["osonic-legacy-branch", "robin-runtime", "marginfi-source-only", "meteora-source-only", "cetus-source-only", "strata-source-only"]) {
    assert.equal(byId.get(id).disposition, "SUPPRESSED");
  }
  const morpho = byId.get("morpho-post-27aug-review");
  assert.equal(morpho.disposition, "SCHEDULED");
  assert.equal(morpho.reviewAt, "2026-08-27T00:00:00.000Z");
  assert.equal(morpho.executableNow, "unknown");
});

test("provenance bootstrap entries remain fail-closed holds", () => {
  const state = buildState(registry(), ROOT, "2026-08-25T12:00:00Z");
  const byId = new Map(state.entries.map(entry => [entry.id, entry]));
  const ids = [
    "compound-iii-provenance-bootstrap",
    "curve-core-provenance-bootstrap",
    "fluid-provenance-bootstrap",
    "pendle-v2-provenance-bootstrap",
  ];
  const unknownGates = {
    officialLineage: "unknown",
    reproducibleBuild: "unknown",
    authoritativeDeployment: "unknown",
    exactRuntime: "unknown",
  };
  for (const id of ids) {
    const entry = byId.get(id);
    assert.ok(entry, id);
    assert.equal(entry.disposition, "HOLD", id);
    assert.deepEqual(entry.gates, unknownGates, id);
    assert.equal(entry.routePositive, "unknown", id);
    assert.equal(entry.executableNow, "unknown", id);
    assert.equal(entry.signedActionJustified, false, id);
  }
});

test("missing local source makes an entry incomplete rather than active", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "research-watch-"));
  try {
    const value = {
      schema: "monitor-research-watch-registry/v1",
      entries: [{
        id: "bounded-missing-watch",
        protocol: "Fixture",
        disposition: "ACTIVE_WATCH",
        trigger: "Local fixture changes.",
        sources: ["reports/missing.json"],
        gates: { runtimeBound: "unknown" },
        reason: "Fixture source is intentionally absent.",
        routePositive: "unknown",
        executableNow: "unknown",
        signedActionJustified: false,
      }],
    };
    const entry = buildState(value, root, "2026-08-25T12:00:00Z").entries[0];
    assert.equal(entry.status, "INCOMPLETE");
    assert.equal(entry.effectiveDisposition, "INCOMPLETE");
    assert.equal(entry.sources[0].exists, false);
    assert.equal(entry.sources[0].mtime, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("viewer source contains no legacy sensitive or live-operation presentation", () => {
  const source = fs.readFileSync(VIEW_PATH, "utf8").toLowerCase();
  for (const forbidden of [
    "wallet",
    "deployed:",
    "bot armed",
    "auto-executions",
    "live profit",
    "private key",
    "private_key",
    "endpoint identity",
    "provider identity",
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  assert.equal(/0x[a-f0-9]{40}/i.test(source), false);
});
