#!/usr/bin/env node
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const ARTIFACT = "reports/raw/fast/critical-raft-callback-cross-entry-step3-gate0.json";
const MANIFEST = "reports/raw/fast/critical-raft-callback-cross-entry-step3-gate0-manifest.json";
const REPORT = "reports/critical-raft-callback-cross-entry-step3-gate0.md";
const STEP2_CAPTURE = "reports/raw/fast/critical-raft-callback-cross-entry-step2-capture.json";
const STEP2_MANIFEST = "reports/raw/fast/critical-raft-callback-cross-entry-step2-manifest.json";
const STEP2_REPORT = "reports/critical-raft-callback-cross-entry-step2.md";
const REQUIRED_IDS = ["wcrETH", "R_CHai_PSM", "IRPM_token", "R_Minter"];
const CORRESPONDENCE = new Set(["exact", "qualified", "shape_only", "unknown", "absent"]);
const ZERO_BEHAVIOR = new Set(["observed", "skipped", "reverts", "unknown"]);
const STATUS_BLOCKED = "BLOCKED_RUNTIME_SOURCE_CONTINUITY";
const PM_ORDER = [
  ["public_managePosition", [["targets/raft/contracts/PositionManager.sol", 104, 167]]],
  ["debt_adjustment_and_mint", [["targets/raft/contracts/PositionManager.sol", 146, 146], ["targets/raft/contracts/PositionManager.sol", 517, 546]]],
  ["collateral_adjustment", [["targets/raft/contracts/PositionManager.sol", 147, 147], ["targets/raft/contracts/PositionManager.sol", 560, 582]]],
  ["redemption_fee_transfer", [["targets/raft/contracts/PositionManager.sol", 269, 270]]],
  ["r_burn", [["targets/raft/contracts/PositionManager.sol", 272, 273]]],
  ["caller_collateral_transfer", [["targets/raft/contracts/PositionManager.sol", 275, 276]]],
  ["final_index_writes", [["targets/raft/contracts/PositionManager.sol", 278, 280], ["targets/raft/contracts/PositionManager.sol", 589, 599]]]
];
const SOURCE_SNIPPETS = {
  "targets/raft/contracts/WrappedCollateralToken.sol:91-93": "super._transfer(from, to, amount);",
  "targets/raft/contracts/common/ERC20RMinter.sol:13-24": "abstract contract ERC20RMinter is IRMinter, ERC20, Ownable2Step",
  "targets/raft/contracts/common/ERC20RMinter.sol:38-68": "positionManager.managePosition(",
  "targets/raft/contracts/PSM/BasePSM.sol:47-75": "function buyR(uint256 reserveAmount, uint256 minReturn)",
  "targets/raft/contracts/PSM/ChaiPSM.sol:12-35": "contract ChaiPSM is BasePSM",
  "targets/raft/contracts/InterestRates/InterestRatePositionManager.sol:14-25": "contract InterestRatePositionManager is ERC20RMinter, PositionManager",
  "targets/raft/contracts/InterestRates/InterestRatePositionManager.sol:29-57": "return super.managePosition(",
  "targets/raft/contracts/PositionManager.sol:104-167": "function managePosition(",
  "targets/raft/contracts/PositionManager.sol:146-146": "_adjustDebt(",
  "targets/raft/contracts/PositionManager.sol:517-546": "raftDebtToken.mint(position, totalDebtChange);",
  "targets/raft/contracts/PositionManager.sol:147-147": "_adjustCollateral(",
  "targets/raft/contracts/PositionManager.sol:560-582": "collateralToken.safeTransfer(msg.sender, collateralChange);",
  "targets/raft/contracts/PositionManager.sol:269-270": "collateralToken.safeTransfer(feeRecipient, redemptionFee - rebate);",
  "targets/raft/contracts/PositionManager.sol:272-273": "_burnRTokens(msg.sender, debtAmount);",
  "targets/raft/contracts/PositionManager.sol:275-276": "collateralToken.safeTransfer(msg.sender, collateralToRedeem - redemptionFee);",
  "targets/raft/contracts/PositionManager.sol:278-280": "_updateDebtAndCollateralIndex(",
  "targets/raft/contracts/PositionManager.sol:589-599": "raftCollateralToken.setIndex(collateralToken.balanceOf(address(this)));",
  "targets/raft/contracts/PositionManager.sol:224-283": "function redeemCollateral("
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

function walkFiles(relative, suffix) {
  const absolute = path.join(ROOT, relative);
  if (!fs.existsSync(absolute)) return [];
  const rows = [];
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const child = path.posix.join(relative.replace(/\\/g, "/"), entry.name);
    if (entry.isDirectory()) rows.push(...walkFiles(child, suffix));
    else if (!suffix || entry.name.endsWith(suffix)) rows.push(child);
  }
  return rows.sort();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function evidenceKey(evidence) {
  return `${evidence.path}:${evidence.startLine}-${evidence.endLine}`;
}

function validateLineEvidence(evidence, sourceReader = read) {
  assert.strictEqual(typeof evidence.path, "string", "source evidence path missing");
  assert.ok(Number.isInteger(evidence.startLine) && Number.isInteger(evidence.endLine), "source line range non-integer");
  assert.ok(evidence.startLine > 0 && evidence.endLine >= evidence.startLine, "source line range invalid");
  const lines = sourceReader(evidence.path).split(/\r?\n/);
  assert.ok(evidence.endLine <= lines.length, `source line range exceeds file: ${evidence.path}`);
  const snippet = SOURCE_SNIPPETS[evidenceKey(evidence)];
  assert.ok(snippet, `unrecognized source claim: ${evidenceKey(evidence)}`);
  assert.ok(lines.slice(evidence.startLine - 1, evidence.endLine).join("\n").includes(snippet), `source claim mismatch: ${evidenceKey(evidence)}`);
}

function expectedCapturedRows(step2) {
  const state = step2.deployments.canonicalState;
  assert.ok(state && state.rootManager, "Step2 canonical state missing");
  const root = state.managers.find((manager) => manager.manager.toLowerCase() === state.rootManager.toLowerCase());
  assert.ok(root, "Step2 root manager row missing");
  const enabled = root.collateral.filter((row) => row.info.enabled);
  assert.strictEqual(enabled.length, 4, "Step2 enabled root row count changed");
  const byAddress = new Map(enabled.map((row) => [row.collateralToken.toLowerCase(), row]));
  const addresses = {
    wcrETH: "0xb69E35fB4A157028b92F42655090b984609Ae598",
    R_CHai_PSM: "0xa03342feB2e1D4690B60Ef556509ec3B76c97eE7",
    IRPM_token: "0x9AB6b21cDF116f611110b048987E58894786C244",
    R_Minter: "0xe899603576967180c7594bd5a1caD898A3E3dAf3"
  };
  return REQUIRED_IDS.map((id, index) => {
    const captured = byAddress.get(addresses[id].toLowerCase());
    assert.ok(captured, `Step2 required row missing: ${id}`);
    return {
      id,
      index: index + 1,
      address: captured.collateralToken,
      root: state.rootManager,
      claim: captured.info.collateralClaimToken,
      debt: captured.info.debtToken,
      enabled: captured.info.enabled,
      runtimeKeccak256: captured.runtime.runtimeKeccak256,
      codeSize: captured.runtime.codeSize,
      proxy: clone(captured.runtime.proxy)
    };
  });
}

function deriveStatus(artifact) {
  const exactRows = artifact.rows.filter((row) => row.correspondence === "exact");
  if (
    exactRows.length === artifact.rows.length
    && exactRows.every((row) => row.deployedTransfer.ordinaryCallbackFree === true && row.deployedTransfer.zeroCallbackFree === true)
  ) return "PASS_ALL_EXACT_CALLBACK_FREE_STOP";
  if (exactRows.some((row) => row.deployedTransfer.recipientCallback === true)) return "PASS_CALLBACK_COMPATIBLE_ADMIT";
  return STATUS_BLOCKED;
}

function rejectForbiddenKeys(value, keyPath = "") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const current = keyPath ? `${keyPath}.${key}` : key;
    assert.ok(!/selfSha256|artifactSha256|reportSha256/i.test(key), `circular self hash key forbidden: ${current}`);
    rejectForbiddenKeys(child, current);
  }
}

