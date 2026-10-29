"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { id } = require("ethers");
const shared = require("../shared-rpc");
const preflight = require("../lib/common-finalized-rpc-preflight");
const { openPinnedCollection, LIMITS } = require("../lib/aave-v4-pinned-collection");
const { MAX_ENDPOINTS_PER_FAMILY } = require("../lib/rpc-provider-reliability");

// Synthetic fixtures only: never load the real inventory or dispatch network IO.
test.beforeEach(t => {
  t.mock.method(global, "fetch", () => assert.fail("network prohibited"));
  t.mock.method(shared, "loadRpcUrls", () => assert.fail("inventory reads prohibited"));
});
const NOW = Date.parse("2026-10-17T20:00:00Z");
const ADDRESS = "0x" + "11".repeat(20);
const word = n => "0x" + BigInt(n).toString(16).padStart(64, "0");
const coverage = { stateReadsAttempted: 3, stateReadsSucceeded: 3, stateReadsFailed: 0 };
const trusted = handle => Boolean(preflight.classifyOperatorFamily(handle)) && !shared.getOrigin(handle);
const scoped = { preferredChainId: 8453, candidateFilter: trusted };
const domains = ["alchemy.com", "infura.io", "quiknode.pro", "ankr.com", "publicnode.com", "1rpc.io", "0xrpc.io", "drpc.org"];
const unknown = Array.from({ length: 140 }, (_, i) => `https://unknown-${i}.invalid/rpc`);
const rows = domains.flatMap(domain => [
  `https://polygon.${domain}/fixture`, `https://arbitrum.${domain}/fixture`,
  `https://ethereum.${domain}/fixture`, `https://optimism.${domain}/fixture`,
  `https://base-mainnet.${domain}/fixture`,
]);
const inventory = [...unknown, ...rows].join("\n");
function header(n) {
  return { number: "0x" + n.toString(16), hash: word(n), parentHash: word(n - 1), stateRoot: word(900),
    timestamp: "0x" + (NOW / 1000 - 600).toString(16) };
}
function fixture(chainOf = () => 8453, probeAddress = ADDRESS) {
  const calls = [];
  const state = { corrupt: false, stateHash: word(100) };
  const candidates = ["alchemy", "infura"].map((operatorFamily, i) => ({ handle: `fixture-${i}`, operatorFamily, inventoryOrder: i }));
  const rpc = async (handle, method, params) => {
    calls.push({ handle, method, params });
    if (method === "eth_chainId") return "0x" + chainOf(handle).toString(16);
    if (method === "eth_getBlockByNumber") {
      const result = header(params[0] === "finalized" ? 100 : Number(BigInt(params[0])));
      return state.corrupt ? { ...result, stateRoot: word(901) } : result;
    }
    if (method === "eth_getLogs") {
      assert.equal(params[0].blockHash, state.stateHash);
      assert.deepEqual(params[0].topics, [word(0)]);
      return [];
    }
    assert.deepEqual(params.at(-1), { blockHash: state.stateHash, requireCanonical: true });
    if (method === "eth_getCode") return "0x6000";
    if (method === "eth_getStorageAt") return word(0);
    if (method === "eth_call") {
      assert.deepEqual(params[0], { to: probeAddress, data: id("getAssetCount()").slice(0, 10) });
      return word(1);
    }
    assert.fail("unexpected RPC method");
  };
  return { calls, state, options: { rpc, candidates, probeAddress, now: () => NOW } };
}
async function readState(context, address = ADDRESS) {
  await context.provider.getCode(address);
  await context.provider.getStorage(address, word(0));
  await context.provider.call({ to: address, data: id("getAssetCount()").slice(0, 10) });
}

test("Base emits the selected chain only after exact terminal confirmation, without changing normalized pin shape or limits", async () => {
  const f = fixture();
  const context = await openPinnedCollection({ ...f.options, chainId: 8453 });
  assert.equal(context.chainId, 8453);
  assert.deepEqual(context.pin, preflight.normalizeHeader(header(100)));
  assert.equal(Object.hasOwn(context.pin, "chainId"), false);
  assert.ok(Object.isFrozen(context.pin));
  await readState(context);
  assert.equal(context.observationPin(coverage), null);
  await context.confirmPin();
  assert.deepEqual(context.observationPin(coverage), {
    schema: "aave-v4-state-pin/v1", chainId: 8453, blockNumber: 100, blockHash: word(100),
    stateRoot: word(900), finality: "finalized", stateReadsPinned: 3,
    terminalBlockNumber: 100, terminalBlockHash: word(100), headerFamilies: 2, stateFamilies: 1, rpcStrength: "single-provider",
  });
  assert.equal(context.statistics().automaticRetries, 0);
  assert.deepEqual(LIMITS, { maxCandidates: 16, maxRequests: 12000, maxMs: 240000, timeoutMs: 10000,
    maxBytes: 4 * 1024 * 1024, concurrency: 4, reserveRequests: 8, maxPinAgeMs: 30 * 60_000 });
});

