"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs");
const { Interface, AbiCoder, Transaction, keccak256, solidityPacked } = require("../node_modules/ethers");
const guard = require("../lib/wallet-execution-guard.js");
const rank1 = require("../lib/rank1-aave-v4-proof.js");
const { prepareRank1 } = require("../lib/rank1-aave-v4-settlement.js");
const { createM1V2Budget } = require("../execute-top-whale-trigger.js");
const { createNextBlockContext, normalizeSimulationTransaction } = require("../lib/next-block-simulation.js");
const { v3InputPool } = require("../lib/next-block-execution.js");
const { TARGET: T, POLICY } = rank1, ABI = AbiCoder.defaultAbiCoder();
const EXEC = new Interface(JSON.parse(fs.readFileSync(require.resolve("../fork-poc/contracts/FlashLiquidateAaveV4.compiled.json"))).abi);
const PLAN = EXEC.getFunction("execute").inputs[0];
const TOKEN = new Interface(["function balanceOf(address) view returns(uint256)", "function approve(address,uint256) returns(bool)",
  "function transfer(address,uint256) returns(bool)", "function transferFrom(address,address,uint256) returns(bool)",
  "event Transfer(address indexed from,address indexed to,uint256 value)"]);
const FLASH = new Interface(["function flashLoan(address,uint256,bytes)", "function onMorphoFlashLoan(uint256,bytes)"]);
const SPOKE = new Interface(["function liquidationCall(uint256,uint256,address,uint256,bool)"]);
const HUB = new Interface(["function remove(uint256,uint256,address) returns(uint256)",
  "function restore(uint256,uint256,(int256 sharesDelta,int256 offsetRayDelta,uint256 restoredPremiumRay)) returns(uint256)"]);
const SWAP = new Interface(["function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns(uint256)",
  "function swap(address,bool,int256,uint160,bytes) returns(int256,int256)", "function uniswapV3SwapCallback(int256,int256,bytes)"]);
const QUOTE = new Interface(["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns(uint256,uint160,uint32,uint256)"]);
const U = 10n ** 6n, W = 10n ** 18n, MAX = (1n << 256n) - 1n, AT = 1792875000;
const addr = n => "0x" + BigInt(n).toString(16).padStart(40, "0"), hash = n => "0x" + BigInt(n).toString(16).padStart(64, "0");
const LENDER = "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb", ROUTER = "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45";
const QUOTER = "0x61ffe014ba17989e743c5f6cb21bf9697530b21e", POOL = v3InputPool(T.usde, T.usdc, 100);
const HUB_ADDRESS = addr(71), LIBRARY = addr(72), IMPLEMENTATION = addr(73);
// Explicit commitment from the approved build (not runtime bytes or provider data).
const COMMITMENT = "0x9bfeec237d3689863be8dda33148dfecaa28433c115513b2cc211733c593f833";
const CALLBACK = ABI.encode(["tuple(bytes path,address payer)"], [[solidityPacked(["address", "uint24", "address"], [T.usde, 100, T.usdc]), T.executor]]);
const clone = value => structuredClone(value), turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const variant = plan => plan.flashLoanAmount === 1008000000000n ? 1 : plan.debtToCover === MAX ? 0 : 2;
const safe = code => error => { assert.ok(error instanceof guard.ExecutionError); assert.equal(error.code, code); assert.equal(error.message, code); return true; };
const flatten = tree => [tree, ...tree.calls.flatMap(flatten)];

function traceFixture(tx, plan, amounts, proxy = 1) {
  const { C, D, O } = amounts, F = plan.flashLoanAmount, P = O - D;
  const node = (from, to, iface, method, args, result = [], calls = [], type = "CALL") => ({ type, from, to,
    input: iface.encodeFunctionData(method, args).toLowerCase(), output: iface.encodeFunctionResult(method, result).toLowerCase(), value: "0", reverted: false, calls });
  const token = (from, target, method, args, result = true, type = "CALL") => {
    const frame = node(from, target, TOKEN, method, args, [result], [], type);
    if (target === T.usdc) {
      let parent = frame;
      for (let i = 0; i < proxy; i++) {
        const child = { ...frame, type: "DELEGATECALL", from: target, to: addr(BigInt(IMPLEMENTATION) + BigInt(i)), calls: [] };
        parent.calls.push(child); parent = child;
      }
    }
    return frame;
  };
  const balance = (from, target, account, value) => token(from, target, "balanceOf", [account], value, "STATICCALL");
  const remove = node(T.spoke, HUB_ADDRESS, HUB, "remove", [3, C, T.executor], [C / 2n], [token(HUB_ADDRESS, T.usde, "transfer", [T.executor, C])]);
  const debt = token(T.spoke, T.usdc, "transferFrom", [T.executor, HUB_ADDRESS, D]);
  const restore = node(T.spoke, HUB_ADDRESS, HUB, "restore", [4, D - 1n, [0, 0, 1]], [D / 2n], [balance(HUB_ADDRESS, T.usdc, HUB_ADDRESS, D)]);
  const liquidation = node(T.executor, T.spoke, SPOKE, "liquidationCall", [3, 4, T.borrower, plan.debtToCover, false], [], [
    { type: "DELEGATECALL", from: T.spoke, to: LIBRARY, input: "0x12345678", output: "0x", value: "0", reverted: false, calls: [remove, debt, restore] },
  ]);
  const swapCallback = node(POOL, ROUTER, SWAP, "uniswapV3SwapCallback", [C, -O, CALLBACK], [], [token(ROUTER, T.usde, "transferFrom", [T.executor, POOL, C])]);
  const pool = node(ROUTER, POOL, SWAP, "swap", [T.executor, true, C, 4295128740n, CALLBACK], [C, -O], [
    token(POOL, T.usdc, "transfer", [T.executor, O]), balance(POOL, T.usde, POOL, W), swapCallback, balance(POOL, T.usde, POOL, W + C),
  ]);
  const router = node(T.executor, ROUTER, SWAP, "exactInputSingle", [[T.usde, T.usdc, 100, T.executor, C, plan.minSwapOut, 0]], [O], [pool]);
  const payload = ABI.encode(["uint256", PLAN], [9, plan]);
  const callback = node(LENDER, T.executor, FLASH, "onMorphoFlashLoan", [F, payload], [], [
    balance(T.executor, T.usdc, T.executor, F), balance(T.executor, T.usde, T.executor, 0n),
    token(T.executor, T.usdc, "approve", [T.spoke, F]), liquidation, token(T.executor, T.usdc, "approve", [T.spoke, 0]),
    balance(T.executor, T.usdc, T.executor, F - D), balance(T.executor, T.usde, T.executor, C),
    token(T.executor, T.usde, "approve", [ROUTER, C]), router, token(T.executor, T.usde, "approve", [ROUTER, 0]),
    balance(T.executor, T.usdc, T.executor, F - D + O), token(T.executor, T.usdc, "approve", [LENDER, F]),
  ]);
  const flash = node(T.executor, LENDER, FLASH, "flashLoan", [T.usdc, F, payload], [], [
    token(LENDER, T.usdc, "transfer", [T.executor, F]), callback, token(LENDER, T.usdc, "transferFrom", [T.executor, LENDER, F]),
  ]);
  const tree = node(T.owner, T.executor, EXEC, "execute", [plan], [P], [balance(T.executor, T.usdc, T.executor, 0n), flash,
    balance(T.executor, T.usdc, T.executor, P), token(T.executor, T.usdc, "transfer", [T.owner, P])]);
  assert.equal(tree.input, tx.input);
  return { tree, nodes: flatten(tree).length };
}
function log(iface, method, address, args) {
  const event = iface.encodeEventLog(iface.getEvent(method), args);
  return { address, topics: event.topics.map(t => t.toLowerCase()), data: event.data.toLowerCase() };
}
function settlementLogs(plan, { C, D, O }) {
  const F = plan.flashLoanAmount, P = O - D;
  return [
    [T.usdc, LENDER, T.executor, F], [T.usde, HUB_ADDRESS, T.executor, C], [T.usdc, T.executor, HUB_ADDRESS, D],
    [T.usdc, POOL, T.executor, O], [T.usde, T.executor, POOL, C], [T.usdc, T.executor, LENDER, F], [T.usdc, T.executor, T.owner, P],
  ].map(([token, from, to, value]) => log(TOKEN, "Transfer", token, [from, to, value])).concat([
    log(EXEC, "LiquidatedAndUnwound", T.executor, [9, T.spoke, T.borrower, T.usdc, T.usde, D, C, O, P]),
  ]);
}

