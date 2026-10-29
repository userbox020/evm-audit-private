#!/usr/bin/env node
"use strict";
// Explicit injected public observations only. No implicit files/RPC/indexer/BTC.
const { ethers } = require("ethers");
const { decodeRuntime } = require("./lib/surge-credit-runtime-decode");
const CHAIN_ID = 8453;
const CODES = new Set(["PAGE_INVALID", "CURSOR_STALL_OR_DUPLICATE", "SNAPSHOT_DRIFT", "PAGE_CAP", "ROW_CAP", "READ_CAP",
  "TRANSPORT_FAILED", "RESULT_INVALID", "PIN_INVALID", "PIN_DRIFT", "LOAN_PLAN_INCOMPLETE", "MODEL_UNQUALIFIED", "DESCRIPTOR_UNQUALIFIED"]);
class ObservationFailure extends Error { constructor(code) { super(code); this.code = code; } }
const need = (condition, code) => { if (!condition) throw new ObservationFailure(code); };
const hash = value => typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value);
const address = value => typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value) && !/^0x0{40}$/i.test(value);
const idText = value => typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value) && BigInt(value) < (1n << 256n);
const failure = error => error instanceof ObservationFailure && CODES.has(error.code) ? error.code : "TRANSPORT_FAILED";
const knownFailure = error => error instanceof ObservationFailure && CODES.has(error.code);
function sameSnapshot(a, b) { return a && b && a.id === b.id && a.chainId === CHAIN_ID && b.chainId === CHAIN_ID && hash(a.blockHash) && a.blockHash.toLowerCase() === b.blockHash?.toLowerCase(); }
function counts() { return { attempted: 0, succeeded: 0, failed: 0, unclassifiedFailures: 0, truncated: false }; }

// -1 is this local adapter's initial sentinel, not an assertion about a remote API.
async function collectLoanPages({ readPage, snapshot, pageSize = 100, maxPages = 16, maxRows = 5000, startCursor = "-1" } = {}) {
  const result = { schema: "surge-loan-indexer-pages/v1", loans: [], balanceAddresses: [], reads: counts(), readResults: [], complete: false, explicitEnd: false, failures: [], nextCursor: startCursor };
  if (typeof readPage !== "function") { result.failures.push("INDEXER_READER_MISSING"); return result; }
  try {
    need(sameSnapshot(snapshot, snapshot) && typeof snapshot.id === "string" && snapshot.id.length > 0 && snapshot.id.length <= 128, "PAGE_INVALID");
    need(Number.isInteger(pageSize) && pageSize > 0 && pageSize <= 1000 && Number.isInteger(maxPages) && maxPages > 0 && maxPages <= 64
      && Number.isInteger(maxRows) && maxRows > 0 && maxRows <= 10000 && (startCursor === "-1" || idText(startCursor)), "PAGE_INVALID");
    snapshot = structuredClone(snapshot);
    const seen = new Set(); let cursor = BigInt(startCursor), rowCount = 0;
    while (result.reads.attempted < maxPages) {
      result.reads.attempted++;
      try {
        const page = await readPage({ cursor: cursor.toString(), limit: pageSize, snapshot: structuredClone(snapshot), chainId: CHAIN_ID });
        need(sameSnapshot(page?.snapshot, snapshot), "SNAPSHOT_DRIFT");
        need(Array.isArray(page.rows) && page.rows.length <= pageSize && typeof page.end === "boolean", "PAGE_INVALID");
        let last = cursor; const additions = [];
        for (const row of page.rows) {
          need(row && idText(row.id) && Number.isSafeInteger(row.chainId) && row.chainId > 0, "PAGE_INVALID");
          need(BigInt(row.id) > last && !seen.has(row.id), "CURSOR_STALL_OR_DUPLICATE");
          last = BigInt(row.id);
          if (row.chainId === CHAIN_ID) {
            need(typeof row.bitcoinAddress === "string" && row.bitcoinAddress.length > 0 && row.bitcoinAddress.length <= 128
              && /^[a-zA-Z0-9]+$/.test(row.bitcoinAddress), "PAGE_INVALID");
            additions.push({ id: row.id, chainId: CHAIN_ID, bitcoinAddress: row.bitcoinAddress });
          }
        }
        need(page.end ? page.nextCursor === null : idText(page.nextCursor) && BigInt(page.nextCursor) === last && last > cursor, "CURSOR_STALL_OR_DUPLICATE");
        need(rowCount + page.rows.length <= maxRows, "ROW_CAP");
        rowCount += page.rows.length; for (const row of page.rows) seen.add(row.id);
        result.loans.push(...additions); result.reads.succeeded++;
        result.readResults.push({ id: `indexer.${cursor}`, status: "SUCCESS", kind: "INDEXER_PAGE" });
        if (page.end) { result.explicitEnd = true; result.complete = true; result.nextCursor = null; break; }
        cursor = last; result.nextCursor = cursor.toString();
      } catch (error) {
        result.reads.failed++; const code = failure(error); result.failures.push(code);
        result.readResults.push({ id: `indexer.${cursor}`, status: "FAILED", kind: "INDEXER_PAGE", failure: code });
        if (!knownFailure(error)) result.reads.unclassifiedFailures++;
        if (code === "ROW_CAP") result.reads.truncated = true;
        break;
      }
    }
    if (!result.explicitEnd && !result.failures.length) { result.reads.truncated = true; result.failures.push("PAGE_CAP"); }
  } catch (error) { result.failures.push(failure(error)); }
  // Never use this address deduplication as a position/loan deduplication key.
  result.balanceAddresses = [...new Set(result.loans.map(row => row.bitcoinAddress))];
  result.loanCount = result.loans.length; result.chainFilter = CHAIN_ID;
  result.scope = "INDEXER_SNAPSHOT_ONLY_NOT_AUTHORITATIVE_ONCHAIN_ENUMERATION";
  return result;
}

