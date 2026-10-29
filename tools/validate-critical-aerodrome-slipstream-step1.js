#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

if (process.argv.length !== 3 || process.argv[2] !== "--check-only") {
  console.error("usage: node tools/validate-critical-aerodrome-slipstream-step1.js --check-only");
  process.exit(2);
}

const root = path.resolve(__dirname, "..");
const paths = {
  report: "reports/critical-aerodrome-slipstream-pool-accounting-step1.md",
  raw: "reports/raw/fast/critical-aerodrome-slipstream-pool-accounting-step1.json",
  sourceGate: "reports/raw/fast/critical-aerodrome-slipstream-pool-accounting-step1-source-gate.txt",
  forge: "reports/raw/fast/critical-aerodrome-slipstream-pool-accounting-step1-forge.txt",
  metadata: "reports/raw/fast/critical-aerodrome-slipstream-pool-accounting-step1-metadata.json",
  manifest: "reports/raw/fast/critical-aerodrome-slipstream-pool-accounting-step1-manifest.json",
  inbox: "coordination/inbox/critical/20260729-critical-aerodrome-slipstream-step1.json",
  handoff: "coordination/handoffs/20260729-critical-aerodrome-slipstream-step1-handoff.md",
  validator: "tools/validate-critical-aerodrome-slipstream-step1.js"
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
const inbox = JSON.parse(read(paths.inbox));
const handoff = read(paths.handoff);
const manifest = JSON.parse(read(paths.manifest));
const manifestBefore = hash(paths.manifest);
const before = new Map(manifest.files.map((entry) => [entry.path, hash(entry.path)]));

check(report.includes("INCOMPLETE / SCOPE-BLOCKED"), "report signal");
check(report.includes("exact Aerodrome Slipstream concentrated-liquidity pool"), "exact source gate");
check(report.includes("were not substituted"), "no V1 substitution");
check(raw.classification.startsWith("INCOMPLETE_SCOPE_BLOCKED"), "raw classification");
check(raw.decisiveGateAssessed === false, "decisive gate unassessed");
check(raw.routePositive === null && raw.executableNow === null, "null route/execution gates");
check(raw.signedActionJustified === null && raw.fork === false, "null signing gate and false fork");
check(raw.sourceGate.parentCommit === "1ba30815bba620f7e9faa34769ffd00c214c9b82", "parent commit");
check(raw.sourceGate.parentTree === "7fb339f61f598959786f81d3667f0df4865608be", "parent tree");
check(raw.sourceGate.trackedContractFileCount === 62, "contract count");
check(raw.sourceGate.exactSlipstreamImplementationPresent === false, "source absence");
check(raw.sourceGate.clSymbolGitGrepExitCode === 1, "git grep absence");
check(raw.sourceGate.exactSlipstreamCompiler === null, "compiler unbound");
check(raw.sourceGate.exactSlipstreamDependencies === null, "dependencies unbound");
check(raw.nonSubstitutions.v1PoolTestedAsSlipstream === false, "V1 excluded");
check(raw.nonSubstitutions.canonicalV3TestedAsSlipstream === false, "canonical excluded");
check(raw.tests.solidityTestsAuthored === 0 && raw.tests.protocolTestsExecuted === 0, "zero tests");
check(raw.tests.fuzzRuns === 0 && raw.tests.effectiveCases === 0, "zero cases");
check(raw.accountingDeltas === null, "no deltas");
check(raw.differential.performed === false, "no differential");
check(raw.safety.networkReads === 0 && raw.safety.dependencyFetches === 0, "offline no fetch");
check(sourceGate.includes("TRACKED_CONTRACT_FILE_COUNT=62"), "source transcript count");
check(sourceGate.includes("PARENT_TREE=7fb339f61f598959786f81d3667f0df4865608be"), "source transcript tree");
check(sourceGate.includes("CL_SYMBOL_GIT_GREP_EXIT_CODE=1"), "source transcript grep");
check(sourceGate.includes("STOP_SCOPE_BLOCKED=true"), "source transcript stop");
check(forge.includes("STATUS=NOT_RUN_SCOPE_BLOCKED"), "forge disposition");
check(forge.includes("PROTOCOL_TESTS_EXECUTED=0"), "forge zero tests");
check(metadata.slipstream.sourcePresent === false, "metadata source absence");
check(metadata.target.tree === "7fb339f61f598959786f81d3667f0df4865608be", "metadata parent tree");
check(metadata.slipstream.compiler === null && metadata.slipstream.dependencies === null, "metadata build unbound");
check(metadata.canonicalReference.usedForTesting === false, "metadata canonical excluded");
check(metadata.safety.offline === true && metadata.safety.network === false, "metadata offline");
check(inbox.routePositive === null && inbox.executableNow === null, "inbox null route gates");
check(inbox.signedActionJustified === null, "inbox null signing gate");
check(handoff.includes("`null/null/null`; `fork=false`"), "handoff gates");
check(Array.isArray(manifest.files) && manifest.files.length === 8, "manifest count");

const sorted = [...manifest.files].sort((a, b) => a.path.localeCompare(b.path));
for (const entry of sorted) {
  check(/^[0-9a-f]{64}$/.test(entry.sha256), `hash shape ${entry.path}`);
  check(hash(entry.path) === entry.sha256, `hash mismatch ${entry.path}`);
}
const input = sorted.map((entry) => `${entry.path}\0${entry.sha256}\n`).join("");
const aggregate = crypto.createHash("sha256").update(input).digest("hex");
check(aggregate === manifest.aggregateSha256, "aggregate");

for (const rel of Object.values(paths)) {
  if (rel === paths.manifest) continue;
  const text = read(rel);
  check(!/[ \t]+$/m.test(text), `trailing whitespace ${rel}`);
  if (rel !== paths.validator) check(!text.includes("rpc_endpoints.txt"), `endpoint inventory reference ${rel}`);
}
for (const [rel, prior] of before) check(hash(rel) === prior, `write detected ${rel}`);
check(hash(paths.manifest) === manifestBefore, "manifest write detected");

console.log(`PASS ${checks} checks; noWrite=true; tests=0; aggregate=${aggregate}`);
