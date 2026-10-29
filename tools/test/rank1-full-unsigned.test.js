"use strict";

// OFFLINE: actual factory, proofs, settlement, runner and wallet guard. Every
// positive integration stops at a throwing signer; no keys or signed bytes.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { Interface, AbiCoder, solidityPacked } = require("../node_modules/ethers");
const runner = require("../lib/rank1-aave-v4-runner.js"), cli = require("../execute-aave-v4-liquidation.js");
const proof = require("../lib/rank1-aave-v4-proof.js"), guard = require("../lib/wallet-execution-guard.js");
const transport = require("../lib/executor-pinned-rpc.js"), simulation = require("../lib/next-block-simulation.js");
const { prepareRank1 } = require("../lib/rank1-aave-v4-settlement.js");
const { v3InputPool } = require("../lib/next-block-execution.js");
const T = proof.TARGET, AT = Date.parse("2026-10-24T21:00:00Z") / 1000, HEAD = 1000;
const STOP = "OFFLINE_UNSIGNED_SIGNER_TRAP", ROOT = path.resolve(__dirname, "../..");
const TEMP = "C:/Users/MiPC/AppData/Local/Temp/opencode";
const hex = n => "0x" + BigInt(n).toString(16), hash = n => "0x" + BigInt(n).toString(16).padStart(64, "0");
const address = n => "0x" + BigInt(n).toString(16).padStart(40, "0");
const freeze = x => { if (x && typeof x === "object") { Object.values(x).forEach(freeze); Object.freeze(x); } return x; };
const turn = () => new Promise(resolve => setImmediate(resolve));
const compiled = JSON.parse(fs.readFileSync(path.join(ROOT, "tools/fork-poc/contracts/FlashLiquidateAaveV4.compiled.json")));
const EXEC = new Interface(compiled.abi), HEALTH = new Interface([EXEC.getFunction("previewHealthFactor")]);
const PROBE = new Interface(["function getBlockNumber() view returns(uint256)"]);
assert.deepEqual(HEALTH.getFunction("previewHealthFactor").outputs.map(output => output.type), ["uint256", "bool", "uint256", "uint256"]);
const TOKEN = new Interface(["function owner() view returns(address)", "function balanceOf(address) view returns(uint256)",
  "function decimals() view returns(uint8)", "function approve(address,uint256) returns(bool)", "function transfer(address,uint256) returns(bool)",
  "function transferFrom(address,address,uint256) returns(bool)", "event Transfer(address indexed from,address indexed to,uint256 value)"]);
const FEED = new Interface(["function decimals() view returns(uint8)", "function description() view returns(string)",
  "function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)"]);
const QUOTE = new Interface(["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns(uint256,uint160,uint32,uint256)"]);
const LENDER = "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb", QUOTER = "0x61ffe014ba17989e743c5f6cb21bf9697530b21e";
const POOL = v3InputPool(T.usde, T.usdc, 100), C = 352000n * 10n ** 18n, D = 345000000000n, O = 352000000000n;
const runtime = Buffer.from(compiled.deployedBytecode.slice(2), "hex");
for (const start of [252, 868, 4524, 4775, 6307]) Buffer.from(T.owner.slice(2).padStart(64, "0"), "hex").copy(runtime, start);
const CODE = "0x" + runtime.toString("hex");
const FLASH = new Interface(["function flashLoan(address,uint256,bytes)", "function onMorphoFlashLoan(uint256,bytes)"]);
const SPOKE = new Interface(["function liquidationCall(uint256,uint256,address,uint256,bool)"]);
const HUB = new Interface(["function remove(uint256,uint256,address) returns(uint256)",
  "function restore(uint256,uint256,(int256 sharesDelta,int256 offsetRayDelta,uint256 restoredPremiumRay)) returns(uint256)"]);
const SWAP = new Interface(["function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns(uint256)",
  "function swap(address,bool,int256,uint160,bytes) returns(int256,int256)", "function uniswapV3SwapCallback(int256,int256,bytes)"]);
const ROUTER = "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45", ABI = AbiCoder.defaultAbiCoder();
const CALLBACK = ABI.encode(["tuple(bytes path,address payer)"], [[solidityPacked(["address", "uint24", "address"], [T.usde, 100, T.usdc]), T.executor]]);

// Same authenticated execution topology as the settlement lane's read-only
// traceFixture, emitted here as RAW callTracer nodes through the real factory.
function rawSettlementTrace(tx) {
  const plan = EXEC.decodeFunctionData("execute", tx.data)[0], F = plan.flashLoanAmount, P = O - D, W = 10n ** 18n;
  const node = (from, to, iface, method, args, result = [], calls = [], type = "CALL") => ({ type, from, to,
    input: iface.encodeFunctionData(method, args).toLowerCase(), output: iface.encodeFunctionResult(method, result).toLowerCase(), value: "0x0", calls });
  const token = (from, target, method, args, result = true, type = "CALL") => {
    const frame = node(from, target, TOKEN, method, args, [result], [], type);
    if (target === T.usdc) frame.calls.push({ ...frame, type: "DELEGATECALL", from: target, to: address(73), calls: [] });
    return frame;
  };
  const balance = (from, target, account, value) => token(from, target, "balanceOf", [account], value, "STATICCALL");
  const remove = node(T.spoke, address(71), HUB, "remove", [3, C, T.executor], [C / 2n], [token(address(71), T.usde, "transfer", [T.executor, C])]);
  const debt = token(T.spoke, T.usdc, "transferFrom", [T.executor, address(71), D]);
  const restore = node(T.spoke, address(71), HUB, "restore", [4, D - 1n, [0, 0, 1]], [D / 2n], [balance(address(71), T.usdc, address(71), D)]);
  const liquidation = node(T.executor, T.spoke, SPOKE, "liquidationCall", [3, 4, T.borrower, plan.debtToCover, false], [], [
    { type: "DELEGATECALL", from: T.spoke, to: address(72), input: "0x12345678", output: "0x", value: "0x0", calls: [remove, debt, restore] },
  ]);
  const swapCallback = node(POOL, ROUTER, SWAP, "uniswapV3SwapCallback", [C, -O, CALLBACK], [], [token(ROUTER, T.usde, "transferFrom", [T.executor, POOL, C])]);
  const pool = node(ROUTER, POOL, SWAP, "swap", [T.executor, true, C, 4295128740n, CALLBACK], [C, -O], [
    token(POOL, T.usdc, "transfer", [T.executor, O]), balance(POOL, T.usde, POOL, W), swapCallback, balance(POOL, T.usde, POOL, W + C),
  ]);
  const router = node(T.executor, ROUTER, SWAP, "exactInputSingle", [[T.usde, T.usdc, 100, T.executor, C, plan.minSwapOut, 0]], [O], [pool]);
  const payload = ABI.encode(["uint256", EXEC.getFunction("execute").inputs[0]], [9, plan]);
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
  assert.equal(tree.input, tx.data); return tree;
}

function syntheticClock(initial = AT * 1000 + 1000) {
  let tick = 0, queued = false;
  const queue = [], state = { offset: 0 };
  function pump() {
    if (queued || !queue.length) return;
    queued = true;
    setImmediate(() => {
      queued = false; queue.sort((a, b) => a.due - b.due); tick = Math.max(tick, queue[0].due);
      state.onAdvance?.();
      while (queue.length && queue[0].due <= tick) queue.shift().resolve();
      pump();
    });
  }
  return { state, wall: () => initial + tick + state.offset, mono: () => tick,
    advance(ms) { assert.ok(ms >= 0); tick += ms; state.onAdvance?.(); },
    wait(ms = 7) { assert.ok(ms > 0); const result = new Promise(resolve => queue.push({ due: tick + ms, resolve })); pump(); return result; } };
}
function directories(t) {
  const root = fs.mkdtempSync(path.join(TEMP, "rank1-unsigned-"));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(TEMP)); assert.match(path.basename(root), /^rank1-unsigned-/);
    function inspect(dir) {
      assert.equal(fs.lstatSync(dir).isSymbolicLink(), false);
      for (const row of fs.readdirSync(dir, { withFileTypes: true })) {
        assert.equal(row.isSymbolicLink(), false);
        const file = path.join(dir, row.name);
        assert.ok(["locks", "journal"].includes(path.relative(root, file).split(path.sep)[0]));
        if (row.isDirectory()) inspect(file); else assert.ok(row.isFile());
      }
    }
    inspect(root); fs.rmSync(root, { recursive: true }); // Only the inspected test-owned tree.
  });
  return { lockRoot: path.join(root, "locks"), journalDir: path.join(root, "journal"), receiptWaitMs: 0 };
}
function logs(plan) {
  const transfer = (token, from, to, value) => ({ address: token, ...TOKEN.encodeEventLog(TOKEN.getEvent("Transfer"), [from, to, value]) });
  return [transfer(T.usdc, LENDER, T.executor, plan.flashLoanAmount), transfer(T.usde, address(71), T.executor, C),
    transfer(T.usdc, T.executor, address(71), D), transfer(T.usdc, POOL, T.executor, O), transfer(T.usde, T.executor, POOL, C),
    transfer(T.usdc, T.executor, LENDER, plan.flashLoanAmount), transfer(T.usdc, T.executor, T.owner, O - D),
    { address: T.executor, ...EXEC.encodeEventLog(EXEC.getEvent("LiquidatedAndUnwound"), [9, T.spoke, T.borrower, T.usdc, T.usde, D, C, O, O - D]) }];
}
function header(number = HEAD) {
  return { number: hex(number), hash: hash(number), parentHash: hash(number - 1), stateRoot: hash(77 + number),
    timestamp: hex(AT + (number - HEAD) * 12), baseFeePerGas: hex(50000000), gasLimit: hex(60000000) };
}

