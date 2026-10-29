"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const manifest = require("../monitor-service-manifest");
const statusModule = require("../autopilot-status");
const runtime = require("../monitor-minimal-env");
const globalGatesProducer = require("../monitor-global-gates");
const v3RouteProducer = require("../scan-aave-v3-route-distance");
const v3ReadinessProducer = require("../audit-aave-v3-trigger-readiness");
const v3WatchProducer = require("../aave-v3-liquidation-watch");
const v4BorrowerProducer = require("../scan-aave-v4-spoke-borrowers");
const v4WatchProducer = require("../watch-aave-v4-liquidation-triggers");
const v4TopologyProducer = require("../scan-aave-v4-hubs");
const routeSweepProducer = require("../scan-route-positive-sweep");
const completionGatesProducer = require("../scan-audit-completion-gates");
const disabledRoutesProducer = require("../autopilot-disabled-routes");
const triggerCoverageAudit = require("../audit-trigger-coverage-universe");
const hiddenDispatch = require("../monitor-hidden-dispatch");

function actualV3Inputs(recent) {
  const chainIds = [1, 8453, 42161, 10, 137, 43114, 100, 534352, 56];
  const chains = chainIds.map(chainId => ({
    chainId, observedRange: { fromBlock: 90, toBlock: 100 }, fromBlock: 90, latestBlock: 100,
    historyScope: "RECENT_BLOCK_SUFFIX", fullHistoryProven: false,
    logChunks: 1, logChunksSucceeded: 1, logChunksFailed: 0,
    borrowersDiscovered: 0, accountDataChecked: 0, accountReadsAttempted: 0,
    accountReadsSucceeded: 0, accountReadsFailed: 0, reserveReadsAttempted: 0,
    reserveReadsSucceeded: 0, reserveReadsFailed: 0, wasTruncated: false, coverageErrors: [],
  }));
  const route = { generatedAt: recent, sourceCoverage: v3RouteProducer.buildRouteSourceCoverage(chains, chainIds) };
  const tracker = { attempted: 1, succeeded: 1, failed: 0, accountAttempted: 1, accountSucceeded: 1, accountFailed: 0 };
  const readiness = { generatedAt: recent, sourceCoverage: v3ReadinessProducer.buildReadinessSourceCoverage(route, tracker) };
  return { route, readiness };
}

function actualV3MonitorCoverage(nowMs, recent) {
  const { route, readiness } = actualV3Inputs(recent);
  return v3WatchProducer.buildSourceCoverage(route, readiness, {
    nowMs, maxSourceAgeMs: 5 * 60_000, routeRefreshAttempted: true, routeRefreshOk: true,
  });
}

function actualV4MonitorCoverage(nowMs, recent) {
  const registry = v4TopologyProducer.loadAaveV4EthereumRegistry();
  const topology = v4TopologyProducer.buildTopologySourceCoverage(
    registry.hubs.map(({ address }) => ({
      address,
      assetCountReadOk: true, assetCount: 0, assetScanTruncated: false, assets: [],
    })), registry,
  );
  const raw = v4BorrowerProducer.buildSourceCoverage({
    topologyGeneratedAt: recent, topologySourceComplete: false, topologySourceSampleComplete: true,
    topologyUniverse: topology.topologyUniverse,
    spokeReserveLinks: topology.spokeReserveLinks,
    upstreamCoverage: topology,
    chainsExpected: 1, chainsObserved: 1, spokesExpected: 0, spokesObserved: 0,
    observedRange: { fromBlock: 90, toBlock: 100 }, historyScope: "RECENT_BLOCK_SUFFIX", fullHistoryProven: false,
    logChunksAttempted: 1, logChunksSucceeded: 1, logChunksFailed: 0,
    discoveredBorrowers: 0, checkedBorrowers: 0, accountReadsAttempted: 0,
    accountReadsSucceeded: 0, accountReadsFailed: 0, reserveReadsAttempted: 0,
    reserveReadsSucceeded: 0, reserveReadsFailed: 0, truncationLimit: 20, wasTruncated: false,
  }, nowMs);
  return v4WatchProducer.sourceCoverageForArtifact({ sourceCoverage: raw }, { nowMs });
}

function launcherText() {
  return fs.readFileSync(path.join(ROOT, "tools", "aave-autopilot.cmd"), "utf8");
}

