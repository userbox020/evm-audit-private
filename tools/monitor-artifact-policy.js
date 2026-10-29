"use strict";

const fs = require("fs");
const path = require("path");

const ARTIFACT_STATUS = Object.freeze({
  VALID_FRESH: "VALID_FRESH",
  VALID_STALE: "VALID_STALE",
  MISSING: "MISSING",
  MALFORMED: "MALFORMED",
  SCHEMA_INVALID: "SCHEMA_INVALID",
  FUTURE_TIMESTAMP: "FUTURE_TIMESTAMP",
  INCOMPLETE: "INCOMPLETE",
});

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_FUTURE_SKEW_MS = 5 * 60_000;
const FORBIDDEN_BASENAMES = /^(?:\.env(?:\..*)?|.*(?:private[-_]?key|keypair).*|.*\.(?:pem|key))$/i;

function result(status, fields = {}) {
  return { status, valid: status === ARTIFACT_STATUS.VALID_FRESH, fresh: status === ARTIFACT_STATUS.VALID_FRESH, ...fields };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function valueAt(object, dottedPath) {
  return String(dottedPath).split(".").reduce((value, key) => value?.[key], object);
}

function timestampValue(data, fields) {
  for (const field of fields) {
    const value = valueAt(data, field);
    if (value !== undefined && value !== null && value !== "") return { field, value };
  }
  return null;
}

function assessArtifactObject(data, options = {}) {
  if (!isPlainObject(data)) return result(ARTIFACT_STATUS.SCHEMA_INVALID, { error: "artifact must be an object" });

  const requiredPaths = Array.isArray(options.requiredPaths) ? options.requiredPaths : [];
  const missing = requiredPaths.filter((field) => valueAt(data, field) === undefined || valueAt(data, field) === null);
  if (missing.length) return result(ARTIFACT_STATUS.INCOMPLETE, { error: "required fields missing", missing });

  const timestampFields = Array.isArray(options.timestampFields) && options.timestampFields.length
    ? options.timestampFields
    : ["generatedAt"];
  const timestamp = timestampValue(data, timestampFields);
  if (!timestamp) return result(ARTIFACT_STATUS.INCOMPLETE, { error: "generated timestamp missing" });

  const generatedMs = Date.parse(timestamp.value);
  if (!Number.isFinite(generatedMs)) {
    return result(ARTIFACT_STATUS.SCHEMA_INVALID, { error: "generated timestamp invalid", timestampField: timestamp.field });
  }

  if (typeof options.validate === "function") {
    let validation;
    try { validation = options.validate(data); }
    catch (_) { validation = false; }
    if (validation !== true) {
      const error = typeof validation === "string" ? validation : validation?.error || "artifact schema invalid";
      const status = validation?.incomplete ? ARTIFACT_STATUS.INCOMPLETE : ARTIFACT_STATUS.SCHEMA_INVALID;
      return result(status, { error, generatedAt: new Date(generatedMs).toISOString(), timestampField: timestamp.field });
    }
  }

  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const maxAgeMs = Number.isFinite(options.maxAgeMs) ? Math.max(0, options.maxAgeMs) : Infinity;
  const maxFutureSkewMs = Number.isFinite(options.maxFutureSkewMs)
    ? Math.max(0, options.maxFutureSkewMs)
    : DEFAULT_FUTURE_SKEW_MS;
  const ageMs = nowMs - generatedMs;
  const common = { data, generatedAt: new Date(generatedMs).toISOString(), timestampField: timestamp.field, ageMs };

  if (ageMs < -maxFutureSkewMs) return result(ARTIFACT_STATUS.FUTURE_TIMESTAMP, { ...common, error: "generated timestamp is in the future" });
  if (ageMs > maxAgeMs) return result(ARTIFACT_STATUS.VALID_STALE, common);
  return result(ARTIFACT_STATUS.VALID_FRESH, common);
}

function pathIsAllowed(filePath) {
  const segments = path.resolve(String(filePath || "")).split(/[\\/]+/);
  return !segments.some((segment) => FORBIDDEN_BASENAMES.test(segment));
}

function readArtifactFile(filePath, options = {}) {
  if (!pathIsAllowed(filePath)) return result(ARTIFACT_STATUS.SCHEMA_INVALID, { error: "artifact path is not permitted" });
  const maxBytes = Number.isFinite(options.maxBytes) ? Math.max(1, options.maxBytes) : DEFAULT_MAX_BYTES;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return result(ARTIFACT_STATUS.MISSING, { error: "artifact is not a file" });
    if (stat.size > maxBytes) return result(ARTIFACT_STATUS.MALFORMED, { error: "artifact exceeds bounded read limit", size: stat.size });
    let data;
    try { data = JSON.parse(fs.readFileSync(filePath, "utf8")); }
    catch (_) { return result(ARTIFACT_STATUS.MALFORMED, { error: "artifact JSON malformed" }); }
    return assessArtifactObject(data, options);
  } catch (error) {
    if (error?.code === "ENOENT") return result(ARTIFACT_STATUS.MISSING, { error: "artifact missing" });
    return result(ARTIFACT_STATUS.MALFORMED, { error: "artifact could not be read" });
  }
}

module.exports = {
  ARTIFACT_STATUS,
  assessArtifactObject,
  readArtifactFile,
};
