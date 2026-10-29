#!/usr/bin/env node
"use strict";

// Deliberately minimal one-shot broadcast dispatcher.
//
// There is no watch mode, no loop, no daemon, no FIFO, no retry, no
// auto-dispatch, and no default command. `dispatchOnce` performs exactly one
// attempt or refuses. The canonical at-most-once authority
// (live-execution-batch.js) is consumed before the sibling broadcast adapter is
// ever invoked, so a terminal batch can never be re-broadcast.
//
// The broadcast wiring is validated BEFORE `consumeBatch` so a batch is never
// consumed when the send path cannot execute. R1: the canonical batch module is
// the REAL `./live-execution-batch.js`, required unconditionally; callers may
// pass only DATA via `deps.batchOptions` (batchPath/registryPath/registrySha256)
// and `deps.batch` is rejected as adversarial. R2: the pre-consume preflight
// additionally resolves the send endpoint once and proves an executable signer
// path exists. The caller's `deps` are forwarded to the adapter, and the
// adapter's own returned status is mapped onto the dispatcher status vocabulary
// (COMPLETED -> BROADCASTED, INCOMPLETE -> INCOMPLETE, FAIL_CLOSED ->
// FAIL_CLOSED, thrown -> INCOMPLETE); no non-throwing adapter result is ever
// reported as a successful broadcast.

const fs = require("node:fs");
const path = require("node:path");

const DISPATCH_SCHEMA = "live-execution-broadcast-dispatch/v1";
const SCHEMA_V3 = "live-execution-batch/v3";
const EXECUTABLE_MODES = Object.freeze(["TESTNET", "PRODUCTION"]);
const HASH = /^0x[0-9a-f]{64}$/u;
const OPTION_KEYS = Object.freeze(new Set([
  "expectedBatchCommitment", "signerRef", "endpointRef", "confirmBatchId", "runId", "deps",
]));
// R1: the only caller-controlled batch inputs are DATA path bindings. Behavior
// injection (`deps.batch`) is rejected; `deps.batchOptions` is allowlisted.
const BATCH_OPTION_KEYS = Object.freeze(new Set(["batchPath", "registryPath", "registrySha256"]));
const BATCH_MODULE_PATH = "./live-execution-batch.js";
const STATUS = Object.freeze({
  REFUSED: "REFUSED",
  BROADCASTED: "BROADCASTED",
  FAIL_CLOSED: "FAIL_CLOSED",
  INCOMPLETE: "INCOMPLETE",
  READY: "READY",
});
const ADAPTER_STATUS = Object.freeze({
  COMPLETED: "COMPLETED",
  INCOMPLETE: "INCOMPLETE",
  FAIL_CLOSED: "FAIL_CLOSED",
});
// TASK 1: the only send-status values that may cross the publish boundary. The
// adapter's internal HASH_MISMATCH signal is deliberately not publishable; such
// an entry is omitted by `sanitizeSends` rather than leaked.
const SEND_STATUSES = Object.freeze(new Set(["SUCCESS", "REVERTED", "UNKNOWN"]));
const STATES = Object.freeze({ VALID: "VALID", CONSUMED: "CONSUMED" });

