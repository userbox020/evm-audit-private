#!/usr/bin/env node
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const FINDING_ID = "raft-callback-cross-entry-step3-gate0-r2";
const STATUS = "BLOCKED_RUNTIME_SOURCE_CONTINUITY";
const ARTIFACT = "reports/raw/fast/critical-raft-callback-cross-entry-step3-gate0-r2.json";
const MANIFEST = "reports/raw/fast/critical-raft-callback-cross-entry-step3-gate0-r2-manifest.json";
const REPORT = "reports/critical-raft-callback-cross-entry-step3-gate0-r2.md";
const PIN = {
  chainId: 1,
  number: "25642210",
  hash: "0xd179b59abdc15cc674715c04a146b23e2fe1991ca11ecd791d1e9b9dbfee3554",
  temporalScope: "historical-step2-pin-only",
  deploymentCurrentClaim: false
};
const INPUT_BINDINGS = [
  ["reports/raw/fast/critical-raft-callback-cross-entry-step2-capture.json", "aa8614af1b3d2dfbea74abd46801a1697fa84603a8b1d88dbb2e8c7422e8c761"],
  ["reports/raw/fast/critical-raft-callback-cross-entry-step2-manifest.json", "8b2ee5a5062c928201f86494a790c855bbf69ec7d06caf90eee8df96a6b80c57"],
  ["reports/critical-raft-callback-cross-entry-step2.md", "a054c3320dbaa469ad466aba6076d44a5a79cd6b722127dd86bf81ee5d00166c"],
  ["reports/critical-raft-collateral-redemption-conservation-step1.md", "be392c8213a187ffea890cb15eb53490a36959f80439fa02192c5d9909248571"]
];
const PREDECESSOR_BINDINGS = [
  ["tools/validate-critical-raft-callback-step3-gate0.js", "e936c98de7b88422f0c40ea38195dfaaf69ee6fa8540d8b6a6230d5e1f8d13e8"],
  ["tools/test-critical-raft-callback-step3-gate0.js", "9a436a0a441546d9ad18909b86917f8e4de44bed8538c22002cce76da9148c00"],
  ["reports/raw/fast/critical-raft-callback-cross-entry-step3-gate0.json", "0604728e5e9a349693e320a01065ffeaca8010813ac44aed11ebfb0edea67de3"],
  ["reports/raw/fast/critical-raft-callback-cross-entry-step3-gate0-manifest.json", "382938861c3373a8e47b642c5fe0957cdc1ee4eca2d6b0b45a14363aacb70ec7"],
  ["reports/critical-raft-callback-cross-entry-step3-gate0.md", "564015e1921f2a5beb09749f4380f4a05f608933e5e8451c836a22aa07897046"]
];
const SOURCE_HASHES = [
  ["targets/raft/contracts/WrappedCollateralToken.sol", "4f500ff6f9636f3a8f6c22c78bf3b1a65177e1677da8bf3ec7da29fb9d5f4b06"],
  ["targets/raft/contracts/common/ERC20RMinter.sol", "6c8825c261b680314d09aad2810514c797851a5f7b61ae9161abe3132254ce3a"],
  ["targets/raft/contracts/PSM/BasePSM.sol", "c52e5e01722ceef8d67bac2996e0924b64291b70c32a73ea47ce20c82600ee89"],
  ["targets/raft/contracts/PSM/ChaiPSM.sol", "285a3db2706096eac9c23de6b788da1733d082db94b7186e21343f1b36518a9e"],
  ["targets/raft/contracts/InterestRates/InterestRatePositionManager.sol", "13a689397be201247109b447561f4c4b18fc0f4b8fa01976212655638edd80b6"],
  ["targets/raft/contracts/PositionManager.sol", "d5699247fac89f0ac1b30e6410f46ae96b3ee76dcada9c2c6e9f0f234225dd68"]
];
const BUILD_CONFIG = [
  ["targets/raft/foundry.toml", "1e97df84833096cecc4bc588fee7c2dbc8404a3bb30007814c7c8d52234b0884"],
  ["targets/raft/remappings.txt", "dd2b51fab9feb477b3593570d16cef80274ef0738c91a78c779b59f3dbbd7278"],
  ["targets/raft/package.json", "5824fc7e194fbde394d215141ad5ab3e7ef5cee2b275ae71f16cc66c77c378d7"],
  ["targets/raft/yarn.lock", "5a9da59f39345fae7cef1a5e32d8428df8a7e8753ccc57f085e20b934234ec26"],
  ["targets/raft/.gitmodules", "83b45aac718701f6393f40d846beccf2775707cd4ebf752e413fd5cd76f95d7e"]
];
const SOURCE_SNIPPETS = {
  "targets/raft/contracts/WrappedCollateralToken.sol:91-93": "super._transfer(from, to, amount);",
  "targets/raft/contracts/PSM/ChaiPSM.sol:12-35": "contract ChaiPSM is BasePSM",
  "targets/raft/contracts/InterestRates/InterestRatePositionManager.sol:14-25": "contract InterestRatePositionManager is ERC20RMinter, PositionManager",
  "targets/raft/contracts/common/ERC20RMinter.sol:13-24": "abstract contract ERC20RMinter is IRMinter, ERC20, Ownable2Step",
  "targets/raft/contracts/PositionManager.sol:146-146": "_adjustDebt(",
  "targets/raft/contracts/PositionManager.sol:517-546": "raftDebtToken.mint(position, totalDebtChange);",
  "targets/raft/contracts/PositionManager.sol:147-147": "_adjustCollateral(",
  "targets/raft/contracts/PositionManager.sol:560-582": "collateralToken.safeTransfer(msg.sender, collateralChange);",
  "targets/raft/contracts/PositionManager.sol:269-270": "collateralToken.safeTransfer(feeRecipient, redemptionFee - rebate);",
  "targets/raft/contracts/PositionManager.sol:272-273": "_burnRTokens(msg.sender, debtAmount);",
  "targets/raft/contracts/PositionManager.sol:275-276": "collateralToken.safeTransfer(msg.sender, collateralToRedeem - redemptionFee);",
  "targets/raft/contracts/PositionManager.sol:278-280": "_updateDebtAndCollateralIndex(",
  "targets/raft/contracts/PositionManager.sol:589-599": "raftCollateralToken.setIndex(collateralToken.balanceOf(address(this)));"
};
const EXPECTED_ROWS = [
  {
    id: "wcrETH",
    address: "0xb69E35fB4A157028b92F42655090b984609Ae598",
    root: "0x5F59b322eB3e16A0C78846195af1F588b77403FC",
    claim: "0xc38a040faC5769bDed5dDa8Dea1aef609e755363",
    debt: "0xF22Cd22B5Cf439825C6B75c816A4daf8fB44375B",
    enabled: true,
    runtimeKeccak256: "0xeb65eb794bc93391d277ab1111b3cb0a388e8f31376ffa686f79b6e1cf96a9aa",
    codeSize: 10482,
    proxy: { implementation: null, admin: null, beacon: null, beaconImplementation: null },
    captureEvidence: "reports/raw/fast/critical-raft-callback-cross-entry-step2-capture.json#/deployments/canonicalState/managers/0/collateral/1",
    identityBasis: "enumerated-local-contract-shape-only/no-runtime-identity-inference",
    correspondence: "shape_only",
    candidate: {
      contract: "WrappedCollateralToken",
      sourcePath: "targets/raft/contracts/WrappedCollateralToken.sol",
      sourceEvidence: [{ path: "targets/raft/contracts/WrappedCollateralToken.sol", startLine: 91, endLine: 93 }],
      compiledRuntimeBytecode: null,
      compiledRuntimeKeccak256: null,
      compiledCodeSize: null,
      runtimeByteEquality: null,
      runtimeHashEquality: null,
      correspondence: "shape_only",
      controlFlow: {
        ordinaryTransfer: "unknown",
        internalTransfer: "unknown",
        transferFrom: "unknown",
        hooks: "unknown",
        recipientDependentExternalCalls: "unknown",
        zeroValueBehavior: "unknown"
      }
    },
    deployedBehavior: { ordinaryTransfer: "unknown", hooks: "unknown", recipientDependentExternalCalls: "unknown", zeroValueBehavior: "unknown" },
    standardCallbackIndicatorAbsenceIsCallbackFreeProof: false
  },
  {
    id: "R_CHai_PSM",
    address: "0xa03342feB2e1D4690B60Ef556509ec3B76c97eE7",
    root: "0x5F59b322eB3e16A0C78846195af1F588b77403FC",
    claim: "0xd51D6A3b551f1150c69C4aaD46049c9bACc84A21",
    debt: "0xb2aC17ad1cdBa3702f726782f5d4F75d883e0071",
    enabled: true,
    runtimeKeccak256: "0x4b3f2a152f2ec059d26472051f3259176a1be6e12d3c100bd9b942849becb3e9",
    codeSize: 9685,
    proxy: { implementation: null, admin: null, beacon: null, beaconImplementation: null },
    captureEvidence: "reports/raw/fast/critical-raft-callback-cross-entry-step2-capture.json#/deployments/canonicalState/managers/0/collateral/2",
    identityBasis: "enumerated-local-contract-shape-only/no-name-or-runtime-identity-inference",
    correspondence: "shape_only",
    candidate: {
      contract: "ChaiPSM",
      sourcePath: "targets/raft/contracts/PSM/ChaiPSM.sol",
      sourceEvidence: [{ path: "targets/raft/contracts/PSM/ChaiPSM.sol", startLine: 12, endLine: 35 }],
      compiledRuntimeBytecode: null,
      compiledRuntimeKeccak256: null,
      compiledCodeSize: null,
      runtimeByteEquality: null,
      runtimeHashEquality: null,
      correspondence: "shape_only",
      controlFlow: {
        ordinaryTransfer: "unknown",
        internalTransfer: "unknown",
        transferFrom: "unknown",
        hooks: "unknown",
        recipientDependentExternalCalls: "unknown",
        zeroValueBehavior: "unknown"
      }
    },
    deployedBehavior: { ordinaryTransfer: "unknown", hooks: "unknown", recipientDependentExternalCalls: "unknown", zeroValueBehavior: "unknown" },
    standardCallbackIndicatorAbsenceIsCallbackFreeProof: false
  },
  {
    id: "IRPM_token",
    address: "0x9AB6b21cDF116f611110b048987E58894786C244",
    root: "0x5F59b322eB3e16A0C78846195af1F588b77403FC",
    claim: "0x6C6492779Dcdd070F7a5C3D246af4794eA102F59",
    debt: "0x508d93785d4CE31a0F6Ff257Df53C9a6C3b79f39",
    enabled: true,
    runtimeKeccak256: "0x6cb99346de6e61fd74d21a40459ce84a5c45a564d72ca9bc82aef096332f6ba3",
    codeSize: 22615,
    proxy: { implementation: null, admin: null, beacon: null, beaconImplementation: null },
    captureEvidence: "reports/raw/fast/critical-raft-callback-cross-entry-step2-capture.json#/deployments/canonicalState/managers/0/collateral/3",
    identityBasis: "enumerated-local-contract-shape-only/no-getter-or-runtime-identity-inference",
    correspondence: "shape_only",
    candidate: {
      contract: "InterestRatePositionManager",
      sourcePath: "targets/raft/contracts/InterestRates/InterestRatePositionManager.sol",
      sourceEvidence: [{ path: "targets/raft/contracts/InterestRates/InterestRatePositionManager.sol", startLine: 14, endLine: 25 }],
      compiledRuntimeBytecode: null,
      compiledRuntimeKeccak256: null,
      compiledCodeSize: null,
      runtimeByteEquality: null,
      runtimeHashEquality: null,
      correspondence: "shape_only",
      controlFlow: {
        ordinaryTransfer: "unknown",
        internalTransfer: "unknown",
        transferFrom: "unknown",
        hooks: "unknown",
        recipientDependentExternalCalls: "unknown",
        zeroValueBehavior: "unknown"
      }
    },
    deployedBehavior: { ordinaryTransfer: "unknown", hooks: "unknown", recipientDependentExternalCalls: "unknown", zeroValueBehavior: "unknown" },
    standardCallbackIndicatorAbsenceIsCallbackFreeProof: false
  },
  {
    id: "R_Minter",
    address: "0xe899603576967180c7594bd5a1caD898A3E3dAf3",
    root: "0x5F59b322eB3e16A0C78846195af1F588b77403FC",
    claim: "0x72e692A3D7b8A653DaCcBedD85917D5182FedB88",
    debt: "0xAEe0Ef7a8559c401Ac827c5f5Cb9Bc483149dDE8",
    enabled: true,
    runtimeKeccak256: "0xc7b842fcac28b93c3f2ce94375a37812b9a5ae9f98a724f41cbf40cf24912669",
    codeSize: 7930,
    proxy: { implementation: null, admin: null, beacon: null, beaconImplementation: null },
    captureEvidence: "reports/raw/fast/critical-raft-callback-cross-entry-step2-capture.json#/deployments/canonicalState/managers/0/collateral/4",
    identityBasis: "abstract-generic-source-only/no-named-concrete-source-or-runtime-identity",
    correspondence: "unknown",
    candidate: {
      contract: "ERC20RMinter",
      sourcePath: "targets/raft/contracts/common/ERC20RMinter.sol",
      sourceEvidence: [{ path: "targets/raft/contracts/common/ERC20RMinter.sol", startLine: 13, endLine: 24 }],
      compiledRuntimeBytecode: null,
      compiledRuntimeKeccak256: null,
      compiledCodeSize: null,
      runtimeByteEquality: null,
      runtimeHashEquality: null,
      correspondence: "unknown",
      controlFlow: {
        ordinaryTransfer: "unknown",
        internalTransfer: "unknown",
        transferFrom: "unknown",
        hooks: "unknown",
        recipientDependentExternalCalls: "unknown",
        zeroValueBehavior: "unknown"
      }
    },
    deployedBehavior: { ordinaryTransfer: "unknown", hooks: "unknown", recipientDependentExternalCalls: "unknown", zeroValueBehavior: "unknown" },
    standardCallbackIndicatorAbsenceIsCallbackFreeProof: false
  }
];
const MANAGE_ORDER = {
  scope: "managePosition-only",
  debtAdjustmentBeforeCollateralAdjustment: true,
  debtAdjustment: [
    { path: "targets/raft/contracts/PositionManager.sol", startLine: 146, endLine: 146 },
    { path: "targets/raft/contracts/PositionManager.sol", startLine: 517, endLine: 546 }
  ],
  collateralAdjustment: [
    { path: "targets/raft/contracts/PositionManager.sol", startLine: 147, endLine: 147 },
    { path: "targets/raft/contracts/PositionManager.sol", startLine: 560, endLine: 582 }
  ]
};
const REDEEM_ORDER = {
  scope: "redeemCollateral-only",
  orderedStages: [
    { id: "fee_transfer", evidence: [{ path: "targets/raft/contracts/PositionManager.sol", startLine: 269, endLine: 270 }] },
    { id: "r_burn", evidence: [{ path: "targets/raft/contracts/PositionManager.sol", startLine: 272, endLine: 273 }] },
    { id: "caller_transfer", evidence: [{ path: "targets/raft/contracts/PositionManager.sol", startLine: 275, endLine: 276 }] },
    { id: "index_writes", evidence: [
      { path: "targets/raft/contracts/PositionManager.sol", startLine: 278, endLine: 280 },
      { path: "targets/raft/contracts/PositionManager.sol", startLine: 589, endLine: 599 }
    ] }
  ]
};

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

