#!/usr/bin/env node
// test-all-rpc-endpoints.js — Tests ALL RPC URLs in rpc_endpoints.txt
// Measures: chainId, latency, eth_call support, getLogs support
const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "rpc-test-results.json");

const CHAIN_NAMES = {
  1: "Ethereum", 10: "Optimism", 56: "BNB Chain", 100: "Gnosis",
  137: "Polygon", 146: "Sonic", 250: "Fantom", 130: "Unichain",
  252: "Fraxtal", 480: "World Chain", 8453: "Base", 42161: "Arbitrum",
  43114: "Avalanche", 59144: "Linea", 81457: "Blast", 534352: "Scroll",
  42220: "Celo", 5000: "Mantle", 57073: "Ink", 324: "zkSync Era",
  10143: "Monad", 80094: "Berachain", 999: "Hyperliquid",
};

function parseEndpoints() {
  const content = fs.readFileSync(RPC_FILE, "utf8");
  const urls = [...content.matchAll(/https?:\/\/[^\s'"<>]+/g)].map(m => m[0]);
  
  // Extract origin hints from the file
  const originMap = {};
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const originMatch = line.match(/\[origin:\s*([^\]]+)\]/);
    const urlMatch = line.match(/(https?:\/\/[^\s'"<>]+)/);
    if (originMatch && urlMatch) {
      originMap[urlMatch[1]] = originMatch[1].trim();
    }
  }
  
  return { urls, originMap };
}

async function testEndpoint(url, originHint) {
  const result = { url, chainId: null, chainName: "?", latencyMs: null, ethCall: false, getLogs: false, error: null };
  const start = Date.now();
  
  const headers = { "content-type": "application/json" };
  if (originHint) headers["origin"] = originHint;
  
  try {
    // Test 1: eth_chainId
    const r1 = await fetch(url, {
      method: "POST", headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(8000),
    });
    const j1 = await r1.json();
    if (j1.error) { result.error = j1.error.message?.slice(0, 80); return result; }
    
    const chainId = parseInt(j1.result, 16);
    result.chainId = chainId;
    result.chainName = CHAIN_NAMES[chainId] || `chain-${chainId}`;
    
    // Test 2: eth_blockNumber (latency)
    const r2 = await fetch(url, {
      method: "POST", headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_blockNumber", params: [] }),
      signal: AbortSignal.timeout(8000),
    });
    const j2 = await r2.json();
    if (j2.error) { result.error = j2.error.message?.slice(0, 80); return result; }
    result.latencyMs = Date.now() - start;
    
    // Test 3: eth_call (USDT balanceOf on Ethereum, or just a simple call)
    const testTarget = chainId === 1 ? "0xdAC17F958D2ee523a2206206994597C13D831ec7" : 
                       "0x0000000000000000000000000000000000000000";
    const testData = "0x70a082310000000000000000000000000000000000000000000000000000000000000000";
    const r3 = await fetch(url, {
      method: "POST", headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "eth_call", params: [{ to: testTarget, data: testData }, "latest"] }),
      signal: AbortSignal.timeout(8000),
    });
    const j3 = await r3.json();
    result.ethCall = !j3.error;
    if (j3.error && j3.error.message?.includes("filter")) result.error = "FILTER_BLOCKED";
    
    // Test 4: eth_getLogs (small range)
    const r4 = await fetch(url, {
      method: "POST", headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "eth_getLogs", params: [{ fromBlock: "0x1", toBlock: "0x2", address: "0x0000000000000000000000000000000000000000" }] }),
      signal: AbortSignal.timeout(8000),
    });
    const j4 = await r4.json();
    result.getLogs = !j4.error;
    
  } catch (e) {
    result.error = e.message?.slice(0, 60);
    result.latencyMs = Date.now() - start;
  }
  
  return result;
}

async function main() {
  const { urls, originMap } = parseEndpoints();
  console.log(`Testing ${urls.length} RPC endpoints...\n`);
  
  const results = [];
  for (const url of urls) {
    const origin = originMap[url] || null;
    const r = await testEndpoint(url, origin);
    results.push(r);
    
    const icon = r.chainId ? "✅" : "❌";
    const line = `${icon} ${r.chainName.padEnd(12)} ${url.slice(0, 55).padEnd(58)} ${r.latencyMs ? r.latencyMs + "ms" : "FAIL"} ethCall=${r.ethCall} getLogs=${r.getLogs} ${r.error ? "ERR:" + r.error : ""}`;
    console.log(line);
  }
  
  // Summary by chain
  console.log("\n=== Summary by Chain ===");
  const byChain = {};
  for (const r of results) {
    if (!r.chainId) continue;
    const key = `${r.chainId}:${r.chainName}`;
    if (!byChain[key]) byChain[key] = [];
    byChain[key].push(r);
  }
  
  for (const [key, eps] of Object.entries(byChain)) {
    const working = eps.filter(e => e.ethCall && e.error !== "FILTER_BLOCKED");
    const blocked = eps.filter(e => e.error === "FILTER_BLOCKED");
    console.log(`  ${key.padEnd(18)} ${eps.length} total, ${working.length} working, ${blocked.length} filter-blocked`);
  }
  
  // Aave V3 chains
  console.log("\n=== Aave V3 Chain Readiness ===");
  const aaveChains = { 1: "Ethereum", 8453: "Base", 42161: "Arbitrum", 10: "Optimism", 137: "Polygon", 43114: "Avalanche" };
  for (const [cid, name] of Object.entries(aaveChains)) {
    const eps = results.filter(e => e.chainId === Number(cid));
    const working = eps.filter(e => e.ethCall && e.error !== "FILTER_BLOCKED");
    console.log(`  ${name.padEnd(12)} ${working.length} working RPC(s)`);
  }
  
  const artifact = { scannedAt: new Date().toISOString(), total: results.length, working: results.filter(e=>e.chainId).length, byChain };
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2));
  console.log(`\nArtifact: ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
