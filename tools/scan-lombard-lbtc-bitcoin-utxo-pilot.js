#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const RAW_REL = "reports/raw/fast/lombard-lbtc-bitcoin-utxo-pilot.json";
const REPORT_REL = "reports/lombard-lbtc-bitcoin-utxo-pilot-triage.md";
const HANDOFF_REL = "coordination/handoffs/2026-07-11-coordinator-lombard-step10-handoff.md";
const CLASSIFICATION = "INCOMPLETE/WATCH — PUBLIC CURRENT-UNSPENT PILOT, HISTORICAL UTXO/CUSTODY/BACKING UNVERIFIED";
const POR_PROXY = "0xe7ebc588f4ec9297d9867ad75a9b5d86848c8018";
const EXPECTED_IMPLEMENTATION = "0x0bb606e85c7f25d07aef61928c7b25c3c54470cc";
const EXPECTED_LIST_LENGTH = 28973;
const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const MAX_BYTES = 1_000_000;
const TIMEOUT_MS = 10_000;
const WALL_MS = 180_000;
const MAX_REQUESTS = 360;
const MAX_SAMPLE = 20;
const MAX_UTXO_VERIFY = 100;
const CONFIRMATIONS = 6;

// Hardcoded auth-free, read-only fallbacks. Their identities never enter generated artifacts.
const BASE_ENDPOINTS = [
  { label: "public-fallback-a", url: "https://mainnet.base.org" },
  { label: "public-fallback-b", url: "https://base-rpc.publicnode.com" },
];
const PRIMARY = { label: "public-primary", url: "https://mempool.space/api" };
const SECONDARY = { label: "public-secondary", url: "https://blockchain.info" };
const SECONDARY_INDEX = { label: "public-secondary", url: "https://api.blockchain.info/haskoin-store/btc" };

const started = Date.now();
const net = { requests: 0, successes: 0, failures: 0, responseSizeBlocks: 0, normalizedFailures: {} };
const sensitive = { addresses: new Set(), txids: new Set(), outpoints: new Set() };
let rpcId = 1;

function sha256(x) { return crypto.createHash("sha256").update(x).digest("hex"); }
function stable(v) { if (Array.isArray(v)) return v.map(stable); if (v && typeof v === "object") { const o = {}; for (const k of Object.keys(v).sort()) o[k] = stable(v[k]); return o; } return v; }
function serialize(v) { return JSON.stringify(stable(v), null, 2) + "\n"; }
function inc(o, k) { o[k] = (o[k] || 0) + 1; }
function normalizeError(e) { const s = `${e?.name || ""} ${e?.message || e || ""}`.toLowerCase(); if (s.includes("wall-limit")) return "wall-time-limit"; if (s.includes("request-limit")) return "request-limit"; if (s.includes("abort") || s.includes("timeout")) return "timeout"; if (s.includes("size-limit")) return "response-size-limit"; if (s.includes("http-status")) return "http-status"; if (s.includes("rpc-error")) return "rpc-error"; if (s.includes("network-identity")) return "network-identity-mismatch"; if (s.includes("decode") || s.includes("invalid")) return "validation-rejected"; if (s.includes("json")) return "invalid-json"; return "transport-error"; }
function budget() { if (net.requests >= MAX_REQUESTS) throw new Error("request-limit"); if (Date.now() - started >= WALL_MS) throw new Error("wall-limit"); }

async function requestJson(url, options = {}, allow404Empty = false, parseJson = true) {
  budget(); net.requests++;
  const ctrl = new AbortController(), remaining = Math.max(1, WALL_MS - (Date.now() - started));
  const timer = setTimeout(() => ctrl.abort(), Math.min(TIMEOUT_MS, remaining));
  try {
    const response = await fetch(url, { ...options, signal: ctrl.signal });
    if (allow404Empty && response.status === 404) { net.successes++; return []; }
    if (!response.ok) throw new Error("http-status");
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > MAX_BYTES) { net.responseSizeBlocks++; throw new Error("size-limit"); }
    if (!response.body) throw new Error("transport-error");
    const reader = response.body.getReader(), chunks = []; let total = 0;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) { net.responseSizeBlocks++; await reader.cancel(); ctrl.abort(); throw new Error("size-limit"); }
      chunks.push(Buffer.from(value));
    }
    const text = Buffer.concat(chunks, total).toString("utf8");
    net.successes++; return parseJson ? JSON.parse(text) : text;
  } catch (e) {
    net.failures++; const errorClass = normalizeError(e); inc(net.normalizedFailures, errorClass);
    throw Object.assign(new Error(errorClass), { errorClass });
  } finally { clearTimeout(timer); }
}

