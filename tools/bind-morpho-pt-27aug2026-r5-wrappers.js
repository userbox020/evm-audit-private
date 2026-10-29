#!/usr/bin/env node
"use strict";

// Bounded offline source/runtime binding gate for the two declared Pendle
// wrapper candidates. This file intentionally contains no network or RPC code.
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const INPUT_DIR = path.join(ROOT, "reports", "raw", "fast", "morpho-pt-27aug2026-expiry-oracle-gate0");
const PATHS = Object.freeze({
  profile: path.join(ROOT, "tools", "morpho-pt-27aug2026-post-expiry-r1-profile.js"),
  compilerInputs: path.join(INPUT_DIR, "verified-compiler-inputs.json"),
  sourceManifest: path.join(INPUT_DIR, "source-runtime-manifest.json"),
  capture: path.join(INPUT_DIR, "capture.json"),
});
const OUTPUT = path.join(ROOT, "reports", "raw", "fast", "morpho-pt-27aug2026-r5-wrapper-bind", "binding.json");
const SCHEMA = "morpho-pt-27aug2026-r5-wrapper-bind/exact-wrapper-binding-v1";
const PASS = "PASS_EXACT_WRAPPER_BINDING";
const STOP = "STOP_RUNTIME_MISMATCH";
const BLOCKED = "BLOCKED_COMPILER_OR_INPUT_AUTHORITY";
const EXPECTED_COMPILER = "0.8.30+commit.73712a01";
const TARGET_FILE = "src/PendleLinearDiscountOracleWrapper.sol";
const TARGET_CONTRACT = "PendleLinearDiscountOracleWrapper";
const ZERO_WORD = Buffer.alloc(32);
const WRAPPERS = Object.freeze([
  Object.freeze({ role: "APX", addressKey: "apxWrapper", innerKey: "apxInner" }),
  Object.freeze({ role: "APY", addressKey: "apyWrapper", innerKey: "apyInner" }),
]);
const EXPECTED_ADDRESSES = Object.freeze({
  apxWrapper: "0x130e1c3c755588ccfa08482ce8066c0d94676efe",
  apyWrapper: "0xbdf49b12043906b646e4faee7413ca61f2262aec",
});
const EXPECTED_SETTINGS = Object.freeze({
  evmVersion: "prague",
  libraries: {},
  metadata: { appendCBOR: true, bytecodeHash: "ipfs", useLiteralContent: false },
  optimizer: { enabled: true, runs: 999999 },
  outputSelection: { "*": { "": ["*"], "*": ["*"] } },
  viaIR: true,
});

class GateError extends Error {
  constructor(disposition, code, evidence = null) {
    super(code);
    this.name = "GateError";
    this.disposition = disposition;
    this.code = code;
    this.evidence = evidence;
  }
}

function reject(disposition, code, evidence = null) { throw new GateError(disposition, code, evidence); }
function blocked(code, evidence = null) { reject(BLOCKED, code, evidence); }
function stopped(code, evidence = null) { reject(STOP, code, evidence); }
function sha256(value) { return `0x${crypto.createHash("sha256").update(value).digest("hex")}`; }
function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
  }
  return value;
}
function canonicalize(value) { return JSON.stringify(sortValue(value)); }
function canonicalBytes(value) { return Buffer.from(canonicalize(value), "utf8"); }
function serializedArtifact(value) { return Buffer.from(`${JSON.stringify(sortValue(value), null, 2)}\n`, "utf8"); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function strictAddress(value, code = "MALFORMED_ADDRESS") {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) blocked(code);
  return value.toLowerCase();
}
function strictSha256(value, code = "MALFORMED_SHA256") {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) blocked(code);
  return value.toLowerCase();
}
function exactObject(value) { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }

function gates(oracleGate) {
  return {
    economics: "UNKNOWN_CLOSED",
    execution: "CLOSED",
    fork: "UNKNOWN_CLOSED",
    oracleSubgraphSourceRuntime: oracleGate,
    overallSourceRuntime: "UNKNOWN_CLOSED",
    protocolLoss: "UNKNOWN_CLOSED",
    publicExit: "UNKNOWN_CLOSED",
    route: "UNKNOWN_CLOSED",
  };
}

function safety() {
  return {
    broadcasts: 0,
    endpointInventoryReads: 0,
    endpointMaterialUsed: false,
    envOrKeyReads: 0,
    fork: false,
    networkRequests: 0,
    offlineOnly: true,
    rpcCalls: 0,
    signedTransactions: 0,
    transactions: 0,
  };
}

