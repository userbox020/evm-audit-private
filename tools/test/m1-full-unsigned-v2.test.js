"use strict";

// OFFLINE ONLY. Synthetic scheduling is not a measurement of RPC/node latency.
// Every successful case stops by throwing at the injected signer boundary. No
// signed bytes, key loader, production journal, receipt, or relay is involved.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { Interface, Transaction } = require("../node_modules/ethers");
const originalTransactionParser = Transaction.from;
const { readEvidence, batch, PUBLIC_CODE, W, hex, hash, transfer, emitted } = require("./m1-live-evidence.test.js");
assert.equal(Transaction.from, originalTransactionParser, "Importing public fixture data must not install signer mocks");
const runner = require("../execute-top-whale-trigger.js"), transport = require("../lib/executor-pinned-rpc.js");
const m1 = require("../lib/m1-live-evidence.js"), guard = require("../lib/wallet-execution-guard.js");
const next = require("../lib/next-block-execution.js"), simulation = require("../lib/next-block-simulation.js");
const { FEED_IFACE, MULTICALL_IFACE } = require("../execute-aave-v4-near-liquidation.js");

// main owns detection before acquisition and preserves its private budget through
// continuation. Its idle clock remains monotonic; never patch the global clock.
const INTEGRATION = Object.freeze({
  factoryOptions: Object.freeze({ qualificationMode: "capability-v1" }),
  mainClocks: clock => ({ wallNow: clock.wall, monotonicNow: clock.mono, now: clock.mono }),
});

const TEMP_BASE = path.resolve("C:/Users/MiPC/AppData/Local/Temp/opencode");
const PARENT_TIME = Date.parse("2026-10-24T02:00:00Z") / 1000, HEAD = 1000;
const UNKNOWN = "0x" + "f".repeat(64), PRICE = 10n ** 36n, VIRTUAL = 1000000n;
const MAX_SEIZE = 108500n * W, COLLATERAL = 125000n * W, BORROW_SHARES = 107500n * W * VIRTUAL;
const STOP = "OFFLINE_UNSIGNED_SIGNER_TRAP";
const RATE = new Interface(["function borrowRateView((address,address,address,address,uint256),(uint128,uint128,uint128,uint128,uint128,uint128)) view returns(uint256)"]);
const FLAGS = ["--execute", "--no-write", "--m1-only", "--m1-hot-path-v2", "--m1-capability-v1"];
const turn = () => new Promise(resolve => setImmediate(resolve));
const serialize = value => JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item);
const digest = value => crypto.createHash("sha256").update(serialize(value)).digest("hex");
const ceil = (a, b) => (a + b - 1n) / b;

// Event-time scheduler: concurrent requests overlap; RTT is NOT added once per
// request. Microtasks drain between completion waves before the next jump. Wall
// and monotonic clocks always advance together, including idle readiness waits.
function syntheticClock(initialWall = PARENT_TIME * 1000 + 1000) {
  let tick = 0, ordinal = 0, scheduled = null, closed = false;
  const queue = [], waves = [];
  function pump() {
    if (scheduled || closed || queue.length === 0) return;
    scheduled = setImmediate(() => {
      scheduled = null;
      if (closed || queue.length === 0) return;
      queue.sort((a, b) => a.due - b.due || a.ordinal - b.ordinal);
      tick = Math.max(tick, queue[0].due);
      const completed = queue.splice(0, queue.findIndex(row => row.due > tick) < 0 ? queue.length : queue.findIndex(row => row.due > tick));
      waves.push({ at: tick, labels: completed.map(row => row.label) });
      for (const row of completed) row.resolve();
      pump();
    });
  }
  return {
    wall: () => initialWall + tick, mono: () => tick, waves,
    wait(ms, label = "idle") {
      assert.ok(!closed && Number.isSafeInteger(ms) && ms > 0, "Every simulated RTT/wait is positive and bounded");
      const result = new Promise(resolve => queue.push({ due: tick + ms, ordinal: ordinal++, resolve, label }));
      pump(); return result;
    },
    jumpTo(value) {
      assert.equal(queue.length, 0, "Only an idle clock may jump to an expiry/detection boundary");
      assert.ok(Number.isSafeInteger(value) && value >= tick); tick = value;
    },
    close() {
      closed = true; clearImmediate(scheduled); scheduled = null;
      // Cleanup releases test-owned waits so the real factory can drain them.
      for (const row of queue.splice(0)) row.resolve();
    },
    get pending() { return queue.length; },
  };
}

function ownedDirectories() {
  assert.equal(process.platform, "win32", "This workspace's approved temporary root is Windows-only");
  const root = fs.mkdtempSync(path.join(TEMP_BASE, "m1-full-unsigned-v2-"));
  const lockRoot = path.join(root, "locks"), journalDir = path.join(root, "journal");
  function removeOwned() {
    assert.equal(path.dirname(root), TEMP_BASE);
    assert.match(path.basename(root), /^m1-full-unsigned-v2-/);
    const inspected = [];
    function inspect(directory) {
      assert.equal(fs.lstatSync(directory).isSymbolicLink(), false);
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name), relative = path.relative(root, file);
        assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
        assert.equal(entry.isSymbolicLink(), false);
        assert.ok(["locks", "journal"].includes(relative.split(path.sep)[0]), "Only this fixture's lock/journal tree is removable");
        inspected.push(relative);
        if (entry.isDirectory()) inspect(file); else assert.ok(entry.isFile());
      }
    }
    inspect(root); // Inspect the exact owned set before recursive deletion.
    fs.rmSync(root, { recursive: true, force: false });
    return inspected;
  }
  return { root, lockRoot, journalDir, receiptWaitMs: 0, removeOwned };
}

function blockHeader(number = HEAD) {
  assert.ok([HEAD - 1, HEAD].includes(number), "No unmodeled chain history");
  return { number: hex(number), hash: hash(number), parentHash: hash(number - 1), stateRoot: hash(77 + number),
    timestamp: hex(PARENT_TIME + (number - HEAD) * 12), baseFeePerGas: hex(100000000), gasLimit: hex(30000000) };
}

