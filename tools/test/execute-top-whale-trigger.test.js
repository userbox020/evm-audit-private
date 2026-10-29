"use strict";

// Import-inert, offline calldata/HTTP fixtures only: no inventory, wallet or RPC.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), { compileFunction } = require("node:vm");
const { createRequire } = require("node:module");
const { AbiCoder, Interface } = require("../node_modules/ethers");
const guard = require("../lib/wallet-execution-guard.js");
const FILE = path.resolve(__dirname, "../execute-top-whale-trigger.js"), native = createRequire(FILE);
const SOURCE = fs.readFileSync(FILE, "utf8");
const denied = () => assert.fail("offline fixture attempted external IO");
function loadRunner(fetchImpl = denied, fixtureFs = new Proxy({}, { get: () => denied })) {
  const module = { exports: {} };
  const req = name => name === "node:fs" ? fixtureFs :
    name === "./lib/m32-attended-call.cjs" ? denied() : native(name);
  compileFunction(fs.readFileSync(FILE, "utf8").replace(/^#![^\n]*\n/, ""),
    ["require", "module", "exports", "__dirname", "__filename", "fetch"], { filename: FILE })
    (req, module, module.exports, path.dirname(FILE), FILE, fetchImpl);
  return module.exports;
}
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", SYRUP = "0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b";
const KYBER = "0x6131b5fae19ea4f9d964eac0408e4408b66337b5", EXECUTOR = "0x2d5bca1b846e89965544c7f03d09a25126803627";
const payload = amount => "0xe21fd0e9" + amount.toString(16).padStart(64, "0") + "00".repeat(32);
const response = value => ({ ok: true, json: async () => value });
const NOW = Date.parse("2026-10-28T00:00:00Z"), PIN = { chainId: 1, number: 1000, hash: "0x" + "11".repeat(32), timestamp: NOW / 1000, baseFeePerGas: "1" };
const ETH_USD = "0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419", ETH_USD8 = 240000000000n;
const round = ({ roundId = 12n, answer = ETH_USD8, updatedAt = BigInt(PIN.timestamp), answeredInRound = roundId } = {}) =>
  AbiCoder.defaultAbiCoder().encode(["uint80", "int256", "uint256", "uint256", "uint80"], [roundId, answer, updatedAt, updatedAt, answeredInRound]);
const uintResult = value => AbiCoder.defaultAbiCoder().encode(["uint256"], [value]);
function memoryFs(files) {
  const reads = [];
  return { reads, existsSync: filename => Object.hasOwn(files, filename), readFileSync: (filename, encoding) => {
    assert.equal(encoding, "utf8"); assert.ok(Object.hasOwn(files, filename), filename); reads.push(filename);
    return typeof files[filename] === "string" ? files[filename] : JSON.stringify(files[filename]);
  } };
}
test("batch renewal is read only at/after a valid primary expiry and only when present", () => {
  for (const [expiresAt, now, present, renewed] of [
    [new Date(NOW).toISOString(), NOW - 1, true, false], [new Date(NOW).toISOString(), NOW, true, true],
    [new Date(NOW).toISOString(), NOW + 1, true, true], [new Date(NOW).toISOString(), NOW, false, false],
    ["invalid", NOW, true, false], [undefined, NOW, true, false],
  ]) {
    const primary = { id: "historical", schema: "live-execution-batch/v1", approved: true, approvedAt: "2026-10-25T00:00:00Z", expiresAt }, renewal = { id: "renewal", expiresAt: "2026-11-03T23:59:59Z" };
    const io = memoryFs({ primary, ...(present ? { renewal } : {}) }), api = loadRunner(denied, io);
    assert.equal(api.readBatchWithRenewal("primary", "renewal", now).id, renewed ? renewal.id : primary.id);
    assert.deepEqual(io.reads, renewed ? ["primary", "renewal"] : ["primary"]);
  }
});
test("batch renewal rereads revisions, defaults to wall time, and does not hide malformed JSON", () => {
  const files = { primary: { schema: "live-execution-batch/v1", approved: true, approvedAt: "1999-12-31T00:00:00Z", expiresAt: "2000-01-01T00:00:00Z" }, renewal: { approved: true } };
  const api = loadRunner(denied, memoryFs(files));
  assert.equal(api.readBatchWithRenewal("primary", "renewal").approved, true);
  files.renewal = { approved: false };
  assert.equal(api.readBatchWithRenewal("primary", "renewal").approved, false);
  files.renewal = "{";
  assert.throws(() => api.readBatchWithRenewal("primary", "renewal"), SyntaxError);
  files.primary = "{";
  assert.throws(() => api.readBatchWithRenewal("primary", "renewal"), SyntaxError);
});
// Real selector fixtures: no injected candidates, native-profit proof or admission bypass.
function literal(name) {
  const match = SOURCE.match(new RegExp(`\\b${name} = "(0x[0-9a-f]+)"`));
  assert.ok(match, name); return match[1];
}
function contractInterface(name) {
  const match = SOURCE.match(new RegExp(`const ${name} = new Interface\\(\\["([^"]+)"\\]\\)`));
  assert.ok(match, name); return new Interface([match[1]]);
}
function tokenFixture(api, route) {
  const W = 10n ** 18n, zero = "0x" + "00".repeat(20);
  let { candidate, plan } = fixture(api), id = candidate.id, data = candidate.data;
  let iface = api.M2_EXEC_IFACE, field = "readyExecuteCurveUnwindCalldata";
  if (route === "M10") {
    id = "targetM10_Morpho_USDe_RLUSD";
    plan = { ...plan, loanToken: literal("RLUSD"), collateralToken: literal("USDE"), oracle: literal("M10_ORACLE"),
      borrower: literal("M10_BORROWER"), seizedAssets: 35000n * W, swapTarget: literal("UNI_ROUTER"), minLoanOut: 34900n * W };
    const swap = contractInterface("UNIV3_EXACT_INPUT_IFACE").encodeFunctionData("exactInput", [{
      path: literal("M10_PATH"), recipient: EXECUTOR, deadline: 9999999999n, amountIn: plan.seizedAssets, amountOutMinimum: 34800n * W }]);
    data = iface.encodeFunctionData("execute", [plan, swap]);
  } else if (route === "M16") {
    id = "targetM16_Morpho_apyUSD_apxUSD";
    plan = { ...plan, loanToken: literal("M16_APXUSD"), collateralToken: literal("M16_APYUSD"), oracle: literal("M16_ORACLE"),
      borrower: literal("M16_BORROWER"), lltv: 860000000000000000n, seizedAssets: 10000n * W,
      swapTarget: literal("CURVE_APY_APX"), minLoanOut: 11000n * W };
    data = iface.encodeFunctionData("execute", [plan, api.CURVE_EXCHANGE_IFACE.encodeFunctionData("exchange", [0, 1, plan.seizedAssets, plan.minLoanOut])]);
  } else if (route === "M8" || route === "M14") {
    iface = contractInterface("PENDLE_PT_EXEC_IFACE"); field = "readyExecutePendlePtCalldata";
    const dai = route === "M8";
    id = dai ? "targetM8_Morpho_PT_USDe_DAI" : "targetM14_Morpho_PT_USDat_USDC";
    plan = { ...plan, loanToken: dai ? literal("DAI") : USDC, collateralToken: literal(dai ? "PT_USDE" : "M14_PT"),
      oracle: literal(dai ? "PT_ORACLE" : "M14_ORACLE"), borrower: literal(dai ? "M8_BORROWER" : "M14_BORROWER"),
      pendleYt: literal(dai ? "PENDLE_YT" : "M14_YT"), pendleSy: literal(dai ? "PENDLE_SY" : "M14_SY"),
      redeemedToken: literal(dai ? "USDE" : "USDAT"), swapTarget: literal(dai ? "UNI_ROUTER" : "CURVE_USDAT_USDC"),
      seizedAssets: dai ? 30000n * W : 5400000000n, minLoanOut: dai ? 30200n * W : 5425000000n };
    const swap = dai ? "0x1234567890" : api.CURVE_EXCHANGE_IFACE.encodeFunctionData("exchange", [1, 0, plan.seizedAssets, plan.minLoanOut]);
    data = iface.encodeFunctionData("execute", [plan, swap]);
  } else if (route === "F1" || route === "F2") {
    iface = contractInterface("UNIVERSAL_EXEC_IFACE"); field = "readyExecuteUniversalCalldata";
    const usdt = route === "F1";
    id = usdt ? "targetF1_Fluid_USDe_USDT_Vault93" : "targetF2_Fluid_eBTC_cbBTC_Vault96";
    const defaults = Object.fromEntries(iface.getFunction("execute").inputs[0].components.map(p =>
      [p.name, p.type === "address" ? zero : p.type === "bytes" ? "0x" : p.type === "bool" ? false : 0n]));
    plan = { ...defaults, mode: 1, loanToken: literal(usdt ? "USDT" : "WBTC"), borrower: literal(usdt ? "F1_BORROWER" : "F2_BORROWER"),
      fluidVault: literal(usdt ? "F1_VAULT_93" : "F2_VAULT_96"), flashAmount: 1000000000n, minProfit: usdt ? 5000000n : 100000n };
    data = iface.encodeFunctionData("execute", [plan]);
  } else assert.equal(route, "M31");
  const row = { user: plan.borrower, liquidatableNow: true, executableNow: true, [field]: data };
  [candidate] = api.selectCandidates({ targets: { [id]: row } });
  assert.ok(candidate, `${route} must pass real selection, not hold on malformed calldata`);
  assert.equal(candidate.data, data);
  return { id, row, candidate, iface };
}
async function nativeProfitHeld(t, api, fixtures, options = {}) {
  const spies = ["reconcileWallet", "acquireWalletLock", "executeGuarded", "buildFees", "signWithProcessKey"]
    .map(name => t.mock.method(guard, name, denied));
  const targets = Object.fromEntries(fixtures.map(f => [f.id, f.row])), before = structuredClone(targets);
  const candidates = api.selectCandidates({ targets });
  assert.equal(candidates.length, fixtures.length);
  for (const candidate of candidates) {
    assert.equal(candidate.conservativeProfitBeforeGasWei, undefined);
    assert.equal(candidate.variantProfitByBps, undefined);
    assert.ok((candidate.minProfitUsdc ?? candidate.minProfitRaw) > 0n);
  }
  const pinned = { pin: PIN, evidence: {}, assertUsable() {}, recheck: async () => {},
    call: t.mock.fn(async call => {
      if (call.to === ETH_USD) {
        const feed = Object.hasOwn(options, "feed") ? options.feed : round();
        if (feed instanceof Error) throw feed;
        return feed;
      }
      const f = fixtures.find(f => f.candidate.executor === call.to && f.candidate.data === call.data);
      assert.ok(f, "only the exact nominated token-settlement simulation is available");
      if (options.simulation) return options.simulation(f);
      return f.iface.encodeFunctionResult("execute", f.iface.getFunction("execute").outputs.length ? [f.candidate.minProfitRaw * 2n] : []);
    }), estimateGas: t.mock.fn(denied), nonce: t.mock.fn(denied), send: t.mock.fn(denied), receipt: t.mock.fn(denied) };
  const signTransaction = t.mock.fn(denied);
  const out = await api.runPass({ execute: true, argv: ["--no-write"], batch: approvedBatches(api).batch,
    loadMorphoBatch: denied, pinned, now: () => NOW, signTransaction,
    checkOnce: async options => ({ pin: PIN, targets: options.m1Only ? {} : targets }), ...options.runOptions });
  assert.equal(out.fired, false); assert.equal(out.summary.armed, false); assert.equal(out.summary.ok, true);
  assert.equal(out.summary.reason, "NO_CANDIDATE_PASSED_PREFLIGHT"); assert.equal(out.summary.candidateCount, fixtures.length);
  assert.deepEqual(out.summary.preflightFailures, candidates.map(c => ({ targetId: c.id, reason: "PROFIT_UNVERIFIED" })));
  assert.equal(out.summary.execution, undefined);
  for (const fn of [...spies, pinned.call, pinned.estimateGas, pinned.nonce, pinned.send, pinned.receipt, signTransaction])
    assert.equal(fn.mock.callCount(), 0, "unverified profit must hold before simulation, wallet, fees, nonce or signing");
  assert.deepEqual(targets, before, "no native-profit metadata is synthesized into collector rows");
  for (const spy of spies) spy.mock.restore();
  return out;
}
for (const [route, kind, token] of [
  ["M31", "MORPHO_BLUE_M2", "USDC"], ["M10", "MORPHO_BLUE_M2", "RLUSD"], ["M16", "MORPHO_BLUE_M2", "M16_APXUSD"],
  ["M14", "MORPHO_PENDLE_PT_REDEEM", "USDC"], ["M8", "MORPHO_PENDLE_PT_REDEEM", "DAI"],
  ["F1", "UNIVERSAL_FLUID_MORPHO_LIQUIDATION", "USDT"],
]) test(`${route} ${kind}: fresh ETH/USD and successful token simulation cannot authorize native profit`, async t => {
  const api = loadRunner(), f = tokenFixture(api, route);
  assert.equal(f.candidate.kind, kind); assert.equal(f.candidate.profitToken, literal(token));
  await nativeProfitHeld(t, api, [f]);
});
test("invalid, failed, stale or future ETH/USD still holds without attempting a conversion", async t => {
  const api = loadRunner();
  for (const feed of [undefined, "0x", "0x" + "00".repeat(159), "0x" + "gg".repeat(160), round() + "0",
    round({ answer: 0n }), round({ answer: -1n }), round({ answeredInRound: 11n }), round({ updatedAt: 0n }),
    round({ updatedAt: BigInt(PIN.timestamp) - 3601n }), round({ updatedAt: BigInt(PIN.timestamp) + 1n }), new Error("READ_FAILED")]) {
    await nativeProfitHeld(t, api, [tokenFixture(api, "M31")], { feed });
  }
});
test("ETH/USD at the old age boundary cannot authorize any token-only candidate", async t => {
  const api = loadRunner();
  await nativeProfitHeld(t, api, [tokenFixture(api, "M31"), tokenFixture(api, "M8")], {
    feed: round({ updatedAt: BigInt(PIN.timestamp) - 3600n }),
    simulation: f => { if (f.candidate.kind === "MORPHO_BLUE_M2") throw Error("SIMULATION_REVERTED"); return "0x"; },
  });
});
test("positive token floors with successful, failed, malformed or below-floor simulations remain unverified", async t => {
  const api = loadRunner();
  for (const [route, simulation] of [["M31", "0x"], ["M31", uintResult(5n)], ["M14", "0x00"],
    ["M8", new Error("SIMULATION_REVERTED")], ["F1", "0x"], ["F1", uintResult(0n)], ["F1", uintResult(1n)],
    ["F1", uintResult(4999999n)], ["F1", uintResult(5000000n)], ["F1", uintResult(10n ** 24n)]]) {
    await nativeProfitHeld(t, api, [tokenFixture(api, route)], { simulation: () => {
      if (simulation instanceof Error) throw simulation; return simulation;
    } });
  }
});
test("unsupported token and peg/depeg display hints cannot supply exact liquid-native evidence", async t => {
  const api = loadRunner();
  await nativeProfitHeld(t, api, [tokenFixture(api, "F2")]);
  // The same ETH/USD feed and token-only settlement do not establish a token's
  // liquid exit, whether an untrusted display calls it pegged or depegged.
  for (const tokenUsdPrice of [1, 0.99, 0.4, 0]) {
    const f = tokenFixture(api, "M31");
    f.row.liveQuote = { tokenUsdPrice, verified: true, conservativeNetUsd: 5 };
    f.row.conservativeProfitBeforeGasWei = "1000000000000000000";
    f.row.variantProfitByBps = { 10000: "1000000000000000000" };
    await nativeProfitHeld(t, api, [f]);
  }
});
function approvedBatches(api) {
  const base = { schema: "live-execution-batch/v1", approved: true, approvedAt: "2026-10-25T00:00:00Z", expiresAt: "2026-11-03T23:59:59Z", chainId: 1,
    chain: "ethereum", account: { address: guard.MAIN_ACCOUNT } };
  return {
    batch: { ...base, targets: api.REQUIRED_TARGETS.map(address => ({ address })),
      actions: ["liquidator.executeMorpho(uint256 flashAmount, UnifiedLiquidationParams params) when net > 0"],
      caps: { maxExecutionGasLimit: 1500000, maxExecutionSpendWei: "2000000000000000", signedExecutionsPerDay: 3,
        slippageFloor: "minDebtTokenOut >= quoted * 0.995; minProfitDebtToken > 0", principalAtRisk: "zero (atomic settlement)" } },
    morphoBatch: { ...base, targets: [api.MORPHO_EXECUTOR, api.M2_EXECUTOR, "0xba12222222228d8ba445958a75a0704d566bf2c8"].map(address => ({ address })),
      actions: ["executor.execute(MarketParams, borrower, seizedAssets, repaidShares, minProfitWei, minOut, router, routerSwapData)"],
      caps: { maxGasLimitPerTransaction: 2000000, maxNativeSpendPerTransactionWei: "2000000000000000", signedExecutionsPerDay: 3 } },
  };
}
function batchFiles(batches) {
  return Object.fromEntries([["live-execution-batch-aave-v4-v3-morpho", batches.batch], ["live-execution-batch-morpho-trigger", batches.morphoBatch]]
    .flatMap(([name, value]) => [[path.resolve(__dirname, "../../coordination", name + ".json"), { ...value, expiresAt: "2026-10-26T23:59:59Z" }],
      [path.resolve(__dirname, "../../coordination", name + "-renewal-20261027.json"), value]]));
}
test("runPass default renewal loader still rereads approval but token-only profit holds before wallet admission", async t => {
  const batches = approvedBatches(loadRunner()), io = memoryFs(batchFiles(batches)), api = loadRunner(denied, io);
  const expectedReads = Object.keys(batchFiles(batches)).filter(name => name.includes("aave-v4-v3-morpho"));
  await nativeProfitHeld(t, api, [tokenFixture(api, "M31")], { runOptions: { batch: undefined, loadMorphoBatch: undefined } });
  assert.deepEqual(io.reads, expectedReads, "unsigned admission hold stops before post-reconciliation approval reload");
  await nativeProfitHeld(t, api, [tokenFixture(api, "M31")], { runOptions: { batch: undefined, loadMorphoBatch: undefined } });
  assert.deepEqual(io.reads, [...expectedReads, ...expectedReads], "each new pass rereads the primary and its renewal");
  assert.ok(io.reads.every(filename => !filename.includes("morpho-trigger")), "held candidate must not enter execution-batch preparation");
});
test("runPass check-only skips default batch IO and profit derivation", async () => {
  const api = loadRunner(), { candidate, plan } = fixture(api);
  const out = await api.runPass({ argv: ["--check", "--no-write"], now: () => NOW,
    pinned: { pin: PIN, evidence: {}, assertUsable() {}, recheck: async () => {}, call: denied },
    checkOnce: async options => ({ pin: PIN, targets: options.m1Only ? {} : {
      [candidate.id]: { user: plan.borrower, liquidatableNow: true, readyExecuteCurveUnwindCalldata: candidate.data },
    } }) });
  assert.equal(out.fired, false); assert.equal(out.summary.candidateCount, 1);
});
for (const mode of ["default", "batch", "loader"]) test(`main ${mode} loaders preserve explicit injections and expiry renewal selection`, async () => {
  const batches = approvedBatches(loadRunner()), io = memoryFs(batchFiles(batches));
  const api = loadRunner(denied, mode === "default" ? io : new Proxy({}, { get: () => denied }));
  let passes = 0;
  await api.main(["--check", "--no-write"], { wallNow: () => NOW, loadCandidates: () => [], connect: async () => ({ pin: PIN }),
    output: () => {}, ...(mode === "batch" ? batches : mode === "loader" ? { batch: null, morphoBatch: null,
      loadBatch: () => batches.batch, loadMorphoBatch: () => batches.morphoBatch } : {}),
    runPass: async options => {
      passes++; assert.deepEqual(options.batch, batches.batch);
      assert.deepEqual(options.loadBatch(), batches.batch); assert.deepEqual(options.loadMorphoBatch(), batches.morphoBatch);
      return { summary: {} };
    } });
  assert.equal(passes, 1);
});
async function collect(iterator) { const rows = []; for await (const row of iterator) rows.push(row); return rows; }
function fixture(api, changes = {}, swapData = payload(740000000n)) {
  const plan = { loanToken: USDC, collateralToken: SYRUP, oracle: "0x80032f4cb6e3573b9ed61e888af658e48fb790cc",
    irm: "0x870ac11d48b15db9a138cf899d20f13f79ba00bc", lltv: 915000000000000000n,
    borrower: "0x950fd558f47e234a2fde23b7d61f7ccdbcb4a86f", seizedAssets: 740000000n,
    swapTarget: KYBER, minLoanOut: 819000000n, ...changes };
  const candidate = { id: "targetM31_Morpho_syrupUSDC_USDC", kind: "MORPHO_BLUE_M2", executor: EXECUTOR,
    data: api.M2_EXEC_IFACE.encodeFunctionData("execute", [plan, swapData]), seizedAssets: plan.seizedAssets,
    minLoanOut: plan.minLoanOut, minOutUsdc: 819000001n, minProfitUsdc: 5000000n, skipCurveQuote: true };
  return { candidate, plan };
}
const TARGET_2K = "target2K_AaveV3_WETH_WETH_0x7a05", TARGET_A13 = "targetA13_AaveV4_wstETH_WETH_0x4cd7";
function aaveSelectionFixture(api, flashAmount = 5400000000000000000n) {
  const weth = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", zero = "0x" + "00".repeat(20);
  const router = "0xe592427a0aece92de3edee1f18e0157c05861564";
  const params = { isAaveV3: true, target: "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2",
    borrower: "0x7a0575018b57cb64434fcd794f4f0c624fd0fbd3", debtToken: weth, collateralToken: weth,
    collateralReserveId: 0n, debtReserveId: 0n, minCollateralSeized: 0n, swapKind: 0,
    swapTarget: zero, swapSpender: zero, uniFee: 0, curveI: 0, curveJ: 0,
    minDebtTokenOut: 0n, minProfitDebtToken: 10000000000000000n };
  const a13 = { ...params, isAaveV3: false, target: "0xe1900480ac69f0b296841cd01cc37546d92f35cd",
    borrower: "0x4cd76521f616db4d6978a4a80aeb77ccc9e890ec", collateralToken: "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0",
    debtReserveId: 1n, minCollateralSeized: 1000000000000000000n, swapKind: 1, swapTarget: router,
    swapSpender: router, uniFee: 100, minDebtTokenOut: flashAmount + params.minProfitDebtToken };
  return { targets: Object.fromEntries([[TARGET_2K, params], [TARGET_A13, a13]].map(([id, plan]) => [id, {
    user: plan.borrower, liquidatableNow: true, readyExecuteMorphoCalldata: api.UNIFIED_IFACE.encodeFunctionData("executeMorpho", [flashAmount, plan]),
  }])) };
}
test("2K selection requires the updated exact 5.40 WETH flash amount", () => {
  const api = loadRunner(), status = aaveSelectionFixture(api);
  const row = api.selectCandidates(status).find(row => row.id === TARGET_2K);
  assert.equal(row.flashAmount, 5400000000000000000n);
  assert.equal(row.params.minProfitDebtToken, 10000000000000000n);
  assert.throws(() => api.selectCandidates(aaveSelectionFixture(api, 5000000000000000000n)), /EXECUTION_ROUTE_NOT_ALLOWED/);
});
for (const field of ["readyExecuteCurveUnwindCalldata", "readyExecuteReusdCalldata"])
  for (const stub of ["0xe21fd0e9", "0xE21FD0E9"]) test(`M31 ${field} selector stub ${stub} does not block 2K or A13 selection`, () => {
    const api = loadRunner(), status = aaveSelectionFixture(api), { candidate, plan } = fixture(api, {}, stub);
    status.targets[candidate.id] = { user: plan.borrower, liquidatableNow: true, [field]: candidate.data };
    const rows = api.selectCandidates(status);
    assert.deepEqual(rows.map(row => row.id).sort(), [TARGET_2K, TARGET_A13]);
    assert.equal(rows.find(row => row.id === TARGET_2K).flashAmount, 5400000000000000000n);
  });
test("M31 hydrated payload remains selectable and target validation stays enforced for stubs", () => {
  const api = loadRunner(), { candidate, plan } = fixture(api);
  const status = { targets: { [candidate.id]: { user: plan.borrower, liquidatableNow: true, readyExecuteCurveUnwindCalldata: candidate.data } } };
  assert.equal(api.selectCandidates(status)[0].data, candidate.data);
  status.targets[candidate.id].readyExecuteCurveUnwindCalldata = fixture(api, { swapTarget: EXECUTOR }, "0xe21fd0e9").candidate.data;
  assert.throws(() => api.selectCandidates(status), /EXECUTION_TARGET_MISMATCH/);
});
test("M31 invalid selectors and truncated non-stub payloads still reject the selection pass", () => {
  const api = loadRunner();
  for (const data of ["0x", "0x12345678", "0x12345678" + "00".repeat(64), "0xe21fd0e900", "0xe21fd0e9" + "00".repeat(45)]) {
    const status = aaveSelectionFixture(api), { candidate, plan } = fixture(api, {}, data);
    status.targets[candidate.id] = { user: plan.borrower, liquidatableNow: true, readyExecuteCurveUnwindCalldata: candidate.data };
    assert.throws(() => api.selectCandidates(status), /EXECUTION_ROUTE_NOT_ALLOWED/);
  }
});
test("M2 scaling retains a synchronous iterable array and unchanged Curve 100/50/25 sizing", async () => {
  const api = loadRunner();
  const swap = api.CURVE_EXCHANGE_IFACE.encodeFunctionData("exchange", [0, 1, 740000000n, 819000001n]);
  const { candidate } = fixture(api, {}, swap); Object.freeze(candidate);
  const rows = api.buildScaledM2Variants(candidate);
  assert.ok(Array.isArray(rows)); assert.equal(rows.then, undefined); assert.equal(rows[0], candidate);
  assert.deepEqual(Array.from(rows), rows); assert.deepEqual(rows.slice(1).map(row => row.bps), [5000, 2500]);
  for (const [i, row] of rows.entries()) {
    const [plan, data] = api.M2_EXEC_IFACE.decodeFunctionData("execute", row.data);
    const swap = api.CURVE_EXCHANGE_IFACE.decodeFunctionData("exchange", data);
    assert.equal(plan.seizedAssets, [740000000n, 370000000n, 185000000n][i]); assert.equal(swap[2], plan.seizedAssets);
    assert.equal(swap[3], [819000001n, 409500001n, 204750001n][i]);
  }
  assert.deepEqual(await collect(api.buildScaledM2VariantsWithKyber(candidate, denied)), rows);
});
test("M31 default async wrapper rebuilds exact half/quarter UniV4 routes with fixed executor recipients", async () => {
  const calls = [];
  const api = loadRunner(async (url, options) => {
    calls.push({ url, options });
    if (options.method === "GET") {
      const parsed = new URL(url);
      assert.equal(parsed.origin + parsed.pathname, "https://aggregator-api.kyberswap.com/ethereum/api/v1/routes");
      assert.equal(parsed.searchParams.get("tokenIn"), SYRUP); assert.equal(parsed.searchParams.get("tokenOut"), USDC);
      assert.equal(parsed.searchParams.get("includedSources"), "uniswap-v4");
      assert.equal(options.headers["x-client-id"], "opencode-audit");
      assert.ok(options.signal instanceof AbortSignal);
      return response({ data: { routeSummary: { amountIn: parsed.searchParams.get("amountIn") } } });
    }
    assert.equal(options.method, "POST"); assert.equal(url, "https://aggregator-api.kyberswap.com/ethereum/api/v1/route/build");
    assert.equal(options.headers["content-type"], "application/json"); assert.equal(options.headers["x-client-id"], "opencode-audit");
    assert.equal(options.signal, calls[calls.length - 2].options.signal);
    const body = JSON.parse(options.body);
    assert.deepEqual(body, { routeSummary: { amountIn: calls.length === 2 ? "370000000" : "185000000" },
      sender: EXECUTOR, recipient: EXECUTOR, slippageTolerance: 100, deadline: 2147483647 });
    return response({ data: { data: payload(BigInt(body.routeSummary.amountIn)) } });
  });
  const { candidate, plan: original } = fixture(api); Object.freeze(candidate);
  assert.deepEqual(api.buildScaledM2Variants(candidate), [candidate]); assert.equal(calls.length, 0);
  const iterator = api.buildScaledM2VariantsWithKyber(candidate), first = await iterator.next();
  assert.equal(first.value, candidate); assert.equal(calls.length, 0);
  const rows = [first.value, ...await collect(iterator)]; assert.equal(rows.length, 3); assert.equal(calls.length, 4);
  for (const [i, row] of rows.slice(1).entries()) {
    const [plan, data] = api.M2_EXEC_IFACE.decodeFunctionData("execute", row.data), factor = i === 0 ? 2n : 4n;
    assert.equal(plan.seizedAssets, original.seizedAssets / factor); assert.equal(data, payload(plan.seizedAssets));
    assert.equal(plan.minLoanOut, original.minLoanOut / factor); assert.equal(row.minLoanOut, plan.minLoanOut);
    assert.equal(row.minProfitUsdc, 5000000n / factor); assert.equal(row.minOutUsdc, (819000001n + factor - 1n) / factor);
    for (const key of ["loanToken", "collateralToken", "oracle", "irm", "borrower", "swapTarget"])
      assert.equal(plan[key].toLowerCase(), original[key]);
    assert.equal(plan.lltv, original.lltv); assert.equal(row.executor, EXECUTOR);
  }
});
test("M31 successful full-size consumption does not eagerly request reduced routes", async () => {
  const api = loadRunner(), { candidate } = fixture(api);
  for await (const row of api.buildScaledM2VariantsWithKyber(candidate, denied)) { assert.equal(row, candidate); break; }
});
for (const failure of ["reject", "missing", "invalid"]) test(`M31 unavailable half-size (${failure}) is skipped without blocking quarter-size`, async () => {
  const api = loadRunner(), { candidate } = fixture(api), calls = [];
  const rows = await collect(api.buildScaledM2VariantsWithKyber(candidate, async amount => {
    calls.push(amount);
    if (amount === 370000000n) {
      if (failure === "reject") throw Error("SYNTHETIC_ROUTE_FAILURE");
      return failure === "missing" ? null : "0xe21fd0e9";
    }
    return payload(amount);
  }));
  assert.deepEqual(calls, [370000000n, 185000000n]); assert.equal(rows.length, 2); assert.equal(rows[0], candidate);
  assert.equal(rows[1].bps, 2500); assert.equal(api.M2_EXEC_IFACE.decodeFunctionData("execute", rows[1].data)[1], payload(185000000n));
});
test("Kyber rebuilding is limited to the exact M31 token pair, router, executor and target", async () => {
  const api = loadRunner();
  for (const change of [{ loanToken: SYRUP }, { collateralToken: USDC }, { swapTarget: EXECUTOR }]) {
    const { candidate } = fixture(api, change);
    assert.deepEqual(await collect(api.buildScaledM2VariantsWithKyber(candidate, denied)), [candidate]);
  }
  for (const change of [{ executor: USDC }, { id: "targetM2_Morpho_reUSD_USDC" }]) {
    const candidate = { ...fixture(api).candidate, ...change };
    assert.deepEqual(await collect(api.buildScaledM2VariantsWithKyber(candidate, denied)), [candidate]);
  }
});
test("M31 async rebuilding preserves opt-in full ladder and per-size profit metadata", async () => {
  const api = loadRunner(), candidate = { ...fixture(api).candidate, useFullBpsLadder: true,
    variantProfitByBps: { 10000: 9n, 9500: 8n, 9000: null, 8000: 0n, 5000: 3n, 2500: 1n }, conservativeProfitBeforeGasWei: 2n };
  const rows = await collect(api.buildScaledM2VariantsWithKyber(candidate, async amount => payload(amount)));
  assert.deepEqual(rows.map(row => row.bps), [10000, 9500, 9000, 8000, 7000, 5000, 2500]);
  for (const row of rows) {
    assert.equal(row.seizedAssets, candidate.seizedAssets * BigInt(row.bps) / 10000n);
    assert.equal(row.conservativeProfitBeforeGasWei, candidate.variantProfitByBps[row.bps] ?? null);
  }
  assert.deepEqual(rows.map(row => row.conservativeProfitBeforeGasWei), [9n, 8n, null, 0n, null, 3n, 1n]);
  assert.equal(candidate.conservativeProfitBeforeGasWei, 2n);
});
test("M31 HTTP helper rejects zero size, failed responses, absent route summaries and malformed calldata", async () => {
  await assert.rejects(loadRunner().buildM31KyberUniV4SwapData(0n), /M31_KYBER_AMOUNT_INVALID/);
  for (const failure of ["route-http", "route-summary", "build-http", "build-data", "selector", "odd-hex"]) {
    let calls = 0;
    const api = loadRunner(async () => {
      if (++calls === 1) return failure === "route-http" ? { ok: false } :
        response(failure === "route-summary" ? {} : { data: { routeSummary: { amountIn: "1" } } });
      return failure === "build-http" ? { ok: false } : response({ data: { data: failure === "build-data" ? undefined :
        failure === "selector" ? "0x12345678" + "00".repeat(64) : payload(1n) + "0" } });
    });
    await assert.rejects(api.buildM31KyberUniV4SwapData(1n), /M31_KYBER_ROUTE_UNAVAILABLE/);
    assert.equal(calls, failure.startsWith("route-") ? 1 : 2);
  }
});
