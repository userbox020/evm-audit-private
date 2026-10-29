"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const r16 = require("./run-base-paper-usdplus-redemption-r16");

const T = r16._test;
const ROOT = path.resolve(__dirname, "..");
const RUNNER = require.resolve("./run-base-paper-usdplus-redemption-r16");
const ANCHOR_FILE = path.join(ROOT, "tools/lib/base-paper-usdplus-r16-proof-anchor.js");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const H = byte => `0x${byte.repeat(64)}`;
const NOW = 2_000_000;
function pin(number = 100n, timestamp = 1900n, byte = "1") { return { number: number.toString(), hash: H(byte), parentHash: H("2"), stateRoot: H("3"), timestamp: timestamp.toString() }; }
function rawPin(value) { return { number: `0x${BigInt(value.number).toString(16)}`, hash: value.hash, parentHash: value.parentHash, stateRoot: value.stateRoot, timestamp: `0x${BigInt(value.timestamp).toString(16)}` }; }
const word = value => BigInt(value).toString(16).padStart(64, "0");

test("CLI exposes one indivisible production mode", () => {
  assert.equal(T.parseCli(["--run-once"]), true);
  for (const argv of [[], ["--once"], ["--run-once", "qualification"], ["--binding-only"], ["--fork-only"]]) assert.throws(() => T.parseCli(argv), /EXPLICIT_RUN_ONCE_REQUIRED/);
});

test("runner startup imports built-ins only and owns the exact full P0 manifest pin", () => {
  const source = fs.readFileSync(RUNNER, "utf8"), requires = [...source.matchAll(/require\(([^)]+)\)/g)].map(match => match[1]);
  assert.equal(requires.every(value => /^"node:[a-z_]+"$/.test(value) || value === "file"), true, requires.join(","));
  assert.equal(r16.ANCHOR.sha256, "59dea96628ff46542b92ab6793244904740881489943321911345db1551ef221");
  assert.equal(r16.ANCHOR.manifestSha256, "8ec40e65a917b7c45eb65026732a9cecad80d6b77a343de6b41c2d5101d38cba");
  assert.equal(source.includes("8ec40e65a917b7c45eb65026732a9cecad80d6b77a343de6b41c2d5101d38cba"), true);
  assert.equal(source.includes("qualification-only"), false); assert.equal(source.includes("binding-only"), false); assert.equal(source.includes("fork-only"), false);
});

test("external anchor identity has exact size and hash", () => {
  const bytes = fs.readFileSync(ANCHOR_FILE);
  assert.equal(r16.ANCHOR.bytes, bytes.length);
  assert.equal(hash(bytes), r16.ANCHOR.sha256);
  assert.equal(bytes.toString("utf8").includes(r16.ANCHOR.manifestSha256), true);
  assert.equal(T.anchorIdentity().stat.size, bytes.length);
});

test("startup rejects node injection and preloaded tool-root modules before anchor load", () => {
  const clean = { environment: {}, execArgv: [], cache: { [RUNNER]: {} } };
  assert.equal(T.validateStartupEnvironment(clean), true);
  assert.throws(() => T.validateStartupEnvironment({ ...clean, environment: { NODE_OPTIONS: "--require=x" } }), /NODE_OPTIONS_REJECTED/);
  assert.throws(() => T.validateStartupEnvironment({ ...clean, environment: { node_path: "x" } }), /NODE_PATH_REJECTED/);
  assert.throws(() => T.validateStartupEnvironment({ ...clean, execArgv: ["--inspect"] }), /EXEC_ARGV_REJECTED/);
  assert.throws(() => T.validateStartupEnvironment({ ...clean, cache: { [RUNNER]: {}, [path.join(ROOT, "tools/other.js")]: {} } }), /PRELOADED_TOOL_MODULE_REJECTED/);
});

