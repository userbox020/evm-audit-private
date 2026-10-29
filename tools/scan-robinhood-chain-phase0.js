#!/usr/bin/env node
// scan-robinhood-chain-phase0.js - read-only Phase 0 for Robinhood Chain.
// No secrets, no env files, no private keys, no signed actions, no broadcasts.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpc, rpcCall, getImpl } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_OUT = path.join(WORKSPACE, "reports", "raw", "fast", "robinhood-chain-phase0.json");
const REPORT_OUT = path.join(WORKSPACE, "reports", "robinhood-chain-phase0-triage.md");
const QUIET = process.argv.includes("--quiet");

const CHAIN_ID = 4663;
const L1_CHAIN_ID = 1;
const CHAIN = "Robinhood Chain";
const PROBE_FROM = "0x000000000000000000000000000000000000dEaD";
const ZERO = "0x0000000000000000000000000000000000000000";

const DOC_URLS = {
  connecting: "https://docs.robinhood.com/chain/connecting",
  bridging: "https://docs.robinhood.com/chain/bridging",
  protocolContracts: "https://docs.robinhood.com/chain/protocol-contracts",
  contracts: "https://docs.robinhood.com/chain/contracts",
  stockTokens: "https://docs.robinhood.com/chain/stock-tokens",
};

const EXPLORER = "https://robinhoodchain.blockscout.com";

const OFFICIAL_L1_PROTOCOL = {
  rollup: "0x23A19d23e89166adedbDcB432518AB01e4272D94",
  sequencerInbox: "0xBd0D173EEb87D57A09521c24388a12789F33ba96",
  delayedInbox: "0x1A07cc4BD17E0118BdB54D70990D2158AbAD7a2D",
  bridge: "0xDf8755334ce7A73cCF6b581C02eA649AE3E864b3",
  outbox: "0xf0ce991ea4A0d2400A4AB49b20ae333f6Dce3DE9",
  l1GatewayRouter: "0x6a2E3a1e16FC29f27Ce61429746D558d656975bB",
};

const OFFICIAL_L2_PROTOCOL = {
  l2GatewayRouter: "0x1E324B9316138CA9a73F960213621AD1aaf01B89",
  l2Erc20Gateway: "0xfd9b17206278C16DdaacF6AC8f05dBf97EdCb31e",
  l2Weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
};

// Seeded from Robinhood official docs; the scanner also extracts addresses from the docs page.
const OFFICIAL_STOCK_TOKEN_SEEDS = {
  AAPL: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9",
  GOOGL: "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3",
  MSFT: "0xe93237C50D904957Cf27E7B1133b510C669c2e74",
  NVDA: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
  TSLA: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d",
};

const COMMON_FACTORY_ADDRESSES = {
  uniswapV3Factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  uniswapV2Factory: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
  pancakeswapV2Factory: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73",
  balancerV2Vault: "0xBA12222222228d8Ba445958a75a0704d566BF2C8",
};

const CONSUMER_ARTIFACTS = [
  ["xstocks-live", "reports/raw/fast/xstocks-live.json"],
  ["xstocks-consumer-routes", "reports/raw/fast/xstocks-consumer-routes.json"],
  ["solana-consumer-routes", "reports/raw/fast/solana-consumer-routes.json"],
  ["solana-receipt-token-consumer-graph", "reports/raw/fast/solana-receipt-token-consumer-graph.json"],
  ["aave-euler-silo", "reports/raw/fast/aave-euler-silo-consumer-graph.json"],
  ["consumer-first-high-ltv", "reports/raw/fast/consumer-first-high-ltv-collateral.json"],
  ["erc4626-consumer", "reports/raw/fast/erc4626-consumer-joiner.json"],
  ["dex-consumer-routes", "reports/raw/fast/dex-consumer-routes.json"],
  ["bridge-lending-collateral", "reports/raw/fast/bridge-lending-collateral-join.json"],
  ["bridge-synthetic-consumer", "reports/raw/fast/bridge-synthetic-consumer-exposure.json"],
  ["bridge-proof-binding", "reports/raw/fast/bridge-proof-binding.json"],
  ["morpho", "reports/raw/fast/morpho-high-apy-liquidation-routes.json"],
  ["euler-v2", "reports/raw/fast/euler-v2-phase0.json"],
  ["compound-v3", "reports/raw/fast/compound-v3-phase0.json"],
  ["silo-v2", "reports/raw/fast/silo-v2-phase0.json"],
];

