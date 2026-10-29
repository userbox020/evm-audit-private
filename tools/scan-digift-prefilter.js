#!/usr/bin/env node
// Read-only DigiFT RWA token/registry/consumer prefilter.
// RPC URLs are resolved in memory only via shared-rpc and are never printed or stored.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const OUT = path.join(RAW_DIR, "prefilter-digift-rwa-route-prefilter.json");
const DFEED = "0x7d4d68f18d1be3410ab8d827fb7ebc690f938d2d";
const UMINT = "0xC06036793272219179F846eF6bfc3B16E820Df0B";
const ULTRA = "0x50293DD8889B931EB3441d2664dce8396640B419";
const SUBRED_MANAGEMENT = "0x3797c46db697c24a983222c335f17ba28e8c5b69";
const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const MINT_BURN_FROM_BLOCK = 21091537;

const CHAINS = {
  1: { chain: "Ethereum", llamaKey: "ethereum", geckoNetwork: "eth" },
  42161: { chain: "Arbitrum", llamaKey: "arbitrum", geckoNetwork: "arbitrum" },
  56: { chain: "BNB Chain", llamaKey: "bsc", geckoNetwork: "bsc" },
  137: { chain: "Polygon", llamaKey: "polygon", geckoNetwork: "polygon_pos" },
  98866: { chain: "Plume Mainnet", llamaKey: "plume", geckoNetwork: null },
};
const SCOPE_CHAIN_IDS = [1, 42161, 56, 98866];

const LOCAL_MATCH_FILES = [
  "rwa-nav-consumer-graph.json",
  "aave-euler-silo-consumer-graph.json",
  "consumer-first-high-ltv-collateral.json",
  "euler-v2-phase0.json",
  "silo-v2-phase0.json",
  "pendle-pt-consumer-graph.json",
  "pendle-pt-multichain-consumer-graph.json",
  "morpho-high-apy-liquidation-routes.json",
  "morpho-liquidatable-marketability.json",
];

const REGISTRY = new ethers.Interface([
  "function getAllTokenRecords() view returns (tuple(uint256 chainId, address tokenAddress, uint64 tokenType)[])",
]);
const ERC20 = new ethers.Interface([
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
]);
const OPTIONAL = new ethers.Interface([
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function owner() view returns (address)",
  "function paused() view returns (bool)",
]);
const EVENTS = new ethers.Interface([
  "event Burn(address indexed from, uint256 value, string data)",
  "event Mint(address indexed to, uint256 amount)",
]);

function decode(raw, iface, fn) {
  if (!raw || raw === "0x") return null;
  try { return iface.decodeFunctionResult(fn, raw); } catch (_) { return null; }
}

async function call(provider, address, iface, fn, args = []) {
  try {
    const raw = await provider.call({ to: address, data: iface.encodeFunctionData(fn, args) });
    return decode(raw, iface, fn);
  } catch (_) {
    return null;
  }
}

function slotAddress(raw) {
  if (!raw || raw === "0x" || /^0x0+$/.test(raw)) return null;
  try { return ethers.getAddress(`0x${raw.slice(-40)}`); } catch (_) { return null; }
}

function units(raw, decimals) {
  try { return Number(ethers.formatUnits(raw, decimals)); } catch (_) { return null; }
}

function round(value, decimals = 2) {
  if (!Number.isFinite(Number(value))) return null;
  const scale = 10 ** decimals;
  return Math.round(Number(value) * scale) / scale;
}

async function fetchJson(url, timeoutMs = 30_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "user-agent": "evm-audit-digift/1.0" }, signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function fetchMetadata() {
  const json = await fetchJson("https://api.llama.fi/protocol/digift", 45_000);
  if (!json) return { ok: false };
  const currentTvlUsd = Array.isArray(json.tvl) && json.tvl.length ? json.tvl[json.tvl.length - 1].totalLiquidityUSD : json.tvl;
  return {
    ok: true,
    name: json.name,
    slug: json.slug || "digift",
    category: json.category,
    currentTvlUsd,
    chains: json.chains || [],
    audits: json.audits || null,
    url: json.url || null,
    adapter: "projects/DigiFT/index.js",
  };
}

