"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const { ethers } = require("ethers");
const scenario = require("../fork-poc/snusd-usdc-delayed-normal");
const wrapper = require("../run-snusd-usdc-delayed-local");
const harness = require("../run-fork-poc");
const root = path.resolve(__dirname, "../..");
const input = () => JSON.parse(fs.readFileSync(path.join(root, wrapper.MANIFEST)));
const abi = new ethers.Interface(scenario.ABI);

function mock(options = {}) {
  const m = input(), b = m.bindings, donor = m.fundingEoas[0];
  const state = { sends: [], reads: [], logs: [], asserts: [], seeds: [], waits: [], unsafeAccess: 0, block: Number(m.pin.number), headers: new Map(),
    usdc: new Map([[m.actor, options.dirtyActor ? 1n : 0n], [donor, 2000000000n]]), snusd: 0n, nusd: 0n,
    native: new Map([[m.actor, 0n], [donor, 10n ** 18n]]), allowances: new Map(), pending: [0n, 0n], liquidated: false };
  const header = n => n === Number(m.pin.number) ? { number: n, hash: m.pin.hash, stateRoot: options.wrongRoot ? "0x" + "ff".repeat(32) : m.pin.stateRoot, timestamp: m.pin.timestamp }
    : state.headers.get(n);
  const codes = new Map(Object.keys(m.runtimes).map((a, i) => [a, "0x60" + i.toString(16).padStart(2, "0")]));
  const codeHashes = new Map([...codes].map(([a, code]) => [code, m.runtimes[a]]));
  const mockEthers = { ...ethers, keccak256: data => codeHashes.get(data) || ethers.keccak256(data) };
  const ctx = {
    chainId: 1, blockNumber: m.pin.number, blockHash: options.wrongHash ? "0x" + "ee".repeat(32) : m.pin.hash, ethers: mockEthers, input: m,
    readBlockHeader: async n => { assert.ok(n >= Number(m.pin.number) && n <= Number(m.pin.number) + 8); return header(n); },
    waitOrdinary: async ms => { assert.ok(ms >= 0 && ms <= 5000); state.waits.push(ms); },
    assert: (v, label) => { state.asserts.push({ pass: !!v, label }); return !!v; },
    log: (label, value) => { state.logs.push({ label, value }); return value; },
    getCode: async address => options.donorContract && address === donor ? "0x6000" : codes.get(address) || "0x",
    getStorageAt: async (_address, slot) => { assert.equal(slot, "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"); return "0x" + "00".repeat(32); },
    getBalance: async address => ethers.toQuantity(state.native.get(address) || 0n),
    setBalance: async (address, quantity) => {
      assert.ok(address === m.actor || address === donor); assert.equal(state.sends.length, 0);
      assert.equal(BigInt(quantity), BigInt(address === m.actor ? m.actorNativeFixtureWei : m.fundingNativeFixtureWei));
      state.seeds.push([address, BigInt(quantity)]); state.native.set(address, BigInt(quantity));
    },
    call: async tx => {
      assert.ok(Object.hasOwn(m.runtimes, tx.to), "fixed read target");
      const p = abi.parseTransaction(tx), args = p.args; state.reads.push({ to: tx.to, method: p.name, from: tx.from });
      if (tx.from) { assert.equal(tx.from, b.morpho); assert.equal(tx.to, b.irm); assert.equal(p.name, "borrowRate"); }
      let answer;
      switch (p.name) {
        case "idToMarketParams": answer = options.wrongMarket ? [b.usdc, b.usdc, b.oracle, b.irm, m.marketParams[4]] : m.marketParams; break;
        case "market": answer = m.storedMarket; break;
        case "position": answer = state.liquidated ? [0n, 0n, 0n] : m.position; break;
        case "price": answer = [m.oraclePriceRaw]; break;
        case "borrowRate": answer = [m.borrowRateRaw]; break;
        case "asset": answer = [options.wrongToken ? b.usdc : b.nusd]; break;
        case "silo": answer = [b.silo]; break;
        case "coins": answer = [args[0] === 0n ? b.nusd : b.usdc]; break;
        case "decimals": answer = [tx.to === b.usdc ? 6n : 18n]; break;
        case "paused": answer = [false]; break;
        case "cooldownDuration": answer = [m.cooldownSeconds]; break;
        case "cooldowns": answer = state.pending; break;
        case "allowance": answer = [state.allowances.get(tx.to + args[1].toLowerCase()) || 0n]; break;
        case "balanceOf": answer = [tx.to === b.usdc ? state.usdc.get(args[0].toLowerCase()) || 0n : tx.to === b.snusd ? state.snusd : state.nusd]; break;
        default: assert.fail("unexpected call " + p.name);
      }
      return abi.encodeFunctionResult(p.name, answer);
    },
    send: async tx => {
      assert.ok(Object.hasOwn(m.runtimes, tx.to)); assert.ok(tx.from === m.actor || tx.from === donor);
      assert.equal(tx.value, "0x0"); const p = abi.parseTransaction(tx), args = p.args;
      assert.ok(["transfer", "approve", "liquidate", "cooldownShares", "unstake", "exchange"].includes(p.name));
      state.sends.push({ from: tx.from, to: tx.to, method: p.name, args, gas: BigInt(tx.gas) });
      if (p.name === "transfer" && options.sendError) throw options.sendError;
      if (p.name === "transfer" && options.malformedReturn) return options.malformedReturn;
      if (options.revertMethod === p.name) throw new Error("LOCAL_REVERT");
      const number = ++state.block, timestamp = BigInt(m.pin.timestamp) + BigInt(number - Number(m.pin.number));
      const h = { number, hash: ethers.toBeHex(number, 32), stateRoot: ethers.toBeHex(number + 1, 32), timestamp: timestamp.toString() };
      state.headers.set(number, h); const logs = [];
      if (p.name === "transfer") {
        assert.equal(tx.from, donor); assert.equal(tx.to, b.usdc); assert.equal(args[0].toLowerCase(), m.actor); assert.equal(args[1], BigInt(m.principalRaw));
        const funded = options.shortFunding ? args[1] - 1n : args[1];
        state.usdc.set(donor, state.usdc.get(donor) - args[1]); state.usdc.set(m.actor, funded);
      } else if (p.name === "approve") {
        assert.equal(tx.from, m.actor); assert.ok((tx.to === b.usdc && args[0].toLowerCase() === b.morpho) || (tx.to === b.nusd && args[0].toLowerCase() === b.curve));
        state.allowances.set(tx.to + args[0].toLowerCase(), args[1]);
      } else if (p.name === "liquidate") {
        assert.equal(tx.to, b.morpho); assert.equal(args[1].toLowerCase(), b.borrower); assert.equal(args[2], BigInt(m.seizedAssetsRaw));
        assert.equal(args[3], 0n); assert.equal(args[4], "0x");
        const repaid = BigInt(m.capturedRepaymentRaw), debit = options.overspend ? BigInt(m.repaymentApprovalRaw) + 1n : repaid;
        state.usdc.set(m.actor, state.usdc.get(m.actor) - debit); state.snusd = args[2]; state.liquidated = true;
        state.allowances.set(b.usdc + b.morpho, BigInt(m.repaymentApprovalRaw) - repaid);
        const event = abi.encodeEventLog("Liquidate", [b.marketId, m.actor, b.borrower, repaid, 554350664722939n, args[2], 1059183700n, 499391502689311n]);
        if (!options.missingEvent) logs.push({ address: b.morpho, ...event });
      } else if (p.name === "cooldownShares") {
        assert.equal(tx.to, b.snusd); assert.equal(args[0], state.snusd); state.snusd = 0n;
        state.pending = [timestamp + (options.longCooldown ? 10n : 1n), BigInt(m.previewUnderlyingRaw)];
      } else if (p.name === "unstake") {
        assert.equal(tx.to, b.snusd); assert.equal(args[0].toLowerCase(), m.actor);
        if (options.cooldownUnmet) h.timestamp = (state.pending[0] - 1n).toString();
        state.nusd = options.emptyCash ? 0n : state.pending[1];
        state.pending = options.pendingResidual ? [state.pending[0], 1n] : [0n, 0n];
      } else if (p.name === "exchange") {
        assert.equal(tx.to, b.curve); assert.equal(args[0], 0n); assert.equal(args[1], 1n); assert.equal(args[2], state.nusd); assert.equal(args[3], BigInt(m.minExitRaw));
        state.nusd = options.tokenResidual ? 1n : 0n; state.usdc.set(m.actor, state.usdc.get(m.actor) + (options.negativeCash ? 1000000000n : BigInt(m.capturedExitRaw)));
        state.allowances.set(b.nusd + b.curve, 0n);
      }
      const gasUsed = options.gasOverspend ? BigInt(tx.gas) + 1n : 25000n, price = 1000000000n;
      state.native.set(tx.from, state.native.get(tx.from) - gasUsed * price);
      return { hash: ethers.toBeHex(number + 2, 32), receipt: { status: "0x1", gasUsed: ethers.toQuantity(gasUsed), effectiveGasPrice: ethers.toQuantity(price), blockNumber: ethers.toQuantity(number), blockHash: h.hash, logs } };
    }
  };
  for (const name of ["setCode", "setStorageAt", "deploy", "send7702", "sendAuthorization", "impersonate", "snapshot", "revert", "increaseTime", "setNextBlockTimestamp", "mine", "signTransaction"]) {
    Object.defineProperty(ctx, name, { get() { state.unsafeAccess++; assert.fail("unsafe capability accessed: " + name); } });
  }
  return { ctx, state, m };
}

