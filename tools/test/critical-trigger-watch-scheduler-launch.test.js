"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const net = require("node:net");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const scheduler = require("../run-critical-trigger-watch-scheduler.js");
const aaveWatch = require("../aave-v3-borrower-watch.js");

const stamp = "2026-10-17T00:01:00.000Z";
const dailySlots = ["a12Daily", "morphoDaily", "gmxDaily", "aaveV3Daily", "compoundV3Daily"];
const tempRoot = process.platform === "win32"
  ? path.join(process.env.LOCALAPPDATA, "Temp", "opencode") : os.tmpdir();
function initialHealth() {
  return scheduler.baseHealth({ now: () => Date.parse(stamp), pid: 4321, running: true });
}
function claimed(row, status = "PASS") {
  Object.assign(row, {
    status, lastDueAt: "2026-10-17T00:00:00.000Z", lastAttemptAt: stamp,
    nextDueAt: "2026-10-18T00:00:00.000Z", generatedAt: stamp,
    exitCode: 0, durationMs: 123, freshness: "FRESH", annotations: []
  });
}

test("startup validator accepts current five-slot health and rejects malformed health without launching", () => {
  const root = fs.mkdtempSync(path.join(tempRoot, "scheduler-launch-test-"));
  try {
    const cases = [];
    function add(name, mutate = () => {}, expected = false, expectedPid = 4321, expectedStartedAt = stamp) {
      const health = initialHealth();
      mutate(health);
      // The production scheduler is the schema oracle; ownership is checked by the launcher.
      if (expectedPid === 4321 && expectedStartedAt === stamp) {
        assert.equal(scheduler.validateHealth(health) && health.running && health.pid === expectedPid, expected, name);
      }
      cases.push({ name, health, expected, expectedPid, expectedStartedAt });
    }
    add("initial publication before dispatch", undefined, true);
    add("all five slots claimed", h => dailySlots.forEach(slot => claimed(h[slot])), true);
    for (const slot of dailySlots) {
      for (const status of ["NOT_DUE", "INFLIGHT", "INTERRUPTED", "PASS", "INCOMPLETE", "FAILED", "TIMEOUT", "ARTIFACT_INVALID", "NOT_INSTALLED"]) {
        add(`${slot} accepts ${status}`, h => claimed(h[slot], status), true);
      }
      const mutations = {
        missing: h => { delete h[slot]; },
        null: h => { h[slot] = null; },
        array: h => { h[slot] = []; },
        partial: h => { delete h[slot].freshness; },
        unknown: h => { h[slot].extra = true; },
        identity: h => { h[slot].id = "wrong-slot"; },
        status: h => { h[slot].status = "pass"; },
        statusType: h => { h[slot].status = ["NOT_DUE"]; },
        durationType: h => { h[slot].durationMs = "0"; },
        durationNegative: h => { h[slot].durationMs = -1; },
        durationUnsafe: h => { h[slot].durationMs = 9007199254740992; },
        durationFraction: h => { h[slot].durationMs = 0.5; },
        exitType: h => { h[slot].exitCode = "0"; },
        nextDueMissing: h => { h[slot].nextDueAt = null; },
        nextDueMalformed: h => { h[slot].nextDueAt = "2026-10-17"; },
        generatedMalformed: h => { h[slot].generatedAt = "yesterday"; },
        generatedType: h => { h[slot].generatedAt = 123; },
        freshnessType: h => { h[slot].freshness = null; },
        annotationsType: h => { h[slot].annotations = "MISSING"; },
        annotationsEntry: h => { h[slot].annotations = [false]; },
        partialClaim: h => { h[slot].status = "INFLIGHT"; },
        claimNotMidnight: h => { claimed(h[slot]); h[slot].lastDueAt = stamp; },
        attemptBeforeClaim: h => { claimed(h[slot]); h[slot].lastAttemptAt = "2026-10-16T23:59:59.000Z"; },
        nextDueNotTomorrow: h => { claimed(h[slot]); h[slot].nextDueAt = stamp; },
        attemptMissing: h => { claimed(h[slot]); h[slot].lastAttemptAt = null; }
      };
      for (const [name, mutate] of Object.entries(mutations)) add(`${slot} rejects ${name}`, mutate);
      if (slot !== "a12Daily") {
        for (const value of [false, "true", 1, null]) add(`${slot} rejects readOnly ${JSON.stringify(value)}`, h => { h[slot].readOnly = value; });
        add(`${slot} requires readOnly`, h => { delete h[slot].readOnly; });
      } else {
        add("A12 exact schema has no readOnly field", h => { h.a12Daily.readOnly = true; });
      }
    }
    for (const flag of ["localOnly", "sequential", "overlap", "signing", "broadcast"]) {
      add(`unsafe ${flag}`, h => { h.safety[flag] = !h.safety[flag]; });
      add(`string ${flag}`, h => { h.safety[flag] = String(h.safety[flag]); });
    }
    for (const field of ["automaticRetries", "transactionsInitiatedByScheduler"]) {
      add(`unsafe ${field}`, h => { h.safety[field] = 1; });
      add(`string ${field}`, h => { h.safety[field] = "0"; });
    }
    for (const pid of [0, -1, "4321", 4321.5, 9999]) add(`rejects PID ${JSON.stringify(pid)}`, h => { h.pid = pid; });
    add("rejects foreign owner", undefined, false, 9999);
    add("rejects foreign start time", undefined, false, 4321, "2026-10-16T00:01:00.000Z");
    add("rejects stopped health", h => { h.running = false; });
    add("rejects string running", h => { h.running = "true"; });
    add("rejects malformed generatedAt", h => { h.generatedAt = null; });
    add("rejects unknown top key", h => { h.extra = true; });
    add("rejects extra safety key", h => { h.safety.extra = true; });
    add("rejects missing safety key", h => { delete h.safety.signing; });
    add("rejects partial cycle", h => { delete h.cycle.sequence; });
    add("rejects partial discovery", h => { delete h.discovery.status; });
    add("rejects discovery status array", h => { h.discovery.status = ["NOT_DUE"]; });
    add("rejects refresh status array", h => { h.aaveV4BinderRefresh.status = ["NOT_DUE"]; });
    add("rejects rotation status array", h => { h.capabilityRotation.status = ["NOT_DUE"]; });
    add("rejects partial producer", h => { delete h.producers[0].durationMs; });
    add("rejects reordered producers", h => { h.producers.reverse(); });
    add("rejects wrong producer artifact", h => { h.producers[0].artifactPath = "wrong.json"; });
    add("rejects refresh PASS with null exit", h => { h.aaveV4BinderRefresh.status = "PASS"; h.aaveV4BinderRefresh.lastAttemptAt = stamp; });
    add("rejects rotation READY with null exit", h => { h.capabilityRotation.status = "READY"; h.capabilityRotation.lastAttemptAt = stamp; });
    const fixture = path.join(root, "cases.json");
    fs.writeFileSync(fixture, JSON.stringify(cases));
    const quote = value => `'${value.replace(/'/g, "''")}'`;
    const script = `
$ErrorActionPreference = 'Stop'
$tokens = $null; $parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(${quote(path.resolve(__dirname, "../start-critical-trigger-watch-scheduler.ps1"))}, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw ($parseErrors | Out-String) }
# Load function definitions ONLY: never dot-source or execute the launcher body.
$functions = @($ast.EndBlock.Statements | Where-Object { $_ -is [System.Management.Automation.Language.FunctionDefinitionAst] })
foreach ($function in $functions) { Invoke-Expression $function.Extent.Text }
$cases = Get-Content -LiteralPath ${quote(fixture)} -Raw -Encoding UTF8 | ConvertFrom-Json
$healthPath = ${quote(path.join(root, "health.json"))}
foreach ($case in $cases) {
    $case.health | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $healthPath -Encoding UTF8
    $actual = Test-StrictHealth $healthPath $case.expectedPid $case.expectedStartedAt
    if ($actual -ne $case.expected) { throw ('Health validation mismatch: ' + $case.name + '; got ' + $actual) }
}
$validJson = $cases[0].health | ConvertTo-Json -Depth 20 -Compress
('[' + $validJson + ']') | Set-Content -LiteralPath $healthPath -Encoding UTF8
if (Test-StrictHealth $healthPath 4321 ${quote(stamp)}) { throw 'Array root accepted' }
'{' | Set-Content -LiteralPath $healthPath -Encoding UTF8
if (Test-StrictHealth $healthPath 4321 ${quote(stamp)}) { throw 'Malformed JSON accepted' }
Write-Output ('PASS PowerShell parser and ' + $cases.Count + ' health cases plus malformed JSON/array root')
`;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      encoding: "utf8", timeout: 60000, windowsHide: true
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    console.log(result.stdout.trim());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Aave daily dispatch uses exactly composite-83 args and preserves UTC/cadence/initial publication", async () => {
  const expectedArgs = ["--once", "--live", "--refresh", "--composite-83", "--rpc-url", "https://ethereum.publicnode.com/"];
  assert.deepEqual(scheduler.AAVE_V3_DAILY_SPEC.args, expectedArgs);
  assert.equal(scheduler.CADENCE_SECONDS, 900);
  assert.equal(scheduler.DAILY_CHECK_SECONDS, 60);
  const root = fs.mkdtempSync(path.join(tempRoot, "scheduler-args-test-"));
  try {
    const publications = [], calls = [];
    const instance = scheduler.createScheduler({
      workspace: root, outputPath: path.join(root, "missing-health.json"), producers: [],
      now: () => Date.parse(stamp), pid: 4321,
      exists: file => file === path.join(root, scheduler.AAVE_V3_DAILY_SPEC.command),
      publish: health => { assert.equal(scheduler.validateHealth(health), true); publications.push(health); },
      runner: async (command, options) => {
        assert.equal(publications.at(-1).aaveV3Daily.status, "INFLIGHT");
        calls.push({ command, options });
        return { exitCode: 1, durationMs: 0, timedOut: false };
      }
    });
    instance.publishInitial();
    assert.equal(publications[0].aaveV3Daily.status, "NOT_DUE");
    assert.equal(calls.length, 0);
    assert.equal(await instance.runAaveV3DailyDue(), true);
    assert.deepEqual(calls, [{ command: path.join(root, scheduler.AAVE_V3_DAILY_SPEC.command), options: {
      id: "aave-v3-borrower-watch", daily: true, readOnly: true, args: expectedArgs
    } }]);
    assert.equal(await instance.runAaveV3DailyDue(), false);
    assert.equal(calls.length, 1);
    assert.equal(instance.health.aaveV3Daily.nextDueAt, "2026-10-18T00:00:00.000Z");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function blockNetwork(t) {
  let attempts = 0;
  const blocked = () => { attempts++; throw new Error("NETWORK_FORBIDDEN"); };
  t.mock.method(net.Socket.prototype, "connect", blocked);
  t.mock.method(globalThis, "fetch", blocked);
  t.after(() => assert.equal(attempts, 0, "no socket or fetch calls allowed"));
}

function cohortHash(list) {
  return crypto.createHash("sha256").update(`${JSON.stringify(list, null, 2)}\n`).digest("hex");
}

async function mockedAaveCapture(list = aaveWatch.allFourChainsList(), failure = null) {
  const setup = aaveWatch.fixtureSetup({ rows: list.map(row => ({
    chainId: row.chainId, userNumber: BigInt(row.user), hf: "1050000000000000000"
  })) });
  if (failure) {
    const original = setup.sendByChain[42161];
    setup.sendByChain[42161] = async (method, params) => {
      if (failure === "unavailable" && method === "eth_call") throw new Error("RPC_FAILURE");
      if (failure === "wrong-chain" && method === "eth_chainId") return "0x1";
      if (failure === "pin-drift" && method === "eth_getBlockByNumber" && params[0] !== "finalized") {
        return { ...(await original(method, params)), hash: `0x${"f".repeat(64)}` };
      }
      return original(method, params);
    };
  }
  // Exercise the producer's saved live envelope using synthetic send functions only.
  // No CLI, persistence, default transport, or network endpoint is invoked.
  const artifact = await aaveWatch.capture({ watchList: setup.watchList, sendByChain: setup.sendByChain, mode: "live" });
  artifact.generatedAt = stamp;
  artifact.timing.completedAt = stamp;
  assert.doesNotMatch(JSON.stringify(artifact), /https?:\/\//);
  return artifact;
}

async function dispatchAaveArtifact(artifact, result = { exitCode: 0, durationMs: 1, timedOut: false }) {
  const artifactPath = path.join(scheduler.WORKSPACE, scheduler.AAVE_V3_DAILY_SPEC.artifactPath);
  let bytes, calls = 0;
  const publications = [];
  const missing = () => { throw Object.assign(new Error("MOCK_MISSING"), { code: "ENOENT" }); };
  const instance = scheduler.createScheduler({
    workspace: scheduler.WORKSPACE, outputPath: path.join(tempRoot, "scheduler-memory-only-health.json"),
    producers: [], now: () => Date.parse(stamp), pid: 4321,
    // Never fall through to real monitor files (including scheduler prior state).
    fsImpl: {
      lstatSync: file => file === artifactPath && bytes
        ? { isFile: () => true, isSymbolicLink: () => false, size: bytes.length } : missing(),
      readFileSync: file => file === artifactPath && bytes ? bytes : missing()
    },
    exists: file => file === path.join(scheduler.WORKSPACE, scheduler.AAVE_V3_DAILY_SPEC.command),
    publish: health => { assert.equal(scheduler.validateHealth(health), true); publications.push(health); },
    runner: async (command, options) => {
      calls++;
      assert.equal(command, path.join(scheduler.WORKSPACE, scheduler.AAVE_V3_DAILY_SPEC.command));
      assert.deepEqual(options.args, scheduler.AAVE_V3_DAILY_SPEC.args);
      assert.equal(options.readOnly, true);
      assert.equal(publications.at(-1).aaveV3Daily.status, "INFLIGHT");
      if (artifact !== undefined) bytes = Buffer.from(typeof artifact === "string" ? artifact : JSON.stringify(artifact));
      if (result instanceof Error) throw result;
      return result;
    }
  });
  instance.publishInitial();
  assert.equal(publications[0].aaveV3Daily.status, "NOT_DUE");
  assert.equal(await instance.runAaveV3DailyDue(), true);
  assert.equal(await instance.runAaveV3DailyDue(), false, "no same-day automatic retry");
  assert.equal(calls, 1);
  assert.equal(instance.health.aaveV3Daily.nextDueAt, "2026-10-18T00:00:00.000Z");
  return instance.health.aaveV3Daily;
}

test("Aave scheduler accepts the exact ordered composite-83 producer capture", async t => {
  blockNetwork(t);
  const list = aaveWatch.allFourChainsList();
  const artifact = await mockedAaveCapture(list);
  assert.equal(list.length, 83);
  assert.deepEqual(Object.fromEntries([1, 42161, 10, 137].map(id => [id, list.filter(row => row.chainId === id).length])),
    { 1: 27, 42161: 2, 10: 27, 137: 27 });
  assert.deepEqual(artifact.borrowers.map(({ chainId, chain, market, user }) => ({ chainId, chain, market, user })), list);
  assert.equal(artifact.identity.watchListSha256, cohortHash(list));
  assert.equal(artifact.status, "COMPLETE");
  assert.equal(artifact.diagnostics.rpcCount, 16);
  assert.equal(artifact.diagnostics.maxRequests, 40);
  assert.equal(artifact.diagnostics.perUserCallCap, 4);
  const row = await dispatchAaveArtifact(artifact);
  assert.equal(row.status, "PASS");
  assert.equal(row.freshness, "VALID_FRESH");
  assert.equal(row.generatedAt, stamp);
  assert.ok(row.annotations.includes("REVIEW_NOTE: AAVE_V3_NON_ZERO_OBSERVATIONS_REVIEW_ONLY"));
  assert.ok(!row.annotations.includes("AAVE_V3_CAPTURE_INVALID"));
});

test("Aave scheduler rejects old cohorts, identity/order/hash/budget changes and unsafe captures", async t => {
  blockNetwork(t);
  const complete = await mockedAaveCapture();
  const old = await mockedAaveCapture(aaveWatch.defaultList());
  assert.equal(old.borrowers.length, 27);
  assert.equal((await dispatchAaveArtifact(old)).status, "ARTIFACT_INVALID");
  const mutations = {
    "wrong user with approved hash": a => { a.borrowers[0].user = `0x${"1".repeat(40)}`; },
    "wrong chain": a => { a.borrowers[0].chainId = 10; },
    "wrong chain name": a => { a.borrowers[0].chain = "Optimism"; },
    "wrong Pool": a => { a.borrowers[0].market = `0x${"1".repeat(40)}`; },
    "wrong order with approved hash": a => { [a.borrowers[0], a.borrowers[1]] = [a.borrowers[1], a.borrowers[0]]; },
    "wrong self-hashed cohort": a => {
      a.borrowers[0].user = `0x${"1".repeat(40)}`;
      a.identity.watchListSha256 = cohortHash(a.borrowers.map(({ chainId, chain, market, user }) => ({ chainId, chain, market, user })));
    },
    "wrong cohort hash": a => { a.identity.watchListSha256 = "0".repeat(64); },
    "old request budget": a => { a.diagnostics.maxRequests = 30; },
    "larger request budget": a => { a.diagnostics.maxRequests = 41; },
    "old per-user cap": a => { a.diagnostics.perUserCallCap = 3; },
    "larger per-user cap": a => { a.diagnostics.perUserCallCap = 5; },
    "request overflow": a => { a.diagnostics.rpcCount = a.diagnostics.networkRequestCount = 41; },
    "network count mismatch": a => { a.diagnostics.networkRequestCount--; },
    "automatic retries": a => { a.diagnostics.retries = 1; },
    "wrong producer": a => { a.identity.producer = "other.js"; },
    "wrong protocol": a => { a.identity.protocol = "Other"; },
    "dry-run provenance": a => { a.mode = "dry-run"; },
    "fixture provenance": a => { a.fixtureId = "synthetic"; },
    "changed enforcement": a => { a.enforcement = "other"; },
    "non-finalized pin": a => { a.pins[1].requested = "latest"; },
    "invalid pin": a => { a.pins[1].valid = false; },
    "unverified chain": a => { a.pins[1].chainIdVerified = false; },
    "missing hash recheck": a => { a.pins[1].rechecked = false; },
    "malformed pin hash": a => { a.pins[1].hash = "0x12"; },
    "negative fixed head": a => { a.pins[1].number = -1; },
    "changed getter HF": a => { a.borrowers[0].hfWad = "0"; },
    "changed getter hash": a => { a.borrowers[0].read.sha256 = "0".repeat(64); },
    "malformed getter bytes": a => { a.borrowers[0].read.returnData = "0x12"; },
    "incorrect completion count": a => { a.crossSectionSummary.completeCount--; },
    "endpoint leak": a => { a.provenance.provider = "https://offline.invalid/"; }
  };
  for (const flag of Object.keys(complete.safety)) {
    mutations[`unsafe ${flag}`] = a => { a.safety[flag] = !a.safety[flag]; };
  }
  for (const [name, mutate] of Object.entries(mutations)) {
    await t.test(name, async () => {
      const artifact = structuredClone(complete);
      mutate(artifact);
      const row = await dispatchAaveArtifact(artifact);
      assert.equal(row.status, "ARTIFACT_INVALID");
      assert.equal(row.freshness, "SCHEMA_INVALID");
      assert.ok(row.annotations.includes("AAVE_V3_CAPTURE_INVALID"));
    });
  }
});

test("Aave partial/error captures remain incomplete or failed, never successful zeros", async t => {
  blockNetwork(t);
  for (const failure of ["unavailable", "wrong-chain", "pin-drift"]) {
    const partial = await mockedAaveCapture(undefined, failure);
    assert.equal(partial.status, "INCOMPLETE");
    assert.equal(partial.crossSectionSummary.completeCount, 81);
    assert.equal(partial.crossSectionSummary.incompleteCount, 2);
    assert.equal(partial.pins[42161].valid, false);
    for (const exitCode of [0, 1]) {
      const row = await dispatchAaveArtifact(partial, { exitCode, durationMs: 1, timedOut: false });
      assert.equal(row.status, "INCOMPLETE");
      assert.equal(row.freshness, "VALID_FRESH");
      assert.ok(row.annotations.includes("AAVE_V3_CAPTURE_INCOMPLETE_NOT_ZERO"));
      assert.ok(row.annotations.includes("REVIEW_NOTE: AAVE_V3_NON_ZERO_OBSERVATIONS_REVIEW_ONLY"));
    }
    const forged = structuredClone(partial);
    forged.status = "COMPLETE";
    forged.crossSectionSummary.partial = false;
    assert.equal((await dispatchAaveArtifact(forged)).status, "ARTIFACT_INVALID");
  }
  const complete = await mockedAaveCapture();
  assert.equal((await dispatchAaveArtifact(complete, { exitCode: 1, durationMs: 1, timedOut: false })).status, "FAILED");
  assert.equal((await dispatchAaveArtifact(complete, { exitCode: null, durationMs: 1, timedOut: true })).status, "TIMEOUT");
  assert.equal((await dispatchAaveArtifact(undefined)).status, "ARTIFACT_INVALID");
  assert.equal((await dispatchAaveArtifact("{" )).freshness, "MALFORMED");
  assert.equal((await dispatchAaveArtifact(undefined, new Error("MOCK_CHILD_FAILURE"))).status, "FAILED");
  for (const [offset, freshness] of [[-1000, "VALID_FRESH"], [-27 * 60 * 60 * 1000, "VALID_STALE"], [1000, "FUTURE_TIMESTAMP"]]) {
    const artifact = structuredClone(complete);
    artifact.generatedAt = new Date(Date.parse(stamp) + offset).toISOString();
    const row = await dispatchAaveArtifact(artifact);
    assert.equal(row.status, "ARTIFACT_INVALID", "capture must be generated inside this dispatch window");
    assert.equal(row.freshness, freshness);
  }
});

const savedMorphoPath = "reports/raw/fast/morpho-cbbtc-watch/multi-20261018T045723195Z-b52754285-3dc16c58e6760a3f.json";
function savedMorphoCapture() {
  const bytes = fs.readFileSync(path.join(scheduler.WORKSPACE, savedMorphoPath));
  const manifest = JSON.parse(fs.readFileSync(path.join(scheduler.WORKSPACE, savedMorphoPath.replace(/\.json$/, ".manifest.json"))));
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  assert.equal(digest, "36c65401697303cfff0659724f8c6867453c73e9b106931202ceb20d3473ae02");
  assert.equal(manifest.schema, "morpho-multi-watch-manifest/v1");
  assert.equal(manifest.artifact, savedMorphoPath);
  assert.equal(manifest.sha256, digest);
  assert.equal(manifest.bytes, bytes.length);
  return JSON.parse(bytes);
}

async function dispatchMorphoArtifact(artifact, { exitCode = 0, timedOut = false, nowMs = Date.parse(artifact.generatedAt) } = {}) {
  const artifactPath = path.join(scheduler.WORKSPACE, scheduler.MORPHO_DAILY_SPEC.artifactPath);
  const listPath = path.join(scheduler.WORKSPACE, scheduler.MORPHO_DAILY_SPEC.watchListPath);
  const listBytes = fs.readFileSync(listPath);
  let bytes, calls = 0;
  const missing = () => { throw Object.assign(new Error("MOCK_MISSING"), { code: "ENOENT" }); };
  const read = file => file === listPath ? listBytes : file === artifactPath && bytes ? bytes : missing();
  const instance = scheduler.createScheduler({
    workspace: scheduler.WORKSPACE, outputPath: path.join(tempRoot, "scheduler-memory-only-morpho-health.json"),
    producers: [], now: () => nowMs, pid: 4321,
    fsImpl: {
      lstatSync: file => ({ isFile: () => true, isSymbolicLink: () => false, size: read(file).length }),
      readFileSync: read
    },
    exists: file => file === path.join(scheduler.WORKSPACE, scheduler.MORPHO_DAILY_SPEC.command),
    publish: health => { assert.equal(scheduler.validateHealth(health), true); },
    runner: async (command, options) => {
      calls++;
      assert.equal(command, path.join(scheduler.WORKSPACE, scheduler.MORPHO_DAILY_SPEC.command));
      assert.deepEqual(options.args, scheduler.MORPHO_DAILY_SPEC.args);
      assert.equal(options.readOnly, true);
      assert.equal(instance.health.morphoDaily.status, "INFLIGHT");
      bytes = Buffer.from(JSON.stringify(artifact));
      return { exitCode, durationMs: 1, timedOut };
    }
  });
  instance.publishInitial();
  assert.equal(await instance.runMorphoDailyDue(), true);
  assert.equal(await instance.runMorphoDailyDue(), false, "same UTC claim must not retry");
  assert.equal(calls, 1);
  return instance.health.morphoDaily;
}

test("Morpho scheduler accepts the existing immutable five-pair real capture offline", async t => {
  blockNetwork(t);
  const artifact = savedMorphoCapture();
  assert.equal(artifact.status, "COMPLETE");
  assert.equal(artifact.watchList.length, 5);
  assert.equal(artifact.entries.length, 5);
  assert.equal(artifact.diagnostics.rpcCount, 22);
  assert.equal(artifact.diagnostics.maxRpcRequests, 25);
  const row = await dispatchMorphoArtifact(artifact);
  assert.equal(row.status, "PASS");
  assert.equal(row.freshness, "VALID_FRESH");
  assert.equal(row.generatedAt, "2026-10-18T04:57:23.195Z");
  assert.ok(row.annotations.includes("MORPHO_NON_ZERO_OBSERVATIONS_REVIEW_ONLY"));
  assert.ok(!row.annotations.includes("MORPHO_CAPTURE_INVALID"));
});

test("Morpho scheduler rejects corrupted values, identities, budgets, pins and unsafe captures", async t => {
  blockNetwork(t);
  const complete = savedMorphoCapture();
  const mutations = {
    "old four-pair selection": a => { a.watchList.pop(); a.entries.pop(); },
    "untrusted watch list": a => { a.watchList[0].borrower = `0x${"1".repeat(40)}`; a.entries[0].identity.borrower = a.watchList[0].borrower; },
    "entry order": a => { [a.entries[0], a.entries[1]] = [a.entries[1], a.entries[0]]; },
    "borrower identity": a => { a.entries[0].identity.borrower = `0x${"1".repeat(40)}`; },
    "market identity": a => { a.entries[0].identity.marketId = a.entries[1].identity.marketId; },
    "chain identity": a => { a.entries[0].identity.chainId = 1; },
    "loan token": a => { a.entries[0].identity.loanToken = `0x${"1".repeat(40)}`; },
    "collateral token": a => { a.entries[0].identity.collateralToken = `0x${"1".repeat(40)}`; },
    "oracle identity": a => { a.entries[0].identity.oracle = `0x${"1".repeat(40)}`; },
    "request budget": a => { a.diagnostics.maxRpcRequests = 26; },
    "request overflow": a => { a.diagnostics.rpcCount = a.diagnostics.requestCount = 26; },
    "count mismatch": a => { a.diagnostics.requestCount--; },
    "entry budget": a => { a.entries[0].diagnostics.maxRpcRequests = 26; },
    "retries": a => { a.diagnostics.retries = 1; },
    "getter value": a => { a.entries[0].reads.position.values.collateral = "1"; },
    "getter hash": a => { a.entries[0].reads.position.sha256 = "0".repeat(64); },
    "getter bytes": a => { a.entries[0].reads.position.returnData = "0x12"; },
    "getter target": a => { a.entries[0].reads.price.target = `0x${"1".repeat(40)}`; },
    "computed HF": a => { a.entries[0].metrics.hfWad = "0"; },
    "computed debt": a => { a.entries[0].metrics.debtRawUsdc = "0"; },
    "computed verdict": a => { a.entries[0].trigger.status = "HEALTHY"; },
    "finalized pin": a => { a.pin.finalizedHash = `0x${"0".repeat(64)}`; },
    "fixed head": a => { a.entries[0].pin.number++; },
    "hash recheck": a => { a.entries[0].pin.rechecked = false; },
    "unsafe root": a => { a.safety.signing = true; },
    "unsafe entry": a => { a.entries[0].safety.routePositive = true; },
    "endpoint leak": a => { a.entries[0].provenance.provider = "https://offline.invalid/"; },
    "false completion count": a => { a.crossPairSummary.captured--; }
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    await t.test(name, async () => {
      const artifact = structuredClone(complete);
      mutate(artifact);
      const row = await dispatchMorphoArtifact(artifact);
      assert.equal(row.status, "ARTIFACT_INVALID");
      assert.equal(row.freshness, "SCHEMA_INVALID");
    });
  }
});

test("Morpho partial/error and stale evidence cannot become a successful zero", async t => {
  blockNetwork(t);
  const partial = savedMorphoCapture();
  partial.status = "INCOMPLETE";
  partial.reason = "READ_FAILED";
  partial.pin.valid = false;
  const entry = partial.entries.at(-1);
  entry.status = "INCOMPLETE";
  entry.reason = "READ_FAILED";
  entry.metrics = null;
  entry.pin.valid = false;
  entry.trigger = { status: "INCOMPLETE", reason: "READ_FAILED" };
  partial.crossPairSummary.captured = 4;
  partial.crossPairSummary.incomplete = 1;
  Object.assign(partial.crossPairSummary.pairs.at(-1), {
    status: "INCOMPLETE", verdict: "INCOMPLETE", reason: "READ_FAILED", hf: null, hfWad: null,
    distancePct: null, oraclePriceRaw: null, thresholdOraclePriceRaw: null,
    thresholdOraclePriceUsdcPerCollateral: null, protocolLiquidatableAtPin: null
  });
  partial.crossPairSummary.closestScope = "complete-pairs-only; incomplete-pair-health-unknown";
  for (const exitCode of [0, 1]) {
    const row = await dispatchMorphoArtifact(partial, { exitCode });
    assert.equal(row.status, "INCOMPLETE");
    assert.equal(row.freshness, "VALID_FRESH");
    assert.ok(row.annotations.includes("MORPHO_CAPTURE_INCOMPLETE_NOT_ZERO"));
  }
  const complete = savedMorphoCapture();
  assert.equal((await dispatchMorphoArtifact(complete, { exitCode: 1 })).status, "FAILED");
  assert.equal((await dispatchMorphoArtifact(complete, { timedOut: true })).status, "TIMEOUT");
  const stale = await dispatchMorphoArtifact(complete, { nowMs: Date.parse(complete.generatedAt) + 27 * 60 * 60 * 1000 });
  assert.equal(stale.status, "ARTIFACT_INVALID");
  assert.equal(stale.freshness, "VALID_STALE");
});