function createRawFixture(clock, dirs, options = {}) {
  const future = options.future === true;
  const candidates = Object.freeze(["alchemy", "quicknode"].map((family, i) => Object.freeze({ family, handle: `OFFLINE_OPAQUE_${i}` })));
  const state = { calls: [], assertions: [], inFlight: 0, peak: 0, sends: 0, receipts: 0, secondarySends: 0, network: 0,
    traps: [], outputs: [], acquisitions: [], leases: [], passes: [], reads: [], prewarming: true, prewarmEnd: null,
    detection: null, currentDone: null, continuationDone: null, afterCompletion: false, publication: null,
    futureUnknown: [false, false], finalTailUsed: false, runtimeTailUsed: false, completionOrder: [] };
  let releasePublication;
  const publicationGate = new Promise(resolve => { releasePublication = resolve; });
  const market = (child = false) => [2000000n * W, 2000000n * W * VIRTUAL,
    !future || child ? 1000000n * W + W : 1000000n * W - 1n,
    1000000n * W * VIRTUAL - VIRTUAL, BigInt(PARENT_TIME + (child ? 12 : 0)), 0n];
  const position = () => [0n, state.afterCompletion ? 0n : BORROW_SHARES, state.afterCompletion ? 0n : COLLATERAL];

  function aggregate(tx, specs) {
    const calls = m1.MULTI_IFACE.decodeFunctionData("aggregate3", tx.input || tx.data)[0];
    assert.equal(calls.length, specs.length);
    const rows = calls.map((call, index) => {
      const [target, iface, method, args, values, allowFailure] = specs[index];
      assert.equal(call.target.toLowerCase(), target);
      assert.equal(call.allowFailure, allowFailure);
      assert.equal(call.callData.toLowerCase(), iface.encodeFunctionData(method, args).toLowerCase());
      return { success: true, returnData: iface.encodeFunctionResult(method, values) };
    });
    return m1.MULTI_IFACE.encodeFunctionResult("aggregate3", [rows]);
  }
  function collectorRows(tx) {
    const calls = m1.MULTI_IFACE.decodeFunctionData("aggregate3", tx.input || tx.data)[0];
    if (calls.length === 1) return aggregate(tx, [[m1.MP.irm, RATE, "borrowRateView", [Object.values(m1.MP), market()], [100000000000n], true]]);
    return aggregate(tx, [
      [m1.MORPHO, m1.STATE_IFACE, "market", [m1.MARKET], market(), true],
      [m1.MORPHO, m1.STATE_IFACE, "position", [m1.MARKET, m1.BORROWER], position(), true],
      [m1.MP.oracle, m1.STATE_IFACE, "price", [], [PRICE], true],
    ]);
  }
  function rowsForState(tx, child) {
    return aggregate(tx, [
      ...[m1.USDE, m1.DAI, m1.USDC].map(token => [token, m1.STATE_IFACE, "balanceOf", [m1.EXECUTOR], [0n], false]),
      [m1.MORPHO, m1.STATE_IFACE, "accrueInterest", [m1.MP], [], false],
      [m1.MORPHO, m1.STATE_IFACE, "market", [m1.MARKET], market(child), false],
      [m1.MORPHO, m1.STATE_IFACE, "position", [m1.MARKET, m1.BORROWER], position(), false],
      [m1.MP.oracle, m1.STATE_IFACE, "price", [], [PRICE], false],
    ]);
  }
  function feedRows(tx, child) {
    const specs = [];
    for (const [name, value] of [["eth", 321000000000n], ["dai", 99700000n]]) {
      const feed = next.FEEDS[name], stamp = BigInt(PARENT_TIME + (child ? 12 : 0) - 10);
      for (const [method, values] of [["decimals", [8]], ["description", [feed.description]], ["latestRoundData", [1n, value, stamp, stamp, 1n]]])
        specs.push([feed.address, FEED_IFACE, method, [], values, false]);
    }
    return aggregate(tx, specs);
  }
  // Independent integer fixture math, not a replacement for production readState,
  // sizing, repayment, netProof, or settlement verification.
  function repaymentFor(seized, child) {
    const totals = market(child), lif = W * W / (W - 300000000000000000n * (W - m1.MP.lltv) / W);
    const shares = ceil(ceil(ceil(seized * PRICE, PRICE) * W, lif) * (totals[3] + VIRTUAL), totals[2] + 1n);
    assert.ok(shares > 0n && shares <= BORROW_SHARES && seized <= COLLATERAL);
    return { shares, assets: ceil(shares * (totals[2] + 1n), totals[3] + VIRTUAL) };
  }
  function quoteFor(seized, child) {
    if (options.tie) return (repaymentFor(seized, child).assets + 5n * W) * 10000n / 9950n;
    return 108000n * W * seized / MAX_SEIZE;
  }
  function logsFor(tx) {
    const decoded = m1.EXEC_IFACE.decodeFunctionData("execute", tx.input || tx.data), seized = decoded[2];
    const repaid = repaymentFor(seized, true), output = quoteFor(seized, true), gain = output - repaid.assets;
    assert.ok(output >= decoded[5] && gain >= decoded[4]);
    assert.ok(seized < COLLATERAL, "This bounded fixture has no bad-debt/full-collateral branch");
    return [transfer(m1.DAI, m1.VAULT, m1.EXECUTOR, 0n),
      emitted("Liquidate", m1.MORPHO, [m1.MARKET, m1.EXECUTOR, m1.BORROWER, repaid.assets, repaid.shares, seized, 0n, 0n]),
      transfer(m1.USDE, m1.MORPHO, m1.EXECUTOR, seized), transfer(m1.USDE, m1.EXECUTOR, m1.FIRST_POOL, seized),
      transfer(m1.DAI, m1.LAST_POOL, m1.EXECUTOR, output), transfer(m1.DAI, m1.EXECUTOR, m1.MORPHO, repaid.assets),
      transfer(m1.DAI, m1.EXECUTOR, m1.VAULT, 0n), transfer(m1.DAI, m1.EXECUTOR, guard.MAIN_ACCOUNT, gain),
      emitted("FlashLoan", m1.VAULT, [m1.EXECUTOR, m1.DAI, 0n, 0n])];
  }
  function callKind(tx) {
    const to = tx.to === null ? null : tx.to?.toLowerCase(), data = tx.input || tx.data;
    if (to === null && data === simulation.PROBE_INITCODE) return "childControl";
    if (to === transport.MULTICALL3 && data === transport.PROBE.encodeFunctionData("getBlockNumber")) return "numberControl";
    if (to === transport.MULTICALL3) {
      const count = MULTICALL_IFACE.decodeFunctionData("aggregate3", data)[0].length;
      const kinds = { 1: "collectorRate", 3: "collectorState", 6: "feeds", 7: "accruedState" };
      assert.ok(kinds[count], "Only exact collector/state/feed aggregate shapes are modeled"); return kinds[count];
    }
    if (to === m1.QUOTER) return "quote";
    assert.equal(to, m1.EXECUTOR, "No unmodeled transaction target"); return "exact";
  }
  function response(tx, child) {
    const kind = callKind(tx);
    if (kind === "collectorState" || kind === "collectorRate") { assert.equal(child, false); return collectorRows(tx); }
    if (kind === "accruedState") return rowsForState(tx, child);
    if (kind === "feeds") return feedRows(tx, child);
    if (kind === "quote") {
      const [route, seized] = m1.QUOTE_IFACE.decodeFunctionData("quoteExactInput", tx.input || tx.data);
      assert.equal(route, m1.ROUTE); assert.ok([MAX_SEIZE, MAX_SEIZE / 2n, MAX_SEIZE / 4n].includes(seized));
      return m1.QUOTE_IFACE.encodeFunctionResult("quoteExactInput", [quoteFor(seized, child), [1, 1], [1, 1], 100000]);
    }
    assert.equal(kind, "exact");
    const decoded = m1.EXEC_IFACE.decodeFunctionData("execute", tx.input || tx.data);
    assert.equal(m1.EXEC_IFACE.encodeFunctionData("execute", decoded), tx.input || tx.data);
    if (options.fatalExact && decoded[2] === MAX_SEIZE) throw new guard.ExecutionError(child ? "NEXT_BLOCK_REVERTED" : "CALL_REVERTED");
    return "0x";
  }
  const isPrepared = () => fs.existsSync(dirs.journalDir) && fs.readdirSync(dirs.journalDir).some(name => name.endsWith(".json"));
  function pinnedRef(ref, allowUnknown = false) {
    assert.deepEqual(Object.keys(ref).sort(), ["blockHash", "requireCanonical"]);
    assert.equal(ref.requireCanonical, true);
    assert.ok([hash(HEAD), hash(HEAD - 1), ...(allowUnknown ? [UNKNOWN] : [])].includes(ref.blockHash));
  }
  function describe(method, params) {
    const tx = method === "eth_simulateV1" ? params[0].blockStateCalls[0].calls[0] : params[0];
    const kind = ["eth_call", "eth_estimateGas", "eth_simulateV1"].includes(method) ? callKind(tx) : method;
    return { kind, ...(kind === "exact" ? { seized: m1.EXEC_IFACE.decodeFunctionData("execute", tx.input || tx.data)[2].toString() } : {}),
      ...(kind === "quote" ? { seized: m1.QUOTE_IFACE.decodeFunctionData("quoteExactInput", tx.input || tx.data)[1].toString() } : {}) };
  }
  function latency(row) {
    let ms = row.alias ? 11 : 7;
    // Let fresh FUTURE controls reach publication while CURRENT still owns the
    // collector. The selected publication response is then held by the gate.
    if (future && row.kind === "collectorRate" && state.currentDone === null) ms += 80;
    if (row.kind === "quote") ms += row.seized === MAX_SEIZE.toString() ? 39 : 5;
    // The half-size exact branch completes before the first branch. The third
    // may start when that worker frees up; reduction must still be 100/50/25.
    if (row.kind === "exact" && row.seized === MAX_SEIZE.toString()) ms += options.fatalExact ? 12 : 180;
    if (row.kind === "exact" && row.seized === (MAX_SEIZE / 2n).toString() && options.fatalExact) ms += 240;
    if (!state.prewarming && row.alias === 1 && options.aggregateTail && row.method === "eth_getCode" && row.params[0] === m1.EXECUTOR && !state.runtimeTailUsed) {
      state.runtimeTailUsed = true; ms = 3400;
    }
    if (row.alias === 1 && row.method === "eth_getBlockByNumber" && isPrepared() && !state.finalTailUsed) {
      if (options.aggregateTail) { state.finalTailUsed = true; ms = 3200; }
      if (options.reserveTail) {
        state.finalTailUsed = true; ms = Math.max(ms, (PARENT_TIME + 12) * 1000 - 1999 - clock.wall());
        assert.ok(ms > 0 && ms < 4000, "Reserve case is a sub-timeout tail, not an RPC timeout");
      }
    }
    return ms;
  }
  async function rpc(candidate, method, params, timeout, dispatchGuard) {
    const alias = candidates.findIndex(row => row.handle === candidate.handle && row.family === candidate.family);
    assert.ok(alias >= 0, "Only the two opaque independent fixture families are available");
    const row = { alias, method, params: structuredClone(params), started: clock.mono(), prewarming: state.prewarming, ...describe(method, params) };
    state.calls.push(row); state.peak = Math.max(state.peak, ++state.inFlight);
    try {
      assert.ok(timeout > 0 && timeout <= 4000);
      assert.equal(typeof dispatchGuard, "function", "Capability-mode raw RPC must carry its physical admission guard");
      dispatchGuard({ handle: candidate.handle, origin: null, fetch: state.fetchIdentity });
      const slowTag = options.slowRead === "latest" ? "latest" : hex(HEAD);
      if (future && !state.prewarming && state.leases.length === 1 && alias === 1 && state.futureUnknown[1] &&
          method === "eth_getBlockByNumber" && params[0] === slowTag && state.currentDone === null && !state.publication) {
        state.publication = row; await publicationGate;
      }
      await clock.wait(latency(row), `${alias}:${method}:${row.kind}`);
      dispatchGuard({ handle: candidate.handle, origin: null, fetch: state.fetchIdentity });
      let value;
      if (method === "eth_chainId") { assert.deepEqual(params, []); value = "0x1"; }
      else if (method === "eth_getBlockByNumber") {
        assert.equal(params.length, 2); assert.equal(params[1], false);
        value = blockHeader(params[0] === "latest" ? HEAD : Number(BigInt(params[0])));
        if (options.disagreement && !state.prewarming && alias === 1 && params[0] === hex(HEAD)) value.stateRoot = hash(99999);
      } else if (["eth_call", "eth_getCode", "eth_simulateV1"].includes(method)) {
        assert.equal(params.length, 2); pinnedRef(params[1], true);
        if (params[1].blockHash === UNKNOWN && options.ignoreUnknown !== method) {
          if (method === "eth_simulateV1") state.futureUnknown[alias] = true;
          throw new guard.ExecutionError("UNKNOWN_BLOCK_REJECTED");
        }
        if (method === "eth_getCode") {
          assert.ok([transport.MULTICALL3, m1.EXECUTOR].includes(params[0]));
          value = params[0] === m1.EXECUTOR ? PUBLIC_CODE : "0x600160005260206000f3";
        } else if (method === "eth_call") {
          if (row.kind === "numberControl") value = hash(params[1].blockHash === UNKNOWN ? HEAD : BigInt(params[1].blockHash));
          else { assert.equal(params[1].blockHash, hash(HEAD)); value = response(params[0], false); }
        } else {
          simulation.validateNextBlockParams(params);
          const block = params[0].blockStateCalls[0], tx = block.calls[0], control = row.kind === "childControl";
          assert.deepEqual(tx, simulation.normalizeSimulationTransaction(tx));
          assert.equal(tx.nonce, "0x7"); assert.equal(tx.from, guard.MAIN_ACCOUNT);
          assert.equal(block.blockOverrides.number, hex(HEAD + 1));
          assert.ok([hex(PARENT_TIME + 12), hex(PARENT_TIME + 24)].includes(block.blockOverrides.time));
          if (!control) assert.equal(block.blockOverrides.time, hex(PARENT_TIME + 12));
          const time = options.ignoreTime && control ? hex(PARENT_TIME + 12) : block.blockOverrides.time;
          value = [{ parentHash: params[1].blockHash, number: block.blockOverrides.number, timestamp: time,
            transactions: [structuredClone(tx)], calls: [{ status: "0x1", gasUsed: hex(control ? 80000 : 900000),
              returnData: control ? hash(HEAD + 1) + hash(BigInt(time)).slice(2) : response(tx, true),
              logs: row.kind === "exact" ? logsFor(tx) : [] }] }];
        }
      } else if (method === "eth_getTransactionCount" || method === "eth_getBalance") {
        assert.equal(params.length, 2); assert.equal(params[0], guard.MAIN_ACCOUNT);
        if (params[1] === "pending") assert.equal(method, "eth_getTransactionCount"); else { pinnedRef(params[1]); assert.equal(params[1].blockHash, hash(HEAD)); }
        value = method === "eth_getBalance" ? hex(2000000000000000n) : "0x7";
      } else if (method === "eth_estimateGas") {
        assert.equal(params.length, 2); pinnedRef(params[1]); assert.equal(params[1].blockHash, hash(HEAD));
        assert.equal(row.kind, "exact"); assert.deepEqual(params[0], simulation.normalizeSimulationTransaction(params[0])); value = hex(1000000);
      } else if (method === "eth_sendRawTransaction") { state.sends++; assert.fail("OFFLINE_SEND_FORBIDDEN"); }
      else if (method === "eth_getTransactionReceipt") { state.receipts++; assert.fail("OFFLINE_RECEIPT_FORBIDDEN"); }
      else assert.fail(`Unmodeled RPC method: ${method}`);
      row.completed = clock.mono(); row.result = structuredClone(value);
      if (row.kind === "exact") state.completionOrder.push(row);
      return value;
    } catch (error) {
      row.completed = clock.mono(); row.error = error.code;
      if (error.code === "ERR_ASSERTION") state.assertions.push(error);
      throw error;
    } finally { state.inFlight--; }
  }
  return { candidates, state, rpc, releasePublication, market, rowsForState, feedRows, logsFor, repaymentFor };
}

