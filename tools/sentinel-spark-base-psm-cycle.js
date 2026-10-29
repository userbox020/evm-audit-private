"use strict";

// A keyless, single-observation delta classifier. R8 alone performs RPC qualification and reads;
// this module never turns a quoted spread into funding, net profit or an execution instruction.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { keccak256 } = require("ethers");
const R8 = require("./run-base-paper-cycle-r8.js");

const BASELINE_SHA256 = "db63006406ee8040d5c58d27058f3f8a015a8dd24b8f0ac990e630978cefeae1";
const BASELINE = R8.OUTPUT;
const SCHEMA = "sentinel-spark-base-psm-cycle/v1";
const MAX_FILE_BYTES = 128 * 1024;
const FIXED_SOURCE = Object.freeze({ psmCommit: "6a5a579cb503a461df254007064370f732fcd19d",
  aerodromeReferenceCommit: "1ba30815bba620f7e9faa34769ffd00c214c9b82" });
const DEC = /^(?:0|[1-9][0-9]{0,77})$/;
const HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const DIAGNOSTIC_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const fail = code => { throw new Error(code); };
const integer = value => { if (typeof value !== "string" || !DEC.test(value)) fail("OBSERVATION_INVALID"); return BigInt(value); };
const address = value => typeof value === "string" && ADDRESS.test(value) && value !== "0x" + "0".repeat(40);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const exactKeys = (object, keys) => object && typeof object === "object" && !Array.isArray(object)
  && same(Object.keys(object).sort(), [...keys].sort());

function readBounded(file, expectedHash = null) {
  if (typeof file !== "string" || !path.isAbsolute(file)) fail("ABSOLUTE_FILE_REQUIRED");
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_FILE_BYTES) fail("INPUT_UNSAFE");
  const bytes = fs.readFileSync(file);
  const after = fs.lstatSync(file);
  if (bytes.length !== stat.size || ["dev", "ino", "size", "mtimeMs", "ctimeMs"].some(k => stat[k] !== after[k])) fail("INPUT_CHANGED");
  if (expectedHash && crypto.createHash("sha256").update(bytes).digest("hex") !== expectedHash) fail("BASELINE_HASH_MISMATCH");
  return JSON.parse(bytes.toString("utf8"));
}

function pinValid(pin) {
  return exactKeys(pin, ["number", "hash", "parentHash", "stateRoot", "timestamp"])
    && integer(pin.number) > 0n && integer(pin.timestamp) > 0n
    && [pin.hash, pin.parentHash, pin.stateRoot].every(x => typeof x === "string" && HASH.test(x));
}

