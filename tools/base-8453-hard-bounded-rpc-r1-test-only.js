"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { TextDecoder } = require("util");

const POLICY = Object.freeze({
  chainId: 8453,
  inventoryBytes: 1024 * 1024,
  inventoryRecords: 256,
  candidates: 8,
  candidatesPerFamily: 2,
  concurrency: 4,
  preflightMs: 45_000,
  calls: 40,
  requestBytes: 16 * 1024,
  responseBytes: 128 * 1024,
  runtimeBytes: 64 * 1024,
  requestDeadlineMs: 5_000,
  cancellationSettleMs: 1_000,
  retries: 0,
  selectedPerObserverMs: 2_600,
  selectedTotalMs: 5_200,
});

const ERROR = Object.freeze({
  inventory: "E_BASE8453_RPC_INVENTORY_INVALID",
  preflight: "E_BASE8453_RPC_PREFLIGHT_FAILED",
  budget: "E_BASE8453_RPC_BUDGET_EXCEEDED",
  deadline: "E_BASE8453_RPC_DEADLINE",
  nonsettlement: "E_BASE8453_RPC_CANCELLATION_UNSETTLED",
  body: "E_BASE8453_RPC_BODY_LIMIT",
  response: "E_BASE8453_RPC_RESPONSE_INVALID",
});

const FAMILY_RULES = Object.freeze([
  ["alchemy.com", "alchemy"],
  ["infura.io", "infura"],
  ["quiknode.pro", "quicknode"],
  ["quicknode.com", "quicknode"],
  ["drpc.org", "drpc"],
  ["blastapi.io", "blastapi"],
  ["chainstack.com", "chainstack"],
  ["nodereal.io", "nodereal"],
  ["ankr.com", "ankr"],
  ["allnodes.com", "allnodes"],
  ["onfinality.io", "onfinality"],
  ["publicnode.com", "publicnode"],
  ["1rpc.io", "1rpc"],
  ["llamarpc.com", "llamarpc"],
  ["blockpi.network", "blockpi"],
  ["thirdweb.com", "thirdweb"],
  ["tenderly.co", "tenderly"],
  ["pokt.network", "pokt"],
]);
const BASE_DEPLOYMENT_AUTHORITY_PATH = path.resolve(__dirname, "..", "reports/raw/fast/eulerswap-v2-base-deployment-authority.json");
const BASE_DEPLOYMENT_AUTHORITY_SHA256 = "2126e100339822bdca96fdbeedc55eb7c59bf2588a4ca9e67e39120841bfc160";
const PROBE = loadFixedProbeAuthority();
const TRAILING_URL_PUNCTUATION = new Set([".", ",", ";", ":", ")", "]", "}", ">", "\"", "'"]);
// Only fixed labels and bounded integer counters may leave the test-only preflight.
const DIAGNOSTIC_REASONS = Object.freeze([
  "FETCH_EXCEPTION", "HTTP_STATUS_OR_REDIRECT", "RESPONSE_ENCODING", "RESPONSE_MIME",
  "RESPONSE_SHAPE", "RESPONSE_PARSE", "JSONRPC_ERROR_ENVELOPE",
  "CHAIN_MISMATCH", "HEADER_INVALID", "PROBE_RUNTIME_EMPTY", "PROBE_RUNTIME_INVALID",
  "PROBE_CALL_RESULT_MISMATCH", "TERMINAL_PIN_MISMATCH", "CANDIDATE_RESPONSE_INVALID",
  "BUDGET", "DEADLINE", "CANCELLATION_UNSETTLED", "BODY_LIMIT",
  "PAIR_SAME_FAMILY", "PAIR_PIN_DISAGREEMENT", "PAIR_FINALIZED_HEIGHT_DIFFERENCE",
  "PAIR_SAME_HEIGHT_IDENTITY_CONFLICT", "PAIR_OBSERVER_LATENCY", "PAIR_COMBINED_LATENCY",
]);

