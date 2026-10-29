#!/usr/bin/env node
"use strict";

// live-execution-dispatch-runner.js
//
// Reviewed, repeatable one-shot replacement for the ad-hoc temporary driver that
// wired the production broadcast dependencies by hand. It supplies the signer
// loader and send-endpoint resolver that the dispatcher's injected-deps contract
// requires, then performs exactly ONE `dispatchOnce` (or a read-only `--check`).
//
// CLI:
//   run --expected-batch-commitment 0x<64hex> --confirm <batchId>
//       --key-file <absolute-path> [--check]
//
// There is no watcher, no loop, no retry, no daemon, and no default command.
// Exactly one dispatch happens per invocation, and only when `--check` is absent.
//
// ENDPOINT HYGIENE (STRICT):
//   * The endpoint URL NEVER comes from argv and is never printed, logged, or
//     persisted.
//   * Only two sources are accepted: (a) the authorized inventory default, or
//     (b) the process environment variable LIVE_EXECUTION_ENDPOINT for an
//     explicitly approved exception.
//   * The environment is read directly and the value is passed into the send
//     endpoint resolver's `providerUrls`; it is never echoed.
//   * A non-TLS endpoint, or a missing endpoint when neither source yields one,
//     is refused with a sanitized code.
//
// KEY HYGIENE: the key file path is only ever handed to the signer loader. Key
// bytes returned by the loader are captured and zeroized in a `finally` on every
// path. Key material, key-file contents, and the endpoint URL never appear in
// output.
//
// Dependencies are injectable for offline tests via `options.deps` (the real
// modules `live-execution-broadcast-dispatch.js`,
// `live-execution-broadcast-adapter.js`, `live-execution-send-endpoint.js`,
// `live-execution-evm-key.js`), `options.env`, and `options.readEndpoint`.
// Additional test seams (`options.transport`, `options.loadSigner`,
// `options.resolveSendEndpoint`, `options.batchOptions`, `options.publishResult`,
// `options.now`) default to the real wiring and are also honored when nested
// under `options.deps`.

const path = require("node:path");

const SCHEMA = "live-execution-dispatch-runner/v1";
const HASH = /^0x[0-9a-f]{64}$/u;
const SAFE_STATUS = /^[A-Z][A-Z0-9_]{0,31}$/u;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_BLOCKER = /^[A-Z][A-Z0-9_]{0,63}$/u;
const SAFE_COUNT = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;
const SEND_STATUSES = Object.freeze(new Set(["SUCCESS", "REVERTED", "UNKNOWN"]));
const ENV_ENDPOINT = "LIVE_EXECUTION_ENDPOINT";
const SIGNER_REF = "inline-key-file"; // symbolic only; the real path stays inside the loader
const ENDPOINT_REF = "authorized-send-endpoint";
const MAX_KEY_FILE_LENGTH = 4096;
const MAX_ENDPOINT_LENGTH = 2048;

const BLOCKER = Object.freeze({
  ARGUMENTS_INVALID: "RUNNER_ARGUMENTS_INVALID",
  KEY_FILE_INVALID: "RUNNER_KEY_FILE_INVALID",
  ENDPOINT_INSECURE: "RUNNER_ENDPOINT_INSECURE",
  ENDPOINT_UNAVAILABLE: "RUNNER_ENDPOINT_UNAVAILABLE",
  DEPENDENCY_INVALID: "RUNNER_DEPENDENCY_INVALID",
  DISPATCH_FAILED: "RUNNER_DISPATCH_FAILED",
  INTERNAL: "INTERNAL_FAILURE_REDACTED",
});
const STATUS = Object.freeze({
  READY: "READY",
  BROADCASTED: "BROADCASTED",
  INCOMPLETE: "INCOMPLETE",
  FAIL_CLOSED: "FAIL_CLOSED",
  REFUSED: "REFUSED",
});

