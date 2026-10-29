#!/usr/bin/env node
"use strict";

// Commitment-only, non-executing invariant-plan gate.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const SCHEMA = "deployed-delta-invariant-planner/v1";
const OUTPUT = path.join(path.resolve(__dirname, ".."), "reports", "monitor", "deployed-delta-invariant-planner.json");
const MAX_ROWS = 64;
const MAX_PLANS = 256;
const MAX_OUTPUT_BYTES = 128 * 1024;
const CLASSES = new Set(["share-accounting", "oracle-price", "liquidation-rounding", "queue-epoch", "proxy-module", "new-market-unpause", "other"]);
const TEMPLATES = Object.freeze({
  "share-accounting": "SHARE_ACCOUNTING_CONSERVATION_DILUTION",
  "oracle-price": "ORACLE_PRICE_FRESHNESS",
  "liquidation-rounding": "LIQUIDATION_ROUNDING",
  "queue-epoch": "QUEUE_SETTLEMENT",
  "proxy-module": "PROXY_UPGRADE_CONTINUITY",
  "new-market-unpause": "NEW_MARKET_UNPAUSE_CONFIGURATION",
  other: "OTHER_UNKNOWN"
});
const STATUSES = new Set(["PLANNED", "BLOCKED", "UNKNOWN"]);
const REASONS = new Set(["EXACT_AUTHORITY_AND_PASS_BINDER", "AUTHORITY_OR_BINDER_JOIN_MISSING", "CLASS_TEMPLATE_UNKNOWN"]);
const ADDRESS = /0x[0-9a-f]{40}(?:[0-9a-f]{24})?/i;
const URL_OR_SECRET = /(?:https?|wss?|ftp):\/\/|\bwww\.|authorization\s*:|bearer\s|(?:api|access)[_-]?key|private[_-]?key|client[_-]?secret|access[_-]?token|mnemonic|seed[_-]?phrase|rpc[_-]?(?:url|endpoint)|graphql[_-]?endpoint|\.env\b|\b(?:password|credential|secret)s?\b/i;
const FORBIDDEN = /(?:target|address|url|source|calldata|economic|profit|loss|pnl|liquidity|amount|bytecode|abi|runtime)/i;