test("real Base collection qualifies and confirms through a frozen hub-only state/log target guard", async () => {
  const hub = "0xa4d5947eb727a052bae69c593ffc84247ec9864e";
  const allowed = Object.freeze(new Set([hub]));
  const f = fixture(() => 8453, hub);
  const attempts = [];
  const rpc = async (handle, method, params, timeout) => {
    const target = method === "eth_call" ? params[0].to
      : method === "eth_getLogs" ? params[0].address
        : ["eth_getCode", "eth_getStorageAt"].includes(method) ? params[0] : null;
    if (target !== null) {
      const targets = Array.isArray(target) ? target : [target];
      attempts.push(...targets);
      for (const address of targets) assert.ok(allowed.has(address.toLowerCase()), "UNDECLARED_TARGET");
    }
    return f.options.rpc(handle, method, params, timeout);
  };
  const context = await openPinnedCollection({ ...f.options, chainId: 8453, rpc });
  assert.equal(context.chainId, 8453);
  assert.equal(context.statistics().qualification.stateCapableFamilies, 2);
  assert.equal(context.statistics().headerFamilies, 2);
  assert.deepEqual(context.pin, preflight.normalizeHeader(header(100)));
  assert.equal(Object.hasOwn(context.pin, "chainId"), false);
  await readState(context, hub);
  assert.equal(context.observationPin(coverage), null);
  await context.confirmPin();
  assert.equal(context.observationPin(coverage).chainId, 8453);
  const logs = f.calls.filter(row => row.method === "eth_getLogs");
  assert.equal(logs.length, 4);
  assert.ok(logs.every(row => row.params[0].address === hub));
  assert.equal(new Set(logs.map(row => row.handle)).size, 2);
  assert.ok(attempts.length > 0 && attempts.every(address => address === hub));
  assert.equal(attempts.includes("0x" + "0".repeat(40)), false);
});

test("Base can collect at a same-chain requested pin using canonical EIP-1898 reads", async () => {
  const f = fixture();
  // Qualification still probes finalized block 100 before using requested block 99.
  const rpc = f.options.rpc;
  const context = await openPinnedCollection({ ...f.options, chainId: 8453,
    requestedPin: { chainId: 8453, finality: "finalized", blockNumber: 99, blockHash: word(99) }, rpc });
  f.state.stateHash = word(99);
  await readState(context);
  await context.confirmPin();
  assert.equal(context.observationPin(coverage).chainId, 8453);
  assert.equal(context.observationPin(coverage).blockHash, word(99));
});

test("Base-looking Ethereum-only providers fail before any finalized or state reads", async () => {
  const f = fixture(() => 1);
  const candidates = ["alchemy.com", "infura.io"].map(domain => {
    const handle = `https://base-mainnet.${domain}/fixture`;
    return { handle, ...preflight.classifyOperatorFamily(handle) };
  });
  await assert.rejects(openPinnedCollection({ ...f.options, chainId: 8453, candidates }), error => {
    assert.equal(error.code, "TWO_FAMILIES_UNAVAILABLE");
    assert.equal(error.diagnostics.chainMatches, 0);
    return true;
  });
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(row => row.method === "eth_chainId"));
});

test("requested pins cannot cross between Ethereum and Base", async () => {
  for (const [chainId, requestedChainId] of [[8453, 1], [1, 8453]]) {
    const f = fixture(() => chainId);
    await assert.rejects(openPinnedCollection({ ...f.options, chainId,
      requestedPin: { chainId: requestedChainId, finality: "finalized", blockNumber: 99, blockHash: word(99) },
    }), { code: "REQUESTED_PIN_INVALID" });
    assert.ok(!f.calls.some(row => row.method === "eth_getBlockByNumber" && row.params[0] === "0x63"));
  }
});

test("invalid and unsupported chain IDs reject before candidate loading or transport", async () => {
  for (const chainId of [null, "8453", "1", 0, -1, 10, 137, 84532, NaN, Infinity, 1.5, {}, 8453n]) {
    await assert.rejects(openPinnedCollection({ chainId, probeAddress: ADDRESS,
      get candidates() { assert.fail("candidates must not be accessed"); },
      loadCandidates: () => assert.fail("loader must not be called"),
      rpc: () => assert.fail("transport must not be called"),
    }), { code: "INVALID_CHAIN_ID" });
  }
});

