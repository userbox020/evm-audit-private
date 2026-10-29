#!/usr/bin/env node
// analyze-across-spoke-decode-step2.js
// Offline footprint + selector-space analysis for the live Across ETH SpokePool impl.
// Reads the live capture (tools/across-spoke-decode-step2.live.json) and the pinned
// checkout build artifacts (targets/across-contracts/out/**). No network.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { keccak256 } = require("./node_modules/ethers");

const ROOT = path.resolve(__dirname, "..");
const LIVE = path.join(__dirname, "across-spoke-decode-step2.live.json");
const OUT_DIR = path.join(ROOT, "targets/across-contracts/out");
const ART = path.join(ROOT, "reports/raw/fast/across-spoke-decode-r2.json");

function toHex(v) { return typeof v === "string" ? v : (v && v.object) ? v.object : null; }
function stripMeta(hex) {
  const b = Buffer.from(hex.replace(/^0x/, ""), "hex");
  if (b.length < 4) return { body: b, meta: false, metaLen: 0 };
  const n = b.readUInt16BE(b.length - 2);
  const start = b.length - 2 - n;
  if (start < 0) return { body: b, meta: false, metaLen: 0 };
  const tail = b.slice(start, start + 4);
  const isCbor = tail[0] === 0xa2 && tail[1] === 0x64 && tail[2] === 0x69 && tail[3] === 0x70;
  return isCbor ? { body: b.slice(0, start), meta: true, metaLen: n + 2, metaBytes: b.slice(start) }
                : { body: b, meta: false, metaLen: 0 };
}
function sha256(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }
function hex(buf) { return "0x" + buf.toString("hex"); }

// --- load live capture ---
const live = JSON.parse(fs.readFileSync(LIVE, "utf8"));
const liveImplHex = live.impl.code;
const liveS = stripMeta(liveImplHex);
const liveBody = liveS.body;

// --- load all checkout artifacts with runtime code ---
const artifacts = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.name.endsWith(".json")) {
      let j; try { j = JSON.parse(fs.readFileSync(full, "utf8")); } catch { continue; }
      const h = toHex(j.deployedBytecode);
      if (!h || h === "0x") continue;
      const s = stripMeta(h);
      artifacts.push({
        name: j.contractName || path.basename(dir),
        source: path.relative(ROOT, full).replace(/\\/g, "/"),
        body: s.body, bodyBytes: s.body.length, meta: s.meta, metaLen: s.metaLen,
        methodIdentifiers: j.methodIdentifiers || {},
        compiler: j.metadata && j.metadata.compiler && j.metadata.compiler.version,
        settings: j.metadata && j.metadata.settings,
      });
    }
  }
}
walk(OUT_DIR);

// --- match live against artifacts ---
function hamming(a, b) {
  const n = Math.min(a.length, b.length);
  let d = 0; const pos = [];
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) { d++; if (pos.length < 64) pos.push(i); }
  d += Math.abs(a.length - b.length);
  return { d, pos };
}
const scored = artifacts.map(a => {
  const exact = a.body.length === liveBody.length && a.body.equals(liveBody);
  const hm = hamming(a.body, liveBody);
  return { a, exact, hm };
}).sort((x, y) => x.hm.d - y.hm.d);

const best = scored[0];
const topMatches = scored.slice(0, 8).map(s => ({
  name: s.a.name, source: s.a.source, bodyBytes: s.a.bodyBytes,
  exactStripMatch: s.exact, hammingDiff: s.hm.d, diffPrefix: s.hm.pos.slice(0, 12),
}));

