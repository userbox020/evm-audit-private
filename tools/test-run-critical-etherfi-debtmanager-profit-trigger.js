#!/usr/bin/env node
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { ethers } = require("ethers");
const producer = require("./run-critical-etherfi-debtmanager-profit-trigger.js");

const PROXY_CODE = "0x6000";
const IMPL_CODE = "0x6001";
const IMPL = "0x1111111111111111111111111111111111111111";
const ACTOR_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ACTOR_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const BLOCK = 149700000;
const HEADER = (hashByte = "ab", number = BLOCK, overrides = {}) => ({
  number: ethers.toQuantity(number), hash: `0x${hashByte.repeat(32)}`,
  parentHash: `0x${"cd".repeat(32)}`,
  stateRoot: `0x${"ef".repeat(32)}`,
  timestamp: ethers.toQuantity(1800000000),
  ...overrides
});
const HISTORICAL = Object.freeze({
  implementation: ethers.getAddress(IMPL),
  proxyRuntimeHash: ethers.keccak256(PROXY_CODE),
  implementationRuntimeHash: ethers.keccak256(IMPL_CODE)
});
const REVIEWED_FAMILIES = Object.freeze(["alchemy", "infura", "quicknode", "ankr", "publicnode", "1rpc", "0xrpc", "drpc"]);
const word = (value) => ethers.toBeHex(value, 32);
const implWord = (value = IMPL) => ethers.zeroPadValue(value, 32);

function defaults(overrides = {}) {
  return {
    paused: false,
    proxyCode: PROXY_CODE,
    implementation: IMPL,
    implementationCode: IMPL_CODE,
    header: HEADER(),
    pools: {
      EURC: { assets: 110n, shares: 100n, liquid: 110n, minShares: 10n, decimals: 6, events: [] },
      USDC: { assets: 100n, shares: 100n, liquid: 100n, minShares: 10n, decimals: 6, events: [] }
    },
    ...overrides
  };
}

function supplied(tokenAddress, amount, index = 0) {
  return {
    address: producer.MANAGER,
    topics: [
      producer.SUPPLIED_TOPIC,
      ethers.zeroPadValue(ACTOR_A, 32),
      ethers.zeroPadValue(ACTOR_B, 32),
      ethers.zeroPadValue(tokenAddress, 32)
    ],
    data: word(amount),
    blockNumber: ethers.toQuantity(BLOCK - 1),
    transactionIndex: "0x0",
    logIndex: ethers.toQuantity(index),
    transactionHash: `0x${"ef".repeat(32)}`
  };
}

