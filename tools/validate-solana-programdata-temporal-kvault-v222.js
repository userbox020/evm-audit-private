#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const FIXTURE_ROOT = path.join(ROOT, "tools", "tests", "fixtures");
const OUTPUT_PATH = path.join(ROOT, "reports", "raw", "fast", "solana-kamino-vault-v2.2.2-gate0", "programdata-temporal-capture.json");
const ARTIFACT_SIZE_CAP_BYTES = 24 * 1024 * 1024;
const PROGRAM_ID = "KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd";
const LOADER_ID = "BPFLoaderUpgradeab1e11111111111111111111111";
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOURCE_RELEASE_UTC = "2026-07-08T12:45:00Z";
const SOURCE_RELEASE_SECONDS = Date.parse(SOURCE_RELEASE_UTC) / 1000;
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
const ALLOWED_METHODS = Object.freeze(["getGenesisHash", "getSlot", "getBlockTime", "getAccountInfo"]);
const QUALIFICATION_METHODS = Object.freeze(["getGenesisHash", "getSlot", "getBlockTime", "getAccountInfo"]);
const SELECTED_SEQUENCE = Object.freeze([
  "getSlot(finalized)",
  "getBlockTime(anchor)",
  "getAccountInfo(program,base64,finalized,minContextSlot=anchor)",
  "getAccountInfo(programData,base64,finalized,minContextSlot=anchor)",
  "getBlockTime(deploymentSlot)",
]);
const DISALLOWED_METHODS = Object.freeze([
  "getProgramAccounts", "getSignaturesForAddress", "getTransaction", "getBlock",
  "simulateTransaction", "sendTransaction", "requestAirdrop",
]);
const TOP_LEVEL_FIELDS = Object.freeze([
  "schemaVersion", "captureType", "classification", "chain", "target", "source", "anchor",
  "program", "programData", "methodAssertions", "safety", "gates",
]);
const FORBIDDEN_KEY_PARTS = Object.freeze([
  "url", "endpoint", "host", "provider", "header", "authorization", "credential", "token",
  "inventory", "candidate", "index", "rawerror", "responsebody",
]);
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

class SafeError extends Error {
  constructor(code) {
    super(code);
    this.name = "SafeError";
    this.code = code;
  }
}

function fail(code) {
  throw new SafeError(code);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function decodeBase64Strict(value) {
  if (typeof value !== "string" || !value.length || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) fail("INVALID_BASE64");
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length || bytes.toString("base64") !== value) fail("INVALID_BASE64");
  return bytes;
}

function base58Encode(bytes) {
  const input = Buffer.from(bytes);
  let n = BigInt(`0x${input.toString("hex") || "0"}`);
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const byte of input) { if (byte !== 0) break; out = `1${out}`; }
  return out || "1";
}

function suspiciousValue(value) {
  if (typeof value !== "string") return false;
  if (/https?:\/\//i.test(value)) return true;
  if (/\b(?:bearer|basic)\s+[A-Za-z0-9._~+\/-]+=*/i.test(value)) return true;
  if (/\b(?:api[_-]?key|secret|password)\s*[:=]/i.test(value)) return true;
  return /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:[a-z]{2,63}|invalid)(?:\b|\/)/i.test(value);
}

function assertNoLeaks(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("SCHEMA_INVALID");
  exactKeys(value, TOP_LEVEL_FIELDS, "TOP_LEVEL_FIELDS_INVALID");
  const visit = node => {
    if (Array.isArray(node)) { for (const item of node) visit(item); return; }
    if (node && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        const compact = key.toLowerCase().replace(/[^a-z0-9]/g, "");
        if (FORBIDDEN_KEY_PARTS.some(part => compact.includes(part))) fail("LEAK_FIELD_REJECTED");
        visit(child);
      }
      return;
    }
    if (suspiciousValue(node)) fail("LEAK_VALUE_REJECTED");
  };
  visit(value);
  return true;
}

function validateElf64(payload) {
  if (!Buffer.isBuffer(payload) || payload.length < 64) fail("ELF_HEADER_INVALID");
  if (!payload.subarray(0, 4).equals(ELF_MAGIC)) fail("ELF_MAGIC_INVALID");
  if (payload[4] !== 2 || payload[5] !== 1 || payload[6] !== 1 || payload.readUInt16LE(18) !== 247 || payload.readUInt32LE(20) !== 1) fail("ELF_HEADER_INVALID");
}

