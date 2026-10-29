#!/usr/bin/env node
// scan-fee-on-transfer-rebase.js — Fee-on-transfer token + rebase oracle timing scanner
// Detects tokens with non-standard transfer behavior that could amplify when used as collateral.
// Workspace: C:\_Work\__EVM_AUDIT

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const OUT = path.join(RAW_DIR, "fee-on-transfer-rebase.json");
const QUIET = process.argv.includes("--quiet");

const KNOWN_FEE_TOKENS = [
  { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", chain: "Ethereum", chainId: 1, note: "may charge fee when fee switch active" },
  { symbol: "PAXG", address: "0x45804880De22913dAFE09f4980848ECE6EcbAf78", chain: "Ethereum", chainId: 1, note: "0.02% fee on transfer" },
  { symbol: "sBTC", address: "0xfe18be6b3bd88a2d2a7f928d00292e7a9963cfc6", chain: "Ethereum", chainId: 1, note: "rebasing" },
];

const REBASE_TOKENS = [
  { symbol: "stETH", address: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84", chain: "Ethereum", chainId: 1, dailyRebase: true },
  { symbol: "aUSDC", address: "0x98C23E9d8f34FEFb1B7BD6a91B8FFD8fcFeDA052", chain: "Ethereum", chainId: 1, note: "Aave V3 aToken, rebases on interest accrual" },
  { symbol: "cUSDCv3", address: "0xc3d688B66703497DAA19211EEdff47f25384cdc3", chain: "Ethereum", chainId: 1, note: "Compound V3, rebases via exchange rate" },
];

const CONSUMER_FILES = [
  path.join(RAW_DIR, "consumer-first-high-ltv-collateral.json"),
  path.join(RAW_DIR, "aave-euler-silo-consumer-graph.json"),
  path.join(RAW_DIR, "erc4626-consumer-joiner.json"),
  path.join(RAW_DIR, "morpho-flashloan-token-overlap.json"),
];

function readJson(file, fallback = {}) { try { if (!fs.existsSync(file)) return fallback; return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return fallback; } }
function asNumber(value) { if (value === null || value === undefined) return null; if (typeof value === "number") return Number.isFinite(value) ? value : null; if (typeof value === "boolean") return value ? 1 : 0; const n = Number(String(value).replace(/[$,%\s,]/g, "")); return Number.isFinite(n) ? n : null; }
function round(value, decimals = 6) { const n = asNumber(value); if (n === null) return null; const factor = 10 ** decimals; return Math.round(n * factor) / factor; }
function addr(v) { const t = String(v || "").toLowerCase(); return /^0x[0-9a-f]{40}$/.test(t) ? t : null; }

function loadRpcUrls() { if (!fs.existsSync(RPC_FILE)) return []; return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map(m => m[0]); }
async function rpcCall(url, method, params = [], ms = 15000) { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); try { const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: c.signal }); const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result ?? null; } finally { clearTimeout(t); } }
async function resolveRpc(chainId) { for (const url of loadRpcUrls()) { try { const id = Number(BigInt(await rpcCall(url, "eth_chainId", [], 6000))); if (id === chainId) return url; } catch (_) {} } return null; }

function isCollateralInArtifacts(tokenAddr) {
  const lower = addr(tokenAddr);
  if (!lower) return [];
  const matches = [];
  for (const file of CONSUMER_FILES) {
    try {
      const artifact = readJson(file);
      const scanObject = (obj) => {
        if (!obj || typeof obj !== "object") return;
        for (const key of ["collateralAsset", "collateral", "borrowAsset", "loanAsset", "reserve", "asset", "token", "producer"]) {
          const target = obj[key];
          if (!target) continue;
          const targetAddr = addr(target.address || target);
          if (targetAddr === lower) {
            matches.push({
              source: path.relative(WORKSPACE, file).replace(/\\/g, "/"),
              protocol: obj.protocol || key,
              ltv: asNumber(obj.ltv ?? obj.lltv),
              routeLiquidityUsd: round(asNumber(obj.routeLiquidityUsd), 2),
              file: path.basename(file),
            });
          }
        }
        for (const v of Object.values(obj)) { if (v && typeof v === "object" && !Array.isArray(v)) scanObject(v); }
      };
      // Top-level arrays: topRows, results, producers, matches
      for (const arrKey of ["topRows", "results", "producers", "matches", "rows", "topMatches", "highLtvRowsDetail", "watchCandidates"]) {
        if (Array.isArray(artifact[arrKey])) artifact[arrKey].forEach(scanObject);
      }
      scanObject(artifact);
    } catch (_) {}
  }
  return matches;
}

