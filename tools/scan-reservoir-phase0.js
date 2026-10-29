#!/usr/bin/env node
// Read-only Reservoir Protocol Phase 0 scanner.
// RPC URLs are resolved from local inventory in memory only and never printed or stored.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpc, rpcCall, getImpl } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "reservoir-phase0.json");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");

const CHAIN_ID = 1;
const TIMEOUT_MS = 12_000;
const ROUTE_LIQUIDITY_USD = Number(process.env.RESERVOIR_ROUTE_LIQUIDITY_USD || "10000");
const PREMIUM_WATCH_BPS = Number(process.env.RESERVOIR_PREMIUM_WATCH_BPS || "20");
const MAX_LOCAL_FILES = Number(process.env.RESERVOIR_MAX_LOCAL_FILES || "260");

const ADDRS = {
  usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  usdt: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  rUsd: "0x09D4214C03D01F49544C0448DBE3A27f768F2b34",
  srUsd: "0x738d1115B90efa71AE468F1287fc864775e23a31",
  wsrUsd: "0xd3fD63209FA2D55B07A0f6db36C2f43900be3094",
  psmUsdc: "0x4809010926aec940b550D34a46A52739f996D75D",
  psmUsdt: "0xeaE91B4C84e1EDfA5d78dcae40962C7655A549B9",
  creditEnforcer: "0x04716DB62C085D9e08050fcF6F7D775A03d07720",
  termIssuer: "0x128D86A9e854a709Df06b884f81EeE7240F6cCf7",
  cowSettlement: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
  cowVaultRelayer: "0xC92E8bdf79f0507f65a392b0ab4667716BFE0110",
};

const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
]);

const ERC4626 = new ethers.Interface([
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function previewRedeem(uint256 shares) view returns (uint256)",
]);

const PROBE_ABIS = {
  assetAdapterListAt: new ethers.Interface(["function assetAdapterList(uint256) view returns (address)"]),
  collateralAdapterListAt: new ethers.Interface(["function collateralAdapterList(uint256) view returns (address)"]),
  assetAdaptersArray: new ethers.Interface(["function getAssetAdapters() view returns (address[])"]),
  assetAdapterListArray: new ethers.Interface(["function getAssetAdapterList() view returns (address[])"]),
  assetAdapterCount: new ethers.Interface(["function assetAdapterCount() view returns (uint256)"]),
  adapterForAsset: new ethers.Interface(["function assetAdapters(address) view returns (address)"]),
  collateralAdapterForAsset: new ethers.Interface(["function collateralAdapters(address) view returns (address)"]),
  psmAsset: new ethers.Interface(["function asset() view returns (address)"]),
  psmStablecoin: new ethers.Interface(["function stablecoin() view returns (address)"]),
  psmUnderlying: new ethers.Interface(["function underlying() view returns (address)"]),
  psmCreditEnforcer: new ethers.Interface(["function creditEnforcer() view returns (address)"]),
  paused: new ethers.Interface(["function paused() view returns (bool)"]),
};

const KNOWN_TOKENS = [ADDRS.usdc, ADDRS.usdt, ADDRS.rUsd, ADDRS.srUsd, ADDRS.wsrUsd];

function lower(addr) {
  return String(addr || "").toLowerCase();
}

