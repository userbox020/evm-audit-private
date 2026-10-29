"use strict";

const crypto = require("node:crypto");
const { types } = require("node:util");

const CHAIN_ID = 8453;
const OFFICIAL_SOURCE_PIN = "89de5264c22e0e6e4e075a67046d120a7e7dbcff";
const MAX_CANDIDATES = 24;
const MAX_PAGES = 64;
const MAX_RANGE_BLOCKS = 4096;
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_INPUT_DEPTH = 32;
const MAX_INPUT_NODES = 20000;
const MAX_CONTAINER_KEYS = 8192;
const COVERAGE = "INDEXED_FACTORY_EVENT_SUBSET_ONLY";
const INCOMPLETE_COVERAGE = "INCOMPLETE";
const STATUSES = Object.freeze([
  "READY_FOR_BOUND_VAULT_STATE_READ",
  "HOLD_NO_NEW_VAULT",
  "REJECT",
  "INCOMPLETE"
]);
const REVIEWED_FIXTURE_AUTHORITY = Object.freeze({
  factoryBindingCommitment: "reviewed_fixture_base_metamorpho_v1_1_factory_binding_r1",
  decoderBindingCommitment: "reviewed_fixture_create_metamorpho_exact_decoder_r1",
  eventBindingCommitment: "reviewed_fixture_create_metamorpho_event_layout_r1",
  queryFilterCommitment: "reviewed_fixture_sqd_create_metamorpho_query_filter_r1",
  previousWatcherStateCommitment: "reviewed_fixture_previous_metamorpho_watcher_state_r1",
  priorCheckpointCommitment: "reviewed_fixture_previous_metamorpho_checkpoint_r1",
  initialCursorCommitment: "reviewed_fixture_sqd_initial_cursor_r1",
  cursorChainCommitment: "reviewed_fixture_sqd_cursor_chain_r1",
  terminalExhaustionCommitment: "reviewed_fixture_sqd_terminal_exhaustion_r1",
  observerClassCommitments: Object.freeze([
    "reviewed_fixture_sqd_observer_class_alpha_r1",
    "reviewed_fixture_sqd_observer_class_beta_r1"
  ])
});

class WatcherError extends Error {
  constructor(code, kind = "INCOMPLETE") {
    super(code);
    this.name = "WatcherError";
    this.code = code;
    this.kind = kind;
  }
}

const stop = (code, kind = "INCOMPLETE") => { throw new WatcherError(code, kind); };
const isProxy = (value) => value !== null && typeof value === "object" && types.isProxy(value);
const ownObject = (value) => value !== null && typeof value === "object" && !isProxy(value) && !Array.isArray(value);
const hasOwn = (value, key) => ownObject(value) && Object.hasOwn(value, key);

function isPlainRecord(value) {
  if (!ownObject(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireExact(value, keys, code) {
  if (!ownObject(value)) stop(`${code}_MISSING`);
  for (const key of keys) if (!Object.hasOwn(value, key)) stop(`${code}_${key.toUpperCase()}_MISSING`);
  if (Object.keys(value).some((key) => !keys.includes(key))) stop(`${code}_EXTRA_FIELD`, "REJECT");
  return value;
}

function boolean(value, code) {
  if (typeof value !== "boolean") stop(code, "REJECT");
  return value;
}

function exactTrue(value, key, code) {
  if (!hasOwn(value, key)) stop(`${code}_MISSING`);
  if (boolean(value[key], `${code}_INVALID`) !== true) stop(code, "REJECT");
}

function exactFalse(value, key, code) {
  if (!hasOwn(value, key)) stop(`${code}_MISSING`);
  if (boolean(value[key], `${code}_INVALID`) !== false) stop(code, "REJECT");
}

function completionTrue(value, key, code) {
  if (!hasOwn(value, key)) stop(`${code}_MISSING`);
  if (typeof value[key] !== "boolean") stop(`${code}_INVALID`, "REJECT");
  if (value[key] !== true) stop(code);
}

function opaque(value, code) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{2,127}$/u.test(value)) stop(code, "REJECT");
  return value;
}

function uint(value, code) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) stop(code, "REJECT");
  return BigInt(value);
}

function index(value, code) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0x7fffffff) stop(code, "REJECT");
  return value;
}

const FORBIDDEN_KEY = /^(?:url|urls|uri|uris|domain|domains|hostname|hostnames|endpoint|endpoints|provider|providers|providerLabel|providerLabels|family|families|familyLabel|familyLabels|httpHeader|httpHeaders|authorization|credential|credentials|apiKey|token|secret|password|wallet|wallets|privateKey|keypair|address|addresses|factoryAddress|vaultAddress|transactionHash|transactionHashes|txHash|txHashes|eventHash|eventHashes|blockHash|blockHashes|sourcePath|sourcePaths|path|paths|raw|rawPayload|rawResponse|rawRpc|rpc|rpcUrl|calldata|report|reports)$/iu;

