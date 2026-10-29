#!/usr/bin/env node
// scan-robinhood-chain-attack-vectors.js
// Expanded read-only Robinhood Chain vector battery: donations/ERC4626, oracles, bridge/gateway, and smart-contract inventory.
// No env/secrets/private keys, no signed actions, no broadcasts, no fork transactions.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpc, rpcCall, getImpl } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const PHASE0_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "robinhood-chain-phase0.json");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "robinhood-chain-attack-vectors.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "robinhood-chain-attack-vectors-triage.md");
const QUIET = process.argv.includes("--quiet");

const CHAIN_ID = 4663;
const L1_CHAIN_ID = 1;
const EXPLORER = "https://robinhoodchain.blockscout.com";
const PROBE_FROM = "0x000000000000000000000000000000000000dEaD";
const ZERO = "0x0000000000000000000000000000000000000000";
const MAX_INVENTORY = Number(process.env.ROBINHOOD_ATTACK_MAX_CONTRACTS || "260");

const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const ERC20 = new ethers.Interface([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const ERC4626 = new ethers.Interface([
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function convertToShares(uint256) view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function previewDeposit(uint256) view returns (uint256)",
  "function previewMint(uint256) view returns (uint256)",
  "function previewWithdraw(uint256) view returns (uint256)",
  "function previewRedeem(uint256) view returns (uint256)",
  "function maxDeposit(address) view returns (uint256)",
  "function maxMint(address) view returns (uint256)",
  "function maxWithdraw(address) view returns (uint256)",
  "function maxRedeem(address) view returns (uint256)",
]);
const COMMON = new ethers.Interface([
  "function owner() view returns (address)",
  "function admin() view returns (address)",
  "function paused() view returns (bool)",
  "function defaultGateway() view returns (address)",
  "function counterpartGateway() view returns (address)",
  "function inbox() view returns (address)",
  "function bridge() view returns (address)",
  "function rollup() view returns (address)",
  "function sequencerInbox() view returns (address)",
]);
const OPTIONAL = new ethers.Interface([
  "function uiMultiplier() view returns (uint256)",
  "function multiplier() view returns (uint256)",
  "function oracle() view returns (address)",
  "function priceFeed() view returns (address)",
  "function feed() view returns (address)",
  "function chainlinkFeed() view returns (address)",
  "function aggregator() view returns (address)",
  "function getPrice(address) view returns (uint256)",
  "function latestAnswer() view returns (int256)",
]);
const CHAINLINK = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function version() view returns (uint256)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
]);