async function createHarness(t, options = {}, integration = INTEGRATION) {
  const dirs = ownedDirectories(), clock = syntheticClock(PARENT_TIME * 1000 + (options.reserveTail ? 7000 : 1000));
  const raw = createRawFixture(clock, dirs, options), { state } = raw;
  let factory, closed = false;
  const forbidden = () => { state.network++; assert.fail("OFFLINE_NETWORK_FORBIDDEN"); };
  t.mock.method(globalThis, "fetch", forbidden);
  state.fetchIdentity = forbidden;
  const configuration = Object.freeze({}), inventoryRevision = Symbol("offline-fixed-inventory");
  const resolveOrigin = handle => { assert.ok(raw.candidates.some(candidate => candidate.handle === handle)); return null; };
  const cleanup = async () => {
    if (closed) return; closed = true;
    raw.releasePublication(); clock.close();
    try { await factory?.close(); assert.equal(state.inFlight, 0, "Drain every started raw request before deleting the owned tree"); }
    finally { dirs.removeOwned(); }
  };
  t.after(cleanup);
  factory = transport.createM1HotPathFactory({ ...integration.factoryOptions, rpc: raw.rpc,
    now: clock.wall, monotonic: clock.mono, allowFuture: options.future === true, resolveOrigin,
    getCapabilityContext: () => ({ rpc: raw.rpc, fetch: forbidden, configuration, inventoryRevision }) });
  const factoryView = Object.freeze({
    maintain: factory.maintain,
    acquire: async input => {
      if (state.acquisitions.length === 0) assert.equal(state.detection, clock.mono());
      else if (options.future && !options.ignoreTime && !options.ignoreUnknown && !options.disagreement)
        assert.notEqual(state.continuationDone, null, "No reacquisition may overlap the retained continuation");
      const event = { started: clock.mono() }; state.acquisitions.push(event);
      const lease = await factory.acquire(input); event.completed = clock.mono(); state.leases.push(lease); return lease;
    },
    close: factory.close,
  });
  async function prewarm(expected = "READY") {
    let status = factory.maintain({ candidates: raw.candidates });
    for (let i = 0; status.refreshing && i < 2000; i++) { await turn(); status = factory.maintain({ candidates: raw.candidates }); }
    assert.equal(status.refreshing, false, "Bounded prewarm must finish before detection/acquisition");
    assert.equal(status.selection, expected);
    assert.equal(state.inFlight, 0); state.prewarming = false; state.prewarmEnd = clock.mono();
    assert.ok(state.prewarmEnd > 0); return status;
  }
  function signerTrap(transaction) {
    const arrived = { at: clock.mono(), wall: clock.wall(), transaction };
    state.traps.push(arrived); // Arrival is recorded even if an invariant fails.
    try {
      assert.ok(Object.isFrozen(transaction)); assert.ok(Object.isFrozen(transaction.accessList));
      assert.equal(fs.readdirSync(dirs.lockRoot).length, 1);
      const journals = guard.readJournals(dirs.journalDir); assert.equal(journals.length, 1);
      const record = journals[0].record, proof = record.intent.m1LiveProof;
      assert.equal(record.stage, "PREPARED"); assert.equal(record.txHash, null);
      assert.equal(proof.mode, options.future ? "NEXT_BLOCK_PASSIVE" : "CURRENT");
      assert.deepEqual(simulation.normalizeSimulationTransaction({ ...transaction, from: guard.MAIN_ACCOUNT }), proof.transaction);
      assert.equal(record.intent.m1LiveProofSha256, digest(proof));
      assert.equal(transaction.nonce, 7); assert.equal(transaction.value, 0n);
      assert.equal(transaction.to, m1.EXECUTOR); assert.equal(transaction.chainId, 1);
      assert.ok(transaction.gasLimit > 0n && transaction.gasLimit <= 1500000n);
      assert.ok(transaction.maxFeePerGas > 0n && transaction.maxPriorityFeePerGas > 0n);
      assert.ok(transaction.gasLimit * transaction.maxFeePerGas <= 2000000000000000n);
      assert.ok(BigInt(proof.economics.netTokenRaw) > 0n);
      assert.ok(BigInt(proof.economics.conservativeProfitBeforeGasWei) > transaction.gasLimit * transaction.maxFeePerGas);
      assert.equal(BigInt(proof.economics.netTokenRaw), BigInt(proof.economics.conservativeGrossRaw) - BigInt(proof.economics.uncertaintyHaircutRaw) -
        BigInt(proof.economics.additionalReserveRaw) - BigInt(proof.economics.gasCostTokenRaw));
      assert.ok(BigInt(proof.accruedState.debt) > BigInt(proof.accruedState.maxBorrow));
      assert.equal(proof.accruedState.timestamp, PARENT_TIME + (options.future ? 12 : 0));
      assert.deepEqual(proof.accruedState.zeroInventory, { USDe: "0", DAI: "0", USDC: "0" });
      assert.equal(proof.source.proofSha256, m1.PROOF_SHA256);
      assert.equal(proof.source.originalRuntimeSha256, m1.RUNTIME_SHA256);
      assert.equal(proof.context.pin.hash, state.leases[0].current.pin.hash);
      assert.deepEqual(proof.context.aliases, state.leases[0].current.evidence.aliases);
      assert.ok(BigInt(proof.selectedSeizedRaw) > 0n && BigInt(proof.selectedSeizedRaw) <= MAX_SEIZE);
      assert.ok(BigInt(record.intent.minProfitBeforeGasRaw) >= 5n * W);
      assert.ok(BigInt(proof.quote.minOutputRaw) > 0n && BigInt(proof.quote.minOutputRaw) <= BigInt(proof.quote.outputRaw));
      assert.ok(BigInt(proof.quote.minOutputRaw) * 10000n >= BigInt(proof.quote.outputRaw) * 9950n);
      assert.ok(arrived.at - state.detection > 0 && arrived.at - state.detection <= 6000, "Original detection-to-trap budget includes every phase");
      if (options.future) {
        assert.equal(BigInt(proof.parentState.debt), BigInt(proof.parentState.maxBorrow));
        assert.deepEqual(proof.settlement.zeroResidual, { USDe: "0", DAI: "0", USDC: "0" });
        assert.equal(proof.finalSimulation.context.parentHash, hash(HEAD));
        assert.equal(proof.finalSimulation.context.number, HEAD + 1);
        assert.equal(proof.finalSimulation.context.timestamp, PARENT_TIME + 12);
        assert.deepEqual(proof.finalSimulation.context.transaction, proof.transaction);
        assert.ok((PARENT_TIME + 12) * 1000 - arrived.wall >= 2000, "Child inclusion reserve is checked at the actual signer boundary");
      }
      arrived.record = record;
    } catch (error) { state.assertions.push(error); }
    // Always the same genuine ExecutionError, before any key access or signing.
    throw new guard.ExecutionError(STOP);
  }
  async function run() {
    assert.notEqual(state.prewarmEnd, null); state.detection = clock.mono(); state.detectionWall = clock.wall();
    const argv = [...FLAGS, ...(options.future ? ["--next-block"] : []), "--watch", "5", "--max-runs", options.future ? "2" : "1"];
    try {
      await runner.main(argv, {
        ...integration.mainClocks(clock), loadCandidates: () => raw.candidates, loadBatch: () => batch(0),
        connect: config => runner.connectForPass(config),
        createM1HotPathFactory: profile => {
          assert.equal(profile.allowFuture, options.future === true);
          for (const [key, value] of Object.entries(integration.factoryOptions)) assert.deepEqual(profile[key], value);
          return factoryView;
        },
        // This wrapper only supplies dependencies and forwards to production.
        // No checkOnce override: production watcher.checkOnce owns both passes.
        runPass: args => {
          state.passes.push({ at: clock.mono(), pin: args.pinned.pin, lease: args.hotPathLease, budget: args.m1Budget });
          return runner.runPass({ ...args, batch: batch(0), morphoBatch: batch(1), now: clock.wall,
            m1ReadFile: file => { state.reads.push(file); return readEvidence(file); }, amendmentReadFile: readEvidence,
            executionOptions: { lockRoot: dirs.lockRoot, journalDir: dirs.journalDir, receiptWaitMs: 0 },
            signTransaction: signerTrap, secondarySendRawTransaction: () => { state.secondarySends++; assert.fail("OFFLINE_SECONDARY_SEND_FORBIDDEN"); } });
        },
        liveHeadNumber: async () => { await clock.wait(5, "head-poll"); return HEAD + (state.afterCompletion ? 1 : 0); },
        sleep: ms => clock.wait(Math.max(1, Math.ceil(ms)), "readiness-wait"),
        output: summary => {
          state.outputs.push({ at: clock.mono(), summary });
          if (summary.run === 1 && summary.passPhase === "CURRENT") {
            state.currentDone = clock.mono();
            // Publication stays withheld until this actual CURRENT output.
            raw.releasePublication();
          }
          if (summary.passPhase === "FUTURE_CONTINUATION") {
            state.continuationDone = clock.mono(); state.afterCompletion = true;
          }
          if (summary.run === 1 && !options.future) state.afterCompletion = true;
        },
      });
      if (state.assertions.length) throw state.assertions[0];
      assert.equal(state.sends, 0); assert.equal(state.receipts, 0); assert.equal(state.secondarySends, 0); assert.equal(state.network, 0);
      assert.equal(Transaction.from, originalTransactionParser);
      assert.equal(state.inFlight, 0);
      if (fs.existsSync(dirs.lockRoot)) assert.deepEqual(fs.readdirSync(dirs.lockRoot), [], "Wallet lock is released after the throwing signer or unsigned rejection");
      return state;
    } finally { raw.releasePublication(); }
  }
  return { ...raw, dirs, clock, factory, prewarm, run, cleanup };
}

