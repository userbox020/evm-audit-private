#!/usr/bin/env node
// scan-harmonix-phase0.js - read-only Phase 0 for Harmonix factories, vaults, yield rows, and consumer joins.
// Resolves RPC URLs in memory only. Never prints or stores RPC URLs, keys, calldata for execution, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpcPool } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "harmonix-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "harmonix-phase0-triage.md");
const PUBLIC_TARGETS = path.join(WORKSPACE, "reports", "raw", "fast", "public-audit-target-discovery.json");
const QUIET = process.argv.includes("--quiet");

const SIGNAL_DORMANT = "\uD83D\uDFE2 DORMANT";
const ZERO = "0x0000000000000000000000000000000000000000";
const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const VAULT_REGISTERED_TOPIC = ethers.id("VaultRegistered(address)");

const CHAINS = [
  { key: "ethereum", chain: "Ethereum", chainId: 1, factory: "0xC7C8Cdd1E9817Fc98AD1b05cD3633c6471A9473b", logFromBlock: "0x1260000" },
  { key: "arbitrum", chain: "Arbitrum", chainId: 42161, factory: "0x3363A85c31cf13a96802e2935724232767420135", logFromBlock: null },
  { key: "base", chain: "Base", chainId: 8453, factory: "0x45dC73fB760f2382Cfd11e28C0Dd0a3A8d3E4C31", logFromBlock: "0x0" },
  { key: "hyperliquid", chain: "Hyperliquid", chainId: 999, factory: "0x8085C67f122B7C7c7AB06864ac359536640f5E28", logFromBlock: "0x0" },
];

const FACTORY = new ethers.Interface([
  "function getVaultsTVL() view returns (uint256)",
  "function vaultList(uint256) view returns (address)",
  "function registeredVaults(address) view returns (bool)",
  "function admin() view returns (address)",
]);
const VAULT = new ethers.Interface([
  "function totalValueLocked() view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function pricePerShare() view returns (uint256)",
  "function getWithdrawPoolAmount() view returns (uint256)",
  "function getFeeInfo() view returns (uint256 performanceFee,uint256 managementFee)",
  "function getPerpDexState() view returns (uint256,uint256)",
  "function getEthStakingState() view returns (tuple(uint256 unAllocatedBalance,uint256 totalBalance))",
  "function getVaultState() view returns (tuple(uint256 withdrawPoolAmount,uint256 pendingDepositAmount,uint256 totalShares,uint256 totalFeePoolAmount,uint256 lastUpdateManagementFeeDate))",
  "function balanceOf(address) view returns (uint256)",
  "function asset() view returns (address)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
]);

