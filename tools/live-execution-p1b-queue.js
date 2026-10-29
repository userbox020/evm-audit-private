#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const batchTool = require("./live-execution-batch.js");
const runner = require("./run-approved-fork-validation.js");

const ROOT = path.resolve(__dirname, "..");
const QUEUE_ROOT = path.join(ROOT, "coordination", "live-execution-p1b-queue-v1");
const TEST_ROOT = process.platform === "win32" ? "C:\\Users\\MiPC\\AppData\\Local\\Temp\\opencode" : "/mnt/c/Users/MiPC/AppData/Local/Temp/opencode";
const REQUEST_SCHEMA = "live-execution-p1b-request/v1";
const DECISION_SCHEMA = "live-execution-p1b-decision/v1";
const RESULT_SCHEMA = "live-execution-p1b-result/v1";
const REQUEST_DOMAIN = "EVM_AUDIT_P1B_QUEUE_REQUEST_V1\0";
const DECISION_DOMAIN = "EVM_AUDIT_P1B_QUEUE_DECISION_V1\0";
const SMALL_CAP = 8 * 1024;
const HASH = /^0x[0-9a-f]{64}$/u;
const RESULT_STATES = new Set(["COMPLETED", "FAILED", "INCOMPLETE"]);
const CONSUMPTION_STATES = new Set(["CONFIRMED", "UNKNOWN"]);
const RESULT_BLOCKERS = new Set(["RUNNER_FAILED", "RUNNER_OUTPUT_INVALID", "RUNNER_INCOMPLETE", "CONSUMPTION_UNCONFIRMED"]);