function assertSanitized(value) {
  const ancestors = new Set();
  let nodes = 0;
  function visit(current, depth = 0) {
    nodes += 1;
    if (nodes > MAX_INPUT_NODES || depth > MAX_INPUT_DEPTH) stop("SANITIZER_BOUNDS_EXCEEDED", "REJECT");
    if (typeof current === "string") {
      if (/(?:https?|wss?|ftp):\/\//iu.test(current)) stop("FORBIDDEN_URL", "REJECT");
      if (/^(?:Bearer|Basic)\s+/iu.test(current)) stop("FORBIDDEN_CREDENTIAL", "REJECT");
      if (/\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|xyz|cloud|dev|app|finance|invalid)\b/iu.test(current)) stop("FORBIDDEN_DOMAIN", "REJECT");
      if (/^0x[0-9a-f]+$/iu.test(current) || /^[0-9a-f]{64}$/iu.test(current)
          || (/^[0-9a-f]{40}$/iu.test(current) && current.toLowerCase() !== OFFICIAL_SOURCE_PIN)) {
        stop("FORBIDDEN_HEX_IDENTIFIER", "REJECT");
      }
      if (/[\u0000-\u001f\u007f]/u.test(current)) stop("FORBIDDEN_CONTROL_CHARACTER", "REJECT");
      return;
    }
    if (current === null || typeof current === "boolean" || (typeof current === "number" && Number.isFinite(current))) return;
    if (!current || typeof current !== "object" || isProxy(current) || ancestors.has(current)) stop("UNSANITIZED_VALUE", "REJECT");
    if (!Array.isArray(current) && !isPlainRecord(current)) stop("NONPLAIN_OBJECT", "REJECT");
    ancestors.add(current);
    const descriptors = Object.getOwnPropertyDescriptors(current);
    if (Object.getOwnPropertySymbols(current).length !== 0 || Object.keys(descriptors).length > MAX_CONTAINER_KEYS) stop("UNSANITIZED_SHAPE", "REJECT");
    for (const descriptor of Object.values(descriptors)) {
      if (typeof descriptor.get === "function" || typeof descriptor.set === "function") stop("ACCESSOR_FORBIDDEN", "REJECT");
    }
    if (Array.isArray(current)) {
      for (let itemIndex = 0; itemIndex < current.length; itemIndex += 1) {
        const descriptor = descriptors[String(itemIndex)];
        if (!descriptor || !("value" in descriptor)) stop("SPARSE_ARRAY_FORBIDDEN", "REJECT");
        visit(descriptor.value, depth + 1);
      }
    } else {
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (FORBIDDEN_KEY.test(key)) stop("FORBIDDEN_FIELD", "REJECT");
        visit(descriptor.value, depth + 1);
      }
    }
    ancestors.delete(current);
  }
  visit(value);
  return true;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function resultHash(value) {
  return `derived_${crypto.createHash("sha256").update(canonical(value)).digest("base64url")}`;
}

function makeResult(status, count = 0, safeContinuation = false, coverage = INCOMPLETE_COVERAGE) {
  const core = {
    count,
    status,
    derivedHash: null,
    safeContinuation,
    coverage,
    gates: { profit: false, execution: false, signed: false }
  };
  core.derivedHash = resultHash({
    count: core.count,
    status: core.status,
    safeContinuation: core.safeContinuation,
    coverage: core.coverage,
    gates: core.gates
  });
  if (!validateResult(core)) throw new Error("INTERNAL_RESULT_INVALID");
  return core;
}

function validateResult(value) {
  if (!ownObject(value)
      || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["count", "coverage", "derivedHash", "gates", "safeContinuation", "status"].sort())
      || !Number.isSafeInteger(value.count) || value.count < 0 || value.count > MAX_CANDIDATES
      || !STATUSES.includes(value.status)
      || typeof value.derivedHash !== "string" || !/^derived_[A-Za-z0-9_-]{43}$/u.test(value.derivedHash)
      || typeof value.safeContinuation !== "boolean"
      || ![COVERAGE, INCOMPLETE_COVERAGE].includes(value.coverage)
      || !ownObject(value.gates)
      || JSON.stringify(Object.keys(value.gates).sort()) !== JSON.stringify(["execution", "profit", "signed"])
      || Object.values(value.gates).some((item) => item !== false)) return false;
  if (["READY_FOR_BOUND_VAULT_STATE_READ", "HOLD_NO_NEW_VAULT"].includes(value.status)) {
    if (!value.safeContinuation || value.coverage !== COVERAGE) return false;
  } else if (value.safeContinuation || value.coverage !== INCOMPLETE_COVERAGE || value.count !== 0) return false;
  const expected = resultHash({
    count: value.count,
    status: value.status,
    safeContinuation: value.safeContinuation,
    coverage: value.coverage,
    gates: value.gates
  });
  return value.derivedHash === expected;
}

function topLevelDataProperty(input, key, missingCode) {
  if (!isPlainRecord(input)) stop("INPUT_MISSING", "REJECT");
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor) stop(missingCode);
  if (typeof descriptor.get === "function" || typeof descriptor.set === "function") stop("ACCESSOR_FORBIDDEN", "REJECT");
  return descriptor.value;
}

function safeDescriptors(value, code, arrayExpected = false) {
  if (!value || typeof value !== "object" || isProxy(value)) stop(`${code}_UNSAFE_SHAPE`, "REJECT");
  if (arrayExpected ? !Array.isArray(value) : !isPlainRecord(value)) stop(`${code}_UNSAFE_SHAPE`, "REJECT");
  if (arrayExpected && value.length > MAX_CONTAINER_KEYS) stop(`${code}_UNSAFE_SHAPE`, "REJECT");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length !== 0 || Object.keys(descriptors).length > MAX_CONTAINER_KEYS) stop(`${code}_UNSAFE_SHAPE`, "REJECT");
  if (Object.values(descriptors).some((descriptor) => typeof descriptor.get === "function" || typeof descriptor.set === "function")) {
    stop("ACCESSOR_FORBIDDEN", "REJECT");
  }
  if (arrayExpected && Object.keys(descriptors).some((key) => key !== "length"
      && (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length))) stop(`${code}_ARRAY_EXTRA_FIELD`, "REJECT");
  return descriptors;
}