async function requestText(url) {
  const value = await requestJson(url, { headers: { accept: "text/plain" } }, false, false);
  return typeof value === "string" || typeof value === "number" ? String(value) : value;
}
async function rpc(endpoint, method, params) { const j = await requestJson(endpoint.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }) }); if (j?.error || !("result" in j)) throw Object.assign(new Error("rpc-error"), { errorClass: "rpc-error" }); return j.result; }
function strip0x(x) { if (typeof x !== "string" || !/^0x[0-9a-fA-F]*$/.test(x)) throw new Error("decode-invalid-hex"); return x.slice(2); }
function uintWord(hex, i = 0) { const h = strip0x(hex), at = i * 64; if (at + 64 > h.length) throw new Error("decode-word"); return BigInt("0x" + h.slice(at, at + 64)); }
function word(n) { return BigInt(n).toString(16).padStart(64, "0"); }
function addressFromSlot(x) { const h = strip0x(x).padStart(64, "0"), a = h.slice(-40); return /^0{40}$/.test(a) ? null : "0x" + a.toLowerCase(); }
function rootOffsets(hex, count) { const h = strip0x(hex); if (h.length < count * 64) throw new Error("decode-root"); return { h, offsets: Array.from({ length: count }, (_, i) => Number(uintWord("0x" + h, i))) }; }
function dynamicBytes(h, byteOffset) { if (!Number.isSafeInteger(byteOffset) || byteOffset < 0 || (byteOffset + 32) * 2 > h.length) throw new Error("decode-offset"); const n = Number(BigInt("0x" + h.slice(byteOffset * 2, byteOffset * 2 + 64))); if (!Number.isSafeInteger(n) || (byteOffset + 32 + n) * 2 > h.length) throw new Error("decode-length"); return Buffer.from(h.slice((byteOffset + 32) * 2, (byteOffset + 32 + n) * 2), "hex"); }
function stringArray(h, start, max) { if ((start + 32) * 2 > h.length) throw new Error("decode-array"); const n = Number(BigInt("0x" + h.slice(start * 2, start * 2 + 64))); if (!Number.isSafeInteger(n) || n > max) throw new Error("decode-count"); const tuple = start + 32, out = []; for (let i = 0; i < n; i++) { const at = tuple + i * 32; const off = Number(BigInt("0x" + h.slice(at * 2, at * 2 + 64))); const b = dynamicBytes(h, tuple + off), s = b.toString("utf8"); if (!Buffer.from(s).equals(b)) throw new Error("decode-utf8"); out.push(s); } return out; }
function decodeSingleAddressPage(hex) { const { h, offsets } = rootOffsets(hex, 4), addresses = stringArray(h, offsets[0], 1); if (addresses.length !== 1 || !addresses[0] || addresses[0].length > 100) throw new Error("decode-address"); return addresses[0]; }
function sampleIndices(length) { if (!Number.isSafeInteger(length) || length <= 0) return []; const fractions = [0,.05,.1,.15,.2,.25,.3,.35,.4,.45,.5,.55,.6,.65,.7,.75,.8,.85,.925,1]; const out = [...new Set(fractions.map(f => Math.floor((length - 1) * f)))]; return out.slice(0, MAX_SAMPLE); }
function reverseHex(h) { return Buffer.from(h, "hex").reverse().toString("hex"); }
function txidCandidates(row) { const out = []; if (/^[0-9a-fA-F]{64}$/.test(row?.tx_hash_big_endian || "")) out.push(row.tx_hash_big_endian.toLowerCase()); if (/^[0-9a-fA-F]{64}$/.test(row?.tx_hash || "")) { out.push(row.tx_hash.toLowerCase(), reverseHex(row.tx_hash.toLowerCase())); } return new Set(out); }
function safeInt(x) { return Number.isSafeInteger(x) && x >= 0; }

async function selectBase() {
  const failures = [];
  for (const endpoint of BASE_ENDPOINTS) {
    try {
      const chainId = Number(BigInt(await rpc(endpoint, "eth_chainId", []))); if (chainId !== 8453) throw new Error("network-identity");
      const numberHex = await rpc(endpoint, "eth_blockNumber", []), block = await rpc(endpoint, "eth_getBlockByNumber", [numberHex, false]);
      if (!block?.hash || block.number !== numberHex) throw new Error("invalid-block");
      return { endpoint, chainId, numberHex, block, failures };
    } catch (e) { failures.push(e.errorClass || normalizeError(e)); }
  }
  return { endpoint: null, failures };
}

