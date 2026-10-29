#!/usr/bin/env node
// Read-only LRT/LST multi-protocol collateral inventory scanner.
// Lists LRT/LST tokens accepted as high-LLTV collateral in Morpho/Aave/Euler with material borrow liquidity.
// Does NOT attempt live oracle reads (trusts the protocol's own USD normalization via API).
// RPC URLs are resolved in memory only and never printed or stored.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "lrt-oracle-drift-routes.json");
const QUIET = process.argv.includes("--quiet");

const CHAIN_ID = 1;
const CHAIN_NAME = "Ethereum";
const TIMEOUT_MS = Number(process.env.LRT_ORACLE_TIMEOUT_MS || "15000");

const AAVE_V3_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const EULER_FACTORY = "0x29a56a1b8214D9Cf7c5561811750D5cBDb45CC8e";

const LRT_TOKENS = [
  { symbol: "weETH", address: "0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee" },
  { symbol: "ezETH", address: "0xbf5495Efe5DB9ce00f80364C8B423567e58d2110" },
  { symbol: "rsETH", address: "0xA1290d69c65A6Fe4DF752f95823fae25cB99e5A7" },
  { symbol: "eETH", address: "0x35fA164735182de50811E8e2E824cFb9B6118ac2" },
  { symbol: "wstETH", address: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0" },
  { symbol: "rETH", address: "0xae78736Cd615f374D3085123A210448E74Fc6393" },
  { symbol: "cbETH", address: "0xBe9895146f7af43049ca1c1AE358B0541Ea49704" },
  { symbol: "mETH", address: "0xd5F7838F5C461fefF7FE49ea5ebaF7728bB0ADfa" },
  { symbol: "sfrxETH", address: "0xac3E018457B222d93114458476f3E3416Abbe38F" },
  { symbol: "swETH", address: "0xf951E335afb289353dc249e82926178EaC7DEd78" },
];

const CONSUMER_ARTIFACTS = [
  "consumer-first-high-ltv-collateral.json",
  "aave-euler-silo-consumer-graph.json",
];

const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
]);

const AAVE_POOL = new ethers.Interface([
  "function getReservesList() view returns (address[])",
  "function getReserveData(address asset) view returns (tuple(uint256 data) configuration,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,uint16 id,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint128 accruedToTreasury,uint128 unbacked,uint128 isolationModeTotalDebt)",
]);

const EVAULT = new ethers.Interface([
  "function asset() view returns (address)",
  "function cash() view returns (uint256)",
  "function LTVBorrow(address collateral) view returns (uint16)",
  "function LTVList() view returns (address[])",
  "function symbol() view returns (string)",
]);

const GENERIC_FACTORY = new ethers.Interface([
  "function getProxyListLength() view returns (uint256)",
  "function getProxyListSlice(uint256 start,uint256 end) view returns (address[])",
]);

function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function normalizeAddress(value) { try { return ethers.getAddress(value); } catch (_) { return null; } }
function lowerAddress(value) { const a = normalizeAddress(value); return a ? a.toLowerCase() : null; }
function asNumber(value) { if (value === null || value === undefined) return null; if (typeof value === "number") return Number.isFinite(value) ? value : null; const text = String(value).replace(/[$,%\s,_]/g, ""); if (!text) return null; const n = Number(text); return Number.isFinite(n) ? n : null; }
function round(value, decimals = 6) { const n = asNumber(value); if (n === null) return null; const factor = 10 ** decimals; return Math.round(n * factor) / factor; }
function strip0x(value) { return String(value || "").replace(/^0x/i, ""); }
function wordAt(raw, index) { const hex = strip0x(raw); const start = index * 64; if (!hex || hex.length < start + 64) return null; return `0x${hex.slice(start, start + 64)}`; }

function decodeAaveConfig(data) {
  const raw = BigInt(data || 0n);
  const mask16 = 0xffffn;
  return { ltv: Number(raw & mask16) / 10_000, lt: Number((raw >> 16n) & mask16) / 10_000, active: Boolean((raw >> 56n) & 1n), borrowingEnabled: Boolean((raw >> 58n) & 1n), paused: Boolean((raw >> 60n) & 1n) };
}

