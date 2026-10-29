"use strict";

/*
 * tools/lib/trigger-fork-epoch-platform.js — PHASE A platform boundary.
 *
 * Two strictly separated adapters:
 *  - TEST MODEL adapter: labeled "TEST_MODEL" offline Byte/file contract bound
 *    over node:fs primitives with SINGLE-SHOT fault injections for decisive
 *    journal/owner tests. Registered in a private brand WeakSet; a copied flag
 *    or stolen object is not a registered adapter. Production code must never
 *    accept it.
 *  - PRODUCTION adapter interface: phase A implements the offline model ONLY.
 *    The production adapter factory ALWAYS returns the fixed, honest
 *    PLATTFORM blocker PLATFORM_RUNTIME_UNIMPLEMENTED — no caller-written
 *    qualification JSON, no readiness booleans, no shortcuts and no
 *    placeholder file adapter exist until a qualified, persistent,
 *    owner-aligned native host is reviewed and implemented (contains an owner
 *    mutex, suspended-spawn kill-on-close job containment, a durable creation
 *    path with measured directory-entry/write-through/FlushFileBuffers
 *    persistence under power-loss, process-creation identity). What the
 *    exactly-bound probe DOES measure is reported as per-call OUTPUT facts.
 *  - The probe runner binds the real reviewed script by absolute module path
 *    (`tools/native/trigger-fork-epoch-platform.ps1`), refusing any caller
 *    script input (Fake scripts with a matching basename can never run) and
 *    confining the probe directory under os.tmpdir().
 *  - The CLI is inert with respect to its platform result unless
 *    --check-platform explicitly requests a probe under the approved
 *    temporary tree. Activation can only ever occur via the designed
 *    attended-focused flow after a REAL platform adapter exists.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const MODE_TEST = "test";
const TEST_MODE_LABEL = "TEST_MODEL";
const PROBE_SCHEMA = "trigger-fork-epoch-platform-probe/v2";
const FIXED_PROBE_SCRIPT = path.join(__dirname, "..", "native", "trigger-fork-epoch-platform.ps1");
const FIXED_PROBE_SCRIPT_BASENAME = "trigger-fork-epoch-platform.ps1";
const PROBE_TIMEOUT_MS = 60000;

const CAPABILITIES = Object.freeze([
  "REGULAR_FILE_WRITE_THROUGH_FLUSH",
  "DIRECTORY_HANDLE_FLUSH_WRITE",
  "DIRECTORY_HANDLE_FLUSH_READONLY",
  "QPC_NONDECREASE_UTC_DURATION",
  "NAMED_MUTEX_ACQUIRE_RELEASE",
  "PROCESS_CREATION_IDENTITY",
  "JOB_CONTAINMENT_SUSPENDED_SPAWN",
  "OWNER_ALIGNED_PERSISTENT_MUTEX_HOST",
  "DIRECTORY_CREATE_POWER_LOSS_DURABILITY"
]);

/* The production block is static and honest; facts dictionary is included. */
const PRODUCTION_BLOCKER = Object.freeze({
  code: "PLATFORM_RUNTIME_UNIMPLEMENTED",
  description: "PHASE A ships the offline model only; no qualified persistent owner-aligned " +
    "native host (exclusive journal lease, owner mutex with abandoned-recovery rules, " +
    "suspended-spawn kill-on-close job containment, durable directory-entry creation) " +
    "exists yet. Required production guarantees remain unimplemented/unqualified."
});
/* The facts list from the corrected probe, kept under the fixed blocker. */
const PRODUCTION_REQUIRED_CAPABILITIES = Object.freeze([
  "REGULAR_FILE_WRITE_THROUGH_FLUSH",
  "DIRECTORY_HANDLE_FLUSH_WRITE",
  "DIRECTORY_CREATE_POWER_LOSS_DURABILITY",
  "NAMED_MUTEX_ACQUIRE_RELEASE",
  "OWNER_ALIGNED_PERSISTENT_MUTEX_HOST",
  "QPC_NONDECREASE_UTC_DURATION",
  "PROCESS_CREATION_IDENTITY",
  "JOB_CONTAINMENT_SUSPENDED_SPAWN"
].map((c) => Object.freeze(c)));