class FixtureRpc {
  constructor(rows) { this.rows = rows; this.calls = []; }
  async call(url, method, params) {
    this.calls.push({ url, method, params: structuredClone(params) });
    const row = this.rows[url];
    if (!row) throw new Error("UNKNOWN_ENDPOINT");
    if (row.throwOnce && !row.thrown) { row.thrown = true; const error = new Error("BOUNDED_FAILURE"); if (row.throwOnceCode) error.code = row.throwOnceCode; throw error; }
    if (method === "eth_chainId") return row.chainId || "0xa";
    if (method === "eth_getBlockByNumber") {
      if (params[0] === "finalized") return row.header;
      row.exactHeaderReads = (row.exactHeaderReads || 0) + 1;
      if (row.terminalHeader && row.exactHeaderReads > 1) return row.terminalHeader;
      const number = Number(BigInt(params[0]));
      return row.headers && row.headers[number] ? row.headers[number] : { ...row.header, number: ethers.toQuantity(number) };
    }
    if (row.failState && method === "eth_getCode") throw new Error("STATE_READ_FAILED");
    if (method === "eth_getCode") return params[0].toLowerCase() === producer.MANAGER.toLowerCase() ? row.proxyCode : row.implementationCode;
    if (method === "eth_getStorageAt") return implWord(row.implementation);
    if (method === "eth_call") return this.ethCall(row, params[0]);
    if (method === "eth_getLogs") {
      if (params[0].topics.length === 1) {
        if (row.failLogProbe) throw new Error("LOG_TRANSPORT_UNAVAILABLE");
        return [];
      }
      if (row.failFullFlow) throw new Error("FULL_FLOW_UNAVAILABLE");
      return this.logs(row, params[0]);
    }
    throw new Error(`UNEXPECTED_METHOD_${method}`);
  }
  ethCall(row, call) {
    const selector = call.data.slice(0, 10);
    if (selector === producer.manager.getFunction("paused").selector) return producer.manager.encodeFunctionResult("paused", [row.paused]);
    if (selector === producer.manager.getFunction("borrowTokenConfig").selector) {
      const tokenAddress = producer.manager.decodeFunctionData("borrowTokenConfig", call.data)[0];
      const pool = this.pool(row, tokenAddress);
      return producer.manager.encodeFunctionResult("borrowTokenConfig", [0, 0, pool.shares, 0, 0, pool.minShares]);
    }
    if (selector === producer.manager.getFunction("totalSupplies").selector) {
      const tokenAddress = producer.manager.decodeFunctionData("totalSupplies", call.data)[0];
      return producer.manager.encodeFunctionResult("totalSupplies", [this.pool(row, tokenAddress).assets]);
    }
    if (selector === producer.token.getFunction("balanceOf").selector) {
      const tokenRow = producer.TOKENS.find((item) => item.address.toLowerCase() === call.to.toLowerCase());
      return producer.token.encodeFunctionResult("balanceOf", [row.pools[tokenRow.name].liquid]);
    }
    if (selector === producer.token.getFunction("decimals").selector) {
      const tokenRow = producer.TOKENS.find((item) => item.address.toLowerCase() === call.to.toLowerCase());
      return producer.token.encodeFunctionResult("decimals", [row.pools[tokenRow.name].decimals]);
    }
    throw new Error(`UNEXPECTED_SELECTOR_${selector}`);
  }
  pool(row, tokenAddress) {
    const tokenRow = producer.TOKENS.find((item) => item.address.toLowerCase() === tokenAddress.toLowerCase());
    return row.pools[tokenRow.name];
  }
  logs(row, filter) {
    const tokenAddress = ethers.getAddress(`0x${filter.topics[3].slice(-40)}`);
    const tokenRow = producer.TOKENS.find((item) => item.address.toLowerCase() === tokenAddress.toLowerCase());
    const from = Number(BigInt(filter.fromBlock)), to = Number(BigInt(filter.toBlock));
    return row.pools[tokenRow.name].events.filter((event) => {
      const block = Number(BigInt(event.blockNumber));
      return block >= from && block <= to;
    });
  }
}

class MemoryFs {
  constructor() { this.files = new Map(); this.handles = new Map(); this.next = 1; }
  openSync(file, mode) {
    if (mode === "wx" && this.files.has(file)) throw Object.assign(new Error("EXISTS"), { code: "EEXIST" });
    if (mode === "wx") this.files.set(file, Buffer.alloc(0));
    const fd = this.next++;
    this.handles.set(fd, file);
    return fd;
  }
  writeFileSync(fd, bytes) { this.files.set(this.handles.get(fd), Buffer.from(bytes)); }
  fsyncSync() {}
  closeSync(fd) { this.handles.delete(fd); }
  renameSync(from, to) { this.files.set(to, this.files.get(from)); this.files.delete(from); }
  readFileSync(file) { return Buffer.from(this.files.get(file)); }
  existsSync(file) { return this.files.has(file); }
  unlinkSync(file) { this.files.delete(file); }
}

async function run(rows, candidateUrls = Object.keys(rows), options = {}) {
  const rpc = new FixtureRpc(rows);
  const artifact = await producer.runTrigger({
    candidates: candidateUrls.map((handle, index) => ({
      handle,
      operatorFamily: rows[handle].operatorFamily || REVIEWED_FAMILIES[index % REVIEWED_FAMILIES.length],
      inventoryOrder: index,
      capabilityRank: rows[handle].capabilityRank || 1
    })),
    rpcCall: rpc.call.bind(rpc), historical: HISTORICAL, now: () => 1800000000000,
    ...options
  });
  assert.equal(producer.validateArtifact(artifact), true);
  assert.equal(artifact.safety.networkCalls, rpc.calls.length);
  assert.ok(rpc.calls.length <= producer.MAX_NETWORK_CALLS);
  const serialized = JSON.stringify(artifact);
  assert.equal(/https?:\/\/|family-[ab]|secret-token|transactionHash|aaaaaaaa|bbbbbbbb|"(?:sender|user|actor)"/i.test(serialized), false);
  assert.equal(REVIEWED_FAMILIES.some((family) => serialized.includes(family)), false);
  assert.equal(rpc.calls.some((entry) => /send|transaction|sign|fork/i.test(entry.method)), false);
  return { artifact, rpc };
}