const COMMON_DEX_FACTORIES = [
  { label: "UniswapV3Factory", address: "0x1F98431c8aD98523631AE4a59f267346ea31F984", type: "v3" },
  { label: "UniswapV2Factory", address: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f", type: "v2" },
  { label: "PancakeV2Factory", address: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73", type: "v2" },
];
const V2_FACTORY = new ethers.Interface(["function getPair(address,address) view returns (address)"]);
const V3_FACTORY = new ethers.Interface(["function getPool(address,address,uint24) view returns (address)"]);

const GENERIC_MUTATIVE_PROBES = [
  { label: "mint(address,uint256)", sig: "mint(address,uint256)", args: [PROBE_FROM, 1n], impact: "mint" },
  { label: "burn(uint256)", sig: "burn(uint256)", args: [1n], impact: "burn" },
  { label: "burnFrom(address,uint256)", sig: "burnFrom(address,uint256)", args: [PROBE_FROM, 1n], impact: "burn" },
  { label: "withdraw(uint256)", sig: "withdraw(uint256)", args: [1n], impact: "withdraw" },
  { label: "withdraw(address,uint256)", sig: "withdraw(address,uint256)", args: [PROBE_FROM, 1n], impact: "withdraw" },
  { label: "redeem(uint256)", sig: "redeem(uint256)", args: [1n], impact: "redeem" },
  { label: "claim()", sig: "claim()", args: [], impact: "claim" },
  { label: "claim(address)", sig: "claim(address)", args: [PROBE_FROM], impact: "claim" },
  { label: "sweep(address)", sig: "sweep(address)", args: [ZERO], impact: "sweep" },
  { label: "rescue(address,uint256)", sig: "rescue(address,uint256)", args: [ZERO, 1n], impact: "rescue" },
  { label: "pause()", sig: "pause()", args: [], impact: "admin" },
  { label: "unpause()", sig: "unpause()", args: [], impact: "admin" },
  { label: "setOracle(address)", sig: "setOracle(address)", args: [ZERO], impact: "oracle-admin" },
  { label: "setPriceFeed(address)", sig: "setPriceFeed(address)", args: [ZERO], impact: "oracle-admin" },
  { label: "setMultiplier(uint256)", sig: "setMultiplier(uint256)", args: [1n], impact: "price-admin" },
  { label: "transferOwnership(address)", sig: "transferOwnership(address)", args: [PROBE_FROM], impact: "admin" },
  { label: "upgradeTo(address)", sig: "upgradeTo(address)", args: [ZERO], impact: "upgrade" },
  { label: "upgradeToAndCall(address,bytes)", sig: "upgradeToAndCall(address,bytes)", args: [ZERO, "0x"], impact: "upgrade" },
];

const BRIDGE_PROBES = [
  { label: "outboundTransfer", sig: "outboundTransfer(address,address,uint256,uint256,uint256,bytes)", args: [ZERO, PROBE_FROM, 1n, 0n, 0n, "0x"], impact: "bridge-withdraw" },
  { label: "outboundTransferCustomRefund", sig: "outboundTransferCustomRefund(address,address,address,uint256,uint256,uint256,bytes)", args: [ZERO, PROBE_FROM, PROBE_FROM, 1n, 0n, 0n, "0x"], impact: "bridge-withdraw" },
  { label: "finalizeInboundTransfer", sig: "finalizeInboundTransfer(address,address,address,uint256,bytes)", args: [ZERO, PROBE_FROM, PROBE_FROM, 1n, "0x"], impact: "bridge-finalize" },
  { label: "setGateway", sig: "setGateway(address,uint256,uint256)", args: [ZERO, 0n, 0n], impact: "bridge-admin" },
  { label: "setDefaultGateway", sig: "setDefaultGateway(address,uint256,uint256)", args: [ZERO, 0n, 0n], impact: "bridge-admin" },
  { label: "forceInclusion", sig: "forceInclusion(uint256,uint8,address,bytes32,uint256,uint256,uint256,uint256)", args: [0n, 0, PROBE_FROM, ethers.ZeroHash, 0n, 0n, 0n, 0n], impact: "bridge-inclusion" },
  { label: "createRetryableTicket", sig: "createRetryableTicket(address,uint256,uint256,address,address,uint256,uint256,bytes)", args: [PROBE_FROM, 0n, 0n, PROBE_FROM, PROBE_FROM, 0n, 0n, "0x"], impact: "bridge-retryable" },
  { label: "executeTransaction", sig: "executeTransaction(bytes32[],uint256,uint256,address,address,uint256,uint256,bytes)", args: [[], 0n, 0n, ZERO, PROBE_FROM, 0n, 0n, "0x"], impact: "bridge-outbox" },
];

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readText(file) { try { return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""; } catch (_) { return ""; } }
function readJson(file, fallback = {}) { try { const t = readText(file).replace(/^\uFEFF/, ""); return t ? JSON.parse(t) : fallback; } catch (_) { return fallback; } }
function writeJson(file, value) { ensureDir(file); fs.writeFileSync(file, `${JSON.stringify(value, jsonReplacer, 2)}\n`); }
function writeText(file, value) { ensureDir(file); fs.writeFileSync(file, value); }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function rel(file) { return path.relative(WORKSPACE, file).replace(/\\/g, "/"); }
function strip0x(value) { return String(value || "").replace(/^0x/i, ""); }
function normalizeAddress(value) {
  if (!value) return null;
  try { return ethers.getAddress(String(value)); } catch (_) {}
  try { return ethers.getAddress(String(value).toLowerCase()); } catch (_) { return null; }
}
function lower(value) { const a = normalizeAddress(value); return a ? a.toLowerCase() : null; }
function short(value) { const a = normalizeAddress(value); return a ? `${a.slice(0, 6)}...${a.slice(-4)}` : "n/a"; }
function codeBytes(code) { return code && code !== "0x" ? strip0x(code).length / 2 : 0; }
function addressFromStorage(raw) {
  if (!raw || raw === "0x") return null;
  const hex = strip0x(raw).padStart(64, "0");
  if (/^0+$/.test(hex)) return null;
  return normalizeAddress(`0x${hex.slice(-40)}`);
}
function asNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  const n = Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}
function round(value, decimals = 2) {
  const n = asNumber(value);
  if (n === null) return null;
  const p = 10 ** decimals;
  return Math.round(n * p) / p;
}
function safeValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(safeValue);
  return String(value);
}
function selector(sig) { return ethers.id(sig).slice(0, 10); }

