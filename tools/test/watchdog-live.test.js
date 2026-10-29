"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const watchdog = require("../watchdog-live");

const NOW_MS = Date.parse("2026-10-11T02:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

function freshHeartbeatMap(nowMs = NOW_MS, ageMs = 1_000) {
  const at = iso(nowMs - ageMs);
  const map = {};
  for (const entry of watchdog.MANIFEST) map[entry.heartbeat] = { [entry.field]: at };
  return map;
}

function liveProcesses(entries = watchdog.MANIFEST) {
  return entries.map((entry, index) => ({
    pid: 5000 + index,
    commandLine: `node.exe ${entry.script} ${entry.args.join(" ")}`.trim(),
  }));
}

function syntheticManifest(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `synth-${index}`,
    script: `tools/synth-watch-${index}.js`,
    args: ["--loop", "60"],
    heartbeat: `reports/synth/synth-${index}.json`,
    field: "generatedAt",
    staleSeconds: 60,
  }));
}

function emptyState() {
  return { passesSinceRelaunch: {}, consecutiveRelaunches: {} };
}

test("embedded manifest is the exact thirteen read-only watchers + crossing drivers + loop timer + surface refreshers", () => {
  assert.equal(watchdog.validateManifest(watchdog.MANIFEST), true);
  assert.equal(watchdog.MANIFEST.length, 13);
  assert.deepEqual(watchdog.MANIFEST.map((entry) => ({
    id: entry.id,
    script: entry.script,
    args: entry.args,
    heartbeat: entry.heartbeat,
    field: entry.field,
    staleSeconds: entry.staleSeconds,
  })), [
    {
      id: "liquity-liquidation-triggers",
      script: "tools/watch-liquity-liquidation-triggers.js",
      args: ["--loop", "300"],
      heartbeat: "reports/raw/fast/liquity-liquidation-watch/status.json",
      field: "generatedAt",
      staleSeconds: 900,
    },
    {
      id: "aave-v3-liquidation-watch",
      script: "tools/aave-v3-liquidation-watch.js",
      args: ["--until-trigger", "--interval-ms", "60000"],
      heartbeat: "reports/raw/fast/aave-v3-liquidation-watch-status.json",
      field: "generatedAt",
      staleSeconds: 700,
    },
    {
      id: "euler-liquidation-watch",
      script: "tools/watch-euler-l.js",
      args: ["--loop", "300"],
      heartbeat: "reports/raw/fast/euler-l-watch-status.json",
      field: "generatedAt",
      staleSeconds: 700,
    },
    {
      id: "aave-v3-liquidation-exact-quotes",
      script: "tools/quote-aave-v3-liquidation-exact.js",
      args: ["--watch", "120", "--max-runs", "500"],
      heartbeat: "reports/raw/fast/aave-v3-liquidation-exact-quotes.json",
      field: "generatedAt",
      staleSeconds: 700,
    },
    {
      id: "morpho-ws",
      script: "tools/monitor-morpho-ws.js",
      args: [],
      heartbeat: "reports/monitor/morpho-ws-status.json",
      field: "updatedAt",
      staleSeconds: 700,
    },
    {
      id: "morpho-frozen-oracle",
      script: "tools/monitor-morpho-frozen-oracle.js",
      args: ["--watch"],
      heartbeat: "reports/raw/fast/morpho-frozen-oracle-status.json",
      field: "capturedAt",
      staleSeconds: 1200,
    },
    {
      id: "euler-crossing-exec2",
      script: "tools/crossing-euler-evk-exec2.js",
      args: [],
      heartbeat: "reports/raw/fast/euler-crossing-exec2-status.json",
      field: "generatedAt",
      staleSeconds: 2400,
    },
    {
      id: "silo-defaulting-watch",
      script: "tools/watch-silo-defaulting.js",
      args: ["--loop", "300"],
      heartbeat: "reports/raw/fast/silo-default-watch-status.json",
      field: "generatedAt",
      staleSeconds: 900,
    },
    {
      id: "euler-fastlane-watch",
      script: "tools/watch-euler-head-fastlane.js",
      args: ["--watch-once"],
      heartbeat: "reports/raw/fast/euler-fastlane-status.json",
      field: "scannedAt",
      staleSeconds: 300,
    },
    {
      id: "autofire-loop",
      script: "tools/loop-autofire.js",
      args: ["--loop", "60"],
      heartbeat: "reports/raw/fast/autofire-loop-status.json",
      field: "scannedAt",
      staleSeconds: 300,
    },
    {
      id: "fluid-surface-refresh",
      script: "tools/reference-fluid-surface-refresh.js",
      args: [],
      heartbeat: "reports/raw/fast/fluid-l-surface-refresh-status.json",
      field: "generatedAt",
      staleSeconds: 1800,
    },
    {
      id: "fluid-crossing-exec",
      script: "tools/crossing-fluid-t2t4-exec.js",
      args: [],
      heartbeat: "reports/raw/fast/fluid-crossing-exec-status.json",
      field: "generatedAt",
      staleSeconds: 1800,
    },
    {
      id: "euler-surface-refresh",
      script: "tools/reference-euler-surface-refresh.js",
      args: [],
      heartbeat: "reports/raw/fast/euler-l-surface-refresh-status.json",
      field: "generatedAt",
      staleSeconds: 1800,
    },
  ]);
  assert.equal(new Set(watchdog.MANIFEST.map((entry) => entry.id)).size, 13);
  assert.equal(new Set(watchdog.MANIFEST.map((entry) => entry.script)).size, 13);
});