function pair(rowA = defaults(), rowB = defaults()) {
  return {
    "https://family-a.invalid/secret-token": rowA,
    "https://family-b.example/secret-token": rowB
  };
}

test("historical runtime remains exactly source-bound", async () => {
  const { artifact } = await run(pair());
  assert.equal(artifact.runtime.changedFromHistorical, false);
  assert.equal(artifact.runtime.exactCurrentSourceBound, true);
  assert.equal(artifact.gates.sourceCurrent, "PASS");
  assert.equal(artifact.trigger.status, "BLOCKED_NO_FLOW");
  assert.deepEqual(artifact.diagnostics, {
    candidatesConsidered: 2, qualificationAttempts: 2, chainMatches: 2, finalizedQualified: 2,
    pinConsensusFamilies: 2, stateAttempts: 2, stateSuccesses: 2, stateConsensusFamilies: 2,
    stateDistinctGroups: 1, flowAttempts: 2, flowSuccesses: 2, flowConsensusFamilies: 2,
    flowDistinctGroups: 1, failurePhase: "NONE", failureCode: "NONE"
  });
});

test("current changed runtime is independently exact-source-bound", () => {
  assert.equal(producer.runtimeMatchesBaseline(producer.CURRENT_SOURCE_BOUND, producer.HISTORICAL), false);
  assert.equal(producer.runtimeMatchesBaseline(producer.CURRENT_SOURCE_BOUND, producer.CURRENT_SOURCE_BOUND), true);
});

test("changed runtime is unbound without erasing pool and flow observations", async () => {
  const changed = defaults({ implementationCode: "0x6002" });
  changed.pools.EURC.events = [supplied(producer.TOKENS[0].address, 2n)];
  const { artifact } = await run(pair(changed, structuredClone(changed)));
  assert.equal(artifact.runtime.changedFromHistorical, true);
  assert.equal(artifact.runtime.exactCurrentSourceBound, false);
  assert.equal(artifact.trigger.status, "BLOCKED_RUNTIME_UNBOUND");
  assert.equal(artifact.pools[0].recentSupplyEventCount, 1);
  assert.equal(artifact.pools[0].recentNonDustSupply, true);
});

test("empty EURC and USDC zero-amount events are dust-only", async () => {
  const empty = defaults();
  for (const tokenRow of producer.TOKENS) {
    empty.pools[tokenRow.name] = { assets: 0n, shares: 0n, liquid: 0n, minShares: 10n, decimals: 6, events: [supplied(tokenRow.address, 0n)] };
  }
  const { artifact } = await run(pair(empty, structuredClone(empty)));
  assert.equal(artifact.trigger.status, "BLOCKED_DUST_ONLY");
  assert.equal(artifact.pools.every((pool) => pool.zeroShareMaxRaw === null && !pool.recentNonDustSupply), true);
});

test("no recent flow is blocked", async () => {
  const { artifact } = await run(pair());
  assert.equal(artifact.trigger.status, "BLOCKED_NO_FLOW");
  assert.equal(artifact.gates.nonDustFlow, "FAIL");
});

test("non-dust recent flow emits gross-only trigger without net claim", async () => {
  const flowing = defaults();
  flowing.pools.EURC.events = [supplied(producer.TOKENS[0].address, 2n)];
  const { artifact } = await run(pair(flowing, structuredClone(flowing)));
  assert.equal(artifact.pools[0].zeroShareMaxRaw, "1");
  assert.equal(artifact.trigger.status, "POSITIVE_FLOW");
  assert.equal(artifact.trigger.positive, true);
  assert.equal(artifact.economics.status, "TRIGGER_POSITIVE_GROSS_ONLY");
  assert.equal(artifact.economics.conservativeNetRaw, null);
  assert.equal(artifact.gates.economicsComplete, "FAIL");
  assert.equal(artifact.gates.conservativeNetPositive, "UNKNOWN");
});

