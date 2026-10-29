"use strict";

const crypto = require("crypto");

const ERROR_CODE = "E_EULERSWAP_RUNTIME_NORMALIZATION_INVALID";

const CONTRACTS = Object.freeze({
  factory: Object.freeze({
    sourceContract: "src/EulerSwapFactory.sol:EulerSwapFactory",
    templateSha256: "455b87f72b378497ee40532c0b32ebc94ed78348d17352031f12857f68fcf9c5",
    byteSize: 3872,
    officialSha256: "4bdd5d473028a3dc1c724eec0c1c60f2dc20e0d341f25dce5267305934d39e85",
    immutableReferences: {
      770: [{ start: 247, length: 32 }, { start: 633, length: 32 }, { start: 1381, length: 32 }, { start: 1465, length: 32 }],
      52372: [{ start: 288, length: 32 }, { start: 434, length: 32 }, { start: 1119, length: 32 }],
    },
    immutableRangeCount: 7,
  }),
  implementation: Object.freeze({
    sourceContract: "src/EulerSwap.sol:EulerSwap",
    templateSha256: "d5d02dfaa6ced6912ab1721d223f2d4c45890dce54bca66291741f13d5fb632e",
    byteSize: 23365,
    officialSha256: "408124d9963c57097485489405479fd6df2a8e413f32e31492eb1dd5e8895aa6",
    immutableReferences: {
      770: [{ start: 1430, length: 32 }, { start: 2156, length: 32 }, { start: 2828, length: 32 }, { start: 4052, length: 32 }, { start: 4289, length: 32 }, { start: 4885, length: 32 }, { start: 5060, length: 32 }, { start: 5144, length: 32 }, { start: 7310, length: 32 }, { start: 7419, length: 32 }, { start: 7505, length: 32 }],
      50859: [{ start: 1828, length: 32 }, { start: 3129, length: 32 }, { start: 3228, length: 32 }, { start: 3671, length: 32 }, { start: 3776, length: 32 }, { start: 4598, length: 32 }, { start: 4701, length: 32 }, { start: 4800, length: 32 }, { start: 7777, length: 32 }, { start: 7989, length: 32 }, { start: 8180, length: 32 }, { start: 9129, length: 32 }, { start: 9905, length: 32 }],
      51756: [{ start: 1361, length: 32 }, { start: 7012, length: 32 }],
      55090: [{ start: 513, length: 32 }, { start: 2189, length: 32 }, { start: 7343, length: 32 }],
    },
    immutableRangeCount: 29,
  }),
  periphery: Object.freeze({
    sourceContract: "src/EulerSwapPeriphery.sol:EulerSwapPeriphery",
    templateSha256: "e8eca31d20a9e30d8b358834af9f44418231cff63282eef1ce53e03c6963acf8",
    byteSize: 2534,
    officialSha256: "f98bd760c3818f32272f4c5bc9485b83d34e9a557d0443dca200e52eb2cdadaa",
    immutableReferences: {},
    immutableRangeCount: 0,
  }),
  protocolFeeConfig: Object.freeze({
    sourceContract: "src/EulerSwapProtocolFeeConfig.sol:EulerSwapProtocolFeeConfig",
    templateSha256: "c5815e0bbef77bc9cd7f93a110cdfbf9c35166734f47875ca465b5053c3bb71a",
    byteSize: 3599,
    officialSha256: "83e2e2c4d440ed1073480505822963a4600d98c878a9b65cf90a81ecdd9984bf",
    immutableReferences: {
      770: [{ start: 551, length: 32 }, { start: 2144, length: 32 }, { start: 2185, length: 32 }, { start: 2540, length: 32 }, { start: 2774, length: 32 }, { start: 2858, length: 32 }, { start: 3037, length: 32 }],
    },
    immutableRangeCount: 7,
  }),
  registry: Object.freeze({
    sourceContract: "src/EulerSwapRegistry.sol:EulerSwapRegistry",
    templateSha256: "58baf5cfe581dec8a70e0b8e5d0c04b50d371d8357b4a2eac99b9fd85f7f5e74",
    byteSize: 9419,
    officialSha256: "42c58b74bd40be0268f5ea0b37691df2a74b60d9ac3124a2148a08ad7d4c9eb4",
    immutableReferences: {
      770: [{ start: 709, length: 32 }, { start: 1692, length: 32 }, { start: 4661, length: 32 }, { start: 5962, length: 32 }, { start: 6720, length: 32 }, { start: 6804, length: 32 }, { start: 7362, length: 32 }],
      53939: [{ start: 980, length: 32 }, { start: 3933, length: 32 }],
    },
    immutableRangeCount: 9,
  }),
});

