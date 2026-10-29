"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { Interface, AbiCoder, getCreate2Address, keccak256, solidityPacked } = require("../node_modules/ethers");
const near = require("../execute-aave-v4-near-liquidation.js"), guard = require("../lib/wallet-execution-guard.js");
const helper = require("../lib/aave-v4-near-swap-preflight.js");
const T = near.NEAR_TARGET_PLANS[1], OWNER = guard.MAIN_ACCOUNT, E = T.executor, WETH = T.debtAsset, WSTETH = T.collateralAsset;
const LENDER = "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb", ROUTER = "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45";
const addr = n => "0x" + n.repeat(40), hash = n => "0x" + n.repeat(64), HUB_ADDRESS = addr("4"), LIBRARY = addr("3");
const ETH_FEED = addr("1"), USDC_FEED = addr("2"), NOW = Date.parse("2026-10-19T23:00:00Z"), DEADLINE = BigInt(NOW / 1000 + 120);
const ABI = AbiCoder.defaultAbiCoder(), PLAN = near.DEDICATED_IFACE.getFunction("execute").inputs[0];
const ERC = new Interface(["function balanceOf(address) view returns(uint256)", "function approve(address,uint256) returns(bool)",
  "function transfer(address,uint256) returns(bool)", "function transferFrom(address,address,uint256) returns(bool)"]);
const FLASH = new Interface(["function flashLoan(address,uint256,bytes)", "function onMorphoFlashLoan(uint256,bytes)"]);
const LIQ = new Interface(["function liquidationCall(uint256,uint256,address,uint256,bool)"]);
const HUB = new Interface(["function remove(uint256,uint256,address) returns(uint256)",
  "function restore(uint256,uint256,(int256 sharesDelta,int256 offsetRayDelta,uint256 restoredPremiumRay)) returns(uint256)"]);
const SWAP = new Interface(["function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) returns(uint256)",
  "function swap(address,bool,int256,uint160,bytes) returns(int256,int256)", "function uniswapV3SwapCallback(int256,int256,bytes)"]);
const POOL = getCreate2Address("0x1f98431c8ad98523631ae4a59f267346ea31f984",
  keccak256(ABI.encode(["address", "address", "uint24"], [WSTETH, WETH, 100])),
  "0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54").toLowerCase();
const SWAP_DATA = ABI.encode(["tuple(bytes path,address payer)"], [[solidityPacked(["address", "uint24", "address"], [WSTETH, 100, WETH]), E]]);
const clone = x => structuredClone(x), count = n => 1 + n.calls.reduce((sum, child) => sum + count(child), 0);

function batch() {
  return { schema: "live-execution-batch/v1", batchId: "SYNTHETIC_SWAP_TEST_ONLY", approved: true, expiresAt: "2026-10-26T23:59:59Z",
    chain: "ethereum", chainId: 1, account: { address: OWNER }, targets: near.REQUIRED_TARGETS.map(address => ({ address })),
    actions: near.NEAR_TARGET_PLANS.map(p => ({ targetId: p.id, permission: "EXECUTE_ON_TRIGGER", method: p.executorKind === "UNIFIED" ? "executeMorpho" : "execute",
      executor: p.executor, spoke: p.spoke, borrower: p.borrower, collateralAsset: p.collateralAsset, debtAsset: p.debtAsset,
      ...Object.fromEntries(["collateralReserveId", "debtReserveId", "flashLoanAmount", "debtToCover", "minProfit"].map(k => [k, p[k].toString()])),
      slippage: p === T ? { mode: "QUOTE_RELATIVE", maxSlippageBps: 50, minSwapOutRaw: "375000000000000000" }
        : { mode: "NO_SWAP_SAME_ASSET", minSwapOutRaw: "0" } })),
    caps: { valueCapEth: "0", principalAtRisk: "zero (atomic synthetic)", maxExecuteGasLimit: 1200000, maxFeePerGasWei: "250000000",
      maxNativeSpendPerTransactionWei: "300000000000000", signedExecutionsPerDay: 3, maxSwapSlippageBps: 50,
      minProfitUsdcRaw: "5000000", minProfitWethRaw: "2000000000000000" },
    economics: { schema: "near-liquidation-economics/v1", additionalReserveUsdcRaw: "2000000", additionalReserveWethRaw: "500000000000000", profitHaircutBps: "1000",
      ethUsdFeed: { address: ETH_FEED, decimals: 8, maxAgeSeconds: 3600 }, usdcUsdFeed: { address: USDC_FEED, decimals: 8, maxAgeSeconds: 82800 } } };
}
function node(from, to, iface, method, args, result = [], calls = [], type = "CALL") {
  return { type, from, to, input: iface.encodeFunctionData(method, args), output: iface.encodeFunctionResult(method, result), value: "0", reverted: false, calls };
}
function bal(token, amount, from = E, account = E) { return node(from, token, ERC, "balanceOf", [account], [amount], [], "STATICCALL"); }
function tok(from, token, name, args) { return node(from, token, ERC, name, args, [true]); }
function probeTx(deadline = DEADLINE) {
  return { from: OWNER, to: E, value: "0x0", data: near.buildExecutionCalldata(T, Number(deadline - 120n) * 1000) };
}