test("paused ordering blocks an otherwise positive flow", async () => {
  const paused = defaults({ paused: true });
  paused.pools.EURC.events = [supplied(producer.TOKENS[0].address, 2n)];
  const { artifact } = await run(pair(paused, structuredClone(paused)));
  assert.equal(artifact.trigger.status, "BLOCKED_PAUSED");
});

test("header consensus failure publishes schema-valid incomplete evidence", async () => {
  const { artifact } = await run(pair(defaults({ header: HEADER("aa") }), defaults({ header: HEADER("bb") })));
  assert.equal(artifact.trigger.status, "INCOMPLETE");
  assert.equal(artifact.pin.headerFamilies, 0);
  assert.equal(artifact.gates.runtimeBound, "UNKNOWN");
  assert.equal(artifact.diagnostics.pinConsensusFamilies, 1);
  assert.equal(artifact.diagnostics.failurePhase, "PIN_CONSENSUS");
  assert.equal(artifact.diagnostics.failureCode, "PIN_CONSENSUS_UNAVAILABLE");
});

test("state diagnostics distinguish one provider read failure", async () => {
  const { artifact } = await run(pair(defaults(), defaults({ failState: true })));
  assert.equal(artifact.trigger.status, "INCOMPLETE");
  assert.equal(artifact.pin.headerFamilies, 2);
  assert.equal(artifact.pin.stateFamilies, 1);
  assert.equal(artifact.diagnostics.stateAttempts, 2);
  assert.equal(artifact.diagnostics.stateSuccesses, 1);
  assert.equal(artifact.diagnostics.stateDistinctGroups, 1);
  assert.equal(artifact.diagnostics.failurePhase, "STATE");
  assert.equal(artifact.diagnostics.failureCode, "STATE_CONSENSUS_UNAVAILABLE");
});

test("state diagnostics distinguish successful provider disagreement", async () => {
  const { artifact } = await run(pair(defaults(), defaults({ paused: true })));
  assert.equal(artifact.trigger.status, "INCOMPLETE");
  assert.equal(artifact.pin.headerFamilies, 2);
  assert.equal(artifact.pin.stateFamilies, 1);
  assert.equal(artifact.diagnostics.stateAttempts, 2);
  assert.equal(artifact.diagnostics.stateSuccesses, 2);
  assert.equal(artifact.diagnostics.stateDistinctGroups, 2);
  assert.equal(artifact.diagnostics.failurePhase, "STATE");
  assert.equal(artifact.diagnostics.failureCode, "STATE_CONSENSUS_UNAVAILABLE");
});

test("combined three-family handoff tolerates one state failure and retains two-family evidence", async () => {
  const rows = {
    "https://one.alpha.invalid/secret-token": defaults(),
    "https://one.beta.example/secret-token": defaults({ failState: true }),
    "https://one.gamma.test/secret-token": defaults()
  };
  const { artifact, rpc } = await run(rows, Object.keys(rows), { qualificationFamilyTarget: 3 });
  assert.equal(artifact.trigger.status, "BLOCKED_NO_FLOW");
  assert.equal(artifact.pin.headerFamilies, 3);
  assert.equal(artifact.pin.stateFamilies, 2);
  assert.equal(artifact.diagnostics.stateAttempts, 3);
  assert.equal(artifact.diagnostics.stateSuccesses, 2);
  assert.equal(artifact.diagnostics.stateConsensusFamilies, 2);
  assert.equal(artifact.diagnostics.flowConsensusFamilies, 2);
  assert.ok(rpc.calls.length <= 80);
});

test("state-capable family with a failing exact log probe is excluded before state reads", async () => {
  const failing = "https://log-failing.alpha.invalid/secret-token";
  const goodA = "https://log-good.beta.example/secret-token";
  const goodB = "https://log-good.gamma.test/secret-token";
  const rows = { [failing]: defaults({ failLogProbe: true }), [goodA]: defaults(), [goodB]: defaults() };
  const { artifact, rpc } = await run(rows, [failing, goodA, goodB]);
  assert.equal(artifact.trigger.status, "BLOCKED_NO_FLOW");
  assert.equal(artifact.diagnostics.flowAttempts, 3); assert.equal(artifact.diagnostics.flowSuccesses, 2);
  assert.equal(artifact.diagnostics.stateAttempts, 2); assert.equal(artifact.diagnostics.stateSuccesses, 2);
  assert.equal(rpc.calls.some((entry) => entry.url === failing
    && ["eth_getCode", "eth_getStorageAt", "eth_call"].includes(entry.method)), false);
});

