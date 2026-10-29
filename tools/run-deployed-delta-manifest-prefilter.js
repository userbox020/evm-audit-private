#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const sentinelModule = require("./run-official-deployed-delta-sentinel.js");
const scopeModule = require("./deployed-delta-sentinel-scope.js");
const feedModule = require("./build-fresh-deployed-delta-candidate-feed-v1.js");
const scorerModule = require("./run-deployed-delta-source-risk-scorer.js");
const identityModule = require("./deployed-delta-identities.js");

const SCHEMA = "deployed-delta-manifest-prefilter/v1";
const WORKSPACE = path.resolve(__dirname, "..");
const OUTPUT = path.join(WORKSPACE, "reports", "monitor", "deployed-delta-manifest-prefilter.json");
const SENTINEL_PATH = sentinelModule.OUTPUT;
const SCORER_PATH = scorerModule.OUTPUT;
const FEED_DIRECTORY = path.join(WORKSPACE, "reports", "monitor", "fresh-deployed-delta-candidate-feed-runs");
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
// Watched coverage chains. The universe covers Ethereum (1) and Base (8453); the older
// entries remain for the previously configured delta families.
const ALLOWED_CHAIN_IDS = new Set(["1", "8453", "100", "137", "146", "43114", "56", "57073"]);
const STATUSES = new Set(["EMPTY", "INCOMPLETE"]);
const FAILURE_CODES = new Set(["NONE", "IDENTITY_UNRESOLVED", "EVIDENCE_UNKNOWN"]);
const SUMMARY_KEYS = Object.freeze([
  "schema", "generatedAt", "status", "sentinelCommitment", "scorerCommitment", "feedId", "counts", "diagnostics", "safety"
]);
const ADDRESS_TEXT = /0x[0-9a-f]{40}(?:[0-9a-f]{24})?/i;
const DOMAIN_TEXT = /\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|app|xyz|finance|cloud|invalid)\b/i;
const LEAK_TEXT = /(?:https?|wss?|ftp):\/\/|\bwww\.|authorization\s*:|bearer\s|(?:api|access)[_-]?key|private[_-]?key|client[_-]?secret|access[_-]?token|mnemonic|seed[_-]?phrase|rpc[_-]?(?:url|endpoint)|graphql[_-]?endpoint|\.env\b|\b(?:password|credential|secret)s?\b/i;

class PrefilterError extends Error {
  constructor(code) {
    super(code);
    this.name = "PrefilterError";
    this.code = code;
  }
}