function validateCandidate(candidate, row, sourceReader) {
  assert.ok(CORRESPONDENCE.has(candidate.correspondence), "candidate correspondence enum invalid");
  assert.strictEqual(typeof candidate.sourcePath, "string", "candidate source path missing");
  sourceReader(candidate.sourcePath);
  assert.ok(Array.isArray(candidate.sourceEvidence) && candidate.sourceEvidence.length > 0, "candidate source evidence missing");
  candidate.sourceEvidence.forEach((evidence) => validateLineEvidence(evidence, sourceReader));
  assert.strictEqual(candidate.runtimeByteEquality, candidate.runtimeHashEquality, "runtime byte/hash equality observations disagree");
  const equality = candidate.runtimeByteEquality === true && candidate.runtimeHashEquality === true;
  assert.strictEqual(candidate.correspondence === "exact", equality, "exact correspondence requires byte and hash equality, and equality requires exact");
  if (candidate.correspondence === "exact") {
    assert.strictEqual(candidate.compiledRuntimeKeccak256, row.runtimeKeccak256, "exact candidate runtime hash differs");
    assert.strictEqual(candidate.compiledCodeSize, row.codeSize, "exact candidate runtime size differs");
    assert.ok(/^0x[0-9a-f]+$/.test(candidate.compiledRuntimeBytecode), "exact candidate bytecode missing");
  }
  const flow = candidate.controlFlow;
  assert.ok(flow && ["observed", "unknown"].includes(flow.ordinaryTransfer), "ordinary transfer status invalid");
  assert.ok(["observed", "unknown"].includes(flow.internalTransfer), "internal transfer status invalid");
  assert.ok(["observed", "unknown"].includes(flow.transferFrom), "transferFrom status invalid");
  assert.ok(["observed", "unknown"].includes(flow.hooks), "hook status invalid");
  assert.ok(["observed", "unknown"].includes(flow.recipientDependentExternalCalls), "recipient call status invalid");
  assert.ok(ZERO_BEHAVIOR.has(flow.zeroValueBehavior), "zero-value behavior must be explicit");
  assert.ok(Array.isArray(flow.evidence), "control-flow evidence missing");
  flow.evidence.forEach((evidence) => validateLineEvidence(evidence, sourceReader));
}

