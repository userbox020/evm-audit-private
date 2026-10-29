"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), { spawnSync } = require("node:child_process");
const { Interface, id } = require("ethers"), child = require("../observe-aave-v4-base-children");
const pinned = require("../lib/aave-v4-pinned-collection"), shared = require("../shared-rpc");
const ROOT = path.resolve(__dirname, "../.."), BASE = "reports/coverage-unblock-20261018/continuation/";
const HUB = "0xa4d5947eb727a052bae69c593ffc84247ec9864e", SPOKE = "0x17905db0e4a3514467539956c084180616ae7b8d";
const ORACLE = "0xabaf048fd7675ea34a84332371ffd5d55e322a47", IMPL = "0x81a73c282faa932de3b2541cee19549f4bf13b19";
const SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const H = n => "0x" + BigInt(n).toString(16).padStart(64, "0"), A = n => "0x" + BigInt(n).toString(16).padStart(40, "0");
const N = 52758870, NOW = Date.parse("2026-10-18T12:00:00.000Z"), HEX = n => "0x" + n.toString(16), clone = x => structuredClone(x);
let cachedInputs;
function inputs() {
  cachedInputs ||= child.buildPublicChildInputs({ workspace: ROOT, originalScopeFile: "tools/aave-v4-base-admission-scope.json",
    bindingsFile: BASE + "observed-price-child-bindings.json", childArchiveDirectory: BASE + "public-child-sources", parentArchiveDirectory: BASE + "public-base-sources" });
  return clone(cachedInputs);
}
function fixture() {
  const data = inputs(), model = child.validateChildPlan(data), state = { calls: [], operations: 0, elapsed: 0, hook: null, access: true,
    observation: BigInt(NOW / 1000 - 180), transmission: BigInt(NOW / 1000 - 90), answer: 100000000n, terminalFail: false };
  const pin = { number: N, hash: H(N), parentHash: H(N - 1), stateRoot: H(900), timestamp: NOW / 1000 - 60 };
  const file = name => data.evidence.files[name], originalSource = at => JSON.parse(fs.readFileSync(path.join(ROOT, "reports/base-aave-v4-admission-20261018/public-sources/" + at + ".json"))).runtimeBytecode.onchainBytecode;
  const codes = { [HUB]: originalSource(HUB), [SPOKE]: originalSource(SPOKE), [IMPL]: JSON.parse(file("reports/base-aave-v4-admission-20261018/public-sources/" + IMPL + ".json")).runtimeBytecode.onchainBytecode };
  const parentReceipt = JSON.parse(file(BASE + "public-base-sources/receipt.json"));
  codes[ORACLE] = JSON.parse(file(BASE + "public-base-sources/oracle.json")).runtimeBytecode.onchainBytecode;
  const ocr = JSON.parse(file(BASE + "public-child-sources/child-0.json")).runtimeBytecode.onchainBytecode;
  const eac = JSON.parse(file(BASE + "public-child-sources/child-7.json")).runtimeBytecode.onchainBytecode;
  for (const row of model.rows) {
    const ref = parentReceipt.rows.find(x => x.address === row.parent && x.status === "ARCHIVED") || parentReceipt.rows[1];
    codes[row.parent] = JSON.parse(file(BASE + "public-base-sources/" + ref.file)).runtimeBytecode.onchainBytecode;
    codes[row.child] = row.reserveId < 7 ? ocr : eac;
  }
  const interfaces = new Map();
  for (const target of new Set(model.operations.filter(op => op.kind === "call").map(op => op.target))) {
    const declarations = [...new Set(model.operations.filter(op => op.kind === "call" && op.target === target)
      .map(op => `function ${op.signature} view returns (${op.outputs.join(",")})`))];
    interfaces.set(target, new Interface(declarations));
  }
  const candidates = ["alchemy", "infura"].map((operatorFamily, i) => ({ handle: "SENTINEL_PRIVATE_CANDIDATE_" + i, operatorFamily, inventoryOrder: i }));
  const now = () => NOW + state.elapsed, header = n => ({ number: HEX(n), hash: H(n), parentHash: H(n - 1), stateRoot: pin.stateRoot,
    timestamp: HEX(pin.timestamp), ignored: "SENTINEL_PRIVATE_PIN" });
  const transport = async (handle, method, params, timeout, transportOptions) => {
    state.calls.push({ handle, method, params: clone(params), start: now(), timeout, maxBytes: transportOptions.maxBytes });
    assert.ok(timeout > 0 && timeout <= 10000); assert.equal(transportOptions.maxBytes, 4194304);
    const isState = ["eth_call", "eth_getStorageAt", "eth_getCode"].includes(method) && (method === "eth_call" ? params[0].to !== HUB : params[0] !== HUB);
    if (isState) state.operations++;
    if (state.hook) { const result = await state.hook(handle, method, params); if (result !== undefined) return result; }
    if (method === "eth_chainId") return "0x2105";
    if (method === "eth_getBlockByNumber") return state.terminalFail && state.operations ? { ...header(N), hash: H(999) } : header(params[0] === "finalized" ? N : Number(BigInt(params[0])));
    if (method === "eth_getLogs") { assert.deepEqual(params[0], { address: HUB, blockHash: H(N), topics: [H(0)] }); return []; }
    if (method === "eth_getCode") return codes[params[0]];
    if (method === "eth_getStorageAt") return params[0] === SPOKE && params[1] === SLOT ? "0x" + "0".repeat(24) + IMPL.slice(2) : H(0);
    if (method === "eth_call") {
      if (params[0].to === HUB) { assert.equal(params[0].data, id("getAssetCount()").slice(0, 10)); return H(8); }
      const at = params[0].to, iface = interfaces.get(at), parsed = iface.parseTransaction(params[0]); assert.ok(parsed);
      const parent = model.rows.find(row => row.parent === at), row = model.rows.find(row => row.child === at);
      const reserveIndex = parsed.name === "getReserveSource" ? Number(parsed.args[0]) : 0;
      const values = { ORACLE: [ORACLE], spoke: [SPOKE], decimals: [8], getReserveSource: [model.rows[reserveIndex].parent],
        aggregator: [parent ? parent.child : A(9000)], ASSET_TO_USD_AGGREGATOR: [model.rows[7].child], description: ["SENTINEL_PRIVATE_DESCRIPTION"],
        typeAndVersion: ["SENTINEL_PRIVATE_TYPE"], latestRoundData: [2, state.answer, state.observation, state.transmission, 2],
        latestConfigDetails: [1, N - 10, H(12)], latestConfigDigestAndEpoch: [false, H(12), 3], checkEnabled: [true], hasAccess: [state.access], phaseId: [2], accessController: [A(9001)] };
      if (parsed.name === "hasAccess") { assert.equal(parsed.args[0].toLowerCase(), row.parent); assert.equal(parsed.args[1], "0xfeaf968c"); }
      return iface.encodeFunctionResult(parsed.fragment, values[parsed.name]);
    }
    assert.fail("unexpected method");
  };
  const options = { ...data, candidates, transport, now, sleep: async ms => { state.elapsed += ms; } };
  const approve = () => { const p = child.validateChildPlan(options); options.approval = { schema: "base-child-observation-approval/v1", status: "CURRENT_IN_PROGRESS",
    attemptStarted: true, chainId: 8453, mode: "CHILDREN_101", originalScopeSha256: data.scope.originalScopeSha256, scopeDigest: p.scopeDigest,
    addressSetSha256: p.scope.addressSetSha256, targetCount: 46, planDigest: p.planDigest, evidenceDigest: p.evidenceDigest, codeDigest: p.codeDigest,
    qualificationCanaryDigest: child.digest(p.canary), budget: clone(p.readset.limits), issuedAtMs: now(), expiresAtMs: now() + 240000,
    candidatesDigest: child.digest(candidates) }; };
  approve(); return { options, state, model, codes, pin, header, interfaces, approve };
}
function closed(out) { assert.equal(out.closed, true); assert.equal(out.coverage.complete, false); assert.equal(out.classSemantics.exact, false);
  for (const key of ["promotion", "coveragePromotion", "dispatchEnabled", "liveAdmission", "baseGuardQualified"]) assert.equal(out[key], false);
  assert.equal(out.freshness, "UNKNOWN"); assert.doesNotMatch(JSON.stringify(out), /SENTINEL_PRIVATE|https?:/); }