function valueBundle(value, rawBytes = null) {
  const bytes = rawBytes || canonicalBytes(value);
  return { value, bytes, commitment: { bytes: bytes.length, sha256: sha256(bytes) } };
}

function readJsonBundle(filePath) {
  let bytes;
  let value;
  try {
    bytes = fs.readFileSync(filePath);
    value = JSON.parse(bytes.toString("utf8"));
  } catch (_) {
    blocked("LOCAL_INPUT_ARTIFACT_UNAVAILABLE");
  }
  return valueBundle(value, bytes);
}

function loadBundles(options) {
  if (options.compilerInputs || options.sourceManifest || options.capture) {
    if (!options.compilerInputs || !options.sourceManifest || !options.capture) blocked("INJECTED_INPUT_SET_INCOMPLETE");
    return {
      compilerInputs: valueBundle(options.compilerInputs),
      sourceManifest: valueBundle(options.sourceManifest),
      capture: valueBundle(options.capture),
    };
  }
  return {
    compilerInputs: readJsonBundle(PATHS.compilerInputs),
    sourceManifest: readJsonBundle(PATHS.sourceManifest),
    capture: readJsonBundle(PATHS.capture),
  };
}

function loadProfile(options) {
  if (options.profileAuthority) {
    return { value: options.profileAuthority, commitment: { bytes: canonicalBytes(options.profileAuthority).length,
      sha256: sha256(canonicalBytes(options.profileAuthority)) } };
  }
  let bytes;
  let value;
  try {
    bytes = fs.readFileSync(PATHS.profile);
    value = require(PATHS.profile);
  } catch (_) {
    blocked("PROFILE_AUTHORITY_UNAVAILABLE");
  }
  return { value, commitment: { bytes: bytes.length, sha256: sha256(bytes) } };
}

function inputCommitments(bundles, profile) {
  return {
    capture: bundles.capture.commitment,
    compilerInputs: bundles.compilerInputs.commitment,
    profile: profile.commitment,
    sourceManifest: bundles.sourceManifest.commitment,
  };
}

function baseArtifact(commitments = null) {
  return {
    schema: SCHEMA,
    disposition: BLOCKED,
    inputCommitments: commitments,
    compiler: null,
    wrappers: [],
    gates: gates("CLOSED"),
    safety: safety(),
  };
}

function selectExactly(rows, address, code) {
  if (!Array.isArray(rows)) blocked(`${code}_ROWS_MISSING`);
  const selected = rows.filter((row) => typeof row?.address === "string" && row.address.toLowerCase() === address);
  if (selected.length !== 1) blocked(code, { address, matches: selected.length });
  return selected[0];
}

function validateProfile(profile) {
  if (!exactObject(profile?.ADDRESSES) || !exactObject(profile?.RUNTIME_BASELINES)) blocked("PROFILE_AUTHORITY_MALFORMED");
  for (const descriptor of WRAPPERS) {
    const wrapper = strictAddress(profile.ADDRESSES[descriptor.addressKey], "PROFILE_WRAPPER_ADDRESS_MALFORMED");
    if (wrapper !== EXPECTED_ADDRESSES[descriptor.addressKey]) blocked("PROFILE_WRAPPER_ADDRESS_MISMATCH");
    strictAddress(profile.ADDRESSES[descriptor.innerKey], "PROFILE_INNER_ADDRESS_MALFORMED");
    const baseline = profile.RUNTIME_BASELINES[descriptor.addressKey];
    if (!Array.isArray(baseline) || baseline.length !== 2 || baseline[0] !== 923) blocked("PROFILE_RUNTIME_BASELINE_MALFORMED");
    strictSha256(baseline[1], "PROFILE_RUNTIME_HASH_MALFORMED");
  }
}

function validateSchemas(inputs, manifest, capture) {
  if (inputs?.schema !== "morpho-pt-27aug2026-expiry-oracle-gate0/explorer-candidate-compiler-bundles-v2") {
    blocked("COMPILER_INPUT_SCHEMA_MISMATCH");
  }
  if (manifest?.schema !== "morpho-pt-27aug2026-expiry-oracle-gate0/source-runtime-manifest-v2-candidate-closure") {
    blocked("SOURCE_MANIFEST_SCHEMA_MISMATCH");
  }
  if (capture?.schema !== "morpho-pt-27aug2026-expiry-oracle-gate0/capture-v2-oracle-review-correction") {
    blocked("CAPTURE_SCHEMA_MISMATCH");
  }
}

