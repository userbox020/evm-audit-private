#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const STEM = "polygon-robin-markets-staking-vault-v2.0.0-runtime-gate1";
const PACKAGE_REL = `reports/raw/fast/${STEM}`;
const PACKAGE_DIR = path.join(ROOT, ...PACKAGE_REL.split("/"));
const MANIFEST_PATH = path.join(PACKAGE_DIR, "package-manifest.json");
const SOURCE_PATH = path.join(PACKAGE_DIR, "source-authority.json");
const TARGET = path.join(ROOT, "targets", "robin-markets-staking-vault-v2.0.0-a09cab3c");
const READY_TOKEN = "ROBIN_RUNTIME_GATE_PASS_PREFLIGHT_PACKAGE_READY";
const OFFLINE_GIT_TIMEOUT_MS = 15000;
const EXPECTED_PACKAGE_PATHS = Object.freeze([
  `${PACKAGE_REL}/source-authority.json`, `${PACKAGE_REL}/runtime-model.json`, `${PACKAGE_REL}/query-plan.json`,
  `tools/vendor/polygon-robin-runtime-gate1-ethers.umd.min.js`,
  `tools/preflight-${STEM}.js`, `tools/capture-${STEM}.js`, `tools/validate-${STEM}.js`, `tools/test-${STEM}.js`
]);