function assertPrepared(f) {
  const { state } = f;
  assert.equal(state.traps.length, 1);
  const record = guard.readJournals(f.dirs.journalDir)[0].record;
  assert.equal(record.stage, "PREPARED"); assert.equal(record.txHash, null);
  assert.notEqual(record.stage, "ABORTED_UNSIGNED");
  assert.ok(state.outputs.some(row => row.summary.preflightFailures?.some(failure => failure.reason === STOP)));
  const proof = record.intent.m1LiveProof;
  const summary = state.outputs.find(row => row.summary.preflightFailures?.some(failure => failure.reason === STOP)).summary;
  const budget = summary.m1Budget, arrived = state.traps[0];
  assert.equal(budget.detectionWallMs, state.detectionWall);
  assert.equal(budget.detectionMonoMs, state.detection);
  assert.equal(budget.unsignedReadyWallMs, arrived.wall);
  assert.equal(budget.unsignedReadyMonoMs, arrived.at);
  assert.equal(budget.fullUnsignedElapsedMs, arrived.at - state.detection);
  assert.ok(budget.fullUnsignedElapsedMs > 0 && budget.fullUnsignedElapsedMs <= 6000);
  assert.equal(budget.unsignedReadyChildHeadroomMs, (PARENT_TIME + 12) * 1000 - arrived.wall);
  assert.ok(budget.unsignedReadyChildHeadroomMs >= 2000);
  assert.deepEqual(state.passes[0].budget.snapshot(), budget, "The actual main-owned budget reaches the actual runPass unchanged");
  assert.deepEqual(proof.evaluatedVariants.map(row => row.seizedRaw), [MAX_SEIZE, MAX_SEIZE / 2n, MAX_SEIZE / 4n].map(String));
  assert.deepEqual(proof.evaluatedVariants.map(row => row.status), ["VERIFIED", "VERIFIED", "VERIFIED"]);
  assert.equal(proof.selectedSeizedRaw, MAX_SEIZE.toString());
  return proof;
}

