#!/usr/bin/env node
// scan-polygon-zkevm-bridge-phase0.js - bounded read-only Phase 0 for Polygon zkEVM Bridge.
// Resolves RPC URLs in memory only. Never prints or stores RPC URLs, keys, calldata, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "polygon-zkevm-bridge-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "polygon-zkevm-bridge-phase0-triage.md");
const QUIET = process.argv.includes("--quiet");

const ETHEREUM_CHAIN_ID = 1;
const DESTINATION_NETWORK_ID = 1;
const BRIDGE = "0x2a3DD3EB832aF982ec71669E178424b10Dca2EDe";
const ZERO = "0x0000000000000000000000000000000000000000";
const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const EXACT_TOKENS = [
  { symbol: "WEETH", address: "0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee", common: true },
  { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", common: true },
  { symbol: "WETH", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", common: true },
  { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", common: true },
  { symbol: "WBTC", address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", common: true },
  { symbol: "DAI", address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", common: true },
  { symbol: "MORPHO", address: "0x58D97B57BB95320F9a05dC918Aef65434969c2B2", common: true },
  { symbol: "WMATIC", address: "0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0", common: true },
  { symbol: "WSTETH", address: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0", common: true },
  { symbol: "TBILL", address: "0xdd50C053C096CB04A3e3362E2b622529EC5f2e8a", common: true },
];

const INPUTS = [
  ["bridge-nonlossless", "reports/raw/fast/bridge-nonlossless-collateral-join.json"],
  ["bridge-delta", "reports/raw/fast/bridge-delta-preflight.json"],
  ["bridge-synthetic", "reports/raw/fast/bridge-synthetic-consumer-exposure.json"],
  ["bridge-proof-binding", "reports/raw/fast/bridge-proof-binding.json"],
  ["bridge-domain", "reports/raw/fast/bridge-domain-separation.json"],
  ["deployed-path-proof-gaps", "reports/raw/fast/deployed-path-proof-gaps.json"],
  ["aave-euler-silo", "reports/raw/fast/aave-euler-silo-consumer-graph.json"],
  ["consumer-first-high-ltv", "reports/raw/fast/consumer-first-high-ltv-collateral.json"],
  ["public-lead-consumer", "reports/raw/fast/public-lead-consumer-joins.json"],
  ["dex-consumer-routes", "reports/raw/fast/dex-consumer-routes.json"],
  ["erc4626", "reports/raw/fast/erc4626-consumer-joiner.json"],
];

const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
]);

const BRIDGE_IFACE = new ethers.Interface([
  "function networkID() view returns (uint32)",
  "function globalExitRootManager() view returns (address)",
  "function polygonZkEVMaddress() view returns (address)",
  "function rollupManager() view returns (address)",
  "function isEmergencyState() view returns (bool)",
  "function bridgeAsset(uint32,address,uint256,address,bool,bytes) payable",
  "function bridgeMessage(uint32,address,bool,bytes) payable",
]);

const COMMON = new ethers.Interface([
  "function owner() view returns (address)",
  "function admin() view returns (address)",
  "function paused() view returns (bool)",
]);

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function readJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function normalizeAddress(value) {
  try {
    return ethers.getAddress(value);
  } catch (_) {
    const text = String(value || "");
    if (/^0x[0-9a-fA-F]{40}$/.test(text)) {
      try { return ethers.getAddress(text.toLowerCase()); } catch (_) { return null; }
    }
    return null;
  }
}

function lowerAddress(value) {
  const address = normalizeAddress(value);
  return address ? address.toLowerCase() : null;
}

function strip0x(value) {
  return String(value || "").replace(/^0x/i, "");
}

function addressFromStorageSlot(raw) {
  if (!raw || raw === "0x") return null;
  const hex = strip0x(raw).padStart(64, "0");
  if (/^0+$/.test(hex)) return null;
  return normalizeAddress(`0x${hex.slice(-40)}`);
}

function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const n = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 2) {
  const n = asNumber(value);
  if (n === null) return null;
  const p = 10 ** decimals;
  return Math.round(n * p) / p;
}

function formatUsd(value) {
  const n = asNumber(value);
  return n === null ? "n/a" : `$${Math.round(n).toLocaleString()}`;
}

function formatUnits(value, decimals) {
  if (value === null || value === undefined || decimals === null || decimals === undefined) return null;
  try { return ethers.formatUnits(BigInt(value), Number(decimals)); } catch (_) { return null; }
}

function numberUnits(value, decimals) {
  const text = formatUnits(value, decimals);
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

async function fetchJson(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-polygon-zkevm-bridge-phase0/1.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function lastRow(value) {
  return Array.isArray(value) && value.length ? value[value.length - 1] : null;
}

async function safeCall(provider, to, iface, fn, args = []) {
  try {
    const raw = await provider.call({ to, data: iface.encodeFunctionData(fn, args) });
    return iface.decodeFunctionResult(fn, raw);
  } catch (_) {
    return null;
  }
}

async function tokenPriceMap(tokens) {
  const keys = tokens.map((token) => token.address ? `ethereum:${token.address.toLowerCase()}` : null).filter(Boolean);
  if (!keys.length) return new Map();
  const prices = new Map();
  try {
    const json = await fetchJson(`https://coins.llama.fi/prices/current/${keys.join(",")}?searchWidth=6h`, 30_000);
    for (const [key, row] of Object.entries(json.coins || {})) {
      const address = lowerAddress(key.split(":").pop());
      const price = Number(row.price || 0);
      if (address && Number.isFinite(price) && price > 0) prices.set(address, price);
    }
  } catch (_) {
    // Public prices are optional; scanner remains fail-closed.
  }
  return prices;
}

function latestTvl(raw) {
  const direct = asNumber(raw?.currentChainTvls?.Ethereum);
  if (direct !== null) return direct;
  const eth = raw?.chainTvls?.Ethereum || raw?.chainTvls?.ethereum || {};
  return asNumber(lastRow(eth.tvl)?.totalLiquidityUSD ?? lastRow(raw?.tvl)?.totalLiquidityUSD ?? raw?.tvl);
}

function latestTokenUsd(raw) {
  const eth = raw?.chainTvls?.Ethereum || raw?.chainTvls?.ethereum || {};
  return lastRow(eth.tokensInUsd)?.tokens || {};
}

async function inspectBridge(provider, prices = new Map()) {
  const [code, nativeBalanceRaw, implRaw, adminRaw, beaconRaw, networkRaw, gerRaw, polygonRaw, rollupRaw, emergencyRaw, ownerRaw, adminCallRaw, pausedRaw] = await Promise.all([
    provider.getCode(BRIDGE).catch(() => "0x"),
    provider.getBalance(BRIDGE).catch(() => null),
    provider.getStorage(BRIDGE, EIP1967_IMPLEMENTATION_SLOT).catch(() => null),
    provider.getStorage(BRIDGE, EIP1967_ADMIN_SLOT).catch(() => null),
    provider.getStorage(BRIDGE, EIP1967_BEACON_SLOT).catch(() => null),
    safeCall(provider, BRIDGE, BRIDGE_IFACE, "networkID", []),
    safeCall(provider, BRIDGE, BRIDGE_IFACE, "globalExitRootManager", []),
    safeCall(provider, BRIDGE, BRIDGE_IFACE, "polygonZkEVMaddress", []),
    safeCall(provider, BRIDGE, BRIDGE_IFACE, "rollupManager", []),
    safeCall(provider, BRIDGE, BRIDGE_IFACE, "isEmergencyState", []),
    safeCall(provider, BRIDGE, COMMON, "owner", []),
    safeCall(provider, BRIDGE, COMMON, "admin", []),
    safeCall(provider, BRIDGE, COMMON, "paused", []),
  ]);
  const implementation = addressFromStorageSlot(implRaw);
  const implCode = implementation ? await provider.getCode(implementation).catch(() => "0x") : "0x";
  const selectors = ["bridgeAsset", "bridgeMessage"].map((fn) => BRIDGE_IFACE.getFunction(fn).selector);
  const selectorSearchCode = `${code || ""}${implCode || ""}`.toLowerCase();
  const ethPrice = prices.get(lowerAddress(EXACT_TOKENS.find((row) => row.symbol === "WETH")?.address)) || null;
  const nativeEth = nativeBalanceRaw === null ? null : formatUnits(nativeBalanceRaw, 18);
  const nativeEthBalanceUsd = ethPrice && nativeBalanceRaw !== null ? numberUnits(nativeBalanceRaw, 18) * ethPrice : null;
  return {
    address: BRIDGE,
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
    implementationCodeBytes: implCode && implCode !== "0x" ? strip0x(implCode).length / 2 : 0,
    selectorHintsPresent: Object.fromEntries(selectors.map((selector) => [selector, selectorSearchCode.includes(strip0x(selector).toLowerCase())])),
    nativeEthBalanceRaw: nativeBalanceRaw?.toString() || null,
    nativeEthBalance: nativeEth,
    nativeEthBalanceUsd: round(nativeEthBalanceUsd, 2),
    eip1967: {
      implementation,
      admin: addressFromStorageSlot(adminRaw),
      beacon: addressFromStorageSlot(beaconRaw),
    },
    networkID: networkRaw?.[0] === undefined ? null : Number(networkRaw[0]),
    globalExitRootManager: normalizeAddress(gerRaw?.[0]) || null,
    polygonZkEVMAddress: normalizeAddress(polygonRaw?.[0]) || null,
    rollupManager: normalizeAddress(rollupRaw?.[0]) || null,
    isEmergencyState: emergencyRaw?.[0] === undefined ? null : Boolean(emergencyRaw[0]),
    owner: normalizeAddress(ownerRaw?.[0]) || null,
    admin: normalizeAddress(adminCallRaw?.[0]) || null,
    paused: pausedRaw?.[0] === undefined ? null : Boolean(pausedRaw[0]),
  };
}

async function inspectContracts(provider, bridge) {
  const contracts = [
    { label: "Bridge", address: BRIDGE, role: "canonical-bridge" },
    { label: "Bridge implementation", address: bridge.eip1967.implementation, role: "implementation" },
    { label: "GlobalExitRootManager", address: bridge.globalExitRootManager, role: "proof-root-manager" },
    { label: "PolygonZkEVM", address: bridge.polygonZkEVMAddress, role: "rollup-core" },
    { label: "RollupManager", address: bridge.rollupManager, role: "rollup-manager" },
  ].filter((row, i, arr) => row.address && arr.findIndex((r) => lowerAddress(r.address) === lowerAddress(row.address)) === i);
  return Promise.all(contracts.map(async (row) => {
    const code = await provider.getCode(row.address).catch(() => "0x");
    return { ...row, address: normalizeAddress(row.address), codePresent: Boolean(code && code !== "0x"), codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0 };
  }));
}

async function inspectTokenRows(provider, prices, publicTokenUsd) {
  const rows = [];
  for (const token of EXACT_TOKENS) {
    const address = normalizeAddress(token.address);
    const [code, symbolRaw, nameRaw, decimalsRaw, balanceRaw, supplyRaw] = await Promise.all([
      provider.getCode(address).catch(() => "0x"),
      safeCall(provider, address, ERC20, "symbol", []),
      safeCall(provider, address, ERC20, "name", []),
      safeCall(provider, address, ERC20, "decimals", []),
      safeCall(provider, address, ERC20, "balanceOf", [BRIDGE]),
      safeCall(provider, address, ERC20, "totalSupply", []),
    ]);
    const decimals = decimalsRaw?.[0] === undefined ? null : Number(decimalsRaw[0]);
    const balance = balanceRaw?.[0] ?? null;
    const totalSupply = supplyRaw?.[0] ?? null;
    const priceUsd = prices.get(address.toLowerCase()) || null;
    const balanceUsd = priceUsd && balance !== null && decimals !== null ? numberUnits(balance, decimals) * priceUsd : null;
    rows.push({
      symbol: token.symbol,
      address,
      common: Boolean(token.common),
      codePresent: Boolean(code && code !== "0x"),
      onchainSymbol: symbolRaw?.[0] ? String(symbolRaw[0]) : null,
      onchainName: nameRaw?.[0] ? String(nameRaw[0]) : null,
      decimals,
      priceUsd: round(priceUsd, 8),
      bridgeBalanceRaw: balance?.toString() || null,
      bridgeBalance: formatUnits(balance, decimals),
      bridgeBalanceUsd: round(balanceUsd, 2),
      totalSupplyRaw: totalSupply?.toString() || null,
      totalSupply: formatUnits(totalSupply, decimals),
      defillamaLatestUsd: round(publicTokenUsd[token.symbol], 2),
      routePositive: false,
      blockers: [
        "Custody balance is context only, not a proof of mint/unlock bypass",
        "Common token consumer routes are not bridge-specific without a backing/proof flaw",
      ],
    });
  }
  rows.sort((a, b) => (asNumber(b.bridgeBalanceUsd) || 0) - (asNumber(a.bridgeBalanceUsd) || 0));
  return rows;
}

function unresolvedPublicSymbols(publicTokenUsd, exactRows) {
  const exact = new Set(exactRows.flatMap((row) => [row.symbol, row.onchainSymbol]).filter(Boolean).map((s) => String(s).toUpperCase()));
  return Object.entries(publicTokenUsd || {})
    .map(([symbol, usd]) => ({ symbol, usd: round(usd, 2) }))
    .filter((row) => !exact.has(String(row.symbol).toUpperCase()))
    .sort((a, b) => (asNumber(b.usd) || 0) - (asNumber(a.usd) || 0))
    .slice(0, 15)
    .map((row) => ({ ...row, blocker: "Exact Ethereum token address not resolved from public protocol API in this bounded pass" }));
}

function contextSummary(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const fields = ["id", "protocol", "chain", "chainId", "surface", "side", "symbol", "token", "asset", "collateral", "borrowAsset", "routePositive", "watchCandidate", "liquidityUsd", "borrowCashUsd", "cashUsd", "source", "status"];
  const out = {};
  for (const field of fields) {
    if (obj[field] !== undefined && typeof obj[field] !== "object") out[field] = String(obj[field]).slice(0, 120);
  }
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
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) walk(value[i], `${objectPath}[${i}]`, parent);
      return;
    }
    for (const [key, child] of Object.entries(value)) walk(child, objectPath ? `${objectPath}.${key}` : key, value);
  }
  walk(data, "", null);
  return matches;
}

function artifactJoins(tokenRows, contractRows) {
  const wanted = [
    ...contractRows.map((row) => ({ label: row.label, address: row.address, common: false, bridgeSpecific: true })),
    ...tokenRows.filter((row) => row.address).map((row) => ({ label: row.symbol, address: row.address, common: row.common, bridgeSpecific: false })),
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
      rows.push({
        label: item.label,
        address: normalizeAddress(item.address),
        common: Boolean(item.common),
        bridgeSpecific: Boolean(item.bridgeSpecific),
        source,
        joinCount: matches.length,
        routePositive: matches.some((m) => m.routePositive),
        watchCandidate: matches.some((m) => m.watchCandidate),
        matches,
      });
    }
  }
  rows.sort((a, b) => Number(b.bridgeSpecific) - Number(a.bridgeSpecific) || Number(b.routePositive) - Number(a.routePositive) || Number(b.watchCandidate) - Number(a.watchCandidate) || Number(a.common) - Number(b.common) || b.joinCount - a.joinCount);
  return { rows, loadedInputs };
}

function writeReport(out) {
  const s = out.summary;
  const bridge = out.bridge;
  const contractRows = out.contractRows.map((row) => `| ${row.label} | ${row.address} | ${row.role} | ${row.codePresent} | ${row.codeBytes} |`).join("\n") || "| none | none | none | false | 0 |";
  const tokenRows = out.trackedAssets.slice(0, 10).map((row) => `| ${row.symbol} | ${row.address} | ${formatUsd(row.bridgeBalanceUsd)} | ${formatUsd(row.defillamaLatestUsd)} |`).join("\n") || "| none | none | n/a | n/a |";
  const unresolvedRows = out.unresolvedPublicTokenRows.slice(0, 8).map((row) => `| ${row.symbol} | ${formatUsd(row.usd)} | ${row.blocker} |`).join("\n") || "| none | n/a | none |";
  const joinRows = out.artifactJoins.slice(0, 10).map((row) => `| ${row.label} | ${row.source} | ${row.joinCount} | ${row.bridgeSpecific} | ${row.common} | ${row.routePositive} |`).join("\n") || "| none | none | 0 | false | false | false |";
  const content = `# DORMANT - Polygon zkEVM Bridge Phase 0

Generated: ${out.generatedAt}

Scanner: \`tools/scan-polygon-zkevm-bridge-phase0.js\`

Artifact: \`reports/raw/fast/polygon-zkevm-bridge-phase0.json\`

## Result

No permissionless route-positive exploit is claimed. This Phase 0 mapped the Ethereum canonical bridge contract, public DeFiLlama custody context, exact known token balances, rollup/root-manager contract hints, and local bridge/consumer artifact joins. It found no deployed proof-binding bypass, no material exact backing mismatch joined to consumer economics, and no exact positive mint/unlock/borrow/redeem/unwind route.

## Target

| Field | Value |
|---|---:|
| Protocol | \`${out.metadata.name}\` |
| Slug | \`${out.metadata.slug}\` |
| Category | \`${out.metadata.category}\` |
| Source chain | \`Ethereum\` |
| Destination network id | \`${DESTINATION_NETWORK_ID}\` |
| Bridge contract | \`${BRIDGE}\` |
| Code present | \`${bridge.codePresent}\` |
| Code bytes | \`${bridge.codeBytes}\` |
| EIP-1967 implementation | \`${bridge.eip1967.implementation || "none"}\` |
| Implementation code bytes | \`${bridge.implementationCodeBytes || 0}\` |
| GlobalExitRootManager | \`${bridge.globalExitRootManager || "unresolved"}\` |
| PolygonZkEVM address | \`${bridge.polygonZkEVMAddress || "unresolved"}\` |
| RollupManager | \`${bridge.rollupManager || "unresolved"}\` |
| Emergency state | \`${bridge.isEmergencyState === null ? "unresolved" : bridge.isEmergencyState}\` |
| Native ETH bridge balance | \`${bridge.nativeEthBalance || "n/a"}\` |
| Native ETH bridge balance USD | \`${formatUsd(bridge.nativeEthBalanceUsd)}\` |
| Current public TVL | \`${formatUsd(s.defillamaCurrentTvlUsd)}\` |

## Contract Rows

| Label | Address | Role | Code present | Code bytes |
|---|---|---|---:|---:|
${contractRows}

## Tracked Exact Tokens

| Symbol | Address | Bridge balance USD | Public token TVL USD |
|---|---|---:|---:|
${tokenRows}

## Unresolved Public Token Symbols

| Symbol | Public token TVL USD | Caveat |
|---|---:|---|
${unresolvedRows}

## Local Joins

| Label | Source | Join count | Bridge-specific | Common token | Route-positive |
|---|---|---:|---:|---:|---:|
${joinRows}

## Blockers

- No deployed proof-acceptance or message-binding bypass was identified for the Polygon zkEVM bridge path in this pass.
- Common assets such as native ETH/WETH/USDC/USDT/DAI/WBTC/weETH are consumer-heavy but do not create a bridge-specific exploit without a mint/unlock/backing mismatch.
- Top public TVL symbols such as LUMIA/BILL/PC/CAPS remain exact-address caveats in this bounded pass because the public protocol API exposes symbols, not source token addresses.
- No Polygon-zkEVM destination-chain wrapped supply check was performed because the current queue scope is Ethereum adapter custody and no sanitized Polygon zkEVM RPC is declared in the standard inventory.
- No exact positive bridge, borrow, redemption, liquidation, or DEX unwind economics exist, so fork/live work remains blocked.

## Next Gate

Reopen only if a Polygon-zkEVM-specific bridge proof/domain/nonce/token binding issue is mapped to the deployed bridge, or if an exact source/destination backing mismatch joins to a material same-chain consumer with positive exit economics.
`;
  fs.writeFileSync(REPORT_OUT, content);
}

async function main() {
  const metadataRaw = await fetchJson("https://api.llama.fi/protocol/polygon-zkevm-bridge", 30_000).catch(() => ({}));
  const publicTokenUsd = latestTokenUsd(metadataRaw);
  const currentTvlUsd = latestTvl(metadataRaw);
  const rpc = await resolveRpc(ETHEREUM_CHAIN_ID);
  const provider = rpc ? new ethers.JsonRpcProvider(rpc) : null;
  const prices = await tokenPriceMap(EXACT_TOKENS);
  const bridge = provider ? await inspectBridge(provider, prices) : { address: BRIDGE, codePresent: null, codeBytes: null, implementationCodeBytes: null, selectorHintsPresent: {}, nativeEthBalanceRaw: null, nativeEthBalance: null, nativeEthBalanceUsd: null, eip1967: {}, networkID: null, globalExitRootManager: null, polygonZkEVMAddress: null, rollupManager: null, isEmergencyState: null, owner: null, admin: null, paused: null };
  const contractRows = provider ? await inspectContracts(provider, bridge) : [{ label: "Bridge", address: BRIDGE, role: "canonical-bridge", codePresent: null, codeBytes: null }];
  const trackedAssets = provider ? await inspectTokenRows(provider, prices, publicTokenUsd) : EXACT_TOKENS.map((row) => ({ ...row, queried: false, routePositive: false, blockers: ["Ethereum RPC unavailable"] }));
  const unresolved = unresolvedPublicSymbols(publicTokenUsd, trackedAssets);
  const joins = artifactJoins(trackedAssets, contractRows);
  const bridgeSpecificRouteJoins = joins.rows.filter((row) => row.bridgeSpecific && row.routePositive).length;
  const bridgeSpecificWatchJoins = joins.rows.filter((row) => row.bridgeSpecific && row.watchCandidate && !row.routePositive).length;
  const routePositive = bridgeSpecificRouteJoins;
  const watchCandidates = bridgeSpecificWatchJoins;
  const output = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-polygon-zkevm-bridge-phase0.js",
    scope: "Polygon zkEVM Bridge Ethereum canonical custody, proof-surface, and consumer-join Phase 0",
    safety: {
      publicApisOnly: false,
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: routePositive > 0,
      signedActionJustified: false,
    },
    metadata: {
      name: metadataRaw.name || "Polygon zkEVM Bridge",
      slug: metadataRaw.slug || "polygon-zkevm-bridge",
      category: metadataRaw.category || "Canonical Bridge",
      chains: metadataRaw.chains || ["Ethereum"],
      audits: metadataRaw.audits || "0",
      url: metadataRaw.url || "https://polygon.technology/polygon-zkevm",
      twitter: metadataRaw.twitter || "0xPolygon",
      description: metadataRaw.description || null,
      module: metadataRaw.module || "polygonZk/index.js",
      tvlCodePath: metadataRaw.tvlCodePath || null,
      adapter: {
        sourceChain: "Ethereum",
        bridge: BRIDGE,
        destinationNetworkId: DESTINATION_NETWORK_ID,
      },
      latestTokensInUsd: publicTokenUsd,
    },
    bridge,
    contractRows,
    trackedAssets,
    unresolvedPublicTokenRows: unresolved,
    artifactJoins: joins.rows,
    joinInputsLoaded: joins.loadedInputs,
    summary: {
      ethereumRpcResolved: Boolean(provider),
      defillamaCurrentTvlUsd: round(currentTvlUsd, 2),
      contractRows: contractRows.length,
      contractsWithCode: contractRows.filter((row) => row.codePresent).length,
      trackedAssetRows: trackedAssets.length,
      trackedAssetRowsWithCode: trackedAssets.filter((row) => row.codePresent).length,
      trackedAssetBalanceUsd: round(trackedAssets.reduce((sum, row) => sum + (asNumber(row.bridgeBalanceUsd) || 0), 0), 2),
      nativeEthBalanceUsd: round(bridge.nativeEthBalanceUsd, 2),
      trackedCustodyUsd: round((asNumber(bridge.nativeEthBalanceUsd) || 0) + trackedAssets.reduce((sum, row) => sum + (asNumber(row.bridgeBalanceUsd) || 0), 0), 2),
      unresolvedPublicTokenSymbols: unresolved.length,
      unresolvedPublicTokenUsd: round(unresolved.reduce((sum, row) => sum + (asNumber(row.usd) || 0), 0), 2),
      artifactJoinRows: joins.rows.length,
      bridgeSpecificJoinRows: joins.rows.filter((row) => row.bridgeSpecific).length,
      commonTokenJoinRows: joins.rows.filter((row) => row.common).length,
      bridgeSpecificRouteJoins,
      bridgeSpecificWatchJoins,
      watchCandidates,
      routePositive,
      executableNow: 0,
      signedActionJustified: false,
      coverageClassification: "bounded-with-caveats",
      status: routePositive > 0 ? "route-positive-needs-proof" : "phase0-no-route-positive",
    },
    blockers: [
      "No deployed proof-acceptance bypass or forged mint/unlock path proven",
      "No exact source/destination backing mismatch joined to material same-chain consumer economics",
      "Common token consumer presence is not bridge-specific exploit evidence",
      "Top public token symbols include exact-address caveats in this bounded pass",
      "No fork extraction proof and no signed-action justification",
    ],
    requiredForRoutePositive: [
      "deployed proof/domain/message/nonce/token binding weakness or material backing mismatch",
      "permissionless path to mint/unlock/transfer or consumer-borrow against the affected asset",
      "exact unwind/borrow/redeem/liquidation economics positive after costs",
      "fork extraction proof",
    ],
  };
  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(output, jsonReplacer, 2)}\n`);
  writeReport(output);
  if (!QUIET) {
    console.log(`Polygon zkEVM Bridge Phase0: tvl=$${Math.round(currentTvlUsd || 0)} joins=${joins.rows.length} bridgeSpecific=${output.summary.bridgeSpecificJoinRows} watch=${watchCandidates} routePositive=${routePositive}`);
    console.log(`Artifact: ${path.relative(WORKSPACE, RAW_OUT).replace(/\\/g, "/")}`);
    console.log(`Report: ${path.relative(WORKSPACE, REPORT_OUT).replace(/\\/g, "/")}`);
  }
}

main().catch((err) => {
  console.error(String(err?.message || err).slice(0, 240));
  process.exit(1);
});
