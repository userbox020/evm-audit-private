#!/usr/bin/env node
"use strict";

// Read-only, fixed-head resolver for the bounded candidates published by the
// legacy small-cap oracle scan. RPC inventory values remain in memory and are
// never logged or serialized.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
let ethers;
try { ({ ethers } = require("ethers")); } catch (_) { ({ ethers } = require("./node_modules/ethers")); }
const sharedRpc = require("./shared-rpc");

const ROOT = path.resolve(__dirname, "..");
const REL = {
  scanner: "tools/scan-small-cap-oracle-current-paths.js",
  legacy: "reports/raw/fast/small-cap-oracle-manipulation-routes.json",
  raw: "reports/raw/fast/small-cap-oracle-current-paths.json",
  report: "reports/small-cap-oracle-current-paths-triage.md",
  manifest: "reports/raw/fast/small-cap-oracle-current-paths.manifest.json",
  definitions: "reports/raw/fast/small-cap-oracle-current-paths-definitions.json",
  sources: "reports/raw/fast/small-cap-oracle-current-paths-source-snapshots.json",
  handoff: "coordination/handoffs/small-cap-oracle-current-paths-handoff.md",
};
const abs = (p) => path.join(ROOT, ...p.split("/"));
const QUIET = process.argv.includes("--quiet");
const VERIFY = process.argv.includes("--verify");
const SELF_TEST = process.argv.includes("--self-test");
const TIMEOUT_MS = 12_000;
const ZERO = ethers.ZeroAddress;
const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const CURRENT_CAPO = "0x91359Ce8989CB610A4127777828E667F23b94ee9";
const STAGING_BASE = "reports/raw/fast/.small-cap-oracle-current-paths-staging";
const GENERATION_LOCK = "reports/raw/fast/.small-cap-oracle-current-paths.lock";
const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_BEACON = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const SOURCE_FILES = [
  "targets/compound-comet/contracts/Comet.sol",
  "targets/compound-comet/contracts/pricefeeds/WstETHPriceFeed.sol",
  "targets/compound-comet/contracts/IWstETH.sol",
  "targets/euler-oracle/src/EulerRouter.sol",
  "targets/euler-oracle/src/adapter/CrossAdapter.sol",
  "targets/euler-oracle/src/adapter/chainlink/ChainlinkOracle.sol",
  "targets/euler-oracle/src/adapter/uniswap/UniswapV3Oracle.sol",
  "targets/euler-oracle/src/adapter/fixed/FixedRateOracle.sol",
  "targets/morpho-blue/src/interfaces/IMorpho.sol",
  "targets/morpho-blue-oracles/src/morpho-chainlink/MorphoChainlinkOracleV2.sol",
  "tools/shared-rpc.js",
  "tools/node_modules/ethers/package.json",
  "targets/compound-comet/contracts/pricefeeds/ConstantPriceFeed.sol",
];

const ABI = {
  comet: new ethers.Interface([
    "function getAssetInfoByAddress(address) view returns (uint8 offset,address asset,address priceFeed,uint64 scale,uint64 borrowCollateralFactor,uint64 liquidateCollateralFactor,uint64 liquidationFactor,uint128 supplyCap)",
    "function baseToken() view returns (address)", "function numAssets() view returns (uint8)",
  ]),
  evault: new ethers.Interface([
    "function oracle() view returns (address)", "function unitOfAccount() view returns (address)",
    "function asset() view returns (address)", "function cash() view returns (uint256)",
    "function totalBorrows() view returns (uint256)", "function LTVBorrow(address) view returns (uint16)",
  ]),
  router: new ethers.Interface([
    "function getConfiguredOracle(address,address) view returns (address)",
    "function resolvedVaults(address) view returns (address)", "function fallbackOracle() view returns (address)",
  ]),
  morpho: new ethers.Interface([
    "function idToMarketParams(bytes32) view returns (address loanToken,address collateralToken,address oracle,address irm,uint256 lltv)",
    "function market(bytes32) view returns (uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee)",
  ]),
  erc20: new ethers.Interface(["function decimals() view returns (uint8)", "function balanceOf(address) view returns (uint256)"]),
  beacon: new ethers.Interface(["function implementation() view returns (address)"]),
};

const PROBES = {
  name: "function name() view returns (string)", description: "function description() view returns (string)",
  decimals: "function decimals() view returns (uint8)", latestRoundData: "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  aggregator: "function aggregator() view returns (address)", feed: "function feed() view returns (address)",
  base: "function base() view returns (address)", quote: "function quote() view returns (address)", cross: "function cross() view returns (address)",
  oracleBaseCross: "function oracleBaseCross() view returns (address)", oracleCrossQuote: "function oracleCrossQuote() view returns (address)",
  pool: "function pool() view returns (address)", tokenA: "function tokenA() view returns (address)", tokenB: "function tokenB() view returns (address)",
  fee: "function fee() view returns (uint24)", twapWindow: "function twapWindow() view returns (uint32)", rate: "function rate() view returns (uint256)",
  asset: "function asset() view returns (address)", convertToAssets: "function convertToAssets(uint256) view returns (uint256)",
  stETHtoETHPriceFeed: "function stETHtoETHPriceFeed() view returns (address)", wstETH: "function wstETH() view returns (address)",
  underlyingPriceFeed: "function underlyingPriceFeed() view returns (address)", priceFeedA: "function priceFeedA() view returns (address)",
  priceFeedB: "function priceFeedB() view returns (address)", rateProvider: "function rateProvider() view returns (address)", ratioProvider: "function ratioProvider() view returns (address)",
  assetToBaseAggregator: "function assetToBaseAggregator() view returns (address)", marketAggregator: "function marketAggregator() view returns (address)",
  stEthPerToken: "function stEthPerToken() view returns (uint256)", tokensPerStEth: "function tokensPerStEth() view returns (uint256)",
  getStETHByWstETH: "function getStETHByWstETH(uint256) view returns (uint256)",
  constantPrice: "function constantPrice() view returns (int256)",
  BASE_VAULT: "function BASE_VAULT() view returns (address)", BASE_VAULT_CONVERSION_SAMPLE: "function BASE_VAULT_CONVERSION_SAMPLE() view returns (uint256)",
  QUOTE_VAULT: "function QUOTE_VAULT() view returns (address)", QUOTE_VAULT_CONVERSION_SAMPLE: "function QUOTE_VAULT_CONVERSION_SAMPLE() view returns (uint256)",
  BASE_FEED_1: "function BASE_FEED_1() view returns (address)", BASE_FEED_2: "function BASE_FEED_2() view returns (address)",
  QUOTE_FEED_1: "function QUOTE_FEED_1() view returns (address)", QUOTE_FEED_2: "function QUOTE_FEED_2() view returns (address)",
  SCALE_FACTOR: "function SCALE_FACTOR() view returns (uint256)",
  token0: "function token0() view returns (address)", token1: "function token1() view returns (address)",
  getReserves: "function getReserves() view returns (uint112,uint112,uint32)", liquidity: "function liquidity() view returns (uint128)",
  slot0: "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)",
  getPoolId: "function getPoolId() view returns (bytes32)", getVault: "function getVault() view returns (address)",
  coins0: "function coins(uint256) view returns (address)", balances0: "function balances(uint256) view returns (uint256)",
};