function shallowArray(value, cap, code) {
  if (!value || typeof value !== "object" || isProxy(value) || !Array.isArray(value)) stop(`${code}_UNSAFE_SHAPE`, "REJECT");
  if (value.length > cap) stop(`${code}_CAP_EXCEEDED`, "REJECT");
  const descriptors = safeDescriptors(value, code, true);
  for (let itemIndex = 0; itemIndex < value.length; itemIndex += 1) {
    if (!descriptors[String(itemIndex)] || !("value" in descriptors[String(itemIndex)])) stop(`${code}_SPARSE`, "REJECT");
  }
  return descriptors;
}

function boundedInputBytes(value) {
  const ancestors = new Set();
  let nodes = 0;
  function add(current, depth) {
    nodes += 1;
    if (nodes > MAX_INPUT_NODES || depth > MAX_INPUT_DEPTH) stop("INPUT_ACCOUNTING_BOUNDS_EXCEEDED", "REJECT");
    if (current === null) return 4;
    if (typeof current === "boolean") return current ? 4 : 5;
    if (typeof current === "number" && Number.isFinite(current)) return Buffer.byteLength(JSON.stringify(current), "utf8");
    if (typeof current === "string") {
      if (current.length > MAX_INPUT_BYTES) stop("INPUT_CAP_EXCEEDED", "REJECT");
      return Buffer.byteLength(JSON.stringify(current), "utf8");
    }
    if (!current || typeof current !== "object" || isProxy(current) || ancestors.has(current)) stop("INPUT_NOT_SERIALIZABLE", "REJECT");
    const array = Array.isArray(current);
    const descriptors = safeDescriptors(current, "INPUT_ACCOUNTING", array);
    ancestors.add(current);
    let bytes = 2;
    if (array) {
      for (let itemIndex = 0; itemIndex < current.length; itemIndex += 1) {
        const descriptor = descriptors[String(itemIndex)];
        if (!descriptor || !("value" in descriptor)) stop("INPUT_ARRAY_SPARSE", "REJECT");
        bytes += (itemIndex === 0 ? 0 : 1) + add(descriptor.value, depth + 1);
        if (bytes > MAX_INPUT_BYTES) stop("INPUT_CAP_EXCEEDED", "REJECT");
      }
    } else {
      const entries = Object.entries(descriptors);
      for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
        const [key, descriptor] = entries[entryIndex];
        if (!("value" in descriptor)) stop("ACCESSOR_FORBIDDEN", "REJECT");
        bytes += (entryIndex === 0 ? 0 : 1) + Buffer.byteLength(JSON.stringify(key), "utf8") + 1 + add(descriptor.value, depth + 1);
        if (bytes > MAX_INPUT_BYTES) stop("INPUT_CAP_EXCEEDED", "REJECT");
      }
    }
    ancestors.delete(current);
    return bytes;
  }
  const bytes = add(value, 0);
  if (bytes > MAX_INPUT_BYTES) stop("INPUT_CAP_EXCEEDED", "REJECT");
  return bytes;
}

function preflightCaps(input) {
  safeDescriptors(input, "INPUT");
  const pages = topLevelDataProperty(input, "pages", "PAGES_MISSING");
  const pageDescriptors = shallowArray(pages, MAX_PAGES, "PAGE");

  let eventCount = 0;
  let headerCount = 0;
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = pageDescriptors[String(pageIndex)].value;
    const descriptors = safeDescriptors(page, "PAGE");
    const descriptor = descriptors.events;
    if (descriptor) {
      shallowArray(descriptor.value, MAX_CANDIDATES, "CANDIDATE");
      eventCount += descriptor.value.length;
      if (eventCount > MAX_CANDIDATES) stop("CANDIDATE_CAP_EXCEEDED", "REJECT");
    }
    if (descriptors.headers) {
      shallowArray(descriptors.headers.value, MAX_RANGE_BLOCKS, "HEADER");
      headerCount += descriptors.headers.value.length;
      if (headerCount > MAX_RANGE_BLOCKS) stop("HEADER_CAP_EXCEEDED", "REJECT");
    }
  }
  const inputBytes = boundedInputBytes(input);
  return { pages, eventCount, headerCount, inputBytes };
}

function validateRange(authority) {
  const range = requireExact(authority.range, [
    "immutable", "finalized", "startBlock", "endBlock", "previousLastHeaderNumber",
    "previousLastHeaderCommitment", "rangeCommitment"
  ], "RANGE");
  exactTrue(range, "immutable", "RANGE_NOT_IMMUTABLE");
  exactTrue(range, "finalized", "RANGE_NOT_FINALIZED");
  const start = uint(range.startBlock, "RANGE_START_INVALID");
  const end = uint(range.endBlock, "RANGE_END_INVALID");
  const previous = uint(range.previousLastHeaderNumber, "PREVIOUS_HEADER_NUMBER_INVALID");
  if (start !== previous + 1n) stop("CONTINUATION_NOT_EXACT", "REJECT");
  if (end < start || end - start + 1n > BigInt(MAX_RANGE_BLOCKS)) stop("RANGE_BOUNDS_INVALID", "REJECT");
  return {
    start,
    end,
    previous,
    previousCommitment: opaque(range.previousLastHeaderCommitment, "PREVIOUS_HEADER_COMMITMENT_INVALID"),
    rangeCommitment: opaque(range.rangeCommitment, "RANGE_COMMITMENT_INVALID")
  };
}

