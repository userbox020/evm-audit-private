"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const R8 = require("../run-base-paper-cycle-r8.js");
const sentinel = require("../sentinel-spark-base-psm-cycle.js");

const baseline = sentinel.loadBaseline();
const clone = () => structuredClone(baseline);
const recompute = artifact => {
  const { pools, psm, rows } = artifact.observation;
  for (const row of rows) {
    let amount = BigInt(row.inputUsdcRaw);
    for (const [index, field] of [[0, "wethRaw"], [1, "susdsRaw"]]) {
      const pool = pools[index], token = index === 0 ? R8.A.usdc : R8.A.weth;
      const first = pool.token0 === token;
      const reserveIn = BigInt(first ? pool.reserve0Raw : pool.reserve1Raw);
      const reserveOut = BigInt(first ? pool.reserve1Raw : pool.reserve0Raw);
      amount = R8.volatileOutput(amount, reserveIn, reserveOut, BigInt(pool.feeBps));
      row[field] = String(amount);
    }
    const output = R8.psmOutput(amount, BigInt(psm.rateRay));
    const surplus = output - BigInt(row.inputUsdcRaw);
    row.outputUsdcRaw = String(output);
    row.quotedSurplusUsdcRaw = String(surplus);
    row.quotedSurplusBps = { numerator: String(surplus * 10000n), denominator: row.inputUsdcRaw };
    row.pocketBalanceAllowanceSufficient = output <= BigInt(psm.balanceAllowanceCapacityRaw);
  }
  artifact.code = rows.some(r => BigInt(r.quotedSurplusUsdcRaw) > 0n && r.pocketBalanceAllowanceSufficient)
    ? "QUOTED_SURPLUS_REQUIRES_VALIDATION" : "NO_CAPACITY_BACKED_POSITIVE_QUOTE_AT_TESTED_SIZES";
  return artifact;
};
const positive = () => {
  const a = clone(), pool = a.observation.pools[1];
  pool.reserve1Raw = String(BigInt(pool.reserve1Raw) * 102n / 100n);
  pool.balance1Raw = pool.reserve1Raw;
  return recompute(a);
};
const status = artifact => sentinel.classify(artifact, baseline).status;

test("hashed historical baseline self-check retains six negative quotes", () => {
  assert.equal(status(clone()), "NOT_READY");
  assert.equal(baseline.observation.rows.length, 6);
  assert.ok(baseline.observation.rows.every(r => BigInt(r.quotedSurplusUsdcRaw) < 0n));
});

test("only capacity-backed model-consistent positive quote triggers non-executable discrepancy", () => {
  const artifact = positive(), output = sentinel.classify(artifact, baseline);
  assert.equal(output.status, "PRICE_DISCREPANCY_ONLY");
  assert.ok(output.positiveInputSizesUsdcRaw.length > 0);
  assert.deepEqual(output.pin, { number: artifact.observation.pin.number,
    hash: artifact.observation.pin.hash, timestamp: artifact.observation.pin.timestamp });
  assert.equal(output.routePositive, "unknown");
  assert.equal(output.executableNow, "unknown");
  assert.equal(output.conservativeNet, null);
  assert.equal(output.dispatchAllowed, false);
  assert.equal(output.signedActionJustified, false);
  const noReserves = structuredClone(artifact);
  noReserves.observation.pools[1].balance1Raw = "0";
  assert.equal(status(noReserves), "INCOMPLETE");
  assert.equal(sentinel.classify(noReserves, baseline).pin, null);
  assert.deepEqual(sentinel.classify(noReserves, baseline).diagnostic,
    { code: "OBSERVATION_INVALID", qualification: null });
  const insufficient = structuredClone(artifact);
  insufficient.observation.psm.usdcBalanceRaw = "1";
  insufficient.observation.psm.balanceAllowanceCapacityRaw = "1";
  recompute(insufficient);
  assert.equal(status(insufficient), "NOT_READY");
});

test("external pocket requires independently observed allowance and sufficient transfer capacity", () => {
  const artifact = positive();
  artifact.observation.psm.pocket = "0x1111111111111111111111111111111111111111";
  artifact.observation.psm.usdcAllowanceRaw = "1";
  artifact.observation.psm.balanceAllowanceCapacityRaw = "1";
  recompute(artifact);
  assert.equal(status(artifact), "NOT_READY");
  artifact.observation.psm.usdcAllowanceRaw = null;
  assert.equal(status(artifact), "INCOMPLETE");
  artifact.observation.psm.usdcAllowanceRaw = artifact.observation.psm.usdcBalanceRaw;
  artifact.observation.psm.balanceAllowanceCapacityRaw = artifact.observation.psm.usdcBalanceRaw;
  recompute(artifact);
  assert.equal(status(artifact), "PRICE_DISCREPANCY_ONLY");
});

test("invalid chain, token/pool/factory, runtime, source, family, size, fee or missing data fails closed", () => {
  const edits = [
    a => { a.chainId = 1; },
    a => { a.addresses.susds = R8.A.usdc; },
    a => { a.addresses.factory = R8.A.psm; },
    a => { a.observation.pools[0].address = a.observation.pools[1].address; },
    a => { a.observation.pools[1].token1 = R8.A.usdc; },
    a => { a.observation.runtimeKeccak256[R8.A.psm] = "0x" + "a".repeat(64); },
    a => { a.source.psmCommit = "a".repeat(40); },
    a => { a.qualification.selectedFamilyCount = 1; },
    a => { a.inputSizesUsdcRaw[0] = "2000000"; },
    a => { a.observation.rows[0].inputUsdcRaw = "2000000"; },
    a => { a.observation.pools[0].feeBps = "301"; },
    a => { a.observation.pools[1].feeBps = "29"; },
    a => { delete a.observation.rows[1].outputUsdcRaw; },
    a => { a.observation.rows.pop(); },
    a => { a.observation.pin.hash = "0x" + "a".repeat(64) + "00"; },
    a => { a.observation.psm.rateRay = "0"; },
    a => { a.observation = null; },
  ];
  for (const edit of edits) {
    const artifact = positive(); edit(artifact);
    assert.equal(status(artifact), "INCOMPLETE", edit.toString());
  }
});

