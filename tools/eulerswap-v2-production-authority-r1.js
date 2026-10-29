"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { normalizeTrustedRuntimeTemplates } = require("./eulerswap-v2-runtime-normalizer-r1");
const { validateNonAuthorizingSourceProvenance } = require("./eulerswap-v2-source-provenance-r1");

const WORKSPACE_ROOT = path.resolve(__dirname, "..");
const FIXED_PATHS = Object.freeze({
  sourceManifest: path.join(WORKSPACE_ROOT, "reports/raw/fast/eulerswap-v2-source-manifest.json"),
  deploymentAuthority: path.join(WORKSPACE_ROOT, "reports/raw/fast/eulerswap-v2-base-deployment-authority.json"),
  compilerBundle: path.join(WORKSPACE_ROOT, "reports/raw/fast/eulerswap-v2-compiler-runtime-bundle-r1.json"),
  sourceRoot: path.join(WORKSPACE_ROOT, "targets/euler-swap-eulerswap-2.0-81cf6dc98846"),
});

const SOURCE_COMMIT = "81cf6dc988468fd56f690e6bc0e338a5be02d034";
const SOURCE_MANIFEST_SHA256 = "22865012f442af2f5b1ef0a80a321b1acf078552b48d1ab839d39455365a86b4";
const DEPLOYMENT_AUTHORITY_SHA256 = "2126e100339822bdca96fdbeedc55eb7c59bf2588a4ca9e67e39120841bfc160";
const COMPILER_BUNDLE_SHA256 = "212d26bf07eeda67d35ccfc0a3bb43293577d0dcfe90b8eaec8aa0b24caf7e40";

const CANONICAL_DEPLOYMENTS = Object.freeze({
  factory: Object.freeze({
    address: "0x6C5f4c239ceD289447737EAB8eEA64523bd9c05E",
    contractName: "EulerSwapFactory",
    sourceContract: "src/EulerSwapFactory.sol:EulerSwapFactory",
    codeSize: 3872,
    strippedSha256: "4bdd5d473028a3dc1c724eec0c1c60f2dc20e0d341f25dce5267305934d39e85",
    templateSha256: "455b87f72b378497ee40532c0b32ebc94ed78348d17352031f12857f68fcf9c5",
  }),
  implementation: Object.freeze({
    address: "0x6F1C1a3eAFbB1b345AD5662b0374a9Bf0E4785af",
    contractName: "EulerSwap",
    sourceContract: "src/EulerSwap.sol:EulerSwap",
    codeSize: 23365,
    strippedSha256: "408124d9963c57097485489405479fd6df2a8e413f32e31492eb1dd5e8895aa6",
    templateSha256: "d5d02dfaa6ced6912ab1721d223f2d4c45890dce54bca66291741f13d5fb632e",
  }),
  periphery: Object.freeze({
    address: "0xA564dAe65eA7B1ce049AbACFC4Cb1A32C93e127c",
    contractName: "EulerSwapPeriphery",
    sourceContract: "src/EulerSwapPeriphery.sol:EulerSwapPeriphery",
    codeSize: 2534,
    strippedSha256: "f98bd760c3818f32272f4c5bc9485b83d34e9a557d0443dca200e52eb2cdadaa",
    templateSha256: "e8eca31d20a9e30d8b358834af9f44418231cff63282eef1ce53e03c6963acf8",
  }),
  protocolFeeConfig: Object.freeze({
    address: "0x78bCCFA312432cE84d0B818796eE33f9192A284d",
    contractName: "EulerSwapProtocolFeeConfig",
    sourceContract: "src/EulerSwapProtocolFeeConfig.sol:EulerSwapProtocolFeeConfig",
    codeSize: 3599,
    strippedSha256: "83e2e2c4d440ed1073480505822963a4600d98c878a9b65cf90a81ecdd9984bf",
    templateSha256: "c5815e0bbef77bc9cd7f93a110cdfbf9c35166734f47875ca465b5053c3bb71a",
  }),
  registry: Object.freeze({
    address: "0x35D410A5052c7362eCdD72cFb65651A71adFaf61",
    contractName: "EulerSwapRegistry",
    sourceContract: "src/EulerSwapRegistry.sol:EulerSwapRegistry",
    codeSize: 9419,
    strippedSha256: "42c58b74bd40be0268f5ea0b37691df2a74b60d9ac3124a2148a08ad7d4c9eb4",
    templateSha256: "58baf5cfe581dec8a70e0b8e5d0c04b50d371d8357b4a2eac99b9fd85f7f5e74",
  }),
});

