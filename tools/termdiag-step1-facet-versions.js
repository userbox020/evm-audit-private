#!/usr/bin/env node
"use strict";
/* READ-ONLY: call version() directly on live facet contracts (standalone read). */
const fs = require("fs");
const path = require("path");
const { ethers } = require(path.join(__dirname, "node_modules", "ethers"));
const sharedRpc = require("./shared-rpc");

const OUT = path.join(__dirname, "..", "reports", "raw", "termdiag-step1-facet-versions.json");
const IFACE = new ethers.Interface(["function version() view returns (string)"]);
const FACETS = {
  "0xc024BE1b35a7271b815125676f30C3EC3BB4463a": "DiamondCutFacet",
  "0xd7f2F42188932513dCAA4F9c9b241F34a1f70e92": "DiamondLoupeFacet",
  "0xFF6D0eb2E2BB598B645598CcfD1e81790b8FCa1B": "TermControllerFacet",
  "0x4145fFC9f5f4dCB0aFe05aa78Fa07CAC5ceaB06C": "TermStrategyFacet",
  "0x02c7d197D047F687E67504cB9Ac21EADe5ce19bb": "TermLoanIntentFacet",
  "0x7045f0945691De1E4f22e9841b77c06020BA3d13": "TransferFacet",
};

async function main() {
  const ep = await sharedRpc.resolveRpc(1, null, { capability: "read" });
  const out = { schema: "termdiag-step1-facet-versions/v1", generatedUtc: new Date().toISOString(), facets: [] };
  for (const [addr, name] of Object.entries(FACETS)) {
    const data = IFACE.encodeFunctionData("version", []);
    try {
      const r = await (await fetch(ep, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: addr, data }, "latest"] }),
      })).json();
      out.facets.push({ address: addr, name, result: r.error ? { error: String(r.error.message || "").slice(0, 100) } : { version: IFACE.decodeFunctionResult("version", r.result)[0] } });
    } catch (e) {
      out.facets.push({ address: addr, name, result: { error: String(e.message || "").slice(0, 100) } });
    }
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => { console.error("FATAL " + String(e.message || e).slice(0, 200)); process.exit(1); });
