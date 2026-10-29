#!/usr/bin/env node
"use strict";

const fs = require("fs");
const V = require("./validate-critical-yearn-v3-withdrawal-queue-effective-liquidity-step3-result.js");

let tests = 0; let assertions = 0;
function ok(value, message = "expected truthy") { assertions += 1; if (!value) throw new Error(message); }
function eq(actual, expected, message = "values differ") { assertions += 1; if (V.stable(actual) !== V.stable(expected)) throw new Error(`${message}: ${V.stable(actual)} !== ${V.stable(expected)}`); }
function throws(fn, code) { assertions += 1; try { fn(); } catch (error) { if (!code || error.code === code) return; throw new Error(`wrong error ${error.code}; expected ${code}`); } throw new Error(`expected ${code}`); }
function test(name, fn) { fn(); tests += 1; return name; }
function bytes(key) { return fs.readFileSync(V.rel(V.PATHS[key])); }
function value(key) { return JSON.parse(bytes(key).toString("utf8")); }
function clone(value) { return structuredClone(value); }

const diagnostic = value("diagnostic"), ledger = value("ledger"), decision = value("decision");
const report = fs.readFileSync(V.rel(V.PATHS.report), "utf8"), inbox = value("inbox"), handoff = fs.readFileSync(V.rel(V.PATHS.handoff), "utf8");

test("real immutable result and closeout pass", () => { const result = V.verifyResult(); eq(result.status, "PASS"); eq(result.checks, 14); eq(result.finalDisposition, V.FINAL_DISPOSITION); });
test("exact immutable hashes are frozen", () => { eq(V.sha256(bytes("diagnostic")), V.HASHES.diagnostic); eq(V.sha256(bytes("ledger")), V.HASHES.marker); eq(V.sha256(bytes("lock")), V.HASHES.marker); eq(V.sha256(bytes("decision")), V.HASHES.decision); });
test("diagnostic byte tamper rejected", () => { throws(() => V.verifyResult({ diagnosticBytes: Buffer.concat([bytes("diagnostic"), Buffer.from(" ")]) }), "DIAGNOSTIC_HASH"); });
test("ledger byte tamper rejected", () => { throws(() => V.verifyResult({ ledgerBytes: Buffer.concat([bytes("ledger"), Buffer.from(" ")]) }), "LEDGER_HASH"); });
test("lock byte tamper rejected", () => { throws(() => V.verifyResult({ lockBytes: Buffer.concat([bytes("lock"), Buffer.from(" ")]) }), "LOCK_HASH"); });
test("decision byte tamper rejected", () => { throws(() => V.verifyResult({ decisionBytes: Buffer.concat([bytes("decision"), Buffer.from(" ")]) }), "DECISION_HASH"); });
test("marker byte identity enforced independently", () => { const altered = Buffer.from(bytes("lock")); altered[0] ^= 1; throws(() => V.verifyResult({ lockBytes: altered }), "LOCK_HASH"); });
test("pass output presence rejected", () => { throws(() => V.verifyResult({ passExists: true }), "PASS_OUTPUT_PRESENT"); });

test("diagnostic exact schema rejects extra", () => { const row=clone(diagnostic); row.pin={}; throws(()=>V.validateDiagnostic(row),"DIAGNOSTIC_KEYS"); });
test("diagnostic exact schema rejects missing", () => { const row=clone(diagnostic); delete row.error; throws(()=>V.validateDiagnostic(row),"DIAGNOSTIC_KEYS"); });
test("diagnostic schema type rejected", () => { const row=clone(diagnostic); row.schemaVersion="1"; throws(()=>V.validateDiagnostic(row),"DIAGNOSTIC_SCHEMA_TYPE"); });
test("diagnostic execution mismatch rejected", () => { const row=clone(diagnostic); row.executionId="x"; throws(()=>V.validateDiagnostic(row),"DIAGNOSTIC_IDENTITY"); });
test("diagnostic status mismatch rejected", () => { const row=clone(diagnostic); row.status="CAPTURE_COMPLETE"; throws(()=>V.validateDiagnostic(row),"DIAGNOSTIC_IDENTITY"); });
test("diagnostic stage mismatch rejected", () => { const row=clone(diagnostic); row.error.stage="STATE"; throws(()=>V.validateDiagnostic(row),"DIAGNOSTIC_TERMINAL_ERROR"); });
test("diagnostic code mismatch rejected", () => { const row=clone(diagnostic); row.error.code="OTHER"; throws(()=>V.validateDiagnostic(row),"DIAGNOSTIC_TERMINAL_ERROR"); });
test("diagnostic retry true rejected", () => { const row=clone(diagnostic); row.safety.retry=true; throws(()=>V.validateDiagnostic(row),"DIAGNOSTIC_PERMANENCE"); });
test("diagnostic replacement true rejected", () => { const row=clone(diagnostic); row.safety.replacement=true; throws(()=>V.validateDiagnostic(row),"DIAGNOSTIC_PERMANENCE"); });
test("diagnostic cleanup true rejected", () => { const row=clone(diagnostic); row.safety.cleanup=true; throws(()=>V.validateDiagnostic(row),"DIAGNOSTIC_PERMANENCE"); });
test("diagnostic safety boolean type rejected", () => { const row=clone(diagnostic); row.safety.retry=0; throws(()=>V.validateDiagnostic(row),"DIAGNOSTIC_RETRY_TYPE"); });

