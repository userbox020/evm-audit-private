#!/usr/bin/env node
"use strict";

// Admission only. Import and --check deliberately do not load the RPC libraries.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const WORKSPACE = path.resolve(__dirname, "..");
const SCHEMA = "aave-v4-base-admission-scope/v1";
const IDENTITY = Object.freeze({ moduleName: "AaveV4Base", version: "4.74.1",
  commit: "3cd68031dad4e2fe0c8e8610e747b6083c2fc561",
  moduleSha256: "4f8dac4012e70c59e351167e4933af10630cd3ca70f569cbb15b088ba52fa059" });
const BUDGET = Object.freeze({ maxCandidates: 16, maxRequests: 12000, maxMs: 240000,
  timeoutMs: 10000, maxBytes: 4 * 1024 * 1024, concurrency: 4, maxPinAgeMs: 1800000 });
const METHODS = new Set(["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_getStorageAt", "eth_call", "eth_getLogs"]);
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const HASH = /^0x[0-9a-f]{64}$/i;
const HEX = /^0x(?:[0-9a-f]{2})*$/i;
const DIGEST = /^[0-9a-f]{64}$/;
const ZERO = "0x" + "0".repeat(40);
const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const SAFE_FAILURES = new Set(["CALL_EXCEPTION", "RPC_RATE_LIMITED", "RPC_HTTP_REJECTED", "RPC_RESPONSE_TOO_LARGE",
  "RPC_INVALID_JSON", "RPC_INVALID_ENVELOPE", "RPC_REJECTED", "RPC_TRANSPORT", "LOG_RANGE_LIMIT",
  "COLLECTION_DEADLINE", "COLLECTION_BUDGET_EXHAUSTED", "TERMINAL_PIN_MISMATCH", "PIN_STALE_OR_FUTURE",
  "INVALID_CHAIN_ID", "PREFLIGHT_FAILED", "RPC_INVALID_RESULT", "RPC_INVALID_HEADER",
  "INDEPENDENT_FAMILIES_UNAVAILABLE", "COMMON_PIN_UNAVAILABLE", "TWO_FAMILIES_UNAVAILABLE",
  "PIN_CONSENSUS_UNAVAILABLE", "STATE_CONSENSUS_UNAVAILABLE", "NETWORK_CALL_CAP",
  "BASE_ROLE_EVIDENCE_INVALID", "BASE_ROLE_BINDING_MISMATCH", "BASE_DEPLOYMENT_SEMANTICS_UNRESOLVED"]);

class AdmissionError extends Error {
  constructor(code) { super(code); this.name = "AdmissionError"; this.code = code; }
}
function fail(code) { throw new AdmissionError(code); }
function errorCode(error, fallback = "ADMISSION_FAILED") {
  return error instanceof AdmissionError || SAFE_FAILURES.has(error?.code) ? error.code : fallback;
}
function sanitizedCallRevert() {
  // The pinned adapter deliberately recognizes this class, not arbitrary raw
  // provider errors. Lazy construction preserves import/--check isolation.
  const { CollectionError } = require("./lib/aave-v4-pinned-collection");
  return new CollectionError("CALL_EXCEPTION");
}
function sha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function keys(value, expected, code) {
  if (!object(value) || Object.keys(value).sort().join("|") !== [...expected].sort().join("|")) fail(code);
}
function address(value) {
  if (typeof value !== "string" || !ADDRESS.test(value) || value.toLowerCase() === ZERO) fail("INVALID_ADDRESS");
  return value.toLowerCase();
}
function parseJson(bytes) { try { return JSON.parse(String(bytes)); } catch (_) { fail("INVALID_PUBLIC_JSON"); } }
function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function relativeInside(root, target) {
  const relative = path.relative(root, target);
  return relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}
function forbiddenPath(value) {
  return /(?:^|[\\/])(?:\.env(?:\.[^\\/]*)?|[^\\/]*inventory[^\\/]*|rawlogs?|keys?|secrets?)(?:[\\/]|$)/i.test(value);
}
function containedPath(root, value, io = fs, existing = true) {
  if (typeof value !== "string" || !value || /[\x00-\x1f]/.test(value)) fail("INVALID_LOCAL_PATH");
  const target = path.resolve(root, value);
  if (!relativeInside(root, target)) fail("PATH_OUTSIDE_WORKSPACE");
  // Even an accidentally supplied path must not turn validation into a secret read.
  if (forbiddenPath(path.relative(root, target))) fail("FORBIDDEN_INPUT_PATH");
  let ancestor = target;
  while (!io.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) fail("INVALID_LOCAL_PATH");
    ancestor = parent;
  }
  const realRoot = io.realpathSync(root);
  const realAncestor = io.realpathSync(ancestor);
  if (realAncestor !== realRoot && !relativeInside(realRoot, realAncestor)) fail("PATH_OUTSIDE_WORKSPACE");
  if (forbiddenPath(path.relative(realRoot, realAncestor))) fail("FORBIDDEN_INPUT_PATH");
  if (existing && (!io.existsSync(target) || !io.statSync(target).isFile())) fail("PUBLIC_FILE_MISSING");
  return target;
}
function publicRead(file, io) {
  try {
    if (io.statSync(file).size > 16 * 1024 * 1024) fail("PUBLIC_FILE_TOO_LARGE");
    return Buffer.from(io.readFileSync(file));
  } catch (error) { if (error instanceof AdmissionError) throw error; fail("PUBLIC_FILE_READ_FAILED"); }
}
function sourcifyUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !["sourcify.dev", "repo.sourcify.dev"].includes(url.hostname)
      || url.username || url.password || url.port || (url.search && url.search !== "?fields=all") || url.hash) fail("INVALID_PUBLIC_SOURCE_URL");
    return url.href;
  } catch (_) { fail("INVALID_PUBLIC_SOURCE_URL"); }
}
function moduleAddresses(module) {
  const rows = new Map();
  function visit(value, parts) {
    if (typeof value === "string" && /^0x/i.test(value)) {
      if (!ADDRESS.test(value)) fail("MALFORMED_MODULE_ADDRESS");
      if (value.toLowerCase() !== ZERO) {
        const key = address(value);
        if (!rows.has(key)) rows.set(key, []);
        rows.get(key).push(parts.join("."));
      }
    } else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (!/^[A-Za-z0-9_]+$/.test(key)) fail("INVALID_MODULE_KEY");
        visit(child, [...parts, key]);
      }
    } else if (typeof value !== "number" && typeof value !== "string" && value !== null) fail("INVALID_MODULE_VALUE");
  }
  visit(module, []);
  return rows;
}
function principalProxies(module) {
  const proxies = [
    { role: "HUBS.EQUITIES_HUB", address: module.HUBS?.EQUITIES_HUB },
    { role: "SPOKES.MAG7_SPOKE", address: module.SPOKES?.MAG7_SPOKE },
    { role: "TOKENIZATION_SPOKES.EQUITIES_USDC_TOKENIZATION_SPOKE", address: module.TOKENIZATION_SPOKES?.EQUITIES_USDC_TOKENIZATION_SPOKE },
    { role: "TREASURY_SPOKE", address: module.TREASURY_SPOKE },
  ].map(row => ({ ...row, address: address(row.address) }));
  if (new Set(proxies.map(row => row.address)).size !== 4) fail("AMBIGUOUS_PRINCIPAL_PROXIES");
  return proxies;
}

