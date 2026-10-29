#!/usr/bin/env node
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
export const PACKAGE_ID = "critical-40acres-legacy-jit-deployment-step2-v2";
export const PREDECESSOR_PACKAGE_ID = "critical-40acres-legacy-jit-deployment-step2";
export const PREDECESSOR_OUTPUT_SHA256 = "976adec0d97c166b122e6803f178e4b4314a61ff31e4d8736ff62eecdcb4c612";
export const FIXED_OUTPUT_REL = "reports/raw/fast/40acres-legacy-jit-base-a-state-runtime-v2.json";
export const RESERVATION_STATUS = "CAPTURE_RESERVED_NOT_STARTED";
export const STARTED_STATUS = "CAPTURE_STARTED_COUNTS_INDETERMINATE";
export const FAILURE_STATUS = "CAPTURE_FAILED";
export const SOURCE_COMMIT = "0792fd368635b0f91f7094250d7dfbae7511aaba";
export const WEEK = 604800n;
export const ZERO_ADDRESS = `0x${"00".repeat(20)}`;
export const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
export const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
export const RECOMMENDED_ARTIFACT_MANIFEST = "tools/fixtures/critical-40acres-legacy-jit-deployment-step2-artifacts.json";
export const EXPECTED_ARTIFACT_MANIFEST_SHA256 = "4cd97164240268a500a54dbce17f585cd69a72cc5b7647a551110f56eb13dc4a";
export const EXPECTED_PROVENANCE_AGGREGATE_SHA256 = "8f729b401f516fe7b6c585e1197bd143f8b54e862272f99e4c18cf011ae53db7";
export const CAPS = Object.freeze({
  maxCandidates: 1,
  maxChains: 1,
  maxRpcElements: 45,
  maxHttpRequests: 45,
  retries: 0,
  timeoutMs: 10000,
  maxResponseBytes: 2 * 1024 * 1024,
  maxAggregateResponseBytes: 8 * 1024 * 1024,
  concurrency: 1
});
export const CHAINS = Object.freeze({
  base: Object.freeze({ label: "base", chainId: 8453n, defaultRpc: "https://mainnet.base.org" })
});
export const CANDIDATES = Object.freeze([
  Object.freeze({ id: "A", chain: "base", loan: "0x87f18b377e625b62c708d5f6ea96ec193558efd0", expectedVault: null,
    provenance: "OFFICIAL_REPO_LIVE_LEGACY_LOAN", applicability: "LEGACY_V2_CLAIM_CANDIDATE" }),
]);
export const SELECTORS = Object.freeze({
  owner: "8da5cb5b", loanVault: "fd243da3", lendingVault: "cb8c5a3a", loanAsset: "fcea5e29",
  lendingAsset: "1ffce3f4", activeAssets: "1c17b946", lastEpochReward: "1460c114",
  rewardsPerEpoch: "03a93deb", rewardsRate: "a0df48b1", paused: "16c61ccc",
  vaultLoan: "86997794", vaultAsset: "fcea5e29", asset: "38d52e0f", totalSupply: "18160ddd",
  totalAssets: "01e1d114", epochRewardsLocked: "fd158092", balanceOf: "70a08231", allowance: "dd62ed3e"
});
export const ERROR_ENUM = Object.freeze([
  "ACCOUNTING_MISMATCH", "ARTIFACT_INVALID", "BUDGET_HTTP_REQUESTS", "BUDGET_ELEMENTS", "CHAIN_ID_INVALID",
  "DECODE_ADDRESS", "DECODE_BOOL", "DECODE_CODE", "DECODE_QUANTITY", "DECODE_UINT", "FINALIZED_UNSUPPORTED",
  "HTTP_FAILURE", "LINKAGE_MISMATCH", "MALFORMED_ENVELOPE", "MALFORMED_JSON", "MISSING_RESULT",
  "NONCANONICAL_HEX", "NULL_RESULT", "REDIRECT_REJECTED", "RESPONSE_BODY_CAP", "RPC_ERROR",
  "RUNTIME_UNKNOWN", "TERMINAL_DRIFT", "TIMEOUT", "TOPOLOGY_UNEXPECTED", "TRANSPORT_FAILURE"
]);
const EXPECTED_ARTIFACTS = Object.freeze({
  "targets/40-acres-loan-contracts/out/LoanV2.sol/Loan.json": Object.freeze({ family: "LoanV2", contractName: "Loan", sha256: "d3ff2487ab302e029bb35629e364d3b9c86b8288216ab8065d3ef2209fc44d91" }),
  "targets/40-acres-loan-contracts/out/VaultV2.sol/Vault.json": Object.freeze({ family: "VaultV2", contractName: "Vault", sha256: "2a56467ccaad8618b6553d94e94a7a8d2b8700fcad47078b0f845d2d9995b05a" }),
  "targets/40-acres-loan-contracts/out/LoanUtils.sol/LoanUtils.json": Object.freeze({ family: "LoanUtils", contractName: "LoanUtils", sha256: "90e9bcc4543b8cc13bfcb57a662981047f170be0d155b7254938a1a06acc05d8" }),
  "targets/40-acres-loan-contracts/out/PortfolioLoanLib.sol/PortfolioLoanLib.json": Object.freeze({ family: "PortfolioLoanLib", contractName: "PortfolioLoanLib", sha256: "cd42ffce84545ff0a0ad4e28948353fc1508448b591bae81ffaf3897a38ab46a" })
});
const EXPECTED_PROVENANCE_FILES = Object.freeze({
  "targets/40-acres-loan-contracts/foundry.toml": "14235545a84fca3b786de51a6b65f9df29c423c8e3b603a6390d76b8e93cf6b3",
  "targets/40-acres-loan-contracts/foundry.lock": "f9b1eefced6cda1397ee74466939a8117bc11c189e28440cf743e3bf33db2768",
  "targets/40-acres-loan-contracts/src/Loan.sol": "2449e886a86b918bb639a81cae50b784d54b3c6f758fe82e669fa04e4e6600d8",
  "targets/40-acres-loan-contracts/src/LoanV2.sol": "2b90564e81fa240e5323a9a4476a4b936d4725c6d133138b31a26526f0b10763",
  "targets/40-acres-loan-contracts/src/Vault.sol": "a5b028ed7852e47518d32af46ae16d8380865d0c360044a79bf66c34cd0c0ac4",
  "targets/40-acres-loan-contracts/src/VaultV2.sol": "6cc5da5ee92913c8ebbb84c665f0b7c48d592a0e9790b3abdc8a9728eabb44b3",
  "targets/40-acres-loan-contracts/src/libraries/ProtocolTimeLibrary.sol": "cfcc0e2e35c91f7671017eccacc87edbb5d80e8ddab5f7fb41f36569587a8ce6",
  "targets/40-acres-loan-contracts/src/RateStorage.sol": "531543ae205a6ab6fcce0dbc5643df58f8e43c2fe4e8ed334bb273414c3dbf29",
  "targets/40-acres-loan-contracts/src/LoanStorage.sol": "a5a4369490e5fdca9d8b83b4120103dc9418511061d7d35a26a9899084c6c28e",
  "targets/40-acres-loan-contracts/src/LoanUtils.sol": "2abe0986d806a038414024716d26a5e5b3a0f5745123c977febb43700e584d54",
  "targets/40-acres-loan-contracts/src/PortfolioLoanLib.sol": "7da0d99e94a3e497bce057137bea8bb8788a58a1d21a2a2acd9cf871a6185682",
  "targets/40-acres-loan-contracts/lib/openzeppelin-contracts-upgradeable/contracts/proxy/utils/UUPSUpgradeable.sol": "248f8f5f8d7f13d65247bdeab84b2f49dc2a32d6efe21d7a002df723ffee5081"
});
const EXPECTED_REFERENCE_RULES = Object.freeze({
  uupsSelf: Object.freeze({ sourcePath: "targets/40-acres-loan-contracts/lib/openzeppelin-contracts-upgradeable/contracts/proxy/utils/UUPSUpgradeable.sol",
    sourceSha256: "248f8f5f8d7f13d65247bdeab84b2f49dc2a32d6efe21d7a002df723ffee5081", sourceLine: 22, variable: "__self",
    semantic: "address private immutable __self = address(this)", loanV2Ranges: [[9505, 32], [9788, 32]], vaultV2Ranges: [[1451, 32], [1625, 32]] }),
  loanLibraries: Object.freeze({ loanUtilsRanges: [[18261, 20]], portfolioLoanLibRanges: [[2704, 20], [8031, 20], [9279, 20]],
    semantic: "Solidity external-library link addresses" }),
  portfolioSelf: Object.freeze({ sourcePath: "targets/40-acres-loan-contracts/src/PortfolioLoanLib.sol",
    sourceSha256: "7da0d99e94a3e497bce057137bea8bb8788a58a1d21a2a2acd9cf871a6185682", sourceLine: 16,
    variable: "library_deploy_address", semantic: "compiler-generated Solidity library deploy-address self guard", ranges: [[8, 32]] })
});
const ERROR_SET = new Set(ERROR_ENUM);
const FAILURE_ERROR_SET = new Set([...ERROR_ENUM, "ARTIFACT_MANIFEST_REQUIRED", "CAP_OVERRIDE_FORBIDDEN", "CAPTURE_FAILURE",
  "ENDPOINT_OR_SCOPE_OVERRIDE_FORBIDDEN", "LOCAL_PROVENANCE_FAILED", "RAW_RUNTIME_BINDING_FAILED"]);
const MASK64 = (1n << 64n) - 1n;
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n
];