function sourceCommitments(inputRow, manifestRow) {
  if (!exactObject(inputRow.sources)) blocked("SOURCE_SET_MISSING");
  const sourceNames = Object.keys(inputRow.sources).sort();
  if (!sourceNames.length || !sourceNames.includes(inputRow.filePath)) blocked("TARGET_SOURCE_MISSING");
  if (manifestRow.sourceCount !== sourceNames.length || !Array.isArray(manifestRow.sourceHashes)
    || manifestRow.sourceHashes.length !== sourceNames.length) blocked("SOURCE_SET_COUNT_MISMATCH");
  const manifestHashes = new Map();
  for (const row of manifestRow.sourceHashes) {
    if (typeof row?.sourcePath !== "string" || manifestHashes.has(row.sourcePath)) blocked("SOURCE_MANIFEST_AMBIGUOUS");
    manifestHashes.set(row.sourcePath, strictSha256(row.sha256, "SOURCE_MANIFEST_HASH_MALFORMED"));
  }
  if (canonicalize([...manifestHashes.keys()].sort()) !== canonicalize(sourceNames)) blocked("SOURCE_SET_PATH_MISMATCH");
  const sources = sourceNames.map((sourcePath) => {
    const content = inputRow.sources[sourcePath]?.content;
    if (typeof content !== "string") blocked("SOURCE_CONTENT_MISSING");
    const bytes = Buffer.from(content, "utf8");
    const actual = sha256(bytes);
    if (actual !== manifestHashes.get(sourcePath)) blocked("SOURCE_HASH_MISMATCH", { sourcePath });
    return { sourcePath, bytes: bytes.length, sha256: actual };
  });
  return { aggregateSha256: sha256(canonicalBytes(inputRow.sources)), sources };
}

function validateSettings(inputRow, manifestRow) {
  if (inputRow.compilerVersion !== `v${EXPECTED_COMPILER}` || manifestRow.compilerVersion !== inputRow.compilerVersion) {
    blocked("COMPILER_VERSION_AUTHORITY_MISMATCH");
  }
  if (!exactObject(inputRow.compilerSettings)
    || canonicalize(inputRow.compilerSettings) !== canonicalize(EXPECTED_SETTINGS)) blocked("COMPILER_SETTINGS_MISMATCH");
  return sha256(canonicalBytes(inputRow.compilerSettings));
}

function decodeConstructorInner(inputRow) {
  if (typeof inputRow.constructorArgs !== "string" || !/^[0-9a-fA-F]{64}$/.test(inputRow.constructorArgs)
    || !/^0{24}/.test(inputRow.constructorArgs)) blocked("CONSTRUCTOR_ARGUMENT_AUTHORITY_MALFORMED");
  const encoded = `0x${inputRow.constructorArgs.slice(24).toLowerCase()}`;
  const decoded = inputRow.decodedConstructorArgs;
  if (!Array.isArray(decoded) || decoded.length !== 1 || !Array.isArray(decoded[0]) || decoded[0].length !== 2
    || strictAddress(decoded[0][0], "DECODED_CONSTRUCTOR_ADDRESS_MALFORMED") !== encoded
    || decoded[0][1]?.name !== "_innerOracle" || decoded[0][1]?.type !== "address") {
    blocked("DECODED_CONSTRUCTOR_AUTHORITY_MISMATCH");
  }
  return encoded;
}

