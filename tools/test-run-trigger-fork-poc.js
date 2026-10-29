"use strict";

// Offline node:test suite for tools/run-trigger-fork-poc.js.
//
// ALL fork/network/Anvil dependencies are injected mocks. This suite makes no
// network requests, starts no Anvil process, reads no rpc_endpoints.txt, and
// never exercises the live --run path against a real harness.

const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const bridge = require("./run-trigger-fork-poc");

test("phase B manual bridge read/parse failures preserve MANUAL null-reservation metadata", async () => {
  for (const readArtifact of [() => { throw new Error("private read"); }, () => "{"]) {
    const r = await bridge.runBridge({}, { now: () => Date.parse("2026-10-14T04:00:00.000Z"), readArtifact });
    assert.equal(r.status, "FAIL_CLOSED"); assert.equal(r.callerClass, "MANUAL"); assert.equal(r.eventContext, null); assert.equal(r.deadlines, null);
    assert.ok(!JSON.stringify(r).includes("private read"));
  }
});
test("phase B manual bridge setup throw returns structured context before source access", async () => {
  let reads = 0;
  const r = await bridge.runBridge({}, { now: () => { throw new Error("private clock"); }, readArtifact: () => { ++reads; } });
  assert.equal(r.status, "FAIL_CLOSED"); assert.equal(r.callerClass, "MANUAL"); assert.equal(r.eventContext, null); assert.equal(reads, 0);
});

const NOW = "2026-09-14T22:11:15.969Z";

function producer(id, status, evidence = {}) {
  return { id, status, reason: "TEST_REASON", evidence, generatedAt: NOW };
}

function artifact(producers) {
  return {
    schema: "profit-trigger-watch/v1",
    generatedAt: NOW,
    running: false,
    producers,
    safety: {},
  };
}

function makeDeps(sourceArtifact, overrides = {}) {
  const state = { forks: [], writes: [], written: [] };
  const deps = {
    readArtifact: () => JSON.stringify(sourceArtifact),
    writeArtifact: (file, output) => {
      state.writes.push(file);
      state.written.push(output);
    },
    scenarioExists: () => true,
    loadScenario: () => ({ chainId: 8453, block: "finalized", run: async () => {} }),
    runForkPoc: async (options) => {
      state.forks.push(options);
      return { status: "PASS", blocker: null, output: { observations: [{ label: "net", value: null }] }, outPath: options.outPath };
    },
    now: () => Date.parse(NOW),
    write: () => {},
    triggersDir: path.join(os.tmpdir(), "trigger-bridge-tests"),
    outDir: path.join(os.tmpdir(), "trigger-bridge-tests"),
    ...overrides,
  };
  return { deps, state };
}

test("fired/not-fired mapping covers every monitor status", () => {
  for (const status of ["TRIGGER_UNPAUSE", "WINDOW_OPEN", "STRATEGY_SET_CHANGED", "ATOMIC_FORK_REQUIRED"]) {
    assert.equal(bridge.isFired(status), true, status);
    assert.equal(bridge.classifyStatus(status), "FIRED", status);
  }
  for (const status of ["BLOCKED_PAUSED", "WINDOW_CLOSED", "NO_CHANGE", "NO_GROSS_EDGE", "GROSS_EDGE_NET_BLOCKED", "FAILED", "TIMEOUT"]) {
    assert.equal(bridge.isFired(status), false, status);
    assert.equal(bridge.classifyStatus(status), "NOT_FIRED", status);
  }
  assert.equal(bridge.classifyStatus("SOMETHING_ELSE"), "UNKNOWN");
});

test("FRAX fired evidence is passed only as in-process scenario input", async () => {
  const evidence = { blockNumberRaw: "123", blockHash: `0x${"1".repeat(64)}`, candidate: { eventId: "a".repeat(64) } };
  const source = artifact([producer("frax-usdc-cross-venue", "ATOMIC_FORK_REQUIRED", evidence)]);
  const { deps, state } = makeDeps(source, { loadScenario: () => ({ chainId: 1, run: async () => {} }) });
  const outcome = await bridge.runBridge({ run: true }, deps);
  assert.equal(outcome.output.executedCount, 1);
  assert.deepEqual(state.forks[0].scenarioInput, evidence);
  assert.equal(state.forks[0].block, "123");
});

