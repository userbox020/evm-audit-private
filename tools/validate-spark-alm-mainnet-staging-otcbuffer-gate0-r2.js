#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const ROOT = path.resolve(__dirname, "..");
const TARGET = path.join(ROOT, "targets", "spark-alm-controller-ce5cbd96");
const OUT = "reports/raw/critical/spark-alm-mainnet-staging-otcbuffer-gate0-r2";
const MANIFEST = `${OUT}/manifest-r2.json`;
const sha = b => crypto.createHash("sha256").update(b).digest("hex");
function stable(v) {
  if (v === null || typeof v === "string" || typeof v === "boolean" || typeof v === "number") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
}
const abs = rel => path.join(ROOT, ...rel.split("/"));
let checks = 0; const ok = (v, m) => { checks++; assert.ok(v, m); };
const manifestBytes = fs.readFileSync(abs(MANIFEST)), manifest = JSON.parse(manifestBytes);
ok(manifest.schema.endsWith("-r2/manifest-v1") && manifest.hashAlgorithm === "sha256", "manifest identity");
ok(manifest.digestConstruction === "sha256(stable-json(records))", "digest construction");
ok(manifest.aggregateSha256 === sha(Buffer.from(stable(manifest.records))), "R2 aggregate");
for (const row of manifest.records) { const b = fs.readFileSync(abs(row.path)); ok(b.length === row.bytes, `bytes ${row.path}`); ok(sha(b) === row.sha256, `hash ${row.path}`); ok(row.path.includes("-r2") || row.path.includes("gate0-r2/"), `R2-only path ${row.path}`); }

const r1Bytes = fs.readFileSync(abs(manifest.r1Authority.manifestPath)), r1 = JSON.parse(r1Bytes);
ok(r1Bytes.length === manifest.r1Authority.manifestBytes && sha(r1Bytes) === manifest.r1Authority.manifestSha256, "R1 manifest immutable");
ok(r1.aggregateSha256 === manifest.r1Authority.aggregateSha256 && r1.records.length === manifest.r1Authority.recordCount, "R1 authority");
ok(sha(Buffer.from(stable(r1.records))) === r1.aggregateSha256, "R1 aggregate recomputed");
for (const row of r1.records) { const b = fs.readFileSync(abs(row.path)); ok(b.length === row.bytes && sha(b) === row.sha256, `R1 record immutable ${row.path}`); }

const commit = manifest.sourceAuthority.commit;
ok(cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: TARGET, encoding: "utf8", windowsHide: true }).trim() === commit, "source commit");
ok(cp.execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: TARGET, encoding: "utf8", windowsHide: true }).trim() === manifest.sourceAuthority.rootTree, "source tree");
for (const row of manifest.sourceAuthority.sourceRecords) { const b = cp.execFileSync("git", ["show", `${commit}:${row.path}`], { cwd: TARGET, encoding: null, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }); ok(b.length === row.bytes && sha(b) === row.sha256, `source ${row.path}`); }
ok(manifest.sourceAuthority.submodulePins.length === 18, "18 top-level submodule pins");

