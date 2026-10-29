"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const binding = require("./run-base-metamorpho-v1-1-factory-binding");

const URL_A = "https://base-a.nodealpha.org/rpc";
const URL_B = "https://base-b.nodebeta.net/rpc";
const INVENTORY = `[Base public open no-auth]\nBase public ${URL_A}\nBase public ${URL_B}`;
const OTHER = "0x1111111111111111111111111111111111111111";
const IMMUTABLE_START = 32;

const hex = (value, bytes = 32) => `0x${BigInt(value).toString(16).padStart(bytes * 2, "0")}`;
const quantity = (value) => `0x${BigInt(value).toString(16)}`;

function buildFixture(overrides = {}) {
  return {
    authority: { ...binding.AUTHORITY },
    checkedOutHead: "2d160ba9bb945ca3bf12efb182427445dce59c27",
    detachedHead: binding.AUTHORITY.sourceCommit,
    checkedOutUnchanged: true,
    detached: true,
    submodulesExact: true,
    submoduleCount: 5,
    lockStateExact: true,
    cleanupComplete: true,
    runtime: Buffer.alloc(128, 0x60),
    immutableReferences: [{ start: IMMUTABLE_START, length: 32 }],
    ...overrides
  };
}

function runtimeWithMorpho(address = binding.AUTHORITY.morpho) {
  const runtime = Buffer.alloc(128, 0x60);
  Buffer.from(`${"0".repeat(24)}${address.slice(2)}`, "hex").copy(runtime, IMMUTABLE_START);
  return `0x${runtime.toString("hex")}`;
}

function header(variant = 0) {
  const number = binding.AUTHORITY.startBlock + 1000;
  return {
    number: quantity(number),
    hash: hex(number * 100 + variant + 1),
    parentHash: hex(number * 100 + variant),
    stateRoot: hex(number * 200 + variant),
    timestamp: quantity(1_800_000_000)
  };
}

function rpcRow(envelope, result) {
  const value = { jsonrpc: "2.0", id: envelope.id, result };
  return { value, bytes: Buffer.byteLength(JSON.stringify(value), "utf8") };
}

function transportFixture(config = {}) {
  const calls = [];
  const headerReads = new Map();
  const transport = async ({ candidate, envelope }) => {
    calls.push({ ordinal: candidate.ordinal, method: envelope.method, params: envelope.params });
    if (envelope.method === "eth_chainId") return rpcRow(envelope, config.wrongChain === candidate.ordinal ? "0x1" : "0x2105");
    if (envelope.method === "eth_getBlockByNumber") {
      const reads = (headerReads.get(candidate.ordinal) || 0) + 1;
      headerReads.set(candidate.ordinal, reads);
      const variant = config.headerVariant ? config.headerVariant(candidate, reads, envelope.params[0]) : 0;
      return rpcRow(envelope, header(variant));
    }
    if (envelope.method === "eth_getCode") {
      const target = envelope.params[0];
      assert.equal(envelope.params[1].requireCanonical, true);
      if (target === binding.AUTHORITY.factory) {
        const value = config.factoryRuntime ? config.factoryRuntime(candidate) : runtimeWithMorpho();
        return rpcRow(envelope, value);
      }
      assert.equal(target, binding.AUTHORITY.morpho);
      return rpcRow(envelope, config.morphoRuntime || "0x6000");
    }
    assert.equal(envelope.method, "eth_call");
    assert.deepEqual(envelope.params[0], { to: binding.AUTHORITY.factory, data: binding.MORPHO_SELECTOR });
    const getter = config.getter ? config.getter(candidate) : binding.AUTHORITY.morpho;
    return rpcRow(envelope, `0x${"0".repeat(24)}${getter.slice(2)}`);
  };
  transport.calls = calls;
  return transport;
}

function options(transport, extra = {}) {
  return {
    buildAdapter: async () => buildFixture(),
    inventoryText: INVENTORY,
    inventoryIdentity: "stable-fixture",
    assertInventoryUnchangedFn: (identity) => assert.equal(identity, "stable-fixture"),
    transport,
    requestMs: 500,
    ...extra
  };
}

