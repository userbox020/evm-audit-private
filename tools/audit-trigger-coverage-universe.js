#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const WORKSPACE = path.resolve(__dirname, "..");
const UNIVERSE_PATH = path.join(__dirname, "trigger-coverage-universe.json");
const OUT_PATH = path.join(WORKSPACE, "reports", "monitor", "trigger-coverage-audit.json");
const UNIVERSE_SCHEMA = "trigger-coverage-universe/v1";
const AUDIT_SCHEMA = "trigger-coverage-audit/v1";
const EVIDENCE_SCHEMA = "trigger-coverage-evidence/v1";
const ROW_KEYS = Object.freeze(["id", "chainId", "family", "triggerClass", "enumerationKind", "enumerationRef", "artifactPath", "freshnessSeconds", "coverageMode", "onFire"]);
const AUDIT_ROW_KEYS = Object.freeze(["id", "status", "observedAt", "expiresAt", "artifactPath", "artifactSha256", "evidence", "blockers"]);
const CHAINS = Object.freeze([1, 8453, 42161]);
const CHAIN_NAMES = Object.freeze({ 1: "Ethereum", 8453: "Base", 42161: "Arbitrum" });
const FAMILIES = Object.freeze(["Morpho Blue", "Aave V3", "Aave V4", "Curve", "Uniswap V3", "Balancer V2", "Balancer V3", "Ammalgam", "Enhanced", "Basalt", "Surge Credit", "Umbrae"]);
const CLASSES = Object.freeze(["L", "O", "X", "R", "F", "D"]);
const MODES = Object.freeze(["BOUNDED", "DELTA_ONLY", "BLOCKED"]);
const ENUMERATION_KINDS = Object.freeze(["BOUNDED_ARTIFACT", "DELTA_SENTINEL", "BLOCKED_REGISTRY"]);
const ON_FIRE_STAGES = Object.freeze(["economics", "keyless-fixed-pin-fork", "alert"]);
const EXCLUSIONS = Object.freeze([
  "victim/orderflow/sandwiching",
  "ordinary non-flawed liquidation",
  "feed manipulation",
  "reorg attacks",
  "live access bypass",
  "chains other than 1/8453 (Arbitrum 42161 registered as a dispatch-disabled blocked row only)",
  "non-atomic multi-day routes",
]);

const EXPECTED_MATRIX = Object.freeze({
  "Morpho Blue": Object.freeze({ 1: "LOFD", 8453: "LOFD" }),
  "Aave V3": Object.freeze({ 1: "LOFD", 8453: "LOFD" }),
  "Aave V4": Object.freeze({ 1: "LOD", 8453: "LOD" }),
  Curve: Object.freeze({ 1: "XRD", 8453: "XRD" }),
  "Uniswap V3": Object.freeze({ 1: "XD", 8453: "XD" }),
  "Balancer V2": Object.freeze({ 1: "XRFD", 8453: "XRFD" }),
  "Balancer V3": Object.freeze({ 1: "XRFD", 8453: "XRFD" }),
  Ammalgam: Object.freeze({ 1: "L" }),
  Enhanced: Object.freeze({ 1: "R" }),
  Basalt: Object.freeze({ 42161: "X" }),
  "Surge Credit": Object.freeze({ 8453: "L" }),
  Umbrae: Object.freeze({ 8453: "X" }),
});