test.beforeEach(t => { t.mock.method(global, "fetch", () => assert.fail("network forbidden")); t.mock.method(shared, "loadRpcUrls", () => assert.fail("inventory forbidden")); });

test("import/default CLI check has no ambient file/provider/inventory discovery; capture CLI refuses", async () => {
  const code = `const M=require('node:module'),old=M._load;M._load=function(n,...a){if(/node:fs|pinned-collection|admit-aave|shared-rpc|ethers/.test(n))throw Error('ambient');return old.call(this,n,...a)};require('./tools/observe-aave-v4-base-children').runCli(['--check']).then(x=>console.log(JSON.stringify(x)));`;
  const result = spawnSync(process.execPath, ["-e", code], { cwd: ROOT, encoding: "utf8" }); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).networkCalls, 0); assert.equal((await child.runCli(["--capture"])).status, "REFUSED");
});
test("explicit public builder and pure preview bind 38+8 identities and exactly 101 fixed operations", () => {
  const i = inputs(), p = child.validateChildPlan(i); assert.equal(p.scope.originalAddresses.length, 38); assert.equal(p.scope.addresses.length, 46);
  assert.equal(p.operations.length, 101); assert.equal(p.operations.filter(op => op.kind === "call").length, 81);
  assert.equal(p.operations.filter(op => op.kind === "code").length, 19); assert.equal(p.operations.filter(op => op.kind === "storage").length, 1);
  assert.equal(p.rows.filter(row => !row.perAddressSourcePublication).length, 2); assert.equal(p.readset.history, false);
  assert.throws(() => child.buildPublicChildInputs({}), { code: "INPUT_INVALID" });
});
test("REAL native pin/common/C guard execute 101 state reads plus qualification/terminal at 1-second starts", async t => {
  const f = fixture(), out = await child.observeBaseChildren(f.options); closed(out);
  assert.equal(out.status, "OBSERVED", JSON.stringify(out)); assert.deepEqual(out.stateReads, { planned: 101, attempted: 101, succeeded: 101, failed: 0, skipped: 0 });
  assert.equal(out.observationPin.stateReadsPinned, 101); assert.equal(out.observationPin.headerFamilies, 2); assert.equal(out.contextCounters.stateReadOperations, 101);
  assert.equal(out.qualificationCanaryDispatches, 4); assert.equal(out.physicalCounters.actualStarts, f.state.calls.length);
  assert.ok(f.state.calls.every((c, i, a) => !i || c.start - a[i - 1].start >= 1000));
  assert.ok(f.state.calls.slice(-2).every(c => c.method === "eth_getBlockByNumber" && c.params[0] === HEX(N)));
  assert.equal(f.state.calls.filter(c => c.method === "eth_getLogs").length, 4);
  assert.ok(out.rows.every(row => row.parentLinkMatched && row.runtimeClassMatched && row.freshness === "UNKNOWN" && row.consumerPricePathQualification === "UNKNOWN"));
  assert.equal(out.rows[3].sourceGap, "HTML_SOURCE_UNPARSED"); assert.equal(out.rows[5].perAddressSourcePublication, false);
  assert.equal(out.rows[0].round.observationAgeSecondsRaw, "120"); assert.equal(out.rows[0].round.transmissionAgeSecondsRaw, "30");
  assert.equal(out.rows[0].round.updatedAtMeaning, "TRANSMISSION_TIMESTAMP"); assert.equal(out.rows[7].round.updatedAtMeaning, "FORWARDED_NEXT_LAYER_UNQUALIFIED");
  assert.equal(out.rows[7].views.aggregator[0], A(9000)); assert.ok(f.state.calls.every(c => c.params[0]?.to !== A(9000)));
  assert.equal(f.state.calls.some(c => c.method === "eth_call" && c.params[0].data.startsWith(id("latestTransmissionDetails()").slice(0, 10))), false);
  t.diagnostic(JSON.stringify({ state: out.stateReads, physical: out.physicalCounters, context: out.contextCounters, elapsedMs: f.state.elapsed }));
});
test("unapproved/expired/incomplete authorization and wrong candidate/family/limits fail with zero transports", async () => {
  for (const change of [f => { delete f.options.approval; }, f => { f.options.approval.status = "NOT_APPROVED"; }, f => { f.options.approval.attemptStarted = false; },
    f => { f.options.approval.expiresAtMs = NOW; }, f => { f.options.approval.targetCount = 47; }, f => { f.options.approval.planDigest = "0".repeat(64); },
    f => { f.options.approval.codeDigest = "0".repeat(64); }, f => { f.options.candidates[1].operatorFamily = "alchemy"; },
    f => { f.options.candidates[1].operatorFamily = "unknown"; }, f => { f.options.readset.limits.paceMs = 999; }, f => { f.options.readset.limits.timeoutMs = 10001; },
    f => { f.options.readset.limits.concurrency = 5; }, f => { f.options.historyStore = {}; }, f => { delete f.options.transport; }]) {
    const f = fixture(); change(f); const out = await child.observeBaseChildren(f.options); closed(out); assert.equal(out.status, "INCOMPLETE"); assert.equal(f.state.calls.length, 0);
  }
});
test("wrong extension, ABI return tuples, exact calldata/args, source/class/code commitments fail before RPC", async () => {
  for (const change of [f => { f.options.scope.addresses.push(A(999)); }, f => { f.options.readset.operations.find(op => op.key === "hasAccess").args[0] = A(1); },
    f => { f.options.readset.operations.find(op => op.key === "hasAccess").data += "00"; }, f => { f.options.readset.operations.find(op => op.key === "latestRoundData").outputs[0] = "uint256"; },
    f => { const target = JSON.parse(f.options.evidence.files[BASE + "public-child-sources/not-approved-child-readset.json"]).targets[0];
      const file = BASE + "public-child-sources/" + target.sourceAbiFile, abi = JSON.parse(f.options.evidence.files[file]); abi.find(x => x.name === "latestRoundData").outputs[0].type = "uint256"; f.options.evidence.files[file] = JSON.stringify(abi); },
    f => { f.options.evidence.classProof.sourceBound = true; }, f => { f.options.evidence.codeHashes[child.CODE_FILES[0]] = "0".repeat(64); }]) {
    const f = fixture(); change(f); const out = await child.observeBaseChildren(f.options); assert.equal(out.status, "INCOMPLETE"); assert.equal(f.state.calls.length, 0);
  }
});
test("changed child/parent code, parent link and oracle source block only bound rows, never follow replacements", async () => {
  for (const kind of ["childCode", "parentCode", "parentLink", "oracleSource"]) {
    const f = fixture(), row = f.model.rows[0];
    if (kind === "childCode") f.codes[row.child] = "0x6000";
    if (kind === "parentCode") f.codes[row.parent] = "0x6000";
    f.state.hook = async (_h, method, p) => {
      if (method === "eth_call" && kind === "parentLink" && p[0].to === row.parent) return f.interfaces.get(row.parent).encodeFunctionResult("aggregator", [A(999)]);
      if (method === "eth_call" && kind === "oracleSource" && p[0].to === ORACLE && p[0].data === new Interface(["function getReserveSource(uint256) view returns(address)"]).encodeFunctionData("getReserveSource", [0])) return H(999);
    };
    const out = await child.observeBaseChildren(f.options); closed(out); assert.equal(out.status, "OBSERVED_PARTIAL", JSON.stringify(out));
    assert.ok(out.rows[0].blockers.length); assert.equal(out.rows[0].round, null); assert.equal(out.rows[1].runtimeClassMatched, true);
    assert.ok(f.state.calls.every(c => c.params[0]?.to !== A(999))); assert.ok(out.stateReads.attempted < 101);
  }
});
test("MAG7 implementation pointer/code and reciprocal binding are mandatory, no replacement implementation followed", async () => {
  for (const kind of ["pointer", "implementationCode", "spokeCode", "reciprocal"]) {
    const f = fixture(); if (kind === "implementationCode") f.codes[IMPL] = "0x6000"; if (kind === "spokeCode") f.codes[SPOKE] = "0x6000";
    f.state.hook = async (_h, method, p) => {
      if (kind === "pointer" && method === "eth_getStorageAt" && p[0] === SPOKE) return H(999);
      if (kind === "reciprocal" && method === "eth_call" && p[0].to === SPOKE) return H(999);
    };
    const out = await child.observeBaseChildren(f.options); closed(out); assert.equal(out.status, "OBSERVED_PARTIAL"); assert.ok(out.blockers.length);
    assert.ok(out.rows.every(row => row.round === null)); assert.ok(f.state.calls.every(c => c.params[0] !== A(999) && c.params[0]?.to !== A(999)));
  }
});
test("access false or EVM denial remains partial; no EOA/price-context qualification or speculative methods", async () => {
  for (const denied of [false, true]) {
    const f = fixture(); f.state.access = false;
    if (denied) f.state.hook = async (_h, m, p) => { if (m === "eth_call" && p[0].to === f.model.rows[0].child && p[0].data === "0xfeaf968c") {
      throw { code: "CALL_EXCEPTION", message: "SENTINEL_PRIVATE_REVERT", cause: { authorization: "SENTINEL_PRIVATE_AUTH" } }; } };
    const out = await child.observeBaseChildren(f.options); closed(out); assert.equal(out.status, "OBSERVED_PARTIAL");
    assert.ok(out.rows[0].blockers.includes(denied ? "READ_FAILED" : "ACCESS_OBSERVED_FALSE"));
    if (denied) assert.equal(out.observationPin, null); else assert.equal(out.rows[0].views.hasAccess[0], false);
    assert.equal(out.rows[0].consumerPricePathQualification, "UNKNOWN");
  }
});
test("signed raw answer, observation vs transmission age, zero/future rounds do not invent freshness policy", async () => {
  for (const kind of ["negative", "zero", "future"]) {
    const f = fixture(); if (kind === "negative") f.state.answer = -123n;
    if (kind === "zero") f.state.transmission = 0n;
    if (kind === "future") f.state.transmission = BigInt(f.pin.timestamp + 1);
    const out = await child.observeBaseChildren(f.options); closed(out); assert.equal(out.status, "OBSERVED_PARTIAL");
    assert.equal(out.rows[0].round.answerRaw, String(f.state.answer)); assert.equal(out.rows[0].freshness, "UNKNOWN");
    assert.ok(out.rows[0].round.flags.includes(kind === "negative" ? "NON_POSITIVE_ANSWER" : kind === "zero" ? "INVALID_ROUND_STRUCTURE" : "FUTURE_TIMESTAMP"));
  }
});
test("malformed return data and arbitrary nested/getter errors are sanitized, never attested", async () => {
  for (const kind of ["data", "getter"]) {
    const f = fixture();
    f.state.hook = async (_h, method, params) => { if (method === "eth_call" && params[0].to === f.model.rows[0].child && params[0].data === "0xfeaf968c") {
      if (kind === "data") return H(1);
      throw { get code() { throw new Error("SENTINEL_PRIVATE_GETTER"); }, message: "SENTINEL_PRIVATE_ERROR", headers: { authorization: "SENTINEL_PRIVATE_HEADER" }, cause: { body: "SENTINEL_PRIVATE_BODY" } };
    } };
    const out = await child.observeBaseChildren(f.options); closed(out); assert.equal(out.observationPin, null); assert.ok(out.rows[0].blockers.includes("READ_FAILED"));
  }
});
test("counter drift or an earlier/false whole-context proof cannot fabricate a count-matched final pin", async t => {
  const real = pinned.openPinnedCollection;
  for (const kind of ["counter", "attestation"]) {
    const f = fixture();
    t.mock.method(pinned, "openPinnedCollection", async options => { const context = await real(options); return { ...context,
      statistics: () => ({ ...context.statistics(), ...(kind === "counter" ? { networkCalls: context.statistics().networkCalls + 1 } : {}) }),
      observationPin: coverage => { const value = context.observationPin(coverage); return value && { ...value, ...(kind === "attestation" ? { stateReadsPinned: 683 } : {}) }; },
    }; });
    const out = await child.observeBaseChildren(f.options); closed(out); assert.equal(out.status, "INCOMPLETE"); assert.equal(out.observationPin, null);
    assert.ok(out.errors.includes("COUNTERS_INVALID")); pinned.openPinnedCollection = real;
  }
});
test("universe membership never permits arbitrary selectors, from/override, EOA getters or STATE logs", async t => {
  const real = pinned.openPinnedCollection;
  for (const kind of ["selector", "from", "logs"]) {
    const f = fixture();
    t.mock.method(pinned, "openPinnedCollection", async options => { const context = await real(options); return { ...context, provider: { ...context.provider, async call(tx) {
      if (kind === "logs") await options.rpc(f.options.candidates[0].handle, "eth_getLogs", [{ address: HUB, blockHash: H(N), topics: [H(0)] }]);
      else await options.rpc(f.options.candidates[0].handle, "eth_call", [{ ...tx, ...(kind === "selector" ? { data: id("owner()").slice(0, 10) } : { from: SPOKE }) }, { blockHash: H(N), requireCanonical: true }]);
      return context.provider.call(tx);
    } } }; });
    const out = await child.observeBaseChildren(f.options); closed(out); assert.equal(out.observationPin, null); assert.equal(out.status, "INCOMPLETE");
    assert.equal(f.state.calls.filter(c => c.method === "eth_getLogs").length, 4); pinned.openPinnedCollection = real;
  }
});
test("wrong qualification canary target/topic/hash/keys/replay and header interval fail before prohibited starts", async t => {
  const real = pinned.openPinnedCollection;
  for (const kind of ["target", "topic", "hash", "extra", "numeric", "replay", "stage", "range"]) {
    const f = fixture();
    if (kind === "range") f.state.hook = async (_h, m) => m === "eth_getBlockByNumber" ? f.header(N + 100000) : undefined;
    t.mock.method(pinned, "openPinnedCollection", async options => {
      if (kind === "stage") await options.rpc(f.options.candidates[0].handle, "eth_getLogs", [{ address: HUB, blockHash: H(N), topics: [H(0)] }]);
      return real({ ...options, rpc: async (h, m, p, timeout) => {
        if (m !== "eth_getLogs" || ["stage", "range"].includes(kind)) return options.rpc(h, m, p, timeout);
        const filter = clone(p[0]); if (kind === "target") filter.address = f.model.rows[0].child;
        if (kind === "topic") filter.topics = [H(4)]; if (kind === "hash") filter.blockHash = H(N - 1);
        if (kind === "extra") filter.extra = true; if (kind === "numeric") { delete filter.blockHash; filter.fromBlock = HEX(N); filter.toBlock = HEX(N); }
        const value = await options.rpc(h, m, [filter], timeout);
        if (kind === "replay") await options.rpc(h, m, [filter], timeout); return value;
      } });
    });
    const out = await child.observeBaseChildren(f.options); closed(out); assert.equal(out.status, "INCOMPLETE"); assert.equal(out.observationPin, null);
    assert.ok(f.state.calls.filter(c => c.method === "eth_getLogs").length <= (kind === "replay" ? 2 : 0)); pinned.openPinnedCollection = real;
  }
});
test("deadline and terminal reorg keep bounded partial rows without attestation", async () => {
  for (const kind of ["deadline", "terminal"]) {
    const f = fixture(); if (kind === "terminal") f.state.terminalFail = true;
    if (kind === "deadline") f.state.hook = async () => { if (f.state.operations === 10) f.state.elapsed = 210001; };
    const out = await child.observeBaseChildren(f.options); closed(out); assert.equal(out.status, "INCOMPLETE"); assert.equal(out.observationPin, null);
    assert.equal(out.physicalCounters.activeRequests, 0); assert.ok(out.rows.length <= 8);
  }
});
test("late physical failure drains retained native terminal requests before closing and refuses subsequent RPC", async t => {
  const f = fixture(); let releaseA, releaseB, startedB, settled = false, rpc;
  const gateA = new Promise(r => { releaseA = r; }), gateB = new Promise(r => { releaseB = r; }), beganB = new Promise(r => { startedB = r; });
  const real = pinned.openPinnedCollection; t.mock.method(pinned, "openPinnedCollection", options => { rpc = options.rpc; return real(options); });
  f.state.hook = async (h, m, p) => { if (m === "eth_getBlockByNumber" && p[0] === HEX(N) && f.state.operations === 101) {
    if (h === f.options.candidates[0].handle) { await gateA; throw new Error("SENTINEL_PRIVATE_TERMINAL"); }
    startedB(); await gateB; return f.header(N);
  } };
  const running = child.observeBaseChildren(f.options).then(out => { settled = true; return out; }); await beganB; releaseA();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false); releaseB();
  const out = await running; closed(out); assert.equal(out.observationPin, null); assert.equal(out.physicalCounters.activeRequests, 0);
  const before = f.state.calls.length; await assert.rejects(rpc(f.options.candidates[0].handle, "eth_chainId", []), { code: "RUN_CLOSED" }); assert.equal(f.state.calls.length, before);
});
