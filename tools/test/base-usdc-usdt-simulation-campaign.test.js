"use strict";
// OFFLINE_FIXTURE ONLY: actual quote/scenario/cost modules, fake transport and fake local RPC.
// No runForkPoc default execution, child, relay listener, inventory, credentials or persisted output.
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const E = require("ethers"), api = require("../base-usdc-usdt-simulation-campaign");
const core = require("../run-fork-poc"), actualApproved = require("../run-approved-fork-validation");
const scenario = require("../fork-poc/triggers/base-usdc-usdt-cross-venue");
const { quoteFixture, PIN, NOW, H, q, SECRET } = require("./base-usdc-usdt-current-quote.test");
const ROOT = path.resolve(__dirname, "../.."), A = n => "0x" + BigInt(n).toString(16).padStart(40, "0"), EXECUTOR = A(999);
const sha = b => crypto.createHash("sha256").update(b).digest("hex");
const COST_FILE = "tools/base-usdc-usdt-simulation-costs.js";
const archive = path.join(ROOT, "reports/profit-validation-20261018/base-fee-oracle-public-03");
const proxy = JSON.parse(fs.readFileSync(path.join(archive, "proxy.json"))), implementation = JSON.parse(fs.readFileSync(path.join(archive, "implementation.json")));
const GPO_ABI = new E.Interface(implementation.abi);
const files = new Map([...api.SOURCE_FILES.map(f => path.join(ROOT, f)), api.ANVIL].map(f => [f, fs.readFileSync(f)]));
const protectedHashes = Object.fromEntries([...Object.keys(api.CORE_SHA), COST_FILE, "tools/test/base-usdc-usdt-simulation-costs.test.js",
  "tools/trigger-coverage-universe.json", "tools/autopilot-disabled-routes.js", "tools/trigger-fork-autopilot.js"].map(f => [f, sha(fs.readFileSync(path.join(ROOT, f)))]));
