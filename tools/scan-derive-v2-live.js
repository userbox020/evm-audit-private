#!/usr/bin/env node
// Derive V2 (Lyra) options protocol config scanner.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "derive-v2-live.json");
const QUIET = process.argv.includes("--quiet");
const TIMEOUT_MS = 15_000;

const CONTRACTS = [
  { chainId: 1, address: "0xb1d1eae60eea9525032a6dcb4c1ce336a1de71be", label: "primary" },
];

const PROBES = [
  { label: "paused", data: "0x5c975abb", types: ["bool"] },
  { label: "owner", data: "0x8da5cb5b", types: ["address"] },
  { label: "name", data: "0x06fdde03", types: ["string"] },
  { label: "symbol", data: "0x95d89b41", types: ["string"] },
];

function asNumber(v) { if (v === null || v === undefined) return null; if (typeof v === "number") return Number.isFinite(v) ? v : null; const n = Number(String(v).replace(/[$,%\s,]/g, "")); return Number.isFinite(n) ? n : null; }
function round(v, d = 2) { const n = asNumber(v); if (n === null) return null; return Math.round(n * 10 ** d) / 10 ** d; }
function loadRpcUrls() { if (!fs.existsSync(RPC_FILE)) return []; return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map(m => m[0]); }
async function rpcCall(url, method, params = [], timeoutMs = TIMEOUT_MS) { const c = new AbortController(); const t = setTimeout(() => c.abort(), timeoutMs); try { const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: c.signal }); const j = await r.json(); if (j.error) throw new Error(j.error.message || JSON.stringify(j.error)); return j.result ?? null; } finally { clearTimeout(t); } }
async function resolveRpcPool(ids) { const p = {}; for (const u of loadRpcUrls()) { try { const h = await rpcCall(u, "eth_chainId", [], 6000); const c = Number(BigInt(h)); if (ids.includes(c) && !p[c]) p[c] = u; } catch (_) {} } return p; }

const CHAIN_NAMES = { 1: "Ethereum", 10: "Optimism", 42161: "Arbitrum", 8453: "Base" };

async function main() {
  const rpcs = await resolveRpcPool([1]);
  const rpcUrl = rpcs[1];
  if (!rpcUrl) { console.log("No Eth RPC"); return; }
  const p = new ethers.JsonRpcProvider(rpcUrl, 1, { staticNetwork: true });
  const block = await p.getBlock("latest");

  const results = [];
  for (const c of CONTRACTS) {
    const entry = { label: c.label, chainId: c.chainId, address: c.address };
    try {
      const code = await p.getCode(c.address);
      entry.codeBytes = (code.length - 2) / 2;
      entry.hasCode = code.length > 2;

      const impl = await p.getStorage(c.address, "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc");
      const implAddr = "0x" + impl.slice(-40);
      if (implAddr !== "0x" + "0".repeat(40)) {
        entry.isProxy = true;
        entry.implAddress = implAddr;
        const implCode = await p.getCode(implAddr);
        entry.implCodeBytes = (implCode.length - 2) / 2;
      } else {
        entry.isProxy = false;
      }

      entry.probes = {};
      for (const probe of PROBES) {
        try {
          const raw = await p.call({ to: c.address, data: probe.data });
          if (!raw || raw === "0x") { entry.probes[probe.label] = null; continue; }
          const dec = ethers.AbiCoder.defaultAbiCoder().decode(probe.types, raw);
          entry.probes[probe.label] = probe.types[0] === "address" ? (dec[0] ? dec[0].toLowerCase() : null) : probe.types[0] === "bool" ? dec[0] : String(dec[0]);
        } catch (_) { entry.probes[probe.label] = "reverted"; }
      }
    } catch (e) {
      entry.error = e?.message?.slice(0, 100);
    }
    results.push(entry);
  }

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-derive-v2-live.js",
    scope: "Read-only Derive V2 options protocol config scan",
    safety: { rpcInventoryRead: true, rpcUrlsStored: false, signedActions: false, routePositive: false, signedActionJustified: false },
    protocol: { name: "Derive V2 (Lyra)", type: "Options/Perps/Spot", audits: 0, tvl: "~$126M", chains: ["Ethereum", "Optimism", "Arbitrum", "Base", "Hyperliquid"] },
    chain: { id: 1, block: block.number },
    contracts: results,
    summary: { contractsScanned: results.length, contractsWithCode: results.filter(r => r.hasCode).length, proxiesFound: results.filter(r => r.isProxy).length, routePositive: 0, signedActionJustified: false, closedReason: results.length ? "Initial config scan complete — no verified source or deep function probing yet" : "No contracts mapped" },
    requiredForRoutePositive: ["verified source code or decompiled semantics", "options/futures oracle manipulation exploitable", "exercise/settlement timing gap", "exact economics positive after gas", "fork extraction proof"],
    nextReadOnlyStep: "Extend to Optimism/Arbitrum/Base deployments; decompile implementation; probe settlement/exercise functions.",
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");
  if (!QUIET) {
    for (const r of results) {
      console.log(`Derive V2: ${r.label} chain=${r.chainId} proxy=${r.isProxy} code=${r.codeBytes}b probes=${Object.entries(r.probes||{}).filter(([,v])=>v!==null&&v!=="reverted").length}/${PROBES.length}`);
    }
  }
}

main().catch(e => { console.error(e?.message || String(e)); process.exit(1); });
