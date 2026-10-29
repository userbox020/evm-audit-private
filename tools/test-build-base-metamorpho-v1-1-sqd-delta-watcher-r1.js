"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const watcher = require("./build-base-metamorpho-v1-1-sqd-delta-watcher-r1");

const reviewed = watcher.REVIEWED_FIXTURE_AUTHORITY;

function event(candidate = "candidate_vault_alpha", blockNumber = "102", transactionIndex = 0, eventIndex = 0) {
  return {
    blockNumber,
    transactionIndex,
    eventIndex,
    headerCommitment: `header_${blockNumber}`,
    candidateCommitment: candidate,
    decodingProof: {
      exact: true,
      eventName: "CreateMetaMorpho",
      version: "V1.1",
      fieldsComplete: true,
      topicLayoutExact: true,
      decoderBindingCommitment: reviewed.decoderBindingCommitment,
      eventBindingCommitment: reviewed.eventBindingCommitment,
      decodedCandidateCommitment: candidate
    },
    originProof: {
      factoryOnly: true,
      exactEmitter: true,
      factoryBindingCommitment: reviewed.factoryBindingCommitment
    },
    statusProof: {
      success: true,
      receiptBound: true,
      transactionCommitment: `transaction_${blockNumber}_${transactionIndex}`
    }
  };
}

function continuationProof(pageCommitment, requestedCursorCommitment, returnedCursorCommitment, hasNextPage, proofCommitment) {
  return {
    exact: true,
    complete: true,
    queryFilterCommitment: reviewed.queryFilterCommitment,
    priorCheckpointCommitment: reviewed.priorCheckpointCommitment,
    cursorChainCommitment: reviewed.cursorChainCommitment,
    pageCommitment,
    requestedCursorCommitment,
    returnedCursorCommitment,
    hasNextPage,
    exhausted: !hasNextPage,
    proofCommitment
  };
}

