"use strict";

/*
 * Focused phase-1 tests for tools/lib/trigger-fork-epoch.js — pure offline epoch core.
 * Wholly synthetic, deterministic fixtures; the injected clock is fixed. These tests
 * establish local contract boundaries only: no real producer, chain state, endpoint,
 * qualification or profitability is invented or claimed, and no runtime path is touched.
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const epoch = require("../lib/trigger-fork-epoch.js");
const {
  BLOCKERS, DESIGN_LIMITS, MANIFEST_SCHEMA, EVENT_SCHEMA, CONSUMED_SCHEMA, IDENTITY_SCHEMA,
  IDENTITY_SCHEMA_VERSION, POLICY_VERSION, OWNER_POLICY_VERSION, INDEPENDENCE_POLICY_VERSION,
  LEGACY_DISPOSITION, UNKNOWN_GAP_POLICY, LEGACY_RATIONALE_CODES, LEGACY_SEARCH_POLICY_CODES
} = epoch;

/* --------------------------- deterministic clock ----------------------------- */
const NOW = Date.parse("2026-10-14T04:00:00.000Z");
const iso = (offset) => new Date(NOW + offset).toISOString();
const hex64 = (ch) => `0x${ch.repeat(64)}`;
const addr = (ch) => `0x${ch.repeat(40)}`;

/* ------------------------- literal known-answer vectors ---------------------- */
/* Independently computed SHA-256 literals over the fixed canonical fixtures below;
 * the module must agree with each. */
const KAT_QUOTE_ID = "0x54ed8e23519348f14079887d1392939e237996c7733a2aa0ba9e55f5287bd068";
const KAT_TRANSITION_ID = "0x9adf51f3a48e249aa2766a92c4c1c2eb065cefff3566f859541209434993311e";
const KAT_CONSUMED_SET_DIGEST =
  "0xc66b0592349f0c2dddd79392b1783ab5f3e79929e3e190cebdf55005abe227b2";
const KAT_MANIFEST_DIGEST = "0xcfaf1ad9236c850404b3c48c49ef4f97de45fbb018b0b77e42fbb41b97036cdd";
const KAT_QUOTE_IDENTITY_CANONICAL = `{"amountInRaw":"100000000","chainId":8453,` +
  `"expectedOutRaw":"103000000","firedStatus":"ATOMIC_FORK_REQUIRED","identityVersion":1,` +
  `"kind":"PIN_QUOTE","pinBlockHash":"${hex64("a")}","pinBlockNumber":"165",` +
  `"route":{"direction":"POOL_A_TO_POOL_B","poolA":"${addr("6")}","poolB":"${addr("7")}",` +
  `"tokenIn":"${addr("4")}","tokenOut":"${addr("5")}"},` +
  `"schema":"trigger-fork-epoch-identity/v1"}`;
const KAT_SAME_HEIGHT_TRANSITION_ID =
  "0x5f46d1e8ed8d19805c441e990b1182552403bcd1484c05a6d65c9b57ef149649";
/* Derived route-key known answer, independently computed over the domain-separated
 * composition { schema: "trigger-fork-epoch-route/v1", chainId, route } of the
 * fixture route. */
const KAT_ROUTE_KEY = "0x31813bd841411a64b95b54d5c45985a384449171fda1eaf46cbe51d3821ee291";
const KAT_ROUTE_KEY_CHAIN_10 = "0x0ad1d559d367a53ddadbdcd391531a8fcffaf96cb0aa0b02ca25317714368f31";
const KAT_TRANSITION_IDENTITY_CANONICAL = `{"chainId":8453,"conditionId":"POOL_UNPAUSED",` +
  `"firedStatus":"TRIGGER_UNPAUSE","identityVersion":1,"kind":"STATE_TRANSITION",` +
  `"schema":"trigger-fork-epoch-identity/v1","subjectContract":"${addr("8")}",` +
  `"transitionBlockHash":"${hex64("b")}","transitionBlockNumber":"164"}`;
const sha256Hex = (text) => `0x${createHash("sha256").update(text, "utf8").digest("hex")}`;

/* ------------------------------ fixture builders ----------------------------- */
const TOKEN_IN = addr("4");
const TOKEN_OUT = addr("5");
const POOL_A = addr("6");
const POOL_B = addr("7");
const SUBJECT_CONTRACT = addr("8");
const CHAIN = {
  primary: 8453,
  companions: [1, 10],
  floors: { 8453: "162", 1: "9000", 10: "9" }
};
const manifestFixture = (patch) => {
  const independence = () => ({
    policyVersion: INDEPENDENCE_POLICY_VERSION,
    qualifyingSourceCount: 2,
    distinctOperationalControl: true,
    distinctUpstreamPath: true,
    unknownSharedProvenance: false
  });
  const chainRecord = (floorNumber) => ({
    floorBlockNumber: floorNumber,
    floorBlockHash: hex64("c"),
    floorHeaderTime: iso(-30000),
    qualifiedAt: iso(-10000),
    independence: independence()
  });
  const value = {
    schema: MANIFEST_SCHEMA,
    epochId: "EP-20261014-a",
    policyVersion: POLICY_VERSION,
    identitySchemaVersion: IDENTITY_SCHEMA_VERSION,
    ownerBinding: { policyVersion: OWNER_POLICY_VERSION, proposalDigest: hex64("a") },
    createdAt: iso(-120000),
    notBefore: iso(-60000),
    expiresAt: iso(300000),
    bounds: {
      maxConsumedIdentities: 8,
      sourceMaxAgeMs: 600000,
      observationMaxAgeMs: 600000,
      floorQualificationMaxAgeMs: 600000,
      futureSkewMs: 60000,
      promotionMaxAgeMs: 120000,
      forkBudgetMs: 210000,
      cleanupBudgetMs: 10000,
      maxInFlight: 1
    },
    scope: {
      primaryChainId: CHAIN.primary,
      companionChainIds: [...CHAIN.companions],
      adapterId: "cross-venue-route-v1",
      scenarioId: "SC-OPUSDC-01",
      adapterDigest: hex64("b"),
      scenarioDigest: hex64("c"),
      producerAllowlist: ["usdc-usdt-route-watch-1"],
      firedStatusAllowlist: ["ATOMIC_FORK_REQUIRED"]
    },
    chains: {
      "8453": chainRecord(CHAIN.floors[8453]),
      "1": chainRecord(CHAIN.floors[1]),
      "10": chainRecord(CHAIN.floors[10])
    },
    legacy: {
      disposition: LEGACY_DISPOSITION,
      archiveDigest: hex64("d"),
      rationaleCode: "LEGACY_V1_INCOMPLETE",
      searchPolicyCode: "NO_RECOVERABLE_IDS"
    },
    predecessor: {
      predecessorEpochId: "EP-20261013-a",
      lineageDigest: hex64("e"),
      ancestry: [{ epochId: "EP-20261013-a", lineageDigest: hex64("e") }],
      inheritedConsumedCount: 0,
      inheritedConsumedDigest: epoch.consumedSetDigest("[]").digest,
      identitySchemaVersion: IDENTITY_SCHEMA_VERSION,
      unknownGapPolicy: UNKNOWN_GAP_POLICY,
      gaps: []
    }
  };
  if (patch) patch(value);
  return value;
};
const quoteEventFixture = (patch) => {
  const value = {
    schema: EVENT_SCHEMA,
    identitySchemaVersion: IDENTITY_SCHEMA_VERSION,
    adapterId: "cross-venue-route-v1",
    adapterDigest: hex64("b"),
    producerId: "usdc-usdt-route-watch-1",
    firedStatus: "ATOMIC_FORK_REQUIRED",
    scenarioId: "SC-OPUSDC-01",
    scenarioDigest: hex64("c"),
    epochId: "EP-20261014-a",
    ownerProposalDigest: hex64("a"),
    source: { digest: hex64("f"), observedAt: iso(-5000) },
    producer: { generatedAt: iso(-2500) },
    observation: { at: iso(-2000) },
    primary: { chainId: CHAIN.primary, blockNumber: "165", blockHash: hex64("a"), headerTime: iso(-1000) },
    companions: [
      { chainId: 1, blockNumber: "9001", blockHash: hex64("2"), headerTime: iso(-1000) },
      { chainId: 10, blockNumber: "10", blockHash: hex64("3"), headerTime: iso(-1000) }
    ],
    target: {
      kind: "PIN_QUOTE",
      chainId: CHAIN.primary,
      pin: { blockNumber: "165", blockHash: hex64("a") },
      route: { tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, poolA: POOL_A, poolB: POOL_B,
        direction: "POOL_A_TO_POOL_B" },
      candidate: { amountInRaw: "100000000", expectedOutRaw: "103000000",
        economicsObservedAt: iso(-2500) }
    }
  };
  if (patch) patch(value);
  return value;
};
const transitionEventFixture = (patch) => {
  const value = {
    ...quoteEventFixture(null),
    adapterId: "pool-unpause-watch-v1",
    producerId: "pool-pause-watch-1",
    firedStatus: "TRIGGER_UNPAUSE",
    target: {
      kind: "STATE_TRANSITION",
      chainId: CHAIN.primary,
      subject: { contract: SUBJECT_CONTRACT },
      conditionId: "POOL_UNPAUSED",
      transition: { blockNumber: "164", blockHash: hex64("b"), headerTime: iso(-2000) }
    }
  };
  if (patch) patch(value);
  return value;
};
const validQuoteManifest = (patch) => {
  const parsed = epoch.parseEpochManifest(JSON.stringify(manifestFixture(patch)));
  assert.equal(typeof parsed.digest, "string");
  return parsed;
};
const validTransitionManifest = (patch) => {
  const parsed = epoch.parseEpochManifest(JSON.stringify(manifestFixture((m) => {
    m.scope.adapterId = "pool-unpause-watch-v1";
    m.scope.producerAllowlist = ["pool-pause-watch-1", "pool-pause-watch-2"];
    m.scope.firedStatusAllowlist = ["TRIGGER_UNPAUSE"];
    if (patch) patch(m);
  })));
  assert.equal(typeof parsed.digest, "string");
  return parsed;
};
const admit = (manifest, eventText, extra) => {
  return epoch.admitEvent({
    manifest,
    event: typeof eventText === "string" ? eventText : JSON.stringify(eventText),
    consumed: "[]",
    inherited: "[]",
    expectedSourceDigest: hex64("f"),
    nowMs: NOW,
    ...(extra || {})
  });
};
const consumedRecordFixture = (semanticEventId, outcome, patch) => {
  const record = {
    schema: CONSUMED_SCHEMA,
    identitySchemaVersion: IDENTITY_SCHEMA_VERSION,
    semanticEventId,
    outcome: outcome || "SUCCESS",
    provenance: {
      source: "PREDECESSOR_EPOCH",
      epochId: "EP-20261013-a",
      lineageDigest: hex64("e")
    }
  };
  if (patch) patch(record);
  return record;
};
const legacyRecordFixture = (semanticEventId) => ({
  schema: CONSUMED_SCHEMA,
  identitySchemaVersion: IDENTITY_SCHEMA_VERSION,
  semanticEventId,
  outcome: "FAILED",
  provenance: { source: "LEGACY_ARCHIVE", lineageDigest: hex64("d") }
});
const currentRecordFixture = (semanticEventId) => ({
  schema: CONSUMED_SCHEMA,
  identitySchemaVersion: IDENTITY_SCHEMA_VERSION,
  semanticEventId,
  outcome: "SUCCESS",
  provenance: {
    source: "CURRENT_EPOCH",
    epochId: "EP-20261014-a",
    ownerProposalDigest: hex64("a")
  }
});
const assertBlocked = (result, code) => {
  assert.deepEqual(result, { status: "BLOCKED", code, semanticEventId: null, digest: null });
};
const assertValid = (result, expectedId) => {
  assert.deepEqual(result, {
    status: "OFFLINE_VALID", code: "OFFLINE_VALID", semanticEventId: expectedId
  });
};
const buildSuccessorManifest = (records, patch) => validQuoteManifest((m) => {
  m.predecessor.inheritedConsumedCount = records.length;
  m.predecessor.inheritedConsumedDigest = epoch.consumedSetDigest(JSON.stringify(records)).digest;
  if (patch) patch(m);
});
const freshPin = (chainId, blockNumber, hashChar) => ({
  chainId, blockNumber, blockHash: hex64(hashChar), headerTime: iso(-1000)
});