test("fired chain id is passed to the fork harness as a CLI string", async () => {
  const base = artifact([producer("base-usdc-usdt-cross-venue", "ATOMIC_FORK_REQUIRED", { chainId: 1 })]);
  const { deps, state } = makeDeps(base);
  const outcome = await bridge.runBridge({ run: true }, deps);
  assert.equal(outcome.output.executedCount, 1);
  assert.equal(state.forks[0].chain, "8453");
  assert.equal(typeof state.forks[0].chain, "string");
  const frax = artifact([producer("frax-usdc-cross-venue", "ATOMIC_FORK_REQUIRED", { chainId: 1 })]);
  const { deps: fraxDeps, state: fraxState } = makeDeps(frax, { loadScenario: () => ({ chainId: 1, run: async () => {} }) });
  await bridge.runBridge({ run: true }, fraxDeps);
  assert.equal(fraxState.forks[0].chain, "1");
});

test("parseArgs accepts --artifact/--run and rejects malformed flags", () => {
  assert.deepEqual(bridge.parseArgs([]), { run: false, artifact: null });
  assert.deepEqual(bridge.parseArgs(["--run", "--artifact", "x.json"]), { run: true, artifact: "x.json" });
  assert.throws(() => bridge.parseArgs(["--bogus"]), /USAGE_ERROR/);
  assert.throws(() => bridge.parseArgs(["--artifact"]), /USAGE_ERROR/);
  assert.throws(() => bridge.parseArgs(["--artifact", "--run"]), /USAGE_ERROR/);
  assert.throws(() => bridge.parseArgs(["--run", "--run"]), /USAGE_ERROR/);
});

test("without --run the bridge prints a plan and contacts nothing", async () => {
  const source = artifact([
    producer("kelp-composite", "TRIGGER_UNPAUSE", { chainId: 8453 }),
    producer("ostium-settlement-window", "WINDOW_OPEN", { chainId: 42161 }),
    producer("clever-harvest", "NO_CHANGE", { chainId: 1 }),
  ]);
  const { deps, state } = makeDeps(source);
  const outcome = await bridge.runBridge({ run: false }, deps);

  assert.equal(outcome.status, "PLAN_ONLY");
  assert.equal(state.forks.length, 0);
  assert.equal(state.writes.length, 0);
  assert.equal(outcome.output.mode, "PLAN");
  assert.equal(outcome.output.firedCount, 2);
  assert.equal(outcome.output.triggers.length, 3);
  assert.equal(outcome.output.triggers[0].status, "WOULD_FORK");
  assert.equal(outcome.output.triggers[0].chainId, 8453);
  assert.equal(outcome.output.triggers[1].status, "WOULD_FORK");
  assert.equal(outcome.output.triggers[1].chainId, 42161);
  assert.equal(outcome.output.triggers[2].status, "NOT_FIRED");
  assert.equal(outcome.output.triggers[2].fired, false);
});

test("a fired producer with no mapped scenario records NO_SCENARIO_MAPPED", async () => {
  const source = artifact([producer("kelp-composite", "TRIGGER_UNPAUSE", { chainId: 8453 })]);
  const { deps, state } = makeDeps(source, { scenarioExists: () => false });
  const outcome = await bridge.runBridge({ run: true }, deps);

  assert.equal(outcome.status, "BRIDGE_COMPLETE");
  assert.equal(state.forks.length, 0);
  const row = outcome.output.triggers[0];
  assert.equal(row.status, "NO_SCENARIO_MAPPED");
  assert.equal(row.fired, true);
  assert.equal(row.scenario, null);
  assert.equal(row.chainId, 8453);
  assert.equal(row.result, null);
  assert.equal(row.net, null);
  assert.equal(row.blocker, null);
});