function fixture(events = [event()]) {
  const observers = [
    {
      classCommitment: reviewed.observerClassCommitments[0],
      observationCommitment: "observer_observation_alpha",
      reviewed: true,
      independent: true,
      finalized: true,
      canonical: true,
      exactPageAgreement: true,
      exhaustivePageSet: true,
      rangeCommitment: "immutable_range_commitment_r1",
      pageSetCommitment: "page_set_commitment_r1",
      terminalHeaderCommitment: "header_103",
      queryFilterCommitment: reviewed.queryFilterCommitment,
      priorCheckpointCommitment: reviewed.priorCheckpointCommitment,
      initialCursorCommitment: reviewed.initialCursorCommitment,
      cursorChainCommitment: reviewed.cursorChainCommitment,
      terminalExhaustionCommitment: reviewed.terminalExhaustionCommitment
    },
    {
      classCommitment: reviewed.observerClassCommitments[1],
      observationCommitment: "observer_observation_beta",
      reviewed: true,
      independent: true,
      finalized: true,
      canonical: true,
      exactPageAgreement: true,
      exhaustivePageSet: true,
      rangeCommitment: "immutable_range_commitment_r1",
      pageSetCommitment: "page_set_commitment_r1",
      terminalHeaderCommitment: "header_103",
      queryFilterCommitment: reviewed.queryFilterCommitment,
      priorCheckpointCommitment: reviewed.priorCheckpointCommitment,
      initialCursorCommitment: reviewed.initialCursorCommitment,
      cursorChainCommitment: reviewed.cursorChainCommitment,
      terminalExhaustionCommitment: reviewed.terminalExhaustionCommitment
    }
  ];
  return {
    authority: {
      chainId: watcher.CHAIN_ID,
      protocol: "METAMORPHO",
      version: "V1.1",
      mode: "OFFLINE_REVIEWED_FIXTURE_ONLY",
      fixtureOnly: true,
      realCapture: false,
      captureEnabled: false,
      sourcePin: watcher.OFFICIAL_SOURCE_PIN,
      factoryBindingCommitment: reviewed.factoryBindingCommitment,
      decoderBindingCommitment: reviewed.decoderBindingCommitment,
      eventBindingCommitment: reviewed.eventBindingCommitment,
      queryFilterCommitment: reviewed.queryFilterCommitment,
      cursorChainCommitment: reviewed.cursorChainCommitment,
      range: {
        immutable: true,
        finalized: true,
        startBlock: "101",
        endBlock: "103",
        previousLastHeaderNumber: "100",
        previousLastHeaderCommitment: "header_100",
        rangeCommitment: "immutable_range_commitment_r1"
      },
      priorCheckpoint: {
        exact: true,
        previousWatcherStateCommitment: reviewed.previousWatcherStateCommitment,
        checkpointCommitment: reviewed.priorCheckpointCommitment,
        lastHeaderNumber: "100",
        lastHeaderCommitment: "header_100",
        initialCursorCommitment: reviewed.initialCursorCommitment
      },
      pageSetCommitment: "page_set_commitment_r1",
      terminalExhaustion: {
        exact: true,
        exhausted: true,
        noNextPage: true,
        queryFilterCommitment: reviewed.queryFilterCommitment,
        priorCheckpointCommitment: reviewed.priorCheckpointCommitment,
        initialCursorCommitment: reviewed.initialCursorCommitment,
        cursorChainCommitment: reviewed.cursorChainCommitment,
        pageSetCommitment: "page_set_commitment_r1",
        returnedCursorCommitment: null,
        proofCommitment: reviewed.terminalExhaustionCommitment
      },
      observers,
      terminalRecheck: {
        complete: true,
        finalized: true,
        canonical: true,
        exact: true,
        blockNumber: "103",
        headerCommitment: "header_103",
        rangeCommitment: "immutable_range_commitment_r1",
        pageSetCommitment: "page_set_commitment_r1",
        queryFilterCommitment: reviewed.queryFilterCommitment,
        priorCheckpointCommitment: reviewed.priorCheckpointCommitment,
        cursorChainCommitment: reviewed.cursorChainCommitment,
        terminalExhaustionCommitment: reviewed.terminalExhaustionCommitment,
        observerCommitments: observers.map((item) => item.observationCommitment)
      }
    },
    pageState: {
      format: "CHRONOLOGICAL_NDJSON_PAGE_SUMMARIES",
      pageCount: 2,
      complete: true,
      firstPageCommitment: "page_commitment_1",
      lastPageCommitment: "page_commitment_2",
      pageSetCommitment: "page_set_commitment_r1",
      queryFilterCommitment: reviewed.queryFilterCommitment,
      priorCheckpointCommitment: reviewed.priorCheckpointCommitment,
      initialCursorCommitment: reviewed.initialCursorCommitment,
      cursorChainCommitment: reviewed.cursorChainCommitment,
      terminalExhaustionCommitment: reviewed.terminalExhaustionCommitment
    },
    pages: [
      {
        ordinal: 1,
        format: "NDJSON_PAGE_SUMMARY",
        pageCommitment: "page_commitment_1",
        previousPageCommitment: null,
        complete: true,
        chronological: true,
        boundary: {
          startBlock: "101",
          endBlock: "102",
          previousHeaderCommitment: "header_100",
          terminalHeaderCommitment: "header_102"
        },
        continuationProof: continuationProof(
          "page_commitment_1",
          reviewed.initialCursorCommitment,
          "returned_cursor_page_1",
          true,
          "page_continuation_proof_1"
        ),
        headers: [
          { number: "101", headerCommitment: "header_101", parentHeaderCommitment: "header_100", canonical: true, finalized: true },
          { number: "102", headerCommitment: "header_102", parentHeaderCommitment: "header_101", canonical: true, finalized: true }
        ],
        events: events.filter((item) => BigInt(item.blockNumber) <= 102n)
      },
      {
        ordinal: 2,
        format: "NDJSON_PAGE_SUMMARY",
        pageCommitment: "page_commitment_2",
        previousPageCommitment: "page_commitment_1",
        complete: true,
        chronological: true,
        boundary: {
          startBlock: "103",
          endBlock: "103",
          previousHeaderCommitment: "header_102",
          terminalHeaderCommitment: "header_103"
        },
        continuationProof: continuationProof(
          "page_commitment_2",
          "returned_cursor_page_1",
          null,
          false,
          reviewed.terminalExhaustionCommitment
        ),
        headers: [
          { number: "103", headerCommitment: "header_103", parentHeaderCommitment: "header_102", canonical: true, finalized: true }
        ],
        events: events.filter((item) => BigInt(item.blockNumber) === 103n)
      }
    ]
  };
}