function fail(code) { throw new PrefilterError(code); }
function ownObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value, keys) {
  return ownObject(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
function iso(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function sha64(value, nullable = false) {
  return (nullable && value === null) || (typeof value === "string" && /^[0-9a-f]{64}$/.test(value));
}
function leakFree(value) {
  const serialized = JSON.stringify(value);
  return !ADDRESS_TEXT.test(serialized) && !DOMAIN_TEXT.test(serialized) && !LEAK_TEXT.test(serialized);
}
function safetyFields() {
  return {
    localOnly: true,
    networkAccess: false,
    rpcAccess: false,
    forkUse: false,
    pnlEvaluation: false,
    signing: false,
    transactions: false,
    automaticExecution: false
  };
}

function validateArtifact(value) {
  try {
    if (!exactKeys(value, SUMMARY_KEYS) || value.schema !== SCHEMA || !iso(value.generatedAt)
        || !STATUSES.has(value.status) || !sha64(value.sentinelCommitment) || !sha64(value.scorerCommitment) || !sha64(value.feedId, true)
        || !exactKeys(value.counts, ["candidateRepositories", "resolvedRepositories", "unresolvedRepositories", "evidenceRows"])
        || Object.values(value.counts).some((count) => !Number.isSafeInteger(count) || count < 0 || count > 256)
        || value.counts.candidateRepositories !== value.counts.resolvedRepositories + value.counts.unresolvedRepositories
        || value.counts.evidenceRows !== value.counts.resolvedRepositories
        || !exactKeys(value.diagnostics, ["failureCode"]) || !FAILURE_CODES.has(value.diagnostics.failureCode)
        || !exactKeys(value.safety, [
          "localOnly", "networkAccess", "rpcAccess", "forkUse", "pnlEvaluation", "signing", "transactions", "automaticExecution"
        ]) || value.safety.localOnly !== true
        || Object.entries(value.safety).some(([key, item]) => key !== "localOnly" && item !== false)
        || !leakFree(value)) return false;
    if (value.status === "EMPTY") {
      return value.feedId !== null && value.diagnostics.failureCode === "NONE"
        && Object.values(value.counts).every((count) => count === 0);
    }
    if (value.diagnostics.failureCode === "NONE") return false;
    if (value.diagnostics.failureCode === "IDENTITY_UNRESOLVED" && value.counts.unresolvedRepositories === 0) return false;
    if (value.diagnostics.failureCode === "EVIDENCE_UNKNOWN" && value.counts.unresolvedRepositories !== 0) return false;
    return value.counts.resolvedRepositories > 0 ? value.feedId !== null : value.feedId === null;
  } catch (_) { return false; }
}

function normalizeNow(now) {
  const value = now === undefined ? Date.now() : (typeof now === "function" ? now() : now);
  if (!Number.isSafeInteger(value) || value < 0 || !Number.isFinite(new Date(value).getTime())) fail("INVALID_NOW");
  return value;
}

function strictReadJson(filename, fsImpl = fs, maximumBytes = MAX_INPUT_BYTES) {
  let stat, raw;
  try {
    stat = fsImpl.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > maximumBytes) fail("SENTINEL_INVALID");
    raw = fsImpl.readFileSync(filename);
  } catch (error) {
    if (error instanceof PrefilterError) throw error;
    fail("SENTINEL_INVALID");
  }
  if (!Buffer.isBuffer(raw) || raw.length <= 0 || raw.length > maximumBytes) fail("SENTINEL_INVALID");
  try { return JSON.parse(raw.toString("utf8")); } catch (_) { fail("SENTINEL_INVALID"); }
}

function loadSentinel(filename = SENTINEL_PATH, fsImpl = fs, now = Date.now(), scope) {
  const sentinel = strictReadJson(filename, fsImpl);
  if (!sentinelModule.validateArtifact(sentinel)) fail("SENTINEL_INVALID");
  const assessment = scopeModule.assessSentinelScope(sentinel, scopeModule.resolveScope(scope));
  if (!assessment.ok) fail("SENTINEL_INVALID");
  const candidatePolls = sentinel.repositories.filter((repository) => repository.pollStatus === "candidate-change");
  if ((sentinel.status === "unchanged" && candidatePolls.length !== 0)
      || (sentinel.status === "candidate-change" && candidatePolls.length === 0)) fail("SENTINEL_INVALID");
  const generatedMs = Date.parse(sentinel.generatedAt);
  if (generatedMs > now + feedModule.MAX_FUTURE_SKEW_MS || now >= generatedMs + feedModule.SENTINEL_MAX_AGE_MS) {
    fail("SENTINEL_STALE");
  }
  return sentinel;
}

function loadScorer(filename, sentinel, fsImpl, now, effectiveStatus, excludedIds) {
  let stat, raw, scorer;
  try {
    stat = fsImpl.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_INPUT_BYTES) fail("SCORER_INVALID");
    raw = fsImpl.readFileSync(filename);
  } catch (error) {
    if (error instanceof PrefilterError) throw error;
    fail(error && error.code === "ENOENT" ? "SCORER_MISSING" : "SCORER_INVALID");
  }
  if (!Buffer.isBuffer(raw) || raw.length <= 0 || raw.length > MAX_INPUT_BYTES) fail("SCORER_INVALID");
  try { scorer = JSON.parse(raw.toString("utf8")); } catch (_) { fail("SCORER_INVALID"); }
  const generatedMs = scorer && Date.parse(scorer.generatedAt);
  const sentinelCommitment = feedModule.sha256Canonical(sentinel);
  if (!scorerModule.validateArtifact(scorer) || scorer.sentinelCommitment !== sentinelCommitment
      || !Number.isFinite(generatedMs) || generatedMs < Date.parse(sentinel.generatedAt)
      || generatedMs > now + feedModule.MAX_FUTURE_SKEW_MS || now >= generatedMs + feedModule.SENTINEL_MAX_AGE_MS
      || (effectiveStatus === "unchanged" && scorer.status !== "EMPTY")
      || (effectiveStatus === "candidate-change" && scorer.status !== "INCOMPLETE")) fail("SCORER_INVALID");
  const expected = scorerModule.scoreSentinel(sentinel, generatedMs, { effectiveStatus, excludedIds });
  if (feedModule.canonicalJson(expected) !== feedModule.canonicalJson(scorer)) fail("SCORER_INVALID");
  return scorer;
}

function classesFor(hints) {
  const classes = new Set();
  for (const hint of hints) {
    if (hint === "implementation") classes.add("implementation");
    else if (hint === "oracle-config") classes.add("oracle");
    else if (hint === "pause-unpause-config") classes.add("unpause");
    else classes.add("config");
  }
  if (classes.size === 0) classes.add("config");
  return [...classes].sort((a, b) => a.localeCompare(b));
}

function evidenceFor(repository, sentinel, expiresAt) {
  const exactChainIds = identityModule.chainIdsForPaths(repository.id, repository.changedManifestPaths);
  const chainIds = [...new Set([...repository.chainTextHints, ...exactChainIds])]
    .filter((chainId) => ALLOWED_CHAIN_IDS.has(chainId) && /^[1-9][0-9]{0,19}$/.test(chainId));
  if (chainIds.length !== 1 || !repository.observedHeadSha || Date.parse(expiresAt) <= Date.parse(repository.observedAt)) return null;
  const changedManifestPaths = [...repository.changedManifestPaths].sort((a, b) => a.localeCompare(b));
  const identityMaterial = {
    repositoryId: repository.id,
    previousHeadSha: repository.previousHeadSha,
    observedHeadSha: repository.observedHeadSha,
    chainId: chainIds[0],
    changedManifestPaths
  };
  const targetCommitment = feedModule.sha256Canonical(identityMaterial);
  const deltaId = `delta:${feedModule.sha256Canonical({ kind: "manifest-prefilter-delta", ...identityMaterial })}`;
  const row = {
    schema: feedModule.EVIDENCE_SCHEMA,
    evidenceId: `evidence:${feedModule.sha256Canonical({ kind: "manifest-prefilter-evidence", deltaId, targetCommitment })}`,
    deltaId,
    observedAt: repository.observedAt,
    expiresAt,
    sentinelBinding: {
      runId: sentinel.runId,
      repositoryId: repository.id,
      previousHeadSha: repository.previousHeadSha,
      observedHeadSha: repository.observedHeadSha
    },
    identity: { protocol: repository.id, chainId: chainIds[0], targetCommitment },
    delta: {
      classes: classesFor(repository.changeHints),
      affectedLocations: changedManifestPaths.map((changedPath) => ({
        path: changedPath, startLine: 1, endLine: 1, symbol: "path-level-change", side: "head"
      }))
    },
    source: { exact: "unknown", commit: repository.observedHeadSha, treeCommitment: null, references: [] },
    deployment: { current: "unknown", finalized: "unknown", pinCommitment: null, references: [] },
    runtime: { bound: "unknown", deltaApplied: "unknown", runtimeCommitment: null, references: [] },
    route: { publicAccountingPath: "unknown", liquidExit: "unknown", references: [] },
    novelty: { status: "unknown", references: [] }
  };
  return feedModule.validateEvidenceRow(row) ? row : null;
}

function buildEvidenceRows(sentinel, selections) {
  const expiresAt = new Date(Date.parse(sentinel.generatedAt) + feedModule.SENTINEL_MAX_AGE_MS).toISOString();
  const selectedByRepository = selections === undefined ? null : new Map(selections.map((row) => [row.repositoryId, new Set(row.selectedPaths)]));
  const repositories = sentinel.repositories.filter((repository) => repository.pollStatus === "candidate-change"
    && repository.changedManifestPaths.length > 0 && (selectedByRepository === null || selectedByRepository.has(repository.id)))
    .map((repository) => {
      if (selectedByRepository === null) return repository;
      const selectedPaths = selectedByRepository.get(repository.id);
      return { ...repository, changedManifestPaths: repository.changedManifestPaths.filter((changedPath) => selectedPaths.has(changedPath)) };
    }).filter((repository) => repository.changedManifestPaths.length > 0);
  const evidence = [];
  let unresolvedRepositories = 0;
  for (const repository of repositories) {
    const row = evidenceFor(repository, sentinel, expiresAt);
    if (row) evidence.push(row);
    else unresolvedRepositories += 1;
  }
  evidence.sort((a, b) => a.evidenceId.localeCompare(b.evidenceId));
  return {
    evidence,
    candidateRepositories: repositories.length,
    resolvedRepositories: evidence.length,
    unresolvedRepositories
  };
}

function buildSuppression(sentinel, now) {
  const expiresAt = new Date(Date.parse(sentinel.generatedAt) + feedModule.SENTINEL_MAX_AGE_MS).toISOString();
  if (Date.parse(expiresAt) <= now) fail("SENTINEL_STALE");
  const sentinelCommitment = feedModule.sha256Canonical(sentinel);
  const suppression = {
    schema: feedModule.SUPPRESSION_SCHEMA,
    indexId: `manifest-prefilter:${sentinelCommitment}`,
    generatedAt: new Date(now).toISOString(),
    expiresAt,
    entries: []
  };
  if (!feedModule.validateSuppression(suppression)) fail("SUPPRESSION_INVALID");
  return suppression;
}

function ensureDirectory(directory, fsImpl) {
  fsImpl.mkdirSync(directory, { recursive: true });
  const stat = fsImpl.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("OUTPUT_DIRECTORY_INVALID");
}

async function publishFeedIdempotent(feed, feedDirectory, fsImpl) {
  ensureDirectory(feedDirectory, fsImpl);
  try {
    return await feedModule.publishNoReplace(feed, { outputDirectory: feedDirectory, fsImpl });
  } catch (error) {
    if (!error || error.code !== "OUTPUT_EXISTS") throw error;
    const filename = path.join(feedDirectory, `${feed.feedId}.json`);
    let stat, actual;
    try {
      stat = fsImpl.lstatSync(filename);
      actual = fsImpl.readFileSync(filename);
    } catch (_) { fail("EXISTING_FEED_INVALID"); }
    const expected = feedModule.canonicalBytes(feed);
    if (!stat.isFile() || stat.isSymbolicLink() || !Buffer.isBuffer(actual) || !actual.equals(expected)) fail("EXISTING_FEED_INVALID");
    let parsed;
    try { parsed = JSON.parse(actual.toString("utf8")); } catch (_) { fail("EXISTING_FEED_INVALID"); }
    if (!feedModule.validateFeed(parsed) || !feedModule.canonicalBytes(parsed).equals(actual)) fail("EXISTING_FEED_INVALID");
    return filename;
  }
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

async function runAndPublish(options = {}) {
  const now = normalizeNow(options.now);
  const fsImpl = options.fsImpl || fs;
  const scope = scopeModule.resolveScope(options.scope, options.scopeConfigPath);
  const sentinel = loadSentinel(options.sentinelPath || SENTINEL_PATH, fsImpl, now, scope);
  const effectiveStatus = scopeModule.assessSentinelScope(sentinel, scope).effectiveStatus;
  const sentinelCommitment = feedModule.sha256Canonical(sentinel);
  const scorer = loadScorer(options.scorerPath || SCORER_PATH, sentinel, fsImpl, now, effectiveStatus, scope.excludedIds);
  const scorerCommitment = feedModule.sha256Canonical(scorer);
  const feedDirectory = options.feedDirectory || FEED_DIRECTORY;
  let feed = null;
  let counts = { candidateRepositories: 0, resolvedRepositories: 0, unresolvedRepositories: 0, evidenceRows: 0 };
  let status, failureCode;

  if (effectiveStatus === "unchanged") {
    const suppression = buildSuppression(sentinel, now);
    feed = feedModule.buildFeed({ sentinel, evidence: [], suppression, now, sentinelComplete: true });
    if (feed.status !== "empty") fail("FEED_NOT_EMPTY");
    await publishFeedIdempotent(feed, feedDirectory, fsImpl);
    status = "EMPTY";
    failureCode = "NONE";
  } else {
    const built = buildEvidenceRows(sentinel, scorer.selected);
    counts = {
      candidateRepositories: built.candidateRepositories,
      resolvedRepositories: built.resolvedRepositories,
      unresolvedRepositories: built.unresolvedRepositories,
      evidenceRows: built.evidence.length
    };
    if (built.evidence.length > 0) {
      const suppression = buildSuppression(sentinel, now);
      feed = feedModule.buildFeed({ sentinel, evidence: built.evidence, suppression, now, sentinelComplete: true });
      if (!["ready", "incomplete"].includes(feed.status)) fail("FEED_NOT_INCOMPLETE");
      await publishFeedIdempotent(feed, feedDirectory, fsImpl);
    }
    status = "INCOMPLETE";
    failureCode = built.unresolvedRepositories > 0 ? "IDENTITY_UNRESOLVED" : "EVIDENCE_UNKNOWN";
  }

  const artifact = {
    schema: SCHEMA,
    generatedAt: new Date(now).toISOString(),
    status,
    sentinelCommitment,
    scorerCommitment,
    feedId: feed ? feed.feedId : null,
    counts,
    diagnostics: { failureCode },
    safety: safetyFields()
  };
  publishAtomic(artifact, { fsImpl, outputPath: options.outputPath || OUTPUT });
  return { artifact, feed };
}

async function main(argv = process.argv.slice(2)) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    process.stderr.write("deployed-delta-manifest-prefilter: unsupported arguments\n");
    process.exitCode = 2;
    return;
  }
  try {
    const result = await runAndPublish();
    process.stdout.write(`deployed-delta-manifest-prefilter: ${result.artifact.status}\n`);
  } catch (error) {
    process.stderr.write(`deployed-delta-manifest-prefilter: ${error instanceof PrefilterError ? error.code : "FAILED"}\n`);
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({
  SCHEMA, OUTPUT, SENTINEL_PATH, SCORER_PATH, FEED_DIRECTORY, PrefilterError, validateArtifact, buildEvidenceRows,
  runAndPublish, main, publishAtomic, loadSentinel
});

if (require.main === module) void main();
