"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const {
  aggregateRuntimeNormalizations,
  normalizeRuntimeCandidate,
  normalizeTrustedRuntimeTemplates,
} = require("./eulerswap-v2-runtime-normalizer-r1");

const root = path.resolve(__dirname, "..");
const compilerBundle = JSON.parse(fs.readFileSync(
  path.join(root, "reports/raw/fast/eulerswap-v2-compiler-runtime-bundle-r1.json"),
  "utf8",
));
const deploymentAuthority = JSON.parse(fs.readFileSync(
  path.join(root, "reports/raw/fast/eulerswap-v2-base-deployment-authority.json"),
  "utf8",
));
const originalCompilerBundle = structuredClone(compilerBundle);
const originalDeploymentAuthority = structuredClone(deploymentAuthority);
const ERROR_CODE = "E_EULERSWAP_RUNTIME_NORMALIZATION_INVALID";

const expected = {
  factory: ["src/EulerSwapFactory.sol:EulerSwapFactory", 3819, 7, "4bdd5d473028a3dc1c724eec0c1c60f2dc20e0d341f25dce5267305934d39e85"],
  implementation: ["src/EulerSwap.sol:EulerSwap", 23312, 29, "408124d9963c57097485489405479fd6df2a8e413f32e31492eb1dd5e8895aa6"],
  periphery: ["src/EulerSwapPeriphery.sol:EulerSwapPeriphery", 2481, 0, "f98bd760c3818f32272f4c5bc9485b83d34e9a557d0443dca200e52eb2cdadaa"],
  protocolFeeConfig: ["src/EulerSwapProtocolFeeConfig.sol:EulerSwapProtocolFeeConfig", 3546, 7, "83e2e2c4d440ed1073480505822963a4600d98c878a9b65cf90a81ecdd9984bf"],
  registry: ["src/EulerSwapRegistry.sol:EulerSwapRegistry", 9366, 9, "42c58b74bd40be0268f5ea0b37691df2a74b60d9ac3124a2148a08ad7d4c9eb4"],
};

function clone(value) {
  return structuredClone(value);
}

function expectInvalid(action) {
  assert.throws(action, (error) => (
    error instanceof Error
    && error.message === ERROR_CODE
    && error.code === ERROR_CODE
    && error.stack === ERROR_CODE
  ));
}

