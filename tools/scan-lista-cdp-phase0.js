#!/usr/bin/env node
// scan-lista-cdp-phase0.js - bounded read-only Phase 0 for Lista CDP / lisUSD on BNB Chain.
// Resolves RPC URLs in memory only. Never prints or stores RPC URLs, keys, calldata for execution, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "lista-cdp-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "lista-cdp-phase0-triage.md");
const PUBLIC_DISCOVERY = path.join(WORKSPACE, "reports", "raw", "fast", "public-audit-target-discovery.json");
const PRIOR_ORACLE = path.join(WORKSPACE, "reports", "raw", "fast", "lista-oracle-deep.json");
const PRIOR_DEX = path.join(WORKSPACE, "reports", "raw", "fast", "lista-dex-phase0.json");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const QUIET = process.argv.includes("--quiet");

const CHAIN_ID = 56;
const CHAIN = "BNB Chain";
const VAULT_LIST_URL = "https://api.lista.org/api/defiLlama/cdp-vault-list";
const LISUSD = "0x0782b6d8c4551B9760e74c0545a9bCD90bdc41E5";
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const ZERO = ethers.ZeroAddress;
const NATIVE_SENTINELS = new Set([ZERO.toLowerCase(), "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"]);
const MAX_ARTIFACT_JOINS = Number(process.env.LISTA_CDP_MAX_ARTIFACT_JOINS || "80");
const MIN_MATERIAL_BALANCE_USD = Number(process.env.LISTA_CDP_MIN_MATERIAL_BALANCE_USD || "10000");

const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function totalSupply() view returns (uint256)",
]);
const BYTES32_TOKEN = new ethers.Interface([
  "function symbol() view returns (bytes32)",
  "function name() view returns (bytes32)",
]);
const NOARG_ADDRESS_GETTERS = ["token", "asset", "collateralToken", "oracle", "priceFeed", "manager", "interaction", "vat", "spotter", "jug", "dog", "owner"];
const NOARG_UINT_GETTERS = ["live", "paused", "totalDebt", "debt", "totalCollateral", "totalDeposited", "collateralRate", "liquidationRatio", "minimumCollateralPercentage"];

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readJson(file, fallback = null) { try { if (!fs.existsSync(file)) return fallback; return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return fallback; } }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function normalizeAddress(value) { try { return ethers.getAddress(value); } catch (_) { return null; } }
function lowerAddress(value) { const a = normalizeAddress(value); return a ? a.toLowerCase() : null; }
function isNative(value) { return NATIVE_SENTINELS.has(String(value || "").toLowerCase()); }
function safeText(value, max = 180) { return String(value ?? "").replace(/https?:\/\/\S+/g, "[redacted-url]").replace(/\s+/g, " ").trim().slice(0, max); }
function rel(file) { return path.relative(WORKSPACE, file).replace(/\\/g, "/"); }
function round(value, decimals = 2) { const n = Number(value); if (!Number.isFinite(n)) return null; const f = 10 ** decimals; return Math.round(n * f) / f; }
function formatUsd(value) { const n = Number(value); return Number.isFinite(n) ? `$${Math.round(n).toLocaleString()}` : "n/a"; }
function formatPct(value) { const n = Number(value); return Number.isFinite(n) ? `${round(n * 100, 2)}%` : "n/a"; }

function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  const n = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function decimalsToNumber(value, decimals) {
  if (value === null || value === undefined || decimals === null || decimals === undefined) return null;
  try {
    const n = Number(ethers.formatUnits(BigInt(value), Number(decimals)));
    return Number.isFinite(n) ? n : null;
  } catch (_) { return null; }
}

function decodeBytes32String(value) { try { return ethers.decodeBytes32String(value); } catch (_) { return null; } }