function sha(data) { return crypto.createHash("sha256").update(data).digest("hex"); }
function fileBinding(rel) { const b = fs.readFileSync(abs(rel)); return { file: rel, bytes: b.length, sha256: sha(b) }; }
function physicalBinding(file, rel) { const b = fs.readFileSync(file); return { file: rel, bytes: b.length, sha256: sha(b) }; }
function writeJson(rel, value) { fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), `${JSON.stringify(value, null, 2)}\n`); }
function writeJsonAt(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
function stagePath(stageRoot, rel) { return path.join(stageRoot, ...rel.split("/")); }
function norm(v) { try { return ethers.getAddress(v); } catch (_) { return null; } }
function addrFromWord(v) { const s = String(v || ""); return /^0x[0-9a-fA-F]{64}$/.test(s) ? norm(`0x${s.slice(-40)}`) : null; }
function hexNum(n) { return `0x${BigInt(n).toString(16)}`; }
function asSafe(v) { const n = Number(v); return Number.isSafeInteger(n) ? n : String(v); }
function sanitizeText(v) { return String(v || "").replace(/https?:\/\/[^\s'\"<>]+/gi, "[redacted-url]").slice(0, 180); }
function countBy(rows, key) { return rows.filter(key).length; }

function selectCandidates(legacy) {
  const rows = legacy.rows || [];
  const compound = rows.filter((r) => r.protocol === "Compound Comet" && r.chainId === 1 && r.collateral?.symbol === "wstETH" && r.borrowAsset?.symbol === "WETH").slice(0, 1);
  const morpho = rows.filter((r) => r.protocol === "Morpho Blue" && ((r.chainId === 1 && r.collateral?.symbol === "wJAAA" && r.borrowAsset?.symbol === "USDC") || (r.chainId === 8453 && r.collateral?.symbol === "WETH" && r.borrowAsset?.symbol === "USDC"))).slice(0, 2);
  const euler = rows.filter((r) => r.protocol === "Euler EVK").slice(0, 14);
  return [...compound, ...morpho, ...euler].map((r, i) => ({ ...r, candidateIndex: i }));
}

function resolveRouterFixture(f, initialBase, quote) {
  let base = initialBase; const edges = [];
  for (let depth = 0; depth < 8; depth++) {
    if (!base || !quote) return { resolved: false, terminal: null, edges, failure: "missing-base-or-quote" };
    if (base.toLowerCase() === quote.toLowerCase()) return { resolved: true, terminal: "identity", edges, failure: null };
    const key = [base.toLowerCase(), quote.toLowerCase()].sort().join(":");
    if (f.configured?.[key]) { edges.push({ type: "configured", oracle: f.configured[key] }); return { resolved: true, terminal: f.configured[key], edges, failure: null }; }
    if (f.resolvedVaults?.[base.toLowerCase()]) { const next = f.resolvedVaults[base.toLowerCase()]; edges.push({ type: "erc4626", from: base, to: next }); base = next; continue; }
    if (f.fallback) { edges.push({ type: "fallback", oracle: f.fallback }); return { resolved: true, terminal: f.fallback, edges, failure: null }; }
    return { resolved: false, terminal: null, edges, failure: "no-config-vault-or-fallback" };
  }
  return { resolved: false, terminal: null, edges, failure: "depth-limit" };
}

function runSelfTests() {
  const a = "0x0000000000000000000000000000000000000001", b = "0x0000000000000000000000000000000000000002";
  const c = "0x0000000000000000000000000000000000000003", o = "0x0000000000000000000000000000000000000004";
  const key = [a, b].sort().join(":");
  const direct = resolveRouterFixture({ configured: { [key]: o } }, a, b);
  const vault = resolveRouterFixture({ configured: { [[c, b].sort().join(":")]: o }, resolvedVaults: { [a]: c } }, a, b);
  const fallback = resolveRouterFixture({ fallback: o }, a, b);
  const missing = resolveRouterFixture({}, null, b);
  if (!direct.resolved || vault.edges[0]?.type !== "erc4626" || !fallback.resolved || missing.terminal !== null || missing.resolved) throw new Error("recursive resolver/null propagation fixture failed");
  return { passed: 4, names: ["direct-config", "resolved-vault-recursion", "fallback", "null-propagation"] };
}

class Rpc {
  constructor(url, chainId, metrics) { this.url = url; this.chainId = chainId; this.metrics = metrics; }
  async send(method, params, ms = TIMEOUT_MS) {
    const start = Date.now(); this.metrics.requests++;
    const out = await sharedRpc.rpcCall(this.url, method, params, ms);
    this.metrics.latencyMs += Date.now() - start;
    if (out === null) this.metrics.failures++;
    return out;
  }
  async call(to, iface, fn, args, block) {
    const selector = iface.getFunction(fn).selector;
    let data;
    try { data = iface.encodeFunctionData(fn, args || []); } catch (e) { return { ok: false, selector, failure: "encode-failed" }; }
    const raw = await this.send("eth_call", [{ to, data }, hexNum(block)]);
    if (!raw) return { ok: false, selector, failure: "rpc-null-or-revert" };
    try { return { ok: true, selector, raw, value: iface.decodeFunctionResult(fn, raw) }; }
    catch (_) { return { ok: false, selector, raw, failure: "decode-failed" }; }
  }
}

async function endpointFor(chainId, validationAddress) {
  const inventory = sharedRpc.loadRpcUrls();
  const candidates = [...inventory];
  if (sharedRpc.PUBLIC_FALLBACKS[chainId] && !candidates.includes(sharedRpc.PUBLIC_FALLBACKS[chainId])) candidates.push(sharedRpc.PUBLIC_FALLBACKS[chainId]);
  const metrics = { inventoryRead: true, inventoryCandidates: inventory.length, candidatesTried: 0, requests: 0, failures: 0, latencyMs: 0, selected: false };
  for (const url of candidates) {
    metrics.candidatesTried++;
    const rpc = new Rpc(url, chainId, metrics);
    const id = await rpc.send("eth_chainId", [], 5_000);
    if (!id || Number(BigInt(id)) !== chainId) continue;
    const latest = await rpc.send("eth_getBlockByNumber", ["latest", false]);
    if (!latest?.number || !latest?.hash) continue;
    const fixed = Number(BigInt(latest.number));
    const code = await rpc.send("eth_getCode", [validationAddress, hexNum(fixed)]);
    const archiveAt = Math.max(1, fixed - 1024);
    const archiveCode = await rpc.send("eth_getCode", [validationAddress, hexNum(archiveAt)]);
    if (!code || code === "0x" || archiveCode === null) continue;
    if (chainId === 1) {
      const traceProbe = await rpc.send("debug_traceCall", [{ to: validationAddress, data: ABI.comet.encodeFunctionData("baseToken", []) }, hexNum(fixed), { tracer: "callTracer" }], 15_000);
      if (!traceProbe) continue;
    }
    metrics.selected = true;
    return { rpc, metrics, head: { chainId, number: fixed, hash: latest.hash, timestamp: Number(BigInt(latest.timestamp)), iso: new Date(Number(BigInt(latest.timestamp)) * 1000).toISOString(), archiveValidation: { blockNumber: archiveAt, historicalCodeRead: archiveCode !== null }, validationCodeHash: ethers.keccak256(code) } };
  }
  return { rpc: null, metrics, head: null };
}

async function inspectContract(ctx, address) {
  address = norm(address);
  if (!address) return { address: null, codePresent: false, failure: "invalid-address" };
  const code = await ctx.rpc.send("eth_getCode", [address, hexNum(ctx.head.number)]);
  if (!code || code === "0x") return { address, codePresent: false, failure: "no-code-at-fixed-head" };
  const implRaw = await ctx.rpc.send("eth_getStorageAt", [address, EIP1967_IMPL, hexNum(ctx.head.number)]);
  const beaconRaw = await ctx.rpc.send("eth_getStorageAt", [address, EIP1967_BEACON, hexNum(ctx.head.number)]);
  const implementation = addrFromWord(implRaw);
  const beacon = addrFromWord(beaconRaw);
  let beaconImplementation = null;
  let beaconImplementationCodeHash = null;
  if (beacon && beacon !== ZERO) {
    const beaconCall = await ctx.rpc.call(beacon, ABI.beacon, "implementation", [], ctx.head.number);
    beaconImplementation = beaconCall.ok ? norm(beaconCall.value[0]) : null;
    if (beaconImplementation && beaconImplementation !== ZERO) {
      const beaconImplCode = await ctx.rpc.send("eth_getCode", [beaconImplementation, hexNum(ctx.head.number)]);
      beaconImplementationCodeHash = beaconImplCode && beaconImplCode !== "0x" ? ethers.keccak256(beaconImplCode) : null;
    }
  }
  let implementationCodeHash = null;
  if (implementation && implementation !== ZERO) {
    const implCode = await ctx.rpc.send("eth_getCode", [implementation, hexNum(ctx.head.number)]);
    implementationCodeHash = implCode && implCode !== "0x" ? ethers.keccak256(implCode) : null;
  }
  return { address, codePresent: true, codeBytes: (code.length - 2) / 2, codeHash: ethers.keccak256(code), proxy: Boolean((implementation && implementation !== ZERO) || (beacon && beacon !== ZERO)), implementation: implementation && implementation !== ZERO ? implementation : beaconImplementation, implementationCodeHash: implementationCodeHash || beaconImplementationCodeHash, beacon: beacon && beacon !== ZERO ? beacon : null, blockNumber: ctx.head.number, blockHash: ctx.head.hash };
}

async function probe(ctx, address, key, args = []) {
  if (!PROBES[key]) throw new Error(`missing probe ABI definition: ${key}`);
  const iface = new ethers.Interface([PROBES[key]]);
  const fn = iface.fragments[0].name;
  const r = await ctx.rpc.call(address, iface, fn, args, ctx.head.number);
  let value = null;
  if (r.ok) {
    const v = r.value.length === 1 ? r.value[0] : [...r.value];
    if (typeof v === "bigint") value = v.toString();
    else if (Array.isArray(v)) value = v.map((x) => typeof x === "bigint" ? x.toString() : x);
    else value = v;
  }
  return { selector: r.selector, ok: r.ok, returnData: r.raw || null, value, failure: r.failure || null };
}

function graphFlags(node) {
  const all = [];
  (function walk(n) { if (!n) return; all.push(n); for (const c of n.children || []) walk(c); })(node);
  return {
    graphContainsChainlinkNode: all.some((n) => n.classification === "chainlink"),
    graphContainsDexNode: all.some((n) => ["uniswap-v2", "uniswap-v3", "curve", "balancer"].includes(n.classification)),
    graphContainsERC4626Node: all.some((n) => n.classification === "erc4626-conversion"),
    graphContainsConversionNode: all.some((n) => ["conversion-feed", "ratio-provider-conversion", "compound-capo"].includes(n.classification)),
    unresolved: all.some((n) => n.classification === "unknown" || n.failure),
  };
}

async function classifyContract(ctx, address, options = {}, depth = 0, visited = new Set()) {
  const info = await inspectContract(ctx, address);
  const node = { ...info, classification: "unknown", name: null, evidence: {}, children: [], failure: info.failure || null };
  if (!info.codePresent || depth > 7) { if (depth > 7) node.failure = "classification-depth-limit"; return node; }
  const key = info.address.toLowerCase();
  if (visited.has(key)) { node.failure = "cycle-detected"; return node; }
  const nextVisited = new Set(visited); nextVisited.add(key);
  const [name, description] = await Promise.all([probe(ctx, info.address, "name"), probe(ctx, info.address, "description")]);
  node.name = name.ok ? String(name.value) : description.ok ? String(description.value) : null;
  node.evidence.name = name; node.evidence.description = description;

  if (node.name === "EulerRouter") { node.classification = "router"; return node; }
  if (node.name === "CrossAdapter") {
    node.classification = "cross-adapter";
    for (const ref of ["base", "cross", "quote", "oracleBaseCross", "oracleCrossQuote"]) node.evidence[ref] = await probe(ctx, info.address, ref);
    for (const ref of ["oracleBaseCross", "oracleCrossQuote"]) if (node.evidence[ref].ok && norm(node.evidence[ref].value)) node.children.push(await classifyContract(ctx, node.evidence[ref].value, {}, depth + 1, nextVisited));
    return node;
  }
  if (/Chainlink/i.test(node.name || "")) {
    node.classification = "chainlink-adapter";
    for (const ref of ["base", "quote", "feed"]) node.evidence[ref] = await probe(ctx, info.address, ref);
    if (node.evidence.feed.ok && norm(node.evidence.feed.value)) node.children.push(await classifyContract(ctx, node.evidence.feed.value, {}, depth + 1, nextVisited));
    return node;
  }
  if (node.name === "UniswapV3Oracle") {
    node.classification = "dex-adapter";
    for (const ref of ["tokenA", "tokenB", "fee", "twapWindow", "pool"]) node.evidence[ref] = await probe(ctx, info.address, ref);
    if (node.evidence.pool.ok && norm(node.evidence.pool.value)) node.children.push(await classifyContract(ctx, node.evidence.pool.value, { forcePool: true }, depth + 1, nextVisited));
    return node;
  }
  if (node.name === "FixedRateOracle") {
    node.classification = "fixed"; for (const ref of ["base", "quote", "rate"]) node.evidence[ref] = await probe(ctx, info.address, ref); return node;
  }

  const morphoKeys = ["BASE_VAULT", "BASE_VAULT_CONVERSION_SAMPLE", "QUOTE_VAULT", "QUOTE_VAULT_CONVERSION_SAMPLE", "BASE_FEED_1", "BASE_FEED_2", "QUOTE_FEED_1", "QUOTE_FEED_2", "SCALE_FACTOR"];
  const morphoEvidence = {};
  for (const k of morphoKeys) morphoEvidence[k] = await probe(ctx, info.address, k);
  if (morphoEvidence.SCALE_FACTOR.ok && morphoEvidence.BASE_VAULT.ok) {
    node.classification = "morpho-chainlink-v2"; Object.assign(node.evidence, morphoEvidence);
    for (const k of ["BASE_VAULT", "QUOTE_VAULT"]) {
      const a = norm(morphoEvidence[k].value); if (a && a !== ZERO) node.children.push(await classifyContract(ctx, a, { forceVault: true }, depth + 1, nextVisited));
    }
    for (const k of ["BASE_FEED_1", "BASE_FEED_2", "QUOTE_FEED_1", "QUOTE_FEED_2"]) {
      const a = norm(morphoEvidence[k].value); if (a && a !== ZERO) node.children.push(await classifyContract(ctx, a, {}, depth + 1, nextVisited));
    }
    return node;
  }

  const [latest, token0, token1, reserves, liquidity, poolId, vault, coins0] = await Promise.all([
    probe(ctx, info.address, "latestRoundData"), probe(ctx, info.address, "token0"), probe(ctx, info.address, "token1"),
    probe(ctx, info.address, "getReserves"), probe(ctx, info.address, "liquidity"), probe(ctx, info.address, "getPoolId"),
    probe(ctx, info.address, "getVault"), probe(ctx, info.address, "coins0", [0]),
  ]);
  if (latest.ok) {
    const aggregatorProbe = await probe(ctx, info.address, "aggregator");
    const constantPriceProbe = await probe(ctx, info.address, "constantPrice");
    const isConversion = /wstETH|Custom price feed|CAPO/i.test(node.name || "");
    const isIdentifiedChainlink = aggregatorProbe.ok || /Chainlink|(?:ETH|USD|BTC|USDC|USDT)\s*\/\s*(?:ETH|USD|BTC|USDC|USDT)/i.test(node.name || "");
    node.classification = constantPriceProbe.ok ? "fixed" : isConversion ? "conversion-feed" : isIdentifiedChainlink ? "chainlink" : "unknown";
    node.evidence.latestRoundData = latest; node.evidence.decimals = await probe(ctx, info.address, "decimals");
    node.evidence.constantPrice = constantPriceProbe;
    for (const ref of ["aggregator", "stETHtoETHPriceFeed", "underlyingPriceFeed", "priceFeedA", "priceFeedB"]) {
      const p = ref === "aggregator" ? aggregatorProbe : await probe(ctx, info.address, ref); node.evidence[ref] = p;
      if (p.ok && norm(p.value) && norm(p.value) !== info.address) node.children.push(await classifyContract(ctx, p.value, {}, depth + 1, nextVisited));
    }
    if (node.classification === "conversion-feed") node.evidence.wstETH = await probe(ctx, info.address, "wstETH");
    if (node.classification === "fixed") node.sourceBinding = { status: "exact-getter-and-local-source-bound", localSource: "targets/compound-comet/contracts/pricefeeds/ConstantPriceFeed.sol", codeHash: info.codeHash };
    if (node.classification === "unknown") node.failure = "latestRoundData-compatible source is custom/unverified";
    return node;
  }
  if (token0.ok && token1.ok && reserves.ok) { node.classification = "uniswap-v2"; Object.assign(node.evidence, { token0, token1, getReserves: reserves }); return node; }
  if (token0.ok && token1.ok && liquidity.ok) { node.classification = "uniswap-v3"; Object.assign(node.evidence, { token0, token1, liquidity, slot0: await probe(ctx, info.address, "slot0") }); return node; }
  if (poolId.ok && vault.ok) { node.classification = "balancer"; Object.assign(node.evidence, { getPoolId: poolId, getVault: vault }); return node; }
  if (coins0.ok) { node.classification = "curve"; Object.assign(node.evidence, { coins0, balances0: await probe(ctx, info.address, "balances0", [0]) }); return node; }
  const asset = await probe(ctx, info.address, "asset");
  if (options.forceVault && asset.ok) {
    node.classification = "erc4626-conversion"; node.evidence.asset = asset;
    const decimals = await probe(ctx, info.address, "decimals"); const sample = decimals.ok ? 10n ** BigInt(decimals.value) : 10n ** 18n;
    node.evidence.convertToAssets = await probe(ctx, info.address, "convertToAssets", [sample]); return node;
  }
  for (const ref of ["feed", "pool", "underlyingPriceFeed", "priceFeedA", "priceFeedB", "rateProvider"]) {
    const p = await probe(ctx, info.address, ref); node.evidence[ref] = p;
    if (p.ok && norm(p.value) && norm(p.value) !== info.address) node.children.push(await classifyContract(ctx, p.value, ref === "pool" ? { forcePool: true } : {}, depth + 1, nextVisited));
  }
  return node;
}

async function resolveEulerRouter(ctx, router, base, quote) {
  const routerInfo = await inspectContract(ctx, router);
  const out = { router: routerInfo, initialBase: norm(base), quote: norm(quote), calls: [], edges: [], terminalOracle: null, terminal: null, resolved: false, failure: null };
  let current = norm(base); const q = norm(quote);
  if (!current || !q) { out.failure = !current ? "missing-collateral-base-address" : "missing-unit-of-account"; return out; }
  for (let depth = 0; depth < 8; depth++) {
    if (current.toLowerCase() === q.toLowerCase()) { out.resolved = true; out.terminal = { classification: "identity", children: [] }; return out; }
    const configured = await ctx.rpc.call(router, ABI.router, "getConfiguredOracle", [current, q], ctx.head.number);
    out.calls.push({ method: "getConfiguredOracle", base: current, quote: q, selector: configured.selector, returnData: configured.raw || null, success: configured.ok, failure: configured.failure || null });
    const configuredOracle = configured.ok ? norm(configured.value[0]) : null;
    if (configuredOracle && configuredOracle !== ZERO) {
      out.edges.push({ type: "configured", base: current, quote: q, oracle: configuredOracle }); out.terminalOracle = configuredOracle;
      out.terminal = await classifyContract(ctx, configuredOracle); const flags = graphFlags(out.terminal); out.resolved = !flags.unresolved; if (!out.resolved) out.failure = "reached-adapter-has-unresolved-edge"; return out;
    }
    const vault = await ctx.rpc.call(router, ABI.router, "resolvedVaults", [current], ctx.head.number);
    out.calls.push({ method: "resolvedVaults", vault: current, selector: vault.selector, returnData: vault.raw || null, success: vault.ok, failure: vault.failure || null });
    const underlying = vault.ok ? norm(vault.value[0]) : null;
    if (underlying && underlying !== ZERO) {
      const conversion = await classifyContract(ctx, current, { forceVault: true });
      out.edges.push({ type: "erc4626", vault: current, asset: underlying, conversion }); current = underlying; continue;
    }
    const fallback = await ctx.rpc.call(router, ABI.router, "fallbackOracle", [], ctx.head.number);
    out.calls.push({ method: "fallbackOracle", selector: fallback.selector, returnData: fallback.raw || null, success: fallback.ok, failure: fallback.failure || null });
    const fallbackOracle = fallback.ok ? norm(fallback.value[0]) : null;
    if (fallbackOracle && fallbackOracle !== ZERO) {
      out.edges.push({ type: "fallback", base: current, quote: q, oracle: fallbackOracle }); out.terminalOracle = fallbackOracle;
      out.terminal = await classifyContract(ctx, fallbackOracle); const flags = graphFlags(out.terminal); out.resolved = !flags.unresolved; if (!out.resolved) out.failure = "fallback-adapter-has-unresolved-edge"; return out;
    }
    out.failure = "router-no-config-resolved-vault-or-fallback"; return out;
  }
  out.failure = "router-resolution-depth-limit"; return out;
}

function compactTraceCall(node, depth = 0) {
  if (!node || depth > 8) return null;
  return {
    type: node.type || null,
    to: norm(node.to),
    selector: typeof node.input === "string" && node.input.length >= 10 ? node.input.slice(0, 10) : null,
    error: node.error ? sanitizeText(node.error) : null,
    calls: (node.calls || []).map((c) => compactTraceCall(c, depth + 1)).filter(Boolean),
  };
}

async function classifyRatioProvider(ctx, address) {
  const info = await inspectContract(ctx, address);
  const node = { ...info, classification: "ratio-provider-conversion", name: null, evidence: {}, children: [], failure: info.failure || null };
  if (!info.codePresent) return node;
  node.evidence.stEthPerToken = await probe(ctx, info.address, "stEthPerToken");
  node.evidence.tokensPerStEth = await probe(ctx, info.address, "tokensPerStEth");
  node.evidence.getStETHByWstETHOneToken = await probe(ctx, info.address, "getStETHByWstETH", [10n ** 18n]);
  if (!node.evidence.stEthPerToken.ok || !node.evidence.getStETHByWstETHOneToken.ok) node.failure = "ratio-provider exact conversion ABI calls failed";
  node.sourceBinding = { status: "runtime-and-local-interface-bound", localInterface: "targets/compound-comet/contracts/IWstETH.sol", requiredGetter: "stEthPerToken()", codeHash: info.codeHash || null };
  return node;
}

async function resolveCompoundCapo(ctx, address) {
  const info = await inspectContract(ctx, address);
  const node = { ...info, classification: "compound-capo", name: null, evidence: {}, dependencies: {}, children: [], failure: info.failure || null, sourceBinding: null };
  if (!info.codePresent) return node;
  for (const getter of ["assetToBaseAggregator", "ratioProvider", "marketAggregator"]) node.evidence[getter] = await probe(ctx, info.address, getter);
  node.evidence.latestRoundData = await probe(ctx, info.address, "latestRoundData");
  const assetAggregator = node.evidence.assetToBaseAggregator.ok ? norm(node.evidence.assetToBaseAggregator.value) : null;
  const ratioProvider = node.evidence.ratioProvider.ok ? norm(node.evidence.ratioProvider.value) : null;
  const marketAggregator = node.evidence.marketAggregator.ok ? norm(node.evidence.marketAggregator.value) : null;
  node.dependencies = { assetToBaseAggregator: assetAggregator, ratioProvider, marketAggregator: marketAggregator === ZERO ? null : marketAggregator };
  if (assetAggregator && assetAggregator !== ZERO) node.children.push(await classifyContract(ctx, assetAggregator));
  if (ratioProvider && ratioProvider !== ZERO) node.children.push(await classifyRatioProvider(ctx, ratioProvider));
  if (marketAggregator && marketAggregator !== ZERO) node.children.push(await classifyContract(ctx, marketAggregator));

  const traceRaw = await ctx.rpc.send("debug_traceCall", [{ to: info.address, data: new ethers.Interface([PROBES.latestRoundData]).encodeFunctionData("latestRoundData", []) }, hexNum(ctx.head.number), { tracer: "callTracer" }], 30_000);
  node.runtimeCallTrace = compactTraceCall(traceRaw);
  const directCalls = node.runtimeCallTrace?.calls || [];
  const stEthSelector = new ethers.Interface([PROBES.stEthPerToken]).getFunction("stEthPerToken").selector;
  const latestSelector = new ethers.Interface([PROBES.latestRoundData]).getFunction("latestRoundData").selector;
  const ratioCallBound = directCalls.some((c) => c.to?.toLowerCase() === ratioProvider?.toLowerCase() && c.selector === stEthSelector && !c.error);
  const assetCallBound = directCalls.some((c) => c.to?.toLowerCase() === assetAggregator?.toLowerCase() && c.selector === latestSelector && !c.error);
  const expectedAddresses = new Set([ratioProvider, assetAggregator, marketAggregator].filter((a) => a && a !== ZERO).map((a) => a.toLowerCase()));
  const unknownDirectCalls = directCalls.filter((c) => c.to && !expectedAddresses.has(c.to.toLowerCase()));
  const childrenResolved = node.children.map(graphFlags).every((f) => !f.unresolved);
  const getterSetBound = node.evidence.assetToBaseAggregator.ok && node.evidence.ratioProvider.ok && node.evidence.marketAggregator.ok && node.evidence.latestRoundData.ok;
  const runtimeBound = Boolean(traceRaw && ratioCallBound && assetCallBound && unknownDirectCalls.length === 0);
  node.sourceBinding = {
    status: runtimeBound ? "exact-runtime-callgraph-bound" : "verified-source-unavailable-and-runtime-callgraph-incomplete",
    exactLocalCapoSourceAvailable: false,
    verifiedExplorerSourcePersisted: false,
    runtimeCodeHash: info.codeHash || null,
    getterSetBound,
    runtimeBound,
    ratioCallBound,
    assetAggregatorCallBound: assetCallBound,
    unknownDirectCalls: unknownDirectCalls.map((c) => ({ to: c.to, selector: c.selector })),
  };
  if (!getterSetBound || !assetAggregator || !ratioProvider || !runtimeBound || !childrenResolved) node.failure = "CAPO value-determining dependency graph not fully bound";
  return node;
}

async function compoundRow(ctx, row) {
  const comet = norm(row.consumer?.comet), collateral = norm(row.collateral?.address);
  const live = { target: "compound-weth-wsteth", protocol: row.protocol, chainId: 1, legacy: compactLegacy(row), identity: { comet, collateral }, path: null, current: {}, blockers: [], economics: null };
  live.identity.cometCode = await inspectContract(ctx, comet);
  const info = await ctx.rpc.call(comet, ABI.comet, "getAssetInfoByAddress", [collateral], ctx.head.number);
  live.current.assetInfoCall = { selector: info.selector, success: info.ok, returnData: info.raw || null, failure: info.failure || null };
  if (!info.ok) { live.blockers.push("deployed Comet getAssetInfoByAddress failed at fixed head"); return finalizeRow(live); }
  const v = info.value; const priceFeed = norm(v[2]);
  live.current.assetInfo = { offset: Number(v[0]), asset: norm(v[1]), priceFeed, scale: v[3].toString(), borrowCollateralFactor: v[4].toString(), liquidateCollateralFactor: v[5].toString(), liquidationFactor: v[6].toString(), supplyCap: v[7].toString() };
  live.path = await resolveCompoundCapo(ctx, priceFeed);
  const flags = graphFlags(live.path);
  if (flags.unresolved) live.blockers.push("configured CAPO feed confirmed, but a value-determining dependency/source edge remains unresolved");
  live.current.capo = { configuredFeedConfirmed: true, dependencies: live.path.dependencies, sourceBinding: live.path.sourceBinding };
  live.current.legacyThinPoolEdge = flags.unresolved ? null : flags.graphContainsDexNode ? "compare-exact-reached-pool" : false;
  live.outcome = flags.unresolved
    ? "current configured CAPO feed confirmed; no-edge-to-legacy-pool remains null/unproven because the dependency path is unresolved"
    : flags.graphContainsDexNode ? "current configured CAPO feed reaches an exact DEX edge requiring pool comparison" : "current CAPO value graph is fully bound and does not reach the legacy thin wstETH/DAI pool";
  return finalizeRow(live);
}

function compactLegacy(row) {
  return { candidateIndex: row.candidateIndex, marketId: row.consumer?.marketId || null, consumer: row.consumer || null, collateral: row.collateral || null, borrowAsset: row.borrowAsset || null, ltv: row.ltv ?? null, routeLiquidityUsd: row.routeLiquidityUsd ?? null, priorBestHypotheticalNetUsd: row.bestModeledPool?.economics?.modeledNetUsd ?? null };
}

function finalizeRow(row) {
  const roots = [];
  if (row.path) roots.push(row.path.terminal || row.path);
  const flags = roots.reduce((a, r) => { const f = graphFlags(r); for (const k of Object.keys(a)) a[k] ||= f[k]; return a; }, { graphContainsChainlinkNode: false, graphContainsDexNode: false, graphContainsERC4626Node: false, graphContainsConversionNode: false, unresolved: false });
  if (row.path?.edges?.some((e) => e.type === "erc4626")) flags.graphContainsERC4626Node = true;
  row.pathResolved = Boolean(row.path && (row.path.resolved !== undefined ? row.path.resolved : !flags.unresolved));
  row.graphContainsChainlinkNode = flags.graphContainsChainlinkNode;
  row.graphContainsDexNode = flags.graphContainsDexNode;
  row.graphContainsERC4626Node = flags.graphContainsERC4626Node;
  row.graphContainsConversionNode = flags.graphContainsConversionNode;
  row.unresolved = !row.pathResolved || flags.unresolved;
  row.dexOracleLinked = flags.graphContainsDexNode;
  row.routePositive = null;
  row.routeKey = deriveRouteKey(row);
  return row;
}

function deriveRouteKey(row) {
  let parts;
  if (row.protocol === "Euler EVK") parts = ["euler", row.path?.router?.address, row.path?.initialBase, row.path?.quote];
  else if (row.protocol === "Morpho Blue") parts = ["morpho", row.chainId, row.current?.marketParams?.oracle, row.current?.marketParams?.collateralToken, row.current?.marketParams?.loanToken];
  else parts = ["compound", row.chainId, row.identity?.comet, row.identity?.collateral, row.current?.assetInfo?.priceFeed];
  return parts.map((v) => String(v ?? "missing").toLowerCase()).join(":");
}

function aggregateUniqueRoutes(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const members = grouped.get(row.routeKey) || [];
    members.push(row); grouped.set(row.routeKey, members);
  }
  return [...grouped.entries()].map(([routeKey, members]) => ({
    routeKey,
    protocol: members[0].protocol,
    chainId: members[0].chainId,
    candidateRows: members.length,
    candidateIndices: members.map((r) => r.legacy?.candidateIndex),
    pathResolved: members.every((r) => r.pathResolved),
    graphContainsChainlinkNode: members.some((r) => r.graphContainsChainlinkNode),
    graphContainsDexNode: members.some((r) => r.graphContainsDexNode),
    graphContainsERC4626Node: members.some((r) => r.graphContainsERC4626Node),
    graphContainsConversionNode: members.some((r) => r.graphContainsConversionNode),
    unresolved: members.some((r) => r.unresolved),
    exactEconomics: members.some((r) => r.dexOracleLinked && r.economics !== null),
  }));
}

async function morphoRow(ctx, row) {
  const id = row.consumer?.marketId; const live = { target: row.chainId === 1 ? "morpho-wjaaa-usdc" : "morpho-base-weth-usdc", protocol: row.protocol, chainId: row.chainId, legacy: compactLegacy(row), identity: { morpho: MORPHO, marketId: id }, current: {}, path: null, blockers: [], economics: null };
  live.identity.morphoCode = await inspectContract(ctx, MORPHO);
  const [params, market] = await Promise.all([ctx.rpc.call(MORPHO, ABI.morpho, "idToMarketParams", [id], ctx.head.number), ctx.rpc.call(MORPHO, ABI.morpho, "market", [id], ctx.head.number)]);
  live.current.calls = [{ method: "idToMarketParams", selector: params.selector, success: params.ok, returnData: params.raw || null, failure: params.failure || null }, { method: "market", selector: market.selector, success: market.ok, returnData: market.raw || null, failure: market.failure || null }];
  if (!params.ok || !market.ok) { live.blockers.push("deployed Morpho market identity/state call failed at fixed head"); return finalizeRow(live); }
  const p = params.value, m = market.value; const loanDecimals = Number(row.borrowAsset?.decimals ?? 18);
  const liquidityRaw = BigInt(m[0]) > BigInt(m[2]) ? BigInt(m[0]) - BigInt(m[2]) : 0n;
  live.current.marketParams = { loanToken: norm(p[0]), collateralToken: norm(p[1]), oracle: norm(p[2]), irm: norm(p[3]), lltvRaw: p[4].toString(), lltv: Number(p[4]) / 1e18 };
  live.current.marketState = { totalSupplyAssets: m[0].toString(), totalBorrowAssets: m[2].toString(), availableBorrowLiquidityRaw: liquidityRaw.toString(), availableBorrowLiquidityTokens: Number(ethers.formatUnits(liquidityRaw, loanDecimals)), lastUpdate: asSafe(m[4]), fee: m[5].toString(), nominalUsdOnlyIfDollarPegHolds: /^(USDC|USDT|DAI|USDbC)$/i.test(row.borrowAsset?.symbol || "") ? Number(ethers.formatUnits(liquidityRaw, loanDecimals)) : null };
  live.current.identityMatchesLegacy = live.current.marketParams.loanToken?.toLowerCase() === norm(row.borrowAsset?.address)?.toLowerCase() && live.current.marketParams.collateralToken?.toLowerCase() === norm(row.collateral?.address)?.toLowerCase();
  live.path = await classifyContract(ctx, live.current.marketParams.oracle);
  const pathFlags = graphFlags(live.path);
  if (!live.current.identityMatchesLegacy) live.blockers.push("current deployed market tokens differ from legacy candidate identity");
  if (graphFlags(live.path).unresolved) live.blockers.push("oracle is custom/unverified or retains an unresolved dynamic edge");
  if (live.target === "morpho-wjaaa-usdc") {
    live.current.prior448_6kConfirmed = Math.abs(live.current.marketState.availableBorrowLiquidityTokens - 448609.365845) / 448609.365845 < 0.02;
    live.current.routeGapBps = null; live.blockers.push("route gap not recomputed: no exact linked DEX/acquisition edge reached by the deployed oracle path");
    live.outcome = `current LLTV ${(live.current.marketParams.lltv * 100).toFixed(2)}%; borrow liquidity bound in USDC units; oracle path ${pathFlags.unresolved ? "custom/unverified and unresolved" : "resolved"}`;
  } else {
    live.outcome = "prior Base hypothetical economics remain non-evidence unless the deployed oracle path reaches that exact pool";
  }
  return finalizeRow(live);
}

async function eulerRow(ctx, row) {
  const evault = norm(row.consumer?.evault), collateral = norm(row.collateral?.address);
  const live = { target: `euler-${row.candidateIndex}`, protocol: row.protocol, chainId: 1, legacy: compactLegacy(row), identity: { evault, collateral }, current: {}, path: null, blockers: [], economics: null };
  live.identity.evaultCode = await inspectContract(ctx, evault);
  const methods = [["oracle", []], ["unitOfAccount", []], ["asset", []], ["cash", []], ["totalBorrows", []], ["LTVBorrow", [collateral]]];
  const calls = {};
  for (const [fn, args] of methods) calls[fn] = await ctx.rpc.call(evault, ABI.evault, fn, args, ctx.head.number);
  live.current.calls = Object.fromEntries(Object.entries(calls).map(([k, r]) => [k, { selector: r.selector, success: r.ok, returnData: r.raw || null, failure: r.failure || null }]));
  const router = calls.oracle.ok ? norm(calls.oracle.value[0]) : null, quote = calls.unitOfAccount.ok ? norm(calls.unitOfAccount.value[0]) : null;
  live.current.market = { router, unitOfAccount: quote, asset: calls.asset.ok ? norm(calls.asset.value[0]) : null, cashRaw: calls.cash.ok ? calls.cash.value[0].toString() : null, totalBorrowsRaw: calls.totalBorrows.ok ? calls.totalBorrows.value[0].toString() : null, borrowLtvRaw: calls.LTVBorrow.ok ? calls.LTVBorrow.value[0].toString() : null, borrowLtv: calls.LTVBorrow.ok ? Number(calls.LTVBorrow.value[0]) / 1e4 : null };
  if (!router) { live.blockers.push("current eVault oracle() missing or failed"); return finalizeRow(live); }
  if (!quote) { live.blockers.push("current eVault unitOfAccount() missing or failed"); return finalizeRow(live); }
  live.path = await resolveEulerRouter(ctx, router, collateral, quote);
  if (!live.path.resolved) live.blockers.push(live.path.failure || "recursive router path unresolved");
  live.outcome = `${row.collateral?.symbol}/${row.borrowAsset?.symbol}: exact router path ${live.path.resolved ? "resolved" : "coverage-open"}`;
  return finalizeRow(live);
}

function definitions(runId) {
  return {
    schemaVersion: 1, runId,
    classifications: {
      pathResolved: "Every reached edge terminates in a classified source; no unknown, failed, cyclic, or depth-limited edge.",
      graphContainsChainlinkNode: "The graph contains a deployed Chainlink node; this does not imply the whole route is resolved.",
      graphContainsDexNode: "The graph reaches a specific deployed V2/V3/Curve/Balancer pool; absence is not proof no manipulable venue exists.",
      graphContainsERC4626Node: "The graph explicitly contains a deployed ERC4626 conversion node; it is not described as a terminal leaf.",
      unresolved: "At least one required selector, implementation, dynamic edge, or source classification remains open.",
      dexOracleLinked: "True only when the deployed path reaches the exact DEX pool/adapter whose fixed-head state is recorded.",
      routePositive: "Null unless linked acquisition/manipulation/borrow/unwind is fully assessed after fees, slippage, flash fee, and gas.",
    },
    routerSemantics: ["base==quote identity", "getConfiguredOracle(base,quote)", "resolvedVaults(base)+convertToAssets recursion", "fallbackOracle", "explicit unresolved"],
    focusedFixtures: runSelfTests(),
    countSemantics: { candidateRows: "All 17 bounded legacy candidate identities.", uniqueRoutes: "Deduplicated by protocol plus deployed router/oracle, exact base/collateral, and exact quote/loan identity." },
    safety: { readOnlyEthMethods: ["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_getStorageAt", "eth_call", "debug_traceCall"], transactions: false, signing: false, forks: false, stateMutation: false },
  };
}

function sourceSnapshots(runId) {
  return {
    schemaVersion: 1, runId,
    snapshots: SOURCE_FILES.map(fileBinding),
    semanticEvidence: [
      { file: SOURCE_FILES[0], lines: "309-389", claim: "Comet getAssetInfo/getAssetInfoByAddress returns configured collateral priceFeed." },
      { file: SOURCE_FILES[1], lines: "28-76", claim: "Context-only legacy WstETHPriceFeed semantics; not used to identify the current CAPO feed, which is bound from deployed code and selector results." },
      { file: SOURCE_FILES[2], lines: "19-22", claim: "Local exact wstETH conversion getter ABI used by the current CAPO ratioProvider runtime call graph." },
      { file: SOURCE_FILES[3], lines: "99-142", claim: "Euler router configured-oracle, resolved-vault recursion, then fallback semantics." },
      { file: SOURCE_FILES[8], lines: "308-331", claim: "Morpho deployed market state and exact market params ABI." },
      { file: SOURCE_FILES[9], lines: "21-48,149-154", claim: "MorphoChainlinkOracleV2 immutable getters and price composition." },
      { file: SOURCE_FILES[12], lines: "13-47", claim: "Exact ConstantPriceFeed ABI/source for CAPO assetToBaseAggregator, including constantPrice and latestRoundData." },
    ],
    compoundCapo: { exactLocalSourceAvailable: false, bindingPolicy: "Use deployed getter set, code hash, and sanitized fixed-head runtime call graph; unresolved if any value-determining dependency is not bound." },
  };
}

function makeReport(a) {
  const s = a.summary; const cr = s.candidateRows, ur = s.uniqueRoutes; const heads = Object.values(a.fixedHeads).map((h) => `- Chain ${h.chainId}: block \`${h.number}\`, hash \`${h.hash}\`, timestamp \`${h.iso}\`; final recheck \`${h.finalRecheckPassed}\`.`).join("\n");
  const target = (id) => a.rows.find((r) => r.target === id);
  const comp = target("compound-weth-wsteth"), wj = target("morpho-wjaaa-usdc"), base = target("morpho-base-weth-usdc");
  const material = a.rows.filter((r) => r.protocol === "Euler EVK" && /eUSDe|ePYUSD|esUSDe|esyrupUSDC/.test(r.legacy.collateral?.symbol || ""));
  return `# Small-Cap Oracle Current Paths — WATCH ONLY\n\nRun ID: \`${a.runId}\`  \nGenerated: \`${a.generatedAt}\`  \nRaw: \`${REL.raw}\`\n\n## Classification\n\n**WATCH_ONLY / COVERAGE_OPEN / NO_ROUTE_PROOF**. The authorized endpoint inventory was read only in memory; no endpoint value/domain/header/key/inventory content was persisted. No transaction, signature, fork, or mutation occurred.\n\n### Candidate-row counts\n\n| Metric | Count |\n|---|---:|\n| Candidate identities | ${cr.total} |\n| Compound / Morpho / Euler | ${s.byProtocol["Compound Comet"] || 0} / ${s.byProtocol["Morpho Blue"] || 0} / ${s.byProtocol["Euler EVK"] || 0} |\n| Fully resolved candidate rows | ${cr.pathResolved} |\n| Graph contains Chainlink node | ${cr.graphContainsChainlinkNode} |\n| Graph contains DEX node | ${cr.graphContainsDexNode} |\n| Graph contains ERC4626 node | ${cr.graphContainsERC4626Node} |\n| Unresolved candidate rows | ${cr.unresolved} |\n\n### Unique route-key counts\n\n| Metric | Count |\n|---|---:|\n| Unique route keys | ${ur.total} |\n| Fully resolved routes | ${ur.pathResolved} |\n| Graph contains Chainlink node | ${ur.graphContainsChainlinkNode} |\n| Graph contains DEX node | ${ur.graphContainsDexNode} |\n| Graph contains ERC4626 node | ${ur.graphContainsERC4626Node} |\n| Unresolved routes | ${ur.unresolved} |\n| Exact linked-DEX economics | ${ur.exactEconomicsRoutes} |\n\nA Chainlink or ERC4626 count means the graph contains that node; it does not claim that an otherwise unresolved route has a resolved terminal leaf.\n\n## Fixed heads\n\n${heads}\n\n## Required outcomes\n\n- **Compound WETH/wstETH:** ${comp?.outcome || "candidate unavailable"}. Feed \`${comp?.current?.assetInfo?.priceFeed || "unresolved"}\`; asset-to-base aggregator \`${comp?.current?.capo?.dependencies?.assetToBaseAggregator || "unresolved"}\`; ratio provider \`${comp?.current?.capo?.dependencies?.ratioProvider || "unresolved"}\`; market aggregator \`${comp?.current?.capo?.dependencies?.marketAggregator || "zero/not used"}\`; binding \`${comp?.current?.capo?.sourceBinding?.status || "unresolved"}\`.\n- **Morpho wJAAA/USDC:** ${wj?.outcome || "candidate unavailable"}. Current borrow-liquidity units: \`${wj?.current?.marketState?.availableBorrowLiquidityTokens ?? "unresolved"}\`; prior ~$448.6k confirmation: \`${wj?.current?.prior448_6kConfirmed ?? false}\`; route gap: \`${wj?.current?.routeGapBps ?? "null"}\`.\n- **Morpho Base WETH/USDC:** ${base?.outcome || "candidate unavailable"}. Legacy hypothetical best net remains \`${base?.legacy?.priorBestHypotheticalNetUsd ?? "not bound"}\`; dexOracleLinked=\`${base?.dexOracleLinked ?? false}\`.\n- **Euler material rows:** ${material.length} candidate rows; ${material.filter((r) => r.pathResolved).length} resolved and ${material.filter((r) => r.unresolved).length} coverage-open. Raw records ordered base/quote, selectors/returns, vault/fallback decisions, implementation hashes, and failures.\n\n## DEX and economics\n\nOnly exact deployed pools reached by resolved graphs qualify. Unique DEX-linked routes: \`${ur.graphContainsDexNode}\`; exact economics routes: \`${ur.exactEconomicsRoutes}\`. All other economics remain \`null\`.\n\n## Gates\n\n- positiveRouteEstablished: \`${a.gates.positiveRouteEstablished}\`\n- routePositive: \`${a.gates.routePositive}\`\n- forkJustified: \`${a.gates.forkJustified}\`\n- executableNow: \`${a.gates.executableNow}\`\n- signedActionJustified: \`${a.gates.signedActionJustified}\`\n\n## Blockers\n\n${a.blockers.map((b) => `- ${b}`).join("\n")}\n`;
}

function makeHandoff(a) {
  const u = a.summary.uniqueRoutes;
  return `# Handoff — small-cap-oracle-current-paths\n\nRun ID: \`${a.runId}\`\n\nBound outputs:\n- \`${REL.raw}\`\n- \`${REL.report}\`\n- \`${REL.definitions}\`\n- \`${REL.sources}\`\n- \`${REL.manifest}\`\n\nResult: **WATCH_ONLY / COVERAGE_OPEN / NO_ROUTE_PROOF**. ${a.summary.candidateRows.total} candidate identities map to ${u.total} unique route keys; ${u.pathResolved} routes resolve fully, ${u.unresolved} remain open, and ${u.graphContainsDexNode} reach an exact DEX node. No fork, transaction, signature, or mutation was performed.\n`;
}

function leakScan(files, physicalRoot = ROOT) {
  const patterns = [/https?:\/\//i, /\b(?:api[_-]?key|private[_-]?key|authorization|bearer)\b/i];
  const allowed = new Set([REL.scanner]);
  const failures = [];
  for (const f of files) {
    if (allowed.has(f)) continue;
    const text = fs.readFileSync(path.join(physicalRoot, ...f.split("/")), "utf8");
    for (const p of patterns) if (p.test(text)) failures.push({ file: f, pattern: String(p) });
  }
  return failures;
}

function summarize(rows, uniqueRoutes) {
  const byProtocol = {}; for (const r of rows) byProtocol[r.protocol] = (byProtocol[r.protocol] || 0) + 1;
  return {
    byProtocol,
    candidateRows: {
      total: rows.length,
      pathResolved: countBy(rows, (r) => r.pathResolved),
      graphContainsChainlinkNode: countBy(rows, (r) => r.graphContainsChainlinkNode),
      graphContainsDexNode: countBy(rows, (r) => r.graphContainsDexNode),
      graphContainsERC4626Node: countBy(rows, (r) => r.graphContainsERC4626Node),
      graphContainsConversionNode: countBy(rows, (r) => r.graphContainsConversionNode),
      unresolved: countBy(rows, (r) => r.unresolved),
      exactEconomicsRows: countBy(rows, (r) => r.dexOracleLinked && r.economics !== null),
    },
    uniqueRoutes: {
      total: uniqueRoutes.length,
      pathResolved: countBy(uniqueRoutes, (r) => r.pathResolved),
      graphContainsChainlinkNode: countBy(uniqueRoutes, (r) => r.graphContainsChainlinkNode),
      graphContainsDexNode: countBy(uniqueRoutes, (r) => r.graphContainsDexNode),
      graphContainsERC4626Node: countBy(uniqueRoutes, (r) => r.graphContainsERC4626Node),
      graphContainsConversionNode: countBy(uniqueRoutes, (r) => r.graphContainsConversionNode),
      unresolved: countBy(uniqueRoutes, (r) => r.unresolved),
      exactEconomicsRoutes: countBy(uniqueRoutes, (r) => r.exactEconomics),
    },
  };
}

function assertArtifact(raw) {
  const failures = [];
  const derivedRoutes = aggregateUniqueRoutes(raw.rows || []);
  const derived = summarize(raw.rows || [], derivedRoutes);
  if (derived.candidateRows.total !== 17) failures.push(`candidate-baseline:${derived.candidateRows.total}`);
  if (derived.uniqueRoutes.total !== 12) failures.push(`unique-route-baseline:${derived.uniqueRoutes.total}`);
  if (JSON.stringify(derived) !== JSON.stringify(raw.summary)) failures.push("summary-not-derived-from-rows");
  if (JSON.stringify(derivedRoutes) !== JSON.stringify(raw.uniqueRoutes)) failures.push("unique-routes-not-derived-from-rows");
  const capo = (raw.rows || []).find((r) => r.target === "compound-weth-wsteth");
  if (!capo?.current?.capo?.configuredFeedConfirmed) failures.push("capo-feed-not-confirmed");
  if (capo?.current?.assetInfo?.priceFeed?.toLowerCase() !== capo?.path?.address?.toLowerCase()) failures.push("capo-path-address-mismatch");
  if (!capo?.path?.evidence?.assetToBaseAggregator?.ok || !capo?.path?.evidence?.ratioProvider?.ok || !capo?.path?.evidence?.marketAggregator?.ok) failures.push("capo-getter-set-incomplete");
  if (capo?.pathResolved && capo?.path?.sourceBinding?.status !== "exact-runtime-callgraph-bound") failures.push("capo-resolved-without-runtime-binding");
  if (capo?.unresolved && capo?.current?.legacyThinPoolEdge !== null) failures.push("capo-unresolved-false-safety");
  if (raw.gates?.routePositive !== null || raw.gates?.forkJustified || raw.gates?.executableNow || raw.gates?.signedActionJustified) failures.push("gate-invariant");
  if (failures.length) throw new Error(`artifact assertions failed: ${failures.join(", ")}`);
  return { candidateRows: derived.candidateRows.total, uniqueRoutes: derived.uniqueRoutes.total, capoResolved: capo.pathResolved };
}

function verifyStaged(stageRoot, runId) {
  const manifest = JSON.parse(fs.readFileSync(stagePath(stageRoot, REL.manifest), "utf8"));
  const raw = JSON.parse(fs.readFileSync(stagePath(stageRoot, REL.raw), "utf8"));
  const defs = JSON.parse(fs.readFileSync(stagePath(stageRoot, REL.definitions), "utf8"));
  const sources = JSON.parse(fs.readFileSync(stagePath(stageRoot, REL.sources), "utf8"));
  const failures = [];
  if (manifest.runId !== runId || raw.runId !== runId || defs.runId !== runId || sources.runId !== runId) failures.push("run-id-mismatch");
  for (const [name, item] of Object.entries(manifest.files || {})) {
    const physical = item.file === REL.scanner ? abs(item.file) : stagePath(stageRoot, item.file);
    if (!fs.existsSync(physical)) failures.push(`${name}:missing`);
    else { const actual = physicalBinding(physical, item.file); if (actual.sha256 !== item.sha256 || actual.bytes !== item.bytes) failures.push(`${name}:hash-or-size`); }
  }
  for (const item of raw.inputs || []) {
    const physical = item.file === REL.definitions || item.file === REL.sources ? stagePath(stageRoot, item.file) : abs(item.file);
    const actual = physicalBinding(physical, item.file); if (actual.sha256 !== item.sha256 || actual.bytes !== item.bytes) failures.push(`${item.file}:input-binding`);
  }
  if (JSON.stringify(manifest.inputs) !== JSON.stringify(raw.inputs) || JSON.stringify(manifest.dependencies) !== JSON.stringify(raw.dependencies)) failures.push("manifest-input-or-dependency-mismatch");
  if (!fs.readFileSync(stagePath(stageRoot, REL.report), "utf8").includes(runId) || !fs.readFileSync(stagePath(stageRoot, REL.handoff), "utf8").includes(runId)) failures.push("text-output-run-id-mismatch");
  assertArtifact(raw);
  if (leakScan([REL.raw, REL.report, REL.definitions, REL.sources, REL.handoff, REL.manifest], stageRoot).length) failures.push("endpoint-or-secret-leak-pattern");
  if (failures.length) throw new Error(`staged verification failed: ${failures.join(", ")}`);
}

function publishAtomically(stageRoot, runId) {
  const rels = [REL.definitions, REL.sources, REL.raw, REL.report, REL.handoff, REL.manifest];
  const backupRoot = path.join(stageRoot, "_backups");
  const prepared = [];
  for (const rel of rels) {
    const dest = abs(rel); fs.mkdirSync(path.dirname(dest), { recursive: true });
    const temp = `${dest}.${runId}.new`; fs.copyFileSync(stagePath(stageRoot, rel), temp);
    prepared.push({ rel, dest, temp, backup: path.join(backupRoot, ...rel.split("/")), hadDest: fs.existsSync(dest) });
  }
  const swapped = [];
  try {
    for (const item of prepared) {
      if (item.hadDest) { fs.mkdirSync(path.dirname(item.backup), { recursive: true }); fs.renameSync(item.dest, item.backup); }
      fs.renameSync(item.temp, item.dest); swapped.push(item);
    }
  } catch (e) {
    for (const item of [...swapped].reverse()) {
      if (fs.existsSync(item.dest)) fs.rmSync(item.dest, { force: true });
      if (item.hadDest && fs.existsSync(item.backup)) fs.renameSync(item.backup, item.dest);
    }
    for (const item of prepared) if (fs.existsSync(item.temp)) fs.rmSync(item.temp, { force: true });
    throw e;
  }
  fs.rmSync(backupRoot, { recursive: true, force: true });
}

function verifyOffline() {
  const manifest = JSON.parse(fs.readFileSync(abs(REL.manifest), "utf8"));
  const failures = [];
  for (const item of Object.values(manifest.files)) {
    if (!item?.file || !fs.existsSync(abs(item.file))) { failures.push(`${item?.file || "missing-entry"}:missing`); continue; }
    const actual = fileBinding(item.file); if (actual.sha256 !== item.sha256 || actual.bytes !== item.bytes) failures.push(`${item.file}:hash-or-size`);
  }
  const raw = JSON.parse(fs.readFileSync(abs(REL.raw), "utf8"));
  const defs = JSON.parse(fs.readFileSync(abs(REL.definitions), "utf8"));
  const sources = JSON.parse(fs.readFileSync(abs(REL.sources), "utf8"));
  if (manifest.runId !== raw.runId || raw.runId !== defs.runId || raw.runId !== sources.runId) failures.push("run-id-mismatch");
  for (const item of [...raw.inputs, ...raw.dependencies]) if (fs.existsSync(abs(item.file)) && fileBinding(item.file).sha256 !== item.sha256) failures.push(`${item.file}:dependency-drift`);
  if (JSON.stringify(manifest.inputs) !== JSON.stringify(raw.inputs) || JSON.stringify(manifest.dependencies) !== JSON.stringify(raw.dependencies)) failures.push("manifest-input-or-dependency-mismatch");
  try { assertArtifact(raw); } catch (e) { failures.push(sanitizeText(e.message)); }
  const leaks = leakScan([REL.raw, REL.report, REL.definitions, REL.sources, REL.handoff, REL.manifest]);
  if (leaks.length) failures.push("endpoint-or-secret-leak-pattern");
  if (failures.length) throw new Error(`offline verification failed: ${failures.join(", ")}`);
  if (!QUIET) console.log(`Verified ${manifest.runId}: files=${Object.keys(manifest.files).length} fixtures=${runSelfTests().passed} leaks=0`);
  return true;
}

async function main() {
  if (SELF_TEST && !VERIFY) { const r = runSelfTests(); if (!QUIET) console.log(`Focused fixtures passed: ${r.passed}`); return; }
  if (VERIFY) return verifyOffline();
  fs.mkdirSync(path.dirname(abs(GENERATION_LOCK)), { recursive: true });
  let lockFd;
  try { lockFd = fs.openSync(abs(GENERATION_LOCK), "wx"); fs.writeFileSync(lockFd, String(process.pid)); }
  catch (_) { throw new Error("another live small-cap-oracle-current-paths generation is active"); }
  try {
    const legacy = JSON.parse(fs.readFileSync(abs(REL.legacy), "utf8"));
    const candidates = selectCandidates(legacy);
    if (candidates.length !== 17 || candidates.filter((r) => r.protocol === "Euler EVK").length !== 14) throw new Error(`bounded legacy candidate selection mismatch: ${candidates.length}`);
    const chainIds = [...new Set(candidates.map((r) => Number(r.chainId)))].sort((a, b) => a - b);
    const validation = { 1: norm(candidates.find((r) => r.chainId === 1)?.consumer?.comet) || MORPHO, 8453: MORPHO };
    const contexts = {}; const providerMetrics = {}; const fixedHeads = {};
    for (const chainId of chainIds) {
      const found = await endpointFor(chainId, validation[chainId] || MORPHO);
      providerMetrics[chainId] = found.metrics;
      if (!found.rpc || !found.head) throw new Error(`no validated read-only provider for chain ${chainId}`);
      contexts[chainId] = { rpc: found.rpc, head: found.head }; fixedHeads[chainId] = found.head;
    }
    const legacyBinding = fileBinding(REL.legacy);
    const runSeed = `${legacyBinding.sha256}:${chainIds.map((id) => `${id}:${fixedHeads[id].number}:${fixedHeads[id].hash}`).join(":")}`;
    const runId = `small-cap-oracle-current-paths-${sha(runSeed).slice(0, 20)}`;
    const stageRoot = abs(`${STAGING_BASE}/${runId}`);
    fs.rmSync(stageRoot, { recursive: true, force: true }); fs.mkdirSync(stageRoot, { recursive: true });
    writeJsonAt(stagePath(stageRoot, REL.definitions), definitions(runId));
    writeJsonAt(stagePath(stageRoot, REL.sources), sourceSnapshots(runId));

    const rows = [];
    for (const row of candidates) {
      const ctx = contexts[row.chainId];
      if (row.protocol === "Compound Comet") rows.push(await compoundRow(ctx, row));
      else if (row.protocol === "Morpho Blue") rows.push(await morphoRow(ctx, row));
      else rows.push(await eulerRow(ctx, row));
    }
    for (const id of chainIds) {
      const h = fixedHeads[id]; const again = await contexts[id].rpc.send("eth_getBlockByNumber", [hexNum(h.number), false]);
      h.finalRecheckPassed = Boolean(again && Number(BigInt(again.number)) === h.number && again.hash === h.hash && Number(BigInt(again.timestamp)) === h.timestamp);
      h.finalRecheck = again ? { number: Number(BigInt(again.number)), hash: again.hash, timestamp: Number(BigInt(again.timestamp)) } : null;
    }
    const uniqueRoutes = aggregateUniqueRoutes(rows);
    const summary = summarize(rows, uniqueRoutes);
    const blockers = [...new Set(rows.flatMap((r) => r.blockers || []))];
    if (!summary.uniqueRoutes.graphContainsDexNode) blockers.push("No bounded deployed oracle path reached a specific DEX pool; economics correctly remain null.");
    blockers.push("No read-only path result is a fork proof or signed-action justification.");
    const generatedAt = new Date().toISOString();
    const inputs = [legacyBinding, physicalBinding(stagePath(stageRoot, REL.definitions), REL.definitions), physicalBinding(stagePath(stageRoot, REL.sources), REL.sources)];
    const dependencies = [fileBinding(REL.scanner), fileBinding("tools/shared-rpc.js"), fileBinding("tools/node_modules/ethers/package.json")];
    const artifact = {
      schemaVersion: 2, runId, generatedAt, scanner: REL.scanner,
      scope: "Bounded current deployed oracle-path resolver for 17 exact legacy candidates and 12 derived unique route keys",
      classification: "WATCH_ONLY/COVERAGE_OPEN/NO_ROUTE_PROOF",
      publication: { stagedAndVerifiedBeforeSwap: true, transactionalAtomicSwap: true, runSpecificStage: true },
      safety: { rpcInventoryRead: true, endpointValuesPersisted: false, endpointDomainsPersisted: false, transactions: false, signing: false, forks: false, stateMutation: false },
      inputs, dependencies, fixedHeads, providerMetrics, summary, uniqueRoutes, rows,
      gates: { positiveRouteEstablished: false, routePositive: null, forkJustified: false, executableNow: false, signedActionJustified: false }, blockers,
    };
    assertArtifact(artifact);
    writeJsonAt(stagePath(stageRoot, REL.raw), artifact);
    fs.mkdirSync(path.dirname(stagePath(stageRoot, REL.report)), { recursive: true }); fs.writeFileSync(stagePath(stageRoot, REL.report), makeReport(artifact));
    fs.mkdirSync(path.dirname(stagePath(stageRoot, REL.handoff)), { recursive: true }); fs.writeFileSync(stagePath(stageRoot, REL.handoff), makeHandoff(artifact));
    const files = {
      scanner: fileBinding(REL.scanner),
      raw: physicalBinding(stagePath(stageRoot, REL.raw), REL.raw), report: physicalBinding(stagePath(stageRoot, REL.report), REL.report),
      definitions: physicalBinding(stagePath(stageRoot, REL.definitions), REL.definitions), sources: physicalBinding(stagePath(stageRoot, REL.sources), REL.sources),
      handoff: physicalBinding(stagePath(stageRoot, REL.handoff), REL.handoff),
    };
    writeJsonAt(stagePath(stageRoot, REL.manifest), { schemaVersion: 2, detached: true, selfExcluded: true, runId, generatedAt, files, dependencies, inputs, runtime: { node: process.version, ethers: require("./node_modules/ethers/package.json").version, builtins: ["crypto", "fs", "path", "fetch", "AbortController"] }, verification: { hashAlgorithm: "sha256", atomicStageVerified: true, focusedFixturesPassed: runSelfTests().passed, focusedCountAssertions: { candidateRows: summary.candidateRows.total, uniqueRoutes: summary.uniqueRoutes.total }, capoRuntimeBinding: rows.find((r) => r.target === "compound-weth-wsteth")?.path?.sourceBinding?.status || null, fixedHeadsRechecked: Object.values(fixedHeads).every((h) => h.finalRecheckPassed), endpointSecretLeakScanPassed: true } });
    verifyStaged(stageRoot, runId);
    publishAtomically(stageRoot, runId);
    fs.rmSync(stageRoot, { recursive: true, force: true });
    verifyOffline();
    if (!QUIET) console.log(`Current paths: runId=${runId} candidateRows=${summary.candidateRows.total} uniqueRoutes=${summary.uniqueRoutes.total} resolved=${summary.uniqueRoutes.pathResolved} unresolved=${summary.uniqueRoutes.unresolved} chainlinkNodes=${summary.uniqueRoutes.graphContainsChainlinkNode} dexNodes=${summary.uniqueRoutes.graphContainsDexNode} erc4626Nodes=${summary.uniqueRoutes.graphContainsERC4626Node}`);
  } finally {
    if (lockFd !== undefined) fs.closeSync(lockFd);
    fs.rmSync(abs(GENERATION_LOCK), { force: true });
  }
}

main().catch((err) => { console.error(sanitizeText(err?.stack || err?.message || err)); process.exitCode = 1; });