function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value, keys) {
  return isObject(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function iso(ms) { return new Date(ms).toISOString(); }

function expectedMatrixKeys() {
  const keys = [];
  for (const [family, chains] of Object.entries(EXPECTED_MATRIX)) {
    for (const chainId of CHAINS) {
      const classes = chains[chainId];
      if (!classes) continue;
      for (const triggerClass of classes) keys.push(`${chainId}|${family}|${triggerClass}`);
    }
  }
  return keys.sort();
}

function containedArtifactPath(workspace, relativePath) {
  if (typeof relativePath !== "string" || !relativePath || path.isAbsolute(relativePath) || relativePath.includes("\0")) return null;
  const normalized = relativePath.replace(/\\/g, "/");
  if (normalized.split("/").some((part) => part === ".." || part === "")) return null;
  if (!normalized.startsWith("reports/")) return null;
  const absolute = path.resolve(workspace, ...normalized.split("/"));
  const prefix = `${path.resolve(workspace)}${path.sep}`.toLowerCase();
  return absolute.toLowerCase().startsWith(prefix) ? absolute : null;
}

function validateUniverse(universe, options = {}) {
  const workspace = path.resolve(options.workspace || WORKSPACE);
  if (!exactKeys(universe, ["schema", "chains", "rows", "exclusions"])) throw new Error("universe top-level keys are invalid");
  if (universe.schema !== UNIVERSE_SCHEMA) throw new Error("universe schema is invalid");
  if (!Array.isArray(universe.chains) || universe.chains.length !== CHAINS.length
    || !universe.chains.every((row) => exactKeys(row, ["chainId", "name"]))
    || JSON.stringify(universe.chains.map((row) => row.chainId)) !== JSON.stringify(CHAINS)
    || universe.chains.some((row) => row.name !== CHAIN_NAMES[row.chainId])) throw new Error("universe chains are invalid");
  if (JSON.stringify(universe.exclusions) !== JSON.stringify(EXCLUSIONS)) throw new Error("universe exclusions are invalid");
  const expectedRowCount = expectedMatrixKeys().length;
  if (!Array.isArray(universe.rows) || universe.rows.length !== expectedRowCount) throw new Error(`universe must contain exactly ${expectedRowCount} rows`);
  const ids = new Set();
  const matrix = [];
  for (const row of universe.rows) {
    if (!exactKeys(row, ROW_KEYS)) throw new Error(`row keys are invalid: ${row?.id || "unknown"}`);
    if (typeof row.id !== "string" || !/^[a-z0-9-]+$/.test(row.id) || ids.has(row.id)) throw new Error(`duplicate or invalid row id: ${row.id}`);
    if (!CHAINS.includes(row.chainId) || !FAMILIES.includes(row.family) || !CLASSES.includes(row.triggerClass)) throw new Error(`unknown row dimension: ${row.id}`);
    if (!ENUMERATION_KINDS.includes(row.enumerationKind) || typeof row.enumerationRef !== "string" || !row.enumerationRef.trim()) throw new Error(`invalid enumeration: ${row.id}`);
    if (!MODES.includes(row.coverageMode)) throw new Error(`invalid coverage mode: ${row.id}`);
    if (!Number.isSafeInteger(row.freshnessSeconds) || row.freshnessSeconds <= 0 || row.freshnessSeconds > 86400) throw new Error(`invalid freshness: ${row.id}`);
    if (!containedArtifactPath(workspace, row.artifactPath)) throw new Error(`artifact path escapes workspace: ${row.id}`);
    if (!exactKeys(row.onFire, ["stages", "enabled"]) || JSON.stringify(row.onFire.stages) !== JSON.stringify(ON_FIRE_STAGES)
      || typeof row.onFire.enabled !== "boolean") throw new Error(`invalid on-fire pipeline: ${row.id}`);
    if (row.coverageMode === "DELTA_ONLY" && row.triggerClass !== "D") throw new Error(`DELTA_ONLY is valid only for D: ${row.id}`);
    if (row.triggerClass === "D" && row.coverageMode === "BOUNDED") throw new Error(`D must use DELTA_ONLY or BLOCKED: ${row.id}`);
    if (row.coverageMode === "BLOCKED" && row.onFire.enabled) throw new Error(`blocked row dispatch must be disabled: ${row.id}`);
    if (row.family === "Aave V4" && row.chainId === 8453 && row.coverageMode !== "BLOCKED") throw new Error(`Base Aave V4 row must be blocked: ${row.id}`);
    ids.add(row.id);
    matrix.push(`${row.chainId}|${row.family}|${row.triggerClass}`);
  }
  if (JSON.stringify(matrix.sort()) !== JSON.stringify(expectedMatrixKeys())) throw new Error("universe row matrix is invalid");
  return true;
}

function sanitizeText(value) {
  let text = String(value ?? "").replace(/[\r\n\t]+/g, " ").trim();
  text = text.replace(/\b(?:https?|wss?):\/\/[^\s]+/gi, "[redacted-endpoint]");
  text = text.replace(/\b((?:api[_-]?key|token|secret|password))\s*[=:]\s*[^\s,;]+/gi, "$1=[redacted]");
  return text.slice(0, 320);
}

function timestampFromArtifact(value) {
  for (const candidate of [value?.observedAt, value?.auditedAt, value?.generatedAt, value?.scannedAt, value?.capturedAt, value?.freshness?.observedAt]) {
    const ms = Date.parse(candidate);
    if (Number.isFinite(ms)) return { text: new Date(ms).toISOString(), ms };
  }
  return null;
}

function nonnegativeCount(value) { return Number.isSafeInteger(value) && value >= 0; }
function genericEvidenceShape(value, row) {
  if (!isObject(value) || value.schema !== EVIDENCE_SCHEMA) return { recognized: false };
  const enumeration = value.enumeration;
  const reads = value.reads;
  const semantics = value.classSemantics;
  const pipeline = value.onFire;
  const identity = value.chainId === row.chainId && value.family === row.family && value.triggerClass === row.triggerClass;
  const enumerationBound = isObject(enumeration) && enumeration.kind === row.enumerationKind && enumeration.ref === row.enumerationRef
    && enumeration.boundDeclared === true && enumeration.successful === true;
  const readsClean = isObject(reads) && [reads.attempted, reads.succeeded, reads.failed, reads.unclassifiedFailures].every(nonnegativeCount)
    && reads.succeeded + reads.failed === reads.attempted && reads.failed === 0 && reads.unclassifiedFailures === 0;
  const semanticsExact = isObject(semantics) && semantics.triggerClass === row.triggerClass && semantics.exact === true;
  const stagesWired = isObject(pipeline) && pipeline.economics === true && pipeline.keylessFixedPinFork === true && pipeline.alert === true;
  const complete = value.coverage?.complete === true;
  const evidence = Array.isArray(value.evidence) ? value.evidence.map(sanitizeText).filter(Boolean) : [];
  const explicitBlockers = Array.isArray(value.blockers) ? value.blockers.map(sanitizeText).filter(Boolean) : [];
  return { recognized: true, identity, enumerationBound, readsClean, semanticsExact, stagesWired, complete, evidence, explicitBlockers, dispatchEnabled: value.dispatchEnabled === true };
}

function legacyAssessment(value, row) {
  const blockers = [];
  const evidence = [];
  if (row.coverageMode === "DELTA_ONLY" && value?.schema === "config-delta-scan/v1") {
    const chain = value.chains?.[String(row.chainId)];
    if (!chain) blockers.push("delta sentinel does not declare this chain");
    if (chain?.chunkFailures > 0) blockers.push("delta sentinel has read failures");
    if (!timestampFromArtifact(value)) blockers.push("delta sentinel has no auditable observation timestamp");
    blockers.push("delta sentinel has no complete economics/fork/alert feeder");
    evidence.push(`${row.artifactPath}#schema=config-delta-scan/v1`);
    if (chain) evidence.push(`${row.artifactPath}#chains.${row.chainId}`);
    return { recognized: true, blockers, evidence };
  }
  if (value?.sourceCoverage?.schema === "aave-source-coverage/v1") {
    const coverage = value.sourceCoverage;
    if (coverage.complete !== true || coverage.sampleComplete !== true) blockers.push("declared Aave enumeration bound is incomplete");
    for (const key of ["logChunksFailed", "accountReadsFailed", "reserveReadsFailed", "stateReadsFailed"]) {
      if ((coverage[key] || 0) > 0) blockers.push(`Aave source reports ${key}=${coverage[key]}`);
    }
    if (row.family === "Aave V4" && (coverage.topologySourceSampleComplete === false || coverage.topologyUniverse?.bound === false)) blockers.push("Aave V4 topology/source is not structurally bound");
    blockers.push("keyless fixed-pin fork adapter is not wired to this row");
    evidence.push(`${row.artifactPath}#sourceCoverage`);
    return { recognized: true, blockers, evidence };
  }
  if (value?.scanner === "tools/morpho-find-liquidatable.js") {
    if (value.complete !== true || value.coverage?.fullHistoryProven !== true) blockers.push("Morpho active-position enumeration is a bounded recent suffix");
    if (value.results?.valuationStatus !== "available") blockers.push("Morpho executable unwind valuation is absent");
    blockers.push("keyless fixed-pin fork adapter is not wired to this row");
    evidence.push(`${row.artifactPath}#coverage`, `${row.artifactPath}#results`);
    return { recognized: true, blockers, evidence };
  }
  if (value?.schema === "morpho-frozen-oracle-status/read-only/v1") {
    const matching = Array.isArray(value.markets) ? value.markets.filter((market) => market.chainId === row.chainId) : [];
    if (!matching.length) blockers.push("no bounded oracle rows for the declared chain");
    if (matching.some((market) => market.status === "REFERENCE_UNAVAILABLE" || (market.errors || []).length)) blockers.push("oracle/reference observations are incomplete");
    blockers.push("public atomic extraction economics and keyless fixed-pin fork are not wired");
    evidence.push(`${row.artifactPath}#markets`);
    return { recognized: true, blockers, evidence };
  }
  if (value?.scanner === "tools/scan-cross-dex-arbitrage.js" && value?.schemaVersion === 2) {
    if (value.chainId !== row.chainId) blockers.push("bounded FRAX/USDC producer does not cover the declared chain");
    if (!Array.isArray(value.rows) || value.rows.some((candidate) => candidate.classification === "INCOMPLETE")) blockers.push("cross-venue round-trip observation is incomplete");
    blockers.push("FRAX/USDC observation has no keyless fixed-pin fork and alert wiring");
    evidence.push(`${row.artifactPath}#routeBinding`, `${row.artifactPath}#methodology`);
    return { recognized: true, blockers, evidence };
  }
  return { recognized: false, blockers: [], evidence: [] };
}

function auditRow(row, options = {}) {
  const workspace = path.resolve(options.workspace || WORKSPACE);
  const nowMs = options.nowMs ?? Date.now();
  const file = containedArtifactPath(workspace, row.artifactPath);
  let bytes = null;
  let value = null;
  try {
    bytes = fs.readFileSync(file);
    value = JSON.parse(bytes.toString("utf8"));
  } catch (_) {}
  const dispatchDisabled = row.onFire.enabled === false;
  const artifactSha256 = bytes ? sha256(bytes) : null;
  const timestamp = value ? timestampFromArtifact(value) : null;
  const observedAt = timestamp?.text || iso(nowMs);
  const expiresAt = timestamp ? iso(timestamp.ms + row.freshnessSeconds * 1000) : null;
  const fresh = Boolean(timestamp && timestamp.ms <= nowMs + 300_000 && timestamp.ms + row.freshnessSeconds * 1000 >= nowMs);
  const generic = genericEvidenceShape(value, row);
  const legacy = generic.recognized ? { recognized: false, blockers: [], evidence: [] } : legacyAssessment(value, row);
  let status;
  let evidence = [];
  let blockers = [];

  if (generic.recognized) {
    evidence = generic.evidence;
    blockers.push(...generic.explicitBlockers);
    if (!generic.identity) blockers.push("artifact identity does not match the declared row");
    if (!generic.enumerationBound) blockers.push("declared enumeration bound did not succeed");
    if (!generic.readsClean) blockers.push("read accounting is incomplete or has unclassified failures");
    if (!generic.semanticsExact) blockers.push("exact trigger-class semantics are not proven");
    if (!generic.complete) blockers.push("coverage artifact does not claim complete bounded coverage");
    if (!generic.stagesWired || !row.onFire.enabled || !generic.dispatchEnabled) blockers.push("economics -> keyless-fixed-pin-fork -> alert is not fully wired");
    const covered = fresh && !blockers.length;
    if (covered) status = "COVERED";
    else if (!fresh && !dispatchDisabled) status = timestamp ? "STALE" : "MISSING";
    else if (dispatchDisabled && evidence.length && blockers.length) status = "BLOCKED";
    else status = "MISSING";
  } else if (legacy.recognized) {
    evidence = legacy.evidence;
    blockers = legacy.blockers;
    if (!fresh) blockers.push(timestamp ? "underlying artifact is stale" : "underlying artifact has no valid observation timestamp");
    if (dispatchDisabled) blockers.push("on-fire dispatch is disabled");
    status = dispatchDisabled && evidence.length && blockers.length ? "BLOCKED" : timestamp ? "STALE" : "MISSING";
  } else if (!bytes) {
    blockers = ["declared coverage artifact/producer is absent"];
    evidence = dispatchDisabled ? [`filesystem absence observed for ${row.artifactPath}`, `dispatch disabled for ${row.id}`] : [];
    if (row.coverageMode === "BLOCKED") blockers.push(sanitizeText(row.enumerationRef));
    if (dispatchDisabled) blockers.push("on-fire dispatch is disabled");
    status = dispatchDisabled && evidence.length ? "BLOCKED" : "MISSING";
  } else {
    blockers = ["artifact is not a recognized trigger coverage schema"];
    evidence = dispatchDisabled ? [`schema mismatch observed for ${row.artifactPath}`, `dispatch disabled for ${row.id}`] : [];
    if (!fresh) blockers.push(timestamp ? "underlying artifact is stale" : "underlying artifact has no valid observation timestamp");
    if (dispatchDisabled) blockers.push("on-fire dispatch is disabled");
    status = dispatchDisabled ? "BLOCKED" : timestamp && !fresh ? "STALE" : "MISSING";
  }

  evidence = [...new Set(evidence.map(sanitizeText).filter(Boolean))];
  blockers = [...new Set(blockers.map(sanitizeText).filter(Boolean))];
  if (status === "BLOCKED" && (!dispatchDisabled || !evidence.length || !blockers.length)) status = "MISSING";
  if (status === "COVERED") blockers = [];
  return { id: row.id, status, observedAt, expiresAt, artifactPath: row.artifactPath, artifactSha256, evidence, blockers };
}

function atomicWriteJson(file, value, options = {}) {
  const fsImpl = options.fsImpl || fs;
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${crypto.randomUUID()}`;
  try {
    fsImpl.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    fsImpl.renameSync(temporary, file);
  } finally {
    try { fsImpl.rmSync(temporary, { force: true }); } catch (_) {}
  }
}

function runAudit(options = {}) {
  const workspace = path.resolve(options.workspace || WORKSPACE);
  const universePath = path.resolve(options.universePath || UNIVERSE_PATH);
  const nowMs = options.nowMs ?? Date.now();
  const raw = fs.readFileSync(universePath);
  const universe = JSON.parse(raw.toString("utf8"));
  validateUniverse(universe, { workspace });
  const rows = universe.rows.map((row) => auditRow(row, { workspace, nowMs }));
  const audit = {
    schema: AUDIT_SCHEMA,
    auditedAt: iso(nowMs),
    universeSha256: sha256(raw),
    rows,
    done: rows.every((row) => row.status === "COVERED" || row.status === "BLOCKED"),
  };
  if (options.apply) atomicWriteJson(path.resolve(options.outputPath || OUT_PATH), audit, options);
  return audit;
}

function parseOptions(argv) {
  const unknown = argv.filter((arg) => !["--check", "--apply"].includes(arg));
  if (unknown.length || (argv.includes("--check") && argv.includes("--apply"))) throw new Error("usage: audit-trigger-coverage-universe.js [--check|--apply]");
  return { apply: argv.includes("--apply") };
}

function summary(audit) {
  const counts = Object.fromEntries(["COVERED", "BLOCKED", "MISSING", "STALE"].map((status) => [status, audit.rows.filter((row) => row.status === status).length]));
  return `trigger-coverage rows=${audit.rows.length} covered=${counts.COVERED} blocked=${counts.BLOCKED} missing=${counts.MISSING} stale=${counts.STALE} done=${audit.done}`;
}

if (require.main === module) {
  try {
    const options = parseOptions(process.argv.slice(2));
    const audit = runAudit(options);
    process.stdout.write(`${summary(audit)}\n`);
  } catch (error) {
    process.stderr.write(`trigger-coverage-audit failed closed: ${sanitizeText(error?.message || error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  WORKSPACE, UNIVERSE_PATH, OUT_PATH, UNIVERSE_SCHEMA, AUDIT_SCHEMA, EVIDENCE_SCHEMA,
  ROW_KEYS, AUDIT_ROW_KEYS, CHAINS, FAMILIES, CLASSES, MODES, EXCLUSIONS, EXPECTED_MATRIX,
  sha256, sanitizeText, containedArtifactPath, expectedMatrixKeys, validateUniverse,
  genericEvidenceShape, legacyAssessment, auditRow, atomicWriteJson, runAudit, parseOptions, summary,
};