const capture = JSON.parse(fs.readFileSync(abs(`${OUT}/capture-r2.json`), "utf8")), build = JSON.parse(fs.readFileSync(abs(`${OUT}/build-record-r2.json`), "utf8"));
ok(stable(capture.sourcePreflight) === stable(build), "capture/build record exact join");
ok(capture.status === "TERMINAL_TWO_STAGE1_EIP1898_FAMILIES_UNAVAILABLE" && capture.failure.failureClass === "TWO_STAGE1_EIP1898_FAMILIES_UNAVAILABLE", "precise terminal blocker");
ok(capture.accessDisposition === "CAPTURE-FAILED" && capture.pin === null && capture.materiality === "unknown", "access/pin/material");
ok(capture.failure.baseAccounting.candidatesConsidered === 30 && capture.failure.baseAccounting.candidatesAttempted === 16, "candidate bounds");
ok(capture.failure.baseAccounting.newFamiliesAdmitted === 11 && capture.failure.baseAccounting.baseQualifiedFamilies === 4 && capture.failure.baseAccounting.baseQualifiedCandidates === 4, "base qualification accounting");
ok(capture.failure.stage1Accounting.commonPinObserved === true && capture.failure.stage1Accounting.materialReadAttemptsStarted === 6, "partial Stage1 accounting");
ok(capture.failure.stage1Accounting.rootCodeReadsAttempted === capture.rpcBudget.methodCounts.eth_getCode, "code method count join");
ok(capture.failure.stage1Accounting.rootStorageReadsAttempted === capture.rpcBudget.methodCounts.eth_getStorageAt, "storage method count join");
ok(capture.failure.stage1Accounting.authorizationEthCallsReached === 0 && !Object.hasOwn(capture.rpcBudget.methodCounts, "eth_call"), "authorization not reached");
ok(capture.gates.routePositive === "unknown" && capture.gates.executableNow === "unknown" && capture.gates.material === "unknown", "canonical unknown gates");
ok(capture.gates.fork.justified === false && capture.gates.fork.signedAction === false && capture.gates.signedActionJustified === false, "no fork/signing");
ok(build.commands[0].exitCode === 0 && build.commands[0].command.includes("--offline") && !build.commands[0].command.includes("http"), "sanitized successful build command");
ok(build.compiler.forgeIdentity.includes("1.5.1-stable") && build.compiler.solcVersion === "0.8.25+commit.b61c2a91", "compiler identities");
ok(build.buildInfo.length === 1 && build.buildInfo[0].sourceCount === 82 && /^[0-9a-f]{64}$/u.test(build.buildInfo[0].inputSha256), "build input binding");
ok(build.erc1967ProxyArtifactRetained === true && build.artifacts.length === 13, "artifact cardinality");
for (const row of build.artifacts) { const b = fs.readFileSync(abs(row.relativePath)); ok(b.length === row.bytes && sha(b) === row.sha256, `build artifact ${row.name}`); const j = JSON.parse(b); ok(typeof j.deployedBytecode?.object === "string" && j.deployedBytecode.object.length > 0, `deployed bytecode ${row.name}`); }
ok(build.artifacts.some(x => x.name === "ERC1967Proxy"), "ERC1967Proxy explicit artifact");
ok(capture.rpcBudget.logicalCalls === Object.values(capture.rpcBudget.methodCounts).reduce((a, b) => a + b, 0), "RPC calls exact");
ok(capture.rpcBudget.logicalCalls === 109 && capture.rpcBudget.responseBytes === 1072920 && capture.rpcBudget.withinCaps === true, "RPC budget exact");
ok(capture.r1Interpretation.r1FilesModified === false && capture.r1Interpretation.canonicalR1Status.includes("QUALIFICATION_OVERCONSTRAINED"), "R1 interpretation only");

const report = fs.readFileSync(abs("reports/critical-spark-alm-mainnet-staging-otcbuffer-gate0-r2.md"), "utf8");
ok(report.includes("Signal: NO FINDING") && report.includes("TWO_STAGE1_EIP1898_FAMILIES_UNAVAILABLE"), "report signal/blocker");
const publicPaths = [MANIFEST, `${OUT}/capture-r2.json`, `${OUT}/build-record-r2.json`, "reports/critical-spark-alm-mainnet-staging-otcbuffer-gate0-r2.md", "coordination/inbox/critical/20260822-coordinator-spark-otcbuffer-gate0-terminal-r2.json", "coordination/handoffs/20260822-coordinator-spark-otcbuffer-gate0-handoff-r2.md"];
for (const rel of publicPaths) { const text = fs.readFileSync(abs(rel), "utf8"); ok(!/(?:https?|wss?):\/\//iu.test(text), `no URL ${rel}`); ok(!/(?:private[_-]?key\s*[:=]|seed phrase|bearer\s+[a-z0-9]|"rpc(?:Url|Endpoint|Hostname|Domain|Headers)"\s*:)/iu.test(text), `no provider/secret value ${rel}`); }
console.log(`PASS ${checks} checks r1=${r1.aggregateSha256} r2=${manifest.aggregateSha256}`);
