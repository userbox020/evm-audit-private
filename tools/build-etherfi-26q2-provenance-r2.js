#!/usr/bin/env node
"use strict";

// Hermetic standard-JSON compilation of the 11 R2 verified inputs. Compiler
// binaries are fetched from the official Solidity binary distribution and
// authenticated against its published SHA-256 and Keccak-256 checksums.
const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const crypto = require("node:crypto");
const cp = require("node:child_process");
const { keccak256 } = require("./node_modules/ethers");

const ROOT = path.resolve(__dirname, "..");
const BASE = path.join(ROOT, "reports", "raw", "fast", "etherfi-26q2-upgrade-migration-gate0-r2");
const INPUTS = path.join(BASE, "verified-inputs");
const OUT = path.join(BASE, "hermetic-builds");
const CACHE = path.join("C:\\Users\\MiPC\\AppData\\Local\\Temp\\opencode", "etherfi-r2-solc");
const LIST_HOST = "binaries.soliditylang.org", LIST_PATH = "/windows-amd64/list.json";
const MAX_DOWNLOAD = 64 * 1024 * 1024, MAX_OUTPUT = 256 * 1024 * 1024;
const sha256 = (b) => `0x${crypto.createHash("sha256").update(b).digest("hex")}`;
const rel = (p) => path.relative(ROOT, p).replaceAll("\\", "/");
class Stop extends Error { constructor(code, details) { super(code); this.code = code; this.details = details; } }
const fail = (code, details) => { throw new Stop(code, details); };

function fetchOfficial(p) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    const req = https.request({ protocol: "https:", hostname: LIST_HOST, port: 443, path: p, method: "GET", agent: false,
      headers: { accept: "application/octet-stream", "accept-encoding": "identity", "user-agent": "defensive-audit-r2" } }, (res) => {
      res.on("data", (c) => { n += c.length; if (n > MAX_DOWNLOAD) req.destroy(new Stop("DOWNLOAD_CAP")); else chunks.push(Buffer.from(c)); });
      res.on("end", () => { if (res.statusCode !== 200) return reject(new Stop("HTTP_STATUS", { status: res.statusCode })); resolve(Buffer.concat(chunks)); });
    });
    req.setTimeout(60_000, () => req.destroy(new Stop("TIMEOUT")));
    req.on("error", (e) => reject(e instanceof Stop ? e : new Stop("TRANSPORT")));
    req.end();
  });
}

function extractCbor(hex) {
  if (typeof hex !== "string" || !/^[0-9a-f]*$/iu.test(hex) || hex.length < 4) return { present: false };
  const n = parseInt(hex.slice(-4), 16), total = n * 2 + 4;
  if (!Number.isFinite(n) || n <= 0 || total > hex.length) return { present: false };
  const data = hex.slice(hex.length - total, -4).toLowerCase();
  return { present: true, payloadBytes: n, trailerBytes: 2, payloadHex: `0x${data}`, payloadSha256: sha256(Buffer.from(data, "hex")), fullTrailerHex: `0x${hex.slice(-total).toLowerCase()}` };
}