const REVIEWED_CHILD_DIGEST_MASKS = Object.freeze(Object.fromEntries(
  Object.values(CONTRACTS).map((entry) => [`${entry.sourceContract}|${entry.templateSha256}`, Object.freeze([])]),
));
const RESULT_KEYS = Object.freeze([
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

function fail() {
  const error = new Error(ERROR_CODE);
  error.code = ERROR_CODE;
  error.stack = ERROR_CODE;
  throw error;
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function deepFreeze(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child);
  }
  return Object.freeze(value);
}

function parseHex(value) {
  if (typeof value !== "string" || !/^0x(?:[0-9a-f]{2})+$/.test(value)) fail();
  return Buffer.from(value.slice(2), "hex");
}

function validateTerminalMetadata(bytes) {
  if (bytes.length < 53) fail();
  const cborLength = bytes.readUInt16BE(bytes.length - 2);
  if (cborLength !== 51 || bytes.length < cborLength + 2) fail();
  const start = bytes.length - cborLength - 2;
  const metadata = bytes.subarray(start, bytes.length - 2);
  if (
    metadata[0] !== 0xa2
    || metadata[1] !== 0x64
    || metadata.subarray(2, 6).toString("ascii") !== "ipfs"
    || metadata[6] !== 0x58
    || metadata[7] !== 0x22
    || metadata[8] !== 0x12
    || metadata[9] !== 0x20
    || metadata[42] !== 0x64
    || metadata.subarray(43, 47).toString("ascii") !== "solc"
    || metadata[47] !== 0x43
    || metadata[48] !== 0x00
    || metadata[49] !== 0x08
    || metadata[50] !== 0x1b
  ) fail();
  return start;
}

function discoverChildDigestRanges(executable) {
  const ranges = [];
  for (let start = 0; start + 53 <= executable.length; start += 1) {
    if (
      executable[start] === 0xa2
      && executable[start + 1] === 0x64
      && executable.subarray(start + 2, start + 6).toString("ascii") === "ipfs"
      && executable[start + 6] === 0x58
      && executable[start + 7] === 0x22
      && executable[start + 8] === 0x12
      && executable[start + 9] === 0x20
      && executable[start + 42] === 0x64
      && executable.subarray(start + 43, start + 47).toString("ascii") === "solc"
      && executable[start + 47] === 0x43
      && executable[start + 48] === 0x00
      && executable[start + 49] === 0x08
      && executable[start + 50] === 0x1b
      && executable[start + 51] === 0x00
      && executable[start + 52] === 0x33
    ) {
      ranges.push({ start: start + 10, length: 32 });
      start += 52;
    }
  }
  return ranges;
}

function flattenReferences(references) {
  return Object.values(references).flat().map(({ start, length }) => ({ start, length }));
}

function isPlainExactDataObject(value, expectedKeys) {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  const ownNames = Object.getOwnPropertyNames(value);
  if (ownNames.length !== expectedKeys.length) return false;
  const expectedSet = new Set(expectedKeys);
  for (const name of ownNames) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!expectedSet.has(name) || !descriptor || descriptor.enumerable !== true || !("value" in descriptor)) return false;
  }
  return true;
}

function rangesEqual(left, right) {
  if (!Array.isArray(left) || left.length !== right.length) return false;
  for (let index = 0; index < right.length; index += 1) {
    if (
      !isPlainExactDataObject(left[index], ["start", "length"])
      || left[index].start !== right[index].start
      || left[index].length !== right[index].length
    ) return false;
  }
  return true;
}

function immutableReferencesEqual(actual, expected) {
  if (!isPlainExactDataObject(actual, Object.keys(expected))) return false;
  for (const key of Object.keys(expected)) {
    if (!rangesEqual(actual[key], expected[key])) return false;
  }
  return true;
}

function validateRanges(ranges, executableSize, expectedCount, trustedExecutable) {
  if (ranges.length !== expectedCount) fail();
  const ordered = [...ranges].sort((left, right) => left.start - right.start);
  let end = 0;
  for (const range of ordered) {
    if (!Number.isInteger(range.start) || range.length !== 32 || range.start < end || range.start + range.length > executableSize) fail();
    if (!trustedExecutable.subarray(range.start, range.start + range.length).equals(Buffer.alloc(32))) fail();
    end = range.start + range.length;
  }
  return ordered;
}

function createPlan(compilerBundle, deploymentAuthority, key) {
  const expected = CONTRACTS[key];
  const entry = compilerBundle.contracts.find((candidate) => candidate.sourceContract === expected.sourceContract);
  const deployment = deploymentAuthority.deployments[key];
  if (
    !entry
    || !deployment
    || entry.byteSize !== expected.byteSize
    || entry.bytecodeSha256 !== expected.templateSha256
    || deployment.codeSize !== expected.byteSize
    || deployment.strippedSha256 !== expected.officialSha256
    || !immutableReferencesEqual(entry.immutableReferences, expected.immutableReferences)
    || !isPlainExactDataObject(entry.linkReferences, [])
  ) fail();
  const template = parseHex(entry.deployedBytecodeTemplate);
  if (template.length !== expected.byteSize || sha256(template) !== expected.templateSha256) fail();
  const executableSize = validateTerminalMetadata(template);
  const trustedExecutable = Buffer.from(template.subarray(0, executableSize));
  const immutableRanges = validateRanges(
    flattenReferences(entry.immutableReferences),
    executableSize,
    expected.immutableRangeCount,
    trustedExecutable,
  );
  const tableKey = `${expected.sourceContract}|${expected.templateSha256}`;
  const childDigestRanges = REVIEWED_CHILD_DIGEST_MASKS[tableKey];
  if (!childDigestRanges || !rangesEqual(discoverChildDigestRanges(trustedExecutable), childDigestRanges)) fail();
  const planIdentityMaterial = [
    key,
    expected.sourceContract,
    expected.templateSha256,
    expected.officialSha256,
    String(executableSize),
    immutableRanges.map((range) => `${range.start}:${range.length}`).join(","),
    childDigestRanges.map((range) => `${range.start}:${range.length}`).join(","),
  ].join("\0");
  const planIdentity = sha256(Buffer.from(planIdentityMaterial, "utf8"));
  return { key, expected, executableSize, immutableRanges, childDigestRanges, planIdentity };
}