// Pure, with public bytes and metadata supplied by the caller. The CLI cannot
// override the official identity; identity injection exists for offline fixtures.
function validateScope(scope, { manifest, moduleBytes, sourceBytes = new Map(), identity = IDENTITY } = {}) {
  keys(scope, ["schema", "chainId", "registry", "components", "dependencies", "sources"], "INVALID_SCOPE_SCHEMA");
  if (scope.schema !== SCHEMA || scope.chainId !== 8453) fail("INVALID_SCOPE_CHAIN_OR_SCHEMA");
  keys(scope.registry, ["manifestPath", "modulePath", "moduleName", "version", "commit", "moduleSha256"], "INVALID_REGISTRY_SCHEMA");
  for (const key of ["moduleName", "version", "commit", "moduleSha256"]) {
    if (scope.registry[key] !== identity[key]) fail("REGISTRY_IDENTITY_MISMATCH");
  }
  if (!manifest || manifest.commit !== identity.commit || manifest.packageVersion !== identity.version
    || !Array.isArray(manifest.modules)) fail("MANIFEST_IDENTITY_MISMATCH");
  const entries = manifest.modules.filter(row => row.name === identity.moduleName);
  const bytes = Buffer.from(moduleBytes || "");
  if (entries.length !== 1 || entries[0].chainId !== 8453 || entries[0].sha256 !== identity.moduleSha256
    || entries[0].bytes !== bytes.length || sha256(bytes) !== identity.moduleSha256) fail("MODULE_BINDING_MISMATCH");
  const module = parseJson(bytes);
  if (module.CHAIN_ID !== 8453) fail("MODULE_CHAIN_MISMATCH");
  const declared = moduleAddresses(module);
  const proxies = principalProxies(module);
  for (const name of ["ALL_HUBS", "ALL_SPOKES", "ALL_SPOKES_RAW", "ALL_TOKENIZED_SPOKES"]) {
    if (!Array.isArray(module[name]) || module[name].some(value => !ADDRESS.test(value))) fail("INVALID_MODULE_GROUP");
  }
  if (module.ALL_HUBS.length !== 1 || address(module.ALL_HUBS[0]) !== proxies[0].address) fail("INVALID_BASE_HUB_SET");
  if (!Array.isArray(scope.components) || !Array.isArray(scope.dependencies) || !Array.isArray(scope.sources)) fail("INVALID_SCOPE_ROWS");
  const seen = new Set();
  const components = scope.components.map(row => {
    keys(row, ["address", "roles"], "INVALID_COMPONENT");
    const at = address(row.address);
    if (seen.has(at)) fail("DUPLICATE_COMPONENT_ADDRESS");
    seen.add(at);
    if (!declared.has(at) || !Array.isArray(row.roles) || !row.roles.length) fail("COMPONENT_SCOPE_MISMATCH");
    const roles = row.roles.map(role => {
      if (typeof role !== "string") fail("INVALID_COMPONENT_ROLE");
      const normalized = role.replace(/\[(\d+)\]/g, ".$1");
      if (!declared.get(at).includes(normalized)) fail("INVALID_COMPONENT_ROLE");
      return normalized;
    });
    if (new Set(roles).size !== roles.length) fail("DUPLICATE_COMPONENT_ROLE");
    return { address: at, roles };
  });
  if (seen.size !== declared.size || [...declared.keys()].some(at => !seen.has(at))) fail("COMPONENT_SCOPE_MISMATCH");
  const dependencies = scope.dependencies.map(row => {
    keys(row, ["address", "role", "parent", "source"], "INVALID_DEPENDENCY");
    const at = address(row.address);
    if (seen.has(at)) fail("DUPLICATE_DEPENDENCY_ADDRESS");
    seen.add(at);
    if (typeof row.role !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]{0,159}$/.test(row.role)) fail("INVALID_DEPENDENCY_ROLE");
    return { address: at, role: row.role, parent: address(row.parent), source: sourcifyUrl(row.source) };
  });
  if (dependencies.some(row => !seen.has(row.parent) || row.parent === row.address)) fail("INVALID_DEPENDENCY_PARENT");
  const sourced = new Set();
  const sources = scope.sources.map(row => {
    keys(row, ["address", "filePath", "sha256"], "INVALID_SOURCE");
    const at = address(row.address);
    if (!seen.has(at) || sourced.has(at)) fail("AMBIGUOUS_SOURCE_ADDRESS");
    sourced.add(at);
    if (!DIGEST.test(row.sha256 || "")) fail("INVALID_SOURCE_DIGEST");
    const content = sourceBytes.get(row.filePath);
    if (!content || sha256(content) !== row.sha256) fail("SOURCE_HASH_MISMATCH");
    const source = parseJson(content);
    const published = source.runtimeBytecode?.onchainBytecode;
    if (published != null && (typeof published !== "string" || !HEX.test(published))) fail("INVALID_PUBLISHED_BYTECODE");
    return { address: at, filePath: row.filePath, sha256: row.sha256,
      publishedOnchainBytecode: published == null ? null : published };
  });
  return freeze({ scope: JSON.parse(JSON.stringify(scope)), module, components, dependencies, sources, proxies,
    allowedAddresses: [...seen], moduleAddressRoles: Object.fromEntries(declared) });
}