function fixture(mode = "CURRENT", options = {}) {
  const future = mode === "NEXT_BLOCK_PASSIVE";
  const state = { wall: AT * 1000 + 1000, mono: 100, reads: [], active: 0, peak: 0, traceCalls: 0, qualifications: 0, authChecks: 0,
    usable: true, hook: async () => {}, authHook: () => undefined, traceHook: () => undefined, resultHook: () => undefined,
    amountHook: () => undefined, quoteHook: () => undefined, estimate: 900000n, settled: 0 };
  const pin = { number: 26265000, hash: hash(26265000), parentHash: hash(26264999), stateRoot: hash(400), timestamp: AT,
    baseFeePerGas: options.baseFeePerGas ?? "50000000", gasLimit: "60000000" };
  const context = createNextBlockContext(pin), evidence = { aliases: [1, 3], strictEvidence: true, independentFamilies: true,
    fixedProviderPair: true, rawTimestamp: true, codeHashPinnedQualified: true };
  const amounts = (plan, final) => ({ C: 352000n * W, D: 345000n * U, O: 352000n * U, ...state.amountHook(plan, final) });
  function assertUsable() { if (!state.usable) throw new guard.ExecutionError("PIN_EVIDENCE_INVALIDATED"); }
  async function request(kind, tx) {
    if (kind !== "simulate") { assert.ok(Object.hasOwn(tx, "data")); assert.equal(Object.hasOwn(tx, "input"), false); }
    const wire = normalizeSimulationTransaction(tx);
    assert.deepEqual(Object.keys(wire), ["type", "from", "to", "input", "value", "nonce", "gas", "maxFeePerGas", "maxPriorityFeePerGas", "chainId", "accessList"]);
    assert.equal(wire.from, T.owner); assert.equal(wire.nonce, "0x36"); assert.equal(wire.chainId, "0x1"); assert.equal(wire.type, "0x2"); assert.equal(wire.value, "0x0");
    assert.ok(BigInt(wire.gas) <= caps.gasCap); assert.ok(BigInt(wire.maxFeePerGas) <= caps.feeCap);
    assert.ok(BigInt(wire.gas) * BigInt(wire.maxFeePerGas) <= caps.spendCap);
    const iface = wire.to === QUOTER ? QUOTE : EXEC, decoded = iface.parseTransaction({ data: wire.input });
    const plan = decoded.name === "execute" ? decoded.args[0] : null;
    const entry = { kind, wire, method: decoded.name, plan, index: plan ? variant(plan) : null, final: !!plan && plan.minSwapOut !== 1n };
    state.reads.push(entry); state.peak = Math.max(state.peak, ++state.active);
    try {
      await state.hook(entry);
      let result, values;
      if (kind === "estimate") return state.estimate;
      if (decoded.name === "nonce") values = [8];
      else if (decoded.name === "quoteExactInputSingle") {
        const q = decoded.args[0];
        assert.equal(q.tokenIn.toLowerCase(), T.usde); assert.equal(q.tokenOut.toLowerCase(), T.usdc);
        assert.equal(q.fee, 100n); assert.equal(q.sqrtPriceLimitX96, 0n);
        values = [state.quoteHook(q.amountIn) ?? q.amountIn / 10n ** 12n, 0, 0, 100000];
        entry.quoteInput = q.amountIn;
      } else {
        assert.equal(decoded.name, "execute"); const actual = amounts(plan, entry.final);
        if (kind === "trace") {
          state.traceCalls++;
          result = traceFixture(wire, plan, actual, options.proxy ?? 1);
          state.traceHook(result, entry); result.nodes = flatten(result.tree).length;
          return result;
        }
        values = [actual.O - actual.D];
        if (kind === "simulate") result = { logs: settlementLogs(plan, actual) };
      }
      const returnData = iface.encodeFunctionResult(decoded.name, values);
      if (kind === "call") { state.resultHook({ returnData }, entry); return entry.returnData ?? returnData; }
      result = { context: { ...context, transaction: wire }, gasLimit: wire.gas, gasUsed: "0xdbba0", logs: [], ...result, returnData };
      state.resultHook(result, entry); return result;
    } finally { state.active--; state.settled++; }
  }
  const current = { pin, evidence, assertUsable, async nonce(account) { assert.equal(account, T.owner); return 54; },
    call: tx => request("call", tx), estimateGas: tx => request("estimate", tx), async recheck() { assertUsable(); } };
  const facet = { pin, evidence: { aliases: [1, 3], traceQualified: true, independentFamilies: true, fixedProviderPair: true,
    hashPinnedBlockNumberVerified: true, unknownHashRejected: true }, assertUsable, trace: tx => request("trace", tx) };
  const lease = { current, async qualifyCurrentTrace() { state.qualifications++; assert.equal(future, false, "FUTURE must never qualify traces"); return facet; } };
  const active = future ? { ...current, evidence: { ...evidence, nextBlockQualified: true }, nextBlock: { context,
    simulate: tx => request("simulate", tx), async recheck() { assertUsable(); } } } : current;
  const caps = { gasCap: 1300000n, feeCap: options.competitive ? 1500000000n : 250000000n,
    spendCap: options.competitive ? 1950000000000000n : 550000000000000n, minProfitUsdc: 100n * U,
    maxFlashLoanUsdcRaw: 1008000000000n, maxSlippageBps: 50, maxVariantsPerContext: 3, dailyCap: null, lifetimeCap: null };
  const authorization = { caps, assertCurrent() { state.authChecks++; return state.authHook(); } };
  const proofPin = { number: String(pin.number), hash: pin.hash, timestamp: String(pin.timestamp) };
  const proofInputs = { runtime: { schema: "rank1-runtime-proof/v1", targetId: T.id, executor: T.executor, owner: T.owner,
    runtimeKeccak256: COMMITMENT, source: { runtimeKeccak256: COMMITMENT }, pin: proofPin,
    inventories: { usde: { balanceRaw: "0" }, usdc: { balanceRaw: "0" } } },
  feeds: { schema: "rank1-feeds/v1", pin: proofPin, contextTimestamp: String(future ? context.timestamp : pin.timestamp),
    ...Object.fromEntries(["ethUsd", "usdcUsd"].map(name => [name, { ...POLICY[name], roundId: "7", answeredInRound: "7",
      answerRaw: name === "ethUsd" ? "200000000000" : "100000000", startedAt: String(AT - 60), updatedAt: String(AT - 30) }])) } };
  const observation = { id: T.id, spoke: T.spoke, borrower: T.borrower, mode, healthFactorRaw: "999999999999999999",
    isLiquidatableBothProviders: true, liquidatable: true };
  const budget = createM1V2Budget({ wallNow: () => state.wall, monotonicNow: () => state.mono }); budget.bind(lease);
  const args = { lease, active, observation, proofInputs, authorization, budget, now: () => state.wall };
  return { state, args, facet, context, run: () => prepareRank1(args) };
}