function assertOnlyCapabilityTraces(state) {
  const traces = state.calls.filter(row => row.method === "debug_traceCall");
  assert.equal(traces.filter(row => row.params[0]?.to?.toLowerCase() === T.executor).length, 0, "No CURRENT executor/settlement traces");
  const references = [hash(HEAD), hash(HEAD - 1), simulation.UNKNOWN_HASH];
  for (const row of traces) {
    assert.ok([0, 1].includes(row.alias));
    assert.ok(references.includes(row.params[1]?.blockHash), "Only same/previous/unknown capability-probe hashes");
    assert.deepEqual(row.params, [
      { from: address(0), to: transport.MULTICALL3, value: "0x0", data: PROBE.encodeFunctionData("getBlockNumber") },
      { blockHash: row.params[1].blockHash, requireCanonical: true },
      { tracer: "callTracer", timeout: "3s", tracerConfig: { onlyTopCall: false } },
    ], "Unexpected trace request; capability hints never authorize execution traces or overrides");
  }
  // Verify each independent provider's controls, not an undifferentiated count.
  for (const alias of [0, 1]) assert.deepEqual(traces.filter(row => row.alias === alias).map(row => row.params[1].blockHash), references);
}

async function harness(t, options = {}) {
  const dirs = directories(t), clock = syntheticClock(AT * 1000 + (options.initialAge ?? 1000));
  const state = { calls: [], active: 0, peak: 0, signers: 0, sends: 0, network: 0, prepared: [], outputs: [], leases: [],
    assertions: [], reads: [], revoked: false, parentAdvanced: false, prewarming: true, phase: "PREWARM", detection: null, acquisitions: [], factories: [],
    acquiring: 0, peakAcquiring: 0, factoryCloses: 0, retirements: [] };
  const candidates = freeze([{ family: "alchemy", handle: "OFFLINE_A" }, { family: "quicknode", handle: "OFFLINE_B" }]);
  const forbidden = () => { state.network++; assert.fail("OFFLINE_NETWORK_FORBIDDEN"); };
  t.mock.method(globalThis, "fetch", forbidden);
  let releaseFuture;
  const futureGate = new Promise(resolve => { releaseFuture = resolve; });
  t.after(releaseFuture);
  function response(tx, child = false) {
    const to = tx.to.toLowerCase(), data = tx.input || tx.data;
    if (to === transport.MULTICALL3) return hash(HEAD);
    if (to === T.executor && data.startsWith(HEALTH.getFunction("previewHealthFactor").selector)) {
      assert.deepEqual(Array.from(HEALTH.decodeFunctionData("previewHealthFactor", data), x => x.toLowerCase()), [T.spoke, T.borrower]);
      const liquidatable = options.health?.(child, state) ?? (child ? options.futureLiquidatable !== false : options.currentLiquidatable === true);
      const raw = HEALTH.encodeFunctionResult("previewHealthFactor", [10n ** 18n + (liquidatable ? -1n : 1n), liquidatable, C, D]);
      return options.healthResult ? options.healthResult(raw) : raw;
    }
    if (to === T.executor && data === EXEC.encodeFunctionData("owner")) return EXEC.encodeFunctionResult("owner", [options.wrongOwner ? address(99) : T.owner]);
    if (to === T.executor && data === EXEC.encodeFunctionData("nonce")) return EXEC.encodeFunctionResult("nonce", [8]);
    if (to === T.executor && data.startsWith(EXEC.getFunction("execute").selector)) {
      return EXEC.encodeFunctionResult("execute", [O - D]);
    }
    if ([T.usdc, T.usde].includes(to)) {
      if (data === TOKEN.encodeFunctionData("decimals")) return TOKEN.encodeFunctionResult("decimals", [to === T.usdc ? 6 : 18]);
      assert.equal(data, TOKEN.encodeFunctionData("balanceOf", [T.executor])); return TOKEN.encodeFunctionResult("balanceOf", [0]);
    }
    const feed = [proof.POLICY.ethUsd, proof.POLICY.usdcUsd].find(row => row.address === to);
    if (feed) {
      const method = FEED.parseTransaction({ data }).name;
      if (method === "decimals") return FEED.encodeFunctionResult(method, [8]);
      if (method === "description") return FEED.encodeFunctionResult(method, [feed.description]);
      return FEED.encodeFunctionResult(method, options.feedRound?.(feed, state, child) ||
        [1, to === proof.POLICY.ethUsd.address ? 300000000000n : 100000000n, AT - 10, AT - 10, 1]);
    }
    assert.equal(to, QUOTER);
    const q = QUOTE.decodeFunctionData("quoteExactInputSingle", data)[0];
    assert.equal(q.tokenIn.toLowerCase(), T.usde); assert.equal(q.tokenOut.toLowerCase(), T.usdc); assert.equal(q.amountIn, C); assert.equal(q.fee, 100n);
    return QUOTE.encodeFunctionResult("quoteExactInputSingle", [O, 1, 1, 100000]);
  }
  async function rpc(candidate, method, params, timeout, dispatch) {
    const alias = candidates.findIndex(c => c.handle === candidate.handle);
    assert.ok(alias >= 0); assert.ok(timeout > 0 && timeout <= 4000); assert.equal(typeof dispatch, "function");
    dispatch({ handle: candidate.handle, origin: null, fetch: forbidden });
    const row = { method, params: structuredClone(params), alias, start: clock.mono(), phase: state.phase };
    state.calls.push(row); state.peak = Math.max(state.peak, ++state.active);
    try {
      await clock.wait(alias ? 11 : 7);
      dispatch({ handle: candidate.handle, origin: null, fetch: forbidden });
      await options.rpcHook?.(row, state, clock, () => dispatch({ handle: candidate.handle, origin: null, fetch: forbidden }));
      if (options.holdFuturePublication && method === "eth_simulateV1" && alias === 1 && params[1].blockHash !== simulation.UNKNOWN_HASH &&
        params[0].blockStateCalls[0].calls[0].to === null) await futureGate;
      if (method === "eth_chainId") return options.chainId?.(row, state) || "0x1";
      if (method === "eth_getBlockByNumber") {
        const live = options.autoHeads ? HEAD + Math.floor((clock.wall() / 1000 - AT) / 12) : HEAD + (state.parentAdvanced ? 1 : 0);
        const number = params[0] === "latest" ? live : Number(BigInt(params[0])), h = header(number);
        if (state.parentAdvanced && !options.autoHeads && number === HEAD + 1) h.timestamp = hex(options.advancedTimestamp ?? AT + 1);
        if (state.pinContradiction && number === HEAD) h.stateRoot = hash(99999);
        return h;
      }
      if (method === "debug_traceCall" && options.traceUnavailable) throw new guard.ExecutionError("TRACE_METHOD_UNAVAILABLE");
      if (method === "debug_traceCall" && options.traceUnavailableDuringPreparation && params[0].to === T.executor)
        throw new guard.ExecutionError("TRACE_RESOURCE_UNAVAILABLE");
      if (["eth_call", "eth_getCode", "eth_simulateV1", "debug_traceCall"].includes(method)) {
        assert.deepEqual(Object.keys(params[1]).sort(), ["blockHash", "requireCanonical"]); assert.equal(params[1].requireCanonical, true);
        if (params[1].blockHash === simulation.UNKNOWN_HASH) throw new guard.ExecutionError("UNKNOWN_BLOCK_REJECTED");
      }
      if (method === "eth_getCode") return params[0] === T.executor ? options.runtimeCode?.(CODE, state) || CODE : "0x6001";
      if (method === "eth_call") return params[0].to === transport.MULTICALL3 ? hash(BigInt(params[1].blockHash)) : response(params[0]);
      if (method === "debug_traceCall") {
        if (params[0].to === T.executor) return rawSettlementTrace(params[0]);
        assert.equal(params[0].to, transport.MULTICALL3);
        return { type: "CALL", from: params[0].from, to: params[0].to, input: params[0].data,
          output: hash(BigInt(params[1].blockHash)), value: "0x0", calls: [] };
      }
      if (method === "eth_getTransactionCount") return "0x36";
      if (method === "eth_estimateGas") { assert.equal(params[0].to, T.executor); return hex(900000); }
      if (method === "eth_getBalance") return hex(2000000000000000n);
      if (method === "eth_simulateV1") {
        simulation.validateNextBlockParams(params);
        const block = params[0].blockStateCalls[0], tx = block.calls[0], control = tx.to === null;
        const executing = !control && tx.to === T.executor && tx.input.startsWith(EXEC.getFunction("execute").selector);
        const plan = executing && EXEC.decodeFunctionData("execute", tx.input)[0];
        const result = [{ parentHash: params[1].blockHash, number: block.blockOverrides.number, timestamp: block.blockOverrides.time,
          transactions: [structuredClone(tx)], calls: [{ status: "0x1", gasUsed: hex(executing ? 900000 : 80000),
            returnData: control ? hash(BigInt(block.blockOverrides.number)) + hash(BigInt(block.blockOverrides.time)).slice(2) : response(tx, true),
            logs: executing ? logs(plan) : [] }] }];
        return options.simulationResult ? options.simulationResult(result, row) : result;
      }
      if (method === "eth_getTransactionReceipt") return null;
      if (method === "eth_sendRawTransaction") { state.sends++; assert.fail("OFFLINE_SEND_FORBIDDEN"); }
      assert.fail(`UNMODELED_METHOD_${method}`);
    } catch (error) { if (error.code === "ERR_ASSERTION") state.assertions.push(error); throw error; }
    finally { row.end = clock.mono(); state.active--; }
  }
  const configuration = Object.freeze({});
  let factory;
  t.after(async () => { for (const item of state.factories) await item.close(); });
  const allowed = [runner.APPROVAL_PATH, runner.BASE_PATH, runner.GAS_APPROVAL_PATH, "tools/fork-poc/contracts/FlashLiquidateAaveV4.sol", "tools/fork-poc/contracts/FlashLiquidateAaveV4.compiled.json"];
  function readFile(file) {
    const relative = path.relative(ROOT, file).replaceAll("\\", "/"); assert.ok(allowed.includes(relative), "Only public proof/approval artifacts may be read");
    state.reads.push({ relative, phase: state.phase });
    let raw = fs.readFileSync(file);
    if (relative === runner.APPROVAL_PATH && (state.revoked || options.revokePreSign && guard.readJournals(dirs.journalDir).length)) {
      const value = JSON.parse(raw); value.revoked = true; raw = Buffer.from(JSON.stringify(value));
    }
    if (relative === runner.GAS_APPROVAL_PATH && options.revokeGasPreSign && guard.readJournals(dirs.journalDir).length) {
      const value = JSON.parse(raw); value.revoked = true; raw = Buffer.from(JSON.stringify(value));
    }
    return raw;
  }
  async function prepare(args) {
    state.phase = "PREPARE";
    const prepared = await (options.prepare || prepareRank1)(args);
    state.prepared.push(prepared); state.phase = "VALIDATE";
    await options.afterPrepare?.(prepared, state, clock, args);
    return options.changePrepared ? options.changePrepared(structuredClone(prepared)) : prepared;
  }
  const signer = tx => {
    state.signers++; state.phase = "SIGNER";
    assert.ok(Object.isFrozen(tx)); assert.equal(fs.readdirSync(dirs.lockRoot).length, 1);
    const records = guard.readJournals(dirs.journalDir); assert.equal(records.length, 1);
    assert.equal(records[0].record.stage, "PREPARED"); assert.equal(records[0].record.txHash, null);
    assert.equal(records[0].record.intent.rank1EventId, runner.EVENT_ID);
    assert.equal(records[0].record.intent.targetId, T.id); assert.equal(records[0].record.intent.profitToken, T.usdc);
    assert.equal(BigInt(records[0].record.intent.conservativeProfitBeforeGasWei), state.prepared.at(-1).conservativeProfitBeforeGasWei);
    if (records[0].record.intent.executionMode === "NEXT_BLOCK_PASSIVE") assert.match(records[0].record.intent.nextBlockReplayKey, /^0x[0-9a-f]{64}$/);
    assert.ok(clock.mono() - state.detection > 0 && clock.mono() - state.detection <= 6000);
    assert.ok((state.prepared.at(-1).proof.parent.timestamp + 12) * 1000 - clock.wall() >= 2000);
    throw new guard.ExecutionError(options.signerCode || STOP);
  };
  async function run(flags = []) {
    state.detection = clock.mono();
    const argv = ["--target1-v2", "--no-write", ...(options.check ? ["--check"] : ["--execute-if-liquidatable"]), ...flags];
    const result = await cli.main(argv, { wallNow: () => { options.wallHook?.(state, clock, dirs); return clock.wall(); }, monotonicNow: clock.mono,
      readFile, loadCandidates: () => options.candidates?.(state, candidates) || candidates, rpc, resolveOrigin: () => null,
      getCapabilityContext: () => ({ rpc, fetch: forbidden, configuration: state.changedContext || configuration, inventoryRevision: 1 }),
      headConnect: options.headConnect, createAdvisoryHeadWakeup: options.createAdvisoryHeadWakeup,
      signal: options.signal,
      createFactory: profile => {
        const real = transport.createM1HotPathFactory({ ...profile, allowFuture: profile.allowFuture && options.allowFuture !== false });
        factory = options.decorateFactory ? options.decorateFactory(real, profile, { state, clock, dirs }) : real;
        state.factories.push(factory);
        const instance = factory;
        return { maintain: instance.maintain, close: async () => { state.factoryCloses++; await instance.close(); },
          ...(typeof instance.retireFailedAcquisition === "function" ? { retireFailedAcquisition: async error => {
            const row = { error, instance, start: clock.mono() }; state.retirements.push(row);
            try { return await instance.retireFailedAcquisition(error); } finally { row.end = clock.mono(); }
          } } : {}), acquire: async input => {
          state.detection = clock.mono(); state.phase = "RUN"; state.prewarming = false; state.acquisitions.push(clock.mono());
          state.peakAcquiring = Math.max(state.peakAcquiring, ++state.acquiring);
          try { const lease = await instance.acquire(input); state.leases.push(lease); return lease; }
          finally { state.acquiring--; }
        } };
      }, prepareRank1: prepare, signTransaction: signer, secondaryRpc: forbidden, executionOptions: dirs,
      maxRuns: options.maxRuns ?? 1, sleep: ms => options.sleep ? options.sleep(ms, state, clock) : clock.wait(Math.max(1, Math.ceil(ms))), output: value => {
        state.outputs.push(value);
        options.onOutput?.(value, state, clock);
        if (value.currentHold === "RANK1_CURRENT_TRACE_UNAVAILABLE" || value.ok === false || options.releaseFutureOnStandby && value.mode === "STANDBY") releaseFuture();
      } });
    if (state.assertions.length) throw state.assertions[0];
    assert.equal(state.network, 0); assert.equal(state.sends, 0); assert.equal(state.active, 0);
    if (fs.existsSync(dirs.lockRoot)) assert.deepEqual(fs.readdirSync(dirs.lockRoot), []);
    assert.doesNotMatch(JSON.stringify(state.outputs), /OFFLINE_[AB]|https?:|signedBytes|privateKey|handle|origin/i);
    for (const row of state.outputs) {
      assert.ok(Number.isFinite(Date.parse(row.checkedAt))); assert.equal(row.targetId, "target1_AaveV4_USDe_USDC");
      assert.equal(row.collectionScope, "RANK1_ONLY"); assert.equal(typeof row.scheduled, "boolean"); assert.equal(typeof row.terminal, "boolean");
      assert.equal(row.borrower, T.borrower); assert.equal(row.spoke, T.spoke); assert.equal(row.owner, T.owner); assert.equal(row.deployedExecutor, T.executor);
      assert.equal(row.executionReady, false); assert.equal(row.armed, false);
      if (row.terminal) assert.equal(row.scheduled, false);
      if (options.check) assert.equal(row.scheduled, false);
    }
    assert.equal(state.outputs.at(-1).terminal, true); assert.equal(state.outputs.at(-1).scheduled, false);
    return result;
  }
  return { state, dirs, clock, get factory() { return factory; }, candidates, run, readFile, prepare, signer, rpc };
}

