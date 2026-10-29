#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const runner = require("./run-critical-fluid-vaultt2-t4-negative-max-step2.js");

const ROOT = path.resolve(__dirname, "..");
let checks = 0;

function check(condition, message) {
  checks++;
  if (!condition) throw new Error(`check ${checks} failed: ${message}`);
}

function equal(actual, expected, message) {
  check(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}

function expectThrow(fn, code, message) {
  let observed = null;
  try { fn(); } catch (error) { observed = error.code || error.message; }
  equal(observed, code, message);
}

function readArtifact(relative) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, ...relative.split("/")), "utf8"));
}

const templates = runner.loadRuntimeTemplates();
check(templates[2].vulnerable.logicalBodySha256 !== templates[2].patched.logicalBodySha256, "T2 templates distinct");
check(templates[4].vulnerable.logicalBodySha256 !== templates[4].patched.logicalBodySha256, "T4 templates distinct");

for (const type of [2, 4]) {
  for (const revision of ["vulnerable", "patched"]) {
    const artifact = readArtifact(`remediations/fluid-vaultt2-t4-r2${revision === "vulnerable" ? "-vulnerable" : ""}/out/mainOperate.sol/FluidVaultT${type}Operate.json`);
    const code = `0x${artifact.deployedBytecode.object.replace(/^0x/u, "")}`;
    const result = runner.classifyRuntime(code, type, templates);
    equal(result.classification, `${revision}-shaped`, `T${type} ${revision} self classification`);
    equal(result.logicalBodySha256, templates[type][revision].logicalBodySha256, `T${type} ${revision} logical hash`);
    equal(result.method, "exact-masked-logical-body", `T${type} ${revision} exact method`);

    const chars = code.slice(2).split("");
    const ref = runner.flattenImmutableReferences(artifact)[0];
    for (let i = ref.start * 2; i < (ref.start + ref.length) * 2; i++) chars[i] = "a";
    equal(
      runner.classifyRuntime(`0x${chars.join("")}`, type, templates).classification,
      `${revision}-shaped`,
      `T${type} ${revision} immutable masking`
    );

    const signatureOnly = code.slice(2).split("");
    signatureOnly[200] = signatureOnly[200] === "f" ? "e" : "f";
    const signatureResult = runner.classifyRuntime(`0x${signatureOnly.join("")}`, type, templates);
    equal(signatureResult.classification, `${revision}-shaped`, `T${type} ${revision} semantic signature fallback`);
    equal(
      signatureResult.method,
      revision === "vulnerable"
        ? "unique-duplicated-token0-predicate-bytecode-signature"
        : "unique-token0-token1-predicate-bytecode-signature",
      `T${type} ${revision} semantic method`
    );
  }
}

for (const fixture of [
  [2, "targets/fluid-contracts-public/deployments/mainnet/VaultT2_DEX-wstUSR-USDT_USDT_Operate.json"],
  [4, "targets/fluid-contracts-public/deployments/mainnet/VaultT4_DEX-USDC-ETH_DEX-USDC-ETH_Operate.json"]
]) {
  const artifact = readArtifact(fixture[1]);
  const result = runner.classifyRuntime(artifact.deployedBytecode, fixture[0], templates);
  equal(result.classification, "vulnerable-shaped", `T${fixture[0]} retained deployment artifact predicate`);
  equal(result.method, "unique-duplicated-token0-predicate-bytecode-signature", `T${fixture[0]} retained deployment artifact method`);
}

const t2Artifact = readArtifact("remediations/fluid-vaultt2-t4-r2/out/mainOperate.sol/FluidVaultT2Operate.json");
const t4Artifact = readArtifact("remediations/fluid-vaultt2-t4-r2/out/mainOperate.sol/FluidVaultT4Operate.json");
const t2 = new ethers.Interface(t2Artifact.abi);
const t4 = new ethers.Interface(t4Artifact.abi);
const vault2 = "0x1111111111111111111111111111111111111111";
const vault4 = "0x2222222222222222222222222222222222222222";
const from = "0x3333333333333333333333333333333333333333";
const to = "0x4444444444444444444444444444444444444444";
const facts = new Map([
  [vault2, { type: 2, iface: t2 }],
  [vault4, { type: 4, iface: t4 }]
]);