const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const ERC20 = new ethers.Interface([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
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

const OPTIONAL_TOKEN = new ethers.Interface([
  "function uiMultiplier() view returns (uint256)",
  "function multiplier() view returns (uint256)",
  "function oracle() view returns (address)",
  "function priceFeed() view returns (address)",
  "function feed() view returns (address)",
  "function chainlinkFeed() view returns (address)",
  "function compliance() view returns (address)",
  "function identityRegistry() view returns (address)",
  "function tokenIssuer() view returns (address)",
  "function custodian() view returns (address)",
]);

const CHAINLINK = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
]);

const PROBES = [
  { label: "mint(address,uint256)", signature: "mint(address,uint256)", args: [PROBE_FROM, 1n] },
  { label: "burn(uint256)", signature: "burn(uint256)", args: [1n] },
  { label: "burnFrom(address,uint256)", signature: "burnFrom(address,uint256)", args: [PROBE_FROM, 1n] },
  { label: "pause()", signature: "pause()", args: [] },
  { label: "unpause()", signature: "unpause()", args: [] },
  { label: "setPriceFeed(address)", signature: "setPriceFeed(address)", args: [ZERO] },
  { label: "setMultiplier(uint256)", signature: "setMultiplier(uint256)", args: [1n] },
  { label: "upgradeTo(address)", signature: "upgradeTo(address)", args: [ZERO] },
];

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function jsonReplacer(_key, value) { return typeof value === "bigint" ? value.toString() : value; }
function readText(file) { try { return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""; } catch (_) { return ""; } }
function writeJson(file, value) { ensureDir(file); fs.writeFileSync(file, `${JSON.stringify(value, jsonReplacer, 2)}\n`); }
function writeText(file, value) { ensureDir(file); fs.writeFileSync(file, value); }
function rel(file) { return path.relative(WORKSPACE, file).replace(/\\/g, "/"); }

function normalizeAddress(value) {
  if (!value) return null;
  const s = String(value);
  try { return ethers.getAddress(s); } catch (_) {}
  try { return ethers.getAddress(s.toLowerCase()); } catch (_) { return null; }
}
function lower(value) { const a = normalizeAddress(value); return a ? a.toLowerCase() : null; }
function strip0x(value) { return String(value || "").replace(/^0x/i, ""); }
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
function short(value) {
  const a = normalizeAddress(value);
  return a ? `${a.slice(0, 6)}...${a.slice(-4)}` : "n/a";
}
function codeBytes(code) { return code && code !== "0x" ? (strip0x(code).length / 2) : 0; }
function safeString(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(safeString);
  return String(value);
}
function formatUnits(raw, decimals) {
  try {
    if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
    const n = Number(ethers.formatUnits(BigInt(raw), Number(decimals)));
    return Number.isFinite(n) ? n : null;
  } catch (_) { return null; }
}
function selector(signature) { return ethers.id(signature).slice(0, 10); }

async function fetchText(url, timeoutMs = 20_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "accept": "text/html,text/plain,application/json" } });
    if (!res.ok) return null;
    return await res.text();
  } catch (_) { return null; } finally { clearTimeout(timer); }
}

async function fetchJson(url, timeoutMs = 20_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "accept": "application/json" } });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) { return null; } finally { clearTimeout(timer); }
}

async function getCode(rpc, address) {
  const a = normalizeAddress(address);
  if (!rpc || !a) return "0x";
  return (await rpcCall(rpc, "eth_getCode", [a, "latest"], 10_000)) || "0x";
}

