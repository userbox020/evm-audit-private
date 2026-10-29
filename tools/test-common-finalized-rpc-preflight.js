#!/usr/bin/env node
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const preflight = require("./lib/common-finalized-rpc-preflight");

const BLOCK = 1000;
const hash = (byte) => `0x${byte.repeat(64)}`;
function header(number = BLOCK, byte = "a", overrides = {}) {
  return {
    number: `0x${number.toString(16)}`,
    hash: hash(byte),
    parentHash: hash("b"),
    stateRoot: hash("c"),
    timestamp: "0x6553f100",
    ...overrides
  };
}
function candidate(handle, operatorFamily, inventoryOrder = 0, capabilityRank = 1) {
  return { handle, operatorFamily, inventoryOrder, capabilityRank };
}
function row(overrides = {}) {
  return { chainId: "0xa", finalized: header(), observation: { value: "0xAA", nested: { count: 1 } }, ...overrides };
}

class FixtureRpc {
  constructor(rows, maximum = 80) {
    this.rows = rows;
    this.calls = [];
    this.ledger = preflight.createRpcLedger(this.call.bind(this), maximum);
  }
  async call(handle, method, params) {
    this.calls.push({ handle, method, params: structuredClone(params) });
    const current = this.rows[handle];
    if (!current) throw new Error("UNKNOWN");
    if (current.timeoutMethod === method) return new Promise((_, reject) => reject(new Error("TIMEOUT")));
    if (method === "eth_chainId") return current.chainId;
    if (method === "eth_getBlockByNumber") {
      if (params[0] === "finalized") return current.finalized;
      const number = Number(BigInt(params[0]));
      if (current.exact && current.exact[number]) return current.exact[number];
      return { ...current.finalized, number: params[0] };
    }
    if (current.failProbe === method) throw new Error("PROBE_FAILED_WITH_SECRET");
    if (method === "eth_getCode") return "0x6000";
    if (method === "eth_getStorageAt") return `0x${"0".repeat(64)}`;
    if (method === "eth_call") return "0x01";
    if (method === "eth_getLogs") return [];
    throw new Error("UNEXPECTED");
  }
}

async function stateProbe({ reader, candidate: source }) {
  await reader.getCode("0x0000000000000000000000000000000000000001");
  await reader.getStorageAt("0x0000000000000000000000000000000000000001", `0x${"0".repeat(64)}`);
  await reader.call({ to: "0x0000000000000000000000000000000000000001", data: "0x12345678" });
  return FIXTURE.rows[source.handle].observation;
}

let FIXTURE;
async function qualify(rows, candidates, overrides = {}) {
  FIXTURE = new FixtureRpc(rows, overrides.maxNetworkCalls || 80);
  const result = await preflight.qualifyCommonFinalized({
    candidates,
    chainId: 10,
    minimumFamilies: 2,
    preferredFamilies: 3,
    limits: {
      maxCandidates: 44,
      maxProbeCallsPerCandidate: overrides.maxProbeCallsPerCandidate || 12,
      reserveRequests: overrides.reserveRequests === undefined ? 15 : overrides.reserveRequests,
      retries: 0,
      maxNetworkCalls: overrides.maxNetworkCalls || 80
    },
    rpc: FIXTURE.ledger,
    probe: overrides.probe || stateProbe
  });
  return { result, rpc: FIXTURE };
}

test("two authoritative families succeed with exact normalized state consensus", async () => {
  const rows = { a: row(), b: row({ observation: { nested: { count: 1 }, value: "0xaa" } }) };
  const { result } = await qualify(rows, [candidate("a", "alchemy", 0), candidate("b", "infura", 1)]);
  assert.equal(result.pin.number, BLOCK);
  assert.equal(result.diagnostics.pinConsensusFamilies, 2);
  assert.equal(result.diagnostics.stateConsensusFamilies, 2);
  assert.equal(result.selected.length, 2);
});

test("an early state failure recovers through the later third family", async () => {
  const rows = { a: row(), b: row({ failProbe: "eth_getCode" }), c: row() };
  const { result } = await qualify(rows, [candidate("a", "alchemy"), candidate("b", "infura"), candidate("c", "quicknode")]);
  assert.equal(result.diagnostics.stateAttempts, 3);
  assert.equal(result.diagnostics.stateSuccesses, 2);
  assert.equal(result.diagnostics.stateConsensusFamilies, 2);
  assert.deepEqual(result.selected.map((entry) => entry.candidate.operatorFamily), ["alchemy", "quicknode"]);
});