class PreflightError extends Error {
  constructor(code) { super(code); this.name = "PreflightError"; this.code = code; }
}
function fail(code) { throw new PreflightError(code); }
function sha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function absolute(rel, root = ROOT) {
  if (typeof rel !== "string" || rel.includes("\\") || path.isAbsolute(rel) || rel.split("/").some((x) => x === ".." || x === "")) fail("UNSAFE_PACKAGE_PATH");
  const resolved = path.join(root, ...rel.split("/"));
  if (path.relative(root, resolved).startsWith("..")) fail("UNSAFE_PACKAGE_PATH");
  return resolved;
}
function readJson(file, reader = fs.readFileSync) {
  let value; try { value = JSON.parse(reader(file, "utf8")); } catch (_) { fail("JSON_INVALID"); } return value;
}
function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
function canonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") { if (!Number.isSafeInteger(value)) fail("NON_CANONICAL_NUMBER"); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!value || typeof value !== "object") fail("NON_CANONICAL_VALUE"); return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
function verifyBinding(binding, options = {}) {
  if (!exactKeys(binding, ["path", "bytes", "sha256"]) || !Number.isSafeInteger(binding.bytes) || binding.bytes < 1 || !/^[0-9a-f]{64}$/.test(binding.sha256)) fail("BINDING_SCHEMA");
  let bytes; try { bytes = (options.readFile || fs.readFileSync)(absolute(binding.path, options.root || ROOT)); } catch (_) { fail("BOUND_FILE_MISSING"); }
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (bytes.length !== binding.bytes || sha256(bytes) !== binding.sha256) fail("BOUND_FILE_MISMATCH");
  return true;
}
function verifyManifest(options = {}) {
  const root = options.root || ROOT, manifestPath = options.manifestPath || absolute(`${PACKAGE_REL}/package-manifest.json`, root);
  const manifestBytes = (options.readFile || fs.readFileSync)(manifestPath);
  let manifest; try { manifest = JSON.parse(manifestBytes); } catch (_) { fail("MANIFEST_JSON_INVALID"); }
  if (!exactKeys(manifest, ["schemaVersion", "date", "claimId", "status", "hashAlgorithm", "records", "aggregateSha256", "nonclaims"])
    || manifest.schemaVersion !== "robin-runtime-gate1/package-manifest-v1" || manifest.claimId !== STEM || manifest.status !== "IMMUTABLE_PACKAGE_RUNTIME_NOT_EXECUTED"
    || manifest.hashAlgorithm !== "sha256" || !Array.isArray(manifest.records) || manifest.records.length !== 8) fail("MANIFEST_SCHEMA");
  if (JSON.stringify(manifest.records.map((x) => x.path)) !== JSON.stringify(EXPECTED_PACKAGE_PATHS) || manifest.records.some((x) => x.path === `${PACKAGE_REL}/package-manifest.json`)) fail("MANIFEST_PATH_SET");
  const seen = new Set();
  for (const row of manifest.records) {
    if (!exactKeys(row, ["path", "bytes", "sha256"]) || seen.has(row.path)) fail("MANIFEST_RECORD_SCHEMA");
    seen.add(row.path); verifyBinding(row, { ...options, root });
  }
  const expected = sha256(Buffer.from(JSON.stringify(manifest.records)));
  if (manifest.aggregateSha256 !== expected) fail("MANIFEST_AGGREGATE_MISMATCH");
  return { manifest, bytes: Buffer.from(manifestBytes), sha256: sha256(manifestBytes) };
}
function verifySourceAuthority(options = {}) {
  const root = options.root || ROOT;
  const source = readJson(options.sourcePath || absolute(`${PACKAGE_REL}/source-authority.json`, root), options.readFile || fs.readFileSync);
  if (source.schemaVersion !== "robin-runtime-gate1/source-authority-v1" || source.status !== "PACKAGE_ONLY_RUNTIME_NOT_EXECUTED"
    || source.target.commit !== "a09cab3cd7dbc331bb1c12bb646d684c671bbeef" || source.target.tree !== "36e7023e8095171a6cc191b4f8b83cfffacdc22f"
    || source.gate0Authority.buildStatus !== "PASS_DEPENDENCY_AND_DETERMINISTIC_OFFLINE_BUILD"
    || source.gate0Authority.normalizedSemanticSha256 !== "48ab006107585968276d6cf74abeb108ebc088c2a9435dc3ad7d163a71db695a"
    || !Array.isArray(source.artifacts) || source.artifacts.length !== 8) fail("SOURCE_AUTHORITY_SCHEMA");
  verifyBinding(source.gate0Authority.sourceProvenance, { ...options, root });
  verifyBinding(source.gate0Authority.buildGate, { ...options, root });
  verifyBinding({ path: source.vendoredRuntimeDependency.path, bytes: source.vendoredRuntimeDependency.bytes, sha256: source.vendoredRuntimeDependency.sha256 }, { ...options, root });
  for (const row of source.artifacts) verifyBinding({ path: row.path, bytes: row.bytes, sha256: row.sha256 }, { ...options, root });
  const proxyAuthority = source.declarations.proxyRuntimeAuthority; verifyBinding({ path: proxyAuthority.path, bytes: proxyAuthority.bytes, sha256: proxyAuthority.sha256 }, { ...options, root });
  const broadcast = readJson(absolute(proxyAuthority.path, root), options.readFile || fs.readFileSync), runtimes = [];
  for (const proxy of [source.declarations.vaultProxy, source.declarations.twapProxy]) { const row = broadcast.transactions.find((x) => x.transactionType === "CREATE" && x.contractName === proxyAuthority.contract && String(x.contractAddress).toLowerCase() === proxy), input = String(row?.transaction?.input || "").toLowerCase(), start = 2 + proxyAuthority.runtimeOffset * 2,
      runtime = Buffer.from(input.slice(start, start + proxyAuthority.runtimeBytes * 2), "hex"); if (runtime.length !== proxyAuthority.runtimeBytes || sha256(runtime) !== proxyAuthority.runtimeSha256) fail("PROXY_RUNTIME_AUTHORITY"); runtimes.push(runtime.toString("hex")); }
  const vaultCreate = broadcast.transactions.find((x) => x.transactionType === "CREATE" && x.contractName === proxyAuthority.contract && String(x.contractAddress).toLowerCase() === source.declarations.vaultProxy), initData = String(vaultCreate?.arguments?.[1] || "").toLowerCase();
  if (runtimes[0] !== runtimes[1] || Object.entries(source.declarations.coreDependencies).filter(([key]) => key !== "binding").some(([, address]) => !initData.includes(address.slice(2)))) fail("CORE_DEPENDENCY_AUTHORITY");
  return source;
}
function verifyCheckout(options = {}) {
  if (options.checkoutVerifier) return options.checkoutVerifier();
  const target = options.target || TARGET, exec = options.execFile || execFileSync;
  const remaining = () => options.deadline && typeof options.deadline.remaining === "function" ? options.deadline.remaining() : OFFLINE_GIT_TIMEOUT_MS;
  const git = (...args) => { const timeout = Math.floor(Math.min(OFFLINE_GIT_TIMEOUT_MS, remaining())); if (timeout <= 0) fail("PREFLIGHT_GLOBAL_DEADLINE");
    try { return exec("git", ["-C", target, ...args], { encoding: "utf8", windowsHide: true, timeout }).trim(); } catch (_) { fail("CHECKOUT_COMMAND_FAILED_OR_TIMEOUT"); } };
  if (git("rev-parse", "HEAD") !== "a09cab3cd7dbc331bb1c12bb646d684c671bbeef"
    || git("rev-parse", "HEAD^{tree}") !== "36e7023e8095171a6cc191b4f8b83cfffacdc22f"
    || git("rev-parse", "--abbrev-ref", "HEAD") !== "HEAD" || git("status", "--porcelain") !== "") fail("CHECKOUT_MISMATCH");
  return true;
}
function assertNoLifecycleArtifacts(options = {}) {
  const exists = options.exists || fs.existsSync, root = options.root || ROOT;
  const rels = [
    `reports/raw/fast/${STEM}/preflight.json`, `reports/raw/fast/${STEM}/capture.json`, `reports/raw/fast/${STEM}/diagnostic.json`,
    `reports/raw/fast/${STEM}/validation.json`, `reports/raw/fast/${STEM}/validation-manifest.json`, `reports/raw/fast/${STEM}/capture.lock`,
    `reports/raw/fast/${STEM}/consumption-ledger.json`, `reports/raw/fast/${STEM}/terminal-manifest.json`, `reports/raw/fast/${STEM}/lifecycle-journal.json`, `reports/raw/fast/${STEM}/validation-journal.json`,
    `coordination/decisions/${STEM}-review-a.json`, `coordination/decisions/${STEM}-review-b.json`,
    `coordination/decisions/${STEM}-review-a.json.consumed`, `coordination/decisions/${STEM}-review-b.json.consumed`
  ];
  if (rels.some((rel) => exists(absolute(rel, root)))) fail("LIFECYCLE_ARTIFACT_PRESENT");
  return true;
}
function verifyAll(options = {}) {
  const manifest = verifyManifest(options); verifySourceAuthority(options); verifyCheckout(options);
  if (options.requireUnused !== false) assertNoLifecycleArtifacts(options);
  return { claimId: STEM, packageManifestSha256: manifest.sha256, packageAggregateSha256: manifest.manifest.aggregateSha256, packageRecords: manifest.manifest.records,
    records: manifest.manifest.records.length, runtimeExecuted: false };
}
function markerTemplates(packageManifestSha256, manifest = readJson(MANIFEST_PATH)) {
  const base = { schemaVersion: "robin-runtime-gate1/review-record-v2", claimId: STEM, status: "REVIEWED_UNCONSUMED", reviewerIdentity: "<independent-reviewer>",
    reviewerRole: "<ORACLE_REVIEWER|SECURITY_REVIEWER>", reviewerCommitment: "<sha256-canonical-record-with-null-commitment>", packageManifestSha256,
    packageAggregateSha256: manifest.aggregateSha256, packageRecords: manifest.records, command: `node tools/capture-${STEM}.js --capture --execution-id <execution-id>`, recoveryCommand: `node tools/capture-${STEM}.js --recover --execution-id <execution-id>`,
    scope: "READ_ONLY_POLYGON_ROBIN_RUNTIME_GATE1_EXACT_PACKAGE", executionId: "<execution-id>", issuedAt: "<ISO-8601>", expiresAt: "<ISO-8601<=issued+2h>",
    oneRun: true, noRetry: true, readOnly: true, signing: false, broadcast: false, mutation: false, funds: false };
  return [{ ...base, slot: "A" }, { ...base, slot: "B" }];
}
function main(argv = process.argv.slice(2)) {
  if (argv.length !== 0) fail("ARGUMENTS_FORBIDDEN");
  verifyAll(); process.stdout.write(`${READY_TOKEN}\n`);
}

module.exports = { ROOT, STEM, PACKAGE_REL, PACKAGE_DIR, MANIFEST_PATH, SOURCE_PATH, TARGET, READY_TOKEN, OFFLINE_GIT_TIMEOUT_MS, EXPECTED_PACKAGE_PATHS, PreflightError, sha256, absolute,
  readJson, exactKeys, canonical, verifyBinding, verifyManifest, verifySourceAuthority, verifyCheckout, assertNoLifecycleArtifacts, verifyAll, markerTemplates, main };
if (require.main === module) try { main(); } catch (error) { process.stdout.write("ROBIN_RUNTIME_GATE_FAIL_SOURCE_OR_PACKAGE\n"); process.exitCode = 1; }