const PLATFORM_BLOCKERS = Object.freeze({
  PLATFORM_MODE_INVALID: "PLATFORM_MODE_INVALID",
  PLATFORM_ADAPTER_UNREGISTERED: "PLATFORM_ADAPTER_UNREGISTERED",
  PLATFORM_RUNTIME_UNIMPLEMENTED: "PLATFORM_RUNTIME_UNIMPLEMENTED",
  PLATFORM_PROBE_OUTPUT_INVALID: "PLATFORM_PROBE_OUTPUT_INVALID",
  PLATFORM_PROBE_FAILED: "PLATFORM_PROBE_FAILED",
  PLATFORM_PROBE_REFUSED: "PLATFORM_PROBE_REFUSED",
  PLATFORM_NOT_TEMP_ROOT: "PLATFORM_NOT_TEMP_ROOT"
});

function deepFreeze(value) {
  if (Array.isArray(value)) { value.forEach(deepFreeze); return Object.freeze(value); }
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    return Object.freeze(value);
  }
  return value;
}
function failure(code, detail) {
  return Object.freeze({ ok: false, mode: TEST_MODE_LABEL, code, detail: detail || null });
}
function okTest(value) {
  return Object.freeze(Object.assign({ ok: true, mode: TEST_MODE_LABEL }, value));
}

/* ============================ TEST MODEL adapter ============================ */
/*- Decisive test-mode adapter contract: faults are SINGLE-SHOT injections; each
 * `adapter.injectFault(kind, injection)` arms exactly the next matching
 * operation. Injection values:
 *   { fail: "CODE" }  -> that operation fails with the fixed code
 *   { shortWritten: n } (append only) -> ok with fewer bytes written
 * false/null clears a pending injection. Only the frozen adapter object owns
 * the fds; production code never touches this adapter.
 */
const TEST_ADAPTER_BRAND = new WeakSet();

