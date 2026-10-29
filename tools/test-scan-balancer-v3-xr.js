#!/usr/bin/env node
"use strict";

// Offline suite for the Balancer V3 X (cross-venue) and R (mint/redeem) producers.
// All RPC interactions are injected doubles; no network, no endpoint material.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("ethers");

const scanner = require("./scan-balancer-v3-xr.js");
const audit = require("./audit-trigger-coverage-universe.js");

const UNIVERSE = JSON.parse(fs.readFileSync(path.join(__dirname, "trigger-coverage-universe.json"), "utf8"));
const IFACE = new ethers.Interface([
  "function getVault() view returns (address)",
  "function querySwapSingleTokenExactIn(address pool,address tokenIn,address tokenOut,uint256 exactAmountIn,address sender,bytes userData) returns (uint256)",
  "function queryAddLiquidityUnbalanced(address pool,uint256[] exactAmountsIn,address sender,bytes userData) returns (uint256)",
  "function queryRemoveLiquiditySingleTokenExactIn(address pool,uint256 exactBptAmountIn,address tokenOut,address sender,bytes userData) returns (uint256)",
  "function queryAddLiquidityProportional(address pool,uint256 exactBptAmountOut,address sender,bytes userData) returns (uint256[])",
  "function queryRemoveLiquidityProportional(address pool,uint256 exactBptAmountIn,address sender,bytes userData) returns (uint256[])",
  "function getPool(address,address,uint24) view returns (address)",
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
const SEL = Object.fromEntries(["getVault", "querySwapSingleTokenExactIn", "queryAddLiquidityUnbalanced", "queryRemoveLiquiditySingleTokenExactIn", "queryAddLiquidityProportional", "queryRemoveLiquidityProportional", "getPool", "quoteExactInputSingle"].map((name) => [name, IFACE.getFunction(name).selector]));
const resolveRpc = async () => "http://127.0.0.1:8545";
const UNI_POOL = "0x1111111111111111111111111111111111111111";

function makeRpc(options = {}) {
  const block = { number: "0x100", hash: `0x${"ab".repeat(32)}`, timestamp: "0x100000", baseFeePerGas: "0x3b9aca00", stateRoot: `0x${"cd".repeat(32)}` };
  // A hook-guard revert is either returned as raw revert data or thrown with `.data`,
  // matching the two shapes the scanner must classify.
  const hookRevert = (data) => {
    if (options.hookGuard === "throw") throw Object.assign(new Error("execution reverted"), { data });
    return data;
  };
  const handleCall = (to, data) => {
    const selector = data.slice(0, 10);
    if (selector === SEL.getVault) {
      return IFACE.encodeFunctionResult("getVault", [options.wrongVault ? "0x2222222222222222222222222222222222222222" : scanner.VAULT]);
    }
    if (selector === SEL.getPool) return IFACE.encodeFunctionResult("getPool(address,address,uint24)", [UNI_POOL]);
    if (selector === SEL.querySwapSingleTokenExactIn) {
      if (options.failSwap) throw new Error("MOCK_SWAP_FAILURE");
      return IFACE.encodeFunctionResult("querySwapSingleTokenExactIn", [1_000_000n]);
    }
    if (selector === SEL.quoteExactInputSingle) {
      if (options.failUni) throw new Error("MOCK_UNI_FAILURE");
      return IFACE.encodeFunctionResult("quoteExactInputSingle", [999_000n, 0n, 0, 0n]);
    }
    if (options.hookGuard && selector === SEL.queryAddLiquidityUnbalanced) return hookRevert("0xe1249165");
    if (options.hookGuard && selector === SEL.queryRemoveLiquiditySingleTokenExactIn) return hookRevert("0x1d3391d8");
    if (selector === SEL.queryAddLiquidityUnbalanced) return IFACE.encodeFunctionResult("queryAddLiquidityUnbalanced", [1_000_000n]);
    if (selector === SEL.queryRemoveLiquiditySingleTokenExactIn) return IFACE.encodeFunctionResult("queryRemoveLiquiditySingleTokenExactIn", [990_000n]);
    if (selector === SEL.queryAddLiquidityProportional) {
      if (options.proportionalFail) return hookRevert("0x1d3391d8");
      return IFACE.encodeFunctionResult("queryAddLiquidityProportional", [[1_000_000n, 2_000_000_000_000_000_000n]]);
    }
    if (selector === SEL.queryRemoveLiquidityProportional) {
      if (options.proportionalFail) return hookRevert("0xe1249165");
      return IFACE.encodeFunctionResult("queryRemoveLiquidityProportional", [[999_000n, 1_999_000_000_000_000_000n]]);
    }
    throw new Error(`UNROUTED_CALL ${to} ${selector}`);
  };
  const rpcCallImpl = async (_url, method, params) => {
    if (method === "eth_getCode") return "0x6000";
    if (method === "eth_getBlockByNumber") return block;
    if (method === "eth_getBlockByHash") return block;
    if (method === "eth_call") return handleCall(params[0].to, params[0].data);
    throw new Error(`UNROUTED_METHOD ${method}`);
  };
  return { rpcCallImpl };
}

test("X binds the Router on-chain and completes both directions", async () => {
  const { rpcCallImpl } = makeRpc();
  const chain = await scanner.scanX(1, { rpcCall: rpcCallImpl, resolveRpc });
  assert.equal(chain.chainId, 1);
  assert.equal(chain.vault, scanner.VAULT);
  assert.equal(chain.reads.failed, 0);
  assert.equal(chain.reads.succeeded, chain.reads.attempted);
  assert.equal(chain.complete, true);
  assert.equal(chain.rows.length, scanner.X_ROUTES[1].sizes.length * 2);
  assert.ok(chain.rows.every((row) => row.legs.length === 2));
  assert.ok(chain.rows.every((row) => row.classification === "NO_CROSS_VENUE_EDGE"));
});

test("X rejects a Vault provenance mismatch", async () => {
  const { rpcCallImpl } = makeRpc({ wrongVault: true });
  await assert.rejects(() => scanner.scanX(1, { rpcCall: rpcCallImpl, resolveRpc }), /VAULT_PROVENANCE_MISMATCH/);
});

test("X fails the row closed when a leg fails", async () => {
  const { rpcCallImpl } = makeRpc({ failUni: true });
  const chain = await scanner.scanX(1, { rpcCall: rpcCallImpl, resolveRpc });
  assert.equal(chain.complete, false);
  assert.ok(chain.reads.failed >= 1);
  assert.ok(chain.rows.some((row) => row.classification === "INCOMPLETE"));
});

test("R completes single-token add/remove round trips on both chains", async () => {
  const { rpcCallImpl } = makeRpc();
  for (const chainId of [1, 8453]) {
    const chain = await scanner.scanR(chainId, { rpcCall: rpcCallImpl, resolveRpc });
    assert.equal(chain.complete, true, `chain ${chainId} should be complete`);
    assert.equal(chain.reads.failed, 0);
    assert.equal(chain.rows.length, scanner.R_ROUTES[chainId].deposits.length);
    assert.ok(chain.rows.every((row) => row.legType === "unbalanced"), "no hook interference keeps the unbalanced leg");
    assert.deepEqual(chain.hookGuard, []);
  }
});

test("X and R coverage evidence maps exactly the enabled universe rows", async () => {
  const { rpcCallImpl } = makeRpc();
  const artifact = await scanner.scan({ rpcCall: rpcCallImpl, resolveRpc, now: Date.parse("2026-09-21T04:59:00.000Z") });
  for (const chain of artifact.x) {
    const row = UNIVERSE.rows.find((entry) => entry.id === "ethereum-balancer-v3-x");
    assert.equal(row.onFire.enabled, true);
    const shape = audit.genericEvidenceShape(scanner.xEvidence(chain, artifact), row);
    assert.equal(shape.identity && shape.enumerationBound && shape.readsClean && shape.semanticsExact && shape.stagesWired && shape.complete && shape.dispatchEnabled, true);
  }
  for (const chain of artifact.r) {
    const row = UNIVERSE.rows.find((entry) => entry.id === `${chain.chainId === 1 ? "ethereum" : "base"}-balancer-v3-r`);
    assert.equal(row.onFire.enabled, true);
    const shape = audit.genericEvidenceShape(scanner.rEvidence(chain, artifact), row);
    assert.equal(shape.identity && shape.enumerationBound && shape.readsClean && shape.semanticsExact && shape.stagesWired && shape.complete && shape.dispatchEnabled, true);
  }
});

test("publish writes the raw artifact and one binder per configured route", async () => {
  const { rpcCallImpl } = makeRpc();
  const artifact = await scanner.scan({ rpcCall: rpcCallImpl, resolveRpc });
  const writes = [];
  const fsImpl = { mkdirSync() {}, writeFileSync(file) { writes.push(String(file)); } };
  const original = audit.atomicWriteJson;
  audit.atomicWriteJson = (file, value) => writes.push({ file: String(file), value });
  try {
    scanner.publish(artifact, { fsImpl, rawPath: path.join(scanner.WORKSPACE, "reports", "raw", "fast", "unused-xr.json") });
  } finally {
    audit.atomicWriteJson = original;
  }
  const binderFiles = writes.filter((entry) => typeof entry === "object").map((entry) => entry.file);
  assert.equal(binderFiles.length, 3); // eth X + eth R + base R
  assert.ok(binderFiles.some((file) => file.endsWith("balancer-v3-ethereum-x.json")));
  assert.ok(binderFiles.some((file) => file.endsWith("balancer-v3-ethereum-r.json")));
  assert.ok(binderFiles.some((file) => file.endsWith("balancer-v3-base-r.json")));
});

test("Base X has no route and no Uniswap leg (honest gap)", () => {
  assert.equal(scanner.X_ROUTES[8453], undefined);
  const serialized = JSON.stringify(scanner.X_ROUTES, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
  assert.doesNotMatch(serialized, /https?:\/\//i);
});

// --- hook-guard classification + proportional fallback ------------------------------------

test("hook-guard selectors are recognised and mapped to their Vault errors", () => {
  assert.deepEqual(scanner.HOOK_GUARD_SELECTORS, {
    "0xe1249165": "AfterAddLiquidityHookFailed",
    "0x1d3391d8": "AfterRemoveLiquidityHookFailed",
  });
  assert.equal(scanner.revertSelector("0xe1249165"), "0xe1249165");
  assert.equal(scanner.revertSelector("0x1D3391d8deadbeef"), "0x1d3391d8");
  assert.equal(scanner.revertSelector("0x1234"), null);
  assert.equal(scanner.revertSelector(null), null);
  assert.equal(scanner.hookGuardSelector("0xe1249165"), "0xe1249165");
  assert.equal(scanner.hookGuardSelector("0x1d3391d8"), "0x1d3391d8");
  assert.equal(scanner.hookGuardSelector("0xdeadbeef"), null);
  assert.equal(scanner.revertDataFromError({ data: "0xe1249165" }), "0xe1249165");
  assert.equal(scanner.revertDataFromError({ error: { data: "0x1d3391d8" } }), "0x1d3391d8");
  assert.equal(scanner.revertDataFromError({ info: { error: { data: "0xe1249165" } } }), "0xe1249165");
  assert.equal(scanner.revertDataFromError(new Error("plain")), null);
});

test("callDecoded classifies hook-guard reverts and keeps other failures classified", async () => {
  const pool = scanner.R_ROUTES[8453].pool;
  const args = [pool, [1n], scanner.SENDER, "0x"];
  const decode = (rpcCallImpl, revertCapture) => scanner.callDecoded("rpc", pool, IFACE, "queryAddLiquidityUnbalanced", args, "0x1", rpcCallImpl, revertCapture);

  // returned raw revert data
  await assert.rejects(() => decode(async () => "0xe1249165"), /HOOK_GUARD/);
  await assert.rejects(() => decode(async () => "0x1d3391d8"), /HOOK_GUARD/);
  // thrown transport error carrying `.data`
  await assert.rejects(() => decode(async () => { throw Object.assign(new Error("execution reverted"), { data: "0xe1249165" }); }), /HOOK_GUARD/);
  // collapsed to null -> re-probe captures the cause
  await assert.rejects(() => decode(async () => null, async () => "0x1d3391d8"), /HOOK_GUARD/);
  // a generic revert is not a hook guard
  await assert.rejects(() => decode(async () => "0xdeadbeef"), /ABI_DECODE_FAILED/);
  await assert.rejects(() => decode(async () => null, async () => null), /CALL_FAILED/);
  // a normal result still decodes
  const ok = await decode(async () => IFACE.encodeFunctionResult("queryAddLiquidityUnbalanced", [42n]));
  assert.equal(ok[0], 42n);
});

test("R falls back to a PROPORTIONAL round trip when the hook rejects an unbalanced leg", async () => {
  const { rpcCallImpl } = makeRpc({ hookGuard: "return" });
  const chain = await scanner.scanR(8453, { rpcCall: rpcCallImpl, resolveRpc, revertCapture: async () => null });
  assert.equal(chain.complete, true);
  assert.equal(chain.reads.failed, 0);
  assert.equal(chain.rows.length, scanner.R_ROUTES[8453].deposits.length);
  assert.ok(chain.rows.every((row) => row.legType === "proportional"));
  assert.ok(chain.rows.every((row) => row.classification === "NO_JOIN_EXIT_EDGE"));
  assert.equal(chain.hookGuard.length, scanner.R_ROUTES[8453].deposits.length);
  assert.ok(chain.hookGuard.every((guard) => guard.fallbackUsed === true && guard.fallback === "proportional"));

  const evidence = scanner.rEvidence(chain, { scannedAt: "2026-09-21T20:46:36.066Z" });
  assert.deepEqual(evidence.blockers, []);
  assert.ok(evidence.evidence.some((line) => /surge-hook guard: imbalance-increasing direction rejected .* proportional fallback used/.test(line)));
  assert.ok(evidence.evidence.some((line) => /\[proportional\]/.test(line)));
  assert.equal(evidence.dispatchEnabled, true);
  const row = UNIVERSE.rows.find((entry) => entry.id === "base-balancer-v3-r");
  const shape = audit.genericEvidenceShape(evidence, row);
  assert.equal(shape.identity && shape.enumerationBound && shape.readsClean && shape.semanticsExact && shape.stagesWired && shape.complete && shape.dispatchEnabled, true);
});

test("R surfaces the classified hook-guard cause when the proportional fallback also fails", async () => {
  const { rpcCallImpl } = makeRpc({ hookGuard: "throw", proportionalFail: true });
  const chain = await scanner.scanR(8453, { rpcCall: rpcCallImpl, resolveRpc, revertCapture: async () => null });
  assert.equal(chain.complete, false);
  assert.ok(chain.reads.failed >= 1);
  assert.ok(chain.hookGuard.every((guard) => guard.fallbackUsed === false));
  assert.ok(chain.errors.every((line) => line.includes("HOOK_GUARD")));

  const evidence = scanner.rEvidence(chain, { scannedAt: "2026-09-21T20:46:36.066Z" });
  assert.equal(evidence.dispatchEnabled, false);
  assert.ok(evidence.blockers.some((line) => /surge-hook guard: imbalance-increasing direction rejected .* proportional fallback failed/.test(line)));
  assert.equal(evidence.blockers.some((line) => /CALL_FAILED/.test(line)), false, "no bare CALL_FAILED for a classified hook guard");
  assert.equal(/CALL_FAILED/.test(JSON.stringify(chain)), false);
});
