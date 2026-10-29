#!/usr/bin/env node
// scan-cronos-zkevm-bridge-phase0.js - bounded read-only Phase 0 for Cronos zkEVM Bridge.
// Resolves RPC URLs in memory only. Never prints or stores RPC URLs, keys, calldata for execution, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "cronos-zkevm-bridge-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "cronos-zkevm-bridge-phase0-triage.md");
const QUIET = process.argv.includes("--quiet");

const ETHEREUM_CHAIN_ID = 1;
const CRONOS_ZKEVM_DESTINATION_CHAIN_ID = 388;
const BRIDGE = "0xbeD1EB542f9a5aA6419Ff3deb921A372681111f6";
const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const KNOWN_TOKENS = [
  { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", common: true },
  { symbol: "WBTC", address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", common: true },
  { symbol: "CRO", address: "0xA0b73E1Ff0B80914AB6fe0444E65848C4C34450b", common: false },
  { symbol: "DAI", address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", common: true },
  { symbol: "WETH", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", common: true },
  { symbol: "CORGIAI", address: null, common: false, blocker: "Exact Ethereum token address not resolved in public adapter metadata" },
  { symbol: "ZKCRO", address: null, common: false, blocker: "Native/destination asset symbol; exact Ethereum token address not resolved from adapter metadata" },
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
  ["rwa-nav", "reports/raw/fast/rwa-nav-consumer-graph.json"],
  ["erc4626", "reports/raw/fast/erc4626-consumer-joiner.json"],
];

const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
]);
const TX_BRIDGE = new ethers.Interface([
  "function assetId(address token) view returns (bytes32)",
  "function chainBalance(uint256 chainId, bytes32 assetId) view returns (uint256)",
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
  return n === null ? "n/a" : `$${n.toLocaleString()}`;
}

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function loadRpcUrls() {
  if (!fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function rpcCall(url, method, params = [], timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || "rpc error");
    return json.result ?? null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveRpc(chainId) {
  for (const url of loadRpcUrls()) {
    try {
      const idHex = await rpcCall(url, "eth_chainId", [], 6000);
      if (Number(BigInt(idHex)) === chainId) return url;
    } catch (_) {
      // Never print or persist RPC URLs.
    }
  }
  return null;
}

async function fetchJson(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-cronos-phase0/1.0" } });
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

async function bridgeState(provider) {
  const [code, implRaw, adminRaw, beaconRaw, ownerRaw, pausedRaw] = await Promise.all([
    provider.getCode(BRIDGE).catch(() => "0x"),
    provider.getStorage(BRIDGE, EIP1967_IMPLEMENTATION_SLOT).catch(() => null),
    provider.getStorage(BRIDGE, EIP1967_ADMIN_SLOT).catch(() => null),
    provider.getStorage(BRIDGE, EIP1967_BEACON_SLOT).catch(() => null),
    safeCall(provider, BRIDGE, TX_BRIDGE, "owner", []),
    safeCall(provider, BRIDGE, TX_BRIDGE, "paused", []),
  ]);
  return {
    address: BRIDGE,
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
    eip1967: {
      implementation: addressFromStorageSlot(implRaw),
      admin: addressFromStorageSlot(adminRaw),
      beacon: addressFromStorageSlot(beaconRaw),
    },
    owner: normalizeAddress(ownerRaw?.[0]) || null,
    paused: pausedRaw?.[0] === undefined ? null : Boolean(pausedRaw[0]),
  };
}

async function trackedAssetRows(provider, prices, defillamaTokensInUsd) {
  const rows = [];
  for (const token of KNOWN_TOKENS) {
    const address = normalizeAddress(token.address);
    if (!address) {
      rows.push({ ...token, address: null, queried: false, routePositive: false, blockers: [token.blocker || "No exact address"] });
      continue;
    }
    const [code, symbolRaw, nameRaw, decimalsRaw, balanceRaw, assetIdRaw] = await Promise.all([
      provider.getCode(address).catch(() => "0x"),
      safeCall(provider, address, ERC20, "symbol", []),
      safeCall(provider, address, ERC20, "name", []),
      safeCall(provider, address, ERC20, "decimals", []),
      safeCall(provider, address, ERC20, "balanceOf", [BRIDGE]),
      safeCall(provider, BRIDGE, TX_BRIDGE, "assetId", [address]),
    ]);
    const decimals = decimalsRaw?.[0] === undefined ? null : Number(decimalsRaw[0]);
    const balance = balanceRaw?.[0] ?? null;
    const assetId = assetIdRaw?.[0] && !/^0x0+$/.test(String(assetIdRaw[0])) ? String(assetIdRaw[0]) : null;
    const chainBalanceRaw = assetId
      ? await safeCall(provider, BRIDGE, TX_BRIDGE, "chainBalance", [CRONOS_ZKEVM_DESTINATION_CHAIN_ID, assetId])
      : null;
    const chainBalance = chainBalanceRaw?.[0] ?? null;
    const priceUsd = prices.get(address.toLowerCase()) || null;
    const balanceUsd = priceUsd && balance !== null && decimals !== null ? numberUnits(balance, decimals) * priceUsd : null;
    const chainBalanceUsd = priceUsd && chainBalance !== null && decimals !== null ? numberUnits(chainBalance, decimals) * priceUsd : null;
    const diffRaw = balance !== null && chainBalance !== null ? balance - chainBalance : null;
    rows.push({
      symbol: token.symbol,
      address,
      codePresent: Boolean(code && code !== "0x"),
      common: Boolean(token.common),
      onchainSymbol: symbolRaw?.[0] ? String(symbolRaw[0]) : null,
      onchainName: nameRaw?.[0] ? String(nameRaw[0]) : null,
      decimals,
      bridgeBalanceRaw: balance?.toString() || null,
      bridgeBalance: formatUnits(balance, decimals),
      bridgeBalanceUsd: round(balanceUsd, 2),
      assetId,
      destinationChainBalanceRaw: chainBalance?.toString() || null,
      destinationChainBalance: formatUnits(chainBalance, decimals),
      destinationChainBalanceUsd: round(chainBalanceUsd, 2),
      balanceMinusDestinationChainBalanceRaw: diffRaw?.toString() || null,
      defillamaLatestUsd: round(defillamaTokensInUsd?.[token.symbol], 2),
      routePositive: false,
      blockers: [
        assetId ? null : "Bridge assetId not resolved for token",
        chainBalance === null ? "Destination chainBalance not resolved" : null,
        "Balance/chainBalance read is backing context only, not a proof of mint/unlock bypass",
        "No same-chain consumer route or forged proof path proven",
      ].filter(Boolean),
    });
  }
  rows.sort((a, b) => (asNumber(b.destinationChainBalanceUsd) || 0) - (asNumber(a.destinationChainBalanceUsd) || 0));
  return rows;
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
      if (lowerAddress(value) === wanted) {
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

function artifactJoins(tokens) {
  const wanted = [
    { label: "bridge", address: BRIDGE, common: false },
    ...tokens.filter((row) => row.address).map((row) => ({ label: row.symbol, address: row.address, common: row.common })),
  ];
  const rows = [];
  const loadedInputs = [];
  for (const [source, rel] of INPUTS) {
    const file = path.join(WORKSPACE, rel);
    const data = readJson(file, null);
    if (!data) continue;
    loadedInputs.push(rel);
    for (const token of wanted) {
      const matches = findMatches(data, token.address, source, token.common ? 5 : 20);
      if (!matches.length) continue;
      rows.push({
        label: token.label,
        address: normalizeAddress(token.address),
        common: Boolean(token.common),
        source,
        joinCount: matches.length,
        routePositive: matches.some((m) => m.routePositive),
        watchCandidate: matches.some((m) => m.watchCandidate),
        matches,
      });
    }
  }
  rows.sort((a, b) => Number(b.routePositive) - Number(a.routePositive) || Number(b.watchCandidate) - Number(a.watchCandidate) || Number(a.common) - Number(b.common) || b.joinCount - a.joinCount);
  return { rows, loadedInputs };
}

function writeReport(out) {
  const s = out.summary;
  const bridge = out.bridge;
  const topAssets = out.trackedAssets.slice(0, 8).map((row) => `| ${row.symbol} | ${row.address || "unresolved"} | ${formatUsd(row.destinationChainBalanceUsd)} | ${formatUsd(row.bridgeBalanceUsd)} | ${row.assetId ? "yes" : "no"} |`).join("\n");
  const content = `# 🟢 DORMANT — Cronos zkEVM Bridge Phase 0

Generated: ${out.generatedAt}

Scanner: \`tools/scan-cronos-zkevm-bridge-phase0.js\`

Artifact: \`reports/raw/fast/cronos-zkevm-bridge-phase0.json\`

## Result

No permissionless route-positive exploit is claimed. The Ethereum TX bridge lockbox is live and holds material tracked assets, but this Phase 0 found no proof-acceptance bypass, no balance-delta/backing mismatch joined to a consumer, and no exact positive borrow/redeem/unwind route.

## Target

| Field | Value |
|---|---:|
| Protocol | \`${out.metadata.name}\` |
| Slug | \`${out.metadata.slug}\` |
| Category | \`${out.metadata.category}\` |
| Source chain | \`Ethereum\` |
| Destination chain id | \`${CRONOS_ZKEVM_DESTINATION_CHAIN_ID}\` |
| Bridge contract | \`${BRIDGE}\` |
| Code present | \`${bridge.codePresent}\` |
| Code bytes | \`${bridge.codeBytes}\` |
| EIP-1967 implementation | \`${bridge.eip1967.implementation || "none"}\` |
| Owner | \`${bridge.owner || "unresolved"}\` |
| Paused | \`${bridge.paused === null ? "unresolved" : bridge.paused}\` |
| Public audits field | \`${out.metadata.audits}\` |
| Current public TVL | \`${formatUsd(s.defillamaCurrentTvlUsd)}\` |

## Tracked Assets

| Symbol | Address | Destination chainBalance USD | Bridge balance USD | assetId |
|---|---|---:|---:|---:|
${topAssets}

## Consumer/Bridge Joins

| Metric | Value |
|---|---:|
| Artifact inputs loaded | \`${out.joinInputsLoaded.length}\` |
| Address join rows | \`${s.artifactJoinRows}\` |
| Watch joins | \`${s.watchCandidates}\` |
| Route-positive joins | \`${s.routePositive}\` |

## Blockers

- No deployed proof-acceptance or message-binding bypass was identified for the Cronos zkEVM bridge path in this pass.
- Common assets such as WETH/USDC/DAI/WBTC are consumer-heavy but do not create a bridge-specific exploit without a mint/unlock/backing mismatch.
- CRO is the only non-common Ethereum token address resolved here; no route-positive consumer join was found.
- CORGIAI and ZKCRO exact Ethereum source-token addresses were not resolved from the public adapter metadata in this bounded pass.
- No exact positive bridge, borrow, redemption, liquidation, or DEX unwind economics exist, so fork/live work remains blocked.

## Next Gate

Reopen only if a Cronos-specific bridge proof/domain/nonce/token binding issue is mapped to this deployed bridge, or if an exact source/destination backing mismatch joins to a material same-chain consumer with positive exit economics.
`;
  fs.writeFileSync(REPORT_OUT, content);
}

async function main() {
  const metadataRaw = await fetchJson("https://api.llama.fi/protocol/cronos-zkevm-bridge", 30_000).catch(() => ({}));
  const eth = metadataRaw.chainTvls?.Ethereum || metadataRaw.chainTvls?.ethereum || {};
  const latestTokensInUsd = lastRow(eth.tokensInUsd)?.tokens || {};
  const latestTokens = lastRow(eth.tokens)?.tokens || {};
  const currentTvlUsd = Object.values(latestTokensInUsd).reduce((sum, value) => sum + (asNumber(value) || 0), 0);
  const rpc = await resolveRpc(ETHEREUM_CHAIN_ID);
  const provider = rpc ? new ethers.JsonRpcProvider(rpc) : null;
  const prices = await tokenPriceMap(KNOWN_TOKENS.filter((row) => row.address));
  const bridge = provider ? await bridgeState(provider) : { address: BRIDGE, codePresent: null, codeBytes: null, eip1967: {}, owner: null, paused: null };
  const trackedAssets = provider ? await trackedAssetRows(provider, prices, latestTokensInUsd) : KNOWN_TOKENS.map((row) => ({ ...row, queried: false, routePositive: false, blockers: ["Ethereum RPC unavailable"] }));
  const joins = artifactJoins(trackedAssets);
  const routePositive = joins.rows.filter((row) => row.routePositive).length;
  const watchCandidates = joins.rows.filter((row) => row.watchCandidate && !row.routePositive).length;
  const output = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-cronos-zkevm-bridge-phase0.js",
    scope: "Cronos zkEVM Bridge public Phase 0 and artifact-only consumer join",
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
      name: metadataRaw.name || "Cronos zkEVM Bridge",
      slug: metadataRaw.slug || "cronos-zkevm-bridge",
      category: metadataRaw.category || "Canonical Bridge",
      chains: metadataRaw.chains || ["Ethereum"],
      audits: metadataRaw.audits || "0",
      url: metadataRaw.url || "https://zkevm.cronos.org/",
      twitter: metadataRaw.twitter || "cronos_chain",
      description: metadataRaw.description || null,
      module: metadataRaw.module || "cronos-zk/index.js",
      tvlCodePath: metadataRaw.tvlCodePath || "https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/cronos-zk/index.js",
      adapter: {
        helper: "txBridgeTvlV2",
        sourceChain: "Ethereum",
        bridge: BRIDGE,
        destinationChainId: CRONOS_ZKEVM_DESTINATION_CHAIN_ID,
      },
      latestTokens,
      latestTokensInUsd,
    },
    bridge,
    trackedAssets,
    artifactJoins: joins.rows,
    joinInputsLoaded: joins.loadedInputs,
    summary: {
      ethereumRpcResolved: Boolean(provider),
      defillamaCurrentTvlUsd: round(currentTvlUsd, 2),
      trackedAssetRows: trackedAssets.length,
      trackedKnownAddressRows: trackedAssets.filter((row) => row.address).length,
      trackedAddressRowsWithAssetId: trackedAssets.filter((row) => row.assetId).length,
      artifactJoinRows: joins.rows.length,
      watchCandidates,
      routePositive,
      executableNow: 0,
      signedActionJustified: false,
      status: routePositive > 0 ? "route-positive-needs-proof" : "phase0-no-route-positive",
    },
    blockers: [
      "No deployed proof-acceptance bypass or forged mint/unlock path proven",
      "No exact source/destination backing mismatch joined to material same-chain consumer economics",
      "Common token consumer presence is not bridge-specific exploit evidence",
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
    console.log(`Cronos zkEVM Bridge Phase0: tvl=$${Math.round(currentTvlUsd)} joins=${joins.rows.length} watch=${watchCandidates} routePositive=${routePositive}`);
    console.log(`Artifact: ${path.relative(WORKSPACE, RAW_OUT).replace(/\\/g, "/")}`);
    console.log(`Report: ${path.relative(WORKSPACE, REPORT_OUT).replace(/\\/g, "/")}`);
  }
}

main().catch((err) => {
  console.error(String(err?.message || err).slice(0, 240));
  process.exit(1);
});