test("same-family hosts cannot form quorum and unknown authority is excluded", async () => {
  const rows = { a: row(), b: row(), c: row() };
  await assert.rejects(
    qualify(rows, [candidate("a", "alchemy"), candidate("b", "alchemy"), { handle: "c", operatorFamily: "unknown" }]),
    (error) => error.code === "TWO_FAMILIES_UNAVAILABLE" && error.diagnostics.qualificationAttempts === 0
  );
  assert.equal(preflight.classifyOperatorFamily("https://arbitrary.example/rpc"), null);
  assert.equal(preflight.classifyOperatorFamily("https://optimism.publicnode.com").operatorFamily, "publicnode");
});

test("wrong-chain same-family alternative does not suppress a later valid handle", async () => {
  const rows = { wrong: row({ chainId: "0x1" }), replacement: row(), independent: row() };
  const { result, rpc } = await qualify(rows, [
    candidate("wrong", "alchemy"), candidate("replacement", "alchemy"), candidate("independent", "infura")
  ]);
  assert.equal(result.diagnostics.chainMatches, 2);
  assert.equal(result.diagnostics.stateConsensusFamilies, 2);
  assert.equal(rpc.calls.filter((entry) => entry.handle === "wrong").length, 1);
  assert.ok(rpc.calls.some((entry) => entry.handle === "replacement"));
});

test("highest common finalized pin is selected highest-to-lowest", async () => {
  const at1001 = header(1001, "d"), at1002 = header(1002, "e");
  const rows = {
    a: row({ finalized: at1002, exact: { 1001: at1001 } }),
    b: row({ finalized: at1001 }),
    c: row({ finalized: header(1000, "f") })
  };
  const { result } = await qualify(rows, [candidate("a", "alchemy"), candidate("b", "infura"), candidate("c", "quicknode")]);
  assert.equal(result.pin.number, 1001);
  assert.equal(result.pin.hash, at1001.hash);
  assert.equal(result.diagnostics.pinConsensusFamilies, 2);
});

test("full header hash, parent, and stateRoot disagreement fail closed", async () => {
  for (const changed of [
    { hash: hash("d") }, { parentHash: hash("d") }, { stateRoot: hash("d") }
  ]) {
    const rows = { a: row(), b: row({ finalized: header(BLOCK, "a", changed) }) };
    await assert.rejects(qualify(rows, [candidate("a", "alchemy"), candidate("b", "infura")]),
      (error) => error.code === "PIN_CONSENSUS_UNAVAILABLE");
  }
});

test("code, storage, and call use canonical EIP-1898 while canary logs use blockHash only", async () => {
  const rows = { a: row(), b: row() };
  const { result, rpc } = await qualify(rows, [candidate("a", "alchemy"), candidate("b", "infura")]);
  for (const call of rpc.calls.filter((entry) => ["eth_getCode", "eth_getStorageAt", "eth_call"].includes(entry.method))) {
    assert.deepEqual(call.params.at(-1), { blockHash: result.pin.hash, requireCanonical: true });
  }
  const logs = rpc.calls.filter((entry) => entry.method === "eth_getLogs");
  assert.equal(logs.length, 2);
  assert.equal(logs.every((entry) => entry.params[0].blockHash === result.pin.hash
    && !Object.hasOwn(entry.params[0], "fromBlock") && !Object.hasOwn(entry.params[0], "toBlock")), true);
});

test("guarded log reader rejects ranges and latest without issuing a call", async () => {
  const rows = { a: row(), b: row() };
  const badProbe = async ({ reader }) => {
    await reader.getCode("0x0000000000000000000000000000000000000001");
    await reader.getStorageAt("0x0000000000000000000000000000000000000001", `0x${"0".repeat(64)}`);
    await reader.call({ to: "0x0000000000000000000000000000000000000001", data: "0x" });
    await reader.getLogs({ fromBlock: "latest", toBlock: "latest" });
    return { ok: true };
  };
  await assert.rejects(qualify(rows, [candidate("a", "alchemy"), candidate("b", "infura")], { probe: badProbe }),
    (error) => error.code === "STATE_CONSENSUS_UNAVAILABLE");
  assert.equal(FIXTURE.calls.some((entry) => entry.method === "eth_getLogs"), false);
});

test("malformed headers, timeouts, and probe failures receive no retries", async () => {
  const rows = {
    malformed: row({ finalized: { number: "0x1" } }),
    timeout: row({ timeoutMethod: "eth_chainId" }),
    a: row(), b: row()
  };
  const { result, rpc } = await qualify(rows, [
    candidate("malformed", "ankr"), candidate("timeout", "drpc"), candidate("a", "alchemy"), candidate("b", "infura")
  ]);
  assert.equal(result.diagnostics.finalizedQualified, 2);
  assert.equal(rpc.calls.filter((entry) => entry.handle === "timeout" && entry.method === "eth_chainId").length, 1);
  assert.equal(rpc.calls.filter((entry) => entry.handle === "malformed" && entry.method === "eth_getBlockByNumber").length, 1);
});

