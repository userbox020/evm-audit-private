"use strict";

// Offline snapshot join only. This does NOT run the producers' full validators,
// verify chain evidence, prove a route/profit, or grant dispatch authority.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const SURFACES = Object.freeze(["dedicated", "multichain", "divergence"]);
const SCHEMAS = Object.freeze({
  dedicated: ["exploit-rearm-canary/v1", "exploit-rearm-canary-history/v1"],
  multichain: ["exploit-rearm-canary-multichain/v1", "exploit-rearm-canary-multichain-history/v1"],
  divergence: ["oracle-divergence-monitor/v1", "oracle-divergence-monitor-history/v1"],
});
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_ROWS = 10000;
const MAX_RUNS = 50;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RUN_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/u;

function invalid(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function id(surface, chainId, sentinel) {
  return JSON.stringify([surface, chainId, sentinel]);
}
function validIdentity(chainId, sentinel) {
  return Number.isSafeInteger(chainId) && chainId > 0 &&
    typeof sentinel === "string" && sentinel.length > 0 && sentinel.length <= 256;
}
function equalHex(left, right, bytes) {
  return typeof left === "string" && typeof right === "string" &&
    new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`, "u").test(left) &&
    new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`, "u").test(right) &&
    left.toLowerCase() === right.toLowerCase();
}
function historicalToken(row, field) {
  const value = row[`historical${field}`] ?? row[`${field[0].toLowerCase()}${field.slice(1)}`];
  return value == null ? null : value;
}

function pinnedDivergenceRows(pinned, tracked) {
  if (!object(pinned) || typeof pinned.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(pinned.sha256) ||
      typeof pinned.sourceConstantSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(pinned.sourceConstantSha256) ||
      !Array.isArray(pinned.rows) || pinned.rows.length !== tracked.size) throw invalid("PINNED_UNIVERSE_INVALID");
  const byId = new Map();
  for (const row of pinned.rows) {
    if (!object(row) || !validIdentity(row.chainId, row.sentinel) ||
        (row.id !== undefined && row.id !== row.sentinel) ||
        !equalHex(row.oracle, row.oracle, 20) ||
        !(row.marketId === null || equalHex(row.marketId, row.marketId, 32)) ||
        !(row.pair === null || typeof row.pair === "string") ||
        typeof row.kind !== "string" || !row.kind ||
        typeof row.provenanceConstant !== "boolean" ||
        [historicalToken(row, "CollateralToken"), historicalToken(row, "LoanToken")].some((token) =>
          token !== null && !equalHex(token, token, 20)) ||
        ["sentinel", "chainId", "oracle", "marketId", "pair", "kind"].some((field) => !Object.hasOwn(row, field))) {
      throw invalid("PINNED_UNIVERSE_INVALID");
    }
    const key = id("divergence", row.chainId, row.sentinel);
    if (!tracked.has(key) || byId.has(key)) throw invalid("PINNED_UNIVERSE_IDS_INVALID");
    byId.set(key, row);
  }
  return byId;
}

function positiveRaw(value) {
  return typeof value === "string" && /^[1-9][0-9]*$/u.test(value);
}
function nonnegativeRaw(value) {
  return value === "0" || positiveRaw(value);
}