// Narrow runner-only seam, never used by the real FUTURE integration tests.
async function preparedSeam({ active, observation, proofInputs, authorization }) {
  const plan = { spoke: T.spoke, collateralReserveId: 3, debtReserveId: 4, borrower: T.borrower, debtAsset: T.usdc,
    collateralAsset: T.usde, flashLoanAmount: 360000000000n, debtToCover: (1n << 256n) - 1n, minSwapOut: 350240000000n,
    minProfit: 5240000000n, deadline: AT + 120, venueType: 0, swapTarget: address(0), uniV3Fee: 100,
    curveIndexIn: 0, curveIndexOut: 0, customSwapData: "0x" };
  const transaction = freeze({ type: 2, chainId: 1, from: T.owner, to: T.executor, data: EXEC.encodeFunctionData("execute", [plan]),
    nonce: 54, value: 0n, accessList: [], ...guard.buildFeePolicy(1300000n, active.pin.baseFeePerGas, authorization.caps) });
  const economics = proof.valueRank1Profit({ profitUsdcRaw: plan.minProfit, fees: transaction, feeds: proofInputs.feeds });
  return freeze({ transaction, caps: authorization.caps, conservativeProfitBeforeGasWei: BigInt(economics.conservativeProfitBeforeGasWei),
    proof: { schema: "rank1-settlement-proof/v1", targetId: T.id, mode: observation.mode, parent: active.pin,
      context: active.nextBlock?.context || null, transaction: simulation.normalizeSimulationTransaction(transaction), economics, settlementVerified: true } });
}