/* --------------------------- module purity guarantees ------------------------- */
test("module imports only crypto and the reused pure canonical parser", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "lib", "trigger-fork-epoch.js"), "utf8");
  const requires = [...source.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(requires.sort(), ["./evm-call-inventory-v2/canonical.js", "node:crypto"].sort());
  for (const forbidden of ["__dirname", "__filename", "spawn", "execSync", "Date.now(",
    "setImmediate", "setInterval", "setTimeout", "child_process", "node:fs", "node:http",
    "node:net", "node:os", "node:dns", "worker_threads"]) {
    assert.ok(!source.includes(forbidden), `module must not contain ${forbidden}`);
  }
});

test("public surface is small and the unchecked hashing seams are gone", () => {
  assert.equal(Object.isFrozen(BLOCKERS), true);
  assert.equal(Object.isFrozen(DESIGN_LIMITS), true);
  assert.equal(Object.isFrozen(epoch.ADAPTER_REGISTRY), true);
  assert.deepEqual(Object.keys(epoch).sort(), ["ADAPTER_REGISTRY", "BLOCKERS", "CONSUMED_SCHEMA",
    "DESIGN_LIMITS", "EVENT_SCHEMA", "IDENTITY_SCHEMA", "IDENTITY_SCHEMA_VERSION",
    "INDEPENDENCE_POLICY_VERSION", "LEGACY_DISPOSITION", "LEGACY_RATIONALE_CODES",
    "LEGACY_SEARCH_POLICY_CODES", "MANIFEST_SCHEMA", "OWNER_POLICY_VERSION", "POLICY_VERSION",
    "UNKNOWN_GAP_POLICY", "admitEvent", "consumedSetDigest", "parseEpochManifest",
    "parseSourceEvent"]);
  /* no generic raw-object digest export and no invented producer roster */
  assert.equal(epoch.canonicalDigest, undefined);
  assert.equal(epoch.APPROVED_PRODUCERS, undefined);
  assert.equal(DESIGN_LIMITS.maxConsumedIdentities, 128);
  assert.equal(DESIGN_LIMITS.epochLifetimeMs, 8 * 60 * 60 * 1000);
  assert.equal(DESIGN_LIMITS.forkBudgetMs, 210000);
  assert.equal(DESIGN_LIMITS.maxInFlight, 1);
});

test("identity known answers match the literal vectors and canonical compositions", () => {
  assert.equal(epoch.parseSourceEvent(JSON.stringify(quoteEventFixture())).semanticEventId,
    KAT_QUOTE_ID);
  assert.equal(epoch.parseSourceEvent(JSON.stringify(transitionEventFixture())).semanticEventId,
    KAT_TRANSITION_ID);
  /* independent canonical-composition vectors (module-independent hashing) */
  assert.equal(sha256Hex(KAT_QUOTE_IDENTITY_CANONICAL), KAT_QUOTE_ID);
  assert.equal(sha256Hex(KAT_TRANSITION_IDENTITY_CANONICAL), KAT_TRANSITION_ID);
});

test("manifest parses to the literal digest and roundtrips through its own JSON", () => {
  const text = JSON.stringify(manifestFixture((m) => {
    m.predecessor.inheritedConsumedCount = 2;
    m.predecessor.inheritedConsumedDigest = KAT_CONSUMED_SET_DIGEST; /* literal, not module-derived */
  }));
  const first = epoch.parseEpochManifest(text);
  assert.equal(first.digest, KAT_MANIFEST_DIGEST);
  const second = epoch.parseEpochManifest(JSON.stringify(first.manifest));
  assert.equal(second.digest, KAT_MANIFEST_DIGEST);
  assert.deepEqual(JSON.stringify(second.manifest), JSON.stringify(first.manifest));
});

test("consumed-set digest matches its literal vector and is reorder-stable", () => {
  const records = [
    consumedRecordFixture(KAT_QUOTE_ID, "SUCCESS"),
    consumedRecordFixture(KAT_TRANSITION_ID, "FAILED")
  ];
  assert.equal(epoch.consumedSetDigest(JSON.stringify(records)).digest, KAT_CONSUMED_SET_DIGEST);
  assert.equal(epoch.consumedSetDigest(JSON.stringify([...records].reverse())).digest,
    KAT_CONSUMED_SET_DIGEST);
  assert.equal(epoch.consumedSetDigest("[]").digest,
    `0x${createHash("sha256").update("[]", "utf8").digest("hex")}`);
});

/* ------------------------------ positive controls ----------------------------- */
test("valid pin-quote event admits offline-valid with the literal known-answer identity", () => {
  assertValid(admit(validQuoteManifest(), quoteEventFixture()), KAT_QUOTE_ID);
});

test("valid state-transition event admits offline-valid with its known-answer identity", () => {
  assertValid(admit(validTransitionManifest(), transitionEventFixture()), KAT_TRANSITION_ID);
});

test("admission is pure: repeated calls are identical and inputs are never mutated", () => {
  const manifest = validQuoteManifest();
  const eventText = JSON.stringify(quoteEventFixture());
  const snapshot = JSON.stringify(manifest.manifest);
  const first = admit(manifest, eventText);
  const second = admit(manifest, eventText);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(manifest.manifest), snapshot);
  assert.equal(Object.isFrozen(manifest.manifest), true);
  assert.equal(Object.isFrozen(manifest.manifest.scope), true);
});

test("multi-entry ordering cannot create another manifest identity (real reversal)", () => {
  const gaps = [
    { gapDigest: hex64("1"), cutoff: iso(-200000), excludedByCutoff: true, excludedByAdapterScope: false },
    { gapDigest: hex64("2"), cutoff: iso(-300000), excludedByCutoff: true, excludedByAdapterScope: false }
  ];
  const parsedA = epoch.parseEpochManifest(JSON.stringify(manifestFixture((m) => {
    m.scope.companionChainIds = [10, 1];
    m.predecessor.gaps = gaps;
  })));
  const parsedB = epoch.parseEpochManifest(JSON.stringify(manifestFixture((m) => {
    m.scope.companionChainIds = [1, 10];
    m.predecessor.gaps = [...gaps].reverse();
  })));
  assert.equal(parsedA.digest, parsedB.digest);
  /* multi-chain reordered companions remain admissible with the same identity */
  const reorderedEvent = quoteEventFixture((v) => {
    v.companions = [freshPin(10, "10", "3"), freshPin(1, "9001", "2")];
  });
  assertValid(admit(parsedA, reorderedEvent), KAT_QUOTE_ID);
});

test("wrapper-only changes never change the identity; epoch change admits the same event", () => {
  const idA = epoch.parseSourceEvent(JSON.stringify(quoteEventFixture())).semanticEventId;
  const wrapperAltered = quoteEventFixture((v) => {
    v.source.digest = hex64("1");
    v.source.observedAt = iso(-1000);
    v.producer.generatedAt = iso(-1500);
    v.observation.at = iso(0);
  });
  assert.equal(epoch.parseSourceEvent(JSON.stringify(wrapperAltered)).semanticEventId, idA);
  const otherEpochManifest = validQuoteManifest((m) => {
    m.epochId = "EP-20261014-b";
    m.ownerBinding.proposalDigest = hex64("9");
    m.predecessor.predecessorEpochId = "EP-20261013-a";
    m.predecessor.ancestry = [{ epochId: "EP-20261013-a", lineageDigest: hex64("e") }];
  });
  const otherEpochEvent = quoteEventFixture((v) => {
    v.epochId = "EP-20261014-b";
    v.ownerProposalDigest = hex64("9");
  });
  assertValid(admit(otherEpochManifest, otherEpochEvent), idA);
});

test("simultaneous semantic changes change the identity; matched controls admit", () => {
  assert.notEqual(epoch.parseSourceEvent(JSON.stringify(quoteEventFixture((v) => {
    v.target.route.direction = "POOL_B_TO_POOL_A";
  }))).semanticEventId, KAT_QUOTE_ID);
  assert.notEqual(epoch.parseSourceEvent(JSON.stringify(quoteEventFixture((v) => {
    v.target.candidate.amountInRaw = "200000000";
  }))).semanticEventId, KAT_QUOTE_ID);
  assert.notEqual(epoch.parseSourceEvent(JSON.stringify(transitionEventFixture((v) => {
    v.target.transition.blockHash = hex64("1");
  }))).semanticEventId, KAT_TRANSITION_ID);
  /* matched positive controls for the patched events */
  expect(quoteEventFixture((v) => { v.target.route.direction = "POOL_B_TO_POOL_A"; }));
  expect(quoteEventFixture((v) => { v.target.candidate.amountInRaw = "200000000"; }));
  function expect(evt) {
    assert.equal(epoch.parseSourceEvent(JSON.stringify(evt)).status, undefined);
  }
});

test("a caller-supplied event id is recompute-checked, typed, never trusted as identity", () => {
  const correct = quoteEventFixture((v) => { v.semanticEventId = KAT_QUOTE_ID; });
  assert.equal(epoch.parseSourceEvent(JSON.stringify(correct)).semanticEventId, KAT_QUOTE_ID);
  assertBlocked(epoch.parseSourceEvent(JSON.stringify(quoteEventFixture((v) => {
    v.semanticEventId = hex64("0");
  }))), BLOCKERS.IDENTITY_RECOMPUTE_MISMATCH);
  assertBlocked(admit(validQuoteManifest(), quoteEventFixture((v) => {
    v.semanticEventId = hex64("0");
  })), BLOCKERS.IDENTITY_RECOMPUTE_MISMATCH);
  /* wrong type is refused outright; no null-as-absent shortcut */
  assertBlocked(epoch.parseSourceEvent(JSON.stringify(quoteEventFixture((v) => {
    v.semanticEventId = 123;
  }))), BLOCKERS.FIELD_TYPE);
  assertBlocked(epoch.parseSourceEvent(JSON.stringify(quoteEventFixture((v) => {
    v.semanticEventId = null;
  }))), BLOCKERS.FIELD_TYPE);
  /* absent recomputes normally */
  assert.equal(epoch.parseSourceEvent(JSON.stringify(quoteEventFixture())).semanticEventId,
    KAT_QUOTE_ID);
});