test("candidate, per-probe, global, reserve, and zero-retry budgets are hard", async () => {
  assert.deepEqual(preflight.DEFAULT_LIMITS, {
    maxCandidates: 44, maxProbeCallsPerCandidate: 12, reserveRequests: 15, retries: 0, maxNetworkCalls: 80
  });
  const rows = {}, candidates = [];
  const reviewed = preflight.REVIEWED_OPERATOR_FAMILY_IDS;
  for (let index = 0; index < 50; index += 1) {
    rows[`h${index}`] = row();
    candidates.push(candidate(`h${index}`, reviewed[index % reviewed.length]));
  }
  const bounded = await qualify(rows, candidates);
  assert.equal(bounded.result.diagnostics.candidatesConsidered, 44);
  assert.ok(bounded.rpc.ledger.networkCalls <= 65);

  await assert.rejects(qualify({ a: row(), b: row() }, [candidate("a", "alchemy"), candidate("b", "infura")], { maxNetworkCalls: 30 }),
    (error) => error.code === "NETWORK_CALL_CAP" && error.diagnostics.stateSuccesses === 0);

  const overProbe = async ({ reader }) => {
    await reader.getCode("0x0000000000000000000000000000000000000001");
    await reader.getStorageAt("0x0000000000000000000000000000000000000001", `0x${"0".repeat(64)}`);
    await reader.call({ to: "0x0000000000000000000000000000000000000001", data: "0x" });
    for (let index = 0; index < 10; index += 1) await reader.getCode("0x0000000000000000000000000000000000000001");
    return { ok: true };
  };
  await assert.rejects(qualify({ a: row(), b: row() }, [candidate("a", "alchemy"), candidate("b", "infura")], { probe: overProbe }),
    (error) => error.code === "STATE_CONSENSUS_UNAVAILABLE");
  assert.equal(FIXTURE.calls.filter((entry) => entry.method === "eth_getCode").length, 20);
});

test("state quorum is family-aware and exact disagreements are deterministic and sanitized", async () => {
  const one = { a: row(), b: row({ observation: { value: "0xbb" } }) };
  await assert.rejects(qualify(one, [candidate("a", "alchemy"), candidate("b", "infura")]), (error) => {
    assert.equal(error.code, "STATE_CONSENSUS_UNAVAILABLE");
    assert.deepEqual(error.diagnostics, {
      candidatesConsidered: 2, qualificationAttempts: 2, chainMatches: 2, finalizedQualified: 2,
      pinConsensusFamilies: 2, stateAttempts: 2, stateSuccesses: 2, stateConsensusFamilies: 1, stateDistinctGroups: 2
    });
    const serialized = JSON.stringify(error.diagnostics);
    assert.equal(/secret|alpha|beta|https?:\/\//i.test(serialized), false);
    return true;
  });
});

test("exact-handle dedupe preserves first candidate order", async () => {
  const rows = { same: row(), other: row() };
  const { result } = await qualify(rows, [
    candidate("same", "alchemy", 0), candidate("same", "forged-second", 1), candidate("other", "infura", 2)
  ]);
  assert.equal(result.diagnostics.candidatesConsidered, 2);
  assert.deepEqual(result.selected.map((entry) => entry.candidate.operatorFamily), ["alchemy", "infura"]);
});

test("caller family authority is closed to reviewed IDs", async () => {
  assert.equal(Object.isFrozen(preflight.REVIEWED_OPERATOR_FAMILY_IDS), true);
  assert.equal(Object.isFrozen(preflight.REVIEWED_OPERATOR_FAMILY_SET), true);
  assert.equal(preflight.REVIEWED_OPERATOR_FAMILY_SET.has("alchemy"), true);
  assert.throws(() => preflight.REVIEWED_OPERATOR_FAMILY_SET.add("arbitrary-untrusted-family"), TypeError);
  assert.equal(preflight.reviewedOperatorFamily("ALCHEMY"), "alchemy");
  assert.equal(preflight.reviewedOperatorFamily("arbitrary-untrusted-family"), null);
  const rows = { a: row(), b: row() };
  await assert.rejects(
    qualify(rows, [candidate("a", "arbitrary-one"), candidate("b", "arbitrary-two")]),
    (error) => error.code === "TWO_FAMILIES_UNAVAILABLE" && error.diagnostics.qualificationAttempts === 0
  );
  const trusted = await qualify(rows, [candidate("a", "alchemy"), candidate("b", "infura")]);
  assert.equal(trusted.result.diagnostics.stateConsensusFamilies, 2);
});