test("only prepareRank1 is exported; import is inert", t => {
  const file = require.resolve("../lib/rank1-aave-v4-settlement.js"), cached = require.cache[file], read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (p, ...args) => {
    assert.ok(String(p).replaceAll("\\", "/").endsWith("/tools/lib/rank1-aave-v4-settlement.js")); return read(p, ...args);
  });
  t.mock.method(fs, "writeFileSync", () => assert.fail("NO_WRITES"));
  t.mock.method(globalThis, "fetch", () => assert.fail("NO_NETWORK"));
  delete require.cache[file];
  try { assert.deepEqual(Object.keys(require(file)), ["prepareRank1"]); } finally { require.cache[file] = cached; }
});

for (const mode of ["CURRENT", "NEXT_BLOCK_PASSIVE"]) test(`${mode}: real preparation verifies settlement and immutable complete envelope`, async () => {
  const f = fixture(mode), current = f.args.lease.current, result = await f.run(), p = result.proof, tx = result.transaction;
  const plan = EXEC.decodeFunctionData("execute", tx.data)[0];
  assert.equal(f.args.lease.current, current); assert.equal(f.state.active, 0); assert.equal(f.state.peak, 2);
  assert.equal(f.state.qualifications, mode === "CURRENT" ? 1 : 0); assert.equal(f.state.traceCalls, mode === "CURRENT" ? 4 : 0);
  assert.equal(plan.minSwapOut, 350240n * U); assert.equal(plan.minProfit, 5240n * U);
  assert.equal(p.settlement.C, String(352000n * W)); assert.equal(p.settlement.D, String(345000n * U));
  assert.equal(p.settlement.P, String(7000n * U)); assert.equal(p.selectedVariant, 0);
  assert.deepEqual(p.variants.map(row => row.status), ["VERIFIED", "VERIFIED", "SKIPPED"]);
  assert.equal(f.state.reads.some(row => row.index === 2), false);
  assert.equal(p.economics.contractEnforcedProfitUsdcRaw, String(plan.minProfit));
  assert.ok(result.conservativeProfitBeforeGasWei > 0n); assert.ok(BigInt(p.economics.afterGas.netNativeWei) > 0n);
  assert.equal(result.conservativeProfitBeforeGasWei - tx.gasLimit * tx.maxFeePerGas, BigInt(p.economics.afterGas.netNativeWei));
  assert.deepEqual(p.transaction, normalizeSimulationTransaction(tx)); assert.equal(p.calldataHash, keccak256(tx.data));
  const { from, ...unsigned } = tx; assert.equal(from, T.owner); assert.equal(p.unsignedTransactionHash, Transaction.from(unsigned).unsignedHash);
  assert.equal(tx.gasLimit, mode === "CURRENT" ? 1080000n : 1300000n);
  assert.equal(tx.type, 2); assert.equal(tx.chainId, 1); assert.equal(tx.nonce, 54); assert.equal(tx.value, 0n); assert.equal(tx.to, T.executor);
  assert.equal(f.args.budget.snapshot().unsignedReadyWallMs, null, "only runner accepts unsigned evidence");
  assert.equal(p.realizedProfit, "UNKNOWN"); assert.equal(p.settlementVerified, true);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(tx) && Object.isFrozen(p.quote) && Object.isFrozen(p.economics.feeds.ethUsd));
  assert.throws(() => { tx.maxFeePerGas++; }, TypeError); assert.throws(() => { p.plan.minProfit = "999999999999"; }, TypeError);
  const executions = f.state.reads.filter(row => row.plan && row.kind !== "estimate");
  for (const row of executions.filter(row => !row.final)) { assert.equal(row.plan.minSwapOut, 1n); assert.equal(row.plan.minProfit, 100n * U); }
  assert.ok(executions.filter(row => row.final).every(row => row.plan.minSwapOut === plan.minSwapOut && row.plan.minProfit === plan.minProfit));
  const quotes = f.state.reads.filter(row => row.method === "quoteExactInputSingle");
  assert.equal(quotes.length, 2); assert.ok(quotes.every(row => row.quoteInput === 352000n * W));
  for (const row of f.state.reads.filter(row => row.plan && row.final && row.index === p.selectedVariant && row.kind !== "estimate")) assert.deepEqual(row.wire, p.transaction);
});

for (const proxy of [0, 1, 2]) test(`CURRENT authenticates USDC token entry with ${proxy} delegate levels`, async () => {
  const f = fixture("CURRENT", { proxy }); assert.ok((await f.run()).proof.settlementVerified);
});

test("FUTURE never accesses trace or current execution/gas methods", async () => {
  const f = fixture("NEXT_BLOCK_PASSIVE");
  f.args.lease.qualifyCurrentTrace = () => assert.fail("NO_TRACE");
  f.args.active.call = () => assert.fail("NO_CURRENT_CALL"); f.args.active.estimateGas = () => assert.fail("NO_ESTIMATE");
  assert.ok((await f.run()).proof.settlementVerified); assert.equal(f.state.traceCalls, 0);
});

for (const [field, value] of [["id", "another-target"], ["spoke", addr(99)], ["borrower", addr(99)]]) test(`focused health binds ${field}`, async () => {
  const f = fixture(); f.args.observation[field] = value;
  await assert.rejects(f.run(), safe("RANK1_OBSERVATION_SCOPE_INVALID")); assert.equal(f.state.qualifications, 0);
});
for (const mode of ["CURRENT", "NEXT_BLOCK_PASSIVE"]) for (const health of ["0", "1000000000000000000"])
  test(`${mode} rejects ineligible health ${health}`, async () => {
    const f = fixture(mode); f.args.observation.healthFactorRaw = health;
    await assert.rejects(f.run(), safe(mode === "CURRENT" ? "RANK1_CURRENT_NOT_LIQUIDATABLE" : "RANK1_FUTURE_NOT_LIQUIDATABLE"));
    assert.equal(f.state.reads.length, 0);
  });
test("CURRENT cannot replace the lease.current identity", async () => {
  const f = fixture(); f.args.active = { ...f.args.active };
  await assert.rejects(f.run(), safe("RANK1_MODE_INVALID"));
});

for (const code of ["TRACE_CAPABILITY_UNAVAILABLE", "TRACE_METHOD_UNAVAILABLE", "TRACE_RESOURCE_UNAVAILABLE"]) test(`${code} is typed CURRENT unavailable only`, async () => {
  const f = fixture(); f.args.lease.qualifyCurrentTrace = async () => { throw new guard.ExecutionError(code); };
  await assert.rejects(f.run(), safe("RANK1_CURRENT_TRACE_UNAVAILABLE")); assert.equal(f.state.reads.length, 0);
});
for (const code of ["PROVIDER_RESULT_DISAGREEMENT", "TRACE_UNKNOWN_HASH_NOT_REJECTED", "TRACE_SHAPE_INVALID", "PIN_CHANGED", "M1_HOT_PATH_BUDGET"])
  test(`trace qualification ${code} stays fatal, never unavailable`, async () => {
    const f = fixture(); f.args.lease.qualifyCurrentTrace = async () => { throw new guard.ExecutionError(code); };
    await assert.rejects(f.run(), safe(code));
  });
test("trace unavailable cannot hide simultaneous lease revocation", async () => {
  const f = fixture(); f.args.lease.qualifyCurrentTrace = async () => { f.state.usable = false; throw new guard.ExecutionError("TRACE_CAPABILITY_UNAVAILABLE"); };
  await assert.rejects(f.run(), safe("PIN_EVIDENCE_INVALIDATED"));
});
for (const field of ["traceQualified", "fixedProviderPair", "hashPinnedBlockNumberVerified", "unknownHashRejected", "independentFamilies", "aliases"])
  test(`trace facet requires ${field} on the same pin/pair`, async () => {
    const f = fixture(); f.facet.evidence[field] = field === "aliases" ? [1, 2] : false;
    await assert.rejects(f.run(), safe("RANK1_TRACE_PAIR_INVALID"));
  });

