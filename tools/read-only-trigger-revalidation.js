#!/usr/bin/env node
"use strict";

// Saved-source classification only. A fired event requests independent validation;
// it is neither a live revalidation nor evidence of executable profit.
const fs = require("node:fs");
const autopilot = require("./trigger-fork-autopilot");
const { classifyStatus } = require("./run-trigger-fork-poc");
const producer = require("./run-profit-trigger-watch");

const SCHEMA = "read-only-trigger-revalidation/v1";
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_FIRED_EVENTS = 5;

function result(verdict, code, producerCount = 0, firedCount = 0) {
  return { schema: SCHEMA, verdict, code, producerCount, firedCount };
}

function checkSavedSource(raw, nowMs = Date.now()) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) return result("BLOCKED", "INVALID_CLOCK");
  if (!(typeof raw === "string" || Buffer.isBuffer(raw))
    || Buffer.byteLength(raw) > MAX_SOURCE_BYTES) return result("BLOCKED", "SOURCE_SIZE_INVALID");
  const parsed = autopilot.parseSource(raw);
  if (!parsed.source) return result("BLOCKED", parsed.blocker);
  const source = parsed.source;
  if (!producer.validateArtifact(source)) return result("BLOCKED", "SOURCE_SCHEMA_INVALID");
  if (!autopilot.sourceFresh(source, nowMs)) return result("BLOCKED", "SOURCE_STALE");

  const identities = new Set();
  let firedCount = 0;
  for (const row of source.producers) {
    if (!autopilot.sourceFresh(row, nowMs)
      || Date.parse(row.generatedAt) > Date.parse(source.generatedAt) + 60_000) {
      return result("BLOCKED", "PRODUCER_INVALID");
    }
    const classification = classifyStatus(row.status);
    if (classification === "UNKNOWN") return result("BLOCKED", "UNKNOWN_STATUS");
    if (classification === "NOT_FIRED") continue;
    if (autopilot.SUPPORTED_EVENTS.get(row.id) !== row.status) return result("BLOCKED", "UNSUPPORTED_FIRE");
    const identity = autopilot.evidenceIdentity(row);
    if (identities.has(identity)) return result("BLOCKED", "FIRED_IDENTITY_DUPLICATE");
    identities.add(identity);
    firedCount += 1;
    if (firedCount > MAX_FIRED_EVENTS) return result("BLOCKED", "FIRED_CAP_EXCEEDED");
  }
  return firedCount === 0
    ? result("NO_FIRE", "NO_FIRE", source.producers.length)
    : result("FIRE_REQUIRES_FRESH_INDEPENDENT_VALIDATION", "FIRE_REQUIRES_FRESH_INDEPENDENT_VALIDATION", source.producers.length, firedCount);
}

function runCli(args = process.argv.slice(2)) {
  if (args.length !== 1 || args[0] !== "--check") {
    process.stdout.write(JSON.stringify({ code: "CHECK_ONLY", producerCount: 0, firedCount: 0 }) + "\n");
    return 1;
  }
  let checked;
  try {
    if (fs.statSync(autopilot.SOURCE_FILE).size > MAX_SOURCE_BYTES) {
      checked = result("BLOCKED", "SOURCE_SIZE_INVALID");
    } else {
      checked = checkSavedSource(fs.readFileSync(autopilot.SOURCE_FILE));
    }
  } catch (_) {
    checked = result("BLOCKED", "SOURCE_READ_FAILED");
  }
  process.stdout.write(JSON.stringify({ code: checked.code, producerCount: checked.producerCount, firedCount: checked.firedCount }) + "\n");
  return checked.verdict === "BLOCKED" ? 1 : 0;
}

if (require.main === module) process.exitCode = runCli();

module.exports = { SCHEMA, MAX_SOURCE_BYTES, MAX_FIRED_EVENTS, checkSavedSource, runCli };