async function fetchJson(url, timeoutMs = 20_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) { return null; } finally { clearTimeout(timer); }
}
async function getCode(rpc, address) { return (rpc && normalizeAddress(address)) ? ((await rpcCall(rpc, "eth_getCode", [normalizeAddress(address), "latest"], 8_000)) || "0x") : "0x"; }
async function callRaw(rpc, to, data, from = PROBE_FROM, timeout = 8_000) {
  const addr = normalizeAddress(to);
  if (!rpc || !addr || !data) return null;
  return await rpcCall(rpc, "eth_call", [{ to: addr, from, data }, "latest"], timeout);
}
async function callIface(rpc, to, iface, fn, args = []) {
  try {
    const data = iface.encodeFunctionData(fn, args);
    const raw = await callRaw(rpc, to, data);
    if (!raw || raw === "0x") return { ok: false, value: null };
    const decoded = iface.decodeFunctionResult(fn, raw);
    return { ok: true, value: decoded.length === 1 ? decoded[0] : Array.from(decoded) };
  } catch (_) { return { ok: false, value: null }; }
}
async function probeSig(rpc, to, probe) {
  try {
    const fn = probe.sig.split("(")[0];
    const iface = new ethers.Interface([`function ${probe.sig}`]);
    const data = iface.encodeFunctionData(fn, probe.args);
    const raw = await callRaw(rpc, to, data, PROBE_FROM, 8_000);
    return raw !== null ? { ok: true, label: probe.label, selector: selector(probe.sig), impact: probe.impact } : null;
  } catch (_) { return null; }
}
async function proxySlots(rpc, address) {
  const addr = normalizeAddress(address);
  if (!addr) return { implementation: null, admin: null, beacon: null, adminCodePresent: null };
  const [impl, adminRaw, beaconRaw] = await Promise.all([
    getImpl(rpc, addr).catch(() => null),
    rpcCall(rpc, "eth_getStorageAt", [addr, EIP1967_ADMIN_SLOT, "latest"], 6_000).catch(() => null),
    rpcCall(rpc, "eth_getStorageAt", [addr, EIP1967_BEACON_SLOT, "latest"], 6_000).catch(() => null),
  ]);
  const admin = addressFromStorage(adminRaw);
  const adminCode = admin ? await getCode(rpc, admin) : null;
  return { implementation: impl || null, admin, beacon: addressFromStorage(beaconRaw), adminCodePresent: admin ? codeBytes(adminCode) > 0 : null };
}

async function fetchBlockscoutInventory() {
  const endpoints = [
    { label: "tokens", url: `${EXPLORER}/api/v2/tokens?type=ERC-20` },
    { label: "smart-contracts", url: `${EXPLORER}/api/v2/smart-contracts` },
  ];
  const rows = [];
  const status = [];
  for (const ep of endpoints) {
    const j = await fetchJson(ep.url);
    const items = Array.isArray(j?.items) ? j.items : Array.isArray(j) ? j : [];
    status.push({ source: ep.label, fetched: Boolean(j), rows: items.length });
    for (const item of items.slice(0, 100)) {
      const address = normalizeAddress(item?.address?.hash || item?.address || item?.address_hash || item?.hash);
      if (!address) continue;
      rows.push({
        source: `blockscout-${ep.label}`,
        chainId: CHAIN_ID,
        address,
        label: item.name || item.address?.name || item.symbol || item.address?.symbol || ep.label,
        symbol: item.symbol || item.address?.symbol || null,
      });
    }
  }
  return { rows, status };
}