for (const kind of ["missing-event", "duplicate-event", "wrong-event-address", "wrong-event-nonce", "missing-transfer", "recipient", "lender", "seizure", "output", "return", "extra-owner-flow", "transfer-order", "removed"])
  test(`FUTURE rejects ${kind} settlement evidence`, async () => {
    const f = fixture("NEXT_BLOCK_PASSIVE");
    f.state.resultHook = (result, row) => {
      if (!row.plan) return; const logs = result.logs, plan = row.plan;
      if (kind === "missing-event") logs.pop();
      if (kind === "duplicate-event") logs.push(clone(logs.at(-1)));
      if (kind === "wrong-event-address") logs.at(-1).address = addr(88);
      if (kind === "wrong-event-nonce") logs.at(-1).topics[1] = hash(10);
      if (kind === "missing-transfer") logs.splice(3, 1);
      if (kind === "recipient") logs[6] = log(TOKEN, "Transfer", T.usdc, [T.executor, addr(88), 7000n * U]);
      if (kind === "lender") logs[5] = log(TOKEN, "Transfer", T.usdc, [T.executor, addr(88), plan.flashLoanAmount]);
      if (kind === "seizure") logs[1] = log(TOKEN, "Transfer", T.usde, [HUB_ADDRESS, T.executor, 352000n * W + 1n]);
      if (kind === "output") logs[3] = log(TOKEN, "Transfer", T.usdc, [POOL, T.executor, 352000n * U + 1n]);
      if (kind === "return") result.returnData = EXEC.encodeFunctionResult("execute", [7000n * U + 1n]);
      if (kind === "extra-owner-flow") logs.unshift(log(TOKEN, "Transfer", T.usdc, [T.owner, T.executor, 1]));
      if (kind === "transfer-order") [logs[4], logs[5]] = [logs[5], logs[4]];
      if (kind === "removed") logs[0].removed = true;
    };
    await assert.rejects(f.run(), error => { assert.match(error.code, /^RANK1_(SETTLEMENT|TOKEN_FLOW|OWNER_FLOW|LOG)_/); return true; });
    assert.equal(f.state.active, 0); assert.equal(f.state.traceCalls, 0);
  });

for (const kind of ["recipient", "lender", "seizure", "swap-input", "swap-output", "flash-principal", "inventory", "extra-mutation", "proxy-external-call", "proxy-calldata", "proxy-output", "root-calldata", "root-from", "reverted-child"])
  test(`CURRENT rejects ${kind} trace contradiction`, async () => {
    const f = fixture(); f.state.traceHook = (trace, row) => {
      const root = trace.tree, flash = root.calls[1], callback = flash.calls[1], c = callback.calls, router = c[8], pool = router.calls[0];
      const rewrite = (node, iface, method, args) => { node.input = iface.encodeFunctionData(method, args).toLowerCase(); };
      if (kind === "recipient") rewrite(root.calls[3], TOKEN, "transfer", [addr(88), 7000n * U]);
      if (kind === "lender") flash.to = addr(88);
      if (kind === "seizure") c[6].output = TOKEN.encodeFunctionResult("balanceOf", [352000n * W + 1n]);
      if (kind === "swap-input") rewrite(router, SWAP, "exactInputSingle", [[T.usde, T.usdc, 100, T.executor, 352000n * W - 1n, row.plan.minSwapOut, 0]]);
      if (kind === "swap-output") pool.output = SWAP.encodeFunctionResult("swap", [352000n * W, -352000n * U - 1n]);
      if (kind === "flash-principal") rewrite(flash.calls[2], TOKEN, "transferFrom", [T.executor, LENDER, row.plan.flashLoanAmount - 1n]);
      if (kind === "inventory") { root.calls[0].output = TOKEN.encodeFunctionResult("balanceOf", [1]); root.calls[0].calls[0].output = root.calls[0].output; }
      if (kind === "extra-mutation") c[3].calls[0].calls.push(clone(c[2]));
      if (kind === "proxy-external-call") root.calls[0].calls[0].type = "CALL";
      if (kind === "proxy-calldata") root.calls[0].calls[0].input = "0x";
      if (kind === "proxy-output") root.calls[0].calls[0].output = "0x";
      if (kind === "root-calldata") root.input = "0x";
      if (kind === "root-from") root.from = addr(88);
      if (kind === "reverted-child") c[3].reverted = true;
    };
    await assert.rejects(f.run(), error => { assert.match(error.code, /^RANK1_(TRACE|TOKEN|SWAP|INVENTORY|SETTLEMENT)_/); return true; });
    assert.equal(f.state.active, 0);
  });

for (const mode of ["CURRENT", "NEXT_BLOCK_PASSIVE"]) for (const field of ["C", "D"])
  test(`${mode} rejects changed ${field} between discovery and final settlement`, async () => {
    const f = fixture(mode); f.state.amountHook = (_, final) => final ? { [field]: (field === "C" ? 352000n * W : 345000n * U) + 1n } : {};
    await assert.rejects(f.run(), safe("RANK1_DISCOVERY_FINAL_MISMATCH")); assert.equal(f.state.active, 0);
  });

for (const field of ["parentHash", "timestamp", "number"]) test(`FUTURE rejects wrong quote ${field} context`, async () => {
  const f = fixture("NEXT_BLOCK_PASSIVE"); f.state.resultHook = (result, row) => {
    if (row.method === "quoteExactInputSingle") result.context[field] = field === "parentHash" ? hash(999) : result.context[field] + 1;
  };
  await assert.rejects(f.run(), safe("NEXT_BLOCK_SIMULATION_PROOF_INVALID"));
});
for (const field of ["maxFeePerGas", "maxPriorityFeePerGas", "gas", "nonce", "type", "chainId", "from", "to", "value", "input", "accessList"])
  test(`FUTURE final proof rejects changed envelope ${field}`, async () => {
    const f = fixture("NEXT_BLOCK_PASSIVE"); f.state.resultHook = (result, row) => {
      if (!row.final) return; const wire = clone(result.context.transaction);
      wire[field] = field === "from" || field === "to" ? addr(99) : field === "input" ? "0x" : field === "accessList" ? [{ address: addr(99), storageKeys: [] }] : field === "chainId" ? "0x2" : "0x1";
      result.context.transaction = wire;
    };
    await assert.rejects(f.run(), safe("NEXT_BLOCK_SIMULATION_PROOF_INVALID"));
  });

for (const mode of ["CURRENT", "NEXT_BLOCK_PASSIVE"]) test(`${mode}: economics is final calldata floor, never inflated simulated profit`, async () => {
  const f = fixture(mode); f.state.quoteHook = () => 348100n * U;
  const result = await f.run(), plan = EXEC.decodeFunctionData("execute", result.transaction.data)[0];
  assert.equal(plan.minSwapOut, 348000n * U); assert.equal(plan.minProfit, 3000n * U);
  assert.equal(result.proof.economics.contractEnforcedProfitUsdcRaw, String(plan.minProfit));
  const excessive = rank1.valueRank1Profit({ profitUsdcRaw: 7000n * U, fees: result.transaction, feeds: f.args.proofInputs.feeds });
  assert.ok(result.conservativeProfitBeforeGasWei < BigInt(excessive.conservativeProfitBeforeGasWei));
});
test("50bps minimum rounds upward, and quote floor rejects sub-absolute routes", async () => {
  const f = fixture("NEXT_BLOCK_PASSIVE"); f.state.quoteHook = () => 352000n * U - 1n;
  const r = await f.run(); assert.equal(BigInt(r.proof.plan.minSwapOut), ((352000n * U - 1n) * 9950n + 9999n) / 10000n);
  const low = fixture("NEXT_BLOCK_PASSIVE"); low.state.quoteHook = () => 347999n * U;
  await assert.rejects(low.run(), safe("RANK1_QUOTE_BELOW_FLOOR"));
});
test("source minimum remains 100 USDC when quote-implied profit is lower", async () => {
  const f = fixture("NEXT_BLOCK_PASSIVE"); f.state.amountHook = () => ({ D: 348000n * U - 10n }); f.state.quoteHook = () => 348100n * U;
  const result = await f.run(); assert.equal(result.proof.plan.minProfit, String(100n * U));
});

