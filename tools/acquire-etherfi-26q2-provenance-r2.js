#!/usr/bin/env node
"use strict";

// Public verified-source acquisition only. No RPC inventory, environment file,
// wallet, key, transaction, signing, broadcast, or fork access.
const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const crypto = require("node:crypto");
const { keccak256 } = require("./node_modules/ethers");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "reports", "raw", "fast", "etherfi-26q2-upgrade-migration-gate0-r2", "verified-inputs");
const SUMMARY = path.join(OUT, "acquisition-summary.json");
const HOST = "eth.blockscout.com";
const LIMITS = Object.freeze({ records: 11, responseBytes: 8 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, requestMs: 45_000 });
const RECORDS = Object.freeze([
  ["local-prior-deposit-adapter", "DepositAdapter", "prior", "0xe87797a1afb329216811dfa22c87380128ca17d8", "smart-contracts"],
  ["local-prior-membership-manager", "MembershipManager", "prior", "0x047a7749ad683c2fd8a27c7904ca8dd128f15889", "smart-contracts"],
  ["local-prior-membership-nft", "MembershipNFT", "prior", "0x290d981b41b713437265cd7846806d7500307106", "smart-contracts"],
  ["local-prior-cmrd", "CumulativeMerkleRewardsDistributor", "prior", "0xd3f3480511fb25a3d86568b6e1efba09d0adeebf", "smart-contracts"],
  ["local-prior-auction-manager", "AuctionManager", "prior", "0x68fe80c6e97e0c8613e2fed344358c6635ba5366", "smart-contracts"],
  ["local-prior-node-operator-manager", "NodeOperatorManager", "prior", "0xfcc674fc9a0602692d2a91905e7e978ae6ee2caf", "smart-contracts"],
  ["local-prior-role-registry", "RoleRegistry", "prior", "0x3a75019f8b09c278d152279d446c97d009e064f3", "smart-contracts"],
  ["l1-sync-pool-prior", "EtherfiL1SyncPoolETH", "prior", "0x2c28aed76d1fa85e1afe42ed476593d6cef50155", "weeth-cross-chain"],
  ["l1-sync-pool-post", "EtherfiL1SyncPoolETH", "post", "0x5d310451276d28a90cc6910449052d29a41e3abd", "weeth-cross-chain"],
  ["avs-operator-manager-prior", "AvsOperatorManager", "prior", "0xdc9e0d46bd75aa2837b266715d870b497104fae7", "avs-smart-contracts"],
  ["avs-operator-manager-post", "AvsOperatorManager", "post", "0xa4c83200e0c9a61296c63333f2bd22559058852e", "avs-smart-contracts"],
].map(([id, contract, phase, address, repository]) => ({ id, contract, phase, address, repository })));

class Stop extends Error { constructor(code, details) { super(code); this.code = code; this.details = details; } }
const fail = (code, details) => { throw new Stop(code, details); };
const sha256 = (b) => `0x${crypto.createHash("sha256").update(b).digest("hex")}`;
const rel = (p) => path.relative(ROOT, p).replaceAll("\\", "/");
function parseMaybeJson(v) { if (typeof v !== "string") return v; try { return JSON.parse(v); } catch (_) { return v; } }
function getSourcePath(x) { return x.Filename || x.FileName || x.filename || x.fileName || null; }
function getSourceContent(x) { return x.SourceCode ?? x.sourceCode ?? x.Content ?? x.content ?? null; }

function fetchPath(requestPath) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    const req = https.request({ protocol: "https:", hostname: HOST, port: 443, path: requestPath, method: "GET",
      agent: false, headers: { accept: "application/json", "accept-encoding": "identity", "user-agent": "defensive-audit-r2" } }, (res) => {
      res.on("data", (chunk) => { size += chunk.length; if (size > LIMITS.responseBytes) req.destroy(new Stop("RESPONSE_CAP")); else chunks.push(Buffer.from(chunk)); });
      res.on("end", () => { if (res.statusCode !== 200) return reject(new Stop("HTTP_STATUS", { status: res.statusCode })); resolve(Buffer.concat(chunks)); });
    });
    req.setTimeout(LIMITS.requestMs, () => req.destroy(new Stop("TIMEOUT")));
    req.on("error", (e) => reject(e instanceof Stop ? e : new Stop("TRANSPORT")));
    req.end();
  });
}