function loadScope(scopePath, options = {}) {
  const io = options.fs || fs, root = path.resolve(options.workspace || WORKSPACE);
  const scopeBytes = publicRead(containedPath(root, scopePath, io), io);
  const scope = parseJson(scopeBytes);
  // Validate the outer shape before following any public-file pointers.
  keys(scope, ["schema", "chainId", "registry", "components", "dependencies", "sources"], "INVALID_SCOPE_SCHEMA");
  if (scope.schema !== SCHEMA || scope.chainId !== 8453 || !object(scope.registry) || !Array.isArray(scope.sources)) fail("INVALID_SCOPE_CHAIN_OR_SCHEMA");
  const moduleBytes = publicRead(containedPath(root, scope.registry.modulePath, io), io);
  const manifest = parseJson(publicRead(containedPath(root, scope.registry.manifestPath, io), io));
  const sourceBytes = new Map();
  for (const row of scope.sources) {
    if (!object(row)) fail("INVALID_SOURCE");
    sourceBytes.set(row.filePath, publicRead(containedPath(root, row.filePath, io), io));
  }
  const validated = validateScope(scope, { manifest, moduleBytes, sourceBytes, identity: options.identity || IDENTITY });
  return Object.freeze({ ...validated, scopeSha256: sha256(scopeBytes) });
}