function validatePinnedDivergence(status, latest, pinned, byId) {
  if (status.pinnedUniverseSha256 !== pinned.sha256 || latest.pinnedUniverseSha256 !== pinned.sha256 ||
      status.sourceConstantSha256 !== pinned.sourceConstantSha256 ||
      latest.sourceConstantSha256 !== pinned.sourceConstantSha256) {
    throw invalid("PINNED_UNIVERSE_DIGEST_MISMATCH");
  }
  if (status.sentinels.length !== byId.size) throw invalid("PINNED_UNIVERSE_IDS_INVALID");
  for (const row of status.sentinels) {
    const expected = byId.get(id("divergence", row.chainId, row.sentinel));
    if (!expected || ["sentinel", "chainId", "oracle", "marketId", "pair", "kind"].some((field) =>
      !Object.hasOwn(row, field)) || !equalHex(row.oracle, expected.oracle, 20) ||
        !(row.marketId === null && expected.marketId === null ||
          equalHex(row.marketId, expected.marketId, 32)) || row.pair !== expected.pair ||
        row.kind !== expected.kind || typeof row.actionable !== "boolean") {
      throw invalid("PINNED_UNIVERSE_TUPLE_MISMATCH");
    }
    const measurements = row.measurements;
    if (row.actionable) throw invalid("PINNED_UNIVERSE_ACTIONABLE_FORBIDDEN");
    if (row.signalType != null || typeof row.sustained !== "boolean" ||
        !Number.isSafeInteger(row.consecutiveOver) || row.consecutiveOver < 0 ||
        (row.referenceOk !== true && (row.fired || row.sustained || row.consecutiveOver !== 0 ||
          row.divergenceBps != null)) ||
        (row.fired && (!row.ok || !row.sustained || row.consecutiveOver < 2 ||
          !Number.isFinite(row.divergenceBps) || !Number.isFinite(row.thresholdBps) ||
          row.divergenceBps <= row.thresholdBps ||
          row.divergenceBps !== Math.round(Math.abs(row.oracleRatio - row.referenceRatio) /
            row.referenceRatio * 10000))) ||
        (row.sustained && !row.fired)) {
      throw invalid("PINNED_UNIVERSE_STRUCTURAL_INVALID");
    }
    if (!expected.provenanceConstant &&
        (row.structuralVerified === true || row.structuralCandidate === true || row.signalType != null)) {
      throw invalid("PINNED_UNIVERSE_STRUCTURAL_INVALID");
    }
    if (!row.ok && (row.structuralCandidate === true || row.signalType != null)) {
      throw invalid("PINNED_UNIVERSE_STRUCTURAL_INVALID");
    }
    if (row.ok) {
      const collateral = historicalToken(expected, "CollateralToken");
      const loan = historicalToken(expected, "LoanToken");
      const independentReference = row.referenceOk === true &&
        typeof row.referenceSource === "string" && !!row.referenceSource &&
        Number.isFinite(row.oracleRatio) && row.oracleRatio > 0 &&
        Number.isFinite(row.referenceRatio) && row.referenceRatio > 0;
      const structuralOnly = expected.provenanceConstant === true && row.referenceOk === false &&
        row.structuralVerified === true;
      if (!object(measurements) || measurements.marketBound !== true ||
          measurements.marketStateReadable !== true || !(independentReference || structuralOnly) ||
          !equalHex(row.marketId, expected.marketId, 32) ||
          !Number.isInteger(measurements.collateralDecimals) ||
          measurements.collateralDecimals < 0 || measurements.collateralDecimals > 36 ||
          !Number.isInteger(measurements.loanDecimals) ||
          measurements.loanDecimals < 0 || measurements.loanDecimals > 36 ||
          !equalHex(measurements.collateralToken, measurements.collateralToken, 20) ||
          !equalHex(measurements.loanToken, measurements.loanToken, 20) ||
          (collateral !== null && !equalHex(measurements.collateralToken, collateral, 20)) ||
          (loan !== null && !equalHex(measurements.loanToken, loan, 20))) {
        throw invalid("PINNED_UNIVERSE_BINDING_INVALID");
      }
      if (expected.provenanceConstant) {
        if (row.structuralVerified !== true || typeof row.structuralCandidate !== "boolean" ||
            !positiveRaw(measurements.oraclePrice) ||
            !nonnegativeRaw(row.borrowRaw) || !nonnegativeRaw(row.availableRaw) ||
            typeof row.borrowsPositive !== "boolean" ||
            row.borrowsPositive !== positiveRaw(row.borrowRaw) ||
            row.structuralCandidate !== (row.borrowsPositive && positiveRaw(row.availableRaw))) {
          throw invalid("PINNED_UNIVERSE_STRUCTURAL_INVALID");
        }
      }
    }
  }
}
function isoMs(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return NaN;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : NaN;
}