function run(mutate = () => {}, events) {
  const input = fixture(events);
  mutate(input);
  return watcher.buildDeltaWatcher(input);
}

test("no events holds with safe indexed-subset continuation", () => {
  const result = watcher.buildDeltaWatcher(fixture([]));
  assert.deepEqual(result, watcher.buildDeltaWatcher(fixture([])));
  assert.equal(result.status, "HOLD_NO_NEW_VAULT");
  assert.equal(result.count, 0);
  assert.equal(result.safeContinuation, true);
  assert.equal(result.coverage, watcher.COVERAGE);
  assert.equal(watcher.validateResult(result), true);
});

test("valid reviewed fixture discovers only an aggregate candidate count", () => {
  const result = run();
  assert.equal(result.status, "READY_FOR_BOUND_VAULT_STATE_READ");
  assert.equal(result.count, 1);
  assert.equal(result.safeContinuation, true);
  assert.deepEqual(result.gates, { profit: false, execution: false, signed: false });
  assert.deepEqual(Object.keys(result).sort(), ["count", "coverage", "derivedHash", "gates", "safeContinuation", "status"]);
});

test("exact candidate cap passes and hostile over-cap rejects before recursive access", () => {
  const maximum = Array.from({ length: watcher.MAX_CANDIDATES }, (_, index) => event(`candidate_${String(index).padStart(2, "0")}`, "102", index, 0));
  const accepted = watcher.buildDeltaWatcher(fixture(maximum));
  assert.equal(accepted.status, "READY_FOR_BOUND_VAULT_STATE_READ");
  assert.equal(accepted.count, watcher.MAX_CANDIDATES);

  let reached = false;
  const hostile = {};
  Object.defineProperty(hostile, "nested", { enumerable: true, get() { reached = true; throw new Error("unreachable"); } });
  const over = fixture([]);
  over.pages[0].events = Array.from({ length: watcher.MAX_CANDIDATES + 1 }, () => ({}));
  over.pages[0].events[0] = hostile;
  const rejected = watcher.buildDeltaWatcher(over);
  assert.equal(rejected.status, "REJECT");
  assert.equal(reached, false);
});

test("input byte cap and page count cap run before deep sanitizer", () => {
  let reached = false;
  const hostilePage = {};
  Object.defineProperty(hostilePage, "events", { enumerable: true, get() { reached = true; throw new Error("unreachable"); } });
  const tooManyPages = fixture([]);
  tooManyPages.pages = Array.from({ length: watcher.MAX_PAGES + 1 }, () => ({}));
  tooManyPages.pages[0] = hostilePage;
  assert.equal(watcher.buildDeltaWatcher(tooManyPages).status, "REJECT");
  assert.equal(reached, false);

  const tooLarge = fixture([]);
  tooLarge.padding = "x".repeat(watcher.MAX_INPUT_BYTES);
  assert.equal(watcher.buildDeltaWatcher(tooLarge).status, "REJECT");
});

test("page and candidate caps reject hostile proxies before member traps", () => {
  let traps = 0;
  const hostile = new Proxy({}, {
    get() { traps += 1; throw new Error("get trap"); },
    getOwnPropertyDescriptor() { traps += 1; throw new Error("descriptor trap"); },
    getPrototypeOf() { traps += 1; throw new Error("prototype trap"); },
    ownKeys() { traps += 1; throw new Error("keys trap"); }
  });
  const tooManyPages = fixture([]);
  tooManyPages.pages = Array.from({ length: watcher.MAX_PAGES + 1 }, () => ({}));
  tooManyPages.pages[0] = hostile;
  assert.doesNotThrow(() => watcher.buildDeltaWatcher(tooManyPages));
  assert.equal(watcher.buildDeltaWatcher(tooManyPages).status, "REJECT");
  assert.equal(traps, 0);

  const tooManyCandidates = fixture([]);
  tooManyCandidates.pages[0].events = Array.from({ length: watcher.MAX_CANDIDATES + 1 }, () => ({}));
  tooManyCandidates.pages[0].events[0] = hostile;
  assert.doesNotThrow(() => watcher.buildDeltaWatcher(tooManyCandidates));
  assert.equal(watcher.buildDeltaWatcher(tooManyCandidates).status, "REJECT");
  assert.equal(traps, 0);
});

