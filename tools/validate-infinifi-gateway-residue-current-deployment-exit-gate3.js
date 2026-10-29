#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const gate = require("./infinifi-gateway-residue-current-deployment-exit-gate3.js");

function main() {
  const capture = JSON.parse(fs.readFileSync(gate.CAPTURE_PATH, "utf8")), manifest = JSON.parse(fs.readFileSync(gate.MANIFEST_PATH, "utf8"));
  assert.equal(capture.schema, gate.SCHEMA); assert.equal(manifest.schema, gate.MANIFEST_SCHEMA);
  gate.assertSanitized(capture); gate.assertSanitized(manifest);
  assert.equal(capture.scope.defensiveReadOnly, true); assert.equal(capture.scope.transactions, false); assert.equal(capture.scope.signing, false); assert.equal(capture.scope.forkExecuted, false);
  assert.equal(capture.chain.statePin.blockHash, capture.chain.finalized.hash); assert.equal(capture.chain.statePin.requireCanonical, true); assert.equal(capture.chain.terminalRecheck.exact, true);
  assert.equal(capture.chain.qualification.independentFamilies, true); assert.equal(capture.chain.qualification.selected.length, 2); assert.notEqual(capture.chain.qualification.selected[0].anonymousFamily, capture.chain.qualification.selected[1].anonymousFamily);
  assert.equal(capture.gateway.routerHistory.completeRange, true); assert.equal(capture.gateway.routerHistory.throughBlock, capture.chain.finalized.number); assert.equal(capture.gateway.ordinaryCallerReachability.routerCallsSent, false);
  assert.equal(capture.scope.bounty, "unknown"); assert.equal(capture.gates.fork, false); assert.equal(capture.gates.signing, false);
  if (capture.gateway.usdcBalanceRaw === "0") { assert.equal(capture.status, "CLOSED_ZERO_GATEWAY_USDC_RESIDUE"); assert.equal(capture.gates.routePositive, false); assert.equal(capture.gates.economics, "NOT_RUN_PRIMARY_ZERO_GATE"); }
  for (const row of manifest.files) {
    const file = path.join(gate.ROOT, ...row.path.split("/")); assert.equal(fs.statSync(file).size, row.bytes); assert.equal(gate.sha256(fs.readFileSync(file)), row.sha256);
  }
  JSON.parse(fs.readFileSync(gate.CAPTURE_PATH, "utf8")); JSON.parse(fs.readFileSync(gate.MANIFEST_PATH, "utf8"));
  console.log(`Validated InfiniFi Gate3 artifacts (${manifest.files.length} hashes)`);
}

if (require.main === module) main();