function loadRpcUrls() { if (!fs.existsSync(RPC_FILE)) return []; return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]); }
async function rpcCall(url, method, params = [], timeoutMs = TIMEOUT_MS) { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs); try { const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: controller.signal }); const json = await res.json(); if (json.error) throw new Error(json.error.message || JSON.stringify(json.error)); return json.result ?? null; } finally { clearTimeout(timer); } }
async function resolveRpcUrl(chainId) { for (const url of loadRpcUrls()) { try { const id = Number(BigInt(await rpcCall(url, "eth_chainId", [], 6000))); if (id === chainId) return url; } catch (_) {} } return null; }
async function fetchJson(url, options = {}) { const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), options.timeoutMs || TIMEOUT_MS); try { const res = await fetch(url, { ...options, signal: ctl.signal }); if (!res.ok) throw new Error(`HTTP ${res.status}`); return await res.json(); } finally { clearTimeout(t); } }
async function safeCall(provider, to, data) { try { return await provider.call({ to, data }); } catch (_) { return null; } }
function decodeResult(raw, iface, fn) { if (!raw || raw === "0x") return null; try { return iface.decodeFunctionResult(fn, raw); } catch (_) { return null; } }
function readJson(file) { try { if (!fs.existsSync(file)) return null; return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return null; } }