function countDiagnostic(state, reason) {
  const counts = state.diagnostics;
  if (counts && Object.hasOwn(counts.reasons, reason)) {
    counts.reasons[reason] = Math.min(POLICY.calls + POLICY.candidates ** 2, counts.reasons[reason] + 1);
  }
}

function diagnosticSnapshot(counts) {
  return freeze({
    candidateCount: counts.candidateCount,
    qualifiedCandidateCount: counts.qualifiedCandidateCount,
    requestsByStage: { ...counts.requestsByStage },
    reasons: { ...counts.reasons },
  });
}

function newDiagnostics() {
  return {
    candidateCount: 0,
    qualifiedCandidateCount: 0,
    requestsByStage: { chain: 0, finalized: 0, code: 0, call: 0, terminal: 0 },
    reasons: Object.fromEntries(DIAGNOSTIC_REASONS.map((reason) => [reason, 0])),
  };
}

function fail(code) {
  const error = new Error(code);
  error.code = code;
  error.stack = code;
  throw error;
}

function freeze(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) freeze(child);
  }
  return Object.freeze(value);
}

function loadFixedProbeAuthority() {
  try {
    const bytes = fs.readFileSync(BASE_DEPLOYMENT_AUTHORITY_PATH);
    if (bytes.length > 64 * 1024 || crypto.createHash("sha256").update(bytes).digest("hex") !== BASE_DEPLOYMENT_AUTHORITY_SHA256) {
      fail(ERROR.preflight);
    }
    const authority = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const factory = authority?.deployments?.factory;
    const implementation = authority?.deployments?.implementation;
    if (
      authority.schema !== "eulerswap-v2-base-deployment-authority-r1"
      || authority.status !== "OFFICIAL_DEPLOYMENT_AUTHORITY_ONLY"
      || authority.chainId !== POLICY.chainId
      || authority.eulerSwapSource?.commit !== "81cf6dc988468fd56f690e6bc0e338a5be02d034"
      || factory?.contractName !== "EulerSwapFactory"
      || implementation?.contractName !== "EulerSwap"
      || !/^0x[0-9A-Fa-f]{40}$/.test(factory.address || "")
      || !/^0x[0-9A-Fa-f]{40}$/.test(implementation.address || "")
    ) fail(ERROR.preflight);
    return Object.freeze({
      address: factory.address.toLowerCase(),
      callData: "0xdbecb208",
      expectedCallResult: `0x${"00".repeat(12)}${implementation.address.slice(2).toLowerCase()}`,
    });
  } catch (error) {
    if (error?.code === ERROR.preflight) throw error;
    fail(ERROR.preflight);
  }
}

function classifyAuthenticatedFamily(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_error) {
    fail(ERROR.inventory);
  }
  if (parsed.protocol !== "https:" || parsed.hash !== "") fail(ERROR.inventory);
  const host = parsed.hostname.toLowerCase();
  const matchingFamilies = new Set(FAMILY_RULES
    .filter(([domain]) => host === domain || host.endsWith(`.${domain}`))
    .map(([, family]) => family));
  if (matchingFamilies.size > 1) fail(ERROR.inventory);
  const authenticated = parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || (parsed.pathname !== "" && parsed.pathname !== "/");
  return { endpoint: parsed.href, family: matchingFamilies.size === 1 && authenticated ? [...matchingFamilies][0] : null };
}