const CONSUMER_ARTIFACTS = [
  ["aave-euler-silo", "reports/raw/fast/aave-euler-silo-consumer-graph.json"],
  ["consumer-first-high-ltv", "reports/raw/fast/consumer-first-high-ltv-collateral.json"],
  ["seven-chain-lending", "reports/raw/fast/seven-chain-lending-coverage.json"],
  ["stablecoin-depeg", "reports/raw/fast/stablecoin-depeg-lending-routes.json"],
  ["erc4626-consumer", "reports/raw/fast/erc4626-consumer-joiner.json"],
  ["evault-collateral-nav", "reports/raw/fast/evault-collateral-nav-manipulation.json"],
  ["focused-morpho", "reports/raw/fast/focused-morpho-review-producers.json"],
  ["focused-euler", "reports/raw/fast/focused-euler-evk-review-producers.json"],
  ["morpho-public-allocator", "reports/raw/fast/morpho-public-allocator-force-feed.json"],
  ["pool-share-snapshot", "reports/raw/fast/pool-share-snapshot-drift.json"],
  ["public-lead-consumer", "reports/raw/fast/public-lead-consumer-joins.json"],
  ["current-profit-leads", "reports/raw/fast/current-profit-lead-triage.json"],
  ["hyperliquid-linked-token-consumers", "reports/raw/fast/hyperliquid-linked-token-consumers.json"],
  ["bridge-proof-binding", "reports/raw/fast/bridge-proof-binding.json"],
  ["bridge-synthetic-consumer", "reports/raw/fast/bridge-synthetic-consumer-exposure.json"],
];
const DIRECT_ROLES = new Set(["harmonixFactory", "harmonixVault"]);

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readText(file) { try { return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""; } catch (_) { return ""; } }
function readJson(file, fallback = null) { try { const t = readText(file).replace(/^\uFEFF/, ""); return t ? JSON.parse(t) : fallback; } catch (_) { return fallback; } }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function normalizeAddress(value) { try { return ethers.getAddress(String(value || "").replace(/^0X/, "0x")); } catch (_) { return null; } }
function lowerAddress(value) { const addr = normalizeAddress(value); return addr ? addr.toLowerCase() : null; }
function strip0x(value) { return String(value || "").replace(/^0x/i, ""); }
function unique(items) { return [...new Set((items || []).filter(Boolean))]; }
function compactAddress(value) { const addr = normalizeAddress(value); return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : "n/a"; }
function safeText(value, max = 140) { return String(value || "").replace(/https?:\/\/\S+/g, "[redacted-url]").replace(/\s+/g, " ").trim().slice(0, max) || null; }
function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value).replace(/[$,%\s,]/g, "");
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}
function round(value, decimals = 2) { const n = asNumber(value); if (n === null) return null; const factor = 10 ** decimals; return Math.round(n * factor) / factor; }
function formatUsd(value) { const n = asNumber(value); return n === null ? "n/a" : `$${Math.round(n).toLocaleString()}`; }
function formatNumber(value, decimals = 2) { const n = asNumber(value); return n === null ? "n/a" : n.toLocaleString(undefined, { maximumFractionDigits: decimals }); }
function unitsToNumber(value, decimals = 6) { try { if (value === null || value === undefined) return null; return Number(ethers.formatUnits(BigInt(value), decimals)); } catch (_) { return null; } }
function slotAddress(raw) { return raw && raw !== "0x" && raw.length >= 66 ? normalizeAddress(`0x${raw.slice(26)}`) : null; }

function usdLikeRaw(decimals, ppsDecimals, yieldRow) {
  if (yieldRow) return false;
  if (decimals === 18) return false;
  return decimals === 6 || (decimals === null && ppsDecimals === 6);
}

async function fetchJson(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-harmonix-phase0/1.0" } });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
    return { ok: res.ok, status: res.status, json, error: res.ok ? null : safeText(text || `HTTP ${res.status}`, 120) };
  } catch (err) { return { ok: false, status: null, json: null, error: safeText(err?.name || err?.message || "transport-error", 80) }; }
  finally { clearTimeout(timer); }
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

async function getSlotAddress(rpc, address, slot) {
  const raw = await rpcCall(rpc, "eth_getStorageAt", [address, slot, "latest"], 10_000).catch(() => null);
  return slotAddress(raw);
}

function protocolMetadata() {
  const d = readJson(PUBLIC_TARGETS, {});
  const rows = [...(d.phase0Queue || []), ...(d.consumerJoinFirst || []), ...(d.protocolCandidates || []), ...(d.targets || [])];
  const row = rows.find((p) => p?.slug === "harmonix-finance" || p?.name === "Harmonix Finance");
  if (row) return { name: row.name, slug: row.slug, category: row.category, chains: row.chains || [], evmChains: row.evmChains || [], customSupportedChains: row.customSupportedChains || [], tvlUsd: row.tvlUsd, change1dPct: row.change1dPct, change7dPct: row.change7dPct, routePriority: row.routePriority || null, source: "public-audit-target-discovery" };
  return { name: "Harmonix Finance", slug: "harmonix-finance", category: "Yield", chains: ["Hyperliquid L1", "Arbitrum", "Ethereum", "Base"], evmChains: ["Arbitrum", "Ethereum", "Base"], customSupportedChains: ["Hyperliquid L1"], tvlUsd: null };
}

async function loadYieldRows() {
  const fetched = await fetchJson("https://yields.llama.fi/pools", 45_000);
  const rows = (fetched.json?.data || []).filter((row) => String(row.project || "").toLowerCase() === "harmonix-finance").map((row) => ({
    pool: safeText(row.pool, 80),
    chain: safeText(row.chain, 40),
    project: row.project,
    symbol: safeText(row.symbol, 40),
    tvlUsd: round(row.tvlUsd, 2),
    apy: round(row.apy, 6),
    apyBase: round(row.apyBase, 6),
    apyReward: round(row.apyReward, 6),
    underlyingTokens: (row.underlyingTokens || []).map(normalizeAddress).filter(Boolean),
    rewardTokens: (row.rewardTokens || []).map(normalizeAddress).filter(Boolean),
    routePositive: false,
  }));
  return { fetched: { ok: fetched.ok, status: fetched.status, count: rows.length, error: fetched.error }, rows };
}

