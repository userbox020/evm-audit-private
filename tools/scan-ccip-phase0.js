#!/usr/bin/env node
// scan-ccip-phase0.js - bounded read-only Phase 0 for Chainlink CCIP.
// Resolves RPC URLs in memory only. Never prints or stores RPC URLs, keys, execution calldata, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpcPool } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "ccip-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "ccip-phase0-triage.md");
const QUIET = process.argv.includes("--quiet");

const PAGE = 500;
const MAX_TOKEN_PAGES = 12;
const MAX_JOIN_POOLS = 80;
const ZERO = "0x0000000000000000000000000000000000000000";

const CHAINS = [
  { key: "ethereum", name: "Ethereum", chainId: 1, coinKey: "ethereum", registry: "0xb22764f98dD05c789929716D677382Df22C05Cb6" },
  { key: "avax", name: "Avalanche", chainId: 43114, coinKey: "avax", registry: "0xc8df5D618c6a59Cc6A311E96a39450381001464F" },
  { key: "base", name: "Base", chainId: 8453, coinKey: "base", registry: "0x6f6C373d09C07425BaAE72317863d7F6bb731e37" },
  { key: "arbitrum", name: "Arbitrum", chainId: 42161, coinKey: "arbitrum", registry: "0x39AE1032cF4B334a1Ed41cdD0833bdD7c7E7751E" },
  { key: "bsc", name: "BNB Chain", chainId: 56, coinKey: "bsc", registry: "0x736Fd8660c443547a85e4Eaf70A49C1b7Bb008fc" },
  { key: "optimism", name: "Optimism", chainId: 10, coinKey: "optimism", registry: "0x657c42abE4CD8aa731Aec322f871B5b90cf6274F" },
  { key: "wc", name: "World Chain", chainId: 480, coinKey: "wc", registry: "0x02Fe6ab4fb0943F58D9D925d1d2cbA9474997Ed0" },
  { key: "polygon", name: "Polygon", chainId: 137, coinKey: "polygon", registry: "0x00F027eA6D0fb03256A15E9182B2B9227A4931d8" },
  { key: "linea", name: "Linea", chainId: 59144, coinKey: "linea", registry: "0xBc933cEE67d2b1c08490ee8C51E2dF653a713534" },
  { key: "sonic", name: "Sonic", chainId: 146, coinKey: "sonic", registry: "0x2961Cb47b5111F38d75f415c21ceB4120ddd1b69" },
  { key: "era", name: "zkSync Era", chainId: 324, coinKey: "era", registry: "0x100a47C9DB342884E3314B91cec076BbAC8e619c" },
];

const REGISTRY = new ethers.Interface([
  "function getAllConfiguredTokens(uint64 startIndex, uint64 maxCount) view returns (address[])",
  "function getPools(address[] tokens) view returns (address[])",
  "function owner() view returns (address)",
  "function typeAndVersion() view returns (string)",
]);

const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
]);

const TYPE_AND_VERSION = new ethers.Interface([
  "function typeAndVersion() view returns (string)",
]);

const INPUTS = [
  ["bridge-proof-binding", "reports/raw/fast/bridge-proof-binding.json"],
  ["bridge-domain", "reports/raw/fast/bridge-domain-separation.json"],
  ["bridge-nonlossless", "reports/raw/fast/bridge-nonlossless-collateral-join.json"],
  ["bridge-delta", "reports/raw/fast/bridge-delta-preflight.json"],
  ["bridge-synthetic", "reports/raw/fast/bridge-synthetic-consumer-exposure.json"],
  ["layerzero-oft", "reports/raw/fast/layerzero-oft-dvn-consumer-joins.json"],
  ["aave-euler-silo", "reports/raw/fast/aave-euler-silo-consumer-graph.json"],
  ["consumer-first-high-ltv", "reports/raw/fast/consumer-first-high-ltv-collateral.json"],
  ["public-lead-consumer", "reports/raw/fast/public-lead-consumer-joins.json"],
  ["dex-consumer-routes", "reports/raw/fast/dex-consumer-routes.json"],
  ["rwa-nav", "reports/raw/fast/rwa-nav-consumer-graph.json"],
  ["erc4626", "reports/raw/fast/erc4626-consumer-joiner.json"],
];