function assertFreshWaves(f, future) {
  const { state } = f, firstEnd = state.traps[0].at;
  const calls = state.calls.filter(row => !row.prewarming && row.started <= firstEnd);
  for (const alias of [0, 1]) {
    const rows = calls.filter(row => row.alias === alias);
    const warmed = state.calls.filter(row => row.alias === alias && row.prewarming);
    for (const method of ["eth_call", "eth_getCode"])
      assert.ok(warmed.some(row => row.method === method && row.params[1]?.blockHash === UNKNOWN && row.error === "UNKNOWN_BLOCK_REJECTED"),
        `Real strict unknown-hash control was performed before detection: ${method}/${alias}`);
    for (const method of ["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_getTransactionCount"])
      assert.ok(rows.some(row => row.method === method), `Fresh ${method} witness ${alias}`);
    assert.ok(rows.some(row => row.kind === "numberControl" && row.params[1].blockHash === hash(HEAD)));
    assert.ok(rows.some(row => row.method === "eth_getBlockByNumber" && row.params[0] === "latest"));
    assert.ok(rows.some(row => row.method === "eth_getBlockByNumber" && row.params[0] === hex(HEAD)));
    assert.equal(rows.filter(row => row.method === "eth_getCode" && row.params[0] === m1.EXECUTOR).length, 1);
    assert.equal(rows.filter(row => row.method === "eth_getTransactionCount" && row.params[1] === "pending").length, 1);
    assert.equal(rows.filter(row => row.kind === "collectorState").length, future ? 2 : 1);
    assert.equal(rows.filter(row => row.kind === "collectorRate").length, future ? 2 : 1);
    assert.equal(rows.filter(row => row.kind === "accruedState").length, future ? 2 : 1);
    assert.equal(rows.filter(row => row.kind === "feeds").length, 1);
    assert.equal(rows.filter(row => row.kind === "quote").length, 3);
    assert.equal(rows.filter(row => row.kind === "exact" && row.method !== "eth_estimateGas").length, 3);
    assert.equal(rows.filter(row => row.method === "eth_estimateGas").length, future ? 0 : 6);
    // Only strict capability checks may be reused, never current data or the
    // funded +24/+12/unknown-hash FUTURE control proof for this actual parent.
    assert.equal(rows.filter(row => row.params[1]?.blockHash === UNKNOWN && row.method !== "eth_simulateV1").length, 0);
    assert.equal(rows.filter(row => row.method === "eth_getCode" && row.params[0] === transport.MULTICALL3).length, 0);
    if (future) {
      const controls = rows.filter(row => row.kind === "childControl");
      assert.equal(controls.length, 3);
      assert.deepEqual(controls.slice(0, 2).map(row => row.params[0].blockStateCalls[0].blockOverrides.time), [hex(PARENT_TIME + 24), hex(PARENT_TIME + 12)]);
      assert.equal(controls[2].error, "UNKNOWN_BLOCK_REJECTED");
      assert.ok(rows.some(row => row.method === "eth_getBalance" && row.params[1].blockHash === hash(HEAD)));
      assert.ok(rows.some(row => row.method === "eth_getTransactionCount" && row.params[1]?.blockHash === hash(HEAD)));
    }
  }
  assert.ok(calls.every(row => row.completed > row.started));
  assert.ok(f.clock.waves.some(wave => wave.labels.length > 1), "Concurrent independent RPC requests actually overlap");
  const exact = calls.filter(row => row.alias === 1 && row.kind === "exact" && row.method !== "eth_estimateGas");
  assert.ok(exact.find(row => row.seized === (MAX_SEIZE / 2n).toString()).completed < exact.find(row => row.seized === MAX_SEIZE.toString()).completed,
    "Reverse exact-variant completion exercises parallel-v2, not only parallel quote reads");
}