test("two allowed producers observing the same defined semantic event dedupe", () => {
  const manifest = validTransitionManifest(); /* both producers allowlisted */
  const producerA = transitionEventFixture((v) => {
    v.producerId = "pool-pause-watch-1";
    v.producer = { generatedAt: iso(-2400) };
  });
  const producerB = transitionEventFixture((v) => {
    v.producerId = "pool-pause-watch-2";
    v.source.digest = hex64("e");
    v.producer = { generatedAt: iso(-2300) };
    v.observation.at = iso(-1900);
  });
  const idA = epoch.parseSourceEvent(JSON.stringify(producerA)).semanticEventId;
  const idB = epoch.parseSourceEvent(JSON.stringify(producerB)).semanticEventId;
  assert.equal(idA, idB);
  assertValid(admit(manifest, producerB, { expectedSourceDigest: hex64("e") }), idA);
  /* once consumed under one observation, the other observation is a replay */
  const records = [consumedRecordFixture(idA, "SUCCESS")];
  const successor = validTransitionManifest((m) => {
    m.predecessor.inheritedConsumedCount = 1;
    m.predecessor.inheritedConsumedDigest = epoch.consumedSetDigest(JSON.stringify(records)).digest;
  });
  assertBlocked(admit(successor, producerB, {
    inherited: JSON.stringify(records),
    expectedSourceDigest: hex64("e")
  }), BLOCKERS.REPLAY_CONSUMED);
});

/* --------------------------- bounded strict parsing --------------------------- */
test("raw duplicate serialized keys are rejected before any contract logic", () => {
  assertBlocked(admit(validQuoteManifest(),
    JSON.stringify(quoteEventFixture()).replace(`"schema":"${EVENT_SCHEMA}"`,
      `"schema":"${EVENT_SCHEMA}","producerId":"usdc-usdt-route-watch-1"`)
  ), BLOCKERS.PARSE_BLOCKED);
  assertBlocked(epoch.parseEpochManifest(
    JSON.stringify(manifestFixture()).replace(`"schema":"${MANIFEST_SCHEMA}"`,
      `"schema":"${MANIFEST_SCHEMA}","epochId":"EP-20261014-a"`)
  ), BLOCKERS.PARSE_BLOCKED);
});

test("escaped-key duplicates decode to the same name and are rejected", () => {
  assertBlocked(admit(validQuoteManifest(),
    JSON.stringify(quoteEventFixture()).replace(`"schema":"${EVENT_SCHEMA}"`,
      `"schema":"${EVENT_SCHEMA}","\\u0073chema":"${EVENT_SCHEMA}"`)
  ), BLOCKERS.PARSE_BLOCKED);
});

test("unknown extra fields are rejected at every nested object", () => {
  assertBlocked(epoch.parseEpochManifest(JSON.stringify(manifestFixture((m) => {
    m.bounds.extra = 1;
  }))), BLOCKERS.FIELD_UNKNOWN);
  assertBlocked(epoch.parseEpochManifest(JSON.stringify(manifestFixture((m) => {
    m.overflowing = true;
  }))), BLOCKERS.FIELD_UNKNOWN);
  assertBlocked(epoch.parseEpochManifest(JSON.stringify(manifestFixture((m) => {
    m.legacy.rationale = "free text";
  }))), BLOCKERS.FIELD_UNKNOWN);
  assertBlocked(admit(validQuoteManifest(), quoteEventFixture((v) => {
    v.target.extra = 1;
  })), BLOCKERS.FIELD_UNKNOWN);
  assertBlocked(admit(validQuoteManifest(), quoteEventFixture((v) => {
    v.adapterDigestExtra = 1;
  })), BLOCKERS.FIELD_UNKNOWN);
  assertBlocked(admit(validQuoteManifest(), quoteEventFixture((v) => {
    v.target.routeKey = hex64("9"); /* no opaque caller route hashes exist any more */
  })), BLOCKERS.FIELD_UNKNOWN);
});

test("unsupported schema, version and adapter values reject, including prototype keys", () => {
  assertBlocked(epoch.parseEpochManifest(JSON.stringify(manifestFixture((m) => {
    m.schema = "trigger-fork-epoch-manifest/v2";
  }))), BLOCKERS.SCHEMA_UNSUPPORTED);
  assertBlocked(epoch.parseEpochManifest(JSON.stringify(manifestFixture((m) => {
    m.policyVersion = "trigger-fork-epoch-policy/v2";
  }))), BLOCKERS.SCHEMA_UNSUPPORTED);
  assertBlocked(epoch.parseEpochManifest(JSON.stringify(manifestFixture((m) => {
    m.ownerBinding.policyVersion = "trigger-fork-owner/v2";
  }))), BLOCKERS.SCHEMA_UNSUPPORTED);
  assertBlocked(epoch.parseSourceEvent(JSON.stringify(quoteEventFixture((v) => {
    v.identitySchemaVersion = 2;
  }))), BLOCKERS.SCHEMA_UNSUPPORTED);
  assertBlocked(epoch.parseSourceEvent(JSON.stringify(quoteEventFixture((v) => {
    v.adapterId = "join-exit-route-v1"; /* unsupported variant removed */
  }))), BLOCKERS.ADAPTER_UNSUPPORTED);
  /* registry lookups are own-property based: inherited names cannot bind */
  assertBlocked(epoch.parseSourceEvent(JSON.stringify(quoteEventFixture((v) => {
    v.adapterId = "toString";
  }))), BLOCKERS.ADAPTER_UNSUPPORTED);
  assertBlocked(epoch.parseSourceEvent(JSON.stringify(quoteEventFixture((v) => {
    v.adapterId = "constructor";
  }))), BLOCKERS.ADAPTER_UNSUPPORTED);
});

test("prototype-named keys on an otherwise valid event payload cannot bypass checks", () => {
  const payload = quoteEventFixture();
  const text = JSON.stringify(payload).replace(`"schema":"${EVENT_SCHEMA}"`,
    `"schema":"${EVENT_SCHEMA}","__proto__":{"polluted":true}`);
  const result = admit(validQuoteManifest(), text);
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.code === BLOCKERS.FIELD_UNKNOWN || result.code === BLOCKERS.PARSE_BLOCKED,
    `expected an exact-field rejection, got ${result.code}`);
});

test("unsafe numeric forms never survive the boundary", () => {
  assertBlocked(epoch.parseEpochManifest(JSON.stringify(manifestFixture((m) => {
    m.bounds.maxInFlight = 1.5;
  }))), BLOCKERS.PARSE_BLOCKED);
  assertBlocked(epoch.parseEpochManifest(
    JSON.stringify(manifestFixture()).replace('"maxInFlight":1', '"maxInFlight":1.0E1000')),
    BLOCKERS.PARSE_BLOCKED);
  /* 1e3 is a legal safe integer in the reused parser; the bounds contract rejects it */
  assertBlocked(epoch.parseEpochManifest(
    JSON.stringify(manifestFixture()).replace('"maxInFlight":1', '"maxInFlight":1e3')),
    BLOCKERS.BOUND_EXCEEDS_DESIGN);
  /* compact JSON substitution really changes the input: 8453.5 is not a safe integer */
  const compact = JSON.stringify(quoteEventFixture());
  assert.ok(compact.includes('"chainId":8453,'));
  assertBlocked(epoch.parseSourceEvent(compact.replace('"chainId":8453,', '"chainId":8453.5,')),
    BLOCKERS.PARSE_BLOCKED);
});

test("non-canonical decimal quantities are rejected", () => {
  for (const bad of ["0165", "+165", "1.65", "165.0", "", " ", "0x0A5", "abcd", "-1", "-0"]) {
    assertBlocked(epoch.parseSourceEvent(JSON.stringify(quoteEventFixture((v) => {
      v.primary.blockNumber = bad;
    }))), BLOCKERS.QUANTITY_NONCANONICAL);
  }
  assertBlocked(epoch.parseEpochManifest(JSON.stringify(manifestFixture((m) => {
    m.chains["8453"].floorBlockNumber = "00" + "9";
  }))), BLOCKERS.QUANTITY_NONCANONICAL);
});

test("malformed or ambiguous timestamps are rejected", () => {
  const badStamps = ["2026-10-14T04:00:00+00:00", "2026-10-14T04:00:00.000+00:00",
    "2026-1-14T04:00:00.000Z", "2026-13-14T04:00:00.000Z", "2026-10-14T25:00:00.000Z",
    "2026-10-14T04:00:00Z", "2026-10-14T04:00:00.0000Z"];
  for (const bad of badStamps) {
    assertBlocked(epoch.parseEpochManifest(JSON.stringify(manifestFixture((m) => {
      m.notBefore = bad;
    }))), BLOCKERS.TIMESTAMP_NONCANONICAL);
    assertBlocked(epoch.parseSourceEvent(JSON.stringify(quoteEventFixture((v) => {
      v.observation.at = bad;
    }))), BLOCKERS.TIMESTAMP_NONCANONICAL);
  }
});

test("too-large, too-long, malformed-shape and too-deep inputs fail at the boundary", () => {
  assertBlocked(epoch.parseSourceEvent(JSON.stringify(quoteEventFixture((v) => {
    v.source.observedAt = "Z".repeat(20000);
  }))), BLOCKERS.BOUNDARY_SIZE);
  const deep = '{"schema":"trigger-fork-epoch-event/v1","n":[[[[[[[[[1]]]]]]]]]}';
  assertBlocked(admit(validQuoteManifest(), deep), BLOCKERS.BOUNDARY_DEPTH);
  assertBlocked(epoch.parseEpochManifest(deep), BLOCKERS.BOUNDARY_DEPTH);
  assertBlocked(epoch.parseSourceEvent("not json"), BLOCKERS.PARSE_BLOCKED);
});

test("no free-form text exists anywhere in the legacy bindings", () => {
  assertBlocked(epoch.parseEpochManifest(JSON.stringify(manifestFixture((m) => {
    m.legacy.rationaleCode = "LEGACY_V1_INCOMPLETE; see https://attacker.example/rpc";
  }))), BLOCKERS.VALUE_INVALID);
  assertBlocked(epoch.parseEpochManifest(JSON.stringify(manifestFixture((m) => {
    m.legacy.searchPolicyCode = "MANUAL_RUNS_UNSPECIFIED";
  }))), BLOCKERS.VALUE_INVALID);
  assert.deepEqual(LEGACY_RATIONALE_CODES, ["LEGACY_V1_INCOMPLETE"]);
});

test("error output never echoes synthetic endpoint material from input text", () => {
  const hostile = `{"schema":"${EVENT_SCHEMA}",` +
    '"https://attacker.example/rpc":1,"https://attacker.example/rpc":2}';
  const result = admit(validQuoteManifest(), hostile);
  assert.equal(result.status, "BLOCKED");
  assert.equal(Object.keys(result).join(","), "status,code,semanticEventId,digest");
  assert.ok(!JSON.stringify(result).includes("attacker"));
  assert.ok(!JSON.stringify(result).includes("rpc"));
});

/* ------------------------------ lifecycle windows ----------------------------- */
test("not-yet-active and expired manifests block at the exact boundaries", () => {
  assertBlocked(admit(validQuoteManifest((m) => { m.notBefore = iso(1); }),
    quoteEventFixture(), { nowMs: NOW }), BLOCKERS.NOT_YET_ACTIVE);
  const atCutoffEvent = quoteEventFixture((v) => {
    v.source.observedAt = iso(0);
    v.observation.at = iso(0);
    v.producer.generatedAt = iso(0);
    v.target.candidate.economicsObservedAt = iso(0);
  });
  assertValid(admit(validQuoteManifest((m) => { m.notBefore = iso(0); }), atCutoffEvent,
    { nowMs: NOW }), KAT_QUOTE_ID);
  assertBlocked(admit(validQuoteManifest((m) => { m.expiresAt = iso(-1); }),
    quoteEventFixture(), { nowMs: NOW }), BLOCKERS.EPOCH_EXPIRED);
  assertBlocked(admit(validQuoteManifest((m) => { m.expiresAt = iso(0); }),
    quoteEventFixture(), { nowMs: NOW }), BLOCKERS.EPOCH_EXPIRED);
});