class RunnerError extends Error {
  constructor(code) { super(code); this.name = "RunnerError"; this.code = code; }
}
const fail = (code) => { throw new RunnerError(code); };
const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const funcOr = (candidate, fallback) => (typeof candidate === "function" ? candidate : fallback);
const plainOr = (candidate, fallback) => (isPlainObject(candidate) ? candidate : fallback);

function zeroize(buffer) {
  if (Buffer.isBuffer(buffer) || buffer instanceof Uint8Array) {
    try { buffer.fill(0); } catch (_) { /* best effort */ }
  }
}
function zeroizeLoaded(loaded) {
  if (!loaded || typeof loaded !== "object") return;
  zeroize(loaded.keyBytes);
  zeroize(loaded.privateKey);
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------
function parseCli(args) {
  if (!Array.isArray(args) || args.length === 0) fail(BLOCKER.ARGUMENTS_INVALID);
  if (args[0] !== "run") fail(BLOCKER.ARGUMENTS_INVALID);
  const allowed = new Set(["--expected-batch-commitment", "--confirm", "--key-file", "--check"]);
  const booleanFlags = new Set(["--check"]);
  const flags = new Map();
  const rest = args.slice(1);
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!allowed.has(token) || flags.has(token)) fail(BLOCKER.ARGUMENTS_INVALID);
    if (booleanFlags.has(token)) { flags.set(token, true); continue; }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) fail(BLOCKER.ARGUMENTS_INVALID);
    flags.set(token, value);
    index += 1;
  }
  if (!flags.has("--expected-batch-commitment") || !flags.has("--confirm") || !flags.has("--key-file")) {
    fail(BLOCKER.ARGUMENTS_INVALID);
  }
  const expectedBatchCommitment = flags.get("--expected-batch-commitment");
  if (!HASH.test(expectedBatchCommitment)) fail(BLOCKER.ARGUMENTS_INVALID);
  const confirmBatchId = flags.get("--confirm");
  if (typeof confirmBatchId !== "string" || confirmBatchId.length === 0 || confirmBatchId.length > 64) fail(BLOCKER.ARGUMENTS_INVALID);
  const keyFile = flags.get("--key-file");
  if (typeof keyFile !== "string" || keyFile.length === 0 || keyFile.length > MAX_KEY_FILE_LENGTH || CONTROL_CHARS.test(keyFile)) {
    fail(BLOCKER.KEY_FILE_INVALID);
  }
  if (!path.isAbsolute(keyFile)) fail(BLOCKER.KEY_FILE_INVALID);
  return {
    command: "run",
    options: { expectedBatchCommitment, confirmBatchId, keyFile, check: flags.get("--check") === true },
  };
}

// ---------------------------------------------------------------------------
// Sanitized result projection
// ---------------------------------------------------------------------------
function safeToken(value) {
  return typeof value === "string" && SAFE_TOKEN.test(value) ? value : null;
}
function safeHash(value) {
  return typeof value === "string" && HASH.test(value) ? value : null;
}
function safeBlocker(value) {
  return typeof value === "string" && SAFE_BLOCKER.test(value) ? value : null;
}
function sanitizeCounts(counts) {
  if (!isPlainObject(counts)) return null;
  const safe = {};
  for (const key of ["actions", "attempts", "sends", "confirmations"]) {
    safe[key] = SAFE_COUNT(counts[key]) ? counts[key] : null;
  }
  return safe;
}
// Mirrors the dispatcher's publish rule exactly: an entry is publishable only
// when its index is a non-negative integer, its txHash is 0x + 64 lowercase hex,
// and its status is one of SUCCESS | REVERTED | UNKNOWN. Anything else is
// omitted so a malformed value can never reach output.
function sanitizeSends(sends) {
  if (!Array.isArray(sends)) return [];
  const safe = [];
  for (const entry of sends) {
    if (!isPlainObject(entry)) continue;
    const { index, txHash, status } = entry;
    if (!Number.isSafeInteger(index) || index < 0) continue;
    if (typeof txHash !== "string" || !HASH.test(txHash)) continue;
    if (typeof status !== "string" || !SEND_STATUSES.has(status)) continue;
    safe.push({ index, txHash, status });
  }
  return safe;
}
function buildResult(check, envelope) {
  const value = isPlainObject(envelope) ? envelope : {};
  return {
    schema: SCHEMA,
    command: "run",
    check: check === true,
    status: typeof value.status === "string" && SAFE_STATUS.test(value.status) ? value.status : STATUS.FAIL_CLOSED,
    blocker: safeBlocker(value.blocker),
    runId: safeToken(value.runId),
    batchCommitment: safeHash(value.batchCommitment),
    scopeCommitment: safeHash(value.scopeCommitment),
    confirmBatchId: safeToken(value.confirmBatchId),
    batchId: safeToken(value.batchId),
    mode: safeBlocker(value.mode),
    counts: sanitizeCounts(value.counts),
    sends: sanitizeSends(value.sends),
  };
}
function refusal(check, code) {
  return buildResult(check, { status: STATUS.FAIL_CLOSED, blocker: code });
}