test("manifest staleness ordering is exact and stable", () => {
  assert.deepEqual(watchdog.staleOrder(), [
    "euler-fastlane-watch",
    "autofire-loop",
    "aave-v3-liquidation-watch",
    "euler-liquidation-watch",
    "aave-v3-liquidation-exact-quotes",
    "morpho-ws",
    "liquity-liquidation-triggers",
    "silo-defaulting-watch",
    "morpho-frozen-oracle",
    "fluid-surface-refresh",
    "fluid-crossing-exec",
    "euler-surface-refresh",
    "euler-crossing-exec2",
  ]);
  const equal = [
    { id: "b", staleSeconds: 700 },
    { id: "a", staleSeconds: 700 },
  ];
  assert.deepEqual(watchdog.staleOrder(equal), ["b", "a"], "equal thresholds keep manifest order");
});

test("manifest validation fails closed on shape drift and url material", () => {
  assert.throws(() => watchdog.validateManifest([]), /non-empty/);
  assert.throws(() => watchdog.validateManifest([{ id: "x" }]), /script/);
  const valid = watchdog.MANIFEST[0];
  assert.throws(() => watchdog.validateManifest([{ ...valid, staleSeconds: 0 }]), /staleSeconds/);
  assert.throws(() => watchdog.validateManifest([{ ...valid, script: "tools/../evil.js" }]), /script/);
  assert.throws(() => watchdog.validateManifest([{ ...valid, heartbeat: "reports/raw/fast/http://evil.json" }]), /url material/);
  assert.throws(() => watchdog.validateManifest([{ ...valid, args: ["http://evil"] }]), /url material/);
  assert.throws(() => watchdog.validateManifest([valid, valid]), /duplicate/);
});

test("heartbeatAge reads the declared field and reports age in minutes and seconds", () => {
  const fresh = watchdog.heartbeatAge({ generatedAt: iso(NOW_MS - 90_000) }, "generatedAt", NOW_MS);
  assert.equal(fresh.present, true);
  assert.equal(fresh.ageSeconds, 90);
  assert.equal(fresh.ageMinutes, 1.5);

  const nested = watchdog.heartbeatAge({ a: { b: iso(NOW_MS - 10_000) } }, "a.b", NOW_MS);
  assert.equal(nested.ageSeconds, 10);

  assert.deepEqual(watchdog.heartbeatAge({}, "generatedAt", NOW_MS), { present: false, iso: null, ageSeconds: null, ageMinutes: null });
  assert.equal(watchdog.heartbeatAge({ generatedAt: "not-a-date" }, "generatedAt", NOW_MS).present, false);
});

test("heartbeatIsFresh applies the exact threshold and clock-skew tolerance", () => {
  const at = (seconds) => watchdog.heartbeatAge({ generatedAt: iso(NOW_MS - seconds * 1000) }, "generatedAt", NOW_MS);
  assert.equal(watchdog.heartbeatIsFresh(at(299), 300), true);
  assert.equal(watchdog.heartbeatIsFresh(at(300), 300), true);
  assert.equal(watchdog.heartbeatIsFresh(at(301), 300), false);
  assert.equal(watchdog.heartbeatIsFresh(at(-100), 300), true, "small future skew tolerated");
  assert.equal(watchdog.heartbeatIsFresh(at(-301), 300), false, "large future skew is not fresh");
  assert.equal(watchdog.heartbeatIsFresh(watchdog.heartbeatAge({}, "generatedAt", NOW_MS), 300), false);
});