test("remaining work plus cleanup budget must fit inside the epoch lifetime", () => {
  /* expiresAt is NOW+300000; forkBudget+cleanup = 220000ms */
  assertBlocked(admit(validQuoteManifest(), quoteEventFixture(), { nowMs: NOW + 80001 }),
    BLOCKERS.BUDGET_INSUFFICIENT); /* remaining = 219999 */
  assertValid(admit(validQuoteManifest(), quoteEventFixture(), { nowMs: NOW + 80000 }),
    KAT_QUOTE_ID); /* remaining = exactly 220000 */
});

test("epoch lifetime cannot exceed the eight-hour design maximum", () => {
  assertBlocked(epoch.parseEpochManifest(JSON.stringify(manifestFixture((m) => {
    m.expiresAt = new Date(NOW + DESIGN_LIMITS.epochLifetimeMs + 1).toISOString();
  }))), BLOCKERS.LIFETIME_EXCEEDED);
  assert.equal(typeof epoch.parseEpochManifest(JSON.stringify(manifestFixture((m) => {
    m.createdAt = iso(0);
    m.notBefore = iso(0);
    m.expiresAt = new Date(NOW + DESIGN_LIMITS.epochLifetimeMs).toISOString();
  }))).digest, "string");
});

test("manifest bounds may narrow but widening beyond design maxima fails", () => {
  const wide = [
    (m) => { m.bounds.sourceMaxAgeMs = 600001; },
    (m) => { m.bounds.observationMaxAgeMs = 600001; },
    (m) => { m.bounds.floorQualificationMaxAgeMs = 600001; },
    (m) => { m.bounds.futureSkewMs = 60001; },
    (m) => { m.bounds.promotionMaxAgeMs = 120001; },
    (m) => { m.bounds.forkBudgetMs = 210001; },
    (m) => { m.bounds.maxConsumedIdentities = 129; },
    (m) => { m.bounds.maxInFlight = 2; }
  ];
  for (const patch of wide) {
    assertBlocked(epoch.parseEpochManifest(JSON.stringify(manifestFixture(patch))),
      BLOCKERS.BOUND_EXCEEDS_DESIGN);
  }
  assert.equal(typeof epoch.parseEpochManifest(JSON.stringify(manifestFixture((m) => {
    m.bounds.sourceMaxAgeMs = 300000;
    m.bounds.maxConsumedIdentities = 4;
  }))).digest, "string");
});

/* -------- validated-handle protection (probe: forgedInheritedManifestResult) --- */
test("the validated-manifest handle is unforgeable and accessor-free, with valid roundtrip", () => {
  const live = validQuoteManifest();
  let getterCalls = 0;
  const forgedInner = Object.create(live.manifest);
  Object.defineProperty(forgedInner, "expiresAt", {
    get() { getterCalls += 1; return iso(300000); },
    enumerable: true
  });
  /* expired control first: a valid handle for an expired manifest fails the clock */
  const expiredText = JSON.stringify(manifestFixture((m) => { m.expiresAt = iso(-1); }));
  const expiredHandle = epoch.parseEpochManifest(expiredText);
  assertBlocked(admit(expiredHandle, quoteEventFixture()), BLOCKERS.EPOCH_EXPIRED);
  /* copied wrapper with the real inner object: not the registered handle */
  assertBlocked(admit({ manifest: live.manifest, digest: live.digest }, quoteEventFixture()),
    BLOCKERS.PARAM_MANIFEST_UNVALIDATED);
  /* prototype-inherited wrapper */
  assertBlocked(admit(Object.create(live), quoteEventFixture()),
    BLOCKERS.PARAM_MANIFEST_UNVALIDATED);
  /* inherited-lookalike inner manifest with replaced field and the old digest */
  assertBlocked(admit({ manifest: forgedInner, digest: live.digest }, quoteEventFixture()),
    BLOCKERS.PARAM_MANIFEST_UNVALIDATED);
  assert.equal(getterCalls, 0, "no accessor inside a forged handle may be evaluated");
  /* bare inner object */
  assertBlocked(admit(live.manifest, quoteEventFixture()), BLOCKERS.PARAM_MANIFEST_UNVALIDATED);
  /* lookalike plain copy */
  assertBlocked(admit({ manifest: JSON.parse(JSON.stringify(live.manifest)) }, quoteEventFixture()),
    BLOCKERS.PARAM_MANIFEST_UNVALIDATED);
  /* empty wrapper */
  assertBlocked(admit({}, quoteEventFixture()), BLOCKERS.PARAM_MANIFEST_UNVALIDATED);
  /* the genuine handle still admits, and its public JSON revalidates to the same digest */
  assertValid(admit(live, quoteEventFixture()), KAT_QUOTE_ID);
  const roundtripped = epoch.parseEpochManifest(JSON.stringify(live.manifest));
  assert.equal(roundtripped.digest, live.digest);
  assertValid(admit(roundtripped, quoteEventFixture()), KAT_QUOTE_ID);
});

/* --------------------------- binding and mismatch tests ------------------------ */
test("epoch, owner, adapter/scenario digests and expected source digest bind per call", () => {
  assertBlocked(admit(validQuoteManifest(), quoteEventFixture((v) => {
    v.epochId = "EP-20261014-z";
  })), BLOCKERS.EPOCH_MISMATCH);
  assertBlocked(admit(validQuoteManifest(), quoteEventFixture((v) => {
    v.ownerProposalDigest = hex64("0");
  })), BLOCKERS.OWNER_MISMATCH);
  assertBlocked(admit(validQuoteManifest(), quoteEventFixture((v) => {
    v.adapterDigest = hex64("0");
  })), BLOCKERS.ADAPTER_DIGEST_MISMATCH);
  assertBlocked(admit(validQuoteManifest(), quoteEventFixture((v) => {
    v.scenarioDigest = hex64("0");
  })), BLOCKERS.SCENARIO_DIGEST_MISMATCH);
  assertBlocked(admit(validQuoteManifest(), quoteEventFixture(), {
    expectedSourceDigest: hex64("0")
  }), BLOCKERS.SOURCE_DIGEST_MISMATCH);
  /* the per-call binding is independent of any manifest artifact */
  assertValid(admit(validQuoteManifest(), quoteEventFixture((v) => {
    v.source.digest = hex64("e");
  }), { expectedSourceDigest: hex64("e") }), KAT_QUOTE_ID);
  assertBlocked(admit(validQuoteManifest(), quoteEventFixture((v) => {
    v.scenarioId = "SC-OTHER-01";
  })), BLOCKERS.SCENARIO_MISMATCH);
  assertBlocked(epoch.parseEpochManifest(JSON.stringify(manifestFixture((m) => {
    m.scope.firedStatusAllowlist = ["TRIGGER_UNPAUSE"];
  }))), BLOCKERS.STATUS_NOT_IN_ADAPTER);
  assertBlocked(admit(validQuoteManifest(), quoteEventFixture((v) => {
    v.producerId = "unknown-producer";
  })), BLOCKERS.PRODUCER_NOT_ALLOWLISTED);
});

test("producer-generated time is a separate freshness input with cutoff and skew gates", () => {
  assertBlocked(admit(validQuoteManifest(), quoteEventFixture((v) => {
    v.producer.generatedAt = iso(-600001); /* exceeds the 600000ms age bound */
  })), BLOCKERS.PRODUCER_STALE);
  /* the exact age bound is fresh (opening cutoff far enough back) */
  const wide = validQuoteManifest((m) => {
    m.createdAt = iso(-1300000);
    m.notBefore = iso(-1200000);
  });
  assertValid(admit(wide, quoteEventFixture((v) => {
    v.producer.generatedAt = iso(-600000); /* exact bound */
  })), KAT_QUOTE_ID);
  /* a producer time older than both the opening cutoff and the age bound reports the
   * age failure first (stale); the near-window cutoff case isolates the cutoff code */
  assertBlocked(admit(validQuoteManifest(), quoteEventFixture((v) => {
    v.producer.generatedAt = iso(-60001); /* before the near notBefore */
  })), BLOCKERS.PRODUCER_BEFORE_CUTOFF);
  assertBlocked(admit(validQuoteManifest(), quoteEventFixture((v) => {
    v.producer.generatedAt = iso(60001);
  })), BLOCKERS.PRODUCER_FUTURE_SKEW);
  /* source/producer timestamps cannot precede the opening cutoff under fresh ages */
  assertBlocked(admit(validQuoteManifest(), quoteEventFixture((v) => {
    v.source.observedAt = iso(-60001);
  })), BLOCKERS.SOURCE_BEFORE_CUTOFF);
  assertBlocked(admit(wide, quoteEventFixture((v) => {
    v.source.observedAt = iso(-1200001);
  })), BLOCKERS.SOURCE_STALE);
  assertBlocked(admit(validQuoteManifest(), quoteEventFixture((v) => {
    v.source.observedAt = iso(60001);
  })), BLOCKERS.SOURCE_FUTURE_SKEW);
  assertValid(admit(validQuoteManifest(), quoteEventFixture((v) => {
    v.source.observedAt = iso(60000);
    v.producer.generatedAt = iso(60000);
    v.observation.at = iso(60000);
    v.target.candidate.economicsObservedAt = iso(60000);
    v.primary.headerTime = iso(60000);
    for (const companion of v.companions) companion.headerTime = iso(60000);
  })), KAT_QUOTE_ID);
});

test("observation, economics and header freshness fail closed with exact boundaries", () => {
  const wide = validQuoteManifest((m) => {
    m.createdAt = iso(-1300000);
    m.notBefore = iso(-1200000);
  });
  assertBlocked(admit(wide, quoteEventFixture((v) => {
    v.observation.at = iso(-600001);
  })), BLOCKERS.OBSERVATION_STALE);
  assertValid(admit(wide, quoteEventFixture((v) => {
    v.observation.at = iso(-600000);
  })), KAT_QUOTE_ID);
  assertBlocked(admit(validQuoteManifest(), quoteEventFixture((v) => {
    v.observation.at = iso(-60001);
  })), BLOCKERS.OBSERVATION_BEFORE_CUTOFF);
  assertBlocked(admit(validQuoteManifest(), quoteEventFixture((v) => {
    v.target.candidate.economicsObservedAt = iso(-60001);
  })), BLOCKERS.ECONOMICS_BEFORE_CUTOFF);
  assertBlocked(admit(validQuoteManifest(), quoteEventFixture((v) => {
    v.observation.at = iso(60001);
  })), BLOCKERS.OBSERVATION_FUTURE_SKEW);
  assertBlocked(admit(validQuoteManifest((m) => {
    m.chains["8453"].floorHeaderTime = iso(-700000); /* keep floor coherence out of the stale case */
    m.chains["1"].floorHeaderTime = iso(-700000);
    m.chains["10"].floorHeaderTime = iso(-700000);
  }), quoteEventFixture((v) => {
    v.primary.headerTime = iso(-600001);
    v.companions[0].headerTime = iso(-1000);
    v.companions[1].headerTime = iso(-1000);
  })), BLOCKERS.HEADER_STALE);
});

