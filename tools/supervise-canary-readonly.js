"use strict";

// Exact read-only triplet only. No restart, signer, dispatcher or route authority.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { spawn: nodeSpawn, spawnSync } = require("node:child_process");
const { snapshotCanaryReadonlyTriplet } = require("./lib/canary-readonly-triplet.js");
const { acquireCanaryOutputOwner, LOCK_NAME } = require("./lib/canary-output-owner.js");
const { STOP_MESSAGE_TYPE, READY_MESSAGE_TYPE } = require("./lib/canary-readonly-stop.js");

const SURFACES = Object.freeze(["dedicated", "multichain", "divergence"]);
const HISTORY = Object.freeze({ dedicated: "history.json", multichain: "history-multichain.json",
  divergence: "history-divergence.json" });
const SCRIPT = Object.freeze({ dedicated: "monitor-exploit-rearm-canary.js",
  multichain: "monitor-rearm-canary-multichain.js", divergence: "monitor-oracle-divergence.js" });
const DEFAULT_OUT_DIR = path.resolve(__dirname, "..", "reports");
const PILOT_MS = 24 * 60 * 60 * 1000;
const CHILD_MAX_HOURS = 23;
const CHILD_MS = CHILD_MAX_HOURS * 60 * 60 * 1000;
const MULTICHAIN_BATCH_EXPIRES_MS = Date.parse("2026-10-25T22:10:00.000Z");
const HEALTH_MS = 30000;
// Multichain historical catch-up is slower than the 60-second polling interval.
const STALE_MS = 30 * 60 * 1000;
const STOP_MS = 75000;
const JOIN_RETRY_MS = 120000;
const LAUNCH_BASELINE = path.resolve(__dirname, "..", "reports", "raw", "fast",
  "all-sentinels-coverage-20260926", "coverage-r3.json");
const LAUNCH_SHA256 = "9bd9ddb6a622c3dbfdea0f90e5491374f2473888b1e1d24ef3180d0bf1b9886a";
const PINNED_DIVERGENCE_SHA256 = "ed62283d99d674f61d445c49a3cda4bfb021cb7fb684b900299cd7d738bf549a";
const SOURCE_CONSTANT_SHA256 = "d8e47e5034747b901007f6d47c5a07b431fb99a8fb2f73af70466575aa6fa5bd";
const LAUNCH_COUNTS = Object.freeze({ dedicated: 3, multichain: 67, divergence: 351 });
const GUARDIAN_PREFIX = "CANARY_READONLY_GUARDIAN_V2 \\\\.\\pipe\\";
const GUARDIAN_MAX_BYTES = 192;
const GUARDIAN_VERIFIER = "C:\\Users\\MiPC\\AppData\\Local\\Temp\\opencode\\canary-readonly-guardian-win32.exe";
const issuedGuardianReceipts = new WeakSet();
const DIAGNOSTIC_NAME = "startup-diagnostic.json";
const DIAGNOSTIC_PHASES = new Set(["RECEIPT_ISSUED", "OWNER_ACQUIRED", "SEED_VALIDATED",
  "PINNED_JOINED", "CHILD_SPAWNED", "CHILD_READY", "MONITORING_JOINED", "EXIT"]);
const DIAGNOSTIC_REASONS = new Set(["NONE", "OWNER_ACQUIRE_FAILED", "STARTUP_INVALID",
  "SEED_INVALID", "BASELINE_INVALID", "PINNED_INVALID", "DEADLINE_BLOCKED",
  "CHILD_EARLY_EXIT", "CHILD_START_UNVERIFIED", "CHILD_EXIT", "CHILD_LOCK_LOST",
  "PRODUCER_LOCK_PRESENT", "STATUS_STALE", "HEALTH_INVALID", "OBSERVATION_DRIFT",
  "JOIN_RETRY_EXPIRED", "ATTENDED_RECOVERY_REQUIRED", "WRAPPER_RELEASE_UNVERIFIED",
  "CHILD_STOP_ERROR", "PILOT_EXPIRED", "SIGNAL_STOP"]);