test("empty exact Supplied probes are capability success, never no-flow evidence", async () => {
  const flowing = defaults(); flowing.pools.EURC.events = [supplied(producer.TOKENS[0].address, 2n)];
  const { artifact, rpc } = await run(pair(flowing, structuredClone(flowing)));
  const probes = rpc.calls.filter((entry) => entry.method === "eth_getLogs" && entry.params[0].topics.length === 1);
  assert.equal(probes.length, 2); assert.equal(artifact.diagnostics.flowSuccesses, 2);
  assert.equal(artifact.pools[0].recentSupplyEventCount, 1); assert.equal(artifact.trigger.status, "POSITIVE_FLOW");
});

test("selected log-capable families require normalized complete flow agreement", async () => {
  const first = defaults(), second = defaults();
  const low = supplied(producer.TOKENS[0].address, 1n, 0), high = supplied(producer.TOKENS[0].address, 2n, 1);
  first.pools.EURC.events = [high, low]; second.pools.EURC.events = [structuredClone(low), structuredClone(high)];
  const { artifact, rpc } = await run(pair(first, second));
  assert.equal(artifact.diagnostics.flowConsensusFamilies, 2); assert.equal(artifact.diagnostics.flowDistinctGroups, 1);
  assert.equal(artifact.pools[0].recentSupplyEventCount, 2); assert.equal(artifact.trigger.status, "POSITIVE_FLOW");
  const firstState = rpc.calls.findIndex((entry) => ["eth_getCode", "eth_getStorageAt", "eth_call"].includes(entry.method));
  const probes = rpc.calls.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.method === "eth_getLogs" && entry.params[0].topics.length === 1);
  assert.equal(probes.every(({ index }) => index < firstState), true);
});

test("stale pre-deployment finalized provider cannot drag the combined pin", async () => {
  const rows = {
    "https://one.stale.invalid/secret-token": defaults({
      header: HEADER("aa", 149521227, { timestamp: "0x2" })
    }),
    "https://one.alpha.example/secret-token": defaults(),
    "https://one.beta.test/secret-token": defaults()
  };
  const { artifact } = await run(rows, Object.keys(rows), { qualificationFamilyTarget: 3 });
  assert.equal(artifact.trigger.status, "BLOCKED_NO_FLOW");
  assert.equal(artifact.diagnostics.qualificationAttempts, 3);
  assert.equal(artifact.diagnostics.finalizedQualified, 2);
  assert.equal(artifact.pin.headerFamilies, 2);
  assert.equal(artifact.pin.number, String(BLOCK));
});

test("combined three-family mutually different states fail closed", async () => {
  const changedAssets = defaults();
  changedAssets.pools.EURC.assets = 111n;
  const rows = {
    "https://one.alpha.invalid/secret-token": defaults(),
    "https://one.beta.example/secret-token": defaults({ paused: true }),
    "https://one.gamma.test/secret-token": changedAssets
  };
  const { artifact } = await run(rows, Object.keys(rows), { qualificationFamilyTarget: 3 });
  assert.equal(artifact.trigger.status, "INCOMPLETE");
  assert.equal(artifact.diagnostics.stateSuccesses, 3);
  assert.equal(artifact.diagnostics.stateDistinctGroups, 3);
  assert.equal(artifact.diagnostics.stateConsensusFamilies, 1);
  assert.equal(artifact.diagnostics.failureCode, "STATE_CONSENSUS_UNAVAILABLE");
});