function validateCapture(capture, address, inner, baseline) {
  if (!exactObject(capture.code) || !Object.hasOwn(capture.code, address)) blocked("CAPTURE_RUNTIME_ROW_MISSING");
  const code = capture.code[address];
  if (!exactObject(code) || code.present !== true || !Number.isSafeInteger(code.bytes)) blocked("CAPTURE_RUNTIME_ROW_MALFORMED");
  const observedHash = strictSha256(code.sha256, "CAPTURE_RUNTIME_HASH_MALFORMED");
  if (code.bytes !== baseline[0]) stopped("OBSERVED_RUNTIME_LENGTH_MISMATCH", {
    address, expectedBytes: baseline[0], observedBytes: code.bytes,
  });
  if (observedHash !== baseline[1].toLowerCase()) stopped("OBSERVED_RUNTIME_HASH_MISMATCH", {
    address, expectedSha256: baseline[1].toLowerCase(), observedSha256: observedHash,
  });
  if (!Array.isArray(capture.rows)) blocked("CAPTURE_ROWS_MISSING");
  const observations = [];
  for (const row of capture.rows) {
    const feed = row?.feeds?.[address];
    if (feed) observations.push(feed);
  }
  if (!observations.length) blocked("CAPTURE_WRAPPER_OBSERVATION_MISSING");
  for (const observation of observations) {
    if (strictAddress(observation.address, "CAPTURE_WRAPPER_ADDRESS_MALFORMED") !== address
      || observation.innerOracle?.ok !== true
      || strictAddress(observation.innerOracle?.value, "CAPTURE_INNER_ADDRESS_MALFORMED") !== inner) {
      blocked("CAPTURE_INNER_ORACLE_MISMATCH", { address });
    }
  }
  return { bytes: code.bytes, sha256: observedHash };
}

function selectAndValidate(bundles, profileAuthority) {
  const inputs = bundles.compilerInputs.value;
  const manifest = bundles.sourceManifest.value;
  const capture = bundles.capture.value;
  validateSchemas(inputs, manifest, capture);
  validateProfile(profileAuthority);
  const selected = [];
  for (const descriptor of WRAPPERS) {
    const address = strictAddress(profileAuthority.ADDRESSES[descriptor.addressKey]);
    const inner = strictAddress(profileAuthority.ADDRESSES[descriptor.innerKey]);
    const inputRow = selectExactly(inputs.contracts, address, "COMPILER_INPUT_WRAPPER_SELECTION_AMBIGUOUS");
    const manifestRow = selectExactly(manifest.contracts, address, "SOURCE_MANIFEST_WRAPPER_SELECTION_AMBIGUOUS");
    if (inputRow.contractName !== TARGET_CONTRACT || inputRow.filePath !== TARGET_FILE
      || manifestRow.contractName !== TARGET_CONTRACT) blocked("WRAPPER_IDENTITY_MISMATCH");
    if (inputRow.bundleAuthority !== "EXPLORER_CANDIDATE_PARTIAL_NOT_EXACT"
      || inputRow.strictSourceRuntimeAdmitted !== false
      || manifestRow.bundleAuthority !== "EXPLORER_CANDIDATE_PARTIAL_NOT_EXACT"
      || manifestRow.verification?.isVerified !== true || manifestRow.verification?.isPartiallyVerified !== true
      || manifestRow.verification?.isChangedBytecode !== false || manifestRow.explorerRuntimeEqualsPinnedRuntime !== true) {
      blocked("DECLARED_SOURCE_AUTHORITY_MISMATCH");
    }
    const sources = sourceCommitments(inputRow, manifestRow);
    const compilerSettingsSha256 = validateSettings(inputRow, manifestRow);
    const constructorInner = decodeConstructorInner(inputRow);
    if (constructorInner !== inner) blocked("INNER_ORACLE_CONSTRUCTOR_MISMATCH", { address });
    const baseline = profileAuthority.RUNTIME_BASELINES[descriptor.addressKey];
    const observedRuntime = validateCapture(capture, address, inner, baseline);
    selected.push({ descriptor, address, inner, inputRow, sources, compilerSettingsSha256,
      expectedRuntime: { bytes: baseline[0], sha256: baseline[1].toLowerCase() }, observedRuntime });
  }
  if (selected.length !== 2 || new Set(selected.map((row) => row.address)).size !== 2) {
    blocked("WRAPPER_SELECTION_NOT_EXACTLY_TWO");
  }
  return selected;
}

function localCompilerPath() {
  const appData = process.env.APPDATA;
  if (!appData) blocked("LOCAL_COMPILER_PATH_UNAVAILABLE");
  return path.join(appData, "svm", "0.8.30", "solc-0.8.30");
}

