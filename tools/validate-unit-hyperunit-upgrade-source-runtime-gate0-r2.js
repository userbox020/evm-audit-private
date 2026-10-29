#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { getAddress, id } = require("./node_modules/ethers");

const ROOT = path.resolve(__dirname, "..");
const STEM = "unit-hyperunit-upgrade-source-runtime-gate0-r2";
const CAPTURE_REL = `reports/raw/fast/${STEM}/capture.json`;
const MANIFEST_REL = `reports/raw/fast/${STEM}/manifest.json`;
const TOPIC = id("Upgraded(address)").toLowerCase();
const PROXIES = [
  ["UBTC", "0x9FDBdA0A5e284c32744D2f17Ee5c74B284993463", "1513232", "0x1a7689c3B783EB37550efBB9c81e7F468F7034FC"],
  ["UETH", "0xBe6727B535545C67d5cAa73dEa54865B92CF7907", "1546814", "0xE60DD45EBa5655e31CA1E61BEad4f983B3C4A83B"],
  ["UFART", "0x3B4575E689DEd21CAAD31d64C4df1f10F3B2CedF", "4131487", "0xEEE571012C07032907b952714c48c81F8999e96A"],
  ["USOL", "0x068f321Fa8Fb9f0D135f290Ef6a3e2813e1c8A29", "4132417", "0xaB73C0Ab9E4b931769373bd0C6480c022119D74c"],
  ["UPUMP", "0x27eC642013bcB3D80CA3706599D3cdA04F6f4452", "8415332", "0xD9d236F9FA38e5aE0c33170a23f09eD50c3E0617"],
];
const ADDRESS_SET = new Set(PROXIES.map((x) => x[1].toLowerCase()));
let checks = 0;
function ok(value, message) { checks += 1; if (!value) throw new Error(message); }
function abs(rel) { return path.join(ROOT, ...rel.split("/")); }
function sha(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
function pinHeader(pin) {
  return {
    number: pin.number,
    hash: pin.hash,
    stateRoot: pin.stateRoot,
    timestamp: pin.timestamp,
    parentHash: pin.parentHash,
  };
}
function readJson(rel) { return JSON.parse(fs.readFileSync(abs(rel), "utf8")); }
function exactKeys(object, keys, label) { ok(object && typeof object === "object" && !Array.isArray(object), `${label} object`); ok(stable(Object.keys(object).sort()) === stable([...keys].sort()), `${label} keys`); }
function canonicalGate(value) { return ["true", "false", "unknown", "n/a"].includes(value); }
function normalizedEvents(rows) {
  return [...rows].sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || Number(BigInt(a.transactionIndex) - BigInt(b.transactionIndex)) || Number(BigInt(a.logIndex) - BigInt(b.logIndex)) || a.address.localeCompare(b.address));
}
function validateEvent(row, interval, seen, label) {
  exactKeys(row, ["address", "symbol", "blockNumber", "blockHash", "transactionHash", "transactionIndex", "logIndex", "topic0", "topicCount", "data", "implementation", "removed", "dedupeKey"], `${label} event`);
  const normalizedAddress = getAddress(row.address), implementation = getAddress(row.implementation);
  ok(ADDRESS_SET.has(normalizedAddress.toLowerCase()), `${label} scoped address`);
  ok(PROXIES.find((x) => x[1].toLowerCase() === normalizedAddress.toLowerCase())[0] === row.symbol, `${label} symbol join`);
  ok(/^0x[0-9a-f]{64}$/.test(row.blockHash) && /^0x[0-9a-f]{64}$/.test(row.transactionHash), `${label} hashes`);
  ok(row.topic0 === TOPIC && row.topicCount === 2 && row.data === "0x" && row.removed === false, `${label} topic/layout/removed`);
  ok(BigInt(row.blockNumber) >= BigInt(interval.fromBlock) && BigInt(row.blockNumber) <= BigInt(interval.toBlock), `${label} interval containment`);
  const key = `${row.blockHash}:${row.transactionHash}:${row.logIndex}`;
  ok(row.dedupeKey === key && !seen.has(key), `${label} dedupe key`); seen.add(key);
  ok(implementation === row.implementation, `${label} checksummed implementation`);
}
function validateLedger(rel, family, pin) {
  const ledger = readJson(rel);
  exactKeys(ledger, ["schema", "family", "pin", "width", "status", "intervals"], `${family} ledger`);
  ok(ledger.schema === `${STEM}/ledger-v1` && ledger.family === family, `${family} identity`);
  ok(stable(ledger.pin) === stable(pinHeader(pin)), `${family} pin`);
  ok(ledger.status === "PASS", `${family} pass`);
  ok(["100000", "50000", "25000", "10000"].includes(ledger.width), `${family} width`);
  let expected = 0n, eventCount = 0; const seen = new Set(), all = [];
  for (let i = 0; i < ledger.intervals.length; i += 1) {
    const row = ledger.intervals[i];
    exactKeys(row, ["fromBlock", "toBlock", "inclusiveWidth", "addressBatch", "addressBatchCount", "resultCount", "normalizedResultCommitment", "eventRecords"], `${family} interval ${i}`);
    const from = BigInt(row.fromBlock), to = BigInt(row.toBlock), width = BigInt(row.inclusiveWidth);
    ok(from === expected, `${family} contiguous ${i}`);
    ok(to >= from && to - from + 1n === width, `${family} inclusive width ${i}`);
    ok(i === ledger.intervals.length - 1 || width === BigInt(ledger.width), `${family} full nonterminal width ${i}`);
    ok(row.addressBatchCount === 5 && row.addressBatch.length === 5 && stable(new Set(row.addressBatch.map((x) => getAddress(x).toLowerCase())).size) === stable(5), `${family} batch cardinality ${i}`);
    ok(row.addressBatch.every((x) => ADDRESS_SET.has(getAddress(x).toLowerCase())), `${family} exact batch ${i}`);
    ok(row.resultCount === row.eventRecords.length, `${family} result count ${i}`);
    const localSeen = new Set(); for (const event of row.eventRecords) validateEvent(event, row, localSeen, `${family}/${i}`);
    const sorted = normalizedEvents(row.eventRecords);
    ok(row.normalizedResultCommitment === sha(Buffer.from(stable(sorted))), `${family} interval commitment ${i}`);
    for (const event of sorted) { ok(!seen.has(event.dedupeKey), `${family} global dedupe ${i}`); seen.add(event.dedupeKey); all.push(event); }
    eventCount += row.eventRecords.length; expected = to + 1n;
  }
  ok(expected === BigInt(pin.number) + 1n, `${family} exact [0,T] union`);
  return { ledger, events: normalizedEvents(all), eventCount };
}
function validateR1(authority) {
  const capture = fs.readFileSync(abs(authority.capturePath)), manifestBytes = fs.readFileSync(abs(authority.manifestPath)), manifest = JSON.parse(manifestBytes);
  ok(capture.length === authority.captureBytes && sha(capture) === authority.captureSha256, "R1 capture immutable");
  ok(manifestBytes.length === authority.manifestBytes && sha(manifestBytes) === authority.manifestSha256, "R1 manifest immutable");
  ok(manifest.aggregateSha256 === authority.manifestAggregateSha256 && manifest.records.length === authority.recordCount, "R1 aggregate binding");
  for (const row of manifest.records) { const bytes = fs.readFileSync(abs(row.path)); ok(bytes.length === row.bytes && sha(bytes) === row.sha256, `R1 record ${row.path}`); }
}
function validateManifest() {
  const manifest = readJson(MANIFEST_REL);
  exactKeys(manifest, ["schema", "generatedAt", "hashAlgorithm", "digestConstruction", "records", "aggregateSha256"], "manifest");
  ok(manifest.schema === `${STEM}/manifest-v1` && manifest.hashAlgorithm === "sha256" && manifest.digestConstruction === "sha256(stable-json(records))", "manifest authority");
  for (const row of manifest.records) { exactKeys(row, ["path", "bytes", "sha256"], `manifest ${row.path}`); const bytes = fs.readFileSync(abs(row.path)); ok(bytes.length === row.bytes && sha(bytes) === row.sha256, `manifest hash ${row.path}`); }
  ok(manifest.aggregateSha256 === sha(Buffer.from(stable(manifest.records))), "manifest aggregate recomputation");
}

