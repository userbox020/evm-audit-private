#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const sentinelModule = require("./run-official-deployed-delta-sentinel.js");
const feedModule = require("./build-fresh-deployed-delta-candidate-feed-v1.js");
const scopeModule = require("./deployed-delta-sentinel-scope.js");

const SCHEMA = "deployed-delta-source-risk-scorer/v1";
const WORKSPACE = path.resolve(__dirname, "..");
const OUTPUT = path.join(WORKSPACE, "reports", "monitor", "deployed-delta-source-risk-scorer.json");
const SENTINEL_PATH = sentinelModule.OUTPUT;
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 128 * 1024;
const MAX_SELECTED_REPOSITORIES = 16;
const MAX_SELECTED_PATHS = 64;
const CLASSES = new Set([
  "share-accounting", "oracle-price", "liquidation-rounding", "queue-epoch",
  "proxy-module", "new-market-unpause", "other"
]);
const PRIORITIES = new Set(["HIGH", "MEDIUM", "LOW"]);
const PRIORITY_ORDER = Object.freeze({ HIGH: 0, MEDIUM: 1, LOW: 2 });
const ADDRESS_TEXT = /0x[0-9a-f]{40}(?:[0-9a-f]{24})?/i;
const DOMAIN_TEXT = /\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|app|xyz|finance|cloud|invalid)\b/i;
const LEAK_TEXT = /(?:https?|wss?|ftp):\/\/|\bwww\.|authorization\s*:|bearer\s|(?:api|access)[_-]?key|private[_-]?key|client[_-]?secret|access[_-]?token|mnemonic|seed[_-]?phrase|rpc[_-]?(?:url|endpoint)|graphql[_-]?endpoint|\.env\b|\b(?:password|credential|secret)s?\b/i;

class ScorerError extends Error {
  constructor(code) { super(code); this.name = "ScorerError"; this.code = code; }
}

function fail(code) { throw new ScorerError(code); }
function ownObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value, keys) {
  return ownObject(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
function iso(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function sha40(value, nullable = false) {
  return (nullable && value === null) || (typeof value === "string" && /^[0-9a-f]{40}$/.test(value));
}
function sha64(value) { return typeof value === "string" && /^[0-9a-f]{64}$/.test(value); }
function safeRepositoryId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 200
    && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) && !value.includes("..");
}
function safePath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 1024
    && !/[\u0000-\u001f\u007f]/.test(value) && !value.startsWith("/") && !value.includes("\\")
    && !value.includes("//") && !value.split("/").includes("..")
    && !ADDRESS_TEXT.test(value) && !DOMAIN_TEXT.test(value) && !LEAK_TEXT.test(value);
}
function leakFree(value) {
  const serialized = JSON.stringify(value);
  return !ADDRESS_TEXT.test(serialized) && !DOMAIN_TEXT.test(serialized) && !LEAK_TEXT.test(serialized)
    && !/(?:bytecode|sourceCode|rawSource|diff|patch|lineRange|startLine|endLine|economic|profit|liquidity|accountingLoss)/i.test(serialized);
}
function sortedUniqueStrings(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    && new Set(value).size === value.length
    && JSON.stringify(value) === JSON.stringify([...value].sort((a, b) => a.localeCompare(b)));
}

function tokensFor(values) {
  const tokens = [];
  for (const value of values) {
    const separated = String(value).replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
    tokens.push(...separated.split(/[^a-z0-9]+/).filter(Boolean));
  }
  return tokens;
}
function classesFor(paths, hints) {
  const tokens = tokensFor([...paths, ...hints]);
  const has = (...values) => tokens.some((token) => values.some((value) => token === value));
  const hasPrefix = (value) => tokens.some((token) => token.startsWith(value));
  const classes = [];
  if (has("share", "vault", "asset", "conversion", "accounting")) classes.push("share-accounting");
  if (has("oracle", "price")) classes.push("oracle-price");
  if (hasPrefix("liquidat") || hasPrefix("round") || has("precision")) classes.push("liquidation-rounding");
  if (has("queue", "epoch") || hasPrefix("settle")) classes.push("queue-epoch");
  if (has("proxy", "module", "adapter", "upgrade", "implementation")) classes.push("proxy-module");
  if (has("market", "pool", "pause", "unpause") || hasPrefix("deploy")) classes.push("new-market-unpause");
  if (classes.length === 0) classes.push("other");
  return classes.sort((a, b) => a.localeCompare(b));
}
function priorityFor(classes) {
  if (classes.some((item) => ["share-accounting", "oracle-price", "liquidation-rounding", "queue-epoch"].includes(item))) return "HIGH";
  if (classes.some((item) => ["proxy-module", "new-market-unpause"].includes(item))) return "MEDIUM";
  return "LOW";
}
function compareSelected(a, b) {
  return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.repositoryId.localeCompare(b.repositoryId);
}