function validate(artifact, baseline, { fresh = false, now = Date.now() } = {}) {
  const bad = () => fail("OBSERVATION_INVALID");
  if (!artifact || artifact.schema !== "base-paper-cycle/v8" || artifact.chainId !== 8453
    || artifact.study !== "ORDINARY_MARKET_QUOTES_ONLY" || artifact.status !== "OBSERVED_UNPROMOTED"
    || artifact.phase !== "TERMINAL" || artifact.operation !== "psm.previewSwapExactIn"
    || !exactKeys(artifact.addresses, Object.keys(R8.A)) || !same(artifact.addresses, R8.A)
    || !same(artifact.inputSizesUsdcRaw, R8.SIZES.map(String))
    || !artifact.source || artifact.source.psmCommit !== FIXED_SOURCE.psmCommit
    || artifact.source.aerodromeReferenceCommit !== FIXED_SOURCE.aerodromeReferenceCommit
    || artifact.source.psmPrimarySourceMatches !== true || artifact.source.normalization !== "CRLF_TO_LF"
    || artifact.source.sourceRuntimeBound !== "unknown" || artifact.source.dependencyBuildClosure !== "unknown"
    || !artifact.qualification || artifact.qualification.selectedFamilyCount !== 2
    || !Number.isSafeInteger(artifact.qualification.qualified) || artifact.qualification.qualified < 2
    || !Number.isSafeInteger(artifact.requests) || artifact.requests < 1 || artifact.requests > R8.CAP.requests
    || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1 || artifact.bytes > R8.CAP.totalBytes
    || !artifact.safety || artifact.safety.readOnly !== true || artifact.safety.walletAccess !== false
    || artifact.safety.signing !== false || artifact.safety.transactions !== 0 || artifact.safety.retries !== 0
    || artifact.safety.endpointMaterialPersisted !== false
    || !artifact.gates || artifact.gates.profitabilityClaim !== false || artifact.gates.signedActionJustified !== false
    || artifact.gates.executableNow !== "unknown"
    || !artifact.economics || artifact.economics.costsComplete !== false
    || artifact.economics.conservativeNetUsdc !== null || artifact.economics.conservativeNetUsd !== null
    || !artifact.observation || !pinValid(artifact.observation.pin)
    || artifact.observation.rpcStrength !== "corroborated-operator-families"
    || artifact.observation.upstreamIndependenceProven !== false) bad();
  const view = artifact.observation, reference = baseline.observation;
  if (fresh) {
    const pinAge = BigInt(Math.floor(now / 1000)) - integer(view.pin.timestamp);
    const started = Date.parse(artifact.generatedAt), completed = Date.parse(artifact.completedAt);
    if (!Number.isFinite(started) || !Number.isFinite(completed) || started > completed
      || completed > now + 60000 || now - started > R8.CAP.wallMs + 60000
      || pinAge < -60n || pinAge > BigInt(R8.CAP.maxAgeSeconds)) bad();
  }
  if (!exactKeys(view.runtimeKeccak256, Object.keys(reference.runtimeKeccak256))) bad();
  for (const [target, hash] of Object.entries(reference.runtimeKeccak256)) {
    if (!address(target) || !HASH.test(view.runtimeKeccak256[target]) || view.runtimeKeccak256[target] !== hash) bad();
  }
  if (!Array.isArray(view.pools) || view.pools.length !== 2 || !Array.isArray(view.rows)
    || view.rows.length !== R8.SIZES.length || !view.psm) bad();
  for (let i = 0; i < 2; i++) {
    const pool = view.pools[i], expected = reference.pools[i];
    if (!pool || pool.address !== expected.address || pool.implementation !== expected.implementation
      || pool.token0 !== expected.token0 || pool.token1 !== expected.token1 || pool.stable !== false
      || pool.balancesMatchReserves !== true || integer(pool.feeBps) > 300n
      || integer(pool.reserve0Raw) === 0n || integer(pool.reserve1Raw) === 0n
      || integer(pool.reserveTimestamp) > integer(view.pin.timestamp)
      || integer(pool.balance0Raw) !== integer(pool.reserve0Raw)
      || integer(pool.balance1Raw) !== integer(pool.reserve1Raw)) bad();
    const cloneCode = `0x363d3d373d3d3d363d73${pool.implementation.slice(2)}5af43d82803e903d91602b57fd5bf3`;
    if (view.runtimeKeccak256[pool.address] !== keccak256(cloneCode)) bad();
  }
  const psm = view.psm;
  if (!address(psm.pocket) || integer(psm.rateRay) === 0n
    || psm.capacityIsTransferProof !== false) bad();
  const balance = integer(psm.usdcBalanceRaw);
  const allowance = psm.pocket === R8.A.psm
    ? (psm.usdcAllowanceRaw === null ? null : bad())
    : integer(psm.usdcAllowanceRaw);
  const capacity = allowance === null || balance < allowance ? balance : allowance;
  if (integer(psm.balanceAllowanceCapacityRaw) !== capacity) bad();
  const positive = [];
  for (let i = 0; i < R8.SIZES.length; i++) {
    const row = view.rows[i], input = R8.SIZES[i];
    if (!row || row.inputUsdcRaw !== String(input)) bad();
    let amount = input;
    for (const [index, key] of [[0, "wethRaw"], [1, "susdsRaw"]]) {
      const pool = view.pools[index], token = index === 0 ? R8.A.usdc : R8.A.weth;
      const in0 = pool.token0 === token;
      const reserveIn = integer(in0 ? pool.reserve0Raw : pool.reserve1Raw);
      const reserveOut = integer(in0 ? pool.reserve1Raw : pool.reserve0Raw);
      const output = integer(row[key]);
      if (output === 0n || output >= reserveOut
        || output !== R8.volatileOutput(amount, reserveIn, reserveOut, integer(pool.feeBps))) bad();
      amount = output;
    }
    const output = integer(row.outputUsdcRaw);
    const surplus = output - input;
    if (output !== R8.psmOutput(amount, integer(psm.rateRay))
      || row.quotedSurplusUsdcRaw !== String(surplus)
      || !row.quotedSurplusBps || row.quotedSurplusBps.numerator !== String(surplus * 10000n)
      || row.quotedSurplusBps.denominator !== String(input)
      || row.pocketBalanceAllowanceSufficient !== (output <= capacity)
      || row.poolsBalancesMatchReserves !== true || row.quoteIncludesPoolFeesAndImpact !== true
      || row.conservativeNetUsdc !== null || row.executable !== "unknown") bad();
    if (surplus > 0n && output <= capacity && BigInt(reference.rows[i].quotedSurplusUsdcRaw) < 0n) positive.push(String(input));
  }
  const expectedCode = positive.length ? "QUOTED_SURPLUS_REQUIRES_VALIDATION" : "NO_CAPACITY_BACKED_POSITIVE_QUOTE_AT_TESTED_SIZES";
  if (artifact.code !== expectedCode) bad();
  return positive;
}

