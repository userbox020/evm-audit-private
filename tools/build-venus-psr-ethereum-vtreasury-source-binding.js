#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const CAPTURE_PATH = path.join(ROOT, "reports", "raw", "fast", "venus-psr-ethereum-fixed-block.json");
const DEPLOYMENT_PATH = path.join(ROOT, "targets", "venus-protocol", "deployments", "ethereum", "VTreasuryV8.json");
const OUTPUT_PATH = path.join(ROOT, "reports", "raw", "fast", "venus-psr-ethereum-vtreasury-source-binding.json");
const TARGET_ROOT = path.join(ROOT, "targets", "venus-protocol");
const TARGET_SOURCE = "contracts/Governance/VTreasuryV8.sol";
const TARGET_CONTRACT = "VTreasuryV8";
const DESTINATION = "0xfd9b071168bc27dbe16406ec3aba050ce8eb22fa";
const ZERO = "0x0000000000000000000000000000000000000000";
const SCHEMA = "venus-psr-ethereum-vtreasury-source-binding/v1";

const EXPECTED = Object.freeze({
  captureSha256: "0x8a954ba0cad23aaae41c9d8f8ca102081410f9adcd89c95809c0fed54258353b",
  deploymentSha256: "0xa6391d2d88795e3fbe04ceda89fd07a3a8beec94b5db5f22b6ee8104545b22ae",
  inputId: "427921aed0a07e3af769b0b61644e89c",
  inputSha256: "0x95222d5638891e567f9d40fc4a81e4152f4325a861a967d564fe64f0608f8f95",
  compiler: "0.8.20+commit.a1b79de6",
  compilationTarget: `${TARGET_SOURCE}:${TARGET_CONTRACT}`,
  settingsSha256: "0xbc12dcc82291f57011afadeabc96077b080153266de84c0a2f43084bf051b52d",
  metadataSettingsSha256: "0xe5189c7f434e71648fe0075716276e6bd89571f9978c2548fb71bec476d35696",
  targetSourceSha256: "0xaf35afbf44b1b60eb1086597f7284fdb2863dc4d441693c43050c93bf6cd5b0e",
  abiSha256: "0x83a0e094b2d78fa38c32e41878563bca92678de2487757fdd7a7ce88e1870a11",
  creationSha256: "0x5398e278e4f561ce25aef622cb63e463b6e4324f9e3bbaac7861c53e826f1b99",
  runtimeSha256: "0x458fbbc0f5f5e5ce479c8b47cad4accd416bff591e4ea85a826cd98d5f487a46",
  runtimeLength: 2702,
  fixedBlock: 25692605,
});