/* ------------------------- pins, floors and transitions ------------------------ */
test("companion set coverage and per-chain floor guards bind every pin", () => {
  assertBlocked(epoch.parseEpochManifest(JSON.stringify(manifestFixture((m) => {
    delete m.chains["1"];
  }))), BLOCKERS.FIELD_MISSING);
  assertBlocked(admit(validQuoteManifest(), quoteEventFixture((v) => {
    v.companions = [freshPin(1, "9001", "2")];
  })), BLOCKERS.COMPANION_CHAIN_MISSING);
  assertBlocked(admit(validQuoteManifest(), quoteEventFixture((v) => {
    v.companions = [freshPin(1, "9001", "2"), freshPin(10, "10", "3"), freshPin(20, "20", "4")];
  })), BLOCKERS.COMPANION_CHAIN_UNEXPECTED);
  assertBlocked(admit(validQuoteManifest(), quoteEventFixture((v) => {
    v.companions = [freshPin(1, "9001", "2"), freshPin(1, "9001", "2")];
  })), BLOCKERS.CHAIN_SCOPE_MISMATCH);
  /* companion floor negatives on the multi-chain set */
  assertBlocked(admit(validQuoteManifest(), quoteEventFixture((v) => {
    v.companions = [freshPin(1, "9000", "2"), freshPin(10, "10", "3")]; /* equality */
  })), BLOCKERS.FLOOR_INEQUALITY);
  assertBlocked(admit(validQuoteManifest(), quoteEventFixture((v) => {
    v.companions = [freshPin(1, "8999", "2"), freshPin(10, "10", "3")]; /* older */
  })), BLOCKERS.PIN_BELOW_FLOOR);
  assertBlocked(admit(validQuoteManifest(), quoteEventFixture((v) => {
    v.companions = [freshPin(1, "9001", "c"), freshPin(10, "10", "3")]; /* floor hash */
  })), BLOCKERS.PIN_CONFLICT);
  assertBlocked(admit(validQuoteManifest(), quoteEventFixture((v) => {
    v.companions = [
      { chainId: 1, blockNumber: "9001", blockHash: hex64("2"), headerTime: iso(-35000) },
      freshPin(10, "10", "3")
    ]; /* below the canonical floor header time */
  })), BLOCKERS.PIN_HEADER_INCONSISTENT);
});

test("primary floor equality, older pins and conflicting pins block; identity pins bind", () => {
  assertBlocked(admit(validQuoteManifest(), quoteEventFixture((v) => {
    v.primary.blockNumber = "162";
    v.target.pin.blockNumber = "162";
  })), BLOCKERS.FLOOR_INEQUALITY);
  assertBlocked(admit(validQuoteManifest(), quoteEventFixture((v) => {
    v.primary.blockNumber = "161";
    v.target.pin.blockNumber = "161";
  })), BLOCKERS.PIN_BELOW_FLOOR);
  assertBlocked(admit(validQuoteManifest(), quoteEventFixture((v) => {
    v.primary.blockHash = hex64("c"); /* the floor hash at a higher height */
    v.target.pin.blockHash = hex64("c");
  })), BLOCKERS.PIN_CONFLICT);
  assertBlocked(epoch.parseSourceEvent(JSON.stringify(quoteEventFixture((v) => {
    v.target.pin.blockHash = hex64("3");
  }))), BLOCKERS.PIN_TARGET_MISMATCH);
});

test("original transition must sit between the floor and the observed pin with coherent data", () => {
  /* the observed head (999999-style) cannot carry the transition */
  assertBlocked(admit(validTransitionManifest(), transitionEventFixture((v) => {
    v.target.transition.blockNumber = "999999";
  })), BLOCKERS.TRANSITION_ABOVE_OBSERVATION);
  /* equal height requires hash agreement */
  assertBlocked(admit(validTransitionManifest(), transitionEventFixture((v) => {
    v.target.transition.blockNumber = "165";
  })), BLOCKERS.TRANSITION_PIN_MISMATCH);
  const sameHeight = transitionEventFixture((v) => {
    v.target.transition.blockNumber = "165";
    v.target.transition.blockHash = hex64("a"); /* the observed pin block itself */
    v.target.transition.headerTime = iso(-1000); /* must equal the observed header */
  });
  assertValid(admit(validTransitionManifest(), sameHeight), KAT_SAME_HEIGHT_TRANSITION_ID);
  /* same block and hash with a different observed header is incoherent data */
  assertBlocked(admit(validTransitionManifest(), transitionEventFixture((v) => {
    v.target.transition.blockNumber = "165";
    v.target.transition.blockHash = hex64("a");
    v.target.transition.headerTime = iso(-2000);
  })), BLOCKERS.TRANSITION_PIN_MISMATCH);
  /* the observed pin hash may not be reused at a different height */
  assertBlocked(admit(validTransitionManifest(), transitionEventFixture((v) => {
    v.target.transition.blockNumber = "163";
    v.target.transition.blockHash = hex64("a");
  })), BLOCKERS.TRANSITION_PIN_MISMATCH);
  /* below the floor */
  assertBlocked(admit(validTransitionManifest(), transitionEventFixture((v) => {
    v.target.transition.blockNumber = "161";
  })), BLOCKERS.PIN_BELOW_FLOOR);
  /* floor-hash appearance at another height */
  assertBlocked(admit(validTransitionManifest(), transitionEventFixture((v) => {
    v.target.transition.blockNumber = "163";
    v.target.transition.blockHash = hex64("c");
  })), BLOCKERS.PIN_CONFLICT);
  /* incoherent original header time */
  assertBlocked(admit(validTransitionManifest(), transitionEventFixture((v) => {
    v.target.transition.headerTime = iso(-31000); /* below the floor header time */
  })), BLOCKERS.PIN_HEADER_INCONSISTENT);
  /* the original transition header carries the same max-age gate as other evidence */
  assertBlocked(admit(validTransitionManifest((m) => {
    m.createdAt = iso(-1300000);
    m.notBefore = iso(-1200000);
    m.chains["8453"].floorHeaderTime = iso(-1100000);
  }), transitionEventFixture((v) => {
    v.target.transition.headerTime = iso(-700000); /* past the observation max-age */
  })), BLOCKERS.TRANSITION_STALE);
  /* the equal-height data boundary wins over header position: at equal height the
   * header timestamp must equal the observed one */
  assertBlocked(admit(validTransitionManifest(), transitionEventFixture((v) => {
    v.target.transition.blockNumber = "165";
    v.target.transition.blockHash = hex64("a");
    v.target.transition.headerTime = iso(0); /* after the observed pin header */
  })), BLOCKERS.TRANSITION_PIN_MISMATCH);
  /* a pre-cutoff transition cannot be refreshed by a new observation; the floor
   * header time is moved back and the cutoff case uses a near window so it
   * isolates its own code ahead of the age gate */
  assertBlocked(admit(validTransitionManifest((m) => {
    m.chains["8453"].floorHeaderTime = iso(-1300000);
  }), transitionEventFixture((v) => {
    v.target.transition.headerTime = iso(-60001); /* strictly before the cutoff */
  })), BLOCKERS.TRANSITION_BEFORE_CUTOFF);
  /* a future transition cannot be refreshed by a new observation: a transition
   * header after the observed pin header is incoherent chain data */
  assertBlocked(admit(validTransitionManifest(), transitionEventFixture((v) => {
    v.target.transition.headerTime = iso(60001);
  })), BLOCKERS.PIN_HEADER_INCONSISTENT);
  /* same original transition reobserved later keeps one identity and admits */
  const laterObservation = transitionEventFixture((v) => {
    v.primary.blockNumber = "170";
    v.primary.blockHash = hex64("7");
    v.primary.headerTime = iso(0);
    v.companions[0].headerTime = iso(0);
    v.companions[1].headerTime = iso(0);
  });
  assertValid(admit(validTransitionManifest(), laterObservation), KAT_TRANSITION_ID);
});

test("narrowed floor-qualification bound blocks stale qualifications; boundaries bind", () => {
  /* default: qualification is 10s old and the default max-age is 600000ms → fresh */
  assertValid(admit(validQuoteManifest(), quoteEventFixture()), KAT_QUOTE_ID);
  /* narrowed bound below the actual age blocks */
  assertBlocked(admit(validQuoteManifest((m) => {
    m.bounds.floorQualificationMaxAgeMs = 5000;
  }), quoteEventFixture()), BLOCKERS.QUALIFICATION_STALE);
  /* older qualification with the default bound blocks */
  assertBlocked(admit(validQuoteManifest((m) => {
    m.chains["8453"].qualifiedAt = iso(-700000);
  }), quoteEventFixture()), BLOCKERS.QUALIFICATION_STALE);
  /* future-skewed qualification beyond the bound */
  assertBlocked(admit(validQuoteManifest((m) => {
    m.chains["8453"].qualifiedAt = iso(60001);
    m.chains["1"].qualifiedAt = iso(60001);
    m.chains["10"].qualifiedAt = iso(60001);
  }), quoteEventFixture()), BLOCKERS.QUALIFICATION_FUTURE_SKEW);
});

/* --------------------------- consumed-identity protection ---------------------- */
test("inherited consumed identities deny replay in a genuinely different successor epoch", () => {
  for (const outcome of ["SUCCESS", "FAILED", "UNCERTAIN", "REJECTED"]) {
    const records = [consumedRecordFixture(KAT_QUOTE_ID, outcome)];
    const successor = buildSuccessorManifest(records);
    assertBlocked(admit(successor, quoteEventFixture(), {
      inherited: JSON.stringify(records)
    }), BLOCKERS.REPLAY_CONSUMED);
  }
});

test("predecessor bindings are explicit and cannot be impersonated", () => {
  /* current epoch cannot impersonate the predecessor */
  const selfRecords = [consumedRecordFixture(KAT_QUOTE_ID, "SUCCESS", (r) => {
    r.provenance = { source: "PREDECESSOR_EPOCH", epochId: "EP-20261014-a", lineageDigest: hex64("e") };
  })];
  const selfManifest = validQuoteManifest((m) => {
    m.predecessor.ancestry = [{ epochId: "EP-20261013-a", lineageDigest: hex64("e") }];
    m.predecessor.inheritedConsumedCount = 1;
    m.predecessor.inheritedConsumedDigest = epoch.consumedSetDigest(JSON.stringify(selfRecords)).digest;
  });
  assertBlocked(admit(selfManifest, quoteEventFixture(), {
    inherited: JSON.stringify(selfRecords)
  }), BLOCKERS.LINEAGE_PROVENANCE_MISMATCH);
  /* arbitrary foreign epoch sharing the lineage digest is not a bound ancestor */
  const foreignRecords = [consumedRecordFixture(KAT_QUOTE_ID, "SUCCESS", (r) => {
    r.provenance = { source: "PREDECESSOR_EPOCH", epochId: "EP-20200101-x", lineageDigest: hex64("e") };
  })];
  const foreignManifest = validQuoteManifest((m) => {
    m.predecessor.inheritedConsumedCount = 1;
    m.predecessor.inheritedConsumedDigest = epoch.consumedSetDigest(JSON.stringify(foreignRecords)).digest;
  });
  assertBlocked(admit(foreignManifest, quoteEventFixture(), {
    inherited: JSON.stringify(foreignRecords)
  }), BLOCKERS.LINEAGE_PROVENANCE_MISMATCH);
  /* new ancestor descriptors may bind older lineage entries explicitly */
  const grandparent = [consumedRecordFixture(hex64("1"), "FAILED", (r) => {
    r.provenance = { source: "PREDECESSOR_EPOCH", epochId: "EP-20261012-a", lineageDigest: hex64("1") };
  })];
  const chainManifest = validQuoteManifest((m) => {
    m.predecessor.predecessorEpochId = "EP-20261013-a";
    m.predecessor.ancestry = [
      { epochId: "EP-20261013-a", lineageDigest: hex64("e") },
      { epochId: "EP-20261012-a", lineageDigest: hex64("1") }
    ];
    m.predecessor.inheritedConsumedCount = 1;
    m.predecessor.inheritedConsumedDigest = epoch.consumedSetDigest(JSON.stringify(grandparent)).digest;
  });
  assert.equal(admit(chainManifest, quoteEventFixture(), {
    inherited: JSON.stringify(grandparent)
  }).status, "OFFLINE_VALID");
  /* manifest cannot bind itself as its own predecessor */
  assertBlocked(epoch.parseEpochManifest(JSON.stringify(manifestFixture((m) => {
    m.predecessor.ancestry = [{ epochId: "EP-20261014-a", lineageDigest: hex64("e") }];
    m.predecessor.predecessorEpochId = "EP-20261013-a";
  }))), BLOCKERS.PREDECESSOR_MISMATCH);
  /* the first ancestry entry must be the immediate predecessor binding */
  assertBlocked(epoch.parseEpochManifest(JSON.stringify(manifestFixture((m) => {
    m.predecessor.ancestry = [
      { epochId: "EP-20261012-a", lineageDigest: hex64("1") },
      { epochId: "EP-20261013-a", lineageDigest: hex64("e") }
    ];
  }))), BLOCKERS.ANCESTRY_INCOHERENT);
  /* duplicated ancestry entries rejected (same epoch bound twice) */
  assertBlocked(epoch.parseEpochManifest(JSON.stringify(manifestFixture((m) => {
    m.predecessor.predecessorEpochId = "EP-20261013-a";
    m.predecessor.ancestry = [
      { epochId: "EP-20261013-a", lineageDigest: hex64("e") },
      { epochId: "EP-20261013-a", lineageDigest: hex64("e") }
    ];
  }))), BLOCKERS.ANCESTRY_INCOHERENT);
  /* the same epoch bound to two different digests is contradictory, not two pairs */
  assertBlocked(epoch.parseEpochManifest(JSON.stringify(manifestFixture((m) => {
    m.predecessor.predecessorEpochId = "EP-20261013-a";
    m.predecessor.ancestry = [
      { epochId: "EP-20261013-a", lineageDigest: hex64("e") },
      { epochId: "EP-20261012-a", lineageDigest: hex64("1") },
      { epochId: "EP-20261012-a", lineageDigest: hex64("2") }
    ];
  }))), BLOCKERS.ANCESTRY_INCOHERENT);
});