// Reject symlink components as well as the leaf; open by descriptor with no-follow,
// cap actual bytes even if the file grows between stat and read, and hash those bytes.
function readBoundedJson(file) {
  if (typeof file !== "string" || !file) throw invalid("PATH_INVALID");
  let fd;
  try {
    let component = path.parse(path.resolve(file)).root;
    for (const part of path.resolve(file).slice(component.length).split(path.sep).filter(Boolean)) {
      component = path.join(component, part);
      const stat = fs.lstatSync(component);
      if (stat.isSymbolicLink()) throw invalid("SYMLINK_INPUT");
      if (component !== path.resolve(file) && !stat.isDirectory()) throw invalid("PATH_INVALID");
    }
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.size > MAX_BYTES) throw invalid("FILE_INVALID_OR_OVERSIZE");
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.size > MAX_BYTES || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw invalid("FILE_CHANGED_OR_OVERSIZE");
    }
    const chunks = [];
    let size = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_BYTES + 1 - size));
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      size += count;
      if (size > MAX_BYTES) throw invalid("FILE_CHANGED_OR_OVERSIZE");
      chunks.push(chunk.subarray(0, count));
    }
    const after = fs.fstatSync(fd);
    if (after.size !== size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      throw invalid("FILE_CHANGED_OR_OVERSIZE");
    }
    const bytes = Buffer.concat(chunks, size);
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    let data;
    try { data = JSON.parse(bytes.toString("utf8")); } catch (_) { throw invalid("JSON_INVALID"); }
    if (!object(data)) throw invalid("JSON_INVALID");
    return { data, sha256: digest };
  } catch (error) {
    if (error.code && /^[A-Z_]+$/u.test(error.code) && error.message === error.code) throw error;
    throw invalid("FILE_UNREADABLE");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function requireRun(runId, at, nowMs, maxAgeMs, priorId) {
  const time = isoMs(at);
  if (typeof runId !== "string" || !RUN_ID.test(runId) || !Number.isFinite(time) ||
      new Date(time).toISOString().replace(/[:.]/gu, "-") !== runId ||
      time > nowMs || nowMs - time > maxAgeMs) throw invalid("RUN_STALE_OR_INVALID");
  if (priorId !== undefined && priorId === runId) throw invalid("RUN_UNCHANGED");
}

function snapshotCanaryReadonlyTriplet({ baselinePath, sources, priorGeneration, pinnedDivergenceUniverse,
  nowMs = Date.now(), maxAgeMs = 120000 } = {}) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(maxAgeMs) ||
      maxAgeMs <= 0 || maxAgeMs > MAX_AGE_MS || !object(sources) ||
      (priorGeneration !== undefined && (!object(priorGeneration) ||
        SURFACES.some((surface) => typeof priorGeneration[surface] !== "string")))) throw invalid("OPTIONS_INVALID");
  const directories = SURFACES.map((surface) => {
    const source = sources[surface];
    if (!object(source) || typeof source.statusPath !== "string" || typeof source.historyPath !== "string" ||
        path.resolve(source.statusPath) === path.resolve(source.historyPath) ||
        path.dirname(path.resolve(source.statusPath)) !== path.dirname(path.resolve(source.historyPath))) {
      throw invalid("SOURCE_PATHS_INVALID");
    }
    return path.dirname(path.resolve(source.statusPath));
  });
  if (new Set(directories).size !== SURFACES.length) throw invalid("SOURCES_NOT_SEPARATE");
  const baseline = readBoundedJson(baselinePath);
  if (baseline.data.schema !== "all-sentinels-coverage/v1" || !Array.isArray(baseline.data.records) ||
      baseline.data.records.length === 0 || baseline.data.records.length > MAX_ROWS) throw invalid("BASELINE_INVALID");
  const tracked = Object.fromEntries(SURFACES.map((surface) => [surface, new Set()]));
  for (const row of baseline.data.records) {
    if (!object(row) || !SURFACES.includes(row.source) || !validIdentity(row.chainId, row.id) ||
        row.schema !== SCHEMAS[row.source][0]) throw invalid("BASELINE_INVALID");
    const key = id(row.source, row.chainId, row.id);
    if (tracked[row.source].has(key)) throw invalid("BASELINE_DUPLICATE_ID");
    tracked[row.source].add(key);
  }
  if (SURFACES.some((surface) => !tracked[surface].size)) throw invalid("BASELINE_INVALID");
  const pinnedRows = pinnedDivergenceUniverse === undefined ? null :
    pinnedDivergenceRows(pinnedDivergenceUniverse, tracked.divergence);

  const generation = {};
  const sourceRowCounts = {};
  const surfaces = {};
  const hashes = { baseline: baseline.sha256 };
  let coverageComplete = true;
  for (const surface of SURFACES) {
    const status = readBoundedJson(sources[surface].statusPath);
    const history = readBoundedJson(sources[surface].historyPath);
    hashes[surface] = { status: status.sha256, history: history.sha256 };
    const s = status.data;
    const h = history.data;
    if (s.schema !== SCHEMAS[surface][0] || h.schema !== SCHEMAS[surface][1] ||
        !Array.isArray(s.sentinels) || s.sentinels.length === 0 || s.sentinels.length > MAX_ROWS ||
        !Array.isArray(h.runs) || h.runs.length === 0 || h.runs.length > MAX_RUNS ||
        !["DORMANT", "FIRED", "INCOMPLETE"].includes(s.verdict)) throw invalid("SOURCE_SCHEMA_OR_BOUNDS_INVALID");
    requireRun(s.runId, s.generatedAt, nowMs, maxAgeMs, priorGeneration?.[surface]);
    const latest = h.runs[h.runs.length - 1];
    if (!object(latest) || latest.runId !== s.runId || latest.at !== s.generatedAt || latest.verdict !== s.verdict ||
        !Array.isArray(latest.fired) || !Array.isArray(s.firedSentinels) ||
        !Number.isSafeInteger(s.firedCount) || s.firedCount < 0) throw invalid("HISTORY_LATEST_MISMATCH");
    const seenRuns = new Set();
    for (const run of h.runs) {
      if (!object(run) || typeof run.runId !== "string" || !RUN_ID.test(run.runId) ||
          seenRuns.has(run.runId) || !Number.isFinite(isoMs(run.at))) throw invalid("HISTORY_INVALID");
      seenRuns.add(run.runId);
    }
    const seen = new Set();
    const fired = [];
    let incomplete = false;
    for (const row of s.sentinels) {
      const chainId = surface === "dedicated" ? s.chainId : row?.chainId;
      if (!object(row) || !validIdentity(chainId, row.sentinel) ||
          typeof row.ok !== "boolean" || typeof row.fired !== "boolean") throw invalid("ROW_INVALID");
      const key = id(surface, chainId, row.sentinel);
      if (seen.has(key)) throw invalid("SOURCE_DUPLICATE_ID");
      seen.add(key);
      if (row.fired) fired.push(row.sentinel);
      if (!row.ok) incomplete = true;
    }
    if (new Set(fired).size !== fired.length || fired.length !== s.firedCount ||
        JSON.stringify(fired) !== JSON.stringify(s.firedSentinels) ||
        JSON.stringify(fired) !== JSON.stringify(latest.fired) ||
        (fired.length > 0 ? s.verdict !== "FIRED" : s.verdict === "FIRED")) throw invalid("FIRE_SUMMARY_MISMATCH");
    if (surface === "divergence" && pinnedRows) {
      validatePinnedDivergence(s, latest, pinnedDivergenceUniverse, pinnedRows);
    }
    if (s.verdict === "INCOMPLETE") incomplete = true;
    const missingIds = [...tracked[surface]].filter((key) => !seen.has(key)).map((key) => JSON.parse(key));
    const newIds = [...seen].filter((key) => !tracked[surface].has(key)).map((key) => JSON.parse(key));
    const complete = !incomplete && missingIds.length === 0 && newIds.length === 0;
    coverageComplete &&= complete;
    sourceRowCounts[surface] = s.sentinels.length;
    generation[surface] = s.runId;
    surfaces[surface] = { ok: complete && !fired.length, fired: complete && fired.length > 0,
      incomplete: !complete, missingIds, newIds };
  }
  return { validatorBoundary: pinnedRows ? "PINNED_DIVERGENCE_JOIN_ONLY" : "MINIMAL_SHAPE_JOIN_ONLY",
    trackedBaselineCount: baseline.data.records.length,
    sourceRowCounts, surfaces, generation, hashes, coverageComplete, routeProven: false,
    profitProven: false, dispatchAllowed: false, monitoringOnly: true };
}

module.exports = { snapshotCanaryReadonlyTriplet };