const capture = readJson(CAPTURE_REL);
ok(capture.schema === `${STEM}/capture-v1`, "capture schema");
ok(capture.overlay === "R2_IMMUTABLE_CORRECTION", "overlay");
ok(["HISTORY_COMPLETE_PASS", "HISTORY_INCOMPLETE_CAPABILITY_LIMITED"].includes(capture.status), "status");
ok(capture.r1Supersession.supersedesR1AdmissionSemantics === true && capture.r1Supersession.r1ArtifactsModified === false, "R1 supersession semantics");
ok(capture.currentCodeAuditAdmission.startsWith("PASS"), "current-code admission preserved");
ok(canonicalGate(capture.gates.routePositive) && canonicalGate(capture.gates.executableNow), "canonical gates");
ok(capture.gates.routePositive === "unknown" && capture.gates.executableNow === "unknown", "unknown route gates");
ok(capture.gates.signedActionJustified === false && capture.gates.fork.justified === false && capture.gates.fork.signedAction === false, "no signing/fork");
ok(capture.safety.readOnly && !capture.safety.transactions && !capture.safety.signing && !capture.safety.providerMaterialPersisted, "safety");
validateR1(capture.r1Authority);

const methodTotal = Object.values(capture.counters.methodAttempts).reduce((a, b) => a + b, 0);
ok(methodTotal === capture.counters.logicalRpcAttempts, "exact logical attempt count");
ok(capture.counters.logicalRpcAttempts <= 10000 && capture.counters.retries <= 64 && capture.counters.successfulHistoryCallsTotal <= 9000, "global caps");
ok(capture.qualification == null || capture.qualification.candidatesConsidered <= 16, "candidate cap");