test("legacy-archive provenance binds the recorded archive digest", () => {
  const records = [legacyRecordFixture(KAT_QUOTE_ID)];
  const manifest = validQuoteManifest((m) => {
    m.predecessor.inheritedConsumedCount = 1;
    m.predecessor.inheritedConsumedDigest = epoch.consumedSetDigest(JSON.stringify(records)).digest;
  });
  assertBlocked(admit(manifest, quoteEventFixture(), {
    inherited: JSON.stringify(records)
  }), BLOCKERS.REPLAY_CONSUMED);
  const moved = [legacyRecordFixture(KAT_QUOTE_ID)];
  moved[0].provenance.lineageDigest = hex64("0");
  const movedManifest = validQuoteManifest((m) => {
    m.predecessor.inheritedConsumedCount = 1;
    m.predecessor.inheritedConsumedDigest = epoch.consumedSetDigest(JSON.stringify(moved)).digest;
  });
  assertBlocked(admit(movedManifest, quoteEventFixture(), {
    inherited: JSON.stringify(moved)
  }), BLOCKERS.LINEAGE_PROVENANCE_MISMATCH);
});

test("current records bind both the epoch and the owner proposal digest", () => {
  const manifest = validQuoteManifest();
  assertBlocked(admit(manifest, quoteEventFixture(), {
    consumed: JSON.stringify([currentRecordFixture(KAT_QUOTE_ID)])
  }), BLOCKERS.REPLAY_CONSUMED);
  const foreign = [currentRecordFixture(hex64("6"))];
  foreign[0].provenance.ownerProposalDigest = hex64("0");
  assertBlocked(admit(manifest, quoteEventFixture(), {
    consumed: JSON.stringify(foreign)
  }), BLOCKERS.CONSUMED_OWNER_MISMATCH);
  const otherEpoch = [currentRecordFixture(hex64("6"))];
  otherEpoch[0].provenance.epochId = "EP-20261014-b";
  assertBlocked(admit(manifest, quoteEventFixture(), {
    consumed: JSON.stringify(otherEpoch)
  }), BLOCKERS.CONSUMED_EPOCH_MISMATCH);
  /* inherited records have no owner field; current use is an exact-shape error */
  assertBlocked(admit(manifest, quoteEventFixture(), {
    consumed: JSON.stringify([consumedRecordFixture(hex64("6"))])
  }), BLOCKERS.CONSUMED_PROVENANCE_INVALID);
});

test("corrupted inherited digest, count and capacity bindings fail closed", () => {
  const records = [consumedRecordFixture(hex64("7"))];
  const miscounted = validQuoteManifest((m) => {
    m.predecessor.inheritedConsumedCount = 2;
    m.predecessor.inheritedConsumedDigest = epoch.consumedSetDigest(JSON.stringify(records)).digest;
  });
  assertBlocked(admit(miscounted, quoteEventFixture(), { inherited: JSON.stringify(records) }),
    BLOCKERS.INHERITED_COUNT_MISMATCH);
  assertBlocked(admit(miscounted, quoteEventFixture(), { inherited: "[]" }),
    BLOCKERS.INHERITED_SET_MISSING);
  const wrongDigest = validQuoteManifest((m) => {
    m.predecessor.inheritedConsumedCount = 1;
    m.predecessor.inheritedConsumedDigest = epoch.consumedSetDigest(
      JSON.stringify([consumedRecordFixture(hex64("0"))])).digest;
  });
  assertBlocked(admit(wrongDigest, quoteEventFixture(), { inherited: JSON.stringify(records) }),
    BLOCKERS.INHERITED_DIGEST_MISMATCH);
  /* inherited count is enforced against the narrowed manifest capacity at parse */
  assertBlocked(epoch.parseEpochManifest(JSON.stringify(manifestFixture((m) => {
    m.bounds.maxConsumedIdentities = 2;
    m.predecessor.inheritedConsumedCount = 3;
  }))), BLOCKERS.BOUND_EXCEEDS_DESIGN);
});

test("inherited records under another identity-schema version cannot be mapped", () => {
  const unmappable = [{
    schema: CONSUMED_SCHEMA,
    identitySchemaVersion: 2,
    semanticEventId: hex64("7"),
    outcome: "SUCCESS",
    provenance: { source: "PREDECESSOR_EPOCH", epochId: "EP-20261013-a", lineageDigest: hex64("e") }
  }];
  const manifest = validQuoteManifest((m) => {
    m.predecessor.inheritedConsumedCount = 1;
    m.predecessor.inheritedConsumedDigest = sha256HexOrBlocked(unmappable);
  });
  assertBlocked(admit(manifest, quoteEventFixture(), { inherited: JSON.stringify(unmappable) }),
    BLOCKERS.IDENTITY_VERSION_UNSUPPORTED);
});

test("combined deny-set saturation and overflow reject without eviction or override", () => {
  const inheritedA = [consumedRecordFixture(hex64("7"))];
  const narrow = validQuoteManifest((m) => {
    m.bounds.maxConsumedIdentities = 2;
    m.predecessor.inheritedConsumedCount = 1;
    m.predecessor.inheritedConsumedDigest = epoch.consumedSetDigest(JSON.stringify(inheritedA)).digest;
  });
  assertBlocked(admit(narrow, quoteEventFixture(), {
    inherited: JSON.stringify(inheritedA),
    consumed: JSON.stringify([currentRecordFixture(hex64("8"))])
  }), BLOCKERS.DENY_SET_SATURATED);
  /* replay precedence at saturation: manifest bounds the exact two-record set */
  const replaySet = [consumedRecordFixture(KAT_QUOTE_ID), consumedRecordFixture(hex64("8"))];
  const replayNarrow = validQuoteManifest((m) => {
    m.bounds.maxConsumedIdentities = 2;
    m.predecessor.inheritedConsumedCount = 2;
    m.predecessor.inheritedConsumedDigest =
      epoch.consumedSetDigest(JSON.stringify(replaySet)).digest;
  });
  assertBlocked(admit(replayNarrow, quoteEventFixture(), {
    inherited: JSON.stringify(replaySet),
    consumed: "[]"
  }), BLOCKERS.REPLAY_CONSUMED);
  const inheritedB = [consumedRecordFixture(hex64("7")), consumedRecordFixture(hex64("9"))];
  const overflowManifest = validQuoteManifest((m) => {
    m.bounds.maxConsumedIdentities = 2;
    m.predecessor.inheritedConsumedCount = 2;
    m.predecessor.inheritedConsumedDigest = epoch.consumedSetDigest(JSON.stringify(inheritedB)).digest;
  });
  assertBlocked(admit(overflowManifest, quoteEventFixture(), {
    inherited: JSON.stringify(inheritedB),
    consumed: JSON.stringify([currentRecordFixture(hex64("8")), currentRecordFixture(hex64("6"))])
  }), BLOCKERS.DENY_SET_OVERFLOW);
  /* no room remains without any replay; the closing bound is authoritative */
  assertBlocked(admit(overflowManifest, quoteEventFixture(), {
    inherited: JSON.stringify(inheritedB),
    consumed: "[]"
  }), BLOCKERS.DENY_SET_SATURATED);
  /* room left (bound 2, one inherited): the same event admits against a non-replay set */
  assertValid(admit(narrow, quoteEventFixture(), {
    inherited: JSON.stringify(inheritedA),
    consumed: "[]"
  }), KAT_QUOTE_ID);
});

test("malformed consumed records (outcome or provenance) cannot enter the deny-set", () => {
  const oddOutcome = [consumedRecordFixture(hex64("7"), "PENDING")];
  /* digest precomputed by an independent test-only helper over the malformed text */
  const oddManifest = validQuoteManifest((m) => {
    m.predecessor.inheritedConsumedCount = 1;
    m.predecessor.inheritedConsumedDigest = sha256HexOrBlocked(oddOutcome);
  });
  assertBlocked(admit(oddManifest, quoteEventFixture(), { inherited: JSON.stringify(oddOutcome) }),
    BLOCKERS.CONSUMED_OUTCOME_INVALID);
  const oddProvenance = [consumedRecordFixture(hex64("7"), "SUCCESS", (r) => {
    r.provenance = { source: "UNKNOWN_SOURCE", lineageDigest: hex64("e") };
  })];
  const manifest2 = validQuoteManifest((m) => {
    m.predecessor.inheritedConsumedCount = 1;
    m.predecessor.inheritedConsumedDigest = sha256HexOrBlocked(oddProvenance);
  });
  assertBlocked(admit(manifest2, quoteEventFixture(), {
    inherited: JSON.stringify(oddProvenance)
  }), BLOCKERS.CONSUMED_PROVENANCE_INVALID);
  /* mixed inherited origins (PREDECESSOR_EPOCH + LEGACY_ARCHIVE) are now a
   * legitimate preserved lineage; role mixing and duplicates are the negatives */
  assert.equal(epoch.consumedSetDigest(JSON.stringify([
    consumedRecordFixture(hex64("7")),
    legacyRecordFixture(hex64("8"))
  ])).digest.length, 66);
  assertBlocked(epoch.consumedSetDigest(JSON.stringify([
    consumedRecordFixture(hex64("7")),
    currentRecordFixture(hex64("8"))
  ])), BLOCKERS.CONSUMED_PROVENANCE_INVALID);
  assertBlocked(epoch.consumedSetDigest(JSON.stringify([
    consumedRecordFixture(hex64("7")),
    consumedRecordFixture(hex64("7"))
  ])), BLOCKERS.DUPLICATE_CONSUMED);
});

