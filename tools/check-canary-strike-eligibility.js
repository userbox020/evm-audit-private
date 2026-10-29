#!/usr/bin/env node
"use strict";

// Read-only observation of strike candidates; cannot load a key or send a tx.
const fs = require("node:fs");
const path = require("node:path");
const ROOT = path.resolve(__dirname, "..");
const { batchState } = require("./live-execution-batch.js");
const { classifyStrike, assessPaxg } = require("./lib/canary-strike-eligibility.js");
const { matchPaxgBatch } = require("./lib/paxg-batch-match.js");

function checkedJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (_) { return null; }
}

function main() {
  if (process.argv.length !== 3 || process.argv[2] !== "--check") {
    console.error("usage: node tools/check-canary-strike-eligibility.js --check");
    process.exitCode = 1;
    return;
  }
  const base = path.join(ROOT, "reports", "raw", "fast");
  const signal = checkedJson(path.join(base, "exploit-rearm-canary", "status.json"));
  const list = checkedJson(path.join(base, "w9-strike-routes-20260922", "sentinel-list-proposed.json"));
  const classes = {};
  const rows = Array.isArray(list?.sentinels) ? list.sentinels : [];
  for (const spec of rows) {
    const key = classifyStrike(spec);
    classes[key] = (classes[key] || 0) + 1;
  }
  // The real batch module verifies the Ed25519 approval before returning VALID.
  const authority = batchState();
  const paxg = assessPaxg(signal, authority);
  console.log(JSON.stringify({
    schema: "canary-strike-eligibility/check-v1",
    noSigning: true, noBroadcast: true,
    proposed: rows.length, classes,
    canonicalAuthorizationState: authority.state,
    canonicalPaxgMatch: matchPaxgBatch(authority) || "MATCHED_ACTIONS_NOT_EXECUTION_AUTHORITY",
    paxg,
  }));
}

if (require.main === module) main();
