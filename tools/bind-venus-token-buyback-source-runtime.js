#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const TARGET = path.join(ROOT, "targets", "venus-protocol-reserve");
const DEPLOYMENTS = path.join(TARGET, "deployments", "bscmainnet");
const FIXED_ARTIFACT = path.join(ROOT, "reports", "raw", "fast", "venus-psr-bnb-fixed-block.json");
const OUTPUT = path.join(ROOT, "reports", "raw", "fast", "venus-psr-bnb-token-buyback-source-binding.json");
const SCHEMA = "venus-token-buyback-source-runtime-binding/v1";
const IMPLEMENTATION_INPUT_ID = "06a4b2a5158db930e9e8fb8d7fe245af";
const PROXY_INPUT_ID = "fae7506ed1356610aa2cd31adaad25fa";
const TRACKED_SOURCES = [
  "contracts/ProtocolReserve/TokenBuyback.sol",
  "contracts/Interfaces/ITokenBuyback.sol",
];

// Derived from solc's immutable patch table in the locally persisted creation bytecode.
const IMPLEMENTATION_PATCHES = Object.freeze([
  { name: "DESTINATION", argumentIndex: 0, offsets: [0x251, 0xcaf, 0x11cb] },
  { name: "BASE_ASSET", argumentIndex: 1, offsets: [0x325, 0x97f, 0xbb1, 0xc8d, 0xd1e, 0xd95, 0x10b4, 0x1161, 0x11a9, 0x121e, 0x129b, 0x1856, 0x1bf8, 0x1d14] },
  { name: "PROTOCOL_SHARE_RESERVE", argumentIndex: 2, offsets: [0x37f, 0xe5b] },
  { name: "RESILIENT_ORACLE", argumentIndex: 3, offsets: [0x2d0, 0x1b6b] },
]);
const PROXY_ADMIN_OFFSETS = Object.freeze([0xfc, 0x15f, 0x1ee, 0x245, 0x283, 0x2a7]);

class BindingError extends Error {
  constructor(code) {
    super(code);
    this.name = "BindingError";
    this.code = code;
  }
}

function fail(code) {
  throw new BindingError(code);
}

