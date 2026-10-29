#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

if (process.argv.length !== 3 || process.argv[2] !== "--check-only") {
  console.error("usage: node tools/validate-critical-balancer-v3-vault-step1.js --check-only");
  process.exit(2);
}

const root = path.resolve(__dirname, "..");
const paths = {
  report: "reports/critical-balancer-v3-vault-transient-accounting-step1.md",
  raw: "reports/raw/fast/critical-balancer-v3-vault-transient-accounting-step1.json",
  sourceGate: "reports/raw/fast/critical-balancer-v3-vault-transient-accounting-step1-source-gate.txt",
  forge: "reports/raw/fast/critical-balancer-v3-vault-transient-accounting-step1-forge.txt",
  metadata: "reports/raw/fast/critical-balancer-v3-vault-transient-accounting-step1-metadata.json",
  matrix: "reports/raw/fast/critical-balancer-v3-vault-transient-accounting-step1-test-matrix.json",
  manifest: "reports/raw/fast/critical-balancer-v3-vault-transient-accounting-step1-manifest.json",
  inbox: "coordination/inbox/critical/20260729-critical-balancer-v3-vault-transient-accounting-step1.json",
  handoff: "coordination/handoffs/20260729-critical-balancer-v3-vault-transient-accounting-step1-handoff.md",
  validator: "tools/validate-critical-balancer-v3-vault-step1.js"
};

let checks = 0;
function check(condition, message) {
  checks += 1;
  if (!condition) throw new Error(`check ${checks} failed: ${message}`);
}
function abs(rel) {
  return path.join(root, rel);
}
function read(rel) {
  check(fs.existsSync(abs(rel)), `missing ${rel}`);
  return fs.readFileSync(abs(rel), "utf8");
}
function hash(rel) {
  return crypto.createHash("sha256").update(fs.readFileSync(abs(rel))).digest("hex");
}

const report = read(paths.report);
const raw = JSON.parse(read(paths.raw));
const sourceGate = read(paths.sourceGate);
const forge = read(paths.forge);
const metadata = JSON.parse(read(paths.metadata));
const matrix = JSON.parse(read(paths.matrix));
const manifest = JSON.parse(read(paths.manifest));
const inbox = JSON.parse(read(paths.inbox));
const handoff = read(paths.handoff);
const manifestBefore = hash(paths.manifest);
const before = new Map(manifest.files.map((entry) => [entry.path, hash(entry.path)]));

check(report.includes("INCOMPLETE / SOURCE-ABSENT BLOCKED"), "report classification");
check(report.includes("No V2 `batchSwap`, `joinPool`, or `exitPool` terminology"), "V2 terminology exclusion");
check(raw.classification === "INCOMPLETE_SOURCE_ABSENT_BUILD_AND_TEST_BLOCKED", "raw classification");
check(raw.target.present === false && raw.target.commit === null, "target absence and null commit");
check(raw.buildBinding.bound === false && raw.buildBinding.productionContractsCompiled === 0, "zero production build");
check(raw.decisiveGateAssessed === false, "decisive gate unassessed");
check(raw.routePositive === null && raw.executableNow === null, "null route gates");
check(raw.signedActionJustified === null && raw.fork === false, "signing and fork gates");
check(raw.architecture.v2TerminologyImported === false, "no V2 API substitution");
check(Object.values(raw.assertions).every((value) => value === null), "assertions unassessed");
check(Object.values(raw.decisiveOutcomes).every((value) => value === null), "decisive outcomes null");
check(raw.tests.solidityTestsAuthored === 0 && raw.tests.focusedTestsExecuted === 0, "zero authored/focused tests");
check(raw.tests.executedFuzzRuns === 0 && raw.tests.effectiveCases === 0, "zero fuzz cases");
check(raw.safety.networkReads === 0 && raw.safety.dependencyFetches === 0, "offline no fetch");
check(raw.safety.rpcReads === 0 && raw.safety.endpointInventoriesRead === 0, "no RPC or endpoint inventory");
check(sourceGate.includes("TARGET_PRESENT=false"), "source transcript target absence");
check(sourceGate.includes("EXIT_CODE=128"), "source transcript git exit");
check(sourceGate.includes("STOP_SOURCE_ABSENT=true"), "source stop gate");
check(forge.includes("FILES_COMPILED=0"), "zero files compiled");
check(forge.includes("TESTS_EXECUTED=0"), "zero tests transcript");
check(forge.includes("QUALIFICATION=VACUOUS_NONEXISTENT_ROOT_NOT_A_BUILD"), "vacuous build qualification");
check(forge.includes("NPX_INVOCATIONS=0"), "no npx");
check(metadata.target.present === false && metadata.toolchain.solc === null, "metadata source and compiler");
check(metadata.execution.testsExecuted === 0 && metadata.execution.invariantCalls === 0, "metadata zero execution");
check(metadata.safety.offline === true && metadata.safety.network === false, "metadata offline");
check(matrix.productionLinked === false && matrix.executedTests === 0, "matrix blocked");
check(matrix.scenarioGroups.length === 10, "ten requested scenario groups");
check(matrix.scenarioGroups.every((row) => row.status === "blocked_source_absent"), "all scenarios blocked honestly");
check(matrix.requiredAssertions.length === 5, "five required assertions");
check(Object.values(matrix.decisiveGate).every((value) => value === null), "matrix decisive gate null");
check(inbox.routePositive === null && inbox.executableNow === null, "inbox null route gates");
check(inbox.signedActionJustified === null, "inbox null signing gate");
check(handoff.includes("Tests authored/executed/fuzz cases: `0/0/0`"), "handoff counts");
check(fs.existsSync(abs("targets")), "targets parent exists");
check(!fs.existsSync(abs("targets/balancer-v3-monorepo")), "target remains absent at validation");
check(Array.isArray(manifest.files) && manifest.files.length === 7, "manifest record count");

const sorted = [...manifest.files].sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)));
for (const entry of sorted) {
  check(/^[0-9a-f]{64}$/.test(entry.sha256), `hash shape ${entry.path}`);
  check(fs.statSync(abs(entry.path)).size === entry.bytes, `byte count ${entry.path}`);
  check(hash(entry.path) === entry.sha256, `hash mismatch ${entry.path}`);
}
const records = sorted.map((entry) => ({ path: entry.path, sha256: entry.sha256, bytes: entry.bytes }));
const aggregate = crypto.createHash("sha256").update(JSON.stringify(records)).digest("hex");
check(aggregate === manifest.aggregateSha256, "manifest aggregate");
check(inbox.manifestAggregateSha256 === aggregate, "inbox aggregate");
check(handoff.includes(aggregate), "handoff aggregate");

for (const rel of Object.values(paths)) {
  const text = read(rel);
  check(!/[ \t]+$/m.test(text), `trailing whitespace ${rel}`);
  check(!text.includes("rpc" + "_endpoints.txt"), `endpoint inventory filename ${rel}`);
}
for (const [rel, prior] of before) check(hash(rel) === prior, `write detected ${rel}`);
check(hash(paths.manifest) === manifestBefore, "manifest write detected");

console.log(`PASS ${checks} checks; noWrite=true; tests=0; effectiveCases=0; aggregate=${aggregate}`);