function json(relative) {
  return JSON.parse(read(relative));
}

function sha256(relative) {
  return crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, relative))).digest("hex");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function objects(rows) {
  return rows.map(([filePath, hash]) => ({ path: filePath, sha256: hash }));
}

function assertExactBindings(actual, expected, label, verifyFiles = true) {
  assert.deepStrictEqual(actual, objects(expected), `${label} set/order mismatch`);
  assert.strictEqual(new Set(actual.map((row) => row.path)).size, actual.length, `${label} duplicate path`);
  if (verifyFiles) for (const row of actual) assert.strictEqual(sha256(row.path), row.sha256, `${label} hash mismatch: ${row.path}`);
}

function validateLineEvidence(evidence) {
  const key = `${evidence.path}:${evidence.startLine}-${evidence.endLine}`;
  assert.ok(SOURCE_SNIPPETS[key], `unrecognized source evidence: ${key}`);
  const lines = read(evidence.path).split(/\r?\n/);
  assert.ok(evidence.startLine > 0 && evidence.endLine >= evidence.startLine && evidence.endLine <= lines.length, `invalid source range: ${key}`);
  assert.ok(lines.slice(evidence.startLine - 1, evidence.endLine).join("\n").includes(SOURCE_SNIPPETS[key]), `source evidence mismatch: ${key}`);
}

