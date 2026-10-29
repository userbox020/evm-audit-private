"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const shared = require("../shared-rpc");
const preflight = require("../lib/common-finalized-rpc-preflight");
const { openPinnedCollection, LIMITS } = require("../lib/aave-v4-pinned-collection");
const { MAX_ENDPOINTS_PER_FAMILY } = require("../lib/rpc-provider-reliability");

// Static synthetic inventory only. No inventory/credential files or network IO.
const trusted = handle => Boolean(preflight.classifyOperatorFamily(handle)) && !shared.getOrigin(handle);
const scoped = { candidateFilter: trusted, preferredChainId: 1 };
const domains = ["alchemy.com", "infura.io", "quiknode.pro", "ankr.com", "publicnode.com", "1rpc.io", "0xrpc.io", "drpc.org"];
const unknown = Array.from({ length: 140 }, (_, i) => `https://unknown-${i}.invalid/rpc`);
const rows = domains.flatMap(domain => [
  `https://polygon.${domain}/fixture`, `https://arbitrum.${domain}/fixture`,
  `https://ethereum.${domain}/fixture`, `https://optimism.${domain}/fixture`,
]);
const inventory = [...unknown, ...rows].join("\n");
const word = n => "0x" + BigInt(n).toString(16).padStart(64, "0");
const NOW = Date.parse("2026-10-17T20:00:00Z");
const ADDRESS = "0x" + "11".repeat(20);

function mockInventory(t, text = inventory) {
  let selected;
  t.mock.method(shared, "loadRpcUrls", options => {
    assert.equal(options.maxCandidates, 128);
    assert.equal(options.preferredChainId, 1);
    assert.equal(typeof options.candidateFilter, "function");
    selected = shared.parseRpcInventory(text, options);
    return selected;
  });
  t.mock.method(global, "fetch", () => assert.fail("network prohibited"));
  return () => selected;
}
function transport(chainOf = handle => new URL(handle).hostname.startsWith("ethereum.") ? 1 : 137) {
  const calls = [];
  const rpc = async (handle, method, params) => {
    calls.push({ handle, method, params });
    if (method === "eth_chainId") return "0x" + chainOf(handle).toString(16);
    if (method === "eth_getBlockByNumber") {
      const n = params[0] === "finalized" ? 100 : Number(BigInt(params[0]));
      return { number: "0x" + n.toString(16), hash: word(n), parentHash: word(n - 1), stateRoot: word(900), timestamp: "0x" + (NOW / 1000 - 600).toString(16) };
    }
    if (method === "eth_getLogs") return [];
    assert.deepEqual(params.at(-1), { blockHash: word(100), requireCanonical: true });
    if (method === "eth_getCode") return "0x6000";
    if (method === "eth_getStorageAt") return word(0);
    if (method === "eth_call") return word(1);
    assert.fail("unexpected RPC method");
  };
  return { rpc, calls };
}

test("global cap reproduces keyless starvation; opt-in trust selection precedes every cap", () => {
  const baseline = shared.parseRpcInventory(inventory);
  assert.equal(baseline.length, 128);
  assert.equal(baseline.filter(trusted).length, 8);
  assert.equal(baseline.some(handle => /publicnode|1rpc|0xrpc|drpc/.test(handle)), false);
  assert.equal(baseline.some(handle => new URL(handle).hostname.startsWith("ethereum.")), false);
  const selected = shared.parseRpcInventory(inventory, scoped);
  assert.equal(selected.length, 16);
  assert.ok(selected.every(trusted));
  for (const family of preflight.REVIEWED_OPERATOR_FAMILY_IDS) {
    const kept = selected.filter(handle => preflight.classifyOperatorFamily(handle).operatorFamily === family);
    assert.equal(kept.length, MAX_ENDPOINTS_PER_FAMILY);
    assert.ok(kept.some(handle => new URL(handle).hostname.startsWith("ethereum.")));
  }
  assert.equal(shared.parseRpcInventory(inventory, { ...scoped, maxCandidates: 1 })[0], "https://ethereum.alchemy.com/fixture");
  assert.equal(shared.parseRpcInventory(inventory, { ...scoped, maxCandidates: 999 }).length, 16);
  assert.equal(shared.parseRpcInventory(unknown.join("\n"), { maxCandidates: 999 }).length, 128);
  assert.deepEqual(shared.parseRpcInventory("x".repeat(1024 * 1024 + 1), scoped), []);
});

test("default Optimism replacement and filter-only behavior stay unchanged", () => {
  const [polygon, arbitrum, ethereum, optimism] = rows.slice(0, 4);
  const text = [polygon, arbitrum, ethereum, optimism].join("\n");
  assert.deepEqual(shared.parseRpcInventory(text), [polygon, optimism]);
  assert.deepEqual(shared.parseRpcInventory(text, { candidateFilter: trusted }), [polygon, optimism]);
  for (const malformed of ["1", 10, {}, null, NaN]) {
    assert.deepEqual(shared.parseRpcInventory(text, { preferredChainId: malformed }), [polygon, optimism]);
  }
  assert.deepEqual(shared.parseRpcInventory(text, { ...scoped, maxCandidates: 1 }), [ethereum]);
});

