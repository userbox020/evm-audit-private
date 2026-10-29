"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const fsp = fs.promises;
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const monitor = require("./monitor-venus-psr-multichain.js");
const bnbControls = require("./capture-venus-psr-bnb-controls.js");

const ROOT = path.resolve(__dirname, "..");
const FIXTURES = {
  bnb: {
    artifact: require(path.join(ROOT, "reports/raw/fast/venus-psr-bnb-fixed-block.json")),
  },
  ethereum: {
    artifact: require(path.join(ROOT, "reports/raw/fast/venus-psr-ethereum-fixed-block.json")),
    supplement: require(path.join(ROOT, "reports/raw/fast/venus-psr-ethereum-vtreasury-source-binding.json")),
  },
  arbitrum: {
    artifact: require(path.join(ROOT, "reports/raw/fast/venus-psr-arbitrum-fixed-block.json")),
    supplement: require(path.join(ROOT, "reports/raw/fast/venus-psr-arbitrum-vtreasury-source-binding.json")),
  },
};

const clone = (value) => JSON.parse(JSON.stringify(value));
let BASELINES;
let CONTROL_BASELINE;
let CONTROL_PROFILE;

function syntheticControlArtifact(mode = "HISTORICAL_BASELINE", block = { number: bnbControls.FIXED_BLOCK, hash: bnbControls.FIXED_HASH }) {
  const destinations = CONTROL_PROFILE.destinationBindings.map((binding) => ({
    destination: binding.destination,
    proxyCode: clone(binding.expected.proxyCode),
    implementation: binding.expected.implementation,
    admin: binding.expected.admin,
    beacon: binding.expected.beacon,
    implementationCode: clone(binding.expected.implementationCode),
    expected: clone(binding.expected),
    getters: {
      ...Object.fromEntries(Object.entries(binding.expected.immutableGetters).map(([name, value]) => [name, { available: true, value }])),
      accessControlManager: { available: true, value: "0x0000000000000000000000000000000000000031" },
      owner: { available: true, value: "0x0000000000000000000000000000000000000032" },
    },
    authorization: {
      updateAssetsState: { decision: "PROTECTED", success: false, errorSelector: bnbControls.ACL.UnauthorizedCaller, recognizedClass: "UNAUTHORIZED_CALLER", actorMatches: true, targetMatches: null, methodMatches: null },
      executeBuyback: { decision: "PROTECTED", success: false, errorSelector: bnbControls.ACL.Unauthorized, recognizedClass: "UNAUTHORIZED", actorMatches: true, targetMatches: true, methodMatches: true },
      forwardBaseAsset: { decision: "PROTECTED", success: false, errorSelector: bnbControls.ACL.Unauthorized, recognizedClass: "UNAUTHORIZED", actorMatches: true, targetMatches: true, methodMatches: true },
      sweepToken: { decision: "PROTECTED", success: false, errorSelector: bnbControls.ACL.ErrorString, recognizedClass: "OWNABLE_CALLER_NOT_OWNER_OZ4", actorMatches: null, targetMatches: null, methodMatches: null },
    },
    bindingMatch: true,
  }));
  const controlsValue = {
    actor: { address: bnbControls.ACTOR, balance: "0", code: { present: false, lengthBytes: 0, sha256: "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }, nonce: "0", zeroState: true },
    bindingDigest: bnbControls.BOUND_PROFILE_DIGEST,
    destinations,
  };
  return {
    schema: bnbControls.SCHEMA, mode, chainId: 56, block, complete: true,
    controls: controlsValue, normalizedControlDigest: bnbControls.digest(controlsValue),
    budget: { requests: 5, elements: 141, requestCap: 8, elementCap: 180, retries: 0 },
    inputCommitments: mode === "HISTORICAL_BASELINE"
      ? { fixed: `0x${"1".repeat(64)}`, fork: `0x${"2".repeat(64)}`, binding: `0x${"3".repeat(64)}` }
      : null,
    readOnly: true, upstreamTransactions: 0,
    signedActionJustified: false, providerMaterialAbsent: true,
  };
}

test.before(async () => {
  CONTROL_PROFILE = await bnbControls.loadHistoricalProfile(ROOT);
  BASELINES = await monitor.deriveBaselines(ROOT);
  CONTROL_BASELINE = syntheticControlArtifact();
  BASELINES.bnb = monitor._test.attachBnbControlPolicy(BASELINES.bnb, CONTROL_BASELINE, true);
});

async function tempRoot() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "venus-psr-monitor-"));
  await fsp.mkdir(path.join(root, "reports", "monitor"), { recursive: true });
  return root;
}

async function copyCommittedBaselines(root) {
  for (const config of Object.values(monitor.CHAIN_CONFIG)) {
    for (const relative of [config.baseline, config.supplement].filter(Boolean)) {
      const target = path.join(root, relative);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.copyFile(path.join(ROOT, relative), target);
    }
  }
  const controls = monitor.BNB_CONTROL_COMMITMENT.path;
  const target = path.join(root, controls);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.copyFile(path.join(ROOT, controls), target);
}

function inventory() {
  return Buffer.from([
    "BNB primary https://bnb.secret.invalid",
    "ETHEREUM primary https://ethereum.secret.invalid",
    "ARBITRUM primary https://arbitrum.secret.invalid",
  ].join("\n"));
}

function parsers() {
  return {
    bnb: () => ["https://bnb.secret.invalid"],
    ethereum: () => ["https://ethereum.secret.invalid"],
    arbitrum: () => ["https://arbitrum.secret.invalid"],
  };
}

function captures(mutators = {}, failures = {}) {
  return Object.fromEntries(Object.keys(FIXTURES).map((key) => [key, async () => {
    if (failures[key]) return {
      ok: false,
      artifact: null,
      summary: { status: "CAPTURE_REJECTED", failure: { errorClass: failures[key] } },
    };
    const artifact = clone(FIXTURES[key].artifact);
    if (mutators[key]) mutators[key](artifact);
    return { ok: true, artifact, summary: { status: "CAPTURE_VALIDATED" } };
  }]));
}