test("decideEntryAction covers fresh, stale, absent, cooldown and budget paths", () => {
  assert.deepEqual(
    watchdog.decideEntryAction({ fresh: true, processAlive: true, cooldownRemaining: 0, relaunchesThisPass: 0 }),
    { action: "NONE", reason: "fresh-and-alive", suppressed: false },
  );
  assert.deepEqual(
    watchdog.decideEntryAction({ fresh: false, processAlive: true, cooldownRemaining: 0, relaunchesThisPass: 0 }),
    { action: "STOP_STALE_THEN_RELAUNCH", reason: "heartbeat-stale", suppressed: false },
  );
  assert.deepEqual(
    watchdog.decideEntryAction({ fresh: true, processAlive: false, cooldownRemaining: 0, relaunchesThisPass: 0 }),
    { action: "STOP_STALE_THEN_RELAUNCH", reason: "process-absent", suppressed: false },
  );
  assert.deepEqual(
    watchdog.decideEntryAction({ fresh: false, processAlive: false, cooldownRemaining: 1, relaunchesThisPass: 0 }),
    { action: "NONE", reason: "relaunch-cooldown", suppressed: true },
  );
  assert.deepEqual(
    watchdog.decideEntryAction({ fresh: false, processAlive: false, cooldownRemaining: 0, relaunchesThisPass: watchdog.MAX_RELAUNCHES_PER_PASS }),
    { action: "NONE", reason: "relaunch-budget-exhausted", suppressed: true },
  );
});

test("commandLineMatchesScript recognizes node invocation forms without suffix drift", () => {
  const script = "tools/watch-liquity-liquidation-triggers.js";
  for (const commandLine of [
    `node.exe ${script} --loop 300`,
    `node ${script.replace(/\//g, "\\")} --loop 300`,
    `"C:\\Program Files\\nodejs\\node.exe" "C:\\_Work\\__EVM_AUDIT\\tools\\watch-liquity-liquidation-triggers.js" --loop 300`,
    `node --no-warnings ${script} --loop 300`,
  ]) assert.equal(watchdog.commandLineMatchesScript(commandLine, script), true, commandLine);

  for (const commandLine of [
    `node tools/test/watch-liquity-liquidation-triggers.test.js`,
    `node tools/watch-liquity-liquidation-triggers.test.js`,
    `node tools/not-watch-liquity-liquidation-triggers.js`,
    `node tools/monitor-morpho-ws.js`,
  ]) assert.equal(watchdog.commandLineMatchesScript(commandLine, script), false, commandLine);
});

test("duplicate supervisor guard ignores self and --once, flags other --loop supervisors", () => {
  const loop = [{ pid: 5, commandLine: "node.exe tools/watchdog-live.js --loop 60" }];
  assert.equal(watchdog.detectDuplicateSupervisor(loop, 5), false, "self is not a duplicate");
  assert.equal(watchdog.detectDuplicateSupervisor(loop, 1), true);
  assert.equal(watchdog.detectDuplicateSupervisor([{ pid: 2, commandLine: "node tools/watchdog-live.js --loop=60" }], 1), true);
  assert.equal(watchdog.detectDuplicateSupervisor([{ pid: 2, commandLine: "node tools/watchdog-live.js --once" }], 1), false);
  assert.equal(watchdog.detectDuplicateSupervisor([{ pid: 2, commandLine: "node tools/watchdog-live.js" }], 1), false);
  assert.equal(watchdog.detectDuplicateSupervisor([{ pid: 2, commandLine: "node tools/other.js tools/watchdog-live.js --loop 60" }], 1), true);
});

test("sweep keeps everything NONE when all five heartbeats are fresh and alive", () => {
  const state = emptyState();
  const sweep = watchdog.runSweep(watchdog.MANIFEST, state, {
    nowMs: NOW_MS,
    processes: liveProcesses(),
    heartbeatMap: freshHeartbeatMap(),
    dryRun: true,
  });
  assert.equal(sweep.relaunchesThisPass, 0);
  assert.equal(sweep.entries.length, 13);
  for (const row of sweep.entries) {
    assert.equal(row.action, "NONE", row.id);
    assert.equal(row.suppressed, false, row.id);
    assert.equal(row.processAlive, true, row.id);
    assert.equal(row.reason, "fresh-and-alive", row.id);
    assert.equal(row.consecutiveRelaunches, 0, row.id);
  }
});

test("sweep relaunches stale or absent entries and honors the per-pass budget", () => {
  const manifest = syntheticManifest(6);
  const state = emptyState();
  const sweep = watchdog.runSweep(manifest, state, { nowMs: NOW_MS, processes: [], heartbeatMap: {}, dryRun: true });
  assert.equal(sweep.relaunchesThisPass, watchdog.MAX_RELAUNCHES_PER_PASS);
  assert.equal(sweep.summary.relaunched, watchdog.MAX_RELAUNCHES_PER_PASS);
  assert.equal(sweep.entries[5].action, "NONE");
  assert.equal(sweep.entries[5].reason, "relaunch-budget-exhausted");
  assert.equal(sweep.entries[5].suppressed, true);
});

