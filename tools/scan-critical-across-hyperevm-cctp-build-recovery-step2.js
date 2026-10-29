#!/usr/bin/env node
"use strict";

// Offline-only recovery from retained creation inputs, local Git objects, an
// already prepared LF checkout, package cache, compiler cache, and local build.
const crypto = require("crypto");
const cp = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const REPO = path.join(ROOT, "targets", "across-contracts");
const TEMP = path.join(process.env.LOCALAPPDATA || "", "Temp", "opencode", "across-cctp-03b868a1-exactdeps");
const NAME = "critical-across-hyperevm-cctp-build-recovery-step2";
const AGENT = "critical-across-hyperevm-cctp-build-recovery-step2-20260724";
const RAW = `reports/raw/fast/${NAME}.json`;
const BUILD = `reports/raw/fast/${NAME}-candidate-build.json`;
const TESTS = `reports/raw/fast/${NAME}-tests.json`;
const LEAK = `reports/raw/fast/${NAME}-leak-scan.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const REPORT = `reports/${NAME}.md`;
const INBOX = `coordination/inbox/critical/2026-07-24-${NAME}.json`;
const HANDOFF = `coordination/handoffs/2026-07-24-${NAME}-handoff.md`;
const SCANNER = `tools/scan-${NAME}.js`;
const VALIDATOR = `tools/test-${NAME}.js`;
const STEP1_RAW = "reports/raw/fast/critical-across-hyperevm-fallback-sponsorship-step1.json";
const STEP1_R2_MANIFEST = "reports/raw/fast/critical-across-hyperevm-fallback-sponsorship-step1-r2-manifest.json";
const USDC_RUN = "targets/across-contracts/broadcast/DeploySponsoredCCTPDstPeriphery.s.sol/999/run-latest.json";
const USDH_RUN = "targets/across-contracts/broadcast/DeploySponsoredCCTPDstPeripheryUSDH.s.sol/999/run-latest.json";
const CANDIDATE_COMMIT = "03b868a12df59c2ec2639e3a8d97597dab6cb8f2";
const CANDIDATE_ARTIFACT = path.join(TEMP, "out", "SponsoredCCTPDstPeriphery.sol", "SponsoredCCTPDstPeriphery.json");
const EXPECTED = {
  normalized: "5b2319c1fc8a64d9fb45b7473e489c902976b0f98ae423e39ec055d431c50706",
  usdc: "f06f5859a51a1d0b987676df5a1d6bf4167037127f210c3770478f900c3f4f68",
  usdh: "b91cf9a3c51533218f496ce132c6a4420a58ab7a98d1f157dce0c088a4f93e5d",
  creation: "a1204240aff49e21839588bb96ce484c2259866884b69b91a1e25a9fb7488e50",
  activeMetadataCid: "QmT2V8ejSdB8J7wtztQNfGHtZxn85f9WJADvjJC7kdVPtW",
  activeMetadataMultihash: "122045a326ca9b7fc09c89563df92941dc2675e9d98f23484d0043b02d17cc551343"
};
const abs = (rel) => path.join(ROOT, rel);
const read = (rel) => fs.readFileSync(abs(rel));
const text = (rel) => read(rel).toString("utf8");
const json = (rel) => JSON.parse(text(rel));
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const digest = (value) => sha(Buffer.from(JSON.stringify(canonical(value))));
const hashFile = (rel) => { const body = read(rel); return { path: rel, bytes: body.length, sha256: sha(body) }; };
const write = (rel, body) => { fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), body, "utf8"); };
function exec(command, args, cwd, env = {}) { const result = cp.spawnSync(command, args, { cwd, env: { ...process.env, ...env }, encoding: "utf8", windowsHide: true, timeout: 600000 }); return { passed: result.status === 0, exitCode: result.status, outputSha256: sha(Buffer.from(`${result.stdout || ""}${result.stderr || ""}`)) }; }
let checks = 0;
function check(ok, label) { checks++; if (!ok) throw new Error(label); }
function cidV0(multihash) { const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"; let value = BigInt(`0x${multihash}`), out = ""; while (value) { out = alphabet[Number(value % 58n)] + out; value /= 58n; } return out; }
function cbor(hex) { const length = parseInt(hex.slice(-4), 16), body = hex.slice(-(length + 2) * 2, -4), multihash = body.match(/1220[0-9a-f]{64}/)?.[0] || null, solc = body.match(/64736f6c6343([0-9a-f]{6})/)?.[1] || null; return { length, hex: body, multihash, cid: multihash ? cidV0(multihash) : null, solcHex: solc }; }
function normalize(hex, refs) { const out = hex.split(""); for (const row of Object.values(refs).flat()) for (let i = row.start * 2; i < (row.start + row.length) * 2; i++) out[i] = "0"; return out.join(""); }
function patchImmutables(template, refs, values) { const out = template.split(""); for (const [id, rows] of Object.entries(refs)) { const word = values[id].replace(/^0x/, "").padStart(64, "0"); for (const row of rows) for (let i = 0; i < row.length * 2; i++) out[row.start * 2 + i] = word[i]; } return out.join(""); }
function deployment(rel, expectedHash) {
  const run = json(rel), tx = run.transactions.find((row) => row.contractName === "SponsoredCCTPDstPeriphery" && row.transactionType === "CREATE");
  const input = tx.transaction.input.replace(/^0x/, "").toLowerCase(), creation = input.slice(0, -384), argsHex = input.slice(-384);
  const args = Array.from({ length: 6 }, (_, i) => `0x${argsHex.slice(i * 64 + 24, (i + 1) * 64)}`);
  const runtimeTemplate = creation.slice(0x3f1 * 2, (0x3f1 + 0x2d23) * 2);
  return { rel, recordedCommit: run.commit, handler: tx.contractAddress.toLowerCase(), module: tx.additionalContracts[0].address.toLowerCase(), creation, args, runtimeTemplate, expectedRuntimeSha256: expectedHash, inputBytes: input.length / 2, creationBytes: creation.length / 2, runtimeBytes: runtimeTemplate.length / 2, creationSha256: sha(Buffer.from(creation, "hex")), runtimeTemplateSha256: sha(Buffer.from(runtimeTemplate, "hex")), cbor: cbor(runtimeTemplate) };
}
function findAstNames(dir, ids) {
  const wanted = new Set(ids), found = {};
  function node(value) { if (!value || typeof value !== "object") return; if (wanted.has(String(value.id)) && value.nodeType === "VariableDeclaration") found[String(value.id)] = value.name; for (const child of Object.values(value)) node(child); }
  function walk(current) { for (const entry of fs.readdirSync(current, { withFileTypes: true })) { const full = path.join(current, entry.name); if (entry.isDirectory()) walk(full); else if (entry.name.endsWith(".json")) try { node(JSON.parse(fs.readFileSync(full, "utf8")).ast); } catch {} } }
  walk(dir); return found;
}
function leakScan(paths) { const findings = []; for (const rel of paths) { const body = text(rel); if (/(?:https?|wss?):\/\//i.test(body)) findings.push({ path: rel, category: "url-scheme" }); if (/(?:authorization|x-api-key|api-key|bearer)\s*[:=]/i.test(body)) findings.push({ path: rel, category: "credential-shape" }); } return { scannedPaths: paths, findingCount: findings.length, findings, passed: findings.length === 0, endpointInventoryCompared: false }; }

function ensureOfflineCandidateWorktree() {
  if (!fs.existsSync(TEMP)) {
    const added = exec("git", ["-c", "core.autocrlf=false", "worktree", "add", "--detach", TEMP, CANDIDATE_COMMIT], REPO);
    if (!added.passed) throw new Error("offline-candidate-worktree-create");
  }
  const actual = cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: TEMP, encoding: "utf8" }).trim();
  if (actual !== CANDIDATE_COMMIT) throw new Error("candidate-worktree-commit");
  if (!fs.existsSync(path.join(TEMP, "node_modules"))) {
    const yarn = path.join(process.env.LOCALAPPDATA || "", "node", "corepack", "v1", "yarn", "1.22.22", "bin", "yarn.js");
    if (!fs.existsSync(yarn)) throw new Error("offline-yarn-cache-runner-missing");
    const installed = exec(process.execPath, [yarn, "install", "--offline", "--frozen-lockfile", "--ignore-scripts", "--non-interactive"], TEMP);
    if (!installed.passed) throw new Error("offline-package-cache-install");
  }
}

function main() {
  ensureOfflineCandidateWorktree();
  check(cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: TEMP, encoding: "utf8" }).trim() === CANDIDATE_COMMIT, "candidate-worktree-commit");
  const buildRun = exec("forge", ["build", "--skip", "test", "--contracts", "contracts/periphery/mintburn/HyperCoreFlowExecutor.sol"], TEMP, { FOUNDRY_PROFILE: "mintburn" });
  check(buildRun.passed, "candidate-offline-build");
  check(fs.existsSync(CANDIDATE_ARTIFACT), "offline-candidate-artifact-missing-after-build");
  const artifact = JSON.parse(fs.readFileSync(CANDIDATE_ARTIFACT, "utf8"));
  const metadata = typeof artifact.metadata === "string" ? JSON.parse(artifact.metadata) : artifact.metadata;
  const candidateCreation = artifact.bytecode.object.replace(/^0x/, "").toLowerCase(), candidateRuntime = artifact.deployedBytecode.object.replace(/^0x/, "").toLowerCase();
  const refs = artifact.deployedBytecode.immutableReferences || {}, links = artifact.deployedBytecode.linkReferences || {};
  const names = findAstNames(path.join(TEMP, "out"), Object.keys(refs));
  check(Object.keys(refs).length === 5 && Object.values(refs).flat().length === 15, "solc-immutable-reference-shape");
  check(Object.keys(links).length === 0, "no-link-references");
  check(Object.values(names).sort().join(",") === ["baseToken", "cctpMessageTransmitter", "cctpTokenMessenger", "hyperCoreModule", "multicallHandler"].sort().join(","), "immutable-ast-names");
  const usdc = deployment(USDC_RUN, EXPECTED.usdc), usdh = deployment(USDH_RUN, EXPECTED.usdh);
  check(usdc.creation === usdh.creation && usdc.creationSha256 === EXPECTED.creation, "two-deployment-creation-family");
  check(usdc.runtimeTemplate === usdh.runtimeTemplate && usdc.runtimeTemplateSha256 === EXPECTED.normalized, "two-deployment-runtime-template-family");
  check(usdc.cbor.cid === EXPECTED.activeMetadataCid && usdc.cbor.multihash === EXPECTED.activeMetadataMultihash && usdc.cbor.solcHex === "00081e", "active-cbor-solc-ipfs");
  check(usdc.runtimeBytes === 11555 && candidateRuntime.length / 2 === 11555 && candidateCreation.length / 2 === 37196, "candidate-size-equality");
  const diffs = []; for (let i = 0; i < candidateCreation.length; i += 2) if (candidateCreation.slice(i, i + 2) !== usdc.creation.slice(i, i + 2)) diffs.push(i / 2);
  check(diffs.length === 32 && diffs[0] === 12521 && diffs.at(-1) === 12552, "creation-diff-only-ipfs-digest");
  const runtimeDiffs = []; for (let i = 0; i < candidateRuntime.length; i += 2) if (candidateRuntime.slice(i, i + 2) !== usdc.runtimeTemplate.slice(i, i + 2)) runtimeDiffs.push(i / 2);
  check(runtimeDiffs.length === 32 && runtimeDiffs[0] === 11512 && runtimeDiffs.at(-1) === 11543, "runtime-diff-only-ipfs-digest");
  const candidateCbor = cbor(candidateRuntime);
  check(candidateCbor.cid === "QmRbm2RTFUbC9AU4c2dLXBVBBFTLZgMpCpKRADjbev7zHo" && candidateCbor.solcHex === "00081e", "candidate-cbor");
  check(candidateRuntime.slice(0, -(candidateCbor.length + 2) * 2) === usdc.runtimeTemplate.slice(0, -(usdc.cbor.length + 2) * 2), "executable-body-byte-equality");
  check(normalize(candidateRuntime, refs) === candidateRuntime && sha(Buffer.from(candidateRuntime, "hex")) !== EXPECTED.normalized, "candidate-full-runtime-normalized-mismatch");
  const idByName = Object.fromEntries(Object.entries(names).map(([id, name]) => [name, id]));
  function values(dep) { return { [idByName.multicallHandler]: dep.args[5], [idByName.hyperCoreModule]: dep.module, [idByName.cctpMessageTransmitter]: dep.args[0], [idByName.cctpTokenMessenger]: dep.args[1], [idByName.baseToken]: dep.args[4] }; }
  for (const dep of [usdc, usdh]) {
    dep.patchedRetainedRuntimeSha256 = sha(Buffer.from(patchImmutables(dep.runtimeTemplate, refs, values(dep)), "hex"));
    dep.patchedCandidateRuntimeSha256 = sha(Buffer.from(patchImmutables(candidateRuntime, refs, values(dep)), "hex"));
    dep.retainedPatchedExact = dep.patchedRetainedRuntimeSha256 === dep.expectedRuntimeSha256;
    dep.candidatePatchedExact = dep.patchedCandidateRuntimeSha256 === dep.expectedRuntimeSha256;
  }
  check(usdc.retainedPatchedExact && usdh.retainedPatchedExact, "retained-creation-immutable-runtime-binding");
  check(!usdc.candidatePatchedExact && !usdh.candidatePatchedExact, "candidate-build-not-byte-exact");
  const missingObjectChecks = ["3680af8", "15a19c0"].map((short) => ({ short, locallyPresent: exec("git", ["cat-file", "-e", `${short}^{commit}`], REPO).passed }));
  check(missingObjectChecks.every((row) => !row.locallyPresent), "recorded-deployment-commits-absent");
  const compiler = path.join(process.env.APPDATA || "", "svm", "0.8.30", "solc-0.8.30");
  check(fs.existsSync(compiler), "solc-cache-present");
  check(metadata.compiler.version === "0.8.30+commit.73712a01", "compiler-version");
  check(metadata.settings.optimizer.enabled && metadata.settings.optimizer.runs === 300 && metadata.settings.viaIR === true && metadata.settings.evmVersion === "prague" && metadata.settings.metadata.bytecodeHash === "ipfs" && metadata.settings.metadata.useLiteralContent === true, "candidate-settings");
  const closure = Object.keys(metadata.sources).sort().map((source) => { const full = path.join(TEMP, source); const body = fs.readFileSync(full); return { source, bytes: body.length, sha256: sha(body) }; });
  check(closure.length === 51, "candidate-source-closure-count");
  const candidate = canonical({
    schemaVersion: 1, sourceCommit: CANDIDATE_COMMIT, sourceCommitRole: "nearest locally reproducible executable-body-equivalent candidate; not exact full-runtime provenance", compiler: { version: metadata.compiler.version, localBinaryBytes: fs.statSync(compiler).size, localBinarySha256: sha(fs.readFileSync(compiler)) }, settings: { optimizer: metadata.settings.optimizer, viaIR: metadata.settings.viaIR, evmVersion: metadata.settings.evmVersion, metadata: metadata.settings.metadata }, packageLock: { packageJson: { bytes: fs.statSync(path.join(TEMP, "package.json")).size, sha256: sha(fs.readFileSync(path.join(TEMP, "package.json"))) }, yarnLock: { bytes: fs.statSync(path.join(TEMP, "yarn.lock")).size, sha256: sha(fs.readFileSync(path.join(TEMP, "yarn.lock"))) }, installCommand: "Yarn 1.22.22 install --offline --frozen-lockfile --ignore-scripts --non-interactive", networkAllowed: false },
    build: { command: "FOUNDRY_PROFILE=mintburn forge build --skip test --contracts contracts/periphery/mintburn/HyperCoreFlowExecutor.sol", passed: true, outputSha256: buildRun.outputSha256 }, artifact: { creationBytes: candidateCreation.length / 2, creationSha256: sha(Buffer.from(candidateCreation, "hex")), runtimeBytes: candidateRuntime.length / 2, runtimeTemplateSha256: sha(Buffer.from(candidateRuntime, "hex")), normalizedRuntimeSha256: sha(Buffer.from(normalize(candidateRuntime, refs), "hex")), immutableReferences: refs, immutableAstNames: names, linkReferences: links, cbor: candidateCbor }, closureCount: closure.length, closureAggregateSha256: digest(closure), closure });
  write(BUILD, JSON.stringify(candidate, null, 2) + "\n");
  const exactMatch = false;
  const compactDeployment = (dep) => { const { creation, runtimeTemplate, ...retained } = dep; return retained; };
  const raw = canonical({
    schemaVersion: 1, generatedAt: new Date().toISOString(), runId: `${NAME}-${digest({ active: EXPECTED.normalized, candidate: candidate.artifact.runtimeTemplateSha256, closure: candidate.closureAggregateSha256 })}`, agentId: AGENT, role: "critical-research",
    classification: "WATCH/COVERAGE-BLOCKED/EXACT-CCTP-BUILD-METADATA-OBJECT-ABSENT/STEP2", exactMatch, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false,
    pipeline: { stage: 1, total: 5, priorSourceConditionalPrimitive: true, exactActiveCctpBuildRecovered: false, actualCctpGuardSemanticsPromoted: false, deployedUnderDeliveryTrigger: false, forkGateOpened: false },
    retainedBindings: { creationFamilyExact: true, creationBytes: usdc.creationBytes, creationSha256: usdc.creationSha256, normalizedRuntimeTemplateBytes: usdc.runtimeBytes, normalizedRuntimeTemplateSha256: usdc.runtimeTemplateSha256, activeMetadata: usdc.cbor, deployments: [compactDeployment(usdc), compactDeployment(usdh)], solcReportedImmutableReferenceCount: Object.values(refs).flat().length, solcReportedLinkReferenceCount: 0 },
    candidateResult: { sourceCommit: CANDIDATE_COMMIT, compiler: candidate.compiler, settings: candidate.settings, fullCreationByteExact: false, fullNormalizedRuntimeByteExact: false, executableBodyExcludingCborByteExact: true, differingByteCount: 32, differingRuntimeByteRangeInclusive: [11512, 11543], differenceCategory: "CBOR IPFS metadata multihash digest only", candidateMetadata: candidateCbor, activeMetadata: usdc.cbor, immutablePatchedCandidateRuntimeExactForBothDeployments: false, retainedCreationTemplatePatchedRuntimeExactForBothDeployments: true, acceptedByGate: false },
    semanticGate: { actualReceiveTransportBeforeNonceExact: null, actualSharedReentrancyGuardSemanticsExact: null, promotionAllowed: false, reason: "The required full normalized runtime byte match is absent. Candidate source semantics are not promoted despite executable-body equality outside CBOR." },
    localSearch: { gitHistorySearched: true, gitObjectsSearched: true, buildArtifactsSearched: true, buildInfoSearched: true, standardJsonSearched: true, deploymentManifestsSearched: true, packageCachesUsedOffline: true, compilerCacheUsedOffline: true, sourceServiceSnapshotsSearched: true, cborIpfsBzzSnapshotsSearched: true, creationBytecodeAndConstructorArgsRecovered: true, recordedCommitObjects: missingObjectChecks, exactMetadataPayloadLocallyPresent: false, exactStandardJsonLocallyPresent: false, buildInfoCandidateCount: 0, endpointCaptureRepeated: false },
    missingContentAddressedObjects: [
      { type: "git-commit-object", identifier: "3680af8 (only abbreviated deployment-manifest identifier retained; full object ID unavailable)", requiredFor: "USDC deployment source tree and build provenance" },
      { type: "git-commit-object", identifier: "15a19c0 (only abbreviated deployment-manifest identifier retained; full object ID unavailable)", requiredFor: "USDH deployment source tree and build provenance" },
      { type: "ipfs-metadata", identifier: EXPECTED.activeMetadataCid, multihashHex: EXPECTED.activeMetadataMultihash, requiredFor: "exact metadata JSON and source content-address resolution" },
      { type: "solc-standard-json", identifier: `sha256/metadata-preimage-for-${EXPECTED.activeMetadataMultihash.slice(4)}`, requiredFor: "exact compiler input/output, source closure, settings, AST IDs, immutable/link references" }
    ],
    predecessor: { step1R2Manifest: hashFile(STEP1_R2_MANIFEST), step1Raw: hashFile(STEP1_RAW), usdcDeploymentManifest: hashFile(USDC_RUN), usdhDeploymentManifest: hashFile(USDH_RUN) },
    tests: { checksPassed: checks, checksTotal: checks, buildPassed: true },
    nextGate: "Provide or recover offline the full Git objects for deployment commits 3680af8/15a19c0 or the exact IPFS metadata payload QmT2V8ejSdB8J7wtztQNfGHtZxn85f9WJADvjJC7kdVPtW plus its complete standard-json/source closure; then rebuild and require full runtime equality after only solc-reported immutable/link normalization.",
    activityScope: { offlineOnly: true, endpointInventoryReads: 0, rpcCalls: 0, httpRequests: 0, webRequests: 0, forkCreated: false, liveCalls: 0, signedTransactions: 0, broadcasts: 0, privateKeyReads: 0, envFileReads: 0, productionMutation: false, retainedCaptureRerun: false, localBuilds: 1, localArtifactWrites: true }
  });
  write(RAW, JSON.stringify(raw, null, 2) + "\n");
  write(TESTS, JSON.stringify(canonical({ schemaVersion: 1, checksPassed: checks, checksTotal: checks, passed: true, build: candidate.build, exactMatch, assertions: { retainedCreationSameAcrossDeployments: true, retainedNormalizedTemplateMatchesStep1: true, solcImmutableReferencesOnly: true, linksAbsent: true, retainedTemplatePatchesToBothCapturedRuntimeHashes: true, candidateExecutableBodyMatchesOutsideCbor: true, candidateFullNormalizedRuntimeMismatch: true, mismatchExactly32IpfsDigestBytes: true, missingCommitObjectsConfirmed: true, exactMetadataPayloadAbsent: true } }), null, 2) + "\n");
  write(REPORT, `# 🟠 WATCH — Across HyperEVM CCTP build recovery Step 2\n\n**Classification:** \`${raw.classification}\`  \n**Exact active source/runtime match:** \`false\`  \n**Pipeline:** \`1/5\`; gates \`0/0/false\`; fork=false\n\n## Result\n\nThe two retained deployment manifests contain the same ${usdc.creationBytes}-byte creation bytecode at SHA-256 \`${usdc.creationSha256}\`. Its embedded ${usdc.runtimeBytes}-byte runtime template hashes to the Step 1 normalized active family \`${usdc.runtimeTemplateSha256}\`. Applying only the 15 solc-reported immutable placements with each manifest's constructor values and created HyperCore module address reproduces both captured active runtime hashes exactly: USDC \`${usdc.patchedRetainedRuntimeSha256}\`, USDH \`${usdh.patchedRetainedRuntimeSha256}\`. No link references exist.\n\nThe nearest reproducible source is commit \`${CANDIDATE_COMMIT}\`, solc \`${candidate.compiler.version}\`, optimizer 300, viaIR, Prague, literal-content/IPFS metadata. It has the same sizes, immutable layout, and every executable runtime byte before CBOR. It nevertheless differs in exactly 32 bytes: the IPFS digest in runtime CBOR. Candidate CID is \`${candidateCbor.cid}\`; active CID is \`${usdc.cbor.cid}\`. Metadata is part of runtime, and the requested gate permits only immutable/link normalization, so this is **not** an exact match.\n\n## Blocker\n\nThe abbreviated deployment commit objects \`3680af8\` and \`15a19c0\` are absent locally. The active metadata object \`${EXPECTED.activeMetadataCid}\` and its exact standard-json/source closure are also absent. No normalized-family or executable-prefix equivalence is promoted to source/runtime equivalence. Consequently actual deployed CCTP transport-before-nonce and shared-guard semantics remain null at this gate.\n\n## Offline evidence and next gate\n\nComparator/build assertions: ${checks}/${checks}; local build PASS. No endpoint inventory, RPC, HTTP, web, fork, live call, signing, broadcast, or retained capture occurred.\n\nNext: ${raw.nextGate}\n`);
  const inbox = canonical({ findingId: NAME, runId: raw.runId, agentId: AGENT, role: "critical-research", status: raw.classification, classification: raw.classification, exactMatch: false, routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false, summary: "Retained creation inputs patch exactly to both active runtimes, but the nearest local source build differs by the 32-byte CBOR IPFS digest; exact source/runtime provenance remains blocked on missing Git/metadata/standard-json objects.", artifacts: [RAW, BUILD, TESTS, LEAK, MANIFEST, REPORT, SCANNER, VALIDATOR, HANDOFF], nextAction: raw.nextGate });
  write(INBOX, JSON.stringify(inbox, null, 2) + "\n");
  write(HANDOFF, `# Across HyperEVM CCTP build recovery Step 2 handoff\n\n- Classification: \`${raw.classification}\`; exactMatch=false; pipeline 1/5; gates 0/0/false; fork=false.\n- Retained creation ${usdc.creationSha256}; embedded normalized runtime ${usdc.runtimeTemplateSha256}; 15 immutable placements and zero links patch exactly to USDC ${usdc.patchedRetainedRuntimeSha256} and USDH ${usdh.patchedRetainedRuntimeSha256}.\n- Candidate commit ${CANDIDATE_COMMIT}; solc ${candidate.compiler.version}; optimizer 300/viaIR/Prague/IPFS/literal-content. Executable body matches, but full runtime differs in 32 CBOR IPFS digest bytes; exact gate fails.\n- Missing: Git objects 3680af8 and 15a19c0; IPFS metadata ${EXPECTED.activeMetadataCid}; exact standard-json/source closure. Actual deployed CCTP nonce/guard semantics remain unpromoted/null.\n- Tests ${checks}/${checks}; build PASS. Endpoint inventory/RPC/HTTP/web/fork/live/signing/broadcast/production mutation all zero.\n- Next gate: ${raw.nextGate}\n`);
  const leak = leakScan([RAW, BUILD, TESTS, REPORT, INBOX, HANDOFF]); write(LEAK, JSON.stringify(canonical(leak), null, 2) + "\n"); if (!leak.passed) throw new Error("leak-scan");
  const records = [SCANNER, VALIDATOR, BUILD, RAW, TESTS, LEAK, REPORT, INBOX, HANDOFF].map(hashFile);
  const aggregateSha256 = sha(Buffer.from(records.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n")));
  const predecessorFiles = [hashFile(STEP1_R2_MANIFEST), hashFile(STEP1_RAW), hashFile(USDC_RUN), hashFile(USDH_RUN)];
  const manifest = canonical({ schemaVersion: 1, runId: raw.runId, classification: raw.classification, exactMatch: false, algorithm: "sha256", aggregateSha256, records, predecessorFiles, predecessorAggregateSha256: sha(Buffer.from(predecessorFiles.map((row) => `${row.path}\0${row.bytes}\0${row.sha256}`).join("\n"))), tests: { checksPassed: checks, checksTotal: checks, buildPassed: true }, gates: { routePositive: 0, executableNow: 0, signedActionJustified: false, fork: false }, leakScanPassed: true, activityScope: raw.activityScope });
  write(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ ok: true, runId: raw.runId, classification: raw.classification, exactMatch: false, sourceCommit: CANDIDATE_COMMIT, compiler: candidate.compiler.version, settings: candidate.settings, checksPassed: checks, checksTotal: checks, retainedCreationSha256: usdc.creationSha256, retainedNormalizedRuntimeSha256: usdc.runtimeTemplateSha256, candidateNormalizedRuntimeSha256: candidate.artifact.normalizedRuntimeSha256, aggregateSha256, pipeline: "1/5", nextGate: raw.nextGate }) + "\n");
}

try { main(); } catch (error) { process.stderr.write(JSON.stringify({ ok: false, category: String(error.message || error) }) + "\n"); process.exit(1); }