function expectedCaptureRows(step2) {
  const state = step2.deployments.canonicalState;
  const root = state.managers.find((row) => row.manager.toLowerCase() === state.rootManager.toLowerCase());
  assert.ok(root, "Step2 root manager missing");
  const enabled = root.collateral.filter((row) => row.info.enabled);
  assert.strictEqual(enabled.length, 4, "Step2 exact enabled set changed");
  return enabled.map((row) => ({
    address: row.collateralToken,
    root: state.rootManager,
    claim: row.info.collateralClaimToken,
    debt: row.info.debtToken,
    enabled: row.info.enabled,
    runtimeKeccak256: row.runtime.runtimeKeccak256,
    codeSize: row.runtime.codeSize,
    proxy: row.runtime.proxy
  }));
}

function deriveStatus(rows, rMinterGate) {
  if (rMinterGate && rMinterGate.blocked === true) return STATUS;
  if (rows.length > 0 && rows.every((row) => row.correspondence === "exact" && row.ordinaryCallbackFree === true && row.zeroCallbackFree === true)) {
    return "PASS_ALL_EXACT_CALLBACK_FREE_STOP";
  }
  if (rows.some((row) => row.correspondence === "exact" && row.recipientCallback === true)) return "PASS_CALLBACK_COMPATIBLE_ADMIT";
  return STATUS;
}