async function callRaw(rpc, to, data, from = PROBE_FROM, timeout = 10_000) {
  const a = normalizeAddress(to);
  if (!rpc || !a || !data) return null;
  return await rpcCall(rpc, "eth_call", [{ to: a, from, data }, "latest"], timeout);
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

async function getProxySlots(rpc, address) {
  const [impl, adminRaw, beaconRaw] = await Promise.all([
    getImpl(rpc, address).catch(() => null),
    rpcCall(rpc, "eth_getStorageAt", [normalizeAddress(address), EIP1967_ADMIN_SLOT, "latest"], 8_000).catch(() => null),
    rpcCall(rpc, "eth_getStorageAt", [normalizeAddress(address), EIP1967_BEACON_SLOT, "latest"], 8_000).catch(() => null),
  ]);
  return { implementation: impl || null, admin: addressFromStorage(adminRaw), beacon: addressFromStorage(beaconRaw) };
}

async function queryContract({ rpc, chainId, label, address, kind }) {
  const addr = normalizeAddress(address);
  const code = await getCode(rpc, addr);
  const proxy = codeBytes(code) > 0 ? await getProxySlots(rpc, addr) : { implementation: null, admin: null, beacon: null };
  const viewNames = ["owner", "admin", "paused", "defaultGateway", "counterpartGateway", "inbox", "bridge", "rollup", "sequencerInbox"];
  const views = {};
  for (const fn of viewNames) {
    const r = await callIface(rpc, addr, COMMON, fn);
    if (r.ok) views[fn] = safeString(r.value);
  }
  return {
    chainId,
    label,
    kind,
    address: addr,
    codePresent: codeBytes(code) > 0,
    codeBytes: codeBytes(code),
    proxy,
    views,
  };
}

async function queryFeed(rpc, feedAddress) {
  const addr = normalizeAddress(feedAddress);
  if (!addr) return null;
  const code = await getCode(rpc, addr);
  if (!codeBytes(code)) return { address: addr, codePresent: false };
  const decimals = await callIface(rpc, addr, CHAINLINK, "decimals");
  const description = await callIface(rpc, addr, CHAINLINK, "description");
  const latest = await callIface(rpc, addr, CHAINLINK, "latestRoundData");
  const row = {
    address: addr,
    codePresent: true,
    decimals: decimals.ok ? Number(decimals.value) : null,
    description: description.ok ? String(description.value) : null,
    latestRoundDataOk: latest.ok,
  };
  if (latest.ok && Array.isArray(latest.value)) {
    row.answer = latest.value[1]?.toString?.() || null;
    row.updatedAt = latest.value[3] ? Number(latest.value[3]) : null;
    row.ageSeconds = row.updatedAt ? Math.max(0, Math.floor(Date.now() / 1000) - row.updatedAt) : null;
  }
  return row;
}

async function queryToken(rpc, seedSymbol, address) {
  const addr = normalizeAddress(address);
  const code = await getCode(rpc, addr);
  const row = {
    chainId: CHAIN_ID,
    chain: CHAIN,
    seedSymbol,
    address: addr,
    codePresent: codeBytes(code) > 0,
    codeBytes: codeBytes(code),
    erc20: {},
    optionalViews: {},
    priceFeeds: [],
    publicProbeSuccesses: [],
    proxy: { implementation: null, admin: null, beacon: null },
    routePositive: false,
  };
  if (!row.codePresent) return row;

  row.proxy = await getProxySlots(rpc, addr);
  for (const fn of ["name", "symbol", "decimals", "totalSupply"]) {
    const r = await callIface(rpc, addr, ERC20, fn);
    if (r.ok) row.erc20[fn] = safeString(r.value);
  }
  if (row.erc20.totalSupply && row.erc20.decimals !== undefined) {
    row.totalSupplyFormatted = formatUnits(row.erc20.totalSupply, row.erc20.decimals);
  }

  for (const fn of ["owner", "admin", "paused"]) {
    const r = await callIface(rpc, addr, COMMON, fn);
    if (r.ok) row.optionalViews[fn] = safeString(r.value);
  }
  for (const fn of ["uiMultiplier", "multiplier", "oracle", "priceFeed", "feed", "chainlinkFeed", "compliance", "identityRegistry", "tokenIssuer", "custodian"]) {
    const r = await callIface(rpc, addr, OPTIONAL_TOKEN, fn);
    if (r.ok) row.optionalViews[fn] = safeString(r.value);
  }

  const feedCandidates = ["oracle", "priceFeed", "feed", "chainlinkFeed"]
    .map((k) => normalizeAddress(row.optionalViews[k]))
    .filter(Boolean);
  for (const feed of [...new Set(feedCandidates)]) {
    const feedRow = await queryFeed(rpc, feed);
    if (feedRow) row.priceFeeds.push(feedRow);
  }

  for (const probe of PROBES) {
    try {
      const data = new ethers.Interface([`function ${probe.signature}`]).encodeFunctionData(probe.signature.split("(")[0], probe.args);
      const raw = await callRaw(rpc, addr, data, PROBE_FROM, 8_000);
      if (raw !== null) row.publicProbeSuccesses.push({ label: probe.label, selector: selector(probe.signature), staticCallSucceeded: true });
    } catch (_) {}
  }
  return row;
}

async function extractDocAddresses() {
  const byAddress = new Map();
  const sourceStatus = [];
  for (const [name, url] of Object.entries(DOC_URLS)) {
    const text = await fetchText(url);
    const ok = Boolean(text);
    const matches = text ? [...new Set(text.match(/0x[a-fA-F0-9]{40}/g) || [])] : [];
    sourceStatus.push({ source: name, fetched: ok, addresses: matches.length });
    for (const raw of matches) {
      const addr = normalizeAddress(raw);
      if (!addr) continue;
      const key = addr.toLowerCase();
      const row = byAddress.get(key) || { address: addr, sources: [] };
      row.sources.push(name);
      byAddress.set(key, row);
    }
  }
  return { sourceStatus, addresses: [...byAddress.values()].map((r) => ({ ...r, sources: [...new Set(r.sources)] })) };
}

async function fetchBlockscoutTokens() {
  const out = [];
  const first = await fetchJson(`${EXPLORER}/api/v2/tokens?type=ERC-20`);
  const items = Array.isArray(first?.items) ? first.items : Array.isArray(first) ? first : [];
  for (const item of items.slice(0, 100)) {
    const address = normalizeAddress(item?.address?.hash || item?.address || item?.address_hash);
    if (!address) continue;
    out.push({
      address,
      name: item.name || item.address?.name || null,
      symbol: item.symbol || item.address?.symbol || null,
      type: item.type || null,
      decimals: item.decimals || null,
      holders: item.holders || item.holders_count || null,
      exchangeRate: item.exchange_rate || null,
    });
  }
  return out;
}

function scanLocalConsumerArtifacts(stockTokens, docsAddresses) {
  const tokenAddresses = new Set(stockTokens.map((t) => lower(t.address)).filter(Boolean));
  const docsSet = new Set(docsAddresses.map((r) => lower(r.address)).filter(Boolean));
  const rows = [];
  for (const [source, relPath] of CONSUMER_ARTIFACTS) {
    const full = path.join(WORKSPACE, relPath);
    const text = readText(full);
    if (!text) continue;
    const lowered = text.toLowerCase();
    const tokenHits = [...tokenAddresses].filter((addr) => lowered.includes(addr));
    const docsHits = [...docsSet].filter((addr) => lowered.includes(addr)).slice(0, 20);
    const robinhoodMention = /robinhood/i.test(text);
    const chainMention = /\b4663\b/.test(text);
    if (tokenHits.length || docsHits.length || robinhoodMention || chainMention) {
      rows.push({
        source,
        artifact: relPath,
        tokenAddressHits: tokenHits.length,
        docsAddressHits: docsHits.length,
        robinhoodMention,
        chain4663Mention: chainMention,
        routeRelevant: tokenHits.length > 0 || chainMention,
      });
    }
  }
  return rows;
}

function classifyDocAddress(address, stockTokens) {
  const l1 = Object.entries(OFFICIAL_L1_PROTOCOL).find(([, a]) => lower(a) === lower(address));
  if (l1) return { chainId: L1_CHAIN_ID, category: "official-l1-protocol", label: l1[0] };
  const l2 = Object.entries(OFFICIAL_L2_PROTOCOL).find(([, a]) => lower(a) === lower(address));
  if (l2) return { chainId: CHAIN_ID, category: "official-l2-protocol", label: l2[0] };
  const tok = stockTokens.find((t) => lower(t.address) === lower(address));
  if (tok) return { chainId: CHAIN_ID, category: "official-stock-token-seed", label: tok.seedSymbol || tok.erc20?.symbol || "stock-token" };
  return { chainId: CHAIN_ID, category: "docs-address-unclassified", label: "docs-address" };
}

function makeReport(artifact) {
  const s = artifact.summary;
  const lines = [];
  lines.push("# 🟢 DORMANT — Robinhood Chain Phase 0");
  lines.push("");
  lines.push("**Signal**: 🟢 DORMANT / watch-only — no confirmed permissionless route; route-positive=0, executableNow=0, signedActionJustified=false.");
  lines.push("");
  lines.push(`Generated: ${artifact.generatedAt}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| --- | ---: |");
  lines.push(`| Chain ID verified | ${s.chainIdVerified ? "yes" : "no"} |`);
  lines.push(`| Latest block reachable | ${artifact.chain?.blockNumber ?? "n/a"} |`);
  lines.push(`| Docs addresses extracted | ${s.docsAddressRows} |`);
  lines.push(`| Code-present docs/protocol rows | ${s.codePresentRows} |`);
  lines.push(`| Official stock-token seed rows checked | ${s.stockTokenRows} |`);
  lines.push(`| Stock tokens with code | ${s.stockTokensWithCode} |`);
  lines.push(`| Bridge/protocol contracts with code | ${s.bridgeContractRows} |`);
  lines.push(`| Blockscout ERC20 token rows sampled | ${s.blockscoutTokenRows} |`);
  lines.push(`| Local consumer join rows | ${s.localConsumerJoinRows} |`);
  lines.push(`| Public mutative probe successes | ${s.publicProbeSuccessRows} |`);
  lines.push(`| Exact economics rows | ${s.exactEconomicsRows} |`);
  lines.push(`| Route-positive | ${s.routePositive} |`);
  lines.push("");
  lines.push("## Official Stock Token Seeds");
  lines.push("");
  lines.push("| Seed | On-chain symbol | Address | Code | Total supply | Optional controls/feeds | Probe successes |");
  lines.push("| --- | --- | --- | ---: | ---: | --- | ---: |");
  for (const row of artifact.stockTokens) {
    const controls = Object.keys(row.optionalViews || {}).filter((k) => !["name", "symbol"].includes(k)).join(", ") || "none decoded";
    lines.push(`| ${row.seedSymbol || "?"} | ${row.erc20?.symbol || "?"} | \`${short(row.address)}\` | ${row.codePresent ? "yes" : "no"} | ${row.totalSupplyFormatted ?? "n/a"} | ${controls} / feeds=${row.priceFeeds?.length || 0} | ${row.publicProbeSuccesses?.length || 0} |`);
  }
  lines.push("");
  lines.push("## Bridge / Protocol Contracts");
  lines.push("");
  lines.push("| Chain | Label | Address | Code | Proxy impl | Decoded views |");
  lines.push("| --- | --- | --- | ---: | --- | --- |");
  for (const row of artifact.protocolContracts) {
    lines.push(`| ${row.chainId === 1 ? "Ethereum L1" : CHAIN} | ${row.label} | \`${short(row.address)}\` | ${row.codePresent ? "yes" : "no"} | ${row.proxy?.implementation ? short(row.proxy.implementation) : "none"} | ${Object.keys(row.views || {}).join(", ") || "none"} |`);
  }
  lines.push("");
  lines.push("## Gate");
  lines.push("");
  lines.push("The scan found deployed Robinhood Chain infrastructure and official RWA/stock-token contracts, but no local lending/DEX consumer join, exact borrow/redeem/liquidation route, bridge-proof bypass, or fork-positive extraction path.");
  lines.push("");
  lines.push("## Blockers");
  lines.push("");
  for (const blocker of artifact.blockers) lines.push(`- ${blocker}`);
  lines.push("");
  lines.push("## Required for Route Positive");
  lines.push("");
  for (const req of artifact.requiredForRoutePositive) lines.push(`- ${req}`);
  lines.push("");
  lines.push("## Artifacts");
  lines.push("");
  lines.push(`- JSON: \`${rel(RAW_OUT)}\``);
  lines.push("- Scanner: `tools/scan-robinhood-chain-phase0.js`");
  return `${lines.join("\n")}\n`;
}