async function scanMorphoLrt(lrtAddrs) {
  const query = `query($chainIds:[Int!]!, $minSupply:Float!) {
    markets(first:500, orderBy:SupplyAssetsUsd, orderDirection:Desc,
      where:{chainId_in:$chainIds, supplyAssetsUsd_gte:$minSupply}) { items {
        marketId loanAsset { symbol address decimals } collateralAsset { symbol address decimals }
        oracle { address } lltv state { supplyAssetsUsd borrowAssetsUsd liquidityAssetsUsd utilization }
      } }
  }`;
  const json = await fetchJson("https://api.morpho.org/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables: { chainIds: [CHAIN_ID], minSupply: 1 } }), timeoutMs: 30_000 }).catch(() => null);
  const markets = (json?.data?.markets?.items || []).filter((m) => lrtAddrs.has(lowerAddress(m.collateralAsset?.address)));
  const rows = [];
  for (const m of markets) {
    const lltv = (() => { try { return Number(BigInt(String(m.lltv || 0))) / 1e18; } catch (_) { return Number(m.lltv || 0); } })();
    const liq = Number(m.state?.liquidityAssetsUsd || 0);
    const supply = Number(m.state?.supplyAssetsUsd || 0);
    const utilization = m.state?.utilization ?? null;
    const oracle = normalizeAddress(m.oracle?.address);
    rows.push({
      protocol: "Morpho Blue",
      marketId: m.marketId,
      oracle,
      collateral: { symbol: m.collateralAsset?.symbol, address: normalizeAddress(m.collateralAsset?.address) },
      borrowAsset: m.loanAsset,
      lltv, routeLiquidityUsd: round(liq, 2), supplyUsd: round(supply, 2), utilization,
      oracleNeedsVerification: true,
      watchCandidate: lltv >= 0.86 && liq >= 50000,
      routePositive: false,
      blockers: [
        lltv >= 0.86 && liq >= 50000 ? "High-LLTV LRT market with material liquidity; needs oracle premium fork verification" : null,
        lltv < 0.86 ? `LLTV below 86%` : null,
        liq < 50000 ? `Liquidity below $50k` : null,
        "No exact borrow/exit route or fork proof",
      ].filter(Boolean),
    });
  }
  return rows;
}

async function scanAaveLrt(provider, lrtAddrs) {
  const pool = normalizeAddress(AAVE_V3_POOL);
  if (!pool) return [];
  const reservesRaw = await safeCall(provider, pool, AAVE_POOL.encodeFunctionData("getReservesList", []));
  const reserves = (decodeResult(reservesRaw, AAVE_POOL, "getReservesList")?.[0] || []).map(normalizeAddress).filter(Boolean);
  const rows = [];
  for (const reserve of reserves) {
    const lower = lowerAddress(reserve);
    if (!lower || !lrtAddrs.has(lower)) continue;
    const dataRaw = await safeCall(provider, pool, AAVE_POOL.encodeFunctionData("getReserveData", [reserve]));
    if (!dataRaw || dataRaw === "0x") continue;
    const cfg = decodeAaveConfig(BigInt(wordAt(dataRaw, 0) || 0n));
    rows.push({
      protocol: "Aave V3",
      collateral: { address: reserve },
      ltv: cfg.ltv, lt: cfg.lt, active: cfg.active, borrowingEnabled: cfg.borrowingEnabled, paused: cfg.paused,
      watchCandidate: cfg.ltv >= 0.70 && cfg.active && cfg.borrowingEnabled,
      routePositive: false,
      blockers: [cfg.ltv >= 0.70 && cfg.active ? "Aave V3 LRT reserve active at high LTV; needs Chainlink feed staleness check" : "LTV below 70% or reserve inactive", "No exact borrow/exit route or fork proof"].filter(Boolean),
    });
  }
  return rows;
}

async function scanEulerLrt(provider, lrtAddrs) {
  const factory = normalizeAddress(EULER_FACTORY);
  if (!factory) return [];
  const lengthRaw = await safeCall(provider, factory, GENERIC_FACTORY.encodeFunctionData("getProxyListLength", []));
  const length = Number(decodeResult(lengthRaw, GENERIC_FACTORY, "getProxyListLength")?.[0] || 0n);
  const rows = [];
  const start = Math.max(0, length - 400);
  for (let cursor = start; cursor < length; cursor += 100) {
    const end = Math.min(length, cursor + 100);
    const raw = await safeCall(provider, factory, GENERIC_FACTORY.encodeFunctionData("getProxyListSlice", [cursor, end]));
    const evaults = (decodeResult(raw, GENERIC_FACTORY, "getProxyListSlice")?.[0] || []).map(normalizeAddress).filter(Boolean);
    for (const evault of evaults) {
      const [assetRaw, cashRaw, ltvListRaw, symbolRaw] = await Promise.all([
        safeCall(provider, evault, EVAULT.encodeFunctionData("asset", [])),
        safeCall(provider, evault, EVAULT.encodeFunctionData("cash", [])),
        safeCall(provider, evault, EVAULT.encodeFunctionData("LTVList", [])),
        safeCall(provider, evault, EVAULT.encodeFunctionData("symbol", [])),
      ]);
      const asset = normalizeAddress(decodeResult(assetRaw, EVAULT, "asset")?.[0]);
      if (!asset) continue;
      const ltvList = (decodeResult(ltvListRaw, EVAULT, "LTVList")?.[0] || []).map(normalizeAddress).filter(Boolean);
      for (const collateral of ltvList) {
        const collLower = lowerAddress(collateral);
        if (!collLower || !lrtAddrs.has(collLower)) continue;
        const ltvRaw = await safeCall(provider, evault, EVAULT.encodeFunctionData("LTVBorrow", [collateral]));
        const ltv = Number(decodeResult(ltvRaw, EVAULT, "LTVBorrow")?.[0] || 0) / 10_000;
        rows.push({ protocol: "Euler EVK", evault, borrowAsset: normalizeAddress(asset), ltv, collateral: { address: collateral }, watchCandidate: ltv >= 0.90, routePositive: false, blockers: [ltv >= 0.90 ? "Euler EVK high-LTV LRT collateral; needs oracle drift check" : "LTV below 90%", "No exact borrow/exit route or fork proof"].filter(Boolean) });
      }
    }
  }
  return rows;
}

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const lrtAddrs = new Set(LRT_TOKENS.map((t) => t.address.toLowerCase()));
  const rpc = await resolveRpcUrl(CHAIN_ID);
  if (!rpc) throw new Error("No Ethereum RPC endpoint resolved from local inventory");
  const provider = new ethers.JsonRpcProvider(rpc, CHAIN_ID, { staticNetwork: true });
  const blockNumber = await provider.getBlockNumber().catch(() => null);
  const [morpho, aave, euler] = await Promise.all([scanMorphoLrt(lrtAddrs), scanAaveLrt(provider, lrtAddrs), scanEulerLrt(provider, lrtAddrs)]);
  const allRows = [...morpho, ...aave, ...euler];
  const watch = allRows.filter((r) => r.watchCandidate);
  const bp = {};
  for (const r of allRows) bp[r.protocol] = (bp[r.protocol] || 0) + 1;
  const artifact = {
    generatedAt: new Date().toISOString(), scanner: "tools/scan-lrt-oracle-drift-routes.js",
    scope: "Read-only LRT/LST collateral inventory across Morpho Blue, Aave V3, and Euler EVK",
    safety: { rpcInventoryRead: true, rpcUrlsStored: false, envFilesRead: false, privateKeysRead: false, signedActions: false, exploitExecuteCalls: false, forkTransactions: false, routePositive: false, signedActionJustified: false },
    chain: { chainId: CHAIN_ID, name: CHAIN_NAME, blockNumber },
    summary: { morphoRows: morpho.length, aaveRows: aave.length, eulerRows: euler.length, rowsScanned: allRows.length, watchCandidates: watch.length, routePositive: 0, signedActionJustified: false, breakdown: { byProtocol: bp } },
    topRows: allRows.slice().sort((a, b) => Number(b.watchCandidate) - Number(a.watchCandidate) || (b.routeLiquidityUsd || 0) - (a.routeLiquidityUsd || 0)).slice(0, 80), rows: allRows,
    nextRoutePositiveCriteria: ["high-LLTV LRT market with material borrow liquidity", "oracle premium verified via fork staticCall", "exact borrow/exit route positive after gas/flash-fee/slippage", "fork extraction proof demonstrates positive net value"],
  };
  fs.writeFileSync(OUT, JSON.stringify(artifact, jsonReplacer, 2) + "\n");
  console.log(`LRT inventory: rows=${artifact.summary.rowsScanned} watch=${artifact.summary.watchCandidates} routePositive=0`);
  if (!QUIET) console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
}
main().catch((err) => { console.error(err.stack || err.message || String(err)); process.exitCode = 1; });