function validateArtifact(artifact, step2 = json(INPUT_BINDINGS[0][0])) {
  assert.strictEqual(artifact.schemaVersion, 2, "artifact schema mismatch");
  assert.strictEqual(artifact.findingId, FINDING_ID, "artifact finding ID mismatch");
  assert.strictEqual(artifact.revision, "gate0-r2-oracle-corrective", "artifact revision mismatch");
  assert.strictEqual(artifact.publication, "immutable-no-replace", "artifact publication mismatch");
  assert.strictEqual(artifact.status, STATUS, "artifact status mismatch");
  assert.deepStrictEqual(artifact.pin, PIN, "artifact pin mismatch");
  assertExactBindings(artifact.inputBindings, INPUT_BINDINGS, "input bindings");
  assert.deepStrictEqual(artifact.predecessor, {
    findingId: "raft-callback-cross-entry-step3-gate0",
    status: STATUS,
    relationship: "historical-blocked-predecessor/no-byte-replacement",
    files: objects(PREDECESSOR_BINDINGS)
  }, "predecessor metadata mismatch");
  assertExactBindings(artifact.predecessor.files, PREDECESSOR_BINDINGS, "predecessor bindings");
  assertExactBindings(artifact.sourceHashes, SOURCE_HASHES, "source hashes");
  assertExactBindings(artifact.buildConfig, BUILD_CONFIG, "build config");
  assert.deepStrictEqual(artifact.rows, EXPECTED_ROWS, "exact four row/candidate tuples changed");
  assert.strictEqual(new Set(artifact.rows.map((row) => row.id)).size, 4, "duplicate row ID");
  assert.strictEqual(new Set(artifact.rows.map((row) => `${row.candidate.contract}:${row.candidate.sourcePath}`)).size, 4, "duplicate candidate tuple");
  const captured = expectedCaptureRows(step2);
  for (let index = 0; index < artifact.rows.length; index += 1) {
    const row = artifact.rows[index];
    for (const key of ["address", "root", "claim", "debt", "enabled", "runtimeKeccak256", "codeSize"]) {
      assert.strictEqual(row[key], captured[index][key], `Step2 capture mismatch: ${row.id}.${key}`);
    }
    assert.deepStrictEqual(row.proxy, captured[index].proxy, `Step2 proxy mismatch: ${row.id}`);
    assert.notStrictEqual(row.correspondence, "exact", `exact row forbidden in immutable blocked package: ${row.id}`);
    assert.notStrictEqual(row.candidate.correspondence, "exact", `exact candidate forbidden: ${row.id}`);
    for (const field of ["compiledRuntimeBytecode", "compiledRuntimeKeccak256", "compiledCodeSize", "runtimeByteEquality", "runtimeHashEquality"]) {
      assert.strictEqual(row.candidate[field], null, `compiled/equality claim forbidden: ${row.id}.${field}`);
    }
    assert.deepStrictEqual(row.candidate.controlFlow, {
      ordinaryTransfer: "unknown",
      internalTransfer: "unknown",
      transferFrom: "unknown",
      hooks: "unknown",
      recipientDependentExternalCalls: "unknown",
      zeroValueBehavior: "unknown"
    }, `source candidate control flow promoted: ${row.id}`);
    assert.deepStrictEqual(row.deployedBehavior, {
      ordinaryTransfer: "unknown",
      hooks: "unknown",
      recipientDependentExternalCalls: "unknown",
      zeroValueBehavior: "unknown"
    }, `deployed behavior promoted: ${row.id}`);
    row.candidate.sourceEvidence.forEach(validateLineEvidence);
  }
  assert.deepStrictEqual(artifact.positionManager.managePosition, MANAGE_ORDER, "managePosition ordering mismatch");
  assert.deepStrictEqual(artifact.positionManager.redemption, REDEEM_ORDER, "redemption ordering mismatch");
  [...MANAGE_ORDER.debtAdjustment, ...MANAGE_ORDER.collateralAdjustment].forEach(validateLineEvidence);
  REDEEM_ORDER.orderedStages.flatMap((stage) => stage.evidence).forEach(validateLineEvidence);
  assert.deepStrictEqual(artifact.rMinterGate, {
    blocked: true,
    precedence: "forces-BLOCKED_RUNTIME_SOURCE_CONTINUITY-before-other-row-status",
    namedConcreteSourceEstablished: false,
    deterministicArtifactEstablished: false,
    deterministicRuntimeCorrespondenceEstablished: false
  }, "R Minter blocking gate mismatch");
  assert.strictEqual(deriveStatus([], artifact.rMinterGate), STATUS, "R Minter precedence not applied");
  assert.deepStrictEqual(artifact.buildProvenance, {
    analysisMode: "local/offline-intended-with-unauthorized-failed-network-attempt",
    offlineFlagRequested: true,
    foundryAutomaticSubmoduleInitializationAttempted: true,
    publicRemoteTransportAttempted: true,
    networkAuthorized: false,
    networkAttempted: true,
    dependencyDownloadAuthorized: false,
    attemptFailed: true,
    retries: 0,
    compiledCandidateProduced: false,
    changesRestored: true,
    finalTargetStatus: ["?? audit/"],
    finalTargetStatusBasis: "pre-existing-untracked-audit-tree-only",
    transcriptBound: false,
    durableTranscript: null
  }, "build provenance mismatch");
  assert.deepStrictEqual(artifact.gates, {
    routePositive: "unknown",
    executableNow: "unknown",
    signedActionJustified: false,
    fork: false,
    economics: "UNASSESSED"
  }, "gate promotion detected");
  assert.deepStrictEqual(artifact.conclusion, {
    exactRows: 0,
    runtimeMismatchClaim: false,
    routeNegativeClaim: false,
    disposition: "CLOSE_ROTATE",
    reviewerApprovalRequired: true,
    substantiveLocalContinuityStepJustified: false,
    blockers: [
      "pinned-Tempus-dependency-unavailable",
      "named-concrete-R-Minter-source-and-artifact-unavailable"
    ]
  }, "conclusion/disposition mismatch");
  assert.strictEqual(deriveStatus(artifact.rows, artifact.rMinterGate), artifact.status, "derived artifact status mismatch");
  return true;
}

