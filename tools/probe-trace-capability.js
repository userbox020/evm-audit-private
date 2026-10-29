#!/usr/bin/env node
"use strict";
// Probe trace_* / receipt history capability across the Ethereum endpoint inventory.
// Read-only. Never prints endpoint URLs (family labels only).
const { loadRpcUrls, rpcCallStrict, rpcCall } = require("./shared-rpc");
const { providerFamily } = require("./lib/rpc-provider-reliability");

const PROXY = "0xf7b6B32492c2e13799D921E84202450131bd238B";
const START = 20377912;
const hex = (n) => "0x" + BigInt(n).toString(16);

async function raw(url, method, params, ms = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: ctrl.signal });
    const j = await r.json().catch(() => null);
    if (!j) return { ok: false, error: "no-json" };
    if (j.error) return { ok: false, error: j.error.message || "rpc-error" };
    return { ok: true, result: j.result };
  } catch (e) {
    return { ok: false, error: e.name || "transport" };
  } finally { clearTimeout(t); }
}

async function main() {
  const urls = loadRpcUrls({ maxCandidates: 32 });
  console.log("candidates:", urls.length);
  const seen = new Set();
  const rows = [];
  for (const url of urls) {
    const fam = providerFamily(url) || "other";
    if (seen.has(fam)) continue;
    seen.add(fam);
    const id = await rpcCall(url, "eth_chainId", [], 8000);
    if (id !== "0x1") { rows.push({ fam, chain: false }); continue; }
    const row = { fam, chain: true, trace_filter: null, trace_block: null, debug_traceBlock: null, blockReceipts: null, limit: null };
    // find max span for trace_filter
    for (const span of [100, 1000, 10000, 100000]) {
      const r = await raw(url, "trace_filter", [{ fromBlock: hex(START), toBlock: hex(START + span - 1), toAddress: [PROXY] }], 25000);
      if (r.ok) { row.limit = span; } else { row.limitErr = String(r.error).slice(0, 90); break; }
    }
    const tb = await raw(url, "trace_block", [hex(START)], 25000);
    row.trace_block = tb.ok ? "ok" : String(tb.error).slice(0, 60);
    const dt = await raw(url, "debug_traceBlockByNumber", [hex(START), { tracer: "callTracer" }], 30000);
    row.debug_traceBlock = dt.ok ? "ok" : String(dt.error).slice(0, 60);
    const br = await raw(url, "eth_getBlockReceipts", [hex(START)], 20000);
    row.blockReceipts = br.ok ? "ok" : String(br.error).slice(0, 60);
    rows.push(row);
  }
  console.log(JSON.stringify(rows, null, 1));
}
main().catch((e) => console.log("FATAL", String(e).slice(0, 200)));