function validatePaceMs(value) {
  if (!Number.isInteger(value) || (value !== 0 && (value < 250 || value > 10000))) fail("INVALID_PACE_MS");
  return value;
}
function createRpcGuard({ allowedAddresses, rpcRead, now = Date.now, started = now(), budget = BUDGET, phase = "STATE",
  paceMs = 0, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  validatePaceMs(paceMs);
  if (phase !== "STATE" && phase !== "QUALIFICATION") fail("INVALID_COLLECTION_PHASE");
  const allowed = new Set(allowedAddresses.map(address));
  let fatal = null, requests = 0, failedRequests = 0, active = 0;
  let qualificationFailures = 0, stateFailures = 0, stateReverts = 0;
  const qualificationFailureCodes = {};
  const pendingStateReverts = [];
  const refusals = [];
  const actualStartOffsetsMs = [];
  let dispatchTail = Promise.resolve(), lastStart = null;
  function latch(code, method, at) {
    if (!fatal) fatal = code;
    if (refusals.length < 16 && (method || at)) refusals.push({ code, method: METHODS.has(method) ? method : null,
      address: typeof at === "string" && ADDRESS.test(at) ? at.toLowerCase() : null });
    throw new AdmissionError(fatal);
  }
  function check() {
    if (fatal) throw new AdmissionError(fatal);
    if (now() - started >= budget.maxMs || now() < started) latch("ADMISSION_DEADLINE");
  }
  function beginStateCollection() {
    check();
    if (phase !== "QUALIFICATION") fail("INVALID_COLLECTION_PHASE");
    if (active !== 0) fail("QUALIFICATION_CALLS_ACTIVE");
    phase = "STATE";
  }
  function target(at, method) {
    check();
    if (typeof at !== "string" || !ADDRESS.test(at) || !allowed.has(at.toLowerCase())) latch("UNDECLARED_TARGET", method, at);
  }
  function canonical(value, method) {
    if (!object(value) || !HASH.test(value.blockHash || "") || value.requireCanonical !== true
      || Object.keys(value).some(key => !["blockHash", "requireCanonical"].includes(key))) latch("NONCANONICAL_STATE_READ", method);
  }
  function validate(method, params) {
    check();
    if (!METHODS.has(method)) latch("METHOD_NOT_ALLOWED", method);
    if (!Array.isArray(params)) latch("INVALID_RPC_PARAMETERS", method);
    if (method === "eth_chainId" && params.length !== 0) latch("INVALID_RPC_PARAMETERS", method);
    if (method === "eth_getBlockByNumber" && (params.length !== 2 || params[1] !== false
      || !(params[0] === "finalized" || /^0x[0-9a-f]+$/i.test(params[0] || "")))) latch("INVALID_HEADER_REQUEST", method);
    if (method === "eth_getCode" || method === "eth_getStorageAt" || method === "eth_call") {
      const isCall = method === "eth_call", storage = method === "eth_getStorageAt";
      const at = isCall ? params[0]?.to : params[0];
      target(at, method);
      if (params.length !== (storage ? 3 : 2)) latch("INVALID_RPC_PARAMETERS", method, at);
      if (isCall && (!object(params[0]) || !HEX.test(params[0].data || "")
        || Object.keys(params[0]).some(key => !["to", "data"].includes(key)))) latch("INVALID_READ_CALL", method, at);
      if (storage && !HASH.test(params[1] || "")) latch("INVALID_STORAGE_SLOT", method, at);
      canonical(params[storage ? 2 : 1], method);
    }
    if (method === "eth_getLogs") {
      const filter = params[0];
      if (params.length !== 1 || !object(filter)) latch("INVALID_LOG_FILTER", method);
      const addresses = Array.isArray(filter.address) ? filter.address : [filter.address];
      if (!addresses.length) latch("UNDECLARED_TARGET", method);
      addresses.forEach(at => target(at, method));
      const quantity = value => typeof value === "string" && /^0x[0-9a-f]+$/i.test(value) && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER);
      if (Object.hasOwn(filter, "blockHash")) {
        if (!HASH.test(filter.blockHash || "") || Object.hasOwn(filter, "fromBlock") || Object.hasOwn(filter, "toBlock")) latch("UNBOUNDED_LOG_READ", method);
      } else if (!quantity(filter.fromBlock) || !quantity(filter.toBlock) || BigInt(filter.fromBlock) > BigInt(filter.toBlock)) latch("UNBOUNDED_LOG_READ", method);
      if (Object.keys(filter).some(key => !["address", "topics", "blockHash", "fromBlock", "toBlock"].includes(key))) latch("INVALID_LOG_FILTER", method);
    }
  }
  async function rpc(handle, method, params, timeoutMs) {
    validate(method, params);
    if (requests >= budget.maxRequests) latch("ADMISSION_REQUEST_CAP", method);
    if (active >= budget.concurrency) latch("ADMISSION_CONCURRENCY_CAP", method);
    const callPhase = phase;
    requests += 1; active += 1;
    let releaseTurn;
    try {
      if (paceMs > 0) {
        const previous = dispatchTail;
        dispatchTail = new Promise(resolve => { releaseTurn = resolve; });
        await previous;
        validate(method, params);
        while (lastStart !== null) {
          check();
          const delay = lastStart + paceMs - now();
          if (delay <= 0) break;
          const remaining = budget.maxMs - (now() - started);
          if (remaining <= 0) latch("ADMISSION_DEADLINE", method);
          try { await sleep(Math.min(delay, remaining)); }
          catch (_) { latch("PACING_WAIT_FAILED", method); }
          // Timers may wake early. Never substitute a scheduled start for the
          // clock observed immediately before the actual transport invocation.
        }
      }
      validate(method, params);
      // requests includes reservations already holding a conservative active
      // slot. The actual-dispatch cap is checked again after any pacing wait.
      if (requests > budget.maxRequests || actualStartOffsetsMs.length >= budget.maxRequests) latch("ADMISSION_REQUEST_CAP", method);
      const dispatchAt = now();
      if (dispatchAt - started >= budget.maxMs || dispatchAt < started) latch("ADMISSION_DEADLINE", method);
      const timeout = Math.min(budget.timeoutMs, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : budget.timeoutMs,
        budget.maxMs - (dispatchAt - started));
      // Production rpcRead aborts at this timeout. Retain the physical slot until
      // that actual transport settles; a race must not release it prematurely.
      let pending;
      try {
        lastStart = dispatchAt;
        actualStartOffsetsMs.push(dispatchAt - started);
        pending = rpcRead(handle, method, params, timeout, { maxBytes: budget.maxBytes });
      } finally {
        // Serialize STARTS only, never the raw promise's completion.
        if (releaseTurn) { releaseTurn(); releaseTurn = null; }
      }
      const value = await pending;
      check();
      return value;
    } catch (error) {
      failedRequests += 1;
      if (!fatal && (now() - started >= budget.maxMs || now() < started)) fatal = "ADMISSION_DEADLINE";
      const code = fatal || errorCode(error, "RPC_TRANSPORT");
      if (callPhase === "QUALIFICATION") {
        qualificationFailures += 1;
        qualificationFailureCodes[code] = (qualificationFailureCodes[code] || 0) + 1;
      } else if (!fatal && method === "eth_call" && error?.code === "CALL_EXCEPTION") {
        stateReverts += 1;
        if (pendingStateReverts.length < 32) pendingStateReverts.push(Object.freeze({ status: "UNRESOLVED",
          to: params[0].to.toLowerCase(), selector: params[0].data.length >= 10 ? params[0].data.slice(0, 10).toLowerCase() : null,
          calldataSha256: sha256(Buffer.from(params[0].data.slice(2), "hex")), blockHash: params[1].blockHash.toLowerCase() }));
        throw sanitizedCallRevert();
      } else stateFailures += 1;
      // Qualification may reject an ordinary candidate, never a global guard or
      // cap failure. No ledger, deadline, candidate ceiling or retry is reset.
      if (callPhase === "QUALIFICATION" && !fatal && ["CALL_EXCEPTION", "RPC_RATE_LIMITED", "RPC_HTTP_REJECTED",
        "RPC_INVALID_JSON", "RPC_INVALID_ENVELOPE", "RPC_REJECTED", "RPC_TRANSPORT", "LOG_RANGE_LIMIT",
        "RPC_INVALID_RESULT", "RPC_INVALID_HEADER"].includes(code)) {
        throw new AdmissionError(code);
      }
      latch(code, method);
    } finally { if (releaseTurn) releaseTurn(); active -= 1; }
  }
  return { rpc, check, target, latch, beginStateCollection, statistics: () => ({ requests, failedRequests,
    qualificationFailures, stateFailures, stateReverts, qualificationFailureCodes: { ...qualificationFailureCodes }, phase,
    paceMs, actualDispatches: actualStartOffsetsMs.length, actualStartOffsetsMs: [...actualStartOffsetsMs],
    pendingStateReverts: pendingStateReverts.map(row => ({ ...row })), pendingStateRevertsTruncated: stateReverts > pendingStateReverts.length,
    activeRequests: active, fatalCode: fatal, refusals: [...refusals] }) };
}