function validateArtifact(artifact, step2, sourceReader = read) {
  assert.strictEqual(artifact.schemaVersion, 1, "schema version mismatch");
  assert.strictEqual(artifact.findingId, "raft-callback-cross-entry-step3-gate0", "finding id mismatch");
  assert.strictEqual(artifact.status, STATUS_BLOCKED, "Gate0 status must remain blocked");
  assert.deepStrictEqual(artifact.rows.map((row) => row.id), REQUIRED_IDS, "exact four-row matrix mismatch");
  assert.strictEqual(artifact.rows.length, 4, "matrix must contain exactly four rows");
  assert.deepStrictEqual(artifact.pin, {
    chainId: 1,
    number: step2.pin.number,
    hash: step2.pin.hash,
    temporalScope: "historical-step2-pin-only",
    deploymentCurrentClaim: false
  }, "historical pin binding mismatch");

  const expected = expectedCapturedRows(step2);
  for (let index = 0; index < artifact.rows.length; index += 1) {
    const row = artifact.rows[index];
    const captured = expected[index];
    for (const key of ["id", "address", "root", "claim", "debt", "enabled", "runtimeKeccak256", "codeSize"]) {
      assert.strictEqual(row[key], captured[key], `capture mismatch for ${row.id}.${key}`);
    }
    assert.deepStrictEqual(row.proxy, captured.proxy, `capture mismatch for ${row.id}.proxy`);
    assert.deepStrictEqual(row.evidencePaths, [
      `${STEP2_CAPTURE}#/deployments/canonicalState/managers/0/collateral/${captured.index}`,
      STEP2_REPORT
    ], `evidence path mismatch for ${row.id}`);
    assert.ok(CORRESPONDENCE.has(row.correspondence), `row correspondence invalid: ${row.id}`);
    assert.ok(Array.isArray(row.candidates) && row.candidates.length > 0, `candidates absent: ${row.id}`);
    row.candidates.forEach((candidate) => validateCandidate(candidate, row, sourceReader));
    const hasExact = row.candidates.some((candidate) => candidate.correspondence === "exact");
    assert.strictEqual(row.correspondence === "exact", hasExact, `row exact promotion mismatch: ${row.id}`);
    assert.deepStrictEqual(row.deployedTransfer, {
      ordinaryCallbackFree: null,
      zeroCallbackFree: null,
      recipientCallback: null,
      conclusion: "unknown-runtime-source-continuity-not-exact"
    }, `deployed callback conclusion promoted: ${row.id}`);
    assert.strictEqual(row.standardCallbackIndicatorAbsenceIsCallbackFreeProof, false, "indicator absence promoted");
  }

  assert.deepStrictEqual(artifact.sourceInventory.discoveredConcreteCandidateSources, [
    "targets/raft/contracts/InterestRates/InterestRatePositionManager.sol",
    "targets/raft/contracts/PSM/ChaiPSM.sol",
    "targets/raft/contracts/WrappedCollateralToken.sol"
  ], "deterministic candidate source inventory mismatch");
  assert.deepStrictEqual(artifact.sourceInventory.discoveredAbstractCandidateSources, [
    "targets/raft/contracts/PSM/BasePSM.sol",
    "targets/raft/contracts/common/ERC20RMinter.sol"
  ], "deterministic abstract source inventory mismatch");
  assert.deepStrictEqual(artifact.sourceInventory.namedRMinterSources, [], "named R Minter source must remain absent");
  assert.deepStrictEqual(artifact.sourceInventory.candidateArtifactRoots, {
    "targets/raft/out": "absent",
    "targets/raft/artifacts": "absent",
    "targets/raft/build": "absent",
    "targets/raft/cache": "absent"
  }, "candidate artifact-root inventory mismatch");
  assert.deepStrictEqual(artifact.sourceInventory.candidateArtifacts, [], "unexpected candidate build artifact");
  if (sourceReader === read) {
    const solidity = walkFiles("targets/raft/contracts", ".sol");
    const concrete = solidity.filter((file) => /contract\s+(?:WrappedCollateralToken|ChaiPSM|InterestRatePositionManager)\b/.test(read(file))).sort();
    const abstractCandidates = solidity.filter((file) => /abstract contract\s+(?:BasePSM|ERC20RMinter)\b/.test(read(file))).sort();
    const namedRMinter = solidity.filter((file) => /R Minter/.test(read(file))).sort();
    assert.deepStrictEqual(concrete, artifact.sourceInventory.discoveredConcreteCandidateSources, "filesystem concrete candidate inventory changed");
    assert.deepStrictEqual(abstractCandidates, artifact.sourceInventory.discoveredAbstractCandidateSources, "filesystem abstract candidate inventory changed");
    assert.deepStrictEqual(namedRMinter, artifact.sourceInventory.namedRMinterSources, "filesystem named R Minter inventory changed");
    for (const root of Object.keys(artifact.sourceInventory.candidateArtifactRoots)) assert.strictEqual(fs.existsSync(path.join(ROOT, root)), false, `candidate artifact root unexpectedly exists: ${root}`);
    assert.deepStrictEqual(walkFiles("targets/raft/audit", ".json"), artifact.sourceInventory.excludedAuditJsonArtifacts, "excluded audit artifact inventory changed");
  }
  for (const binding of [...artifact.sourceInventory.sourceHashes, ...artifact.sourceInventory.buildConfig]) {
    if (sourceReader === read) assert.strictEqual(binding.sha256, sha256(binding.path), `local inventory hash mismatch: ${binding.path}`);
    else assert.match(binding.sha256, /^[0-9a-f]{64}$/, `local inventory hash malformed: ${binding.path}`);
  }
  assert.strictEqual(artifact.build.status, "BUILD_BLOCKED_OFFLINE", "offline build status mismatch");
  assert.strictEqual(artifact.build.fetchOrInitAllowed, false, "dependency fetch/init must be forbidden");
  assert.strictEqual(artifact.build.productionTreeMutationAllowed, false, "production mutation must be forbidden");

  assert.deepStrictEqual(artifact.positionManagerOrdering.map((row) => [
    row.id,
    row.evidence.map((item) => [item.path, item.startLine, item.endLine])
  ]), PM_ORDER, "PositionManager ordering mismatch");
  artifact.positionManagerOrdering.forEach((row) => row.evidence.forEach((item) => validateLineEvidence(item, sourceReader)));
  assert.deepStrictEqual(artifact.rMinterGate, {
    namedConcreteSourceEstablished: false,
    deterministicArtifactEstablished: false,
    deterministicRuntimeCorrespondenceEstablished: false,
    blocked: true
  }, "R Minter gate opened");
  assert.deepStrictEqual(artifact.witness, {
    kind: "caller-hook",
    acceptedValueNetRRaw: "6625188536953243065000",
    acceptedValueNetRDisplay: "6625.188536953243065000 R",
    scope: "source-local-only",
    feeRecipientWitnessExcluded: true,
    feeHookCollusionExcluded: true,
    evidence: "reports/raw/fast/critical-raft-collateral-redemption-conservation-step1.json:138-145"
  }, "caller-hook witness mismatch or fee-hook promotion");
  assert.deepStrictEqual(artifact.publicValuePath, {
    sourceLocalRAcquisition: "observed",
    sourceLocalRAcquisitionEvidence: [
      { path: "targets/raft/contracts/PositionManager.sol", startLine: 517, endLine: 546 },
      { path: "targets/raft/contracts/PSM/BasePSM.sol", startLine: 47, endLine: 75 }
    ],
    sourceLocalRedemption: "observed",
    sourceLocalRedemptionEvidence: [
      { path: "targets/raft/contracts/PositionManager.sol", startLine: 224, endLine: 283 }
    ],
    externalMarketExit: "unknown",
    currentCapacity: "unknown",
    realizableEconomics: "unknown",
    economicsAssessment: "UNASSESSED"
  }, "route/economics promotion detected");
  artifact.publicValuePath.sourceLocalRAcquisitionEvidence.forEach((item) => validateLineEvidence(item, sourceReader));
  artifact.publicValuePath.sourceLocalRedemptionEvidence.forEach((item) => validateLineEvidence(item, sourceReader));
  assert.deepStrictEqual(artifact.gates, {
    routePositive: "unknown",
    executableNow: "unknown",
    signedActionJustified: false,
    fork: false,
    economics: "UNASSESSED"
  }, "gate mismatch");
  assert.deepStrictEqual(artifact.prohibitedOperations, {
    networkAuthorized: false,
    protectedAccessAuthorized: false,
    dependencyDownloadAuthorized: false,
    forkPerformed: false,
    signingPerformed: false,
    transactionPerformed: false
  }, "prohibited-operation field mismatch");
  assert.strictEqual(deriveStatus(artifact), artifact.status, "status derivation mismatch");
  rejectForbiddenKeys(artifact);
  return true;
}