function fullTest(name, body) {
  test(name, { timeout: 15000 }, async t => {
    const fixtures = [];
    const make = async options => { const f = await createHarness(t, options); fixtures.push(f); return f; };
    try { await body(t, make); }
    finally { for (const f of fixtures.reverse()) await f.cleanup(); }
  });
}

fullTest("full unsigned CURRENT: real factory/main/collector/admission/parallel-v2 reaches throwing signer with immutable PREPARED proof", async (t, make) => {
  const f = await make({}); await f.prewarm(); await f.run(); assertPrepared(f); assertFreshWaves(f, false);
  assert.equal(f.state.acquisitions.length, 1);
  t.diagnostic(`SYNTHETIC ONLY: detection-to-trap=${f.state.traps[0].at - f.state.detection}ms, RPC=${f.state.calls.length}, waves=${f.clock.waves.length}`);
});

for (const slowRead of ["latest", "canonical"]) fullTest(`full unsigned FUTURE: delayed ${slowRead} publication waits for CURRENT then executes one real same-lease continuation`, async (t, make) => {
  const f = await make({ future: true, slowRead }); await f.prewarm(); await f.run(); assertPrepared(f); assertFreshWaves(f, true);
  const first = f.state.outputs[0].summary, continued = f.state.outputs.filter(row => row.summary.passPhase === "FUTURE_CONTINUATION");
  assert.equal(first.passPhase, "CURRENT"); assert.equal(first.futureContinuation, "WAITING"); assert.equal(first.candidateCount, 0);
  assert.equal(first.m1Budget.detectionMonoMs, f.state.detection);
  assert.equal(first.m1Budget.detectionWallMs, f.state.detectionWall);
  assert.equal(first.m1Budget.fullUnsignedElapsedMs, null);
  assert.ok(f.state.publication && f.state.publication.completed > f.state.currentDone);
  assert.equal(continued.length, 1); assert.equal(continued[0].summary.run, 1); assert.equal(continued[0].summary.candidateCount, 1);
  assert.equal(continued[0].summary.pin.hash, first.pin.hash);
  assert.equal(continued[0].summary.phaseTimingsMs.acquisition, null);
  assert.equal(continued[0].summary.m1Budget.detectionMonoMs, first.m1Budget.detectionMonoMs);
  assert.equal(continued[0].summary.m1Budget.detectionWallMs, first.m1Budget.detectionWallMs);
  assert.equal(continued[0].summary.m1Budget.fullUnsignedElapsedMs, f.state.traps[0].at - f.state.detection);
  assert.equal(f.state.acquisitions.length, 2);
  assert.ok(f.state.acquisitions[1].started >= f.state.continuationDone);
  assert.equal(f.state.passes[0].lease, f.state.leases[0]);
  assert.equal(f.state.leases[0].takeFuture(), null);
  assert.ok(f.state.traps[0].at - f.state.detection > f.state.traps[0].at - f.state.currentDone, "Readiness must not reset total elapsed time");
  const proofCalls = f.state.calls.filter(row => !row.prewarming && row.started <= f.state.traps[0].at);
  t.diagnostic(`SYNTHETIC ONLY: detection-to-trap=${f.state.traps[0].at - f.state.detection}ms, readiness-after-CURRENT=${f.state.publication.completed - f.state.currentDone}ms, fresh RPC=${proofCalls.length}, child controls=${proofCalls.filter(row => row.kind === "childControl").length}, quotes=${proofCalls.filter(row => row.kind === "quote").length}, exact simulations=${proofCalls.filter(row => row.kind === "exact").length}`);
});