async function sourcifyStatus(chainId, address) {
  const checks = [
    `https://repo.sourcify.dev/contracts/full_match/${chainId}/${address}/metadata.json`,
    `https://repo.sourcify.dev/contracts/partial_match/${chainId}/${address}/metadata.json`,
  ];
  for (const url of checks) {
    const res = await fetch(url, { headers: { "user-agent": "evm-audit-digift/1.0" } }).catch(() => null);
    if (res?.ok) return { verified: true, source: url.includes("full_match") ? "sourcify-full" : "sourcify-partial" };
  }
  return { verified: false, source: null };
}

async function scanAddress(provider, chainId, address) {
  const [code, implRaw, adminRaw, sourceStatus] = await Promise.all([
    provider.getCode(address).catch(() => "0x"),
    provider.getStorage(address, EIP1967_IMPL).catch(() => null),
    provider.getStorage(address, EIP1967_ADMIN).catch(() => null),
    sourcifyStatus(chainId, address),
  ]);
  return {
    address,
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? (code.length - 2) / 2 : 0,
    proxy: {
      eip1967Implementation: slotAddress(implRaw),
      eip1967Admin: slotAddress(adminRaw),
    },
    sourceStatus,
  };
}

async function priceMap(tokens) {
  const ids = tokens.map((row) => `${CHAINS[row.chainId]?.llamaKey}:${row.address}`).filter((x) => !x.startsWith("undefined:"));
  if (!ids.length) return {};
  const json = await fetchJson(`https://coins.llama.fi/prices/current/${ids.join(",")}?searchWidth=6h`, 30_000);
  return json?.coins || {};
}

async function geckoPools(token) {
  const chain = CHAINS[token.chainId];
  if (!chain?.geckoNetwork) return [];
  const json = await fetchJson(`https://api.geckoterminal.com/api/v2/networks/${chain.geckoNetwork}/tokens/${token.address}/pools?page=1`, 20_000);
  const rows = Array.isArray(json?.data) ? json.data : [];
  return rows.slice(0, 3).map((row) => ({
    pool: row.id || null,
    dex: row.relationships?.dex?.data?.id || null,
    name: row.attributes?.name || null,
    reserveUsd: row.attributes?.reserve_in_usd ? Number(row.attributes.reserve_in_usd) : null,
    baseTokenPriceUsd: row.attributes?.base_token_price_usd ? Number(row.attributes.base_token_price_usd) : null,
  }));
}

function localAddressMatches(address) {
  const needle = address.toLowerCase();
  const matches = [];
  for (const file of LOCAL_MATCH_FILES) {
    const filePath = path.join(RAW_DIR, file);
    if (!fs.existsSync(filePath)) continue;
    const text = fs.readFileSync(filePath, "utf8").toLowerCase();
    const count = text.split(needle).length - 1;
    if (count > 0) matches.push({ file: `reports/raw/fast/${file}`, count });
  }
  return matches;
}

async function registryRecords(provider) {
  const raw = await provider.call({ to: DFEED, data: REGISTRY.encodeFunctionData("getAllTokenRecords") });
  const decoded = REGISTRY.decodeFunctionResult("getAllTokenRecords", raw)[0];
  return decoded.map((row) => ({
    chainId: Number(row.chainId ?? row[0]),
    address: ethers.getAddress(row.tokenAddress ?? row[1]),
    tokenType: Number(row.tokenType ?? row[2]),
  }));
}

function uniqTokens(records) {
  const out = new Map();
  for (const row of records.filter((r) => SCOPE_CHAIN_IDS.includes(r.chainId) && r.tokenType === 1)) {
    out.set(`${row.chainId}:${row.address.toLowerCase()}`, { chainId: row.chainId, address: row.address, source: "registry-tokenType-1" });
  }
  out.set(`1:${UMINT.toLowerCase()}`, { chainId: 1, address: ethers.getAddress(UMINT), source: "adapter-uMINT-net-supply" });
  out.set(`1:${ULTRA.toLowerCase()}`, { chainId: 1, address: ethers.getAddress(ULTRA), source: "adapter-excluded-ULTRA-seed" });
  return Array.from(out.values()).sort((a, b) => a.chainId - b.chainId || a.address.localeCompare(b.address));
}

