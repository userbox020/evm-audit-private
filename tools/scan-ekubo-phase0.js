#!/usr/bin/env node
// scan-ekubo-phase0.js - bounded read-only Phase 0 for Ekubo Ethereum owner/token custody and consumer joins.
// Resolves RPC URLs in memory only. Never prints or stores RPC URLs, keys, calldata for execution, or signed actions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { rpcCall, resolveRpcPool } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "ekubo-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "ekubo-phase0-triage.md");
const PUBLIC_TARGETS = path.join(WORKSPACE, "reports", "raw", "fast", "public-audit-target-discovery.json");
const QUIET = process.argv.includes("--quiet");

const MIN_MATERIAL_BALANCE_USD = Number(process.env.EKUBO_MIN_MATERIAL_BALANCE_USD || "100000");
const ETHEREUM = 1;
const OWNERS = [
  { label: "Ekubo Ethereum owner 1", address: "0xe0e0e08a6a4b9dc7bd67bcb7aade5cf48157d444" },
  { label: "Ekubo Ethereum owner 2", address: "0x00000000000014aA86C5d3c41765bb24e11bd701" },
];
const TRACKED_TOKENS = {
  WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  DAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
  WBTC: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
};

const ERC20 = new ethers.Interface([
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
]);
const BYTES32_TOKEN = new ethers.Interface(["function symbol() view returns (bytes32)", "function name() view returns (bytes32)"]);

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
];
const DIRECT_SOURCE_SET = new Set(["aave-euler-silo", "consumer-first-high-ltv", "seven-chain-lending", "stablecoin-depeg", "erc4626-consumer", "evault-collateral-nav", "focused-morpho", "focused-euler", "morpho-public-allocator", "pool-share-snapshot", "public-lead-consumer"]);
const DIRECT_ROLES = new Set(["owner"]);
const ZERO = "0x0000000000000000000000000000000000000000";
const SIGNAL_DORMANT = "\uD83D\uDFE2 DORMANT";

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readText(file) { try { return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""; } catch (_) { return ""; } }
function readJson(file, fallback = null) { try { const t = readText(file).replace(/^\uFEFF/, ""); return t ? JSON.parse(t) : fallback; } catch (_) { return fallback; } }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function normalizeAddress(value) { try { return ethers.getAddress(value); } catch (_) { return null; } }
function lowerAddress(value) { const addr = normalizeAddress(value); return addr ? addr.toLowerCase() : null; }
function strip0x(value) { return String(value || "").replace(/^0x/i, ""); }
function unique(items) { return [...new Set((items || []).filter(Boolean))]; }
function compactAddress(value) { const addr = normalizeAddress(value); return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : "n/a"; }
function safeText(value, max = 140) { return String(value || "").replace(/https?:\/\/\S+/g, "[redacted-url]").replace(/\s+/g, " ").trim().slice(0, max) || null; }
function decodeBytes32String(value) { try { return safeText(ethers.decodeBytes32String(value), 40); } catch (_) { return null; } }
function asNumber(value) { const n = typeof value === "number" ? value : Number(String(value ?? "").replace(/[$,%\s,]/g, "")); return Number.isFinite(n) ? n : null; }
function round(value, decimals = 2) { const n = asNumber(value); if (n === null) return null; const factor = 10 ** decimals; return Math.round(n * factor) / factor; }
function formatUsd(value) { const n = asNumber(value); return n === null ? "n/a" : `$${Math.round(n).toLocaleString()}`; }
function decimalsToNumber(value, decimals) { try { if (value === null || value === undefined || decimals === null || decimals === undefined) return null; const n = Number(ethers.formatUnits(BigInt(value), Number(decimals))); return Number.isFinite(n) ? n : null; } catch (_) { return null; } }

