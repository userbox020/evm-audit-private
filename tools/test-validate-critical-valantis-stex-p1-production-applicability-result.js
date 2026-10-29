#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const V = require("./validate-critical-valantis-stex-p1-production-applicability-result.js");

const ROOT = path.resolve(__dirname, "..");
let tests = 0; let assertions = 0;
function ok(value, message = "expected truthy") { assertions += 1; if (!value) throw new Error(message); }
function eq(actual, expected, message = "values differ") { assertions += 1; if (actual !== expected) throw new Error(`${message}: ${actual} !== ${expected}`); }
function deepEq(actual, expected, message = "objects differ") { assertions += 1; if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(message); }
function throws(fn, pattern = null) { assertions += 1; try { fn(); } catch (error) { if (!pattern || new RegExp(pattern, "iu").test(String(error.message || error))) return error; throw new Error(`wrong error: ${error.message}`); } throw new Error("expected throw"); }
async function test(name, fn) { await fn(); tests += 1; return name; }
function rel(value) { return path.join(ROOT, ...value.split("/")); }
function actualBytes() { return Object.fromEntries(Object.entries(V.PATHS).filter(([name]) => name !== "pass").map(([name, value]) => [name, fs.readFileSync(rel(value))])); }
function harness(overrides = {}, pass = false) { const rows = { ...actualBytes(), ...overrides }; return {
  read: (value) => { const entry = Object.entries(V.PATHS).find(([, file]) => file === value); if (!entry || !rows[entry[0]]) throw new Error(`unexpected read ${value}`); return rows[entry[0]]; },
  exists: (value) => value === V.PATHS.pass ? pass : false
}; }
function diagnostic() { return JSON.parse(actualBytes().diagnostic); }
function marker() { return JSON.parse(actualBytes().ledger); }
function decision() { return JSON.parse(actualBytes().decision); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

async function main() {
  await test("actual immutable result verifies", async () => { const result = V.validate(); eq(result.status, "PASS"); eq(result.disposition, V.DISPOSITION); eq(result.diagnosticSha256, V.EXPECTED.diagnostic.sha256); eq(result.markerSha256, V.EXPECTED.ledger.sha256); });
  await test("expected immutable hashes are exact", async () => { eq(V.EXPECTED.diagnostic.sha256, "67d11660e5dd68646ff256e0e7084e0e62b14aad2b633d1145228daa90351643"); eq(V.EXPECTED.ledger.sha256, "ee2b56b6088cc39dd1d79d2aa8a3eb6eaa7e414bb811e7ef52ef05233a900898"); eq(V.EXPECTED.decision.sha256, "000faae022b21f111c43286f053257f7b99511293c9fbac0f874baf68113140c"); });
  await test("diagnostic byte tamper fails", async () => { const rows = actualBytes(); const tampered = Buffer.from(rows.diagnostic); tampered[0] ^= 1; throws(() => V.validate(harness({ diagnostic: tampered })), "diagnostic immutable hash"); });
  await test("ledger byte tamper fails", async () => { const rows = actualBytes(); throws(() => V.validate(harness({ ledger: Buffer.concat([rows.ledger, Buffer.from("x")]) })), "ledger byte length"); });
  await test("lock byte tamper fails", async () => { const rows = actualBytes(); const tampered = Buffer.from(rows.lock); tampered[tampered.length - 2] ^= 1; throws(() => V.validate(harness({ lock: tampered })), "lock immutable hash"); });
  await test("decision byte tamper fails", async () => { const rows = actualBytes(); const tampered = Buffer.from(rows.decision); tampered[10] ^= 1; throws(() => V.validate(harness({ decision: tampered })), "decision immutable hash"); });
  await test("forbidden pass output fails", async () => { throws(() => V.validate(harness({}, true)), "forbidden pass output absent"); });

  await test("diagnostic root extra key fails", async () => { const row = diagnostic(); row.extra = true; throws(() => V.validateDiagnostic(row), "diagnostic exact keys"); });
  await test("diagnostic root missing key fails", async () => { const row = diagnostic(); delete row.pin; throws(() => V.validateDiagnostic(row), "diagnostic exact keys"); });
  await test("diagnostic outcome must be capture incomplete", async () => { const row = diagnostic(); row.outcome = "APPLICABILITY_BOUND_NOT_AFFECTED"; throws(() => V.validateDiagnostic(row), "diagnostic identity/outcome"); });
  await test("diagnostic execution ID mismatch fails", async () => { const row = diagnostic(); row.executionId = `p1-${"0".repeat(32)}`; throws(() => V.validateDiagnostic(row), "diagnostic identity/outcome"); });
  await test("terminal counter tamper fails", async () => { for (const [key, value] of [["inventoryFilesOpened", 1], ["logicalRpcCalls", 5], ["httpAttempts", 5], ["networkCalls", 13], ["automaticRetries", 1], ["authorizationConsumed", false]]) { const row = diagnostic(); row.counters[key] = value; throws(() => V.validateDiagnostic(row), "terminal counters"); } });
  await test("counter type tamper fails", async () => { const row = diagnostic(); row.counters.networkCalls = "12"; throws(() => V.validateDiagnostic(row), "terminal counters"); });
  await test("durability observation tamper fails", async () => { const row = diagnostic(); row.counters.durability.parentDirectoryFsync = true; throws(() => V.validateDiagnostic(row), "runtime durability observation"); });
  await test("group A or B qualification tamper fails", async () => { for (const key of ["groupAQualified", "groupBQualified"]) { const row = diagnostic(); row.groupQualification[key] = 1; throws(() => V.validateDiagnostic(row), "bounded group result"); } });
  await test("backend independence claim fails", async () => { const row = diagnostic(); row.groupQualification.backendIndependenceClaimed = true; throws(() => V.validateDiagnostic(row), "bounded group result"); });
  await test("pin fact fails", async () => { const row = diagnostic(); row.pin = {}; throws(() => V.validateDiagnostic(row), "no pin"); });
  await test("topology fact fails", async () => { const row = diagnostic(); row.topology = { pool: "x" }; throws(() => V.validateDiagnostic(row), "no topology"); });
  await test("runtime or interface fact fails", async () => { const runtime = diagnostic(); runtime.runtimeBinding.complete = true; throws(() => V.validateDiagnostic(runtime), "no runtime binding facts"); const iface = diagnostic(); iface.interfaces.complete = true; throws(() => V.validateDiagnostic(iface), "no interface facts"); });
  await test("history stage/code tamper fails", async () => { const row = diagnostic(); row.history.code = "OTHER"; throws(() => V.validateDiagnostic(row), "terminal stage/code only"); });
  await test("liability or zero-state claim fails", async () => { const row = diagnostic(); row.liabilities.zeroState = true; throws(() => V.validateDiagnostic(row), "no liability/zero-state facts"); });
  await test("economics row or route inference fails", async () => { const row = diagnostic(); row.economics.rows.push({ gap: "1" }); throws(() => V.validateDiagnostic(row), "no economics facts"); const route = diagnostic(); route.economics.routeOrProfitInferred = true; throws(() => V.validateDiagnostic(route), "no economics facts"); });
  await test("route and executable gates cannot be promoted", async () => { const row = diagnostic(); row.gates.routePositive = "POSITIVE"; throws(() => V.validateDiagnostic(row), "unknown/false gates"); const executable = diagnostic(); executable.gates.executableNow = "TRUE"; throws(() => V.validateDiagnostic(executable), "unknown/false gates"); });
  await test("signed and fork gates cannot be promoted", async () => { const row = diagnostic(); row.gates.signedActionJustified = true; throws(() => V.validateDiagnostic(row), "unknown/false gates"); const fork = diagnostic(); fork.gates.fork = true; throws(() => V.validateDiagnostic(fork), "unknown/false gates"); });
  await test("transaction signing deployment and mutation safety tamper fails", async () => { for (const key of ["signing", "deployment", "productionMutation", "broadcast", "fork"]) { const row = diagnostic(); row.safety[key] = true; throws(() => V.validateDiagnostic(row), "terminal safety"); } const tx = diagnostic(); tx.safety.transactions = 1; throws(() => V.validateDiagnostic(tx), "terminal safety"); });
  await test("provider URL material fails scan", async () => { const row = diagnostic(); row.history.code = "https://provider.invalid"; throws(() => V.validateDiagnostic(row), "terminal stage/code only"); throws(() => V.scanNoProviderMaterial({ note: "https://provider.invalid" }), "no URL material"); });
  await test("raw response or endpoint key fails scan", async () => { throws(() => V.scanNoProviderMaterial({ rawResponse: "x" }), "no provider/raw keys"); throws(() => V.scanNoProviderMaterial({ endpoint: "x" }), "no provider/raw keys"); });

  await test("marker exact schema rejects extras", async () => { const row = marker(); row.extra = 1; throws(() => V.validateMarker(row), "marker exact keys"); });
  await test("marker decision hash tamper fails", async () => { const row = marker(); row.decisionSha256 = "0".repeat(64); throws(() => V.validateMarker(row), "marker decision hash"); });
  await test("marker execution mismatch fails", async () => { const row = marker(); row.executionId = `p1-${"0".repeat(32)}`; throws(() => V.validateMarker(row), "marker execution"); });
  await test("marker status must be conservative pre-access consumption", async () => { const row = marker(); row.status = "LOCKED"; throws(() => V.validateMarker(row), "marker status"); });
  await test("marker parent fsync claim fails", async () => { const row = marker(); row.parentDirectoryFsync = true; throws(() => V.validateMarker(row), "marker parent-fsync honesty"); });
  await test("marker pre-access inventory/network must remain zero", async () => { const inventory = marker(); inventory.inventoryFilesOpened = 1; throws(() => V.validateMarker(inventory), "marker pre-access inventory zero"); const network = marker(); network.networkCalls = 1; throws(() => V.validateMarker(network), "marker pre-access network zero"); });
  await test("marker flush count must be two", async () => { const row = marker(); row.fileFlushes = 1; throws(() => V.validateMarker(row), "marker file flushes"); });

  await test("decision execution mismatch fails", async () => { const row = decision(); row.executionId = `p1-${"0".repeat(32)}`; throws(() => V.validateDecision(row), "decision execution"); });
  await test("decision retry or replacement authorization fails", async () => { for (const key of ["retryAuthorized", "replacementAuthorized"]) { const row = decision(); row.scope[key] = true; throws(() => V.validateDecision(row), "decision read-only one-run scope"); } });
  await test("decision transaction signing fork deploy mutation authorization fails", async () => { for (const key of ["transactionsAuthorized", "signingAuthorized", "forkAuthorized", "deploymentAuthorized", "productionMutationAuthorized"]) { const row = decision(); row.scope[key] = true; throws(() => V.validateDecision(row), "decision read-only one-run scope"); } });
  await test("disposition remains exact and non-affirmative", async () => { eq(V.DISPOSITION, "CAPTURE_EXECUTED / AUTHORIZATION_CONSUMED / CAPTURE_INCOMPLETE / PIN: GROUP_UNQUALIFIED"); ok(!/AFFECTED|NOT_AFFECTED|STAGING_ELIGIBLE/u.test(V.DISPOSITION)); });

  process.stdout.write(`${JSON.stringify({ status: "PASS", tests, assertions, protectedInventoryReads: 0, networkCalls: 0, captureExecuted: false })}\n`);
}
main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
