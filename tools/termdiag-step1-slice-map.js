#!/usr/bin/env node
"use strict";
/* Build live-slice signature map: live facet selectors -> pinned artifact signatures. */
const fs = require("fs");
const path = require("path");
const { ethers } = require(path.join(__dirname, "node_modules", "ethers"));
const sharedRpc = require("./shared-rpc");

const PIN = path.join(__dirname, "..", "targets", "term-finance-contracts-v2.1.2");
const OUT = path.join(__dirname, "..", "reports", "raw", "termdiag-step1-slice-map.json");

function buildMap() {
  const dir = path.join(PIN, "artifacts", "contracts", "facets");
  const map = new Map();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith(".json")) continue;
      let j; try { j = JSON.parse(fs.readFileSync(p, "utf8")); } catch { continue; }
      if (!Array.isArray(j.abi)) continue;
      const contract = e.name.replace(/\.json$/, "");
      for (const item of j.abi) {
        try {
          const iface = new ethers.Interface([item]);
          for (const frag of iface.fragments) {
            if (!frag.selector) continue;
            const label = `${contract}.${frag.format("sighash")}`;
            const arr = map.get(frag.selector) || [];
            if (!arr.includes(label)) arr.push(label);
            map.set(frag.selector, arr);
          }
        } catch { /* ignore */ }
      }
    }
  };
  walk(dir);
  return map;
}

async function main() {
  const ep = await sharedRpc.resolveRpc(1, null, { capability: "read" });
  const diamond = "0xb4B1de03F229220eDbBB31A224b2a004b3c3e47f";
  const iface = new ethers.Interface(["function facets() view returns ((address facetAddress, bytes4[] functionSelectors)[])"]);
  const res = await (await fetch(ep, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: diamond, data: iface.encodeFunctionData("facets", []) }, "latest"] }),
  })).json();
  const decoded = iface.decodeFunctionResult("facets", res.result)[0];
  const map = buildMap();
  const out = { schema: "termdiag-step1-slice-map/v1", generatedUtc: new Date().toISOString(), diamond, facets: [] };
  for (const f of decoded) {
    const entry = { facetAddress: f.facetAddress, selectors: [] };
    for (const sel of f.functionSelectors) {
      const labels = map.get(sel) || [];
      entry.selectors.push({ selector: sel, signature: labels.length ? labels[0] : "UNMAPPED" });
    }
    out.facets.push(entry);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  for (const f of out.facets) {
    console.log(f.facetAddress, "=>", f.selectors.map((s) => s.signature).join(", "));
  }
}

main().catch((e) => { console.error("FATAL " + String(e.message || e).slice(0, 200)); process.exit(1); });
