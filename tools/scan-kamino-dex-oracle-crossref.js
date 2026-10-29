const fs = require("fs");
const path = require("path");
const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "kamino-dex-oracle-crossref.json");

const scopeCfg = JSON.parse(fs.readFileSync(path.join(WORKSPACE, "targets/kamino-scope/configs/mainnet/3NJYftD5sjVfxSnUdZ1wVML8f3aC6mp1CXCL6L7TnU8C.json"), "utf8"));
const oracleCfg = JSON.parse(fs.readFileSync(path.join(WORKSPACE, "reports/raw/fast/kamino-oracle-config.json"), "utf8"));
const meteoraPools = JSON.parse(fs.readFileSync(path.join(WORKSPACE, "reports/raw/fast/meteora-dlmm-pools.json"), "utf8"));

// Build Scope label → type map
const scopeLabelMap = {};
for (const [k, v] of Object.entries(scopeCfg)) {
  if (!v || typeof v !== "object") continue;
  scopeLabelMap[k] = { label: v.label || "", type: v.oracle_type || "", mapping: v.oracle_mapping || "" };
}

const reserveRows = oracleCfg.reserves || oracleCfg.rows || [];
const results = [];

for (const r of reserveRows) {
  const scopeChain = r.scopeChain || r.scope_chain || [];
  if (!Array.isArray(scopeChain) || scopeChain.length === 0) continue;
  
  for (let i = 0; i < Math.min(scopeChain.length, 4); i++) {
    const idx = scopeChain[i];
    if (typeof idx !== "number") continue;
    const entry = scopeLabelMap[String(idx)];
    if (!entry) continue;
    
    const type = entry.type.toLowerCase();
    const isDex = type.includes("meteora") || type.includes("orca") || type.includes("raydium");
    if (!isDex) continue;
    
    // Find matching DLMM pool for Meteora
    let poolMatch = null;
    if (type.includes("meteora")) {
      const allPools = meteoraPools.allPools || meteoraPools.pools || [];
      poolMatch = allPools.find(p => p.pubkey === entry.mapping);
    }
    
    results.push({
      reserve: r.symbol || r.asset || "unknown",
      reservePubkey: r.pubkey || r.address || "",
      scopeIdx: idx,
      scopeChainPos: i,
      oracleType: entry.type,
      oracleLabel: entry.label,
      oracleMapping: entry.mapping,
      poolPubkey: entry.mapping,
      poolMatch: poolMatch ? { active_id: poolMatch.active_id, bin_step: poolMatch.bin_step, status: poolMatch.status } : null,
      note: type.includes("meteora") ? "METEORA DLMM — swap exploits active_id" :
            type.includes("orca") ? "ORCA WHIRLPOOL — swap exploits sqrt_price" :
            "RAYDIUM AMMV3 — swap exploits sqrt_price",
    });
  }
}

console.log(`\n=== DEX Oracle Cross-Reference Results ===`);
console.log(`Kamino reserves with DEX oracle types: ${results.length}\n`);

const byType = {};
for (const r of results) {
  const t = r.oracleType;
  if (!byType[t]) byType[t] = [];
  byType[t].push(r);
}

for (const [type, items] of Object.entries(byType)) {
  console.log(`  ${type} (${items.length}):`);
  for (const item of items.slice(0, 5)) {
    console.log(`    ${item.reserve} → ${item.oracleLabel} (idx=${item.scopeIdx}) pool=${item.oracleMapping.slice(0,16)}...`);
  }
  if (items.length > 5) console.log(`    ... and ${items.length - 5} more`);
  console.log("");
}

const artifact = {
  scannedAt: new Date().toISOString(),
  totalReserves: reserveRows.length,
  dexOracleReserves: results.length,
  byType,
  allResults: results,
};
fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2));
console.log(`Artifact: ${OUT}`);
