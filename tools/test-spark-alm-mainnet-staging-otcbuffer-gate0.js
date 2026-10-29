#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const ROOT = path.resolve(__dirname, "..");
const TARGET = path.join(ROOT, "targets", "spark-alm-controller-ce5cbd96");
const COMMIT = "ce5cbd96e2d7ff9c52b4e143ca74643b1680469c";
const rels = {
  capture: "reports/raw/critical/spark-alm-mainnet-staging-otcbuffer-gate0/capture.json",
  report: "reports/critical-spark-alm-mainnet-staging-otcbuffer-gate0.md",
  inbox: "coordination/inbox/critical/20260822-coordinator-spark-otcbuffer-gate0-terminal.json",
  handoff: "coordination/handoffs/20260822-coordinator-spark-otcbuffer-gate0-handoff.md"
};
let checks = 0; const ok = (v, m) => { checks++; assert.ok(v, m); };
const text = Object.fromEntries(Object.entries(rels).map(([k, v]) => [k, fs.readFileSync(path.join(ROOT, ...v.split("/")), "utf8")]));
const capture = JSON.parse(text.capture), inbox = JSON.parse(text.inbox);
ok(capture.status === "TERMINAL_STAGE1_TWO_FAMILY_QUALIFICATION_UNAVAILABLE", "terminal status");
ok(capture.stopStage === 1 && capture.stopReason === "TWO_QUALIFIED_FAMILIES_UNAVAILABLE", "stage1 stop");
ok(capture.pin === null && capture.qualification.commonFinalizedPin === null, "no invented pin");
ok(capture.gates.routePositive === "unknown" && capture.gates.executableNow === "unknown" && capture.gates.material === "unknown", "unknown gates");
ok(capture.gates.fork.justified === false && capture.gates.fork.signedAction === false && capture.gates.signedActionJustified === false, "no fork/signing");
ok(Object.values(capture.stages).every(x => x === "NOT_RUN_DUE_STAGE1_FAILURE"), "all downstream stages stopped");
ok(capture.accessDisposition === "ACCESS-BLOCKED" && capture.routeDisposition === "UNKNOWN", "orthogonal dispositions");
ok(capture.evidence.economics.status === "N/A" && capture.evidence.economics.result === "n/a", "economics unopened");
ok(text.report.includes("Signal: NO FINDING") && text.report.includes("TERMINAL ACCESS-BLOCKED STOP"), "report signal");
ok(inbox.routePositive === "unknown" && inbox.executableNow === "unknown" && inbox.signedActionJustified === false, "inbox gates");
ok(inbox.accessDisposition === "ACCESS-BLOCKED" && inbox.routeDisposition === "UNKNOWN", "inbox dispositions");
ok(text.handoff.includes("Downstream stages: not run"), "handoff stop");
ok(cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: TARGET, encoding: "utf8", windowsHide: true }).trim() === COMMIT, "exact commit");
ok(cp.execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: TARGET, encoding: "utf8", windowsHide: true }).trim() === "ab97575c59587c904aa8cb04554b2967b25a1f5d", "exact tree");
const source = cp.execFileSync("git", ["show", `${COMMIT}:src/MainnetController.sol`], { cwd: TARGET, encoding: "utf8", windowsHide: true });
ok(source.includes("_checkRole(RELAYER);") && source.includes("IERC20(assetToClaim).balanceOf(otcBuffer)"), "source observations anchored");
for (const [name, value] of Object.entries(text)) {
  ok(!/(?:https?|wss?):\/\//iu.test(value), `${name} has no URL`);
  ok(!/(?:private[_-]?key\s*[:=]|seed phrase|bearer\s+[a-z0-9]|"rpc(?:Url|Endpoint)"\s*:)/iu.test(value), `${name} has no secret/provider value marker`);
}
ok(capture.safety.transactions === false && capture.safety.signing === false && capture.safety.broadcast === false && capture.safety.fundMovement === false, "safety flags");
console.log(`PASS ${checks} checks`);