function round(value, decimals = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function formatUnits(value, decimals) {
  if (value === null || value === undefined) return null;
  try {
    return Number(ethers.formatUnits(value, Number(decimals || 18)));
  } catch (_) {
    return null;
  }
}

async function call(rpc, to, iface, fragment, args = []) {
  try {
    const data = iface.encodeFunctionData(fragment, args);
    const result = await rpcCall(rpc, "eth_call", [{ to, data }, "latest"], TIMEOUT_MS);
    if (!result || result === "0x") return null;
    return iface.decodeFunctionResult(fragment, result);
  } catch (_) {
    return null;
  }
}

async function getCodePresent(rpc, address) {
  const code = await rpcCall(rpc, "eth_getCode", [address, "latest"], TIMEOUT_MS);
  return Boolean(code && code !== "0x");
}

async function erc20State(rpc, label, address, prices = {}) {
  const [codePresent, decimalsRaw, symbolRaw, nameRaw, supplyRaw] = await Promise.all([
    getCodePresent(rpc, address),
    call(rpc, address, ERC20, "decimals"),
    call(rpc, address, ERC20, "symbol"),
    call(rpc, address, ERC20, "name"),
    call(rpc, address, ERC20, "totalSupply"),
  ]);
  const decimals = decimalsRaw ? Number(decimalsRaw[0]) : null;
  const totalSupply = supplyRaw && decimals !== null ? formatUnits(supplyRaw[0], decimals) : null;
  const priceUsd = prices[lower(address)] ?? null;
  return {
    label,
    address,
    codePresent,
    symbol: symbolRaw ? String(symbolRaw[0]) : null,
    name: nameRaw ? String(nameRaw[0]) : null,
    decimals,
    totalSupply,
    priceUsd,
    totalSupplyUsd: totalSupply !== null && priceUsd !== null ? round(totalSupply * priceUsd, 2) : null,
  };
}

async function tokenBalance(rpc, token, holder, decimals) {
  const raw = await call(rpc, token, ERC20, "balanceOf", [holder]);
  return raw && decimals !== null ? formatUnits(raw[0], decimals) : null;
}

async function vaultState(rpc, label, address, tokenMeta) {
  const meta = tokenMeta.find((row) => lower(row.address) === lower(address));
  const decimals = meta?.decimals ?? 18;
  const oneShare = 10n ** BigInt(decimals);
  const [assetRaw, totalAssetsRaw, convertRaw, previewRaw] = await Promise.all([
    call(rpc, address, ERC4626, "asset"),
    call(rpc, address, ERC4626, "totalAssets"),
    call(rpc, address, ERC4626, "convertToAssets", [oneShare]),
    call(rpc, address, ERC4626, "previewRedeem", [oneShare]),
  ]);
  const asset = assetRaw ? String(assetRaw[0]) : null;
  const assetMeta = tokenMeta.find((row) => lower(row.address) === lower(asset));
  const assetDecimals = assetMeta?.decimals ?? 18;
  const assetPriceUsd = assetMeta?.priceUsd ?? null;
  const totalAssets = totalAssetsRaw ? formatUnits(totalAssetsRaw[0], assetDecimals) : null;
  const convertOneShareToAssets = convertRaw ? formatUnits(convertRaw[0], assetDecimals) : null;
  const previewRedeemOneShare = previewRaw ? formatUnits(previewRaw[0], assetDecimals) : null;
  return {
    label,
    address,
    asset,
    assetSymbol: assetMeta?.symbol || null,
    totalAssets,
    totalAssetsUsd: totalAssets !== null && assetPriceUsd !== null ? round(totalAssets * assetPriceUsd, 2) : null,
    convertOneShareToAssets,
    previewRedeemOneShare,
  };
}

async function fetchJson(url, timeoutMs = 20_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "user-agent": "reservoir-phase0-scanner/1.0" } });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function fetchPrices() {
  const coins = [ADDRS.usdc, ADDRS.usdt, ADDRS.rUsd, ADDRS.srUsd, ADDRS.wsrUsd]
    .map((addr) => `ethereum:${addr}`)
    .join(",");
  const json = await fetchJson(`https://coins.llama.fi/prices/current/${coins}`);
  const out = {};
  for (const [key, row] of Object.entries(json?.coins || {})) {
    const addr = key.split(":")[1];
    if (addr && Number.isFinite(Number(row.price))) out[lower(addr)] = Number(row.price);
  }
  return out;
}

async function fetchDex(address) {
  const json = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
  const pairs = Array.isArray(json?.pairs) ? json.pairs : [];
  const rows = pairs
    .map((row) => ({
      chainId: row.chainId || null,
      dexId: row.dexId || null,
      pairAddress: row.pairAddress || null,
      baseSymbol: row.baseToken?.symbol || null,
      quoteSymbol: row.quoteToken?.symbol || null,
      priceUsd: Number(row.priceUsd),
      liquidityUsd: Number(row.liquidity?.usd),
      volume24hUsd: Number(row.volume?.h24),
    }))
    .filter((row) => Number.isFinite(row.liquidityUsd))
    .sort((a, b) => b.liquidityUsd - a.liquidityUsd);
  const top = rows[0] || null;
  return {
    token: address,
    pairCount: rows.length,
    topLiquidityUsd: top ? round(top.liquidityUsd, 2) : 0,
    topPriceUsd: top && Number.isFinite(top.priceUsd) ? top.priceUsd : null,
    topPair: top ? { chainId: top.chainId, dexId: top.dexId, pairAddress: top.pairAddress, baseSymbol: top.baseSymbol, quoteSymbol: top.quoteSymbol } : null,
    topPairs: rows.slice(0, 5).map((row) => ({
      chainId: row.chainId,
      dexId: row.dexId,
      pairAddress: row.pairAddress,
      baseSymbol: row.baseSymbol,
      quoteSymbol: row.quoteSymbol,
      priceUsd: Number.isFinite(row.priceUsd) ? row.priceUsd : null,
      liquidityUsd: round(row.liquidityUsd, 2),
      volume24hUsd: Number.isFinite(row.volume24hUsd) ? round(row.volume24hUsd, 2) : null,
    })),
  };
}