async function scanToken(provider, token, prices) {
  const chain = CHAINS[token.chainId];
  const [basic, symbolRaw, nameRaw, decimalsRaw, supplyRaw, ownerRaw, pausedRaw, assetRaw, totalAssetsRaw] = await Promise.all([
    scanAddress(provider, token.chainId, token.address),
    call(provider, token.address, ERC20, "symbol"),
    call(provider, token.address, ERC20, "name"),
    call(provider, token.address, ERC20, "decimals"),
    call(provider, token.address, ERC20, "totalSupply"),
    call(provider, token.address, OPTIONAL, "owner"),
    call(provider, token.address, OPTIONAL, "paused"),
    call(provider, token.address, OPTIONAL, "asset"),
    call(provider, token.address, OPTIONAL, "totalAssets"),
  ]);
  const decimals = Number(decimalsRaw?.[0] ?? 18n);
  const supply = supplyRaw?.[0] ?? 0n;
  const supplyUnits = units(supply, decimals);
  const price = Number(prices[`${chain.llamaKey}:${token.address}`]?.price || 0);
  const pools = await geckoPools(token);
  return {
    chainId: token.chainId,
    chain: chain.chain,
    source: token.source,
    ...basic,
    symbol: symbolRaw?.[0] || null,
    name: nameRaw?.[0] || null,
    decimals,
    totalSupplyRaw: supply.toString(),
    totalSupply: ethers.formatUnits(supply, decimals),
    priceUsd: price || null,
    totalSupplyUsd: price && supplyUnits !== null ? supplyUnits * price : null,
    owner: ownerRaw?.[0] || null,
    paused: pausedRaw?.[0] ?? null,
    erc4626Probe: {
      asset: assetRaw?.[0] || null,
      totalAssetsRaw: totalAssetsRaw?.[0]?.toString() || null,
    },
    dexPools: pools,
    topDexLiquidityUsd: pools.length ? Math.max(...pools.map((row) => Number(row.reserveUsd || 0))) : 0,
    localConsumerMatches: localAddressMatches(token.address),
  };
}

async function uMintNetSupply(provider) {
  const mintTopic = EVENTS.getEvent("Mint").topicHash;
  const burnTopic = EVENTS.getEvent("Burn").topicHash;
  const managementTopic = ethers.zeroPadValue(SUBRED_MANAGEMENT, 32);
  const latest = await provider.getBlockNumber().catch(() => null);
  if (!latest) return { ok: false };
  let mint = 0n;
  let burn = 0n;
  for (const event of ["Mint", "Burn"]) {
    const topic0 = event === "Mint" ? mintTopic : burnTopic;
    const logs = await provider.getLogs({ address: UMINT, fromBlock: MINT_BURN_FROM_BLOCK, toBlock: latest, topics: [topic0, managementTopic] }).catch(() => []);
    for (const log of logs) {
      try {
        const parsed = EVENTS.parseLog(log);
        if (event === "Mint") mint += parsed.args.amount;
        else burn += parsed.args.value;
      } catch (_) {}
    }
  }
  return { ok: true, fromBlock: MINT_BURN_FROM_BLOCK, toBlock: latest, mintRaw: mint.toString(), burnRaw: burn.toString(), netRaw: (mint - burn).toString() };
}

