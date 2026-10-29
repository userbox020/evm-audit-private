#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const ROOT = path.resolve(__dirname, "..");
const TARGET = path.join(ROOT, "targets", "spark-alm-controller-ce5cbd96");
const OUT_REL = "reports/raw/critical/spark-alm-mainnet-staging-otcbuffer-gate0-r2";
const OUT = path.join(ROOT, ...OUT_REL.split("/"));
const COMMIT = "ce5cbd96e2d7ff9c52b4e143ca74643b1680469c";
const R1_MANIFEST_REL = "reports/raw/critical/spark-alm-mainnet-staging-otcbuffer-gate0/manifest.json";
const fixed = [
  `${OUT_REL}/capture-r2.json`, `${OUT_REL}/build-record-r2.json`,
  "reports/critical-spark-alm-mainnet-staging-otcbuffer-gate0-r2.md",
  "coordination/inbox/critical/20260822-coordinator-spark-otcbuffer-gate0-terminal-r2.json",
  "coordination/handoffs/20260822-coordinator-spark-otcbuffer-gate0-handoff-r2.md",
  "tools/capture-spark-alm-mainnet-staging-otcbuffer-gate0-r2.js",
  "tools/test-spark-alm-mainnet-staging-otcbuffer-gate0-r2.js",
  "tools/package-spark-alm-mainnet-staging-otcbuffer-gate0-r2.js",
  "tools/validate-spark-alm-mainnet-staging-otcbuffer-gate0-r2.js"
];
const sourcePaths = [".gitmodules", "foundry.toml", "src/OTCBuffer.sol", "src/MainnetController.sol", "src/ALMProxy.sol", "src/RateLimits.sol", "src/RateLimitHelpers.sol", "deploy/MainnetControllerInit.sol", "script/input/1/mainnet-staging.json", "script/output/1/mainnet-staging-release-20260616.json"];
const sha = b => crypto.createHash("sha256").update(b).digest("hex");
function stable(v) {
  if (v === null || typeof v === "string" || typeof v === "boolean" || typeof v === "number") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
}
const abs = rel => path.join(ROOT, ...rel.split("/"));
const record = rel => { const b = fs.readFileSync(abs(rel)); return { path: rel, bytes: b.length, sha256: sha(b) }; };
const git = (args, encoding = "utf8") => cp.execFileSync("git", args, { cwd: TARGET, encoding, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
if (git(["rev-parse", "HEAD"]).trim() !== COMMIT) throw new Error("commit mismatch");

const retained = fs.readdirSync(path.join(OUT, "build-retained-r2")).filter(x => x.endsWith("-r2.json")).sort().map(x => `${OUT_REL}/build-retained-r2/${x}`);
const records = [...fixed, ...retained].map(record);
const r1Bytes = fs.readFileSync(abs(R1_MANIFEST_REL)), r1 = JSON.parse(r1Bytes);
for (const row of r1.records) { const b = fs.readFileSync(abs(row.path)); if (b.length !== row.bytes || sha(b) !== row.sha256) throw new Error(`R1 drift ${row.path}`); }
if (sha(Buffer.from(stable(r1.records))) !== r1.aggregateSha256) throw new Error("R1 aggregate drift");
const sourceRecords = sourcePaths.map(rel => { const b = git(["show", `${COMMIT}:${rel}`], null); return { path: rel, bytes: b.length, sha256: sha(b) }; });
const submodulePins = git(["ls-tree", "-r", COMMIT]).split(/\r?\n/u).filter(x => x.startsWith("160000 commit ")).map(x => { const m = x.match(/^160000 commit ([0-9a-f]{40})\t(.+)$/u); if (!m) throw new Error("gitlink parse"); return { path: m[2], commit: m[1] }; });
const manifest = {
  schema: "spark-alm-mainnet-staging-otcbuffer-gate0-r2/manifest-v1", generatedAt: new Date().toISOString(), hashAlgorithm: "sha256", digestConstruction: "sha256(stable-json(records))",
  r1Authority: { manifestPath: R1_MANIFEST_REL, manifestBytes: r1Bytes.length, manifestSha256: sha(r1Bytes), aggregateSha256: r1.aggregateSha256, recordCount: r1.records.length, bytesPreserved: true,
    canonicalInterpretation: "STAGE1_RETRY_REQUIRED / R1_QUALIFICATION_OVERCONSTRAINED" },
  sourceAuthority: { repository: "sparkdotfi/spark-alm-controller", commit: COMMIT, parent: git(["rev-parse", `${COMMIT}^`]).trim(), rootTree: git(["rev-parse", `${COMMIT}^{tree}`]).trim(), sourceRecords, submodulePins },
  records, aggregateSha256: sha(Buffer.from(stable(records)))
};
fs.writeFileSync(path.join(OUT, "manifest-r2.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`PASS records=${records.length} retained=${retained.length} r1=${r1.aggregateSha256} r2=${manifest.aggregateSha256}`);
