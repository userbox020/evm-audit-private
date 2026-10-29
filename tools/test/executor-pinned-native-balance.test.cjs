"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const { Interface, Wallet } = require("../node_modules/ethers");
const { createPinnedRpc } = require("../lib/executor-pinned-rpc.js");
const { ExecutionError } = require("../lib/wallet-execution-guard.js");

const NOW = Date.parse("2026-10-28T08:00:00Z"), PIN = 100;
const ACCOUNT = "0x" + "ab".repeat(20), MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
const PROBE = new Interface(["function getBlockNumber() view returns(uint256)"]);
const hex = value => "0x" + BigInt(value).toString(16);
const hash = value => "0x" + BigInt(value).toString(16).padStart(64, "0");
const UNKNOWN_HASH = "0x" + "f".repeat(64);

async function fixture() {
  const candidates = ["family-a", "family-a", "family-b"].map((family, i) => ({ family, handle: `OFFLINE_${i + 1}` }));
  const calls = [], state = { now: NOW, head: PIN, reorg: false, balances: ["0xa", "0xdead", "0xa"],
    failure: null, remainingRequests: Infinity, admittedRequests: 0 };
  const rawHeader = number => ({ number: hex(number), hash: hash(state.reorg && number === PIN ? 9999 : number),
    parentHash: hash(number - 1), stateRoot: hash(7),
    timestamp: hex(NOW / 1000 - 10 - (PIN - number) * 12), baseFeePerGas: "0x1" });
  const rpc = async (candidate, method, params, timeoutMs) => {
    const alias = candidates.indexOf(candidate) + 1;
    calls.push({ alias, method, params: structuredClone(params), timeoutMs });
    if (state.remainingRequests <= 0) throw new ExecutionError("NETWORK_CALL_CAP");
    state.remainingRequests--; state.admittedRequests++;
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_getBlockByNumber") return rawHeader(params[0] === "latest" ? state.head : Number(BigInt(params[0])));
    assert.ok(["eth_call", "eth_getCode", "eth_getBalance"].includes(method), "only planned read methods may dispatch");
    assert.equal(params.length, 2);
    assert.equal(params[1].requireCanonical, true);
    assert.deepEqual(Object.keys(params[1]).sort(), ["blockHash", "requireCanonical"]);
    if (["eth_call", "eth_getCode"].includes(method) && params[1].blockHash === UNKNOWN_HASH) throw new ExecutionError("UNKNOWN_BLOCK_REJECTED");
    if (method === "eth_getCode") return "0x6000";
    if (method === "eth_call") {
      assert.equal(params[0].to, MULTICALL3);
      assert.equal(params[0].data, PROBE.encodeFunctionData("getBlockNumber"));
      return hash(BigInt(params[1].blockHash));
    }
    assert.deepEqual(params, [ACCOUNT, { blockHash: hash(PIN), requireCanonical: true }]);
    if (state.failure && alias === 3) throw state.failure;
    return state.balances[alias - 1];
  };
  const pinned = await createPinnedRpc({ candidates, rpc, now: () => state.now, requireStrictEvidence: true });
  assert.equal(pinned.evidence.strictEvidence, true);
  assert.equal(pinned.evidence.independentFamilies, true);
  assert.deepEqual(pinned.evidence.aliases, [1, 3]);
  assert.ok(pinned.evidence.qualification.every(row => row.qualified && row.callUnknownHashRejected && row.codeUnknownHashRejected));
  return { pinned, calls, state };
}

function assertInvalidated(pinned) {
  assert.throws(() => pinned.assertUsable(), { code: "PIN_EVIDENCE_INVALIDATED" });
}

test("balance uses exactly the two selected strict witnesses, canonical pin and timeout; no HTTP or signer", async t => {
  const fetch = t.mock.method(globalThis, "fetch", () => assert.fail("HTTP forbidden"));
  const signer = t.mock.method(Wallet.prototype, "signTransaction", () => assert.fail("signing forbidden"));
  const { pinned, calls } = await fixture(), before = calls.length;
  assert.equal(await pinned.balance("0x" + "AB".repeat(20), 321), "0xa");
  assert.deepEqual(calls.slice(before), [1, 3].map(alias => ({ alias, method: "eth_getBalance",
    params: [ACCOUNT, { blockHash: hash(PIN), requireCanonical: true }], timeoutMs: 321 })));
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(signer.mock.callCount(), 0);
  assert.equal(JSON.stringify(pinned.evidence).includes("OFFLINE_"), false);
});

test("positive and zero native quantities compare numerically and return normalized hex", async () => {
  for (const [first, second, expected] of [["0xAbC", "0xaBc", "0xabc"], ["0x0", "0X0", "0x0"]]) {
    const { pinned, state } = await fixture();
    state.balances = [first, "0xdead", second];
    assert.equal(await pinned.balance(ACCOUNT), expected);
    pinned.assertUsable();
  }
});