function registryExtract(validated, pin) {
  return { registryId: "aave-dao/aave-address-book", chainId: 8453, version: "v" + validated.scope.registry.version,
    commit: validated.scope.registry.commit, moduleSha256: validated.scope.registry.moduleSha256,
    source: "AaveV4Base", pinBlock: "0x" + pin.number.toString(16), pinBlockNumber: pin.number,
    hubs: [{ key: "EQUITIES_HUB", name: "Equities Hub", address: validated.module.HUBS.EQUITIES_HUB }],
    admins: { ACCESS_MANAGER: validated.module.ACCESS_MANAGER, TREASURY_SPOKE: validated.module.TREASURY_SPOKE },
    spokes: validated.module.SPOKES, tokenizationSpokes: validated.module.TOKENIZATION_SPOKES,
    positionManagers: validated.module.POSITION_MANAGERS, externalLibraries: validated.module.EXTERNAL_LIBRARIES };
}
function hasReadGaps(value) {
  function failedError(child) {
    if (child && typeof child === "object") return Object.values(child).some(failedError);
    if (typeof child === "number") return child > 0;
    return child === true || (typeof child === "string" && child !== "");
  }
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => {
    if (/^(?:error|errors|failureReason)$/i.test(key) && failedError(child)) return true;
    if (/truncated|incomplete|budgetExhausted/i.test(key) && child === true) return true;
    if (/^stateReadsFailed$/i.test(key) && typeof child === "number" && child > 0) return true;
    return hasReadGaps(child);
  });
}
// Keep numbers/hex and known public labels, never arbitrary RPC error text or
// endpoint-shaped strings. Earlier scanner attestations are deliberately removed.
const PUBLIC_TOPOLOGY_METADATA = Object.freeze({
  schema: ["aave-source-coverage/v1", "aave-v4-state-pin/v1", "aave-v4-base-admission/v1", SCHEMA, "aave-v4-base-role-evidence/v1"],
  scanner: ["tools/scan-aave-v4-hubs.js"],
  protocolVersion: ["V4"], coverageKind: ["topology"], producerKind: ["topology"],
  type: ["DECLARED_STATIC_HUB_SET", "BOUNDED_OBSERVATION", "INCOMPLETE_SOURCE"],
  classification: ["SOURCE_INCOMPLETE", "BOUNDED_OBSERVATIONAL"],
  registry: ["aave-dao/aave-address-book", "aave-dao/aave-address-book/AaveV4Base"],
  registryId: ["aave-dao/aave-address-book", "aave-dao/aave-address-book/AaveV4Base"],
  source: ["AaveV4Base"], moduleName: ["AaveV4Base"],
  version: [IDENTITY.version, "v" + IDENTITY.version], packageVersion: [IDENTITY.version],
  commit: [IDENTITY.commit], inputSourceCommit: [IDENTITY.commit],
  unitHint: ["underlying", "supply-shares", "shares", "raw-index", "raw-rate", "ray"],
});
function sanitizeTopology(value, labels = new Set(), key = "", parentKey = "", errorContext = false) {
  if (/observationPin/i.test(key)) return undefined;
  const inError = errorContext || /error|failureReason/i.test(key);
  if (inError && typeof value === "string") return value ? "TOPOLOGY_READ_FAILED" : "";
  if (key === "generatedAt" || key === "observedAt") {
    if (value === null) return null;
    const time = typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ? Date.parse(value) : NaN;
    return Number.isFinite(time) && new Date(time).toISOString() === value ? value : "METADATA_OMITTED";
  }
  if (key === "inventoryDigest" || key === "moduleSha256") {
    if (value === null) return null;
    const publicContext = key === "inventoryDigest" ? ["declaredTopology", "topologyUniverse"].includes(parentKey)
      : ["registry", ""].includes(parentKey);
    return publicContext && typeof value === "string" && DIGEST.test(value) ? value : "METADATA_OMITTED";
  }
  if (key === "pinBlock" && typeof value === "string") {
    return /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value) && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER) ? value : "METADATA_OMITTED";
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "bigint") return String(value);
  if (typeof value === "string") {
    if (Object.hasOwn(PUBLIC_TOPOLOGY_METADATA, key)) {
      return PUBLIC_TOPOLOGY_METADATA[key].includes(value) || (key === "source" && ADDRESS.test(value)) ? value : "METADATA_OMITTED";
    }
    if (HEX.test(value) || /^-?\d+(?:\.\d+)?$/.test(value) || labels.has(value)
      || ["Base", "aave-v4-state-pin/v1", "finalized", "single-provider", "DECLARED_STATIC_HUB_SET", "match", "mismatch", "unavailable", "Equities Hub",
        "NON_LENDING_INTERFACE", "TYPED_INTERFACE", "treasury", "tokenization", "lending", "hub", "strategy", "UNKNOWN_DEPLOYMENT_SEMANTICS",
        "SOURCE_INCOMPLETE", "BOUNDED_OBSERVATIONAL", "underlying", "supply-shares"].includes(value)) return value;
    return "METADATA_OMITTED";
  }
  if (Array.isArray(value)) return value.map(child => sanitizeTopology(child, labels, key, parentKey, inError));
  if (object(value)) {
    const output = {};
    for (const [name, child] of Object.entries(value)) {
      // Object keys also originate in chain-returned metadata in some summaries.
      if (!/^[A-Za-z0-9_.-]{1,160}$/.test(name)) continue;
      if (/headers?|authorization|body|rpcurl|endpoint|providerhandle/i.test(name)) continue;
      if (["__proto__", "constructor", "prototype"].includes(name)) continue;
      const safe = sanitizeTopology(child, labels, name, key, inError);
      if (safe !== undefined) output[name] = safe;
    }
    return output;
  }
  return null;
}
function publicStatistics(context) {
  const input = context.statistics(), result = {};
  for (const key of ["dispatchedRequests", "stateRequests", "stateReadOperations", "stateCacheHits", "stateTransportFailures",
    "revertedStateReads", "rejectedRequests", "networkCalls", "headerFamilies", "stateFamilies", "automaticRetries"]) {
    if (!Number.isSafeInteger(input[key]) || input[key] < 0) fail("INVALID_COLLECTION_STATISTICS");
    result[key] = input[key];
  }
  return result;
}
function atomicWrite(io, directory, name, value) {
  const target = path.join(directory, name), temporary = path.join(directory, "." + name + ".tmp");
  try {
    io.writeFileSync(temporary, JSON.stringify(value, (_, child) => typeof child === "bigint" ? String(child) : child, 2) + "\n", { flag: "wx" });
    io.renameSync(temporary, target);
  } catch (_) { fail("ARTIFACT_WRITE_FAILED"); }
}
function safePin(pin) {
  if (!pin || !Number.isSafeInteger(pin.number) || pin.number < 0 || !HASH.test(pin.hash || "")
    || !HASH.test(pin.stateRoot || "") || !Number.isSafeInteger(Number(pin.timestamp))) fail("INVALID_COLLECTION_PIN");
  return { number: pin.number, hash: pin.hash, stateRoot: pin.stateRoot, timestamp: Number(pin.timestamp) };
}

