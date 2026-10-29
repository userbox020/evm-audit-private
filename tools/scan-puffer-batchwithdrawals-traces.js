#!/usr/bin/env node
"use strict";
/*
 * P2 — Puffer `batchHandleWithdrawals` trace-level revert scan (read-only, keyless).
 *
 * Uses Parity `trace_filter` (toAddress = PufferProtocol proxy) to enumerate every
 * call that reached the proxy, including calls that reverted (logs cannot see
 * reverts). Filters selector 0xe241ef8d = batchHandleWithdrawals.
 *
 * Endpoint is discovered by capability (largest trace_filter block span), never
 * persisted. No tx is signed or sent.
 */

const fs = require("fs");
const path = require("path");
const { loadRpcUrls, rpcCall } = require("./shared-rpc");
const { providerFamily } = require("./lib/rpc-provider-reliability");

const OUT_DIR = path.resolve(__dirname, "..", "reports", "raw", "fast", "puffer-history-decode-20260922");
const OUT = path.join(OUT_DIR, "trace-revert-scan.json");
const CP = path.join(OUT_DIR, ".trace-scan-checkpoint.json");

const PROXY = "0xf7b6B32492c2e13799D921E84202450131bd238B";
const BATCH_SELECTOR = "0xe241ef8d";
const FROM_BLOCK = 19846787n;
const TO_BLOCK = 26037753n;
const MAX_CHUNK = 100000n;
const RESULT_CAP_HINT = 9000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hex(n) { return "0x" + BigInt(n).toString(16); }

async function discoverEndpoint() {
  const urls = loadRpcUrls({ maxCandidates: 128 });
  for (const url of urls) {
    const cid = await rpcCall(url, "eth_chainId", [], 7000);
    if (cid !== "0x1") continue;
    const probe = await rpcCall(url, "trace_filter", [{
      fromBlock: hex(20377912), toBlock: hex(20377912 + 99999), toAddress: [PROXY],
    }], 40000);
    if (Array.isArray(probe)) {
      return { url, family: providerFamily(url) || "other" };
    }
  }
  return null;
}

async function scanChunk(url, from, to, depth) {
  const r = await rpcCall(url, "trace_filter", [{ fromBlock: hex(from), toBlock: hex(to), toAddress: [PROXY] }], 90000);
  if (r === null) {
    if (to - from > 10000n && depth < 6) {
      const mid = from + (to - from) / 2n;
      const a = await scanChunk(url, from, mid, depth + 1);
      const b = await scanChunk(url, mid + 1n, to, depth + 1);
      if (a && b) return a.concat(b);
      return null;
    }
    return null;
  }
  if (r.length >= RESULT_CAP_HINT && to - from > 10000n && depth < 6) {
    const mid = from + (to - from) / 2n;
    const a = await scanChunk(url, from, mid, depth + 1);
    const b = await scanChunk(url, mid + 1n, to, depth + 1);
    if (a && b) return a.concat(b);
    return null;
  }
  return r;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const ep = await discoverEndpoint();
  if (!ep) throw new Error("no trace_filter-capable endpoint");
  console.log(`endpoint family=${ep.family} (trace_filter span>=100k)`);

  let cp = { next: FROM_BLOCK.toString(), chunks: [], batchCalls: [], reverts: [], bySelector: {}, allRevertedCalls: 0, allProxyTraces: 0 };
  if (fs.existsSync(CP)) {
    try { cp = JSON.parse(fs.readFileSync(CP, "utf8")); console.log(`resuming from ${cp.next}`); } catch (_) {}
  }

  let cur = BigInt(cp.next);
  let chunks = 0;
  while (cur <= TO_BLOCK) {
    let end = cur + MAX_CHUNK - 1n;
    if (end > TO_BLOCK) end = TO_BLOCK;
    const traces = await scanChunk(ep.url, cur, end, 0);
    if (traces === null) {
      cp.chunks.push({ from: cur.toString(), to: end.toString(), traces: null, error: "unserved" });
      console.log(`UNSERVED ${cur}..${end}`);
    } else {
      let reverted = 0;
      for (const t of traces) {
        cp.allProxyTraces++;
        const sel = t.action && typeof t.action.input === "string" ? t.action.input.slice(0, 10) : "0x";
        cp.bySelector[sel] = (cp.bySelector[sel] || 0) + 1;
        if (t.error) { reverted++; cp.allRevertedCalls++; }
        if (sel === BATCH_SELECTOR) {
          const rec = {
            txHash: t.transactionHash,
            blockNumber: BigInt(t.blockNumber).toString(),
            from: t.action.from,
            to: t.action.to,
            topLevel: Array.isArray(t.traceAddress) && t.traceAddress.length === 0,
            traceAddress: t.traceAddress,
            error: t.error || null,
            callType: t.action.callType,
          };
          cp.batchCalls.push(rec);
          if (t.error) cp.reverts.push(rec);
        }
      }
      cp.chunks.push({ from: cur.toString(), to: end.toString(), traces: traces.length, reverted });
      console.log(`chunk ${cur}..${end}: traces=${traces.length} reverted=${reverted} batchSoFar=${cp.batchCalls.length} reverts=${cp.reverts.length}`);
    }
    cp.next = (end + 1n).toString();
    fs.writeFileSync(CP, JSON.stringify(cp));
    cur = end + 1n;
    if (++chunks % 10 === 0) await sleep(200);
  }

  // Cross-check: every batch success tx from the log pass must appear as a non-error batch call.
  let logTxs = [];
  try {
    const hist = JSON.parse(fs.readFileSync(path.join(OUT_DIR, "history-decode.json"), "utf8"));
    logTxs = hist.batches.map((b) => b.txHash);
  } catch (_) {}

  const nonErrorBatchTxs = new Set(cp.batchCalls.filter((c) => !c.error).map((c) => c.txHash.toLowerCase()));
  const missing = logTxs.filter((h) => !nonErrorBatchTxs.has(h.toLowerCase()));

  const result = {
    meta: {
      generatedUtc: new Date().toISOString(),
      chain: 1,
      proxy: PROXY,
      method: "trace_filter(toAddress=proxy) selector-filtered",
      endpointFamily: ep.family,
      fromBlock: FROM_BLOCK.toString(),
      toBlock: TO_BLOCK.toString(),
      readOnly: true,
      signed: false,
      urlsPersisted: false,
    },
    coverage: {
      chunksScanned: cp.chunks.length,
      unservedChunks: cp.chunks.filter((c) => c.traces === null).length,
      proxyTracesSeen: cp.allProxyTraces,
      proxyTracesReverted: cp.allRevertedCalls,
      bySelector: cp.bySelector,
    },
    batchWithdrawals: {
      totalCalls: cp.batchCalls.length,
      topLevelCalls: cp.batchCalls.filter((c) => c.topLevel).length,
      nestedCalls: cp.batchCalls.filter((c) => !c.topLevel).length,
      failedCalls: cp.reverts.length,
      successfulCalls: cp.batchCalls.length - cp.reverts.length,
      logSuccessTxs: logTxs.length,
      logSuccessTxsMissingFromTracePass: missing.length,
      missingSample: missing.slice(0, 10),
    },
    reverts: cp.reverts,
    batchCallSample: cp.batchCalls.slice(0, 5),
  };
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(`SUMMARY batchCalls=${cp.batchCalls.length} reverts=${cp.reverts.length} proxyTraces=${cp.allProxyTraces} revertedTraces=${cp.allRevertedCalls} missingLogTxs=${missing.length}`);
}

main().catch((e) => { console.log("FATAL", String(e && e.stack || e).slice(0, 800)); process.exit(1); });