async function probeAddressArray(rpc, target, iface, fragment, label) {
  const rows = [];
  for (let i = 0; i < 32; i++) {
    const decoded = await call(rpc, target, iface, fragment, [i]);
    if (!decoded) break;
    const addr = String(decoded[0]);
    if (addr === ethers.ZeroAddress) break;
    rows.push({ source: label, index: i, address: addr });
  }
  return rows;
}

async function probeArrayReturn(rpc, target, iface, fragment, label) {
  const decoded = await call(rpc, target, iface, fragment);
  if (!decoded || !Array.isArray(decoded[0])) return [];
  return decoded[0].filter((addr) => addr && addr !== ethers.ZeroAddress).map((addr, index) => ({ source: label, index, address: String(addr) }));
}

async function probeAdapterForAssets(rpc, target) {
  const rows = [];
  for (const token of KNOWN_TOKENS) {
    for (const [source, iface] of [["assetAdapters(address)", PROBE_ABIS.adapterForAsset], ["collateralAdapters(address)", PROBE_ABIS.collateralAdapterForAsset]]) {
      const decoded = await call(rpc, target, iface, source.split("(")[0], [token]);
      if (!decoded) continue;
      const adapter = String(decoded[0]);
      if (adapter && adapter !== ethers.ZeroAddress) rows.push({ source, asset: token, address: adapter });
    }
  }
  return rows;
}

