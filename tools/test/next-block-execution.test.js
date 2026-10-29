"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { id, keccak256, zeroPadValue } = require("../node_modules/ethers");
const guard = require("../lib/wallet-execution-guard.js"), policy = require("../lib/next-block-execution.js");
const { createNextBlockContext, normalizeSimulationTransaction, createNextBlockSimulation } = require("../lib/next-block-simulation.js");
const runner = require("../execute-top-whale-trigger.js"), { FEED_IFACE, MULTICALL_IFACE } = require("../execute-aave-v4-near-liquidation.js");
const { MULTICALL3 } = require("../lib/executor-pinned-rpc.js");
const m1Live = require("../lib/m1-live-evidence.js"), m1Fixtures = require("./m1-live-evidence.test.js");
const { mockSignedTransactionBinding } = require("./signed-transaction-binding-fixture.js");
const ROOT = path.resolve(__dirname, "../.."), NOW = Date.parse("2026-10-23T20:00:03Z"), W = 10n ** 18n;
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", DAI = "0x6b175474e89094c44da98b954eedeac495271d0f";
const USDE = "0x4c9edd5852cd905f086c759e8383e09bff1e68b3", ZERO = "0x" + "00".repeat(20);
const ROUTER = "0xe592427a0aece92de3edee1f18e0157c05861564", QUOTER = "0x61ffe014ba17989e743c5f6cb21bf9697530b21e";
const M1_KEY = "targetM1_Morpho_USDe_DAI", M1_USER = "0xa3609cf7872faa7804281c7c5edb8b2d33001089";
const hash = n => "0x" + BigInt(n).toString(16).padStart(64, "0"), hex = n => "0x" + BigInt(n).toString(16);
const PIN = { chainId: 1, number: 1000, hash: hash(1000), timestamp: NOW / 1000 - 3, baseFeePerGas: "100000000" };
const CONTEXT = createNextBlockContext(PIN);
// Only these three public authorization files can be read by the injected loader.
const AUTH_BYTES = new Map([policy.AMENDMENT_PATH, ...policy.BASES.map(b => b.path)]
  .map(file => [path.join(ROOT, file), fs.readFileSync(path.join(ROOT, file))]));