if (capture.historyComplete) {
  ok(capture.status === "HISTORY_COMPLETE_PASS" && capture.accessDisposition === "AVAILABLE", "history pass classification");
  ok(capture.pin.chainId === "999" && capture.pin.finality === "finalized" && capture.pin.twoFamilyAgreement === true, "fixed finalized pin");
  ok(capture.qualification.independentFamilies && capture.qualification.selected.A.capabilities.fiveAddressBatchEqualsSingletonUnion && capture.qualification.selected.B.capabilities.fiveAddressBatchEqualsSingletonUnion, "qualified families and batching");
  const a = validateLedger(capture.ledgers.A.path, "family-A", capture.pin), b = validateLedger(capture.ledgers.B.path, "family-B", capture.pin);
  ok(stable(a.events) === stable(b.events), "normalized family event sets equal");
  ok(stable(a.events) === stable(capture.normalizedEventSet), "capture event set recomputed");
  for (const [symbol, proxy, seed, expected] of PROXIES) ok(a.events.some((x) => x.symbol === symbol && x.address.toLowerCase() === proxy.toLowerCase() && x.blockNumber === seed && x.implementation.toLowerCase() === expected.toLowerCase()), `canary ${symbol}`);
  const terminal = capture.terminal;
  ok(stable(terminal.initial.A) === stable(terminal.initial.B) && stable(terminal.final.A) === stable(terminal.final.B) && stable(terminal.initial.A) === stable(terminal.final.A), "terminal two-family continuity");
  for (const family of ["A", "B"]) for (const phase of ["initial", "final"]) {
    const snap = terminal[phase][family]; ok(stable(snap.headerByNumber) === stable(pinHeader(capture.pin)), `${phase}/${family} header by number`); ok(stable(snap.headerByNumber) === stable(snap.headerByHash), `${phase}/${family} header by hash`);
  }
  for (const [symbol] of PROXIES) {
    const events = a.events.filter((x) => x.symbol === symbol), finalEvent = events.at(-1), slot = terminal.final.A.slots[symbol].implementation;
    ok(finalEvent && finalEvent.implementation.toLowerCase() === slot.toLowerCase(), `terminal event/slot ${symbol}`);
    ok(terminal.final.A.slots[symbol].proxyCode.present && terminal.final.A.slots[symbol].implementationCode.present, `terminal code ${symbol}`);
  }
  const qualificationSuccess = capture.qualification.successfulHistoryCallsAllCandidates;
  ok(qualificationSuccess + a.ledger.intervals.length + b.ledger.intervals.length === capture.counters.successfulHistoryCallsTotal, "successful history calls exact");
  ok(capture.qualification.selected.A.successfulQualificationLogs + a.ledger.intervals.length === capture.counters.successfulHistoryCallsFamilyA, "family A history cap count");
  ok(capture.qualification.selected.B.successfulQualificationLogs + b.ledger.intervals.length === capture.counters.successfulHistoryCallsFamilyB, "family B history cap count");
  ok(capture.counters.successfulHistoryCallsFamilyA <= 4400 && capture.counters.successfulHistoryCallsFamilyB <= 4400, "per-family caps");
} else {
  ok(capture.status === "HISTORY_INCOMPLETE_CAPABILITY_LIMITED", "bounded failure classification");
  ok(capture.accessDisposition === "RANGE_CAPABILITY_UNRESOLVED", "range capability unresolved");
  ok(capture.upgradeDeltaAdmission === "FAIL_CLOSED_HISTORY_INCOMPLETE", "upgrade claims blocked");
}

for (const rel of [CAPTURE_REL, ...(capture.historyComplete ? [capture.ledgers.A.path, capture.ledgers.B.path] : [])]) {
  const text = fs.readFileSync(abs(rel), "utf8");
  ok(!/(?:https?|wss?):\/\//i.test(text), `${rel} no URLs`);
  ok(!/bearer\s|authorization\s*[:=]|api[_-]?key|\.env(?:\.|\b)|private[_-]?key|seed phrase|providerUrl|hostname/i.test(text), `${rel} secret/provider scan`);
}
validateManifest();
console.log(`PASS ${checks} checks historyComplete=${capture.historyComplete}`);