test("unequal balances fail closed and invalidate the pin before another read", async () => {
  const { pinned, state, calls } = await fixture();
  state.balances = ["0xa", "0xa", "0xb"];
  await assert.rejects(pinned.balance(ACCOUNT), { code: "PROVIDER_RESULT_DISAGREEMENT" });
  assertInvalidated(pinned);
  const after = calls.length;
  await assert.rejects(pinned.balance(ACCOUNT), { code: "PIN_EVIDENCE_INVALIDATED" });
  assert.equal(calls.length, after);
});

test("malformed, negative, nonquantity and noncanonical results fail closed even when both agree", async () => {
  for (const value of [undefined, null, {}, 0, 0n, "1", "-0x1", "0x", "0xgg", "0x00", "0x01", " 0x1"]) {
    const { pinned, state } = await fixture();
    state.balances = [value, "0xa", value];
    await assert.rejects(pinned.balance(ACCOUNT), { code: "PIN_BALANCE_RESULT_INVALID" });
    assertInvalidated(pinned);
  }
});

test("RPC failure is sanitized, drains both witnesses, and invalidates the pin", async () => {
  const { pinned, state, calls } = await fixture(), before = calls.length;
  state.failure = new Error("PRIVATE_PROVIDER_RESPONSE");
  await assert.rejects(pinned.balance(ACCOUNT), error => {
    assert.equal(error.code, "PINNED_RPC_FAILED");
    assert.equal(error.message.includes("PRIVATE_PROVIDER_RESPONSE"), false);
    return true;
  });
  assert.deepEqual(calls.slice(before).map(row => row.alias), [1, 3]);
  assertInvalidated(pinned);
});

test("collector allowlist still rejects eth_getBalance without dispatch or widening its scope", async () => {
  const { pinned, calls } = await fixture(), before = calls.length;
  const handle = await pinned.collectorOptions.resolveRpc(1);
  for (const ref of ["latest", hash(PIN), { blockHash: hash(PIN), requireCanonical: true }]) {
    await assert.rejects(pinned.collectorOptions.rpcCall(handle, "eth_getBalance", [ACCOUNT, ref]), { code: "COLLECTOR_UNPINNED_REQUEST" });
  }
  assert.equal(calls.length, before);
  pinned.assertUsable();
  assert.equal(await pinned.balance(ACCOUNT), "0xa");
});

test("invalid accounts never dispatch and caller-supplied selectors/overrides cannot replace the pin", async () => {
  const { pinned, calls } = await fixture(), before = calls.length;
  for (const account of [null, {}, [ACCOUNT], "latest", hash(PIN), "0x123", ACCOUNT + " "]) {
    await assert.rejects(pinned.balance(account), { code: "PIN_BALANCE_REQUEST_INVALID" });
  }
  assert.equal(calls.length, before);
  await pinned.balance(ACCOUNT, { blockHash: hash(9999), requireCanonical: false }, { [ACCOUNT]: { balance: "0xffff" } });
  assert.ok(calls.slice(before).every(row => row.method === "eth_getBalance" && row.timeoutMs === 4000));
  assert.deepEqual(calls.slice(before).map(row => row.params), [1, 3].map(() => [ACCOUNT, { blockHash: hash(PIN), requireCanonical: true }]));
});

test("balance remains at the pin after head movement; changed/stale rechecks still invalidate it", async () => {
  for (const kind of ["changed", "stale"]) {
    const { pinned, state, calls } = await fixture();
    state.now += 12000; state.head = PIN + 1;
    await pinned.recheck();
    assert.equal(await pinned.balance(ACCOUNT), "0xa");
    assert.equal(pinned.pin.number, PIN);
    if (kind === "changed") state.reorg = true;
    else state.now += 120001;
    await assert.rejects(pinned.recheck(), { code: kind === "changed" ? "PIN_CHANGED" : "PIN_STALE_OR_FUTURE" });
    assertInvalidated(pinned);
    const after = calls.length;
    await assert.rejects(pinned.balance(ACCOUNT), { code: "PIN_EVIDENCE_INVALIDATED" });
    assert.equal(calls.length, after);
  }
});

test("expired timeout and injected request budget stay on the existing fail-closed request path", async () => {
  const expired = await fixture(), before = expired.calls.length;
  await assert.rejects(expired.pinned.balance(ACCOUNT, 0), { code: "PINNED_RPC_FAILED" });
  assert.equal(expired.calls.length, before);
  assertInvalidated(expired.pinned);

  const bounded = await fixture(), admitted = bounded.state.admittedRequests;
  bounded.state.remainingRequests = 1;
  await assert.rejects(bounded.pinned.balance(ACCOUNT), { code: "PINNED_RPC_FAILED" });
  assert.equal(bounded.state.admittedRequests - admitted, 1);
  assertInvalidated(bounded.pinned);
});