test("normal mocked EOA sequence measures cash and excludes funding principal", async () => {
  const { ctx, state, m } = mock(); await scenario.run(ctx);
  assert.equal(state.sends.length, 8); assert.equal(state.seeds.length, 2);
  assert.equal(state.seeds.reduce((n, [, amount]) => n + amount, 0n), 10000000000000000n);
  const facts = state.logs.find(x => x.label === "historical-simulated-cash").value;
  assert.equal(facts.grossUsdcRaw, 24927763n); assert.equal(facts.postFundingBaseline.usdc, 1200000000n);
  assert.equal(facts.final.usdc, 1224927763n); assert.equal(facts.actualPaidNusdRaw, BigInt(m.previewUnderlyingRaw));
  assert.equal(facts.actualLiveProfit, null); assert.equal(facts.currentExecutable, false); assert.ok(facts.referenceNetUsdcRaw > 0n);
  assert.equal(facts.fixtureGasWei, 25000n * 1000000000n); assert.equal(facts.actorGasWei, 7n * facts.fixtureGasWei);
  const progress = state.logs.find(x => x.label === "funding-progress").value;
  assert.equal(progress.sendEntered, true); assert.equal(progress.sendReturned, true); assert.equal(progress.receiptSeen, true);
  assert.equal(progress.headerReadEntered, true); assert.equal(progress.headerReadReturned, true); assert.equal(progress.baselineEstablished, true);
  assert.deepEqual(state.waits, [1000]); assert.equal(state.logs.filter(x => x.label === "receipt").length, 8);
  assert.ok(state.asserts.every(x => x.pass));
});
test("input, exact pin/root, market and token mismatches fail before funding", async () => {
  for (const opts of [{ wrongHash: true }, { wrongRoot: true }, { wrongMarket: true }, { wrongToken: true }, { dirtyActor: true }]) {
    const { ctx, state } = mock(opts); await assert.rejects(scenario.run(ctx)); assert.equal(state.sends.length, 0); assert.equal(state.seeds.length, 0);
    assert.equal(state.unsafeAccess, 0);
  }
  const { ctx, state } = mock(); ctx.input = { ...ctx.input, unknown: true };
  await assert.rejects(scenario.run(ctx)); assert.equal(state.reads.length, 0);
});
test("caps and unknown manifest fields cannot be enlarged", () => {
  for (const mutate of [m => m.caps.sends++, m => m.caps.gasUnits++, m => m.caps.nativeWei = "10000000000000001", m => m.principalRaw = "1200000001",
    m => m.pin.number = "26217683", m => m.bindings.usdc = m.bindings.nusd]) {
    const m = input(); mutate(m); assert.throws(() => scenario.validateInput(m, ethers), /INPUT_COMMITMENT_MISMATCH/);
  }
});
test("a contract funding fixture and short funding cannot imply usable capital", async () => {
  for (const opts of [{ donorContract: true }, { shortFunding: true }]) {
    const { ctx, state } = mock(opts); await assert.rejects(scenario.run(ctx));
    assert.ok(state.sends.length <= 1); assert.equal(state.logs.some(x => x.label === "historical-simulated-cash"), false);
    assert.equal(state.unsafeAccess, 0);
  }
});
test("caller restrictions/reverts terminate rather than using roles or storage bypasses", async () => {
  for (const name of ["liquidate", "cooldownShares", "unstake", "exchange"]) {
    const { ctx, state } = mock({ revertMethod: name }); await assert.rejects(scenario.run(ctx));
    assert.equal(state.sends.at(-1).method, name); assert.equal(state.logs.some(x => x.label === "historical-simulated-cash"), false);
    assert.equal(state.unsafeAccess, 0);
  }
});
test("cooldown outside bound or unmet at claim does not become paid cash", async () => {
  for (const opts of [{ longCooldown: true }, { cooldownUnmet: true }]) {
    const { ctx, state } = mock(opts); await assert.rejects(scenario.run(ctx));
    assert.equal(state.sends.some(x => x.method === "exchange"), false);
    assert.equal(state.unsafeAccess, 0);
  }
});
test("empty payout, pending entitlement and token residuals suppress success", async () => {
  for (const opts of [{ emptyCash: true }, { pendingResidual: true }, { tokenResidual: true }]) {
    const { ctx, state } = mock(opts); await assert.rejects(scenario.run(ctx));
    assert.equal(state.logs.some(x => x.label === "historical-simulated-cash"), false);
    assert.equal(state.unsafeAccess, 0);
  }
});
test("overspend, missing liquidation event, gas excess and negative cash abort", async () => {
  for (const opts of [{ overspend: true }, { missingEvent: true }, { gasOverspend: true }, { negativeCash: true }]) {
    const { ctx, state } = mock(opts); await assert.rejects(scenario.run(ctx));
    assert.equal(state.logs.some(x => x.label === "historical-simulated-cash"), false);
    assert.ok(state.sends.length <= 8);
    assert.equal(state.unsafeAccess, 0);
  }
});
test("manifest, receipt and exact source commitments validate offline and fit real ctx input", () => {
  const m = wrapper.prepare(); assert.equal(m.receiptSha256, "59f45afd7ee910a0c57e1fc8ec9b6f68da49f5aaaaf7a01fe62922515d038eee");
  assert.deepEqual(harness.plainValue(m), m);
  assert.throws(() => wrapper.prepare(file => file.endsWith(wrapper.SCENARIO.replace(/\//g, path.sep)) ? Buffer.from("changed") : fs.readFileSync(file)), /SCENARIO_SOURCE_MISMATCH/);
});
test("wrapper exact CLI/output refusal and injected mock harness never execute real RPC", async () => {
  let calls = 0;
  const runForkPoc = async (opts, deps) => { calls++; assert.equal(opts.callerClass, "MANUAL"); assert.equal(opts.chain, "1"); assert.equal(opts.block, "26217682");
    assert.equal(opts.limits.sends, 8); assert.equal(opts.limits.relayRequests, 1000); assert.equal(opts.limits.totalMs, 180000);
    assert.equal(opts.outPath, path.join(root, wrapper.OUT)); assert.equal(typeof deps.createLocalRpc, "function"); return { status: "PASS", blocker: null }; };
  for (const args of [[], ["--help"], ["--run", "--live"], ["--run", "--output", "other"], ["--run", "--run"]]) await assert.rejects(wrapper.main(args, { runForkPoc }));
  await assert.rejects(wrapper.main(["--run"], { runForkPoc, exists: () => true }), /OUTPUT_ALREADY_EXISTS/);
  await assert.rejects(wrapper.main(["--run"], { runForkPoc, output: () => {} }), /TEST_SEAM_REQUIRES_MOCK_HARNESS/);
  assert.equal(calls, 0); assert.equal((await wrapper.main(["--run"], { runForkPoc, exists: () => false })).status, "PASS"); assert.equal(calls, 1);
});
test("wrapper provides only bounded ctx reads/native fixtures; unsafe capabilities absent", async () => {
  const m = input(), rawCalls = [], passedLimits = [];
  const fakeLocal = { call: async (method, params) => { rawCalls.push([method, params]); assert.equal(method, "eth_getBlockByNumber"); return { number: ethers.toQuantity(m.pin.number), hash: m.pin.hash, stateRoot: m.pin.stateRoot, timestamp: ethers.toQuantity(m.pin.timestamp) }; } };
  const base = { loadRpcUrls: opts => { assert.equal(opts.maxCandidates, 8); return []; }, transport: async () => ({ value: { result: { number: ethers.toQuantity(m.pin.number), hash: "wrong", stateRoot: m.pin.stateRoot, timestamp: ethers.toQuantity(m.pin.timestamp) } } }) };
  const fakeHarness = { defaultDeps: () => base, leakGuard: () => {} };
  const approved = { createLocalRpc: (_port, opts) => { passedLimits.push(opts.limits); return fakeLocal; } };
  let ran = false;
  const deps = wrapper.makeHarnessDeps(fakeHarness, approved, m, { run: async ctx => {
    ran = true; for (const key of ["deploy", "setCode", "send7702", "sendAuthorization", "impersonate", "snapshot", "revert", "rpc", "provider", "mine"]) assert.equal(ctx[key], undefined);
    assert.equal((await ctx.readBlockHeader(Number(m.pin.number))).stateRoot, m.pin.stateRoot);
    await assert.rejects(ctx.readBlockHeader(Number(m.pin.number) + 9), /HEADER_READ_SCOPE_INVALID/);
    assert.throws(() => ctx.setBalance(m.bindings.morpho, "0x1"), /NATIVE_FIXTURE_SCOPE_REJECTED/);
    assert.throws(() => ctx.call({ to: m.actor, data: "0x" }), /CALL_TARGET_REJECTED/);
    assert.throws(() => ctx.send({ to: m.actor, from: m.actor, data: "0x", gas: "0x1" }), /SEND_SCOPE_REJECTED/);
    await assert.rejects(ctx.waitOrdinary(5001), /ORDINARY_WAIT_CAP/);
  } });
  deps.createLocalRpc(12345); assert.deepEqual(passedLimits, [m.harnessLimits]);
  await deps.loadScenario(path.join(root, wrapper.SCENARIO)).run({ chainId: 1, blockNumber: m.pin.number, blockHash: m.pin.hash, ethers, input: m, log: () => {}, assert: () => {}, call: () => assert.fail(), send: () => assert.fail(), getCode: () => assert.fail(), getStorageAt: () => assert.fail(), getBalance: () => assert.fail(), setBalance: () => assert.fail() });
  assert.equal(ran, true); assert.equal(rawCalls.length, 1);
  await assert.rejects(deps.transport("inert-fixture", { method: "eth_getBlockByNumber", params: [ethers.toQuantity(m.pin.number), false] }, 1, 10), /UPSTREAM_FIXED_PIN_MISMATCH/);
});
test("imports and no-run child refusal are offline and preserve existing fork output", () => {
  const preserved = fs.readFileSync(path.join(root, wrapper.OUT));
  const source = path.join(root, wrapper.SCENARIO), driver = path.join(root, "tools/run-snusd-usdc-delayed-local.js");
  const imported = spawnSync(process.execPath, ["-e", `global.fetch=()=>{throw Error('NO_NETWORK')};require(${JSON.stringify(source)});require(${JSON.stringify(driver)})`], { encoding: "utf8" });
  assert.equal(imported.status, 0); assert.equal(imported.stdout, ""); assert.equal(imported.stderr, "");
  const refused = spawnSync(process.execPath, [driver], { encoding: "utf8" });
  assert.equal(refused.status, 1); assert.equal(refused.stderr.trim(), "EXPLICIT_FIXED_RUN_REQUIRED");
  assert.deepEqual(fs.readFileSync(path.join(root, wrapper.OUT)), preserved);
  assert.equal(crypto.createHash("sha256").update(preserved).digest("hex"), wrapper.ORIGINAL_RECEIPT_SHA);
});
test("real createScenarioContext works through fixed wrapper with inert local RPC spies", async () => {
  const fixture = mock(), { m, state } = fixture, receipts = new Map(), rpcMethods = [];
  const local = { call: async (method, params) => {
    rpcMethods.push(method); assert.ok(rpcMethods.length <= m.harnessLimits.localRequests);
    if (method === "eth_getBlockByNumber") { const h = await fixture.ctx.readBlockHeader(Number(BigInt(params[0]))); return { number: ethers.toQuantity(h.number), hash: h.hash, stateRoot: h.stateRoot, timestamp: ethers.toQuantity(h.timestamp) }; }
    if (method === "eth_call") return fixture.ctx.call(params[0]);
    if (method === "eth_getCode") return fixture.ctx.getCode(params[0]);
    if (method === "eth_getStorageAt") return fixture.ctx.getStorageAt(params[0], params[1]);
    if (method === "eth_getBalance") return fixture.ctx.getBalance(params[0]);
    if (method === "anvil_setBalance") return fixture.ctx.setBalance(params[0], params[1]);
    if (method === "anvil_impersonateAccount") { assert.ok(params[0] === m.actor || params[0] === m.fundingEoas[0]); return true; }
    if (method === "eth_sendTransaction") { const tx = await fixture.ctx.send(params[0]); receipts.set(tx.hash, tx.receipt); return tx.hash; }
    if (method === "eth_getTransactionReceipt") return receipts.get(params[0]);
    assert.fail("unapproved local RPC method " + method);
  } };
  const ctx = harness.createScenarioContext({ chainId: 1, block: { number: m.pin.number, hash: m.pin.hash }, localRpc: local, ethers: fixture.ctx.ethers,
    scenarioInput: m, limits: m.harnessLimits, deadline: Date.now() + 180000 });
  // Real clock/timer behavior; one 1-second ordinary wait, never a time warp.
  const deps = wrapper.makeHarnessDeps({ defaultDeps: () => ({}), leakGuard: () => {} }, { createLocalRpc: () => local }, m, scenario);
  deps.createLocalRpc(12345);
  await deps.loadScenario(path.join(root, wrapper.SCENARIO)).run(ctx);
  assert.equal(ctx._state.sends, 8); assert.equal(ctx._state.deployments, 0); assert.equal(ctx._state.snapshots, 0);
  assert.ok(ctx._state.calls <= 256); assert.ok(ctx._state.asserts.every(x => x.pass));
  assert.equal(state.unsafeAccess, 0); assert.equal(state.seeds.length, 2);
  assert.equal(ctx._state.observations.find(x => x.label === "historical-simulated-cash").value.grossUsdcRaw, "24927763");
  assert.equal(rpcMethods.some(method => /setCode|setStorage|increaseTime|setNextBlock|mine|sendRaw|sign/i.test(method)), false);
});
test("three-argument relay transport retains finite default Content-Length and stream limits", async () => {
  const m = input(), cap = m.harnessLimits.messageBytes, realTransport = harness.defaultDeps().transport;
  const passedCaps = [], fixtures = [], originalFetch = global.fetch;
  function fixture(declared, chunks) {
    const state = { pulls: 0, closed: false };
    return { state, response: { ok: true, headers: { get: name => { assert.equal(name, "content-length"); return declared; } },
      body: { async *[Symbol.asyncIterator]() {
        try { for (const chunk of chunks) { state.pulls++; yield chunk; } }
        finally { state.closed = true; }
      } } } };
  }
  const deps = wrapper.makeHarnessDeps({ defaultDeps: () => ({ transport: (...args) => {
    assert.ok(Number.isSafeInteger(args[3]) && args[3] > 0 && args[3] <= cap);
    passedCaps.push(args[3]); return realTransport(...args);
  } }) }, {}, m, {});
  const payload = { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] };
  const bytes = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }));
  global.fetch = async () => { assert.ok(fixtures.length, "no unmocked fetch allowed"); return fixtures.shift().response; };
  try {
    const ordinary = fixture(String(bytes.length), [bytes]); fixtures.push(ordinary);
    assert.equal((await deps.transport("inert-fixture", payload, 1000)).value.result, "0x1");
    assert.equal(ordinary.state.pulls, 1); assert.equal(ordinary.state.closed, true);

    const oversizedDeclared = fixture(String(cap + 1), [bytes]); fixtures.push(oversizedDeclared);
    await assert.rejects(deps.transport("inert-fixture", payload, 1000), /response-too-large/);
    assert.equal(oversizedDeclared.state.pulls, 0, "oversized declaration rejected before streaming");

    const oversizedStream = fixture(null, [Buffer.alloc(cap), Buffer.from("x"), Buffer.from("must-not-be-read")]); fixtures.push(oversizedStream);
    await assert.rejects(deps.transport("inert-fixture", payload, 1000), /response-too-large/);
    assert.equal(oversizedStream.state.pulls, 2, "stop at first chunk exceeding the finite cap");
    assert.equal(oversizedStream.state.closed, true);

    fixtures.push(fixture(String(bytes.length), [bytes]));
    assert.equal((await deps.transport("inert-fixture", payload, 1000, cap * 2)).value.result, "0x1");
    fixtures.push(fixture(String(bytes.length), [bytes]));
    assert.equal((await deps.transport("inert-fixture", payload, 1000, 128)).value.result, "0x1");
    assert.deepEqual(passedCaps, [cap, cap, cap, cap, 128]); assert.equal(fixtures.length, 0);
  } finally { global.fetch = originalFetch; }
  assert.equal(global.fetch, originalFetch);
});
test("typed local RPC and reverted-receipt failures preserve only allowlisted diagnostics", async () => {
  for (const [code, stage] of [["LOCAL_RPC_METHOD_FAILED", "LOCAL_RPC_eth_sendTransaction"], ["SCENARIO_TX_REVERTED", "SCENARIO"]]) {
    const error = new harness.ForkError(code, stage);
    error.message = "https://fixture.invalid/secret-marker Bearer fake-token";
    error.stack = "raw-stack-secret-marker"; error.data = { calldata: "secret-marker" };
    error.detail = "status=0x0 gasUsed=60000 reason=https://fixture.invalid/secret-marker";
    const { ctx, state } = mock({ sendError: error });
    await assert.rejects(scenario.run(ctx), /^Error: SNUSD_NORMAL_FLOW_BLOCKED$/);
    const d = state.logs.find(x => x.label === "failure-diagnostic").value;
    assert.deepEqual(Object.keys(d).sort(), ["failureCode", "errorClass", "errorStage", "stage", "substep", "sendStep", "funding",
      ...(code === "SCENARIO_TX_REVERTED" ? ["revertedReceipt"] : [])].sort());
    assert.equal(d.failureCode, code); assert.equal(d.errorClass, "FORK_ERROR_REPORTED"); assert.equal(d.errorStage, stage);
    assert.equal(d.stage, "funding-fixture"); assert.equal(d.substep, "send-entered"); assert.equal(d.sendStep, "fund");
    assert.equal(d.funding.sendEntered, true); assert.equal(d.funding.sendReturned, false); assert.equal(d.funding.receiptSeen, false);
    assert.equal(d.funding.receiptStatus, "UNKNOWN"); assert.equal(d.funding.headerReadEntered, false); assert.equal(d.funding.baselineEstablished, false);
    if (code === "SCENARIO_TX_REVERTED") assert.deepEqual(d.revertedReceipt,
      { status: "FAILURE_REPORTED", gasUsed: 60000, configuredSendGasLimit: 100000, reportedGasEqualsLimit: false });
    assert.equal(/secret-marker|fixture\.invalid|Bearer|fake-token|calldata|raw-stack/.test(JSON.stringify(d)), false);
    assert.equal(state.logs.some(x => x.label === "historical-simulated-cash"), false); assert.equal(state.sends.length, 1); assert.equal(state.unsafeAccess, 0);
  }
});
test("malformed returned receipts record TypeError and field presence without raw values", async () => {
  const returned = { receipt: { gasUsed: "secret-marker", effectiveGasPrice: "https://fixture.invalid/secret-marker", blockNumber: "0x1", blockHash: "secret-marker" } };
  const { ctx, state } = mock({ malformedReturn: returned }); await assert.rejects(scenario.run(ctx));
  const d = state.logs.find(x => x.label === "failure-diagnostic").value;
  assert.equal(d.failureCode, "UNCLASSIFIED"); assert.equal(d.errorClass, "TYPE_ERROR"); assert.equal(d.substep, "receipt-validation");
  assert.equal(d.funding.sendReturned, true); assert.equal(d.funding.receiptSeen, true); assert.equal(d.funding.receiptFields.status, false);
  assert.equal(d.funding.receiptFields.gasUsed, true); assert.equal(d.funding.receiptStatus, "UNKNOWN");
  assert.equal(d.funding.headerReadEntered, false); assert.equal(d.funding.headerReadReturned, false);
  assert.equal(/secret-marker|fixture\.invalid/.test(JSON.stringify(d)), false);
  assert.equal(state.logs.some(x => x.label === "historical-simulated-cash"), false); assert.equal(state.unsafeAccess, 0);
  const range = mock({ sendError: new RangeError("https://fixture.invalid/secret-marker") }); await assert.rejects(scenario.run(range.ctx));
  assert.equal(range.state.logs.find(x => x.label === "failure-diagnostic").value.errorClass, "RANGE_ERROR");
});
test("unknown failure properties/getters and arbitrary error stages cannot leak", () => {
  let reads = 0; const hostile = {};
  for (const key of ["code", "name", "stage", "message", "stack", "detail", "data", "body"]) Object.defineProperty(hostile, key, { get() { reads++; throw Error("secret-marker"); } });
  assert.deepEqual(scenario.safeFailure(hostile), { failureCode: "UNCLASSIFIED", errorClass: "UNCLASSIFIED", errorStage: "UNCLASSIFIED" });
  assert.equal(reads, 0);
  const arbitrary = Object.assign(new TypeError("secret-marker"), { code: "UNSAFE_CODE_https://fixture.invalid", stage: "https://fixture.invalid" });
  assert.deepEqual(scenario.safeFailure(arbitrary), { failureCode: "UNCLASSIFIED", errorClass: "TYPE_ERROR", errorStage: "UNCLASSIFIED" });
});
test("funding header-read failure distinguishes returned receipt from validated funding", async () => {
  const { ctx, state, m } = mock(), initialHeader = ctx.readBlockHeader;
  ctx.readBlockHeader = async n => {
    if (n > Number(m.pin.number)) throw new harness.ForkError("LOCAL_RPC_METHOD_FAILED", "LOCAL_RPC_eth_getBlockByNumber");
    return initialHeader(n);
  };
  await assert.rejects(scenario.run(ctx)); const d = state.logs.find(x => x.label === "failure-diagnostic").value;
  assert.equal(d.failureCode, "LOCAL_RPC_METHOD_FAILED"); assert.equal(d.substep, "receipt-header-read-entered");
  assert.equal(d.funding.sendReturned, true); assert.equal(d.funding.receiptSeen, true); assert.equal(d.funding.receiptStatus, "SUCCESS_REPORTED");
  assert.equal(d.funding.headerReadEntered, true); assert.equal(d.funding.headerReadReturned, false); assert.equal(d.funding.baselineEstablished, false);
  assert.equal(state.logs.some(x => x.label === "funding-not-profit" || x.label === "historical-simulated-cash"), false);
});
test("attempt 2..4 use distinct fixed outputs and one invocation each, without changing strict input", async () => {
  const calls = [];
  const runForkPoc = async options => { calls.push(options); return { status: "FAIL_CLOSED", blocker: "INERT_TEST" }; };
  await assert.rejects(wrapper.main(["--run"], { runForkPoc }), /OUTPUT_ALREADY_EXISTS/);
  const invalid = ["0", "1", "02", "+2", "2.0", "5", "2e0", "../2", 2, null];
  for (const value of invalid) await assert.rejects(wrapper.main(["--run", "--attempt", value], { runForkPoc, exists: () => false }));
  for (const args of [["--attempt", "2", "--run"], ["--run", "--attempt", "2", "--attempt", "3"], ["--run", "--attempt", "2", "--force"], ["--run", "--attempt", "2", "--pin", "other"]]) await assert.rejects(wrapper.main(args, { runForkPoc }));
  assert.equal(calls.length, 0);
  for (const attempt of [2, 3, 4]) {
    await assert.rejects(wrapper.main(["--run", "--attempt", String(attempt)], { runForkPoc, exists: () => true }), /OUTPUT_ALREADY_EXISTS/);
    const result = await wrapper.main(["--run", "--attempt", String(attempt)], { runForkPoc, exists: () => false });
    assert.equal(calls.length, attempt - 1); assert.equal(result.attempt, attempt); assert.equal(result.outPath, wrapper.OUTPUTS[attempt]);
    const options = calls.at(-1); assert.equal(options.outPath, path.join(root, wrapper.OUTPUTS[attempt]));
    assert.equal(options.scenarioName, "snusd-usdc-delayed-normal-20261018"); assert.equal(options.block, "26217682");
    assert.deepEqual(options.scenarioInput, input()); assert.deepEqual(options.limits, input().harnessLimits);
  }
  assert.equal(new Set(calls.map(x => x.outPath)).size, 3);
  await assert.rejects(wrapper.main(["--run", "--attempt", "2"], { runForkPoc, exists: () => false,
    readFile: file => file.endsWith(wrapper.SCENARIO.replace(/\//g, path.sep)) ? Buffer.from("changed") : fs.readFileSync(file) }), /SCENARIO_SOURCE_MISMATCH/);
  assert.equal(calls.length, 3);
});
test("attempt evidence writer has fixed path, current source hashes and exclusive creation", () => {
  const m = input(), writes = [], oldWrite = fs.writeFileSync, oldMkdir = fs.mkdirSync;
  const deps = wrapper.makeHarnessDeps({ defaultDeps: () => ({}), leakGuard: value => { assert.equal(/https?:\/\//.test(JSON.stringify(value)), false); } }, {}, m, {}, 2);
  fs.mkdirSync = () => {};
  fs.writeFileSync = (file, bytes, opts) => { writes.push({ file, value: JSON.parse(bytes), opts }); };
  try {
    assert.throws(() => deps.writeEvidence(path.join(root, wrapper.OUT), {}), /OUTPUT_PATH_REJECTED/);
    deps.writeEvidence(path.join(root, wrapper.OUTPUTS[2]), { schema: "fork-poc/v1", status: "FAIL_CLOSED" });
    assert.equal(writes.length, 1); assert.equal(writes[0].opts.flag, "wx");
    const meta = writes[0].value.operationalAttempt; assert.equal(meta.number, 2); assert.equal(meta.originalReceiptSha256, wrapper.ORIGINAL_RECEIPT_SHA);
    assert.equal(meta.sourceArchiveStatus, "PARENT_SNAPSHOT_REQUIRED_NOT_VERIFIED_BY_WRAPPER");
    assert.equal(meta.sourceFiles.length, 4); assert.equal(meta.sourceFiles.find(x => x.file === wrapper.SCENARIO).sha256, wrapper.SCENARIO_SHA);
    fs.writeFileSync = () => { const error = new Error("EXISTS"); error.code = "EEXIST"; throw error; };
    assert.throws(() => deps.writeEvidence(path.join(root, wrapper.OUTPUTS[2]), {}), { code: "EEXIST" });
  } finally { fs.writeFileSync = oldWrite; fs.mkdirSync = oldMkdir; }
  assert.equal(fs.writeFileSync, oldWrite); assert.equal(fs.mkdirSync, oldMkdir);
});
test("attempt01 source archive resolves original receipt bytes and preserves prior manifest", () => {
  const base = path.join(root, "reports/raw/fast/fork-poc/snusd-usdc-normal-source-history-20261018/attempt01");
  const index = JSON.parse(fs.readFileSync(path.join(base, "index.json")));
  assert.equal(index.attempt, 1); assert.equal(index.receiptSha256, wrapper.ORIGINAL_RECEIPT_SHA); assert.equal(index.files.length, 4);
  for (const row of index.files) assert.equal(crypto.createHash("sha256").update(fs.readFileSync(path.join(base, row.archivedFile))).digest("hex"), row.sha256);
  assert.equal(index.files.find(x => x.sourcePath === wrapper.SCENARIO).sha256, "a898d9b1ce719ed1cd456e90ff670f8182bf964f7b551853aa836147251197eb");
  const prior = fs.readFileSync(path.join(base, path.basename(wrapper.MANIFEST)), "utf8");
  assert.equal(prior.replace('"fund": 60000', '"fund": 100000'), fs.readFileSync(path.join(root, wrapper.MANIFEST), "utf8"));
});
test("fund-only operational gas experiment preserves exact snapshot financial data and caps", () => {
  const base = path.join(root, "reports/raw/fast/fork-poc/snusd-usdc-normal-source-history-20261018/attempt02");
  const index = JSON.parse(fs.readFileSync(path.join(base, "index.json"))), current = input();
  for (const row of index.files) assert.equal(crypto.createHash("sha256").update(fs.readFileSync(path.join(base, row.archivedBasename))).digest("hex"), row.sha256);
  const priorBytes = fs.readFileSync(path.join(base, path.basename(wrapper.MANIFEST)), "utf8"), prior = JSON.parse(priorBytes);
  assert.equal(prior.sendGas.fund, 60000); assert.equal(current.sendGas.fund, 100000);
  assert.equal(fs.readFileSync(path.join(root, wrapper.MANIFEST), "utf8"), priorBytes.replace('"fund": 60000', '"fund": 100000'));
  const expected = structuredClone(prior); expected.sendGas.fund = 100000; assert.deepEqual(current, expected);
  assert.equal(Object.values(current.sendGas).reduce((a, b) => a + b, 0), 1980000);
  assert.equal(Math.max(...Object.values(current.sendGas)), 650000); assert.equal(current.caps.gasUnits, 2000000);
  assert.equal(current.caps.sends, 8); assert.equal(current.principalRaw, "1200000000");
  assert.equal(BigInt(current.actorNativeFixtureWei) + BigInt(current.fundingNativeFixtureWei), 10000000000000000n);
  assert.equal(ethers.sha256(ethers.toUtf8Bytes(JSON.stringify(current))), scenario.DATA_SHA);
  assert.deepEqual(wrapper.prepare(), current);
  for (const value of [60000, 100001, 650001]) { const changed = structuredClone(current); changed.sendGas.fund = value; assert.throws(() => scenario.validateInput(changed, ethers)); }
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(path.join(root, wrapper.OUTPUTS[2]))).digest("hex"), "1aeb7de80434694f6e401bb6fba2014e15a8e307337bd5419b51434a2799e319");
  assert.equal(fs.existsSync(path.join(root, wrapper.OUTPUTS[3])), false);
  assert.equal(fs.existsSync(path.join(root, "reports/raw/fast/fork-poc/snusd-usdc-normal-source-history-20261018/attempt03")), false);
});
test("reverted helper detail accepts only bounded canonical numeric fields and fixed status", () => {
  const get = (detail, limit = 100000) => scenario.safeFailure(Object.assign(new harness.ForkError("SCENARIO_TX_REVERTED", "SCENARIO"), { detail }), limit).revertedReceipt;
  const expected = (gasUsed, equal, limit = 100000) => ({ status: "FAILURE_REPORTED", gasUsed, configuredSendGasLimit: limit, reportedGasEqualsLimit: equal });
  for (const gas of [0, 1, 60000, 100000, 2000000]) assert.deepEqual(get(`status=0x0 gasUsed=${gas}`), expected(gas, gas === 100000));
  assert.deepEqual(get("status=0x0 gasUsed=unknown"), expected(null, null));
  assert.deepEqual(get("status=0x0 gasUsed=650000", 650000), expected(650000, true, 650000));
  assert.deepEqual(get("status=0x0 gasUsed=100000", 650001), expected(100000, null, null));
  const nonRevert = Object.assign(new harness.ForkError("LOCAL_RPC_METHOD_FAILED", "SCENARIO"), { detail: "status=0x0 gasUsed=100000" });
  assert.equal(Object.hasOwn(scenario.safeFailure(nonRevert, 100000), "revertedReceipt"), false);
});
test("malformed, oversized, inherited and getter details are unknown without leaks or exceptions", () => {
  const unknown = { status: "UNKNOWN", gasUsed: null, configuredSendGasLimit: 100000, reportedGasEqualsLimit: null };
  const check = error => { const d = scenario.safeFailure(error, 100000); assert.deepEqual(d.revertedReceipt, unknown); assert.equal(/secret-marker|fixture\.invalid/.test(JSON.stringify(d)), false); };
  for (const detail of [null, 12, {}, "status=0x1 gasUsed=100000", "status=0x00 gasUsed=100000", " status=0x0 gasUsed=100000",
    "status=0x0 gasUsed=0100000", "status=0x0 gasUsed=-1", "status=0x0 gasUsed=2e5", "status=0x0 gasUsed=2000001",
    "status=0x0 gasUsed=99999999", "status=0x0 gasUsed=unknown extra=secret-marker", "status=0x0 gasUsed=100000\n",
    "status=0x0 gasUsed=100000 reason=secret-marker\nhttps://fixture.invalid", "status=0x0 gasUsed=100000 reason=" + "x".repeat(513)]) {
    check(Object.assign(new harness.ForkError("SCENARIO_TX_REVERTED", "SCENARIO"), { detail }));
  }
  let reads = 0; const getter = new harness.ForkError("SCENARIO_TX_REVERTED", "SCENARIO");
  Object.defineProperty(getter, "detail", { get() { reads++; throw new Error("secret-marker"); } }); check(getter); assert.equal(reads, 0);
  const inherited = Object.create({ detail: "status=0x0 gasUsed=100000" }); inherited.code = "SCENARIO_TX_REVERTED"; check(inherited);
  const value = { toString() { throw new Error("secret-marker"); } };
  check(Object.assign(new harness.ForkError("SCENARIO_TX_REVERTED", "SCENARIO"), { detail: value }));
});
test("reverted numeric reports never imply zero actual cost, successful funding or profit", async () => {
  for (const gasUsed of ["0", "100000", "unknown"]) {
    const error = new harness.ForkError("SCENARIO_TX_REVERTED", "SCENARIO");
    error.detail = `status=0x0 gasUsed=${gasUsed} reason=https://fixture.invalid/secret-marker Bearer fake-token calldata=secret-marker`;
    const { ctx, state } = mock({ sendError: error }); await assert.rejects(scenario.run(ctx), /^Error: SNUSD_NORMAL_FLOW_BLOCKED$/);
    const d = state.logs.find(x => x.label === "failure-diagnostic").value;
    assert.equal(d.revertedReceipt.status, "FAILURE_REPORTED"); assert.equal(d.revertedReceipt.configuredSendGasLimit, 100000);
    assert.equal(d.revertedReceipt.reportedGasEqualsLimit, gasUsed === "unknown" ? null : gasUsed === "100000");
    assert.equal(d.funding.sendReturned, false); assert.equal(d.funding.baselineEstablished, false);
    assert.equal(state.sends[0].gas, 100000n); assert.equal(state.sends.length, 1); assert.equal(state.unsafeAccess, 0);
    assert.equal(state.asserts.some(x => x.pass), false);
    assert.equal(state.logs.some(x => ["receipt", "funding-not-profit", "historical-simulated-cash", "separate-cost-stress"].includes(x.label)), false);
    assert.equal(/secret-marker|fixture\.invalid|Bearer|fake-token|calldata/.test(JSON.stringify(state.logs, (_, v) => typeof v === "bigint" ? v.toString() : v)), false);
    assert.equal(Object.hasOwn(d.revertedReceipt, "gasCostWei"), false);
  }
});