class QueueError extends Error {
  constructor(code) { super(code); this.name = "QueueError"; this.code = code; }
}
function fail(code) { throw new QueueError(code); }
function exactKeys(value, keys) { return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function hashBytes(bytes) { return `0x${crypto.createHash("sha256").update(bytes).digest("hex")}`; }
function validateHash(value, code = "REQUEST_COMMITMENT_INVALID") { if (typeof value !== "string" || !HASH.test(value)) fail(code); return value; }
function decodeUtf8(bytes, code) { try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch (_) { fail(code); } }
function parseJson(bytes, code) { try { return JSON.parse(decodeUtf8(bytes, code)); } catch (error) { if (error instanceof QueueError) throw error; fail(code); } }
function validateRequest(request) {
  if (!exactKeys(request, ["schema", "manifestBytesSha256", "manifestCommitment"]) || request.schema !== REQUEST_SCHEMA) fail("REQUEST_SCHEMA_INVALID");
  validateHash(request.manifestBytesSha256, "REQUEST_MANIFEST_BYTES_INVALID");
  validateHash(request.manifestCommitment, "REQUEST_MANIFEST_COMMITMENT_INVALID");
  batchTool.leakGuard(request);
  return request;
}
function requestCommitment(request) {
  validateRequest(request);
  return hashBytes(Buffer.from(`${REQUEST_DOMAIN}${batchTool.canonical(request)}`, "utf8"));
}
function decisionCommitment(decision) { return hashBytes(Buffer.from(`${DECISION_DOMAIN}${batchTool.canonical(decision)}`, "utf8")); }
function canonicalBytes(value) { return Buffer.from(`${batchTool.canonical(value)}\n`, "utf8"); }
function decisionBytes(value) { return canonicalBytes(value); }
function resultBytes(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"); }
function pathsFor(root, commitment) {
  const hex = validateHash(commitment).slice(2);
  return Object.freeze({
    manifest: path.join(root, `${hex}.manifest.json`), request: path.join(root, `${hex}.request.json`),
    decision: path.join(root, `${hex}.decision.json`), result: path.join(root, `${hex}.result.json`), hex,
  });
}
function sameIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs; }
function strictRead(file, cap, ctx) {
  const io = ctx.io, expected = path.resolve(file);
  let before, real, fd;
  try { before = io.lstatSync(expected); real = io.realpathSync(expected); }
  catch (_) { fail("QUEUE_FILE_UNAVAILABLE"); }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || real !== expected || before.size < 1 || before.size > cap) fail("QUEUE_FILE_INVALID");
  try {
    const noFollow = ctx.testOnly ? 0 : io.constants.O_NOFOLLOW;
    fd = io.openSync(expected, io.constants.O_RDONLY | noFollow);
    const opened = io.fstatSync(fd);
    if (!sameIdentity(before, opened)) fail("QUEUE_FILE_IDENTITY_CHANGED");
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) { const count = io.readSync(fd, bytes, offset, bytes.length - offset, offset); if (!Number.isInteger(count) || count <= 0) fail("QUEUE_FILE_READ_INCOMPLETE"); offset += count; }
    const afterFd = io.fstatSync(fd), after = io.lstatSync(expected);
    if (!sameIdentity(opened, afterFd) || !sameIdentity(before, after) || io.realpathSync(expected) !== expected) fail("QUEUE_FILE_IDENTITY_CHANGED");
    return bytes;
  } catch (error) { if (error instanceof QueueError) throw error; fail("QUEUE_FILE_READ_FAILED"); }
  finally { if (fd !== undefined) try { io.closeSync(fd); } catch (_) { fail("QUEUE_FILE_CLOSE_FAILED"); } }
}
function present(file, io) { try { return io.lstatSync(file), true; } catch (error) { if (error?.code === "ENOENT") return false; fail("QUEUE_PATH_UNAVAILABLE"); } }
function fsyncDirectory(directory, io) { let fd; try { fd = io.openSync(directory, io.constants.O_RDONLY); io.fsyncSync(fd); } catch (_) { fail("QUEUE_DURABILITY_UNSUPPORTED"); } finally { if (fd !== undefined) try { io.closeSync(fd); } catch (_) { fail("QUEUE_DURABILITY_UNSUPPORTED"); } } }
function assertTestRoot(root) {
  const resolved = path.resolve(root), prefix = `${path.resolve(TEST_ROOT)}${path.sep}`;
  if (!resolved.toLowerCase().startsWith(prefix.toLowerCase())) fail("TEST_ROOT_FORBIDDEN");
}
function qualifyRoot(ctx, create) {
  const io = ctx.io, root = ctx.root;
  if (!ctx.testOnly) {
    if (process.platform !== "linux" || root !== QUEUE_ROOT || typeof process.getuid !== "function" || !Number.isInteger(io.constants.O_NOFOLLOW)) fail("QUEUE_SECURE_HOST_REQUIRED");
    const parent = path.dirname(root);
    let parentStat, parentReal;
    try { parentStat = io.lstatSync(parent); parentReal = io.realpathSync(parent); } catch (_) { fail("QUEUE_PARENT_UNAVAILABLE"); }
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || parentReal !== parent || parentStat.uid !== process.getuid() || (parentStat.mode & 0o022) !== 0) fail("QUEUE_PARENT_UNSAFE");
  } else assertTestRoot(root);
  if (!present(root, io)) {
    if (!create) return false;
    const parent = path.dirname(root);
    if (!present(parent, io)) fail("QUEUE_PARENT_UNAVAILABLE");
    try { io.mkdirSync(root, { mode: 0o700 }); } catch (_) { fail("QUEUE_ROOT_CREATE_FAILED"); }
    if (!ctx.testOnly) fsyncDirectory(parent, io);
  }
  let stat, real;
  try { stat = io.lstatSync(root); real = io.realpathSync(root); } catch (_) { fail("QUEUE_ROOT_INVALID"); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || real !== root) fail("QUEUE_ROOT_INVALID");
  if (!ctx.testOnly) {
    if (stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) fail("QUEUE_ROOT_INVALID");
    fsyncDirectory(root, io);
  }
  return true;
}
function validateReviewedManifest(manifestPath, expectedDigest, ctx) {
  if (typeof manifestPath !== "string" || !path.isAbsolute(manifestPath)) fail("MANIFEST_PATH_INVALID");
  if (ctx.testOnly) assertTestRoot(manifestPath);
  validateHash(expectedDigest, "MANIFEST_BYTES_SHA256_INVALID");
  if (!ctx.testOnly && process.platform !== "linux") fail("QUEUE_SECURE_HOST_REQUIRED");
  const bytes = strictRead(manifestPath, batchTool.CAPS.batchBytes, ctx);
  if (hashBytes(bytes) !== expectedDigest) fail("MANIFEST_BYTES_SHA256_MISMATCH");
  const manifest = parseJson(bytes, "MANIFEST_UTF8_OR_JSON_INVALID");
  try { runner.validateManifest(manifest); runner.leakGuard(manifest); } catch (_) { fail("MANIFEST_INVALID"); }
  return { bytes, manifest, commitment: runner.manifestCommitment(manifest) };
}
function validateDecision(value, commitment) {
  if (!value || value.schema !== DECISION_SCHEMA || value.requestCommitment !== commitment) fail("DECISION_INVALID");
  if (value.decision === "CANCELLED") { if (!exactKeys(value, ["schema", "requestCommitment", "decision"])) fail("DECISION_INVALID"); }
  else if (value.decision === "CLAIMED") {
    if (!exactKeys(value, ["schema", "requestCommitment", "decision", "expectedBatchCommitment", "runId"]) || !HASH.test(value.expectedBatchCommitment) || value.runId !== `p1b-${commitment.slice(2)}`) fail("DECISION_INVALID");
  } else fail("DECISION_INVALID");
  return value;
}
function validRunnerOutput(output, expectedBatchCommitment, expectedManifestCommitment) {
  try {
    if (!output || typeof output !== "object" || Array.isArray(output) || output.schema !== runner.OUTPUT_SCHEMA || output.batchCommitment !== expectedBatchCommitment || output.manifestCommitment !== expectedManifestCommitment) return false;
    runner.leakGuard(output);
    return Buffer.byteLength(JSON.stringify(output), "utf8") <= batchTool.CAPS.batchBytes;
  } catch (_) { return false; }
}
function completedRunnerOutput(output, expectedBatchCommitment, expectedManifestCommitment) {
  return validRunnerOutput(output, expectedBatchCommitment, expectedManifestCommitment) && output.status === "FORK_VALIDATION_COMPLETE" && output.authorizationStateAtRun === "CONSUMED" && output.cleanup?.child === "STOPPED" && output.cleanup?.relay === "CLOSED";
}
function validateResult(value, commitment, decisionHash, expectedBatchCommitment, expectedManifestCommitment) {
  if (!exactKeys(value, ["schema", "requestCommitment", "decisionCommitment", "state", "consumption", "blocker", "runnerOutput"]) || value.schema !== RESULT_SCHEMA || value.requestCommitment !== commitment || value.decisionCommitment !== decisionHash || !RESULT_STATES.has(value.state) || !CONSUMPTION_STATES.has(value.consumption)) fail("RESULT_INVALID");
  if (value.blocker !== null && !RESULT_BLOCKERS.has(value.blocker)) fail("RESULT_INVALID");
  if (value.runnerOutput !== null && !validRunnerOutput(value.runnerOutput, expectedBatchCommitment, expectedManifestCommitment)) fail("RESULT_INVALID");
  const complete = completedRunnerOutput(value.runnerOutput, expectedBatchCommitment, expectedManifestCommitment);
  if (value.state === "COMPLETED" && (value.consumption !== "CONFIRMED" || value.blocker !== null || !complete)) fail("RESULT_INVALID");
  if (value.state === "FAILED" && (value.consumption !== "CONFIRMED" || value.blocker !== "RUNNER_FAILED" || value.runnerOutput === null)) fail("RESULT_INVALID");
  if (value.state === "INCOMPLETE" && !["RUNNER_OUTPUT_INVALID", "RUNNER_INCOMPLETE", "CONSUMPTION_UNCONFIRMED"].includes(value.blocker)) fail("RESULT_INVALID");
  if ((value.consumption === "UNKNOWN") !== (value.state === "INCOMPLETE" && value.blocker === "CONSUMPTION_UNCONFIRMED")) fail("RESULT_INVALID");
  runner.leakGuard(value);
  return value;
}
function loadEntry(commitment, ctx) {
  validateHash(commitment);
  if (!qualifyRoot(ctx, false)) return { status: "ABSENT", requestCommitment: commitment };
  const files = pathsFor(ctx.root, commitment), has = Object.fromEntries(Object.entries(files).filter(([key]) => key !== "hex").map(([key, file]) => [key, present(file, ctx.io)]));
  if (!has.manifest && !has.request && !has.decision && !has.result) return { status: "ABSENT", requestCommitment: commitment, _files: files };
  if (!has.manifest || !has.request) return { status: "INCOMPLETE_ENQUEUE", requestCommitment: commitment, _files: files };
  let manifestBytes, requestBytes, request, manifest;
  try {
    manifestBytes = strictRead(files.manifest, batchTool.CAPS.batchBytes, ctx);
    requestBytes = strictRead(files.request, SMALL_CAP, ctx);
    request = validateRequest(parseJson(requestBytes, "REQUEST_INVALID"));
    if (!requestBytes.equals(canonicalBytes(request)) || requestCommitment(request) !== commitment || hashBytes(manifestBytes) !== request.manifestBytesSha256) fail("ENTRY_BINDING_INVALID");
    manifest = parseJson(manifestBytes, "MANIFEST_INVALID"); runner.validateManifest(manifest); runner.leakGuard(manifest);
    if (runner.manifestCommitment(manifest) !== request.manifestCommitment) fail("ENTRY_BINDING_INVALID");
  } catch (_) { return { status: "INVALID", requestCommitment: commitment, _files: files }; }
  if (!has.decision) return { status: has.result ? "INCOMPLETE" : "QUEUED", requestCommitment: commitment, manifestBytesSha256: request.manifestBytesSha256, manifestCommitment: request.manifestCommitment, authorizationEvaluated: false, _files: files, _manifest: manifest, _request: request, _manifestBytes: manifestBytes };
  let decision, decisionHash;
  try { const bytes = strictRead(files.decision, SMALL_CAP, ctx); decision = validateDecision(parseJson(bytes, "DECISION_INVALID"), commitment); if (!bytes.equals(decisionBytes(decision))) fail("DECISION_INVALID"); decisionHash = decisionCommitment(decision); }
  catch (_) { return { status: "INVALID", requestCommitment: commitment, _files: files }; }
  if (decision.decision === "CANCELLED") return { status: has.result ? "INCOMPLETE" : "CANCELLED", requestCommitment: commitment, decisionCommitment: decisionHash, _files: files, _decision: decision };
  if (!has.result) return { status: "CLAIMED_UNRESOLVED", requestCommitment: commitment, decisionCommitment: decisionHash, expectedBatchCommitment: decision.expectedBatchCommitment, runId: decision.runId, _files: files, _decision: decision };
  try {
    const bytes = strictRead(files.result, batchTool.CAPS.batchBytes, ctx), result = validateResult(parseJson(bytes, "RESULT_INVALID"), commitment, decisionHash, decision.expectedBatchCommitment, request.manifestCommitment);
    if (!bytes.equals(resultBytes(result))) fail("RESULT_INVALID");
    return { status: result.state, requestCommitment: commitment, decisionCommitment: decisionHash, expectedBatchCommitment: decision.expectedBatchCommitment, runId: decision.runId, consumption: result.consumption, blocker: result.blocker, runnerOutput: result.runnerOutput, _files: files, _decision: decision, _result: result };
  } catch (_) { return { status: "INVALID", requestCommitment: commitment, _files: files }; }
}
function publicStatus(entry) { return Object.fromEntries(Object.entries(entry).filter(([key]) => !key.startsWith("_"))); }
function durablePublish(file, bytes, ctx, indeterminateCode) {
  try { const receipt = ctx.durableWrite(file, bytes, { io: ctx.io, requireDurable: true }); if (!receipt || receipt.committed !== true) fail(indeterminateCode); return receipt; }
  catch (error) { if (error instanceof QueueError) throw error; if (error?.code === "BATCH_ALREADY_EXISTS") throw error; fail(indeterminateCode); }
}
function enqueueImpl(options, ctx) {
  if (!exactKeys(options, ["manifestPath", "expectedManifestBytesSha256"])) fail("ENQUEUE_ARGUMENTS_INVALID");
  const reviewed = validateReviewedManifest(options.manifestPath, options.expectedManifestBytesSha256, ctx);
  const request = validateRequest({ schema: REQUEST_SCHEMA, manifestBytesSha256: options.expectedManifestBytesSha256, manifestCommitment: reviewed.commitment });
  const commitment = requestCommitment(request), files = pathsFor(ctx.root, commitment), requestBytes = canonicalBytes(request);
  qualifyRoot(ctx, true);
  const existing = loadEntry(commitment, ctx);
  if (existing.status !== "ABSENT") {
    if (["QUEUED", "CANCELLED", "CLAIMED_UNRESOLVED", "COMPLETED", "FAILED", "INCOMPLETE"].includes(existing.status) && existing._manifestBytes?.equals(reviewed.bytes) !== false) return { status: "ALREADY_EXISTS", requestCommitment: commitment, manifestBytesSha256: request.manifestBytesSha256, manifestCommitment: request.manifestCommitment, authorizationEvaluated: false };
    return { status: "INCOMPLETE_ENQUEUE", requestCommitment: commitment, authorizationEvaluated: false };
  }
  try { durablePublish(files.manifest, reviewed.bytes, ctx, "MANIFEST_PUBLICATION_INDETERMINATE"); }
  catch (_) { return { status: "INCOMPLETE_ENQUEUE", requestCommitment: commitment, authorizationEvaluated: false }; }
  try { durablePublish(files.request, requestBytes, ctx, "REQUEST_PUBLICATION_INDETERMINATE"); }
  catch (_) { return { status: "INCOMPLETE_ENQUEUE", requestCommitment: commitment, authorizationEvaluated: false }; }
  return { status: "QUEUED", requestCommitment: commitment, manifestBytesSha256: request.manifestBytesSha256, manifestCommitment: request.manifestCommitment, authorizationEvaluated: false };
}
function cancelImpl(commitment, ctx) {
  const current = loadEntry(validateHash(commitment), ctx);
  if (current.status !== "QUEUED") return publicStatus(current);
  const decision = { schema: DECISION_SCHEMA, requestCommitment: commitment, decision: "CANCELLED" };
  try { durablePublish(current._files.decision, decisionBytes(decision), ctx, "DECISION_PUBLICATION_INDETERMINATE"); }
  catch (error) {
    if (error?.code === "BATCH_ALREADY_EXISTS") return publicStatus(loadEntry(commitment, ctx));
    throw error;
  }
  return { status: "CANCELLED", requestCommitment: commitment, decisionCommitment: decisionCommitment(decision) };
}
function consumptionConfirmed(state, expectedBatchCommitment, manifestCommitmentValue, runId) {
  return state?.state === batchTool.STATES.CONSUMED && state.batchCommitment === expectedBatchCommitment && state.terminal?.manifestCommitment === manifestCommitmentValue && state.terminal?.runId === runId;
}
async function dispatchImpl(options, ctx) {
  if (!exactKeys(options, ["requestCommitment", "expectedBatchCommitment"])) fail("DISPATCH_ARGUMENTS_INVALID");
  const commitment = validateHash(options.requestCommitment), expectedBatchCommitment = validateHash(options.expectedBatchCommitment, "EXPECTED_BATCH_COMMITMENT_INVALID");
  const current = loadEntry(commitment, ctx);
  if (current.status !== "QUEUED") return publicStatus(current);
  let authorization;
  try { authorization = ctx.batchState(); } catch (_) { return { ...publicStatus(current), dispatched: false, blocker: "AUTHORIZATION_INVALID" }; }
  if (authorization?.state !== batchTool.STATES.VALID) return { ...publicStatus(current), dispatched: false, blocker: "AUTHORIZATION_NOT_VALID" };
  if (authorization.batchCommitment !== expectedBatchCommitment) return { ...publicStatus(current), dispatched: false, blocker: "BATCH_SELECTION_MISMATCH" };
  let scope;
  try { scope = runner.scopeCheck(authorization, current._manifest); } catch (_) { scope = { ok: false }; }
  if (!scope.ok || scope.batchCommitment !== expectedBatchCommitment) return { ...publicStatus(current), dispatched: false, blocker: "SCOPE_MISMATCH" };
  const runId = `p1b-${current._files.hex}`;
  const decision = { schema: DECISION_SCHEMA, requestCommitment: commitment, decision: "CLAIMED", expectedBatchCommitment, runId };
  const decisionHash = decisionCommitment(decision);
  try { durablePublish(current._files.decision, decisionBytes(decision), ctx, "DECISION_PUBLICATION_INDETERMINATE"); }
  catch (error) {
    if (error?.code === "BATCH_ALREADY_EXISTS") return publicStatus(loadEntry(commitment, ctx));
    throw error;
  }
  let returned = null, thrown = false;
  try {
    returned = await ctx.runForkValidation({ manifestPath: current._files.manifest, runId, expectedManifestBytesSha256: current._request.manifestBytesSha256, expectedManifestCommitment: current._request.manifestCommitment, expectedBatchCommitment });
  } catch (error) { thrown = true; returned = error?.output ? { output: error.output } : null; }
  const output = returned?.output, outputValid = validRunnerOutput(output, expectedBatchCommitment, current._request.manifestCommitment);
  let finalAuthorization;
  try { finalAuthorization = ctx.batchState(); } catch (_) { finalAuthorization = null; }
  const confirmed = consumptionConfirmed(finalAuthorization, expectedBatchCommitment, current._request.manifestCommitment, runId);
  let state, blocker;
  if (!confirmed) { state = "INCOMPLETE"; blocker = "CONSUMPTION_UNCONFIRMED"; }
  else if (!outputValid) { state = "INCOMPLETE"; blocker = "RUNNER_OUTPUT_INVALID"; }
  else if (thrown) { state = "FAILED"; blocker = "RUNNER_FAILED"; }
  else if (!completedRunnerOutput(output, expectedBatchCommitment, current._request.manifestCommitment)) { state = "INCOMPLETE"; blocker = "RUNNER_INCOMPLETE"; }
  else { state = "COMPLETED"; blocker = null; }
  const result = { schema: RESULT_SCHEMA, requestCommitment: commitment, decisionCommitment: decisionHash, state, consumption: confirmed ? "CONFIRMED" : "UNKNOWN", blocker, runnerOutput: outputValid ? output : null };
  validateResult(result, commitment, decisionHash, expectedBatchCommitment, current._request.manifestCommitment);
  const bytes = resultBytes(result);
  if (bytes.length > batchTool.CAPS.batchBytes) { result.state = "INCOMPLETE"; result.blocker = "RUNNER_OUTPUT_INVALID"; result.runnerOutput = null; }
  try { durablePublish(current._files.result, resultBytes(result), ctx, "RESULT_PUBLICATION_INDETERMINATE"); }
  catch (_) { fail("RESULT_PUBLICATION_INDETERMINATE"); }
  return publicStatus(loadEntry(commitment, ctx));
}