const ERROR = Object.freeze({
  source: "E_EULERSWAP_SOURCE_AUTHORITY_INVALID",
  deployment: "E_EULERSWAP_DEPLOYMENT_AUTHORITY_INVALID",
  compiler: "E_EULERSWAP_COMPILER_AUTHORITY_INVALID",
  compilerStatus: "E_EULERSWAP_COMPILER_STATUS_INVALID",
  sizeMismatch: "E_EULERSWAP_AUTHORITY_SIZE_MISMATCH",
});

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function readArtifact(filePath, errorCode) {
  try {
    const bytes = fs.readFileSync(filePath);
    return { bytes, value: JSON.parse(bytes.toString("utf8")) };
  } catch (_error) {
    fail(errorCode);
  }
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  return isObject(value)
    && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function validateSourceManifest(artifact, sourceRoot) {
  const manifest = artifact.value;
  const source = manifest && manifest.source;
  const checkout = manifest && manifest.checkout;
  const build = manifest && manifest.build_metadata;
  if (
    manifest.schema !== "eulerswap-v2-source-manifest/v1"
    || manifest.acquisition_class !== "EXACT_LIGHTWEIGHT_TAG_RECURSIVE_SOURCE"
    || !isObject(source)
    || source.repository !== "https://github.com/euler-xyz/euler-swap.git"
    || source.tag !== "eulerswap-2.0"
    || source.tag_type !== "lightweight"
    || source.commit !== SOURCE_COMMIT
    || source.tree !== "2e63f629c73b3458a6505defc6fafb7db87c375b"
    || source.advertised_tag_ref_verified !== true
    || !Array.isArray(source.parents)
    || source.parents.length !== 2
    || !isObject(checkout)
    || checkout.path !== "targets/euler-swap-eulerswap-2.0-81cf6dc98846"
    || checkout.detached !== true
    || checkout.root_clean !== true
    || checkout.recursively_clean !== true
    || !Array.isArray(manifest.direct_gitlinks)
    || manifest.direct_gitlinks.length !== 5
    || !manifest.direct_gitlinks.every((entry) => isObject(entry) && typeof entry.path === "string" && isSha256(entry.commit.padEnd(64, "0").slice(0, 64)))
    || !Array.isArray(manifest.recursive_gitlinks)
    || manifest.recursive_gitlinks.length === 0
    || !manifest.recursive_gitlinks.every((entry) => isObject(entry) && entry.initialized === true && entry.exact_gitlink === true)
    || !isObject(build)
    || build.build_system !== "Foundry"
    || build.source_dir !== "src"
    || build.output_dir !== "out"
    || build.compiler !== "solc 0.8.27"
    || build.optimizer !== true
    || build.optimizer_runs !== 2500
    || build.ci_foundry_pin !== "v1.3.6"
    || build.all_recursive_gitlinks_match !== true
    || !Array.isArray(manifest.files)
    || sha256(artifact.bytes) !== SOURCE_MANIFEST_SHA256
  ) {
    fail(ERROR.source);
  }

  const sourceFiles = manifest.files.filter((entry) => entry.category === "production-solidity");
  if (sourceFiles.length !== manifest.file_counts.production_solidity) fail(ERROR.source);
  try {
    for (const entry of sourceFiles) {
      if (!hasExactKeys(entry, ["path", "category", "sha256"]) || !isSha256(entry.sha256)) fail(ERROR.source);
      const fullPath = path.resolve(sourceRoot, entry.path);
      const relative = path.relative(path.resolve(sourceRoot), fullPath);
      if (relative.startsWith("..") || path.isAbsolute(relative) || sha256(fs.readFileSync(fullPath)) !== entry.sha256) {
        fail(ERROR.source);
      }
    }
  } catch (error) {
    if (error && error.code === ERROR.source) throw error;
    fail(ERROR.source);
  }
}

function validateDeploymentAuthority(deployment) {
  if (
    !hasExactKeys(deployment, ["schema", "status", "chainId", "source", "eulerSwapSource", "deployments", "limitations"])
    || deployment.schema !== "eulerswap-v2-base-deployment-authority-r1"
    || deployment.status !== "OFFICIAL_DEPLOYMENT_AUTHORITY_ONLY"
    || deployment.chainId !== 8453
    || !hasExactKeys(deployment.source, ["repository", "commit", "addressManifestPath", "addressManifestSha256", "verificationManifestPath"])
    || deployment.source.repository !== "euler-xyz/euler-interfaces"
    || deployment.source.commit !== "d0e9a428523b3de6cb3e6c7a06ad55b6e59223f3"
    || deployment.source.addressManifestPath !== "addresses/8453/EulerSwapAddresses.json"
    || deployment.source.addressManifestSha256 !== "b16db2d8c8af9b2fecd1711eb9fae49b5face7b6719b963cc8c2ee375a76d38f"
    || deployment.source.verificationManifestPath !== "verify/manifest.json"
    || !isObject(deployment.eulerSwapSource)
    || !hasExactKeys(deployment.eulerSwapSource, ["repository", "tag", "commit", "solc", "evmVersion", "optimizerRuns"])
    || deployment.eulerSwapSource.repository !== "euler-xyz/euler-swap"
    || deployment.eulerSwapSource.commit !== SOURCE_COMMIT
    || deployment.eulerSwapSource.tag !== "eulerswap-2.0"
    || deployment.eulerSwapSource.solc !== "0.8.27"
    || deployment.eulerSwapSource.evmVersion !== "prague"
    || deployment.eulerSwapSource.optimizerRuns !== 2500
    || !hasExactKeys(deployment.deployments, Object.keys(CANONICAL_DEPLOYMENTS))
  ) {
    fail(ERROR.deployment);
  }

  for (const [key, expected] of Object.entries(CANONICAL_DEPLOYMENTS)) {
    const actual = deployment.deployments[key];
    if (!hasExactKeys(actual, ["address", "contractName", "codeSize", "strippedSha256"])) fail(ERROR.deployment);
    for (const field of ["address", "contractName", "strippedSha256"]) {
      if (actual[field] !== expected[field]) fail(ERROR.deployment);
    }
    if (!Number.isInteger(actual.codeSize) || actual.codeSize <= 0) fail(ERROR.deployment);
  }
}

function validateCompilerBundle(artifact) {
  const bundle = artifact.value;
  if (bundle.status !== "PRODUCTION_COMPILER_EVIDENCE_ONLY" || bundle.authorityScope !== "COMPILER_EVIDENCE") {
    fail(ERROR.compilerStatus);
  }
  if (
    !hasExactKeys(bundle, ["schema", "status", "authorityScope", "source", "toolchain", "compiler", "captureGates", "contracts"])
    || bundle.schema !== "eulerswap-v2-compiler-runtime-bundle/r1"
    || !hasExactKeys(bundle.source, ["manifestPath", "commit"])
    || bundle.source.manifestPath !== "reports/raw/fast/eulerswap-v2-source-manifest.json"
    || bundle.source.commit !== SOURCE_COMMIT
    || !hasExactKeys(bundle.toolchain, ["ociImage", "foundry"])
    || !hasExactKeys(bundle.toolchain.ociImage, ["reference", "platform", "platformManifestDigest", "imageId"])
    || bundle.toolchain.ociImage.reference !== "ghcr.io/foundry-rs/foundry@sha256:7026b071fb16606a14426acc0a0e2cd57f80b96abd7e7d371fef8dafe1712cdf"
    || bundle.toolchain.ociImage.platform !== "linux/amd64"
    || bundle.toolchain.ociImage.platformManifestDigest !== "sha256:851514e83f1ea35b82a5236b34c01958942eb5a2d0fc25a507e61df505f949ff"
    || bundle.toolchain.ociImage.imageId !== "sha256:9af7b882d05ae4f07a9d187694cacf6189f9708655063fa75ff53f83c0c2e646"
    || !hasExactKeys(bundle.toolchain.foundry, ["version", "commit", "forgeSha256"])
    || bundle.toolchain.foundry.version !== "1.3.6-v1.3.6"
    || bundle.toolchain.foundry.commit !== "d2415887096b10226d13af9240b5bef5e6b0d815"
    || bundle.toolchain.foundry.forgeSha256 !== "b85926a3a0982ba061d7db5bbfbcd12f35bb9c1f372fce6d71c49685502e0a68"
    || !hasExactKeys(bundle.compiler, ["version", "binaryPlatform", "binarySha256", "settings"])
    || bundle.compiler.version !== "0.8.27+commit.40a35a09"
    || bundle.compiler.binaryPlatform !== "linux/amd64"
    || bundle.compiler.binarySha256 !== "b9977d500c17cba6f0032ca939ef98c4decf6363f19f386d05fb02f708115264"
    || !isObject(bundle.compiler.settings)
    || bundle.compiler.settings.optimizer?.enabled !== true
    || bundle.compiler.settings.optimizer?.runs !== 2500
    || bundle.compiler.settings.evmVersion !== "prague"
    || bundle.compiler.settings.metadata?.bytecodeHash !== "ipfs"
    || !Array.isArray(bundle.compiler.settings.remappings)
    || !hasExactKeys(bundle.captureGates, ["liveRecursiveSourceCleanliness", "runtimeNormalization", "transportAuthority", "fullCaptureGo"])
    || bundle.captureGates.liveRecursiveSourceCleanliness !== false
    || bundle.captureGates.runtimeNormalization !== false
    || bundle.captureGates.transportAuthority !== false
    || bundle.captureGates.fullCaptureGo !== false
    || !Array.isArray(bundle.contracts)
    || bundle.contracts.length !== Object.keys(CANONICAL_DEPLOYMENTS).length
  ) {
    fail(ERROR.compiler);
  }

  const byName = new Map();
  for (const entry of bundle.contracts) {
    if (!hasExactKeys(entry, ["sourceContract", "deployedBytecodeTemplate", "immutableReferences", "linkReferences", "bytecodeSha256", "byteSize"])) {
      fail(ERROR.compiler);
    }
    const contractName = entry.sourceContract.split(":")[1];
    if (
      !contractName
      || byName.has(contractName)
      || typeof entry.deployedBytecodeTemplate !== "string"
      || !/^0x(?:[0-9a-f]{2})+$/.test(entry.deployedBytecodeTemplate)
      || !isObject(entry.immutableReferences)
      || !isObject(entry.linkReferences)
      || !isSha256(entry.bytecodeSha256)
      || !Number.isInteger(entry.byteSize)
    ) {
      fail(ERROR.compiler);
    }
    const bytes = Buffer.from(entry.deployedBytecodeTemplate.slice(2), "hex");
    if (bytes.length !== entry.byteSize || sha256(bytes) !== entry.bytecodeSha256) fail(ERROR.compiler);
    byName.set(contractName, entry);
  }
  return byName;
}

function validateCrossBindings(deployment, bundleByName) {
  for (const [key, expected] of Object.entries(CANONICAL_DEPLOYMENTS)) {
    const deployed = deployment.deployments[key];
    const compiled = bundleByName.get(expected.contractName);
    if (!compiled || deployed.codeSize !== compiled.byteSize) fail(ERROR.sizeMismatch);
  }

  for (const [key, expected] of Object.entries(CANONICAL_DEPLOYMENTS)) {
    const deployed = deployment.deployments[key];
    const compiled = bundleByName.get(expected.contractName);
    if (
      deployed.codeSize !== expected.codeSize
      || compiled.sourceContract !== expected.sourceContract
      || compiled.byteSize !== expected.codeSize
      || compiled.bytecodeSha256 !== expected.templateSha256
    ) {
      fail(ERROR.deployment);
    }
  }
}

function deepFreeze(value) {
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (Object.prototype.hasOwnProperty.call(descriptor, "value") && descriptor.value && typeof descriptor.value === "object") {
      deepFreeze(descriptor.value);
    }
  }
  return Object.freeze(value);
}