test("proxies, revoked proxies, accessors, and non-plain objects close without invoking user code", () => {
  let traps = 0;
  const hostile = new Proxy({}, {
    get() { traps += 1; throw new Error("get trap"); },
    getOwnPropertyDescriptor() { traps += 1; throw new Error("descriptor trap"); },
    getPrototypeOf() { traps += 1; throw new Error("prototype trap"); },
    ownKeys() { traps += 1; throw new Error("keys trap"); }
  });
  const inputs = [hostile];
  const pageProxy = fixture([]);
  pageProxy.pages[0] = hostile;
  inputs.push(pageProxy);
  const candidateProxy = fixture([]);
  candidateProxy.pages[0].events = [hostile];
  inputs.push(candidateProxy);
  const arrayProxy = fixture([]);
  arrayProxy.pages = new Proxy([], {
    get() { traps += 1; throw new Error("array get trap"); },
    ownKeys() { traps += 1; throw new Error("array keys trap"); }
  });
  inputs.push(arrayProxy);
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  inputs.push(revoked.proxy);
  for (const input of inputs) {
    assert.doesNotThrow(() => watcher.buildDeltaWatcher(input));
    assert.equal(watcher.buildDeltaWatcher(input).status, "REJECT");
  }
  assert.equal(traps, 0);

  let getters = 0;
  const topAccessor = fixture([]);
  Object.defineProperty(topAccessor, "pages", { enumerable: true, get() { getters += 1; throw new Error("getter"); } });
  const nestedAccessor = fixture([]);
  Object.defineProperty(nestedAccessor.pages[0].events[0] || (nestedAccessor.pages[0].events[0] = {}), "x", {
    enumerable: true,
    get() { getters += 1; throw new Error("nested getter"); }
  });
  for (const input of [topAccessor, nestedAccessor]) {
    assert.doesNotThrow(() => watcher.buildDeltaWatcher(input));
    assert.equal(watcher.buildDeltaWatcher(input).status, "REJECT");
  }
  assert.equal(getters, 0);

  const nonPlain = fixture([]);
  nonPlain.authority = new Date(0);
  assert.doesNotThrow(() => watcher.buildDeltaWatcher(nonPlain));
  assert.equal(watcher.buildDeltaWatcher(nonPlain).status, "REJECT");
});

test("bounded accounting closes cyclic, deep, sparse, and unsupported values without throwing", () => {
  const cyclic = fixture([]);
  cyclic.extra = cyclic;
  const deep = fixture([]);
  let cursor = {};
  deep.extra = cursor;
  for (let index = 0; index < watcher.MAX_INPUT_DEPTH + 2; index += 1) {
    cursor.next = {};
    cursor = cursor.next;
  }
  const sparse = fixture([]);
  sparse.pages[0].events = new Array(1);
  const unsupported = fixture([]);
  unsupported.extra = 1n;
  for (const input of [cyclic, deep, sparse, unsupported]) {
    assert.doesNotThrow(() => watcher.buildDeltaWatcher(input));
    const result = watcher.buildDeltaWatcher(input);
    assert.equal(result.status, "REJECT");
    assert.equal(result.safeContinuation, false);
    assert.deepEqual(result.gates, { profit: false, execution: false, signed: false });
  }
});

test("chain, source pin, factory binding, event binding, and protocol errors reject", () => {
  const mutations = [
    (value) => { value.authority.chainId = 1; },
    (value) => { value.authority.sourcePin = "0000000000000000000000000000000000000000"; },
    (value) => { value.authority.factoryBindingCommitment = "wrong_factory_binding"; },
    (value) => { value.authority.decoderBindingCommitment = "wrong_decoder_binding"; },
    (value) => { value.authority.eventBindingCommitment = "wrong_event_binding"; },
    (value) => { value.authority.version = "V1"; },
    (value) => { value.pages[0].events[0].decodingProof.eventName = "OtherEvent"; },
    (value) => { value.pages[0].events[0].decodingProof.version = "V1"; }
  ];
  for (const mutate of mutations) assert.equal(run(mutate).status, "REJECT");
});

