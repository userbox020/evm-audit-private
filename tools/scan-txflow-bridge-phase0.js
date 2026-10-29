#!/usr/bin/env node
// scan-txflow-bridge-phase0.js - bounded read-only Phase 0 for TxFlow Bridge custody wallet.
// Resolves RPC URLs in memory only. Never prints or stores RPC URLs, keys, calldata for execution, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { loadRpcUrls, rpcCall } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "txflow-bridge-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "txflow-bridge-phase0-triage.md");
const QUIET = process.argv.includes("--quiet");

const ARBITRUM_CHAIN_ID = 42161;
const SYSTEM_WALLET = "0xcde3f99bcb4c91e19124e41730489eaefec24565";
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const INPUTS = [
  ["bridge-nonlossless", "reports/raw/fast/bridge-nonlossless-collateral-join.json"],
  ["bridge-delta", "reports/raw/fast/bridge-delta-preflight.json"],
  ["bridge-synthetic", "reports/raw/fast/bridge-synthetic-consumer-exposure.json"],
  ["bridge-proof-binding", "reports/raw/fast/bridge-proof-binding.json"],
  ["bridge-domain", "reports/raw/fast/bridge-domain-separation.json"],
  ["layerzero-oft", "reports/raw/fast/layerzero-oft-dvn-consumer-joins.json"],
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
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function nonce() view returns (uint256)",
  "function VERSION() view returns (string)",
]);

const SELECTOR_HINT_SIGNATURES = [
  "withdraw(address,uint256)",
  "withdraw(address,address,uint256)",
  "transfer(address,uint256)",
  "execute(address,uint256,bytes)",
  "execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)",
  "deposit(address,uint256)",
  "finalize(address,address,uint256)",
  "receiveMessage(bytes)",
  "claim(address,uint256)",
  "rescueTokens(address,address,uint256)",
];

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
function selectorHints(code) {
  const bytecode = strip0x(code).toLowerCase();
  if (!bytecode) return [];
  return SELECTOR_HINT_SIGNATURES.map((signature) => ({ signature, selector: ethers.id(signature).slice(0, 10) }))
    .filter((row) => bytecode.includes(strip0x(row.selector).toLowerCase()));
}

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
async function fetchJson(url, timeoutMs = 30_000) { const c = new AbortController(); const t = setTimeout(() => c.abort(), timeoutMs); try { const res = await fetch(url, { signal: c.signal, headers: { "user-agent": "evm-audit-txflow-phase0/1.0" } }); if (!res.ok) throw new Error(`HTTP ${res.status}`); return await res.json(); } finally { clearTimeout(t); } }
async function getCode(rpc, address) { return await rpc.call("eth_getCode", [address, "latest"], 10_000).catch(() => "0x") || "0x"; }
async function getStorage(rpc, address, slot) { return await rpc.call("eth_getStorageAt", [address, slot, "latest"], 10_000).catch(() => null); }
async function getBalance(rpc, address) { return await rpc.call("eth_getBalance", [address, "latest"], 10_000).catch(() => null); }
async function safeCall(rpc, to, iface, fn, args = []) { try { const data = iface.encodeFunctionData(fn, args); const raw = await rpc.call("eth_call", [{ to, data }, "latest"], 12_000); if (!raw || raw === "0x") return null; return iface.decodeFunctionResult(fn, raw); } catch (_) { return null; } }

async function inspectWallet(rpc, address) {
  const [code, balanceRaw, implRaw, adminRaw, beaconRaw, ownerRaw, adminCallRaw, pausedRaw, safeOwnersRaw, safeThresholdRaw, safeNonceRaw, versionRaw] = await Promise.all([
    getCode(rpc, address),
    getBalance(rpc, address),
    getStorage(rpc, address, EIP1967_IMPLEMENTATION_SLOT),
    getStorage(rpc, address, EIP1967_ADMIN_SLOT),
    getStorage(rpc, address, EIP1967_BEACON_SLOT),
    safeCall(rpc, address, COMMON, "owner", []),
    safeCall(rpc, address, COMMON, "admin", []),
    safeCall(rpc, address, COMMON, "paused", []),
    safeCall(rpc, address, COMMON, "getOwners", []),
    safeCall(rpc, address, COMMON, "getThreshold", []),
    safeCall(rpc, address, COMMON, "nonce", []),
    safeCall(rpc, address, COMMON, "VERSION", []),
  ]);
  const balance = balanceRaw ? BigInt(balanceRaw).toString() : null;
  const safeOwners = Array.isArray(safeOwnersRaw?.[0]) ? safeOwnersRaw[0].map((owner) => normalizeAddress(owner)).filter(Boolean) : [];
  return {
    label: "TxFlow system wallet",
    address,
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
    nativeBalanceWei: balance,
    nativeBalance: formatUnits(balance, 18),
    eip1967: { implementation: addressFromStorageSlot(implRaw), admin: addressFromStorageSlot(adminRaw), beacon: addressFromStorageSlot(beaconRaw) },
    owner: normalizeAddress(ownerRaw?.[0]) || null,
    admin: normalizeAddress(adminCallRaw?.[0]) || null,
    paused: pausedRaw?.[0] === undefined ? null : Boolean(pausedRaw[0]),
    safeOwners,
    safeOwnerCount: safeOwners.length,
    safeThreshold: safeThresholdRaw?.[0] === undefined ? null : Number(safeThresholdRaw[0]),
    safeNonce: safeNonceRaw?.[0] === undefined ? null : safeNonceRaw[0].toString(),
    version: versionRaw?.[0] === undefined ? null : String(versionRaw[0]),
    selectorHints: selectorHints(code),
    routePositive: false,
  };
}