test("exact authority build and two agreeing families bind direct runtime and MORPHO", async () => {
  const transport = transportFixture();
  const result = await binding.runBinding(options(transport));
  assert.equal(result.status, binding.STATUS_BOUND);
  assert.equal(result.anonymousCandidateCount, 2);
  assert.equal(result.anonymousQualifiedCount, 2);
  assert.equal(result.anonymousFamilyCount, 2);
  assert.equal(result.readCount, 12);
  assert.equal(result.binding.authorityExact, true);
  assert.equal(result.binding.detachedWorktreeExact, true);
  assert.equal(result.binding.dependenciesExact, true);
  assert.equal(result.binding.buildExact, true);
  assert.equal(result.binding.twoIndependentFamilies, true);
  assert.equal(result.binding.finalizedAgreement, true);
  assert.equal(result.binding.directTopology, true);
  assert.equal(result.binding.boundMorpho, true);
  assert.equal(result.binding.exactRuntime, true);
  assert.equal(result.binding.terminalHeaderStable, true);
  assert.equal(result.binding.inventoryStable, true);
  assert.equal(result.forkEligible, false);
  assert.equal(result.routePositive, false);
  assert.equal(result.execution, false);
  assert.equal(result.signed, false);
  assert.ok(transport.calls.every((call) => ["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_call"].includes(call.method)));
});

test("authority mismatch, detached checkout mismatch, and build failure fail closed", async (t) => {
  await t.test("authority mismatch", async () => {
    const bad = buildFixture({ authority: { ...binding.AUTHORITY, sourceCommit: "0".repeat(40) } });
    const result = await binding.runBinding(options(transportFixture(), { buildAdapter: async () => bad }));
    assert.equal(result.status, binding.STATUS_INCOMPLETE);
    assert.equal(result.binding.authorityExact, false);
    assert.equal(result.readCount, 0);
    assert.equal(result.failurePhase, "AUTHORITY");
    assert.equal(result.failureCode, "AUTHORITY_MISMATCH");
  });
  await t.test("detached checkout mismatch", async () => {
    const bad = buildFixture({ detachedHead: "1".repeat(40) });
    const result = await binding.runBinding(options(transportFixture(), { buildAdapter: async () => bad }));
    assert.equal(result.status, binding.STATUS_INCOMPLETE);
    assert.equal(result.binding.detachedWorktreeExact, false);
    assert.equal(result.failurePhase, "WORKTREE");
    assert.equal(result.failureCode, "WORKTREE_STATE_MISMATCH");
  });
  await t.test("build failure", async () => {
    const result = await binding.runBinding(options(transportFixture(), { buildAdapter: async () => { throw new Error("fixture compiler unavailable"); } }));
    assert.equal(result.status, binding.STATUS_INCOMPLETE);
    assert.equal(result.binding.buildExact, false);
    assert.equal(result.readCount, 0);
    assert.equal(result.failurePhase, "BUILD");
    assert.equal(result.failureCode, "BUILD_FAILED");
  });
});