let serial = 0;
test.beforeEach(t => {
  t.mock.method(global, "fetch", () => assert.fail("network forbidden"));
  for (const method of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"])
    t.mock.method(require("node:child_process"), method, () => assert.fail("process spawn forbidden"));
  for (const method of ["writeFileSync", "appendFileSync", "mkdirSync"])
    t.mock.method(fs, method, () => assert.fail("file writes forbidden"));
});

function fixture(options = {}) {
  let tick = NOW, ready, feeIndex = 0, executed = false, startupMissed = false, startupComplete = false, active = 0, maxActive = 0;
  const code = Object.fromEntries(api.ROOT_ADDRESSES.map(a => [a, "0x6000"]));
  code[api.GPO] = proxy.runtimeBytecode.onchainBytecode; code[api.GPO_IMPL] = implementation.runtimeBytecode.onchainBytecode;
  const spec = { ...structuredClone(api.SPEC_DEFAULTS), primaryFamily: "infura", qualificationPin: structuredClone(PIN),
    runtime: Object.fromEntries(Object.entries(code).map(([a, bytes]) => [a, E.keccak256(bytes)])),
    pointers: [{ address: api.GPO, slot: api.SLOTS[0], value: "0x" + "0".repeat(24) + api.GPO_IMPL.slice(2) }],
    allowances: { quoteHaircutBps: 60, slippageUsdcRaw: "0", financingUsdcRaw: "0", latencyUsdcRaw: "0", competitionUsdcRaw: "0", otherUsdcRaw: "0", ethConversionHaircutBps: 0, networkFeeMarginBps: 0 },
    anvilSha256: sha(files.get(api.ANVIL)), costModuleSha256: sha(files.get(path.join(ROOT, COST_FILE))) };
  spec.pacing.minSpacingMs = options.spacing ?? 0; // explicit fixture authority, never an implicit production speedup
  Object.assign(spec.budget, options.budget); options.specEdit?.(spec);
  const readFile = f => options.changedFile === f ? Buffer.from("OFFLINE_FIXTURE_CHANGED") : files.get(f) || fs.readFileSync(f);
  const prepared = api.prepareOffline(spec, { fixture: "OFFLINE_FIXTURE", readFile });
  const approval = { schema: "base-usdc-usdt-campaign-approval/v1", status: "CURRENT_IN_PROGRESS", attemptStarted: true,
    issuedAtMs: NOW - ++serial, expiresAtMs: NOW + spec.budget.totalMs - 10000, candidateCount: 2, maximumForkRuns: 1,
    preparedSha256: prepared.preparedSha256, specSha256: prepared.specSha256, sourceSha256: structuredClone(prepared.sourceSha256), allowDiagnosticParity: options.diagnostic ?? false };
  for (const k of ["chainId", "routeId", "direction", "principalRaw", "actions", "budget", "pacing", "freshness", "primaryFamily", "witnessFamily"]) approval[k] = structuredClone(spec[k]);
  const candidates = [{ handle: "https://offline.infura.io/OFFLINE_FIXTURE_SECRET_DO_NOT_ECHO", operatorFamily: "infura", inventoryOrder: 0 },
    { handle: "https://offline.publicnode.com/OFFLINE_FIXTURE_SECRET_DO_NOT_ECHO", operatorFamily: "publicnode", inventoryOrder: 1 }];
  const calls = [], localCalls = [], sends = [], events = [], receipts = new Map(), transactions = new Map(), readinessErrors = [];
  const pins = new Map([[PIN.number, PIN]]), quote = quoteFixture(options), m = api.LOCAL_FIXED;
  const erc20 = new E.Interface(["function balanceOf(address) view returns(uint256)"]), executor = new E.Interface(prepared.artifact.abi);
  let localPin = PIN, hd = null, harnessCalls = 0;
  const header = pin => ({ number: q(pin.number), hash: pin.hash, stateRoot: pin.stateRoot, parentHash: H(pin.number - 1), timestamp: q(pin.timestamp), baseFeePerGas: "0x0" });
  const rawTransport = async (handle, payload, timeout, maxBytes) => {
    calls.push({ handle, payload: structuredClone(payload), timeout, maxBytes, at: tick }); active++; maxActive = Math.max(maxActive, active);
    try {
      await options.onUpstream?.({ handle, payload, calls, maxBytes, timeout });
      if (options.transportError) throw Object.assign(new Error(SECRET), { body: { key: SECRET } });
      const { method, params } = payload; let result;
      if (method === "eth_chainId") result = options.providerChanged ? "0x1" : "0x2105";
      else if (method === "net_version") result = "8453";
      else if (method === "eth_getBlockByNumber" || method === "eth_getBlockByHash") {
        const pin = method === "eth_getBlockByNumber" ? pins.get(Number(BigInt(params[0]))) : [...pins.values()].find(p => p.hash === params[0]);
        result = header(pin || localPin);
        if (options.headerReorg && method === "eth_getBlockByNumber") result.hash = H(999999);
        if (options.missingBaseFee) delete result.baseFeePerGas;
      } else if (method === "eth_getCode") result = options.runtimeChanged === params[0].toLowerCase() ? "0x6001" : code[params[0].toLowerCase()] || "0x6000";
      else if (method === "eth_getStorageAt") result = options.pointerChanged ? H(0) : spec.pointers.find(p => p.address === params[0].toLowerCase() && p.slot === params[1])?.value || H(0);
      else if (method === "eth_call" && params[0].to.toLowerCase() === api.GPO) {
        const parsed = GPO_ABI.parseTransaction(params[0]); let value;
        if (options.missingFee === parsed.name) return { bytes: 4, value: { jsonrpc: "2.0", id: payload.id, result: null } };
        if (parsed.name === "version") value = options.version || "1.6.0";
        else if (parsed.name.startsWith("is")) value = true;
        else { value = (options.fees || [[0n, 0n, 0n], [0n, 0n, 0n]])[Math.floor(feeIndex / 3)][feeIndex % 3]; feeIndex++; }
        result = GPO_ABI.encodeFunctionResult(parsed.name, [value]);
      } else {
        const ref = params.at(-1), pin = [...pins.values()].find(p => p.hash === ref?.blockHash) || localPin;
        Object.assign(quote.pin, pin); result = await quote.rpcCall(handle, method, params);
      }
      const value = { jsonrpc: "2.0", id: payload.id, result };
      return { bytes: options.consumeAllowance ? maxBytes : options.responseBytes ?? Buffer.byteLength(JSON.stringify(value)), value };
    } finally { active--; }
  };
  const rpc = { stats: () => ({ requests: localCalls.length, bytes: 0 }), async call(method, params) {
    localCalls.push({ method, params: structuredClone(params), at: tick });
    await options.onLocal?.({ method, params });
    if ((!startupMissed && method === options.startupUnavailableMethod) || (startupComplete && options.postReadyUnavailable && method === "eth_getCode")) {
      startupMissed = true;
      const e = options.untypedUnavailable ? Object.assign(new Error(SECRET), { code: "LOCAL_RPC_UNAVAILABLE" }) : new actualApproved.ForkError("LOCAL_RPC_UNAVAILABLE", SECRET);
      e.detail = SECRET; e.cause = { key: SECRET }; throw e;
    }
    if (options.localError === method) throw new Error(SECRET);
    if (method === "eth_chainId") return options.readinessChain || "0x2105";
    if (method === "eth_getBlockByNumber") return options.readinessPinMismatch ? { ...header(localPin), hash: H(4) } : header(localPin);
    if (method === "eth_getCode") return options.localCode || code[params[0].toLowerCase()] || "0x6000";
    if (["anvil_setBalance", "anvil_impersonateAccount", "anvil_stopImpersonatingAccount"].includes(method)) return true;
    if (method === "eth_call") {
      const tx = params[0];
      if (tx.to.toLowerCase() === m.bindings.usdc) {
        const holder = erc20.decodeFunctionData("balanceOf", tx.data)[0].toLowerCase();
        const value = holder === m.actor ? executed ? options.gain ?? 10000000n : options.actorInitial || 0n
          : holder === m.bindings.morpho ? executed ? options.capacityAfter ?? options.capacity ?? 1000000000n : options.capacity ?? 1000000000n : options.executorInitial || 0n;
        return erc20.encodeFunctionResult("balanceOf", [value]);
      }
      const parsed = executor.parseTransaction(tx);
      return executor.encodeFunctionResult(parsed.name, [parsed.name === "actor" ? options.constructorActor || m.actor : options[parsed.name] ?? true]);
    }
    if (method === "eth_sendTransaction") {
      const tx = params[0], stage = tx.to ? "EXECUTE" : "DEPLOY", type = options.txType ?? 2;
      if (options.failedSend === stage) throw new Error(SECRET);
      sends.push(tx); const transactionHash = H(sends.length);
      if (stage === "EXECUTE") executed = options.failedReceipt !== stage;
      const receipt = { transactionHash, blockHash: H(100), blockNumber: q(localPin.number + sends.length), transactionIndex: "0x0", type: q(type),
        status: options.failedReceipt === stage ? "0x0" : "0x1", gasUsed: q(options.gasUsed ?? (stage === "DEPLOY" ? 200000 : 300000)),
        effectiveGasPrice: q(5000000), cumulativeGasUsed: q(500000), from: m.actor, to: tx.to || null, contractAddress: tx.to ? null : EXECUTOR,
        logs: [{ address: m.bindings.usdc, topics: [H(12)], data: H(10), secret: SECRET }], secret: SECRET };
      options.receiptEdit?.(receipt, stage); receipts.set(transactionHash, receipt);
      const publicTx = { hash: transactionHash, chainId: q(8453), type: q(type), nonce: q(16 + sends.length), gas: tx.gas,
        gasPrice: q(5000000), ...(type === 2 ? { maxFeePerGas: q(9000000), maxPriorityFeePerGas: q(1000000) } : {}),
        from: m.actor, to: tx.to || null, value: "0x0", input: tx.data, ...(type === 0 ? {} : { accessList: [{ address: m.bindings.usdc, storageKeys: [H(12)] }] }),
        privateKey: SECRET, r: SECRET, s: SECRET, v: SECRET, raw: SECRET, signature: SECRET, headers: { secret: SECRET } };
      options.transactionEdit?.(publicTx, stage); transactions.set(transactionHash, publicTx); return transactionHash;
    }
    if (method === "eth_getTransactionReceipt") return receipts.get(params[0]);
    if (method === "eth_getTransactionByHash") return transactions.get(params[0]);
    throw new Error(SECRET);
  } };
  const harness = {
    defaultDeps: () => ({ loadScenario: () => options.scenario ? { run: ctx => options.scenario(ctx, f) } : scenario,
      waitReady: async (child, local, pin) => {
        await actualApproved.waitReady(child, { call: async (method, params) => {
          try { return await local.call(options.readinessPolicyRefusal ? "eth_getAccountInfo" : method, params); }
          catch (e) { readinessErrors.push(e); throw e; }
        } }, pin); startupComplete = true;
      }, createRelay: async () => ({ close: async () => { events.push("CLOSED"); } }) }),
    async runForkPoc(runOptions, deps) {
      harnessCalls++; hd = deps; events.push("HARNESS"); localPin = pins.get(Number(runOptions.block));
      assert.equal(runOptions.callerClass, "MANUAL"); assert.equal(runOptions.scenarioName, "base-usdc-usdt-cross-venue");
      assert.equal(runOptions.scenarioInput.candidate.expectedOutRaw, "1000000001"); assert.ok(runOptions.limits.totalMs <= spec.budget.totalMs);
      const primary = hd.resolveUpstream(8453, hd.loadRpcUrls()); assert.equal(primary, candidates[0].handle);
      const relay = await hd.createRelay({ upstreamUrl: primary, transport: hd.transport, limits: runOptions.limits });
      const local = hd.createLocalRpc(8545);
      const ctx = core.createScenarioContext({ chainId: 8453, block: { number: String(localPin.number), hash: localPin.hash }, localRpc: local, ethers: E,
        scenarioInput: runOptions.scenarioInput, limits: runOptions.limits, now: () => tick, deadline: tick + runOptions.limits.totalMs });
      let status = "PASS";
      try {
        await hd.transport(primary, { jsonrpc: "2.0", id: 1000, method: "eth_getCode", params: [A(1), q(localPin.number)] }); // lazy fork read
        await hd.waitReady({ exitCode: null, signalCode: null }, local, { chainId: "8453", pinBlockNumber: String(localPin.number), pinBlockHash: localPin.hash, pinStateRoot: localPin.stateRoot });
        await options.harnessAction?.({ hd, local, primary, ctx, f });
        await hd.loadScenario(runOptions.scenario).run(ctx);
      } catch (_) { status = "FAIL_CLOSED"; }
      finally {
        for (const a of ctx._state.impersonated) { try { await local.call("anvil_stopImpersonatingAccount", [a]); } catch (_) { status = "FAIL_CLOSED"; } }
        events.push("STOPPED"); await relay.close();
      }
      hd.writeEvidence(runOptions.outPath, { status, asserts: ctx._state.asserts, blockerDetail: SECRET,
        relay: { deniedMethods: options.denied ? ["eth_getAccountInfo"] : [] }, cleanup: options.badCleanup ? {} : { child: "STOPPED", relay: "CLOSED" } });
      return { status, secret: SECRET };
    },
  };
  const deps = { fixture: "OFFLINE_FIXTURE", readFile, now: () => tick, sleep: async ms => { tick += ms; }, transport: rawTransport, harness, approved: { createLocalRpc: () => rpc } };
  const f = { spec, prepared, approval, candidates, deps, options, calls, localCalls, sends, events, readinessErrors, code,
    setTick: value => { tick = value; }, get tick() { return tick; }, get active() { return active; }, get maxActive() { return maxActive; }, get hd() { return hd; },
    get harnessCalls() { return harnessCalls; }, get ready() { return ready; },
    head: (number = PIN.number + 1, timestamp = String(Math.floor(tick / 1000))) => { const pin = { ...PIN, number, hash: H(number), timestamp }; pins.set(number, pin); return pin; },
    qualify: async () => { ready = await api.qualifyCampaign(prepared, approval, candidates, deps); return ready; },
    evaluate: head => api.evaluateHead(ready, head || f.head()),
    run: async () => { const r = await f.qualify(); return r.status === "READY" ? f.evaluate() : r; } };
  return f;
}
function honest(out) {
  assert.equal(out.status, "OFFLINE_FIXTURE"); assert.equal(out.evidenceOrigin, "OFFLINE_FIXTURE");
  assert.equal(out.liveReady, false); assert.equal(out.liveAdmission, false); assert.equal(out.dispatchEnabled, false);
  assert.equal(out.triggerOrCoveragePromotion, false); assert.equal(out.routePositive, "unknown");
  assert.equal(out.compiledSourceIndependentlyRebuilt, false); assert.equal(out.budget.pending, 0); assert.equal(out.budget.active, 0);
  assert.doesNotMatch(JSON.stringify(out), /OFFLINE_FIXTURE_SECRET_DO_NOT_ECHO|https?:|privateKey|blockerDetail|candidatesDigest/);
}
const payload = (method, params = []) => ({ jsonrpc: "2.0", id: "OFFLINE_REJECTED_PROBE", method, params });
async function deploy(ctx, f) { ctx.fatal = true; await ctx.setBalance(api.LOCAL_FIXED.actor, q(api.LOCAL_FIXED.actorNativeFixtureWei)); return ctx.deploy({ from: api.LOCAL_FIXED.actor, data: f.prepared.creationData }); }

test("OFFLINE_FIXTURE import/CLI never starts network, services or approval", () => {
  assert.equal(api.main([]).transportCalls, 0); assert.equal(api.main(["--check"]).campaignStarted, false);
  assert.throws(() => api.main(["--run"]), { code: "CAMPAIGN_CLI_REFUSED" });
  assert.equal(api.SPEC_DEFAULTS.pacing.concurrency, 1); assert.equal(api.SPEC_DEFAULTS.pacing.minSpacingMs, 1000);
});
test("OFFLINE_FIXTURE real quote -> unchanged scenario -> actual bound GPO costs is positive-at-pin only", async () => {
  const f = fixture(), out = await f.run(); honest(out);
  assert.equal(out.outcome, "POSITIVE_AT_PIN"); assert.equal(out.failure, null);
  assert.equal(out.costs.costs.networkUsdcRaw, "100000"); assert.equal(out.costs.costs.quoteHaircutUsdcRaw, "6000000");
  assert.equal(out.costs.netUsdcRaw, "3900000"); assert.equal(out.costs.realizedProfit, null); assert.equal(out.costs.guaranteedFutureFee, false);
  assert.equal(f.sends.length, 2); assert.equal(out.simulation.principalRepaidRaw, "1000000000");
  assert.equal(out.simulation.morphoUsdcAfterRaw, out.simulation.morphoUsdcCapacityRaw);
  assert.equal(out.simulation.executor.zeroObservedBeforeExecute, true); assert.equal(out.simulation.executor.initialUsdcBalanceRaw, "0");
  assert.equal(f.sends[0].data, f.prepared.creationData); assert.equal(f.sends[1].data, f.prepared.executeData);
  assert.deepEqual(f.sends.map(tx => tx.gas), [q(3000000), q(1000000)]); assert.ok(f.sends.every(tx => tx.value === "0x0" && tx.from.toLowerCase() === api.LOCAL_FIXED.actor));
  assert.equal(out.simulation.local.submittedGasLimits, "4000000"); assert.equal(out.simulation.fixtureAssertionsPassed, true);
  assert.equal(out.simulation.localDiagnosticParityPassed, false); assert.deepEqual(out.simulation.cleanup, { child: "STOPPED", relay: "CLOSED" });
  assert.equal(out.budget.requests, f.calls.length + f.localCalls.length); assert.equal(out.budget.maximumUpstreamConcurrency, 1);
  const feeCalls = f.calls.filter(c => c.payload.method === "eth_call" && c.payload.params[0].to.toLowerCase() === api.GPO);
  assert.deepEqual(feeCalls.map(c => GPO_ABI.parseTransaction(c.payload.params[0]).name), ["version", "isEcotone", "isFjord", "isIsthmus", "isJovian",
    "getL1Fee", "getL1FeeUpperBound", "getOperatorFee", "getL1Fee", "getL1FeeUpperBound", "getOperatorFee"]);
  assert.ok(feeCalls.every(c => c.handle === f.candidates[0].handle && c.payload.params[1].blockHash === out.pin.hash));
  assert.ok(f.calls.filter(c => c.handle === f.candidates[1].handle).every(c => ["eth_chainId", "eth_getBlockByNumber"].includes(c.payload.method)));
  assert.ok(f.calls.some(c => c.payload.method === "eth_getStorageAt" && c.payload.params[2].blockHash === PIN.hash));
  assert.ok(f.calls.some(c => c.payload.method === "eth_call" && c.payload.params[1].blockHash === PIN.hash));
  assert.equal(out.simulation.costs.fullyCostedNet, null, "native-only scenario net is never authoritative");
  assert.ok(Object.isFrozen(out)); assert.ok(Object.isFrozen(out.simulation.unsignedTransactions[0]));
});
test("OFFLINE_FIXTURE real costs: 1 ETH at $2000 defeats a 10-USDC gain, no false green", async () => {
  const f = fixture({ gasUsed: 0, fees: [[1000000000000000000n, 0n, 0n], [0n, 0n, 0n]] }), out = await f.run(); honest(out);
  assert.equal(out.outcome, "NONPOSITIVE"); assert.equal(out.costs.costs.networkUsdcRaw, "2000000000");
  assert.equal(out.costs.netUsdcRaw, "-1996000000"); assert.equal(out.costs.qualifiedAtPin, false);
});
for (const missingFee of ["getL1Fee", "getL1FeeUpperBound", "getOperatorFee"]) test(`OFFLINE_FIXTURE missing ${missingFee} is UNKNOWN not zero`, async () => {
  const out = await fixture({ missingFee }).run(); honest(out); assert.equal(out.outcome, "UNKNOWN"); assert.equal(out.costs.netUsdcRaw, null);
});
test("OFFLINE_FIXTURE gross-negative and conservative-suppressed quotes do not simulate", async () => {
  for (const curveOut of [999999999n, 1000000000n, 1003816057n]) {
    const f = fixture({ curveOut }), out = await f.run(); honest(out); assert.equal(out.outcome, "WATCH"); assert.equal(f.harnessCalls, 0);
  }
});
test("OFFLINE_FIXTURE diagnostic parity needs explicit authority and cannot promote", async () => {
  const f = fixture({ curveOut: 1003816057n, diagnostic: true }), out = await f.run(); honest(out);
  assert.equal(out.outcome, "DIAGNOSTIC_ONLY"); assert.equal(out.diagnosticOnly, true); assert.equal(out.costs.qualifiedAtPin, false); assert.equal(f.harnessCalls, 1);
  const g = fixture({ curveOut: 999999999n, diagnostic: true }); assert.equal((await g.run()).outcome, "WATCH"); assert.equal(g.harnessCalls, 0);
});
test("OFFLINE_FIXTURE preparation schema/caps/allowances/source hashes fail before transport", () => {
  const f = fixture();
  const edits = [s => { s.chainId = 1; }, s => { s.principalRaw = "1"; }, s => { s.direction = "CURVE_TO_UNIV3"; }, s => { s.actions.push("SIGN"); },
    s => { s.budget.requests = 1001; }, s => { s.budget.bytes = 67108865; }, s => { s.budget.totalMs = 180001; }, s => { s.budget.simulations = 2; },
    s => { s.budget.retries = 1; }, s => { s.pacing.concurrency = 2; }, s => { s.pacing.minSpacingMs = -1; }, s => { s.freshness.candidateAgeMs = 10001; },
    s => { s.freshness.headLagBlocks = 3; }, s => { s.allowances.quoteHaircutBps = 59; }, s => { delete s.allowances.otherUsdcRaw; },
    s => { delete s.runtime[api.GPO]; }, s => { s.pointers = []; }, s => { s.costModuleSha256 = "0".repeat(64); }, s => { s.anvilSha256 = "0".repeat(64); }, s => { s.extra = true; }];
  for (const edit of edits) { const spec = structuredClone(f.spec); edit(spec); assert.throws(() => api.prepareOffline(spec, { fixture: "OFFLINE_FIXTURE", readFile: f.deps.readFile })); }
  for (const file of Object.keys(api.CORE_SHA)) assert.throws(() => api.prepareOffline(f.spec, { fixture: "OFFLINE_FIXTURE", readFile: name => name === path.join(ROOT, file) ? Buffer.from("{}") : f.deps.readFile(name) }));
  assert.equal(f.calls.length, 0);
});
test("OFFLINE_FIXTURE exact parent authority, prepared identity, family provenance and replay", async () => {
  const f = fixture();
  const edits = [a => { a.status = "CONSUMED"; }, a => { a.attemptStarted = false; }, a => { a.expiresAtMs = NOW; }, a => { a.issuedAtMs = NOW + 1; },
    a => { a.preparedSha256 = "0".repeat(64); }, a => { a.specSha256 = "0".repeat(64); }, a => { a.sourceSha256 = {}; }, a => { a.primaryFamily = "drpc"; },
    a => { a.witnessFamily = "infura"; }, a => { a.maximumForkRuns = 2; }, a => { a.candidateCount = 1; }, a => { a.pacing.minSpacingMs = 1; }, a => { a.candidatesDigest = "forbidden"; }];
  for (const edit of edits) { const a = structuredClone(f.approval); edit(a); await assert.rejects(api.qualifyCampaign(f.prepared, a, structuredClone(f.candidates), f.deps)); }
  for (const edit of [c => { c.reverse(); }, c => { c[0].handle = "https://infura.io.offline.invalid/fixture"; }, c => { c[1].handle = c[0].handle; }, c => { c[0].headers = {}; }]) {
    const c = structuredClone(f.candidates); edit(c); await assert.rejects(api.qualifyCampaign(f.prepared, structuredClone(f.approval), c, f.deps));
  }
  await assert.rejects(api.qualifyCampaign({ ...f.prepared }, f.approval, f.candidates, f.deps), { code: "PREPARATION_REQUIRED" });
  assert.equal(f.calls.length, 0); await f.qualify();
  await assert.rejects(api.qualifyCampaign(f.prepared, structuredClone(f.approval), structuredClone(f.candidates), f.deps), { code: "ATTEMPT_ALREADY_USED" });
  assert.ok(Object.isFrozen(f.approval.sourceSha256)); assert.ok(Object.isFrozen(f.candidates[0]));
});
test("OFFLINE_FIXTURE source, runtime, pointer, provider and by-number reorg invalidate readiness", async () => {
  for (const alter of [f => { f.options.changedFile = path.join(ROOT, COST_FILE); }, f => { f.options.changedFile = path.join(ROOT, "tools/scan-cross-dex-arbitrage.js"); },
    f => { f.options.runtimeChanged = api.LOCAL_FIXED.bindings.usdc; }, f => { f.options.pointerChanged = true; },
    f => { f.options.providerChanged = true; }, f => { f.options.headerReorg = true; }]) {
    const f = fixture(); assert.equal((await f.qualify()).status, "READY"); alter(f);
    const out = await f.evaluate(); honest(out); assert.equal(out.outcome, "UNKNOWN"); assert.ok(out.failure); assert.equal(f.harnessCalls, 0);
    const count = f.calls.length; assert.equal((await f.evaluate(f.head(PIN.number + 2))).outcome, "UNKNOWN"); assert.equal(f.calls.length, count);
  }
});
test("OFFLINE_FIXTURE qualification errors/oversized responses are sanitized and drained", async () => {
  for (const options of [{ transportError: true }, { responseBytes: 1048577 }, { pointerChanged: true }, { providerChanged: true },
    { runtimeChanged: api.GPO }, { updatedAt: BigInt(PIN.timestamp) - 1000000n }]) {
    const f = fixture(options), out = await f.qualify(); honest(out); assert.equal(out.outcome, "UNKNOWN"); assert.equal(f.active, 0); assert.equal(f.harnessCalls, 0);
  }
});
test("OFFLINE_FIXTURE strict stale/future/expired candidate checks happen before quote", async () => {
  for (const delta of [-10001, 1000]) {
    const f = fixture(); await f.qualify(); const out = await f.evaluate(f.head(PIN.number + 1, String(Math.floor((NOW + delta) / 1000))));
    honest(out); assert.equal(out.outcome, "UNKNOWN"); assert.equal(out.failure.code, "CANDIDATE_STALE"); assert.equal(f.harnessCalls, 0);
  }
  const f = fixture(); await f.qualify(); f.setTick(f.approval.expiresAtMs); const out = await f.evaluate(); honest(out); assert.equal(out.failure.code, "CAMPAIGN_EXPIRED");
});
test("OFFLINE_FIXTURE staleness after quote, simulation or fee collection never returns green", async () => {
  for (const phase of ["quote", "simulation", "cost"]) {
    const options = {}, f = fixture(options); await f.qualify(); let changed = false;
    if (phase === "simulation") options.onLocal = ({ method }) => { if (method === "eth_getTransactionByHash" && !changed) { changed = true; f.setTick(NOW + 10001); } };
    else options.onUpstream = ({ payload: p }) => {
      if (!changed && p.method === "eth_call" && (phase === "cost" ? p.params[0].to.toLowerCase() === api.GPO : p.params[0].data.startsWith("0x5e0d443f"))) { changed = true; f.setTick(NOW + 10001); }
    };
    const out = await f.evaluate(); honest(out); assert.equal(changed, true); assert.equal(out.outcome, "UNKNOWN"); assert.equal(out.failure.code, "CANDIDATE_STALE");
  }
});
test("OFFLINE_FIXTURE same-height reorg, head lag >2 and latest-head coalescing have no stale queue", async () => {
  for (const mode of ["reorg", "lag", "coalesce"]) {
    let release, entered; const gate = new Promise(r => { release = r; }), started = new Promise(r => { entered = r; });
    const options = { curveOut: 999999999n }, f = fixture(options); await f.qualify(); let blocked = false;
    options.onUpstream = async () => { if (!blocked) { blocked = true; entered(); await gate; } };
    const first = f.evaluate(f.head()); await started;
    const next = f.head(mode === "lag" ? PIN.number + 4 : mode === "reorg" ? PIN.number + 1 : PIN.number + 2);
    if (mode === "reorg") next.hash = H(9999);
    const second = f.evaluate(next); let latest;
    if (mode === "coalesce") latest = f.evaluate(f.head(PIN.number + 3));
    release(); const out = await first; honest(out);
    if (mode === "coalesce") { assert.equal((await second).outcome, "COALESCED"); assert.equal(out.outcome, "WATCH"); const last = await latest; honest(last); assert.equal(last.pin.number, PIN.number + 3); assert.equal(last.outcome, "WATCH"); }
    else { assert.equal(out.outcome, "UNKNOWN"); assert.equal((await second).outcome, "UNKNOWN"); }
    assert.equal(f.harnessCalls, 0);
  }
});
test("OFFLINE_FIXTURE simulation and one-use campaign cannot replay", async () => {
  const f = fixture(), out = await f.run(); honest(out); const count = f.calls.length;
  const repeat = await f.evaluate(f.head(PIN.number + 2)); honest(repeat); assert.equal(repeat.outcome, "UNKNOWN"); assert.equal(repeat.failure.code, "CAMPAIGN_CONSUMED");
  assert.equal(f.calls.length, count); assert.equal(f.harnessCalls, 1);
});
test("OFFLINE_FIXTURE explicit default pacing stays serial and shared qualification counts are charged", async () => {
  const f = fixture({ spacing: 1000 }); assert.equal((await f.qualify()).status, "READY");
  assert.ok(f.calls.slice(1).every((call, i) => call.at - f.calls[i].at >= 1000)); assert.equal(f.maxActive, 1);
  const out = await f.evaluate(); honest(out); assert.equal(out.outcome, "UNKNOWN"); assert.equal(out.failure.code, "CANDIDATE_STALE");
  assert.ok(out.budget.requests >= f.calls.length); assert.equal(f.harnessCalls, 0);
});
test("OFFLINE_FIXTURE shared requests, bytes, response caps and deadline bound qualification", async () => {
  for (const [options, code] of [[{ budget: { requests: 5 } }, "CAMPAIGN_REQUEST_CAP"], [{ budget: { bytes: 1024 }, responseBytes: 1024 }, "CAMPAIGN_BYTE_CAP"],
    [{ budget: { responseBytes: 16 }, responseBytes: 17 }, "CAMPAIGN_RESPONSE_CAP"], [{ spacing: 1000, budget: { totalMs: 12000 } }, "CAMPAIGN_EXPIRED"]]) {
    const f = fixture(options), out = await f.qualify(); honest(out); assert.equal(out.outcome, "UNKNOWN"); assert.equal(out.failure.code, code);
    assert.ok(out.budget.requests <= f.spec.budget.requests); assert.ok(out.budget.bytes <= f.spec.budget.bytes); assert.equal(f.active, 0);
  }
});
test("OFFLINE_FIXTURE pending provider reads drain before failure resolves", async () => {
  let release, entered; const gate = new Promise(r => { release = r; }), started = new Promise(r => { entered = r; });
  const options = {}, f = fixture(options); await f.qualify(); let blocked = false;
  options.onUpstream = async () => { if (!blocked) { blocked = true; entered(); await gate; } };
  let done = false; const work = f.evaluate().then(out => { done = true; return out; }); await started;
  f.setTick(f.approval.expiresAtMs); await new Promise(r => setImmediate(r)); assert.equal(done, false);
  release(); const out = await work; honest(out); assert.equal(out.outcome, "UNKNOWN"); assert.equal(f.active, 0);
});
test("OFFLINE_FIXTURE actual waitReady retries only typed startup unavailability", async () => {
  for (const startupUnavailableMethod of ["eth_chainId", "eth_getBlockByNumber"]) {
    const f = fixture({ startupUnavailableMethod }), out = await f.run(); honest(out); assert.equal(out.outcome, "POSITIVE_AT_PIN");
    assert.equal(out.simulation.local.readinessPhase, "READY"); assert.equal(f.readinessErrors.length, 1);
    const error = f.readinessErrors[0]; assert.ok(error instanceof actualApproved.ForkError); assert.equal(error.code, "LOCAL_RPC_UNAVAILABLE");
    assert.equal(error.detail, null); assert.equal(error.cause, undefined);
  }
});
for (const [name, options, code] of [
  ["chain mismatch", { readinessChain: "0x1" }, "LOCAL_FORK_CHAIN_MISMATCH"], ["pin mismatch", { readinessPinMismatch: true }, "LOCAL_FORK_PIN_MISMATCH"],
  ["policy refusal", { readinessPolicyRefusal: true }, "LOCAL_METHOD_DENIED"],
  ["untyped lookalike", { startupUnavailableMethod: "eth_chainId", untypedUnavailable: true }, "LOCAL_RPC_FAILED"],
  ["post-ready unavailable", { postReadyUnavailable: true }, "LOCAL_RPC_FAILED"],
]) test(`OFFLINE_FIXTURE readiness ${name} is fatal and cleanup is retained`, async () => {
  const f = fixture(options), out = await f.run(); honest(out); assert.equal(out.outcome, "UNKNOWN"); assert.equal(out.simulation.failure.code, code);
  assert.equal(f.sends.length, 0); assert.deepEqual(out.simulation.cleanup, { child: "STOPPED", relay: "CLOSED" });
});
for (const [name, options, code, count] of [
  ["executor funds", { executorInitial: 1n }, "EXECUTOR_INITIAL_USDC_NONZERO", 1], ["actor funds", { actorInitial: 1n }, "ACTOR_INITIAL_USDC_NONZERO", 0],
  ["capacity", { capacity: 999999999n }, "MORPHO_CAPACITY_INSUFFICIENT", 0], ["repayment", { capacityAfter: 999999999n }, "MORPHO_REPAYMENT_UNPROVEN", 2],
  ["constructor", { constructorActor: A(5) }, "EXECUTOR_CONSTRUCTOR_MISMATCH", 1], ["runtime", { localCode: "0x6001" }, "LOCAL_RUNTIME_CHANGED", 0],
]) test(`OFFLINE_FIXTURE ${name} proof cannot be omitted`, async () => {
  const f = fixture(options), out = await f.run(); honest(out); assert.equal(out.outcome, "UNKNOWN"); assert.equal(out.simulation.failure.code, code);
  assert.equal(f.sends.length, count); assert.equal(f.localCalls.some(c => /setStorage|setCode|sendRaw/.test(c.method)), false);
});
test("OFFLINE_FIXTURE failed sends/receipts, incomplete settlement and cleanup never qualify", async () => {
  for (const options of [{ failedSend: "DEPLOY" }, { failedSend: "EXECUTE" }, { failedReceipt: "DEPLOY" }, { failedReceipt: "EXECUTE" },
    { callbackComplete: false }, { bothSwapsComplete: false }, { denied: true }, { badCleanup: true }]) {
    const f = fixture(options), out = await f.run(); honest(out); assert.equal(out.outcome, "UNKNOWN"); assert.equal(out.simulation.fixtureAssertionsPassed, false);
  }
});
test("OFFLINE_FIXTURE transaction type, nonce, access list and full unsigned bytes are preserved without signatures", async () => {
  for (const txType of [0, 1, 2]) {
    const f = fixture({ txType }), out = await f.run(); honest(out); assert.equal(out.outcome, "POSITIVE_AT_PIN");
    assert.deepEqual(f.localCalls.filter(c => c.method === "eth_getTransactionByHash").map(c => c.params), [[H(1)], [H(2)]]);
    for (const [i, row] of out.simulation.unsignedTransactions.entries()) {
      const tx = E.Transaction.from(row.unsignedSerialized); assert.equal(tx.type, txType); assert.equal(tx.signature, null);
      assert.equal(tx.nonce, 17 + i); assert.equal(tx.gasLimit, BigInt(f.sends[i].gas)); assert.equal(tx.chainId, 8453n); assert.equal(tx.value, 0n);
      assert.equal(tx.data, f.sends[i].data); assert.ok(row.serializedByteLength > E.getBytes(row.input).length);
      assert.equal(row.serializedByteLength, E.getBytes(row.unsignedSerialized).length);
    }
  }
});
test("OFFLINE_FIXTURE invalid owned transaction capture fails closed with no secret echo", async () => {
  for (const transactionEdit of [r => { r.hash = H(9); }, r => { r.chainId = "0x1"; }, r => { r.type = "0x4"; }, r => { r.from = A(9); },
    r => { r.input = "0x6000"; }, r => { r.value = "0x1"; }, r => { r.to = A(1); }, r => { r.nonce = q(BigInt(Number.MAX_SAFE_INTEGER) + 1n); },
    r => { r.gas = q(3000001); }, r => { delete r.maxFeePerGas; }, r => { r.maxPriorityFeePerGas = q(9000001); },
    r => { r.accessList = [{ address: A(1), storageKeys: ["invalid"] }]; }, r => { r.accessList = Array(65).fill({ address: A(1), storageKeys: [] }); },
    r => { r.accessList = [{ address: A(1), storageKeys: Array(257).fill(H(1)) }]; }, r => { r.accessList = [{ address: A(1), storageKeys: [], privateKey: SECRET }]; }]) {
    const f = fixture({ transactionEdit }), out = await f.run(); honest(out); assert.equal(out.outcome, "UNKNOWN"); assert.equal(out.simulation.failure.code, "LOCAL_TRANSACTION_INVALID");
    assert.equal(f.sends.length, 1); assert.equal(out.simulation.unsignedTransactions.length, 0);
  }
});
test("OFFLINE_FIXTURE execution actor/value/calldata/target/gas are exact, no duplicate sends", async () => {
  for (const mutate of [tx => { tx.from = A(77); }, tx => { tx.value = "0x1"; }, tx => { tx.data = "0x12345678"; }, tx => { tx.to = A(88); }, tx => { tx.gas = q(1000001); }]) {
    const f = fixture({ scenario: async (ctx, f) => { const deployment = await deploy(ctx, f); const tx = { from: api.LOCAL_FIXED.actor, to: deployment.address, data: f.prepared.executeData }; mutate(tx); await ctx.send(tx); } });
    const out = await f.run(); honest(out); assert.equal(out.outcome, "UNKNOWN"); assert.equal(f.sends.length, 1);
  }
  for (const action of ["deploy", "execute", "fundAgain", "fundOver", "fundOther"]) {
    const f = fixture({ scenario: async (ctx, f) => {
      if (action === "fundOver") return ctx.setBalance(api.LOCAL_FIXED.actor, q(BigInt(api.LOCAL_FIXED.actorNativeFixtureWei) + 1n));
      if (action === "fundOther") return ctx.setBalance(A(4), q(api.LOCAL_FIXED.actorNativeFixtureWei));
      const deployment = await deploy(ctx, f);
      if (action === "deploy") return ctx.deploy({ from: api.LOCAL_FIXED.actor, data: f.prepared.creationData });
      if (action === "fundAgain") return ctx.setBalance(api.LOCAL_FIXED.actor, q(api.LOCAL_FIXED.actorNativeFixtureWei));
      const tx = { from: api.LOCAL_FIXED.actor, to: deployment.address, data: f.prepared.executeData }; await ctx.send(tx); await ctx.send(tx);
    } });
    const out = await f.run(); honest(out); assert.equal(out.outcome, "UNKNOWN"); assert.ok(f.sends.length <= 2); assert.ok(BigInt(out.simulation.local.submittedGasLimits) <= 6000000n);
  }
});
test("OFFLINE_FIXTURE local RPC default-denies signing, token seeds, time and arbitrary transaction capture", async () => {
  for (const method of ["eth_sendRawTransaction", "anvil_setCode", "anvil_setStorageAt", "evm_increaseTime", "evm_mine", "eth_getAccountInfo", "eth_getTransactionByHash"]) {
    const f = fixture({ harnessAction: ({ local }) => local.call(method, []) }), out = await f.run(); honest(out);
    assert.equal(out.outcome, "UNKNOWN"); assert.equal(out.simulation.failure.code, "LOCAL_METHOD_DENIED"); assert.equal(f.localCalls.some(c => c.method === method), false);
  }
});
test("OFFLINE_FIXTURE deployment gas and calldata/actor/value cannot be substituted", async () => {
  for (const mutate of [tx => { tx.data = "0x6000"; }, tx => { tx.from = A(1); }, tx => { tx.value = "0x1"; }, tx => { tx.gas = q(3000001); }]) {
    const f = fixture({ harnessAction: async ({ local, f }) => {
      await local.call("anvil_setBalance", [api.LOCAL_FIXED.actor, q(api.LOCAL_FIXED.actorNativeFixtureWei)]);
      const tx = { from: api.LOCAL_FIXED.actor, data: f.prepared.creationData }; mutate(tx); await local.call("eth_sendTransaction", [tx]);
    } });
    const out = await f.run(); honest(out); assert.equal(out.outcome, "UNKNOWN"); assert.equal(f.sends.length, 0);
  }
});
test("OFFLINE_FIXTURE relay denies accountInfo/writes/latest state/unbound targets and witness state", async () => {
  const tx = { to: api.LOCAL_FIXED.bindings.usdc, data: "0x12345678" };
  for (const request of [payload("eth_getAccountInfo", [A(1), q(PIN.number + 1)]), payload("eth_sendRawTransaction", ["0x12"]), payload("eth_sendTransaction", [tx]),
    payload("eth_getCode", [A(1), "latest"]), payload("eth_getBalance", [A(888), q(PIN.number + 1)]), payload("eth_getBlockByHash", [H(999999), false]),
    payload("eth_getBlockByNumber", [q(PIN.number - 256), false]), payload("eth_call", [tx, "latest"])]) {
    const f = fixture({ harnessAction: ({ hd, primary }) => hd.transport(primary, request) }), out = await f.run(); honest(out); assert.equal(out.outcome, "UNKNOWN"); assert.equal(f.sends.length, 0);
    assert.ok(!f.calls.some(c => c.payload.id === "OFFLINE_REJECTED_PROBE"));
  }
  const f = fixture({ harnessAction: ({ hd, f }) => hd.transport(f.candidates[1].handle, payload("eth_getCode", [api.GPO, q(PIN.number + 1)])) });
  assert.equal((await f.run()).simulation.failure.code, "WITNESS_STATE_REJECTED");
});
test("OFFLINE_FIXTURE readiness is one-shot and provider resolution has no fallback", async () => {
  const f = fixture({ harnessAction: async ({ hd, local, f }) => {
    assert.equal(hd.resolveUpstream(8453), null); assert.deepEqual(hd.loadRpcUrls(), [f.candidates[0].handle]);
    await hd.waitReady({ exitCode: null, signalCode: null }, local, { chainId: "8453", pinBlockNumber: String(PIN.number + 1), pinBlockHash: H(PIN.number + 1), pinStateRoot: PIN.stateRoot });
  } });
  const out = await f.run(); honest(out); assert.equal(out.simulation.failure.code, "READINESS_ALREADY_USED"); assert.equal(f.sends.length, 0);
});
test("OFFLINE_FIXTURE protected core/cost/config files remain byte-identical", () => {
  for (const [file, expected] of Object.entries(protectedHashes)) assert.equal(sha(fs.readFileSync(path.join(ROOT, file))), expected, file);
  for (const [file, expected] of Object.entries(api.CORE_SHA)) assert.equal(protectedHashes[file], expected, file);
  assert.equal(protectedHashes[COST_FILE], "414b42445ae4fa134ec71ae0c28c4937b14ee99655aefc7c632c869864f09e2f");
  assert.equal(protectedHashes["tools/test/base-usdc-usdt-simulation-costs.test.js"], "926ceff1259aa6f2eae582ded9da427caa3385cd1fdb4501c9ff4b33783e84bd");
});

test("OFFLINE_FIXTURE shared request ceiling includes qualification, lazy fork, local execution and actual fees", async () => {
  const markers = {}, options = {}, baseline = fixture(options);
  options.onUpstream = ({ payload: p }) => {
    if (p.id === 1000) markers.fork = baseline.calls.length + baseline.localCalls.length;
    if (p.method === "eth_call" && p.params[0].to.toLowerCase() === api.GPO && markers.fees === undefined)
      markers.fees = baseline.calls.length + baseline.localCalls.length;
  };
  options.onLocal = ({ method }) => { if (method === "eth_sendTransaction" && markers.local === undefined) markers.local = baseline.calls.length + baseline.localCalls.length; };
  const complete = await baseline.run(); honest(complete); assert.equal(complete.outcome, "POSITIVE_AT_PIN");
  assert.ok(markers.fork < markers.local && markers.local < markers.fees);
  for (const stage of ["fork", "local", "fees"]) {
    const f = fixture({ budget: { requests: markers[stage] } }), out = await f.run(); honest(out);
    assert.equal(out.outcome, "UNKNOWN"); assert.equal(out.failure.code, "CAMPAIGN_REQUEST_CAP");
    assert.ok(out.budget.requests <= markers[stage]); assert.equal(out.budget.requests, f.calls.length + f.localCalls.length);
    if (stage === "fees") { assert.equal(f.sends.length, 2); assert.deepEqual(out.simulation.cleanup, { child: "STOPPED", relay: "CLOSED" }); }
    else assert.equal(f.sends.length, 0);
  }
});
test("OFFLINE_FIXTURE shared byte reservation includes a local operation and its lazy upstream read", async () => {
  const options = {}, f = fixture(options); await f.qualify();
  options.harnessAction = async ({ local, hd, primary }) => {
    options.onLocal = async ({ method }) => {
      if (method === "eth_chainId") {
        for (let i = 0; i < 64; i++) await hd.transport(primary, payload("eth_chainId"));
      }
    };
    options.consumeAllowance = true;
    await local.call("eth_chainId", []);
  };
  const out = await f.evaluate(); honest(out); assert.equal(out.outcome, "UNKNOWN");
  assert.equal(out.failure.code, "CAMPAIGN_BYTE_CAP"); assert.ok(out.budget.bytes <= 67108864);
  assert.equal(out.budget.requests, f.calls.length + f.localCalls.length); assert.equal(f.sends.length, 0);
});
test("OFFLINE_FIXTURE per-read deadlines and explicit pacing cover lazy fork and fee getters", async () => {
  const f = fixture({ spacing: 1, budget: { requestMs: 73 } }), out = await f.run(); honest(out); assert.equal(out.outcome, "POSITIVE_AT_PIN");
  assert.ok(f.calls.every(c => c.timeout > 0 && c.timeout <= 73 && c.timeout <= f.approval.expiresAtMs - c.at));
  assert.ok(f.calls.slice(1).every((c, i) => c.at - f.calls[i].at >= 1)); assert.equal(f.maxActive, 1);
  assert.equal(out.budget.requests, f.calls.length + f.localCalls.length);
});
test("OFFLINE_FIXTURE deadline during local RPC still drains and attempts bounded cleanup", async () => {
  const options = {}, f = fixture(options); await f.qualify(); let changed = false;
  options.onLocal = ({ method }) => { if (method === "eth_getTransactionByHash" && !changed) { changed = true; f.setTick(f.approval.expiresAtMs); } };
  const out = await f.evaluate(); honest(out); assert.equal(out.outcome, "UNKNOWN"); assert.equal(out.failure.code, "CAMPAIGN_EXPIRED");
  assert.equal(f.localCalls.filter(c => c.method === "anvil_stopImpersonatingAccount").length, 1);
  assert.deepEqual(out.simulation.cleanup, { child: "STOPPED", relay: "CLOSED" }); assert.equal(f.sends.length, 1);
});
test("OFFLINE_FIXTURE unawaited local work is drained, with no result while a receipt is pending", async () => {
  let release, entered; const gate = new Promise(r => { release = r; }), started = new Promise(r => { entered = r; });
  const options = {}, f = fixture(options); await f.qualify(); let detached;
  options.harnessAction = ({ local }) => {
    options.onLocal = async ({ method }) => { if (method === "eth_chainId") { entered(); await gate; } };
    detached = local.call("eth_chainId", []); detached.catch(() => {});
  };
  let done = false; const work = f.evaluate().then(out => { done = true; return out; }); await started;
  await new Promise(r => setImmediate(r)); assert.equal(done, false);
  release(); await detached; const out = await work; honest(out); assert.equal(out.outcome, "POSITIVE_AT_PIN");
});
test("OFFLINE_FIXTURE post-simulation source changes and terminal-number reorgs invalidate the result", async () => {
  for (const phase of ["source", "reorg", "runtime"]) {
    const options = {}, f = fixture(options); await f.qualify();
    options.onLocal = ({ method, params }) => {
      if (method === "eth_getTransactionByHash" && params[0] === H(2)) {
        if (phase === "source") options.changedFile = path.join(ROOT, COST_FILE);
        else if (phase === "reorg") options.headerReorg = true;
        else options.runtimeChanged = api.GPO;
      }
    };
    const out = await f.evaluate(); honest(out); assert.equal(out.outcome, "UNKNOWN"); assert.ok(out.failure); assert.equal(f.sends.length, 2);
    assert.equal(out.costs, undefined);
  }
});
test("OFFLINE_FIXTURE fee version failure, missing price and failing quote never promote", async () => {
  for (const options of [{ version: "unsupported" }, { missingBaseFee: true }]) {
    const f = fixture(options), out = await f.run(); honest(out); assert.equal(out.outcome, "UNKNOWN");
    if (options.version) assert.equal(out.costs.netUsdcRaw, null); else assert.equal(f.harnessCalls, 0);
  }
  const f = fixture({ failCall: "get_dy" }), out = await f.qualify(); honest(out); assert.equal(out.outcome, "UNKNOWN"); assert.equal(f.harnessCalls, 0);
});
test("OFFLINE_FIXTURE raw-unit zero/one net boundaries use actual corrected costs", async () => {
  for (const [gain, outcome, net] of [[6100000n, "NONPOSITIVE", "0"], [6100001n, "POSITIVE_AT_PIN", "1"]]) {
    const out = await fixture({ gain }).run(); honest(out); assert.equal(out.outcome, outcome); assert.equal(out.costs.netUsdcRaw, net);
  }
});
test("OFFLINE_FIXTURE explicit margins and uncertainty allowances are each deducted once", async () => {
  const f = fixture({ specEdit: s => { s.allowances.networkFeeMarginBps = 1000; s.allowances.ethConversionHaircutBps = 1000;
    s.allowances.slippageUsdcRaw = "11"; s.allowances.financingUsdcRaw = "13"; s.allowances.latencyUsdcRaw = "17";
    s.allowances.competitionUsdcRaw = "19"; s.allowances.otherUsdcRaw = "23"; } });
  const out = await f.run(); honest(out); assert.equal(out.costs.costs.networkUsdcRaw, "121000");
  assert.equal(out.costs.costs.explicitAllowancesUsdcRaw, "83"); assert.equal(out.costs.netUsdcRaw, "3878917");
});
test("OFFLINE_FIXTURE malformed receipt and failed owned transaction read retain UNKNOWN", async () => {
  for (const options of [{ localError: "eth_getTransactionByHash" }, { receiptEdit: r => { delete r.effectiveGasPrice; } },
    { receiptEdit: r => { r.gasUsed = q(3000001); } }, { receiptEdit: r => { r.from = A(2); } }]) {
    const f = fixture(options), out = await f.run(); honest(out); assert.equal(out.outcome, "UNKNOWN"); assert.equal(f.sends.length, 1);
    assert.equal(out.simulation.unsignedTransactions.length, 0);
  }
});
test("OFFLINE_FIXTURE complete unsigned transaction bytes, not calldata, feed each actual GPO getter", async () => {
  const f = fixture(), out = await f.run(); honest(out);
  const getters = f.calls.filter(c => c.payload.method === "eth_call" && c.payload.params[0].to.toLowerCase() === api.GPO)
    .map(c => GPO_ABI.parseTransaction(c.payload.params[0]));
  const exact = getters.filter(c => c.name === "getL1Fee"), upper = getters.filter(c => c.name === "getL1FeeUpperBound"), operator = getters.filter(c => c.name === "getOperatorFee");
  for (const [index, tx] of out.simulation.unsignedTransactions.entries()) {
    assert.equal(exact[index].args[0], tx.unsignedSerialized); assert.notEqual(exact[index].args[0], tx.input);
    assert.equal(upper[index].args[0], BigInt(tx.serializedByteLength)); assert.equal(operator[index].args[0], BigInt(tx.gas));
  }
});

test("OFFLINE_FIXTURE P2 replay: reordered validated public authority is still consumed", async () => {
  const f = fixture(); assert.equal((await f.qualify()).status, "READY");
  const reverseKeys = value => Array.isArray(value) ? value.map(reverseKeys) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).reverse().map(k => [k, reverseKeys(value[k])])) : value;
  const attempts = [Object.fromEntries(Object.entries(structuredClone(f.approval)).reverse()), reverseKeys(f.approval)];
  for (const key of ["budget", "pacing", "freshness", "sourceSha256"]) {
    const approval = structuredClone(f.approval); approval[key] = reverseKeys(approval[key]); attempts.push(approval);
  }
  const requests = f.calls.length;
  for (const approval of attempts) {
    assert.deepEqual(approval, f.approval); assert.notEqual(JSON.stringify(approval), JSON.stringify(f.approval));
    assert.deepEqual(approval.actions, f.approval.actions);
    await assert.rejects(api.qualifyCampaign(f.prepared, approval, structuredClone(f.candidates), f.deps), { code: "ATTEMPT_ALREADY_USED" });
    assert.equal(f.calls.length, requests); assert.equal(f.harnessCalls, 0);
    assert.ok(Object.isFrozen(approval)); assert.ok(Object.isFrozen(approval.budget));
  }
});
test("OFFLINE_FIXTURE P2 replay: distinct valid authority works; array order and scalar types remain binding", async () => {
  const f = fixture(); await f.qualify(); const requests = f.calls.length;
  for (const edit of [a => { a.actions.reverse(); }, a => { a.principalRaw = 1000000000; }, a => { a.budget.requests = "1000"; }]) {
    const approval = structuredClone(f.approval); edit(approval);
    await assert.rejects(api.qualifyCampaign(f.prepared, approval, structuredClone(f.candidates), f.deps), { code: "APPROVAL_REQUIRED" });
    assert.equal(f.calls.length, requests);
  }
  const fresh = structuredClone(f.approval); fresh.expiresAtMs--;
  const ready = await api.qualifyCampaign(f.prepared, fresh, structuredClone(f.candidates), f.deps);
  assert.equal(ready.status, "READY"); assert.equal(ready.evidenceOrigin, "OFFLINE_FIXTURE"); assert.ok(f.calls.length > requests);
  assert.equal(f.harnessCalls, 0);
});