test("factory-only origin, successful status, and exact decoder proofs are mandatory", () => {
  const mutations = [
    (value) => { value.pages[0].events[0].originProof.factoryOnly = false; },
    (value) => { value.pages[0].events[0].originProof.exactEmitter = false; },
    (value) => { value.pages[0].events[0].originProof.factoryBindingCommitment = "wrong_factory_binding"; },
    (value) => { value.pages[0].events[0].statusProof.success = false; },
    (value) => { value.pages[0].events[0].statusProof.receiptBound = false; },
    (value) => { value.pages[0].events[0].decodingProof.exact = false; },
    (value) => { value.pages[0].events[0].decodingProof.fieldsComplete = false; },
    (value) => { value.pages[0].events[0].decodingProof.topicLayoutExact = false; },
    (value) => { value.pages[0].events[0].decodingProof.decoderBindingCommitment = "wrong_decoder"; },
    (value) => { value.pages[0].events[0].decodingProof.decodedCandidateCommitment = "different_candidate"; }
  ];
  for (const mutate of mutations) assert.equal(run(mutate).status, "REJECT");
  assert.equal(run((value) => { delete value.pages[0].events[0].decodingProof; }).status, "INCOMPLETE");
});

test("continuation and immutable finalized range failures fail closed", () => {
  const mutations = [
    (value) => { value.authority.range.immutable = false; },
    (value) => { value.authority.range.finalized = false; },
    (value) => { value.authority.range.startBlock = "100"; },
    (value) => { value.authority.range.previousLastHeaderNumber = "99"; },
    (value) => { delete value.authority.range.previousLastHeaderNumber; }
  ];
  for (const mutate of mutations.slice(0, 4)) assert.equal(run(mutate).status, "REJECT");
  assert.equal(run(mutations[4]).status, "INCOMPLETE");
});

test("reviewed SQD query and prior watcher checkpoint bindings are exact", () => {
  const rejected = [
    (value) => { value.authority.queryFilterCommitment = "wrong_query_filter"; },
    (value) => { value.authority.priorCheckpoint.previousWatcherStateCommitment = "wrong_previous_state"; },
    (value) => { value.authority.priorCheckpoint.checkpointCommitment = "wrong_checkpoint"; },
    (value) => { value.authority.priorCheckpoint.lastHeaderNumber = "99"; },
    (value) => { value.authority.priorCheckpoint.lastHeaderCommitment = "wrong_header"; },
    (value) => { value.pageState.queryFilterCommitment = "wrong_query_filter"; },
    (value) => { value.pageState.priorCheckpointCommitment = "wrong_checkpoint"; },
    (value) => { value.pages[0].continuationProof.queryFilterCommitment = "wrong_query_filter"; },
    (value) => { value.pages[0].continuationProof.priorCheckpointCommitment = "wrong_checkpoint"; },
    (value) => { value.authority.observers[0].queryFilterCommitment = "wrong_query_filter"; },
    (value) => { value.authority.observers[0].priorCheckpointCommitment = "wrong_checkpoint"; }
  ];
  for (const mutate of rejected) assert.equal(run(mutate).status, "REJECT");
  const missing = [
    (value) => { delete value.authority.queryFilterCommitment; },
    (value) => { delete value.authority.priorCheckpoint; },
    (value) => { delete value.authority.priorCheckpoint.previousWatcherStateCommitment; }
  ];
  for (const mutate of missing) assert.equal(run(mutate).status, "INCOMPLETE");
});

