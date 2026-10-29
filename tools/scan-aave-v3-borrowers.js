#!/usr/bin/env node
// scan-aave-v3-borrowers.js — Multi-chain Aave V3 borrower scanner
// Uses shared-rpc for endpoint resolution + getLogs + eth_call
const fs = require("fs");
const path = require("path");
const { rpcCall, resolveRpcPool } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "aave-v3-multichain-borrowers.json");

const AAVE_POOLS = {
  1:     "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
  8453:  "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
  42161: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  10:    "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  137:   "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  43114: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  100:   "0xb50201558B00496A145fE76f7424749556E326D8",
  534352:"0x11fCfe756c05AD438e312a7fd934381537D3cFfe",
  56:    "0x6807dc923806fE8Fd134338EABCA509979a7e0cB",
};
const CHAIN_IDS = Object.keys(AAVE_POOLS).map(Number);
const chainNames = {1:"ETH",8453:"Base",42161:"Arb",10:"OP",137:"Poly",43114:"Avax",100:"Gno",534352:"Scroll",56:"BSC"};

function decodeHF(raw) {
  if (!raw || raw.length < 386) return null;
  const w = raw.slice(2);
  return {
    collateral: Number(BigInt("0x" + w.slice(0, 64))) / 1e8,
    debt: Number(BigInt("0x" + w.slice(64, 128))) / 1e8,
    hf: Number(BigInt("0x" + w.slice(320, 384))) / 1e18,
  };
}

async function findBorrowers(rpc, pool) {
  const blockHex = await rpcCall(rpc, "eth_blockNumber");
  if (!blockHex) return [];
  const block = parseInt(blockHex, 16);
  const logs = await rpcCall(rpc, "eth_getLogs", [{ fromBlock: "0x" + (block - 10000).toString(16), toBlock: "latest", address: pool }], 20000);
  if (!Array.isArray(logs)) return [];
  return [...new Set(logs.map(l => l.topics[1]).filter(a => a && a.length === 66).map(a => "0x" + a.slice(26)))].slice(0, 200);
}

async function scanChain(name, chainId, pool, rpc) {
  console.log(`${name} (c${chainId}, getLogs)...`);
  const borrowers = await findBorrowers(rpc, pool);
  console.log(`  Found ${borrowers.length} borrowers`);
  const results = [];
  for (const b of borrowers) {
    const raw = await rpcCall(rpc, "eth_call", [{ to: pool, data: "0xbf92857c" + "000000000000000000000000" + b.slice(2) }, "latest"]);
    if (!raw) continue;
    const d = decodeHF(raw);
    if (!d || d.debt < 5000 || d.hf > 1.05) continue;
    results.push({ address: b, hf: d.hf.toFixed(4), debtUsd: Math.round(d.debt), collateralUsd: Math.round(d.collateral), estProfitUsd: Math.round(d.debt * 0.50 * 0.05), distanceBps: ((d.hf - 1) * 10000).toFixed(1) });
  }
  results.sort((a,b) => b.debtUsd - a.debtUsd);
  console.log(`  Near-liquidation (HF<1.05): ${results.length}`);
  for (const b of results.slice(0, 5)) console.log(`  ${b.address.slice(0,12)}... HF=${b.hf} debt=$${(b.debtUsd/1e6).toFixed(2)}M dist=${b.distanceBps}bps`);
  return results;
}

async function main() {
  console.log("Aave V3 Multi-Chain Scanner\n");
  const allResults = {};
  const pool = await resolveRpcPool(CHAIN_IDS);
  console.log(`Resolved ${Object.keys(pool).length}/${CHAIN_IDS.length} chains\n`);
  for (const chainId of CHAIN_IDS) {
    const rpc = pool[chainId]; const poolAddr = AAVE_POOLS[chainId];
    if (!rpc || !poolAddr) { allResults[chainId] = { error: "no-rpc-or-pool" }; continue; }
    try { const borrowers = await scanChain(chainNames[chainId]||`c${chainId}`, chainId, poolAddr, rpc); allResults[chainId] = { chainId, pool: poolAddr, borrowers, total: borrowers.length }; } catch (e) { allResults[chainId] = { error: e.message?.slice(0,80) }; }
  }
  console.log("\n=== Summary ===");
  let grandTotal = 0;
  for (const [cid, r] of Object.entries(allResults)) {
    const name = chainNames[Number(cid)]||`c${cid}`;
    if (r.error) { console.log(`  ${name}: ${r.error}`); continue; }
    grandTotal += r.total;
    console.log(`  ${name}: ${r.total} near-liq (${r.borrowers?.[0]?.debtUsd>0?'$'+Math.round(r.borrowers[0].debtUsd/1e6)+'M top':'none'})`);
  }
  console.log(`  TOTAL: ${grandTotal} near-liquidation across ${Object.keys(allResults).filter(c=>!allResults[c].error).length} chains`);
  fs.writeFileSync(OUT, JSON.stringify({ scannedAt: new Date().toISOString(), chains: Object.keys(allResults).length, results: allResults, totalNearLiq: grandTotal }, null, 2));
  console.log(`\nArtifact: ${OUT}`);
}
main().catch(e => { console.error(e); process.exit(1); });