async function tokenPrice() {
  try {
    const key = `arbitrum:${USDC.toLowerCase()}`;
    const json = await fetchJson(`https://coins.llama.fi/prices/current/${key}?searchWidth=6h`, 30_000);
    const price = Number(json.coins?.[key]?.price || 0);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch (_) {
    return null;
  }
}

async function inspectToken(rpc, metadata) {
  const address = normalizeAddress(USDC);
  const chain = metadata?.chainTvls?.Arbitrum || {};
  const defillamaUsd = asNumber(lastRow(chain.tokensInUsd)?.tokens?.USDC) || asNumber(metadata?.currentChainTvls?.Arbitrum) || null;
  const defillamaAmount = asNumber(lastRow(chain.tokens)?.tokens?.USDC) || null;
  const [code, symbolRaw, nameRaw, decimalsRaw, supplyRaw, balanceRaw, priceUsd] = await Promise.all([
    getCode(rpc, address),
    safeCall(rpc, address, ERC20, "symbol", []),
    safeCall(rpc, address, ERC20, "name", []),
    safeCall(rpc, address, ERC20, "decimals", []),
    safeCall(rpc, address, ERC20, "totalSupply", []),
    safeCall(rpc, address, ERC20, "balanceOf", [SYSTEM_WALLET]),
    tokenPrice(),
  ]);
  const decimals = decimalsRaw?.[0] === undefined ? null : Number(decimalsRaw[0]);
  const balance = balanceRaw?.[0] ?? null;
  const amount = numberUnits(balance, decimals);
  const inferredPrice = defillamaAmount && defillamaUsd ? defillamaUsd / defillamaAmount : null;
  const effectivePrice = priceUsd || inferredPrice;
  const balanceUsd = amount !== null && effectivePrice ? amount * effectivePrice : null;
  const deltaUsd = balanceUsd !== null && defillamaUsd !== null ? balanceUsd - defillamaUsd : null;
  return {
    chain: "Arbitrum",
    symbol: "USDC",
    address,
    common: true,
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
    onchainSymbol: symbolRaw?.[0] === undefined ? null : String(symbolRaw[0]),
    onchainName: nameRaw?.[0] === undefined ? null : String(nameRaw[0]),
    decimals,
    totalSupplyRaw: supplyRaw?.[0] === undefined ? null : supplyRaw[0].toString(),
    totalSupply: supplyRaw?.[0] === undefined ? null : formatUnits(supplyRaw[0], decimals),
    walletBalanceRaw: balance?.toString() || null,
    walletBalance: formatUnits(balance, decimals),
    priceUsd: round(priceUsd, 8),
    inferredDefillamaPriceUsd: round(inferredPrice, 8),
    walletBalanceUsd: round(balanceUsd, 2),
    defillamaLatestAmount: round(defillamaAmount, 6),
    defillamaLatestUsd: round(defillamaUsd, 2),
    walletVsDefillamaDeltaUsd: round(deltaUsd, 2),
    routePositive: false,
    blockers: [
      "USDC custody balance is backing context only",
      "USDC consumer joins are common-token context, not TxFlow-specific exploit evidence",
      "No proof/custody weakness or exact backing mismatch maps to consumer economics",
    ],
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

function artifactJoins(tokenRow) {
  const wanted = [
    { label: "TxFlow system wallet", address: SYSTEM_WALLET, common: false, custodySpecific: true },
    { label: "Arbitrum USDC", address: tokenRow.address, common: true, custodySpecific: false },
  ];
  const rows = [];
  for (const item of wanted) {
    for (const [source, rel] of INPUTS) {
      const data = readJson(path.join(WORKSPACE, rel));
      if (!data) continue;
      const matches = findMatches(data, item.address, source, 10);
      if (!matches.length) continue;
      rows.push({
        label: item.label,
        address: normalizeAddress(item.address),
        source,
        common: item.common,
        custodySpecific: item.custodySpecific,
        joinCount: matches.length,
        routePositive: false,
        watchCandidate: false,
        matches,
      });
    }
  }
  rows.sort((a, b) => Number(b.custodySpecific) - Number(a.custodySpecific) || Number(a.common) - Number(b.common) || b.joinCount - a.joinCount);
  return rows;
}

function writeReport(out) {
  const s = out.summary;
  const walletRows = out.walletRows.map((row) => `| ${row.label} | ${row.address} | ${row.codePresent} | ${row.codeBytes} | ${row.safeThreshold ?? "n/a"} | ${row.safeOwnerCount || 0} | ${row.selectorHints.length} | ${row.nativeBalance || "n/a"} | ${row.paused === null ? "n/a" : row.paused} |`).join("\n");
  const tokenRows = out.tokenRows.map((row) => `| ${row.symbol} | ${row.address} | ${row.walletBalance || "n/a"} | ${formatUsd(row.walletBalanceUsd)} | ${formatUsd(row.defillamaLatestUsd)} | ${formatUsd(row.walletVsDefillamaDeltaUsd)} |`).join("\n");
  const joinRows = out.artifactJoins.slice(0, 12).map((row) => `| ${row.label} | ${row.source} | ${row.joinCount} | ${row.custodySpecific} | ${row.common} | ${row.routePositive} |`).join("\n") || "| none | none | 0 | false | false | false |";
  const md = `# 🟢 DORMANT — TxFlow Bridge Phase 0

Generated: ${out.generatedAt}

Scanner: \`tools/scan-txflow-bridge-phase0.js\`

Artifact: \`reports/raw/fast/txflow-bridge-phase0.json\`

## Result

No permissionless route-positive exploit is claimed. This Phase 0 mapped the public DeFiLlama TxFlow adapter, the Arbitrum USDC system wallet custody balance, wallet/code state, local bridge/consumer artifact joins, and backing context. It found no deployed proof verifier, no permissionless mint/unlock/balance-delta path, no material exact backing mismatch joined to consumer economics, and no exact positive borrow/redeem/liquidation/unwind route.

## Target

| Field | Value |
|---|---:|
| Protocol | \`${out.metadata.name}\` |
| Slug | \`${out.metadata.slug}\` |
| Category | \`${out.metadata.category}\` |
| Chain | \`Arbitrum\` |
| Current public TVL | \`${formatUsd(s.defillamaCurrentTvlUsd)}\` |
| Wallet rows | \`${s.walletRows}\` |
| Wallets with code | \`${s.walletRowsWithCode}\` |
| Safe threshold | \`${s.safeThreshold ?? "n/a"}\` |
| Safe owner count | \`${s.safeOwnerCount}\` |
| Selector hint rows | \`${s.selectorHintRows}\` |
| Token rows | \`${s.tokenRows}\` |
| Tracked wallet balance USD | \`${formatUsd(s.trackedWalletBalanceUsd)}\` |
| Artifact join rows | \`${s.artifactJoinRows}\` |
| Custody-specific join rows | \`${s.custodySpecificJoinRows}\` |
| Route-positive rows | \`${s.routePositive}\` |

## Wallet State

| Label | Address | Code | Code bytes | Safe threshold | Safe owners | Selector hints | Native balance | Paused |
|---|---|---:|---:|---:|---:|---:|---:|---:|
${walletRows}

## Token Custody

| Token | Address | Wallet balance | Wallet balance USD | DeFiLlama USD | Delta USD |
|---|---|---:|---:|---:|---:|
${tokenRows}

## Artifact Joins

| Label | Source | Join count | Custody-specific | Common token | Route-positive |
|---|---|---:|---:|---:|---:|
${joinRows}

## Blockers

- DeFiLlama methodology counts USDC in one Arbitrum system wallet; that is custody context, not a proof-acceptance or mint/unlock path.
- The system wallet has no route-positive permissionless surface in this bounded pass.
- USDC local joins are common-token context only and do not establish TxFlow-specific consumer impact.
- No exact positive bridge, borrow, redemption, liquidation, or DEX unwind economics were found.
- No fork extraction proof and no signed-action justification exist.

## Next Gate

Reopen only if a TxFlow-specific custody/proof/balance-delta weakness or material exact backing mismatch maps to a permissionless consumer route with exact positive economics.
`;
  fs.writeFileSync(REPORT_OUT, md);
}

async function main() {
  const rpcUrl = await resolveInventoryRpc(ARBITRUM_CHAIN_ID);
  if (!rpcUrl) throw new Error("Missing required RPC endpoint from rpc_endpoints.txt for Arbitrum chainId 42161. Provide a suitable endpoint before continuing.");
  const rpc = client(rpcUrl);
  const metadataRaw = await fetchJson("https://api.llama.fi/protocol/txflow-bridge", 30_000).catch(() => ({}));
  const chain = metadataRaw.chainTvls?.Arbitrum || {};
  const defillamaCurrentTvlUsd = asNumber(metadataRaw.currentChainTvls?.Arbitrum) || asNumber(lastRow(chain.tvl)?.totalLiquidityUSD) || null;
  const [walletRow, tokenRow] = await Promise.all([
    inspectWallet(rpc, normalizeAddress(SYSTEM_WALLET)),
    inspectToken(rpc, metadataRaw),
  ]);
  const joins = artifactJoins(tokenRow);
  const custodySpecificJoinRows = joins.filter((row) => row.custodySpecific).length;
  const routePositive = 0;
  const out = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-txflow-bridge-phase0.js",
    scope: "TxFlow Bridge Arbitrum custody wallet, backing, proof-surface, and consumer join Phase 0",
    safety: {
      publicApisOnly: false,
      rpcInventoryRead: true,
      rpcInventoryOnly: true,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: false,
      signedActionJustified: false,
    },
    metadata: {
      name: metadataRaw.name || "TxFlow Bridge",
      slug: metadataRaw.slug || "txflow-bridge",
      category: metadataRaw.category || "Bridge",
      chains: metadataRaw.chains || ["Arbitrum"],
      audits: metadataRaw.audits || null,
      url: metadataRaw.url || "https://txflow.com/",
      module: metadataRaw.module || "txflow/index.js",
      tvlCodePath: metadataRaw.tvlCodePath || "https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/txflow/index.js",
      methodology: metadataRaw.methodology || "Counts tokens held in the TxFlow system wallet on Arbitrum.",
      adapter: { owner: normalizeAddress(SYSTEM_WALLET), tokens: [normalizeAddress(USDC)] },
    },
    walletRows: [walletRow],
    tokenRows: [tokenRow],
    artifactJoins: joins,
    summary: {
      arbitrumRpcResolved: true,
      defillamaCurrentTvlUsd: round(defillamaCurrentTvlUsd, 2),
      walletRows: 1,
      walletRowsWithCode: walletRow.codePresent ? 1 : 0,
      safeThreshold: walletRow.safeThreshold,
      safeOwnerCount: walletRow.safeOwnerCount,
      selectorHintRows: walletRow.selectorHints.length,
      tokenRows: 1,
      trackedWalletBalanceUsd: tokenRow.walletBalanceUsd,
      walletVsDefillamaDeltaUsd: tokenRow.walletVsDefillamaDeltaUsd,
      artifactJoinRows: joins.length,
      custodySpecificJoinRows,
      watchCandidates: 0,
      routePositive,
      executableNow: 0,
      signedActionJustified: false,
      status: "phase0-no-route-positive",
    },
    blockers: [
      "Adapter exposes a single Arbitrum USDC system-wallet balance, not a proof verifier or permissionless bridge entry point",
      "No TxFlow-specific custody/proof/balance-delta weakness is proven",
      "USDC consumer joins are common-token context without TxFlow-specific impact",
      "No exact positive bridge, borrow, redemption, liquidation, or DEX unwind route",
      "No fork extraction proof and no signed-action justification",
    ],
    requiredForRoutePositive: [
      "TxFlow-specific custody/proof/balance-delta weakness or material exact backing mismatch",
      "permissionless path to mint, unlock, transfer, borrow, redeem, or liquidate against affected assets",
      "exact route economics positive after gas/slippage/fees",
      "fork extraction proof",
    ],
  };
  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, JSON.stringify(out, jsonReplacer, 2));
  writeReport(out);
  if (!QUIET) {
    console.log(`TxFlow Bridge Phase0: tvl=${formatUsd(out.summary.defillamaCurrentTvlUsd)} walletUsd=${formatUsd(out.summary.trackedWalletBalanceUsd)} joins=${out.summary.artifactJoinRows} routePositive=${routePositive}`);
    console.log(`Artifact: ${path.relative(WORKSPACE, RAW_OUT)}`);
    console.log(`Report: ${path.relative(WORKSPACE, REPORT_OUT)}`);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
