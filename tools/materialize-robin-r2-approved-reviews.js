#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const common = require("./polygon-robin-runtime-r2-common");
const review = require("./polygon-robin-runtime-r2-review");

const WORKSPACE = "/mnt/c/_Work/__EVM_AUDIT";
const NATIVE_ROOT = "/home/mruserbox/.local/share/evm-audit/robin-runtime-r2";
const RECORDS = Object.freeze({
  A: Object.freeze({
    issuedAt: "2026-08-25T17:33:56.353Z",
    expiresAt: "2026-08-25T19:03:56.353Z",
    expectedSha256: "669ce69cc50b443d30ae2c72d3405a1d810ac88c5e482634a7caa2cbbb0c2c8e",
  }),
  B: Object.freeze({
    issuedAt: "2026-08-25T17:33:27.139Z",
    expiresAt: "2026-08-25T19:03:27.139Z",
    expectedSha256: "cf84728dd1fb7a0e36e517425eb29eeb822ab85f8470aaee3ad8d112053fd5eb",
  }),
});

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function makeRecord(slot, authority, timing) {
  const row = {
    schemaVersion: "robin-runtime-r2/review-record-v3",
    claimId: common.STEM,
    status: "REVIEWED_UNCONSUMED",
    slot,
    reviewerIdentity: review.IDENTITIES[slot],
    reviewerRole: review.ROLES[slot],
    reviewerCommitment: null,
    reviewBytesCommitment: null,
    packageManifestSha256: authority.authority.packageManifestSha256,
    packageAggregateSha256: authority.authority.packageAggregateSha256,
    stagingSealSha256: authority.stagingSealSha256,
    capabilitySealSha256: authority.capabilitySealSha256,
    launcherSha256: authority.launcherSha256,
    node: authority.node,
    lifecycleRoot: authority.lifecycleRoot,
    executionId: common.EXECUTION_ID,
    commands: authority.commands,
    brokerContract: review.BROKER_CONTRACT,
    scope: common.REVIEW_SCOPE,
    issuedAt: timing.issuedAt,
    expiresAt: timing.expiresAt,
    oneRun: true,
    noRetry: true,
    safety: {
      readOnly: true,
      signing: false,
      broadcast: false,
      mutation: false,
      funds: false,
      rawPersistence: false,
      canonicalOutputBoundary: "EXT4_ONLY",
    },
  };
  row.reviewBytesCommitment = review.reviewBytesCommitment(row);
  row.reviewerCommitment = review.commitment(row);
  const bytes = Buffer.from(`${common.canonical(row)}\n`);
  if (sha256(bytes) !== timing.expectedSha256) throw new Error(`REVIEW_${slot}_BYTE_MISMATCH`);
  review.validateReview(row, bytes, authority, slot, Date.parse(timing.issuedAt), true);
  return bytes;
}

async function main() {
  if (process.platform !== "linux") throw new Error("LINUX_REQUIRED");
  const authority = await review.fixedAuthority(NATIVE_ROOT, { uid: process.getuid() });
  for (const slot of ["A", "B"]) {
    const bytes = makeRecord(slot, authority, RECORDS[slot]);
    const target = path.join(WORKSPACE, "coordination", "decisions", `polygon-robin-markets-staking-vault-v2.0.0-runtime-r2-review-${slot.toLowerCase()}.json`);
    const fd = fs.openSync(target, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    process.stdout.write(`REVIEW_${slot}_MATERIALIZED ${sha256(bytes)}\n`);
  }
}

main().catch(() => {
  process.stdout.write("ROBIN_RUNTIME_R2_REVIEW_MATERIALIZATION_FAIL\n");
  process.exitCode = 1;
});