test("Base terminal header metadata mismatch invalidates an already confirmed attestation", async () => {
  const f = fixture();
  const context = await openPinnedCollection({ ...f.options, chainId: 8453 });
  await readState(context);
  await context.confirmPin();
  assert.ok(context.observationPin(coverage));
  f.state.corrupt = true;
  await assert.rejects(context.confirmPin(), { code: "TERMINAL_PIN_MISMATCH" });
  assert.equal(context.observationPin(coverage), null);
});

test("two Base endpoints from one operator never satisfy the two-family minimum", async () => {
  const f = fixture();
  await assert.rejects(openPinnedCollection({ ...f.options, chainId: 8453,
    candidates: f.options.candidates.map(row => ({ ...row, operatorFamily: "alchemy" })),
  }), error => error.code === "TWO_FAMILIES_UNAVAILABLE" && error.diagnostics.stateCapableFamilies === 1);
});

test("common-finalized preflight rechecks the selected Base chain independently", async () => {
  const counts = new Map();
  const f = fixture(handle => {
    const count = (counts.get(handle) || 0) + 1;
    counts.set(handle, count);
    return count === 1 ? 8453 : 1;
  });
  await assert.rejects(openPinnedCollection({ ...f.options, chainId: 8453 }), { code: "TWO_FAMILIES_UNAVAILABLE" });
  assert.deepEqual([...counts.values()], [2, 2]);
});

test("default Ethereum and explicit chain 1 retain identical calls, statistics and output", async () => {
  const outputs = [];
  for (const options of [{}, { chainId: 1 }]) {
    const f = fixture(() => 1);
    const context = await openPinnedCollection({ ...f.options, ...options });
    assert.equal(context.chainId, 1);
    const logs = f.calls.filter(row => row.method === "eth_getLogs");
    assert.equal(logs.filter(row => row.params[0].address === "0x" + "0".repeat(40)).length, 2);
    assert.equal(logs.filter(row => row.params[0].address === ADDRESS).length, 2);
    await readState(context);
    await context.confirmPin();
    outputs.push({ calls: f.calls, pin: context.pin, statistics: context.statistics(), observation: context.observationPin(coverage) });
  }
  assert.deepEqual(outputs[0], outputs[1]);
  assert.equal(outputs[0].observation.chainId, 1);
  assert.equal(Object.hasOwn(outputs[0].statistics, "chainId"), false);
});

test("injected candidates retain priority and injected loaders retain their zero-argument contract on both chains", async () => {
  for (const chainId of [1, 8453]) {
    const f = fixture(() => chainId);
    let loads = 0;
    const loadCandidates = function (...args) {
      assert.equal(this, undefined);
      assert.deepEqual(args, []);
      loads += 1;
      return f.options.candidates;
    };
    await openPinnedCollection({ ...f.options, chainId, loadCandidates });
    assert.equal(loads, 0);
    await openPinnedCollection({ ...f.options, chainId, candidates: undefined, loadCandidates });
    assert.equal(loads, 1);
  }
});

test("Base trust filtering and hints run before family/global caps under a large multichain inventory", () => {
  const baseline = shared.parseRpcInventory(inventory);
  assert.equal(baseline.length, 128);
  assert.equal(baseline.some(handle => new URL(handle).hostname.startsWith("base-mainnet.")), false);
  const selected = shared.parseRpcInventory(inventory, scoped);
  assert.equal(selected.length, 16);
  assert.ok(selected.every(trusted));
  for (const family of preflight.REVIEWED_OPERATOR_FAMILY_IDS) {
    const kept = selected.filter(handle => preflight.classifyOperatorFamily(handle).operatorFamily === family);
    assert.equal(kept.length, MAX_ENDPOINTS_PER_FAMILY);
    assert.ok(kept.some(handle => new URL(handle).hostname.startsWith("base-mainnet.")));
  }
  assert.equal(shared.parseRpcInventory(inventory, { ...scoped, maxCandidates: 1 })[0], "https://base-mainnet.alchemy.com/fixture");
  assert.equal(shared.parseRpcInventory(inventory, { ...scoped, maxCandidates: 999 }).length, 16);
  assert.equal(shared.parseRpcInventory(unknown.join("\n"), { preferredChainId: 8453, maxCandidates: 999 }).length, 128);
});

test("Base selection recognizes exact hostname labels and reviewed /base provider paths", () => {
  for (const hint of [
    "https://base-mainnet.g.alchemy.com/v2/FAKE_KEY", "https://base-mainnet.infura.io/v3/FAKE_KEY",
    "https://base-mainnet.quiknode.pro/FAKE_KEY", "https://BASE.publicnode.com", "https://base-rpc.publicnode.com",
    "https://base.drpc.org", "https://rpc.ankr.com/base/FAKE_KEY", "https://1rpc.io/base", "https://0xrpc.io/base",
  ]) {
    const family = preflight.classifyOperatorFamily(hint).operatorFamily;
    const domain = domains[preflight.REVIEWED_OPERATOR_FAMILY_IDS.indexOf(family)];
    const text = [`https://polygon.${domain}/first`, `https://arbitrum.${domain}/second`, hint].join("\n");
    assert.deepEqual(shared.parseRpcInventory(text, { ...scoped, maxCandidates: 1 }), [hint]);
  }
});