async function scanBase() {
  const selected = await selectBase();
  const out = { chainId: 8453, networkIdentityStatus: selected.endpoint ? "verified" : "unverified-no-state-promotion", providerLabel: selected.endpoint?.label || null, resolutionFailureClasses: selected.failures, fixedBlock: null, expectedProxy: POR_PROXY, expectedImplementation: EXPECTED_IMPLEMENTATION, observedImplementation: null, proxyImplementationMatch: false, expectedListLength: EXPECTED_LIST_LENGTH, observedListLength: null, listLengthMatch: false, sampleStrategy: "deterministic-stratified-max-20-across-start-quartiles-middle-end", sampleRanges: [], sampleCount: 0, sampleCoveragePct: 0, wholeSampleCommitmentSha256: null, exactAddressesPersisted: false, ready: false };
  if (!selected.endpoint) return { out, addresses: [], indices: [] };
  let e = selected.endpoint; const b = selected.block;
  out.fixedBlock = { number: Number(BigInt(selected.numberHex)), hash: b.hash, timestampSeconds: Number(BigInt(b.timestamp)), stable: false };
  const read = async (method, params) => {
    try { return await rpc(e, method, params); }
    catch (first) {
      for (const candidate of BASE_ENDPOINTS) {
        if (candidate === e) continue;
        try {
          const chainId = Number(BigInt(await rpc(candidate, "eth_chainId", []))); if (chainId !== 8453) throw new Error("network-identity");
          const fixed = await rpc(candidate, "eth_getBlockByNumber", [selected.numberHex, false]); if (fixed?.hash !== b.hash) throw new Error("invalid-block");
          const value = await rpc(candidate, method, params); e = candidate; out.providerLabel = "public-fallback-mixed"; return value;
        } catch (_) { /* continue to another hardcoded fallback */ }
      }
      throw first;
    }
  };
  try {
    const proxyCode = await read("eth_getCode", [POR_PROXY, selected.numberHex]);
    const impl = addressFromSlot(await read("eth_getStorageAt", [POR_PROXY, IMPLEMENTATION_SLOT, selected.numberHex]));
    const implCode = impl ? await read("eth_getCode", [impl, selected.numberHex]) : "0x";
    out.observedImplementation = impl; out.proxyImplementationMatch = strip0x(proxyCode).length > 0 && strip0x(implCode).length > 0 && impl === EXPECTED_IMPLEMENTATION;
    const length = uintWord(await read("eth_call", [{ to: POR_PROXY, data: "0x4f20b888" }, selected.numberHex]));
    if (length > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("decode-list-length");
    out.observedListLength = Number(length); out.listLengthMatch = out.observedListLength === EXPECTED_LIST_LENGTH;
    if (!out.proxyImplementationMatch || !out.listLengthMatch) return { out, addresses: [], indices: [] };
    const indices = sampleIndices(out.observedListLength), addresses = [];
    for (const index of indices) {
      const data = "0x391e9474" + word(index) + word(index);
      const address = decodeSingleAddressPage(await read("eth_call", [{ to: POR_PROXY, data }, selected.numberHex]));
      addresses.push(address); sensitive.addresses.add(address);
    }
    if (new Set(addresses).size !== addresses.length) throw new Error("invalid-duplicate-sample-address");
    out.sampleRanges = indices.map(String); out.sampleCount = addresses.length; out.sampleCoveragePct = Number((100 * addresses.length / out.observedListLength).toFixed(8));
    out.wholeSampleCommitmentSha256 = sha256(Buffer.from("lombard-step10-whole-sample-v1\0" + indices.map((x, i) => `${x}:${addresses[i]}`).join("\n")));
    const finalBlock = await read("eth_getBlockByNumber", [selected.numberHex, false]);
    out.fixedBlock.stable = finalBlock?.hash === b.hash;
    out.ready = addresses.length === indices.length && addresses.length > 0 && out.fixedBlock.stable;
    return { out, addresses, indices };
  } catch (e) { out.failureClass = e.errorClass || normalizeError(e); return { out, addresses: [], indices: [] }; }
}

async function primaryHeight() { const x = await requestText(`${PRIMARY.url}/blocks/tip/height`); const n = Number(x); if (!safeInt(n)) throw new Error("invalid-tip"); return n; }
async function primaryBlockHash(height) { const x = await requestText(`${PRIMARY.url}/block-height/${height}`); if (typeof x !== "string" || !/^[0-9a-fA-F]{64}$/.test(x)) throw new Error("invalid-block-hash"); return x.toLowerCase(); }
async function secondaryTip() { const x = await requestJson(`${SECONDARY.url}/latestblock`); if (!safeInt(x?.height) || !/^[0-9a-fA-F]{64}$/.test(x?.hash || "")) throw new Error("invalid-tip"); return { height: x.height, hash: x.hash.toLowerCase() }; }
async function secondaryBlockHash(height, expectedHash = null) { let last; const paths = [`block/height/${height}`, ...(expectedHash ? [`block/${expectedHash}`] : [])]; for (const suffix of paths) { for (let attempt = 0; attempt < 2; attempt++) { try { const x = await requestJson(`${SECONDARY_INDEX.url}/${suffix}`), row = Array.isArray(x) && x.length === 1 ? x[0] : x, h = row?.blockId || row?.hash; if (typeof h !== "string" || !/^[0-9a-fA-F]{64}$/.test(h) || (safeInt(row?.height) && row.height !== height)) throw new Error("invalid-block-hash"); return h.toLowerCase(); } catch (e) { last = e; if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 500)); } } } throw last; }