test("initial and per-page requested/returned cursor chain is exact", () => {
  const rejected = [
    (value) => { value.authority.cursorChainCommitment = "wrong_cursor_chain"; },
    (value) => { value.authority.priorCheckpoint.initialCursorCommitment = "wrong_initial_cursor"; },
    (value) => { value.pageState.initialCursorCommitment = "wrong_initial_cursor"; },
    (value) => { value.pageState.cursorChainCommitment = "wrong_cursor_chain"; },
    (value) => { value.authority.observers[0].initialCursorCommitment = "wrong_initial_cursor"; },
    (value) => { value.authority.observers[0].cursorChainCommitment = "wrong_cursor_chain"; },
    (value) => { value.pages[0].continuationProof.cursorChainCommitment = "wrong_cursor_chain"; },
    (value) => { value.pages[0].continuationProof.requestedCursorCommitment = "wrong_initial_cursor"; },
    (value) => { value.pages[0].continuationProof.returnedCursorCommitment = "wrong_returned_cursor"; },
    (value) => { value.pages[1].continuationProof.requestedCursorCommitment = "wrong_returned_cursor"; },
    (value) => { value.pages[0].continuationProof.returnedCursorCommitment = reviewed.initialCursorCommitment; }
  ];
  for (const mutate of rejected) assert.equal(run(mutate).status, "REJECT");
  assert.equal(run((value) => { delete value.pages[0].continuationProof.requestedCursorCommitment; }).status, "INCOMPLETE");
  assert.equal(run((value) => { delete value.pages[0].continuationProof; }).status, "INCOMPLETE");
});

test("truncated or omitted continuation never permits HOLD or safe continuation", () => {
  const truncated = [
    (value) => { value.pages.pop(); },
    (value) => {
      value.pages[1].continuationProof.hasNextPage = true;
      value.pages[1].continuationProof.exhausted = false;
      value.pages[1].continuationProof.returnedCursorCommitment = "unconsumed_cursor";
    },
    (value) => { value.pages[1].continuationProof.complete = false; },
    (value) => { delete value.pages[1].continuationProof.returnedCursorCommitment; }
  ];
  for (const mutate of truncated) {
    const result = run(mutate, []);
    assert.equal(result.status, "INCOMPLETE");
    assert.equal(result.safeContinuation, false);
    assert.notEqual(result.status, "HOLD_NO_NEW_VAULT");
  }
  assert.equal(run((value) => {
    value.pages[0].continuationProof.hasNextPage = false;
    value.pages[0].continuationProof.exhausted = true;
    value.pages[0].continuationProof.returnedCursorCommitment = null;
  }).status, "REJECT");
});

test("terminal exhaustion and no-next-page proof bind authority, pages, terminal, and both observers", () => {
  const incomplete = [
    (value) => { delete value.authority.terminalExhaustion; },
    (value) => { value.authority.terminalExhaustion.exhausted = false; },
    (value) => { value.authority.terminalExhaustion.noNextPage = false; },
    (value) => { value.authority.terminalExhaustion.returnedCursorCommitment = "unexpected_cursor"; },
    (value) => { value.authority.observers[0].exhaustivePageSet = false; },
    (value) => { delete value.authority.observers[1].terminalExhaustionCommitment; }
  ];
  for (const mutate of incomplete) assert.equal(run(mutate, []).status, "INCOMPLETE");
  const rejected = [
    (value) => { value.authority.terminalExhaustion.proofCommitment = "wrong_exhaustion_proof"; },
    (value) => { value.authority.terminalExhaustion.queryFilterCommitment = "wrong_query_filter"; },
    (value) => { value.authority.terminalExhaustion.priorCheckpointCommitment = "wrong_checkpoint"; },
    (value) => { value.authority.observers[0].terminalExhaustionCommitment = "wrong_exhaustion_proof"; },
    (value) => { value.pageState.terminalExhaustionCommitment = "wrong_exhaustion_proof"; },
    (value) => { value.authority.terminalRecheck.terminalExhaustionCommitment = "wrong_exhaustion_proof"; },
    (value) => { value.pages[1].continuationProof.proofCommitment = "wrong_exhaustion_proof"; }
  ];
  for (const mutate of rejected) assert.equal(run(mutate).status, "REJECT");
});

