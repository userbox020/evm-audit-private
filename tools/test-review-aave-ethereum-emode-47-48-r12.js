#!/usr/bin/env node
"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const r = require("./review-aave-ethereum-emode-47-48-r12.js");
const html = r.read(r.PAGE, r.PAGE_SHA).toString("utf8"), logs = r.parsePage(html), a = r.authority();
const workflowId = "0x00c672ab84adbd3c64d17c7dd3fe67860b7a4da4f7d0d952d46989ce109b1933";

test("real page yields canonical router key and matches six retained eMode events", () => {
  const locator = r.validateEvents(logs, a);
  assert.equal(locator.workflowId, workflowId); assert.equal(locator.publishSelector, "0x031ed79c");
  assert.equal(locator.publishFunction, "publishBulkRiskParameterUpdates"); assert.equal(locator.linkedExistingEventCount, 6);
  assert.deepEqual(logs.map(row => row.logIndex), [134, 135, 136, 137, 138, 139, 140, 141]);
});
test("transaction mismatch, wrong block and duplicate log markers are rejected", () => {
  assert.throws(() => r.parsePage(html.replace(`>${r.TX}</span>`, `>0x${"0".repeat(64)}</span>`)), /PAGE_TRANSACTION_MISMATCH/);
  assert.throws(() => r.parsePage(html.replace(/\/block\/25915775/g, "/block/1")), /PAGE_TRANSACTION_MISMATCH/);
  assert.throws(() => r.parsePage(html.replace("id='logI_135'", "id='logI_134'")), /LOG_MARKERS_INVALID/);
});
test("wrong emitter, reordered events, extra topics and noncanonical data cannot establish a locator", () => {
  for (const change of [x => { x[0].address = a.addresses.hub; }, x => { [x[1], x[2]] = [x[2], x[1]]; },
    x => { x[0].topics.push(`0x${"0".repeat(64)}`); }, x => { x[0].data += "00"; }]) {
    const changed = structuredClone(logs); change(changed); assert.throws(() => r.validateEvents(changed, a));
  }
});
test("router events must agree on workflow key and oracle target", () => {
  const changed = structuredClone(logs); changed[7].topics[1] = `0x${"1".repeat(64)}`;
  assert.throws(() => r.validateEvents(changed, a), /WORKFLOW_DISAGREEMENT/);
  const target = structuredClone(logs); target[0].topics[2] = `0x${"0".repeat(24)}${a.addresses.hub.slice(2)}`;
  assert.throws(() => r.validateEvents(target, a), /ROUTED_TARGET_MISMATCH/);
});
test("a matching key cannot hide different eMode values or update IDs", () => {
  const changed = structuredClone(logs); changed[1].data = `0x${"0".repeat(63)}5${changed[1].data.slice(66)}`;
  assert.throws(() => r.validateEvents(changed, a), /INJECTION_CONTEXT_MISMATCH/);
  const category = structuredClone(logs); category[2].topics[1] = category[5].topics[1];
  assert.throws(() => r.validateEvents(category, a), /CATEGORY_CONTEXT_MISMATCH/);
});
test("next scope is eight ABI-derived views for only this router and workflow", () => {
  const report = r.prepare(), scope = report.proposedReadScope;
  assert.equal(scope.status, "SCOPED_NOT_IMPLEMENTED_OR_RUN"); assert.equal(scope.routerViews.length, 8);
  assert.equal(scope.statePin.number, 25930340);
  for (const view of scope.routerViews) {
    assert.equal(view.target, a.addresses.router); assert.equal(view.abi.stateMutability, "view");
    assert.deepEqual(view.args, view.abi.inputs.length ? [workflowId] : []);
  }
  assert.equal(report.gates.workflowEventsCorroborated, false); assert.equal(report.execution.rpcRequests, 0);
});
test("local publication is append-only and every report gate is rederived", () => {
  const root = fs.mkdtempSync("C:/Users/MiPC/AppData/Local/Temp/opencode/emode-r12-");
  fs.mkdirSync(path.join(root, "reports/raw/fast"), { recursive: true });
  try {
    const envelope = r.publish(root), result = r.verify(root);
    assert.equal(result.workflowId, workflowId); assert.equal(result.reportCommitment, envelope.sha256);
    assert.throws(() => r.publish(root), /OUTPUT_EXISTS/);
    for (const key of Object.keys(envelope.report.gates)) {
      const changed = structuredClone(envelope.report); changed.gates[key] = changed.gates[key] === true ? false : true;
      assert.throws(() => r.validate(changed), /REPORT_MISMATCH/);
    }
    const changed = structuredClone(envelope.report); changed.executionContext.newWorkflowEventEvidence = "corroborated";
    assert.throws(() => r.validate(changed), /REPORT_MISMATCH/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