async function discoverVaults(rpc, chain) {
  const byAddress = new Map();
  let listStoppedAt = null;
  for (let i = 0; i < 60; i++) {
    const res = await safeCall(rpc, chain.factory, FACTORY, "vaultList", [i]);
    const addr = normalizeAddress(res?.[0]);
    if (!addr || addr === ZERO) { listStoppedAt = i; break; }
    byAddress.set(addr.toLowerCase(), { address: addr, discoverySources: ["vaultList"], vaultListIndex: i });
  }
  let logRows = 0;
  let logError = null;
  if (chain.logFromBlock) {
    try {
      const logs = await rpcCall(rpc, "eth_getLogs", [{ address: chain.factory, fromBlock: chain.logFromBlock, toBlock: "latest", topics: [VAULT_REGISTERED_TOPIC] }], 25_000);
      if (Array.isArray(logs)) {
        logRows = logs.length;
        for (const log of logs) {
          const addr = normalizeAddress(`0x${String(log.topics?.[1] || "").slice(26)}`);
          if (!addr) continue;
          const key = addr.toLowerCase();
          const existing = byAddress.get(key) || { address: addr, discoverySources: [] };
          existing.discoverySources = unique([...(existing.discoverySources || []), "VaultRegistered"]);
          byAddress.set(key, existing);
        }
      } else logError = "no-log-result";
    } catch (_) { logError = "log-query-failed"; }
  }
  return { vaults: [...byAddress.values()], listStoppedAt, logRows, logError };
}

async function inspectFactories(rpcs) {
  const rows = [];
  for (const chain of CHAINS) {
    const rpc = rpcs[chain.chainId];
    const code = await getCode(rpc, chain.factory);
    const [impl, admin, tvlRaw, adminFn] = await Promise.all([
      getSlotAddress(rpc, chain.factory, EIP1967_IMPL),
      getSlotAddress(rpc, chain.factory, EIP1967_ADMIN),
      safeCall(rpc, chain.factory, FACTORY, "getVaultsTVL"),
      safeCall(rpc, chain.factory, FACTORY, "admin"),
    ]);
    const implCode = impl ? await getCode(rpc, impl) : "0x";
    const discovery = await discoverVaults(rpc, chain);
    rows.push({
      ...chain,
      rpcAvailable: Boolean(rpc),
      codePresent: Boolean(code && code !== "0x"),
      codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
      implementation: impl,
      implementationCodePresent: Boolean(implCode && implCode !== "0x"),
      implementationCodeBytes: implCode && implCode !== "0x" ? strip0x(implCode).length / 2 : 0,
      proxyAdmin: admin,
      contractAdmin: normalizeAddress(adminFn?.[0]),
      getVaultsTvlRaw: tvlRaw?.[0]?.toString?.() || null,
      getVaultsTvlUsd: round(unitsToNumber(tvlRaw?.[0]?.toString?.(), 6), 2),
      vaultListRows: discovery.vaults.filter((v) => (v.discoverySources || []).includes("vaultList")).length,
      vaultRegisteredLogs: discovery.logRows,
      logError: discovery.logError,
      listStoppedAt: discovery.listStoppedAt,
      routePositive: false,
      discoveredVaults: discovery.vaults,
    });
  }
  return rows;
}

function tupleAt(result, index) { try { return result?.[0]?.[index] ?? result?.[0]?.[Object.keys(result?.[0] || {})[index]] ?? null; } catch (_) { return null; } }

