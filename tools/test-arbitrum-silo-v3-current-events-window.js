#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const {
  CATEGORIES,
  PINS,
  STATUS_COMPLETE,
  WindowError,
  parseInventoryText,
  readAuthority,
  runWindow,
  validateOutput
} = require("./run-arbitrum-silo-v3-current-events-window");

const HASH_A = `0x${"11".repeat(32)}`;
const HASH_B = `0x${"22".repeat(32)}`;
const ROOT_A = `0x${"33".repeat(32)}`;
const TX_A = `0x${"44".repeat(32)}`;
const FINALIZED = 10000n;
const INVENTORY = [
  "Arbitrum One https://node-a.test/rpc/one [public]",
  "Arbitrum https://node-b.test/rpc/two [keyless]"
].join("\n");
function classify(value) { const pathname = new URL(value).pathname; return { operatorFamily: pathname.endsWith("/two") ? "family-b" : "family-a", capabilityRank: 1 }; }

function block(number, overrides = {}) {
  const n = BigInt(number);
  return {
    number: `0x${n.toString(16)}`,
    hash: overrides.hash || (n === FINALIZED ? HASH_A : `0x${n.toString(16).padStart(64, "0")}`),
    parentHash: overrides.parentHash || HASH_B,
    stateRoot: overrides.stateRoot || ROOT_A,
    timestamp: overrides.timestamp || "0x66"
  };
}

function eventLog(authority, options = {}) {
  const event = authority.events.find((row) => row.name === "SetIsAllocator");
  const emitter = options.emitter || authority.vaults[0];
  const values = [authority.vaults[0], options.flag ?? true];
  const encoded = event.iface.encodeEventLog(event.iface.getEvent(event.name), values);
  return {
    address: emitter,
    blockNumber: `0x${FINALIZED.toString(16)}`,
    blockHash: HASH_A,
    transactionHash: TX_A,
    transactionIndex: "0x1",
    logIndex: "0x2",
    removed: false,
    topics: encoded.topics,
    data: encoded.data
  };
}

function fixture(authority, options = {}) {
  const exactReads = new Map(); const calls = [];
  const transport = async ({ candidate, envelope }) => {
    calls.push({ method: envelope.method, family: candidate.family, ordinal: candidate.ordinal }); let result;
    if (envelope.method === "eth_chainId") result = options.wrongChainOrdinals?.has(candidate.ordinal) ? "0x1" : "0xa4b1";
    else if (envelope.method === "eth_getBlockByNumber") {
      const tag = envelope.params[0];
      if (tag === "finalized") result = block(FINALIZED);
      else {
        const number = BigInt(tag), key = `${candidate.family}:${number}`, count = (exactReads.get(key) || 0) + 1; exactReads.set(key, count);
        if (options.headerDisagreement && number === FINALIZED && candidate.family === "family-b") result = block(number, { stateRoot: `0x${"55".repeat(32)}` });
        else if (options.terminalReorg && number === FINALIZED && count >= 3) result = block(number, { hash: `0x${"66".repeat(32)}` });
        else result = block(number);
      }
    } else if (envelope.method === "eth_getLogs") {
      const filter = envelope.params[0], single = filter.fromBlock === filter.toBlock;
      if (single) result = [];
      else if (options.unbound) result = [eventLog(authority, { emitter: "0x0000000000000000000000000000000000000001" })];
      else result = [eventLog(authority, { flag: options.logDisagreement && candidate.family === "family-b" ? false : true })];
    } else throw new Error("unexpected method");
    const value = { jsonrpc: "2.0", id: envelope.id, result };
    return { value, bytes: Buffer.byteLength(JSON.stringify(value)) };
  };
  return { transport, calls };
}

async function execute(authority, options = {}, runOptions = {}) {
  const current = fixture(authority, options);
  const output = await runWindow({ authorityAdapter: () => authority, inventoryText: INVENTORY, inventoryIdentity: "fixture", assertInventoryUnchangedFn: () => {}, operatorClassifier: classify, transport: current.transport, ...runOptions });
  return { output, calls: current.calls };
}

