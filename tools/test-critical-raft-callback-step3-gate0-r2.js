#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  ARTIFACT,
  MANIFEST,
  STATUS,
  assertImmutablePublication,
  clone,
  deriveStatus,
  validateArtifact,
  validateManifest
} = require("./validate-critical-raft-callback-step3-gate0-r2");

const ROOT = path.resolve(__dirname, "..");
const artifact = JSON.parse(fs.readFileSync(path.join(ROOT, ARTIFACT), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, MANIFEST), "utf8"));
let checks = 0;

function passes(fn, message) {
  checks += 1;
  assert.doesNotThrow(fn, message);
}

function rejectsArtifact(mutator, message) {
  checks += 1;
  const changed = clone(artifact);
  mutator(changed);
  assert.throws(() => validateArtifact(changed), message);
}

function rejectsManifest(mutator, message) {
  checks += 1;
  const changed = clone(manifest);
  mutator(changed);
  assert.throws(() => validateManifest(changed, artifact), message);
}

passes(() => validateArtifact(artifact), "baseline artifact");
passes(() => validateManifest(manifest, artifact), "baseline manifest");
passes(() => assertImmutablePublication([]), "exclusive first publication");
checks += 1;
assert.throws(() => assertImmutablePublication([ARTIFACT]), "replacement publication rejected");

rejectsArtifact((x) => { x.rows.pop(); }, "omitted row rejected");
rejectsArtifact((x) => { [x.rows[0], x.rows[1]] = [x.rows[1], x.rows[0]]; }, "reordered row rejected");
rejectsArtifact((x) => { x.rows[1] = clone(x.rows[0]); }, "duplicate row rejected");
rejectsArtifact((x) => { x.rows[0].candidate.compiledRuntimeBytecode = "0x00"; }, "runtime bytes rejected");
rejectsArtifact((x) => { x.rows[0].candidate.compiledRuntimeKeccak256 = x.rows[0].runtimeKeccak256; }, "compiled runtime hash rejected");
rejectsArtifact((x) => { x.rows[0].candidate.compiledCodeSize = x.rows[0].codeSize; }, "compiled runtime size rejected");
rejectsArtifact((x) => { x.rows[0].candidate.runtimeByteEquality = true; }, "byte equality rejected");
rejectsArtifact((x) => { x.rows[0].candidate.runtimeHashEquality = false; }, "hash equality claim rejected");
rejectsArtifact((x) => { x.rows[0].correspondence = "exact"; }, "exact row promotion rejected");
rejectsArtifact((x) => { x.rows[0].candidate.correspondence = "qualified"; }, "candidate correspondence change rejected");
rejectsArtifact((x) => { x.rows[0].candidate.contract = x.rows[1].candidate.contract; }, "candidate identity swap rejected");
rejectsArtifact((x) => { x.rows[0].candidate.sourcePath = x.rows[1].candidate.sourcePath; }, "candidate source swap rejected");
rejectsArtifact((x) => { x.rows[0].identityBasis = x.rows[1].identityBasis; }, "identity basis swap rejected");
rejectsArtifact((x) => { x.rows[0].candidate.controlFlow.hooks = "observed"; }, "source hook promotion rejected");
rejectsArtifact((x) => { x.rows[0].candidate.controlFlow.zeroValueBehavior = "observed"; }, "source zero promotion rejected");
rejectsArtifact((x) => { x.rows[0].deployedBehavior.ordinaryTransfer = "callback-free"; }, "deployed ordinary promotion rejected");
rejectsArtifact((x) => { x.rows[0].deployedBehavior.hooks = "observed"; }, "deployed hook promotion rejected");
rejectsArtifact((x) => { x.rows[0].deployedBehavior.recipientDependentExternalCalls = "absent"; }, "deployed recipient-call promotion rejected");
rejectsArtifact((x) => { x.rows[0].deployedBehavior.zeroValueBehavior = "reverts"; }, "deployed zero promotion rejected");
rejectsArtifact((x) => { x.inputBindings.pop(); }, "omitted input binding rejected");
rejectsArtifact((x) => { [x.inputBindings[0], x.inputBindings[1]] = [x.inputBindings[1], x.inputBindings[0]]; }, "reordered input binding rejected");
rejectsArtifact((x) => { x.inputBindings[1] = clone(x.inputBindings[0]); }, "duplicate input binding rejected");
rejectsArtifact((x) => { x.inputBindings[3].sha256 = "0".repeat(64); }, "Step1 report mutation rejected");
rejectsArtifact((x) => { x.sourceHashes.pop(); }, "source hash omission rejected");
rejectsArtifact((x) => { [x.sourceHashes[0], x.sourceHashes[1]] = [x.sourceHashes[1], x.sourceHashes[0]]; }, "source hash reorder rejected");
rejectsArtifact((x) => { x.buildConfig[1] = clone(x.buildConfig[0]); }, "build config duplicate rejected");
rejectsArtifact((x) => { x.predecessor.files.pop(); }, "predecessor binding omission rejected");
rejectsArtifact((x) => { x.buildProvenance.networkAttempted = false; }, "network attempt erasure rejected");
rejectsArtifact((x) => { x.buildProvenance.networkAuthorized = true; }, "network authorization promotion rejected");
rejectsArtifact((x) => { x.buildProvenance.retries = 1; }, "retry provenance mutation rejected");
rejectsArtifact((x) => { x.buildProvenance.transcriptBound = true; }, "transcript binding promotion rejected");
rejectsArtifact((x) => { x.buildProvenance.finalTargetStatus = []; }, "target status provenance mutation rejected");
rejectsArtifact((x) => { x.rMinterGate.blocked = false; }, "R Minter gate opening rejected");
rejectsArtifact((x) => { x.positionManager.redemption = clone(x.positionManager.managePosition); }, "concatenated PM path rejected");
rejectsArtifact((x) => { x.gates.routePositive = false; }, "route-negative promotion rejected");
rejectsArtifact((x) => { x.conclusion.runtimeMismatchClaim = true; }, "runtime mismatch claim rejected");

rejectsManifest((x) => { x.schemaVersion = 1; }, "manifest schema mutation rejected");
rejectsManifest((x) => { x.findingId = "wrong"; }, "manifest finding ID mutation rejected");
rejectsManifest((x) => { x.publication = "replace"; }, "manifest publication mutation rejected");
rejectsManifest((x) => { x.pin.number = "0"; }, "manifest pin mutation rejected");
rejectsManifest((x) => { x.artifactMetadata.exactRows = 1; }, "manifest artifact metadata mutation rejected");
rejectsManifest((x) => { x.reportBinding.sha256 = "0".repeat(64); }, "report-byte binding mutation rejected");
rejectsManifest((x) => { x.files.pop(); }, "manifest omitted binding rejected");
rejectsManifest((x) => { [x.files[0], x.files[1]] = [x.files[1], x.files[0]]; }, "manifest reordered binding rejected");
rejectsManifest((x) => { x.files[1] = clone(x.files[0]); }, "manifest duplicate binding rejected");

const callbackPositive = [{ correspondence: "exact", recipientCallback: true, ordinaryCallbackFree: false, zeroCallbackFree: false }];
checks += 1;
assert.strictEqual(deriveStatus(callbackPositive, { blocked: true }), STATUS, "R Minter block precedes positive other row");
checks += 1;
assert.strictEqual(deriveStatus(callbackPositive, { blocked: false }), "PASS_CALLBACK_COMPATIBLE_ADMIT", "positive status fixture sanity");

console.log(`PASS ${checks} Raft Gate0-R2 corrective mutation checks`);