async function scanBitcoin(addresses) {
  const out = { primaryProviderLabel: PRIMARY.label, secondaryProviderLabel: SECONDARY.label, preTips: null, postTips: null, confirmationDepth: CONFIRMATIONS, selectedBlock: null, selectedBlockStability: "unknown-post-check-incomplete", resultName: "current-unspent-at-observation-with-creation-height-le-anchor", historicalBalanceClaimed: false, addressQueryCoverage: { requested: addresses.length, primaryComplete: 0, secondaryComplete: 0 }, utxos: { returned: 0, retained: 0, primaryVerifiedUtxos: 0, independentlyCrosscheckedUtxos: 0, actualCrossProviderConflicts: 0, crosscheckUnavailable: 0, primaryVerificationFailures: 0, malformedResponseFailures: 0, verificationOrCrosscheckIncomplete: false, verificationCap: MAX_UTXO_VERIFY, capExceeded: false }, aggregate: { completenessStatus: "unknown-incomplete", satoshis: null, lowerBoundContributorCount: 0, independentlyCrosscheckedPartialLowerBoundSatoshis: null }, extrapolationPerformed: false, ownershipVerified: false, custodyVerified: false, blockers: [] };
  if (!addresses.length) { out.blockers.push("base-registry-sample-unavailable"); return out; }
  let prePrimary, preSecondary, anchor, anchorHash;
  try {
    prePrimary = await primaryHeight(); preSecondary = await secondaryTip(); out.preTips = { primary: prePrimary, secondary: preSecondary.height };
    anchor = Math.min(prePrimary, preSecondary.height) - CONFIRMATIONS; if (!safeInt(anchor)) throw new Error("invalid-anchor");
    const pHash = await primaryBlockHash(anchor), sHash = await secondaryBlockHash(anchor, pHash); if (pHash !== sHash) throw new Error("invalid-anchor-disagreement");
    anchorHash = pHash; out.selectedBlock = { height: anchor, hash: anchorHash, independentlyVerified: true };
  } catch (e) {
    out.blockers.push(`anchor:${e.errorClass || normalizeError(e)}`);
    out.utxos.verificationOrCrosscheckIncomplete = true;
    out.blockers.push("current-run-anchor-unavailable-no-address-or-utxo-promotion");
    return out;
  }

  const retained = [], secondaryRows = new Map(); let rowsComplete = true;
  for (const address of addresses) {
    let primaryRows;
    try {
      primaryRows = await requestJson(`${PRIMARY.url}/address/${encodeURIComponent(address)}/utxo`);
      if (!Array.isArray(primaryRows)) throw new Error("invalid-utxo-list"); out.addressQueryCoverage.primaryComplete++;
      const local = new Set();
      for (const u of primaryRows) {
        if (!/^[0-9a-fA-F]{64}$/.test(u?.txid || "") || !safeInt(u?.vout) || !safeInt(u?.value) || typeof u?.status?.confirmed !== "boolean") throw new Error("invalid-utxo-row");
        const txid = u.txid.toLowerCase(), key = `${txid}:${u.vout}`; if (local.has(key)) throw new Error("invalid-duplicate-utxo"); local.add(key); sensitive.txids.add(txid); sensitive.outpoints.add(key); out.utxos.returned++;
        if (u.status.confirmed && safeInt(u.status.block_height) && u.status.block_height <= anchor) retained.push({ address, txid, vout: u.vout, value: u.value, status: u.status });
      }
    } catch (_) { rowsComplete = false; out.blockers.push("primary-address-query-incomplete"); }
    try {
      const rows = await requestJson(`${SECONDARY.url}/unspent?active=${encodeURIComponent(address)}&limit=100`, {}, true);
      const arr = Array.isArray(rows) ? rows : rows?.unspent_outputs;
      if (!Array.isArray(arr) || arr.length >= 100) throw new Error("invalid-secondary-cap-or-shape");
      if (arr.some(x => txidCandidates(x).size === 0 || !safeInt(x?.tx_output_n) || !safeInt(x?.value))) { secondaryRows.set(address, { status: "malformed" }); throw new Error("invalid-secondary-row"); }
      secondaryRows.set(address, { status: "available", rows: arr }); out.addressQueryCoverage.secondaryComplete++;
    } catch (e) { rowsComplete = false; if (!secondaryRows.has(address)) secondaryRows.set(address, { status: e?.errorClass ? "unavailable" : "malformed" }); out.blockers.push("secondary-address-query-incomplete-or-capped"); }
  }
  out.utxos.retained = retained.length;
  if (retained.length > MAX_UTXO_VERIFY) { out.utxos.capExceeded = true; rowsComplete = false; out.blockers.push("global-utxo-verification-cap-exceeded"); }

  const primaryBlockCache = new Map([[anchor, anchorHash]]), secondaryBlockCache = new Map([[anchor, anchorHash]]); let independentlyCrosscheckedSats = 0;
  for (const u of retained.slice(0, MAX_UTXO_VERIFY)) {
    let category = null;
    try {
      let tx; try { tx = await requestJson(`${PRIMARY.url}/tx/${u.txid}`); } catch (_) { category = "primaryVerificationFailures"; throw _; }
      if (!tx || !Array.isArray(tx.vout) || !tx.status || typeof tx.status.confirmed !== "boolean" || !/^[0-9a-fA-F]{64}$/.test(tx.txid || "") || !safeInt(tx.status.block_height) || !/^[0-9a-fA-F]{64}$/.test(tx.status.block_hash || "")) { category = "malformedResponseFailures"; throw new Error("malformed-primary-tx"); }
      const output = tx.vout[u.vout]; if (!output || !safeInt(output.value)) { category = "malformedResponseFailures"; throw new Error("malformed-primary-output"); }
      if (tx.txid.toLowerCase() !== u.txid || output.value !== u.value || !tx.status.confirmed || tx.status.block_height !== u.status.block_height || tx.status.block_hash.toLowerCase() !== u.status.block_hash.toLowerCase()) { category = "primaryVerificationFailures"; throw new Error("primary-verification-mismatch"); }
      let outspend; try { outspend = await requestJson(`${PRIMARY.url}/tx/${u.txid}/outspend/${u.vout}`); } catch (_) { category = "primaryVerificationFailures"; throw _; }
      if (typeof outspend?.spent !== "boolean") { category = "malformedResponseFailures"; throw new Error("malformed-primary-outspend"); }
      if (outspend.spent !== false) { category = "primaryVerificationFailures"; throw new Error("primary-outspend-mismatch"); }
      try { if (!primaryBlockCache.has(u.status.block_height)) primaryBlockCache.set(u.status.block_height, await primaryBlockHash(u.status.block_height)); } catch (_) { category = "primaryVerificationFailures"; throw _; }
      if (primaryBlockCache.get(u.status.block_height) !== u.status.block_hash.toLowerCase()) { category = "primaryVerificationFailures"; throw new Error("primary-creation-chain-mismatch"); }
      out.utxos.primaryVerifiedUtxos++;

      const secondary = secondaryRows.get(u.address);
      if (!secondary || secondary.status === "unavailable") { category = "crosscheckUnavailable"; throw new Error("secondary-unavailable"); }
      if (secondary.status === "malformed") { category = "malformedResponseFailures"; throw new Error("secondary-malformed"); }
      const matching = secondary.rows.filter(x => txidCandidates(x).has(u.txid) && x.tx_output_n === u.vout && x.value === u.value);
      if (matching.length !== 1) { category = "actualCrossProviderConflicts"; throw new Error("secondary-unspent-conflict"); }
      let raw; try { raw = await requestJson(`${SECONDARY.url}/rawtx/${u.txid}?format=json`); } catch (_) { category = "crosscheckUnavailable"; throw _; }
      if (!raw || !Array.isArray(raw.out) || !/^[0-9a-fA-F]{64}$/.test(raw.hash || "") || !safeInt(raw.block_height)) { category = "malformedResponseFailures"; throw new Error("malformed-secondary-rawtx"); }
      const rawOut = raw.out[u.vout]; if (!rawOut || !safeInt(rawOut.value) || typeof rawOut.spent !== "boolean") { category = "malformedResponseFailures"; throw new Error("malformed-secondary-output"); }
      if (raw.hash.toLowerCase() !== u.txid || raw.block_height !== u.status.block_height || rawOut.value !== u.value || rawOut.spent !== false) { category = "actualCrossProviderConflicts"; throw new Error("secondary-rawtx-conflict"); }
      try { if (!secondaryBlockCache.has(u.status.block_height)) secondaryBlockCache.set(u.status.block_height, await secondaryBlockHash(u.status.block_height, u.status.block_hash)); } catch (e) { category = e?.errorClass ? "crosscheckUnavailable" : "malformedResponseFailures"; throw e; }
      if (secondaryBlockCache.get(u.status.block_height) !== u.status.block_hash.toLowerCase()) { category = "actualCrossProviderConflicts"; throw new Error("secondary-creation-chain-conflict"); }
      out.utxos.independentlyCrosscheckedUtxos++; independentlyCrosscheckedSats += u.value;
    } catch (_) { rowsComplete = false; out.utxos[category || "crosscheckUnavailable"]++; out.utxos.verificationOrCrosscheckIncomplete = true; out.blockers.push("utxo-verification-or-independent-crosscheck-incomplete"); }
  }

  try {
    const postPrimary = await primaryHeight(), postSecondary = await secondaryTip(), pHash = await primaryBlockHash(anchor), sHash = await secondaryBlockHash(anchor, anchorHash);
    out.postTips = { primary: postPrimary, secondary: postSecondary.height };
    out.selectedBlockStability = pHash === anchorHash && sHash === anchorHash && postPrimary >= anchor + CONFIRMATIONS && postSecondary.height >= anchor + CONFIRMATIONS ? "stable" : "unstable";
    if (out.selectedBlockStability !== "stable") { rowsComplete = false; out.blockers.push("selected-block-race-or-reorg-check-failed"); }
  } catch (_) { rowsComplete = false; out.selectedBlockStability = "unknown-post-check-incomplete"; out.blockers.push("post-tip-or-stability-check-incomplete"); }

  const complete = rowsComplete && out.addressQueryCoverage.primaryComplete === addresses.length && out.addressQueryCoverage.secondaryComplete === addresses.length && retained.length <= MAX_UTXO_VERIFY && out.utxos.primaryVerifiedUtxos === retained.length && out.utxos.independentlyCrosscheckedUtxos === retained.length && !out.utxos.verificationOrCrosscheckIncomplete && out.selectedBlockStability === "stable";
  out.aggregate = complete ? { completenessStatus: "complete-for-bounded-sample-current-unspent-only", satoshis: independentlyCrosscheckedSats, lowerBoundContributorCount: 0, independentlyCrosscheckedPartialLowerBoundSatoshis: null } : { completenessStatus: independentlyCrosscheckedSats > 0 ? "partial-lower-bound-for-bounded-sample-current-unspent-only" : "unknown-incomplete", satoshis: null, lowerBoundContributorCount: out.utxos.independentlyCrosscheckedUtxos, independentlyCrosscheckedPartialLowerBoundSatoshis: independentlyCrosscheckedSats > 0 ? independentlyCrosscheckedSats : null };
  if (!complete) out.blockers.push("bounded-sample-aggregate-incomplete-no-total-promotion");
  return out;
}