function makeAuthority(deployment, bundleByName, bundle, runtimeNormalization) {
  const addresses = {};
  const compiledTemplates = {};
  for (const [key, expected] of Object.entries(CANONICAL_DEPLOYMENTS)) {
    const compiled = bundleByName.get(expected.contractName);
    addresses[key] = deployment.deployments[key].address;
    compiledTemplates[key] = {
      contractName: expected.contractName,
      sourceContract: compiled.sourceContract,
      deployedBytecodeTemplate: compiled.deployedBytecodeTemplate,
      immutableReferences: compiled.immutableReferences,
      linkReferences: compiled.linkReferences,
      bytecodeSha256: compiled.bytecodeSha256,
      byteSize: compiled.byteSize,
    };
  }

  return deepFreeze({
    schema: "eulerswap-v2-production-authority/r1",
    chainId: 8453,
    source: { commit: SOURCE_COMMIT, root: "targets/euler-swap-eulerswap-2.0-81cf6dc98846" },
    compilerAuthority: {
      status: bundle.status,
      authorityScope: bundle.authorityScope,
      toolchain: bundle.toolchain,
      compiler: bundle.compiler,
    },
    capabilities: {
      compilerEvidence: true,
      liveRecursiveSourceCleanliness: true,
      runtimeNormalization: runtimeNormalization.allOfficialDigestsMatch,
      transportAuthority: false,
      fullCaptureGo: false,
    },
    runtimeNormalization,
    addresses,
    compiledTemplates,
  });
}

