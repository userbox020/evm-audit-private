#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { id } = require("./node_modules/ethers");
const gate = require("./capture-stakewise-subvault-exitqueue-residual-gate0.js");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "reports", "raw", "fast", "stakewise-subvault-exitqueue-residual-gate0");
let assertions = 0;
function check(value, message) { assert.ok(value, message); assertions++; }
function equal(actual, expected, message) { assert.deepEqual(actual, expected, message); assertions++; }
function throws(fn, message) { assert.throws(fn, message); assertions++; }

gate.verifyHardcodedManifests();
const proof = gate.verifySourceCompilerProofs();
equal(proof.storageLayouts.length, 4, "both versions and compiler profiles prove storage");
equal(proof.storageLayouts.map((x) => x.p.slot), ["11", "11", "11", "11"], "slot 11 compiler proof");
equal(proof.packing.positionTicketBits, 160, "ticket width");
equal(proof.packing.sharesBits, 96, "share width");

equal(gate.intervals(0n, 1n, 0n), [{ from: 0n, to: 0n }], "single boundary");
equal(gate.intervals(12n, 3n, 5n), [{ from: 5n, to: 7n }, { from: 8n, to: 10n }, { from: 11n, to: 12n }], "inclusive interval partition");
equal(gate.intervals(4n, 3n, 5n), [], "empty inverted range");
equal(gate.intervals(4n, 0n, 0n), [], "zero width rejected");
const ledger = gate.intervals(12n, 3n, 5n).map((x) => ({ fromBlock: x.from.toString(), toBlock: x.to.toString() }));
check(gate.validateCoverage(ledger, { number: "12" }, "5"), "coverage accepts exact contiguous partition");
check(!gate.validateCoverage([{ fromBlock: "5", toBlock: "7" }, { fromBlock: "9", toBlock: "12" }], { number: "12" }, "5"), "coverage rejects gap");
check(!gate.validateCoverage([{ fromBlock: "5", toBlock: "13" }], { number: "12" }, "5"), "coverage rejects overshoot");

const registry = gate.CHAINS.ethereum.registry;
const baseLog = { removed: false, address: registry, blockNumber: "0x1", blockHash: `0x${"11".repeat(32)}`, transactionHash: `0x${"22".repeat(32)}`, transactionIndex: "0x0", logIndex: "0x0", data: "0x" };
const caller = "0x0000000000000000000000000000000000000001", vault = "0x0000000000000000000000000000000000000002";
const topicAddress = (x) => `0x${x.slice(2).padStart(64, "0")}`;
const normalized = gate.normalizeRegistryLog({ ...baseLog, topics: [gate.TOPICS.vaultAdded, topicAddress(caller), topicAddress(vault)] }, registry);
equal(normalized.type, "VaultAdded", "event filter type");
equal(normalized.caller, caller, "indexed caller decode");
equal(normalized.vault, vault, "indexed vault decode");
equal(gate.TOPICS.factoryAdded, id("FactoryAdded(address)").toLowerCase(), "factory topic");
equal(gate.TOPICS.claim, id("ExitedAssetsClaimed(address,uint256,uint256,uint256)").toLowerCase(), "claim topic");
throws(() => gate.normalizeRegistryLog({ ...baseLog, address: vault, topics: [gate.TOPICS.factoryAdded, topicAddress(caller)] }, registry), "foreign registry rejected");

function pack(ticket, shares) { return `0x${ticket.toString(16).padStart(40, "0")}${shares.toString(16).padStart(24, "0")}`; }
for (const [ticket, shares] of [[0n, 0n], [1n, 1n], [(1n << 160n) - 1n, (1n << 96n) - 1n], [0x1234567890abcdefn, 0xfedcba987654321n]]) {
  const decoded = gate.unpackPosition(pack(ticket, shares)); equal(decoded.positionTicket, ticket.toString(), "packed ticket boundary"); equal(decoded.shares, shares.toString(), "packed shares boundary");
}

const fixtureParent = (overrides = {}) => ({ totalAssets: "1000000000000000000", children: [], runtimeBinding: { currentPatchExact: true }, invariants: { pass: true, coveragePass: true, childShareAccountingPass: true }, publicOneTicketComposition: { activeBoundaries: [], maximumCurrentProtocolOwnedExposureRaw: "0" }, ...overrides });
const fixtureState = (parent) => ({ vaultEventCount: 1, uniqueRegisteredVaults: 1, duplicateVaultAddedEvents: 0, parents: [parent] });
const runtime = { exactRelevantRuntimeCount: 1, relevantRuntimeCount: 1, allRelevantExact: true, parentBackPointersExact: true };
let summary = gate.summarizeChain(gate.CHAINS.ethereum, fixtureState(fixtureParent()), runtime);
equal(summary.gatePositive, false, "fixed empty fixture stops");
equal(summary.assetDecimals, 18, "unit decimals preserved");
summary = gate.summarizeChain(gate.CHAINS.ethereum, fixtureState(fixtureParent({ runtimeBinding: { currentPatchExact: false } })), runtime);
equal(summary.materialPatchLagParents, 1, "material patch lag fixture"); check(summary.gatePositive, "patch lag opens Gate0");
summary = gate.summarizeChain(gate.CHAINS.ethereum, fixtureState(fixtureParent({ invariants: { pass: false, coveragePass: true, childShareAccountingPass: true } })), runtime);
equal(summary.materialResidualOrCoverageMismatchParents, 1, "residual fixture"); check(summary.gatePositive, "residual opens Gate0");
summary = gate.summarizeChain(gate.CHAINS.ethereum, fixtureState(fixtureParent({ publicOneTicketComposition: { activeBoundaries: [{}], maximumCurrentProtocolOwnedExposureRaw: "1" } })), runtime);
equal(summary.activePublicOneTicketBoundaries, 1, "one-ticket fixture"); check(summary.gatePositive, "live composition opens Gate0");
summary = gate.summarizeChain(gate.CHAINS.ethereum, fixtureState(fixtureParent({ totalAssets: "999999999999999999", runtimeBinding: { currentPatchExact: false } })), runtime);
equal(summary.materialPatchLagParents, 0, "sub-unit patch lag is not material");

equal(gate.stable({ b: 2, a: 1 }), gate.stable({ a: 1, b: 2 }), "family equality canonicalizes key order");
check(gate.stable({ pin: "a" }) !== gate.stable({ pin: "b" }), "family mismatch remains visible");
gate.secretGuard({ safe: true, familyCount: 2 }, ["secret-token-value"]); assertions++;
throws(() => gate.secretGuard({ unsafe: "https://example.invalid" }, []), "URL sanitization");
throws(() => gate.secretGuard({ unsafe: "secret-token-value" }, ["secret-token-value"]), "inventory corpus sanitization");

const result = { schemaVersion: 1, testId: "stakewise-subvault-exitqueue-residual-gate0", generatedAt: new Date().toISOString(), status: "PASS", suites: 8, assertions, coverage: ["interval coverage", "event filters/topics", "two-family canonical equality", "compiler storage layout", "exit-position packing boundaries", "P/E/Q gate equations", "units/decimals/materiality", "strict sanitization"], network: false, rpcInventoryRead: false, fork: false, transactions: false, signing: false };
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "tests.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));