function exactArray(actual, expected, code) {
  if (!Array.isArray(actual) || actual.length !== expected.length || actual.some((value, i) => value !== expected[i])) fail(code);
}

function exactKeys(object, expected, code) {
  if (!object || typeof object !== "object" || Array.isArray(object)) fail(code);
  const actual = Object.keys(object).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((value, i) => value !== wanted[i])) fail(code);
}

function safeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function exactUtc(seconds, value, code) {
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || value !== new Date(seconds * 1000).toISOString()) fail(code);
}

function validateArtifact(artifact) {
  assertNoLeaks(artifact);
  if (artifact.schemaVersion !== 1) fail("SCHEMA_VERSION_INVALID");
  if (artifact.captureType !== "SOLANA_PROGRAMDATA_TEMPORAL_CAPTURE") fail("CAPTURE_TYPE_INVALID");
  if (artifact.classification !== "TEMPORAL_COMPATIBILITY_ONLY_SOURCE_RUNTIME_UNBOUND") fail("CLASSIFICATION_INVALID");

  exactKeys(artifact.chain, ["name", "genesis", "commitment"], "CHAIN_SCHEMA_INVALID");
  if (artifact.chain.name !== "solana-mainnet-beta" || artifact.chain.genesis !== MAINNET_GENESIS || artifact.chain.commitment !== "finalized") fail("CHAIN_IDENTITY_INVALID");
  exactKeys(artifact.target, ["programId", "loaderId"], "TARGET_SCHEMA_INVALID");
  if (artifact.target.programId !== PROGRAM_ID || artifact.target.loaderId !== LOADER_ID) fail("TARGET_INVALID");

  exactKeys(artifact.source, ["repository", "releaseTag", "commit", "tree", "baselineCommit", "releaseUtc", "evidenceBoundary"], "SOURCE_SCHEMA_INVALID");
  if (artifact.source.repository !== "Kamino-Finance/kvault" ||
      artifact.source.releaseTag !== "release/v2.2.2" ||
      artifact.source.commit !== "1d146d7087a76edbbadc14d848ae14295c0745a4" ||
      artifact.source.tree !== "1a54a554f1081643df4b16abe540c9cc50aa20cb" ||
      artifact.source.baselineCommit !== "ac367c3adecf9ae29e384b50c9cf2e7fcc521f94" ||
      artifact.source.releaseUtc !== SOURCE_RELEASE_UTC ||
      artifact.source.evidenceBoundary !== "official-source-reference-not-runtime-evidence") fail("SOURCE_IDENTITY_INVALID");

  exactKeys(artifact.anchor, ["slot", "unixSeconds", "utc", "requestedMinContextSlot"], "ANCHOR_SCHEMA_INVALID");
  const anchor = safeInteger(artifact.anchor.slot, "ANCHOR_SLOT_INVALID");
  if (artifact.anchor.requestedMinContextSlot !== anchor) fail("MIN_CONTEXT_INVALID");
  exactUtc(artifact.anchor.unixSeconds, artifact.anchor.utc, "ANCHOR_TIME_INVALID");

  exactKeys(artifact.program, ["address", "owner", "executable", "contextSlot", "loaderStateTag", "programDataLink", "rawBase64", "rawLength", "rawSha256"], "PROGRAM_SCHEMA_INVALID");
  if (artifact.program.address !== PROGRAM_ID || artifact.program.owner !== LOADER_ID || artifact.program.executable !== true) fail("PROGRAM_METADATA_INVALID");
  if (safeInteger(artifact.program.contextSlot, "PROGRAM_CONTEXT_INVALID") < anchor) fail("CONTEXT_BELOW_ANCHOR");
  const programBytes = decodeBase64Strict(artifact.program.rawBase64);
  if (artifact.program.rawLength !== programBytes.length || artifact.program.rawSha256 !== sha256(programBytes)) fail("PROGRAM_RAW_COMMITMENT_INVALID");
  if (programBytes.length !== 36 || programBytes.readUInt32LE(0) !== 2 || artifact.program.loaderStateTag !== 2) fail("PROGRAM_TAG_INVALID");
  const linked = base58Encode(programBytes.subarray(4, 36));
  if (artifact.program.programDataLink !== linked) fail("PROGRAM_LINKAGE_INVALID");

  exactKeys(artifact.programData, [
    "address", "owner", "executable", "contextSlot", "loaderStateTag", "deploymentSlot",
    "deploymentUnixSeconds", "deploymentUtc", "authorityOption", "upgradeAuthority", "payloadOffset",
    "payloadLength", "payloadSha256", "elfMagic", "rawBase64", "rawLength", "rawSha256",
  ], "PROGRAMDATA_SCHEMA_INVALID");
  if (artifact.programData.address !== linked || artifact.programData.owner !== LOADER_ID || artifact.programData.executable !== false) fail("PROGRAMDATA_METADATA_INVALID");
  const programDataContext = safeInteger(artifact.programData.contextSlot, "PROGRAMDATA_CONTEXT_INVALID");
  if (programDataContext < anchor) fail("CONTEXT_BELOW_ANCHOR");
  const dataBytes = decodeBase64Strict(artifact.programData.rawBase64);
  if (artifact.programData.rawLength !== dataBytes.length || artifact.programData.rawSha256 !== sha256(dataBytes)) fail("PROGRAMDATA_RAW_COMMITMENT_INVALID");
  if (dataBytes.length < 49 || dataBytes.readUInt32LE(0) !== 3 || artifact.programData.loaderStateTag !== 3) fail("PROGRAMDATA_TAG_INVALID");
  const decodedSlot = dataBytes.readBigUInt64LE(4);
  if (!/^(?:0|[1-9]\d*)$/.test(artifact.programData.deploymentSlot) || BigInt(artifact.programData.deploymentSlot) !== decodedSlot || artifact.programData.deploymentSlot !== decodedSlot.toString()) fail("DEPLOYMENT_SLOT_INVALID");
  if (decodedSlot > BigInt(Number.MAX_SAFE_INTEGER)) fail("DEPLOYMENT_SLOT_INVALID");
  if (decodedSlot > BigInt(programDataContext)) fail("DEPLOYMENT_SLOT_AFTER_CONTEXT");
  const option = dataBytes[12];
  const offset = 45;
  let authority;
  if (option === 0) {
    authority = null;
  } else if (option === 1) {
    authority = base58Encode(dataBytes.subarray(13, 45));
  } else {
    fail("AUTHORITY_LAYOUT_INVALID");
  }
  if (artifact.programData.authorityOption !== option || artifact.programData.upgradeAuthority !== authority || artifact.programData.payloadOffset !== offset) fail("AUTHORITY_METADATA_INVALID");
  const payload = dataBytes.subarray(offset);
  validateElf64(payload);
  if (artifact.programData.elfMagic !== "7f454c46") fail("ELF_PAYLOAD_INVALID");
  if (artifact.programData.payloadLength !== payload.length || artifact.programData.payloadSha256 !== sha256(payload)) fail("PAYLOAD_COMMITMENT_INVALID");
  exactUtc(artifact.programData.deploymentUnixSeconds, artifact.programData.deploymentUtc, "DEPLOYMENT_TIME_INVALID");
  if (artifact.programData.deploymentUnixSeconds < SOURCE_RELEASE_SECONDS) fail("DEPLOYMENT_PREDATES_RELEASE");

  exactKeys(artifact.methodAssertions, ["qualificationMethods", "selectedSequence", "allowedMethods", "disallowedMethods", "selectedSequenceExact", "noDisallowedMethods"], "METHOD_SCHEMA_INVALID");
  exactArray(artifact.methodAssertions.qualificationMethods, QUALIFICATION_METHODS, "QUALIFICATION_METHODS_INVALID");
  exactArray(artifact.methodAssertions.selectedSequence, SELECTED_SEQUENCE, "METHOD_SEQUENCE_INVALID");
  exactArray(artifact.methodAssertions.allowedMethods, ALLOWED_METHODS, "METHOD_ALLOWLIST_INVALID");
  exactArray(artifact.methodAssertions.disallowedMethods, DISALLOWED_METHODS, "METHOD_DENYLIST_INVALID");
  if (artifact.methodAssertions.selectedSequenceExact !== true || artifact.methodAssertions.noDisallowedMethods !== true) fail("METHOD_ASSERTION_INVALID");

  exactKeys(artifact.safety, [
    "readOnly", "selectedFinalizedSequenceCount", "programAccountsCalled", "transactionMethodsCalled",
    "signatureMethodsCalled", "simulationCalled", "signingUsed", "vaultOrConfigAccountsRead",
    "accountCensusPerformed", "productionMutation",
  ], "SAFETY_SCHEMA_INVALID");
  if (artifact.safety.readOnly !== true || artifact.safety.selectedFinalizedSequenceCount !== 1 ||
      artifact.safety.programAccountsCalled !== false || artifact.safety.transactionMethodsCalled !== false ||
      artifact.safety.signatureMethodsCalled !== false || artifact.safety.simulationCalled !== false ||
      artifact.safety.signingUsed !== false || artifact.safety.vaultOrConfigAccountsRead !== false ||
      artifact.safety.accountCensusPerformed !== false || artifact.safety.productionMutation !== false) fail("SAFETY_ASSERTION_INVALID");

  exactKeys(artifact.gates, ["temporalCompatibility", "sourceRuntimeEquivalence", "routePositive", "executableNow", "material", "fork", "economics", "signedActionJustified"], "GATE_SCHEMA_INVALID");
  if (artifact.gates.temporalCompatibility !== "PASS" || artifact.gates.sourceRuntimeEquivalence !== "unknown" ||
      artifact.gates.routePositive !== "unknown" || artifact.gates.executableNow !== "unknown" ||
      artifact.gates.material !== "unknown" || artifact.gates.fork !== false || artifact.gates.economics !== "UNOPENED" ||
      artifact.gates.signedActionJustified !== false) fail("GATE_ASSERTION_INVALID");

  return {
    code: "VALIDATION_OK",
    classification: artifact.classification,
    temporalCompatibility: artifact.gates.temporalCompatibility,
  };
}