// TEST-ONLY fabricated success trace. No captured positive trace exists, and no
// fixture amount is a live quote. Required nodes reproduce the inspected sources.
function positive(tx, options = {}) {
  const plan = near.DEDICATED_IFACE.decodeFunctionData("execute", tx.data)[0];
  const C = options.C ?? 300000000000000000n, S = options.S ?? C, X = options.X ?? S;
  const Q = options.Q ?? 405000000000000001n, O = options.O ?? Q, R = options.R ?? 400000000000000000n, P = options.P ?? O - R;
  const B = options.B ?? 10000000000000000000n, A = options.A ?? 3000000000000000000n, poolB = 100n * 10n ** 18n;
  const payload = ABI.encode(["uint256", PLAN], [1n, plan]);
  const swapCallback = node(POOL, ROUTER, SWAP, "uniswapV3SwapCallback", [X, -Q, SWAP_DATA], [], [tok(ROUTER, WSTETH, "transferFrom", [E, POOL, X])]);
  const pool = node(ROUTER, POOL, SWAP, "swap", [E, true, S, 4295128740n, SWAP_DATA], [X, -Q], [
    tok(POOL, WETH, "transfer", [E, Q]), bal(WSTETH, poolB, POOL, POOL), swapCallback, bal(WSTETH, poolB + X, POOL, POOL)
  ]);
  const router = node(E, ROUTER, SWAP, "exactInputSingle", [[WSTETH, WETH, 100, E, S, plan.minSwapOut, 0]], [Q], [pool]);
  const liquidation = node(E, T.spoke, LIQ, "liquidationCall", [0, 1, T.borrower, T.debtToCover, false], [], [
    node(T.spoke, HUB_ADDRESS, HUB, "remove", [0, C, E], [C], [tok(HUB_ADDRESS, WSTETH, "transfer", [E, C])]),
    tok(T.spoke, WETH, "transferFrom", [E, HUB_ADDRESS, R]), node(T.spoke, HUB_ADDRESS, HUB, "restore", [1, R, [0, 0, 0]], [R])
  ]);
  const callback = node(LENDER, E, FLASH, "onMorphoFlashLoan", [T.flashLoanAmount, payload], [], [
    bal(WETH, A + T.flashLoanAmount), bal(WSTETH, B), tok(E, WETH, "approve", [T.spoke, T.flashLoanAmount]), liquidation,
    tok(E, WETH, "approve", [T.spoke, 0]), bal(WETH, A + T.flashLoanAmount - R), bal(WSTETH, B + C),
    tok(E, WSTETH, "approve", [ROUTER, C]), router, tok(E, WSTETH, "approve", [ROUTER, 0]),
    bal(WETH, A + T.flashLoanAmount - R + O), tok(E, WETH, "approve", [LENDER, T.flashLoanAmount])
  ]);
  const flash = node(E, LENDER, FLASH, "flashLoan", [WETH, T.flashLoanAmount, payload], [], [
    tok(LENDER, WETH, "transfer", [E, T.flashLoanAmount]), callback, tok(LENDER, WETH, "transferFrom", [E, LENDER, T.flashLoanAmount])
  ]);
  const tree = node(OWNER, E, near.DEDICATED_IFACE, "execute", [plan], [P], [bal(WETH, A), flash, bal(WETH, A + P), tok(E, WETH, "transfer", [OWNER, P])]);
  return { tree, nodes: count(tree) };
}
function parts(trace) {
  const root = trace.tree, flash = root.calls[1], callback = flash.calls[1], c = callback.calls, router = c[8], pool = router.calls[0];
  return { root, flash, callback, c, router, pool, swapCallback: pool.calls[2], liquidation: c[3] };
}
function parse(trace, tx = probeTx(), quote = null, deadline = DEADLINE, b = 50) {
  return helper.validateRank2SwapTrace({ trace, transaction: tx, deadline, quote, maxSlippageBps: b });
}
function fixture(options = {}) {
  const f = { batch: batch(), time: NOW, calls: [], rechecks: 0, traces: 0, loads: 0 };
  f.pinned = {
    pin: { number: 26229760, hash: hash("a"), parentHash: hash("b"), stateRoot: hash("c"), timestamp: NOW / 1000 - 12, baseFeePerGas: "115000000" },
    evidence: { aliases: [2, 21], independentFamilies: true, traceQualified: true },
    assertUsable() { if (options.poisoned) throw new guard.ExecutionError("PIN_EVIDENCE_INVALIDATED"); },
    async recheck() { f.calls.push({ method: "recheck" }); f.rechecks++; await Promise.resolve(); options.onRecheck?.(f); },
    async trace(tx) {
      f.calls.push({ method: "trace", tx }); f.traces++;
      const trace = positive(tx, options.traceOptions);
      options.onTrace?.(f, trace); return trace;
    },
    async call(tx) {
      f.calls.push({ method: "call", tx });
      if (tx.to === E) return options.callOutput ?? near.DEDICATED_IFACE.encodeFunctionResult("execute", [options.traceOptions?.P ?? (options.traceOptions?.Q ?? 405000000000000001n) - (options.traceOptions?.R ?? 400000000000000000n)]);
      assert.equal(tx.to, ETH_FEED);
      const name = near.FEED_IFACE.parseTransaction({ data: tx.data }).name;
      return near.FEED_IFACE.encodeFunctionResult(name, name === "decimals" ? [8] : name === "description" ? ["ETH / USD"]
        : [1, 2400n * 10n ** 8n, f.pinned.pin.timestamp - 30, f.pinned.pin.timestamp - 30, 1]);
    },
    async estimateGas(tx) { f.calls.push({ method: "estimateGas", tx }); return options.gas ?? "0x7a120"; }
  };
  for (const name of ["nonce", "send", "signTransaction"]) Object.defineProperty(f.pinned, name, { get() { assert.fail("Forbidden signing API access: " + name); } });
  f.run = () => helper.prepareRank2SwapPreflight({ pinned: f.pinned, loadBatch: () => { f.loads++; return f.batch; }, now: () => f.time });
  return f;
}

