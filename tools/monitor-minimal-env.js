#!/usr/bin/env node
"use strict";

// Central environment boundary for monitor launchers and nested monitor children.
// This module never prints values. The CLI only emits names that must be removed.

const WINDOWS_RUNTIME_NAMES = Object.freeze([
  "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "PATH", "TEMP", "TMP",
]);
const POSIX_RUNTIME_NAMES = Object.freeze([
  "PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "TZ",
]);
const SAFE_CONFIG_NAMES = Object.freeze([
  "DISABLE_EVALUATOR_PROXIMITY",
  "E1_PROXIMITY_INTERVAL_MS",
  "GLOBAL_GATES_INTERVAL_MS",
  "GLOBAL_GATES_APYUSD_INTERVAL_MS",
  "AAVE_V4_FAMILY_INJECTION",
]);
const FORBIDDEN_NAME = /NODE_OPTIONS|NODE_PATH|KEY|KEYPAIR|WALLET|SEED|MNEMONIC|SECRET|PASSWORD|PASSPHRASE|CREDENTIAL|TOKEN/i;
const SENSITIVE_ARTIFACT_KEYS = new Set([
  "privatekey", "secretkey", "keypair", "keystore", "mnemonic", "seed", "seedphrase",
  "secret", "clientsecret", "apisecret", "password", "passphrase", "token", "auth", "access",
  "session", "accesstoken", "refreshtoken", "sessiontoken", "sessionid", "sessioncookie",
  "bearertoken", "authtoken", "apitoken", "idtoken", "jwt", "jwttoken", "csrftoken",
  "xsrftoken", "clienttoken",
  "oauthtoken", "apikey", "credential", "credentials", "authorization", "proxyauthorization",
  "authorizationheader", "authenticationheader", "authheader", "cookieheader", "cookie", "cookies",
  "setcookie", "header", "headers", "endpoint",
  "endpoints", "rpc", "rpcs", "rpcurl", "rpcurls", "rpcendpoint", "rpcendpoints",
  "provider", "providers", "providerurl", "providerurls", "providerendpoint",
  "providerendpoints", "url", "urls", "websocketurl", "websocketurls", "wsurl", "wsurls",
]);
const normalizeKey = (key) => String(key).replace(/[^a-z0-9]/giu, "").toLowerCase();
const UNSAFE_CONTEXT_ROOTS = ["error", "exception", "evidence"];
const UNSAFE_CONTEXT_SUFFIXES = new Set([
  "", "s", "detail", "details", "context", "contexts", "bundle", "bundles", "data", "metadata",
  "info", "message", "messages", "payload", "payloads", "record", "records", "result", "results",
]);
const isSensitiveArtifactKey = (key) => {
  const normalized = normalizeKey(key);
  return SENSITIVE_ARTIFACT_KEYS.has(normalized)
    || (normalized.startsWith("x") && SENSITIVE_ARTIFACT_KEYS.has(normalized.slice(1)));
};
const isUnsafeArtifactContextKey = (key) => {
  const normalized = normalizeKey(key);
  return UNSAFE_CONTEXT_ROOTS.some((root) => normalized.startsWith(root) && UNSAFE_CONTEXT_SUFFIXES.has(normalized.slice(root.length)));
};
const FALSE_AUTHORIZATION_FIELDS = new Set([
  "armed", "autoExecute", "autoExecutable", "autoExecutableWhenTriggered", "autoExecutionEnabled",
  "canExecute", "executable", "executableNow", "executableWhenTriggered", "executeReady",
  "executionAllowed", "executionApproved", "executionAuthorized", "executionEnabled", "executionReady",
  "executorReady", "isExecutable", "liveExecutorReady", "readyToExecute", "routeAuthorization",
  "routeAuthorized", "signedActionJustified", "signedActions", "exploitExecuteCalls",
]);
const ZERO_AUTHORIZATION_COUNT_FIELDS = new Set(["executableNowCount"]);
const OBSERVED_AUTHORIZATION_FIELDS = new Set([
  "observedUpstreamAuthorizationSignal", "upstreamAuthorizationSignal",
  "observedUpstreamLiveExecutorSignal",
]);
const OBSERVED_INVALID_AUTHORIZATION_FIELDS = new Set([
  "observedInvalidAuthorizationSignal", "invalidUpstreamAuthorizationSignal",
]);
const AUTHORIZATION_STATES = new Set([
  "ABSENT", "INVALID", "NOT_YET_VALID", "VALID", "EXPIRED", "CONSUMED", "SCOPE_MISMATCH",
]);
const UNSAFE_MONITOR_TEXT = /(?:https?|wss?):\/\/|\bbearer\s+\S+|(?:authorization|token|secret|password|credential|api[_-]?key)\s*[:=]/iu;
// Narrow exception for machine diagnostic codes emitted under an unsafe-context key (for
// example sourceCoverage.errors): lowercase letters, digits, hyphen and underscore only,
// 1..64 characters, first character alphanumeric, no control characters, and never a
// URL/bearer/credential-keyword shape. Everything else under an unsafe context is sanitized.
const MACHINE_DIAGNOSTIC_CODE = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const isMachineDiagnosticCode = (value) => typeof value === "string"
  && MACHINE_DIAGNOSTIC_CODE.test(value)
  && !UNSAFE_MONITOR_TEXT.test(value)
  && !/[\u0000-\u001f\u007f]/u.test(value);