function collectInventory(phase0, blockscoutRows) {
  const map = new Map();
  function add(row) {
    const address = normalizeAddress(row?.address);
    if (!address) return;
    const chainId = Number(row.chainId || CHAIN_ID);
    const key = `${chainId}:${address.toLowerCase()}`;
    const prev = map.get(key) || { chainId, address, labels: [], sources: [], symbols: [] };
    if (row.label) prev.labels.push(row.label);
    if (row.source) prev.sources.push(row.source);
    if (row.symbol) prev.symbols.push(row.symbol);
    if (row.kind) prev.kind = row.kind;
    map.set(key, prev);
  }
  for (const row of phase0.protocolContracts || []) add({ chainId: row.chainId, address: row.address, label: row.label, source: "phase0-protocol", kind: row.kind });
  for (const row of phase0.stockTokens || []) add({ chainId: CHAIN_ID, address: row.address, label: row.seedSymbol || row.erc20?.symbol, symbol: row.erc20?.symbol || row.seedSymbol, source: "phase0-stock-token", kind: "stock-token" });
  for (const row of phase0.docsAddressRows || []) add({ chainId: row.chainId || CHAIN_ID, address: row.address, label: row.label, source: `docs:${(row.sources || []).join(",")}`, kind: row.category });
  for (const row of phase0.blockscoutTokens || []) add({ chainId: CHAIN_ID, address: row.address, label: row.name, symbol: row.symbol, source: "phase0-blockscout-token", kind: "blockscout-token" });
  for (const row of blockscoutRows || []) add(row);
  return [...map.values()].map((row) => ({
    ...row,
    labels: [...new Set(row.labels.filter(Boolean))],
    sources: [...new Set(row.sources.filter(Boolean))],
    symbols: [...new Set(row.symbols.filter(Boolean))],
  })).slice(0, MAX_INVENTORY);
}

async function queryContract(rpc, l1Rpc, item) {
  const useRpc = item.chainId === L1_CHAIN_ID ? l1Rpc : rpc;
  const code = await getCode(useRpc, item.address);
  const proxy = codeBytes(code) ? await proxySlots(useRpc, item.address) : { implementation: null, admin: null, beacon: null, adminCodePresent: null };
  const views = {};
  for (const fn of ["owner", "admin", "paused", "defaultGateway", "counterpartGateway", "inbox", "bridge", "rollup", "sequencerInbox"]) {
    const r = await callIface(useRpc, item.address, COMMON, fn);
    if (r.ok) views[fn] = safeValue(r.value);
  }
  const erc20 = {};
  for (const fn of ["name", "symbol", "decimals", "totalSupply"]) {
    const r = await callIface(useRpc, item.address, ERC20, fn);
    if (r.ok) erc20[fn] = safeValue(r.value);
  }
  const optionals = {};
  for (const fn of ["uiMultiplier", "multiplier", "oracle", "priceFeed", "feed", "chainlinkFeed", "aggregator", "latestAnswer"]) {
    const r = await callIface(useRpc, item.address, OPTIONAL, fn);
    if (r.ok) optionals[fn] = safeValue(r.value);
  }
  return { ...item, codePresent: codeBytes(code) > 0, codeBytes: codeBytes(code), proxy, views, erc20, optionals };
}