const SENSITIVE = /(private.?key|secret|mnemonic|seed.?phrase|passphrase|password|credential|bearer|authorization|api.?key|access.?token|refresh.?token|keystore|keypair)/iu;
const URL_LIKE = /(?:https?|wss?):\/\//iu;
const WIN_ABS = /[A-Za-z]:\\/u;
const POSIX_ABS = /(?:^|[\s"'(])\/(?:home|root|mnt|users|var|etc|tmp|opt|coordination)\//iu;
const SAFE_TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/u;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_STATE = /^[A-Z][A-Z0-9_]{0,31}$/u;
const SAFE_BLOCKER = /^[A-Z][A-Z0-9_]{0,63}$/u;

class DispatchError extends Error {
  constructor(code) { super(code); this.name = "DispatchError"; this.code = code; }
}
const fail = (code) => { throw new DispatchError(code); };
const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function isSafeRef(value) {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 128
    && SAFE_REF.test(value)
    && !URL_LIKE.test(value)
    && !SENSITIVE.test(value);
}
function safeState(value) {
  return typeof value === "string" && SAFE_STATE.test(value) ? value : "UNKNOWN";
}
// F1(e): mirror the adapter's `parseQuantity` for the read-only pre-consume
// eth_chainId probe. Returns a BigInt or null; never throws.
function parseChainQuantity(value) {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/iu.test(value)) return null;
  try {
    const parsed = BigInt(value);
    return parsed >= 0n ? parsed : null;
  } catch (_) {
    return null;
  }
}
function sanitizeToken(value) {
  if (typeof value !== "string" || !SAFE_TOKEN.test(value) || URL_LIKE.test(value) || SENSITIVE.test(value)) return "UNRECOGNIZED";
  return value;
}
function sanitizeCounts(counts) {
  if (!isPlainObject(counts)) return null;
  const safe = {};
  for (const key of ["actions", "attempts", "sends", "confirmations"]) {
    const value = counts[key];
    safe[key] = (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) ? value : null;
  }
  return safe;
}
// TASK 1: publishable `sends[]` entries. Every field must validate exactly:
//   index  - non-negative safe integer
//   txHash - 0x + 64 lowercase hex
//   status - SUCCESS | REVERTED | UNKNOWN
// Anything that does not validate is omitted, never passed through. The array is
// always an array so the published envelope shape is stable.
function sanitizeSends(sends) {
  if (!Array.isArray(sends)) return [];
  const safe = [];
  for (const entry of sends) {
    if (!isPlainObject(entry)) continue;
    const index = entry.index;
    const txHash = entry.txHash;
    const status = entry.status;
    if (!Number.isSafeInteger(index) || index < 0) continue;
    if (typeof txHash !== "string" || !HASH.test(txHash)) continue;
    if (typeof status !== "string" || !SEND_STATUSES.has(status)) continue;
    safe.push({ index, txHash, status });
  }
  return safe;
}
function sanitizeEnvelope(envelope) {
  if (!isPlainObject(envelope)) return { status: "UNRECOGNIZED", counts: null, sends: [] };
  return { status: sanitizeToken(envelope.status), counts: sanitizeCounts(envelope.counts), sends: sanitizeSends(envelope.sends) };
}
function assertSanitized(value) {
  if (typeof value === "string") {
    if (URL_LIKE.test(value) || WIN_ABS.test(value) || POSIX_ABS.test(value) || SENSITIVE.test(value)) fail("DISPATCH_RESULT_UNSANITIZED");
    return;
  }
  if (Array.isArray(value)) { for (const item of value) assertSanitized(item); return; }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (SENSITIVE.test(key)) fail("DISPATCH_RESULT_UNSANITIZED");
      assertSanitized(child);
    }
  }
}
function envelope(status, blocker, fields = {}) {
  const safeBlocker = typeof blocker === "string" && SAFE_BLOCKER.test(blocker) ? blocker : null;
  const result = { schema: DISPATCH_SCHEMA, status, blocker: safeBlocker };
  const order = ["runId", "batchCommitment", "scopeCommitment", "confirmBatchId", "batchId", "mode", "adapterStatus", "counts", "sends", "observedState"];
  for (const key of order) {
    const value = fields[key];
    if (value === undefined || value === null) continue;
    result[key] = value;
  }
  return result;
}
function defaultPublishResult(result, directoryOverride) {
  // FIX 4: kept outside the tracked source tree (`tools/`) and outside
  // `coordination/`, so an accidental dispatch never mutates the canonical
  // authorization directory. Write-once. R3: the file is keyed on the unique
  // `batchCommitment`, not the caller-supplied `runId`, so a duplicate runId
  // across two different batches can never make the second (already completed)
  // broadcast publish collide into a false INCOMPLETE. An EEXIST for the same
  // batchCommitment is idempotent success, never failure.
  const directory = directoryOverride || path.join(__dirname, "..", "reports", "live-execution-broadcast");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const raw = typeof result.batchCommitment === "string" && HASH.test(result.batchCommitment)
    ? result.batchCommitment.slice(2)
    : (typeof result.runId === "string" ? result.runId : String(result.batchCommitment || ""));
  const token = raw.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 128) || "unknown";
  const file = path.join(directory, `${token}.result.json`);
  const contents = `${JSON.stringify(result, null, 2)}\n`;
  try {
    fs.writeFileSync(file, contents, { flag: "wx", mode: 0o600 });
    return { written: true, writeOnce: true };
  } catch (error) {
    if (error && error.code === "EEXIST") {
      // A prior completed broadcast for the same batchCommitment already
      // published. Never turn a completed broadcast into a reported failure.
      let identical = false;
      try { identical = fs.readFileSync(file, "utf8") === contents; } catch (_) { identical = false; }
      return { written: true, writeOnce: true, idempotent: true, identical };
    }
    throw error;
  }
}
function resolveRunBroadcast() {
  const adapter = require("./live-execution-broadcast-adapter.js");
  if (!adapter || typeof adapter.runBroadcast !== "function") fail("DISPATCH_BROADCAST_ADAPTER_INVALID");
  return adapter.runBroadcast;
}
// R1: the canonical module is fixed; only its DATA path may be relocated.
function resolveBatchModule() {
  try { return require(BATCH_MODULE_PATH); } catch (_) { return null; }
}
function resolveBatchOptions(deps) {
  if (Object.hasOwn(deps, "batch")) return { ok: false, code: "DISPATCH_BATCH_MODULE_INJECTED" };
  const raw = deps.batchOptions;
  if (raw === undefined) return { ok: true, options: {} };
  if (!isPlainObject(raw)) return { ok: false, code: "DISPATCH_BATCH_OPTIONS_INVALID" };
  for (const key of Object.keys(raw)) {
    if (!BATCH_OPTION_KEYS.has(key)) return { ok: false, code: "DISPATCH_BATCH_OPTIONS_INVALID" };
  }
  if (raw.batchPath !== undefined && (typeof raw.batchPath !== "string" || raw.batchPath.length === 0)) return { ok: false, code: "DISPATCH_BATCH_OPTIONS_INVALID" };
  if (raw.registryPath !== undefined && (typeof raw.registryPath !== "string" || raw.registryPath.length === 0)) return { ok: false, code: "DISPATCH_BATCH_OPTIONS_INVALID" };
  if (raw.registrySha256 !== undefined && !HASH.test(raw.registrySha256)) return { ok: false, code: "DISPATCH_BATCH_OPTIONS_INVALID" };
  return { ok: true, options: { ...raw } };
}
function resolveBroadcastWiring(deps) {
  // FIX 2(b): resolve the adapter and prove a send-capable path exists BEFORE any
  // authority is consumed. An injected `deps.runBroadcast` is self-contained; the
  // default adapter additionally needs a transport and an explicit send-endpoint
  // resolver (the adapter's built-in resolver always fails closed).
  if (deps.runBroadcast !== undefined && deps.runBroadcast !== null && typeof deps.runBroadcast !== "function") {
    return { ok: false, code: "DISPATCH_BROADCAST_WIRING_UNAVAILABLE" };
  }
  const injected = typeof deps.runBroadcast === "function";
  let runBroadcast;
  try {
    runBroadcast = injected ? deps.runBroadcast : resolveRunBroadcast();
  } catch (_) {
    return { ok: false, code: "DISPATCH_BROADCAST_ADAPTER_UNAVAILABLE" };
  }
  if (typeof runBroadcast !== "function") return { ok: false, code: "DISPATCH_BROADCAST_WIRING_UNAVAILABLE" };
  if (!injected && (typeof deps.transport !== "function" || typeof deps.resolveSendEndpoint !== "function")) {
    return { ok: false, code: "DISPATCH_BROADCAST_WIRING_UNAVAILABLE" };
  }
  return { ok: true, runBroadcast, injected };
}
// R2/F1: read-only proof, before consumeBatch, that the DEFAULT adapter path can
// actually execute. The adapter's pure request validator runs first, then the
// send endpoint is resolved + policy-checked, the signer is loaded and its
// address proven equal to the batch accountRef, and one `eth_chainId` read is
// proven equal to batch.chainId. Because `isSafeRef` rejects path separators an
// absolute signerRef can never pass dispatcher option validation, so PRODUCTION
// MUST INJECT `deps.loadSigner`; the default Linux signer loader is accepted only
// as defense-in-depth for an absolute ref that never survives caller validation.
// Without this preflight a valid batch would be consumed (and its terminal marker
// burned) before the adapter failed closed.
async function preflightDefaultBroadcastPath(deps, batchObj, request) {
  let adapterModule;
  try { adapterModule = require("./live-execution-broadcast-adapter.js"); }
  catch (_) { return { ok: false, code: "DISPATCH_BROADCAST_ADAPTER_UNAVAILABLE" }; }
  const validateEndpoint = adapterModule.validateSendEndpointUrl;
  const validateRequest = adapterModule.validateBroadcastRequest;
  if (typeof validateEndpoint !== "function" || typeof validateRequest !== "function") {
    return { ok: false, code: "DISPATCH_BROADCAST_ADAPTER_UNAVAILABLE" };
  }

  // F1: the adapter's own PURE request validator runs first, so every condition
  // the adapter would reject before signing (ref grammar, `..` traversal,
  // commitment/scope binding, option/type checks) is refused here, before the
  // one-shot authority is consumed, with zero sends.
  const requestBlocker = validateRequest(request);
  if (requestBlocker) return { ok: false, code: requestBlocker };

  const signerRef = request.signerRef;
  const endpointRef = request.endpointRef;
  if (typeof signerRef !== "string" || typeof endpointRef !== "string") {
    return { ok: false, code: "DISPATCH_BROADCAST_OPTIONS_INVALID" };
  }

  let resolved;
  try { resolved = await deps.resolveSendEndpoint(batchObj.chainId, endpointRef); }
  catch (_) { return { ok: false, code: "DISPATCH_BROADCAST_ENDPOINT_UNAVAILABLE" }; }
  const endpointUrl = validateEndpoint(resolved);
  if (!endpointUrl) return { ok: false, code: "DISPATCH_BROADCAST_ENDPOINT_UNAVAILABLE" };

  // F1(d): read-only signer probe. Load the signer once, before consumption, and
  // prove the derived address is exactly the batch accountRef.
  const loadSigner = typeof deps.loadSigner === "function"
    ? deps.loadSigner
    : (typeof adapterModule.defaultLoadSigner === "function" && process.platform === "linux" && path.isAbsolute(signerRef) ? adapterModule.defaultLoadSigner : null);
  if (typeof loadSigner !== "function") return { ok: false, code: "DISPATCH_BROADCAST_SIGNER_UNAVAILABLE" };
  let loaded;
  try { loaded = await loadSigner(signerRef); }
  catch (_) { return { ok: false, code: "DISPATCH_BROADCAST_SIGNER_UNAVAILABLE" }; }
  const derived = typeof adapterModule.signerAddressOf === "function" ? adapterModule.signerAddressOf(loaded) : null;
  if (typeof derived !== "string") return { ok: false, code: "DISPATCH_BROADCAST_SIGNER_UNAVAILABLE" };
  const expectedAddress = typeof batchObj.accountRef === "string" ? batchObj.accountRef : "";
  if (derived.toLowerCase() !== expectedAddress.toLowerCase()) {
    return { ok: false, code: "DISPATCH_BROADCAST_ACCOUNT_MISMATCH" };
  }

  // F1(e): read-only chain probe. One `eth_chainId` read must equal batch.chainId.
  let chainResult;
  try { chainResult = await deps.transport(endpointUrl, "eth_chainId", []); }
  catch (_) { return { ok: false, code: "DISPATCH_BROADCAST_CHAIN_UNAVAILABLE" }; }
  const observedChain = parseChainQuantity(chainResult);
  if (observedChain === null) return { ok: false, code: "DISPATCH_BROADCAST_CHAIN_UNAVAILABLE" };
  let expectedChain;
  try { expectedChain = BigInt(batchObj.chainId); } catch (_) { return { ok: false, code: "DISPATCH_BROADCAST_CHAIN_MISMATCH" }; }
  if (observedChain !== expectedChain) return { ok: false, code: "DISPATCH_BROADCAST_CHAIN_MISMATCH" };

  return { ok: true, resolvedUrl: endpointUrl, loadedSigner: loaded };
}
function terminalBindingOk(finalState, batchId, expectedBatchCommitment, scopeCommitment, runId) {
  if (!finalState || finalState.state !== STATES.CONSUMED) return false;
  if (finalState.batchCommitment !== expectedBatchCommitment) return false;
  const terminal = finalState.terminal;
  if (!isPlainObject(terminal) || terminal.state !== STATES.CONSUMED) return false;
  return terminal.batchId === batchId
    && terminal.batchCommitment === expectedBatchCommitment
    && terminal.manifestCommitment === scopeCommitment
    && terminal.runId === runId;
}