async function fetchJson(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-lista-cdp-phase0/1.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    return { error: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
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

async function getNativeBalance(rpc, owner) {
  const addr = normalizeAddress(owner);
  if (!rpc || !addr) return null;
  const raw = await rpcCall(rpc, "eth_getBalance", [addr, "latest"], 10_000).catch(() => null);
  return raw ? BigInt(raw) : null;
}

async function tokenMeta(rpc, address, fallback = {}) {
  const native = isNative(address);
  if (native) return { address: ZERO, native: true, symbol: "BNB", name: "BNB", decimals: 18, codePresent: false, codeBytes: 0, totalSupplyRaw: null };
  const addr = normalizeAddress(address);
  if (!addr) return { address: null, native: false, symbol: fallback.symbol || null, name: fallback.name || null, decimals: fallback.decimals ?? null, codePresent: false, codeBytes: 0, totalSupplyRaw: null };
  const [code, dec, sym, sym32, name, name32, supply] = await Promise.all([
    getCode(rpc, addr),
    safeCall(rpc, addr, ERC20, "decimals"),
    safeCall(rpc, addr, ERC20, "symbol"),
    safeCall(rpc, addr, BYTES32_TOKEN, "symbol"),
    safeCall(rpc, addr, ERC20, "name"),
    safeCall(rpc, addr, BYTES32_TOKEN, "name"),
    safeCall(rpc, addr, ERC20, "totalSupply"),
  ]);
  return {
    address: addr,
    native: false,
    symbol: safeText(sym?.[0] || decodeBytes32String(sym32?.[0]) || fallback.symbol || "", 32) || null,
    name: safeText(name?.[0] || decodeBytes32String(name32?.[0]) || fallback.name || "", 80) || null,
    decimals: dec?.[0] === undefined ? fallback.decimals ?? null : Number(dec[0]),
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? code.replace(/^0x/, "").length / 2 : 0,
    totalSupplyRaw: supply?.[0] === undefined ? null : supply[0].toString(),
  };
}

async function balanceOf(rpc, token, owner) {
  if (isNative(token)) return getNativeBalance(rpc, owner);
  const raw = await safeCall(rpc, token, ERC20, "balanceOf", [normalizeAddress(owner)]);
  return raw?.[0] === undefined ? null : raw[0];
}

async function coinPrices(tokens) {
  const ids = [];
  for (const token of tokens) {
    if (isNative(token)) ids.push("coingecko:binancecoin");
    else {
      const addr = normalizeAddress(token);
      if (addr) ids.push(`bsc:${addr}`);
    }
  }
  if (!ids.length) return {};
  const chunks = [];
  for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));
  const prices = {};
  for (const chunk of chunks) {
    const url = `https://coins.llama.fi/prices/current/${chunk.join(",")}`;
    const json = await fetchJson(url, 20_000);
    for (const [id, row] of Object.entries(json?.coins || {})) prices[id.toLowerCase()] = asNumber(row?.price);
  }
  return prices;
}

function priceFor(prices, token, symbol) {
  if (isNative(token)) return prices["coingecko:binancecoin"] ?? null;
  const addr = normalizeAddress(token);
  const direct = addr ? prices[`bsc:${addr}`.toLowerCase()] : null;
  if (direct !== null && direct !== undefined) return direct;
  const s = String(symbol || "").toLowerCase();
  if (["usdt", "usdc", "busd", "dai", "lisusd", "usd1", "u"].includes(s)) return 1;
  return null;
}

function sourceTvlUsd() {
  const discovery = readJson(PUBLIC_DISCOVERY, {});
  const rows = [...(discovery?.phase0Queue || []), ...(discovery?.targetedRefreshQueue || []), ...(discovery?.consumerJoinFirst || [])];
  return asNumber(rows.find((r) => r?.slug === "lista-cdp")?.tvlUsd) || asNumber(discovery?.summary?.topPhase0TargetTvlUsd) || null;
}

async function selectorProbe(rpc, owner) {
  const target = normalizeAddress(owner);
  if (!target) return { addressGetters: {}, numericGetters: {} };
  const addressGetters = {};
  const numericGetters = {};
  for (const fn of NOARG_ADDRESS_GETTERS) {
    const iface = new ethers.Interface([`function ${fn}() view returns (address)`]);
    const out = await safeCall(rpc, target, iface, fn, [], 8_000);
    if (out?.[0] !== undefined && normalizeAddress(out[0])) addressGetters[fn] = normalizeAddress(out[0]);
  }
  for (const fn of NOARG_UINT_GETTERS) {
    for (const ret of ["uint256", "bool"]) {
      const iface = new ethers.Interface([`function ${fn}() view returns (${ret})`]);
      const out = await safeCall(rpc, target, iface, fn, [], 8_000);
      if (out?.[0] !== undefined) {
        numericGetters[fn] = typeof out[0] === "boolean" ? out[0] : out[0].toString();
        break;
      }
    }
  }
  return { addressGetters, numericGetters };
}