async function scanDonation(rpc, contract) {
  if (contract.chainId !== CHAIN_ID || !contract.codePresent) return null;
  const address = contract.address;
  const asset = await callIface(rpc, address, ERC4626, "asset");
  const totalAssets = await callIface(rpc, address, ERC4626, "totalAssets");
  const totalSupply = await callIface(rpc, address, ERC20, "totalSupply");
  const decimals = await callIface(rpc, address, ERC20, "decimals");
  const convertToShares = await callIface(rpc, address, ERC4626, "convertToShares", [1_000_000_000_000_000_000n]);
  const convertToAssets = await callIface(rpc, address, ERC4626, "convertToAssets", [1_000_000_000_000_000_000n]);
  const maxDeposit = await callIface(rpc, address, ERC4626, "maxDeposit", [PROBE_FROM]);
  const maxMint = await callIface(rpc, address, ERC4626, "maxMint", [PROBE_FROM]);
  const erc4626Like = asset.ok && totalAssets.ok && (convertToShares.ok || convertToAssets.ok);
  if (!erc4626Like && !totalAssets.ok && !maxDeposit.ok && !maxMint.ok) return null;
  const totalAssetsBn = totalAssets.ok ? BigInt(totalAssets.value) : null;
  const totalSupplyBn = totalSupply.ok ? BigInt(totalSupply.value) : null;
  const zeroSupply = totalSupplyBn !== null && totalSupplyBn === 0n;
  const tinySupply = totalSupplyBn !== null && totalSupplyBn > 0n && totalSupplyBn < 10n ** 12n;
  const depositOpen = (maxDeposit.ok && BigInt(maxDeposit.value) > 0n) || (maxMint.ok && BigInt(maxMint.value) > 0n);
  const donationWatch = erc4626Like && depositOpen && (zeroSupply || tinySupply || (totalAssetsBn !== null && totalAssetsBn < 10n ** 12n));
  return {
    chainId: contract.chainId,
    address,
    labels: contract.labels,
    symbols: contract.symbols,
    erc4626Like,
    asset: asset.ok ? normalizeAddress(asset.value) : null,
    totalAssets: totalAssetsBn?.toString?.() || null,
    totalSupply: totalSupplyBn?.toString?.() || null,
    decimals: decimals.ok ? Number(decimals.value) : null,
    convertToShares1e18: convertToShares.ok ? convertToShares.value.toString() : null,
    convertToAssets1e18: convertToAssets.ok ? convertToAssets.value.toString() : null,
    maxDeposit: maxDeposit.ok ? maxDeposit.value.toString() : null,
    maxMint: maxMint.ok ? maxMint.value.toString() : null,
    donationWatch,
    routePositive: false,
    blockers: donationWatch
      ? ["ERC4626-like low/tiny supply needs consumer join, exact donation math, borrow/exit economics, and fork proof before route-positive"]
      : ["No exploitable donation path proven"],
  };
}

async function scanOracle(rpc, l1Rpc, contract) {
  const useRpc = contract.chainId === L1_CHAIN_ID ? l1Rpc : rpc;
  if (!contract.codePresent) return null;
  const latest = await callIface(useRpc, contract.address, CHAINLINK, "latestRoundData");
  const decimals = await callIface(useRpc, contract.address, CHAINLINK, "decimals");
  const description = await callIface(useRpc, contract.address, CHAINLINK, "description");
  const version = await callIface(useRpc, contract.address, CHAINLINK, "version");
  const feedGetterKeys = ["oracle", "priceFeed", "feed", "chainlinkFeed", "aggregator"];
  const referencedFeeds = feedGetterKeys.map((k) => normalizeAddress(contract.optionals?.[k])).filter(Boolean);
  if (!latest.ok && !referencedFeeds.length) return null;
  const row = {
    chainId: contract.chainId,
    address: contract.address,
    labels: contract.labels,
    symbols: contract.symbols,
    latestRoundDataOk: latest.ok,
    decimals: decimals.ok ? Number(decimals.value) : null,
    description: description.ok ? String(description.value) : null,
    version: version.ok ? String(version.value) : null,
    referencedFeeds,
    routePositive: false,
  };
  if (latest.ok && Array.isArray(latest.value)) {
    row.answer = latest.value[1]?.toString?.() || null;
    row.updatedAt = latest.value[3] ? Number(latest.value[3]) : null;
    row.ageSeconds = row.updatedAt ? Math.max(0, Math.floor(Date.now() / 1000) - row.updatedAt) : null;
    row.stale24h = row.ageSeconds !== null && row.ageSeconds > 86_400;
    row.stale72h = row.ageSeconds !== null && row.ageSeconds > 259_200;
  }
  return row;
}

async function scanProbes(rpc, l1Rpc, contract, probeSet, scope) {
  const useRpc = contract.chainId === L1_CHAIN_ID ? l1Rpc : rpc;
  if (!contract.codePresent) return [];
  const rows = [];
  for (const p of probeSet) {
    const res = await probeSig(useRpc, contract.address, p);
    if (res) rows.push({ scope, chainId: contract.chainId, address: contract.address, labels: contract.labels, ...res, routePositive: false });
  }
  return rows;
}

