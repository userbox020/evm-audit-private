"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const monitorPath = path.join(__dirname, "..", "monitor-novelty-conditions.js");
const disabledRoutesPath = path.join(__dirname, "..", "autopilot-disabled-routes.js");
const source = fs.readFileSync(monitorPath, "utf8");
const disabledRoutesSource = fs.readFileSync(disabledRoutesPath, "utf8");
const {
  forceMonitorOnlyAuthorization,
  beginCycleHealth,
  recordCycleSource,
  finalizeCycleHealth,
  getLiveEthPrice,
  setE23HardStop,
} = require(monitorPath);
const { buildArtifact } = require(disabledRoutesPath);
const monitorEnv = require(path.join(__dirname, "..", "monitor-minimal-env.js"));

function visit(value, callback, pathParts = []) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    callback(key, child, [...pathParts, key]);
    visit(child, callback, [...pathParts, key]);
  }
}

test("monitor source has no environment-file or private-key access", () => {
  assert.doesNotMatch(source, /\.env(?:\.exploit)?/i);
  assert.doesNotMatch(source, /PRIVATE_KEY/);
  assert.doesNotMatch(source, /\.privateKey\b/);
  assert.doesNotMatch(source, /new\s+ethers\.Wallet\s*\(/);
  assert.doesNotMatch(source, /\.execute\s*\(/);
  assert.doesNotMatch(source, /sendTransaction\s*\(/);
});

test("main path rejects auto execution and never dispatches an executor", () => {
  assert.match(source, /const autoExecute = false;/);
  assert.match(source, /--auto-execute is permanently disabled; refusing to start/);
  assert.doesNotMatch(source, /cp\.spawn\s*\(/);
  assert.doesNotMatch(source, /monitor-[^"']*executor/i);
});

test("spawnSync uses one minimal allowlisted environment and never forwards the parent environment", () => {
  assert.equal((source.match(/cp\.spawnSync\s*\(/g) || []).length, 1);
  assert.match(source, /env:\s*minimalChildEnv\(\)/);
  assert.doesNotMatch(source, /env\s*:\s*\{\s*\.\.\./);
  assert.doesNotMatch(source, /env\s*:\s*(?:process\.env|runtimeConfig)\b/);
  assert.doesNotMatch(source, /Object\.assign\s*\([^)]*(?:process\.env|runtimeConfig)/);
  assert.match(source, /\["SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP"\]/);
  assert.doesNotMatch(source, /NODE_OPTIONS|NODE_PATH|PRIVATE_KEY|MNEMONIC|SEED_PHRASE/);
});

test("EVM monitor cannot transitively invoke or query Solana and E21 is fresh-artifact-only", () => {
  assert.doesNotMatch(source, /KAMINO_MONITOR_SCRIPT|KAMINO_TIMEOUT_MS|targets["',\\/\s]+kamino/i);
  assert.doesNotMatch(source, /monitor-liquidation-window\.js/i);
  assert.doesNotMatch(source, /https?:\/\/[^"'\s]*solana/i);
  assert.match(source, /Evaluator 21: Kamino Liquidation Window \(artifact-only, fail-closed\)/);
  assert.match(source, /readArtifactFile\(KAMINO_WINDOW_ARTIFACT/);
  assert.doesNotMatch(source, /spawnSync\([^;]*(?:kamino|solana)/is);
});

test("machine-readable monitor fields cannot authorize execution", () => {
  for (const match of source.matchAll(/autoExecutable\s*:\s*([^,\n}]+)/g)) {
    assert.equal(match[1].trim(), "false", match[0]);
  }
  assert.doesNotMatch(source, /routeGuard/);
  assert.doesNotMatch(source, /MORPHO_EXPLOIT_SIGNED_EXECUTION_ENABLED/);
  assert.doesNotMatch(source, /auto-enabled|auto-exec eligible/i);

  const value = forceMonitorOnlyAuthorization({
    autoExecutable: true,
    executableNow: true,
    executionEnabled: true,
    signedActionJustified: true,
    nested: [{ autoExecutable: true }, { candidatePositive: true }],
  });
  assert.equal(value.autoExecutable, false);
  assert.equal(value.executableNow, false);
  assert.equal(value.executionEnabled, false);
  assert.equal(value.signedActionJustified, false);
  assert.equal(value.nested[0].autoExecutable, false);
  assert.equal(value.nested[1].candidatePositive, true);
});

test("authorization sanitizer recursively closes execution aliases and preserves observational telemetry", () => {
  const value = forceMonitorOnlyAuthorization({
    executable: true,
    routeCandidatePositive: true,
    routeGuard: { authorized: true },
    nested: [{
      status: "ARMED",
      executableNow: 7,
      executableNowCount: 2,
      autoExecutableWhenTriggered: true,
      liveExecutorReady: true,
      signedActions: 3,
      candidatePositive: true,
    }],
  });

  assert.equal(value.executable, false);
  assert.equal(value.routeCandidatePositive, true);
  assert.equal(value.observedRouteCandidateSignal, true);
  assert.equal(Object.hasOwn(value, "routeGuard"), false);
  assert.equal(value.nested[0].status, "watch-only-upstream-signal-observed");
  assert.equal(value.nested[0].executableNow, false);
  assert.equal(typeof value.nested[0].executableNow, "boolean");
  assert.equal(value.nested[0].executableNowCount, 0);
  assert.equal(typeof value.nested[0].executableNowCount, "number");
  assert.equal(value.nested[0].autoExecutableWhenTriggered, false);
  assert.equal(value.nested[0].liveExecutorReady, false);
  assert.equal(value.nested[0].signedActions, false);
  assert.equal(value.nested[0].candidatePositive, true);
  assert.equal(value.nested[0].observedUpstreamAuthorizationSignal, true);

  const reparsed = JSON.parse(JSON.stringify(value));
  assert.equal(reparsed.nested[0].executableNow, false);
  assert.equal(typeof reparsed.nested[0].executableNow, "boolean");
  assert.equal(reparsed.nested[0].executableNowCount, 0);
  assert.equal(typeof reparsed.nested[0].executableNowCount, "number");
  const persisted = JSON.stringify(reparsed);
  assert.doesNotMatch(persisted, /"(?:executable|autoExecutable|autoExecutableWhenTriggered|signedActionJustified)":true/);
  assert.doesNotMatch(persisted, /"executableNow(?:Count)?":[1-9]/);
  assert.doesNotMatch(persisted, /"(?:status|gateStatus)":"[^"]*(?:armed|executable|auto-enabled)/i);
  assert.doesNotMatch(persisted, /"routeGuard"/);

  const oddTypes = JSON.parse(JSON.stringify(forceMonitorOnlyAuthorization({
    executable: 1,
    executableNow: "1",
    executableNowCount: true,
    signedActionJustified: 0,
  })));
  assert.equal(oddTypes.executable, false);
  assert.equal(typeof oddTypes.executable, "boolean");
  assert.equal(oddTypes.executableNow, false);
  assert.equal(typeof oddTypes.executableNow, "boolean");
  assert.equal(oddTypes.executableNowCount, 0);
  assert.equal(typeof oddTypes.executableNowCount, "number");
  assert.equal(oddTypes.signedActionJustified, false);
  assert.equal(typeof oddTypes.signedActionJustified, "boolean");
});

test("cycle health is recreated per cycle and fails closed on failed or unknown source evidence", () => {
  const state = {
    cycleHealth: {
      status: "HEALTHY",
      complete: true,
      sources: [{ group: "carried", status: "HEALTHY" }],
    },
  };
  const cycle = beginCycleHealth(state, true, Date.parse("2026-08-25T12:00:00.000Z"));
  assert.equal(state.cycleHealth, cycle);
  assert.equal(cycle.cycleType, "fast");
  assert.deepEqual(cycle.sources, []);
  assert.deepEqual(cycle.sourceSummary, { total: 0, healthy: 0, failed: 0, unknown: 0 });
  assert.equal(cycle.complete, false);

  recordCycleSource(cycle, "rpc", "HEALTHY");
  recordCycleSource(cycle, "oracle", "FAILED");
  recordCycleSource(cycle, "artifact", "UNKNOWN");
  finalizeCycleHealth(cycle, { completed: true, nowMs: Date.parse("2026-08-25T12:00:01.000Z") });
  assert.equal(cycle.status, "FAILED");
  assert.equal(cycle.complete, true);
  assert.equal(cycle.broadlyFailed, true);
  assert.equal(cycle.blind, false);
  assert.deepEqual(cycle.sourceSummary, { total: 3, healthy: 1, failed: 1, unknown: 1 });

  const unknown = beginCycleHealth(state, false, Date.parse("2026-08-25T12:05:00.000Z"));
  assert.equal(unknown.cycleType, "full");
  assert.deepEqual(unknown.sources, []);
  finalizeCycleHealth(unknown, { completed: true });
  assert.equal(unknown.status, "FAILED");
  assert.equal(unknown.blind, true);
  assert.equal(unknown.complete, true);
});

test("live ETH price failure warning counter resets after a successful source response", async (t) => {
  const originalFetch = global.fetch;
  const originalLog = console.log;
  const responses = [
    { ok: false, status: 503 }, { ok: false, status: 503 },
    { ok: false, status: 503 }, { ok: false, status: 503 },
    { ok: true, json: async () => ({ ethereum: { usd: 2500 } }) },
    { ok: false, status: 503 }, { ok: false, status: 503 },
    { ok: false, status: 503 }, { ok: false, status: 503 },
  ];
  const logs = [];
  global.fetch = async () => {
    const response = responses.shift();
    if (!response) throw new Error("unexpected offline fetch");
    return { json: async () => ({}), ...response };
  };
  console.log = (line) => logs.push(String(line));
  t.after(() => {
    global.fetch = originalFetch;
    console.log = originalLog;
  });

  assert.equal(await getLiveEthPrice(), null);
  assert.equal(await getLiveEthPrice(), null);
  assert.equal(await getLiveEthPrice(), 2500);
  assert.equal(await getLiveEthPrice(), null);
  assert.equal(await getLiveEthPrice(), null);
  assert.equal(logs.filter((line) => line.includes("Both CoinGecko and Binance down")).length, 0);
});

test("disabled-route artifact is observational and all authorization gates fail closed", () => {
  assert.doesNotMatch(disabledRoutesSource, /routeGuard|auto-enabled|AUTO_LIQUIDATE\s*=\s*true/i);
  const artifact = buildArtifact();
  assert.equal(artifact.autoExecutable, false);
  assert.ok(Array.isArray(artifact.observedLowFundCandidates));
  assert.equal(Object.hasOwn(artifact, "enabledLowFundRoutes"), false);
  visit(artifact, (key, value, fieldPath) => {
    if (["autoExecutable", "executableNow", "signedActionJustified", "signedActions", "exploitExecuteCalls"].includes(key)) {
      assert.ok(value === false || value === 0, `${fieldPath.join(".")}=${value}`);
    }
  });
});

test("RPC inventory selection is bounded, concurrent, capability-qualified, and inventory-ordered", () => {
  assert.match(source, /RPC_INVENTORY_MAX_BYTES\s*=\s*512 \* 1024/);
  assert.match(source, /RPC_INVENTORY_MAX_CANDIDATES\s*=\s*64/);
  assert.match(source, /RPC_QUALIFICATION_CONCURRENCY\s*=\s*4/);
  assert.match(source, /RPC_QUALIFICATION_TIMEOUT_MS\s*=\s*4_000/);
  for (const method of ["eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getCode", "eth_call"]) {
    assert.match(source, new RegExp(`"${method}"`));
  }
  assert.match(source, /for \(const candidate of qualified\)/);
  assert.doesNotMatch(source, /qualified\.sort/);
  assert.match(source, /Public read-only\s*\n\s*\/\/ fallbacks are only filled for chains where inventory qualification failed/);
});

test("E23 hardStop clears without fresh positive evidence and reopens only for fresh positive evidence", () => {
  const state = { hardStop: true, lastResult: { stale: true } };
  assert.equal(setE23HardStop(state, false), false);
  assert.equal(state.hardStop, false);
  assert.equal(state.lastResult, null);
  assert.equal(setE23HardStop(state, true), true);
  assert.equal(state.hardStop, true);
});

test("E23, AV4, E45, and E46 have no detached or child execution path", () => {
  assert.doesNotMatch(source, /detached\s*:\s*true/);
  assert.doesNotMatch(source, /execSync\s*\(/);
  assert.doesNotMatch(source, /AUTO_EXEC/);
  assert.doesNotMatch(source, /AUTO_FORK_[A-Z_]*SCRIPT/);
});

test("monitor sanitizer preserves bounded machine diagnostic codes under unsafe keys", () => {
  const codes = ["route-stale", "readiness-stale", "reserve-link-cap"];
  const artifact = monitorEnv.forceMonitorOnlyArtifact({ sourceCoverage: { errors: codes } });
  assert.deepEqual(artifact.sourceCoverage.errors, codes);
  const reparsed = JSON.parse(JSON.stringify(artifact));
  assert.deepEqual(reparsed.sourceCoverage.errors, codes);
});

test("monitor sanitizer still scrubs adversarial strings under unsafe diagnostic keys", () => {
  const adversarial = [
    "https://rpc.invalid/path",
    "Bearer credential-value",
    "authorization: credential-value",
    "bad\u0000code",
    "a".repeat(65),
    "MixedCaseCode",
    "two words",
  ];
  const artifact = monitorEnv.forceMonitorOnlyArtifact({
    errors: adversarial,
    error: "free text under a root key",
    errorDetails: "free text under a suffixed key",
    evidence: "free text under the evidence root",
  });
  for (const value of artifact.errors) assert.equal(value, "SANITIZED_MONITOR_TEXT", value);
  assert.equal(artifact.error, "SANITIZED_MONITOR_TEXT");
  assert.equal(artifact.errorDetails, "SANITIZED_MONITOR_TEXT");
  assert.equal(artifact.evidence, "SANITIZED_MONITOR_TEXT");
});