function expectedManifestPaths() {
  return [
    "tools/validate-critical-raft-callback-step3-gate0-r2.js",
    "tools/test-critical-raft-callback-step3-gate0-r2.js",
    ARTIFACT,
    REPORT,
    ...INPUT_BINDINGS.map(([filePath]) => filePath),
    ...PREDECESSOR_BINDINGS.map(([filePath]) => filePath)
  ];
}

function validateManifest(manifest, artifact = json(ARTIFACT)) {
  assert.strictEqual(manifest.schemaVersion, 2, "manifest schema mismatch");
  assert.strictEqual(manifest.findingId, FINDING_ID, "manifest finding ID mismatch");
  assert.strictEqual(manifest.publication, "immutable-no-replace", "manifest publication mismatch");
  assert.deepStrictEqual(manifest.pin, artifact.pin, "manifest/artifact pin mismatch");
  assert.deepStrictEqual(manifest.artifactMetadata, {
    findingId: artifact.findingId,
    revision: artifact.revision,
    status: artifact.status,
    rowCount: artifact.rows.length,
    exactRows: artifact.conclusion.exactRows,
    predecessorFindingId: artifact.predecessor.findingId
  }, "manifest/artifact metadata mismatch");
  assert.deepStrictEqual(manifest.reportBinding, {
    path: REPORT,
    sha256: sha256(REPORT)
  }, "manifest report binding mismatch");
  assert.deepStrictEqual(manifest.files.map((row) => row.path), expectedManifestPaths(), "manifest file set/order mismatch");
  assert.strictEqual(new Set(manifest.files.map((row) => row.path)).size, manifest.files.length, "manifest duplicate path");
  assert.ok(!manifest.files.some((row) => row.path === MANIFEST), "manifest self-hash forbidden");
  for (const row of manifest.files) assert.strictEqual(sha256(row.path), row.sha256, `manifest hash mismatch: ${row.path}`);
  const preimage = manifest.files.map((row) => `${row.sha256}  ${row.path}`).join("\n") + "\n";
  const aggregate = crypto.createHash("sha256").update(preimage).digest("hex");
  assert.strictEqual(manifest.aggregatePreimageFormat, "<sha256><two spaces><path><LF>", "manifest aggregate format mismatch");
  assert.strictEqual(manifest.aggregateSha256, aggregate, "manifest aggregate mismatch");
  return aggregate;
}

