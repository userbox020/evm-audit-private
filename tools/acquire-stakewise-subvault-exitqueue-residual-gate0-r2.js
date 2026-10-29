#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");
const { keccak256 } = require("./node_modules/ethers");

const ROOT = path.resolve(__dirname, "..");
const GATE0 = path.join(ROOT, "reports", "raw", "fast", "stakewise-subvault-exitqueue-residual-gate0", "capture.json");
const OUT = path.join(ROOT, "reports", "raw", "fast", "stakewise-subvault-exitqueue-residual-gate0-r2");
const CURRENT = path.join(ROOT, "targets", "stakewise-v3-core-v5.0.1");
const PREDECESSOR = "C:\\Users\\MiPC\\AppData\\Local\\Temp\\opencode\\stakewise-v500-gate0";
const CAPTURE_SHA256 = "51aa5cdb9082231a03029a8ad937316c92f01263fa70745be578306b2df3cc1f";
const LIMIT = 64 * 1024 * 1024;
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const stable = (value) => Array.isArray(value) ? `[${value.map(stable).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}` : JSON.stringify(value);
function fail(code) { throw new Error(code); }
function safePath(value) { const normalized = value.replaceAll("\\", "/").replace(/^\/+/, ""); if (!normalized || normalized.split("/").some((x) => !x || x === "." || x === "..")) fail("UNSAFE_SOURCE_PATH"); return normalized; }
function write(file, bytes) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); }
function rel(file) { return path.relative(ROOT, file).replaceAll("\\", "/"); }
function getJson(host, requestPath, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get({ hostname: host, path: requestPath, method: "GET", headers: { accept: "application/json", "user-agent": "authorized-defensive-source-recovery" }, timeout: 30000 }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 2) { res.resume(); const next = new URL(res.headers.location); return getJson(next.hostname, `${next.pathname}${next.search}`, redirects + 1).then(resolve, reject); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP_${res.statusCode}`)); }
      const chunks = []; let size = 0;
      res.on("data", (chunk) => { size += chunk.length; if (size > LIMIT) { req.destroy(new Error("RESPONSE_LIMIT")); return; } chunks.push(chunk); });
      res.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (_) { reject(new Error("INVALID_JSON")); } });
    });
    req.on("timeout", () => req.destroy(new Error("TIMEOUT"))); req.on("error", reject);
  });
}
function localBinding(filePath, content) {
  const bytes = Buffer.from(content), digest = sha256(bytes), result = { sourceSha256: digest, current: false, predecessor: false, currentGitCommit: null, predecessorGitCommit: null };
  for (const [root, key, commitKey, commit] of [[CURRENT, "current", "currentGitCommit", "fc70cbe1b3d41bc5f78434830d837aa270ca33bc"], [PREDECESSOR, "predecessor", "predecessorGitCommit", "31b2da5e9c729b00ead0db16369141608410bee8"]]) {
    const candidate = path.join(root, ...filePath.split("/"));
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile() && sha256(fs.readFileSync(candidate)) === digest) { result[key] = true; result[commitKey] = commit; }
  }
  return result;
}
function normalizeCompiler(version) { const match = String(version || "").match(/v?(0\.8\.(?:22|26)\+commit\.[0-9a-f]{8})/iu); if (!match) fail("UNSUPPORTED_COMPILER"); return match[1]; }

const TARGETS = Object.freeze([
  { chain: "ethereum", host: "eth.blockscout.com", address: "0x3a0008a588772446f6e656133c2d5029cc4fc20e", roles: ["vaults-registry"], expected: "0xfea640fe67d9867f0feb82794b496e3d0f9812fe56493eb8eab3d33b4c3194ba", material: true },
  { chain: "ethereum", host: "eth.blockscout.com", address: "0x6107db0bdd84023228e0ab11099190e88b073c1d", roles: ["meta-factory-other-registry-caller-or-factory"], expected: "0xb6de9ac923974145a7d621635b8b27095cc21a164c09a1fed704f608e93be9a6", material: false },
  { chain: "ethereum", host: "eth.blockscout.com", address: "0xd0d527b67186d8880f9427ea4cf9847e89bce764", roles: ["meta-factory-implementation-other-registry-caller-or-factory"], expected: "0xbbdac95302b3f038ecfc6fed57da007e2b94647253a137e966f73aec41762249", material: false },
  { chain: "ethereum", host: "eth.blockscout.com", address: "0xac0f906e433d58fa868f936e8a43230473652885", roles: ["child-proxy", "duplicate-proxy-family"], expected: "0x95341690861a566af190df6392bba32f9f9645191a89ddd9252ffa8c061b624b", material: true },
  { chain: "ethereum", host: "eth.blockscout.com", address: "0xf113bfd6423291b1dd2ca76f897bff54456e7c88", roles: ["child-implementation", "EthGenesisVault"], expected: "0x0163dff0145d814a24df66ec2c1037cd2afbdf5811536f0c9645d16d2742706a", material: true },
  { chain: "ethereum", host: "eth.blockscout.com", address: "0xd2037ca73ed58b3f97f471ade4384ac52ee7becc", roles: ["child-implementation", "EthPrivVault"], expected: "0x34d5189d3785222b4a1e81e176afb98669d6f0bc51456c2a7b03d84f67ca16db", material: false },
  { chain: "ethereum", host: "eth.blockscout.com", address: "0x927a83c679a5e1a6435d6bfaef7f20d4db23e2cc", roles: ["child-implementation", "EthVault"], expected: "0xe6381554eb02cdb8fa2814920f1af952ed1580d43877f357045910fbad0ea20f", material: false },
  { chain: "gnosis", host: "gnosisscan.io", address: "0x7d014b3c6ee446563d4e0cb6fbd8c3d0419867cb", roles: ["vaults-registry"], expected: "0xa4032e5c6e1068f17d6d856e2774a2759fee1ab0df359a2a222f71cbe9db40a7", material: true },
  { chain: "gnosis", host: "gnosisscan.io", address: "0x3dec6026137010783571697b98011c4c01010895", roles: ["sub-registry-implementation-current", "sub-registry-implementation"], expected: "0x12f6ca38ec73ffa92ce9d3156d2fd9704c69d71da43e3d862a97f548cb8d3e62", material: true },
  { chain: "gnosis", host: "gnosisscan.io", address: "0x9778317a6f6ff0224e8c1dd30af71e1e25edc5d1", roles: ["sub-registry-implementation-predecessor"], expected: "0xd159e3828b948dd094e7922e227a5b45d9be62271aa6b7c14a4c05c5d20d9482", material: false },
  { chain: "gnosis", host: "gnosisscan.io", address: "0x6107db0bdd84023228e0ab11099190e88b073c1d", roles: ["meta-factory-other-registry-caller-or-factory"], expected: "0xda40ea206e1b2bc1fbae30ed9658e279cbf3cf53feb37f71645e1d9399cc9695", material: true },
  { chain: "gnosis", host: "gnosisscan.io", address: "0xd0d527b67186d8880f9427ea4cf9847e89bce764", roles: ["meta-factory-implementation-other-registry-caller-or-factory"], expected: "0x65215bdb080a712c9cbc1ee0c8c77080dcc032e5ac20792cd2dd49dbf1f47080", material: true },
  { chain: "gnosis", host: "gnosisscan.io", address: "0x75e6f7640137c128c91de4ee62f6f30b542e5f1b", roles: ["meta-factory-removed-predecessor-meta-factory"], expected: "0x627b46f69458cd5e30a7f6513df995425d23c4e232ad626253634416e8dd1483", material: false },
  { chain: "gnosis", host: "gnosisscan.io", address: "0x0ba13125fc3a300538bb890529182df7ccc5a19b", roles: ["meta-factory-implementation-removed-predecessor-meta-factory"], expected: "0x453c0bb0090c680eea642dabc339fc390154e0babd87686b06b435bcf324191c", material: false },
  { chain: "gnosis", host: "gnosisscan.io", address: "0x6f59ae1dd36eed6d7a928505f754b2965197c8e5", roles: ["parent-implementation", "child-implementation", "GnoMetaVault-v5"], expected: "0x3aac7d7922313e3d1a5fafe005de2dfd3a2cb55bb7ba37e4827aa576145975a7", material: true },
  { chain: "gnosis", host: "gnosisscan.io", address: "0x4b4406ed8659d03423490d8b62a1639206da0a7a", roles: ["child-proxy", "duplicate-proxy-family"], expected: "0x95341690861a566af190df6392bba32f9f9645191a89ddd9252ffa8c061b624b", material: true },
  { chain: "gnosis", host: "gnosisscan.io", address: "0xf113bfd6423291b1dd2ca76f897bff54456e7c88", roles: ["child-implementation", "GnoGenesisVault"], expected: "0x00a2232ae1087dae45c97723527e6dc7c95240c9b95ed5e2baa8353ba97511bc", material: true }
]);

async function main() {
  if (process.argv.length !== 2) fail("ARGV");
  const captureBytes = fs.readFileSync(GATE0); if (sha256(captureBytes) !== CAPTURE_SHA256) fail("CAPTURE_IMMUTABILITY");
  const records = [];
  for (const target of TARGETS) {
    const raw = await getJson(target.host, `/api/v2/smart-contracts/${target.address}`);
    if (!raw.is_verified || !raw.deployed_bytecode || !raw.source_code || !raw.file_path || !raw.compiler_settings) fail(`UNVERIFIED_${target.chain}_${target.address}`);
    const runtime = String(raw.deployed_bytecode).toLowerCase(), runtimeBytes = Buffer.from(runtime.slice(2), "hex"), runtimeKeccak256 = keccak256(runtimeBytes).toLowerCase();
    if (runtimeKeccak256 !== target.expected) fail(`RUNTIME_HASH_${target.chain}_${target.address}`);
    const sources = [{ file_path: safePath(raw.file_path), source_code: raw.source_code }, ...(raw.additional_sources || []).map((x) => ({ file_path: safePath(x.file_path), source_code: x.source_code }))];
    const uniqueSources = [...new Map(sources.map((x) => [x.file_path, x])).values()]; if (!uniqueSources.length || uniqueSources.some((x) => typeof x.source_code !== "string")) fail("SOURCE_SCHEMA");
    const settings = structuredClone(raw.compiler_settings); settings.outputSelection = { "*": { "*": ["abi", "metadata", "evm.deployedBytecode.object", "evm.deployedBytecode.immutableReferences", "evm.deployedBytecode.linkReferences"], "": ["ast"] } };
    const standardInput = { language: raw.language || "Solidity", sources: Object.fromEntries(uniqueSources.map((x) => [x.file_path, { content: x.source_code }])), settings };
    const standardBytes = Buffer.from(`${JSON.stringify(standardInput, null, 2)}\n`), standardSha = sha256(standardBytes), bundleDir = path.join(OUT, "source-authority", target.chain, `${target.address}-${standardSha}`);
    const sourceRows = [];
    for (const source of uniqueSources) { const sourceBytes = Buffer.from(source.source_code), outputPath = path.join(bundleDir, "sources", ...source.file_path.split("/")); write(outputPath, sourceBytes); sourceRows.push({ filePath: source.file_path, bytes: sourceBytes.length, sha256: sha256(sourceBytes), authorityPath: rel(outputPath), localBinding: localBinding(source.file_path, source.source_code) }); }
    const inputPath = path.join(bundleDir, "standard-input.json"); write(inputPath, standardBytes);
    const runtimePath = path.join(OUT, "runtime-authority", target.chain, `${runtimeKeccak256.slice(2)}.hex`); if (!fs.existsSync(runtimePath)) write(runtimePath, Buffer.from(`${runtime}\n`)); else if (fs.readFileSync(runtimePath, "utf8").trim().toLowerCase() !== runtime) fail("RUNTIME_CONTENT_COLLISION");
    const authority = {
      schemaVersion: 1, chain: target.chain, address: target.address, roles: target.roles, materialSignalGraph: target.material,
      explorerVerification: { isVerified: raw.is_verified, isFullyVerified: raw.is_fully_verified, isPartiallyVerified: raw.is_partially_verified === true || raw.is_fully_verified === false, isVerifiedViaSourcify: Boolean(raw.is_verified_via_sourcify), isVerifiedViaEthBytecodeDb: Boolean(raw.is_verified_via_eth_bytecode_db), name: raw.name, filePath: raw.file_path, compilerVersion: normalizeCompiler(raw.compiler_version), optimizationEnabled: raw.optimization_enabled, optimizationRuns: raw.optimization_runs, evmVersion: raw.evm_version, compilerSettings: raw.compiler_settings, decodedConstructorArgs: raw.decoded_constructor_args || null, externalLibraries: raw.external_libraries || [] },
      sourceFiles: sourceRows, standardInputPath: rel(inputPath), standardInputSha256: standardSha,
      runtime: { bytes: runtimeBytes.length, keccak256: runtimeKeccak256, sha256: sha256(runtimeBytes), authorityPath: rel(runtimePath), equalsGate0TwoFamilyCodeHash: true },
      creationBytecode: raw.creation_bytecode ? { bytes: (String(raw.creation_bytecode).length - 2) / 2, sha256: sha256(Buffer.from(String(raw.creation_bytecode).slice(2), "hex")) } : null,
      proxyType: raw.proxy_type || null, implementations: raw.implementations || []
    };
    const authorityBytes = Buffer.from(`${JSON.stringify(authority, null, 2)}\n`), authorityPath = path.join(bundleDir, "authority.json"); write(authorityPath, authorityBytes);
    records.push({ chain: target.chain, address: target.address, roles: target.roles, materialSignalGraph: target.material, name: raw.name, compilerVersion: authority.explorerVerification.compilerVersion, optimizerRuns: raw.optimization_runs, evmVersion: raw.evm_version, viaIR: raw.compiler_settings.viaIR, sourceFiles: sourceRows.length, standardInputSha256: standardSha, runtime: authority.runtime, authorityPath: rel(authorityPath), authoritySha256: sha256(authorityBytes) });
  }
  const uniqueRuntimeHashes = [...new Set(records.map((x) => x.runtime.keccak256))];
  const summary = { schemaVersion: 1, acquisitionId: "stakewise-subvault-exitqueue-residual-gate0-r2", generatedAt: new Date().toISOString(), status: "PASS", gate0CaptureSha256: CAPTURE_SHA256, publicExplorerReads: TARGETS.length, rpcReads: 0, historyReads: 0, stateReads: 0, sourceAuthorityRecords: records.length, uniqueRuntimeFamilies: uniqueRuntimeHashes.length, materialAuthorityRecords: records.filter((x) => x.materialSignalGraph).length, records, uniqueRuntimeHashes, sanitization: "PASS", endpointsPersisted: false, secretsRead: false, signing: false, transactions: false, fork: false };
  const bytes = Buffer.from(`${JSON.stringify(summary, null, 2)}\n`); write(path.join(OUT, "acquisition.json"), bytes);
  console.log(JSON.stringify({ status: summary.status, records: records.length, uniqueRuntimeFamilies: uniqueRuntimeHashes.length, materialRecords: summary.materialAuthorityRecords, acquisitionSha256: sha256(bytes) }));
}

main().catch((error) => { console.error(JSON.stringify({ status: "FAIL_CLOSED", code: String(error.message || "FAILURE") })); process.exitCode = 1; });