test("every NDJSON page and boundary continuity failure fails closed", () => {
  const rejected = [
    (value) => { value.pageState.format = "JSON_ARRAY"; },
    (value) => { value.pageState.pageCount = 1; },
    (value) => { value.pageState.firstPageCommitment = "different_page"; },
    (value) => { value.pages[0].ordinal = 2; },
    (value) => { value.pages[0].chronological = false; },
    (value) => { value.pages[1].previousPageCommitment = "different_page"; },
    (value) => { value.pages[1].boundary.startBlock = "102"; },
    (value) => { value.pages[1].boundary.previousHeaderCommitment = "different_header"; },
    (value) => { value.pages[0].boundary.terminalHeaderCommitment = "different_header"; },
    (value) => { value.pages[0].headers.pop(); }
  ];
  for (const mutate of rejected) assert.equal(run(mutate).status, "REJECT");
  assert.equal(run((value) => { delete value.pageState; }).status, "INCOMPLETE");
  assert.equal(run((value) => { delete value.pages[0].boundary; }).status, "INCOMPLETE");
  assert.equal(run((value) => { value.pages[0].complete = false; }).status, "INCOMPLETE");
});

test("canonical header continuity and event-to-header binding are exact", () => {
  const mutations = [
    (value) => { value.pages[0].headers[0].canonical = false; },
    (value) => { value.pages[0].headers[0].finalized = false; },
    (value) => { value.pages[0].headers[1].number = "103"; },
    (value) => { value.pages[0].headers[1].parentHeaderCommitment = "different_header"; },
    (value) => { value.pages[0].events[0].headerCommitment = "different_header"; },
    (value) => { value.pages[0].events[0].blockNumber = "101"; }
  ];
  for (const mutate of mutations) assert.equal(run(mutate).status, "REJECT");
  assert.equal(run((value) => { delete value.pages[0].headers[0].canonical; }).status, "INCOMPLETE");
});

test("terminal canonical finalized recheck binds range, pages, header, and observers", () => {
  const mutations = [
    (value) => { value.authority.terminalRecheck.finalized = false; },
    (value) => { value.authority.terminalRecheck.canonical = false; },
    (value) => { value.authority.terminalRecheck.exact = false; },
    (value) => { value.authority.terminalRecheck.blockNumber = "102"; },
    (value) => { value.authority.terminalRecheck.headerCommitment = "different_header"; },
    (value) => { value.authority.terminalRecheck.rangeCommitment = "different_range"; },
    (value) => { value.authority.terminalRecheck.pageSetCommitment = "different_pages"; },
    (value) => { value.authority.terminalRecheck.observerCommitments.pop(); }
  ];
  for (const mutate of mutations) assert.equal(run(mutate).status, "REJECT");
  assert.equal(run((value) => { value.authority.terminalRecheck.complete = false; }).status, "INCOMPLETE");
  assert.equal(run((value) => { delete value.authority.terminalRecheck; }).status, "INCOMPLETE");
});

test("exactly two distinct independent reviewed fixture observer classes are required", () => {
  const mutations = [
    (value) => { value.authority.observers.pop(); },
    (value) => { value.authority.observers[1].classCommitment = value.authority.observers[0].classCommitment; },
    (value) => { value.authority.observers[1].observationCommitment = value.authority.observers[0].observationCommitment; },
    (value) => { value.authority.observers[1].classCommitment = "unreviewed_observer_class"; },
    (value) => { value.authority.observers[0].reviewed = false; },
    (value) => { value.authority.observers[0].independent = false; },
    (value) => { value.authority.observers[0].finalized = false; },
    (value) => { value.authority.observers[0].canonical = false; },
    (value) => { value.authority.observers[0].exactPageAgreement = false; },
    (value) => { value.authority.observers[0].pageSetCommitment = "different_pages"; },
    (value) => { value.authority.observers[0].terminalHeaderCommitment = "different_header"; }
  ];
  for (const mutate of mutations) assert.equal(run(mutate).status, "REJECT");
  assert.equal(run((value) => { delete value.authority.observers; }).status, "INCOMPLETE");
});