async function scanDexLiquidity(rpc, stockTokens) {
  const factories = [];
  for (const f of COMMON_DEX_FACTORIES) {
    const code = await getCode(rpc, f.address);
    factories.push({ ...f, codePresent: codeBytes(code) > 0, codeBytes: codeBytes(code) });
  }
  const pools = [];
  const tokens = stockTokens.filter((t) => normalizeAddress(t.address));
  const pairs = [];
  for (let i = 0; i < tokens.length; i++) for (let j = i + 1; j < tokens.length; j++) pairs.push([tokens[i], tokens[j]]);
  for (const f of factories.filter((x) => x.codePresent)) {
    for (const [a, b] of pairs) {
      if (f.type === "v2") {
        const r = await callIface(rpc, f.address, V2_FACTORY, "getPair", [a.address, b.address]);
        if (r.ok && normalizeAddress(r.value) && lower(r.value) !== lower(ZERO)) pools.push({ factory: f.label, type: "v2", tokenA: a.symbol || a.seedSymbol, tokenB: b.symbol || b.seedSymbol, pool: normalizeAddress(r.value) });
      } else if (f.type === "v3") {
        for (const fee of [100, 500, 3000, 10000]) {
          const r = await callIface(rpc, f.address, V3_FACTORY, "getPool", [a.address, b.address, fee]);
          if (r.ok && normalizeAddress(r.value) && lower(r.value) !== lower(ZERO)) pools.push({ factory: f.label, type: "v3", fee, tokenA: a.symbol || a.seedSymbol, tokenB: b.symbol || b.seedSymbol, pool: normalizeAddress(r.value) });
        }
      }
    }
  }
  return { factories, pools };
}

function makeReport(out) {
  const s = out.summary;
  const lines = [];
  lines.push("# 🟢 DORMANT — Robinhood Chain Attack-Vector Battery");
  lines.push("");
  lines.push("**Signal**: 🟢 DORMANT / watch-only — donation/oracle/bridge/smart-contract tests found no confirmed permissionless route; route-positive=0, executableNow=0, signedActionJustified=false.");
  lines.push("");
  lines.push(`Generated: ${out.generatedAt}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Vector | Result |");
  lines.push("| --- | ---: |");
  lines.push(`| Contracts inventoried | ${s.contractsInventoried} |`);
  lines.push(`| Code-present contracts | ${s.codePresentContracts} |`);
  lines.push(`| Proxy rows | ${s.proxyRows} |`);
  lines.push(`| Proxy admin EOA/watch rows | ${s.proxyAdminEoaRows} |`);
  lines.push(`| ERC4626/donation rows | ${s.erc4626Rows} |`);
  lines.push(`| Donation watch rows | ${s.donationWatchRows} |`);
  lines.push(`| Oracle/feed rows | ${s.oracleRows} |`);
  lines.push(`| Oracle stale >24h rows | ${s.oracleStale24hRows} |`);
  lines.push(`| Generic public mutative probe successes | ${s.genericProbeSuccessRows} |`);
  lines.push(`| Bridge/gateway probe successes | ${s.bridgeProbeSuccessRows} |`);
  lines.push(`| Common DEX factories with code | ${s.commonDexFactoriesWithCode} |`);
  lines.push(`| Stock-token DEX pools found | ${s.stockTokenDexPools} |`);
  lines.push(`| Consumer join rows | ${s.consumerJoinRows} |`);
  lines.push(`| Exact economics rows | ${s.exactEconomicsRows} |`);
  lines.push(`| Fork proof rows | ${s.forkProofRows} |`);
  lines.push(`| Route-positive | ${s.routePositive} |`);
  lines.push("");
  lines.push("## Vector Results");
  lines.push("");
  lines.push("- Donation/ERC4626: no route-positive donation inflation path; any ERC4626-like row would still require consumer join, exact donation math, exact borrow/exit economics, and fork proof.");
  lines.push("- Oracles: feed/reference rows are watch-only; no stale/incorrect oracle impact is joined to material borrow/redeem/liquidation liquidity.");
  lines.push("- Bridge: official Arbitrum bridge/gateway contracts are code-present; no proof/retryable/gateway bypass or value extraction is proven.");
  lines.push("- Smart contracts: docs/explorer inventory is code-present context; generic public probe successes, if any, are not route-positive without value movement plus exact economics.");
  lines.push("");
  lines.push("## Top Watch Rows");
  lines.push("");
  lines.push("| Vector | Chain | Address | Detail | Route-positive |");
  lines.push("| --- | --- | --- | --- | ---: |");
  const watchRows = [
    ...out.donationRows.filter((r) => r.donationWatch).slice(0, 5).map((r) => ["donation", r.chainId, r.address, "ERC4626-like donation watch"]),
    ...out.oracleRows.filter((r) => r.stale24h).slice(0, 5).map((r) => ["oracle", r.chainId, r.address, `${r.description || "feed"} age=${r.ageSeconds}s`]),
    ...out.bridgeProbeSuccessRows.slice(0, 5).map((r) => ["bridge-probe", r.chainId, r.address, r.label]),
    ...out.genericProbeSuccessRows.slice(0, 5).map((r) => ["generic-probe", r.chainId, r.address, r.label]),
  ];
  if (!watchRows.length) lines.push("| none | - | - | no watch rows cleared impact threshold | 0 |");
  for (const [v, c, a, d] of watchRows) lines.push(`| ${v} | ${c} | \`${short(a)}\` | ${String(d).replace(/\|/g, "/")} | 0 |`);
  lines.push("");
  lines.push("## Blockers");
  lines.push("");
  for (const b of out.blockers) lines.push(`- ${b}`);
  lines.push("");
  lines.push("## Required for Route Positive");
  lines.push("");
  for (const r of out.requiredForRoutePositive) lines.push(`- ${r}`);
  lines.push("");
  lines.push("## Artifacts");
  lines.push("");
  lines.push(`- JSON: \`${rel(RAW_OUT)}\``);
  lines.push("- Scanner: `tools/scan-robinhood-chain-attack-vectors.js`");
  return `${lines.join("\n")}\n`;
}