function validateSelectedRow(row) {
  return exactKeys(row, ["repositoryId", "previousHeadSha", "observedHeadSha", "selectedPaths", "classes", "priority"])
    && safeRepositoryId(row.repositoryId) && sha40(row.previousHeadSha, true) && sha40(row.observedHeadSha)
    && row.selectedPaths.length > 0 && row.selectedPaths.length <= MAX_SELECTED_PATHS
    && sortedUniqueStrings(row.selectedPaths) && row.selectedPaths.every(safePath)
    && row.classes.length > 0 && row.classes.length <= CLASSES.size && sortedUniqueStrings(row.classes)
    && row.classes.every((item) => CLASSES.has(item)) && PRIORITIES.has(row.priority)
    && row.priority === priorityFor(row.classes);
}

function validateArtifact(value) {
  try {
    if (!exactKeys(value, ["schema", "generatedAt", "status", "sentinelCommitment", "selected", "counts", "safety"])
        || value.schema !== SCHEMA || !iso(value.generatedAt) || !["EMPTY", "INCOMPLETE"].includes(value.status)
        || !sha64(value.sentinelCommitment) || !Array.isArray(value.selected)
        || value.selected.length > MAX_SELECTED_REPOSITORIES || value.selected.some((row) => !validateSelectedRow(row))
        || JSON.stringify(value.selected) !== JSON.stringify([...value.selected].sort(compareSelected))
        || new Set(value.selected.map((row) => row.repositoryId)).size !== value.selected.length
        || !exactKeys(value.counts, ["candidateRepositories", "candidatePaths", "selectedRepositories", "selectedPaths"])
        || Object.values(value.counts).some((count) => !Number.isSafeInteger(count) || count < 0)
        || value.counts.selectedRepositories !== value.selected.length
        || value.counts.selectedPaths !== value.selected.reduce((total, row) => total + row.selectedPaths.length, 0)
        || value.counts.selectedRepositories > value.counts.candidateRepositories
        || value.counts.selectedPaths > value.counts.candidatePaths || value.counts.selectedPaths > MAX_SELECTED_PATHS
        || !exactKeys(value.safety, [
          "localOnly", "networkAccess", "rpcAccess", "forkUse", "pnlEvaluation", "signing", "transactions", "automaticExecution"
        ]) || value.safety.localOnly !== true
        || Object.entries(value.safety).some(([key, item]) => key !== "localOnly" && item !== false)
        || !leakFree(value)) return false;
    if (value.status === "EMPTY") {
      return value.selected.length === 0 && Object.values(value.counts).every((count) => count === 0);
    }
    return true;
  } catch (_) { return false; }
}

function scoreSentinel(sentinel, now, options = {}) {
  const excludedIds = options.excludedIds || new Set();
  const candidates = sentinel.repositories.filter((repository) => repository.pollStatus === "candidate-change"
    && !excludedIds.has(repository.id));
  const candidatePaths = candidates.reduce((total, repository) => total + repository.changedManifestPaths.length, 0);
  const effectiveStatus = options.effectiveStatus || sentinel.status;
  if (effectiveStatus === "unchanged") {
    return {
      schema: SCHEMA,
      generatedAt: new Date(now).toISOString(),
      status: "EMPTY",
      sentinelCommitment: feedModule.sha256Canonical(sentinel),
      selected: [],
      counts: { candidateRepositories: 0, candidatePaths: 0, selectedRepositories: 0, selectedPaths: 0 },
      safety: safetyFields()
    };
  }
  const ranked = candidates.filter((repository) => repository.changedManifestPaths.length > 0).map((repository) => {
    const selectedPaths = [...repository.changedManifestPaths].sort((a, b) => a.localeCompare(b));
    const classes = classesFor(selectedPaths, repository.changeHints);
    return {
      repositoryId: repository.id,
      previousHeadSha: repository.previousHeadSha,
      observedHeadSha: repository.observedHeadSha,
      selectedPaths,
      classes,
      priority: priorityFor(classes)
    };
  }).sort(compareSelected);
  const selected = [];
  let remainingPaths = MAX_SELECTED_PATHS;
  for (const row of ranked) {
    if (selected.length >= MAX_SELECTED_REPOSITORIES || remainingPaths === 0) break;
    const selectedPaths = row.selectedPaths.slice(0, remainingPaths);
    if (selectedPaths.length === 0) continue;
    selected.push({ ...row, selectedPaths });
    remainingPaths -= selectedPaths.length;
  }
  return {
    schema: SCHEMA,
    generatedAt: new Date(now).toISOString(),
    status: "INCOMPLETE",
    sentinelCommitment: feedModule.sha256Canonical(sentinel),
    selected,
    counts: {
      candidateRepositories: candidates.length,
      candidatePaths,
      selectedRepositories: selected.length,
      selectedPaths: selected.reduce((total, row) => total + row.selectedPaths.length, 0)
    },
    safety: safetyFields()
  };
}

