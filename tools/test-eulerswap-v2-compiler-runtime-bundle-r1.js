"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const bundle = readJson("reports/raw/fast/eulerswap-v2-compiler-runtime-bundle-r1.json");
const sourceManifest = readJson("reports/raw/fast/eulerswap-v2-source-manifest.json");
const deploymentAuthority = readJson("reports/raw/fast/eulerswap-v2-base-deployment-authority.json");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function assertExactKeys(value, expected, label) {
  assert.deepStrictEqual(Object.keys(value).sort(), [...expected].sort(), `${label} keys`);
}

const expectedContracts = [
  ["EulerSwapFactory", "src/EulerSwapFactory.sol:EulerSwapFactory"],
  ["EulerSwap", "src/EulerSwap.sol:EulerSwap"],
  ["EulerSwapPeriphery", "src/EulerSwapPeriphery.sol:EulerSwapPeriphery"],
  ["EulerSwapProtocolFeeConfig", "src/EulerSwapProtocolFeeConfig.sol:EulerSwapProtocolFeeConfig"],
  ["EulerSwapRegistry", "src/EulerSwapRegistry.sol:EulerSwapRegistry"],
];

assertExactKeys(bundle, [
  "schema",
  "status",
  "authorityScope",
  "source",
  "toolchain",
  "compiler",
  "captureGates",
  "contracts",
], "bundle");
assert.strictEqual(bundle.schema, "eulerswap-v2-compiler-runtime-bundle/r1");
assert.strictEqual(bundle.status, "PRODUCTION_COMPILER_EVIDENCE_ONLY");
assert.strictEqual(bundle.authorityScope, "COMPILER_EVIDENCE");

assertExactKeys(bundle.source, ["manifestPath", "commit"], "source");
assert.strictEqual(bundle.source.manifestPath, "reports/raw/fast/eulerswap-v2-source-manifest.json");
assert.strictEqual(bundle.source.commit, "81cf6dc988468fd56f690e6bc0e338a5be02d034");
assert.strictEqual(bundle.source.commit, sourceManifest.source.commit);

assertExactKeys(bundle.toolchain, ["ociImage", "foundry"], "toolchain");
assertExactKeys(bundle.toolchain.ociImage, ["reference", "platform", "platformManifestDigest", "imageId"], "OCI image");
assert.deepStrictEqual(bundle.toolchain.ociImage, {
  reference: "ghcr.io/foundry-rs/foundry@sha256:7026b071fb16606a14426acc0a0e2cd57f80b96abd7e7d371fef8dafe1712cdf",
  platform: "linux/amd64",
  platformManifestDigest: "sha256:851514e83f1ea35b82a5236b34c01958942eb5a2d0fc25a507e61df505f949ff",
  imageId: "sha256:9af7b882d05ae4f07a9d187694cacf6189f9708655063fa75ff53f83c0c2e646",
});
assertExactKeys(bundle.toolchain.foundry, ["version", "commit", "forgeSha256"], "Foundry");
assert.deepStrictEqual(bundle.toolchain.foundry, {
  version: "1.3.6-v1.3.6",
  commit: "d2415887096b10226d13af9240b5bef5e6b0d815",
  forgeSha256: "b85926a3a0982ba061d7db5bbfbcd12f35bb9c1f372fce6d71c49685502e0a68",
});

assertExactKeys(bundle.compiler, ["version", "binaryPlatform", "binarySha256", "settings"], "compiler");
assert.strictEqual(bundle.compiler.version, "0.8.27+commit.40a35a09");
assert.strictEqual(bundle.compiler.binaryPlatform, "linux/amd64");
assert.strictEqual(bundle.compiler.binarySha256, "b9977d500c17cba6f0032ca939ef98c4decf6363f19f386d05fb02f708115264");
assertExactKeys(bundle.compiler.settings, ["optimizer", "evmVersion", "metadata", "remappings"], "compiler settings");
assert.deepStrictEqual(bundle.compiler.settings.optimizer, { enabled: true, runs: 2500 });
assert.strictEqual(bundle.compiler.settings.evmVersion, "prague");
assert.deepStrictEqual(bundle.compiler.settings.metadata, { bytecodeHash: "ipfs" });
assert.ok(Array.isArray(bundle.compiler.settings.remappings) && bundle.compiler.settings.remappings.length > 0);

assertExactKeys(bundle.captureGates, [
  "liveRecursiveSourceCleanliness",
  "runtimeNormalization",
  "transportAuthority",
  "fullCaptureGo",
], "capture gates");
assert.deepStrictEqual(bundle.captureGates, {
  liveRecursiveSourceCleanliness: false,
  runtimeNormalization: false,
  transportAuthority: false,
  fullCaptureGo: false,
});

assert.strictEqual(bundle.contracts.length, expectedContracts.length);
assert.deepStrictEqual(bundle.contracts.map((entry) => entry.sourceContract), expectedContracts.map((entry) => entry[1]));
const authorityByContract = new Map(
  Object.values(deploymentAuthority.deployments).map((deployment) => [deployment.contractName, deployment]),
);

for (let index = 0; index < bundle.contracts.length; index += 1) {
  const entry = bundle.contracts[index];
  const [contractName, sourceContract] = expectedContracts[index];
  assertExactKeys(entry, [
    "sourceContract",
    "deployedBytecodeTemplate",
    "immutableReferences",
    "linkReferences",
    "bytecodeSha256",
    "byteSize",
  ], contractName);
  assert.strictEqual(entry.sourceContract, sourceContract);
  assert.match(entry.deployedBytecodeTemplate, /^0x(?:[0-9a-f]{2})+$/);
  assert.strictEqual(typeof entry.immutableReferences, "object");
  assert.strictEqual(typeof entry.linkReferences, "object");
  const bytecode = Buffer.from(entry.deployedBytecodeTemplate.slice(2), "hex");
  assert.strictEqual(entry.byteSize, bytecode.length, `${contractName} byte size recomputation`);
  assert.strictEqual(
    entry.bytecodeSha256,
    crypto.createHash("sha256").update(bytecode).digest("hex"),
    `${contractName} SHA-256 recomputation`,
  );
  assert.strictEqual(entry.byteSize, authorityByContract.get(contractName).codeSize, `${contractName} authority size`);
}

console.log("eulerswap-v2 compiler runtime bundle r1: production compiler evidence ok");