async function main() {
  const authority = readAuthority();
  assert.equal(authority.eventCount, 9);
  assert.deepEqual(authority.categoryNames, CATEGORIES);
  assert.equal(new Set(authority.events.map((row) => row.topic)).size, authority.eventCount);

  const candidates = parseInventoryText(`${INVENTORY}\nArbitrum https://node-c.test/rpc/three [public custom headers required]\nArbitrum https://node-d.test/rpc/four [public unavailable]`, classify);
  assert.equal(candidates.length, 2);
  assert.equal(new Set(candidates.map((row) => row.family)).size, 2);

  const unrelatedBefore = Array.from({ length: 20 }, (_, index) => `Ethereum public https://other-${index}.test/rpc/ignored`).join("\n");
  const labelledAfter = parseInventoryText(`${unrelatedBefore}\nArbitrum One https://node-a.test/rpc/one\nArbitrum https://node-b.test/rpc/two`, classify);
  assert.equal(labelledAfter.length, 2);
  assert.deepEqual(labelledAfter.map((row) => row.ordinal), [0, 1]);

  const matrixRow = parseInventoryText("| public | Arbitrum https://node-a.test/rpc/one | no auth |", classify);
  assert.equal(matrixRow.length, 1);

  const sameLineOnly = parseInventoryText(["Arbitrum One", "https://node-a.test/rpc/one", "https://node-b.test/rpc/two"].join("\n"), classify);
  assert.equal(sameLineOnly.length, 0);

  const genericOnly = parseInventoryText(["https://node-a.test/rpc/one", "Ethereum https://node-b.test/rpc/two"].join("\n"), classify);
  assert.equal(genericOnly.length, 0);

  const overCap = parseInventoryText(Array.from({ length: 14 }, (_, index) => `Arbitrum https://node-${index}.test/rpc/${index === 13 ? "two" : "one"} [public]`).join("\n"), classify);
  assert.equal(overCap.length, 12);
  assert.deepEqual(overCap.map((row) => row.ordinal), Array.from({ length: 12 }, (_, index) => index));

  assert.throws(() => readAuthority({ readFile(file) { const bytes = fs.readFileSync(file); return file === PINS.events.file ? Buffer.concat([bytes, Buffer.from("x")]) : bytes; } }), (error) => error instanceof WindowError && error.code === "AUTHORITY_INVALID");

  const complete = await execute(authority);
  assert.equal(complete.output.status, STATUS_COMPLETE);
  assert.equal(complete.output.eventCount, 1);
  assert.equal(complete.output.categoryCounts.SetIsAllocator, 1);
  assert.equal(complete.output.anonymousLabelledCount, 2);
  assert.equal(complete.output.anonymousChainMatchedCount, 2);
  assert.equal(complete.output.anonymousLogQualifiedCount, 2);
  assert.equal(complete.output.anonymousSelectedCount, 2);
  assert.equal(complete.output.blockRange.toBlock, FINALIZED.toString());
  assert.deepEqual(complete.calls.slice(0, 2).map((row) => row.method), ["eth_chainId", "eth_chainId"]);
  assert(complete.calls.every((row) => ["eth_chainId", "eth_getBlockByNumber", "eth_getLogs"].includes(row.method)));
  assert.equal(validateOutput(complete.output), true);
  assert(!/(?:https?:\/\/|0x[0-9a-f]{8,}|provider|endpoint|topic|address)/iu.test(JSON.stringify(complete.output)));

  const wrong = await execute(authority, { wrongChainOrdinals: new Set([0]) }, { inventoryText: "Arbitrum https://node-a.test/rpc/one" });
  assert.equal(wrong.output.anonymousLabelledCount, 1);
  assert.equal(wrong.output.anonymousChainMatchedCount, 0);
  assert.equal(wrong.output.anonymousLogQualifiedCount, 0);
  assert.equal(wrong.output.readCount, 1);
  assert.deepEqual(wrong.calls.map((row) => row.method), ["eth_chainId"]);
  assert.equal(Object.hasOwn(wrong.output, "eventCount"), false);
  assert.equal(Object.hasOwn(wrong.output, "categoryCounts"), false);

  const unsafeInventory = [
    "Arbitrum https://node-a.test/rpc/one [public custom headers required]",
    "Arbitrum https://node-b.test/rpc/two [public restricted]",
    "Arbitrum https://node-c.test/rpc/three [public browser session auth]",
    "Arbitrum https://node-d.test/rpc/four [public exposed credentials]",
    "Arbitrum https://node-e.test/rpc/five [public pruned]",
    "Arbitrum https://node-f.test/rpc/six [public unsupported proxy batch]",
    "Arbitrum https://placeholder.test/rpc/seven [public]"
  ].join("\n");
  const unsafe = await execute(authority, {}, { inventoryText: unsafeInventory });
  assert.equal(unsafe.output.anonymousLabelledCount, 0);
  assert.equal(unsafe.output.readCount, 0);
  assert.equal(unsafe.calls.length, 0);

  const independentInventory = ["Arbitrum One https://node-a.test/rpc/one", "Arbitrum https://node-c.test/rpc/three", "Arbitrum One https://node-b.test/rpc/two"].join("\n");
  const independent = await execute(authority, {}, { inventoryText: independentInventory });
  assert.equal(independent.output.status, STATUS_COMPLETE);
  const fullLogFamilies = independent.calls.filter((row) => row.method === "eth_getLogs").slice(-2).map((row) => row.family);
  assert.deepEqual(fullLogFamilies, ["family-a", "family-b"]);

  const noFallback = () => null;
  const distinctHeadings = ["Provider Alpha", "Arbitrum https://node-a.test/rpc/one", "Provider Beta", "Arbitrum One https://node-b.test/rpc/two"].join("\n");
  const headingRows = parseInventoryText(distinctHeadings, noFallback);
  assert.equal(headingRows.length, 2);
  assert.equal(new Set(headingRows.map((row) => row.family)).size, 2);
  assert(headingRows.every((row) => /^inventory-family-[0-9]+$/u.test(row.family)));
  const headingSelection = await execute(authority, {}, { inventoryText: distinctHeadings, operatorClassifier: noFallback });
  assert.equal(headingSelection.output.status, STATUS_COMPLETE);
  assert.equal(headingSelection.output.anonymousSelectedCount, 2);
  assert(!/(?:alpha|beta|provider|inventory-family|family-[0-9]+)/iu.test(JSON.stringify(headingSelection.output)));

  const sameHeading = ["Provider Alpha", "Arbitrum https://node-a.test/rpc/one", "Arbitrum https://node-b.test/rpc/two"].join("\n");
  const sameRows = parseInventoryText(sameHeading, noFallback);
  assert.equal(new Set(sameRows.map((row) => row.family)).size, 1);
  const sameSelection = await execute(authority, {}, { inventoryText: sameHeading, operatorClassifier: noFallback });
  assert.equal(sameSelection.output.code, "TWO_FAMILIES_UNAVAILABLE");
  assert.equal(sameSelection.output.anonymousSelectedCount, 0);

  const repeatedHeadingKey = ["Provider Alpha", "Arbitrum https://node-a.test/rpc/one", "Provider Alpha", "Arbitrum https://node-b.test/rpc/two"].join("\n");
  const repeatedRows = parseInventoryText(repeatedHeadingKey, noFallback);
  assert.equal(new Set(repeatedRows.map((row) => row.family)).size, 1);
  const repeatedSelection = await execute(authority, {}, { inventoryText: repeatedHeadingKey, operatorClassifier: noFallback });
  assert.equal(repeatedSelection.output.code, "TWO_FAMILIES_UNAVAILABLE");

  const repeatedUrl = parseInventoryText(["Provider Alpha", "Arbitrum https://node-a.test/rpc/one", "Provider Beta", "Arbitrum https://node-a.test/rpc/one"].join("\n"), noFallback);
  assert.equal(repeatedUrl.length, 1);

  const unboundFamilies = await execute(authority, {}, { inventoryText: ["Arbitrum https://node-a.test/rpc/one", "Arbitrum One https://node-b.test/rpc/two"].join("\n"), operatorClassifier: noFallback });
  assert.equal(unboundFamilies.output.anonymousLogQualifiedCount, 2);
  assert.equal(unboundFamilies.output.code, "TWO_FAMILIES_UNAVAILABLE");
  assert.equal(unboundFamilies.output.anonymousSelectedCount, 0);

  const disagreement = await execute(authority, { logDisagreement: true });
  assert.equal(disagreement.output.status, "INCOMPLETE");
  assert.equal(disagreement.output.code, "LOG_DISAGREEMENT");

  const headerMismatch = await execute(authority, { headerDisagreement: true });
  assert.equal(headerMismatch.output.status, "INCOMPLETE");
  assert.equal(headerMismatch.output.code, "COMMON_FINALIZED_UNAVAILABLE");

  const unbound = await execute(authority, { unbound: true });
  assert.equal(unbound.output.status, "INCOMPLETE");
  assert.equal(unbound.output.code, "UNBOUND_EMITTER");

  const reorg = await execute(authority, { terminalReorg: true });
  assert.equal(reorg.output.status, "INCOMPLETE");
  assert.equal(reorg.output.code, "TERMINAL_RECHECK_FAILED");

  const cap = await execute(authority, {}, { maxCalls: 2 });
  assert.equal(cap.output.status, "INCOMPLETE");
  assert.equal(cap.output.code, "READ_CAP");

  process.stdout.write("PASS arbitrum silo v3 current events window fixture suite\n");
}

main().catch((error) => { process.stderr.write(`FAIL ${error.message}\n`); process.exitCode = 1; });