test("import is inert and public API contains only read-only preparation and pure validation/builders", t => {
  const read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", function(file, ...args) {
    assert.doesNotMatch(String(file), /(?:\.env|rpc_endpoints|keypair|\.pem|live-execution-batch)/i); return read.call(this, file, ...args);
  });
  t.mock.method(globalThis, "fetch", () => assert.fail("No network"));
  t.mock.method(guard, "signWithProcessKey", () => assert.fail("No keys"));
  delete require.cache[require.resolve("../lib/aave-v4-near-swap-preflight.js")];
  const imported = require("../lib/aave-v4-near-swap-preflight.js");
  assert.deepEqual(Object.keys(imported).sort(), ["buildRank2SwapTransaction", "collateralRemainder", "minimumOutput", "prepareRank2SwapPreflight", "validateRank2SwapTrace"].sort());
});

for (const order of ["runner-first", "helper-first"]) test(`fresh CommonJS ${order} import is inert and resolves both complete APIs`, () => {
  const { spawnSync } = require("node:child_process");
  const script = String.raw`
    const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
    const [runnerFile, helperFile, order] = process.argv.slice(1), read = fs.readFileSync;
    fs.readFileSync = function(file, ...args) {
      assert.doesNotMatch(String(file), /(?:\.env|rpc_endpoints|keypair|\.pem|live-execution-batch)/i);
      return read.call(this, file, ...args);
    };
    globalThis.fetch = () => assert.fail("No network during import");
    const guard = require(path.join(path.dirname(helperFile), "wallet-execution-guard.js"));
    guard.signWithProcessKey = () => assert.fail("No keys during import");
    const rpc = require(path.join(path.dirname(helperFile), "executor-pinned-rpc.js"));
    rpc.loadRpcCandidates = () => assert.fail("No endpoint inventory during import");
    rpc.httpRpc = () => assert.fail("No RPC during import");
    let runner, helper;
    if (order === "runner-first") {
      runner = require(runnerFile);
      assert.equal(require.cache[helperFile], undefined, "runner must not eagerly import helper");
      helper = require(helperFile);
    } else { helper = require(helperFile); runner = require(runnerFile); }
    assert.equal(require(runnerFile), runner); assert.equal(require(helperFile), helper);
    assert.equal(typeof runner.runOnce, "function"); assert.equal(typeof runner.validateAuthorization, "function");
    assert.equal(typeof helper.prepareRank2SwapPreflight, "function");
    const built = helper.buildRank2SwapTransaction({ S: 300000000000000000n, Q: 405000000000000001n, maxSlippageBps: 50, deadline: 1792450920n });
    assert.equal(built.M, helper.minimumOutput(BigInt(built.Q), 50).toString());
    const plan = runner.DEDICATED_IFACE.decodeFunctionData("execute", built.transaction.data)[0];
    assert.equal(plan.borrower.toLowerCase(), runner.NEAR_TARGET_PLANS[1].borrower);
  `;
  const child = spawnSync(process.execPath, ["-e", script, require.resolve("../execute-aave-v4-near-liquidation.js"),
    require.resolve("../lib/aave-v4-near-swap-preflight.js"), order], { encoding: "utf8", timeout: 10000 });
  assert.ifError(child.error); assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout, ""); assert.equal(child.stderr, "");
});