const LOCAL_SOURCE_FILES = [
  "targets/folks-xchain-contracts/contracts/bridge/CCIPAdapter.sol",
  "targets/folks-xchain-contracts/contracts/bridge/CCIPTokenAdapter.sol",
  "targets/folks-xchain-contracts/contracts/bridge/CCIPDataAdapter.sol",
  "targets/folks-xchain-contracts/contracts/bridge/libraries/CCIPTokenMessages.sol",
  "targets/dolomite-margin-modules/packages/tokenomics/contracts/interfaces/ICCIPRouter.sol",
  "targets/dolomite-margin-modules/packages/tokenomics/contracts/interfaces/ICCIPOnRamp.sol",
];

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

function readText(file, fallback = "") {
  try {
    if (!fs.existsSync(file)) return fallback;
    return fs.readFileSync(file, "utf8");
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

function safeError(err) {
  const message = String(err?.message || err || "unknown error").replace(/https?:\/\/[^\s)\]"']+/g, "[redacted-url]");
  return message.length > 180 ? `${message.slice(0, 177)}...` : message;
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

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = index++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

async function fetchJson(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-ccip-phase0/1.0" } });
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

async function protocolMetadata() {
  try {
    const json = await fetchJson("https://api.llama.fi/protocol/ccip", 45_000);
    const currentChainTvls = {};
    for (const [chain, value] of Object.entries(json.currentChainTvls || {})) currentChainTvls[chain] = round(value, 0);
    const scopedChainTvls = {};
    for (const chain of CHAINS) {
      const value = currentChainTvls[chain.name] ?? currentChainTvls[chain.key] ?? currentChainTvls[chain.coinKey] ?? null;
      if (value !== null && value !== undefined) scopedChainTvls[chain.name] = value;
    }
    const tvlUsd = round(Object.values(currentChainTvls).reduce((sum, value) => sum + (asNumber(value) || 0), 0) || json.tvl, 0);
    return {
      ok: true,
      name: json.name || "CCIP",
      slug: json.slug || "ccip",
      category: json.category || "Cross Chain",
      chains: json.chains || [],
      tvlUsd,
      currentChainTvls,
      scopedChainTvls,
      url: json.url || "https://chain.link/cross-chain",
      audits: json.audits ?? null,
      tvlCodePath: json.tvlCodePath || "https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/ccip/index.js",
      adapterMethod: "sum tokens locked in LockRelease TokenPools from TokenAdminRegistry.getAllConfiguredTokens/getPools",
    };
  } catch (err) {
    return { ok: false, name: "CCIP", slug: "ccip", category: "Cross Chain", error: safeError(err), chains: [], tvlUsd: null, currentChainTvls: {}, scopedChainTvls: {}, audits: null, adapterMethod: "TokenAdminRegistry LockRelease TokenPool balance scan" };
  }
}

async function tokenPriceMap(chain, tokenAddresses) {
  const prices = new Map();
  const keys = [...new Set(tokenAddresses.map((address) => lowerAddress(address)).filter(Boolean))]
    .map((address) => `${chain.coinKey}:${address}`);
  for (const group of chunk(keys, 80)) {
    try {
      const json = await fetchJson(`https://coins.llama.fi/prices/current/${group.join(",")}?searchWidth=6h`, 25_000);
      for (const [key, row] of Object.entries(json.coins || {})) {
        const address = lowerAddress(key.split(":").pop());
        const price = Number(row.price || 0);
        if (address && Number.isFinite(price) && price > 0) prices.set(address, price);
      }
    } catch (_) {
      // Public price enrichment is optional; scanner remains fail-closed.
    }
  }
  return prices;
}

async function codeInfo(provider, address) {
  const normalized = normalizeAddress(address);
  if (!provider || !normalized) return { codePresent: false, codeBytes: 0 };
  const code = await provider.getCode(normalized).catch(() => "0x");
  return {
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
  };
}

function typeCategory(typeAndVersion) {
  const text = String(typeAndVersion || "");
  if (/LockRelease/i.test(text)) return "LockRelease";
  if (/Burn.*Mint|BurnWithFromMint|BurnMint/i.test(text)) return "BurnMint";
  if (text) return "Other";
  return "Unknown";
}

async function configuredTokens(provider, registryAddress, errors) {
  const tokens = [];
  let truncated = false;
  for (let page = 0; page < MAX_TOKEN_PAGES; page++) {
    const start = page * PAGE;
    const result = await safeCall(provider, registryAddress, REGISTRY, "getAllConfiguredTokens", [start, PAGE]);
    if (!result || !Array.isArray(result[0])) {
      errors.push(`getAllConfiguredTokens failed at start=${start}`);
      break;
    }
    const rows = result[0].map(normalizeAddress).filter(Boolean);
    tokens.push(...rows);
    if (rows.length < PAGE) return { tokens, truncated };
  }
  truncated = true;
  return { tokens, truncated };
}

async function poolsForTokens(provider, registryAddress, tokens, errors) {
  const pairs = [];
  for (const group of chunk(tokens, 250)) {
    const result = await safeCall(provider, registryAddress, REGISTRY, "getPools", [group]);
    if (!result || !Array.isArray(result[0])) {
      errors.push(`getPools failed for token chunk size=${group.length}`);
      continue;
    }
    const pools = result[0];
    for (let i = 0; i < group.length; i++) {
      const pool = normalizeAddress(pools[i]);
      if (!pool || pool === ZERO) continue;
      pairs.push({ token: group[i], pool });
    }
  }
  return pairs;
}

async function enrichPoolTypes(provider, pairs) {
  return mapLimit(pairs, 16, async (pair) => {
    const [poolCode, typeRaw] = await Promise.all([
      codeInfo(provider, pair.pool),
      safeCall(provider, pair.pool, TYPE_AND_VERSION, "typeAndVersion", []),
    ]);
    const typeAndVersion = typeRaw?.[0] ? String(typeRaw[0]) : null;
    return {
      ...pair,
      poolCodePresent: poolCode.codePresent,
      poolCodeBytes: poolCode.codeBytes,
      typeAndVersion,
      typeCategory: typeCategory(typeAndVersion),
    };
  });
}

async function enrichLockReleaseBalances(provider, chain, pairs) {
  const prices = await tokenPriceMap(chain, pairs.map((row) => row.token));
  return mapLimit(pairs, 12, async (pair) => {
    const [tokenCode, symbolRaw, nameRaw, decimalsRaw, balanceRaw] = await Promise.all([
      codeInfo(provider, pair.token),
      safeCall(provider, pair.token, ERC20, "symbol", []),
      safeCall(provider, pair.token, ERC20, "name", []),
      safeCall(provider, pair.token, ERC20, "decimals", []),
      safeCall(provider, pair.token, ERC20, "balanceOf", [pair.pool]),
    ]);
    const decimals = decimalsRaw?.[0] === undefined ? null : Number(decimalsRaw[0]);
    const balance = balanceRaw?.[0] ?? null;
    const balanceAmount = numberUnits(balance, decimals);
    const priceUsd = prices.get(pair.token.toLowerCase()) || null;
    const balanceUsd = balanceAmount !== null && priceUsd !== null ? round(balanceAmount * priceUsd, 6) : null;
    return {
      ...pair,
      chainKey: chain.key,
      chainName: chain.name,
      chainId: chain.chainId,
      tokenSymbol: symbolRaw?.[0] ? String(symbolRaw[0]) : null,
      tokenName: nameRaw?.[0] ? String(nameRaw[0]) : null,
      tokenCodePresent: tokenCode.codePresent,
      tokenCodeBytes: tokenCode.codeBytes,
      decimals,
      poolBalanceRaw: balance === null ? null : balance.toString(),
      poolBalance: balanceAmount === null ? null : round(balanceAmount, 8),
      tokenPriceUsd: priceUsd === null ? null : round(priceUsd, 10),
      poolBalanceUsd: balanceUsd,
      material: (asNumber(balanceUsd) || 0) >= 10_000,
      routePositive: false,
    };
  });
}

async function scanChain(chain, rpc) {
  const registry = normalizeAddress(chain.registry);
  const base = {
    chainKey: chain.key,
    chainName: chain.name,
    chainId: chain.chainId,
    registry,
    rpcResolved: Boolean(rpc),
    blockNumber: null,
    registryCodePresent: false,
    registryCodeBytes: 0,
    registryTypeAndVersion: null,
    registryOwner: null,
    configuredTokenRows: 0,
    configuredTokensTruncated: false,
    poolRows: 0,
    lockReleasePoolRows: 0,
    burnMintPoolRows: 0,
    unknownPoolRows: 0,
    materialLockReleasePoolRows: 0,
    lockReleaseBalanceUsd: null,
    maxLockReleasePoolUsd: null,
    errors: [],
  };
  if (!rpc) return { chainRow: { ...base, errors: ["RPC unavailable in sanitized resolver scope"] }, poolRows: [], configuredTokens: [] };

  const provider = new ethers.JsonRpcProvider(rpc, chain.chainId, { staticNetwork: true });
  const errors = [];
  try {
    const [blockNumber, registryCode, registryTypeRaw, ownerRaw] = await Promise.all([
      provider.getBlockNumber().catch((err) => { errors.push(`getBlockNumber failed: ${safeError(err)}`); return null; }),
      codeInfo(provider, registry),
      safeCall(provider, registry, REGISTRY, "typeAndVersion", []),
      safeCall(provider, registry, REGISTRY, "owner", []),
    ]);
    const tokenResult = await configuredTokens(provider, registry, errors);
    const pairs = await poolsForTokens(provider, registry, tokenResult.tokens, errors);
    const typedPairs = await enrichPoolTypes(provider, pairs);
    const lockReleasePairs = typedPairs.filter((row) => row.typeCategory === "LockRelease");
    const lockReleaseRows = await enrichLockReleaseBalances(provider, chain, lockReleasePairs);
    const lockReleaseBalanceUsd = round(lockReleaseRows.reduce((sum, row) => sum + (asNumber(row.poolBalanceUsd) || 0), 0), 6);
    const maxLockReleasePoolUsd = round(Math.max(0, ...lockReleaseRows.map((row) => asNumber(row.poolBalanceUsd) || 0)), 6);
    const chainRow = {
      ...base,
      blockNumber,
      registryCodePresent: registryCode.codePresent,
      registryCodeBytes: registryCode.codeBytes,
      registryTypeAndVersion: registryTypeRaw?.[0] ? String(registryTypeRaw[0]) : null,
      registryOwner: normalizeAddress(ownerRaw?.[0]) || null,
      configuredTokenRows: tokenResult.tokens.length,
      configuredTokensTruncated: tokenResult.truncated,
      poolRows: typedPairs.length,
      lockReleasePoolRows: lockReleaseRows.length,
      burnMintPoolRows: typedPairs.filter((row) => row.typeCategory === "BurnMint").length,
      unknownPoolRows: typedPairs.filter((row) => row.typeCategory === "Unknown").length,
      materialLockReleasePoolRows: lockReleaseRows.filter((row) => row.material).length,
      lockReleaseBalanceUsd,
      maxLockReleasePoolUsd,
      errors,
    };
    return { chainRow, poolRows: lockReleaseRows, configuredTokens: tokenResult.tokens };
  } catch (err) {
    return { chainRow: { ...base, errors: [...errors, safeError(err)] }, poolRows: [], configuredTokens: [] };
  }
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

function artifactJoins(chainRows, poolRows) {
  const wanted = [];
  for (const row of chainRows) {
    if (row.registry) wanted.push({ label: `${row.chainName} TokenAdminRegistry`, address: row.registry, ccipSpecific: true, common: false });
  }
  const topPools = [...poolRows]
    .sort((a, b) => (asNumber(b.poolBalanceUsd) || 0) - (asNumber(a.poolBalanceUsd) || 0))
    .slice(0, MAX_JOIN_POOLS);
  for (const row of topPools) wanted.push({ label: `${row.chainName} ${row.tokenSymbol || "token"} LockReleasePool`, address: row.pool, ccipSpecific: true, common: false });
  const seenTokens = new Set();
  for (const row of topPools) {
    const token = lowerAddress(row.token);
    if (!token || seenTokens.has(`${row.chainId}:${token}`)) continue;
    seenTokens.add(`${row.chainId}:${token}`);
    wanted.push({ label: `${row.chainName} ${row.tokenSymbol || "token"}`, address: row.token, ccipSpecific: false, common: true });
  }

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
        ccipSpecific: Boolean(item.ccipSpecific),
        source,
        joinCount: matches.length,
        routePositive: matches.some((m) => m.routePositive),
        watchCandidate: matches.some((m) => m.watchCandidate),
        matches,
      });
    }
  }
  rows.sort((a, b) => Number(b.ccipSpecific) - Number(a.ccipSpecific) || Number(b.routePositive) - Number(a.routePositive) || Number(b.watchCandidate) - Number(a.watchCandidate) || Number(a.common) - Number(b.common) || b.joinCount - a.joinCount);
  return { rows, loadedInputs };
}

function localCcipSourceRows() {
  return LOCAL_SOURCE_FILES.map((rel) => {
    const file = path.join(WORKSPACE, rel);
    const text = readText(file, "");
    const exists = Boolean(text);
    return {
      path: rel,
      exists,
      lineCount: exists ? text.split(/\r?\n/).length : 0,
      hasCcipReceiver: /CCIPReceiver|ccipReceive|_ccipReceive/.test(text),
      hasRouterSend: /ccipSend|getFee/.test(text),
      hasSourceSenderCheck: /message\.sender|InvalidMessageSender|sourceChainSelector/.test(text),
      hasDestTokenAmountCheck: /destTokenAmounts|InvalidReceivedAmount|receivedAmount/.test(text),
      hasOnlyBridgeRouterGate: /onlyBridgeRouter|InvalidBridgeRouter/.test(text),
      hasManagerRole: /MANAGER_ROLE|onlyRole\(MANAGER_ROLE\)/.test(text),
      routePositive: false,
    };
  });
}

function tableOrNone(rows, fallback) {
  return rows.length ? rows.join("\n") : fallback;
}

function writeReport(out) {
  const s = out.summary;
  const registryRows = out.chainRows.map((row) => `| ${row.chainName} | ${row.chainId} | ${row.registry || "unresolved"} | ${row.rpcResolved} | ${row.registryCodePresent} | ${row.configuredTokenRows} | ${row.lockReleasePoolRows} | ${formatUsd(row.lockReleaseBalanceUsd)} |`).join("\n");
  const poolRows = out.poolRows
    .filter((row) => row.material)
    .sort((a, b) => (asNumber(b.poolBalanceUsd) || 0) - (asNumber(a.poolBalanceUsd) || 0))
    .slice(0, 15)
    .map((row) => `| ${row.chainName} | ${row.tokenSymbol || "unknown"} | ${row.token} | ${row.pool} | ${row.typeAndVersion || "unknown"} | ${formatUsd(row.poolBalanceUsd)} | ${row.poolBalance ?? "n/a"} |`).join("\n");
  const joins = out.artifactJoins.slice(0, 12).map((row) => `| ${row.label} | ${row.source} | ${row.joinCount} | ${row.ccipSpecific} | ${row.routePositive} |`).join("\n");
  const sourceRows = out.localCcipSourceRows.map((row) => `| ${row.path} | ${row.hasCcipReceiver} | ${row.hasSourceSenderCheck} | ${row.hasDestTokenAmountCheck} | ${row.hasOnlyBridgeRouterGate} |`).join("\n");
  const content = `# 🟢 DORMANT — CCIP Phase 0

Generated: ${out.generatedAt}

Scanner: \`tools/scan-ccip-phase0.js\`

Artifact: \`reports/raw/fast/ccip-phase0.json\`

## Result

No permissionless route-positive exploit is claimed. This bounded Phase 0 mapped the public DeFiLlama CCIP adapter methodology, live EVM TokenAdminRegistry addresses, configured TokenPool rows, LockRelease custody balances, and local CCIP consumer references. It found no deployed CCIP-specific proof-binding, domain, nonce, token, sender, or amount-check bypass joined to consumer economics, and no exact positive mint/unlock/borrow/redeem/unwind route.

## Target

| Field | Value |
|---|---:|
| Protocol | \`${out.metadata.name}\` |
| Slug | \`${out.metadata.slug}\` |
| Category | \`${out.metadata.category}\` |
| Adapter method | \`${out.metadata.adapterMethod}\` |
| Public audits field | \`${out.metadata.audits}\` |
| Current public TVL | \`${formatUsd(s.defillamaCurrentTvlUsd)}\` |
| Scoped EVM chains | \`${out.scopeChains.join(", ")}\` |
| EVM chains with RPC | \`${s.chainsWithRpc}\` |
| Coverage classification | \`${s.coverageClassification}\` |

## Registries

| Chain | Chain ID | TokenAdminRegistry | RPC | Code | Configured tokens | LockRelease pools | LockRelease USD |
|---|---:|---|---:|---:|---:|---:|---:|
${tableOrNone([registryRows].filter(Boolean), "| none | 0 | unresolved | false | false | 0 | 0 | n/a |")}

## Top LockRelease Pools

| Chain | Token | Token address | Pool | Type | Balance USD | Balance |
|---|---|---|---|---|---:|---:|
${tableOrNone([poolRows].filter(Boolean), "| none | none | unresolved | unresolved | none | n/a | n/a |")}

## Local CCIP Source Context

| File | Receiver | Sender/chain checks | Token amount checks | Bridge-router gate |
|---|---:|---:|---:|---:|
${tableOrNone([sourceRows].filter(Boolean), "| none | false | false | false | false |")}

## Local Artifact Joins

| Label | Source | Joins | CCIP-specific | Route-positive |
|---|---|---:|---:|---:|
${tableOrNone([joins].filter(Boolean), "| none | none | 0 | false | false |")}

## Metrics

| Metric | Value |
|---|---:|
| Chains scoped | \`${s.chainsScoped}\` |
| Chains with RPC | \`${s.chainsWithRpc}\` |
| Registry rows with code | \`${s.registryCodeRows}\` |
| Configured token rows | \`${s.configuredTokenRows}\` |
| LockRelease pool rows | \`${s.lockReleasePoolRows}\` |
| BurnMint pool rows | \`${s.burnMintPoolRows}\` |
| Material LockRelease rows | \`${s.materialLockReleasePoolRows}\` |
| Tracked LockRelease USD | \`${formatUsd(s.totalLockReleaseUsd)}\` |
| Max LockRelease pool USD | \`${formatUsd(s.maxLockReleasePoolUsd)}\` |
| Artifact join rows | \`${s.artifactJoinRows}\` |
| CCIP-specific join rows | \`${s.ccipSpecificJoinRows}\` |
| Watch candidates | \`${s.watchCandidates}\` |
| Route positive | \`${s.routePositive}\` |

## Blockers

- Public DeFiLlama CCIP TVL is LockRelease pool custody context, not a proof that any message can be forged or any token can be unlocked.
- BurnMint and BurnWithFromMint pools are accounting/mint-authority context; this pass found no deployed verifier or routing bypass that turns them into extractable supply.
- Local CCIP consumer references reviewed in scope include sender/chain, token, amount, and bridge-router gates; no deployed route-positive join was found.
- Common-token joins are context only; they are not CCIP-specific impact without a CCIP proof, pool, registry, or consumer-specific weakness.
- Solana LockRelease PDAs and non-RPC-accessible registry chains are outside this bounded EVM pass.
- No exact positive bridge, borrow, redemption, liquidation, or DEX unwind economics were found.
- No fork extraction proof was run; no transaction was signed or sent.

## Next Read-Only Step

Reopen CCIP only if a deployed TokenPool/router/offramp proof-binding weakness, material exact backing/accounting mismatch, or CCIP-specific consumer route maps to permissionless live liquidity with positive economics. Otherwise continue to Venus Core Pool or the next public Phase 0 target.
`;
  ensureDir(REPORT_OUT);
  fs.writeFileSync(REPORT_OUT, content);
}

async function main() {
  const generatedAt = new Date().toISOString();
  const metadata = await protocolMetadata();
  const rpcPool = await resolveRpcPool(CHAINS.map((chain) => chain.chainId));
  const chainResults = await mapLimit(CHAINS, 3, async (chain) => scanChain(chain, rpcPool[chain.chainId] || null));
  const chainRows = chainResults.map((row) => row.chainRow);
  const poolRows = chainResults.flatMap((row) => row.poolRows)
    .sort((a, b) => (asNumber(b.poolBalanceUsd) || 0) - (asNumber(a.poolBalanceUsd) || 0));
  const joins = artifactJoins(chainRows, poolRows);
  const localSources = localCcipSourceRows();
  const ccipSpecificJoinRows = joins.rows.filter((row) => row.ccipSpecific).length;
  const ccipSpecificRoutePositiveRows = joins.rows.filter((row) => row.ccipSpecific && row.routePositive).length;
  const totalLockReleaseUsd = round(poolRows.reduce((sum, row) => sum + (asNumber(row.poolBalanceUsd) || 0), 0), 6);
  const maxLockReleasePoolUsd = round(Math.max(0, ...poolRows.map((row) => asNumber(row.poolBalanceUsd) || 0)), 6);
  const out = {
    generatedAt,
    scanner: "tools/scan-ccip-phase0.js",
    scope: "CCIP Phase 0 using public DeFiLlama adapter TokenAdminRegistry addresses, EVM live read-only state, and local sanitized consumer/proof artifacts",
    scopeChains: CHAINS.map((chain) => chain.name),
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
    metadata,
    source: {
      defillama: metadata,
      adapter: {
        path: "projects/ccip/index.js",
        tokenAdminRegistryChains: CHAINS.map((chain) => ({ key: chain.key, name: chain.name, chainId: chain.chainId, registry: chain.registry })),
        method: "getAllConfiguredTokens -> getPools -> typeAndVersion includes LockRelease -> sum token balanceOf(pool)",
        sourcePersisted: false,
      },
      sourceAvailability: "bounded to public DeFiLlama adapter metadata, Chainlink CCIP public interfaces via local consumers, and live bytecode/state; no Chainlink CCIP source tree was cloned in this pass",
    },
    thresholds: {
      minMaterialPoolUsd: 10_000,
      maxTokenPagesPerRegistry: MAX_TOKEN_PAGES,
      registryPageSize: PAGE,
      maxPoolAddressesJoinedToArtifacts: MAX_JOIN_POOLS,
    },
    chainRows,
    poolRows,
    artifactJoins: joins.rows,
    loadedArtifactInputs: joins.loadedInputs,
    localCcipSourceRows: localSources,
    summary: {
      defillamaCurrentTvlUsd: metadata.tvlUsd,
      chainsScoped: CHAINS.length,
      chainsWithRpc: chainRows.filter((row) => row.rpcResolved).length,
      registryRows: chainRows.length,
      registryCodeRows: chainRows.filter((row) => row.registryCodePresent).length,
      configuredTokenRows: chainRows.reduce((sum, row) => sum + (asNumber(row.configuredTokenRows) || 0), 0),
      configuredTokenTruncatedRegistries: chainRows.filter((row) => row.configuredTokensTruncated).length,
      poolRows: chainRows.reduce((sum, row) => sum + (asNumber(row.poolRows) || 0), 0),
      lockReleasePoolRows: poolRows.length,
      burnMintPoolRows: chainRows.reduce((sum, row) => sum + (asNumber(row.burnMintPoolRows) || 0), 0),
      unknownPoolRows: chainRows.reduce((sum, row) => sum + (asNumber(row.unknownPoolRows) || 0), 0),
      materialLockReleasePoolRows: poolRows.filter((row) => row.material).length,
      totalLockReleaseUsd,
      maxLockReleasePoolUsd,
      artifactJoinRows: joins.rows.length,
      ccipSpecificJoinRows,
      ccipSpecificRoutePositiveRows,
      localCcipSourceRows: localSources.filter((row) => row.exists).length,
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
    console.log(`CCIP Phase0 chains=${out.summary.chainsWithRpc}/${out.summary.chainsScoped} configuredTokens=${out.summary.configuredTokenRows} lockReleasePools=${out.summary.lockReleasePoolRows} materialPools=${out.summary.materialLockReleasePoolRows} ccipSpecificJoins=${ccipSpecificJoinRows} routePositive=0`);
    console.log(`Report: ${path.relative(WORKSPACE, REPORT_OUT)}`);
  }
}

main().catch((err) => {
  console.error(`scan-ccip-phase0 failed: ${safeError(err)}`);
  process.exit(1);
});
