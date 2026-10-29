"use strict";

// Historical, observational identity only. This module confers no route, transaction, or execution authority.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../..");
const BASELINE = "reports/raw/fast/all-sentinels-coverage-20260926/coverage-r3.json";
const SOURCE = "reports/raw/fast/exploit-rearm-canary/status-divergence.json";
const SOURCE_CONSTANT = "reports/raw/fast/w9-strike-routes-20260922/drain-route-spec.json";
const BASELINE_SHA256 = "9bd9ddb6a622c3dbfdea0f90e5491374f2473888b1e1d24ef3180d0bf1b9886a";
const SOURCE_SHA256 = "ed62283d99d674f61d445c49a3cda4bfb021cb7fb684b900299cd7d738bf549a";
const SOURCE_CONSTANT_SHA256 = "d8e47e5034747b901007f6d47c5a07b431fb99a8fb2f73af70466575aa6fa5bd";
const RUN_ID = "2026-09-26T06-27-25-966Z";
const COUNT = 351;
const CONSTANT_COUNT = 238;
const MAX_BYTES = 1024 * 1024;
const CHAINS = new Set([1, 8453, 42161, 999, 4663]);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MARKET = /^0x[0-9a-fA-F]{64}$/;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }

function readPinned(root, relative, digest) {
  const absolute = path.resolve(root);
  const anchor = path.parse(absolute).root;
  const parts = [anchor, ...absolute.slice(anchor.length).split(path.sep).filter(Boolean), ...relative.split("/")];
  let current = parts[0];
  let fd;
  try {
    for (let i = 0; i < parts.length; i += 1) {
      if (i) current = path.join(current, parts[i]);
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || (i === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) fail("PINNED_FILE_UNSAFE");
    }
    fd = fs.openSync(current, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size <= 0 || before.size > MAX_BYTES) fail("PINNED_FILE_UNSAFE");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const n = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
      if (n === 0) fail("PINNED_FILE_UNSAFE");
      offset += n;
    }
    const extra = Buffer.alloc(1);
    const after = fs.fstatSync(fd);
    if (fs.readSync(fd, extra, 0, 1, null) !== 0 || after.size !== before.size || after.ino !== before.ino || after.dev !== before.dev || after.mtimeMs !== before.mtimeMs) fail("PINNED_FILE_UNSAFE");
    if (crypto.createHash("sha256").update(bytes).digest("hex") !== digest) fail("PINNED_HASH_MISMATCH");
    try { return JSON.parse(bytes.toString("utf8")); } catch (_) { fail("PINNED_JSON_INVALID"); }
  } catch (error) {
    if (error.code && error.message === error.code && error.code.startsWith("PINNED_")) throw error;
    fail("PINNED_FILE_UNSAFE");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// options is exclusively for copied-fixture offline tests; normal callers use the no-argument fixed pins.
function loadPinnedDivergenceUniverse(options) {
  let root = ROOT;
  let baselineHash = BASELINE_SHA256;
  let sourceHash = SOURCE_SHA256;
  let constantHash = SOURCE_CONSTANT_SHA256;
  if (options !== undefined) {
    if (!object(options) || typeof options.root !== "string" || !path.isAbsolute(options.root) ||
        Object.keys(options).some((key) => !["root", "testPins"].includes(key))) fail("PINNED_OPTIONS_INVALID");
    root = options.root;
    if (options.testPins !== undefined) {
      if (!object(options.testPins) || Object.keys(options.testPins).length !== 3 ||
          !/^[0-9a-f]{64}$/.test(options.testPins.baseline) || !/^[0-9a-f]{64}$/.test(options.testPins.source) ||
          !/^[0-9a-f]{64}$/.test(options.testPins.sourceConstant)) fail("PINNED_OPTIONS_INVALID");
      baselineHash = options.testPins.baseline;
      sourceHash = options.testPins.source;
      constantHash = options.testPins.sourceConstant;
    }
  }
  const baseline = readPinned(root, BASELINE, baselineHash);
  const source = readPinned(root, SOURCE, sourceHash);
  const sourceConstant = readPinned(root, SOURCE_CONSTANT, constantHash);
  if (!object(baseline) || !object(baseline.sources) || !object(baseline.sources.divergence) ||
      baseline.sources.divergence.runId !== RUN_ID || !Array.isArray(baseline.records) ||
      !object(source) || source.runId !== RUN_ID || !Array.isArray(source.sentinels) || source.sentinels.length !== COUNT) fail("PINNED_SHAPE_INVALID");

  const baselineIds = new Map();
  for (const record of baseline.records) {
    if (!object(record) || record.source !== "divergence") continue;
    if (!CHAINS.has(record.chainId) || typeof record.id !== "string" || baselineIds.has(record.id)) fail("PINNED_BASELINE_INVALID");
    baselineIds.set(record.id, record.chainId);
  }
  if (baselineIds.size !== COUNT) fail("PINNED_BASELINE_MISMATCH");

  const ids = new Set();
  const oracles = new Set();
  const rows = source.sentinels.map((item) => {
    if (!object(item) || !CHAINS.has(item.chainId) || typeof item.oracle !== "string" || !ADDRESS.test(item.oracle) ||
        typeof item.marketId !== "string" || !MARKET.test(item.marketId) ||
        typeof item.sentinel !== "string" || item.sentinel !== `div:${item.chainId}:${item.oracle.slice(2, 10)}` ||
        typeof item.pair !== "string" || !item.pair || item.pair.length > 128 ||
        typeof item.kind !== "string" || !item.kind || item.kind.length > 128) fail("PINNED_ROW_INVALID");
    const key = `${item.chainId}:${item.oracle.toLowerCase()}`;
    if (ids.has(item.sentinel) || oracles.has(key)) fail("PINNED_DUPLICATE_IDENTITY");
    ids.add(item.sentinel);
    oracles.add(key);
    const collateral = item.measurements?.collateralToken;
    const loan = item.measurements?.loanToken;
    const tokensReadable = typeof collateral === "string" && typeof loan === "string" && ADDRESS.test(collateral) && ADDRESS.test(loan);
    return { id: item.sentinel, chainId: item.chainId, sentinel: item.sentinel, oracle: item.oracle,
      marketId: item.marketId, pair: item.pair, kind: item.kind,
      collateralToken: tokensReadable ? collateral : null, loanToken: tokensReadable ? loan : null };
  });
  if (ids.size !== COUNT || rows.some((row) => baselineIds.get(row.id) !== row.chainId)) fail("PINNED_BASELINE_MISMATCH");
  if (!object(sourceConstant) || !Array.isArray(sourceConstant.groups)) fail("PINNED_CONSTANT_SHAPE_INVALID");
  const groups = sourceConstant.groups.filter((group) => object(group) && group.class === "stub-constant-price-oracle");
  if (groups.length !== 1 || groups[0].chainId !== 8453 || groups[0].chain !== "base" ||
      groups[0].count !== CONSTANT_COUNT || !Array.isArray(groups[0].rows) ||
      groups[0].rows.length !== CONSTANT_COUNT) fail("PINNED_CONSTANT_SHAPE_INVALID");
  const constantRows = new Map(rows.filter((row) => row.kind === "constant-oracle")
    .map((row) => [`${row.chainId}:${row.oracle.toLowerCase()}`, row]));
  if (constantRows.size !== CONSTANT_COUNT) fail("PINNED_CONSTANT_MISMATCH");
  const matched = new Set();
  for (const item of groups[0].rows) {
    if (!object(item) || item.kind !== "stub-oracle" || typeof item.oracle !== "string" || !ADDRESS.test(item.oracle) ||
        typeof item.pair !== "string" || item.marketId !== null &&
        (typeof item.marketId !== "string" || !MARKET.test(item.marketId))) fail("PINNED_CONSTANT_ROW_INVALID");
    const key = `8453:${item.oracle.toLowerCase()}`;
    if (matched.has(key)) fail("PINNED_CONSTANT_DUPLICATE");
    matched.add(key);
    const row = constantRows.get(key);
    if (!row || row.chainId !== 8453 || row.pair !== item.pair ||
        (item.marketId !== null && item.marketId !== row.marketId)) fail("PINNED_CONSTANT_MISMATCH");
  }
  if (matched.size !== CONSTANT_COUNT || [...constantRows.keys()].some((key) => !matched.has(key))) fail("PINNED_CONSTANT_MISMATCH");
  for (const row of rows) row.provenanceConstant = row.kind === "constant-oracle" && matched.has(`${row.chainId}:${row.oracle.toLowerCase()}`);
  rows.sort((a, b) => a.chainId - b.chainId || (a.oracle.toLowerCase() < b.oracle.toLowerCase() ? -1 : 1));
  return { sha256: sourceHash, sourceConstantSha256: constantHash, rows };
}

module.exports = { loadPinnedDivergenceUniverse };