function validatePriorCheckpoint(authority, range) {
  const checkpoint = requireExact(authority.priorCheckpoint, [
    "exact", "previousWatcherStateCommitment", "checkpointCommitment", "lastHeaderNumber",
    "lastHeaderCommitment", "initialCursorCommitment"
  ], "PRIOR_CHECKPOINT");
  exactTrue(checkpoint, "exact", "PRIOR_CHECKPOINT_NOT_EXACT");
  if (checkpoint.previousWatcherStateCommitment !== REVIEWED_FIXTURE_AUTHORITY.previousWatcherStateCommitment
      || checkpoint.checkpointCommitment !== REVIEWED_FIXTURE_AUTHORITY.priorCheckpointCommitment
      || checkpoint.initialCursorCommitment !== REVIEWED_FIXTURE_AUTHORITY.initialCursorCommitment) {
    stop("PRIOR_CHECKPOINT_NOT_REVIEWED", "REJECT");
  }
  if (uint(checkpoint.lastHeaderNumber, "CHECKPOINT_HEADER_NUMBER_INVALID") !== range.previous
      || checkpoint.lastHeaderCommitment !== range.previousCommitment) stop("PRIOR_CHECKPOINT_RANGE_MISMATCH", "REJECT");
  return checkpoint;
}

function validateTerminalExhaustionAuthority(authority, pageSetCommitment) {
  const terminal = requireExact(authority.terminalExhaustion, [
    "exact", "exhausted", "noNextPage", "queryFilterCommitment", "priorCheckpointCommitment",
    "initialCursorCommitment", "cursorChainCommitment", "pageSetCommitment", "returnedCursorCommitment", "proofCommitment"
  ], "TERMINAL_EXHAUSTION");
  exactTrue(terminal, "exact", "TERMINAL_EXHAUSTION_NOT_EXACT");
  completionTrue(terminal, "exhausted", "TERMINAL_NOT_EXHAUSTED");
  completionTrue(terminal, "noNextPage", "TERMINAL_NEXT_PAGE_UNRESOLVED");
  if (terminal.returnedCursorCommitment !== null) stop("TERMINAL_CURSOR_NOT_EMPTY");
  if (terminal.queryFilterCommitment !== REVIEWED_FIXTURE_AUTHORITY.queryFilterCommitment
      || terminal.priorCheckpointCommitment !== REVIEWED_FIXTURE_AUTHORITY.priorCheckpointCommitment
      || terminal.initialCursorCommitment !== REVIEWED_FIXTURE_AUTHORITY.initialCursorCommitment
      || terminal.cursorChainCommitment !== REVIEWED_FIXTURE_AUTHORITY.cursorChainCommitment
      || terminal.pageSetCommitment !== pageSetCommitment
      || terminal.proofCommitment !== REVIEWED_FIXTURE_AUTHORITY.terminalExhaustionCommitment) {
    stop("TERMINAL_EXHAUSTION_BINDING_MISMATCH", "REJECT");
  }
  return terminal;
}

function validateObservers(authority, range, pageSetCommitment, terminalExhaustion) {
  if (!Array.isArray(authority.observers)) stop("OBSERVERS_MISSING");
  if (authority.observers.length !== 2) stop("TWO_OBSERVERS_REQUIRED", "REJECT");
  const classes = new Set();
  const observations = new Set();
  let terminalHeaderCommitment = null;
  for (const observer of authority.observers) {
    requireExact(observer, [
      "classCommitment", "observationCommitment", "reviewed", "independent", "finalized", "canonical",
      "exactPageAgreement", "exhaustivePageSet", "rangeCommitment", "pageSetCommitment", "terminalHeaderCommitment",
      "queryFilterCommitment", "priorCheckpointCommitment", "initialCursorCommitment", "cursorChainCommitment",
      "terminalExhaustionCommitment"
    ], "OBSERVER");
    exactTrue(observer, "reviewed", "OBSERVER_NOT_REVIEWED");
    exactTrue(observer, "independent", "OBSERVER_NOT_INDEPENDENT");
    exactTrue(observer, "finalized", "OBSERVER_NOT_FINALIZED");
    exactTrue(observer, "canonical", "OBSERVER_NOT_CANONICAL");
    exactTrue(observer, "exactPageAgreement", "OBSERVER_PAGE_DISAGREEMENT");
    completionTrue(observer, "exhaustivePageSet", "OBSERVER_EXHAUSTION_UNPROVEN");
    const classCommitment = opaque(observer.classCommitment, "OBSERVER_CLASS_INVALID");
    const observationCommitment = opaque(observer.observationCommitment, "OBSERVER_COMMITMENT_INVALID");
    if (!REVIEWED_FIXTURE_AUTHORITY.observerClassCommitments.includes(classCommitment) || classes.has(classCommitment)) {
      stop("OBSERVER_CLASSES_NOT_DISTINCT_REVIEWED", "REJECT");
    }
    if (observations.has(observationCommitment)) stop("OBSERVER_COMMITMENTS_NOT_DISTINCT", "REJECT");
    if (observer.rangeCommitment !== range.rangeCommitment || observer.pageSetCommitment !== pageSetCommitment
        || observer.queryFilterCommitment !== REVIEWED_FIXTURE_AUTHORITY.queryFilterCommitment
        || observer.priorCheckpointCommitment !== REVIEWED_FIXTURE_AUTHORITY.priorCheckpointCommitment
        || observer.initialCursorCommitment !== REVIEWED_FIXTURE_AUTHORITY.initialCursorCommitment
        || observer.cursorChainCommitment !== REVIEWED_FIXTURE_AUTHORITY.cursorChainCommitment
        || observer.terminalExhaustionCommitment !== terminalExhaustion.proofCommitment) {
      stop("OBSERVER_SCOPE_MISMATCH", "REJECT");
    }
    const observerTerminal = opaque(observer.terminalHeaderCommitment, "OBSERVER_TERMINAL_HEADER_INVALID");
    if (terminalHeaderCommitment !== null && terminalHeaderCommitment !== observerTerminal) stop("OBSERVER_TERMINAL_DISAGREEMENT", "REJECT");
    terminalHeaderCommitment = observerTerminal;
    classes.add(classCommitment);
    observations.add(observationCommitment);
  }
  if (classes.size !== 2 || observations.size !== 2) stop("TWO_DISTINCT_REVIEWED_OBSERVERS_REQUIRED", "REJECT");
  return { observations, terminalHeaderCommitment };
}