function report(raw) { const { metrics: m, base, bitcoin } = raw.currentRun; return ["# Lombard LBTC Step 10 — Bitcoin Current-Unspent Pilot","",`**Classification:** ${raw.classification}`,"","> This artifact contains current-run observations only. Bounded public read-only pilot; no exact Bitcoin addresses, transaction IDs, outpoints, scripts, per-entry rows, endpoint identities, raw errors, or response bodies are persisted.","",`Requests/successes/failures: ${m.requests}/${m.successes}/${m.failures}; duration=${m.scanDurationMs}ms.`,`Base chain=${m.baseChainId}; fixed block=${m.baseFixedBlock ?? "unknown"}; proxy/implementation match=${m.proxyImplementationMatch}; list length=${m.listLength ?? "unknown"}; expected-list match=${m.listLengthMatch}.`,`Sample ranges=${m.sampleRanges.join(", ") || "none"}; count=${m.sampleCount}; coverage=${m.sampleCoveragePct}%; whole-sample commitment=${base.wholeSampleCommitmentSha256 || "none"}.`,`Bitcoin pre tips=${JSON.stringify(m.preTips)}; post tips=${JSON.stringify(m.postTips)}; depth=${m.confirmationDepth}; selected height=${m.selectedHeight ?? "unknown"}; selected block stability=${m.selectedBlockStability}.`,`Address coverage primary/secondary/requested=${m.addressPrimaryComplete}/${m.addressSecondaryComplete}/${m.addressRequested}.`,`UTXOs returned=${m.utxosReturned}; retained=${m.utxosRetained}; primary verified=${m.primaryVerifiedUtxos}; independently crosschecked=${m.independentlyCrosscheckedUtxos}; actual conflicts=${m.actualCrossProviderConflicts}; crosscheck unavailable=${m.crosscheckUnavailable}; primary verification failures=${m.primaryVerificationFailures}; malformed responses=${m.malformedResponseFailures}; incomplete=${m.verificationOrCrosscheckIncomplete}; cap exceeded=${m.utxoCapExceeded}.`,`Result name: **${bitcoin.resultName}**. Completeness=${m.satoshisCompletenessStatus}; satoshis=${m.satoshis ?? "unknown"}; lower-bound contributors=${m.lowerBoundContributorCount}; independently crosschecked partial lower bound=${m.independentlyCrosscheckedPartialLowerBoundSatoshis ?? "none"}. Incomplete/conflict rows contribute zero.`,`extrapolationPerformed=false; ownershipVerified=false; custodyVerified=false; fullyReconciledBackingRows=0. No historical balance, exploit, insolvency, custody, or backing conclusion is claimed.`,"","## Blockers",...raw.blockers.map(x => `- ${x}`),"","## Required next step",raw.nextStep,"","## Closed gates","`routePositive=0`, `routeEvidenceStatus=unknown`, `evidenceComplete=false`, `closureEligible=false`, `executableNow=0`, `signedActionJustified=false`, `forkJustified=false`.",""].join("\n"); }
function handoff(raw) { const { metrics: m, bitcoin } = raw.currentRun; return ["# Coordinator Handoff — Lombard LBTC Step 10 — 2026-07-11","",`- Classification: **${raw.classification}**`,`- Current-run observations only; no carried-forward UTXO or lower-bound values.`,`- Requests/successes/failures=${m.requests}/${m.successes}/${m.failures}; duration=${m.scanDurationMs}ms.`,`- Base fixed block=${m.baseFixedBlock ?? "unknown"}; proxy/implementation match=${m.proxyImplementationMatch}; list=${m.listLength ?? "unknown"}; sample rows=${m.sampleCount}; coverage=${m.sampleCoveragePct}%.`,`- Anchor=${m.selectedHeight ?? "unknown"}; depth=${m.confirmationDepth}; stability=${m.selectedBlockStability}; address coverage=${m.addressPrimaryComplete}/${m.addressSecondaryComplete}/${m.addressRequested}.`,`- UTXOs returned/retained/primary-verified/independently-crosschecked=${m.utxosReturned}/${m.utxosRetained}/${m.primaryVerifiedUtxos}/${m.independentlyCrosscheckedUtxos}; actual conflicts=${m.actualCrossProviderConflicts}; unavailable=${m.crosscheckUnavailable}; primary failures=${m.primaryVerificationFailures}; malformed=${m.malformedResponseFailures}; incomplete=${m.verificationOrCrosscheckIncomplete}.`,`- ${bitcoin.resultName}; completeness=${m.satoshisCompletenessStatus}; total=${m.satoshis ?? "unknown"}; lower-bound contributors=${m.lowerBoundContributorCount}; independently crosschecked partial lower bound=${m.independentlyCrosscheckedPartialLowerBoundSatoshis ?? "none"}. Incomplete/conflict rows contribute zero.`,`- No exact Bitcoin addresses, txids, outpoints, scripts, per-entry data or linkage is persisted. No extrapolation, historical-balance, ownership, custody, backing, exploit, or insolvency claim is made.`,"","## Required next step","Obtain an archival Bitcoin node/indexer, the full registry, the published PoR verifier specification/test vectors, and Babylon active-stake/unbonding/transit/slashing joins. Explicit current-turn authorization is required before any private inventories are used.","","## Closed gates","`routePositive=0`, `routeEvidenceStatus=unknown`, `evidenceComplete=false`, `closureEligible=false`, `executableNow=0`, `signedActionJustified=false`, `forkJustified=false`.",""].join("\n"); }