async function main() {
  if (process.argv.length !== 2) fail("ARGV_FORBIDDEN");
  const acquisition = JSON.parse(fs.readFileSync(path.join(INPUTS, "acquisition-summary.json"), "utf8"));
  if (acquisition.status !== "PASS_11_OF_11_VERIFIED_INPUTS" || acquisition.records.length !== 11) fail("ACQUISITION_GATE");
  fs.mkdirSync(CACHE, { recursive: true }); fs.mkdirSync(OUT, { recursive: true });
  const listRaw = await fetchOfficial(LIST_PATH); let list; try { list = JSON.parse(listRaw); } catch (_) { fail("COMPILER_LIST_JSON"); }
  const versions = [...new Set(acquisition.records.map((r) => r.compilerVersion.replace(/^v/u, "")))];
  const compilerEvidence = {};
  for (const longVersion of versions) {
    const build = list.builds.find((b) => b.longVersion === longVersion);
    if (!build || typeof build.path !== "string") fail("COMPILER_UNAVAILABLE", { longVersion });
    const exe = path.join(CACHE, build.path); let bytes;
    if (fs.existsSync(exe)) bytes = fs.readFileSync(exe); else { bytes = await fetchOfficial(`/windows-amd64/${build.path}`); fs.writeFileSync(exe, bytes); }
    const observedSha = sha256(bytes), observedKeccak = keccak256(bytes);
    if (observedSha.toLowerCase() !== String(build.sha256).toLowerCase() || observedKeccak.toLowerCase() !== String(build.keccak256).toLowerCase()) fail("COMPILER_CHECKSUM", { longVersion });
    const ver = cp.spawnSync(exe, ["--version"], { encoding: "utf8", maxBuffer: 1024 * 1024,
      env: { SystemRoot: process.env.SystemRoot || "C:\\Windows", TEMP: CACHE, TMP: CACHE }, windowsHide: true });
    if (ver.status !== 0 || !String(ver.stdout).includes(longVersion)) fail("COMPILER_VERSION_EXEC", { longVersion, status: ver.status });
    compilerEvidence[longVersion] = { officialDistribution: "Solidity windows-amd64", binaryFile: build.path, bytes: bytes.length,
      sha256: observedSha, keccak256: observedKeccak, versionOutput: String(ver.stdout).trim(), versionExitCode: ver.status };
  }

  const records = [];
  for (const rec of acquisition.records) {
    const authority = JSON.parse(fs.readFileSync(path.join(ROOT, rec.authority), "utf8"));
    const sourcifyInput = path.join(BASE, "sourcify-v2", rec.id, "build-input.json");
    const inputPath = fs.existsSync(sourcifyInput) ? sourcifyInput : path.join(ROOT, rec.standardInput.path), inputBytes = fs.readFileSync(inputPath);
    if (!fs.existsSync(sourcifyInput) && sha256(inputBytes) !== rec.standardInput.sha256) fail("INPUT_HASH_DRIFT", { id: rec.id });
    const parsedInput = JSON.parse(inputBytes.toString("utf8"));
    const longVersion = rec.compilerVersion.replace(/^v/u, ""), compiler = compilerEvidence[longVersion];
    const exe = path.join(CACHE, compiler.binaryFile), start = process.hrtime.bigint();
    const run = cp.spawnSync(exe, ["--standard-json"], { input: inputBytes, encoding: "utf8", maxBuffer: MAX_OUTPUT, cwd: CACHE,
      env: { SystemRoot: process.env.SystemRoot || "C:\\Windows", TEMP: CACHE, TMP: CACHE }, windowsHide: true });
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    if (run.error || run.status !== 0) fail("COMPILER_EXIT", { id: rec.id, status: run.status, signal: run.signal, error: run.error?.code || null });
    let output; try { output = JSON.parse(run.stdout); } catch (_) { fail("COMPILER_OUTPUT_JSON", { id: rec.id, stdoutPrefix: String(run.stdout).slice(0, 80) }); }
    const errors = Array.isArray(output.errors) ? output.errors : [], fatal = errors.filter((e) => e.severity === "error");
    if (fatal.length) fail("COMPILER_ERRORS", { id: rec.id, count: fatal.length, messages: fatal.slice(0, 3).map((e) => String(e.formattedMessage || e.message).slice(0, 300)) });
    const artifact = output.contracts?.[authority.fileName]?.[authority.contractName];
    if (!artifact) fail("TARGET_ARTIFACT_MISSING", { id: rec.id, fileName: authority.fileName, contractName: authority.contractName });
    const runtime = artifact.evm?.deployedBytecode?.object, creation = artifact.evm?.bytecode?.object;
    if (typeof runtime !== "string" || !/^[0-9a-f]*$/iu.test(runtime) || !runtime.length) fail("RUNTIME_MISSING", { id: rec.id });
    if (typeof creation !== "string" || !/^[0-9a-f]*$/iu.test(creation) || !creation.length) fail("CREATION_MISSING", { id: rec.id });
    const recDir = path.join(OUT, rec.id); fs.mkdirSync(recDir, { recursive: true });
    const outputPath = path.join(recDir, "compiler-output.json"); fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
    const evm = artifact.evm || {}, buildEvidence = {
      schemaVersion: "etherfi-26q2-provenance-r2/hermetic-build-v1", id: rec.id, address: rec.address,
      compiler: { ...compiler, requestedLongVersion: longVersion }, execution: { command: "<authenticated-solc-binary> --standard-json", actualExecution: true,
        lifecycleScripts: false, networkDuringCompilation: false, exitCode: run.status, signal: run.signal, elapsedMs, stderr: String(run.stderr || "").trim().slice(0, 2000) },
      input: { path: rel(inputPath), authority: fs.existsSync(sourcifyInput) ? "Sourcify v2 public verified compiler closure" : "Blockscout public verified compiler closure",
        bytes: inputBytes.length, sha256: sha256(inputBytes), sourceCount: Object.keys(parsedInput.sources || {}).length,
        optimizer: parsedInput.settings?.optimizer || null, evmVersion: parsedInput.settings?.evmVersion || null,
        metadata: parsedInput.settings?.metadata || null, viaIR: parsedInput.settings?.viaIR ?? false },
      output: { path: rel(outputPath), bytes: fs.statSync(outputPath).size, sha256: sha256(fs.readFileSync(outputPath)), warnings: errors.filter((e) => e.severity !== "error").length,
        fatalErrors: fatal.length, compiledSourceCount: Object.keys(output.sources || {}).length },
      target: { fileName: authority.fileName, contractName: authority.contractName, creationBytes: creation.length / 2,
        creationSha256: sha256(Buffer.from(creation, "hex")), creationKeccak256: keccak256(`0x${creation}`), runtimeBytes: runtime.length / 2,
        runtimeSha256: sha256(Buffer.from(runtime, "hex")), runtimeKeccak256: keccak256(`0x${runtime}`),
        immutableReferences: evm.deployedBytecode?.immutableReferences || {}, linkReferences: evm.deployedBytecode?.linkReferences || {},
        creationLinkReferences: evm.bytecode?.linkReferences || {}, cbor: extractCbor(runtime), metadataJsonSha256: typeof artifact.metadata === "string" ? sha256(Buffer.from(artifact.metadata)) : null,
        storageEntries: Array.isArray(artifact.storageLayout?.storage) ? artifact.storageLayout.storage.length : null,
        storageTypes: artifact.storageLayout?.types ? Object.keys(artifact.storageLayout.types).length : null },
      constructorArguments: authority.constructorArguments,
      safety: { localCompilationOnly: true, rpcInventoryRead: false, environmentFilesRead: false, keysRead: false, transaction: false, signing: false, fork: false }
    };
    const evidencePath = path.join(recDir, "build-evidence.json"); fs.writeFileSync(evidencePath, `${JSON.stringify(buildEvidence, null, 2)}\n`);
    records.push({ id: rec.id, address: rec.address, phase: rec.phase, repository: rec.repository, compilerVersion: longVersion,
      optimizer: buildEvidence.input.optimizer, sourceCount: buildEvidence.input.sourceCount, compiledSourceCount: buildEvidence.output.compiledSourceCount,
      exitCode: run.status, runtimeBytes: buildEvidence.target.runtimeBytes, runtimeKeccak256: buildEvidence.target.runtimeKeccak256,
      creationKeccak256: buildEvidence.target.creationKeccak256, immutableReferenceGroups: Object.keys(buildEvidence.target.immutableReferences).length,
      linkReferenceFiles: Object.keys(buildEvidence.target.linkReferences).length, cborPresent: buildEvidence.target.cbor.present,
      buildEvidence: rel(evidencePath), compilerOutput: rel(outputPath) });
  }
  const summary = { schemaVersion: "etherfi-26q2-provenance-r2/hermetic-build-summary-v1", generatedAt: new Date().toISOString(),
    status: records.length === 11 && records.every((r) => r.exitCode === 0) ? "PASS_11_OF_11_ACTUAL_STANDARD_JSON_BUILDS" : "FAIL",
    actualExecution: true, expectedRecords: 11, builtRecords: records.length, compilerVersions: compilerEvidence, records,
    limitations: ["Build success alone does not establish deployed runtime equality or official Git provenance."],
    safety: { localBuildOnly: true, lifecycleScripts: false, fork: false, transaction: false, signing: false } };
  fs.writeFileSync(path.join(OUT, "build-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ status: summary.status, records: records.length, compilers: Object.keys(compilerEvidence),
    optimizers: records.map((r) => [r.id, r.optimizer]) }));
}

main().catch((e) => { console.error(JSON.stringify({ status: "FAIL_CLOSED", code: e instanceof Stop ? e.code : "UNEXPECTED",
  details: e instanceof Stop ? e.details : { name: e?.name, message: String(e?.message || "").slice(0, 300) } })); process.exitCode = 1; });