async function capture(options = {}) {
  const paceMs = validatePaceMs(options.paceMs === undefined ? 0 : options.paceMs);
  const now = options.now || Date.now, started = now();
  const io = options.fs || fs, root = path.resolve(options.workspace || WORKSPACE);
  const validated = loadScope(options.scopePath, { ...options, fs: io, workspace: root });
  const output = containedPath(root, options.outDir, io, false);
  const reports = path.join(root, "reports");
  if (!relativeInside(reports, output)) fail("OUTPUT_NOT_IN_REPORTS");
  if (io.existsSync(output)) fail("OUTPUT_EXISTS");
  io.mkdirSync(path.dirname(output), { recursive: true });
  // Recheck containment after creating parents; never overwrite an existing run.
  containedPath(root, output, io, false);
  io.mkdirSync(output);
  const snapshot = JSON.parse(JSON.stringify(validated.scope));
  snapshot.registry.manifestPath = path.relative(root, path.resolve(root, snapshot.registry.manifestPath));
  snapshot.registry.modulePath = path.relative(root, path.resolve(root, snapshot.registry.modulePath));
  snapshot.sources.forEach(row => { row.filePath = path.relative(root, path.resolve(root, row.filePath)); });
  atomicWrite(io, output, "frozen-scope.json", { scope: snapshot, approvalBudget: BUDGET,
    approval: { mode: "ONE_ATTENDED_READ_ONLY_ADMISSION_BATCH", minimumIndependentReviewedFamilies: 2,
      requireCanonicalBlockHash: true, stopOnAnyCap: true, signing: false, borrowerHistory: false,
      ...(paceMs > 0 ? { pacing: { paceMs, maxRequestStartsPerSecond: 1000 / paceMs, includesQualificationStateAndTerminal: true } } : {}) },
    chainId: 8453, sourceCommitNotDeploymentVersion: true, moduleGroups: {
      ALL_HUBS: validated.module.ALL_HUBS, ALL_SPOKES: validated.module.ALL_SPOKES,
      ALL_SPOKES_RAW: validated.module.ALL_SPOKES_RAW, ALL_TOKENIZED_SPOKES: validated.module.ALL_TOKENIZED_SPOKES,
      HUBS: validated.module.HUBS, SPOKES: validated.module.SPOKES, TOKENIZATION_SPOKES: validated.module.TOKENIZATION_SPOKES,
    } });
  const report = { schema: "aave-v4-base-admission/v1", chainId: 8453, status: "INCOMPLETE", codes: [],
    coveragePromotion: false, dispatchEnabled: false, baseRowsRemainBlocked: true, unpriced: true,
    borrowerHistoryComplete: false, sourceWiringQualified: false, deployedGitCommitVerified: false,
    sourceVerificationClaimed: false, D: "BLOCKED", O: "BLOCKED", L: "BLOCKED",
    registry: { moduleName: IDENTITY.moduleName, packageVersion: validated.scope.registry.version,
      inputSourceCommit: validated.scope.registry.commit, moduleSha256: validated.scope.registry.moduleSha256 },
    declaredAddressCount: validated.allowedAddresses.length, sourceCount: validated.sources.length,
    codeInventoryComplete: false, topologyObtained: false, terminalPinConfirmed: false, finalObservationPin: null,
    topologyDiagnosticWritten: false };
  const inventory = [];
  let context, guard, topology;
  try {
    // Lazy loading here is the only production route to candidate inventory.
    const pinned = options.openCollection && options.rpcRead ? null : require("./lib/aave-v4-pinned-collection");
    const open = options.openCollection || pinned.openPinnedCollection;
    const raw = options.rpcRead || pinned.rpcRead;
    guard = createRpcGuard({ allowedAddresses: validated.allowedAddresses, rpcRead: raw, now, started,
      phase: "QUALIFICATION", paceMs, sleep: options.sleep });
    guard.check();
    const original = await open({ chainId: 8453, probeAddress: validated.module.HUBS.EQUITIES_HUB, rpc: guard.rpc, now });
    guard.check();
    if (original.chainId !== 8453) fail("COLLECTION_CHAIN_MISMATCH");
    guard.beginStateCollection();
    const pin = safePin(original.pin);
    report.pin = pin;
    function checkpoint() {
      guard.check();
      if (now() - pin.timestamp * 1000 > BUDGET.maxPinAgeMs || pin.timestamp * 1000 - now() > 60000) guard.latch("PIN_STALE_OR_FUTURE");
    }
    const provider = {};
    for (const method of ["getCode", "getStorage", "call", "getLogs", "getBlock", "callMany"]) {
      if (typeof original.provider?.[method] !== "function") continue;
      provider[method] = async (...args) => {
        checkpoint();
        if (method === "getCode" || method === "getStorage") guard.target(args[0], method === "getCode" ? "eth_getCode" : "eth_getStorageAt");
        if (method === "call") guard.target(args[0]?.to, "eth_call");
        if (method === "callMany") for (const tx of args[0]) guard.target(tx?.to, "eth_call");
        if (method === "getLogs") for (const at of Array.isArray(args[0]?.address) ? args[0].address : [args[0]?.address]) guard.target(at, "eth_getLogs");
        try {
          const result = await original.provider[method](...args);
          checkpoint();
          return result;
        } catch (error) {
          if (method === "call" && error?.code === "CALL_EXCEPTION") {
            checkpoint();
            throw sanitizedCallRevert();
          }
          guard.latch(errorCode(error, "STATE_READ_FAILED"));
        }
      };
    }
    context = Object.freeze({ ...original, provider: Object.freeze(provider),
      confirmPin: async () => { checkpoint(); const result = await original.confirmPin(); checkpoint(); return result; } });
    const hashCode = options.keccak256 || require("ethers").keccak256;
    for (const at of validated.allowedAddresses) {
      checkpoint();
      const code = await context.provider.getCode(at);
      if (typeof code !== "string" || !HEX.test(code)) fail("INVALID_CHAIN_BYTECODE");
      const source = validated.sources.find(row => row.address === at);
      inventory.push({ address: at, roles: validated.moduleAddressRoles[at] || [],
        dependency: validated.dependencies.find(row => row.address === at) || null,
        codePresent: code !== "0x", codeBytes: (code.length - 2) / 2, codeKeccak256: hashCode(code),
        publishedSourceSha256: source?.sha256 || null,
        publishedOnchainBytecodeComparison: !source || source.publishedOnchainBytecode === null ? "unavailable"
          : code === source.publishedOnchainBytecode ? "equal" : "not-equal",
        chainCodeEqualsPublishedOnchainBytecode: source?.publishedOnchainBytecode === null || !source ? null : code === source.publishedOnchainBytecode });
    }
    report.codeInventoryComplete = true;
    for (const proxy of validated.proxies) {
      checkpoint();
      const slot = await context.provider.getStorage(proxy.address, IMPLEMENTATION_SLOT);
      if (!HASH.test(slot || "") || !/^0x0{24}/i.test(slot)) fail("INVALID_IMPLEMENTATION_SLOT");
      const implementation = "0x" + slot.slice(-40).toLowerCase();
      const row = inventory.find(item => item.address === proxy.address);
      row.proxyRole = proxy.role;
      row.implementation = implementation;
      row.publishedDependencyAddresses = validated.dependencies.filter(item => item.parent === proxy.address).map(item => item.address);
      row.implementationInFrozenScope = implementation !== ZERO && validated.allowedAddresses.includes(implementation);
      if (implementation === ZERO) fail("MISSING_PROXY_IMPLEMENTATION");
      if (implementation !== ZERO && !row.implementationInFrozenScope) {
        report.scopeExpansion = { proxy: proxy.address, implementation };
        guard.latch("IMPLEMENTATION_SCOPE_EXPANSION", "eth_getStorageAt", implementation);
      }
    }
    checkpoint();
    let roleBindings;
    if (validated.scope.registry.moduleSha256 === IDENTITY.moduleSha256) {
      const roles = require("./lib/aave-v4-base-role-evidence");
      const published = roles.loadPublishedEvidence({ readFile: relative => publicRead(containedPath(root, relative, io), io) });
      roleBindings = roles.bindRoleEvidence({ chainId: 8453, registry: validated.scope.registry, pin: original.pin,
        scopeSha256: validated.scopeSha256, published,
        inventory: { chainId: 8453, pin: original.pin, complete: true, rows: inventory } });
      report.roleEvidence = { publishedBytesValidated: true, currentPinCodeAndPointersMatched: true,
        terminalPinConfirmed: false, sourceVerificationClaimed: false, bindings: roleBindings.bindings,
        unresolved: roleBindings.unresolved };
    }
    const labels = new Set([validated.scope.registry.commit, validated.scope.registry.version, "v" + validated.scope.registry.version,
      validated.scope.registry.moduleSha256, "aave-dao/aave-address-book", "AaveV4Base", "NON_LENDING_INTERFACE", "TYPED_INTERFACE",
      "treasury", "tokenization", "lending", "hub", "strategy", "UNKNOWN_DEPLOYMENT_SEMANTICS", ...Object.keys(validated.module)]);
    const collect = options.collectTopology || require("./scan-aave-v4-hubs").collectTopology;
    topology = await collect({ chainId: 8453, registryExtract: registryExtract(validated, pin),
      ...(roleBindings ? { roleBindings } : {}),
      onProvisionalTopology: snapshot => {
        const diagnostic = sanitizeTopology(snapshot, labels);
        diagnostic.provisional = true;
        diagnostic.incomplete = true;
        diagnostic.sourceCoverage = { ...(diagnostic.sourceCoverage || {}), complete: false, sampleComplete: false, observationPin: null };
        atomicWrite(io, output, "topology-diagnostic.json", diagnostic);
        report.topologyDiagnosticWritten = true;
      },
      openCollection: async () => { checkpoint(); return context; }, fetchPrices: async () => ({}), now });
    report.topologyObtained = true;
    checkpoint();
    if (topology?.chain?.id !== 8453 || topology.chain.blockNumber !== pin.number || topology.chain.blockHash !== pin.hash) fail("TOPOLOGY_PIN_OR_CHAIN_MISMATCH");
    // Never reuse the scanner's earlier attestation after subsequent reads.
    await context.confirmPin();
    report.terminalPinConfirmed = true;
    const statistics = publicStatistics(context);
    report.collection = statistics;
    if (statistics.headerFamilies < 2 || statistics.networkCalls > BUDGET.maxRequests) fail("COLLECTION_QUALIFICATION_OR_CAP_FAILED");
    if (guard.statistics().stateReverts || statistics.revertedStateReads) fail("UNRECONCILED_STATE_REVERTS");
    if (roleBindings?.unresolved.length) fail("BASE_DEPLOYMENT_SEMANTICS_UNRESOLVED");
    if (statistics.stateTransportFailures || statistics.rejectedRequests
      || guard.statistics().stateFailures || hasReadGaps(topology)) fail("COLLECTION_READ_GAPS");
    checkpoint();
    const coverage = { stateReadsAttempted: statistics.stateReadOperations,
      stateReadsSucceeded: statistics.stateReadOperations, stateReadsFailed: 0 };
    const attestation = context.observationPin(coverage);
    if (!attestation || attestation.schema !== "aave-v4-state-pin/v1" || attestation.chainId !== 8453 || attestation.blockHash !== pin.hash
      || attestation.blockNumber !== pin.number || attestation.stateRoot !== pin.stateRoot || attestation.finality !== "finalized"
      || attestation.terminalBlockNumber !== pin.number || attestation.terminalBlockHash !== pin.hash
      || attestation.headerFamilies < 2 || attestation.stateReadsPinned !== statistics.stateReadOperations) fail("FINAL_PIN_ATTESTATION_UNAVAILABLE");
    report.finalObservationPin = sanitizeTopology(attestation);
    report.stateReadCoverage = coverage;
    report.status = "ADMISSION_CAPTURED";
  } catch (error) {
    report.codes.push(guard?.statistics().fatalCode || errorCode(error));
    report.finalObservationPin = null;
  }
  if (context) {
    try { report.collection = publicStatistics(context); } catch (_) { report.codes.push("INVALID_COLLECTION_STATISTICS"); report.status = "INCOMPLETE"; report.finalObservationPin = null; }
  }
  report.guard = guard ? guard.statistics() : { requests: 0, failedRequests: 0, qualificationFailures: 0,
    stateFailures: 0, stateReverts: 0, pendingStateReverts: [], pendingStateRevertsTruncated: false,
    paceMs, actualDispatches: 0, actualStartOffsetsMs: [],
    qualificationFailureCodes: {}, phase: "QUALIFICATION", activeRequests: 0, fatalCode: null, refusals: [] };
  if ((report.guard.stateReverts || report.collection?.revertedStateReads) && !report.codes.includes("UNRECONCILED_STATE_REVERTS")) {
    report.codes.push("UNRECONCILED_STATE_REVERTS");
    report.status = "INCOMPLETE"; report.finalObservationPin = null;
  }
  report.totalElapsedMs = Math.max(0, now() - started);
  if (report.totalElapsedMs >= BUDGET.maxMs || report.guard.fatalCode) {
    report.status = "INCOMPLETE"; report.finalObservationPin = null;
    if (!report.codes.length) report.codes.push(report.guard.fatalCode || "ADMISSION_DEADLINE");
  }
  if (report.status !== "ADMISSION_CAPTURED") report.stateReadCoverage = {
    stateReadsAttempted: report.collection?.stateReadOperations ?? null, stateReadsSucceeded: null, stateReadsFailed: null };
  atomicWrite(io, output, "code-inventory.json", { chainId: 8453, pin: report.pin || null, complete: report.codeInventoryComplete, rows: inventory });
  if (topology) {
    const labels = new Set([validated.scope.registry.commit, validated.scope.registry.version, "v" + validated.scope.registry.version, validated.scope.registry.moduleSha256,
      "aave-dao/aave-address-book", "AaveV4Base", ...Object.keys(validated.module), ...Object.keys(validated.moduleAddressRoles)]);
    atomicWrite(io, output, "topology.json", sanitizeTopology(topology, labels));
  }
  report.totalElapsedMs = Math.max(0, now() - started);
  if (report.totalElapsedMs >= BUDGET.maxMs) {
    report.status = "INCOMPLETE"; report.finalObservationPin = null;
    report.stateReadCoverage = { stateReadsAttempted: report.collection?.stateReadOperations ?? null,
      stateReadsSucceeded: null, stateReadsFailed: null };
    if (!report.codes.includes("ADMISSION_DEADLINE")) report.codes.push("ADMISSION_DEADLINE");
  }
  if (report.pin && (now() - report.pin.timestamp * 1000 > BUDGET.maxPinAgeMs || report.pin.timestamp * 1000 - now() > 60000)) {
    report.status = "INCOMPLETE"; report.finalObservationPin = null;
    report.stateReadCoverage = { stateReadsAttempted: report.collection?.stateReadOperations ?? null,
      stateReadsSucceeded: null, stateReadsFailed: null };
    if (!report.codes.includes("PIN_STALE_OR_FUTURE")) report.codes.push("PIN_STALE_OR_FUTURE");
  }
  atomicWrite(io, output, "admission.json", report);
  return report;
}