test("run aggregation writes a trigger-fork-bridge/v1 artifact with the required shape", async () => {
  const source = artifact([
    producer("kelp-composite", "TRIGGER_UNPAUSE", { chainId: 8453 }),
    producer("ostium-settlement-window", "WINDOW_OPEN", { chainId: 42161 }),
    producer("clever-harvest", "STRATEGY_SET_CHANGED", { chainId: 1 }),
  ]);
  const { deps, state } = makeDeps(source);
  const outcome = await bridge.runBridge({ run: true }, deps);

  assert.equal(outcome.status, "BRIDGE_COMPLETE");
  const output = outcome.output;
  assert.equal(output.schema, "trigger-fork-bridge/v1");
  assert.equal(output.mode, "RUN");
  assert.equal(output.firedCount, 3);
  assert.equal(output.executedCount, 3);
  assert.equal(output.triggers.length, 3);
  for (const row of output.triggers) {
    for (const key of ["producerId", "status", "fired", "scenario", "chainId", "result", "net", "blocker"]) {
      assert.equal(Object.hasOwn(row, key), true, `${row.producerId}:${key}`);
    }
    assert.equal(row.status, "EXECUTED");
    assert.equal(row.result, "PASS");
  }
  assert.deepEqual(output.safety, {
    localOnly: true,
    readOnly: true,
    impersonationOnly: true,
    noSigning: true,
    noBroadcast: true,
    endpointInventoryPrinted: false,
    firedTriggerLimit: 5,
  });
  assert.equal(state.forks.length, 3);
  assert.equal(state.writes.length, 1);
  assert.equal(state.written[0].schema, "trigger-fork-bridge/v1");
  assert.match(outcome.outPath, /trigger-bridge-.*\.json$/u);
  assert.equal(/https?:\/\//iu.test(JSON.stringify(output)), false);
});

test("one failing trigger fails closed without aborting the others", async () => {
  const source = artifact([
    producer("kelp-composite", "TRIGGER_UNPAUSE", { chainId: 8453 }),
    producer("ostium-settlement-window", "WINDOW_OPEN", { chainId: 42161 }),
    producer("clever-harvest", "STRATEGY_SET_CHANGED", { chainId: 1 }),
  ]);
  let calls = 0;
  const { deps, state } = makeDeps(source, {
    runForkPoc: async (options) => {
      calls += 1;
      state.forks.push(options);
      if (calls === 1) {
        const error = new Error("boom");
        error.code = "LOCAL_RPC_UNAVAILABLE";
        throw error;
      }
      return { status: "FAIL", blocker: null, output: { observations: [{ label: "net", value: null }] }, outPath: options.outPath };
    },
  });
  const outcome = await bridge.runBridge({ run: true }, deps);

  assert.equal(outcome.status, "BRIDGE_COMPLETE");
  assert.equal(outcome.output.triggers[0].status, "FAILED");
  assert.equal(outcome.output.triggers[0].blocker, "LOCAL_RPC_UNAVAILABLE");
  assert.equal(outcome.output.triggers[1].status, "EXECUTED");
  assert.equal(outcome.output.triggers[1].result, "FAIL");
  assert.equal(outcome.output.triggers[2].status, "EXECUTED");
  assert.equal(state.forks.length, 3);
});

test("main refuses to fork without --run and forks only when it is present", async () => {
  const source = artifact([producer("clever-harvest", "STRATEGY_SET_CHANGED", { chainId: 1 })]);
  const { deps, state } = makeDeps(source);

  const plan = await bridge.main(["node", "run-trigger-fork-poc.js"], deps);
  assert.equal(plan.status, "PLAN_ONLY");
  assert.equal(state.forks.length, 0);

  const run = await bridge.main(["node", "run-trigger-fork-poc.js", "--run"], deps);
  assert.equal(run.status, "BRIDGE_COMPLETE");
  assert.equal(state.forks.length, 1);
});

test("leakGuard rejects endpoint/url material and no artifact is written", async () => {
  const source = artifact([producer("clever-harvest", "STRATEGY_SET_CHANGED", { chainId: 1 })]);
  const { deps, state } = makeDeps(source, {
    runForkPoc: async (options) => ({
      status: "PASS",
      blocker: null,
      output: { observations: [{ label: "net", value: "https://evil.invalid" }] },
      outPath: options.outPath,
    }),
  });
  const outcome = await bridge.runBridge({ run: true }, deps);

  assert.equal(outcome.status, "FAIL_CLOSED");
  assert.equal(outcome.blocker, "OUTPUT_URL_REJECTED");
  assert.equal(state.writes.length, 0);
});

test("chain resolution honors fixed mapping, scenario declaration, and evidence fallback", () => {
  const declared = { chainId: 999, block: "finalized", run: async () => {} };
  const withScenario = makeDeps(artifact([]), { loadScenario: () => declared, scenarioExists: () => true }).deps;
  const withoutScenario = makeDeps(artifact([]), { scenarioExists: () => false }).deps;

  const kelpArtifact = artifact([producer("kelp-composite", "TRIGGER_UNPAUSE", { chainId: 8453 })]);
  assert.equal(bridge.buildPlan(kelpArtifact, {}, withScenario).rows[0].chainId, 999);
  assert.equal(bridge.buildPlan(kelpArtifact, {}, withoutScenario).rows[0].chainId, 8453);

  const ostiumArtifact = artifact([producer("ostium-settlement-window", "WINDOW_OPEN", { chainId: 42161 })]);
  assert.equal(bridge.buildPlan(ostiumArtifact, {}, withScenario).rows[0].chainId, 42161);

  const cleverArtifact = artifact([producer("clever-harvest", "STRATEGY_SET_CHANGED", { chainId: 1 })]);
  assert.equal(bridge.buildPlan(cleverArtifact, {}, withScenario).rows[0].chainId, 1);

  const baseArtifact = artifact([producer("base-usdc-usdt-cross-venue", "ATOMIC_FORK_REQUIRED", { chainId: 1 })]);
  assert.equal(bridge.buildPlan(baseArtifact, {}, withScenario).rows[0].chainId, 8453);
  assert.equal(bridge.buildPlan(baseArtifact, {}, withoutScenario).rows[0].chainId, 8453);
});

test("at most five fired triggers are planned per run", () => {
  const producers = ["a", "b", "c", "d", "e", "f"].map((suffix) => producer(`fired-${suffix}`, "WINDOW_OPEN", { chainId: 1 }));
  const { deps } = makeDeps(artifact(producers), { loadScenario: () => ({ chainId: 1, block: "finalized", run: async () => {} }) });
  const plan = bridge.buildPlan(artifact(producers), {}, deps);

  assert.equal(plan.firedCount, 6);
  assert.deepEqual(plan.rows.map((row) => row.status), ["WOULD_FORK", "WOULD_FORK", "WOULD_FORK", "WOULD_FORK", "WOULD_FORK", "SKIPPED_CAP"]);
});

test("blocked/closed/unchanged/failed/timed-out statuses never fork", async () => {
  const source = artifact([
    producer("kelp-composite", "BLOCKED_PAUSED", { chainId: 8453 }),
    producer("ostium-settlement-window", "WINDOW_CLOSED", { chainId: 42161 }),
    producer("clever-harvest", "NO_CHANGE", { chainId: 1 }),
  ]);
  const { deps, state } = makeDeps(source);
  const outcome = await bridge.runBridge({ run: true }, deps);

  assert.equal(state.forks.length, 0);
  assert.equal(state.writes.length, 1);
  assert.deepEqual(outcome.output.triggers.map((row) => row.status), ["NOT_FIRED", "NOT_FIRED", "NOT_FIRED"]);
  assert.equal(outcome.output.firedCount, 0);
});

test("net is extracted from scenario observations without fabrication", async () => {
  const source = artifact([producer("clever-harvest", "STRATEGY_SET_CHANGED", { chainId: 1 })]);

  const nullNet = makeDeps(source);
  const nullOutcome = await bridge.runBridge({ run: true }, nullNet.deps);
  assert.equal(nullOutcome.output.triggers[0].net, null);

  const valueNet = makeDeps(source, {
    runForkPoc: async (options) => ({ status: "PASS", blocker: null, output: { observations: [{ label: "net", value: "123" }] }, outPath: options.outPath }),
  });
  const valueOutcome = await bridge.runBridge({ run: true }, valueNet.deps);
  assert.equal(valueOutcome.output.triggers[0].net, "123");
});

test("plan mode also rejects leaked endpoint material", async () => {
  const source = artifact([producer("https://evil.invalid", "WINDOW_OPEN", { chainId: 1 })]);
  const { deps, state } = makeDeps(source);
  const outcome = await bridge.runBridge({ run: false }, deps);

  assert.equal(outcome.status, "FAIL_CLOSED");
  assert.equal(outcome.blocker, "OUTPUT_URL_REJECTED");
  assert.equal(state.forks.length, 0);
  assert.equal(state.writes.length, 0);
});

test("a malformed monitor artifact fails closed before any fork", async () => {
  const bad = makeDeps(artifact([]), { readArtifact: () => "not-json" });
  assert.equal((await bridge.runBridge({ run: true }, bad.deps)).blocker, "ARTIFACT_PARSE_FAILED");

  const wrongSchema = makeDeps(artifact([]), { readArtifact: () => JSON.stringify({ schema: "other/v1", producers: [] }) });
  assert.equal((await bridge.runBridge({ run: true }, wrongSchema.deps)).blocker, "ARTIFACT_INVALID");

  const unreadable = makeDeps(artifact([]), { readArtifact: () => { throw new Error("nope"); } });
  assert.equal((await bridge.runBridge({ run: true }, unreadable.deps)).blocker, "ARTIFACT_READ_FAILED");
});