function launcherInvocations(text) {
  return [...text.matchAll(/^\s*node tools\\monitor-hidden-dispatch\.js ([a-z0-9-]+)\s*$/gim)]
    .map((match) => {
      const payload = hiddenDispatch.servicePayload(match[1]);
      // Parse the actual encoded target, not an assumed copy of the manifest.
      const research = match[1] === "research-watch-build";
      let tokens = require("../monitor-set-watchdog").splitWindowsCommandLine(payload.arguments);
      if (research) {
        const command = payload.arguments.match(/^\/d \/s \/c ""([^"]+)" "([^"]+)" "([^"]+)" > reports\\monitor\\research-watch-startup\.log 2>&1 && echo completed> reports\\monitor\\research-watch-startup\.done"$/);
        assert.ok(command, "research build must retain exact redirection and success-only marker");
        assert.equal(command[1], process.execPath);
        tokens = command.slice(2);
      }
      const script = tokens[0];
      const args = tokens.slice(1);
      return {
        script: path.relative(ROOT, script).replace(/\\/g, "/").toLowerCase(),
        args,
        windowMode: "hidden",
        invocationMode: "background",
      };
    });
}

function syntheticArtifacts(nowMs, overrides = {}) {
  const recent = new Date(nowMs - 60_000).toISOString();
  const artifacts = {};
  for (const service of manifest.services) {
    if (!service.artifact) continue;
    if (service.artifact.format === "text") {
      artifacts[service.artifact.path] = { text: `${service.artifact.semantic.expectedText}\n`, mtimeMs: nowMs - 60_000 };
      continue;
    }
    let json;
    switch (service.artifact.semantic.validator) {
      case "novelty-state":
        json = {
          lastRun: recent,
          lastBlock: {},
          conditions: {
            "novelty-patterns": {
              lastResult: {
                checkedAt: recent,
                scanned: 11,
                alerts: 0,
                sourceSummary: { total: 11, healthy: 11, failed: 0, unknown: 0 },
              },
            },
          },
          cycleHealth: {
            status: "HEALTHY",
            complete: true,
            broadlyFailed: false,
            blind: false,
            sourceSummary: { total: 4, healthy: 4, failed: 0, unknown: 0 },
          },
        };
        break;
      case "morpho-ws":
        json = {
          updatedAt: recent,
          status: "RUNNING",
          chains: service.artifact.semantic.requiredChains.map((key, index) => ({
            key,
            connected: true,
            degraded: false,
            subscriptionState: "SUBSCRIBED",
            lastObservedBlock: 1000 + index,
            observationUpdatedAt: recent,
          })),
        };
        break;
      case "chainlink-ws":
        json = {
          updatedAt: recent,
          status: "RUNNING",
          feeds: service.artifact.semantic.requiredChains.map((key, index) => ({
            key,
            connection: {
              connected: true,
              degraded: false,
              subscriptionState: "SUBSCRIBED",
              lastObservedBlock: 2000 + index,
              observationUpdatedAt: recent,
            },
          })),
        };
        break;
      case "aave-v4-watch":
        json = {
          schema: v4WatchProducer.AAVE_V4_WATCH_SCHEMA,
          generatedAt: recent,
          scanner: service.script,
          sourceScanner: v4WatchProducer.SOURCE_SCANNER,
          sourceArtifact: v4WatchProducer.SOURCE_ARTIFACT,
          source: { scanner: v4WatchProducer.SOURCE_SCANNER, artifact: v4WatchProducer.SOURCE_ARTIFACT },
          sourceCoverage: actualV4MonitorCoverage(nowMs, recent),
          latest: {
            generatedAt: recent,
            sourceScanner: v4WatchProducer.SOURCE_SCANNER,
            sourceArtifact: v4WatchProducer.SOURCE_ARTIFACT,
            summary: { activeBorrowers: 0, liquidatable: 0, signedActionJustified: false },
            topRows: [],
          },
        };
        break;
      case "aave-v3-watch":
        json = {
          generatedAt: recent,
          scanner: service.script,
          cycle: 1,
          sourceCoverage: actualV3MonitorCoverage(nowMs, recent),
          latest: { forkGateCandidate: false, executableNow: false, signedActionJustified: false },
        };
        break;
      case "morpho-frozen-oracle":
        json = {
          schema: "morpho-frozen-oracle-status/read-only/v1",
          capturedAt: recent,
          mode: "watch",
          source: "local source tests, public read-only state, and one keyless public reference API",
          safety: {
            readOnly: true,
            externalStateMutations: false,
            oracleOrPoolManipulation: false,
            signing: false,
            transactions: false,
            forks: false,
            endpointValuesStored: false,
            endpointMaterialInChildArgv: false,
          },
          stalenessThresholdSeconds: 86400,
          minimumActionableLiquidityAssets: 1,
          limits: { maxMarkets: 16 },
          requestCounts: { rpcCalls: 2, referenceCalls: 1, trackedMarkets: 3 },
          summary: { TRIGGERED: 0, WATCH: 1, CLEAR: 2, REFERENCE_UNAVAILABLE: 0, ORACLE_REVERT: 0 },
          markets: [
            { chainId: 1, market: "USR/USDC", status: "CLEAR" },
            { chainId: 1, market: "RLP/USDC", status: "CLEAR" },
            { chainId: 8453, market: "USR/USDC", status: "WATCH" },
          ],
        };
        break;
      case "morpho-startup-scan":
        json = {
          schemaVersion: 2,
          generatedAt: recent,
          scanner: service.script,
          classification: "EXHAUSTIVE_COMPLETE",
          complete: true,
          blocker: null,
          currentBlock: 1000,
          logQuerySuccessful: true,
          marketsAttempted: 2,
          marketsSuccessfullyChecked: 2,
          positionsAttempted: 4,
          positionsSuccessfullyChecked: 4,
          errors: 0,
          coverage: {
            currentBlock: 1000,
            logQuerySuccessful: true,
            observedRange: { fromBlock: 0, toBlock: 1000 },
            historyScope: "GENESIS_TO_TIP",
            historyStartBound: { block: 0, kind: "genesis", proven: true, proof: "genesis" },
            fullHistoryProven: true,
            caps: { borrowLogs: 500, borrowersPerMarket: 30 },
            borrowLogs: { discovered: 4, processed: 4, omittedByCap: 0, malformed: 0, wasTruncated: false },
            markets: { discoveryScope: "processedBorrowLogs", discovered: 2, attempted: 2, resolved: 2, unresolved: 0 },
            borrowers: { discoveryScope: "processedBorrowLogs", discoveredUnique: 4, discoveredMarketBorrowerPairs: 4, selectedForCheck: 4, omittedByCap: 0, wasTruncated: false },
            positions: { discovered: 4, selectedForCheck: 4, readAttempts: 4, successfullyChecked: 4, readFailures: 0, unchecked: 0, uncheckedDueToBorrowerCap: 0, uncheckedDueToUnresolvedMarket: 0 },
            reads: {
              attempts: 12,
              successes: 12,
              failures: 0,
              byKind: {
                blockNumber: { attempts: 1, successes: 1, failures: 0 },
                borrowLogs: { attempts: 1, successes: 1, failures: 0 },
                marketParams: { attempts: 2, successes: 2, failures: 0 },
                marketState: { attempts: 2, successes: 2, failures: 0 },
                oraclePrice: { attempts: 2, successes: 2, failures: 0 },
                position: { attempts: 4, successes: 4, failures: 0 },
              },
            },
            operationalFailures: 0,
            errors: 0,
          },
          results: { liquidatablePositionsFound: 0, valuationStatus: "unavailable", valuationEvidence: null, promotionEligible: false, liquidatablePositions: [] },
        };
        break;
      case "global-gates":
        json = {
          generatedAt: recent,
          scanner: service.script,
          summary: { status: "watching-no-executable-gates", gateRefreshOk: true, confirmationOk: true, routePositive: 0, executableNow: false, executableNowCount: 0, signedActionJustified: false, hardStop: false },
        };
        break;
      case "e1-proximity":
        json = { generatedAt: recent, scanner: service.script, metrics: { feedAgeSeconds: 1, divergencePercent: 0 }, gates: { triggered: false, executableNow: false }, statusLevel: "NOMINAL" };
        break;
      case "venus-psr":
        json = {
          schema: "venus-psr-state/v1",
          attemptAt: recent,
          status: "CLEAR",
          readOnly: true,
          upstreamTransactions: 0,
          signedActionJustified: false,
          chains: Object.fromEntries(service.artifact.semantic.requiredChains.map(key => [key, { status: "CLEAR" }])),
        };
        break;
      case "supervisor-health":
        json = { generatedAt: recent, scanner: service.script, summary: { status: "observational" }, safetyStatus: { status: "ok" } };
        break;
      case "disabled-routes":
        json = { generatedAt: recent, scanner: service.script, summary: { observedLowFundCandidates: 1, disabledRoutes: 1, executableNow: false, executableNowCount: 0, signedActionJustified: false, hardStop: false }, observedLowFundCandidates: [{}], disabledRoutes: [{}] };
        break;
      default:
        throw new Error(`missing synthetic artifact fixture: ${service.id}`);
    }
    artifacts[service.artifact.path] = { json, mtimeMs: nowMs - 60_000 };
  }
  for (const spec of manifest.dataArtifacts) {
    let json;
    if (spec.semantic.validator === "route-sweep") {
      json = { generatedAt: recent, scanner: "tools/scan-route-positive-sweep.js", summary: { routePositive: 0, executableNow: false, executableNowCount: 0, signedActionJustified: false, hardStop: false }, ranked: [] };
    } else if (spec.semantic.validator === "trigger-coverage-audit") {
      const universeBytes = fs.readFileSync(triggerCoverageAudit.UNIVERSE_PATH);
      const universe = JSON.parse(universeBytes.toString("utf8"));
      json = {
        schema: triggerCoverageAudit.AUDIT_SCHEMA,
        auditedAt: recent,
        universeSha256: triggerCoverageAudit.sha256(universeBytes),
        rows: universe.rows.map(row => ({
          id: row.id,
          status: row.onFire.enabled ? "COVERED" : "BLOCKED",
          observedAt: recent,
          expiresAt: row.onFire.enabled ? new Date(nowMs + row.freshnessSeconds * 1000).toISOString() : null,
          artifactPath: row.artifactPath,
          artifactSha256: row.onFire.enabled ? "a".repeat(64) : null,
          evidence: [row.onFire.enabled ? "synthetic complete coverage evidence" : "synthetic current blocker evidence"],
          blockers: row.onFire.enabled ? [] : ["synthetic dispatch-disabled blocker"],
        })),
        done: true,
      };
    } else {
      json = { generatedAt: recent, scanner: "tools/scan-audit-completion-gates.js", summary: { status: "watch-ready", completeForNow: true, routePositive: 0, executableNow: false, executableNowCount: 0, signedActionJustified: false, hardStop: false } };
    }
    artifacts[spec.path] = { json, mtimeMs: nowMs - 60_000 };
  }
  return Object.assign(artifacts, overrides);
}

function persistentProcessRows() {
  return manifest.persistentServices.map((service, index) => ({
    pid: 9000 + index,
    commandLine: `node ${service.script} ${service.args.join(" ")} synthetic-secret-marker-${index}`,
  }));
}

function nodeInvocationForms(script, trailingArgs = "") {
  const basename = path.win32.basename(script);
  const absolute = path.join(ROOT, ...script.split("/"));
  const suffix = trailingArgs ? ` ${trailingArgs}` : "";
  return [
    `node.exe ${script}${suffix}`,
    `node ${script.replace(/\//g, "\\")}${suffix}`,
    `"C:\\Program Files\\nodejs\\node.exe" "${absolute}"${suffix}`,
    `node --trace-warnings --require synthetic-preload ${script}${suffix}`,
    `node --no-warnings ${basename}${suffix}`,
  ];
}

test("manifest is unique and launcher uses each exact service argument list and mode", () => {
  assert.equal(manifest.validateManifest(), true);
  assert.equal(new Set(manifest.services.map((row) => row.id)).size, manifest.services.length);
  assert.deepEqual(manifest.summary(), { persistent: 10, scheduled: 3, optionalScheduled: 1, total: 13 });

  for (const name of ["aave-autopilot.cmd", "monitor-set-autostart.cmd"]) {
    const text = fs.readFileSync(path.join(ROOT, "tools", name), "utf8");
    const invocations = launcherInvocations(text);
    assert.deepEqual(invocations, manifest.services.map(service => ({
    script: service.script.toLowerCase(),
    args: service.args,
    windowMode: "hidden",
    invocationMode: "background",
    })));
    assert.doesNotMatch(text, /\/MIN|^\s*start\s+/im);
  }
  assert.ok(manifest.services.every(service => service.mode === "read-only"));
});

test("launcher is monitor-only and contains the exact direct Aave watches", () => {
  const text = launcherText();
  assert.match(text, /EVM AUDIT - Read-Only Monitor Launcher/);
  assert.match(text, /Updated: 2026-08-25/);
  assert.match(text, /monitor-hidden-dispatch\.js aave-v4-owner-watch/);
  assert.match(text, /monitor-hidden-dispatch\.js aave-v3-liquidation-watch/);
  assert.deepEqual(launcherInvocations(text).find(row => row.script === "tools/watch-aave-v4-liquidation-triggers.js").args, ["--iterations", "1000000", "--interval-ms", "300000", "--no-quotes", "--no-sweep", "--quiet"]);
  assert.deepEqual(launcherInvocations(text).find(row => row.script === "tools/aave-v3-liquidation-watch.js").args, ["--until-trigger", "--interval-ms", "60000"]);
  assert.match(text, /READ-ONLY SERVICES LAUNCHED/);
  assert.match(text, /%PERSISTENT_TOTAL% persistent \+ %SCHEDULED_TOTAL% scheduled/);

  const forbidden = [
    /\.env\.exploit/i,
    /private_key/i,
    /auto-execute/i,
    /auto-exploit/i,
    /bot armed/i,
    /\barmed\b/i,
    /aave-v3-autopilot\.js/i,
    /monitor-morpho-executor\.js/i,
    /monitor-aave-v3-executor\.js/i,
    /monitor-auto-liquidate\.js/i,
    /monitor-solana-liquidations\.js/i,
    /autopilot-action-queue\.js/i,
    /aave-autopilot\.js/i,
    /%\*/,
  ];
  for (const pattern of forbidden) assert.doesNotMatch(text, pattern);
  const reservation = text.indexOf("node tools\\autopilot-status.js --reserve-launch");
  const firstStart = text.search(/^\s*node tools\\monitor-hidden-dispatch/im);
  assert(reservation >= 0 && reservation < firstStart, "launch reservation must precede every background start");
});

test("forbidden process denylist fails closed with sanitized assertions", () => {
  assert.deepEqual(manifest.forbiddenProcessScripts, [
    "tools/aave-autopilot.js",
    "tools/aave-v3-autopilot.js",
    "tools/monitor-morpho-executor.js",
    "tools/monitor-aave-v3-executor.js",
    "tools/monitor-auto-liquidate.js",
    "tools/monitor-solana-liquidations.js",
    "tools/autopilot-action-queue.js",
  ]);
  const nowMs = Date.parse("2026-08-25T12:00:00.000Z");
  for (const forbidden of manifest.forbiddenProcessScripts) {
    const processes = [...persistentProcessRows(), { pid: 12345, commandLine: `node ${forbidden} secret-command-material` }];
    const status = statusModule.buildStatus(1, "2026-08-25T11:59:00.000Z", {
      nowMs,
      processes,
      artifactMap: syntheticArtifacts(nowMs),
      scriptExists: () => true,
    });
    assert.equal(status.summary.safetyStatus, "fail-closed");
    assert(status.summary.failedAssertionIds.includes("forbidden-processes-absent"));
    const encoded = JSON.stringify(status);
    assert.doesNotMatch(encoded, /secret-command-material/);
    assert.doesNotMatch(encoded, /aave-autopilot|aave-v3-autopilot|monitor-morpho-executor|monitor-aave-v3-executor|monitor-auto-liquidate|monitor-solana-liquidations|autopilot-action-queue/);
    assert.doesNotMatch(encoded, /"pid"|commandLine/i);
  }
});

test("process script identity recognizes exact Node invocation forms without substring matches", () => {
  const persistent = manifest.persistentServices.find(service => service.script !== "tools/autopilot-status.js");
  const forbidden = manifest.forbiddenProcessScripts[0];

  for (const commandLine of nodeInvocationForms(persistent.script, "--synthetic-arg")) {
    assert.equal(statusModule.processHasScript({ commandLine }, persistent.script), true, commandLine);
    const row = statusModule.buildServiceStatuses([{ commandLine }], {
      nowMs: Date.parse("2026-08-25T12:00:00.000Z"),
      artifactMap: {},
      scriptExists: () => true,
    }).find(service => service.id === persistent.id);
    assert.equal(row.processCount, 1, commandLine);
  }

  const duplicateRows = nodeInvocationForms(persistent.script).map(commandLine => ({ commandLine }));
  const duplicate = statusModule.buildServiceStatuses(duplicateRows, {
    nowMs: Date.parse("2026-08-25T12:00:00.000Z"),
    artifactMap: {},
    scriptExists: () => true,
  }).find(service => service.id === persistent.id);
  assert.equal(duplicate.processCount, duplicateRows.length);
  assert.equal(duplicate.readiness, "duplicate-processes");

  for (const commandLine of nodeInvocationForms(forbidden)) {
    assert.deepEqual(statusModule.forbiddenProcessMatches([{ commandLine }]), [forbidden], commandLine);
  }
  for (const commandLine of [
    `node ..\\tools\\${path.win32.basename(forbidden)}`,
    `node ..\\..\\other\\${path.win32.basename(forbidden)}`,
  ]) assert.deepEqual(statusModule.forbiddenProcessMatches([{ commandLine }]), [forbidden], commandLine);

  const falsePositives = [
    `node tools/test/${path.win32.basename(persistent.script, ".js")}.test.js`,
    `node tools/${path.win32.basename(persistent.script)}.test`,
    `node tools/${path.win32.basename(persistent.script)}.backup`,
    `node tools/not-${path.win32.basename(persistent.script)}`,
    `node tools/other.js ${persistent.script}`,
    `node tools/other.js --label=${persistent.script}`,
    `node --require ${persistent.script} tools/other.js`,
    `node -e "require('${persistent.script}')"`,
  ];
  for (const commandLine of falsePositives) {
    assert.equal(statusModule.processHasScript({ commandLine }, persistent.script), false, commandLine);
  }
  assert.deepEqual(statusModule.forbiddenProcessMatches([
    { commandLine: `node tools/test/${path.win32.basename(forbidden, ".js")}.test.js` },
    { commandLine: `node tools/${path.win32.basename(forbidden)}.backup` },
  ]), []);
});

test("launch reservations use exact supervisor script and argument identity in every invocation form", () => {
  for (const commandLine of nodeInvocationForms("tools/autopilot-status.js", "--reserve-launch")) {
    const inspection = { ok: true, rows: [{ commandLine }] };
    assert.deepEqual(statusModule.persistentProcessMatches(inspection.rows), [], commandLine);
    assert.equal(statusModule.launchPreflightIsClear(inspection), true, commandLine);
  }

  for (const commandLine of [
    "node tools/test/autopilot-status.test.js --reserve-launch",
    "node tools/autopilot-status.js.test --reserve-launch",
    "node tools/other.js tools/autopilot-status.js --reserve-launch",
  ]) {
    assert.equal(statusModule.processHasScript({ commandLine }, "tools/autopilot-status.js"), false, commandLine);
    assert.equal(statusModule.launchPreflightIsClear({ ok: true, rows: [{ commandLine }] }), true, commandLine);
  }

  assert.equal(statusModule.launchPreflightIsClear({
    ok: true,
    rows: [{ commandLine: "node tools/autopilot-status.js --reserve-launch-extra" }],
  }), false, "reservation option matching must also be exact");
});

test("launcher preflight rejects forbidden and pre-existing persistent services", () => {
  assert.equal(statusModule.launchPreflightIsClear({ ok: true, rows: [] }), true);
  assert.equal(statusModule.launchPreflightIsClear({
    ok: true,
    rows: [{ commandLine: "node tools/monitor-morpho-executor.js synthetic-secret" }],
  }), false);
  for (const service of manifest.persistentServices) {
    const args = service.script === "tools/autopilot-status.js" ? "--watch" : service.args.join(" ");
    assert.equal(statusModule.launchPreflightIsClear({
      ok: true,
      rows: [{ commandLine: `node ${service.script} ${args}` }],
    }), false, service.id);
  }
  assert.equal(statusModule.launchPreflightIsClear({
    ok: true,
    rows: [{ commandLine: "node tools/autopilot-status.js --reserve-launch" }],
  }), true, "the current reservation command must not identify itself as a persistent supervisor");

  const source = fs.readFileSync(path.join(ROOT, "tools", "autopilot-status.js"), "utf8");
  assert.match(source, /if \(!launchPreflightIsClear\(inspection\)\) throw new Error\("launch-preflight-fail-closed"\)/);
  assert.match(source, /\$_\.Name -ieq 'node\.exe'/, "process ownership counts Node, not the cmd launcher wrapper");
  assert.doesNotMatch(source, /CommandLine -match 'tools/, "all Node command lines must reach exact script parsing");
  const text = launcherText();
  assert.match(text, /already-running persistent manifest services/);
  assert(text.indexOf("--reserve-launch") < text.search(/^\s*node tools\\monitor-hidden-dispatch/im));
});

test("every persistent service requires exactly one process", () => {
  const nowMs = Date.parse("2026-08-25T12:00:00.000Z");
  const processes = persistentProcessRows();
  const duplicate = manifest.persistentServices[0];
  processes.push({ commandLine: `node ${duplicate.script} ${duplicate.args.join(" ")}` });
  const status = statusModule.buildStatus(1, "2026-08-25T11:59:00.000Z", {
    nowMs,
    processes,
    artifactMap: syntheticArtifacts(nowMs),
    scriptExists: () => true,
  });
  const row = status.services.find((service) => service.id === duplicate.id);
  assert.equal(row.processCount, 2);
  assert.equal(row.running, false);
  assert.equal(row.readiness, "duplicate-processes");
  assert(status.summary.failedAssertionIds.includes(`service-singleton-${duplicate.id}`));
  assert(status.summary.failedAssertionIds.includes(`service-ready-${duplicate.id}`));
  assert.doesNotMatch(JSON.stringify(status), /synthetic-secret-marker|commandLine|"pid"/i);
});

test("scheduled one-shots are excluded from the persistent denominator", () => {
  const nowMs = Date.parse("2026-08-25T12:00:00.000Z");
  const status = statusModule.buildStatus(1, "2026-08-25T11:59:00.000Z", {
    nowMs,
    processes: persistentProcessRows(),
    artifactMap: syntheticArtifacts(nowMs),
    scriptExists: (script) => script !== "tools/build-monitor-research-watch.js",
  });
  assert.equal(status.summary.persistentExpected, manifest.persistentServices.length);
  assert.equal(status.summary.persistentExpected, 10);
  assert.equal(status.summary.persistentRunning, 10);
  assert.equal(status.summary.persistentReady, 10);
  assert.equal(status.summary.scheduledExpected, 3);
  assert.equal(status.summary.scheduledComplete, 2);
  assert.equal(status.summary.scheduledNotInstalled, 1);
  assert.equal(status.services.find((row) => row.id === "research-watch-build").readiness, "not-installed");
  assert.equal(status.services.find((row) => row.id === "morpho-startup-scan").running, null);
});

test("serialized V3, global-gates, and V4 producer artifacts retain canonical authorization types", () => {
  const nowMs = Date.parse("2026-08-25T12:00:00.000Z");
  const recent = new Date(nowMs - 60_000).toISOString();
  const serialize = value => JSON.parse(JSON.stringify(runtime.forceMonitorOnlyArtifact(value)));

  const { route, readiness } = actualV3Inputs(recent);
  const v3 = serialize(v3WatchProducer.latestStatus(1, recent, {
    route: { ...route, summary: {}, globalTopRows: [] },
    readiness: { ...readiness, summary: {} },
    sweep: { summary: { executableNow: false, signedActionJustified: false } },
    gates: { summary: { executableNow: false, signedActionJustified: false } },
  }, { nowMs, maxSourceAgeMs: 5 * 60_000, routeRefreshAttempted: true, routeRefreshOk: true }));
  const v3Spec = manifest.services.find(service => service.id === "aave-v3-liquidation-watch").artifact;
  assert.equal(v3.latest.executableNow, false);
  assert.equal(typeof v3.latest.executableNow, "boolean");
  assert.equal(statusModule.validateArtifactSemantics(v3Spec, v3, null, nowMs), true);

  const global = serialize(globalGatesProducer.buildStatus(1, recent, [{ ok: true }], false, null, {
    route: { summary: { routePositive: 0, executableNow: false, signedActionJustified: false } },
    gates: { summary: { status: "watch-ready", routePositive: 0, executableNow: false, signedActionJustified: false } },
    apyusdPreflight: { summary: {}, preflightChecks: {} },
  }));
  const globalSpec = manifest.services.find(service => service.id === "global-gates").artifact;
  assert.equal(global.summary.executableNow, false);
  assert.equal(typeof global.summary.executableNow, "boolean");
  assert.equal(global.summary.executableNowCount, 0);
  assert.equal(typeof global.summary.executableNowCount, "number");
  assert.equal(statusModule.validateArtifactSemantics(globalSpec, global, null, nowMs), true);

  const sourceCoverage = actualV4MonitorCoverage(nowMs, recent);
  const snapshot = {
    generatedAt: recent,
    sourceGeneratedAt: recent,
    sourceScanner: v4WatchProducer.SOURCE_SCANNER,
    sourceArtifact: v4WatchProducer.SOURCE_ARTIFACT,
    classification: sourceCoverage.classification,
    complete: sourceCoverage.complete,
    blocker: sourceCoverage.blocker,
    sourceCoverage,
    summary: {
      activeBorrowers: 0, nearLiquidation: 0, liquidatable: 0, routePositive: 0,
      triggerRows: 0, quoteRequiredRows: 0, materialTriggerRows: 0, materialRows: 0,
      signedActionJustified: false,
    },
    topRows: [],
    quoteRequiredRows: [],
  };
  const v4 = serialize(v4WatchProducer.buildWatchArtifact(snapshot, [], {}, { generatedAt: recent }));
  const v4Spec = manifest.services.find(service => service.id === "aave-v4-owner-watch").artifact;
  assert.equal(v4.schema, v4WatchProducer.AAVE_V4_WATCH_SCHEMA);
  assert.equal(v4.safety.executableNow, false);
  assert.equal(typeof v4.safety.executableNow, "boolean");
  assert.equal(statusModule.validateArtifactSemantics(v4Spec, v4, null, nowMs), true);

  for (const mutate of [
    value => { delete value.schema; },
    value => { value.schema = "aave-v4-liquidation-watch/v0"; },
    value => { value.scanner = "tools/not-the-v4-wrapper.js"; },
    value => { value.source.artifact = "reports/raw/fast/not-the-v4-source.json"; },
  ]) {
    const rejected = JSON.parse(JSON.stringify(v4));
    mutate(rejected);
    assert.equal(statusModule.validateArtifactSemantics(v4Spec, rejected, null, nowMs), false);
  }
});

test("route, completion, and disabled-route producers serialize canonical gates accepted by supervisor semantics", () => {
  const nowMs = Date.parse("2026-08-25T12:00:00.000Z");
  const generatedAt = new Date(nowMs - 1_000).toISOString();
  const serialize = value => JSON.parse(JSON.stringify(value));
  const route = serialize(routeSweepProducer.buildArtifact({
    recentContractsOldMoneyProbes: {
      generatedAt,
      summary: {
        rowsProbed: 1,
        uniqueContracts: 1,
        targetStaticSuccessRows: 0,
        routePositive: 0,
        executableNow: 0,
        executableNowCount: 0,
        signedActionJustified: false,
      },
    },
  }));
  route.generatedAt = generatedAt;
  assert.equal(route.ranked.length, 1);
  assert.equal(route.ranked[0].executableNow, false);
  assert.equal(typeof route.ranked[0].executableNow, "boolean");
  assert.equal(route.ranked[0].distance.summary.executableNow, false);
  assert.equal(typeof route.ranked[0].distance.summary.executableNow, "boolean");
  assert.equal(route.ranked[0].distance.summary.executableNowCount, 0);
  assert.equal(typeof route.ranked[0].distance.summary.executableNowCount, "number");
  const completion = serialize(completionGatesProducer.buildArtifact({
    routeSweep: route,
    proximity: { summary: {} },
    reportSignals: {
      counts: { CONFIRMED: 0, VULNERABLE: 0, WATCH: 0, DORMANT: 0, CLEAN: 0, UNTAGGED: 0 },
      files: { CONFIRMED: [], VULNERABLE: [], WATCH: [], DORMANT: [], CLEAN: [], UNTAGGED: [] },
      totalReports: 0,
    },
    branches: [],
    criticalArtifacts: [],
    missingRequiredBranchIds: [],
    generatedAt,
  }));
  const disabled = serialize(disabledRoutesProducer.buildArtifact({
    routeSweep: route,
    globalGates: { summary: { routePositive: 0, executableNow: false, executableNowCount: 0, signedActionJustified: false, hardStop: false } },
    apyusdPreflight: { summary: {}, preflightChecks: {} },
    aaveV4Watch: { latest: { summary: {} } },
  }));
  disabled.generatedAt = generatedAt;
  const cases = [
    [manifest.dataArtifacts.find(spec => spec.semantic.validator === "route-sweep"), route],
    [manifest.dataArtifacts.find(spec => spec.semantic.validator === "completion-gates"), completion],
    [manifest.services.find(service => service.id === "disabled-routes-report").artifact, disabled],
  ];

  for (const [spec, artifact] of cases) {
    assert.equal(artifact.summary.executableNow, false);
    assert.equal(typeof artifact.summary.executableNow, "boolean");
    assert.equal(artifact.summary.executableNowCount, 0);
    assert.equal(typeof artifact.summary.executableNowCount, "number");
    assert.equal(statusModule.validateArtifactSemantics(spec, artifact, null, nowMs), true);

    const wrongType = serialize(artifact);
    wrongType.summary.executableNow = 0;
    assert.equal(statusModule.validateArtifactSemantics(spec, wrongType, null, nowMs), false);
  }

  for (const mutate of [
    artifact => { artifact.ranked[0].distance.summary.executableNow = true; },
    artifact => { artifact.ranked[0].distance.summary.executableNow = 0; },
    artifact => { artifact.ranked[0].distance.summary.executableNowCount = 1; },
    artifact => { artifact.ranked[0].distance.summary.executableNowCount = "0"; },
  ]) {
    const rejected = serialize(route);
    mutate(rejected);
    assert.equal(statusModule.validateArtifactSemantics(cases[0][0], rejected, null, nowMs), false);
  }

  for (const [field, unsafeValue, invalid] of [
    ["executableNow", 1, false],
    ["executableNowCount", true, false],
    ["executableNow", "invalid", true],
    ["executableNowCount", "0", true],
  ]) {
    const upstream = {
      generatedAt,
      summary: {
        rowsProbed: 1,
        routePositive: 0,
        executableNow: 0,
        executableNowCount: 0,
        signedActionJustified: false,
        [field]: unsafeValue,
      },
    };
    const canonical = serialize(routeSweepProducer.buildArtifact({ recentContractsOldMoneyProbes: upstream }));
    const copied = canonical.ranked[0].distance.summary;
    assert.equal(copied.executableNow, false);
    assert.equal(copied.executableNowCount, 0);
    assert.equal(copied.hardStop, true);
    assert.equal(canonical.summary.hardStop, true);
    if (invalid) assert.equal(copied.invalidUpstreamAuthorizationSignal, true);
    else assert.equal(copied.observedUpstreamAuthorizationSignal, true);
    assert.equal(statusModule.validateArtifactSemantics(cases[0][0], canonical, null, nowMs), false);
  }
});

test("actual producer round trip propagates recursive hard stops and supervisor rejects every hard-stopped artifact", () => {
  const nowMs = Date.parse("2026-08-25T12:00:00.000Z");
  const generatedAt = new Date(nowMs - 1_000).toISOString();
  const reportSignals = {
    counts: { CONFIRMED: 0, VULNERABLE: 0, WATCH: 0, DORMANT: 0, CLEAN: 0, UNTAGGED: 0 },
    files: { CONFIRMED: [], VULNERABLE: [], WATCH: [], DORMANT: [], CLEAN: [], UNTAGGED: [] },
    totalReports: 0,
  };
  const route = JSON.parse(JSON.stringify(routeSweepProducer.buildArtifact({
    recentContractsOldMoneyProbes: {
      generatedAt,
      summary: {
        rowsProbed: 1,
        routePositive: 0,
        executableNow: "invalid",
        executableNowCount: 0,
        signedActionJustified: false,
      },
    },
  })));
  route.generatedAt = generatedAt;
  assert.equal(route.summary.hardStop, true);

  const completion = JSON.parse(JSON.stringify(completionGatesProducer.buildArtifact({
    routeSweep: route,
    proximity: { summary: {} },
    reportSignals,
    branches: [],
    criticalArtifacts: [],
    missingRequiredBranchIds: [],
    generatedAt,
  })));
  assert.equal(completion.summary.hardStop, true);
  assert.equal(completion.summary.completeForNow, false);
  assert.equal(completion.summary.status, "hard-stop-upstream-authorization-signal");
  assert.equal(completion.summary.executableNow, false);
  assert.equal(completion.summary.executableNowCount, 0);
  assert.equal(completion.summary.signedActionJustified, false);

  const global = JSON.parse(JSON.stringify(globalGatesProducer.buildStatus(1, generatedAt, [{ ok: true }], false, null, {
    route,
    gates: completion,
    apyusdPreflight: { summary: {}, preflightChecks: {} },
  })));
  global.generatedAt = generatedAt;
  assert.equal(global.summary.hardStop, true);
  assert.equal(global.summary.confirmationOk, false);
  assert.equal(global.summary.status, "hard-stop-upstream-authorization-signal");

  const disabled = JSON.parse(JSON.stringify(disabledRoutesProducer.buildArtifact({
    routeSweep: route,
    globalGates: global,
    apyusdPreflight: { summary: {}, preflightChecks: {} },
    aaveV4Watch: { latest: { summary: {} } },
  })));
  disabled.generatedAt = generatedAt;
  assert.equal(disabled.summary.hardStop, true);
  assert.equal(disabled.summary.status, "hard-stop-upstream-authorization-signal");
  assert.equal(disabled.autoExecutable, false);
  assert.equal(disabled.summary.autoExecutable, false);
  assert.equal(disabled.summary.executableNow, false);
  assert.equal(disabled.summary.signedActionJustified, false);

  const cases = [
    [manifest.dataArtifacts.find(spec => spec.semantic.validator === "route-sweep"), route],
    [manifest.dataArtifacts.find(spec => spec.semantic.validator === "completion-gates"), completion],
    [manifest.services.find(service => service.id === "global-gates").artifact, global],
    [manifest.services.find(service => service.id === "disabled-routes-report").artifact, disabled],
  ];
  for (const [spec, artifact] of cases) {
    assert.equal(statusModule.validateArtifactSemantics(spec, artifact, null, nowMs), false, spec.semantic.validator);
  }
});

test("completion producer retains stale and incomplete fail-closed status", () => {
  const generatedAt = "2026-08-25T11:59:59.000Z";
  const artifact = completionGatesProducer.buildArtifact({
    routeSweep: { summary: { routePositive: 0, executableNow: false, executableNowCount: 0, signedActionJustified: false, hardStop: false }, ranked: [] },
    proximity: { summary: {} },
    reportSignals: {
      counts: { CONFIRMED: 0, VULNERABLE: 0, WATCH: 0, DORMANT: 0, CLEAN: 0, UNTAGGED: 0 },
      files: { CONFIRMED: [], VULNERABLE: [], WATCH: [], DORMANT: [], CLEAN: [], UNTAGGED: [] },
      totalReports: 0,
    },
    branches: [{ id: "incomplete", complete: false, incompleteReasons: ["still incomplete"], sourceArtifacts: [] }],
    criticalArtifacts: [{ path: "stale.json", exists: true, stale: true }],
    missingRequiredBranchIds: [],
    generatedAt,
  });
  assert.equal(artifact.summary.hardStop, false);
  assert.equal(artifact.summary.completeForNow, false);
  assert.equal(artifact.summary.status, "stale-critical-artifacts");
  const spec = manifest.dataArtifacts.find(row => row.semantic.validator === "completion-gates");
  assert.equal(statusModule.validateArtifactSemantics(spec, artifact, null, Date.parse("2026-08-25T12:00:00.000Z")), false);
});

test("stale Aave V4 artifact keeps a running service unready with exact failures and age", () => {
  const nowMs = Date.parse("2026-08-25T12:00:00.000Z");
  const stale = new Date(nowMs - 31 * 60_000).toISOString();
  const artifacts = syntheticArtifacts(nowMs);
  artifacts["reports/raw/fast/aave-v4-liquidation-watch.json"].json.generatedAt = stale;
  artifacts["reports/raw/fast/aave-v4-liquidation-watch.json"].json.latest.generatedAt = stale;
  artifacts["reports/raw/fast/aave-v4-liquidation-watch.json"].mtimeMs = nowMs - 31 * 60_000;
  const status = statusModule.buildStatus(2, "2026-08-25T11:00:00.000Z", {
    nowMs,
    processes: persistentProcessRows(),
    artifactMap: artifacts,
    scriptExists: () => true,
  });

  const av4 = status.services.find((row) => row.id === "aave-v4-owner-watch");
  assert.equal(av4.running, true);
  assert.equal(av4.readiness, "pending-artifact");
  assert.equal(av4.artifact.ageMinutes, 31);
  assert.equal(status.summary.serviceStatus, "degraded");
  assert.equal(status.summary.dataStatus, "fail-closed");
  assert(status.summary.failedAssertionIds.includes("service-ready-aave-v4-owner-watch"));
  assert(status.summary.failedAssertionIds.includes("fresh-aaveV4Watch"));
  assert.equal(status.summary.artifactAgesMinutes["fresh-aaveV4Watch"], 31);
  const line = statusModule.formatConsole(status);
  assert.match(line, /fresh-aaveV4Watch/);
  assert.match(line, /fresh-aaveV4Watch:31m/);
});

test("Aave supervisor consumes actual versioned producer coverage as observational, without exact-key drift", () => {
  const nowMs = Date.parse("2026-08-25T12:00:00.000Z");
  const cases = [
    coverage => { coverage.schemaVersion += 1; },
    coverage => { coverage.sampleComplete = false; },
    coverage => { coverage.complete = true; },
    coverage => { coverage.chainsObserved -= 1; },
    coverage => { coverage.errors = ["sanitized-read-failure"]; },
    coverage => { coverage.wasTruncated = true; },
    coverage => { coverage.logChunksSucceeded -= 1; coverage.logChunksFailed += 1; },
    coverage => { coverage.checkedBorrowers -= 1; },
    coverage => { coverage.accountReadsSucceeded -= 1; coverage.accountReadsFailed += 1; },
    coverage => { coverage.reserveReadsSucceeded -= 1; coverage.reserveReadsFailed += 1; },
    coverage => { coverage.stateReadsSucceeded -= 1; coverage.stateReadsFailed += 1; },
    coverage => { delete coverage.logChunksFailed; },
  ];
  for (const artifactPath of [
    "reports/raw/fast/aave-v3-liquidation-watch-status.json",
    "reports/raw/fast/aave-v4-liquidation-watch.json",
  ]) {
    for (const mutate of cases) {
      const artifacts = syntheticArtifacts(nowMs);
      mutate(artifacts[artifactPath].json.sourceCoverage);
      const status = statusModule.buildStatus(1, "2026-08-25T11:59:00.000Z", {
        nowMs,
        processes: persistentProcessRows(),
        artifactMap: artifacts,
        scriptExists: () => true,
      });
      const service = status.services.find(row => row.artifact?.path === artifactPath);
      assert.equal(service.artifact.semanticValid, false);
      assert.equal(service.readiness, "pending-artifact");
    }
    for (const mutate of artifactPath.includes("v3") ? [
      coverage => { coverage.maxSourceAgeMs = 100 * 60_000; },
      coverage => { coverage.routeGeneratedAt = new Date(nowMs - 100 * 60_000).toISOString(); },
      coverage => { coverage.readinessGeneratedAt = new Date(nowMs - 100 * 60_000).toISOString(); },
      coverage => { coverage.routeRefreshAttempted = false; },
      coverage => { coverage.routeRefreshOk = false; },
      coverage => { coverage.requiredChainIds.pop(); },
      coverage => { coverage.observedChainIds[0] = 999; },
      coverage => { coverage.readinessStateReadsAttempted = 0; coverage.readinessStateReadsSucceeded = 0; },
      coverage => { coverage.readinessAccountReadsFailed = 1; coverage.readinessAccountReadsSucceeded -= 1; },
      coverage => { coverage.stateReadsAttempted += 1; coverage.stateReadsSucceeded += 1; },
    ] : [
      coverage => { coverage.topologyAgeMs = 100 * 60_000; },
      coverage => { coverage.topologyGeneratedAt = new Date(nowMs - 100 * 60_000).toISOString(); },
      coverage => { coverage.topologyRefreshOk = false; },
      coverage => { coverage.spokesObserved -= 1; },
      coverage => { coverage.stateReadsAttempted += 1; coverage.stateReadsSucceeded += 1; },
    ]) {
      const artifacts = syntheticArtifacts(nowMs);
      mutate(artifacts[artifactPath].json.sourceCoverage);
      const status = statusModule.buildStatus(1, "2026-08-25T11:59:00.000Z", {
        nowMs,
        processes: persistentProcessRows(),
        artifactMap: artifacts,
        scriptExists: () => true,
      });
      const service = status.services.find(row => row.artifact?.path === artifactPath);
      assert.equal(service.artifact.semanticValid, false);
    }
  }

  for (const artifactPath of [
    "reports/raw/fast/aave-v3-liquidation-watch-status.json",
    "reports/raw/fast/aave-v4-liquidation-watch.json",
  ]) {
    const artifacts = syntheticArtifacts(nowMs);
    const coverage = artifacts[artifactPath].json.sourceCoverage;
    coverage.logChunksAttempted = 0;
    coverage.logChunksSucceeded = 0;
    const status = statusModule.buildStatus(1, "2026-08-25T11:59:00.000Z", {
      nowMs,
      processes: persistentProcessRows(),
      artifactMap: artifacts,
      scriptExists: () => true,
    });
    assert.equal(status.services.find(row => row.artifact?.path === artifactPath).artifact.semanticValid, false);
  }

  const producerOutputs = syntheticArtifacts(nowMs);
  for (const artifactPath of [
    "reports/raw/fast/aave-v3-liquidation-watch-status.json",
    "reports/raw/fast/aave-v4-liquidation-watch.json",
  ]) producerOutputs[artifactPath].json.sourceCoverage.additionalProducerMetadata = { allowed: true };
  const accepted = statusModule.buildStatus(1, "2026-08-25T11:59:00.000Z", {
    nowMs,
    processes: persistentProcessRows(),
    artifactMap: producerOutputs,
    scriptExists: () => true,
  });
  for (const id of ["aave-v3-liquidation-watch", "aave-v4-owner-watch"]) {
    const row = accepted.services.find(service => service.id === id);
    assert.equal(row.artifact.semanticValid, true);
    assert.equal(row.artifact.healthy, false);
    assert.equal(row.artifact.status, "ready-observational");
    assert.equal(row.readiness, "ready-observational");
  }
  assert.equal(accepted.summary.status, "observational");
  assert.equal(accepted.summary.routeGateStatus, "closed");
});

test("health output never exposes process identifiers or command text", () => {
  const nowMs = Date.parse("2026-08-25T12:00:00.000Z");
  const status = statusModule.buildStatus(1, "2026-08-25T11:59:00.000Z", {
    nowMs,
    processes: persistentProcessRows(),
    artifactMap: syntheticArtifacts(nowMs),
    scriptExists: () => true,
  });
  const encoded = JSON.stringify(status);
  assert.doesNotMatch(encoded, /synthetic-secret-marker/);
  assert.doesNotMatch(encoded, /"pid"/i);
  assert.doesNotMatch(encoded, /commandline/i);
  assert.doesNotMatch(encoded, /synthetic-provider|synthetic-endpoint|environment-state/i);
});

test("fresh RUNNING WebSocket artifacts fail when any declared chain is degraded", () => {
  const nowMs = Date.parse("2026-08-25T12:00:00.000Z");
  for (const [artifactPath, rowsField] of [
    ["reports/monitor/morpho-ws-status.json", "chains"],
    ["reports/monitor/chainlink-ws-status.json", "feeds"],
  ]) {
    const artifacts = syntheticArtifacts(nowMs);
    const row = artifacts[artifactPath].json[rowsField][1];
    const connection = rowsField === "feeds" ? row.connection : row;
    connection.connected = false;
    connection.degraded = true;
    const status = statusModule.buildStatus(1, "2026-08-25T11:59:00.000Z", {
      nowMs,
      processes: persistentProcessRows(),
      artifactMap: artifacts,
      scriptExists: () => true,
    });
    const service = status.services.find(item => item.artifact?.path === artifactPath);
    assert.equal(service.artifact.fresh, true);
    assert.equal(service.artifact.semanticValid, false);
    assert.equal(service.artifact.healthy, false);
    assert.equal(service.readiness, "pending-artifact");
  }
});

test("incomplete or stale completion gates fail semantic health despite closed execution fields", () => {
  const nowMs = Date.parse("2026-08-25T12:00:00.000Z");
  for (const mutate of [
    summary => { summary.completeForNow = false; },
    summary => { summary.status = "stale-critical-artifacts"; },
    summary => { summary.routePositive = 1; },
    summary => { summary.executableNow = 1; },
    summary => { summary.signedActionJustified = true; },
  ]) {
    const artifacts = syntheticArtifacts(nowMs);
    mutate(artifacts["reports/raw/fast/audit-completion-gates.json"].json.summary);
    const status = statusModule.buildStatus(1, "2026-08-25T11:59:00.000Z", {
      nowMs,
      processes: persistentProcessRows(),
      artifactMap: artifacts,
      scriptExists: () => true,
    });
    const assertion = status.dataStatus.assertions.find(row => row.id === "fresh-completionGates");
    assert.equal(assertion.pass, false);
    assert.equal(status.summary.dataStatus, "fail-closed");
    assert.equal(status.summary.routeGateStatus, "fail-closed");
  }
});

test("failed or missing novelty cycle health summary fails closed", () => {
  const nowMs = Date.parse("2026-08-25T12:00:00.000Z");
  for (const mutate of [
    json => { json.cycleHealth.status = "FAILED"; json.cycleHealth.broadlyFailed = true; },
    json => { json.cycleHealth.sourceSummary = { total: 4, healthy: 1, failed: 3, unknown: 0 }; },
    json => { delete json.cycleHealth; },
  ]) {
    const artifacts = syntheticArtifacts(nowMs);
    mutate(artifacts["reports/monitor/state.json"].json);
    const status = statusModule.buildStatus(1, "2026-08-25T11:59:00.000Z", {
      nowMs,
      processes: persistentProcessRows(),
      artifactMap: artifacts,
      scriptExists: () => true,
    });
    const novelty = status.services.find(row => row.id === "novelty-monitor");
    assert.equal(novelty.artifact.fresh, true);
    assert.equal(novelty.artifact.semanticValid, false);
    assert.equal(novelty.readiness, "pending-artifact");
  }
});

test("WebSocket artifacts require fresh per-lane subscription observation heartbeats", () => {
  const nowMs = Date.parse("2026-08-25T12:00:00.000Z");
  const stale = new Date(nowMs - 11 * 60_000).toISOString();
  for (const [artifactPath, rowsField] of [
    ["reports/monitor/morpho-ws-status.json", "chains"],
    ["reports/monitor/chainlink-ws-status.json", "feeds"],
  ]) {
    for (const mutate of [
      row => { delete row.observationUpdatedAt; },
      row => { row.observationUpdatedAt = stale; },
      row => { row.subscriptionState = "CONNECTING"; },
      row => { delete row.lastObservedBlock; },
    ]) {
      const artifacts = syntheticArtifacts(nowMs);
      const lane = artifacts[artifactPath].json[rowsField][0];
      mutate(rowsField === "feeds" ? lane.connection : lane);
      const status = statusModule.buildStatus(1, "2026-08-25T11:59:00.000Z", {
        nowMs,
        processes: persistentProcessRows(),
        artifactMap: artifacts,
        scriptExists: () => true,
      });
      const service = status.services.find(row => row.artifact?.path === artifactPath);
      assert.equal(service.artifact.fresh, true);
      assert.equal(service.artifact.semanticValid, false);
      assert.equal(service.readiness, "pending-artifact");
    }
  }
});

test("failed global refresh or confirmation and missing route fields fail closed", () => {
  const nowMs = Date.parse("2026-08-25T12:00:00.000Z");
  for (const mutate of [
    summary => { summary.gateRefreshOk = false; },
    summary => { summary.confirmationOk = false; },
    summary => { delete summary.executableNow; },
  ]) {
    const artifacts = syntheticArtifacts(nowMs);
    mutate(artifacts["reports/monitor/global-gates-status.json"].json.summary);
    const status = statusModule.buildStatus(1, "2026-08-25T11:59:00.000Z", {
      nowMs,
      processes: persistentProcessRows(),
      artifactMap: artifacts,
      scriptExists: () => true,
    });
    const global = status.services.find(row => row.id === "global-gates");
    assert.equal(global.artifact.fresh, true);
    assert.equal(global.artifact.valid, false);
    assert.equal(status.summary.dataStatus, "fail-closed");
    assert.equal(status.summary.routeGateStatus, "fail-closed");
    assert(status.summary.failedAssertionIds.includes("fresh-globalGates"));
  }
});

test("missing semantic fields do not become healthy from a fresh timestamp or mtime", () => {
  const nowMs = Date.parse("2026-08-25T12:00:00.000Z");
  const artifacts = syntheticArtifacts(nowMs);
  delete artifacts["reports/raw/fast/route-positive-sweep.json"].json.summary.signedActionJustified;
  const status = statusModule.buildStatus(1, "2026-08-25T11:59:00.000Z", {
    nowMs,
    processes: persistentProcessRows(),
    artifactMap: artifacts,
    scriptExists: () => true,
  });
  const routeAssertion = status.dataStatus.assertions.find(row => row.id === "fresh-routeSweep");
  assert.equal(routeAssertion.pass, false);
  assert.equal(status.routeGateStatus.executableNow, false);
  assert.equal(status.routeGateStatus.executableNowCount, 0);
  assert.equal(status.routeGateStatus.signedActionJustified, false);
  assert(status.summary.failedAssertionIds.includes("route-gate-inputs-ready"));
});

test("safety assertions are derived from explicit runtime facts", () => {
  const nowMs = Date.parse("2026-08-25T12:00:00.000Z");
  const status = statusModule.buildStatus(1, "2026-08-25T11:59:00.000Z", {
    nowMs,
    processes: persistentProcessRows(),
    artifactMap: syntheticArtifacts(nowMs),
    scriptExists: () => true,
    runtimeFacts: { ...manifest.supervisorRuntime, artifactRefresh: "enabled" },
  });
  assert.equal(status.summary.safetyStatus, "fail-closed");
  assert(status.summary.failedAssertionIds.includes("no-child-refresh"));
});

test("PowerShell process inspection environment is explicitly allowlisted", () => {
  const env = statusModule.minimalProcessInspectionEnv({
    SystemRoot: "C:\\Windows",
    TEMP: "C:\\Temp",
    PATH: "sensitive-path",
    SECRET_TOKEN: "sensitive-token",
  });
  assert.deepEqual(env, { SystemRoot: "C:\\Windows", TEMP: "C:\\Temp" });
});

test("Morpho scheduled completion accepts an honest exhaustive or bounded-observational producer schema", () => {
  const text = launcherText();
  assert.match(text, /node tools\\monitor-hidden-dispatch\.js morpho-startup-scan/);
  assert.deepEqual(launcherInvocations(text).find(row => row.script === "tools/morpho-find-liquidatable.js").args, []);
  assert.doesNotMatch(text, /findstr[^\r\n]*Scanned:|morpho-liquidatable-startup\.done/);
  const spec = manifest.services.find(row => row.id === "morpho-startup-scan").artifact;
  const nowMs = Date.parse("2026-08-25T12:00:00.000Z");
  const base = syntheticArtifacts(nowMs)[spec.path].json;
  const mutations = [
    json => { json.classification = "BOUNDED_SAMPLE_INCOMPLETE"; json.complete = false; },
    json => { json.complete = false; },
    json => { json.coverage.borrowLogs.processed -= 1; },
    json => { json.coverage.borrowLogs.omittedByCap = 1; json.coverage.borrowLogs.wasTruncated = true; },
    json => { json.coverage.borrowLogs.malformed = 1; json.coverage.errors = 1; json.errors = 1; },
    json => { json.coverage.markets.unresolved = 1; json.coverage.markets.resolved -= 1; },
    json => { json.coverage.borrowers.selectedForCheck -= 1; json.coverage.borrowers.omittedByCap = 1; },
    json => { json.coverage.positions.successfullyChecked -= 1; json.coverage.positions.unchecked = 1; },
    json => { json.coverage.reads.failures = 1; json.coverage.reads.successes -= 1; },
    json => { json.coverage.operationalFailures = 1; },
    json => { json.results.valuationStatus = "available"; },
    json => { json.results.promotionEligible = true; },
    json => { json.unexpectedProducerField = true; },
  ];
  for (const mutate of mutations) {
    const json = JSON.parse(JSON.stringify(base));
    mutate(json);
    assert.equal(statusModule.artifactHealth(spec, {
      nowMs,
      artifactMap: { [spec.path]: { json, mtimeMs: nowMs - 1000 } },
    }).healthy, false);
  }
  assert.equal(statusModule.artifactHealth(spec, {
    nowMs,
    artifactMap: { [spec.path]: { json: base, mtimeMs: nowMs - 1000 } },
  }).healthy, true);

  const exhaustiveZero = JSON.parse(JSON.stringify(base));
  exhaustiveZero.marketsAttempted = 0;
  exhaustiveZero.marketsSuccessfullyChecked = 0;
  exhaustiveZero.positionsAttempted = 0;
  exhaustiveZero.positionsSuccessfullyChecked = 0;
  exhaustiveZero.coverage.borrowLogs.discovered = 0;
  exhaustiveZero.coverage.borrowLogs.processed = 0;
  exhaustiveZero.coverage.markets.discovered = 0;
  exhaustiveZero.coverage.markets.attempted = 0;
  exhaustiveZero.coverage.markets.resolved = 0;
  exhaustiveZero.coverage.borrowers.discoveredUnique = 0;
  exhaustiveZero.coverage.borrowers.discoveredMarketBorrowerPairs = 0;
  exhaustiveZero.coverage.borrowers.selectedForCheck = 0;
  exhaustiveZero.coverage.positions.discovered = 0;
  exhaustiveZero.coverage.positions.selectedForCheck = 0;
  exhaustiveZero.coverage.positions.readAttempts = 0;
  exhaustiveZero.coverage.positions.successfullyChecked = 0;
  for (const kind of ["marketParams", "marketState", "oraclePrice", "position"]) {
    exhaustiveZero.coverage.reads.byKind[kind].attempts = 0;
    exhaustiveZero.coverage.reads.byKind[kind].successes = 0;
  }
  exhaustiveZero.coverage.reads.attempts = 2;
  exhaustiveZero.coverage.reads.successes = 2;
  assert.equal(statusModule.artifactHealth(spec, {
    nowMs,
    artifactMap: { [spec.path]: { json: exhaustiveZero, mtimeMs: nowMs - 1000 } },
  }).healthy, true, "a successful exhaustive zero-result log query is complete");

  const sampled = JSON.parse(JSON.stringify(base));
  sampled.classification = "BOUNDED_SAMPLE_INCOMPLETE";
  sampled.complete = false;
  sampled.coverage.borrowLogs.omittedByCap = 1;
  sampled.coverage.borrowLogs.wasTruncated = true;
  const status = statusModule.buildStatus(1, "2026-08-25T11:59:00.000Z", {
    nowMs,
    processes: persistentProcessRows(),
    artifactMap: syntheticArtifacts(nowMs, { [spec.path]: { json: sampled, mtimeMs: nowMs - 1000 } }),
    scriptExists: () => true,
  });
  assert.equal(status.services.find(row => row.id === "morpho-startup-scan").readiness, "pending-artifact");
  assert.equal(status.summary.scheduledComplete, 2);

  // The declared observational coverage mode lets a truthful bounded-window artifact satisfy
  // the scheduled service while a non-bounded misclassification stays pending.
  const boundedJson = JSON.parse(JSON.stringify(base));
  boundedJson.classification = "BOUNDED_WINDOW_INCOMPLETE";
  boundedJson.complete = false;
  boundedJson.blocker = "Active-position discovery covers only a recent block suffix; full history is not proven.";
  boundedJson.coverage.historyScope = "RECENT_BLOCK_SUFFIX";
  boundedJson.coverage.observedRange = { fromBlock: 500, toBlock: 1000 };
  boundedJson.coverage.historyStartBound = null;
  boundedJson.coverage.fullHistoryProven = false;
  const boundedRow = statusModule.buildServiceStatuses([], {
    nowMs,
    artifactMap: { [spec.path]: { json: boundedJson, mtimeMs: nowMs - 1000 } },
    scriptExists: () => true,
  }).find((row) => row.id === "morpho-startup-scan");
  assert.equal(boundedRow.artifact.semanticValid, true);
  assert.equal(boundedRow.artifact.observational, true);
  assert.equal(boundedRow.artifact.acceptable, true);
  assert.equal(boundedRow.readiness, "complete");
});

test("autopilot artifact lease rejects contention, replaces stale owners, and releases one-shots", () => {
  const temp = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "monitor-supervisor-lock-"));
  const lockDir = path.join(temp, "autopilot-status.lock");
  try {
    const first = statusModule.acquireArtifactLease({ lockDir, nowMs: 1_000_000, leaseMs: 1000, role: "one-shot-validation" });
    assert(first);
    assert.equal(statusModule.acquireArtifactLease({ lockDir, nowMs: 1_000_500, leaseMs: 1000 }), null);
    const leaseText = fs.readFileSync(path.join(lockDir, "lease.json"), "utf8");
    assert.doesNotMatch(leaseText, /"pid"|command|environment/i);

    const replacement = statusModule.acquireArtifactLease({ lockDir, nowMs: 1_002_000, leaseMs: 1000, role: "supervisor" });
    assert(replacement);
    assert.notEqual(replacement.ownerToken, first.ownerToken);
    assert.equal(statusModule.releaseArtifactLease(first), false);
    assert.equal(statusModule.releaseArtifactLease(replacement), true);
    assert.equal(fs.existsSync(lockDir), false);

    const oneShot = statusModule.acquireArtifactLease({ lockDir, nowMs: 1_003_000, leaseMs: 1000, role: "one-shot-validation" });
    assert(oneShot);
    assert.equal(statusModule.releaseArtifactLease(oneShot), true);
    assert.equal(fs.existsSync(lockDir), false);

    const reservation = statusModule.acquireArtifactLease({ lockDir, nowMs: 1_004_000, leaseMs: 1000, role: "launch-reservation" });
    assert(reservation);
    const adopted = statusModule.acquireArtifactLease({ lockDir, nowMs: 1_004_100, leaseMs: 1000, role: "supervisor", adoptLaunchReservation: true });
    assert(adopted);
    assert.equal(statusModule.releaseArtifactLease(reservation), false);
    assert.equal(statusModule.releaseArtifactLease(adopted), true);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("missing route data fails closed with exact assertion IDs", () => {
  const nowMs = Date.parse("2026-08-25T12:00:00.000Z");
  const artifacts = syntheticArtifacts(nowMs);
  delete artifacts["reports/raw/fast/route-positive-sweep.json"];
  const status = statusModule.buildStatus(1, "2026-08-25T11:59:00.000Z", {
    nowMs,
    processes: persistentProcessRows(),
    artifactMap: artifacts,
    workspace: path.join(ROOT, "tools", "test", "does-not-exist"),
    scriptExists: () => true,
  });
  assert.equal(status.summary.dataStatus, "fail-closed");
  assert.equal(status.summary.routeGateStatus, "fail-closed");
  assert(status.summary.failedAssertionIds.includes("fresh-routeSweep"));
  assert(status.summary.failedAssertionIds.includes("route-gate-inputs-ready"));
  assert.equal(status.summary.artifactAgesMinutes["fresh-routeSweep"], null);
});

test("status source has no artifact refresh or legacy authorization behavior", () => {
  const source = fs.readFileSync(path.join(ROOT, "tools", "autopilot-status.js"), "utf8");
  for (const pattern of [/spawnSync/, /autopilot-action-queue/, /\.env\.exploit/i, /AUTOPILOT_LIVE_AUTH/, /keyFilePresent/, /commandLines:/, /pids:/]) {
    assert.doesNotMatch(source, pattern);
  }
  assert.match(source, /if \(require\.main === module\)/);
  assert.match(source, /module\.exports/);
});

test("chainlink-ws semantic evaluates the heartbeat on each feed connection object", () => {
  const nowMs = Date.parse("2026-08-25T12:00:00.000Z");
  const recent = new Date(nowMs - 60_000).toISOString();
  const stale = new Date(nowMs - 11 * 60_000).toISOString();
  const spec = manifest.services.find(service => service.id === "chainlink-ws").artifact;

  function buildChainlink(mutate = () => {}) {
    return {
      updatedAt: recent,
      status: "RUNNING",
      feeds: spec.semantic.requiredChains.map((key, index) => {
        const connection = {
          connected: true,
          degraded: false,
          subscriptionState: "SUBSCRIBED",
          lastObservedBlock: 2000 + index,
          observationUpdatedAt: recent,
        };
        mutate(connection, index);
        return { key, connection };
      }),
    };
  }

  assert.equal(statusModule.validateArtifactSemantics(spec, buildChainlink(), null, nowMs), true);
  for (const [label, mutate] of [
    ["stale observationUpdatedAt", connection => { connection.observationUpdatedAt = stale; }],
    ["absent lastObservedBlock", connection => { delete connection.lastObservedBlock; }],
    ["zero lastObservedBlock", connection => { connection.lastObservedBlock = 0; }],
    ["non-subscribed state", connection => { connection.subscriptionState = "CONNECTING"; }],
    ["degraded connection", connection => { connection.connected = false; connection.degraded = true; }],
  ]) {
    assert.equal(statusModule.validateArtifactSemantics(spec, buildChainlink(mutate), null, nowMs), false, label);
  }

  const flatFeeds = {
    updatedAt: recent,
    status: "RUNNING",
    feeds: spec.semantic.requiredChains.map((key, index) => ({
      key,
      connection: { connected: true, degraded: false },
      subscriptionState: "SUBSCRIBED",
      lastObservedBlock: 2100 + index,
      observationUpdatedAt: recent,
    })),
  };
  assert.equal(statusModule.validateArtifactSemantics(spec, flatFeeds, null, nowMs), false,
    "observation fields outside connection must not satisfy the chainlink heartbeat");
});

test("morpho-ws semantic still evaluates the flat per-chain connection row", () => {
  const nowMs = Date.parse("2026-08-25T12:00:00.000Z");
  const recent = new Date(nowMs - 60_000).toISOString();
  const stale = new Date(nowMs - 11 * 60_000).toISOString();
  const spec = manifest.services.find(service => service.id === "morpho-ws").artifact;

  function buildMorpho(mutate = () => {}) {
    return {
      updatedAt: recent,
      status: "RUNNING",
      chains: spec.semantic.requiredChains.map((key, index) => {
        const row = {
          key,
          connected: true,
          degraded: false,
          subscriptionState: "SUBSCRIBED",
          lastObservedBlock: 1000 + index,
          observationUpdatedAt: recent,
        };
        mutate(row, index);
        return row;
      }),
    };
  }

  assert.equal(statusModule.validateArtifactSemantics(spec, buildMorpho(), null, nowMs), true);
  for (const [label, mutate] of [
    ["stale observationUpdatedAt", row => { row.observationUpdatedAt = stale; }],
    ["absent lastObservedBlock", row => { delete row.lastObservedBlock; }],
    ["zero lastObservedBlock", row => { row.lastObservedBlock = 0; }],
    ["non-subscribed state", row => { row.subscriptionState = "CONNECTING"; }],
    ["degraded connection", row => { row.degraded = true; }],
  ]) {
    assert.equal(statusModule.validateArtifactSemantics(spec, buildMorpho(mutate), null, nowMs), false, label);
  }
});

test("morpho-startup-scan accepts the documented producer schema, accepts an honest bounded observation, and still rejects false completeness or drift", () => {
  const nowMs = Date.parse("2026-08-25T12:00:00.000Z");
  const { buildCompletionArtifact } = require("../morpho-find-liquidatable");
  const spec = manifest.services.find(service => service.id === "morpho-startup-scan").artifact;

  function producerCoverage(overrides = {}) {
    return {
      currentBlock: 1000,
      logQuerySuccessful: true,
      observedRange: { fromBlock: 0, toBlock: 1000 },
      historyScope: "GENESIS_TO_TIP",
      historyStartBound: { block: 0, kind: "genesis", proven: true, proof: "genesis" },
      fullHistoryProven: true,
      caps: { borrowLogs: 500, borrowersPerMarket: 30 },
      borrowLogs: { discovered: 4, processed: 4, omittedByCap: 0, malformed: 0, wasTruncated: false },
      markets: { discoveryScope: "processedBorrowLogs", discovered: 2, attempted: 2, resolved: 2, unresolved: 0 },
      borrowers: { discoveryScope: "processedBorrowLogs", discoveredUnique: 4, discoveredMarketBorrowerPairs: 4, selectedForCheck: 4, omittedByCap: 0, wasTruncated: false },
      positions: { discovered: 4, selectedForCheck: 4, readAttempts: 4, successfullyChecked: 4, readFailures: 0, unchecked: 0, uncheckedDueToBorrowerCap: 0, uncheckedDueToUnresolvedMarket: 0 },
      reads: {
        attempts: 12,
        successes: 12,
        failures: 0,
        byKind: {
          blockNumber: { attempts: 1, successes: 1, failures: 0 },
          borrowLogs: { attempts: 1, successes: 1, failures: 0 },
          marketParams: { attempts: 2, successes: 2, failures: 0 },
          marketState: { attempts: 2, successes: 2, failures: 0 },
          oraclePrice: { attempts: 2, successes: 2, failures: 0 },
          position: { attempts: 4, successes: 4, failures: 0 },
        },
      },
      operationalFailures: 0,
      errors: 0,
      ...overrides,
    };
  }

  // A genuine exhaustive producer artifact (with blocker + history provenance and no blockCount) is healthy.
  const exhaustive = buildCompletionArtifact(producerCoverage(), [], new Date(nowMs));
  assert.equal(exhaustive.classification, "EXHAUSTIVE_COMPLETE");
  assert.equal(exhaustive.blocker, null);
  assert.equal(exhaustive.coverage.observedRange.blockCount, undefined);
  assert.equal(statusModule.validateArtifactSemantics(spec, exhaustive, null, nowMs), true);

  // The same producer schema is now accepted when the scan is honestly bounded, because the
  // service is declared BOUNDED_OBSERVATIONAL. The bounded artifact never claims exhaustiveness.
  const bounded = buildCompletionArtifact(producerCoverage({
    currentBlock: 10000,
    observedRange: { fromBlock: 5000, toBlock: 10000 },
    historyScope: "RECENT_BLOCK_SUFFIX",
    historyStartBound: null,
    fullHistoryProven: false,
  }), [], new Date(nowMs));
  assert.equal(bounded.classification, "BOUNDED_WINDOW_INCOMPLETE");
  assert.equal(bounded.complete, false);
  assert.equal(bounded.coverage.fullHistoryProven, false);
  assert.equal(statusModule.validateArtifactSemantics(spec, bounded, null, nowMs), true,
    "an honest bounded-window observation validates observationally");

  // A false completeness claim must still fail even though bounded observations are accepted.
  for (const [label, mutate] of [
    ["exhaustive claim without proven history", artifact => { artifact.classification = "EXHAUSTIVE_COMPLETE"; artifact.complete = true; }],
    ["exhaustive claim that is incomplete", artifact => { artifact.classification = "EXHAUSTIVE_COMPLETE"; }],
    ["bounded claim that asserts completeness", artifact => { artifact.complete = true; }],
    ["bounded claim with proven history", artifact => { artifact.coverage.fullHistoryProven = true; }],
    ["bounded claim without a blocker explanation", artifact => { artifact.blocker = null; }],
    ["bounded claim with an empty blocker explanation", artifact => { artifact.blocker = "   "; }],
    ["bounded claim with truncated discovery", artifact => { artifact.coverage.borrowLogs.omittedByCap = 1; artifact.coverage.borrowLogs.wasTruncated = true; }],
  ]) {
    const tampered = JSON.parse(JSON.stringify(bounded));
    mutate(tampered);
    assert.equal(statusModule.validateArtifactSemantics(spec, tampered, null, nowMs), false, label);
  }

  for (const [label, mutate] of [
    ["missing blocker field", artifact => { delete artifact.blocker; }],
    ["unexpected top-level drift", artifact => { artifact.unexpectedProducerField = true; }],
    ["unexpected observedRange drift", artifact => { artifact.coverage.observedRange.blockCount = 1001; }],
  ]) {
    const tampered = JSON.parse(JSON.stringify(exhaustive));
    mutate(tampered);
    assert.equal(statusModule.validateArtifactSemantics(spec, tampered, null, nowMs), false, label);
  }
});