function loadPriorContext() {
  const oracle = readJson(PRIOR_ORACLE, {});
  const dex = readJson(PRIOR_DEX, {});
  const oracleRows = Object.entries(oracle?.results || {}).filter(([k]) => !k.startsWith("_")).map(([symbol, row]) => ({
    symbol,
    asset: row.asset || null,
    mainEqualsFallback: Boolean(row.mainEqualsFallback),
    pivotEnabled: Boolean(row.pivotEnabled),
    cascadeIssues: row.cascadeIssues || [],
    pivotAgeSeconds: row.pivotFeed?.age ?? null,
  }));
  const lisUsdPoolRows = (dex?.poolRows || []).filter((row) => String(row?.token0SymbolApi || row?.token0Meta?.symbol || "").toLowerCase() === "lisusd" || String(row?.token1SymbolApi || row?.token1Meta?.symbol || "").toLowerCase() === "lisusd");
  return {
    oracleGeneratedAt: oracle?.generatedAt || oracle?.scannedAt || null,
    dexGeneratedAt: dex?.generatedAt || null,
    oracleRows,
    dexSummary: dex?.summary || {},
    lisUsdPoolRows: lisUsdPoolRows.map((row) => ({
      chain: row.chainName || row.chain,
      chainId: row.chainId,
      swapPool: row.swapPool,
      pair: `${row.token0Meta?.symbol || row.token0SymbolApi || "?"}/${row.token1Meta?.symbol || row.token1SymbolApi || "?"}`,
      poolTvlUsd: row.poolTvlUsd ?? null,
      lisUsdPriceUsd: String(row.token0Meta?.symbol || row.token0SymbolApi || "").toLowerCase() === "lisusd" ? row.token0Meta?.priceUsd ?? null : row.token1Meta?.priceUsd ?? null,
      marketIds: row.marketIds || [],
    })),
  };
}

