#!/usr/bin/env node
"use strict";

// Authorized defensive Step 3. Local compilation and mocked state transitions only.
// No RPC, fork, endpoint inventory, signing file, broadcast, or real funds.

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { getAddress, keccak256 } = require("ethers");

const ROOT = path.resolve(__dirname, "..");
const TARGET = path.join(ROOT, "targets", "cash-v3");
const SCANNER = "tools/scan-critical-etherfi-stargate-valid-auth-tuple-invariant.js";
const VALIDATOR = "tools/test-critical-etherfi-stargate-valid-auth-tuple-invariant.js";
const SOL_TEST = "targets/cash-v3/test/critical/EtherFiStargateValidAuthTupleInvariant.t.sol";
const RAW = "reports/raw/fast/critical-etherfi-stargate-valid-auth-tuple-invariant.json";
const MANIFEST = "reports/raw/fast/critical-etherfi-stargate-valid-auth-tuple-invariant-manifest.json";
const REPORT = "reports/critical-etherfi-stargate-valid-auth-tuple-invariant.md";
const INBOX = "coordination/inbox/critical/2026-07-22-critical-etherfi-stargate-valid-auth-tuple-invariant.json";
const HANDOFF = "coordination/handoffs/2026-07-22-critical-etherfi-stargate-valid-auth-tuple-invariant-handoff.md";
const STEP1 = "reports/raw/fast/critical-etherfi-pinbound-build-binding.json";
const STEP2 = "reports/raw/fast/critical-etherfi-pending-withdrawal-tuple.json";
const CAPABILITY = "reports/raw/fast/critical-etherfi-default-module-capability.json";
const REVISION = "stargate-valid-auth-tuple-invariant-step3-r1";
const AGENT = "critical-etherfi-step3-stargate-invariant-20260722";
const SOURCE_COMMIT = "e05bda2be27a6a606f3f1b8ff0d0791032fd0ff8";
const FUZZ_RUNS = 256;
const FUZZ_SEED = "0x53544550335f53544152474154455f415554485f5455504c455f323032363037";
const PIN = { chainId: 10, blockNumber: 154534581, blockHash: "0x9e2d47b4f179b068df84fe73f11601cfa0af372d769902848222dc3a6e3c8b13" };
const ADDR = { dataProvider: "0xDC515Cb479a64552c5A11a57109C314E40A1A778", cashModule: "0x7Ca0b75E67E33c0014325B739A8d019C4FE445F0", stargateModule: "0xee77DEB6991f5d5CcAE5a327debA32d292E85c1c" };
const SOURCE_FILES = [
  "targets/cash-v3/src/modules/stargate/StargateModule.sol",
  "targets/cash-v3/src/modules/ModuleBase.sol",
  "targets/cash-v3/src/modules/ModuleCheckBalance.sol",
  "targets/cash-v3/src/modules/cash/CashModuleSetters.sol",
  "targets/cash-v3/src/modules/cash/CashModuleStorageContract.sol",
  "targets/cash-v3/src/safe/EtherFiSafe.sol",
  "targets/cash-v3/src/safe/EtherFiSafeBase.sol",
  "targets/cash-v3/src/safe/MultiSig.sol",
  "targets/cash-v3/src/interfaces/IEtherFiSafe.sol",
  "targets/cash-v3/src/interfaces/ICashModule.sol",
];

function abs(rel) { return path.join(ROOT, rel); }
function sha(data) { return crypto.createHash("sha256").update(data).digest("hex"); }
function canonical(v) { if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`; if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`; return JSON.stringify(v); }
function hashFile(rel) { const data = fs.readFileSync(abs(rel)); return { path: rel, bytes: data.length, sha256: sha(data) }; }
function writeOwned(rel, content) { if (![RAW, MANIFEST, REPORT, INBOX, HANDOFF].includes(rel)) throw new Error(`write refused: ${rel}`); fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), content, "utf8"); }
function walkFiles(dir, predicate, out = []) { if (!fs.existsSync(dir)) return out; for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) walkFiles(full, predicate, out); else if (predicate(full)) out.push(full); } return out; }
function strip0x(v) { return String(v || "").replace(/^0x/i, ""); }
function addressWord(address) { return Buffer.from(`${"0".repeat(24)}${strip0x(getAddress(address)).toLowerCase()}`, "hex"); }

