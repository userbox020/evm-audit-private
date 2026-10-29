#!/usr/bin/env node
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const TARGET = path.join(ROOT, "targets", "cash-v3");
const RAW = "reports/raw/fast/critical-etherfi-pinbound-build-binding.json";
const MANIFEST = "reports/raw/fast/critical-etherfi-pinbound-build-binding-manifest.json";
const REPRO = "reports/raw/fast/critical-etherfi-pinbound-build-binding-reproduction.json";
const REPORT = "reports/critical-etherfi-pinbound-build-binding.md";
const INBOX = "coordination/inbox/critical/2026-07-21-critical-etherfi-pinbound-build-binding.json";
const HANDOFF = "coordination/handoffs/2026-07-21-critical-etherfi-pinbound-build-binding-handoff.md";
const SCANNER = "tools/scan-critical-etherfi-pinbound-build-binding.js";
const REVISION = "pinbound-build-binding-step1-r3-reviewer-corrected";
const BUILD_TIMEOUT_MS = 600_000;
const abs = (x) => path.join(ROOT, x);
const hash = (x) => crypto.createHash("sha256").update(x).digest("hex");
const strip0x = (x) => String(x || "").replace(/^0x/i, "").toLowerCase();
const canonical = (v) => Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}` : JSON.stringify(v);
const addressWord = (address) => Buffer.from(`${"0".repeat(24)}${strip0x(address)}`, "hex");
function walkFiles(dir, predicate, out = []) { if (!fs.existsSync(dir)) return out; for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) walkFiles(full, predicate, out); else if (predicate(full)) out.push(full); } return out; }
function immutableDeclarations(buildInfo) { const out = new Map(); function walk(node, sourcePath) { if (!node || typeof node !== "object") return; if (node.nodeType === "VariableDeclaration" && node.mutability === "immutable") out.set(String(node.id), { declarationName: node.name, sourcePath }); for (const value of Object.values(node)) { if (Array.isArray(value)) value.forEach((x) => walk(x, sourcePath)); else if (value && typeof value === "object") walk(value, sourcePath); } } for (const [sourcePath, item] of Object.entries(buildInfo.output?.sources || {})) walk(item.ast, sourcePath); return out; }
function normalizedPositions(rows) { return rows.map((x) => ({ start: Number(x.start), length: Number(x.length) })).sort((a, b) => a.start - b.start || a.length - b.length); }

const rawText = fs.readFileSync(abs(RAW), "utf8"); const raw = JSON.parse(rawText);
const manifestText = fs.readFileSync(abs(MANIFEST), "utf8"); const manifest = JSON.parse(manifestText);
const reproductionText = fs.readFileSync(abs(REPRO), "utf8"); const reproduction = JSON.parse(reproductionText);
const inboxText = fs.readFileSync(abs(INBOX), "utf8"); const inbox = JSON.parse(inboxText);
const report = fs.readFileSync(abs(REPORT), "utf8"); const handoff = fs.readFileSync(abs(HANDOFF), "utf8"); const scanner = fs.readFileSync(abs(SCANNER), "utf8");

assert.strictEqual(raw.revision, REVISION); assert.strictEqual(raw.classification, "exact"); assert.strictEqual(raw.step2SafeToBegin, true);
assert.strictEqual(raw.pin.chainId, 10); assert.strictEqual(raw.pin.blockNumber, 154534581); assert.strictEqual(raw.pin.blockHash, "0x9e2d47b4f179b068df84fe73f11601cfa0af372d769902848222dc3a6e3c8b13");
assert.strictEqual(raw.pin.chainIdVerified, true); assert.strictEqual(raw.pin.exactNumberHashVerified, true); assert.strictEqual(raw.pin.terminalSameNumberHashVerified, true);
assert.strictEqual(raw.source.commitMatch, true); assert.strictEqual(raw.source.scopedRecursiveClosure.complete, true); assert.strictEqual(raw.source.scopedRecursiveClosure.files.length, 80);
assert.strictEqual(raw.source.closureBuildLinkage.scopedClosureFileCount, 80); assert.strictEqual(raw.source.closureBuildLinkage.standardJsonBuildInputSourceCount, 296); assert.strictEqual(raw.source.closureBuildLinkage.matchedClosureFileCount, 80); assert.strictEqual(raw.source.closureBuildLinkage.additionalBuildInputSourceCount, 216); assert.strictEqual(raw.source.closureBuildLinkage.allClosureFilesPresentWithMatchingHash, true);
assert(raw.source.closureBuildLinkage.explanation.includes("not the full Foundry build input"));
assert.strictEqual(raw.componentResults.length, 6); assert(raw.componentResults.every((x) => x.proxyRuntime.present && x.implementationRuntime.present && x.proxyComparison.exactRuntimeEqual === true && x.implementationComparison.exactReconstructedEqual === true));
assert.strictEqual(raw.dependencies.immutableGetterBindingsExact, true); assert.deepStrictEqual(Object.keys(raw.dependencies.immutableGetterChecks).sort(), ["cashDataProvider", "debtDataProvider", "hookDataProvider", "liquifierCashModule", "liquifierDataProvider", "liquifierDebtManager"].sort()); assert(Object.values(raw.dependencies.immutableGetterChecks).every(Boolean));
assert.strictEqual(raw.dependencies.immutableProvenanceCoverage.allRowsIndependentlyBound, true); assert.strictEqual(raw.dependencies.immutableProvenanceCoverage.allRowsActualValuesMatch, true); assert(raw.dependencies.immutableProvenanceCoverage.astImmutableRowCount > 0);
for (const component of raw.componentResults) for (const row of component.implementationComparison.immutableRows) { assert.strictEqual(row.independentlyBound, true); assert.strictEqual(row.actualMatchesExpected, true); assert(["getter", "implementation-address", "independently-fixed-deployed-address"].includes(row.expectedValueSource)); if (row.declarationName === "__self") assert.strictEqual(row.expectedValueSource, "implementation-address"); else assert.strictEqual(row.expectedValueSource, "getter"); }
assert.strictEqual(raw.routePositive, 0); assert.strictEqual(raw.executableNow, 0); assert.strictEqual(raw.signedActionJustified, false); assert.strictEqual(raw.fork, false); assert.strictEqual(raw.safety.pendingWithdrawalsInspected, false); assert.strictEqual(raw.safety.exploitFork, false); assert.strictEqual(raw.safety.endpointInventoryRead, true); assert.strictEqual(raw.safety.endpointValuesPersisted, false);
assert.strictEqual(raw.r1Predecessor.preservationMode, "summary-provenance-and-package-hashes-only"); assert.strictEqual(raw.r1Predecessor.originalFilesManifestBoundInR3, false); assert.strictEqual(raw.r2Predecessor.preservationMode, "summary-provenance-and-package-hashes-only"); assert.strictEqual(raw.r2Predecessor.originalFilesManifestBoundInR3, false);
assert.strictEqual(raw.captureProvenance.runId, raw.runId); assert.strictEqual(raw.captureProvenance.revision, raw.revision); assert.strictEqual(raw.captureProvenance.scannerSha256.slice(0, 12), raw.runId.split("-").at(-1)); assert.strictEqual(raw.captureProvenance.predecessorRunId, raw.r2Predecessor.runId); assert.strictEqual(raw.publicationProvenance.currentPublicationScannerSha256, raw.captureProvenance.scannerSha256); assert.strictEqual(raw.publicationProvenance.capturePublicationScannerIdentical, true);
assert.strictEqual(raw.offlineReproduction.path, REPRO); assert.strictEqual(raw.offlineReproduction.bytes, Buffer.byteLength(reproductionText)); assert.strictEqual(raw.offlineReproduction.sha256, hash(reproductionText));
assert.strictEqual(reproduction.revision, REVISION); assert.strictEqual(reproduction.runId, raw.runId); assert.strictEqual(reproduction.components.length, 6); assert.strictEqual(reproduction.expectedOutcome.proxyExactCount, 6); assert.strictEqual(reproduction.expectedOutcome.implementationExactReconstructionCount, 6); assert.strictEqual(reproduction.expectedOutcome.allImmutableRowsIndependentlyBound, true); assert.strictEqual(reproduction.expectedOutcome.closureLinkedToBuildInput, true);

const tempRoot = path.join(os.tmpdir(), "opencode", "etherfi-pinbound-build-binding-r3-offline-test"); const outDir = path.join(tempRoot, "out"); const cacheDir = path.join(tempRoot, "cache"); const infoDir = path.join(tempRoot, "build-info");
let offlineComponentResults = [];
try {
  fs.rmSync(tempRoot, { recursive: true, force: true }); fs.mkdirSync(tempRoot, { recursive: true });
  const run = spawnSync("forge", ["build", "--root", TARGET, "--out", outDir, "--cache-path", cacheDir, "--build-info", "--build-info-path", infoDir, "--no-cache", "--offline"], { cwd: ROOT, encoding: "utf8", timeout: BUILD_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  assert.strictEqual(run.status, 0, "offline forge build failed"); assert.notStrictEqual(run.error?.code, "ETIMEDOUT", "offline forge build timed out");
  const infoFiles = walkFiles(infoDir, (x) => x.endsWith(".json")); assert.strictEqual(infoFiles.length, 1); const buildInfo = JSON.parse(fs.readFileSync(infoFiles[0], "utf8"));
  assert.strictEqual(hash(canonical(buildInfo.input)), reproduction.buildInputLinkage.standardJsonInputSha256); assert.strictEqual(Object.keys(buildInfo.input.sources || {}).length, reproduction.buildInputLinkage.standardJsonBuildInputSourceCount);
  const sourceRows = Object.entries(buildInfo.input.sources || {}).map(([sourcePath, item]) => ({ sourcePath, bytes: Buffer.byteLength(item.content || ""), sha256: hash(item.content || "") })).sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
  assert.strictEqual(hash(sourceRows.map((x) => `${x.sourcePath}\0${x.bytes}\0${x.sha256}`).join("\n")), reproduction.buildInputLinkage.sourceSetAggregateSha256);
  const linkage = reproduction.buildInputLinkage.closureBuildLinkage; assert.strictEqual(linkage.rows.length, 80);
  for (const row of linkage.rows) { const content = buildInfo.input.sources[row.buildInputPath]?.content; assert.strictEqual(typeof content, "string", `missing closure source ${row.buildInputPath}`); assert.strictEqual(hash(content), row.closureCompilerInputTextSha256, `closure/build hash ${row.buildInputPath}`); assert.strictEqual(row.contentHashMatch, true); const rawFile = fs.readFileSync(abs(row.closurePath)); assert.strictEqual(hash(rawFile), row.closureRawFileSha256, `closure raw hash ${row.closurePath}`); }
  const declarations = immutableDeclarations(buildInfo);
  const proxyArtifactPath = path.join(outDir, reproduction.proxyArtifact.artifactDir, reproduction.proxyArtifact.artifact); const proxyArtifact = JSON.parse(fs.readFileSync(proxyArtifactPath, "utf8")); const proxyTemplate = `0x${strip0x(proxyArtifact.deployedBytecode.object)}`;
  for (const component of reproduction.components) {
    assert.strictEqual(strip0x(proxyTemplate), strip0x(component.proxyRuntime), `${component.name} proxy runtime`);
    const artifactPath = path.join(outDir, component.implementationArtifact.artifactDir, component.implementationArtifact.artifact); const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    const refs = artifact.deployedBytecode.immutableReferences || {}; assert.strictEqual(Object.keys(refs).length, component.immutableRows.length, `${component.name} immutable AST row count`);
    const reconstructed = Buffer.from(strip0x(artifact.deployedBytecode.object), "hex"); const deployed = Buffer.from(strip0x(component.implementationRuntime), "hex");
    for (const row of component.immutableRows) {
      assert.strictEqual(row.independentlyBound, true); assert.strictEqual(row.actualMatchesExpected, true); assert(["getter", "implementation-address", "independently-fixed-deployed-address"].includes(row.expectedValueSource));
      const declaration = declarations.get(String(row.astId)); assert(declaration, `${component.name} AST ${row.astId}`); assert.strictEqual(declaration.declarationName, row.declarationName); assert.strictEqual(declaration.sourcePath, row.sourcePath);
      assert.deepStrictEqual(normalizedPositions(refs[row.astId] || []), normalizedPositions(row.positions), `${component.name} immutable ranges ${row.astId}`);
      const word = addressWord(row.expectedValue); for (const position of row.positions) { assert.strictEqual(position.length, 32); assert(deployed.subarray(position.start, position.start + position.length).equals(word), `${component.name} deployed immutable ${row.declarationName}`); word.copy(reconstructed, position.start); }
    }
    assert(reconstructed.equals(deployed), `${component.name} reconstructed implementation runtime`);
    offlineComponentResults.push({ name: component.name, proxyExact: true, implementationReconstructedExact: true, immutableAstRows: component.immutableRows.length });
  }
} finally { fs.rmSync(tempRoot, { recursive: true, force: true }); }
assert.strictEqual(offlineComponentResults.length, 6); assert(offlineComponentResults.every((x) => x.proxyExact && x.implementationReconstructedExact));

assert.strictEqual(manifest.runId, raw.runId); assert.strictEqual(inbox.runId, raw.runId); assert.strictEqual(manifest.revision, REVISION); assert.strictEqual(manifest.classification, "exact"); assert.strictEqual(manifest.step2SafeToBegin, true); assert.strictEqual(manifest.closureBuildLinkageComplete, true); assert.strictEqual(manifest.immutableProvenanceComplete, true); assert.strictEqual(manifest.offlineReproduction.sha256, hash(reproductionText));
for (const rec of manifest.records) { const data = fs.readFileSync(abs(rec.path)); assert.strictEqual(data.length, rec.bytes, `bytes ${rec.path}`); assert.strictEqual(hash(data), rec.sha256, `hash ${rec.path}`); }
const aggregate = hash(manifest.records.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n")); assert.strictEqual(aggregate, manifest.aggregateSha256); const reproductionManifestRecord = manifest.records.find((x) => x.path === REPRO); assert(reproductionManifestRecord); assert.strictEqual(reproductionManifestRecord.sha256, hash(reproductionText));
const scannerRecord = manifest.records.find((x) => x.path === SCANNER); assert(scannerRecord); assert.strictEqual(scannerRecord.sha256, raw.captureProvenance.scannerSha256);
const leak = [rawText, manifestText, reproductionText, inboxText, report, handoff, scanner].join("\n"); assert(!/https?:\/\/[a-z0-9]/i.test(leak), "URL leak"); assert(!/[?&](?:key|token|api_key|apikey)=/i.test(leak), "credential leak"); assert(!/(authorization|cookie|set-cookie)\s*[:=]/i.test(leak), "header leak");
assert(report.includes("not the full Foundry build input")); assert(report.includes("preserved only as summary/provenance plus package hashes")); assert(report.includes("nextReadOnlyStep")); assert(handoff.includes(raw.runId));
process.stdout.write(`PASS EtherFi pin-bound r3 offline reproduction (${offlineComponentResults.length}/6 exact; ${manifest.records.length} records; ${manifest.aggregateSha256})\n`);
