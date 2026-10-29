#!/usr/bin/env node
"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const R = require("./capture-critical-yearn-v3-withdrawal-queue-effective-liquidity-step3.js");

let checks = 0;
function check(value, message) { checks += 1; if (!value) throw new Error(`VALIDATION_${checks}:${message}`); }
function equal(actual, expected, message) { check(R.stable(actual) === R.stable(expected), `${message}:${R.stable(actual)}`); }
function read(relative) { return fs.readFileSync(R.rel(relative)); }
function json(relative) { return JSON.parse(read(relative).toString("utf8")); }

function validate() {
  check(process.argv.length === 2, "validator takes no arguments");
  for (const script of [R.PATHS.runner,R.PATHS.tests,R.PATHS.validator]) {
    const syntax = childProcess.spawnSync(process.execPath,["--check",R.rel(script)],{cwd:R.ROOT,encoding:"utf8",env:{}});
    equal([syntax.status,syntax.stdout,syntax.stderr],[0,"",""],`${script} syntax`);
  }

  const prepared = R.preflight();
  equal(prepared.manifest.status,R.STATUS,"manifest status");
  equal(prepared.review.status,R.STATUS,"review status");
  equal(prepared.source,{ path:R.SOURCE_REL,bytes:R.SOURCE_BYTES,sha256:R.SOURCE_SHA256,sourceCommit:R.SOURCE_COMMIT,apiVersion:"3.0.4",compilerDirective:"0.3.7",selectors:R.SELECTORS },"source authority");
  equal(prepared.manifest.components.map((row)=>row.path),[R.PATHS.runner,R.PATHS.tests,R.PATHS.validator,R.PATHS.authority,R.PATHS.publicEvidence,R.PATHS.report,R.PATHS.inbox,R.PATHS.handoff],"cycle-free component order");
  check(!prepared.manifest.components.some((row)=>[R.PATHS.packageManifest,R.PATHS.reviewPackage].includes(row.path)),"manifest excludes manifest and review cycle");
  check(/^[0-9a-f]{64}$/u.test(prepared.manifest.packageDigest),"package digest shape");
  check(/^[0-9a-f]{64}$/u.test(prepared.packageManifestSha256),"manifest hash shape");

  const authority = json(R.PATHS.authority), evidence = json(R.PATHS.publicEvidence), inbox = json(R.PATHS.inbox);
  equal(authority.status,R.STATUS,"authority status"); equal(evidence.status,R.STATUS,"evidence status"); equal(inbox.status,R.STATUS,"inbox status");
  equal(authority.source.commit,R.SOURCE_COMMIT,"source commit"); equal(authority.source.sha256,R.SOURCE_SHA256,"source hash");
  equal(authority.source.bytes,R.SOURCE_BYTES,"source bytes"); equal(authority.abi.selectors,R.SELECTORS,"selectors");
  equal(authority.abi.strategyParamsOrder,["activation","last_report","current_debt","max_debt"],"tuple order");
  equal(authority.semantics.defaultQueueCoverageCompleteOnlyWhenUseDefaultQueueTrueAndFrozenListExactlyEqualsQueueAndEveryEntryActiveAndRead,true,"default queue scope authority");
  equal([authority.semantics.completeActiveStrategySetAuthorityPresent,authority.semantics.completeActiveStrategySetMayBeClaimed],[false,false],"active set authority absent");
  equal(authority.semantics.customQueueCoverageDispositionWithoutSeparateAuthority,"CAPTURE_INCOMPLETE","custom queue disposition");
  equal(authority.runtimeAuthority.positiveRuntimeSourceBindingAllowed,false,"runtime binding fail closed");
  equal(authority.fixReference.v3_1CommitCandidateFact,R.FIX_COMMIT,"fix fact");
  equal(authority.fixReference.usedAsRuntimeAuthority,false,"fix not authority");
  equal(evidence.targets.map((row)=>row.vault),R.TARGETS.map((row)=>row.vault),"vault targets");
  equal(evidence.targets.map((row)=>row.asset),R.TARGETS.map((row)=>row.asset),"asset targets");
  equal(evidence.targets.map((row)=>row.strategies),R.TARGETS.map((row)=>[...row.strategies]),"strategies");
  equal(evidence.capturePolicy.allowedRpc,R.ALLOWED_RPC,"RPC allowlist");
  equal(evidence.capturePolicy.retries,0,"no retries"); equal(evidence.capturePolicy.logsNeeded,false,"no logs");
  equal(evidence.capturePolicy.completeActiveStrategySetAuthority,null,"no active set authority"); equal(evidence.capturePolicy.completeActiveStrategySetClaimed,false,"active set not claimed");
  equal(evidence.capturePolicy.customQueueDisposition,"CAPTURE_INCOMPLETE","evidence custom queue disposition");
  equal(evidence.capturePolicy.holderScan,false,"no holders"); equal(evidence.capturePolicy.simulation,false,"no simulation");
  equal(evidence.materiality.exactIndependentPriceAuthority,null,"no price authority"); equal(evidence.materiality.usdConclusionAvailable,false,"USD unknown");
  equal(evidence.permittedOutcomes,R.OUTCOMES,"outcomes");
  equal([inbox.captureExecuted,inbox.decisionCreated,inbox.protectedInventoryReads,inbox.networkCalls],[false,false,0,0],"offline inbox");
  equal([inbox.routePositive,inbox.executable,inbox.findingClaimed],[false,false,false],"no positive claims");
  equal([inbox.coveragePolicy.completeActiveStrategySet,inbox.coveragePolicy.completeActiveStrategySetAuthority,inbox.coveragePolicy.customQueueDisposition],[false,null,"CAPTURE_INCOMPLETE"],"inbox coverage policy");
  equal(inbox.launchCommand,R.COMMAND,"launch command");

  const report = read(R.PATHS.report).toString("utf8"), handoff = read(R.PATHS.handoff).toString("utf8");
  for (const text of [report,handoff]) { check(text.includes(R.STATUS),"document status"); check(/backend(?:\/operator)? independence remains unproven/iu.test(text),"independence limitation"); check(/runtime(?:\/source binding|SourceBinding)/iu.test(text),"runtime limit"); check(/USD (?:materiality|conclusion)/u.test(text),"USD limit"); check(text.includes(R.COMMAND),"launch command documented"); }
  check(report.includes("Public API TVL is discovery evidence only"),"TVL scope");
  check(report.includes("partial marker") && report.includes("no retry, replacement, or cleanup"),"marker lineage");
  check(report.includes("convertToAssets") && report.includes("do not establish executable liquidity"),"quote semantics");
  check(report.includes("defaultQueueCoverageComplete") && report.includes("completeActiveStrategySet") && report.includes("hidden active strategy"),"report coverage distinction");
  check(report.includes("Incomplete strategy coverage takes precedence"),"report classification precedence");
  check(handoff.includes("Step 1/Step 2 execution lineage is not reused"),"fresh lineage");
  check(handoff.includes("No finding, route-positive, executable, or profit claim"),"no claims");

  for (const item of [R.PATHS.decision,R.PATHS.pass,R.PATHS.diagnostic,R.PATHS.lock,R.PATHS.ledger]) check(!fs.existsSync(R.rel(item)),`${item} absent`);
  const checkOnly = childProcess.spawnSync(process.execPath,[R.rel(R.PATHS.runner),"--check-only"],{cwd:R.ROOT,encoding:"utf8",env:{},maxBuffer:4*1024*1024});
  equal([checkOnly.status,checkOnly.stderr],[0,""],"runner check-only"); const checkResult = JSON.parse(checkOnly.stdout);
  equal([checkResult.status,checkResult.captureExecuted,checkResult.decisionCreated,checkResult.inventoryReads,checkResult.networkCalls],[R.STATUS,false,false,0,0],"check-only offline");
  equal(checkResult.packageDigest,prepared.manifest.packageDigest,"check package digest");

  const testRun = childProcess.spawnSync(process.execPath,[R.rel(R.PATHS.tests)],{cwd:R.ROOT,encoding:"utf8",env:{},maxBuffer:16*1024*1024});
  equal([testRun.status,testRun.stderr],[0,""],"offline tests"); const testResult = JSON.parse(testRun.stdout);
  check(testResult.tests >= 104,"at least 104 tests"); check(testResult.assertions >= 100,"meaningful assertions");
  equal([testResult.networkReads,testResult.rpcReads,testResult.protectedInventoryReads,testResult.captureExecuted,testResult.decisionCreated],[0,0,0,false,false],"test safety summary");

  let leakMatches = 0;
  for (const item of [R.PATHS.authority,R.PATHS.publicEvidence,R.PATHS.packageManifest,R.PATHS.reviewPackage,R.PATHS.inbox]) {
    const text = read(item).toString("utf8"); JSON.parse(text); check(text.endsWith("\n"),`${item} newline`);
    leakMatches += (text.match(/(?:https?|wss?):\/\//giu)||[]).length;
    leakMatches += (text.match(/"(?:endpoint|provider|hostname|rawResponse|responseBody|headers)"\s*:/giu)||[]).length;
  }
  equal(leakMatches,0,"no provider material");
  for (const row of prepared.manifest.components) { const bytes=read(row.path); equal(bytes.length,row.bytes,`${row.path} bytes`); equal(R.sha256(bytes),row.sha256,`${row.path} hash`); }
  for (const item of [R.PATHS.decision,R.PATHS.pass,R.PATHS.diagnostic,R.PATHS.lock,R.PATHS.ledger]) check(!fs.existsSync(R.rel(item)),`${item} still absent`);
  return { status:"PASS",checks,tests:testResult.tests,assertions:testResult.assertions,packageDigest:prepared.manifest.packageDigest,packageManifestSha256:prepared.packageManifestSha256,networkReads:0,rpcReads:0,protectedInventoryReads:0,captureExecuted:false,decisionCreated:false };
}

if (require.main === module) process.stdout.write(`${JSON.stringify(validate(),null,2)}\n`);
module.exports = { validate };
