#!/usr/bin/env node
// scan-silo-v2-phase0.js - read-only Phase 0 for Silo V2 adapter-scope lending markets.
// Resolves RPC URLs in memory only. Never prints or stores RPC URLs, keys, calldata for execution, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpcPool } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "silo-v2-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "silo-v2-phase0-triage.md");
const QUIET = process.argv.includes("--quiet");

const MIN_MATERIAL_USD = Number(process.env.SILO_V2_MIN_MATERIAL_USD || "10000");
const MIN_ROUTE_LIQUIDITY_USD = Number(process.env.SILO_V2_MIN_ROUTE_LIQUIDITY_USD || "10000");
const HIGH_LTV = Number(process.env.SILO_V2_HIGH_LTV || "0.8");
const MAX_IDS_PER_FACTORY = Number(process.env.SILO_V2_MAX_IDS_PER_FACTORY || "5000");
const ZERO = "0x0000000000000000000000000000000000000000";
const XAI = "0xd7c9f0e536dc865ae858b0c0453fe76d13c3beac";

const CHAINS = {
  1: {
    chain: "Ethereum",
    adapterChain: "ethereum",
    coinSlug: "ethereum",
    factories: [{ startBlock: 22616413, factory: "0x22a3cF6149bFa611bAFc89Fd721918EC3Cf7b581", label: "Silo V2 Ethereum Main" }],
  },
  42161: {
    chain: "Arbitrum",
    adapterChain: "arbitrum",
    coinSlug: "arbitrum",
    factories: [{ startBlock: 334531851, factory: "0x384DC7759d35313F0b567D42bf2f611B285B657C", label: "Silo V2 Arbitrum Main" }],
  },
  43114: {
    chain: "Avalanche",
    adapterChain: "avax",
    coinSlug: "avax",
    factories: [{ startBlock: 64050356, factory: "0x92cECB67Ed267FF98026F814D813fDF3054C6Ff9", label: "Silo V2 Avalanche Main" }],
  },
  146: {
    chain: "Sonic",
    adapterChain: "sonic",
    coinSlug: "sonic",
    factories: [
      { startBlock: 2672166, factory: "0xa42001d6d2237d2c74108fe360403c4b796b7170", label: "Silo V2 Sonic Main" },
      { startBlock: 25244110, factory: "0x4e9dE3a64c911A37f7EB2fCb06D1e68c3cBe9203", label: "Silo V2 Sonic Revised" },
    ],
  },
};

const BLACKLISTED_SILOS = new Set([
  "0x6543ee07cf5dd7ad17aeecf22ba75860ef3bbaaa",
]);
const BAD_DEBT_SILOS = {
  sonic: [
    "0xCCdDbBbd1E36a6EDA3a84CdCee2040A86225Ba71", "0xEd9777944A2Fb32504a410D23f246463B3f40908", "0x6e8C150224D6e9B646889b96EFF6f7FD742e2C22",
    "0x0aB02DD08c1555d1a20C76a6EA30e3E36f3e06d4", "0x75c550776c191A8F6aE22EdC742aD2788723B66E", "0xc6ee9A58D5270e53fD1361946899b6D0553142B4",
    "0x501Ee3D6cB84004c7970cA24f3daC07D61A25e4D", "0x1A089424F52502139888fa4c0ED2FA088e9E1d51", "0x1c1791911483E98875D162355feC47f37613f0FB",
    "0x8c98b43BF61F2B07c4D26f85732217948Fca2a90", "0xA1627a0E1d0ebcA9326D2219B84Df0c600bed4b1", "0xb1412442aa998950f2f652667d5Eba35fE66E43f",
    "0x27968d36b937DcB26F33902fA489E5b228b104BE", "0x76DF755A9f40463F14d0a2b7Cba3Ccf05404eEdf", "0xAF1BDaE843d90c546DE5001f7b107B46e1a26Aa9",
    "0x5954ce6671d97D24B782920ddCdBB4b1E63aB2De", "0x4935FaDB17df859667Cc4F7bfE6a8cB24f86F8d0", "0x219656F33c58488D09d518BaDF50AA8CdCAcA2Aa",
  ],
  ethereum: ["0x1dE3bA67Da79A81Bc0c3922689c98550e4bd9bc2"],
  arbitrum: ["0xACb7432a4BB15402CE2afe0A7C9D5b738604F6F9", "0x2433D6AC11193b4695D9ca73530de93c538aD18a"],
  avax: ["0x672b77f0538b53Dc117C9dDfEb7377A678d321a6", "0xE0fc62e685E2b3183b4B88b1fE674cFEc55a63F7", "0x9C4D4800b489d217724155399CD64D07Eae603f3", "0x7437ac81457Fa98fFB2d0C8f9943ecfE4813e2f1"],
};
for (const key of Object.keys(BAD_DEBT_SILOS)) BAD_DEBT_SILOS[key] = new Set(BAD_DEBT_SILOS[key].map((a) => a.toLowerCase()));