function safetyFields() {
  return {
    localOnly: true, networkAccess: false, rpcAccess: false, forkUse: false, pnlEvaluation: false,
    signing: false, transactions: false, automaticExecution: false
  };
}
function normalizeNow(now) {
  const value = now === undefined ? Date.now() : (typeof now === "function" ? now() : now);
  if (!Number.isSafeInteger(value) || value < 0 || !Number.isFinite(new Date(value).getTime())) fail("INVALID_NOW");
  return value;
}
function strictReadJson(filename, fsImpl = fs) {
  let stat, raw;
  try {
    stat = fsImpl.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_INPUT_BYTES) fail("SENTINEL_INVALID");
    raw = fsImpl.readFileSync(filename);
  } catch (error) {
    if (error instanceof ScorerError) throw error;
    fail("SENTINEL_INVALID");
  }
  if (!Buffer.isBuffer(raw) || raw.length <= 0 || raw.length > MAX_INPUT_BYTES) fail("SENTINEL_INVALID");
  try { return JSON.parse(raw.toString("utf8")); } catch (_) { fail("SENTINEL_INVALID"); }
}
function loadSentinel(filename, fsImpl, now, scope) {
  const sentinel = strictReadJson(filename, fsImpl);
  if (!sentinelModule.validateArtifact(sentinel)) fail("SENTINEL_INVALID");
  const assessment = scopeModule.assessSentinelScope(sentinel, scopeModule.resolveScope(scope));
  if (!assessment.ok) fail("SENTINEL_INVALID");
  const candidatePolls = sentinel.repositories.filter((repository) => repository.pollStatus === "candidate-change");
  if ((sentinel.status === "unchanged" && candidatePolls.length !== 0)
      || (sentinel.status === "candidate-change" && candidatePolls.length === 0)) fail("SENTINEL_INVALID");
  const generatedMs = Date.parse(sentinel.generatedAt);
  if (generatedMs > now + feedModule.MAX_FUTURE_SKEW_MS || now >= generatedMs + feedModule.SENTINEL_MAX_AGE_MS) fail("SENTINEL_STALE");
  return { sentinel, effectiveStatus: assessment.effectiveStatus };
}

function ensureDirectory(directory, fsImpl) {
  fsImpl.mkdirSync(directory, { recursive: true });
  const stat = fsImpl.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("OUTPUT_DIRECTORY_INVALID");
}
function publishAtomic(artifact, options = {}) {
  if (!validateArtifact(artifact)) fail("ARTIFACT_INVALID");
  const fsImpl = options.fsImpl || fs;
  const outputPath = path.resolve(options.outputPath || OUTPUT);
  const directory = path.dirname(outputPath);
  ensureDirectory(directory, fsImpl);
  const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  if (bytes.length > MAX_OUTPUT_BYTES) fail("OUTPUT_TOO_LARGE");
  const temporary = path.join(directory, `.${path.basename(outputPath)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`);
  let descriptor;
  try {
    descriptor = fsImpl.openSync(temporary, "wx", 0o600);
    fsImpl.writeFileSync(descriptor, bytes);
    fsImpl.fsyncSync(descriptor);
    fsImpl.closeSync(descriptor);
    descriptor = undefined;
    fsImpl.renameSync(temporary, outputPath);
    const readback = fsImpl.readFileSync(outputPath);
    if (!Buffer.isBuffer(readback) || !readback.equals(bytes)) fail("READBACK_INVALID");
    let parsed;
    try { parsed = JSON.parse(readback.toString("utf8")); } catch (_) { fail("READBACK_INVALID"); }
    if (!validateArtifact(parsed)) fail("READBACK_INVALID");
    return outputPath;
  } finally {
    if (descriptor !== undefined) try { fsImpl.closeSync(descriptor); } catch (_) {}
    try { if (fsImpl.existsSync(temporary)) fsImpl.unlinkSync(temporary); } catch (_) {}
  }
}

function runAndPublish(options = {}) {
  const now = normalizeNow(options.now);
  const fsImpl = options.fsImpl || fs;
  const scope = scopeModule.resolveScope(options.scope, options.scopeConfigPath);
  const loaded = loadSentinel(options.sentinelPath || SENTINEL_PATH, fsImpl, now, scope);
  const artifact = scoreSentinel(loaded.sentinel, now, {
    effectiveStatus: loaded.effectiveStatus,
    excludedIds: scope.excludedIds
  });
  if (!validateArtifact(artifact)) fail("ARTIFACT_INVALID");
  publishAtomic(artifact, { fsImpl, outputPath: options.outputPath || OUTPUT });
  return artifact;
}

function main(argv = process.argv.slice(2)) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    process.stderr.write("deployed-delta-source-risk-scorer: unsupported arguments\n");
    process.exitCode = 2;
    return;
  }
  try {
    const artifact = runAndPublish();
    process.stdout.write(`deployed-delta-source-risk-scorer: ${artifact.status}\n`);
  } catch (error) {
    process.stderr.write(`deployed-delta-source-risk-scorer: ${error instanceof ScorerError ? error.code : "FAILED"}\n`);
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({ SCHEMA, OUTPUT, ScorerError, validateArtifact, scoreSentinel, runAndPublish, main });

if (require.main === module) main();