function createTestPlatformAdapter() {
  const pending = new Map();
  const hooks = new Map();
  const owned = new Set();
  function checkpoint(stage) {
    const fn = hooks.get(stage);
    if (fn) { hooks.delete(stage); fn(); }
  }
  function consume(kind) {
    if (!pending.has(kind)) return undefined;
    const injection = pending.get(kind);
    pending.delete(kind);
    return injection;
  }
  const api = {
    mode: MODE_TEST,
    label: TEST_MODE_LABEL,
    // Deterministic MODEL fault checkpoints, not native crash qualification.
    injectCheckpoint(stage, fn) { if (typeof fn !== "function") throw new Error("TEST_HOOK_INVALID"); hooks.set(stage, fn); },
    ownedHandleCount: () => owned.size,
    releaseTestHandles() { for (const fd of owned) { fs.closeSync(fd); owned.delete(fd); } },
    injectFault(kind, injection) {
      if (injection === null || injection === undefined) { pending.delete(kind); return; }
      pending.set(kind, injection);
    },
    createExclusiveFile(file) {
      const injected = consume("create");
      if (injected !== undefined) return adaptInjected(injected);
      const result = applyExclusiveNodeFile(file);
      if (result.ok === false) return result;
      owned.add(result.fd);
      return okTest(result);
    },
    openReadonlyExisting(file) {
      const injected = consume("open");
      if (injected !== undefined) return adaptInjected(injected);
      let fd;
      try { fd = fs.openSync(file, fs.constants.O_RDONLY); }
      catch (error) { return failure(PLATFORM_BLOCKERS.PLATFORM_PROBE_FAILED, String(error.code)); }
      owned.add(fd);
      return okTest({ fd, identityMode: TEST_MODE_LABEL });
    },
    append(fd, bytes) {
      const injected = consume("write");
      if (injected !== undefined) return adaptInjected(injected, bytes.length);
      try {
        const written = fs.writeSync(fd, bytes, 0, bytes.length, null);
        checkpoint("postWrite");
        return okTest({ written });
      } catch (error) { return failure(PLATFORM_BLOCKERS.PLATFORM_PROBE_FAILED, String(error.code)); }
    },
    flush(fd) {
      const injected = consume("fsync");
      if (injected !== undefined) return adaptInjected(injected);
      try { fs.fsyncSync(fd); checkpoint("postFlush"); return okTest({}); }
      catch (error) { return failure(PLATFORM_BLOCKERS.PLATFORM_PROBE_FAILED, String(error.code)); }
    },
    readAll(fd, maxBytes = 768 * 1024) {
      const injected = consume("readback");
      if (injected !== undefined) return adaptInjected(injected);
      try {
        const st = fs.fstatSync(fd);
        if (!Number.isSafeInteger(st.size) || st.size < 0 || st.size > maxBytes) return failure("TEST_READ_BOUND");
        const buffer = Buffer.alloc(st.size);
        let offset = 0;
        while (offset < st.size) {
          const count = fs.readSync(fd, buffer, offset, st.size - offset, offset);
          if (count <= 0) break;
          offset += count;
        }
        if (offset !== st.size) return failure("TEST_READ_SHORT");
        checkpoint("postRead");
        return okTest({ bytes: buffer });
      } catch (error) { return failure(PLATFORM_BLOCKERS.PLATFORM_PROBE_FAILED, String(error.code)); }
    },
    statIdentity(fd) {
      const injected = consume("stat");
      if (injected !== undefined) return adaptInjected(injected);
      try { return okTest(fdIdentity(fd)); }
      catch (error) { return failure(PLATFORM_BLOCKERS.PLATFORM_PROBE_FAILED, String(error.code)); }
    },
    statIdentityByPath(file) {
      const injected = consume("statPath");
      if (injected !== undefined) return adaptInjected(injected);
      try {
        const st = fs.statSync(file);
        return okTest({ size: st.size, dev: st.dev, ino: st.ino, nlink: st.nlink });
      } catch (error) { return failure(PLATFORM_BLOCKERS.PLATFORM_PROBE_FAILED, String(error.code)); }
    },
    closeFile(fd) {
      const injected = consume("close");
      if (injected !== undefined) return adaptInjected(injected);
      try { fs.closeSync(fd); owned.delete(fd); return okTest({}); }
      catch (error) { return failure(PLATFORM_BLOCKERS.PLATFORM_PROBE_FAILED, String(error.code)); }
    }
  };
  const frozen = deepFreeze(api);
  TEST_ADAPTER_BRAND.add(frozen);
  return frozen;
}
function isRegisteredTestAdapter(candidate) {
  return candidate !== null && typeof candidate === "object" &&
    TEST_ADAPTER_BRAND.has(candidate);
}
/* Only private TEST/native construction registries; no public brand setter.
 * Actual native I/O registration does not remove production/source blockers. */
function isRegisteredEpochPlatformAdapter(candidate) {
  return isRegisteredTestAdapter(candidate) || require("./trigger-fork-epoch-native-adapter.js").isNativeStorageAdapter(candidate);
}
// Explicit actual native service construction. This does NOT replace the
// default production/source blocker or grant activation from capability JSON.
function createNativeInactivePlatformAdapter(options) {
  if(!options||![Object.prototype,null].includes(Object.getPrototypeOf(options))||Reflect.ownKeys(options).length!==4) return Object.freeze({ok:false,code:"NATIVE_FACTORY_INPUT_INVALID"});
  for(const k of Reflect.ownKeys(options)){const d=Object.getOwnPropertyDescriptor(options,k);if(!["root","timeoutMs","startupTimeoutMs","qualificationDelayMs"].includes(k)||!d.enumerable||!("value"in d))return Object.freeze({ok:false,code:"NATIVE_FACTORY_INPUT_INVALID"});}
  try { return require("./trigger-fork-epoch-native-adapter.js").createNativeStorageAdapter(options); }
  catch { return Object.freeze({ok:false,code:"NATIVE_FACTORY_INPUT_INVALID"}); }
}
function adaptInjected(injection, expectedLength) {
  if (injection && typeof injection === "object") {
    if (typeof injection.shortWritten === "number" &&
        (!expectedLength || injection.shortWritten <= expectedLength)) {
      return okTest({ written: injection.shortWritten });
    }
    if (typeof injection.fail === "string") return failure(injection.fail);
  }
  return failure(PLATFORM_BLOCKERS.PLATFORM_PROBE_FAILED);
}
function applyExclusiveNodeFile(file) {
  let fd;
  try {
    /* exclusive CREATE (fail if it exists) with READ access for readback +
     * WRITE for appends, so the same descriptor can write AND read back. */
    fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT |
      fs.constants.O_EXCL, 0o600);
  } catch (error) {
    /* propagate the exact fs errno (EEXIST etc.) so the journal layer can
     * distinguish a fresh-only creation collision from other failures */
    return failure(String(error && error.code ? error.code : "EIO"));
  }
  return { fd, size: 0, dev: 0, ino: 0, nlink: 1 };
}
function fdIdentity(fd) {
  const st = fs.fstatSync(fd);
  return { size: st.size, dev: st.dev, ino: st.ino, nlink: st.nlink };
}