for (const [kind, failure] of [["reorg", "HEAD_REORG"], ["expiry", "CAMPAIGN_EXPIRED"], ["malformed", "PIN_REJECTED"]]) {
  test(`OFFLINE_FIXTURE P2 cleanup: ${kind} invalidation waits for held owned local transaction read`, async () => {
    let release, entered; const gate = new Promise(r => { release = r; }), started = new Promise(r => { entered = r; });
    const options = {}, f = fixture(options); await f.qualify();
    options.onLocal = async ({ method, params }) => { if (method === "eth_getTransactionByHash" && params[0] === H(1)) { entered(); await gate; } };
    const terminal = [], head = f.head(), first = f.evaluate(head).then(out => { terminal.push(out); return out; });
    await started;
    let invalid = { ...head, hash: H(9999) };
    if (kind === "expiry") { f.setTick(f.approval.expiresAtMs); invalid = f.head(PIN.number + 2); }
    if (kind === "malformed") { invalid = { ...head }; delete invalid.stateRoot; }
    const second = f.evaluate(invalid).then(out => { terminal.push(out); return out; });
    const requests = f.calls.length;
    const denied = await f.hd.transport(f.candidates[0].handle, payload("eth_chainId")).then(() => null, error => error);
    await new Promise(r => setImmediate(r));
    const beforeRelease = { terminals: terminal.length, events: [...f.events], requests: f.calls.length, activeUpstream: f.active };
    release(); const results = await Promise.all([first, second]);
    assert.equal(denied?.code, kind === "expiry" ? "RUN_TIME_OR_AUTHORITY_EXHAUSTED" : failure);
    assert.equal(beforeRelease.terminals, 0, "no terminal UNKNOWN/clean counters while owned local work is held");
    assert.deepEqual(beforeRelease.events, ["HARNESS"]); assert.equal(beforeRelease.requests, requests); assert.equal(beforeRelease.activeUpstream, 0);
    for (const out of results) {
      honest(out); assert.equal(out.outcome, "UNKNOWN"); assert.equal(out.failure.code, failure);
      assert.deepEqual(out.simulation.cleanup, { child: "STOPPED", relay: "CLOSED" });
      assert.equal(out.simulation.local.executions, 0); assert.equal(out.budget.requests, f.calls.length + f.localCalls.length);
    }
    assert.equal(f.sends.length, 1); assert.equal(f.harnessCalls, 1);
    assert.equal(f.localCalls.filter(c => c.method === "anvil_stopImpersonatingAccount").length, 1);
    assert.deepEqual(f.events, ["HARNESS", "STOPPED", "CLOSED"]);
  });
}
test("OFFLINE_FIXTURE P2 cleanup: superseded/latest heads settle only after invalidated local owner cleans up", async () => {
  let release, entered; const gate = new Promise(r => { release = r; }), started = new Promise(r => { entered = r; });
  const options = {}, f = fixture(options); await f.qualify();
  options.onLocal = async ({ method, params }) => { if (method === "eth_getTransactionByHash" && params[0] === H(1)) { entered(); await gate; } };
  const terminal = [], collect = job => job.then(out => { terminal.push(out); return out; });
  const first = collect(f.evaluate(f.head())); await started;
  const superseded = collect(f.evaluate(f.head(PIN.number + 2))), latestHead = f.head(PIN.number + 3);
  const latest = collect(f.evaluate(latestHead)), invalidation = collect(f.evaluate({ ...latestHead, hash: H(9999) }));
  await new Promise(r => setImmediate(r)); const early = terminal.length;
  release(); const results = await Promise.all([first, superseded, latest, invalidation]);
  assert.equal(early, 0);
  for (const out of results) { honest(out); assert.equal(out.outcome, "UNKNOWN"); assert.equal(out.failure.code, "HEAD_REORG"); assert.deepEqual(out.simulation.cleanup, { child: "STOPPED", relay: "CLOSED" }); }
  assert.equal(f.harnessCalls, 1); assert.equal(f.sends.length, 1); assert.deepEqual(f.events, ["HARNESS", "STOPPED", "CLOSED"]);
});
test("OFFLINE_FIXTURE P2 cleanup: invalidation retains unconfirmed cleanup rather than manufacturing success", async () => {
  let release, entered; const gate = new Promise(r => { release = r; }), started = new Promise(r => { entered = r; });
  const options = { badCleanup: true }, f = fixture(options); await f.qualify();
  options.onLocal = async ({ method, params }) => { if (method === "eth_getTransactionByHash" && params[0] === H(1)) { entered(); await gate; } };
  const head = f.head(), first = f.evaluate(head); await started;
  const second = f.evaluate({ ...head, hash: H(9999) }); release();
  for (const out of await Promise.all([first, second])) {
    honest(out); assert.equal(out.outcome, "UNKNOWN"); assert.equal(out.failure.code, "HEAD_REORG");
    assert.deepEqual(out.simulation.cleanup, { child: "UNCONFIRMED", relay: "UNCONFIRMED" }); assert.equal(out.simulation.fixtureAssertionsPassed, false);
  }
});
test("OFFLINE_FIXTURE P2 cleanup: invalidation before a local child starts never claims STOPPED/CLOSED", async () => {
  let release, entered; const gate = new Promise(r => { release = r; }), started = new Promise(r => { entered = r; });
  const options = {}, f = fixture(options); await f.qualify(); let held = false;
  // The port's pre-simulation corroboration uses ID 1 after quote evaluation.
  options.onUpstream = async ({ payload: p }) => { if (p.id === 1 && !held) { held = true; entered(); await gate; } };
  const head = f.head(), first = f.evaluate(head); await started;
  const second = f.evaluate({ ...head, hash: H(9999) }); release();
  for (const out of await Promise.all([first, second])) {
    honest(out); assert.equal(out.outcome, "UNKNOWN"); assert.equal(out.simulation.local.readinessPhase, "NOT_STARTED");
    assert.deepEqual(out.simulation.cleanup, { child: "UNCONFIRMED", relay: "UNCONFIRMED" });
  }
  assert.equal(f.harnessCalls, 0); assert.deepEqual(f.events, []);
});
