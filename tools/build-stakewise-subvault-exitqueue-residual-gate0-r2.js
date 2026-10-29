#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");
const solcWrapper = require("./node_modules/solc/wrapper");
const { getAddress, keccak256 } = require("./node_modules/ethers");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "reports", "raw", "fast", "stakewise-subvault-exitqueue-residual-gate0-r2");
const ACQUISITION = path.join(OUT, "acquisition.json");
const CAPTURE_SHA256 = "51aa5cdb9082231a03029a8ad937316c92f01263fa70745be578306b2df3cc1f";
const LIMIT = 64 * 1024 * 1024;
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
function fail(code) { throw new Error(code); }
function rel(file) { return path.relative(ROOT, file).replaceAll("\\", "/"); }
function write(file, bytes) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); }
function get(host, requestPath, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get({ hostname: host, path: requestPath, method: "GET", headers: { accept: "application/json,text/javascript", "user-agent": "authorized-defensive-exact-build" }, timeout: 30000 }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 2) { res.resume(); const next = new URL(res.headers.location); return get(next.hostname, `${next.pathname}${next.search}`, redirects + 1).then(resolve, reject); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP_${res.statusCode}`)); }
      const chunks = []; let size = 0; res.on("data", (chunk) => { size += chunk.length; if (size > LIMIT) req.destroy(new Error("RESPONSE_LIMIT")); else chunks.push(chunk); }); res.on("end", () => resolve(Buffer.concat(chunks)));
    }); req.on("timeout", () => req.destroy(new Error("TIMEOUT"))); req.on("error", reject);
  });
}
function normalizeHex(value) { const out = String(value || "").toLowerCase(); if (!/^0x[0-9a-f]*$/u.test(out) || out.length % 2) fail("INVALID_HEX"); return out; }
function normalizeLibraries(libraries) {
  const normalized = {};
  for (const [key, value] of Object.entries(libraries || {})) {
    if (typeof value === "string") { const at = key.lastIndexOf(":"); if (at <= 0) fail("FLAT_LIBRARY_KEY"); const filePath = key.slice(0, at), name = key.slice(at + 1); (normalized[filePath] ||= {})[name] = value; }
    else normalized[key] = value;
  }
  return normalized;
}
function resolveDeclaredLinks(object, linkReferences, settingsLibraries, externalLibraries) {
  let linked = object; const resolved = [];
  for (const [filePath, names] of Object.entries(linkReferences || {})) for (const [name, refs] of Object.entries(names || {})) {
    let address = settingsLibraries?.[filePath]?.[name] || null;
    if (!address) for (const value of Object.values(settingsLibraries || {})) if (value && value[name]) { address = value[name]; break; }
    if (!address) { const match = (externalLibraries || []).find((x) => x.name === name); address = match?.address_hash || match?.address || null; }
    if (!address || !/^0x[0-9a-f]{40}$/iu.test(address)) fail(`UNRESOLVED_LIBRARY_${name}`); const raw = address.slice(2).toLowerCase();
    for (const ref of refs) { if (ref.length !== 20) fail("LINK_LENGTH"); linked = `${linked.slice(0, ref.start * 2)}${raw}${linked.slice((ref.start + ref.length) * 2)}`; }
    resolved.push({ filePath, name, address: address.toLowerCase(), offsets: refs });
  }
  if (!/^[0-9a-f]*$/iu.test(linked)) fail("UNDECLARED_LINK_PLACEHOLDER"); return { object: linked, resolved };
}
function patchAndDecode(compiledHex, deployedHex, immutableReferences) {
  const compiled = Buffer.from(compiledHex, "hex"), deployed = Buffer.from(deployedHex.slice(2), "hex"); if (compiled.length !== deployed.length) return { equal: false, reason: "LENGTH", compiledBytes: compiled.length, deployedBytes: deployed.length, decoded: [], patched: compiled };
  const patched = Buffer.from(compiled), covered = new Set(), decoded = [];
  for (const [astId, refs] of Object.entries(immutableReferences || {})) {
    let common = null;
    for (const ref of refs) { if (!Number.isInteger(ref.start) || !Number.isInteger(ref.length) || ref.start < 0 || ref.length <= 0 || ref.start + ref.length > deployed.length) fail("IMMUTABLE_RANGE"); const value = deployed.subarray(ref.start, ref.start + ref.length); if (common && !common.equals(value)) fail("IMMUTABLE_INCONSISTENT"); common = value; value.copy(patched, ref.start); for (let i = ref.start; i < ref.start + ref.length; i++) covered.add(i); }
    const hex = `0x${common.toString("hex")}`; const item = { astId, offsets: refs, bytes: common.length, hex, uint256: common.length <= 32 ? BigInt(hex).toString() : null, address: common.length === 32 && common.subarray(0, 12).every((x) => x === 0) ? getAddress(`0x${common.subarray(12).toString("hex")}`).toLowerCase() : null }; decoded.push(item);
  }
  const unexplained = []; for (let i = 0; i < deployed.length; i++) if (patched[i] !== deployed[i] && !covered.has(i)) { unexplained.push(i); if (unexplained.length > 20) break; }
  return { equal: patched.equals(deployed), reason: unexplained.length ? "UNEXPLAINED_BYTES" : patched.equals(deployed) ? "EXACT_AFTER_DECLARED_IMMUTABLES" : "MISMATCH", compiledBytes: compiled.length, deployedBytes: deployed.length, decoded, unexplainedOffsets: unexplained, patched };
}
function compile(solc, input, filePath, contractName) {
  const output = JSON.parse(solc.compile(JSON.stringify(input))); const errors = (output.errors || []).filter((x) => x.severity === "error"); if (errors.length) fail(`COMPILE_${contractName}_${errors.map((x) => x.errorCode || x.type || "ERROR").join("_")}_${String(errors[0].formattedMessage || errors[0].message || "").replace(/\s+/gu, " ").slice(0, 240)}`);
  const contract = output.contracts?.[filePath]?.[contractName]; if (!contract) fail(`MISSING_CONTRACT_${contractName}`); return { contract, warnings: (output.errors || []).filter((x) => x.severity !== "error").map((x) => ({ errorCode: x.errorCode || null, type: x.type, severity: x.severity })) };
}

async function main() {
  if (process.argv.length !== 2) fail("ARGV");
  const acquisitionBytes = fs.readFileSync(ACQUISITION), acquisition = JSON.parse(acquisitionBytes); if (acquisition.status !== "PASS" || acquisition.gate0CaptureSha256 !== CAPTURE_SHA256) fail("ACQUISITION");
  const compilerListBytes = await get("binaries.soliditylang.org", "/bin/list.json"), compilerList = JSON.parse(compilerListBytes.toString("utf8"));
  const versions = [...new Set(acquisition.records.map((x) => x.compilerVersion))]; const compilers = new Map(), compilerAuthority = [];
  for (const exactVersion of versions) {
    const semver = exactVersion.split("+")[0], build = compilerList.builds.find((x) => x.version === semver && x.longVersion === exactVersion); if (!build) fail(`COMPILER_LIST_${exactVersion}`);
    const bytes = await get("binaries.soliditylang.org", `/bin/${build.path}`); const digest = sha256(bytes); if (build.sha256 && build.sha256.toLowerCase() !== `0x${digest}`) fail(`COMPILER_SHA256_${exactVersion}`); if (build.keccak256 && build.keccak256.toLowerCase() !== keccak256(bytes).toLowerCase()) fail(`COMPILER_KECCAK_${exactVersion}`);
    const compilerPath = path.join(OUT, "compiler-authority", `${digest}.js`); write(compilerPath, bytes); delete require.cache[require.resolve(compilerPath)]; const solc = solcWrapper(require(compilerPath)); if (!solc.version().includes(exactVersion)) fail(`COMPILER_VERSION_${exactVersion}`); compilers.set(exactVersion, solc);
    compilerAuthority.push({ version: exactVersion, longVersion: build.longVersion, path: build.path, sha256: digest, keccak256: keccak256(bytes), bytes: bytes.length, authorityPath: rel(compilerPath) });
  }
  const records = [];
  for (const record of acquisition.records) {
    const authority = JSON.parse(fs.readFileSync(path.join(ROOT, ...record.authorityPath.split("/")), "utf8")); const inputPath = path.join(ROOT, ...authority.standardInputPath.split("/")), inputBytes = fs.readFileSync(inputPath); if (sha256(inputBytes) !== authority.standardInputSha256) fail("STANDARD_INPUT_HASH"); const input = JSON.parse(inputBytes);
    const explorerLanguage = input.language; if (String(input.language).toLowerCase() === "solidity") input.language = "Solidity"; const explorerLibraries = input.settings.libraries || {}; input.settings.libraries = normalizeLibraries(explorerLibraries);
    const runtimePath = path.join(ROOT, ...authority.runtime.authorityPath.split("/")), deployed = normalizeHex(fs.readFileSync(runtimePath, "utf8").trim()); if (keccak256(deployed) !== authority.runtime.keccak256) fail("RUNTIME_AUTHORITY_HASH");
    const result = compile(compilers.get(authority.explorerVerification.compilerVersion), input, authority.explorerVerification.filePath, authority.explorerVerification.name); const templateObject = result.contract.evm.deployedBytecode.object; const linked = resolveDeclaredLinks(templateObject, result.contract.evm.deployedBytecode.linkReferences, input.settings.libraries, authority.explorerVerification.externalLibraries); const object = linked.object;
    const comparison = patchAndDecode(object, deployed, result.contract.evm.deployedBytecode.immutableReferences); if (!comparison.equal) fail(`BYTE_MISMATCH_${record.chain}_${record.address}_${comparison.reason}`);
    const metadata = JSON.parse(result.contract.metadata); const buildRecord = {
      schemaVersion: 1, chain: record.chain, address: record.address, roles: record.roles, materialSignalGraph: record.materialSignalGraph, contract: { filePath: authority.explorerVerification.filePath, name: authority.explorerVerification.name },
      profile: { compilerVersion: authority.explorerVerification.compilerVersion, explorerLanguage, compilerLanguage: input.language, evmVersion: input.settings.evmVersion, viaIR: input.settings.viaIR, optimizer: input.settings.optimizer, metadata: input.settings.metadata, explorerLibraries, compilerLibraries: input.settings.libraries || {} },
      sourceAuthority: { standardInputPath: authority.standardInputPath, standardInputSha256: authority.standardInputSha256, files: authority.sourceFiles.length }, runtimeAuthority: authority.runtime,
      exactRuntimeBinding: { status: "PASS", equality: true, comparisonMode: comparison.decoded.length || linked.resolved.length ? "compiler-declared-links-and-immutables-only" : "literal-byte-equality", compiledLinkedTemplateKeccak256: keccak256(`0x${object}`), patchedRuntimeKeccak256: keccak256(comparison.patched), deployedRuntimeKeccak256: authority.runtime.keccak256, bytes: comparison.compiledBytes, immutableReferences: comparison.decoded, linkReferences: result.contract.evm.deployedBytecode.linkReferences || {}, resolvedLinks: linked.resolved, metadataCompilerVersion: metadata.compiler?.version || null }, warnings: result.warnings
    };
    const outputBytes = Buffer.from(`${JSON.stringify(buildRecord, null, 2)}\n`), outputPath = path.join(OUT, "builds", record.chain, `${record.address}-${authority.runtime.keccak256.slice(2)}.json`); write(outputPath, outputBytes);
    records.push({ chain: record.chain, address: record.address, roles: record.roles, materialSignalGraph: record.materialSignalGraph, name: authority.explorerVerification.name, profile: buildRecord.profile, runtimeKeccak256: authority.runtime.keccak256, exact: true, comparisonMode: buildRecord.exactRuntimeBinding.comparisonMode, immutableCount: comparison.decoded.length, buildPath: rel(outputPath), buildSha256: sha256(outputBytes) });
  }
  const counterfactuals = [];
  for (const address of ["0x6f59ae1dd36eed6d7a928505f754b2965197c8e5", "0x3dec6026137010783571697b98011c4c01010895"]) {
    const record = acquisition.records.find((x) => x.chain === "gnosis" && x.address === address); const authority = JSON.parse(fs.readFileSync(path.join(ROOT, ...record.authorityPath.split("/")), "utf8")); const input = JSON.parse(fs.readFileSync(path.join(ROOT, ...authority.standardInputPath.split("/")), "utf8")); if (String(input.language).toLowerCase() === "solidity") input.language = "Solidity"; input.settings.libraries = normalizeLibraries(input.settings.libraries); input.settings.optimizer.runs = 120;
    const result = compile(compilers.get(authority.explorerVerification.compilerVersion), input, authority.explorerVerification.filePath, authority.explorerVerification.name); const linked = resolveDeclaredLinks(result.contract.evm.deployedBytecode.object, result.contract.evm.deployedBytecode.linkReferences, input.settings.libraries, authority.explorerVerification.externalLibraries); const object = linked.object; const deployed = normalizeHex(fs.readFileSync(path.join(ROOT, ...authority.runtime.authorityPath.split("/")), "utf8").trim()); const comparison = patchAndDecode(object, deployed, result.contract.evm.deployedBytecode.immutableReferences);
    counterfactuals.push({ chain: "gnosis", address, contractName: authority.explorerVerification.name, deployedOptimizerRuns: 200, counterfactualOptimizerRuns: 120, exactAt200: true, exactAt120: comparison.equal, counterfactualTemplateKeccak256: keccak256(`0x${object}`), deployedRuntimeKeccak256: authority.runtime.keccak256, mismatchReason: comparison.reason });
  }
  if (counterfactuals.some((x) => x.exactAt120)) fail("PROFILE_120_FALSE_POSITIVE");
  const summary = { schemaVersion: 1, buildId: "stakewise-subvault-exitqueue-residual-gate0-r2", generatedAt: new Date().toISOString(), status: "PASS", gate0CaptureSha256: CAPTURE_SHA256, acquisitionSha256: sha256(acquisitionBytes), compilerAuthority, records, counterfactuals, exactRecords: records.filter((x) => x.exact).length, materialExactRecords: records.filter((x) => x.exact && x.materialSignalGraph).length, uniqueRuntimeFamiliesExact: new Set(records.map((x) => x.runtimeKeccak256)).size, rpcReads: 0, stateReads: 0, historyReads: 0, fork: false, signing: false, transactions: false };
  const bytes = Buffer.from(`${JSON.stringify(summary, null, 2)}\n`); write(path.join(OUT, "build.json"), bytes); console.log(JSON.stringify({ status: summary.status, records: summary.exactRecords, uniqueRuntimeFamilies: summary.uniqueRuntimeFamiliesExact, materialRecords: summary.materialExactRecords, counterfactual120Mismatch: counterfactuals.length, buildSha256: sha256(bytes) }));
}

main().catch((error) => { console.error(JSON.stringify({ status: "FAIL_CLOSED", code: String(error.message || "FAILURE") })); process.exitCode = 1; });