function collectImmutableNames(buildInfo) {
  const names = new Map();
  function walk(node, sourcePath) { if (!node || typeof node !== "object") return; if (node.nodeType === "VariableDeclaration" && node.mutability === "immutable") names.set(String(node.id), { name: node.name, sourcePath }); for (const value of Object.values(node)) { if (Array.isArray(value)) value.forEach((x) => walk(x, sourcePath)); else if (value && typeof value === "object") walk(value, sourcePath); } }
  for (const [sourcePath, row] of Object.entries(buildInfo.output?.sources || {})) walk(row.ast, sourcePath);
  return names;
}

function reconstructRuntime(artifact, immutableNames, bindings) {
  const runtime = Buffer.from(strip0x(artifact.deployedBytecode.object), "hex");
  const rows = [];
  for (const [astId, positions] of Object.entries(artifact.deployedBytecode.immutableReferences || {})) {
    const declaration = immutableNames.get(String(astId));
    const expected = bindings[declaration?.name];
    if (!declaration || !expected) throw new Error(`unbound immutable ${astId}:${declaration?.name || "unknown"}`);
    const word = addressWord(expected);
    for (const position of positions) { if (Number(position.length) !== 32) throw new Error("non-address immutable"); word.copy(runtime, Number(position.start)); }
    rows.push({ astId, declarationName: declaration.name, sourcePath: declaration.sourcePath, expectedValue: getAddress(expected), positions: positions.map((x) => ({ start: Number(x.start), length: Number(x.length) })) });
  }
  return { bytes: runtime.length, sha256: sha(runtime), keccak256: keccak256(runtime), immutableRows: rows, runtimeHex: `0x${runtime.toString("hex")}` };
}