for (const mode of ["CURRENT", "NEXT_BLOCK_PASSIVE"]) test(`${mode} selects deterministic greatest conservative net, not completion order`, async () => {
  const f = fixture(mode); f.state.amountHook = plan => ({ C: (352000n + BigInt(variant(plan))) * W, O: (352000n + BigInt(variant(plan))) * U });
  f.state.hook = async row => { if (row.index === 0) await turn(); };
  const result = await f.run(); assert.equal(result.proof.selectedVariant, 1); assert.equal(f.state.peak, 2);
  assert.deepEqual(result.proof.variants.map(row => row.status), ["VERIFIED", "VERIFIED", "SKIPPED"]);
  assert.equal(f.state.reads.some(row => row.index === 2), false, "a more profitable but optional third route is deliberately not searched");
});
for (const mode of ["CURRENT", "NEXT_BLOCK_PASSIVE"]) test(`${mode} ordinary reverted variant does not suppress verified siblings`, async () => {
  const f = fixture(mode); f.state.hook = async row => { if (row.index === 0) throw new guard.ExecutionError(mode === "CURRENT" ? "CALL_REVERTED" : "NEXT_BLOCK_REVERTED"); };
  const result = await f.run(); assert.equal(result.proof.selectedVariant, 1); assert.equal(result.proof.variants[0].status, "REVERTED");
});
test("all ordinary reverts produce no verified variant", async () => {
  const f = fixture("NEXT_BLOCK_PASSIVE"); f.state.hook = async row => { if (row.plan) throw new guard.ExecutionError("NEXT_BLOCK_REVERTED"); };
  await assert.rejects(f.run(), safe("RANK1_NO_VERIFIED_VARIANT"));
});

for (const fatalCode of ["PROVIDER_RESULT_DISAGREEMENT", "M1_V2_UNSIGNED_BUDGET_EXCEEDED", "PIN_EVIDENCE_INVALIDATED"])
  test(`width-two fatal ${fatalCode} stops scheduling and drains outstanding work`, async () => {
    const f = fixture("NEXT_BLOCK_PASSIVE"), started = deferred(), release = deferred(); let done = false;
    f.state.hook = async row => {
      if (row.index === 0) { started.resolve(); await release.promise; }
      if (row.index === 1) { await started.promise; throw new guard.ExecutionError(fatalCode); }
    };
    const run = f.run().finally(() => { done = true; }); const rejected = assert.rejects(run, safe(fatalCode));
    await started.promise; await turn(); assert.equal(done, false); assert.equal(f.state.active, 1);
    assert.equal(f.state.reads.some(row => row.index === 2), false); release.resolve(); await rejected;
    assert.equal(f.state.active, 0); assert.equal(f.state.peak, 2);
  });
test("a previously completed winner cannot survive a later fatal sibling", async () => {
  const f = fixture("NEXT_BLOCK_PASSIVE"), firstFinal = deferred(), release = deferred(); let done = false;
  f.state.hook = async row => {
    if (row.index === 0 && row.final) firstFinal.resolve();
    if (row.index === 1) { await release.promise; throw new guard.ExecutionError("PROVIDER_RESULT_DISAGREEMENT"); }
  };
  const rejected = assert.rejects(f.run().finally(() => { done = true; }), safe("PROVIDER_RESULT_DISAGREEMENT"));
  await firstFinal.promise; await turn(); assert.equal(done, false); assert.equal(f.state.active, 1);
  assert.equal(f.state.reads.some(row => row.index === 2), false); release.resolve(); await rejected;
  assert.equal(f.state.active, 0);
});
test("the caller's original six-second budget is never reset or accepted", async () => {
  const f = fixture("NEXT_BLOCK_PASSIVE"); const detected = f.args.budget.snapshot().detectionWallMs;
  f.state.hook = async row => { if (row.final) { f.state.wall += 6001; f.state.mono += 6001; } };
  await assert.rejects(f.run(), safe("M1_V2_UNSIGNED_BUDGET_EXCEEDED"));
  assert.equal(f.args.budget.snapshot().detectionWallMs, detected); assert.equal(f.args.budget.snapshot().unsignedReadyWallMs, null);
});
test("synchronous undefined-returning authorization reload is mandatory", async () => {
  const f = fixture(); f.state.authHook = () => true;
  await assert.rejects(f.run(), safe("RANK1_AUTHORIZATION_INVALID")); assert.equal(f.state.qualifications, 0);
});
test("rejected async authorization is contained, not accepted or left unhandled", async () => {
  const f = fixture(); f.state.authHook = () => Promise.reject(new Error("UNTRUSTED_DETAIL"));
  await assert.rejects(f.run(), safe("RANK1_AUTHORIZATION_INVALID")); await turn();
});
test("authorization hook revocation stops before IO", async () => {
  const f = fixture(); f.state.authHook = () => { f.state.usable = false; };
  await assert.rejects(f.run(), safe("PIN_EVIDENCE_INVALIDATED")); assert.equal(f.state.reads.length, 0);
});
test("caps changed during proof cannot select any winner", async () => {
  const f = fixture(); f.state.hook = async row => { if (row.final) f.args.authorization.caps.feeCap--; };
  await assert.rejects(f.run(), safe("RANK1_CONTEXT_CHANGED"));
});
for (const key of ["runtime", "feeds"]) test(`${key} must use the execution pin`, async () => {
  const f = fixture(); f.args.proofInputs[key] = clone(f.args.proofInputs[key]); f.args.proofInputs[key].pin.hash = hash(999);
  await assert.rejects(f.run(), safe("RANK1_PROOF_CONTEXT_INVALID"));
});
test("feeds must use the child timestamp in FUTURE", async () => {
  const f = fixture("NEXT_BLOCK_PASSIVE"); f.args.proofInputs.feeds.contextTimestamp = String(AT);
  await assert.rejects(f.run(), safe("RANK1_PROOF_CONTEXT_INVALID"));
});
test("CURRENT exact final call profit must reconcile with trace", async () => {
  const f = fixture(); f.state.resultHook = (_, row) => { if (row.final) row.returnData = EXEC.encodeFunctionResult("execute", [1]); };
  await assert.rejects(f.run(), safe("RANK1_FINAL_CALL_MISMATCH"));
});
test("CURRENT final gas estimate cannot exceed final proven cap", async () => {
  const f = fixture(); const counts = [0, 0, 0];
  f.state.hook = async row => { if (row.kind === "estimate" && ++counts[row.index] === 2) f.state.estimate = 1300001n; };
  await assert.rejects(f.run(), safe("RANK1_FINAL_GAS_INVALID"));
});
test("final canonical recheck revocation cannot return a winner", async () => {
  const f = fixture("NEXT_BLOCK_PASSIVE"); f.args.active.nextBlock.recheck = async () => { f.state.usable = false; };
  await assert.rejects(f.run(), safe("PIN_EVIDENCE_INVALIDATED"));
});
test("unknown thrown details are sanitized", async () => {
  const f = fixture(); f.args.lease.qualifyCurrentTrace = async () => { throw new Error("UNTRUSTED_DETAIL"); };
  await assert.rejects(f.run(), error => { safe("RANK1_PREPARATION_FAILED")(error); assert.doesNotMatch(error.stack, /UNTRUSTED_DETAIL/); return true; });
});