function workerFactory(captureSet, events = [], controlMutators = {}) {
  return (key, candidates, options) => {
    const worker = new EventEmitter();
    worker.terminated = false;
    worker.exited = false;
    worker.terminate = async () => {
      events.push(`terminate:${key}`);
      worker.terminated = true;
      if (!worker.exited) {
        worker.exited = true;
        worker.emit("exit", 1);
      }
      events.push(`terminated:${key}`);
      return 1;
    };
    setImmediate(async () => {
      try {
        const result = await captureSet[key](candidates, options);
        if (worker.terminated) return;
        if (key === "bnb" && result?.ok) {
          result.controlArtifact = clone(CONTROL_BASELINE);
          result.controlArtifact.mode = "CURRENT_MONITOR";
          result.controlArtifact.inputCommitments = null;
          result.controlArtifact.block = {
            number: result.artifact.chain.selectedFinalizedBlock.number,
            hash: result.artifact.chain.selectedFinalizedBlock.hash.toLowerCase(),
          };
          if (controlMutators.bnb) {
            controlMutators.bnb(result.controlArtifact);
            result.controlArtifact.normalizedControlDigest = bnbControls.digest(result.controlArtifact.controls);
          }
        }
        worker.emit("message", result);
      } catch {
        if (worker.terminated) return;
        worker.emit("error", new Error("reflected provider detail"));
      }
      if (!worker.terminated && !worker.exited) {
        worker.exited = true;
        worker.emit("exit", 0);
      }
    });
    return worker;
  };
}

function dependencies(root, options = {}) {
  const captureSet = options.captures || captures(options.mutators, options.failures);
  return {
    root,
    now: options.now || (() => Date.parse("2026-08-06T12:00:00.000Z")),
    baselines: options.baselines || BASELINES,
    readInventory: options.readInventory || (async () => inventory()),
    parsers: options.parsers || parsers(),
    workerFactory: options.workerFactory || workerFactory(captureSet, options.events, options.controlMutators),
    ethereumFallbackCandidates: ["https://fallback.secret.invalid"],
    ...options.extra,
  };
}

async function attempt(root, options = {}, dependencyOptions = {}) {
  return monitor.runAttempt({
    useAuthorizedInventory: true,
    checkOnly: options.checkOnly ?? true,
    intervalSeconds: 3600,
    allowPublicEthereumFallback: options.allowPublicEthereumFallback === true,
  }, dependencies(root, dependencyOptions));
}

test("baseline capture is clear and stable counters and pins are ignored", async () => {
  const root = await tempRoot();
  const state = await attempt(root, {}, {
    mutators: {
      bnb: (artifact) => {
        artifact.capturedAt = "2030-01-01T00:00:00.000Z";
        artifact.budget.requests = 31;
        artifact.chain.selectedFinalizedBlock.number += 1;
        artifact.chain.selectedFinalizedBlock.hash = `0x${"a".repeat(64)}`;
      },
    },
  });
  assert.equal(state.status, "CLEAR");
  assert.deepEqual(Object.values(state.chains).map((row) => row.status), ["CLEAR", "CLEAR", "CLEAR"]);
  assert.equal(monitor.containsProviderMaterial(state), false);
});

test("approved baseline commitments are exact and documented", async () => {
  assert.equal(monitor.BASELINE_COMMITMENTS.bnb.topologyDigest, "0xa6bba633be71acc0bacaff141d8e1e6b955ea3c2748589f33af9d47ccf6ccdc5");
  assert.equal(monitor.BASELINE_COMMITMENTS.bnb.normalizedDigest, "0x02a45b9aa3eb957c5e6e712b2f3980f3a2fa79d241fbc57af133a888bebd93d9");
  assert.equal(monitor.BASELINE_COMMITMENTS.ethereum.normalizedDigest, "0x4b3edd3f7b22552e7a47e75f83b7becada33b1e9f987fd72d760d23a6af3eb89");
  assert.equal(monitor.BASELINE_COMMITMENTS.arbitrum.normalizedDigest, "0x492a1389a8d1763931c60df17ff31ff488fb8c6d5fdd5a521619a4e19941322a");
  assert.equal(monitor.BNB_CONTROL_COMMITMENT.rawSha256, "0xa250869da77728f0367ac25d83b7c5b3721a660cc1fa0f54d191ceda7718472a");
  assert.equal(monitor.BNB_CONTROL_COMMITMENT.normalizedControlDigest, "0x5335acaf90769337356cdfc80bd198980d5097431239d806cd66d841f9e694ce");
  const loaded = await monitor.loadBaselines(ROOT);
  assert.equal(loaded.bnb.digest, monitor.BASELINE_COMMITMENTS.bnb.normalizedDigest);
  const topology = await monitor.deriveBaselines(ROOT);
  assert.equal(topology.bnb.digest, monitor.BASELINE_COMMITMENTS.bnb.topologyDigest);
});

for (const mutation of ["coherent-rebase", "supplement", "wrong-pin", "control-byte", "control-reformat", "control-digest"]) {
  test(`${mutation} fails baseline commitment before inventory access`, async () => {
    const root = await tempRoot();
    await copyCommittedBaselines(root);
    if (mutation.startsWith("control-")) {
      const relative = monitor.BNB_CONTROL_COMMITMENT.path;
      const file = path.join(root, relative);
      const value = JSON.parse(await fsp.readFile(file, "utf8"));
      if (mutation === "control-byte") {
        value.controls.destinations[0].getters.owner.value = "0x0000000000000000000000000000000000000099";
        await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      } else if (mutation === "control-reformat") {
        await fsp.writeFile(file, JSON.stringify(value), "utf8");
      } else {
        value.normalizedControlDigest = `0x${"7".repeat(64)}`;
        await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      }
    } else if (mutation === "supplement") {
      const relative = monitor.CHAIN_CONFIG.ethereum.supplement;
      const value = JSON.parse(await fsp.readFile(path.join(root, relative), "utf8"));
      value.exactRuntimeBinding.sha256 = `0x${"9".repeat(64)}`;
      await fsp.writeFile(path.join(root, relative), JSON.stringify(value), "utf8");
    } else {
      const relative = monitor.CHAIN_CONFIG.bnb.baseline;
      const value = JSON.parse(await fsp.readFile(path.join(root, relative), "utf8"));
      value.chain.selectedFinalizedBlock.number += 1;
      value.chain.terminalRecheck.number = value.chain.selectedFinalizedBlock.number;
      if (mutation === "coherent-rebase") {
        value.chain.selectedFinalizedBlock.hash = `0x${"8".repeat(64)}`;
        value.chain.terminalRecheck.hash = value.chain.selectedFinalizedBlock.hash;
      }
      await fsp.writeFile(path.join(root, relative), JSON.stringify(value), "utf8");
    }
    let inventoryOpened = false;
    const deps = dependencies(root, { readInventory: async () => { inventoryOpened = true; return inventory(); } });
    delete deps.baselines;
    await assert.rejects(
      monitor.runAttempt({ useAuthorizedInventory: true, checkOnly: false, intervalSeconds: 3600 }, deps),
      /BASELINE_COMMITMENT_FAILED/,
    );
    assert.equal(inventoryOpened, false);
    await assert.rejects(fsp.stat(path.join(root, "reports", "monitor", "venus-psr-state.json")));
  });
}