function parseInventory(inventoryText) {
  if (typeof inventoryText !== "string" || Buffer.byteLength(inventoryText, "utf8") > POLICY.inventoryBytes) {
    fail(ERROR.inventory);
  }
  const lines = inventoryText.split(/\r?\n/);
  const catalogMode = lines.some((rawLine) => {
    const line = rawLine.trim();
    if (line === "") return false;
    if (line.startsWith("#")) return hasBaseScope(line);
    const tokens = line.match(/https:\/\/\S+/g) || [];
    if (tokens.length !== 1) return tokens.length === 0 || tokens.length > 1;
    const assignment = /^[A-Z][A-Z0-9_]{0,127}=(https:\/\/\S+)$/.test(line);
    return !assignment && line !== tokens[0];
  });
  const records = [];
  const precedingLabels = [];
  const assignmentKeys = new Set();
  const endpointClassifications = new Map();
  const eligibleEndpoints = new Set();
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === "") continue;
    if (/^[\[{]/.test(line)) fail(ERROR.inventory);
    const urlTokens = line.match(/https:\/\/\S+/g) || [];
    if (urlTokens.length > 1) fail(ERROR.inventory);
    if (urlTokens.length === 0) {
      const baseScoped = hasBaseScope(line) || precedingLabels.some(hasBaseScope);
      if (
        /^[A-Za-z0-9_]{1,256}\s*=/.test(line)
        || /^authorization\s*:/i.test(line)
        || (/\bhttps?:\/\//i.test(line) && baseScoped)
        || /^\S+:\/\//.test(line)
      ) fail(ERROR.inventory);
      precedingLabels.push(line);
      if (precedingLabels.length > 3) precedingLabels.shift();
      continue;
    }

    const token = urlTokens[0];
    let endpoint = token;
    while (endpoint.length > 0 && TRAILING_URL_PUNCTUATION.has(endpoint[endpoint.length - 1])) {
      endpoint = endpoint.slice(0, -1);
    }
    if (endpoint === "") fail(ERROR.inventory);
    const assignment = /^[A-Z][A-Z0-9_]{0,127}=(https:\/\/\S+)$/.exec(line);
    const rawEndpoint = line === token;
    if (assignment || (rawEndpoint && !catalogMode)) {
      if (assignment && assignment[1] !== endpoint) fail(ERROR.inventory);
      if (assignment) {
        const assignmentKey = line.slice(0, line.indexOf("="));
        if (assignmentKeys.has(assignmentKey)) fail(ERROR.inventory);
        assignmentKeys.add(assignmentKey);
      }
      admitEligibleRecord(endpoint, records, endpointClassifications, eligibleEndpoints);
    } else {
      if (/^[A-Za-z0-9_]{1,256}\s*=/.test(line)) fail(ERROR.inventory);
      const lineWithoutUrl = line.replace(token, " ");
      const baseScoped = hasBaseScope(lineWithoutUrl) || precedingLabels.some(hasBaseScope);
      if (!baseScoped) continue;
      admitEligibleRecord(endpoint, records, endpointClassifications, eligibleEndpoints);
    }
    if (records.length > POLICY.inventoryRecords) fail(ERROR.inventory);
  }
  if (records.length === 0) fail(ERROR.inventory);
  const byFamily = new Map();
  for (const record of records) {
    if (!byFamily.has(record.family)) byFamily.set(record.family, []);
    byFamily.get(record.family).push(record);
  }
  const candidates = [];
  for (let round = 0; round < POLICY.candidatesPerFamily && candidates.length < POLICY.candidates; round += 1) {
    for (const familyRecords of byFamily.values()) {
      if (familyRecords[round] && candidates.length < POLICY.candidates) candidates.push(familyRecords[round]);
    }
  }
  if (new Set(candidates.map((record) => record.family)).size < 2) fail(ERROR.inventory);
  return candidates;
}

function hasBaseScope(value) {
  const label = value
    .replace(/^\s*(?:[#>*-]+\s*)+/, "")
    .replace(/[\s:;,.|/\\()[\]{}=-]+$/g, "")
    .trim();
  return /^(?:Base(?:\s+Mainnet)?(?:\s+(?:RPC|endpoint|endpoints|provider|providers))?|(?:Chain|Network)(?:\s+(?:ID|Name))?\s*[:=-]?\s*(?:Base|8453)(?:\s+(?:RPC|endpoint|endpoints|provider|providers))?|Chain\s+ID\s+8453(?:\s+(?:RPC|endpoint|endpoints|provider|providers))?|8453)$/i.test(label);
}

function admitEligibleRecord(endpoint, records, endpointClassifications, eligibleEndpoints) {
  const classified = classifyAuthenticatedFamily(endpoint);
  const classification = classified.family || "INELIGIBLE";
  const previous = endpointClassifications.get(classified.endpoint);
  if (previous !== undefined && previous !== classification) fail(ERROR.inventory);
  endpointClassifications.set(classified.endpoint, classification);
  if (!classified.family || eligibleEndpoints.has(classified.endpoint)) return;
  eligibleEndpoints.add(classified.endpoint);
  records.push(classified);
}

function exactDataObject(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== keys.length || !keys.every((key) => names.includes(key))) return false;
  return names.every((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return descriptor && descriptor.enumerable && "value" in descriptor;
  });
}

function cancellationWait(promises, settleMs) {
  return Promise.race([
    Promise.allSettled(promises).then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), settleMs)),
  ]);
}

