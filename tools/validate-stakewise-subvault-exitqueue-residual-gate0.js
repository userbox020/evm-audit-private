#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const STEM = "stakewise-subvault-exitqueue-residual-gate0";
const OUT = path.join(ROOT, "reports", "raw", "fast", STEM);
const FINAL_VERDICT = "GATE0_INCOMPLETE_RUNTIME_BINDING_POSITIVE_STATE_SIGNALS_UNADMITTED";
const rel = (value) => path.relative(ROOT, value).replaceAll("\\", "/");
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const stable = (value) => Array.isArray(value) ? `[${value.map(stable).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}` : JSON.stringify(value);
let checks = 0;
function check(value, code) { checks++; if (!value) throw new Error(code); }
function readStrictJson(file) { const bytes = fs.readFileSync(file); check(bytes.length > 1 && bytes.at(-1) === 10, `JSON_NEWLINE:${rel(file)}`); const text = bytes.toString("utf8"); check(!text.startsWith("\uFEFF"), `JSON_BOM:${rel(file)}`); const value = JSON.parse(text); check(value && typeof value === "object" && !Array.isArray(value), `JSON_ROOT:${rel(file)}`); return { bytes, value }; }
function sum(rows, fn) { return rows.reduce((total, row) => total + BigInt(fn(row)), 0n); }
function validateLedger(ledger, from, to) { let expected = BigInt(from); for (const row of ledger) { check(BigInt(row.fromBlock) === expected, "LEDGER_GAP"); check(BigInt(row.toBlock) >= expected, "LEDGER_REVERSED"); check(BigInt(row.inclusiveWidth) === BigInt(row.toBlock) - BigInt(row.fromBlock) + 1n, "LEDGER_WIDTH"); check(/^[0-9a-f]{64}$/u.test(row.commitment), "LEDGER_COMMITMENT"); expected = BigInt(row.toBlock) + 1n; } check(expected === BigInt(to) + 1n, "LEDGER_TERMINAL"); }
function lineageResolved(events, child, targetTicket) { let ticket = targetTicket; for (let i = events.length - 1; i >= 0; i--) { const row = events[i]; if (row.child !== child) continue; if (row.type === "ExitedAssetsClaimed" && row.newPositionTicket === ticket) ticket = row.prevPositionTicket; else if (row.type === "ExitQueueEntered" && row.positionTicket === ticket) return true; } return false; }
function rowKey(row) { return `${row.kind}|${row.address}|${row.code.keccak256}`; }