function assertDeepFrozen(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.strictEqual(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

function entryFor(sourceContract, bundle = compilerBundle) {
  return bundle.contracts.find((entry) => entry.sourceContract === sourceContract);
}

function asHex(bytes) {
  return `0x${bytes.toString("hex")}`;
}

const normalized = normalizeTrustedRuntimeTemplates(compilerBundle, deploymentAuthority);
assert.strictEqual(normalized.componentCount, 5);
assert.strictEqual(normalized.matchedCount, 5);
assert.strictEqual(normalized.allOfficialDigestsMatch, true);
assert.deepStrictEqual(Object.keys(normalized.components), Object.keys(expected));
for (const [key, [sourceContract, executableByteSize, immutableMaskCount, digest]] of Object.entries(expected)) {
  const result = normalized.components[key];
  assert.deepStrictEqual(Object.keys(result), [
    "componentKey",
    "sourceContract",
    "templateSha256",
    "expectedOfficialSha256",
    "planIdentity",
    "normalizedSha256",
    "executableByteSize",
    "immutableMaskCount",
    "childDigestMaskCount",
  ]);
  assert.strictEqual(result.componentKey, key);
  assert.strictEqual(result.sourceContract, sourceContract);
  assert.strictEqual(result.templateSha256, entryFor(sourceContract).bytecodeSha256);
  assert.strictEqual(result.expectedOfficialSha256, digest);
  assert.match(result.planIdentity, /^[0-9a-f]{64}$/);
  assert.strictEqual(result.normalizedSha256, digest);
  assert.strictEqual(result.executableByteSize, executableByteSize);
  assert.strictEqual(result.immutableMaskCount, immutableMaskCount);
  assert.strictEqual(result.childDigestMaskCount, 0);
  const deployment = deploymentAuthority.deployments[key];
  assert.strictEqual(result.normalizedSha256, deployment.strippedSha256);
  assert.strictEqual(entryFor(sourceContract).byteSize, deployment.codeSize);
}
assertDeepFrozen(normalized);

for (const [key, [sourceContract, , immutableMaskCount, digest]] of Object.entries(expected)) {
  const entry = entryFor(sourceContract);
  if (immutableMaskCount > 0) {
    const candidate = Buffer.from(entry.deployedBytecodeTemplate.slice(2), "hex");
    const firstRange = Object.values(entry.immutableReferences).flat()[0];
    candidate.fill(0xa5, firstRange.start, firstRange.start + firstRange.length);
    const result = normalizeRuntimeCandidate(compilerBundle, deploymentAuthority, sourceContract, asHex(candidate));
    assert.strictEqual(result.normalizedSha256, digest, `${key} immutable normalization`);
    assert.strictEqual(result.expectedOfficialSha256, digest);
  }

  const metadataDigestCandidate = Buffer.from(entry.deployedBytecodeTemplate.slice(2), "hex");
  const metadataStart = metadataDigestCandidate.length - 53;
  metadataDigestCandidate.fill(0x5a, metadataStart + 10, metadataStart + 42);
  const metadataResult = normalizeRuntimeCandidate(
    compilerBundle,
    deploymentAuthority,
    sourceContract,
    asHex(metadataDigestCandidate),
  );
  assert.strictEqual(metadataResult.normalizedSha256, digest, `${key} terminal metadata digest stripping`);
}

// Scanner/table reconciliation found no executable-prefix child metadata in these five pinned templates.
assert.strictEqual(Object.values(normalized.components).reduce((sum, result) => sum + result.childDigestMaskCount, 0), 0);

const peripherySource = expected.periphery[0];
const peripheryEntry = entryFor(peripherySource);
const outsideMask = Buffer.from(peripheryEntry.deployedBytecodeTemplate.slice(2), "hex");
outsideMask[0] ^= 0x01;
const mismatch = normalizeRuntimeCandidate(compilerBundle, deploymentAuthority, peripherySource, asHex(outsideMask));
assert.notStrictEqual(mismatch.normalizedSha256, expected.periphery[3]);
expectInvalid(() => aggregateRuntimeNormalizations(compilerBundle, deploymentAuthority, [
  normalized.components.factory,
  normalized.components.implementation,
  mismatch,
  normalized.components.protocolFeeConfig,
  normalized.components.registry,
]));

const canonicalResults = Object.values(normalized.components);
assert.deepStrictEqual(
  aggregateRuntimeNormalizations(compilerBundle, deploymentAuthority, canonicalResults),
  { componentCount: 5, matchedCount: 5, allOfficialDigestsMatch: true },
);
expectInvalid(() => aggregateRuntimeNormalizations(
  compilerBundle,
  deploymentAuthority,
  canonicalResults.map(() => ({ matchesOfficialDigest: true })),
));
expectInvalid(() => aggregateRuntimeNormalizations(compilerBundle, deploymentAuthority, [
  canonicalResults[0], canonicalResults[0], canonicalResults[2], canonicalResults[3], canonicalResults[4],
]));
expectInvalid(() => aggregateRuntimeNormalizations(compilerBundle, deploymentAuthority, canonicalResults.slice(0, 4)));
expectInvalid(() => aggregateRuntimeNormalizations(compilerBundle, deploymentAuthority, [
  canonicalResults[0], canonicalResults[1], canonicalResults[4], canonicalResults[3], canonicalResults[4],
]));
expectInvalid(() => aggregateRuntimeNormalizations(
  compilerBundle,
  deploymentAuthority,
  [...canonicalResults].reverse(),
));

const toJsonForgery = { componentKey: "forged" };
Object.defineProperty(toJsonForgery, "toJSON", {
  enumerable: false,
  value: () => canonicalResults[0],
});
expectInvalid(() => aggregateRuntimeNormalizations(compilerBundle, deploymentAuthority, [
  toJsonForgery,
  ...canonicalResults.slice(1),
]));

const inheritedForgery = Object.create(canonicalResults[0]);
expectInvalid(() => aggregateRuntimeNormalizations(compilerBundle, deploymentAuthority, [
  inheritedForgery,
  ...canonicalResults.slice(1),
]));

const getterForgery = clone(canonicalResults[0]);
delete getterForgery.normalizedSha256;
Object.defineProperty(getterForgery, "normalizedSha256", {
  enumerable: true,
  get: () => canonicalResults[0].normalizedSha256,
});
expectInvalid(() => aggregateRuntimeNormalizations(compilerBundle, deploymentAuthority, [
  getterForgery,
  ...canonicalResults.slice(1),
]));

const symbolForgery = clone(canonicalResults[0]);
symbolForgery[Symbol("forged")] = true;
expectInvalid(() => aggregateRuntimeNormalizations(compilerBundle, deploymentAuthority, [
  symbolForgery,
  ...canonicalResults.slice(1),
]));

const extraKeyForgery = clone(canonicalResults[0]);
extraKeyForgery.extra = true;
expectInvalid(() => aggregateRuntimeNormalizations(compilerBundle, deploymentAuthority, [
  extraKeyForgery,
  ...canonicalResults.slice(1),
]));

for (const field of ["componentKey", "sourceContract", "templateSha256", "expectedOfficialSha256", "planIdentity", "normalizedSha256"]) {
  const tamperedResults = clone(canonicalResults);
  tamperedResults[0][field] = field === "componentKey"
    ? "unknown"
    : field === "sourceContract"
      ? "src/Unknown.sol:Unknown"
      : "0".repeat(64);
  expectInvalid(() => aggregateRuntimeNormalizations(compilerBundle, deploymentAuthority, tamperedResults));
}

const badFraming = Buffer.from(peripheryEntry.deployedBytecodeTemplate.slice(2), "hex");
badFraming[badFraming.length - 1] ^= 0x01;
expectInvalid(() => normalizeRuntimeCandidate(compilerBundle, deploymentAuthority, peripherySource, asHex(badFraming)));

const badMetadata = Buffer.from(peripheryEntry.deployedBytecodeTemplate.slice(2), "hex");
badMetadata[badMetadata.length - 53 + 8] = 0x13;
expectInvalid(() => normalizeRuntimeCandidate(compilerBundle, deploymentAuthority, peripherySource, asHex(badMetadata)));

const badCompiler = Buffer.from(peripheryEntry.deployedBytecodeTemplate.slice(2), "hex");
badCompiler[badCompiler.length - 53 + 50] = 0x1c;
expectInvalid(() => normalizeRuntimeCandidate(compilerBundle, deploymentAuthority, peripherySource, asHex(badCompiler)));

expectInvalid(() => normalizeRuntimeCandidate(
  compilerBundle,
  deploymentAuthority,
  peripherySource,
  peripheryEntry.deployedBytecodeTemplate.toUpperCase(),
));
expectInvalid(() => normalizeRuntimeCandidate(compilerBundle, deploymentAuthority, peripherySource, "0x123"));
expectInvalid(() => normalizeRuntimeCandidate(compilerBundle, deploymentAuthority, "src/Unknown.sol:Unknown", "0x00"));

const unknownChildMetadata = Buffer.from(peripheryEntry.deployedBytecodeTemplate.slice(2), "hex");
const child = Buffer.from(`a2646970667358221220${"11".repeat(32)}64736f6c634300081b0033`, "hex");
child.copy(unknownChildMetadata, 100);
expectInvalid(() => normalizeRuntimeCandidate(
  compilerBundle,
  deploymentAuthority,
  peripherySource,
  asHex(unknownChildMetadata),
));

const badReference = clone(compilerBundle);
entryFor(expected.factory[0], badReference).immutableReferences[770][0].start += 1;
expectInvalid(() => normalizeTrustedRuntimeTemplates(badReference, deploymentAuthority));

const overlappingReference = clone(compilerBundle);
const overlapEntry = entryFor(expected.factory[0], overlappingReference);
overlapEntry.immutableReferences[770][1].start = overlapEntry.immutableReferences[770][0].start;
expectInvalid(() => normalizeTrustedRuntimeTemplates(overlappingReference, deploymentAuthority));

const outOfPrefixReference = clone(compilerBundle);
entryFor(expected.factory[0], outOfPrefixReference).immutableReferences[770][0].start = 3840;
expectInvalid(() => normalizeTrustedRuntimeTemplates(outOfPrefixReference, deploymentAuthority));

const nonEmptyLinkReference = clone(compilerBundle);
entryFor(expected.factory[0], nonEmptyLinkReference).linkReferences = { "src/Library.sol": { Library: [{ start: 1, length: 20 }] } };
expectInvalid(() => normalizeTrustedRuntimeTemplates(nonEmptyLinkReference, deploymentAuthority));

const nonZeroTrustedPlaceholder = clone(compilerBundle);
const nonZeroEntry = entryFor(expected.factory[0], nonZeroTrustedPlaceholder);
const nonZeroBytes = Buffer.from(nonZeroEntry.deployedBytecodeTemplate.slice(2), "hex");
nonZeroBytes[247] = 1;
nonZeroEntry.deployedBytecodeTemplate = asHex(nonZeroBytes);
expectInvalid(() => normalizeTrustedRuntimeTemplates(nonZeroTrustedPlaceholder, deploymentAuthority));

const badOfficialDigest = clone(deploymentAuthority);
badOfficialDigest.deployments.factory.strippedSha256 = "0".repeat(64);
expectInvalid(() => normalizeTrustedRuntimeTemplates(compilerBundle, badOfficialDigest));

assert.deepStrictEqual(compilerBundle, originalCompilerBundle);
assert.deepStrictEqual(deploymentAuthority, originalDeploymentAuthority);
console.log("eulerswap-v2 runtime normalizer r1: ok");
