#!/usr/bin/env node
// scan-meteora-dlmm-pools.js — Phase 1: Enumerate all Meteora DLMM pools on Solana
// Read-only. Queries Solana RPC for all LbPair accounts, decodes key fields.
const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "meteora-dlmm-pools.json");
const TIMEOUT_MS = 60_000;

const DLMM_PROGRAM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const LbPair_DATA_SIZE = 904; // rent-exempt size, actual struct = 896 bytes

function solRpcUrls() {
  const urls = [];
  if (fs.existsSync(RPC_FILE)) {
    for (const line of fs.readFileSync(RPC_FILE, "utf8").split(/\r?\n/).map(x=>x.trim()).filter(Boolean)) {
      if (/solana/i.test(line)) for (const m of line.matchAll(/https?:\/\/[^\s'"<>]+/g)) urls.push(m[0]);
    }
  }
  urls.push("https://api.mainnet-beta.solana.com");
  return [...new Set(urls)];
}

async function solPost(url, body, ms = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  const hdrs = { "content-type": "application/json" };
  if (url.includes("helius") && !url.includes("heliapi")) hdrs.origin = "helius.xyz";
  try {
    const r = await fetch(url, { method: "POST", headers: hdrs, body: JSON.stringify(body), signal: ctrl.signal });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    return j.result;
  } catch (e) { return null; } finally { clearTimeout(t); }
}

async function tryRpc(urls, method, params, ms = 30000) {
  for (const url of urls) {
    const r = await solPost(url, { jsonrpc: "2.0", id: 1, method, params }, ms);
    if (r !== null && r !== undefined) return r;
  }
  return null;
}

function simpleHex(b) { return b.toString("hex"); }
function decodeLbPair(data) {
  if (data.length < 896) return null;
  // active_id at byte 68
  const active_id = data.readInt32LE(68);
  // bin_step at byte 72
  const bin_step = data.readUInt16LE(72);
  // status at byte 74
  const status = data.readUInt8(74);
  // token_x at byte 80 (Pubkey = 32 bytes)
  const token_x = simpleHex(data.slice(80, 112));
  const token_y = simpleHex(data.slice(112, 144));
  const reserve_x = simpleHex(data.slice(144, 176));
  const reserve_y = simpleHex(data.slice(176, 208));
  return { active_id, bin_step, status, token_x, token_y, reserve_x, reserve_y };
}

function computePrice(active_id, bin_step) {
  // price = (1 + bin_step/10000)^active_id
  const base = 1 + bin_step / 10000;
  return Math.pow(base, active_id);
}

async function main() {
  const urls = solRpcUrls();
  console.log(`Solana RPC endpoints: ${urls.length}`);
  console.log(`Scanning Meteora DLMM program: ${DLMM_PROGRAM}\n`);

  // Phase 1a: Get all LbPair accounts
  console.log("Fetching all DLMM pools via getProgramAccounts...");
  const raw = await tryRpc(urls, "getProgramAccounts", [
    DLMM_PROGRAM,
    { encoding: "base64", filters: [{ dataSize: LbPair_DATA_SIZE }] }
  ], 60000);

  if (!raw) {
    console.error("ERROR: Could not fetch DLMM pools from any RPC endpoint.");
    process.exit(1);
  }

  console.log(`Raw accounts returned: ${raw.length}`);

  const MAX_DECODE = 5000;
  const sample = raw.slice(0, MAX_DECODE);

  const pools = [];
  for (const item of sample) {
    try {
      const dataArr = item.account.data;
      if (!Array.isArray(dataArr) || !dataArr[0]) continue;
      const buf = Buffer.from(dataArr[0], "base64");
      if (buf.length < 896) continue;
      const lp = decodeLbPair(buf);
      if (!lp) continue;
      lp.pubkey = item.pubkey;
      lp.price_xy = computePrice(lp.active_id, lp.bin_step);
      pools.push(lp);
    } catch (e) {
      // skip
    }
  }

  console.log(`Successfully decoded: ${pools.length} pools`);

  // Phase 1c: Classify pools
  const category = {
    disabled: pools.filter(p => p.status !== 1),
    active: pools.filter(p => p.status === 1),
    binStepZero: pools.filter(p => p.bin_step === 0),
    binStepLow: pools.filter(p => p.bin_step > 0 && p.bin_step <= 5),
    binStepHigh: pools.filter(p => p.bin_step > 100),
  };

  console.log(`\n=== Pool Classification ===`);
  console.log(`  Total: ${pools.length}`);
  console.log(`  Active (status=1): ${category.active.length}`);
  console.log(`  Disabled/other: ${category.disabled.length}`);
  console.log(`  bin_step=0 (degenerate): ${category.binStepZero.length}`);
  console.log(`  bin_step 1-5: ${category.binStepLow.length}`);
  console.log(`  bin_step >100: ${category.binStepHigh.length}`);

  // Phase 1d: Show top pools by extreme active_id
  const byAbsId = [...pools].sort((a,b) => Math.abs(b.active_id) - Math.abs(a.active_id));
  console.log(`\n=== Extreme Active IDs (furthest from 1:1) ===`);
  for (const p of byAbsId.slice(0, 10)) {
    console.log(`  ${p.pubkey.slice(0,8)}... id=${p.active_id} step=${p.bin_step} price=${p.price_xy.toExponential(4)} status=${p.status}`);
  }

  // Phase 1e: Bin step zero pools (critical — degenerate)
  if (category.binStepZero.length > 0) {
    console.log(`\n=== CRITICAL: bin_step=0 pools ===`);
    for (const p of category.binStepZero) {
      console.log(`  ${p.pubkey} active_id=${p.active_id} status=${p.status}`);
    }
  }

  const artifact = {
    scannedAt: new Date().toISOString(),
    programId: DLMM_PROGRAM,
    totalAccounts: raw.length,
    poolsDecoded: pools.length,
    categories: {
      total: pools.length,
      active: category.active.length,
      disabled: category.disabled.length,
      binStepZero: category.binStepZero.length,
      binStepLow: category.binStepLow.length,
      binStepHigh: category.binStepHigh.length,
    },
    extremeActiveIds: byAbsId.slice(0, 20).map(p => ({
      pubkey: p.pubkey, active_id: p.active_id, bin_step: p.bin_step,
      price: p.price_xy, status: p.status,
      token_x: p.token_x, token_y: p.token_y,
    })),
    binStepZeroPools: category.binStepZero.map(p => ({
      pubkey: p.pubkey, active_id: p.active_id, token_x: p.token_x, token_y: p.token_y,
    })),
    allPools: pools.map(p => ({
      pubkey: p.pubkey, token_x: p.token_x, token_y: p.token_y,
      active_id: p.active_id, bin_step: p.bin_step, price: p.price_xy,
      status: p.status, reserve_x: p.reserve_x, reserve_y: p.reserve_y,
      oracle: p.oracle,
    })),
  };

  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2));
  console.log(`\nArtifact: ${OUT}`);
  console.log(`Total pools: ${pools.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