const t2MinusOne = runner.decodeCall({
  to: vault2,
  from,
  value: "0x0",
  input: t2.encodeFunctionData("operatePerfect", [0n, 10n, 11n, -1n, 0n, to])
}, facts);
equal(t2MinusOne.kind, "operatePerfect", "decode T2 perfect");
equal(t2MinusOne.type, 2, "decode T2 type");
equal(t2MinusOne.perfectColShares.toString(), "10", "decode T2 shares");
equal(t2MinusOne.token0MinMax.toString(), "11", "decode T2 token0 max");
equal(t2MinusOne.token1MinMax.toString(), "-1", "decode T2 minus one");

const t4Min = runner.decodeCall({
  to: vault4,
  from,
  value: "0x0",
  input: t4.encodeFunctionData("operatePerfect", [9n, 12n, 13n, runner.INT_MIN, 0n, 0n, 0n, to])
}, facts);
equal(t4Min.kind, "operatePerfect", "decode T4 perfect");
equal(t4Min.type, 4, "decode T4 type");
equal(t4Min.nftId.toString(), "9", "decode T4 nft");
equal(t4Min.token1MinMax.toString(), runner.INT_MIN.toString(), "decode T4 int min");

const ordinary = runner.decodeCall({
  to: vault2,
  from,
  value: "0x0",
  input: t2.encodeFunctionData("operate", [0n, 1n, 2n, 3n, 4n, to])
}, facts);
equal(ordinary.kind, "operate", "decode ordinary operate");

equal(runner.reserveRatio({ colReserves: { token0RealReserves: 10n, token1RealReserves: 20n } }).toString(), "2000000000000000000", "reserve ratio");
equal(runner.signedBps(110n, 100n).toString(), "1000", "positive reserve bps");
equal(runner.signedBps(90n, 100n).toString(), "-1000", "negative reserve bps");
equal(runner.signedBps(null, 100n), null, "null reserve bps");

runner.assertNoLeaks({ pinHash: `0x${"a".repeat(64)}`, routePositive: 0 });
checks++;
expectThrow(() => runner.assertNoLeaks({ value: "https://example.invalid/secret" }), "LEAK_GUARD_URL", "URL leak rejected");
expectThrow(() => runner.assertNoLeaks({ value: vault2 }), "LEAK_GUARD_ADDRESS", "address leak rejected");
expectThrow(() => runner.assertNoLeaks({ authorization: "secret" }), "LEAK_GUARD_HEADER", "header leak rejected");
expectThrow(() => runner.assertNoLeaks({ endpointUrl: "redacted" }), "LEAK_GUARD_IDENTITY_KEY", "identity key rejected");

const deploymentRoot = path.join(ROOT, "targets", "fluid-contracts-public", "deployments");
const expected = {
  arbitrum: [12, 7],
  base: [9, 3],
  bnb: [4, 1],
  mainnet: [26, 18],
  plasma: [12, 1],
  polygon: [4, 2]
};
let total = 0;
for (const [chain, counts] of Object.entries(expected)) {
  const files = fs.readdirSync(path.join(deploymentRoot, chain));
  const t2Count = files.filter(file => /^VaultT2_.*\.json$/u.test(file) && !file.endsWith("_Operate.json")).length;
  const t4Count = files.filter(file => /^VaultT4_.*\.json$/u.test(file) && !file.endsWith("_Operate.json")).length;
  equal([t2Count, t4Count], counts, `${chain} local deployment counts`);
  total += t2Count + t4Count;
}
equal(total, 99, "local T2/T4 manifest total");

const metadataFixture = `${"60".repeat(10)}${"ab".repeat(43)}002b`;
equal(runner.stripSolidityMetadata(metadataFixture), `${"60".repeat(10)}`, "metadata stripping");

const correctedCapturePath = path.join(ROOT, "reports", "raw", "fast", "critical-fluid-vaultt2-t4-negative-max-step2-capture.json");
if (fs.existsSync(correctedCapturePath)) {
  const corrected = JSON.parse(fs.readFileSync(correctedCapturePath, "utf8"));
  if (corrected.oracleCorrection) {
    equal(corrected.aggregate.vulnerableShapedPredicateSignatureObserved, 128, "corrected shaped aggregate");
    equal(corrected.aggregate.deployedOperatePerfectSemanticsBound, 0, "corrected semantics bound");
    equal(corrected.aggregate.deployedOperatePerfectSemanticsUnbound, 128, "corrected semantics unbound");
    equal(corrected.chains.find(row => row.chain === "base").history.crossFamilyCompletenessAgreement, null, "Base cross-family null");
    equal(corrected.chains.find(row => row.chain === "base").history.successfulLogOperateLinkageProven, false, "Base success linkage unproven");
  }
}

console.log(`PASS ${checks} offline fixture checks; counted 99 local manifest files; classified 2 explicitly retained deployment artifacts`);