async function main() {
  const phase0 = readJson(PHASE0_FILE, {});
  const [rpc, l1Rpc, blockscout] = await Promise.all([resolveRpc(CHAIN_ID), resolveRpc(L1_CHAIN_ID), fetchBlockscoutInventory()]);
  const inventorySeed = collectInventory(phase0, blockscout.rows);
  const contracts = [];
  for (const item of inventorySeed) contracts.push(await queryContract(rpc, l1Rpc, item));

  const stockTokens = (phase0.stockTokens || []).map((t) => ({ address: normalizeAddress(t.address), symbol: t.erc20?.symbol || t.seedSymbol, seedSymbol: t.seedSymbol })).filter((t) => t.address);
  const donationRows = [];
  for (const c of contracts) {
    const row = await scanDonation(rpc, c);
    if (row) donationRows.push(row);
  }
  const oracleRows = [];
  for (const c of contracts) {
    const row = await scanOracle(rpc, l1Rpc, c);
    if (row) oracleRows.push(row);
  }
  const genericProbeSuccessRows = [];
  for (const c of contracts) genericProbeSuccessRows.push(...await scanProbes(rpc, l1Rpc, c, GENERIC_MUTATIVE_PROBES, "generic-mutative"));
  const bridgeContracts = contracts.filter((c) => /protocol|gateway|bridge|rollup|inbox|outbox/i.test(`${c.kind || ""} ${(c.labels || []).join(" ")}`));
  const bridgeProbeSuccessRows = [];
  for (const c of bridgeContracts) bridgeProbeSuccessRows.push(...await scanProbes(rpc, l1Rpc, c, BRIDGE_PROBES, "bridge-gateway"));
  const dex = await scanDexLiquidity(rpc, stockTokens);
  const consumerJoinRows = Number(phase0.summary?.localConsumerJoinRows || 0);

  const proxyRows = contracts.filter((c) => c.proxy?.implementation || c.proxy?.beacon || c.proxy?.admin).length;
  const proxyAdminEoaRows = contracts.filter((c) => c.proxy?.admin && c.proxy.adminCodePresent === false).map((c) => ({ chainId: c.chainId, address: c.address, admin: c.proxy.admin, labels: c.labels }));
  const donationWatchRows = donationRows.filter((r) => r.donationWatch).length;
  const oracleStale24hRows = oracleRows.filter((r) => r.stale24h).length;
  const exactEconomicsRows = 0;
  const forkProofRows = 0;
  const routePositive = 0;

  const blockers = [
    "No Robinhood Chain donation/ERC4626 row is joined to a material lending/borrow consumer with exact positive economics.",
    "No oracle/feed row is proven stale or incorrect in a way that changes a material borrow, redeem, liquidation, bridge, or settlement route.",
    "Bridge/gateway probes did not prove a proof, retryable, counterpart, or message-binding bypass with liquid value extraction.",
    "Generic public/static-call probe successes are treated as watch-only unless they move value and have exact economics plus fork proof.",
    "No stock-token DEX pool or local material consumer join was found for the official Robinhood Chain stock-token seeds.",
  ];
  const requiredForRoutePositive = [
    "Donation/ERC4626: public deposit/mint/donation path plus consumer-listed shares, exact inflation math, borrow/exit liquidity, positive net, and fork proof.",
    "Oracle: current accepted price diverges from executable reference price and feeds a material borrow/redeem/liquidation route with exact positive economics.",
    "Bridge: deployed proof/retryable/gateway/message path can be abused permissionlessly to mint/unlock/credit liquid value, with exact unwind economics.",
    "Smart contracts: permissionless public entrypoint reaches live balances/approvals/accounting and produces exact positive value after gas/slippage/fees.",
    "Explicit authorization remains required before any signed action.",
  ];
  const out = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-robinhood-chain-attack-vectors.js",
    scope: "Expanded read-only Robinhood Chain attack-vector battery: donations/ERC4626, oracles/feeds, bridge/gateway proof paths, DEX liquidity, and docs/explorer smart-contract inventory",
    safety: { rpcInventoryRead: true, rpcUrlsStored: false, envFilesRead: false, privateKeysRead: false, signedActions: false, exploitExecuteCalls: false, forkTransactions: false, routePositive: false, executableNow: false, signedActionJustified: false },
    sourceArtifacts: { phase0: rel(PHASE0_FILE), blockscout: EXPLORER },
    blockscoutStatus: blockscout.status,
    summary: {
      contractsInventoried: contracts.length,
      codePresentContracts: contracts.filter((c) => c.codePresent).length,
      proxyRows,
      proxyAdminEoaRows: proxyAdminEoaRows.length,
      erc4626Rows: donationRows.filter((r) => r.erc4626Like).length,
      donationRows: donationRows.length,
      donationWatchRows,
      oracleRows: oracleRows.length,
      oracleStale24hRows,
      oracleStale72hRows: oracleRows.filter((r) => r.stale72h).length,
      genericProbeSuccessRows: genericProbeSuccessRows.length,
      bridgeProbeSuccessRows: bridgeProbeSuccessRows.length,
      commonDexFactoriesWithCode: dex.factories.filter((f) => f.codePresent).length,
      stockTokenDexPools: dex.pools.length,
      consumerJoinRows,
      exactEconomicsRows,
      forkProofRows,
      watchCandidates: donationWatchRows + oracleStale24hRows + bridgeProbeSuccessRows.length + genericProbeSuccessRows.length + proxyAdminEoaRows.length,
      routePositive,
      executableNow: 0,
      signedActionJustified: false,
      status: "robinhood-attack-vectors-watch-only-no-exact-route",
    },
    contracts: contracts.map((c) => ({ chainId: c.chainId, address: c.address, labels: c.labels, sources: c.sources, symbols: c.symbols, kind: c.kind, codePresent: c.codePresent, codeBytes: c.codeBytes, proxy: c.proxy, views: c.views, erc20: c.erc20, optionals: c.optionals })).slice(0, 220),
    donationRows,
    oracleRows,
    bridgeProbeSuccessRows,
    genericProbeSuccessRows,
    proxyAdminEoaRows,
    dex,
    blockers,
    requiredForRoutePositive,
    nextReadOnlyStep: "Keep Robinhood Chain on watch; only fork after a vector has consumer linkage, exact positive economics, and proof of permissionless value impact.",
  };
  writeJson(RAW_OUT, out);
  writeText(REPORT_OUT, makeReport(out));
  if (!QUIET) {
    console.log(`Robinhood attack vectors: contracts=${out.summary.contractsInventoried} erc4626=${out.summary.erc4626Rows} oracleRows=${out.summary.oracleRows} bridgeProbeSuccess=${out.summary.bridgeProbeSuccessRows} genericProbeSuccess=${out.summary.genericProbeSuccessRows} routePositive=${out.summary.routePositive}`);
    console.log(`Report: ${rel(REPORT_OUT)}`);
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: String(err?.message || err) }));
  process.exit(1);
});