function sha256(value) {
  return `0x${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function normalizeSource(value) {
  return value.replace(/\r\n/g, "\n");
}

function parseMetadata(deployment) {
  try {
    return JSON.parse(deployment.metadata);
  } catch {
    fail("INVALID_DEPLOYMENT_METADATA");
  }
}

function runtimeBuffer(deployment, expectedLength) {
  if (typeof deployment.deployedBytecode !== "string"
    || !/^0x[0-9a-fA-F]+$/.test(deployment.deployedBytecode)) fail("INVALID_RUNTIME_TEMPLATE");
  const runtime = Buffer.from(deployment.deployedBytecode.slice(2), "hex");
  if (runtime.length !== expectedLength) fail("RUNTIME_LENGTH_MISMATCH");
  return runtime;
}

function addressWord(value) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) fail("INVALID_IMMUTABLE_ADDRESS");
  return Buffer.from(value.slice(2).padStart(64, "0"), "hex");
}

function patchZeroWords(template, patches, args) {
  const runtime = Buffer.from(template);
  for (const patch of patches) {
    const value = addressWord(args[patch.argumentIndex]);
    for (const offset of patch.offsets) {
      if (offset < 0 || offset + 32 > runtime.length) fail("IMMUTABLE_OFFSET_OUT_OF_RANGE");
      if (!runtime.subarray(offset, offset + 32).equals(Buffer.alloc(32))) {
        fail("IMMUTABLE_TEMPLATE_NOT_ZERO");
      }
      value.copy(runtime, offset);
    }
  }
  return runtime;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    fail("LOCAL_ARTIFACT_READ_FAILED");
  }
}

function gitIdentity() {
  try {
    return {
      commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: TARGET, encoding: "utf8" }).trim(),
      tree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: TARGET, encoding: "utf8" }).trim(),
    };
  } catch {
    fail("SOURCE_CHECKOUT_IDENTITY_UNAVAILABLE");
  }
}

function inputEvidence(inputId, expectedTarget, trackedSources = []) {
  const inputPath = path.join(DEPLOYMENTS, "solcInputs", `${inputId}.json`);
  const bytes = fs.readFileSync(inputPath);
  const input = JSON.parse(bytes.toString("utf8"));
  for (const sourceName of trackedSources) {
    const embedded = input.sources?.[sourceName]?.content;
    if (typeof embedded !== "string") fail("TRACKED_SOURCE_MISSING_FROM_SOLC_INPUT");
    const checkedOut = fs.readFileSync(path.join(TARGET, sourceName), "utf8");
    if (normalizeSource(checkedOut) !== normalizeSource(embedded)) fail("TRACKED_SOURCE_SOLC_INPUT_MISMATCH");
  }
  return {
    hardhatDeployInputId: inputId,
    sha256: sha256(bytes),
    compilationTarget: expectedTarget,
    trackedSourceMatches: trackedSources.map((source) => ({
      source,
      normalizedSha256: sha256(Buffer.from(normalizeSource(input.sources[source].content), "utf8")),
    })),
  };
}

function deploymentFiles() {
  return fs.readdirSync(DEPLOYMENTS)
    .filter((name) => name.endsWith("Buyback_Implementation.json"))
    .sort();
}

function buildBinding(options = {}) {
  const fixed = options.fixedArtifact || readJson(FIXED_ARTIFACT);
  if (fixed?.schema !== "venus-psr-fixed-block/v1") fail("FIXED_ARTIFACT_SCHEMA_MISMATCH");
  const captured = fixed.destinationClassifications;
  if (!Array.isArray(captured) || captured.length !== 9) fail("CAPTURED_DESTINATION_COUNT_MISMATCH");
  if (captured.some((row) => row.classification !== "TOKEN_BUYBACK_GETTER_COMPATIBLE_UNBOUND")) {
    fail("CAPTURED_DESTINATION_CLASSIFICATION_MISMATCH");
  }

  const identity = options.sourceIdentity || gitIdentity();
  if (!/^[0-9a-f]{40}$/.test(identity.commit) || !/^[0-9a-f]{40}$/.test(identity.tree)) {
    fail("INVALID_SOURCE_CHECKOUT_IDENTITY");
  }
  const implementationInput = inputEvidence(
    IMPLEMENTATION_INPUT_ID,
    "contracts/ProtocolReserve/TokenBuyback.sol:TokenBuyback",
    TRACKED_SOURCES,
  );
  const proxyInput = inputEvidence(
    PROXY_INPUT_ID,
    "hardhat-deploy/solc_0.8/proxy/OptimizedTransparentUpgradeableProxy.sol:OptimizedTransparentUpgradeableProxy",
  );

  const implementationsByAddress = new Map();
  for (const fileName of deploymentFiles()) {
    const deployment = readJson(path.join(DEPLOYMENTS, fileName));
    implementationsByAddress.set(String(deployment.address).toLowerCase(), { fileName, deployment });
  }

  let implementationCompiler = null;
  let implementationNormalizedHash = null;
  let proxyCompiler = null;
  let proxyNormalizedHash = null;
  let sharedProxyCapturedHash = null;
  const rows = [];
  for (const record of captured) {
    const destination = String(record.destination).toLowerCase();
    const implementationAddress = String(record.resolvedRuntime?.address).toLowerCase();
    const found = implementationsByAddress.get(implementationAddress);
    if (!found) fail("IMPLEMENTATION_DEPLOYMENT_NOT_FOUND");
    const { fileName, deployment } = found;
    if (deployment.solcInputHash !== IMPLEMENTATION_INPUT_ID) fail("IMPLEMENTATION_SOLC_INPUT_ID_MISMATCH");
    const metadata = parseMetadata(deployment);
    if (metadata.settings?.compilationTarget?.["contracts/ProtocolReserve/TokenBuyback.sol"] !== "TokenBuyback") {
      fail("IMPLEMENTATION_COMPILATION_TARGET_MISMATCH");
    }
    implementationCompiler ||= metadata.compiler?.version;
    if (metadata.compiler?.version !== implementationCompiler) fail("IMPLEMENTATION_COMPILER_MISMATCH");
    const template = runtimeBuffer(deployment, record.resolvedRuntime?.code?.lengthBytes);
    const normalizedHash = sha256(template);
    implementationNormalizedHash ||= normalizedHash;
    if (normalizedHash !== implementationNormalizedHash) fail("IMPLEMENTATION_NORMALIZED_RUNTIME_MISMATCH");
    const reconstructed = patchZeroWords(template, IMPLEMENTATION_PATCHES, deployment.args);
    const reconstructedHash = sha256(reconstructed);
    const capturedHash = String(record.resolvedRuntime?.code?.sha256).toLowerCase();
    if (reconstructedHash !== capturedHash) fail("IMPLEMENTATION_RUNTIME_HASH_MISMATCH");

    const stem = fileName.replace("_Implementation.json", "");
    const proxyDeployment = readJson(path.join(DEPLOYMENTS, `${stem}_Proxy.json`));
    if (String(proxyDeployment.address).toLowerCase() !== destination) fail("PROXY_DESTINATION_ADDRESS_MISMATCH");
    if (proxyDeployment.solcInputHash !== PROXY_INPUT_ID) fail("PROXY_SOLC_INPUT_ID_MISMATCH");
    const proxyMetadata = parseMetadata(proxyDeployment);
    if (proxyMetadata.settings?.compilationTarget?.["hardhat-deploy/solc_0.8/proxy/OptimizedTransparentUpgradeableProxy.sol"]
      !== "OptimizedTransparentUpgradeableProxy") fail("PROXY_COMPILATION_TARGET_MISMATCH");
    proxyCompiler ||= proxyMetadata.compiler?.version;
    if (proxyMetadata.compiler?.version !== proxyCompiler) fail("PROXY_COMPILER_MISMATCH");
    const proxyTemplate = runtimeBuffer(proxyDeployment, record.code?.lengthBytes);
    const thisProxyNormalizedHash = sha256(proxyTemplate);
    proxyNormalizedHash ||= thisProxyNormalizedHash;
    if (thisProxyNormalizedHash !== proxyNormalizedHash) fail("PROXY_NORMALIZED_RUNTIME_MISMATCH");
    const proxyRuntime = patchZeroWords(proxyTemplate, [{ argumentIndex: 1, offsets: PROXY_ADMIN_OFFSETS }], proxyDeployment.args);
    const proxyHash = sha256(proxyRuntime);
    const capturedProxyHash = String(record.code?.sha256).toLowerCase();
    if (proxyHash !== capturedProxyHash) fail("PROXY_RUNTIME_HASH_MISMATCH");
    sharedProxyCapturedHash ||= capturedProxyHash;
    if (capturedProxyHash !== sharedProxyCapturedHash) fail("CAPTURED_PROXY_RUNTIME_NOT_SHARED");

    rows.push({
      destination,
      implementation: implementationAddress,
      implementationRuntime: {
        lengthBytes: reconstructed.length,
        capturedSha256: capturedHash,
        reconstructedSha256: reconstructedHash,
        normalizedTemplateSha256: normalizedHash,
        immutableValues: Object.fromEntries(IMPLEMENTATION_PATCHES.map((patch) => [
          patch.name,
          String(deployment.args[patch.argumentIndex]).toLowerCase(),
        ])),
        match: true,
      },
      proxyRuntime: {
        lengthBytes: proxyRuntime.length,
        capturedSha256: capturedProxyHash,
        reconstructedSha256: proxyHash,
        normalizedTemplateSha256: thisProxyNormalizedHash,
        immutableAdmin: String(proxyDeployment.args[1]).toLowerCase(),
        match: true,
      },
    });
  }

  rows.sort((left, right) => left.destination.localeCompare(right.destination));
  if (new Set(rows.map((row) => row.destination)).size !== 9
    || new Set(rows.map((row) => row.implementation)).size !== 9) fail("BINDING_SET_NOT_UNIQUE");
  if (implementationCompiler !== "0.8.25+commit.b61c2a91" || proxyCompiler !== implementationCompiler) {
    fail("UNEXPECTED_COMPILER_VERSION");
  }

  return {
    schema: SCHEMA,
    status: "TOKEN_BUYBACK_SOURCE_RUNTIME_BOUND_9_OF_9",
    scope: {
      tokenBuybackImplementations: "BOUND",
      sharedTransparentProxyRuntime: "BOUND",
      protocolShareReserve: "EXCLUDED_SOURCE_UNBOUND",
      psrSourceBindingClaimed: false,
    },
    fixedBlock: {
      chainId: fixed.chain.chainId,
      number: fixed.chain.selectedFinalizedBlock.number,
      hash: fixed.chain.selectedFinalizedBlock.hash.toLowerCase(),
    },
    sourceCheckout: {
      commit: identity.commit,
      tree: identity.tree,
      lineEndingNormalization: "CRLF_TO_LF_FOR_TRACKED_SOURCE_COMPARISON_ONLY",
    },
    compiler: {
      version: implementationCompiler,
      implementationInput,
      proxyInput,
    },
    matchingMethod: {
      hashAlgorithm: "sha256",
      implementation: "LOCAL_DEPLOYMENT_RUNTIME_TEMPLATE_WITH_SOLC_IMMUTABLE_WORDS_ZEROED; PATCH_FOUR_CONSTRUCTOR_ADDRESS_WORDS_AT_VALIDATED_OFFSETS; REQUIRE_EXACT_CAPTURED_RUNTIME_HASH",
      sharedProxy: "LOCAL_TRANSPARENT_PROXY_RUNTIME_TEMPLATE_WITH_IMMUTABLE_ADMIN_WORDS_ZEROED; PATCH_ADMIN_AT_VALIDATED_OFFSETS; REQUIRE_EXACT_CAPTURED_RUNTIME_HASH",
      metadataIgnored: false,
      wildcardsBeyondDeclaredImmutables: false,
      mismatchPolicy: "FAIL_CLOSED_NO_BINDING_ARTIFACT",
    },
    sharedProxy: {
      proxyCount: rows.length,
      normalizedTemplateSha256: proxyNormalizedHash,
      capturedRuntimeSha256: sharedProxyCapturedHash,
      allExactMatches: true,
      addresses: rows.map((row) => row.destination),
    },
    implementations: rows,
    result: {
      expected: 9,
      matched: rows.length,
      mismatched: 0,
      allExactImmutableAwareMatches: rows.length === 9,
      providerAccessed: false,
      providerMaterialAbsent: true,
      liveAction: false,
    },
  };
}

async function publishNoReplace(artifact) {
  const temporary = `${OUTPUT}.tmp-${process.pid}`;
  let handle;
  try {
    handle = await fsp.open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.link(temporary, OUTPUT);
  } catch (error) {
    if (error?.code === "EEXIST") fail("OUTPUT_EXISTS");
    if (error instanceof BindingError) throw error;
    fail("PUBLICATION_FAILED");
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fsp.unlink(temporary).catch(() => {});
  }
}

async function runCli(argv = process.argv.slice(2)) {
  const output = argv.length === 1 && argv[0] === "--output";
  if (argv.length !== 0 && !output) fail("INVALID_ARGUMENTS");
  const artifact = buildBinding();
  if (output) await publishNoReplace(artifact);
  process.stdout.write(`${JSON.stringify(artifact)}\n`);
  return artifact;
}

if (require.main === module) {
  runCli().catch((error) => {
    const code = error instanceof BindingError ? error.code : "UNEXPECTED";
    process.stdout.write(`${JSON.stringify({ schema: SCHEMA, status: "REJECTED", failure: code })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  SCHEMA,
  OUTPUT,
  BindingError,
  buildBinding,
  publishNoReplace,
  _test: { patchZeroWords, sha256, IMPLEMENTATION_PATCHES, PROXY_ADMIN_OFFSETS },
};