test("sweep enforces at least two full passes between repeat relaunches", () => {
  const manifest = syntheticManifest(1);
  const state = emptyState();
  const options = { nowMs: NOW_MS, processes: [], heartbeatMap: {}, dryRun: true };

  const pass1 = watchdog.runSweep(manifest, state, options);
  assert.equal(pass1.entries[0].action, "STOP_STALE_THEN_RELAUNCH");
  assert.equal(pass1.entries[0].consecutiveRelaunches, 1);

  const pass2 = watchdog.runSweep(manifest, state, options);
  assert.equal(pass2.entries[0].action, "NONE");
  assert.equal(pass2.entries[0].reason, "relaunch-cooldown");
  assert.equal(pass2.entries[0].suppressed, true);

  const pass3 = watchdog.runSweep(manifest, state, options);
  assert.equal(pass3.entries[0].suppressed, true, "second cooldown pass still suppressed");

  const pass4 = watchdog.runSweep(manifest, state, options);
  assert.equal(pass4.entries[0].action, "STOP_STALE_THEN_RELAUNCH", "third pass after relaunch is allowed again");
  assert.equal(pass4.entries[0].consecutiveRelaunches, 2);
});

test("stale heartbeat with a live process is stopped then relaunched", () => {
  const state = emptyState();
  const stale = iso(NOW_MS - 15 * 60_000);
  const map = freshHeartbeatMap();
  map["reports/monitor/morpho-ws-status.json"] = { updatedAt: stale };
  const sweep = watchdog.runSweep(watchdog.MANIFEST, state, {
    nowMs: NOW_MS,
    processes: liveProcesses(),
    heartbeatMap: map,
    dryRun: true,
  });
  const morpho = sweep.entries.find((row) => row.id === "morpho-ws");
  assert.equal(morpho.processAlive, true);
  assert.equal(morpho.action, "STOP_STALE_THEN_RELAUNCH");
  assert.equal(morpho.reason, "heartbeat-stale");
});

test("buildStatus emits the watchdog-live/v1 read-only schema with no url material", () => {
  const state = emptyState();
  const status = watchdog.buildStatus({
    pass: 1,
    mode: "once",
    manifest: watchdog.MANIFEST,
    state,
    nowMs: NOW_MS,
    options: {
      processes: [
        ...liveProcesses(),
        { pid: 9999, commandLine: "node tools/other.js --endpoint https://secret.example/rpc private-marker" },
      ],
      heartbeatMap: freshHeartbeatMap(),
      dryRun: true,
    },
  });
  assert.equal(status.schema, "watchdog-live/v1");
  assert.equal(status.readonly, true);
  assert.equal(status.coverageProof, null);
  assert.equal(status.relaunches, 0);
  assert.equal(typeof status.generatedAt, "string");
  assert.equal(status.entries.length, 13);
  for (const row of status.entries) {
    assert.deepEqual(Object.keys(row).sort(), [
      "action", "consecutiveRelaunches", "field", "heartbeat", "heartbeatAge",
      "heartbeatAgeSeconds", "id", "passesSinceRelaunch", "processAlive", "reason",
      "script", "staleThresholdSeconds", "suppressed",
    ]);
  }

  assert.equal(watchdog.containsUrlMaterial(status), false);
  const encoded = JSON.stringify(status);
  assert.doesNotMatch(encoded, /https?:\/\//i);
  assert.doesNotMatch(encoded, /secret\.example|private-marker/);
  assert.doesNotMatch(encoded, /commandLine|"pid"/i);
});

test("parseOptions handles once, loop, max-passes and manifest override", () => {
  assert.deepEqual(watchdog.parseOptions([]), { once: false, loopSeconds: 60, maxPasses: 1440, manifestPath: null, quiet: false });
  assert.deepEqual(watchdog.parseOptions(["--once"]), { once: true, loopSeconds: 60, maxPasses: 1440, manifestPath: null, quiet: false });
  assert.deepEqual(watchdog.parseOptions(["--loop", "30"]), { once: false, loopSeconds: 30, maxPasses: 1440, manifestPath: null, quiet: false });
  assert.deepEqual(watchdog.parseOptions(["--loop=15", "--max-passes", "2"]), { once: false, loopSeconds: 15, maxPasses: 2, manifestPath: null, quiet: false });
  assert.deepEqual(watchdog.parseOptions(["--manifest", "custom.json", "--quiet"]), { once: false, loopSeconds: 60, maxPasses: 1440, manifestPath: "custom.json", quiet: true });
  assert.equal(watchdog.parseOptions(["--max-passes", "0"]).maxPasses, 1, "max passes is clamped to at least 1");
});

test("loadManifest returns the embedded manifest without an override", () => {
  assert.equal(watchdog.loadManifest(null), watchdog.MANIFEST);
});