const EXPECTED_UNMATCHED = Object.freeze({
  ethereum: [
    "vaults-registry|0x3a0008a588772446f6e656133c2d5029cc4fc20e|0xfea640fe67d9867f0feb82794b496e3d0f9812fe56493eb8eab3d33b4c3194ba",
    "meta-factory-other-registry-caller-or-factory|0x6107db0bdd84023228e0ab11099190e88b073c1d|0xb6de9ac923974145a7d621635b8b27095cc21a164c09a1fed704f608e93be9a6",
    "meta-factory-implementation-other-registry-caller-or-factory|0xd0d527b67186d8880f9427ea4cf9847e89bce764|0xbbdac95302b3f038ecfc6fed57da007e2b94647253a137e966f73aec41762249",
    "child-proxy|0xac0f906e433d58fa868f936e8a43230473652885|0x95341690861a566af190df6392bba32f9f9645191a89ddd9252ffa8c061b624b",
    "child-implementation|0xf113bfd6423291b1dd2ca76f897bff54456e7c88|0x0163dff0145d814a24df66ec2c1037cd2afbdf5811536f0c9645d16d2742706a",
    "child-implementation|0xd2037ca73ed58b3f97f471ade4384ac52ee7becc|0x34d5189d3785222b4a1e81e176afb98669d6f0bc51456c2a7b03d84f67ca16db",
    "child-proxy|0xb36fc5e542cb4fc562a624912f55da2758998113|0x95341690861a566af190df6392bba32f9f9645191a89ddd9252ffa8c061b624b",
    "child-implementation|0x927a83c679a5e1a6435d6bfaef7f20d4db23e2cc|0xe6381554eb02cdb8fa2814920f1af952ed1580d43877f357045910fbad0ea20f",
    "child-proxy|0xa8cb2e35f594b308726b242136f0a8995bf19e97|0x95341690861a566af190df6392bba32f9f9645191a89ddd9252ffa8c061b624b",
    "child-proxy|0x8a93a876912c9f03f88bc9114847cf5b63c89f56|0x95341690861a566af190df6392bba32f9f9645191a89ddd9252ffa8c061b624b",
    "child-proxy|0xe6d8d8ac54461b1c5ed15740eee322043f696c08|0x95341690861a566af190df6392bba32f9f9645191a89ddd9252ffa8c061b624b",
    "child-proxy|0x089a97a8bc0c0f016f89f9cf42181ff06afb2daf|0x95341690861a566af190df6392bba32f9f9645191a89ddd9252ffa8c061b624b",
    "child-proxy|0x1b3ce55dde0e0d4b9a200855406e7b14334c10b0|0x95341690861a566af190df6392bba32f9f9645191a89ddd9252ffa8c061b624b"
  ],
  gnosis: [
    "vaults-registry|0x7d014b3c6ee446563d4e0cb6fbd8c3d0419867cb|0xa4032e5c6e1068f17d6d856e2774a2759fee1ab0df359a2a222f71cbe9db40a7",
    "sub-registry-implementation-current|0x3dec6026137010783571697b98011c4c01010895|0x12f6ca38ec73ffa92ce9d3156d2fd9704c69d71da43e3d862a97f548cb8d3e62",
    "sub-registry-implementation-predecessor|0x9778317a6f6ff0224e8c1dd30af71e1e25edc5d1|0xd159e3828b948dd094e7922e227a5b45d9be62271aa6b7c14a4c05c5d20d9482",
    "meta-factory-other-registry-caller-or-factory|0x6107db0bdd84023228e0ab11099190e88b073c1d|0xda40ea206e1b2bc1fbae30ed9658e279cbf3cf53feb37f71645e1d9399cc9695",
    "meta-factory-implementation-other-registry-caller-or-factory|0xd0d527b67186d8880f9427ea4cf9847e89bce764|0x65215bdb080a712c9cbc1ee0c8c77080dcc032e5ac20792cd2dd49dbf1f47080",
    "meta-factory-removed-predecessor-meta-factory|0x75e6f7640137c128c91de4ee62f6f30b542e5f1b|0x627b46f69458cd5e30a7f6513df995425d23c4e232ad626253634416e8dd1483",
    "meta-factory-implementation-removed-predecessor-meta-factory|0x0ba13125fc3a300538bb890529182df7ccc5a19b|0x453c0bb0090c680eea642dabc339fc390154e0babd87686b06b435bcf324191c",
    "parent-implementation|0x6f59ae1dd36eed6d7a928505f754b2965197c8e5|0x3aac7d7922313e3d1a5fafe005de2dfd3a2cb55bb7ba37e4827aa576145975a7",
    "sub-registry-implementation|0x3dec6026137010783571697b98011c4c01010895|0x12f6ca38ec73ffa92ce9d3156d2fd9704c69d71da43e3d862a97f548cb8d3e62",
    "child-implementation|0x6f59ae1dd36eed6d7a928505f754b2965197c8e5|0x3aac7d7922313e3d1a5fafe005de2dfd3a2cb55bb7ba37e4827aa576145975a7",
    "child-proxy|0x4b4406ed8659d03423490d8b62a1639206da0a7a|0x95341690861a566af190df6392bba32f9f9645191a89ddd9252ffa8c061b624b",
    "child-implementation|0xf113bfd6423291b1dd2ca76f897bff54456e7c88|0x00a2232ae1087dae45c97723527e6dc7c95240c9b95ed5e2baa8353ba97511bc"
  ]
});