const FACTORY = new ethers.Interface([
  "event NewSilo(address indexed implementation, address indexed token0, address indexed token1, address silo0, address silo1, address siloConfig)",
  "function getNextSiloId() view returns (uint256)",
  "function idToSiloConfig(uint256 id) view returns (address)",
]);
const SILO_CONFIG = new ethers.Interface([
  "function getSilos() view returns (address,address)",
  "function getConfig(address silo) view returns ((uint256,uint256,address,address,address,address,address,address,address,address,uint256,uint256,uint256,uint256,uint256,address,bool))",
]);
const SILO = new ethers.Interface([
  "function asset() view returns (address)",
  "function getLiquidity() view returns (uint256)",
  "function getSiloStorage() view returns (uint192,uint64,uint256,uint256,uint256)",
  "function getTotalAssetsStorage(uint8 _assetType) view returns (uint256 totalAssetsByType)",
]);
const ERC20 = new ethers.Interface([
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
]);
const BYTES32_TOKEN = new ethers.Interface(["function symbol() view returns (bytes32)", "function name() view returns (bytes32)"]);
const ORACLE = new ethers.Interface(["function VERSION() view returns (string)", "function quote(uint256,address) view returns (uint256)"]);

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function strip0x(value) { return String(value || "").replace(/^0x/i, ""); }
function normalizeAddress(value) { try { return ethers.getAddress(String(value || "")); } catch (_) { return null; } }
function lowerAddress(value) { const addr = normalizeAddress(value); return addr ? addr.toLowerCase() : null; }
function unique(items) { return [...new Set((items || []).filter(Boolean))]; }
function round(value, decimals = 2) { const n = Number(value); if (!Number.isFinite(n)) return null; const f = 10 ** decimals; return Math.round(n * f) / f; }
function formatUsd(value) { const n = Number(value); return Number.isFinite(n) ? `$${Math.round(n).toLocaleString()}` : "n/a"; }
function formatNumber(value, decimals = 6) { const n = Number(value); return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: decimals }) : "n/a"; }
function compactAddress(value) { const addr = normalizeAddress(value); return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : "n/a"; }
function siloLtvToRatio(value) { try { return Number(value) / 1e18; } catch (_) { return 0; } }

async function fetchJson(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-silo-v2-phase0/1.0" } });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) { return null; } finally { clearTimeout(timer); }
}

async function safeCall(rpc, to, iface, fn, args = [], timeoutMs = 12_000) {
  const addr = normalizeAddress(to);
  if (!rpc || !addr) return null;
  try {
    const raw = await rpcCall(rpc, "eth_call", [{ to: addr, data: iface.encodeFunctionData(fn, args) }, "latest"], timeoutMs);
    if (!raw || raw === "0x") return null;
    return iface.decodeFunctionResult(fn, raw);
  } catch (_) { return null; }
}

async function getCode(rpc, address) {
  const addr = normalizeAddress(address);
  if (!rpc || !addr) return "0x";
  return await rpcCall(rpc, "eth_getCode", [addr, "latest"], 10_000).catch(() => "0x") || "0x";
}

async function latestBlock(rpc) {
  const hex = await rpcCall(rpc, "eth_blockNumber", [], 10_000).catch(() => null);
  return hex ? parseInt(hex, 16) : null;
}

function toBlockHex(value) { return `0x${Number(value).toString(16)}`; }

async function getLogsChunked(rpc, address, fromBlock, toBlock) {
  const target = normalizeAddress(address);
  if (!rpc || !target || !Number.isFinite(fromBlock) || !Number.isFinite(toBlock) || toBlock < fromBlock) return { logs: [], errors: ["invalid-log-range"] };
  const topic0 = FACTORY.getEvent("NewSilo").topicHash;
  const logs = [];
  const errors = [];
  let from = fromBlock;
  let step = 1_000_000;
  while (from <= toBlock) {
    const to = Math.min(toBlock, from + step - 1);
    try {
      const chunk = await rpcCall(rpc, "eth_getLogs", [{ address: target, fromBlock: toBlockHex(from), toBlock: toBlockHex(to), topics: [topic0] }], 30_000);
      if (Array.isArray(chunk)) logs.push(...chunk);
      from = to + 1;
      if (step < 4_000_000) step = Math.min(4_000_000, step * 2);
    } catch (_) {
      if (step <= 25_000) {
        errors.push(`logs-unavailable-${from}-${to}`);
        from = to + 1;
      } else {
        step = Math.max(25_000, Math.floor(step / 4));
      }
    }
  }
  return { logs, errors };
}