// Hold both CURRENT operations before releasing either: these tests exercise
// the helper's own width-two drain, not a synthetic qualification rejection.
async function currentTraceDrain({ other = "disagreement", unavailableFirst = true, final = false } = {}) {
  const f = fixture(), entered = deferred(), gates = [deferred(), deferred()];
  const codes = { disagreement: "PROVIDER_RESULT_DISAGREEMENT", revoked: "PIN_EVIDENCE_INVALIDATED",
    contradiction: "RANK1_TRACE_TRANSACTION_INVALID", changedSettlement: "RANK1_DISCOVERY_FINAL_MISMATCH",
    certificate: "M1_CAPABILITY_INVALIDATED", budget: "M1_V2_UNSIGNED_BUDGET_EXCEEDED", authorization: "RANK1_CONTEXT_CHANGED",
    unknown: "RANK1_PREPARATION_FAILED", success: "RANK1_CURRENT_TRACE_UNAVAILABLE" };
  let started = 0, done = false, cancellations = 0;
  f.args.lease.cancelFuture = () => { cancellations++; };
  f.state.hook = async row => {
    if (row.kind !== "trace" || row.final !== final) return;
    assert.ok(row.index < 2, "no third variant may start after the stop");
    if (++started === 2) entered.resolve();
    await gates[row.index].promise;
    if (row.index === 0) throw new guard.ExecutionError("TRACE_RESOURCE_UNAVAILABLE");
    if (other === "disagreement" || other === "certificate") throw new guard.ExecutionError(codes[other]);
    if (other === "revoked") f.state.usable = false;
    if (other === "budget") { f.state.wall += 6001; f.state.mono += 6001; }
    if (other === "authorization") f.args.authorization.caps.feeCap--;
    if (other === "unknown") throw undefined; // Even falsy/unclassified rejections are fatal.
  };
  f.state.traceHook = (trace, row) => {
    if (other === "contradiction" && row.index === 1) trace.tree.from = addr(99);
  };
  if (other === "changedSettlement") f.state.amountHook = (plan, isFinal) => isFinal && variant(plan) === 1 ? { D: 345000n * U + 1n } : {};
  const run = f.run().finally(() => { done = true; }), rejected = assert.rejects(run, safe(codes[other]));
  await entered.promise;
  const first = unavailableFirst ? 0 : 1;
  gates[first].resolve(); await turn();
  assert.equal(done, false, "return must wait for the other started trace");
  assert.equal(f.state.active, 1); assert.equal(f.state.peak, 2);
  const readsAfterStop = f.state.reads.length;
  gates[1 - first].resolve(); await rejected;
  assert.equal(f.state.active, 0); assert.equal(f.state.reads.length, readsAfterStop, "draining must not schedule additional IO");
  assert.equal(f.state.reads.some(row => row.index === 2), false);
  assert.equal(cancellations, 0, "settlement never cancels the caller's FUTURE lane");
}

for (const unavailableFirst of [true, false]) test(`CURRENT drain: ${unavailableFirst ? "unavailable then disagreement" : "disagreement then unavailable"} returns fatal`, async () => {
  await currentTraceDrain({ unavailableFirst });
});
for (const other of ["revoked", "contradiction", "certificate", "budget", "authorization", "unknown"])
  test(`CURRENT drain: later ${other} overrides earlier unavailable`, async () => { await currentTraceDrain({ other }); });
test("CURRENT drain inspects successful final settlement even after unavailable", async () => {
  await currentTraceDrain({ other: "changedSettlement", final: true });
});
test("CURRENT unavailable alone drains the valid sibling and leaves FUTURE uncancelled", async () => {
  await currentTraceDrain({ other: "success" });
});

for (const boundary of ["advanced-parent", "child-clock"]) test(`FUTURE ${boundary} during final simulation await rejects and drains`, async () => {
  const f = fixture("NEXT_BLOCK_PASSIVE"), entered = deferred(), release = deferred(); let started = 0;
  if (boundary === "child-clock") {
    // Begin with 3 seconds of child headroom. Detection/binding happens once,
    // before preparation, so the actual await crosses the child boundary.
    f.state.wall = (AT + 9) * 1000;
    f.args.budget = createM1V2Budget({ wallNow: () => f.state.wall, monotonicNow: () => f.state.mono });
    f.args.budget.bind(f.args.lease);
  }
  f.state.hook = async row => {
    if (!row.final) return;
    assert.equal(row.kind, "simulate"); if (++started === 2) entered.resolve();
    await release.promise;
    if (boundary === "advanced-parent") throw new guard.ExecutionError("NEXT_BLOCK_HEAD_ADVANCED");
  };
  const rejected = assert.rejects(f.run(), safe(boundary === "advanced-parent" ? "NEXT_BLOCK_HEAD_ADVANCED" : "M1_V2_CHILD_HEADROOM_INSUFFICIENT"));
  await entered.promise;
  if (boundary === "child-clock") { f.state.wall += 3000; f.state.mono += 3000; }
  release.resolve(); await rejected;
  assert.equal(f.state.active, 0); assert.equal(f.state.traceCalls, 0);
  assert.equal(f.state.reads.some(row => row.index === 2), false);
  assert.equal(f.args.budget.snapshot().unsignedReadyWallMs, null);
});

for (const location of ["result", "context"]) for (const field of ["stateOverrides", "blockTag"])
  test(`FUTURE rejects ${field} reported in final simulation ${location}`, async () => {
    const f = fixture("NEXT_BLOCK_PASSIVE");
    f.state.resultHook = (result, row) => {
      if (row.final) (location === "result" ? result : result.context)[field] = field === "stateOverrides" ? {} : "pending";
    };
    await assert.rejects(f.run(), safe("NEXT_BLOCK_SIMULATION_PROOF_INVALID"));
    assert.equal(f.state.active, 0); assert.equal(f.state.traceCalls, 0);
  });

function competitiveFixture(mode) {
  const f = fixture(mode, { competitive: true, baseFeePerGas: "35493438" });
  // The authenticated simulated gain is much larger than the enforced floor.
  // Fee bidding must use the latter: exactly 100 USDC, not this simulated gain.
  f.state.amountHook = () => ({ D: 348000n * U - 10n });
  f.state.quoteHook = () => 348100n * U;
  return f;
}

