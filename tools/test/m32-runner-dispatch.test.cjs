"use strict";

// Offline dispatch/classification only. No production command, filesystem state,
// provider qualification, signing, relay or inventory access.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), { createRequire } = require("node:module");
const { Interface } = require("../node_modules/ethers"), d = require("../lib/m32-deployment.js");
const FILE = path.resolve(__dirname, "../execute-top-whale-trigger.js"), ID = "targetM32_Morpho_sUSDe_USDtb";
const BORROWER = "0xc17a3f83798c8dfe5b6bc4f05825fccf08889c65", MARKET = "0x88a18b2f4d94e7ad27a381b15531c06abf05a7c99dd5d3c3679875fed6f7e742";
const forbidden = () => assert.fail("legacy IO/fallback must not run");
function loaded(command = { check: forbidden, execute: forbidden }) {
  const native = createRequire(FILE), module = { exports: {} };
  const req = name => {
    if (name === "./lib/m32-attended-call.cjs") { if (command instanceof Error) throw command; return command; }
    if (name === "node:fs") return new Proxy({}, { get: () => forbidden });
    return native(name);
  };
  vm.compileFunction(fs.readFileSync(FILE, "utf8").replace(/^#![^\n]*\n/, ""), ["require", "module", "exports", "__dirname", "__filename"], { filename: FILE })
    (req, module, module.exports, path.dirname(FILE), FILE);
  return module.exports;
}
function nomination(extra = {}) { return { user: BORROWER, marketId: MARKET, liquidatableNow: true, ...extra }; }
function m2() {
  const outer = new Interface(["function execute((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv,address borrower,uint256 seizedAssets,address swapTarget,uint256 minLoanOut) plan,bytes swapData)"]);
  const curve = new Interface(["function exchange(int128 i,int128 j,uint256 amount,uint256 minimum)"]);
  const borrower = "0xaa34d20be3f9623ccf5bff53ef4dfa765c3f5dd5", seized = 1000n * 10n ** 18n;
  const data = outer.encodeFunctionData("execute", [["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "0x5086bf358635b81d8c47c66d1c8b9e567db70c72",
    "0xa66a4f03fd8031973f8c7718904ce32385f54e70", "0x870ac11d48b15db9a138cf899d20f13f79ba00bc", 915000000000000000n, borrower, seized,
    "0xf74c91b36c26543a0aa820bef407a577e5498bf0", 1000000000n], curve.encodeFunctionData("exchange", [0, 1, seized, 1000000000n])]);
  return { targetM2_Morpho_reUSD_USDC: { user: borrower, liquidatableNow: true, readyExecuteCurveUnwindCalldata: data } };
}
function dependencies(outputs = [], sleeps = []) { return { loadBatch: forbidden, loadCandidates: forbidden, connect: forbidden, runPass: forbidden,
  createQualifiedPairFactory: forbidden, output: value => outputs.push(value), sleep: async ms => sleeps.push(ms) }; }

for (const flags of [[], ["--check"], ["--dry-run"], ["--execute-if-liquidatable"]]) test(`dedicated ${flags[0] || "default check"} dispatch precedes every legacy dependency`, async () => {
  const calls = [], result = { status: "HOLD", failureCode: "SYNTHETIC_DEDICATED_GATE", preparedBoundaryEntered: false };
  const command = Object.fromEntries(["check", "execute"].map(name => [name, async function () { assert.equal(arguments.length, 0); calls.push(name); return result; }]));
  const outputs = []; await loaded(command).main(["--m32-only", ...flags, "--no-write"], dependencies(outputs));
  assert.deepEqual(calls, [flags.includes("--execute-if-liquidatable") ? "execute" : "check"]);
  assert.equal(outputs[0].collectionScope, "M32_ONLY"); assert.equal(outputs[0].failureCode, result.failureCode);
});
test("partition/execution/unknown arguments reject before dedicated loading or legacy IO", async () => {
  const runner = loaded(Error("must not load"));
  for (const extra of [["--m1-only"], ["--v3-only"], ["--include-aave-v4"], ["--reuse-qualified-pair"], ["--next-block"], ["--measure-only"],
    ["--execute"], ["--execute-if-liquidatable", "--check"], ["--execute-if-liquidatable", "--dry-run"], ["--check", "--dry-run"],
    ["--watch", "1"], ["--watch", "NaN"], ["--max-runs", "0"], ["--m32-only"], ["--root=elsewhere"]]) {
    await assert.rejects(runner.main(["--m32-only", ...extra], dependencies()), /M32_ARGUMENTS_REJECTED|CONFLICTING_EXECUTION_FLAGS/);
  }
});
test("missing dedicated module or rejected dedicated gate has no M2 fallback", async () => {
  await assert.rejects(loaded(Error("synthetic module unavailable")).main(["--m32-only"], dependencies()), /synthetic module unavailable/);
  await assert.rejects(loaded({ execute: async () => { throw Error("synthetic dedicated denial"); } })
    .main(["--m32-only", "--execute-if-liquidatable"], dependencies()), /synthetic dedicated denial/);
});
test("watch makes fresh zero-argument entries at 20 seconds and stops on any attempt", async () => {
  for (const boundary of [{ preparedBoundaryEntered: true }, { irreversibleHold: true }, { liquidationVerified: true }]) {
    let calls = 0; const outputs = [], sleeps = [];
    const command = { async execute() { assert.equal(arguments.length, 0); return ++calls === 1 ? { status: "HEALTHY_WAITING" } : { status: "HOLD", ...boundary }; } };
    await loaded(command).main(["--m32-only", "--execute-if-liquidatable", "--watch", "--max-runs", "5"], dependencies(outputs, sleeps));
    assert.equal(calls, 2); assert.deepEqual(sleeps, [20000]); assert.equal(outputs.length, 2);
  }
});
test("explicit five-second M32 watch sleeps 5000ms between fresh entries", async () => {
  let calls = 0; const outputs = [], sleeps = [];
  const command = { async check() { assert.equal(arguments.length, 0); calls++; return { status: "HEALTHY_WAITING" }; } };
  await loaded(command).main(["--m32-only", "--watch", "5", "--max-runs", "2"], dependencies(outputs, sleeps));
  assert.equal(calls, 2); assert.deepEqual(sleeps, [5000]); assert.equal(outputs.length, 2);
});
test("M32 watch rejects four- and one-second intervals before loading the dedicated command", async () => {
  const runner = loaded(Error("must not load"));
  for (const interval of ["4", "1"]) {
    await assert.rejects(runner.main(["--m32-only", "--watch", interval], dependencies()), /^Error: M32_ARGUMENTS_REJECTED$/);
  }
});
test("M32 warm watch requires watch without an explicit interval before dedicated loading", async () => {
  const runner = loaded(Error("must not load"));
  for (const extra of [["--m32-warm-watch"], ["--watch", "5", "--m32-warm-watch"], ["--m32-warm-watch", "--watch", "20"]]) {
    for (const mode of [[], ["--execute-if-liquidatable"]]) {
      await assert.rejects(runner.main(["--m32-only", ...mode, ...extra], dependencies()), /^Error: M32_ARGUMENTS_REJECTED$/);
    }
  }
});
for (const method of ["nextCheck", "nextExecute"]) {
  const mode = method === "nextExecute" ? ["--execute-if-liquidatable"] : [];
  test(`M32 warm ${method} runs three zero-argument entries without outer sleep and awaits close`, async () => {
    const outputs = [], calls = []; let closed = false, created = 0;
    const result = { status: "HEALTHY_WAITING" };
    const watch = { nextCheck: forbidden, nextExecute: forbidden,
      async [method]() { assert.equal(arguments.length, 0); calls.push(method); return result; },
      async close() { assert.equal(arguments.length, 0); calls.push("close"); await new Promise(resolve => setImmediate(resolve)); closed = true; } };
    const command = { check: forbidden, execute: forbidden, createWatchSession(options) {
      assert.equal(arguments.length, 1); assert.deepEqual(options, { maxRuns: 3 }); created++; return watch;
    } };
    await loaded(command).main(["--m32-only", ...mode, "--watch", "--m32-warm-watch", "--max-runs", "3"],
      { ...dependencies(outputs), sleep: forbidden });
    assert.equal(created, 1); assert.equal(closed, true);
    assert.deepEqual(calls, [method, method, method, "close"]);
    assert.deepEqual(outputs, [1, 2, 3].map(run => ({ run, collectionScope: "M32_ONLY", ...result })));
  });
  test(`M32 warm ${method} stops on each attempt boundary and closes with or without max-runs`, async () => {
    for (const boundary of ["preparedBoundaryEntered", "irreversibleHold", "liquidationVerified"]) {
      for (const bounded of [true, false]) {
        const outputs = []; let calls = 0, closed = 0, created = 0;
        const watch = { nextCheck: forbidden, nextExecute: forbidden,
          async [method]() { assert.equal(arguments.length, 0); assert.ok(++calls <= 2); return calls === 1 ? { status: "HEALTHY_WAITING" } : { status: "HOLD", [boundary]: true }; },
          async close() { assert.equal(arguments.length, 0); closed++; } };
        const command = { check: forbidden, execute: forbidden, createWatchSession(options) {
          assert.equal(arguments.length, 1); assert.deepEqual(options, bounded ? { maxRuns: 3 } : {}); created++; return watch;
        } };
        await loaded(command).main(["--m32-only", ...mode, "--watch", "--m32-warm-watch", ...(bounded ? ["--max-runs", "3"] : [])],
          { ...dependencies(outputs), sleep: forbidden });
        assert.equal(created, 1); assert.equal(calls, 2); assert.equal(closed, 1);
        assert.deepEqual(outputs, [{ run: 1, collectionScope: "M32_ONLY", status: "HEALTHY_WAITING" },
          { run: 2, collectionScope: "M32_ONLY", status: "HOLD", [boundary]: true }]);
      }
    }
  });
  test(`M32 warm ${method} awaits finally-close when the dedicated entry throws`, async () => {
    const error = Error("synthetic warm entry failure"), outputs = []; let calls = 0, closed = false, closes = 0, created = 0;
    const watch = { nextCheck: forbidden, nextExecute: forbidden,
      async [method]() { assert.equal(arguments.length, 0); calls++; throw error; },
      async close() { assert.equal(arguments.length, 0); closes++; await new Promise(resolve => setImmediate(resolve)); closed = true; } };
    const command = { check: forbidden, execute: forbidden, createWatchSession(options) {
      assert.equal(arguments.length, 1); assert.deepEqual(options, { maxRuns: 3 }); created++; return watch;
    } };
    await assert.rejects(loaded(command).main(["--m32-only", ...mode, "--watch", "--m32-warm-watch", "--max-runs", "3"],
      { ...dependencies(outputs), sleep: forbidden }), value => value === error);
    assert.equal(created, 1); assert.equal(calls, 1); assert.equal(closes, 1); assert.equal(closed, true);
    assert.deepEqual(outputs, []);
  });
}
test("M32 warm watch continues after transient HOLD and awaits close immediately on watchStopped", async () => {
  for (const method of ["nextCheck", "nextExecute"]) {
    const results = [{ status: "HOLD", watchStopped: false }, { status: "HEALTHY_WAITING" }, { status: "HOLD", watchStopped: true }];
    const outputs = []; let calls = 0, closes = 0, closed = false;
    const watch = { nextCheck: forbidden, nextExecute: forbidden,
      async [method]() { assert.equal(arguments.length, 0); assert.ok(calls < results.length, "no entry after watchStopped"); return results[calls++]; },
      async close() { assert.equal(arguments.length, 0); closes++; await new Promise(resolve => setImmediate(resolve)); closed = true; } };
    const command = { check: forbidden, execute: forbidden, createWatchSession(options) {
      assert.deepEqual(options, { maxRuns: 5 }); return watch;
    } };
    await loaded(command).main(["--m32-only", ...(method === "nextExecute" ? ["--execute-if-liquidatable"] : []),
      "--watch", "--m32-warm-watch", "--max-runs", "5"], { ...dependencies(outputs), sleep: forbidden });
    assert.equal(calls, 3); assert.equal(closes, 1); assert.equal(closed, true);
    assert.deepEqual(outputs, results.map((result, i) => ({ run: i + 1, collectionScope: "M32_ONLY", ...result })));
  }
});
test("only exact active M32 identity becomes a health nomination; old calldata is never admitted", () => {
  const runner = loaded();
  for (const row of [nomination({ user: 1 }), nomination({ marketId: 1 }), nomination({ user: d.OWNER }), nomination({ marketId: undefined }),
    nomination({ liquidatableNow: false }), nomination({ inactive: true }), nomination({ positionStatus: "UNKNOWN" }),
    { user: BORROWER, liquidatableNow: true, readyExecuteCurveUnwindCalldata: "0xdeadbeef" }]) {
    assert.equal(runner.selectCandidates({ targets: { [ID]: row } }).length, 0);
  }
  const [candidate] = runner.selectCandidates({ targets: { [ID]: nomination({ readyExecuteCurveUnwindCalldata: "0xdeadbeef",
    readyExecuteReusdCalldata: "0xcafe", conservativeProfitBeforeGasWei: "999999" }) } });
  assert.equal(candidate.kind, "MORPHO_BLUE_M32"); assert.equal(candidate.executor, d.EXECUTOR);
  assert.equal(candidate.data, undefined); assert.equal(candidate.conservativeProfitBeforeGasWei, undefined);
  assert.equal(candidate.nominationOnly, true); assert.equal(candidate.executableNow, false);
  assert.equal(runner.canonicalPosition(candidate), `1:0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb:${BORROWER}:${MARKET}`);
});
test("M32 health or malformed identity does not change other M2 classification, bytes or scaling", () => {
  const runner = loaded(), targets = m2(), baseline = runner.selectCandidates({ targets }); assert.equal(baseline.length, 1);
  assert.equal(baseline[0].kind, "MORPHO_BLUE_M2"); assert.equal(baseline[0].executor, "0x2d5bca1b846e89965544c7f03d09a25126803627");
  assert.equal(baseline[0].data, targets.targetM2_Morpho_reUSD_USDC.readyExecuteCurveUnwindCalldata);
  for (const row of [nomination(), nomination({ user: 42 })]) {
    const other = runner.selectCandidates({ targets: { ...targets, [ID]: row } }).filter(c => c.id !== ID);
    assert.deepEqual(other, baseline); assert.deepEqual(runner.buildScaledM2Variants(other[0]), runner.buildScaledM2Variants(baseline[0]));
  }
});

test("M36, M38 and M45 admit CurveRouterNG and legacy Kyber but reject other routers", () => {
  const runner = loaded(), zero = "0x0000000000000000000000000000000000000000";
  const outer = new Interface([
    "function execute((uint8 mode,address loanToken,uint256 flashAmount,address collateralToken,address oracle,address irm,uint256 lltv,address borrower,uint256 seizedAssets,address fluidVault,uint256 token0DebtAmt,uint256 token1DebtAmt,uint256 debtSharesMin,uint256 colPerUnitDebt,uint256 token0ColAmtPerUnitShares,uint256 token1ColAmtPerUnitShares,bool absorb,address approveToken1,address target1,bytes data1,address approveToken2,address target2,bytes data2,uint256 minProfit) plan) returns (uint256 profitOut)",
  ]);
  for (const [id, borrower, isReusde] of [
    ["targetM36_Morpho_sUSDS_USDT", "0x56f91d80cdf27b9e7abe845fa4bfec05f7de2794", false],
    ["targetM38_Morpho_sUSDS_USDT", "0x8d54e7f07f5502dc6428644c72850790c5dbc198", false],
    ["targetM45_Morpho_reUSDe_USDC", "0xaa34d20be3f9623ccf5bff53ef4dfa765c3f5dd5", true],
  ]) {
    const collateralToken = isReusde ? "0xddc0f880ff6e4e22e4b74632fbb43ce4df6ccc5a" : "0xa3931d71877c0e7a3148cb7eb4463524fec27fbd";
    const status = target1 => ({ targets: { [id]: { user: borrower, liquidatableNow: true,
      readyExecuteUniversalCalldata: outer.encodeFunctionData("execute", [{
        mode: 0, loanToken: isReusde ? "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" : "0xdac17f958d2ee523a2206206994597c13d831ec7",
        flashAmount: 1000_000000n, collateralToken,
        oracle: isReusde ? "0x0d63495e3e827297c2686158055989da78eb47fe" : "0x0c426d174fc88b7a25d59945ab2f7274bf7b4c79",
        irm: "0x870ac11d48b15db9a138cf899d20f13f79ba00bc", lltv: isReusde ? 770000000000000000n : 965000000000000000n,
        borrower, seizedAssets: (isReusde ? 30000n : 40000n) * 10n ** 18n,
        fluidVault: zero, token0DebtAmt: 0n, token1DebtAmt: 0n, debtSharesMin: 0n, colPerUnitDebt: 0n,
        token0ColAmtPerUnitShares: 0n, token1ColAmtPerUnitShares: 0n, absorb: false,
        approveToken1: collateralToken, target1, data1: "0x", approveToken2: zero, target2: zero, data2: "0x",
        minProfit: isReusde ? 100000000n : 50000000n,
      }]),
    } } });
    for (const router of ["0x16c6521dff6bab339122a0fe25a9116693265353", "0x6131b5fae19ea4f9d964eac0408e4408b66337b5"]) {
      const input = status(router), candidates = runner.selectCandidates(input);
      assert.equal(candidates.length, 1, id); assert.equal(candidates[0].id, id);
      assert.equal(candidates[0].data, input.targets[id].readyExecuteUniversalCalldata);
      assert.equal(candidates[0].executor, "0xc50321a07dab061d59b992e57a2ef4dca0d33089");
    }
    assert.throws(() => runner.selectCandidates(status(zero)), /EXECUTION_TARGET_MISMATCH/);
  }
});

test("combined offline pass holds M32 without loading dedicated command or signing", async () => {
  const runner = loaded(Error("combined pass must not load dedicated command"));
  const pin = { chainId: 1, number: 100, hash: "0x" + "ab".repeat(32), timestamp: 1000 };
  const pinned = { pin, evidence: {}, collectorOptions: {}, assertUsable() {}, async recheck() {}, call: forbidden, nonce: forbidden, send: forbidden, receipt: forbidden };
  const result = await runner.runPass({ pinned, argv: ["--check", "--no-write"], now: () => 1000000,
    checkOnce: async options => ({ pin, partial: false, targets: options.m1Only ? {} : { ...m2(), [ID]: nomination() } }),
    loadBatch: forbidden, loadMorphoBatch: forbidden, signTransaction: forbidden });
  assert.equal(result.fired, false); assert.equal(result.summary.candidateCount, 2);
  assert.ok(result.summary.preflightFailures.some(row => row.targetId === ID && row.reason === "M32_DEDICATED_ONLY_REQUIRED"));
});