test("secure startup pins before load, uses only reviewed methods, and rechecks", () => {
  let loads = 0, attestations = 0;
  const fake = Object.freeze({ verifyAccountProof: async () => ({}), attestation: () => { attestations++; return { reviewedIdentity: true, externalAnchorRequired: true, anchorHashMustBePinnedBeforeRequire: true, selfVerificationClaimed: false }; } });
  const out = T.secureStartup({ environment: {}, execArgv: [], cache: { [RUNNER]: {} }, load: file => { loads++; assert.equal(file, ANCHOR_FILE); return fake; } });
  assert.equal(out, fake); assert.equal(loads, 1); assert.equal(attestations, 1);
});

test("dependency-free Keccak, selectors, role IDs, and static ABI encoding are exact", () => {
  assert.equal(T.keccakHex(Buffer.alloc(0)), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.equal(T.selector("balanceOf(address)"), "0x70a08231"); assert.equal(T.selector("totalSupply()"), "0x18160ddd");
  assert.equal(T.keccakHex("EXCHANGER"), "0x3eb675f159e6ca6cf5de6bfbbc8c4521cfd428f5e9166e51094d5898504caf2d");
  const call = T.calldata("redeem(address,uint256)", [r16.A.usdc, 1n]); assert.equal(call.length, 2 + 8 + 128); assert.equal(call.slice(-64), word(1));
});

test("exact admitted static authority loads fourteen runtimes including Pool proxy and both libraries", () => {
  const authority = T.staticAuthority();
  assert.equal(Object.keys(authority.runtimes).length, 14); assert.equal(authority.runtimes[r16.A.pool].length, 2 + 1933 * 2);
  assert.equal(authority.runtimes[r16.A.supplyLogic].startsWith("0x73" + r16.A.supplyLogic.slice(2)), true);
  assert.equal(authority.runtimes[r16.A.poolLogic].startsWith("0x73" + r16.A.poolLogic.slice(2)), true);
  assert.deepEqual(authority.slots[r16.A.manager], [r16.EIP1967, r16.MANAGER_ASSET_SLOT]);
  assert.equal(Object.values(authority.events).every(value => /^0x[0-9a-f]{64}$/.test(value)), true);
  assert.equal(T.assertAuthorityUnchanged(authority), true);
});

test("recorded Anvil identity is enforced before spawn through regular-file size and hash", () => {
  const bytes = Buffer.from("anvil"), stat = { dev: 1, ino: 2, size: bytes.length, mtimeMs: 3, ctimeMs: 4, nlink: 1, isFile: () => true, isSymbolicLink: () => false };
  const expected = { file: "X", version: "1.5.1-stable", commit: "b0", bytes: bytes.length, sha256: hash(bytes) };
  const out = T.verifyAnvilIdentity({ file: "X", expected, lstat: () => stat, realpath: value => path.resolve(value), readFile: () => bytes });
  assert.equal(out.version, expected.version); assert.equal(out.commit, expected.commit); assert.equal(out.sha256, expected.sha256);
  assert.throws(() => T.verifyAnvilIdentity({ file: "X", expected: { ...expected, bytes: bytes.length + 1 }, lstat: () => stat, realpath: value => path.resolve(value), readFile: () => bytes }), /PINNED_FILE_SIZE_MISMATCH/);
  assert.deepEqual(r16.ANVIL, { file: "C:/Users/MiPC/.foundry/bin/anvil.exe", version: "1.5.1-stable", commit: "b0a9dd9ceda36f63e2326ce530c10e6916f4b8a2", bytes: 27333120, sha256: "d909a15a16d56ef2c00093c70cb567845b16400398158e5957b7a9a6818a1b9b" });
});

test("inventory selection is HTTPS-only, deduplicated by href and origin, bounded, and two-family", () => {
  const lines = ["https://x.alchemy.com/v2/secret", "https://x.alchemy.com:443/v2/secret", "https://x.alchemy.com/other", "https://base-mainnet.infura.io/v3/secret",
    "http://base.publicnode.com", "https://unknown.example/rpc", "https://base.publicnode.com", "https://base.drpc.org"];
  const rows = T.parseInventory(lines.join("\n")); assert.equal(rows.length, 4); assert.equal(new Set(rows.map(row => row.url.origin)).size, rows.length); assert.ok(new Set(rows.map(row => row.family)).size >= 2);
  assert.throws(() => T.parseInventory("https://one.alchemy.com/a\nhttps://two.alchemy.com/b"), /TWO_REVIEWED_FAMILIES_UNAVAILABLE/);
  assert.equal(JSON.stringify(rows.map(row => ({ rank: row.rank, ordinal: row.ordinal }))).includes("secret"), false);
});

function qualificationFixture(options = {}) {
  const candidates = [{ url: new URL("https://one.invalid/a"), family: "alpha" }, { url: new URL("https://two.invalid/b"), family: "beta" }], p = pin(), calls = [], counts = new Map();
  const transport = async (url, body) => {
    calls.push(body); const index = candidates.findIndex(row => row.url.href === url.href); let result;
    if (body.method === "eth_chainId") result = "0x2105";
    else { const count = counts.get(index) || 0; counts.set(index, count + 1); result = rawPin(options.disagree && index === 1 && count > 0 ? pin(100n, 1900n, "9") : p); }
    return { value: { jsonrpc: "2.0", id: body.id, result }, bytes: 100 };
  };
  return { candidates, p, calls, ledger: T.createRpcLedger(transport, () => NOW) };
}

test("qualification derives one fresh exact root from two families with no retries", async () => {
  const f = qualificationFixture(), out = await T.qualify(f.candidates, f.ledger, () => NOW);
  assert.deepEqual(out.pin, f.p); assert.equal(out.pair.length, 2); assert.equal(out.stats.selectedFamilyCount, 2); assert.equal(f.ledger.state.requests, 6);
  assert.deepEqual(f.calls.map(row => row.method), ["eth_chainId", "eth_getBlockByNumber", "eth_chainId", "eth_getBlockByNumber", "eth_getBlockByNumber", "eth_getBlockByNumber"]);
  const bad = qualificationFixture({ disagree: true }); await assert.rejects(() => T.qualify(bad.candidates, bad.ledger, () => NOW), /EXACT_TWO_FAMILY_PIN_UNAVAILABLE/);
});

test("proof binding supplies the selected root, exact code, and exact requested storage key to P0", async () => {
  const target = r16.A.usdc, slot = r16.EIP1967, p = pin(), seen = [];
  const proof = { address: target, nonce: "0x1", balance: "0x0", storageHash: H("4"), codeHash: H("5"), accountProof: ["0x12"], storageProof: [{ key: slot, value: "0x1234", proof: ["0x34"] }] };
  const ledger = { call: async (_candidate, method, params) => { seen.push({ method, params }); return method === "eth_getProof" ? proof : "0x6000"; } };
  let input, policy; const anchor = { verifyAccountProof: async (value, selectedPolicy) => { input = value; policy = selectedPolicy; return { accountIncluded: true, codeHashMatched: true, storageProofCount: 1 }; } };
  const out = await T.bindAccount({ url: new URL("https://secret.invalid") }, p, ledger, anchor, target, [slot], "0x6000");
  assert.equal(input.stateRoot, p.stateRoot); assert.equal(input.code, "0x6000"); assert.equal(input.storageProof[0].key, slot); assert.equal(policy, "REQUIRED_EXISTING");
  assert.equal(out.slots[slot], `0x${"0".repeat(60)}1234`); assert.equal(seen.every(row => row.params.at(-1).blockHash === p.hash && row.params.at(-1).requireCanonical === true), true);
});

function goodView(authority) {
  const capacity = r16.SIZES.map(size => ({ x: size.toString(), liquidationStrict: true, scaledSufficient: true, virtualSufficient: true, actualSufficient: true }));
  return { staticProofCount: Object.keys(authority.runtimes).length, pointers: { exchange: r16.A.exchangeImpl, manager: r16.A.managerImpl, cash: r16.A.cashImpl, token: r16.A.usdPlusImpl, role: r16.A.roleImpl, pool: r16.A.poolImpl },
    privateAsset: r16.A.usdc, dynamic: Array.from({ length: 8 }, (_, index) => ({ address: `0x${(index + 1).toString(16).padStart(40, "0")}`, implementation: r16.A.usdc })), pinNumber: "100", blockGetterNumber: undefined,
    core: { usdPlus: r16.A.usdPlus, usdc: r16.A.usdc, manager: r16.A.manager, role: r16.A.role, tokenExchange: r16.A.exchange, tokenRole: r16.A.role, blockGetter: r16.A.actor,
      exchangePaused: false, tokenPaused: false, locks: { actor: { lockSend: false, lockReceive: false }, venue: { lockSend: false, lockReceive: false }, burn: { lockSend: false, lockReceive: false } } },
    manager: { exchanger: r16.A.exchange, cash: r16.A.cash, exchangeHasRole: true }, cash: { manager: r16.A.manager, usdc: r16.A.usdc, aToken: r16.A.aToken, provider: r16.A.aaveProvider, inLending: true },
    aave: { configuration: (1n << 56n).toString(), userConfiguration: "0", reserve: { aToken: r16.A.aToken, variableDebt: r16.A.actor, rateStrategy: r16.A.venue }, providerAtPool: r16.A.aaveProvider,
      providerPool: r16.A.pool, tokenPool: r16.A.pool, tokenUnderlying: r16.A.usdc, incentives: r16.A.actor }, capacity };
}

test("G1-G5 are conjunctive and every failure blocks relay eligibility", () => {
  const authority = { runtimes: { a: "x" } }, view = goodView(authority); view.core.blockGetter = r16.A.actor; view.blockGetterNumber = "100";
  assert.equal(T.evaluateGates(view, authority).allPass, true);
  const mutations = [["G1", value => value.staticProofCount = 0], ["G2", value => value.core.exchangePaused = true], ["G3", value => value.privateAsset = r16.A.actor], ["G4", value => value.capacity[2].actualSufficient = false], ["G5", value => value.aave.incentives = "0x" + "0".repeat(40)]];
  for (const [gate, mutate] of mutations) { const changed = structuredClone(view); mutate(changed); assert.equal(T.evaluateGates(changed, authority).firstFailure.stage, `PREFORK_${gate}`); }
});

test("payout and capacity include exact raw sizes 1, 1_000_000, and 100_000_000", () => {
  const inputs = { assetDecimals: "6", usdPlusDecimals: "6", feeRate: "10", feeDenominator: "100000", freeRider: false };
  assert.deepEqual(r16.SIZES.map(String), ["1", "1000000", "100000000"]); assert.equal(T.payoutFor(1n, inputs).payout, "1"); assert.equal(T.payoutFor(100_000_000n, inputs).payout, "99990000");
  const rows = T.capacityRows({ payoutInputs: inputs, cash: { liquidationValue: "100000001" }, aave: { nextLiquidityIndex: (2n * 10n ** 27n).toString(), scaledBalance: "100000000", virtualUnderlying: "100000001", actualUnderlying: "100000001" } });
  assert.deepEqual(rows.map(row => row.x), r16.SIZES.map(String)); assert.equal(rows[2].scaledP, "49995000"); assert.equal(rows.every(row => row.liquidationStrict), true);
});

function traceCalls() {
  const A = r16.A;
  return [[A.actor, A.exchange], [A.exchange, A.exchangeImpl], [A.exchange, A.manager], [A.manager, A.managerImpl], [A.manager, A.cash], [A.cash, A.cashImpl], [A.cash, A.pool],
    [A.pool, A.poolImpl], [A.pool, A.supplyLogic], [A.pool, A.aToken], [A.aToken, A.usdc]].map(([caller, callee], order) => ({ order, parent: order - 1, caller, callee, type: order === 1 ? "DELEGATECALL" : "CALL", success: true }));
}

test("G6 ordered cash path tolerates bound delegatecall frames but rejects balancing and unknown targets", () => {
  const calls = traceCalls(), expected = new Set(Object.values(r16.A)); assert.deepEqual(T.validateOrderedCashPath(calls), { pass: true, code: null }); assert.deepEqual(T.validateTraceClosure(calls, expected), { pass: true, code: null });
  const balanced = structuredClone(calls); balanced.push({ order: 20, caller: r16.A.manager, callee: r16.A.m2m, type: "CALL", success: true }); assert.equal(T.validateOrderedCashPath(balanced).code, "PATH_EXPANDED_TO_PORTFOLIO_BALANCING");
  const unknown = structuredClone(calls); unknown.push({ order: 20, caller: r16.A.cash, callee: "0x0000000000000000000000000000000000001234", type: "CALL", success: true }); assert.equal(T.validateTraceClosure(unknown, expected).code, "UNEXPECTED_CODE_TARGET");
});

function conservationRow(size) {
  const x = BigInt(size), payout = x, index = 2n * 10n ** 27n + 7n, beforeIndex = 10n ** 27n, scaled = (payout * 10n ** 27n + index - 1n) / index;
  const before = { blockNumber: "100", usdPlusActor: x.toString(), usdPlusSupply: "100000100", usdcActor: "0", usdcAToken: "1000000000", usdcCash: "0", usdcManager: "0", usdcExchange: "0", usdcSupply: "9999999999", scaledCash: (100000000n + scaled).toString(), virtualUnderlying: "1000000000", actualUnderlying: "1000000000", nextLiquidityIndex: beforeIndex.toString(), blockTimestamp: "2000" };
  const after = { blockNumber: "101", usdPlusActor: "0", usdPlusSupply: (100000100n - x).toString(), usdcActor: payout.toString(), usdcAToken: (1000000000n - payout).toString(), usdcCash: "0", usdcManager: "0", usdcExchange: "0", usdcSupply: "9999999999", scaledCash: "100000000", virtualUnderlying: (1000000000n - payout).toString(), actualUnderlying: (1000000000n - payout).toString(), nextLiquidityIndex: index.toString(), blockTimestamp: "2000" };
  const transfers = [[r16.A.usdPlus, r16.A.actor, "0x" + "0".repeat(40), x], [r16.A.usdc, r16.A.aToken, r16.A.cash, payout], [r16.A.usdc, r16.A.cash, r16.A.manager, payout], [r16.A.usdc, r16.A.manager, r16.A.exchange, payout], [r16.A.usdc, r16.A.exchange, r16.A.actor, payout]].map(([token, from, to, value]) => ({ token, from, to, value: value.toString() }));
  return { x: x.toString(), payout: payout.toString(), postLiquidityIndex: index.toString(), eventBlockNumber: "101", before, after, transfers, poolWithdraw: true, strategyUnstake: true, reserveUpdated: true, balanceEvent: false, rollbackComplete: true, path: { pass: true }, closure: { pass: true } };
}

test("native-USDC conservation, exact scaled burn, and rollback are mandatory at all three sizes", () => {
  for (const size of r16.SIZES) { const row = conservationRow(size), result = T.validateConservation(row); assert.equal(result.pass, true); assert.notEqual(row.before.nextLiquidityIndex, row.postLiquidityIndex); assert.equal(row.before.blockTimestamp, row.after.blockTimestamp);
    if (size > 1n) assert.notEqual(result.scaledP, ((size * 10n ** 27n + BigInt(row.before.nextLiquidityIndex) - 1n) / BigInt(row.before.nextLiquidityIndex)).toString()); }
  const bad = conservationRow(1n); bad.rollbackComplete = false; assert.equal(T.validateConservation(bad).pass, false);
  const expanded = conservationRow(1n); expanded.closure.pass = false; assert.equal(T.validateConservation(expanded).pass, false);
  const staleIndex = conservationRow(1_000_000n); staleIndex.postLiquidityIndex = staleIndex.before.nextLiquidityIndex; assert.equal(T.validateConservation(staleIndex).pass, false);
});

test("ReserveDataUpdated supplies the post-update index and must equal immediate normalized income", () => {
  const topic = H("a"), index = 2n * 10n ** 27n + 7n, receipt = { logs: [{ address: r16.A.pool, topics: [topic, `0x${r16.A.usdc.slice(2).padStart(64, "0")}`], data: `0x${[11n, 12n, 13n, index, 14n].map(word).join("")}` }] };
  const event = T.reserveUpdateEvidence(receipt, topic); assert.equal(event.liquidityIndex, index.toString());
  const row = conservationRow(1_000_000n); assert.equal(row.after.nextLiquidityIndex, event.liquidityIndex); assert.equal(T.validateConservation(row).pass, true);
  const mismatch = conservationRow(1_000_000n); mismatch.after.nextLiquidityIndex = (index + 1n).toString(); assert.equal(T.validateConservation(mismatch).pass, false);
});

test("relay rewrites only the selected pin and child argv contains localhost relay only", () => {
  const p = pin(), params = T.relayParams("eth_getCode", [r16.A.usdc, "latest"], p); assert.deepEqual(params[1], { blockHash: p.hash, requireCanonical: true });
  assert.equal(T.relayParams("eth_getBlockReceipts", ["latest"], p)[0], p.hash);
  assert.throws(() => T.relayParams("eth_getCode", [r16.A.usdc, "0x99"], p), /UNPINNED_STATE_REQUEST/);
  assert.throws(() => T.relayParams("eth_getBlockByNumber", ["0x99", false], p), /UNPINNED_BLOCK_REQUEST/);
  const args = T.buildAnvilArgs(41000, 41001, p); assert.equal(args[args.indexOf("--fork-url") + 1], "http://127.0.0.1:41000"); assert.equal(args[args.indexOf("--fork-block-number") + 1], p.number);
  assert.equal(args.join(" ").includes("https://"), false); assert.throws(() => T.localhost("https://127.0.0.1:1"), /LOCALHOST_REQUIRED/);
});

function localBindingFixture(mutation = null) {
  const slotValue = `0x${word(0x1234n)}`, configurationData = "0x12345678", indexData = "0x87654321";
  const pre = { commitments: [{ address: r16.A.exchange, code: "0x6000", slots: { [r16.EIP1967]: slotValue } }], abiCommitments: {
    configuration: { to: r16.A.pool, data: configurationData, raw: `0x${word(1n)}` }, liquidityIndex: { to: r16.A.pool, data: indexData, raw: `0x${word(2n)}` },
  } };
  const calls = [];
  const rpc = { call: async (method, params) => { calls.push(method); if (/^(?:anvil_|eth_send|evm_)/.test(method)) throw new Error("mutation reached");
    if (method === "eth_getCode") return mutation === "code" ? "0x6001" : "0x6000";
    if (method === "eth_getStorageAt") return mutation === "slot" ? `0x${word(0x1235n)}` : slotValue;
    if (method === "eth_call") { if (params[0].data === configurationData) return mutation === "configuration" ? `0x${word(9n)}` : `0x${word(1n)}`; return mutation === "liquidityIndex" ? `0x${word(9n)}` : `0x${word(2n)}`; }
    throw new Error("unexpected"); } };
  return { pre, rpc, calls };
}

test("lazy fork rebinds every code, storage, configuration, and liquidity-index commitment before mutation", async () => {
  const valid = localBindingFixture(), result = await T.verifyLocalBinding(valid.rpc, valid.pre); assert.deepEqual(result, { accounts: 1, slots: 1, abi: 2 });
  assert.equal(valid.calls.some(method => /^(?:anvil_|eth_send|evm_)/.test(method)), false);
  for (const mutation of ["code", "slot", "configuration", "liquidityIndex"]) {
    const fixture = localBindingFixture(mutation); await assert.rejects(() => T.verifyLocalBinding(fixture.rpc, fixture.pre), /LOCAL_(?:CODE|STORAGE|ABI)_COMMITMENT_MISMATCH/);
    assert.equal(fixture.calls.some(method => /^(?:anvil_|eth_send|evm_)/.test(method)), false, mutation);
  }
});

test("local binding failure stops before G6 mutation executor", async () => {
  const now = Date.now(), relay = { port: 1, stats: () => ({}), close: async () => {} }, child = { exitCode: 0 }; let executed = 0;
  const output = await T.runAttempt({ now: () => now, candidates: [{}, {}], authority: {}, anchor: {}, anvilIdentity: {}, establish: async () => preResult(now), relayFactory: async () => relay,
    freePort: async () => 2, startChild: async () => child, rpcFactory: () => ({}), waitReady: async () => true,
    verifyLocalBinding: async () => { throw new r16.R16Error("LOCAL_BINDING", "LOCAL_CODE_COMMITMENT_MISMATCH"); }, executeG6: async () => { executed++; return completeRows(); } });
  assert.equal(executed, 0); assert.equal(output.progress.localBindingVerified, false); assert.equal(output.progress.mintReached, false); assert.equal(output.firstFailure.stage, "LOCAL_BINDING");
});

function preResult(now, evaluation = { allPass: true, gates: {}, firstFailure: null }) {
  const p = pin(200n, BigInt(Math.floor(now / 1000) - 10)); return { pin: p, pair: [{ candidate: {} }, { candidate: {} }], selected: {}, stats: { attempted: 2, finalizedAdmitted: 2, selectedFamilyCount: 2, failures: {} },
    evaluation, commitments: [], abiCommitments: {}, view: { dynamic: [], aave: { nextLiquidityIndex: "1" }, capacity: r16.SIZES.map(size => ({ x: size.toString(), payout: size.toString() })) } };
}
function completeRows() { return r16.SIZES.map(size => ({ amountRaw: size.toString(), payoutRaw: size.toString(), scaledBurnRaw: size.toString(), orderedCashPath: true, targetClosure: true, conservation: true, rollback: true })); }

test("successful injected seams with testMode true, false, or omitted cannot create production truth", async () => {
  for (const testMode of [true, false, undefined]) {
    const now = Date.now(), relay = { port: 41000, stats: () => ({ forwarded: 0, denied: 0, bytes: 0, methods: {} }), close: async () => {} }, child = new EventEmitter(); child.exitCode = 0;
    const options = { now: () => now, candidates: [{}, {}], authority: {}, anchor: {}, anvilIdentity: {}, establish: async () => preResult(now), relayFactory: async () => relay,
      freePort: async () => 41001, startChild: async () => child, rpcFactory: () => ({ stats: () => ({ requests: 0, bytes: 0 }) }), waitReady: async () => true,
      verifyLocalBinding: async () => ({ accounts: 1, slots: 1, abi: 1 }), executeG6: async ({ progress }) => { progress.mintReached = true; progress.redemptionReached = true; return completeRows(); } };
    if (testMode !== undefined) options.testMode = testMode;
    const output = await T.runAttempt(options);
    assert.equal(output.classification, "OFFLINE_TEST_STATE_MACHINE_COMPLETE"); assert.equal(output.evidenceSource, "offline-test"); assert.equal(output.productionInvocationBound, false); assert.equal(output.attemptId, null);
    assert.equal(output.fullExitVerified, false); assert.equal(output.measuredFreshRedemptionBehavior, false); assert.equal(output.localSemantic.status, "UNKNOWN"); assert.equal(output.localSemantic.result, "inconclusive");
    assert.equal(output.routePositive, "unknown"); assert.equal(output.executableNow, "unknown"); assert.equal(output.quoteEligible, false); assert.deepEqual(output.cleanup, { child: "CONFIRMED", relay: "CONFIRMED" });
  }
});

test("every G1-G5 failure prevents relay and Anvil and cleanup uncertainty downgrades success", async () => {
  const now = Date.now(); let relays = 0, children = 0;
  for (const gate of ["G1", "G2", "G3", "G4", "G5"]) {
    const evaluation = { allPass: false, gates: {}, firstFailure: { stage: `PREFORK_${gate}`, code: `BLOCK_${gate}` } };
    const out = await T.runAttempt({ testMode: true, now: () => now, candidates: [{}, {}], authority: {}, anchor: {}, anvilIdentity: {}, establish: async () => { throw new r16.R16Error(evaluation.firstFailure.stage, evaluation.firstFailure.code, { evaluation }); },
      relayFactory: async () => { relays++; }, startChild: async () => { children++; } });
    assert.equal(out.firstFailure.stage, `PREFORK_${gate}`); assert.equal(out.progress.relayReached, false);
  }
  assert.equal(relays, 0); assert.equal(children, 0);
  const relay = { port: 1, stats: () => ({}), close: async () => { throw new r16.R16Error("RELAY_CLEANUP", "CLOSE_UNCONFIRMED"); } }, child = { exitCode: 0 };
  const output = await T.runAttempt({ testMode: true, now: () => now, candidates: [{}, {}], authority: {}, anchor: {}, anvilIdentity: {}, establish: async () => preResult(now), relayFactory: async () => relay,
    freePort: async () => 2, startChild: async () => child, rpcFactory: () => ({}), waitReady: async () => true, verifyLocalBinding: async () => ({ accounts: 1, slots: 1, abi: 1 }), executeG6: async () => completeRows() });
  assert.equal(output.cleanup.relay, "FAILED"); assert.equal(output.fullExitVerified, false); assert.equal(output.firstFailure.code, "CLOSE_UNCONFIRMED");
});

test("attempt and result publication are append-only, sanitized, and no-retry", () => {
  assert.throws(() => T.ensureNoOverwrite({ exists: file => file === r16.ATTEMPT_FILE }), /ATTEMPT_ALREADY_CONSUMED_NO_RETRY/);
  assert.equal(T.ensureNoOverwrite({ exists: () => false }), true); assert.equal(T.sanitized({ pin: pin(), routePositive: "unknown" }), true);
  for (const secret of ["https://secret.invalid", "Authorization: x", "api_key=x", "rpc_endpoints.txt", "alchemy"]) assert.equal(T.sanitized(secret), false);
  for (const publisher of ["writeJsonOnce", "writeAttemptMarker", "writeOutput", "publishProduction", "beginProductionInvocation", "productionOnce", "runCli"]) assert.equal(Object.hasOwn(T, publisher), false, publisher);
  assert.equal(Object.values(r16).some(value => value && typeof value === "object" && value.productionCapability), false);
});

test("terminal semantics remain WATCH-only even after measured local behavior", () => {
  const output = T.baseOutput(); assert.equal(output.evidenceSource, "offline-test"); assert.equal(output.productionInvocationBound, false); assert.equal(output.safety.indivisibleStateMachine, true); assert.equal(output.safety.partialProductionModes, false); assert.equal(output.safety.retries, 0);
  assert.equal(output.routePositive, "unknown"); assert.equal(output.executableNow, "unknown"); assert.equal(output.quoteEligible, false); assert.equal(output.profitabilityClaim, false); assert.equal(output.signedActionJustified, false);
  assert.deepEqual(output.safety.rawSizes, ["1", "1000000", "100000000"]); assert.equal(T.provenance().runnerSha256, hash(fs.readFileSync(RUNNER)));
});