fullTest("full unsigned CURRENT: equal-net variants reduce in stable 100/50/25 order despite reverse exact completion", async (_t, make) => {
  const f = await make({ tie: true }); await f.prewarm(); await f.run(); const proof = assertPrepared(f); assertFreshWaves(f, false);
  assert.equal(new Set(proof.evaluatedVariants.map(row => row.economics.netTokenRaw)).size, 1);
});

fullTest("full unsigned CURRENT: aggregate asymmetric tails exceeding six seconds reject before the signer trap", async (t, make) => {
  const f = await make({ aggregateTail: true }); await f.prewarm(); await f.run();
  assert.ok(f.state.runtimeTailUsed && f.state.finalTailUsed);
  assert.ok(f.clock.mono() - f.state.detection > 6000); assert.equal(f.state.traps.length, 0);
  assert.equal(f.state.outputs[0].summary.reason, "M1_V2_UNSIGNED_BUDGET_EXCEEDED");
  assert.equal(f.state.outputs[0].summary.m1Budget.fullUnsignedElapsedMs, null);
  const record = guard.readJournals(f.dirs.journalDir)[0].record;
  assert.equal(record.stage, "ABORTED_UNSIGNED"); assert.equal(record.txHash, null); assert.equal(record.signerInvoked, false);
  assert.equal(record.reason, "M1_V2_UNSIGNED_BUDGET_EXCEEDED");
  assert.equal(record.intent.m1LiveProof.evaluatedVariants.length, 3, "Budget rejection is after actual complete preparation, not a setup failure");
  t.diagnostic(`SYNTHETIC ONLY: aggregate tail rejection at ${f.clock.mono() - f.state.detection}ms, before signer`);
});