function validateAuthority(input) {
  const authority = requireExact(input.authority, [
    "chainId", "protocol", "version", "mode", "fixtureOnly", "realCapture", "captureEnabled", "sourcePin",
    "factoryBindingCommitment", "decoderBindingCommitment", "eventBindingCommitment", "queryFilterCommitment", "range",
    "priorCheckpoint", "cursorChainCommitment", "pageSetCommitment", "terminalExhaustion", "observers", "terminalRecheck"
  ], "AUTHORITY");
  if (authority.chainId !== CHAIN_ID) stop("WRONG_CHAIN", "REJECT");
  if (authority.protocol !== "METAMORPHO" || authority.version !== "V1.1") stop("WRONG_PROTOCOL_VERSION", "REJECT");
  if (authority.mode !== "OFFLINE_REVIEWED_FIXTURE_ONLY") stop("REAL_CAPTURE_AUTHORITY_FORBIDDEN", "REJECT");
  exactTrue(authority, "fixtureOnly", "FIXTURE_ONLY_REQUIRED");
  exactFalse(authority, "realCapture", "REAL_CAPTURE_FORBIDDEN");
  exactFalse(authority, "captureEnabled", "CAPTURE_FORBIDDEN");
  if (authority.sourcePin !== OFFICIAL_SOURCE_PIN) stop("SOURCE_PIN_MISMATCH", "REJECT");
  if (authority.factoryBindingCommitment !== REVIEWED_FIXTURE_AUTHORITY.factoryBindingCommitment) stop("FACTORY_BINDING_MISMATCH", "REJECT");
  if (authority.decoderBindingCommitment !== REVIEWED_FIXTURE_AUTHORITY.decoderBindingCommitment) stop("DECODER_BINDING_MISMATCH", "REJECT");
  if (authority.eventBindingCommitment !== REVIEWED_FIXTURE_AUTHORITY.eventBindingCommitment) stop("EVENT_BINDING_MISMATCH", "REJECT");
  if (authority.queryFilterCommitment !== REVIEWED_FIXTURE_AUTHORITY.queryFilterCommitment) stop("QUERY_FILTER_BINDING_MISMATCH", "REJECT");
  if (authority.cursorChainCommitment !== REVIEWED_FIXTURE_AUTHORITY.cursorChainCommitment) stop("CURSOR_CHAIN_BINDING_MISMATCH", "REJECT");
  const range = validateRange(authority);
  const priorCheckpoint = validatePriorCheckpoint(authority, range);
  const pageSetCommitment = opaque(authority.pageSetCommitment, "PAGE_SET_COMMITMENT_INVALID");
  const terminalExhaustion = validateTerminalExhaustionAuthority(authority, pageSetCommitment);
  const observers = validateObservers(authority, range, pageSetCommitment, terminalExhaustion);
  return { authority, range, priorCheckpoint, pageSetCommitment, terminalExhaustion, observers };
}

function comparePosition(a, b) {
  if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
  if (a.transactionIndex !== b.transactionIndex) return a.transactionIndex - b.transactionIndex;
  return a.eventIndex - b.eventIndex;
}

