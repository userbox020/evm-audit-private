#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const ROOT = path.resolve(__dirname, "..");
const TARGET = path.join(ROOT, "targets", "spark-alm-controller-ce5cbd96");
const MANIFEST = "reports/raw/critical/spark-alm-mainnet-staging-otcbuffer-gate0/manifest.json";
const sha = b => crypto.createHash("sha256").update(b).digest("hex");
function stable(v) {
  if (v === null || typeof v === "string" || typeof v === "boolean" || typeof v === "number") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
}
let checks = 0; const ok = (v, m) => { checks++; assert.ok(v, m); };
const abs = rel => path.join(ROOT, ...rel.split("/"));
const manifest = JSON.parse(fs.readFileSync(abs(MANIFEST), "utf8"));
ok(manifest.schema.endsWith("/manifest-v1") && manifest.hashAlgorithm === "sha256", "manifest schema");
ok(manifest.digestConstruction === "sha256(stable-json(records))", "digest construction");
ok(manifest.aggregateSha256 === sha(Buffer.from(stable(manifest.records))), "aggregate recomputed");
for (const row of manifest.records) { const bytes = fs.readFileSync(abs(row.path)); ok(bytes.length === row.bytes, `bytes ${row.path}`); ok(sha(bytes) === row.sha256, `hash ${row.path}`); }
const commit = manifest.sourceAuthority.commit;
ok(cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: TARGET, encoding: "utf8", windowsHide: true }).trim() === commit, "target commit");
ok(cp.execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: TARGET, encoding: "utf8", windowsHide: true }).trim() === manifest.sourceAuthority.rootTree, "target tree");
for (const row of manifest.sourceAuthority.sourceRecords) { const bytes = cp.execFileSync("git", ["show", `${commit}:${row.path}`], { cwd: TARGET, encoding: null, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }); ok(bytes.length === row.bytes, `source bytes ${row.path}`); ok(sha(bytes) === row.sha256, `source hash ${row.path}`); }
ok(manifest.sourceAuthority.submodulePins.length > 0, "submodule pins preserved");
for (const row of manifest.sourceAuthority.submodulePins) ok(/^[0-9a-f]{40}$/u.test(row.commit) && row.path.startsWith("lib/"), `gitlink ${row.path}`);
const capture = JSON.parse(fs.readFileSync(abs("reports/raw/critical/spark-alm-mainnet-staging-otcbuffer-gate0/capture.json"), "utf8"));
ok(capture.stopStage === 1 && capture.pin === null, "fail-closed ordering");
ok([capture.gates.routePositive, capture.gates.executableNow, capture.gates.material].every(x => ["true", "false", "unknown", "n/a"].includes(x)), "canonical gates");
ok(capture.gates.routePositive === "unknown" && capture.gates.executableNow === "unknown", "access gap stays unknown");
ok(capture.gates.fork.justified === false && capture.gates.signedActionJustified === false, "fork/signing false");
for (const rel of [MANIFEST, ...manifest.records.map(x => x.path).filter(x => !x.startsWith("tools/"))]) {
  const value = fs.readFileSync(abs(rel), "utf8");
  ok(!/(?:https?|wss?):\/\//iu.test(value), `no URL ${rel}`);
  ok(!/(?:private[_-]?key\s*[:=]|seed phrase|bearer\s+[a-z0-9]|"rpc(?:Url|Endpoint)"\s*:)/iu.test(value), `no provider/secret value marker ${rel}`);
}
console.log(`PASS ${checks} checks aggregate=${manifest.aggregateSha256}`);