function readAuthorization(file) { assert.ok(AUTH_BYTES.has(file), "unplanned file access"); return AUTH_BYTES.get(file); }
const AUTH = policy.loadAuthorization({ readFile: readAuthorization, now: NOW });
function replaceAuthorization(edit, file = policy.AMENDMENT_PATH) {
  return name => {
    const bytes = readAuthorization(name);
    if (name !== path.join(ROOT, file)) return bytes;
    const value = JSON.parse(bytes.toString("utf8")); edit(value); return Buffer.from(JSON.stringify(value));
  };
}
function temp(t) {
  const base = process.platform === "win32" ? path.join(os.tmpdir(), "opencode") : os.tmpdir(); fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, "next-block-execution-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, lockRoot: path.join(root, "locks"), journalDir: path.join(root, "journal"), receiptWaitMs: 0 };
}
function forecastRow(user, field, data, projection = {}) {
  return { user, rank: "display-only", liquidatableNow: false, executableNow: false, armed: true,
    inactive: false, positionStatus: "OPEN", debtReadStatus: "COMPLETE", debtRaw: "100",
    nextBlockForecast: { context: CONTEXT, eligibleForSimulation: true, evidence: "FORECAST_ONLY", requiresExactSimulation: true,
      currentHealth: "HEALTHY", currentHealthFactorRaw: (W + 1000n).toString(), plans: { [field]: data }, ...projection } };
}
function monitorForecastRow(row) {
  return { ...row, observationKind: "READ_ONLY_MONITOR", armed: false, executableNow: false, eligibleForPreflight: false,
    observationStatus: "COMPLETE", refreshStatus: "COMPLETE", chainId: PIN.chainId,
    observationBlock: PIN.number, observationHash: PIN.hash, observationTimestamp: PIN.timestamp,
    observationUtc: new Date(PIN.timestamp * 1000).toISOString() };
}
function plan(rank = "#2K") {
  if (rank === "M1") {
    const data = runner.MORPHO_EXEC_IFACE.encodeFunctionData("execute", [
      { loanToken: DAI, collateralToken: USDE, oracle: "0xae4750d0813b5e37a51f7629beedd72af1f9ca35",
        irm: "0x870ac11d48b15db9a138cf899d20f13f79ba00bc", lltv: 860000000000000000n }, M1_USER,
      108500n * W, 0, 25n * W, 107460n * W, ROUTER,
      "0x4c9edd5852cd905f086c759e8383e09bff1e68b3000064a0b86991c6218b36c1d19d4a2e9eb0ce3606eb480000646b175474e89094c44da98b954eedeac495271d0f",
    ]);
    return { key: M1_KEY, token: DAI, executor: runner.MORPHO_EXECUTOR, gain: 1000n * W, quote: 108000n * W,
      row: forecastRow(M1_USER, "readyExecuteMorphoBlueCalldata", data,
        { currentHealthFactorRaw: undefined, currentDebtRaw: (100000n * W).toString(), maxBorrowRaw: (100000n * W + 1n).toString() }) };
  }
  const binding = AUTH.batches[1].targetWhales.find(row => row.rank === rank), spark = rank.startsWith("#S");
  const flash = rank === "#2L" ? 12n * W : rank === "#2M" ? 45n * W / 10n : 5n * W;
  const minimumProfit = rank === "#2L" || spark ? W / 10n : W / 100n;
  const data = runner.UNIFIED_IFACE.encodeFunctionData("executeMorpho", [flash, {
    isAaveV3: true, target: binding.pool, borrower: binding.borrower, debtToken: WETH, collateralToken: binding.collateralToken,
    collateralReserveId: 0, debtReserveId: 0, minCollateralSeized: spark ? 5n * W : 0n, swapKind: spark ? 1 : 0,
    swapTarget: spark ? ROUTER : ZERO, swapSpender: spark ? ROUTER : ZERO, uniFee: spark ? 100 : 0,
    curveI: 0, curveJ: 0, minDebtTokenOut: spark ? 6n * W : 0n, minProfitDebtToken: minimumProfit,
  }]);
  return { key: `target${rank.slice(1)}_${spark ? "Spark_wstETH" : "AaveV3_WETH"}_WETH_${binding.borrower.slice(0, 6)}`,
    token: WETH, executor: runner.DEPLOYED_EXECUTOR, gain: spark ? W : minimumProfit * 2n, quote: 61n * W / 10n,
    row: forecastRow(binding.borrower, "readyExecuteMorphoCalldata", data) };
}
function fixture(t, options = {}) {
  if (options.rank === "M1") return m1Fixtures.fixture(t, { ...options, future: true });
  const dirs = temp(t), p = plan(options.rank), state = { now: NOW, nonces: 0, signs: 0, sends: 0, secondary: 0, checks: 0, tx: null, simulations: [], executorCalls: 0 };
  const journalExists = () => fs.existsSync(dirs.journalDir) && fs.readdirSync(dirs.journalDir).some(n => n.endsWith(".json"));
  const next = { context: CONTEXT, recheck: async () => {
    state.checks++;
    const stage = state.sends ? "secondary" : state.signs ? "preSend" : journalExists() ? "preSign" : "prepare";
    if (stage === options.failStage) {
      if (options.reason === "NEXT_BLOCK_DEADLINE") state.now = CONTEXT.timestamp * 1000;
      throw new guard.ExecutionError(options.reason || "NEXT_BLOCK_PARENT_CHANGED");
    }
    return CONTEXT;
  }, simulate: async tx => {
    state.simulations.push(tx);
    assert.equal(fs.readdirSync(dirs.lockRoot).length, 1, "all forecast work occurs inside the wallet lock");
    assert.equal(state.nonces, 1); assert.equal(tx.nonce, 7); assert.equal(tx.gasLimit, 1500000n);
    const proof = { context: { ...CONTEXT, transaction: normalizeSimulationTransaction(tx) }, gasLimit: hex(tx.gasLimit), gasUsed: hex(900000), returnData: "0x", logs: [] };
    if (tx.to === QUOTER) {
      const input = runner.QUOTER_IFACE.decodeFunctionData("quoteExactInput", tx.data)[1];
      const quote = p.quote * input / (options.rank === "M1" ? 108500n * W : 5n * W);
      proof.returnData = runner.QUOTER_IFACE.encodeFunctionResult("quoteExactInput", [quote, [], [], 100000]);
    } else if (tx.to === MULTICALL3) {
      if (options.noValuation) throw new guard.ExecutionError("NEXT_BLOCK_ORACLE_UNAVAILABLE");
      const calls = MULTICALL_IFACE.decodeFunctionData("aggregate3", tx.data)[0];
      assert.equal(calls.length, 6);
      const rows = calls.map((call, i) => {
        const feed = i < 3 ? policy.FEEDS.eth : policy.FEEDS.dai, method = ["decimals", "description", "latestRoundData"][i % 3];
        assert.equal(call.target.toLowerCase(), feed.address); assert.equal(call.allowFailure, false);
        assert.equal(call.callData, FEED_IFACE.encodeFunctionData(method));
        const updated = CONTEXT.parentTimestamp - (options.staleValuation ? 20000 : 10);
        const price = feed === policy.FEEDS.eth ? 321000000000n : 99700000n;
        return { success: true, returnData: FEED_IFACE.encodeFunctionResult(method,
          method === "decimals" ? [8] : method === "description" ? [feed.description] : [1, price, updated, updated, 1]) };
      });
      if (options.mutateFeeds) options.mutateFeeds(rows);
      proof.returnData = MULTICALL_IFACE.encodeFunctionResult("aggregate3", [rows]);
    } else {
      assert.equal(tx.to, p.executor);
      state.executorCalls++;
      proof.logs = options.noGain ? [] : [{ address: p.token, topics: [id("Transfer(address,address,uint256)"), zeroPadValue(p.executor, 32), zeroPadValue(guard.MAIN_ACCOUNT, 32)],
        data: hash(options.gain ?? p.gain) }];
      if (options.rank === "M1" || options.rank?.startsWith("#S")) {
        const collateral = options.rank === "M1" ? USDE : "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0";
        const recipient = policy.v3InputPool(collateral, options.rank === "M1" ? "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" : WETH, 100);
        proof.logs.unshift({ address: collateral, topics: [id("Transfer(address,address,uint256)"), zeroPadValue(p.executor, 32), zeroPadValue(recipient, 32)],
          data: hash(options.actualInput ?? (options.rank === "M1" ? 108500n * W : 5n * W)) });
        if (options.mutateInput) options.mutateInput(proof.logs, state.executorCalls);
      }
      if (options.mutateProof) options.mutateProof(proof);
      if (options.afterSimulation) options.afterSimulation(state);
    }
    return proof;
  } };
  const pinned = { pin: PIN, evidence: { independentFamilies: true, nextBlockQualified: true, aliases: [1, 2], qualification: [1, 2].map(alias =>
    ({ alias, qualified: true, nextBlockQualified: true, numberTimestampVerified: true, timeControlVerified: true, simulationUnknownHashRejected: true })) },
    nextBlock: next, collectorOptions: {}, assertUsable() {}, recheck: async () => {},
    nonce: async () => { state.nonces++; return "0x7"; },
    call: async () => assert.fail("forecast must not use parent eth_call"), estimateGas: async () => assert.fail("forecast must not use parent estimateGas"),
    send: async raw => { state.sends++; return keccak256(raw); },
    receipt: async txHash => options.pending ? null : ({ transactionHash: txHash, from: guard.MAIN_ACCOUNT, to: p.executor, blockHash: hash(1001),
      blockNumber: "0x3e9", status: options.reverted ? "0x0" : "0x1", gasUsed: hex(900000), effectiveGasPrice: hex(100000000), logs: [] }),
  };
  const signTransaction = mockSignedTransactionBinding(t).wrapSigner(async tx => {
    assert.deepEqual(normalizeSimulationTransaction({ ...tx, from: guard.MAIN_ACCOUNT }),
      normalizeSimulationTransaction(state.simulations.findLast(call => call.to === p.executor)));
    state.signs++; state.tx = tx; return "0x010203"; // Synthetic bytes, never cryptographic signing.
  }, guard.MAIN_ACCOUNT);
  const run = (overrides = {}) => runner.runPass({ execute: true, argv: ["--next-block"], batch: AUTH.batches[0], morphoBatch: AUTH.batches[1],
    pinned, now: () => state.now, executionOptions: dirs, signTransaction,
    amendmentReadFile: options.readFile || readAuthorization,
    checkOnce: async collectOptions => {
      if (!options.noContext) assert.deepEqual(collectOptions.nextBlockContext, CONTEXT);
      return { pin: PIN, targets: { [p.key]: p.row } };
    }, ...overrides });
  return { ...dirs, state, pinned, next, p, run, signTransaction, journalExists };
}