test("builder uses Router02's seven-field tuple, ceiling, absolute floor and a single frozen outer deadline", () => {
  const S = 300000000000000000n, Q = 405000000000000001n;
  for (const b of [0, 1, 25, 50]) {
    const built = helper.buildRank2SwapTransaction({ S, Q, maxSlippageBps: b, deadline: DEADLINE });
    const expected = (Q * BigInt(10000 - b) + 9999n) / 10000n;
    assert.equal(built.M, expected.toString()); assert.equal(built.plan.deadline, DEADLINE);
    assert.equal(built.plan.venueType, 2); assert.equal(built.plan.swapTarget, ROUTER); assert.equal(built.plan.uniV3Fee, 100);
    assert.equal(built.plan.curveIndexIn, 0); assert.equal(built.plan.curveIndexOut, 0);
    assert.equal(built.plan.customSwapData, SWAP.encodeFunctionData("exactInputSingle", [[WSTETH, WETH, 100, E, S, expected, 0]]));
    assert.equal(built.plan.customSwapData.length, 2 + 8 + 7 * 64);
    const decoded = near.DEDICATED_IFACE.decodeFunctionData("execute", built.transaction.data)[0];
    for (const key of ["spoke", "borrower", "collateralAsset", "debtAsset"]) assert.equal(decoded[key].toLowerCase(), T[key]);
    for (const key of ["collateralReserveId", "debtReserveId", "flashLoanAmount", "debtToCover", "minProfit"]) assert.equal(decoded[key], T[key]);
    assert.equal(decoded.deadline, DEADLINE); assert.equal(built.transaction.value, "0x0");
    assert.ok(Object.isFrozen(built) && Object.isFrozen(built.plan) && Object.isFrozen(built.transaction));
  }
  assert.equal(helper.minimumOutput(376000000000000000n, 50), 375000000000000000n);
  assert.throws(() => helper.buildRank2SwapTransaction({ S, Q: 374999999999999999n, maxSlippageBps: 50, deadline: DEADLINE }));
});

test("builder rejects missing/negative/over-50bps policy, invalid amounts and opaque calldata/identity overrides", () => {
  const good = { S: "300000000000000000", Q: "405000000000000001", maxSlippageBps: 50, deadline: DEADLINE };
  for (const b of [undefined, null, -1, 51, 1.2, "50", NaN]) assert.throws(() => helper.buildRank2SwapTransaction({ ...good, maxSlippageBps: b }));
  for (const key of ["S", "Q", "deadline"]) for (const value of [0n, -1n, undefined, "junk", 1n << 256n]) {
    assert.throws(() => helper.buildRank2SwapTransaction({ ...good, [key]: value }));
  }
  for (const key of ["customSwapData", "transaction", "recipient", "tokenIn", "fee", "minSwapOut", "venueType", "plan"]) {
    assert.throws(() => helper.buildRank2SwapTransaction({ ...good, [key]: "0x" }), /OPAQUE_SWAP_INPUT_FORBIDDEN/);
  }
  const missing = { ...good }; delete missing.maxSlippageBps;
  assert.throws(() => helper.buildRank2SwapTransaction(missing));
});

test("synthetic discovery and final branches authenticate full settlement with pre-existing balances", () => {
  const tx = probeTx(), discovery = parse(positive(tx));
  assert.equal(discovery.C, "300000000000000000"); assert.equal(discovery.S, discovery.C); assert.equal(discovery.X, discovery.C);
  assert.equal(discovery.Q, "405000000000000001"); assert.equal(discovery.O, discovery.Q);
  assert.equal(discovery.R, "400000000000000000"); assert.equal(discovery.P, "5000000000000001");
  assert.equal(discovery.priorDebt, "3000000000000000000"); assert.equal(discovery.remainingCollateral, discovery.priorCollateral);
  const built = helper.buildRank2SwapTransaction({ S: discovery.S, Q: discovery.Q, maxSlippageBps: 50, deadline: DEADLINE });
  const final = parse(positive(built.transaction), built.transaction, discovery);
  assert.deepEqual(final, discovery);
  // Authenticated delegatecall contexts preserve msg.sender/address(this) relationships.
  const delegated = positive(tx), liq = parts(delegated).liquidation;
  liq.calls = [{ ...clone(liq), from: T.spoke, to: LIBRARY, type: "DELEGATECALL", calls: liq.calls }]; delegated.nodes = count(delegated.tree);
  assert.equal(parse(delegated).C, discovery.C);
});

