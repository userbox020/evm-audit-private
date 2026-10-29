#!/usr/bin/env node
"use strict";

const path = require("node:path");

const ROOT = "/home/mruserbox/.local/share/evm-audit/robin-runtime-r2";

async function main() {
  const capture = require(path.join(ROOT, "tools", "polygon-robin-runtime-r2-capture.js"));
  const review = require(path.join(ROOT, "tools", "polygon-robin-runtime-r2-review.js"));
  const fixed = await capture.verifyRuntimeRoot(ROOT);
  process.stdout.write("ROBIN_R2_PRELOCK_ROOT_PASS\n");
  const pair = await review.readPair(ROOT, { fixed, uid: process.getuid(), nowMs: Date.now(), requireFresh: true });
  if (pair.rows.length !== 2) throw new Error("PAIR_COUNT");
  process.stdout.write("ROBIN_R2_PRELOCK_REVIEWS_PASS\n");
  const common = require(path.join(ROOT, "tools", "polygon-robin-runtime-r2-common.js"));
  const lock = {
    schemaVersion: "robin-runtime-r2/capture-lock-v3",
    claimId: common.STEM,
    executionId: common.EXECUTION_ID,
    packageManifestSha256: fixed.authority.packageManifestSha256,
    stagingSealSha256: fixed.stagingSealSha256,
    capabilitySealSha256: fixed.capabilitySealSha256,
    state: "ACTIVE",
    status: null,
    process: common.processIdentity(),
    oneShot: true,
    terminalSha256: null,
  };
  capture.encode(lock, common.CAPS.outputLifecycleBytes);
  process.stdout.write("ROBIN_R2_PRELOCK_LOCK_ENCODING_PASS\n");
}

main().catch((error) => {
  const code = typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code) ? error.code : "UNKNOWN";
  process.stdout.write(`ROBIN_R2_PRELOCK_FAIL_${code}\n`);
  process.exitCode = 1;
});