const AUTHORIZATION_SNAPSHOTS = new WeakMap();
function sanitizeMonitorText(value, key = "") {
  if (typeof value !== "string") return value;
  if (value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value) || UNSAFE_MONITOR_TEXT.test(value) || isUnsafeArtifactContextKey(key)) return "SANITIZED_MONITOR_TEXT";
  return value;
}

function booleanAuthorizationSignal(value) {
  return value === true || (typeof value === "number" && value > 0);
}

function countAuthorizationSignal(value) {
  return (typeof value === "number" && value > 0) || value === true;
}

function positiveAuthorizationStatus(value) {
  return typeof value === "string"
    && /armed|executable|auto-enabled/i.test(value)
    && !/(?:no|non|not|never)[-_\s]?executable/i.test(value);
}

function allowedNames(platform = process.platform) {
  return new Set([
    ...(platform === "win32" ? WINDOWS_RUNTIME_NAMES : POSIX_RUNTIME_NAMES),
    ...SAFE_CONFIG_NAMES,
  ].map((name) => name.toUpperCase()));
}

function isAllowedName(name, platform = process.platform) {
  if (typeof name !== "string" || !name || FORBIDDEN_NAME.test(name)) return false;
  return allowedNames(platform).has(name.toUpperCase());
}

function minimalMonitorEnv(source = process.env, platform = process.platform) {
  const env = {};
  for (const [name, value] of Object.entries(source || {})) {
    if (!isAllowedName(name, platform) || typeof value !== "string" || !value) continue;
    env[name] = value;
  }
  return env;
}

function namesToClear(source = process.env, platform = process.platform) {
  return Object.keys(source || {}).filter((name) => !isAllowedName(name, platform));
}

function assertMinimalEnvironment(source = process.env, platform = process.platform) {
  return namesToClear(source, platform).length === 0;
}