// Real advisory parser/subscription/generation path, synthetic socket and timers.
// Header payloads are intentionally unrelated to the raw-RPC canonical head.
function offlineHeads(clock) {
  const { EventEmitter } = require("node:events"), socket = new EventEmitter(), timers = new Set();
  const state = { wakes: 0, subscribed: false, nonce: 5000 };
  socket.readyState = 1;
  socket.send = (raw, done) => {
    const req = JSON.parse(raw); done?.();
    setImmediate(() => {
      if (req.method === "eth_subscribe") state.subscribed = true;
      socket.emit("message", JSON.stringify({ jsonrpc: "2.0", id: req.id, result: req.method === "eth_chainId" ? "0x1" : "0xabc" }));
    });
  };
  socket.terminate = () => { socket.readyState = 3; socket.emit("close"); };
  const fire = item => { if (timers.delete(item)) item.fn(); };
  clock.state.onAdvance = () => { for (const item of [...timers]) if (clock.mono() >= item.at) fire(item); };
  return { state, head() {
    assert.equal(state.subscribed, true);
    socket.emit("message", JSON.stringify({ jsonrpc: "2.0", method: "eth_subscription", params: { subscription: "0xabc",
      result: { number: hex(++state.nonce), timestamp: hex(AT), hash: hash(state.nonce), parentHash: hash(state.nonce - 1) } } }));
  }, headConnect: async () => socket,
  createAdvisoryHeadWakeup: options => require("../lib/advisory-head-wakeup.js").createAdvisoryHeadWakeup({ ...options,
    onWake: () => { state.wakes++; options.onWake(); }, _test: {
      setTimeout: (fn, ms) => { const item = { fn, at: clock.mono() + ms }; timers.add(item); if (ms === 0) item.immediate = setImmediate(() => fire(item)); return item; },
      clearTimeout: item => { timers.delete(item); if (item) clearImmediate(item.immediate); }, random: () => 0.5,
    } }),
  };
}

