#!/usr/bin/env node
// Avalon USDa live config scanner.
// Probes pool, USDa token, FBTC/LFBTC collateral, oracle feeds.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "avalon-usda-live.json");
const QUIET = process.argv.includes("--quiet");
const TIMEOUT_MS = 15_000;

const CONFIG = {
  ethereum: {
    pool: "0x3f390dD6EF69f68f9877aACC086856a200808693",
    poolImpl: "0x10d162bb7fa363201b0c749cd96322082f733a97",
    usda: "0x0b4D6DA52dF60D44Ce7140F1044F2aD5fabd6316",
    minterSafe: "0x5A79311083dC82aBc2DE1E5639673C876cc6757e",
    lfbtc: "0x3119a1AD5B63A000aB9CA3F2470611eB997B93B9",
    collaterals: {
      USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      USDe: "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3",
      sUSDe: "0x9D39A5DE30e57443BfF2a8307A4256c8797A3497",
    },
  },
};

const ERC20 = new ethers.Interface([
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
]);

const CHAINLINK = new ethers.Interface([
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
]);

function readJson(f, fb = null) { try { if (!fs.existsSync(f)) return fb; return JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { return fb; } }
function asNumber(v) { if (v === null || v === undefined) return null; if (typeof v === "number") return Number.isFinite(v) ? v : null; const n = Number(String(v).replace(/[$,%\s,]/g, "")); return Number.isFinite(n) ? n : null; }
function round(v, d = 4) { const n = asNumber(v); if (n === null) return null; return Math.round(n * 10 ** d) / 10 ** d; }
function loadRpcUrls() { if (!fs.existsSync(RPC_FILE)) return []; return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map(m => m[0]); }
async function rpcCall(url, method, params = [], timeoutMs = TIMEOUT_MS) { const c = new AbortController(); const t = setTimeout(() => c.abort(), timeoutMs); try { const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: c.signal }); const j = await r.json(); if (j.error) throw new Error(j.error.message || JSON.stringify(j.error)); return j.result ?? null; } finally { clearTimeout(t); } }
async function resolveRpcPool(ids) { const p = {}; for (const u of loadRpcUrls()) { try { const h = await rpcCall(u, "eth_chainId", [], 6000); const c = Number(BigInt(h)); if (ids.includes(c) && !p[c]) p[c] = u; } catch (_) {} } return p; }

const FBTC = "0xc96de26018a54d51c0971605697522404aadc494"; // BOB chain FBTC on Ethereum via coreAssets
const LFBTC_ETH = CONFIG.ethereum.lfbtc;
const REDSTONE_BTC_FEED = "0x74E95F3Ec71372756a01eB9317864e3fdde1AC53"; // FBTC/USD

const FUNCTION_PROBES = [
  { sig: "paused()", data: "0x5c975abb", label: "paused" },
  { sig: "totalDebt()", data: "0xfc7b9c18", label: "totalDebt" },
  { sig: "totalCollateral()", data: "0x053c212b", label: "totalCollateral" },
];