function assertImmutablePublication(existingFinalPaths) {
  assert.deepStrictEqual(existingFinalPaths, [], "immutable publication refuses replacement");
  return true;
}

function main() {
  if (process.argv.length !== 3 || process.argv[2] !== "--check-only") {
    console.error("usage: node tools/validate-critical-raft-callback-step3-gate0-r2.js --check-only");
    process.exit(2);
  }
  const artifact = json(ARTIFACT);
  validateArtifact(artifact);
  const aggregate = validateManifest(json(MANIFEST), artifact);
  const report = read(REPORT);
  for (const phrase of [
    STATUS,
    "0/4 exact",
    "networkAuthorized=false",
    "networkAttempted=true",
    "CLOSE_ROTATE",
    "No runtime mismatch or route-negative conclusion is made"
  ]) assert.ok(report.includes(phrase), `report phrase missing: ${phrase}`);
  for (const filePath of [ARTIFACT, MANIFEST, REPORT, "tools/validate-critical-raft-callback-step3-gate0-r2.js", "tools/test-critical-raft-callback-step3-gate0-r2.js"]) {
    const text = read(filePath);
    assert.ok(text.endsWith("\n"), `final newline missing: ${filePath}`);
    assert.ok(!/[ \t]+$/m.test(text), `trailing whitespace: ${filePath}`);
    assert.ok(!/Bearer\s/i.test(text), `protected header retained: ${filePath}`);
  }
  console.log(`PASS Raft Gate0-R2 validation; status=${artifact.status}; exact=0/4; aggregate=${aggregate}`);
}

module.exports = {
  ARTIFACT,
  FINDING_ID,
  MANIFEST,
  STATUS,
  assertImmutablePublication,
  clone,
  deriveStatus,
  validateArtifact,
  validateManifest
};

if (require.main === module) main();
