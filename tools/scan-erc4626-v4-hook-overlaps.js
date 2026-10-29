#!/usr/bin/env node
// Read-only joiner for low-TVL ERC4626 vault alerts whose address is also a Uniswap V4 hook.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const ALERTS_FILE = path.join(WORKSPACE, "reports", "monitor", "alerts.jsonl");
const HOOKS_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "uniswap-v4-hooks.json");
const VAULT_INVENTORY_FILE = path.join(WORKSPACE, "reports", "monitor", "vault-inventory.json");
const MORPHO_ALLOCATOR_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "morpho-public-allocator-force-feed.json");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "erc4626-v4-hook-overlaps.json");

const DAY_MS = 24 * 60 * 60 * 1000;
const ZERO = "0x0000000000000000000000000000000000000000";
const CHAINS = {
  1: {
    name: "Ethereum",
    artifactKey: "ethereum",
    poolManager: "0x000000000004444c5dc75cB358380D2e3dE08A90",
    fromBlock: 21600000,
  },
  8453: {
    name: "Base",
    artifactKey: "base",
    poolManager: "0x498581ff718922c3f8e6a244956af099b2652b2b",
    fromBlock: 25000000,
  },
};

const ERC4626 = new ethers.Interface([
  "function asset() view returns (address)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
]);
const ERC20 = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
]);
const POOL = new ethers.Interface([
  "event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,uint24 fee,int24 tickSpacing,address hooks,uint160 sqrtPriceX96,int24 tick)",
  "event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)",
  "event Donate(bytes32 indexed id,address indexed sender,uint256 amount0,uint256 amount1)",
]);

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function loadAlerts() {
  try {
    return fs.readFileSync(ALERTS_FILE, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (_) {
    return [];
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
  const addr = normalizeAddress(value);
  return addr ? addr.toLowerCase() : null;
}

function loadRpcUrls() {
  if (!fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function rpcCall(url, method, params = [], timeoutMs = 8000) {
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
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    return json.result ?? null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveRpc(chainId) {
  for (const url of loadRpcUrls()) {
    try {
      const idHex = await rpcCall(url, "eth_chainId", [], 5000);
      if (Number(BigInt(idHex)) === chainId) return url;
    } catch (_) {
      // Never print or persist RPC URLs.
    }
  }
  return null;
}

function alertStateKey(a) {
  const id = a.vector || a.vault || a.market || a.feed || a.asset || a.token || a.contract || a.proxy || a.target || a.address || a.poolId || a.chainId || a.chain || a.message || "";
  return `${a.condition || "unknown"}:${String(id).toLowerCase()}`;
}

function currentVaultAlerts(alerts, nowMs) {
  const recent = alerts.filter((a) => nowMs - new Date(a.timestamp).getTime() < DAY_MS);
  const states = new Map();
  for (const alert of recent) {
    const key = alertStateKey(alert);
    const prev = states.get(key);
    if (!prev || new Date(alert.timestamp) >= new Date(prev.timestamp)) states.set(key, alert);
  }
  return [...states.values()].filter((a) =>
    ["vault-new-deploy", "vault-donation"].includes(a.condition)
    && ["CRITICAL", "HIGH"].includes(a.severity)
    && normalizeAddress(a.vault)
  );
}

function inventoryVaultRows(inventory) {
  const rows = [];
  for (const [chainIdRaw, chain] of Object.entries(inventory?.chains || {})) {
    const chainId = Number(chainIdRaw);
    for (const vault of chain?.vaults || []) {
      const address = normalizeAddress(vault.address);
      if (!address) continue;
      rows.push({
        chainId,
        vault: address,
        inventory: {
          deployBlock: vault.deployBlock ?? null,
          totalAssets: vault.totalAssets ?? null,
          decimals: vault.decimals ?? null,
          flag: vault.flag || null,
        },
      });
    }
  }
  return rows;
}

function morphoVaultRows(artifact) {
  const rows = new Map();
  function add(vault) {
    const address = normalizeAddress(vault?.address);
    if (!address) return;
    const key = `1:${address.toLowerCase()}`;
    const prev = rows.get(key) || { chainId: 1, vault: address, morpho: { appearances: 0 } };
    prev.morpho.appearances += 1;
    prev.morpho.symbol = prev.morpho.symbol || vault.symbol || null;
    prev.morpho.name = prev.morpho.name || vault.name || null;
    prev.morpho.totalAssetsUsd = prev.morpho.totalAssetsUsd ?? vault.totalAssetsUsd ?? null;
    prev.morpho.liquidityUsd = prev.morpho.liquidityUsd ?? vault.liquidityUsd ?? null;
    rows.set(key, prev);
  }
  function walk(value, key = null) {
    if (!value || typeof value !== "object") return;
    if (key === "vault" && !Array.isArray(value)) add(value);
    if (Array.isArray(value)) {
      for (const item of value) walk(item, null);
      return;
    }
    for (const [childKey, childValue] of Object.entries(value)) walk(childValue, childKey);
  }
  walk(artifact);
  return [...rows.values()];
}

function mergeCandidate(map, row, source) {
  const vault = normalizeAddress(row.vault);
  if (!vault || !Number.isFinite(Number(row.chainId))) return;
  const key = `${Number(row.chainId)}:${vault.toLowerCase()}`;
  const prev = map.get(key) || {
    chainId: Number(row.chainId),
    chain: CHAINS[Number(row.chainId)]?.name || String(row.chainId),
    vault,
    sources: [],
  };
  if (!prev.sources.includes(source)) prev.sources.push(source);
  if (row.alert) prev.alert = row.alert;
  if (row.inventory) prev.inventory = row.inventory;
  if (row.morpho) prev.morpho = row.morpho;
  map.set(key, prev);
}

function buildHookIndex(hooksArtifact) {
  const byChain = new Map();
  for (const [artifactKey, entry] of Object.entries(hooksArtifact || {})) {
    const chainId = Number(entry?.chainId);
    if (!Number.isFinite(chainId) || !Array.isArray(entry.hooks)) continue;
    const hooks = new Map();
    for (const hook of entry.hooks) {
      const addr = lowerAddress(hook.address);
      if (addr) hooks.set(addr, { ...hook, artifactKey, artifactBlock: entry.block || null });
    }
    byChain.set(chainId, { entry, hooks });
  }
  return byChain;
}

async function safeCall(provider, to, iface, fn, args = []) {
  try {
    const raw = await provider.call({ to, data: iface.encodeFunctionData(fn, args) });
    if (!raw || raw === "0x") return null;
    return iface.decodeFunctionResult(fn, raw)[0];
  } catch (_) {
    return null;
  }
}

async function tokenMeta(provider, address) {
  const normalized = normalizeAddress(address);
  if (!normalized || normalized.toLowerCase() === ZERO) {
    return { address: ZERO, symbol: "ETH", name: "Ether", decimals: 18 };
  }
  const [symbol, name, decimals] = await Promise.all([
    safeCall(provider, normalized, ERC20, "symbol"),
    safeCall(provider, normalized, ERC20, "name"),
    safeCall(provider, normalized, ERC20, "decimals"),
  ]);
  return {
    address: normalized,
    symbol: typeof symbol === "string" ? symbol : null,
    name: typeof name === "string" ? name : null,
    decimals: decimals == null ? null : Number(decimals),
  };
}

async function erc4626State(provider, vault) {
  const [code, symbol, name, decimals, asset, totalAssets, totalSupply] = await Promise.all([
    provider.getCode(vault),
    safeCall(provider, vault, ERC4626, "symbol"),
    safeCall(provider, vault, ERC4626, "name"),
    safeCall(provider, vault, ERC4626, "decimals"),
    safeCall(provider, vault, ERC4626, "asset"),
    safeCall(provider, vault, ERC4626, "totalAssets"),
    safeCall(provider, vault, ERC4626, "totalSupply"),
  ]);
  const vaultDecimals = decimals == null ? null : Number(decimals);
  const oneShare = vaultDecimals == null ? null : 10n ** BigInt(vaultDecimals);
  const oneShareAssets = oneShare == null ? null : await safeCall(provider, vault, ERC4626, "convertToAssets", [oneShare]);
  const assetMeta = asset ? await tokenMeta(provider, asset) : null;
  return {
    hasCode: code && code !== "0x",
    codeSize: code && code !== "0x" ? (code.length - 2) / 2 : 0,
    symbol: typeof symbol === "string" ? symbol : null,
    name: typeof name === "string" ? name : null,
    decimals: vaultDecimals,
    asset: asset ? normalizeAddress(asset) : null,
    assetMeta,
    totalAssetsRaw: totalAssets,
    totalSupplyRaw: totalSupply,
    oneShareAssetsRaw: oneShareAssets,
    oneShareAssets: oneShareAssets != null && assetMeta?.decimals != null ? Number(ethers.formatUnits(oneShareAssets, assetMeta.decimals)) : null,
    totalAssets: totalAssets != null && assetMeta?.decimals != null ? Number(ethers.formatUnits(totalAssets, assetMeta.decimals)) : null,
    totalSupply: totalSupply != null && vaultDecimals != null ? Number(ethers.formatUnits(totalSupply, vaultDecimals)) : null,
  };
}

async function getLogs(provider, filter, fromBlock, toBlock) {
  try {
    return await provider.getLogs({ ...filter, fromBlock, toBlock });
  } catch (_) {
    const out = [];
    const step = 10000;
    for (let start = fromBlock; start <= toBlock; start += step) {
      const end = Math.min(toBlock, start + step - 1);
      try {
        out.push(...await provider.getLogs({ ...filter, fromBlock: start, toBlock: end }));
      } catch (_) {
        // Provider may refuse a range; keep the scanner fail-closed.
      }
    }
    return out;
  }
}

async function poolEvents(provider, chain, poolIds, artifactBlock = null) {
  const latest = await provider.getBlockNumber();
  const initToBlock = artifactBlock || latest;
  const initFromBlock = Math.max(chain.fromBlock || 0, initToBlock - 200_000);
  const initTopic = POOL.getEvent("Initialize").topicHash;
  const swapTopic = POOL.getEvent("Swap").topicHash;
  const donateTopic = POOL.getEvent("Donate").topicHash;
  const rows = [];
  for (const poolId of poolIds) {
    const id = String(poolId || "").toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(id)) continue;
    const initLogs = await getLogs(provider, { address: chain.poolManager, topics: [initTopic, id] }, initFromBlock, initToBlock);
    const anyPoolIdLogs = initLogs.length ? [] : await getLogs(provider, { address: chain.poolManager, topics: [null, id] }, initFromBlock, initToBlock);
    const recentFrom = Math.max(chain.fromBlock || 0, latest - 50_000);
    const swapLogs = await getLogs(provider, { address: chain.poolManager, topics: [swapTopic, id] }, recentFrom, latest);
    const donateLogs = await getLogs(provider, { address: chain.poolManager, topics: [donateTopic, id] }, recentFrom, latest);
    const parsed = initLogs.map((log) => {
      try {
        const p = POOL.parseLog(log);
        return {
          blockNumber: log.blockNumber,
          currency0: normalizeAddress(p.args.currency0),
          currency1: normalizeAddress(p.args.currency1),
          fee: Number(p.args.fee),
          tickSpacing: Number(p.args.tickSpacing),
          hooks: normalizeAddress(p.args.hooks),
          sqrtPriceX96: p.args.sqrtPriceX96,
          tick: Number(p.args.tick),
        };
      } catch (_) {
        return null;
      }
    }).filter(Boolean);
    rows.push({
      poolId: id,
      initializeLogs: parsed,
      initializeLookupBlocks: {
        from: initFromBlock,
        to: initToBlock,
      },
      anyPoolIdEventCount: initLogs.length ? initLogs.length : anyPoolIdLogs.length,
      anyPoolIdEventTopicSamples: anyPoolIdLogs.slice(0, 5).map((log) => log.topics[0]),
      recentWindowBlocks: latest - recentFrom,
      recentSwaps: swapLogs.length,
      recentDonates: donateLogs.length,
    });
  }
  return rows;
}

async function main() {
  const nowMs = Date.now();
  const alerts = loadAlerts();
  const hooksArtifact = readJson(HOOKS_FILE, {});
  const inventory = readJson(VAULT_INVENTORY_FILE, {});
  const morphoAllocator = readJson(MORPHO_ALLOCATOR_FILE, {});
  const hookIndex = buildHookIndex(hooksArtifact);
  const vaultAlerts = currentVaultAlerts(alerts, nowMs);
  const inventoryRows = inventoryVaultRows(inventory);
  const morphoRows = morphoVaultRows(morphoAllocator);
  const merged = new Map();

  for (const alert of vaultAlerts) {
    mergeCandidate(merged, { chainId: Number(alert.chainId), vault: alert.vault, alert }, "current-alert");
  }
  for (const row of inventoryRows) mergeCandidate(merged, row, "vault-inventory");
  for (const row of morphoRows) mergeCandidate(merged, row, "morpho-public-allocator");

  const candidates = [];
  for (const row of merged.values()) {
    const hook = hookIndex.get(row.chainId)?.hooks?.get(row.vault.toLowerCase());
    if (!hook) continue;
    candidates.push({ ...row, hook });
  }

  const rpcByChain = new Map();
  const rows = [];
  for (const candidate of candidates) {
    const chain = CHAINS[candidate.chainId];
    let rpcResolved = false;
    let state = null;
    let pools = [];
    if (chain) {
      let rpc = rpcByChain.get(candidate.chainId);
      if (rpc === undefined) {
        rpc = await resolveRpc(candidate.chainId);
        rpcByChain.set(candidate.chainId, rpc || null);
      }
      if (rpc) {
        rpcResolved = true;
        const provider = new ethers.JsonRpcProvider(rpc);
        state = await erc4626State(provider, candidate.vault);
        pools = await poolEvents(provider, chain, candidate.hook.samplePoolIds || [], candidate.hook.artifactBlock);
        for (const pool of pools) {
          for (const init of pool.initializeLogs) {
            const currencyMetas = await Promise.all([
              tokenMeta(provider, init.currency0),
              tokenMeta(provider, init.currency1),
            ]);
            init.currency0Meta = currencyMetas[0];
            init.currency1Meta = currencyMetas[1];
          }
        }
      }
    }

    const poolCurrencies = pools.flatMap((pool) => pool.initializeLogs.flatMap((init) => [init.currency0, init.currency1])).filter(Boolean).map((a) => a.toLowerCase());
    const actualHooks = [...new Set(pools.flatMap((pool) => pool.initializeLogs.map((init) => init.hooks)).filter(Boolean).map((a) => a.toLowerCase()))];
    const vaultLower = candidate.vault.toLowerCase();
    const assetLower = state?.asset ? state.asset.toLowerCase() : null;
    const currenciesIncludeVault = poolCurrencies.includes(vaultLower);
    const currenciesIncludeAsset = assetLower ? poolCurrencies.includes(assetLower) : false;
    const vaultIsActualHook = actualHooks.includes(vaultLower);
    const artifactLikelyCurrencyMisclassification = currenciesIncludeVault && !vaultIsActualHook;
    const recentSwaps = pools.reduce((sum, pool) => sum + pool.recentSwaps, 0);
    const recentDonates = pools.reduce((sum, pool) => sum + pool.recentDonates, 0);

    rows.push({
      chainId: candidate.chainId,
      chain: candidate.chain,
      rpcResolved,
      vault: candidate.vault,
      sources: candidate.sources,
      alert: {
        timestamp: candidate.alert?.timestamp || null,
        condition: candidate.alert?.condition || null,
        severity: candidate.alert?.severity || null,
        totalAssets: candidate.alert?.totalAssets ?? null,
        classification: candidate.alert?.classification || null,
      },
      inventory: candidate.inventory || null,
      morpho: candidate.morpho || null,
      hook: {
        flags: candidate.hook.flags,
        enabledFlags: candidate.hook.enabledFlags || [],
        poolCount: candidate.hook.poolCount || 0,
        samplePoolIds: candidate.hook.samplePoolIds || [],
        hasCode: candidate.hook.hasCode,
        codeSize: candidate.hook.codeSize,
      },
      erc4626: state,
      pools,
      analysis: {
        currenciesIncludeVault,
        currenciesIncludeAsset,
        actualHookAddresses: actualHooks,
        vaultIsActualHook,
        artifactLikelyCurrencyMisclassification,
        recentSwaps,
        recentDonates,
        routePositive: false,
        signedActionJustified: false,
        blockers: [
          "No lending/oracle consumer route-positive proof",
          artifactLikelyCurrencyMisclassification ? "Vault address is a V4 pool currency, not the initialized hook" : "Uniswap V4 hook overlap is not extractable by itself",
          "Needs source review plus fork proof before any impact claim",
        ],
      },
    });
  }

  const out = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-erc4626-v4-hook-overlaps.js",
    scope: "Low-TVL ERC4626 vault alerts whose address is also a Uniswap V4 hook",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: false,
      signedActionJustified: false,
    },
    sourceArtifacts: {
      alerts: "reports\\monitor\\alerts.jsonl",
      hooks: "reports\\raw\\fast\\uniswap-v4-hooks.json",
      vaultInventory: "reports\\monitor\\vault-inventory.json",
      morphoPublicAllocator: "reports\\raw\\fast\\morpho-public-allocator-force-feed.json",
    },
    summary: {
      currentLowTvlVaultAlerts: vaultAlerts.length,
      inventoryVaults: inventoryRows.length,
      morphoAllocatorVaults: morphoRows.length,
      hookOverlaps: rows.length,
      currentAlertHookOverlaps: rows.filter((r) => r.sources.includes("current-alert")).length,
      inventoryHookOverlaps: rows.filter((r) => r.sources.includes("vault-inventory")).length,
      morphoAllocatorHookOverlaps: rows.filter((r) => r.sources.includes("morpho-public-allocator")).length,
      erc4626Confirmed: rows.filter((r) => r.erc4626?.asset).length,
      poolKeysResolved: rows.reduce((sum, r) => sum + r.pools.reduce((s, p) => s + p.initializeLogs.length, 0), 0),
      rowsWithRecentSwaps: rows.filter((r) => r.analysis.recentSwaps > 0).length,
      rowsWherePoolTradesVault: rows.filter((r) => r.analysis.currenciesIncludeVault).length,
      rowsWherePoolTradesUnderlying: rows.filter((r) => r.analysis.currenciesIncludeAsset).length,
      rowsWhereVaultIsActualHook: rows.filter((r) => r.analysis.vaultIsActualHook).length,
      rowsLikelyCurrencyMisclassifiedAsHook: rows.filter((r) => r.analysis.artifactLikelyCurrencyMisclassification).length,
      watchCandidates: 0,
      routePositive: 0,
      signedActionJustified: false,
    },
    rows,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, jsonReplacer, 2));
  console.log(`Wrote ${path.relative(WORKSPACE, OUT)}; overlaps=${rows.length}; routePositive=0`);
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exitCode = 1;
});
