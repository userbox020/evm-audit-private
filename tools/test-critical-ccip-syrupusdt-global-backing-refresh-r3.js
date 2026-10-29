#!/usr/bin/env node
"use strict";

// Offline validator: no endpoint inventory or network access.
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const ROOT = path.resolve(__dirname, "..");
const NAME = "reviewer-ccip-syrupusdt-global-backing-refresh-r3";
const P = { raw: `reports/raw/fast/${NAME}.json`, tests: `reports/raw/fast/${NAME}-tests.json`, manifest: `reports/raw/fast/${NAME}-manifest.json`, report: `reports/${NAME}.md`, inbox: `coordination/inbox/review-critical-ccip-syrupusdt-global-backing-refresh-r3-2026-07-26.json`, handoff: `coordination/handoffs/2026-07-26-${NAME}-handoff.md` };
const PRE = "95665be926d27b9a9175fa11b7da702c26f5ad5450a1cd86676af0f4297d4bfb";
const EXPECTED = { ethereum: [1,"5009297550715157269",25616077,"0xdfc7c1cba0b72ede467cc3fa42743d870d1e6729a5188a79c3fca25529dfb61b"], bnb:[56,"11344663589394136015",112218620,"0xe6862bd03e7b0e0b3e47626ea9f2e00c397a10082669053fbab0a78847e864b4"], mantle:[5000,"1556008542357238666",98463936,"0xc390fe1163bf1ab6300c411427e4019b14a25cd42e3525b754ecf101a4cea768"], plasma:[9745,"9335212494177455608",28117828,"0xe6ad5bf53690b50ce7d55bf4f033a68a56c631fe52bc93b89401b1af7a982b58"], ink:[57073,"3461204551265785888",51559773,"0x4b0bc5aa16642ed12ff8b2dbb6bbd5879b55051737748990d32b1d75e3c83449"] };
const abs = (p) => path.join(ROOT, ...p.split("/")), read = (p) => fs.readFileSync(abs(p)), json = (p) => JSON.parse(read(p)), sha = (x) => crypto.createHash("sha256").update(x).digest("hex"), rec = (p) => { const b=read(p); return {bytes:b.length,sha256:sha(b)}; }, assert = (x,m) => { if(!x) throw new Error(m); };
function main(){ const raw=json(P.raw),tests=json(P.tests),manifest=json(P.manifest),texts=[read(P.report).toString(),read(P.inbox).toString(),read(P.handoff).toString(),JSON.stringify(raw),JSON.stringify(tests),JSON.stringify(manifest)]; let checks=0; const ok=(x,m)=>{assert(x,m);checks++;};
  for(const row of manifest.records){const a=rec(row.path);ok(a.bytes===row.bytes&&a.sha256===row.sha256,`record:${row.path}`);} ok(sha(Buffer.from(manifest.records.map(x=>`${x.path}\0${x.bytes}\0${x.sha256}`).join("\n")))===manifest.aggregateSha256,"aggregate");
  ok(raw.r2Binding.aggregateSha256===PRE&&raw.r2Binding.rawEvidencePreservedImmutably===true&&raw.r2Binding.rawEvidenceModified===false,"r2-immutable");
  for(const [k,e] of Object.entries(EXPECTED)){const p=raw.pins[k];ok(p.chainId===e[0]&&p.selector===e[1]&&p.blockNumber===e[2]&&p.blockHash===e[3],`pin:${k}`);} ok(raw.routes.length===4&&raw.routes.every(x=>EXPECTED[x.key][1]===x.selector),"selectors");
  ok(raw.pinPolicy.spreadSeconds===9&&raw.pinPolicy.toleranceSeconds===30,"spread"); ok(raw.pins.plasma.headerEvidence==="SINGLE-HOSTNAME-HEADER-PIN"&&Object.entries(raw.pins).filter(([k])=>k!=="plasma").every(([,x])=>x.headerEvidence==="MULTI-HOSTNAME-HEADER-PIN-CONSENSUS"),"header-class");
  ok(Object.values(raw.pins).every(x=>x.stateEvidence.includes("NO-CROSS-FAMILY")&&x.historyEvidence.includes("NO-COMPLETE-CROSS-FAMILY")),"state-history-class"); ok(raw.budget.maxPerEndpoint===1200&&raw.budget.globalUsed===2095&&raw.budget.globalCap===5000&&raw.budget.globalBudgetExhausted===false,"budget");
  ok(raw.accounting.remoteRows.every(x=>x.attributable===false),"attributable-false"); ok([raw.accounting.attributableRemoteSupplyRaw,raw.accounting.inFlightPrincipalRaw,raw.accounting.attributableLiabilityRaw,raw.accounting.deltaRaw,raw.accounting.deficitRaw,raw.accounting.surplusRaw].every(x=>x===null),"tri-state-null");
  ok(raw.contextOnlyArithmetic.custodyMinusRemoteSupplyRaw==="100000"&&raw.contextOnlyArithmetic.custodyMinusRemoteSupplyFormatted==="0.100000"&&raw.contextOnlyArithmetic.solvencyEvidence===false,"residual"); ok(raw.interpretation.authorityCallFailuresMeanAbsence===false&&raw.interpretation.rampAbiFailuresMeanAbsence===false,"unknown-not-negative"); ok(raw.interpretation.originalSenderAllowlistDisabledDoesNotBypass.length===4,"allowlist");
  ok(raw.pipeline==="0/5"&&Object.values(raw.gates).every(x=>x===0||x===false),"gates"); ok(tests.status==="PASS"&&tests.passed===tests.total,"tests"); ok(texts.every(x=>!/(?:https?|wss?):\/\//i.test(x)),"no-url"); ok(Object.values(raw.safety).every(x=>x===false),"offline");
  process.stdout.write(`${JSON.stringify({status:"PASS",offline:true,checks,runId:raw.runId,classification:raw.classification,r2AggregateSha256:PRE,aggregateSha256:manifest.aggregateSha256,pipeline:raw.pipeline,gates:raw.gates})}\n`);
}
try{main();}catch(error){process.stderr.write(`r3 validator failed:${error.message}\n`);process.exitCode=1;}