// Shared pre-consume pipeline for `dispatchOnce` and `preflightOnce`. Every
// pre-consume refusal keeps the historical sanitized envelope. On success it
// returns `{ prepared: true, ...context }`; `dispatchOnce` then consumes and
// broadcasts, while `preflightOnce` returns READY without consuming. Extracting
// this keeps the dispatcher's own preflight as the single source of truth for
// both entry points, so a `--check` can never diverge from a real dispatch.
async function prepareDispatch(options) {
  if (!isPlainObject(options)) return envelope(STATUS.FAIL_CLOSED, "DISPATCH_ARGUMENTS_INVALID");
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) return envelope(STATUS.FAIL_CLOSED, "DISPATCH_ARGUMENTS_INVALID");
  }
  let expected;
  let deps;
  let now;
  let batchOptions;
  let batchModule;
  let wiring;
  try {
    expected = options.expectedBatchCommitment;
    if (typeof expected !== "string" || !HASH.test(expected)) return envelope(STATUS.FAIL_CLOSED, "DISPATCH_EXPECTED_COMMITMENT_INVALID");
    if (options.signerRef !== undefined && !isSafeRef(options.signerRef)) return envelope(STATUS.FAIL_CLOSED, "DISPATCH_SIGNER_REF_INVALID");
    if (options.endpointRef !== undefined && !isSafeRef(options.endpointRef)) return envelope(STATUS.FAIL_CLOSED, "DISPATCH_ENDPOINT_REF_INVALID");
    if (options.runId !== undefined && !isSafeRef(options.runId)) return envelope(STATUS.FAIL_CLOSED, "DISPATCH_RUN_ID_INVALID");

    deps = isPlainObject(options.deps) ? options.deps : {};
    now = typeof deps.now === "function" ? deps.now : Date.now;

    // R1: reject behavior injection, validate the DATA-only path binding, and use
    // the REAL canonical module unconditionally. `deps.batch` is adversarial and
    // its presence is a sanitized fail-closed refusal with no adapter call.
    const batchResolution = resolveBatchOptions(deps);
    if (!batchResolution.ok) return envelope(STATUS.FAIL_CLOSED, batchResolution.code, { batchCommitment: expected });
    batchOptions = batchResolution.options;

    batchModule = resolveBatchModule();
    if (!batchModule || typeof batchModule.batchState !== "function" || typeof batchModule.consumeBatch !== "function" || typeof batchModule.scopeCommitment !== "function") {
      return envelope(STATUS.FAIL_CLOSED, "DISPATCH_BATCH_MODULE_INVALID");
    }

    // 0. Validate the broadcast wiring before touching the authority. If the path
    //    cannot execute, refuse without consuming; a valid batch is never burned.
    wiring = resolveBroadcastWiring(deps);
    if (!wiring.ok) {
      return envelope(STATUS.FAIL_CLOSED, wiring.code, { batchCommitment: expected });
    }
  } catch (_) {
    // F4: a hostile throwing getter on `options`/`deps` (for example
    // `deps.batchOptions.batchPath`) yields the sanitized fail-closed envelope
    // instead of rejecting the promise out of `dispatchOnce`.
    return envelope(STATUS.FAIL_CLOSED, "DISPATCH_ARGUMENTS_INVALID");
  }
  const runBroadcast = wiring.runBroadcast;
  const injectedAdapter = wiring.injected;

  // 1. Refuse unless the canonical state is VALID and bound to the expected commitment.
  let state;
  try { state = batchModule.batchState({ ...batchOptions, now }); }
  catch (_) { return envelope(STATUS.FAIL_CLOSED, "DISPATCH_BATCH_STATE_UNAVAILABLE"); }
  if (!state || state.state !== STATES.VALID) {
    return envelope(STATUS.REFUSED, `DISPATCH_BATCH_STATE_${safeState(state && state.state)}`);
  }
  if (state.batchCommitment !== expected) {
    return envelope(STATUS.REFUSED, "DISPATCH_BATCH_COMMITMENT_MISMATCH", { batchCommitment: expected });
  }
  const batchObj = state.batch;
  if (!isPlainObject(batchObj)) return envelope(STATUS.FAIL_CLOSED, "DISPATCH_BATCH_OBJECT_INVALID");

  // 2. FORK_TESTNET is never broadcastable; only v3 TESTNET/PRODUCTION are executable.
  const mode = batchObj.mode;
  if (mode === "FORK_TESTNET") return envelope(STATUS.REFUSED, "DISPATCH_MODE_FORBIDDEN", { batchCommitment: expected });
  if (!EXECUTABLE_MODES.includes(mode)) return envelope(STATUS.REFUSED, "DISPATCH_MODE_UNKNOWN", { batchCommitment: expected });
  if (batchObj.schema !== SCHEMA_V3) return envelope(STATUS.REFUSED, "DISPATCH_SCHEMA_NOT_V3", { batchCommitment: expected });

  // 3. Require the explicit human confirmation to equal the batch's own id.
  const confirmBatchId = options.confirmBatchId;
  if (typeof confirmBatchId !== "string" || confirmBatchId.length === 0 || confirmBatchId !== batchObj.batchId) {
    return envelope(STATUS.REFUSED, "DISPATCH_CONFIRMATION_MISMATCH", { batchCommitment: expected });
  }

  // 4. Re-derive the scope commitment from the signed batch before consuming.
  let recomputedScope;
  try { recomputedScope = batchModule.scopeCommitment(batchObj); }
  catch (_) { return envelope(STATUS.FAIL_CLOSED, "DISPATCH_SCOPE_RECOMPUTE_FAILED", { batchCommitment: expected }); }
  if (typeof recomputedScope !== "string" || !HASH.test(recomputedScope) || recomputedScope !== state.scopeCommitment) {
    return envelope(STATUS.REFUSED, "DISPATCH_SCOPE_COMMITMENT_MISMATCH", { batchCommitment: expected });
  }

  // No caller-supplied runId is required; derive a deterministic one for the CLI.
  const runId = options.runId === undefined ? `dispatch-${expected.slice(2)}` : options.runId;

  // 4b. R2/F1: for the default adapter path, run the adapter's PURE request
  //     validator plus read-only signer/chain probes BEFORE consuming. Every
  //     adapter-rejectable condition (missing/invalid refs, `..` traversal,
  //     commitment/scope binding, wrong signer, wrong chain) is refused with zero
  //     sends and an unburned authority. An injected `deps.runBroadcast` is
  //     self-contained and owns its own wiring, so it is exempt.
  let adapterDeps = deps;
  if (!injectedAdapter) {
    const adapterRequest = {
      batch: batchObj,
      runId,
      expectedBatchCommitment: expected,
      scopeCommitment: recomputedScope,
      signerRef: options.signerRef,
      endpointRef: options.endpointRef,
      deps,
    };
    const preflight = await preflightDefaultBroadcastPath(deps, batchObj, adapterRequest);
    if (!preflight.ok) {
      return envelope(STATUS.FAIL_CLOSED, preflight.code, { batchCommitment: expected, scopeCommitment: recomputedScope });
    }
    // F2: memoize the endpoint resolution and signer load for the duration of
    // this single dispatch. The adapter's calls return the same preflighted,
    // already-validated URL and the same already-probed signer, so each injected
    // resolver/loader is invoked exactly once per `dispatchOnce`.
    adapterDeps = Object.create(deps);
    adapterDeps.resolveSendEndpoint = async () => preflight.resolvedUrl;
    adapterDeps.loadSigner = async () => preflight.loadedSigner;
  }

  return {
    prepared: true,
    expected, deps, now, batchOptions, batchModule, batchObj, mode, confirmBatchId,
    recomputedScope, runId, adapterDeps, injectedAdapter, runBroadcast,
  };
}

