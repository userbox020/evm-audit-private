#!/usr/bin/env node
"use strict";

// Control-flow rehearsal only: fork PASS/net/exact-pin below are FABRICATED,
// not evidence of execution, economics, or a profitable route.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const producer = require("./run-profit-trigger-watch");
const bridge = require("./run-trigger-fork-poc");
const autopilot = require("./trigger-fork-autopilot");
const dispatcher = require("./monitor-alert-dispatcher");

const NOW = Date.parse("2026-09-28T18:00:00.000Z");
const FRAX = "frax-usdc-cross-venue";
const EVENT = "b".repeat(64);
const ROUTE = "a".repeat(64);
const PROMOTION = `fork-promotion:${FRAX}`;
const stamp = () => new Date(NOW).toISOString();

function source(fired) {
  const artifact = producer.baseArtifact(() => NOW);
  const row = artifact.producers.find((entry) => entry.id === FRAX);
  row.status = fired ? "ATOMIC_FORK_REQUIRED" : "NO_GROSS_EDGE";
  row.reason = row.status;
  row.evidence = {
    chainId: 1, blockNumberRaw: "123", blockHash: `0x${"1".repeat(64)}`,
    blockTimestamp: stamp(), routeCount: 8, failedCount: 0,
    firedCount: fired ? 1 : 0,
    candidate: fired ? {
      routeKey: ROUTE, eventId: EVENT, direction: "CURVE_TO_UNIV3",
      amountInRaw: "100000000", expectedOutRaw: "103000000", grossDeltaRaw: "3000000",
      gasCeilingUsdcRaw: "2000000", baseFeePerGasRaw: "1000000000",
      ethUsdRaw: "200000000000", curvePool: `0x${"2".repeat(40)}`,
      uniPool: `0x${"3".repeat(40)}`,
    } : null,
  };
  assert.equal(producer.validateArtifact(artifact), true, "synthetic full producer artifact must validate");
  return artifact;
}