test("CLI baseline preflight precedes lock creation and inventory", async () => {
  const root = await tempRoot();
  await copyCommittedBaselines(root);
  const relative = monitor.CHAIN_CONFIG.arbitrum.baseline;
  const value = JSON.parse(await fsp.readFile(path.join(root, relative), "utf8"));
  value.chain.selectedFinalizedBlock.number += 1;
  await fsp.writeFile(path.join(root, relative), JSON.stringify(value), "utf8");
  let locked = false;
  let opened = false;
  const output = [];
  const result = await monitor.runCli(["--once", "--use-authorized-inventory"], {
    root,
    acquireLock: async () => { locked = true; return async () => true; },
    readInventory: async () => { opened = true; return inventory(); },
    writeStdout: (text) => output.push(text),
  });
  assert.equal(result.exitCode, 1);
  assert.equal(locked, false);
  assert.equal(opened, false);
  assert.match(output.join(""), /BASELINE_COMMITMENT_FAILED/);
});

const DRIFTS = {
  PSR_IDENTITY: {
    bnb: (artifact) => { artifact.proxy.eip1967.adminSlot = "0x0000000000000000000000000000000000000002"; },
  },
  PSR_CONFIGURATION: {
    bnb: (artifact) => { artifact.getters.poolRegistry.value = "0x0000000000000000000000000000000000000002"; },
  },
  DISTRIBUTION: {
    ethereum: (artifact) => { artifact.distribution.rows[0].percentage = 9999; },
  },
  POSITIVE_DESTINATIONS: {
    arbitrum: (artifact) => { artifact.destinations[0].eip1967.adminSlot = "0x0000000000000000000000000000000000000002"; },
  },
  DESTINATION_CONTROLS: {
    ethereum: (artifact) => { artifact.destinations[0].probes.conversionPaused = { available: true, value: true }; },
  },
  CONVERTER_NETWORK: {
    ethereum: (artifact) => { artifact.converterNetwork.members.push("0x0000000000000000000000000000000000000002"); },
  },
};

for (const [category, mutators] of Object.entries(DRIFTS)) {
  test(`detects ${category} drift only`, async () => {
    const root = await tempRoot();
    const state = await attempt(root, {}, { mutators });
    const row = Object.values(state.chains).find((item) => item.status === "DRIFT");
    assert.ok(row);
    assert.deepEqual(row.driftCategories, [category]);
    assert.equal(state.status, "DRIFT");
  });
}

test("detects DESTINATION_POLICY drift", async () => {
  const root = await tempRoot();
  const state = await attempt(root, {}, {
    controlMutators: { bnb: (artifact) => { artifact.controls.destinations[0].getters.owner.value = "0x0000000000000000000000000000000000000099"; } },
  });
  assert.deepEqual(state.chains.bnb.driftCategories, ["DESTINATION_POLICY"]);
});

test("missing or inconclusive BNB control result is ERROR never CLEAR", async () => {
  for (const mutate of [
    (artifact) => { artifact.complete = false; },
    (artifact) => { delete artifact.controls.destinations[0].getters.owner; artifact.complete = false; },
  ]) {
    const root = await tempRoot();
    const state = await attempt(root, {}, { controlMutators: { bnb: mutate } });
    assert.equal(state.chains.bnb.status, "ERROR");
    assert.equal(state.status, "DEGRADED");
  }
});

test("BNB control supplement must match the exact selected topology block and mode", () => {
  const current = clone(CONTROL_BASELINE);
  current.mode = "CURRENT_MONITOR";
  current.inputCommitments = null;
  current.block = clone(BASELINES.bnb.block);
  assert.doesNotThrow(() => monitor._test.attachBnbControlPolicy(BASELINES.bnb, current, false));
  current.block.hash = `0x${"8".repeat(64)}`;
  assert.throws(() => monitor._test.attachBnbControlPolicy(BASELINES.bnb, current, false), /BNB_CONTROL_SUPPLEMENT_INVALID/);
  current.block = clone(BASELINES.bnb.block);
  current.mode = "HISTORICAL_BASELINE";
  current.inputCommitments = clone(CONTROL_BASELINE.inputCommitments);
  assert.throws(() => monitor._test.attachBnbControlPolicy(BASELINES.bnb, current, false), /BNB_CONTROL_SUPPLEMENT_INVALID/);
});

test("corrected TokenBuyback mutable policy and actor leaves produce DESTINATION_POLICY drift", async () => {
  assert.deepEqual(Object.keys(CONTROL_BASELINE.controls.destinations[0].getters), bnbControls.GETTER_NAMES);
  const mutations = [
    (artifact) => { artifact.controls.destinations[0].getters.accessControlManager.value = "0x0000000000000000000000000000000000000097"; },
    (artifact) => { artifact.controls.destinations[0].getters.owner.value = "0x0000000000000000000000000000000000000098"; },
    (artifact) => { artifact.controls.actor.balance = "1"; artifact.controls.actor.zeroState = false; },
    (artifact) => { artifact.controls.actor.nonce = "1"; artifact.controls.actor.zeroState = false; },
    (artifact) => { artifact.controls.actor.code.sha256 = `0x${"7".repeat(64)}`; artifact.controls.actor.code.present = true; artifact.controls.actor.code.lengthBytes = 1; artifact.controls.actor.zeroState = false; },
  ];
  for (const mutate of mutations) {
    const root = await tempRoot();
    const state = await attempt(root, {}, { controlMutators: { bnb: mutate } });
    assert.ok(state.chains.bnb.driftCategories.includes("DESTINATION_POLICY"));
    assert.notEqual(state.chains.bnb.status, "CLEAR");
  }
});

