#!/usr/bin/env node
// patch-dashboard-freshness.js — Adds lastSeen + E35-E40 handlers to view-alerts.js
const fs = require("fs");
const path = require("path");
const fpath = path.join(__dirname, "..", "tools", "view-alerts.js");
let c = fs.readFileSync(fpath, "utf8");

// 1. Add lastSeen helper to evaluator row display
c = c.replace(
  'function evaluatorRow(icon, name, status) {',
  'function evaluatorRow(icon, name, status, lastSeen) { const age = lastSeen ? Math.round((Date.now()-new Date(lastSeen).getTime())/60000) : null; const freshness = age !== null ? (age > 60 ? " STALE("+Math.round(age/60)+"h)" : " "+age+"m ago") : ""; return `${icon} ${name.padEnd(6)} ${status.padEnd(20)}${freshness}`; }'
);

// 2. Add E35 handler in evaluator map
c = c.replace(
  'E27: "aave-v3-hf-watch",',
  'E27: "aave-v3-hf-watch", E35: "aave-v3-hf-watch", E36: "morpho-liquidation-bot",'
);

// 3. Add E35-E40 to evalSummary array
const evalInsert = '  { name: "E35", evaluators: ["E35"], statusFn: "e35Status" },\n  { name: "E36", evaluators: ["E36"], statusFn: "e36Status" },\n  { name: "E37", evaluators: ["E37"], statusFn: "e37Status" },\n  { name: "E38", evaluators: ["E38"], statusFn: "e38Status" },\n  { name: "E39", evaluators: ["E39"], statusFn: "e39Status" },\n  { name: "E40", evaluators: ["E40"], statusFn: "e40Status" },';
c = c.replace('  { name: "CAPO",', evalInsert + '\n  { name: "CAPO",');

// 4. Add status functions for E35-E40
const statusFns = `
function e35Status(s) { const r = s.conditions?.["aave-v3-hf-watch"]?.lastResult; if (!r) return "BOT ARMED, no scan"; const hf = r.results?.length ? Math.min(...r.results.filter(x=>x.hf).map(x=>x.hf)).toFixed(4) : "?"; return "HF="+hf+" debt=$${(r.results?.[0]?.totalDebt||0)>0?Math.round(r.results[0].totalDebt/1e6)+"M":"0"}, chains="+(r.results?.length||0); }
function e36Status(s) { return "Morpho bot — HF <1 watch on ETH/Base/Arb"; }
function e37Status(s) { const r = s.conditions?.["dex-divergence-watch"]; return r?.lastResult ? "last="+r.lastResult.age+"h" : "OK no scan"; }
function e38Status(s) { return s.conditions?.["wsteth-dex-discount"]?.lastScan ? "checked " + Math.round((Date.now()-s.conditions["wsteth-dex-discount"].lastScan)/60000)+"m ago" : "OK no scan"; }
function e39Status(s) { return s.conditions?.["rusd-psm-arb"]?.lastScan ? "checked " + Math.round((Date.now()-s.conditions["rusd-psm-arb"].lastScan)/60000)+"m ago" : "OK no scan"; }
function e40Status(s) { const r = s.conditions?.["fee-on-transfer"]; return r?.lastResult?.usdtFeeActive ? "USDT fee ACTIVE" : "USDT fee=0 OK"; }
`;
c = c.replace("function evaluatorRow(", statusFns + "function evaluatorRow(");

fs.writeFileSync(fpath, c);
console.log("Dashboard patched: freshness + E35-E40 handlers added");
