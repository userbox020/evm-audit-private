#!/usr/bin/env node
"use strict";
// Deep decode of the two reverted batchHandleWithdrawals Safe txs (P2). Read-only, keyless.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { loadRpcUrls, rpcCall } = require("./shared-rpc");
const { providerFamily } = require("./lib/rpc-provider-reliability");

const OUT_DIR = path.resolve(__dirname, "..", "reports", "raw", "fast", "puffer-history-decode-20260922");
const OUT = path.join(OUT_DIR, "revert-analysis.json");
const PROXY = "0xf7b6B32492c2e13799D921E84202450131bd238B";
const PAYMASTER = "0xc0896ab1a8cae8c2c1d27d011eb955cca955580d";
const BATCH_SELECTOR = "0xe241ef8d";
const REVERTS = [
  { txHash: "0x511f7cb7916bfc575d0b6559198b24e9abbe20b1a9149ad3b1000d891be5254b", blockNumber: 25954512 },
  { txHash: "0xef001267656e6bcca00f9f229b004b71866a7f949be842a5705b08c0680d7dba", blockNumber: 25954537 },
];
const IFACE = new ethers.Interface([
  "function batchHandleWithdrawals((address module,uint256 startEpoch,uint256 endEpoch,bool wasSlashed,bytes32 moduleName,uint256 pufferModuleIndex,uint256 withdrawalAmount)[] validatorInfos, bytes[] guardianEOASignatures)",
  "error InvalidValidatorState(uint8 status)",
  "error Failed()",
]);
const hex = (n) => "0x" + BigInt(n).toString(16);
const fmt = (w) => (Number(w) / 1e18).toFixed(6);

async function discover() {
  const urls = loadRpcUrls({ maxCandidates: 128 });
  for (const url of urls) {
    if ((await rpcCall(url, "eth_chainId", [], 7000)) !== "0x1") continue;
    const p = await rpcCall(url, "trace_filter", [{ fromBlock: hex(25954512), toBlock: hex(25954611), toAddress: [PROXY] }], 40000);
    if (Array.isArray(p)) return { url, family: providerFamily(url) || "other" };
  }
  return null;
}

function decodeEntries(input) {
  const parsed = IFACE.parseTransaction({ data: input });
  return parsed.args[0].map((e) => {
    const wa = BigInt(e.withdrawalAmount);
    const sf = wa < 32n * 10n ** 18n ? 32n * 10n ** 18n - wa : 0n;
    return {
      moduleName: e.moduleName,
      idx: e.pufferModuleIndex.toString(),
      wasSlashed: e.wasSlashed,
      wa: e.withdrawalAmount.toString(),
      waEth: fmt(wa),
      shortfallEth: fmt(sf),
      underflowDefinite: !e.wasSlashed && wa < 30n * 10n ** 18n,
      underflowPossible: !e.wasSlashed && wa < 31n * 10n ** 18n,
    };
  });
}

function summarise(entries) {
  const nums = entries.map((e) => Number(e.waEth));
  return {
    count: entries.length,
    minEth: nums.length ? Math.min(...nums) : null,
    below32: entries.filter((e) => Number(e.waEth) < 32).length,
    underflowDefinite: entries.filter((e) => e.underflowDefinite).length,
    underflowPossible: entries.filter((e) => e.underflowPossible).length,
    slashed: entries.filter((e) => e.wasSlashed).length,
    lowSample: entries.filter((e) => Number(e.waEth) < 32).slice(0, 12),
  };
}

async function main() {
  const ep = await discover();
  if (!ep) throw new Error("no trace endpoint");
  console.log(`endpoint family=${ep.family}`);

  const out = { meta: { generatedUtc: new Date().toISOString(), endpointFamily: ep.family, readOnly: true, urlsPersisted: false }, reverts: [] };

  for (const r of REVERTS) {
    const rec = { txHash: r.txHash, blockNumber: String(r.blockNumber) };
    const tx = await rpcCall(ep.url, "eth_getTransactionByHash", [r.txHash], 20000);
    const receipt = await rpcCall(ep.url, "eth_getTransactionReceipt", [r.txHash], 20000);
    const traces = await rpcCall(ep.url, "trace_transaction", [r.txHash], 40000);
    const dt = await rpcCall(ep.url, "debug_traceTransaction", [r.txHash, { tracer: "callTracer" }], 40000);

    rec.txStatus = receipt ? receipt.status : null;
    rec.txFrom = tx ? tx.from : null;
    rec.txTo = tx ? tx.to : null;
    rec.txNonce = tx ? tx.nonce : null;
    rec.outerSelector = tx && tx.input ? tx.input.slice(0, 10) : null;

    const batchTraces = Array.isArray(traces)
      ? traces.filter((t) => t.action && typeof t.action.input === "string" && t.action.input.slice(0, 10) === BATCH_SELECTOR)
      : [];
    rec.subBatchCalls = batchTraces.map((t) => {
      const entries = decodeEntries(t.action.input);
      return {
        traceAddress: t.traceAddress,
        error: t.error || null,
        entrySummary: summarise(entries),
      };
    });
    rec.totalEntriesAcrossSubBatches = rec.subBatchCalls.reduce((a, s) => a + s.entrySummary.count, 0);
    rec.anyUnderflowInRevertedTx = rec.subBatchCalls.some((s) => s.entrySummary.underflowDefinite || s.entrySummary.underflowPossible);

    // Replay the failing sub-batch via eth_call at the pre-tx block to recover the raw revert reason.
    const failed = batchTraces.find((t) => t.error);
    if (failed) {
      rec.replay = {};
      for (const blk of [r.blockNumber - 1, r.blockNumber]) {
        const res = await rpcCall(ep.url, "eth_call", [{ from: PAYMASTER, to: PROXY, data: failed.action.input }, hex(blk)], 40000);
        rec.replay["block" + blk] = res;
      }
      const raw = rec.replay["block" + (r.blockNumber - 1)] || rec.replay["block" + r.blockNumber];
      if (raw && raw !== "0x" && raw.length >= 10) {
        try { rec.decodedRevert = IFACE.parseError(raw); } catch (_) { rec.decodedRevert = { raw }; }
      } else {
        rec.decodedRevert = { raw: raw || null };
      }
    }

    if (dt) {
      const stack = [];
      const walk = (n, d) => {
        if (!n || d > 12) return;
        stack.push({ to: n.to, error: n.error || null, revertReason: n.revertReason || null, output: n.output || null, type: n.type });
        for (const c of n.calls || []) walk(c, d + 1);
      };
      walk(dt, 0);
      rec.callTrace = stack;
    }

    out.reverts.push(rec);
    console.log(`tx ${r.txHash} status=${rec.txStatus} subBatches=${rec.subBatchCalls.length} totalEntries=${rec.totalEntriesAcrossSubBatches} anyUnderflow=${rec.anyUnderflowInRevertedTx}`);
    for (const s of rec.subBatchCalls) console.log(`  trace=${JSON.stringify(s.traceAddress)} err=${s.error} entries=${s.entrySummary.count} minWA=${s.entrySummary.minEth} below32=${s.entrySummary.below32} ufDef=${s.entrySummary.underflowDefinite} ufPoss=${s.entrySummary.underflowPossible}`);
    console.log(`  decodedRevert=${JSON.stringify(rec.decodedRevert)}`);
  }

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`wrote ${OUT}`);
}
main().catch((e) => { console.log("FATAL", String(e && e.stack || e).slice(0, 600)); process.exit(1); });
