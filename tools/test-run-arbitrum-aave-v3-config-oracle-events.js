#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const {
  EVENT_NAMES,
  LIMITS,
  PINS,
  STATUS_COMPLETE,
  STATUS_INCOMPLETE,
  STATUS_SURVIVOR,
  ScannerError,
  parseInventoryText,
  readAuthority,
  runScanner,
  validateOutput
} = require("./run-arbitrum-aave-v3-config-oracle-events");

const FINALIZED = 10000n;
const FINAL_HASH = `0x${"11".repeat(32)}`;
const PARENT_HASH = `0x${"22".repeat(32)}`;
const STATE_ROOT = `0x${"33".repeat(32)}`;
const TX_HASH = `0x${"44".repeat(32)}`;
const CHANGED_HASH = `0x${"55".repeat(32)}`;
const ASSET = "0x00000000000000000000000000000000000000a1";
const INVENTORY = [
  "Arbitrum One https://node-a.test/rpc/one [public]",
  "Arbitrum https://node-b.test/rpc/two [keyless]"
].join("\n");

function classify(value) {
  return { operatorFamily: new URL(value).pathname.endsWith("/two") ? "family-b" : "family-a", capabilityRank: 1 };
}
function block(number, overrides = {}) {
  const current = BigInt(number);
  return {
    number: `0x${current.toString(16)}`,
    hash: overrides.hash || (current === FINALIZED ? FINAL_HASH : `0x${current.toString(16).padStart(64, "0")}`),
    parentHash: overrides.parentHash || PARENT_HASH,
    stateRoot: overrides.stateRoot || STATE_ROOT,
    timestamp: overrides.timestamp || "0x66"
  };
}
function eventLog(authority, options = {}) {
  const event = authority.events.find((row) => row.name === (options.name || "ReserveBorrowing"));
  let values;
  if (event.name === "ReserveBorrowing") values = [ASSET, options.enabled ?? true];
  else if (event.name === "AssetSourceUpdated") values = [ASSET, "0x00000000000000000000000000000000000000b2"];
  else throw new Error("unsupported fixture event");
  const encoded = event.iface.encodeEventLog(event.fragment, values);
  const row = {
    address: options.emitter || authority.emitters[event.group],
    blockNumber: `0x${BigInt(options.blockNumber ?? FINALIZED).toString(16)}`,
    blockHash: block(options.blockNumber ?? FINALIZED).hash,
    transactionHash: TX_HASH,
    transactionIndex: "0x1",
    logIndex: options.logIndex || "0x2",
    removed: false,
    topics: [...encoded.topics],
    data: encoded.data
  };
  if (options.wrongTopic) row.topics[0] = `0x${"99".repeat(32)}`;
  if (options.wrongData) row.data = "0x01";
  if (options.malformed) delete row.removed;
  return row;
}
function fixture(authority, options = {}) {
  const exactReads = new Map(), logReads = new Map(), calls = [], finalized = BigInt(options.finalized ?? FINALIZED);
  const transport = async ({ candidate, envelope }) => {
    calls.push({ method: envelope.method, family: candidate.family, ordinal: candidate.ordinal });
    if (options.secretFailure && envelope.method === "eth_getBlockByNumber") throw new Error("https://private.test/key=SUPER_SECRET_CREDENTIAL");
    let result;
    if (envelope.method === "eth_chainId") result = options.wrongChainOrdinals?.has(candidate.ordinal) ? "0x1" : "0xa4b1";
    else if (envelope.method === "eth_getBlockByNumber") {
      const tag = envelope.params[0];
      if (tag === "finalized") result = block(finalized);
      else {
        const number = BigInt(tag), key = `${candidate.family}:${number}`, count = (exactReads.get(key) || 0) + 1; exactReads.set(key, count);
        if (options.terminalReorg && number === finalized && count >= 2) result = block(number, { hash: CHANGED_HASH });
        else result = block(number);
      }
    } else if (envelope.method === "eth_getLogs") {
      const priorLogReads = logReads.get(candidate.family) || 0; logReads.set(candidate.family, priorLogReads + 1);
      const qualificationProbe = priorLogReads === 0;
      if (qualificationProbe || options.zeroEvents) result = [];
      else if (options.eventCap) result = Array.from({ length: LIMITS.events + 1 }, (_, index) => eventLog(authority, { blockNumber: finalized, logIndex: `0x${(index + 1).toString(16)}` }));
      else if (options.wrongEmitter) result = [eventLog(authority, { blockNumber: finalized, emitter: "0x0000000000000000000000000000000000000001" })];
      else if (options.wrongTopic) result = [eventLog(authority, { blockNumber: finalized, wrongTopic: true })];
      else if (options.wrongData) result = [eventLog(authority, { blockNumber: finalized, wrongData: true })];
      else if (options.malformed) result = [eventLog(authority, { blockNumber: finalized, malformed: true })];
      else result = [eventLog(authority, { blockNumber: finalized, enabled: !(options.familyDisagreement && candidate.family === "family-b") })];
    } else throw new Error("unexpected method");
    const value = { jsonrpc: "2.0", id: envelope.id, result };
    return { value, bytes: Buffer.byteLength(JSON.stringify(value)) };
  };
  return { calls, transport };
}
async function execute(authority, fixtureOptions = {}, runOptions = {}) {
  const current = fixture(authority, fixtureOptions);
  const output = await runScanner({
    authorityAdapter: () => authority,
    inventoryText: INVENTORY,
    inventoryIdentity: "fixture",
    assertInventoryUnchangedFn: () => {},
    operatorClassifier: classify,
    transport: current.transport,
    priorArtifact: null,
    now: () => Date.UTC(2026, 8, 2, 12, 0, 0),
    ...runOptions
  });
  return { calls: current.calls, output };
}
function assertIncomplete(result, code) {
  assert.equal(result.output.status, STATUS_INCOMPLETE);
  assert.equal(result.output.outcome, "INCOMPLETE");
  assert.equal(result.output.code, code);
  assert.equal(Object.hasOwn(result.output, "events"), false);
  assert.equal(Object.hasOwn(result.output, "eventCount"), false);
  assert.deepEqual(result.output.blockRange, { fromBlock: null, toBlock: null });
  assert.equal(validateOutput(result.output), true);
}