fullTest("full unsigned FUTURE: less than two seconds child headroom rejects after final validation and before trap", async (t, make) => {
  const f = await make({ future: true, reserveTail: true, slowRead: "canonical" }); await f.prewarm(); await f.run();
  assert.ok(f.state.finalTailUsed); assert.equal(f.state.traps.length, 0);
  const continuation = f.state.outputs.find(row => row.summary.passPhase === "FUTURE_CONTINUATION");
  assert.equal(continuation.summary.reason, "M1_V2_CHILD_HEADROOM_INSUFFICIENT");
  assert.equal(continuation.summary.m1Budget.fullUnsignedElapsedMs, null);
  assert.equal(continuation.summary.m1Budget.childHeadroomMs, 1999);
  assert.ok(continuation.at - f.state.detection < 6000, "Only headroom, not the unsigned elapsed budget, rejects this case");
  const record = guard.readJournals(f.dirs.journalDir)[0].record;
  assert.equal(record.stage, "ABORTED_UNSIGNED"); assert.equal(record.txHash, null); assert.equal(record.signerInvoked, false);
  assert.equal(record.reason, "M1_V2_CHILD_HEADROOM_INSUFFICIENT");
  assert.equal(record.intent.m1LiveProof.evaluatedVariants.length, 3);
  t.diagnostic(`SYNTHETIC ONLY: child reserve rejection at ${continuation.at - f.state.detection}ms, 1999ms headroom`);
});

fullTest("qualified capability certificate expires at qualification START plus sixty seconds without foreground rescue", async (_t, make) => {
  const f = await make({}); const qualificationStart = f.clock.mono(); await f.prewarm();
  assert.ok(f.state.prewarmEnd > qualificationStart);
  f.clock.jumpTo(qualificationStart + 60000);
  const before = f.state.calls.length;
  await assert.rejects(f.factory.acquire({ candidates: f.candidates }), error => error instanceof guard.ExecutionError && /HOLD|EXPIRED/.test(error.code));
  assert.equal(f.state.calls.length, before, "Expired acquisition must not perform qualification or rescue calls");
  assert.equal(f.state.traps.length, 0);
});

for (const method of ["eth_call", "eth_getCode"]) fullTest(`real qualification rejects an ignored unknown hash (${method}) without granting a warm capability`, async (_t, make) => {
  const f = await make({ ignoreUnknown: method }); await f.prewarm("HOLD");
  const before = f.state.calls.length;
  await assert.rejects(f.factory.acquire({ candidates: f.candidates }), error => error instanceof guard.ExecutionError && /HOLD/.test(error.code));
  assert.equal(f.state.calls.length, before); assert.equal(f.state.traps.length, 0);
});

fullTest("full unsigned FUTURE: ignored time control cannot publish or execute a child", async (_t, make) => {
  const f = await make({ future: true, ignoreTime: true }); await f.prewarm(); await f.run();
  assert.equal(f.state.traps.length, 0);
  assert.equal(f.state.calls.some(row => row.kind === "exact"), false);
  assert.ok(f.state.leases.length > 0);
  assert.ok(f.state.calls.some(row => row.kind === "childControl" && row.params[0].blockStateCalls[0].blockOverrides.time === hex(PARENT_TIME + 24) &&
    row.result?.[0].timestamp === hex(PARENT_TIME + 12)), "The actual +24 control returned +12; failure is not an unrelated setup hold");
});

fullTest("full unsigned FUTURE: ignored simulation unknown hash cannot publish or execute a child", async (_t, make) => {
  const f = await make({ future: true, ignoreUnknown: "eth_simulateV1" }); await f.prewarm(); await f.run();
  assert.equal(f.state.traps.length, 0);
  assert.equal(f.state.calls.some(row => row.kind === "exact"), false);
  assert.ok(f.state.leases.length > 0);
  assert.ok(f.state.calls.some(row => row.method === "eth_simulateV1" && row.params[1].blockHash === UNKNOWN && !row.error));
});

fullTest("full unsigned CURRENT: fresh canonical witness disagreement rejects cached strict capability", async (_t, make) => {
  const f = await make({ disagreement: true }); await f.prewarm(); await f.run();
  assert.equal(f.state.traps.length, 0);
  assert.equal(f.state.calls.some(row => row.kind === "exact"), false);
  const canonical = f.state.calls.filter(row => !row.prewarming && row.method === "eth_getBlockByNumber" && row.params[0] === hex(HEAD));
  assert.equal(canonical.length, 2);
  assert.equal(canonical[0].result.stateRoot, blockHeader().stateRoot);
  assert.equal(canonical[1].result.stateRoot, hash(99999));
  assert.notDeepEqual(canonical[0].result, canonical[1].result);
  assert.equal(f.state.passes.length, 0, "Fresh canonical contradiction is rejected before collector admission");
  // The createPinnedSession request boundary sanitizes its inspector's trust
  // error. Verify the exact raw contradiction above, not a generic setup hold.
  assert.equal(f.state.outputs[0].summary.reason, "PINNED_RPC_FAILED");
});

fullTest("full unsigned CURRENT: fatal exact variant drains its started sibling and never schedules the third exact variant", async (_t, make) => {
  const f = await make({ fatalExact: true }); await f.prewarm(); await f.run();
  assert.equal(f.state.traps.length, 0);
  const exact = f.state.calls.filter(row => row.method === "eth_call" && row.kind === "exact");
  assert.equal(exact.filter(row => row.seized === MAX_SEIZE.toString()).length, 2);
  assert.equal(exact.filter(row => row.seized === (MAX_SEIZE / 2n).toString()).length, 2);
  assert.equal(exact.some(row => row.seized === (MAX_SEIZE / 4n).toString()), false);
  assert.ok(exact.every(row => row.completed <= f.state.outputs[0].at));
  assert.equal(f.state.inFlight, 0);
  assert.ok(f.state.outputs[0].summary.preflightFailures.some(row => row.reason === "CALL_REVERTED"));
  assert.deepEqual(guard.readJournals(f.dirs.journalDir), []);
});

module.exports = { syntheticClock, createRawFixture, createHarness };