const rotl = (v, n) => n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK64;
function keccakF(s) {
  for (const rc of RC) {
    const c = new Array(5), d = new Array(5), b = new Array(25);
    for (let x = 0; x < 5; x += 1) c[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
    for (let x = 0; x < 5; x += 1) d[x] = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
    for (let y = 0; y < 5; y += 1) for (let x = 0; x < 5; x += 1) s[x + 5 * y] = (s[x + 5 * y] ^ d[x]) & MASK64;
    for (let y = 0; y < 5; y += 1) for (let x = 0; x < 5; x += 1) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x + 5 * y]);
    for (let y = 0; y < 5; y += 1) for (let x = 0; x < 5; x += 1)
      s[x + 5 * y] = (b[x + 5 * y] ^ ((~b[(x + 1) % 5 + 5 * y]) & b[(x + 2) % 5 + 5 * y])) & MASK64;
    s[0] ^= rc;
  }
}
export function keccak256(value) {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const rate = 136, paddedLength = Math.ceil((input.length + 1) / rate) * rate;
  const padded = Buffer.alloc(paddedLength); input.copy(padded); padded[input.length] = 0x01; padded[padded.length - 1] |= 0x80;
  const state = new Array(25).fill(0n);
  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let i = 0; i < rate; i += 1) state[Math.floor(i / 8)] ^= BigInt(padded[offset + i]) << BigInt((i % 8) * 8);
    keccakF(state);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 32; i += 1) out[i] = Number((state[Math.floor(i / 8)] >> BigInt((i % 8) * 8)) & 0xffn);
  return `0x${out.toString("hex")}`;
}
export const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
const PROTECTED_PATH = /(?:^|\/)(?:\.env(?:\.|$)|rpc_endpoints\.txt$|graphql_endpoints\.txt$|[^/]*\.(?:pem|key)$|[^/]*keypair[^/]*\.json$)/iu;
const ALLOWED_TARGET_PATHS = new Set([...Object.keys(EXPECTED_PROVENANCE_FILES), ...Object.keys(EXPECTED_ARTIFACTS)]);
export function resolveAllowedProvenancePath(relativePath, fsApi = fs) {
  if (typeof relativePath !== "string" || path.isAbsolute(relativePath) || /^[a-zA-Z]:/u.test(relativePath)) throw new Error("PROVENANCE_PATH_FORBIDDEN");
  const normalized = relativePath.replaceAll("\\", "/");
  if (normalized !== path.posix.normalize(normalized) || normalized.includes("..") || PROTECTED_PATH.test(normalized) || !ALLOWED_TARGET_PATHS.has(normalized))
    throw new Error("PROVENANCE_PATH_FORBIDDEN");
  const targetRoot = fsApi.realpathSync(path.join(ROOT, "targets", "40-acres-loan-contracts"));
  const absolute = path.resolve(ROOT, ...normalized.split("/")), real = fsApi.realpathSync(absolute);
  const prefix = `${targetRoot}${path.sep}`;
  if (real !== targetRoot && !real.startsWith(prefix)) throw new Error("PROVENANCE_PATH_FORBIDDEN");
  return absolute;
}
export function strictData(value, bytes = null) {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/u.test(value)) return null;
  if (bytes !== null && value.length !== 2 + bytes * 2) return null;
  return value.toLowerCase();
}
export function strictQuantity(value) {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/u.test(value)) return null;
  try { return BigInt(value); } catch { return null; }
}
export const toQuantity = (value) => `0x${BigInt(value).toString(16)}`;
export function decodeAddress(value) {
  const word = strictData(value, 32); return word && /^0x0{24}[0-9a-f]{40}$/u.test(word) ? `0x${word.slice(26)}` : null;
}
export function decodeUint(value) { const word = strictData(value, 32); return word ? BigInt(word) : null; }
export function decodeBool(value) { const v = decodeUint(value); return v === 0n ? false : v === 1n ? true : null; }
export function encodeAddress(address) {
  if (!/^0x[0-9a-f]{40}$/u.test(address)) throw new Error("DECODE_ADDRESS"); return address.slice(2).padStart(64, "0");
}
export const encodeUint = (value) => BigInt(value).toString(16).padStart(64, "0");
export function stripCborMetadata(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 3) return { stripped: bytes, metadataBytes: 0, strippedApplied: false };
  const metadataBytes = bytes.readUInt16BE(bytes.length - 2), start = bytes.length - 2 - metadataBytes;
  if (metadataBytes === 0 || start < 0 || (bytes[start] & 0xe0) !== 0xa0)
    return { stripped: bytes, metadataBytes: 0, strippedApplied: false };
  return { stripped: bytes.subarray(0, start), metadataBytes, strippedApplied: true };
}
function flattenedLinkReferences(linkReferences) {
  const rows = [];
  for (const [source, libraries] of Object.entries(linkReferences ?? {})) for (const [library, ranges] of Object.entries(libraries ?? {}))
    for (const range of ranges ?? []) if (Number.isInteger(range.start) && Number.isInteger(range.length) && range.start >= 0 && range.length > 0)
      rows.push({ source, library, start: range.start, length: range.length });
  return rows.sort((a, b) => a.start - b.start || a.length - b.length || a.source.localeCompare(b.source) || a.library.localeCompare(b.library));
}
function flattenedImmutableReferences(immutableReferences) {
  const rows = [];
  for (const [id, ranges] of Object.entries(immutableReferences ?? {})) for (const range of ranges ?? [])
    if (Number.isInteger(range.start) && Number.isInteger(range.length) && range.start >= 0 && range.length > 0)
      rows.push({ id, start: range.start, length: range.length });
  return rows.sort((a, b) => a.start - b.start || a.length - b.length || a.id.localeCompare(b.id));
}
function assertReferenceLayout(ranges, codeLength) {
  let end = 0;
  for (const range of ranges) {
    if (!Number.isInteger(range.start) || !Number.isInteger(range.length) || range.start < end || range.length <= 0 || range.start + range.length > codeLength)
      throw new Error("ARTIFACT_INVALID");
    end = range.start + range.length;
  }
}
function linkedArtifactBytes(object, ranges) {
  if (typeof object !== "string") return null;
  const hex = object.startsWith("0x") ? object.slice(2) : object;
  if (hex.length % 2 !== 0) return null;
  const chars = [...hex];
  for (const range of ranges) {
    const start = range.start * 2, end = start + range.length * 2;
    if (end > chars.length) return null;
    for (let i = start; i < end; i += 1) chars[i] = "0";
  }
  const normalized = chars.join("");
  return /^[0-9a-fA-F]*$/u.test(normalized) ? Buffer.from(normalized, "hex") : null;
}
function byteCodeInfo(bytes) {
  const metadata = stripCborMetadata(bytes);
  return { lengthBytes: bytes.length, fullKeccak256: keccak256(bytes), strippedKeccak256: keccak256(metadata.stripped),
    strippedLengthBytes: metadata.stripped.length, metadataBytes: metadata.metadataBytes, metadataStripped: metadata.strippedApplied };
}
export function codeInfo(code) {
  const normalized = strictData(code); if (normalized === null) return null;
  const bytes = Buffer.from(normalized.slice(2), "hex");
  return byteCodeInfo(bytes);
}
export function normalizeArtifactObject(artifact, binding = {}) {
  const object = artifact?.deployedBytecode?.object ?? artifact?.deployedBytecode;
  const linkReferences = flattenedLinkReferences(artifact?.deployedBytecode?.linkReferences);
  const immutableReferences = flattenedImmutableReferences(artifact?.deployedBytecode?.immutableReferences);
  const bytes = linkedArtifactBytes(object, linkReferences), info = bytes ? byteCodeInfo(bytes) : null;
  if (!info || info.lengthBytes === 0) throw new Error("ARTIFACT_INVALID");
  const nonPromotableReasons = [];
  if (linkReferences.length > 0) nonPromotableReasons.push("UNBOUND_LINK_REFERENCES");
  if (immutableReferences.length > 0) nonPromotableReasons.push("UNBOUND_IMMUTABLE_REFERENCES");
  const promotable = nonPromotableReasons.length === 0 && strictData(object?.startsWith?.("0x") ? object : `0x${object}`) !== null;
  return { family: binding.family ?? null, contractName: binding.contractName ?? artifact.contractName ?? null,
    path: binding.path ?? null, artifactSha256: binding.artifactSha256 ?? null, promotable, nonPromotableReasons,
    fullRuntimeKeccak256: promotable ? info.fullKeccak256 : null,
    templateZeroedFullKeccak256: info.fullKeccak256, informationalStrippedKeccak256: info.strippedKeccak256,
    lengthBytes: info.lengthBytes, strippedLengthBytes: info.strippedLengthBytes, metadataBytes: info.metadataBytes,
    metadataStripped: info.metadataStripped, linkReferences, immutableReferences };
}
export function loadArtifactManifest(manifestPath) {
  if (!manifestPath) return null;
  if (manifestPath.replaceAll("\\", "/") !== RECOMMENDED_ARTIFACT_MANIFEST || path.isAbsolute(manifestPath)) throw new Error("ARTIFACT_INVALID");
  const absolute = path.resolve(ROOT, ...RECOMMENDED_ARTIFACT_MANIFEST.split("/"));
  if (fs.lstatSync(absolute).isSymbolicLink() || path.resolve(fs.realpathSync(absolute)).toLowerCase() !== absolute.toLowerCase()) throw new Error("ARTIFACT_INVALID");
  const manifestBytes = fs.readFileSync(absolute);
  if (sha256(manifestBytes) !== EXPECTED_ARTIFACT_MANIFEST_SHA256) throw new Error("ARTIFACT_INVALID");
  const manifest = JSON.parse(manifestBytes);
  if (manifest.schemaVersion !== 2 || manifest.packageId !== PREDECESSOR_PACKAGE_ID || manifest.sourceCommit !== SOURCE_COMMIT || !manifest.provenance ||
    !Array.isArray(manifest.artifacts) || manifest.artifacts.length !== Object.keys(EXPECTED_ARTIFACTS).length ||
    canonicalJson(manifest.referenceRules) !== canonicalJson(EXPECTED_REFERENCE_RULES) ||
    manifest.provenanceAggregateSha256 !== EXPECTED_PROVENANCE_AGGREGATE_SHA256 ||
    manifest.provenanceAggregateSha256 !== sha256(Buffer.from(canonicalJson({ provenance: manifest.provenance, referenceRules: manifest.referenceRules, artifacts: manifest.artifacts }), "utf8")))
    throw new Error("ARTIFACT_INVALID");
  if (manifest.provenance.head !== SOURCE_COMMIT || manifest.provenance.tree !== "00e6e8a58da2c525388fe484a28634fc8efe52a9" ||
    manifest.provenance.toolchain?.forgeVersion !== "1.5.1-stable" || manifest.provenance.toolchain?.forgeCommit !== "b0a9dd9ceda36f63e2326ce530c10e6916f4b8a2" ||
    manifest.provenance.toolchain?.solcVersion !== "0.8.30" || !Array.isArray(manifest.provenance.files)) throw new Error("ARTIFACT_INVALID");
  if (manifest.provenance.files.length !== Object.keys(EXPECTED_PROVENANCE_FILES).length) throw new Error("ARTIFACT_INVALID");
  const provenanceSeen = new Set();
  for (const row of manifest.provenance.files) {
    if (!row || EXPECTED_PROVENANCE_FILES[row.path] !== row.sha256 || provenanceSeen.has(row.path) ||
      sha256(fs.readFileSync(resolveAllowedProvenancePath(row.path))) !== row.sha256)
      throw new Error("ARTIFACT_INVALID");
    provenanceSeen.add(row.path);
  }
  const paths = new Set(), families = new Set();
  const entries = manifest.artifacts.map((row) => {
    const normalizedPath = typeof row?.path === "string" ? row.path.replaceAll("\\", "/") : null;
    const expected = normalizedPath ? EXPECTED_ARTIFACTS[normalizedPath] : null;
    if (!expected || row.family !== expected.family || row.contractName !== expected.contractName || row.sha256 !== expected.sha256 ||
      paths.has(normalizedPath) || families.has(row.family) || !/^targets\/40-acres-loan-contracts\/out\/.+\.json$/u.test(normalizedPath))
      throw new Error("ARTIFACT_INVALID");
    paths.add(normalizedPath); families.add(row.family);
    const artifactPath = resolveAllowedProvenancePath(normalizedPath), bytes = fs.readFileSync(artifactPath), actualSha256 = sha256(bytes);
    if (actualSha256 !== row.sha256) throw new Error("ARTIFACT_INVALID");
    const artifact = JSON.parse(bytes), normalized = normalizeArtifactObject(artifact, { path: normalizedPath, family: row.family,
      contractName: row.contractName, artifactSha256: actualSha256 });
    const settings = artifact.metadata?.settings;
    if (artifact.id !== row.artifactId || artifact.metadata?.compiler?.version !== row.compilerVersion ||
      canonicalJson(settings?.compilationTarget) !== canonicalJson(row.compilationTarget) || settings?.evmVersion !== manifest.provenance.settings.evmVersion ||
      settings?.viaIR !== manifest.provenance.settings.viaIR || settings?.optimizer?.enabled !== manifest.provenance.settings.optimizerEnabled ||
      settings?.optimizer?.runs !== manifest.provenance.settings.optimizerRuns || settings?.metadata?.bytecodeHash !== manifest.provenance.settings.bytecodeHash ||
      settings?.metadata?.appendCBOR !== manifest.provenance.settings.appendCBOR || canonicalJson(settings?.libraries) !== canonicalJson(manifest.provenance.settings.libraries) ||
      normalized.linkReferences.length !== row.linkReferenceCount || normalized.immutableReferences.length !== row.immutableReferenceCount ||
      normalized.promotable !== row.promotable || canonicalJson(normalized.nonPromotableReasons) !== canonicalJson(row.nonPromotableReasons))
      throw new Error("ARTIFACT_INVALID");
    if (normalized.metadataBytes !== 0) throw new Error("ARTIFACT_INVALID");
    Object.defineProperty(normalized, "_templateBytes", { value: linkedArtifactBytes(artifact.deployedBytecode.object, normalized.linkReferences), enumerable: false });
    return normalized;
  });
  if (paths.size !== Object.keys(EXPECTED_ARTIFACTS).length) throw new Error("ARTIFACT_INVALID");
  const byFamily = Object.fromEntries(entries.map((entry) => [entry.family, entry]));
  for (const entry of entries) assertReferenceLayout([...entry.linkReferences, ...entry.immutableReferences].sort((a, b) => a.start - b.start), entry.lengthBytes);
  const expectedLoanLinks = [
    { source: "src/PortfolioLoanLib.sol", library: "PortfolioLoanLib", start: 2704, length: 20 },
    { source: "src/PortfolioLoanLib.sol", library: "PortfolioLoanLib", start: 8031, length: 20 },
    { source: "src/PortfolioLoanLib.sol", library: "PortfolioLoanLib", start: 9279, length: 20 },
    { source: "src/LoanUtils.sol", library: "LoanUtils", start: 18261, length: 20 }
  ];
  if (canonicalJson(byFamily.LoanV2.linkReferences) !== canonicalJson(expectedLoanLinks) ||
    canonicalJson(byFamily.LoanV2.immutableReferences) !== canonicalJson([{ id: "40200", start: 9505, length: 32 }, { id: "40200", start: 9788, length: 32 }]) ||
    canonicalJson(byFamily.VaultV2.linkReferences) !== "[]" ||
    canonicalJson(byFamily.VaultV2.immutableReferences) !== canonicalJson([{ id: "40200", start: 1451, length: 32 }, { id: "40200", start: 1625, length: 32 }]) ||
    byFamily.LoanUtils.linkReferences.length !== 0 || byFamily.LoanUtils.immutableReferences.length !== 0 ||
    byFamily.PortfolioLoanLib.linkReferences.length !== 0 ||
    canonicalJson(byFamily.PortfolioLoanLib.immutableReferences) !== canonicalJson([{ id: "library_deploy_address", start: 8, length: 32 }]))
    throw new Error("ARTIFACT_INVALID");
  return { manifestSha256: sha256(manifestBytes), provenanceAggregateSha256: manifest.provenanceAggregateSha256,
    sourceCommit: manifest.sourceCommit, provenance: manifest.provenance, referenceRules: manifest.referenceRules, entries };
}