async function main() {
  const authority = readAuthority();
  assert.equal(authority.sourceRevision, "cff15de6d1271b0c800fc001f4aea4c263e8a597");
  assert.equal(authority.addressBookRevision, "6a0ac5a5e548d764488a2f95f26714ff9275de48");
  assert.equal(authority.eventCount, 21);
  assert.deepEqual(authority.eventNames, EVENT_NAMES);
  assert.equal(new Set(authority.events.map((row) => row.topic)).size, 21);
  assert.equal(authority.events.find((row) => row.name === "ReserveBorrowing").signature, "ReserveBorrowing(address,bool)");
  assert.equal(authority.events.find((row) => row.name === "EModeCategoryAdded").signature, "EModeCategoryAdded(uint8,uint256,uint256,uint256,address,string)");
  assert.equal(authority.events.find((row) => row.name === "ReserveInterestRateDataChanged").signature, "ReserveInterestRateDataChanged(address,address,bytes)");
  assert.throws(() => readAuthority({ readFile(file) { const bytes = fs.readFileSync(file); return file === PINS.oracle.file ? Buffer.concat([bytes, Buffer.from("x")]) : bytes; } }), (error) => error instanceof ScannerError && error.code === "AUTHORITY_INVALID");

  const candidates = parseInventoryText(`${INVENTORY}\nArbitrum https://blocked.test/rpc/three [custom headers required]`, classify);
  assert.equal(candidates.length, 2);
  assert.equal(new Set(candidates.map((row) => row.family)).size, 2);

  const zero = await execute(authority, { zeroEvents: true });
  assert.equal(zero.output.status, STATUS_COMPLETE, JSON.stringify(zero.output));
  assert.equal(zero.output.schema, "aave-v3-arbitrum-config-oracle-events/v2");
  assert.equal(zero.output.generatedAt, "2026-09-02T12:00:00.000Z");
  assert.equal(zero.output.outcome, "COMPLETE_ZERO_EVENTS");
  assert.equal(zero.output.eventCount, 0);
  assert.deepEqual(zero.output.events, []);
  assert.equal(Object.values(zero.output.categoryCounts).reduce((sum, count) => sum + count, 0), 0);
  assert.deepEqual(zero.output.blockRange, { fromBlock: "1809", toBlock: "10000" });
  assert.deepEqual(zero.output.lastCompleteCursor, zero.output.blockRange);
  assert.deepEqual(zero.output.continuation, { mode: "FIRST_WINDOW", previousToBlock: null, nextFromBlock: "10001", cursorAdvanced: true, backlogRemaining: false, blocksScanned: 8192 });
  assert.equal(zero.output.qualification.selectedFamilyCount, 2);
  assert(zero.output.reads.count <= LIMITS.calls);
  assert.equal(zero.output.reads.retries, 0);
  assert.deepEqual(zero.calls.slice(0, 2).map((row) => row.method), ["eth_chainId", "eth_chainId"]);
  assert.equal(validateOutput(zero.output), true);

  const continued = await execute(authority, { finalized: 10005n, zeroEvents: true }, { priorArtifact: zero.output });
  assert.equal(continued.output.status, STATUS_COMPLETE);
  assert.deepEqual(continued.output.blockRange, { fromBlock: "10001", toBlock: "10005" });
  assert.deepEqual(continued.output.lastCompleteCursor, continued.output.blockRange);
  assert.deepEqual(continued.output.continuation, { mode: "CONTINUATION", previousToBlock: "10000", nextFromBlock: "10006", cursorAdvanced: true, backlogRemaining: false, blocksScanned: 5 });

  const backlog = await execute(authority, { finalized: 30000n, zeroEvents: true }, { priorArtifact: zero.output });
  assert.deepEqual(backlog.output.blockRange, { fromBlock: "10001", toBlock: "18192" });
  assert.equal(backlog.output.continuation.backlogRemaining, true);
  assert.equal(backlog.output.continuation.blocksScanned, 8192);
  const backlogNext = await execute(authority, { finalized: 30000n, zeroEvents: true }, { priorArtifact: backlog.output });
  assert.deepEqual(backlogNext.output.blockRange, { fromBlock: "18193", toBlock: "26384" });

  const noNew = await execute(authority, { finalized: 10000n, zeroEvents: true }, { priorArtifact: zero.output });
  assert.equal(noNew.output.status, STATUS_COMPLETE);
  assert.deepEqual(noNew.output.blockRange, { fromBlock: null, toBlock: null });
  assert.deepEqual(noNew.output.lastCompleteCursor, zero.output.lastCompleteCursor);
  assert.deepEqual(noNew.output.continuation, { mode: "NO_NEW_FINALIZED_BLOCK", previousToBlock: "10000", nextFromBlock: "10001", cursorAdvanced: false, backlogRemaining: false, blocksScanned: 0 });

  const legacy = JSON.parse(JSON.stringify(zero.output));
  legacy.schema = "aave-v3-arbitrum-config-oracle-events/v1";
  delete legacy.generatedAt; delete legacy.lastCompleteCursor; delete legacy.continuation;
  const seeded = await execute(authority, { finalized: 10002n, zeroEvents: true }, { priorArtifact: legacy });
  assert.deepEqual(seeded.output.blockRange, { fromBlock: "10001", toBlock: "10002" });

  const survivor = await execute(authority);
  assert.equal(survivor.output.status, STATUS_SURVIVOR);
  assert.equal(survivor.output.outcome, "EVENT_SURVIVOR_NO_ROUTE");
  assert.equal(survivor.output.eventCount, 1);
  assert.equal(survivor.output.categoryCounts.ReserveBorrowing, 1);
  assert.deepEqual(Object.keys(survivor.output.events[0]).sort(), ["blockNumber", "category", "commitment", "logIndex", "transactionIndex"]);
  assert.equal(survivor.output.events[0].category, "ReserveBorrowing");
  assert.match(survivor.output.events[0].commitment, /^sha256-[A-Za-z0-9_-]{43}$/u);
  assert.deepEqual(survivor.output.route, { routeObserved: false, routePositive: "n/a", stateInterpretationPerformed: false });
  const repeated = await execute(authority);
  assert.deepEqual(repeated.output.events, survivor.output.events);
  assert.equal(validateOutput(survivor.output), true);

  const disagreement = await execute(authority, { familyDisagreement: true });
  assertIncomplete(disagreement, "LOG_DISAGREEMENT");

  const preserved = await execute(authority, { finalized: 10001n, familyDisagreement: true }, { priorArtifact: zero.output });
  assertIncomplete(preserved, "LOG_DISAGREEMENT");
  assert.deepEqual(preserved.output.lastCompleteCursor, zero.output.lastCompleteCursor);
  assert.deepEqual(preserved.output.continuation, { mode: "INCOMPLETE", previousToBlock: "10000", nextFromBlock: "10001", cursorAdvanced: false, backlogRemaining: null, blocksScanned: 0 });

  const malformedPrior = await execute(authority, { zeroEvents: true }, { priorArtifact: { schema: "tampered" } });
  assertIncomplete(malformedPrior, "PRIOR_ARTIFACT_INVALID");
  assert.equal(malformedPrior.calls.length, 0);
  assert.equal(malformedPrior.output.lastCompleteCursor, null);

  const insufficient = await execute(authority, {}, { inventoryText: "Arbitrum https://node-a.test/rpc/one [public]" });
  assertIncomplete(insufficient, "TWO_FAMILIES_UNAVAILABLE");
  assert.equal(insufficient.output.qualification.selectedFamilyCount, 0);

  const malformed = await execute(authority, { malformed: true });
  assertIncomplete(malformed, "LOG_INVALID");
  const wrongEmitter = await execute(authority, { wrongEmitter: true });
  assertIncomplete(wrongEmitter, "WRONG_EMITTER");
  const wrongTopic = await execute(authority, { wrongTopic: true });
  assertIncomplete(wrongTopic, "LOG_INVALID");
  const wrongData = await execute(authority, { wrongData: true });
  assertIncomplete(wrongData, "LOG_INVALID");

  const reorg = await execute(authority, { terminalReorg: true });
  assertIncomplete(reorg, "TERMINAL_RECHECK_FAILED");

  const capped = await execute(authority, { eventCap: true });
  assertIncomplete(capped, "EVENT_CAP");
  assert(capped.output.reads.count <= LIMITS.calls);

  const secret = await execute(authority, { secretFailure: true }, { inventoryText: [
    "Arbitrum One https://node-a.test/rpc/one/SUPER_SECRET_CREDENTIAL [public]",
    "Arbitrum https://node-b.test/rpc/two/SUPER_SECRET_CREDENTIAL [keyless]"
  ].join("\n") });
  assertIncomplete(secret, "TWO_FAMILIES_UNAVAILABLE");
  const serialized = JSON.stringify(secret.output);
  assert(!serialized.includes("SUPER_SECRET_CREDENTIAL"));
  assert(!/(?:https?|wss?):\/\/|0x[0-9a-f]{8,}|\b(?:credentials?|secrets?|authorization|bearer|endpoints?|raw[- _]?logs?)\b/iu.test(JSON.stringify(survivor.output)));
  assert.deepEqual(survivor.output.safety, { readOnlyRpc: true, transactions: false, signing: false, broadcast: false, walletAccess: false, productionMutation: false });

  process.stdout.write("PASS arbitrum aave v3 config/oracle event-only fixture suite\n");
}

main().catch((error) => { process.stderr.write(`FAIL ${error.message}\n`); process.exitCode = 1; });