function reconcileLoanIds({ indexerIds = [], registryIds, historyEvents, totalSupply } = {}) {
  need(indexerIds.every(idText) && new Set(indexerIds).size === indexerIds.length, "PAGE_INVALID");
  const registry = Array.isArray(registryIds) && registryIds.every(idText) ? new Set(registryIds) : null;
  const active = new Set(), burned = new Set(), issues = [];
  let previousBlock = -1, previousLog = -1;
  for (const event of historyEvents || []) {
    need(idText(event.loanId) && ["MINT", "BURN"].includes(event.kind) && Number.isSafeInteger(event.blockNumber) && event.blockNumber >= 0
      && Number.isSafeInteger(event.logIndex) && event.logIndex >= 0 && hash(event.blockHash), "RESULT_INVALID");
    need(event.blockNumber > previousBlock || event.blockNumber === previousBlock && event.logIndex > previousLog, "RESULT_INVALID");
    previousBlock = event.blockNumber; previousLog = event.logIndex;
    if (event.kind === "MINT") { if (active.has(event.loanId)) issues.push("DUPLICATE_MINT"); active.add(event.loanId); burned.delete(event.loanId); }
    else { if (!active.has(event.loanId)) issues.push("BURN_WITHOUT_OBSERVED_MINT"); active.delete(event.loanId); burned.add(event.loanId); }
  }
  return { indexerIds: [...indexerIds], registryIds: registry ? [...registry] : null, observedHistoryActiveIds: [...active],
    missingFromIndexer: registry ? [...registry].filter(id => !indexerIds.includes(id)) : null,
    absentFromRegistry: registry ? indexerIds.filter(id => !registry.has(id)) : null,
    observedBurnedIndexedIds: indexerIds.filter(id => burned.has(id)), historyIssues: issues,
    totalSupply: idText(totalSupply) ? totalSupply : null, totalSupplyIsMaximumId: false,
    authoritativeEnumerationComplete: false, blocker: "AUTHORITATIVE_HISTORY_RANGE_EVENT_ABI_CANONICALITY_AND_REGISTRY_PROOF_REQUIRED" };
}