/* =================== PRODUCTION adapter factory (static blocker) ============ */
/* ALWAYS fails with the fixed blocker; absolutely no caller input accepted. */
function createProductionPlatformAdapter() {
  return Object.freeze({
    ok: false,
    code: PRODUCTION_BLOCKER.code,
    description: PRODUCTION_BLOCKER.description,
    requiredCapabilities: PRODUCTION_REQUIRED_CAPABILITIES,
    observed: null  // no observed/test/qualification data can upgrade readiness
  });
}

/* ---------------------------- probe output wiring ----------------------------- */
/* Runs the ACTUAL reviewed probe script by fixed absolute module path, refuses
 * any caller-provided script, and confines probeDir under os.tmpdir(). */
function runActualNativeProbe(probeConfig) {
  const hardFail = (code) => Object.freeze({ ok: false, code, output: null });
  if (probeConfig === null || typeof probeConfig !== "object" || Array.isArray(probeConfig)) {
    return hardFail(PLATFORM_BLOCKERS.PLATFORM_MODE_INVALID);
  }
  if (Object.keys(probeConfig).length !== 1 || typeof probeConfig.probeDir !== "string" ||
      probeConfig.probeDir.length === 0) {
    return hardFail(PLATFORM_BLOCKERS.PLATFORM_MODE_INVALID);
  }
  if (path.basename(probeConfig.probeDir).length === 0) {
    return hardFail(PLATFORM_BLOCKERS.PLATFORM_MODE_INVALID);
  }
  let probeDirAbs;
  try { probeDirAbs = fs.realpathSync(probeConfig.probeDir); }
  catch (error) { return hardFail(PLATFORM_BLOCKERS.PLATFORM_PROBE_REFUSED); }
  const approved = path.resolve(process.env.LOCALAPPDATA || "", "Temp", "opencode");
  const tmpRoot = fs.realpathSync(approved);
  const requested = path.resolve(probeConfig.probeDir);
  const inside = (root, target) => { const r = path.relative(root, target); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };
  if (!process.env.LOCALAPPDATA || !inside(tmpRoot, probeDirAbs) || !inside(approved, requested)) {
    return hardFail(PLATFORM_BLOCKERS.PLATFORM_NOT_TEMP_ROOT);
  }
  // Reject junction/symlink redirection, including ancestors of the approved root.
  for (let cursor = requested; path.dirname(cursor) !== cursor; cursor = path.dirname(cursor)) {
    if (fs.lstatSync(cursor).isSymbolicLink()) return hardFail(PLATFORM_BLOCKERS.PLATFORM_NOT_TEMP_ROOT);
  }
  if (!fs.existsSync(FIXED_PROBE_SCRIPT) ||
      path.basename(FIXED_PROBE_SCRIPT) !== FIXED_PROBE_SCRIPT_BASENAME) {
    return hardFail(PLATFORM_BLOCKERS.PLATFORM_PROBE_REFUSED);
  }
  const out = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", FIXED_PROBE_SCRIPT, "-ProbeDir", probeDirAbs], {
      encoding: "utf8", timeout: PROBE_TIMEOUT_MS, windowsHide: true,
      env: { ...process.env, TEMP: approved, TMP: approved }
    });
  if (out.error || out.status !== 0) {
    return hardFail(PLATFORM_BLOCKERS.PLATFORM_PROBE_FAILED);
  }
  let raw;
  try { raw = JSON.parse(out.stdout); }
  catch (error) { return hardFail(PLATFORM_BLOCKERS.PLATFORM_PROBE_OUTPUT_INVALID); }
  return validateProbeRecord(raw);
}
function validateProbeRecord(raw) {
  const hardFail = (code) => Object.freeze({ ok: false, code, output: null });
  if (raw === null || typeof raw !== "object" || Array.isArray(raw) ||
      raw.schema !== PROBE_SCHEMA || typeof raw.platform !== "string" ||
      raw.platform !== "win32" || typeof raw.elevated !== "boolean" ||
      typeof raw.startedAt !== "string" || typeof raw.finishedAt !== "string" ||
      typeof raw.scopeNote !== "string" || !Array.isArray(raw.results)) {
    return hardFail(PLATFORM_BLOCKERS.PLATFORM_PROBE_OUTPUT_INVALID);
  }
  const results = [];
  const wantedKeys = ["capability", "scope", "outcome", "detail", "at"];
  for (const r of raw.results) {
    if (r === null || typeof r !== "object" || Array.isArray(r)) {
      return hardFail(PLATFORM_BLOCKERS.PLATFORM_PROBE_OUTPUT_INVALID);
    }
    const keys = Object.keys(r);
    if (keys.length !== wantedKeys.length) {
      return hardFail(PLATFORM_BLOCKERS.PLATFORM_PROBE_OUTPUT_INVALID);
    }
    for (const key of ["capability", "scope", "outcome", "detail", "at"]) {
      if (typeof r[key] !== "string") {
        return hardFail(PLATFORM_BLOCKERS.PLATFORM_PROBE_OUTPUT_INVALID);
      }
    }
    if (!CAPABILITIES.includes(r.capability)) {
      return hardFail(PLATFORM_BLOCKERS.PLATFORM_PROBE_OUTPUT_INVALID);
    }
    if (!["OBSERVED", "UNQUALIFIED", "UNMEASURED", "SKIPPED", "FAILED"].includes(r.outcome)) {
      return hardFail(PLATFORM_BLOCKERS.PLATFORM_PROBE_OUTPUT_INVALID);
    }
    results.push({ capability: r.capability, scope: r.scope,
      outcome: r.outcome, detail: r.detail, at: r.at });
  }
  return Object.freeze({ ok: true, code: "PROBE_RAN", platform: raw.platform,
    elevated: raw.elevated === true, output: deepFreeze({ results }) });
}

/* Build the OBSERVED-facts evidence record (no readiness semantics). */
function buildQualificationEvidence(actualProbeResult) {
  if (!actualProbeResult || actualProbeResult.ok !== true) {
    return Object.freeze({ ok: false, code: "PLATFORM_PROBE_FAILED", evidence: null });
  }
  return Object.freeze({
    ok: true,
    schema: "trigger-fork-epoch-platform-qualification/v2",
    evidence: deepFreeze({ results: actualProbeResult.output.results }),
    note: "OBSERVED is a per-call measurement only; never a production guarantee"
  });
}

module.exports = Object.freeze({
  PLATFORM_BLOCKERS,
  CAPABILITIES,
  PRODUCTION_REQUIRED_CAPABILITIES,
  PRODUCTION_BLOCKER,
  MODE_TEST,
  TEST_MODE_LABEL,
  PROBE_SCHEMA: "trigger-fork-epoch-platform-probe/v2",
  createTestPlatformAdapter,
  isRegisteredTestAdapter,
  isRegisteredEpochPlatformAdapter,
  createProductionPlatformAdapter,
  createNativeInactivePlatformAdapter,
  runActualNativeProbe,
  buildQualificationEvidence,
  deepFreeze
});