test("Ethereum hints use exact labels and unambiguous reviewed provider paths", () => {
  for (const hint of [
    "https://eth-mainnet.g.alchemy.com/v2/FAKE_KEY", "https://mainnet.infura.io/v3/FAKE_KEY",
    "https://ETHEREUM-RPC.publicnode.com", "https://eth.drpc.org",
    "https://rpc.ankr.com/eth/FAKE_KEY", "https://1rpc.io/eth", "https://0xrpc.io/ethereum",
  ]) {
    const family = preflight.classifyOperatorFamily(hint).operatorFamily;
    const domain = domains[preflight.REVIEWED_OPERATOR_FAMILY_IDS.indexOf(family)];
    const text = [`https://polygon.${domain}/other-a`, `https://arbitrum.${domain}/other-b`, hint].join("\n");
    assert.deepEqual(shared.parseRpcInventory(text, { ...scoped, maxCandidates: 1 }), [hint]);
  }
  for (const nonHint of [
    "https://ethereumish.publicnode.com/rpc", "https://my-ethereum.publicnode.com/rpc",
    "https://mainnet.publicnode.com/eth", "https://base.publicnode.com/ethereum",
    "https://base.publicnode.com/?chainId=1", "https://rpc.ankr.com/ethereumish",
    "https://polygon.ankr.com/eth",
    "https://polygon.infura.io/v3/FAKE_KEY?network=mainnet",
  ]) {
    const domain = preflight.classifyOperatorFamily(nonHint).operatorFamily === "infura" ? "infura.io"
      : preflight.classifyOperatorFamily(nonHint).operatorFamily === "ankr" ? "ankr.com" : "publicnode.com";
    const first = `https://polygon.${domain}/first`;
    assert.deepEqual(shared.parseRpcInventory([first, nonHint].join("\n"), { ...scoped, maxCandidates: 1 }), [first]);
  }
});

test("hints never admit unknown, malformed, lookalike or origin-proxy endpoints", () => {
  const text = ["https://:80", "https://ethereum.unknown.invalid", "https://ethereum.publicnode.com.evil.invalid",
    "https://app.aave.com/api/rpc-proxy?chainId=1", "https://ethereum.alchemy.com/rpc?proxy=app.aave.com/api/rpc-proxy",
    "https://ethereum.nodereal.io/rpc", "https://sepolia.infura.io/v3/FAKE_KEY"].join("\n");
  assert.deepEqual(shared.parseRpcInventory(text, scoped), []);
});

test("Aave default loader opts in, retains multiple Ethereum families, and preserves pin guards and caps", async t => {
  const selection = mockInventory(t);
  const f = transport();
  const context = await openPinnedCollection({ rpc: f.rpc, now: () => NOW, probeAddress: ADDRESS });
  assert.equal(selection().length, 16);
  assert.equal(context.statistics().qualification.candidatesConsidered, LIMITS.maxCandidates);
  assert.equal(context.statistics().qualification.chainMatches, 8);
  assert.equal(context.statistics().qualification.stateCapableFamilies, 8);
  assert.equal(context.statistics().headerFamilies, 2);
  const stateMethods = new Set(["eth_getCode", "eth_getStorageAt", "eth_call"]);
  assert.ok(f.calls.filter(row => stateMethods.has(row.method)).every(row => new URL(row.handle).hostname.startsWith("ethereum.")));
  await context.provider.getCode(ADDRESS);
  const coverage = { stateReadsAttempted: 1, stateReadsSucceeded: 1, stateReadsFailed: 0 };
  assert.equal(context.observationPin(coverage), null);
  await context.confirmPin();
  assert.equal(context.observationPin(coverage).blockHash, word(100));
});

test("Ethereum hints cannot substitute for live chain identity or two independent families", async t => {
  mockInventory(t);
  const f = transport(handle => handle === "https://ethereum.alchemy.com/fixture" ? 1 : 137);
  let context;
  await assert.rejects(async () => { context = await openPinnedCollection({ rpc: f.rpc, now: () => NOW, probeAddress: ADDRESS }); }, error => {
    assert.equal(error.code, "TWO_FAMILIES_UNAVAILABLE");
    assert.equal(error.diagnostics.chainMatches, 1);
    assert.equal(error.diagnostics.stateCapableFamilies, 1);
    assert.doesNotMatch(JSON.stringify(error.diagnostics), /https|alchemy|fixture/);
    return true;
  });
  assert.equal(context, undefined, "failed qualification cannot produce a context or observation pin");
  assert.ok(f.calls.filter(row => row.method !== "eth_chainId").every(row => row.handle === "https://ethereum.alchemy.com/fixture"));
});

test("injected loadCandidates bypasses default inventory selection unchanged", async t => {
  t.mock.method(shared, "loadRpcUrls", () => assert.fail("injected loader must not read inventory"));
  const f = transport(() => 1);
  let loads = 0;
  const context = await openPinnedCollection({ rpc: f.rpc, now: () => NOW, probeAddress: ADDRESS,
    loadCandidates: () => { loads += 1; return ["alchemy", "infura"].map((operatorFamily, i) => ({ handle: `fixture-${i}`, operatorFamily })); },
  });
  assert.equal(loads, 1);
  assert.equal(context.statistics().headerFamilies, 2);
});