function offline() {
  return { schema: "surge-credit-l-observation/v1", chainId: CHAIN_ID, provisional: true, offline: true, observedAt: null,
    reads: { ...counts(), transportCalls: 0 },
    readAccounting: "attempted counts validated observation operations (including blocked indexer attempts); transportCalls counts actual injected invocations, capped globally",
    readResults: [], loans: [], indexer: null, runtimeFacts: [],
    baseLoanReadsComplete: false, auctionReadPlanComplete: false, loanReadPlan: [],
    baseLoanStateComplete: false, indexerEnumerationComplete: false, bitcoinBackingComplete: false, settlementValuationComplete: false,
    classSemantics: { triggerClass: "L", exact: false }, coverage: { complete: false },
    onFire: { economics: false, keylessFixedPinFork: false, alert: false }, dispatchEnabled: false,
    routePositive: "unknown", executableNow: "unknown", blockers: ["CORE_LOAN_HEALTH_AUTHORITY_AUCTION_AND_BTC_SETTLEMENT_SEMANTICS_UNQUALIFIED"] };
}
async function observe(options = {}) {
  const result = offline();
  // Decode only bytes explicitly provided by the caller, never archive paths.
  for (const runtime of options.runtimes || []) result.runtimeFacts.push(decodeRuntime(runtime));
  if (typeof options.transport !== "function") return result;
  const input = structuredClone(options.input || {}), nowMs = options.nowMs ?? Date.now();
  const cap = options.maxReads ?? 256; let pinValid = false;
  const read = async (id, descriptor, validate) => {
    if (result.reads.transportCalls >= cap) { result.reads.truncated = true; throw new ObservationFailure("READ_CAP"); }
    result.reads.attempted++;
    try {
      result.reads.transportCalls++;
      const value = await options.transport({ ...descriptor, chainId: CHAIN_ID, pin: structuredClone(input.pin) });
      const output = validate(value); result.reads.succeeded++; result.readResults.push({ id, status: "SUCCESS", kind: descriptor.kind }); return output;
    } catch (error) {
      result.reads.failed++; if (!knownFailure(error)) result.reads.unclassifiedFailures++;
      result.readResults.push({ id, status: "FAILED", kind: descriptor.kind, failure: failure(error) }); throw error;
    }
  };
  const pinCheck = id => read(id, { kind: "CANONICAL_PIN" }, value => {
    need(value && value.chainId === CHAIN_ID && value.number === input.pin.number && value.hash?.toLowerCase() === input.pin.hash.toLowerCase()
      && value.timestamp === input.pin.timestamp && value.canonical === true, "PIN_DRIFT");
  });
  try {
    need(input.chainId === CHAIN_ID && input.pin && hash(input.pin.hash) && Number.isSafeInteger(input.pin.number) && input.pin.number >= 0
      && Number.isSafeInteger(input.pin.timestamp) && input.pin.timestamp > 0 && input.pin.finality === "finalized"
      && nowMs / 1000 - input.pin.timestamp <= 900 && input.pin.timestamp <= nowMs / 1000 + 60
      && Number.isSafeInteger(cap) && cap > 0 && cap <= 1024, "PIN_INVALID");
    await pinCheck("pin.before"); pinValid = true; result.offline = false;
    need(input.snapshot?.chainId === CHAIN_ID && hash(input.snapshot.blockHash)
      && input.snapshot.blockHash.toLowerCase() === input.pin.hash.toLowerCase(), "SNAPSHOT_DRIFT");
    result.indexer = await collectLoanPages({ ...input.indexer, snapshot: input.snapshot,
      readPage: request => {
        need(result.reads.transportCalls < cap, "READ_CAP"); result.reads.transportCalls++;
        return options.transport({ kind: "INDEXER_PAGE", ...request, pin: structuredClone(input.pin) });
      } });
    for (const key of ["attempted", "succeeded", "failed", "unclassifiedFailures"]) result.reads[key] += result.indexer.reads[key];
    result.reads.truncated ||= result.indexer.reads.truncated || result.indexer.failures.includes("READ_CAP");
    result.readResults.push(...result.indexer.readResults);
    result.indexerEnumerationComplete = result.indexer.complete;
    const plans = input.loanReads || [];
    need(Array.isArray(plans) && plans.length <= 1000, "LOAN_PLAN_INCOMPLETE");
    const loanIds = result.indexer.loans.map(loan => loan.id), seen = new Set();
    result.loanReadPlan = loanIds.map(loanId => ({ loanId, loanStateStatus: "NOT_REQUESTED", auctionStateStatus: "NOT_REQUESTED" }));
    for (const descriptor of plans) {
      need(descriptor && idText(descriptor.loanId) && loanIds.includes(descriptor.loanId) && ["LOAN_STATE", "AUCTION_STATE"].includes(descriptor.kind)
        && address(descriptor.to) && typeof descriptor.data === "string" && /^0x(?:[0-9a-f]{2}){4,16384}$/i.test(descriptor.data)
        && hash(descriptor.runtimeKeccak256) && Number.isSafeInteger(descriptor.entryPC) && descriptor.entryPC >= 0, "DESCRIPTOR_UNQUALIFIED");
      const key = `${descriptor.loanId}|${descriptor.kind}`; need(!seen.has(key), "DESCRIPTOR_UNQUALIFIED"); seen.add(key);
      const fact = result.runtimeFacts.find(fact => fact.commitments.codeKeccak256.toLowerCase() === descriptor.runtimeKeccak256.toLowerCase());
      need(fact && (fact.dispatcher.some(entry => entry.validJumpdest && entry.selector === descriptor.data.slice(0, 10).toLowerCase() && entry.entryPC === descriptor.entryPC)
        || fact.explicitEntries.some(entry => entry.selector === descriptor.data.slice(0, 10).toLowerCase() && entry.pc === descriptor.entryPC)), "DESCRIPTOR_UNQUALIFIED");
      const planned = result.loanReadPlan.find(row => row.loanId === descriptor.loanId);
      const statusKey = descriptor.kind === "LOAN_STATE" ? "loanStateStatus" : "auctionStateStatus";
      try {
        const raw = await read(key, { kind: descriptor.kind, loanId: descriptor.loanId, to: descriptor.to, data: descriptor.data }, value => {
          need(value && value.chainId === CHAIN_ID && value.blockHash?.toLowerCase() === input.pin.hash.toLowerCase()
            && value.runtimeKeccak256?.toLowerCase() === descriptor.runtimeKeccak256.toLowerCase()
            && typeof value.raw === "string" && /^0x(?:[0-9a-f]{2})+$/i.test(value.raw) && value.raw.length <= 131074, "RESULT_INVALID");
          return value.raw;
        });
        result.loans.push({ loanId: descriptor.loanId, kind: descriptor.kind, raw, semantics: "UNRESOLVED_NO_TUPLE_INVENTED",
          loanIdAssociation: "PARENT_DESCRIPTOR_NOT_ABI_VERIFIED" });
        planned[statusKey] = "READ_SUCCESS_SEMANTICS_UNQUALIFIED";
      } catch (error) { planned[statusKey] = failure(error) === "READ_CAP" ? "TRUNCATED" : "FAILED"; result.blockers.push(failure(error)); }
    }
    // Even successful raw getters do not supply an ABI/health/authority formula.
    result.baseLoanReadsComplete = loanIds.length > 0 && loanIds.every(id => result.loans.some(row => row.loanId === id && row.kind === "LOAN_STATE"));
    result.auctionReadPlanComplete = loanIds.length > 0 && loanIds.every(id => result.loans.some(row => row.loanId === id && row.kind === "AUCTION_STATE"));
    if (!result.baseLoanReadsComplete || !result.auctionReadPlanComplete) result.blockers.push("LOAN_OR_AUCTION_READ_PLAN_INCOMPLETE");
    result.reconciliation = reconcileLoanIds({ ...input.reconciliation, indexerIds: loanIds });
    result.bitcoinBalanceAddresses = result.indexer.balanceAddresses;
    result.missingBitcoinEvidence = ["UTXO_SCRIPT_OWNERSHIP_AND_SPEND_PROOFS", "BITCOIN_BLOCKHASH_CONFIRMATIONS_AND_REORG_PROOF", "OPERATOR_DELIVERY_AND_TSN_SETTLEMENT_PROOF"];
    result.blockers.push("BITCOIN_BACKING_AND_SETTLEMENT_VERIFIERS_UNIMPLEMENTED");
  } catch (error) { result.blockers.push(failure(error)); }
  if (pinValid) {
    try {
      await pinCheck("pin.after");
      result.pin = { number: input.pin.number, hash: input.pin.hash, timestamp: input.pin.timestamp, finality: input.pin.finality };
      result.observedAt = new Date(nowMs).toISOString();
    }
    catch (_) { result.indexerEnumerationComplete = false; result.baseLoanReadsComplete = false; result.blockers.push("PIN_DRIFT"); }
  }
  result.blockers = [...new Set(result.blockers)];
  return result;
}
function main(argv = process.argv.slice(2)) {
  if (argv.length && (argv.length !== 1 || argv[0] !== "--check")) { process.stderr.write("usage: scan-surge-credit-l.js [--check] (offline; explicit injected API only)\n"); process.exitCode = 1; return; }
  process.stdout.write(`${JSON.stringify(offline(), null, 2)}\n`);
}
module.exports = { observe, collectLoanPages, reconcileLoanIds, offline, main, ObservationFailure };
if (require.main === module) main();