function loadLocalCompiler() {
  const filename = localCompilerPath();
  let stat;
  let binary;
  try {
    stat = fs.statSync(filename);
    binary = fs.readFileSync(filename);
  } catch (_) {
    blocked("LOCAL_SOLC_0_8_30_UNAVAILABLE");
  }
  if (!stat.isFile()) blocked("LOCAL_SOLC_0_8_30_UNAVAILABLE");
  const versionRun = spawnSync(filename, ["--version"], {
    encoding: "utf8", windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024,
  });
  if (versionRun.error || versionRun.status !== 0) blocked("LOCAL_SOLC_VERSION_CHECK_FAILED");
  const matched = String(versionRun.stdout || "").match(/Version:\s*([^\s]+)/);
  if (!matched || !matched[1].startsWith(EXPECTED_COMPILER)) blocked("LOCAL_SOLC_VERSION_MISMATCH");
  return {
    version: matched[1],
    commitment: { kind: "LOCAL_SVM_BINARY", bytes: binary.length, sha256: sha256(binary) },
    compile(input) {
      const run = spawnSync(filename, ["--standard-json"], {
        input, encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 32 * 1024 * 1024,
      });
      if (run.error || run.status !== 0 || typeof run.stdout !== "string") blocked("LOCAL_SOLC_EXECUTION_FAILED");
      return run.stdout;
    },
  };
}

function compilerVersion(adapter) {
  let version;
  try { version = typeof adapter.version === "function" ? adapter.version() : adapter.version; }
  catch (_) { blocked("COMPILER_ADAPTER_VERSION_FAILED"); }
  if (typeof version !== "string" || !version.startsWith(EXPECTED_COMPILER)) blocked("COMPILER_ADAPTER_VERSION_MISMATCH");
  return version;
}

function buildStandardInput(row) {
  const input = { language: "Solidity", sources: clone(row.sources), settings: clone(row.compilerSettings) };
  const bytes = canonicalBytes(input);
  return { input, bytes, sha256: sha256(bytes) };
}

function parseCompilerOutput(raw) {
  const start = raw.indexOf("{");
  if (start < 0) blocked("SOLC_OUTPUT_JSON_MISSING");
  let output;
  try { output = JSON.parse(raw.slice(start).trim()); }
  catch (_) { blocked("SOLC_OUTPUT_JSON_MALFORMED"); }
  if ((output.errors || []).some((row) => row?.severity === "error")) blocked("SOLC_COMPILATION_ERROR");
  return output;
}

function compileTwice(adapter, inputBundle) {
  let first;
  let second;
  try {
    first = adapter.compile(inputBundle.bytes.toString("utf8"));
    second = adapter.compile(inputBundle.bytes.toString("utf8"));
  } catch (error) {
    if (error instanceof GateError) throw error;
    blocked("COMPILER_ADAPTER_EXECUTION_FAILED");
  }
  if (typeof first !== "string" || typeof second !== "string") blocked("COMPILER_OUTPUT_NOT_TEXT");
  if (Buffer.from(first, "utf8").compare(Buffer.from(second, "utf8")) !== 0) blocked("NONDETERMINISTIC_COMPILER_OUTPUT");
  return { output: parseCompilerOutput(first), outputBytes: Buffer.byteLength(first), outputSha256: sha256(Buffer.from(first, "utf8")) };
}

function countLinkReferences(linkReferences) {
  if (!exactObject(linkReferences)) stopped("LINK_REFERENCES_MALFORMED");
  let count = 0;
  for (const libraries of Object.values(linkReferences)) {
    if (!exactObject(libraries)) stopped("LINK_REFERENCES_MALFORMED");
    for (const references of Object.values(libraries)) {
      if (!Array.isArray(references)) stopped("LINK_REFERENCES_MALFORMED");
      count += references.length;
    }
  }
  return count;
}

function walkAst(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((child) => walkAst(child, visit));
    else if (value && typeof value === "object") walkAst(value, visit);
  }
}

function immutableDeclaration(output, id) {
  const matches = [];
  for (const [sourcePath, sourceOutput] of Object.entries(output.sources || {})) {
    walkAst(sourceOutput?.ast, (node) => { if (node.id === Number(id)) matches.push({ sourcePath, node }); });
  }
  if (matches.length !== 1) stopped("IMMUTABLE_DECLARATION_AMBIGUOUS", { declarationId: id, matches: matches.length });
  const match = matches[0];
  if (match.sourcePath !== TARGET_FILE || match.node.nodeType !== "VariableDeclaration"
    || match.node.name !== "innerOracle" || match.node.mutability !== "immutable") {
    stopped("IMMUTABLE_NOT_DECLARED_INNER_ORACLE", { declarationId: id });
  }
  return match;
}