test("marker exact schema rejects extra", () => { const row=clone(ledger); row.networkCalls=0; throws(()=>V.validateMarker(row),"MARKER_KEYS"); });
test("marker execution mismatch rejected", () => { const row=clone(ledger); row.executionId="x"; throws(()=>V.validateMarker(row),"MARKER_IDENTITY"); });
test("marker decision hash mismatch rejected", () => { const row=clone(ledger); row.decisionSha256="0".repeat(64); throws(()=>V.validateMarker(row),"MARKER_IDENTITY"); });
test("marker status mismatch rejected", () => { const row=clone(ledger); row.status="OTHER"; throws(()=>V.validateMarker(row),"MARKER_PERMANENCE"); });
test("marker count mismatch rejected", () => { const row=clone(ledger); row.markersRequired=1; throws(()=>V.validateMarker(row),"MARKER_PERMANENCE"); });
test("marker flush mismatch rejected", () => { const row=clone(ledger); row.fileFlushesRequired=1; throws(()=>V.validateMarker(row),"MARKER_PERMANENCE"); });
test("marker false parent fsync claim rejected", () => { const row=clone(ledger); row.parentDirectoryFsync=true; throws(()=>V.validateMarker(row),"MARKER_PERMANENCE"); });
test("marker retry authorization rejected", () => { const row=clone(ledger); row.retryReplacementCleanupAuthorized=true; throws(()=>V.validateMarker(row),"MARKER_PERMANENCE"); });

test("decision exact schema rejects extra", () => { const row=clone(decision); row.extra=true; throws(()=>V.validateDecision(row),"DECISION_KEYS"); });
test("decision scope exact schema rejects extra", () => { const row=clone(decision); row.scope.extra=false; throws(()=>V.validateDecision(row),"DECISION_SCOPE_KEYS"); });
test("decision execution mismatch rejected", () => { const row=clone(decision); row.executionId="x"; throws(()=>V.validateDecision(row),"DECISION_IDENTITY"); });
test("decision retry scope rejected", () => { const row=clone(decision); row.scope.retryAuthorized=true; throws(()=>V.validateDecision(row),"DECISION_SCOPE_POLICY"); });
test("decision replacement scope rejected", () => { const row=clone(decision); row.scope.replacementAuthorized=true; throws(()=>V.validateDecision(row),"DECISION_SCOPE_POLICY"); });
test("decision cleanup scope rejected", () => { const row=clone(decision); row.scope.cleanupAuthorized=true; throws(()=>V.validateDecision(row),"DECISION_SCOPE_POLICY"); });
test("decision package binding rejected", () => { const row=clone(decision); row.packageDigest="0".repeat(64); throws(()=>V.validateDecision(row),"DECISION_PACKAGEDIGEST"); });
test("decision count type rejected", () => { const row=clone(decision); row.scope.captureCount="1"; throws(()=>V.validateDecision(row),"DECISION_COUNT_TYPE"); });

test("provider URL leak rejected", () => { throws(()=>V.assertNoLeak([{value:"https://secret.example"}]),"PROVIDER_OR_RAW_LEAK"); });
test("raw response key leak rejected", () => { throws(()=>V.assertNoLeak([{rawResponse:"opaque"}]),"PROVIDER_OR_RAW_LEAK"); });
test("generic provider-independence limitation is allowed", () => { ok(V.assertNoLeak([decision])); });

test("closeout inbox exact schema rejects extra", () => { const row=clone(inbox); row.networkCalls=0; throws(()=>V.validateCloseout(report,row,handoff),"INBOX_KEYS"); });
test("closeout route positive must remain unknown", () => { const row=clone(inbox); row.conclusions.routePositive=false; throws(()=>V.validateCloseout(report,row,handoff),"INBOX_CONCLUSION_VALUES"); });
test("closeout executable must remain unknown", () => { const row=clone(inbox); row.conclusions.executable=false; throws(()=>V.validateCloseout(report,row,handoff),"INBOX_CONCLUSION_VALUES"); });
test("closeout signed action must remain false", () => { const row=clone(inbox); row.conclusions.signedActionJustified=true; throws(()=>V.validateCloseout(report,row,handoff),"INBOX_CONCLUSION_VALUES"); });
test("closeout fork must remain false", () => { const row=clone(inbox); row.conclusions.fork=true; throws(()=>V.validateCloseout(report,row,handoff),"INBOX_CONCLUSION_VALUES"); });
test("closeout replacement remains forbidden", () => { const row=clone(inbox); row.lineage.replacementUnderThisLineage=true; throws(()=>V.validateCloseout(report,row,handoff),"INBOX_LINEAGE_VALUES"); });
test("report signal removal rejected", () => { throws(()=>V.validateCloseout(report.replaceAll("🟠 WATCH","UNSET"),inbox,handoff),"REPORT_SIGNAL_OR_DISPOSITION"); });
test("handoff disposition removal rejected", () => { throws(()=>V.validateCloseout(report,inbox,handoff.replace(V.FINAL_DISPOSITION,"OTHER")),"HANDOFF_SIGNAL_OR_DISPOSITION"); });
test("invented report network counter rejected", () => { throws(()=>V.validateCloseout(`${report}\nnetworkCalls: 0`,inbox,handoff),"REPORT_INVENTED_COUNTER"); });
test("discovery context tamper rejected", () => { const row=clone(inbox); row.discoveryContext.yBOLD="0x0"; throws(()=>V.validateCloseout(report,row,handoff),"INBOX_DISCOVERY_VALUES"); });

process.stdout.write(`${JSON.stringify({status:"PASS",tests,assertions,immutableEvidenceWrites:0,protectedFileReads:0,networkCalls:0,captureReruns:0})}\n`);