test("a changed fee/rate/reserve without positive backed output is NOT_READY", () => {
  const a = clone();
  a.observation.pools[0].feeBps = "31";
  a.observation.psm.rateRay = String(BigInt(a.observation.psm.rateRay) - 100000000000000000000000n);
  a.observation.pools[1].reserve1Raw = String(BigInt(a.observation.pools[1].reserve1Raw) - 1000000000000000000n);
  a.observation.pools[1].balance1Raw = a.observation.pools[1].reserve1Raw;
  assert.equal(status(recompute(a)), "NOT_READY");
});

test("incomplete reader reports only bounded failure codes and counts, never endpoint data", () => {
  const a = { status: "INCOMPLETE", code: "TWO_STATE_CAPABLE_FAMILIES_UNAVAILABLE",
    qualification: { attempted: 3, qualified: 1, selectedFamilyCount: 0,
      failures: { TRANSPORT_UNAVAILABLE: 2, "https://sensitive.invalid/key": 1 } } };
  const out = sentinel.classify(a, baseline);
  assert.equal(out.status, "INCOMPLETE");
  assert.deepEqual(out.diagnostic, { code: "TWO_STATE_CAPABLE_FAMILIES_UNAVAILABLE",
    qualification: { attempted: 3, qualified: 1, selectedFamilyCount: 0,
      failures: { TRANSPORT_UNAVAILABLE: 2 } } });
  a.code = "https://sensitive.invalid/key";
  assert.equal(sentinel.classify(a, baseline).diagnostic.code, "READER_FAILURE_UNSPECIFIED");
  assert.doesNotMatch(JSON.stringify(sentinel.classify(a, baseline)), /sensitive\.invalid/);
});

test("--check reads offline, never requires RPC or writes a file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spark-cycle-check-"));
  try {
    const artifact = path.join(dir, "input.json");
    const fresh = positive(), now = Date.now();
    fresh.observation.pin.timestamp = String(Math.floor(now / 1000));
    fresh.generatedAt = new Date(now - 10000).toISOString();
    fresh.completedAt = new Date(now).toISOString();
    fs.writeFileSync(artifact, JSON.stringify(fresh));
    const cli = path.resolve(__dirname, "../sentinel-spark-base-psm-cycle.js");
    const child = spawnSync(process.execPath, [cli, "--check", artifact], { encoding: "utf8", env: { PATH: "", RPC_URL: "" } });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(child.stdout).status, "PRICE_DISCREPANCY_ONLY");
    assert.deepEqual(fs.readdirSync(dir), ["input.json"]);
    const bad = spawnSync(process.execPath, [cli, "--once", "relative.json"], { encoding: "utf8" });
    assert.equal(bad.status, 1);
    assert.equal(bad.stderr.trim(), "SPARK_SENTINEL_FAILED_CLOSED");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("injected --once never calls real R8/inventory and refuses duplicate output", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spark-cycle-once-"));
  try {
    const artifact = positive(), now = Number(artifact.observation.pin.timestamp) * 1000;
    artifact.generatedAt = new Date(now - 10000).toISOString();
    artifact.completedAt = new Date(now).toISOString();
    const dest = path.join(dir, "one.json");
    let calls = 0;
    const options = { outputRoot: dir, now: () => now, run: async () => { calls++; return artifact; } };
    const output = await sentinel.once(dest, options);
    assert.equal(output.status, "PRICE_DISCREPANCY_ONLY");
    assert.equal(calls, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(dest, "utf8")), output);
    assert.doesNotMatch(fs.readFileSync(dest, "utf8"), /(?:https?|wss?):\/\//i);
    await assert.rejects(sentinel.once(dest, options), /OUTPUT_EXISTS_NO_RETRY/);
    assert.equal(calls, 1);
    const stale = structuredClone(artifact);
    stale.observation.pin.timestamp = String(BigInt(stale.observation.pin.timestamp) - 7200n);
    const incomplete = await sentinel.once(path.join(dir, "stale.json"), { ...options, run: async () => stale });
    assert.equal(incomplete.status, "INCOMPLETE");
    assert.throws(() => sentinel.approvedOutput(path.join(os.tmpdir(), "escape.json"), dir), /OUTPUT_OUTSIDE_APPROVED_TEMP/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("input rejects symlink, oversized and baseline hash mismatches", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spark-cycle-input-"));
  try {
    const file = path.join(dir, "artifact.json");
    fs.writeFileSync(file, JSON.stringify(baseline));
    assert.throws(() => sentinel.readBounded(file, "0".repeat(64)), /BASELINE_HASH_MISMATCH/);
    fs.writeFileSync(file, "x".repeat(128 * 1024 + 1));
    assert.throws(() => sentinel.readBounded(file), /INPUT_UNSAFE/);
    const link = path.join(dir, "link.json");
    try {
      fs.symlinkSync(file, link);
      assert.throws(() => sentinel.readBounded(link), /INPUT_UNSAFE/);
    } catch (error) {
      if (error.code !== "EPERM") throw error; // Windows without Developer Mode cannot create links.
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