const mutations = [
  ["root owner", p => { p.root.from = addr("8"); }],
  ["root destination", p => { p.root.to = addr("8"); }],
  ["native value", p => { p.root.value = "1"; }],
  ["root revert", p => { p.root.reverted = true; p.root.output = "0xdeadbeef"; }],
  ["root trailing bytes", p => { p.root.input += "00"; }],
  ["truncated root", p => { p.root.calls.pop(); }],
  ["reordered root", p => { [p.root.calls[0], p.root.calls[2]] = [p.root.calls[2], p.root.calls[0]]; }],
  ["flash amount", p => { const d = FLASH.decodeFunctionData("flashLoan", p.flash.input); p.flash.input = FLASH.encodeFunctionData("flashLoan", [WETH, d[1] - 1n, d[2]]); }],
  ["callback sender", p => { p.callback.from = addr("8"); }],
  ["callback payload", p => { const d = FLASH.decodeFunctionData("onMorphoFlashLoan", p.callback.input); p.callback.input = FLASH.encodeFunctionData("onMorphoFlashLoan", [d[0], d[1] + "00"]); }],
  ["liquidation borrower", p => { p.liquidation.input = LIQ.encodeFunctionData("liquidationCall", [0, 1, OWNER, T.debtToCover, false]); }],
  ["liquidation shares", p => { p.liquidation.input = LIQ.encodeFunctionData("liquidationCall", [0, 1, T.borrower, T.debtToCover, true]); }],
  ["reverted ancestor", p => { p.liquidation.reverted = true; }],
  ["debt allowance", p => { p.c[2].input = ERC.encodeFunctionData("approve", [T.spoke, T.flashLoanAmount - 1n]); }],
  ["debt allowance reset", p => { p.c[4].input = ERC.encodeFunctionData("approve", [T.spoke, 1]); }],
  ["collateral allowance not C", p => { p.c[7].input = ERC.encodeFunctionData("approve", [ROUTER, 1]); }],
  ["collateral allowance reset", p => { p.c[9].input = ERC.encodeFunctionData("approve", [ROUTER, 1]); }],
  ["approval false", p => { p.c[7].output = ERC.encodeFunctionResult("approve", [false]); }],
  ["router recipient", p => { const d = Array.from(SWAP.decodeFunctionData("exactInputSingle", p.router.input)[0]); d[3] = OWNER; p.router.input = SWAP.encodeFunctionData("exactInputSingle", [d]); }],
  ["router fee", p => { const d = Array.from(SWAP.decodeFunctionData("exactInputSingle", p.router.input)[0]); d[2] = 500; p.router.input = SWAP.encodeFunctionData("exactInputSingle", [d]); }],
  ["router token route", p => { const d = Array.from(SWAP.decodeFunctionData("exactInputSingle", p.router.input)[0]); d[0] = WETH; p.router.input = SWAP.encodeFunctionData("exactInputSingle", [d]); }],
  ["router price limit", p => { const d = Array.from(SWAP.decodeFunctionData("exactInputSingle", p.router.input)[0]); d[6] = 1; p.router.input = SWAP.encodeFunctionData("exactInputSingle", [d]); }],
  ["router minimum", p => { const d = Array.from(SWAP.decodeFunctionData("exactInputSingle", p.router.input)[0]); d[5]--; p.router.input = SWAP.encodeFunctionData("exactInputSingle", [d]); }],
  ["router trailing bytes", p => { p.router.input += "00"; }],
  ["router return trailing bytes", p => { p.router.output += "00"; }],
  ["duplicate router", p => { p.c.splice(9, 0, clone(p.router)); }],
  ["wrong pool", p => { p.pool.to = addr("8"); }],
  ["pool callback payer", p => { p.swapCallback.calls[0].input = ERC.encodeFunctionData("transferFrom", [OWNER, POOL, 300000000000000000n]); }],
  ["pool callback missing", p => { p.pool.calls.splice(2, 1); }],
  ["pool reordered", p => { p.pool.calls.reverse(); }],
  ["pool balance mismatch", p => { p.pool.calls[3].output = ERC.encodeFunctionResult("balanceOf", [1]); }],
  ["repayment short", p => { p.flash.calls[2].input = ERC.encodeFunctionData("transferFrom", [E, LENDER, T.flashLoanAmount - 1n]); }],
  ["owner profit recipient", p => { p.root.calls[3].input = ERC.encodeFunctionData("transfer", [addr("8"), 5000000000000001n]); }],
  ["fabricated profit", p => { p.root.output = near.DEDICATED_IFACE.encodeFunctionResult("execute", [999999999999999999999n]); }],
  ["unexpected collateral debit", p => { p.liquidation.calls.push(tok(T.spoke, WSTETH, "transferFrom", [E, HUB_ADDRESS, 1])); }],
  ["unexpected WETH debit", p => { p.liquidation.calls.push(tok(T.spoke, WETH, "transferFrom", [E, HUB_ADDRESS, 1])); }],
  ["wrong liquidation debt recipient", p => { p.liquidation.calls[1].input = ERC.encodeFunctionData("transferFrom", [E, addr("8"), 400000000000000000n]); }],
  ["missing collateral transfer", p => { p.liquidation.calls[0].calls = []; }],
  ["missing debt restore", p => { p.liquidation.calls.pop(); }],
  ["wrong restore amount", p => { p.liquidation.calls[2].input = HUB.encodeFunctionData("restore", [1, 1, [0, 0, 0]]); }],
  ["wrong hub remove amount", p => { p.liquidation.calls[0].input = HUB.encodeFunctionData("remove", [0, 1, E]); }],
  ["truncated frame", p => { delete p.router.calls; }],
  ["unrecognized frame type", p => { p.router.type = "CREATE"; }]
];
for (const phase of ["discovery", "final"]) for (const [name, mutate] of mutations) {
  test(`${phase} rejects ${name}`, () => {
    const discovery = parse(positive(probeTx()));
    const tx = phase === "discovery" ? probeTx() : helper.buildRank2SwapTransaction({ S: discovery.S, Q: discovery.Q, maxSlippageBps: 50, deadline: DEADLINE }).transaction;
    const trace = positive(tx); mutate(parts(trace));
    if (name !== "truncated frame") trace.nodes = count(trace.tree);
    assert.throws(() => parse(trace, tx, phase === "final" ? discovery : null), guard.ExecutionError);
  });
}