function canonicalAuthorization(options = {}) {
  const { authorizationRow } = require("./live-execution-batch");
  return authorizationRow(options);
}
function authorizationSnapshot(options = {}) {
  if (options && typeof options === "object" && AUTHORIZATION_SNAPSHOTS.has(options)) return AUTHORIZATION_SNAPSHOTS.get(options);
  const snapshot = canonicalAuthorization(options);
  AUTHORIZATION_SNAPSHOTS.set(snapshot, snapshot);
  return snapshot;
}
function rememberAuthorizationSnapshot(value, snapshot) {
  if (value && typeof value === "object" && snapshot && typeof snapshot === "object" && AUTHORIZATION_SNAPSHOTS.has(snapshot)) {
    AUTHORIZATION_SNAPSHOTS.set(value, AUTHORIZATION_SNAPSHOTS.get(snapshot));
  }
  return value;
}
function snapshotFor(value, options = {}) {
  if (value && typeof value === "object" && AUTHORIZATION_SNAPSHOTS.has(value)) return AUTHORIZATION_SNAPSHOTS.get(value);
  return authorizationSnapshot(options);
}
function authorizationSafetySignals(value, options = {}) {
  const canonical = authorizationSnapshot(options);
  const signals = { observedUpstreamAuthorizationSignal: false, observedInvalidAuthorizationSignal: false, authorizationState: canonical.authorizationState, batchCommitment: canonical.batchCommitment || null, scopeCommitment: canonical.scopeCommitment || null, approvedAuthorization: canonical.authorizationState === "VALID", liveBatchStatus: canonical, hardStop: false };
  function visit(current) {
    if (Array.isArray(current)) {
      for (const child of current) visit(child);
      return;
    }
    if (!current || typeof current !== "object") return;
    for (const [key, child] of Object.entries(current)) {
      if (["authorizationState", "batchCommitment", "scopeCommitment", "approval", "liveBatchStatus"].includes(key)) continue;
      if (key === "hardStop" && child === true) signals.hardStop = true;
      if (key === "authorizationState") continue;
      if (OBSERVED_AUTHORIZATION_FIELDS.has(key) && child === true) { signals.observedUpstreamAuthorizationSignal = true; signals.observedInvalidAuthorizationSignal = true; }
      if (OBSERVED_INVALID_AUTHORIZATION_FIELDS.has(key) && child === true) signals.observedInvalidAuthorizationSignal = true;
      if (FALSE_AUTHORIZATION_FIELDS.has(key)) {
        if (booleanAuthorizationSignal(child)) { signals.observedUpstreamAuthorizationSignal = true; signals.observedInvalidAuthorizationSignal = true; }
        else if (child !== false && child !== 0) signals.observedInvalidAuthorizationSignal = true;
      } else if (ZERO_AUTHORIZATION_COUNT_FIELDS.has(key)) {
        if (countAuthorizationSignal(child)) { signals.observedUpstreamAuthorizationSignal = true; signals.observedInvalidAuthorizationSignal = true; }
        else if (child !== 0) signals.observedInvalidAuthorizationSignal = true;
      } else if (/status$/i.test(key) && positiveAuthorizationStatus(child)) {
        signals.observedUpstreamAuthorizationSignal = true; signals.observedInvalidAuthorizationSignal = true;
      }
      visit(child);
    }
  }
  visit(value);
  signals.hardStop ||= signals.observedInvalidAuthorizationSignal;
  signals.hardStop ||= signals.observedUpstreamAuthorizationSignal;
  return rememberAuthorizationSnapshot(signals, canonical);
}

function authorizationSignalPresent(value, options = {}) {
  return authorizationSafetySignals(value, options).hardStop;
}

