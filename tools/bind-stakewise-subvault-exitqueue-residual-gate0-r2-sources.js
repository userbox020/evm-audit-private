#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "reports", "raw", "fast", "stakewise-subvault-exitqueue-residual-gate0-r2");
const MAIN = path.join(ROOT, "targets", "stakewise-v3-core-v5.0.1");
const PREDECESSOR = "C:\\Users\\MiPC\\AppData\\Local\\Temp\\opencode\\stakewise-v500-gate0";
const OZU = path.join(MAIN, "lib", "openzeppelin-contracts-upgradeable");
const OZ = path.join(OZU, "lib", "openzeppelin-contracts");
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
function fail(code) { throw new Error(code); }
function gitBlob(bytes) { return crypto.createHash("sha1").update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest("hex"); }
function git(cwd, args) { return spawnSync("git", args, { cwd, encoding: null, maxBuffer: 64 * 1024 * 1024, windowsHide: true }); }
function showEquals(cwd, commit, filePath, bytes) { const result = git(cwd, ["show", `${commit}:${filePath}`]); return result.status === 0 && Buffer.isBuffer(result.stdout) && result.stdout.equals(bytes); }
function hasBlob(cwd, blob) { return git(cwd, ["cat-file", "-e", `${blob}^{blob}`]).status === 0; }
function identitiesFor(filePath, bytes, blob) {
  const identities = [];
  const mainPath = filePath.startsWith("contracts/") ? filePath : null;
  if (mainPath && showEquals(MAIN, "fc70cbe1b3d41bc5f78434830d837aa270ca33bc", mainPath, bytes)) identities.push({ repository: "stakewise-v3-core", commit: "fc70cbe1b3d41bc5f78434830d837aa270ca33bc", path: mainPath, exact: true });
  if (mainPath && showEquals(PREDECESSOR, "31b2da5e9c729b00ead0db16369141608410bee8", mainPath, bytes)) identities.push({ repository: "stakewise-v3-core", commit: "31b2da5e9c729b00ead0db16369141608410bee8", path: mainPath, exact: true });
  let upgPath = null, ozPath = null;
  if (filePath.startsWith("@openzeppelin/contracts-upgradeable/")) upgPath = `contracts/${filePath.slice("@openzeppelin/contracts-upgradeable/".length)}`;
  if (filePath.startsWith("lib/openzeppelin-contracts-upgradeable/contracts/")) upgPath = filePath.slice("lib/openzeppelin-contracts-upgradeable/".length);
  if (filePath.startsWith("@openzeppelin/contracts/")) ozPath = `contracts/${filePath.slice("@openzeppelin/contracts/".length)}`;
  if (filePath.startsWith("lib/openzeppelin-contracts-upgradeable/lib/openzeppelin-contracts/contracts/")) ozPath = filePath.slice("lib/openzeppelin-contracts-upgradeable/lib/openzeppelin-contracts/".length);
  if (upgPath && showEquals(OZU, "60b305a8f3ff0c7688f02ac470417b6bbf1c4d27", upgPath, bytes)) identities.push({ repository: "openzeppelin-contracts-upgradeable", commit: "60b305a8f3ff0c7688f02ac470417b6bbf1c4d27", path: upgPath, exact: true });
  if (ozPath && showEquals(OZ, "e4f70216d759d8e6a64144a9e1f7bbeed78e7079", ozPath, bytes)) identities.push({ repository: "openzeppelin-contracts", commit: "e4f70216d759d8e6a64144a9e1f7bbeed78e7079", path: ozPath, exact: true });
  const objectDatabases = [];
  for (const [repository, cwd] of [["stakewise-v3-core", MAIN], ["openzeppelin-contracts-upgradeable", OZU], ["openzeppelin-contracts", OZ]]) if (hasBlob(cwd, blob)) objectDatabases.push(repository);
  return { identities, objectDatabases };
}

function main() {
  if (process.argv.length !== 2) fail("ARGV"); const acquisitionBytes = fs.readFileSync(path.join(OUT, "acquisition.json")), acquisition = JSON.parse(acquisitionBytes); if (acquisition.status !== "PASS") fail("ACQUISITION");
  const unique = new Map();
  for (const record of acquisition.records) { const authority = JSON.parse(fs.readFileSync(path.join(ROOT, ...record.authorityPath.split("/")), "utf8")); for (const source of authority.sourceFiles) { const bytes = fs.readFileSync(path.join(ROOT, ...source.authorityPath.split("/"))); if (sha256(bytes) !== source.sha256) fail("SOURCE_HASH"); const key = source.sha256; const row = unique.get(key) || { sha256: key, bytes: bytes.length, gitBlobSha1: gitBlob(bytes), filePaths: new Set(), occurrences: 0, materialOccurrences: 0, bytes }; row.filePaths.add(source.filePath); row.occurrences++; if (record.materialSignalGraph) row.materialOccurrences++; unique.set(key, row); } }
  const rows = [];
  for (const row of unique.values()) { const allIdentities = [], allDatabases = new Set(); for (const filePath of row.filePaths) { const result = identitiesFor(filePath, row.bytes, row.gitBlobSha1); allIdentities.push(...result.identities); result.objectDatabases.forEach((x) => allDatabases.add(x)); } rows.push({ sha256: row.sha256, bytes: row.bytes.length, gitBlobSha1: row.gitBlobSha1, filePaths: [...row.filePaths].sort(), occurrences: row.occurrences, materialOccurrences: row.materialOccurrences, exactCommitPathIdentities: [...new Map(allIdentities.map((x) => [`${x.repository}|${x.commit}|${x.path}`, x])).values()], officialGitObjectDatabases: [...allDatabases].sort(), officialGitBlobBound: allIdentities.length > 0 || allDatabases.size > 0 }); }
  rows.sort((a, b) => a.sha256.localeCompare(b.sha256)); const bound = rows.filter((x) => x.officialGitBlobBound), exactPath = rows.filter((x) => x.exactCommitPathIdentities.length);
  const output = { schemaVersion: 1, bindingId: "stakewise-subvault-exitqueue-residual-gate0-r2-source-git-bindings", generatedAt: new Date().toISOString(), status: "PASS", acquisitionSha256: sha256(acquisitionBytes), uniqueSourceBlobs: rows.length, officialGitBlobBound: bound.length, exactCommitPathBound: exactPath.length, explorerOnlyButRuntimeRebuildExact: rows.length - bound.length, repositories: [{ name: "stakewise-v3-core", commits: ["fc70cbe1b3d41bc5f78434830d837aa270ca33bc", "31b2da5e9c729b00ead0db16369141608410bee8"] }, { name: "openzeppelin-contracts-upgradeable", commit: "60b305a8f3ff0c7688f02ac470417b6bbf1c4d27" }, { name: "openzeppelin-contracts", commit: "e4f70216d759d8e6a64144a9e1f7bbeed78e7079" }], rows };
  const bytes = Buffer.from(`${JSON.stringify(output, null, 2)}\n`); fs.writeFileSync(path.join(OUT, "source-git-bindings.json"), bytes); console.log(JSON.stringify({ status: output.status, uniqueSourceBlobs: output.uniqueSourceBlobs, officialGitBlobBound: output.officialGitBlobBound, exactCommitPathBound: output.exactCommitPathBound, explorerOnlyButRuntimeRebuildExact: output.explorerOnlyButRuntimeRebuildExact, bindingSha256: sha256(bytes) }));
}

try { main(); } catch (error) { console.error(JSON.stringify({ status: "FAIL_CLOSED", code: String(error.message || "FAILURE") })); process.exitCode = 1; }