test("exact approved policy and byte-bound bases load; absent, malformed, revoked, contradictory and expired approval fail closed", () => {
  assert.equal(AUTH.amendmentHash, policy.AMENDMENT_SHA256);
  const caps = policy.boundedCaps(AUTH, { gasCap: 2000000n, spendCap: 3000000000000000n, feeCap: null, dailyCap: 10n });
  assert.equal(caps.gasCap, 1500000n); assert.equal(caps.spendCap, 2000000000000000n); assert.equal(caps.dailyCap, 3n); assert.equal(caps.lifetimeCap, 5n);
  for (const readFile of [() => { throw Error("missing"); }, () => Buffer.from("{"),
    replaceAuthorization(a => a.approved = false), replaceAuthorization(a => a.revoked = true),
    replaceAuthorization(a => a.nextBlock.validation = false), replaceAuthorization(a => a.caps.maxSlippageBps = 51),
    replaceAuthorization(a => a.caps.signedExecutionsTotal = 6, policy.BASES[1].path)]) {
    assert.throws(() => policy.loadAuthorization({ readFile, now: NOW }), /NEXT_BLOCK_/);
  }
  assert.throws(() => policy.loadAuthorization({ readFile: readAuthorization, now: Date.parse(AUTH.amendment.expiresAt) }), /EXPIRED/);
});

for (const rank of ["#2K", "#2L", "#2M", "M1", "#S1", "#S2", "#S3", "#S4"]) {
  test(`${rank}: healthy parent/future success signs once with exact tested gas and conditional net evidence`, async t => {
    const f = fixture(t, { rank }), out = await f.run(), record = out.summary.execution;
    assert.equal(out.fired, true, JSON.stringify(out.summary.preflightFailures));
    assert.equal(f.state.signs, 1); assert.equal(f.state.sends, 1); assert.equal(f.state.tx.gasLimit, 1500000n);
    assert.equal(record.intent.simulatedGasUsed, "900000"); assert.equal(record.intent.executionMode, "NEXT_BLOCK_PASSIVE");
    assert.equal(record.intent.amendmentHash, rank === "M1" ? m1Live.AMENDMENT_SHA256 : policy.AMENDMENT_SHA256); assert.deepEqual(record.intent.baseBatchHashes, AUTH.baseHashes);
    assert.deepEqual(record.intent.nextBlockContext, CONTEXT); assert.equal(record.intent.calldataHash, keccak256(f.state.tx.data));
    assert.equal(record.intent.forecastCalldataHash, keccak256(Object.values(f.p.row.nextBlockForecast.plans)[0]));
    const net = record.intent.simulatedEconomics;
    assert.ok(BigInt(net.netTokenRaw) > 0n); assert.equal(BigInt(net.maxGasCostWei), f.state.tx.gasLimit * f.state.tx.maxFeePerGas);
    const profit = BigInt(net.conservativeProfitBeforeGasWei), tx = f.state.tx;
    const expectedFees = guard.buildFeePolicy(tx.gasLimit, PIN.baseFeePerGas,
      { gasCap: 1500000n, spendCap: 2000000000000000n, feeCap: null }, profit);
    assert.equal(tx.maxFeePerGas, expectedFees.maxFeePerGas); assert.equal(tx.maxPriorityFeePerGas, expectedFees.maxPriorityFeePerGas);
    assert.ok(tx.maxPriorityFeePerGas > 50000000n); assert.ok(profit - tx.gasLimit * tx.maxFeePerGas > 0n);
    assert.equal(net.realizedNetProfit, "UNKNOWN"); assert.equal(record.realizedNetProfit, "UNKNOWN");
    if (rank === "M1") {
      assert.equal(net.prices.eth.priceRaw, "321000000000"); assert.equal(net.prices.dai.priceRaw, "99700000");
      const d = runner.MORPHO_EXEC_IFACE.decodeFunctionData("execute", f.state.tx.data);
      assert.equal(d[5], f.p.quote * 9950n / 10000n); assert.equal(d[4], 25n * W);
    }
    if (rank.startsWith("#S")) assert.equal(runner.UNIFIED_IFACE.decodeFunctionData("executeMorpho", f.state.tx.data)[1].minDebtTokenOut,
      f.p.quote * 9950n / 10000n);
    const replay = await f.run(); assert.equal(replay.fired, false); assert.equal(replay.summary.preflightFailures[0].reason,
      rank === "M1" ? "M1_TRIGGER_EVENT_ALREADY_ATTEMPTED" : "NEXT_BLOCK_ALREADY_ATTEMPTED");
    assert.equal(f.state.signs, 1);
  });
}

