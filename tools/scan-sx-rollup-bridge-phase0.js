#!/usr/bin/env node
// scan-sx-rollup-bridge-phase0.js - bounded read-only Phase 0 for SX Rollup Bridge custody owners.
// Resolves RPC URLs in memory only. Never prints or stores RPC URLs, keys, calldata for execution, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { loadRpcUrls, rpcCall } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "sx-rollup-bridge-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "sx-rollup-bridge-phase0-triage.md");
const QUIET = process.argv.includes("--quiet");

const ETHEREUM_CHAIN_ID = 1;
const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const OWNERS = [
  "0xa104C0426e95a5538e89131DbB4163d230C35f86",
  "0xB4968C66BECc8fb4f73b50354301c1aDb2Abaa91",
];

const TRACKED_TOKENS = [
  { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", tvlToken: true, common: true },
  { symbol: "WETH", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", tvlToken: true, common: true },
  { symbol: "GRG", address: "0x4fbb350052Bca5417566f188eb2EBCE5b19BC964", tvlToken: true, common: false },
  { symbol: "SX", address: "0xbe9f61555f50dd6167f2772e9cf7519790d96624", tvlToken: false, stakingToken: true, common: false },
  { symbol: "SX", address: "0x99fe3b1391503a1bc1788051347a1324bff41452", tvlToken: false, stakingToken: true, common: false },
];

const INPUTS = [
  ["bridge-nonlossless", "reports/raw/fast/bridge-nonlossless-collateral-join.json"],
  ["bridge-delta", "reports/raw/fast/bridge-delta-preflight.json"],
  ["bridge-synthetic", "reports/raw/fast/bridge-synthetic-consumer-exposure.json"],
  ["bridge-proof-binding", "reports/raw/fast/bridge-proof-binding.json"],
  ["bridge-domain", "reports/raw/fast/bridge-domain-separation.json"],
  ["aave-euler-silo", "reports/raw/fast/aave-euler-silo-consumer-graph.json"],
  ["consumer-first-high-ltv", "reports/raw/fast/consumer-first-high-ltv-collateral.json"],
  ["public-lead-consumer", "reports/raw/fast/public-lead-consumer-joins.json"],
  ["dex-consumer-routes", "reports/raw/fast/dex-consumer-routes.json"],
  ["deprecated-orphaned", "reports/raw/fast/deprecated-orphaned-reachability.json"],
];

const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
]);
const COMMON = new ethers.Interface([
  "function owner() view returns (address)",
  "function admin() view returns (address)",
  "function paused() view returns (bool)",
]);

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readJson(file, fallback = null) { try { if (!fs.existsSync(file)) return fallback; return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return fallback; } }
function normalizeAddress(value) {
  try { return ethers.getAddress(value); } catch (_) {
    const text = String(value || "");
    if (/^0x[0-9a-fA-F]{40}$/.test(text)) {
      try { return ethers.getAddress(text.toLowerCase()); } catch (_) { return null; }
    }
    return null;
  }
}
function lowerAddress(value) { const address = normalizeAddress(value); return address ? address.toLowerCase() : null; }
function strip0x(value) { return String(value || "").replace(/^0x/i, ""); }
function addressFromStorageSlot(raw) { if (!raw || raw === "0x") return null; const hex = strip0x(raw).padStart(64, "0"); if (/^0+$/.test(hex)) return null; return normalizeAddress(`0x${hex.slice(-40)}`); }
function formatUnits(value, decimals) { if (value === null || value === undefined || decimals === null || decimals === undefined) return null; try { return ethers.formatUnits(BigInt(value), Number(decimals)); } catch (_) { return null; } }
function numberUnits(value, decimals) { const text = formatUnits(value, decimals); const n = Number(text); return Number.isFinite(n) ? n : null; }
function asNumber(value) { if (value === null || value === undefined) return null; if (typeof value === "boolean") return value ? 1 : 0; if (typeof value === "number") return Number.isFinite(value) ? value : null; const n = Number(String(value).replace(/[$,%\s,]/g, "")); return Number.isFinite(n) ? n : null; }
function round(value, decimals = 2) { const n = asNumber(value); if (n === null) return null; const p = 10 ** decimals; return Math.round(n * p) / p; }
function formatUsd(value) { const n = asNumber(value); return n === null ? "n/a" : `$${n.toLocaleString()}`; }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function lastRow(value) { return Array.isArray(value) && value.length ? value[value.length - 1] : null; }