// ---------------------------------------------------------------------------
// Endpoint selection (hygiene)
// ---------------------------------------------------------------------------
function isHttpsEndpoint(value, adapterModule) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ENDPOINT_LENGTH) return false;
  if (typeof adapterModule.validateSendEndpointUrl !== "function") return false;
  if (adapterModule.validateSendEndpointUrl(value) !== value) return false;
  try { return new URL(value).protocol === "https:"; } catch (_) { return false; }
}
function selectEndpointSource({ env, readEndpoint, modules }) {
  const raw = env && typeof env[ENV_ENDPOINT] === "string" ? env[ENV_ENDPOINT].trim() : "";
  if (raw.length > 0) {
    if (!isHttpsEndpoint(raw, modules.adapter)) return { ok: false, code: BLOCKER.ENDPOINT_INSECURE };
    return { ok: true, providerUrls: [raw], source: "ENV" };
  }
  let inventory;
  try { inventory = readEndpoint(); } catch (_) { return { ok: false, code: BLOCKER.ENDPOINT_UNAVAILABLE }; }
  let urls;
  if (Array.isArray(inventory)) urls = inventory;
  else if (typeof inventory === "string" && modules.sendEndpoint && typeof modules.sendEndpoint.parseInventoryUrls === "function") {
    urls = modules.sendEndpoint.parseInventoryUrls(inventory);
  } else urls = [];
  if (!Array.isArray(urls) || urls.length === 0) return { ok: false, code: BLOCKER.ENDPOINT_UNAVAILABLE };
  const secure = urls.filter((value) => isHttpsEndpoint(value, modules.adapter));
  if (secure.length === 0) return { ok: false, code: BLOCKER.ENDPOINT_INSECURE };
  return { ok: true, providerUrls: secure, source: "INVENTORY" };
}

