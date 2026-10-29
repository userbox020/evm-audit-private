#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const TARGET = path.join(ROOT, "targets", "spark-alm-controller-ce5cbd96");
const COMMIT = "ce5cbd96e2d7ff9c52b4e143ca74643b1680469c";
const OUT = path.join(ROOT, "reports", "raw", "critical", "spark-alm-mainnet-staging-otcbuffer-gate0");
const MANIFEST = path.join(OUT, "manifest.json");
const records = [
  "reports/raw/critical/spark-alm-mainnet-staging-otcbuffer-gate0/capture.json",
  "reports/critical-spark-alm-mainnet-staging-otcbuffer-gate0.md",
  "coordination/inbox/critical/20260822-coordinator-spark-otcbuffer-gate0-terminal.json",
  "coordination/handoffs/20260822-coordinator-spark-otcbuffer-gate0-handoff.md",
  "tools/capture-spark-alm-mainnet-staging-otcbuffer-gate0.js",
  "tools/package-spark-alm-mainnet-staging-otcbuffer-gate0.js",
  "tools/test-spark-alm-mainnet-staging-otcbuffer-gate0.js",
  "tools/validate-spark-alm-mainnet-staging-otcbuffer-gate0.js"
];
const sourcePaths = [
  ".gitmodules", "foundry.toml", "src/OTCBuffer.sol", "src/MainnetController.sol", "src/ALMProxy.sol",
  "src/RateLimits.sol", "src/RateLimitHelpers.sol", "deploy/MainnetControllerInit.sol",
  "script/input/1/mainnet-staging.json", "script/output/1/mainnet-staging-release-20260616.json"
];
const sha = b => crypto.createHash("sha256").update(b).digest("hex");
function stable(v) {
  if (v === null || typeof v === "string" || typeof v === "boolean" || typeof v === "number") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
}
function git(args, encoding = "utf8") { return cp.execFileSync("git", args, { cwd: TARGET, encoding, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }); }
if (git(["rev-parse", "HEAD"]).trim() !== COMMIT) throw new Error("commit mismatch");
const artifactRecords = records.map(rel => { const bytes = fs.readFileSync(path.join(ROOT, ...rel.split("/"))); return { path: rel, bytes: bytes.length, sha256: sha(bytes) }; });
const sourceRecords = sourcePaths.map(rel => { const bytes = git(["show", `${COMMIT}:${rel}`], null); return { path: rel, bytes: bytes.length, sha256: sha(bytes) }; });
const submodulePins = git(["ls-tree", "-r", COMMIT]).split(/\r?\n/u).filter(x => x.startsWith("160000 commit ")).map(x => {
  const m = x.match(/^160000 commit ([0-9a-f]{40})\t(.+)$/u); if (!m) throw new Error("gitlink parse"); return { path: m[2], commit: m[1] };
});
const manifest = {
  schema: "spark-alm-mainnet-staging-otcbuffer-gate0/manifest-v1",
  generatedAt: new Date().toISOString(),
  hashAlgorithm: "sha256",
  digestConstruction: "sha256(stable-json(records))",
  sourceAuthority: {
    repository: "sparkdotfi/spark-alm-controller", commit: COMMIT,
    parent: git(["rev-parse", `${COMMIT}^`]).trim(), rootTree: git(["rev-parse", `${COMMIT}^{tree}`]).trim(),
    sourceRecords, submodulePins
  },
  records: artifactRecords,
  aggregateSha256: sha(Buffer.from(stable(artifactRecords)))
};
fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`PASS records=${artifactRecords.length} sources=${sourceRecords.length} submodules=${submodulePins.length} aggregate=${manifest.aggregateSha256}`);