test("bounded consumed-set digest helper validates before hashing with fixed errors", () => {
  assertBlocked(epoch.consumedSetDigest('{ not json'), BLOCKERS.PARSE_BLOCKED);
  assertBlocked(epoch.consumedSetDigest('{}'), BLOCKERS.FIELD_TYPE);
  assertBlocked(epoch.consumedSetDigest(JSON.stringify([
    { schema: CONSUMED_SCHEMA, identitySchemaVersion: 1, semanticEventId: 5,
      outcome: "SUCCESS", provenance: { source: "CURRENT_EPOCH", epochId: "EP-20261014-a",
        ownerProposalDigest: hex64("a") } }
  ])), BLOCKERS.FIELD_TYPE);
  assertBlocked(epoch.consumedSetDigest(JSON.stringify([{ unexpected: true }])),
    BLOCKERS.CONSUMED_SCHEMA_UNSUPPORTED);
  assert.equal(epoch.consumedSetDigest(JSON.stringify([currentRecordFixture(hex64("6"))])).digest.length, 66);
  /* per-record key order cannot change the digest */
  const record = currentRecordFixture(hex64("6"));
  const reorderedKeys = {
    provenance: record.provenance,
    outcome: record.outcome,
    semanticEventId: record.semanticEventId,
    identitySchemaVersion: record.identitySchemaVersion,
    schema: record.schema
  };
  assert.equal(epoch.consumedSetDigest(JSON.stringify([record])).digest,
    epoch.consumedSetDigest(JSON.stringify([reorderedKeys])).digest);
});

/* -------------------------------- gap exclusions ------------------------------- */
test("gap exclusions are concrete: policy, scope waivers and cutoff placement bind", () => {
  assertBlocked(epoch.parseEpochManifest(JSON.stringify(manifestFixture((m) => {
    m.predecessor.unknownGapPolicy = "ALLOW_KNOWN_GAPS";
  }))), BLOCKERS.GAP_POLICY_UNSUPPORTED);
  /* an adapter-scope boolean alone cannot waive a gap in this phase */
  assertBlocked(epoch.parseEpochManifest(JSON.stringify(manifestFixture((m) => {
    m.predecessor.gaps = [{
      gapDigest: hex64("8"), cutoff: iso(-200000),
      excludedByCutoff: false, excludedByAdapterScope: true
    }];
  }))), BLOCKERS.GAP_EXCLUSION_UNSUPPORTED);
  assertBlocked(epoch.parseEpochManifest(JSON.stringify(manifestFixture((m) => {
    m.predecessor.gaps = [{
      gapDigest: hex64("8"), cutoff: iso(-200000),
      excludedByCutoff: false, excludedByAdapterScope: false
    }];
  }))), BLOCKERS.GAP_EXCLUSION_UNSUPPORTED);
  /* a cutoff after the epoch window cannot define a covered region */
  assertBlocked(epoch.parseEpochManifest(JSON.stringify(manifestFixture((m) => {
    m.predecessor.gaps = [{
      gapDigest: hex64("8"), cutoff: iso(-1000),
      excludedByCutoff: true, excludedByAdapterScope: false
    }];
  }))), BLOCKERS.GAP_CUTOFF_INVALID);
  /* valid cutoff exclusions admit; ordering of entries is irrelevant */
  const withGaps = epoch.parseEpochManifest(JSON.stringify(manifestFixture((m) => {
    m.predecessor.gaps = [{
      gapDigest: hex64("8"), cutoff: iso(-200000),
      excludedByCutoff: true, excludedByAdapterScope: false
    }];
  })));
  assertValid(admit(withGaps, quoteEventFixture()), KAT_QUOTE_ID);
  /* an event exactly at (not strictly inside) a covered region overlaps the gap */
  const boundaryManifest = epoch.parseEpochManifest(JSON.stringify(manifestFixture((m) => {
    m.predecessor.gaps = [{
      gapDigest: hex64("8"), cutoff: iso(-60000),
      excludedByCutoff: true, excludedByAdapterScope: false
    }];
  })));
  const boundaryEvent = quoteEventFixture((v) => {
    v.observation.at = iso(-60000);
    v.producer.generatedAt = iso(-55000);
  });
  assertBlocked(admit(boundaryManifest, boundaryEvent), BLOCKERS.GAP_OVERLAP);
  const coveredEvent = quoteEventFixture((v) => {
    v.observation.at = iso(-59999);
  });
  assertValid(admit(boundaryManifest, coveredEvent), KAT_QUOTE_ID);
});

/* ------------------------------- parameter guards ------------------------------ */
test("consumed and inherited inputs must be explicit serialized arrays", () => {
  assertBlocked(epoch.admitEvent({
    manifest: validQuoteManifest(), event: JSON.stringify(quoteEventFixture()),
    inherited: "[]", expectedSourceDigest: hex64("f"), nowMs: NOW
  }), BLOCKERS.PARAM_FIELD_INVALID);
  assertBlocked(epoch.admitEvent({
    manifest: validQuoteManifest(), event: JSON.stringify(quoteEventFixture()),
    consumed: "[]", expectedSourceDigest: hex64("f"), nowMs: NOW
  }), BLOCKERS.PARAM_FIELD_INVALID);
  assertBlocked(epoch.admitEvent({
    manifest: validQuoteManifest(), event: JSON.stringify(quoteEventFixture()),
    consumed: null, inherited: null, expectedSourceDigest: hex64("f"), nowMs: NOW
  }), BLOCKERS.PARAM_FIELD_INVALID);
  assertBlocked(admit(validQuoteManifest(), quoteEventFixture(), {
    expectedSourceDigest: "0xzz"
  }), BLOCKERS.HASH_INVALID);
  assertBlocked(admit(validQuoteManifest(), quoteEventFixture(), { extra: true }),
    BLOCKERS.PARAM_FIELD_INVALID);
  assertBlocked(admit(validQuoteManifest(), quoteEventFixture(), { nowMs: 1.5 }),
    BLOCKERS.CLOCK_INVALID);
  assertBlocked(admit(validQuoteManifest(), quoteEventFixture(), { nowMs: "NOW" }),
    BLOCKERS.CLOCK_INVALID);
  assertBlocked(admit({}, quoteEventFixture()), BLOCKERS.PARAM_MANIFEST_UNVALIDATED);
  assertBlocked(admit({ manifest: manifestFixture() }, quoteEventFixture()),
    BLOCKERS.PARAM_MANIFEST_UNVALIDATED);
});

/* ------------------------------- closure pass regressions --------------------- */
test("admission options must be plain frozen-shape data properties; accessors never run", () => {
  /* clock getter: not executed, not read */
  let clockReads = 0;
  const clockOptions = {
    manifest: validQuoteManifest(),
    event: JSON.stringify(quoteEventFixture()),
    consumed: "[]",
    inherited: "[]",
    expectedSourceDigest: hex64("f")
  };
  Object.defineProperty(clockOptions, "nowMs", {
    enumerable: true,
    get() { clockReads += 1; return NOW; }
  });
  assertBlocked(epoch.admitEvent(clockOptions), BLOCKERS.PARAM_FIELD_INVALID);
  assert.equal(clockReads, 0);
  /* manifest getter: never executes */
  let manifestReads = 0;
  const manifestGetterOptions = {
    event: JSON.stringify(quoteEventFixture()),
    consumed: "[]",
    inherited: "[]",
    expectedSourceDigest: hex64("f"),
    nowMs: NOW
  };
  Object.defineProperty(manifestGetterOptions, "manifest", {
    enumerable: true,
    get() { manifestReads += 1; return validQuoteManifest((m) => { m.expiresAt = iso(-1); }); }
  });
  assertBlocked(epoch.admitEvent(manifestGetterOptions), BLOCKERS.PARAM_FIELD_INVALID);
  assert.equal(manifestReads, 0);
  /* event getter and nonenumerable/symbol extras are refused without value reads */
  const eventGetter = {
    manifest: validQuoteManifest(),
    consumed: "[]",
    inherited: "[]",
    expectedSourceDigest: hex64("f"),
    nowMs: NOW
  };
  Object.defineProperty(eventGetter, "event", { enumerable: true, get() { return "{}"; } });
  assertBlocked(epoch.admitEvent(eventGetter), BLOCKERS.PARAM_FIELD_INVALID);
  assertBlocked(admit(validQuoteManifest(), quoteEventFixture(), { hidden: true }),
    BLOCKERS.PARAM_FIELD_INVALID);
  /* a genuine handle with plain data options and an expired window still fails the clock */
  assertBlocked(admit(validQuoteManifest((m) => { m.expiresAt = iso(-1); }),
    quoteEventFixture()), BLOCKERS.EPOCH_EXPIRED);
});

test("exported policy code arrays are frozen so mutation cannot widen allowed codes", () => {
  assert.equal(Object.isFrozen(epoch.LEGACY_RATIONALE_CODES), true);
  assert.equal(Object.isFrozen(epoch.LEGACY_SEARCH_POLICY_CODES), true);
  assert.throws(() => { epoch.LEGACY_RATIONALE_CODES.push("UNAPPROVED_SYNTHETIC_CODE"); }, TypeError);
  assert.throws(() => { epoch.LEGACY_SEARCH_POLICY_CODES.push("UNAPPROVED_SYNTHETIC_CODE"); }, TypeError);
  assert.deepEqual(epoch.LEGACY_RATIONALE_CODES, ["LEGACY_V1_INCOMPLETE"]);
  assertBlocked(epoch.parseEpochManifest(JSON.stringify(manifestFixture((m) => {
    m.legacy.rationaleCode = "UNAPPROVED_SYNTHETIC_CODE";
  }))), BLOCKERS.VALUE_INVALID);
});

test("nonempty gap manifests roundtrip; the strict after-gap rule binds every event time", () => {
  const twoGaps = [
    { gapDigest: hex64("8"), cutoff: iso(-200000), excludedByCutoff: true, excludedByAdapterScope: false },
    { gapDigest: hex64("5"), cutoff: iso(-60000), excludedByCutoff: true, excludedByAdapterScope: false }
  ];
  const handle = validQuoteManifest((m) => { m.predecessor.gaps = twoGaps; });
  const roundtrip = epoch.parseEpochManifest(JSON.stringify(handle.manifest));
  assert.equal(typeof roundtrip.digest, "string");
  assert.equal(roundtrip.digest, handle.digest);
  const roundtripTwo = epoch.parseEpochManifest(JSON.stringify(roundtrip.manifest));
  assert.equal(roundtripTwo.digest, handle.digest);
  /* roundtripped gap manifests carry the input schema and still admit */
  assertValid(admit(roundtripTwo, quoteEventFixture()), KAT_QUOTE_ID);
  /* observation equality with the notBefore-equal gap cutoff overlaps the gap */
  assertBlocked(admit(handle, quoteEventFixture((v) => {
    v.observation.at = iso(-60000);
    v.producer.generatedAt = iso(-2500);
  })), BLOCKERS.GAP_OVERLAP);
  /* +1ms is strictly inside both cutoffs' covered regions */
  assertValid(admit(handle, quoteEventFixture((v) => {
    v.observation.at = iso(-59999);
    v.producer.generatedAt = iso(-2500);
  })), KAT_QUOTE_ID);
});

