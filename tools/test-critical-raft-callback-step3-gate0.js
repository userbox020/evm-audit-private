#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  assertImmutablePublication,
  clone,
  deriveStatus,
  validateArtifact
} = require("./validate-critical-raft-callback-step3-gate0");

const ROOT = path.resolve(__dirname, "..");
const artifact = JSON.parse(fs.readFileSync(path.join(ROOT, "reports/raw/fast/critical-raft-callback-cross-entry-step3-gate0.json"), "utf8"));
const step2 = JSON.parse(fs.readFileSync(path.join(ROOT, "reports/raw/fast/critical-raft-callback-cross-entry-step2-capture.json"), "utf8"));
let checks = 0;

function passes(fn, message) {
  checks += 1;
  assert.doesNotThrow(fn, message);
}

function rejects(mutator, message) {
  checks += 1;
  const changed = clone(artifact);
  mutator(changed);
  assert.throws(() => validateArtifact(changed, step2), message);
}

passes(() => validateArtifact(artifact, step2), "baseline artifact validates");
passes(() => assertImmutablePublication([]), "new exclusive publication accepted");
checks += 1;
assert.throws(() => assertImmutablePublication(["already-exists"]), "immutable publication replacement rejected");

rejects((x) => x.rows.pop(), "row deletion rejected");
rejects((x) => [x.rows[0], x.rows[1]] = [x.rows[1], x.rows[0]], "row reordering rejected");
rejects((x) => { x.rows[0].address = x.rows[1].address; }, "captured address mutation rejected");
rejects((x) => { x.rows[0].root = x.rows[1].claim; }, "captured root mutation rejected");
rejects((x) => { x.rows[0].claim = x.rows[1].claim; }, "captured claim mutation rejected");
rejects((x) => { x.rows[0].debt = x.rows[1].debt; }, "captured debt mutation rejected");
rejects((x) => { x.rows[0].enabled = false; }, "captured enabled mutation rejected");
rejects((x) => { x.rows[0].runtimeKeccak256 = x.rows[1].runtimeKeccak256; }, "captured runtime hash mutation rejected");
rejects((x) => { x.rows[0].codeSize += 1; }, "captured code-size mutation rejected");
rejects((x) => { x.rows[0].proxy.implementation = x.rows[0].root; }, "captured proxy mutation rejected");
rejects((x) => { x.rows[0].evidencePaths[0] = "wrong"; }, "evidence path mutation rejected");
rejects((x) => { x.rows[0].candidates[0].correspondence = "exact"; }, "exact promotion without runtime equality rejected");
rejects((x) => { x.rows[0].candidates[0].runtimeByteEquality = true; }, "partial equality promotion rejected");
rejects((x) => { x.rows[0].candidates[0].controlFlow.zeroValueBehavior = "assumed"; }, "implicit zero behavior rejected");
rejects((x) => { x.rows[0].candidates[0].sourceEvidence[0].startLine = 90; }, "source-line mutation rejected");
rejects((x) => { x.positionManagerOrdering.reverse(); }, "PositionManager ordering mutation rejected");
rejects((x) => { x.rMinterGate.blocked = false; }, "R Minter gate opening rejected");
rejects((x) => { x.witness.feeRecipientWitnessExcluded = false; }, "fee-recipient witness promotion rejected");
rejects((x) => { x.witness.scope = "deployed"; }, "source-local witness scope mutation rejected");
rejects((x) => { x.publicValuePath.externalMarketExit = "observed"; }, "market exit promotion rejected");
rejects((x) => { x.gates.routePositive = true; }, "route promotion rejected");
rejects((x) => { x.gates.economics = "ASSESSED"; }, "economics promotion rejected");
rejects((x) => { x.pin.deploymentCurrentClaim = true; }, "deployment-current promotion rejected");
rejects((x) => { x.prohibitedOperations.networkAuthorized = true; }, "network authorization mutation rejected");
rejects((x) => { x.prohibitedOperations.protectedAccessAuthorized = true; }, "protected-access mutation rejected");
rejects((x) => { x.prohibitedOperations.dependencyDownloadAuthorized = true; }, "download authorization mutation rejected");
rejects((x) => { x.prohibitedOperations.forkPerformed = true; }, "fork mutation rejected");
rejects((x) => { x.prohibitedOperations.transactionPerformed = true; }, "transaction mutation rejected");
rejects((x) => { x.rows[0].standardCallbackIndicatorAbsenceIsCallbackFreeProof = true; }, "indicator absence promotion rejected");
rejects((x) => { x.selfSha256 = "00"; }, "artifact self-hash rejected");
rejects((x) => { x.status = "PASS_CALLBACK_COMPATIBLE_ADMIT"; }, "unsupported status promotion rejected");

checks += 1;
assert.strictEqual(deriveStatus(artifact), "BLOCKED_RUNTIME_SOURCE_CONTINUITY", "blocked status derived");
console.log(`PASS ${checks} Raft Step3 Gate0 mutation checks`);