function parseArgs(argv) {
  let mode = "check", explicitMode = false, scopePath, outDir, paceMs;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check" || arg === "--capture") {
      if (explicitMode) fail("INVALID_ARGUMENTS");
      explicitMode = true; mode = arg.slice(2);
    } else if (arg === "--scope" || arg === "--out-dir" || arg === "--pace-ms") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) fail("INVALID_ARGUMENTS");
      if (arg === "--scope") { if (scopePath !== undefined) fail("INVALID_ARGUMENTS"); scopePath = value; }
      else if (arg === "--out-dir") { if (outDir !== undefined) fail("INVALID_ARGUMENTS"); outDir = value; }
      else {
        if (paceMs !== undefined) fail("INVALID_ARGUMENTS");
        if (!/^\d+$/.test(value) || Number(value) === 0) fail("INVALID_PACE_MS");
        paceMs = validatePaceMs(Number(value));
      }
    } else fail("INVALID_ARGUMENTS");
  }
  if (mode === "capture" && (!scopePath || !outDir) || mode === "check" && (outDir !== undefined || paceMs !== undefined)) fail("INVALID_ARGUMENTS");
  return { mode, scopePath: scopePath || "tools/aave-v4-base-admission-scope.json", outDir, ...(paceMs === undefined ? {} : { paceMs }) };
}
async function runCli(argv, options = {}) {
  const args = parseArgs(argv);
  if (args.mode === "capture") return capture({ ...options, ...args });
  const validated = loadScope(args.scopePath, options);
  return { status: "SCOPE_VALID", chainId: 8453, componentCount: validated.components.length,
    dependencyCount: validated.dependencies.length, sourceCount: validated.sources.length, rpcRequests: 0 };
}
if (require.main === module) {
  runCli(process.argv.slice(2)).then(result => {
    console.log(JSON.stringify({ status: result.status, chainId: 8453, codes: result.codes || [] }));
    if (result.status === "INCOMPLETE") process.exitCode = 1;
  }).catch(error => { console.error(JSON.stringify({ status: "INCOMPLETE", code: errorCode(error) })); process.exitCode = 1; });
}
module.exports = { IDENTITY, BUDGET, SCHEMA, AdmissionError, sha256, validateScope, loadScope, containedPath,
  createRpcGuard, registryExtract, sanitizeTopology, hasReadGaps, capture, parseArgs, runCli };
