#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const REGISTRY_SCHEMA = "monitor-research-watch-registry/v1";
const OUTPUT_SCHEMA = "monitor-research-watch/v1";
const DISPOSITIONS = new Set(["ACTIVE_WATCH", "CHANGE_TRIGGER", "SCHEDULED", "HOLD", "SUPPRESSED"]);
const IDENTIFIER = /^[a-z0-9][a-z0-9-]{2,79}$/;
const UNKNOWN_OR_FALSE = new Set(["unknown", false]);

function fail(message) {
  throw new Error(`research watch registry: ${message}`);
}

function validTime(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validateEntry(entry, seen) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail("entry object required");
  if (typeof entry.id !== "string" || !IDENTIFIER.test(entry.id) || seen.has(entry.id)) fail("invalid or duplicate id");
  seen.add(entry.id);
  if (typeof entry.protocol !== "string" || !entry.protocol.trim()) fail(`${entry.id}: protocol required`);
  if (!DISPOSITIONS.has(entry.disposition)) fail(`${entry.id}: invalid disposition`);
  if (typeof entry.trigger !== "string" || !entry.trigger.trim()) fail(`${entry.id}: trigger required`);
  if (typeof entry.reason !== "string" || !entry.reason.trim()) fail(`${entry.id}: reason required`);
  if (!Array.isArray(entry.sources) || entry.sources.length === 0) fail(`${entry.id}: source paths required`);
  if (!entry.gates || typeof entry.gates !== "object" || Array.isArray(entry.gates) || Object.keys(entry.gates).length === 0) fail(`${entry.id}: gates required`);
  if (!Object.values(entry.gates).every(value => UNKNOWN_OR_FALSE.has(value))) fail(`${entry.id}: gate values must fail closed`);
  if (!UNKNOWN_OR_FALSE.has(entry.routePositive) || !UNKNOWN_OR_FALSE.has(entry.executableNow)) fail(`${entry.id}: route fields must fail closed`);
  if (entry.signedActionJustified !== false) fail(`${entry.id}: signedActionJustified must be false`);
  if (entry.disposition === "SCHEDULED") {
    if (!validTime(entry.reviewAt)) fail(`${entry.id}: valid reviewAt required`);
  } else if (entry.reviewAt !== undefined) {
    fail(`${entry.id}: reviewAt is scheduled-only`);
  }
}

function sourceStatus(root, relative) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative)) fail("source path must be relative");
  const normalized = relative.replace(/\\/g, "/");
  if (normalized.split("/").some(part => part === ".." || part === "")) fail("source path escapes root");
  if (/(^|\/)(\.env(?:\.|$)|[^/]*(?:private[-_]?key|keypair|\.pem)(?:\.|$))/i.test(normalized)) fail("secret-bearing source path rejected");
  const absolute = path.resolve(root, normalized);
  const relativeBack = path.relative(root, absolute);
  if (relativeBack.startsWith("..") || path.isAbsolute(relativeBack)) fail("source path escapes root");
  try {
    const info = fs.lstatSync(absolute);
    const real = fs.realpathSync.native(absolute);
    if (!info.isFile() || info.isSymbolicLink() || path.resolve(real) !== absolute) return { path: normalized, exists: false, mtime: null };
    return { path: normalized, exists: true, mtime: info.mtime.toISOString() };
  } catch (error) {
    if (error && error.code === "ENOENT") return { path: normalized, exists: false, mtime: null };
    fail(`cannot inspect source ${normalized}`);
  }
}

function buildState(registry, root, generatedAt = new Date().toISOString()) {
  if (!registry || registry.schema !== REGISTRY_SCHEMA || !Array.isArray(registry.entries) || registry.entries.length === 0 || registry.entries.length > 200) fail("invalid registry schema");
  if (!validTime(generatedAt)) fail("generatedAt must be an ISO timestamp");
  const resolvedRoot = path.resolve(root);
  const seen = new Set();
  const entries = registry.entries.map(entry => {
    validateEntry(entry, seen);
    if (entry.sources.length > 20 || new Set(entry.sources).size !== entry.sources.length) fail(`${entry.id}: source paths must be bounded and unique`);
    const sources = entry.sources.map(source => sourceStatus(resolvedRoot, source));
    const complete = sources.every(source => source.exists);
    return {
      id: entry.id,
      protocol: entry.protocol,
      disposition: entry.disposition,
      ...(entry.reviewAt ? { reviewAt: new Date(entry.reviewAt).toISOString() } : {}),
      trigger: entry.trigger,
      reason: entry.reason,
      gates: { ...entry.gates },
      routePositive: entry.routePositive,
      executableNow: entry.executableNow,
      signedActionJustified: false,
      status: complete ? "COMPLETE" : "INCOMPLETE",
      effectiveDisposition: complete ? entry.disposition : "INCOMPLETE",
      sources,
    };
  });
  return {
    schema: OUTPUT_SCHEMA,
    generatedAt: new Date(generatedAt).toISOString(),
    entries,
    safety: { readOnly: true, networkAccess: false, execution: false, signedActions: false },
  };
}

function main() {
  const root = path.resolve(__dirname, "..");
  const registryPath = path.join(__dirname, "monitor-research-watch-registry.json");
  const outputPath = path.join(root, "reports", "monitor", "research-watch-state.json");
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  const state = buildState(registry, root);
  if (fs.existsSync(outputPath)) {
    const prior = loadExistingOutput(outputPath);
    if (prior.schema !== OUTPUT_SCHEMA) fail("refusing to replace an unrelated output file");
  }
  fs.writeFileSync(outputPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "w" });
  process.stdout.write(`research watch state: ${state.entries.length} entries\n`);
}

function loadExistingOutput(file) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 5 * 1024 * 1024) fail("existing output is not a bounded regular file");
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("existing output object required");
    return value;
  } catch (error) {
    fail("existing output is not valid JSON");
  }
}

if (require.main === module) main();

module.exports = { buildState, validateEntry, sourceStatus, loadExistingOutput };