for (const mode of ["CURRENT", "NEXT_BLOCK_PASSIVE"]) test(`${mode} negative diagnostic economics does not block a positive exact final envelope`, async () => {
  const f = competitiveFixture(mode), feeds = f.args.proofInputs.feeds, caps = f.args.authorization.caps;
  feeds.ethUsd.answerRaw = "80000000000000"; f.state.estimate = 1083333n; // Padded CURRENT gas is exactly 1,300,000.
  const diagnostic = guard.buildFeePolicy(1300000n, 35493438n, caps);
  assert.equal(diagnostic.maxFeePerGas, 120986876n);
  assert.equal(diagnostic.gasLimit * diagnostic.maxFeePerGas, 157282938800000n);
  assert.throws(() => rank1.valueRank1Profit({ profitUsdcRaw: 100n * U, feeds, fees: diagnostic }), safe("RANK1_NET_NONPOSITIVE"));
  const result = await f.run(), tx = result.transaction, p = result.proof;
  const plan = EXEC.decodeFunctionData("execute", tx.data)[0];
  assert.equal(plan.minProfit, 100n * U); assert.equal(result.conservativeProfitBeforeGasWei, 110000000000000n);
  assert.equal(tx.gasLimit, 1300000n); assert.equal(tx.maxFeePerGas, 82237810n); assert.equal(tx.maxPriorityFeePerGas, 42307692n);
  assert.equal(tx.gasLimit * tx.maxFeePerGas, 106909153000000n);
  assert.equal(p.economics.nativeGasBudgetWei, "106909153000000"); assert.equal(p.economics.afterGas.netNativeWei, "3090847000000");
  assert.equal(p.economics.positive, true); assert.equal(p.settlementVerified, true);
  assert.deepEqual(p.economics, rank1.valueRank1Profit({ profitUsdcRaw: plan.minProfit, feeds, fees: tx }));
  const finalProof = f.state.reads.filter(row => row.index === p.selectedVariant && row.final && BigInt(row.wire.maxFeePerGas) === tx.maxFeePerGas);
  assert.deepEqual(finalProof.map(row => row.kind), mode === "CURRENT" ? ["trace", "call", "estimate"] : ["simulate"]);
  for (const row of finalProof) assert.deepEqual(row.wire, p.transaction, "all exact final checks bind the cheaper profitable envelope");
  assert.deepEqual(p.transaction, normalizeSimulationTransaction(tx));
  assert.deepEqual(p.variants.map(row => row.status), ["VERIFIED", "VERIFIED", "SKIPPED"]);
  assert.equal(f.state.active, 0); assert.equal(f.state.peak, 2);
});

for (const mode of ["CURRENT", "NEXT_BLOCK_PASSIVE"]) test(`${mode} genuinely nonpositive final economics still rejects before exact final proof`, async () => {
  const f = competitiveFixture(mode), feeds = f.args.proofInputs.feeds;
  feeds.ethUsd.answerRaw = "88000000000000"; f.state.estimate = 1083333n;
  const beforeGas = rank1.valueRank1ProfitBeforeGas({ profitUsdcRaw: 100n * U, feeds });
  assert.equal(beforeGas.conservativeProfitBeforeGasWei, "100000000000000");
  const finalFees = { gasLimit: 1300000n, maxFeePerGas: 78391656n, maxPriorityFeePerGas: 38461538n };
  assert.equal(100000000000000n - finalFees.gasLimit * finalFees.maxFeePerGas, -1909152800000n);
  assert.throws(() => rank1.valueRank1Profit({ profitUsdcRaw: 100n * U, feeds, fees: finalFees }), safe("RANK1_NET_NONPOSITIVE"));
  await assert.rejects(f.run(), safe("PROFIT_NET_NONPOSITIVE"));
  assert.equal(f.state.reads.some(row => row.final && ["trace", "simulate", "call"].includes(row.kind)), false);
  assert.equal(f.state.reads.some(row => row.index === 2), false); assert.equal(f.state.active, 0);
});

for (const mode of ["CURRENT", "NEXT_BLOCK_PASSIVE"]) test(`${mode} binds competitive profit-aware fees before every exact final proof`, async () => {
  const f = competitiveFixture(mode), result = await f.run(), tx = result.transaction, p = result.proof;
  const plan = EXEC.decodeFunctionData("execute", tx.data)[0], gas = mode === "CURRENT" ? 1080000n : 1300000n;
  assert.equal(plan.minProfit, 100n * U); assert.equal(p.economics.contractEnforcedProfitUsdcRaw, String(plan.minProfit));
  assert.equal(result.conservativeProfitBeforeGasWei, 44000000000000000n);
  const expected = guard.buildFeePolicy(gas, 35493438n, result.caps, result.conservativeProfitBeforeGasWei);
  for (const key of ["gasLimit", "maxFeePerGas", "maxPriorityFeePerGas"]) assert.equal(tx[key], expected[key]);
  assert.equal(tx.maxFeePerGas, 1500000000n); assert.equal(tx.maxPriorityFeePerGas, 1460069882n);
  assert.ok(tx.maxPriorityFeePerGas > 50000000n); assert.equal(tx.gasLimit, gas);
  const spend = gas * tx.maxFeePerGas;
  assert.ok(spend <= 1950000000000000n); assert.ok(spend < result.conservativeProfitBeforeGasWei);
  assert.equal(BigInt(p.economics.nativeGasBudgetWei), spend);
  assert.equal(BigInt(p.economics.afterGas.netNativeWei), result.conservativeProfitBeforeGasWei - spend);
  assert.equal(p.economics.maxFeePerGasWei, String(tx.maxFeePerGas));
  assert.deepEqual(p.transaction, normalizeSimulationTransaction(tx));
  const selected = f.state.reads.filter(row => row.index === p.selectedVariant && row.final);
  const finalProof = selected.filter(row => BigInt(row.wire.maxFeePerGas) === tx.maxFeePerGas);
  assert.deepEqual(finalProof.map(row => row.kind), mode === "CURRENT" ? ["trace", "call", "estimate"] : ["simulate"]);
  for (const row of finalProof) assert.deepEqual(row.wire, p.transaction, "final nonce/calldata/gas/fees are immutable across proof");
  if (mode === "CURRENT") {
    assert.equal(selected[0].kind, "estimate"); assert.equal(BigInt(selected[0].wire.maxFeePerGas), 120986876n);
  } else { assert.equal(f.state.qualifications, 0); assert.equal(f.state.traceCalls, 0); }
  for (const row of f.state.reads.filter(row => row.method === "quoteExactInputSingle" || row.plan && !row.final)) {
    assert.equal(BigInt(row.wire.maxFeePerGas), 120986876n); assert.equal(BigInt(row.wire.maxPriorityFeePerGas), 50000000n);
  }
  assert.equal(f.args.budget.snapshot().unsignedReadyWallMs, null);
});

for (const mode of ["CURRENT", "NEXT_BLOCK_PASSIVE"]) test(`${mode} final bid is bounded by before-gas floor, not simulated surplus or after-gas net`, async () => {
  const f = competitiveFixture(mode); f.args.proofInputs.feeds.ethUsd.answerRaw = "5000000000000";
  const result = await f.run(), tx = result.transaction;
  assert.equal(result.conservativeProfitBeforeGasWei, 1760000000000000n);
  assert.ok(tx.maxFeePerGas < 1500000000n, "profit share must limit the bid below the authorized ceiling");
  const expectedTip = guard.TIP_PROFIT_SHARE_BPS * result.conservativeProfitBeforeGasWei / (10000n * tx.gasLimit);
  assert.equal(tx.maxPriorityFeePerGas, expectedTip);
  assert.equal(tx.maxFeePerGas, 39930118n + expectedTip);
  assert.ok(tx.gasLimit * tx.maxFeePerGas < result.conservativeProfitBeforeGasWei);
  assert.equal(BigInt(result.proof.economics.afterGas.netNativeWei), result.conservativeProfitBeforeGasWei - tx.gasLimit * tx.maxFeePerGas);
});

for (const mode of ["CURRENT", "NEXT_BLOCK_PASSIVE"]) test(`${mode} profit-aware fees retain a stricter caller spend cap`, async () => {
  const f = competitiveFixture(mode); f.args.authorization.caps.spendCap = 1000000000000000n;
  const result = await f.run(), tx = result.transaction;
  assert.equal(tx.maxFeePerGas, result.caps.spendCap / tx.gasLimit);
  assert.ok(tx.gasLimit * tx.maxFeePerGas <= result.caps.spendCap);
  assert.ok(BigInt(result.proof.economics.afterGas.netNativeWei) > 0n);
});

for (const [field, value] of [["gasCap", 1300001n], ["feeCap", 1500000001n], ["spendCap", 1950000000000001n]])
  test(`competitive preparation rejects ${field} above the fixed ceiling`, async () => {
    const f = competitiveFixture("NEXT_BLOCK_PASSIVE"); f.args.authorization.caps[field] = value;
    await assert.rejects(f.run(), safe("RANK1_CAP_INVALID")); assert.equal(f.state.reads.length, 0);
  });