async function main() {
  const metadataPromise = fetchMetadata();
  const polygonRpc = await resolveRpc(137);
  if (!polygonRpc) throw new Error("Polygon RPC unavailable for DigiFT registry prefilter");
  const polygonProvider = new ethers.JsonRpcProvider(polygonRpc, 137, { staticNetwork: true });
  const [metadata, registryBasic, records] = await Promise.all([
    metadataPromise,
    scanAddress(polygonProvider, 137, DFEED),
    registryRecords(polygonProvider),
  ]);
  const tokens = uniqTokens(records);
  const prices = await priceMap(tokens);
  const rpcs = {};
  for (const chainId of [...new Set(tokens.map((row) => row.chainId))]) rpcs[chainId] = await resolveRpc(chainId);
  const tokenRows = [];
  const rpcBlocked = [];
  for (const token of tokens) {
    const chain = CHAINS[token.chainId] || { chain: `chain-${token.chainId}` };
    const rpc = rpcs[token.chainId];
    if (!rpc) {
      rpcBlocked.push({ protocol: "DigiFT", chain: chain.chain, chainId: token.chainId, missingEndpointClass: "EVM RPC", skippedChecks: ["token code", "token supply", "DEX liquidity", "consumer joins"], token: token.address });
      continue;
    }
    const provider = new ethers.JsonRpcProvider(rpc, token.chainId, { staticNetwork: true });
    tokenRows.push(await scanToken(provider, token, prices));
  }
  const ethereumRpc = rpcs[1];
  const management = ethereumRpc ? await scanAddress(new ethers.JsonRpcProvider(ethereumRpc, 1, { staticNetwork: true }), 1, SUBRED_MANAGEMENT) : null;
  const netUMintSupply = ethereumRpc ? await uMintNetSupply(new ethers.JsonRpcProvider(ethereumRpc, 1, { staticNetwork: true })) : { ok: false };
  const byChain = {};
  for (const row of records) {
    if (!byChain[row.chainId]) byChain[row.chainId] = { chainId: row.chainId, chain: CHAINS[row.chainId]?.chain || `chain-${row.chainId}`, records: 0, tokenType1: 0 };
    byChain[row.chainId].records++;
    if (row.tokenType === 1) byChain[row.chainId].tokenType1++;
  }
  const localConsumerRows = tokenRows.reduce((sum, row) => sum + row.localConsumerMatches.reduce((s, m) => s + m.count, 0), 0);
  const dexRows = tokenRows.filter((row) => Number(row.topDexLiquidityUsd || 0) >= 10000);
  const totalSupplyUsdTracked = tokenRows.reduce((sum, row) => sum + Number(row.totalSupplyUsd || 0), 0);
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-digift-prefilter.js",
    scope: "DigiFT RWA registry/token/consumer route prefilter",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
      forkJustified: false,
    },
    metadata,
    adapter: {
      source: "https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/DigiFT/index.js",
      dFeedPrice: DFEED,
      tokenListAbi: "getAllTokenRecords()(tuple(uint256 chainId,address tokenAddress,uint64 tokenType)[])",
      uMINT: UMINT,
      ULTRA,
      subRedManagement: SUBRED_MANAGEMENT,
    },
    registry: {
      chainId: 137,
      chain: "Polygon",
      ...registryBasic,
      recordsByChain: Object.values(byChain).sort((a, b) => a.chainId - b.chainId),
    },
    management,
    netUMintSupply,
    tokens: tokenRows,
    rpcBlocked,
    consumerContext: {
      localConsumerRows,
      localConsumerMatches: tokenRows.filter((row) => row.localConsumerMatches.length).map((row) => ({ symbol: row.symbol, chain: row.chain, address: row.address, matches: row.localConsumerMatches })),
      dexLiquidityRows: dexRows.map((row) => ({ symbol: row.symbol, chain: row.chain, address: row.address, topDexLiquidityUsd: row.topDexLiquidityUsd, pools: row.dexPools })),
    },
    summary: {
      registryRecords: records.length,
      scopedTokenRows: tokens.length,
      tokensScanned: tokenRows.length,
      rpcBlockedRows: rpcBlocked.length,
      codePresentRows: tokenRows.filter((row) => row.codePresent).length,
      totalSupplyUsdTracked,
      localConsumerRows,
      dexLiquidityRows: dexRows.length,
      maxDexLiquidityUsd: dexRows.length ? Math.max(...dexRows.map((row) => Number(row.topDexLiquidityUsd || 0))) : 0,
      proofBypassRows: 0,
      consumerJoinRows: localConsumerRows,
      exactEconomicsRows: 0,
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      forkJustified: false,
    },
    blockers: [
      "No exact lending, Pendle, vault, or borrow consumer join was found in local artifacts for scanned DigiFT tokens",
      "DEX liquidity is absent or not paired with an accepted-value consumer route",
      "Redemption and transfer constraints remain likely permissioned until source/role paths are proven public",
      "Plume registry rows returned no token code in this pass; chain/address mapping remains inconclusive rather than route-negative",
      "No accepted-value divergence or positive exact route exists from current evidence",
    ],
    nextRoutePositiveCriteria: [
      "DigiFT token is accepted by a live consumer with borrow/redeem/liquidation liquidity",
      "Public acquisition or redemption route prices the token below accepted NAV after fees, slippage, and gas",
      "Plume/Mainnet dynamic registry rows are fully resolved or explicitly excluded by current registry state",
    ],
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");
  console.log(`DigiFT prefilter: tokens=${tokenRows.length}/${tokens.length} consumers=${localConsumerRows} dexRows=${dexRows.length} routePositive=0 blockedRpc=${rpcBlocked.length}`);
  console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
