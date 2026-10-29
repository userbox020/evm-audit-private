#!/usr/bin/env node
"use strict";
// Decode the batchHandleWithdrawals calls nested inside the 4 successful Safe txs
// that the log pass could not decode (outer selector = execTransaction). Read-only.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { loadRpcUrls, rpcCall } = require("./shared-rpc");
const { providerFamily } = require("./lib/rpc-provider-reliability");

const OUT_DIR = path.resolve(__dirname, "..", "reports", "raw", "fast", "puffer-history-decode-20260922");
const OUT = path.join(OUT_DIR, "safe-batch-decode.json");
const PROXY = "0xf7b6B32492c2e13799D921E84202450131bd238B";
const BATCH_SELECTOR = "0xe241ef8d";
const TXS = [
  "0x6d2535a0e7b5467c48d8ed2ef759cf46234cb20e9aa4b5cf62bdaee59cee1578",
  "0x99438da75a3488215f3a983e35f7dd51f45201bbd184c9e0d832a9a4dce10400",
  "0x77599958ace05f8580670ce4b18efd3d89dbc56e74b2a0078b4deb24023e4f89",
  "0xe554a438a5c9b4ff6a1a5ec73a493db25681688ce97bdd56b34a172ef2151d41",
];
const IFACE = new ethers.Interface([
  "function batchHandleWithdrawals((address module,uint256 startEpoch,uint256 endEpoch,bool wasSlashed,bytes32 moduleName,uint256 pufferModuleIndex,uint256 withdrawalAmount)[] validatorInfos, bytes[] guardianEOASignatures)",
]);
const hex = (n) => "0x" + BigInt(n).toString(16);
const fmt = (w) => (Number(w) / 1e18).toFixed(6);

async function discover() {
  const urls = loadRpcUrls({ maxCandidates: 128 });
  for (const url of urls) {
    if ((await rpcCall(url, "eth_chainId", [], 7000)) !== "0x1") continue;
    const p = await rpcCall(url, "trace_filter", [{ fromBlock: hex(25624907), toBlock: hex(25625006), toAddress: [PROXY] }], 40000);
    if (Array.isArray(p)) return { url, family: providerFamily(url) || "other" };
  }
  return null;
}

function decode(input) {
  const parsed = IFACE.parseTransaction({ data: input });
  return parsed.args[0].map((e) => {
    const wa = BigInt(e.withdrawalAmount);
    const sf = wa < 32n * 10n ** 18n ? 32n * 10n ** 18n - wa : 0n;
    return { moduleName: e.moduleName, idx: e.pufferModuleIndex.toString(), wasSlashed: e.wasSlashed, wa: e.withdrawalAmount.toString(), waEth: fmt(wa), shortfallEth: fmt(sf), underflowDefinite: !e.wasSlashed && wa < 30n * 10n ** 18n, underflowPossible: !e.wasSlashed && wa < 31n * 10n ** 18n };
  });
}

async function main() {
  const ep = await discover();
  if (!ep) throw new Error("no trace endpoint");
  const out = { meta: { generatedUtc: new Date().toISOString(), endpointFamily: ep.family, readOnly: true, urlsPersisted: false }, txs: [] };
  let all = [];
  for (const hash of TXS) {
    const traces = await rpcCall(ep.url, "trace_transaction", [hash], 40000);
    const batches = Array.isArray(traces) ? traces.filter((t) => t.action && typeof t.action.input === "string" && t.action.input.slice(0, 10) === BATCH_SELECTOR) : [];
    const seen = new Set();
    const uniq = [];
    for (const t of batches) { const k = t.traceAddress.join(","); if (seen.has(k)) continue; seen.add(k); uniq.push(t); }
    const entries = [];
    for (const t of uniq) for (const e of decode(t.action.input)) entries.push(e);
    all = all.concat(entries);
    out.txs.push({ txHash: hash, batchCalls: uniq.length, entries: entries.length, minWA: entries.length ? Math.min(...entries.map((e) => Number(e.waEth))) : null, below32: entries.filter((e) => Number(e.waEth) < 32).length, underflowDefinite: entries.filter((e) => e.underflowDefinite).length, underflowPossible: entries.filter((e) => e.underflowPossible).length, slashed: entries.filter((e) => e.wasSlashed).length, lowSample: entries.filter((e) => Number(e.waEth) < 32).slice(0, 12) });
    console.log(`${hash} batchCalls=${uniq.length} entries=${entries.length}`);
  }
  out.aggregate = { entries: all.length, minWA: all.length ? Math.min(...all.map((e) => Number(e.waEth))) : null, below32: all.filter((e) => Number(e.waEth) < 32).length, underflowDefinite: all.filter((e) => e.underflowDefinite).length, underflowPossible: all.filter((e) => e.underflowPossible).length, slashed: all.filter((e) => e.wasSlashed).length };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log("aggregate", JSON.stringify(out.aggregate));
}
main().catch((e) => { console.log("FATAL", String(e && e.stack || e).slice(0, 600)); process.exit(1); });