test("duplicate candidates, duplicate positions, and nonchronological events reject", () => {
  const duplicateCandidate = [event("candidate_same", "102", 0, 0), event("candidate_same", "102", 1, 0)];
  assert.equal(watcher.buildDeltaWatcher(fixture(duplicateCandidate)).status, "REJECT");
  const duplicatePosition = [event("candidate_one", "102", 0, 0), event("candidate_two", "102", 0, 0)];
  assert.equal(watcher.buildDeltaWatcher(fixture(duplicatePosition)).status, "REJECT");
  const reversed = [event("candidate_one", "102", 1, 0), event("candidate_two", "102", 0, 0)];
  assert.equal(watcher.buildDeltaWatcher(fixture(reversed)).status, "REJECT");
  assert.equal(run((value) => {
    value.pages[1].pageCommitment = value.pages[0].pageCommitment;
    value.pageState.lastPageCommitment = value.pages[0].pageCommitment;
  }).status, "REJECT");
  assert.equal(run((value) => {
    value.pages[1].headers[0].headerCommitment = value.pages[0].headers[1].headerCommitment;
    value.pages[1].boundary.terminalHeaderCommitment = value.pages[0].headers[1].headerCommitment;
    value.authority.observers.forEach((item) => { item.terminalHeaderCommitment = value.pages[0].headers[1].headerCommitment; });
    value.authority.terminalRecheck.headerCommitment = value.pages[0].headers[1].headerCommitment;
  }).status, "REJECT");
});

test("sanitizer rejects addresses, hashes, provider data, paths, raw payloads, and transport material", () => {
  const forbidden = [
    { address: "opaque" },
    { transactionHash: "opaque" },
    { blockHash: "opaque" },
    { provider: "opaque" },
    { endpoint: "opaque" },
    { sourcePath: "opaque" },
    { rawPayload: "opaque" },
    { safe: `0x${"11".repeat(20)}` },
    { safe: "https://example.invalid" }
  ];
  for (const item of forbidden) assert.throws(() => watcher.assertSanitized(item), watcher.WatcherError);
});

test("output privacy excludes all injected identifiers, numbers, and semantic commitments", () => {
  const input = fixture([event("semantic_candidate_never_emit", "102", 0, 0)]);
  input.authority.range.rangeCommitment = "semantic_range_never_emit";
  input.authority.observers.forEach((item) => { item.rangeCommitment = "semantic_range_never_emit"; });
  input.authority.terminalRecheck.rangeCommitment = "semantic_range_never_emit";
  const result = watcher.buildDeltaWatcher(input);
  assert.equal(result.status, "READY_FOR_BOUND_VAULT_STATE_READ");
  const text = JSON.stringify(result);
  for (const marker of [
    "semantic_candidate_never_emit", "semantic_range_never_emit", "header_", "page_commitment",
    "observer_observation", "transaction_", "returned_cursor", watcher.OFFICIAL_SOURCE_PIN,
    reviewed.factoryBindingCommitment, reviewed.queryFilterCommitment, reviewed.previousWatcherStateCommitment,
    reviewed.priorCheckpointCommitment, reviewed.initialCursorCommitment, reviewed.cursorChainCommitment,
    reviewed.terminalExhaustionCommitment
  ]) assert.equal(text.includes(marker), false);
  assert.equal(/block|address|provider|endpoint|sourcePath|rawPayload|transactionHash|eventHash/iu.test(text), false);
});

test("missing continuity, page, observer, or decoding authority is INCOMPLETE with no continuation", () => {
  const mutations = [
    (value) => { delete value.pages; },
    (value) => { delete value.pageState.complete; },
    (value) => { delete value.pages[1].previousPageCommitment; },
    (value) => { delete value.authority.observers[0].exactPageAgreement; },
    (value) => { delete value.authority.decoderBindingCommitment; },
    (value) => { delete value.pages[0].events[0].decodingProof.fieldsComplete; }
  ];
  for (const mutate of mutations) {
    const result = run(mutate);
    assert.equal(result.status, "INCOMPLETE");
    assert.equal(result.coverage, watcher.INCOMPLETE_COVERAGE);
    assert.equal(result.safeContinuation, false);
    assert.equal(result.count, 0);
  }
});

test("fixture authority cannot claim real capture or enable capture", () => {
  const mutations = [
    (value) => { value.authority.mode = "REAL_CAPTURE"; },
    (value) => { value.authority.fixtureOnly = false; },
    (value) => { value.authority.realCapture = true; },
    (value) => { value.authority.captureEnabled = true; }
  ];
  for (const mutate of mutations) assert.equal(run(mutate).status, "REJECT");
});
