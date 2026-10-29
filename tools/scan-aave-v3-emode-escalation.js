#!/usr/bin/env node
// scan-aave-v3-emode-escalation.js — Aave V3 eMode category escalation risk scanner
// Checks whether eMode categories allow correlated assets at higher LTV than their actual correlation warrants.
// eMode allows up to 97% LTV for "correlated" pairs (e.g., stablecoins).
// If eMode is misconfigured or can be triggered for uncorrelated assets, attacker can over-borrow.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const OUT = path.join(RAW_DIR, "aave-v3-emode-escalation.json");
const QUIET = process.argv.includes("--quiet");

const AAVE_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const CHAIN_ID = 1;

const AAVE_ABI = [
  "function getEModeCategoryData(uint8) view returns (tuple(uint16 ltv, uint16 liquidationThreshold, uint16 liquidationBonus, address priceSource, string label))",
  "function getReservesList() view returns (address[])",
];

const ERC20 = new ethers.Interface(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);

function loadRpcUrls() { if (!fs.existsSync(RPC_FILE)) return []; return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map(m => m[0]); }
async function rpcCall(url, method, params = [], ms = 15000) { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); try { const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: c.signal }); const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result ?? null; } finally { clearTimeout(t); } }
async function resolveRpc(chainId) { for (const url of loadRpcUrls()) { try { const id = Number(BigInt(await rpcCall(url, "eth_chainId", [], 6000))); if (id === chainId) return url; } catch (_) {} } return null; }
function asNumber(value) { if (value === null || value === undefined) return null; if (typeof value === "number") return Number.isFinite(value) ? value : null; const n = Number(String(value).replace(/[$,%\s,]/g, "")); return Number.isFinite(n) ? n : null; }
function round(value, decimals = 6) { const n = asNumber(value); if (n === null) return null; const factor = 10 ** decimals; return Math.round(n * factor) / factor; }
function addr(v) { const t = String(v || "").toLowerCase(); return /^0x[0-9a-f]{40}$/.test(t) ? t : null; }
function decodeConfig(raw) { const d = BigInt(String(raw || 0n)); return { ltv: Number(d & 0xffffn) / 100, lt: Number((d >> 16n) & 0xffffn) / 100, liqBonus: Number((d >> 32n) & 0xffffn) / 100, active: Boolean((d >> 56n) & 1n), borrowingEnabled: Boolean((d >> 58n) & 1n), reserveEModeCategory: Number((d >> 114n) & 0xffn), }; }

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const rpc = await resolveRpc(CHAIN_ID);
  if (!rpc) throw new Error("No ETH RPC");
  const provider = new ethers.JsonRpcProvider(rpc, CHAIN_ID, { staticNetwork: true });

  // Read eMode categories (0-255, but typically 0-4 are used)
  const categories = [];
  for (let i = 1; i <= 10; i++) {
    try {
      const raw = await rpcCall(rpc, "eth_call", [{ to: AAVE_POOL, data: new ethers.Interface(AAVE_ABI).encodeFunctionData("getEModeCategoryData", [i]) }, "latest"]);
      if (!raw || raw === "0x") continue;
      const decoded = new ethers.Interface(AAVE_ABI).decodeFunctionResult("getEModeCategoryData", raw)[0];
      if (Number(decoded.ltv) === 0) continue;
      categories.push({ id: i, ltv: Number(decoded.ltv) / 100, lt: Number(decoded.liquidationThreshold) / 100, liqBonus: Number(decoded.liquidationBonus) / 100, label: decoded.label, priceSource: decoded.priceSource });
    } catch (_) { break; }
  }

  // Read reserve list and filter by eMode enrollment
  const poolIface = new ethers.Interface(AAVE_ABI);
  // Use raw eth_call for getReserveData to avoid tuple parsing issues
  const reservesRaw = await rpcCall(rpc, "eth_call", [{ to: AAVE_POOL, data: "0x35ea6a75000000000000000000000000" + "0000000000000000000000000000000000000001" }, "latest"]);
  // getReservesList returns address[]
  const reservesEncoded = await rpcCall(rpc, "eth_call", [{ to: AAVE_POOL, data: poolIface.encodeFunctionData("getReservesList", []) }, "latest"]);
  const reserves = ethers.AbiCoder.defaultAbiCoder().decode(["address[]"], reservesEncoded)[0].map(a => ethers.getAddress(a));

  const rows = [];
  for (const reserve of reserves) {
    // getReserveData via raw eth_call: selector 0x35ea6a75 + padded address
    const selector = "0x35ea6a75";
    const padded = ethers.zeroPadValue(reserve, 32);
    const rdRaw = await rpcCall(rpc, "eth_call", [{ to: AAVE_POOL, data: selector + padded.slice(2) }, "latest"]);
    if (!rdRaw || rdRaw === "0x") continue;
    const decoded = ethers.AbiCoder.defaultAbiCoder().decode(["tuple(uint256 data,uint128,uint128,uint128,uint128,uint128,uint40,uint16,address,address,address,address,uint128,uint128,uint128)"], rdRaw)[0];
    const cfg = decodeConfig(decoded.data);
    const emode = cfg.reserveEModeCategory;
    if (emode === 0) continue; // Not enrolled in any eMode

    const symRaw = await rpcCall(rpc, "eth_call", [{ to: reserve, data: "0x95d89b41" }, "latest"]);
    let symbol = "unknown";
    try { symbol = ethers.AbiCoder.defaultAbiCoder().decode(["string"], symRaw)[0]; } catch (_) {}

    const cat = categories.find(c => c.id === emode);
    const ltvBoost = cat ? cat.ltv - cfg.ltv : 0;
    const score = Math.round(
      Math.min(35, (cat?.ltv || 0) * 35)
      + (ltvBoost > 0.15 ? 25 : ltvBoost > 0.10 ? 15 : ltvBoost > 0.05 ? 5 : 0)
      + (cat ? Math.min(20, cat.ltv - 0.90 > 0 ? (cat.ltv - 0.90) * 100 : 0) : 0)
      + (cfg.borrowingEnabled ? 10 : -20)
      + (cfg.active ? 5 : -20)
    );

    rows.push({
      reserve: addr(reserve),
      symbol,
      baseLtv: round(cfg.ltv, 4),
      baseLt: round(cfg.lt, 4),
      eModeId: emode,
      eMode: cat,
      eModeLtv: round(cat?.ltv, 4),
      ltvBoost: round(ltvBoost, 4),
      borrowingEnabled: cfg.borrowingEnabled,
      active: cfg.active,
      riskScore: score,
      watchCandidate: score >= 50 && cfg.borrowingEnabled && cfg.active,
      routePositive: false,
      blockers: [
        score >= 50 ? "High eMode LTV boost — asset may be treated as correlated when it's not" : null,
        !cfg.borrowingEnabled ? "Borrowing not enabled" : null,
        !cfg.active ? "Reserve not active" : null,
        "No eMode depeg or category-escape route proven",
        "No exact borrow/exit economics",
        "No fork extraction proof",
      ].filter(Boolean),
    });
  }

  rows.sort((a, b) => b.riskScore - a.riskScore);

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-aave-v3-emode-escalation.js",
    scope: "Read-only Aave V3 eMode category escalation risk scanner",
    safety: { rpcInventoryRead: true, rpcUrlsStored: false, signedActions: false, routePositive: false, executablNow: false, signedActionJustified: false },
    eModeCategories: categories,
    summary: { categoriesFound: categories.length, reservesScanned: reserves.length, reservesInEmode: rows.length, watchCandidates: rows.filter(r => r.watchCandidate).length, routePositive: 0, executablenow: 0, signedActionJustified: false, blocker: "eMode category escalation not proven; all enrolled reserves require user opt-in and correlated-asset depeg" },
    topRows: rows.slice(0, 20),
    rows,
    nextRoutePositiveCriteria: ["eMode category pair is actually uncorrelated (e.g., volatile + stable at 97% LTV)", "attacker can force eMode enrollment for victim", "borrow capacity exceeds liquidation buffer after depeg", "exact unwind positive after gas/slippage", "fork proof"],
  };

  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");
  console.log(`Aave eMode: categories=${categories.length} emodeReserves=${rows.length} watch=${rows.filter(r => r.watchCandidate).length} routePositive=0`);
  if (!QUIET) console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
}
main().catch(e => { console.error(e); process.exit(1); });