test("no amendment or unavailable future capability holds only forecast and never reaches nonce/signing", async t => {
  for (const readFile of [() => { throw Error("missing"); }, replaceAuthorization(a => a.revoked = true)]) {
    const f = fixture(t, { readFile, noContext: true }), out = await f.run();
    assert.equal(out.fired, false); assert.equal(out.summary.nextBlock.enabled, false); assert.match(out.summary.nextBlock.hold, /NEXT_BLOCK_/);
    assert.equal(f.state.nonces, 0); assert.equal(f.state.signs, 0);
  }
  const f = fixture(t, { noContext: true }); delete f.pinned.nextBlock;
  const out = await f.run(); assert.equal(out.fired, false); assert.equal(out.summary.nextBlock.enabled, false); assert.equal(f.state.signs, 0);
  const calls = [], strictCurrent = {};
  assert.equal(await runner.connectForPass({ argv: ["--next-block"], candidates: [], rpc: () => {}, create: async options => {
    calls.push([Boolean(options.requireStrictEvidence), Boolean(options.requireNextBlock)]);
    if (options.requireNextBlock) throw Error("not qualified");
    return strictCurrent;
  } }), strictCurrent);
  assert.deepEqual(calls, [[true, true], [true, false]]);
  const nonStrictCalls = [], nonStrictCurrent = {};
  assert.equal(await runner.connectForPass({ argv: ["--next-block"], candidates: [], rpc: () => {}, create: async options => {
    nonStrictCalls.push([Boolean(options.requireStrictEvidence), Boolean(options.requireNextBlock)]);
    if (options.requireStrictEvidence || options.requireNextBlock) throw Error("not qualified");
    return nonStrictCurrent;
  } }), nonStrictCurrent);
  assert.deepEqual(nonStrictCalls, [[true, true], [true, false], [false, true], [false, false]]);
});

test("authorization is reloaded after nonce and immediately before sign/send, including base byte changes", async t => {
  for (const stage of ["nonce", "preSign", "preSend"]) {
    const f = fixture(t);
    const altered = replaceAuthorization(a => a.revoked = true, stage === "nonce" ? policy.BASES[1].path : policy.AMENDMENT_PATH);
    const readFile = file => ((stage === "nonce" && f.state.nonces) || (stage === "preSign" && f.journalExists()) ||
      (stage === "preSend" && f.state.signs)) ? altered(file) : readAuthorization(file);
    const out = await f.run({ amendmentReadFile: readFile });
    assert.equal(out.fired, false); assert.equal(f.state.signs, stage === "preSend" ? 1 : 0); assert.equal(f.state.sends, 0);
  }
});

test("stale/reorg/advanced/late parent checks block before signing and again before any send", async t => {
  for (const failStage of ["preSign", "preSend"]) for (const reason of ["NEXT_BLOCK_HEAD_STALE", "NEXT_BLOCK_PARENT_CHANGED", "NEXT_BLOCK_HEAD_ADVANCED", "NEXT_BLOCK_DEADLINE"]) {
    const f = fixture(t, { failStage, reason }), out = await f.run({ secondarySendRawTransaction: () => { f.state.secondary++; } });
    assert.equal(out.fired, false); assert.equal(f.state.signs, failStage === "preSend" ? 1 : 0); assert.equal(f.state.sends, 0);
    assert.equal(f.state.secondary, 0);
    assert.equal(out.summary.preflightFailures[0].reason, failStage === "preSend" ? "BROADCAST_OUTCOME_UNCERTAIN" : reason);
  }
});

test("concurrent secondary send shares pre-send validation; post-send parent advancement cannot suppress it", async t => {
  for (const failStage of [undefined, "secondary"]) {
    const f = fixture(t, { failStage }); let secondaryFinished = false;
    const out = await f.run({ secondarySendRawTransaction: async () => {
      assert.ok(f.state.checks > 0); assert.equal(f.state.sends, 1); await Promise.resolve(); secondaryFinished = true; f.state.secondary++;
    } });
    assert.equal(out.fired, true); assert.equal(f.state.secondary, 1); assert.equal(secondaryFinished, true);
  }
});

test("forecast and M1 dispatch identical bytes before primary settles, with primary-authoritative failure", { timeout: 10000 }, async t => {
  for (const rank of ["#2K", "M1"]) for (const outcome of ["success", "primary-reject", "primary-throw", "secondary-reject", "secondary-throw"]) {
    const f = fixture(t, { rank }), send = f.pinned.send;
    let releasePrimary, enteredSecondary;
    const gate = new Promise(resolve => { releasePrimary = resolve; });
    const entered = new Promise(resolve => { enteredSecondary = resolve; });
    f.pinned.send = signed => {
      if (outcome === "primary-throw") throw new guard.ExecutionError("RPC_FAILED");
      return gate.then(() => {
        if (outcome === "primary-reject") throw new guard.ExecutionError("RPC_FAILED");
        return send(signed);
      });
    };
    const pending = f.run({ secondarySendRawTransaction: signed => {
      assert.equal(signed, "0x010203"); assert.equal(f.state.sends, 0);
      enteredSecondary();
      if (outcome === "secondary-throw") throw new Error("OFFLINE_SECONDARY_FAILURE");
      if (outcome === "secondary-reject") return Promise.reject(new Error("OFFLINE_SECONDARY_FAILURE"));
      return Promise.resolve(keccak256(signed));
    } });
    try { await entered; } finally { releasePrimary(); }
    const out = await pending, primaryFailed = outcome.startsWith("primary-");
    assert.equal(out.fired, !primaryFailed); assert.equal(f.state.signs, 1);
    assert.equal(guard.readJournals(f.journalDir)[0].record.stage, primaryFailed ? "UNCERTAIN" : "RECEIPT_VERIFIED");
    if (primaryFailed) assert.equal(out.summary.preflightFailures[0].reason, "BROADCAST_OUTCOME_UNCERTAIN");
    else assert.equal(out.summary.execution.txHash, keccak256("0x010203"));
    assert.doesNotMatch(JSON.stringify(out), /OFFLINE_SECONDARY_FAILURE/);
  }
});