class BindingError extends Error {
  constructor(code) { super(code); this.name = "BindingError"; this.code = code; }
}
function fail(code) { throw new BindingError(code); }
function sha256(value) { return `0x${crypto.createHash("sha256").update(value).digest("hex")}`; }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function normalizedSource(value) { return String(value).replace(/\r\n/g, "\n"); }
function strictAddress(value, code) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) fail(code);
  return value.toLowerCase();
}
function strictBytes(value, code) {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(value)) fail(code);
  return Buffer.from(value.slice(2), "hex");
}
function relative(value) { return path.relative(ROOT, value).replace(/\\/g, "/"); }
function checkoutIdentity() {
  try {
    return {
      commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: TARGET_ROOT, encoding: "utf8" }).trim(),
      tree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: TARGET_ROOT, encoding: "utf8" }).trim(),
    };
  } catch { return { commit: null, tree: null }; }
}
function abiCommitment(abi) {
  return sha256(Buffer.from(canonical(abi.map((entry) => ({
    type: entry.type, name: entry.name || null,
    inputs: (entry.inputs || []).map((input) => ({ type: input.type, indexed: input.indexed ?? null })),
    outputs: (entry.outputs || []).map((output) => output.type),
    stateMutability: entry.stateMutability || null,
  })))));
}
function assertSourceSemantics(input) {
  const target = input.sources?.[TARGET_SOURCE]?.content;
  const ownable = input.sources?.["@openzeppelin/contracts/access/Ownable.sol"]?.content;
  const ownable2Step = input.sources?.["@openzeppelin/contracts/access/Ownable2Step.sol"]?.content;
  const guard = input.sources?.["@openzeppelin/contracts/security/ReentrancyGuard.sol"]?.content;
  if (![target, ownable, ownable2Step, guard].every((value) => typeof value === "string")) fail("MISSING_HISTORICAL_DEPENDENCY_SOURCE");
  if (!/function\s+withdrawTreasuryToken\s*\([\s\S]*?\)\s*external\s+onlyOwner\s+nonReentrant\s*\{/.test(target)) fail("TOKEN_WITHDRAW_ACCESS_MISMATCH");
  if (!/function\s+withdrawTreasuryNative\s*\([\s\S]*?\)\s*external\s+payable\s+onlyOwner\s+nonReentrant\s*\{/.test(target)) fail("NATIVE_WITHDRAW_ACCESS_MISMATCH");
  if (!/fallback\s*\(\s*\)\s*external\s+payable\s*\{\s*\}/.test(target)
    || !/receive\s*\(\s*\)\s*external\s+payable\s*\{\s*\}/.test(target)) fail("PASSIVE_RECEIVER_MISMATCH");
  if (!/modifier\s+onlyOwner\s*\(\s*\)\s*\{[\s\S]*?_checkOwner\s*\(\s*\)\s*;[\s\S]*?_\s*;[\s\S]*?\}/.test(ownable)
    || !/function\s+renounceOwnership\s*\(\s*\)\s*public\s+virtual\s+onlyOwner/.test(ownable)
    || !/function\s+transferOwnership\s*\(address\s+newOwner\)\s*public\s+virtual\s+override\s+onlyOwner/.test(ownable2Step)
    || !/function\s+acceptOwnership\s*\(\s*\)\s*public\s+virtual\s*\{[\s\S]*?pendingOwner\s*\(\s*\)\s*==\s*sender/.test(ownable2Step)) fail("OWNERSHIP_ACCESS_MISMATCH");
  if (!/modifier\s+nonReentrant\s*\(\s*\)\s*\{[\s\S]*?_nonReentrantBefore\s*\(\s*\)[\s\S]*?_\s*;[\s\S]*?_nonReentrantAfter\s*\(\s*\)/.test(guard)) fail("REENTRANCY_GUARD_MISMATCH");
  if (/\b(?:updateAssetsState|converterNetwork|MAX_INCENTIVE|conversionConfigurations)\b/.test(target)) fail("CONVERTER_SURFACE_PRESENT");
  return target;
}
function assertAbi(abi) {
  if (!Array.isArray(abi) || abiCommitment(abi) !== EXPECTED.abiSha256) fail("ABI_MISMATCH");
  const functions = abi.filter((entry) => entry.type === "function").map((entry) => `${entry.name}(${(entry.inputs || []).map((input) => input.type).join(",")}):${entry.stateMutability}`).sort();
  const expected = [
    "acceptOwnership():nonpayable", "owner():view", "pendingOwner():view", "renounceOwnership():nonpayable",
    "transferOwnership(address):nonpayable", "withdrawTreasuryNative(uint256,address):payable",
    "withdrawTreasuryToken(address,uint256,address):nonpayable",
  ].sort();
  if (canonical(functions) !== canonical(expected)) fail("UNKNOWN_EXTERNAL_FUNCTION");
  if (abi.filter((entry) => entry.type === "fallback" && entry.stateMutability === "payable").length !== 1
    || abi.filter((entry) => entry.type === "receive" && entry.stateMutability === "payable").length !== 1) fail("RECEIVER_ABI_MISMATCH");
}
function buildSupplement({ capture, deployment, input, rawHashes = {}, currentSource = null, checkout = { commit: null, tree: null } }) {
  if (capture?.schema !== "venus-psr-ethereum-fixed-block/v1" || capture.chain?.chainId !== 1
    || capture.chain?.selectedFinalizedBlock?.number !== EXPECTED.fixedBlock) fail("CAPTURE_SCHEMA_OR_SCOPE_MISMATCH");
  const positiveDestinations = [...new Set((capture.distribution?.rows || []).filter((row) => row.percentage > 0).map((row) => strictAddress(row.destination, "CAPTURE_DESTINATION_INVALID")))];
  if (positiveDestinations.length !== 1 || positiveDestinations[0] !== DESTINATION) fail("POSITIVE_DESTINATION_MISMATCH");
  const rows = (capture.destinations || []).filter((row) => strictAddress(row.destination, "CAPTURE_DESTINATION_INVALID") === DESTINATION);
  if (rows.length !== 1 || rows[0].classification !== "UNKNOWN_CONTRACT" || rows[0].sourceBound !== false) fail("HISTORICAL_CLASSIFICATION_MISMATCH");
  const captured = rows[0];
  if (strictAddress(deployment.address, "DEPLOYMENT_ADDRESS_INVALID") !== DESTINATION) fail("DEPLOYMENT_ADDRESS_MISMATCH");
  const receipt = deployment.receipt;
  if (!receipt || receipt.status !== 1 || receipt.to !== null || strictAddress(receipt.contractAddress, "RECEIPT_ADDRESS_INVALID") !== DESTINATION
    || !Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber <= 0 || typeof deployment.transactionHash !== "string") fail("DIRECT_DEPLOYMENT_RECEIPT_MISMATCH");
  const slots = captured.eip1967;
  if (!slots || slots.implementationSlot !== ZERO || slots.adminSlot !== ZERO || slots.beaconSlot !== ZERO
    || captured.resolvedRuntime?.resolution !== "DIRECT_RUNTIME_NO_EIP1967_TARGET"
    || strictAddress(captured.resolvedRuntime?.address, "RESOLVED_RUNTIME_ADDRESS_INVALID") !== DESTINATION
    || captured.beacon !== null) fail("PROXY_CONTRADICTION");
  const runtime = strictBytes(deployment.deployedBytecode, "RUNTIME_INVALID");
  const creation = strictBytes(deployment.bytecode, "CREATION_INVALID");
  const runtimeHash = sha256(runtime); const creationHash = sha256(creation);
  if (runtime.length !== EXPECTED.runtimeLength || runtimeHash !== EXPECTED.runtimeSha256
    || captured.code?.lengthBytes !== runtime.length || captured.code?.sha256 !== runtimeHash
    || captured.resolvedRuntime?.code?.lengthBytes !== runtime.length || captured.resolvedRuntime?.code?.sha256 !== runtimeHash) fail("FULL_RUNTIME_MISMATCH");
  if (creationHash !== EXPECTED.creationSha256) fail("CREATION_BYTECODE_MISMATCH");
  let metadata; try { metadata = JSON.parse(deployment.metadata); } catch { fail("METADATA_INVALID"); }
  const compilationTargetEntry = Object.entries(metadata?.settings?.compilationTarget || {});
  const compilationTarget = compilationTargetEntry.length === 1 ? `${compilationTargetEntry[0][0]}:${compilationTargetEntry[0][1]}` : null;
  const settingsHash = sha256(Buffer.from(canonical(input.settings)));
  const metadataSettingsHash = sha256(Buffer.from(canonical(metadata.settings)));
  if (deployment.solcInputHash !== EXPECTED.inputId || metadata?.compiler?.version !== EXPECTED.compiler
    || compilationTarget !== EXPECTED.compilationTarget || settingsHash !== EXPECTED.settingsSha256
    || metadataSettingsHash !== EXPECTED.metadataSettingsSha256) fail("COMPILER_OR_SETTINGS_MISMATCH");
  assertAbi(deployment.abi);
  const historicalTarget = assertSourceSemantics(input);
  const targetSourceHash = sha256(Buffer.from(normalizedSource(historicalTarget)));
  if (targetSourceHash !== EXPECTED.targetSourceSha256) fail("HISTORICAL_TARGET_SOURCE_MISMATCH");
  const dependencyNames = Object.keys(metadata.sources || {}).sort();
  if (!dependencyNames.length) fail("EMPTY_DEPENDENCY_SET");
  const historicalSources = dependencyNames.map((sourcePath) => {
    const content = input.sources?.[sourcePath]?.content;
    if (typeof content !== "string") fail("MISSING_INPUT_DEPENDENCY");
    return { sourcePath, normalizedSha256: sha256(Buffer.from(normalizedSource(content))), metadataKeccak256: metadata.sources[sourcePath]?.keccak256 || null };
  });
  const currentAvailable = typeof currentSource === "string";
  const currentHash = currentAvailable ? sha256(Buffer.from(normalizedSource(currentSource))) : null;
  const supplement = {
    schema: SCHEMA,
    classification: "SOURCE_BOUND_NONPUBLIC_SINK",
    scope: {
      chainId: 1, blockNumber: capture.chain.selectedFinalizedBlock.number, blockHash: capture.chain.selectedFinalizedBlock.hash,
      destination: DESTINATION, fixedBlockAndDestinationOnly: true,
    },
    supersession: {
      kind: "SUPPLEMENT_ONLY_NO_FIXED_ARTIFACT_MUTATION", priorClassification: "UNKNOWN_CONTRACT",
      supplementalClassification: "SOURCE_BOUND_NONPUBLIC_SINK", fixedArtifactPath: relative(CAPTURE_PATH),
    },
    exactRuntimeBinding: {
      fullRuntimeIncludingMetadata: true, wildcardMasking: false, lengthBytes: runtime.length,
      sha256: runtimeHash, capturedLengthAndSha256Exact: true,
    },
    buildBinding: {
      compilerVersion: metadata.compiler.version, standardJsonInputId: deployment.solcInputHash,
      standardJsonInputSha256: rawHashes.inputSha256 || null, compilerSettingsSha256: settingsHash,
      metadataSettingsSha256: metadataSettingsHash, compilationTarget,
      creationBytecode: { lengthBytes: creation.length, sha256: creationHash },
      deployedRuntime: { lengthBytes: runtime.length, sha256: runtimeHash },
    },
    sourceBinding: {
      authority: "PERSISTED_HISTORICAL_STANDARD_JSON_INPUT", historicalInputBound: true,
      targetSource: TARGET_SOURCE, targetContract: TARGET_CONTRACT, targetNormalizedSha256: targetSourceHash,
      historicalSources, currentCheckoutComparison: {
        bindingRequirement: false, available: currentAvailable, normalizedSha256: currentHash,
        exactHistoricalMatch: currentAvailable ? currentHash === targetSourceHash : null,
        semanticsClaimedFromCurrentCheckout: false,
      },
    },
    provenance: {
      fixedCapture: { path: relative(CAPTURE_PATH), sha256: rawHashes.captureSha256 || null },
      deploymentArtifact: { path: relative(DEPLOYMENT_PATH), sha256: rawHashes.deploymentSha256 || null },
      standardJsonInput: { path: `targets/venus-protocol/deployments/ethereum/solcInputs/${deployment.solcInputHash}.json`, sha256: rawHashes.inputSha256 || null },
      checkout,
    },
    deploymentEvidence: {
      address: DESTINATION, directDeployment: true, nonProxy: true, transactionHash: deployment.transactionHash,
      blockNumber: receipt.blockNumber, receiptStatus: receipt.status, receiptTo: receipt.to,
      eip1967: { implementation: ZERO, admin: ZERO, beacon: ZERO },
    },
    assetMovingSurface: {
      abiExact: true, abiSha256: EXPECTED.abiSha256, unknownMutatingOrValueMovingExternalSurface: false,
      withdrawals: [
        { function: "withdrawTreasuryToken(address,uint256,address)", access: "onlyOwner", reentrancy: "nonReentrant", asset: "ERC20" },
        { function: "withdrawTreasuryNative(uint256,address)", access: "onlyOwner", reentrancy: "nonReentrant", asset: "NATIVE" },
      ],
      ownership: {
        transferOwnership: "onlyOwner_two_step_start", acceptOwnership: "pendingOwner_only",
        renounceOwnership: "onlyOwner", ownerAtPin: captured.probes?.owner?.available === true ? strictAddress(captured.probes.owner.value, "OWNER_INVALID") : null,
        ownerIdentitySemanticsGloballyResolved: false,
      },
      passiveValueReception: { receive: true, fallback: true, bodiesEmptyInBoundHistoricalSource: true },
      absentSurfaces: { publicConverter: true, incentiveConfiguration: true, updateAssetsState: true },
    },
    safety: { providerMaterialAbsent: true, rawRpcEnvelopeAbsent: true, networkAccess: false, transactions: 0, signedActionJustified: false, executableNow: false },
  };
  supplement.deterministicContentSha256 = sha256(Buffer.from(canonical(supplement)));
  validateSupplement(supplement);
  return supplement;
}
function validateSupplement(value) {
  if (!value || value.schema !== SCHEMA || value.classification !== "SOURCE_BOUND_NONPUBLIC_SINK"
    || value.scope?.destination !== DESTINATION || value.scope?.blockNumber !== EXPECTED.fixedBlock
    || value.supersession?.priorClassification !== "UNKNOWN_CONTRACT"
    || value.supersession?.kind !== "SUPPLEMENT_ONLY_NO_FIXED_ARTIFACT_MUTATION"
    || value.exactRuntimeBinding?.sha256 !== EXPECTED.runtimeSha256 || value.exactRuntimeBinding?.lengthBytes !== EXPECTED.runtimeLength
    || value.exactRuntimeBinding?.wildcardMasking !== false || value.buildBinding?.standardJsonInputId !== EXPECTED.inputId
    || value.buildBinding?.compilerVersion !== EXPECTED.compiler || value.buildBinding?.compilerSettingsSha256 !== EXPECTED.settingsSha256
    || value.sourceBinding?.historicalInputBound !== true || value.sourceBinding?.currentCheckoutComparison?.bindingRequirement !== false
    || value.deploymentEvidence?.directDeployment !== true || value.deploymentEvidence?.nonProxy !== true
    || value.assetMovingSurface?.unknownMutatingOrValueMovingExternalSurface !== false
    || value.assetMovingSurface?.absentSurfaces?.publicConverter !== true || value.assetMovingSurface?.absentSurfaces?.updateAssetsState !== true
    || value.safety?.providerMaterialAbsent !== true || value.safety?.networkAccess !== false) fail("SUPPLEMENT_SCHEMA_INVALID");
  const copy = structuredClone(value); delete copy.deterministicContentSha256;
  if (value.deterministicContentSha256 !== sha256(Buffer.from(canonical(copy)))) fail("SUPPLEMENT_COMMITMENT_MISMATCH");
  if (/(?:https?|wss?):\/\//i.test(JSON.stringify(value))) fail("PROVIDER_OR_URL_MATERIAL_PRESENT");
  return true;
}
function loadInputs() {
  const captureBytes = fs.readFileSync(CAPTURE_PATH); const deploymentBytes = fs.readFileSync(DEPLOYMENT_PATH);
  const deployment = JSON.parse(deploymentBytes); const inputPath = path.join(path.dirname(DEPLOYMENT_PATH), "solcInputs", `${deployment.solcInputHash}.json`);
  const inputBytes = fs.readFileSync(inputPath);
  const rawHashes = { captureSha256: sha256(captureBytes), deploymentSha256: sha256(deploymentBytes), inputSha256: sha256(inputBytes) };
  if (rawHashes.captureSha256 !== EXPECTED.captureSha256 || rawHashes.deploymentSha256 !== EXPECTED.deploymentSha256 || rawHashes.inputSha256 !== EXPECTED.inputSha256) fail("PERSISTED_INPUT_HASH_MISMATCH");
  const currentPath = path.join(TARGET_ROOT, TARGET_SOURCE);
  return {
    capture: JSON.parse(captureBytes), deployment, input: JSON.parse(inputBytes), rawHashes,
    currentSource: fs.existsSync(currentPath) ? fs.readFileSync(currentPath, "utf8") : null, checkout: checkoutIdentity(),
  };
}
async function publishNoReplaceAtomic(outputPath, artifact) {
  if (path.resolve(outputPath) !== OUTPUT_PATH) fail("OUTPUT_PATH_NOT_ALLOWED");
  validateSupplement(artifact);
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  let handle;
  try {
    handle = await fsp.open(temporary, "wx", 0o600); await handle.writeFile(`${JSON.stringify(artifact, null, 2)}\n`); await handle.sync(); await handle.close(); handle = null;
    await fsp.link(temporary, outputPath);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (error?.code === "EEXIST") fail("OUTPUT_EXISTS");
    if (error instanceof BindingError) throw error;
    fail("PUBLICATION_FAILED");
  } finally { await fsp.unlink(temporary).catch(() => {}); }
}
async function main() {
  if (process.argv.length !== 2) fail("ARGUMENTS_NOT_ALLOWED");
  const artifact = buildSupplement(loadInputs());
  await publishNoReplaceAtomic(OUTPUT_PATH, artifact);
  process.stdout.write(`${JSON.stringify({ schema: SCHEMA, status: "GENERATED", classification: artifact.classification, providerMaterialAbsent: true, networkAccess: false })}\n`);
}
if (require.main === module) main().catch((error) => { process.stdout.write(`${JSON.stringify({ schema: SCHEMA, status: "REJECTED", errorClass: error instanceof BindingError ? error.code : "UNEXPECTED" })}\n`); process.exitCode = 1; });

module.exports = { SCHEMA, OUTPUT_PATH, EXPECTED, BindingError, loadInputs, buildSupplement, validateSupplement, publishNoReplaceAtomic, _test: { canonical, abiCommitment, assertAbi, assertSourceSemantics } };