test("malformed node counts and opaque final plan/calldata mutations fail closed", () => {
  const trace = positive(probeTx()); trace.nodes++; assert.throws(() => parse(trace), /TRACE_NODE_COUNT_MISMATCH/);
  const discovery = parse(positive(probeTx())), built = helper.buildRank2SwapTransaction({ S: discovery.S, Q: discovery.Q, maxSlippageBps: 50, deadline: DEADLINE });
  for (const edit of [p => { p.spoke = OWNER; }, p => { p.minProfit--; }, p => { p.minSwapOut--; }, p => { p.venueType = 0; },
    p => { p.swapTarget = OWNER; }, p => { p.deadline++; }, p => { p.customSwapData += "00"; }, p => { p.curveIndexIn = 1; }, p => { p.uniV3Fee = 500; }]) {
    const plan = { ...built.plan }; edit(plan);
    const tx = { ...built.transaction, data: near.DEDICATED_IFACE.encodeFunctionData("execute", [plan]) };
    assert.throws(() => parse(positive(tx), tx, discovery), /TRACE_TRANSACTION_MISMATCH/);
  }
  assert.throws(() => parse(trace, { ...probeTx(), nonce: 1 }), /TRACE_TRANSACTION_MISMATCH/);
});

test("both phases reject partial input, C<S/C>S, inaccurate quote/output, or nonincremental profit despite preexisting balances", () => {
  const discovery = parse(positive(probeTx())), built = helper.buildRank2SwapTransaction({ S: discovery.S, Q: discovery.Q, maxSlippageBps: 50, deadline: DEADLINE });
  for (const phase of ["discovery", "final"]) for (const options of [
    { X: 299999999999999999n }, { C: 299999999999999999n, S: 300000000000000000n, X: 299999999999999999n },
    { C: 300000000000000001n, S: 300000000000000000n }, { O: 405000000000000000n },
    { P: 5000000000000002n }, { R: 0n }, { R: T.flashLoanAmount + 1n, Q: 2n * 10n ** 18n },
    { Q: 401999999999999999n }, { Q: 1n, O: 405000000000000001n }
  ]) {
    const tx = phase === "discovery" ? probeTx() : built.transaction;
    assert.throws(() => parse(positive(tx, options), tx, phase === "final" ? discovery : null), guard.ExecutionError);
  }
  assert.throws(() => parse(positive(built.transaction, { Q: 406000000000000001n }), built.transaction, discovery), /TRACE_DISCOVERY_FINAL_MISMATCH/);
  assert.throws(() => parse(positive(built.transaction, { B: 0n }), built.transaction, discovery), /TRACE_DISCOVERY_FINAL_MISMATCH/);
});

test("collateral arithmetic protects prior B without pretending inclusion X=S is enforced", () => {
  assert.equal(helper.collateralRemainder({ B: 100n, C: 7n, S: 10n, X: 7n }), 100n); // C<S partial fill is possible.
  assert.equal(helper.collateralRemainder({ B: 100n, C: 12n, S: 10n, X: 10n }), 102n); // Extra collateral is not liquid profit.
  assert.equal(helper.collateralRemainder({ B: 100n, C: 10n, S: 10n, X: 9n }), 101n);
  assert.throws(() => helper.collateralRemainder({ B: 100n, C: 7n, S: 10n, X: 8n }));
  assert.throws(() => helper.collateralRemainder({ B: 100n, C: 12n, S: 10n, X: 11n }));
});

test("preflight binds one pair/pin and identical final trace/call/estimate tx, returns deeply immutable simulation-only evidence", async () => {
  const f = fixture(), out = await f.run();
  assert.equal(out.status, "SIMULATION_ONLY"); assert.equal(out.simulationOnly, true); assert.equal(out.armed, undefined);
  assert.equal(out.H, hash("a")); assert.equal(out.finalCalldataHash, keccak256(out.finalTx.data));
  assert.equal(out.M, "402975000000000001"); assert.equal(out.netEstimate.positive, true);
  assert.equal(out.netEstimate.netLowerBoundProfitTokenRaw, "1150000000000000");
  assert.equal(out.gasEstimateRaw, "500000"); assert.equal(out.fees.gasLimit, 600000n); assert.equal(f.loads, 2);
  const executionReads = f.calls.filter(c => c.tx?.to === E);
  assert.deepEqual(executionReads.map(c => c.method), ["trace", "trace", "call", "estimateGas"]);
  for (const call of executionReads.slice(1)) assert.equal(call.tx, out.finalTx);
  assert.equal(near.DEDICATED_IFACE.decodeFunctionData("execute", executionReads[0].tx.data)[0].deadline.toString(), out.deadline);
  assert.equal(executionReads[0].tx.data, probeTx().data); assert.equal(f.rechecks, 2);
  for (const value of [out, out.policy, out.policy.caps, out.finalTx, out.plan, out.evidence, out.evidence.discovery, out.evidence.final, out.limitations]) assert.ok(Object.isFrozen(value));
  assert.match(out.limitations.join(" "), /does NOT enforce inclusion X=S/);
  assert.match(out.limitations.join(" "), /overwrites prior allowance/);
});

