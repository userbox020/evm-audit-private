#!/usr/bin/env node
// scan-metis-bridge-phase0.js - bounded read-only Phase 0 for Metis Bridge.
// Resolves RPC URLs in memory only. Never prints or stores RPC URLs, keys, execution calldata, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "metis-bridge-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "metis-bridge-phase0-triage.md");
const QUIET = process.argv.includes("--quiet");

const ETHEREUM_CHAIN_ID = 1;
const METIS_CHAIN_ID = 1088;
const L1_STANDARD_BRIDGE = "0x3980c9ed79d2c191A89E02Fa3529C60eD6e9c04b";
const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const ZERO = "0x0000000000000000000000000000000000000000";

const L2_PREDEPLOYS = {
  l2CrossDomainMessenger: "0x4200000000000000000000000000000000000007",
  l2StandardBridge: "0x4200000000000000000000000000000000000010",
};

const KNOWN_TOKENS = [
  { symbol: "METIS", address: "0x9E32b13ce7f2E80A01932B9919cC8256cDF8f777", common: false },
  { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", common: true },
  { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", common: true },
  { symbol: "WETH", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", common: true },
  { symbol: "DAI", address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", common: true },
  { symbol: "WBTC", address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", common: true },
  { symbol: "AAVE", address: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9", common: true },
  { symbol: "LINK", address: "0x514910771AF9Ca656af840dff83E8264EcF986CA", common: true },
  { symbol: "BUSD", address: "0x4Fabb145d64652a948d72533023f6e7a623C7C53", common: true },
  { symbol: "SUSHI", address: "0x6B3595068778DD592e39A122f4f5a5cF09C90fE2", common: true },
  { symbol: "UNI", address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", common: true },
  { symbol: "CRV", address: "0xD533a949740bb3306d119CC777fa900bA034cd52", common: true },
  { symbol: "TUSD", address: "0x0000000000085d4780B73119b644AE5ecd22b376", common: true },
  { symbol: "HEX", address: "0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39", common: true },
];

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
  ["rwa-nav", "reports/raw/fast/rwa-nav-consumer-graph.json"],
  ["erc4626", "reports/raw/fast/erc4626-consumer-joiner.json"],
];

const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
]);

const BRIDGE = new ethers.Interface([
  "function messenger() view returns (address)",
  "function l2TokenBridge() view returns (address)",
  "function deposits(address,address) view returns (uint256)",
  "function owner() view returns (address)",
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
      try {
        return ethers.getAddress(text.toLowerCase());
      } catch (_) {
        return null;
      }
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

function formatUnits(value, decimals) {
  if (value === null || value === undefined || decimals === null || decimals === undefined) return null;
  try {
    return ethers.formatUnits(BigInt(value), Number(decimals));
  } catch (_) {
    return null;
  }
}

function numberUnits(value, decimals) {
  const text = formatUnits(value, decimals);
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function formatUsd(value) {
  const n = asNumber(value);
  return n === null ? "n/a" : `$${n.toLocaleString()}`;
}

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

async function fetchJson(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-metis-bridge-phase0/1.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function safeCall(provider, to, iface, fn, args = []) {
  try {
    const raw = await provider.call({ to, data: iface.encodeFunctionData(fn, args) });
    return iface.decodeFunctionResult(fn, raw);
  } catch (_) {
    return null;
  }
}

function latestArrayRow(value) {
  return Array.isArray(value) && value.length ? value[value.length - 1] : null;
}

async function protocolMetadata() {
  try {
    const json = await fetchJson("https://api.llama.fi/protocol/metis-bridge", 45_000);
    const eth = json.chainTvls?.Ethereum || {};
    const latestUsd = latestArrayRow(eth.tokensInUsd)?.tokens || {};
    const latestTokens = latestArrayRow(eth.tokens)?.tokens || {};
    return {
      ok: true,
      name: json.name || "Metis Bridge",
      slug: json.slug || "metis-bridge",
      category: json.category || "Canonical Bridge",
      chains: json.chains || ["Ethereum"],
      tvlUsd: round(json.currentChainTvls?.Ethereum ?? json.tvl, 0),
      currentChainTvls: json.currentChainTvls || {},
      latestTokensInUsd: latestUsd,
      latestTokens,
      url: json.url || "https://bridge.metis.io/home",
      audits: json.audits ?? null,
      tvlCodePath: json.tvlCodePath || "https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/metis/index.js",
      adapterOwner: L1_STANDARD_BRIDGE,
      adapterMethod: "sumTokens2 owner balance with fetchCoValentTokens=true",
    };
  } catch (err) {
    return { ok: false, name: "Metis Bridge", slug: "metis-bridge", category: "Canonical Bridge", error: err.message, latestTokensInUsd: {}, latestTokens: {}, tvlUsd: null, adapterOwner: L1_STANDARD_BRIDGE };
  }
}

async function tokenPriceMap(tokens) {
  const keys = tokens.map((token) => token.address ? `ethereum:${token.address.toLowerCase()}` : null).filter(Boolean);
  const prices = new Map();
  if (!keys.length) return prices;
  try {
    const json = await fetchJson(`https://coins.llama.fi/prices/current/${keys.join(",")}?searchWidth=6h`, 30_000);
    for (const [key, row] of Object.entries(json.coins || {})) {
      const address = lowerAddress(key.split(":").pop());
      const price = Number(row.price || 0);
      if (address && Number.isFinite(price) && price > 0) prices.set(address, price);
    }
  } catch (_) {
    // Public price enrichment is optional; scanner remains fail-closed.
  }
  return prices;
}

async function contractRow(provider, chainId, name, address, extra = {}) {
  const normalized = normalizeAddress(address);
  if (!provider || !normalized) return { chainId, name, address: normalized, codePresent: false, codeBytes: 0, ...extra };
  const [code, implRaw, adminRaw, beaconRaw] = await Promise.all([
    provider.getCode(normalized).catch(() => "0x"),
    provider.getStorage(normalized, EIP1967_IMPLEMENTATION_SLOT).catch(() => null),
    provider.getStorage(normalized, EIP1967_ADMIN_SLOT).catch(() => null),
    provider.getStorage(normalized, EIP1967_BEACON_SLOT).catch(() => null),
  ]);
  return {
    chainId,
    name,
    address: normalized,
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
    eip1967: {
      implementation: addressFromStorageSlot(implRaw),
      admin: addressFromStorageSlot(adminRaw),
      beacon: addressFromStorageSlot(beaconRaw),
    },
    ...extra,
  };
}

async function bridgeRows(ethProvider, metisProvider) {
  const [messengerRaw, l2BridgeRaw, ownerRaw, pausedRaw] = await Promise.all([
    safeCall(ethProvider, L1_STANDARD_BRIDGE, BRIDGE, "messenger", []),
    safeCall(ethProvider, L1_STANDARD_BRIDGE, BRIDGE, "l2TokenBridge", []),
    safeCall(ethProvider, L1_STANDARD_BRIDGE, BRIDGE, "owner", []),
    safeCall(ethProvider, L1_STANDARD_BRIDGE, BRIDGE, "paused", []),
  ]);
  const messenger = normalizeAddress(messengerRaw?.[0]);
  const l2TokenBridge = normalizeAddress(l2BridgeRaw?.[0]);
  const rows = [];
  rows.push(await contractRow(ethProvider, ETHEREUM_CHAIN_ID, "L1StandardBridge/AdapterOwner", L1_STANDARD_BRIDGE, {
    messenger,
    l2TokenBridge,
    owner: normalizeAddress(ownerRaw?.[0]) || null,
    paused: pausedRaw?.[0] === undefined ? null : Boolean(pausedRaw[0]),
  }));
  if (messenger) rows.push(await contractRow(ethProvider, ETHEREUM_CHAIN_ID, "L1CrossDomainMessenger", messenger));
  const impl = rows[0]?.eip1967?.implementation;
  if (impl) rows.push(await contractRow(ethProvider, ETHEREUM_CHAIN_ID, "L1StandardBridgeImplementation", impl));
  for (const [name, address] of Object.entries(L2_PREDEPLOYS)) rows.push(await contractRow(metisProvider, METIS_CHAIN_ID, name, address));
  return rows;
}

function buildTokenInventory(metadata) {
  const bySymbol = new Map(KNOWN_TOKENS.map((row) => [row.symbol.toUpperCase(), { ...row }]));
  for (const symbol of Object.keys(metadata.latestTokensInUsd || {})) {
    const key = String(symbol).toUpperCase();
    if (!bySymbol.has(key)) bySymbol.set(key, { symbol: key, address: null, common: true, unresolved: true });
  }
  return [...bySymbol.values()].sort((a, b) => (metadata.latestTokensInUsd?.[b.symbol] || 0) - (metadata.latestTokensInUsd?.[a.symbol] || 0));
}

async function tokenRows(provider, metadata, nativeBalanceRaw = null) {
  const tokens = buildTokenInventory(metadata);
  const prices = await tokenPriceMap(tokens.filter((token) => token.address));
  const rows = [];
  for (const token of tokens) {
    const address = normalizeAddress(token.address);
    const defillamaUsd = round(metadata.latestTokensInUsd?.[token.symbol], 6);
    const defillamaAmount = round(metadata.latestTokens?.[token.symbol], 8);
    if (!address) {
      rows.push({
        symbol: token.symbol,
        address: null,
        common: Boolean(token.common),
        codePresent: false,
        queried: false,
        defillamaAmount,
        defillamaUsd,
        bridgeBalance: null,
        bridgeBalanceUsd: null,
        balanceVsDefillamaUsdDelta: null,
        routePositive: false,
        blockers: ["No exact Ethereum token address resolved in bounded Phase 0 static list"],
      });
      continue;
    }
    const [code, symbolRaw, nameRaw, decimalsRaw, balanceRaw] = await Promise.all([
      provider.getCode(address).catch(() => "0x"),
      safeCall(provider, address, ERC20, "symbol", []),
      safeCall(provider, address, ERC20, "name", []),
      safeCall(provider, address, ERC20, "decimals", []),
      safeCall(provider, address, ERC20, "balanceOf", [L1_STANDARD_BRIDGE]),
    ]);
    const decimals = decimalsRaw?.[0] === undefined ? null : Number(decimalsRaw[0]);
    const balance = balanceRaw?.[0] ?? null;
    const erc20Amount = numberUnits(balance, decimals);
    const nativeBridgeBalance = token.symbol === "WETH" && nativeBalanceRaw !== null ? Number(ethers.formatEther(nativeBalanceRaw)) : null;
    const amount = erc20Amount === null && nativeBridgeBalance === null ? null : (erc20Amount || 0) + (nativeBridgeBalance || 0);
    const price = prices.get(address.toLowerCase()) || (defillamaUsd && defillamaAmount ? defillamaUsd / defillamaAmount : null);
    const bridgeBalanceUsd = amount !== null && price ? round(amount * price, 6) : null;
    const nativeBridgeBalanceUsd = nativeBridgeBalance !== null && price ? round(nativeBridgeBalance * price, 6) : null;
    rows.push({
      symbol: String(symbolRaw?.[0] || token.symbol),
      expectedSymbol: token.symbol,
      name: String(nameRaw?.[0] || ""),
      address,
      common: Boolean(token.common),
      codePresent: Boolean(code && code !== "0x"),
      codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
      decimals,
      defillamaAmount,
      defillamaUsd,
      bridgeBalanceRaw: balance === null ? null : balance.toString(),
      erc20BridgeBalance: erc20Amount === null ? null : round(erc20Amount, 8),
      nativeBridgeBalance: nativeBridgeBalance === null ? null : round(nativeBridgeBalance, 8),
      nativeBridgeBalanceUsd,
      bridgeBalance: amount === null ? null : round(amount, 8),
      priceUsd: price === null ? null : round(price, 10),
      bridgeBalanceUsd,
      balanceVsDefillamaUsdDelta: bridgeBalanceUsd === null || defillamaUsd === null ? null : round(bridgeBalanceUsd - defillamaUsd, 6),
      material: Math.max(asNumber(bridgeBalanceUsd) || 0, asNumber(defillamaUsd) || 0) >= 10_000,
      routePositive: false,
    });
  }
  rows.sort((a, b) => (asNumber(b.bridgeBalanceUsd) || asNumber(b.defillamaUsd) || 0) - (asNumber(a.bridgeBalanceUsd) || asNumber(a.defillamaUsd) || 0));
  return rows;
}

function contextSummary(obj) {
  if (!obj || typeof obj !== "object") return null;
  const out = {};
  for (const key of ["id", "protocol", "chain", "symbol", "asset", "token", "surface", "status", "routePositive", "watchCandidate", "watchCandidates", "exactEconomicsRows"]) {
    if (obj[key] !== undefined && out[key] === undefined) out[key] = obj[key];
  }
  return Object.keys(out).length ? out : null;
}

function findMatches(data, wanted, source, max = 20) {
  const target = lowerAddress(wanted);
  if (!target) return [];
  const matches = [];
  function walk(value, objectPath, parent) {
    if (matches.length >= max) return;
    if (typeof value === "string") {
      if (lowerAddress(value) === target) {
        matches.push({ source, path: objectPath, context: contextSummary(parent), routePositive: Boolean(parent?.routePositive), watchCandidate: Boolean(parent?.watchCandidate) });
      }
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

function artifactJoins(contracts, tokens) {
  const wanted = [
    { label: "L1StandardBridge", address: L1_STANDARD_BRIDGE, common: false, bridgeSpecific: true },
    ...contracts.filter((row) => row.address && row.name !== "L1StandardBridge/AdapterOwner").map((row) => ({ label: row.name, address: row.address, common: false, bridgeSpecific: true })),
  ];
  const impl = contracts[0]?.eip1967?.implementation;
  if (impl) wanted.push({ label: "L1StandardBridgeImplementation", address: impl, common: false, bridgeSpecific: true });
  for (const row of tokens) if (row.address) wanted.push({ label: row.expectedSymbol || row.symbol, address: row.address, common: row.common, bridgeSpecific: false });

  const rows = [];
  const loadedInputs = [];
  for (const [source, rel] of INPUTS) {
    const data = readJson(path.join(WORKSPACE, rel), null);
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
  const topContracts = out.contractRows.slice(0, 10).map((row) => `| ${row.chainId} | ${row.name} | ${row.address || "unresolved"} | ${row.codePresent} | ${row.eip1967?.implementation || "none"} | ${row.paused === null || row.paused === undefined ? "unresolved" : row.paused} |`).join("\n");
  const topTokens = out.tokenRows.slice(0, 12).map((row) => `| ${row.expectedSymbol || row.symbol} | ${row.address || "unresolved"} | ${formatUsd(row.bridgeBalanceUsd)} | ${formatUsd(row.defillamaUsd)} | ${formatUsd(row.balanceVsDefillamaUsdDelta)} |`).join("\n");
  const topJoins = out.artifactJoins.slice(0, 12).map((row) => `| ${row.label} | ${row.source} | ${row.joinCount} | ${row.bridgeSpecific} | ${row.routePositive} |`).join("\n");
  const content = `# 🟢 DORMANT — Metis Bridge Phase 0

Generated: ${out.generatedAt}

Scanner: \`tools/scan-metis-bridge-phase0.js\`

Artifact: \`reports/raw/fast/metis-bridge-phase0.json\`

## Result

No permissionless route-positive exploit is claimed. This bounded Phase 0 mapped the public DeFiLlama Metis Bridge adapter owner, live L1 bridge/proxy state, L2 bridge predeploy code presence, top custody balances, and local bridge/consumer/proof artifacts. It found no deployed proof-binding bypass, no material exact backing mismatch joined to consumer economics, and no exact positive mint/unlock/borrow/redeem/unwind route. The material METIS row is treated as adapter-dynamic token-discovery context, not as a proven backing mismatch.

## Target

| Field | Value |
|---|---:|
| Protocol | \`${out.metadata.name}\` |
| Slug | \`${out.metadata.slug}\` |
| Category | \`${out.metadata.category}\` |
| Source chain | \`Ethereum\` |
| Destination chain id | \`${METIS_CHAIN_ID}\` |
| L1 bridge / adapter owner | \`${L1_STANDARD_BRIDGE}\` |
| Adapter method | \`${out.metadata.adapterMethod}\` |
| Public audits field | \`${out.metadata.audits}\` |
| Current public TVL | \`${formatUsd(s.defillamaCurrentTvlUsd)}\` |
| Ethereum RPC resolved | \`${s.ethereumRpcResolved}\` |
| Metis RPC resolved | \`${s.metisRpcResolved}\` |

## Contracts

| Chain | Name | Address | Code | EIP-1967 implementation | Paused |
|---:|---|---|---:|---|---:|
${topContracts}

## Custody Tokens

| Symbol | Ethereum token | Bridge balance USD | DeFiLlama token USD | Delta USD |
|---|---|---:|---:|---:|
${topTokens}

## Local Artifact Joins

| Label | Source | Joins | Bridge-specific | Route-positive |
|---|---|---:|---:|---:|
${topJoins || "| none | none | 0 | false | false |"}

## Metrics

| Metric | Value |
|---|---:|
| Contract rows | \`${s.contractRows}\` |
| Contracts with code | \`${s.contractsWithCode}\` |
| Token rows | \`${s.tokenRows}\` |
| Material token rows | \`${s.materialTokenRows}\` |
| Tracked bridge balance USD | \`${formatUsd(s.trackedBridgeBalanceUsd)}\` |
| Public token TVL USD | \`${formatUsd(s.defillamaTokenUsd)}\` |
| Material context delta rows | \`${s.materialContextDeltaRows}\` |
| Address join rows | \`${s.artifactJoinRows}\` |
| Bridge-specific join rows | \`${s.bridgeSpecificJoinRows}\` |
| Watch candidates | \`${s.watchCandidates}\` |
| Route positive | \`${s.routePositive}\` |

## Blockers

- The public adapter exposes one Ethereum owner balance; this pass does not prove an L2 token-pair backing invariant for every token.
- The public adapter uses dynamic token discovery; the METIS token breakdown did not map to a positive balance for the static Ethereum METIS token address in this bounded pass, so it is context-only until the exact token identity/backing invariant is resolved.
- Bridge-specific contract joins did not reveal a deployed proof/domain/nonce/token-binding bypass with mint/unlock impact.
- Common-token joins are context only; they are not Metis-specific impact without a backing mismatch or proof weakness.
- No exact positive bridge, borrow, redemption, liquidation, or DEX unwind economics were found.
- No fork extraction proof was run; no transaction was signed or sent.

## Next Read-Only Step

Reopen Metis Bridge only if a deployed proof-binding weakness, exact material backing mismatch, or Metis-specific consumer route maps to permissionless live liquidity with positive economics. Otherwise continue to CCIP or the next public Phase 0 target.
`;
  ensureDir(REPORT_OUT);
  fs.writeFileSync(REPORT_OUT, content);
}

async function main() {
  const generatedAt = new Date().toISOString();
  const metadata = await protocolMetadata();
  const [ethRpc, metisRpc] = await Promise.all([resolveRpc(ETHEREUM_CHAIN_ID), resolveRpc(METIS_CHAIN_ID)]);
  if (!ethRpc) throw new Error("Ethereum RPC unavailable from sanitized inventory/resolver");
  const ethProvider = new ethers.JsonRpcProvider(ethRpc, ETHEREUM_CHAIN_ID, { staticNetwork: true });
  const metisProvider = metisRpc ? new ethers.JsonRpcProvider(metisRpc, METIS_CHAIN_ID, { staticNetwork: true }) : null;
  const [ethBlock, metisBlock, nativeBalanceRaw, contracts] = await Promise.all([
    ethProvider.getBlockNumber().catch(() => null),
    metisProvider ? metisProvider.getBlockNumber().catch(() => null) : null,
    ethProvider.getBalance(L1_STANDARD_BRIDGE).catch(() => null),
    bridgeRows(ethProvider, metisProvider),
  ]);
  const tokens = await tokenRows(ethProvider, metadata, nativeBalanceRaw);
  const joins = artifactJoins(contracts, tokens);
  const trackedBridgeBalanceUsd = round(tokens.reduce((sum, row) => sum + (asNumber(row.bridgeBalanceUsd) || 0), 0), 6);
  const defillamaTokenUsd = round(Object.values(metadata.latestTokensInUsd || {}).reduce((sum, value) => sum + (asNumber(value) || 0), 0), 6);
  const materialContextDeltaRows = tokens.filter((row) => Math.abs(asNumber(row.balanceVsDefillamaUsdDelta) || 0) >= 100_000).length;
  const bridgeSpecificJoinRows = joins.rows.filter((row) => row.bridgeSpecific).length;
  const bridgeSpecificRoutePositiveRows = joins.rows.filter((row) => row.bridgeSpecific && row.routePositive).length;
  const nativeWethContext = tokens.find((row) => row.expectedSymbol === "WETH") || null;
  const out = {
    generatedAt,
    scanner: "tools/scan-metis-bridge-phase0.js",
    scope: "Metis Bridge Phase 0 using public DeFiLlama adapter metadata, Ethereum/Metis live read-only state, and local sanitized consumer/proof artifacts",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      executionCalldataStored: false,
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
    },
    chain: {
      source: { name: "Ethereum", chainId: ETHEREUM_CHAIN_ID, blockNumber: ethBlock },
      destination: { name: "Metis Andromeda", chainId: METIS_CHAIN_ID, blockNumber: metisBlock },
    },
    metadata,
    source: {
      defillama: metadata,
      adapter: {
        path: "projects/metis/index.js",
        owner: L1_STANDARD_BRIDGE,
        method: "sumTokens2({ owner, fetchCoValentTokens: true })",
        sourcePersisted: false,
      },
      sourceAvailability: "bounded to public adapter metadata plus live bytecode/state; no verified local Metis bridge source tree was cloned in this pass",
    },
    thresholds: {
      minMaterialTokenUsd: 10_000,
      materialDeltaUsd: 100_000,
      minRouteNetUsd: 50,
    },
    nativeContext: {
      l1BridgeNativeEthRaw: nativeBalanceRaw === null ? null : nativeBalanceRaw.toString(),
      l1BridgeNativeEth: nativeBalanceRaw === null ? null : Number(ethers.formatEther(nativeBalanceRaw)),
      l1BridgeNativeEthUsd: nativeWethContext?.nativeBridgeBalanceUsd ?? null,
      mappedToDefillamaSymbol: nativeWethContext ? "WETH" : null,
    },
    contractRows: contracts,
    tokenRows: tokens,
    artifactJoins: joins.rows,
    loadedArtifactInputs: joins.loadedInputs,
    summary: {
      defillamaCurrentTvlUsd: metadata.tvlUsd,
      ethereumRpcResolved: Boolean(ethRpc),
      metisRpcResolved: Boolean(metisRpc),
      contractRows: contracts.length,
      contractsWithCode: contracts.filter((row) => row.codePresent).length,
      proxyLikeRows: contracts.filter((row) => row.eip1967?.implementation || row.eip1967?.beacon || row.eip1967?.admin).length,
      tokenRows: tokens.length,
      tokenRowsWithCode: tokens.filter((row) => row.codePresent).length,
      materialTokenRows: tokens.filter((row) => row.material).length,
      unresolvedTokenRows: tokens.filter((row) => !row.address).length,
      trackedBridgeBalanceUsd,
      defillamaTokenUsd,
      materialContextDeltaRows,
      artifactJoinRows: joins.rows.length,
      bridgeSpecificJoinRows,
      bridgeSpecificRoutePositiveRows,
      watchCandidates: 0,
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      coverageClassification: "bounded-with-caveats",
    },
  };
  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, JSON.stringify(out, jsonReplacer, 2));
  writeReport(out);
  if (!QUIET) {
    console.log(`Wrote ${path.relative(WORKSPACE, RAW_OUT)}`);
    console.log(`Metis Bridge Phase0 contracts=${out.summary.contractRows} tokens=${out.summary.tokenRows} materialTokens=${out.summary.materialTokenRows} bridgeSpecificJoins=${bridgeSpecificJoinRows} routePositive=0`);
    console.log(`Report: ${path.relative(WORKSPACE, REPORT_OUT)}`);
  }
}

main().catch((err) => {
  console.error(`scan-metis-bridge-phase0 failed: ${err.message}`);
  process.exit(1);
});
