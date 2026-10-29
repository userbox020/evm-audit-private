#!/usr/bin/env node
"use strict";
/* READ-ONLY: live DIAMOND_ROLE chain probe (diamond -> per-repo contracts). */
const fs = require("fs");
const path = require("path");
const { ethers } = require(path.join(__dirname, "node_modules", "ethers"));
const sharedRpc = require("./shared-rpc");

const OUT = path.join(__dirname, "..", "reports", "raw", "termdiag-step1-chain-probe.json");
const DIAMOND = "0xb4B1de03F229220eDbBB31A224b2a004b3c3e47f";
const CANDIDATES = [
  "0xa7dE1A7118e2BBE17c0928673966f466b18aDE77",
  "0xc8006dec63d7d2f6b45a0f5de90390a86a6b950d",
  "0x99FE7E977DFE42700f4424Bc4C2bbb3EfcC6E691",
];
const IFACE = new ethers.Interface([
  "function termRepoCollateralManager() view returns (address)",
  "function termRepoLocker() view returns (address)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
]);

async function call(ep, to, fn, args) {
  try {
    const data = IFACE.encodeFunctionData(fn, args);
    const r = await (await fetch(ep, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
    })).json();
    if (r.error) return { ok: false, error: String(r.error.message || "").slice(0, 80) };
    return { ok: true, value: IFACE.decodeFunctionResult(fn, r.result)[0].toString() };
  } catch (e) { return { ok: false, error: String(e.message || e).slice(0, 80) }; }
}

async function main() {
  const ep = await sharedRpc.resolveRpc(1, null, { capability: "read" });
  const role = ethers.id("DIAMOND_ROLE");
  const out = {
    schema: "termdiag-step1-chain-probe/v1",
    generatedUtc: new Date().toISOString(),
    diamond: DIAMOND,
    diamondRoleHash: role,
    repos: [],
    status: "PASS",
  };
  for (const c of CANDIDATES) {
    const entry = { servicer: c };
    entry.diamondOnServicer = await call(ep, c, "hasRole", [role, DIAMOND]);
    const cm = await call(ep, c, "termRepoCollateralManager");
    entry.collateralManager = cm;
    if (cm.ok) entry.diamondOnCollateralManager = await call(ep, cm.value, "hasRole", [role, DIAMOND]);
    const rl = await call(ep, c, "termRepoLocker");
    entry.repoLocker = rl;
    if (rl.ok) entry.diamondOnLocker = await call(ep, rl.value, "hasRole", [role, DIAMOND]);
    out.repos.push(entry);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => { console.error("FATAL " + String(e.message || e).slice(0, 200)); process.exit(1); });