test("genuine healthy trace yields NOT_LIQUIDATABLE with no quote, final call, estimate, nonce or signing", async () => {
  const captured = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../reports/raw/fast/near-trace-compound-20261019/trace-qualification-1792450576451.json"), "utf8"));
  const deadline = near.DEDICATED_IFACE.decodeFunctionData("execute", captured.rank2Probe.call.data)[0].deadline;
  const f = fixture(); f.time = Number(deadline - 120n) * 1000;
  f.pinned.pin = { ...captured.probePin, baseFeePerGas: "115000000" };
  f.pinned.trace = async tx => { f.calls.push({ method: "trace", tx }); assert.deepEqual(tx, captured.rank2Probe.call); return captured.rank2Probe; };
  const out = await f.run();
  assert.equal(out.status, "NOT_LIQUIDATABLE"); assert.equal(out.simulationOnly, true);
  for (const key of ["S", "Q", "M", "finalTx", "gasEstimateRaw", "armed"]) assert.equal(out[key], undefined);
  assert.deepEqual(f.calls.map(c => c.method), ["recheck", "trace", "recheck"]);
});

test("reverted discovery and malformed healthy revert paths never supply a quote", async () => {
  for (const mode of ["other-error", "forged-healthy"]) {
    const f = fixture({ onTrace(_f, trace) { trace.tree.reverted = true; trace.tree.output = mode === "other-error" ? "0xdeadbeef" : "0x930bb771"; } });
    await assert.rejects(f.run(), guard.ExecutionError);
    assert.equal(f.traces, 1); assert.equal(f.calls.some(c => c.method === "estimateGas" || c.method === "call"), false);
  }
});

test("unqualified/duplicate families, stale pins and invalidated provider evidence reject before tracing", async () => {
  for (const edit of [f => { f.pinned.evidence.traceQualified = false; }, f => { delete f.pinned.evidence.traceQualified; },
    f => { f.pinned.evidence.independentFamilies = false; }, f => { f.pinned.evidence.aliases = [2, 2]; }, f => { f.pinned.evidence.aliases.push(3); },
    f => { f.pinned.pin.timestamp -= 121; }, f => { f.pinned.pin.timestamp += 100; }, f => { f.pinned.pin.hash = "0x0"; }]) {
    const f = fixture(); edit(f); await assert.rejects(f.run(), guard.ExecutionError); assert.equal(f.traces, 0);
  }
  const poisoned = fixture({ poisoned: true }); await assert.rejects(poisoned.run(), /PIN_EVIDENCE_INVALIDATED/);
});

test("pair/pin/method identity mutation or provider disagreement invalidates all simulation evidence", async () => {
  for (const mutate of [f => { f.pinned.pin.hash = hash("d"); }, f => { f.pinned.evidence.aliases = [2, 22]; },
    f => { f.pinned.trace = async () => assert.fail("Replacement trace must not run"); },
    () => { throw new guard.ExecutionError("PROVIDER_RESULT_DISAGREEMENT"); }]) {
    const f = fixture({ onTrace: mutate }); await assert.rejects(f.run(), guard.ExecutionError);
    assert.equal(f.traces, 1); assert.equal(f.calls.some(c => c.method === "call" || c.method === "estimateGas"), false);
  }
});

test("final call mismatch/malformed return, invalid or excessive gas, and nonpositive conservative net reject", async () => {
  for (const options of [{ callOutput: "0x" }, { callOutput: near.DEDICATED_IFACE.encodeFunctionResult("execute", [1]) },
    { gas: 0n }, { gas: -1 }, { gas: "not-gas" }, { gas: 1000001n }]) {
    await assert.rejects(fixture(options).run(), guard.ExecutionError);
  }
  const f = fixture(); f.batch.economics.additionalReserveWethRaw = "1650000000000000";
  await assert.rejects(f.run(), /CONSERVATIVE_NET_NONPOSITIVE/);
});