function parseUtf8Json(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 2 || (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)) fail("JSON_UTF8_INVALID");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (_) {
    fail("JSON_UTF8_INVALID");
  }
  try {
    return JSON.parse(text);
  } catch (_) {
    fail("JSON_INVALID");
  }
}

function resolveFixturePath(requestedPath, options = {}) {
  const fixtureRoot = path.resolve(options.fixtureRoot || FIXTURE_ROOT);
  const workspaceRoot = path.resolve(options.workspaceRoot || ROOT);
  let rootReal;
  let requestedReal;
  try {
    rootReal = fs.realpathSync(fixtureRoot);
    requestedReal = fs.realpathSync(path.resolve(workspaceRoot, requestedPath));
  } catch (_) {
    fail("FIXTURE_PATH_REJECTED");
  }
  const relative = path.relative(rootReal, requestedReal);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) fail("FIXTURE_PATH_REJECTED");
  return { file: requestedReal, display: path.relative(workspaceRoot, requestedReal).replace(/\\/g, "/") };
}

function resolveInput(argv, options = {}) {
  if (!Array.isArray(argv)) fail("CLI_INPUT_REJECTED");
  if (argv.length === 0) return { file: OUTPUT_PATH, display: path.relative(ROOT, OUTPUT_PATH).replace(/\\/g, "/") };
  if (argv.length !== 2 || argv[0] !== "--fixture") fail("CLI_INPUT_REJECTED");
  return resolveFixturePath(argv[1], options);
}

function validateFile(file, options = {}) {
  if (!fs.existsSync(file)) fail("ARTIFACT_MISSING");
  let stat;
  try { stat = fs.statSync(file); } catch (_) { fail("ARTIFACT_MISSING"); }
  const cap = options.sizeCapBytes || ARTIFACT_SIZE_CAP_BYTES;
  if (!stat.isFile() || stat.size < 2 || stat.size > cap) fail("ARTIFACT_SIZE_INVALID");
  return validateArtifact(parseUtf8Json(fs.readFileSync(file)));
}

function main() {
  const input = resolveInput(process.argv.slice(2));
  validateFile(input.file);
  process.stdout.write(`VALIDATION_OK ${input.display}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    const code = error instanceof SafeError ? error.code : "INTERNAL_FAILURE";
    process.stderr.write(`VALIDATION_FAILED_${code}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  ARTIFACT_SIZE_CAP_BYTES,
  FIXTURE_ROOT,
  SafeError,
  assertNoLeaks,
  base58Encode,
  decodeBase64Strict,
  exactArray,
  exactKeys,
  parseUtf8Json,
  resolveFixturePath,
  resolveInput,
  validateArtifact,
  validateFile,
};