test("malformed simulation and altered transaction evidence reject before signing", async t => {
  for (const mutateProof of [p => p.context.parentHash = hash(2), p => p.context.transaction = { ...p.context.transaction, gas: "0x5208" },
    p => p.context.transaction = { ...p.context.transaction, nonce: "0x8" }, p => p.gasLimit = "0x5208",
    p => p.gasUsed = "0x0", p => p.logs = null, p => p.returnData = "0x0"]) {
    const f = fixture(t, { mutateProof }), out = await f.run(); assert.equal(out.fired, false); assert.equal(f.state.signs, 0);
    assert.equal(out.summary.preflightFailures[0].reason, "NEXT_BLOCK_SIMULATION_PROOF_INVALID");
  }
  const f = fixture(t, { noContext: true }); f.pinned.evidence.qualification[1].numberTimestampVerified = false;
  const out = await f.run(); assert.equal(out.summary.nextBlock.hold, "NEXT_BLOCK_QUALIFICATION_REQUIRED"); assert.equal(f.state.signs, 0);
});

test("unknown owner gain, missing/stale non-WETH valuation, nonpositive net and excessive slippage cannot sign", async t => {
  for (const options of [{ noGain: true }, { rank: "M1", noValuation: true }, { rank: "M1", staleValuation: true }, { rank: "M1", gain: 25n * W }]) {
    const f = fixture(t, options), out = await f.run(); assert.equal(out.fired, false); assert.equal(f.state.signs, 0);
    assert.match(out.summary.preflightFailures[0].reason, /NEXT_BLOCK_(OWNER_GAIN_UNKNOWN|ORACLE_|NET_NONPOSITIVE)|M1_SETTLEMENT_INVALID/);
  }
  await assert.rejects(policy.economics({ gain: W, minimumProfit: 100n, token: WETH, transaction: { gasLimit: 1500000n, maxFeePerGas: 1n } }), /NET_NONPOSITIVE/);
  const f = fixture(t), [candidate] = runner.selectCandidates({ targets: { [f.p.key]: f.p.row } }, [], { nextBlockContext: CONTEXT });
  const route = runner.forecastRoute(candidate), prepare = route.prepare;
  route.prepare = async simulate => ({ ...await prepare(simulate), quoteEvidence: { context: CONTEXT, maxSlippageBps: 50, outputRaw: "10000", minOutputRaw: "9949" } });
  await assert.rejects(policy.executeForecast({ candidate, pinned: f.pinned, route, validateBase: runner.validateForecastBase, readFile: readAuthorization,
    now: () => f.state.now, signTransaction: f.signTransaction, executionOptions: f }), /NEXT_BLOCK_SLIPPAGE_EXCEEDS_CAP/);
  assert.equal(f.state.signs, 0);
});

test("reverted attempts remain replay blockers; pending attempts retain indefinite wallet blocker", async t => {
  for (const pending of [false, true]) {
    const f = fixture(t, { reverted: true, pending }), first = await f.run(); assert.equal(first.fired, true);
    if (pending) await assert.rejects(f.run(), /TX_ALREADY_PENDING_ON_SAME_WALLET/);
    else { const second = await f.run(); assert.equal(second.summary.preflightFailures[0].reason, "NEXT_BLOCK_ALREADY_ATTEMPTED"); }
    assert.equal(f.state.signs, 1);
  }
});

test("healthy/current raw boundaries, explicit readiness vetoes, missing proof and wrong contexts never become candidates", () => {
  const p = plan(), select = row => runner.selectCandidates({ targets: { [p.key]: row } }, [], { nextBlockContext: CONTEXT });
  assert.equal(select(p.row).length, 1); // executableNow=false is only bypassed by the qualified health-only proposal.
  for (const edit of [{ inactive: true }, { positionStatus: "UNKNOWN" }, { positionStatus: "CLOSED" }, { debtRaw: "0" }, { debtReadStatus: "UNAVAILABLE" },
    { armed: false }, { routePositive: false }, { observationOnly: true }, { observationStatus: "INCOMPLETE" },
    { healthFactorRaw: (W - 1n).toString() }, { healthFactorRaw: (W + 6000000000000n).toString() }]) assert.deepEqual(select({ ...p.row, ...edit }), []);
  for (const edit of [{ eligibleForSimulation: false }, { evidence: "SIMULATED" }, { currentHealth: "UNKNOWN" }, { requiresExactSimulation: false },
    { currentHealthFactorRaw: undefined }, { currentHealthFactorRaw: (W + 6000000000000n).toString() },
    { context: { ...CONTEXT, parentHash: hash(5) } }, { plans: {} }]) assert.deepEqual(select({ ...p.row, nextBlockForecast: { ...p.row.nextBlockForecast, ...edit } }), []);
  assert.deepEqual(runner.selectCandidates({ targets: { [p.key]: p.row } }), [], "forecast cannot self-enable from cached context");
});

test("complete pinned read-only monitors nominate healthy forecasts without current readiness or execution authority", () => {
  for (const rank of ["#2K", "M1"]) {
    const p = plan(rank), row = monitorForecastRow(p.row), before = structuredClone(row);
    const status = { generatedAt: new Date(NOW).toISOString(), targets: { [p.key]: row } };
    assert.equal(policy.forecastEligible(row, CONTEXT), true);
    const [candidate] = runner.selectCandidates(status, [], { nextBlockContext: CONTEXT });
    assert.equal(candidate.id, p.key); assert.equal(candidate.executionMode, "NEXT_BLOCK_PASSIVE");
    assert.deepEqual(candidate.nextBlockContext, CONTEXT);
    assert.deepEqual(row, before, "nomination must not mutate monitor readiness or authority");
    assert.deepEqual(runner.selectCandidates(status), [], "public forecast context cannot self-enable nomination");
    assert.equal(policy.forecastEligible({ ...row, observationKind: undefined }, CONTEXT), false, "legacy armed=false remains a veto");
  }
});