function forceMonitorOnlyArtifact(value, options = {}) {
  const fresh = snapshotFor(value, options);
  function mergeSignals(target, source) {
    target.observedUpstreamAuthorizationSignal ||= source.observedUpstreamAuthorizationSignal;
    target.observedInvalidAuthorizationSignal ||= source.observedInvalidAuthorizationSignal;
    if (source.authorizationState) {
      if (target.authorizationState && target.authorizationState !== source.authorizationState) target.observedInvalidAuthorizationSignal = true;
      else target.authorizationState = source.authorizationState;
    }
    target.hardStop ||= source.hardStop;
  }
  function visit(current, unsafeContext = false, codePreserveContext = false) {
    if (Array.isArray(current)) {
      const children = current.map((child) => visit(child, unsafeContext, codePreserveContext));
      const signals = { observedUpstreamAuthorizationSignal: false, observedInvalidAuthorizationSignal: false, authorizationState: null, approvedAuthorization: false, hardStop: false };
      for (const child of children) mergeSignals(signals, child.signals);
      signals.approvedAuthorization = false;
      signals.hardStop ||= signals.observedInvalidAuthorizationSignal;
      signals.hardStop ||= signals.observedUpstreamAuthorizationSignal;
      return {
        value: children.map((child) => child.value),
        signals,
      };
    }
    const signals = { observedUpstreamAuthorizationSignal: false, observedInvalidAuthorizationSignal: false, authorizationState: null, approvedAuthorization: false, hardStop: false };
    if (!current || typeof current !== "object") return {
      value: unsafeContext && typeof current === "string" && !(codePreserveContext && isMachineDiagnosticCode(current))
        ? "SANITIZED_MONITOR_TEXT"
        : sanitizeMonitorText(current),
      signals,
    };
    const out = {};
    for (const [key, child] of Object.entries(current)) {
      if (["authorizationState", "batchCommitment", "scopeCommitment", "approval", "liveBatchStatus"].includes(key)) continue;
      const childUnsafeContext = unsafeContext || isUnsafeArtifactContextKey(key);
      const childCodePreserveContext = isUnsafeArtifactContextKey(key);
      if (isSensitiveArtifactKey(key)) { out[key] = "REDACTED_SENSITIVE_SUBTREE"; continue; }
      const nested = visit(child, childUnsafeContext, childCodePreserveContext);
      mergeSignals(signals, nested.signals);
      if (key === "hardStop" && child === true) signals.hardStop = true;
      if (OBSERVED_AUTHORIZATION_FIELDS.has(key) && child === true) { signals.observedUpstreamAuthorizationSignal = true; signals.observedInvalidAuthorizationSignal = true; }
      if (OBSERVED_INVALID_AUTHORIZATION_FIELDS.has(key) && child === true) signals.observedInvalidAuthorizationSignal = true;
      if (ZERO_AUTHORIZATION_COUNT_FIELDS.has(key)) {
        if (countAuthorizationSignal(child)) { signals.observedUpstreamAuthorizationSignal = true; signals.observedInvalidAuthorizationSignal = true; }
        else if (child !== 0) signals.observedInvalidAuthorizationSignal = true;
        out[key] = 0;
      } else if (FALSE_AUTHORIZATION_FIELDS.has(key)) {
        if (booleanAuthorizationSignal(child)) { signals.observedUpstreamAuthorizationSignal = true; signals.observedInvalidAuthorizationSignal = true; }
        else if (child !== false && child !== 0) signals.observedInvalidAuthorizationSignal = true;
        out[key] = false;
      } else if (/status$/i.test(key) && positiveAuthorizationStatus(child)) {
        signals.observedUpstreamAuthorizationSignal = true; signals.observedInvalidAuthorizationSignal = true;
        out[key] = "watch-only-upstream-signal-observed";
      } else out[key] = childUnsafeContext && typeof nested.value === "string"
        ? (childCodePreserveContext && isMachineDiagnosticCode(nested.value) ? nested.value : "SANITIZED_MONITOR_TEXT")
        : sanitizeMonitorText(nested.value, key);
    }
    signals.authorizationState = null;
    signals.approvedAuthorization = false;
    signals.hardStop ||= signals.observedInvalidAuthorizationSignal;
    signals.hardStop ||= signals.observedUpstreamAuthorizationSignal;
    if (signals.observedUpstreamAuthorizationSignal) out.observedUpstreamAuthorizationSignal = true;
    if (signals.observedInvalidAuthorizationSignal) out.observedInvalidAuthorizationSignal = true;
    if (signals.hardStop) out.hardStop = true;
    return { value: out, signals };
  }
  const result = visit(value).value;
  if (result && typeof result === "object" && !Array.isArray(result)) result.liveBatchStatus = fresh;
  return rememberAuthorizationSnapshot(result, fresh);
}

function cli(argv = process.argv.slice(2)) {
  if (argv.length !== 1) throw new Error("exactly one environment-safety command is required");
  if (argv[0] === "--names-to-clear") {
    for (const name of namesToClear()) process.stdout.write(`${name}\n`);
    return;
  }
  if (argv[0] === "--assert-current") {
    if (!assertMinimalEnvironment()) throw new Error("environment isolation failed");
    return;
  }
  throw new Error("unsupported environment-safety command");
}

if (require.main === module) {
  try {
    cli();
  } catch (error) {
    process.stderr.write(`monitor-minimal-env: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  SAFE_CONFIG_NAMES,
  WINDOWS_RUNTIME_NAMES,
  POSIX_RUNTIME_NAMES,
  isAllowedName,
  minimalMonitorEnv,
  namesToClear,
  assertMinimalEnvironment,
  authorizationSafetySignals,
  canonicalAuthorization,
  rememberAuthorizationSnapshot,
  sanitizeMonitorText,
  authorizationSignalPresent,
  forceMonitorOnlyArtifact,
  cli,
};