function validateManifest(manifest) {
  const expectedPaths = [
    "tools/validate-critical-raft-callback-step3-gate0.js",
    "tools/test-critical-raft-callback-step3-gate0.js",
    ARTIFACT,
    REPORT,
    STEP2_CAPTURE,
    STEP2_MANIFEST,
    STEP2_REPORT
  ];
  assert.deepStrictEqual(manifest.files.map((row) => row.path), expectedPaths, "manifest file set/order mismatch");
  assert.ok(!manifest.files.some((row) => row.path === MANIFEST), "manifest must not self-hash");
  for (const row of manifest.files) assert.strictEqual(sha256(row.path), row.sha256, `manifest hash mismatch: ${row.path}`);
  const preimage = manifest.files.map((row) => `${row.sha256}  ${row.path}`).join("\n") + "\n";
  const aggregate = crypto.createHash("sha256").update(preimage).digest("hex");
  assert.strictEqual(manifest.aggregatePreimageFormat, "<sha256><two spaces><path><LF>", "aggregate format mismatch");
  assert.strictEqual(manifest.aggregateSha256, aggregate, "manifest aggregate mismatch");
  return aggregate;
}

function assertImmutablePublication(existingFinalPaths) {
  assert.ok(Array.isArray(existingFinalPaths), "publication path set missing");
  assert.strictEqual(existingFinalPaths.length, 0, "immutable publication refuses replacement");
  return true;
}