test("monitor forecasts reject failed refreshes, missing or stale row pins and all existing health/route holds", () => {
  const p = plan(), row = monitorForecastRow(p.row);
  const select = value => runner.selectCandidates({ generatedAt: new Date(NOW).toISOString(), pin: PIN,
    targets: { [p.key]: value } }, [], { nextBlockContext: CONTEXT });
  for (const edit of [
    { observationStatus: "INCOMPLETE" }, { observationStatus: "UNAVAILABLE" }, { observationStatus: undefined },
    { refreshStatus: "INCOMPLETE", refreshReason: "WATCH_ITERATION_FAILED", refreshAttemptedAt: new Date(NOW).toISOString() },
    { refreshStatus: "UNAVAILABLE" }, { refreshStatus: "FAILED" }, { refreshStatus: undefined },
    { chainId: 8453 }, { chainId: undefined }, { observationBlock: PIN.number - 1 }, { observationBlock: undefined },
    { observationHash: hash(999) }, { observationHash: undefined },
    { observationTimestamp: PIN.timestamp - 12 }, { observationTimestamp: undefined },
    { inactive: true }, { positionStatus: "CLOSED" }, { positionStatus: "UNKNOWN" }, { debtRaw: "0" }, { debtReadStatus: "UNAVAILABLE" },
    { observationOnly: true }, { routePositive: false }, { liquidatableNow: true }, { hfUnderwaterNow: true },
    { healthFactorRaw: (W - 1n).toString() }, { healthFactorRaw: (W + 6000000000000n).toString() },
  ]) assert.deepEqual(select({ ...row, ...edit }), [], JSON.stringify(edit));
  for (const edit of [{ eligibleForSimulation: false }, { evidence: "SIMULATED" }, { currentHealth: "UNKNOWN" },
    { requiresExactSimulation: false }, { currentHealthFactorRaw: (W - 1n).toString() },
    { currentHealthFactorRaw: (W + 6000000000000n).toString() }, { plans: {} }, { plans: [] },
    { context: { ...CONTEXT, parentHash: hash(999) } }, { context: { ...CONTEXT, parentNumber: PIN.number - 1 } },
    { context: { ...CONTEXT, parentTimestamp: PIN.timestamp - 12 } }, { context: { ...CONTEXT, number: CONTEXT.number + 1 } },
    { context: { ...CONTEXT, timestamp: CONTEXT.timestamp + 12 } }]) {
    assert.deepEqual(select({ ...row, nextBlockForecast: { ...row.nextBlockForecast, ...edit } }), [], JSON.stringify(edit));
  }
});

test("monitor nomination cannot replace trusted future capability, authorization or exact simulation proof", async t => {
  for (const mutate of [
    f => { f.pinned.nextBlock = { context: CONTEXT, ...f.pinned.evidence }; }, // Copied public qualification flags, not callable capability.
    f => { delete f.pinned.nextBlock.simulate; },
    f => { delete f.pinned.nextBlock.recheck; },
    f => { f.pinned.evidence.qualification[0].timeControlVerified = false; },
    f => { f.state.now = CONTEXT.timestamp * 1000; },
  ]) {
    const f = fixture(t, { noContext: true }); f.p.row = monitorForecastRow(f.p.row); mutate(f);
    const out = await f.run();
    assert.equal(out.fired, false); assert.equal(out.summary.nextBlock.enabled, false);
    assert.match(out.summary.nextBlock.hold, /NEXT_BLOCK_/);
    assert.equal(f.state.nonces, 0); assert.equal(f.state.signs, 0); assert.equal(f.state.sends, 0);
    assert.equal(f.state.simulations.length, 0);
  }
  const missing = fixture(t, { noContext: true, readFile: () => { throw Error("missing"); } });
  missing.p.row = monitorForecastRow(missing.p.row);
  const held = await missing.run();
  assert.equal(held.fired, false); assert.equal(held.summary.nextBlock.enabled, false);
  assert.equal(missing.state.nonces, 0); assert.equal(missing.state.signs, 0); assert.equal(missing.state.sends, 0);
  const invalid = fixture(t, { mutateProof: proof => { proof.context.timestamp++; } });
  invalid.p.row = monitorForecastRow(invalid.p.row);
  const out = await invalid.run();
  assert.equal(out.fired, false); assert.equal(out.summary.preflightFailures[0].reason, "NEXT_BLOCK_SIMULATION_PROOF_INVALID");
  assert.ok(invalid.state.simulations.length > 0); assert.equal(invalid.state.signs, 0); assert.equal(invalid.state.sends, 0);
});

test("M1 child uses live settlement without any parent-positive file and never falls back when amendment is absent", async t => {
  const f = fixture(t, { rank: "M1" }), out = await f.run({ morphoEvidenceReadFile: () => assert.fail("obsolete retained artifact accessed") });
  assert.equal(out.fired, true); assert.equal(f.state.signs, 1);
  const held = fixture(t, { rank: "M1" }), result = await held.run({ m1ReadFile: () => { throw Error("missing"); } });
  assert.equal(result.fired, false); assert.equal(result.summary.preflightFailures[0].reason, "M1_LIVE_APPROVAL_REQUIRED");
  assert.equal(held.state.nonces, 0); assert.equal(held.state.signs, 0);
});

test("M1 evidence is re-read before sign/concurrent sends and after dispatch", async t => {
  for (const stage of ["preSign", "preSend", "secondary"]) {
    const f = fixture(t, { rank: "M1" });
    const read = file => {
      const raw = m1Fixtures.readEvidence(file);
      if (file === path.join(ROOT, m1Live.AMENDMENT_PATH) && (stage === "preSign" && f.journalExists() || stage === "preSend" && f.state.signs || stage === "secondary" && f.state.sends))
        return Buffer.concat([raw, Buffer.from(" ")]);
      return raw;
    };
    const out = await f.run({ m1ReadFile: read, secondarySendRawTransaction: async () => { f.state.secondary++; } });
    assert.equal(out.fired, stage === "secondary");
    assert.equal(f.state.signs, stage === "preSign" ? 0 : 1); assert.equal(f.state.sends, stage === "secondary" ? 1 : 0);
    assert.equal(f.state.secondary, stage === "secondary" ? 1 : 0);
  }
});