function normalizeRow(record, raw, v2Raw) {
  let payload; try { payload = JSON.parse(raw.toString("utf8")); } catch (_) { fail("EXPLORER_JSON", { id: record.id }); }
  const row = payload?.status === "1" && Array.isArray(payload.result) && payload.result.length === 1 ? payload.result[0] : null;
  if (!row || String(row.Address || "").toLowerCase() !== record.address) fail("EXPLORER_IDENTITY", { id: record.id });
  const primaryPath = row.FileName || row.Filename;
  const primaryContent = row.SourceCode;
  if (typeof primaryPath !== "string" || typeof primaryContent !== "string" || !primaryContent.length) fail("PRIMARY_SOURCE_MISSING", { id: record.id });
  const sourceRows = [{ path: primaryPath, content: primaryContent, primary: true }];
  for (const item of Array.isArray(row.AdditionalSources) ? row.AdditionalSources : []) {
    const p = getSourcePath(item), c = getSourceContent(item); if (typeof p !== "string" || typeof c !== "string") fail("ADDITIONAL_SOURCE_SCHEMA", { id: record.id });
    sourceRows.push({ path: p, content: c, primary: false });
  }
  const byPath = new Map();
  for (const s of sourceRows) { if (byPath.has(s.path) && byPath.get(s.path).content !== s.content) fail("DUPLICATE_SOURCE_CONFLICT", { id: record.id, path: s.path }); byPath.set(s.path, s); }
  const sources = Object.fromEntries([...byPath.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([p, s]) => [p, { content: s.content }]));
  const explorerSettings = parseMaybeJson(row.CompilerSettings);
  if (!explorerSettings || typeof explorerSettings !== "object" || Array.isArray(explorerSettings)) fail("COMPILER_SETTINGS_MISSING", { id: record.id });
  const settings = JSON.parse(JSON.stringify(explorerSettings));
  const compilationTargetRemoved = settings.compilationTarget ?? null;
  delete settings.compilationTarget;
  let flattenedLibrariesNormalized = false;
  if (settings.libraries && Object.values(settings.libraries).some((x) => typeof x === "string")) {
    const nested = {};
    for (const [qualified, address] of Object.entries(settings.libraries)) {
      const split = qualified.lastIndexOf(":");
      if (split <= 0 || typeof address !== "string") fail("LIBRARY_SCHEMA", { id: record.id, qualified });
      const file = qualified.slice(0, split), name = qualified.slice(split + 1);
      (nested[file] ||= {})[name] = address;
    }
    settings.libraries = nested; flattenedLibrariesNormalized = true;
  }
  let v2; try { v2 = JSON.parse(v2Raw.toString("utf8")); } catch (_) { fail("EXPLORER_V2_JSON", { id: record.id }); }
  if (!v2?.is_verified || String(v2.name || "") !== String(row.ContractName || "") || String(v2.file_path || "") !== primaryPath ||
      String(v2.compiler_version || "").replace(/^v/u, "") !== String(row.CompilerVersion || "").replace(/^v/u, "")) fail("EXPLORER_V1_V2_CONFLICT", { id: record.id });
  const v2Sources = [{ path: v2.file_path, content: v2.source_code }, ...(Array.isArray(v2.additional_sources) ? v2.additional_sources.map((x) => ({ path: x.file_path, content: x.source_code })) : [])];
  const v2Map = new Map(v2Sources.map((x) => [x.path, x.content]));
  if (v2Map.size !== byPath.size || [...byPath].some(([p, x]) => v2Map.get(p) !== x.content)) fail("EXPLORER_SOURCE_BUNDLE_CONFLICT", { id: record.id });
  const runtime = String(v2.deployed_bytecode || "").toLowerCase(), creation = String(v2.creation_bytecode || "").toLowerCase();
  if (!/^0x[0-9a-f]+$/u.test(runtime) || !/^0x[0-9a-f]+$/u.test(creation)) fail("EXPLORER_BYTECODE_MISSING", { id: record.id });
  const originalOutputSelection = settings.outputSelection ?? null;
  if (!settings.outputSelection) settings.outputSelection = { "*": { "": ["*"], "*": ["*"] } };
  const input = { language: "Solidity", sources, settings };
  const compilerVersion = String(row.CompilerVersion || ""); if (!/^v?0\.\d+\.\d+\+commit\.[0-9a-f]{8}$/iu.test(compilerVersion)) fail("COMPILER_VERSION", { id: record.id });
  const constructorArguments = String(row.ConstructorArguments || "");
  if (!/^(?:0x)?[0-9a-fA-F]*$/u.test(constructorArguments) || constructorArguments.replace(/^0x/u, "").length % 2) fail("CONSTRUCTOR_ARGS", { id: record.id });
  return {
    row: {
      address: record.address,
      contractName: row.ContractName,
      fileName: primaryPath,
      compilerVersion,
      evmVersion: row.EVMVersion || settings.evmVersion || null,
      optimizationUsed: row.OptimizationUsed,
      optimizationRuns: row.OptimizationRuns,
      constructorArguments: `0x${constructorArguments.replace(/^0x/u, "").toLowerCase()}`,
      explorerCompilerSettings: explorerSettings,
      compilerSettings: settings,
      sourceCount: Object.keys(sources).length,
      sourceFiles: Object.entries(sources).map(([p, x]) => ({ path: p, bytes: Buffer.byteLength(x.content), sha256: sha256(Buffer.from(x.content)), keccak256: keccak256(Buffer.from(x.content)) })),
      verificationProvider: "Blockscout Ethereum verified-source API v1 and v2",
      isVerified: true,
      explorerRuntime: { bytes: (runtime.length - 2) / 2, sha256: sha256(Buffer.from(runtime.slice(2), "hex")), keccak256: keccak256(runtime), bytecode: runtime },
      explorerCreation: { bytes: (creation.length - 2) / 2, sha256: sha256(Buffer.from(creation.slice(2), "hex")), keccak256: keccak256(creation), bytecode: creation },
      inputReconstruction: { exactSourceContents: true, exactCompilerVersion: true, exactCompilerSettings: true,
        explorerSuppliedOutputSelection: originalOutputSelection !== null,
        deterministicOutputSelectionAdded: originalOutputSelection === null,
        flattenedLibrariesNormalized,
        explorerCompilationTargetRemovedFromCompilerInput: compilationTargetRemoved,
        outputSelectionBytecodeSemantic: false },
    },
    input,
  };
}