test("combined three-family handoff fails without a matching header or flow pair", async () => {
  const headerRows = {
    "https://one.alpha.invalid/secret-token": defaults({ header: HEADER("aa") }),
    "https://one.beta.example/secret-token": defaults({ header: HEADER("bb") }),
    "https://one.gamma.test/secret-token": defaults({ header: HEADER("cc") })
  };
  const header = await run(headerRows, Object.keys(headerRows), { qualificationFamilyTarget: 3 });
  assert.equal(header.artifact.trigger.status, "INCOMPLETE");
  assert.equal(header.artifact.diagnostics.failureCode, "PIN_CONSENSUS_UNAVAILABLE");

  const first = defaults(), second = defaults(), third = defaults();
  first.pools.EURC.events = [];
  second.pools.EURC.events = [supplied(producer.TOKENS[0].address, 2n)];
  third.pools.EURC.events = [supplied(producer.TOKENS[0].address, 3n)];
  const flowRows = {
    "https://one.alpha.invalid/secret-token": first,
    "https://one.beta.example/secret-token": second,
    "https://one.gamma.test/secret-token": third
  };
  const flow = await run(flowRows, Object.keys(flowRows), { qualificationFamilyTarget: 3 });
  assert.equal(flow.artifact.trigger.status, "INCOMPLETE");
  assert.equal(flow.artifact.diagnostics.flowSuccesses, 3);
  assert.equal(flow.artifact.diagnostics.flowDistinctGroups, 3);
  assert.equal(flow.artifact.diagnostics.flowConsensusFamilies, 1);
  assert.equal(flow.artifact.diagnostics.failureCode, "FLOW_CONSENSUS_UNAVAILABLE");
});

test("wrong-chain response never rotates to a second endpoint in the same provider family", async () => {
  const wrong = "https://ethereum.shared.example/secret-token";
  const optimismSameFamily = "https://optimism.shared.example/secret-token";
  const optimismIndependent = "https://optimism.independent.test/secret-token";
  const rows = {
    [wrong]: defaults({ chainId: "0x1", operatorFamily: "alchemy" }),
    [optimismSameFamily]: defaults({ operatorFamily: "alchemy" }),
    [optimismIndependent]: defaults()
  };
  const { artifact, rpc } = await run(rows, [wrong, optimismSameFamily, optimismIndependent]);
  assert.equal(artifact.trigger.status, "INCOMPLETE");
  assert.equal(artifact.pin.headerFamilies, 0);
  assert.equal(artifact.pin.stateFamilies, 0);
  assert.equal(rpc.calls.some((entry) => entry.url === wrong), true);
  assert.equal(rpc.calls.some((entry) => entry.url === optimismSameFamily), false);
  assert.equal(artifact.safety.automaticRetries, 0);
});

test("matching unknown-domain endpoints cannot establish authority or emit a positive trigger", async () => {
  assert.equal(producer.canonicalProviderFamily("https://unknown-one.invalid/secret-token"), null);
  assert.deepEqual(
    producer.candidatePool({ candidateUrls: ["https://unknown-one.invalid/rpc", "https://unknown-two.example/rpc"] })
      .map((candidate) => candidate.operatorFamily),
    [null, null]
  );
  const flowing = defaults();
  flowing.pools.EURC.events = [supplied(producer.TOKENS[0].address, 2n)];
  const rows = {
    "https://unknown-one.invalid/secret-token": defaults({ ...structuredClone(flowing), operatorFamily: "untrusted-one" }),
    "https://unknown-two.example/secret-token": defaults({ ...structuredClone(flowing), operatorFamily: "untrusted-two" })
  };
  const { artifact, rpc } = await run(rows);
  assert.equal(artifact.trigger.status, "INCOMPLETE");
  assert.equal(artifact.trigger.positive, false);
  assert.equal(artifact.diagnostics.failurePhase, "QUALIFICATION");
  assert.equal(artifact.diagnostics.failureCode, "TWO_FAMILIES_UNAVAILABLE");
  assert.equal(artifact.diagnostics.qualificationAttempts, 0);
  assert.equal(artifact.pin.headerFamilies, 0);
  assert.equal(artifact.pin.stateFamilies, 0);
  assert.equal(rpc.calls.length, 0);
  assert.equal(producer.validateArtifact(artifact), true);
  assert.equal(/unknown-one|unknown-two|untrusted/i.test(JSON.stringify(artifact)), false);
});

