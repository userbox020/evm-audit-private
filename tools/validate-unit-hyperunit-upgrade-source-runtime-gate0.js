#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const STEM = "unit-hyperunit-upgrade-source-runtime-gate0";
const CAPTURE = path.join(ROOT, "reports", "raw", "fast", STEM, "capture.json");
const MANIFEST = path.join(ROOT, "reports", "raw", "fast", STEM, "manifest.json");
let checks = 0;
function ok(value, message) { checks += 1; if (!value) throw new Error(message); }
function sha(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function canonicalGate(value) { return ["true", "false", "unknown", "n/a"].includes(value); }

const capture = readJson(CAPTURE), manifest = readJson(MANIFEST);
ok(capture.schema === `${STEM}/capture-v1`, "capture schema");
ok(["PASS", "FAIL-CLOSED", "ACCESS-BLOCKED"].includes(capture.status), "status enum");
ok(canonicalGate(capture.gates.routePositive), "routePositive enum");
ok(canonicalGate(capture.gates.executableNow), "executableNow enum");
ok(capture.gates.routePositive === "unknown" && capture.gates.executableNow === "unknown", "incomplete gates unknown");
ok(capture.gates.signedActionJustified === false, "signing false");
ok(capture.gates.fork.justified === false && capture.gates.fork.signedAction === false, "fork false");
ok(capture.safety.readOnly === true && capture.safety.transactions === false && capture.safety.signing === false, "safety");
ok(capture.safety.endpointValuesPersisted === false && capture.safety.endpointValuesHashed === false && capture.safety.endpointValuesOnArgv === false, "provider policy");
ok(capture.decision.auditHypothesisOpened === false && capture.decision.economicsOpened === false, "Gate0 only");
if (capture.status !== "ACCESS-BLOCKED") {
  ok(capture.pin.chainId === "999" && capture.pin.finality === "finalized", "pin");
  ok(capture.pin.twoFamilyAgreement === true && capture.pin.terminalRecheck === true, "two-family pin continuity");
  ok(capture.qualification.selectedAnonymousFamilies.length === 2 && capture.qualification.independentFamilyKeys === true, "families");
  ok(capture.registry.completeExpectedFive === true && capture.registry.uxplAuthoritativeEntryPresent === false, "official registry");
  ok(capture.proxies.length === 5, "proxy completeness");
  if (capture.accessDisposition === "AVAILABLE") {
    ok(capture.upgradedHistory.fromBlock === "0" && capture.upgradedHistory.toBlock === capture.pin.number, "history complete bounds");
    ok(capture.counters.dualLogQueries === capture.upgradedHistory.queryChunks, "log count exact");
    ok(capture.counters.upgradedEvents === capture.upgradedHistory.totalEvents, "event count exact");
  } else {
    ok(capture.upgradedHistory.status === "ACCESS-BLOCKED/UNKNOWN", "history access blocked");
    ok(capture.decision.completeness.completeUpgradedHistoryFromBlockZero === false, "history completeness false");
  }
  ok(capture.counters.terminalRechecks === 4, "terminal count exact");
  for (const proxy of capture.proxies) {
    ok(proxy.proxyCode.present && proxy.implementationCode.present, `${proxy.symbol} code`);
    ok(proxy.admin === "0x0000000000000000000000000000000000000000", `${proxy.symbol} admin`);
  }
  if (capture.decision.admission === "PASS") {
    ok(capture.builds.some((x) => x.exactRuntime), "exact runtime exists");
    ok(capture.decision.publicValuePathSymbols.length > 0, "public path exists");
    ok(capture.decision.materialConsumerAndLiquidExitSymbols.length > 0, "material exposure exists");
  }
}
ok(manifest.schema === `${STEM}/manifest-v1`, "manifest schema");
for (const row of manifest.records) {
  const file = path.join(ROOT, ...row.path.split("/"));
  const bytes = fs.readFileSync(file);
  ok(bytes.length === row.bytes, `manifest bytes ${row.path}`);
  ok(sha(bytes) === row.sha256, `manifest hash ${row.path}`);
}
const serialized = JSON.stringify(capture);
ok(!/(?:https?|wss?):\/\//i.test(serialized), "no URLs in capture");
ok(!/bearer\s|authorization\s*[:=]|api[_-]?key|\.env(?:\.|\b)|private[_-]?key|seed phrase/i.test(serialized), "secret pattern scan");
console.log(`PASS ${checks} checks`);