function createCancellationCoordinator(settleMs) {
  const active = new Set();
  let cancellationPromise = null;
  const coordinator = {
    cancelled: false,
    track(record) {
      active.add(record);
      if (coordinator.cancelled) record.cancel();
    },
    complete(record) { active.delete(record); },
    async cancelAll() {
      if (cancellationPromise) return cancellationPromise;
      coordinator.cancelled = true;
      cancellationPromise = (async () => {
        const records = [...active];
        for (const record of records) record.cancel();
        const settled = await cancellationWait(records.map((record) => record.wait()), settleMs);
        if (!settled || records.some((record) => !record.isSettled())) fail(ERROR.nonsettlement);
      })();
      return cancellationPromise;
    },
    assertIdle() {
      if (active.size !== 0) fail(ERROR.nonsettlement);
    },
  };
  return coordinator;
}

async function boundedFetch(state, endpoint, requestBody) {
  const controller = new AbortController();
  let reader = null;
  let cancelRequested = false;
  let cancelStarted = false;
  let cancelPromise = Promise.resolve();
  let operationSettled = false;
  let fetchException = false;
  let deadlineTimer;
  let deadlineResolve;
  const deadline = new Promise((resolve) => { deadlineResolve = resolve; });
  deadlineTimer = setTimeout(() => deadlineResolve("deadline"), state.timing.requestDeadlineMs);
  const cancelBody = () => {
    if (!reader || cancelStarted || typeof reader.cancel !== "function") return;
    cancelStarted = true;
    try { cancelPromise = Promise.resolve(reader.cancel()).catch(() => undefined); } catch (_error) { cancelPromise = Promise.resolve(); }
  };
  let guarded;
  const record = {
    cancel() {
      cancelRequested = true;
      controller.abort();
      cancelBody();
    },
    async wait() {
      await guarded;
      await cancelPromise;
    },
    isSettled() { return operationSettled; },
  };
  const operation = (async () => {
    let response;
    try { response = await state.fetchImpl(endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "accept-encoding": "identity",
      },
      body: requestBody,
      signal: controller.signal,
    }); } catch (error) {
      fetchException = true;
      countDiagnostic(state, "FETCH_EXCEPTION");
      throw error;
    }
    if (!response || response.status !== 200 || response.redirected === true) {
      countDiagnostic(state, "HTTP_STATUS_OR_REDIRECT");
      fail(ERROR.response);
    }
    const declared = response.headers?.get?.("content-length");
    if (declared !== null && declared !== undefined) {
      if (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > POLICY.responseBytes) fail(ERROR.body);
    }
    const encoding = response.headers?.get?.("content-encoding");
    if (encoding && encoding.toLowerCase() !== "identity") {
      countDiagnostic(state, "RESPONSE_ENCODING");
      fail(ERROR.response);
    }
    const contentType = response.headers?.get?.("content-type") || "";
    if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
      countDiagnostic(state, "RESPONSE_MIME");
      fail(ERROR.response);
    }
    if (!response.body || typeof response.body.getReader !== "function") {
      countDiagnostic(state, "RESPONSE_SHAPE");
      fail(ERROR.response);
    }
    reader = response.body.getReader();
    if (cancelRequested) cancelBody();
    const chunks = [];
    let total = 0;
    while (true) {
      const part = await reader.read();
      if (!part || typeof part.done !== "boolean") { countDiagnostic(state, "RESPONSE_SHAPE"); fail(ERROR.response); }
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) { countDiagnostic(state, "RESPONSE_SHAPE"); fail(ERROR.response); }
      total += part.value.byteLength;
      if (total > POLICY.responseBytes) fail(ERROR.body);
      chunks.push(Buffer.from(part.value));
    }
    return Buffer.concat(chunks, total);
  })();
  guarded = operation.then(
    (value) => ({ state: "fulfilled", value }),
    (error) => ({ state: "rejected", error }),
  );
  state.coordinator.track(record);
  guarded.then(async () => {
    operationSettled = true;
    await cancelPromise;
    state.coordinator.complete(record);
  });
  const first = await Promise.race([guarded, deadline]);
  if (first === "deadline") {
    clearTimeout(deadlineTimer);
    await state.coordinator.cancelAll();
    fail(ERROR.deadline);
  }
  clearTimeout(deadlineTimer);
  if (first.state === "rejected") {
    if (first.error?.code && Object.values(ERROR).includes(first.error.code)) throw first.error;
    if (!fetchException) countDiagnostic(state, "RESPONSE_SHAPE");
    fail(ERROR.response);
  }
  return first.value;
}