async function fetchJson(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "evm-audit-ekubo-phase0/1.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
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

async function ethBalance(rpc, address) {
  const addr = normalizeAddress(address);
  if (!rpc || !addr) return null;
  try { return (await rpcCall(rpc, "eth_getBalance", [addr, "latest"], 10_000)).toString(); } catch (_) { return null; }
}

function discoveryRows() {
  const d = readJson(PUBLIC_TARGETS, {});
  return [...(d.phase0Queue || []), ...(d.consumerJoinFirst || []), ...(d.protocolCandidates || []), ...(d.targetedRefreshQueue || []), ...(d.yieldCandidates || []), ...(d.targets || []), ...(d.value || [])];
}

function protocolMetadata() {
  const row = discoveryRows().find((p) => p?.slug === "ekubo" || p?.name === "Ekubo");
  if (row) return { name: row.name, slug: row.slug, category: row.category, chains: row.chains || [], tvlUsd: round(row.tvlUsd, 2), change1dPct: row.change1dPct ?? null, change7dPct: row.change7dPct ?? null, routePriority: row.routePriority || null, source: "public-audit-target-discovery" };
  return { name: "Ekubo", slug: "ekubo", category: "Dexs", chains: ["Starknet", "Ethereum"], tvlUsd: null };
}

async function loadPrices() {
  const keys = Object.values(TRACKED_TOKENS).map((addr) => `ethereum:${addr.toLowerCase()}`);
  const json = await fetchJson(`https://coins.llama.fi/prices/current/${keys.join(",")}?searchWidth=6h`, 30_000);
  const out = {};
  for (const [key, value] of Object.entries(json?.coins || {})) {
    const price = asNumber(value?.price);
    if (price !== null) out[key.toLowerCase()] = price;
  }
  return out;
}

async function tokenMeta(rpc, address, prices) {
  const addr = normalizeAddress(address);
  const [code, decimalsRaw, symbolRaw, symbolBytesRaw, nameRaw, nameBytesRaw] = await Promise.all([
    getCode(rpc, addr),
    safeCall(rpc, addr, ERC20, "decimals"),
    safeCall(rpc, addr, ERC20, "symbol"),
    safeCall(rpc, addr, BYTES32_TOKEN, "symbol"),
    safeCall(rpc, addr, ERC20, "name"),
    safeCall(rpc, addr, BYTES32_TOKEN, "name"),
  ]);
  const symbol = safeText(symbolRaw?.[0], 40) || decodeBytes32String(symbolBytesRaw?.[0]);
  return { address: addr, symbol, name: safeText(nameRaw?.[0], 80) || decodeBytes32String(nameBytesRaw?.[0]), decimals: decimalsRaw?.[0] === undefined ? null : Number(decimalsRaw[0]), codePresent: Boolean(code && code !== "0x"), priceUsd: prices[`ethereum:${addr.toLowerCase()}`] ?? null };
}

async function inspectOwners(rpc) {
  const prices = await loadPrices();
  const wethPrice = prices[`ethereum:${TRACKED_TOKENS.WETH.toLowerCase()}`] ?? null;
  const tokenRows = [];
  const ownerRows = [];
  const tokenMetas = {};
  for (const [label, token] of Object.entries(TRACKED_TOKENS)) tokenMetas[label] = await tokenMeta(rpc, token, prices);
  for (const ownerDef of OWNERS) {
    const owner = normalizeAddress(ownerDef.address);
    const [code, nativeRaw] = await Promise.all([getCode(rpc, owner), ethBalance(rpc, owner)]);
    const nativeEth = decimalsToNumber(nativeRaw, 18);
    ownerRows.push({ chainId: ETHEREUM, chain: "Ethereum", label: ownerDef.label, owner, codePresent: Boolean(code && code !== "0x"), codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0, nativeBalanceRaw: nativeRaw, nativeEth: round(nativeEth, 8), nativeUsd: nativeEth !== null && wethPrice !== null ? round(nativeEth * wethPrice, 2) : null, routePositive: false });
    for (const [label, token] of Object.entries(TRACKED_TOKENS)) {
      const meta = tokenMetas[label];
      const raw = await safeCall(rpc, token, ERC20, "balanceOf", [owner]);
      const amount = decimalsToNumber(raw?.[0]?.toString(), meta.decimals);
      const amountUsd = amount !== null && meta.priceUsd !== null ? amount * meta.priceUsd : null;
      tokenRows.push({ chainId: ETHEREUM, chain: "Ethereum", owner, ownerLabel: ownerDef.label, token: meta.address, symbol: meta.symbol || label, name: meta.name, balanceRaw: raw?.[0] === undefined ? null : raw[0].toString(), amount: round(amount, 8), amountUsd: round(amountUsd, 2), material: (asNumber(amountUsd) || 0) >= MIN_MATERIAL_BALANCE_USD, routePositive: false });
    }
  }
  return { ownerRows, tokenRows };
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
  if (!obj || depth > 9 || out.length >= 700) return;
  if (Array.isArray(obj)) { for (const item of obj) scanObjectForAddresses(source, item, addressRoles, out, depth + 1); return; }
  if (typeof obj !== "object") return;
  const hits = [...primitiveAddresses(obj)].filter((addr) => addressRoles[addr]);
  if (hits.length) {
    const roles = unique(hits.flatMap((addr) => addressRoles[addr].map((role) => role.role)));
    out.push({ source, hitRoles: roles, hitAddresses: hits.slice(0, 12), owners: unique(hits.flatMap((addr) => addressRoles[addr].map((role) => role.owner)).filter(Boolean)).slice(0, 10), context: summarizeContext(obj), directConsumer: DIRECT_SOURCE_SET.has(source) && roles.some((role) => DIRECT_ROLES.has(role)), routePositive: false, blocker: "Local artifact address match is context only unless an Ekubo Ethereum owner/token is trusted by consumer logic with exact positive economics" });
    return;
  }
  for (const value of Object.values(obj)) scanObjectForAddresses(source, value, addressRoles, out, depth + 1);
}

function localConsumerJoins(ownerRows, tokenRows) {
  const roles = {};
  function add(addr, role, owner) {
    const lower = lowerAddress(addr);
    if (!lower || lower === ZERO) return;
    if (!roles[lower]) roles[lower] = [];
    roles[lower].push({ role, owner });
  }
  for (const row of ownerRows) add(row.owner, "owner", row.owner);
  for (const row of tokenRows) add(row.token, "token", row.owner);
  const matches = [];
  for (const [source, rel] of CONSUMER_ARTIFACTS) { const json = readJson(path.join(WORKSPACE, rel), null); if (json) scanObjectForAddresses(source, json, roles, matches); }
  return { ownerSpecificJoinRows: matches.filter((row) => row.directConsumer), tokenContextRows: matches.filter((row) => !row.directConsumer) };
}

function buildReport(artifact) {
  const s = artifact.summary;
  const ownerTable = artifact.ownerRows.map((row) => `| ${row.chain} | ${row.label} | ${compactAddress(row.owner)} | ${row.codePresent ? "yes" : "no"} | ${row.codeBytes} | ${row.nativeEth ?? "n/a"} | ${formatUsd(row.nativeUsd)} |`).join("\n");
  const tokenTable = artifact.tokenRows.filter((row) => (asNumber(row.amountUsd) || 0) > 0).sort((a, b) => (asNumber(b.amountUsd) || 0) - (asNumber(a.amountUsd) || 0)).slice(0, 12).map((row) => `| ${row.chain} | ${row.ownerLabel} | ${row.symbol || compactAddress(row.token)} | ${row.amount ?? "n/a"} | ${formatUsd(row.amountUsd)} |`).join("\n") || "| none | n/a | n/a | n/a | n/a |";
  const consumerTable = artifact.ownerSpecificJoinRows.length ? artifact.ownerSpecificJoinRows.slice(0, 10).map((row) => `| ${row.source} | ${row.hitRoles.join(",")} | ${row.hitAddresses.map(compactAddress).join(", ")} | ${row.owners.map(compactAddress).join(", ") || "n/a"} | ${safeText(row.context?.protocol || row.context?.project || row.context?.name || row.context?.surface || row.context?.file || "context", 80)} |`).join("\n") : "| none | n/a | n/a | n/a | no Ekubo Ethereum owner address was found in consumer-grade artifacts |";
  return `# ${SIGNAL_DORMANT} - Ekubo Phase 0 Triage

Date: ${artifact.generatedAt}

## Result

No confirmed permissionless exploit. Ekubo's public adapter exposes a Starknet AMM market plus Ethereum token-owner TVL, not an Ethereum AMM factory. The bounded Ethereum pass mapped owner bytecode, native/token balance context, and local consumer joins. Token-level matches are common-asset context only; route-positive requires a deployed consumer that trusts Ekubo owner/token state plus exact positive borrow, redeem, liquidation, bridge, or unwind economics.

## Scope

| Item | Value |
|---|---:|
| DeFiLlama TVL context | ${formatUsd(s.defillamaCurrentTvlUsd)} |
| Ethereum RPC available | ${s.ethereumRpcAvailable ? "yes" : "no"} |
| Owners scanned | ${s.ownersScanned} |
| Owners with code | ${s.ownersWithCode} |
| Tracked token rows | ${s.trackedTokenRows} |
| Material tracked balance rows | ${s.materialBalanceRows} |
| Owner-specific consumer rows | ${s.ownerSpecificJoinRows} |
| Token context rows | ${s.tokenContextRows} |
| Watch candidates | ${s.watchCandidates} |
| Route-positive | ${s.routePositive} |

## Ethereum Owners

| Chain | Label | Owner | Code | Code bytes | Native ETH | Native USD |
|---|---|---|---|---:|---:|---:|
${ownerTable}

## Tracked Token Balances

| Chain | Owner | Token | Amount | USD |
|---|---|---|---:|---:|
${tokenTable}

## Direct Consumer Join

| Source | Hit roles | Addresses | Owners | Context |
|---|---|---|---|---|
${consumerTable}

## Blockers

- The Ethereum side is adapter owner/token custody context, not a discovered EVM AMM pool factory.
- No Ekubo Ethereum owner address is currently found as value-bearing collateral, reserve asset, oracle-specific consumer, bridge proof target, or settlement target in scanned consumer-grade artifacts.
- Token-level joins are dominated by common assets such as ETH/WETH, USDC, USDT, DAI, and WBTC.
- Starknet AMM state is not an EVM flash-loan route without a cross-domain consumer/economics link.
- No exact positive bridge, borrow, redemption, liquidation, settlement, or DEX unwind economics and no fork extraction proof exist.

## Required For Route-Positive

- A deployed EVM or cross-domain consumer references an Ekubo owner, receipt, LP/accounting state, or Starknet-to-Ethereum message path.
- The referenced state is permissionlessly movable or stale in an attacker-favorable direction.
- Borrow, redemption, bridge, liquidation, or settlement liquidity is material and exact-quoted after fees, gas, and slippage.
- Fork/local proof shows positive net value.

Artifacts: \`reports/raw/fast/ekubo-phase0.json\`.
`;
}

async function main() {
  const metadata = protocolMetadata();
  const rpcs = await resolveRpcPool([ETHEREUM]);
  const rpc = rpcs[ETHEREUM];
  const ownerRows = [];
  const tokenRows = [];
  if (rpc) {
    const inspected = await inspectOwners(rpc);
    ownerRows.push(...inspected.ownerRows);
    tokenRows.push(...inspected.tokenRows);
  }
  const joins = localConsumerJoins(ownerRows, tokenRows);
  const ownerJoinSet = new Set(joins.ownerSpecificJoinRows.flatMap((row) => row.owners.map(lowerAddress)).filter(Boolean));
  const watchCandidates = ownerRows.filter((row) => ownerJoinSet.has(lowerAddress(row.owner))).map((row) => ({ ...row, reason: "Ekubo Ethereum owner appears in a consumer-grade artifact", routePositive: false }));
  const summary = { ethereumRpcAvailable: Boolean(rpc), ownersScanned: ownerRows.length, ownersWithCode: ownerRows.filter((row) => row.codePresent).length, trackedTokenRows: tokenRows.length, trackedKnownBalanceUsd: round(tokenRows.reduce((sum, row) => sum + (asNumber(row.amountUsd) || 0), 0), 2), nativeBalanceUsd: round(ownerRows.reduce((sum, row) => sum + (asNumber(row.nativeUsd) || 0), 0), 2), materialBalanceRows: tokenRows.filter((row) => (asNumber(row.amountUsd) || 0) >= MIN_MATERIAL_BALANCE_USD).length, ownerSpecificJoinRows: joins.ownerSpecificJoinRows.length, tokenContextRows: joins.tokenContextRows.length, watchCandidates: watchCandidates.length, defillamaCurrentTvlUsd: metadata.tvlUsd, routePositive: 0, executableNow: 0, signedActionJustified: false, closedReason: joins.ownerSpecificJoinRows.length ? "Ekubo owner references found, but no exact-positive consumer economics or proof" : "no Ekubo Ethereum owner address is referenced by scanned consumer-grade artifacts" };
  const artifact = { generatedAt: new Date().toISOString(), scanner: "tools/scan-ekubo-phase0.js", scope: "Read-only Ekubo Ethereum owner/token custody and consumer-route Phase 0 scan", target: { name: "Ekubo", slug: "ekubo", category: "Dexs", surface: "dex-oracle-consumer-only", metadata }, safety: { publicApisOnlyForMetadata: true, rpcInventoryRead: true, rpcUrlsStored: false, privateKeysRead: false, signedActions: false, exploitExecuteCalls: false, forkTransactions: false, routePositive: false, executableNow: false, signedActionJustified: false }, thresholds: { minMaterialBalanceUsd: MIN_MATERIAL_BALANCE_USD }, docs: { adapter: "https://raw.githubusercontent.com/DefiLlama/DefiLlama-Adapters/main/projects/ekubo/index.js", starknetMarket: "0x00000005dd3d2f4429af886cd1a3b08289dbcea99a294197e9eb43b0e0325b4b" }, ownerRows, tokenRows, ownerSpecificJoinRows: joins.ownerSpecificJoinRows, tokenContextRows: joins.tokenContextRows.slice(0, 150), watchCandidates, routePositiveRows: [], summary, blockers: ["Ethereum adapter surface is owner/token custody context, not an EVM AMM pool factory", "No Ekubo owner address is referenced by scanned consumer-grade artifacts", "Token-level matches are common-asset context and not Ekubo-specific impact", "No exact positive bridge, borrow, redemption, liquidation, settlement, or DEX unwind economics or proof"], requiredForRoutePositive: ["deployed consumer references Ekubo owner, receipt, LP/accounting state, or cross-domain message path", "referenced state is permissionlessly movable or stale in attacker-favorable direction", "borrow, redemption, bridge, liquidation, or settlement route is exact-quoted and positive", "fork/local proof"], nextReadOnlyStep: joins.ownerSpecificJoinRows.length ? "Static-review the matched consumer and exact-quote only if Ekubo owner/accounting state affects accepted value." : "Reopen Ekubo only if an EVM/cross-domain consumer references Ekubo owner, receipt, LP/accounting, or message state." };
  ensureDir(RAW_OUT);
  fs.writeFileSync(RAW_OUT, `${JSON.stringify(artifact, jsonReplacer, 2)}\n`);
  fs.writeFileSync(REPORT_OUT, buildReport(artifact));
  if (!QUIET) console.log(`Ekubo Phase 0: owners=${summary.ownersScanned} materialBalances=${summary.materialBalanceRows} ownerConsumers=${summary.ownerSpecificJoinRows} watch=${summary.watchCandidates} routePositive=${summary.routePositive}`);
}

main().catch((err) => { console.error(err?.message || String(err)); process.exit(1); });
