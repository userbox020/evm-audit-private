"use strict";

// Regression coverage for watch-euler-l.js loop semantics.
//
// The standing watchdog manifest runs this runner as `watch-euler-l.js --loop 300`
// (see tools/watchdog-live.js MANIFEST). Until this fix, untilTrigger defaulted true
// for that invocation, so the runner exited after the first trigger-bearing sweep and
// the supervisor's relaunch-after-exit policy churned the generation. These tests pin
// the decision logic (pure functions) without spawning the real loop.

const test = require("node:test");
const assert = require("node:assert/strict");

const watcher = require("../watch-euler-l");

const TRIGGER_SWEEP = { trigger: true };
const QUIET_SWEEP = { trigger: false };

test("--loop <seconds> defaults untilTrigger=false and does not exit on first trigger sweep", () => {
  // Exactly the watchdog manifest invocation.
  const options = watcher.parseArgs(["--loop", "300"]);
  assert.equal(options.untilTrigger, false, "standing --loop must be persistent");
  assert.equal(options.intervalMs, 300_000);
  assert.equal(
    watcher.shouldStopOnTrigger(options.untilTrigger, TRIGGER_SWEEP),
    false,
    "persistent loop rides through a trigger-bearing sweep instead of breaking",
  );
  assert.equal(watcher.shouldStopOnTrigger(options.untilTrigger, QUIET_SWEEP), false);
});

test("no args preserves the legacy untilTrigger=true default", () => {
  const options = watcher.parseArgs([]);
  assert.equal(options.untilTrigger, true, "unbounded no-flag invocation keeps legacy stop-on-trigger");
  assert.equal(options.once, false);
  assert.equal(
    watcher.shouldStopOnTrigger(options.untilTrigger, TRIGGER_SWEEP),
    true,
    "legacy default still stops on the first trigger-bearing sweep",
  );
  assert.equal(watcher.shouldStopOnTrigger(options.untilTrigger, QUIET_SWEEP), false);
});

test("explicit --until-trigger remains an opt-in even alongside --loop (aave convention)", () => {
  const explicit = watcher.parseArgs(["--until-trigger", "--interval-ms", "60000"]);
  assert.equal(explicit.untilTrigger, true);
  assert.equal(watcher.shouldStopOnTrigger(explicit.untilTrigger, TRIGGER_SWEEP), true);

  const explicitWithLoop = watcher.parseArgs(["--loop", "300", "--until-trigger"]);
  assert.equal(explicitWithLoop.untilTrigger, true, "explicit flag overrides the --loop default");
});

test("--once and explicit --max-runs remain bounded (untilTrigger=false)", () => {
  assert.equal(watcher.parseArgs(["--once"]).untilTrigger, false);
  assert.equal(watcher.parseArgs(["--max-runs", "5"]).untilTrigger, false);
  assert.equal(watcher.parseArgs(["--loop", "300", "--max-runs", "3"]).untilTrigger, false);
});

test("resolveUntilTrigger precedence is explicit > loop > legacy default", () => {
  assert.equal(
    watcher.resolveUntilTrigger({ once: false, loop: true, explicitMaxRuns: null, explicitUntilTrigger: false }),
    false,
  );
  assert.equal(
    watcher.resolveUntilTrigger({ once: false, loop: false, explicitMaxRuns: null, explicitUntilTrigger: false }),
    true,
  );
  assert.equal(
    watcher.resolveUntilTrigger({ once: false, loop: true, explicitMaxRuns: null, explicitUntilTrigger: true }),
    true,
  );
  assert.equal(
    watcher.resolveUntilTrigger({ once: true, loop: false, explicitMaxRuns: null, explicitUntilTrigger: false }),
    false,
  );
  assert.equal(
    watcher.resolveUntilTrigger({ once: false, loop: false, explicitMaxRuns: "9", explicitUntilTrigger: false }),
    false,
  );
});