function decodeBytes32String(value) { try { return ethers.decodeBytes32String(value); } catch (_) { return null; } }

async function tokenMeta(rpc, token, priceMap) {
  const address = normalizeAddress(token);
  if (!address) return null;
  const [code, decimals, symbolRaw, nameRaw, totalSupplyRaw] = await Promise.all([
    getCode(rpc, address),
    safeCall(rpc, address, ERC20, "decimals"),
    safeCall(rpc, address, ERC20, "symbol"),
    safeCall(rpc, address, ERC20, "name"),
    safeCall(rpc, address, ERC20, "totalSupply"),
  ]);
  let symbol = symbolRaw?.[0] === undefined ? null : String(symbolRaw[0]);
  let name = nameRaw?.[0] === undefined ? null : String(nameRaw[0]);
  if (!symbol) symbol = decodeBytes32String((await safeCall(rpc, address, BYTES32_TOKEN, "symbol"))?.[0]);
  if (!name) name = decodeBytes32String((await safeCall(rpc, address, BYTES32_TOKEN, "name"))?.[0]);
  const dec = decimals?.[0] === undefined ? 18 : Number(decimals[0]);
  const supply = totalSupplyRaw?.[0] === undefined ? null : Number(ethers.formatUnits(totalSupplyRaw[0], dec));
  const price = priceMap.get(address.toLowerCase()) || 0;
  return { address, codePresent: Boolean(code && code !== "0x"), codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0, decimals: dec, symbol, name, totalSupply: round(supply, 8), priceUsd: price };
}

async function fetchPrices(chainSlug, addresses) {
  const keys = unique(addresses.map(normalizeAddress).filter(Boolean).map((a) => `${chainSlug}:${a.toLowerCase()}`));
  const prices = new Map();
  for (let i = 0; i < keys.length; i += 60) {
    const chunk = keys.slice(i, i + 60);
    const json = await fetchJson(`https://coins.llama.fi/prices/current/${chunk.join(",")}?searchWidth=6h`, 30_000).catch(() => null);
    for (const [key, row] of Object.entries(json?.coins || {})) {
      const address = key.split(":").pop();
      const price = Number(row?.price || 0);
      if (Number.isFinite(price) && price > 0) prices.set(address.toLowerCase(), price);
    }
  }
  return prices;
}

function parseSiloConfig(decoded) {
  const row = decoded?.[0];
  if (!row) return null;
  return {
    silo: normalizeAddress(row[2]),
    token: normalizeAddress(row[3]),
    protectedShareToken: normalizeAddress(row[4]),
    collateralShareToken: normalizeAddress(row[5]),
    debtShareToken: normalizeAddress(row[6]),
    solvencyOracle: normalizeAddress(row[7]),
    maxLtvOracle: normalizeAddress(row[8]),
    maxLtv: round(siloLtvToRatio(row[10] || 0n), 6),
    lt: round(siloLtvToRatio(row[11] || 0n), 6),
  };
}