function validateEvent(event, headerByNumber, context) {
  requireExact(event, [
    "blockNumber", "transactionIndex", "eventIndex", "headerCommitment", "candidateCommitment",
    "decodingProof", "originProof", "statusProof"
  ], "EVENT");
  const blockNumber = uint(event.blockNumber, "EVENT_BLOCK_INVALID");
  const transactionIndex = index(event.transactionIndex, "TRANSACTION_INDEX_INVALID");
  const eventIndex = index(event.eventIndex, "EVENT_INDEX_INVALID");
  const headerCommitment = opaque(event.headerCommitment, "EVENT_HEADER_COMMITMENT_INVALID");
  if (headerByNumber.get(blockNumber.toString()) !== headerCommitment) stop("EVENT_HEADER_BINDING_MISMATCH", "REJECT");
  const candidateCommitment = opaque(event.candidateCommitment, "CANDIDATE_COMMITMENT_INVALID");

  const decoding = requireExact(event.decodingProof, [
    "exact", "eventName", "version", "fieldsComplete", "topicLayoutExact", "decoderBindingCommitment",
    "eventBindingCommitment", "decodedCandidateCommitment"
  ], "DECODING_PROOF");
  exactTrue(decoding, "exact", "DECODING_NOT_EXACT");
  exactTrue(decoding, "fieldsComplete", "DECODING_FIELDS_INCOMPLETE");
  exactTrue(decoding, "topicLayoutExact", "DECODING_TOPIC_LAYOUT_INEXACT");
  if (decoding.eventName !== "CreateMetaMorpho" || decoding.version !== "V1.1") stop("EVENT_DECODER_WRONG_EVENT", "REJECT");
  if (decoding.decoderBindingCommitment !== REVIEWED_FIXTURE_AUTHORITY.decoderBindingCommitment
      || decoding.eventBindingCommitment !== REVIEWED_FIXTURE_AUTHORITY.eventBindingCommitment) stop("EVENT_DECODER_BINDING_MISMATCH", "REJECT");
  if (opaque(decoding.decodedCandidateCommitment, "DECODED_CANDIDATE_INVALID") !== candidateCommitment) stop("DECODED_CANDIDATE_MISMATCH", "REJECT");

  const origin = requireExact(event.originProof, ["factoryOnly", "exactEmitter", "factoryBindingCommitment"], "ORIGIN_PROOF");
  exactTrue(origin, "factoryOnly", "EVENT_NOT_FACTORY_ONLY");
  exactTrue(origin, "exactEmitter", "EVENT_EMITTER_NOT_EXACT");
  if (origin.factoryBindingCommitment !== REVIEWED_FIXTURE_AUTHORITY.factoryBindingCommitment) stop("EVENT_FACTORY_ORIGIN_MISMATCH", "REJECT");

  const status = requireExact(event.statusProof, ["success", "receiptBound", "transactionCommitment"], "STATUS_PROOF");
  exactTrue(status, "success", "TRANSACTION_STATUS_NOT_SUCCESS");
  exactTrue(status, "receiptBound", "STATUS_NOT_RECEIPT_BOUND");
  const transactionCommitment = opaque(status.transactionCommitment, "TRANSACTION_COMMITMENT_INVALID");

  const position = { blockNumber, transactionIndex, eventIndex };
  if (context.lastPosition && comparePosition(context.lastPosition, position) >= 0) stop("EVENT_ORDER_INVALID", "REJECT");
  const eventKey = `${blockNumber}:${transactionIndex}:${eventIndex}`;
  if (context.eventKeys.has(eventKey)) stop("DUPLICATE_EVENT", "REJECT");
  if (context.candidates.has(candidateCommitment)) stop("DUPLICATE_CANDIDATE", "REJECT");
  context.eventKeys.add(eventKey);
  context.candidates.add(candidateCommitment);
  context.transactionCommitments.add(transactionCommitment);
  context.lastPosition = position;
}

function validateContinuationProof(proofValue, pageCommitment, expectedCursor, isLastPage, authorityState, context) {
  const proof = requireExact(proofValue, [
    "exact", "complete", "queryFilterCommitment", "priorCheckpointCommitment", "pageCommitment",
    "cursorChainCommitment", "requestedCursorCommitment", "returnedCursorCommitment", "hasNextPage", "exhausted",
    "proofCommitment"
  ], "PAGE_CONTINUATION");
  exactTrue(proof, "exact", "PAGE_CONTINUATION_NOT_EXACT");
  completionTrue(proof, "complete", "PAGE_CONTINUATION_INCOMPLETE");
  if (proof.queryFilterCommitment !== REVIEWED_FIXTURE_AUTHORITY.queryFilterCommitment
      || proof.priorCheckpointCommitment !== REVIEWED_FIXTURE_AUTHORITY.priorCheckpointCommitment
      || proof.cursorChainCommitment !== REVIEWED_FIXTURE_AUTHORITY.cursorChainCommitment
      || proof.pageCommitment !== pageCommitment
      || proof.requestedCursorCommitment !== expectedCursor) stop("PAGE_CURSOR_BINDING_MISMATCH", "REJECT");
  if (typeof proof.hasNextPage !== "boolean" || typeof proof.exhausted !== "boolean") stop("PAGE_CONTINUATION_FLAGS_INVALID", "REJECT");
  if (proof.hasNextPage === proof.exhausted) stop("PAGE_CONTINUATION_FLAGS_CONTRADICTORY", "REJECT");
  const proofCommitment = opaque(proof.proofCommitment, "PAGE_CONTINUATION_PROOF_INVALID");
  if (context.continuationProofs.has(proofCommitment)) stop("DUPLICATE_CONTINUATION_PROOF", "REJECT");
  context.continuationProofs.add(proofCommitment);
  if (isLastPage) {
    if (proof.hasNextPage || !proof.exhausted) stop("TRUNCATED_PAGE_SET");
    if (proof.returnedCursorCommitment !== null) stop("TERMINAL_PAGE_CURSOR_PRESENT");
    if (proofCommitment !== authorityState.terminalExhaustion.proofCommitment) stop("TERMINAL_PAGE_EXHAUSTION_MISMATCH", "REJECT");
    return null;
  }
  if (!proof.hasNextPage || proof.exhausted) stop("OMITTED_CONTINUATION_PAGE", "REJECT");
  const returnedCursor = opaque(proof.returnedCursorCommitment, "RETURNED_CURSOR_INVALID");
  if (returnedCursor === expectedCursor || context.cursors.has(returnedCursor)) stop("CURSOR_CHAIN_LOOP", "REJECT");
  context.cursors.add(returnedCursor);
  return returnedCursor;
}