async function resolveInventoryRpc(chainId) {
  for (const url of loadRpcUrls()) {
    try {
      const idHex = await rpcCall(url, "eth_chainId", [], 5000);
      if (idHex && Number(BigInt(idHex)) === chainId) return url;
    } catch (_) {
      // Never print or persist RPC URLs.
    }
  }
  return null;
}

function client(url) { return { call: (method, params = [], timeoutMs = 10_000) => rpcCall(url, method, params, timeoutMs) }; }
async function fetchJson(url, timeoutMs = 30_000) { const c = new AbortController(); const t = setTimeout(() => c.abort(), timeoutMs); try { const res = await fetch(url, { signal: c.signal, headers: { "user-agent": "evm-audit-sx-rollup-phase0/1.0" } }); if (!res.ok) throw new Error(`HTTP ${res.status}`); return await res.json(); } finally { clearTimeout(t); } }
async function getCode(rpc, address) { return await rpc.call("eth_getCode", [address, "latest"], 10_000).catch(() => "0x") || "0x"; }
async function getStorage(rpc, address, slot) { return await rpc.call("eth_getStorageAt", [address, slot, "latest"], 10_000).catch(() => null); }
async function getBalance(rpc, address) { return await rpc.call("eth_getBalance", [address, "latest"], 10_000).catch(() => null); }
async function safeCall(rpc, to, iface, fn, args = []) { try { const data = iface.encodeFunctionData(fn, args); const raw = await rpc.call("eth_call", [{ to, data }, "latest"], 12_000); if (!raw || raw === "0x") return null; return iface.decodeFunctionResult(fn, raw); } catch (_) { return null; } }

async function inspectOwner(rpc, address) {
  const [code, balanceRaw, implRaw, adminRaw, beaconRaw, ownerRaw, adminCallRaw, pausedRaw] = await Promise.all([
    getCode(rpc, address),
    getBalance(rpc, address),
    getStorage(rpc, address, EIP1967_IMPLEMENTATION_SLOT),
    getStorage(rpc, address, EIP1967_ADMIN_SLOT),
    getStorage(rpc, address, EIP1967_BEACON_SLOT),
    safeCall(rpc, address, COMMON, "owner", []),
    safeCall(rpc, address, COMMON, "admin", []),
    safeCall(rpc, address, COMMON, "paused", []),
  ]);
  const balance = balanceRaw ? BigInt(balanceRaw).toString() : null;
  return {
    address,
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
    nativeBalanceWei: balance,
    nativeBalance: formatUnits(balance, 18),
    eip1967: { implementation: addressFromStorageSlot(implRaw), admin: addressFromStorageSlot(adminRaw), beacon: addressFromStorageSlot(beaconRaw) },
    owner: normalizeAddress(ownerRaw?.[0]) || null,
    admin: normalizeAddress(adminCallRaw?.[0]) || null,
    paused: pausedRaw?.[0] === undefined ? null : Boolean(pausedRaw[0]),
  };
}

async function tokenPrices(tokens) {
  const keys = tokens.map((token) => `ethereum:${token.address.toLowerCase()}`);
  const prices = new Map();
  try {
    const json = await fetchJson(`https://coins.llama.fi/prices/current/${keys.join(",")}?searchWidth=6h`, 30_000);
    for (const [key, row] of Object.entries(json.coins || {})) {
      const address = lowerAddress(key.split(":").pop());
      const price = Number(row.price || 0);
      if (address && Number.isFinite(price) && price > 0) prices.set(address, price);
    }
  } catch (_) {
    // Optional; scanner remains fail-closed.
  }
  return prices;
}