function recomputeSummary(chain) {
  const parents = chain.state.parents;
  const material = parents.filter((x) => BigInt(x.totalAssets) >= 10n ** BigInt(chain.state.observedAssetDecimals));
  const patchLag = material.filter((x) => !x.runtimeBinding.currentPatchExact);
  const mismatches = material.filter((x) => !x.invariants.pass || !x.invariants.coveragePass || !x.invariants.childShareAccountingPass);
  const boundaries = parents.flatMap((x) => x.publicOneTicketComposition.activeBoundaries);
  return {
    vaultAddedEvents: chain.state.vaultEventCount,
    registeredVaults: chain.state.uniqueRegisteredVaults,
    duplicateVaultAddedEvents: chain.state.duplicateVaultAddedEvents,
    metaVaultParents: parents.length,
    materialMetaVaultParents: material.length,
    childVaults: parents.reduce((n, x) => n + x.children.length, 0),
    activeRegistryExitPositions: parents.reduce((n, x) => n + x.children.reduce((m, c) => m + c.registryState.positions.length, 0), 0),
    materialPatchLagParents: patchLag.length,
    materialResidualOrCoverageMismatchParents: mismatches.length,
    residualOrCoverageMismatchParents: mismatches.length,
    activePublicOneTicketBoundaries: boundaries.length,
    maximumCurrentProtocolOwnedExposureRaw: parents.reduce((n, x) => n + BigInt(x.publicOneTicketComposition.maximumCurrentProtocolOwnedExposureRaw), 0n).toString(),
    assetDecimals: chain.state.observedAssetDecimals,
    exactRelevantRuntimes: chain.runtime.rows.filter((x) => x.match.exact).length,
    relevantRuntimes: chain.runtime.rows.length,
    graphExact: chain.runtime.rows.every((x) => x.match.exact) && parents.every((x) => x.runtimeBinding.exact),
    gatePositive: patchLag.length > 0 || mismatches.length > 0 || boundaries.length > 0
  };
}