const production = Object.freeze({ root: QUEUE_ROOT, io: fs, testOnly: false, durableWrite: batchTool.durableExclusiveWrite, batchState: () => batchTool.batchState(), runForkValidation: (options) => runner.runForkValidation(options) });
function enqueueReviewedManifest(options) { return enqueueImpl(options, production); }
function requestStatus(commitment) { return publicStatus(loadEntry(commitment, production)); }
function cancelRequest(commitment) { return cancelImpl(commitment, production); }
function dispatchOnce(options) { return dispatchImpl(options, production); }
function parseCli(args) {
  if (args[0] === "enqueue" && args.length === 5) {
    const pairs = new Map(); for (let i = 1; i < args.length; i += 2) { if (!["--manifest", "--expected-manifest-sha256"].includes(args[i]) || pairs.has(args[i]) || !args[i + 1]) fail("USAGE_ERROR"); pairs.set(args[i], args[i + 1]); }
    if (pairs.size !== 2) fail("USAGE_ERROR"); return { command: "enqueue", options: { manifestPath: pairs.get("--manifest"), expectedManifestBytesSha256: pairs.get("--expected-manifest-sha256") } };
  }
  if (["status", "cancel"].includes(args[0]) && args.length === 3 && args[1] === "--request") return { command: args[0], requestCommitment: args[2] };
  fail("USAGE_ERROR");
}
function runCli(argv = process.argv) {
  try {
    const parsed = parseCli(argv.slice(2));
    const result = parsed.command === "enqueue" ? enqueueReviewedManifest(parsed.options) : parsed.command === "status" ? requestStatus(parsed.requestCommitment) : cancelRequest(parsed.requestCommitment);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  } catch (error) {
    const blocker = error instanceof QueueError ? error.code : "INTERNAL_FAILURE_REDACTED";
    process.stdout.write(`${JSON.stringify({ status: "FAIL_CLOSED", blocker })}\n`); process.exitCode = 1; return null;
  }
}
if (require.main === module) runCli();

function createTestHarness(options) {
  if (!exactKeys(options, ["root", "batchState", "runForkValidation", "durableWrite"])) fail("TEST_HARNESS_INVALID");
  assertTestRoot(options.root);
  const ctx = Object.freeze({ root: path.resolve(options.root), io: fs, testOnly: true, batchState: options.batchState, runForkValidation: options.runForkValidation, durableWrite: options.durableWrite });
  return Object.freeze({ enqueueReviewedManifest: (value) => enqueueImpl(value, ctx), requestStatus: (value) => publicStatus(loadEntry(value, ctx)), cancelRequest: (value) => cancelImpl(value, ctx), dispatchOnce: (value) => dispatchImpl(value, ctx), root: ctx.root });
}
module.exports = Object.freeze({ validateRequest, requestCommitment, enqueueReviewedManifest, requestStatus, cancelRequest, dispatchOnce, runCli, QueueError, constants: Object.freeze({ ROOT, QUEUE_ROOT, REQUEST_SCHEMA, DECISION_SCHEMA, RESULT_SCHEMA, REQUEST_DOMAIN, DECISION_DOMAIN, SMALL_CAP }), _test: Object.freeze({ createTestHarness, pathsFor, parseCli }) });
