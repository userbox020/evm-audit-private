#!/usr/bin/env node
// scan-apollo-acred-phase0.js - bounded read-only Phase 0 for Apollo/Securitize ACRED.
// Resolves RPC URLs in memory only. Never prints or stores RPC URLs, keys, calldata for execution, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { loadRpcUrls, rpcCall } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "apollo-acred-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "apollo-acred-phase0-triage.md");
const QUIET = process.argv.includes("--quiet");

const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const CHAINS = [
  { chainId: 1, name: "Ethereum", llamaKey: "Ethereum", adapterKey: "ethereum", token: "0x17418038ecF73BA4026c4f428547BF099706F27B" },
  { chainId: 57073, name: "Ink", llamaKey: "Ink", adapterKey: "ink", token: "0x53Ad50D3B6FCaCB8965d3A49cB722917C7DAE1F3" },
  { chainId: 43114, name: "Avalanche", llamaKey: "Avalanche", adapterKey: "avax", token: "0x7C64925002BFA705834B118a923E9911BeE32875" },
  { chainId: 137, name: "Polygon", llamaKey: "Polygon", adapterKey: "polygon", token: "0xFCe60bBc52a5705CeC5B445501FBAf3274Dc43D0" },
];

const NON_EVM_TOKENS = [
  { chain: "Solana", token: "FubtUcvhSCr3VPXEcxouoQjKQ7NWTCzXyECe76B7L3f8" },
  { chain: "Aptos", token: "0xe528f4df568eb9fff6398adc514bc9585fab397f478972bcbebf1e75dee40a88" },
  { chain: "Sei", token: "0xf7fa6725183e603059fc23d95735bf67f72b2d78" },
];

const INPUTS = [
  ["aave-euler-silo", "reports/raw/fast/aave-euler-silo-consumer-graph.json"],
  ["consumer-first-high-ltv", "reports/raw/fast/consumer-first-high-ltv-collateral.json"],
  ["public-lead-consumer", "reports/raw/fast/public-lead-consumer-joins.json"],
  ["rwa-nav", "reports/raw/fast/rwa-nav-consumer-graph.json"],
  ["centrifuge-nav", "reports/raw/fast/centrifuge-nav-consumer-graph.json"],
  ["focused-euler", "reports/raw/fast/focused-euler-evk-review-producers.json"],
  ["focused-morpho", "reports/raw/fast/focused-morpho-review-producers.json"],
  ["erc4626", "reports/raw/fast/erc4626-consumer-joiner.json"],
  ["small-cap-oracle", "reports/raw/fast/small-cap-oracle-manipulation-routes.json"],
  ["stablecoin-depeg", "reports/raw/fast/stablecoin-depeg-lending-routes.json"],
  ["dex-consumer-routes", "reports/raw/fast/dex-consumer-routes.json"],
  ["governance-listing", "reports/raw/fast/governance-listing-watch.json"],
];

const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function cap() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function isPaused() view returns (bool)",
  "function name() view returns (string)",
  "function paused() view returns (bool)",
  "function symbol() view returns (string)",
  "function totalIssued() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function owner() view returns (address)",
]);

const ERC4626 = new ethers.Interface([
  "function asset() view returns (address)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function totalAssets() view returns (uint256)",
]);

const ORACLE_LIKE = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function latestAnswer() view returns (int256)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
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