class PlannerError extends Error { constructor(code) { super(code); this.name = "PlannerError"; this.code = code; } }
function fail(code) { throw new PlannerError(code); }
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function keys(value, expected) { return object(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()); }
function sha(value, nullable = false) { return (nullable && value === null) || (typeof value === "string" && /^[0-9a-f]{64}$/.test(value)); }
function iso(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!object(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}
function commitment(domain, value) {
  return crypto.createHash("sha256").update(`${SCHEMA}\0${domain}\0`).update(JSON.stringify(canonical(value))).digest("hex");
}
function sortedStrings(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= CLASSES.size
    && value.every((item) => CLASSES.has(item)) && new Set(value).size === value.length;
}
function safe(value) {
  const text = JSON.stringify(value);
  return !ADDRESS.test(text) && !URL_OR_SECRET.test(text) && !FORBIDDEN.test(text);
}
function authorityRow(value) { return keys(value, ["recordCommitment", "authorityCommitment", "status"]) && sha(value.recordCommitment) && sha(value.authorityCommitment, true) && ["EXACT", "UNKNOWN"].includes(value.status) && (value.status === "EXACT" ? value.authorityCommitment !== null : value.authorityCommitment === null); }
function binderRow(value) { return keys(value, ["recordCommitment", "authorityCommitment", "binderCommitment", "status"]) && sha(value.recordCommitment) && sha(value.authorityCommitment, true) && sha(value.binderCommitment) && ["PASS", "FAIL", "UNKNOWN", "BLOCKED"].includes(value.status) && (value.status === "PASS" ? value.authorityCommitment !== null : true); }
function scorerRow(value) { return keys(value, ["recordCommitment", "scorerCommitment", "classes"]) && sha(value.recordCommitment) && sha(value.scorerCommitment) && sortedStrings(value.classes); }
function rowMaterial(row) { return { recordCommitment: row.recordCommitment, authorityCommitment: row.authorityCommitment, binderCommitment: row.binderCommitment, scorerCommitment: row.scorerCommitment, class: row.class, template: row.template, status: row.status, reason: row.reason }; }
function makeRow(material) { return { ...material, planCommitment: commitment("invariant-plan", material) }; }
function compare(a, b) { return a.planCommitment.localeCompare(b.planCommitment); }
function validPlan(row) {
  if (!keys(row, ["recordCommitment", "authorityCommitment", "binderCommitment", "scorerCommitment", "class", "template", "status", "reason", "planCommitment"])
    || !sha(row.recordCommitment) || !sha(row.authorityCommitment, true) || !sha(row.binderCommitment, true) || !sha(row.scorerCommitment, true)
    || !CLASSES.has(row.class) || row.template !== TEMPLATES[row.class] || !STATUSES.has(row.status) || !REASONS.has(row.reason) || !sha(row.planCommitment)
    || row.planCommitment !== commitment("invariant-plan", rowMaterial(row))) return false;
  if (row.status === "PLANNED") return row.reason === "EXACT_AUTHORITY_AND_PASS_BINDER" && row.authorityCommitment !== null && row.binderCommitment !== null && row.scorerCommitment !== null && row.class !== "other";
  if (row.status === "UNKNOWN") return row.reason === "CLASS_TEMPLATE_UNKNOWN" && row.scorerCommitment !== null && row.class === "other";
  return row.reason === "AUTHORITY_OR_BINDER_JOIN_MISSING" && row.status === "BLOCKED";
}
function safety() { return { localOnly: true, networkAccess: false, rpcAccess: false, forkUse: false, processExecution: false, signing: false, transactions: false, automaticExecution: false }; }
function validateArtifact(value) {
  try {
    if (!keys(value, ["schema", "generatedAt", "upstreamExtractorCommitment", "authorityBatchCommitment", "binderBatchCommitment", "scorerBatchCommitment", "planBatchCommitment", "counts", "plans", "safety"])
      || value.schema !== SCHEMA || !iso(value.generatedAt) || !sha(value.upstreamExtractorCommitment) || !sha(value.authorityBatchCommitment) || !sha(value.binderBatchCommitment) || !sha(value.scorerBatchCommitment) || !sha(value.planBatchCommitment)
      || !keys(value.counts, ["planned", "blocked", "unknown"]) || Object.values(value.counts).some((count) => !Number.isSafeInteger(count) || count < 0 || count > MAX_PLANS)
      || !Array.isArray(value.plans) || value.plans.length > MAX_PLANS || value.plans.some((row) => !validPlan(row)) || new Set(value.plans.map((row) => row.planCommitment)).size !== value.plans.length
      || JSON.stringify(value.plans) !== JSON.stringify([...value.plans].sort(compare)) || value.counts.planned !== value.plans.filter((row) => row.status === "PLANNED").length || value.counts.blocked !== value.plans.filter((row) => row.status === "BLOCKED").length || value.counts.unknown !== value.plans.filter((row) => row.status === "UNKNOWN").length
      || value.planBatchCommitment !== commitment("invariant-plan-batch", { upstreamExtractorCommitment: value.upstreamExtractorCommitment, authorityBatchCommitment: value.authorityBatchCommitment, binderBatchCommitment: value.binderBatchCommitment, scorerBatchCommitment: value.scorerBatchCommitment, plans: value.plans })
      || !keys(value.safety, ["localOnly", "networkAccess", "rpcAccess", "forkUse", "processExecution", "signing", "transactions", "automaticExecution"]) || value.safety.localOnly !== true || Object.entries(value.safety).some(([key, item]) => key !== "localOnly" && item !== false) || !safe(value)) return false;
    return value.plans.length === value.counts.planned + value.counts.blocked + value.counts.unknown;
  } catch (_) { return false; }
}
function normalizeNow(now) { const value = now === undefined ? Date.now() : (typeof now === "function" ? now() : now); if (!Number.isSafeInteger(value) || value < 0 || !Number.isFinite(new Date(value).getTime())) fail("INVALID_NOW"); return value; }
function planBatch(options = {}) {
  const now = normalizeNow(options.now);
  if (!sha(options.upstreamExtractorCommitment)) fail("UPSTREAM_EXTRACTOR_COMMITMENT_INVALID");
  const batches = ["authorityBatchCommitment", "binderBatchCommitment", "scorerBatchCommitment"];
  if (batches.some((key) => !sha(options[key]))) fail("BATCH_COMMITMENT_INVALID");
  const authority = Array.isArray(options.authorityRows) && options.authorityRows.length <= MAX_ROWS ? options.authorityRows : null;
  const binder = Array.isArray(options.binderRows) && options.binderRows.length <= MAX_ROWS ? options.binderRows : null;
  const scorer = Array.isArray(options.scorerRows) && options.scorerRows.length <= MAX_ROWS ? options.scorerRows : null;
  const inputValid = authority && binder && scorer && authority.every(authorityRow) && binder.every(binderRow) && scorer.every(scorerRow) && safe({ authority, binder, scorer });
  if (!inputValid) fail("INPUT_INVALID");
  const authorityByRecord = new Map(authority.map((row) => [row.recordCommitment, row]));
  const binderByRecord = new Map(binder.map((row) => [row.recordCommitment, row]));
  const plans = [];
  for (const scored of scorer) for (const klass of scored.classes) {
    const exact = authorityByRecord.get(scored.recordCommitment);
    const bound = binderByRecord.get(scored.recordCommitment);
    const joined = exact && bound && exact.status === "EXACT" && bound.status === "PASS" && exact.authorityCommitment === bound.authorityCommitment;
    const material = klass === "other"
      ? { recordCommitment: scored.recordCommitment, authorityCommitment: exact ? exact.authorityCommitment : null, binderCommitment: bound ? bound.binderCommitment : null, scorerCommitment: scored.scorerCommitment, class: "other", template: TEMPLATES.other, status: "UNKNOWN", reason: "CLASS_TEMPLATE_UNKNOWN" }
      : joined
        ? { recordCommitment: scored.recordCommitment, authorityCommitment: exact.authorityCommitment, binderCommitment: bound.binderCommitment, scorerCommitment: scored.scorerCommitment, class: klass, template: TEMPLATES[klass], status: "PLANNED", reason: "EXACT_AUTHORITY_AND_PASS_BINDER" }
        : { recordCommitment: scored.recordCommitment, authorityCommitment: exact ? exact.authorityCommitment : null, binderCommitment: bound ? bound.binderCommitment : null, scorerCommitment: scored.scorerCommitment, class: klass, template: TEMPLATES[klass], status: "BLOCKED", reason: "AUTHORITY_OR_BINDER_JOIN_MISSING" };
    plans.push(makeRow(material));
  }
  if (plans.length > MAX_PLANS) fail("PLAN_LIMIT_EXCEEDED");
  plans.sort(compare);
  const artifact = { schema: SCHEMA, generatedAt: new Date(now).toISOString(), upstreamExtractorCommitment: options.upstreamExtractorCommitment, authorityBatchCommitment: options.authorityBatchCommitment, binderBatchCommitment: options.binderBatchCommitment, scorerBatchCommitment: options.scorerBatchCommitment, planBatchCommitment: commitment("invariant-plan-batch", { upstreamExtractorCommitment: options.upstreamExtractorCommitment, authorityBatchCommitment: options.authorityBatchCommitment, binderBatchCommitment: options.binderBatchCommitment, scorerBatchCommitment: options.scorerBatchCommitment, plans }), counts: { planned: plans.filter((row) => row.status === "PLANNED").length, blocked: plans.filter((row) => row.status === "BLOCKED").length, unknown: plans.filter((row) => row.status === "UNKNOWN").length }, plans, safety: safety() };
  if (!validateArtifact(artifact)) fail("ARTIFACT_INVALID");
  return artifact;
}
function publishAtomic(artifact, options = {}) {
  if (!validateArtifact(artifact)) fail("ARTIFACT_INVALID");
  const fsImpl = options.fsImpl || fs; const output = path.resolve(options.outputPath || OUTPUT); const directory = path.dirname(output);
  fsImpl.mkdirSync(directory, { recursive: true }); const stat = fsImpl.lstatSync(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) fail("OUTPUT_DIRECTORY_INVALID");
  const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`); if (bytes.length > MAX_OUTPUT_BYTES) fail("OUTPUT_TOO_LARGE");
  const temporary = path.join(directory, `.${path.basename(output)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`); let fd;
  try { fd = fsImpl.openSync(temporary, "wx", 0o600); fsImpl.writeFileSync(fd, bytes); fsImpl.fsyncSync(fd); fsImpl.closeSync(fd); fd = undefined; fsImpl.renameSync(temporary, output); const readback = fsImpl.readFileSync(output); if (!readback.equals(bytes) || !validateArtifact(JSON.parse(readback.toString("utf8")))) fail("READBACK_INVALID"); return output; } finally { if (fd !== undefined) try { fsImpl.closeSync(fd); } catch (_) {} try { if (fsImpl.existsSync(temporary)) fsImpl.unlinkSync(temporary); } catch (_) {} }
}
function runAndPublish(options = {}) { const artifact = planBatch(options); publishAtomic(artifact, options); return artifact; }
function main(argv = process.argv.slice(2)) { if (!Array.isArray(argv) || argv.length !== 0) { process.stderr.write("deployed-delta-invariant-planner: unsupported arguments\n"); process.exitCode = 2; return; } try { process.stdout.write("deployed-delta-invariant-planner: commitment input required\n"); process.exitCode = 2; } catch (_) { process.exitCode = 1; } }
module.exports = Object.freeze({ SCHEMA, OUTPUT, PlannerError, TEMPLATES, commitment, validateArtifact, planBatch, publishAtomic, runAndPublish, main });
if (require.main === module) main();