function sandbox(t) {
  const approvedTemp = path.join(os.tmpdir(), "opencode");
  assert.equal(fs.existsSync(approvedTemp), true, "approved Temp/opencode directory is required");
  const root = fs.mkdtempSync(path.join(approvedTemp, "trigger-fork-offline-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const checked = (file) => {
    const absolute = path.resolve(file);
    const relative = path.relative(root, absolute);
    assert.ok(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
      "all filesystem paths must remain inside unique Temp sandbox");
    return absolute;
  };
  const files = {
    source: checked(path.join(root, "profit-trigger-watch.json")),
    filtered: checked(path.join(root, "filtered-source.json")),
    state: checked(path.join(root, "autopilot-state.json")),
    status: checked(path.join(root, "autopilot-status.json")),
    lock: checked(path.join(root, "autopilot.lock")),
    dispatcher: checked(path.join(root, "dispatcher.json")),
    scenarios: checked(path.join(root, "scenarios")),
    forks: checked(path.join(root, "forks")),
  };
  const save = (file, value) => {
    const target = checked(file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(value)}\n`, { flag: "w" });
  };
  const load = (file) => JSON.parse(fs.readFileSync(checked(file), "utf8"));
  // TEST-ONLY synthetic completeness provenance; never attest production state.
  save(files.state, { schema: autopilot.STATE_SCHEMA,
    eventJournal: { completeness: "EXPLICIT_ATTESTATION", provenance: "EXTERNAL_RECONCILIATION", attestedAt: stamp() },
    updatedAt: stamp(), events: {}, routeCooldowns: {}, history: [] });
  return { files, checked, save, load };
}

function lifecycle(box, { fakeForkResult = "PASS" } = {}) {
  const { files, checked, save, load } = box;
  const effects = { forks: [], reservations: [], releases: 0, deliveries: [] };
  const scenario = checked(path.join(files.scenarios, `${FRAX}.js`));
  const scenarioExists = (file) => checked(file) === scenario;
  const loadScenario = (file) => {
    assert.equal(checked(file), scenario);
    // Metadata only; there is deliberately no scenario runner or require(file).
    return { chainId: 1, block: "123" };
  };
  const planBridge = (artifact) => bridge.buildPlan(artifact, { triggersDir: files.scenarios }, {
    triggersDir: files.scenarios, scenarioExists, loadScenario,
  });
  const runBridge = (filtered) => {
    assert.equal(filtered.producers.length, 1);
    assert.equal(filtered.producers[0].id, FRAX);
    save(files.filtered, filtered);
    return bridge.runBridge({ artifactPath: files.filtered, triggersDir: files.scenarios, run: true }, {
      now: () => NOW,
      readArtifact: (file) => fs.readFileSync(checked(file), "utf8"),
      writeArtifact: (file, value) => save(file, value),
      triggersDir: files.scenarios, outDir: files.forks, scenarioExists, loadScenario,
      runForkPoc: async (options) => {
        assert.equal(checked(options.scenario), scenario);
        checked(options.outPath);
        assert.equal(options.chain, "1");
        assert.equal(options.block, "123");
        assert.equal(options.scenarioInput.candidate.eventId, EVENT);
        const journal = load(files.state);
        const event = journal.events[`${FRAX}:ATOMIC_FORK_REQUIRED:${EVENT}`];
        assert.equal(event.phase, "RESERVED", "durable reservation must precede fake fork");
        assert.equal(event.terminal, true);
        assert.equal(event.attempts, 1);
        assert.equal(load(files.status).classification, "EXECUTING");
        effects.reservations.push(event);
        effects.forks.push(options);
        const net = fakeForkResult === "PASS"
          ? { routePositive: true, exactPin: true, fabricated: true }
          : { routePositive: false, exactPin: false, fabricated: true };
        save(options.outPath, { fabricated: true, status: fakeForkResult, net });
        return {
          status: fakeForkResult, blocker: fakeForkResult === "PASS" ? null : "FAKE_FORK_FAILED",
          output: { observations: [{ label: "net", value: net }] },
        };
      },
    });
  };
  const autopilotDeps = {
    now: () => NOW,
    readSource: () => fs.readFileSync(checked(files.source), "utf8"),
    readState: () => load(files.state),
    planBridge, runBridge,
    acquireLock: () => {
      const file = checked(files.lock);
      fs.writeFileSync(file, "fake-lock\n", { flag: "wx" });
      return { acquired: true, release: () => { fs.unlinkSync(file); effects.releases += 1; } };
    },
    writeArtifacts: ({ state, status }) => {
      if (state) save(files.state, state);
      if (status) save(files.status, status);
    },
    write: () => { throw new Error("CLI output is not part of this test"); },
  };
  let priorState = null;
  let priorQueue = null;
  const dispatch = (profitTrigger, triggerForkAutopilot) => {
    const result = dispatcher.runDispatcher({
      apply: true, clock: () => NOW, priorState, priorQueue,
      inputs: { profitTrigger, triggerForkAutopilot,
        autopilotHealth: { generatedAt: stamp(), services: [], triggerStatus: { status: "clear", triggered: 0 } } },
      delivery: (alert) => { effects.deliveries.push(alert); return "DELIVERED"; },
      write: (output) => save(files.dispatcher, output),
    });
    priorState = result.state;
    priorQueue = result.queue;
    assert.deepEqual(load(files.dispatcher).status.summary, result.status.summary);
    return result;
  };
  return { effects, autopilotDeps, dispatch, planBridge };
}

test("no fire: valid source plans no fork and cannot promote or alert", async (t) => {
  const box = sandbox(t);
  const input = source(false);
  box.save(box.files.source, input);
  const flow = lifecycle(box);
  assert.equal(flow.planBridge(input).firedCount, 0);
  const result = await autopilot.runAutopilot({ apply: true }, flow.autopilotDeps);
  assert.equal(result.status.classification, "FAIL_CLOSED");
  assert.equal(result.status.blocker, "EPOCH_OWNER_REQUIRED");
  assert.equal(result.executed, 0);
  assert.equal(flow.effects.forks.length, 0);
  const alert = flow.dispatch(input, result.status);
  assert.equal(alert.candidates.length, 0);
  assert.equal(alert.queue.alerts.length, 0);
  assert.equal(flow.effects.deliveries.length, 0);
  assert.equal(flow.effects.releases, 0);
});

test("historical FABRICATED PASS cannot bypass held default APPLY or promote; replay remains inert", async (t) => {
  const box = sandbox(t);
  const flow = lifecycle(box);
  const quiet = source(false);
  box.save(box.files.source, quiet);
  const baseline = await autopilot.runAutopilot({ apply: true }, flow.autopilotDeps);
  assert.equal(flow.dispatch(quiet, baseline.status).queue.alerts.length, 0);

  const fired = source(true);
  box.save(box.files.source, fired);
  const plan = flow.planBridge(fired);
  assert.equal(plan.firedCount, 1);
  assert.equal(plan.rows.find((row) => row.producerId === FRAX).status, "WOULD_FORK");
  const run = await autopilot.runAutopilot({ apply: true }, flow.autopilotDeps);
  assert.equal(flow.effects.forks.length, 0);
  assert.equal(flow.effects.reservations.length, 0);
  assert.equal(run.status.blocker, "EPOCH_OWNER_REQUIRED");
  assert.equal(run.status.execution, null);
  assert.deepEqual(box.load(box.files.state).events, {});
  const alert = flow.dispatch(fired, run.status);
  assert.deepEqual(alert.candidates.map((entry) => entry.key), []);
  assert.deepEqual(flow.effects.deliveries.map((entry) => entry.key), []);
  assert.equal(alert.status.summary.delivered, 0);

  const replay = await autopilot.runAutopilot({ apply: true }, flow.autopilotDeps);
  assert.equal(replay.status.blocker, "EPOCH_OWNER_REQUIRED");
  assert.equal(replay.status.plan.length, 0);
  assert.equal(replay.executed, 0);
  assert.equal(flow.effects.forks.length, 0, "no default event may fork");
  assert.equal(flow.effects.deliveries.length, 0);
  assert.equal(flow.effects.releases, 0);
});

test("historical FABRICATED failed fork cannot bypass held default APPLY or mutate the ledger", async (t) => {
  const box = sandbox(t);
  const flow = lifecycle(box, { fakeForkResult: "FAIL" });
  const quiet = source(false);
  box.save(box.files.source, quiet);
  const baseline = await autopilot.runAutopilot({ apply: true }, flow.autopilotDeps);
  flow.dispatch(quiet, baseline.status);

  const fired = source(true);
  box.save(box.files.source, fired);
  const run = await autopilot.runAutopilot({ apply: true }, flow.autopilotDeps);
  assert.equal(flow.effects.forks.length, 0);
  assert.equal(flow.effects.reservations.length, 0);
  assert.equal(run.status.blocker, "EPOCH_OWNER_REQUIRED");
  assert.equal(run.status.execution, null);
  assert.deepEqual(box.load(box.files.state).events, {});
  const alert = flow.dispatch(fired, run.status);
  assert.equal(alert.candidates.some((entry) => entry.key === PROMOTION), false);
  assert.equal(alert.queue.alerts.length, 0);
  assert.equal(flow.effects.deliveries.length, 0);
  const replay = await autopilot.runAutopilot({ apply: true }, flow.autopilotDeps);
  assert.equal(replay.executed, 0);
  assert.equal(flow.effects.forks.length, 0);
  assert.equal(flow.effects.releases, 0);
});