async function checkStethRebase(rpc) {
  try {
    const balanceRaw = await rpcCall(rpc, "eth_call", [{ to: REBASE_TOKENS[0].address, data: "0x70a08231000000000000000000000000" + "0".repeat(64) }, "latest"]);
    const totalSupplyRaw = await rpcCall(rpc, "eth_call", [{ to: REBASE_TOKENS[0].address, data: "0x18160ddd" }, "latest"]);
    const tsRaw = await rpcCall(rpc, "eth_blockNumber", [], 6000);
    const blockNum = parseInt(tsRaw, 16);
    const blockData = await rpcCall(rpc, "eth_getBlockByNumber", [tsRaw, false]);
    const blockTs = parseInt(blockData?.timestamp || "0", 16);
    return { block: blockNum, blockTimestamp: blockTs, stEthTotalSupply: balanceRaw ? Number(BigInt(balanceRaw)) / 1e18 : null, dailyRebaseTimeUTC: "approx 18:00 UTC", lastRebaseAgeHours: blockTs ? (Math.floor(Date.now() / 1000) - blockTs) / 3600 : null };
  } catch (_) { return { error: _.message }; }
}

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const rpc = await resolveRpc(1);
  const stethData = rpc ? await checkStethRebase(rpc) : { error: "no RPC" };

  const rows = [];
  for (const token of [...KNOWN_FEE_TOKENS, ...REBASE_TOKENS]) {
    const consumerMatches = isCollateralInArtifacts(token.address);
    const hasCollateralRole = consumerMatches.filter(m => m.protocol && m.ltv > 0).length > 0;
    const score = Math.round(
      (hasCollateralRole ? 40 : 0)
      + (token.dailyRebase ? 25 : 0)
      + Math.min(30, (token.note?.includes("fee") ? 20 : 0))
      + Math.min(15, consumerMatches.length * 3)
    );
    rows.push({
      token: { symbol: token.symbol, address: token.address, chain: token.chain },
      tokenType: token.dailyRebase ? "rebase" : "fee-on-transfer",
      collateralConsumerMatches: consumerMatches.length,
      hasCollateralRole,
      consumers: consumerMatches.slice(0, 8),
      note: token.note || null,
      dailyRebase: Boolean(token.dailyRebase),
      watchCandidate: hasCollateralRole && consumerMatches.length > 0,
      routePositive: false,
      priorityScore: score,
      blockers: [
        hasCollateralRole ? "Token has fee/rebase behavior AND is used as lending collateral — accepted-value drift risk" : "Not found as lending collateral in current artifacts",
        "No live on-chain transfer-fee / rebase divergence proven in this scan",
        "No exact borrow/unwind route quote",
        "No fork extraction proof",
      ].filter(Boolean),
    });
  }

  rows.sort((a, b) => b.priorityScore - a.priorityScore);
  const watchCount = rows.filter(r => r.watchCandidate).length;

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-fee-on-transfer-rebase.js",
    scope: "Read-only fee-on-transfer and rebase token collateral risk scanner",
    safety: { rpcInventoryRead: true, rpcUrlsStored: false, signedActions: false, routePositive: false, executablNow: false, signedActionJustified: false },
    stethContext: stethData,
    summary: { tokensScanned: rows.length, feeTokens: KNOWN_FEE_TOKENS.length, rebaseTokens: REBASE_TOKENS.length, watchCandidates: watchCount, routePositive: 0, executablenow: 0, signedActionJustified: false, blocker: "No live fee/rebase divergence proven at current block" },
    topRows: rows.slice(0, 20),
    rows,
    nextRoutePositiveCriteria: ["token has active transfer fee that creates balance delta", "token is used as lending collateral with material LTV and borrow cash", "accepted value diverges from realizable value by more than LTV haircut + costs", "exact borrow/exit economics are positive at route size", "fork proof demonstrates net extraction"],
  };

  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");
  console.log(`Fee-on-transfer/rebase: tokens=${rows.length} watch=${watchCount} routePositive=0`);
  if (!QUIET) console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
}
main().catch(e => { console.error(e); process.exit(1); });