function artifactJoins(addresses) {
  const wanted = [...new Set(addresses.map((a) => lowerAddress(a)).filter(Boolean))];
  const rows = [];
  if (!wanted.length || !fs.existsSync(RAW_DIR)) return rows;
  const files = fs.readdirSync(RAW_DIR).filter((f) => f.endsWith(".json") && f !== path.basename(RAW_OUT));
  for (const file of files) {
    if (rows.length >= MAX_ARTIFACT_JOINS) break;
    const abs = path.join(RAW_DIR, file);
    let text = "";
    try { text = fs.readFileSync(abs, "utf8").toLowerCase(); } catch (_) { continue; }
    for (const addr of wanted) {
      if (!text.includes(addr)) continue;
      rows.push({ address: ethers.getAddress(addr), source: rel(abs), routePositiveContext: /"routepositive"\s*:\s*(true|1)/i.test(text), watchContext: /"watchcandidate|"watchcandidates"\s*:\s*[1-9]/i.test(text) });
      if (rows.length >= MAX_ARTIFACT_JOINS) break;
    }
  }
  return rows;
}

function buildReport(out) {
  const s = out.summary;
  const topBalances = out.balanceRows
    .filter((row) => (row.balanceUsd || 0) >= MIN_MATERIAL_BALANCE_USD)
    .sort((a, b) => (b.balanceUsd || 0) - (a.balanceUsd || 0))
    .slice(0, 10)
    .map((row) => `| ${row.symbol || "?"} | ${row.ownerShort} | ${formatUsd(row.balanceUsd)} | ${row.ownerCodePresent} | ${row.ownerImpl ? "yes" : "no"} |`)
    .join("\n") || "| none | n/a | n/a | n/a | n/a |";
  const probes = out.ownerRows.slice(0, 10).map((row) => `| ${row.ownerShort} | ${Object.keys(row.probes.addressGetters || {}).join(", ") || "none"} | ${Object.keys(row.probes.numericGetters || {}).join(", ") || "none"} |`).join("\n") || "| none | none | none |";
  const priorOracle = out.priorContext.oracleRows.map((row) => `| ${row.symbol} | ${row.mainEqualsFallback} | ${row.pivotEnabled} | ${(row.cascadeIssues || []).join("; ") || "none"} |`).join("\n") || "| none | false | false | none |";
  const lisPools = out.priorContext.lisUsdPoolRows.slice(0, 6).map((row) => `| ${row.chain} | ${row.pair} | ${formatUsd(row.poolTvlUsd)} | ${row.lisUsdPriceUsd === null || row.lisUsdPriceUsd === undefined ? "n/a" : `$${round(row.lisUsdPriceUsd, 6)}`} | ${row.marketIds.length} |`).join("\n") || "| none | none | n/a | n/a | 0 |";
  return `# 🟢 DORMANT — Lista CDP Phase 0 Triage

Generated: ${out.generatedAt}

Scanner: \`tools/scan-lista-cdp-phase0.js\`

## Result

No confirmed permissionless exploit. This pass maps the public Lista CDP vault-list, live BNB-chain token/owner balances, basic selector probes, lisUSD supply/peg context, and prior Lista Moolah/oracle artifacts. Current gates remain closed because no current CDP liquidation/redemption/borrow route has exact positive economics or fork proof.

## Summary

| Metric | Value |
|---|---:|
| DeFiLlama TVL | ${formatUsd(s.defillamaCurrentTvlUsd)} |
| Vault-list rows | \`${s.vaultListRows}\` |
| Unique owners | \`${s.uniqueOwners}\` |
| Owners with code | \`${s.ownersWithCode}\` |
| Unique collateral tokens | \`${s.uniqueTokens}\` |
| Material balance rows | \`${s.materialBalanceRows}\` |
| Tracked balance context | ${formatUsd(s.trackedBalanceUsd)} |
| lisUSD supply | \`${s.lisUsdSupplyUnits === null ? "n/a" : round(s.lisUsdSupplyUnits, 2).toLocaleString()}\` |
| lisUSD prior DEX liquidity | ${formatUsd(s.lisUsdPriorDexLiquidityUsd)} |
| Prior Lista DEX watch candidates | \`${s.priorListaDexWatchCandidates}\` |
| Prior oracle residual rows | \`${s.priorOracleResidualRows}\` |
| Artifact joins | \`${s.artifactJoinRows}\` |
| Watch candidates | \`${s.watchCandidates}\` |
| Route-positive | \`${s.routePositive}\` |
| Executable now | \`${s.executableNow}\` |
| Signed action justified | \`${s.signedActionJustified}\` |

## Material Vault Balances

| Token | Owner | Balance USD | Owner has code | Proxy impl |
|---|---:|---:|---:|---:|
${topBalances}

## Selector Probe Snapshot

| Owner | Address getters found | Numeric getters found |
|---|---|---|
${probes}

## Prior Lista Oracle Context

| Asset | Main equals fallback | Pivot enabled | Residual issue |
|---|---:|---:|---|
${priorOracle}

## Prior lisUSD/Moolah DEX Context

| Chain | Pair | Pool TVL | lisUSD price | Moolah market refs |
|---|---|---:|---:|---:|
${lisPools}

## Blockers

- Public CDP adapter exposes vault token/owner balances, not borrower-level vault health or liquidation queue state.
- Existing Lista oracle issue is timing-dependent; current pass does not prove stale-but-accepted or attacker-favorable accepted value.
- Prior Lista DEX/Moolah smart-lending rows are consumer joins only; no exact pool/provider manipulation plus borrow/exit economics are positive.
- No permissionless lisUSD redemption, liquidation, or CDP unwind path is exact-quoted positive after fees/gas/slippage.
- No fork extraction proof exists.

## Required For Route-Positive

- Specific Lista CDP position, vault, oracle, or lisUSD peg state must expose a permissionless value-changing trigger.
- Collateral acquisition/liquidation/redemption/borrow path must be live and unblocked.
- Borrowed, redeemed, or seized assets must have exact positive DEX/repay/unwind economics after costs.
- Fork extraction proof must show measured profit.

## Next Read-Only Step

Keep Lista CDP on lisUSD peg, vault-list, and oracle residual watch. Reopen for exact quoting only if a public borrower/position source appears, lisUSD depegs materially while CDP/Moolah still accepts par value, or the prior oracle collapse becomes stale-but-accepted with material borrow/liquidation liquidity.

Artifacts: \`reports/raw/fast/lista-cdp-phase0.json\`.
`;
}

async function main() {
  const rpc = await resolveRpc(CHAIN_ID);
  if (!rpc) throw new Error("No BNB Chain RPC available through sanitized resolver");
  const blockNumberHex = await rpcCall(rpc, "eth_blockNumber", [], 10_000);
  const blockNumber = blockNumberHex ? Number(BigInt(blockNumberHex)) : null;
  const vaultResp = await fetchJson(VAULT_LIST_URL, 30_000);
  const pairs = Array.isArray(vaultResp?.data) ? vaultResp.data : Array.isArray(vaultResp) ? vaultResp : [];
  const normalizedPairs = pairs.map((row) => ({ token: normalizeAddress(row?.[0]) || ZERO, owner: normalizeAddress(row?.[1]) })).filter((row) => row.owner);
  const tokens = [...new Set(normalizedPairs.map((row) => row.token))];
  const owners = [...new Set(normalizedPairs.map((row) => row.owner))];
  const prices = await coinPrices(tokens);
  const metaByToken = new Map();
  for (const token of tokens) metaByToken.set(lowerAddress(token) || ZERO.toLowerCase(), await tokenMeta(rpc, token));
  const ownerRows = [];
  for (const owner of owners) {
    const code = await getCode(rpc, owner);
    const implRaw = await rpcCall(rpc, "eth_getStorageAt", [owner, "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc", "latest"], 8_000).catch(() => null);
    const impl = implRaw && implRaw !== "0x" + "0".repeat(64) ? normalizeAddress("0x" + implRaw.slice(26)) : null;
    ownerRows.push({
      owner,
      ownerShort: `${owner.slice(0, 6)}...${owner.slice(-4)}`,
      codePresent: Boolean(code && code !== "0x"),
      codeBytes: code && code !== "0x" ? code.replace(/^0x/, "").length / 2 : 0,
      impl,
      probes: await selectorProbe(rpc, owner),
    });
  }
  const ownerByAddress = new Map(ownerRows.map((row) => [row.owner.toLowerCase(), row]));
  const balanceRows = [];
  for (const pair of normalizedPairs) {
    const meta = metaByToken.get((lowerAddress(pair.token) || ZERO.toLowerCase())) || {};
    const raw = await balanceOf(rpc, pair.token, pair.owner);
    const units = decimalsToNumber(raw, meta.decimals);
    const priceUsd = priceFor(prices, pair.token, meta.symbol);
    const balanceUsd = units !== null && priceUsd !== null && priceUsd !== undefined ? units * priceUsd : null;
    const owner = ownerByAddress.get(pair.owner.toLowerCase()) || {};
    balanceRows.push({
      chain: CHAIN,
      chainId: CHAIN_ID,
      token: normalizeAddress(pair.token) || ZERO,
      owner: pair.owner,
      ownerShort: `${pair.owner.slice(0, 6)}...${pair.owner.slice(-4)}`,
      symbol: meta.symbol || null,
      name: meta.name || null,
      decimals: meta.decimals ?? null,
      tokenCodePresent: Boolean(meta.codePresent),
      ownerCodePresent: Boolean(owner.codePresent),
      ownerImpl: owner.impl || null,
      balanceRaw: raw === null ? null : raw.toString(),
      balanceUnits: units,
      priceUsd,
      balanceUsd: balanceUsd === null ? null : round(balanceUsd, 2),
      material: Number(balanceUsd || 0) >= MIN_MATERIAL_BALANCE_USD,
    });
  }
  const priorContext = loadPriorContext();
  const lisUsdMeta = metaByToken.get(LISUSD.toLowerCase()) || await tokenMeta(rpc, LISUSD);
  const lisUsdSupplyUnits = decimalsToNumber(lisUsdMeta.totalSupplyRaw, lisUsdMeta.decimals);
  const lisUsdPriorDexLiquidityUsd = priorContext.lisUsdPoolRows.reduce((acc, row) => acc + Number(row.poolTvlUsd || 0), 0);
  const priorOracleResidualRows = priorContext.oracleRows.filter((row) => row.mainEqualsFallback || !row.pivotEnabled || (row.cascadeIssues || []).length).length;
  const addressesForJoin = [LISUSD, WBNB, ...tokens, ...owners, ...ownerRows.map((r) => r.impl).filter(Boolean)];
  const joins = artifactJoins(addressesForJoin);
  const trackedBalanceUsd = balanceRows.reduce((acc, row) => acc + Number(row.balanceUsd || 0), 0);
  const materialBalanceRows = balanceRows.filter((row) => row.material).length;
  const watchLabels = [];
  if ((priorContext.dexSummary?.watchCandidates || 0) > 0) watchLabels.push("prior-lista-dex-moolah-smart-lending-watch");
  if (priorOracleResidualRows > 0) watchLabels.push("prior-lista-oracle-residual-watch");
  const lisUsdPriceSamples = priorContext.lisUsdPoolRows.map((row) => asNumber(row.lisUsdPriceUsd)).filter((n) => n !== null);
  const maxLisUsdDepegBps = lisUsdPriceSamples.length ? Math.max(...lisUsdPriceSamples.map((p) => Math.abs(p - 1) * 10000)) : null;
  if (maxLisUsdDepegBps !== null && maxLisUsdDepegBps >= 150) watchLabels.push("lisusd-peg-watch");

  const summary = {
    protocol: "Lista CDP",
    slug: "lista-cdp",
    chain: CHAIN,
    chainId: CHAIN_ID,
    blockNumber,
    defillamaCurrentTvlUsd: sourceTvlUsd(),
    vaultListRows: normalizedPairs.length,
    uniqueOwners: owners.length,
    ownersWithCode: ownerRows.filter((row) => row.codePresent).length,
    uniqueTokens: tokens.length,
    tokenRowsWithCode: [...metaByToken.values()].filter((row) => row.codePresent).length,
    materialBalanceRows,
    trackedBalanceUsd: round(trackedBalanceUsd, 2),
    lisUsdSupplyUnits: lisUsdSupplyUnits === null ? null : round(lisUsdSupplyUnits, 2),
    lisUsdPriorDexLiquidityUsd: round(lisUsdPriorDexLiquidityUsd, 2),
    lisUsdMaxPriorDexDepegBps: maxLisUsdDepegBps === null ? null : round(maxLisUsdDepegBps, 2),
    priorListaDexWatchCandidates: asNumber(priorContext.dexSummary?.watchCandidates) || 0,
    priorOracleResidualRows,
    artifactJoinRows: joins.length,
    watchCandidates: watchLabels.length,
    routePositive: 0,
    executableNow: false,
    signedActionJustified: false,
    coverageClassification: "bounded-with-caveats",
    signal: "DORMANT",
  };

  const out = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-lista-cdp-phase0.js",
    scope: "Read-only Lista CDP/lisUSD Phase 0 vault-list, balance, oracle-context, and consumer-join scan on BNB Chain",
    target: { name: "Lista CDP", slug: "lista-cdp", category: "CDP", surface: "lending-oracle-liquidation", chains: [CHAIN] },
    safety: {
      publicApisOnlyForDiscovery: true,
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
    },
    inputs: {
      helioMoneyAdapter: "DefiLlama-Adapters/projects/helio-money/index.js",
      cdpVaultList: VAULT_LIST_URL,
      priorListaOracle: rel(PRIOR_ORACLE),
      priorListaDex: rel(PRIOR_DEX),
    },
    thresholds: { minMaterialBalanceUsd: MIN_MATERIAL_BALANCE_USD, maxArtifactJoins: MAX_ARTIFACT_JOINS },
    summary,
    watchCandidateLabels: watchLabels,
    ownerRows,
    tokenRows: [...metaByToken.values()],
    balanceRows,
    priorContext,
    artifactJoins: joins,
    blockers: [
      "Public CDP adapter exposes vault token/owner balances, not borrower-level vault health or liquidation queue state",
      "Existing Lista oracle issue is timing-dependent and current pass does not prove stale-but-accepted accepted-value divergence",
      "Prior Lista DEX/Moolah smart-lending rows are consumer joins only without exact positive manipulation/borrow/exit economics",
      "No permissionless lisUSD redemption, liquidation, or CDP unwind path is exact-quoted positive",
      "No fork extraction proof",
    ],
    requiredForRoutePositive: [
      "specific Lista CDP position, vault, oracle, or lisUSD peg state exposes a permissionless value-changing trigger",
      "collateral acquisition/liquidation/redemption/borrow path is live and unblocked",
      "borrowed, redeemed, or seized assets have exact positive DEX/repay/unwind economics after costs",
      "fork extraction proof",
    ],
    nextReadOnlyStep: "Keep Lista CDP on lisUSD peg, vault-list, and oracle residual watch; exact-quote only if borrower/position data or a live stale/depeg trigger appears.",
  };

  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, JSON.stringify(out, jsonReplacer, 2));
  fs.writeFileSync(REPORT_OUT, buildReport(out));
  if (!QUIET) {
    console.log(`Lista CDP Phase 0: vaultRows=${summary.vaultListRows} owners=${summary.uniqueOwners} materialBalances=${summary.materialBalanceRows} tracked=${formatUsd(summary.trackedBalanceUsd)} watch=${summary.watchCandidates} routePositive=${summary.routePositive}`);
    console.log(`Wrote ${rel(RAW_OUT)}`);
    console.log(`Report ${rel(REPORT_OUT)}`);
  }
}

main().catch((err) => { console.error(err?.stack || err?.message || String(err)); process.exit(1); });