function patchDeclaredInnerOracle(output, runtimeHex, immutableReferences, inner, address) {
  const ids = Object.keys(immutableReferences || {});
  if (ids.length !== 1 || !Array.isArray(immutableReferences[ids[0]]) || !immutableReferences[ids[0]].length) {
    stopped("INNER_ORACLE_IMMUTABLE_REFERENCES_MISSING", { address });
  }
  immutableDeclaration(output, ids[0]);
  const runtime = Buffer.from(runtimeHex, "hex");
  const patched = Buffer.from(runtime);
  const word = Buffer.from(inner.slice(2).padStart(64, "0"), "hex");
  const ranges = immutableReferences[ids[0]].map((reference) => {
    if (!Number.isSafeInteger(reference?.start) || reference.length !== 32 || reference.start < 0
      || reference.start + reference.length > runtime.length) {
      stopped("IMMUTABLE_REFERENCE_INVALID", { address });
    }
    return { declarationId: Number(ids[0]), start: reference.start, length: reference.length };
  }).sort((left, right) => left.start - right.start);
  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index];
    if (index && ranges[index - 1].start + ranges[index - 1].length > range.start) {
      stopped("IMMUTABLE_REFERENCE_OVERLAP", { address });
    }
    if (!runtime.subarray(range.start, range.start + range.length).equals(ZERO_WORD)) {
      stopped("IMMUTABLE_TEMPLATE_VALUE_NOT_ZERO", { address, start: range.start });
    }
    word.copy(patched, range.start);
  }
  return { patched, ranges: ranges.map((range) => ({ ...range, value: inner })) };
}

function bindWrapper(selected, adapter) {
  const standardInput = buildStandardInput(selected.inputRow);
  const compiled = compileTwice(adapter, standardInput);
  const artifact = compiled.output.contracts?.[TARGET_FILE]?.[TARGET_CONTRACT];
  if (!artifact) blocked("SOLC_TARGET_ARTIFACT_MISSING", { address: selected.address });
  const deployed = artifact.evm?.deployedBytecode;
  const runtimeHex = deployed?.object;
  if (typeof runtimeHex !== "string" || !/^[0-9a-fA-F]+$/.test(runtimeHex) || runtimeHex.length % 2) {
    stopped("COMPILED_RUNTIME_MALFORMED", { address: selected.address });
  }
  if (countLinkReferences(deployed.linkReferences || {}) !== 0 || /__[^_]{1,36}_+/.test(runtimeHex)) {
    stopped("UNRESOLVED_LINKS_OR_PLACEHOLDERS", { address: selected.address });
  }
  const compiledBytes = runtimeHex.length / 2;
  if (compiledBytes !== selected.expectedRuntime.bytes) stopped("COMPILED_RUNTIME_LENGTH_MISMATCH", {
    address: selected.address, expectedBytes: selected.expectedRuntime.bytes, compiledBytes,
  });
  const patched = patchDeclaredInnerOracle(compiled.output, runtimeHex.toLowerCase(),
    deployed.immutableReferences, selected.inner, selected.address);
  const reconstructedSha256 = sha256(patched.patched);
  const exactHash = reconstructedSha256 === selected.expectedRuntime.sha256
    && reconstructedSha256 === selected.observedRuntime.sha256;
  const row = {
    address: selected.address,
    role: selected.descriptor.role,
    disposition: exactHash ? PASS : STOP,
    source: selected.sources,
    compiler: {
      outputByteIdenticalAcrossTwoRuns: true,
      outputBytes: compiled.outputBytes,
      outputSha256: compiled.outputSha256,
      settingsSha256: selected.compilerSettingsSha256,
      standardJsonInputSha256: standardInput.sha256,
    },
    immutable: {
      name: "innerOracle",
      expectedValue: selected.inner,
      references: patched.ranges,
      unresolvedLinks: 0,
      unresolvedPlaceholders: 0,
    },
    runtime: {
      expectedBytes: selected.expectedRuntime.bytes,
      expectedSha256: selected.expectedRuntime.sha256,
      observedBytes: selected.observedRuntime.bytes,
      observedSha256: selected.observedRuntime.sha256,
      reconstructedBytes: patched.patched.length,
      reconstructedSha256,
    },
  };
  if (!exactHash) row.failure = { code: "RECONSTRUCTED_RUNTIME_HASH_MISMATCH", evidence: {
    address: selected.address,
    expectedSha256: selected.expectedRuntime.sha256,
    immutableReferences: patched.ranges,
    observedSha256: selected.observedRuntime.sha256,
    reconstructedSha256,
  } };
  return row;
}

