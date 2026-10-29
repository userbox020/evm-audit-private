#!/usr/bin/env node
// probe-debug-trace-endpoints.js — Test debug_traceTransaction on CSP-leaked RPCs
// Goal: find if ANY RPC supports debug_* methods (unblocks UniswapX Phase 2)
const fs = require("fs"); const path = require("path");
const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "debug-trace-capability.json");

const ENDPOINTS = [
  { name: "cloudflare-eth", url: "https://cloudflare-eth.com" },
  { name: "merkle-eth", url: "https://eth.merkle.io" },
  { name: "merkle-base", url: "https://base.merkle.io" },
  { name: "merkle-bsc", url: "https://bsc.merkle.io" },
  { name: "0xrpc-eth", url: "https://0xrpc.io/eth" },
];

// Known tx hashes for testing debug_trace
const TRACE_TX_HASHES = {
  // Ethereum: recent Uniswap V3 swap (USDC → WETH, 2026-06-09)
  eth: "0x9c7c4e60adc02cd5da331a1c24a4e06f7cf53086821660696c141d130258550b",
  // Base: recent Uniswap V3 swap
  base: "0x1a42b5aa52b06a33feb7e7fda75d312b6b4e532c6f6ca9d68030c5cb96adab5e",
  // BSC: recent PancakeSwap swap
  bsc: "0x5b7b7b8e0c8f3b5c7b7b8e0c8f3b5c7b7b8e0c8f3b5c7b7b8e0c8f3b5c7b",
};

async function rpcCall(url, method, params, ms = 10000) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctrl.signal,
    });
    const j = await r.json();
    if (j.error) return { error: j.error.message };
    return j.result;
  } catch (e) { return { error: e.message }; }
  finally { clearTimeout(t); }
}

async function testEndpoint(ep) {
  const result = {
    name: ep.name, url: ep.url,
    chainId: null, blockNumber: null,
    eth_call: false, debug_traceTransaction: false, debug_traceBlockByNumber: false,
    trace_tx_error: null, trace_block_error: null,
    trace_tx_sample: null, trace_block_sample: null,
  };

  // 1. Basic connectivity
  const id = await rpcCall(ep.url, "eth_chainId", [], 6000);
  if (typeof id === "object" && id?.error) { result.chainId = "FAIL: " + id.error; return result; }
  if (!id) { result.chainId = "no-response"; return result; }
  result.chainId = parseInt(id, 16);

  const bn = await rpcCall(ep.url, "eth_blockNumber", [], 6000);
  result.blockNumber = bn ? parseInt(bn, 16) : null;

  // 2. Test eth_call
  const call = await rpcCall(ep.url, "eth_call", [
    { to: "0xdAC17F958D2ee523a2206206994597C13D831ec7", data: "0x70a082310000000000000000000000000000000000000000000000000000000000000000" },
    "latest"
  ], 8000);
  result.eth_call = call !== null && !(call?.error);

  // 3. Test debug_traceTransaction (key test)
  const traceTx = await rpcCall(ep.url, "debug_traceTransaction", [
    TRACE_TX_HASHES.eth,
    { tracer: "callTracer" }
  ], 15000);
  if (traceTx?.error) {
    result.trace_tx_error = traceTx.error;
  } else if (traceTx) {
    result.debug_traceTransaction = true;
    result.trace_tx_sample = JSON.stringify(traceTx).slice(0, 200);
  }

  // 4. Test debug_traceBlockByNumber (fallback trace method)
  const traceBlock = await rpcCall(ep.url, "debug_traceBlockByNumber", [
    "0x1",
    { tracer: "callTracer" }
  ], 15000);
  if (traceBlock?.error) {
    result.trace_block_error = traceBlock.error;
  } else if (traceBlock) {
    result.debug_traceBlockByNumber = true;
    result.trace_block_sample = JSON.stringify(traceBlock).slice(0, 200);
  }

  return result;
}

async function main() {
  console.log("=== debug_traceTransaction Capability Scan ===\n");

  const results = [];
  for (const ep of ENDPOINTS) {
    console.log(`Testing ${ep.name}...`);
    const r = await testEndpoint(ep);
    results.push(r);
    const icon = r.debug_traceTransaction ? "UNBLOCKED" : r.trace_tx_error ? "BLOCKED: " + r.trace_tx_error.slice(0, 60) : "TIMEOUT/NO-RESPONSE";
    console.log(`  chainId=${r.chainId} eth_call=${r.eth_call} debug_trace=${icon}`);
  }

  const unblocked = results.filter(r => r.debug_traceTransaction);
  console.log(`\n=== RESULT: ${unblocked.length}/${ENDPOINTS.length} endpoints support debug_traceTransaction ===`);
  if (unblocked.length > 0) {
    console.log("UniswapX Phase 2 UNBLOCKED on: " + unblocked.map(r => r.name).join(", "));
  } else {
    const altMethods = results.filter(r => r.debug_traceBlockByNumber);
    console.log("No debug_traceTransaction. debug_traceBlockByNumber on: " + (altMethods.map(r => r.name).join(", ") || "none"));
  }

  fs.writeFileSync(OUT, JSON.stringify({ scannedAt: new Date().toISOString(), results }, null, 2));
  console.log(`\nArtifact: ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