test("build-only observability classifies every finite build-stage failure", async (t) => {
  const cases = [
    ["authority", buildFixture({ authority: { ...binding.AUTHORITY, contract: "WrongFactory" } }), "AUTHORITY", "AUTHORITY_MISMATCH"],
    ["worktree", buildFixture({ checkedOutUnchanged: false }), "WORKTREE", "WORKTREE_STATE_MISMATCH"],
    ["submodule", buildFixture({ submodulesExact: false }), "SUBMODULE", "SUBMODULE_STATE_MISMATCH"],
    ["compiler", new binding.BindingError("COMPILER_UNAVAILABLE", true), "COMPILER", "COMPILER_UNAVAILABLE"],
    ["build", buildFixture({ runtime: Buffer.alloc(0) }), "BUILD", "BUILD_ARTIFACT_INVALID"]
  ];
  for (const [name, fixture, phase, code] of cases) {
    await t.test(name, async () => {
      const buildAdapter = async () => {
        if (fixture instanceof Error) throw fixture;
        return fixture;
      };
      const result = await binding.runBuildOnly({ buildAdapter });
      assert.equal(result.status, binding.STATUS_INCOMPLETE);
      assert.equal(result.failurePhase, phase);
      assert.equal(result.failureCode, code);
      assert.equal(binding.FAILURE_PHASES.includes(result.failurePhase), true);
      assert.doesNotMatch(JSON.stringify(result), /WrongFactory|compiler unavailable|stderr|https?:\/\//iu);
    });
  }
});

test("two-family disagreements and incorrect bound MORPHO fail closed", async (t) => {
  await t.test("header disagreement", async () => {
    const result = await binding.runBinding(options(transportFixture({
      headerVariant: (candidate) => candidate.ordinal === 1 ? 1 : 0
    })));
    assert.equal(result.status, binding.STATUS_INCOMPLETE);
    assert.equal(result.binding.twoIndependentFamilies, false);
  });
  await t.test("factory code disagreement", async () => {
    const result = await binding.runBinding(options(transportFixture({
      factoryRuntime: (candidate) => candidate.ordinal === 0 ? runtimeWithMorpho() : `${runtimeWithMorpho().slice(0, -2)}61`
    })));
    assert.equal(result.status, binding.STATUS_INCOMPLETE);
    assert.equal(result.binding.factoryCodeAgreement, false);
  });
  await t.test("incorrect MORPHO getter", async () => {
    const result = await binding.runBinding(options(transportFixture({ getter: () => OTHER })));
    assert.equal(result.status, binding.STATUS_INCOMPLETE);
    assert.equal(result.binding.boundMorpho, false);
  });
  await t.test("incorrect MORPHO immutable", async () => {
    const result = await binding.runBinding(options(transportFixture({ factoryRuntime: () => runtimeWithMorpho(OTHER) })));
    assert.equal(result.status, binding.STATUS_INCOMPLETE);
    assert.equal(result.binding.exactRuntime, false);
  });
  await t.test("runtime mismatch outside immutable", async () => {
    const changed = `${runtimeWithMorpho().slice(0, -2)}61`;
    const result = await binding.runBinding(options(transportFixture({ factoryRuntime: () => changed })));
    assert.equal(result.status, binding.STATUS_INCOMPLETE);
    assert.equal(result.binding.exactRuntime, false);
  });
});

test("terminal header recheck change is rejected", async () => {
  const result = await binding.runBinding(options(transportFixture({
    headerVariant: (_candidate, reads) => reads > 1 ? 1 : 0
  })));
  assert.equal(result.status, binding.STATUS_INCOMPLETE);
  assert.equal(result.binding.exactRuntime, true);
  assert.equal(result.binding.terminalHeaderStable, false);
});

test("public endpoint filtering remains strict and inventory-ordered", () => {
  const rows = binding.parsePublicBaseInventory([
    "[Base public open no-auth]",
    `Base public ${URL_B}`,
    "Base credentialed https://base.secretvendor.org/rpc?key=secret",
    "Base private restricted https://base.privatevendor.net/rpc",
    "Ethereum public https://eth.publicvendor.org/rpc",
    `Base public ${URL_A}`
  ].join("\n"));
  assert.deepEqual(rows.map((row) => row.url.href), [URL_B, URL_A]);
  assert.deepEqual(rows.map((row) => row.ordinal), [0, 4]);
});

test("inventory mutation after binding is incomplete", async () => {
  const result = await binding.runBinding(options(transportFixture(), {
    assertInventoryUnchangedFn: () => { throw new Error("fixture inventory changed"); }
  }));
  assert.equal(result.status, binding.STATUS_INCOMPLETE);
  assert.equal(result.failurePhase, "INVENTORY");
  assert.equal(result.failureCode, "INVENTORY_MUTATED");
  assert.equal(result.binding.inventoryStable, false);
});

test("output contains no raw addresses, endpoints, headers, code, or source artifact material", async () => {
  const result = await binding.runBinding(options(transportFixture()));
  const serialized = JSON.stringify(result).toLowerCase();
  for (const forbidden of [binding.AUTHORITY.factory, binding.AUTHORITY.morpho, URL_A, URL_B, "nodealpha.org", "nodebeta.net",
    runtimeWithMorpho(), header().hash, "metamorphov1_1factory.sol"] ) {
    assert.equal(serialized.includes(forbidden.toLowerCase()), false, `leaked ${forbidden}`);
  }
  assert.doesNotMatch(serialized, /https?:\/\//u);
  assert.doesNotMatch(serialized, /0x[0-9a-f]{8,}/u);
  assert.match(result.authorityCommitment, /^authority_[A-Za-z0-9_-]{43}$/u);
  assert.match(result.derivedHash, /^derived_[A-Za-z0-9_-]{43}$/u);
});

test("same injected build and RPC evidence is deterministic", async () => {
  const first = await binding.runBinding(options(transportFixture()));
  const second = await binding.runBinding(options(transportFixture()));
  assert.deepEqual(second, first);
});