// ---------------------------------------------------------------------------
// Real wiring
// ---------------------------------------------------------------------------
function resolveModules(injected) {
  const source = isPlainObject(injected) ? injected : {};
  return {
    dispatch: source.dispatch || require("./live-execution-broadcast-dispatch.js"),
    adapter: source.adapter || require("./live-execution-broadcast-adapter.js"),
    sendEndpoint: source.sendEndpoint || require("./live-execution-send-endpoint.js"),
    evmKey: source.evmKey || require("./live-execution-evm-key.js"),
  };
}
function makeResolveSendEndpoint({ modules, transport, providerUrls }) {
  const inner = modules.sendEndpoint.createSendEndpointResolver({ transport, providerUrls });
  return async (chainId, endpointRef) => {
    const url = await inner(chainId, endpointRef);
    // Defense in depth: the runner only ever hands the adapter a TLS endpoint.
    if (!isHttpsEndpoint(url, modules.adapter)) return null;
    return url;
  };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------
async function execute(argv = process.argv, options = {}) {
  const opts = isPlainObject(options) ? options : {};
  const injection = isPlainObject(opts.deps) ? opts.deps : {};
  const modules = resolveModules(injection);
  const env = isPlainObject(opts.env) ? opts.env : process.env;

  let parsed;
  try { parsed = parseCli(argv); }
  catch (error) {
    const code = error instanceof RunnerError ? error.code : BLOCKER.ARGUMENTS_INVALID;
    return refusal(false, code);
  }
  const check = parsed.options.check === true;
  const captured = [];
  try {
    const defaultRead = modules.sendEndpoint && typeof modules.sendEndpoint.readAuthorizedInventory === "function"
      ? modules.sendEndpoint.readAuthorizedInventory
      : () => [];
    const readEndpoint = funcOr(opts.readEndpoint, funcOr(injection.readEndpoint, defaultRead));
    const endpoint = selectEndpointSource({ env, readEndpoint, modules });
    if (!endpoint.ok) return refusal(check, endpoint.code);

    const transport = funcOr(injection.transport, funcOr(opts.transport, modules.adapter.defaultTransport));
    const baseResolver = funcOr(injection.resolveSendEndpoint, opts.resolveSendEndpoint);
    const resolveSendEndpoint = baseResolver
      ? baseResolver
      : makeResolveSendEndpoint({ modules, transport, providerUrls: endpoint.providerUrls });

    const baseLoader = funcOr(injection.loadSigner, funcOr(opts.loadSigner, (signerRef) => {
      void signerRef;
      return modules.evmKey.load({ keyPath: parsed.options.keyFile });
    }));
    const loadSigner = async (signerRef) => {
      const loaded = await baseLoader(signerRef);
      if (loaded && typeof loaded === "object") captured.push(loaded);
      return loaded;
    };

    const dispatchDeps = { transport, loadSigner, resolveSendEndpoint };
    const batchOptions = plainOr(injection.batchOptions, plainOr(opts.batchOptions, null));
    if (batchOptions) dispatchDeps.batchOptions = { ...batchOptions };
    const publishResult = funcOr(injection.publishResult, opts.publishResult);
    if (publishResult) dispatchDeps.publishResult = publishResult;
    const now = funcOr(injection.now, opts.now);
    if (now) dispatchDeps.now = now;

    const request = {
      expectedBatchCommitment: parsed.options.expectedBatchCommitment,
      confirmBatchId: parsed.options.confirmBatchId,
      signerRef: SIGNER_REF,
      endpointRef: ENDPOINT_REF,
      deps: dispatchDeps,
    };

    const dispatchFn = check
      ? modules.dispatch && modules.dispatch.preflightOnce
      : modules.dispatch && modules.dispatch.dispatchOnce;
    if (typeof dispatchFn !== "function") return refusal(check, BLOCKER.DEPENDENCY_INVALID);

    let envelope;
    try { envelope = await dispatchFn(request); }
    catch (_) { return refusal(check, BLOCKER.DISPATCH_FAILED); }
    return buildResult(check, envelope);
  } catch (_) {
    return refusal(check, BLOCKER.INTERNAL);
  } finally {
    for (const loaded of captured) zeroizeLoaded(loaded);
  }
}

async function run(argv = process.argv, options = {}) {
  const opts = isPlainObject(options) ? options : {};
  // `run` is the CLI entry: strip the node executable + script path exactly once.
  // `execute` itself takes pre-sliced arguments (as the tests pass them).
  const result = await execute((Array.isArray(argv) ? argv : process.argv).slice(2), opts);
  const line = `${JSON.stringify(result)}\n`;
  if (typeof opts.write === "function") opts.write(line);
  else process.stdout.write(line);
  if (result.status !== STATUS.READY && result.status !== STATUS.BROADCASTED) process.exitCode = 1;
  return result;
}

if (require.main === module) run(process.argv);

module.exports = Object.freeze({
  SCHEMA,
  STATUS,
  BLOCKER,
  parseCli,
  execute,
  run,
  runCli: run,
  buildResult,
  sanitizeSends,
  RunnerError,
  constants: Object.freeze({ ENV_ENDPOINT, SIGNER_REF, ENDPOINT_REF, MAX_KEY_FILE_LENGTH, MAX_ENDPOINT_LENGTH, SEND_STATUSES }),
});