test("bound immutable, runtime, topology and exact ACL contradictions are ERROR never drift or CLEAR", async () => {
  const mutations = [
    (artifact) => { artifact.controls.destinations[0].getters.PROTOCOL_SHARE_RESERVE.value = "0x0000000000000000000000000000000000000081"; },
    (artifact) => { artifact.controls.destinations[0].getters.BASE_ASSET.value = "0x0000000000000000000000000000000000000082"; },
    (artifact) => { artifact.controls.destinations[0].getters.DESTINATION.value = "0x0000000000000000000000000000000000000083"; },
    (artifact) => { artifact.controls.destinations[0].getters.RESILIENT_ORACLE.value = "0x0000000000000000000000000000000000000084"; },
    (artifact) => { artifact.controls.destinations[0].proxyCode.sha256 = `0x${"8".repeat(64)}`; },
    (artifact) => { artifact.controls.destinations[0].implementation = "0x0000000000000000000000000000000000000085"; },
    (artifact) => { artifact.controls.destinations[0].admin = "0x0000000000000000000000000000000000000086"; },
    (artifact) => { artifact.controls.destinations[0].beacon = "0x0000000000000000000000000000000000000087"; },
    (artifact) => { artifact.controls.destinations[0].authorization.executeBuyback.targetMatches = false; },
    (artifact) => { artifact.controls.destinations[0].authorization.forwardBaseAsset.methodMatches = false; },
    (artifact) => { artifact.controls.destinations[0].authorization.updateAssetsState.actorMatches = false; },
    (artifact) => { artifact.controls.destinations[0].authorization.sweepToken.recognizedClass = "OWNABLE_UNSUPPORTED"; },
  ];
  for (const mutate of mutations) {
    const root = await tempRoot(); const state = await attempt(root, {}, { controlMutators: { bnb: mutate } });
    assert.equal(state.chains.bnb.status, "ERROR"); assert.deepEqual(state.chains.bnb.driftCategories, []);
  }
});

test("exhaustive normalized baseline leaf mutation is categorized", () => {
  const mutateLeaf = (value) => {
    if (value === null) return "__changed__";
    if (typeof value === "boolean") return !value;
    if (typeof value === "number") return value + 1;
    if (typeof value === "string") return `${value}__changed__`;
    throw new Error("not a leaf");
  };
  for (const key of ["bnb", "ethereum", "arbitrum"]) {
    const baseline = BASELINES[key].configuration;
    const walk = (node, route = []) => {
      if (node === null || typeof node !== "object") {
        const changed = clone(baseline);
        let cursor = changed;
        for (const segment of route.slice(0, -1)) cursor = cursor[segment];
        cursor[route[route.length - 1]] = mutateLeaf(node);
        assert.notEqual(monitor.digest(changed), monitor.digest(baseline));
        assert.ok(monitor.driftCategories(baseline, changed).length > 0, `${key}:${route.join(".")}`);
        return;
      }
      for (const child of Object.keys(node)) walk(node[child], [...route, child]);
    };
    walk(baseline);
  }
});

const REOPEN_FIELD_MUTATIONS = [
  ["bnb PSR admin", "PSR_IDENTITY", { bnb: (a) => { a.proxy.eip1967.adminSlot = "0x0000000000000000000000000000000000000003"; } }],
  ["ethereum PSR admin", "PSR_IDENTITY", { ethereum: (a) => { a.psr.proxy.eip1967.adminSlot = "0x0000000000000000000000000000000000000003"; } }],
  ["arbitrum PSR admin", "PSR_IDENTITY", { arbitrum: (a) => { a.psr.proxy.eip1967.adminSlot = "0x0000000000000000000000000000000000000003"; } }],
  ["bnb poolRegistry", "PSR_CONFIGURATION", { bnb: (a) => { a.getters.poolRegistry.value = "0x0000000000000000000000000000000000000003"; } }],
  ["ethereum poolRegistry", "PSR_CONFIGURATION", { ethereum: (a) => { a.psr.getters.poolRegistry.value = "0x0000000000000000000000000000000000000003"; } }],
  ["arbitrum poolRegistry", "PSR_CONFIGURATION", { arbitrum: (a) => { a.psr.getters.poolRegistry.value = "0x0000000000000000000000000000000000000003"; } }],
  ["bnb destination admin", "POSITIVE_DESTINATIONS", { bnb: (a) => { a.destinationClassifications[0].eip1967.adminSlot = "0x0000000000000000000000000000000000000003"; } }],
  ["ethereum destination admin", "POSITIVE_DESTINATIONS", { ethereum: (a) => { a.destinations[0].eip1967.adminSlot = "0x0000000000000000000000000000000000000003"; } }],
  ["arbitrum destination admin", "POSITIVE_DESTINATIONS", { arbitrum: (a) => { a.destinations[0].eip1967.adminSlot = "0x0000000000000000000000000000000000000003"; } }],
  ["bnb destination probe", "DESTINATION_CONTROLS", { bnb: (a) => { a.destinationClassifications[0].probes.legacyConverterGetterCompatible = true; } }],
  ["ethereum destination ACM", "DESTINATION_CONTROLS", { ethereum: (a) => { a.destinations[0].probes.accessControlManager = { available: true, value: "0x0000000000000000000000000000000000000003" }; } }],
  ["arbitrum destination pause", "DESTINATION_CONTROLS", { arbitrum: (a) => { a.destinations[0].probes.conversionPaused = { available: true, value: false }; } }],
];