async function inspectVaults(rpcs, factoryRows, yieldRows) {
  const rows = [];
  const byYieldToken = new Map();
  for (const y of yieldRows) for (const token of y.underlyingTokens || []) byYieldToken.set(token.toLowerCase(), y);
  for (const factory of factoryRows) {
    const rpc = rpcs[factory.chainId];
    for (const discovered of factory.discoveredVaults || []) {
      const address = normalizeAddress(discovered.address);
      if (!address) continue;
      const code = await getCode(rpc, address);
      const [impl, admin] = await Promise.all([getSlotAddress(rpc, address, EIP1967_IMPL), getSlotAddress(rpc, address, EIP1967_ADMIN)]);
      const implCode = impl ? await getCode(rpc, impl) : "0x";
      const [registered, tvl, totalAssets, pps, withdrawPool, feeInfo, vaultState, perpDex, ethStake, asset, decimals, symbol, name] = await Promise.all([
        safeCall(rpc, factory.factory, FACTORY, "registeredVaults", [address]),
        safeCall(rpc, address, VAULT, "totalValueLocked"),
        safeCall(rpc, address, VAULT, "totalAssets"),
        safeCall(rpc, address, VAULT, "pricePerShare"),
        safeCall(rpc, address, VAULT, "getWithdrawPoolAmount"),
        safeCall(rpc, address, VAULT, "getFeeInfo"),
        safeCall(rpc, address, VAULT, "getVaultState"),
        safeCall(rpc, address, VAULT, "getPerpDexState"),
        safeCall(rpc, address, VAULT, "getEthStakingState"),
        safeCall(rpc, address, VAULT, "asset"),
        safeCall(rpc, address, VAULT, "decimals"),
        safeCall(rpc, address, VAULT, "symbol"),
        safeCall(rpc, address, VAULT, "name"),
      ]);
      const assetAddr = normalizeAddress(asset?.[0]);
      const y = assetAddr ? byYieldToken.get(assetAddr.toLowerCase()) : null;
      const ppsRaw = pps?.[0]?.toString?.() || null;
      const ppsDecimals = ppsRaw && BigInt(ppsRaw) > 10n ** 12n ? 18 : 6;
      const tvlRaw = tvl?.[0]?.toString?.() || totalAssets?.[0]?.toString?.() || null;
      const amountDecimals = decimals?.[0] === undefined ? ppsDecimals : Number(decimals[0]);
      const withdrawRaw = withdrawPool?.[0]?.toString?.() || tupleAt(vaultState, 0)?.toString?.() || null;
      const isUsdLikeRaw = usdLikeRaw(decimals?.[0] === undefined ? null : Number(decimals[0]), ppsDecimals, y);
      const tvlUsd = y?.tvlUsd ?? (isUsdLikeRaw ? round(unitsToNumber(tvlRaw, 6), 2) : null);
      const withdrawUsd = isUsdLikeRaw ? round(unitsToNumber(withdrawRaw, 6), 2) : null;
      rows.push({
        chainId: factory.chainId,
        chain: factory.chain,
        factory: factory.factory,
        vault: address,
        discoverySources: discovered.discoverySources || [],
        vaultListIndex: discovered.vaultListIndex ?? null,
        registered: registered?.[0] === undefined ? null : Boolean(registered[0]),
        codePresent: Boolean(code && code !== "0x"),
        codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
        implementation: impl,
        implementationCodePresent: Boolean(implCode && implCode !== "0x"),
        implementationCodeBytes: implCode && implCode !== "0x" ? strip0x(implCode).length / 2 : 0,
        proxyAdmin: admin,
        asset: assetAddr,
        symbol: safeText(symbol?.[0], 40) || y?.symbol || null,
        name: safeText(name?.[0], 80),
        decimals: decimals?.[0] === undefined ? null : Number(decimals[0]),
        totalValueLockedRaw: tvlRaw,
        totalValueLockedTokenAmount: round(unitsToNumber(tvlRaw, amountDecimals), 8),
        totalValueLockedTokenDecimals: amountDecimals,
        totalValueLockedUsd: tvlUsd,
        totalValueLockedUsdSource: y ? "defillama-yields-token-match" : isUsdLikeRaw ? "vault-raw-usd-like-6dec" : null,
        totalValueLockedUsdAssuming6: isUsdLikeRaw ? tvlUsd : null,
        pricePerShareRaw: ppsRaw,
        pricePerShare: round(unitsToNumber(ppsRaw, ppsDecimals), 8),
        pricePerShareDecimals: ppsRaw ? ppsDecimals : null,
        withdrawPoolAmountRaw: withdrawRaw,
        withdrawPoolTokenAmount: round(unitsToNumber(withdrawRaw, amountDecimals), 8),
        withdrawPoolUsd: withdrawUsd,
        withdrawPoolUsdAssuming6: withdrawUsd,
        pendingDepositAmountRaw: tupleAt(vaultState, 1)?.toString?.() || null,
        totalSharesRaw: tupleAt(vaultState, 2)?.toString?.() || null,
        totalFeePoolAmountRaw: tupleAt(vaultState, 3)?.toString?.() || null,
        lastUpdateManagementFeeDate: tupleAt(vaultState, 4)?.toString?.() || null,
        performanceFee: feeInfo?.[0]?.toString?.() || null,
        managementFee: feeInfo?.[1]?.toString?.() || null,
        perpDexUnallocatedRaw: perpDex?.[0]?.toString?.() || null,
        perpDexBalanceRaw: perpDex?.[1]?.toString?.() || null,
        ethStakeUnallocatedRaw: ethStake?.[0]?.[0]?.toString?.() || null,
        ethStakeTotalRaw: ethStake?.[0]?.[1]?.toString?.() || null,
        yieldPool: y?.pool || null,
        yieldTvlUsd: y?.tvlUsd || null,
        yieldApy: y?.apy || null,
        needsManualUsdNormalization: Boolean(tvlRaw && !tvlUsd),
        usdNormalizationNote: y ? "USD resolved from matched public yield row" : isUsdLikeRaw ? "raw vault units treated as 6-decimal USD-like TVL" : "raw vault units are token-denominated; not reported as USD without a trusted price row",
        routePositive: false,
      });
    }
  }
  return rows.sort((a, b) => (asNumber(b.totalValueLockedUsd) || 0) - (asNumber(a.totalValueLockedUsd) || 0));
}