export class Budget {
  constructor(caps = CAPS) { this.caps = caps; this.rpcElements = 0; this.httpRequests = 0; this.responseBytes = 0; this.dispatched = 0; this.byScope = {}; }
  reserve(scope = "unscoped") {
    if (this.rpcElements + 1 > this.caps.maxRpcElements) throw new Error("BUDGET_ELEMENTS");
    if (this.httpRequests + 1 > this.caps.maxHttpRequests) throw new Error("BUDGET_HTTP_REQUESTS");
    this.rpcElements += 1; this.httpRequests += 1;
    const row = this.byScope[scope] ?? { rpcElements: 0, httpRequests: 0 };
    row.rpcElements += 1; row.httpRequests += 1; this.byScope[scope] = row;
  }
  recordDispatch() { this.dispatched += 1; }
  addBytes(bytes) { this.responseBytes += bytes; if (this.responseBytes > this.caps.maxAggregateResponseBytes) throw new Error("RESPONSE_BODY_CAP"); }
  summary() { return { rpcElements: this.rpcElements, httpRequests: this.httpRequests, dispatchedHttpRequests: this.dispatched,
    responseBytes: this.responseBytes, retries: 0, concurrency: 1, byScope: this.byScope }; }
}
export function createCaptureTelemetry() {
  return { rpcElements: 0, httpRequests: 0, dispatchedHttpRequests: 0, responseBytes: 0, reliable: true };
}
function syncTelemetry(context) {
  if (!context?.telemetry) return;
  const summary = context.budget.summary();
  context.telemetry.rpcElements = summary.rpcElements;
  context.telemetry.httpRequests = summary.httpRequests;
  context.telemetry.dispatchedHttpRequests = summary.dispatchedHttpRequests;
  context.telemetry.responseBytes = summary.responseBytes;
}
async function readBody(response, budget, caps, controller) {
  if (!response.body?.getReader) throw new Error("TRANSPORT_FAILURE");
  const reader = response.body.getReader(), chunks = []; let size = 0;
  while (true) {
    const part = await reader.read(); if (part.done) break; const chunk = Buffer.from(part.value); size += chunk.length;
    if (size > caps.maxResponseBytes) { controller.abort(); await reader.cancel(); throw new Error("RESPONSE_BODY_CAP"); }
    budget.addBytes(chunk.length); chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
export async function rpcRequest(endpoint, call, context) {
  context.budget.reserve(context.scope ?? "unscoped");
  syncTelemetry(context);
  const id = ++context.nextId, payload = { jsonrpc: "2.0", id, method: call.method, params: call.params };
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), context.caps.timeoutMs);
  try {
    context.budget.recordDispatch();
    syncTelemetry(context);
    const response = await (context.fetchImpl ?? fetch)(endpoint, { method: "POST", redirect: "error",
      headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(payload), signal: controller.signal });
    if (response.redirected || (response.status >= 300 && response.status < 400)) throw new Error("REDIRECT_REJECTED");
    if (response.status < 200 || response.status >= 300) throw new Error("HTTP_FAILURE");
    let parsed; try { parsed = JSON.parse(await readBody(response, context.budget, context.caps, controller)); } catch (error) {
      if (ERROR_SET.has(error.message)) throw error; throw new Error("MALFORMED_JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.jsonrpc !== "2.0" || parsed.id !== id || !Number.isInteger(parsed.id))
      throw new Error("MALFORMED_ENVELOPE");
    const hasResult = Object.hasOwn(parsed, "result"), hasError = Object.hasOwn(parsed, "error");
    if (hasResult === hasError) throw new Error("MALFORMED_ENVELOPE");
    if (hasError) {
      if (!parsed.error || typeof parsed.error !== "object" || Array.isArray(parsed.error)) throw new Error("MALFORMED_ENVELOPE");
      return { key: call.key, ok: false, error: "RPC_ERROR", result: null };
    }
    if (parsed.result === null) return { key: call.key, ok: false, error: "NULL_RESULT", result: null };
    return { key: call.key, ok: true, error: null, result: parsed.result };
  } catch (error) {
    if (ERROR_SET.has(error.message) || /^BUDGET_/u.test(error.message)) throw error;
    if (error?.name === "AbortError") throw new Error("TIMEOUT");
    throw new Error("TRANSPORT_FAILURE");
  } finally { syncTelemetry(context); clearTimeout(timer); }
}
export async function rpcManySingleton(endpoint, calls, context) {
  const rows = [];
  for (const call of calls) rows.push(await rpcRequest(endpoint, call, context));
  return rows;
}
const call = (key, to, selector, block) => ({ key, method: "eth_call", params: [{ to, data: `0x${selector}` }, block] });
const storage = (key, to, slot, block) => ({ key, method: "eth_getStorageAt", params: [to, slot, block] });
const code = (key, to, block) => ({ key, method: "eth_getCode", params: [to, block] });
const resultMap = (rows) => Object.fromEntries(rows.map((row) => [row.key, row]));
function decoded(row, kind) {
  if (!row?.ok) return { value: null, error: row?.error ?? "MISSING_RESULT" };
  const value = kind === "address" ? decodeAddress(row.result) : kind === "uint" ? decodeUint(row.result) : kind === "bool" ? decodeBool(row.result) : null;
  return value === null ? { value: null, error: kind === "address" ? "DECODE_ADDRESS" : kind === "bool" ? "DECODE_BOOL" : "DECODE_UINT" }
    : { value: typeof value === "bigint" ? value.toString() : value, error: null };
}
function slotDecoded(row) { const value = row?.ok ? decodeAddress(row.result) : null; return { address: value, error: value === null ? row?.error ?? "DECODE_ADDRESS" : null }; }
function blockDecoded(row) {
  if (!row?.ok || !row.result || typeof row.result !== "object") return null;
  const number = strictQuantity(row.result.number), hash = strictData(row.result.hash, 32), timestamp = strictQuantity(row.result.timestamp);
  return number === null || !hash || timestamp === null ? null : { number, hash, timestamp };
}
const publicBlock = (block) => block ? { number: block.number.toString(), hash: block.hash, timestamp: block.timestamp.toString(), finalityMethod: "finalized" } : null;
function callValue(calls, key) { return calls[key]?.value ?? null; }
function firstAddress(...values) { return values.find((v) => typeof v === "string" && /^0x[0-9a-f]{40}$/u.test(v)) ?? null; }
const addressWord = (address) => Buffer.from(`${"00".repeat(12)}${address.slice(2)}`, "hex");
const addressAt = (bytes, start) => `0x${bytes.subarray(start, start + 20).toString("hex")}`;
function rawCodeBuffer(value) { const normalized = strictData(value); if (normalized === null || normalized.length === 2) throw new Error("RAW_RUNTIME_BINDING_FAILED"); return Buffer.from(normalized.slice(2), "hex"); }
function zeroRanges(bytes, ranges) { const out = Buffer.from(bytes); for (const range of ranges) out.fill(0, range.start, range.start + range.length); return out; }
function requireWords(bytes, ranges, expected) { for (const range of ranges) if (!bytes.subarray(range.start, range.start + range.length).equals(expected)) throw new Error("RAW_RUNTIME_BINDING_FAILED"); }
function runtimeFacts(bytes, normalized) { return { lengthBytes: bytes.length, fullKeccak256: keccak256(bytes), normalizedFullKeccak256: keccak256(normalized),
  normalizedLengthBytes: normalized.length, metadataAbsent: stripCborMetadata(bytes).metadataBytes === 0 }; }
function extractLinkedLibraryAddresses(loanCode, artifacts) {
  const bytes = rawCodeBuffer(loanCode), entry = artifacts.entries.find((row) => row.family === "LoanV2");
  if (!entry || bytes.length !== entry.lengthBytes) throw new Error("RAW_RUNTIME_BINDING_FAILED");
  const loanUtilsRanges = entry.linkReferences.filter((row) => row.library === "LoanUtils"), portfolioRanges = entry.linkReferences.filter((row) => row.library === "PortfolioLoanLib");
  const loanUtils = loanUtilsRanges.length === 1 ? addressAt(bytes, loanUtilsRanges[0].start) : ZERO_ADDRESS;
  const portfolio = portfolioRanges.map((range) => addressAt(bytes, range.start));
  if (loanUtils === ZERO_ADDRESS || portfolio.length !== 3 || portfolio.some((address) => address === ZERO_ADDRESS) || new Set(portfolio).size !== 1)
    throw new Error("RAW_RUNTIME_BINDING_FAILED");
  return { loanUtils, portfolioLoanLib: portfolio[0] };
}
export function validateRawReferenceBindings(input, artifacts) {
  if (!artifacts || canonicalJson(artifacts.referenceRules) !== canonicalJson(EXPECTED_REFERENCE_RULES)) throw new Error("RAW_RUNTIME_BINDING_FAILED");
  const byFamily = Object.fromEntries(artifacts.entries.map((entry) => [entry.family, entry]));
  const expectedLoanLinks = [{ source: "src/PortfolioLoanLib.sol", library: "PortfolioLoanLib", start: 2704, length: 20 },
    { source: "src/PortfolioLoanLib.sol", library: "PortfolioLoanLib", start: 8031, length: 20 },
    { source: "src/PortfolioLoanLib.sol", library: "PortfolioLoanLib", start: 9279, length: 20 },
    { source: "src/LoanUtils.sol", library: "LoanUtils", start: 18261, length: 20 }];
  if (canonicalJson(byFamily.LoanV2?.linkReferences) !== canonicalJson(expectedLoanLinks) ||
    canonicalJson(byFamily.LoanV2?.immutableReferences) !== canonicalJson([{ id: "40200", start: 9505, length: 32 }, { id: "40200", start: 9788, length: 32 }]) ||
    canonicalJson(byFamily.VaultV2?.immutableReferences) !== canonicalJson([{ id: "40200", start: 1451, length: 32 }, { id: "40200", start: 1625, length: 32 }]) ||
    byFamily.LoanUtils?.linkReferences.length !== 0 || byFamily.LoanUtils?.immutableReferences.length !== 0 || byFamily.PortfolioLoanLib?.linkReferences.length !== 0 ||
    canonicalJson(byFamily.PortfolioLoanLib?.immutableReferences) !== canonicalJson([{ id: "library_deploy_address", start: 8, length: 32 }]))
    throw new Error("RAW_RUNTIME_BINDING_FAILED");
  for (const entry of Object.values(byFamily)) assertReferenceLayout([...entry.linkReferences, ...entry.immutableReferences].sort((a, b) => a.start - b.start), entry.lengthBytes);
  const loan = rawCodeBuffer(input.loanCode), vault = rawCodeBuffer(input.vaultCode), loanUtils = rawCodeBuffer(input.loanUtilsCode), portfolio = rawCodeBuffer(input.portfolioLoanLibCode);
  const loanImpl = input.loanImplementation?.toLowerCase(), vaultImpl = input.vaultImplementation?.toLowerCase();
  if (![loanImpl, vaultImpl].every((value) => /^0x[0-9a-f]{40}$/u.test(value))) throw new Error("RAW_RUNTIME_BINDING_FAILED");
  for (const [bytes, entry] of [[loan, byFamily.LoanV2], [vault, byFamily.VaultV2], [loanUtils, byFamily.LoanUtils], [portfolio, byFamily.PortfolioLoanLib]])
    if (!entry || bytes.length !== entry.lengthBytes || stripCborMetadata(bytes).metadataBytes !== 0) throw new Error("RAW_RUNTIME_BINDING_FAILED");
  const loanUups = byFamily.LoanV2.immutableReferences, vaultUups = byFamily.VaultV2.immutableReferences;
  requireWords(loan, loanUups, addressWord(loanImpl)); requireWords(vault, vaultUups, addressWord(vaultImpl));
  const loanUtilsRanges = byFamily.LoanV2.linkReferences.filter((row) => row.library === "LoanUtils");
  const portfolioRanges = byFamily.LoanV2.linkReferences.filter((row) => row.library === "PortfolioLoanLib");
  if (loanUtilsRanges.length !== 1 || portfolioRanges.length !== 3) throw new Error("RAW_RUNTIME_BINDING_FAILED");
  const loanUtilsAddress = addressAt(loan, loanUtilsRanges[0].start), portfolioAddresses = portfolioRanges.map((range) => addressAt(loan, range.start));
  if (loanUtilsAddress === ZERO_ADDRESS || portfolioAddresses.some((address) => address === ZERO_ADDRESS) || new Set(portfolioAddresses).size !== 1)
    throw new Error("RAW_RUNTIME_BINDING_FAILED");
  const portfolioAddress = portfolioAddresses[0];
  if (!loanUtils.equals(byFamily.LoanUtils._templateBytes) || keccak256(loanUtils) !== byFamily.LoanUtils.fullRuntimeKeccak256) throw new Error("RAW_RUNTIME_BINDING_FAILED");
  const portfolioSelf = byFamily.PortfolioLoanLib.immutableReferences;
  requireWords(portfolio, portfolioSelf, addressWord(portfolioAddress));
  const normalizedPortfolio = zeroRanges(portfolio, portfolioSelf), normalizedPortfolioArtifact = zeroRanges(byFamily.PortfolioLoanLib._templateBytes, portfolioSelf);
  if (!normalizedPortfolio.equals(normalizedPortfolioArtifact)) throw new Error("RAW_RUNTIME_BINDING_FAILED");
  const loanRanges = [...byFamily.LoanV2.linkReferences, ...loanUups].sort((a, b) => a.start - b.start), vaultRanges = [...vaultUups];
  const normalizedLoan = zeroRanges(loan, loanRanges), normalizedVault = zeroRanges(vault, vaultRanges);
  if (!normalizedLoan.equals(zeroRanges(byFamily.LoanV2._templateBytes, loanRanges)) || !normalizedVault.equals(zeroRanges(byFamily.VaultV2._templateBytes, vaultRanges)))
    throw new Error("RAW_RUNTIME_BINDING_FAILED");
  return { allChecksPassed: true, semanticRulesSha256: sha256(Buffer.from(canonicalJson(artifacts.referenceRules), "utf8")),
    loanImplementation: loanImpl, vaultImplementation: vaultImpl,
    loanUtils: { address: loanUtilsAddress, semantic: "LoanUtils exact full runtime", ...runtimeFacts(loanUtils, loanUtils) },
    portfolioLoanLib: { address: portfolioAddress, semantic: "library_deploy_address equals extracted library address",
      selfRanges: portfolioSelf.map(({ start, length }) => [start, length]), ...runtimeFacts(portfolio, normalizedPortfolio) },
    loanV2: { family: "LoanV2", semantic: "UUPS __self plus exact linked libraries", uupsRanges: loanUups.map(({ start, length }) => [start, length]),
      loanUtilsRanges: loanUtilsRanges.map(({ start, length }) => [start, length]), portfolioLoanLibRanges: portfolioRanges.map(({ start, length }) => [start, length]),
      referencesBound: true, ...runtimeFacts(loan, normalizedLoan) },
    vaultV2: { family: "VaultV2", semantic: "UUPS __self", uupsRanges: vaultUups.map(({ start, length }) => [start, length]),
      referencesBound: true, ...runtimeFacts(vault, normalizedVault) } };
}
export function evaluateCandidate(candidate, observed, artifacts = null) {
  const errors = new Set(observed.errors ?? []), c = observed.calls ?? {}, pin = observed.pin;
  const loanVault = firstAddress(callValue(c, "loanVault"), callValue(c, "lendingVault"));
  const loanAsset = firstAddress(callValue(c, "loanAsset"), callValue(c, "lendingAsset"));
  const vaultLoan = callValue(c, "vaultLoan"), vaultAsset = firstAddress(callValue(c, "vaultAsset"), callValue(c, "asset"));
  const active = callValue(c, "activeAssets"), reward = callValue(c, "lastEpochReward"), bucket = callValue(c, "rewardsPerEpoch");
  const cash = callValue(c, "cash"), supply = callValue(c, "totalSupply"), totalAssets = callValue(c, "totalAssets"), locked = callValue(c, "epochRewardsLocked");
  const owner = callValue(c, "owner"), rate = callValue(c, "rewardsRate"), paused = callValue(c, "paused");
  const aliasVault = callValue(c, "lendingVault"), aliasAsset = callValue(c, "lendingAsset"), vaultAssetAlias = callValue(c, "asset");
  const family = active !== null && reward !== null && bucket !== null ? "LEGACY_V2" : paused !== null ? "LEGACY_V1" : "UNKNOWN";
  if (family === "UNKNOWN") errors.add("RUNTIME_UNKNOWN");
  const loanEntry = artifacts?.entries.find((entry) => entry.family === "LoanV2"), vaultEntry = artifacts?.entries.find((entry) => entry.family === "VaultV2");
  const rawRuntimeValidatedInProcess = observed.rawRuntimeValidatedInProcess === true && observed.runtimeReferenceEvidence?.allChecksPassed === true && Boolean(loanEntry && vaultEntry);
  const runtimeEquivalent = artifacts === null ? null : rawRuntimeValidatedInProcess;
  const loanRuntime = { matchedArtifact: rawRuntimeValidatedInProcess ? { family: "LoanV2", contractName: loanEntry.contractName, path: loanEntry.path,
    artifactSha256: loanEntry.artifactSha256, normalizedFullKeccak256: observed.runtimeReferenceEvidence.loanV2.normalizedFullKeccak256 } : null };
  const vaultRuntime = { matchedArtifact: rawRuntimeValidatedInProcess ? { family: "VaultV2", contractName: vaultEntry.contractName, path: vaultEntry.path,
    artifactSha256: vaultEntry.artifactSha256, normalizedFullKeccak256: observed.runtimeReferenceEvidence.vaultV2.normalizedFullKeccak256 } : null };
  const loanAdminZero = observed.loan.admin.address === ZERO_ADDRESS, vaultAdminZero = observed.vault?.admin.address === ZERO_ADDRESS;
  const loanTopology = observed.loan.implementation.address === ZERO_ADDRESS ? "DIRECT" : observed.loan.implementation.address ? "ERC1967_UUPS_PROXY" : "UNKNOWN";
  const vaultTopology = observed.vault?.implementation.address === ZERO_ADDRESS ? "DIRECT" : observed.vault?.implementation.address ? "ERC1967_UUPS_PROXY" : "UNKNOWN";
  const topology = loanAdminZero && vaultAdminZero && loanTopology !== "UNKNOWN" && vaultTopology !== "UNKNOWN";
  if (!topology) errors.add("TOPOLOGY_UNEXPECTED");
  const vaultAliases = aliasVault === null || aliasVault === loanVault;
  const assetAliases = aliasAsset === null || aliasAsset === loanAsset;
  const vaultAssetAliases = vaultAssetAlias === null || vaultAssetAlias === vaultAsset;
  const expectedVault = candidate.expectedVault === null || loanVault === candidate.expectedVault;
  const linkage = Boolean(loanVault && loanAsset && vaultLoan && vaultAsset && loanVault === observed.vault?.address && vaultLoan === candidate.loan &&
    loanAsset === vaultAsset && expectedVault && vaultAliases && assetAliases && vaultAssetAliases);
  if (!linkage) errors.add("LINKAGE_MISMATCH");
  let epoch = null, remaining = null, expectedLocked = null, expectedTotalAssets = null, accounting = false;
  if (pin && [active, reward, bucket, cash, totalAssets, locked].every((v) => v !== null)) {
    const t = BigInt(pin.timestamp), a = BigInt(active), r = BigInt(reward), b = BigInt(bucket), ca = BigInt(cash), ta = BigInt(totalAssets), lo = BigInt(locked);
    epoch = (t / WEEK) * WEEK; remaining = epoch + WEEK - t; expectedLocked = (remaining * b) / WEEK;
    if (ca + a >= lo) expectedTotalAssets = ca + a - lo;
    accounting = b === r && lo === expectedLocked && expectedTotalAssets !== null && ta === expectedTotalAssets;
  }
  if (!accounting) errors.add("ACCOUNTING_MISMATCH");
  const terminal = Boolean(observed.terminal?.stable);
  if (!terminal) errors.add("TERMINAL_DRIFT");
  const applicability = candidate.id === "A" && candidate.chain === "base" && candidate.loan === CANDIDATES[0].loan &&
    candidate.provenance === CANDIDATES[0].provenance && candidate.applicability === CANDIDATES[0].applicability && family === "LEGACY_V2";
  const gates = { finality: Boolean(pin), topology, runtime: runtimeEquivalent === true && applicability,
    linkage, accounting, terminal, currentImpactClosed: supply === null ? null : supply === "0", paused: rate === "0" || paused === true };
  const historyEligible = Object.values({ finality: gates.finality, topology: gates.topology, runtime: gates.runtime,
    linkage: gates.linkage, accounting: gates.accounting, terminal: gates.terminal }).every((v) => v === true) &&
    gates.paused === false && gates.currentImpactClosed === false;
  return {
    id: candidate.id, chain: CHAINS[candidate.chain].label, chainId: CHAINS[candidate.chain].chainId.toString(), loan: candidate.loan,
    vault: observed.vault?.address ?? loanVault, expectedVault: candidate.expectedVault, provenance: candidate.provenance,
    applicability: candidate.applicability, sourceCommit: SOURCE_COMMIT, pin,
    slots: { loan: { implementation: observed.loan.implementation, admin: observed.loan.admin, topology: loanTopology },
      vault: observed.vault ? { implementation: observed.vault.implementation, admin: observed.vault.admin, topology: vaultTopology } : null },
    code: { loanProxy: observed.loan.proxyCode, loanImplementation: observed.loan.implementationCode,
      vaultProxy: observed.vault?.proxyCode ?? null, vaultImplementation: observed.vault?.implementationCode ?? null },
    calls: c, rawRuntimeValidatedInProcess,
    runtime: { family, applicabilityProven: applicability, equivalence: runtimeEquivalent, promotionMode: "EXACT_FULL_RUNTIME_WITH_VERIFIED_REFERENCES",
      rawRuntimeValidatedInProcess, postOutputValidatorRawCodeAccess: false,
      promotionBlockers: rawRuntimeValidatedInProcess ? [] : ["RAW_REFERENCE_BINDING_NOT_COMPLETED"], referenceEvidence: observed.runtimeReferenceEvidence ?? null,
      loanArtifact: loanRuntime.matchedArtifact, vaultArtifact: vaultRuntime.matchedArtifact },
    formulas: { epoch: epoch?.toString() ?? null, remaining: remaining?.toString() ?? null, bucket,
      lastEpochReward: reward, expectedLocked: expectedLocked?.toString() ?? null, observedLocked: locked,
      cash, activeAssets: active, expectedTotalAssets: expectedTotalAssets?.toString() ?? null, observedTotalAssets: totalAssets },
    terminal: observed.terminal, gates, historyEligible, errors: [...errors].filter((e) => ERROR_SET.has(e)).sort()
  };
}

function decodeRows(rows, definitions) {
  const m = resultMap(rows), out = {};
  for (const [key, kind] of Object.entries(definitions)) out[key] = decoded(m[key], kind);
  return out;
}
async function pinChain(chain, endpoint, context) {
  try {
    const rows = await rpcManySingleton(endpoint, [
      { key: "chainId", method: "eth_chainId", params: [] },
      { key: "finalized", method: "eth_getBlockByNumber", params: ["finalized", false] }
    ], context), m = resultMap(rows), chainId = m.chainId?.ok ? strictQuantity(m.chainId.result) : null, block = blockDecoded(m.finalized);
    if (chainId !== chain.chainId) return { pin: null, error: "CHAIN_ID_INVALID" };
    if (!block) return { pin: null, error: "FINALIZED_UNSUPPORTED" };
    return { pin: publicBlock(block), raw: block, error: null };
  } catch (error) { return { pin: null, error: ERROR_SET.has(error.message) ? error.message : "TRANSPORT_FAILURE" }; }
}
async function captureCandidate(candidate, chainPin, endpoint, context, artifacts) {
  const block = toQuantity(chainPin.raw.number), epoch = (chainPin.raw.timestamp / WEEK) * WEEK;
  const loanRows = await rpcManySingleton(endpoint, [
    storage("loanImplementation", candidate.loan, IMPLEMENTATION_SLOT, block), storage("loanAdmin", candidate.loan, ADMIN_SLOT, block), code("loanCode", candidate.loan, block),
    call("owner", candidate.loan, SELECTORS.owner, block), call("loanVault", candidate.loan, SELECTORS.loanVault, block),
    call("lendingVault", candidate.loan, SELECTORS.lendingVault, block), call("loanAsset", candidate.loan, SELECTORS.loanAsset, block),
    call("lendingAsset", candidate.loan, SELECTORS.lendingAsset, block), call("activeAssets", candidate.loan, SELECTORS.activeAssets, block),
    call("lastEpochReward", candidate.loan, SELECTORS.lastEpochReward, block),
    { ...call("rewardsPerEpoch", candidate.loan, SELECTORS.rewardsPerEpoch, block), params: [{ to: candidate.loan, data: `0x${SELECTORS.rewardsPerEpoch}${encodeUint(epoch)}` }, block] },
    call("rewardsRate", candidate.loan, SELECTORS.rewardsRate, block), call("paused", candidate.loan, SELECTORS.paused, block)
  ], context), lm = resultMap(loanRows);
  const loanImplementation = slotDecoded(lm.loanImplementation), loanAdmin = slotDecoded(lm.loanAdmin), loanProxyCode = lm.loanCode?.ok ? codeInfo(lm.loanCode.result, artifacts?.entries) : null;
  const implementationTarget = loanImplementation.address && loanImplementation.address !== ZERO_ADDRESS ? loanImplementation.address : candidate.loan;
  const implementationRows = await rpcManySingleton(endpoint, [code("loanImplementationCode", implementationTarget, block)], context), lim = resultMap(implementationRows);
  const calls = decodeRows(loanRows, { owner: "address", loanVault: "address", lendingVault: "address", loanAsset: "address", lendingAsset: "address",
    activeAssets: "uint", lastEpochReward: "uint", rewardsPerEpoch: "uint", rewardsRate: "uint", paused: "bool" });
  const vaultAddress = firstAddress(callValue(calls, "loanVault"), callValue(calls, "lendingVault"));
  const observed = { pin: chainPin.pin, errors: [], loan: { implementation: loanImplementation, admin: loanAdmin, proxyCode: loanProxyCode,
    implementationCode: lim.loanImplementationCode?.ok ? codeInfo(lim.loanImplementationCode.result, artifacts?.entries) : null }, vault: null, calls, terminal: { stable: false } };
  if (!vaultAddress) { observed.errors.push("LINKAGE_MISMATCH"); return evaluateCandidate(candidate, observed, artifacts); }
  const loanAsset = firstAddress(callValue(calls, "loanAsset"), callValue(calls, "lendingAsset"));
  const vaultCalls = [storage("vaultImplementation", vaultAddress, IMPLEMENTATION_SLOT, block), storage("vaultAdmin", vaultAddress, ADMIN_SLOT, block), code("vaultCode", vaultAddress, block),
    call("vaultLoan", vaultAddress, SELECTORS.vaultLoan, block), call("vaultAsset", vaultAddress, SELECTORS.vaultAsset, block), call("asset", vaultAddress, SELECTORS.asset, block),
    call("totalSupply", vaultAddress, SELECTORS.totalSupply, block), call("totalAssets", vaultAddress, SELECTORS.totalAssets, block),
    call("epochRewardsLocked", vaultAddress, SELECTORS.epochRewardsLocked, block)];
  if (loanAsset) {
    vaultCalls.push({ ...call("cash", loanAsset, SELECTORS.balanceOf, block), params: [{ to: loanAsset, data: `0x${SELECTORS.balanceOf}${encodeAddress(vaultAddress)}` }, block] });
    vaultCalls.push({ ...call("allowance", loanAsset, SELECTORS.allowance, block), params: [{ to: loanAsset,
      data: `0x${SELECTORS.allowance}${encodeAddress(vaultAddress)}${encodeAddress(candidate.loan)}` }, block] });
  } else {
    vaultCalls.push(call("cash", vaultAddress, "ffffffff", block), call("allowance", vaultAddress, "ffffffff", block));
  }
  const vaultRows = await rpcManySingleton(endpoint, vaultCalls, context), vm = resultMap(vaultRows), vaultImplementation = slotDecoded(vm.vaultImplementation), vaultAdmin = slotDecoded(vm.vaultAdmin);
  Object.assign(calls, decodeRows(vaultRows, { vaultLoan: "address", vaultAsset: "address", asset: "address", totalSupply: "uint", totalAssets: "uint",
    epochRewardsLocked: "uint", cash: "uint", allowance: "uint" }));
  const vaultImplementationTarget = vaultImplementation.address && vaultImplementation.address !== ZERO_ADDRESS ? vaultImplementation.address : vaultAddress;
  const vaultImplRows = await rpcManySingleton(endpoint, [code("vaultImplementationCode", vaultImplementationTarget, block)], context), vim = resultMap(vaultImplRows);
  observed.vault = { address: vaultAddress, implementation: vaultImplementation, admin: vaultAdmin,
    proxyCode: vm.vaultCode?.ok ? codeInfo(vm.vaultCode.result, artifacts?.entries) : null,
    implementationCode: vim.vaultImplementationCode?.ok ? codeInfo(vim.vaultImplementationCode.result, artifacts?.entries) : null };
  let libraries, initialEvidence;
  try {
    libraries = extractLinkedLibraryAddresses(lim.loanImplementationCode.result, artifacts);
    const libraryRows = await rpcManySingleton(endpoint, [code("loanUtilsCode", libraries.loanUtils, block), code("portfolioLoanLibCode", libraries.portfolioLoanLib, block)], context), libraryMap = resultMap(libraryRows);
    if (!libraryMap.loanUtilsCode?.ok || !libraryMap.portfolioLoanLibCode?.ok) throw new Error("RAW_RUNTIME_BINDING_FAILED");
    initialEvidence = validateRawReferenceBindings({ loanCode: lim.loanImplementationCode.result, vaultCode: vim.vaultImplementationCode.result,
      loanUtilsCode: libraryMap.loanUtilsCode.result, portfolioLoanLibCode: libraryMap.portfolioLoanLibCode.result,
      loanImplementation: implementationTarget, vaultImplementation: vaultImplementationTarget }, artifacts);
    observed.rawRuntimeValidatedInProcess = true; observed.runtimeReferenceEvidence = initialEvidence;
  } catch (_) {
    observed.rawRuntimeValidatedInProcess = false; observed.runtimeReferenceEvidence = null; observed.errors.push("RUNTIME_UNKNOWN");
    return evaluateCandidate(candidate, observed, artifacts);
  }
  const terminalVaultSelector = callValue(calls, "loanVault") !== null ? SELECTORS.loanVault : SELECTORS.lendingVault;
  const terminalAssetSelector = callValue(calls, "loanAsset") !== null ? SELECTORS.loanAsset : SELECTORS.lendingAsset;
  const terminalRows = await rpcManySingleton(endpoint, [
    { key: "terminalBlock", method: "eth_getBlockByNumber", params: [block, false] },
    storage("terminalLoanImplementation", candidate.loan, IMPLEMENTATION_SLOT, block), storage("terminalLoanAdmin", candidate.loan, ADMIN_SLOT, block),
    call("terminalOwner", candidate.loan, SELECTORS.owner, block), call("terminalLoanVault", candidate.loan, terminalVaultSelector, block),
    call("terminalLoanAsset", candidate.loan, terminalAssetSelector, block), storage("terminalVaultImplementation", vaultAddress, IMPLEMENTATION_SLOT, block),
    storage("terminalVaultAdmin", vaultAddress, ADMIN_SLOT, block), call("terminalVaultLoan", vaultAddress, SELECTORS.vaultLoan, block),
    call("terminalVaultAsset", vaultAddress, SELECTORS.vaultAsset, block), call("terminalAssetAlias", vaultAddress, SELECTORS.asset, block),
    code("terminalLoanCode", implementationTarget, block), code("terminalVaultCode", vaultImplementationTarget, block),
    code("terminalLoanUtilsCode", libraries.loanUtils, block), code("terminalPortfolioLoanLibCode", libraries.portfolioLoanLib, block)
  ], context), tm = resultMap(terminalRows), terminalBlock = blockDecoded(tm.terminalBlock);
  const terminalLoanImplementation = slotDecoded(tm.terminalLoanImplementation), terminalLoanAdmin = slotDecoded(tm.terminalLoanAdmin),
    terminalVaultImplementation = slotDecoded(tm.terminalVaultImplementation), terminalVaultAdmin = slotDecoded(tm.terminalVaultAdmin);
  const terminalOwner = decoded(tm.terminalOwner, "address"), terminalLoanVault = decoded(tm.terminalLoanVault, "address"),
    terminalLoanAsset = decoded(tm.terminalLoanAsset, "address"), terminalVaultLoan = decoded(tm.terminalVaultLoan, "address"),
    terminalVaultAsset = decoded(tm.terminalVaultAsset, "address"), terminalAssetAlias = decoded(tm.terminalAssetAlias, "address");
  let terminalEvidence = null;
  try { terminalEvidence = validateRawReferenceBindings({ loanCode: tm.terminalLoanCode.result, vaultCode: tm.terminalVaultCode.result,
    loanUtilsCode: tm.terminalLoanUtilsCode.result, portfolioLoanLibCode: tm.terminalPortfolioLoanLibCode.result,
    loanImplementation: implementationTarget, vaultImplementation: vaultImplementationTarget }, artifacts); } catch (_) {}
  observed.terminal = { stable: Boolean(terminalBlock && terminalBlock.hash === chainPin.raw.hash && terminalBlock.number === chainPin.raw.number &&
    terminalLoanImplementation.address === loanImplementation.address && terminalLoanAdmin.address === loanAdmin.address &&
    terminalVaultImplementation.address === vaultImplementation.address && terminalVaultAdmin.address === vaultAdmin.address &&
    terminalOwner.value === callValue(calls, "owner") && terminalLoanVault.value === vaultAddress && terminalLoanAsset.value === loanAsset &&
    terminalVaultLoan.value === callValue(calls, "vaultLoan") && terminalVaultAsset.value === callValue(calls, "vaultAsset") &&
    terminalAssetAlias.value === callValue(calls, "asset") && terminalEvidence && canonicalJson(terminalEvidence) === canonicalJson(initialEvidence)),
    block: publicBlock(terminalBlock), loanImplementation: terminalLoanImplementation, loanAdmin: terminalLoanAdmin, owner: terminalOwner,
    loanVault: terminalLoanVault, loanAsset: terminalLoanAsset, vaultImplementation: terminalVaultImplementation,
    vaultAdmin: terminalVaultAdmin, vaultLoan: terminalVaultLoan, vaultAsset: terminalVaultAsset, assetAlias: terminalAssetAlias,
    rawRuntimeValidatedInProcess: Boolean(terminalEvidence), referenceEvidence: terminalEvidence };
  return evaluateCandidate(candidate, observed, artifacts);
}

export function sanitizeOutput(value) {
  const text = JSON.stringify(value);
  if (/(?:https?|wss?):\/\//iu.test(text) || /(?:authorization|bearer\s|api[_-]?key|x-api-key)/iu.test(text)) throw new Error("OUTPUT_LEAK");
  const forbidden = /^(?:endpoint|url|headers?|raw|rawResponse|calldata|bytecode|requestBody|responseBody)$/iu, stack = [value];
  while (stack.length) {
    const current = stack.pop(); if (!current || typeof current !== "object") continue;
    for (const [key, child] of Object.entries(current)) { if (forbidden.test(key)) throw new Error("OUTPUT_LEAK"); if (child && typeof child === "object") stack.push(child); }
  }
  return value;
}
export function validateTrackedStatus(statusText) {
  const rows = String(statusText).split(/\r?\n/u).filter(Boolean), allowedUntracked = [];
  for (const row of rows) {
    if (row.startsWith("?? ") && row.slice(3).replaceAll("\\", "/").startsWith("test/audit/")) { allowedUntracked.push(row.slice(3).replaceAll("\\", "/")); continue; }
    throw new Error("DIRTY_TRACKED_SCOPE");
  }
  return allowedUntracked.sort();
}
export function parseSubmoduleStatus(statusText) {
  const rows = [];
  for (const line of String(statusText).split(/\r?\n/u).filter(Boolean)) {
    if (/^[-+U]/u.test(line)) throw new Error("SUBMODULE_MISMATCH");
    const match = line.match(/^ ([0-9a-f]{40}) ([^ ]+)(?: |$)/u); if (!match) throw new Error("SUBMODULE_MISMATCH");
    rows.push({ path: match[2], commit: match[1] });
  }
  return rows;
}
export function validateOutput(output, expectedArtifacts = loadArtifactManifest(RECOMMENDED_ARTIFACT_MANIFEST)) {
  sanitizeOutput(output);
  if (!output || output.schemaVersion !== 1 || output.packageId !== PACKAGE_ID || output.source?.commit !== SOURCE_COMMIT || output.stage !== "STATE_RUNTIME_ONLY" ||
    output.transport?.mode !== "JSON_RPC_SINGLETON_HTTP" || output.transport?.automaticMultiRequestFallback !== false ||
    output.predecessor?.outputSha256 !== PREDECESSOR_OUTPUT_SHA256 || output.predecessor?.causeInference !== false)
    throw new Error("OUTPUT_SCHEMA");
  const keyStack = [output];
  while (keyStack.length) { const current = keyStack.pop(); if (!current || typeof current !== "object") continue;
    for (const [key, child] of Object.entries(current)) { if (/batch/iu.test(key)) throw new Error("OUTPUT_SCHEMA"); if (child && typeof child === "object") keyStack.push(child); } }
  if (output.localProvenance?.verifiedBeforeRpc !== true || output.localProvenance?.manifestSha256 !== EXPECTED_ARTIFACT_MANIFEST_SHA256 ||
    output.localProvenance?.provenanceAggregateSha256 !== EXPECTED_PROVENANCE_AGGREGATE_SHA256) throw new Error("OUTPUT_SCHEMA");
  if (output.validationSeparation !== "RUNNER_VALIDATES_RAW_IN_PROCESS; POST_OUTPUT_VALIDATOR_CHECKS_SCHEMA_AND_INTERNAL_CONSISTENCY_ONLY") throw new Error("OUTPUT_SCHEMA");
  if (!Array.isArray(output.candidates) || output.candidates.length !== 1 || !Array.isArray(output.chains) || output.chains.length !== 1)
    throw new Error("OUTPUT_CAPS");
  if (!output.counts || output.counts.rpcElements > CAPS.maxRpcElements || output.counts.httpRequests > CAPS.maxHttpRequests ||
    output.counts.dispatchedHttpRequests > output.counts.httpRequests || output.counts.rpcElements !== output.counts.httpRequests ||
    output.counts.responseBytes > CAPS.maxAggregateResponseBytes ||
    output.counts.retries !== 0 || output.counts.concurrency !== 1 || !output.counts.byScope)
    throw new Error("OUTPUT_CAPS");
  if (canonicalJson(output.artifacts) !== canonicalJson(expectedArtifacts)) throw new Error("RUNTIME_OVERCLAIM");
  for (const row of output.candidates) {
    const required = ["id", "chain", "chainId", "loan", "vault", "provenance", "applicability", "sourceCommit", "pin", "slots", "code", "calls", "rawRuntimeValidatedInProcess", "runtime", "formulas", "terminal", "gates", "historyEligible", "errors"];
    if (required.some((key) => !Object.hasOwn(row, key))) throw new Error("OUTPUT_SCHEMA");
    if (row.id !== "A" || row.chain !== "base" || row.chainId !== "8453" || row.loan !== CANDIDATES[0].loan ||
      row.provenance !== CANDIDATES[0].provenance || row.applicability !== CANDIDATES[0].applicability ||
      row.sourceCommit !== SOURCE_COMMIT || (row.pin !== null && row.pin?.finalityMethod !== "finalized") ||
      (row.pin === null && row.gates.finality !== false)) throw new Error("CANDIDATE_BINDING");
    if (row.runtime.equivalence === true) {
      if (!output.artifacts || output.artifacts.sourceCommit !== SOURCE_COMMIT || !row.runtime.loanArtifact || !row.runtime.vaultArtifact) throw new Error("RUNTIME_OVERCLAIM");
      if (row.runtime.rawRuntimeValidatedInProcess !== true || row.runtime.postOutputValidatorRawCodeAccess !== false || !row.runtime.referenceEvidence?.allChecksPassed ||
        row.terminal?.rawRuntimeValidatedInProcess !== true || canonicalJson(row.terminal.referenceEvidence) !== canonicalJson(row.runtime.referenceEvidence))
        throw new Error("RUNTIME_OVERCLAIM");
      const evidence = row.runtime.referenceEvidence, byFamily = Object.fromEntries(output.artifacts.entries.map((entry) => [entry.family, entry]));
      if (evidence.semanticRulesSha256 !== sha256(Buffer.from(canonicalJson(output.artifacts.referenceRules), "utf8")) ||
        evidence.loanImplementation !== row.slots.loan.implementation.address || evidence.vaultImplementation !== row.slots.vault.implementation.address ||
        evidence.loanUtils.address === ZERO_ADDRESS || evidence.portfolioLoanLib.address === ZERO_ADDRESS ||
        evidence.loanUtils.fullKeccak256 !== byFamily.LoanUtils.fullRuntimeKeccak256 || evidence.loanUtils.lengthBytes !== byFamily.LoanUtils.lengthBytes ||
        evidence.portfolioLoanLib.normalizedFullKeccak256 !== byFamily.PortfolioLoanLib.templateZeroedFullKeccak256 ||
        evidence.portfolioLoanLib.lengthBytes !== byFamily.PortfolioLoanLib.lengthBytes ||
        evidence.loanV2.normalizedFullKeccak256 !== byFamily.LoanV2.templateZeroedFullKeccak256 || evidence.loanV2.lengthBytes !== byFamily.LoanV2.lengthBytes ||
        evidence.vaultV2.normalizedFullKeccak256 !== byFamily.VaultV2.templateZeroedFullKeccak256 || evidence.vaultV2.lengthBytes !== byFamily.VaultV2.lengthBytes ||
        canonicalJson(evidence.loanV2.uupsRanges) !== canonicalJson(output.artifacts.referenceRules.uupsSelf.loanV2Ranges) ||
        canonicalJson(evidence.vaultV2.uupsRanges) !== canonicalJson(output.artifacts.referenceRules.uupsSelf.vaultV2Ranges) ||
        canonicalJson(evidence.loanV2.loanUtilsRanges) !== canonicalJson(output.artifacts.referenceRules.loanLibraries.loanUtilsRanges) ||
        canonicalJson(evidence.loanV2.portfolioLoanLibRanges) !== canonicalJson(output.artifacts.referenceRules.loanLibraries.portfolioLoanLibRanges) ||
        canonicalJson(evidence.portfolioLoanLib.selfRanges) !== canonicalJson(output.artifacts.referenceRules.portfolioSelf.ranges) ||
        evidence.loanV2.referencesBound !== true || evidence.vaultV2.referencesBound !== true ||
        [evidence.loanUtils, evidence.portfolioLoanLib, evidence.loanV2, evidence.vaultV2].some((item) => item.metadataAbsent !== true))
        throw new Error("RUNTIME_OVERCLAIM");
      if (row.runtime.loanArtifact.family !== "LoanV2" || row.runtime.vaultArtifact.family !== "VaultV2" ||
        row.code?.loanImplementation?.fullKeccak256 !== row.runtime.referenceEvidence.loanV2.fullKeccak256 ||
        row.code?.vaultImplementation?.fullKeccak256 !== row.runtime.referenceEvidence.vaultV2.fullKeccak256 ||
        row.runtime.loanArtifact.normalizedFullKeccak256 !== row.runtime.referenceEvidence.loanV2.normalizedFullKeccak256 ||
        row.runtime.vaultArtifact.normalizedFullKeccak256 !== row.runtime.referenceEvidence.vaultV2.normalizedFullKeccak256) throw new Error("RUNTIME_OVERCLAIM");
      for (const binding of [row.runtime.loanArtifact, row.runtime.vaultArtifact]) {
        const matched = output.artifacts.entries.some((entry) => entry.path === binding.path && entry.artifactSha256 === binding.artifactSha256 &&
          entry.family === binding.family);
        if (!matched) throw new Error("RUNTIME_OVERCLAIM");
      }
    }
    if (row.rawRuntimeValidatedInProcess !== row.runtime.rawRuntimeValidatedInProcess ||
      row.runtime.rawRuntimeValidatedInProcess !== (row.runtime.equivalence === true) || row.runtime.postOutputValidatorRawCodeAccess !== false)
      throw new Error("RUNTIME_OVERCLAIM");
    if (row.gates.finality === true && row.pin === null) throw new Error("GATE_OVERCLAIM");
    const topology = row.slots?.loan?.admin?.address === ZERO_ADDRESS && row.slots?.vault?.admin?.address === ZERO_ADDRESS &&
      ["DIRECT", "ERC1967_UUPS_PROXY"].includes(row.slots?.loan?.topology) && ["DIRECT", "ERC1967_UUPS_PROXY"].includes(row.slots?.vault?.topology);
    if (row.gates.topology !== null && row.gates.topology !== topology) throw new Error("GATE_OVERCLAIM");
    if (row.gates.linkage === true) {
      const v = row.calls?.loanVault?.value ?? row.calls?.lendingVault?.value, a = row.calls?.loanAsset?.value ?? row.calls?.lendingAsset?.value;
      const va = row.calls?.vaultAsset?.value ?? row.calls?.asset?.value;
      if (!v || v !== row.vault || row.calls?.vaultLoan?.value !== row.loan || !a || a !== va ||
        (row.expectedVault !== null && row.expectedVault !== row.vault)) throw new Error("GATE_OVERCLAIM");
    }
    const linkage = Boolean((row.calls?.loanVault?.value ?? row.calls?.lendingVault?.value) === row.vault && row.calls?.vaultLoan?.value === row.loan &&
      (row.calls?.loanAsset?.value ?? row.calls?.lendingAsset?.value) &&
      (row.calls?.loanAsset?.value ?? row.calls?.lendingAsset?.value) === (row.calls?.vaultAsset?.value ?? row.calls?.asset?.value) &&
      (row.calls?.lendingVault?.value === null || row.calls?.lendingVault?.value === row.vault) &&
      (row.calls?.lendingAsset?.value === null || row.calls?.lendingAsset?.value === (row.calls?.loanAsset?.value ?? row.calls?.lendingAsset?.value)) &&
      (row.calls?.asset?.value === null || row.calls?.asset?.value === (row.calls?.vaultAsset?.value ?? row.calls?.asset?.value)));
    if (row.gates.linkage !== null && row.gates.linkage !== linkage) throw new Error("GATE_OVERCLAIM");
    if (row.runtime.promotionMode !== "EXACT_FULL_RUNTIME_WITH_VERIFIED_REFERENCES") throw new Error("RUNTIME_OVERCLAIM");
    const eligible = row.gates.finality === true && row.gates.topology === true && row.gates.runtime === true && row.gates.linkage === true &&
      row.gates.accounting === true && row.gates.terminal === true && row.gates.paused === false && row.gates.currentImpactClosed === false;
    if (row.historyEligible !== eligible) throw new Error("GATE_OVERCLAIM");
    if (row.gates.accounting === true) {
      const f = row.formulas;
      if ([f.epoch, f.remaining, f.bucket, f.lastEpochReward, f.expectedLocked, f.observedLocked, f.cash, f.activeAssets,
        f.expectedTotalAssets, f.observedTotalAssets].some((v) => v === null)) throw new Error("GATE_OVERCLAIM");
      const timestamp = BigInt(row.pin.timestamp), epoch = timestamp / WEEK * WEEK, remaining = epoch + WEEK - timestamp;
      const expectedLocked = remaining * BigInt(f.bucket) / WEEK;
      const gross = BigInt(f.cash) + BigInt(f.activeAssets);
      if (gross < expectedLocked || f.epoch !== epoch.toString() || f.remaining !== remaining.toString() || f.bucket !== f.lastEpochReward ||
        f.expectedLocked !== expectedLocked.toString() || f.observedLocked !== expectedLocked.toString() ||
        f.expectedTotalAssets !== (gross - expectedLocked).toString() || f.observedTotalAssets !== (gross - expectedLocked).toString()) throw new Error("GATE_OVERCLAIM");
    }
    const paused = row.calls?.rewardsRate?.value === "0" || row.calls?.paused?.value === true;
    const closed = row.calls?.totalSupply?.value === null ? null : row.calls?.totalSupply?.value === "0";
    if ((row.gates.paused !== null && row.gates.paused !== paused) || (row.gates.currentImpactClosed !== null && row.gates.currentImpactClosed !== closed))
      throw new Error("GATE_OVERCLAIM");
    const runtime = row.runtime.equivalence === true && row.runtime.applicabilityProven === true &&
      row.runtime.loanArtifact?.family === "LoanV2" && row.runtime.vaultArtifact?.family === "VaultV2";
    if (row.gates.runtime !== null && row.gates.runtime !== runtime) throw new Error("GATE_OVERCLAIM");
    const terminal = Boolean(row.terminal?.stable && row.terminal.block?.number === row.pin.number && row.terminal.block?.hash === row.pin.hash &&
      row.terminal.loanImplementation?.address === row.slots?.loan?.implementation?.address && row.terminal.loanAdmin?.address === row.slots?.loan?.admin?.address &&
      row.terminal.owner?.value === row.calls?.owner?.value && row.terminal.loanVault?.value === row.vault &&
      row.terminal.loanAsset?.value === (row.calls?.loanAsset?.value ?? row.calls?.lendingAsset?.value) &&
      row.terminal.vaultImplementation?.address === row.slots?.vault?.implementation?.address &&
      row.terminal.vaultAdmin?.address === row.slots?.vault?.admin?.address && row.terminal.vaultLoan?.value === row.loan &&
      row.terminal.vaultAsset?.value === row.calls?.vaultAsset?.value && row.terminal.assetAlias?.value === row.calls?.asset?.value);
    if (row.gates.terminal !== null && row.gates.terminal !== terminal) throw new Error("GATE_OVERCLAIM");
  }
  if (output.historyEligibleCount !== output.candidates.filter((row) => row.historyEligible).length) throw new Error("GATE_OVERCLAIM");
  return true;
}
export function preflight() {
  return { schemaVersion: 1, packageId: PACKAGE_ID, mode: "CHECK_ONLY_NO_NETWORK", source: { commit: SOURCE_COMMIT }, stage: "STATE_RUNTIME_ONLY",
    candidates: CANDIDATES.map(({ id, chain, loan, expectedVault, provenance, applicability }) => ({ id, chain: CHAINS[chain].label, loan, expectedVault, provenance, applicability })),
    caps: CAPS, allowedMethods: ["eth_call", "eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_getStorageAt"],
    transport: { mode: "JSON_RPC_SINGLETON_HTTP", requestBody: "SINGLE_OBJECT_NEVER_ARRAY", responseBody: "SINGLE_OBJECT_NEVER_ARRAY",
      automaticMultiRequestFallback: false }, endpointPolicy: { fixedOfficialEndpoint: CHAINS.base.defaultRpc, overridesAllowed: false },
    artifactManifest: { fixedPath: RECOMMENDED_ARTIFACT_MANIFEST, expectedSha256: EXPECTED_ARTIFACT_MANIFEST_SHA256,
      expectedProvenanceAggregateSha256: EXPECTED_PROVENANCE_AGGREGATE_SHA256, mandatoryForCapture: true, compilationPerformedByRunner: false },
    atomicLocalPrecondition: "MANIFEST_HASH+AGGREGATE+HEAD+TREE+CLEAN_TRACKED_SCOPE+RECURSIVE_GITLINKS+FILE_HASHES+COMPILER_METADATA_BEFORE_RPC",
    runtimePromotion: "EXACT_FULL_RUNTIME_WITH_SEMANTICALLY_VERIFIED_LINK_AND_IMMUTABLE_REFERENCES; NO_CBOR_STRIPPING",
    validationSeparation: "RUNNER_VALIDATES_RAW_IN_PROCESS; POST_OUTPUT_VALIDATOR_CHECKS_SCHEMA_AND_INTERNAL_CONSISTENCY_ONLY",
    predecessor: { packageId: PREDECESSOR_PACKAGE_ID, outputSha256: PREDECESSOR_OUTPUT_SHA256,
      transportStatus: "V1_TRANSPORT_INCONCLUSIVE", causeInference: false, predecessorReadByV2Capture: false },
    outputPath: { fixedPath: FIXED_OUTPUT_REL, writeMode: "wx", reservationBeforeRpc: true,
      sameReservedInodeFinalization: true, hardCrashLeavesReservationMarker: true,
      lifecycleStatuses: [RESERVATION_STATUS, STARTED_STATUS, FAILURE_STATUS], failureMarkerStatus: FAILURE_STATUS,
      reservationMarkerStatus: RESERVATION_STATUS, startedMarkerStatus: STARTED_STATUS,
      countSemantics: { started: "NULL_MEANS_INDETERMINATE", failureExact: "EXACT_FROM_MUTABLE_TRANSPORT_TELEMETRY",
        failureUnknown: "NULL_NEVER_COERCED_TO_ZERO" } },
    historyStageExecuted: false, outputPolicy: "SANITIZED_NO_ENDPOINT_HEADERS_RAW_CALLDATA_OR_BYTECODE", networkReads: 0, captureExecuted: false };
}
function localCommand(executable, args, cwd) {
  const child = spawnSync(executable, args, { cwd, encoding: "utf8", env: process.env, maxBuffer: 16 * 1024 * 1024 });
  if (child.status !== 0) throw new Error("LOCAL_PROVENANCE_FAILED");
  return child.stdout.trimEnd();
}
export function verifyLocalProvenance() {
  const artifacts = loadArtifactManifest(RECOMMENDED_ARTIFACT_MANIFEST), target = path.join(ROOT, "targets", "40-acres-loan-contracts"), p = artifacts.provenance;
  if (localCommand("git", ["rev-parse", "HEAD"], target) !== p.head || localCommand("git", ["rev-parse", "HEAD^{tree}"], target) !== p.tree)
    throw new Error("LOCAL_PROVENANCE_FAILED");
  const untrackedAuditFiles = validateTrackedStatus(localCommand("git", ["status", "--porcelain=v1", "--untracked-files=all"], target));
  for (const args of [["diff", "--quiet", "--", "src", "foundry.toml", "foundry.lock", "lib"],
    ["diff", "--cached", "--quiet", "--", "src", "foundry.toml", "foundry.lock", "lib"]]) {
    const child = spawnSync("git", args, { cwd: target, env: process.env }); if (child.status !== 0) throw new Error("LOCAL_PROVENANCE_FAILED");
  }
  if (canonicalJson(parseSubmoduleStatus(localCommand("git", ["submodule", "status", "--recursive"], target))) !== canonicalJson(p.recursiveGitlinks))
    throw new Error("LOCAL_PROVENANCE_FAILED");
  const top = localCommand("git", ["ls-files", "-s", "lib"], target).split(/\r?\n/u).filter(Boolean).map((line) => {
    const match = line.match(/^160000 ([0-9a-f]{40}) 0\t(.+)$/u); if (!match) throw new Error("LOCAL_PROVENANCE_FAILED"); return { path: match[2], commit: match[1] };
  });
  if (canonicalJson(top) !== canonicalJson(p.topLevelGitlinks)) throw new Error("LOCAL_PROVENANCE_FAILED");
  const forge = localCommand("forge", ["--version"], target);
  if (!forge.includes(`forge Version: ${p.toolchain.forgeVersion}`) || !forge.includes(`Commit SHA: ${p.toolchain.forgeCommit}`)) throw new Error("LOCAL_PROVENANCE_FAILED");
  return { artifacts, untrackedAuditFiles, verified: true, manifestSha256: artifacts.manifestSha256,
    provenanceAggregateSha256: artifacts.provenanceAggregateSha256 };
}
export async function runCapture(options = {}, dependencies = {}) {
  if (options.baseRpc || options.avalancheRpc || options.endpoint || options.candidates ||
    (options.artifactManifest && options.artifactManifest !== RECOMMENDED_ARTIFACT_MANIFEST)) throw new Error("ENDPOINT_OR_SCOPE_OVERRIDE_FORBIDDEN");
  const selected = CANDIDATES;
  const localProvenance = verifyLocalProvenance(), artifacts = localProvenance.artifacts;
  if (Object.hasOwn(dependencies, "caps")) throw new Error("CAP_OVERRIDE_FORBIDDEN");
  const budget = new Budget(CAPS), context = { budget, caps: CAPS, nextId: 0, fetchImpl: dependencies.fetchImpl, telemetry: dependencies.telemetry };
  const endpoints = { base: CHAINS.base.defaultRpc };
  const chainPins = {}, chains = [], results = [];
  for (const chainKey of [...new Set(selected.map((c) => c.chain))]) {
    context.scope = `chain:${CHAINS[chainKey].label}`;
    const pinned = await pinChain(CHAINS[chainKey], endpoints[chainKey], context); chainPins[chainKey] = pinned;
    chains.push({ label: CHAINS[chainKey].label, chainId: CHAINS[chainKey].chainId.toString(), pin: pinned.pin, error: pinned.error });
  }
  for (const candidate of selected) {
    context.scope = `candidate:${candidate.id}`;
    const pinned = chainPins[candidate.chain];
    if (!pinned?.pin) {
      results.push({ id: candidate.id, chain: CHAINS[candidate.chain].label, chainId: CHAINS[candidate.chain].chainId.toString(), loan: candidate.loan,
        vault: null, expectedVault: candidate.expectedVault, provenance: candidate.provenance, sourceCommit: SOURCE_COMMIT, pin: null, slots: null, code: null, calls: null,
        applicability: candidate.applicability,
        rawRuntimeValidatedInProcess: false,
        runtime: { family: "UNKNOWN", applicabilityProven: false, equivalence: null, promotionMode: "EXACT_FULL_RUNTIME_WITH_VERIFIED_REFERENCES",
          rawRuntimeValidatedInProcess: false, postOutputValidatorRawCodeAccess: false, referenceEvidence: null,
          promotionBlockers: [], loanArtifact: null, vaultArtifact: null }, formulas: null,
        terminal: null,
        gates: { finality: false, topology: null, runtime: null, linkage: null, accounting: null, terminal: null, currentImpactClosed: null, paused: null },
        historyEligible: false, errors: [pinned?.error ?? "FINALIZED_UNSUPPORTED"] });
      continue;
    }
    try { results.push(await captureCandidate(candidate, pinned, endpoints[candidate.chain], context, artifacts)); }
    catch (error) {
      const code = ERROR_SET.has(error.message) ? error.message : /^BUDGET_/u.test(error.message) ? error.message : "TRANSPORT_FAILURE";
      results.push({ id: candidate.id, chain: CHAINS[candidate.chain].label, chainId: CHAINS[candidate.chain].chainId.toString(), loan: candidate.loan,
        vault: null, expectedVault: candidate.expectedVault, provenance: candidate.provenance, sourceCommit: SOURCE_COMMIT, pin: pinned.pin, slots: null, code: null, calls: null,
        applicability: candidate.applicability,
        rawRuntimeValidatedInProcess: false,
        runtime: { family: "UNKNOWN", applicabilityProven: false, equivalence: null, promotionMode: "EXACT_FULL_RUNTIME_WITH_VERIFIED_REFERENCES",
          rawRuntimeValidatedInProcess: false, postOutputValidatorRawCodeAccess: false, referenceEvidence: null,
          promotionBlockers: [], loanArtifact: null, vaultArtifact: null }, formulas: null,
        terminal: null,
        gates: { finality: true, topology: null, runtime: null, linkage: null, accounting: null, terminal: null, currentImpactClosed: null, paused: null },
        historyEligible: false, errors: [code] });
    }
  }
  const output = sanitizeOutput({ schemaVersion: 1, packageId: PACKAGE_ID, source: { commit: SOURCE_COMMIT }, stage: "STATE_RUNTIME_ONLY",
    transport: { mode: "JSON_RPC_SINGLETON_HTTP", automaticMultiRequestFallback: false },
    predecessor: { packageId: PREDECESSOR_PACKAGE_ID, outputSha256: PREDECESSOR_OUTPUT_SHA256,
      transportStatus: "V1_TRANSPORT_INCONCLUSIVE", causeInference: false },
    validationSeparation: "RUNNER_VALIDATES_RAW_IN_PROCESS; POST_OUTPUT_VALIDATOR_CHECKS_SCHEMA_AND_INTERNAL_CONSISTENCY_ONLY",
    localProvenance: { verifiedBeforeRpc: true, manifestSha256: localProvenance.manifestSha256,
      provenanceAggregateSha256: localProvenance.provenanceAggregateSha256, untrackedAuditFiles: localProvenance.untrackedAuditFiles },
    captureExecuted: true, chains, artifacts, counts: budget.summary(), candidates: results,
    historyEligibleCount: results.filter((r) => r.historyEligible).length });
  validateOutput(output); return output;
}
function writeReservedJson(fd, value, fsApi = fs) {
  sanitizeOutput(value); const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  fsApi.ftruncateSync(fd, 0); fsApi.writeSync(fd, bytes, 0, bytes.length, 0); fsApi.fsyncSync(fd);
}
export function validateCaptureMarker(value) {
  sanitizeOutput(value);
  if (!value || value.schemaVersion !== 1 || value.packageId !== PACKAGE_ID || !Number.isFinite(Date.parse(value.timestamp)) ||
    ![RESERVATION_STATUS, STARTED_STATUS, FAILURE_STATUS].includes(value.status)) throw new Error("CAPTURE_MARKER_INVALID");
  if (value.status === RESERVATION_STATUS && (value.captureStarted !== false || value.networkReads !== 0 || value.counts !== null))
    throw new Error("CAPTURE_MARKER_INVALID");
  if (value.status === STARTED_STATUS && (value.captureStarted !== true || value.networkReads !== null || value.counts !== null))
    throw new Error("CAPTURE_MARKER_INVALID");
  if (value.status === FAILURE_STATUS) {
    if (typeof value.captureStarted !== "boolean" || typeof value.error !== "string" || !FAILURE_ERROR_SET.has(value.error) ||
      !["PRE_DISPATCH", "POST_DISPATCH", "UNKNOWN"].includes(value.failureStage) || !["EXACT", "UNKNOWN"].includes(value.countSemantics))
      throw new Error("CAPTURE_MARKER_INVALID");
    if (value.countSemantics === "UNKNOWN") {
      if (value.networkReads !== null || value.counts !== null || value.failureStage === "PRE_DISPATCH") throw new Error("CAPTURE_MARKER_INVALID");
    } else {
      const c = value.counts;
      if (!c || ![c.rpcElements, c.httpRequests, c.dispatchedHttpRequests, c.responseBytes].every(Number.isInteger) ||
        c.rpcElements < 0 || c.httpRequests < 0 || c.dispatchedHttpRequests < 0 || c.responseBytes < 0 ||
        c.rpcElements > CAPS.maxRpcElements || c.httpRequests > CAPS.maxHttpRequests || c.dispatchedHttpRequests > c.httpRequests ||
        value.networkReads !== c.dispatchedHttpRequests || (value.failureStage === "PRE_DISPATCH" && c.dispatchedHttpRequests !== 0) ||
        (value.failureStage === "POST_DISPATCH" && c.dispatchedHttpRequests === 0)) throw new Error("CAPTURE_MARKER_INVALID");
    }
  }
  return true;
}
export function canonicalFixedOutput(workspaceRoot = ROOT, fsApi = fs) {
  const root = path.resolve(workspaceRoot), parent = path.join(root, "reports", "raw", "fast");
  if (!fsApi.existsSync(parent)) throw new Error("OUTPUT_PARENT_MISSING");
  const rootReal = path.resolve(fsApi.realpathSync(root)), parentReal = path.resolve(fsApi.realpathSync(parent));
  if (fsApi.lstatSync(parent).isSymbolicLink() || parentReal.toLowerCase() !== parent.toLowerCase() ||
    !parentReal.toLowerCase().startsWith(`${rootReal.toLowerCase()}${path.sep}`)) throw new Error("OUTPUT_PARENT_CANONICAL_MISMATCH");
  const target = path.join(parent, path.basename(FIXED_OUTPUT_REL));
  if (fsApi.existsSync(target)) throw new Error("OUTPUT_PREEXISTS");
  return { parent, target };
}
export function reserveFixedOutput({ workspaceRoot = ROOT, fsApi = fs, now = () => new Date() } = {}) {
  const { target } = canonicalFixedOutput(workspaceRoot, fsApi); let fd;
  try {
    fd = fsApi.openSync(target, "wx");
    const marker = { schemaVersion: 1, packageId: PACKAGE_ID, status: RESERVATION_STATUS, timestamp: now().toISOString(),
      captureStarted: false, networkReads: 0, counts: null };
    validateCaptureMarker(marker); writeReservedJson(fd, marker, fsApi);
    return { fd, target, marker, inode: fsApi.fstatSync(fd).ino };
  } catch (error) {
    if (fd !== undefined) { try { fsApi.closeSync(fd); } catch {} try { fsApi.unlinkSync(target); } catch {} }
    if (/^OUTPUT_/u.test(error.message)) throw error;
    throw new Error("OUTPUT_RESERVATION_FAILED");
  }
}
export function markCaptureStarted(reserved, { fsApi = fs, now = () => new Date() } = {}) {
  const marker = { schemaVersion: 1, packageId: PACKAGE_ID, status: STARTED_STATUS, timestamp: now().toISOString(),
    captureStarted: true, networkReads: null, counts: null };
  validateCaptureMarker(marker); writeReservedJson(reserved.fd, marker, fsApi); return marker;
}
function exactTelemetryCounts(telemetry) {
  if (!telemetry || telemetry.reliable !== true || ![telemetry.rpcElements, telemetry.httpRequests, telemetry.dispatchedHttpRequests, telemetry.responseBytes].every(Number.isInteger) ||
    telemetry.rpcElements < 0 || telemetry.httpRequests < 0 || telemetry.dispatchedHttpRequests < 0 || telemetry.responseBytes < 0 ||
    telemetry.rpcElements > CAPS.maxRpcElements || telemetry.httpRequests > CAPS.maxHttpRequests || telemetry.dispatchedHttpRequests > telemetry.httpRequests) return null;
  return { rpcElements: telemetry.rpcElements, httpRequests: telemetry.httpRequests,
    dispatchedHttpRequests: telemetry.dispatchedHttpRequests, responseBytes: telemetry.responseBytes };
}
export async function orchestrateCliCapture({ workspaceRoot = ROOT, fsApi = fs, now = () => new Date(), runCaptureImpl = runCapture } = {}) {
  const reserved = reserveFixedOutput({ workspaceRoot, fsApi, now }), telemetry = createCaptureTelemetry(); let captureStarted = false;
  try {
    markCaptureStarted(reserved, { fsApi, now }); captureStarted = true;
    const output = await runCaptureImpl({}, { telemetry });
    sanitizeOutput(output); writeReservedJson(reserved.fd, output, fsApi);
    const inode = fsApi.fstatSync(reserved.fd).ino; fsApi.closeSync(reserved.fd);
    return { output, path: reserved.target, reservedInode: reserved.inode, finalInode: inode };
  } catch (error) {
    if (error?.telemetryReliable === false) telemetry.reliable = false;
    const counts = exactTelemetryCounts(telemetry), code = FAILURE_ERROR_SET.has(error?.message) ? error.message : "CAPTURE_FAILURE";
    const preDispatch = new Set(["ARTIFACT_INVALID", "ARTIFACT_MANIFEST_REQUIRED", "CAP_OVERRIDE_FORBIDDEN",
      "ENDPOINT_OR_SCOPE_OVERRIDE_FORBIDDEN", "LOCAL_PROVENANCE_FAILED", "OUTPUT_SCHEMA"]);
    let failureStage, countSemantics, persistedCounts, networkReads;
    if (counts && counts.dispatchedHttpRequests > 0) {
      failureStage = "POST_DISPATCH"; countSemantics = "EXACT"; persistedCounts = counts; networkReads = counts.dispatchedHttpRequests;
    } else if (counts && counts.dispatchedHttpRequests === 0 && preDispatch.has(code)) {
      failureStage = "PRE_DISPATCH"; countSemantics = "EXACT"; persistedCounts = counts; networkReads = 0;
    } else {
      failureStage = error?.failureStage === "POST_RPC" ? "POST_DISPATCH" : "UNKNOWN";
      countSemantics = "UNKNOWN"; persistedCounts = null; networkReads = null;
    }
    const failure = { schemaVersion: 1, packageId: PACKAGE_ID, status: FAILURE_STATUS, timestamp: now().toISOString(), error: code,
      captureStarted, failureStage, countSemantics, networkReads, counts: persistedCounts };
    try { validateCaptureMarker(failure); writeReservedJson(reserved.fd, failure, fsApi); } finally { fsApi.closeSync(reserved.fd); }
    const wrapped = new Error(code); wrapped.failureRecord = failure; throw wrapped;
  }
}
function parseArgs(argv) {
  const options = { capture: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i]; if (arg === "--capture") options.capture = true;
    else if (arg !== "--check-only") throw new Error("UNKNOWN_ARGUMENT");
  }
  return options;
}
async function main() {
  const options = parseArgs(process.argv);
  if (!options.capture) { process.stdout.write(`${JSON.stringify(preflight(), null, 2)}\n`); return; }
  const result = await orchestrateCliCapture();
  process.stdout.write(`${JSON.stringify({ status: "CAPTURE_WRITTEN", candidates: result.output.candidates.length, counts: result.output.counts }, null, 2)}\n`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