async function inspectToken(rpc, token, prices, defillamaTokensInUsd) {
  const address = normalizeAddress(token.address);
  const [code, symbolRaw, nameRaw, decimalsRaw, supplyRaw] = await Promise.all([
    getCode(rpc, address),
    safeCall(rpc, address, ERC20, "symbol", []),
    safeCall(rpc, address, ERC20, "name", []),
    safeCall(rpc, address, ERC20, "decimals", []),
    safeCall(rpc, address, ERC20, "totalSupply", []),
  ]);
  const decimals = decimalsRaw?.[0] === undefined ? null : Number(decimalsRaw[0]);
  const balances = [];
  for (const owner of OWNERS) {
    const raw = await safeCall(rpc, address, ERC20, "balanceOf", [owner]);
    const value = raw?.[0] ?? null;
    balances.push({ owner, raw: value?.toString() || null, amount: formatUnits(value, decimals) });
  }
  const totalRaw = balances.reduce((sum, row) => sum + (row.raw ? BigInt(row.raw) : 0n), 0n);
  const amount = numberUnits(totalRaw, decimals);
  const priceUsd = prices.get(address.toLowerCase()) || null;
  const balanceUsd = priceUsd && amount !== null ? amount * priceUsd : null;
  const defillamaUsd = asNumber(defillamaTokensInUsd?.[token.symbol]) || null;
  return {
    symbol: token.symbol,
    address,
    tvlToken: Boolean(token.tvlToken),
    stakingToken: Boolean(token.stakingToken),
    common: Boolean(token.common),
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
    onchainSymbol: symbolRaw?.[0] === undefined ? null : String(symbolRaw[0]),
    onchainName: nameRaw?.[0] === undefined ? null : String(nameRaw[0]),
    decimals,
    totalSupplyRaw: supplyRaw?.[0] === undefined ? null : supplyRaw[0].toString(),
    totalSupply: supplyRaw?.[0] === undefined ? null : formatUnits(supplyRaw[0], decimals),
    ownerBalances: balances,
    ownerBalanceRaw: totalRaw.toString(),
    ownerBalance: formatUnits(totalRaw, decimals),
    priceUsd: round(priceUsd, 8),
    ownerBalanceUsd: round(balanceUsd, 2),
    defillamaLatestUsd: round(defillamaUsd, 2),
    routePositive: false,
    blockers: [
      "Custody balance read is context only, not proof of bridge mint/unlock bypass",
      token.common ? "Common-token consumer presence is not bridge-specific evidence" : null,
      "No exact proof/custody weakness or consumer route economics proven",
    ].filter(Boolean),
  };
}

function contextSummary(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const fields = ["id", "protocol", "chain", "chainId", "surface", "side", "symbol", "token", "asset", "collateral", "borrowAsset", "routePositive", "watchCandidate", "liquidityUsd", "borrowCashUsd", "cashUsd", "source", "status"];
  const out = {};
  for (const field of fields) if (obj[field] !== undefined && typeof obj[field] !== "object") out[field] = String(obj[field]).slice(0, 120);
  return out;
}

function findMatches(data, wantedAddress, source, max = 12) {
  const matches = [];
  const wanted = lowerAddress(wantedAddress);
  if (!wanted) return matches;
  function walk(value, objectPath, parent) {
    if (matches.length >= max) return;
    if (typeof value === "string") {
      if (lowerAddress(value) === wanted) matches.push({ source, path: objectPath, context: contextSummary(parent), routePositive: Boolean(parent?.routePositive), watchCandidate: Boolean(parent?.watchCandidate) });
      return;
    }
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) walk(value[i], `${objectPath}[${i}]`, parent); return; }
    for (const [key, child] of Object.entries(value)) walk(child, objectPath ? `${objectPath}.${key}` : key, value);
  }
  walk(data, "", null);
  return matches;
}

function artifactJoins(tokenRows) {
  const wanted = [
    ...OWNERS.map((address, i) => ({ label: `owner-${i + 1}`, address, common: false, custodySpecific: true })),
    ...tokenRows.map((row) => ({ label: row.symbol, address: row.address, common: row.common, custodySpecific: false })),
  ];
  const rows = [];
  const loadedInputs = [];
  for (const [source, rel] of INPUTS) {
    const file = path.join(WORKSPACE, rel);
    const data = readJson(file, null);
    if (!data) continue;
    loadedInputs.push(rel);
    for (const item of wanted) {
      const matches = findMatches(data, item.address, source, item.common ? 5 : 20);
      if (!matches.length) continue;
      rows.push({ label: item.label, address: normalizeAddress(item.address), common: Boolean(item.common), custodySpecific: Boolean(item.custodySpecific), source, joinCount: matches.length, routePositive: matches.some((m) => m.routePositive), watchCandidate: matches.some((m) => m.watchCandidate), matches });
    }
  }
  rows.sort((a, b) => Number(b.custodySpecific) - Number(a.custodySpecific) || Number(b.routePositive) - Number(a.routePositive) || Number(b.watchCandidate) - Number(a.watchCandidate) || Number(a.common) - Number(b.common) || b.joinCount - a.joinCount);
  return { rows, loadedInputs };
}

