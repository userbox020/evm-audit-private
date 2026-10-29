#!/usr/bin/env node
"use strict";

// Offline construction helper. This script never reads endpoint inventories and
// never performs network I/O. It reproduces the exact solc 0.7.6 deployed
// runtime templates used by the capture runner.
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SOURCE_ROOT = path.join(ROOT, "targets", "notional-contracts-v3-6e7907e");
const OUTPUT = path.join(__dirname, "fixtures", "notional-v3-missed-quarter-stage-a-r2-runtime-manifest.json");
const ROLES = Object.freeze({
  proxy: ["nProxy", "contracts/proxy/nProxy.sol"],
  router: ["Router", "contracts/external/Router.sol"],
  initializeMarkets: ["InitializeMarketsAction", "contracts/external/actions/InitializeMarketsAction.sol"],
  views: ["Views", "contracts/external/Views.sol"],
  nTokenMint: ["nTokenMintAction", "contracts/external/actions/nTokenMintAction.sol"],
  freeCollateral: ["FreeCollateralExternal", "contracts/external/FreeCollateralExternal.sol"]
});
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function cborRecord(object) {
  if (typeof object !== "string" || object.length < 4 || !/^[0-9a-fA-F_$]*$/u.test(object)) throw new Error("RUNTIME_OBJECT_INVALID");
  const trailer = object.slice(-4); if (!/^[0-9a-fA-F]{4}$/u.test(trailer)) throw new Error("CBOR_TRAILER_INVALID");
  const length = Number.parseInt(trailer, 16), start = object.length - 4 - length * 2;
  if (start < 0) throw new Error("CBOR_LENGTH_INVALID"); const hex = object.slice(start, -4);
  if (!/^[0-9a-fA-F]+$/u.test(hex)) throw new Error("CBOR_HEX_INVALID");
  const first = Number.parseInt(hex.slice(0, 2), 16); if (first < 0xa0 || first > 0xbf) throw new Error("CBOR_MAP_INVALID");
  return { start: start / 2, bytes: length + 2, payloadBytes: length, sha256: sha256(Buffer.from(hex, "hex")), validMap: true };
}
function readArtifact(name) {
  const file = path.join(SOURCE_ROOT, "build", "contracts", `${name}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}
function sourceContent(sourceName) {
  if (sourceName.startsWith("OpenZeppelin/")) return fs.readFileSync(path.join(os.homedir(), ".brownie", "packages", ...sourceName.split("/")), "utf8");
  if (path.isAbsolute(sourceName)) return fs.readFileSync(sourceName, "utf8");
  return fs.readFileSync(path.join(SOURCE_ROOT, ...sourceName.split("/")), "utf8");
}
function canonicalSourceName(sourceName) {
  const normalized = sourceName.replace(/\\/gu, "/"), marker = "/.brownie/packages/";
  const at = normalized.indexOf(marker); return at >= 0 ? normalized.slice(at + marker.length) : normalized;
}
function walk(node, sourceName, declarations, contractDefinitions) {
  if (!node || typeof node !== "object") return;
  if (node.nodeType === "VariableDeclaration") declarations.set(String(node.id), {
    name: node.name || null, type: node.typeDescriptions?.typeString || null, sourceName
  });
  if (node.nodeType === "ContractDefinition") contractDefinitions.set(`${sourceName}:${node.name}`, { contractKind: node.contractKind, astId: String(node.id) });
  for (const value of Object.values(node)) walk(value, sourceName, declarations, contractDefinitions);
}
function main() {
  const artifacts = Object.fromEntries(Object.entries(ROLES).map(([role, [name]]) => [role, readArtifact(name)]));
  const sourceNames = new Set();
  const visit = (sourceName) => {
    sourceName = canonicalSourceName(sourceName); if (sourceNames.has(sourceName)) return; sourceNames.add(sourceName);
    const content = sourceContent(sourceName);
    for (const match of content.matchAll(/\bimport\s+(?:[^"']*\s+from\s+)?["']([^"']+)["']\s*;/gu)) {
      let imported = match[1];
      if (imported.startsWith("@openzeppelin/")) imported = `OpenZeppelin/openzeppelin-contracts@3.4.2-solc-0.7/${imported.slice("@openzeppelin/".length)}`;
      else imported = path.posix.normalize(path.posix.join(path.posix.dirname(sourceName), imported));
      visit(imported);
    }
  };
  for (const [, sourceName] of Object.values(ROLES)) visit(sourceName);
  const sources = Object.fromEntries([...sourceNames].sort().map((sourceName) => [sourceName, { content: sourceContent(sourceName) }]));
  const input = { language: "Solidity", sources, settings: {
    optimizer: { enabled: true, runs: 200 }, evmVersion: "istanbul",
    remappings: ["@openzeppelin=OpenZeppelin/openzeppelin-contracts@3.4.2-solc-0.7"],
    outputSelection: { "*": { "*": ["evm.deployedBytecode.object", "evm.deployedBytecode.linkReferences", "evm.deployedBytecode.immutableReferences"], "": ["ast"] } }
  } };
  const solc = process.env.SOLC_076 || path.join(os.homedir(), ".solcx", "solc-v0.7.6", "solc.exe");
  if (!fs.existsSync(solc)) throw new Error("SOLC_076_NOT_FOUND");
  const compiled = spawnSync(solc, ["--standard-json"], { input: JSON.stringify(input), encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  if (compiled.status !== 0) throw new Error("SOLC_076_FAILED");
  const output = JSON.parse(compiled.stdout); const fatal = (output.errors || []).filter((row) => row.severity === "error");
  if (fatal.length) throw new Error(`SOLC_076_ERRORS_${fatal.length}: ${fatal.map((row) => row.formattedMessage || row.message).join(" | ")}`);
  const declarations = new Map(), contractDefinitions = new Map(); for (const [sourceName, row] of Object.entries(output.sources || {})) walk(row.ast, sourceName, declarations, contractDefinitions);
  const contracts = {};
  for (const [role, [contractName, sourceName]] of Object.entries(ROLES)) {
    const artifact = artifacts[role], deployed = output.contracts?.[sourceName]?.[contractName]?.evm?.deployedBytecode;
    if (!deployed?.object) throw new Error(`COMPILED_RUNTIME_MISSING_${role}`);
    const compiledCbor = cborRecord(deployed.object);
    if (artifact) { if (deployed.object.length !== artifact.deployedBytecode.length) throw new Error(`BROWNIE_STANDARD_JSON_LENGTH_MISMATCH_${role}`);
      const artifactCbor = cborRecord(artifact.deployedBytecode); if (deployed.object.slice(0, compiledCbor.start * 2) !== artifact.deployedBytecode.slice(0, artifactCbor.start * 2)) throw new Error(`BROWNIE_STANDARD_JSON_EXECUTABLE_MISMATCH_${role}`); }
    const links = [];
    for (const [librarySource, byName] of Object.entries(deployed.linkReferences || {})) for (const [libraryName, ranges] of Object.entries(byName))
      links.push({ librarySource, libraryName, ranges: ranges.map(({ start, length }) => ({ start, length })) });
    const immutables = Object.entries(deployed.immutableReferences || {}).map(([astId, ranges]) => ({
      astId, ...(declarations.get(astId) || { name: null, type: null, sourceName: null }), ranges: ranges.map(({ start, length }) => ({ start, length }))
    }));
    const definition = contractDefinitions.get(`${sourceName}:${contractName}`); if (!definition) throw new Error(`CONTRACT_DEFINITION_MISSING_${role}`);
    let librarySelfReference = null; if (definition.contractKind === "library") { const exactPrefix = `73${"00".repeat(20)}3014`;
      if (!deployed.object.startsWith(exactPrefix)) throw new Error(`LIBRARY_SELF_PREFIX_INVALID_${role}`); librarySelfReference = { start: 1, length: 20, exactPrefix, proof: "solc-0.7.6 PUSH20 <self> ADDRESS EQ" }; }
    contracts[role] = { contractName, sourceName, runtimeTemplate: deployed.object, templateSha256: sha256(deployed.object),
      contractKind: definition.contractKind, contractAstId: definition.astId, runtimeBytes: deployed.object.length / 2, linkReferences: links, immutableReferences: immutables, librarySelfReference, cbor: compiledCbor };
  }
  const sourceRecords = [...sourceNames].sort().map((sourceName) => { const bytes = Buffer.from(sources[sourceName].content); return { sourceName, bytes: bytes.length, sha256: sha256(bytes) }; });
  const manifest = { schemaVersion: 2, sourceCommit: "6e7907e68ec99959144a0c939684a6da076f63c1",
    sourceTree: "b04475d3d783362b4da3e11e6f90f0fdedb42aa4", compiler: "0.7.6+commit.7338295f",
    optimizer: { enabled: true, runs: 200 }, evmVersion: "istanbul", contracts, sourceRecords,
    sourceAggregateSha256: sha256(sourceRecords.map((row) => `${row.sourceName}:${row.sha256}`).join("\n")) };
  fs.writeFileSync(OUTPUT, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "w" });
  process.stdout.write(`wrote ${path.relative(ROOT, OUTPUT).replace(/\\/gu, "/")} (${Object.keys(contracts).length} exact runtimes, ${sourceRecords.length} sources)\n`);
}
try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