function parseRpcResponse(bytes, expectedId, state) {
  let text;
  let value;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch (_error) {
    countDiagnostic(state, "RESPONSE_PARSE");
    fail(ERROR.response);
  }
  if (exactDataObject(value, ["jsonrpc", "id", "error"]) && value.jsonrpc === "2.0" && value.id === expectedId) {
    countDiagnostic(state, "JSONRPC_ERROR_ENVELOPE");
  } else if (!exactDataObject(value, ["jsonrpc", "id", "result"]) || value.jsonrpc !== "2.0" || value.id !== expectedId) {
    countDiagnostic(state, "RESPONSE_SHAPE");
  }
  if (!exactDataObject(value, ["jsonrpc", "id", "result"]) || value.jsonrpc !== "2.0" || value.id !== expectedId) {
    fail(ERROR.response);
  }
  return value.result;
}

async function rpc(state, candidate, method, params) {
  if (state.coordinator.cancelled) fail(ERROR.deadline);
  if (state.calls >= POLICY.calls) fail(ERROR.budget);
  state.calls += 1;
  if (state.diagnostics) {
    const stages = { eth_chainId: "chain", eth_getBlockByNumber: "finalized", eth_getCode: "code", eth_call: "call", eth_getBlockByHash: "terminal" };
    state.diagnostics.requestsByStage[stages[method]] += 1;
  }
  const id = state.calls;
  const requestBody = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  if (Buffer.byteLength(requestBody, "utf8") > POLICY.requestBytes) fail(ERROR.budget);
  const bytes = await boundedFetch(state, candidate.endpoint, requestBody);
  return parseRpcResponse(bytes, id, state);
}

function strictQuantity(value) {
  return typeof value === "string" && /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value);
}

function strictHash(value) {
  return typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value);
}

function strictRuntime(value) {
  return typeof value === "string"
    && /^0x(?:[0-9a-f]{2})*$/.test(value)
    && (value.length - 2) / 2 <= POLICY.runtimeBytes;
}

function strictHeader(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && strictQuantity(value.number)
    && strictHash(value.hash)
    && strictHash(value.parentHash)
    && strictHash(value.stateRoot)
    && strictQuantity(value.timestamp);
}