async function adapterProbes(rpc) {
  const target = ADDRS.creditEnforcer;
  const [assetList, collateralList, getAssetAdapters, getAssetAdapterList, assetForTokens] = await Promise.all([
    probeAddressArray(rpc, target, PROBE_ABIS.assetAdapterListAt, "assetAdapterList", "assetAdapterList(uint256)"),
    probeAddressArray(rpc, target, PROBE_ABIS.collateralAdapterListAt, "collateralAdapterList", "collateralAdapterList(uint256)"),
    probeArrayReturn(rpc, target, PROBE_ABIS.assetAdaptersArray, "getAssetAdapters", "getAssetAdapters()"),
    probeArrayReturn(rpc, target, PROBE_ABIS.assetAdapterListArray, "getAssetAdapterList", "getAssetAdapterList()"),
    probeAdapterForAssets(rpc, target),
  ]);
  const count = await call(rpc, target, PROBE_ABIS.assetAdapterCount, "assetAdapterCount");
  const rows = [...assetList, ...collateralList, ...getAssetAdapters, ...getAssetAdapterList, ...assetForTokens];
  const seen = new Set();
  const unique = [];
  for (const row of rows) {
    const key = `${lower(row.address)}:${lower(row.asset || "")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
  }
  return {
    assetAdapterCount: count ? Number(count[0]) : null,
    adapterRows: unique,
    successfulProbeRows: rows.length,
  };
}

async function psmState(rpc, label, address, tokenMeta) {
  const impl = await getImpl(rpc, address).catch(() => null);
  const codePresent = await getCodePresent(rpc, address);
  const balances = [];
  for (const token of tokenMeta) {
    if (!token.decimals) continue;
    const bal = await tokenBalance(rpc, token.address, address, token.decimals);
    if (bal && bal > 0) balances.push({ token: token.symbol || token.label, address: token.address, balance: bal, balanceUsd: token.priceUsd ? round(bal * token.priceUsd, 2) : null });
  }
  const probes = {};
  for (const [field, iface] of [["asset", PROBE_ABIS.psmAsset], ["stablecoin", PROBE_ABIS.psmStablecoin], ["underlying", PROBE_ABIS.psmUnderlying], ["creditEnforcer", PROBE_ABIS.psmCreditEnforcer], ["paused", PROBE_ABIS.paused]]) {
    const decoded = await call(rpc, address, iface, field);
    if (decoded) probes[field] = typeof decoded[0] === "boolean" ? decoded[0] : String(decoded[0]);
  }
  return { label, address, codePresent, implementation: impl, probes, balances };
}

function scanLocalArtifactJoins() {
  const wanted = Object.entries(ADDRS).map(([label, address]) => ({ label, address, lower: lower(address) }));
  const rows = [];
  let filesScanned = 0;
  for (const name of fs.readdirSync(RAW_DIR).filter((n) => n.endsWith(".json")).slice(0, MAX_LOCAL_FILES)) {
    const file = path.join(RAW_DIR, name);
    if (file === OUT) continue;
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8").toLowerCase();
    } catch (_) {
      continue;
    }
    filesScanned++;
    for (const item of wanted) {
      if (text.includes(item.lower)) rows.push({ artifact: `reports/raw/fast/${name}`, label: item.label, address: item.address });
    }
  }
  const reservoirSpecific = rows.filter((row) => !["usdc", "usdt"].includes(row.label));
  return { filesScanned, joinRows: reservoirSpecific.slice(0, 120), totalJoinRows: reservoirSpecific.length, commonTokenJoinRows: rows.length - reservoirSpecific.length };
}

function classify({ adapterRows, dexRows, tokenRows }) {
  const rUsdDex = dexRows.find((row) => lower(row.token) === lower(ADDRS.rUsd));
  const rUsdPrice = rUsdDex?.topPriceUsd ?? tokenRows.find((row) => lower(row.address) === lower(ADDRS.rUsd))?.priceUsd ?? null;
  const rUsdPremiumBps = rUsdPrice === null ? null : (rUsdPrice - 1) * 10_000;
  const rUsdPremiumWatch = rUsdPremiumBps !== null && rUsdPremiumBps >= PREMIUM_WATCH_BPS && (rUsdDex?.topLiquidityUsd || 0) >= ROUTE_LIQUIDITY_USD;
  const adapterWatch = adapterRows.length > 0;
  const watchCandidates = Number(rUsdPremiumWatch) + Number(adapterWatch);
  return {
    rUsdPriceUsd: rUsdPrice,
    rUsdPremiumBps: round(rUsdPremiumBps, 4),
    rUsdTopLiquidityUsd: rUsdDex?.topLiquidityUsd || 0,
    rUsdPremiumWatch,
    adapterWatch,
    watchCandidates,
    routePositive: 0,
    blockers: [
      adapterWatch ? "Credit Enforcer adapter rows need source decode, current collateral economics, and fork proof" : "No active Credit Enforcer vault/asset adapter row was resolved by bounded probes",
      rUsdPremiumWatch ? "rUSD premium needs exact DEX quote, staticCall, gas, and unwind proof" : "No rUSD premium plus DEX liquidity above watch threshold",
      "PSM mint/redeem and DEX unwind are not exact-quoted positive in this Phase 0 artifact",
      "No fork extraction proof",
    ],
  };
}

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const rpc = await resolveRpc(CHAIN_ID);
  const blockHex = rpc ? await rpcCall(rpc, "eth_blockNumber", [], TIMEOUT_MS) : null;
  const prices = await fetchPrices();
  const tokenRows = rpc ? await Promise.all(Object.entries(ADDRS)
    .filter(([label]) => ["usdc", "usdt", "rUsd", "srUsd", "wsrUsd"].includes(label))
    .map(([label, address]) => erc20State(rpc, label, address, prices))) : [];
  const [srUsdVault, wsrUsdVault] = rpc ? await Promise.all([
    vaultState(rpc, "srUsd", ADDRS.srUsd, tokenRows),
    vaultState(rpc, "wsrUsd", ADDRS.wsrUsd, tokenRows),
  ]) : [null, null];
  const [psmUsdc, psmUsdt, adapterScan, codeRows, dexRows] = await Promise.all([
    rpc ? psmState(rpc, "psmUsdc", ADDRS.psmUsdc, tokenRows) : null,
    rpc ? psmState(rpc, "psmUsdt", ADDRS.psmUsdt, tokenRows) : null,
    rpc ? adapterProbes(rpc) : { assetAdapterCount: null, adapterRows: [], successfulProbeRows: 0 },
    rpc ? Promise.all(Object.entries(ADDRS).map(async ([label, address]) => ({ label, address, codePresent: await getCodePresent(rpc, address), implementation: await getImpl(rpc, address).catch(() => null) }))) : [],
    Promise.all([ADDRS.rUsd, ADDRS.srUsd, ADDRS.wsrUsd].map(fetchDex)),
  ]);
  const localJoins = scanLocalArtifactJoins();
  const classification = classify({ adapterRows: adapterScan.adapterRows, dexRows, tokenRows });
  const psmBackingUsd = [psmUsdc, psmUsdt].flatMap((row) => row?.balances || []).reduce((sum, row) => sum + Number(row.balanceUsd || 0), 0);

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-reservoir-phase0.js",
    scope: "Reservoir Protocol rUSD/srUSD/wsrUSD, PSM, Credit Enforcer adapter, DEX premium, and local consumer-join Phase 0",
    safety: {
      rpcInventoryRead: Boolean(rpc),
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: classification.routePositive > 0,
      signedActionJustified: false,
    },
    thresholds: {
      routeLiquidityUsd: ROUTE_LIQUIDITY_USD,
      premiumWatchBps: PREMIUM_WATCH_BPS,
      maxLocalFiles: MAX_LOCAL_FILES,
    },
    chain: { chainId: CHAIN_ID, name: "Ethereum", rpcResolved: Boolean(rpc), blockNumber: blockHex ? Number.parseInt(blockHex, 16) : null },
    deployments: codeRows,
    tokenRows,
    vaultRows: [srUsdVault, wsrUsdVault].filter(Boolean),
    psmRows: [psmUsdc, psmUsdt].filter(Boolean),
    creditEnforcer: adapterScan,
    dexRows,
    localArtifactJoins: localJoins,
    summary: {
      contractsScanned: codeRows.length,
      contractsWithCode: codeRows.filter((row) => row.codePresent).length,
      tokenRows: tokenRows.length,
      vaultRows: [srUsdVault, wsrUsdVault].filter(Boolean).length,
      psmRows: [psmUsdc, psmUsdt].filter(Boolean).length,
      psmBackingUsd: round(psmBackingUsd, 2),
      rUsdSupplyUsd: tokenRows.find((row) => lower(row.address) === lower(ADDRS.rUsd))?.totalSupplyUsd ?? null,
      rUsdPriceUsd: classification.rUsdPriceUsd,
      rUsdPremiumBps: classification.rUsdPremiumBps,
      rUsdTopLiquidityUsd: classification.rUsdTopLiquidityUsd,
      assetAdapterRows: adapterScan.adapterRows.length,
      successfulAdapterProbeRows: adapterScan.successfulProbeRows,
      localArtifactJoinRows: localJoins.totalJoinRows,
      commonTokenJoinRows: localJoins.commonTokenJoinRows,
      localFilesScanned: localJoins.filesScanned,
      reviewCandidates: localJoins.totalJoinRows,
      watchCandidates: classification.watchCandidates,
      routePositive: classification.routePositive,
      signedActionJustified: false,
      coverageClassification: "bounded-with-caveats",
      coverageCaveat: "Ethereum live deployment and bounded local artifact joins only; non-Ethereum public TVL chains are not exhaustively scanned in this Phase 0 pass",
    },
    blockers: classification.blockers,
    nextRoutePositiveCriteria: [
      "Credit Enforcer has an active asset/vault adapter with public mint/borrow/redeem path and material liquidity",
      "rUSD/srUSD/wsrUSD accepted value, PSM mint/redeem value, or DEX market value diverges favorably after fees and slippage",
      "DEX/PSM route is exact-quoted with staticCall/estimateGas and positive net economics",
      "fork simulation extracts positive value without capital lock or delayed settlement",
    ],
  };
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");
  console.log(`Reservoir Phase0: code=${artifact.summary.contractsWithCode}/${artifact.summary.contractsScanned} adapters=${artifact.summary.assetAdapterRows} joins=${artifact.summary.localArtifactJoinRows} watch=${artifact.summary.watchCandidates} routePositive=${artifact.summary.routePositive}`);
  console.log(`Artifact: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