function validatePages(input, pageState, authorityState, preflight) {
  const pages = input.pages;
  if (pages.length === 0) stop("PAGES_EMPTY");
  if (pageState.pageCount !== pages.length) {
    if (pageState.pageCount > pages.length) stop("TRUNCATED_PAGE_SET");
    stop("PAGE_COUNT_MISMATCH", "REJECT");
  }
  const context = {
    candidates: new Set(),
    eventKeys: new Set(),
    headerCommitments: new Set(),
    pageCommitments: new Set(),
    continuationProofs: new Set(),
    cursors: new Set([authorityState.priorCheckpoint.initialCursorCommitment]),
    transactionCommitments: new Set(),
    lastPosition: null
  };
  let expectedBlock = authorityState.range.start;
  let expectedParent = authorityState.range.previousCommitment;
  let previousPageCommitment = null;
  let firstPageCommitment = null;
  let expectedCursor = authorityState.priorCheckpoint.initialCursorCommitment;
  let totalEvents = 0;

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = requireExact(pages[pageIndex], [
      "ordinal", "format", "pageCommitment", "previousPageCommitment", "complete", "chronological",
      "boundary", "continuationProof", "headers", "events"
    ], "PAGE");
    if (page.ordinal !== pageIndex + 1 || page.format !== "NDJSON_PAGE_SUMMARY") stop("NDJSON_PAGE_ORDER_INVALID", "REJECT");
    completionTrue(page, "complete", "PAGE_INCOMPLETE");
    exactTrue(page, "chronological", "PAGE_NOT_CHRONOLOGICAL");
    const pageCommitment = opaque(page.pageCommitment, "PAGE_COMMITMENT_INVALID");
    if (context.pageCommitments.has(pageCommitment)) stop("DUPLICATE_PAGE_COMMITMENT", "REJECT");
    context.pageCommitments.add(pageCommitment);
    if (pageIndex === 0) {
      if (page.previousPageCommitment !== null) stop("FIRST_PAGE_PREDECESSOR_INVALID", "REJECT");
      firstPageCommitment = pageCommitment;
    } else if (page.previousPageCommitment !== previousPageCommitment) stop("PAGE_CHAIN_BROKEN", "REJECT");
    previousPageCommitment = pageCommitment;
    expectedCursor = validateContinuationProof(
      page.continuationProof,
      pageCommitment,
      expectedCursor,
      pageIndex === pages.length - 1,
      authorityState,
      context
    );

    const boundary = requireExact(page.boundary, [
      "startBlock", "endBlock", "previousHeaderCommitment", "terminalHeaderCommitment"
    ], "PAGE_BOUNDARY");
    const pageStart = uint(boundary.startBlock, "PAGE_START_INVALID");
    const pageEnd = uint(boundary.endBlock, "PAGE_END_INVALID");
    if (pageStart !== expectedBlock || pageEnd < pageStart || pageEnd > authorityState.range.end) stop("PAGE_BOUNDARY_DISCONTINUITY", "REJECT");
    if (boundary.previousHeaderCommitment !== expectedParent) stop("PAGE_PARENT_BOUNDARY_MISMATCH", "REJECT");
    if (!Array.isArray(page.headers) || page.headers.length === 0) stop("PAGE_HEADERS_MISSING");
    if (BigInt(page.headers.length) !== pageEnd - pageStart + 1n) stop("PAGE_HEADER_COUNT_MISMATCH", "REJECT");
    const headerByNumber = new Map();
    for (const header of page.headers) {
      requireExact(header, ["number", "headerCommitment", "parentHeaderCommitment", "canonical", "finalized"], "HEADER");
      const number = uint(header.number, "HEADER_NUMBER_INVALID");
      if (number !== expectedBlock) stop("HEADER_NUMBER_DISCONTINUITY", "REJECT");
      exactTrue(header, "canonical", "HEADER_NOT_CANONICAL");
      exactTrue(header, "finalized", "HEADER_NOT_FINALIZED");
      const commitment = opaque(header.headerCommitment, "HEADER_COMMITMENT_INVALID");
      if (header.parentHeaderCommitment !== expectedParent) stop("CANONICAL_PARENT_CONTINUITY_BROKEN", "REJECT");
      if (context.headerCommitments.has(commitment)) stop("DUPLICATE_HEADER_COMMITMENT", "REJECT");
      if (headerByNumber.has(number.toString())) stop("DUPLICATE_HEADER", "REJECT");
      context.headerCommitments.add(commitment);
      headerByNumber.set(number.toString(), commitment);
      expectedParent = commitment;
      expectedBlock += 1n;
    }
    if (boundary.terminalHeaderCommitment !== expectedParent) stop("PAGE_TERMINAL_BOUNDARY_MISMATCH", "REJECT");
    if (!Array.isArray(page.events)) stop("PAGE_EVENTS_MISSING");
    totalEvents += page.events.length;
    if (totalEvents > MAX_CANDIDATES) stop("CANDIDATE_CAP_EXCEEDED", "REJECT");
    for (const event of page.events) validateEvent(event, headerByNumber, context);
  }

  if (totalEvents !== preflight.eventCount) stop("EVENT_COUNT_PREFLIGHT_MISMATCH", "REJECT");
  if (expectedCursor !== null) stop("TERMINAL_CURSOR_NOT_EXHAUSTED");
  if (expectedBlock !== authorityState.range.end + 1n) stop("RANGE_TERMINAL_BLOCK_MISMATCH", "REJECT");
  if (pageState.firstPageCommitment !== firstPageCommitment || pageState.lastPageCommitment !== previousPageCommitment) {
    stop("PAGE_STATE_BOUNDARY_MISMATCH", "REJECT");
  }
  return { count: context.candidates.size, terminalHeaderCommitment: expectedParent };
}