for (const [name, category, mutators] of REOPEN_FIELD_MUTATIONS) {
  test(`${name} cannot normalize to false CLEAR`, async () => {
    const root = await tempRoot();
    const state = await attempt(root, {}, { mutators });
    const row = Object.values(state.chains).find((item) => item.status === "DRIFT");
    assert.ok(row);
    assert.ok(row.driftCategories.includes(category));
  });
}

test("one-chain failure is isolated and produces degraded state", async () => {
  const root = await tempRoot();
  const state = await attempt(root, {}, { failures: { arbitrum: "ENDPOINT_QUALIFICATION_FAILED" } });
  assert.equal(state.status, "DEGRADED");
  assert.equal(state.chains.arbitrum.status, "ERROR");
  assert.equal(state.chains.arbitrum.errorClass, "ENDPOINT_QUALIFICATION_FAILED");
  assert.equal(state.chains.bnb.status, "CLEAR");
});

test("all-chain failure is error and never inferred clear", async () => {
  const root = await tempRoot();
  const state = await attempt(root, {}, {
    failures: { bnb: "NO_ENDPOINT", ethereum: "NO_ENDPOINT", arbitrum: "NO_ENDPOINT" },
  });
  assert.equal(state.status, "ERROR");
  assert.ok(Object.values(state.chains).every((row) => row.status === "ERROR" && row.current === null));
});

test("failed chain carries only prior safe last-success timestamp", async () => {
  const root = await tempRoot();
  const first = await attempt(root, { checkOnly: false });
  const second = await attempt(root, {}, {
    now: () => Date.parse("2026-08-06T13:00:00.000Z"),
    failures: { bnb: "NO_ENDPOINT" },
  });
  assert.equal(second.chains.bnb.lastSuccessfulAt, first.chains.bnb.lastSuccessfulAt);
  assert.deepEqual(second.chains.bnb.lastSuccessfulObservation, first.chains.bnb.lastSuccessfulObservation);
  assert.equal(second.chains.bnb.current, null);
  assert.equal(second.chains.ethereum.lastSuccessfulAt, second.attemptAt);
});

test("DRIFT to ERROR preserves unresolved drift until successful CLEAR", async () => {
  const root = await tempRoot();
  const drift = await attempt(root, { checkOnly: false }, {
    mutators: { bnb: (artifact) => { artifact.proxy.eip1967.adminSlot = "0x0000000000000000000000000000000000000009"; } },
  });
  assert.equal(drift.chains.bnb.status, "DRIFT");
  assert.deepEqual(drift.chains.bnb.unresolvedDrift, drift.chains.bnb.lastSuccessfulObservation);

  const error = await attempt(root, { checkOnly: false }, {
    now: () => Date.parse("2026-08-06T13:00:00.000Z"),
    failures: { bnb: "NO_ENDPOINT" },
  });
  assert.equal(error.chains.bnb.status, "ERROR");
  assert.deepEqual(error.chains.bnb.unresolvedDrift, drift.chains.bnb.unresolvedDrift);
  assert.deepEqual(error.chains.bnb.lastSuccessfulObservation, drift.chains.bnb.lastSuccessfulObservation);

  const clear = await attempt(root, { checkOnly: false }, {
    now: () => Date.parse("2026-08-06T14:00:00.000Z"),
  });
  assert.equal(clear.chains.bnb.status, "CLEAR");
  assert.equal(clear.chains.bnb.unresolvedDrift, null);
  assert.equal(clear.chains.bnb.lastSuccessfulObservation.status, "CLEAR");
});

test("producer validator rejects contradictory unresolved lifecycle", async () => {
  const root = await tempRoot();
  await attempt(root, { checkOnly: false }, {
    controlMutators: { bnb: (artifact) => { artifact.controls.destinations[0].getters.owner.value = "0x0000000000000000000000000000000000000099"; } },
  });
  const error = await attempt(root, {}, {
    now: () => Date.parse("2026-08-06T13:00:00.000Z"), failures: { bnb: "NO_ENDPOINT" },
  });
  const missing = clone(error); missing.chains.bnb.unresolvedDrift = null;
  assert.throws(() => monitor.validateState(missing), /STATE_CHAIN_INVALID/);
  const changed = clone(error); changed.chains.bnb.unresolvedDrift.digest = `0x${"9".repeat(64)}`;
  assert.throws(() => monitor.validateState(changed), /STATE_CHAIN_INVALID/);
  const clearPrior = clone(error);
  clearPrior.chains.bnb.lastSuccessfulObservation.status = "CLEAR";
  clearPrior.chains.bnb.lastSuccessfulObservation.driftCategories = [];
  assert.throws(() => monitor.validateState(clearPrior), /STATE_CHAIN_INVALID/);
});

test("malformed prior state is ignored safely", async () => {
  const root = await tempRoot();
  await fsp.writeFile(path.join(root, "reports", "monitor", "venus-psr-state.json"), "{", "utf8");
  const state = await attempt(root, {}, { failures: { bnb: "NO_ENDPOINT" } });
  assert.equal(state.chains.bnb.lastSuccessfulAt, null);
});

test("malformed prior unresolved drift is ignored fail-closed", async () => {
  const root = await tempRoot();
  const prior = await attempt(root, { checkOnly: false }, {
    mutators: { bnb: (artifact) => { artifact.proxy.eip1967.adminSlot = "0x0000000000000000000000000000000000000009"; } },
  });
  prior.chains.bnb.unresolvedDrift.driftCategories = ["NOT_ALLOWED"];
  await fsp.writeFile(path.join(root, "reports", "monitor", "venus-psr-state.json"), JSON.stringify(prior), "utf8");
  const state = await attempt(root, {}, { failures: { bnb: "NO_ENDPOINT" } });
  assert.equal(state.chains.bnb.lastSuccessfulObservation, null);
  assert.equal(state.chains.bnb.unresolvedDrift, null);
});