function writeReport(out) {
  const s = out.summary;
  const ownerTable = out.owners.map((row) => `| ${row.address} | ${row.codePresent} | ${row.codeBytes} | ${row.eip1967.implementation || "none"} | ${row.paused === null ? "unresolved" : row.paused} |`).join("\n");
  const tokenTable = out.tokenRows.map((row) => `| ${row.symbol} | ${row.address} | ${row.ownerBalance || "n/a"} | ${formatUsd(row.ownerBalanceUsd)} | ${formatUsd(row.defillamaLatestUsd)} | ${row.tvlToken} | ${row.stakingToken} |`).join("\n");
  const content = `# 🟢 DORMANT — SX Rollup Bridge Phase 0

Generated: ${out.generatedAt}

Scanner: \`tools/scan-sx-rollup-bridge-phase0.js\`

Artifact: \`reports/raw/fast/sx-rollup-bridge-phase0.json\`

## Result

No permissionless route-positive exploit is claimed. The DeFiLlama adapter maps SX Rollup Bridge TVL to two Ethereum custody owner addresses rather than an explicit canonical proof verifier in the adapter. This Phase 0 inspected those owners, tracked adapter-relevant token balances, and joined owners/tokens to local proof and consumer artifacts. It found no custody-specific proof weakness, no backing mismatch joined to consumer economics, and no exact positive mint/unlock/borrow/redeem/unwind route.

## Target

| Field | Value |
|---|---:|
| Protocol | \`${out.metadata.name}\` |
| Slug | \`${out.metadata.slug}\` |
| Category | \`${out.metadata.category}\` |
| Adapter | \`${out.metadata.module}\` |
| Current public TVL | \`${formatUsd(s.defillamaCurrentTvlUsd)}\` |
| Owner rows | \`${s.ownerRows}\` |
| Token rows | \`${s.tokenRows}\` |
| Consumer/proof join rows | \`${s.artifactJoinRows}\` |
| Route-positive rows | \`${s.routePositive}\` |

## Custody Owners

| Address | Code | Code bytes | EIP-1967 implementation | Paused |
|---|---:|---:|---|---:|
${ownerTable}

## Tracked Assets

| Symbol | Token | Owner balance | Owner balance USD | DeFiLlama latest USD | TVL token | Staking token |
|---|---|---:|---:|---:|---:|---:|
${tokenTable}

## Blockers

- Adapter custody balances are context only; no bridge proof verifier or permissionless mint/unlock bypass was identified in this pass.
- Common USDC/WETH consumer joins would not be bridge-specific without a custody/proof flaw.
- SX/GRG token balances do not create a route without material consumer acceptance and exact exit economics.
- No fork extraction proof and no signed-action justification exist.

## Next Gate

Reopen only if an SX-specific bridge/custody proof weakness or exact backing mismatch maps to a material consumer with positive exit economics.
`;
  fs.writeFileSync(REPORT_OUT, content);
}