test("ceiling math is exact at divisible, rounding, empty, and zero-asset boundaries", () => {
  assert.equal(producer.zeroShareMax("100", "100"), "0");
  assert.equal(producer.zeroShareMax("101", "100"), "1");
  assert.equal(producer.zeroShareMax("0", "0"), null);
  assert.equal(producer.zeroShareMax("0", "100"), "-1");
});

test("reviewed capable candidates are scored before the cap and families retain at most two endpoints", () => {
  const early = Array.from({ length: producer.MAX_CANDIDATES }, (_, index) => `https://unknown-${index}.invalid/rpc`);
  const values = [...early,
    { handle: "https://late-a.invalid/rpc", operatorFamily: "alchemy", capabilityRank: 0 },
    { handle: "https://late-b.invalid/rpc", operatorFamily: "infura", capabilityRank: 0 },
    { handle: "https://late-c.invalid/rpc", operatorFamily: "alchemy", capabilityRank: 0 },
    { handle: "https://late-d.invalid/rpc", operatorFamily: "alchemy", capabilityRank: 0 }];
  const selected = producer.candidatePool({ candidates: values });
  assert.deepEqual(selected.slice(0, 3).map((row) => row.operatorFamily), ["alchemy", "infura", "alchemy"]);
  assert.equal(selected.filter((row) => row.operatorFamily === "alchemy").length, 2);
  assert.equal(selected.length, producer.MAX_CANDIDATES);
});

test("classified transport failure rotates once to the retained same-family endpoint", async () => {
  const primary = "https://primary.invalid/secret-token", secondary = "https://secondary.invalid/secret-token", independent = "https://independent.example/secret-token";
  const rows = {
    [primary]: defaults({ operatorFamily: "alchemy", throwOnce: true, throwOnceCode: "RPC_TRANSPORT" }),
    [secondary]: defaults({ operatorFamily: "alchemy" }),
    [independent]: defaults({ operatorFamily: "infura" }),
  };
  const { artifact, rpc } = await run(rows, [primary, secondary, independent]);
  assert.equal(artifact.trigger.status, "BLOCKED_NO_FLOW");
  assert.equal(artifact.safety.transportFailures, 1); assert.equal(artifact.safety.automaticRetries, 1); assert.equal(artifact.safety.retryExhaustions, 0);
  assert.equal(rpc.calls.filter((entry) => entry.url === primary).length, 1);
  assert.ok(rpc.calls.filter((entry) => entry.url === secondary).length > 1);
});

test("default candidate pool puts fixed fallback then hostname-only Optimism hints first and stays bounded", () => {
  const fallback = require("./shared-rpc").PUBLIC_FALLBACKS[producer.CHAIN_ID];
  const hinted = "https://node.optimism.alchemy.com/credential-shaped-path";
  const inventory = [fallback, "https://ordinary.alchemy.com/rpc", hinted,
    ...Array.from({ length: 50 }, (_, index) => `https://inventory-${index}.invalid/rpc`)];
  const rows = producer.candidatePool({ inventoryLoader: () => inventory });
  assert.equal(rows[0].handle, fallback);
  assert.equal(rows[1].handle, hinted);
  assert.equal(rows.filter((row) => row.handle === fallback).length, 1);
  assert.equal(rows.length, producer.MAX_CANDIDATES);
});

test("state reads use the common hash, canonical EIP-1898 selectors, and an exact chunk-shaped Supplied probe", async () => {
  const { artifact, rpc } = await run(pair());
  const stateCalls = rpc.calls.filter((entry) => ["eth_getCode", "eth_getStorageAt", "eth_call"].includes(entry.method));
  assert.ok(stateCalls.length > 0);
  for (const entry of stateCalls) {
    const selector = entry.params.at(-1);
    assert.deepEqual(selector, { blockHash: artifact.pin.hash, requireCanonical: true });
  }
  const canaries = rpc.calls.filter((entry) => entry.method === "eth_getLogs" && entry.params[0].topics.length === 1);
  const flowReads = rpc.calls.filter((entry) => entry.method === "eth_getLogs" && entry.params[0].topics.length === 4);
  assert.equal(flowReads.length, 8);
  assert.equal(flowReads.every((entry) => BigInt(entry.params[0].toBlock) - BigInt(entry.params[0].fromBlock) < 50000n), true);
  assert.equal(canaries.length, 2);
  assert.equal(canaries.every((entry) => entry.params[0].address === producer.MANAGER
    && entry.params[0].topics[0] === producer.SUPPLIED_TOPIC
    && BigInt(entry.params[0].toBlock) - BigInt(entry.params[0].fromBlock) < 50000n), true);
});