test("strict after-gap equality covers source, economics and header times at cutoff=notBefore", () => {
  const boundaryManifest = validQuoteManifest((m) => {
    m.predecessor.gaps = [{
      gapDigest: hex64("8"), cutoff: iso(-60000),
      excludedByCutoff: true, excludedByAdapterScope: false
    }];
  });
  /* equality on the source envelope time overlaps the gap */
  assertBlocked(admit(boundaryManifest, quoteEventFixture((v) => {
    v.source.observedAt = iso(-60000);
  })), BLOCKERS.GAP_OVERLAP);
  /* equality on the economic observation time overlaps the gap */
  assertBlocked(admit(boundaryManifest, quoteEventFixture((v) => {
    v.target.candidate.economicsObservedAt = iso(-60000);
  })), BLOCKERS.GAP_OVERLAP);
  /* header equality is overridden by floor coherence unless the floor moves back */
  const backFloor = validQuoteManifest((m) => {
    m.chains["8453"].floorHeaderTime = iso(-700000);
    m.chains["1"].floorHeaderTime = iso(-700000);
    m.chains["10"].floorHeaderTime = iso(-700000);
    m.predecessor.gaps = [{
      gapDigest: hex64("8"), cutoff: iso(-60000),
      excludedByCutoff: true, excludedByAdapterScope: false
    }];
  });
  assertBlocked(admit(backFloor, quoteEventFixture((v) => {
    v.primary.headerTime = iso(-60000);
    v.target.pin = { blockNumber: "165", blockHash: hex64("a") };
  })), BLOCKERS.GAP_OVERLAP);
  /* +1ms on every checked time is strictly inside the covered region */
  assertValid(admit(backFloor, quoteEventFixture((v) => {
    v.primary.headerTime = iso(-59999);
    v.target.pin = { blockNumber: "165", blockHash: hex64("a") };
  })), KAT_QUOTE_ID);
  /* without a gap, ordinary notBefore equality keeps the documented inclusive rule */
  assertBlocked(admit(validQuoteManifest(), quoteEventFixture((v) => {
    v.observation.at = iso(-60001);
  })), BLOCKERS.OBSERVATION_BEFORE_CUTOFF);
  assertValid(admit(validQuoteManifest((m) => { m.notBefore = iso(0); }),
    quoteEventFixture((v) => {
      v.source.observedAt = iso(0);
      v.observation.at = iso(0);
      v.producer.generatedAt = iso(0);
      v.target.candidate.economicsObservedAt = iso(0);
    }), { nowMs: NOW }), KAT_QUOTE_ID);
});

test("the legacy-only root variant admits only correctly bound archive history", () => {
  /* positive root control: recorded unknown-gap cutoff, zero inherited, one new event */
  const root = validQuoteManifest((m) => {
    m.predecessor.predecessorEpochId = null;
    m.predecessor.ancestry = [];
    m.predecessor.lineageDigest = m.legacy.archiveDigest;
    m.predecessor.gaps = [{
      gapDigest: hex64("8"), cutoff: iso(-200000),
      excludedByCutoff: true, excludedByAdapterScope: false
    }];
  });
  assertValid(admit(root, quoteEventFixture()), KAT_QUOTE_ID);
  /* a correctly bound inherited legacy record is consumed as history */
  const legacyHistory = [legacyRecordFixture(KAT_QUOTE_ID)];
  const rootWithHistory = validQuoteManifest((m) => {
    m.predecessor.predecessorEpochId = null;
    m.predecessor.ancestry = [];
    m.predecessor.lineageDigest = m.legacy.archiveDigest;
    m.predecessor.inheritedConsumedCount = 1;
    m.predecessor.inheritedConsumedDigest =
      epoch.consumedSetDigest(JSON.stringify(legacyHistory)).digest;
  });
  assertBlocked(admit(rootWithHistory, quoteEventFixture(), {
    inherited: JSON.stringify(legacyHistory)
  }), BLOCKERS.REPLAY_CONSUMED);
  /* mismatched root lineage digest is refused */
  assertBlocked(epoch.parseEpochManifest(JSON.stringify(manifestFixture((m) => {
    m.predecessor.predecessorEpochId = null;
    m.predecessor.ancestry = [];
    m.predecessor.lineageDigest = hex64("0");
  }))), BLOCKERS.ANCESTRY_INCOHERENT);
  /* a root cannot carry predecessor descriptors */
  assertBlocked(epoch.parseEpochManifest(JSON.stringify(manifestFixture((m) => {
    m.predecessor.predecessorEpochId = null;
    m.predecessor.ancestry = [{ epochId: "EP-20261013-a", lineageDigest: hex64("e") }];
    m.predecessor.lineageDigest = m.legacy.archiveDigest;
  }))), BLOCKERS.ANCESTRY_INCOHERENT);
  /* a fake predecessor (record bound to a nameless root) has no ancestry to match */
  const fakeRecords = [consumedRecordFixture(hex64("9"))];
  const fakeRoot = validQuoteManifest((m) => {
    m.predecessor.predecessorEpochId = null;
    m.predecessor.ancestry = [];
    m.predecessor.lineageDigest = m.legacy.archiveDigest;
    m.predecessor.inheritedConsumedCount = 1;
    m.predecessor.inheritedConsumedDigest =
      epoch.consumedSetDigest(JSON.stringify(fakeRecords)).digest;
  });
  assertBlocked(admit(fakeRoot, quoteEventFixture(), {
    inherited: JSON.stringify(fakeRecords)
  }), BLOCKERS.LINEAGE_PROVENANCE_MISMATCH);
  /* current records cannot masquerade as inherited root history either: the root
   * binds this (all-current-shaped) inherited array, then admission refuses it */
  const impersonating = [currentRecordFixture(hex64("9"))];
  const impersonatingRoot = validQuoteManifest((m) => {
    m.predecessor.predecessorEpochId = null;
    m.predecessor.ancestry = [];
    m.predecessor.lineageDigest = m.legacy.archiveDigest;
    m.predecessor.inheritedConsumedCount = 1;
    m.predecessor.inheritedConsumedDigest =
      epoch.consumedSetDigest(JSON.stringify(impersonating)).digest;
  });
  assertBlocked(admit(impersonatingRoot, quoteEventFixture(), {
    inherited: JSON.stringify(impersonating)
  }), BLOCKERS.CONSUMED_PROVENANCE_INVALID);
});

test("pool order is canonical: distinct ascending addresses; aliases cannot re-identify", () => {
  /* the existing ascending fixture/KAT stays valid */
  assertValid(admit(validQuoteManifest(), quoteEventFixture()), KAT_QUOTE_ID);
  /* swapping pools and flipping direction preserves the real ordered route: rejected */
  const alias = quoteEventFixture((v) => {
    const oldPool = v.target.route.poolA;
    v.target.route.poolA = v.target.route.poolB;
    v.target.route.poolB = oldPool;
    v.target.route.direction = "POOL_B_TO_POOL_A";
  });
  assertBlocked(admit(validQuoteManifest(), alias), BLOCKERS.ROUTE_FIELD_INVALID);
  assert.equal(epoch.parseSourceEvent(JSON.stringify(alias)).status, "BLOCKED");
  /* equal pool addresses are not a two-pool route */
  assertBlocked(epoch.parseSourceEvent(JSON.stringify(quoteEventFixture((v) => {
    v.target.route.poolB = v.target.route.poolA;
  }))), BLOCKERS.ROUTE_FIELD_INVALID);
});

test("adapter ids and lineage entries are typed and uniquely bound", () => {
  /* array ids must not coerce into registry keys */
  assertBlocked(epoch.parseEpochManifest(JSON.stringify(manifestFixture((m) => {
    m.scope.adapterId = ["cross-venue-route-v1"];
  }))), BLOCKERS.ADAPTER_UNSUPPORTED);
  assertBlocked(epoch.parseSourceEvent(JSON.stringify(quoteEventFixture((v) => {
    v.adapterId = ["cross-venue-route-v1"];
  }))), BLOCKERS.ADAPTER_UNSUPPORTED);
});

test("the derived route key matches its literal vector and is order-stable", () => {
  const parsed = epoch.parseSourceEvent(JSON.stringify(quoteEventFixture()));
  assert.equal(parsed.event.routeKey, KAT_ROUTE_KEY);
  /* key order in the serialized route fields cannot create another route key */
  const reordered = quoteEventFixture((v) => {
    v.target.route = {
      direction: v.target.route.direction,
      tokenOut: v.target.route.tokenOut,
      poolB: v.target.route.poolB,
      poolA: v.target.route.poolA,
      tokenIn: v.target.route.tokenIn
    };
  });
  assert.equal(epoch.parseSourceEvent(JSON.stringify(reordered)).event.routeKey, KAT_ROUTE_KEY);
  /* reordering companions/wrapper fields likewise leaves the key untouched */
  const shuffled = quoteEventFixture((v) => {
    v.companions = [freshPin(10, "10", "3"), freshPin(1, "9001", "2")];
  });
  assert.equal(epoch.parseSourceEvent(JSON.stringify(shuffled)).event.routeKey, KAT_ROUTE_KEY);
});

test("the derived route key is chain- and route-sensitive; non-route targets are null", () => {
  /* changing a concrete route field changes the derived key */
  const changedToken = epoch.parseSourceEvent(JSON.stringify(quoteEventFixture((v) => {
    v.target.route.tokenOut = addr("9");
  })));
  assert.notEqual(changedToken.event.routeKey, KAT_ROUTE_KEY);
  assert.equal(typeof changedToken.event.routeKey, "string");
  /* chain sensitivity, verified against the independent literal compositions */
  assert.equal(sha256Hex(`{"chainId":8453,"route":{"direction":"POOL_A_TO_POOL_B",` +
    `"poolA":"${addr("6")}","poolB":"${addr("7")}","tokenIn":"${addr("4")}",` +
    `"tokenOut":"${addr("5")}"},"schema":"trigger-fork-epoch-route/v1"}`), KAT_ROUTE_KEY);
  assert.equal(sha256Hex(`{"chainId":10,"route":{"direction":"POOL_A_TO_POOL_B",` +
    `"poolA":"${addr("6")}","poolB":"${addr("7")}","tokenIn":"${addr("4")}",` +
    `"tokenOut":"${addr("5")}"},"schema":"trigger-fork-epoch-route/v1"}`),
    KAT_ROUTE_KEY_CHAIN_10);
  assert.notEqual(KAT_ROUTE_KEY, KAT_ROUTE_KEY_CHAIN_10);
  /* a reviewed non-route adapter carries the explicit null, not a derived hash */
  assert.equal(epoch.parseSourceEvent(JSON.stringify(transitionEventFixture())).event.routeKey,
    null);
  /* the route key is not a serialized input field and no caller override exists */
  assertBlocked(admit(validQuoteManifest(), quoteEventFixture((v) => {
    v.routeKey = KAT_ROUTE_KEY; /* unknown input field */
  })), BLOCKERS.FIELD_UNKNOWN);
  /* semantic identity stays bound to the route object; the key is derived output */
  assert.equal(epoch.parseSourceEvent(JSON.stringify(quoteEventFixture())).semanticEventId,
    KAT_QUOTE_ID);
});

/* ------------------------- supporting test-only helpers ------------------------ */
function sha256HexOrBlocked(records) {
  /* Test-only independent composition replicating the documented per-record set
   * digest for INVALID record payloads (admission must reject before digesting). */
  const perRecord = records.map((record) => `0x${createHash("sha256")
    .update(JSON.stringify(record), "utf8").digest("hex")}`);
  perRecord.sort();
  return `0x${createHash("sha256").update(`[${perRecord.map((r) => JSON.stringify(r)).join(",")}]`, "utf8")
    .digest("hex")}`;
}