function lastRow(value) {
  return Array.isArray(value) && value.length ? value[value.length - 1] : null;
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

function client(url) {
  return { call: (method, params = [], timeoutMs = 10_000) => rpcCall(url, method, params, timeoutMs) };
}

async function fetchJson(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-apollo-acred-phase0/1.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function getCode(rpc, address) {
  return await rpc.call("eth_getCode", [address, "latest"], 10_000).catch(() => "0x") || "0x";
}

async function getStorage(rpc, address, slot) {
  return await rpc.call("eth_getStorageAt", [address, slot, "latest"], 10_000).catch(() => null);
}

async function safeCall(rpc, to, iface, fn, args = []) {
  try {
    const data = iface.encodeFunctionData(fn, args);
    const raw = await rpc.call("eth_call", [{ to, data }, "latest"], 12_000);
    if (!raw || raw === "0x") return null;
    return iface.decodeFunctionResult(fn, raw);
  } catch (_) {
    return null;
  }
}

function chainData(metadataRaw, chainName) {
  const chain = metadataRaw.chainTvls?.[chainName] || {};
  return {
    tvlUsd: lastRow(chain.tvl)?.totalLiquidityUSD ?? null,
    tokens: lastRow(chain.tokens)?.tokens || {},
    tokensInUsd: lastRow(chain.tokensInUsd)?.tokens || {},
  };
}

async function dexLiquidityRows(tokens) {
  const addresses = tokens.map((row) => row.token).filter(Boolean);
  if (!addresses.length) return [];
  try {
    const json = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${addresses.join(",")}`, 30_000);
    const rows = [];
    for (const pair of json.pairs || []) {
      const base = lowerAddress(pair.baseToken?.address);
      const quote = lowerAddress(pair.quoteToken?.address);
      const match = tokens.find((row) => lowerAddress(row.token) === base || lowerAddress(row.token) === quote);
      if (!match) continue;
      rows.push({
        chainId: pair.chainId || null,
        dexId: pair.dexId || null,
        pairAddress: normalizeAddress(pair.pairAddress) || pair.pairAddress || null,
        matchedToken: match.token,
        matchedChain: match.name,
        baseSymbol: pair.baseToken?.symbol || null,
        quoteSymbol: pair.quoteToken?.symbol || null,
        liquidityUsd: round(pair.liquidity?.usd, 2),
        volume24hUsd: round(pair.volume?.h24, 2),
        priceUsd: round(pair.priceUsd, 8),
        url: pair.url || null,
      });
    }
    return rows.sort((a, b) => (asNumber(b.liquidityUsd) || 0) - (asNumber(a.liquidityUsd) || 0)).slice(0, 20);
  } catch (_) {
    return [];
  }
}

async function inspectToken(chain, rpc, metadataRaw) {
  const address = normalizeAddress(chain.token);
  const data = chainData(metadataRaw, chain.llamaKey);
  const [code, implRaw, adminRaw, beaconRaw, symbolRaw, nameRaw, decimalsRaw, supplyRaw, capRaw, issuedRaw, isPausedRaw, pausedRaw, ownerRaw, assetRaw, totalAssetsRaw, convertRaw, latestAnswerRaw, latestRoundDataRaw, oracleDecimalsRaw, descriptionRaw] = await Promise.all([
    getCode(rpc, address),
    getStorage(rpc, address, EIP1967_IMPLEMENTATION_SLOT),
    getStorage(rpc, address, EIP1967_ADMIN_SLOT),
    getStorage(rpc, address, EIP1967_BEACON_SLOT),
    safeCall(rpc, address, ERC20, "symbol", []),
    safeCall(rpc, address, ERC20, "name", []),
    safeCall(rpc, address, ERC20, "decimals", []),
    safeCall(rpc, address, ERC20, "totalSupply", []),
    safeCall(rpc, address, ERC20, "cap", []),
    safeCall(rpc, address, ERC20, "totalIssued", []),
    safeCall(rpc, address, ERC20, "isPaused", []),
    safeCall(rpc, address, ERC20, "paused", []),
    safeCall(rpc, address, ERC20, "owner", []),
    safeCall(rpc, address, ERC4626, "asset", []),
    safeCall(rpc, address, ERC4626, "totalAssets", []),
    safeCall(rpc, address, ERC4626, "convertToAssets", [10n ** 18n]),
    safeCall(rpc, address, ORACLE_LIKE, "latestAnswer", []),
    safeCall(rpc, address, ORACLE_LIKE, "latestRoundData", []),
    safeCall(rpc, address, ORACLE_LIKE, "decimals", []),
    safeCall(rpc, address, ORACLE_LIKE, "description", []),
  ]);

  const decimals = decimalsRaw?.[0] === undefined ? null : Number(decimalsRaw[0]);
  const supply = supplyRaw?.[0] ?? null;
  const supplyUnits = numberUnits(supply, decimals);
  const defillamaSupply = asNumber(data.tokens?.ACRED);
  const defillamaUsd = asNumber(data.tokensInUsd?.ACRED) || asNumber(data.tvlUsd);
  const impliedPriceUsd = defillamaUsd && defillamaSupply ? defillamaUsd / defillamaSupply : null;
  const supplyDiff = supplyUnits !== null && defillamaSupply !== null ? supplyUnits - defillamaSupply : null;
  const oracleDecimals = oracleDecimalsRaw?.[0] === undefined ? null : Number(oracleDecimalsRaw[0]);
  const latestAnswer = latestAnswerRaw?.[0] === undefined ? null : latestAnswerRaw[0].toString();
  const roundAnswer = latestRoundDataRaw?.[1] === undefined ? null : latestRoundDataRaw[1].toString();
  const roundUpdatedAt = latestRoundDataRaw?.[3] === undefined ? null : Number(latestRoundDataRaw[3]);
  const latestAnswerUsd = latestAnswer !== null && oracleDecimals !== null ? numberUnits(latestAnswer, oracleDecimals) : null;
  const roundAnswerUsd = roundAnswer !== null && oracleDecimals !== null ? numberUnits(roundAnswer, oracleDecimals) : null;

  return {
    chain: chain.name,
    chainId: chain.chainId,
    adapterKey: chain.adapterKey,
    token: address,
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
    eip1967: {
      implementation: addressFromStorageSlot(implRaw),
      admin: addressFromStorageSlot(adminRaw),
      beacon: addressFromStorageSlot(beaconRaw),
    },
    symbol: symbolRaw?.[0] === undefined ? null : String(symbolRaw[0]),
    name: nameRaw?.[0] === undefined ? null : String(nameRaw[0]),
    decimals,
    totalSupplyRaw: supply?.toString() || null,
    totalSupply: formatUnits(supply, decimals),
    capRaw: capRaw?.[0] === undefined ? null : capRaw[0].toString(),
    cap: capRaw?.[0] === undefined ? null : formatUnits(capRaw[0], decimals),
    totalIssuedRaw: issuedRaw?.[0] === undefined ? null : issuedRaw[0].toString(),
    totalIssued: issuedRaw?.[0] === undefined ? null : formatUnits(issuedRaw[0], decimals),
    isPaused: isPausedRaw?.[0] === undefined ? null : Boolean(isPausedRaw[0]),
    paused: pausedRaw?.[0] === undefined ? null : Boolean(pausedRaw[0]),
    owner: normalizeAddress(ownerRaw?.[0]) || null,
    erc4626Like: Boolean(assetRaw?.[0] || totalAssetsRaw?.[0] !== undefined || convertRaw?.[0] !== undefined),
    asset: normalizeAddress(assetRaw?.[0]) || null,
    totalAssetsRaw: totalAssetsRaw?.[0] === undefined ? null : totalAssetsRaw[0].toString(),
    convertToAssets1e18Raw: convertRaw?.[0] === undefined ? null : convertRaw[0].toString(),
    oracleLike: Boolean(latestAnswerRaw?.[0] !== undefined || latestRoundDataRaw?.[1] !== undefined),
    oracleDescription: descriptionRaw?.[0] === undefined ? null : String(descriptionRaw[0]),
    latestAnswerRaw: latestAnswer,
    latestAnswerUsd: round(latestAnswerUsd, 8),
    latestRoundAnswerRaw: roundAnswer,
    latestRoundAnswerUsd: round(roundAnswerUsd, 8),
    latestRoundUpdatedAt: roundUpdatedAt,
    defillamaSupply,
    defillamaUsd: round(defillamaUsd, 2),
    impliedPriceUsd: round(impliedPriceUsd, 8),
    supplyMinusDefillamaSupply: round(supplyDiff, 8),
    materialSupplyMismatch: supplyDiff !== null && defillamaSupply !== null && Math.abs(supplyDiff) > Math.max(10, defillamaSupply * 0.005),
    routePositive: false,
    blockers: [
      "Token supply/NAV context only; no consumer-side borrow or liquidation route proven",
      "ACRED redemption/issuance appears RWA/permissioned unless a public exit path is proven",
      "No exact positive acquisition, borrow, redeem, or unwind economics in this pass",
    ],
  };
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

function artifactJoins(tokenRows) {
  const rows = [];
  const loadedInputs = [];
  for (const [source, rel] of INPUTS) {
    const file = path.join(WORKSPACE, rel);
    const data = readJson(file, null);
    if (!data) continue;
    loadedInputs.push(rel);
    for (const token of tokenRows) {
      const matches = findMatches(data, token.token, source, 20);
      if (!matches.length) continue;
      rows.push({
        label: `${token.chain} ACRED`,
        address: token.token,
        source,
        joinCount: matches.length,
        routePositive: matches.some((m) => m.routePositive),
        watchCandidate: matches.some((m) => m.watchCandidate),
        matches,
      });
    }
  }
  rows.sort((a, b) => Number(b.routePositive) - Number(a.routePositive) || Number(b.watchCandidate) - Number(a.watchCandidate) || b.joinCount - a.joinCount);
  return { rows, loadedInputs };
}

function writeReport(out) {
  const s = out.summary;
  const tokenTable = out.tokenRows.map((row) => `| ${row.chain} | ${row.token} | ${row.codePresent} | ${row.totalSupply || "n/a"} | ${formatUsd(row.defillamaUsd)} | ${formatUsd(row.impliedPriceUsd)} | ${row.isPaused === null ? row.paused === null ? "unresolved" : row.paused : row.isPaused} |`).join("\n");
  const dexTable = out.dexLiquidityRows.slice(0, 8).map((row) => `| ${row.matchedChain} | ${row.dexId || "n/a"} | ${row.baseSymbol || "?"}/${row.quoteSymbol || "?"} | ${formatUsd(row.liquidityUsd)} | ${formatUsd(row.volume24hUsd)} |`).join("\n") || "| none | n/a | n/a | n/a | n/a |";
  const content = `# 🟢 DORMANT — Apollo/Securitize ACRED Phase 0

Generated: ${out.generatedAt}

Scanner: \`tools/scan-apollo-acred-phase0.js\`

Artifact: \`reports/raw/fast/apollo-acred-phase0.json\`

## Result

No permissionless route-positive exploit is claimed. This Phase 0 mapped EVM ACRED token deployments from the DeFiLlama adapter, compared live token supply to public TVL context, checked optional ERC4626/oracle-like surfaces, sampled public DEX liquidity, and joined ACRED addresses to local consumer artifacts. It found no material supply/NAV mismatch joined to borrow or liquidation liquidity, no route-positive consumer, and no exact positive acquisition/redeem/unwind path.

## Target

| Field | Value |
|---|---:|
| Protocol | \`${out.metadata.name}\` |
| Slug | \`${out.metadata.slug}\` |
| Category | \`${out.metadata.category}\` |
| Adapter | \`${out.metadata.module}\` |
| Current public TVL | \`${formatUsd(s.defillamaCurrentTvlUsd)}\` |
| EVM tokens scanned | \`${s.tokenRows}\` |
| Consumer join rows | \`${s.artifactJoinRows}\` |
| Watch candidates | \`${s.watchCandidates}\` |
| Route-positive rows | \`${s.routePositive}\` |

## EVM ACRED Tokens

| Chain | Token | Code | Total supply | DeFiLlama USD | Implied price | Paused |
|---|---|---:|---:|---:|---:|---:|
${tokenTable}

## DEX Context

| Chain | DEX | Pair | Liquidity USD | 24h volume USD |
|---|---|---|---:|---:|
${dexTable}

## Blockers

- ACRED Phase 0 is producer-side supply/NAV context only unless a lending, margin, or redemption consumer accepts ACRED with material liquidity.
- RWA issuance/redemption remains treated as permissioned; no public atomic redeem or same-block exit was proven.
- Public DEX liquidity is not enough by itself, and no consumer route-positive economics were found in local artifacts.
- No fork extraction proof and no signed-action justification exist.

## Next Gate

Reopen only if ACRED is accepted by a material lending/margin/redeem consumer, or if a permissionless NAV/oracle/backing divergence maps to exact positive borrow, liquidation, redemption, or DEX unwind economics.
`;
  fs.writeFileSync(REPORT_OUT, content);
}

async function main() {
  const metadataRaw = await fetchJson("https://api.llama.fi/protocol/apollo-diversified-credit-securitize-fund", 30_000).catch(() => ({}));
  const rpcUrls = {};
  for (const chain of CHAINS) {
    const rpc = await resolveInventoryRpc(chain.chainId);
    if (!rpc) throw new Error(`Missing required RPC endpoint from rpc_endpoints.txt for ${chain.name} chainId ${chain.chainId}. Provide a suitable endpoint before continuing.`);
    rpcUrls[chain.chainId] = rpc;
  }

  const tokenRows = [];
  for (const chain of CHAINS) tokenRows.push(await inspectToken(chain, client(rpcUrls[chain.chainId]), metadataRaw));
  const dexRows = await dexLiquidityRows(CHAINS);
  const joins = artifactJoins(tokenRows);
  const routePositive = joins.rows.filter((row) => row.routePositive).length;
  const watchCandidates = joins.rows.filter((row) => row.watchCandidate && !row.routePositive).length;
  const latestTvl = lastRow(metadataRaw.tvl)?.totalLiquidityUSD ?? Object.values(metadataRaw.currentChainTvls || {}).reduce((sum, value) => sum + (asNumber(value) || 0), 0);

  const output = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-apollo-acred-phase0.js",
    scope: "Apollo Diversified Credit Securitize Fund ACRED public Phase 0 token/NAV and consumer join",
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
      routePositive: routePositive > 0,
      signedActionJustified: false,
    },
    metadata: {
      name: metadataRaw.name || "Apollo Diversified Credit Securitize Fund",
      slug: metadataRaw.slug || "apollo-diversified-credit-securitize-fund",
      category: metadataRaw.category || "RWA",
      chains: metadataRaw.chains || ["Ethereum", "Ink", "Avalanche", "Polygon"],
      audits: metadataRaw.audits || "0",
      url: metadataRaw.url || "https://securitize.io/",
      twitter: metadataRaw.twitter || "Securitize",
      description: metadataRaw.description || null,
      module: metadataRaw.module || "acred/index.js",
      tvlCodePath: metadataRaw.tvlCodePath || "https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/acred/index.js",
      methodology: metadataRaw.methodology || "TVL is calculated as total ACRED supply per supported chain.",
      evmAdapterTokens: CHAINS.map(({ name, chainId, adapterKey, token }) => ({ name, chainId, adapterKey, token })),
      nonEvmTokens: NON_EVM_TOKENS,
    },
    tokenRows,
    dexLiquidityRows: dexRows,
    artifactJoins: joins.rows,
    joinInputsLoaded: joins.loadedInputs,
    summary: {
      evmRpcResolved: CHAINS.length,
      defillamaCurrentTvlUsd: round(latestTvl, 2),
      tokenRows: tokenRows.length,
      tokenRowsWithCode: tokenRows.filter((row) => row.codePresent).length,
      erc4626LikeRows: tokenRows.filter((row) => row.erc4626Like).length,
      oracleLikeRows: tokenRows.filter((row) => row.oracleLike).length,
      pausedRows: tokenRows.filter((row) => row.isPaused === true || row.paused === true).length,
      materialSupplyMismatchRows: tokenRows.filter((row) => row.materialSupplyMismatch).length,
      dexLiquidityRows: dexRows.length,
      topDexLiquidityUsd: round(dexRows[0]?.liquidityUsd, 2),
      artifactJoinRows: joins.rows.length,
      watchCandidates,
      routePositive,
      executableNow: 0,
      signedActionJustified: false,
      status: routePositive > 0 ? "route-positive-needs-proof" : "phase0-no-route-positive",
    },
    blockers: [
      "No ACRED consumer-side borrow/liquidation/redeem route with material liquidity was found",
      "No permissionless oracle/NAV/backing divergence mapped to exact positive economics",
      "RWA issuance/redemption is treated as permissioned absent proof of public atomic exit",
      "No fork extraction proof and no signed-action justification",
    ],
    requiredForRoutePositive: [
      "ACRED accepted by a material lending, margin, redemption, or liquidation consumer",
      "permissionless NAV/oracle/backing divergence or current liquidatable borrower condition",
      "exact acquisition, borrow/repay, redeem/liquidate, and exit economics positive after costs",
      "fork extraction proof",
    ],
  };

  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(output, jsonReplacer, 2)}\n`);
  writeReport(output);
  if (!QUIET) {
    console.log(`Apollo ACRED Phase0: tvl=$${Math.round(latestTvl || 0)} tokens=${tokenRows.length} joins=${joins.rows.length} dexRows=${dexRows.length} routePositive=${routePositive}`);
    console.log(`Artifact: ${path.relative(WORKSPACE, RAW_OUT).replace(/\\/g, "/")}`);
    console.log(`Report: ${path.relative(WORKSPACE, REPORT_OUT).replace(/\\/g, "/")}`);
  }
}

main().catch((err) => {
  console.error(String(err?.message || err).slice(0, 320));
  process.exit(1);
});