async function dispatchOnce(options = {}) {
  const prepared = await prepareDispatch(options);
  if (!prepared.prepared) return prepared;
  const {
    expected, deps, now, batchOptions, batchModule, batchObj, mode, confirmBatchId,
    recomputedScope, runId, adapterDeps, runBroadcast,
  } = prepared;

  // 5. Consume the single at-most-once authority BEFORE the adapter runs.
  //    The scope commitment is the signed manifest commitment; no manifest
  //    override is accepted from the caller. (Documented overload: the CONSUMED
  //    terminal marker's `manifestCommitment` field carries the re-derived batch
  //    scopeCommitment here, whereas the fork path stores a manifest commitment.)
  try {
    batchModule.consumeBatch({ ...batchOptions, expectedBatchCommitment: expected, manifestCommitment: recomputedScope, runId, now });
  } catch (_) {
    let observedState = "UNKNOWN";
    try { observedState = safeState(batchModule.batchState({ ...batchOptions, now })?.state); } catch (_) { observedState = "UNKNOWN"; }
    return envelope(STATUS.FAIL_CLOSED, "DISPATCH_CONSUMPTION_INDETERMINATE", {
      batchCommitment: expected, scopeCommitment: recomputedScope, runId, observedState,
    });
  }

  // 6. Invoke the sibling adapter exactly once, forwarding the caller's deps.
  //    FIX 2(a): forwarding `deps` is what lets the real adapter's transport,
  //    signer loader, endpoint resolver and DATA-only batch path reach it. For
  //    the default path `adapterDeps` shadows only the resolver/signer with the
  //    memoized preflight values (F2). The adapter reads the same bound path via
  //    `deps.batchOptions`.
  let adapterEnvelope = null;
  let adapterThrew = false;
  try {
    adapterEnvelope = await runBroadcast({
      batch: batchObj,
      runId,
      expectedBatchCommitment: expected,
      scopeCommitment: recomputedScope,
      signerRef: options.signerRef,
      endpointRef: options.endpointRef,
      deps: adapterDeps,
    });
  } catch (_) { adapterThrew = true; }

  const view = adapterThrew ? { status: "UNKNOWN", counts: null, sends: [] } : sanitizeEnvelope(adapterEnvelope);

  // 7. FIX 3: map the adapter envelope status onto the dispatcher status. A
  //    non-throwing FAIL_CLOSED/INCOMPLETE adapter result is never BROADCASTED.
  let status;
  let blocker;
  if (adapterThrew) {
    status = STATUS.INCOMPLETE;
    blocker = "DISPATCH_BROADCAST_ADAPTER_FAILED";
  } else if (view.status === ADAPTER_STATUS.COMPLETED) {
    status = STATUS.BROADCASTED;
    blocker = null;
  } else if (view.status === ADAPTER_STATUS.INCOMPLETE) {
    status = STATUS.INCOMPLETE;
    blocker = "DISPATCH_BROADCAST_INCOMPLETE";
  } else if (view.status === ADAPTER_STATUS.FAIL_CLOSED) {
    status = STATUS.FAIL_CLOSED;
    blocker = "DISPATCH_BROADCAST_ADAPTER_FAIL_CLOSED";
  } else {
    status = STATUS.FAIL_CLOSED;
    blocker = "DISPATCH_BROADCAST_STATUS_UNRECOGNIZED";
  }

  // 8. Publish a write-once, sanitized result envelope. Only adapter status and
  //    bounded counts cross the boundary; raw adapter payloads are never copied.
  const result = envelope(status, blocker, {
    runId,
    batchCommitment: expected,
    scopeCommitment: recomputedScope,
    confirmBatchId,
    batchId: batchObj.batchId,
    mode,
    adapterStatus: view.status,
    counts: view.counts,
    sends: view.sends,
  });
  try { assertSanitized(result); }
  catch (_) { return envelope(STATUS.FAIL_CLOSED, "DISPATCH_RESULT_UNSANITIZED", { batchCommitment: expected, runId }); }

  const publishResult = typeof deps.publishResult === "function" ? deps.publishResult : defaultPublishResult;
  let publishFailed = false;
  try { await publishResult(result); }
  catch (_) { publishFailed = true; }

  // 9. Re-read the final canonical state and confirm the terminal marker binds
  //    the same batch, scope, and runId. Indeterminate durability fails closed
  //    with no retry and no resend.
  let finalState = null;
  try { finalState = batchModule.batchState({ ...batchOptions, now }); } catch (_) { finalState = null; }
  if (!terminalBindingOk(finalState, batchObj.batchId, expected, recomputedScope, runId)) {
    return envelope(STATUS.INCOMPLETE, "DISPATCH_FINAL_STATE_MISMATCH", {
      runId, batchCommitment: expected, scopeCommitment: recomputedScope,
      adapterStatus: view.status, counts: view.counts, sends: view.sends,
    });
  }
  if (publishFailed) {
    return envelope(STATUS.INCOMPLETE, "DISPATCH_RESULT_PUBLISH_INDETERMINATE", {
      runId, batchCommitment: expected, scopeCommitment: recomputedScope,
      adapterStatus: view.status, counts: view.counts, sends: view.sends,
    });
  }
  return result;
}