if (require.main === module) {
  test("COLD actual CLI/factory check warms outside detection, acquires fresh pin, observes without signing", async t => {
    const f = await harness(t, { check: true }); assert.equal(f.state.calls.length, 0);
    const out = await f.run(); assert.equal(out.mode, "CHECK_ONLY"); assert.equal(out.exitCode, 0);
    assert.ok(out.budget.detectionMonoMs > 0); assert.equal(out.budget.detectionMonoMs, f.state.acquisitions[0]);
    assert.ok(f.state.calls.some(row => row.end <= out.budget.detectionMonoMs));
    assert.equal(out.scheduled, false); assert.equal(out.terminal, true); assert.equal(out.executionReady, false);
    assert.equal(f.state.signers, 0); assert.equal(f.state.factories.length, 1);
  });
  test("REAL positive CURRENT: trace discovery, exact quote, final trace/call/gas, actual guard, one throwing signer", async t => {
    const f = await harness(t, { currentLiquidatable: true }); const out = await f.run(["--loop"]);
    assert.equal(out.reason, STOP); assert.equal(out.exitCode, 2); assert.equal(f.state.signers, 1);
    const prepared = f.state.prepared[0], p = prepared.proof;
    assert.equal(prepared.transaction.maxFeePerGas, 1500000000n);
    assert.ok(prepared.transaction.gasLimit * prepared.transaction.maxFeePerGas <= 1950000000000000n);
    assert.equal(p.mode, "CURRENT"); assert.equal(p.settlementVerified, true); assert.equal(p.variants.length, 3);
    assert.deepEqual(p.variants.map(v => v.status), ["VERIFIED", "VERIFIED", "SKIPPED"]); assert.equal(p.economics.contextTimestamp, String(AT));
    const exact = row => row.params[0]?.to === T.executor && (row.params[0].data || row.params[0].input)?.startsWith(EXEC.getFunction("execute").selector);
    assert.equal(f.state.calls.filter(row => row.method === "debug_traceCall" && exact(row)).length, 8);
    assert.equal(f.state.calls.filter(row => row.method === "eth_estimateGas" && exact(row)).length, 8);
    assert.equal(f.state.calls.filter(row => row.method === "eth_call" && exact(row)).length, 4);
    assert.equal(f.state.calls.filter(row => row.method === "eth_call" && row.params[0].to === QUOTER).length, 4);
    assert.deepEqual(p.transaction, simulation.normalizeSimulationTransaction(prepared.transaction));
    assert.ok(out.budget.fullUnsignedElapsedMs > 0 && out.budget.fullUnsignedElapsedMs <= 6000);
    assert.equal(out.scheduled, false); assert.equal(out.terminal, true); assert.equal(out.executionReady, false);
  });
  test("factory -> runner -> REAL FUTURE preparation -> actual guard -> throwing signer exactly once", async t => {
    let validations = 0;
    const actual = guard.executeGuarded;
    t.mock.method(guard, "executeGuarded", args => actual({ ...args, validate: async (...values) => {
      const result = await args.validate(...values); validations++; return result;
    } }));
    const f = await harness(t); const out = await f.run(["--loop"]);
    assert.equal(out.reason, STOP); assert.equal(f.state.signers, 1); assert.equal(f.state.prepared.length, 1);
    assertOnlyCapabilityTraces(f.state); assert.equal(validations, 2); assert.equal(f.state.sends, 0);
    const p = f.state.prepared[0]; assert.equal(p.proof.settlementVerified, true); assert.equal(p.proof.variants.length, 3);
    assert.equal(p.proof.mode, "NEXT_BLOCK_PASSIVE");
    assert.equal(p.transaction.maxFeePerGas, 1500000000n); assert.equal(p.transaction.gasLimit * p.transaction.maxFeePerGas, 1950000000000000n);
    assert.deepEqual(p.proof.variants.map(row => row.status), ["VERIFIED", "VERIFIED", "SKIPPED"]);
    assert.deepEqual(p.proof.transaction, simulation.normalizeSimulationTransaction(p.transaction));
    assert.equal(p.proof.economics.contextTimestamp, String(AT + 12));
    assert.equal(p.proof.economics.contractEnforcedProfitUsdcRaw, EXEC.decodeFunctionData("execute", p.transaction.data)[0].minProfit.toString());
    assert.ok(f.state.calls.every(row => row.end > row.start));
    assert.equal(f.state.leases.length, 1); assert.ok(out.budget.fullUnsignedElapsedMs > 0);
  });
  test("liquidatable CURRENT trace unavailable holds CURRENT without poisoning real FUTURE", async t => {
    const f = await harness(t, { currentLiquidatable: true, traceUnavailable: true });
    const out = await f.run(["--loop"]); assert.equal(out.reason, STOP); assert.equal(f.state.signers, 1);
    assert.ok(f.state.calls.some(row => row.method === "debug_traceCall"));
    assert.equal(f.state.prepared[0].proof.mode, "NEXT_BLOCK_PASSIVE"); assert.equal(f.state.leases.length, 1);
  });
  test("preparation-stage CURRENT trace unavailable retains original lease/budget for delayed FUTURE", async t => {
    const attempts = [];
    const f = await harness(t, { currentLiquidatable: true, holdFuturePublication: true, traceUnavailableDuringPreparation: true,
      prepare: async args => {
        attempts.push({ mode: args.observation.mode, lease: args.lease, budget: args.budget });
        return prepareRank1(args);
      } });
    const out = await f.run(["--loop"]);
    assert.equal(out.reason, STOP); assert.equal(f.state.signers, 1); assert.equal(f.state.leases.length, 1);
    assert.deepEqual(attempts.map(row => row.mode), ["CURRENT", "NEXT_BLOCK_PASSIVE"]);
    assert.equal(attempts[0].lease, attempts[1].lease); assert.equal(attempts[0].budget, attempts[1].budget);
    assert.ok(f.state.outputs.some(row => row.mode === "HOLD" && row.currentHold === "RANK1_CURRENT_TRACE_UNAVAILABLE"));
    assert.equal(guard.readJournals(f.dirs.journalDir).length, 1);
  });
  test("CURRENT preparation unavailable then same-lease FUTURE pre-lock contention recovers on a fresh head", async t => {
    const preparations = [], modes = []; let lock, ownerBytes, released = false, currentBudget;
    const f = await harness(t, { holdFuturePublication: true, traceUnavailableDuringPreparation: true, autoHeads: true, maxRuns: 2,
      health: (_, state) => state.leases.length === 1,
      prepare: args => { preparations.push(args.observation.mode); currentBudget = args.budget; return prepareRank1(args); },
      onOutput: (value, state) => {
        if (value.currentHold === "RANK1_CURRENT_TRACE_UNAVAILABLE" && !lock) {
          assert.deepEqual(preparations, ["CURRENT"]); assert.equal(guard.readJournals(f.dirs.journalDir).length, 0);
          lock = guard.acquireWalletLock({ lockRoot: f.dirs.lockRoot }); ownerBytes = fs.readFileSync(path.join(lock.directory, "owner.json"));
        }
        if (value.reason === "WALLET_LOCK_HELD" && !released) {
          assert.equal(value.scheduled, true); assert.equal(value.terminal, false); assert.equal(state.active, 0);
          assert.equal(state.signers, 0); assert.equal(guard.readJournals(f.dirs.journalDir).length, 0);
          assert.equal(state.leases.length, 1); assert.equal(value.budget.detectionMonoMs, currentBudget.snapshot().detectionMonoMs);
          assert.deepEqual(fs.readFileSync(path.join(lock.directory, "owner.json")), ownerBytes);
          lock.release(); released = true;
        }
      },
    });
    t.after(() => { if (lock && !released && fs.existsSync(lock.directory)) lock.release(); });
    const actual = guard.executeGuarded;
    t.mock.method(guard, "executeGuarded", args => {
      modes.push(args.intent.executionMode);
      if (args.intent.executionMode === "NEXT_BLOCK_PASSIVE") {
        assert.equal(f.state.leases.length, 1); assert.deepEqual(fs.readFileSync(path.join(lock.directory, "owner.json")), ownerBytes);
      }
      return actual(args);
    });
    const out = await f.run(["--loop"]);
    assert.deepEqual(modes, ["CURRENT", "NEXT_BLOCK_PASSIVE"]); assert.deepEqual(preparations, ["CURRENT"]);
    assert.equal(released, true); assert.equal(out.mode, "STANDBY"); assert.equal(out.exitCode, 0); assert.equal(out.pin.number, HEAD + 1);
    assert.equal(f.state.leases.length, 2); assert.equal(f.state.signers, 0); assert.equal(guard.readJournals(f.dirs.journalDir).length, 0);
    assert.ok(out.budget.detectionMonoMs > currentBudget.snapshot().detectionMonoMs);
  });
  test("fatal canonical contradiction stops loop scheduling and drains physical reads", async t => {
    const f = await harness(t, { maxRuns: 3, afterPrepare: (_, state) => { state.pinContradiction = true; } });
    const out = await f.run(["--loop"]); assert.equal(out.mode, "HOLD"); assert.equal(f.state.signers, 0);
    assert.equal(f.state.leases.length, 1); assert.equal(f.state.active, 0);
  });
  test("late healthy check waits for a genuinely new head within its absolute check deadline", async t => {
    const f = await harness(t, { check: true, initialAge: 11000, autoHeads: true, maxRuns: 4 });
    const out = await f.run(); assert.equal(out.mode, "CHECK_ONLY"); assert.equal(out.pin.number, HEAD + 1);
    assert.equal(out.exitCode, 0); assert.equal(f.state.signers, 0); assert.equal(f.state.leases.length, 2);
    assert.ok(f.state.outputs.some(row => row.reason === "M1_V2_CHILD_HEADROOM_INSUFFICIENT"));
    assert.ok(f.state.outputs.every(row => !row.scheduled && !row.executionReady && typeof row.checkedAt === "string"));
    assert.ok(out.budget.detectionMonoMs > f.state.acquisitions[0]);
  });
  test("healthy cold check with no new head is bounded, typed HOLD, never perpetual standby", async t => {
    const f = await harness(t, { check: true, initialAge: 11000, maxRuns: Infinity });
    const out = await f.run(); assert.equal(out.reason, "RANK1_CHECK_DEADLINE"); assert.equal(out.exitCode, 1);
    assert.ok(f.clock.mono() >= 20000 && f.clock.mono() < 21000); assert.equal(out.terminal, true); assert.equal(out.scheduled, false);
  });
  for (const fault of ["budget", "headroom", "advance"]) test(`unsigned ${fault} HOLD retires/drains lease and resumes fresh-head standby`, async t => {
    let injected = false;
    const f = await harness(t, { maxRuns: 2, autoHeads: fault !== "advance",
      health: (child, state) => state.leases.length === 1 ? child : false,
      afterPrepare: (_, state, clock) => {
        if (injected) return; injected = true;
        if (fault === "budget") clock.advance(6001);
        else if (fault === "headroom") clock.advance((AT + 12) * 1000 - clock.wall() - 1999);
        else state.parentAdvanced = true;
      },
    });
    const out = await f.run(["--loop"]);
    assert.equal(f.state.signers, 0); assert.equal(f.state.active, 0); assert.equal(out.exitCode, 0, out.reason);
    assert.equal(out.mode, "STANDBY"); assert.equal(out.pin.number, HEAD + 1);
    assert.equal(f.state.leases.length, 2); assert.notEqual(f.state.leases[0], f.state.leases[1]);
    assert.ok(f.state.outputs.some(row => row.mode === "HOLD" && row.scheduled && !row.terminal));
    assert.equal(out.terminal, true); assert.equal(out.scheduled, false); assert.equal(out.executionReady, false);
    assert.equal(guard.readJournals(f.dirs.journalDir).length, 0);
  });
  for (const completion of ["valid", "valid-post-await-guard", "contradictory"]) test(`57ms acquired lease cancellation: late OPTIONAL ${completion} response`, async t => {
    let releaseHints, releaseOptional, markIssued, released = false, cancelledAt, acquiredHeadroom, firstHold, trustAtHold;
    const hintGate = new Promise(resolve => { releaseHints = resolve; }), optionalGate = new Promise(resolve => { releaseOptional = resolve; });
    const issued = new Promise(resolve => { markIssued = resolve; }), hintRows = [], optionalRows = [], boundaryErrors = [];
    const releaseAll = () => { released = true; releaseHints(); releaseOptional(); };
    // Cleanup never depends on output: actual cancel/close, test abort, and finally
    // all release the gates. No real-time sleep or unbounded polling is involved.
    t.signal.addEventListener("abort", releaseAll, { once: true }); t.after(releaseAll);
    const f = await harness(t, { initialAge: 11000, autoHeads: true, maxRuns: 2, health: () => false,
      rpcHook: async (row, state, clock, assertDispatch) => {
        if (released || state.acquisitions.length > 1) return;
        // Stall only the background trace hints; they cannot reach their FUTURE
        // probes yet. Thus the gated known-hash simulations belong to the lease.
        if (row.method === "debug_traceCall") { hintRows.push(row); await hintGate; return; }
        if (state.acquisitions.length === 1 && row.method === "eth_simulateV1" &&
          row.params[1].blockHash !== simulation.UNKNOWN_HASH && row.params[0].blockStateCalls[0].calls[0].to === null) {
          optionalRows.push(row); if (optionalRows.length === 2) markIssued();
          await optionalGate;
          if (completion === "valid-post-await-guard") {
            try { assertDispatch(); } catch (error) { boundaryErrors.push({ code: error.code, stack: error.stack }); throw error; }
          }
        }
      },
      simulationResult: (result, row) => completion === "contradictory" && optionalRows.includes(row) ?
        [{ ...result[0], number: hex(BigInt(result[0].number) + 1n) }] : result,
      decorateFactory: (real, profile, { clock }) => {
        assert.equal(profile.qualificationMode, "capability-v1"); assert.equal(profile.rank1AcquisitionRecovery, true);
        assert.equal(profile.selectionPolicy, "rank1-prefer-dual"); assert.equal(profile.allowFuture, true);
        return { ...real, close: async () => { releaseAll(); await real.close(); }, acquire: async input => {
          const lease = await real.acquire(input);
          if (released) return lease;
          await issued;
          clock.advance((lease.current.pin.timestamp + 12) * 1000 - clock.wall() - 57);
          acquiredHeadroom = (lease.current.pin.timestamp + 12) * 1000 - clock.wall();
          lease.current.assertUsable();
          return Object.freeze({ ...lease, cancelFuture: () => {
            lease.cancelFuture();
            if (cancelledAt === undefined) { cancelledAt = clock.mono(); queueMicrotask(releaseAll); }
          } });
        } };
      },
      onOutput: (row, state) => {
        if (firstHold || row.mode !== "HOLD") return;
        firstHold = row;
        try { state.leases[0].current.assertUsable(); trustAtHold = "USABLE"; }
        catch (error) { trustAtHold = error.code; }
      },
    });
    let out;
    try { out = await f.run(["--loop"]); } finally { releaseAll(); }
    assert.equal(acquiredHeadroom, 57); assert.equal(firstHold.budget.childHeadroomMs, 57);
    assert.equal(new Set(hintRows.map(row => row.alias)).size, 2);
    assert.equal(optionalRows.length, 2); assert.deepEqual(optionalRows.map(row => row.alias).sort(), [0, 1]);
    assert.ok(optionalRows.every(row => row.start < cancelledAt && row.end >= cancelledAt));
    assert.ok(f.state.outputs.every(row => !/CLOCK/.test(row.reason || "")));
    assert.equal(f.state.active, 0); assert.equal(f.state.signers, 0); assert.equal(f.state.sends, 0); assert.equal(f.state.prepared.length, 0);
    assert.equal(fs.existsSync(f.dirs.lockRoot), false); assert.equal(guard.readJournals(f.dirs.journalDir).length, 0);
    if (completion === "valid-post-await-guard") {
      assert.equal(boundaryErrors.length, 2);
      t.diagnostic(JSON.stringify({ firstHold: firstHold.reason, trustAtHold, boundaryErrors }));
    }
    if (completion === "contradictory") {
      assert.equal(out.exitCode, 2); assert.equal(f.state.leases.length, 1); assert.notEqual(trustAtHold, "USABLE");
      assert.ok(f.state.outputs.every(row => !row.scheduled));
    } else {
      assert.equal(firstHold.reason, "M1_V2_CHILD_HEADROOM_INSUFFICIENT"); assert.equal(trustAtHold, "USABLE");
      assert.equal(firstHold.scheduled, true); assert.equal(firstHold.terminal, false);
      assert.equal(out.exitCode, 0); assert.equal(out.mode, "STANDBY"); assert.equal(out.pin.number, HEAD + 1);
      assert.equal(f.state.leases.length, 2); assert.equal(f.state.factories.length, 1);
      assert.equal(out.budget.detectionMonoMs, f.state.acquisitions[1]);
      assert.ok(out.budget.detectionMonoMs > firstHold.budget.detectionMonoMs);
    }
  });
  for (const code of ["M1_V2_UNSIGNED_BUDGET_EXCEEDED", "M1_V2_CHILD_HEADROOM_INSUFFICIENT", "NEXT_BLOCK_HEAD_ADVANCED"])
    test(`signer throwing transient-shaped ${code} is terminal, never a retry`, async t => {
      const f = await harness(t, { currentLiquidatable: true, signerCode: code, maxRuns: 3 });
      const out = await f.run(["--loop"]); assert.equal(out.reason, code); assert.equal(out.exitCode, 2);
      assert.equal(f.state.signers, 1); assert.equal(f.state.leases.length, 1); assert.equal(out.scheduled, false); assert.equal(out.terminal, true);
      assert.equal(guard.readJournals(f.dirs.journalDir)[0].record.stage, "PREPARED");
    });
  for (const mode of ["CURRENT", "NEXT_BLOCK_PASSIVE"]) test(`actual ${mode} second-validation timeout preserves bound unsigned abort and resumes fresh-head standby`, async t => {
    let persisted, abortedBytes;
    const f = await harness(t, { maxRuns: 2, autoHeads: true,
      health: (child, state) => state.leases.length === 1 && child === (mode === "NEXT_BLOCK_PASSIVE"),
      wallHook: (_, clock, dirs) => {
        if (persisted) return;
        const rows = guard.readJournals(dirs.journalDir);
        if (rows.length) { [persisted] = rows; assert.equal(persisted.record.stage, "PREPARED"); clock.advance(6001); }
      },
      onOutput: (value, state) => {
        if (value.reason !== "M1_V2_UNSIGNED_BUDGET_EXCEEDED") return;
        assert.equal(state.active, 0); assert.equal(value.scheduled, true);
        const [row] = guard.readJournals(f.dirs.journalDir);
        assert.equal(row.file, persisted.file); assert.equal(row.record.stage, "ABORTED_UNSIGNED");
        assert.equal(row.record.signerInvoked, false); assert.equal(row.record.abortPhase, "PRE_SIGN_VALIDATION");
        assert.equal(row.record.reason, value.reason); assert.deepEqual(row.record.intent, persisted.record.intent);
        assert.match(row.record.intent.rank1AttemptId, /^[0-9a-f-]{36}$/); abortedBytes = fs.readFileSync(row.file);
      },
    });
    const out = await f.run(["--loop"]);
    assert.ok(persisted); assert.ok(abortedBytes); assert.equal(out.mode, "STANDBY"); assert.equal(out.exitCode, 0);
    assert.equal(out.pin.number, HEAD + 1); assert.equal(f.state.signers, 0); assert.equal(f.state.prepared.length, 1);
    assert.equal(f.state.leases.length, 2); assert.ok(f.state.acquisitions[1] > f.state.acquisitions[0] + 6000);
    assert.deepEqual(fs.readFileSync(persisted.file), abortedBytes); assert.equal(guard.readJournals(f.dirs.journalDir).length, 1);
  });
  for (const next of ["standby", "candidate"]) test(`actual shared lock contention releases only by its owner, then fresh-head ${next}`, async t => {
    let lock, released = false, before;
    const f = await harness(t, { maxRuns: 2, autoHeads: true,
      health: (child, state) => !child && (state.leases.length === 1 || next === "candidate"),
      onOutput: (value, state) => {
        if (released || value.reason !== "WALLET_LOCK_HELD") return;
        assert.equal(value.scheduled, true); assert.equal(value.terminal, false); assert.equal(state.active, 0);
        assert.equal(state.prepared.length, 0); assert.equal(state.signers, 0); assert.equal(guard.readJournals(f.dirs.journalDir).length, 0);
        assert.deepEqual(fs.readFileSync(path.join(lock.directory, "owner.json")), before);
        lock.release(); released = true;
      },
    });
    lock = guard.acquireWalletLock({ lockRoot: f.dirs.lockRoot }); before = fs.readFileSync(path.join(lock.directory, "owner.json"));
    t.after(() => { if (!released && fs.existsSync(lock.directory)) lock.release(); });
    const out = await f.run(["--loop"]); assert.equal(released, true); assert.equal(f.state.leases.length, 2);
    assert.equal(f.state.leases[1].current.pin.number, HEAD + 1);
    assert.equal(f.state.prepared.length, next === "candidate" ? 1 : 0); assert.equal(f.state.signers, next === "candidate" ? 1 : 0);
    assert.equal(out.mode, next === "candidate" ? "HOLD" : "STANDBY"); assert.equal(out.exitCode, next === "candidate" ? 2 : 0);
    if (next === "candidate") {
      assert.equal(out.reason, STOP); assert.equal(guard.readJournals(f.dirs.journalDir).length, 1);
      await assert.rejects(guard.executeGuarded({ ...f.dirs, intent: { to: T.executor }, receiptRpc: () => null,
        prepare: () => assert.fail("DUPLICATE_ATTEMPT"), signTransaction: () => assert.fail("DUPLICATE_SIGNER") }),
      { code: "PREPARED_INTENT_REQUIRES_MANUAL_RECONCILIATION" });
    }
  });
  test("final signer-boundary clock hook fails before the actual signer and never retries its prepared journal", async t => {
    let boundary = false, fired = false;
    const actual = guard.executeGuarded;
    t.mock.method(guard, "executeGuarded", args => actual({ ...args, signTransaction: tx => { boundary = true; return args.signTransaction(tx); } }));
    const f = await harness(t, { currentLiquidatable: true, maxRuns: 3, wallHook: (_, clock) => {
      if (boundary && !fired) { fired = true; clock.advance((AT + 12) * 1000 - clock.wall() - 1999); }
    } });
    const out = await f.run(["--loop"]); assert.equal(fired, true); assert.equal(f.state.signers, 0);
    assert.equal(out.exitCode, 2); assert.equal(f.state.leases.length, 1); assert.equal(out.terminal, true);
    assert.equal(guard.readJournals(f.dirs.journalDir)[0].record.stage, "PREPARED");
  });
  test("unsigned delayed FUTURE continuation budget expiry resumes only a new-head standby pass", async t => {
    let expired = false;
    const f = await harness(t, { maxRuns: 2, autoHeads: true, holdFuturePublication: true, releaseFutureOnStandby: true,
      health: (child, state) => state.leases.length === 1 && child,
      afterPrepare: (_, state, clock) => { if (!expired) { expired = true; clock.advance(6001); } } });
    const out = await f.run(["--loop"]); assert.equal(expired, true); assert.equal(out.mode, "STANDBY");
    assert.equal(out.exitCode, 0); assert.equal(f.state.signers, 0); assert.equal(f.state.leases.length, 2);
    assert.ok(f.state.outputs.some(row => row.reason === "M1_V2_UNSIGNED_BUDGET_EXCEEDED" && row.scheduled));
    assert.equal(guard.readJournals(f.dirs.journalDir).length, 0);
  });
  for (const stage of ["PREPARED", "SENT", "UNCERTAIN"]) test(`existing ${stage} journal prevents a healthy late-head retry`, async t => {
    const f = await harness(t, { initialAge: 11000, maxRuns: 3, autoHeads: true });
    guard.atomicJson(path.join(f.dirs.journalDir, "pending.json"), { schema: "wallet-execution-journal/v1", stage, chainId: 1, owner: T.owner,
      executedAt: new Date(AT * 1000).toISOString(), txHash: stage === "PREPARED" ? null : hash(777), intent: { to: T.executor } });
    const out = await f.run(["--loop"]); assert.equal(out.exitCode, 2); assert.equal(f.state.leases.length, 1);
    assert.equal(f.state.signers, 0); assert.ok(f.state.outputs.every(row => !row.scheduled));
    assert.equal(guard.readJournals(f.dirs.journalDir)[0].record.stage, stage);
  });
  test("authorization revocation accompanying an unsigned timeout is fatal, never transient", async t => {
    const f = await harness(t, { maxRuns: 3, afterPrepare: (_, state, clock) => { state.revoked = true; clock.advance(6001); } });
    const out = await f.run(["--loop"]); assert.equal(out.reason, "RANK1_AUTHORIZATION_INVALID_OR_EXPIRED");
    assert.equal(out.exitCode, 2); assert.equal(f.state.leases.length, 1); assert.equal(f.state.signers, 0);
  });
  test("cold qualification unavailable has a finite typed check HOLD and never calls hot acquire", async t => {
    const f = await harness(t, { check: true, maxRuns: Infinity, rpcHook: row => {
      if (row.method === "eth_getCode") throw new guard.ExecutionError("RPC_FAILED");
    } });
    const out = await f.run(); assert.equal(out.mode, "HOLD"); assert.equal(out.exitCode, 1);
    assert.equal(out.reason, "RANK1_CHECK_DEADLINE"); assert.equal(f.state.acquisitions.length, 0); assert.equal(f.state.signers, 0);
    assert.ok(f.clock.mono() >= 20000 && f.clock.mono() < 24000);
  });
  test("actual WS generation wakes OUTER idle before its deadline; expiry retains the real certificate pool", async t => {
    let holdAt, hinted = false, oldPin, probeCount;
    const options = { maxRuns: 2, allowFuture: false, prepare: preparedSeam,
      health: (_, state) => state.leases.length === 1,
      afterPrepare: (_, state, clock) => clock.advance(6001),
      onOutput: (row, state, clock) => {
        if (row.reason !== "M1_V2_UNSIGNED_BUDGET_EXCEEDED") return;
        holdAt = clock.mono(); oldPin = state.leases[0].current.pin; assert.equal(state.factoryCloses, 0);
        probeCount = state.calls.filter(row => row.method === "eth_getCode" && row.params[1].blockHash === simulation.UNKNOWN_HASH).length;
      },
      sleep: async (ms, state, clock) => {
        await clock.wait(Math.max(1, Math.ceil(ms)));
        if (holdAt !== undefined && !hinted) { hinted = true; state.parentAdvanced = true; heads.head(); }
      },
    };
    const f = await harness(t, options), heads = offlineHeads(f.clock); Object.assign(options, heads);
    const out = await f.run(["--loop", "--target1-ws-heads"]);
    assert.equal(out.mode, "STANDBY"); assert.ok(heads.state.wakes > 0); assert.equal(f.state.leases.length, 2);
    assert.ok(f.state.acquisitions[1] - holdAt < 1000); assert.ok(f.state.acquisitions[1] + (AT * 1000 + 1000) < (oldPin.timestamp + 12) * 1000);
    assert.equal(out.pin.number, HEAD + 1); assert.notEqual(out.pin.number, heads.state.nonce);
    assert.equal(f.state.peakAcquiring, 1); assert.equal(f.state.factories.length, 1); assert.equal(f.state.factoryCloses, 1);
    assert.equal(f.state.leases[0].current.evidence.capability.revision, f.state.leases[1].current.evidence.capability.revision);
    assert.equal(f.state.calls.filter(row => row.method === "eth_getCode" && row.params[1].blockHash === simulation.UNKNOWN_HASH).length, probeCount);
  });
  test("latched advisory storms coalesce; same-head retries start at most once/second and never run observations", async t => {
    let started = false, sameHeadHolds = 0, readsAtHold;
    const healthReads = state => state.calls.filter(row => row.method === "eth_call" && row.params[0].data.startsWith(HEALTH.getFunction("previewHealthFactor").selector)).length;
    const options = { maxRuns: 4, allowFuture: false, prepare: preparedSeam, health: (_, state) => state.leases.length === 1,
      afterPrepare: (_, state, clock) => clock.advance(6001),
      onOutput: (row, state) => {
        if (row.reason === "M1_V2_UNSIGNED_BUDGET_EXCEEDED") { started = true; readsAtHold = healthReads(state); for (let i = 0; i < 8; i++) heads.head(); }
        if (row.reason === "RANK1_WAITING_FRESH_HEAD") {
          assert.equal(healthReads(state), readsAtHold); assert.equal(row.scheduled, true);
          if (++sameHeadHolds === 2) state.parentAdvanced = true;
        }
      },
      sleep: async (ms, state, clock) => { await clock.wait(Math.max(1, Math.ceil(ms))); if (started) for (let i = 0; i < 4; i++) heads.head(); },
    };
    const f = await harness(t, options), heads = offlineHeads(f.clock); Object.assign(options, heads);
    const out = await f.run(["--loop", "--target1-ws-heads"]); assert.equal(out.mode, "STANDBY"); assert.equal(out.pin.number, HEAD + 1);
    assert.equal(sameHeadHolds, 2); assert.equal(f.state.acquisitions.length, 4); assert.equal(f.state.peakAcquiring, 1);
    for (let i = 1; i < f.state.acquisitions.length; i++) assert.ok(f.state.acquisitions[i] - f.state.acquisitions[i - 1] >= 1000);
    assert.equal(f.state.factories.length, 1); assert.equal(f.state.signers, 0);
  });
  for (const fault of ["certificate-expiry", "inventory-change"]) test(`retained pool ${fault} gives hot selection HOLD, never foreground rescue`, async t => {
    let retired = false;
    const f = await harness(t, { maxRuns: 2, autoHeads: true, allowFuture: false, currentLiquidatable: true, prepare: preparedSeam,
      afterPrepare: (_, state, clock) => clock.advance(6001),
      candidates: (state, candidates) => retired && fault === "inventory-change" ? [...candidates].reverse() : candidates,
      onOutput: (row, state, clock) => {
        if (row.reason !== "M1_V2_UNSIGNED_BUDGET_EXCEEDED") return;
        retired = true; if (fault === "certificate-expiry") clock.advance(60001);
      } });
    const out = await f.run(["--loop"]); assert.equal(out.reason, "M1_HOT_PATH_SELECTION_HOLD"); assert.equal(out.exitCode, 0);
    assert.equal(f.state.factories.length, 1); assert.equal(f.state.acquisitions.length, 2); assert.equal(f.state.leases.length, 1); assert.equal(f.state.signers, 0);
  });
  test("retained certificate context revocation accompanying unsigned expiry is terminal", async t => {
    const f = await harness(t, { currentLiquidatable: true, maxRuns: 3, afterPrepare: (_, state, clock) => { state.changedContext = {}; clock.advance(6001); } });
    const out = await f.run(["--loop"]); assert.equal(out.exitCode, 2); assert.equal(f.state.leases.length, 1); assert.equal(f.state.signers, 0);
    assert.ok(f.state.outputs.every(row => !row.scheduled));
  });
  for (const future of [false, true]) test(`actual ${future ? "FUTURE" : "CURRENT"} age-only stale feed holds unsigned then fresh-head feeds recover`, async t => {
    let held = false;
    const f = await harness(t, { maxRuns: 2, autoHeads: true, health: child => child === future,
      feedRound: (feed, state) => feed === proof.POLICY.usdcUsd && state.leases.length === 1 ? [1, 100000000n, AT - 82801, AT - 82801, 1] : null,
      onOutput: (row, state) => {
        if (row.reason !== "RANK1_FEED_STALE") return;
        held = true; assert.equal(row.scheduled, true); assert.equal(row.terminal, false);
        assert.equal(state.signers, 0); assert.equal(state.active, 0); assert.equal(state.factoryCloses, 0);
        assert.equal(guard.readJournals(f.dirs.journalDir).length, 0);
      } });
    const out = await f.run(["--loop"]); assert.equal(held, true); assert.equal(out.reason, STOP);
    assert.equal(f.state.signers, 1); assert.equal(f.state.leases.length, 2); assert.equal(f.state.leases[1].current.pin.number, HEAD + 1);
    assert.equal(f.state.factories.length, 1); assert.equal(f.state.factoryCloses, 1);
    assert.equal(f.state.leases[0].current.evidence.capability.revision, f.state.leases[1].current.evidence.capability.revision);
    assert.equal(proof.POLICY.usdcUsd.maxAgeSeconds, 82800);
    const feedReads = f.state.calls.filter(row => row.method === "eth_call" && row.params[0].to === proof.POLICY.usdcUsd.address &&
      row.params[0].data === FEED.encodeFunctionData("latestRoundData"));
    assert.ok(feedReads.some(row => row.params[1].blockHash === hash(HEAD)) && feedReads.some(row => row.params[1].blockHash === hash(HEAD + 1)));
  });
  for (const fault of ["future-timestamp", "invalid-price", "late-runtime", "late-other-feed"]) test(`actual helper ${fault} remains fatal, including hard failures later than staleness`, async t => {
    const f = await harness(t, { maxRuns: 3, currentLiquidatable: true,
      feedRound: feed => {
        if (fault === "late-runtime" && feed === proof.POLICY.usdcUsd) return [1, 100000000n, AT - 82801, AT - 82801, 1];
        if (fault === "late-other-feed" && feed === proof.POLICY.ethUsd) return [1, 300000000000n, AT - 3601, AT - 3601, 1];
        if (feed === proof.POLICY.usdcUsd && ["invalid-price", "late-other-feed"].includes(fault)) return [1, 0, AT - 10, AT - 10, 1];
        if (feed === proof.POLICY.usdcUsd && fault === "future-timestamp") return [1, 100000000n, AT + 1, AT + 1, 1];
        return null;
      },
      rpcHook: async (row, _, clock) => {
        if (fault === "late-runtime" && row.method === "eth_getCode" && row.params[0] === T.executor ||
          fault === "late-other-feed" && row.method === "eth_call" && row.params[0].to === proof.POLICY.usdcUsd.address &&
          row.params[0].data === FEED.encodeFunctionData("latestRoundData")) await clock.wait(200);
      },
      runtimeCode: code => fault === "late-runtime" ? "0x00" + code.slice(4) : code,
    });
    const out = await f.run(["--loop"]); assert.equal(out.exitCode, 2, out.reason);
    assert.equal(out.reason, fault === "future-timestamp" ? "RANK1_FEED_FUTURE_TIMESTAMP" : fault === "late-runtime" ? "RANK1_RUNTIME_MISMATCH" : "RANK1_FEED_PRICE_INVALID");
    assert.equal(f.state.signers, 0); assert.equal(f.state.leases.length, 1); assert.equal(f.state.active, 0);
    assert.equal(guard.readJournals(f.dirs.journalDir).length, 0); assert.ok(f.state.outputs.every(row => !row.scheduled));
    const rounds = address => f.state.calls.filter(row => row.method === "eth_call" && row.params[0].to === address && row.params[0].data === FEED.encodeFunctionData("latestRoundData"));
    if (fault === "late-other-feed") assert.ok(Math.min(...rounds(proof.POLICY.usdcUsd.address).map(row => row.end)) >
      Math.max(...rounds(proof.POLICY.ethUsd.address).map(row => row.end)));
    if (fault === "late-runtime") assert.ok(Math.min(...f.state.calls.filter(row => row.method === "eth_getCode" && row.params[0] === T.executor).map(row => row.end)) >
      Math.max(...rounds(proof.POLICY.usdcUsd.address).map(row => row.end)));
  });
  for (const from of ["raw-call", "settlement", "signer"]) test(`stale-code lookalike from ${from} cannot acquire trusted feed provenance`, async t => {
    const stale = () => { throw new guard.ExecutionError("RANK1_FEED_STALE"); };
    const f = await harness(t, { currentLiquidatable: true, maxRuns: 3,
      ...(from === "settlement" ? { prepare: stale } : from === "signer" ? { signerCode: "RANK1_FEED_STALE" } : {
        rpcHook: row => { if (row.method === "eth_call" && row.params[0].to === proof.POLICY.usdcUsd.address) stale(); },
      }) });
    const out = await f.run(["--loop"]); assert.equal(out.exitCode, 2); assert.equal(f.state.leases.length, 1);
    assert.equal(f.state.signers, from === "signer" ? 1 : 0); assert.ok(f.state.outputs.every(row => !row.scheduled));
    assert.equal(guard.readJournals(f.dirs.journalDir).length, from === "signer" ? 1 : 0);
  });
  for (const code of ["RPC_TIMEOUT", "RPC_TRANSPORT_ERROR", "RPC_HTTP_RETRYABLE"])
    test(`REAL issued ${code} acquisition retires/drains before new factory, certificate and healthy proof`, async t => {
      let held = false, qualifiedBefore;
      const f = await harness(t, { maxRuns: 2, allowFuture: false, health: () => false,
        rpcHook: async (row, state, clock) => {
          if (state.acquiring !== 1 || state.acquisitions.length !== 1) return;
          if (row.method === "eth_getBlockByNumber" && row.params[0] === "latest" && row.alias === 0) throw new guard.ExecutionError(code);
          if (row.alias === 1) await clock.wait(60);
        },
        onOutput: (row, state) => {
          if (row.reason !== "RANK1_RPC_RECOVERY_HOLD") return;
          held = true; assert.equal(row.scheduled, true); assert.equal(row.terminal, false); assert.equal(state.active, 0);
          assert.equal(state.signers, 0); assert.equal(state.sends, 0); assert.equal(guard.readJournals(f.dirs.journalDir).length, 0);
          assert.equal(state.retirements.length, 1); assert.ok(state.retirements[0].end >= state.retirements[0].start);
          assert.throws(() => state.factories[0].maintain({ candidates: f.candidates }), { code: "M1_HOT_PATH_CLOSED" });
          qualifiedBefore = state.calls.filter(call => call.method === "eth_getCode" && call.params[1].blockHash === simulation.UNKNOWN_HASH).length;
        } });
      const out = await f.run(["--loop"]); assert.equal(held, true, out.reason); assert.equal(out.mode, "STANDBY");
      assert.equal(out.exitCode, 0); assert.equal(f.state.factories.length, 2); assert.equal(f.state.leases.length, 1);
      assert.equal(f.state.acquisitions.length, 2); assert.equal(f.state.peakAcquiring, 1);
      const retired = f.state.retirements[0];
      assert.ok(f.state.leases[0].current.evidence.capability.startedAtMonoMs >= retired.end + 1000);
      assert.ok(f.state.acquisitions[1] > retired.end); assert.equal(out.budget.detectionMonoMs, f.state.acquisitions[1]);
      assert.ok(f.state.calls.filter(call => call.method === "eth_getCode" && call.params[1].blockHash === simulation.UNKNOWN_HASH).length > qualifiedBefore);
      assert.equal(f.state.signers, 0); assert.equal(f.state.sends, 0); assert.equal(guard.readJournals(f.dirs.journalDir).length, 0);
    });
  for (const code of ["RPC_FAILED", "PINNED_RPC_FAILED"]) test(`REAL issued generic ${code} is not recovery authority`, async t => {
    const f = await harness(t, { maxRuns: 3, allowFuture: false,
      rpcHook: (row, state) => {
        if (state.acquiring && row.method === "eth_getBlockByNumber" && row.params[0] === "latest" && row.alias === 0) throw new guard.ExecutionError(code);
      } });
    const out = await f.run(["--loop"]); assert.equal(out.exitCode, 2); assert.equal(f.state.factories.length, 1);
    assert.equal(f.state.leases.length, 0); assert.ok(f.state.outputs.every(row => !row.scheduled));
    assert.equal(f.state.signers, 0); assert.equal(guard.readJournals(f.dirs.journalDir).length, 0);
  });
  test("REAL late wrong-chain response outranks earlier acquisition timeout and cannot recover", async t => {
    const f = await harness(t, { maxRuns: 3, allowFuture: false,
      rpcHook: async (row, state, clock) => {
        if (!state.acquiring) return;
        if (row.method === "eth_chainId" && row.alias === 0) throw new guard.ExecutionError("RPC_TIMEOUT");
        if (row.method === "eth_chainId" && row.alias === 1) await clock.wait(200);
      },
      chainId: (row, state) => state.acquiring && row.alias === 1 ? "0x2" : "0x1",
    });
    const out = await f.run(["--loop"]); assert.equal(out.exitCode, 2); assert.equal(f.state.factories.length, 1);
    assert.equal(f.state.active, 0); assert.equal(f.state.leases.length, 0); assert.equal(f.state.signers, 0);
    assert.ok(f.state.outputs.every(row => !row.scheduled && row.reason !== "RANK1_RPC_RECOVERY_HOLD"));
    const timeout = f.state.calls.find(row => row.phase === "RUN" && row.alias === 0 && row.method === "eth_chainId");
    const contradiction = f.state.calls.find(row => row.phase === "RUN" && row.alias === 1 && row.method === "eth_chainId");
    assert.ok(timeout && contradiction, "Both same-batch chain checks must have been issued");
    assert.ok(contradiction.end > timeout.end);
  });
}

module.exports = { harness, preparedSeam, freeze, AT, HEAD, T, STOP, EXEC, hash, address, directories, syntheticClock, offlineHeads, assertOnlyCapabilityTraces };