function validatePageState(input, authorityState) {
  const state = requireExact(input.pageState, [
    "format", "pageCount", "complete", "firstPageCommitment", "lastPageCommitment", "pageSetCommitment",
    "queryFilterCommitment", "priorCheckpointCommitment", "initialCursorCommitment", "cursorChainCommitment",
    "terminalExhaustionCommitment"
  ], "PAGE_STATE");
  if (state.format !== "CHRONOLOGICAL_NDJSON_PAGE_SUMMARIES") stop("PAGE_STATE_FORMAT_INVALID", "REJECT");
  if (!Number.isSafeInteger(state.pageCount) || state.pageCount < 1 || state.pageCount > MAX_PAGES) stop("PAGE_STATE_COUNT_INVALID", "REJECT");
  completionTrue(state, "complete", "PAGE_STATE_INCOMPLETE");
  opaque(state.firstPageCommitment, "FIRST_PAGE_COMMITMENT_INVALID");
  opaque(state.lastPageCommitment, "LAST_PAGE_COMMITMENT_INVALID");
  if (state.pageSetCommitment !== authorityState.pageSetCommitment
      || state.queryFilterCommitment !== REVIEWED_FIXTURE_AUTHORITY.queryFilterCommitment
      || state.priorCheckpointCommitment !== REVIEWED_FIXTURE_AUTHORITY.priorCheckpointCommitment
      || state.initialCursorCommitment !== REVIEWED_FIXTURE_AUTHORITY.initialCursorCommitment
      || state.cursorChainCommitment !== REVIEWED_FIXTURE_AUTHORITY.cursorChainCommitment
      || state.terminalExhaustionCommitment !== authorityState.terminalExhaustion.proofCommitment) {
    stop("PAGE_SET_BINDING_MISMATCH", "REJECT");
  }
  return state;
}

function validateTerminal(authorityState, pagesState) {
  const terminal = requireExact(authorityState.authority.terminalRecheck, [
    "complete", "finalized", "canonical", "exact", "blockNumber", "headerCommitment", "rangeCommitment",
    "pageSetCommitment", "queryFilterCommitment", "priorCheckpointCommitment", "cursorChainCommitment",
    "terminalExhaustionCommitment", "observerCommitments"
  ], "TERMINAL_RECHECK");
  completionTrue(terminal, "complete", "TERMINAL_RECHECK_INCOMPLETE");
  exactTrue(terminal, "finalized", "TERMINAL_RECHECK_NOT_FINALIZED");
  exactTrue(terminal, "canonical", "TERMINAL_RECHECK_NOT_CANONICAL");
  exactTrue(terminal, "exact", "TERMINAL_RECHECK_NOT_EXACT");
  if (uint(terminal.blockNumber, "TERMINAL_BLOCK_INVALID") !== authorityState.range.end
      || terminal.headerCommitment !== pagesState.terminalHeaderCommitment
      || terminal.headerCommitment !== authorityState.observers.terminalHeaderCommitment
      || terminal.rangeCommitment !== authorityState.range.rangeCommitment
      || terminal.pageSetCommitment !== authorityState.pageSetCommitment
      || terminal.queryFilterCommitment !== REVIEWED_FIXTURE_AUTHORITY.queryFilterCommitment
      || terminal.priorCheckpointCommitment !== REVIEWED_FIXTURE_AUTHORITY.priorCheckpointCommitment
      || terminal.cursorChainCommitment !== REVIEWED_FIXTURE_AUTHORITY.cursorChainCommitment
      || terminal.terminalExhaustionCommitment !== authorityState.terminalExhaustion.proofCommitment) {
    stop("TERMINAL_RECHECK_MISMATCH", "REJECT");
  }
  if (!Array.isArray(terminal.observerCommitments) || terminal.observerCommitments.length !== 2
      || new Set(terminal.observerCommitments).size !== 2
      || terminal.observerCommitments.some((item) => !authorityState.observers.observations.has(item))) {
    stop("TERMINAL_OBSERVER_BINDING_MISMATCH", "REJECT");
  }
}

function validateInjectedInput(input, preflight) {
  requireExact(input, ["authority", "pageState", "pages"], "INPUT");
  const authorityState = validateAuthority(input);
  const pageState = validatePageState(input, authorityState);
  const pagesState = validatePages(input, pageState, authorityState, preflight);
  validateTerminal(authorityState, pagesState);
  return pagesState.count;
}

function buildDeltaWatcher(input) {
  try {
    const preflight = preflightCaps(input);
    assertSanitized(input);
    const count = validateInjectedInput(input, preflight);
    return makeResult(count === 0 ? "HOLD_NO_NEW_VAULT" : "READY_FOR_BOUND_VAULT_STATE_READ", count, true, COVERAGE);
  } catch (error) {
    if (error instanceof WatcherError) return makeResult(error.kind === "REJECT" ? "REJECT" : "INCOMPLETE");
    return makeResult("REJECT");
  }
}

module.exports = Object.freeze({
  CHAIN_ID,
  OFFICIAL_SOURCE_PIN,
  MAX_CANDIDATES,
  MAX_PAGES,
  MAX_RANGE_BLOCKS,
  MAX_INPUT_BYTES,
  MAX_INPUT_DEPTH,
  MAX_INPUT_NODES,
  COVERAGE,
  INCOMPLETE_COVERAGE,
  STATUSES,
  REVIEWED_FIXTURE_AUTHORITY,
  WatcherError,
  assertSanitized,
  validateResult,
  buildDeltaWatcher,
  buildWatcher: buildDeltaWatcher,
  runWatcher: buildDeltaWatcher
});