function buildBinding(options = {}) {
  let bundles;
  let profile;
  let base = baseArtifact();
  try {
    bundles = loadBundles(options);
    profile = loadProfile(options);
    base = baseArtifact(inputCommitments(bundles, profile));
    const selected = selectAndValidate(bundles, profile.value);
    const adapter = options.compilerAdapter || loadLocalCompiler();
    const version = compilerVersion(adapter);
    const rows = [];
    for (const row of selected) {
      try { rows.push(bindWrapper(row, adapter)); }
      catch (error) {
        if (!(error instanceof GateError) || error.disposition !== STOP) throw error;
        rows.push({
          address: row.address,
          role: row.descriptor.role,
          disposition: STOP,
          source: row.sources,
          runtime: {
            expectedBytes: row.expectedRuntime.bytes,
            expectedSha256: row.expectedRuntime.sha256,
            observedBytes: row.observedRuntime.bytes,
            observedSha256: row.observedRuntime.sha256,
          },
          failure: { code: error.code, evidence: error.evidence },
        });
      }
    }
    const failed = rows.filter((row) => row.disposition !== PASS);
    const disposition = failed.length ? STOP : PASS;
    const artifact = {
      ...base,
      disposition,
      compiler: {
        commitment: sortValue(adapter.commitment || { kind: "INJECTED_FIXTURE", sha256: sha256(Buffer.from(version)) }),
        requiredVersion: EXPECTED_COMPILER,
        version,
      },
      wrappers: rows,
      gates: gates(disposition === PASS ? "PASS" : "CLOSED"),
    };
    if (failed.length) artifact.failure = {
      code: failed[0].failure?.code || "WRAPPER_RUNTIME_MISMATCH",
      evidence: { failedAddresses: failed.map((row) => row.address), failedWrapperCount: failed.length },
    };
    return artifact;
  } catch (error) {
    const failure = error instanceof GateError ? error : new GateError(BLOCKED, "UNEXPECTED_LOCAL_FAILURE");
    return {
      ...base,
      disposition: failure.disposition,
      failure: { code: failure.code, evidence: failure.evidence },
      gates: gates("CLOSED"),
    };
  }
}

async function publishNoReplace(artifact, outputPath = OUTPUT) {
  const directory = path.dirname(outputPath);
  await fsp.mkdir(directory, { recursive: true });
  const temporary = `${outputPath}.tmp-${process.pid}`;
  let handle;
  try {
    handle = await fsp.open(temporary, "wx", 0o600);
    await handle.writeFile(serializedArtifact(artifact));
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.link(temporary, outputPath);
  } catch (error) {
    if (error?.code === "EEXIST") throw new GateError(BLOCKED, "OUTPUT_EXISTS_NO_OVERWRITE");
    if (error instanceof GateError) throw error;
    throw new GateError(BLOCKED, "OUTPUT_PUBLICATION_FAILED");
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fsp.unlink(temporary).catch(() => {});
  }
}

async function runCli(argv = process.argv.slice(2)) {
  const writeOutput = argv.length === 1 && argv[0] === "--output";
  if (argv.length !== 0 && !writeOutput) throw new GateError(BLOCKED, "INVALID_ARGUMENTS");
  const artifact = buildBinding();
  if (writeOutput && artifact.disposition !== BLOCKED) await publishNoReplace(artifact);
  process.stdout.write(`${canonicalize(artifact)}\n`);
  if (artifact.disposition === BLOCKED) process.exitCode = 2;
  return artifact;
}

if (require.main === module) {
  runCli().catch((error) => {
    const code = error instanceof GateError ? error.code : "UNEXPECTED_LOCAL_FAILURE";
    process.stdout.write(`${canonicalize({ schema: SCHEMA, disposition: BLOCKED, failure: { code }, gates: gates("CLOSED"), safety: safety() })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  BLOCKED,
  EXPECTED_COMPILER,
  GateError,
  OUTPUT,
  PASS,
  PATHS,
  SCHEMA,
  STOP,
  buildBinding,
  canonicalize,
  publishNoReplace,
  serializedArtifact,
  sha256,
  _test: { EXPECTED_SETTINGS, TARGET_CONTRACT, TARGET_FILE, WRAPPERS, patchDeclaredInnerOracle },
};