function validateAuthorityInputs(compilerBundle, deploymentAuthority) {
  if (
    !compilerBundle
    || !deploymentAuthority
    || !Array.isArray(compilerBundle.contracts)
    || compilerBundle.contracts.length !== 5
    || !deploymentAuthority.deployments
    || Object.keys(deploymentAuthority.deployments).sort().join("|") !== Object.keys(CONTRACTS).sort().join("|")
    || compilerBundle.contracts.map((entry) => entry.sourceContract).sort().join("|")
      !== Object.values(CONTRACTS).map((entry) => entry.sourceContract).sort().join("|")
  ) fail();
}

function normalizeRuntimeCandidate(compilerBundle, deploymentAuthority, sourceContract, candidateHex) {
  validateAuthorityInputs(compilerBundle, deploymentAuthority);
  const pair = Object.entries(CONTRACTS).find(([, entry]) => entry.sourceContract === sourceContract);
  if (!pair) fail();
  const [key] = pair;
  const plan = createPlan(compilerBundle, deploymentAuthority, key);
  const candidate = parseHex(candidateHex);
  if (candidate.length !== plan.expected.byteSize || validateTerminalMetadata(candidate) !== plan.executableSize) fail();
  const executable = Buffer.from(candidate.subarray(0, plan.executableSize));
  if (!rangesEqual(discoverChildDigestRanges(executable), plan.childDigestRanges)) fail();
  for (const range of plan.immutableRanges) executable.fill(0, range.start, range.start + range.length);
  for (const range of plan.childDigestRanges) executable.fill(0, range.start, range.start + range.length);
  const normalizedSha256 = sha256(executable);
  return deepFreeze({
    componentKey: plan.key,
    sourceContract: plan.expected.sourceContract,
    templateSha256: plan.expected.templateSha256,
    expectedOfficialSha256: plan.expected.officialSha256,
    planIdentity: plan.planIdentity,
    normalizedSha256,
    executableByteSize: executable.length,
    immutableMaskCount: plan.immutableRanges.length,
    childDigestMaskCount: plan.childDigestRanges.length,
  });
}

function aggregateRuntimeNormalizations(compilerBundle, deploymentAuthority, results) {
  validateAuthorityInputs(compilerBundle, deploymentAuthority);
  const canonicalKeys = Object.keys(CONTRACTS);
  if (!Array.isArray(results) || results.length !== canonicalKeys.length) fail();
  let matchedCount = 0;
  for (let index = 0; index < canonicalKeys.length; index += 1) {
    const key = canonicalKeys[index];
    const expected = CONTRACTS[key];
    const entry = compilerBundle.contracts.find((candidate) => candidate.sourceContract === expected.sourceContract);
    const trustedResult = normalizeRuntimeCandidate(
      compilerBundle,
      deploymentAuthority,
      expected.sourceContract,
      entry.deployedBytecodeTemplate,
    );
    const result = results[index];
    if (!isPlainExactDataObject(result, RESULT_KEYS)) fail();
    for (const field of RESULT_KEYS) {
      if (typeof result[field] !== typeof trustedResult[field] || result[field] !== trustedResult[field]) fail();
    }
    if (trustedResult.normalizedSha256 === trustedResult.expectedOfficialSha256) matchedCount += 1;
  }
  return deepFreeze({ componentCount: 5, matchedCount, allOfficialDigestsMatch: matchedCount === 5 });
}

function normalizeTrustedRuntimeTemplates(compilerBundle, deploymentAuthority) {
  validateAuthorityInputs(compilerBundle, deploymentAuthority);
  const components = {};
  for (const [key, expected] of Object.entries(CONTRACTS)) {
    const entry = compilerBundle.contracts.find((candidate) => candidate.sourceContract === expected.sourceContract);
    components[key] = normalizeRuntimeCandidate(
      compilerBundle,
      deploymentAuthority,
      expected.sourceContract,
      entry.deployedBytecodeTemplate,
    );
  }
  const aggregate = aggregateRuntimeNormalizations(compilerBundle, deploymentAuthority, Object.values(components));
  return deepFreeze({ ...aggregate, components });
}

module.exports = Object.freeze({
  normalizeRuntimeCandidate,
  normalizeTrustedRuntimeTemplates,
  aggregateRuntimeNormalizations,
});
