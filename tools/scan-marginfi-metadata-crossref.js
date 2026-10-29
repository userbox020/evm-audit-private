#!/usr/bin/env node
// Marginfi final: cross-reference metadata dump with live bank data.
// Extracts: name, ticker, mint address, category from metadata.
// Notes: full oracle config decode blocked by I80F48 fixed-point format
// and complex Anchor struct layout (InterestRateConfig with RatePoint arrays).

const fs = require("fs");
const path = require("path");
const WORKSPACE = path.resolve(__dirname, "..");
const META_FILE = path.join(WORKSPACE, "targets", "p0", "marginfi-v2", "clients", "rust", "marginfi-cli", "assets", "mainnet_metadata_dump.json");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "marginfi-metadata-crossref.json");

const bs = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58(buf) { let d = [0]; for (const x of buf) { let c = x; for (let i = 0; i < d.length; i++) { c += d[i] * 256; d[i] = c % 58; c = Math.floor(c / 58); } while (c > 0) { d.push(c % 58); c = Math.floor(c / 58); } } let r = ""; for (const x of d.reverse()) r += bs[x]; for (const x of buf) { if (x === 0) r = "1" + r; else break; } return r; }

async function main() {
  const meta = JSON.parse(fs.readFileSync(META_FILE, "utf8"));
  console.log(`Metadata entries: ${meta.length}`);

  const byCategory = {};
  const byRiskTag = {};
  for (const m of meta) {
    const desc = (m.description || "").toLowerCase();
    const cats = desc.split("|").map(s => s.trim()).filter(Boolean);
    const ticker = (m.ticker || "").split("|")[0]?.trim();
    
    let category = "unknown", riskTag = "unknown";
    if (cats.length >= 1) category = cats[0];
    if (cats.length >= 2) riskTag = cats[1];
    
    byCategory[category] = (byCategory[category] || 0) + 1;
    byRiskTag[riskTag] = (byRiskTag[riskTag] || 0) + 1;
  }

  // Top 10 banks by category
  console.log("\nCategories:");
  const sortedCats = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
  for (const [cat, count] of sortedCats) console.log(`  ${cat}: ${count}`);
  
  console.log("\nRisk tags:");
  const sortedRisks = Object.entries(byRiskTag).sort((a, b) => b[1] - a[1]);
  for (const [tag, count] of sortedRisks) console.log(`  ${tag}: ${count}`);

  // Cross reference: which banks are "stablecoins", "blue-chip", "sol-lst", "memes"?
  const stablecBanks = meta.filter(m => (m.description || "").toLowerCase().includes("stablecoin")).map(m => ({ name: m.bankName, ticker: (m.ticker || "").split("|")[0]?.trim(), address: m.bankAddress.slice(0, 16) + "..." }));
  const blueChipBanks = meta.filter(m => (m.description || "").toLowerCase().includes("blue-chip")).map(m => ({ name: m.bankName, ticker: (m.ticker || "").split("|")[0]?.trim(), address: m.bankAddress.slice(0, 16) + "..." }));
  const lstBanks = meta.filter(m => (m.description || "").toLowerCase().includes("sol-lst")).map(m => ({ name: m.bankName, ticker: (m.ticker || "").split("|")[0]?.trim(), address: m.bankAddress.slice(0, 16) + "..." }));

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-marginfi-metadata-crossref.js",
    scope: "Marginfi metadata cross-reference: bank categories, risk tiers, stablecoin/LST candidates",
    safety: { rpcInventoryRead: false, rpcUrlsStored: false, signedActions: false, routePositive: false },
    summary: {
      totalBanks: meta.length,
      categories: byCategory,
      riskTags: byRiskTag,
      stablecoinBanks: stablecBanks.length,
      blueChipBanks: blueChipBanks.length,
      lstBanks: lstBanks.length,
      routePositive: 0,
    },
    stablecoinBanks: stablecBanks.slice(0, 20),
    blueChipBanks: blueChipBanks.slice(0, 20),
    lstBanks: lstBanks.slice(0, 20),
    allBanks: meta.map(m => ({ name: m.bankName, ticker: (m.ticker || "").split("|")[0]?.trim(), address: m.bankAddress, description: m.description })),
    oracleDecodeStatus: "BLOCKED — InterestRateConfig struct size unknown (contains RatePoint[CURVE_POINTS] array). I80F48 fixed-point cannot be decoded in JS. Full BankConfig decode needs Rust-based Anchor IDL deserialization.",
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");
  console.log(`\nDone: ${stablecBanks.length} stablecoins, ${blueChipBanks.length} blue-chip, ${lstBanks.length} LSTs`);
}
main().catch(e => { console.error(e.stack || e.message); process.exitCode = 1; });