// --- classify the best candidate diff ---
function classifyDiff(a, b) {
  const n = Math.min(a.length, b.length);
  const diffs = [];
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) diffs.push(i);
  const lenDelta = b.length - a.length;
  const allZeroToNonzero = diffs.every(i => a[i] === 0x00 && b[i] !== 0x00);
  const allNonzero = diffs.every(i => a[i] !== 0x00 && b[i] !== 0x00);
  // contiguous 20-byte zero->addr spans
  let addrSpans = 0;
  let i = 0;
  while (i < diffs.length) {
    if (a[diffs[i]] === 0x00 && b[diffs[i]] !== 0x00) {
      let j = i;
      while (j + 1 < diffs.length && diffs[j + 1] === diffs[j] + 1 && a[diffs[j + 1]] === 0x00 && b[diffs[j + 1]] !== 0x00) j++;
      const span = diffs[j] - diffs[i] + 1;
      if (span >= 1 && span <= 20) addrSpans++;
      i = j + 1;
    } else i++;
  }
  const block32 = [];
  // find runs of >= 24 contiguous diffs (single 32B salt often shows as a contiguous run)
  let p = 0;
  while (p < diffs.length) {
    let q = p;
    while (q + 1 < diffs.length && diffs[q + 1] === diffs[q] + 1) q++;
    const span = diffs[q] - diffs[p] + 1;
    if (span >= 24) block32.push({ start: diffs[p], end: diffs[q], span });
    p = q + 1;
  }
  return { diffCount: diffs.length, lengthDelta: lenDelta, allZeroToNonzero, allNonzero, zeroToAddrSpans: addrSpans, contiguousBlocks: block32, firstDiffs: diffs.slice(0, 12) };
}

const bestIsSameLength = best.a.body.length === liveBody.length;
const diffClass = classifyDiff(best.a.body, liveBody);

// --- Exact match across all artifacts (any exact) ---
const anyExact = scored.filter(s => s.exact);

// --- selector-space extraction from live code (BYTE-ALIGNED only) ---
// Solidity dispatcher entry: DUP1 PUSH4 <sel> (0x80 0x63 xxxx xxxx) followed by EQ (0x14).
// Requiring an even character offset prevents unaligned nibble false positives.
const liveHex = liveBody.toString("hex");
const selSet = new Map();
const re = /63([0-9a-f]{8})14/g;
let m;
while ((m = re.exec(liveHex)) !== null) {
  if (m.index % 2 !== 0) continue;
  const sel = "0x" + m[1];
  if (!selSet.has(sel)) selSet.set(sel, { selector: sel, occurrences: 0, offsets: [] });
  const rec = selSet.get(sel);
  rec.occurrences++;
  if (rec.offsets.length < 6) rec.offsets.push((m.index) >> 1);
}
// selectors present in the code via alternate compare forms (e.g. PUSH4 sel SUB ... JUMPI)
const presentBytes = new Set();
const reAlt = /([0-9a-f]{8})/g;
for (let i = 0; i + 8 <= liveHex.length; i += 2) presentBytes.add("0x" + liveHex.slice(i, i + 8));

// --- build selector->signature dictionary from all checkout artifacts ---
const sigBySelector = new Map();
for (const a of artifacts) {
  for (const [sig, sel] of Object.entries(a.methodIdentifiers)) {
    const key = "0x" + sel.toLowerCase();
    if (!sigBySelector.has(key)) sigBySelector.set(key, new Set());
    sigBySelector.get(key).add(sig);
  }
}

const dispatcherSelectors = [...selSet.values()].map(r => ({
  selector: r.selector,
  occurrences: r.occurrences,
  knownSignatures: sigBySelector.has(r.selector) ? [...sigBySelector.get(r.selector)] : [],
}));
const unknownSelectors = dispatcherSelectors.filter(r => r.knownSignatures.length === 0).map(r => r.selector);

// --- Ethereum_SpokePool artifact method identifier count (checkout ABI) ---
const ethSpoke = artifacts.find(a => a.name === "Ethereum_SpokePool");