for (const [name, mutate, code] of [
  ["revocation", f => { f.batch.approved = false; }, "BATCH_INVALID_OR_EXPIRED"],
  ["expiry", f => { f.time += 1000; }, "BATCH_INVALID_OR_EXPIRED"],
  ["owner", f => { f.batch.account.address = addr("8"); }, "BATCH_SCOPE_MISMATCH"],
  ["borrower", f => { f.batch.actions[1].borrower = OWNER; }, "BATCH_ACTION_NOT_APPROVED"],
  ["targets", f => { f.batch.targets.pop(); }, "BATCH_TARGET_NOT_APPROVED"],
  ["batch identity", f => { f.batch.batchId = "other"; }, "PREFLIGHT_BATCH_CHANGED"],
  ["tighter slippage", f => { f.batch.caps.maxSwapSlippageBps = f.batch.actions[1].slippage.maxSlippageBps = 49; }, "PREFLIGHT_SLIPPAGE_TIGHTENED"],
  ["missing slippage", f => { delete f.batch.caps.maxSwapSlippageBps; }, "BATCH_SLIPPAGE_NOT_APPROVED"],
  ["economics", f => { f.batch.economics.additionalReserveWethRaw = "500000000000001"; }, "PREFLIGHT_BATCH_CHANGED"],
  ["gas cap", f => { f.batch.caps.maxExecuteGasLimit = 599999; }, "TX_CAP_EXCEEDED"],
  ["fee cap", f => { f.batch.caps.maxFeePerGasWei = "249999999"; }, "TX_CAP_EXCEEDED"],
  ["spend cap", f => { f.batch.caps.maxNativeSpendPerTransactionWei = "149999999999999"; }, "TX_CAP_EXCEEDED"]
]) test(`late ${name} during last awaited recheck is rejected by final synchronous policy gate`, async () => {
  const f = fixture({ onRecheck(state) { if (state.rechecks === 2) mutate(state); } });
  if (name === "expiry") f.batch.expiresAt = new Date(NOW + 1000).toISOString();
  await assert.rejects(f.run(), { code }); assert.equal(f.loads, 2); assert.equal(f.calls.at(-1).method, "recheck");
});

test("a tighter final policy is accepted only when the unchanged absolute floor already satisfies it", async () => {
  const f = fixture({ traceOptions: { Q: 376000000000000000n, R: 370000000000000000n },
    onRecheck(state) { if (state.rechecks === 2) state.batch.caps.maxSwapSlippageBps = state.batch.actions[1].slippage.maxSlippageBps = 40; } });
  const out = await f.run(); assert.equal(out.M, "375000000000000000"); assert.equal(out.policy.caps.maxSwapSlippageBps, 40);
});

test("runner integrates the unchanged real preflight API with fabricated positive traces and injected signer/send only", async t => {
  const os = require("node:os"), { MULTICALL3 } = require("../lib/executor-pinned-rpc.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode", "rank2-wiring-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = fixture(), signed = [], sent = [], receipts = [];
  let opens = 0, nonceReads = 0, healthReads = 0;
  const rank2 = Object.create(f.pinned);
  const health = () => near.MULTICALL_IFACE.encodeFunctionResult("aggregate3", [near.NEAR_TARGET_PLANS.map((_, i) => ({ success: true,
    returnData: near.DEDICATED_IFACE.encodeFunctionResult("previewHealthFactor", [i === 1 ? 999999000000000000n : 1001000000000000000n, i === 1, 1n, 1n]) }))]);
  Object.defineProperties(rank2, {
    call: { value: async tx => { if (tx.to === MULTICALL3) { healthReads++; return health(); } return f.pinned.call(tx); } },
    nonce: { value: async () => { nonceReads++; return 5; } },
    send: { value: async raw => { sent.push(raw); return keccak256(raw); } },
    receipt: { value: async txHash => { receipts.push(txHash); return { transactionHash: txHash, from: OWNER, to: E, blockHash: hash("d"),
      blockNumber: "0x1903e81", status: "0x1", gasUsed: "0x61a80", effectiveGasPrice: "0x6dac2c0", logs: [] }; } }
  });
  const polling = { pin: rank2.pin, evidence: { independentFamilies: true }, call: async tx => { assert.equal(tx.to, MULTICALL3); return health(); },
    recheck: async () => {}, receipt: async () => assert.fail("No polling-session receipts"),
    nonce: async () => assert.fail("No polling-session nonce"), send: async () => assert.fail("No polling-session send") };
  const out = await near.runOnce({ execute: true, pinned: polling, batch: f.batch, loadBatch: () => f.batch, now: () => f.time,
    createRank2Pinned: async () => { opens++; return rank2; }, signTransaction: async tx => { signed.push(tx); return "0x010203"; },
    executionOptions: { lockRoot: path.join(root, "locks"), journalDir: path.join(root, "journals"), receiptWaitMs: 0 } });
  assert.equal(opens, 1); assert.equal(healthReads, 1); assert.equal(f.traces, 2); assert.equal(nonceReads, 1); assert.equal(signed.length, 1); assert.equal(sent.length, 1); assert.equal(receipts.length, 1);
  const final = f.calls.filter(row => row.method === "trace")[1].tx;
  assert.equal(signed[0].data, final.data); assert.equal(signed[0].to, E);
  assert.equal(out.execution.intent.calldataHash, keccak256(final.data)); assert.equal(out.execution.stage, "RECEIPT_VERIFIED");
  assert.equal(out.execution.intent.simulation.seizedCollateralRaw, "300000000000000000");
  assert.equal(out.execution.intent.simulation.quoteOutputWethRaw, "405000000000000001");
  assert.equal(out.execution.intent.simulation.minSwapOutWethRaw, "402975000000000001");
  assert.equal(out.execution.intent.simulation.simulatedProfitBeforeGasRaw, "5000000000000001");
  assert.equal(out.execution.realizedNetProfit, "UNKNOWN");
});