async function main() {
  const baseScan = await scanBase(), bitcoin = await scanBitcoin(baseScan.addresses);
  const blockers = [...new Set([...(baseScan.out.ready ? [] : ["base-chain-proxy-implementation-list-or-sample-gate-incomplete"]), ...bitcoin.blockers, "current-unspent-observation-is-not-a-historical-balance-at-the-selected-height", "sample-is-bounded-nonstatistical-and-never-extrapolated", "bitcoin-address-membership-and-utxos-do-not-prove-ownership-custody-or-spend-control", "full-registry-historical-indexer-por-verifier-and-babylon-joins-unavailable"])].sort();
  const metrics = { requests: net.requests, successes: net.successes, failures: net.failures, normalizedFailures: net.normalizedFailures, responseSizeBlocks: net.responseSizeBlocks, scanDurationMs: Date.now() - started, baseChainId: 8453, baseFixedBlock: baseScan.out.fixedBlock?.number ?? null, proxyImplementationMatch: baseScan.out.proxyImplementationMatch, listLength: baseScan.out.observedListLength, listLengthMatch: baseScan.out.listLengthMatch, sampleRanges: baseScan.out.sampleRanges, sampleCount: baseScan.out.sampleCount, sampleCoveragePct: baseScan.out.sampleCoveragePct, preTips: bitcoin.preTips, postTips: bitcoin.postTips, confirmationDepth: CONFIRMATIONS, selectedHeight: bitcoin.selectedBlock?.height ?? null, selectedBlockStability: bitcoin.selectedBlockStability, addressRequested: bitcoin.addressQueryCoverage.requested, addressPrimaryComplete: bitcoin.addressQueryCoverage.primaryComplete, addressSecondaryComplete: bitcoin.addressQueryCoverage.secondaryComplete, utxosReturned: bitcoin.utxos.returned, utxosRetained: bitcoin.utxos.retained, primaryVerifiedUtxos: bitcoin.utxos.primaryVerifiedUtxos, independentlyCrosscheckedUtxos: bitcoin.utxos.independentlyCrosscheckedUtxos, actualCrossProviderConflicts: bitcoin.utxos.actualCrossProviderConflicts, crosscheckUnavailable: bitcoin.utxos.crosscheckUnavailable, primaryVerificationFailures: bitcoin.utxos.primaryVerificationFailures, malformedResponseFailures: bitcoin.utxos.malformedResponseFailures, verificationOrCrosscheckIncomplete: bitcoin.utxos.verificationOrCrosscheckIncomplete, utxoCapExceeded: bitcoin.utxos.capExceeded, satoshisCompletenessStatus: bitcoin.aggregate.completenessStatus, satoshis: bitcoin.aggregate.satoshis, lowerBoundContributorCount: bitcoin.aggregate.lowerBoundContributorCount, independentlyCrosscheckedPartialLowerBoundSatoshis: bitcoin.aggregate.independentlyCrosscheckedPartialLowerBoundSatoshis, extrapolationPerformed: false, ownershipVerified: false, custodyVerified: false, fullyReconciledBackingRows: 0 };
  const raw = { generatedAt: new Date().toISOString(), scanner: "tools/scan-lombard-lbtc-bitcoin-utxo-pilot.js", classification: CLASSIFICATION, limits: { responseSizeCapBytes: MAX_BYTES, requestTimeoutMs: TIMEOUT_MS, wallTimeoutMs: WALL_MS, requestCeiling: MAX_REQUESTS, sequentialCalls: true, sampleMaximum: MAX_SAMPLE, globalUtxoVerificationCap: MAX_UTXO_VERIFY, confirmationsBehindMinimumTip: CONFIRMATIONS }, currentRun: { base: baseScan.out, bitcoin, metrics }, blockers, dataMinimization: { exactBitcoinAddressesPersisted: false, txidsPersisted: false, outpointsPersisted: false, scriptsPersisted: false, perEntryRowsPersisted: false, perEntryCommitmentsPersisted: false, wholeSampleAggregateCommitmentAllowed: true, endpointUrlsOrDomainsPersisted: false, unsanitizedFailuresOrBodiesPersisted: false, priorObservationRetained: false }, conclusion: { exploitProven: false, insolvencyProven: false, historicalBalanceProven: false, ownershipVerified: false, custodyVerified: false, backingVerified: false, extrapolationPerformed: false, fullyReconciledBackingRows: 0, aggregatePromotion: false }, gates: { routePositive: 0, routeEvidenceStatus: "unknown", evidenceComplete: false, closureEligible: false, executableNow: 0, signedActionJustified: false, forkJustified: false }, safety: { publicReadOnlyNetworkOnly: true, privateEndpointInventoryRead: false, envFilesRead: false, secretsRead: false, keysRead: false, transactions: false, signing: false, wallets: false, mutations: false, forks: false, endpointLeakCheck: "passed", minimizationCheck: "passed" }, nextStep: "Use an archival Bitcoin node/indexer with the full registry, a published PoR verifier specification/test vectors, and Babylon active-stake/unbonding/transit/slashing joins. Explicit current-turn authorization is required before private inventories are used." };
  const rawText = serialize(raw), reportText = report(raw), handoffText = handoff(raw), outputs = [["raw", rawText], ["report", reportText], ["handoff", handoffText]];
  const endpointValues = [...BASE_ENDPOINTS.map(x => x.url), PRIMARY.url, SECONDARY.url, SECONDARY_INDEX.url], forbidden = [...endpointValues, ...endpointValues.map(x => new URL(x).hostname), "publicnode", "mempool", "blockchain.info", "esplora", "blockchain.com", "rawError", "responseBody", "requestHeaders"];
  for (const [name, text] of outputs) {
    const lower = text.toLowerCase(); if (forbidden.some(x => lower.includes(x.toLowerCase()))) throw new Error(`${name}-endpoint-leak`);
    for (const value of [...sensitive.addresses, ...sensitive.txids, ...sensitive.outpoints]) if (value && lower.includes(value.toLowerCase())) throw new Error(`${name}-sensitive-leak`);
    if (/"(?:address|txid|outpoint|script)"\s*:/.test(text)) throw new Error(`${name}-per-entry-field-leak`);
  }
  if (metrics.extrapolationPerformed || metrics.ownershipVerified || metrics.custodyVerified || metrics.fullyReconciledBackingRows !== 0 || raw.conclusion.aggregatePromotion) throw new Error("fail-closed-check");
  if (!["stable", "unstable", "unknown-post-check-incomplete"].includes(metrics.selectedBlockStability) || metrics.lowerBoundContributorCount !== metrics.independentlyCrosscheckedUtxos || (metrics.lowerBoundContributorCount === 0) !== (metrics.independentlyCrosscheckedPartialLowerBoundSatoshis === null)) throw new Error("taxonomy-check");
  if (bitcoin.selectedBlock && bitcoin.selectedBlock.height !== Math.min(bitcoin.preTips.primary, bitcoin.preTips.secondary) - CONFIRMATIONS) throw new Error("current-anchor-check");
  if (!bitcoin.selectedBlock && (metrics.selectedHeight !== null || metrics.utxosReturned !== 0 || metrics.utxosRetained !== 0 || metrics.primaryVerifiedUtxos !== 0 || metrics.independentlyCrosscheckedUtxos !== 0 || metrics.lowerBoundContributorCount !== 0 || metrics.independentlyCrosscheckedPartialLowerBoundSatoshis !== null)) throw new Error("current-run-stale-data-check");
  if (raw.gates.routePositive !== 0 || raw.gates.routeEvidenceStatus !== "unknown" || raw.gates.evidenceComplete || raw.gates.closureEligible || raw.gates.executableNow || raw.gates.signedActionJustified || raw.gates.forkJustified) throw new Error("gate-check");
  const atomic = (rel, data) => { const target = path.join(ROOT, rel), temp = `${target}.tmp-${process.pid}`; fs.writeFileSync(temp, data, "utf8"); fs.renameSync(temp, target); };
  atomic(RAW_REL, rawText); atomic(REPORT_REL, reportText); atomic(HANDOFF_REL, handoffText);
  process.stdout.write(`rawSha256=${sha256(rawText)} reportSha256=${sha256(reportText)} handoffSha256=${sha256(handoffText)} scannerSha256=${sha256(fs.readFileSync(__filename))} requests=${metrics.requests} successes=${metrics.successes} failures=${metrics.failures} baseBlock=${metrics.baseFixedBlock ?? "unknown"} proxyImplementationMatch=${metrics.proxyImplementationMatch} listLength=${metrics.listLength ?? "unknown"} listLengthMatch=${metrics.listLengthMatch} sampleCount=${metrics.sampleCount} coveragePct=${metrics.sampleCoveragePct} selectedHeight=${metrics.selectedHeight ?? "unknown"} selectedBlockStability=${metrics.selectedBlockStability} addressCoverage=${metrics.addressPrimaryComplete}/${metrics.addressSecondaryComplete}/${metrics.addressRequested} utxos=${metrics.utxosReturned}/${metrics.utxosRetained}/${metrics.primaryVerifiedUtxos}/${metrics.independentlyCrosscheckedUtxos} conflicts=${metrics.actualCrossProviderConflicts} unavailable=${metrics.crosscheckUnavailable} primaryFailures=${metrics.primaryVerificationFailures} malformed=${metrics.malformedResponseFailures} incomplete=${metrics.verificationOrCrosscheckIncomplete} contributors=${metrics.lowerBoundContributorCount} completeness=${metrics.satoshisCompletenessStatus} satoshis=${metrics.satoshis ?? "unknown"} independentLowerBound=${metrics.independentlyCrosscheckedPartialLowerBoundSatoshis ?? "none"} durationMs=${metrics.scanDurationMs} leakCheck=passed minimizationCheck=passed\n`);
}

main().catch(e => { const safe = /^(?:raw|report|handoff)-(?:endpoint|sensitive|per-entry-field)-leak$|^(?:fail-closed|gate|taxonomy|current-anchor|current-run-stale-data)-check$/.test(e?.message || "") ? e.message : normalizeError(e); process.stderr.write(`scan-lombard-lbtc-bitcoin-utxo-pilot failed: ${safe}\n`); process.exitCode = 1; });