const out = {
  schema: "across-spoke-decode-r2/footprint-v1",
  generatedAt: new Date().toISOString(),
  pin: { number: live.pin.number, block: Number(BigInt(live.pin.number)), hash: live.pin.hash, tag: live.pin.tag, timestamp: Number(BigInt(live.pin.timestamp)) },
  liveImpl: {
    address: live.addresses.spokeImpl,
    runtimeBytes: live.impl.codeBytes,
    twoFamilyCodeAgree: live.impl.twoFamilyCodeAgree,
    runtimeSha256: live.impl.codeSha256,
    strippedBodyBytes: liveBody.length,
    metadataBytes: liveS.metaLen,
    metadataIsCbor: liveS.meta,
    bodySha256: sha256(liveBody),
  },
  checkout: {
    source: "targets/across-contracts (commit 9ffb2ab, @across-protocol/contracts 5.0.11)",
    compiler: ethSpoke ? ethSpoke.compiler : null,
    buildProfile: ethSpoke ? { optimizer: ethSpoke.settings && ethSpoke.settings.optimizer, evmVersion: ethSpoke.settings && ethSpoke.settings.evmVersion, viaIR: ethSpoke.settings && ethSpoke.settings.viaIR, bytecodeHash: ethSpoke.settings && ethSpoke.settings.metadata && ethSpoke.settings.metadata.bytecodeHash } : null,
    artifactCount: artifacts.length,
  },
  footprintVerdict: {
    anyExactStripMatch: anyExact.length > 0,
    exactMatchNames: anyExact.map(s => s.a.name),
    bestCandidate: best.a.name,
    bestCandidateBodyBytes: best.a.bodyBytes,
    lengthDelta: liveBody.length - best.a.body.length,
    hammingDiff: best.hm.d,
    diffClass,
    classification: best.hm.d === 0 ? "SOURCE_EQUIVALENT_EXACT" : (!bestIsSameLength ? "DIFFERENT_REVISION_OR_BUILD:length-delta" : (diffClass.allZeroToNonzero && diffClass.zeroToAddrSpans > 0 && diffClass.diffCount <= 80 ? "SOURCE_EQUIVALENT_IMMUTABLES" : "DIFFERENT_REVISION")),
  },
  topMatches,
  selectorSpace: {
    alignedDispatcherSelectorCount: dispatcherSelectors.length,
    knownSelectorCount: dispatcherSelectors.filter(r => r.knownSignatures.length > 0).length,
    unknownSelectors,
    extrasVsCheckoutEthSpokeAbi: ethSpoke
      ? dispatcherSelectors.filter(r => !Object.values(ethSpoke.methodIdentifiers).map(s => "0x" + s.toLowerCase()).includes(r.selector)).map(r => r.selector)
      : null,
    checkoutEthSpokeAbiSelectorsPresentInLiveBytes: ethSpoke
      ? Object.values(ethSpoke.methodIdentifiers).map(s => "0x" + s.toLowerCase()).filter(sel => presentBytes.has(sel)).length
      : null,
    checkoutEthSpokeAbiSelectorCount: ethSpoke ? Object.keys(ethSpoke.methodIdentifiers).length : null,
    dispatcherSelectors,
  },
  checkoutEthSpokeMethodIdentifierCount: ethSpoke ? Object.keys(ethSpoke.methodIdentifiers).length : null,
};

fs.mkdirSync(path.dirname(ART), { recursive: true });
fs.writeFileSync(ART, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify({
  liveRuntimeBytes: live.impl.codeBytes,
  liveStrippedBodyBytes: liveBody.length,
  bestCandidate: best.a.name,
  bestBodyBytes: best.a.bodyBytes,
  lengthDelta: liveBody.length - best.a.body.length,
  hammingDiff: best.hm.d,
  classification: out.footprintVerdict.classification,
  dispatcherSelectorCount: dispatcherSelectors.length,
  knownSelectors: out.selectorSpace.knownSelectorCount,
  unknownSelectors: unknownSelectors.length,
}, null, 2));
