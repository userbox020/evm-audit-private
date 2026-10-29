"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { ethers } = require("ethers");
const check = require("../check-snusd-usdc-delayed");

const base = { assets: 999n, shares: 999000000n, borrowerShares: 500000000n,
  collateral: 100n, price: 10n ** 36n, lltv: 0n };

test("seizedAssets branch known answer: capped LIF, three upward conversions", () => {
  const a = check.seizedBranch(base, 100n);
  assert.equal(a.lif, 1150000000000000000n);
  assert.equal(a.quoted, 100n); assert.equal(a.discounted, 87n);
  assert.equal(a.repaidShares, 87000000n); assert.equal(a.repaid, 87n);
  assert.equal(a.feasible, true);
});
test("all intermediate ceilings are retained instead of linearly scaling repayment", () => {
  const a = check.seizedBranch({ ...base, price: 10n ** 36n + 1n }, 1n);
  assert.equal(a.quoted, 2n); assert.equal(a.repaid, 2n);
  assert.notEqual(a.repaid, check.seizedBranch(base, 100n).repaid / 100n);
});
test("virtual offsets support an empty market and reject borrower share underflow", () => {
  assert.throws(() => check.seizedBranch({ ...base, assets: 0n, shares: 0n, borrowerShares: 1n }, 1n), /SEIZURE_INPUT_INVALID/);
  const a = check.seizedBranch({ ...base, assets: 0n, shares: 1n, borrowerShares: 1n }, 1n);
  assert.equal(a.repaid, 1n); assert.equal(a.feasible, false);
});
test("borrower share cap bounds the exact feasible seizedAssets amount", () => {
  const rows = check.sizes({ ...base, borrowerShares: 20000000n });
  assert.ok(rows.length <= 5); assert.ok(rows.every(r => r.feasible));
  assert.equal(rows.at(-1).seized, 23n); assert.equal(rows.at(-1).repaidShares, 20000000n);
  assert.equal(check.seizedBranch({ ...base, borrowerShares: 20000000n }, 24n).feasible, false);
});
test("deduplicated dust sizes, invalid price and invalid seizure boundaries", () => {
  assert.equal(check.sizes({ ...base, collateral: 1n }).length, 1);
  assert.throws(() => check.seizedBranch(base, 0n), /SEIZURE_INPUT_INVALID/);
  assert.throws(() => check.seizedBranch(base, 101n), /SEIZURE_INPUT_INVALID/);
  assert.throws(() => check.seizedBranch({ ...base, price: 0n }, 1n), /SEIZURE_INPUT_INVALID/);
  assert.throws(() => check.seizedBranch({ ...base, shares: 0n }, 1n), /SEIZURE_INPUT_INVALID/);
});
test("Taylor accrual known answers preserve integer rounding and zero elapsed", () => {
  assert.equal(check.accrue(1000000n, 10n ** 16n, 10n), 1105166n);
  assert.equal(check.accrue(999n, 123n, 0n), 999n);
  assert.throws(() => check.accrue(1n, 1n, -1n), /ACCRUAL_INPUT_INVALID/);
});
test("canonical health uses nested floors and upward debt; healthy equality is not eligible", () => {
  const row = { ...base, lltv: 500000000000000000n, borrowerShares: 50000000n };
  assert.equal(check.eligibility(row).debt, 50n); assert.equal(check.eligibility(row).maxBorrow, 50n);
  assert.equal(check.eligibility(row).eligible, false);
  assert.equal(check.eligibility({ ...row, borrowerShares: 50000001n }).eligible, true);
});
test("negative quotes stay negative, missing gas leaves net unknown and financing is charged", () => {
  const a = check.margin({ repaid: 1000000000n, quote: 990000000n, gasUsdc: 1000000n });
  assert.equal(a.gross, -10000000n); assert.ok(a.assumedNet < a.gross); assert.ok(a.financing > 0n);
  assert.equal(a.actualNet, null);
  assert.equal(check.margin({ repaid: 1n, quote: 2n }).assumedNet, null);
  assert.throws(() => check.margin({ repaid: 1n, quote: -1n }), /COST_INPUT_INVALID/);
});
test("same-pin equality includes timestamp, root and parent; canonical selectors never use latest", async () => {
  const pin = { number: 1, hash: "0x" + "ab".repeat(32), parentHash: "0x" + "cd".repeat(32), stateRoot: "0x" + "ef".repeat(32), timestamp: "1" };
  assert.equal(check.pinEqual(pin, { ...pin }), true);
  for (const field of ["hash", "parentHash", "stateRoot", "timestamp"]) assert.equal(check.pinEqual(pin, { ...pin, [field]: "changed" }), false);
  const calls = [];
  const reader = check.pinnedReader({ handle: "fixture", pin, call: async (...args) => { calls.push(args); return check.iface.encodeFunctionResult("decimals", [6]); } });
  assert.equal((await reader.view(check.B.loan, "decimals"))[0], 6n);
  assert.deepEqual(calls[0][2].at(-1), { blockHash: pin.hash, requireCanonical: true });
});
test("healthy capture stops without previews or quotes, confirms both terminal headers", async () => {
  const now = 1800000000000, height = 26000000;
  const header = { number: ethers.toQuantity(height), hash: "0x" + "ab".repeat(32), parentHash: "0x" + "cd".repeat(32), stateRoot: "0x" + "ef".repeat(32), timestamp: ethers.toQuantity(now / 1000 - 600) };
  const calls = [];
  const a = await check.capture({ now: () => now, endpoints: ["https://ethereum.publicnode.com", "https://ethereum.drpc.org"], rpc: async (_h, method, params) => {
    calls.push([method, params]);
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_getBlockByNumber") return header;
    assert.equal(method, "eth_call"); assert.equal(params[1].blockHash, header.hash);
    const parsed = check.iface.parseTransaction(params[0]);
    const results = { idToMarketParams: [check.B.loan, check.B.collateral, check.B.oracle, check.B.irm, BigInt(check.B.lltv)],
      market: [1000n, 1000n, 999n, 999000000n, BigInt(now / 1000 - 600), 0n], position: [0n, 1000000n, 10n ** 18n], price: [10n ** 24n], borrowRate: [0n] };
    assert.ok(Object.hasOwn(results, parsed.name), "no route reads after healthy position");
    return check.iface.encodeFunctionResult(parsed.name, results[parsed.name]);
  } });
  assert.equal(a.status, "STOPPED_NOT_ELIGIBLE_OR_MATERIAL"); assert.equal(a.sizes.length, 0);
  assert.equal(a.terminalCanonical, true); assert.equal(a.networkCalls, calls.length); assert.ok(calls.length < 100);
});
test("IRM simulation uses the protocol sender and canonical hash, without wallet access", async () => {
  const pin = { hash: "0x" + "ab".repeat(32) }, calls = [];
  const params = [check.B.loan, check.B.collateral, check.B.oracle, check.B.irm, BigInt(check.B.lltv)];
  const market = [1000n, 1000n, 999n, 999000000n, 1800000000n, 0n];
  const reader = check.pinnedReader({ handle: "fixture", pin, call: async (...args) => { calls.push(args); return check.iface.encodeFunctionResult("borrowRate", [123n]); } });
  assert.equal(await reader.irmRate(params, market), 123n);
  const tx = calls[0][2][0];
  assert.equal(tx.from, check.B.morpho); assert.equal(tx.to, check.B.irm);
  assert.equal(check.iface.parseTransaction(tx).name, "borrowRate");
  assert.deepEqual(calls[0][2][1], { blockHash: pin.hash, requireCanonical: true });
  assert.equal(calls[0][1], "eth_call");
});
test("inert import and exact CLI run gate make zero network requests", async () => {
  await assert.rejects(check.main([]), /EXPLICIT_RUN_REQUIRED/);
  await assert.rejects(check.main(["--run", "extra"]), /EXPLICIT_RUN_REQUIRED/);
  const file = path.resolve(__dirname, "../check-snusd-usdc-delayed.js");
  const child = spawnSync(process.execPath, ["-e", `global.fetch=()=>{throw Error('NETWORK_FORBIDDEN')};require(${JSON.stringify(file)})`], { encoding: "utf8" });
  assert.equal(child.status, 0); assert.equal(child.stdout, ""); assert.equal(child.stderr, "");
});