function main() {
  check(process.argv.length === 2, "ARGV");
  const capturePath = path.join(OUT, "capture.json"), testsPath = path.join(OUT, "tests.json");
  const captureRead = readStrictJson(capturePath), testsRead = readStrictJson(testsPath), capture = captureRead.value, tests = testsRead.value;
  const captureHash = sha256(captureRead.bytes);
  check(captureHash.startsWith("51aa5c"), "CAPTURE_HASH_PREFIX");
  check(capture.schemaVersion === 3, "SCHEMA"); check(capture.captureId === STEM, "CAPTURE_ID"); check(tests.status === "PASS" && tests.assertions > 0, "TESTS");
  check(capture.source.current.commit === "fc70cbe1b3d41bc5f78434830d837aa270ca33bc", "CURRENT_COMMIT");
  check(capture.source.current.tree === "032d433ceaa40bf20dd9d49c66dcd38189241fc9", "CURRENT_TREE");
  check(capture.source.predecessor.commit === "31b2da5e9c729b00ead0db16369141608410bee8", "PRIOR_COMMIT");
  check(capture.source.predecessor.tree === "6d7aa79dc7f1d00c883edb5d456787491ce8a698", "PRIOR_TREE");
  check(capture.source.compilerProof.storageLayouts.length === 4, "LAYOUT_COUNT");
  for (const layout of capture.source.compilerProof.storageLayouts) { check(layout.p.slot === "11" && layout.p.offset === 0 && layout.p.type === "uint256", "P_LAYOUT"); check(layout.subVaultState[0].offset === 0 && layout.subVaultState[1].offset === 16, "STATE_LAYOUT"); check(/^[0-9a-f]{64}$/u.test(layout.artifactSha256), "ARTIFACT_HASH"); }
  check(capture.source.compilerProof.packing.positionTicketBits === 160 && capture.source.compilerProof.packing.sharesBits === 96, "EXIT_PACKING");
  check(capture.source.manifests.verifiedAgainstExactSource && capture.source.manifests.governorFactorySetsVerified && capture.source.manifests.expectedVersionsVerified, "MANIFEST_PROOF");

  const chains = Object.entries(capture.chains).sort(([a], [b]) => a.localeCompare(b));
  check(stable(chains.map(([name, x]) => [name, x.chainId])) === stable([["ethereum", "1"], ["gnosis", "100"]]), "CHAINS");
  const recomputed = {};
  let activePositions = 0, resolvedLineages = 0, currentOneTicketBoundaries = 0;
  for (const [name, chain] of chains) {
    check(/^0x[0-9a-f]{64}$/u.test(chain.pin.hash) && /^0x[0-9a-f]{64}$/u.test(chain.pin.stateRoot), `${name}_PIN`);
    check(chain.statePin.blockHash === chain.pin.hash && chain.statePin.requireCanonical === true, `${name}_EIP1898`);
    check(chain.qualification.selectedFamilies === 2 && chain.qualification.independent === true, `${name}_FAMILIES`);
    check(chain.history.twoFamilyExact === true, `${name}_HISTORY_EQUALITY`);
    validateLedger(chain.history.ledger, chain.deployment.blockNumber, chain.pin.number);
    check(chain.history.eventCount === chain.history.events.length, `${name}_EVENT_COUNT`);
    check(chain.history.vaultAddedCount === chain.history.events.filter((x) => x.type === "VaultAdded").length, `${name}_VAULT_EVENTS`);
    check(chain.history.factoryAddedCount === chain.history.events.filter((x) => x.type === "FactoryAdded").length, `${name}_FACTORY_ADDS`);
    check(chain.history.factoryRemovedCount === chain.history.events.filter((x) => x.type === "FactoryRemoved").length, `${name}_FACTORY_REMOVES`);
    check(chain.terminalRecheck.familyA && chain.terminalRecheck.familyB && chain.terminalRecheck.fixedHashAndHeaderExact, `${name}_TERMINAL`);
    check(chain.state.observedAssetDecimals === 18 && chain.summary.assetDecimals === 18, `${name}_DECIMALS`);
    check(chain.state.currentVaultMembershipTrueCount === chain.state.uniqueRegisteredVaults, `${name}_MEMBERSHIP`);
    for (const parent of chain.state.parents) {
      const Q = BigInt(parent.exitQueue.queuedShares), E = BigInt(parent.exitQueue.totalExitedTickets), P = BigInt(parent.registryState.totalProcessedExitQueueTickets), residual = (P > E ? P : E) - E;
      check(BigInt(parent.invariants.residual) === residual, `${name}_RESIDUAL_VALUE`); check(parent.invariants.pass === (residual <= Q), `${name}_RESIDUAL_PASS`);
      check(BigInt(parent.invariants.unresolvedTickets) === (residual <= Q ? Q - residual : 0n), `${name}_UNRESOLVED`);
      let positionAssets = 0n;
      for (const child of parent.children) {
        const packedShares = sum(child.registryState.positions, (x) => x.shares), packedAssets = sum(child.registryState.positions, (x) => x.assetsAtCurrentRate);
        check(BigInt(child.registryState.queuedShares) === packedShares, `${name}_QUEUED_PACKED`); check(BigInt(child.registryState.positionAssets) === packedAssets, `${name}_POSITION_ASSETS`); check(child.registryState.stakedShares === child.parentSharesView, `${name}_STAKED_SHARES`); check(child.implementation === child.implementationSlot, `${name}_CHILD_SLOT`);
        positionAssets += packedAssets;
        for (const position of child.registryState.positions) { activePositions++; check(position.timestamp !== null, `${name}_POSITION_TIMESTAMP`); check(lineageResolved(parent.protocolExitHistory.events, child.address, position.positionTicket), `${name}_POSITION_LINEAGE`); resolvedLineages++; if (position.oneTicketBoundary === true) currentOneTicketBoundaries++; }
      }
      check(BigInt(parent.invariants.childPositionAssets) === positionAssets, `${name}_CHILD_POSITION_ASSETS`);
      check(BigInt(parent.invariants.coverageAssets) === positionAssets + BigInt(parent.withdrawableAssets), `${name}_COVERAGE_EQUATION`);
      check(parent.invariants.coveragePass === (BigInt(parent.invariants.coverageAssets) >= BigInt(parent.invariants.unresolvedAssets)), `${name}_COVERAGE_PASS`);
      check(parent.implementation === parent.implementationSlot, `${name}_PARENT_SLOT`);
      const exactExpected = Boolean(parent.runtimeBinding.parent?.exact && parent.runtimeBinding.registry?.exact && parent.runtimeBinding.parentImmutableContainsExpectedFactory && parent.runtimeBinding.registryImplementationEqualsExpectedFactoryImplementation && parent.runtimeBinding.assetTokenImmutableExact);
      check(parent.runtimeBinding.exact === exactExpected, `${name}_PARENT_BINDING_FORMULA`);
      const patchExpected = BigInt(parent.version) === BigInt(parent.expectedVersion) && parent.runtimeBinding.parentCurrentSource && parent.runtimeBinding.registryCurrentSource && parent.runtimeBinding.registryImplementationEqualsExpectedFactoryImplementation;
      check(parent.runtimeBinding.currentPatchExact === patchExpected, `${name}_PATCH_FORMULA`);
      check(parent.protocolExitHistory.activeLineageComplete === true, `${name}_LINEAGE_FLAG`);
      check(parent.publicOneTicketComposition.selector === "0xe620196c" && parent.publicOneTicketComposition.callerGuard === "none-beyond-nonReentrant", `${name}_PUBLIC_CLAIM`);
      check(parent.publicOneTicketComposition.count === parent.publicOneTicketComposition.activeBoundaries.length, `${name}_BOUNDARY_COUNT`);
      for (const boundary of parent.publicOneTicketComposition.activeBoundaries) { check(boundary.arbitraryCaller === true && boundary.liveClaimPerformed === false, `${name}_NO_LIVE_CLAIM`); check(BigInt(boundary.maxCurrentTicketAssets) >= BigInt(boundary.floorCurrentTicketAssets), `${name}_ROUNDING_INTERVAL`); }
    }
    check(chain.runtime.relevantRuntimeCount === chain.runtime.rows.length, `${name}_RUNTIME_COUNT`);
    check(chain.runtime.exactRelevantRuntimeCount === chain.runtime.rows.filter((x) => x.match.exact).length, `${name}_EXACT_RUNTIME_COUNT`);
    check(chain.runtime.allRelevantExact === chain.runtime.rows.every((x) => x.match.exact), `${name}_ALL_RUNTIME_EXACT`);
    check(chain.runtime.parentBackPointersExact === chain.state.parents.every((x) => x.runtimeBinding.exact), `${name}_BACKPOINTER_EXACT`);
    const unmatched = chain.runtime.rows.filter((x) => !x.match.exact).map(rowKey);
    check(stable(unmatched) === stable(EXPECTED_UNMATCHED[name]), `${name}_UNMATCHED_ROWS`);
    recomputed[name] = recomputeSummary(chain);
    check(stable(recomputed[name]) === stable(chain.summary), `${name}_SUMMARY`);
  }
  check(activePositions === capture.totals.activeRegistryExitPositions && resolvedLineages === activePositions, "ACTIVE_LINEAGES");
  check(currentOneTicketBoundaries === 0 && capture.totals.activePublicOneTicketBoundaries === 0, "ZERO_ONE_TICKET");

  const totals = capture.totals;
  for (const field of ["vaultAddedEvents", "registeredVaults", "metaVaultParents", "materialMetaVaultParents", "childVaults", "activeRegistryExitPositions", "materialPatchLagParents", "residualOrCoverageMismatchParents", "activePublicOneTicketBoundaries"]) check(totals[field] === chains.reduce((s, [name]) => s + recomputed[name][field], 0), `TOTAL_${field}`);
  const positiveStateSignals = chains.some(([name]) => recomputed[name].gatePositive), graphExact = chains.every(([name]) => recomputed[name].graphExact), gate1 = positiveStateSignals && graphExact;
  check(positiveStateSignals === true && graphExact === false && gate1 === false, "FAIL_CLOSED_CLASSIFICATION");
  check(capture.gate1Justified === gate1, "GATE0_DECISION");
  check(capture.gates.routePositive === "unknown" && capture.gates.routeDisposition === "UNKNOWN" && capture.gates.executableNow === "false", "CANONICAL_GATES");
  check(capture.gates.signedActionJustified === false && capture.gates.fork.justified === false && capture.gates.fork.signedAction === false, "SAFETY_GATES");
  check(capture.safety.readOnly && !capture.safety.transactions && !capture.safety.fork && !capture.safety.signing && !capture.safety.broadcast && !capture.safety.mutation && !capture.safety.liveClaim, "SAFETY");
  const serialized = JSON.stringify(capture); check(!/(?:https?|wss?):\/\//iu.test(serialized), "URL_LEAK"); check(!/"(?:endpoint|hostname|domain|headers|rpcUrl|rawResponse|providerFamily)"\s*:/iu.test(serialized), "PROVIDER_LEAK");

  const reportPath = path.join(ROOT, "reports", "critical-stakewise-subvault-exitqueue-residual-gate0.md");
  const reportText = fs.readFileSync(reportPath, "utf8"); check(reportText.includes(FINAL_VERDICT), "REPORT_VERDICT"); check(reportText.includes("0x34284c27a2304132af751b0dec5bba2cf98ed039"), "REPORT_RESIDUAL_PARENT"); check(reportText.includes("0x6f59ae1dd36eed6d7a928505f754b2965197c8e5"), "REPORT_GNOSIS_IMPL");
  const artifactPaths = [
    capturePath, testsPath,
    path.join(ROOT, "tools", "capture-stakewise-subvault-exitqueue-residual-gate0.js"),
    path.join(ROOT, "tools", "test-stakewise-subvault-exitqueue-residual-gate0.js"),
    path.join(ROOT, "tools", "validate-stakewise-subvault-exitqueue-residual-gate0.js"),
    reportPath,
    path.join(ROOT, "coordination", "inbox", "critical", "20260821-coordinator-stakewise-subvault-exitqueue-residual-gate0-terminal.json"),
    path.join(ROOT, "coordination", "handoffs", "20260821-coordinator-stakewise-subvault-exitqueue-residual-gate0-terminal.md")
  ];
  const artifacts = artifactPaths.map((file) => { check(fs.existsSync(file), `MISSING:${rel(file)}`); const bytes = fs.readFileSync(file); return { path: rel(file), bytes: bytes.length, sha256: sha256(bytes) }; });
  const manifest = { schemaVersion: 1, manifestId: STEM, generatedAt: new Date().toISOString(), captureSha256: captureHash, testsSha256: sha256(testsRead.bytes), artifacts, packageCommitment: sha256(Buffer.from(stable(artifacts))) };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`); fs.writeFileSync(path.join(OUT, "manifest.json"), manifestBytes);
  const unmatchedRuntimeRows = Object.fromEntries(chains.map(([name, chain]) => [name, chain.runtime.rows.filter((x) => !x.match.exact).map((x) => ({ role: x.kind, address: x.address, codeKeccak256: x.code.keccak256 }))]));
  const validation = { schemaVersion: 2, validatorId: STEM, generatedAt: new Date().toISOString(), status: "PASS", checks, captureStatusPreservedLegacy: capture.status, finalVerdict: FINAL_VERDICT, positiveStateSignals, graphExact, admittedPassCondition: false, gate1Justified: false, routePositive: "unknown", executableNow: "false", activePositions, activePositionLineagesResolved: resolvedLineages, activePublicOneTicketBoundaries: currentOneTicketBoundaries, summaries: recomputed, totals, unmatchedRuntimeRows, captureSha256: captureHash, manifestSha256: sha256(manifestBytes), packageCommitment: manifest.packageCommitment, strictJson: true, hashesValid: true, sanitization: "PASS", fork: false, transactions: false, signing: false };
  fs.writeFileSync(path.join(OUT, "validation.json"), `${JSON.stringify(validation, null, 2)}\n`);
  console.log(JSON.stringify(validation));
}

try { main(); } catch (error) { console.error(JSON.stringify({ status: "FAIL", code: String(error.message || "VALIDATION") })); process.exitCode = 1; }