test("swapped route quotes actual collateral ten times the seizure floor, then binds the final exact transaction", async t => {
  const f = fixture(t, { rank: "#S1", actualInput: 50n * W }), out = await f.run();
  assert.equal(out.fired, true, JSON.stringify(out.summary.preflightFailures));
  const calls = f.state.simulations, executions = calls.filter(c => c.to === f.p.executor), quotes = calls.filter(c => c.to === QUOTER);
  assert.equal(executions.length, 3); assert.equal(quotes.length, 1);
  assert.ok(calls.indexOf(executions[0]) < calls.indexOf(quotes[0]) && calls.indexOf(quotes[0]) < calls.indexOf(executions[1]));
  assert.equal(runner.QUOTER_IFACE.decodeFunctionData("quoteExactInput", quotes[0].data)[1], 50n * W);
  const p = runner.UNIFIED_IFACE.decodeFunctionData("executeMorpho", f.state.tx.data)[1];
  assert.equal(p.minCollateralSeized, 5n * W); assert.equal(p.minDebtTokenOut, 61n * W * 9950n / 10000n);
  assert.equal(p.minProfitDebtToken, W / 10n); assert.equal(f.state.tx.data, executions[2].data);
  assert.equal(executions[1].data, executions[2].data); assert.ok(executions[2].maxPriorityFeePerGas > executions[1].maxPriorityFeePerGas);
  assert.notEqual(executions[0].data, executions[1].data); assert.equal(out.summary.execution.intent.quoteEvidence.inputRaw, (50n * W).toString());
});

test("final repriced simulation, not the preliminary proof, binds gain and swap input before signing", async t => {
  for (const mutateInput of [
    (logs, n) => { if (n === 3) logs[0].data = hash(6n * W); },
    (logs, n) => { if (n === 3) logs[1].data = hash(0n); },
  ]) {
    const f = fixture(t, { rank: "#S1", mutateInput }), out = await f.run();
    assert.equal(out.fired, false); assert.equal(f.state.executorCalls, 3); assert.equal(f.state.signs, 0); assert.equal(f.state.sends, 0);
    assert.match(out.summary.preflightFailures[0].reason, /NEXT_BLOCK_SWAP_INPUT_CHANGED|NEXT_BLOCK_OWNER_GAIN_UNKNOWN/);
  }
});

test("forecast zero P and tip-induced nonpositive worst-case net remain unsigned", async t => {
  for (const minimumProfit of [555555555555556n, 750000000000000n]) {
    const f = fixture(t), [candidate] = runner.selectCandidates({ targets: { [f.p.key]: f.p.row } }, [], { nextBlockContext: CONTEXT });
    const route = runner.forecastRoute(candidate), prepare = route.prepare;
    route.prepare = async simulate => ({ ...await prepare(simulate), minimumProfit });
    await assert.rejects(policy.executeForecast({ candidate, pinned: f.pinned, route, validateBase: runner.validateForecastBase,
      readFile: readAuthorization, now: () => f.state.now, signTransaction: f.signTransaction, executionOptions: f }),
    /NEXT_BLOCK_NET_NONPOSITIVE|PROFIT_NET_NONPOSITIVE/);
    assert.equal(f.state.signs, 0); assert.equal(f.state.sends, 0); assert.equal(f.journalExists(), false);
  }
});

test("missing, malformed, ambiguous and wrong-route swap inputs hold; changed final input is never signed", async t => {
  for (const mutateInput of [logs => logs.shift(), logs => logs[0].address = ZERO, logs => logs[0].data = "0x01",
    logs => logs[0].topics.push(hash(0)), logs => logs[0].topics[1] = zeroPadValue(ZERO, 32),
    logs => logs[0].topics[2] = zeroPadValue(ROUTER, 32), logs => logs.push({ ...logs[0] }),
    logs => logs[0].data = hash(4n * W), logs => logs[0].removed = true]) {
    const f = fixture(t, { rank: "#S1", mutateInput }), out = await f.run();
    assert.equal(out.fired, false); assert.equal(out.summary.preflightFailures[0].reason, "NEXT_BLOCK_SWAP_INPUT_UNPROVEN");
    assert.equal(f.state.signs, 0); assert.equal(f.state.sends, 0);
    assert.equal(f.state.simulations.some(c => c.to === QUOTER), false);
  }
  const changed = fixture(t, { rank: "#S1", mutateInput: (logs, n) => { if (n === 2) logs[0].data = hash(6n * W); } });
  const out = await changed.run(); assert.equal(out.summary.preflightFailures[0].reason, "NEXT_BLOCK_SWAP_INPUT_CHANGED");
  assert.equal(changed.state.signs, 0); assert.equal(changed.state.sends, 0); assert.equal(changed.state.executorCalls, 2);
  for (const actualInput of [108499n * W, 108501n * W]) {
    const f = fixture(t, { rank: "M1", actualInput }), held = await f.run();
    assert.equal(held.summary.preflightFailures[0].reason, "M1_SETTLEMENT_INVALID"); assert.equal(f.state.signs, 0);
  }
});

test("deadline is checked after authorization reload before sign/concurrent sends and after dispatch", async t => {
  for (const stage of ["preSign", "preSend", "secondary"]) {
    const f = fixture(t), recheck = f.next.recheck; let postCheck = false;
    f.next.recheck = async () => {
      await recheck();
      postCheck = stage === "preSign" ? f.journalExists() : stage === "preSend" ? f.state.signs > 0 : f.state.sends > 0;
    };
    const out = await f.run({ amendmentReadFile: file => {
      const bytes = readAuthorization(file);
      if (postCheck && file === path.join(ROOT, policy.BASES[1].path)) f.state.now = CONTEXT.timestamp * 1000;
      return bytes;
    }, secondarySendRawTransaction: async () => { f.state.secondary++; } });
    assert.equal(out.fired, stage === "secondary"); assert.equal(f.state.signs, stage === "preSign" ? 0 : 1);
    assert.equal(f.state.sends, stage === "secondary" ? 1 : 0); assert.equal(f.state.secondary, stage === "secondary" ? 1 : 0);
    if (stage === "preSign") assert.equal(out.summary.preflightFailures[0].reason, "NEXT_BLOCK_DEADLINE");
  }
});