function reject(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exactDirectory(directory) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) throw reject("DIRECTORY_REQUIRED");
  const resolved = path.resolve(directory);
  if (resolved === path.parse(resolved).root) throw reject("DIRECTORY_INVALID");
  let component = path.parse(resolved).root;
  for (const part of resolved.slice(component.length).split(path.sep).filter(Boolean)) {
    component = path.join(component, part);
    let stat;
    try { stat = fs.lstatSync(component); } catch (_) { throw reject("DIRECTORY_INVALID"); }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw reject("DIRECTORY_INVALID");
  }
  return fs.realpathSync.native(resolved);
}
function under(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

// A one-use, native-verified receipt is the only production entry to this writer.
// Diagnostics are not authority and must never perturb ownership or shutdown.
function startupDiagnostic(options) {
  let wrapper;
  try {
    wrapper = exactDirectory(options.wrapperDir);
    const directories = SURFACES.map((surface) => exactDirectory(options.directories[surface]));
    if (new Set([wrapper, ...directories]).size !== 4 ||
        [wrapper, ...directories].some((dir) => under(DEFAULT_OUT_DIR, dir))) return () => {};
  } catch (_) { return () => {}; }
  return (phase, reason = "NONE") => {
    if (!DIAGNOSTIC_PHASES.has(phase) || !DIAGNOSTIC_REASONS.has(reason)) return;
    let temporary;
    try {
      if (exactDirectory(wrapper) !== wrapper) return;
      const data = JSON.stringify({ phase, reason, at: new Date().toISOString() }) + "\n";
      temporary = path.join(wrapper, `.${DIAGNOSTIC_NAME}.${crypto.randomBytes(12).toString("hex")}.tmp`);
      fs.writeFileSync(temporary, data, { flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, path.join(wrapper, DIAGNOSTIC_NAME));
      temporary = undefined;
    } catch (_) { /* Failure to write telemetry never changes owner semantics. */ }
    finally { if (temporary) { try { fs.unlinkSync(temporary); } catch (_) { /* no cleanup authority */ } } }
  };
}

function startupRejectReason(code) {
  if (code === "CHILD_EARLY_EXIT" || code === "CHILD_START_UNVERIFIED" ||
      code === "PRODUCER_LOCK_PRESENT") return code;
  if (code === "CHILD_DEADLINE_BLOCKED") return "DEADLINE_BLOCKED";
  if (code === "LAUNCH_BASELINE_INVALID") return "BASELINE_INVALID";
  if (code === "PINNED_UNIVERSE_SOURCE_INVALID" || code === "PINNED_UNIVERSE_JOIN_INVALID" ||
      (typeof code === "string" && code.startsWith("PINNED_UNIVERSE_"))) return "PINNED_INVALID";
  return "SEED_INVALID";
}

function validateSeed({ baselinePath, directories, wrapperDir, nowMs = Date.now(),
  maxAgeMs = STALE_MS } = {}) {
  if (!isObject(directories) || typeof baselinePath !== "string" || !path.isAbsolute(baselinePath)) {
    throw reject("PATHS_REQUIRED");
  }
  const mapped = {};
  for (const surface of SURFACES) mapped[surface] = exactDirectory(directories[surface]);
  const wrapper = exactDirectory(wrapperDir);
  if (new Set([...Object.values(mapped), wrapper]).size !== 4 ||
      [...Object.values(mapped), wrapper].some((dir) => under(DEFAULT_OUT_DIR, dir))) {
    throw reject("DIRECTORIES_NOT_ISOLATED");
  }
  const sources = Object.fromEntries(SURFACES.map((surface) => [surface, {
    statusPath: path.join(mapped[surface], "status.json"),
    historyPath: path.join(mapped[surface], HISTORY[surface]),
  }]));
  const baseline = path.resolve(baselinePath);
  if (Object.values(sources).some(({ statusPath, historyPath }) => baseline === statusPath || baseline === historyPath)) {
    throw reject("BASELINE_OVERLAPS_OUTPUT");
  }
  // Any existing lock is forbidden, even if stale, malformed, or not owned by
  // a running process. No lock theft, cleanup, or producer startup occurs.
  for (const dir of Object.values(mapped)) {
    try { fs.lstatSync(path.join(dir, LOCK_NAME)); throw reject("PRODUCER_LOCK_PRESENT"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const verdict = snapshotCanaryReadonlyTriplet({ baselinePath: baseline, sources, nowMs, maxAgeMs });
  // Incomplete observations are precisely what a read-only monitor may need
  // to observe. Identity drift is different: refuse even a dormant snapshot.
  if (SURFACES.some((surface) => verdict.surfaces[surface].missingIds.length ||
      verdict.surfaces[surface].newIds.length)) throw reject("SEED_IDENTITY_DRIFT");
  const commands = Object.fromEntries(SURFACES.map((surface) => [surface, {
    executable: process.execPath, script: path.join(__dirname, SCRIPT[surface]),
    args: ["--out", sources[surface].statusPath, "--loop", "60", "--keep-watching-on-fire",
      "--supervised-readonly", "--max-hours", String(CHILD_MAX_HOURS),
      ...(surface === "divergence" ? ["--pinned-universe"] : [])],
  }]));
  return { state: verdict.coverageComplete ? "PREFLIGHT_ONLY_LIFECYCLE_DISABLED" :
    "PREFLIGHT_DEGRADED_LIFECYCLE_DISABLED",
    validatorBoundary: verdict.validatorBoundary,
    trackedBaselineCount: verdict.trackedBaselineCount, sourceRowCounts: verdict.sourceRowCounts,
    generation: verdict.generation, hashes: verdict.hashes, commands, surfaces: verdict.surfaces,
    coverageComplete: verdict.coverageComplete, routeProven: false, profitProven: false, dispatchAllowed: false,
    monitoringOnly: true, noSpawn: true, noRestart: true };
}

function preflightReadonlyCanary(options = {}) {
  const wrapper = exactDirectory(options.wrapperDir);
  const owner = acquireCanaryOutputOwner(path.join(wrapper, "supervisor-readonly.json"));
  try { owner.check(); return validateSeed({ maxAgeMs: 120000, ...options }); }
  finally { if (!owner.release()) throw reject("WRAPPER_RELEASE_UNVERIFIED"); }
}

function childLocksReleased(directories) {
  return SURFACES.every((surface) => {
    try { fs.lstatSync(path.join(directories[surface], LOCK_NAME)); return false; }
    catch (error) { return error.code === "ENOENT"; }
  });
}

function childLockMatches(record, directory) {
  try {
    const lock = path.join(directory, LOCK_NAME);
    const stat = fs.lstatSync(lock);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    const ownerFile = path.join(lock, "owner.json");
    const ownerStat = fs.lstatSync(ownerFile);
    if (!ownerStat.isFile() || ownerStat.isSymbolicLink() || ownerStat.size > 256) return false;
    const metadata = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
    if (metadata.pid !== record.child.pid || typeof metadata.token !== "string" ||
        !/^[a-f0-9]{64}$/u.test(metadata.token)) return false;
    if (!record.lock) record.lock = { dev: stat.dev, ino: stat.ino, token: metadata.token };
    return record.lock.dev === stat.dev && record.lock.ino === stat.ino &&
      record.lock.token === metadata.token;
  } catch (_) { return false; }
}

function baselineMatches(file, digest) {
  let fd;
  try {
    let component = path.parse(path.resolve(file)).root;
    for (const part of path.resolve(file).slice(component.length).split(path.sep).filter(Boolean)) {
      component = path.join(component, part);
      if (fs.lstatSync(component).isSymbolicLink()) return false;
    }
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024) return false;
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.size !== stat.size || opened.dev !== stat.dev || opened.ino !== stat.ino) return false;
    const hash = crypto.createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let size = 0;
    while (true) {
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      size += count;
      if (size > 32 * 1024 * 1024) return false;
      hash.update(chunk.subarray(0, count));
    }
    const after = fs.fstatSync(fd);
    return size === opened.size && after.size === size && after.mtimeMs === opened.mtimeMs &&
      hash.digest("hex") === digest;
  } catch (_) { return false; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function assertLaunchBaseline(baselinePath, verdict) {
  if (typeof baselinePath !== "string" || path.resolve(baselinePath) !== LAUNCH_BASELINE ||
      verdict.hashes.baseline !== LAUNCH_SHA256 || verdict.trackedBaselineCount !== 421 ||
      SURFACES.some((surface) => verdict.sourceRowCounts[surface] !== LAUNCH_COUNTS[surface])) {
    throw reject("LAUNCH_BASELINE_INVALID");
  }
}

function loadLivePinnedUniverse() {
  // Reload the pinned source bytes on every join; never trust a cached result
  // or a dynamically supplied path. The loader must reject changed source.
  const pinned = require("./lib/pinned-divergence-universe.js").loadPinnedDivergenceUniverse();
  if (!pinned || pinned.sha256 !== PINNED_DIVERGENCE_SHA256 ||
      pinned.sourceConstantSha256 !== SOURCE_CONSTANT_SHA256 ||
      !Array.isArray(pinned.rows) || pinned.rows.length !== LAUNCH_COUNTS.divergence ||
      pinned.rows.some((row) => typeof row.provenanceConstant !== "boolean")) {
    throw reject("PINNED_UNIVERSE_SOURCE_INVALID");
  }
  return pinned;
}

function receiveGuardianReceipt() {
  if (process.platform !== "win32" || process.stdin.isTTY) {
    return Promise.reject(reject("GUARDIAN_REQUIRED"));
  }
  return new Promise((resolve, rejectReceipt) => {
    let count = 0;
    const chunks = [];
    let settled = false;
    const stream = process.stdin;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("close", onClose);
      stream.off("error", onClose);
      stream.pause();
      if (!ok) { rejectReceipt(reject("GUARDIAN_REQUIRED")); return; }
      const bytes = Buffer.concat(chunks, count);
      const text = bytes.toString("ascii");
      if (!text.startsWith(GUARDIAN_PREFIX) || !text.endsWith("\n")) {
        rejectReceipt(reject("GUARDIAN_REQUIRED")); return;
      }
      const name = text.slice(GUARDIAN_PREFIX.length, -1);
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(name)) {
        rejectReceipt(reject("GUARDIAN_REQUIRED")); return;
      }
      const locator = text.slice("CANARY_READONLY_GUARDIAN_V2 ".length, -1);
      const env = process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {};
      const verified = spawnSync(GUARDIAN_VERIFIER, ["--verify", locator], {
        env, stdio: "ignore", windowsHide: true, shell: false, timeout: 10000,
      });
      if (verified.error || verified.signal || verified.status !== 0) {
        rejectReceipt(reject("GUARDIAN_REQUIRED")); return;
      }
      const receipt = Object.freeze({});
      issuedGuardianReceipts.add(receipt);
      resolve(receipt);
    };
    const onData = (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (count + bytes.length > GUARDIAN_MAX_BYTES || bytes.some((byte) => byte > 0x7f)) {
        finish(false); return;
      }
      chunks.push(bytes);
      count += bytes.length;
    };
    const onEnd = () => finish(count > 0);
    const onClose = () => finish(false);
    const timer = setTimeout(() => finish(false), 5000);
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("close", onClose);
    stream.once("error", onClose);
    stream.resume();
  });
}

// Dependency injection is for offline tests only. The CLI always uses the fixed
// implementation and never accepts a command, environment, or manifest input.
async function startReadonlyCanary(options = {}, dependencies = {}, guardianReceipt) {
  const offlineFixture = !!(dependencies.spawn && dependencies.now && dependencies.wait && dependencies.stop);
  let diagnostic = () => {};
  let diagnosticPhase = "RECEIPT_ISSUED";
  let diagnosticFailure = "NONE";
  const note = (phase, reason = "NONE") => {
    diagnosticPhase = phase;
    if (reason !== "NONE") diagnosticFailure = reason;
    diagnostic(phase, reason);
  };
  if (!offlineFixture) {
    if (process.platform !== "win32" || !guardianReceipt || !issuedGuardianReceipts.has(guardianReceipt)) {
      throw reject("GUARDIAN_REQUIRED");
    }
    issuedGuardianReceipts.delete(guardianReceipt);
    diagnostic = startupDiagnostic(options);
    note("RECEIPT_ISSUED");
  }
  const now = dependencies.now || Date.now;
  const elapsed = dependencies.elapsed || (dependencies.now ? now : () => performance.now());
  const wait = dependencies.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const spawn = dependencies.spawn || nodeSpawn;
  const stop = dependencies.stop || ((child, callback) => child.send({ type: STOP_MESSAGE_TYPE }, callback));
  const started = elapsed();
  const wrapper = exactDirectory(options.wrapperDir);
  let owner;
  try { owner = acquireCanaryOutputOwner(path.join(wrapper, "supervisor-readonly.json")); }
  catch (error) { note("RECEIPT_ISSUED", "OWNER_ACQUIRE_FAILED"); throw error; }
  note("OWNER_ACQUIRED");
  const owned = [];
  let wake;
  let event = new Promise((resolve) => { wake = resolve; });
  let reason = "PILOT_EXPIRED";
  let initial;
  let sources;
  let shuttingDown = false;
  const signalHandler = () => { if (!shuttingDown) { reason = "SIGNAL_STOP"; wake(); } };
  const onSignal = dependencies.signal || process;
  onSignal.on("SIGINT", signalHandler);
  onSignal.on("SIGTERM", signalHandler);
  try {
    owner.check();
    if (now() + CHILD_MS >= MULTICHAIN_BATCH_EXPIRES_MS) throw reject("CHILD_DEADLINE_BLOCKED");
    initial = validateSeed({ ...options, nowMs: now(), maxAgeMs: STALE_MS });
    note("SEED_VALIDATED");
    sources = Object.fromEntries(SURFACES.map((surface) => [surface, {
      statusPath: initial.commands[surface].args[1],
      historyPath: path.join(path.dirname(initial.commands[surface].args[1]), HISTORY[surface]),
    }]));
    if (!offlineFixture) {
      assertLaunchBaseline(options.baselinePath, initial);
      const joined = snapshotCanaryReadonlyTriplet({ baselinePath: options.baselinePath,
        sources, pinnedDivergenceUniverse: loadLivePinnedUniverse(), nowMs: now(), maxAgeMs: STALE_MS });
      if (joined.validatorBoundary !== "PINNED_DIVERGENCE_JOIN_ONLY") throw reject("PINNED_UNIVERSE_JOIN_INVALID");
      initial.generation = joined.generation;
      initial.hashes = joined.hashes;
      note("PINNED_JOINED");
    }
    const env = {};
    if (process.platform === "win32" && typeof process.env.SystemRoot === "string") {
      env.SystemRoot = process.env.SystemRoot;
    }
    for (const surface of SURFACES) {
      owner.check();
      if (reason === "SIGNAL_STOP" || elapsed() - started >= PILOT_MS) break;
      if (now() + CHILD_MS >= MULTICHAIN_BATCH_EXPIRES_MS) throw reject("CHILD_DEADLINE_BLOCKED");
      if (owned.some((record) => record.exited || record.closed || record.failed)) {
        throw reject("CHILD_EARLY_EXIT");
      }
      if (fs.existsSync(path.join(options.directories[surface], LOCK_NAME))) {
        throw reject("PRODUCER_LOCK_PRESENT");
      }
      const command = initial.commands[surface];
      const child = spawn(command.executable, ["--use-system-ca", command.script, ...command.args], {
        cwd: __dirname, env: { ...env }, stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
      });
      if (!child || typeof child.on !== "function" || typeof child.send !== "function" ||
          !Number.isSafeInteger(child.pid) || child.pid <= 0) {
        throw reject("CHILD_HANDLE_INVALID");
      }
      const record = { surface, child, ready: false, exited: false, closed: false,
        failed: false, sendPending: false, stopSent: false };
      owned.push(record);
      note("CHILD_SPAWNED");
      child.on("message", (message) => {
        if (!message || typeof message !== "object" || Array.isArray(message) ||
            Object.keys(message).length !== 1 || message.type !== READY_MESSAGE_TYPE ||
            record.ready || record.exited || record.closed ||
            !childLockMatches(record, options.directories[record.surface])) {
          record.failed = true;
        } else record.ready = true;
        wake();
      });
      child.once("exit", (code, signal) => { record.exited = true; record.failed ||= code !== 0 || !!signal; wake(); });
      child.once("close", () => { record.closed = true; wake(); });
      child.on("error", () => { record.failed = true; wake(); });
      // Yield before another spawn so an already-failed handle is observed.
      await new Promise((resolve) => setImmediate(resolve));
    }
    // Children acquire their own exclusive locks asynchronously during startup.
    // Never accept a foreign PID or a replacement inode as their lock.
    const lockDeadline = elapsed() + 30000;
    while (owned.some((record) => !record.ready || !childLockMatches(record, options.directories[record.surface]))) {
      owner.check();
      if (owned.some((record) => record.exited || record.closed || record.failed) || elapsed() >= lockDeadline ||
          reason === "SIGNAL_STOP") throw reject("CHILD_START_UNVERIFIED");
      const pending = event;
      await Promise.race([wait(Math.min(1000, lockDeadline - elapsed())), pending]);
      if (event === pending) event = new Promise((resolve) => { wake = resolve; });
    }
    note("CHILD_READY");
    // An initial observation may be incomplete, but it must still be joined.
    let incompleteSince = null;
    while (true) {
      owner.check();
      if (reason === "SIGNAL_STOP" || elapsed() - started >= PILOT_MS) break;
      if (owned.some((record) => record.exited || record.closed || record.failed || !record.ready)) {
        reason = "CHILD_EXIT"; break;
      }
      if (owned.some((record) => !childLockMatches(record, options.directories[record.surface]))) {
        reason = "CHILD_LOCK_LOST"; break;
      }
      if (!baselineMatches(options.baselinePath, initial.hashes.baseline)) {
        reason = "OBSERVATION_DRIFT"; break;
      }
      let verdict;
      try { verdict = snapshotCanaryReadonlyTriplet({ baselinePath: options.baselinePath,
        sources, ...(offlineFixture ? {} : { pinnedDivergenceUniverse: loadLivePinnedUniverse() }),
        nowMs: now(), maxAgeMs: STALE_MS }); }
      catch (error) {
        if (!["FILE_CHANGED_OR_OVERSIZE", "JSON_INVALID", "HISTORY_LATEST_MISMATCH"].includes(error.code)) throw error;
        if (incompleteSince === null) incompleteSince = elapsed();
        if (elapsed() - incompleteSince >= JOIN_RETRY_MS) { reason = "JOIN_RETRY_EXPIRED"; break; }
        const pending = event;
        await Promise.race([wait(Math.min(1000, JOIN_RETRY_MS - (elapsed() - incompleteSince),
          PILOT_MS - (elapsed() - started))), pending]);
        if (event === pending) event = new Promise((resolve) => { wake = resolve; });
        continue;
      }
      incompleteSince = null;
      if (verdict.validatorBoundary !== (offlineFixture ? "MINIMAL_SHAPE_JOIN_ONLY" :
        "PINNED_DIVERGENCE_JOIN_ONLY") ||
          verdict.hashes.baseline !== initial.hashes.baseline ||
          SURFACES.some((surface) => verdict.surfaces[surface].missingIds.length ||
            verdict.surfaces[surface].newIds.length ||
            verdict.generation[surface] < initial.generation[surface] ||
            (verdict.generation[surface] === initial.generation[surface] &&
              (verdict.hashes[surface].status !== initial.hashes[surface].status ||
                verdict.hashes[surface].history !== initial.hashes[surface].history)))) {
        reason = "OBSERVATION_DRIFT"; break;
      }
      for (const surface of SURFACES) {
        initial.generation[surface] = verdict.generation[surface];
        initial.hashes[surface] = verdict.hashes[surface];
      }
      note("MONITORING_JOINED");
      const pending = event;
      await Promise.race([wait(Math.min(HEALTH_MS, Math.max(0, PILOT_MS - (elapsed() - started)))), pending]);
      if (event === pending) event = new Promise((resolve) => { wake = resolve; });
    }
  } catch (error) {
    note(diagnosticPhase, owned.length ?
      (error.code === "CHILD_EARLY_EXIT" || error.code === "CHILD_START_UNVERIFIED" ? error.code : "HEALTH_INVALID") :
      startupRejectReason(error.code));
    if (!(reason === "SIGNAL_STOP" && error.code === "CHILD_START_UNVERIFIED")) {
      reason = error.code === "RUN_STALE_OR_INVALID" ? "STATUS_STALE" :
      error.code === "PRODUCER_LOCK_PRESENT" ? "PRODUCER_LOCK_PRESENT" :
      owned.length ? "HEALTH_INVALID" : "STARTUP_INVALID";
    }
  } finally { shuttingDown = true; /* Keep signal handlers until all owned children finish shutdown. */ }
  // A stop sent before listener installation could be lost. Queue the intent
  // until the exact child reports ready, then send once; never kill or restart.
  const stopDeadline = elapsed() + STOP_MS;
  while (owned.some((record) => !record.ready || !record.closed || record.sendPending) ||
      !childLocksReleased(options.directories)) {
    for (const record of owned.filter((item) => item.ready && !item.stopSent && !item.exited && !item.closed)) {
      record.stopSent = true;
      if (!record.child.connected) { record.failed = true; continue; }
      record.sendPending = true;
      try {
        stop(record.child, (error) => {
          record.sendPending = false;
          if (error) record.failed = true;
          wake();
        }, record.surface);
      } catch (_) { record.sendPending = false; record.failed = true; }
    }
    if (elapsed() >= stopDeadline) break;
    const pending = event;
    await Promise.race([wait(Math.min(250, stopDeadline - elapsed())), pending]);
    if (event === pending) event = new Promise((resolve) => { wake = resolve; });
  }
  const clean = owned.every((record) => record.ready && record.closed && !record.sendPending) &&
    childLocksReleased(options.directories);
  const released = clean && owner.release();
  onSignal.off("SIGINT", signalHandler);
  onSignal.off("SIGTERM", signalHandler);
  const result = { state: released && !owned.some((record) => record.failed) &&
      (reason === "PILOT_EXPIRED" || reason === "SIGNAL_STOP") ?
    "STOPPED" : "DEGRADED", code: !clean ? "ATTENDED_RECOVERY_REQUIRED" :
      !released ? "WRAPPER_RELEASE_UNVERIFIED" : owned.some((record) => record.failed) ?
        (reason === "CHILD_EXIT" ? "CHILD_EXIT" : "CHILD_STOP_ERROR") : reason,
    validatorBoundary: offlineFixture ? "MINIMAL_SHAPE_JOIN_ONLY" : "PINNED_DIVERGENCE_JOIN_ONLY",
    monitoringOnly: true, routeProven: false,
    profitProven: false, dispatchAllowed: false, noRestart: true };
  note("EXIT", diagnosticFailure !== "NONE" &&
    (result.code === "STARTUP_INVALID" || result.code === "HEALTH_INVALID" ||
      result.code === "ATTENDED_RECOVERY_REQUIRED") ? diagnosticFailure :
    DIAGNOSTIC_REASONS.has(result.code) ? result.code : "STARTUP_INVALID");
  return result;
}

function parseCli(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--run-readonly" || flag === "--preflight") {
      if (values[flag]) throw reject("CLI_INVALID");
      values[flag] = true;
    } else if (["--baseline", "--dedicated-dir", "--multichain-dir", "--divergence-dir", "--wrapper-dir"].includes(flag)) {
      if (values[flag] || !argv[i + 1] || argv[i + 1].startsWith("--")) throw reject("CLI_INVALID");
      values[flag] = argv[++i];
    } else throw reject("CLI_INVALID");
  }
  if (values["--run-readonly"] === values["--preflight"]) throw reject("EXPLICIT_MODE_REQUIRED");
  return { runReadonly: !!values["--run-readonly"], baselinePath: values["--baseline"], wrapperDir: values["--wrapper-dir"],
    directories: { dedicated: values["--dedicated-dir"], multichain: values["--multichain-dir"],
      divergence: values["--divergence-dir"] } };
}

if (require.main === module) {
  (async () => {
    try {
    const options = parseCli(process.argv.slice(2));
    const result = options.runReadonly ?
      await startReadonlyCanary(options, {}, await receiveGuardianReceipt()) : preflightReadonlyCanary(options);
    // Never log paths, environment, producer output, raw errors or credentials.
    console.log(JSON.stringify({ state: result.state, trackedBaselineCount: result.trackedBaselineCount,
      ...(options.runReadonly ? {} : { sourceRowCounts: result.sourceRowCounts,
        coverageComplete: result.coverageComplete,
        surfaces: Object.fromEntries(SURFACES.map((surface) => [surface, {
          ok: result.surfaces[surface].ok, fired: result.surfaces[surface].fired,
          incomplete: result.surfaces[surface].incomplete }])) }),
      routeProven: false, dispatchAllowed: false,
      ...(options.runReadonly ? { code: result.code } : { noSpawn: true }) }));
    if (result.state === "DEGRADED") process.exitCode = 1;
  } catch (_) {
    console.error("READONLY_CANARY_REJECTED");
    process.exitCode = 1;
  }
  })();
}

module.exports = { preflightReadonlyCanary, startReadonlyCanary, parseCli, assertLaunchBaseline };