function main() {
  if (process.argv.length !== 3 || process.argv[2] !== "--check-only") {
    console.error("usage: node tools/validate-critical-raft-callback-step3-gate0.js --check-only");
    process.exit(2);
  }
  const artifact = json(ARTIFACT);
  const step2 = json(STEP2_CAPTURE);
  const manifest = json(MANIFEST);
  validateArtifact(artifact, step2);
  const bindingMap = new Map(artifact.inputBindings.map((row) => [row.path, row.sha256]));
  for (const input of [STEP2_CAPTURE, STEP2_MANIFEST, STEP2_REPORT]) {
    assert.strictEqual(bindingMap.get(input), sha256(input), `immutable Step2 input binding mismatch: ${input}`);
  }
  const report = read(REPORT);
  assert.ok(report.includes(STATUS_BLOCKED), "report status missing");
  assert.ok(report.includes("6625.188536953243065000 R"), "report caller witness missing");
  assert.ok(report.includes("Standard callback-indicator absence is not callback-free proof"), "report indicator caveat missing");
  const generated = [read(ARTIFACT), read(MANIFEST), report, read(__filename.slice(ROOT.length + 1)), read("tools/test-critical-raft-callback-step3-gate0.js")];
  for (const text of generated) {
    assert.ok(!/https?:\/\//i.test(text), "URL material retained");
    assert.ok(!/Bearer\s/i.test(text), "protected header material retained");
    assert.ok(text.endsWith("\n"), "final newline missing");
    assert.ok(!/[ \t]+$/m.test(text), "trailing whitespace present");
  }
  const aggregate = validateManifest(manifest);
  console.log(`PASS Raft Step3 Gate0 validation; status=${artifact.status}; rows=4; aggregate=${aggregate}`);
}

module.exports = {
  REQUIRED_IDS,
  STATUS_BLOCKED,
  assertImmutablePublication,
  clone,
  deriveStatus,
  validateArtifact,
  validateLineEvidence,
  validateManifest
};

if (require.main === module) main();