for (const field of ["maxFeePerGas", "maxPriorityFeePerGas"]) test(`competitive FUTURE proof rejects changed final ${field}`, async () => {
  const f = competitiveFixture("NEXT_BLOCK_PASSIVE");
  f.state.resultHook = (result, row) => {
    if (!row.final) return;
    const wire = clone(result.context.transaction);
    wire[field] = "0x" + (BigInt(wire[field]) - 1n).toString(16); result.context.transaction = wire;
  };
  await assert.rejects(f.run(), safe("NEXT_BLOCK_SIMULATION_PROOF_INVALID")); assert.equal(f.state.active, 0);
});

test("competitive final fee derivation cannot survive a changed feed floor", async () => {
  const f = competitiveFixture("NEXT_BLOCK_PASSIVE");
  f.state.hook = async row => { if (row.final) f.args.proofInputs.feeds.ethUsd.answerRaw = "100000000000"; };
  await assert.rejects(f.run(), safe("RANK1_CONTEXT_CHANGED"));
});

for (const mode of ["CURRENT", "NEXT_BLOCK_PASSIVE"]) for (const stage of ["discovery", "final"])
  test(`${mode} still tries the third variant when the first two revert at ${stage}`, async () => {
    const f = fixture(mode);
    f.state.hook = async row => {
      if (row.index < 2 && row.plan && (stage === "discovery" || row.final) && ["trace", "simulate"].includes(row.kind))
        throw new guard.ExecutionError(mode === "CURRENT" ? "CALL_REVERTED" : "NEXT_BLOCK_REVERTED");
    };
    const result = await f.run();
    assert.equal(result.proof.selectedVariant, 2);
    assert.deepEqual(result.proof.variants.map(row => row.status), ["REVERTED", "REVERTED", "VERIFIED"]);
    assert.equal(f.state.peak, 2); assert.equal(f.state.active, 0);
    if (stage === "final") assert.equal(f.state.reads.filter(row => row.method === "quoteExactInputSingle").length, 3,
      "discovery and positive quote must not count as verified candidates");
  });

for (const mode of ["CURRENT", "NEXT_BLOCK_PASSIVE"]) test(`${mode} ties remain stable even when variant one finishes first`, async () => {
  const f = fixture(mode); f.state.hook = async row => { if (row.index === 0) await turn(); };
  const result = await f.run(); assert.equal(result.proof.selectedVariant, 0);
  assert.deepEqual(result.proof.variants.map(row => row.status), ["VERIFIED", "VERIFIED", "SKIPPED"]);
  assert.equal(f.state.reads.some(row => row.index === 2), false);
});

test("CURRENT third variant remains eligible until final call and gas both pass", async () => {
  const f = competitiveFixture("CURRENT");
  f.state.hook = async row => { if (row.kind === "call" && row.final && row.index < 2) throw new guard.ExecutionError("CALL_REVERTED"); };
  const result = await f.run(); assert.equal(result.proof.selectedVariant, 2);
  assert.deepEqual(result.proof.variants.map(row => row.status), ["REVERTED", "REVERTED", "VERIFIED"]);
  for (const index of [0, 1]) assert.equal(f.state.reads.filter(row => row.index === index && row.kind === "estimate").length, 2,
    "ordinary final-call reverts still drain the exact final gas check");
});

test("CURRENT reconciles discovery and final trace before starting the final call/gas pair", async () => {
  const f = competitiveFixture("CURRENT"); f.state.amountHook = (_, final) => ({ D: 348000n * U - 10n + (final ? 1n : 0n) });
  await assert.rejects(f.run(), safe("RANK1_DISCOVERY_FINAL_MISMATCH"));
  assert.equal(f.state.reads.some(row => row.final && ["call", "estimate"].includes(row.kind) && BigInt(row.wire.maxFeePerGas) === 1500000000n), false);
});

async function finalPairDrain({ earlyKind = "call", earlyError = null, late = "success" } = {}) {
  const f = competitiveFixture("CURRENT"), entered = deferred(), gates = { call: deferred(), estimate: deferred() };
  let started = 0, done = false;
  const lateKind = earlyKind === "call" ? "estimate" : "call";
  f.state.hook = async row => {
    // Isolate one final pair without withholding the other candidate's IO slot.
    if (row.plan && row.index !== 0) throw new guard.ExecutionError("CALL_REVERTED");
    if (!row.final || !["call", "estimate"].includes(row.kind) || BigInt(row.wire.maxFeePerGas) !== 1500000000n) return;
    if (++started === 2) entered.resolve(); await gates[row.kind].promise;
    if (row.kind === earlyKind && earlyError) throw new guard.ExecutionError(earlyError);
    if (row.kind === lateKind && late === "disagreement") throw new guard.ExecutionError("PROVIDER_RESULT_DISAGREEMENT");
    if (row.kind === lateKind && late === "revoked") f.state.usable = false;
    if (row.kind === lateKind && late === "invalid" && lateKind === "estimate") f.state.estimate = 1300001n;
  };
  f.state.resultHook = (_, row) => {
    if (late === "invalid" && lateKind === "call" && row.final) row.returnData = EXEC.encodeFunctionResult("execute", [1]);
  };
  const code = late === "disagreement" ? "PROVIDER_RESULT_DISAGREEMENT" : late === "revoked" ? "PIN_EVIDENCE_INVALIDATED" :
    late === "invalid" ? lateKind === "estimate" ? "RANK1_FINAL_GAS_INVALID" : "RANK1_FINAL_CALL_MISMATCH" :
      earlyError === "CALL_REVERTED" ? "RANK1_NO_VERIFIED_VARIANT" : earlyError ? "RANK1_CURRENT_TRACE_UNAVAILABLE" : null;
  const run = f.run().finally(() => { done = true; }), checked = code ? assert.rejects(run, safe(code)) : run;
  await entered.promise;
  const pair = f.state.reads.filter(row => row.index === 0 && row.final && ["call", "estimate"].includes(row.kind) && BigInt(row.wire.maxFeePerGas) === 1500000000n);
  assert.deepEqual(pair.map(row => row.kind), ["call", "estimate"]);
  assert.deepEqual(pair[0].wire, pair[1].wire, "parallel final checks must bind the identical complete envelope");
  assert.equal(f.state.active, 2); assert.equal(f.state.peak, 2);
  gates[earlyKind].resolve(); await turn(); assert.equal(done, false, "no winner/failure before both started checks drain");
  assert.equal(f.state.active, 1); const reads = f.state.reads.length;
  gates[lateKind].resolve(); const result = await checked;
  assert.equal(f.state.active, 0); assert.equal(f.state.reads.length, reads);
  if (result) { assert.equal(result.proof.selectedVariant, 0); assert.deepEqual(result.proof.transaction, pair[0].wire); }
}

test("CURRENT final call and gas checks overlap within the shared width-two limit", async () => { await finalPairDrain(); });
for (const earlyKind of ["call", "estimate"]) for (const earlyError of ["CALL_REVERTED", "TRACE_RESOURCE_UNAVAILABLE"])
  for (const late of ["invalid", "disagreement", "revoked"])
    test(`CURRENT final pair: ${earlyKind} ${earlyError} cannot hide late ${late}`, async () => { await finalPairDrain({ earlyKind, earlyError, late }); });
for (const earlyError of ["CALL_REVERTED", "TRACE_RESOURCE_UNAVAILABLE"])
  test(`CURRENT final pair retains ${earlyError} only when the drained sibling is valid`, async () => { await finalPairDrain({ earlyError }); });