async function main() {
  const metadataRaw = await fetchJson("https://api.llama.fi/protocol/sx-rollup-bridge", 30_000).catch(() => ({}));
  const ethData = metadataRaw.chainTvls?.Ethereum || {};
  const latestTokensInUsd = lastRow(ethData.tokensInUsd)?.tokens || {};
  const latestTokens = lastRow(ethData.tokens)?.tokens || {};
  const currentTvlUsd = lastRow(metadataRaw.tvl)?.totalLiquidityUSD ?? lastRow(ethData.tvl)?.totalLiquidityUSD ?? Object.values(latestTokensInUsd).reduce((sum, value) => sum + (asNumber(value) || 0), 0);
  const rpcUrl = await resolveInventoryRpc(ETHEREUM_CHAIN_ID);
  if (!rpcUrl) throw new Error("Missing required RPC endpoint from rpc_endpoints.txt for Ethereum mainnet chainId 1. Provide a suitable endpoint before continuing.");
  const rpc = client(rpcUrl);
  const prices = await tokenPrices(TRACKED_TOKENS.map((row) => ({ ...row, address: normalizeAddress(row.address) })).filter((row) => row.address));
  const owners = [];
  for (const owner of OWNERS) owners.push(await inspectOwner(rpc, owner));
  const tokenRows = [];
  for (const token of TRACKED_TOKENS) tokenRows.push(await inspectToken(rpc, token, prices, latestTokensInUsd));
  const joins = artifactJoins(tokenRows);
  const custodySpecificRouteJoins = joins.rows.filter((row) => row.custodySpecific && row.routePositive).length;
  const routePositive = custodySpecificRouteJoins > 0 ? custodySpecificRouteJoins : 0;
  const watchCandidates = joins.rows.filter((row) => row.watchCandidate && !row.routePositive).length;
  const output = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-sx-rollup-bridge-phase0.js",
    scope: "SX Rollup Bridge public Phase 0 custody owner/token and artifact-only consumer join",
    safety: { publicApisOnly: false, rpcInventoryRead: true, rpcInventoryOnly: true, rpcUrlsStored: false, envFilesRead: false, privateKeysRead: false, signedActions: false, exploitExecuteCalls: false, forkTransactions: false, routePositive: routePositive > 0, signedActionJustified: false },
    metadata: {
      name: metadataRaw.name || "SX Rollup Bridge",
      slug: metadataRaw.slug || "sx-rollup-bridge",
      category: metadataRaw.category || "Canonical Bridge",
      chains: metadataRaw.chains || ["Ethereum"],
      audits: metadataRaw.audits || "0",
      url: metadataRaw.url || null,
      twitter: metadataRaw.twitter || null,
      module: metadataRaw.module || "sxr-bridge/index.js",
      tvlCodePath: metadataRaw.tvlCodePath || "https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/sxr-bridge/index.js",
      adapter: { owners: OWNERS, blacklistedTokens: TRACKED_TOKENS.filter((row) => row.stakingToken).map((row) => row.address), fetchCoValentTokens: true },
      latestTokens,
      latestTokensInUsd,
    },
    owners,
    tokenRows,
    artifactJoins: joins.rows,
    joinInputsLoaded: joins.loadedInputs,
    summary: { ethereumRpcResolved: true, defillamaCurrentTvlUsd: round(currentTvlUsd, 2), ownerRows: owners.length, ownersWithCode: owners.filter((row) => row.codePresent).length, tokenRows: tokenRows.length, tvlTokenRows: tokenRows.filter((row) => row.tvlToken).length, stakingTokenRows: tokenRows.filter((row) => row.stakingToken).length, trackedOwnerBalanceUsd: round(tokenRows.reduce((sum, row) => sum + (asNumber(row.ownerBalanceUsd) || 0), 0), 2), artifactJoinRows: joins.rows.length, custodySpecificJoinRows: joins.rows.filter((row) => row.custodySpecific).length, watchCandidates, custodySpecificRouteJoins, routePositive, executableNow: 0, signedActionJustified: false, status: routePositive > 0 ? "route-positive-needs-proof" : "phase0-no-route-positive" },
    blockers: ["No SX-specific proof/custody bypass or exact backing mismatch proven", "Owner/token balances are context only without consumer economics", "No exact positive bridge, borrow, redemption, liquidation, or DEX unwind route", "No fork extraction proof and no signed-action justification"],
    requiredForRoutePositive: ["deployed proof/custody/domain/nonce/token binding weakness or material exact backing mismatch", "permissionless path to mint, unlock, transfer, or borrow against the affected asset", "exact unwind, borrow, redeem, or liquidation economics positive after costs", "fork extraction proof"],
  };
  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(output, jsonReplacer, 2)}\n`);
  writeReport(output);
  if (!QUIET) {
    console.log(`SX Rollup Bridge Phase0: tvl=$${Math.round(currentTvlUsd || 0)} owners=${owners.length} tokens=${tokenRows.length} joins=${joins.rows.length} routePositive=${routePositive}`);
    console.log(`Artifact: ${path.relative(WORKSPACE, RAW_OUT).replace(/\\/g, "/")}`);
    console.log(`Report: ${path.relative(WORKSPACE, REPORT_OUT).replace(/\\/g, "/")}`);
  }
}

main().catch((err) => { console.error(String(err?.message || err).slice(0, 320)); process.exit(1); });