test("authorization gate leaves inventory unopened and performs no capture", async () => {
  const root = await tempRoot();
  let opened = false;
  let captured = false;
  const output = [];
  const result = await monitor.runCli(["--once"], {
    root,
    readInventory: async () => { opened = true; return inventory(); },
    captures: Object.fromEntries(Object.keys(FIXTURES).map((key) => [key, async () => { captured = true; return {}; }])),
    writeStdout: (text) => output.push(text),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(opened, false);
  assert.equal(captured, false);
  assert.match(output.join(""), /AUTHORIZATION_REQUIRED/);
});

test("check-only performs capture without publication", async () => {
  const root = await tempRoot();
  await attempt(root, { checkOnly: true });
  await assert.rejects(fsp.stat(path.join(root, "reports", "monitor", "venus-psr-state.json")));
});

test("production access boundary never opens unverified inventory", async () => {
  let opened = false;
  const root = await tempRoot();
  const state = await monitor.runAttempt({ useAuthorizedInventory: true, checkOnly: true }, {
    root,
    baselines: BASELINES,
    readPriorState: async () => null,
    readInventory: async () => { opened = true; throw new Error("must not read"); },
  });
  assert.equal(opened, false);
  assert.equal(state.status, "ERROR");
  for (const row of Object.values(state.chains)) assert.equal(row.errorClass, "ACCESS_PROVENANCE_REQUIRED");
});

test("reviewed provenance artifact unlocks committed endpoints without inventory", async () => {
  let opened = false;
  const state = await monitor.runAttempt({ useAuthorizedInventory: true, checkOnly: true }, {
    baselines: BASELINES,
    readPriorState: async () => null,
    readInventory: async () => { opened = true; throw new Error("must not read"); },
    workerFactory: () => {
      const worker = new EventEmitter();
      process.nextTick(() => {
        worker.emit("message", { ok: false, summary: { failure: { errorClass: "NO_PASSING_CANDIDATE" } } });
        worker.emit("exit", 0);
      });
      return worker;
    },
  });
  assert.equal(opened, false);
  assert.equal(state.chains.bnb.errorClass, "NO_PASSING_CANDIDATE");
  assert.equal(state.chains.arbitrum.errorClass, "NO_PASSING_CANDIDATE");
  assert.equal(state.chains.ethereum.errorClass, "ACCESS_PROVENANCE_REQUIRED");
});

test("real worker rejects arbitrary candidates before creating a thread", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "venus-psr-no-provenance-"));
  try {
    for (const key of ["bnb", "ethereum", "arbitrum"]) {
      assert.throws(() => monitor._test.createCaptureWorker(key, ["https://unverified.invalid/rpc"], {}, root),
        (error) => error.errorClass === "ACCESS_PROVENANCE_REQUIRED");
    }
    // The committed artifact endpoints pass review at the repository root.
    for (const [key, endpoint] of [
      ["bnb", "https://bsc-rpc.publicnode.com"], ["arbitrum", "https://arb1.arbitrum.io/rpc"], ["ethereum", "https://ethereum-rpc.publicnode.com"],
    ]) {
      assert.doesNotThrow(() => monitor._test.validatePublicCandidates(key, [endpoint], path.resolve(__dirname, "..")));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("direct public fallback stays single-attempt and never opens inventory", async () => {
  let calls = 0;
  const state = await monitor.runAttempt({ useAuthorizedInventory: true, allowPublicEthereumFallback: true, checkOnly: true }, {
    baselines: BASELINES,
    readPriorState: async () => null,
    readInventory: async () => { throw new Error("must not read"); },
    workerFactory: (key, candidates) => {
      calls += 1;
      const normalized = monitor._test.validatePublicCandidates(key, candidates);
      assert.deepEqual(monitor._test.validatePublicCandidates(key, normalized), normalized);
      const worker = new EventEmitter();
      process.nextTick(() => {
        worker.emit("message", { ok: false, summary: { failure: { errorClass: "NO_PASSING_CANDIDATE" } } });
        worker.emit("exit", 0);
      });
      return worker;
    },
  });
  // One attempt per chain, never a retry: ethereum via the reviewed public
  // fallback, bnb/arbitrum via the committed provenance artifact.
  assert.ok(calls === 1 || calls === 3, `expected 1 or 3 single attempts, got ${calls}`);
  assert.equal(state.chains.ethereum.errorClass, "NO_PASSING_CANDIDATE");
});

test("single-provider comparisons cannot self-promote to corroborated evidence", async () => {
  const root = await tempRoot();
  const state = await attempt(root);
  for (const row of Object.values(state.chains)) {
    assert.equal(row.current.rpcStrength, "single-provider");
    assert.equal(row.lastSuccessfulObservation.rpcStrength, "single-provider");
  }
  const promoted = clone(state);
  promoted.chains.ethereum.current.rpcStrength = "corroborated";
  assert.throws(() => monitor.validateState(promoted), (error) => error.errorClass === "STATE_RPC_STRENGTH_INVALID");
  const legacy = clone(state);
  for (const row of Object.values(legacy.chains)) {
    delete row.current.rpcStrength;
    delete row.lastSuccessfulObservation.rpcStrength;
  }
  assert.equal(monitor.validateState(legacy), true);
});

test("parser and provider reflection never reach state or stdout", async () => {
  const root = await tempRoot();
  const badParsers = parsers();
  badParsers.bnb = () => { throw new Error("https://reflected.secret.invalid C:\\secret\\rpc_endpoints.txt"); };
  const state = await attempt(root, {}, { parsers: badParsers });
  const encoded = JSON.stringify(state);
  assert.equal(state.chains.bnb.errorClass, "INVENTORY_PARSE_FAILED");
  assert.doesNotMatch(encoded, /https?:|secret|rpc_endpoints|[A-Za-z]:\\/i);
});

test("ethereum tries documented keyless fallback after inventory candidate failure", async () => {
  const root = await tempRoot();
  let ethereumCalls = 0;
  const captureSet = captures();
  captureSet.ethereum = async () => {
    ethereumCalls += 1;
    if (ethereumCalls === 1) return { ok: false, summary: { failure: { errorClass: "ENDPOINT_QUALIFICATION_FAILED" } } };
    return { ok: true, artifact: clone(FIXTURES.ethereum.artifact), summary: {} };
  };
  const state = await attempt(root, { allowPublicEthereumFallback: true }, { captures: captureSet });
  assert.equal(ethereumCalls, 2);
  assert.equal(state.chains.ethereum.status, "CLEAR");
});

test("ethereum public fallback is unavailable without its explicit flag", async () => {
  const root = await tempRoot();
  let ethereumCalls = 0;
  const captureSet = captures();
  captureSet.ethereum = async () => {
    ethereumCalls += 1;
    return { ok: false, summary: { failure: { errorClass: "ENDPOINT_QUALIFICATION_FAILED" } } };
  };
  const state = await attempt(root, {}, { captures: captureSet });
  assert.equal(ethereumCalls, 1);
  assert.equal(state.chains.ethereum.status, "ERROR");
});

test("capture timeout terminates worker before publication and lock release", async () => {
  const root = await tempRoot();
  const events = [];
  const normalFactory = workerFactory(captures(), events);
  const timeoutFactory = (key, candidates, options) => {
    if (key !== "bnb") return normalFactory(key, candidates, options);
    const worker = new EventEmitter();
    worker.terminate = async () => {
      events.push("terminate:bnb");
      await new Promise((resolve) => setTimeout(resolve, 10));
      worker.emit("exit", 1);
      events.push("terminated:bnb");
      return 1;
    };
    return worker;
  };
  const deps = dependencies(root, {
    workerFactory: timeoutFactory,
    extra: {
      captureTimeoutMs: 5,
      publishState: async () => { events.push("published"); },
      acquireLock: async () => async () => { events.push("unlocked"); return true; },
      writeStdout: () => {},
    },
  });
  const result = await monitor.runCli([
    "--once", "--use-authorized-inventory", "--lock-nonce", "44444444-4444-4444-8444-444444444444",
  ], deps);
  assert.equal(result.state.chains.bnb.errorClass, "CAPTURE_TIMEOUT");
  assert.ok(events.indexOf("terminated:bnb") < events.indexOf("published"));
  assert.ok(events.indexOf("published") < events.indexOf("unlocked"));
});

test("atomic replace publishes validated state and rejects a hardlink target", async (t) => {
  const root = await tempRoot();
  const first = await attempt(root);
  await monitor.publishAtomic(root, first);
  const output = path.join(root, "reports", "monitor", "venus-psr-state.json");
  assert.deepEqual(JSON.parse(await fsp.readFile(output, "utf8")), first);
  const replacement = clone(first);
  replacement.attemptAt = "2026-08-06T13:00:00.000Z";
  for (const row of Object.values(replacement.chains)) {
    row.attemptAt = replacement.attemptAt;
    row.lastSuccessfulAt = replacement.attemptAt;
    row.lastSuccessfulObservation.at = replacement.attemptAt;
  }
  await monitor.publishAtomic(root, replacement);
  assert.equal(JSON.parse(await fsp.readFile(output, "utf8")).attemptAt, replacement.attemptAt);
  const target = path.join(root, "hardlink.json");
  await fsp.writeFile(target, "{}", "utf8");
  await fsp.unlink(output);
  try {
    await fsp.link(target, output);
  } catch {
    t.skip("hardlinks unavailable");
    return;
  }
  await assert.rejects(monitor.publishAtomic(root, first), /PUBLICATION_TARGET_UNSAFE/);
});

test("concurrent monitor lock fails closed and releases cleanly", async () => {
  const root = await tempRoot();
  const release = await monitor.acquireLock(root);
  await assert.rejects(monitor.acquireLock(root), /MONITOR_ALREADY_RUNNING/);
  await release();
  const second = await monitor.acquireLock(root);
  await second();
});

test("lock race has one winner and wrong nonce or PID cannot delete it", async () => {
  const root = await tempRoot();
  const ownerA = { pid: process.pid, nonce: "11111111-1111-4111-8111-111111111111" };
  const ownerB = { pid: process.pid, nonce: "22222222-2222-4222-8222-222222222222" };
  const race = await Promise.allSettled([
    monitor.acquireLock(root, ownerA),
    monitor.acquireLock(root, ownerB),
  ]);
  assert.equal(race.filter((row) => row.status === "fulfilled").length, 1);
  assert.equal(race.filter((row) => row.status === "rejected").length, 1);
  const winner = race[0].status === "fulfilled" ? ownerA : ownerB;
  const release = race.find((row) => row.status === "fulfilled").value;
  assert.equal(await monitor.releaseOwnedLock(root, { pid: winner.pid + 1, nonce: winner.nonce }), false);
  assert.equal(await monitor.releaseOwnedLock(root, { pid: winner.pid, nonce: "33333333-3333-4333-8333-333333333333" }), false);
  assert.equal((await fsp.stat(path.join(root, "reports", "monitor", ".venus-psr-monitor.lock"))).isDirectory(), true);
  assert.equal(await release(), true);
});

const LOCK_RELATIVE = path.join("reports", "monitor", ".venus-psr-monitor.lock");

function deadPid() {
  const result = spawnSync(process.execPath, ["-e", "0"], { stdio: "ignore" });
  assert.ok(Number.isSafeInteger(result.pid) && result.pid > 0, "need a real exited child PID");
  return result.pid;
}

async function stageLock(root, owner, content) {
  const lock = path.join(root, LOCK_RELATIVE);
  await fsp.mkdir(lock, { recursive: true });
  if (content !== undefined) await fsp.writeFile(path.join(lock, "owner.json"), content, "utf8");
  else await fsp.writeFile(path.join(lock, "owner.json"), `${JSON.stringify(owner)}\n`, "utf8");
  return lock;
}

test("stale-lock reclamation never reclaims a live owner", async () => {
  const root = await tempRoot();
  const live = { pid: process.pid, nonce: crypto.randomUUID() };
  const lock = await stageLock(root, live);
  const before = await fsp.readFile(path.join(lock, "owner.json"), "utf8");
  await assert.rejects(monitor.acquireLock(root), /MONITOR_ALREADY_RUNNING/);
  assert.equal(await fsp.readFile(path.join(lock, "owner.json"), "utf8"), before);
  assert.equal((await fsp.stat(lock)).isDirectory(), true);
});

test("provably dead owner is reclaimed and acquisition succeeds", async () => {
  const root = await tempRoot();
  const pid = deadPid();
  assert.equal(monitor.isProcessAlive(pid), false);
  const lock = await stageLock(root, { pid, nonce: crypto.randomUUID() });
  const owner = { pid: process.pid, nonce: crypto.randomUUID() };
  const release = await monitor.acquireLock(root, owner);
  const recorded = JSON.parse(await fsp.readFile(path.join(lock, "owner.json"), "utf8"));
  assert.deepEqual(recorded, owner);
  assert.equal(await release(), true);
  assert.equal(await fsp.stat(lock).then(() => true, () => false), false);
  const entries = await fsp.readdir(path.join(root, "reports", "monitor"));
  assert.deepEqual(entries, []);
});

test("malformed or partial owner.json keeps failing closed", async () => {
  const cases = [
    "{",
    "",
    "{\"pid\":22888}",
    "{\"pid\":0,\"nonce\":\"not-a-uuid\"}",
    "{\"pid\":22888,\"nonce\":\"00000000-0000-0000-0000-000000000000\"}",
    "{}",
  ];
  for (const content of cases) {
    const root = await tempRoot();
    const lock = await stageLock(root, null, content);
    await assert.rejects(monitor.acquireLock(root), /MONITOR_ALREADY_RUNNING/);
    assert.equal((await fsp.stat(lock)).isDirectory(), true, content);
    assert.equal(await fsp.readFile(path.join(lock, "owner.json"), "utf8"), content);
  }
});

test("two concurrent reclaimers of a dead owner produce exactly one winner", async () => {
  const root = await tempRoot();
  await stageLock(root, { pid: deadPid(), nonce: crypto.randomUUID() });
  const ownerA = { pid: process.pid, nonce: "11111111-1111-4111-8111-111111111111" };
  const ownerB = { pid: process.pid, nonce: "22222222-2222-4222-8222-222222222222" };
  const race = await Promise.allSettled([
    monitor.acquireLock(root, ownerA),
    monitor.acquireLock(root, ownerB),
  ]);
  assert.equal(race.filter((row) => row.status === "fulfilled").length, 1);
  assert.equal(race.filter((row) => row.status === "rejected").length, 1);
  const winner = race[0].status === "fulfilled" ? ownerA : ownerB;
  const lock = path.join(root, LOCK_RELATIVE);
  const recorded = JSON.parse(await fsp.readFile(path.join(lock, "owner.json"), "utf8"));
  assert.equal(recorded.pid, winner.pid);
  assert.equal(recorded.nonce, winner.nonce);
  const release = race.find((row) => row.status === "fulfilled").value;
  assert.equal(await release(), true);
  assert.deepEqual(await fsp.readdir(path.join(root, "reports", "monitor")), []);
});

test("normal uncontended acquisition is unchanged", async () => {
  const root = await tempRoot();
  const owner = { pid: process.pid, nonce: crypto.randomUUID() };
  const release = await monitor.acquireLock(root, owner);
  const lock = path.join(root, LOCK_RELATIVE);
  assert.deepEqual(JSON.parse(await fsp.readFile(path.join(lock, "owner.json"), "utf8")), owner);
  assert.equal(await release(), true);
  await assert.rejects(fsp.stat(lock));
});

test("SIGTERM stops loop and invokes lock cleanup", async () => {
  const root = await tempRoot();
  const signalTarget = new EventEmitter();
  const release = await monitor.acquireLock(root);
  const deps = dependencies(root, {
    extra: {
      signalTarget,
      writeStdout: () => setImmediate(() => signalTarget.emit("SIGTERM")),
      sleep: async () => {},
    },
  });
  await monitor.runLoop({ useAuthorizedInventory: true, checkOnly: true, intervalSeconds: 300 }, deps, release);
  assert.equal(signalTarget.listenerCount("SIGINT"), 0);
  assert.equal(signalTarget.listenerCount("SIGTERM"), 0);
  const second = await monitor.acquireLock(root);
  await second();
});

test("canonical digest is deterministic across object key order", () => {
  assert.equal(monitor.digest({ b: 2, a: { d: 4, c: 3 } }), monitor.digest({ a: { c: 3, d: 4 }, b: 2 }));
  assert.notEqual(monitor.digest({ a: 1 }), monitor.digest({ a: 2 }));
});

test("baseline files and provided baseline objects are never mutated", async () => {
  const root = await tempRoot();
  const beforeObjects = crypto.createHash("sha256").update(JSON.stringify(FIXTURES)).digest("hex");
  const paths = Object.values(monitor.CHAIN_CONFIG).flatMap((config) => [config.baseline, config.supplement].filter(Boolean));
  const beforeFiles = await Promise.all(paths.map(async (relative) => crypto.createHash("sha256").update(await fsp.readFile(path.join(ROOT, relative))).digest("hex")));
  await attempt(root);
  const afterObjects = crypto.createHash("sha256").update(JSON.stringify(FIXTURES)).digest("hex");
  const afterFiles = await Promise.all(paths.map(async (relative) => crypto.createHash("sha256").update(await fsp.readFile(path.join(ROOT, relative))).digest("hex")));
  assert.equal(afterObjects, beforeObjects);
  assert.deepEqual(afterFiles, beforeFiles);
});

test("CLI interval bounds are strict and loop check-only remains nonpublishing", async () => {
  assert.throws(() => monitor.parseCli(["--interval-seconds", "299"]), /INTERVAL_INVALID/);
  assert.throws(() => monitor.parseCli(["--interval-seconds", "86401"]), /INTERVAL_INVALID/);
  assert.throws(() => monitor.parseCli(["--lock-nonce", "wrong"]), /LOCK_NONCE_INVALID/);
  assert.equal(monitor.parseCli(["--loop", "--interval-seconds", "300"]).intervalSeconds, 300);
  const parsed = monitor.parseCli(["--loop", "--check-only", "--use-authorized-inventory", "--allow-public-ethereum-fallback"]);
  assert.equal(parsed.loop, true);
  assert.equal(parsed.checkOnly, true);
  assert.equal(parsed.allowPublicEthereumFallback, true);
});