test("ambiguous Base lookalikes, query hints and unreviewed paths do not affect ordering", () => {
  for (const nonHint of [
    "https://baseish.publicnode.com/rpc", "https://my-base.publicnode.com/rpc", "https://base-mainnets.publicnode.com/rpc",
    "https://mainnet.publicnode.com/base", "https://ethereum.publicnode.com/?chainId=8453",
    "https://rpc.ankr.com/baseish", "https://polygon.ankr.com/base", "https://1rpc.io/base-mainnet",
  ]) {
    const family = preflight.classifyOperatorFamily(nonHint).operatorFamily;
    const domain = domains[preflight.REVIEWED_OPERATOR_FAMILY_IDS.indexOf(family)];
    const first = `https://polygon.${domain}/first`;
    assert.deepEqual(shared.parseRpcInventory([first, nonHint].join("\n"), { ...scoped, maxCandidates: 1 }), [first]);
  }
});

test("Base hints cannot bypass caller-opted known-family/origin exclusions", () => {
  const text = ["https://:80", "https://base.unknown.invalid", "https://base.publicnode.com.evil.invalid",
    "https://app.aave.com/api/rpc-proxy?chainId=8453", "https://base.alchemy.com/rpc?proxy=app.aave.com/api/rpc-proxy",
    "https://base.nodereal.io/rpc", "https://base-sepolia.infura.io/v3/FAKE_KEY"].join("\n");
  assert.deepEqual(shared.parseRpcInventory(text, scoped), []);
  assert.ok(shared.parseRpcInventory("https://base.unknown.invalid", { preferredChainId: 8453 }).length,
    "shared parsing itself does not add an Aave-only trust filter");
});

test("unopted parsing and unsupported preferences retain legacy Optimism replacement and Ethereum ordering", () => {
  const [polygon, arbitrum, ethereum, optimism, base] = rows.slice(0, 5);
  const text = [polygon, arbitrum, ethereum, optimism, base].join("\n");
  assert.deepEqual(shared.parseRpcInventory(text), [polygon, optimism]);
  assert.deepEqual(shared.parseRpcInventory(text, { preferredChainId: 1 }), [ethereum, polygon]);
  assert.deepEqual(shared.parseRpcInventory(text, { preferredChainId: 8453 }), [base, polygon]);
  for (const preferredChainId of ["8453", "1", 10, 137, 84532, {}, null, NaN]) {
    assert.deepEqual(shared.parseRpcInventory(text, { preferredChainId }), [polygon, optimism]);
  }
});

test("Base hint sorting preserves capability tiers, stable equal-tier order and existing duplicate/cap semantics", () => {
  const a = "https://base.alchemy.com/first", b = "https://base.infura.io/second";
  const publicBase = "https://base.publicnode.com/third";
  const other = "https://polygon.alchemy.com/other";
  assert.deepEqual(shared.parseRpcInventory([publicBase, other, a, b].join("\n"), { ...scoped, maxCandidates: 3 }), [a, b, other]);
  assert.deepEqual(shared.parseRpcInventory([other, a, a, b, publicBase].join("\n"), scoped), [a, a, b, publicBase]);
});

test("Aave default loader threads Base preference into bounded synthetic inventory admission", async t => {
  let selected;
  t.mock.method(shared, "loadRpcUrls", options => {
    assert.equal(options.maxCandidates, 128);
    assert.equal(options.preferredChainId, 8453);
    assert.equal(typeof options.candidateFilter, "function");
    selected = shared.parseRpcInventory(inventory, options);
    return selected;
  });
  const f = fixture(handle => new URL(handle).hostname.startsWith("base-mainnet.") ? 8453 : 1);
  const context = await openPinnedCollection({ ...f.options, candidates: undefined, chainId: 8453 });
  assert.equal(selected.length, 16);
  assert.equal(context.statistics().qualification.candidatesConsidered, 16);
  assert.equal(context.statistics().qualification.chainMatches, 8);
  assert.equal(context.statistics().qualification.stateCapableFamilies, 8);
  assert.ok(f.calls.filter(row => row.method !== "eth_chainId")
    .every(row => new URL(row.handle).hostname.startsWith("base-mainnet.")));
  await readState(context);
  await context.confirmPin();
  assert.equal(context.observationPin(coverage).chainId, 8453);
});