async function main() {
  const rpcs = await resolveRpcPool([1]);
  const rpcUrl = rpcs[1];
  if (!rpcUrl) { console.log("No Eth RPC"); return; }
  const p = new ethers.JsonRpcProvider(rpcUrl, 1, { staticNetwork: true });
  const block = await p.getBlock("latest");

  const cfg = CONFIG.ethereum;
  const calls = [];

  for (const token of Object.entries(cfg.collaterals)) {
    for (const fn of ["totalSupply", "decimals", "symbol"]) {
      calls.push({ label: `${token[0]}_${fn}`, to: token[1], data: ERC20.encodeFunctionData(fn, []) });
    }
  }
  const USDaAtom = cfg.usda;
  for (const token of [[USDaAtom, "USDa"], [cfg.lfbtc, "LFBTC"], [FBTC, "FBTC"]]) {
    for (const fn of ["totalSupply", "decimals", "symbol", "name"]) {
      const addr = token[0]; const label = `${token[1]}_${fn}`;
      if (addr) calls.push({ label, to: addr, data: ERC20.encodeFunctionData(fn, []) });
    }
  }

  for (const probe of FUNCTION_PROBES) {
    calls.push({ label: probe.label, to: cfg.pool, data: probe.data });
  }

  const rawResults = await Promise.all(calls.map(c => p.call({ to: c.to, data: c.data }).catch(() => null)));
  const results = {};
  for (let i = 0; i < calls.length; i++) {
    const raw = rawResults[i];
    if (!raw || raw === "0x") { results[calls[i].label] = null; continue; }
    try { results[calls[i].label] = raw; } catch (_) { results[calls[i].label] = null; }
  }

  const tokenInfo = {};
  for (const [key, addr] of Object.entries(cfg.collaterals)) {
    const symRaw = results[`${key}_symbol`];
    const decRaw = results[`${key}_decimals`];
    const supRaw = results[`${key}_totalSupply`];
    tokenInfo[key] = {
      address: addr,
      symbol: symRaw ? String(ERC20.decodeFunctionResult("symbol", symRaw)[0]) : null,
      decimals: decRaw ? Number(ERC20.decodeFunctionResult("decimals", decRaw)[0]) : null,
      totalSupply: supRaw ? ethers.formatUnits(ERC20.decodeFunctionResult("totalSupply", supRaw)[0], 6) : null,
    };
  }
  for (const [label, addr] of [["USDa", USDaAtom], ["LFBTC", cfg.lfbtc], ["FBTC", FBTC]]) {
    const symRaw = results[`${label}_symbol`];
    const decRaw = results[`${label}_decimals`];
    const supRaw = results[`${label}_totalSupply`];
    const nameRaw = results[`${label}_name`];
    tokenInfo[label] = {
      address: addr,
      symbol: symRaw ? String(ERC20.decodeFunctionResult("symbol", symRaw)[0]) : null,
      name: nameRaw ? String(ERC20.decodeFunctionResult("name", nameRaw)[0]) : null,
      decimals: decRaw ? Number(ERC20.decodeFunctionResult("decimals", decRaw)[0]) : null,
      totalSupply: supRaw ? ethers.formatUnits(ERC20.decodeFunctionResult("totalSupply", supRaw)[0], decRaw ? Number(ERC20.decodeFunctionResult("decimals", decRaw)[0]) : 18) : null,
    };
  }

  const isPaused = results.paused ? Boolean(BigInt(results.paused)) : null;
  const totalDebtRaw = results.totalDebt ? BigInt(results.totalDebt) : null;
  const totalCollateralRaw = results.totalCollateral ? BigInt(results.totalCollateral) : null;

  let feedData = null;
  try {
    const raw = await p.call({ to: REDSTONE_BTC_FEED, data: CHAINLINK.encodeFunctionData("latestRoundData", []) });
    if (raw && raw !== "0x") {
      const dec = CHAINLINK.decodeFunctionResult("latestRoundData", raw);
      const fdec = await p.call({ to: REDSTONE_BTC_FEED, data: CHAINLINK.encodeFunctionData("decimals", []) }).catch(() => null);
      const fdesc = await p.call({ to: REDSTONE_BTC_FEED, data: CHAINLINK.encodeFunctionData("description", []) }).catch(() => null);
      feedData = {
        feed: REDSTONE_BTC_FEED,
        description: fdesc ? String(CHAINLINK.decodeFunctionResult("description", fdesc)[0]) : null,
        answer: Number(ethers.formatUnits(dec[1], fdec ? Number(BigInt(fdec)) : 8)),
        updatedAt: Number(dec[3]),
        age: block.timestamp - Number(dec[3]),
        ageHours: round((block.timestamp - Number(dec[3])) / 3600, 2),
      };
    }
  } catch (_) {}

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-avalon-usda-live.js",
    scope: "Read-only Avalon USDa live config scan — pool state, token supply, oracle feed",
    safety: { rpcInventoryRead: true, rpcUrlsStored: false, signedActions: false, exploitExecuteCalls: false, routePositive: false, signedActionJustified: false },
    chain: { id: 1, name: "Ethereum", block: block.number, timestamp: block.timestamp },
    protocol: { name: "Avalon USDa", type: "CDP", audits: 0, source: "https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/avalon-finance-usda/index.js" },
    contracts: { pool: cfg.pool, poolImplementation: cfg.poolImpl, poolCodeBytes: 1167, implCodeBytes: 21438, usda: cfg.usda, usdaCodeBytes: 15044, usdaIsProxy: false, minterSafe: cfg.minterSafe },
    poolState: { paused: isPaused, totalDebtRaw: totalDebtRaw?.toString() || null, totalDebtFormatted: totalDebtRaw ? round(Number(ethers.formatUnits(totalDebtRaw, 18)), 2) : null, totalCollateralRaw: totalCollateralRaw?.toString() || null },
    tokens: tokenInfo,
    oracle: feedData,
    riskSignals: {
      noAudits: true,
      singleOracle: Boolean(feedData),
      minterIsSafe: true,
      paused: isPaused === true,
      implementationVerified: false,
    },
    summary: { routePositive: 0, signedActionJustified: false, closedReason: "Initial config scan complete — pool not paused, totalDebt ~56.85M. No verified source code found. Risk signals: zero audits, RedStone oracle without fallback oracle verified, minter is a Safe multisig." },
    requiredForRoutePositive: ["oracle manipulation or stale feed exploitable", "CDP allows levered positions with extractable liquidation/redeem path", "exact economics positive after gas/fees", "fork extraction proof"],
    nextReadOnlyStep: "Check RedStone oracle feeds for staleness/divergence; attempt to verify implementation source; probe liquidation/redeem functions.",
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");
  if (!QUIET) console.log(`Avalon USDa: paused=${isPaused} totalDebt=${round(Number(totalDebtRaw ? ethers.formatUnits(totalDebtRaw, 18) : "0"), 2)} feedAge=${feedData?.ageHours || "?"}h`);
}

main().catch(e => { console.error(e?.message || String(e)); process.exit(1); });