async function enumerateFactory(rpc, chainId, chainCfg, factoryRow, toBlock) {
  const factory = normalizeAddress(factoryRow.factory);
  const code = await getCode(rpc, factory);
  const nextRaw = await safeCall(rpc, factory, FACTORY, "getNextSiloId");
  const nextId = nextRaw?.[0] === undefined ? null : Number(nextRaw[0]);
  const errors = [];
  const configs = [];
  let logsEnumerated = 0;
  let inventorySource = "new-silo-logs";
  let fallbackReason = null;
  if (nextId === null || !Number.isFinite(nextId)) {
    errors.push("getNextSiloId-unavailable");
  }
  if (!Number.isFinite(toBlock)) {
    errors.push("latest-block-unavailable");
  } else {
    const { logs, errors: logErrors } = await getLogsChunked(rpc, factory, factoryRow.startBlock, toBlock);
    logsEnumerated = logs.length;
    errors.push(...logErrors);
    const seen = new Set();
    for (let i = 0; i < logs.length; i += 1) {
      let parsed = null;
      try { parsed = FACTORY.parseLog({ topics: logs[i].topics, data: logs[i].data }); } catch (_) { parsed = null; }
      const config = normalizeAddress(parsed?.args?.siloConfig || parsed?.args?.[5]);
      const silos = [normalizeAddress(parsed?.args?.silo0 || parsed?.args?.[3]), normalizeAddress(parsed?.args?.silo1 || parsed?.args?.[4])].filter(Boolean);
      if (!config || silos.length < 2) {
        errors.push(`log-${i}-decode-unavailable`);
        continue;
      }
      const key = `${lowerAddress(config)}:${silos.map(lowerAddress).join(":")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      configs.push({ chainId, chain: chainCfg.chain, adapterChain: chainCfg.adapterChain, factory, factoryLabel: factoryRow.label, adapterStartBlock: factoryRow.startBlock, id: configs.length, config, silos, inventorySource, txHash: logs[i].transactionHash || null, blockNumber: logs[i].blockNumber ? parseInt(logs[i].blockNumber, 16) : null });
    }
  }
  if (!configs.length && Number.isFinite(nextId) && nextId > 0) {
    inventorySource = "idToSiloConfig-fallback";
    fallbackReason = "new-silo-logs-empty";
    const limit = Math.min(nextId, MAX_IDS_PER_FACTORY);
    const start = Math.max(0, nextId - limit);
    for (let id = start; id < nextId; id += 1) {
      const configRaw = await safeCall(rpc, factory, FACTORY, "idToSiloConfig", [id], 10_000);
      const config = normalizeAddress(configRaw?.[0]);
      if (!config || config === ZERO) continue;
      const silosRaw = await safeCall(rpc, config, SILO_CONFIG, "getSilos", [], 10_000);
      const silos = [normalizeAddress(silosRaw?.[0]), normalizeAddress(silosRaw?.[1])].filter(Boolean);
      if (silos.length < 2) {
        errors.push(`id-${id}-getSilos-unavailable`);
        continue;
      }
      configs.push({ chainId, chain: chainCfg.chain, adapterChain: chainCfg.adapterChain, factory, factoryLabel: factoryRow.label, adapterStartBlock: factoryRow.startBlock, id, config, silos, inventorySource, fallbackReason });
    }
    if (!configs.length) errors.push("inventory-empty");
  }
  return {
    chainId,
    chain: chainCfg.chain,
    adapterChain: chainCfg.adapterChain,
    factory,
    label: factoryRow.label,
    adapterStartBlock: factoryRow.startBlock,
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
    getNextSiloId: nextId,
    inventorySource,
    fallbackReason,
    logsEnumerated,
    configsEnumerated: configs.length,
    errors: errors.slice(0, 20),
    configs,
  };
}

function excludedReason(adapterChain, silo, asset) {
  const s = lowerAddress(silo);
  const a = lowerAddress(asset);
  if (!s) return "invalid-silo";
  if (BLACKLISTED_SILOS.has(s)) return "adapter-blacklisted-silo";
  if (BAD_DEBT_SILOS[adapterChain]?.has(s)) return "adapter-bad-debt-silo";
  if (a && a === XAI.toLowerCase()) return "adapter-xai-token-excluded";
  return null;
}

async function oracleInfo(rpc, oracle) {
  const address = normalizeAddress(oracle);
  if (!address || address === ZERO) return { address, codePresent: false, version: null };
  const [code, versionRaw] = await Promise.all([getCode(rpc, address), safeCall(rpc, address, ORACLE, "VERSION")]);
  return { address, codePresent: Boolean(code && code !== "0x"), codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0, version: versionRaw?.[0] === undefined ? null : String(versionRaw[0]) };
}

async function inspectSilo(rpc, configRow, silo, metaByAsset) {
  const [assetRaw, configRaw, liquidityRaw, storageRaw, protectedRaw, collateralRaw, debtRaw] = await Promise.all([
    safeCall(rpc, silo, SILO, "asset"),
    safeCall(rpc, configRow.config, SILO_CONFIG, "getConfig", [silo]),
    safeCall(rpc, silo, SILO, "getLiquidity"),
    safeCall(rpc, silo, SILO, "getSiloStorage"),
    safeCall(rpc, silo, SILO, "getTotalAssetsStorage", [0]),
    safeCall(rpc, silo, SILO, "getTotalAssetsStorage", [1]),
    safeCall(rpc, silo, SILO, "getTotalAssetsStorage", [2]),
  ]);
  const cfg = parseSiloConfig(configRaw);
  const asset = normalizeAddress(assetRaw?.[0]) || cfg?.token;
  const exclusion = excludedReason(configRow.adapterChain, silo, asset);
  const meta = metaByAsset.get(lowerAddress(asset)) || { decimals: 18, priceUsd: 0, symbol: null };
  const balanceRaw = asset ? await safeCall(rpc, asset, ERC20, "balanceOf", [silo]) : null;
  const balance = balanceRaw?.[0] === undefined ? null : Number(ethers.formatUnits(balanceRaw[0], meta.decimals));
  const liquidity = liquidityRaw?.[0] === undefined ? null : Number(ethers.formatUnits(liquidityRaw[0], meta.decimals));
  const protectedAssets = protectedRaw?.[0] === undefined ? null : Number(ethers.formatUnits(protectedRaw[0], meta.decimals));
  const collateralAssets = collateralRaw?.[0] === undefined ? null : Number(ethers.formatUnits(collateralRaw[0], meta.decimals));
  const debtAssets = debtRaw?.[0] === undefined ? null : Number(ethers.formatUnits(debtRaw[0], meta.decimals));
  const storageCollateral = storageRaw?.[3] === undefined ? null : Number(ethers.formatUnits(storageRaw[3], meta.decimals));
  const storageDebt = storageRaw?.[4] === undefined ? null : Number(ethers.formatUnits(storageRaw[4], meta.decimals));
  const price = Number(meta.priceUsd || 0);
  return {
    ...configRow,
    silo: normalizeAddress(silo),
    asset,
    assetSymbol: meta.symbol,
    assetName: meta.name,
    assetDecimals: meta.decimals,
    assetPriceUsd: price,
    adapterExcluded: Boolean(exclusion),
    exclusionReason: exclusion,
    solvencyOracle: cfg?.solvencyOracle || null,
    maxLtvOracle: cfg?.maxLtvOracle || null,
    maxLtv: cfg?.maxLtv || 0,
    lt: cfg?.lt || 0,
    liquidityRaw: liquidityRaw?.[0] === undefined ? null : liquidityRaw[0].toString(),
    liquidity: round(liquidity, 8),
    liquidityUsd: round((liquidity || 0) * price, 2),
    tokenBalanceRaw: balanceRaw?.[0] === undefined ? null : balanceRaw[0].toString(),
    tokenBalance: round(balance, 8),
    tokenBalanceUsd: round((balance || 0) * price, 2),
    protectedAssets: round(protectedAssets, 8),
    collateralAssets: round(collateralAssets, 8),
    debtAssets: round(debtAssets, 8),
    debtAssetsUsd: round((debtAssets || storageDebt || 0) * price, 2),
    storageCollateral: round(storageCollateral, 8),
    storageDebt: round(storageDebt, 8),
    routePositive: false,
  };
}

function pairRows(rows) {
  const byConfig = new Map();
  for (const row of rows) {
    const key = `${row.chainId}:${lowerAddress(row.config)}`;
    if (!byConfig.has(key)) byConfig.set(key, []);
    byConfig.get(key).push(row);
  }
  const out = [];
  for (const sides of byConfig.values()) {
    if (sides.length < 2) continue;
    for (const side of sides) {
      const opposite = sides.find((row) => lowerAddress(row.silo) !== lowerAddress(side.silo));
      if (!opposite) continue;
      const active = !side.adapterExcluded && !opposite.adapterExcluded;
      const highLtv = Number(side.maxLtv || 0) >= HIGH_LTV;
      const materialBorrowSide = Number(opposite.liquidityUsd || 0) >= MIN_ROUTE_LIQUIDITY_USD;
      const materialCollateralSide = Number(side.tokenBalanceUsd || side.liquidityUsd || 0) >= MIN_MATERIAL_USD;
      const watchCandidate = Boolean(active && highLtv && materialBorrowSide && materialCollateralSide);
      out.push({
        chainId: side.chainId,
        chain: side.chain,
        factory: side.factory,
        id: side.id,
        config: side.config,
        collateralSilo: side.silo,
        collateralAsset: side.asset,
        collateralSymbol: side.assetSymbol,
        borrowSilo: opposite.silo,
        borrowAsset: opposite.asset,
        borrowSymbol: opposite.assetSymbol,
        maxLtv: side.maxLtv,
        lt: side.lt,
        solvencyOracle: side.solvencyOracle,
        maxLtvOracle: side.maxLtvOracle,
        collateralBalanceUsd: side.tokenBalanceUsd,
        collateralLiquidityUsd: side.liquidityUsd,
        borrowLiquidityUsd: opposite.liquidityUsd,
        borrowDebtUsd: opposite.debtAssetsUsd,
        activeAdapterScope: active,
        highLtv,
        materialBorrowSide,
        materialCollateralSide,
        watchCandidate,
        routePositive: false,
        blocker: watchCandidate ? "High-LTV Silo V2 route needs oracle-specific exact collateral acquisition, borrow, and exit economics" : "No current high-LTV material route shape or adapter row is excluded/inactive",
      });
    }
  }
  out.sort((a, b) => Number(b.watchCandidate) - Number(a.watchCandidate) || (b.borrowLiquidityUsd || 0) - (a.borrowLiquidityUsd || 0));
  return out;
}

function coverageClassification(summary) {
  if (summary.chainsWithRpc < summary.chainsDeclared || summary.factoriesWithCode < summary.factoriesDeclared || summary.factoryErrors > 0) return "partial-or-blocked";
  return "full-enough-for-declared-scope";
}

function buildReport(artifact) {
  const s = artifact.summary;
  const factoryTable = artifact.factoryRows.map((row) => `| ${row.chain} | ${compactAddress(row.factory)} | ${row.codePresent ? "yes" : "no"} | ${row.getNextSiloId ?? "n/a"} | ${row.inventorySource || "n/a"} | ${row.logsEnumerated ?? "n/a"} | ${row.configsEnumerated} | ${row.errors.length} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a | n/a |";
  const watchTable = artifact.watchCandidates.length ? artifact.watchCandidates.slice(0, 10).map((row) => `| ${row.chain} | ${row.id} | ${row.collateralSymbol || compactAddress(row.collateralAsset)} | ${row.borrowSymbol || compactAddress(row.borrowAsset)} | ${round(row.maxLtv * 100, 2)}% | ${formatUsd(row.borrowLiquidityUsd)} | ${formatUsd(row.collateralBalanceUsd)} | ${compactAddress(row.maxLtvOracle)} |`).join("\n") : "| none | n/a | n/a | n/a | n/a | n/a | n/a | n/a |";
  const topTable = artifact.rows.filter((row) => !row.adapterExcluded).sort((a, b) => (b.tokenBalanceUsd || 0) - (a.tokenBalanceUsd || 0)).slice(0, 10).map((row) => `| ${row.chain} | ${row.id} | ${row.assetSymbol || compactAddress(row.asset)} | ${formatUsd(row.tokenBalanceUsd)} | ${formatUsd(row.liquidityUsd)} | ${formatUsd(row.debtAssetsUsd)} | ${round((row.maxLtv || 0) * 100, 2)}% |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a |";
  return `# 🟢 DORMANT - Silo V2 Phase 0 Triage

Date: ${artifact.generatedAt}

## Result

No confirmed permissionless exploit. The public DeFiLlama \`silo-v2/index.js\` adapter maps Silo V2 TVL from factory-created silos on Ethereum, Arbitrum, Avalanche, and Sonic, applies explicit bad-debt/blacklist exclusions, and sums asset balances plus borrowed amounts. This pass enumerated the adapter-declared factories with read-only RPC calls and found high-LTV material watch rows, but no exact positive oracle, borrow, liquidation, redemption, or unwind route and no fork proof.

## Scope

| Item | Value |
|---|---:|
| DeFiLlama TVL context | ${formatUsd(s.defillamaCurrentTvlUsd)} |
| Chains declared | ${s.chainsDeclared} |
| Chains with RPC | ${s.chainsWithRpc} |
| Factories declared | ${s.factoriesDeclared} |
| Factories with code | ${s.factoriesWithCode} |
| NewSilo logs enumerated | ${s.logsEnumerated} |
| Inventory fallback factories | ${s.inventoryFallbackFactories} |
| Factory configs enumerated | ${s.configsEnumerated} |
| Silo side rows | ${s.siloRows} |
| Adapter-excluded rows | ${s.adapterExcludedRows} |
| Material asset rows | ${s.materialAssetRows} |
| High-LTV pair rows | ${s.highLtvPairRows} |
| Watch candidates | ${s.watchCandidates} |
| Route-positive | ${s.routePositive} |
| Coverage classification | ${s.coverageClassification} |

## Factories

| Chain | Factory | Code | getNextSiloId | Inventory | Logs | Configs | Errors |
|---|---|---:|---:|---|---:|---:|---:|
${factoryTable}

## Watch Candidates

| Chain | ID | Collateral | Borrow | Max LTV | Borrow liquidity | Collateral balance | Max LTV oracle |
|---|---:|---|---|---:|---:|---:|---|
${watchTable}

## Top Adapter Rows

| Chain | ID | Asset | Token balance | Liquidity | Debt | Max LTV |
|---|---:|---|---:|---:|---:|---:|
${topTable}

## Blockers

- Existing broad Silo review already identified oracle/staleness/PT/vault surfaces, but current adapter rows still need route-specific oracle decoding and exact economics.
- Watch rows are high-LTV/material-lending shapes only; they do not prove stale, manipulable, or overvalued accepted collateral.
- Adapter bad-debt rows are excluded from TVL and are not treated as exploitable collateral routes.
- No exact positive collateral acquisition, borrow, liquidation, redemption, or DEX unwind economics and no fork extraction proof exist.

## Required For Route-Positive

- A specific Silo V2 market uses stale, manipulable, under-bound, or otherwise attacker-favorable oracle/accounting state.
- Borrow-side liquidity is material and unpaused for the exact collateral side.
- Collateral acquisition, borrow, and unwind/liquidation route are exact-quoted after gas, slippage, and fees.
- Fork/local proof shows positive net value.

Artifacts: \`reports/raw/fast/silo-v2-phase0.json\`.
`;
}

async function main() {
  const protocolRaw = await fetchJson("https://api.llama.fi/protocol/silo-v2", 30_000);
  const chainIds = Object.keys(CHAINS).map(Number);
  const rpcs = await resolveRpcPool(chainIds);
  const factoryRows = [];
  const configRows = [];
  const latestBlocks = {};
  for (const chainId of chainIds) {
    const chainCfg = CHAINS[chainId];
    const rpc = rpcs[chainId] || null;
    latestBlocks[chainId] = rpc ? await latestBlock(rpc) : null;
    for (const factory of chainCfg.factories) {
      if (!rpc) {
        factoryRows.push({ chainId, chain: chainCfg.chain, adapterChain: chainCfg.adapterChain, factory: normalizeAddress(factory.factory), label: factory.label, adapterStartBlock: factory.startBlock, codePresent: false, codeBytes: 0, getNextSiloId: null, configsEnumerated: 0, errors: ["missing-rpc"] });
        continue;
      }
      const row = await enumerateFactory(rpc, chainId, chainCfg, factory, latestBlocks[chainId]);
      factoryRows.push({ ...row, configs: undefined });
      configRows.push(...row.configs);
    }
  }

  const assetsByChain = new Map();
  for (const cfg of configRows) {
    for (const silo of cfg.silos) {
      const rpc = rpcs[cfg.chainId];
      const asset = normalizeAddress((await safeCall(rpc, silo, SILO, "asset"))?.[0]);
      if (!asset) continue;
      const key = cfg.chainId;
      if (!assetsByChain.has(key)) assetsByChain.set(key, new Set());
      assetsByChain.get(key).add(asset);
    }
  }
  const metaByChain = new Map();
  for (const [chainId, assets] of assetsByChain.entries()) {
    const chainCfg = CHAINS[chainId];
    const prices = await fetchPrices(chainCfg.coinSlug, [...assets]);
    const meta = new Map();
    for (const asset of assets) {
      const m = await tokenMeta(rpcs[chainId], asset, prices);
      if (m) meta.set(asset.toLowerCase(), m);
    }
    metaByChain.set(chainId, meta);
  }

  const rows = [];
  for (const cfg of configRows) {
    const meta = metaByChain.get(cfg.chainId) || new Map();
    for (const silo of cfg.silos) rows.push(await inspectSilo(rpcs[cfg.chainId], cfg, silo, meta));
  }
  const oracleAddresses = unique(rows.flatMap((row) => [row.solvencyOracle, row.maxLtvOracle]).map(normalizeAddress).filter((addr) => addr && addr !== ZERO));
  const oracleRows = [];
  for (const row of rows) {
    for (const oracle of [row.solvencyOracle, row.maxLtvOracle]) {
      if (!oracle || oracle === ZERO) continue;
      const info = await oracleInfo(rpcs[row.chainId], oracle);
      oracleRows.push({ chainId: row.chainId, chain: row.chain, id: row.id, silo: row.silo, oracle, role: lowerAddress(oracle) === lowerAddress(row.maxLtvOracle) ? "maxLtvOracle" : "solvencyOracle", ...info });
    }
  }
  const pairs = pairRows(rows);
  const watchCandidates = pairs.filter((row) => row.watchCandidate).slice(0, 80);
  const factoryErrors = factoryRows.reduce((sum, row) => sum + (row.errors?.length || 0), 0);
  const summary = {
    chainsDeclared: chainIds.length,
    chainsWithRpc: chainIds.filter((id) => Boolean(rpcs[id])).length,
    rpcAvailability: Object.fromEntries(chainIds.map((id) => [id, Boolean(rpcs[id])])),
    latestBlocks,
    factoriesDeclared: Object.values(CHAINS).reduce((sum, row) => sum + row.factories.length, 0),
    factoriesWithCode: factoryRows.filter((row) => row.codePresent).length,
    factoryErrors,
    logsEnumerated: factoryRows.reduce((sum, row) => sum + (Number(row.logsEnumerated) || 0), 0),
    inventoryFallbackFactories: factoryRows.filter((row) => row.inventorySource !== "new-silo-logs").length,
    configsEnumerated: configRows.length,
    siloRows: rows.length,
    adapterExcludedRows: rows.filter((row) => row.adapterExcluded).length,
    materialAssetRows: rows.filter((row) => !row.adapterExcluded && (Number(row.tokenBalanceUsd || 0) >= MIN_MATERIAL_USD || Number(row.debtAssetsUsd || 0) >= MIN_MATERIAL_USD || Number(row.liquidityUsd || 0) >= MIN_MATERIAL_USD)).length,
    highLtvPairRows: pairs.filter((row) => row.highLtv).length,
    watchCandidates: watchCandidates.length,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    defillamaCurrentTvlUsd: round(Number(protocolRaw?.currentChainTvls?.Ethereum || 0) + Number(protocolRaw?.currentChainTvls?.Arbitrum || 0) + Number(protocolRaw?.currentChainTvls?.Avalanche || 0) + Number(protocolRaw?.currentChainTvls?.Sonic || 0), 2) || round(protocolRaw?.tvl?.slice?.(-1)?.[0]?.totalLiquidityUSD, 2),
  };
  summary.coverageClassification = coverageClassification(summary);
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-silo-v2-phase0.js",
    scope: "Read-only Silo V2 DeFiLlama adapter-scope factory/config/lending Phase 0 scan",
    target: { name: "Silo V2", slug: "silo-v2", category: "Lending", surface: "lending-oracle-liquidation", adapter: "https://raw.githubusercontent.com/DefiLlama/DefiLlama-Adapters/main/projects/silo-v2/index.js" },
    safety: { publicApisOnlyForMetadata: true, rpcInventoryRead: true, rpcUrlsStored: false, privateKeysRead: false, signedActions: false, exploitExecuteCalls: false, forkTransactions: false, routePositive: false, executableNow: false, signedActionJustified: false },
    thresholds: { minMaterialUsd: MIN_MATERIAL_USD, minRouteLiquidityUsd: MIN_ROUTE_LIQUIDITY_USD, highLtv: HIGH_LTV, maxIdsPerFactory: MAX_IDS_PER_FACTORY },
    adapterModel: { sourceModel: "Silo V2 adapter uses factory NewSilo logs, silo asset(), asset balances, and getTotalAssetsStorage(2) borrowed amounts with bad-debt/blacklist exclusions", scannerModel: "Factory NewSilo log enumeration plus idToSiloConfig fallback when logs are empty, then per-silo asset/liquidity/debt reads" },
    factoryRows,
    rows,
    pairRows: pairs,
    oracleRows,
    watchCandidates,
    routePositiveRows: [],
    summary,
    blockers: [
      "Watch rows are high-LTV/material-lending shapes only and do not prove stale/manipulable/overvalued oracle state",
      "Existing broad Silo source/live review found no current stale-feed, PT, ERC4626, zero-oracle, hook, or vault route with exact positive economics",
      "No exact positive collateral acquisition, borrow, liquidation, redemption, or DEX unwind economics or fork proof",
    ],
    requiredForRoutePositive: [
      "specific Silo V2 market uses stale, manipulable, under-bound, or otherwise attacker-favorable oracle/accounting state",
      "borrow-side liquidity is material and unpaused",
      "collateral acquisition, borrow, and unwind/liquidation route are exact-quoted after gas/slippage/fees",
      "fork/local proof",
    ],
    nextReadOnlyStep: watchCandidates.length ? "Decode oracle adapters for top high-LTV watch rows and exact-quote only if accepted collateral value is attacker-favorable." : "Reopen Silo V2 only if new adapter rows have material high-LTV borrow liquidity or oracle-specific anomaly evidence.",
  };
  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(artifact, jsonReplacer, 2)}\n`);
  fs.writeFileSync(REPORT_OUT, buildReport(artifact));
  if (!QUIET) console.log(`Silo V2 Phase 0: chains=${summary.chainsWithRpc}/${summary.chainsDeclared} factories=${summary.factoriesWithCode}/${summary.factoriesDeclared} configs=${summary.configsEnumerated} rows=${summary.siloRows} material=${summary.materialAssetRows} watch=${summary.watchCandidates} routePositive=${summary.routePositive} coverage=${summary.coverageClassification}`);
}

main().catch((err) => { console.error(err?.message || String(err)); process.exit(1); });