function loadBaseline() {
  const baseline = readBounded(BASELINE, BASELINE_SHA256);
  // An immutable hash alone does not say what that file means.
  if (!baseline.observation || !Array.isArray(baseline.observation.rows)
    || baseline.observation.rows.length !== R8.SIZES.length
    || baseline.observation.rows.some(row => !/^-?[0-9]+$/.test(row.quotedSurplusUsdcRaw)
      || BigInt(row.quotedSurplusUsdcRaw) >= 0n)) fail("BASELINE_INVALID");
  validate(baseline, baseline);
  return baseline;
}

function classify(artifact, baseline = loadBaseline(), options = {}) {
  let positive = [];
  try { positive = validate(artifact, baseline, options); }
  catch (_) { return result("INCOMPLETE", [], null, readerDiagnostic(artifact)); }
  return result(positive.length ? "PRICE_DISCREPANCY_ONLY" : "NOT_READY", positive, artifact.observation);
}

function readerDiagnostic(artifact) {
  if (artifact?.status !== "INCOMPLETE") return { code: "OBSERVATION_INVALID", qualification: null };
  const code = DIAGNOSTIC_CODE.test(artifact.code) ? artifact.code : "READER_FAILURE_UNSPECIFIED";
  const q = artifact.qualification;
  const count = n => Number.isSafeInteger(n) && n >= 0 && n <= R8.CAP.candidates;
  const qualification = q && count(q.attempted) && count(q.qualified) && count(q.selectedFamilyCount)
    ? { attempted: q.attempted, qualified: q.qualified, selectedFamilyCount: q.selectedFamilyCount, failures: {} }
    : null;
  if (qualification && q.failures && typeof q.failures === "object" && !Array.isArray(q.failures)) {
    for (const [reason, n] of Object.entries(q.failures).slice(0, R8.CAP.candidates)) {
      if (DIAGNOSTIC_CODE.test(reason) && count(n)) qualification.failures[reason] = n;
    }
  }
  return { code, qualification };
}

function result(status, sizes, observation = null, diagnostic = null) {
  return { schema: SCHEMA, chainId: 8453, status, baselineSha256: BASELINE_SHA256,
    pin: observation ? { number: observation.pin.number, hash: observation.pin.hash, timestamp: observation.pin.timestamp } : null,
    diagnostic,
    positiveInputSizesUsdcRaw: sizes, routePositive: "unknown", executableNow: "unknown",
    conservativeNet: null, dispatchAllowed: false, signedActionJustified: false,
    nextGate: status === "PRICE_DISCREPANCY_ONLY" ? "FULL_SAME_STATE_FORK_AND_ALL_COSTS_REQUIRED" : "NONE" };
}

function approvedOutput(file, root = path.join(os.homedir(), "AppData", "Local", "Temp", "opencode")) {
  if (typeof file !== "string" || !path.isAbsolute(file) || !path.isAbsolute(root)) fail("ABSOLUTE_OUTPUT_REQUIRED");
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) fail("OUTPUT_OUTSIDE_APPROVED_TEMP");
  const segments = relative.split(path.sep);
  let current = root;
  if (!fs.lstatSync(current).isDirectory() || fs.lstatSync(current).isSymbolicLink()) fail("OUTPUT_PARENT_UNSAFE");
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("OUTPUT_PARENT_UNSAFE");
  }
  if (fs.existsSync(file)) fail("OUTPUT_EXISTS_NO_RETRY");
}

async function once(file, { run = R8.run, deps, outputRoot, now = Date.now } = {}) {
  approvedOutput(file, outputRoot);
  const baseline = loadBaseline();
  // No CLI injection hook: the CLI below always calls the original, qualified R8.run().
  const artifact = await run(deps);
  const classified = classify(artifact, baseline, { fresh: true, now: now() });
  const encoded = JSON.stringify(classified, null, 2) + "\n";
  if (Buffer.byteLength(encoded) > MAX_FILE_BYTES) fail("OUTPUT_CAP");
  fs.writeFileSync(file, encoded, { flag: "wx", mode: 0o600 });
  return classified;
}

async function main(args = process.argv.slice(2)) {
  if (args.length !== 2 || !["--check", "--once"].includes(args[0])) fail("EXPLICIT_MODE_AND_ABSOLUTE_PATH_REQUIRED");
  const [mode, file] = args;
  if (!path.isAbsolute(file)) fail("ABSOLUTE_FILE_REQUIRED");
  const output = mode === "--check" ? classify(readBounded(file), loadBaseline(), { fresh: true }) : await once(file);
  process.stdout.write(JSON.stringify(output) + "\n");
  if (output.status === "INCOMPLETE") process.exitCode = 1;
}

module.exports = { loadBaseline, classify, once, approvedOutput, main, validate, readBounded };
if (require.main === module) main().catch(() => { process.stderr.write("SPARK_SENTINEL_FAILED_CLOSED\n"); process.exitCode = 1; });