function loadProductionAuthorityFromPaths(paths) {
  try {
    const sourceArtifact = readArtifact(paths.sourceManifest, ERROR.source);
    validateSourceManifest(sourceArtifact, paths.sourceRoot);
    const deploymentArtifact = readArtifact(paths.deploymentAuthority, ERROR.deployment);
    validateDeploymentAuthority(deploymentArtifact.value);
    const compilerArtifact = readArtifact(paths.compilerBundle, ERROR.compiler);
    const bundleByName = validateCompilerBundle(compilerArtifact);
    validateCrossBindings(deploymentArtifact.value, bundleByName);
    if (sha256(deploymentArtifact.bytes) !== DEPLOYMENT_AUTHORITY_SHA256) fail(ERROR.deployment);
    if (sha256(compilerArtifact.bytes) !== COMPILER_BUNDLE_SHA256) fail(ERROR.compiler);
    const runtimeNormalization = normalizeTrustedRuntimeTemplates(compilerArtifact.value, deploymentArtifact.value);
    if (!runtimeNormalization.allOfficialDigestsMatch) fail("E_EULERSWAP_RUNTIME_NORMALIZATION_MISMATCH");
    validateNonAuthorizingSourceProvenance({ sourceRoot: paths.sourceRoot, manifest: sourceArtifact.value });
    return makeAuthority(deploymentArtifact.value, bundleByName, compilerArtifact.value, runtimeNormalization);
  } catch (error) {
    if (
      error
      && (
        Object.values(ERROR).includes(error.code)
        || /^E_EULERSWAP_SOURCE_PROVENANCE_[A-Z_]+$/.test(error.code || "")
        || /^E_EULERSWAP_RUNTIME_NORMALIZATION_[A-Z_]+$/.test(error.code || "")
      )
    ) throw error;
    fail(ERROR.source);
  }
}

function loadProductionAuthority() {
  return loadProductionAuthorityFromPaths(FIXED_PATHS);
}

module.exports = Object.freeze({
  loadProductionAuthority,
});