async function qualifyCandidate(state, candidate) {
  const started = process.hrtime.bigint();
  try {
    const chainId = await rpc(state, candidate, "eth_chainId", []);
    if (chainId !== "0x2105") { countDiagnostic(state, "CHAIN_MISMATCH"); return null; }
    const header = await rpc(state, candidate, "eth_getBlockByNumber", ["finalized", false]);
    if (!strictHeader(header)) { countDiagnostic(state, "HEADER_INVALID"); return null; }
    const pin = { blockHash: header.hash, requireCanonical: true };
    const code = await rpc(state, candidate, "eth_getCode", [PROBE.address, pin]);
    if (!strictRuntime(code) || code === "0x") {
      countDiagnostic(state, code === "0x" ? "PROBE_RUNTIME_EMPTY" : "PROBE_RUNTIME_INVALID");
      return null;
    }
    const callResult = await rpc(state, candidate, "eth_call", [{ to: PROBE.address, data: PROBE.callData }, pin]);
    if (callResult !== PROBE.expectedCallResult) { countDiagnostic(state, "PROBE_CALL_RESULT_MISMATCH"); return null; }
    const reread = await rpc(state, candidate, "eth_getBlockByHash", [header.hash, false]);
    if (!strictHeader(reread) || reread.number !== header.number || reread.hash !== header.hash || reread.stateRoot !== header.stateRoot) {
      countDiagnostic(state, "TERMINAL_PIN_MISMATCH"); return null;
    }
    return {
      candidate,
      pin: `${header.number}|${header.hash}|${header.stateRoot}`,
      elapsedMs: Number(process.hrtime.bigint() - started) / 1_000_000,
    };
  } catch (error) {
    if ([ERROR.budget, ERROR.deadline, ERROR.nonsettlement, ERROR.body].includes(error?.code)) throw error;
    if (error?.code !== ERROR.response) countDiagnostic(state, "CANDIDATE_RESPONSE_INVALID");
    return null;
  }
}

async function qualifyAll(state, candidates) {
  const results = new Array(candidates.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= candidates.length) return;
      results[index] = await qualifyCandidate(state, candidates[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(POLICY.concurrency, candidates.length) }, worker));
  return results.filter(Boolean);
}

