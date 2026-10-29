#!/usr/bin/env node
// scan-reports-signal.js — Scans all triage reports and prints a signal summary
const fs = require("fs");
const path = require("path");

const QUIET = process.argv.includes("--quiet");
const REPORTS_DIR = path.resolve(__dirname, "..", "reports");
const NON_TRIAGE_REPORTS = new Set([
  "next-top5-audit-targets.md",
  "phase0-coverage-audit.md",
]);

const files = fs.readdirSync(REPORTS_DIR).filter(f => f.endsWith(".md") && !NON_TRIAGE_REPORTS.has(f));

const results = { CONFIRMED: [], VULNERABLE: [], WATCH: [], DORMANT: [], CLEAN: [], UNTAGGED: [] };

for (const file of files) {
  const content = fs.readFileSync(path.join(REPORTS_DIR, file), "utf8");
  
  if (content.includes("🔴 CONFIRMED")) results.CONFIRMED.push(file);
  else if (content.includes("🟡 VULNERABLE")) results.VULNERABLE.push(file);
  else if (content.includes("🟠 WATCH")) results.WATCH.push(file);
  else if (content.includes("🟢 DORMANT")) results.DORMANT.push(file);
  else if (content.includes("⚪ CLEAN")) results.CLEAN.push(file);
  else if (content.includes("No confirmed permissionless") || content.includes("no confirmed permissionless")) results.CLEAN.push(file);
  else results.UNTAGGED.push(file);
}

if (!QUIET) {
  console.log("═══════════════════════════════════════════");
  console.log("REPORT SIGNAL SUMMARY");
  console.log("═══════════════════════════════════════════");
  console.log("");
  console.log(`🔴 CONFIRMED:  ${results.CONFIRMED.length}`);
  if (results.CONFIRMED.length) results.CONFIRMED.forEach(f => console.log(`   → ${f}`));
  console.log("");
  console.log(`🟡 VULNERABLE: ${results.VULNERABLE.length}`);
  if (results.VULNERABLE.length) results.VULNERABLE.forEach(f => console.log(`   → ${f}`));
  console.log("");
  console.log(`🟠 WATCH:      ${results.WATCH.length}`);
  if (results.WATCH.length) results.WATCH.forEach(f => console.log(`   → ${f}`));
  console.log("");
  console.log(`🟢 DORMANT:    ${results.DORMANT.length}`);
  if (results.DORMANT.length) results.DORMANT.forEach(f => console.log(`   → ${f}`));
  console.log("");
  console.log(`⚪ CLEAN:      ${results.CLEAN.length}`);
  console.log("");
  console.log(`❓ UNTAGGED:   ${results.UNTAGGED.length}`);
  if (results.UNTAGGED.length) results.UNTAGGED.forEach(f => console.log(`   → ${f}`));
  console.log("");
  console.log(`Total reports: ${files.length}`);
}