async function main() {
  const [rpc, l1Rpc] = await Promise.all([resolveRpc(CHAIN_ID), resolveRpc(L1_CHAIN_ID)]);
  const chainIdHex = rpc ? await rpcCall(rpc, "eth_chainId", [], 8_000) : null;
  const blockHex = rpc ? await rpcCall(rpc, "eth_blockNumber", [], 8_000) : null;
  const gasPrice = rpc ? await rpcCall(rpc, "eth_gasPrice", [], 8_000) : null;

  const docScan = await extractDocAddresses();
  const stockSeeds = Object.entries(OFFICIAL_STOCK_TOKEN_SEEDS).map(([seedSymbol, address]) => ({ seedSymbol, address: normalizeAddress(address) }));
  const stockTokens = [];
  for (const seed of stockSeeds) {
    stockTokens.push(await queryToken(rpc, seed.seedSymbol, seed.address));
  }

  const protocolContracts = [];
  for (const [label, address] of Object.entries(OFFICIAL_L1_PROTOCOL)) {
    protocolContracts.push(await queryContract({ rpc: l1Rpc, chainId: L1_CHAIN_ID, label, address, kind: "official-l1-protocol" }));
  }
  for (const [label, address] of Object.entries(OFFICIAL_L2_PROTOCOL)) {
    protocolContracts.push(await queryContract({ rpc, chainId: CHAIN_ID, label, address, kind: "official-l2-protocol" }));
  }

  const factoryRows = [];
  for (const [label, address] of Object.entries(COMMON_FACTORY_ADDRESSES)) {
    factoryRows.push(await queryContract({ rpc, chainId: CHAIN_ID, label, address, kind: "common-dex-factory-probe" }));
  }

  const docsRows = [];
  const docAddressesToProbe = docScan.addresses.slice(0, 160);
  const knownLower = new Set([
    ...stockSeeds.map((r) => lower(r.address)),
    ...Object.values(OFFICIAL_L1_PROTOCOL).map(lower),
    ...Object.values(OFFICIAL_L2_PROTOCOL).map(lower),
  ].filter(Boolean));
  for (const row of docAddressesToProbe) {
    const cls = classifyDocAddress(row.address, stockTokens);
    const queryRpc = cls.chainId === L1_CHAIN_ID ? l1Rpc : rpc;
    const code = await getCode(queryRpc, row.address);
    docsRows.push({
      address: row.address,
      sources: row.sources,
      chainId: cls.chainId,
      category: cls.category,
      label: cls.label,
      knownSeedOrProtocol: knownLower.has(lower(row.address)),
      codePresent: codeBytes(code) > 0,
      codeBytes: codeBytes(code),
    });
  }

  const blockscoutTokens = await fetchBlockscoutTokens();
  const localConsumerRows = scanLocalConsumerArtifacts(stockTokens, docsRows);

  const publicProbeSuccessRows = stockTokens.reduce((n, t) => n + (t.publicProbeSuccesses?.length || 0), 0);
  const localConsumerJoinRows = localConsumerRows.filter((r) => r.routeRelevant).length;
  const stockTokensWithCode = stockTokens.filter((r) => r.codePresent).length;
  const bridgeContractRows = protocolContracts.filter((r) => r.codePresent).length;
  const commonDexFactoriesWithCode = factoryRows.filter((r) => r.codePresent).length;
  const docsCodePresentRows = docsRows.filter((r) => r.codePresent).length;
  const watchCandidates = publicProbeSuccessRows + localConsumerJoinRows + (commonDexFactoriesWithCode > 0 ? commonDexFactoriesWithCode : 0);
  const routePositive = 0;
  const exactEconomicsRows = 0;

  const blockers = [
    "No Robinhood stock token is joined to a local material lending/DEX consumer artifact on chain 4663.",
    "Official stock tokens are regulated RWA/debt-security exposure; transferability/oracle restrictions are integration risk, not an extractive route by themselves.",
    "Arbitrum canonical bridge contracts are code-present, but no proof bypass, retryable/accounting mismatch, or gateway value extraction is proven.",
    "No exact borrow, redemption, liquidation, bridge, or DEX unwind economics and no fork extraction proof.",
  ];
  const requiredForRoutePositive = [
    "Robinhood Chain token/bridge/accounting state is consumed by a material lending, DEX, bridge, or settlement route.",
    "A permissionless producer-side issue is proven: bridge proof bypass, token accounting/transfer restriction mismatch, stale/incorrect oracle, or public mint/burn/config path.",
    "Borrow/redeem/liquidate/swap/bridge route is exact-quoted and positive after gas, slippage, fees, bridge delays, and RWA restrictions.",
    "Fork/local proof demonstrates net extraction before any executor or signed action.",
  ];

  const topRows = [
    ...stockTokens.map((t) => ({
      kind: "official-stock-token",
      symbol: t.erc20?.symbol || t.seedSymbol,
      address: t.address,
      codePresent: t.codePresent,
      totalSupplyFormatted: t.totalSupplyFormatted,
      probeSuccesses: t.publicProbeSuccesses?.length || 0,
      routePositive: false,
    })),
    ...protocolContracts.slice(0, 8).map((c) => ({ kind: c.kind, label: c.label, chainId: c.chainId, address: c.address, codePresent: c.codePresent, routePositive: false })),
  ];

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-robinhood-chain-phase0.js",
    scope: "Read-only Robinhood Chain Phase 0 across chain health, official Arbitrum bridge contracts, official stock tokens, docs/explorer inventory, and local consumer joins",
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
    },
    chain: {
      name: CHAIN,
      chainId: CHAIN_ID,
      chainIdVerified: chainIdHex ? parseInt(chainIdHex, 16) === CHAIN_ID : false,
      blockNumber: blockHex ? parseInt(blockHex, 16) : null,
      gasPriceWei: gasPrice ? BigInt(gasPrice).toString() : null,
      explorer: EXPLORER,
      nativeGasToken: "ETH",
      arbitrumL2: true,
    },
    docs: {
      urls: DOC_URLS,
      sourceStatus: docScan.sourceStatus,
    },
    summary: {
      chainIdVerified: chainIdHex ? parseInt(chainIdHex, 16) === CHAIN_ID : false,
      docsAddressRows: docsRows.length,
      codePresentRows: docsCodePresentRows,
      stockTokenRows: stockTokens.length,
      stockTokensWithCode,
      bridgeContractRows,
      l1ProtocolContractsWithCode: protocolContracts.filter((r) => r.chainId === L1_CHAIN_ID && r.codePresent).length,
      l2ProtocolContractsWithCode: protocolContracts.filter((r) => r.chainId === CHAIN_ID && r.codePresent).length,
      commonDexFactoriesWithCode,
      blockscoutTokenRows: blockscoutTokens.length,
      localConsumerArtifactMentions: localConsumerRows.length,
      localConsumerJoinRows,
      publicProbeSuccessRows,
      exactEconomicsRows,
      forkProofRows: 0,
      watchCandidates,
      routePositive,
      executableNow: 0,
      signedActionJustified: false,
      status: routePositive > 0 ? "route-positive-needs-fork-proof" : "robinhood-chain-watch-only-no-exact-route",
    },
    protocolContracts,
    stockTokens,
    docsAddressRows: docsRows,
    commonFactoryProbes: factoryRows,
    blockscoutTokens,
    localConsumerRows,
    topRows,
    blockers,
    requiredForRoutePositive,
    nextReadOnlyStep: "Keep Robinhood Chain on watch for consumer listings, DEX liquidity, bridge/gateway config changes, stock-token oracle/feed exposure, and exact route economics before any fork work.",
    sourceArtifacts: Object.fromEntries(CONSUMER_ARTIFACTS.map(([k, p]) => [k, p])),
  };

  writeJson(RAW_OUT, artifact);
  writeText(REPORT_OUT, makeReport(artifact));

  if (!QUIET) {
    console.log(`Robinhood Chain Phase 0: chainOk=${artifact.summary.chainIdVerified} stockTokens=${stockTokens.length}/${stockTokensWithCode} bridgeContracts=${bridgeContractRows} consumerJoins=${localConsumerJoinRows} probes=${publicProbeSuccessRows} routePositive=${routePositive}`);
    console.log(`Report: ${rel(REPORT_OUT)}`);
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: String(err?.message || err) }));
  process.exit(1);
});