async function runHardBoundedPreflightInternal({ inventoryText, fetchImpl, testTiming }, diagnostics) {
  if (typeof fetchImpl !== "function") fail(ERROR.preflight);
  const timing = {
    preflightMs: testTiming?.preflightMs ?? POLICY.preflightMs,
    requestDeadlineMs: testTiming?.requestDeadlineMs ?? POLICY.requestDeadlineMs,
    cancellationSettleMs: testTiming?.cancellationSettleMs ?? POLICY.cancellationSettleMs,
  };
  if (
    !Object.values(timing).every((value) => Number.isInteger(value) && value > 0)
    || timing.preflightMs > POLICY.preflightMs
    || timing.requestDeadlineMs > POLICY.requestDeadlineMs
    || timing.cancellationSettleMs > POLICY.cancellationSettleMs
  ) fail(ERROR.preflight);
  const candidates = parseInventory(inventoryText);
  if (diagnostics) diagnostics.candidateCount = candidates.length;
  const coordinator = createCancellationCoordinator(timing.cancellationSettleMs);
  const state = { calls: 0, fetchImpl, coordinator, timing, diagnostics };
  const operation = (async () => {
    const qualified = await qualifyAll(state, candidates);
    if (diagnostics) diagnostics.qualifiedCandidateCount = qualified.length;
    for (let left = 0; left < qualified.length; left += 1) {
      for (let right = left + 1; right < qualified.length; right += 1) {
        if (
          qualified[left].candidate.family !== qualified[right].candidate.family
          && qualified[left].pin === qualified[right].pin
          && qualified[left].elapsedMs <= POLICY.selectedPerObserverMs
          && qualified[right].elapsedMs <= POLICY.selectedPerObserverMs
          && qualified[left].elapsedMs + qualified[right].elapsedMs <= POLICY.selectedTotalMs
        ) {
          coordinator.assertIdle();
          return {
            selected: [qualified[left].candidate, qualified[right].candidate],
            calls: state.calls,
          };
        }
        if (diagnostics) {
          if (qualified[left].candidate.family === qualified[right].candidate.family) countDiagnostic(state, "PAIR_SAME_FAMILY");
          else if (qualified[left].pin !== qualified[right].pin) {
            countDiagnostic(state, "PAIR_PIN_DISAGREEMENT");
            // Pin disagreement takes priority over latency; this does not attest latency passed.
            const leftHeight = qualified[left].pin.split("|", 1)[0];
            const rightHeight = qualified[right].pin.split("|", 1)[0];
            countDiagnostic(state, leftHeight !== rightHeight
              ? "PAIR_FINALIZED_HEIGHT_DIFFERENCE" : "PAIR_SAME_HEIGHT_IDENTITY_CONFLICT");
          }
          else if (qualified[left].elapsedMs > POLICY.selectedPerObserverMs || qualified[right].elapsedMs > POLICY.selectedPerObserverMs) countDiagnostic(state, "PAIR_OBSERVER_LATENCY");
          else countDiagnostic(state, "PAIR_COMBINED_LATENCY");
        }
      }
    }
    fail(ERROR.preflight);
  })();
  const guarded = operation.then(
    (value) => ({ state: "fulfilled", value }),
    (error) => ({ state: "rejected", error }),
  );
  let preflightTimer;
  const timeout = new Promise((resolve) => { preflightTimer = setTimeout(() => resolve("deadline"), timing.preflightMs); });
  try {
    const first = await Promise.race([guarded, timeout]);
    if (first === "deadline") {
      await coordinator.cancelAll();
      fail(ERROR.deadline);
    }
    if (first.state === "rejected") {
      await coordinator.cancelAll();
      if (first.error?.code && Object.values(ERROR).includes(first.error.code)) throw first.error;
      fail(ERROR.preflight);
    }
    coordinator.assertIdle();
    return first.value;
  } finally {
    clearTimeout(preflightTimer);
  }
}

async function runHardBoundedPreflight(options) {
  if (options?.collectDiagnostics !== true) return runHardBoundedPreflightInternal(options);
  const diagnostics = newDiagnostics();
  try {
    const result = await runHardBoundedPreflightInternal(options, diagnostics);
    const snapshot = diagnosticSnapshot(diagnostics);
    // Selected endpoints remain available in-process, but are sensitive and must not enter JSON.
    const optInResult = { ...result, diagnostics: snapshot };
    Object.defineProperty(optInResult, "toJSON", {
      enumerable: false,
      value: () => ({ calls: result.calls, diagnostics: snapshot }),
    });
    return Object.freeze(optInResult);
  } catch (error) {
    const code = Object.values(ERROR).includes(error?.code) ? error.code : ERROR.preflight;
    const reason = {
      [ERROR.budget]: "BUDGET", [ERROR.deadline]: "DEADLINE",
      [ERROR.nonsettlement]: "CANCELLATION_UNSETTLED", [ERROR.body]: "BODY_LIMIT",
    }[code];
    if (reason) countDiagnostic({ diagnostics }, reason);
    // Never reuse a provider-supplied Error: its message, stack or custom fields may contain secrets.
    const sanitized = new Error(code);
    sanitized.code = code;
    sanitized.stack = code;
    sanitized.diagnostics = diagnosticSnapshot(diagnostics);
    throw sanitized;
  }
}

module.exports = Object.freeze({ POLICY, ERROR, runHardBoundedPreflightForTest: runHardBoundedPreflight });