function runLocalBuildAndTests() {
  const tempRoot = path.join(os.tmpdir(), "opencode", "etherfi-stargate-valid-auth-step3");
  const outDir = path.join(tempRoot, "out"); const cacheDir = path.join(tempRoot, "cache"); const infoDir = path.join(tempRoot, "build-info");
  fs.rmSync(tempRoot, { recursive: true, force: true }); fs.mkdirSync(tempRoot, { recursive: true });
  const build = spawnSync("forge", ["build", "--root", TARGET, "--out", outDir, "--cache-path", cacheDir, "--build-info", "--build-info-path", infoDir, "--no-cache", "--offline"], { cwd: ROOT, encoding: "utf8", timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
  const buildOutput = `${build.stdout || ""}\n${build.stderr || ""}`;
  if (build.status !== 0) throw new Error("offline build failed");
  const infoFiles = walkFiles(infoDir, (x) => x.endsWith(".json")); if (infoFiles.length !== 1) throw new Error(`build-info count ${infoFiles.length}`);
  const buildInfo = JSON.parse(fs.readFileSync(infoFiles[0], "utf8"));
  const artifacts = {
    StargateModule: JSON.parse(fs.readFileSync(path.join(outDir, "StargateModule.sol", "StargateModule.json"), "utf8")),
    EtherFiSafe: JSON.parse(fs.readFileSync(path.join(outDir, "EtherFiSafe.sol", "EtherFiSafe.json"), "utf8")),
  };
  const testOut = path.join(tempRoot, "test-out"); const testCache = path.join(tempRoot, "test-cache");
  const args = ["test", "--root", TARGET, "--out", testOut, "--cache-path", testCache, "--no-cache", "--offline", "--match-path", "test/critical/EtherFiStargateValidAuthTupleInvariant.t.sol", "--fuzz-runs", String(FUZZ_RUNS), "--fuzz-seed", FUZZ_SEED, "-vv"];
  const test = spawnSync("forge", args, { cwd: ROOT, encoding: "utf8", timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
  const testOutput = `${test.stdout || ""}\n${test.stderr || ""}`;
  if (test.status !== 0) throw new Error("local invariant tests failed");
  const passLines = testOutput.split(/\r?\n/).filter((x) => /^\[PASS\]/.test(x.trim()));
  const fuzzLines = passLines.filter((x) => /\(runs:\s*256,/.test(x));
  const suite = testOutput.match(/(\d+) tests passed, (\d+) failed, (\d+) skipped \((\d+) total tests\)/);
  if (!suite || Number(suite[1]) !== 13 || Number(suite[2]) !== 0 || Number(suite[4]) !== 13 || passLines.length !== 13 || fuzzLines.length !== 2) throw new Error("unexpected test result cardinality");
  return { tempRoot, buildInfo, artifacts, result: { build: { exitStatus: build.status, outputBytes: Buffer.byteLength(buildOutput), outputSha256: sha(buildOutput), compilerVersion: buildInfo.solcVersion, compilerLongVersion: buildInfo.solcLongVersion, sourceCount: Object.keys(buildInfo.input?.sources || {}).length, standardJsonInputSha256: sha(canonical(buildInfo.input)) }, tests: { commandTemplate: `forge test --root targets/cash-v3 --out <ephemeral>/test-out --cache-path <ephemeral>/test-cache --no-cache --offline --match-path test/critical/EtherFiStargateValidAuthTupleInvariant.t.sol --fuzz-runs ${FUZZ_RUNS} --fuzz-seed ${FUZZ_SEED} -vv`, ephemeralPathsPersisted: false, exitStatus: test.status, outputBytes: Buffer.byteLength(testOutput), outputSha256: sha(testOutput), suiteCount: 1, testsPassed: 13, testsFailed: 0, testsSkipped: 0, unitTestsPassed: 11, fuzzPropertiesPassed: 2, fuzzRunsPerProperty: FUZZ_RUNS, totalFuzzCases: FUZZ_RUNS * 2, fuzzSeed: FUZZ_SEED, passLines } } };
}

function staticSemantics() {
  const stargate = fs.readFileSync(abs("targets/cash-v3/src/modules/stargate/StargateModule.sol"), "utf8");
  const moduleBase = fs.readFileSync(abs("targets/cash-v3/src/modules/ModuleBase.sol"), "utf8");
  const safe = fs.readFileSync(abs("targets/cash-v3/src/safe/EtherFiSafe.sol"), "utf8");
  const safeBase = fs.readFileSync(abs("targets/cash-v3/src/safe/EtherFiSafeBase.sol"), "utf8");
  const multiSig = fs.readFileSync(abs("targets/cash-v3/src/safe/MultiSig.sol"), "utf8");
  const cashSetters = fs.readFileSync(abs("targets/cash-v3/src/modules/cash/CashModuleSetters.sol"), "utf8");
  const cashStorage = fs.readFileSync(abs("targets/cash-v3/src/modules/cash/CashModuleStorageContract.sol"), "utf8");
  const requestBody = stargate.slice(stargate.indexOf("function requestBridge("), stargate.indexOf("function executeBridge("));
  const checks = {
    signaturePreimageBindsDomainNonceSafeAndFiveTupleFields: /REQUEST_BRIDGE_SIG, block\.chainid, address\(this\), IEtherFiSafe\(safe\)\.useNonce\(\), safe, abi\.encode\(destEid, asset, amount, destRecipient, maxSlippageInBps\)/.test(stargate),
    signatureCheckedByTargetSafe: /IEtherFiSafe\(safe\)\.checkSignatures\(digestHash, signers, signatures\)/.test(stargate),
    requestCallerNotCryptographicallyBound: !requestBody.includes("msg.sender") && /onlyEtherFiSafe\(safe\)/.test(requestBody),
    safeValidityPredicateDoesNotRequireCallerEquality: /if \(!etherFiDataProvider\.isEtherFiSafe\(account\)\) revert OnlyEtherFiSafe\(\)/.test(moduleBase) && !moduleBase.slice(moduleBase.indexOf("modifier onlyEtherFiSafe"), moduleBase.indexOf("function setupModule")).includes("msg.sender"),
    safeNonceRestrictedToEnabledModule: /if \(!isModuleEnabled\(msg.sender\)\) revert OnlyModules\(\);[\s\S]*return _useNonce\(\)/.test(safe),
    safeNoncePostIncrement: /return \$\.nonce\+\+/.test(safeBase),
    quorumOwnerSignatureVerification: /if \(!\$\.owners\.contains\(signers\[i\]\)\) revert InvalidSigner\(i\)[\s\S]*digestHash\.isValidSignature\(signers\[i\], signatures\[i\]\)[\s\S]*validSigs == \$\.threshold/.test(multiSig),
    requestStoresAllFiveTupleFieldsUnderSafe: /withdrawals\[safe\] = CrossChainWithdrawal\([\s\S]*destEid: destEid[\s\S]*asset: asset[\s\S]*amount: amount[\s\S]*destRecipient: destRecipient[\s\S]*maxSlippageInBps: maxSlippageInBps/.test(stargate),
    cashRequestUsesSafeAssetAmountAndModuleRecipient: /cashModule\.requestWithdrawalByModule\(safe, asset, amount\)/.test(stargate) && /address recipient = msg\.sender;[\s\S]*_requestWithdrawal\(safe, tokens, amounts, recipient\)/.test(cashSetters),
    cashOverwriteCancelsOldModuleBeforeReplacement: /_cancelOldWithdrawal\(safe\);[\s\S]*pendingWithdrawalRequest = WithdrawalRequest/.test(cashSetters) && /IBridgeModule\(recipient\)\.cancelBridgeByCashModule\(safe\)/.test(cashStorage),
    executeMatchesCashRecipientSingleTokenAssetAmount: /withdrawalRequest\.recipient != address\(this\)[\s\S]*withdrawalRequest\.tokens\.length != 1[\s\S]*withdrawalRequest\.tokens\[0\] != withdrawal\.asset[\s\S]*withdrawalRequest\.amounts\[0\] != withdrawal\.amount/.test(stargate),
    executeUsesStoredDestinationRecipientAndSlippage: /_bridge\(withdrawal\.destEid, withdrawal\.asset, withdrawal\.amount, withdrawal\.destRecipient, withdrawal\.maxSlippageInBps\)/.test(stargate),
    destinationAndSlippageAbsentFromCashExecuteGuard: !stargate.slice(stargate.indexOf("WithdrawalRequest memory withdrawalRequest"), stargate.indexOf("cashModule.processWithdrawal(safe)")).includes("destEid") && !stargate.slice(stargate.indexOf("WithdrawalRequest memory withdrawalRequest"), stargate.indexOf("cashModule.processWithdrawal(safe)")).includes("maxSlippageInBps"),
  };
  return { checks, allChecksPass: Object.values(checks).every(Boolean), references: { signature: "StargateModule.sol:304-307", request: "StargateModule.sol:208-229", caller: "ModuleBase.sol:104-111", nonce: "EtherFiSafe.sol:224-233; EtherFiSafeBase.sol:151-163", quorum: "MultiSig.sol:226-263", cashRequestAndOverwrite: "CashModuleSetters.sol:193-207,329-348; CashModuleStorageContract.sol:191-207", execute: "StargateModule.sol:236-250" } };
}

function main() {
  if (strip0x(FUZZ_SEED).length !== 64) throw new Error("fuzz seed must be bytes32");
  const capturedAt = new Date().toISOString(); const scannerSha256 = hashFile(SCANNER).sha256;
  const step1 = JSON.parse(fs.readFileSync(abs(STEP1), "utf8")); const step2 = JSON.parse(fs.readFileSync(abs(STEP2), "utf8")); const capability = JSON.parse(fs.readFileSync(abs(CAPABILITY), "utf8"));
  if (step1.revision !== "pinbound-build-binding-step1-r3-reviewer-corrected" || step1.classification !== "exact") throw new Error("Step 1 predecessor mismatch");
  if (step2.revision !== "pending-withdrawal-tuple-step2-r2-reviewer-corrected" || step2.classification !== "exact-pending-tuple-equal" || step2.deployedSemanticsBinding?.exact !== true) throw new Error("Step 2 predecessor mismatch");
  if (step1.pin.blockNumber !== PIN.blockNumber || step2.pin.blockNumber !== PIN.blockNumber || step1.pin.blockHash.toLowerCase() !== PIN.blockHash || step2.pin.blockHash.toLowerCase() !== PIN.blockHash) throw new Error("pin mismatch");
  const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: TARGET, encoding: "utf8", timeout: 15_000 }); const sourceCommit = git.status === 0 ? git.stdout.trim() : null;
  const local = runLocalBuildAndTests();
  const immutableNames = collectImmutableNames(local.buildInfo);
  const stargateReconstruction = reconstructRuntime(local.artifacts.StargateModule, immutableNames, { etherFiDataProvider: ADDR.dataProvider, cashModule: ADDR.cashModule });
  const safeReconstruction = reconstructRuntime(local.artifacts.EtherFiSafe, immutableNames, { dataProvider: ADDR.dataProvider });
  const step2Stargate = step2.deployedSemanticsBinding.stargate;
  const capabilitySafe = capability.deployment.safeBeacon;
  const runtimeBindings = {
    stargate: { address: getAddress(ADDR.stargateModule), currentBuildBytes: stargateReconstruction.bytes, currentBuildSha256: stargateReconstruction.sha256, step2DeployedSha256: step2Stargate.runtimeComparison.deployedRuntimeSha256, exactCurrentReconstructionEqualsStep2DeployedRuntime: stargateReconstruction.runtimeHex.toLowerCase() === step2Stargate.deployedRuntime.toLowerCase(), immutableRows: stargateReconstruction.immutableRows },
    safeImplementation: { address: capabilitySafe.safeImplementation, currentBuildBytes: safeReconstruction.bytes, currentBuildKeccak256: safeReconstruction.keccak256, predecessorDeployedKeccak256: capabilitySafe.safeImplementationRuntime.keccak256, exactCurrentReconstructionHashEqualsPinObservedImplementation: safeReconstruction.keccak256.toLowerCase() === capabilitySafe.safeImplementationRuntime.keccak256.toLowerCase(), immutableRows: safeReconstruction.immutableRows, legacyLatestDynamicFullBytecodeMatch: capability.localVerification.comparisons.find((x) => x.contract === "EtherFiSafe")?.fullBytecodeMatch === true, legacyLatestDynamicNotUsedAsPinAuthority: capability.localVerification.authoritativeForFixedPinEquality === false },
  };
  const step1Closure = step1.source.scopedRecursiveClosure.files;
  const closureRows = SOURCE_FILES.filter((x) => !x.endsWith("StargateModule.sol")).map((sourcePath) => { const predecessor = step1Closure.find((x) => x.path === sourcePath); const current = hashFile(sourcePath); return { sourcePath, predecessorPresent: Boolean(predecessor), predecessorSha256: predecessor?.sha256 || null, currentSha256: current.sha256, exact: predecessor?.sha256 === current.sha256 }; });
  const stargateSourceCurrent = hashFile("targets/cash-v3/src/modules/stargate/StargateModule.sol");
  const sourceBinding = { sourceCommit, expectedSourceCommit: SOURCE_COMMIT, sourceCommitMatch: sourceCommit === SOURCE_COMMIT, step1ClosureRows: closureRows, allStep1ClosureRowsExact: closureRows.every((x) => x.exact), stargateSource: { currentSha256: stargateSourceCurrent.sha256, step2Sha256: step2.deployedSemanticsBinding.guardSemantics.stargateExecuteBridge.sourceSha256, exact: stargateSourceCurrent.sha256 === step2.deployedSemanticsBinding.guardSemantics.stargateExecuteBridge.sourceSha256 }, currentWholeProjectStandardJsonInputSha256: local.result.build.standardJsonInputSha256, step2WholeProjectStandardJsonInputSha256: step2.build.standardJsonInputSha256, wholeProjectInputExpectedToDifferBecauseStep3TestIsAdded: local.result.build.standardJsonInputSha256 !== step2.build.standardJsonInputSha256 };
  const semantics = staticSemantics();
  const fieldMatrix = [
    { field: "Safe", cryptographicallyBound: true, storageKeyed: true, cashBound: true, executeGuardBound: true, bridgeInput: "storage key selects tuple", mutationOutcome: "rejected", proof: "fixed mutation + 256-case mutation property" },
    { field: "asset", cryptographicallyBound: true, storageKeyed: false, moduleStorageBound: true, cashBound: true, executeGuardBound: true, bridgeInput: "stored asset", mutationOutcome: "rejected", proof: "fixed mutation + property" },
    { field: "amount", cryptographicallyBound: true, storageKeyed: false, moduleStorageBound: true, cashBound: true, executeGuardBound: true, bridgeInput: "stored amount", mutationOutcome: "rejected", proof: "fixed mutation + property" },
    { field: "destination EID", cryptographicallyBound: true, storageKeyed: false, moduleStorageBound: true, cashBound: false, executeGuardBound: false, bridgeInput: "stored destination EID", mutationOutcome: "rejected at request; not rechecked against Cash at execute", proof: "fixed mutation + property + successful local execute capture" },
    { field: "destination recipient", cryptographicallyBound: true, storageKeyed: false, moduleStorageBound: true, cashBound: false, executeGuardBound: false, bridgeInput: "stored destination recipient", mutationOutcome: "rejected at request; not rechecked against Cash at execute", proof: "fixed mutation + property + successful local execute capture" },
    { field: "max slippage", cryptographicallyBound: true, storageKeyed: false, moduleStorageBound: true, cashBound: false, executeGuardBound: false, bridgeInput: "stored slippage bounds quote acceptance", mutationOutcome: "rejected at request; not rechecked against Cash at execute", proof: "fixed mutation + property + successful local execute capture" },
    { field: "caller", cryptographicallyBound: false, storageKeyed: false, moduleStorageBound: false, cashBound: false, executeGuardBound: false, bridgeInput: "none", mutationOutcome: "accepted for arbitrary relayer when authorization is valid", proof: "fixed arbitrary-relayer request and execute tests" },
    { field: "Safe nonce", cryptographicallyBound: true, storageKeyed: "Safe-global", cashBound: false, executeGuardBound: false, bridgeInput: "none", mutationOutcome: "replay rejected; failed verification rolls increment back", proof: "fixed replay/rollback test" },
  ];
  const allBindingExact = sourceBinding.sourceCommitMatch && sourceBinding.allStep1ClosureRowsExact && sourceBinding.stargateSource.exact && runtimeBindings.stargate.exactCurrentReconstructionEqualsStep2DeployedRuntime && runtimeBindings.safeImplementation.exactCurrentReconstructionHashEqualsPinObservedImplementation;
  const allTestsPass = local.result.tests.testsPassed === 13 && local.result.tests.testsFailed === 0 && local.result.tests.totalFuzzCases === 512;
  const classification = allBindingExact && semantics.allChecksPass && allTestsPass ? "PASS/BOUNDED-VALID-AUTH-TUPLE-INVARIANT" : "FAIL-CLOSED/INVARIANT-OR-BINDING-GAP";
  const runId = `etherfi-stargate-valid-auth-tuple-invariant-${PIN.blockNumber}-${PIN.blockHash.slice(2, 14)}-${scannerSha256.slice(0, 12)}`;
  const blockers = ["The proof is local and bounded to source/runtime semantics already observed at the fixed pin; it does not execute the selected live withdrawal or establish current signer intent.", "Caller is intentionally relayer-neutral and not signed. A third party can submit an already-valid tuple; timing or griefing consequences were not economically assessed.", "Destination EID, destination recipient, and slippage are not represented in Cash state or rechecked against Cash at execute; integrity relies on their signed write into Safe-keyed module storage and preservation until execute.", "STARGATE_MODULE_ADMIN_ROLE can change asset-to-pool configuration independently of a pending signature; configuration drift between request and execute is outside this tuple invariant.", "No bridge delivery, recipient receipt, full-history absence, extraction route, or economics were tested."];
  const nextAction = "Independently review and promote this bounded Step 3 package; separately assess asset-config drift between request and execute only if broader EtherFi closeout remains required.";
  const result = { schemaVersion: 1, revision: REVISION, runId, generatedAt: capturedAt, scanner: SCANNER, agentId: AGENT, role: "critical-research", step: 3, classification, signal: classification.startsWith("PASS") ? "⚪ CLEAN — BOUNDED VALID-AUTH TUPLE INVARIANT" : "🟠 WATCH — FAIL CLOSED", routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, safety: { localOnly: true, localMockStateTransitions: true, ephemeralTestIdentity: true, liveRpcCalls: false, endpointInventoryRead: false, envFilesRead: false, privateKeysOrSigningFilesRead: false, liveContractsCalled: false, forkCreated: false, realWithdrawalExecuted: false, realBridgeExecuted: false, broadcast: false, fundsUsed: false }, pin: PIN, predecessor: { step1: { path: STEP1, runId: step1.runId, sha256: hashFile(STEP1).sha256 }, step2: { path: STEP2, runId: step2.runId, sha256: hashFile(STEP2).sha256 }, capability: { path: CAPABILITY, runId: capability.runId, sha256: hashFile(CAPABILITY).sha256 } }, captureProvenance: { runId, scannerSha256, capturedAt, sourceCommit, fuzzSeed: FUZZ_SEED, fuzzRunsPerProperty: FUZZ_RUNS }, sourceBinding, runtimeBindings, semantics, testResults: local.result, fieldInvariantMatrix: fieldMatrix, conclusions: { cryptographicBinding: "REQUEST_BRIDGE_SIG, chain ID, module address, Safe nonce, Safe, destination EID, asset, amount, destination recipient, and max slippage are in the signed digest.", callerBinding: "Caller is not signed and is not required to equal the Safe; request and execute are relayer-neutral once the Safe argument is registered and request authorization is valid.", storageAndCashBinding: "The module stores all five tuple values under Safe. Cash stores Safe -> [asset], [amount], recipient=StargateModule, finalizeTime.", executeBinding: "executeBridge selects by Safe and rejects Cash recipient/token-count/asset/amount mismatch. It then uses destination EID, destination recipient, and slippage preserved in module storage without a second Cash comparison.", overwriteAndReplay: "A second valid authorization at the next Safe nonce atomically cancels and replaces the prior module/Cash tuple. Invalid overwrite and replay revert, roll back nonce consumption, and preserve prior state." }, blockers, nextAction };
  fs.rmSync(local.tempRoot, { recursive: true, force: true });
  writeOwned(RAW, JSON.stringify(result, null, 2) + "\n");
  const matrixMd = fieldMatrix.map((x) => `| ${x.field} | ${x.cryptographicallyBound} | ${x.moduleStorageBound ?? x.storageKeyed} | ${x.cashBound} | ${x.executeGuardBound} | ${x.mutationOutcome} |`).join("\n");
  const report = `# ${result.signal} — EtherFi Stargate valid-authorization tuple Step 3\n\n**Classification:** \`${classification}\`  \n**Run:** \`${runId}\`  \n**Fixed-pin semantic basis:** Optimism \`${PIN.blockNumber}\` / \`${PIN.blockHash}\`  \n**Gates:** \`routePositive=0\`, \`executableNow=0\`, \`signedActionJustified=false\`, \`fork=false\`\n\n## Result\n\nEvery accepted request authorization binds the Safe, destination EID, asset, amount, destination recipient, and maximum slippage through the signed digest (\`StargateModule.sol:304-307\`). The caller is deliberately not signed: any relayer can submit the exact valid tuple. Replay is rejected by the Safe-global nonce.\n\n| Field | Signed | Module storage/key | Cash | Execute Cash guard | Mutation outcome |\n|---|---:|---:|---:|---:|---|\n${matrixMd}\n\n## Request, overwrite, and execute flow\n\n- \`onlyEtherFiSafe(safe)\` validates the Safe argument, not \`msg.sender\` (\`ModuleBase.sol:104-111\`).\n- A valid request consumes \`IEtherFiSafe(safe).useNonce()\`, verifies owner quorum, asks Cash for exactly one asset/amount with recipient equal to StargateModule, then stores destination/asset/amount/recipient/slippage under the Safe (\`StargateModule.sol:208-229\`).\n- A new valid request at the next nonce cancels and atomically replaces the old Cash/module tuple; an invalid overwrite rolls back nonce and state (\`CashModuleSetters.sol:329-348\`; \`CashModuleStorageContract.sol:191-207\`).\n- Execute compares only Cash recipient, token count, asset, and amount. Destination EID, destination recipient, and slippage are not Cash fields; execute consumes their preserved module-storage values (\`StargateModule.sol:236-250\`).\n\n## Deterministic local tests\n\n- \`13/13\` tests passed: 11 unit tests and 2 properties.\n- Seed: \`${FUZZ_SEED}\`; \`${FUZZ_RUNS}\` cases/property; \`512\` fuzz cases total.\n- Covered valid acceptance, six signed-field mutations, arbitrary caller, replay/rollback, valid and invalid overwrite, Cash tuple consistency, four execute mismatch classes, Safe-key mismatch, and successful local capture of stored destination/recipient/slippage flow.\n- No fork, RPC, endpoint inventory, live contract, real withdrawal, real bridge, broadcast, or real funds.\n\n## Pin/build linkage\n\n- Stargate current reconstructed runtime equals Step 2 fixed-pin deployed runtime: \`${runtimeBindings.stargate.exactCurrentReconstructionEqualsStep2DeployedRuntime}\`.\n- Safe current reconstructed runtime hash equals the pin-observed beacon implementation hash: \`${runtimeBindings.safeImplementation.exactCurrentReconstructionHashEqualsPinObservedImplementation}\`.\n- Step 1 closure source rows exact: \`${sourceBinding.allStep1ClosureRowsExact}\`; source commit exact: \`${sourceBinding.sourceCommitMatch}\`.\n\n## Residual blockers\n\n${blockers.map((x) => `- ${x}`).join("\n")}\n\n## nextReadOnlyStep\n\n${nextAction}\n`;
  writeOwned(REPORT, report);
  const inbox = { findingId: "critical-etherfi-stargate-valid-auth-tuple-invariant", revision: REVISION, runId, agentId: AGENT, role: "critical-research", status: classification, classification, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, summary: "Bounded local proof passes: every accepted request signs Safe plus all five bridge tuple fields; caller is relayer-neutral; execute rechecks only Cash recipient/single-token/asset/amount and preserves destination/recipient/slippage from module storage.", artifacts: [RAW, MANIFEST, REPORT, SOL_TEST], testResults: { testsPassed: 13, fuzzCases: 512, seed: FUZZ_SEED }, blockers, nextAction };
  writeOwned(INBOX, JSON.stringify(inbox, null, 2) + "\n");
  writeOwned(HANDOFF, `# 2026-07-22 EtherFi Stargate valid-auth tuple Step 3 handoff\n\n- Run: \`${runId}\`; classification \`${classification}\`.\n- Fixed pin basis: Optimism \`${PIN.blockNumber}\` / \`${PIN.blockHash}\`.\n- Signed: Safe, destination EID, asset, amount, destination recipient, slippage, plus chain/module/nonce domain. Caller is not signed and is relayer-neutral.\n- Execute Cash guard: recipient=module, one token, asset, amount. Destination/recipient/slippage are preserved module storage, not Cash-rechecked.\n- Tests: 13/13, 11 unit + 2 properties, ${FUZZ_RUNS} cases/property, 512 total fuzz cases, seed \`${FUZZ_SEED}\`.\n- Exact bindings: Stargate runtime \`${runtimeBindings.stargate.exactCurrentReconstructionEqualsStep2DeployedRuntime}\`; Safe implementation runtime hash \`${runtimeBindings.safeImplementation.exactCurrentReconstructionHashEqualsPinObservedImplementation}\`; source closure \`${sourceBinding.allStep1ClosureRowsExact}\`.\n- Gates: \`0/0/false\`; fork false. Local mocks only; no RPC, live withdrawal, bridge, broadcast, or funds.\n- Next: ${nextAction}\n`);
  const records = [...new Set([SCANNER, VALIDATOR, SOL_TEST, RAW, REPORT, INBOX, HANDOFF, STEP1, STEP2, CAPABILITY, "targets/cash-v3/foundry.toml", ...SOURCE_FILES])].map(hashFile);
  const aggregateSha256 = sha(records.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n"));
  const manifest = { schemaVersion: 1, revision: REVISION, runId, generatedAt: capturedAt, algorithm: "sha256", classification, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, fixedPin: PIN, testSeed: FUZZ_SEED, fuzzRunsPerProperty: FUZZ_RUNS, totalFuzzCases: 512, testsPassed: 13, exactBinding: allBindingExact, records, aggregateSha256 };
  writeOwned(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ runId, classification, matrix: fieldMatrix, tests: local.result.tests, residualBlockers: blockers, artifacts: [SOL_TEST, SCANNER, VALIDATOR, RAW, MANIFEST, REPORT, INBOX, HANDOFF], nextAction, manifestAggregateSha256: aggregateSha256 }) + "\n");
}

try { main(); } catch (e) { process.stderr.write(`scan failed: ${String(e?.message || e)}\n`); process.exitCode = 1; }