test("terminal full-header drift fails closed as pin consensus unavailable", async () => {
  const drifting = defaults({ terminalHeader: HEADER("ab", BLOCK, { stateRoot: `0x${"12".repeat(32)}` }) });
  const { artifact } = await run(pair(drifting, structuredClone(drifting)));
  assert.equal(artifact.trigger.status, "INCOMPLETE");
  assert.equal(artifact.diagnostics.failurePhase, "PIN_CONSENSUS");
  assert.equal(artifact.diagnostics.failureCode, "PIN_CONSENSUS_UNAVAILABLE");
});

test("schema, leak guard, and atomic stale-positive replacement remain unchanged", async () => {
  const positive = producer.baseArtifact(() => 1800000000000);
  positive.pin = { number: String(BLOCK), hash: HEADER().hash, timestamp: "1800000000", finalized: true, headerFamilies: 2, stateFamilies: 2 };
  positive.runtime = { implementation: HISTORICAL.implementation, proxyRuntimeHash: HISTORICAL.proxyRuntimeHash,
    implementationRuntimeHash: HISTORICAL.implementationRuntimeHash, changedFromHistorical: false, exactCurrentSourceBound: true };
  positive.pools[0] = { ...positive.pools[0], assetsRaw: "110", sharesRaw: "100", liquidRaw: "110", minSharesRaw: "10",
    zeroShareMaxRaw: "1", recentSupplyEventCount: 1, recentNonDustSupply: true,
    recentWindowFrom: String(BLOCK - 99999), recentWindowTo: String(BLOCK) };
  positive.pools[1] = { ...positive.pools[1], assetsRaw: "100", sharesRaw: "100", liquidRaw: "100", minSharesRaw: "10",
    zeroShareMaxRaw: "0", recentWindowFrom: String(BLOCK - 99999), recentWindowTo: String(BLOCK) };
  positive.trigger = { status: "POSITIVE_FLOW", positive: true, reason: "RECENT_NON_DUST_SUPPLY_OBSERVED" };
  positive.economics.status = "TRIGGER_POSITIVE_GROSS_ONLY";
  positive.gates = { sourceCurrent: "PASS", runtimeBound: "PASS", nonDustFlow: "PASS", feasibleCapital: "UNKNOWN",
    liquidExit: "UNKNOWN", economicsComplete: "FAIL", conservativeNetPositive: "UNKNOWN", keylessForkJustified: "PASS" };
  positive.diagnostics = { ...positive.diagnostics, candidatesConsidered: 2, qualificationAttempts: 2, chainMatches: 2,
    finalizedQualified: 2, pinConsensusFamilies: 2, stateAttempts: 2, stateSuccesses: 2,
    stateConsensusFamilies: 2, stateDistinctGroups: 1, flowAttempts: 2, flowSuccesses: 2,
    flowConsensusFamilies: 2, flowDistinctGroups: 1 };
  assert.equal(producer.validateArtifact(positive), true);
  const incomplete = producer.baseArtifact(() => 1800000000001);
  incomplete.diagnostics.failurePhase = "QUALIFICATION";
  incomplete.diagnostics.failureCode = "TWO_FAMILIES_UNAVAILABLE";
  assert.equal(producer.validateArtifact(incomplete), true);
  const directory = path.resolve("C:\\virtual-etherfi-trigger-test");
  const outputPath = path.join(directory, "etherfi-debtmanager-profit-trigger.json");
  const fsImpl = new MemoryFs();
  producer.publishAtomic(positive, { fsImpl, outputPath, allowedRoot: directory });
  producer.publishAtomic(incomplete, { fsImpl, outputPath, allowedRoot: directory });
  const published = JSON.parse(fsImpl.readFileSync(outputPath).toString("utf8"));
  assert.equal(published.trigger.status, "INCOMPLETE");
  assert.equal(JSON.stringify(published).includes("https://"), false);
});