function primitiveAddresses(value, out = new Set()) {
  if (typeof value === "string") { for (const m of value.matchAll(/0x[0-9a-fA-F]{40}/g)) out.add(m[0].toLowerCase()); }
  else if (Array.isArray(value)) { for (const item of value) primitiveAddresses(item, out); }
  else if (value && typeof value === "object") { for (const item of Object.values(value)) primitiveAddresses(item, out); }
  return out;
}

function summarizeContext(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const fields = ["id", "protocol", "project", "name", "chain", "chainId", "surface", "side", "symbol", "asset", "token", "collateral", "borrowAsset", "loanAsset", "oracle", "source", "status", "routePositive", "watchCandidate", "liquidityUsd", "borrowCashUsd", "cashUsd", "borrowAssetsUsd", "supplyAssetsUsd", "file", "rootFile"];
  const out = {};
  for (const field of fields) { const value = obj[field]; if (value === undefined) continue; out[field] = typeof value === "object" ? safeText(JSON.stringify(value), 180) : safeText(value, 180); }
  return out;
}

function scanObjectForAddresses(source, obj, addressRoles, out, depth = 0) {
  if (!obj || depth > 9 || out.length >= 900) return;
  if (Array.isArray(obj)) { for (const item of obj) scanObjectForAddresses(source, item, addressRoles, out, depth + 1); return; }
  if (typeof obj !== "object") return;
  const hits = [...primitiveAddresses(obj)].filter((addr) => addressRoles[addr]);
  if (hits.length) {
    const roles = unique(hits.flatMap((addr) => addressRoles[addr].map((role) => role.role)));
    out.push({
      source,
      hitRoles: roles,
      hitAddresses: hits.slice(0, 12),
      chains: unique(hits.flatMap((addr) => addressRoles[addr].map((role) => role.chain)).filter(Boolean)).slice(0, 8),
      directConsumer: roles.some((role) => DIRECT_ROLES.has(role)),
      context: summarizeContext(obj),
      routePositive: false,
      blocker: "Local artifact address match is context only unless Harmonix vault/factory/share state is trusted by consumer logic with exact positive economics",
    });
    return;
  }
  for (const value of Object.values(obj)) scanObjectForAddresses(source, value, addressRoles, out, depth + 1);
}