async function main() {
  if (process.argv.length !== 2) fail("ARGV_FORBIDDEN");
  if (RECORDS.length !== LIMITS.records) fail("RECORD_CARDINALITY");
  fs.mkdirSync(OUT, { recursive: true }); let total = 0; const summary = [];
  for (const record of RECORDS) {
    const raw = await fetchPath(`/api?module=contract&action=getsourcecode&address=${record.address}`);
    const v2Raw = await fetchPath(`/api/v2/smart-contracts/${record.address}`);
    total += raw.length + v2Raw.length; if (total > LIMITS.totalBytes) fail("TOTAL_RESPONSE_CAP");
    const normalized = normalizeRow(record, raw, v2Raw), dir = path.join(OUT, record.id); fs.mkdirSync(dir, { recursive: true });
    const inputPath = path.join(dir, "standard-input.json"), authorityPath = path.join(dir, "authority.json");
    fs.writeFileSync(inputPath, `${JSON.stringify(normalized.input, null, 2)}\n`);
    const authority = { schemaVersion: "etherfi-26q2-provenance-r2/verified-input-v1", record, ...normalized.row,
      standardInput: { path: rel(inputPath), sha256: sha256(fs.readFileSync(inputPath)) }, rawResponse: { persisted: false, bytesReceived: raw.length + v2Raw.length, sha256Persisted: false },
      safety: { publicExplorerOnly: true, rpcInventoryRead: false, environmentRead: false, keysRead: false, transaction: false, signing: false, fork: false } };
    fs.writeFileSync(authorityPath, `${JSON.stringify(authority, null, 2)}\n`);
    summary.push({ id: record.id, address: record.address, contract: record.contract, phase: record.phase, repository: record.repository,
      compilerVersion: authority.compilerVersion, evmVersion: authority.evmVersion, optimizer: authority.compilerSettings.optimizer || null,
      metadata: authority.compilerSettings.metadata || null, sourceCount: authority.sourceCount, constructorArgumentsBytes: (authority.constructorArguments.length - 2) / 2,
      explorerRuntime: { bytes: authority.explorerRuntime.bytes, sha256: authority.explorerRuntime.sha256, keccak256: authority.explorerRuntime.keccak256 },
      explorerCreation: { bytes: authority.explorerCreation.bytes, sha256: authority.explorerCreation.sha256, keccak256: authority.explorerCreation.keccak256 },
      inputReconstruction: authority.inputReconstruction,
      standardInput: authority.standardInput, authority: rel(authorityPath) });
  }
  const out = { schemaVersion: "etherfi-26q2-provenance-r2/acquisition-summary-v1", generatedAt: new Date().toISOString(),
    status: summary.length === 11 ? "PASS_11_OF_11_VERIFIED_INPUTS" : "FAIL", expectedRecords: 11, acquiredRecords: summary.length,
    records: summary, totalResponseBytes: total,
    limitations: ["Verified-source material is not yet accepted as official Git provenance until every source byte hash maps to an official Git blob.",
      "No build/runtime equivalence is claimed by acquisition alone."],
    safety: { officialPublicSourceAcquisitionOnly: true, rpcInventoryRead: false, fork: false, transaction: false, signing: false } };
  fs.writeFileSync(SUMMARY, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify({ status: out.status, records: summary.length, totalResponseBytes: total,
    sourceCounts: summary.map((x) => [x.id, x.sourceCount]) }));
}

main().catch((e) => { console.error(JSON.stringify({ status: "FAIL_CLOSED", code: e instanceof Stop ? e.code : "UNEXPECTED",
  details: e instanceof Stop ? e.details : { name: e?.name, message: String(e?.message || "").slice(0, 300) } })); process.exitCode = 1; });