// TASK 2 seam: a read-only `--check` preflight that reuses the exact same
// pre-consume pipeline as `dispatchOnce` but NEVER calls `consumeBatch` and
// never invokes the adapter. On refusal it returns the same sanitized envelope
// `dispatchOnce` would return; on success it returns a READY envelope with the
// bound ids and zero-send counts. The loaded signer material is intentionally
// not returned across this boundary; callers that own the signer loader are
// responsible for zeroizing their own captured key bytes.
async function preflightOnce(options = {}) {
  const prepared = await prepareDispatch(options);
  if (!prepared.prepared) return prepared;
  const { expected, batchObj, mode, confirmBatchId, recomputedScope, runId } = prepared;
  return envelope(STATUS.READY, null, {
    runId,
    batchCommitment: expected,
    scopeCommitment: recomputedScope,
    confirmBatchId,
    batchId: batchObj.batchId,
    mode,
    counts: {
      actions: Array.isArray(batchObj.actions) ? batchObj.actions.length : null,
      attempts: 0,
      sends: 0,
      confirmations: 0,
    },
    sends: [],
  });
}

function parseCli(args) {
  if (!Array.isArray(args) || args.length === 0) fail("USAGE_ERROR");
  if (args[0] !== "dispatch-once") fail("USAGE_ERROR");
  const rest = args.slice(1);
  if (rest.length < 4 || rest.length > 8 || rest.length % 2 !== 0) fail("USAGE_ERROR");
  const flags = ["--expected-batch-commitment", "--confirm", "--signer-ref", "--endpoint-ref"];
  const pairs = new Map();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (!flags.includes(flag)) fail("USAGE_ERROR");
    if (pairs.has(flag) || typeof value !== "string" || value.length === 0) fail("USAGE_ERROR");
    pairs.set(flag, value);
  }
  if (!pairs.has("--expected-batch-commitment") || !pairs.has("--confirm")) fail("USAGE_ERROR");
  const expectedBatchCommitment = pairs.get("--expected-batch-commitment");
  if (!HASH.test(expectedBatchCommitment)) fail("USAGE_ERROR");
  const confirmBatchId = pairs.get("--confirm");
  if (typeof confirmBatchId !== "string" || confirmBatchId.length === 0 || confirmBatchId.length > 64) fail("USAGE_ERROR");
  const options = { expectedBatchCommitment, confirmBatchId };
  for (const [flag, key] of [["--signer-ref", "signerRef"], ["--endpoint-ref", "endpointRef"]]) {
    if (!pairs.has(flag)) continue;
    const value = pairs.get(flag);
    if (!isSafeRef(value)) fail("USAGE_ERROR");
    options[key] = value;
  }
  return { command: "dispatch-once", options };
}

async function runCli(argv = process.argv) {
  let parsed;
  try { parsed = parseCli(argv.slice(2)); }
  catch (error) {
    const blocker = error instanceof DispatchError ? error.code : "USAGE_ERROR";
    process.stdout.write(`${JSON.stringify({ status: STATUS.FAIL_CLOSED, blocker })}\n`);
    process.exitCode = 1;
    return null;
  }
  let result;
  try { result = await dispatchOnce(parsed.options); }
  catch (_) {
    process.stdout.write(`${JSON.stringify({ status: STATUS.FAIL_CLOSED, blocker: "INTERNAL_FAILURE_REDACTED" })}\n`);
    process.exitCode = 1;
    return null;
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== STATUS.BROADCASTED) process.exitCode = 1;
  return result;
}

if (require.main === module) runCli();

module.exports = Object.freeze({
  DISPATCH_SCHEMA,
  STATUS,
  ADAPTER_STATUS,
  SEND_STATUSES,
  dispatchOnce,
  preflightOnce,
  prepareDispatch,
  sanitizeSends,
  preflightDefaultBroadcastPath,
  defaultPublishResult,
  parseCli,
  runCli,
  DispatchError,
});