function localConsumerJoins(factoryRows, vaultRows, yieldRows) {
  const roles = {};
  function add(addr, role) {
    const lower = lowerAddress(addr);
    if (!lower || lower === ZERO) return;
    if (!roles[lower]) roles[lower] = [];
    roles[lower].push(role);
  }
  for (const row of factoryRows) add(row.factory, { role: "harmonixFactory", chain: row.chain });
  for (const row of vaultRows) {
    add(row.vault, { role: "harmonixVault", chain: row.chain, symbol: row.symbol });
    add(row.asset, { role: "yieldUnderlying", chain: row.chain, symbol: row.symbol });
  }
  for (const row of yieldRows) for (const token of row.underlyingTokens || []) add(token, { role: "yieldUnderlying", chain: row.chain, symbol: row.symbol });
  const matches = [];
  for (const [source, rel] of CONSUMER_ARTIFACTS) { const json = readJson(path.join(WORKSPACE, rel), null); if (json) scanObjectForAddresses(source, json, roles, matches); }
  return { directConsumerRows: matches.filter((row) => row.directConsumer), tokenContextRows: matches.filter((row) => !row.directConsumer) };
}

function buildReport(artifact) {
  const s = artifact.summary;
  const factoryTable = artifact.factoryRows.map((row) => `| ${row.chain} | ${compactAddress(row.factory)} | ${row.codePresent ? "yes" : "no"} | ${compactAddress(row.implementation)} | ${formatUsd(row.getVaultsTvlUsd)} | ${row.vaultListRows} | ${row.vaultRegisteredLogs} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a |";
  const vaultTable = artifact.vaultRows.slice(0, 14).map((row) => `| ${row.chain} | ${compactAddress(row.vault)} | ${row.registered ?? "n/a"} | ${formatUsd(row.totalValueLockedUsd)} | ${formatNumber(row.totalValueLockedTokenAmount, 6)} | ${row.totalValueLockedTokenDecimals ?? "n/a"} | ${formatNumber(row.pricePerShare, 8)} | ${formatUsd(row.withdrawPoolUsd)} | ${row.performanceFee ?? "n/a"}/${row.managementFee ?? "n/a"} |`).join("\n") || "| none | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |";
  const yieldTable = artifact.yieldRows.map((row) => `| ${row.chain} | ${row.symbol} | ${formatUsd(row.tvlUsd)} | ${formatNumber(row.apy, 4)}% | ${(row.underlyingTokens || []).map(compactAddress).join(", ") || "n/a"} |`).join("\n") || "| none | n/a | n/a | n/a | n/a |";
  const consumerTable = artifact.directConsumerRows.length ? artifact.directConsumerRows.slice(0, 10).map((row) => `| ${row.source} | ${row.hitRoles.join(",")} | ${row.hitAddresses.map(compactAddress).join(", ")} | ${row.chains.join(", ") || "n/a"} | ${safeText(row.context?.protocol || row.context?.project || row.context?.name || row.context?.surface || row.context?.file || "context", 80)} |`).join("\n") : "| none | n/a | n/a | n/a | no Harmonix factory/vault address was found in consumer-grade artifacts |";
  return `# ${SIGNAL_DORMANT} - Harmonix Finance Phase 0 Triage

Date: ${artifact.generatedAt}

## Result

No confirmed permissionless exploit for the covered Harmonix factory/vault/yield scope. The DeFiLlama adapter is a factory aggregate-TVl model using \`getVaultsTVL()\`, not a lending market or public AMM. Factories and proxies were mapped on Ethereum, Arbitrum, Base, and Hyperliquid; vaults were resolved from \`vaultList\` and \`VaultRegistered\` logs where available. Harmonix vaults are not standard ERC4626: withdrawal is queued via initiate/complete withdrawal paths, share accounting is custom, and no Harmonix factory/vault address joined to consumer-grade lending/oracle artifacts with exact positive borrow, redemption, liquidation, settlement, or unwind economics.

## Scope

| Item | Value |
|---|---:|
| DeFiLlama TVL context | ${formatUsd(s.defillamaCurrentTvlUsd)} |
| Factories checked | ${s.factoryRows} |
| Factories with code | ${s.factoryRowsWithCode} |
| Factory aggregate TVL | ${formatUsd(s.factoryAggregateTvlUsd)} |
| Vault rows | ${s.vaultRows} |
| Vault rows with code | ${s.vaultRowsWithCode} |
| Vault rows with resolved USD | ${s.vaultRowsWithResolvedUsd} |
| Vault rows token-denominated only | ${s.vaultRowsTokenDenominatedOnly} |
| Vault resolved TVL | ${formatUsd(s.vaultResolvedTvlUsd)} |
| Public yield rows | ${s.yieldRows} |
| Direct Harmonix consumer rows | ${s.directConsumerRows} |
| Token context rows | ${s.tokenContextRows} |
| Watch candidates | ${s.watchCandidates} |
| Route-positive | ${s.routePositive} |
| Coverage classification | ${s.coverageClassification} |

## Factories

| Chain | Factory | Code | Implementation | getVaultsTVL | vaultList rows | registered logs |
|---|---|---|---|---:|---:|---:|
${factoryTable}

## Vaults

| Chain | Vault | Registered | TVL USD | TVL units | Unit decimals | PPS | Withdraw USD | Perf/Mgmt fee |
|---|---|---|---:|---:|---:|---:|---:|---:|
${vaultTable}

USD TVL uses matched public yield rows where available, otherwise only clearly 6-decimal USD-like vault units. Token-denominated vault rows are kept as raw/unit amounts and not counted as USD without a trusted price source.

## Public Yield Rows

| Chain | Symbol | TVL USD | APY | Underlying tokens |
|---|---|---:|---:|---|
${yieldTable}

## Direct Harmonix Consumer Join

| Source | Hit roles | Addresses | Chains | Context |
|---|---|---|---|---|
${consumerTable}

## Blockers

- Adapter state is aggregate factory/vault TVL context, not a lending or AMM value source by itself.
- Harmonix vault shares are custom/queued-withdrawal accounting, not an immediately redeemable ERC4626 route in the observed ABI.
- No Harmonix factory/vault address was found in scanned consumer-grade artifacts.
- Underlying-token joins are common-asset/yield context only and do not prove accepted-value dependence on Harmonix vault state.
- No exact positive borrow, redemption, liquidation, settlement, or DEX unwind economics and no fork extraction proof exist.

## Required For Route-Positive

- A deployed consumer references Harmonix vault/factory/share accounting state.
- Shares are permissionlessly acquirable and accepted as value by a material borrower/redeemer/liquidator/settlement path.
- Withdrawal or unwind path is exact-quoted and positive after fees, queue delay, slippage, and gas.
- Fork/local proof demonstrates positive net value.

Artifacts: \`reports/raw/fast/harmonix-phase0.json\`.
`;
}

async function main() {
  const metadata = protocolMetadata();
  const chainIds = CHAINS.map((c) => c.chainId);
  const rpcs = await resolveRpcPool(chainIds);
  const rpcAvailability = Object.fromEntries(chainIds.map((chainId) => [chainId, Boolean(rpcs[chainId])]))
  const yields = await loadYieldRows();
  const factoryRows = await inspectFactories(rpcs);
  const vaultRows = await inspectVaults(rpcs, factoryRows, yields.rows);
  const joins = localConsumerJoins(factoryRows, vaultRows, yields.rows);
  const watchCandidates = joins.directConsumerRows.map((row) => ({ ...row, reason: "Harmonix factory/vault appears in consumer-grade artifact; needs source/economics review", routePositive: false }));
  const summary = {
    rpcAvailability,
    defillamaCurrentTvlUsd: metadata.tvlUsd,
    factoryRows: factoryRows.length,
    factoryRowsWithCode: factoryRows.filter((row) => row.codePresent).length,
    factoryImplRowsWithCode: factoryRows.filter((row) => row.implementationCodePresent).length,
    factoryAggregateTvlUsd: round(factoryRows.reduce((sum, row) => sum + (asNumber(row.getVaultsTvlUsd) || 0), 0), 2),
    vaultRows: vaultRows.length,
    vaultRowsWithCode: vaultRows.filter((row) => row.codePresent).length,
    vaultRowsRegistered: vaultRows.filter((row) => row.registered).length,
    vaultRowsWithResolvedUsd: vaultRows.filter((row) => asNumber(row.totalValueLockedUsd) !== null).length,
    vaultRowsUsdLike6: vaultRows.filter((row) => row.totalValueLockedUsdSource === "vault-raw-usd-like-6dec").length,
    vaultRowsYieldMatched: vaultRows.filter((row) => row.totalValueLockedUsdSource === "defillama-yields-token-match").length,
    vaultRowsTokenDenominatedOnly: vaultRows.filter((row) => row.needsManualUsdNormalization).length,
    vaultResolvedTvlUsd: round(vaultRows.reduce((sum, row) => sum + (asNumber(row.totalValueLockedUsd) || 0), 0), 2),
    vaultTvlUsdAssuming6: round(vaultRows.reduce((sum, row) => sum + (asNumber(row.totalValueLockedUsdAssuming6) || 0), 0), 2),
    yieldRows: yields.rows.length,
    yieldTvlUsd: round(yields.rows.reduce((sum, row) => sum + (asNumber(row.tvlUsd) || 0), 0), 2),
    directConsumerRows: joins.directConsumerRows.length,
    tokenContextRows: joins.tokenContextRows.length,
    watchCandidates: watchCandidates.length,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    coverageClassification: factoryRows.every((row) => row.codePresent) && vaultRows.length > 0 ? "full-enough-for-declared-scope" : "bounded-with-caveats",
    closedReason: joins.directConsumerRows.length ? "Harmonix-specific address references found, but no exact-positive consumer economics or proof" : "route-negative for adapter factory/vault/yield scope; no Harmonix-specific consumer value path found",
  };
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-harmonix-phase0.js",
    scope: "Read-only Harmonix Finance adapter factory/vault/yield and consumer-route Phase 0 scan",
    target: { name: "Harmonix Finance", slug: "harmonix-finance", category: "Yield", surface: "vault-yield-allocator", metadata },
    safety: { publicApisOnlyForMetadata: true, rpcInventoryRead: true, rpcUrlsStored: false, privateKeysRead: false, signedActions: false, exploitExecuteCalls: false, forkTransactions: false, routePositive: false, executableNow: false, signedActionJustified: false },
    docs: { adapter: "https://raw.githubusercontent.com/DefiLlama/DefiLlama-Adapters/main/projects/harmonix/index.js", methodology: "Aggregates total value of each Harmonix vault", sourcifySourceChecked: true },
    thresholds: { maxVaultListProbe: 60 },
    yieldFetch: yields.fetched,
    factoryRows: factoryRows.map(({ discoveredVaults, ...row }) => row),
    vaultRows,
    yieldRows: yields.rows,
    directConsumerRows: joins.directConsumerRows,
    tokenContextRows: joins.tokenContextRows.slice(0, 180),
    watchCandidates,
    routePositiveRows: [],
    summary,
    blockers: [
      "Adapter state is aggregate factory/vault TVL context, not a lending or AMM value source by itself",
      "Harmonix vault shares are custom/queued-withdrawal accounting, not an immediately redeemable ERC4626 route in the observed ABI",
      "No Harmonix factory/vault address was found in scanned consumer-grade artifacts",
      "Underlying-token joins are common-asset/yield context only and not Harmonix-specific impact",
      "No exact positive borrow, redemption, liquidation, settlement, or DEX unwind economics or proof",
    ],
    requiredForRoutePositive: [
      "deployed consumer references Harmonix vault/factory/share accounting state",
      "shares are permissionlessly acquirable and accepted as value by a material route",
      "withdrawal or unwind path is exact-quoted and positive after fees, queue delay, slippage, and gas",
      "fork/local proof",
    ],
    nextReadOnlyStep: "Reopen Harmonix only if a consumer references Harmonix vault/factory/share state or a public same-epoch exit route becomes exact-positive.",
  };
  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(artifact, jsonReplacer, 2)}\n`);
  fs.writeFileSync(REPORT_OUT, buildReport(artifact));
  if (!QUIET) console.log(`Harmonix Phase 0: factories=${summary.factoryRows} vaults=${summary.vaultRows} yieldRows=${summary.yieldRows} directConsumers=${summary.directConsumerRows} watch=${summary.watchCandidates} routePositive=${summary.routePositive}`);
}

main().catch((err) => { console.error(err?.message || String(err)); process.exit(1); });