test("DAI valuation uses one strict six-result feed batch; malformed, failed, denomination and round responses hold", async t => {
  for (const mutateFeeds of [rows => rows.pop(), rows => rows.push(rows[0]), rows => rows[0].success = false,
    rows => rows[0].returnData = "0x", rows => rows[1].returnData += "00",
    rows => rows[0].returnData = FEED_IFACE.encodeFunctionResult("decimals", [18]),
    rows => rows[4].returnData = FEED_IFACE.encodeFunctionResult("description", ["DAI / ETH"]),
    rows => rows[5].returnData = FEED_IFACE.encodeFunctionResult("latestRoundData", [2, 100000000, PIN.timestamp, PIN.timestamp, 1]),
    rows => rows[2].returnData = FEED_IFACE.encodeFunctionResult("latestRoundData", [1, 0, PIN.timestamp, PIN.timestamp, 1]),
    rows => rows[5].returnData = FEED_IFACE.encodeFunctionResult("latestRoundData", [1, 100000000, PIN.timestamp, CONTEXT.timestamp + 1, 1])]) {
    const f = fixture(t, { rank: "M1", mutateFeeds }), out = await f.run();
    assert.equal(out.fired, false); assert.match(out.summary.preflightFailures[0].reason, /^NEXT_BLOCK_ORACLE_/);
    assert.equal(f.state.signs, 0); assert.equal(f.state.sends, 0);
    assert.equal(f.state.simulations.filter(c => c.to === MULTICALL3).length, 2, "separate accrued-state and six-response feed batches");
    assert.equal(f.state.simulations.some(c => Object.values(policy.FEEDS).some(feed => c.to === feed.address)), false);
  }
});

test("full synthetic-positive M1 flow models nonzero transport latency and fails closed when the slot budget is exhausted", async t => {
  for (const delay of [50, 200]) {
    const f = fixture(t, { rank: "M1" }), counts = { requests: 0, stages: 0, simulations: 0 }, events = [];
    // Two families run concurrently within each stage; each stage advances the
    // injected wall clock. No real RPC, signing, sleeps, endpoints or wallets.
    const advance = (stage, requests = 2) => {
      counts.requests += requests; counts.stages++; f.state.now += delay; events.push(stage);
    };
    const header = { number: hex(PIN.number), hash: PIN.hash, parentHash: hash(999), stateRoot: hash(8),
      timestamp: hex(PIN.timestamp), baseFeePerGas: hex(PIN.baseFeePerGas), gasLimit: hex(30000000) };
    let pairedProof;
    const transport = createNextBlockSimulation({ pin: { ...PIN, parentHash: hash(999), stateRoot: hash(8), gasLimit: "30000000" },
      providers: [{ family: "one", alias: 1 }, { family: "two", alias: 2 }], now: () => f.state.now, assertUsable() {},
      request: async (provider, method, params) => {
        if (provider.alias === 1) advance(method);
        if (method === "eth_chainId") return "0x1";
        if (method === "eth_getBlockByNumber") return header;
        assert.equal(method, "eth_simulateV1");
        counts.simulations++;
        const tx = params[0].blockStateCalls[0].calls[0];
        if (provider.alias === 1) pairedProof = f.next.simulate({ type: 2, chainId: 1, from: tx.from, to: tx.to, data: tx.input,
          value: 0n, nonce: Number(BigInt(tx.nonce)), gasLimit: BigInt(tx.gas), maxFeePerGas: BigInt(tx.maxFeePerGas),
          maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas), accessList: [] });
        const proof = await pairedProof;
        return [{ parentHash: PIN.hash, number: hex(CONTEXT.number), timestamp: hex(CONTEXT.timestamp), transactions: [tx],
          calls: [{ status: "0x1", gasUsed: proof.gasUsed, returnData: proof.returnData, logs: proof.logs }] }];
      } });
    f.pinned.nextBlock = transport;
    const rawCode = f.pinned.code, rawCall = f.pinned.call;
    f.pinned.code = async address => { advance("code"); return rawCode(address); };
    f.pinned.call = async tx => { advance("parent-state"); return rawCall(tx); };
    f.pinned.recheck = async () => { for (let n = 0; n < 6; n++) advance("parent-recheck", 1); };
    f.pinned.nonce = async () => { advance("nonce"); f.state.nonces++; return "0x7"; };
    f.pinned.send = async raw => { f.state.sendAt = f.state.now; advance("send", 1); f.state.sends++; return keccak256(raw); };
    const receipt = f.pinned.receipt;
    f.pinned.receipt = async hash => { advance("receipt"); return receipt(hash); };
    const out = await f.run({ signTransaction: async tx => { f.state.signAt = f.state.now; return f.signTransaction(tx); },
      checkOnce: async () => {
        // Four bounded paired collector stages are included, not zero-time health discovery.
        for (let n = 0; n < 4; n++) advance("collector");
        return { pin: PIN, targets: { [f.p.key]: f.p.row } };
      } });
    const elapsed = f.state.now - NOW;
    t.diagnostic(JSON.stringify({ rpcStageMs: delay, elapsedMs: elapsed, budgetMs: CONTEXT.timestamp * 1000 - NOW, ...counts,
      signElapsedMs: f.state.signAt === undefined ? null : f.state.signAt - NOW,
      sendElapsedMs: f.state.sendAt === undefined ? null : f.state.sendAt - NOW, signs: f.state.signs, sends: f.state.sends }));
    if (delay === 50) {
      assert.equal(out.fired, true, JSON.stringify(out.summary.preflightFailures));
      assert.equal(f.state.signs, 1); assert.equal(f.state.sends, 1); assert.ok(f.state.sendAt < CONTEXT.timestamp * 1000);
      assert.equal(counts.simulations, 16, "eight separate exact calls, each corroborated on two families; no aux transaction prepended to execution");
      assert.equal(f.state.simulations.filter(c => c.to === MULTICALL3).length, 2);
      assert.ok(elapsed < 9000);
    } else {
      assert.equal(out.fired, false); assert.equal(f.state.signs, 0); assert.equal(f.state.sends, 0);
      assert.match(out.summary.preflightFailures[0].reason, /NEXT_BLOCK_DEADLINE/); assert.ok(elapsed >= 9000);
    }
  }
});
