#!/usr/bin/env node
// batch24-across-spoke-selectorwalk.live.js
// READ-ONLY bounded selector walk over the live Across ETH SpokePool impl.
// Every call is eth_call (node-side static simulation) at the finalized pin; no state mutation,
// no signing, no broadcast. Merges results into the decode artifact.
"use strict";
const fs = require("fs"), path = require("path");
const { loadRpcUrls, rpcCall, rpcEthCallOutcome } = require("./shared-rpc");
const { providerFamily, providerCapabilityRank } = require("./lib/rpc-provider-reliability");

const PROXY = "0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5";
const CAP = path.join(__dirname, "across-spoke-decode-step2.live.json");
const ART = path.join(__dirname, "..", "reports/raw/fast/across-spoke-decode-r2.json");

async function pickFamilies(n) {
  const urls = loadRpcUrls({ maxCandidates: 64 });
  const byFam = new Map();
  for (const u of urls) { const f = providerFamily(u) || "host"; if (!byFam.has(f)) byFam.set(f, []); byFam.get(f).push(u); }
  const order = [...byFam.entries()].map(([f, l]) => ({ f, url: l.sort((a, b) => providerCapabilityRank(a) - providerCapabilityRank(b))[0] }))
    .sort((a, b) => providerCapabilityRank(a.url) - providerCapabilityRank(b.url));
  const live = [];
  for (const e of order) {
    const cid = await rpcCall(e.url, "eth_chainId", [], 6000);
    if (cid === "0x1") live.push(e);
    if (live.length >= n) break;
  }
  return live;
}

(async () => {
  const cap = JSON.parse(fs.readFileSync(CAP, "utf8"));
  const art = JSON.parse(fs.readFileSync(ART, "utf8"));
  const pin = cap.pin.number;
  const fams = await pickFamilies(2);
  if (fams.length < 1) throw new Error("NO_RPC");

  // build selector universe: aligned dispatcher + full checkout ETH ABI (all dispatched)
  const ethPath = path.join(__dirname, "..", "targets/across-contracts/out/Ethereum_SpokePool.sol/Ethereum_SpokePool.json");
  const eth = JSON.parse(fs.readFileSync(ethPath, "utf8"));
  const abiSel = new Map();
  for (const [sig, sel] of Object.entries(eth.methodIdentifiers)) abiSel.set("0x" + sel.toLowerCase(), sig);
  const dispatcher = art.selectorSpace.dispatcherSelectors.map(r => r.selector);
  const universe = [...new Set([...dispatcher, ...abiSel.keys()])];

  const rows = [];
  for (const sel of universe) {
    const out = await rpcEthCallOutcome(fams[0].url, [{ to: PROXY, data: sel }, pin], 10000);
    const known = abiSel.get(sel) || null;
    const inDispatcher = dispatcher.includes(sel);
    let klass;
    if (out.kind === "success") klass = out.result === "0x" ? "VIEW_RETURN_EMPTY" : "VIEW_RETURN_DATA";
    else if (out.kind === "revert") klass = known && !known.endsWith("()") ? "REVERT_NEEDS_ARGS_OR_GUARD" : "REVERT";
    else klass = "INCOMPLETE_UNKNOWN";
    rows.push({ selector: sel, knownSignature: known, inLiveDispatcher: inDispatcher, inCheckoutAbi: !!known, outcome: out.kind, classification: klass, returnBytes: out.kind === "success" ? (out.result.length - 2) / 2 : null });
    await new Promise(r => setTimeout(r, 60));
  }

  // two-family agreement spot-check on the extra (live-only) selectors + a few views
  const extras = rows.filter(r => !r.inCheckoutAbi).map(r => r.selector);
  const spot = [...new Set([...extras, "0x8da5cb5b", "0xfc8a584f", "0x3659cfe6"])];
  const agreement = {};
  for (const sel of spot) {
    const a = await rpcEthCallOutcome(fams[0].url, [{ to: PROXY, data: sel }, pin], 10000);
    const b = fams[1] ? await rpcEthCallOutcome(fams[1].url, [{ to: PROXY, data: sel }, pin], 10000) : null;
    agreement[sel] = { kindA: a.kind, kindB: b ? b.kind : null, agree: b ? a.kind === b.kind : null };
    await new Promise(r => setTimeout(r, 60));
  }

  const summary = {
    pin,
    proxyCalls: rows.length,
    familiesUsed: fams.length,
    outcomes: rows.reduce((acc, r) => (acc[r.outcome] = (acc[r.outcome] || 0) + 1, acc), {}),
    unknownSelectorRows: rows.filter(r => !r.inCheckoutAbi).map(r => ({ selector: r.selector, outcome: r.outcome, classification: r.classification, returnBytes: r.returnBytes })),
    twoFamilyAgreement: agreement,
  };
  art.selectorWalk = { generatedAt: new Date().toISOString(), ...summary, rows };
  fs.writeFileSync(ART, JSON.stringify(art, null, 2) + "\n");

  const extraRows = rows.filter(r => !r.inCheckoutAbi);
  console.log(JSON.stringify({ pin, selectorRows: rows.length, outcomes: summary.outcomes, extras: extraRows, agreement }, null, 2));
})().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
